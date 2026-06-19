import XLSX from "xlsx";
import { normalizeKey, parseNumber, roundMoney } from "./domain.js";

const CATALOG_ALIASES = {
  codigoMl: ["Codigo ML", "Codigo Meli", "Código ML", "Código Meli", "Marca", "Codigo", "Código", "Codigo do produto", "Código do produto", "SKU"],
  descricao: ["Descricao", "Descricao do Item", "Descricao do Produto", "Produto", "Nome", "Descrição", "Descrição do Item", "Descrição do Produto"],
  valorUnit: ["Preco", "Preco de venda", "Valor Unit", "Valor Unitario", "Preço", "Preço de venda", "Valor Unitário"],
  precoCusto: ["Preco de custo", "Custo", "Valor Custo", "Preço de custo"],
  categoria: ["Categoria", "Categoria do produto"],
  subcategoria: ["Subcategoria", "Sub categoria"],
  ean: ["EAN", "GTIN/EAN", "GTIN", "Codigo de barras", "CÃ³digo de barras"],
  foto: ["URL Imagens Externas", "URL da imagem", "URL/foto do produto", "Foto", "Imagem"],
  link: ["Link Externo", "Link do produto", "URL do produto", "Link"]
};

export function readCatalogWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Arquivo sem abas para importar.");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  return parseCatalogRows(rows);
}

export function parseCatalogRows(rows) {
  const headerIndex = rows.findIndex((row) => Array.isArray(row) && hasCatalogColumns(row));
  if (headerIndex === -1) {
    throw new Error("Nao encontrei as colunas minimas: codigo, descricao e preco.");
  }

  const header = rows[headerIndex].map((cell) => String(cell ?? "").trim());
  const index = buildCatalogColumnIndex(header);
  const products = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const codigoMl = String(valueAt(row, index, "codigoMl") ?? "").trim().toUpperCase();
    const descricao = String(valueAt(row, index, "descricao") ?? "").trim();
    if (!codigoMl || !descricao) continue;

    products.push({
      codigoMl,
      descricao,
      valorUnit: roundMoney(parseNumber(valueAt(row, index, "valorUnit"))),
      precoCusto: roundMoney(parseNumber(valueAt(row, index, "precoCusto"))),
      categoria: String(valueAt(row, index, "categoria") ?? "").trim(),
      subcategoria: String(valueAt(row, index, "subcategoria") ?? "").trim(),
      ean: String(valueAt(row, index, "ean") ?? "").trim(),
      foto: String(valueAt(row, index, "foto") ?? "").trim(),
      link: String(valueAt(row, index, "link") ?? "").trim()
    });
  }

  if (!products.length) throw new Error("Nenhum produto valido foi encontrado no arquivo.");
  return products;
}

function hasCatalogColumns(row) {
  const index = buildCatalogColumnIndex(row.map((cell) => String(cell ?? "").trim()));
  return index.has("codigoMl") && index.has("descricao") && index.has("valorUnit");
}

function buildCatalogColumnIndex(header) {
  const normalizedHeader = new Map(header.map((name, position) => [normalizeKey(name), position]));
  const index = new Map();
  for (const [canonical, aliases] of Object.entries(CATALOG_ALIASES)) {
    const alias = aliases.find((name) => normalizedHeader.has(normalizeKey(name)));
    if (alias) index.set(canonical, normalizedHeader.get(normalizeKey(alias)));
  }
  return index;
}

function valueAt(row, index, key) {
  const position = index.get(key);
  return position === undefined ? "" : row[position];
}
