import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { formatSku, roundMoney } from "./domain.js";
import { findProductHistory, getBlingProducts, summarizeLot } from "./lots.js";
import { insertRows } from "./pg-bulk.js";

const { Pool } = pg;

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "db.json");

let pool;

const emptyDb = () => ({
  users: [],
  lots: [],
  products: [],
  rzItems: [],
  scans: [],
  labels: []
});

export function hasPostgres() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPgPool() {
  if (!hasPostgres()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
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
}

export async function readDb() {
  await ensureStore();
  if (hasPostgres()) return readPgDb();

  const raw = await fs.readFile(DB_PATH, "utf8");
  return { ...emptyDb(), ...JSON.parse(raw || "{}") };
}

export async function writeDb(db) {
  await ensureStore();
  if (hasPostgres()) {
    await writePgDb(db);
    return;
  }

  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export async function createUser({ name, email, password }) {
  await ensureStore();
  const normalizedEmail = email.trim().toLowerCase();
  const user = {
    id: randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString()
  };

  if (hasPostgres()) {
    try {
      await query(
        `insert into users (id, name, email, password_hash, created_at)
         values ($1, $2, $3, $4, $5)`,
        [user.id, user.name, user.email, user.passwordHash, user.createdAt]
      );
    } catch (error) {
      if (error.code === "23505") throw new Error("E-mail já cadastrado.");
      throw error;
    }
    return sanitizeUser(user);
  }

  const db = await readDb();
  if (db.users.some((item) => item.email === normalizedEmail)) {
    throw new Error("E-mail já cadastrado.");
  }
  db.users.push(user);
  await writeDb(db);
  return sanitizeUser(user);
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

export function sanitizeUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}

export async function getStoreHealth() {
  await ensureStore();
  if (!hasPostgres()) return { ok: true, storage: "json" };
  await query("select 1");
  return { ok: true, storage: "postgres" };
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
    const origin = blingOriginForKind(kind);
    const products = await query("select * from products where lot_id = $1 and origem = $2 order by created_at asc", [lot.id, origin]);
    return { lot, products: products.rows.map(productFromRow) };
  }

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) return null;
  return { lot, products: getBlingProducts(db, lot, kind) };
}

export async function scanLotRz({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = String(codigoMl || "").trim();
  if (!normalizedMl) throw new Error("Informe o Código ML.");

  if (hasPostgres()) return scanLotRzPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote não encontrado.");

  const rzItems = db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === codigoRz);
  const sameRzItem = rzItems.find((item) => db.products.find((product) => product.id === item.productId)?.codigoMl === normalizedMl);
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
      const history = findProductHistory(db, userId, lot.id, normalizedMl);
      scan.status = history.length ? "historico" : "desconhecido";
      scan.history = history.slice(0, 5);
    }
  }

  db.scans.push(scan);
  await writeDb(db);
  return { scan, lot: summarizeLot(db, lot, true) };
}

export async function createExternalExcess({ userId, lotId, codigoRz, codigoMl }) {
  await ensureStore();
  const normalizedMl = String(codigoMl || "").trim();
  if (hasPostgres()) return createExternalExcessPg({ userId, lotId, codigoRz, codigoMl: normalizedMl });

  const db = await readDb();
  const lot = getUserLotFromDb(db, userId, lotId);
  if (!lot) throw notFound("Lote não encontrado.");

  const history = findProductHistory(db, userId, lot.id, normalizedMl)[0];
  if (!history) throw new Error("Código ML não encontrado em outras planilhas deste usuário.");

  const existing = db.products.find((product) => product.lotId === lot.id && product.codigoMl === normalizedMl);
  if (existing) throw new Error("Este Código ML já existe no lote atual.");

  const { product, item } = buildExternalExcessRecords(lot, history, codigoRz, normalizedMl);
  lot.proximoSequencialSku += 1;
  db.products.push(product);
  db.rzItems.push(item);
  await writeDb(db);
  return { product, lot: summarizeLot(db, lot, true) };
}

