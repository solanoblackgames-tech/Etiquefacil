import assert from "node:assert/strict";
import test from "node:test";
import { findApprovedProductHistory, findProductHistory, getBlingProducts, summarizeLot } from "../src/lots.js";

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
