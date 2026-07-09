import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("getOperationalDashboardStats summarizes lots transfers and operator value", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-operational-dashboard-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-operational-dashboard`;
    const { getOperationalDashboardStats, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", tenantId: "owner-1", tenantName: "Loja", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "operator-1", tenantId: "owner-1", tenantName: "Loja", parentUserId: "owner-1", role: "operator", operatorCode: 1001, name: "Ana", email: "ana@example.com", createdAt: "2026-07-01T00:00:00.000Z" }
      ],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote 1", fornecedor: "FORN", prefixoSku: "SKU", percentualArremate: 0, proximoSequencialSku: 3, createdAt: "2026-07-02T00:00:00.000Z" }
      ],
      products: [
        { id: "product-1", lotId: "lot-1", createdByUserId: "operator-1", operatorUserId: "operator-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", valorUnit: 10, precoCusto: 5, qtdTotal: 2, origem: "planilha", createdAt: "2026-07-02T00:00:00.000Z" },
        { id: "product-2", lotId: "lot-1", createdByUserId: "owner-1", operatorUserId: null, codigoMl: "ML2", sku: "SKU2", descricao: "Produto 2", valorUnit: 20, precoCusto: 8, qtdTotal: 1, origem: "planilha", createdAt: "2026-07-02T00:01:00.000Z" }
      ],
      rzItems: [
        { id: "rz-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 2, qtdConferida: 1, tipoItem: "esperado", valorTotal: 20, createdAt: "2026-07-02T00:00:00.000Z" },
        { id: "rz-2", lotId: "lot-1", productId: "product-2", codigoRz: "RZ-2", qtdEsperada: 1, qtdConferida: 1, tipoItem: "esperado", valorTotal: 20, createdAt: "2026-07-02T00:01:00.000Z" }
      ],
      transferLots: [
        { id: "transfer-1", userId: "owner-1", name: "TRF-1", descricao: "", depositoOrigem: "CD", depositoDestino: "Loja", status: "checking", createdByUserId: "operator-1", createdAt: "2026-07-03T00:00:00.000Z" }
      ],
      transferItems: [
        { id: "transfer-item-1", transferLotId: "transfer-1", sourceLotId: "lot-1", productId: "product-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", ean: "", quantidade: 3, quantidadeConferida: 2, createdAt: "2026-07-03T00:00:00.000Z" }
      ],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
      transferForcedOccurrences: [],
      transferDivergenceReports: [],
      operatorActivities: [],
      operatorInvites: [],
      catalogProducts: [],
      catalogRequests: [],
      catalogRejectedRequests: [],
      noSheetSuggestions: [],
      triageItems: [
        {
          id: "triage-1",
          userId: "owner-1",
          createdByUserId: "operator-1",
          operatorUserId: "operator-1",
          code: "TRIAGE-1",
          productCode: "ML1",
          sku: "SKU1",
          status: "diagnosticado",
          destination: "venda",
          diagnosisCondition: "NAO_LIGA",
          createdAt: "2026-07-04T00:00:00.000Z",
          updatedAt: "2026-07-04T00:00:00.000Z",
          diagnosedAt: "2026-07-04T00:10:00.000Z"
        }
      ],
      triageEvents: []
    });

    const stats = await getOperationalDashboardStats("owner-1");
    const ana = stats.operators.find((operator) => operator.operatorId === "operator-1");

    assert.equal(stats.lots.total, 1);
    assert.equal(stats.lots.remessas, 2);
    assert.equal(stats.lots.value, 40);
    assert.equal(stats.lots.cost, 18);
    assert.equal(stats.lots.checkedValue, 30);
    assert.equal(stats.lots.checkedCost, 13);
    assert.equal(stats.transfers.total, 1);
    assert.equal(stats.transfers.value, 30);
    assert.equal(stats.transfers.cost, 15);
    assert.equal(stats.transfers.receivedValue, 20);
    assert.equal(stats.transfers.receivedCost, 10);
    assert.equal(stats.transfers.pending, 1);
    assert.equal(ana.lotValue, 20);
    assert.equal(ana.lotCost, 10);
    assert.equal(ana.lotCheckedQty, 1);
    assert.equal(ana.lotCheckedValue, 10);
    assert.equal(ana.lotCheckedCost, 5);
    assert.equal(ana.transferValue, 30);
    assert.equal(ana.transferCost, 15);
    assert.equal(ana.transferReceivedValue, 20);
    assert.equal(ana.transferReceivedCost, 10);
    assert.equal(stats.triage.total, 1);
    assert.equal(stats.triage.diagnosed, 1);
    assert.equal(stats.triage.value, 10);
    assert.equal(stats.triage.cost, 5);
    assert.equal(stats.triage.diagnosedValue, 10);
    assert.equal(stats.triage.diagnosedCost, 5);
    assert.deepEqual(stats.triage.diagnosisConditions, [{ condition: "NAO_LIGA", total: 1, totalValue: 10, totalCost: 5 }]);
    assert.equal(stats.sectors.find((sector) => sector.key === "conference").value, 30);
    assert.equal(stats.sectors.find((sector) => sector.key === "conference").cost, 13);
    assert.equal(stats.sectors.find((sector) => sector.key === "transfer").value, 20);
    assert.equal(stats.sectors.find((sector) => sector.key === "transfer").cost, 10);
    assert.equal(stats.sectors.find((sector) => sector.key === "triage").value, 10);
    assert.equal(stats.sectors.find((sector) => sector.key === "triage").cost, 5);
    assert.equal(stats.recentTransfers[0].receivedValue, 20);
    assert.equal(stats.recentTransfers[0].receivedCost, 10);
    assert.equal(ana.triageCount, 1);
    assert.equal(ana.triageValue, 10);
    assert.equal(ana.triageCost, 5);
    assert.equal(ana.totalValue, 40);
    assert.equal(ana.totalCost, 20);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
