import assert from "node:assert/strict";
import test from "node:test";
import { syncBlingSupplier } from "../src/bling-api.js";
import { syncClassLotSupplier } from "../src/class-lot-supplier.js";

test("fornecedor e criado no Bling sem cadastrar produtos ou movimentar estoque", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const replies = [{ data: [{ id: 2, descricao: "Fornecedor" }] }, { data: [] }, { data: { id: 99 } }];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    return { ok: true, status: 200, headers: new Headers(), json: async () => replies.shift() };
  };
  try {
    const result = await syncBlingSupplier({ integration: { accessToken: "supplier-only-create" }, name: "ALIEXPRESS09" });
    assert.deepEqual(result, { id: 99, name: "ALIEXPRESS09" });
    const writes = calls.filter((call) => call.method !== "GET");
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith("/contatos"));
    assert.equal(writes[0].body.nome, "ALIEXPRESS09");
    assert.ok(writes[0].body.tiposContato.some((type) => type.id === 2));
    assert.ok(calls.every((call) => !/produtos|estoques/.test(call.url)));
  } finally { globalThis.fetch = originalFetch; }
});

test("fornecedor existente e reutilizado sem duplicar o contato", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const replies = [{ data: [{ id: 2, descricao: "Fornecedor" }] }, { data: [{ id: 88, nome: "Fornecedor Existente" }] }, { data: { id: 88, nome: "Fornecedor Existente", tiposContato: [{ id: 2 }] } }];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    return { ok: true, status: 200, headers: new Headers(), json: async () => replies.shift() };
  };
  try {
    const result = await syncBlingSupplier({ integration: { accessToken: "supplier-only-reuse" }, name: "Fornecedor Existente" });
    assert.equal(result.id, 88);
    assert.ok(calls.every((call) => call.method === "GET"));
    const repeated = await syncBlingSupplier({ integration: { accessToken: "supplier-only-reuse" }, name: "Fornecedor Existente" });
    assert.equal(repeated.id, 88);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("pendencia do fornecedor pode ser resolvida preservando etiquetas e historico do lote", async () => {
  const state = { batches: [{ id: "batch" }], labels: [{ code: "code", lotId: "lot" }], pallets: [{ lotId: "lot", codigoRz: "01" }], events: [{ lotId: "lot", action: "add" }] };
  const original = structuredClone(state);
  const lot = { id: "lot", nomeArquivo: "Existente", fornecedor: "ALIEXPRESS09" };
  const withState = async (_userId, fn) => fn(state);
  const failed = await syncClassLotSupplier({ userId: "u1", lot, withState, getCredentials: async () => { throw new Error("Autorize o Bling"); } });
  assert.equal(failed.ok, false);
  assert.equal(state.classLots[0].supplierSync.error, "Autorize o Bling");
  const success = await syncClassLotSupplier({ userId: "u1", lot, withState, getCredentials: async () => ({ accessToken: "token" }), syncSupplier: async ({ name }) => ({ id: 99, name }) });
  assert.equal(success.ok, true);
  assert.equal(state.classLots.length, 1);
  assert.equal(state.classLots[0].supplierSync.supplierId, 99);
  for (const key of ["batches", "labels", "pallets", "events"]) assert.deepEqual(state[key], original[key]);
});
