import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildTriageStatsRowsSql } from "../src/triage-stats-query.js";

// Run explicitly against PostgreSQL; all fixture tables are connection-local TEMP tables.
test("PostgreSQL triage statistics preserve scope, prices, photos and latest transfer", {
  skip: !process.env.TRIAGE_STATS_TEST_DATABASE_URL
}, async () => {
  const client = new pg.Client({
    connectionString: process.env.TRIAGE_STATS_TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    for (const table of ["triage_items", "products", "lots", "users", "rz_items", "transfer_lots"]) {
      await client.query(`create temp table ${table} as select * from public.${table} with no data`);
    }
    await client.query("alter table products add primary key (id)");
    await client.query(`
      insert into lots(id,user_id,nome_arquivo) values ('l1','owner','Lote 1'),('l2','other','Outro');
      insert into products(id,lot_id,sku,codigo_ml,valor_unit,preco_custo,created_at) values
        ('p1','l1','sku-1','CODE',100,20,'2026-10-01'),
        ('p2','l2','sku-1','CODE',999,999,'2026-10-20'),
        ('blank','l1','','',999,999,'2026-10-20');
      insert into rz_items(id,lot_id,product_id,qtd_conferida) values ('rz','l1','p1',1);
      insert into triage_items(id,user_id,code,sku,product_code,codigo_bling2,asin,valor_unit,preco_custo,created_at,updated_at,diagnosis_photo) values
        ('t1','owner','T1','SKU-1','','','',50,10,'2026-10-15','2026-10-15','data:image/png;base64,YWJj'),
        ('t2','owner','T2','SKU-1','','','',60,10,'2026-10-16','2026-10-16',''),
        ('history','owner','OLD','FALLBACK','','','',75,0,'2026-09-01','2026-09-01',''),
        ('fallback','owner','T3','fallback','','','',0,0,'2026-10-17','2026-10-17',''),
        ('empty','owner','T4','','','','',0,0,'2026-10-18','2026-10-18',''),
        ('private','other','PRIVATE','SKU-1','','','',999,0,'2026-10-18','2026-10-18','');
      insert into transfer_lots(id,user_id,source,triage_item_id,deposito_destino,status,created_at) values
        ('old','owner','triage','t1','Antigo','waiting_store','2026-10-15'),
        ('new','owner','triage','t1','Loja','synced','2026-10-16'),
        ('foreign','other','triage','t1','Outro','waiting_store','2026-10-20');
      update triage_items set diagnosis_condition='OK_LEILAO', grade_avaliada='B' where id='t1';
      update triage_items set diagnosis_condition='OK_VENDA_DIRETA', grade_avaliada='A' where id='t2';
    `);
    const params = ["owner", "2026-10-14T03:00:00Z", "2026-10-21T02:59:59Z", []];
    const { rows } = await client.query(buildTriageStatsRowsSql(), params);
    assert.equal(rows.length, 4);
    const first = rows.find((row) => row.id === "t1");
    assert.equal(first.product__id, "p1");
    assert.equal(Number(first.valor_unit), 100);
    assert.equal(first.triage_transferred, true);
    assert.equal(first.triage_transfer_deposito_destino, "Loja");
    assert.equal(first.triage_transfer_status, "synced");
    assert.equal("diagnosis_photo" in first, false);
    assert.equal(Number(rows.find((row) => row.id === "fallback").valor_unit), 75);
    assert.equal(rows.find((row) => row.id === "empty").product__id, null);
    const withPhotos = await client.query(buildTriageStatsRowsSql({ includePhotos: true }), params);
    assert.equal(withPhotos.rows.find((row) => row.id === "t1").diagnosis_photo, "data:image/png;base64,YWJj");
    const byLot = await client.query(buildTriageStatsRowsSql(), [...params.slice(0, 3), ["l1"]]);
    assert.deepEqual(byLot.rows.map((row) => row.id), ["t1"]);
    const cardSql = buildTriageStatsRowsSql({ includePhotos: true, itemFilter: {} });
    const auction = await client.query(cardSql, [...params, null, "OK_LEILAO", null, null, null, null]);
    assert.deepEqual(auction.rows.map((row) => row.id), ["t1"]);
    assert.equal(auction.rows[0].diagnosis_photo, "data:image/png;base64,YWJj");
    const completed = await client.query(cardSql, [...params, true, null, null, null, null, null]);
    assert.deepEqual(completed.rows.map((row) => row.id), ["t1"], "transferidos contam como concluidos, como no card");
    const noGrade = await client.query(cardSql, [...params, null, null, null, "", null, null]);
    assert.deepEqual(noGrade.rows.map((row) => row.id).sort(), ["empty", "fallback"]);
    const ranked = await client.query(cardSql, [...params.slice(0, 3), ["l1"], null, null, null, "A", null, null]);
    assert.deepEqual(ranked.rows, [], "filtro do card deve vir depois do limite de unidades conferidas");
    const transfers = await client.query(cardSql, [...params, null, null, null, null, null, "LOJA"]);
    assert.deepEqual(transfers.rows.map((row) => row.id), ["t1"]);
    const noOperator = await client.query(cardSql, [...params, null, null, null, null, "sem-operador", null]);
    assert.equal(noOperator.rows.length, 4);
  } finally {
    await client.end();
  }
});
