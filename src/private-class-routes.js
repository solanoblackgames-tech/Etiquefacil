import { Router } from "express";
import QRCode from "qrcode";
import { withClassState, generateClassBatch, changeClassPallet, classSummary } from "./private-class-labels.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function privateClassRoutes({ requireAuth, requireTriageAccess, requireOwner, workspaceUserId, getUserLotDetail, withState = withClassState }) {
  const router = Router();
  router.use(requireAuth, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const route = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  };
  const actor = (req) => ({ id: req.session.user.id, name: req.session.user.name || req.session.user.email || "" });
  const ownedLot = async (req) => {
    const lot = await getUserLotDetail(workspaceUserId(req), req.params.lotId);
    if (!lot) throw new Error("Lote nao encontrado nesta conta.");
    if (Number(lot.percentualArremate || 0) !== 0) throw new Error("Use um lote sem lista para o controle por classe.");
    return lot;
  };

  router.get("/batches", requireTriageAccess, route(async (req, res) => {
    res.json(await withState(workspaceUserId(req), (state) => ({ batches: [...state.batches].reverse().map((batch) => ({
      ...batch, assigned: state.labels.filter((label) => label.batchId === batch.id && label.lotId).length
    })) })));
  }));
  router.post("/batches", requireTriageAccess, route(async (req, res) => {
    const batch = await withState(workspaceUserId(req), (state) => generateClassBatch(state, {
      grade: req.body.grade, quantity: req.body.quantity, actor: actor(req)
    }));
    res.json({ batch });
  }));
  router.get("/batches/:batchId/print", requireTriageAccess, route(async (req, res) => {
    const labels = await withState(workspaceUserId(req), (state) => {
      if (!state.batches.some((batch) => batch.id === req.params.batchId)) throw new Error("Emissao nao encontrada nesta conta.");
      return state.labels.filter((label) => label.batchId === req.params.batchId).map(({ code }) => code);
    });
    const pages = await Promise.all(labels.map(async (code) => `<section>${await QRCode.toString(code, { type: "svg", margin: 4, errorCorrectionLevel: "M" })}<small>${escapeHtml(code)}</small></section>`));
    res.type("html").send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Etiquetas</title>
      <style>@page{size:60mm 40mm;margin:0}*{box-sizing:border-box}body{margin:0;font:12px Arial;background:#eee}header{padding:16px}section{width:60mm;height:40mm;background:white;display:flex;flex-direction:column;align-items:center;justify-content:center;break-after:page;page-break-after:always;margin:8px auto}section:last-child{break-after:auto;page-break-after:auto}svg{width:32mm;height:32mm}small{font:7px monospace}@media print{header{display:none}body{background:white}section{margin:0}}</style>
      <header>${labels.length} etiquetas · 60 × 40 mm <button onclick="window.print()">Imprimir</button></header>${pages.join("")}</html>`);
  }));

  router.get("/lots/:lotId", route(async (req, res) => {
    await ownedLot(req);
    res.json(await withState(workspaceUserId(req), (state) => ({
      ...classSummary(state, req.params.lotId),
      events: state.events.filter((event) => event.lotId === req.params.lotId).slice(-100).reverse()
    })));
  }));
  router.post("/lots/:lotId/pallets/:codigoRz", route(async (req, res) => {
    const lot = await ownedLot(req);
    // Fechar a composicao e uma decisao do responsavel pela conta.
    if (req.body.action === "close" && req.session.user.role === "operator") throw new Error("Somente o responsavel pode fechar a composicao.");
    res.json(await withState(workspaceUserId(req), (state) => changeClassPallet(state, {
      lotId: lot.id, lotName: lot.nomeArquivo, codigoRz: req.params.codigoRz,
      action: req.body.action, code: req.body.code, actor: actor(req)
    })));
  }));
  router.get("/lots/:lotId/export", requireOwner, route(async (req, res) => {
    const lot = await ownedLot(req);
    const summary = await withState(workspaceUserId(req), (state) => classSummary(state, lot.id));
    const cell = (value) => `"${String(value ?? "").replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
    const rows = [["Pallet", "Classe A", "Classe B", "Total", "Fechado em", "Responsavel"], ...summary.pallets.map((p) => [p.codigoRz, p.A, p.B, p.total, p.closedAt || "", p.closedBy?.name || ""]), ["TOTAL", summary.A, summary.B, summary.total, "", ""]];
    res.set("Content-Disposition", 'attachment; filename="composicao-pallets.csv"').type("text/csv").send("\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n"));
  }));
  return router;
}

export async function attachPrivateClassPallets(userId, lot) {
  if (!lot || Number(lot.percentualArremate || 0) !== 0) return lot;
  const summary = await withClassState(userId, (state) => classSummary(state, lot.id));
  lot.classCounts = summary;
  for (const pallet of summary.pallets) {
    if (!lot.rzs.some((rz) => rz.codigoRz === pallet.codigoRz)) {
      lot.rzs.push({ codigoRz: pallet.codigoRz, expected: 0, checked: 0, qtyPercent: 0, expectedValue: 0, checkedValue: 0, excessValue: 0, missing: 0, excess: 0, missingValue: 0, valuePercent: 0 });
    }
    lot.rzs.find((rz) => rz.codigoRz === pallet.codigoRz).classCounts = { A: pallet.A, B: pallet.B, total: pallet.total };
  }
  return lot;
}
