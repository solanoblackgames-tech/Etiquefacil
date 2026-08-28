import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("triage diagnosis creates one waiting transfer from configured deposits", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-transfer-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-triage-transfer`;
    const {
      createOrUpdateTriageTransfer,
      createTriageItem,
      listTransferLots,
      saveUserTriageTransferSettings,
      updateTriageDiagnosis,
      writeDb
    } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-08-27T00:00:00.000Z" },
        { id: "operator-1", parentUserId: "owner-1", role: "operator", operatorCode: 1001, name: "Ana", email: "ana@example.com", createdAt: "2026-08-27T00:01:00.000Z" }
      ],
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

    await saveUserTriageTransferSettings("owner-1", {
      enabled: true,
      defaultOriginDeposit: "Triagem",
      destinations: [{ code: "ECOMMERCE", label: "Ecommerce", depositName: "Deposito Ecommerce" }],
      diagnosisOptions: [{
        code: "OK_VENDA_INTERNET",
        label: "OK venda internet",
        destination: "ECOMMERCE",
        depositOrigin: "Triagem",
        depositDestination: "Deposito Ecommerce",
        transferEnabled: true
      }]
    });

    const triageItem = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "operator-1",
      operatorUserId: "operator-1",
      payload: { sku: "SKU123", descricao: "Produto internet", ean: "789" }
    });
    const diagnosed = await updateTriageDiagnosis({
      userId: "owner-1",
      code: triageItem.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "OK_VENDA_INTERNET", destination: "RMA", diagnosis: "Aprovado" }
    });

    const created = await createOrUpdateTriageTransfer({ userId: "owner-1", item: diagnosed, createdByUserId: "operator-1" });
    const updated = await createOrUpdateTriageTransfer({ userId: "owner-1", item: diagnosed, createdByUserId: "operator-1" });
    const transfers = await listTransferLots("owner-1");

    assert.equal(created.status, "created");
    assert.equal(updated.status, "updated");
    assert.equal(diagnosed.destination, "ECOMMERCE");
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].source, "triage");
    assert.equal(transfers[0].status, "waiting_store");
    assert.equal(transfers[0].depositoOrigem, "Triagem");
    assert.equal(transfers[0].depositoDestino, "Deposito Ecommerce");
    assert.equal(transfers[0].items.length, 1);
    assert.equal(transfers[0].items[0].sku, "SKU123");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("triage transfer marks WMS only for destinations with generated WMS deposits", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-transfer-wms-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-triage-transfer-wms`;
    const {
      createOrUpdateTriageTransfer,
      createTriageItem,
      listTransferLots,
      saveUserTriageTransferSettings,
      updateTriageDiagnosis,
      writeDb
    } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-08-27T00:00:00.000Z" },
        { id: "operator-1", parentUserId: "owner-1", role: "operator", operatorCode: 1001, name: "Ana", email: "ana@example.com", createdAt: "2026-08-27T00:01:00.000Z" }
      ],
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

    await saveUserTriageTransferSettings("owner-1", {
      enabled: true,
      defaultOriginDeposit: "Geral",
      destinations: [
        { code: "ECOMMERCE", label: "Ecommerce", depositName: "Ecommerce" },
        { code: "RMA", label: "RMA", depositName: "RMA" }
      ],
      wmsDeposits: [{ depositName: "Ecommerce", prefix: "ECOM", rowsConfig: [{ label: "A", columns: 3, positions: 4 }, { label: "B", columns: 4, positions: 2 }] }],
      diagnosisOptions: [
        { code: "OK_VENDA_INTERNET", label: "OK venda internet", destination: "ECOMMERCE", depositOrigin: "Geral", depositDestination: "Ecommerce", transferEnabled: true },
        { code: "NAO_LIGA", label: "Nao liga", destination: "RMA", depositOrigin: "Geral", depositDestination: "RMA", transferEnabled: true }
      ]
    });

    const ecommerceItem = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "operator-1",
      operatorUserId: "operator-1",
      payload: { sku: "SKU-ECOM", descricao: "Produto internet" }
    });
    const rmaItem = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "operator-1",
      operatorUserId: "operator-1",
      payload: { sku: "SKU-RMA", descricao: "Produto RMA" }
    });

    await createOrUpdateTriageTransfer({
      userId: "owner-1",
      createdByUserId: "operator-1",
      item: await updateTriageDiagnosis({
        userId: "owner-1",
        code: ecommerceItem.code,
        operatorUserId: "operator-1",
        payload: { diagnosisCondition: "OK_VENDA_INTERNET", destination: "ECOMMERCE", diagnosis: "Aprovado" }
      })
    });
    await createOrUpdateTriageTransfer({
      userId: "owner-1",
      createdByUserId: "operator-1",
      item: await updateTriageDiagnosis({
        userId: "owner-1",
        code: rmaItem.code,
        operatorUserId: "operator-1",
        payload: { diagnosisCondition: "NAO_LIGA", destination: "RMA", diagnosis: "RMA" }
      })
    });

    const transfers = await listTransferLots("owner-1");
    const ecommerceTransfer = transfers.find((transfer) => transfer.depositoDestino === "Ecommerce");
    const rmaTransfer = transfers.find((transfer) => transfer.depositoDestino === "RMA");

    assert.equal(ecommerceTransfer.wmsEnabled, true);
    assert.equal(ecommerceTransfer.wmsPrefix, "ECOM");
    assert.equal(rmaTransfer.wmsEnabled, false);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
