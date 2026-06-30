import assert from "node:assert/strict";
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
