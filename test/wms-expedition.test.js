import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function withTempStore(name, callback) {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `etiquefacil-${name}-`));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-${name}`;
    const store = await import(storeUrl.href);
    await callback(store);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function baseDb() {
  return {
    users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
    lots: [],
    products: [],
    rzItems: [],
    scans: [],
    labels: [],
    skuReservations: [],
    blingIntegrations: [],
    blingSyncJobs: [],
    appSettings: {},
    userSettings: [],
    transferLots: [
      {
        id: "transfer-1",
        userId: "user-1",
        name: "TRF-1",
        descricao: "",
        depositoOrigem: "Geral",
        depositoDestino: "Ecommerce",
        status: "synced",
        source: "triage",
        wmsEnabled: true,
        wmsPrefix: "ECOM",
        createdAt: "2026-07-03T00:00:00.000Z"
      }
    ],
    transferItems: [
      {
        id: "transfer-item-1",
        transferLotId: "transfer-1",
        sourceLotId: null,
        productId: "product-1",
        codigoMl: "ML1",
        sku: "SKU1",
        descricao: "Produto internet",
        ean: "789123",
        quantidade: 1,
        quantidadeConferida: 1,
        wmsLocation: "ECOM-A01",
        createdAt: "2026-07-03T00:00:00.000Z"
      }
    ],
    transferForcedOccurrences: [],
    transferDivergenceReports: [],
    wmsExpeditionOrders: [],
    wmsExpeditionItems: [],
    wmsExpeditionReservations: [],
    wmsExpeditionPicks: [],
    operatorActivities: [],
    operatorInvites: [],
    catalogProducts: [],
    catalogRequests: [],
    catalogRejectedRequests: [],
    noSheetSuggestions: [],
    triageItems: [],
    triageEvents: []
  };
}

test("guardar um laudo no Venda B2B agenda uma única entrada mesmo com duas bipagens simultâneas", async () => {
  await withTempStore("wms-inventory-bling", async (store) => {
    const db = baseDb();
    db.triageItems = [
      { id: "triage-b2b", userId: "user-1", code: "LAB-20261118-000001", sku: "SKU-B2B" },
      { id: "triage-rma", userId: "user-1", code: "LAB-20261118-000002", sku: "SKU-RMA" }
    ];
    await store.writeDb(db);
    await store.saveUserTriageTransferSettings("user-1", {
      wmsDeposits: [
        { depositName: "Venda B2B", prefix: "B2B", blingAccount: "principal", rowsConfig: [{ label: "A", columns: 1, positions: 1 }] },
        { depositName: "RMA", prefix: "RMA", rowsConfig: [{ label: "A", columns: 1, positions: 1 }] }
      ]
    });
    // A consulta inicial também traz os saldos de transferências anteriores.
    await store.listWmsStock("user-1");
    const scan = { userId: "user-1", depositName: "Venda B2B", location: "B2B-A-1-1", code: "LAB-20261118-000001", quantity: 3 };
    const outcomes = await Promise.allSettled([store.registerWmsInventory(scan), store.registerWmsInventory(scan)]);
    const successful = outcomes.filter((outcome) => outcome.status === "fulfilled");
    assert.equal(successful.length, 1);
    assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /ja esta no WMS/);
    const result = successful[0].value;
    assert.equal(result.units.length, 1);
    assert.equal(result.blingEntryQueued, true);
    assert.equal((await store.registerWmsInventory({ ...scan, code: "SKU-SEM-LAUDO" })).blingEntryQueued, false);
    assert.equal((await store.registerWmsInventory({
      ...scan, depositName: "RMA", location: "RMA-A-1-1", code: "LAB-20261118-000002"
    })).blingEntryQueued, false);
    const [job, ...others] = await store.listDueBlingSyncJobs();
    assert.equal(others.length, 0);
    assert.equal(job.type, store.WMS_BLING_ENTRY_JOB);
    assert.equal(job.productId, result.units[0].id);
    assert.equal(job.sku, "SKU-B2B");
    assert.equal(job.payload.account, "principal");
    assert.equal(job.payload.depositName, "Venda B2B");
    const sending = await store.transitionWmsBlingEntry(job, "sending");
    assert.equal(await store.transitionWmsBlingEntry(job, "sending"), null);
    assert.equal((await store.listDueBlingSyncJobs()).length, 0);
    await store.transitionWmsBlingEntry(sending, "sent");
    const stock = await store.listWmsStock("user-1", { depositName: "Venda B2B" });
    assert.equal(stock.units.find((unit) => unit.triageCode === scan.code).blingEntry.status, "sent");
  });
});

test("WMS expedition creates route from allocated transfer stock", async () => {
  await withTempStore("wms-expedition-route", async ({ writeDb, createWmsExpeditionOrder, listWmsExpedition }) => {
    await writeDb(baseDb());

    const created = await createWmsExpeditionOrder({
      userId: "user-1",
      pedidoNumero: "1001",
      lojaNome: "Loja teste",
      items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
    });
    const expedition = await listWmsExpedition("user-1");

    assert.equal(created.order.pedidoNumero, "1001");
    assert.equal(expedition.totalStock, 0);
    assert.deepEqual(expedition.orders[0].route.map((step) => step.wmsLocation), ["ECOM-A01"]);
    assert.equal(expedition.orders[0].reservations.length, 1);
  });
});

test("WMS expedition rejects picking the right item from the wrong position", async () => {
  await withTempStore("wms-expedition-wrong-position", async ({ writeDb, createWmsExpeditionOrder, scanWmsExpeditionPick }) => {
    await writeDb(baseDb());
    const created = await createWmsExpeditionOrder({
      userId: "user-1",
      pedidoNumero: "1001",
      items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
    });

    await assert.rejects(
      () => scanWmsExpeditionPick({ userId: "user-1", orderId: created.order.id, positionCode: "RMA-A01", productCode: "SKU1" }),
      /Siga a rota: colete primeiro na posicao ECOM-A01/
    );
  });
});

test("WMS expedition order uses only the configured deposit for its store", async () => {
  await withTempStore("wms-expedition-store-deposit", async ({ writeDb, saveUserTriageTransferSettings, createWmsExpeditionOrder, listWmsExpedition, scanWmsExpeditionPick }) => {
    const db = baseDb();
    db.transferLots.push({
      id: "transfer-2",
      userId: "user-1",
      name: "TRF-2",
      descricao: "",
      depositoOrigem: "Geral",
      depositoDestino: "RMA",
      status: "synced",
      source: "triage",
      wmsEnabled: true,
      wmsPrefix: "RMA",
      createdAt: "2026-07-03T00:00:00.000Z"
    });
    db.transferItems.push({
      id: "transfer-item-2",
      transferLotId: "transfer-2",
      sourceLotId: null,
      productId: "product-2",
      codigoMl: "ML1",
      sku: "SKU1",
      descricao: "Produto internet",
      ean: "789123",
      quantidade: 1,
      quantidadeConferida: 1,
      wmsLocation: "RMA-A01",
      createdAt: "2026-07-03T00:00:00.000Z"
    });
    await writeDb(db);
    await saveUserTriageTransferSettings("user-1", {
      enabled: true,
      defaultOriginDeposit: "Geral",
      wmsDeposits: [
        { depositName: "Ecommerce", prefix: "ECOM", stores: [{ name: "Mercado Livre", blingStoreId: "203" }], rowsConfig: [{ label: "A", columns: 1, positions: 1 }] },
        { depositName: "RMA", prefix: "RMA", stores: [{ name: "Assistencia" }], rowsConfig: [{ label: "A", columns: 1, positions: 1 }] }
      ],
      diagnosisOptions: [
        { code: "OK", label: "OK", destination: "ECOMMERCE", depositOrigin: "Geral", depositDestination: "Ecommerce", transferEnabled: true }
      ]
    });

    const created = await createWmsExpeditionOrder({
      userId: "user-1",
      pedidoNumero: "1001",
      lojaNome: "Mercado Livre",
      items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
    });
    const expedition = await listWmsExpedition("user-1");

    assert.equal(created.order.wmsDepositName, "Ecommerce");
    assert.deepEqual(expedition.orders[0].route.map((step) => step.wmsLocation), ["ECOM-A01"]);
    await assert.rejects(
      () => scanWmsExpeditionPick({ userId: "user-1", orderId: created.order.id, positionCode: "RMA-A01", productCode: "SKU1" }),
      /Siga a rota: colete primeiro na posicao ECOM-A01/
    );
  });
});

test("WMS expedition pick lowers available WMS balance and completes the order", async () => {
  await withTempStore("wms-expedition-pick", async ({ writeDb, createWmsExpeditionOrder, scanWmsExpeditionPick, completeWmsExpeditionOrder, listWmsExpedition }) => {
    await writeDb(baseDb());
    const created = await createWmsExpeditionOrder({
      userId: "user-1",
      pedidoNumero: "1001",
      items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
    });

    const picked = await scanWmsExpeditionPick({ userId: "user-1", orderId: created.order.id, positionCode: "ECOM-A01", productCode: "SKU1" });
    assert.equal(picked.pick.wmsLocation, "ECOM-A01");
    assert.equal(picked.expedition.orders[0].status, "ready_print");
    assert.equal(picked.expedition.totalStock, 0);
    assert.equal(picked.expedition.orders[0].reservations[0].status, "picked");

    const completed = await completeWmsExpeditionOrder({ userId: "user-1", orderId: created.order.id });
    assert.equal(completed.expedition.orders[0].status, "completed");

    const expedition = await listWmsExpedition("user-1");
    assert.equal(expedition.totalStock, 0);
  });
});

test("WMS expedition reservation prevents two orders from using the same unit", async () => {
  await withTempStore("wms-expedition-reservation-lock", async ({ writeDb, createWmsExpeditionOrder }) => {
    await writeDb(baseDb());
    await createWmsExpeditionOrder({
      userId: "user-1",
      pedidoNumero: "1001",
      items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
    });

    await assert.rejects(
      () => createWmsExpeditionOrder({
        userId: "user-1",
        pedidoNumero: "1002",
        items: [{ sku: "SKU1", codigoMl: "ML1", quantidade: 1 }]
      }),
      /Saldo WMS insuficiente/
    );
  });
});
