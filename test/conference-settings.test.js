import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConferenceSettings } from "../src/store.js";

test("old category review flag does not enable review before print", () => {
  const settings = normalizeConferenceSettings({
    fields: {
      category: {
        enabled: true,
        required: false,
        askBeforePrint: true
      }
    }
  });

  assert.equal(settings.fields.category.askBeforePrint, true);
  assert.equal(settings.reviewBeforePrint, false);
});

test("explicit review before print setting is preserved", () => {
  assert.equal(normalizeConferenceSettings({ reviewBeforePrint: true }).reviewBeforePrint, true);
  assert.equal(normalizeConferenceSettings({ reviewBeforePrint: false }).reviewBeforePrint, false);
});
