import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("envios por destino agrupam por lote de origem, destino e dia com venda, custo e recebido", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-dashboard-shipments-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-dashboard-shipments`;
    const { getOperationalDashboardStats, writeDb } = await import(storeUrl.href);
    const now = Date.now();
    const at = (days) => new Date(now - days * 86400000).toISOString();
    const day = (days) => at(days).slice(0, 10);

    await writeDb({
      users: [{ id: "owner", tenantId: "owner", tenantName: "JZ", role: "owner", name: "Dono", email: "dono@example.com", createdAt: at(90) }],
      lots: [
        { id: "lot-a", userId: "owner", nomeArquivo: "Lote A", fornecedor: "AMZ", prefixoSku: "A", percentualArremate: 0, proximoSequencialSku: 1, createdAt: at(20) },
        { id: "lot-b", userId: "owner", nomeArquivo: "Lote B", fornecedor: "TVS", prefixoSku: "B", percentualArremate: 0, proximoSequencialSku: 1, createdAt: at(10) }
      ],
      products: [
        { id: "pa", lotId: "lot-a", codigoMl: "MA", sku: "SA", descricao: "Sandalia", valorUnit: 100, precoCusto: 30, qtdTotal: 50, origem: "planilha", createdAt: at(20) },
        { id: "pb", lotId: "lot-b", codigoMl: "MB", sku: "SB", descricao: "TV", valorUnit: 2000, precoCusto: 600, qtdTotal: 5, origem: "planilha", createdAt: at(10) }
      ],
      rzItems: [],
      transferLots: [
        { id: "t-loja", userId: "owner", name: "Loja", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "synced", source: "manual", receivedTotal: 8, receivedAt: at(1), createdAt: at(2) },
        { id: "t-net", userId: "owner", name: "Internet", depositoOrigem: "Geral", depositoDestino: "Soldim Ecommerce", status: "waiting_store", source: "manual", createdAt: at(1) },
        { id: "t-rma", userId: "owner", name: "RMA", depositoOrigem: "Geral", depositoDestino: "RMA", status: "waiting_store", source: "triage", triageItemId: "tri", createdAt: at(1) }
      ],
      transferItems: [
        { id: "i1", transferLotId: "t-loja", productId: "pa", sourceLotId: "lot-a", codigoMl: "MA", sku: "SA", descricao: "Sandalia", quantidade: 6 },
        { id: "i2", transferLotId: "t-loja", productId: "pb", sourceLotId: "lot-b", codigoMl: "MB", sku: "SB", descricao: "TV", quantidade: 2 },
        { id: "i3", transferLotId: "t-net", productId: "pa", sourceLotId: null, codigoMl: "MA", sku: "SA", descricao: "Sandalia", quantidade: 4 },
        { id: "i4", transferLotId: "t-rma", productId: null, triageItemId: "tri", codigoMl: "LAB", sku: "LAB", descricao: "TV quebrada", quantidade: 1 }
      ],
      triageItems: [
        { id: "tri", userId: "owner", code: "LAB-1", sku: "", valorUnit: 1500, precoCusto: 400, status: "diagnosticado", destination: "RMA", createdAt: at(1), diagnosedAt: at(1) }
      ]
    });

    const stats = await getOperationalDashboardStats("owner", { startDate: day(6), endDate: day(0) });
    const shipments = stats.overview.shipments;
    const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
    const pick = (lot, destination) => shipments.rows.filter((row) => row.lot === lot && row.destination === destination);

    assert.deepEqual(shipments.lots.map((lot) => lot.name), ["Lote B", "Lote A", "Sem lote identificado"]);

    const lojaA = pick("lot-a", "SOLDIM MATRIZ");
    assert.equal(sum(lojaA, "quantity"), 6);
    assert.equal(sum(lojaA, "value"), 600);
    assert.equal(sum(lojaA, "cost"), 180);
    assert.equal(sum(lojaA, "received"), 6, "recebido proporcional ao total confirmado");

    const lojaB = pick("lot-b", "SOLDIM MATRIZ");
    assert.equal(sum(lojaB, "value"), 4000);
    assert.equal(sum(lojaB, "received"), 2);

    const internetA = pick("lot-a", "Soldim Ecommerce");
    assert.equal(sum(internetA, "quantity"), 4, "sem lote no item, usa o lote do produto");
    assert.equal(sum(internetA, "received"), 0);

    const rma = pick(shipments.unknownLotId, "RMA");
    assert.equal(sum(rma, "quantity"), 1);
    assert.equal(sum(rma, "value"), 1500, "item de triagem usa o valor do laudo");

    assert.equal(sum(shipments.rows, "quantity"), 13);
    const lojaTransfers = shipments.transfers.filter((row) => row.destination === "SOLDIM MATRIZ");
    assert.equal(new Set(lojaTransfers.flatMap((row) => row.ids)).size, 1, "um agrupamento com dois lotes conta uma vez");
    assert.ok(shipments.days.length >= 1);
    assert.ok(shipments.days.includes(day(1)));
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
