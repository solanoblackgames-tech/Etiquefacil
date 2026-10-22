import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { withClassState, generateClassBatch, changeClassPallet, classSummary, hasPrivateClassAccess, registerPrivateClassLot, isPrivateClassLot } from "../src/private-class-labels.js";
import { privateClassRoutes, attachPrivateClassPallets } from "../src/private-class-routes.js";

const empty = () => ({ labels: [], batches: [], pallets: [], events: [] });
const actor = { id: "owner", name: "Responsavel" };
const move = (state, code, action = "add", codigoRz = "P1", lotId = "lot") => changeClassPallet(state, { lotId, lotName: "Lote sem lista", codigoRz, code, action, actor });

test("controle por classe e exclusivo da conta Solano Black Games", () => {
  assert.equal(hasPrivateClassAccess({ email: " SolanoBlackGames@gmail.com " }), true);
  assert.equal(hasPrivateClassAccess({ email: "outra@example.com" }), false);
  assert.equal(hasPrivateClassAccess(null), false);
});

test("lotes normais continuam sem classe e o lote ja iniciado preserva todos os dados", async () => {
  const state = empty();
  const normalLot = { id: "normal", percentualArremate: 0, rzs: [] };
  const withState = async (_user, fn) => fn(state);
  await attachPrivateClassPallets("u1", normalLot, { allowed: true, withState });
  assert.deepEqual(normalLot, { id: "normal", percentualArremate: 0, rzs: [] });
  generateClassBatch(state, { grade: "A", quantity: 2, actor });
  move(state, state.labels[0].code);
  move(state, null, "close");
  const saved = structuredClone(state);
  const existing = { id: "lot", percentualArremate: 0, rzs: [] };
  await attachPrivateClassPallets("u1", existing, { allowed: true, withState });
  assert.equal(existing.classMode, true);
  assert.equal(existing.classCounts.A, 1);
  assert.equal(existing.classCounts.pallets[0].closedBy.id, actor.id);
  assert.deepEqual(existing.rzs[0].classCounts, { A: 1, B: 0, total: 1 });
  assert.deepEqual(state, saved);
  await attachPrivateClassPallets("u2", normalLot, { allowed: false, withState: () => { throw new Error("Nao deve consultar dados"); } });
});

test("novo lote por classe e identificado antes de receber a primeira etiqueta", async () => {
  const state = empty();
  const lot = { id: "new", nomeArquivo: "Novo por classe", rzs: [] };
  registerPrivateClassLot(state, lot, actor);
  registerPrivateClassLot(state, lot, actor);
  assert.equal(state.classLots.length, 1);
  assert.equal(isPrivateClassLot(state, "new"), true);
  assert.equal(isPrivateClassLot(state, "normal"), false);
  await attachPrivateClassPallets("u1", lot, { allowed: true, withState: async (_user, fn) => fn(state) });
  assert.equal(lot.classMode, true);
  assert.equal(lot.classCounts.total, 0);
});

test("cada etiqueta e unica e gerar etiquetas nao aumenta a contagem nos pallets", () => {
  const state = empty();
  generateClassBatch(state, { grade: "A", quantity: 100, actor });
  generateClassBatch(state, { grade: "B", quantity: 50, actor });
  assert.equal(new Set(state.labels.map((label) => label.code)).size, 150);
  assert.ok(state.labels.every((label) => /^[A-F0-9]{32}$/.test(label.code)));
  assert.deepEqual(classSummary(state, "lot"), { pallets: [], A: 0, B: 0, total: 0 });
  for (const quantity of [0, -1, 1.5, 1001, "5", NaN]) assert.throws(() => generateClassBatch(state, { grade: "A", quantity, actor }));
  assert.throws(() => generateClassBatch(state, { grade: "C", quantity: 1, actor }));
});

test("conta por pallet e lote, impede duplicidade e permite retirar e mover", () => {
  const state = empty();
  generateClassBatch(state, { grade: "A", quantity: 2, actor });
  generateClassBatch(state, { grade: "B", quantity: 1, actor });
  const [a1, a2, b1] = state.labels.map((label) => label.code);
  move(state, a1);
  move(state, b1);
  move(state, a2, "add", "P2");
  assert.throws(() => move(state, a1), /ja foi colocada/);
  assert.throws(() => move(state, a1, "add", "P2", "outro-lote"), /ja foi colocada/);
  assert.throws(() => move(state, a1, "remove", "P2"), /nao pertence/);
  assert.deepEqual(classSummary(state, "lot").pallets.map(({ codigoRz, A, B }) => ({ codigoRz, A, B })), [{ codigoRz: "P1", A: 1, B: 1 }, { codigoRz: "P2", A: 1, B: 0 }]);
  move(state, a1, "remove");
  assert.equal(classSummary(state, "lot").total, 2);
  move(state, a1, "add", "P2");
  assert.equal(classSummary(state, "lot").total, 3);
  assert.equal(classSummary(state, "lot").pallets[1].A, 2);
  assert.equal(state.events.length, 5);
});

