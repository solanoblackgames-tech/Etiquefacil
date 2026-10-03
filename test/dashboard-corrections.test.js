import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("dashboard mostra fila aguardando aceite e rotula triagem sem destino", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-dashboard-corrections-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-dashboard-corrections`;
    const { getOperationalDashboardStats, writeDb } = await import(storeUrl.href);
    const now = Date.now();
    const daysAgo = (days) => new Date(now - days * 86400000).toISOString();

    await writeDb({
      users: [
        { id: "owner-1", tenantId: "owner-1", tenantName: "Loja", role: "owner", name: "Loja", email: "loja@example.com", createdAt: daysAgo(90) }
      ],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote 1", fornecedor: "F", prefixoSku: "SKU", percentualArremate: 0, proximoSequencialSku: 3, createdAt: daysAgo(30) }
      ],
      products: [
        { id: "p-1", lotId: "lot-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", valorUnit: 100, precoCusto: 30, qtdTotal: 5, origem: "planilha", createdAt: daysAgo(30) }
      ],
      rzItems: [],
      transferLots: [
        { id: "t-old", userId: "owner-1", name: "Loja antigo", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "waiting_store", source: "manual", createdAt: daysAgo(20) },
        { id: "t-new", userId: "owner-1", name: "Loja novo", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "waiting_store", source: "manual", createdAt: daysAgo(1) },
        { id: "t-triage", userId: "owner-1", name: "RMA", depositoOrigem: "Geral", depositoDestino: "RMA", status: "waiting_store", source: "triage", triageItemId: "tri-1", createdAt: daysAgo(2) },
        { id: "t-done", userId: "owner-1", name: "Recebido", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "synced", source: "manual", receivedTotal: 1, createdAt: daysAgo(3) },
        { id: "t-other", userId: "other-owner", name: "Outra conta", depositoOrigem: "Geral", depositoDestino: "Loja", status: "waiting_store", source: "manual", createdAt: daysAgo(1) }
      ],
      transferItems: [
        { id: "i-1", transferLotId: "t-old", productId: "p-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", quantidade: 2, createdAt: daysAgo(20) },
        { id: "i-2", transferLotId: "t-new", productId: "p-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", quantidade: 1, createdAt: daysAgo(1) },
        { id: "i-3", transferLotId: "t-triage", productId: null, triageItemId: "tri-1", codigoMl: "TRI", sku: "TRI", descricao: "TV", quantidade: 1, createdAt: daysAgo(2) },
        { id: "i-4", transferLotId: "t-done", productId: "p-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto 1", quantidade: 1, createdAt: daysAgo(3) }
      ],
      triageItems: [
        { id: "tri-1", userId: "owner-1", code: "LAB-1", descricao: "TV", valorUnit: 500, precoCusto: 200, status: "diagnosticado", destination: "RMA", diagnosisCondition: "RMA", createdAt: daysAgo(2), diagnosedAt: daysAgo(2) },
        { id: "tri-2", userId: "owner-1", code: "LAB-2", descricao: "Monitor", valorUnit: 300, precoCusto: 100, status: "aguardando_teste", destination: "", createdAt: daysAgo(1) }
      ]
    });

    const stats = await getOperationalDashboardStats("owner-1", {});
    const awaiting = stats.transfers.awaitingAcceptance;

    assert.equal(awaiting.total, 3);
    assert.equal(awaiting.quantity, 4);
    assert.equal(awaiting.value, 800);
    assert.equal(awaiting.cost, 290);
    assert.equal(awaiting.stale, 1);
    assert.equal(awaiting.oldestCreatedAt, daysAgo(20));
    const loja = awaiting.destinations.find((row) => row.destination === "SOLDIM MATRIZ");
    assert.deepEqual({ total: loja.total, quantity: loja.quantity, fromTriage: loja.fromTriage }, { total: 2, quantity: 3, fromTriage: 0 });
    const rma = awaiting.destinations.find((row) => row.destination === "RMA");
    assert.deepEqual({ total: rma.total, fromTriage: rma.fromTriage, value: rma.value }, { total: 1, fromTriage: 1, value: 500 });

    const filtered = await getOperationalDashboardStats("owner-1", {
      startDate: daysAgo(0).slice(0, 10),
      endDate: daysAgo(0).slice(0, 10)
    });
    assert.equal(filtered.transfers.awaitingAcceptance.total, 3, "a fila nao depende do filtro de periodo");

    const destinations = stats.triage.destinations.map((row) => row.destination);
    assert.ok(destinations.includes("AGUARDANDO TRIAGEM"));
    assert.ok(!destinations.includes("SEM_DESTINO"));
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
