import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { registerPrivateClassLot, isPrivateClassLot } from "../src/private-class-labels.js";

const server = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
const source = server.slice(server.indexOf('app.post("/api/lots/unified"'), server.indexOf('app.post("/api/lots",'));

async function create({ classes = false, allowed = false, file = false, supplierFailure = false } = {}) {
  const saved = { labels: [], pallets: [], events: [], batches: [] };
  const created = [];
  let handler;
  const context = vm.createContext({
    app: { post(_path, ...args) { handler = args.at(-1); } },
    requireAuth() {}, requireOwner() {}, upload: { single() {} },
    workspaceUserId: () => "solano",
    parsePositiveInteger: (value) => Number(value),
    createDiverseLot: async (payload) => { created.push(payload); return { id: "new-lot", nomeArquivo: payload.name }; },
    withClassState: async (_user, fn) => fn(saved),
    registerPrivateClassLot,
    syncPrivateClassLotSupplier: async (_userId, lot) => ({ ok: !supplierFailure, name: lot.fornecedor, ...(supplierFailure ? { error: "Bling indisponivel" } : { supplierId: 123 }) }),
    sendError: (res, error) => res.status(400).json({ error: error.message })
  });
  vm.runInContext(source, context);
  const req = {
    body: { name: "Entrada", fornecedor: "Fornecedor", skuPrefix: "SKU", startSequence: "1", costMode: "fixed", averageCost: "10", ...(classes ? { lotMode: "classes" } : {}) },
    session: { user: { id: "solano", name: "Solano", privateClassesAccess: allowed } },
    ...(file ? { file: { originalname: "lista.xlsx" } } : {})
  };
  const res = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res);
  return { res, saved, created };
}

test("criar lote continua criando lote normal mesmo na conta autorizada", async () => {
  for (const allowed of [false, true]) {
    const { res, saved, created } = await create({ allowed });
    assert.equal(res.code, 200);
    assert.equal(res.body.mode, "empty");
    assert.equal(res.body.lot.classMode, undefined);
    assert.equal(isPrivateClassLot(saved, res.body.lot.id), false);
    assert.equal(created.length, 1);
  }
});

test("criar lote por classe registra o tipo explicitamente apenas na conta autorizada", async () => {
  const { res, saved } = await create({ classes: true, allowed: true });
  assert.equal(res.code, 200);
  assert.equal(res.body.mode, "classes");
  assert.equal(res.body.lot.classMode, true);
  assert.equal(isPrivateClassLot(saved, res.body.lot.id), true);
  assert.equal(res.body.supplierSync.ok, true);
  assert.equal(res.body.supplierSync.supplierId, 123);
});

test("falha do fornecedor no Bling nao impede criar lote por classe", async () => {
  const { res, saved, created } = await create({ classes: true, allowed: true, supplierFailure: true });
  assert.equal(res.code, 200);
  assert.equal(created.length, 1);
  assert.equal(res.body.supplierSync.ok, false);
  assert.equal(res.body.supplierSync.error, "Bling indisponivel");
  assert.equal(isPrivateClassLot(saved, res.body.lot.id), true);
});

test("pedido de lote por classe por outra conta e bloqueado antes de criar registros", async () => {
  const { res, saved, created } = await create({ classes: true });
  assert.equal(res.code, 403);
  assert.equal(created.length, 0);
  assert.equal(saved.classLots, undefined);
});

test("lote por classe nao aceita planilha e nao cria lote parcial nessa tentativa", async () => {
  const { res, created } = await create({ classes: true, allowed: true, file: true });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /sem planilha/);
  assert.equal(created.length, 0);
});
