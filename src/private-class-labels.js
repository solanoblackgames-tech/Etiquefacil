import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { ensureStore, getPgPool } from "./store.js";

const emptyState = () => ({ batches: [], labels: [], pallets: [], events: [], classLots: [] });

export function hasPrivateClassAccess(owner) {
  return String(owner?.email || "").trim().toLowerCase() === "solanoblackgames@gmail.com";
}

// Lotes da primeira versao sao reconhecidos pelo historico, sem alterar etiquetas ou pallets.
export function isPrivateClassLot(state, lotId) {
  return Boolean(state.classLots?.some((lot) => lot.id === lotId)
    || state.pallets.some((pallet) => pallet.lotId === lotId)
    || state.events.some((event) => event.lotId === lotId));
}

export function registerPrivateClassLot(state, lot, actor) {
  state.classLots ||= [];
  if (!state.classLots.some((item) => item.id === lot.id)) {
    state.classLots.push({ id: lot.id, name: lot.nomeArquivo, createdAt: new Date().toISOString(), actor });
  }
}
const queues = new Map();
let tableReady;

// Uma transacao por conta protege a mesma etiqueta de bipagens simultaneas.
export async function withClassState(userId, mutate, { directory = path.resolve("data/private-classes"), pool = getPgPool() } = {}) {
  if (!userId) throw new Error("Conta obrigatoria.");
  if (pool) {
    await ensureStore();
    tableReady ||= pool.query(`create table if not exists private_class_state (
      user_id text primary key, payload jsonb not null
    )`).catch((error) => { tableReady = undefined; throw error; });
    await tableReady;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into private_class_state (user_id, payload) values ($1, $2) on conflict do nothing", [userId, emptyState()]);
      const { rows } = await client.query("select payload from private_class_state where user_id = $1 for update", [userId]);
      const state = rows[0].payload;
      const result = await mutate(state);
      await client.query("update private_class_state set payload = $2 where user_id = $1", [userId, state]);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }
  const filename = path.join(directory, `${createHash("sha256").update(userId).digest("hex")}.json`);
  const previous = queues.get(filename) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.mkdir(directory, { recursive: true });
    const state = await fs.readFile(filename, "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    });
    const result = await mutate(state);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state));
    await fs.rename(temporary, filename);
    return result;
  });
  queues.set(filename, pending);
  try { return await pending; } finally { if (queues.get(filename) === pending) queues.delete(filename); }
}

export function generateClassBatch(state, { grade, quantity, actor }) {
  if (!["A", "B"].includes(grade)) throw new Error("Selecione classe A ou B.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error("Informe de 1 a 1000 etiquetas por impressao.");
  const batch = { id: randomUUID(), grade, quantity, createdAt: new Date().toISOString(), actor };
  const used = new Set(state.labels.map((label) => label.code));
  for (let index = 0; index < quantity; index++) {
    let code;
    do { code = randomBytes(16).toString("hex").toUpperCase(); } while (used.has(code));
    used.add(code);
    state.labels.push({ code, grade, batchId: batch.id, lotId: null, codigoRz: null });
  }
  state.batches.push(batch);
  return batch;
}

export function classSummary(state, lotId) {
  const pallets = state.pallets.filter((pallet) => pallet.lotId === lotId).map((pallet) => {
    const labels = state.labels.filter((label) => label.lotId === lotId && label.codigoRz === pallet.codigoRz);
    const A = labels.filter((label) => label.grade === "A").length;
    const B = labels.length - A;
    return { ...pallet, A, B, total: A + B };
  }).sort((a, b) => a.codigoRz.localeCompare(b.codigoRz, "pt-BR", { numeric: true }));
  return { pallets, A: pallets.reduce((sum, p) => sum + p.A, 0), B: pallets.reduce((sum, p) => sum + p.B, 0), total: pallets.reduce((sum, p) => sum + p.total, 0) };
}

export function reserveSequentialClassPallet(state, { lotId, lotName, actor, existingCodes = [] }) {
  const config = state.classLots?.find((lot) => lot.id === lotId);
  if (!config?.sequentialPallets) throw new Error("Sequencia automatica nao habilitada neste lote.");
  const codes = [...existingCodes, ...state.pallets.filter((p) => p.lotId === lotId).map((p) => p.codigoRz)];
  const used = new Set(codes.filter((code) => /^\d+$/.test(String(code).trim())).map(Number));
  let next = 1;
  while (used.has(next)) next += 1;
  const pallet = { lotId, lotName, codigoRz: String(next), createdAt: new Date().toISOString(), createdBy: actor };
  state.pallets.push(pallet);
  return pallet;
}

export function changeClassPallet(state, { lotId, lotName, codigoRz, action, code, actor }) {
  codigoRz = String(codigoRz || "").trim().toUpperCase();
  if (!codigoRz || codigoRz.length > 100) throw new Error("Informe um pallet valido.");
  if (!["add", "remove", "close"].includes(action)) throw new Error("Operacao invalida.");
  let pallet = state.pallets.find((p) => p.lotId === lotId && p.codigoRz === codigoRz);
  if (pallet?.closedAt) throw new Error("A composicao deste pallet ja foi fechada.");
  const now = new Date().toISOString();
  let label;
  if (action !== "close") {
    label = state.labels.find((item) => item.code === String(code || "").trim().toUpperCase());
    if (!label) throw new Error("Etiqueta privada nao encontrada nesta conta.");
    if (action === "add" && label.lotId) throw new Error("Esta etiqueta ja foi colocada em um pallet. Retire-a do pallet de origem antes de mover.");
    if (action === "remove" && (label.lotId !== lotId || label.codigoRz !== codigoRz)) throw new Error("Esta etiqueta nao pertence a este pallet.");
  } else if (!pallet || !classSummary(state, lotId).pallets.find((p) => p.codigoRz === codigoRz)?.total) {
    throw new Error("Inclua etiquetas antes de fechar a composicao.");
  }
  if (!pallet) {
    pallet = { lotId, lotName, codigoRz, createdAt: now, createdBy: actor };
    state.pallets.push(pallet);
  }
  if (action === "add") Object.assign(label, { lotId, codigoRz });
  if (action === "remove") Object.assign(label, { lotId: null, codigoRz: null });
  if (action === "close") {
    const counts = classSummary(state, lotId).pallets.find((p) => p.codigoRz === codigoRz);
    Object.assign(pallet, { closedAt: now, closedBy: actor, snapshot: { A: counts.A, B: counts.B, total: counts.total } });
  }
  state.events.push({ id: randomUUID(), lotId, codigoRz, action, code: label?.code || null, grade: label?.grade || null, actor, createdAt: now });
  return classSummary(state, lotId);
}
