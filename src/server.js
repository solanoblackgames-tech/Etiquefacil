import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { buildBlingCsv, formatSku, importSpecialistWorkbook, roundMoney } from "./domain.js";
import { createUser, ensureStore, getPgPool, hasPostgres, readDb, verifyUser, writeDb } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const PostgresSessionStore = pgSession(session);
const downloadMode = process.env.DOWNLOAD_MODE || (process.env.NODE_ENV === "production" ? "browser" : "local");

app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : 0);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "etiquefacil-dev-secret",
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
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/config", (req, res) => {
  res.json({ downloadMode });
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
  const user = await verifyUser(req.body.email || "", req.body.password || "");
  if (!user) return res.status(401).json({ error: "Login ou senha inválidos." });
  req.session.user = user;
  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/lots", requireAuth, async (req, res) => {
  const db = await readDb();
  const lots = db.lots
    .filter((lot) => lot.userId === req.session.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((lot) => summarizeLot(db, lot));
  res.json({ lots });
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
    const db = await readDb();
    const lot = {
      id: randomUUID(),
      userId: req.session.user.id,
      nomeArquivo: req.file.originalname,
      percentualArremate: auctionPercent,
      fornecedor,
      prefixoSku: skuPrefix,
      proximoSequencialSku: imported.nextSequence,
      createdAt: new Date().toISOString()
    };

    const products = imported.products.map((product) => ({ ...product, lotId: lot.id }));
    const rzItems = imported.items.map((item) => {
      const product = products.find((candidate) => candidate.id === item.productTempId);
      const { productTempId, ...cleanItem } = item;
      return { ...cleanItem, lotId: lot.id, productId: product.id };
    });

    db.lots.push(lot);
    db.products.push(...products);
    db.rzItems.push(...rzItems);
    await writeDb(db);
    res.json({ lot: summarizeLot(db, lot) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/lots/:lotId", requireAuth, async (req, res) => {
  const db = await readDb();
  const lot = getUserLot(db, req);
  if (!lot) return res.status(404).json({ error: "Lote não encontrado." });
  res.json({ lot: summarizeLot(db, lot, true) });
});

app.get("/api/lots/:lotId/bling/:kind", requireAuth, async (req, res) => {
  const db = await readDb();
  const lot = getUserLot(db, req);
  if (!lot) return res.status(404).json({ error: "Lote não encontrado." });

  const products = getBlingProducts(db, lot, req.params.kind);
  const csv = buildBlingCsv(products, lot);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${blingFileName(lot, req.params.kind)}"`);
  res.send(`\uFEFF${csv}`);
});

app.post("/api/lots/:lotId/bling/:kind/save", requireAuth, async (req, res) => {
  try {
    const db = await readDb();
    const lot = getUserLot(db, req);
    if (!lot) return res.status(404).json({ error: "Lote não encontrado." });

    const products = getBlingProducts(db, lot, req.params.kind);
    const csv = buildBlingCsv(products, lot);
    const downloadsDir = path.join(os.homedir(), "Downloads");
    await fs.mkdir(downloadsDir, { recursive: true });
    const fileName = await uniqueDownloadName(downloadsDir, blingFileName(lot, req.params.kind));
    const filePath = path.join(downloadsDir, fileName);
    await fs.writeFile(filePath, `\uFEFF${csv}`, "utf8");
    revealFile(filePath);
    res.json({ fileName, path: filePath, count: products.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/scan", requireAuth, async (req, res) => {
  try {
    const db = await readDb();
    const lot = getUserLot(db, req);
    if (!lot) return res.status(404).json({ error: "Lote não encontrado." });

    const codigoMl = String(req.body.codigoMl || "").trim();
    if (!codigoMl) throw new Error("Informe o Código ML.");

    const rzItems = db.rzItems.filter((item) => item.lotId === lot.id && item.codigoRz === req.params.codigoRz);
    const sameRzItem = rzItems.find((item) => db.products.find((product) => product.id === item.productId)?.codigoMl === codigoMl);
    const scan = {
      id: randomUUID(),
      lotId: lot.id,
      codigoRz: req.params.codigoRz,
      codigoMl,
      status: "ok",
      createdAt: new Date().toISOString()
    };

    if (sameRzItem) {
      sameRzItem.qtdConferida += 1;
      const scannedProduct = db.products.find((product) => product.id === sameRzItem.productId);
      if (scannedProduct?.origem === "excedente_externo") {
        scannedProduct.qtdTotal += 1;
      }
      if (sameRzItem.qtdConferida > sameRzItem.qtdEsperada) {
        sameRzItem.tipoItem = sameRzItem.tipoItem === "esperado" ? "excedente_outro_rz" : sameRzItem.tipoItem;
        scan.status = "excedente";
      }
    } else {
      const sameLotProduct = db.products.find((product) => product.lotId === lot.id && product.codigoMl === codigoMl);
      if (sameLotProduct) {
        scan.status = "outro_rz";
      } else {
        const history = findProductHistory(db, req.session.user.id, lot.id, codigoMl);
        scan.status = history.length ? "historico" : "desconhecido";
        scan.history = history.slice(0, 5);
      }
    }

    db.scans.push(scan);
    await writeDb(db);
    res.json({ scan, lot: summarizeLot(db, lot, true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lots/:lotId/rz/:codigoRz/external-excess", requireAuth, async (req, res) => {
  try {
    const db = await readDb();
    const lot = getUserLot(db, req);
    if (!lot) return res.status(404).json({ error: "Lote não encontrado." });

    const codigoMl = String(req.body.codigoMl || "").trim();
    const history = findProductHistory(db, req.session.user.id, lot.id, codigoMl)[0];
    if (!history) throw new Error("Código ML não encontrado em outras planilhas deste usuário.");

    const existing = db.products.find((product) => product.lotId === lot.id && product.codigoMl === codigoMl);
    if (existing) throw new Error("Este Código ML já existe no lote atual.");

    const sku = formatSku(lot.prefixoSku, lot.proximoSequencialSku);
    const product = {
      id: randomUUID(),
      lotId: lot.id,
      codigoMl,
      sku,
      descricao: history.descricao,
      valorUnit: history.valorUnit,
      precoCusto: roundMoney(history.valorUnit * (lot.percentualArremate / 100)),
      qtdTotal: 1,
      categoria: history.categoria || "",
      subcategoria: history.subcategoria || "",
      origem: "excedente_externo",
      createdAt: new Date().toISOString()
    };
    const item = {
      id: randomUUID(),
      lotId: lot.id,
      productId: product.id,
      codigoRz: req.params.codigoRz,
      enderecoWms: "",
      qtdEsperada: 0,
      qtdConferida: 1,
      condicaoGrade: "",
      valorTotal: history.valorUnit,
      tipoItem: "excedente_externo",
      createdAt: new Date().toISOString()
    };

    lot.proximoSequencialSku += 1;
    db.products.push(product);
    db.rzItems.push(item);
    await writeDb(db);
    res.json({ product, lot: summarizeLot(db, lot, true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const db = await readDb();
  const codigoMl = String(req.query.codigoMl || "").trim();
  const lotsById = new Map(db.lots.filter((lot) => lot.userId === req.session.user.id).map((lot) => [lot.id, lot]));
  const results = db.products
    .filter((product) => product.codigoMl === codigoMl && lotsById.has(product.lotId))
    .map((product) => ({
      ...product,
      lot: lotsById.get(product.lotId),
      rzs: db.rzItems.filter((item) => item.productId === product.id).map((item) => item.codigoRz)
    }));
  res.json({ results });
});

app.post("/api/labels", requireAuth, async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.body.productId);
  const lot = product && db.lots.find((item) => item.id === product.lotId && item.userId === req.session.user.id);
  if (!product || !lot) return res.status(404).json({ error: "Produto não encontrado." });
  const label = {
    id: randomUUID(),
    productId: product.id,
    lotId: lot.id,
    userId: req.session.user.id,
    createdAt: new Date().toISOString()
  };
  db.labels.push(label);
  await writeDb(db);
  res.json({ label, product, lot });
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Faça login para continuar." });
  next();
}

function getUserLot(db, req) {
  return db.lots.find((lot) => lot.id === req.params.lotId && lot.userId === req.session.user.id);
}

function summarizeLot(db, lot, includeItems = false) {
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
    totalExcessExternal: products.filter((product) => product.origem === "excedente_externo").length,
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

function findProductHistory(db, userId, currentLotId, codigoMl) {
  const userLots = new Map(db.lots.filter((lot) => lot.userId === userId && lot.id !== currentLotId).map((lot) => [lot.id, lot]));
  return db.products
    .filter((product) => product.codigoMl === codigoMl && userLots.has(product.lotId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((product) => ({ ...product, lot: userLots.get(product.lotId) }));
}

function safeFileName(value) {
  return String(value || "etiquefacil").replace(/[^\w.-]+/g, "_");
}

function blingFileName(lot, kind) {
  return `${safeFileName(lot.prefixoSku)}-${kind}-bling.csv`;
}

function getBlingProducts(db, lot, kind) {
  let products = db.products.filter((product) => product.lotId === lot.id);
  if (kind === "complete") return products.filter((product) => product.origem === "planilha");
  if (kind === "excess") return products.filter((product) => product.origem === "excedente_externo");
  throw new Error("Tipo de exportação inválido.");
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
app.listen(PORT, () => {
  console.log(`Etiquefácil rodando em http://localhost:${PORT}`);
});
