import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { formatSku, parseNumber, roundMoney } from "./domain.js";
import { findApprovedProductHistory, findProductHistory, getBlingProducts, summarizeLot } from "./lots.js";
import { insertRows } from "./pg-bulk.js";

const { Pool } = pg;

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "db.json");

let pool;
let storeReady;

const NO_SHEET_ORIGINS = ["lote_sem_planilha", "entrada_diversos"];
const EXCESS_EXPORT_ORIGINS = ["excedente_externo", "lote_sem_planilha_manual"];
const CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY = "catalog_lot_suggestions_backfilled";
const CONFERENCE_SETTINGS_KEY = "conference_registration";
const STANDARD_ML_CODE_PATTERN = /^[A-Z]{4}[0-9]{5}$/;
const OPERATOR_DASHBOARD_ACTIONS = [
  "login",
  "search_ml",
  "scan_ml",
  "scan_transfer",
  "create_manual_product",
  "create_external_excess",
  "view_lot",
  "view_pallet",
  "report_transfer_divergence"
];

const emptyDb = () => ({
  users: [],
  lots: [],
  products: [],
  rzItems: [],
  scans: [],
  labels: [],
  blingIntegrations: [],
  appSettings: {},
  userSettings: [],
  transferLots: [],
  transferItems: [],
  transferForcedOccurrences: [],
  transferDivergenceReports: [],
  operatorActivities: [],
  operatorInvites: [],
  catalogProducts: [],
  catalogRequests: [],
  catalogRejectedRequests: [],
  noSheetSuggestions: [],
  triageItems: [],
  triageEvents: []
});

const CONFERENCE_FIELD_DEFAULTS = Object.freeze({
  ean: { enabled: true, required: false },
  link: { enabled: true, required: false },
  photo: { enabled: true, required: false },
  boxDimensions: { enabled: false, required: false },
  weight: { enabled: false, required: false },
  stockLocation: { enabled: false, required: false, printOnLabel: false },
  category: { enabled: false, required: false },
  subcategory: { enabled: false, required: false }
});

export function hasPostgres() {
  return Boolean(process.env.DATABASE_URL);
}