export async function searchProducts(userId, codigoMl) {
  await ensureStore();
  const normalizedMl = String(codigoMl || "").trim();
  if (hasPostgres()) {
    const result = await query(
      `
        select
          p.*,
          l.id as lot__id,
          l.user_id as lot__user_id,
          l.nome_arquivo as lot__nome_arquivo,
          l.percentual_arremate as lot__percentual_arremate,
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
      origem text not null default 'planilha',
      created_at timestamptz not null default now()
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

    create index if not exists lots_user_id_idx on lots(user_id);
    create index if not exists products_lot_id_idx on products(lot_id);
    create index if not exists products_codigo_ml_idx on products(codigo_ml);
    create index if not exists products_lot_codigo_ml_idx on products(lot_id, codigo_ml);
    create index if not exists rz_items_lot_id_idx on rz_items(lot_id);
    create index if not exists rz_items_product_id_idx on rz_items(product_id);
    create index if not exists rz_items_lot_codigo_rz_idx on rz_items(lot_id, codigo_rz);
    create index if not exists scans_lot_id_idx on scans(lot_id);
    create index if not exists labels_product_id_idx on labels(product_id);
    create index if not exists labels_lot_id_idx on labels(lot_id);
    create index if not exists labels_user_id_idx on labels(user_id);
  `);
}

async function readPgDb() {
  const [users, lots, products, rzItems, scans, labels] = await Promise.all([
    query("select * from users order by created_at asc"),
    query("select * from lots order by created_at asc"),
    query("select * from products order by created_at asc"),
    query("select * from rz_items order by created_at asc"),
    query("select * from scans order by created_at asc"),
    query("select * from labels order by created_at asc")
  ]);

  return {
    users: users.rows.map(userFromRow),
    lots: lots.rows.map(lotFromRow),
    products: products.rows.map(productFromRow),
    rzItems: rzItems.rows.map(rzItemFromRow),
    scans: scans.rows.map(scanFromRow),
    labels: labels.rows.map(labelFromRow)
  };
}

async function writePgDb(db) {
  const client = await getPgPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from labels");
    await client.query("delete from scans");
    await client.query("delete from rz_items");
    await client.query("delete from products");
    await client.query("delete from lots");
    await client.query("delete from users");

    await insertRows(
      client,
      "users",
      ["id", "name", "email", "password_hash", "created_at"],
      (db.users || []).map((user) => [user.id, user.name, user.email, user.passwordHash, user.createdAt])
    );
    await insertRows(
      client,
      "lots",
      ["id", "user_id", "nome_arquivo", "percentual_arremate", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "created_at"],
      (db.lots || []).map((lot) => [
        lot.id,
        lot.userId,
        lot.nomeArquivo,
        lot.percentualArremate,
        lot.fornecedor,
        lot.prefixoSku,
        lot.proximoSequencialSku,
        lot.createdAt
      ])
    );
    await insertRows(
      client,
      "products",
      ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "origem", "created_at"],
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
    ["id", "user_id", "nome_arquivo", "percentual_arremate", "fornecedor", "prefixo_sku", "proximo_sequencial_sku", "created_at"],
    lots.map((lot) => [
      lot.id,
      lot.userId,
      lot.nomeArquivo,
      lot.percentualArremate,
      lot.fornecedor,
      lot.prefixoSku,
      lot.proximoSequencialSku,
      lot.createdAt
    ])
  );
  await insertRows(
    client,
    "products",
    ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "origem", "created_at"],
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

async function scanLotRzPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let scan;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote não encontrado.");

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
        limit 1
        for update of ri
      `,
      [lot.id, codigoRz, codigoMl]
    );

    const sameRzItem = sameRzResult.rows[0];
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

async function createExternalExcessPg({ userId, lotId, codigoRz, codigoMl }) {
  const client = await getPgPool().connect();
  let product;
  try {
    await client.query("begin");
    const lotResult = await client.query("select * from lots where id = $1 and user_id = $2 limit 1 for update", [lotId, userId]);
    const lot = lotResult.rows[0] && lotFromRow(lotResult.rows[0]);
    if (!lot) throw notFound("Lote não encontrado.");

    const history = (await findPgProductHistory(client, userId, lot.id, codigoMl, 1))[0];
    if (!history) throw new Error("Código ML não encontrado em outras planilhas deste usuário.");

    const existing = await client.query("select id from products where lot_id = $1 and codigo_ml = $2 limit 1", [lot.id, codigoMl]);
    if (existing.rows.length) throw new Error("Este Código ML já existe no lote atual.");

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

async function findPgProductHistory(client, userId, currentLotId, codigoMl, limit) {
  const result = await client.query(
    `
      select
        p.*,
        l.id as lot__id,
        l.user_id as lot__user_id,
        l.nome_arquivo as lot__nome_arquivo,
        l.percentual_arremate as lot__percentual_arremate,
        l.fornecedor as lot__fornecedor,
        l.prefixo_sku as lot__prefixo_sku,
        l.proximo_sequencial_sku as lot__proximo_sequencial_sku,
        l.created_at as lot__created_at
      from products p
      join lots l on l.id = p.lot_id
      where l.user_id = $1 and l.id <> $2 and p.codigo_ml = $3
      order by p.created_at desc
      limit $4
    `,
    [userId, currentLotId, codigoMl, limit]
  );

  return result.rows.map((row) => ({
    ...productFromRow(row),
    lot: lotFromPrefixedRow(row, "lot__")
  }));
}

function buildExternalExcessRecords(lot, history, codigoRz, codigoMl) {
  const sku = formatSku(lot.prefixoSku, lot.proximoSequencialSku);
  const product = {
    id: randomUUID(),
    lotId: lot.id,
    codigoMl,
    sku,
    descricao: history.descricao,
    valorUnit: history.valorUnit,
    precoCusto: roundMoney(history.valorUnit * (lot.percentualArremate / 100)),
    qtdTotal: 1,
    categoria: history.categoria || "",
    subcategoria: history.subcategoria || "",
    origem: "excedente_externo",
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
    valorTotal: history.valorUnit,
    tipoItem: "excedente_externo",
    createdAt: new Date().toISOString()
  };
  return { product, item };
}

function getUserLotFromDb(db, userId, lotId) {
  return db.lots.find((lot) => lot.id === lotId && lot.userId === userId);
}

function blingOriginForKind(kind) {
  if (kind === "complete") return "planilha";
  if (kind === "excess") return "excedente_externo";
  throw new Error("Tipo de exportação inválido.");
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
    origem: row.origem || "planilha",
    createdAt: iso(row.created_at)
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

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value) {
  return Number(value || 0);
}
