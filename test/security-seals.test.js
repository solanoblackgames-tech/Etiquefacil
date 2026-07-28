import assert from "node:assert/strict";
import test from "node:test";

import { buildSecuritySealCodes, buildSecuritySealsPdf, fullPageSealQuantity, normalizeSecuritySealOptions, securitySealsPerPage } from "../src/security-seals.js";

test("security seal options sanitize printable sequence settings", () => {
  assert.deepEqual(normalizeSecuritySealOptions({ quantity: "700", start: "-10", columns: "9", prefix: " lacre loja! " }), {
    quantity: 500,
    start: 1,
    columns: 8,
    prefix: "LACRE-LOJA",
    pages: 6
  });
});

test("security seal codes fill complete A4 pages", () => {
  const codes = buildSecuritySealCodes({ pages: 1, start: 42, prefix: "LCR" });
  assert.equal(codes.length, 35);
  assert.equal(codes[0], "LCR-000042");
  assert.equal(codes.at(-1), "LCR-000076");
  assert.equal(securitySealsPerPage({ columns: 5 }), 35);
  assert.equal(fullPageSealQuantity({ quantity: 65, columns: 5 }), 70);
});

test("security seal PDF is generated as a PDF buffer", async () => {
  const buffer = await buildSecuritySealsPdf({ quantity: 2, start: 1, prefix: "LCR", columns: 5 });
  assert.equal(buffer.subarray(0, 5).toString("utf8"), "%PDF-");
  assert.ok(buffer.length > 1000);
});
