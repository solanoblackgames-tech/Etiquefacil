import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("operator entry items count scans and manual registrations once", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-operator-stats-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-operator-stats`;
    const { listOperatorsForUser, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "operator-1", parentUserId: "owner-1", role: "operator", operatorCode: 1001, name: "Ana", email: "ana@example.com", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "operator-2", parentUserId: "owner-1", role: "operator", operatorCode: 1002, name: "Bia", email: "bia@example.com", createdAt: "2026-07-01T00:01:00.000Z" }
      ],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote 1", fornecedor: "", prefixoSku: "SKU", percentualArremate: 0, proximoSequencialSku: 1, createdAt: "2026-07-14T09:00:00.000Z" }
      ],
      products: [
        { id: "product-1", lotId: "lot-1", createdByUserId: "operator-1", operatorUserId: "operator-1", codigoMl: "ML2", sku: "SKU1", descricao: "Manual comum", valorUnit: 10, precoCusto: 5, qtdTotal: 1, origem: "excedente_externo", createdAt: "2026-07-14T10:01:30.000Z" },
        { id: "product-2", lotId: "lot-1", createdByUserId: "operator-1", operatorUserId: "operator-1", codigoMl: "ML3", sku: "SKU2", descricao: "Manual diverso", valorUnit: 10, precoCusto: 5, qtdTotal: 2, origem: "lote_sem_planilha_manual", createdAt: "2026-07-14T10:03:30.000Z" },
        { id: "product-3", lotId: "lot-1", createdByUserId: "operator-2", operatorUserId: "operator-2", codigoMl: "ML4", sku: "SKU3", descricao: "Achado sem evento", valorUnit: 10, precoCusto: 5, qtdTotal: 2, origem: "lote_sem_planilha", createdAt: "2026-07-14T11:00:00.000Z" },
        { id: "product-4", lotId: "lot-1", createdByUserId: "operator-2", operatorUserId: "operator-2", codigoMl: "ML5", sku: "SKU4", descricao: "Manual sem evento", valorUnit: 10, precoCusto: 5, qtdTotal: 3, origem: "lote_sem_planilha_manual", createdAt: "2026-07-14T11:01:00.000Z" }
      ],
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
      operatorActivities: [
        { id: "a1", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_ml", metadata: { codigoMl: "ML1" }, createdAt: "2026-07-14T10:00:00.000Z" },
        { id: "a2", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "create_manual_product", metadata: { codigoMl: "ML2" }, createdAt: "2026-07-14T10:01:00.000Z" },
        { id: "a3", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_ml", metadata: { codigoMl: "ML3", source: "diverse_lot", status: "cadastro_manual" }, createdAt: "2026-07-14T10:02:00.000Z" },
        { id: "a4", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "create_manual_product", metadata: { codigoMl: "ML3", source: "diverse_lot" }, createdAt: "2026-07-14T10:03:00.000Z" },
        { id: "a5", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_transfer", metadata: { code: "TRF1" }, createdAt: "2026-07-14T10:04:00.000Z" }
      ],
      operatorInvites: [],
      catalogProducts: [],
      catalogRequests: [],
      catalogRejectedRequests: [],
      noSheetSuggestions: [],
      triageItems: [],
      triageEvents: []
    });

    const operators = await listOperatorsForUser("owner-1", { startDate: "2026-07-14", endDate: "2026-07-14" });
    const operator = operators.find((item) => item.id === "operator-1");
    const productOnlyOperator = operators.find((item) => item.id === "operator-2");

    assert.equal(operator.stats.registrationScans, 1);
    assert.equal(operator.stats.creates, 3);
    assert.equal(operator.stats.transferScans, 1);
    assert.equal(operator.stats.entryItems, 4);
    assert.equal(productOnlyOperator.stats.registrationScans, 2);
    assert.equal(productOnlyOperator.stats.creates, 3);
    assert.equal(productOnlyOperator.stats.entryItems, 5);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
