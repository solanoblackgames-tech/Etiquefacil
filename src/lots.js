import { roundMoney } from "./domain.js";

const COMPLETE_EXPORT_ORIGINS = new Set(["planilha", "entrada_diversos", "lote_sem_planilha", "lote_sem_planilha_manual"]);
const EXCESS_EXPORT_ORIGINS = new Set(["excedente_externo", "lote_sem_planilha_manual"]);

export function summarizeLot(db, lot, includeItems = false) {
  const usersById = new Map((db.users || []).map((user) => [user.id, user]));
  const products = db.products
    .filter((product) => product.lotId === lot.id)
    .map((product) => enrichProductUsers(product, usersById));
  const rawItems = db.rzItems.filter((item) => item.lotId === lot.id);
  const items = consolidateRzItems(rawItems);
  const rzs = [...new Set(items.map((item) => item.codigoRz))]
    .sort()
    .map((codigoRz) => summarizeRz(db, lot, codigoRz));
  const expectedQty = rzs.reduce((sum, rz) => sum + rz.expected, 0);
  const checkedQty = rzs.reduce((sum, rz) => sum + rz.checked, 0);
  const expectedValue = rzs.reduce((sum, rz) => sum + rz.expectedValue, 0);
  const checkedValue = rzs.reduce((sum, rz) => sum + rz.checkedValue, 0);

  const result = {
    ...lot,
    totalProducts: products.length,
    totalItems: expectedQty,
    totalExcessExternal: products.filter((product) => EXCESS_EXPORT_ORIGINS.has(product.origem)).length,
    progress: {
      expectedQty,
      checkedQty,
      qtyPercent: percent(checkedQty, expectedQty),
      expectedValue: roundMoney(expectedValue),
      checkedValue: roundMoney(checkedValue),
      valuePercent: percent(checkedValue, expectedValue)
    },
    rzs
  };

  if (includeItems) {
    result.products = products;
    result.items = items.map((item) => enrichRzItemWithProductAndScans(db, item, products));
  }

  return result;
}

function enrichRzItemWithProductAndScans(db, item, products) {
  const product = products.find((candidate) => candidate.id === item.productId);
  return {
    ...item,
    lastScanAt: lastRzItemScanAt(db, item, product),
    product
  };
}

function lastRzItemScanAt(db, item, product) {
  if (!product) return "";
  const matchingCodes = productScanCodes(product);
  return (db.scans || [])
    .filter((scan) => scan.lotId === item.lotId && scan.codigoRz === item.codigoRz)
    .filter((scan) => matchingCodes.has(normalizeCode(scan.codigoMl)))
    .map((scan) => scan.createdAt || "")
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
}

function productScanCodes(product) {
  return new Set([product.codigoMl, product.sku, code39BarcodeValue(product.sku), product.ean].map(normalizeCode).filter(Boolean));
}

function enrichProductUsers(product, usersById) {
  const createdByUser = product.createdByUserId ? usersById.get(product.createdByUserId) || null : null;
  const operatorUser = product.operatorUserId ? usersById.get(product.operatorUserId) || null : null;
  return {
    ...product,
    createdByUser: publicProductUser(createdByUser),
    operatorUser: publicProductUser(operatorUser)
  };
}

function publicProductUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name || "",
    email: user.email || "",
    role: user.role || "",
    operatorCode: user.operatorCode || null
  };
}

