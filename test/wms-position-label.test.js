import test from "node:test";
import assert from "node:assert/strict";
import { assertValidWmsPosition } from "../src/wms-units.js";
import { wmsPositionLabel } from "../public/wms-position-label.js";

test("physical B2B labels round-trip without changing stored addresses", () => {
  const deposit = { depositName: "VENDA B2B", prefix: "B2B", rowsConfig: [
    { label: "C", columns: 20, positions: 4 },
    { label: "D", columns: 11, positions: 4 },
    { label: "E", columns: 15, positions: 4 },
    { label: "F", columns: 15, positions: 4 }
  ] };
  for (const [street, start, end] of [["D", 265, 306], ["E", 307, 366], ["F", 367, 426]]) {
    for (let number = start; number <= end; number++) {
      const address = assertValidWmsPosition(deposit, `${street}${number}`);
      const offset = number - start;
      assert.equal(wmsPositionLabel(address, deposit.depositName),
        `${street}${number} · Rua ${street} · C${String(Math.floor(offset / 3) + 1).padStart(2, "0")} A${offset % 3 + 1}`);
    }
  }
  assert.equal(wmsPositionLabel(assertValidWmsPosition(deposit, "RUA C POSICAO 196 ANDAR 4 ESQUERDO"), deposit.depositName), "Posição 196 · Rua C · C03 A4");
  assert.equal(wmsPositionLabel("ECOM-D-1-1", "Ecommerce"), "ECOM-D-1-1");
});
