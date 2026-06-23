import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { formatSku, roundMoney } from "./domain.js";
import { findApprovedProductHistory, findProductHistory, getBlingProducts, summarizeLot } from "./lots.js";
import { insertRows } from "./pg-bulk.js";

const { Pool } = pg;

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "db.json");

let pool;
let storeReady;

const NO_SHEET_ORIGINS = ["lote_sem_planilha", "entrada_diversos"];
const EXCESS_EXPORT_ORIGINS = ["excedente_externo", "lote_sem_planilha_manual"];

const emptyDb = () => ({
  users: [],
  lots: [],
  products: [],
  rzItems: [],
  scans: [],
  labels: [],
  blingIntegrations: [],
  appSettings: {},
  transferLots: [],
  transferItems: [],
  operatorActivities: [],
  catalogProducts: [],
  catalogRequests: [],
  catalogRejectedRequests: []
});

export function hasPostgres() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPgPool() {
  if (!hasPostgres()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 10000,
      max: 5,
      ssl: process.env.PGSSL === "false" ? false : process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    });
  }
  return pool;
}

export async function closePgPool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export async function ensureStore() {
  if (storeReady) return storeReady;
  storeReady = ensureStoreOnce().catch((error) => {
    storeReady = undefined;
    throw error;
  });
  return storeReady;
}

async function ensureStoreOnce() {
  if (hasPostgres()) {
    await ensurePgStore();
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, JSON.stringify(emptyDb(), null, 2));
  }
  await migrateJsonStore();
}

async function migrateJsonStore() {
  const raw = await fs.readFile(DB_PATH, "utf8");
  const db = { ...emptyDb(), ...JSON.parse(raw || "{}") };
  let changed = normalizeDbTenants(db);
  const rejectedInQueue = (db.catalogRequests || []).filter((request) => request.status === "rejected");
  if (!rejectedInQueue.length) {
    if (changed) await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
    return;
  }

  const archivedOriginalIds = new Set((db.catalogRejectedRequests || []).map((request) => request.originalRequestId));
  const archived = rejectedInQueue
    .filter((request) => !archivedOriginalIds.has(request.id))
    .map((request) => buildRejectedCatalogRequest(request, request.reviewedAt || new Date().toISOString()));
  db.catalogRejectedRequests = [...(db.catalogRejectedRequests || []), ...archived];
  db.catalogRequests = (db.catalogRequests || []).filter((request) => request.status !== "rejected");
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export async function readDb() {
  await ensureStore();
  if (hasPostgres()) return readPgDb();

  const raw = await fs.readFile(DB_PATH, "utf8");
  const db = { ...emptyDb(), ...JSON.parse(raw || "{}") };
  normalizeDbTenants(db);
  return db;
}

export async function writeDb(db) {
  await ensureStore();
  if (hasPostgres()) {
    await writePgDb(db);
    return;
  }

  normalizeDbTenants(db);
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export async function createUser({ name, email, password, parentUserId = null }) {
  await ensureStore();
  const normalizedEmail = email.trim().toLowerCase();
  const owner = parentUserId ? await getUserById(parentUserId) : null;
  const operatorCode = owner ? await nextOperatorCode(owner.id) : null;
  const user = {
    id: randomUUID(),
    tenantId: owner?.tenantId || randomUUID(),
    tenantName: owner?.tenantName || name.trim(),
    parentUserId: owner?.id || null,
    role: owner ? "operator" : "owner",
    operatorCode,
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    try {
      await query(
        `insert into users (id, tenant_id, tenant_name, parent_user_id, role, operator_code, name, email, password_hash, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [user.id, user.tenantId, user.tenantName, user.parentUserId, user.role, user.operatorCode, user.name, user.email, user.passwordHash, user.createdAt]
      );
    } catch (error) {
      if (error.code === "23505") throw new Error("E-mail jÃ¡ cadastrado.");
      throw error;
    }
    return sanitizeUser(user);
  }

  const db = await readDb();
  if (db.users.some((item) => item.email === normalizedEmail)) {
    throw new Error("E-mail jÃ¡ cadastrado.");
  }
  db.users.push(user);
  await writeDb(db);
  return sanitizeUser(user);
}

export async function createOperator({ ownerUserId, name, email, password }) {
  return createUser({ name, email, password, parentUserId: ownerUserId });
}

export async function verifyUser(email, password) {
  await ensureStore();
  const normalizedEmail = email.trim().toLowerCase();
  let user;

  if (hasPostgres()) {
    const result = await query("select * from users where email = $1 limit 1", [normalizedEmail]);
    user = result.rows[0] && userFromRow(result.rows[0]);
  } else {
    const db = await readDb();
    user = db.users.find((item) => item.email === normalizedEmail);
  }

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
  return sanitizeUser(user);
}

async function getUserById(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("select * from users where id = $1 limit 1", [userId]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  const db = await readDb();
  return db.users.find((user) => user.id === userId) || null;
}

export async function getPublicUserById(userId) {
  return sanitizeUser(await getUserById(userId));
}

export function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    tenantId: user.tenantId || user.id,
    tenantName: user.tenantName || user.name,
    parentUserId: user.parentUserId || null,
    workspaceUserId: user.parentUserId || user.id,
    role: user.role || (user.parentUserId ? "operator" : "owner"),
    operatorCode: user.operatorCode || null,
    name: user.name,
    email: user.email
  };
}

async function nextOperatorCode(ownerUserId) {
  const firstCode = 1001;
  if (hasPostgres()) {
    const result = await query("select max(operator_code)::int as max_code from users where parent_user_id = $1", [ownerUserId]);
    return Math.max(firstCode - 1, Number(result.rows[0]?.max_code || 0)) + 1;
  }

  const db = await readDb();
  const maxCode = (db.users || [])
    .filter((user) => user.parentUserId === ownerUserId)
    .reduce((max, user) => Math.max(max, Number(user.operatorCode || 0)), 0);
  return Math.max(firstCode - 1, maxCode) + 1;
}

export async function listOperatorsForUser(ownerUserId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      `
        select
          u.*,
          count(oa.id)::int as activity_total,
          max(oa.created_at) as last_activity_at,
          count(oa.id) filter (where oa.action = 'login')::int as login_total,
          count(oa.id) filter (where oa.action = 'search_ml')::int as search_total,
          count(oa.id) filter (where oa.action in ('scan_ml', 'scan_transfer'))::int as scan_total,
          count(oa.id) filter (where oa.action in ('create_manual_product', 'create_external_excess'))::int as create_total,
          count(oa.id) filter (where oa.action = 'view_lot')::int as lot_view_total,
          count(oa.id) filter (where oa.action = 'view_pallet')::int as pallet_view_total
        from users u
        left join operator_activities oa on oa.operator_user_id = u.id
        where u.parent_user_id = $1
        group by u.id
        order by u.created_at desc
      `,
      [ownerUserId]
    );
    return result.rows.map((row) => ({ ...sanitizeUser(userFromRow(row)), stats: operatorStatsFromRow(row) }));
  }

  const db = await readDb();
  return db.users
    .filter((user) => user.parentUserId === ownerUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((user) => ({ ...sanitizeUser(user), stats: summarizeOperatorActivities(db.operatorActivities || [], user.id) }));
}

export async function recordOperatorActivity(user, action, metadata = {}) {
  if (!action) return null;
  const operatorUserId = user?.role === "operator" ? user.id : null;
  const ownerUserId = user?.workspaceUserId || user?.parentUserId || null;
  if (!operatorUserId || !ownerUserId) return null;
  await ensureStore();
  const activity = {
    id: randomUUID(),
    ownerUserId,
    operatorUserId,
    action,
    metadata,
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    await query(
      `insert into operator_activities (id, owner_user_id, operator_user_id, action, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [activity.id, activity.ownerUserId, activity.operatorUserId, activity.action, JSON.stringify(activity.metadata || {}), activity.createdAt]
    );
    return activity;
  }

  const db = await readDb();
  db.operatorActivities.push(activity);
  await writeDb(db);
  return activity;
}

export async function listUsersForAdmin() {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      `
        select
          u.id,
          u.tenant_id,
          u.tenant_name,
          u.parent_user_id,
          u.role,
          u.operator_code,
          u.name,
          u.email,
          u.created_at,
          count(distinct l.id)::int as total_lots,
          count(distinct p.id)::int as total_products
        from users u
        left join lots l on l.user_id = u.id
        left join products p on p.lot_id = l.id
        group by u.id
        order by u.created_at desc
      `
    );
    const users = result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id || row.id,
      tenantName: row.tenant_name || row.name,
      parentUserId: row.parent_user_id || null,
      role: row.role || (row.parent_user_id ? "operator" : "owner"),
      operatorCode: row.operator_code ? Number(row.operator_code) : null,
      name: row.name,
      email: row.email,
      createdAt: iso(row.created_at),
      totalLots: Number(row.total_lots || 0),
      totalProducts: Number(row.total_products || 0)
    }));
    return groupAdminUsersWithOperators(users);
  }

  const db = await readDb();
  const users = db.users
    .map((user) => {
      const lots = db.lots.filter((lot) => lot.userId === user.id);
      const lotIds = new Set(lots.map((lot) => lot.id));
      return {
        ...sanitizeUser(user),
        createdAt: user.createdAt,
        totalLots: lots.length,
        totalProducts: db.products.filter((product) => lotIds.has(product.lotId)).length
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return groupAdminUsersWithOperators(users);
}

function groupAdminUsersWithOperators(users) {
  const operatorsByOwner = new Map();
  const owners = [];

  for (const user of users) {
    if (user.parentUserId) {
      const operators = operatorsByOwner.get(user.parentUserId) || [];
      operators.push(user);
      operatorsByOwner.set(user.parentUserId, operators);
      continue;
    }
    owners.push(user);
  }

  return owners.map((user) => ({
    ...user,
    operators: (operatorsByOwner.get(user.id) || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }));
}

export async function updateUserPassword(userId, password) {
  await ensureStore();
  const normalizedPassword = String(password || "");
  if (normalizedPassword.length < 4) throw new Error("Informe uma senha com pelo menos 4 caracteres.");
  const passwordHash = await bcrypt.hash(normalizedPassword, 10);

  if (hasPostgres()) {
    const result = await query("update users set password_hash = $1 where id = $2 returning id", [passwordHash, userId]);
    if (!result.rows.length) throw notFound("UsuÃ¡rio nÃ£o encontrado.");
    return { ok: true };
  }

  const db = await readDb();
  const user = db.users.find((item) => item.id === userId);
  if (!user) throw notFound("UsuÃ¡rio nÃ£o encontrado.");
  user.passwordHash = passwordHash;
  await writeDb(db);
  return { ok: true };
}

export async function deleteUser(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("delete from users where id = $1 returning id", [userId]);
    if (!result.rows.length) throw notFound("UsuÃ¡rio nÃ£o encontrado.");
    return { ok: true };
  }

  const db = await readDb();
  const user = db.users.find((item) => item.id === userId);
  if (!user) throw notFound("UsuÃ¡rio nÃ£o encontrado.");
  const lotIds = new Set(db.lots.filter((lot) => lot.userId === userId).map((lot) => lot.id));
  const productIds = new Set(db.products.filter((product) => lotIds.has(product.lotId)).map((product) => product.id));
  db.users = db.users.filter((item) => item.id !== userId);
  db.lots = db.lots.filter((lot) => lot.userId !== userId);
  db.products = db.products.filter((product) => !lotIds.has(product.lotId));
  db.rzItems = db.rzItems.filter((item) => !lotIds.has(item.lotId) && !productIds.has(item.productId));
  db.scans = db.scans.filter((scan) => !lotIds.has(scan.lotId));
  db.labels = db.labels.filter((label) => label.userId !== userId && !lotIds.has(label.lotId) && !productIds.has(label.productId));
  db.blingIntegrations = (db.blingIntegrations || []).filter((integration) => integration.userId !== userId);
  await writeDb(db);
  return { ok: true };
}

export async function deleteUserLot(userId, lotId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("delete from lots where id = $1 and user_id = $2 returning id", [lotId, userId]);
    if (!result.rows.length) throw notFound("Lote nÃƒÂ£o encontrado.");
    return { ok: true };
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nÃƒÂ£o encontrado.");
  const productIds = new Set(db.products.filter((product) => product.lotId === lot.id).map((product) => product.id));
  db.lots = db.lots.filter((item) => item.id !== lot.id);
  db.products = db.products.filter((product) => product.lotId !== lot.id);
  db.rzItems = db.rzItems.filter((item) => item.lotId !== lot.id && !productIds.has(item.productId));
  db.scans = db.scans.filter((scan) => scan.lotId !== lot.id);
  db.labels = db.labels.filter((label) => label.lotId !== lot.id && !productIds.has(label.productId));
  await writeDb(db);
  return { ok: true };
}

export async function getStoreHealth() {
  await ensureStore();
  if (!hasPostgres()) return { ok: true, storage: "json" };
  await query("select 1");
  return { ok: true, storage: "postgres" };
}

export async function getUserBlingIntegration(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("select * from bling_integrations where user_id = $1 limit 1", [userId]);
    return publicBlingIntegration(result.rows[0] ? blingIntegrationFromRow(result.rows[0]) : null);
  }

  const db = await readDb();
  return publicBlingIntegration((db.blingIntegrations || []).find((integration) => integration.userId === userId) || null);
}

export async function getUserBlingCredentials(userId) {
  await ensureStore();
  return getPrivateUserBlingIntegration(userId);
}

export async function saveUserBlingIntegration(userId, payload = {}) {
  await ensureStore();
  const existing = await getPrivateUserBlingIntegration(userId);
  const integration = normalizeBlingIntegration(userId, payload, existing);

  if (hasPostgres()) {
    await query(
      `
        insert into bling_integrations (
          user_id,
          client_id,
          client_secret,
          access_token,
          refresh_token,
          token_expires_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (user_id) do update set
          client_id = excluded.client_id,
          client_secret = excluded.client_secret,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          token_expires_at = excluded.token_expires_at,
          updated_at = excluded.updated_at
      `,
      [
        integration.userId,
        integration.clientId,
        integration.clientSecret,
        integration.accessToken,
        integration.refreshToken,
        integration.tokenExpiresAt,
        integration.updatedAt
      ]
    );
    return publicBlingIntegration(integration);
  }

  const db = await readDb();
  const index = (db.blingIntegrations || []).findIndex((item) => item.userId === userId);
  if (index >= 0) db.blingIntegrations[index] = integration;
  else db.blingIntegrations.push(integration);
  await writeDb(db);
  return publicBlingIntegration(integration);
}

export async function deleteUserBlingIntegration(userId) {
  await ensureStore();
  if (hasPostgres()) {
    await query("delete from bling_integrations where user_id = $1", [userId]);
    return { ok: true };
  }

  const db = await readDb();
  db.blingIntegrations = (db.blingIntegrations || []).filter((integration) => integration.userId !== userId);
  await writeDb(db);
  return { ok: true };
}

export async function getBlingAppConfig() {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("select value from app_settings where key = $1 limit 1", ["bling_app_config"]);
    return normalizeBlingAppConfig(result.rows[0]?.value || {});
  }

  const db = await readDb();
  return normalizeBlingAppConfig(db.appSettings?.blingAppConfig || {});
}

