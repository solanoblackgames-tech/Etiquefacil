import assert from "node:assert/strict";
import test from "node:test";
import { getBlingProducts, summarizeLot } from "../src/lots.js";

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
      { id: "product-4", lotId: "lot-2", origem: "entrada_diversos" }
    ]
  };

  assert.deepEqual(
    getBlingProducts(db, lot, "complete").map((product) => product.id),
    ["product-1", "product-2"]
  );
});