export function findProductHistory(db, userId, currentLotId, codigoMl) {
  const userLots = new Map(db.lots.filter((lot) => lot.id !== currentLotId && lot.userId === userId).map((lot) => [lot.id, lot]));
  return db.products
    .filter((product) => product.codigoMl === codigoMl && userLots.has(product.lotId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((product) => ({ ...product, lot: userLots.get(product.lotId) }));
}

export function findApprovedProductHistory(db, userId, currentLotId, codigoMl) {
  const approvedByCode = new Map((db.catalogProducts || []).map((product) => [normalizeCode(product.codigoMl), product]));
  return findProductHistory(db, userId, currentLotId, codigoMl).filter((product) => {
    if (product.lot?.userId !== userId) return false;
    return approvedByCode.has(normalizeCode(product.codigoMl));
  }).map((product) => ({
    ...product,
    ...approvedByCode.get(normalizeCode(product.codigoMl)),
    id: product.id,
    lotId: product.lotId,
    sku: product.sku,
    qtdTotal: product.qtdTotal,
    origem: product.origem,
    lot: product.lot
  }));
}

export function getBlingProducts(db, lot, kind) {
  const products = db.products.filter((product) => product.lotId === lot.id);
  if (kind === "complete") return products.filter((product) => COMPLETE_EXPORT_ORIGINS.has(product.origem));
  if (kind === "excess") return products.filter((product) => EXCESS_EXPORT_ORIGINS.has(product.origem));
  throw new Error("Tipo de exportação inválido.");
}

function summarizeRz(db, lot, codigoRz) {
  const items = consolidateRzItems(db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === codigoRz));
  const products = db.products.filter((product) => product.lotId === lot.id);
  const enriched = items.map((item) => ({ ...item, product: products.find((product) => product.id === item.productId) }));
  const expected = enriched.reduce((sum, item) => sum + item.qtdEsperada, 0);
  const checked = enriched.reduce((sum, item) => sum + item.qtdConferida, 0);
  const expectedValue = enriched.reduce((sum, item) => sum + item.qtdEsperada * (item.product?.valorUnit || 0), 0);
  const checkedValue = enriched.reduce((sum, item) => {
    const checkedQty = item.tipoItem === "excedente_externo" ? 0 : Math.min(item.qtdConferida, item.qtdEsperada);
    return sum + checkedQty * (item.product?.valorUnit || 0);
  }, 0);
  const missingValue = enriched.reduce((sum, item) => {
    return sum + Math.max(0, item.qtdEsperada - item.qtdConferida) * (item.product?.valorUnit || 0);
  }, 0);
  const excessValue = enriched.reduce((sum, item) => {
    const excess = item.tipoItem === "excedente_externo" ? item.qtdConferida : Math.max(0, item.qtdConferida - item.qtdEsperada);
    return sum + excess * (item.product?.valorUnit || 0);
  }, 0);
  return {
    codigoRz,
    expected,
    checked,
    qtyPercent: percent(checked, expected),
    expectedValue: roundMoney(expectedValue),
    checkedValue: roundMoney(checkedValue),
    valuePercent: percent(checkedValue, expectedValue),
    missing: enriched.reduce((sum, item) => sum + Math.max(0, item.qtdEsperada - item.qtdConferida), 0),
    excess: enriched.reduce((sum, item) => sum + (item.tipoItem === "excedente_externo" ? item.qtdConferida : Math.max(0, item.qtdConferida - item.qtdEsperada)), 0),
    missingValue: roundMoney(missingValue),
    excessValue: roundMoney(excessValue)
  };
}

function consolidateRzItems(items) {
  const byProductAndRz = new Map();
  for (const item of items) {
    const key = `${item.lotId || ""}\u0000${item.codigoRz || ""}\u0000${item.productId || ""}`;
    const current = byProductAndRz.get(key);
    if (!current) {
      byProductAndRz.set(key, { ...item });
      continue;
    }

    current.qtdEsperada += item.qtdEsperada;
    current.qtdConferida += item.qtdConferida;
    current.valorTotal += item.valorTotal || 0;
    current.tipoItem = mergeTipoItem(current.tipoItem, item.tipoItem);
    current.tipoItem = consolidatedTipoItem(current);
    current.condicaoGrade = mergeText(current.condicaoGrade, item.condicaoGrade);
    current.enderecoWms = mergeText(current.enderecoWms, item.enderecoWms);
  }
  return [...byProductAndRz.values()].map((item) => ({
    ...item,
    tipoItem: consolidatedTipoItem(item)
  }));
}

function mergeTipoItem(first, second) {
  if (first === "excedente_externo" || second === "excedente_externo") return "excedente_externo";
  if (first === "lote_sem_planilha_manual" || second === "lote_sem_planilha_manual") return "lote_sem_planilha_manual";
  if (first === "lote_sem_planilha" || second === "lote_sem_planilha") return "lote_sem_planilha";
  if (first === "entrada_diversos" || second === "entrada_diversos") return "entrada_diversos";
  return first || second || "esperado";
}

function consolidatedTipoItem(item) {
  if (item.tipoItem === "excedente_externo") return "excedente_externo";
  if (item.tipoItem === "entrada_diversos" || item.tipoItem === "lote_sem_planilha" || item.tipoItem === "lote_sem_planilha_manual") return item.tipoItem;
  return item.qtdConferida > item.qtdEsperada ? "excedente_outro_rz" : "esperado";
}

function mergeText(first, second) {
  const values = [first, second].filter(Boolean);
  return [...new Set(values)].join(" / ");
}

function percent(value, total) {
  if (!total) return 0;
  return roundMoney((value / total) * 100);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function code39BarcodeValue(value) {
  return String(value || "").trim().toUpperCase().replace(/[^0-9A-Z .$/+%-]/g, "-");
}
