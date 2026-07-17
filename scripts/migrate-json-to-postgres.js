import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { closePgPool, ensureStore, getPgPool, hasPostgres } from "../src/store.js";
import { insertRows } from "../src/pg-bulk.js";

const source = process.argv[2] || path.resolve("data", "db.json");

if (!hasPostgres()) {
  console.error("Defina DATABASE_URL antes de migrar para PostgreSQL.");
  process.exit(1);
}

const raw = await fs.readFile(source, "utf8");
const db = JSON.parse(raw);

await ensureStore();
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
    ["id", "lot_id", "codigo_ml", "sku", "descricao", "valor_unit", "preco_custo", "qtd_total", "categoria", "subcategoria", "ncm", "ean", "link", "foto", "origem", "created_at"],
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
      product.ncm || "",
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

  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await closePgPool();
}

console.log(`Migração concluída a partir de ${source}.`);
