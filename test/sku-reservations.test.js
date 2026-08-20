import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function withTempStore(name, callback) {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `etiquefacil-${name}-`));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-${name}-${Math.random()}`;
    const store = await import(storeUrl.href);
    await callback(store);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function baseDb() {
  return {
    users: [
      { id: "owner-1", name: "Dono", email: "owner@example.com" },
      { id: "operator-1", parentUserId: "owner-1", name: "Operador 1", email: "op1@example.com" },
      { id: "operator-2", parentUserId: "owner-1", name: "Operador 2", email: "op2@example.com" }
    ],
    lots: [
      {
        id: "lot-1",
        userId: "owner-1",
        nomeArquivo: "Lote sem planilha",
        fornecedor: "FORN",
        prefixoSku: "SKU",
        percentualArremate: 0,
        proximoSequencialSku: 1,
        createdAt: "2026-08-20T10:00:00.000Z"
      }
    ],
    products: [],
    rzItems: [],
    scans: [],
    labels: [],
    blingIntegrations: [],
    blingSyncJobs: [],
    skuReservations: []
  };
}

test("SKU reservation is held per operator and consumed by local product creation", async () => {
  await withTempStore("sku-reservations", async ({ addDiverseLotItem, ensureActiveSkuReservation, readDb, writeDb }) => {
    await writeDb(baseDb());

    const first = await ensureActiveSkuReservation({ userId: "owner-1", lotId: "lot-1", operatorUserId: "operator-1" });
    assert.equal(first.sku, "SKU0001");

    const same = await ensureActiveSkuReservation({ userId: "owner-1", lotId: "lot-1", operatorUserId: "operator-1" });
    assert.equal(same.id, first.id);

    const second = await ensureActiveSkuReservation({ userId: "owner-1", lotId: "lot-1", operatorUserId: "operator-2" });
    assert.equal(second.sku, "SKU0002");

    const created = await addDiverseLotItem({
      userId: "owner-1",
      createdByUserId: "operator-1",
      operatorUserId: "operator-1",
      lotId: "lot-1",
      codigoMl: "ABCD12345",
      codigoRz: "PALLET-1",
      manualProduct: { descricao: "Produto manual", valorUnit: 10 }
    });

    assert.equal(created.product.sku, "SKU0001");

    const db = await readDb();
    const consumed = db.skuReservations.find((reservation) => reservation.id === first.id);
    assert.equal(consumed.status, "consumed");
    assert.equal(consumed.productId, created.product.id);
    assert.ok(db.skuReservations.some((reservation) => reservation.operatorUserId === "operator-1" && reservation.status === "reserved" && reservation.sku === "SKU0003"));
    assert.equal(db.lots[0].proximoSequencialSku, 4);
  });
});

test("expired SKU reservation is reused before advancing sequence", async () => {
  await withTempStore("sku-reservation-reuse", async ({ ensureActiveSkuReservation, readDb, writeDb }) => {
    const db = baseDb();
    db.lots[0].proximoSequencialSku = 10;
    db.skuReservations.push({
      id: "reservation-old",
      userId: "owner-1",
      lotId: "lot-1",
      operatorUserId: "operator-1",
      sku: "SKU0005",
      sequence: 5,
      status: "reserved",
      reservedAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-19T23:59:59.999Z",
      consumedAt: "",
      productId: "",
      createdAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z"
    });
    await writeDb(db);

    const reservation = await ensureActiveSkuReservation({ userId: "owner-1", lotId: "lot-1", operatorUserId: "operator-2" });
    assert.equal(reservation.id, "reservation-old");
    assert.equal(reservation.sku, "SKU0005");
    assert.equal(reservation.operatorUserId, "operator-2");

    const updated = await readDb();
    assert.equal(updated.lots[0].proximoSequencialSku, 10);
  });
});

test("pending stock movement jobs accumulate quantity while Bling is queued", async () => {
  await withTempStore("bling-stock-queue-accumulate", async ({ enqueueBlingSyncJob, readDb, writeDb }) => {
    const db = baseDb();
    db.products.push({
      id: "product-1",
      lotId: "lot-1",
      codigoMl: "ABCD12345",
      sku: "SKU0001",
      descricao: "Produto",
      valorUnit: 10,
      precoCusto: 2,
      qtdTotal: 1,
      origem: "lote_sem_planilha",
      createdAt: "2026-08-20T10:00:00.000Z"
    });
    await writeDb(db);

    const item = { productId: "product-1", lotId: "lot-1", sku: "SKU0001", quantidade: 1, qtdConferida: 1 };
    await enqueueBlingSyncJob({ userId: "owner-1", lotId: "lot-1", productId: "product-1", sku: "SKU0001", type: "stock_entry", payload: { item } });
    await enqueueBlingSyncJob({ userId: "owner-1", lotId: "lot-1", productId: "product-1", sku: "SKU0001", type: "stock_entry", payload: { item } });

    const updated = await readDb();
    assert.equal(updated.blingSyncJobs.length, 1);
    assert.equal(updated.blingSyncJobs[0].payload.item.quantidade, 2);
    assert.equal(updated.blingSyncJobs[0].payload.item.qtdConferida, 2);
  });
});
