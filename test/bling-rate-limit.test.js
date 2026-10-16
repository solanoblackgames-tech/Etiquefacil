import assert from "node:assert/strict";
import test from "node:test";
import { BlingRateLimiter, getBlingRateLimiter } from "../src/bling-rate-limit.js";
import { syncBlingProducts, updateExistingBlingProducts } from "../src/bling-api.js";

function fakeClock(limiter) {
  let now = Date.parse("2026-10-16T12:00:00Z");
  limiter.now = () => now;
  limiter.sleep = async (ms) => { now += ms; };
  return () => now;
}

test("concurrent product syncs share request spacing across separate API clients", async () => {
  const integration = { userId: "concurrent-rate-limit-test", accessToken: "test-token" };
  const times = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    times.push(Date.now());
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) => updateExistingBlingProducts({
      integration: { ...integration }, products: [{ sku: `SKU${index}` }]
    })));
    assert.equal(times.length, 4);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 450);
    assert.equal(getBlingRateLimiter({ ...integration, accessToken: "refreshed" }), getBlingRateLimiter(integration));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistent 429 ends a sync after three retries so the queue can continue", async () => {
  const integration = { userId: "persistent-rate-limit-test", accessToken: "test-token" };
  fakeClock(getBlingRateLimiter(integration));
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const result = await syncBlingProducts({ integration, products: [{ sku: "SKU" }] });
    assert.equal(calls, 4);
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /429.*fila/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const format of ["seconds", "date"]) {
  test(`429 shares Retry-After cooldown (${format}) with subsequent operations`, async () => {
    const limiter = new BlingRateLimiter();
    const now = fakeClock(limiter);
    const started = now();
    const value = format === "seconds" ? "10" : new Date(started + 10_000).toUTCString();
    limiter.onRateLimit({ headers: new Headers({ "retry-after": value }) }, {}, 0);
    await limiter.acquire();
    assert.equal(now() - started, 10_000);
  });
}

test("daily and long Retry-After limits release the worker without repeated requests", async () => {
  for (const [headers, payload] of [
    [new Headers(), { error: { period: "day" } }],
    [new Headers({ "retry-after": "3600" }), {}]
  ]) {
    const limiter = new BlingRateLimiter();
    const now = fakeClock(limiter);
    const started = now();
    assert.throws(() => limiter.onRateLimit({ headers }, payload, 0), { status: 429 });
    await assert.rejects(limiter.acquire(), { status: 429 });
    assert.equal(now(), started);
  }
});

test("a rejected request slot does not prevent resuming after cooldown", async () => {
  const limiter = new BlingRateLimiter();
  fakeClock(limiter);
  assert.throws(() => limiter.onRateLimit({ headers: new Headers({ "retry-after": "60" }) }, {}, 0));
  await assert.rejects(limiter.acquire());
  await limiter.sleep(60_000);
  await limiter.acquire();
});
