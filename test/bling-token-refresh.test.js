import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshBlingIntegrationToken } from '../src/bling-api.js';
import { getBlingTokenRateLimiter } from '../src/bling-rate-limit.js';

const limiter = getBlingTokenRateLimiter();
let now = Date.now();
limiter.now = () => now;
limiter.sleep = async (ms) => { await new Promise(setImmediate); now += ms; };

function integration(id) {
  return { userId: id, clientId: 'app', clientSecret: 'secret', accessToken: 'old', refreshToken: `refresh-${id}` };
}

function success(id) {
  return { ok: true, status: 200, json: async () => ({ access_token: `access-${id}`, refresh_token: `rotated-${id}`, expires_in: 3600 }) };
}

test('concurrent refreshes and stale snapshots use one token rotation', async () => {
  const source = integration('same-account');
  let requests = 0;
  const fetchImpl = async () => { requests++; return success('same-account'); };
  const results = await Promise.all(Array.from({ length: 12 }, () => refreshBlingIntegrationToken({ ...source }, { fetchImpl })));
  const stale = await refreshBlingIntegrationToken(source, { fetchImpl });
  assert.equal(requests, 1);
  for (const result of [...results, stale]) {
    assert.equal(result.accessToken, 'access-same-account');
    assert.equal(result.refreshToken, 'rotated-same-account');
  }
});

test('different accounts share the server OAuth request limit', async () => {
  const times = [];
  await Promise.all(Array.from({ length: 25 }, (_, i) => refreshBlingIntegrationToken(integration(`tenant-${i}`), {
    fetchImpl: async () => { times.push(now); return success(i); }
  })));
  assert.equal(times.length, 25);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 3100);
  assert.ok(times[20] - times[0] > 60_000);
});

test('failed refreshes are shared instead of repeatedly submitting an invalid token', async () => {
  let requests = 0;
  const options = { fetchImpl: async () => {
    requests++;
    return { ok: false, status: 400, json: async () => ({ error_description: 'Invalid refresh token' }) };
  } };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => refreshBlingIntegrationToken(integration('invalid'), options)));
  assert.ok(results.every((result) => result.status === 'rejected'));
  await assert.rejects(refreshBlingIntegrationToken(integration('invalid'), options), /Invalid refresh token/);
  assert.equal(requests, 1);
});

test('OAuth 429 pauses refreshes for other accounts before issuing another request', async () => {
  let requests = 0;
  await assert.rejects(refreshBlingIntegrationToken(integration('limited'), { fetchImpl: async () => {
    requests++;
    return { ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }), json: async () => ({}) };
  } }), { status: 429 });
  await assert.rejects(refreshBlingIntegrationToken(integration('other-limited'), { fetchImpl: async () => {
    requests++;
    return success('unexpected');
  } }), { status: 429 });
  assert.equal(requests, 1);
});
