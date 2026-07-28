import assert from "node:assert/strict";
import test from "node:test";

import { buildSecuritySealCodes, buildSecuritySealsPdf, fullPageSealQuantity, normalizeSecuritySealOptions, securitySealsPerPage } from "../src/security-seals.js";

test("security seal options sanitize printable sequence settings", () => {
  assert.deepEqual(normalizeSecuritySealOptions({ quantity: "700", start: "-10", prefix: " lacre loja! " }), {
    quantity: 700,
    start: 1,
    prefix: "LACRE-LOJA",
    pages: 4
  });
});

test("security seal codes fill complete A4 pages", () => {
  const codes = buildSecuritySealCodes({ pages: 1, start: 42, prefix: "LCR" });
  assert.equal(codes.length, 204);
  assert.equal(codes[0], "LCR-000042");
  assert.equal(codes.at(-1), "LCR-000245");
  assert.equal(securitySealsPerPage(), 204);
  assert.equal(fullPageSealQuantity({ quantity: 205 }), 408);
});

test("security seal PDF is generated as a PDF buffer", async () => {
  const buffer = await buildSecuritySealsPdf({ quantity: 2, start: 1, prefix: "LCR" });
  assert.equal(buffer.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.ok(buffer.length > 1000);
});
