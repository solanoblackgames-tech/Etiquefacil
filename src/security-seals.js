import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const MM_TO_PT = 72 / 25.4;
const A4 = { width: 210 * MM_TO_PT, height: 297 * MM_TO_PT };
const DEFAULT_COLUMNS = 5;
const SECURITY_SEAL_LABEL_HEIGHT = 21 * MM_TO_PT;

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
  const columns = clampInteger(input.columns, 3, 8, DEFAULT_COLUMNS);
  const margin = 8 * MM_TO_PT;
  const gap = 2 * MM_TO_PT;
  const labelHeight = SECURITY_SEAL_LABEL_HEIGHT;
  const rows = Math.max(1, Math.floor((A4.height - margin * 2 + gap) / (labelHeight + gap)));
  return columns * rows;
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

  const margin = 8 * MM_TO_PT;
  const gap = 2 * MM_TO_PT;
  const usableWidth = A4.width - margin * 2;
  const labelWidth = (usableWidth - gap * (options.columns - 1)) / options.columns;
  const labelHeight = SECURITY_SEAL_LABEL_HEIGHT;
  const rows = Math.max(1, Math.floor((A4.height - margin * 2 + gap) / (labelHeight + gap)));
  const perPage = options.columns * rows;

  for (let index = 0; index < codes.length; index += 1) {
    if (index > 0 && index % perPage === 0) doc.addPage();
    const pageIndex = index % perPage;

    const column = pageIndex % options.columns;
    const row = Math.floor(pageIndex / options.columns);
    const x = margin + column * (labelWidth + gap);
    const y = margin + row * (labelHeight + gap);
    await drawSeal(doc, codes[index], x, y, labelWidth, labelHeight);
  }

  doc.end();
  return output;
}

async function drawSeal(doc, code, x, y, width, height) {
  const padding = 3.5 * MM_TO_PT;
  const qrSize = height - padding * 2;
  const qrDataUrl = await QRCode.toDataURL(code, { margin: 0, width: 180, errorCorrectionLevel: "M" });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  doc.save();
  doc.roundedRect(x, y, width, height, 2).dash(2, { space: 1.5 }).lineWidth(0.45).strokeColor("#94a3b8").stroke();
  doc.undash();
  doc.image(qrBuffer, x + padding, y + padding, { width: qrSize, height: qrSize });

  const textX = x + padding + qrSize + 4;
  const textWidth = width - (textX - x) - padding;
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(8.5).text(code, textX, y + padding + 1, {
    width: textWidth,
    ellipsis: true
  });
  doc.fillColor("#334155").font("Helvetica-Bold").fontSize(7).text("LACRE", textX, y + padding + 13, { width: textWidth });
  doc.fillColor("#64748b").font("Helvetica").fontSize(5.8).text("Triagem", textX, y + padding + 23, { width: textWidth });
  doc.restore();
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
