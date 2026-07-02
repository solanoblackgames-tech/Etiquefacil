import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import XLSX from "xlsx";
import QRCode from "qrcode";
import "dotenv/config";
import {
  deleteBlingProductBySku,
  listBlingDeposits,
  syncBlingProducts,
  syncBlingStockBalances,
  syncBlingStockEntries,
  syncBlingStockMovement,
  syncBlingStockTransfers
} from "./bling-api.js";
import { buildBlingCsv, buildBlingStockEntryCsv, buildBlingStockTransferCsv, importSpecialistWorkbook } from "./domain.js";
import { buildRuntimeConfig } from "./config.js";
import {
  addDiverseLotItem,
  createExternalExcess,
  createDiverseLot,
  createLabel,
  createTriageItem,
  createTransferLot,
  createLotFromImport,
  createManualExternalExcess,
  createOperator,
  createOperatorInvite,
  createUser,
  deleteExternalExcess,
  deleteUserBlingIntegration,
  deleteCatalogProductForAdmin,
  deleteUser,
  deleteUserLot,
  deleteTransferLotItem,
  decrementTransferLotItem,
  decrementLotRzScan,
  ensureStore,
  forceReceivePublicTransferLotScan,
  getBlingAppConfig,
  getLotBlingData,
  getOperatorInvite,
  getPgPool,
  getExternalExcessProduct,
  getPublicTransferLotDetail,
  getStoreHealth,
  getTriageItem,
  getTransferLotDetail,
  getPublicUserById,
  getUserBlingCredentials,
  getUserBlingIntegration,
  getUserLotDetail,
  getUserLotSummaries,
  hasPostgres,
  listTransferLots,
  markTransferLotSynced,
  listCatalogProductsForAdmin,
  listCatalogRequestsForAdmin,
  listLotsForAdmin,
  listOperatorsForUser,
  listTriageItems,
  listRejectedCatalogRequestsForAdmin,
  listUsersForAdmin,
  lookupTriageProduct,
  recordOperatorActivity,
  receivePublicTransferLotScan,
  receiveTransferLotScan,
  releaseTransferLotForStore,
  reviewCatalogRequest,
  scanLotRz,
  scanTransferLot,
  searchProducts,
  splitLotProduct,
  suggestNoSheetProducts,
  suggestCatalogUpdate,
  undoPublicTransferLotScan,
  updateNoSheetSuggestions,
  updateLotProduct,
  updateOperatorTriageAccess,
  updateTriageDiagnosis,
  updateUserTriageAccessForAdmin,
  updateOperatorPasswordForOwner,
  updateUserPassword,
  saveUserBlingIntegration,
  saveBlingAppConfig,
  acceptOperatorInvite,
  verifyUser
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const config = buildRuntimeConfig();
const PostgresSessionStore = pgSession(session);
const ADMIN_EMAIL = "lucassolano@jz";
const ADMIN_PASSWORD = "Jz2026";
const BLING_STOCK_DEPOSIT = process.env.BLING_STOCK_DEPOSIT || "Geral";
const usePgSessionStore = hasPostgres() && config.cookieSecure;
const ADMIN_USER = {
  id: "backoffice-admin",
  tenantId: "backoffice",
  tenantName: "Back Office",
  name: "Back Office",
  email: ADMIN_EMAIL,
  role: "admin"
};

app.set("trust proxy", config.trustProxy);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: config.sessionSecret,
    store: usePgSessionStore
      ? new PostgresSessionStore({
          pool: getPgPool(),
          createTableIfMissing: true
        })
      : undefined,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);
app.get("/", (req, res, next) => {
  if (!req.query.code && !req.query.error) return next();
  return requireAuth(req, res, () =>
    requireOwner(req, res, () => handleBlingOAuthCallback(req, res, getBlingRootRedirectUri(req)))
  );
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/config", (req, res) => {
  res.json({ downloadMode: config.downloadMode });
});

