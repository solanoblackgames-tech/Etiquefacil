import { randomUUID } from "node:crypto";
import { buildWmsPositionCodes } from "./wms-labels.js";

// Estoque WMS por unidade fisica. Cada unidade guardada numa posicao vira uma linha;
// quando veio da triagem carrega o laudo (LAB-...), que identifica exatamente a unidade
// enviada e define a ordem FIFO. Unidades de inventario (estoque anterior ao WMS, sem
// laudo) sao identificadas so pelo SKU e saem primeiro.

const TRIAGE_CODE_PATTERN = /LAB-\d{8}-\d{6}/i;

export const WMS_UNIT_STATUS = {
  stored: "stored",
  reserved: "reserved",
  picked: "picked",
  shipped: "shipped"
};

// O QR do laudo traz uma URL (/laudo/LAB-...); a bipagem pode vir como URL ou como o codigo.
export function extractTriageCode(value) {
  const match = String(value || "").toUpperCase().match(TRIAGE_CODE_PATTERN);
  return match ? match[0] : "";
}

export function normalizeWmsCode(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeWmsLocation(value) {
  return normalizeWmsCode(value).replace(/\s+/g, "");
}

const positionCache = new Map();

// So valem posicoes que existem na grade configurada do deposito (ruas x colunas x posicoes).
export function isValidWmsPosition(depositConfig, location) {
  if (!depositConfig) return false;
  const key = JSON.stringify([depositConfig.prefix, depositConfig.rowsConfig]);
  let codes = positionCache.get(key);
  if (!codes) {
    codes = new Set(buildWmsPositionCodes(depositConfig));
    positionCache.set(key, codes);
  }
  return codes.has(normalizeWmsLocation(location));
}

export function assertValidWmsPosition(depositConfig, location) {
  const normalized = normalizeWmsLocation(location);
  if (!normalized) throw new Error("Informe a posicao WMS.");
  if (!depositConfig) throw new Error("Deposito sem WMS configurado.");
  if (!isValidWmsPosition(depositConfig, normalized)) {
    throw new Error(`Posicao ${normalized} nao existe no deposito ${depositConfig.depositName}. Confira a etiqueta da posicao.`);
  }
  return normalized;
}

export function buildWmsUnit({
  userId,
  depositName,
  location,
  source,
  sku = "",
  codigoMl = "",
  ean = "",
  descricao = "",
  triageItemId = null,
  triageCode = "",
  transferItemId = null,
  fifoAt = null,
  blingValidated = null,
  createdBy = "",
  now = new Date().toISOString()
}) {
  return {
    id: randomUUID(),
    userId,
    depositName: String(depositName || "").trim(),
    location: normalizeWmsLocation(location),
    source,
    sku: normalizeWmsCode(sku),
    codigoMl: normalizeWmsCode(codigoMl),
    ean: normalizeWmsCode(ean),
    descricao: String(descricao || "").trim(),
    triageItemId: triageItemId || null,
    triageCode: normalizeWmsCode(triageCode),
    transferItemId: transferItemId || null,
    fifoAt: fifoAt || now,
    status: WMS_UNIT_STATUS.stored,
    orderId: null,
    blingValidated,
    createdBy: String(createdBy || "").trim(),
    createdAt: now,
    updatedAt: now
  };
}

export function buildWmsMovement({ userId, unit, type, fromLocation = "", toLocation = "", code = "", reason = "", orderId = null, operatorName = "", now = new Date().toISOString() }) {
  return {
    id: randomUUID(),
    userId,
    unitId: unit?.id || null,
    depositName: unit?.depositName || "",
    sku: unit?.sku || "",
    triageCode: unit?.triageCode || "",
    type,
    fromLocation: normalizeWmsLocation(fromLocation),
    toLocation: normalizeWmsLocation(toLocation),
    code: normalizeWmsCode(code),
    reason: String(reason || "").trim(),
    orderId: orderId || null,
    operatorName: String(operatorName || "").trim(),
    createdAt: now
  };
}

// Inventario sai antes de tudo; depois, o laudo mais antigo.
export function compareWmsUnitsFifo(a, b) {
  const sourceRank = (unit) => (unit.source === "inventory" ? 0 : 1);
  return sourceRank(a) - sourceRank(b)
    || String(a.fifoAt || "").localeCompare(String(b.fifoAt || ""))
    || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

export function wmsUnitMatchesItem(unit, item) {
  const sku = normalizeWmsCode(item.sku);
  const codigoMl = normalizeWmsCode(item.codigoMl);
  const ean = normalizeWmsCode(item.ean);
  return Boolean(
    (sku && (unit.sku === sku || unit.codigoMl === sku)) ||
    (codigoMl && (unit.codigoMl === codigoMl || unit.sku === codigoMl)) ||
    (ean && unit.ean === ean)
  );
}

export function wmsUnitMatchesCode(unit, code) {
  const normalized = normalizeWmsCode(code);
  return Boolean(normalized) && [unit.sku, unit.codigoMl, unit.ean, unit.triageCode].some((value) => value && value === normalized);
}

// Escolhe as unidades FIFO de cada item do pedido dentro do deposito. Retorna as reservas
// e o que faltou (pedido sem saldo suficiente).
export function reserveWmsUnitsFifo({ order, items, units, now = new Date().toISOString() }) {
  const deposit = normalizeWmsCode(order.wmsDepositName);
  const available = (units || [])
    .filter((unit) => unit.status === WMS_UNIT_STATUS.stored && (!deposit || normalizeWmsCode(unit.depositName) === deposit))
    .sort(compareWmsUnitsFifo);
  const taken = new Set();
  const reservations = [];
  const missing = [];
  for (const item of items || []) {
    let pending = Math.max(0, Number(item.quantidade || 0) - Number(item.quantidadeSeparada || 0));
    for (const unit of available) {
      if (!pending) break;
      if (taken.has(unit.id) || !wmsUnitMatchesItem(unit, item)) continue;
      taken.add(unit.id);
      reservations.push({
        id: randomUUID(),
        orderId: order.id,
        itemId: item.id,
        unitId: unit.id,
        wmsLocation: unit.location,
        sku: item.sku || unit.sku,
        codigoMl: item.codigoMl || unit.codigoMl,
        ean: item.ean || unit.ean,
        triageCode: unit.triageCode,
        status: "active",
        createdAt: now,
        pickedAt: null,
        releasedAt: null
      });
      pending -= 1;
    }
    if (pending > 0) missing.push({ itemId: item.id, sku: item.sku || item.codigoMl || item.ean, quantidade: pending });
  }
  return { reservations, missing };
}

// Valida a bipagem de coleta (posicao + laudo, ou posicao + SKU para unidade sem laudo).
// A rota e obrigatoria: fora da FIFO ou fora da ordem das posicoes, bloqueia.
export function resolveWmsPick({ reservations, units, positionCode, productCode, skippedLocations = [] }) {
  const position = normalizeWmsLocation(positionCode);
  const scanned = normalizeWmsCode(productCode);
  if (!position) throw new Error("Bipe a posicao WMS.");
  if (!scanned) throw new Error("Bipe o laudo ou o codigo do produto.");

  const unitsById = new Map((units || []).map((unit) => [unit.id, unit]));
  const active = (reservations || [])
    .filter((reservation) => reservation.status === "active")
    .sort((a, b) => compareWmsLocation(a.wmsLocation, b.wmsLocation) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (!active.length) throw new Error("Nao ha produtos pendentes neste pedido.");

  const skipped = new Set((skippedLocations || []).map(normalizeWmsLocation));
  const nextLocation = (active.find((reservation) => !skipped.has(normalizeWmsLocation(reservation.wmsLocation))) || active[0]).wmsLocation;
  if (normalizeWmsLocation(nextLocation) !== position) {
    throw new Error(`Siga a rota: colete primeiro na posicao ${nextLocation}.`);
  }
  const atPosition = active.filter((reservation) => normalizeWmsLocation(reservation.wmsLocation) === position);
  const triageCode = extractTriageCode(scanned);

  if (triageCode) {
    const match = atPosition.find((reservation) => normalizeWmsCode(unitsById.get(reservation.unitId)?.triageCode || reservation.triageCode) === triageCode);
    if (match) return { reservation: match, unit: unitsById.get(match.unitId) || null, code: triageCode };
    const unit = (units || []).find((candidate) => candidate.triageCode === triageCode);
    const expected = atPosition.find((reservation) => (unitsById.get(reservation.unitId)?.triageCode || reservation.triageCode));
    if (!unit) throw new Error(`Laudo ${triageCode} nao esta guardado no WMS.`);
    if (normalizeWmsLocation(unit.location) !== position) throw new Error(`O laudo ${triageCode} esta na posicao ${unit.location}, nao em ${position}.`);
    if (expected) {
      const expectedCode = unitsById.get(expected.unitId)?.triageCode || expected.triageCode;
      throw new Error(`Fora da FIFO: pegue o laudo ${expectedCode} nesta posicao.`);
    }
    throw new Error(`O laudo ${triageCode} nao pertence a este pedido.`);
  }

  const match = atPosition.find((reservation) => {
    const unit = unitsById.get(reservation.unitId);
    if (unit?.triageCode) return false;
    return unit ? wmsUnitMatchesCode(unit, scanned) : [reservation.sku, reservation.codigoMl, reservation.ean].some((value) => normalizeWmsCode(value) === scanned);
  });
  if (match) return { reservation: match, unit: unitsById.get(match.unitId) || null, code: scanned };
  const withLaudo = atPosition.find((reservation) => {
    const unit = unitsById.get(reservation.unitId);
    return unit?.triageCode && wmsUnitMatchesCode(unit, scanned);
  });
  if (withLaudo) {
    throw new Error(`Esta unidade tem laudo: bipe o laudo ${unitsById.get(withLaudo.unitId).triageCode}.`);
  }
  throw new Error("Produto nao esta reservado nesta posicao para este pedido.");
}

export function compareWmsLocation(a, b) {
  const left = parseWmsLocation(a);
  const right = parseWmsLocation(b);
  return left.prefix.localeCompare(right.prefix)
    || left.row.localeCompare(right.row)
    || left.column - right.column
    || left.position - right.position
    || String(a || "").localeCompare(String(b || ""));
}

function parseWmsLocation(value) {
  const parts = normalizeWmsLocation(value).split("-");
  const position = Number(parts.pop() || 0);
  const column = Number(parts.pop() || 0);
  const row = parts.pop() || "";
  return {
    prefix: parts.join("-"),
    row,
    column: Number.isFinite(column) ? column : 0,
    position: Number.isFinite(position) ? position : 0
  };
}

// Posicoes onde o mesmo produto ja esta guardado: sugestao para manter tudo junto.
export function suggestWmsLocations(units, { sku = "", codigoMl = "", ean = "", depositName = "" } = {}) {
  const deposit = normalizeWmsCode(depositName);
  const counts = new Map();
  for (const unit of units || []) {
    if (unit.status !== WMS_UNIT_STATUS.stored && unit.status !== WMS_UNIT_STATUS.reserved) continue;
    if (deposit && normalizeWmsCode(unit.depositName) !== deposit) continue;
    if (!wmsUnitMatchesItem(unit, { sku, codigoMl, ean })) continue;
    counts.set(unit.location, (counts.get(unit.location) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([location, quantity]) => ({ location, quantity }))
    .sort((a, b) => b.quantity - a.quantity || compareWmsLocation(a.location, b.location));
}

// Linhas de saldo para a tela de gestao: agrupa por deposito + posicao + produto.
export function summarizeWmsUnits(units) {
  const rows = new Map();
  for (const unit of [...(units || [])].sort(compareWmsUnitsFifo)) {
    if (unit.status === WMS_UNIT_STATUS.shipped) continue;
    const key = [unit.depositName, unit.location, unit.sku, unit.codigoMl].join("|");
    const row = rows.get(key) || {
      depositName: unit.depositName,
      location: unit.location,
      sku: unit.sku,
      codigoMl: unit.codigoMl,
      ean: unit.ean,
      descricao: unit.descricao,
      stored: 0,
      reserved: 0,
      picked: 0,
      withoutLaudo: 0,
      notValidated: 0,
      oldestFifoAt: unit.fifoAt,
      laudos: []
    };
    if (unit.status === WMS_UNIT_STATUS.stored) row.stored += 1;
    if (unit.status === WMS_UNIT_STATUS.reserved) row.reserved += 1;
    if (unit.status === WMS_UNIT_STATUS.picked) row.picked += 1;
    if (!unit.triageCode) row.withoutLaudo += 1;
    if (unit.blingValidated === false) row.notValidated += 1;
    if (unit.triageCode) row.laudos.push(unit.triageCode);
    if (String(unit.fifoAt || "") < String(row.oldestFifoAt || "")) row.oldestFifoAt = unit.fifoAt;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.depositName.localeCompare(b.depositName) || compareWmsLocation(a.location, b.location) || a.sku.localeCompare(b.sku));
}
