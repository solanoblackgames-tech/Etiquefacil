import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { calculateSplitProductValues } from "../src/store.js";

test("calculateSplitProductValues divides prices and keeps sellable quantity", () => {
  const split = calculateSplitProductValues(
    {
      descricao: "Kit 6 pratos",
      valorUnit: 120,
      precoCusto: 60,
      qtdTotal: 6
    },
    { qtdEsperada: 6 },
    { kitQuantity: 6, sellableQuantity: 5, descricao: "Prato raso branco" }
  );

  assert.equal(split.descricao, "Prato raso branco");
  assert.equal(split.valorUnit, 20);
  assert.equal(split.precoCusto, 10);
  assert.equal(split.qtdTotal, 5);
  assert.equal(split.valorTotal, 100);
});

test("calculateSplitProductValues adjusts only the current RZ quantity from total stock", () => {
  const split = calculateSplitProductValues(
    {
      descricao: "Kit copos",
      valorUnit: 90,
      precoCusto: 30,
      qtdTotal: 10
    },
    { qtdEsperada: 6 },
    { kitQuantity: 6, sellableQuantity: 4 }
  );

  assert.equal(split.qtdTotal, 8);
});

test("splitLotProduct uses reserved SKU and keeps the original product in the RZ", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-split-product-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-split-product`;
    const { ensureActiveSkuReservation, readDb, splitLotProduct, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [
        {
          id: "lot-1",
          userId: "user-1",
          nomeArquivo: "Lote",
          percentualArremate: 50,
          fornecedor: "Fornecedor",
          prefixoSku: "ABC",
          proximoSequencialSku: 7,
          createdAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      products: [
        {
          id: "product-original",
          lotId: "lot-1",
          codigoMl: "ABCD12345",
          sku: "ABC0001",
          descricao: "KIT COM 5 PECAS",
          valorUnit: 100,
          precoCusto: 50,
          qtdTotal: 5,
          origem: "planilha",
          createdAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      rzItems: [
        {
          id: "item-1",
          lotId: "lot-1",
          productId: "product-original",
          codigoRz: "RZ-1",
          qtdEsperada: 5,
          qtdConferida: 5,
          valorTotal: 100,
          tipoItem: "esperado",
          createdAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      skuReservations: [],
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

    await ensureActiveSkuReservation({ userId: "user-1", lotId: "lot-1", operatorUserId: "user-1" });
    const result = await splitLotProduct({
      userId: "user-1",
      operatorUserId: "user-1",
      lotId: "lot-1",
      productId: "product-original",
      codigoRz: "RZ-1",
      payload: {
        kitQuantity: 5,
        sellableQuantity: 4,
        descricao: "PECA UNITARIA"
      }
    });
    const db = await readDb();
    const original = db.products.find((product) => product.id === "product-original");
    const created = db.products.find((product) => product.id === result.product.id);

    assert.equal(original.qtdTotal, 4);
    assert.equal(created.codigoMl, "ABCX00007");
    assert.equal(created.sku, "ABC0007");
    assert.equal(created.splitSourceProductId, "product-original");
    assert.equal(created.qtdTotal, 4);
    assert.equal(created.valorUnit, 20);
    const originalItem = db.rzItems.find((item) => item.id === "item-1");
    const splitItem = db.rzItems.find((item) => item.productId === created.id);
    assert.equal(originalItem.productId, "product-original");
    assert.equal(originalItem.qtdEsperada, 4);
    assert.equal(originalItem.qtdConferida, 4);
    assert.equal(splitItem.qtdEsperada, 4);
    assert.equal(splitItem.qtdConferida, 4);
    assert.equal(db.lots[0].proximoSequencialSku, 9);
    assert.ok(db.skuReservations.some((reservation) => reservation.sku === "ABC0007" && reservation.status === "consumed" && reservation.productId === created.id));
    assert.ok(db.skuReservations.some((reservation) => reservation.sku === "ABC0008" && reservation.status === "reserved"));
    assert.equal(result.originalProduct.codigoMl, "ABCD12345");
    assert.equal(result.originalProduct.qtdTotal, 4);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("splitLotProduct reuses the previous split SKU for the same original product in the lot", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-split-product-reuse-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-split-product-reuse`;
    const { ensureActiveSkuReservation, readDb, splitLotProduct, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [
        {
          id: "lot-1",
          userId: "user-1",
          nomeArquivo: "Lote",
          percentualArremate: 50,
          fornecedor: "Fornecedor",
          prefixoSku: "ABC",
          proximoSequencialSku: 7,
          createdAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      products: [
        {
          id: "product-original",
          lotId: "lot-1",
          codigoMl: "ABCD12345",
          sku: "ABC0001",
          descricao: "KIT COM 5 PECAS",
          valorUnit: 100,
          precoCusto: 50,
          qtdTotal: 10,
          origem: "planilha",
          createdAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      rzItems: [
        { id: "item-1", lotId: "lot-1", productId: "product-original", codigoRz: "RZ-1", qtdEsperada: 5, qtdConferida: 5, valorTotal: 100, tipoItem: "esperado", createdAt: "2026-08-04T00:00:00.000Z" },
        { id: "item-2", lotId: "lot-1", productId: "product-original", codigoRz: "RZ-2", qtdEsperada: 5, qtdConferida: 5, valorTotal: 100, tipoItem: "esperado", createdAt: "2026-08-04T00:01:00.000Z" }
      ],
      scans: [],
      labels: [],
      skuReservations: [],
      blingIntegrations: []
    });

    await ensureActiveSkuReservation({ userId: "user-1", lotId: "lot-1", operatorUserId: "user-1" });
    const first = await splitLotProduct({
      userId: "user-1",
      operatorUserId: "user-1",
      lotId: "lot-1",
      productId: "product-original",
      codigoRz: "RZ-1",
      payload: { kitQuantity: 5, sellableQuantity: 4, descricao: "PECA UNITARIA" }
    });
    const second = await splitLotProduct({
      userId: "user-1",
      operatorUserId: "user-1",
      lotId: "lot-1",
      productId: "product-original",
      codigoRz: "RZ-2",
      payload: { kitQuantity: 5, sellableQuantity: 3, descricao: "PECA UNITARIA" }
    });

    const db = await readDb();
    const splitProducts = db.products.filter((product) => product.splitSourceProductId === "product-original");
    assert.equal(splitProducts.length, 1);
    assert.equal(first.product.id, second.product.id);
    assert.equal(second.product.sku, "ABC0007");
    assert.equal(splitProducts[0].qtdTotal, 7);
    assert.equal(db.products.find((product) => product.id === "product-original").qtdTotal, 8);
    assert.equal(db.rzItems.find((item) => item.id === "item-1").productId, "product-original");
    assert.equal(db.rzItems.find((item) => item.id === "item-1").qtdEsperada, 4);
    assert.equal(db.rzItems.find((item) => item.id === "item-2").productId, "product-original");
    assert.equal(db.rzItems.find((item) => item.id === "item-2").qtdEsperada, 4);
    assert.equal(db.rzItems.find((item) => item.productId === splitProducts[0].id && item.codigoRz === "RZ-1").qtdEsperada, 4);
    assert.equal(db.rzItems.find((item) => item.productId === splitProducts[0].id && item.codigoRz === "RZ-2").qtdEsperada, 3);
    assert.equal(db.skuReservations.filter((reservation) => reservation.status === "consumed").length, 1);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