app.get("/healthz", async (req, res) => {
  try {
    res.json(await getStoreHealth());
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    res.json({ user: await refreshSessionUser(req) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) throw new Error("Informe nome, e-mail e senha.");
    const user = await createUser({ name, email, password });
    req.session.user = user;
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    if (isAdminLogin(req.body.email, req.body.password)) {
      req.session.user = ADMIN_USER;
      return res.json({ user: ADMIN_USER });
    }

    const user = await verifyUser(req.body.email || "", req.body.password || "");
    if (!user) return res.status(401).json({ error: "Login ou senha inválidos." });
    req.session.user = user;
    await recordOperatorActivity(user, "login");
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  res.json({ users: await listUsersForAdmin() });
});

app.get("/api/admin/lots", requireAdmin, async (req, res) => {
  res.json({ lots: await listLotsForAdmin() });
});

app.get("/api/admin/catalog-requests", requireAdmin, async (req, res) => {
  res.json({ requests: await listCatalogRequestsForAdmin() });
});

app.get("/api/admin/catalog-rejected-requests", requireAdmin, async (req, res) => {
  res.json({ requests: await listRejectedCatalogRequestsForAdmin() });
});

app.get("/api/admin/catalog-products", requireAdmin, async (req, res) => {
  res.json({ products: await listCatalogProductsForAdmin(req.query.q) });
});

app.delete("/api/admin/catalog-products/:productId", requireAdmin, async (req, res) => {
  try {
    res.json(await deleteCatalogProductForAdmin(req.params.productId));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/admin/catalog-requests/:requestId/:action", requireAdmin, async (req, res) => {
  try {
    res.json(await reviewCatalogRequest(req.params.requestId, req.params.action, { selectedCheckId: req.body?.selectedCheckId }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) throw new Error("Informe nome, e-mail e senha.");
    const user = await createUser({ name, email, password });
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/admin/users/:userId/password", requireAdmin, async (req, res) => {
  try {
    res.json(await updateUserPassword(req.params.userId, req.body.password));
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/admin/users/:userId/triage-access", requireAdmin, async (req, res) => {
  try {
    res.json(await updateUserTriageAccessForAdmin(req.params.userId, Boolean(req.body?.triageAccess)));
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  try {
    res.json(await deleteUser(req.params.userId));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots", requireAuth, async (req, res) => {
  await recordOperatorActivity(req.session.user, "view_lots");
  res.json({ lots: await getUserLotSummaries(workspaceUserId(req)) });
});

app.get("/api/operators", requireAuth, requireOwner, async (req, res) => {
  res.json({
    operators: await listOperatorsForUser(workspaceUserId(req), {
      startDate: req.query.startDate,
      endDate: req.query.endDate
    })
  });
});

app.post("/api/operators", requireAuth, requireOwner, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) throw new Error("Informe nome, e-mail e senha.");
    res.json({ operator: await createOperator({ ownerUserId: workspaceUserId(req), name, email, password }) });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/operators/:operatorUserId/triage-access", requireAuth, requireOwner, requireTriageAccess, async (req, res) => {
  try {
    res.json(await updateOperatorTriageAccess({
      ownerUserId: workspaceUserId(req),
      operatorUserId: req.params.operatorUserId,
      triageAccess: Boolean(req.body?.triageAccess)
    }));
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/operators/:operatorId/password", requireAuth, requireOwner, async (req, res) => {
  try {
    res.json(await updateOperatorPasswordForOwner(workspaceUserId(req), req.params.operatorId, req.body.password));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/triage/items", requireAuth, requireTriageAccess, async (req, res) => {
  try {
    res.json({ items: await withTriageQrData(req, await listTriageItems(workspaceUserId(req))) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/triage/lookup", requireAuth, requireTriageAccess, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const code = req.query.code || "";
    const localProduct = await lookupTriageProduct(userId, code);
    res.json({ product: localProduct });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/triage/items", requireAuth, requireTriageAccess, async (req, res) => {
  try {
    const item = await createTriageItem({
      userId: workspaceUserId(req),
      createdByUserId: req.session.user?.id,
      operatorUserId: operatorUserId(req),
      payload: req.body || {}
    });
    await recordOperatorActivity(req.session.user, "triage_create", { code: item.code });
    res.json({ item: await withTriageQrData(req, item) });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/triage/items/:code", requireAuth, requireTriageAccess, async (req, res) => {
  try {
    res.json({ item: await withTriageQrData(req, await getTriageItem(workspaceUserId(req), req.params.code)) });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/triage/items/:code/diagnosis", requireAuth, requireTriageAccess, async (req, res) => {
  try {
    const item = await updateTriageDiagnosis({
      userId: workspaceUserId(req),
      code: req.params.code,
      operatorUserId: operatorUserId(req) || req.session.user?.id,
      payload: req.body || {}
    });
    await recordOperatorActivity(req.session.user, "triage_diagnosis", { code: item.code, destination: item.destination });
    res.json({ item: await withTriageQrData(req, item) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/operator-invites", requireAuth, requireOwner, async (req, res) => {
  try {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const invite = await createOperatorInvite({
      ownerUserId: workspaceUserId(req),
      tokenHash: hashInviteToken(token),
      expiresAt
    });
    res.json({ invite, url: `${req.protocol}://${req.get("host")}/operadores/cadastro/${encodeURIComponent(token)}` });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/operator-invites/:token", async (req, res) => {
  try {
    res.json({ invite: await getOperatorInvite(hashInviteToken(req.params.token)) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/operator-invites/:token/accept", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) throw new Error("Informe nome, e-mail e senha.");
    const user = await acceptOperatorInvite({ tokenHash: hashInviteToken(req.params.token), name, email, password });
    req.session.user = user;
    await recordOperatorActivity(user, "login");
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/bling/deposits", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const integration = await getRequiredBlingCredentials(userId);
    const deposits = await listBlingDeposits({
      integration,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json({ deposits });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/transfer-lots", requireAuth, async (req, res) => {
  await recordOperatorActivity(req.session.user, "view_transfer_lots");
  res.json({ lots: await listTransferLots(workspaceUserId(req)) });
});

app.post("/api/transfer-lots", requireAuth, async (req, res) => {
  try {
    const lot = await createTransferLot({
      userId: workspaceUserId(req),
      descricao: req.body.descricao,
      depositoOrigem: req.body.depositoOrigem,
      depositoDestino: req.body.depositoDestino,
      createdByUserId: req.session.user?.id
    });
    await recordOperatorActivity(req.session.user, "create_transfer_lot", { transferLotId: lot.id });
    res.json({ lot });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/transfer-lots/:transferLotId", requireAuth, async (req, res) => {
  const lot = await getTransferLotDetail(workspaceUserId(req), req.params.transferLotId);
  if (!lot) return res.status(404).json({ error: "Lote de transferencia nao encontrado." });
  res.json({ lot });
});

app.get("/api/public/transfer-lots/:transferLotId", async (req, res) => {
  const lot = await getPublicTransferLotDetail(req.params.transferLotId);
  if (!lot) return res.status(404).json({ error: "Remessa de transferencia nao encontrada." });
  res.json({ lot });
});

app.post("/api/transfer-lots/:transferLotId/scan", requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || req.body.codigoMl || "").trim().toUpperCase();
    await recordOperatorActivity(req.session.user, "scan_transfer", { transferLotId: req.params.transferLotId, code });
    res.json(await scanTransferLot({ userId: workspaceUserId(req), transferLotId: req.params.transferLotId, code }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/transfer-lots/:transferLotId/release", requireAuth, async (req, res) => {
  try {
    const result = await releaseTransferLotForStore({ userId: workspaceUserId(req), transferLotId: req.params.transferLotId });
    await recordOperatorActivity(req.session.user, "release_transfer_lot", { transferLotId: req.params.transferLotId });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/transfer-lots/:transferLotId/receive-scan", requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || req.body.codigoMl || "").trim().toUpperCase();
    await recordOperatorActivity(req.session.user, "receive_transfer", { transferLotId: req.params.transferLotId, code });
    res.json(await receiveTransferLotScan({ userId: workspaceUserId(req), transferLotId: req.params.transferLotId, code }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/public/transfer-lots/:transferLotId/receive-scan", async (req, res) => {
  let result = null;
  try {
    const code = String(req.body.code || req.body.codigoMl || "").trim().toUpperCase();
    result = await receivePublicTransferLotScan({ transferLotId: req.params.transferLotId, code });
    const transferResult = await syncSingleReceivedTransferItem(result.lot, result.item);
    if (Number(result.lot?.totalPending || 0) === 0) {
      await markTransferLotSynced(result.lot.userId, result.lot.id);
      result.lot.status = "synced";
    }
    res.json({ ...result, transfer: transferResult });
  } catch (error) {
    if (result?.item?.id) await undoPublicTransferLotScan({ transferLotId: req.params.transferLotId, itemId: result.item.id }).catch(() => null);
    sendError(res, error);
  }
});

app.post("/api/public/transfer-lots/:transferLotId/force-receive-scan", async (req, res) => {
  let result = null;
  try {
    const code = String(req.body.code || req.body.codigoMl || "").trim().toUpperCase();
    const reason = String(req.body.reason || req.body.descricao || "").trim();
    result = await forceReceivePublicTransferLotScan({ transferLotId: req.params.transferLotId, code, reason });
    const transferResult = await syncSingleReceivedTransferItem(result.lot, result.item);
    res.json({ ...result, transfer: transferResult });
  } catch (error) {
    if (result?.item?.id) await undoPublicTransferLotScan({ transferLotId: req.params.transferLotId, itemId: result.item.id }).catch(() => null);
    sendError(res, error);
  }
});

app.post("/api/transfer-lots/:transferLotId/items/:itemId/decrement", requireAuth, async (req, res) => {
  try {
    res.json(await decrementTransferLotItem({ userId: workspaceUserId(req), transferLotId: req.params.transferLotId, itemId: req.params.itemId }));
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/api/transfer-lots/:transferLotId/items/:itemId", requireAuth, async (req, res) => {
  try {
    const reason = String(req.body?.reason || req.body?.justificativa || "").trim();
    if (req.session.user?.role === "operator" && reason.length < 5) {
      throw new Error("Informe uma justificativa para excluir o item da remessa.");
    }
    const result = await deleteTransferLotItem({ userId: workspaceUserId(req), transferLotId: req.params.transferLotId, itemId: req.params.itemId });
    await recordOperatorActivity(req.session.user, "delete_transfer_item", {
      transferLotId: req.params.transferLotId,
      itemId: req.params.itemId,
      codigoMl: result.item?.codigoMl || "",
      sku: result.item?.sku || "",
      quantidade: result.item?.quantidade || 0,
      reason
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/transfer-lots/:transferLotId/qr.svg", requireAuth, async (req, res) => {
  try {
    const lot = await getTransferLotDetail(workspaceUserId(req), req.params.transferLotId);
    if (!lot) return res.status(404).json({ error: "Lote de transferencia nao encontrado." });
    const url = `${req.protocol}://${req.get("host")}/transferencias/${encodeURIComponent(lot.id)}/loja`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 240, errorCorrectionLevel: "M" });
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.send(svg);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/transfer-lots/:transferLotId/bling", requireAuth, async (req, res) => {
  try {
    const lot = await getTransferLotDetail(workspaceUserId(req), req.params.transferLotId);
    if (!lot) return res.status(404).json({ error: "Lote de transferencia nao encontrado." });
    if (!lot.items.length) return res.status(404).json({ error: "Nenhum item bipado neste lote." });
    const csv = buildBlingStockTransferCsv(transferItemsForBling(lot), {
      depositoOrigem: lot.depositoOrigem,
      depositoDestino: lot.depositoDestino,
      observacao: `Transferencia ${lot.name}`
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${transferFileName(lot)}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/transfer-lots/:transferLotId/bling/sync", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const lot = await getTransferLotDetail(userId, req.params.transferLotId);
    if (!lot) return res.status(404).json({ error: "Lote de transferencia nao encontrado." });
    if (!lot.items.length) throw new Error("Nenhum item bipado neste lote.");
    const items = transferItemsForBling(lot, { requireReceived: true });
    if (!items.length) throw new Error("Nenhum item conferido pela loja nesta remessa.");
    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingStockTransfers({
      integration,
      items,
      depositoOrigemName: lot.depositoOrigem,
      depositoDestinoName: lot.depositoDestino,
      observacao: `Transferencia Etiquefacil ${lot.name}`,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    await markTransferLotSynced(userId, lot.id);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

function transferItemsForBling(lot, { requireReceived = false } = {}) {
  const hasReceived = (lot.items || []).some((item) => Number(item.quantidadeConferida || 0) > 0);
  return (lot.items || [])
    .map((item) => ({
      ...item,
      quantidade: Number(requireReceived || hasReceived ? item.quantidadeConferida || 0 : item.quantidade || 0)
    }))
    .filter((item) => Number(item.quantidade || 0) > 0);
}

async function syncSingleReceivedTransferItem(lot, item) {
  if (!lot?.userId) throw new Error("Dono da remessa nao encontrado para transferir no Bling.");
  const integration = await getRequiredBlingCredentials(lot.userId);
  return syncBlingStockTransfers({
    integration,
    items: [{ ...item, quantidade: 1 }],
    depositoOrigemName: lot.depositoOrigem,
    depositoDestinoName: lot.depositoDestino,
    observacao: `Transferencia Etiquefacil ${lot.name} - conferencia QR`,
    saveIntegration: (payload) => saveUserBlingIntegration(lot.userId, payload)
  });
}

app.get("/api/integrations/bling", requireAuth, requireOwner, async (req, res) => {
  const [integration, appConfig] = await Promise.all([
    getUserBlingIntegration(workspaceUserId(req)),
    getBlingAppConfig()
  ]);
  const appConfigured = hasBlingAppConfig() || Boolean(appConfig.clientId && appConfig.clientSecret);
  res.json({ integration: { ...integration, appConfigured, authorizeUrl: appConfigured ? "/api/integrations/bling/authorize" : null } });
});

app.post("/api/integrations/bling/config", requireAuth, requireOwner, async (req, res) => {
  try {
    const clientId = String(req.body.clientId || "").trim();
    const clientSecret = String(req.body.clientSecret || "").trim();
    if (!clientId || !clientSecret) throw new Error("Informe Client ID e Client Secret do Bling.");
    await saveBlingAppConfig({ clientId, clientSecret });
    const integration = await getUserBlingIntegration(workspaceUserId(req));
    res.json({ integration: { ...integration, appConfigured: true, authorizeUrl: "/api/integrations/bling/authorize" } });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/integrations/bling/authorize", requireAuth, requireOwner, async (req, res) => {
  try {
    const blingApp = await getBlingAppCredentials(workspaceUserId(req));
    const state = randomBytes(24).toString("hex");
    req.session.blingOAuthState = state;
    const url = new URL("https://www.bling.com.br/Api/v3/oauth/authorize");
    url.searchParams.set("client_id", blingApp.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/integrations/bling/callback", requireAuth, requireOwner, async (req, res) => {
  return handleBlingOAuthCallback(req, res, getBlingRedirectUri(req));
});

async function handleBlingOAuthCallback(req, res, redirectUri) {
  try {
    const blingApp = await getBlingAppCredentials(workspaceUserId(req));
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    if (!req.query.code) throw new Error("Bling nao retornou o codigo de autorizacao.");
    if (!req.query.state || req.query.state !== req.session.blingOAuthState) throw new Error("Retorno OAuth invalido. Tente autorizar novamente.");
    req.session.blingOAuthState = null;

    const token = await exchangeBlingAuthorizationCodeWithFallback(blingApp, String(req.query.code), getBlingRedirectUriCandidates(req, redirectUri));
    await saveUserBlingIntegration(workspaceUserId(req), {
      clientId: blingApp.clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null
    });
    res.redirect("/perfil?bling=connected");
  } catch (error) {
    req.session.blingOAuthState = null;
    res.redirect(`/perfil?bling=error&message=${encodeURIComponent(error.message)}`);
  }
}

app.delete("/api/integrations/bling", requireAuth, requireOwner, async (req, res) => {
  try {
    res.json(await deleteUserBlingIntegration(workspaceUserId(req)));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots", requireAuth, requireOwner, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Envie uma planilha .xlsx com as colunas obrigatórias.");
    const auctionPercent = Number(req.body.auctionPercent);
    const fornecedor = String(req.body.fornecedor || "").trim();
    const skuPrefix = String(req.body.skuPrefix || "").trim().toUpperCase();
    if (!Number.isFinite(auctionPercent) || auctionPercent <= 0) throw new Error("Informe um percentual de arremate válido.");
    if (!fornecedor) throw new Error("Informe o fornecedor do lote.");
    if (!skuPrefix) throw new Error("Informe o prefixo do SKU.");

    const imported = await importSpecialistWorkbook(req.file.buffer, { auctionPercent, fornecedor, skuPrefix });
    const lot = await createLotFromImport({
      userId: workspaceUserId(req),
      originalName: req.file.originalname,
      auctionPercent,
      fornecedor,
      skuPrefix,
      imported
    });
    res.json({ lot });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId", requireAuth, async (req, res) => {
  await recordOperatorActivity(req.session.user, "view_lot", { lotId: req.params.lotId });
  const lot = await getUserLotDetail(workspaceUserId(req), req.params.lotId);
  if (!lot) return res.status(404).json({ error: "Lote não encontrado." });
  res.json({ lot });
});

app.delete("/api/lots/:lotId", requireAuth, requireOwner, async (req, res) => {
  try {
    res.json(await deleteUserLot(workspaceUserId(req), req.params.lotId));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/diverse-lots", requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim() || `Lote sem planilha ${new Date().toLocaleDateString("pt-BR")}`;
    const fornecedor = String(req.body.fornecedor || "").trim();
    const skuPrefix = String(req.body.skuPrefix || "").trim().toUpperCase();
    const startSequence = Number(req.body.startSequence);
    const costMode = String(req.body.costMode || "fixed").trim();
    const averageCost = Number(req.body.averageCost);
    const costPercent = Number(req.body.costPercent);
    const suggestions = parseNoSheetSuggestions(req.body.suggestions || req.body.suggestionList || "");
    if (!fornecedor) throw new Error("Informe o fornecedor do lote.");
    if (!skuPrefix) throw new Error("Informe o prefixo do SKU.");
    if (!Number.isFinite(startSequence) || startSequence < 1) throw new Error("Informe o sequencial inicial do SKU.");
    if (costMode === "variable") {
      if (!Number.isFinite(costPercent) || costPercent <= 0) throw new Error("Informe o percentual do custo variavel.");
    } else if (!Number.isFinite(averageCost) || averageCost <= 0) {
      throw new Error("Informe o custo medio por unidade.");
    }

    const lot = await createDiverseLot({
      userId: workspaceUserId(req),
      name,
      fornecedor,
      skuPrefix,
      startSequence,
      averageCost,
      costMode,
      costPercent,
      suggestions
    });
    res.json({ lot });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/no-sheet-suggestions", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const suggestions = req.file ? parseNoSheetSuggestionFile(req.file) : parseNoSheetSuggestions(req.body.suggestions || req.body.suggestionList || "");
    res.json(await updateNoSheetSuggestions({ userId: workspaceUserId(req), lotId: req.params.lotId, suggestions }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/no-sheet-suggestions", requireAuth, async (req, res) => {
  try {
    res.json(await suggestNoSheetProducts({ userId: workspaceUserId(req), lotId: req.params.lotId, query: req.query.q }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/bling/:kind", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getLotBlingData(workspaceUserId(req), req.params.lotId, req.params.kind);
    if (!data) return res.status(404).json({ error: "Lote não encontrado." });

    const csv = buildBlingCsv(data.products, data.lot);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${blingFileName(data.lot, req.params.kind)}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/bling/:kind/save", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getLotBlingData(workspaceUserId(req), req.params.lotId, req.params.kind);
    if (!data) return res.status(404).json({ error: "Lote não encontrado." });

    const csv = buildBlingCsv(data.products, data.lot);
    const downloadsDir = path.join(os.homedir(), "Downloads");
    await fs.mkdir(downloadsDir, { recursive: true });
    const fileName = await uniqueDownloadName(downloadsDir, blingFileName(data.lot, req.params.kind));
    const filePath = path.join(downloadsDir, fileName);
    await fs.writeFile(filePath, `\uFEFF${csv}`, "utf8");
    revealFile(filePath);
    res.json({ fileName, path: filePath, count: data.products.length });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/bling/:kind/sync-products", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const data = await getLotBlingData(userId, req.params.lotId, req.params.kind);
    if (!data) return res.status(404).json({ error: "Lote nÃ£o encontrado." });
    if (!data.products.length) throw new Error("Nenhum produto encontrado para enviar ao Bling.");

    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingProducts({
      integration,
      products: withLotSupplier(data.products, data.lot),
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/products/:productId/bling/sync", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const lot = await getUserLotDetail(userId, req.params.lotId);
    if (!lot) return res.status(404).json({ error: "Lote nao encontrado." });

    const product = (lot.products || []).find((item) => item.id === req.params.productId);
    if (!product) return res.status(404).json({ error: "Produto nao encontrado neste lote." });

    res.json(await syncSingleLotProductToBling(userId, lot, product));
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/lots/:lotId/products/:productId", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const result = await updateLotProduct({
      userId,
      lotId: req.params.lotId,
      productId: req.params.productId,
      payload: req.body
    });
    try {
      result.bling = await syncSingleLotProductToBling(userId, result.lot, result.product);
    } catch (blingError) {
      result.bling = { ok: false, error: blingError.message };
    }
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/products/:productId/split", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const result = await splitLotProduct({
      userId,
      lotId: req.params.lotId,
      productId: req.params.productId,
      codigoRz: req.body.codigoRz,
      payload: req.body
    });
    const labelQuantity = Math.max(1, Math.round(Number(req.body.sellableQuantity || 1)));
    try {
      result.bling = await syncSplitProductToBling(userId, result.lot, result.product, labelQuantity);
    } catch (blingError) {
      result.bling = { ok: false, error: blingError.message };
    }
    const labelResult = await createLabel(userId, result.product.id, labelQuantity);
    result.label = labelResult?.label || null;
    result.labels = labelResult?.labels || [];
    result.labelQuantity = labelQuantity;
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/bling/stock-balance/sync", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const data = await getLotStockBalanceData(userId, req.params.lotId);
    if (!data) return res.status(404).json({ error: "Lote nao encontrado." });
    if (!data.items.length) throw new Error("Nenhum item bipado/cadastrado neste lote para corrigir saldo.");

    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingStockBalances({
      integration,
      items: data.items,
      depositoName: BLING_STOCK_DEPOSIT,
      observacao: `Correcao de saldo por bipagem ${data.lot.nomeArquivo}`,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json({ ...result, lot: { id: data.lot.id, nomeArquivo: data.lot.nomeArquivo } });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/rz/:codigoRz/bling", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getRzBlingData(workspaceUserId(req), req.params.lotId, req.params.codigoRz);
    if (!data) return res.status(404).json({ error: "Remessa nÃ£o encontrada neste lote." });

    const csv = buildBlingCsv(data.products, data.lot);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${rzBlingFileName(data.lot, data.codigoRz)}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/bling/save", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getRzBlingData(workspaceUserId(req), req.params.lotId, req.params.codigoRz);
    if (!data) return res.status(404).json({ error: "Remessa nÃ£o encontrada neste lote." });

    const csv = buildBlingCsv(data.products, data.lot);
    const downloadsDir = path.join(os.homedir(), "Downloads");
    await fs.mkdir(downloadsDir, { recursive: true });
    const fileName = await uniqueDownloadName(downloadsDir, rzBlingFileName(data.lot, data.codigoRz));
    const filePath = path.join(downloadsDir, fileName);
    await fs.writeFile(filePath, `\uFEFF${csv}`, "utf8");
    revealFile(filePath);
    res.json({ fileName, path: filePath, count: data.products.length });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/rz/:codigoRz/stock-entry", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getRzStockEntryData(workspaceUserId(req), req.params.lotId, req.params.codigoRz);
    if (!data) return res.status(404).json({ error: "Remessa nao encontrada neste lote." });
    if (!data.items.length) return res.status(404).json({ error: "Nenhum item conferido nesta remessa." });

    const csv = buildStockEntryCsvForRz(data);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${rzStockEntryFileName(data.lot, data.codigoRz)}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/stock-entry/save", requireAuth, requireOwner, async (req, res) => {
  try {
    const data = await getRzStockEntryData(workspaceUserId(req), req.params.lotId, req.params.codigoRz);
    if (!data) return res.status(404).json({ error: "Remessa nao encontrada neste lote." });
    if (!data.items.length) return res.status(404).json({ error: "Nenhum item conferido nesta remessa." });

    const csv = buildStockEntryCsvForRz(data);
    const downloadsDir = path.join(os.homedir(), "Downloads");
    await fs.mkdir(downloadsDir, { recursive: true });
    const fileName = await uniqueDownloadName(downloadsDir, rzStockEntryFileName(data.lot, data.codigoRz));
    const filePath = path.join(downloadsDir, fileName);
    await fs.writeFile(filePath, `\uFEFF${csv}`, "utf8");
    revealFile(filePath);
    res.json({ fileName, path: filePath, count: data.items.length });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/stock-entry/sync", requireAuth, requireOwner, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const data = await getRzStockEntryData(userId, req.params.lotId, req.params.codigoRz);
    if (!data) return res.status(404).json({ error: "Remessa nao encontrada neste lote." });
    if (!data.items.length) return res.status(404).json({ error: "Nenhum item conferido nesta remessa." });

    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingStockEntries({
      integration,
      items: data.items,
      depositoName: BLING_STOCK_DEPOSIT,
      observacao: `Entrada por conferencia RZ ${data.codigoRz}`,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/stock-entry/sync-one", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    if (!codigoMl) throw new Error("Informe o SKU da etiqueta ou Codigo ML.");

    const item = await getRzStockMovementItem(userId, req.params.lotId, req.params.codigoRz, codigoMl);
    if (!item) return res.status(404).json({ error: "Produto conferido nao encontrado nesta RZ." });

    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingStockMovement({
      integration,
      item,
      depositoName: BLING_STOCK_DEPOSIT,
      operation: "entry",
      observacao: `Entrada automatica por bipagem RZ ${req.params.codigoRz}`,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/stock-exit/sync-one", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    if (!codigoMl) throw new Error("Informe o SKU da etiqueta ou Codigo ML.");

    const item = await getRzStockMovementItem(userId, req.params.lotId, req.params.codigoRz, codigoMl);
    if (!item) return res.status(404).json({ error: "Produto nao encontrado nesta RZ." });

    const integration = await getRequiredBlingCredentials(userId);
    const result = await syncBlingStockMovement({
      integration,
      item,
      depositoName: BLING_STOCK_DEPOSIT,
      operation: "exit",
      observacao: `Saida automatica por diminuicao RZ ${req.params.codigoRz}`,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/scan", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    if (!codigoMl) throw new Error("Informe o SKU da etiqueta ou Codigo ML.");
    await recordOperatorActivity(req.session.user, "scan_ml", { lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    res.json(await scanLotRz({ userId: workspaceUserId(req), lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/scan/decrement", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    if (!codigoMl) throw new Error("Informe o SKU da etiqueta ou Codigo ML para diminuir.");
    await recordOperatorActivity(req.session.user, "decrement_scan", { lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    res.json(await decrementLotRzScan({ userId: workspaceUserId(req), lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/external-excess", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    await recordOperatorActivity(req.session.user, "create_external_excess", { lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    res.json(await createExternalExcess({ userId: workspaceUserId(req), lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/external-excess/manual", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    await recordOperatorActivity(req.session.user, "create_manual_product", { lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    res.json(
      await createManualExternalExcess({
        userId: workspaceUserId(req),
        createdByUserId: req.session.user?.id,
        operatorUserId: operatorUserId(req),
        lotId: req.params.lotId,
        codigoRz: req.params.codigoRz,
        codigoMl,
        manualProduct: req.body.manualProduct
      })
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/api/lots/:lotId/rz/:codigoRz/external-excess", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    if (!codigoMl) throw new Error("Informe o Codigo ML.");

    const product = await getExternalExcessProduct({ userId, lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    const integration = await getRequiredBlingCredentials(userId);
    const bling = await deleteBlingProductBySku({
      integration,
      sku: product.sku,
      saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
    });
    await recordOperatorActivity(req.session.user, "delete_external_excess", {
      lotId: req.params.lotId,
      codigoRz: req.params.codigoRz,
      codigoMl,
      sku: product.sku,
      blingStatus: bling.status
    });
    const result = await deleteExternalExcess({ userId, lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl });
    res.json({ ...result, bling });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/diverse-items", requireAuth, async (req, res) => {
  try {
    const userId = workspaceUserId(req);
    const codigoMl = String(req.body.codigoMl || "").trim().toUpperCase();
    const codigoRz = String(req.body.codigoRz || "").trim();
    const preview = Boolean(req.body.preview);
    const result = await addDiverseLotItem({
      userId,
      createdByUserId: req.session.user?.id,
      operatorUserId: operatorUserId(req),
      lotId: req.params.lotId,
      codigoMl,
      codigoRz,
      manualProduct: req.body.manualProduct,
      valorUnitOverride: req.body.valorUnitOverride,
      preview
    });

    if (!preview && result?.product?.id) {
      try {
        result.bling = await syncSingleNoSheetProductStockEntry(userId, result.lot, result.product, codigoRz);
      } catch (blingError) {
        result.bling = { ok: false, error: blingError.message };
      }
    }

    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/products/:productId/catalog-suggestion", requireAuth, requireOwner, async (req, res) => {
  try {
    res.json(
      await suggestCatalogUpdate({
        userId: workspaceUserId(req),
        createdByUserId: req.session.user?.id,
        operatorUserId: operatorUserId(req),
        lotId: req.params.lotId,
        productId: req.params.productId,
        payload: req.body
      })
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/rz/:codigoRz/pallet/:format", requireAuth, requireOwner, async (req, res) => {
  try {
    const lot = await getUserLotDetail(workspaceUserId(req), req.params.lotId);
    if (!lot) return res.status(404).json({ error: "Lote nÃ£o encontrado." });

    const pallet = buildPalletReport(lot, req.params.codigoRz);
    if (!pallet) return res.status(404).json({ error: "RZ nÃ£o encontrado neste lote." });

    const format = String(req.params.format || "").toLowerCase();
    const fileBase = `${safeFileName(lot.prefixoSku)}-${safeFileName(pallet.rz.codigoRz)}-pallet`;
    if (format === "xlsx") {
      const workbook = buildPalletWorkbook(pallet);
      const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.xlsx"`);
      return res.send(buffer);
    }

    if (format === "pdf") {
      const buffer = await buildPalletPdf(pallet);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.pdf"`);
      return res.send(buffer);
    }

    res.status(400).json({ error: "Formato invÃ¡lido." });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const codigoMl = String(req.query.codigoMl || "").trim().toUpperCase();
  if (codigoMl) await recordOperatorActivity(req.session.user, "search_ml", { codigoMl });
  res.json({ results: await searchProducts(workspaceUserId(req), codigoMl) });
});

app.post("/api/operator-activity", requireAuth, async (req, res) => {
  try {
    await recordOperatorActivity(req.session.user, String(req.body.action || ""), req.body.metadata || {});
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/labels", requireAuth, async (req, res) => {
  const result = await createLabel(workspaceUserId(req), req.body.productId, req.body.quantity);
  if (!result) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(result);
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Rota da API nao encontrada." });
});

app.use((error, req, res, next) => {
  if (!req.path.startsWith("/api")) return next(error);
  sendError(res, error);
});

app.get(["/", "/entradas", "/lotes", "/lotes/*", "/busca", "/transferencias", "/triagem", "/triagem/*", "/perfil", "/operadores/cadastro/*"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
  next();
}

async function refreshSessionUser(req) {
  const sessionUser = req.session.user;
  if (!sessionUser) return null;
  if (sessionUser.role === "admin") return sessionUser;

  const freshUser = await getPublicUserById(sessionUser.id);
  if (!freshUser) {
    req.session.user = null;
    return null;
  }
  req.session.user = freshUser;
  return freshUser;
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao back office." });
  next();
}

function requireOwner(req, res, next) {
  const role = req.session.user?.role || (req.session.user?.parentUserId ? "operator" : "owner");
  if (role !== "owner") return res.status(403).json({ error: "Acesso restrito ao usuario principal." });
  next();
}

async function requireTriageAccess(req, res, next) {
  try {
    if (req.session.user?.role === "admin") return next();
    const freshUser = await refreshSessionUser(req);
    if (freshUser?.triageAccess) return next();
    return res.status(403).json({ error: "Modulo de triagem nao liberado para este usuario." });
  } catch (error) {
    sendError(res, error);
  }
}

function workspaceUserId(req) {
  return req.session.user?.workspaceUserId || req.session.user?.id;
}

function operatorUserId(req) {
  return req.session.user?.role === "operator" ? req.session.user.id : null;
}

function triageStatusUrl(req, code) {
  return `${req.protocol}://${req.get("host")}/triagem/${encodeURIComponent(code)}`;
}

async function withTriageQrData(req, value) {
  if (Array.isArray(value)) return Promise.all(value.map((item) => withTriageQrData(req, item)));
  const statusUrl = triageStatusUrl(req, value.code);
  return {
    ...value,
    statusUrl,
    qrDataUrl: await QRCode.toDataURL(statusUrl, { margin: 1, width: 220 })
  };
}

function isAdminLogin(email, password) {
  return String(email || "").trim().toLowerCase() === ADMIN_EMAIL && String(password || "") === ADMIN_PASSWORD;
}

function hashInviteToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function sendError(res, error) {
  res.status(error.status || 400).json({ error: error.message, code: error.code });
}

function hasBlingAppConfig() {
  return Boolean(config.blingClientId && config.blingClientSecret);
}

async function getBlingAppCredentials(userId) {
  if (hasBlingAppConfig()) {
    return { clientId: config.blingClientId, clientSecret: config.blingClientSecret };
  }
  const appConfig = await getBlingAppConfig();
  if (appConfig?.clientId && appConfig?.clientSecret) {
    return { clientId: appConfig.clientId, clientSecret: appConfig.clientSecret };
  }
  throw new Error("Configure Client ID e Client Secret do Bling antes de autorizar.");
}

async function getRequiredBlingCredentials(userId) {
  const integration = await getUserBlingCredentials(userId);
  if (!integration?.accessToken || !integration?.refreshToken) {
    throw new Error("Autorize a integracao Bling na aba Perfil antes de enviar dados.");
  }
  const blingApp = await getBlingAppCredentials(userId);
  return { ...integration, clientId: blingApp.clientId, clientSecret: blingApp.clientSecret };
}

function getBlingRedirectUri(req) {
  const host = req.get("host");
  if (host === "etiquefacil.com.br" || host === "www.etiquefacil.com.br") {
    return "https://etiquefacil.com.br/api/integrations/bling/callback";
  }
  if (config.blingRedirectUri) return config.blingRedirectUri;
  return `${req.protocol}://${req.get("host")}/api/integrations/bling/callback`;
}

function getBlingRootRedirectUri(req) {
  const host = req.get("host");
  if (host === "etiquefacil.com.br" || host === "www.etiquefacil.com.br") {
    return "https://etiquefacil.com.br/";
  }
  return `${req.protocol}://${req.get("host")}/`;
}

function getBlingRedirectUriCandidates(req, primaryRedirectUri) {
  return [
    primaryRedirectUri,
    primaryRedirectUri.endsWith("/") ? primaryRedirectUri.slice(0, -1) : "",
    getBlingRedirectUri(req)
  ].filter((uri, index, items) => uri && items.indexOf(uri) === index);
}

async function exchangeBlingAuthorizationCodeWithFallback(blingApp, code, redirectUris) {
  let lastError;
  for (const redirectUri of redirectUris) {
    try {
      return await exchangeBlingAuthorizationCode(blingApp, code, redirectUri);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function exchangeBlingAuthorizationCode(blingApp, code, redirectUri) {
  const attempts = [
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${blingApp.clientId}:${blingApp.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "enable-jwt": "1"
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri })
    },
    {
      headers: {
        "Content-Type": "application/json",
        "enable-jwt": "1"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: blingApp.clientId,
        client_secret: blingApp.clientSecret
      })
    },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "enable-jwt": "1"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: blingApp.clientId,
        client_secret: blingApp.clientSecret
      }).toString()
    }
  ];

  let payload = {};
  let response = null;
  for (const attempt of attempts) {
    response = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if ((payload?.error?.message || payload?.error_description || payload?.error) !== "invalid_client") break;
  }
  const message = payload?.error?.message || payload?.error_description || payload?.error || "Nao foi possivel autorizar no Bling.";
  throw new Error(message);
}

function safeFileName(value) {
  return String(value || "etiquefacil").replace(/[^\w.-]+/g, "_");
}

function blingFileName(lot, kind) {
  return `${safeFileName(lot.prefixoSku)}-${kind}-bling.csv`;
}

function rzBlingFileName(lot, codigoRz) {
  return `${safeFileName(lot.prefixoSku)}-${safeFileName(codigoRz)}-bling.csv`;
}

function rzStockEntryFileName(lot, codigoRz) {
  return `${safeFileName(lot.prefixoSku)}-${safeFileName(codigoRz)}-entrada-estoque-bling.csv`;
}

function transferFileName(lot) {
  return `${safeFileName(lot.name)}-transferencia-bling.csv`;
}

async function getRzBlingData(userId, lotId, codigoRz) {
  const lot = await getUserLotDetail(userId, lotId);
  if (!lot) return null;

  const productsById = new Map();
  for (const item of lot.items || []) {
    if (item.codigoRz !== codigoRz || !item.product) continue;
    if (!["planilha", "entrada_diversos", "lote_sem_planilha", "lote_sem_planilha_manual"].includes(item.product.origem)) continue;
    const existing = productsById.get(item.product.id);
    const qtdTotal = Number(item.qtdEsperada || 0);
    if (existing) {
      existing.qtdTotal += qtdTotal;
    } else {
      productsById.set(item.product.id, { ...item.product, qtdTotal });
    }
  }

  if (!productsById.size) return null;
  return { lot, codigoRz, products: [...productsById.values()] };
}

async function getRzStockEntryData(userId, lotId, codigoRz) {
  const lot = await getUserLotDetail(userId, lotId);
  if (!lot) return null;
  if (!(lot.rzs || []).some((item) => item.codigoRz === codigoRz)) return null;

  const productsById = new Map();
  for (const item of lot.items || []) {
    if (item.codigoRz !== codigoRz || !item.product) continue;
    const qtdConferida = Number(item.qtdConferida || 0);
    if (qtdConferida <= 0) continue;

    const existing = productsById.get(item.product.id);
    if (existing) {
      existing.qtdConferida += qtdConferida;
    } else {
      productsById.set(item.product.id, {
        sku: item.product.sku || "",
        codigoMl: item.product.codigoMl || "",
        ean: item.product.ean || "",
        descricao: item.product.descricao || "",
        valorUnit: Number(item.product.valorUnit || 0),
        precoCusto: Number(item.product.precoCusto || 0),
        fornecedor: lot.fornecedor || "",
        link: item.product.link || "",
        foto: item.product.foto || "",
        qtdConferida
      });
    }
  }

  if (!productsById.size) return { lot, codigoRz, items: [] };
  return { lot, codigoRz, items: [...productsById.values()].sort((a, b) => a.sku.localeCompare(b.sku)) };
}

async function getLotStockBalanceData(userId, lotId) {
  const lot = await getUserLotDetail(userId, lotId);
  if (!lot) return null;

  const productsById = new Map();
  for (const item of lot.items || []) {
    if (!item.product) continue;
    const qtdConferida = Number(item.qtdConferida || 0);
    if (qtdConferida <= 0) continue;

    const existing = productsById.get(item.product.id);
    if (existing) {
      existing.qtdConferida += qtdConferida;
      existing.quantidade += qtdConferida;
    } else {
      productsById.set(item.product.id, {
        sku: item.product.sku || "",
        codigoMl: item.product.codigoMl || "",
        ean: item.product.ean || "",
        descricao: item.product.descricao || "",
        valorUnit: Number(item.product.valorUnit || 0),
        precoCusto: Number(item.product.precoCusto || 0),
        fornecedor: lot.fornecedor || "",
        link: item.product.link || "",
        foto: item.product.foto || "",
        qtdConferida,
        quantidade: qtdConferida
      });
    }
  }

  return { lot, items: [...productsById.values()].sort((a, b) => a.sku.localeCompare(b.sku)) };
}

async function getRzStockMovementItem(userId, lotId, codigoRz, codigoMl) {
  const lot = await getUserLotDetail(userId, lotId);
  if (!lot) return null;

  const normalizedMl = String(codigoMl || "").trim().toUpperCase();
  const matches = (lot.items || []).filter((candidate) => {
    const product = candidate.product || {};
    return (
      candidate.codigoRz === codigoRz &&
      (normalizeServerCode(product.codigoMl) === normalizedMl ||
        normalizeServerCode(product.sku) === normalizedMl ||
        code39BarcodeValue(product.sku) === normalizedMl)
    );
  });
  const productIds = new Set(matches.map((candidate) => candidate.product?.id).filter(Boolean));
  if (productIds.size > 1) {
    throw new Error("Codigo bipado corresponde a mais de um produto nesta RZ. Confira se a etiqueta e o Codigo ML nao estao duplicados.");
  }
  const item = matches[0];
  if (!item?.product) return null;

  return {
    sku: item.product.sku || "",
    codigoMl: item.product.codigoMl || "",
    ean: item.product.ean || "",
    descricao: item.product.descricao || "",
    valorUnit: Number(item.product.valorUnit || 0),
    precoCusto: Number(item.product.precoCusto || 0),
    fornecedor: lot.fornecedor || "",
    link: item.product.link || "",
    foto: item.product.foto || "",
    quantidade: 1,
    qtdConferida: 1
  };
}

function buildStockEntryCsvForRz(data) {
  return buildBlingStockEntryCsv(data.items, {
    deposito: BLING_STOCK_DEPOSIT,
    observacao: `Entrada por conferência RZ ${data.codigoRz}`
  });
}

function withLotSupplier(items, lot) {
  return (items || []).map((item) => ({ ...item, fornecedor: item.fornecedor || lot?.fornecedor || "" }));
}

function normalizeServerCode(value) {
  return String(value || "").trim().toUpperCase();
}

function code39BarcodeValue(value) {
  return normalizeServerCode(value).replace(/[^0-9A-Z .$/+%-]/g, "-");
}

async function syncSingleLotProductToBling(userId, lot, product) {
  const integration = await getRequiredBlingCredentials(userId);
  return syncBlingProducts({
    integration,
    products: withLotSupplier([product], lot),
    saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
  });
}

async function syncSplitProductToBling(userId, lot, product, quantity) {
  const integration = await getRequiredBlingCredentials(userId);
  const item = {
    sku: product.sku || "",
    codigoMl: product.codigoMl || "",
    ean: product.ean || "",
    descricao: product.descricao || "",
    valorUnit: Number(product.valorUnit || 0),
    precoCusto: Number(product.precoCusto || 0),
    fornecedor: lot.fornecedor || "",
    link: product.link || "",
    foto: product.foto || "",
    quantidade: Number(quantity || 0),
    qtdConferida: Number(quantity || 0)
  };
  return syncBlingStockBalances({
    integration,
    items: [item],
    depositoName: BLING_STOCK_DEPOSIT,
    observacao: `Desmembramento de produto ${product.sku || ""}`.trim(),
    saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
  });
}

async function syncSingleNoSheetProductStockEntry(userId, lot, product, codigoRz) {
  const integration = await getRequiredBlingCredentials(userId);
  return syncBlingStockMovement({
    integration,
    item: {
      sku: product.sku || "",
      codigoMl: product.codigoMl || "",
      ean: product.ean || "",
      descricao: product.descricao || "",
      valorUnit: Number(product.valorUnit || 0),
      precoCusto: Number(product.precoCusto || 0),
      fornecedor: lot.fornecedor || "",
      link: product.link || "",
      foto: product.foto || "",
      quantidade: 1,
      qtdConferida: 1
    },
    depositoName: BLING_STOCK_DEPOSIT,
    operation: "entry",
    observacao: `Entrada automatica lote sem planilha RZ ${codigoRz}`,
    saveIntegration: (payload) => saveUserBlingIntegration(userId, payload)
  });
}

function buildPalletReport(lot, codigoRz) {
  const rz = lot.rzs.find((item) => item.codigoRz === codigoRz);
  if (!rz) return null;

  const items = lot.items
    .filter((item) => item.codigoRz === codigoRz)
    .map((item) => {
      const product = item.product || {};
      const missing = Math.max(0, item.qtdEsperada - item.qtdConferida);
      const excess = item.tipoItem === "excedente_externo" ? item.qtdConferida : Math.max(0, item.qtdConferida - item.qtdEsperada);
      return {
        sku: product.sku || "",
        codigoMl: product.codigoMl || "",
        ean: product.ean || "",
        descricao: product.descricao || "",
        categoria: product.categoria || "",
        subcategoria: product.subcategoria || "",
        origem: product.origem || "",
        enderecoWms: item.enderecoWms || "",
        tipoItem: item.tipoItem || "",
        condicaoGrade: item.condicaoGrade || "",
        qtdEsperada: item.qtdEsperada || 0,
        qtdConferida: item.qtdConferida || 0,
        qtdTotal: product.qtdTotal || 0,
        faltante: missing,
        excedente: excess,
        valorUnit: Number(product.valorUnit || 0),
        precoCusto: Number(product.precoCusto || 0),
        valorTotalItem: Number(item.valorTotal || 0),
        valorEsperado: Number(item.qtdEsperada || 0) * Number(product.valorUnit || 0),
        valorConferido: Number(item.qtdConferida || 0) * Number(product.valorUnit || 0)
      };
    });

  const status = rz.missing === 0 && rz.excess === 0 ? "Concluido" : rz.checked > 0 ? "Em andamento" : "Pendente";
  return { lot, rz, status, items };
}

function buildPalletWorkbook(pallet) {
  const summaryRows = [
    ["Lote", pallet.lot.nomeArquivo],
    ["RZ", pallet.rz.codigoRz],
    ["Status", pallet.status],
    ["Itens esperados", pallet.rz.expected],
    ["Conferido", pallet.rz.checked],
    ["Faltante", pallet.rz.missing],
    ["Excedente", pallet.rz.excess],
    ["Venda total", pallet.rz.expectedValue],
    ["Venda conferida", pallet.rz.checkedValue],
    ["Valor faltante", pallet.rz.missingValue],
    ["Valor excedente", pallet.rz.excessValue]
  ];
  const itemRows = pallet.items.map((item) => ({
    SKU: item.sku,
    "Codigo ML": item.codigoMl,
    EAN: item.ean,
    Descricao: item.descricao,
    "Endereco WMS": item.enderecoWms,
    Tipo: item.tipoItem,
    Grade: item.condicaoGrade,
    Categoria: item.categoria,
    Subcategoria: item.subcategoria,
    Origem: item.origem,
    "Estoque total": item.qtdTotal,
    Esperado: item.qtdEsperada,
    Conferido: item.qtdConferida,
    Faltante: item.faltante,
    Excedente: item.excedente,
    "Valor unitario": item.valorUnit,
    "Preco custo": item.precoCusto,
    "Valor total item": item.valorTotalItem,
    "Venda esperada": item.valorEsperado,
    "Venda conferida": item.valorConferido
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Resumo");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(itemRows), "Itens");
  return workbook;
}

function buildPalletPdf(pallet) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 36, size: "A4" });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    document.fontSize(18).text(`Relatorio do pallet ${pallet.rz.codigoRz}`, { underline: true });
    document.moveDown(0.5);
    document.fontSize(10).text(`Lote: ${pallet.lot.nomeArquivo}`);
    document.text(`Status: ${pallet.status}`);
    document.text(`Itens: ${pallet.rz.expected} | Conferido: ${pallet.rz.checked} | Faltante: ${pallet.rz.missing} | Excedente: ${pallet.rz.excess}`);
    document.text(`Venda total: ${formatCurrency(pallet.rz.expectedValue)} | Venda conferida: ${formatCurrency(pallet.rz.checkedValue)}`);
    document.text(`Valor faltante: ${formatCurrency(pallet.rz.missingValue)} | Valor excedente: ${formatCurrency(pallet.rz.excessValue)}`);
    document.moveDown();

    document.fontSize(12).text("Itens do pallet");
    document.moveDown(0.4);
    for (const item of pallet.items) {
      if (document.y > 735) document.addPage();
      document
        .fontSize(9)
        .text(`${item.sku} | ML ${item.codigoMl} | ${item.descricao}`, { continued: false })
        .fontSize(8)
        .fillColor("#555")
        .text(`End: ${item.enderecoWms || "-"} | Esp: ${item.qtdEsperada} | Conf: ${item.qtdConferida} | Falt: ${item.faltante} | Exc: ${item.excedente} | Venda: ${formatCurrency(item.valorEsperado)}`)
        .text(`Tipo: ${item.tipoItem || "-"} | Grade: ${item.condicaoGrade || "-"} | Origem: ${item.origem || "-"} | Categoria: ${item.categoria || "-"} / ${item.subcategoria || "-"} | Custo: ${formatCurrency(item.precoCusto)} | Estoque: ${item.qtdTotal}`)
        .fillColor("#111");
      document.moveDown(0.35);
    }

    document.end();
  });
}

function parseNoSheetSuggestionFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    return parseNoSheetSuggestionRows(rows);
  }
  return parseNoSheetSuggestions(file.buffer.toString("utf8"));
}

function parseNoSheetSuggestionRows(rows) {
  const usefulRows = (rows || []).filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim()));
  if (!usefulRows.length) return [];
  const header = usefulRows[0].map((cell) => normalizeHeader(cell));
  const nameColumn = header.findIndex((name) => ["produto", "nome", "descricao", "descrição", "item"].includes(name));
  const start = nameColumn >= 0 ? 1 : 0;
  const column = nameColumn >= 0 ? nameColumn : 0;
  return usefulRows.slice(start).map((row) => row[column]).filter((value) => String(value ?? "").trim());
}

function parseNoSheetSuggestions(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/[;\t,]/)[0])
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function uniqueDownloadName(directory, fileName) {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let counter = 2;
  while (await exists(path.join(directory, candidate))) {
    candidate = `${parsed.name}-${counter}${parsed.ext}`;
    counter += 1;
  }
  return candidate;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function revealFile(filePath) {
  if (process.platform === "win32") {
    spawn("explorer.exe", [`/select,${filePath}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  }
}

async function seedBlingAppConfigFromEnv() {
  if (!hasBlingAppConfig()) return;
  try {
    await saveBlingAppConfig({
      clientId: config.blingClientId,
      clientSecret: config.blingClientSecret
    });
  } catch (error) {
    console.error("Falha ao configurar app Bling pelo ambiente:", error);
  }
}

ensureStore()
  .then(seedBlingAppConfigFromEnv)
  .catch((error) => {
    console.error("Falha ao inicializar o banco:", error);
  });

app.get(["/transferencias/*", "/lotes/*", "/perfil", "/entradas", "/busca", "/bling", "/triagem", "/triagem/*", "/operadores/cadastro/*"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(config.port, () => {
  console.log(`Etiquefácil rodando em http://localhost:${config.port}`);
});