test("fechamento preserva composicao, data, responsavel e bloqueia alteracoes", () => {
  const state = empty();
  generateClassBatch(state, { grade: "B", quantity: 2, actor });
  move(state, state.labels[0].code);
  move(state, null, "close");
  const closed = classSummary(state, "lot").pallets[0];
  assert.deepEqual(closed.snapshot, { A: 0, B: 1, total: 1 });
  assert.equal(closed.closedBy.id, actor.id);
  assert.ok(closed.closedAt);
  assert.throws(() => move(state, state.labels[0].code, "remove"), /fechada/);
  assert.throws(() => move(state, state.labels[1].code), /fechada/);
  assert.throws(() => move(state, null, "close", "vazio"), /Inclua etiquetas/);
});

test("persistencia serializa bipagens simultaneas e isola as contas", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "class-labels-"));
  const options = { directory, pool: null };
  try {
    const code = await withClassState("u1", (state) => { generateClassBatch(state, { grade: "A", quantity: 1, actor }); return state.labels[0].code; }, options);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => withClassState("u1", (state) => move(state, code), options)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await withClassState("u1", (state) => classSummary(state, "lot").total, options), 1);
    await assert.rejects(withClassState("u2", (state) => move(state, code), options), /nao encontrada/);
    assert.equal(await withClassState("u2", (state) => state.labels.length, options), 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("API completa: emissao, impressao privada, bipagem, exportacao e autorizacao", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "class-api-"));
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  let supplierCalls = 0;
  app.use("/api/private-classes", privateClassRoutes({
    requireAuth(req, res, next) {
      const id = req.get("x-user");
      if (!id) return res.status(401).json({ error: "Login obrigatorio" });
      req.session = { user: { id, name: id, role: req.get("x-role") || "owner", privateClassesAccess: id === "u1" } };
      next();
    },
    requireTriageAccess: pass,
    requireOwner(req, res, next) { if (req.session.user.role === "operator") return res.status(403).json({ error: "Restrito" }); next(); },
    workspaceUserId: (req) => req.session.user.id,
    syncLotSupplier: async () => { supplierCalls++; return { ok: true, supplierId: 123 }; },
    getUserLotDetail: async (userId, lotId) => ["lot", "normal"].includes(lotId) && userId === "u1" ? { id: lotId, nomeArquivo: "Lote", percentualArremate: 0 } : null,
    withState: (userId, fn) => withClassState(userId, fn, { directory, pool: null })
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const root = `http://127.0.0.1:${server.address().port}/api/private-classes`;
  const call = (url, body, user = "u1", role = "owner") => fetch(root + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(user ? { "x-user": user, "x-role": role } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("/batches", null, null)).status, 401);
    assert.equal((await call("/batches", null, "u2")).status, 403);
    assert.equal((await call("/batches", { grade: "A", quantity: 1 }, "u2")).status, 403);
    await withClassState("u1", (state) => registerPrivateClassLot(state, { id: "lot", nomeArquivo: "Lote por classe" }, actor), { directory, pool: null });
    const { batch } = await (await call("/batches", { grade: "A", quantity: 2 })).json();
    const html = await (await call(`/batches/${batch.id}/print`)).text();
    assert.equal((html.match(/<section>/g) || []).length, 2);
    assert.ok(!html.includes("Classe A"));
    const code = html.match(/<small>([A-F0-9]{32})<\/small>/)[1];
    assert.equal((await call(`/batches/${batch.id}/print`, null, "u2")).status, 403);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "add", code }, "u2")).status, 403);
    assert.equal((await call("/lots/normal/pallets/P1", { action: "add", code })).status, 400);
    assert.equal((await call("/lots/normal")).status, 400);
    assert.equal((await call("/lots/lot/supplier", {}, "u2")).status, 403);
    assert.equal((await call("/lots/lot/supplier", {}, "u1", "operator")).status, 403);
    assert.equal((await call("/lots/normal/supplier", {})).status, 400);
    assert.equal(supplierCalls, 0);
    assert.equal((await (await call("/lots/lot/supplier", {})).json()).supplierSync.supplierId, 123);
    assert.equal(supplierCalls, 1);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "add", code })).status, 200);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "add", code })).status, 400);
    const summary = await (await call("/lots/lot")).json();
    assert.equal(summary.A, 1);
    assert.equal(summary.events[0].actor.id, "u1");
    assert.equal((await call("/lots/lot/pallets/P1", { action: "close" }, "u1", "operator")).status, 400);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "close" })).status, 200);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "remove", code })).status, 400);
    const csv = await (await call("/lots/lot/export")).text();
    assert.match(csv, /"P1";"1";"0";"1"/);
    assert.match(csv, /"TOTAL";"1";"0";"1"/);
    const reprint = await (await call(`/batches/${batch.id}/print`)).text();
    assert.equal(reprint, html);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
