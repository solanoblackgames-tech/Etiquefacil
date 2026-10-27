import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getBlingCompany, listBlingSalesChannelsForDeposit } from "../src/bling-api.js";

async function withTempStore(name, callback) {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `etiquefacil-${name}-`));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;
  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-${name}`;
    await callback(await import(storeUrl.href));
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function jsonResponse(payload) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => payload };
}

test("Ecommerce Bling account is stored apart from the primary account", async () => {
  await withTempStore("bling-accounts", async (store) => {
    await store.writeDb({ users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }] });
    await store.saveUserBlingIntegration("user-1", { clientId: "app", clientSecret: "secret", accessToken: "primary", refreshToken: "primary-r" });
    await store.saveBlingAccountIntegration("user-1", "ecommerce", { clientId: "app", clientSecret: "secret", accessToken: "ecom", refreshToken: "ecom-r", companyId: "c2", companyName: "JZ Ecommerce" });

    assert.equal((await store.getBlingAccountCredentials("user-1", "principal")).accessToken, "primary");
    assert.equal((await store.getBlingAccountCredentials("user-1", "ecommerce")).accessToken, "ecom");
    const ecommerce = await store.getBlingAccountIntegration("user-1", "ecommerce");
    assert.equal(ecommerce.connected, true);
    assert.equal(ecommerce.companyName, "JZ Ecommerce");

    await store.deleteBlingAccountIntegration("user-1", "ecommerce");
    assert.equal(await store.getBlingAccountCredentials("user-1", "ecommerce"), null);
    assert.equal((await store.getBlingAccountCredentials("user-1", "principal")).accessToken, "primary");
    assert.throws(() => store.normalizeBlingAccount("outra"), /Conta Bling desconhecida/);
  });
});

test("sales channels of a deposit are read from each channel's Bling deposit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/depositos")) return jsonResponse({ data: [{ id: 10, descricao: "Ecommerce" }, { id: 11, descricao: "Venda B2B" }] });
    if (href.includes("/canais-venda/1")) return jsonResponse({ data: { id: 1, filiais: [{ deposito: { id: 10 }, padrao: true }] } });
    if (href.includes("/canais-venda/2")) return jsonResponse({ data: { id: 2, filiais: [{ deposito: { id: 11 }, padrao: true }] } });
    if (href.includes("/canais-venda/3")) return jsonResponse({ data: { id: 3, filiais: [{ deposito: { id: 10 }, padrao: true }] } });
    if (href.includes("/canais-venda")) return jsonResponse({ data: [{ id: 1, descricao: "ML1", tipo: "MercadoLivre", situacao: 1 }, { id: 2, descricao: "Atacado", tipo: "Api", situacao: 1 }, { id: 3, descricao: "Shopee 1", tipo: "Shopee", situacao: 1 }] });
    throw new Error(`URL inesperada ${href}`);
  };
  try {
    const channels = await listBlingSalesChannelsForDeposit({ integration: { accessToken: "t" }, depositName: "ecommerce" });
    assert.deepEqual(channels.map((channel) => channel.name), ["ML1", "Shopee 1"]);
    await assert.rejects(
      () => listBlingSalesChannelsForDeposit({ integration: { accessToken: "t" }, depositName: "Inexistente" }),
      /nao encontrado nesta conta Bling/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bling company identifies which account a token belongs to", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ data: { id: "abc", nome: "JZ Ecommerce LTDA", cnpj: "12.345.678/0001-90" } });
  try {
    assert.deepEqual(await getBlingCompany({ integration: { accessToken: "t" } }), { id: "abc", name: "JZ Ecommerce LTDA", cnpj: "12.345.678/0001-90" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bling retries a rejected token with JWT and persists the rotated credentials", async () => {
  const originalFetch = globalThis.fetch;
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'a'.repeat(3000) + '.signature';
  const saved = [];
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(options.headers['enable-jwt'], '1');
    if (requests === 1) {
      assert.equal(options.headers.Authorization, 'Bearer old-token');
      return { ok: false, status: 401, json: async () => ({}) };
    }
    if (requests === 2) {
      assert.equal(String(url), 'https://api.bling.com.br/Api/v3/oauth/token');
      return jsonResponse({ access_token: jwt, refresh_token: 'rotated-jwt-account', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
    return jsonResponse({ data: { id: 'jwt-company', nome: 'Empresa JWT' } });
  };
  try {
    const company = await getBlingCompany({
      integration: { clientId: 'app', clientSecret: 'secret', accessToken: 'old-token', refreshToken: 'jwt-account' },
      saveIntegration: async (credentials) => saved.push(credentials)
    });
    assert.equal(company.id, 'jwt-company');
    assert.equal(requests, 3);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].accessToken, jwt);
    assert.equal(saved[0].refreshToken, 'rotated-jwt-account');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bling storage preserves full JWT credentials for both accounts", async () => {
  await withTempStore('bling-jwt-storage', async (store) => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'a'.repeat(3000) + '.signature';
    const refreshToken = 'r'.repeat(3000);
    await store.writeDb({ users: [{ id: 'jwt-user', name: 'JWT', email: 'jwt@example.com' }] });
    for (const account of ['principal', 'ecommerce']) {
      await store.saveBlingAccountIntegration('jwt-user', account, { clientId: 'app', clientSecret: 'secret', accessToken: jwt, refreshToken });
      const credentials = await store.getBlingAccountCredentials('jwt-user', account);
      assert.equal(credentials.accessToken, jwt);
      assert.equal(credentials.refreshToken, refreshToken);
    }
  });
});
