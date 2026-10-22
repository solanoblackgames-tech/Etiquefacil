import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { withClassState, generateClassBatch, changeClassPallet, classSummary } from "../src/private-class-labels.js";
import { privateClassRoutes } from "../src/private-class-routes.js";

const empty = () => ({ labels: [], batches: [], pallets: [], events: [] });
const actor = { id: "owner", name: "Responsavel" };
const move = (state, code, action = "add", codigoRz = "P1", lotId = "lot") => changeClassPallet(state, { lotId, lotName: "Lote sem lista", codigoRz, code, action, actor });

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
  app.use("/api/private-classes", privateClassRoutes({
    requireAuth(req, res, next) {
      const id = req.get("x-user");
      if (!id) return res.status(401).json({ error: "Login obrigatorio" });
      req.session = { user: { id, name: id, role: req.get("x-role") || "owner" } };
      next();
    },
    requireTriageAccess: pass,
    requireOwner(req, res, next) { if (req.session.user.role === "operator") return res.status(403).json({ error: "Restrito" }); next(); },
    workspaceUserId: (req) => req.session.user.id,
    getUserLotDetail: async (userId, lotId) => lotId === "lot" && userId === "u1" ? { id: lotId, nomeArquivo: "Lote sem lista", percentualArremate: 0 } : null,
    withState: (userId, fn) => withClassState(userId, fn, { directory, pool: null })
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const root = `http://127.0.0.1:${server.address().port}/api/private-classes`;
  const call = (url, body, user = "u1", role = "owner") => fetch(root + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(user ? { "x-user": user, "x-role": role } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("/batches", null, null)).status, 401);
    const { batch } = await (await call("/batches", { grade: "A", quantity: 2 })).json();
    const html = await (await call(`/batches/${batch.id}/print`)).text();
    assert.equal((html.match(/<section>/g) || []).length, 2);
    assert.ok(!html.includes("Classe A"));
    const code = html.match(/<small>([A-F0-9]{32})<\/small>/)[1];
    assert.equal((await call(`/batches/${batch.id}/print`, null, "u2")).status, 400);
    assert.equal((await call("/lots/lot/pallets/P1", { action: "add", code }, "u2")).status, 400);
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