export async function saveBlingAppConfig(payload = {}) {
  await ensureStore();
  const appConfig = normalizeBlingAppConfig(payload);
  if (!appConfig.clientId || !appConfig.clientSecret) throw new Error("Informe Client ID e Client Secret do Bling.");

  if (hasPostgres()) {
    await query(
      `
        insert into app_settings (key, value, updated_at)
        values ($1, $2, $3)
        on conflict (key) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      ["bling_app_config", appConfig, new Date().toISOString()]
    );
    return publicBlingAppConfig(appConfig);
  }

  const db = await readDb();
  db.appSettings = db.appSettings || {};
  db.appSettings.blingAppConfig = appConfig;
  await writeDb(db);
  return publicBlingAppConfig(appConfig);
}

export async function replaceCatalogProducts(products) {
  await ensureStore();
  const now = new Date().toISOString();
  const normalized = normalizeCatalogProducts(products, now);

  if (hasPostgres()) {
    const client = await getPgPool().connect();
    try {
      await client.query("begin");
      await client.query("delete from catalog_products");
      await insertCatalogProductRows(client, normalized);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { count: normalized.length };
  }

  const db = await readDb();
  db.catalogProducts = normalized;
  await writeDb(db);
  return { count: normalized.length };
}

export async function getUserLotSummaries(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const db = await readPgUserLotsDb(userId);
    return db.lots
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((lot) => summarizeLot(db, lot));
  }

  const db = await readDb();
  return db.lots
    .filter((lot) => lot.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((lot) => summarizeLot(db, lot));
}

export async function createLotFromImport({ userId, originalName, auctionPercent, fornecedor, skuPrefix, imported }) {
  await ensureStore();
  const lot = {
    id: randomUUID(),
    userId,
    nomeArquivo: originalName,
    percentualArremate: auctionPercent,
    custoMedioUnitario: 0,
    fornecedor,
    prefixoSku: skuPrefix,
    proximoSequencialSku: imported.nextSequence,
    createdAt: new Date().toISOString()
  };

  const products = imported.products.map((product) => ({ ...product, lotId: lot.id }));
  const rzItems = imported.items.map((item) => {
    const product = products.find((candidate) => candidate.id === item.productTempId);
    const { productTempId, ...cleanItem } = item;
    return { ...cleanItem, lotId: lot.id, productId: product.id };
  });

  if (hasPostgres()) {
    const client = await getPgPool().connect();
    try {
      await client.query("begin");
      await insertLotRows(client, { lots: [lot], products, rzItems });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return summarizeLot({ ...emptyDb(), lots: [lot], products, rzItems }, lot);
  }

  const db = await readDb();
  db.lots.push(lot);
  db.products.push(...products);
  db.rzItems.push(...rzItems);
  await writeDb(db);
  return summarizeLot(db, lot);
}

export async function createDiverseLot({ userId, name, fornecedor, skuPrefix, startSequence, averageCost }) {
  await ensureStore();
  const sequence = Math.max(1, Number.parseInt(startSequence, 10) || 1);
  const custoMedioUnitario = roundMoney(Number(averageCost || 0));
  if (!Number.isFinite(custoMedioUnitario) || custoMedioUnitario <= 0) {
    throw new Error("Informe o custo medio por unidade para criar lote sem planilha.");
  }
  const lot = {
    id: randomUUID(),
    userId,
    nomeArquivo: name,
    percentualArremate: 0,
    custoMedioUnitario,
    fornecedor,
    prefixoSku: skuPrefix,
    proximoSequencialSku: sequence,
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    const client = await getPgPool().connect();
    try {
      await client.query("begin");
      await insertLotRows(client, { lots: [lot] });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return summarizeLot({ ...emptyDb(), lots: [lot] }, lot, true);
  }

  const db = await readDb();
  db.lots.push(lot);
  await writeDb(db);
  return summarizeLot(db, lot, true);
}

export async function getUserLotDetail(userId, lotId) {
  await ensureStore();
  if (hasPostgres()) {
    const db = await readPgUserLotsDb(userId, { lotId });
    const lot = db.lots[0];
    return lot ? summarizeLot(db, lot, true) : null;
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  return lot ? summarizeLot(db, lot, true) : null;
}

export async function getLotBlingData(userId, lotId, kind) {
  await ensureStore();
  if (hasPostgres()) {
    const lotResult = await query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) return null;
    const origins = blingOriginsForKind(kind);
    const products = await query("select * from products where lot_id = $1 and origem = any($2::text[]) order by created_at asc", [lot.id, origins]);
    return { lot, products: products.rows.map(productFromRow) };
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) return null;
  return { lot, products: getBlingProducts(db, lot, kind) };
}

export async function listTransferLots(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const lots = await query("select * from transfer_lots where user_id = $1 order by created_at desc", [userId]);
    const lotIds = lots.rows.map((row) => row.id);
    const items = lotIds.length
      ? await query("select * from transfer_items where transfer_lot_id = any($1::text[]) order by created_at asc", [lotIds])
      : { rows: [] };
    return summarizeTransferLots(lots.rows.map(transferLotFromRow), items.rows.map(transferItemFromRow));
  }

  const db = await readDb();
  return summarizeTransferLots(
    (db.transferLots || []).filter((lot) => lot.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    db.transferItems || []
  );
}

export async function getTransferLotDetail(userId, transferLotId) {
  await ensureStore();
  if (hasPostgres()) {
    const lotResult = await query("select * from transfer_lots where id = $1 and user_id = $2 limit 1", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) return null;
    const items = await query("select * from transfer_items where transfer_lot_id = $1 order by created_at asc", [lot.id]);
    return summarizeTransferLot(lot, items.rows.map(transferItemFromRow));
  }

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) return null;
  return summarizeTransferLot(lot, db.transferItems || []);
}

export async function createTransferLot({ userId, name, depositoOrigem, depositoDestino, createdByUserId = null }) {
  await ensureStore();
  const lot = {
    id: randomUUID(),
    userId,
    name: String(name || "").trim() || `Transferencia ${new Date().toLocaleDateString("pt-BR")}`,
    depositoOrigem: String(depositoOrigem || "").trim(),
    depositoDestino: String(depositoDestino || "").trim(),
    status: "open",
    createdByUserId,
    createdAt: new Date().toISOString(),
    syncedAt: null
  };
  if (!lot.depositoOrigem) throw new Error("Informe o estoque de origem.");
  if (!lot.depositoDestino) throw new Error("Informe o estoque de destino.");
  if (normalizeText(lot.depositoOrigem) === normalizeText(lot.depositoDestino)) throw new Error("Origem e destino precisam ser diferentes.");

  if (hasPostgres()) {
    await insertTransferLotRows(null, [lot]);
    return summarizeTransferLot(lot, []);
  }

  const db = await readDb();
  db.transferLots.push(lot);
  await writeDb(db);
  return summarizeTransferLot(lot, []);
}

export async function scanTransferLot({ userId, transferLotId, code }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Informe o Codigo ML ou SKU.");
  if (hasPostgres()) return scanTransferLotPg({ userId, transferLotId, code: normalized });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");

  const product = findTransferProduct(db, userId, normalized);
  if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
  const existing = (db.transferItems || []).find((item) => item.transferLotId === lot.id && item.productId === product.id);
  if (existing) {
    existing.quantidade += 1;
  } else {
    db.transferItems.push(buildTransferItem(lot.id, product));
  }
  await writeDb(db);
  return { status: existing ? "updated" : "added", product, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function decrementTransferLotItem({ userId, transferLotId, itemId }) {
  await ensureStore();
  if (hasPostgres()) return decrementTransferLotItemPg({ userId, transferLotId, itemId });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");
  const item = (db.transferItems || []).find((candidate) => candidate.id === itemId && candidate.transferLotId === lot.id);
  if (!item) throw notFound("Item nao encontrado no lote.");
  item.quantidade -= 1;
  if (item.quantidade <= 0) db.transferItems = db.transferItems.filter((candidate) => candidate.id !== item.id);
  await writeDb(db);
  return { lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function markTransferLotSynced(userId, transferLotId) {
  await ensureStore();
  const syncedAt = new Date().toISOString();
  if (hasPostgres()) {
    const result = await query("update transfer_lots set status = 'synced', synced_at = $3 where id = $1 and user_id = $2 returning *", [transferLotId, userId, syncedAt]);
    if (!result.rows.length) throw notFound("Lote de transferencia nao encontrado.");
    return { ok: true, syncedAt };
  }

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  lot.status = "synced";
  lot.syncedAt = syncedAt;
  await writeDb(db);
  return { ok: true, syncedAt };
}

export async function scanLotRz({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (!normalizedMl) throw new Error("Informe o CÃ³digo ML.");

  if (hasPostgres()) return scanLotRzPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nÃ£o encontrado.");

  const rzItems = db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === codigoRz);
  const sameRzItems = rzItems.filter((item) => db.products.find((product) => product.id === item.productId)?.codigoMl === normalizedMl);
  const sameRzItem = chooseRzItemForScan(sameRzItems);
  const scan = {
    id: randomUUID(),
    lotId: lot.id,
    codigoRz,
    codigoMl: normalizedMl,
    status: "ok",
    createdAt: new Date().toISOString()
  };

  if (sameRzItem) {
    sameRzItem.qtdConferida += 1;
    const scannedProduct = db.products.find((product) => product.id === sameRzItem.productId);
    if (scannedProduct?.origem === "excedente_externo") scannedProduct.qtdTotal += 1;
    if (sameRzItem.qtdConferida > sameRzItem.qtdEsperada) {
      sameRzItem.tipoItem = sameRzItem.tipoItem === "esperado" ? "excedente_outro_rz" : sameRzItem.tipoItem;
      scan.status = "excedente";
    }
  } else {
    const sameLotProduct = db.products.find((product) => product.lotId === lot.id && product.codigoMl === normalizedMl);
    if (sameLotProduct) {
      scan.status = "outro_rz";
    } else {
      const history = findApprovedProductHistory(db, userId, lot.id, normalizedMl);
      scan.status = history.length ? "historico" : "desconhecido";
      scan.history = history.slice(0, 5);
    }
  }

  db.scans.push(scan);
  await writeDb(db);
  return { scan, lot: summarizeLot(db, lot, true) };
}

export async function decrementLotRzScan({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (!normalizedMl) throw new Error("Informe o CÃ³digo ML para diminuir.");

  if (hasPostgres()) return decrementLotRzScanPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nÃ£o encontrado.");

  const rzItems = db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === codigoRz);
  const sameRzItems = rzItems.filter((item) => db.products.find((product) => product.id === item.productId)?.codigoMl === normalizedMl);
  const sameRzItem = chooseRzItemForDecrement(sameRzItems);
  if (!sameRzItem) throw notFound("CÃ³digo ML nÃ£o encontrado neste RZ.");
  if (sameRzItem.qtdConferida <= 0) throw new Error("Este CÃ³digo ML jÃ¡ estÃ¡ com quantidade conferida zerada.");

  sameRzItem.qtdConferida -= 1;
  const product = db.products.find((item) => item.id === sameRzItem.productId);
  if (product?.origem === "excedente_externo") product.qtdTotal = Math.max(0, Number(product.qtdTotal || 0) - 1);
  if (sameRzItem.tipoItem === "excedente_outro_rz" && sameRzItem.qtdConferida <= sameRzItem.qtdEsperada) {
    sameRzItem.tipoItem = "esperado";
  }

  const scan = {
    id: randomUUID(),
    lotId: lot.id,
    codigoRz,
    codigoMl: normalizedMl,
    status: "diminuido",
    createdAt: new Date().toISOString()
  };
  db.scans.push(scan);
  await writeDb(db);
  return { scan, lot: summarizeLot(db, lot, true) };
}

export async function createExternalExcess({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (hasPostgres()) return createExternalExcessPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nÃ£o encontrado.");

  const history = findApprovedProductHistory(db, userId, lot.id, normalizedMl)[0];

  const existing = db.products.find((product) => product.lotId === lot.id && product.codigoMl === normalizedMl);
  if (existing) throw new Error("Este CÃ³digo ML jÃ¡ existe no lote atual.");

  const { product, item } = buildExternalExcessRecords(lot, history, codigoRz, normalizedMl);
  lot.proximoSequencialSku += 1;
  db.products.push(product);
  db.rzItems.push(item);
  await writeDb(db);
  return { product, lot: summarizeLot(db, lot, true) };
}

export async function createManualExternalExcess({ userId, createdByUserId = userId, operatorUserId = null, lotId, codigoRz, codigoMl, manualProduct }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (!normalizedMl) throw new Error("Informe o Codigo ML.");
  if (hasPostgres()) return createManualExternalExcessPg({ userId, createdByUserId, operatorUserId, lotId, codigoRz, codigoMl: normalizedMl, manualProduct });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");

  const existing = db.products.find((product) => product.lotId === lot.id && product.codigoMl === normalizedMl);
  if (existing) throw new Error("Este Codigo ML ja existe no lote atual.");

  const sourceManual = normalizeManualProduct(manualProduct, normalizedMl);
  const { product, item } = buildExternalExcessRecords(lot, sourceManual, codigoRz, normalizedMl);
  lot.proximoSequencialSku += 1;
  db.products.push(product);
  db.rzItems.push(item);
  mergePendingCatalogRequest(db.catalogRequests, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product, type: "create", payload: sourceManual }));
  db.scans.push({
    id: randomUUID(),
    lotId: lot.id,
    codigoRz,
    codigoMl: normalizedMl,
    status: "cadastro_manual",
    createdAt: new Date().toISOString()
  });
  await writeDb(db);
  return { status: "cadastro_manual", product, lot: summarizeLot(db, lot, true) };
}

export async function getExternalExcessProduct({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (!normalizedMl) throw new Error("Informe o Codigo ML.");
  if (hasPostgres()) return getExternalExcessProductPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");

  const item = db.rzItems.find((candidate) => {
    const product = db.products.find((entry) => entry.id === candidate.productId);
    return (
      candidate.lotId === lot.id &&
      candidate.codigoRz === codigoRz &&
      candidate.tipoItem === "excedente_externo" &&
      product?.codigoMl === normalizedMl &&
      product?.origem === "excedente_externo"
    );
  });
  if (!item) throw notFound("Excedente externo nao encontrado nesta RZ.");
  return db.products.find((product) => product.id === item.productId);
}

export async function deleteExternalExcess({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (!normalizedMl) throw new Error("Informe o Codigo ML.");
  if (hasPostgres()) return deleteExternalExcessPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");

  const product = await getExternalExcessProduct({ userId, lotId, codigoRz, codigoMl: normalizedMl });
  db.products = db.products.filter((candidate) => candidate.id !== product.id);
  db.rzItems = db.rzItems.filter((candidate) => candidate.productId !== product.id);
  db.scans.push({
    id: randomUUID(),
    lotId: lot.id,
    codigoRz,
    codigoMl: normalizedMl,
    status: "excedente_excluido",
    createdAt: new Date().toISOString()
  });
  await writeDb(db);
  return { product, lot: summarizeLot(db, lot, true) };
}

export async function addDiverseLotItem({ userId, createdByUserId = userId, operatorUserId = null, lotId, codigoMl, codigoRz, manualProduct, valorUnitOverride, preview = false }) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  const normalizedRz = String(codigoRz || "").trim().toUpperCase();
  if (!normalizedMl) throw new Error("Informe o CÃƒÂ³digo ML.");
  if (!normalizedRz) throw new Error("Informe o RZ.");
  if (hasPostgres()) return addDiverseLotItemPg({ userId, createdByUserId, operatorUserId, lotId, codigoMl: normalizedMl, codigoRz: normalizedRz, manualProduct, valorUnitOverride, preview });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nÃƒÂ£o encontrado.");

  const existing = db.products.find((product) => product.lotId === lot.id && product.codigoMl === normalizedMl);
  if (existing && preview) return { status: "preview_existing", product: existing, lot: summarizeLot(db, lot, true) };
  if (existing) {
    const item = db.rzItems.find((candidate) => candidate.productId === existing.id && candidate.codigoRz === normalizedRz);
    if (item) {
      item.qtdEsperada += 1;
      item.valorTotal = roundMoney(item.qtdEsperada * existing.valorUnit);
    } else {
      db.rzItems.push(buildDiverseRzItem(lot, existing, normalizedRz));
    }
    existing.qtdTotal += 1;
    await writeDb(db);
    return { status: item ? "duplicado_rz" : "mesmo_sku_novo_rz", product: existing, lot: summarizeLot(db, lot, true) };
  }

  const history = findApprovedProductHistory(db, userId, lot.id, normalizedMl)[0];
  const previousHistory = history ? null : findProductHistory(db, userId, lot.id, normalizedMl)[0];
  const source = history || previousHistory || findCatalogProduct(db, normalizedMl);
  if (!existing && source && preview) {
    return { status: "preview", product: { ...source, codigoMl: normalizedMl }, source: history || previousHistory ? "historico" : "catalogo_oculto", lot: summarizeLot(db, lot, true) };
  }
  if (previousHistory) {
    const { product, item } = buildDiverseLotRecords(lot, previousHistory, normalizedMl, normalizedRz, { valorUnitOverride });
    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    await writeDb(db);
    return { status: "criado", product, parent: previousHistory, source: "historico", lot: summarizeLot(db, lot, true) };
  }
  if (!history && source) {
    const { product, item } = buildDiverseLotRecords(lot, source, normalizedMl, normalizedRz, { valorUnitOverride });
    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    await writeDb(db);
    return { status: "criado", product, parent: null, source: "catalogo_oculto", lot: summarizeLot(db, lot, true) };
  }
  if (!history && manualProduct) {
    const sourceManual = normalizeManualProduct(manualProduct, normalizedMl);
    const { product, item } = buildDiverseLotRecords(lot, sourceManual, normalizedMl, normalizedRz, { origem: "lote_sem_planilha_manual" });
    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    mergePendingCatalogRequest(db.catalogRequests, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product, type: "create", payload: sourceManual }));
    await writeDb(db);
    return { status: "cadastro_manual", product, lot: summarizeLot(db, lot, true) };
  }

  if (!history) {
    const error = new Error("Codigo ML nao encontrado no banco historico. Preencha o cadastro manual para seguir.");
    error.status = 404;
    error.code = "manual_required";
    throw error;
  }

  const { product, item } = buildDiverseLotRecords(lot, history, normalizedMl, normalizedRz, { valorUnitOverride });
  lot.proximoSequencialSku += 1;
  db.products.push(product);
  db.rzItems.push(item);
  await writeDb(db);
  return { status: "criado", product, parent: history, lot: summarizeLot(db, lot, true) };
}

export async function suggestCatalogUpdate({ userId, createdByUserId = userId, operatorUserId = null, lotId, productId, payload }) {
  await ensureStore();
  if (hasPostgres()) return suggestCatalogUpdatePg({ userId, createdByUserId, operatorUserId, lotId, productId, payload });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");
  const product = db.products.find((item) => item.id === productId && item.lotId === lot.id);
  if (!product) throw notFound("Produto nao encontrado.");
  const normalized = normalizeManualProduct({ ...product, ...payload }, product.codigoMl);
  mergePendingCatalogRequest(db.catalogRequests, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product, type: "update", payload: normalized }));
  await writeDb(db);
  return { ok: true };
}

export async function listCatalogRequestsForAdmin() {
  await ensureStore();
  if (hasPostgres()) {
    const [result, usersResult] = await Promise.all([
      query(`
      select cr.*, u.name as user_name, u.email as user_email
      from catalog_requests cr
      left join users u on u.id = cr.user_id
      where cr.status <> 'rejected'
      order by cr.created_at desc
    `),
      query("select id, name, email, created_at from users")
    ]);
    const usersById = new Map(usersResult.rows.map((row) => [row.id, sanitizeUser(userFromRow(row))]));
    return result.rows.map((row) => enrichCatalogRequestDoubleChecks(catalogRequestFromRow(row), usersById));
  }

  const db = await readDb();
  const usersById = new Map(db.users.map((user) => [user.id, sanitizeUser(user)]));
  return (db.catalogRequests || [])
    .filter((request) => request.status !== "rejected")
    .map((request) => enrichCatalogRequestDoubleChecks({
      ...request,
      user: usersById.get(request.userId) || null
    }, usersById))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listRejectedCatalogRequestsForAdmin() {
  await ensureStore();
  if (hasPostgres()) {
    const [result, usersResult] = await Promise.all([
      query(`
      select crr.*, u.name as user_name, u.email as user_email
      from catalog_rejected_requests crr
      left join users u on u.id = crr.user_id
      order by crr.rejected_at desc
      limit 200
    `),
      query("select id, name, email, created_at from users")
    ]);
    const usersById = new Map(usersResult.rows.map((row) => [row.id, sanitizeUser(userFromRow(row))]));
    return result.rows.map((row) => enrichCatalogRequestDoubleChecks({
      ...catalogRejectedRequestFromRow(row),
      user: row.user_name || row.user_email ? { name: row.user_name || "", email: row.user_email || "" } : null
    }, usersById));
  }

  const db = await readDb();
  const usersById = new Map(db.users.map((user) => [user.id, sanitizeUser(user)]));
  return (db.catalogRejectedRequests || [])
    .map((request) => enrichCatalogRequestDoubleChecks({
      ...request,
      user: usersById.get(request.userId) || null
    }, usersById))
    .sort((a, b) => String(b.rejectedAt || "").localeCompare(String(a.rejectedAt || "")))
    .slice(0, 200);
}

export async function listCatalogProductsForAdmin(search = "") {
  await ensureStore();
  const term = String(search || "").trim();
  if (hasPostgres()) {
    const params = [];
    let where = "";
    if (term) {
      params.push(`%${term}%`);
      where = "where codigo_ml ilike $1 or descricao ilike $1 or ean ilike $1";
    }
    const result = await query(
      `select * from catalog_products ${where} order by updated_at desc, codigo_ml asc limit 200`,
      params
    );
    return result.rows.map(catalogProductFromRow);
  }

  const normalized = term.toLowerCase();
  return (await readDb()).catalogProducts
    .filter((product) => {
      if (!normalized) return true;
      return product.codigoMl.toLowerCase().includes(normalized) || product.descricao.toLowerCase().includes(normalized) || String(product.ean || "").toLowerCase().includes(normalized);
    })
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, 200);
}

export async function deleteCatalogProductForAdmin(productId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("delete from catalog_products where id = $1 returning id", [productId]);
    if (!result.rows.length) throw notFound("Produto do banco historico nao encontrado.");
    return { ok: true };
  }

  const db = await readDb();
  const before = db.catalogProducts.length;
  db.catalogProducts = db.catalogProducts.filter((product) => product.id !== productId);
  if (db.catalogProducts.length === before) throw notFound("Produto do banco historico nao encontrado.");
  await writeDb(db);
  return { ok: true };
}

export async function reviewCatalogRequest(requestId, action, options = {}) {
  await ensureStore();
  if (hasPostgres()) return reviewCatalogRequestPg(requestId, action, options);

  const db = await readDb();
  const request = (db.catalogRequests || []).find((item) => item.id === requestId);
  if (!request) throw notFound("Sugestao nao encontrada.");
  if (request.status !== "pending") throw new Error("Esta sugestao ja foi analisada.");

  if (action === "approve") {
    upsertCatalogProduct(db, selectCatalogApprovalPayload(request, options.selectedCheckId));
    request.status = "approved";
    request.reviewedAt = new Date().toISOString();
  } else if (action === "reject") {
    const reviewedAt = new Date().toISOString();
    db.catalogRejectedRequests = db.catalogRejectedRequests || [];
    db.catalogRejectedRequests.push(buildRejectedCatalogRequest(request, reviewedAt));
    db.catalogRequests = (db.catalogRequests || []).filter((item) => item.id !== requestId);
  } else {
    throw new Error("Acao invalida.");
  }
  await writeDb(db);
  return { ok: true };
}

export async function searchProducts(userId, codigoMl) {
  await ensureStore();
  const normalizedMl = normalizeCode(codigoMl);
  if (hasPostgres()) {
    const result = await query(
      `
        select
          p.*,
          l.id as lot__id,
          l.user_id as lot__user_id,
          l.nome_arquivo as lot__nome_arquivo,
          l.percentual_arremate as lot__percentual_arremate,
          l.custo_medio_unitario as lot__custo_medio_unitario,
          l.fornecedor as lot__fornecedor,
          l.prefixo_sku as lot__prefixo_sku,
          l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
          l.created_at as lot__created_at,
          coalesce(array_agg(ri.codigo_rz order by ri.codigo_rz) filter (where ri.id is not null), '{}') as rzs
        from products p
        join lots l on l.id = p.lot_id
        left join rz_items ri on ri.product_id = p.id
        where l.user_id = $1 and p.codigo_ml = $2
        group by p.id, l.id
        order by p.created_at desc
      `,
      [userId, normalizedMl]
    );
    return result.rows.map((row) => ({
      ...productFromRow(row),
      lot: lotFromPrefixedRow(row, "lot__"),
      rzs: row.rzs || []
    }));
  }

  const db = await readDb();
  const lotsById = new Map(db.lots.filter((lot) => lot.userId === userId).map((lot) => [lot.id, lot]));
  return db.products
    .filter((product) => product.codigoMl === normalizedMl && lotsById.has(product.lotId))
    .map((product) => ({
      ...product,
      lot: lotsById.get(product.lotId),
      rzs: db.rzItems.filter((item) => item.productId === product.id).map((item) => item.codigoRz)
    }));
}

export async function createLabel(userId, productId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      `
        select
          p.*,
          l.id as lot__id,
          l.user_id as lot__user_id,
          l.nome_arquivo as lot__nome_arquivo,
          l.percentual_arremate as lot__percentual_arremate,
          l.custo_medio_unitario as lot__custo_medio_unitario,
          l.fornecedor as lot__fornecedor,
          l.prefixo_sku as lot__prefixo_sku,
          l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
          l.created_at as lot__created_at
        from products p
        join lots l on l.id = p.lot_id
        where p.id = $1 and l.user_id = $2
        limit 1
      `,
      [productId, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const product = productFromRow(row);
    const lot = lotFromPrefixedRow(row, "lot__");
    const label = {
      id: randomUUID(),
      productId: product.id,
      lotId: lot.id,
      userId,
      createdAt: new Date().toISOString()
    };
    await query(
      `insert into labels (id, product_id, lot_id, user_id, created_at)
       values ($1, $2, $3, $4, $5)`,
      [label.id, label.productId, label.lotId, label.userId, label.createdAt]
    );
    return { label, product, lot };
  }

  const db = await readDb();
  const product = db.products.find((item) => item.id === productId);
  const lot = product && db.lots.find((item) => item.id === product.lotId && item.userId === userId);
  if (!product || !lot) return null;
  const label = {
    id: randomUUID(),
    productId: product.id,
    lotId: lot.id,
    userId,
    createdAt: new Date().toISOString()
  };
  db.labels.push(label);
  await writeDb(db);
  return { label, product, lot };
}

async function ensurePgStore() {
  await query(`
    create table if not exists users (
      id text primary key,
      tenant_id text not null,
      tenant_name text not null,
      parent_user_id text references users(id) on delete cascade,
      role text not null default 'owner',
      operator_code integer,
      name text not null,
      email text not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists lots (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      nome_arquivo text not null,
      percentual_arremate numeric not null,
      custo_medio_unitario numeric not null default 0,
      fornecedor text not null,
      prefixo_sku text not null,
      proximo_sequencial_sku integer not null,
      created_at timestamptz not null default now()
    );

    create table if not exists products (
      id text primary key,
      lot_id text not null references lots(id) on delete cascade,
      codigo_ml text not null,
      sku text not null,
      descricao text not null,
      valor_unit numeric not null default 0,
      preco_custo numeric not null default 0,
      qtd_total integer not null default 0,
      categoria text not null default '',
      subcategoria text not null default '',
      ean text not null default '',
      link text not null default '',
      foto text not null default '',
      origem text not null default 'planilha',
      created_at timestamptz not null default now()
    );

    create table if not exists catalog_products (
      id text primary key,
      codigo_ml text not null unique,
      descricao text not null,
      valor_unit numeric not null default 0,
      preco_custo numeric not null default 0,
      categoria text not null default '',
      subcategoria text not null default '',
      ean text not null default '',
      link text not null default '',
      foto text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists rz_items (
      id text primary key,
      lot_id text not null references lots(id) on delete cascade,
      product_id text not null references products(id) on delete cascade,
      codigo_rz text not null,
      endereco_wms text not null default '',
      qtd_esperada integer not null default 0,
      qtd_conferida integer not null default 0,
      condicao_grade text not null default '',
      valor_total numeric not null default 0,
      tipo_item text not null default 'esperado',
      created_at timestamptz not null default now()
    );

    create table if not exists scans (
      id text primary key,
      lot_id text not null references lots(id) on delete cascade,
      codigo_rz text not null,
      codigo_ml text not null,
      status text not null,
      history jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists labels (
      id text primary key,
      product_id text not null references products(id) on delete cascade,
      lot_id text not null references lots(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      created_at timestamptz not null default now()
    );

    create table if not exists bling_integrations (
      user_id text primary key references users(id) on delete cascade,
      client_id text not null default '',
      client_secret text not null default '',
      access_token text not null default '',
      refresh_token text not null default '',
      token_expires_at timestamptz,
      updated_at timestamptz not null default now()
    );

    create table if not exists app_settings (
      key text primary key,
      value jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );

    create table if not exists transfer_lots (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      name text not null,
      deposito_origem text not null,
      deposito_destino text not null,
      status text not null default 'open',
      created_by_user_id text references users(id) on delete set null,
      created_at timestamptz not null default now(),
      synced_at timestamptz
    );

    create table if not exists transfer_items (
      id text primary key,
      transfer_lot_id text not null references transfer_lots(id) on delete cascade,
      source_lot_id text references lots(id) on delete set null,
      product_id text references products(id) on delete set null,
      codigo_ml text not null,
      sku text not null,
      descricao text not null,
      ean text not null default '',
      quantidade integer not null default 0,
      created_at timestamptz not null default now()
    );

    create table if not exists operator_activities (
      id text primary key,
      owner_user_id text not null references users(id) on delete cascade,
      operator_user_id text not null references users(id) on delete cascade,
      action text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists catalog_requests (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      created_by_user_id text references users(id) on delete set null,
      operator_user_id text references users(id) on delete set null,
      lot_id text references lots(id) on delete set null,
      product_id text references products(id) on delete set null,
      type text not null,
      status text not null default 'pending',
      codigo_ml text not null,
      descricao text not null,
      valor_unit numeric not null default 0,
      preco_custo numeric not null default 0,
      categoria text not null default '',
      subcategoria text not null default '',
      ean text not null default '',
      link text not null default '',
      foto text not null default '',
      double_checks jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      reviewed_at timestamptz
    );

    create table if not exists catalog_rejected_requests (
      id text primary key,
      original_request_id text not null,
      user_id text not null,
      created_by_user_id text,
      operator_user_id text,
      lot_id text,
      product_id text,
      type text not null,
      status text not null default 'rejected',
      codigo_ml text not null,
      descricao text not null,
      valor_unit numeric not null default 0,
      preco_custo numeric not null default 0,
      categoria text not null default '',
      subcategoria text not null default '',
      ean text not null default '',
      link text not null default '',
      foto text not null default '',
      double_checks jsonb not null default '[]'::jsonb,
      created_at timestamptz not null,
      rejected_at timestamptz not null default now()
    );

    alter table users add column if not exists tenant_id text;
    alter table users add column if not exists tenant_name text;
    alter table users add column if not exists parent_user_id text references users(id) on delete cascade;
    alter table users add column if not exists role text not null default 'owner';
    alter table users add column if not exists operator_code integer;
    update users set tenant_id = id where tenant_id is null or tenant_id = '';
    update users set tenant_name = name where tenant_name is null or tenant_name = '';
    update users set role = 'operator' where parent_user_id is not null and (role is null or role = 'owner');
    with numbered_operators as (
      select
        id,
        1000 + row_number() over (partition by parent_user_id order by created_at asc, id asc) as generated_code
      from users
      where parent_user_id is not null and operator_code is null
    )
    update users u
    set operator_code = n.generated_code
    from numbered_operators n
    where u.id = n.id;
    alter table users alter column tenant_id set not null;
    alter table users alter column tenant_name set not null;
    alter table lots add column if not exists custo_medio_unitario numeric not null default 0;
    alter table products add column if not exists ean text not null default '';
    alter table products add column if not exists link text not null default '';
    alter table products add column if not exists foto text not null default '';
    alter table catalog_products add column if not exists ean text not null default '';
    alter table catalog_products add column if not exists link text not null default '';
    alter table catalog_products add column if not exists foto text not null default '';
    alter table catalog_requests add column if not exists ean text not null default '';
    alter table catalog_requests add column if not exists link text not null default '';
    alter table catalog_requests add column if not exists foto text not null default '';
    alter table catalog_requests add column if not exists double_checks jsonb not null default '[]'::jsonb;
    alter table catalog_requests add column if not exists created_by_user_id text references users(id) on delete set null;
    alter table catalog_requests add column if not exists operator_user_id text references users(id) on delete set null;
    alter table catalog_rejected_requests add column if not exists created_by_user_id text;
    alter table catalog_rejected_requests add column if not exists operator_user_id text;
    update catalog_requests set created_by_user_id = user_id where created_by_user_id is null or created_by_user_id = '';
    update catalog_rejected_requests set created_by_user_id = user_id where created_by_user_id is null or created_by_user_id = '';

    create index if not exists users_tenant_id_idx on users(tenant_id);
    create index if not exists users_parent_user_id_idx on users(parent_user_id);
    create index if not exists lots_user_id_idx on lots(user_id);
    create index if not exists products_lot_id_idx on products(lot_id);
    create index if not exists products_codigo_ml_idx on products(codigo_ml);
    create index if not exists products_lot_codigo_ml_idx on products(lot_id, codigo_ml);
    create index if not exists catalog_products_codigo_ml_idx on catalog_products(codigo_ml);
    create index if not exists rz_items_lot_id_idx on rz_items(lot_id);
    create index if not exists rz_items_product_id_idx on rz_items(product_id);
    create index if not exists rz_items_lot_codigo_rz_idx on rz_items(lot_id, codigo_rz);
    create index if not exists scans_lot_id_idx on scans(lot_id);
    create index if not exists labels_product_id_idx on labels(product_id);
    create index if not exists labels_lot_id_idx on labels(lot_id);
    create index if not exists labels_user_id_idx on labels(user_id);
    create index if not exists bling_integrations_updated_at_idx on bling_integrations(updated_at);
    create index if not exists operator_activities_owner_user_id_idx on operator_activities(owner_user_id);
    create index if not exists operator_activities_operator_user_id_idx on operator_activities(operator_user_id);
    create index if not exists operator_activities_action_idx on operator_activities(action);
    create index if not exists operator_activities_created_at_idx on operator_activities(created_at);
    create index if not exists transfer_lots_user_id_idx on transfer_lots(user_id);
    create index if not exists transfer_items_transfer_lot_id_idx on transfer_items(transfer_lot_id);
    create index if not exists transfer_items_sku_idx on transfer_items(sku);
    create index if not exists catalog_requests_status_idx on catalog_requests(status);
    create index if not exists catalog_requests_codigo_ml_idx on catalog_requests(codigo_ml);
    create index if not exists catalog_rejected_requests_codigo_ml_idx on catalog_rejected_requests(codigo_ml);
    create index if not exists catalog_rejected_requests_rejected_at_idx on catalog_rejected_requests(rejected_at);
  `);
  await query(`
    insert into catalog_rejected_requests (
      id,
      original_request_id,
      user_id,
      created_by_user_id,
      operator_user_id,
      lot_id,
      product_id,
      type,
      status,
      codigo_ml,
      descricao,
      valor_unit,
      preco_custo,
      categoria,
      subcategoria,
      ean,
      link,
      foto,
      double_checks,
      created_at,
      rejected_at
    )
    select
      cr.id || '-rejected',
      cr.id,
      cr.user_id,
      cr.created_by_user_id,
      cr.operator_user_id,
      cr.lot_id,
      cr.product_id,
      cr.type,
      'rejected',
      cr.codigo_ml,
      cr.descricao,
      cr.valor_unit,
      cr.preco_custo,
      cr.categoria,
      cr.subcategoria,
      cr.ean,
      cr.link,
      cr.foto,
      cr.double_checks,
      cr.created_at,
      coalesce(cr.reviewed_at, now())
    from catalog_requests cr
    where cr.status = 'rejected'
      and not exists (
        select 1 from catalog_rejected_requests crr where crr.original_request_id = cr.id
      )
    on conflict (id) do nothing
  `);
  await query("delete from catalog_requests where status = 'rejected'");
}

async function readPgDb() {
  const [users, lots, products, rzItems, scans, labels, blingIntegrations, transferLots, transferItems, operatorActivities, catalogProducts, catalogRequests, catalogRejectedRequests] = await Promise.all([
    query("select * from users order by created_at asc"),
    query("select * from lots order by created_at asc"),
    query("select * from products order by created_at asc"),
    query("select * from rz_items order by created_at asc"),
    query("select * from scans order by created_at asc"),
    query("select * from labels order by created_at asc"),
    query("select * from bling_integrations order by updated_at asc"),
    query("select * from transfer_lots order by created_at asc"),
    query("select * from transfer_items order by created_at asc"),
    query("select * from operator_activities order by created_at asc"),
    query("select * from catalog_products order by codigo_ml asc"),
    query("select * from catalog_requests order by created_at asc"),
    query("select * from catalog_rejected_requests order by rejected_at asc")
  ]);

  return {
    users: users.rows.map(userFromRow),
    lots: lots.rows.map(lotFromRow),
    products: products.rows.map(productFromRow),
    rzItems: rzItems.rows.map(rzItemFromRow),
    scans: scans.rows.map(scanFromRow),
    labels: labels.rows.map(labelFromRow),
    blingIntegrations: blingIntegrations.rows.map(blingIntegrationFromRow),
    transferLots: transferLots.rows.map(transferLotFromRow),
    transferItems: transferItems.rows.map(transferItemFromRow),
    operatorActivities: operatorActivities.rows.map(operatorActivityFromRow),
    catalogProducts: catalogProducts.rows.map(catalogProductFromRow),
    catalogRequests: catalogRequests.rows.map(catalogRequestFromRow),
    catalogRejectedRequests: catalogRejectedRequests.rows.map(catalogRejectedRequestFromRow)
  };
}

async function writePgDb(db) {
  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from catalog_rejected_requests");
    await client.query("delete from catalog_requests");
    await client.query("delete from operator_activities");
    await client.query("delete from transfer_items");
    await client.query("delete from transfer_lots");
    await client.query("delete from bling_integrations");
    await client.query("delete from labels");
    await client.query("delete from scans");
    await client.query("delete from rz_items");
    await client.query("delete from products");
    await client.query("delete from lots");
    await client.query("delete from users");
    await client.query("delete from catalog_products");

    await insertRows(
      client,
      "users",
      ["id", "tenant_id", "tenant_name", "parent_user_id", "role", "operator_code", "name", "email", "password_hash", "created_at"],
      (db.users || []).map((user) => [
        user.id,
        user.tenantId || user.id,
        user.tenantName || user.name,
        user.parentUserId || null,
        user.role || (user.parentUserId ? "operator" : "owner"),
        user.operatorCode || null,
        user.name,
        user.email,
        user.passwordHash,
        user.createdAt
      ])
    );
    await insertRows(
      client,
      "lots",
      ["id", "user_id", "nome_arquivo", "percentual_arremate", "custo_medio_unitario", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "created_at"],
      (db.lots || []).map((lot) => [
        lot.id,
        lot.userId,
        lot.nomeArquivo,
        lot.percentualArremate,
        lot.custoMedioUnitario || 0,
        lot.fornecedor,
        lot.prefixoSku,
        lot.proximoSequencialSku,
        lot.createdAt
      ])
    );
    await insertRows(
      client,
      "products",
      ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "ean", "link", "foto", "origem", "created_at"],
      (db.products || []).map((product) => [
        product.id,
        product.lotId,
        product.codigoMl,
        product.sku,
        product.descricao,
        product.valorUnit,
        product.precoCusto,
        product.qtdTotal,
        product.categoria || "",
        product.subcategoria || "",
        product.ean || "",
        product.link || "",
        product.foto || "",
        product.origem || "planilha",
        product.createdAt
      ])
    );
    await insertRows(
      client,
      "rz_items",
      ["id", "lot_id", "product_id", "codigo_rz", "endereco_wms", "qtd_esperada", "qtd_conferida", "condicao_grade", "valor_total", "tipo_item", "created_at"],
      (db.rzItems || []).map((item) => [
        item.id,
        item.lotId,
        item.productId,
        item.codigoRz,
        item.enderecoWms || "",
        item.qtdEsperada,
        item.qtdConferida,
        item.condicaoGrade || "",
        item.valorTotal || 0,
        item.tipoItem || "esperado",
        item.createdAt
      ])
    );
    await insertRows(
      client,
      "scans",
      ["id", "lot_id", "codigo_rz", "codigo_ml", "status", "history", "created_at"],
      (db.scans || []).map((scan) => [
        scan.id,
        scan.lotId,
        scan.codigoRz,
        scan.codigoMl,
        scan.status,
        scan.history ? JSON.stringify(scan.history) : null,
        scan.createdAt
      ])
    );
    await insertRows(
      client,
      "labels",
      ["id", "product_id", "lot_id", "user_id", "created_at"],
      (db.labels || []).map((label) => [label.id, label.productId, label.lotId, label.userId, label.createdAt])
    );
    await insertBlingIntegrationRows(client, db.blingIntegrations || []);
    await insertTransferLotRows(client, db.transferLots || []);
    await insertTransferItemRows(client, db.transferItems || []);
    await insertOperatorActivityRows(client, db.operatorActivities || []);
    await insertCatalogProductRows(client, db.catalogProducts || []);
    await insertCatalogRequestRows(client, db.catalogRequests || []);
    await insertCatalogRejectedRequestRows(client, db.catalogRejectedRequests || []);

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readPgUserLotsDb(userId, { lotId } = {}) {
  const lotParams = lotId ? [userId, lotId] : [userId];
  const lotsResult = await query(
    `select * from lots where user_id = $1 ${lotId ? "and id = $2" : ""} order by created_at asc`,
    lotParams
  );
  const lots = lotsResult.rows.map(lotFromRow);
  if (!lots.length) return { ...emptyDb(), lots };

  const lotIds = lots.map((lot) => lot.id);
  const [products, rzItems] = await Promise.all([
    query("select * from products where lot_id = any($1::text[]) order by created_at asc", [lotIds]),
    query("select * from rz_items where lot_id = any($1::text[]) order by created_at asc", [lotIds])
  ]);

  return {
    ...emptyDb(),
    lots,
    products: products.rows.map(productFromRow),
    rzItems: rzItems.rows.map(rzItemFromRow)
  };
}

async function insertLotRows(client, { lots = [], products = [], rzItems = [] }) {
  await insertRows(
    client,
    "lots",
    ["id", "user_id", "nome_arquivo", "percentual_arremate", "custo_medio_unitario", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "created_at"],
    lots.map((lot) => [
      lot.id,
      lot.userId,
      lot.nomeArquivo,
      lot.percentualArremate,
      lot.custoMedioUnitario || 0,
      lot.fornecedor,
      lot.prefixoSku,
      lot.proximoSequencialSku,
      lot.createdAt
    ])
  );
  await insertRows(
    client,
    "products",
    ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "ean", "link", "foto", "origem", "created_at"],
    products.map((product) => [
      product.id,
      product.lotId,
      product.codigoMl,
      product.sku,
      product.descricao,
      product.valorUnit,
      product.precoCusto,
      product.qtdTotal,
      product.categoria || "",
      product.subcategoria || "",
      product.ean || "",
      product.link || "",
      product.foto || "",
      product.origem || "planilha",
      product.createdAt
    ])
  );
  await insertRows(
    client,
    "rz_items",
    ["id", "lot_id", "product_id", "codigo_rz", "endereco_wms", "qtd_esperada", "qtd_conferida", "condicao_grade", "valor_total", "tipo_item", "created_at"],
    rzItems.map((item) => [
      item.id,
      item.lotId,
      item.productId,
      item.codigoRz,
      item.enderecoWms || "",
      item.qtdEsperada,
      item.qtdConferida,
      item.condicaoGrade || "",
      item.valorTotal || 0,
      item.tipoItem || "esperado",
      item.createdAt
    ])
  );
}

async function insertCatalogProductRows(client, products = []) {
  await insertRows(
    client,
    "catalog_products",
    ["id", "codigo_ml", "descricao", "valor_unit", "preco_custo", "categoria", "subcategoria", "ean", "link", "foto", "created_at", "updated_at"],
    products.map((product) => [
      product.id,
      product.codigoMl,
      product.descricao,
      product.valorUnit,
      product.precoCusto,
      product.categoria || "",
      product.subcategoria || "",
      product.ean || "",
      product.link || "",
      product.foto || "",
      product.createdAt,
      product.updatedAt || product.createdAt
    ])
  );
}

async function insertBlingIntegrationRows(client, integrations = []) {
  await insertRows(
    client,
    "bling_integrations",
    ["user_id", "client_id", "client_secret", "access_token", "refresh_token", "token_expires_at", "updated_at"],
    integrations.map((integration) => [
      integration.userId,
      integration.clientId || "",
      integration.clientSecret || "",
      integration.accessToken || "",
      integration.refreshToken || "",
      integration.tokenExpiresAt || null,
      integration.updatedAt
    ])
  );
}

async function insertTransferLotRows(client, lots = []) {
  const target = client || { query };
  await insertRows(
    target,
    "transfer_lots",
    ["id", "user_id", "name", "deposito_origem", "deposito_destino", "status", "created_by_user_id", "created_at", "synced_at"],
    lots.map((lot) => [
      lot.id,
      lot.userId,
      lot.name,
      lot.depositoOrigem,
      lot.depositoDestino,
      lot.status || "open",
      lot.createdByUserId || null,
      lot.createdAt,
      lot.syncedAt || null
    ])
  );
}

async function insertTransferItemRows(client, items = []) {
  const target = client || { query };
  await insertRows(
    target,
    "transfer_items",
    ["id", "transfer_lot_id", "source_lot_id", "product_id", "codigo_ml", "sku", "descricao", "ean", "quantidade", "created_at"],
    items.map((item) => [
      item.id,
      item.transferLotId,
      item.sourceLotId || null,
      item.productId || null,
      item.codigoMl,
      item.sku,
      item.descricao,
      item.ean || "",
      item.quantidade || 0,
      item.createdAt
    ])
  );
}

async function insertOperatorActivityRows(client, activities = []) {
  await insertRows(
    client,
    "operator_activities",
    ["id", "owner_user_id", "operator_user_id", "action", "metadata", "created_at"],
    activities.map((activity) => [
      activity.id,
      activity.ownerUserId,
      activity.operatorUserId,
      activity.action,
      JSON.stringify(activity.metadata || {}),
      activity.createdAt
    ])
  );
}

async function insertCatalogRequestRows(client, requests = []) {
  await insertRows(
    client,
    "catalog_requests",
    [
      "id",
      "user_id",
      "created_by_user_id",
      "operator_user_id",
      "lot_id",
      "product_id",
      "type",
      "status",
      "codigo_ml",
      "descricao",
      "valor_unit",
      "preco_custo",
      "categoria",
      "subcategoria",
      "ean",
      "link",
      "foto",
      "double_checks",
      "created_at",
      "reviewed_at"
    ],
    requests.map((request) => [
      request.id,
      request.userId,
      request.createdByUserId || request.userId,
      request.operatorUserId || null,
      request.lotId || null,
      request.productId || null,
      request.type,
      request.status || "pending",
      request.codigoMl,
      request.descricao,
      request.valorUnit,
      request.precoCusto || 0,
      request.categoria || "",
      request.subcategoria || "",
      request.ean || "",
      request.link || "",
      request.foto || "",
      JSON.stringify(request.doubleChecks || []),
      request.createdAt,
      request.reviewedAt || null
    ])
  );
}

async function insertCatalogRejectedRequestRows(client, requests = []) {
  await insertRows(
    client,
    "catalog_rejected_requests",
    [
      "id",
      "original_request_id",
      "user_id",
      "created_by_user_id",
      "operator_user_id",
      "lot_id",
      "product_id",
      "type",
      "status",
      "codigo_ml",
      "descricao",
      "valor_unit",
      "preco_custo",
      "categoria",
      "subcategoria",
      "ean",
      "link",
      "foto",
      "double_checks",
      "created_at",
      "rejected_at"
    ],
    requests.map((request) => [
      request.id,
      request.originalRequestId,
      request.userId,
      request.createdByUserId || request.userId,
      request.operatorUserId || null,
      request.lotId || null,
      request.productId || null,
      request.type,
      request.status || "rejected",
      request.codigoMl,
      request.descricao,
      request.valorUnit,
      request.precoCusto || 0,
      request.categoria || "",
      request.subcategoria || "",
      request.ean || "",
      request.link || "",
      request.foto || "",
      JSON.stringify(request.doubleChecks || []),
      request.createdAt,
      request.rejectedAt
    ])
  );
}

async function scanLotRzPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let scan;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nÃ£o encontrado.");

    scan = {
      id: randomUUID(),
      lotId: lot.id,
      codigoRz,
      codigoMl,
      status: "ok",
      createdAt: new Date().toISOString()
    };

    const sameRzResult = await client.query(
      `
        select
          ri.*,
          p.codigo_ml as product_codigo_ml,
          p.origem as product_origem
        from rz_items ri
        join products p on p.id = ri.product_id
        where ri.lot_id = $1 and ri.codigo_rz = $2 and p.codigo_ml = $3
        order by ri.created_at asc
        for update of ri
      `,
      [lot.id, codigoRz, codigoMl]
    );

    const sameRzItem = choosePgRzItemForScan(sameRzResult.rows);
    if (sameRzItem) {
      const nextQtdConferida = Number(sameRzItem.qtd_conferida) + 1;
      const nextTipoItem =
        nextQtdConferida > Number(sameRzItem.qtd_esperada) && sameRzItem.tipo_item === "esperado" ? "excedente_outro_rz" : sameRzItem.tipo_item;
      await client.query("update rz_items set qtd_conferida = $1, tipo_item = $2 where id = $3", [nextQtdConferida, nextTipoItem, sameRzItem.id]);
      if (sameRzItem.product_origem === "excedente_externo") {
        await client.query("update products set qtd_total = qtd_total + 1 where id = $1", [sameRzItem.product_id]);
      }
      if (nextQtdConferida > Number(sameRzItem.qtd_esperada)) scan.status = "excedente";
    } else {
      const sameLotProduct = await client.query("select id from products where lot_id = $1 and codigo_ml = $2 limit 1", [lot.id, codigoMl]);
      if (sameLotProduct.rows.length) {
        scan.status = "outro_rz";
      } else {
        const history = await findPgProductHistory(client, userId, lot.id, codigoMl, 5);
        scan.status = history.length ? "historico" : "desconhecido";
        scan.history = history;
      }
    }

    await client.query(
      `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [scan.id, scan.lotId, scan.codigoRz, scan.codigoMl, scan.status, scan.history ? JSON.stringify(scan.history) : null, scan.createdAt]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { scan, lot: await getUserLotDetail(userId, lotId) };
}

async function decrementLotRzScanPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let scan;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nÃ£o encontrado.");

    const sameRzResult = await client.query(
      `
        select
          ri.*,
          p.origem as product_origem
        from rz_items ri
        join products p on p.id = ri.product_id
        where ri.lot_id = $1 and ri.codigo_rz = $2 and p.codigo_ml = $3
        order by ri.created_at asc
        for update of ri
      `,
      [lot.id, codigoRz, codigoMl]
    );

    const sameRzItem = choosePgRzItemForDecrement(sameRzResult.rows);
    if (!sameRzItem) throw notFound("CÃ³digo ML nÃ£o encontrado neste RZ.");
    if (Number(sameRzItem.qtd_conferida) <= 0) throw new Error("Este CÃ³digo ML jÃ¡ estÃ¡ com quantidade conferida zerada.");

    const nextQtdConferida = Number(sameRzItem.qtd_conferida) - 1;
    const nextTipoItem =
      sameRzItem.tipo_item === "excedente_outro_rz" && nextQtdConferida <= Number(sameRzItem.qtd_esperada) ? "esperado" : sameRzItem.tipo_item;
    await client.query("update rz_items set qtd_conferida = $1, tipo_item = $2 where id = $3", [
      nextQtdConferida,
      nextTipoItem,
      sameRzItem.id
    ]);
    if (sameRzItem.product_origem === "excedente_externo") {
      await client.query("update products set qtd_total = greatest(qtd_total - 1, 0) where id = $1", [sameRzItem.product_id]);
    }

    scan = {
      id: randomUUID(),
      lotId: lot.id,
      codigoRz,
      codigoMl,
      status: "diminuido",
      createdAt: new Date().toISOString()
    };
    await client.query(
      `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [scan.id, scan.lotId, scan.codigoRz, scan.codigoMl, scan.status, null, scan.createdAt]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { scan, lot: await getUserLotDetail(userId, lotId) };
}

async function createExternalExcessPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let product;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1 for update", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nÃ£o encontrado.");

    const history = (await findPgProductHistory(client, userId, lot.id, codigoMl, 1))[0];

    const existing = await client.query("select id from products where lot_id = $1 and codigo_ml = $2 limit 1", [lot.id, codigoMl]);
    if (existing.rows.length) throw new Error("Este CÃ³digo ML jÃ¡ existe no lote atual.");

    const records = buildExternalExcessRecords(lot, history, codigoRz, codigoMl);
    product = records.product;
    await insertLotRows(client, { products: [records.product], rzItems: [records.item] });
    await client.query("update lots set proximo_sequencial_sku = proximo_sequencial_sku + 1 where id = $1", [lot.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { product, lot: await getUserLotDetail(userId, lotId) };
}

async function createManualExternalExcessPg({ userId, createdByUserId = userId, operatorUserId = null, lotId, codigoRz, codigoMl, manualProduct }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1 for update", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nao encontrado.");

    const existing = await client.query("select id from products where lot_id = $1 and codigo_ml = $2 limit 1", [lot.id, codigoMl]);
    if (existing.rows.length) throw new Error("Este Codigo ML ja existe no lote atual.");

    const source = normalizeManualProduct(manualProduct, codigoMl);
    const records = buildExternalExcessRecords(lot, source, codigoRz, codigoMl);
    await insertLotRows(client, { products: [records.product], rzItems: [records.item] });
    await mergePendingCatalogRequestPg(client, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product: records.product, type: "create", payload: source }));
    await client.query(
      `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), lot.id, codigoRz, codigoMl, "cadastro_manual", null, new Date().toISOString()]
    );
    await client.query("update lots set proximo_sequencial_sku = proximo_sequencial_sku + 1 where id = $1", [lot.id]);
    result = { status: "cadastro_manual", product: records.product };
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getUserLotDetail(userId, lotId) };
}

async function getExternalExcessProductPg({ userId, lotId, codigoRz, codigoMl }) {
  const result = await query(
    `
      select p.*
      from products p
      join lots l on l.id = p.lot_id
      join rz_items ri on ri.product_id = p.id
      where l.id = $1
        and l.user_id = $2
        and ri.codigo_rz = $3
        and p.codigo_ml = $4
        and p.origem = 'excedente_externo'
        and ri.tipo_item = 'excedente_externo'
      limit 1
    `,
    [lotId, userId, codigoRz, codigoMl]
  );
  if (!result.rows.length) throw notFound("Excedente externo nao encontrado nesta RZ.");
  return productFromRow(result.rows[0]);
}

async function deleteExternalExcessPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let product;
  try {
    await client.query("begin");
    const result = await client.query(
      `
        select p.*
        from products p
        join lots l on l.id = p.lot_id
        join rz_items ri on ri.product_id = p.id
        where l.id = $1
          and l.user_id = $2
          and ri.codigo_rz = $3
          and p.codigo_ml = $4
          and p.origem = 'excedente_externo'
          and ri.tipo_item = 'excedente_externo'
        limit 1
        for update of p
      `,
      [lotId, userId, codigoRz, codigoMl]
    );
    if (!result.rows.length) throw notFound("Excedente externo nao encontrado nesta RZ.");
    product = productFromRow(result.rows[0]);
    await client.query("delete from products where id = $1", [product.id]);
    await client.query(
      `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), lotId, codigoRz, codigoMl, "excedente_excluido", null, new Date().toISOString()]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { product, lot: await getUserLotDetail(userId, lotId) };
}

async function addDiverseLotItemPg({ userId, createdByUserId = userId, operatorUserId = null, lotId, codigoMl, codigoRz, manualProduct, valorUnitOverride, preview = false }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1 for update", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nÃƒÂ£o encontrado.");

    const existingResult = await client.query("select * from products where lot_id = $1 and codigo_ml = $2 limit 1 for update", [lot.id, codigoMl]);
    const existing = existingResult.rows[0] && productFromRow(existingResult.rows[0]);
    if (existing && preview) {
      await client.query("commit");
      return { status: "preview_existing", product: existing, lot: await getUserLotDetail(userId, lotId) };
    }
    if (existing) {
      const itemResult = await client.query("select * from rz_items where product_id = $1 and codigo_rz = $2 limit 1 for update", [existing.id, codigoRz]);
      const existingItem = itemResult.rows[0];
      if (existingItem) {
        await client.query(
          `
            update rz_items
            set qtd_esperada = qtd_esperada + 1,
                valor_total = valor_total + $2
            where id = $1
          `,
          [existingItem.id, existing.valorUnit]
        );
      } else {
        await insertLotRows(client, { rzItems: [buildDiverseRzItem(lot, existing, codigoRz)] });
      }
      await client.query("update products set qtd_total = qtd_total + 1 where id = $1", [existing.id]);
      result = { status: existingItem ? "duplicado_rz" : "mesmo_sku_novo_rz", product: { ...existing, qtdTotal: existing.qtdTotal + 1 } };
    } else {
      const approvedHistory = (await findPgProductHistory(client, userId, lot.id, codigoMl, 1))[0];
      const previousHistory = approvedHistory ? null : (await findPgPreviousProductHistory(client, userId, lot.id, codigoMl, 1))[0];
      const catalogProduct = approvedHistory || previousHistory ? null : await findPgCatalogProduct(client, codigoMl);
      const history = approvedHistory || previousHistory || catalogProduct;
      if (history && preview) {
        await client.query("commit");
        return { status: "preview", product: { ...history, codigoMl }, source: approvedHistory || previousHistory ? "historico" : "catalogo_oculto", lot: await getUserLotDetail(userId, lotId) };
      }
      if (!history && manualProduct) {
        const source = normalizeManualProduct(manualProduct, codigoMl);
        const records = buildDiverseLotRecords(lot, source, codigoMl, codigoRz, { origem: "lote_sem_planilha_manual" });
        await insertLotRows(client, { products: [records.product], rzItems: [records.item] });
        await mergePendingCatalogRequestPg(client, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product: records.product, type: "create", payload: source }));
        await client.query("update lots set proximo_sequencial_sku = proximo_sequencial_sku + 1 where id = $1", [lot.id]);
        result = { status: "cadastro_manual", product: records.product, parent: null };
        await client.query("commit");
        return { ...result, lot: await getUserLotDetail(userId, lotId) };
      }

      if (!history) {
        const error = new Error("Codigo ML nao encontrado no banco historico. Preencha o cadastro manual para seguir.");
        error.status = 404;
        error.code = "manual_required";
        throw error;
      }

      const records = buildDiverseLotRecords(lot, history, codigoMl, codigoRz, { valorUnitOverride });
      await insertLotRows(client, { products: [records.product], rzItems: [records.item] });
      await client.query("update lots set proximo_sequencial_sku = proximo_sequencial_sku + 1 where id = $1", [lot.id]);
      result = { status: "criado", product: records.product, parent: history };
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getUserLotDetail(userId, lotId) };
}

async function scanTransferLotPg({ userId, transferLotId, code }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote de transferencia nao encontrado.");
    if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");

    const product = await findPgTransferProduct(client, userId, code);
    if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
    const itemResult = await client.query("select * from transfer_items where transfer_lot_id = $1 and product_id = $2 limit 1 for update", [lot.id, product.id]);
    const existing = itemResult.rows[0] && transferItemFromRow(itemResult.rows[0]);
    if (existing) {
      await client.query("update transfer_items set quantidade = quantidade + 1 where id = $1", [existing.id]);
      result = { status: "updated", product };
    } else {
      await insertTransferItemRows(client, [buildTransferItem(lot.id, product)]);
      result = { status: "added", product };
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getTransferLotDetail(userId, transferLotId) };
}

async function decrementTransferLotItemPg({ userId, transferLotId, itemId }) {
  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote de transferencia nao encontrado.");
    if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");
    const item = await client.query("select * from transfer_items where id = $1 and transfer_lot_id = $2 limit 1 for update", [itemId, lot.id]);
    if (!item.rows.length) throw notFound("Item nao encontrado no lote.");
    if (Number(item.rows[0].quantidade || 0) <= 1) await client.query("delete from transfer_items where id = $1", [itemId]);
    else await client.query("update transfer_items set quantidade = quantidade - 1 where id = $1", [itemId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { lot: await getTransferLotDetail(userId, transferLotId) };
}

async function findPgProductHistory(client, userId, currentLotId, codigoMl, limit) {
  const result = await client.query(
    `
      select
        p.*,
        l.id as lot__id,
        l.user_id as lot__user_id,
        l.nome_arquivo as lot__nome_arquivo,
        l.percentual_arremate as lot__percentual_arremate,
        l.custo_medio_unitario as lot__custo_medio_unitario,
        l.fornecedor as lot__fornecedor,
        l.prefixo_sku as lot__prefixo_sku,
        l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
        l.created_at as lot__created_at,
        cp.codigo_ml as catalog__codigo_ml,
        cp.descricao as catalog__descricao,
        cp.valor_unit as catalog__valor_unit,
        cp.preco_custo as catalog__preco_custo,
        cp.categoria as catalog__categoria,
        cp.subcategoria as catalog__subcategoria,
        cp.ean as catalog__ean,
        cp.link as catalog__link,
        cp.foto as catalog__foto
      from products p
      join lots l on l.id = p.lot_id
      left join catalog_products cp on upper(trim(cp.codigo_ml)) = upper(trim(p.codigo_ml))
      where l.id <> $1
        and l.user_id = $4
        and upper(trim(p.codigo_ml)) = upper(trim($2))
        and cp.id is not null
      order by p.created_at desc
      limit $3
    `,
    [currentLotId, codigoMl, limit, userId]
  );

  return result.rows.map((row) => {
    const product = productFromRow(row);
    return {
      ...product,
      codigoMl: row.catalog__codigo_ml,
      descricao: row.catalog__descricao,
      valorUnit: num(row.catalog__valor_unit),
      precoCusto: num(row.catalog__preco_custo),
      categoria: row.catalog__categoria || "",
      subcategoria: row.catalog__subcategoria || "",
      ean: row.catalog__ean || "",
      link: row.catalog__link || "",
      foto: row.catalog__foto || "",
      lot: lotFromPrefixedRow(row, "lot__")
    };
  });
}

async function findPgTransferProduct(client, userId, code) {
  const result = await client.query(
    `
      select
        p.*,
        l.id as lot__id,
        l.nome_arquivo as lot__nome_arquivo
      from products p
      join lots l on l.id = p.lot_id
      where l.user_id = $1
        and (upper(trim(p.codigo_ml)) = upper(trim($2)) or upper(trim(p.sku)) = upper(trim($2)))
      order by p.created_at desc
      limit 1
    `,
    [userId, code]
  );
  if (!result.rows.length) return null;
  const product = productFromRow(result.rows[0]);
  return {
    ...product,
    sourceLotId: product.lotId,
    sourceLotName: result.rows[0].lot__nome_arquivo || ""
  };
}

async function findPgPreviousProductHistory(client, userId, currentLotId, codigoMl, limit) {
  const result = await client.query(
    `
      select
        p.*,
        l.id as lot__id,
        l.user_id as lot__user_id,
        l.nome_arquivo as lot__nome_arquivo,
        l.percentual_arremate as lot__percentual_arremate,
        l.custo_medio_unitario as lot__custo_medio_unitario,
        l.fornecedor as lot__fornecedor,
        l.prefixo_sku as lot__prefixo_sku,
        l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
        l.created_at as lot__created_at
      from products p
      join lots l on l.id = p.lot_id
      where l.id <> $1
        and l.user_id = $4
        and upper(trim(p.codigo_ml)) = upper(trim($2))
      order by p.created_at desc
      limit $3
    `,
    [currentLotId, codigoMl, limit, userId]
  );

  return result.rows.map((row) => ({
    ...productFromRow(row),
    lot: lotFromPrefixedRow(row, "lot__")
  }));
}

function findCatalogProduct(db, codigoMl) {
  const normalized = String(codigoMl || "").trim().toUpperCase();
  return (db.catalogProducts || []).find((product) => String(product.codigoMl || "").trim().toUpperCase() === normalized) || null;
}

async function findPgCatalogProduct(client, codigoMl) {
  const result = await client.query("select * from catalog_products where upper(trim(codigo_ml)) = upper(trim($1)) limit 1", [codigoMl]);
  return result.rows[0] ? catalogProductFromRow(result.rows[0]) : null;
}

async function suggestCatalogUpdatePg({ userId, createdByUserId = userId, operatorUserId = null, lotId, productId, payload }) {
  const client = await getPgPool().connect();
  try {
    const productResult = await client.query(
      `
        select p.*, l.id as lot_id, l.user_id
        from products p
        join lots l on l.id = p.lot_id
        where p.id = $1 and l.id = $2 and l.user_id = $3
        limit 1
      `,
      [productId, lotId, userId]
    );
    const row = productResult.rows[0];
    if (!row) throw notFound("Produto nao encontrado.");
    const product = productFromRow(row);
    const lot = { id: lotId };
    const normalized = normalizeManualProduct({ ...product, ...payload }, product.codigoMl);
    await mergePendingCatalogRequestPg(client, buildCatalogRequest({ userId, createdByUserId, operatorUserId, lot, product, type: "update", payload: normalized }));
    return { ok: true };
  } finally {
    client.release();
  }
}

async function reviewCatalogRequestPg(requestId, action, options = {}) {
  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    const result = await client.query("select * from catalog_requests where id = $1 limit 1 for update", [requestId]);
    const request = result.rows[0] && catalogRequestFromRow(result.rows[0]);
    if (!request) throw notFound("Sugestao nao encontrada.");
    if (request.status !== "pending") throw new Error("Esta sugestao ja foi analisada.");

    if (action === "approve") {
      const selected = selectCatalogApprovalPayload(request, options.selectedCheckId);
      await client.query(
        `
          insert into catalog_products (id, codigo_ml, descricao, valor_unit, preco_custo, categoria, subcategoria, ean, link, foto, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
          on conflict (codigo_ml) do update set
            descricao = excluded.descricao,
            valor_unit = excluded.valor_unit,
            preco_custo = excluded.preco_custo,
            categoria = excluded.categoria,
            subcategoria = excluded.subcategoria,
            ean = excluded.ean,
            link = excluded.link,
            foto = excluded.foto,
            updated_at = now()
        `,
        [randomUUID(), selected.codigoMl, selected.descricao, selected.valorUnit, selected.precoCusto || 0, selected.categoria || "", selected.subcategoria || "", selected.ean || "", selected.link || "", selected.foto || ""]
      );
      await client.query("update catalog_requests set status = 'approved', reviewed_at = now() where id = $1", [requestId]);
    } else if (action === "reject") {
      await insertCatalogRejectedRequestRows(client, [buildRejectedCatalogRequest(request, new Date().toISOString())]);
      await client.query("delete from catalog_requests where id = $1", [requestId]);
    } else {
      throw new Error("Acao invalida.");
    }

    await client.query("commit");
    return { ok: true };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function buildExternalExcessRecords(lot, history, codigoRz, codigoMl, options = {}) {
  const valorUnit = roundMoney(history.valorUnit);
  const sku = formatSku(lot.prefixoSku, lot.proximoSequencialSku);
  const product = {
    id: randomUUID(),
    lotId: lot.id,
    codigoMl,
    sku,
    descricao: history.descricao,
    valorUnit,
    precoCusto: roundMoney(history.precoCusto || valorUnit * (lot.percentualArremate / 100)),
    qtdTotal: 1,
    categoria: history.categoria || "",
    subcategoria: history.subcategoria || "",
    ean: history.ean || "",
    link: history.link || "",
    foto: history.foto || "",
    origem: options.origem || "excedente_externo",
    createdAt: new Date().toISOString()
  };
  const item = {
    id: randomUUID(),
    lotId: lot.id,
    productId: product.id,
    codigoRz,
    enderecoWms: "",
    qtdEsperada: 0,
    qtdConferida: 1,
    condicaoGrade: "",
    valorTotal: valorUnit,
    tipoItem: "excedente_externo",
    createdAt: new Date().toISOString()
  };
  return { product, item };
}

function buildDiverseLotRecords(lot, history, codigoMl, codigoRz, options = {}) {
  const valorUnit = roundMoney(options.valorUnitOverride === undefined || options.valorUnitOverride === "" ? history.valorUnit : Number(options.valorUnitOverride));
  const product = {
    id: randomUUID(),
    lotId: lot.id,
    codigoMl,
    sku: formatSku(lot.prefixoSku, lot.proximoSequencialSku),
    descricao: history.descricao,
    valorUnit,
    precoCusto: roundMoney(Number(lot.custoMedioUnitario || history.precoCusto || 0)),
    qtdTotal: 1,
    categoria: history.categoria || "",
    subcategoria: history.subcategoria || "",
    ean: history.ean || "",
    link: history.link || "",
    foto: history.foto || "",
    origem: options.origem || "lote_sem_planilha",
    createdAt: new Date().toISOString()
  };
  const item = buildDiverseRzItem(lot, product, codigoRz);
  return { product, item };
}

function buildDiverseRzItem(lot, product, codigoRz) {
  return {
    id: randomUUID(),
    lotId: lot.id,
    productId: product.id,
    codigoRz,
    enderecoWms: "",
    qtdEsperada: 1,
    qtdConferida: 0,
    condicaoGrade: "",
    valorTotal: product.valorUnit,
    tipoItem: "lote_sem_planilha",
    createdAt: new Date().toISOString()
  };
}

function normalizeManualProduct(input = {}, codigoMl) {
  const descricao = String(input.descricao || input.nome || "").trim();
  const valorUnit = roundMoney(Number(input.valorUnit ?? input.preco ?? 0));
  const foto = input.foto ?? input.photo ?? input.image ?? input.imagem ?? input.urlFoto ?? input.urlImagem ?? input.imageUrl ?? "";
  if (!descricao) throw new Error("Informe o nome/descricao do produto.");
  if (!Number.isFinite(valorUnit) || valorUnit <= 0) throw new Error("Informe o preco de venda do produto.");
  return {
    codigoMl: normalizeCode(codigoMl),
    descricao,
    valorUnit,
    precoCusto: roundMoney(Number(input.precoCusto || 0)),
    categoria: String(input.categoria || "").trim(),
    subcategoria: String(input.subcategoria || "").trim(),
    ean: String(input.ean || "").trim(),
    link: String(input.link || "").trim(),
    foto: String(foto || "").trim()
  };
}

function buildCatalogRequest({ userId, createdByUserId = userId, operatorUserId = null, lot, product, type, payload }) {
  const codigoMl = normalizeCode(payload.codigoMl || product.codigoMl);
  return {
    id: randomUUID(),
    userId,
    createdByUserId: createdByUserId || userId,
    operatorUserId: operatorUserId || null,
    lotId: lot.id,
    productId: product.id,
    type,
    status: "pending",
    codigoMl,
    descricao: payload.descricao || product.descricao,
    valorUnit: roundMoney(payload.valorUnit ?? product.valorUnit),
    precoCusto: roundMoney(payload.precoCusto ?? product.precoCusto),
    categoria: payload.categoria || product.categoria || "",
    subcategoria: payload.subcategoria || product.subcategoria || "",
    ean: payload.ean || product.ean || "",
    link: payload.link || product.link || "",
    foto: payload.foto || product.foto || "",
    createdAt: new Date().toISOString(),
    reviewedAt: null
  };
}

export function mergePendingCatalogRequest(requests, request) {
  const target = findMergeableCatalogRequest(requests, request);
  if (!target) {
    request.doubleChecks = normalizeDoubleChecks(request.doubleChecks);
    requests.push(request);
    return request;
  }

  if (catalogRequestHasUserCheck(target, catalogRequestActorId(request))) return target;

  target.doubleChecks = [...normalizeDoubleChecks(target.doubleChecks), buildCatalogDoubleCheck(request)];
  return target;
}

async function mergePendingCatalogRequestPg(client, request) {
  const mergeable = request.type === "create"
    ? await client.query(
        `
          select id, user_id, created_by_user_id, operator_user_id, double_checks
          from catalog_requests
          where status = 'pending'
            and type = 'create'
            and upper(trim(codigo_ml)) = upper(trim($1))
          order by created_at asc
          limit 1
          for update
        `,
        [request.codigoMl]
      )
    : { rows: [] };

  if (!mergeable.rows.length) {
    request.doubleChecks = normalizeDoubleChecks(request.doubleChecks);
    await insertCatalogRequestRows(client, [request]);
    return request;
  }

  if (catalogRequestHasUserCheck(catalogRequestFromRow(mergeable.rows[0]), catalogRequestActorId(request))) {
    return { ...request, id: mergeable.rows[0].id };
  }

  const check = buildCatalogDoubleCheck(request);
  await client.query(
    `
      update catalog_requests
      set double_checks = coalesce(double_checks, '[]'::jsonb) || $2::jsonb
      where id = $1
    `,
    [mergeable.rows[0].id, JSON.stringify([check])]
  );
  return { ...request, id: mergeable.rows[0].id };
}

function findMergeableCatalogRequest(requests, request) {
  if (request.type !== "create") return null;
  const normalizedCode = normalizeCode(request.codigoMl);
  return (requests || []).find((candidate) => {
    return candidate.status === "pending" && candidate.type === "create" && normalizeCode(candidate.codigoMl) === normalizedCode;
  }) || null;
}

function buildCatalogDoubleCheck(request) {
  return {
    id: randomUUID(),
    userId: request.userId,
    createdByUserId: request.createdByUserId || request.userId,
    operatorUserId: request.operatorUserId || null,
    lotId: request.lotId || null,
    productId: request.productId || null,
    type: request.type,
    codigoMl: normalizeCode(request.codigoMl),
    descricao: request.descricao,
    valorUnit: roundMoney(request.valorUnit || 0),
    precoCusto: roundMoney(request.precoCusto || 0),
    categoria: request.categoria || "",
    subcategoria: request.subcategoria || "",
    ean: request.ean || "",
    link: request.link || "",
    foto: request.foto || "",
    createdAt: request.createdAt || new Date().toISOString()
  };
}

function catalogRequestHasUserCheck(request, userId) {
  if (!userId) return false;
  return catalogRequestActorId(request) === userId || normalizeDoubleChecks(request.doubleChecks).some((check) => catalogRequestActorId(check) === userId);
}

function catalogRequestActorId(request) {
  return request?.createdByUserId || request?.userId || null;
}

export function buildRejectedCatalogRequest(request, rejectedAt) {
  return {
    id: randomUUID(),
    originalRequestId: request.originalRequestId || request.id,
    userId: request.userId,
    createdByUserId: request.createdByUserId || request.userId,
    operatorUserId: request.operatorUserId || null,
    lotId: request.lotId || null,
    productId: request.productId || null,
    type: request.type,
    status: "rejected",
    codigoMl: normalizeCode(request.codigoMl),
    descricao: request.descricao,
    valorUnit: roundMoney(request.valorUnit || 0),
    precoCusto: roundMoney(request.precoCusto || 0),
    categoria: request.categoria || "",
    subcategoria: request.subcategoria || "",
    ean: request.ean || "",
    link: request.link || "",
    foto: request.foto || "",
    doubleChecks: normalizeDoubleChecks(request.doubleChecks),
    createdAt: request.createdAt || rejectedAt,
    rejectedAt
  };
}

function normalizeDoubleChecks(checks) {
  return Array.isArray(checks) ? checks : [];
}

function enrichCatalogRequestDoubleChecks(request, usersById) {
  return {
    ...request,
    user: request.user || usersById.get(request.userId) || null,
    createdByUser: usersById.get(request.createdByUserId || request.userId) || null,
    operatorUser: request.operatorUserId ? usersById.get(request.operatorUserId) || null : null,
    doubleChecks: normalizeDoubleChecks(request.doubleChecks).map((check) => ({
      ...check,
      user: usersById.get(check.userId) || null,
      createdByUser: usersById.get(check.createdByUserId || check.userId) || null,
      operatorUser: check.operatorUserId ? usersById.get(check.operatorUserId) || null : null
    }))
  };
}

export function selectCatalogApprovalPayload(request, selectedCheckId) {
  if (!selectedCheckId || selectedCheckId === "base") return request;
  const selected = normalizeDoubleChecks(request.doubleChecks).find((check) => check.id === selectedCheckId);
  if (!selected) throw new Error("Cadastro selecionado para aprovacao nao encontrado.");
  return {
    ...request,
    ...selected,
    id: request.id,
    userId: request.userId,
    lotId: request.lotId,
    productId: request.productId,
    status: request.status,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    doubleChecks: request.doubleChecks
  };
}

function upsertCatalogProduct(db, request) {
  const now = new Date().toISOString();
  const codigoMl = normalizeCode(request.codigoMl);
  const existing = (db.catalogProducts || []).find((product) => normalizeCode(product.codigoMl) === codigoMl);
  const record = {
    id: existing?.id || randomUUID(),
    codigoMl,
    descricao: request.descricao,
    valorUnit: Number(request.valorUnit || 0),
    precoCusto: Number(request.precoCusto || 0),
    categoria: request.categoria || "",
    subcategoria: request.subcategoria || "",
    ean: request.ean || "",
    link: request.link || "",
    foto: request.foto || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (existing) Object.assign(existing, record);
  else db.catalogProducts.push(record);
}

function getUserLotFromDb(db, userId, lotId) {
  return db.lots.find((lot) => lot.id === lotId && lot.userId === userId);
}

function summarizeTransferLots(lots, items) {
  return lots.map((lot) => summarizeTransferLot(lot, items));
}

function summarizeTransferLot(lot, items) {
  const lotItems = (items || []).filter((item) => item.transferLotId === lot.id);
  return {
    ...lot,
    totalSkus: lotItems.length,
    totalQty: lotItems.reduce((sum, item) => sum + Number(item.quantidade || 0), 0),
    items: lotItems.sort((a, b) => a.sku.localeCompare(b.sku))
  };
}

function findTransferProduct(db, userId, code) {
  const lotIds = new Set((db.lots || []).filter((lot) => lot.userId === userId).map((lot) => lot.id));
  const normalized = normalizeCode(code);
  const product = (db.products || [])
    .filter((candidate) => lotIds.has(candidate.lotId))
    .filter((candidate) => normalizeCode(candidate.codigoMl) === normalized || normalizeCode(candidate.sku) === normalized)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!product) return null;
  const sourceLot = (db.lots || []).find((lot) => lot.id === product.lotId);
  return { ...product, sourceLotId: product.lotId, sourceLotName: sourceLot?.nomeArquivo || "" };
}

function buildTransferItem(transferLotId, product) {
  return {
    id: randomUUID(),
    transferLotId,
    sourceLotId: product.sourceLotId || product.lotId || null,
    productId: product.id,
    codigoMl: product.codigoMl || "",
    sku: product.sku || "",
    descricao: product.descricao || "",
    ean: product.ean || "",
    quantidade: 1,
    createdAt: new Date().toISOString()
  };
}

function blingOriginsForKind(kind) {
  if (kind === "complete") return ["planilha", ...NO_SHEET_ORIGINS, "lote_sem_planilha_manual"];
  if (kind === "excess") return EXCESS_EXPORT_ORIGINS;
  throw new Error("Tipo de exportaÃ§Ã£o invÃ¡lido.");
}

function normalizeCatalogProducts(products, now) {
  const byCode = new Map();
  for (const input of products || []) {
    const codigoMl = normalizeCode(input.codigoMl);
    const descricao = String(input.descricao || "").trim();
    if (!codigoMl || !descricao) continue;
    byCode.set(codigoMl, {
      id: input.id || randomUUID(),
      codigoMl,
      descricao,
      valorUnit: Number(input.valorUnit || 0),
      precoCusto: Number(input.precoCusto || 0),
      categoria: String(input.categoria || "").trim(),
      subcategoria: String(input.subcategoria || "").trim(),
      ean: String(input.ean || "").trim(),
      link: String(input.link || "").trim(),
      foto: String(input.foto || "").trim(),
      createdAt: input.createdAt || now,
      updatedAt: now
    });
  }
  return [...byCode.values()].sort((a, b) => a.codigoMl.localeCompare(b.codigoMl));
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

async function query(sql, params) {
  return getPgPool().query(sql, params);
}

function userFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id || row.id,
    tenantName: row.tenant_name || row.name,
    parentUserId: row.parent_user_id || null,
    role: row.role || (row.parent_user_id ? "operator" : "owner"),
    operatorCode: row.operator_code ? Number(row.operator_code) : null,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: iso(row.created_at)
  };
}

function lotFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    nomeArquivo: row.nome_arquivo,
    percentualArremate: num(row.percentual_arremate),
    custoMedioUnitario: num(row.custo_medio_unitario),
    fornecedor: row.fornecedor,
    prefixoSku: row.prefixo_sku,
    proximoSequencialSku: Number(row.proximo_sequencial_sku),
    createdAt: iso(row.created_at)
  };
}

function lotFromPrefixedRow(row, prefix) {
  return {
    id: row[`${prefix}id`],
    userId: row[`${prefix}user_id`],
    nomeArquivo: row[`${prefix}nome_arquivo`],
    percentualArremate: num(row[`${prefix}percentual_arremate`]),
    custoMedioUnitario: num(row[`${prefix}custo_medio_unitario`]),
    fornecedor: row[`${prefix}fornecedor`],
    prefixoSku: row[`${prefix}prefixo_sku`],
    proximoSequencialSku: Number(row[`${prefix}proximo_sequencial_sku`]),
    createdAt: iso(row[`${prefix}created_at`])
  };
}

function productFromRow(row) {
  return {
    id: row.id,
    lotId: row.lot_id,
    codigoMl: row.codigo_ml,
    sku: row.sku,
    descricao: row.descricao,
    valorUnit: num(row.valor_unit),
    precoCusto: num(row.preco_custo),
    qtdTotal: Number(row.qtd_total),
    categoria: row.categoria || "",
    subcategoria: row.subcategoria || "",
    ean: row.ean || "",
    link: row.link || "",
    foto: row.foto || "",
    origem: row.origem || "planilha",
    createdAt: iso(row.created_at)
  };
}

function catalogProductFromRow(row) {
  return {
    id: row.id,
    codigoMl: row.codigo_ml,
    descricao: row.descricao,
    valorUnit: num(row.valor_unit),
    precoCusto: num(row.preco_custo),
    categoria: row.categoria || "",
    subcategoria: row.subcategoria || "",
    ean: row.ean || "",
    link: row.link || "",
    foto: row.foto || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at || row.created_at)
  };
}

function catalogRequestFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id || row.user_id,
    operatorUserId: row.operator_user_id || null,
    lotId: row.lot_id,
    productId: row.product_id,
    type: row.type,
    status: row.status,
    codigoMl: row.codigo_ml,
    descricao: row.descricao,
    valorUnit: num(row.valor_unit),
    precoCusto: num(row.preco_custo),
    categoria: row.categoria || "",
    subcategoria: row.subcategoria || "",
    ean: row.ean || "",
    link: row.link || "",
    foto: row.foto || "",
    doubleChecks: parseJsonArray(row.double_checks),
    createdAt: iso(row.created_at),
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    user: row.user_name || row.user_email ? { name: row.user_name || "", email: row.user_email || "" } : null
  };
}

function catalogRejectedRequestFromRow(row) {
  return {
    id: row.id,
    originalRequestId: row.original_request_id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id || row.user_id,
    operatorUserId: row.operator_user_id || null,
    lotId: row.lot_id,
    productId: row.product_id,
    type: row.type,
    status: row.status,
    codigoMl: row.codigo_ml,
    descricao: row.descricao,
    valorUnit: num(row.valor_unit),
    precoCusto: num(row.preco_custo),
    categoria: row.categoria || "",
    subcategoria: row.subcategoria || "",
    ean: row.ean || "",
    link: row.link || "",
    foto: row.foto || "",
    doubleChecks: parseJsonArray(row.double_checks),
    createdAt: iso(row.created_at),
    rejectedAt: iso(row.rejected_at)
  };
}

function rzItemFromRow(row) {
  return {
    id: row.id,
    lotId: row.lot_id,
    productId: row.product_id,
    codigoRz: row.codigo_rz,
    enderecoWms: row.endereco_wms || "",
    qtdEsperada: Number(row.qtd_esperada),
    qtdConferida: Number(row.qtd_conferida),
    condicaoGrade: row.condicao_grade || "",
    valorTotal: num(row.valor_total),
    tipoItem: row.tipo_item || "esperado",
    createdAt: iso(row.created_at)
  };
}

function chooseRzItemForScan(items) {
  return items.find((item) => item.qtdConferida < item.qtdEsperada) || items[0] || null;
}

function chooseRzItemForDecrement(items) {
  return (
    items.find((item) => item.qtdConferida > item.qtdEsperada) ||
    [...items].reverse().find((item) => item.qtdConferida > 0) ||
    items[0] ||
    null
  );
}

function choosePgRzItemForScan(rows) {
  return rows.find((row) => Number(row.qtd_conferida) < Number(row.qtd_esperada)) || rows[0] || null;
}

function choosePgRzItemForDecrement(rows) {
  return (
    rows.find((row) => Number(row.qtd_conferida) > Number(row.qtd_esperada)) ||
    [...rows].reverse().find((row) => Number(row.qtd_conferida) > 0) ||
    rows[0] ||
    null
  );
}

function scanFromRow(row) {
  return {
    id: row.id,
    lotId: row.lot_id,
    codigoRz: row.codigo_rz,
    codigoMl: row.codigo_ml,
    status: row.status,
    history: row.history || undefined,
    createdAt: iso(row.created_at)
  };
}

function labelFromRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    lotId: row.lot_id,
    userId: row.user_id,
    createdAt: iso(row.created_at)
  };
}

function blingIntegrationFromRow(row) {
  return {
    userId: row.user_id,
    clientId: row.client_id || "",
    clientSecret: row.client_secret || "",
    accessToken: row.access_token || "",
    refreshToken: row.refresh_token || "",
    tokenExpiresAt: row.token_expires_at ? iso(row.token_expires_at) : null,
    updatedAt: iso(row.updated_at)
  };
}

function transferLotFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    depositoOrigem: row.deposito_origem,
    depositoDestino: row.deposito_destino,
    status: row.status || "open",
    createdByUserId: row.created_by_user_id || null,
    createdAt: iso(row.created_at),
    syncedAt: row.synced_at ? iso(row.synced_at) : null
  };
}

function transferItemFromRow(row) {
  return {
    id: row.id,
    transferLotId: row.transfer_lot_id,
    sourceLotId: row.source_lot_id || null,
    productId: row.product_id || null,
    codigoMl: row.codigo_ml,
    sku: row.sku,
    descricao: row.descricao,
    ean: row.ean || "",
    quantidade: Number(row.quantidade || 0),
    createdAt: iso(row.created_at)
  };
}

function operatorActivityFromRow(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    operatorUserId: row.operator_user_id,
    action: row.action,
    metadata: parseJsonObject(row.metadata),
    createdAt: iso(row.created_at)
  };
}

function operatorStatsFromRow(row) {
  return {
    total: Number(row.activity_total || 0),
    logins: Number(row.login_total || 0),
    searches: Number(row.search_total || 0),
    scans: Number(row.scan_total || 0),
    creates: Number(row.create_total || 0),
    lotViews: Number(row.lot_view_total || 0),
    palletViews: Number(row.pallet_view_total || 0),
    lastActivityAt: row.last_activity_at ? iso(row.last_activity_at) : null
  };
}

function summarizeOperatorActivities(activities, operatorUserId) {
  const stats = { total: 0, logins: 0, searches: 0, scans: 0, creates: 0, lotViews: 0, palletViews: 0, lastActivityAt: null };
  for (const activity of activities || []) {
    if (activity.operatorUserId !== operatorUserId) continue;
    stats.total += 1;
    if (activity.action === "login") stats.logins += 1;
    if (activity.action === "search_ml") stats.searches += 1;
    if (activity.action === "scan_ml" || activity.action === "scan_transfer") stats.scans += 1;
    if (activity.action === "create_manual_product" || activity.action === "create_external_excess") stats.creates += 1;
    if (activity.action === "view_lot") stats.lotViews += 1;
    if (activity.action === "view_pallet") stats.palletViews += 1;
    if (!stats.lastActivityAt || activity.createdAt > stats.lastActivityAt) stats.lastActivityAt = activity.createdAt;
  }
  return stats;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value) {
  return Number(value || 0);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeDbTenants(db) {
  let changed = false;
  for (const user of db.users || []) {
    if (!user.tenantId) {
      user.tenantId = user.id;
      changed = true;
    }
    if (!user.tenantName) {
      user.tenantName = user.name;
      changed = true;
    }
    if (user.parentUserId === undefined) {
      user.parentUserId = null;
      changed = true;
    }
    if (!user.role) {
      user.role = user.parentUserId ? "operator" : "owner";
      changed = true;
    }
  }
  const operatorsByOwner = new Map();
  for (const user of db.users || []) {
    if (!user.parentUserId) continue;
    const operators = operatorsByOwner.get(user.parentUserId) || [];
    operators.push(user);
    operatorsByOwner.set(user.parentUserId, operators);
  }

  for (const operators of operatorsByOwner.values()) {
    operators.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)));
    const usedCodes = new Set(operators.map((user) => Number(user.operatorCode || 0)).filter(Boolean));
    let nextCode = 1001;
    for (const user of operators) {
      if (user.operatorCode) continue;
      while (usedCodes.has(nextCode)) nextCode += 1;
      user.operatorCode = nextCode;
      usedCodes.add(nextCode);
      changed = true;
    }
  }
  return changed;
}

async function getPrivateUserBlingIntegration(userId) {
  if (hasPostgres()) {
    const result = await query("select * from bling_integrations where user_id = $1 limit 1", [userId]);
    return result.rows[0] ? blingIntegrationFromRow(result.rows[0]) : null;
  }

  const db = await readDb();
  return (db.blingIntegrations || []).find((integration) => integration.userId === userId) || null;
}

function normalizeBlingIntegration(userId, input = {}, existing = null) {
  const clientId = String(input.clientId ?? existing?.clientId ?? "").trim();
  const clientSecret = String(input.clientSecret || existing?.clientSecret || "").trim();
  const accessToken = String(input.accessToken || existing?.accessToken || "").trim();
  const refreshToken = String(input.refreshToken || existing?.refreshToken || "").trim();
  const tokenExpiresAt = normalizeOptionalIso(input.tokenExpiresAt ?? existing?.tokenExpiresAt ?? null);

  if (!clientId) throw new Error("Informe o Client ID do Bling.");

  return {
    userId,
    clientId,
    clientSecret,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    updatedAt: new Date().toISOString()
  };
}

function normalizeBlingAppConfig(input = {}) {
  return {
    clientId: String(input.clientId || "").trim(),
    clientSecret: String(input.clientSecret || "").trim()
  };
}

function publicBlingAppConfig(appConfig) {
  return {
    configured: Boolean(appConfig?.clientId && appConfig?.clientSecret),
    clientId: appConfig?.clientId || "",
    hasClientSecret: Boolean(appConfig?.clientSecret)
  };
}

function publicBlingIntegration(integration) {
  if (!integration) {
    return {
      connected: false,
      clientId: "",
      hasClientSecret: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      tokenExpiresAt: null,
      updatedAt: null
    };
  }

  return {
    connected: Boolean(integration.accessToken && integration.refreshToken),
    clientId: integration.clientId,
    hasClientSecret: Boolean(integration.clientSecret),
    hasAccessToken: Boolean(integration.accessToken),
    hasRefreshToken: Boolean(integration.refreshToken),
    tokenExpiresAt: integration.tokenExpiresAt || null,
    updatedAt: integration.updatedAt
  };
}

function normalizeOptionalIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Data de expiracao do token invalida.");
  return date.toISOString();
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
