import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeConfig } from "../src/config.js";

test("buildRuntimeConfig requires Postgres and a strong session secret in production", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        NODE_ENV: "production",
        DATABASE_URL: "",
        SESSION_SECRET: ""
      }),
    /DATABASE_URL/
  );

  assert.throws(
    () =>
      buildRuntimeConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://example",
        SESSION_SECRET: "short"
      }),
    /SESSION_SECRET/
  );
});

test("buildRuntimeConfig keeps local development defaults", () => {
  const config = buildRuntimeConfig({});

  assert.equal(config.port, 3000);
  assert.equal(config.downloadMode, "local");
  assert.equal(config.nodeEnv, "development");
  assert.equal(config.cookieSecure, false);
});

test("buildRuntimeConfig uses browser downloads and secure cookies in production", () => {
  const config = buildRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://example",
    SESSION_SECRET: "a".repeat(48)
  });

  assert.equal(config.downloadMode, "browser");
  assert.equal(config.cookieSecure, true);
  assert.equal(config.trustProxy, 1);
});
