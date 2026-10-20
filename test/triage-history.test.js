import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

let triageSerialSequence = 0;
const completeTriagePayload = (payload = {}) => ({
  serial: `SN-TESTE-${++triageSerialSequence}`,
  ean: "7891234567890",
  alturaCaixa: 10,
  larguraCaixa: 20,
  comprimentoCaixa: 30,
  pesoCaixa: 1.5,
  ...payload
});

test("updateTriageDiagnosis stores diagnosis history for the triage item", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-history-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { createTriageItem, getTriageStats, listTriageDiagnosisHistory, updateTriageDiagnosis, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", name: "Usuario", email: "user@example.com" },
        { id: "operator-1", name: "Operador", email: "op@example.com", parentUserId: "owner-1", role: "operator" }
      ],
      lots: [],
      products: [],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    const item = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: completeTriagePayload({ descricao: "Produto teste", sku: "SKU-1" })
    });

    await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "OK_FUNCIONANDO", description: "Primeiro laudo", destination: "LOJA" }
    });
    await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "FUNCIONANDO_COM_DETALHES", diagnosis: "Segundo laudo", destination: "VENDA_DIRETA" }
    });

    const history = await listTriageDiagnosisHistory({ userId: "owner-1", code: item.code });
    const stats = await getTriageStats("owner-1");

    assert.equal(history.length, 2);
    assert.equal(history[0].diagnosis, "Segundo laudo");
    assert.equal(history[0].diagnosisCondition, "FUNCIONANDO_COM_DETALHES");
    assert.equal(history[0].destination, "LOJA");
    assert.equal(history[1].diagnosis, "Primeiro laudo");
    assert.equal(history[1].diagnosisCondition, "OK_FUNCIONANDO");
    assert.equal(stats.totalCost, 0);
    assert.deepEqual(stats.diagnosisConditions, [{ condition: "FUNCIONANDO_COM_DETALHES", total: 1, totalValue: 0, totalCost: 0 }]);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("updateTriageDiagnosis allows diagnosis when logistics data is incomplete", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-required-data-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-required-data`;
    const { createTriageItem, updateTriageDiagnosis, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "owner-1", name: "Usuario", email: "user@example.com" }],
      lots: [],
      products: [],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    const item = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { sku: "SKU-1", serial: "SN-1" }
    });

    const diagnosed = await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "owner-1",
      payload: { diagnosisCondition: "OK_FUNCIONANDO", diagnosis: "Laudo aprovado", destination: "VENDA_DIRETA" }
    });

    assert.equal(diagnosed.status, "diagnosticado");
    assert.equal(diagnosed.diagnosisCondition, "OK_FUNCIONANDO");
    assert.equal(diagnosed.destination, "LOJA");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("triage stats prefer Bling-filled item cost over zero local product cost", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-bling-cost-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { createTriageItem, getTriageStats, writeDb } = await import(storeUrl.href);
    const now = new Date().toISOString();

    await writeDb({
      users: [{ id: "owner-1", name: "Usuario", email: "user@example.com" }],
      lots: [{ id: "lot-1", userId: "owner-1", nomeArquivo: "Lote local", createdAt: now }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "BLING-1",
          sku: "BLING-1",
          descricao: "Produto local sem custo",
          valorUnit: 0,
          precoCusto: 0,
          qtdTotal: 1,
          createdAt: now
        }
      ],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: {
        descricao: "Produto vindo do Bling",
        sku: "BLING-1",
        codigoBling2: "BLING-1",
        valorUnit: 199.9,
        precoCusto: 52.54
      }
    });

    const stats = await getTriageStats("owner-1");

    assert.equal(stats.totalValue, 199.9);
    assert.equal(stats.totalCost, 52.54);
    assert.equal(stats.operators[0].totalValue, 199.9);
    assert.equal(stats.operators[0].totalCost, 52.54);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("triage stats rows can be filtered by lot for export", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-lot-export-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-lot-export`;
    const { createTriageItem, getTriageStats, listTriageItems, listTriageStatsRows, readDb, updateTriageDiagnosis, writeDb } = await import(storeUrl.href);
    const now = new Date().toISOString();

    await writeDb({
      users: [{ id: "owner-1", name: "Usuario", email: "user@example.com" }],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote 1", createdAt: now },
        { id: "lot-2", userId: "owner-1", nomeArquivo: "Lote 2", createdAt: now }
      ],
      products: [
        { id: "product-1", lotId: "lot-1", codigoMl: "ML1", sku: "SKU-1", descricao: "Produto 1", valorUnit: 120.5, precoCusto: 40, qtdTotal: 3, createdAt: now },
        { id: "product-2", lotId: "lot-2", codigoMl: "ML2", sku: "SKU-2", descricao: "Produto 2", valorUnit: 220.5, precoCusto: 80, qtdTotal: 2, createdAt: now }
      ],
      rzItems: [
        { id: "rz-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 3, qtdConferida: 1, tipoItem: "esperado", valorTotal: 361.5, createdAt: now }
      ],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "owner-1", payload: completeTriagePayload({ sku: "SKU-1", descricao: "Triagem 1" }) });
    await createTriageItem({ userId: "owner-1", createdByUserId: "owner-1", payload: { sku: "SKU-2", descricao: "Triagem 2" } });
    await updateTriageDiagnosis({
      userId: "owner-1",
      code: first.code,
      operatorUserId: "owner-1",
      payload: { diagnosisCondition: "OK_VENDA_DIRETA", diagnosis: "Laudo aprovado", destination: "VENDA_DIRETA" }
    });
    const db = await readDb();
    db.transferLots.push({
      id: "transfer-1",
      userId: "owner-1",
      name: "Transferencia Loja",
      descricao: "Transferencia manual para loja",
      depositoOrigem: "Triagem",
      depositoDestino: "Loja",
      status: "waiting_store",
      createdByUserId: "owner-1",
      source: "triage",
      triageItemId: first.id,
      diagnosisCondition: "OK_VENDA_DIRETA",
      triageDestination: "VENDA_DIRETA",
      createdAt: now
    });
    await writeDb(db);

    const stats = await getTriageStats("owner-1", { lotId: "lot-1" });
    const rows = await listTriageStatsRows("owner-1", { lotId: "lot-1" });
    const items = await listTriageItems("owner-1", { lotId: "lot-1" });

    assert.equal(stats.total, 1);
    assert.equal(stats.totalValue, 120.5);
    assert.deepEqual(stats.storeTransfer, { total: 1, totalValue: 120.5, totalCost: 40 });
    assert.deepEqual(stats.transferDestinations, [{ destination: "Loja", total: 1, totalValue: 120.5, totalCost: 40 }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product.sku, "SKU-1");
    assert.equal(rows[0].lot.nomeArquivo, "Lote 1");
    assert.equal(rows[0].item.diagnosis, "Laudo aprovado");
    assert.equal(items.length, 1);
    assert.equal(items[0].lotId, "lot-1");
    assert.equal(items[0].destination, "VENDA_DIRETA");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("triage stats group several lots and compare with the previous period", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-lot-group-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-lot-group`;
    const { getTriageStats, listTriageStatsRows, readDb, writeDb } = await import(storeUrl.href);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const hoursAgo = (hours) => new Date(nowDate.getTime() - hours * 3600000).toISOString();
    const localDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(date);
    const today = localDay(nowDate);
    const yesterday = localDay(new Date(nowDate.getTime() - 24 * 3600000));

    await writeDb({
      users: [{ id: "owner-1", name: "Usuario", email: "user@example.com" }],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "TV Lote A", createdAt: now },
        { id: "lot-2", userId: "owner-1", nomeArquivo: "TV Lote B", createdAt: now },
        { id: "lot-3", userId: "owner-1", nomeArquivo: "Geladeiras", createdAt: now }
      ],
      products: [
        { id: "product-1", lotId: "lot-1", codigoMl: "ML1", sku: "SKU-1", descricao: "TV 1", valorUnit: 1000, precoCusto: 400, qtdTotal: 3, createdAt: now },
        { id: "product-2", lotId: "lot-2", codigoMl: "ML2", sku: "SKU-2", descricao: "TV 2", valorUnit: 2000, precoCusto: 900, qtdTotal: 3, createdAt: now },
        { id: "product-3", lotId: "lot-3", codigoMl: "ML3", sku: "SKU-3", descricao: "Geladeira", valorUnit: 3000, precoCusto: 1000, qtdTotal: 3, createdAt: now }
      ],
      rzItems: [
        { id: "rz-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 3, qtdConferida: 3, tipoItem: "esperado", createdAt: now },
        { id: "rz-2", lotId: "lot-2", productId: "product-2", codigoRz: "RZ-2", qtdEsperada: 3, qtdConferida: 3, tipoItem: "esperado", createdAt: now },
        { id: "rz-3", lotId: "lot-3", productId: "product-3", codigoRz: "RZ-3", qtdEsperada: 3, qtdConferida: 3, tipoItem: "esperado", createdAt: now }
      ],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    const triageItem = (code, sku, fields) => ({
      id: code, userId: "owner-1", createdByUserId: "owner-1", code, sku, descricao: sku,
      status: "aguardando_teste", destination: "", diagnosisCondition: "", diagnosis: "", gradeAvaliada: "",
      diagnosedAt: null, ...fields, updatedAt: fields.createdAt
    });
    const db = await readDb();
    db.triageItems = [
      triageItem("T-A1", "SKU-1", { createdAt: hoursAgo(6), diagnosedAt: hoursAgo(2), status: "diagnosticado", destination: "RMA", gradeAvaliada: "c" }),
      triageItem("T-A2", "SKU-1", { createdAt: hoursAgo(5), gradeAvaliada: "A" }),
      triageItem("T-B1", "SKU-2", { createdAt: hoursAgo(4), diagnosedAt: hoursAgo(2), status: "diagnosticado", destination: "LOJA", gradeAvaliada: "A" }),
      triageItem("T-C1", "SKU-3", { createdAt: hoursAgo(3) }),
      triageItem("T-OLD", "SKU-1", { createdAt: hoursAgo(72) })
    ];
    await writeDb(db);

    const stats = await getTriageStats("owner-1", { startDate: yesterday, endDate: today, lotIds: "lot-1,lot-2" });
    const rows = await listTriageStatsRows("owner-1", { lotIds: ["lot-1", "lot-2"] });

    assert.equal(stats.total, 3);
    assert.equal(stats.totalValue, 4000);
    assert.equal(rows.length, 4);
    assert.deepEqual(stats.lots.map((lot) => [lot.name, lot.total, lot.diagnosed, lot.rma]), [["TV Lote A", 2, 1, 1], ["TV Lote B", 1, 1, 0]]);
    assert.equal(stats.lots[0].averageDiagnosisHours, 4);
    assert.equal(stats.diagnosisTime.averageHours, 3);
    assert.equal(stats.diagnosisTime.measured, 2);
    assert.deepEqual(stats.grades.map((grade) => [grade.grade, grade.total]), [["A", 2], ["C", 1]]);
    assert.deepEqual(stats.daily.map((day) => day.date), [yesterday, today]);
    assert.equal(stats.daily.reduce((sum, day) => sum + day.triaged, 0), 3);
    assert.equal(stats.daily.reduce((sum, day) => sum + day.diagnosed, 0), 2);
    assert.deepEqual(stats.oldestPending.map((item) => item.code), ["T-A2"]);
    assert.equal(stats.previous.total, 1);
    assert.equal(stats.previous.totalValue, 1000);
    assert.equal(stats.previous.endDate < yesterday, true);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
