import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

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
    create index if not exists rz_items_lot_id_idx on rz_items(lot_id);
    create index if not exists rz_items_product_id_idx on rz_items(product_id);
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

    for (const user of db.users || []) {
      await client.query(
        `insert into users (id, name, email, password_hash, created_at)
         values ($1, $2, $3, $4, $5)`,
        [user.id, user.name, user.email, user.passwordHash, user.createdAt]
      );
    }
    for (const lot of db.lots || []) {
      await client.query(
        `insert into lots (id, user_id, nome_arquivo, percentual_arremate, fornecedor, prefixo_sku, proximo_sequencial_sku, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          lot.id,
          lot.userId,
          lot.nomeArquivo,
          lot.percentualArremate,
          lot.fornecedor,
          lot.prefixoSku,
          lot.proximoSequencialSku,
          lot.createdAt
        ]
      );
    }
    for (const product of db.products || []) {
      await client.query(
        `insert into products (id, lot_id, codigo_ml, sku, descricao, valor_unit, preco_custo, qtd_total, categoria, subcategoria, origem, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
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
        ]
      );
    }
    for (const item of db.rzItems || []) {
      await client.query(
        `insert into rz_items (id, lot_id, product_id, codigo_rz, endereco_wms, qtd_esperada, qtd_conferida, condicao_grade, valor_total, tipo_item, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
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
        ]
      );
    }
    for (const scan of db.scans || []) {
      await client.query(
        `insert into scans (id, lot_id, codigo_rz, codigo_ml, status, history, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [scan.id, scan.lotId, scan.codigoRz, scan.codigoMl, scan.status, scan.history ? JSON.stringify(scan.history) : null, scan.createdAt]
      );
    }
    for (const label of db.labels || []) {
      await client.query(
        `insert into labels (id, product_id, lot_id, user_id, created_at)
         values ($1, $2, $3, $4, $5)`,
        [label.id, label.productId, label.lotId, label.userId, label.createdAt]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
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
