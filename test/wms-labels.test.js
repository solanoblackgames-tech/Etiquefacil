import assert from "node:assert/strict";
import test from "node:test";
import { buildWmsLocationLabelsPdf, buildWmsPositionCodes, normalizeWmsDeposit } from "../src/wms-labels.js";

test("buildWmsPositionCodes expands rows columns and positions with the configured prefix", () => {
  const codes = buildWmsPositionCodes({
    depositName: "Soldim Ecommerce",
    prefix: "Ecom",
    rowsConfig: [
      { label: "A", columns: 1, positions: 2 },
      { label: "B", columns: 2, positions: 2 }
    ]
  });

  assert.deepEqual(codes, [
    "ECOM-A-1-1",
    "ECOM-A-1-2",
    "ECOM-B-1-1",
    "ECOM-B-1-2",
    "ECOM-B-2-1",
    "ECOM-B-2-2"
  ]);
});

test("normalizeWmsDeposit sanitizes dimensions and prefix", () => {
  assert.deepEqual(normalizeWmsDeposit({ depositName: "Ecommerce", prefix: " Écom ", rows: 0, columns: 3, positions: 4 }), {
    depositName: "Ecommerce",
    prefix: "ECOM",
    rowsConfig: [{ label: "A", columns: 3, positions: 4 }],
    rows: 1,
    columns: 3,
    positions: 4
  });
});

test("buildWmsLocationLabelsPdf creates a 100x150 QR label PDF", async () => {
  const buffer = await buildWmsLocationLabelsPdf({ depositName: "Ecommerce", prefix: "ECOM", rows: 1, columns: 1, positions: 1 });

  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
});
