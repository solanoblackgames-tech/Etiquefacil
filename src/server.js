import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { buildBlingCsv, importSpecialistWorkbook } from "./domain.js";
import { buildRuntimeConfig } from "./config.js";
import {
  createExternalExcess,
  createLabel,
  createLotFromImport,
  createUser,
  deleteUser,
  deleteUserLot,
  ensureStore,
  getLotBlingData,
  getPgPool,
  getStoreHealth,
  getUserLotDetail,
  getUserLotSummaries,
  hasPostgres,
  listUsersForAdmin,
  scanLotRz,
  searchProducts,
  updateUserPassword,
  verifyUser
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const config = buildRuntimeConfig();
const PostgresSessionStore = pgSession(session);
const ADMIN_EMAIL = "lucassolano@jz";
const ADMIN_PASSWORD = "Jz2026";
const ADMIN_USER = {
  id: "backoffice-admin",
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
    store: hasPostgres()
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

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
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
  if (isAdminLogin(req.body.email, req.body.password)) {
    req.session.user = ADMIN_USER;
    return res.json({ user: ADMIN_USER });
  }

  const user = await verifyUser(req.body.email || "", req.body.password || "");
  if (!user) return res.status(401).json({ error: "Login ou senha inválidos." });
  req.session.user = user;
  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  res.json({ users: await listUsersForAdmin() });
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

app.delete("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  try {
    res.json(await deleteUser(req.params.userId));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots", requireAuth, async (req, res) => {
  res.json({ lots: await getUserLotSummaries(req.session.user.id) });
});

app.post("/api/lots", requireAuth, upload.single("file"), async (req, res) => {
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
      userId: req.session.user.id,
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
  const lot = await getUserLotDetail(req.session.user.id, req.params.lotId);
  if (!lot) return res.status(404).json({ error: "Lote não encontrado." });
  res.json({ lot });
});

app.delete("/api/lots/:lotId", requireAuth, async (req, res) => {
  try {
    res.json(await deleteUserLot(req.session.user.id, req.params.lotId));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/bling/:kind", requireAuth, async (req, res) => {
  try {
    const data = await getLotBlingData(req.session.user.id, req.params.lotId, req.params.kind);
    if (!data) return res.status(404).json({ error: "Lote não encontrado." });

    const csv = buildBlingCsv(data.products, data.lot);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${blingFileName(data.lot, req.params.kind)}"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/bling/:kind/save", requireAuth, async (req, res) => {
  try {
    const data = await getLotBlingData(req.session.user.id, req.params.lotId, req.params.kind);
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

app.post("/api/lots/:lotId/rz/:codigoRz/scan", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim();
    if (!codigoMl) throw new Error("Informe o Código ML.");
    res.json(await scanLotRz({ userId: req.session.user.id, lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl }));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/external-excess", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim();
    res.json(await createExternalExcess({ userId: req.session.user.id, lotId: req.params.lotId, codigoRz: req.params.codigoRz, codigoMl }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const codigoMl = String(req.query.codigoMl || "").trim();
  res.json({ results: await searchProducts(req.session.user.id, codigoMl) });
});

app.post("/api/labels", requireAuth, async (req, res) => {
  const result = await createLabel(req.session.user.id, req.body.productId);
  if (!result) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(result);
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao back office." });
  next();
}

function isAdminLogin(email, password) {
  return String(email || "").trim().toLowerCase() === ADMIN_EMAIL && String(password || "") === ADMIN_PASSWORD;
}

function sendError(res, error) {
  res.status(error.status || 400).json({ error: error.message });
}

function safeFileName(value) {
  return String(value || "etiquefacil").replace(/[^\w.-]+/g, "_");
}

function blingFileName(lot, kind) {
  return `${safeFileName(lot.prefixoSku)}-${kind}-bling.csv`;
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

await ensureStore();
app.listen(config.port, () => {
  console.log(`Etiquefácil rodando em http://localhost:${config.port}`);
});