export function isStandardMlCode(codigoMl) {
  return STANDARD_ML_CODE_PATTERN.test(normalizeCode(codigoMl));
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
  if (rejectedInQueue.length) {
    const archivedOriginalIds = new Set((db.catalogRejectedRequests || []).map((request) => request.originalRequestId));
    const archived = rejectedInQueue
      .filter((request) => !archivedOriginalIds.has(request.id))
      .map((request) => buildRejectedCatalogRequest(request, request.reviewedAt || new Date().toISOString()));
    db.catalogRejectedRequests = [...(db.catalogRejectedRequests || []), ...archived];
    db.catalogRequests = (db.catalogRequests || []).filter((request) => request.status !== "rejected");
    changed = true;
  }

  if (backfillJsonCatalogLotSuggestions(db)) changed = true;
  if (changed) await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

function backfillJsonCatalogLotSuggestions(db) {
  db.appSettings = db.appSettings || {};
  if (db.appSettings[CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY]) return false;

  const lotsById = new Map((db.lots || []).map((lot) => [lot.id, lot]));
  for (const product of db.products || []) {
    if ((product.origem || "planilha") !== "planilha") continue;
    if (!isStandardMlCode(product.codigoMl)) continue;
    const lot = lotsById.get(product.lotId);
    if (!lot?.userId) continue;
    mergePendingCatalogRequest(db.catalogRequests, buildLotCatalogRequest(db, { userId: lot.userId, lot, product }));
  }

  db.appSettings[CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY] = new Date().toISOString();
  return true;
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
    triageAccess: false,
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    try {
      await query(
        `insert into users (id, tenant_id, tenant_name, parent_user_id, role, operator_code, triage_access, name, email, password_hash, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [user.id, user.tenantId, user.tenantName, user.parentUserId, user.role, user.operatorCode, user.triageAccess, user.name, user.email, user.passwordHash, user.createdAt]
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

export async function createOperatorInvite({ ownerUserId, tokenHash, expiresAt }) {
  await ensureStore();
  const owner = await getUserById(ownerUserId);
  if (!owner || owner.parentUserId) throw new Error("Usuario principal nao encontrado.");
  const invite = {
    id: randomUUID(),
    ownerUserId,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    await query("delete from operator_invites where owner_user_id = $1 or expires_at <= now()", [ownerUserId]);
    await query(
      `insert into operator_invites (id, owner_user_id, token_hash, expires_at, created_at)
       values ($1, $2, $3, $4, $5)`,
      [invite.id, invite.ownerUserId, invite.tokenHash, invite.expiresAt, invite.createdAt]
    );
    return publicOperatorInvite(invite, owner);
  }

  const db = await readDb();
  const now = new Date();
  db.operatorInvites = (db.operatorInvites || []).filter((item) => item.ownerUserId !== ownerUserId && new Date(item.expiresAt) > now);
  db.operatorInvites.push(invite);
  await writeDb(db);
  return publicOperatorInvite(invite, owner);
}

export async function getOperatorInvite(tokenHash) {
  await ensureStore();
  const invite = await getOperatorInviteByTokenHash(tokenHash);
  if (!invite) throw notFound("Link de cadastro invalido ou expirado.");
  const owner = await getUserById(invite.ownerUserId);
  if (!owner) throw notFound("Usuario principal nao encontrado.");
  return publicOperatorInvite(invite, owner);
}

export async function acceptOperatorInvite({ tokenHash, name, email, password }) {
  await ensureStore();
  const invite = await getOperatorInviteByTokenHash(tokenHash);
  if (!invite) throw notFound("Link de cadastro invalido ou expirado.");
  const operator = await createOperator({ ownerUserId: invite.ownerUserId, name, email, password });

  if (hasPostgres()) {
    await query("delete from operator_invites where id = $1", [invite.id]);
  } else {
    const db = await readDb();
    db.operatorInvites = (db.operatorInvites || []).filter((item) => item.id !== invite.id);
    await writeDb(db);
  }

  return operator;
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

export async function getUserConferenceSettings(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      "select value from user_settings where user_id = $1 and key = $2 limit 1",
      [userId, CONFERENCE_SETTINGS_KEY]
    );
    return normalizeConferenceSettings(result.rows[0]?.value || {});
  }

  const db = await readDb();
  const setting = (db.userSettings || []).find((item) => item.userId === userId && item.key === CONFERENCE_SETTINGS_KEY);
  return normalizeConferenceSettings(setting?.value || {});
}

export async function saveUserConferenceSettings(userId, payload = {}) {
  await ensureStore();
  const settings = normalizeConferenceSettings(payload);
  const now = new Date().toISOString();

  if (hasPostgres()) {
    await query(
      `insert into user_settings (user_id, key, value, updated_at)
       values ($1, $2, $3, $4)
       on conflict (user_id, key)
       do update set value = excluded.value, updated_at = excluded.updated_at`,
      [userId, CONFERENCE_SETTINGS_KEY, settings, now]
    );
    return settings;
  }

  const db = await readDb();
  db.userSettings = db.userSettings || [];
  const existing = db.userSettings.find((item) => item.userId === userId && item.key === CONFERENCE_SETTINGS_KEY);
  if (existing) {
    existing.value = settings;
    existing.updatedAt = now;
  } else {
    db.userSettings.push({ userId, key: CONFERENCE_SETTINGS_KEY, value: settings, createdAt: now, updatedAt: now });
  }
  await writeDb(db);
  return settings;
}

export function sanitizeUser(user) {
  if (!user) return null;
  const sanitized = {
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
  if (user.triageAccess) sanitized.triageAccess = true;
  return sanitized;
}

export async function updateUserTriageAccessForAdmin(userId, triageAccess) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("update users set triage_access = $2 where id = $1 returning *", [userId, Boolean(triageAccess)]);
    if (!result.rows.length) throw notFound("Usuario nao encontrado.");
    return { user: sanitizeUser(userFromRow(result.rows[0])) };
  }

  const db = await readDb();
  const user = db.users.find((item) => item.id === userId);
  if (!user) throw notFound("Usuario nao encontrado.");
  user.triageAccess = Boolean(triageAccess);
  await writeDb(db);
  return { user: sanitizeUser(user) };
}

export async function updateOperatorTriageAccess({ ownerUserId, operatorUserId, triageAccess }) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      "update users set triage_access = $3 where id = $2 and parent_user_id = $1 returning *",
      [ownerUserId, operatorUserId, Boolean(triageAccess)]
    );
    if (!result.rows.length) throw notFound("Operador nao encontrado.");
    return { user: sanitizeUser(userFromRow(result.rows[0])) };
  }

  const db = await readDb();
  const user = db.users.find((item) => item.id === operatorUserId && item.parentUserId === ownerUserId);
  if (!user) throw notFound("Operador nao encontrado.");
  user.triageAccess = Boolean(triageAccess);
  await writeDb(db);
  return { user: sanitizeUser(user) };
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

export async function listOperatorsForUser(ownerUserId, period = {}) {
  await ensureStore();
  const range = normalizeOperatorActivityRange(period);
  if (hasPostgres()) {
    const result = await query(
      `
        select
          u.*,
          coalesce(od.day_totals, '{}'::jsonb) as day_totals,
          count(oa.id) filter (where oa.action = any($4::text[]))::int as activity_total,
          max(oa.created_at) as last_activity_at,
          count(oa.id) filter (where oa.action = 'login')::int as login_total,
          count(oa.id) filter (where oa.action = 'search_ml')::int as search_total,
          count(oa.id) filter (where oa.action in ('scan_ml', 'scan_transfer'))::int as scan_total,
          count(oa.id) filter (where oa.action in ('create_manual_product', 'create_external_excess'))::int as create_total,
          count(oa.id) filter (where oa.action = 'view_lot')::int as lot_view_total,
          count(oa.id) filter (where oa.action = 'view_pallet')::int as pallet_view_total,
          count(oa.id) filter (where oa.action = 'report_transfer_divergence')::int as production_error_total
        from users u
        left join operator_activities oa on oa.operator_user_id = u.id
          and ($2::timestamptz is null or oa.created_at >= $2::timestamptz)
          and ($3::timestamptz is null or oa.created_at <= $3::timestamptz)
          and not (
            (lower(coalesce(u.name, '')) like '%eduarda%' or lower(coalesce(u.email, '')) like '%eduarda%')
            and (
              oa.created_at::date in (date '2026-06-24', date '2026-06-26')
              or (oa.created_at at time zone 'America/Sao_Paulo')::date in (date '2026-06-24', date '2026-06-26')
            )
          )
        left join (
          select operator_user_id, jsonb_object_agg(activity_day, day_total) as day_totals
          from (
            select
              oa.operator_user_id,
              to_char(oa.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') as activity_day,
              count(*)::int as day_total
            from operator_activities oa
            join users ou on ou.id = oa.operator_user_id
            where oa.owner_user_id = $1
              and oa.action = any($4::text[])
              and ($2::timestamptz is null or oa.created_at >= $2::timestamptz)
              and ($3::timestamptz is null or oa.created_at <= $3::timestamptz)
              and not (
                (lower(coalesce(ou.name, '')) like '%eduarda%' or lower(coalesce(ou.email, '')) like '%eduarda%')
                and (
                  oa.created_at::date in (date '2026-06-24', date '2026-06-26')
                  or (oa.created_at at time zone 'America/Sao_Paulo')::date in (date '2026-06-24', date '2026-06-26')
                )
              )
            group by oa.operator_user_id, to_char(oa.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
          ) daily_operator_activity
          group by operator_user_id
        ) od on od.operator_user_id = u.id
        where u.parent_user_id = $1
        group by u.id, od.day_totals
        order by u.created_at desc
      `,
      [ownerUserId, range.startAt, range.endAt, OPERATOR_DASHBOARD_ACTIONS]
    );
    return result.rows.map((row) => ({ ...sanitizeUser(userFromRow(row)), stats: operatorStatsFromRow(row) }));
  }

  const db = await readDb();
  return db.users
    .filter((user) => user.parentUserId === ownerUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((user) => ({ ...sanitizeUser(user), stats: summarizeOperatorActivities(db.operatorActivities || [], user.id, range, user) }));
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
          u.triage_access,
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
      triageAccess: Boolean(row.triage_access),
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

export async function listLotsForAdmin() {
  await ensureStore();
  if (hasPostgres()) {
    const [db, usersResult] = await Promise.all([
      readPgDb(),
      query("select id, name, email, tenant_name, parent_user_id, role, operator_code, created_at from users")
    ]);
    const usersById = new Map(usersResult.rows.map((row) => [row.id, sanitizeUser(userFromRow(row))]));
    return db.lots
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((lot) => ({
        ...summarizeLot(db, lot),
        user: usersById.get(lot.userId) || null
      }));
  }

  const db = await readDb();
  const usersById = new Map(db.users.map((user) => [user.id, sanitizeUser(user)]));
  return db.lots
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((lot) => ({
      ...summarizeLot(db, lot),
      user: usersById.get(lot.userId) || null
    }));
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

export async function listTriageItems(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query("select * from triage_items where user_id = $1 order by updated_at desc", [userId]);
    return result.rows.map(triageItemFromRow);
  }

  const db = await readDb();
  return (db.triageItems || [])
    .filter((item) => item.userId === userId)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export async function getTriageStats(userId, period = {}) {
  await ensureStore();
  const range = normalizeOperatorActivityRange(period);
  if (hasPostgres()) {
    const result = await query(
      `
        select
          t.id,
          t.created_by_user_id,
          t.operator_user_id,
          t.status,
          t.destination,
          t.diagnosis_condition,
          coalesce(p.valor_unit, t.valor_unit, 0) as valor_unit,
          coalesce(p.preco_custo, t.preco_custo, 0) as preco_custo,
          u.id as user__id,
          u.tenant_id as user__tenant_id,
          u.tenant_name as user__tenant_name,
          u.parent_user_id as user__parent_user_id,
          u.role as user__role,
          u.operator_code as user__operator_code,
          u.triage_access as user__triage_access,
          u.name as user__name,
          u.email as user__email,
          u.password_hash as user__password_hash,
          u.created_at as user__created_at
        from triage_items t
        left join lateral (
          select pr.valor_unit, pr.preco_custo
          from products pr
          join lots l on l.id = pr.lot_id
          where l.user_id = t.user_id
            and (
              (t.sku <> '' and upper(trim(pr.sku)) = upper(trim(t.sku)))
              or (t.product_code <> '' and upper(trim(pr.codigo_ml)) = upper(trim(t.product_code)))
              or (t.codigo_bling2 <> '' and upper(trim(pr.codigo_ml)) = upper(trim(t.codigo_bling2)))
              or (t.asin <> '' and upper(trim(pr.codigo_ml)) = upper(trim(t.asin)))
            )
          order by pr.created_at desc
          limit 1
        ) p on true
        left join users u on u.id = coalesce(t.operator_user_id, t.created_by_user_id, t.user_id)
        where t.user_id = $1
          and ($2::timestamptz is null or t.created_at >= $2::timestamptz)
          and ($3::timestamptz is null or t.created_at <= $3::timestamptz)
        order by t.updated_at desc
      `,
      [userId, range.startAt, range.endAt]
    );
    return buildTriageStatsFromRows(result.rows.map((row) => ({
      item: {
        id: row.id,
        createdByUserId: row.created_by_user_id || userId,
        operatorUserId: row.operator_user_id || null,
        status: row.status || "aguardando_teste",
        destination: row.destination || "",
        diagnosisCondition: row.diagnosis_condition || ""
      },
      salePrice: num(row.valor_unit),
      costPrice: num(row.preco_custo),
      user: row.user__id ? sanitizeUser(userFromPrefixedRow(row, "user__")) : null
    })));
  }

  const db = await readDb();
  const lotIds = new Set((db.lots || []).filter((lot) => lot.userId === userId).map((lot) => lot.id));
  const userMap = new Map((db.users || []).map((user) => [user.id, sanitizeUser(user)]));
  const rows = (db.triageItems || [])
    .filter((item) => item.userId === userId)
    .filter((item) => isWithinDateRange(item.createdAt, range))
    .map((item) => {
      const product = findTriageStatsProduct(db.products || [], lotIds, item);
      const responsibleUserId = item.operatorUserId || item.createdByUserId || item.userId;
      return {
        item,
        salePrice: Number(product?.valorUnit ?? item.valorUnit ?? 0),
        costPrice: Number(product?.precoCusto ?? item.precoCusto ?? 0),
        user: userMap.get(responsibleUserId) || null
      };
    });
  return buildTriageStatsFromRows(rows);
}

export async function getOperationalDashboardStats(userId) {
  await ensureStore();
  if (hasPostgres()) {
    const lotsDb = await readPgUserLotsDb(userId);
    const [transferLotsResult, usersResult] = await Promise.all([
      query("select * from transfer_lots where user_id = $1 order by created_at desc", [userId]),
      query(
        "select id, name, email, tenant_name, parent_user_id, role, operator_code, created_at from users where id = $1 or parent_user_id = $1",
        [userId]
      )
    ]);
    const transferLotIds = transferLotsResult.rows.map((row) => row.id);
    const [transferItemsResult, reportsResult] = transferLotIds.length
      ? await Promise.all([
        query("select * from transfer_items where transfer_lot_id = any($1::text[]) order by created_at asc", [transferLotIds]),
        query("select * from transfer_divergence_reports where transfer_lot_id = any($1::text[]) order by created_at desc", [transferLotIds])
      ])
      : [{ rows: [] }, { rows: [] }];
    const triageResult = await query("select * from triage_items where user_id = $1 order by created_at asc", [userId]);
    const db = {
      ...lotsDb,
      users: usersResult.rows.map(userFromRow),
      transferLots: transferLotsResult.rows.map(transferLotFromRow),
      transferItems: transferItemsResult.rows.map(transferItemFromRow),
      transferDivergenceReports: reportsResult.rows.map(transferDivergenceReportFromRow),
      triageItems: triageResult.rows.map(triageItemFromRow)
    };
    return buildOperationalDashboardStats(db, userId);
  }

  const db = await readDb();
  return buildOperationalDashboardStats(db, userId);
}

export async function getTriageItem(userId, code) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (hasPostgres()) {
    const result = await query("select * from triage_items where user_id = $1 and upper(code) = upper($2) limit 1", [userId, normalized]);
    if (!result.rows.length) throw notFound("Item de triagem nao encontrado.");
    return triageItemFromRow(result.rows[0]);
  }

  const db = await readDb();
  const item = (db.triageItems || []).find((candidate) => candidate.userId === userId && normalizeCode(candidate.code) === normalized);
  if (!item) throw notFound("Item de triagem nao encontrado.");
  return item;
}

export async function createTriageItem({ userId, createdByUserId, operatorUserId = null, payload = {} }) {
  await ensureStore();
  const now = new Date().toISOString();
  const item = normalizeTriageInput({
    ...payload,
    id: randomUUID(),
    userId,
    createdByUserId: createdByUserId || userId,
    operatorUserId,
    code: await nextTriageCode(userId),
    status: "aguardando_teste",
    destination: "",
    diagnosisCondition: "",
    diagnosis: "",
    createdAt: now,
    updatedAt: now,
    diagnosedAt: null
  });

  if (hasPostgres()) {
    await insertTriageItemRows(null, [item]);
    return item;
  }

  const db = await readDb();
  db.triageItems = db.triageItems || [];
  db.triageItems.push(item);
  await writeDb(db);
  return item;
}

export async function updateTriageDiagnosis({ userId, code, operatorUserId = null, payload = {} }) {
  await ensureStore();
  const destination = normalizeTriageDestination(payload.destination);
  const diagnosisCondition = normalizeTriageDiagnosisCondition(payload.diagnosisCondition ?? payload.diagnosis_condition);
  const diagnosis = String(payload.diagnosis || "").trim();
  const diagnosisPhoto = normalizeTriageDiagnosisPhoto(payload.diagnosisPhoto ?? payload.photo ?? payload.foto ?? "");
  const now = new Date().toISOString();

  if (hasPostgres()) {
    const client = await getPgPool().connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update triage_items
         set status = 'diagnosticado',
             destination = $3,
             diagnosis_condition = $4,
             diagnosis = $5,
             diagnosis_photo = $6,
             operator_user_id = coalesce($7, operator_user_id),
             updated_at = $8,
             diagnosed_at = $8
         where user_id = $1 and upper(code) = upper($2)
         returning *`,
        [userId, normalizeCode(code), destination, diagnosisCondition, diagnosis, diagnosisPhoto, operatorUserId, now]
      );
      if (!result.rows.length) throw notFound("Item de triagem nao encontrado.");
      const item = triageItemFromRow(result.rows[0]);
      await insertTriageEventRows(client, [
        {
          id: randomUUID(),
          userId,
          triageItemId: item.id,
          code: item.code,
          operatorUserId,
          destination,
          diagnosisCondition,
          diagnosis,
          diagnosisPhoto,
          createdAt: now
        }
      ]);
      await client.query("commit");
      return item;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await readDb();
  const item = (db.triageItems || []).find((candidate) => candidate.userId === userId && normalizeCode(candidate.code) === normalizeCode(code));
  if (!item) throw notFound("Item de triagem nao encontrado.");
  item.status = "diagnosticado";
  item.destination = destination;
  item.diagnosisCondition = diagnosisCondition;
  item.diagnosis = diagnosis;
  item.diagnosisPhoto = diagnosisPhoto;
  item.operatorUserId = operatorUserId || item.operatorUserId || null;
  item.updatedAt = now;
  item.diagnosedAt = now;
  db.triageEvents = db.triageEvents || [];
  db.triageEvents.push({
    id: randomUUID(),
    userId,
    triageItemId: item.id,
    code: item.code,
    operatorUserId,
    destination,
    diagnosisCondition,
    diagnosis,
    diagnosisPhoto,
    createdAt: now
  });
  await writeDb(db);
  return item;
}

export async function listTriageDiagnosisHistory({ userId, code }) {
  await ensureStore();
  const item = await getTriageItem(userId, code);

  let history;
  if (hasPostgres()) {
    const result = await query(
      "select * from triage_events where user_id = $1 and triage_item_id = $2 order by created_at desc",
      [userId, item.id]
    );
    history = result.rows.map(triageEventFromRow);
  } else {
    const db = await readDb();
    history = (db.triageEvents || [])
      .filter((event) => event.userId === userId && event.triageItemId === item.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  if (!history.length && item.diagnosis) {
    return [
      {
        id: `current-${item.id}`,
        userId: item.userId,
        triageItemId: item.id,
        code: item.code,
        operatorUserId: item.operatorUserId,
        destination: item.destination,
        diagnosisCondition: item.diagnosisCondition || "",
        diagnosis: item.diagnosis,
        diagnosisPhoto: item.diagnosisPhoto,
        createdAt: item.diagnosedAt || item.updatedAt || item.createdAt
      }
    ];
  }
  return history;
}

export async function updateTriageItemDetails({ userId, code, payload = {} }) {
  await ensureStore();
  const currentCode = normalizeCode(code);
  const nextCode = normalizeCode(payload.code || currentCode);
  if (!nextCode) throw new Error("Informe a identificacao interna.");
  const hasValorUnit = payload.valorUnit !== undefined || payload.valor_unit !== undefined || payload.preco !== undefined;
  const hasPrecoCusto = payload.precoCusto !== undefined || payload.preco_custo !== undefined || payload.custo !== undefined;

  const details = {
    productCode: normalizeCode(payload.productCode || payload.codigoMl),
    sku: normalizeCode(payload.sku),
    ean: String(payload.ean || "").trim(),
    asin: normalizeCode(payload.asin),
    codigoBling2: normalizeCode(payload.codigoBling2),
    descricao: String(payload.descricao || payload.description || "").trim(),
    valorUnit: hasValorUnit ? decimalMoney(payload.valorUnit ?? payload.valor_unit ?? payload.preco) : null,
    precoCusto: hasPrecoCusto ? decimalMoney(payload.precoCusto ?? payload.preco_custo ?? payload.custo) : null,
    serial: String(payload.serial || "").trim(),
    alturaCaixa: optionalNum(payload.alturaCaixa ?? payload.altura_caixa ?? payload.altura),
    larguraCaixa: optionalNum(payload.larguraCaixa ?? payload.largura_caixa ?? payload.largura),
    comprimentoCaixa: optionalNum(payload.comprimentoCaixa ?? payload.comprimento_caixa ?? payload.comprimento ?? payload.profundidade),
    pesoCaixa: optionalNum(payload.pesoCaixa ?? payload.peso_caixa ?? payload.peso)
  };
  if (!details.descricao && !details.sku && !details.ean && !details.asin && !details.productCode) {
    throw new Error("Informe pelo menos uma identificacao do produto.");
  }
  const now = new Date().toISOString();

  if (hasPostgres()) {
    if (nextCode !== currentCode) {
      const duplicate = await query(
        "select id from triage_items where user_id = $1 and upper(code) = upper($2) and upper(code) <> upper($3) limit 1",
        [userId, nextCode, currentCode]
      );
      if (duplicate.rows.length) throw new Error("Ja existe um item de triagem com esta identificacao interna.");
    }

    const result = await query(
      `update triage_items
       set code = $3,
           product_code = $4,
           sku = $5,
           ean = $6,
           asin = $7,
           codigo_bling2 = $8,
           descricao = $9,
           valor_unit = case when $10::numeric is not null and $10::numeric > 0 then $10::numeric else valor_unit end,
           preco_custo = case when $11::numeric is not null and $11::numeric > 0 then $11::numeric else preco_custo end,
           serial = $12,
           altura_caixa = $13,
           largura_caixa = $14,
           comprimento_caixa = $15,
           peso_caixa = $16,
           updated_at = $17
       where user_id = $1 and upper(code) = upper($2)
       returning *`,
      [
        userId,
        currentCode,
        nextCode,
        details.productCode,
        details.sku,
        details.ean,
        details.asin,
        details.codigoBling2,
        details.descricao,
        details.valorUnit,
        details.precoCusto,
        details.serial,
        details.alturaCaixa || null,
        details.larguraCaixa || null,
        details.comprimentoCaixa || null,
        details.pesoCaixa || null,
        now
      ]
    );
    if (!result.rows.length) throw notFound("Item de triagem nao encontrado.");
    return triageItemFromRow(result.rows[0]);
  }

  const db = await readDb();
  const item = (db.triageItems || []).find((candidate) => candidate.userId === userId && normalizeCode(candidate.code) === currentCode);
  if (!item) throw notFound("Item de triagem nao encontrado.");
  if (nextCode !== currentCode) {
    const duplicate = (db.triageItems || []).find(
      (candidate) => candidate.userId === userId && candidate.id !== item.id && normalizeCode(candidate.code) === nextCode
    );
    if (duplicate) throw new Error("Ja existe um item de triagem com esta identificacao interna.");
  }
  if (!details.valorUnit) delete details.valorUnit;
  if (!details.precoCusto) delete details.precoCusto;
  Object.assign(item, details, { code: nextCode, updatedAt: now });
  await writeDb(db);
  return item;
}

export async function updateProductRegistrationFromTriage({ userId, item }) {
  await ensureStore();
  const sku = normalizeCode(item?.sku);
  const productCode = normalizeCode(item?.productCode || item?.codigoBling2);
  const asin = normalizeCode(item?.asin);
  const ean = String(item?.ean || "").trim();
  if (!sku && !productCode && !asin) return null;
  if (!ean && !asin) return null;

  if (hasPostgres()) {
    const result = await query(
      `
        update products p
        set ean = case when $4 <> '' then $4 else p.ean end,
            codigo_ml = case when $5 <> '' then $5 else p.codigo_ml end
        where exists (select 1 from lots l where l.id = p.lot_id and l.user_id = $1)
          and (
            ($2 <> '' and upper(trim(p.sku)) = upper(trim($2)))
            or ($3 <> '' and upper(trim(p.codigo_ml)) = upper(trim($3)))
            or ($5 <> '' and upper(trim(p.codigo_ml)) = upper(trim($5)))
          )
        returning *
      `,
      [userId, sku, productCode, ean, asin]
    );
    return result.rows[0] ? productFromRow(result.rows[0]) : null;
  }

  const db = await readDb();
  const lotIds = new Set((db.lots || []).filter((lot) => lot.userId === userId).map((lot) => lot.id));
  const product = (db.products || []).find((candidate) => {
    if (!lotIds.has(candidate.lotId)) return false;
    return (sku && normalizeCode(candidate.sku) === sku) ||
      (productCode && normalizeCode(candidate.codigoMl) === productCode) ||
      (asin && normalizeCode(candidate.codigoMl) === asin);
  });
  if (!product) return null;
  if (ean) product.ean = ean;
  if (asin) product.codigoMl = asin;
  await writeDb(db);
  return product;
}

export async function canDeleteTriageItem({ userId, code, requesterUserId = null, isOwner = false }) {
  await ensureStore();
  if (isOwner) return true;
  const requesterId = String(requesterUserId || "").trim();
  const normalized = normalizeCode(code);
  if (!requesterId || !normalized) return false;

  if (hasPostgres()) {
    const result = await query(
      `select code
       from triage_items
       where user_id = $1 and created_by_user_id = $2
       order by created_at desc
       limit 5`,
      [userId, requesterId]
    );
    return result.rows.some((row) => normalizeCode(row.code) === normalized);
  }

  const db = await readDb();
  return (db.triageItems || [])
    .filter((item) => item.userId === userId && item.createdByUserId === requesterId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 5)
    .some((item) => normalizeCode(item.code) === normalized);
}

export async function deleteTriageItem({ userId, code, requesterUserId = null, isOwner = true }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!(await canDeleteTriageItem({ userId, code: normalized, requesterUserId, isOwner }))) {
    const error = new Error("Operador pode excluir apenas as 5 ultimas etiquetas que ele gerou.");
    error.status = 403;
    throw error;
  }

  if (hasPostgres()) {
    const result = await query(
      "delete from triage_items where user_id = $1 and upper(code) = upper($2) returning *",
      [userId, normalized]
    );
    if (!result.rows.length) throw notFound("Item de triagem nao encontrado.");
    return triageItemFromRow(result.rows[0]);
  }

  const db = await readDb();
  const index = (db.triageItems || []).findIndex((candidate) => candidate.userId === userId && normalizeCode(candidate.code) === normalized);
  if (index < 0) throw notFound("Item de triagem nao encontrado.");
  const [item] = db.triageItems.splice(index, 1);
  await writeDb(db);
  return item;
}

export async function lookupTriageProduct(userId, code) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  if (hasPostgres()) {
    const productResult = await query(
      `
        select
          p.*,
          l.id as lot__id,
          l.nome_arquivo as lot__nome_arquivo,
          l.created_at as lot__created_at
        from products p
        join lots l on l.id = p.lot_id
        where l.user_id = $1
          and (
            upper(trim(p.sku)) = upper(trim($2))
            or regexp_replace(upper(trim(p.sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($2))
          )
        order by p.created_at desc
        limit 1
      `,
      [userId, normalized]
    );
    if (productResult.rows.length) return triageLookupFromProduct(productFromRow(productResult.rows[0]), productResult.rows[0]);
    return null;
  }

  const db = await readDb();
  const product = findTransferProduct(db, userId, normalized);
  if (product) return triageLookupFromProduct(product, { lot__nome_arquivo: product.sourceLotName || "" });
  return null;
}

export async function updateOperatorPasswordForOwner(ownerUserId, operatorUserId, password) {
  await ensureStore();
  const normalizedPassword = String(password || "");
  if (normalizedPassword.length < 4) throw new Error("Informe uma senha com pelo menos 4 caracteres.");
  const passwordHash = await bcrypt.hash(normalizedPassword, 10);

  if (hasPostgres()) {
    const result = await query(
      "update users set password_hash = $1 where id = $2 and parent_user_id = $3 returning id",
      [passwordHash, operatorUserId, ownerUserId]
    );
    if (!result.rows.length) throw notFound("Operador nao encontrado.");
    return { ok: true };
  }

  const db = await readDb();
  const operator = db.users.find((item) => item.id === operatorUserId && item.parentUserId === ownerUserId);
  if (!operator) throw notFound("Operador nao encontrado.");
  operator.passwordHash = passwordHash;
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
  db.operatorInvites = (db.operatorInvites || []).filter((invite) => invite.ownerUserId !== userId);
  db.userSettings = (db.userSettings || []).filter((setting) => setting.userId !== userId);
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
      for (const product of products) {
        await mergePendingCatalogRequestPg(client, await buildLotCatalogRequestPg(client, { userId, lot, product }));
      }
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
  for (const product of products) {
    mergePendingCatalogRequest(db.catalogRequests, buildLotCatalogRequest(db, { userId, lot, product }));
  }
  await writeDb(db);
  return summarizeLot(db, lot);
}

export async function createDiverseLot({ userId, name, fornecedor, skuPrefix, startSequence, averageCost, costMode = "fixed", costPercent = 0, suggestions = [] }) {
  await ensureStore();
  const sequence = Math.max(1, Number.parseInt(startSequence, 10) || 1);
  const tipoCusto = costMode === "variable" ? "variable" : "fixed";
  const percentualCusto = tipoCusto === "variable" ? roundMoney(Number(costPercent || 0)) : 0;
  const custoMedioUnitario = tipoCusto === "fixed" ? roundMoney(Number(averageCost || 0)) : 0;
  if (tipoCusto === "fixed" && (!Number.isFinite(custoMedioUnitario) || custoMedioUnitario <= 0)) {
    throw new Error("Informe o custo medio por unidade para criar lote sem planilha.");
  }
  if (tipoCusto === "variable" && (!Number.isFinite(percentualCusto) || percentualCusto <= 0)) {
    throw new Error("Informe o percentual do custo variavel para criar lote sem planilha.");
  }
  const lot = {
    id: randomUUID(),
    userId,
    nomeArquivo: name,
    percentualArremate: 0,
    custoMedioUnitario,
    tipoCusto,
    percentualCusto,
    fornecedor,
    prefixoSku: skuPrefix,
    proximoSequencialSku: sequence,
    noSheetSuggestions: normalizeNoSheetSuggestions(suggestions),
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

export async function updateNoSheetSuggestions({ userId, lotId, suggestions }) {
  await ensureStore();
  const normalized = normalizeNoSheetSuggestions(suggestions);
  if (hasPostgres()) {
    const result = await query(
      "update lots set no_sheet_suggestions = $3 where id = $1 and user_id = $2 returning *",
      [lotId, userId, JSON.stringify(normalized)]
    );
    if (!result.rows.length) throw notFound("Lote nao encontrado.");
    return { lot: await getUserLotDetail(userId, lotId), suggestions: normalized };
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");
  lot.noSheetSuggestions = normalized;
  await writeDb(db);
  return { lot: summarizeLot(db, lot, true), suggestions: normalized };
}

export async function suggestNoSheetProducts({ userId, lotId, query: search }) {
  await ensureStore();
  const term = normalizeSearchText(search);
  const terms = normalizeSearchTerms(search);
  if (term.length < 2 || !terms.length) return { suggestions: [], source: "empty" };

  const lot = await getUserLotDetail(userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");

  const lotSuggestions = (lot.noSheetSuggestions || [])
    .filter((suggestion) => searchTermsMatch(suggestion.descricao, search))
    .slice(0, 12)
    .map((suggestion) => ({ ...suggestion, source: "lista_lote" }));
  if (lotSuggestions.length) return { suggestions: lotSuggestions, source: "lista_lote" };

  if (hasPostgres()) {
    const params = [userId, lotId];
    const termWhere = sqlAllTermsCondition("lower(p.descricao)", search, params);
    const result = await query(
      `
        select distinct on (upper(trim(p.codigo_ml))) p.*
        from products p
        join lots l on l.id = p.lot_id
        where l.user_id = $1
          and l.id <> $2
          and ${termWhere}
        order by upper(trim(p.codigo_ml)), p.created_at desc
        limit 12
      `,
      params
    );
    return { suggestions: result.rows.map((row) => productSuggestionFromProduct(productFromRow(row))), source: "historico" };
  }

  const db = await readDb();
  const userLotIds = new Set(db.lots.filter((candidate) => candidate.userId === userId && candidate.id !== lotId).map((candidate) => candidate.id));
  const byCode = new Map();
  for (const product of db.products || []) {
    if (!userLotIds.has(product.lotId)) continue;
    if (!searchTermsMatch(product.descricao, search)) continue;
    const key = normalizeCode(product.codigoMl);
    const current = byCode.get(key);
    if (!current || String(product.createdAt || "").localeCompare(String(current.createdAt || "")) > 0) byCode.set(key, product);
  }
  return {
    suggestions: [...byCode.values()]
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 12)
      .map(productSuggestionFromProduct),
    source: "historico"
  };
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

export async function updateLotProduct({ userId, lotId, productId, payload }) {
  await ensureStore();
  const normalized = normalizeEditableProduct(payload);
  if (hasPostgres()) {
    const result = await query(
      `
        update products
        set descricao = $4,
            valor_unit = $5,
            preco_custo = $6,
            ean = $7,
            link = $8,
            foto = $9,
            altura_caixa = $10,
            largura_caixa = $11,
            comprimento_caixa = $12,
            peso_caixa = $13,
            localizacao_estoque = $14
        where id = $1
          and lot_id = $2
          and exists (select 1 from lots where id = $2 and user_id = $3)
        returning *
      `,
      [
        productId,
        lotId,
        userId,
        normalized.descricao,
        normalized.valorUnit,
        normalized.precoCusto,
        normalized.ean,
        normalized.link,
        normalized.foto,
        normalized.alturaCaixa || null,
        normalized.larguraCaixa || null,
        normalized.comprimentoCaixa || null,
        normalized.pesoCaixa || null,
        normalized.localizacaoEstoque
      ]
    );
    if (!result.rows.length) throw notFound("Produto nao encontrado neste lote.");
    return { product: productFromRow(result.rows[0]), lot: await getUserLotDetail(userId, lotId) };
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");
  const product = db.products.find((item) => item.id === productId && item.lotId === lot.id);
  if (!product) throw notFound("Produto nao encontrado neste lote.");
  Object.assign(product, normalized);
  await writeDb(db);
  return { product, lot: summarizeLot(db, lot, true) };
}

export async function splitLotProduct({ userId, lotId, productId, codigoRz, payload }) {
  await ensureStore();
  const kitQuantity = Math.round(Number(payload?.kitQuantity || 0));
  const sellableQuantity = Math.round(Number(payload?.sellableQuantity || 0));
  const descricao = String(payload?.descricao || "").trim();
  if (!Number.isFinite(kitQuantity) || kitQuantity < 2) throw new Error("Informe a quantidade original do kit.");
  if (!Number.isFinite(sellableQuantity) || sellableQuantity < 1) throw new Error("Informe quantas unidades ficaram vendaveis.");
  if (sellableQuantity > kitQuantity) throw new Error("A quantidade vendavel nao pode ser maior que o kit original.");
  if (!descricao) throw new Error("Informe o titulo do produto unitario.");

  if (hasPostgres()) return splitLotProductPg({ userId, lotId, productId, codigoRz, kitQuantity, sellableQuantity, descricao });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");
  const product = db.products.find((item) => item.id === productId && item.lotId === lot.id);
  if (!product) throw notFound("Produto nao encontrado neste lote.");
  const item = db.rzItems.find((candidate) => candidate.lotId === lot.id && candidate.productId === product.id && candidate.codigoRz === codigoRz);
  if (!item) throw notFound("Item nao encontrado nesta RZ.");

  const split = calculateSplitProductValues(product, item, { kitQuantity, sellableQuantity, descricao });
  product.valorUnit = split.valorUnit;
  product.precoCusto = split.precoCusto;
  product.qtdTotal = split.qtdTotal;
  product.descricao = split.descricao;
  item.qtdEsperada = sellableQuantity;
  item.qtdConferida = Math.min(Number(item.qtdConferida || 0), sellableQuantity);
  item.valorTotal = split.valorTotal;
  item.tipoItem = splitItemType(item.tipoItem);

  await writeDb(db);
  return { product, lot: summarizeLot(db, lot, true) };
}

export function calculateSplitProductValues(product, item, { kitQuantity, sellableQuantity, descricao = "" }) {
  const valorUnit = roundMoney(Number(product?.valorUnit || 0) / kitQuantity);
  const precoCusto = roundMoney(Number(product?.precoCusto || 0) / kitQuantity);
  return {
    descricao: String(descricao || "").trim() || splitProductDescription(product?.descricao, kitQuantity, sellableQuantity),
    valorUnit,
    precoCusto,
    qtdTotal: Math.max(0, Number(product?.qtdTotal || 0) - Number(item?.qtdEsperada || 0) + sellableQuantity),
    valorTotal: roundMoney(valorUnit * sellableQuantity)
  };
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
    const reports = lotIds.length
      ? await query("select * from transfer_divergence_reports where transfer_lot_id = any($1::text[]) order by created_at desc", [lotIds])
      : { rows: [] };
    return summarizeTransferLots(lots.rows.map(transferLotFromRow), items.rows.map(transferItemFromRow), reports.rows.map(transferDivergenceReportFromRow));
  }

  const db = await readDb();
  return summarizeTransferLots(
    (db.transferLots || []).filter((lot) => lot.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    db.transferItems || [],
    db.transferDivergenceReports || []
  );
}

export async function getTransferLotDetail(userId, transferLotId) {
  await ensureStore();
  if (hasPostgres()) {
    const lotResult = await query("select * from transfer_lots where id = $1 and user_id = $2 limit 1", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) return null;
    const [items, reports] = await Promise.all([
      query("select * from transfer_items where transfer_lot_id = $1 order by created_at asc", [lot.id]),
      query("select * from transfer_divergence_reports where transfer_lot_id = $1 order by created_at desc", [lot.id])
    ]);
    return summarizeTransferLot(lot, items.rows.map(transferItemFromRow), reports.rows.map(transferDivergenceReportFromRow));
  }

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) return null;
  return summarizeTransferLot(lot, db.transferItems || [], db.transferDivergenceReports || []);
}

export async function getPublicTransferLotDetail(transferLotId) {
  await ensureStore();
  if (hasPostgres()) {
    const lotResult = await query("select * from transfer_lots where id = $1 limit 1", [transferLotId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) return null;
    const [items, reports] = await Promise.all([
      query("select * from transfer_items where transfer_lot_id = $1 order by created_at asc", [lot.id]),
      query("select * from transfer_divergence_reports where transfer_lot_id = $1 order by created_at desc", [lot.id])
    ]);
    return summarizeTransferLot(lot, items.rows.map(transferItemFromRow), reports.rows.map(transferDivergenceReportFromRow));
  }

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId);
  if (!lot) return null;
  return summarizeTransferLot(lot, db.transferItems || [], db.transferDivergenceReports || []);
}

export async function reportTransferLotDivergence({ userId = null, transferLotId, type, description, code = "", reporterName = "", reporterUserId = null }) {
  await ensureStore();
  const report = buildTransferDivergenceReport({ transferLotId, type, description, code, reporterName, reporterUserId });
  if (hasPostgres()) return reportTransferLotDivergencePg({ userId, report });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && (!userId || item.userId === userId));
  if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
  if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
  db.transferDivergenceReports = db.transferDivergenceReports || [];
  db.transferDivergenceReports.push(report);
  lot.status = "divergent";
  await writeDb(db);
  return { report, lot: userId ? await getTransferLotDetail(userId, transferLotId) : await getPublicTransferLotDetail(transferLotId) };
}

async function buildTransferLotWithAutomaticNamePg({ userId, descricao = "", depositoOrigem, depositoDestino, createdByUserId = null }) {
  const creatorId = createdByUserId || userId;
  const [creatorResult, sequenceResult] = await Promise.all([
    query("select * from users where id = $1 limit 1", [creatorId]),
    query(
      "select count(*)::int as total from transfer_lots where user_id = $1 and coalesce(created_by_user_id, user_id) = $2",
      [userId, creatorId]
    )
  ]);
  const creator = creatorResult.rows[0] ? userFromRow(creatorResult.rows[0]) : null;
  return buildTransferLotRecord({
    userId,
    descricao,
    depositoOrigem,
    depositoDestino,
    createdByUserId,
    creator,
    sequence: Number(sequenceResult.rows[0]?.total || 0) + 1
  });
}

function buildTransferLotWithAutomaticName(db, { userId, descricao = "", depositoOrigem, depositoDestino, createdByUserId = null }) {
  const creatorId = createdByUserId || userId;
  const creator = (db.users || []).find((user) => user.id === creatorId) || null;
  const existingCount = (db.transferLots || []).filter((lot) => (
    lot.userId === userId && (lot.createdByUserId || lot.userId) === creatorId
  )).length;
  return buildTransferLotRecord({
    userId,
    descricao,
    depositoOrigem,
    depositoDestino,
    createdByUserId,
    creator,
    sequence: existingCount + 1
  });
}

function buildTransferLotRecord({ userId, descricao = "", depositoOrigem, depositoDestino, createdByUserId = null, creator = null, sequence = 1 }) {
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
    name: formatTransferLotName({ creator, sequence, createdAt }),
    descricao: String(descricao || "").trim().slice(0, 80),
    depositoOrigem,
    depositoDestino,
    status: "open",
    createdByUserId,
    createdAt,
    syncedAt: null
  };
}

function formatTransferLotName({ creator = null, sequence = 1, createdAt = new Date().toISOString() }) {
  const creatorName = String(creator?.name || "").trim();
  const creatorCode = creator?.operatorCode ? `Operador ${creator.operatorCode}` : "";
  const label = creatorName || creatorCode || "Operador";
  return `${label} ${formatCompactDate(createdAt)}-${String(sequence).padStart(3, "0")}`;
}

function formatCompactDate(value) {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

export async function createTransferLot({ userId, descricao = "", depositoOrigem, depositoDestino, createdByUserId = null }) {
  await ensureStore();
  const depositoOrigemValue = String(depositoOrigem || "").trim();
  const depositoDestinoValue = String(depositoDestino || "").trim();
  if (!depositoOrigemValue) throw new Error("Informe o estoque de origem.");
  if (!depositoDestinoValue) throw new Error("Informe o estoque de destino.");
  if (normalizeText(depositoOrigemValue) === normalizeText(depositoDestinoValue)) throw new Error("Origem e destino precisam ser diferentes.");

  if (hasPostgres()) {
    const lot = await buildTransferLotWithAutomaticNamePg({
      userId,
      descricao,
      depositoOrigem: depositoOrigemValue,
      depositoDestino: depositoDestinoValue,
      createdByUserId
    });
    await insertTransferLotRows(null, [lot]);
    return summarizeTransferLot(lot, []);
  }

  const db = await readDb();
  const lot = buildTransferLotWithAutomaticName(db, {
    userId,
    descricao,
    depositoOrigem: depositoOrigemValue,
    depositoDestino: depositoDestinoValue,
    createdByUserId
  });
  db.transferLots.push(lot);
  await writeDb(db);
  return summarizeTransferLot(lot, []);
}

export async function scanTransferLot({ userId, transferLotId, code, externalProduct = null }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Informe o Codigo ML ou SKU.");
  const normalizedExternalProduct = normalizeExternalTransferProduct(externalProduct, normalized);
  if (hasPostgres()) return scanTransferLotPg({ userId, transferLotId, code: normalized, externalProduct: normalizedExternalProduct });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");

  const product = findTransferProduct(db, userId, normalized) || normalizedExternalProduct;
  if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
  const existing = findExistingTransferItem(db.transferItems || [], lot.id, product);
  const now = new Date().toISOString();
  if (existing) {
    existing.quantidade += 1;
    existing.createdAt = now;
  } else {
    db.transferItems.push(buildTransferItem(lot.id, product));
  }
  await writeDb(db);
  return { status: existing ? "updated" : "added", product, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function releaseTransferLotForStore({ userId, transferLotId }) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      "update transfer_lots set status = 'waiting_store' where id = $1 and user_id = $2 and status <> 'synced' returning *",
      [transferLotId, userId]
    );
    if (!result.rows.length) throw notFound("Lote de transferencia nao encontrado.");
    return { lot: await getTransferLotDetail(userId, transferLotId) };
  }

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");
  lot.status = "waiting_store";
  await writeDb(db);
  return { lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function receiveTransferLotScan({ userId, transferLotId, code }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Informe o Codigo ML, SKU ou EAN.");
  if (hasPostgres()) return receiveTransferLotScanPg({ userId, transferLotId, code: normalized });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
  if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
  if (lot.status === "open") throw new Error("A remessa ainda nao foi liberada pelo CD.");

  const item = findTransferItemForReceive(db.transferItems || [], lot.id, normalized);
  if (!item) throw notFound("Produto nao previsto nesta remessa.");
  if (Number(item.quantidadeConferida || 0) >= Number(item.quantidade || 0)) throw new Error("Produto ja conferido nesta remessa.");
  item.quantidadeConferida = Number(item.quantidadeConferida || 0) + 1;
  item.createdAt = new Date().toISOString();
  updateTransferLotReceivingStatus(lot, db.transferItems || []);
  await writeDb(db);
  return { status: item.quantidadeConferida > Number(item.quantidade || 0) ? "over" : "received", item, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function receivePublicTransferLotScan({ transferLotId, code }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("Informe o Codigo ML, SKU ou EAN.");
  if (hasPostgres()) return receiveTransferLotScanPg({ transferLotId, code: normalized });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId);
  if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
  if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
  if (lot.status === "open") throw new Error("A remessa ainda nao foi liberada pelo CD.");

  const item = findTransferItemForReceive(db.transferItems || [], lot.id, normalized);
  if (!item) throw notFound("Produto nao previsto nesta remessa.");
  if (Number(item.quantidadeConferida || 0) >= Number(item.quantidade || 0)) throw new Error("Produto ja conferido nesta remessa.");
  item.quantidadeConferida = Number(item.quantidadeConferida || 0) + 1;
  item.createdAt = new Date().toISOString();
  updateTransferLotReceivingStatus(lot, db.transferItems || []);
  await writeDb(db);
  return { status: item.quantidadeConferida > Number(item.quantidade || 0) ? "over" : "received", item, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function forceReceivePublicTransferLotScan({ transferLotId, code, reason }) {
  await ensureStore();
  const normalized = normalizeCode(code);
  const normalizedReason = normalizeForceTransferReason(reason);
  if (!normalized) throw new Error("Informe o Codigo ML, SKU ou EAN.");
  if (hasPostgres()) return forceReceiveTransferLotScanPg({ transferLotId, code: normalized, reason: normalizedReason });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId);
  if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
  if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
  if (lot.status === "open") throw new Error("A remessa ainda nao foi liberada pelo CD.");

  const product = findTransferProduct(db, lot.userId, normalized);
  if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
  const existingPlanned = (db.transferItems || []).find((item) => item.transferLotId === lot.id && item.productId === product.id && Number(item.quantidade || 0) > 0);
  if (existingPlanned) throw new Error("Produto previsto na remessa. Use a conferencia normal.");

  const existingForced = (db.transferItems || []).find((item) => item.transferLotId === lot.id && item.productId === product.id && Number(item.quantidade || 0) === 0);
  const now = new Date().toISOString();
  const occurrence = buildForcedTransferOccurrence({ transferLotId: lot.id, code: normalized, reason: normalizedReason, itemId: existingForced?.id || null, createdAt: now });
  db.transferForcedOccurrences = db.transferForcedOccurrences || [];
  if (existingForced) {
    existingForced.quantidadeConferida = Number(existingForced.quantidadeConferida || 0) + 1;
    existingForced.forceReason = normalizedReason;
    existingForced.forceCode = normalized;
    existingForced.forceAt = now;
    existingForced.createdAt = now;
    occurrence.itemId = existingForced.id;
  } else {
    const item = {
      ...buildTransferItem(lot.id, product),
      quantidade: 0,
      quantidadeConferida: 1,
      forceReason: normalizedReason,
      forceCode: normalized,
      forceAt: now
    };
    db.transferItems.push(item);
    occurrence.itemId = item.id;
  }
  db.transferForcedOccurrences.push(occurrence);
  updateTransferLotReceivingStatus(lot, db.transferItems || []);
  await writeDb(db);
  const item = (db.transferItems || []).find((candidate) => candidate.id === occurrence.itemId);
  return { status: "forced", item, occurrence, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function undoPublicTransferLotScan({ transferLotId, itemId }) {
  await ensureStore();
  if (hasPostgres()) {
    const result = await query(
      "update transfer_items set quantidade_conferida = greatest(quantidade_conferida - 1, 0) where id = $1 and transfer_lot_id = $2 returning *",
      [itemId, transferLotId]
    );
    if (!result.rows.length) return null;
    const changedItem = transferItemFromRow(result.rows[0]);
    if (Number(changedItem.quantidade || 0) === 0 && Number(changedItem.quantidadeConferida || 0) === 0) {
      await query("delete from transfer_items where id = $1 and transfer_lot_id = $2", [itemId, transferLotId]);
    }
    const lotResult = await query("select * from transfer_lots where id = $1 limit 1", [transferLotId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (lot) {
      const itemsResult = await query("select * from transfer_items where transfer_lot_id = $1", [transferLotId]);
      updateTransferLotReceivingStatus(lot, itemsResult.rows.map(transferItemFromRow));
      await query("update transfer_lots set status = $2 where id = $1", [transferLotId, lot.status]);
    }
    return getPublicTransferLotDetail(transferLotId);
  }

  const db = await readDb();
  const item = (db.transferItems || []).find((candidate) => candidate.id === itemId && candidate.transferLotId === transferLotId);
  if (!item) return null;
  item.quantidadeConferida = Math.max(0, Number(item.quantidadeConferida || 0) - 1);
  if (Number(item.quantidade || 0) === 0 && Number(item.quantidadeConferida || 0) === 0) {
    db.transferItems = (db.transferItems || []).filter((candidate) => candidate.id !== item.id);
  }
  const lot = (db.transferLots || []).find((candidate) => candidate.id === transferLotId);
  if (lot) updateTransferLotReceivingStatus(lot, db.transferItems || []);
  await writeDb(db);
  return lot ? summarizeTransferLot(lot, db.transferItems || []) : null;
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

export async function deleteTransferLotItem({ userId, transferLotId, itemId }) {
  await ensureStore();
  if (hasPostgres()) return deleteTransferLotItemPg({ userId, transferLotId, itemId });

  const db = await readDb();
  const lot = (db.transferLots || []).find((item) => item.id === transferLotId && item.userId === userId);
  if (!lot) throw notFound("Lote de transferencia nao encontrado.");
  if (lot.status !== "open") throw new Error("So e possivel excluir itens enquanto o CD esta montando a remessa.");
  const item = (db.transferItems || []).find((candidate) => candidate.id === itemId && candidate.transferLotId === lot.id);
  if (!item) throw notFound("Item nao encontrado no lote.");
  const deletedItem = { ...item };
  db.transferItems = (db.transferItems || []).filter((candidate) => candidate.id !== item.id);
  await writeDb(db);
  return { item: deletedItem, lot: summarizeTransferLot(lot, db.transferItems || []) };
}

export async function deleteLotRzItem({ userId, lotId, codigoRz, itemId }) {
  await ensureStore();
  if (hasPostgres()) return deleteLotRzItemPg({ userId, lotId, codigoRz, itemId });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote nao encontrado.");

  const item = (db.rzItems || []).find((candidate) => candidate.id === itemId && candidate.lotId === lot.id && candidate.codigoRz === codigoRz);
  if (!item) throw notFound("Item nao encontrado nesta RZ.");
  const product = (db.products || []).find((candidate) => candidate.id === item.productId && candidate.lotId === lot.id);

  db.rzItems = (db.rzItems || []).filter(
    (candidate) => !(candidate.lotId === lot.id && candidate.codigoRz === codigoRz && candidate.productId === item.productId)
  );
  const productStillUsed = (db.rzItems || []).some((candidate) => candidate.productId === item.productId);
  if (!productStillUsed) db.products = (db.products || []).filter((candidate) => candidate.id !== item.productId);
  db.scans.push({
    id: randomUUID(),
    lotId: lot.id,
    codigoRz,
    codigoMl: product?.codigoMl || "",
    status: "item_excluido",
    createdAt: new Date().toISOString()
  });
  await writeDb(db);
  return { item: { ...item, product }, lot: summarizeLot(db, lot, true) };
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
  const sameRzItems = findRzItemsByScannedCode(rzItems, db.products, normalizedMl);
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
    const sameLotProduct = findLotProductByScannedCode(db.products, lot.id, normalizedMl);
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
  const sameRzItems = findRzItemsByScannedCode(rzItems, db.products, normalizedMl);
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
  const { product, item } = buildExternalExcessRecords(lot, sourceManual, codigoRz, normalizedMl, { createdByUserId, operatorUserId });
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
    const { product, item } = buildDiverseLotRecords(lot, previousHistory, normalizedMl, normalizedRz, { valorUnitOverride, createdByUserId, operatorUserId });
    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    await writeDb(db);
    return { status: "criado", product, parent: previousHistory, source: "historico", lot: summarizeLot(db, lot, true) };
  }
  if (!history && source) {
    const { product, item } = buildDiverseLotRecords(lot, source, normalizedMl, normalizedRz, { valorUnitOverride, createdByUserId, operatorUserId });
    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    await writeDb(db);
    return { status: "criado", product, parent: null, source: "catalogo_oculto", lot: summarizeLot(db, lot, true) };
  }
  if (!history && manualProduct) {
    const sourceManual = normalizeManualProduct(manualProduct, normalizedMl);
    const { product, item } = buildDiverseLotRecords(lot, sourceManual, normalizedMl, normalizedRz, { origem: "lote_sem_planilha_manual", createdByUserId, operatorUserId });
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

  const { product, item } = buildDiverseLotRecords(lot, history, normalizedMl, normalizedRz, { valorUnitOverride, createdByUserId, operatorUserId });
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
      where cr.status = 'pending'
        and upper(trim(cr.codigo_ml)) ~ '^[A-Z]{4}[0-9]{5}$'
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
    .filter((request) => request.status === "pending" && isStandardMlCode(request.codigoMl))
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
      where upper(trim(crr.codigo_ml)) ~ '^[A-Z]{4}[0-9]{5}$'
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
    .filter((request) => isStandardMlCode(request.codigoMl))
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
      where = `where ${sqlAllTermsCondition("lower(concat_ws(' ', codigo_ml, descricao, ean))", term, params)}`;
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
      return searchTermsMatch([product.codigoMl, product.descricao, product.ean].join(" "), term);
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
  if (!isStandardMlCode(request.codigoMl)) throw new Error("Codigo ML fora do padrao aceito para sugestoes.");

  if (action === "approve") {
    upsertCatalogProduct(db, selectCatalogApprovalPayload(request, options.selectedCheckId));
    db.catalogRequests = (db.catalogRequests || []).filter((item) => item.id !== requestId);
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
          l.tipo_custo as lot__tipo_custo,
          l.percentual_custo as lot__percentual_custo,
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

export async function createLabel(userId, productId, quantity = 1) {
  await ensureStore();
  const labelQuantity = Math.max(1, Math.round(Number(quantity || 1)));
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
          l.tipo_custo as lot__tipo_custo,
          l.percentual_custo as lot__percentual_custo,
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
    const labels = Array.from({ length: labelQuantity }, () => ({
      id: randomUUID(),
      productId: product.id,
      lotId: lot.id,
      userId,
      createdAt: new Date().toISOString()
    }));
    for (const label of labels) {
      await query(
        `insert into labels (id, product_id, lot_id, user_id, created_at)
         values ($1, $2, $3, $4, $5)`,
        [label.id, label.productId, label.lotId, label.userId, label.createdAt]
      );
    }
    return { label: labels[0], labels, product, lot };
  }

  const db = await readDb();
  const product = db.products.find((item) => item.id === productId);
  const lot = product && db.lots.find((item) => item.id === product.lotId && item.userId === userId);
  if (!product || !lot) return null;
  const labels = Array.from({ length: labelQuantity }, () => ({
    id: randomUUID(),
    productId: product.id,
    lotId: lot.id,
    userId,
    createdAt: new Date().toISOString()
  }));
  db.labels.push(...labels);
  await writeDb(db);
  return { label: labels[0], labels, product, lot };
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
      triage_access boolean not null default false,
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
      tipo_custo text not null default 'fixed',
      percentual_custo numeric not null default 0,
      fornecedor text not null,
      prefixo_sku text not null,
      proximo_sequencial_sku integer not null,
      no_sheet_suggestions jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists products (
      id text primary key,
      lot_id text not null references lots(id) on delete cascade,
      created_by_user_id text references users(id) on delete set null,
      operator_user_id text references users(id) on delete set null,
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
      altura_caixa numeric,
      largura_caixa numeric,
      comprimento_caixa numeric,
      peso_caixa numeric,
      localizacao_estoque text not null default '',
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
      altura_caixa numeric,
      largura_caixa numeric,
      comprimento_caixa numeric,
      peso_caixa numeric,
      localizacao_estoque text not null default '',
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

    create table if not exists user_settings (
      user_id text not null references users(id) on delete cascade,
      key text not null,
      value jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (user_id, key)
    );

    create table if not exists transfer_lots (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      name text not null,
      descricao text not null default '',
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
      force_reason text not null default '',
      force_code text not null default '',
      force_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists transfer_forced_occurrences (
      id text primary key,
      transfer_lot_id text not null references transfer_lots(id) on delete cascade,
      transfer_item_id text references transfer_items(id) on delete set null,
      code text not null,
      reason text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists transfer_divergence_reports (
      id text primary key,
      transfer_lot_id text not null references transfer_lots(id) on delete cascade,
      reporter_user_id text references users(id) on delete set null,
      reporter_name text not null default '',
      type text not null,
      code text not null default '',
      description text not null,
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

    create table if not exists operator_invites (
      id text primary key,
      owner_user_id text not null references users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create table if not exists triage_items (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      created_by_user_id text references users(id) on delete set null,
      operator_user_id text references users(id) on delete set null,
      code text not null,
      product_code text not null default '',
      sku text not null default '',
      ean text not null default '',
      asin text not null default '',
      codigo_bling2 text not null default '',
      descricao text not null default '',
      valor_unit numeric not null default 0,
      preco_custo numeric not null default 0,
      serial text not null default '',
      altura_caixa numeric,
      largura_caixa numeric,
      comprimento_caixa numeric,
      peso_caixa numeric,
      status text not null default 'aguardando_teste',
      destination text not null default '',
      diagnosis_condition text not null default '',
      diagnosis text not null default '',
      diagnosis_photo text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      diagnosed_at timestamptz
    );

    create table if not exists triage_events (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      triage_item_id text not null references triage_items(id) on delete cascade,
      code text not null,
      operator_user_id text references users(id) on delete set null,
      destination text not null default '',
      diagnosis_condition text not null default '',
      diagnosis text not null default '',
      diagnosis_photo text not null default '',
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
      altura_caixa numeric,
      largura_caixa numeric,
      comprimento_caixa numeric,
      peso_caixa numeric,
      localizacao_estoque text not null default '',
      scope text not null default 'individual',
      alert_message text not null default '',
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
      altura_caixa numeric,
      largura_caixa numeric,
      comprimento_caixa numeric,
      peso_caixa numeric,
      localizacao_estoque text not null default '',
      scope text not null default 'individual',
      alert_message text not null default '',
      double_checks jsonb not null default '[]'::jsonb,
      created_at timestamptz not null,
      rejected_at timestamptz not null default now()
    );

    alter table users add column if not exists tenant_id text;
    alter table users add column if not exists tenant_name text;
    alter table users add column if not exists parent_user_id text references users(id) on delete cascade;
    alter table users add column if not exists role text not null default 'owner';
    alter table users add column if not exists operator_code integer;
    alter table users add column if not exists triage_access boolean not null default false;
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
    alter table lots add column if not exists tipo_custo text not null default 'fixed';
    alter table lots add column if not exists percentual_custo numeric not null default 0;
    alter table lots add column if not exists no_sheet_suggestions jsonb not null default '[]'::jsonb;
    alter table products add column if not exists ean text not null default '';
    alter table products add column if not exists link text not null default '';
    alter table products add column if not exists foto text not null default '';
    alter table products add column if not exists created_by_user_id text references users(id) on delete set null;
    alter table products add column if not exists operator_user_id text references users(id) on delete set null;
    alter table products add column if not exists altura_caixa numeric;
    alter table products add column if not exists largura_caixa numeric;
    alter table products add column if not exists comprimento_caixa numeric;
    alter table products add column if not exists peso_caixa numeric;
    alter table products add column if not exists localizacao_estoque text not null default '';
    alter table catalog_products add column if not exists ean text not null default '';
    alter table catalog_products add column if not exists link text not null default '';
    alter table catalog_products add column if not exists foto text not null default '';
    alter table catalog_requests add column if not exists ean text not null default '';
    alter table catalog_requests add column if not exists link text not null default '';
    alter table catalog_requests add column if not exists foto text not null default '';
    alter table catalog_requests add column if not exists scope text not null default 'individual';
    alter table catalog_requests add column if not exists alert_message text not null default '';
    alter table catalog_requests add column if not exists double_checks jsonb not null default '[]'::jsonb;
    alter table catalog_requests add column if not exists created_by_user_id text references users(id) on delete set null;
    alter table catalog_requests add column if not exists operator_user_id text references users(id) on delete set null;
    alter table catalog_products add column if not exists altura_caixa numeric;
    alter table catalog_products add column if not exists largura_caixa numeric;
    alter table catalog_products add column if not exists comprimento_caixa numeric;
    alter table catalog_products add column if not exists peso_caixa numeric;
    alter table catalog_products add column if not exists localizacao_estoque text not null default '';
    alter table catalog_requests add column if not exists altura_caixa numeric;
    alter table catalog_requests add column if not exists largura_caixa numeric;
    alter table catalog_requests add column if not exists comprimento_caixa numeric;
    alter table catalog_requests add column if not exists peso_caixa numeric;
    alter table catalog_requests add column if not exists localizacao_estoque text not null default '';
    alter table triage_items add column if not exists diagnosis_photo text not null default '';
    alter table triage_items add column if not exists diagnosis_condition text not null default '';
    alter table triage_events add column if not exists diagnosis_condition text not null default '';
    alter table triage_items add column if not exists altura_caixa numeric;
    alter table triage_items add column if not exists largura_caixa numeric;
    alter table triage_items add column if not exists comprimento_caixa numeric;
    alter table triage_items add column if not exists peso_caixa numeric;
    alter table triage_items add column if not exists valor_unit numeric not null default 0;
    alter table triage_items add column if not exists preco_custo numeric not null default 0;
    create index if not exists triage_events_item_created_idx on triage_events(triage_item_id, created_at desc);
    alter table catalog_rejected_requests add column if not exists created_by_user_id text;
    alter table catalog_rejected_requests add column if not exists operator_user_id text;
    alter table catalog_rejected_requests add column if not exists scope text not null default 'individual';
    alter table catalog_rejected_requests add column if not exists alert_message text not null default '';
    alter table catalog_rejected_requests add column if not exists altura_caixa numeric;
    alter table catalog_rejected_requests add column if not exists largura_caixa numeric;
    alter table catalog_rejected_requests add column if not exists comprimento_caixa numeric;
    alter table catalog_rejected_requests add column if not exists peso_caixa numeric;
    alter table catalog_rejected_requests add column if not exists localizacao_estoque text not null default '';
    alter table transfer_items add column if not exists quantidade_conferida integer not null default 0;
    alter table transfer_items add column if not exists force_reason text not null default '';
    alter table transfer_items add column if not exists force_code text not null default '';
    alter table transfer_items add column if not exists force_at timestamptz;
    alter table transfer_lots add column if not exists descricao text not null default '';
    update catalog_requests set created_by_user_id = user_id where created_by_user_id is null or created_by_user_id = '';
    update catalog_rejected_requests set created_by_user_id = user_id where created_by_user_id is null or created_by_user_id = '';

    alter table products
      alter column valor_unit type numeric using coalesce(nullif(replace(valor_unit::text, ',', '.'), '')::numeric, 0),
      alter column preco_custo type numeric using coalesce(nullif(replace(preco_custo::text, ',', '.'), '')::numeric, 0),
      alter column altura_caixa type numeric using nullif(replace(altura_caixa::text, ',', '.'), '')::numeric,
      alter column largura_caixa type numeric using nullif(replace(largura_caixa::text, ',', '.'), '')::numeric,
      alter column comprimento_caixa type numeric using nullif(replace(comprimento_caixa::text, ',', '.'), '')::numeric,
      alter column peso_caixa type numeric using nullif(replace(peso_caixa::text, ',', '.'), '')::numeric;
    alter table catalog_products
      alter column valor_unit type numeric using coalesce(nullif(replace(valor_unit::text, ',', '.'), '')::numeric, 0),
      alter column preco_custo type numeric using coalesce(nullif(replace(preco_custo::text, ',', '.'), '')::numeric, 0),
      alter column altura_caixa type numeric using nullif(replace(altura_caixa::text, ',', '.'), '')::numeric,
      alter column largura_caixa type numeric using nullif(replace(largura_caixa::text, ',', '.'), '')::numeric,
      alter column comprimento_caixa type numeric using nullif(replace(comprimento_caixa::text, ',', '.'), '')::numeric,
      alter column peso_caixa type numeric using nullif(replace(peso_caixa::text, ',', '.'), '')::numeric;
    alter table catalog_requests
      alter column valor_unit type numeric using coalesce(nullif(replace(valor_unit::text, ',', '.'), '')::numeric, 0),
      alter column preco_custo type numeric using coalesce(nullif(replace(preco_custo::text, ',', '.'), '')::numeric, 0),
      alter column altura_caixa type numeric using nullif(replace(altura_caixa::text, ',', '.'), '')::numeric,
      alter column largura_caixa type numeric using nullif(replace(largura_caixa::text, ',', '.'), '')::numeric,
      alter column comprimento_caixa type numeric using nullif(replace(comprimento_caixa::text, ',', '.'), '')::numeric,
      alter column peso_caixa type numeric using nullif(replace(peso_caixa::text, ',', '.'), '')::numeric;
    alter table catalog_rejected_requests
      alter column valor_unit type numeric using coalesce(nullif(replace(valor_unit::text, ',', '.'), '')::numeric, 0),
      alter column preco_custo type numeric using coalesce(nullif(replace(preco_custo::text, ',', '.'), '')::numeric, 0),
      alter column altura_caixa type numeric using nullif(replace(altura_caixa::text, ',', '.'), '')::numeric,
      alter column largura_caixa type numeric using nullif(replace(largura_caixa::text, ',', '.'), '')::numeric,
      alter column comprimento_caixa type numeric using nullif(replace(comprimento_caixa::text, ',', '.'), '')::numeric,
      alter column peso_caixa type numeric using nullif(replace(peso_caixa::text, ',', '.'), '')::numeric;
    alter table triage_items
      alter column valor_unit type numeric using coalesce(nullif(replace(valor_unit::text, ',', '.'), '')::numeric, 0),
      alter column preco_custo type numeric using coalesce(nullif(replace(preco_custo::text, ',', '.'), '')::numeric, 0),
      alter column altura_caixa type numeric using nullif(replace(altura_caixa::text, ',', '.'), '')::numeric,
      alter column largura_caixa type numeric using nullif(replace(largura_caixa::text, ',', '.'), '')::numeric,
      alter column comprimento_caixa type numeric using nullif(replace(comprimento_caixa::text, ',', '.'), '')::numeric,
      alter column peso_caixa type numeric using nullif(replace(peso_caixa::text, ',', '.'), '')::numeric;

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
    create index if not exists operator_invites_owner_user_id_idx on operator_invites(owner_user_id);
    create index if not exists operator_invites_expires_at_idx on operator_invites(expires_at);
    create unique index if not exists triage_items_user_code_idx on triage_items(user_id, code);
    create index if not exists triage_items_user_status_idx on triage_items(user_id, status);
    create index if not exists triage_items_user_destination_idx on triage_items(user_id, destination);
    create index if not exists triage_items_user_diagnosis_condition_idx on triage_items(user_id, diagnosis_condition);
    create index if not exists transfer_lots_user_id_idx on transfer_lots(user_id);
    create index if not exists transfer_items_transfer_lot_id_idx on transfer_items(transfer_lot_id);
    create index if not exists transfer_items_sku_idx on transfer_items(sku);
    create index if not exists transfer_forced_occurrences_transfer_lot_id_idx on transfer_forced_occurrences(transfer_lot_id);
    create index if not exists transfer_divergence_reports_transfer_lot_id_idx on transfer_divergence_reports(transfer_lot_id);
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
      altura_caixa,
      largura_caixa,
      comprimento_caixa,
      peso_caixa,
      localizacao_estoque,
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
      cr.altura_caixa,
      cr.largura_caixa,
      cr.comprimento_caixa,
      cr.peso_caixa,
      cr.localizacao_estoque,
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
  await backfillPgCatalogLotSuggestions();
}

async function backfillPgCatalogLotSuggestions() {
  const flag = await query("select value from app_settings where key = $1 limit 1", [CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY]);
  if (flag.rows.length) return;
  if (process.env.BACKFILL_CATALOG_LOT_SUGGESTIONS !== "true") {
    await query(
      `insert into app_settings (key, value, updated_at)
       values ($1, $2, now())
       on conflict (key) do nothing`,
      [CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY, { skippedAt: new Date().toISOString(), reason: "disabled_on_startup" }]
    );
    return;
  }

  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    const products = await client.query(`
      select
        p.*,
        l.id as lot__id,
        l.user_id as lot__user_id,
        l.nome_arquivo as lot__nome_arquivo,
        l.percentual_arremate as lot__percentual_arremate,
        l.custo_medio_unitario as lot__custo_medio_unitario,
        l.tipo_custo as lot__tipo_custo,
        l.percentual_custo as lot__percentual_custo,
        l.fornecedor as lot__fornecedor,
        l.prefixo_sku as lot__prefixo_sku,
        l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
        l.created_at as lot__created_at
      from products p
      join lots l on l.id = p.lot_id
      where p.origem = 'planilha'
        and trim(coalesce(p.codigo_ml, '')) <> ''
      order by p.created_at asc
    `);

    for (const row of products.rows) {
      const product = productFromRow(row);
      const lot = lotFromPrefixedRow(row, "lot__");
      await mergePendingCatalogRequestPg(client, await buildLotCatalogRequestPg(client, { userId: lot.userId, lot, product }));
    }

    await client.query(
      `insert into app_settings (key, value, updated_at)
       values ($1, $2, now())
       on conflict (key) do nothing`,
      [CATALOG_LOT_SUGGESTIONS_BACKFILL_KEY, { completedAt: new Date().toISOString(), products: products.rows.length }]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readPgDb() {
  const [users, lots, products, rzItems, scans, labels, blingIntegrations, userSettings, transferLots, transferItems, transferForcedOccurrences, transferDivergenceReports, operatorActivities, triageItems, triageEvents, catalogProducts, catalogRequests, catalogRejectedRequests] = await Promise.all([
    query("select * from users order by created_at asc"),
    query("select * from lots order by created_at asc"),
    query("select * from products order by created_at asc"),
    query("select * from rz_items order by created_at asc"),
    query("select * from scans order by created_at asc"),
    query("select * from labels order by created_at asc"),
    query("select * from bling_integrations order by updated_at asc"),
    query("select * from user_settings order by updated_at asc"),
    query("select * from transfer_lots order by created_at asc"),
    query("select * from transfer_items order by created_at asc"),
    query("select * from transfer_forced_occurrences order by created_at asc"),
    query("select * from transfer_divergence_reports order by created_at asc"),
    query("select * from operator_activities order by created_at asc"),
    query("select * from triage_items order by created_at asc"),
    query("select * from triage_events order by created_at asc"),
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
    userSettings: userSettings.rows.map(userSettingFromRow),
    transferLots: transferLots.rows.map(transferLotFromRow),
    transferItems: transferItems.rows.map(transferItemFromRow),
    transferForcedOccurrences: transferForcedOccurrences.rows.map(transferForcedOccurrenceFromRow),
    transferDivergenceReports: transferDivergenceReports.rows.map(transferDivergenceReportFromRow),
    operatorActivities: operatorActivities.rows.map(operatorActivityFromRow),
    triageItems: triageItems.rows.map(triageItemFromRow),
    triageEvents: triageEvents.rows.map(triageEventFromRow),
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
    await client.query("delete from triage_events");
    await client.query("delete from triage_items");
    await client.query("delete from operator_activities");
    await client.query("delete from transfer_divergence_reports");
    await client.query("delete from transfer_forced_occurrences");
    await client.query("delete from transfer_items");
    await client.query("delete from transfer_lots");
    await client.query("delete from bling_integrations");
    await client.query("delete from user_settings");
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
      ["id", "tenant_id", "tenant_name", "parent_user_id", "role", "operator_code", "triage_access", "name", "email", "password_hash", "created_at"],
      (db.users || []).map((user) => [
        user.id,
        user.tenantId || user.id,
        user.tenantName || user.name,
        user.parentUserId || null,
        user.role || (user.parentUserId ? "operator" : "owner"),
        optionalInt(user.operatorCode) || null,
        Boolean(user.triageAccess),
        user.name,
        user.email,
        user.passwordHash,
        user.createdAt
      ])
    );
    await insertRows(
      client,
      "user_settings",
      ["user_id", "key", "value", "created_at", "updated_at"],
      (db.userSettings || []).map((setting) => [
        setting.userId,
        setting.key,
        setting.value || {},
        setting.createdAt || setting.updatedAt || new Date().toISOString(),
        setting.updatedAt || setting.createdAt || new Date().toISOString()
      ])
    );
    await insertRows(
      client,
      "lots",
      ["id", "user_id", "nome_arquivo", "percentual_arremate", "custo_medio_unitario", "tipo_custo", "percentual_custo", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "created_at"],
      (db.lots || []).map((lot) => [
        lot.id,
        lot.userId,
        lot.nomeArquivo,
        lot.percentualArremate,
        lot.custoMedioUnitario || 0,
        lot.tipoCusto || "fixed",
        lot.percentualCusto || 0,
        lot.fornecedor,
        lot.prefixoSku,
        optionalInt(lot.proximoSequencialSku),
        lot.createdAt
      ])
    );
    await insertRows(
      client,
      "products",
      ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "ean", "link", "foto", "altura_caixa", "largura_caixa", "comprimento_caixa", "peso_caixa", "localizacao_estoque", "origem", "created_at"],
      (db.products || []).map((product) => [
        product.id,
        product.lotId,
        product.codigoMl,
        product.sku,
        product.descricao,
        product.valorUnit,
        product.precoCusto,
        requiredInt(product.qtdTotal),
        product.categoria || "",
        product.subcategoria || "",
        product.ean || "",
        product.link || "",
        product.foto || "",
        product.alturaCaixa || null,
        product.larguraCaixa || null,
        product.comprimentoCaixa || null,
        product.pesoCaixa || null,
        product.localizacaoEstoque || "",
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
        requiredInt(item.qtdEsperada),
        requiredInt(item.qtdConferida),
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
    await insertTransferForcedOccurrenceRows(client, db.transferForcedOccurrences || []);
    await insertTransferDivergenceReportRows(client, db.transferDivergenceReports || []);
    await insertOperatorActivityRows(client, db.operatorActivities || []);
    await insertTriageItemRows(client, db.triageItems || []);
    await insertTriageEventRows(client, db.triageEvents || []);
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
  const [products, rzItems, scans, users] = await Promise.all([
    query("select * from products where lot_id = any($1::text[]) order by created_at asc", [lotIds]),
    query("select * from rz_items where lot_id = any($1::text[]) order by created_at asc", [lotIds]),
    query("select * from scans where lot_id = any($1::text[]) order by created_at asc", [lotIds]),
    query(
      "select id, name, email, tenant_name, parent_user_id, role, operator_code, created_at from users where id = $1 or parent_user_id = $1",
      [userId]
    )
  ]);

  return {
    ...emptyDb(),
    users: users.rows.map(userFromRow),
    lots,
    products: products.rows.map(productFromRow),
    rzItems: rzItems.rows.map(rzItemFromRow),
    scans: scans.rows.map(scanFromRow)
  };
}

async function insertLotRows(client, { lots = [], products = [], rzItems = [] }) {
  await insertRows(
    client,
    "lots",
    ["id", "user_id", "nome_arquivo", "percentual_arremate", "custo_medio_unitario", "tipo_custo", "percentual_custo", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "no_sheet_suggestions", "created_at"],
    lots.map((lot) => [
      lot.id,
      lot.userId,
      lot.nomeArquivo,
      lot.percentualArremate,
      lot.custoMedioUnitario || 0,
      lot.tipoCusto || "fixed",
      lot.percentualCusto || 0,
      lot.fornecedor,
      lot.prefixoSku,
      lot.proximoSequencialSku,
      JSON.stringify(normalizeNoSheetSuggestions(lot.noSheetSuggestions)),
      lot.createdAt
    ])
  );
  await insertRows(
    client,
    "products",
    ["id", "lot_id", "created_by_user_id", "operator_user_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "ean", "link", "foto", "altura_caixa", "largura_caixa", "comprimento_caixa", "peso_caixa", "localizacao_estoque", "origem", "created_at"],
    products.map((product) => [
      product.id,
      product.lotId,
      product.createdByUserId || null,
      product.operatorUserId || null,
      product.codigoMl,
      product.sku,
      product.descricao,
      product.valorUnit,
      product.precoCusto,
      requiredInt(product.qtdTotal),
      product.categoria || "",
      product.subcategoria || "",
      product.ean || "",
      product.link || "",
      product.foto || "",
      product.alturaCaixa || null,
      product.larguraCaixa || null,
      product.comprimentoCaixa || null,
      product.pesoCaixa || null,
      product.localizacaoEstoque || "",
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
      requiredInt(item.qtdEsperada),
      requiredInt(item.qtdConferida),
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
    ["id", "codigo_ml", "descricao", "valor_unit", "preco_custo", "categoria", "subcategoria", "ean", "link", "foto", "altura_caixa", "largura_caixa", "comprimento_caixa", "peso_caixa", "localizacao_estoque", "created_at", "updated_at"],
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
      product.alturaCaixa || null,
      product.larguraCaixa || null,
      product.comprimentoCaixa || null,
      product.pesoCaixa || null,
      product.localizacaoEstoque || "",
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
    ["id", "user_id", "name", "descricao", "deposito_origem", "deposito_destino", "status", "created_by_user_id", "created_at", "synced_at"],
    lots.map((lot) => [
      lot.id,
      lot.userId,
      lot.name,
      lot.descricao || "",
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
    ["id", "transfer_lot_id", "source_lot_id", "product_id", "codigo_ml", "sku", "descricao", "ean", "quantidade", "quantidade_conferida", "force_reason", "force_code", "force_at", "created_at"],
    items.map((item) => [
      item.id,
      item.transferLotId,
      item.sourceLotId || null,
      item.productId || null,
      item.codigoMl,
      item.sku,
      item.descricao,
      item.ean || "",
      requiredInt(item.quantidade),
      requiredInt(item.quantidadeConferida),
      item.forceReason || "",
      item.forceCode || "",
      item.forceAt || null,
      item.createdAt
    ])
  );
}

async function insertTransferForcedOccurrenceRows(client, occurrences = []) {
  const target = client || { query };
  await insertRows(
    target,
    "transfer_forced_occurrences",
    ["id", "transfer_lot_id", "transfer_item_id", "code", "reason", "created_at"],
    occurrences.map((occurrence) => [
      occurrence.id,
      occurrence.transferLotId,
      occurrence.itemId || null,
      occurrence.code,
      occurrence.reason,
      occurrence.createdAt
    ])
  );
}

async function insertTransferDivergenceReportRows(client, reports = []) {
  const target = client || { query };
  await insertRows(
    target,
    "transfer_divergence_reports",
    ["id", "transfer_lot_id", "reporter_user_id", "reporter_name", "type", "code", "description", "created_at"],
    reports.map((report) => [
      report.id,
      report.transferLotId,
      report.reporterUserId || null,
      report.reporterName || "",
      report.type,
      report.code || "",
      report.description,
      report.createdAt
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

async function insertTriageItemRows(client, items = []) {
  const target = client || { query };
  await insertRows(
    target,
    "triage_items",
    [
      "id",
      "user_id",
      "created_by_user_id",
      "operator_user_id",
      "code",
      "product_code",
      "sku",
      "ean",
      "asin",
      "codigo_bling2",
      "descricao",
      "valor_unit",
      "preco_custo",
      "serial",
      "altura_caixa",
      "largura_caixa",
      "comprimento_caixa",
      "peso_caixa",
      "status",
      "destination",
      "diagnosis_condition",
      "diagnosis",
      "diagnosis_photo",
      "created_at",
      "updated_at",
      "diagnosed_at"
    ],
    items.map((item) => [
      item.id,
      item.userId,
      item.createdByUserId || item.userId,
      item.operatorUserId || null,
      item.code,
      item.productCode || "",
      item.sku || "",
      item.ean || "",
      item.asin || "",
      item.codigoBling2 || "",
      item.descricao || "",
      item.valorUnit || 0,
      item.precoCusto || 0,
      item.serial || "",
      item.alturaCaixa || null,
      item.larguraCaixa || null,
      item.comprimentoCaixa || null,
      item.pesoCaixa || null,
      item.status || "aguardando_teste",
      item.destination || "",
      item.diagnosisCondition || "",
      item.diagnosis || "",
      item.diagnosisPhoto || "",
      item.createdAt,
      item.updatedAt || item.createdAt,
      item.diagnosedAt || null
    ])
  );
}

async function insertTriageEventRows(client, events = []) {
  const target = client || { query };
  await insertRows(
    target,
    "triage_events",
    ["id", "user_id", "triage_item_id", "code", "operator_user_id", "destination", "diagnosis_condition", "diagnosis", "diagnosis_photo", "created_at"],
    events.map((event) => [
      event.id,
      event.userId,
      event.triageItemId,
      event.code || "",
      event.operatorUserId || null,
      event.destination || "",
      event.diagnosisCondition || "",
      event.diagnosis || "",
      event.diagnosisPhoto || "",
      event.createdAt
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
      "altura_caixa",
      "largura_caixa",
      "comprimento_caixa",
      "peso_caixa",
      "localizacao_estoque",
      "scope",
      "alert_message",
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
      request.alturaCaixa || null,
      request.larguraCaixa || null,
      request.comprimentoCaixa || null,
      request.pesoCaixa || null,
      request.localizacaoEstoque || "",
      request.scope || "individual",
      request.alertMessage || "",
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
      "altura_caixa",
      "largura_caixa",
      "comprimento_caixa",
      "peso_caixa",
      "localizacao_estoque",
      "scope",
      "alert_message",
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
      request.alturaCaixa || null,
      request.larguraCaixa || null,
      request.comprimentoCaixa || null,
      request.pesoCaixa || null,
      request.localizacaoEstoque || "",
      request.scope || "individual",
      request.alertMessage || "",
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
          p.sku as product_sku,
          p.origem as product_origem
        from rz_items ri
        join products p on p.id = ri.product_id
        where ri.lot_id = $1
          and ri.codigo_rz = $2
          and (
            upper(trim(p.codigo_ml)) = upper(trim($3))
            or upper(trim(p.sku)) = upper(trim($3))
            or regexp_replace(upper(trim(p.sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($3))
          )
        order by ri.created_at asc
        for update of ri
      `,
      [lot.id, codigoRz, codigoMl]
    );

    ensureUnambiguousPgScanRows(sameRzResult.rows);
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
      const sameLotProduct = await client.query(
        `
          select id
          from products
          where lot_id = $1
            and (
              upper(trim(codigo_ml)) = upper(trim($2))
              or upper(trim(sku)) = upper(trim($2))
              or regexp_replace(upper(trim(sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($2))
            )
        `,
        [lot.id, codigoMl]
      );
      ensureUnambiguousPgScanRows(sameLotProduct.rows);
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

async function splitLotProductPg({ userId, lotId, productId, codigoRz, kitQuantity, sellableQuantity, descricao }) {
  const client = await getPgPool().connect();
  let product;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nao encontrado.");

    const productResult = await client.query("select * from products where id = $1 and lot_id = $2 for update", [productId, lot.id]);
    const current = productResult.rows[0] && productFromRow(productResult.rows[0]);
    if (!current) throw notFound("Produto nao encontrado neste lote.");

    const itemResult = await client.query(
      "select * from rz_items where lot_id = $1 and product_id = $2 and codigo_rz = $3 for update",
      [lot.id, current.id, codigoRz]
    );
    const item = itemResult.rows[0];
    if (!item) throw notFound("Item nao encontrado nesta RZ.");

    const split = calculateSplitProductValues(current, rzItemFromRow(item), { kitQuantity, sellableQuantity, descricao });
    const updatedProduct = await client.query(
      `update products
       set descricao = $3,
           valor_unit = $4,
           preco_custo = $5,
           qtd_total = $6
       where id = $1 and lot_id = $2
       returning *`,
      [current.id, lot.id, split.descricao, split.valorUnit, split.precoCusto, split.qtdTotal]
    );
    product = productFromRow(updatedProduct.rows[0]);

    await client.query(
      `update rz_items
       set qtd_esperada = $4,
           qtd_conferida = least(qtd_conferida, $4),
           valor_total = $5,
           tipo_item = $6
       where lot_id = $1 and product_id = $2 and codigo_rz = $3`,
      [lot.id, current.id, codigoRz, sellableQuantity, split.valorTotal, splitItemType(item.tipo_item)]
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
          p.codigo_ml as product_codigo_ml,
          p.sku as product_sku,
          p.origem as product_origem
        from rz_items ri
        join products p on p.id = ri.product_id
        where ri.lot_id = $1
          and ri.codigo_rz = $2
          and (
            upper(trim(p.codigo_ml)) = upper(trim($3))
            or upper(trim(p.sku)) = upper(trim($3))
            or regexp_replace(upper(trim(p.sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($3))
          )
        order by ri.created_at asc
        for update of ri
      `,
      [lot.id, codigoRz, codigoMl]
    );

    ensureUnambiguousPgScanRows(sameRzResult.rows);
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
    const records = buildExternalExcessRecords(lot, source, codigoRz, codigoMl, { createdByUserId, operatorUserId });
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
        const records = buildDiverseLotRecords(lot, source, codigoMl, codigoRz, { origem: "lote_sem_planilha_manual", createdByUserId, operatorUserId });
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

      const records = buildDiverseLotRecords(lot, history, codigoMl, codigoRz, { valorUnitOverride, createdByUserId, operatorUserId });
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

async function scanTransferLotPg({ userId, transferLotId, code, externalProduct = null }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote de transferencia nao encontrado.");
    if (lot.status === "synced") throw new Error("Este lote ja foi enviado ao Bling.");

    const product = await findPgTransferProduct(client, userId, code) || externalProduct;
    if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
    const itemResult = product.id
      ? await client.query("select * from transfer_items where transfer_lot_id = $1 and product_id = $2 limit 1 for update", [lot.id, product.id])
      : await client.query(
        `select * from transfer_items
         where transfer_lot_id = $1
           and product_id is null
           and (
             upper(trim(codigo_ml)) = upper(trim($2))
             or upper(trim(sku)) = upper(trim($2))
             or regexp_replace(upper(trim(sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($2))
             or upper(trim(ean)) = upper(trim($2))
           )
         limit 1 for update`,
        [lot.id, code]
      );
    const existing = itemResult.rows[0] && transferItemFromRow(itemResult.rows[0]);
    const now = new Date().toISOString();
    if (existing) {
      await client.query("update transfer_items set quantidade = quantidade + 1, created_at = $2 where id = $1", [existing.id, now]);
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

async function receiveTransferLotScanPg({ userId, transferLotId, code }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = userId
      ? await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [transferLotId, userId])
      : await client.query("select * from transfer_lots where id = $1 limit 1 for update", [transferLotId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
    if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
    if (lot.status === "open") throw new Error("A remessa ainda nao foi liberada pelo CD.");

    const itemResult = await client.query(
      `select * from transfer_items
       where transfer_lot_id = $1
         and (
           upper(trim(codigo_ml)) = upper(trim($2))
           or upper(trim(sku)) = upper(trim($2))
           or regexp_replace(upper(trim(sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($2))
           or upper(trim(ean)) = upper(trim($2))
         )
       order by case when quantidade_conferida < quantidade then 0 else 1 end, created_at asc
       limit 1 for update`,
      [lot.id, code]
    );
    if (!itemResult.rows.length) throw notFound("Produto nao previsto nesta remessa.");

    const item = transferItemFromRow(itemResult.rows[0]);
    if (Number(item.quantidadeConferida || 0) >= Number(item.quantidade || 0)) throw new Error("Produto ja conferido nesta remessa.");
    const nextReceived = Number(item.quantidadeConferida || 0) + 1;
    const now = new Date().toISOString();
    await client.query("update transfer_items set quantidade_conferida = $2, created_at = $3 where id = $1", [item.id, nextReceived, now]);

    const itemsResult = await client.query("select * from transfer_items where transfer_lot_id = $1", [lot.id]);
    const items = itemsResult.rows.map((row) => row.id === item.id ? { ...transferItemFromRow(row), quantidadeConferida: nextReceived, createdAt: now } : transferItemFromRow(row));
    updateTransferLotReceivingStatus(lot, items);
    await client.query("update transfer_lots set status = $2 where id = $1", [lot.id, lot.status]);
    result = { status: nextReceived > Number(item.quantidade || 0) ? "over" : "received", item: { ...item, quantidadeConferida: nextReceived, createdAt: now } };
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: userId ? await getTransferLotDetail(userId, transferLotId) : await getPublicTransferLotDetail(transferLotId) };
}

async function forceReceiveTransferLotScanPg({ transferLotId, code, reason }) {
  const client = await getPgPool().connect();
  let result;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from transfer_lots where id = $1 limit 1 for update", [transferLotId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
    if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
    if (lot.status === "open") throw new Error("A remessa ainda nao foi liberada pelo CD.");

    const product = await findPgTransferProduct(client, lot.userId, code);
    if (!product) throw notFound("Produto nao encontrado nos lotes deste usuario.");
    const existingResult = await client.query(
      "select * from transfer_items where transfer_lot_id = $1 and product_id = $2 for update",
      [lot.id, product.id]
    );
    const existingItems = existingResult.rows.map(transferItemFromRow);
    if (existingItems.some((item) => Number(item.quantidade || 0) > 0)) throw new Error("Produto previsto na remessa. Use a conferencia normal.");

    const now = new Date().toISOString();
    let item = existingItems.find((candidate) => Number(candidate.quantidade || 0) === 0);
    if (item) {
      const nextReceived = Number(item.quantidadeConferida || 0) + 1;
      await client.query(
        "update transfer_items set quantidade_conferida = $2, force_reason = $3, force_code = $4, force_at = $5, created_at = $5 where id = $1",
        [item.id, nextReceived, reason, code, now]
      );
      item = { ...item, quantidadeConferida: nextReceived, forceReason: reason, forceCode: code, forceAt: now };
    } else {
      item = {
        ...buildTransferItem(lot.id, product),
        quantidade: 0,
        quantidadeConferida: 1,
        forceReason: reason,
        forceCode: code,
        forceAt: now
      };
      await insertTransferItemRows(client, [item]);
    }
    const occurrence = buildForcedTransferOccurrence({ transferLotId: lot.id, itemId: item.id, code, reason, createdAt: now });
    await insertTransferForcedOccurrenceRows(client, [occurrence]);

    const itemsResult = await client.query("select * from transfer_items where transfer_lot_id = $1", [lot.id]);
    updateTransferLotReceivingStatus(lot, itemsResult.rows.map(transferItemFromRow));
    await client.query("update transfer_lots set status = $2 where id = $1", [lot.id, lot.status]);
    result = { status: "forced", item, occurrence };
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getPublicTransferLotDetail(transferLotId) };
}

async function reportTransferLotDivergencePg({ userId = null, report }) {
  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    const lotResult = userId
      ? await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [report.transferLotId, userId])
      : await client.query("select * from transfer_lots where id = $1 limit 1 for update", [report.transferLotId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Remessa de transferencia nao encontrada.");
    if (lot.status === "synced") throw new Error("Esta transferencia ja foi enviada ao Bling.");
    await insertTransferDivergenceReportRows(client, [report]);
    await client.query("update transfer_lots set status = 'divergent' where id = $1", [lot.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return {
    report,
    lot: userId ? await getTransferLotDetail(userId, report.transferLotId) : await getPublicTransferLotDetail(report.transferLotId)
  };
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

async function deleteTransferLotItemPg({ userId, transferLotId, itemId }) {
  const client = await getPgPool().connect();
  let result = {};
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from transfer_lots where id = $1 and user_id = $2 limit 1 for update", [transferLotId, userId]);
    const lot = lotResult.rows[0] && transferLotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote de transferencia nao encontrado.");
    if (lot.status !== "open") throw new Error("So e possivel excluir itens enquanto o CD esta montando a remessa.");
    const item = await client.query("delete from transfer_items where id = $1 and transfer_lot_id = $2 returning *", [itemId, lot.id]);
    if (!item.rows.length) throw notFound("Item nao encontrado no lote.");
    result = { item: transferItemFromRow(item.rows[0]) };
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getTransferLotDetail(userId, transferLotId) };
}

async function deleteLotRzItemPg({ userId, lotId, codigoRz, itemId }) {
  const client = await getPgPool().connect();
  let result = {};
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote nao encontrado.");

    const itemResult = await client.query(
      `select
         ri.*,
         p.codigo_ml as product_codigo_ml,
         p.sku as product_sku,
         p.descricao as product_descricao
       from rz_items ri
       join products p on p.id = ri.product_id
       where ri.id = $1
         and ri.lot_id = $2
         and ri.codigo_rz = $3
       limit 1
       for update of ri`,
      [itemId, lot.id, codigoRz]
    );
    const item = itemResult.rows[0];
    if (!item) throw notFound("Item nao encontrado nesta RZ.");

    await client.query("delete from rz_items where lot_id = $1 and codigo_rz = $2 and product_id = $3", [lot.id, codigoRz, item.product_id]);
    const remaining = await client.query("select 1 from rz_items where product_id = $1 limit 1", [item.product_id]);
    if (!remaining.rows.length) await client.query("delete from products where id = $1 and lot_id = $2", [item.product_id, lot.id]);
    await client.query(
      `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), lot.id, codigoRz, item.product_codigo_ml || "", "item_excluido", null, new Date().toISOString()]
    );
    result = {
      item: {
        ...rzItemFromRow(item),
        product: {
          codigoMl: item.product_codigo_ml || "",
          sku: item.product_sku || "",
          descricao: item.product_descricao || ""
        }
      }
    };
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, lot: await getUserLotDetail(userId, lotId) };
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
        l.tipo_custo as lot__tipo_custo,
        l.percentual_custo as lot__percentual_custo,
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
        and (
          upper(trim(p.codigo_ml)) = upper(trim($2))
          or upper(trim(p.sku)) = upper(trim($2))
          or regexp_replace(upper(trim(p.sku)), '[^0-9A-Z .$/+%-]', '-', 'g') = upper(trim($2))
          or upper(trim(p.ean)) = upper(trim($2))
        )
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
        l.tipo_custo as lot__tipo_custo,
        l.percentual_custo as lot__percentual_custo,
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
    if (!isStandardMlCode(request.codigoMl)) throw new Error("Codigo ML fora do padrao aceito para sugestoes.");

    if (action === "approve") {
      const selected = selectCatalogApprovalPayload(request, options.selectedCheckId);
      await client.query(
        `
          insert into catalog_products (id, codigo_ml, descricao, valor_unit, preco_custo, categoria, subcategoria, ean, link, foto, altura_caixa, largura_caixa, comprimento_caixa, peso_caixa, localizacao_estoque, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now())
          on conflict (codigo_ml) do update set
            descricao = excluded.descricao,
            valor_unit = excluded.valor_unit,
            preco_custo = excluded.preco_custo,
            categoria = excluded.categoria,
            subcategoria = excluded.subcategoria,
            ean = excluded.ean,
            link = excluded.link,
            foto = excluded.foto,
            altura_caixa = excluded.altura_caixa,
            largura_caixa = excluded.largura_caixa,
            comprimento_caixa = excluded.comprimento_caixa,
            peso_caixa = excluded.peso_caixa,
            localizacao_estoque = excluded.localizacao_estoque,
            updated_at = now()
        `,
        [randomUUID(), selected.codigoMl, selected.descricao, selected.valorUnit, selected.precoCusto || 0, selected.categoria || "", selected.subcategoria || "", selected.ean || "", selected.link || "", selected.foto || "", selected.alturaCaixa || null, selected.larguraCaixa || null, selected.comprimentoCaixa || null, selected.pesoCaixa || null, selected.localizacaoEstoque || ""]
      );
      await client.query("delete from catalog_requests where id = $1", [requestId]);
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
    createdByUserId: options.createdByUserId || null,
    operatorUserId: options.operatorUserId || null,
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
    alturaCaixa: history.alturaCaixa || "",
    larguraCaixa: history.larguraCaixa || "",
    comprimentoCaixa: history.comprimentoCaixa || "",
    pesoCaixa: history.pesoCaixa || "",
    localizacaoEstoque: history.localizacaoEstoque || "",
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
  const valorUnit = decimalMoney(options.valorUnitOverride === undefined || options.valorUnitOverride === "" ? history.valorUnit : options.valorUnitOverride);
  const product = {
    id: randomUUID(),
    lotId: lot.id,
    createdByUserId: options.createdByUserId || null,
    operatorUserId: options.operatorUserId || null,
    codigoMl,
    sku: formatSku(lot.prefixoSku, lot.proximoSequencialSku),
    descricao: history.descricao,
    valorUnit,
    precoCusto: noSheetProductCost(lot, history, valorUnit),
    qtdTotal: 1,
    categoria: history.categoria || "",
    subcategoria: history.subcategoria || "",
    ean: history.ean || "",
    link: history.link || "",
    foto: history.foto || "",
    alturaCaixa: history.alturaCaixa || "",
    larguraCaixa: history.larguraCaixa || "",
    comprimentoCaixa: history.comprimentoCaixa || "",
    pesoCaixa: history.pesoCaixa || "",
    localizacaoEstoque: history.localizacaoEstoque || "",
    origem: options.origem || "lote_sem_planilha",
    createdAt: new Date().toISOString()
  };
  const item = buildDiverseRzItem(lot, product, codigoRz);
  return { product, item };
}

function noSheetProductCost(lot, history, valorUnit) {
  if (lot?.tipoCusto === "variable") {
    return roundMoney(Number(valorUnit || 0) * (Number(lot.percentualCusto || 0) / 100));
  }
  return roundMoney(Number(lot?.custoMedioUnitario || history?.precoCusto || 0));
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

function normalizeNoSheetSuggestions(input) {
  const parsed = typeof input === "string" ? safeParseJsonArray(input) : input;
  const seen = new Set();
  const suggestions = [];
  for (const item of parsed || []) {
    const descricao = String(item?.descricao ?? item?.nome ?? item ?? "").trim();
    if (!descricao) continue;
    const key = normalizeSearchText(descricao);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      id: String(item?.id || key).slice(0, 120),
      descricao
    });
  }
  return suggestions.slice(0, 1000);
}

function safeParseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function productSuggestionFromProduct(product) {
  return {
    id: product.id,
    source: "historico",
    codigoMl: product.codigoMl || "",
    descricao: product.descricao || "",
    valorUnit: product.valorUnit || 0,
    precoCusto: product.precoCusto || 0,
    categoria: product.categoria || "",
    subcategoria: product.subcategoria || "",
    ean: product.ean || "",
    link: product.link || "",
    foto: product.foto || "",
    alturaCaixa: product.alturaCaixa || "",
    larguraCaixa: product.larguraCaixa || "",
    comprimentoCaixa: product.comprimentoCaixa || "",
    pesoCaixa: product.pesoCaixa || "",
    localizacaoEstoque: product.localizacaoEstoque || ""
  };
}

function normalizeManualProduct(input = {}, codigoMl) {
  const descricao = String(input.descricao || input.nome || "").trim();
  const valorUnit = decimalMoney(input.valorUnit ?? input.preco);
  const foto = input.foto ?? input.photo ?? input.image ?? input.imagem ?? input.urlFoto ?? input.urlImagem ?? input.imageUrl ?? "";
  if (!descricao) throw new Error("Informe o nome/descricao do produto.");
  if (!Number.isFinite(valorUnit) || valorUnit <= 0) throw new Error("Informe o preco de venda do produto.");
  return {
    codigoMl: normalizeCode(codigoMl),
    descricao,
    valorUnit,
    categoria: String(input.categoria || "").trim(),
    subcategoria: String(input.subcategoria || "").trim(),
    ean: String(input.ean || "").trim(),
    link: String(input.link || "").trim(),
    foto: String(foto || "").trim(),
    alturaCaixa: optionalNum(input.alturaCaixa ?? input.altura_caixa ?? input.altura),
    larguraCaixa: optionalNum(input.larguraCaixa ?? input.largura_caixa ?? input.largura),
    comprimentoCaixa: optionalNum(input.comprimentoCaixa ?? input.comprimento_caixa ?? input.comprimento ?? input.profundidade),
    pesoCaixa: optionalNum(input.pesoCaixa ?? input.peso_caixa ?? input.peso),
    localizacaoEstoque: String(input.localizacaoEstoque ?? input.localizacao_estoque ?? input.localizacao ?? "").trim()
  };
}

function normalizeEditableProduct(input = {}) {
  const descricao = String(input.descricao || input.nome || "").trim();
  const valorUnit = decimalMoney(input.valorUnit ?? input.preco);
  const precoCusto = decimalMoney(input.precoCusto ?? input.custo);
  const foto = input.foto ?? input.photo ?? input.image ?? input.imagem ?? input.urlFoto ?? input.urlImagem ?? input.imageUrl ?? "";
  if (!descricao) throw new Error("Informe o nome/descricao do produto.");
  if (!Number.isFinite(valorUnit) || valorUnit <= 0) throw new Error("Informe o preco de venda do produto.");
  if (!Number.isFinite(precoCusto) || precoCusto < 0) throw new Error("Informe um custo valido.");
  return {
    descricao,
    valorUnit,
    precoCusto,
    ean: String(input.ean || "").trim(),
    link: String(input.link || "").trim(),
    foto: String(foto || "").trim(),
    alturaCaixa: optionalNum(input.alturaCaixa ?? input.altura_caixa ?? input.altura),
    larguraCaixa: optionalNum(input.larguraCaixa ?? input.largura_caixa ?? input.largura),
    comprimentoCaixa: optionalNum(input.comprimentoCaixa ?? input.comprimento_caixa ?? input.comprimento ?? input.profundidade),
    pesoCaixa: optionalNum(input.pesoCaixa ?? input.peso_caixa ?? input.peso),
    localizacaoEstoque: String(input.localizacaoEstoque ?? input.localizacao_estoque ?? input.localizacao ?? "").trim()
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
    alturaCaixa: optionalNum(payload.alturaCaixa ?? product.alturaCaixa),
    larguraCaixa: optionalNum(payload.larguraCaixa ?? product.larguraCaixa),
    comprimentoCaixa: optionalNum(payload.comprimentoCaixa ?? product.comprimentoCaixa),
    pesoCaixa: optionalNum(payload.pesoCaixa ?? product.pesoCaixa),
    localizacaoEstoque: String(payload.localizacaoEstoque ?? product.localizacaoEstoque ?? "").trim(),
    scope: payload.scope || "individual",
    alertMessage: payload.alertMessage || "",
    createdAt: new Date().toISOString(),
    reviewedAt: null
  };
}

function buildLotCatalogRequest(db, { userId, lot, product }) {
  const existing = findCatalogProduct(db, product.codigoMl);
  return buildCatalogRequest({
    userId,
    lot,
    product,
    type: "create",
    payload: {
      ...product,
      scope: "lot",
      alertMessage: existing ? `Codigo ML ja cadastrado previamente no banco historico: ${existing.descricao || existing.codigoMl}.` : ""
    }
  });
}

async function buildLotCatalogRequestPg(client, { userId, lot, product }) {
  const existing = await findPgCatalogProduct(client, product.codigoMl);
  return buildCatalogRequest({
    userId,
    lot,
    product,
    type: "create",
    payload: {
      ...product,
      scope: "lot",
      alertMessage: existing ? `Codigo ML ja cadastrado previamente no banco historico: ${existing.descricao || existing.codigoMl}.` : ""
    }
  });
}

export function mergePendingCatalogRequest(requests, request) {
  if (!isStandardMlCode(request.codigoMl)) return null;

  const target = findMergeableCatalogRequest(requests, request);
  if (!target) {
    request.doubleChecks = normalizeDoubleChecks(request.doubleChecks);
    requests.push(request);
    return request;
  }

  const promoteToLot = (request.scope || "individual") === "lot";
  const shouldForceLotDoubleCheck = promoteToLot && (target.scope || "individual") !== "lot";
  if ((request.scope || "individual") === "lot") {
    target.scope = "lot";
    if (request.alertMessage) target.alertMessage = request.alertMessage;
  }

  if (catalogRequestHasUserCheck(target, catalogRequestActorId(request)) && !shouldForceLotDoubleCheck) return target;

  target.doubleChecks = [...normalizeDoubleChecks(target.doubleChecks), buildCatalogDoubleCheck(request)];
  return target;
}

async function mergePendingCatalogRequestPg(client, request) {
  if (!isStandardMlCode(request.codigoMl)) return null;

  const mergeable = request.type === "create"
    ? await client.query(
        `
          select id, user_id, created_by_user_id, operator_user_id, scope, double_checks
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

  const mergeableRequest = catalogRequestFromRow(mergeable.rows[0]);
  const shouldForceLotDoubleCheck = (request.scope || "individual") === "lot" && mergeableRequest.scope !== "lot";
  if (catalogRequestHasUserCheck(mergeableRequest, catalogRequestActorId(request)) && !shouldForceLotDoubleCheck) {
    if ((request.scope || "individual") === "lot") {
      await promoteCatalogRequestToLotScopePg(client, mergeable.rows[0].id, request.alertMessage || "");
    }
    return { ...request, id: mergeable.rows[0].id };
  }

  const check = buildCatalogDoubleCheck(request);
  await client.query(
    `
      update catalog_requests
      set
        double_checks = coalesce(double_checks, '[]'::jsonb) || $2::jsonb,
        scope = case when $3 = 'lot' then 'lot' else scope end,
        alert_message = case when $3 = 'lot' and $4 <> '' then $4 else alert_message end
      where id = $1
    `,
    [mergeable.rows[0].id, JSON.stringify([check]), request.scope || "individual", request.alertMessage || ""]
  );
  return { ...request, id: mergeable.rows[0].id };
}

async function promoteCatalogRequestToLotScopePg(client, requestId, alertMessage = "") {
  await client.query(
    `
      update catalog_requests
      set
        scope = 'lot',
        alert_message = case when $2 <> '' then $2 else alert_message end
      where id = $1
    `,
    [requestId, alertMessage]
  );
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
    alturaCaixa: request.alturaCaixa || "",
    larguraCaixa: request.larguraCaixa || "",
    comprimentoCaixa: request.comprimentoCaixa || "",
    pesoCaixa: request.pesoCaixa || "",
    localizacaoEstoque: request.localizacaoEstoque || "",
    scope: request.scope || "individual",
    alertMessage: request.alertMessage || "",
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
    alturaCaixa: request.alturaCaixa || "",
    larguraCaixa: request.larguraCaixa || "",
    comprimentoCaixa: request.comprimentoCaixa || "",
    pesoCaixa: request.pesoCaixa || "",
    localizacaoEstoque: request.localizacaoEstoque || "",
    scope: request.scope || "individual",
    alertMessage: request.alertMessage || "",
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

function splitProductDescription(description, kitQuantity, sellableQuantity) {
  const base = String(description || "").trim();
  const suffix = `unitario do kit ${kitQuantity} pecas (${sellableQuantity} vendaveis)`;
  if (!base) return suffix;
  if (base.toLowerCase().includes("unitario do kit")) return base;
  return `${base} - ${suffix}`;
}

function splitItemType(type) {
  return type === "excedente_outro_rz" ? "esperado" : type || "esperado";
}

function upsertCatalogProduct(db, request) {
  const now = new Date().toISOString();
  const codigoMl = normalizeCode(request.codigoMl);
  if (!isStandardMlCode(codigoMl)) throw new Error("Codigo ML fora do padrao aceito para sugestoes.");
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
    alturaCaixa: request.alturaCaixa || "",
    larguraCaixa: request.larguraCaixa || "",
    comprimentoCaixa: request.comprimentoCaixa || "",
    pesoCaixa: request.pesoCaixa || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (existing) Object.assign(existing, record);
  else db.catalogProducts.push(record);
}

function getUserLotFromDb(db, userId, lotId) {
  return db.lots.find((lot) => lot.id === lotId && lot.userId === userId);
}

function summarizeTransferLots(lots, items, reports = []) {
  return lots.map((lot) => summarizeTransferLot(lot, items, reports));
}

function summarizeTransferLot(lot, items, reports = []) {
  const lotItems = (items || []).filter((item) => item.transferLotId === lot.id);
  const lotReports = (reports || []).filter((report) => report.transferLotId === lot.id);
  const totalQty = lotItems.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);
  const totalReceived = lotItems.reduce((sum, item) => sum + Number(item.quantidadeConferida || 0), 0);
  return {
    ...lot,
    totalSkus: lotItems.length,
    totalQty,
    totalPlanned: totalQty,
    totalReceived,
    totalPending: Math.max(0, totalQty - totalReceived),
    divergenceCount: lotReports.length,
    divergenceReports: lotReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    items: lotItems.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || a.sku.localeCompare(b.sku)).map((item) => ({
      ...item,
      quantidadeConferida: Number(item.quantidadeConferida || 0),
      falta: Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeConferida || 0)),
      statusConferencia: transferItemReceiveStatus(item)
    }))
  };
}

function transferItemReceiveStatus(item) {
  const planned = Number(item.quantidade || 0);
  const received = Number(item.quantidadeConferida || 0);
  if (!received) return "pendente";
  if (received < planned) return "parcial";
  if (received === planned) return "ok";
  return "sobra";
}

function findTransferItemForReceive(items, transferLotId, code) {
  const normalized = normalizeCode(code);
  const matches = (items || []).filter((item) => {
    return item.transferLotId === transferLotId &&
      (normalizeCode(item.codigoMl) === normalized ||
        normalizeCode(item.sku) === normalized ||
        normalizeCode(code39BarcodeValue(item.sku)) === normalized ||
        normalizeCode(item.ean) === normalized);
  });
  return matches.find((item) => Number(item.quantidadeConferida || 0) < Number(item.quantidade || 0)) || matches[0] || null;
}

function updateTransferLotReceivingStatus(lot, items) {
  if (lot.status === "divergent") return;
  const lotItems = (items || []).filter((item) => item.transferLotId === lot.id);
  const hasItems = lotItems.length > 0;
  const hasOver = lotItems.some((item) => Number(item.quantidadeConferida || 0) > Number(item.quantidade || 0));
  const allOk = hasItems && lotItems.every((item) => Number(item.quantidadeConferida || 0) === Number(item.quantidade || 0));
  if (hasOver) lot.status = "divergent";
  else if (allOk) lot.status = "ready_sync";
  else lot.status = "checking";
}

function findTransferProduct(db, userId, code) {
  const lotIds = new Set((db.lots || []).filter((lot) => lot.userId === userId).map((lot) => lot.id));
  const normalized = normalizeCode(code);
  const product = (db.products || [])
    .filter((candidate) => lotIds.has(candidate.lotId))
    .filter(
      (candidate) =>
        normalizeCode(candidate.codigoMl) === normalized ||
        normalizeCode(candidate.sku) === normalized ||
        normalizeCode(code39BarcodeValue(candidate.sku)) === normalized ||
        normalizeCode(candidate.ean) === normalized
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!product) return null;
  const sourceLot = (db.lots || []).find((lot) => lot.id === product.lotId);
  return { ...product, sourceLotId: product.lotId, sourceLotName: sourceLot?.nomeArquivo || "" };
}

function findExistingTransferItem(items, transferLotId, product) {
  return (items || []).find((item) => {
    if (item.transferLotId !== transferLotId) return false;
    if (product.id) return item.productId === product.id;
    if (item.productId) return false;
    const codigoMl = normalizeCode(product.codigoMl);
    const sku = normalizeCode(product.sku);
    const ean = normalizeCode(product.ean);
    return (
      (codigoMl && normalizeCode(item.codigoMl) === codigoMl) ||
      (sku && normalizeCode(item.sku) === sku) ||
      (sku && normalizeCode(code39BarcodeValue(item.sku)) === sku) ||
      (ean && normalizeCode(item.ean) === ean)
    );
  });
}

function normalizeExternalTransferProduct(input, fallbackCode) {
  if (!input) return null;
  const sku = normalizeCode(input.sku || input.codigo || input.productCode || input.codigoBling2 || fallbackCode);
  const codigoMl = normalizeCode(input.codigoMl || input.productCode || input.codigoBling2 || sku || fallbackCode);
  const descricao = String(input.descricao || input.nome || sku || fallbackCode || "").trim();
  if (!sku && !codigoMl) return null;
  return {
    id: null,
    lotId: null,
    sourceLotId: null,
    sourceLotName: "Bling",
    codigoMl: codigoMl || sku,
    sku: sku || codigoMl,
    descricao: descricao || sku || codigoMl,
    ean: String(input.ean || input.gtin || input.gtinEmbalagem || "").trim(),
    origem: "bling",
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function triageLookupFromProduct(product, row = {}) {
  return {
    productCode: product.codigoMl || "",
    sku: product.sku || "",
    ean: product.ean || "",
    asin: product.codigoMl || "",
    codigoBling2: product.codigoMl || "",
    descricao: product.descricao || "",
    valorUnit: product.valorUnit || 0,
    precoCusto: product.precoCusto || 0,
    categoria: product.categoria || "",
    subcategoria: product.subcategoria || "",
    alturaCaixa: product.alturaCaixa || "",
    larguraCaixa: product.larguraCaixa || "",
    comprimentoCaixa: product.comprimentoCaixa || "",
    pesoCaixa: product.pesoCaixa || "",
    source: "produto",
    sourceLotId: product.sourceLotId || product.lotId || row.lot__id || "",
    sourceLotName: product.sourceLotName || row.lot__nome_arquivo || ""
  };
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
    quantidadeConferida: 0,
    createdAt: new Date().toISOString()
  };
}

function normalizeForceTransferReason(reason) {
  const normalized = String(reason || "").trim();
  if (normalized.length < 5) throw new Error("Descreva o ocorrido antes de forcar a transferencia.");
  if (normalized.length > 1000) throw new Error("A descricao do ocorrido deve ter no maximo 1000 caracteres.");
  return normalized;
}

function buildTransferDivergenceReport({ transferLotId, type, description, code = "", reporterName = "", reporterUserId = null }) {
  const normalizedType = normalizeTransferDivergenceType(type);
  const normalizedDescription = String(description || "").trim();
  if (!transferLotId) throw new Error("Remessa nao informada.");
  if (normalizedDescription.length < 5) throw new Error("Descreva a divergencia com pelo menos 5 caracteres.");
  if (normalizedDescription.length > 1000) throw new Error("A descricao da divergencia deve ter no maximo 1000 caracteres.");
  return {
    id: randomUUID(),
    transferLotId,
    reporterUserId: reporterUserId || null,
    reporterName: String(reporterName || "").trim().slice(0, 120),
    type: normalizedType,
    code: normalizeCode(code || "").slice(0, 120),
    description: normalizedDescription,
    createdAt: new Date().toISOString()
  };
}

function normalizeTransferDivergenceType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  const allowed = new Set(["falta", "sobra", "avaria", "produto_trocado", "outro"]);
  if (!allowed.has(normalized)) throw new Error("Selecione o tipo da divergencia.");
  return normalized;
}

function buildForcedTransferOccurrence({ transferLotId, itemId = null, code, reason, createdAt = new Date().toISOString() }) {
  return {
    id: randomUUID(),
    transferLotId,
    itemId,
    code,
    reason,
    createdAt
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
    triageAccess: Boolean(row.triage_access),
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: iso(row.created_at)
  };
}

function triageItemFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    createdByUserId: row.created_by_user_id || row.user_id,
    operatorUserId: row.operator_user_id || null,
    code: row.code,
    productCode: row.product_code || "",
    sku: row.sku || "",
    ean: row.ean || "",
    asin: row.asin || "",
    codigoBling2: row.codigo_bling2 || "",
    descricao: row.descricao || "",
    valorUnit: num(row.valor_unit),
    precoCusto: num(row.preco_custo),
    serial: row.serial || "",
    alturaCaixa: row.altura_caixa === null || row.altura_caixa === undefined ? "" : num(row.altura_caixa),
    larguraCaixa: row.largura_caixa === null || row.largura_caixa === undefined ? "" : num(row.largura_caixa),
    comprimentoCaixa: row.comprimento_caixa === null || row.comprimento_caixa === undefined ? "" : num(row.comprimento_caixa),
    pesoCaixa: row.peso_caixa === null || row.peso_caixa === undefined ? "" : num(row.peso_caixa),
    status: row.status || "aguardando_teste",
    destination: row.destination || "",
    diagnosisCondition: row.diagnosis_condition || "",
    diagnosis: row.diagnosis || "",
    diagnosisPhoto: row.diagnosis_photo || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at || row.created_at),
    diagnosedAt: row.diagnosed_at ? iso(row.diagnosed_at) : null
  };
}

function triageEventFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    triageItemId: row.triage_item_id,
    code: row.code || "",
    operatorUserId: row.operator_user_id || null,
    destination: row.destination || "",
    diagnosisCondition: row.diagnosis_condition || "",
    diagnosis: row.diagnosis || "",
    diagnosisPhoto: row.diagnosis_photo || "",
    createdAt: iso(row.created_at)
  };
}

function userFromPrefixedRow(row, prefix) {
  return {
    id: row[`${prefix}id`],
    tenantId: row[`${prefix}tenant_id`] || row[`${prefix}id`],
    tenantName: row[`${prefix}tenant_name`] || row[`${prefix}name`],
    parentUserId: row[`${prefix}parent_user_id`] || null,
    role: row[`${prefix}role`] || (row[`${prefix}parent_user_id`] ? "operator" : "owner"),
    operatorCode: row[`${prefix}operator_code`] ? Number(row[`${prefix}operator_code`]) : null,
    triageAccess: Boolean(row[`${prefix}triage_access`]),
    name: row[`${prefix}name`],
    email: row[`${prefix}email`],
    passwordHash: row[`${prefix}password_hash`],
    createdAt: iso(row[`${prefix}created_at`])
  };
}

function lotFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    nomeArquivo: row.nome_arquivo,
    percentualArremate: num(row.percentual_arremate),
    custoMedioUnitario: num(row.custo_medio_unitario),
    tipoCusto: row.tipo_custo || "fixed",
    percentualCusto: num(row.percentual_custo),
    fornecedor: row.fornecedor,
    prefixoSku: row.prefixo_sku,
    proximoSequencialSku: Number(row.proximo_sequencial_sku),
    noSheetSuggestions: normalizeNoSheetSuggestions(row.no_sheet_suggestions || []),
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
    tipoCusto: row[`${prefix}tipo_custo`] || "fixed",
    percentualCusto: num(row[`${prefix}percentual_custo`]),
    fornecedor: row[`${prefix}fornecedor`],
    prefixoSku: row[`${prefix}prefixo_sku`],
    proximoSequencialSku: Number(row[`${prefix}proximo_sequencial_sku`]),
    noSheetSuggestions: normalizeNoSheetSuggestions(row[`${prefix}no_sheet_suggestions`] || []),
    createdAt: iso(row[`${prefix}created_at`])
  };
}

function productFromRow(row) {
  return {
    id: row.id,
    lotId: row.lot_id,
    createdByUserId: row.created_by_user_id || null,
    operatorUserId: row.operator_user_id || null,
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
    alturaCaixa: row.altura_caixa === null || row.altura_caixa === undefined ? "" : num(row.altura_caixa),
    larguraCaixa: row.largura_caixa === null || row.largura_caixa === undefined ? "" : num(row.largura_caixa),
    comprimentoCaixa: row.comprimento_caixa === null || row.comprimento_caixa === undefined ? "" : num(row.comprimento_caixa),
    pesoCaixa: row.peso_caixa === null || row.peso_caixa === undefined ? "" : num(row.peso_caixa),
    localizacaoEstoque: row.localizacao_estoque || "",
    origem: row.origem || "planilha",
    createdAt: iso(row.created_at)
  };
}

function buildOperationalDashboardStats(db, userId) {
  const userMap = new Map((db.users || []).map((user) => [user.id, sanitizeUser(user)]));
  const owner = userMap.get(userId) || { id: userId, name: "Conta principal", email: "", role: "owner" };
  userMap.set(userId, owner);

  const lots = (db.lots || []).filter((lot) => lot.userId === userId);
  const lotIds = new Set(lots.map((lot) => lot.id));
  const products = (db.products || []).filter((product) => lotIds.has(product.lotId));
  const rzItems = (db.rzItems || []).filter((item) => lotIds.has(item.lotId));
  const transfers = (db.transferLots || []).filter((lot) => lot.userId === userId);
  const transferIds = new Set(transfers.map((lot) => lot.id));
  const transferItems = (db.transferItems || []).filter((item) => transferIds.has(item.transferLotId));
  const reports = (db.transferDivergenceReports || []).filter((report) => transferIds.has(report.transferLotId));
  const triageItems = (db.triageItems || []).filter((item) => item.userId === userId);

  const productsById = new Map(products.map((product) => [product.id, product]));
  const productsBySku = new Map();
  const productsByCode = new Map();
  for (const product of products) {
    const sku = normalizeCode(product.sku);
    const code = normalizeCode(product.codigoMl);
    if (sku && !productsBySku.has(sku)) productsBySku.set(sku, product);
    if (code && !productsByCode.has(code)) productsByCode.set(code, product);
  }

  const operatorRows = new Map();
  const operatorFor = (operatorId) => {
    const id = operatorId || userId;
    const user = userMap.get(id) || null;
    const current = operatorRows.get(id) || {
      operatorId: id,
      name: user?.name || (id === userId ? "Conta principal" : "Sem operador"),
      email: user?.email || "",
      operatorCode: user?.operatorCode || null,
      lotCount: 0,
      lotSkus: 0,
      lotQty: 0,
      lotValue: 0,
      lotCost: 0,
      lotCheckedQty: 0,
      lotCheckedValue: 0,
      lotCheckedCost: 0,
      transferCount: 0,
      transferQty: 0,
      transferReceived: 0,
      transferValue: 0,
      transferCost: 0,
      transferReceivedValue: 0,
      transferReceivedCost: 0,
      totalValue: 0,
      totalCost: 0,
      _lotIds: new Set(),
      _transferIds: new Set()
    };
    operatorRows.set(id, current);
    return current;
  };

  const qtyByProduct = new Map();
  const checkedByProduct = new Map();
  const rzKeys = new Set();
  for (const item of rzItems) {
    qtyByProduct.set(item.productId, Number(qtyByProduct.get(item.productId) || 0) + Number(item.qtdEsperada || 0));
    checkedByProduct.set(item.productId, Number(checkedByProduct.get(item.productId) || 0) + Number(item.qtdConferida || 0));
    rzKeys.add(`${item.lotId}\u0000${item.codigoRz}`);
  }

  let lotQty = 0;
  let lotCheckedQty = 0;
  let lotValue = 0;
  let lotCost = 0;
  let lotCheckedValue = 0;
  let lotCheckedCost = 0;
  for (const product of products) {
    const qty = Number(qtyByProduct.get(product.id) || product.qtdTotal || 0);
    const checked = Number(checkedByProduct.get(product.id) || 0);
    const value = roundMoney(qty * Number(product.valorUnit || 0));
    const cost = roundMoney(qty * Number(product.precoCusto || 0));
    const checkedValue = roundMoney(Math.min(qty, checked) * Number(product.valorUnit || 0));
    const checkedCost = roundMoney(Math.min(qty, checked) * Number(product.precoCusto || 0));
    lotQty += qty;
    lotCheckedQty += checked;
    lotValue += value;
    lotCost += cost;
    lotCheckedValue += checkedValue;
    lotCheckedCost += checkedCost;

    const row = operatorFor(product.operatorUserId || product.createdByUserId || userId);
    row._lotIds.add(product.lotId);
    row.lotSkus += 1;
    row.lotQty += qty;
    row.lotValue = roundMoney(row.lotValue + value);
    row.lotCost = roundMoney(row.lotCost + cost);
    row.lotCheckedQty += Math.min(qty, checked);
    row.lotCheckedValue = roundMoney(row.lotCheckedValue + checkedValue);
    row.lotCheckedCost = roundMoney(row.lotCheckedCost + checkedCost);
  }

  const statusCounts = {};
  for (const transfer of transfers) {
    statusCounts[transfer.status || "open"] = Number(statusCounts[transfer.status || "open"] || 0) + 1;
    const row = operatorFor(transfer.createdByUserId || userId);
    row._transferIds.add(transfer.id);
  }

  let transferQty = 0;
  let transferReceived = 0;
  let transferValue = 0;
  let transferCost = 0;
  let transferReceivedValue = 0;
  let transferReceivedCost = 0;
  const transfersById = new Map(transfers.map((transfer) => [transfer.id, transfer]));
  for (const item of transferItems) {
    const product = productsById.get(item.productId) || productsBySku.get(normalizeCode(item.sku)) || productsByCode.get(normalizeCode(item.codigoMl));
    const unitValue = Number(product?.valorUnit || 0);
    const unitCost = Number(product?.precoCusto || 0);
    const qty = Number(item.quantidade || 0);
    const received = Number(item.quantidadeConferida || 0);
    const value = roundMoney(qty * unitValue);
    const cost = roundMoney(qty * unitCost);
    const receivedValue = roundMoney(Math.min(qty, received) * unitValue);
    const receivedCost = roundMoney(Math.min(qty, received) * unitCost);
    transferQty += qty;
    transferReceived += received;
    transferValue += value;
    transferCost += cost;
    transferReceivedValue += receivedValue;
    transferReceivedCost += receivedCost;

    const transfer = transfersById.get(item.transferLotId);
    const row = operatorFor(transfer?.createdByUserId || userId);
    row.transferQty += qty;
    row.transferReceived += received;
    row.transferValue = roundMoney(row.transferValue + value);
    row.transferCost = roundMoney(row.transferCost + cost);
    row.transferReceivedValue = roundMoney(row.transferReceivedValue + receivedValue);
    row.transferReceivedCost = roundMoney(row.transferReceivedCost + receivedCost);
  }

  const triageDestinationRows = new Map();
  const triageDiagnosisConditionRows = new Map();
  let triageValue = 0;
  let triageCost = 0;
  let triageDiagnosedValue = 0;
  let triageDiagnosedCost = 0;
  let triageDiagnosed = 0;
  for (const item of triageItems) {
    const product = findTriageStatsProduct(products, lotIds, item);
    const value = roundMoney(Number(product?.valorUnit ?? item.valorUnit ?? 0));
    const cost = roundMoney(Number(product?.precoCusto ?? item.precoCusto ?? 0));
    const destination = String(item.destination || "sem_destino").trim().toUpperCase() || "SEM_DESTINO";
    const row = triageDestinationRows.get(destination) || { destination, total: 0, totalValue: 0, totalCost: 0 };
    row.total += 1;
    row.totalValue = roundMoney(row.totalValue + value);
    row.totalCost = roundMoney(row.totalCost + cost);
    triageDestinationRows.set(destination, row);
    if (item.diagnosisCondition) {
      const condition = String(item.diagnosisCondition).trim().toUpperCase();
      const conditionRow = triageDiagnosisConditionRows.get(condition) || { condition, total: 0, totalValue: 0, totalCost: 0 };
      conditionRow.total += 1;
      conditionRow.totalValue = roundMoney(conditionRow.totalValue + value);
      conditionRow.totalCost = roundMoney(conditionRow.totalCost + cost);
      triageDiagnosisConditionRows.set(condition, conditionRow);
    }
    triageValue = roundMoney(triageValue + value);
    triageCost = roundMoney(triageCost + cost);
    if (item.status === "diagnosticado") {
      triageDiagnosed += 1;
      triageDiagnosedValue = roundMoney(triageDiagnosedValue + value);
      triageDiagnosedCost = roundMoney(triageDiagnosedCost + cost);
    }

    const operatorRow = operatorFor(item.operatorUserId || item.createdByUserId || userId);
    operatorRow.triageCount = Number(operatorRow.triageCount || 0) + 1;
    operatorRow.triageValue = roundMoney(Number(operatorRow.triageValue || 0) + value);
    operatorRow.triageCost = roundMoney(Number(operatorRow.triageCost || 0) + cost);
  }

  const operatorStats = [...operatorRows.values()].map((row) => {
    row.lotCount = row._lotIds.size;
    row.transferCount = row._transferIds.size;
    row.triageCount = Number(row.triageCount || 0);
    row.triageValue = roundMoney(Number(row.triageValue || 0));
    row.triageCost = roundMoney(Number(row.triageCost || 0));
    row.totalValue = roundMoney(Number(row.lotCheckedValue || 0) + Number(row.transferReceivedValue || 0) + Number(row.triageValue || 0));
    row.totalCost = roundMoney(Number(row.lotCheckedCost || 0) + Number(row.transferReceivedCost || 0) + Number(row.triageCost || 0));
    delete row._lotIds;
    delete row._transferIds;
    return row;
  }).sort((a, b) => b.totalValue - a.totalValue || b.transferReceivedValue - a.transferReceivedValue || a.name.localeCompare(b.name));

  const recentTransfers = transfers
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((transfer) => {
      const items = transferItems.filter((item) => item.transferLotId === transfer.id);
      const planned = items.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);
      const received = items.reduce((sum, item) => sum + Number(item.quantidadeConferida || 0), 0);
      const value = items.reduce((sum, item) => {
        const product = productsById.get(item.productId) || productsBySku.get(normalizeCode(item.sku)) || productsByCode.get(normalizeCode(item.codigoMl));
        return sum + Number(item.quantidade || 0) * Number(product?.valorUnit || 0);
      }, 0);
      const cost = items.reduce((sum, item) => {
        const product = productsById.get(item.productId) || productsBySku.get(normalizeCode(item.sku)) || productsByCode.get(normalizeCode(item.codigoMl));
        return sum + Number(item.quantidade || 0) * Number(product?.precoCusto || 0);
      }, 0);
      const receivedValue = items.reduce((sum, item) => {
        const product = productsById.get(item.productId) || productsBySku.get(normalizeCode(item.sku)) || productsByCode.get(normalizeCode(item.codigoMl));
        const qty = Number(item.quantidade || 0);
        const receivedQty = Number(item.quantidadeConferida || 0);
        return sum + Math.min(qty, receivedQty) * Number(product?.valorUnit || 0);
      }, 0);
      const receivedCost = items.reduce((sum, item) => {
        const product = productsById.get(item.productId) || productsBySku.get(normalizeCode(item.sku)) || productsByCode.get(normalizeCode(item.codigoMl));
        const qty = Number(item.quantidade || 0);
        const receivedQty = Number(item.quantidadeConferida || 0);
        return sum + Math.min(qty, receivedQty) * Number(product?.precoCusto || 0);
      }, 0);
      const user = userMap.get(transfer.createdByUserId || userId);
      return {
        id: transfer.id,
        name: transfer.name,
        status: transfer.status,
        depositoOrigem: transfer.depositoOrigem,
        depositoDestino: transfer.depositoDestino,
        planned,
        received,
        pending: Math.max(0, planned - received),
        value: roundMoney(value),
        cost: roundMoney(cost),
        receivedValue: roundMoney(receivedValue),
        receivedCost: roundMoney(receivedCost),
        createdAt: transfer.createdAt,
        operator: user ? publicDashboardUser(user) : null
      };
    })
    .filter((transfer) => Number(transfer.received || 0) > 0)
    .slice(0, 8);

  const recentLots = lots
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 8)
    .map((lot) => {
      const lotProducts = products.filter((product) => product.lotId === lot.id);
      const expected = lotProducts.reduce((sum, product) => sum + Number(qtyByProduct.get(product.id) || product.qtdTotal || 0), 0);
      const value = lotProducts.reduce((sum, product) => sum + Number(qtyByProduct.get(product.id) || product.qtdTotal || 0) * Number(product.valorUnit || 0), 0);
      const cost = lotProducts.reduce((sum, product) => sum + Number(qtyByProduct.get(product.id) || product.qtdTotal || 0) * Number(product.precoCusto || 0), 0);
      return {
        id: lot.id,
        name: lot.nomeArquivo,
        fornecedor: lot.fornecedor,
        skus: lotProducts.length,
        expected,
        value: roundMoney(value),
        cost: roundMoney(cost),
        createdAt: lot.createdAt
      };
    });

  const triage = {
    total: triageItems.length,
    diagnosed: triageDiagnosed,
    pending: Math.max(0, triageItems.length - triageDiagnosed),
    value: roundMoney(triageValue),
    cost: roundMoney(triageCost),
    diagnosedValue: roundMoney(triageDiagnosedValue),
    diagnosedCost: roundMoney(triageDiagnosedCost),
    destinations: [...triageDestinationRows.values()]
      .sort((a, b) => b.totalValue - a.totalValue || b.total - a.total || a.destination.localeCompare(b.destination))
      .slice(0, 6),
    diagnosisConditions: [...triageDiagnosisConditionRows.values()]
      .sort((a, b) => b.totalValue - a.totalValue || b.total - a.total || a.condition.localeCompare(b.condition))
      .slice(0, 6)
  };
  const sectors = [
    {
      key: "conference",
      name: "Conferencia",
      quantity: lotQty,
      completed: lotCheckedQty,
      value: roundMoney(lotCheckedValue),
      cost: roundMoney(lotCheckedCost),
      pending: Math.max(0, lotQty - lotCheckedQty)
    },
    {
      key: "transfer",
      name: "Transferencias",
      quantity: transferQty,
      completed: transferReceived,
      value: roundMoney(transferReceivedValue),
      cost: roundMoney(transferReceivedCost),
      pending: Math.max(0, transferQty - transferReceived)
    },
    {
      key: "triage",
      name: "Triagem",
      quantity: triageItems.length,
      completed: triageDiagnosed,
      value: roundMoney(triageDiagnosedValue),
      cost: roundMoney(triageDiagnosedCost),
      pending: Math.max(0, triageItems.length - triageDiagnosed)
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    lots: {
      total: lots.length,
      skus: products.length,
      remessas: rzKeys.size,
      quantity: lotQty,
      checkedQuantity: lotCheckedQty,
      value: roundMoney(lotValue),
      cost: roundMoney(lotCost),
      checkedValue: roundMoney(lotCheckedValue),
      checkedCost: roundMoney(lotCheckedCost)
    },
    transfers: {
      total: transfers.length,
      items: transferItems.length,
      quantity: transferQty,
      received: transferReceived,
      pending: Math.max(0, transferQty - transferReceived),
      value: roundMoney(transferValue),
      cost: roundMoney(transferCost),
      receivedValue: roundMoney(transferReceivedValue),
      receivedCost: roundMoney(transferReceivedCost),
      divergenceReports: reports.length,
      statusCounts
    },
    triage,
    sectors,
    operators: operatorStats,
    recentLots,
    recentTransfers
  };
}

function publicDashboardUser(user) {
  return {
    id: user.id,
    name: user.name || "",
    email: user.email || "",
    operatorCode: user.operatorCode || null
  };
}

function buildTriageStatsFromRows(rows = []) {
  const byOperator = new Map();
  const destinations = new Map();
  const diagnosisConditions = new Map();
  let totalValue = 0;
  let totalCost = 0;
  let diagnosedTotal = 0;

  for (const row of rows) {
    const item = row.item || {};
    const salePrice = Number(row.salePrice || 0);
    const costPrice = Number(row.costPrice || 0);
    totalValue += salePrice;
    totalCost += costPrice;
    if (item.status === "diagnosticado") diagnosedTotal += 1;
    if (item.destination) {
      const destination = String(item.destination).trim().toUpperCase();
      const destinationStats = destinations.get(destination) || { destination, total: 0, totalValue: 0, totalCost: 0 };
      destinationStats.total += 1;
      destinationStats.totalValue = roundMoney(destinationStats.totalValue + salePrice);
      destinationStats.totalCost = roundMoney(destinationStats.totalCost + costPrice);
      destinations.set(destination, destinationStats);
    }
    if (item.diagnosisCondition) {
      const condition = String(item.diagnosisCondition).trim().toUpperCase();
      const conditionStats = diagnosisConditions.get(condition) || { condition, total: 0, totalValue: 0, totalCost: 0 };
      conditionStats.total += 1;
      conditionStats.totalValue = roundMoney(conditionStats.totalValue + salePrice);
      conditionStats.totalCost = roundMoney(conditionStats.totalCost + costPrice);
      diagnosisConditions.set(condition, conditionStats);
    }

    const user = row.user || null;
    const operatorId = user?.id || item.operatorUserId || item.createdByUserId || "sem-operador";
    const current = byOperator.get(operatorId) || {
      operatorId,
      name: user?.name || "Sem operador",
      email: user?.email || "",
      operatorCode: user?.operatorCode || null,
      total: 0,
      diagnosed: 0,
      pending: 0,
      totalValue: 0,
      totalCost: 0
    };
    current.total += 1;
    current.totalValue = roundMoney(current.totalValue + salePrice);
    current.totalCost = roundMoney(current.totalCost + costPrice);
    if (item.status === "diagnosticado") current.diagnosed += 1;
    else current.pending += 1;
    byOperator.set(operatorId, current);
  }

  const destinationRows = [...destinations.values()]
    .sort((a, b) => b.total - a.total || a.destination.localeCompare(b.destination));
  const diagnosisConditionRows = [...diagnosisConditions.values()]
    .sort((a, b) => b.total - a.total || a.condition.localeCompare(b.condition));

  return {
    total: rows.length,
    diagnosedTotal,
    pendingTotal: rows.length - diagnosedTotal,
    totalValue: roundMoney(totalValue),
    totalCost: roundMoney(totalCost),
    mainDestination: destinationRows[0] || null,
    destinations: destinationRows,
    diagnosisConditions: diagnosisConditionRows,
    operators: [...byOperator.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  };
}

function findTriageStatsProduct(products = [], lotIds = new Set(), item = {}) {
  const sku = normalizeCode(item.sku);
  const codes = [item.productCode, item.codigoBling2, item.asin].map(normalizeCode).filter(Boolean);
  return products
    .filter((product) => lotIds.has(product.lotId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .find((product) => {
      if (sku && normalizeCode(product.sku) === sku) return true;
      return codes.some((code) => normalizeCode(product.codigoMl) === code);
    }) || null;
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
    alturaCaixa: row.altura_caixa === null || row.altura_caixa === undefined ? "" : num(row.altura_caixa),
    larguraCaixa: row.largura_caixa === null || row.largura_caixa === undefined ? "" : num(row.largura_caixa),
    comprimentoCaixa: row.comprimento_caixa === null || row.comprimento_caixa === undefined ? "" : num(row.comprimento_caixa),
    pesoCaixa: row.peso_caixa === null || row.peso_caixa === undefined ? "" : num(row.peso_caixa),
    localizacaoEstoque: row.localizacao_estoque || "",
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
    alturaCaixa: row.altura_caixa === null || row.altura_caixa === undefined ? "" : num(row.altura_caixa),
    larguraCaixa: row.largura_caixa === null || row.largura_caixa === undefined ? "" : num(row.largura_caixa),
    comprimentoCaixa: row.comprimento_caixa === null || row.comprimento_caixa === undefined ? "" : num(row.comprimento_caixa),
    pesoCaixa: row.peso_caixa === null || row.peso_caixa === undefined ? "" : num(row.peso_caixa),
    localizacaoEstoque: row.localizacao_estoque || "",
    scope: row.scope || "individual",
    alertMessage: row.alert_message || "",
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
    alturaCaixa: row.altura_caixa === null || row.altura_caixa === undefined ? "" : num(row.altura_caixa),
    larguraCaixa: row.largura_caixa === null || row.largura_caixa === undefined ? "" : num(row.largura_caixa),
    comprimentoCaixa: row.comprimento_caixa === null || row.comprimento_caixa === undefined ? "" : num(row.comprimento_caixa),
    pesoCaixa: row.peso_caixa === null || row.peso_caixa === undefined ? "" : num(row.peso_caixa),
    localizacaoEstoque: row.localizacao_estoque || "",
    scope: row.scope || "individual",
    alertMessage: row.alert_message || "",
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

function findRzItemsByScannedCode(rzItems, products, code) {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const matches = rzItems.filter((item) => productMatchesScannedCode(productsById.get(item.productId), code));
  ensureUnambiguousItemMatches(matches);
  return matches;
}

function findLotProductByScannedCode(products, lotId, code) {
  const matches = products.filter((product) => product.lotId === lotId && productMatchesScannedCode(product, code));
  ensureUnambiguousProductMatches(matches);
  return matches[0] || null;
}

function productMatchesScannedCode(product, code) {
  if (!product) return false;
  const normalized = normalizeCode(code);
  return (
    normalizeCode(product.codigoMl) === normalized ||
    normalizeCode(product.sku) === normalized ||
    normalizeCode(code39BarcodeValue(product.sku)) === normalized ||
    normalizeCode(product.ean) === normalized
  );
}

function ensureUnambiguousItemMatches(items) {
  ensureUnambiguousProductIds(items.map((item) => item.productId));
}

function ensureUnambiguousProductMatches(products) {
  ensureUnambiguousProductIds(products.map((product) => product.id));
}

function ensureUnambiguousProductIds(productIds) {
  const uniqueProductIds = new Set(productIds.filter(Boolean));
  if (uniqueProductIds.size > 1) {
    throw new Error("Codigo bipado corresponde a mais de um produto neste lote. Confira se a etiqueta e o Codigo ML nao estao duplicados.");
  }
}

function ensureUnambiguousPgScanRows(rows) {
  ensureUnambiguousProductIds(rows.map((row) => row.product_id || row.id));
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
    descricao: row.descricao || "",
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
    quantidadeConferida: Number(row.quantidade_conferida || 0),
    forceReason: row.force_reason || "",
    forceCode: row.force_code || "",
    forceAt: row.force_at ? iso(row.force_at) : null,
    createdAt: iso(row.created_at)
  };
}

function transferForcedOccurrenceFromRow(row) {
  return {
    id: row.id,
    transferLotId: row.transfer_lot_id,
    itemId: row.transfer_item_id || null,
    code: row.code,
    reason: row.reason,
    createdAt: iso(row.created_at)
  };
}

function transferDivergenceReportFromRow(row) {
  return {
    id: row.id,
    transferLotId: row.transfer_lot_id,
    reporterUserId: row.reporter_user_id || null,
    reporterName: row.reporter_name || "",
    type: row.type,
    code: row.code || "",
    description: row.description,
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

function operatorInviteFromRow(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    tokenHash: row.token_hash,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at)
  };
}

async function getOperatorInviteByTokenHash(tokenHash) {
  const now = new Date();
  if (hasPostgres()) {
    await query("delete from operator_invites where expires_at <= now()");
    const result = await query("select * from operator_invites where token_hash = $1 and expires_at > now() limit 1", [tokenHash]);
    return result.rows[0] ? operatorInviteFromRow(result.rows[0]) : null;
  }

  const db = await readDb();
  const invite = (db.operatorInvites || []).find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt) > now) || null;
  const hasExpired = (db.operatorInvites || []).some((item) => new Date(item.expiresAt) <= now);
  if (hasExpired) {
    db.operatorInvites = (db.operatorInvites || []).filter((item) => new Date(item.expiresAt) > now);
    await writeDb(db);
  }
  return invite;
}

function publicOperatorInvite(invite, owner) {
  return {
    id: invite.id,
    ownerName: owner.tenantName || owner.name,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt
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
    productionErrors: Number(row.production_error_total || 0),
    dailyTotals: normalizeDailyTotals(row.day_totals),
    lastActivityAt: row.last_activity_at ? iso(row.last_activity_at) : null
  };
}

function summarizeOperatorActivities(activities, operatorUserId, range = {}, operator = {}) {
  const stats = { total: 0, logins: 0, searches: 0, scans: 0, creates: 0, lotViews: 0, palletViews: 0, productionErrors: 0, dailyTotals: {}, lastActivityAt: null };
  for (const activity of activities || []) {
    if (activity.operatorUserId !== operatorUserId) continue;
    if (!isOperatorActivityInRange(activity, range)) continue;
    if (isIgnoredOperatorActivity(activity, operator)) continue;
    if (isOperatorDashboardActivity(activity.action)) {
      stats.total += 1;
      const day = operatorActivityLocalDay(activity.createdAt);
      if (day) stats.dailyTotals[day] = (stats.dailyTotals[day] || 0) + 1;
    }
    if (activity.action === "login") stats.logins += 1;
    if (activity.action === "search_ml") stats.searches += 1;
    if (activity.action === "scan_ml" || activity.action === "scan_transfer") stats.scans += 1;
    if (activity.action === "create_manual_product" || activity.action === "create_external_excess") stats.creates += 1;
    if (activity.action === "view_lot") stats.lotViews += 1;
    if (activity.action === "view_pallet") stats.palletViews += 1;
    if (activity.action === "report_transfer_divergence") stats.productionErrors += 1;
    if (!stats.lastActivityAt || activity.createdAt > stats.lastActivityAt) stats.lastActivityAt = activity.createdAt;
  }
  return stats;
}

function isOperatorDashboardActivity(action) {
  return OPERATOR_DASHBOARD_ACTIONS.includes(action);
}

function operatorActivityLocalDay(createdAt) {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day ? `${byType.year}-${byType.month}-${byType.day}` : "";
}

function isIgnoredOperatorActivity(activity, operator = {}) {
  const operatorText = `${operator.name || ""} ${operator.email || ""}`;
  return /eduarda/i.test(operatorText) && ignoredEduardaActivityDays(activity).some((day) => ["2026-06-24", "2026-06-26"].includes(day));
}

function ignoredEduardaActivityDays(activity) {
  if (!activity?.createdAt) return [];
  const utcDay = activity.createdAt.slice(0, 10);
  const localDay = operatorActivityLocalDay(activity.createdAt);
  return [utcDay, localDay].filter(Boolean);
}

function normalizeDailyTotals(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([day, total]) => [day, Number(total || 0)])
      .filter(([day, total]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && total > 0)
  );
}

function normalizeOperatorActivityRange(period = {}) {
  let startAt = parseOperatorDateBound(period.startDate, false);
  let endAt = parseOperatorDateBound(period.endDate, true);
  if (startAt && endAt && startAt > endAt) [startAt, endAt] = [endAt, startAt];
  return { startAt, endAt };
}

function parseOperatorDateBound(value, endOfDay) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isOperatorActivityInRange(activity, range) {
  const createdAt = activity.createdAt || "";
  if (range.startAt && createdAt < range.startAt) return false;
  if (range.endAt && createdAt > range.endAt) return false;
  return true;
}

function isWithinDateRange(createdAt, range) {
  const value = createdAt || "";
  if (range.startAt && value < range.startAt) return false;
  if (range.endAt && value > range.endAt) return false;
  return true;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

function num(value) {
  return Number(value || 0);
}

function userSettingFromRow(row) {
  return {
    userId: row.user_id,
    key: row.key,
    value: row.value || {},
    createdAt: iso(row.created_at || row.updated_at),
    updatedAt: iso(row.updated_at || row.created_at)
  };
}

function decimalMoney(value) {
  return roundMoney(parseNumber(value));
}

function requiredInt(value) {
  const number = parseNumber(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (!Number.isInteger(number)) throw new Error("Campo de quantidade recebeu um valor decimal. Confira os dados vindos do Bling.");
  return number;
}

function optionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  return requiredInt(value);
}

function optionalNum(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = parseNumber(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Informe dimensoes da caixa validas.");
  return roundMoney(number);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeRawSearchTerms(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeSearchTerms(value) {
  return normalizeSearchText(value).split(/\s+/).filter(Boolean);
}

export function searchTermsMatch(value, search) {
  const terms = normalizeSearchTerms(search);
  if (!terms.length) return true;
  const haystack = normalizeSearchText(value);
  return terms.every((term) => haystack.includes(term));
}

function sqlAllTermsCondition(expression, search, params) {
  const rawTerms = normalizeRawSearchTerms(search);
  const normalizedTerms = normalizeSearchTerms(search);
  const conditions = normalizedTerms.map((term, index) => {
    const alternatives = [...new Set([term, rawTerms[index]].filter(Boolean))];
    const placeholders = alternatives.map((alternative) => {
      params.push(`%${alternative}%`);
      return `${expression} like $${params.length}`;
    });
    return `(${placeholders.join(" or ")})`;
  });
  return conditions.length ? conditions.join(" and ") : "true";
}

function code39BarcodeValue(value) {
  return normalizeCode(value).replace(/[^0-9A-Z .$/+%-]/g, "-");
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
    if (user.triageAccess === undefined) {
      user.triageAccess = false;
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

async function nextTriageCode(userId) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `LAB-${day}-`;
  let codes = [];
  if (hasPostgres()) {
    const result = await query("select code from triage_items where user_id = $1 and code like $2", [userId, `${prefix}%`]);
    codes = result.rows.map((row) => row.code);
  } else {
    const db = await readDb();
    codes = (db.triageItems || [])
      .filter((item) => item.userId === userId && String(item.code || "").startsWith(prefix))
      .map((item) => item.code);
  }

  const nextNumber = codes.reduce((highest, code) => {
    const suffix = String(code || "").slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(highest, Number(suffix)) : highest;
  }, 0) + 1;
  return `${prefix}${String(nextNumber).padStart(6, "0")}`;
}

function normalizeTriageInput(input = {}) {
  const descricao = String(input.descricao || input.description || "").trim();
  const sku = normalizeCode(input.sku);
  const ean = String(input.ean || "").trim();
  const asin = normalizeCode(input.asin);
  const productCode = normalizeCode(input.productCode || input.codigoMl || input.codigo || sku || asin || ean);
  if (!descricao && !sku && !ean && !asin && !productCode) throw new Error("Informe pelo menos uma identificacao do produto.");
  return {
    id: input.id,
    userId: input.userId,
    createdByUserId: input.createdByUserId || input.userId,
    operatorUserId: input.operatorUserId || null,
    code: normalizeCode(input.code),
    productCode,
    sku,
    ean,
    asin,
    codigoBling2: normalizeCode(input.codigoBling2),
    descricao,
    valorUnit: decimalMoney(input.valorUnit ?? input.valor_unit ?? input.preco),
    precoCusto: decimalMoney(input.precoCusto ?? input.preco_custo ?? input.custo),
    serial: String(input.serial || "").trim(),
    alturaCaixa: optionalNum(input.alturaCaixa ?? input.altura_caixa ?? input.altura),
    larguraCaixa: optionalNum(input.larguraCaixa ?? input.largura_caixa ?? input.largura),
    comprimentoCaixa: optionalNum(input.comprimentoCaixa ?? input.comprimento_caixa ?? input.comprimento ?? input.profundidade),
    pesoCaixa: optionalNum(input.pesoCaixa ?? input.peso_caixa ?? input.peso),
    status: input.status || "aguardando_teste",
    destination: input.destination || "",
    diagnosisCondition: normalizeTriageDiagnosisCondition(input.diagnosisCondition ?? input.diagnosis_condition, { allowEmpty: true }),
    diagnosis: String(input.diagnosis || "").trim(),
    diagnosisPhoto: normalizeTriageDiagnosisPhoto(input.diagnosisPhoto ?? input.diagnosis_photo ?? input.photo ?? input.foto ?? ""),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt || input.createdAt,
    diagnosedAt: input.diagnosedAt || null
  };
}

function normalizeTriageDestination(value) {
  const destination = normalizeCode(value);
  if (!["LOJA", "VENDA_DIRETA", "INTERNET", "RMA"].includes(destination)) throw new Error("Destino invalido. Use Loja, Venda direta, Internet ou RMA.");
  return destination;
}

function normalizeConferenceSettings(input = {}) {
  const sourceFields = input.fields || input.conferenceRegistration?.fields || {};
  const fields = {};
  for (const [key, defaults] of Object.entries(CONFERENCE_FIELD_DEFAULTS)) {
    const incoming = sourceFields[key] || {};
    const enabled = incoming.enabled === undefined ? defaults.enabled : Boolean(incoming.enabled);
    fields[key] = {
      enabled,
      required: enabled ? Boolean(incoming.required) : false
    };
    if (Object.prototype.hasOwnProperty.call(defaults, "printOnLabel")) {
      fields[key].printOnLabel = enabled ? Boolean(incoming.printOnLabel) : false;
    }
  }
  return { fields };
}

function normalizeTriageDiagnosisCondition(value, { allowEmpty = false } = {}) {
  const condition = normalizeCode(value);
  if (!condition && allowEmpty) return "";
  if (["OK_FUNCIONANDO", "FUNCIONANDO_COM_DETALHES", "NAO_LIGA", "QUEBRADO_DANIFICADO"].includes(condition)) return condition;
  throw new Error("Diagnostico invalido. Use OK funcionando, Funcionando com detalhes, Nao liga ou Quebrado/danificado.");
}

function normalizeTriageDiagnosisPhoto(value) {
  const photo = String(value || "").trim();
  if (!photo) return "";
  if (photo.length > 7 * 1024 * 1024) throw new Error("A foto do laudo deve ter ate 5 MB.");
  if (/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(photo)) return photo;
  if (/^https?:\/\/\S+$/i.test(photo)) return photo;
  throw new Error("Foto do laudo invalida. Envie uma imagem JPG, PNG ou WebP.");
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
