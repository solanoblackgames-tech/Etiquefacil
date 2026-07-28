import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const MM_TO_PT = 72 / 25.4;
const A4 = { width: 210 * MM_TO_PT, height: 297 * MM_TO_PT };
const DEFAULT_COLUMNS = 5;

export function normalizeSecuritySealOptions(input = {}) {
  const columns = clampInteger(input.columns, 3, 8, DEFAULT_COLUMNS);
  const pages = clampInteger(input.pages, 1, 50, 0);
  const quantity = pages
    ? pages * securitySealsPerPage({ columns })
    : clampInteger(input.quantity, 1, 500, securitySealsPerPage({ columns }));
  const start = clampInteger(input.start, 1, 999999, 1);
  const prefix = normalizeSealPrefix(input.prefix || "LCR");
  return { quantity, start, columns, prefix, pages: pages || Math.ceil(quantity / securitySealsPerPage({ columns })) };
}

export function buildSecuritySealCodes(input = {}) {
  const options = normalizeSecuritySealOptions(input);
  const quantity = fullPageSealQuantity(options);
  return Array.from({ length: quantity }, (_, index) => `${options.prefix}-${String(options.start + index).padStart(6, "0")}`);
}

export function securitySealsPerPage(input = {}) {
  const layout = securitySealLayout(input);
  return layout.columns * layout.rows;
}

export function fullPageSealQuantity(input = {}) {
  const options = normalizeSecuritySealOptions(input);
  const perPage = securitySealsPerPage(options);
  return Math.ceil(options.quantity / perPage) * perPage;
}

export async function buildSecuritySealsPdf(input = {}) {
  const options = normalizeSecuritySealOptions(input);
  const codes = buildSecuritySealCodes(options);
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
  const chunks = [];
  const output = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.on("data", (chunk) => chunks.push(chunk));
  doc.font("Helvetica");

  const layout = securitySealLayout(options);
  const perPage = layout.columns * layout.rows;

  for (let index = 0; index < codes.length; index += 1) {
    if (index > 0 && index % perPage === 0) doc.addPage();
    const pageIndex = index % perPage;

    const column = pageIndex % layout.columns;
    const row = Math.floor(pageIndex / layout.columns);
    const x = layout.margin + column * (layout.labelWidth + layout.gap);
    const y = layout.margin + row * (layout.labelHeight + layout.gap);
    await drawSeal(doc, codes[index], x, y, layout.labelWidth, layout.labelHeight);
  }

  doc.end();
  return output;
}

async function drawSeal(doc, code, x, y, width, height) {
  const padding = 3 * MM_TO_PT;
  const qrSize = Math.min(width - padding * 2, height * 0.58);
  const qrDataUrl = await QRCode.toDataURL(code, { margin: 0, width: 180, errorCorrectionLevel: "M" });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  doc.save();
  doc.roundedRect(x, y, width, height, 2).dash(2, { space: 1.5 }).lineWidth(0.45).strokeColor("#94a3b8").stroke();
  doc.undash();
  doc.image(qrBuffer, x + (width - qrSize) / 2, y + padding, { width: qrSize, height: qrSize });

  const textX = x + padding;
  const textWidth = width - padding * 2;
  const codeY = y + padding + qrSize + 5;
  doc.font("Helvetica-Bold").fontSize(fitFontSize(doc, code, textWidth, 8.8, 6.4));
  doc.fillColor("#0f172a").text(code, textX, codeY, {
    width: textWidth,
    align: "center",
    lineBreak: false
  });
  doc.fillColor("#64748b").font("Helvetica").fontSize(6.2).text("Triagem", textX, codeY + 12, {
    width: textWidth,
    align: "center",
    lineBreak: false
  });
  doc.restore();
}

function securitySealLayout(input = {}) {
  const columns = clampInteger(input.columns, 3, 8, DEFAULT_COLUMNS);
  const margin = 8 * MM_TO_PT;
  const gap = 2 * MM_TO_PT;
  const usableWidth = A4.width - margin * 2;
  const labelWidth = (usableWidth - gap * (columns - 1)) / columns;
  const labelHeight = labelWidth;
  const rows = Math.max(1, Math.floor((A4.height - margin * 2 + gap) / (labelHeight + gap)));
  return { columns, rows, margin, gap, labelWidth, labelHeight };
}

function fitFontSize(doc, text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 0.2) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= maxWidth) return size;
  }
  return minSize;
}

function normalizeSealPrefix(value) {
  const normalized = String(value || "LCR")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  return normalized || "LCR";
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
