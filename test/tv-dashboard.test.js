import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("getTvDashboardStats soma bipados, cadastrados, triados e transferidos por dia, mes e ano", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-tv-dashboard-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-tv-dashboard`;
    const { getTvDashboardStats, writeDb } = await import(storeUrl.href);
    // 19/10/2026 14:00 em Sao Paulo
    const now = new Date("2026-10-19T17:00:00.000Z");

    await writeDb({
      users: [
        { id: "owner-1", tenantId: "owner-1", tenantName: "Loja", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "owner-2", tenantId: "owner-2", tenantName: "Outra", role: "owner", name: "Outra", email: "outra@example.com", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote 1", fornecedor: "F", prefixoSku: "S", percentualArremate: 0, proximoSequencialSku: 1, createdAt: "2026-01-02T00:00:00.000Z" },
        { id: "lot-2", userId: "owner-2", nomeArquivo: "Lote 2", fornecedor: "F", prefixoSku: "S", percentualArremate: 0, proximoSequencialSku: 1, createdAt: "2026-01-02T00:00:00.000Z" }
      ],
      products: [
        { id: "p-1", lotId: "lot-1", codigoMl: "ML1", sku: "S1", descricao: "A", origem: "lote_sem_planilha_manual", createdAt: "2026-10-19T12:00:00.000Z" },
        { id: "p-2", lotId: "lot-1", codigoMl: "ML2", sku: "S2", descricao: "B", origem: "excedente_externo", createdAt: "2026-03-10T12:00:00.000Z" },
        { id: "p-3", lotId: "lot-1", codigoMl: "ML3", sku: "S3", descricao: "C", origem: "planilha", createdAt: "2026-10-19T12:00:00.000Z" },
        { id: "p-4", lotId: "lot-2", codigoMl: "ML4", sku: "S4", descricao: "D", origem: "excedente_externo", createdAt: "2026-10-19T12:00:00.000Z" }
      ],
      rzItems: [],
      scans: [
        { id: "s-1", lotId: "lot-1", codigoRz: "RZ", codigoMl: "ML1", status: "ok", createdAt: "2026-10-19T12:00:00.000Z" },
        { id: "s-2", lotId: "lot-1", codigoRz: "RZ", codigoMl: "ML1", status: "ok", createdAt: "2026-10-19T16:59:00.000Z" },
        // 19/10 01:00 UTC ainda e 18/10 em Sao Paulo
        { id: "s-3", lotId: "lot-1", codigoRz: "RZ", codigoMl: "ML1", status: "ok", createdAt: "2026-10-19T01:00:00.000Z" },
        { id: "s-4", lotId: "lot-1", codigoRz: "RZ", codigoMl: "ML2", status: "desconhecido", createdAt: "2026-02-05T12:00:00.000Z" },
        { id: "s-5", lotId: "lot-1", codigoRz: "RZ", codigoMl: "ML2", status: "ok", createdAt: "2025-12-30T12:00:00.000Z" },
        { id: "s-6", lotId: "lot-2", codigoRz: "RZ", codigoMl: "ML4", status: "ok", createdAt: "2026-10-19T12:00:00.000Z" }
      ],
      triageItems: [
        { id: "t-1", userId: "owner-1", code: "T1", status: "diagnosticado", diagnosedAt: "2026-10-19T13:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "t-2", userId: "owner-1", code: "T2", status: "diagnosticado", diagnosedAt: "2026-07-01T13:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "t-3", userId: "owner-1", code: "T3", status: "aguardando_teste", diagnosedAt: null, createdAt: "2026-10-19T00:00:00.000Z" }
      ],
      transferLots: [
        { id: "tl-1", userId: "owner-1", name: "TRF-1", depositoOrigem: "Geral", depositoDestino: "Ecommerce", status: "open", createdAt: "2026-10-19T12:00:00.000Z" },
        { id: "tl-2", userId: "owner-1", name: "TRF-2", depositoOrigem: "Geral", depositoDestino: "RMA", status: "open", createdAt: "2026-05-01T12:00:00.000Z" },
        { id: "tl-3", userId: "owner-2", name: "TRF-3", depositoOrigem: "Geral", depositoDestino: "Loja", status: "open", createdAt: "2026-10-19T12:00:00.000Z" }
      ],
      transferItems: [
        { id: "ti-1", transferLotId: "tl-1", codigoMl: "ML1", sku: "S1", descricao: "A", quantidade: 3, createdAt: "2026-10-19T12:00:00.000Z" },
        { id: "ti-2", transferLotId: "tl-1", codigoMl: "ML2", sku: "S2", descricao: "B", quantidade: 2, createdAt: "2026-10-19T12:05:00.000Z" },
        { id: "ti-3", transferLotId: "tl-2", codigoMl: "ML2", sku: "S2", descricao: "B", quantidade: 4, createdAt: "2026-05-01T12:00:00.000Z" },
        { id: "ti-4", transferLotId: "tl-3", codigoMl: "ML4", sku: "S4", descricao: "D", quantidade: 9, createdAt: "2026-10-19T12:00:00.000Z" }
      ],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
      userSettings: [],
      transferForcedOccurrences: [],
      transferDivergenceReports: [],
      operatorActivities: [],
      operatorInvites: [],
      catalogProducts: [],
      catalogRequests: [],
      catalogRejectedRequests: [],
      noSheetSuggestions: []
    });

    const stats = await getTvDashboardStats("owner-1", now);

    assert.equal(stats.today, "2026-10-19");
    assert.deepEqual(stats.metrics.scanned, { today: 2, month: 3, year: 4 });
    assert.deepEqual(stats.metrics.created, { today: 1, month: 1, year: 2 });
    assert.deepEqual(stats.metrics.triaged, { today: 1, month: 1, year: 2 });
    assert.deepEqual(stats.metrics.transferred, { today: 5, month: 5, year: 9, lotsToday: 1 });

    assert.equal(stats.months.length, 10);
    assert.deepEqual(stats.months[1], { month: "2026-02", scanned: 1, created: 0, triaged: 0, transferred: 0 });
    assert.deepEqual(stats.months[9], { month: "2026-10", scanned: 3, created: 1, triaged: 1, transferred: 5 });

    assert.deepEqual(stats.destinations, [
      { destination: "Ecommerce", year: 5, today: 5 },
      { destination: "RMA", year: 4, today: 0 }
    ]);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("link da TV: cria, troca e invalida o token anterior", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-tv-token-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-tv-token`;
    const { findUserIdByTvDashboardToken, getTvDashboardToken, rotateTvDashboardToken, writeDb } = await import(storeUrl.href);
    await writeDb({
      users: [{ id: "owner-1", tenantId: "owner-1", tenantName: "Loja", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-01-01T00:00:00.000Z" }],
      userSettings: []
    });

    assert.equal(await getTvDashboardToken("owner-1"), null);
    const first = await rotateTvDashboardToken("owner-1");
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.equal(await getTvDashboardToken("owner-1"), first);
    assert.equal(await findUserIdByTvDashboardToken(first), "owner-1");

    const second = await rotateTvDashboardToken("owner-1");
    assert.notEqual(second, first);
    assert.equal(await findUserIdByTvDashboardToken(first), null);
    assert.equal(await findUserIdByTvDashboardToken(second), "owner-1");
    assert.equal(await findUserIdByTvDashboardToken("../../etc"), null);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
