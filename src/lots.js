import { roundMoney } from "./domain.js";

const COMPLETE_EXPORT_ORIGINS = new Set(["planilha", "entrada_diversos", "lote_sem_planilha", "lote_sem_planilha_manual"]);
const EXCESS_EXPORT_ORIGINS = new Set(["excedente_externo", "lote_sem_planilha_manual"]);

export function summarizeLot(db, lot, includeItems = false) {
  const products = db.products.filter((product) => product.lotId === lot.id);
  const items = db.rzItems.filter((item) => item.lotId === lot.id);
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
    result.items = items.map((item) => ({
      ...item,
      product: products.find((product) => product.id === item.productId)
    }));
  }

  return result;
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
  const items = db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === codigoRz);
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

function percent(value, total) {
  if (!total) return 0;
  return roundMoney((value / total) * 100);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}
