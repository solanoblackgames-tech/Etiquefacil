import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildTvSalesStats, canonicalSeller, createTvSalesSync } from "../src/tv-sales.js";

// 19/10/2026 14:00 em Sao Paulo
const now = new Date("2026-10-19T17:00:00.000Z");

function jzCache() {
  return {
    channels: { 10: "ATACADO VENDAS", 11: "SOLDIM LOJA", 12: "PANOBIANCO IBITI" },
    sellers: { 1: "Matheus Selbman", 2: "fernando cavasane", 3: "FERNANDO CAVACANE", 4: "Treinamento" },
    images: {},
    orders: {
      a: { id: "a", day: "2026-10-19", total: 1000, storeId: "10" },
      b: { id: "b", day: "2026-10-05", total: 500, storeId: "11" },
      c: { id: "c", day: "2026-10-06", total: 300, storeId: "11" },
      d: { id: "d", day: "2026-10-07", total: 200, storeId: "10" },
      e: { id: "e", day: "2026-10-08", total: 9999, storeId: "12" },
      f: { id: "f", day: "2026-10-09", total: 50, storeId: "0" },
      p1: { id: "p1", day: "2026-09-10", total: 400, storeId: "10" },
      p2: { id: "p2", day: "2026-09-25", total: 700, storeId: "10" }
    },
    details: {
      a: { sellerId: "1", items: [{ sku: "LOTE159", name: "Lote", quantity: 5000, value: 900, productId: "x" }, { sku: "PCTMO", name: "Pacote", quantity: 2, value: 100, productId: "p" }] },
      b: { sellerId: "2", items: [{ sku: "PCTMO", name: "Pacote", quantity: 3, value: 150, productId: "p" }] },
      c: { sellerId: "3", items: [{ sku: "CX1", name: "Caixa", quantity: 1, value: 300, productId: "c" }] },
      d: { sellerId: "4", items: [{ sku: "CX1", name: "Caixa", quantity: 1, value: 200, productId: "c" }] },
      f: { sellerId: "", items: [{ sku: "Z", name: "Z", quantity: 1, value: 50, productId: "" }] },
      p1: { sellerId: "1", items: [{ sku: "PCTMO", name: "Pacote", quantity: 4, value: 400, productId: "p" }] }
    }
  };
}

function ecommerceCache() {
  return {
    channels: { 20: "Mercado Livre" },
    sellers: {},
    images: { m: { url: "https://img/m.jpg", at: Date.now() } },
    orders: { m1: { id: "m1", day: "2026-10-18", total: 2000, storeId: "20" } },
    details: { m1: { sellerId: "", items: [{ sku: "1088L0190", name: "Moto G35", quantity: 10, value: 2000, productId: "m" }] } }
  };
}

test("canonicalSeller junta grafias e tira quem nao vende", () => {
  assert.deepEqual(canonicalSeller("fernanado cavacane"), { key: "fernando cavacane", name: "Fernando Cavacane" });
  assert.deepEqual(canonicalSeller("FERNANDO CAVACANE"), { key: "fernando cavacane", name: "Fernando Cavacane" });
  assert.deepEqual(canonicalSeller(""), { key: "", name: "Sem vendedor" });
  assert.equal(canonicalSeller("Treinamento"), null);
  assert.equal(canonicalSeller("AEL COMERCIO E IMPORTACAO LTDA"), null);
  assert.equal(canonicalSeller("Panobianco-Ibiti"), null);
});

test("buildTvSalesStats soma JZ + Ecommerce, compara com o mes anterior e monta rankings", () => {
  const stats = buildTvSalesStats([
    { account: "principal", label: "JZ", connected: true, cache: jzCache() },
    { account: "ecommerce", label: "Ecommerce", connected: true, cache: ecommerceCache() }
  ], now);

  // Panobianco fica fora; pedido manual entra.
  assert.equal(stats.current.total, 1000 + 500 + 300 + 200 + 50 + 2000);
  assert.equal(stats.current.orders, 6);
  assert.equal(stats.current.pieces, 5002 + 3 + 1 + 1 + 1 + 10);
  // Mes anterior so ate o dia 19.
  assert.equal(stats.previous.total, 400);
  assert.equal(stats.todayTotals.total, 1000);
  assert.equal(stats.daily.current.length, 31);
  assert.equal(stats.daily.current[18], 1000);
  assert.equal(stats.daily.current[19], null);
  assert.equal(stats.daily.previous[24], 700);
  assert.deepEqual(stats.accounts.map((row) => [row.label, row.current]), [["JZ", 2050], ["Ecommerce", 2000]]);

  assert.deepEqual(stats.channels.map((row) => [row.name, row.current, row.previous]), [
    ["Mercado Livre", 2000, 0],
    ["ATACADO VENDAS", 1200, 400],
    ["SOLDIM LOJA", 800, 0],
    ["Pedido manual", 50, 0]
  ]);

  // LOTE159 fora do ranking de SKUs.
  assert.deepEqual(stats.skus.map((row) => [row.sku, row.quantity]), [["1088L0190", 10], ["PCTMO", 5], ["CX1", 2], ["Z", 1]]);
  assert.equal(stats.skus[0].image, "https://img/m.jpg");

  // Fernando junta as duas grafias; Treinamento sai; Sem vendedor fica; Ecommerce nao entra.
  assert.deepEqual(stats.sellers.map((row) => [row.name, row.total, row.orders]), [
    ["Matheus Selbman", 1000, 1],
    ["Fernando Cavacane", 800, 2],
    ["Sem vendedor", 50, 1]
  ]);
  assert.equal(stats.pendingDetails, 0);
});

