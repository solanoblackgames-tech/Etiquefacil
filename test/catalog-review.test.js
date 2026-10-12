import assert from "node:assert/strict";
import test from "node:test";
import { computeCatalogReviewSignals, measureConflicts, textSimilarity } from "../src/catalog-review.js";

function request(descricao, valorUnit, doubleChecks = [], ean = "") {
  return { descricao, valorUnit, ean, doubleChecks };
}

test("textSimilarity ignores accents, case and filler words", () => {
  assert.equal(textSimilarity("Chaleira Elétrica Inox 1,8 Litros", "CHALEIRA ELETRICA INOX 1,8 LITROS - Novo"), 1);
  assert.ok(textSimilarity("Tênis Nike Air Max Preto", "Liquidificador Mondial Vermelho") < 0.1);
});

test("measureConflicts flags same unit with different values only", () => {
  assert.deepEqual(measureConflicts("Liquidificador Mondial 220v", "Liquidificador Mondial 127 V"), ["220v x 127v"]);
  assert.deepEqual(measureConflicts("Shampoo 300ml", "Shampoo 300 ml"), []);
  assert.deepEqual(measureConflicts("Copo 300ml", "Copo 2 litros"), []);
});

test("single suggestion without double check is marked unico", () => {
  const signals = computeCatalogReviewSignals(request("Mixer Cadence Preto 127v", 65));
  assert.equal(signals.status, "unico");
  assert.equal(signals.optionCount, 1);
});

test("matching double checks are concordante and recommended for approval", () => {
  const signals = computeCatalogReviewSignals(request("Mixer Cadence Mixture Preto 127v", 65, [
    { descricao: "Mixer Cadence Mixture Preto 127V", valorUnit: 66, ean: "" }
  ]));
  assert.equal(signals.status, "concordante");
  assert.equal(signals.recommendation, "approve");
  assert.deepEqual(signals.reasons, ["Descrições iguais"]);
});

test("unrelated descriptions under the same ML code are divergente", () => {
  const signals = computeCatalogReviewSignals(request("Tênis Nike Air Max Masculino Preto 42", 299, [
    { descricao: "Liquidificador Mondial Turbo Vermelho", valorUnit: 189 }
  ]));
  assert.equal(signals.status, "divergente");
  assert.match(signals.reasons[0], /provável Código ML errado/);
});

test("voltage mismatch or different EANs make the group divergente", () => {
  const voltage = computeCatalogReviewSignals(request("Liquidificador Mondial Turbo 220v", 189, [
    { descricao: "Liquidificador Mondial Turbo 127v", valorUnit: 189 }
  ]));
  assert.equal(voltage.status, "divergente");
  assert.deepEqual(voltage.measureConflicts, ["220v x 127v"]);

  const ean = computeCatalogReviewSignals(request("Fone Bluetooth JBL Tune 510", 199, [
    { descricao: "Fone Bluetooth JBL Tune 510", valorUnit: 199, ean: "7891234567890" }
  ], "7890000000001"));
  assert.equal(ean.status, "divergente");
  assert.equal(ean.eanConflict, true);
});

test("similar text with a big price gap goes to revisar", () => {
  const signals = computeCatalogReviewSignals(request("Panela de Pressão Tramontina 4,5 Litros", 120, [
    { descricao: "Panela de Pressão Tramontina 4,5 Litros", valorUnit: 160 }
  ]));
  assert.equal(signals.status, "revisar");
  assert.ok(signals.reasons.some((reason) => reason.includes("Preço varia 33%")));
});
