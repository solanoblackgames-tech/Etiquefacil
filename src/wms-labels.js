import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const MM_TO_PT = 72 / 25.4;
const LABEL = { width: 100 * MM_TO_PT, height: 150 * MM_TO_PT };

export function normalizeWmsDeposit(input = {}) {
  const depositName = String(input.depositName ?? input.deposit_name ?? input.deposito ?? "").trim();
  const prefix = normalizeWmsPrefix(input.prefix || depositName);
  const rows = normalizeWmsRows(input.rowsConfig || input.rows_config || input.ruasConfig || input.ruas, input);
  if (!depositName) throw new Error("Informe o deposito WMS.");
  return {
    depositName,
    prefix,
    rowsConfig: rows,
    rows: rows.length,
    columns: Math.max(...rows.map((row) => row.columns)),
    positions: Math.max(...rows.map((row) => row.positions))
  };
}

export function normalizeWmsDeposits(input = []) {
  const rows = Array.isArray(input) ? input : [];
  const normalized = [];
  const seen = new Set();
  for (const row of rows) {
    const deposit = normalizeWmsDeposit(row);
    const key = normalizeWmsPrefix(deposit.depositName);
    if (seen.has(key)) continue;
    normalized.push(deposit);
    seen.add(key);
  }
  return normalized;
}

export function buildWmsPositionCodes(input = {}) {
  const options = normalizeWmsDeposit(input);
  const codes = [];
  for (const row of options.rowsConfig) {
    const rowLabel = row.label;
    for (let column = 1; column <= options.columns; column += 1) {
      if (column > row.columns) continue;
      for (let position = 1; position <= row.positions; position += 1) {
        codes.push(`${options.prefix}-${rowLabel}-${column}-${position}`);
      }
    }
  }
  return codes;
}

export async function buildWmsLocationLabelsPdf(input = {}) {
  const options = normalizeWmsDeposit(input);
  const codes = buildWmsPositionCodes(options);
  const doc = new PDFDocument({ size: [LABEL.width, LABEL.height], margin: 0 });
  const chunks = [];
  const output = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.on("data", (chunk) => chunks.push(chunk));
  doc.font("Helvetica");

  for (let index = 0; index < codes.length; index += 1) {
    if (index > 0) doc.addPage({ size: [LABEL.width, LABEL.height], margin: 0 });
    await drawWmsLabel(doc, codes[index], options.depositName);
  }

  doc.end();
  return output;
}

async function drawWmsLabel(doc, code, depositName) {
  const qrSize = 64 * MM_TO_PT;
  const qrDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 720, errorCorrectionLevel: "M" });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  doc.save();
  doc.rect(0, 0, LABEL.width, LABEL.height).fill("#ffffff");
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(18).text("ETIQUEFACIL WMS", 12 * MM_TO_PT, 10 * MM_TO_PT, {
    width: LABEL.width - 24 * MM_TO_PT,
    align: "center"
  });
  doc.fillColor("#475569").font("Helvetica").fontSize(12).text(depositName, 12 * MM_TO_PT, 20 * MM_TO_PT, {
    width: LABEL.width - 24 * MM_TO_PT,
    align: "center"
  });
  doc.image(qrBuffer, (LABEL.width - qrSize) / 2, 36 * MM_TO_PT, { width: qrSize, height: qrSize });
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(fitFontSize(doc, code, LABEL.width - 16 * MM_TO_PT, 22, 12)).text(code, 8 * MM_TO_PT, 108 * MM_TO_PT, {
    width: LABEL.width - 16 * MM_TO_PT,
    align: "center",
    lineBreak: false
  });
  doc.fillColor("#64748b").font("Helvetica").fontSize(9).text("Bipe esta etiqueta ao alocar o produto", 8 * MM_TO_PT, 132 * MM_TO_PT, {
    width: LABEL.width - 16 * MM_TO_PT,
    align: "center"
  });
  doc.restore();
}

function rowToLetters(value) {
  let number = value;
  let text = "";
  while (number > 0) {
    number -= 1;
    text = String.fromCharCode(65 + (number % 26)) + text;
    number = Math.floor(number / 26);
  }
  return text;
}

function normalizeWmsRows(input, source = {}) {
  const rows = parseRowsConfig(input);
  if (rows.length) return rows;

  const rowCount = clampInteger(source.rows ?? source.rowCount ?? 1, 1, 200, 1);
  const columns = clampInteger(source.columns ?? source.colunas, 1, 200, 1);
  const positions = clampInteger(source.positions ?? source.posicoes, 1, 200, 1);
  return Array.from({ length: rowCount }, (_, index) => ({
    label: rowToLetters(index + 1),
    columns,
    positions
  }));
}

function parseRowsConfig(input) {
  if (!Array.isArray(input) && !String(input || "").trim()) return [];
  const rows = Array.isArray(input)
    ? input
    : String(input || "").split(/\r?\n/).map((line) => {
        const [label, columns, positions] = line.split("|").map((part) => part.trim());
        return { label, columns, positions };
      });
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const label = normalizeRowLabel(row.label || row.rua || row.name || row.nome || rowToLetters(index + 1));
    if (!label || seen.has(label)) continue;
    normalized.push({
      label,
      columns: clampInteger(row.columns ?? row.colunas, 1, 200, 1),
      positions: clampInteger(row.positions ?? row.posicoes, 1, 200, 1)
    });
    seen.add(label);
  }
  return normalized;
}

function normalizeRowLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 6);
}

function normalizeWmsPrefix(value) {
  const normalized = String(value || "WMS")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized || "WMS";
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function fitFontSize(doc, text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 0.5) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= maxWidth) return size;
  }
  return minSize;
}