test("buildTvSalesStats conta pedidos ainda sem detalhe", () => {
  const cache = jzCache();
  delete cache.details.b;
  const stats = buildTvSalesStats([{ account: "principal", label: "JZ", connected: true, cache }], now);
  assert.equal(stats.pendingDetails, 1);
  assert.equal(stats.current.total, 2050);
});

test("createTvSalesSync le o Bling, busca detalhes, nomes e fotos e salva o cache", async () => {
  const saved = {};
  const calls = [];
  const reader = {
    async listAttendedOrders(period) {
      calls.push(["list", period.startDay, period.endDay]);
      return [
        { id: "1", day: "2026-10-19", total: 100, storeId: "10" },
        { id: "2", day: "2026-10-18", total: 50, storeId: "10" }
      ];
    },
    async listSalesChannels() {
      return [{ id: "10", name: "ATACADO VENDAS" }];
    },
    async getOrderDetail(id) {
      calls.push(["detail", id]);
      return { sellerId: "7", items: [{ sku: "A1", name: "Item", quantity: Number(id), value: 10, productId: "77" }] };
    },
    async getSellerName(id) {
      calls.push(["seller", id]);
      return "kleber silva";
    },
    async getProductImage(id) {
      calls.push(["image", id]);
      return "https://img/a1.jpg";
    }
  };
  const sync = createTvSalesSync({
    getReader: async (userId, account) => (account === "principal" ? reader : null),
    saveCache: async (userId, account, cache) => {
      saved[account] = JSON.parse(JSON.stringify(cache));
    },
    sleep: async () => {},
    clock: () => now,
    logError: () => {}
  });

  assert.equal(sync.touch("owner-1"), null);
  await sync.run("owner-1");
  const stats = sync.stats("owner-1");
  assert.deepEqual(calls[0], ["list", "2026-09-01", "2026-10-19"]);
  assert.equal(stats.current.total, 150);
  assert.equal(stats.current.pieces, 3);
  assert.deepEqual(stats.sellers.map((row) => row.name), ["Kleber Silva"]);
  assert.equal(stats.skus[0].image, "https://img/a1.jpg");
  assert.equal(stats.accounts.find((row) => row.account === "ecommerce").connected, false);
  assert.deepEqual(Object.keys(saved.principal.details).sort(), ["1", "2"]);
  assert.equal(calls.filter((call) => call[0] === "seller").length, 1);
});

test("getTvOperatorRanking separa bipados/cadastrados, triagem e transferencia", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-tv-operators-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;
  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-tv-operators`;
    const { getTvOperatorRanking, writeDb } = await import(storeUrl.href);
    const activity = (operatorUserId, action, createdAt) => ({ id: `${operatorUserId}-${action}-${createdAt}`, ownerUserId: "owner-1", operatorUserId, action, metadata: {}, createdAt });
    await writeDb({
      users: [
        { id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "op-1", parentUserId: "owner-1", role: "operator", name: "Ana", email: "ana@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "op-2", parentUserId: "owner-1", role: "operator", name: "Bia", email: "bia@example.com", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      operatorActivities: [
        activity("op-1", "scan_ml", "2026-10-19T12:00:00.000Z"),
        activity("op-1", "create_manual_product", "2026-10-02T12:00:00.000Z"),
        activity("op-2", "scan_ml", "2026-10-03T12:00:00.000Z"),
        activity("op-2", "scan_ml", "2026-10-04T12:00:00.000Z"),
        activity("op-2", "scan_ml", "2026-10-05T12:00:00.000Z"),
        activity("op-2", "triage_diagnosis", "2026-10-19T13:00:00.000Z"),
        activity("op-1", "scan_transfer", "2026-09-30T12:00:00.000Z"),
        activity("op-1", "login", "2026-10-19T12:00:00.000Z")
      ]
    });
    const ranking = await getTvOperatorRanking("owner-1", now);
    const stage = (key) => ranking.stages.find((item) => item.key === key);
    assert.deepEqual(stage("conference").month, [{ name: "Bia", items: 3 }, { name: "Ana", items: 2 }]);
    assert.deepEqual(stage("conference").today, [{ name: "Ana", items: 1 }]);
    assert.deepEqual(stage("triage").month, [{ name: "Bia", items: 1 }]);
    assert.deepEqual(stage("transfer").month, []);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
