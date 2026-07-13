import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findApprovedProductHistory, findProductHistory, getBlingProducts, summarizeLot } from "../src/lots.js";
import { sanitizeUser } from "../src/store.js";

test("summarizeLot calculates lot and RZ progress from scoped records", () => {
  const db = {
    lots: [
      {
        id: "lot-1",
        userId: "user-1",
        nomeArquivo: "Lote.xlsx",
        percentualArremate: 20,
        fornecedor: "FORN",
        prefixoSku: "TST",
        proximoSequencialSku: 2,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ],
    products: [
      {
        id: "product-1",
        lotId: "lot-1",
        codigoMl: "ML1",
        sku: "TST0001",
        descricao: "Produto 1",
        valorUnit: 10,
        precoCusto: 2,
        qtdTotal: 2,
        origem: "planilha",
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ],
    rzItems: [
      {
        id: "item-1",
        lotId: "lot-1",
        productId: "product-1",
        codigoRz: "RZ-1",
        qtdEsperada: 2,
        qtdConferida: 1,
        tipoItem: "esperado",
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]
  };

  const summary = summarizeLot(db, db.lots[0], true);

  assert.equal(summary.totalProducts, 1);
  assert.equal(summary.totalItems, 2);
  assert.equal(summary.progress.expectedQty, 2);
  assert.equal(summary.progress.checkedQty, 1);
  assert.equal(summary.progress.qtyPercent, 50);
  assert.equal(summary.rzs[0].codigoRz, "RZ-1");
  assert.equal(summary.rzs[0].missing, 1);
  assert.equal(summary.items[0].product.codigoMl, "ML1");
});

test("summarizeLot consolidates repeated product rows in the same RZ", () => {
  const db = {
    lots: [{ id: "lot-1", userId: "user-1" }],
    products: [
      {
        id: "product-1",
        lotId: "lot-1",
        codigoMl: "ML1",
        sku: "TST0001",
        descricao: "Produto 1",
        valorUnit: 10,
        origem: "planilha"
      }
    ],
    rzItems: [
      {
        id: "item-1",
        lotId: "lot-1",
        productId: "product-1",
        codigoRz: "RZ-1",
        qtdEsperada: 1,
        qtdConferida: 3,
        tipoItem: "excedente_outro_rz",
        valorTotal: 10
      },
      {
        id: "item-2",
        lotId: "lot-1",
        productId: "product-1",
        codigoRz: "RZ-1",
        qtdEsperada: 1,
        qtdConferida: 0,
        tipoItem: "esperado",
        valorTotal: 10
      }
    ]
  };

  const summary = summarizeLot(db, db.lots[0], true);

  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].qtdEsperada, 2);
  assert.equal(summary.items[0].qtdConferida, 3);
  assert.equal(summary.items[0].tipoItem, "excedente_outro_rz");
  assert.equal(summary.rzs[0].expected, 2);
  assert.equal(summary.rzs[0].checked, 3);
  assert.equal(summary.rzs[0].missing, 0);
  assert.equal(summary.rzs[0].excess, 1);
});

test("summarizeLot includes the latest scan timestamp for each RZ item", () => {
  const db = {
    lots: [{ id: "lot-1", userId: "user-1" }],
    products: [
      {
        id: "product-1",
        lotId: "lot-1",
        codigoMl: "ML1",
        sku: "TST0001",
        ean: "789",
        descricao: "Produto 1",
        valorUnit: 10,
        origem: "planilha"
      }
    ],
    rzItems: [
      {
        id: "item-1",
        lotId: "lot-1",
        productId: "product-1",
        codigoRz: "RZ-1",
        qtdEsperada: 1,
        qtdConferida: 1,
        tipoItem: "esperado",
        valorTotal: 10
      }
    ],
    scans: [
      { id: "scan-1", lotId: "lot-1", codigoRz: "RZ-1", codigoMl: "ML1", status: "ok", createdAt: "2026-07-03T10:00:00.000Z" },
      { id: "scan-2", lotId: "lot-1", codigoRz: "RZ-1", codigoMl: "TST0001", status: "ok", createdAt: "2026-07-03T10:05:00.000Z" }
    ]
  };

  const summary = summarizeLot(db, db.lots[0], true);

  assert.equal(summary.items[0].lastScanAt, "2026-07-03T10:05:00.000Z");
});

test("getBlingProducts includes diverse entry items in complete export", () => {
  const lot = { id: "lot-1" };
  const db = {
    products: [
      { id: "product-1", lotId: "lot-1", origem: "planilha" },
      { id: "product-2", lotId: "lot-1", origem: "entrada_diversos" },
      { id: "product-3", lotId: "lot-1", origem: "excedente_externo" },
      { id: "product-4", lotId: "lot-2", origem: "entrada_diversos" },
      { id: "product-5", lotId: "lot-1", origem: "lote_sem_planilha_manual" }
    ]
  };

  assert.deepEqual(
    getBlingProducts(db, lot, "complete").map((product) => product.id),
    ["product-1", "product-2", "product-5"]
  );
});

test("manual no-sheet products are exported as Bling excess", () => {
  const lot = { id: "lot-1" };
  const db = {
    lots: [lot],
    products: [
      { id: "product-1", lotId: "lot-1", origem: "lote_sem_planilha" },
      { id: "product-2", lotId: "lot-1", origem: "lote_sem_planilha_manual" },
      { id: "product-3", lotId: "lot-1", origem: "excedente_externo" },
      { id: "product-4", lotId: "lot-2", origem: "lote_sem_planilha_manual" }
    ],
    rzItems: []
  };

  assert.equal(summarizeLot(db, lot).totalExcessExternal, 2);
  assert.deepEqual(
    getBlingProducts(db, lot, "excess").map((product) => product.id),
    ["product-2", "product-3"]
  );
});

test("summarizeLot preserves manual no-sheet item type", () => {
  const lot = { id: "lot-1" };
  const db = {
    users: [],
    lots: [lot],
    products: [
      { id: "product-1", lotId: "lot-1", valorUnit: 25, origem: "lote_sem_planilha_manual" }
    ],
    rzItems: [
      {
        id: "rz-1",
        lotId: "lot-1",
        productId: "product-1",
        codigoRz: "PRI260626",
        qtdEsperada: 2,
        qtdConferida: 0,
        tipoItem: "lote_sem_planilha_manual",
        valorTotal: 50,
        createdAt: "2026-07-10T00:00:00.000Z"
      }
    ],
    scans: []
  };

  const summary = summarizeLot(db, lot, true);

  assert.equal(summary.items[0].tipoItem, "lote_sem_planilha_manual");
  assert.equal(summary.rzs[0].codigoRz, "PRI260626");
});

test("findApprovedProductHistory only returns history approved in catalog", () => {
  const db = {
    lots: [
      { id: "old-lot", userId: "user-1" },
      { id: "current-lot", userId: "user-1" },
      { id: "other-user-lot", userId: "user-2" }
    ],
    products: [
      {
        id: "pending-suggestion",
        lotId: "old-lot",
        codigoMl: "ML-PENDING",
        origem: "lote_sem_planilha_manual",
        createdAt: "2026-06-17T00:00:00.000Z"
      },
      {
        id: "approved-suggestion",
        lotId: "old-lot",
        codigoMl: "ML-APPROVED",
        descricao: "Produto antigo incorreto",
        valorUnit: 500,
        origem: "lote_sem_planilha_manual",
        createdAt: "2026-06-17T00:00:00.000Z"
      },
      {
        id: "unapproved-sheet-history",
        lotId: "old-lot",
        codigoMl: "ML-SHEET-PENDING",
        origem: "planilha",
        createdAt: "2026-06-17T00:00:00.000Z"
      },
      {
        id: "approved-sheet-history",
        lotId: "old-lot",
        codigoMl: "ML-SHEET-APPROVED",
        origem: "planilha",
        createdAt: "2026-06-17T00:00:00.000Z"
      },
      {
        id: "other-user-history",
        lotId: "other-user-lot",
        codigoMl: "ML-SHEET-APPROVED",
        origem: "planilha",
        createdAt: "2026-06-18T00:00:00.000Z"
      }
    ],
    catalogProducts: [
      { id: "catalog-1", codigoMl: "ML-APPROVED", descricao: "Produto oficial aprovado", valorUnit: 105 },
      { id: "catalog-2", codigoMl: "ML-SHEET-APPROVED", descricao: "Produto de planilha aprovado", valorUnit: 220 }
    ]
  };

  assert.deepEqual(findApprovedProductHistory(db, "user-1", "current-lot", "ML-PENDING"), []);
  assert.deepEqual(findApprovedProductHistory(db, "user-1", "current-lot", "ML-SHEET-PENDING"), []);
  assert.deepEqual(
    findApprovedProductHistory(db, "user-1", "current-lot", "ML-APPROVED").map((product) => product.id),
    ["approved-suggestion"]
  );
  assert.deepEqual(
    findApprovedProductHistory(db, "user-1", "current-lot", "ML-APPROVED").map((product) => [product.descricao, product.valorUnit]),
    [["Produto oficial aprovado", 105]]
  );
  assert.deepEqual(
    findApprovedProductHistory(db, "user-1", "current-lot", "ML-SHEET-APPROVED").map((product) => product.id),
    ["approved-sheet-history"]
  );
});

test("findProductHistory returns previous products from same user even before catalog approval", () => {
  const db = {
    lots: [
      { id: "old-lot", userId: "user-1" },
      { id: "current-lot", userId: "user-1" },
      { id: "other-user-lot", userId: "user-2" }
    ],
    products: [
      { id: "same-user-history", lotId: "old-lot", codigoMl: "ML-PENDING", createdAt: "2026-06-17T00:00:00.000Z" },
      { id: "other-user-history", lotId: "other-user-lot", codigoMl: "ML-PENDING", createdAt: "2026-06-18T00:00:00.000Z" }
    ]
  };

  assert.deepEqual(
    findProductHistory(db, "user-1", "current-lot", "ML-PENDING").map((product) => product.id),
    ["same-user-history"]
  );
});

test("admin lot summaries can include lots from different users with owner data", () => {
  const db = {
    users: [
      { id: "user-1", name: "Loja A", email: "a@example.com" },
      { id: "user-2", name: "Loja B", email: "b@example.com" }
    ],
    lots: [
      { id: "lot-1", userId: "user-1", nomeArquivo: "Lote A", createdAt: "2026-06-18T00:00:00.000Z" },
      { id: "lot-2", userId: "user-2", nomeArquivo: "Lote B", createdAt: "2026-06-19T00:00:00.000Z" }
    ],
    products: [
      { id: "product-1", lotId: "lot-1", origem: "planilha" },
      { id: "product-2", lotId: "lot-2", origem: "planilha" }
    ],
    rzItems: []
  };
  const usersById = new Map(db.users.map((user) => [user.id, sanitizeUser(user)]));
  const lots = db.lots
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((lot) => ({ ...summarizeLot(db, lot), user: usersById.get(lot.userId) }));

  assert.deepEqual(lots.map((lot) => [lot.nomeArquivo, lot.user.email]), [
    ["Lote B", "b@example.com"],
    ["Lote A", "a@example.com"]
  ]);
});

test("scanLotRz counts one unit per scan for multi-quantity SKU", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-rz-scan-quantity-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-rz-scan-quantity`;
    const { scanLotRz, readDb, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-07-03T00:00:00.000Z" }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto com varias unidades",
          valorUnit: 10,
          precoCusto: 2,
          qtdTotal: 4,
          origem: "planilha",
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      rzItems: [
        {
          id: "item-1",
          lotId: "lot-1",
          productId: "product-1",
          codigoRz: "RZ-1",
          qtdEsperada: 4,
          qtdConferida: 0,
          tipoItem: "esperado",
          valorTotal: 40,
          createdAt: "2026-07-03T00:00:00.000Z"
        }
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

    const result = await scanLotRz({ userId: "user-1", lotId: "lot-1", codigoRz: "RZ-1", codigoMl: "SKU1" });
    const db = await readDb();

    assert.equal(result.scan.status, "ok");
    assert.equal(result.lot.progress.checkedQty, 1);
    assert.equal(result.lot.progress.expectedQty, 4);
    assert.equal(result.lot.rzs[0].checked, 1);
    assert.equal(result.lot.rzs[0].missing, 3);
    assert.equal(result.lot.items[0].qtdConferida, 1);
    assert.equal(db.rzItems[0].qtdConferida, 1);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("no-sheet lot suggestions keep suggested sale price", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-no-sheet-suggestion-price-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-no-sheet-suggestion-price`;
    const { createDiverseLot, suggestNoSheetProducts } = await import(storeUrl.href);

    const lot = await createDiverseLot({
      userId: "user-1",
      name: "Lote sem planilha",
      fornecedor: "Fornecedor",
      skuPrefix: "DIV",
      startSequence: 1,
      averageCost: 10,
      suggestions: [
        { descricao: "Kit vestido infantil", valorUnit: "129,90" },
        { descricao: "Sapato social", maiorPreco: "89.50" }
      ]
    });

    const result = await suggestNoSheetProducts({ userId: "user-1", lotId: lot.id, query: "vestido" });
    const alternateResult = await suggestNoSheetProducts({ userId: "user-1", lotId: lot.id, query: "sapato" });

    assert.equal(result.source, "lista_lote");
    assert.deepEqual(result.suggestions.map((suggestion) => [suggestion.descricao, suggestion.valorUnit]), [
      ["Kit vestido infantil", 129.9]
    ]);
    assert.deepEqual(alternateResult.suggestions.map((suggestion) => [suggestion.descricao, suggestion.valorUnit]), [
      ["Sapato social", 89.5]
    ]);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
