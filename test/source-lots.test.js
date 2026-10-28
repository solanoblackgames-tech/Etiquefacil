import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSourceLot, listSourceLots, suggestSourceLotCode, generateClassBatch, classSummary, changeClassPallet, withClassState, registerPrivateClassLot } from "../src/private-class-labels.js";
import { privateClassRoutes } from "../src/private-class-routes.js";

const empty = () => ({ labels: [], batches: [], pallets: [], events: [] });
const actor = { id: "owner", name: "Solano" };
const add = (state, code, codigoRz = "01", action = "add") => changeClassPallet(state, { lotId: "group", lotName: "Agrupamento", codigoRz, code, action, actor });

test("origens cadastraveis sugerem o proximo codigo e rejeitam duplicatas normalizadas", () => {
  const state = empty();
  assert.deepEqual(listSourceLots(state), []);
  assert.equal(suggestSourceLotCode(state), "EXP10");
  createSourceLot(state, { code: " exp10 ", actor });
  assert.equal(suggestSourceLotCode(state), "EXP11");
  createSourceLot(state, { code: "EXP11", actor });
  assert.equal(suggestSourceLotCode(state), "EXP12");
  assert.throws(() => createSourceLot(state, { code: "exp10", actor }), /ja esta cadastrado/);
  for (const code of ["", "<script>", "EXP 12", "x".repeat(41), "__proto__"]) assert.throws(() => createSourceLot(state, { code, actor }));
  assert.equal(state.sourceLots.length, 2);
  const padded = empty();
  createSourceLot(padded, { code: "EXP009", actor });
  assert.equal(suggestSourceLotCode(padded), "EXP010");
});

test("pilotos e origens EXP10/EXP11 convivem sem mudar registros ou fechamento anteriores", () => {
  const state = empty();
  generateClassBatch(state, { grade: "A", quantity: 1, actor });
  add(state, state.labels[0].code, "piloto");
  add(state, null, "piloto", "close");
  // Um fechamento antigo nao possuia o detalhamento dinamico.
  delete state.pallets[0].snapshot.bySource;
  const old = structuredClone(state);
  createSourceLot(state, { code: "EXP10", actor });
  createSourceLot(state, { code: "EXP11", actor });
  for (const sourceLot of ["EXP10", "EXP11"]) {
    const batch = generateClassBatch(state, { sourceLot, quantity: sourceLot === "EXP10" ? 2 : 3, actor });
    for (const label of state.labels.filter((label) => label.batchId === batch.id)) add(state, label.code);
  }
  const summary = classSummary(state, "group");
  assert.deepEqual(summary.bySource, { A: 1, EXP10: 2, EXP11: 3 });
  assert.equal(summary.B, 0); // As novas origens nao podem ser contadas como piloto B.
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.sources, ["A", "EXP10", "EXP11"]);
  for (const key of ["batches", "labels", "events"]) assert.deepEqual(state[key].slice(0, old[key].length), old[key]);
  assert.deepEqual(state.pallets.find((p) => p.codigoRz === "PILOTO"), old.pallets[0]);
  const beforeRead = structuredClone(state);
  assert.equal(listSourceLots(state).find((lot) => lot.code === "A").pilot, true);
  assert.deepEqual(state, beforeRead);
  add(state, null, "01", "close");
  assert.deepEqual(classSummary(state, "group").pallets.find((p) => p.codigoRz === "01").snapshot.bySource, { EXP10: 2, EXP11: 3 });
  assert.throws(() => add(state, state.labels[1].code, "01", "remove"), /fechada/);
});

test("retirada e transferencia atualizam contagens da origem sem duplicar a etiqueta", () => {
  const state = empty();
  assert.throws(() => generateClassBatch(state, { sourceLot: "EXP10", quantity: 1, actor }), /Cadastre/);
  createSourceLot(state, { code: "EXP10", actor });
  const batch = generateClassBatch(state, { sourceLot: "EXP10", quantity: 1, actor });
  const label = state.labels.find((label) => label.batchId === batch.id);
  assert.match(label.code, /^[A-F0-9]{32}$/);
  assert.equal(classSummary(state, "group").total, 0);
  add(state, label.code);
  assert.throws(() => add(state, label.code, "02"), /ja foi colocada/);
  add(state, label.code, "01", "remove");
  assert.equal(classSummary(state, "group").total, 0);
  add(state, label.code, "02");
  assert.equal(classSummary(state, "group").bySource.EXP10, 1);
  assert.deepEqual(state.events.map((event) => event.sourceLot), ["EXP10", "EXP10", "EXP10"]);
});

test("API cadastra origens, reimprime QR opaco e exporta todas as origens de cada pallet", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "source-lots-"));
  const withState = (user, fn) => withClassState(user, fn, { directory, pool: null });
  await withState("owner", (state) => registerPrivateClassLot(state, { id: "group", nomeArquivo: "Agrupamento" }, actor));
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  app.use("/api/private-classes", privateClassRoutes({
    requireAuth(req, _res, next) { req.session = { user: { id: req.get("x-user") || "owner", role: "owner", privateClassesAccess: req.get("x-user") !== "foreign" } }; next(); },
    requireOwner: pass, requireTriageAccess: pass,
    workspaceUserId: (req) => req.session.user.id,
    getUserLotDetail: async (_user, id) => id === "group" ? { id, nomeArquivo: "Agrupamento", rzs: [] } : null,
    withState
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/private-classes`;
  const call = (route, body, user = "owner") => fetch(url + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "x-user": user }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("/source-lots", { code: "EXP10" }, "foreign")).status, 403);
    assert.equal((await call("/batches", { sourceLot: "EXP10", quantity: 1 })).status, 400);
    for (const code of ["EXP10", "EXP11"]) assert.equal((await call("/source-lots", { code })).status, 200);
    assert.equal((await call("/source-lots", { code: "exp10" })).status, 400);
    assert.equal((await (await call("/source-lots")).json()).suggestedCode, "EXP12");
    for (const sourceLot of ["EXP10", "EXP11"]) {
      const { batch } = await (await call("/batches", { sourceLot, quantity: 1 })).json();
      const printed = await (await call(`/batches/${batch.id}/print`)).text();
      assert.ok(!printed.includes(sourceLot));
      const code = printed.match(/<small>([A-F0-9]{32})<\/small>/)[1];
      assert.equal((await call("/lots/group/pallets/01", { action: "add", code })).status, 200);
      assert.equal(await (await call(`/batches/${batch.id}/print`)).text(), printed);
    }
    const summary = await (await call("/lots/group")).json();
    assert.deepEqual(summary.bySource, { EXP10: 1, EXP11: 1 });
    const csv = await (await call("/lots/group/export")).text();
    assert.match(csv, /"Pallet";"Origem EXP10";"Origem EXP11";"Total"/);
    assert.match(csv, /"01";"1";"1";"2"/);
    assert.match(csv, /"TOTAL";"1";"1";"2"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
