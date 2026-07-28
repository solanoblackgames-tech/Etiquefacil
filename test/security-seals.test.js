import assert from "node:assert/strict";
import test from "node:test";

import { buildSecuritySealCodes, buildSecuritySealsPdf, normalizeSecuritySealOptions } from "../src/security-seals.js";

test("security seal options sanitize printable sequence settings", () => {
  assert.deepEqual(normalizeSecuritySealOptions({ quantity: "700", start: "-10", columns: "9", prefix: " lacre loja! " }), {
    quantity: 500,
    start: 1,
    columns: 8,
    prefix: "LACRE-LOJA"
  });
});

test("security seal codes use prefix and six digit sequence", () => {
  assert.deepEqual(buildSecuritySealCodes({ quantity: 3, start: 42, prefix: "LCR" }), ["LCR-000042", "LCR-000043", "LCR-000044"]);
});

test("security seal PDF is generated as a PDF buffer", async () => {
  const buffer = await buildSecuritySealsPdf({ quantity: 2, start: 1, prefix: "LCR", columns: 5 });
  assert.equal(buffer.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.ok(buffer.length > 1000);
});
