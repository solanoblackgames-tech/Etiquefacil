import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import XLSX from "xlsx";
import "dotenv/config";
import { buildBlingCsv, importSpecialistWorkbook } from "./domain.js";
import { buildRuntimeConfig } from "./config.js";
import {
  addDiverseLotItem,
  createExternalExcess,
  createDiverseLot,
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

app.post("/api/diverse-lots", requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim() || `Entrada diversos ${new Date().toLocaleDateString("pt-BR")}`;
    const fornecedor = String(req.body.fornecedor || "").trim();
    const skuPrefix = String(req.body.skuPrefix || "").trim().toUpperCase();
    const startSequence = Number(req.body.startSequence);
    if (!fornecedor) throw new Error("Informe o fornecedor do lote.");
    if (!skuPrefix) throw new Error("Informe o prefixo do SKU.");
    if (!Number.isFinite(startSequence) || startSequence < 1) throw new Error("Informe o sequencial inicial do SKU.");

    const lot = await createDiverseLot({
      userId: req.session.user.id,
      name,
      fornecedor,
      skuPrefix,
      startSequence
    });
    res.json({ lot });
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

app.post("/api/lots/:lotId/diverse-items", requireAuth, async (req, res) => {
  try {
    const codigoMl = String(req.body.codigoMl || "").trim();
    const codigoRz = String(req.body.codigoRz || "").trim();
    res.json(await addDiverseLotItem({ userId: req.session.user.id, lotId: req.params.lotId, codigoMl, codigoRz }));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lots/:lotId/rz/:codigoRz/pallet/:format", requireAuth, async (req, res) => {
  try {
    const lot = await getUserLotDetail(req.session.user.id, req.params.lotId);
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

await ensureStore();
app.listen(config.port, () => {
  console.log(`Etiquefácil rodando em http://localhost:${config.port}`);
});
