import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { withBlingAuthorizationFailure } from '../src/bling-connection-status.js';

test('authorization failures require reconnect; temporary failures do not', () => {
  const integration = { connected: true, hasAccessToken: true, hasRefreshToken: true };
  for (const message of ['Invalid refresh token', 'Refresh token has expired', 'invalid_grant', 'invalid_token']) {
    const result = withBlingAuthorizationFailure(integration, message);
    assert.equal(result.connected, false);
    assert.equal(result.reconnectRequired, true);
    assert.equal(result.hasAccessToken, true);
  }
  for (const message of ['Erro 429 na API do Bling', 'HTTP 504', 'Produto invalido']) {
    assert.equal(withBlingAuthorizationFailure(integration, message), integration);
  }
});

test('queue authorization rejection changes public connection status without deleting credentials; reconnection clears old failures', async () => {
  const originalCwd = process.cwd();
  const databaseUrl = process.env.DATABASE_URL;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'etiquefacil-bling-status-'));
  delete process.env.DATABASE_URL;
  process.chdir(temp);
  try {
    const moduleUrl = pathToFileURL(path.join(originalCwd, 'src', 'store.js'));
    moduleUrl.search = '?status-test';
    const { writeDb, getUserBlingIntegration, getUserBlingCredentials, saveUserBlingIntegration, resumeUserBlingSyncJobs } = await import(moduleUrl.href);
    const old = '2026-10-15T06:00:00.000Z';
    await writeDb({ users: [], lots: [], products: [], rzItems: [], scans: [], labels: [], blingIntegrations: [{userId:'owner-1',clientId:'app',clientSecret:'secret',accessToken:'old-access',refreshToken:'old-refresh',tokenExpiresAt:old,updatedAt:old}], blingSyncJobs: [{ id:'job-1',userId:'owner-1',status:'failed',errorMessage:'Invalid refresh token',updatedAt:'2026-10-16T06:00:00.000Z'}] });
    const status = await getUserBlingIntegration('owner-1');
    assert.equal(status.connected, false);
    assert.equal(status.reconnectRequired, true);
    assert.equal(JSON.stringify(status).includes('old-refresh'), false);
    assert.equal((await getUserBlingCredentials('owner-1')).refreshToken, 'old-refresh');
    await saveUserBlingIntegration('owner-1', {accessToken:'new-access',refreshToken:'new-refresh'});
    const reconnected = await getUserBlingIntegration('owner-1');
    assert.equal(reconnected.connected, true);
    assert.ok(!reconnected.reconnectRequired);
    await resumeUserBlingSyncJobs('owner-1');
    const resumed = await getUserBlingIntegration('owner-1');
    assert.equal(resumed.connected, true);
    assert.ok(!resumed.reconnectRequired);
  } finally {
    process.chdir(originalCwd);
    if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
    await fs.rm(temp, {recursive:true,force:true});
  }
});

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const renderCode = app.slice(app.indexOf('function renderBlingIntegration('), app.indexOf('// Segunda conta Bling', app.indexOf('function renderBlingIntegration(')));
function render(integration) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {textContent:'',style:{},classList:{values:new Set(),toggle(name, enabled){if(enabled)this.values.add(name);else this.values.delete(name);}}});
    return elements.get(id);
  }
  const badge = element('badge');
  const context = {state:{blingIntegration:integration,blingIntegrationLoaded:true}, $:element, document:{querySelectorAll:()=>[badge]}, isOwnerUser:()=>true,getBlingCallbackMessage:()=>''};
  vm.runInNewContext(renderCode + '\nrenderBlingIntegration(state.blingIntegration);', context);
  return {elements,badge};
}

test('profile displays reconnect for rejected tokens instead of integrated badge', () => {
  const integration = withBlingAuthorizationFailure({connected:true,hasAccessToken:true,appConfigured:true},'Invalid refresh token');
  const {elements,badge} = render(integration);
  assert.equal(badge.textContent, 'RECONECTAR BLING');
  assert.ok(badge.classList.values.has('connection-warning'));
  assert.equal(elements.get('#blingAuthorizeLink').textContent,'Reconectar no Bling');
  assert.equal(elements.get('#blingIntegrationDelete').disabled,false);
  assert.match(elements.get('#blingIntegrationDetails').textContent,/expirou ou foi revogada/);
});

test('temporary validation failure shows verification state without requesting reconnect', () => {
  const {elements,badge} = render({connected:true,hasAccessToken:true,appConfigured:true,validationPending:true});
  assert.equal(badge.textContent,'VERIFICAR BLING');
  assert.match(elements.get('#blingIntegrationTitle').textContent,/verificar/);
  assert.match(elements.get('#blingIntegrationDetails').textContent,/preservados/);
});
