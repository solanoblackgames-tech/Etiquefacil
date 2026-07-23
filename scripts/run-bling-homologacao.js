import { config as loadDotenv } from "dotenv";
import { runBlingHomologation } from "../src/bling-api.js";
import { closePgPool, getPgPool, hasPostgres, readDb, saveUserBlingIntegration } from "../src/store.js";

loadDotenv();

async function main() {
  const integration = await loadIntegration();
  const result = await runBlingHomologation({
    integration,
    saveIntegration: integration.userId
      ? (updated) => saveUserBlingIntegration(integration.userId, updated)
      : null
  });

  console.log(JSON.stringify({
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    productId: result.productId,
    tokenRefreshed: result.tokenRefreshed,
    steps: result.steps
  }, null, 2));
}

async function loadIntegration() {
  const envIntegration = integrationFromEnv();
  if (envIntegration.accessToken) return envIntegration;

  const userId = argValue("--user-id") || process.env.BLING_USER_ID || process.env.USER_ID || "";
  if (userId) return loadIntegrationByUserId(userId);

  const integrations = await listSavedIntegrations();
  if (integrations.length === 1) return integrations[0];
  if (integrations.length > 1) {
    throw new Error("Ha mais de uma integracao Bling salva. Execute com --user-id=<id> ou defina BLING_USER_ID.");
  }
  throw new Error("Nenhuma integracao Bling salva encontrada. Defina BLING_ACCESS_TOKEN e BLING_REFRESH_TOKEN, ou autorize o Bling no app.");
}

function integrationFromEnv() {
  return {
    clientId: process.env.BLING_CLIENT_ID || "",
    clientSecret: process.env.BLING_CLIENT_SECRET || "",
    accessToken: process.env.BLING_ACCESS_TOKEN || "",
    refreshToken: process.env.BLING_REFRESH_TOKEN || "",
    tokenExpiresAt: process.env.BLING_TOKEN_EXPIRES_AT || null
  };
}

async function loadIntegrationByUserId(userId) {
  const integrations = await listSavedIntegrations();
  const integration = integrations.find((item) => item.userId === userId);
  if (!integration) throw new Error(`Integracao Bling nao encontrada para userId ${userId}.`);
  return integration;
}

async function listSavedIntegrations() {
  if (hasPostgres()) {
    const result = await getPgPool().query(`
      select user_id, client_id, client_secret, access_token, refresh_token, token_expires_at, updated_at
      from bling_integrations
      where access_token <> '' and refresh_token <> ''
      order by updated_at desc
    `);
    return result.rows.map((row) => ({
      userId: row.user_id,
      clientId: row.client_id || process.env.BLING_CLIENT_ID || "",
      clientSecret: row.client_secret || process.env.BLING_CLIENT_SECRET || "",
      accessToken: row.access_token || "",
      refreshToken: row.refresh_token || "",
      tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null
    }));
  }

  const db = await readDb();
  return (db.blingIntegrations || [])
    .filter((item) => item.accessToken && item.refreshToken)
    .map((item) => ({
      ...item,
      clientId: item.clientId || process.env.BLING_CLIENT_ID || "",
      clientSecret: item.clientSecret || process.env.BLING_CLIENT_SECRET || ""
    }));
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => item === name || item.startsWith(prefix));
  if (!arg || arg === name) return "";
  return arg.slice(prefix.length);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool();
  });
