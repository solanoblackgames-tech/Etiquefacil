import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("painel da operacao calcula ritmo, fluxo, alertas, envio para loja, destinos e equipe", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-dashboard-overview-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-dashboard-overview`;
    const { getOperationalDashboardStats, writeDb } = await import(storeUrl.href);
    const now = Date.now();
    const at = (days) => new Date(now - days * 86400000).toISOString();
    const day = (days) => at(days).slice(0, 10);

    await writeDb({
      users: [
        { id: "owner", tenantId: "owner", tenantName: "JZ", role: "owner", name: "Dono", email: "dono@example.com", createdAt: at(90) },
        { id: "op-1", tenantId: "owner", tenantName: "JZ", parentUserId: "owner", role: "operator", operatorCode: 1019, name: "Rafaela", email: "r@example.com", createdAt: at(90) },
        { id: "op-2", tenantId: "owner", tenantName: "JZ", parentUserId: "owner", role: "operator", operatorCode: 1011, name: "Giovanni", email: "g@example.com", createdAt: at(90) }
      ],
      lots: [{ id: "lot", userId: "owner", nomeArquivo: "Lote", fornecedor: "F", prefixoSku: "S", percentualArremate: 0, proximoSequencialSku: 1, createdAt: at(2) }],
      products: [{ id: "p", lotId: "lot", codigoMl: "M", sku: "S1", descricao: "P", valorUnit: 100, precoCusto: 30, qtdTotal: 10, origem: "planilha", createdAt: at(2) }],
      rzItems: [{ id: "rz", lotId: "lot", productId: "p", codigoRz: "RZ", qtdEsperada: 10, qtdConferida: 6, tipoItem: "esperado", createdAt: at(2) }],
      transferLots: [
        { id: "store-open", userId: "owner", name: "Loja 1", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "waiting_store", source: "manual", createdAt: at(2) },
        { id: "store-done", userId: "owner", name: "Loja 2", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "synced", source: "manual", receivedTotal: 2, receivedAt: at(1), createdAt: at(1) },
        { id: "rma", userId: "owner", name: "RMA", depositoOrigem: "Geral", depositoDestino: "RMA", status: "waiting_store", source: "triage", triageItemId: "t-rma", createdAt: at(1) }
      ],
      transferItems: [
        { id: "i1", transferLotId: "store-open", productId: "p", codigoMl: "M", sku: "S1", descricao: "P", quantidade: 3 },
        { id: "i2", transferLotId: "store-done", productId: "p", codigoMl: "M", sku: "S1", descricao: "P", quantidade: 2 },
        { id: "i3", transferLotId: "rma", triageItemId: "t-rma", codigoMl: "T", sku: "T", descricao: "TV", quantidade: 1 }
      ],
      triageItems: [
        { id: "t-rma", userId: "owner", code: "L1", valorUnit: 500, precoCusto: 100, status: "diagnosticado", destination: "RMA", diagnosisCondition: "RMA", createdAt: at(1), diagnosedAt: at(1) },
        { id: "t-ok", userId: "owner", code: "L2", valorUnit: 800, precoCusto: 200, status: "diagnosticado", destination: "VENDA_DIRETA", diagnosisCondition: "OK", createdAt: at(1), diagnosedAt: at(1) },
        { id: "t-wait", userId: "owner", code: "L3", valorUnit: 300, precoCusto: 90, status: "aguardando_teste", destination: "", createdAt: at(1) }
      ],
      operatorActivities: [
        { id: "a1", ownerUserId: "owner", operatorUserId: "op-1", action: "scan_ml", createdAt: at(2) },
        { id: "a2", ownerUserId: "owner", operatorUserId: "op-1", action: "scan_ml", createdAt: at(1) },
        { id: "a3", ownerUserId: "owner", operatorUserId: "op-1", action: "create_manual_product", createdAt: at(1) },
        { id: "a4", ownerUserId: "owner", operatorUserId: "op-2", action: "triage_diagnosis", createdAt: at(1) },
        { id: "a5", ownerUserId: "owner", operatorUserId: "op-2", action: "login", createdAt: at(1) }
      ]
    });

    const stats = await getOperationalDashboardStats("owner", { startDate: day(6), endDate: day(0) });
    const overview = stats.overview;
    assert.ok(overview.businessDays >= 1);

    const stage = (key) => overview.stages.find((item) => item.key === key);
    assert.equal(stage("conference").total, 6);
    assert.equal(stage("conference").queue, 4);
    assert.equal(stage("transfer").total, 6);
    assert.equal(stage("transfer").queue, 4, "unidades aguardando aceite em todos os destinos");
    assert.equal(stage("triage").total, 2);
    assert.equal(stage("triage").queue, 1);
    assert.equal(stage("store").total, 5);
    assert.equal(stage("store").queue, 1, "agrupamentos da loja sem conferencia");
    assert.equal(stage("store").perDay, 5 / overview.businessDays);

    assert.equal(overview.flow.conferred, 6);
    assert.equal(overview.flow.storeDirect, 5);
    assert.equal(overview.flow.triageTotal, 3);

    assert.equal(overview.store.sent, 5);
    assert.equal(overview.store.sentValue, 500);
    assert.equal(overview.store.received, 2);
    assert.equal(overview.store.series.reduce((sum, row) => sum + row.quantity, 0), 5);

    assert.equal(overview.destinationTotals.saleableValue, 800);
    assert.equal(overview.destinationTotals.rmaValue, 500);
    assert.equal(overview.destinationTotals.pendingValue, 300);
    assert.equal(overview.destinations[0].destination, "VENDA_DIRETA");

    const alertKeys = overview.alerts.map((alert) => alert.key);
    assert.ok(alertKeys.includes("rma_share"));
    assert.ok(alertKeys.includes("store_awaiting"));
    assert.ok(alertKeys.includes("triage_awaiting"));
    assert.ok(alertKeys.includes("triage_queue"));
    assert.equal(overview.alerts.at(-1).severity, "medium", "alertas graves vem primeiro");

    const rafaela = overview.team.find((row) => row.name === "Rafaela");
    assert.deepEqual({ stage: rafaela.stage, items: rafaela.items, days: rafaela.days }, { stage: "conference", items: 3, days: 2 });
    const giovanni = overview.team.find((row) => row.name === "Giovanni");
    assert.deepEqual({ stage: giovanni.stage, items: giovanni.items }, { stage: "triage", items: 1 });
    assert.ok(!overview.team.some((row) => row.name === "Dono"), "conta principal nao entra na equipe");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
