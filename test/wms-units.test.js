import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  assertValidWmsPosition,
  buildWmsUnit,
  extractTriageCode,
  isValidWmsPosition,
  reserveWmsUnitsFifo,
  resolveWmsPick,
  suggestWmsLocations,
  translateJzWmsLocation
} from "../src/wms-units.js";

const DEPOSIT = { depositName: "Ecommerce", prefix: "ECOM", rowsConfig: [{ label: "A", columns: 2, positions: 2 }] };

function unit(overrides) {
  return { ...buildWmsUnit({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-1-1", source: "transfer", sku: "SKU1", codigoMl: "ML1", ...overrides }), ...(overrides.status ? { status: overrides.status } : {}) };
}

test("triage code is read from the laudo QR URL or the plain code", () => {
  assert.equal(extractTriageCode("https://etiquefacil.com.br/laudo/LAB-20261001-000123"), "LAB-20261001-000123");
  assert.equal(extractTriageCode("lab-20261001-000123"), "LAB-20261001-000123");
  assert.equal(extractTriageCode("SKU1"), "");
});

test("only positions that exist in the deposit grid are valid", () => {
  assert.equal(isValidWmsPosition(DEPOSIT, "ECOM-A-2-2"), true);
  assert.equal(isValidWmsPosition(DEPOSIT, "ecom-a-1-1"), true);
  assert.equal(isValidWmsPosition(DEPOSIT, "ECOM-A-3-1"), false);
  assert.equal(isValidWmsPosition(DEPOSIT, "ECOM-Z-1-1"), false);
});

test("old JZ Separacao position labels are read as the deposit position", () => {
  const b2b = { depositName: "VENDA B2B", prefix: "B2B", rowsConfig: [
    { label: "A", columns: 26, positions: 4 }, { label: "B", columns: 20, positions: 4 }, { label: "C", columns: 20, positions: 4 },
    { label: "D", columns: 11, positions: 4 }, { label: "E", columns: 15, positions: 4 }, { label: "F", columns: 15, positions: 4 },
    { label: "PATIO", columns: 1, positions: 1 }
  ] };
  assert.equal(assertValidWmsPosition(b2b, "RUA B | POSICAO 105 | ANDAR 1"), "B2B-B-1-1");
  assert.equal(assertValidWmsPosition(b2b, "Rua A POS 001"), "B2B-A-1-1");
  assert.equal(assertValidWmsPosition(b2b, "RUA A | POSIÇÃO 104 | ANDAR 1"), "B2B-A-26-4");
  assert.equal(assertValidWmsPosition(b2b, "RUA D POS 306"), "B2B-D-11-2");
  assert.equal(assertValidWmsPosition(b2b, "Chao do Patio"), "B2B-PATIO-1-1");
  assert.equal(assertValidWmsPosition(b2b, "b2b-c-2-3"), "B2B-C-2-3");
  assert.equal(translateJzWmsLocation(b2b, "RUA B POS 104"), "");
  assert.throws(() => assertValidWmsPosition(b2b, "RUA G POS 500"), /nao existe/);
});

test("FIFO reserves inventory units first, then the oldest laudo", () => {
  const newer = unit({ triageCode: "LAB-20261005-000002", fifoAt: "2026-10-05T00:00:00.000Z", location: "ECOM-A-1-1" });
  const older = unit({ triageCode: "LAB-20261001-000001", fifoAt: "2026-10-01T00:00:00.000Z", location: "ECOM-A-2-2" });
  const inventory = unit({ source: "inventory", fifoAt: "2000-01-01T00:00:00.000Z", location: "ECOM-A-2-1" });
  const order = { id: "order-1", wmsDepositName: "Ecommerce" };

  const one = reserveWmsUnitsFifo({ order, items: [{ id: "item-1", sku: "SKU1", quantidade: 2 }], units: [newer, older, inventory] });
  assert.deepEqual(one.reservations.map((reservation) => reservation.unitId), [inventory.id, older.id]);
  assert.deepEqual(one.missing, []);

  const short = reserveWmsUnitsFifo({ order, items: [{ id: "item-1", sku: "SKU1", quantidade: 4 }], units: [newer, older, inventory] });
  assert.deepEqual(short.missing, [{ itemId: "item-1", sku: "SKU1", quantidade: 1 }]);
});

test("pick blocks a laudo out of FIFO and asks for the laudo when the unit has one", () => {
  const oldest = unit({ triageCode: "LAB-20261001-000001", fifoAt: "2026-10-01T00:00:00.000Z" });
  const newer = unit({ triageCode: "LAB-20261005-000002", fifoAt: "2026-10-05T00:00:00.000Z" });
  const order = { id: "order-1", wmsDepositName: "Ecommerce" };
  const { reservations } = reserveWmsUnitsFifo({ order, items: [{ id: "item-1", sku: "SKU1", quantidade: 1 }], units: [newer, oldest] });

  assert.throws(
    () => resolveWmsPick({ reservations, units: [oldest, newer], positionCode: "ECOM-A-1-1", productCode: "LAB-20261005-000002" }),
    /Fora da FIFO: pegue o laudo LAB-20261001-000001/
  );
  assert.throws(
    () => resolveWmsPick({ reservations, units: [oldest, newer], positionCode: "ECOM-A-1-1", productCode: "SKU1" }),
    /bipe o laudo LAB-20261001-000001/
  );
  const ok = resolveWmsPick({ reservations, units: [oldest, newer], positionCode: "ECOM-A-1-1", productCode: "https://x/laudo/LAB-20261001-000001" });
  assert.equal(ok.unit.id, oldest.id);
});

test("pick follows the route and accepts the SKU for inventory units without laudo", () => {
  const first = unit({ source: "inventory", location: "ECOM-A-1-1", sku: "SKU1" });
  const second = unit({ source: "inventory", location: "ECOM-A-2-1", sku: "SKU2", codigoMl: "ML2" });
  const order = { id: "order-1", wmsDepositName: "Ecommerce" };
  const { reservations } = reserveWmsUnitsFifo({ order, items: [{ id: "i1", sku: "SKU1", quantidade: 1 }, { id: "i2", sku: "SKU2", quantidade: 1 }], units: [first, second] });

  assert.throws(
    () => resolveWmsPick({ reservations, units: [first, second], positionCode: "ECOM-A-2-1", productCode: "SKU2" }),
    /Siga a rota: colete primeiro na posicao ECOM-A-1-1/
  );
  assert.equal(resolveWmsPick({ reservations, units: [first, second], positionCode: "ECOM-A-1-1", productCode: "SKU1" }).unit.id, first.id);
});

test("put-away suggests the positions that already hold the same product", () => {
  const units = [
    unit({ location: "ECOM-A-1-1" }),
    unit({ location: "ECOM-A-1-1" }),
    unit({ location: "ECOM-A-2-2" }),
    unit({ location: "ECOM-A-1-2", sku: "OTHER", codigoMl: "OTHER" })
  ];
  assert.deepEqual(suggestWmsLocations(units, { sku: "SKU1", depositName: "Ecommerce" }), [
    { location: "ECOM-A-1-1", quantity: 2 },
    { location: "ECOM-A-2-2", quantity: 1 }
  ]);
});

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

function triageItem(code, diagnosedAt) {
  return { id: `tri-${code}`, userId: "user-1", code, productCode: "SKU1", sku: "SKU1", asin: "ML1", ean: "789", descricao: "Fone", status: "diagnosticado", createdAt: diagnosedAt, diagnosedAt };
}

function triageTransfer(code, index) {
  return {
    lot: { id: `trf-${index}`, userId: "user-1", name: `TRF-${index}`, descricao: "", depositoOrigem: "Geral", depositoDestino: "Ecommerce", status: "waiting_store", source: "triage", wmsEnabled: true, wmsPrefix: "ECOM", createdAt: "2026-10-01T00:00:00.000Z" },
    item: { id: `ti-${index}`, transferLotId: `trf-${index}`, sourceLotId: null, productId: null, triageItemId: `tri-${code}`, triageCode: code, codigoMl: "ML1", sku: "SKU1", descricao: "Fone", ean: "789", quantidade: 1, quantidadeConferida: 0, wmsLocation: "", createdAt: "2026-10-01T00:00:00.000Z" }
  };
}

async function seedWmsStore({ writeDb, saveUserTriageTransferSettings }) {
  const older = triageTransfer("LAB-20261001-000001", 1);
  const newer = triageTransfer("LAB-20261005-000002", 2);
  await writeDb({
    users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
    triageItems: [triageItem("LAB-20261001-000001", "2026-10-01T10:00:00.000Z"), triageItem("LAB-20261005-000002", "2026-10-05T10:00:00.000Z")],
    transferLots: [older.lot, newer.lot],
    transferItems: [older.item, newer.item]
  });
  await saveUserTriageTransferSettings("user-1", {
    enabled: true,
    defaultOriginDeposit: "Geral",
    wmsDeposits: [{ depositName: "Ecommerce", prefix: "ECOM", stores: [{ name: "Mercado Livre", blingStoreId: "203" }], rowsConfig: [{ label: "A", columns: 2, positions: 2 }] }]
  });
}

test("WMS put-away validates the position grid, reads the QR laudo and keeps one unit per laudo", async () => {
  await withTempStore("wms-units-putaway", async (store) => {
    await seedWmsStore(store);
    await assert.rejects(
      () => store.receiveTransferLotScan({ userId: "user-1", transferLotId: "trf-1", code: "LAB-20261001-000001", wmsLocation: "ECOM-A-9-9" }),
      /Posicao ECOM-A-9-9 nao existe no deposito Ecommerce/
    );
    await store.receiveTransferLotScan({ userId: "user-1", transferLotId: "trf-1", code: "https://etiquefacil.com.br/laudo/LAB-20261001-000001", wmsLocation: "ECOM-A-1-1" });
    await store.receivePublicTransferLotScan({ transferLotId: "trf-2", code: "LAB-20261005-000002", wmsLocation: "ECOM-A-2-2" });

    const stock = await store.listWmsStock("user-1");
    assert.deepEqual(stock.units.map((candidate) => [candidate.triageCode, candidate.location]), [
      ["LAB-20261001-000001", "ECOM-A-1-1"],
      ["LAB-20261005-000002", "ECOM-A-2-2"]
    ]);
    assert.deepEqual(await store.suggestWmsLocationsForCode("user-1", { code: "SKU1", depositName: "Ecommerce" }), [
      { location: "ECOM-A-1-1", quantity: 1 },
      { location: "ECOM-A-2-2", quantity: 1 }
    ]);

    await store.undoPublicTransferLotScan({ transferLotId: "trf-2", itemId: "ti-2" });
    assert.equal((await store.listWmsStock("user-1")).units.length, 1);
  });
});

test("WMS expedition picks the oldest laudo (FIFO) and ships exactly that unit", async () => {
  await withTempStore("wms-units-fifo", async (store) => {
    await seedWmsStore(store);
    await store.receiveTransferLotScan({ userId: "user-1", transferLotId: "trf-2", code: "LAB-20261005-000002", wmsLocation: "ECOM-A-1-1" });
    await store.receiveTransferLotScan({ userId: "user-1", transferLotId: "trf-1", code: "LAB-20261001-000001", wmsLocation: "ECOM-A-2-2" });

    const created = await store.createWmsExpeditionOrder({ userId: "user-1", pedidoNumero: "2001", lojaNome: "Mercado Livre", items: [{ sku: "ML1", codigoMl: "ML1", quantidade: 1 }] });
    assert.deepEqual(created.order.route.map((step) => [step.wmsLocation, step.laudos]), [["ECOM-A-2-2", ["LAB-20261001-000001"]]]);

    await assert.rejects(
      () => store.scanWmsExpeditionPick({ userId: "user-1", orderId: created.order.id, positionCode: "ECOM-A-1-1", productCode: "LAB-20261005-000002" }),
      /Siga a rota: colete primeiro na posicao ECOM-A-2-2/
    );
    const picked = await store.scanWmsExpeditionPick({ userId: "user-1", orderId: created.order.id, positionCode: "ECOM-A-2-2", productCode: "LAB-20261001-000001" });
    assert.equal(picked.pick.code, "LAB-20261001-000001");
    assert.equal(picked.expedition.orders[0].status, "ready_print");

    await store.completeWmsExpeditionOrder({ userId: "user-1", orderId: created.order.id });
    const stock = await store.listWmsStock("user-1");
    assert.deepEqual(stock.units.map((candidate) => candidate.triageCode), ["LAB-20261005-000002"]);
    const movements = await store.listWmsMovements("user-1");
    assert.deepEqual(movements.filter((movement) => movement.triageCode === "LAB-20261001-000001").map((movement) => movement.type).sort(), ["coleta", "entrada", "expedicao"]);
  });
});

test("WMS inventory registers existing stock by SKU, validated in Bling without blocking the operation", async () => {
  await withTempStore("wms-units-inventory", async (store) => {
    await seedWmsStore(store);
    const lookupProduct = async (code) => (code === "SKU-OLD" ? { sku: "SKU-OLD", codigoMl: "MLOLD", ean: "", descricao: "Produto antigo" } : null);

    const result = await store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-1-2", code: "SKU-OLD", quantity: 3, lookupProduct });
    assert.equal(result.units.length, 3);
    assert.equal(result.blingValidated, true);

    await assert.rejects(
      () => store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-1-2", code: "SKU-NOPE", quantity: 1, lookupProduct }),
      /SKU-NOPE nao esta cadastrado no Bling/
    );
    const offline = async () => { throw Object.assign(new Error("Bling fora"), { wmsLookupUnavailable: true }); };
    const pending = await store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-2-1", code: "SKU-X", quantity: 1, lookupProduct: offline });
    assert.equal(pending.blingValidated, false);

    await store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-2-1", code: "LAB-20261001-000001" });
    await assert.rejects(
      () => store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-2-2", code: "LAB-20261001-000001" }),
      /ja esta no WMS na posicao ECOM-A-2-1/
    );
    await assert.rejects(
      () => store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-B-1-1", code: "SKU-OLD", quantity: 1, lookupProduct }),
      /nao existe no deposito/
    );

    const stock = await store.listWmsStock("user-1");
    assert.equal(stock.totals.units, 5);
    assert.equal(stock.totals.notValidated, 1);
  });
});

test("WMS relocation moves free units to another valid position and records the movement", async () => {
  await withTempStore("wms-units-relocate", async (store) => {
    await seedWmsStore(store);
    const lookupProduct = async () => ({ sku: "SKU-OLD", codigoMl: "MLOLD", ean: "", descricao: "Produto antigo" });
    await store.registerWmsInventory({ userId: "user-1", depositName: "Ecommerce", location: "ECOM-A-1-1", code: "SKU-OLD", quantity: 2, lookupProduct });

    await assert.rejects(
      () => store.relocateWmsUnits({ userId: "user-1", fromLocation: "ECOM-A-1-1", toLocation: "ECOM-A-7-7", code: "SKU-OLD", quantity: 1 }),
      /nao existe no deposito/
    );
    const moved = await store.relocateWmsUnits({ userId: "user-1", fromLocation: "ECOM-A-1-1", toLocation: "ECOM-A-2-1", code: "SKU-OLD", quantity: 1, reason: "Organizacao", operatorName: "Op" });
    assert.equal(moved.moved, 1);

    const stock = await store.listWmsStock("user-1");
    assert.deepEqual(stock.rows.map((row) => [row.location, row.stored]), [["ECOM-A-1-1", 1], ["ECOM-A-2-1", 1]]);
    const [last] = await store.listWmsMovements("user-1");
    assert.equal(last.type, "reenderecamento");
    assert.equal(last.reason, "Organizacao");
  });
});
