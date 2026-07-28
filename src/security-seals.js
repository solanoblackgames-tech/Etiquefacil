import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const MM_TO_PT = 72 / 25.4;
const A4 = { width: 210 * MM_TO_PT, height: 297 * MM_TO_PT };
const SECURITY_SEAL_SIZE = 15 * MM_TO_PT;
const SECURITY_SEAL_GAP = 1 * MM_TO_PT;
const SECURITY_SEAL_MARGIN = 8 * MM_TO_PT;

export function normalizeSecuritySealOptions(input = {}) {
  const pages = clampInteger(input.pages, 1, 50, 0);
  const quantity = pages
    ? pages * securitySealsPerPage()
    : clampInteger(input.quantity, 1, 10000, securitySealsPerPage());
  const start = clampInteger(input.start, 1, 999999, 1);
  const prefix = normalizeSealPrefix(input.prefix || "LCR");
  return { quantity, start, prefix, pages: pages || Math.ceil(quantity / securitySealsPerPage()) };
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
  const padding = 1 * MM_TO_PT;
  const qrSize = 10.2 * MM_TO_PT;
  const qrDataUrl = await QRCode.toDataURL(code, { margin: 0, width: 180, errorCorrectionLevel: "M" });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  doc.save();
  doc.rect(x, y, width, height).dash(1.4, { space: 1.2 }).lineWidth(0.35).strokeColor("#94a3b8").stroke();
  doc.undash();
  doc.image(qrBuffer, x + (width - qrSize) / 2, y + 1.25 * MM_TO_PT, { width: qrSize, height: qrSize });

  const textX = x + padding;
  const textWidth = width - padding * 2;
  const codeY = y + 12.1 * MM_TO_PT;
  doc.font("Helvetica-Bold").fontSize(fitFontSize(doc, code, textWidth, 4.1, 3.1));
  doc.fillColor("#0f172a").text(code, textX, codeY, {
    width: textWidth,
    align: "center",
    lineBreak: false
  });
  doc.restore();
}

function securitySealLayout() {
  const margin = SECURITY_SEAL_MARGIN;
  const gap = SECURITY_SEAL_GAP;
  const labelWidth = SECURITY_SEAL_SIZE;
  const labelHeight = SECURITY_SEAL_SIZE;
  const columns = Math.max(1, Math.floor((A4.width - margin * 2 + gap) / (labelWidth + gap)));
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
