import { randomUUID } from "node:crypto";
import readXlsxFile from "read-excel-file/node";

export const BLING_HEADERS = [
  "ID",
  "Código",
  "Descrição",
  "Unidade",
  "NCM",
  "Origem",
  "Preço",
  "Valor IPI fixo",
  "Observações",
  "Situação",
  "Estoque",
  "Preço de custo",
  "Cód. no fornecedor",
  "Fornecedor",
  "Localização",
  "Estoque máximo",
  "Estoque mínimo",
  "Peso líquido (Kg)",
  "Peso bruto (Kg)",
  "GTIN/EAN",
  "GTIN/EAN da Embalagem",
  "Largura do produto",
  "Altura do Produto",
  "Profundidade do produto",
  "Data Validade",
  "Descrição do Produto no Fornecedor",
  "Descrição Complementar",
  "Itens p/ caixa",
  "Produto Variação",
  "Tipo Produção",
  "Classe de enquadramento do IPI",
  "Código na Lista de Serviços",
  "Tipo do item",
  "Grupo de Tags/Tags",
  "Tributos",
  "Código Pai",
  "Código Integração",
  "Grupo de produtos",
  "Marca",
  "CEST",
  "Volumes",
  "Descrição Curta",
  "Cross-Docking",
  "URL Imagens Externas",
  "Link Externo",
  "Meses Garantia no Fornecedor",
  "Clonar dados do pai",
  "Condição do Produto",
  "Frete Grátis",
  "Número FCI",
  "Vídeo",
  "Departamento",
  "Unidade de Medida",
  "Preço de Compra",
  "Valor base ICMS ST para retenção",
  "Valor ICMS ST para retenção",
  "Valor ICMS próprio do substituto",
  "Categoria do produto",
  "Informações Adicionais"
];

export const BLING_STOCK_ENTRY_HEADERS = [
  "ID Produto",
  "Código SKU*",
  "GTIN/EAN**",
  "Nome do Produto",
  "Depósito*",
  "Movimentação de Estoque*",
  "Tipo de lançamento*",
  "Preço de Compra*",
  "Preço de Custo",
  "Observação"
];

export const BLING_STOCK_TRANSFER_HEADERS = [
  "Codigo SKU*",
  "GTIN/EAN",
  "Nome do Produto",
  "Deposito origem*",
  "Deposito destino*",
  "Quantidade*",
  "Observacao"
];

const REQUIRED_COLUMNS = [
  "codigoMl",
  "codigoRz",
  "qtd",
  "descricao",
  "valorUnit",
  "valorTotal"
];

const COLUMN_ALIASES = {
  codigoMl: ["Código ML", "Código Meli", "Codigo ML", "Codigo Meli"],
  codigoRz: ["Código RZ", "Codigo RZ"],
  qtd: ["Qtd", "Quantidade"],
  descricao: ["Descrição do Item", "Descricao do Item", "Descrição", "Descricao"],
  valorUnit: ["Valor Unit", "Valor Unitário", "Valor Unitario"],
  valorTotal: ["Valor Total"],
  categoria: ["Categoria"],
  subcategoria: ["Subcategoria"],
  ean: ["EAN", "GTIN/EAN", "GTIN", "Codigo de barras", "CÃ³digo de barras"],
  foto: ["URL Imagens Externas", "URL da imagem", "URL/foto do produto", "Foto", "Imagem"],
  link: ["Link Externo", "Link do produto", "URL do produto", "Link"],
  enderecoWms: ["Endereço WMS", "Endereco WMS"],
  condicaoGrade: ["Condição\n(Grade)", "Condição (Grade)", "Condicao (Grade)", "Grade"]
};

export function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const normalized = text.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatSku(prefix, sequence) {
  return `${String(prefix).trim().toUpperCase()}${String(sequence).padStart(4, "0")}`;
}

export async function importSpecialistWorkbook(buffer, lotInput) {
  let rows;
  try {
    const result = await readXlsxFile(buffer, { getSheets: true });
    if (Array.isArray(result) && result.some((sheet) => sheet?.data || sheet?.name || sheet?.sheet)) {
      const sheetRows = [];
      for (const sheet of result) {
        if (Array.isArray(sheet.data)) {
          sheetRows.push({ sheet: sheet.name || sheet.sheet, data: sheet.data });
          continue;
        }

        const sheetName = sheet.name || sheet.sheet;
        const candidate = await readXlsxFile(buffer, { sheet: sheetName });
        sheetRows.push({ sheet: sheetName, data: Array.isArray(candidate?.[0]?.data) ? candidate[0].data : candidate });
      }
      rows = findImportableSheet(sheetRows)?.data;
    } else {
      const candidate = await readXlsxFile(buffer);
      rows = Array.isArray(candidate?.[0]?.data) ? candidate[0].data : candidate;
    }
  } catch {
    throw new Error("Não foi possível ler a planilha.");
  }
  if (!Array.isArray(rows)) {
    throw new Error(`A planilha precisa conter as colunas: ${REQUIRED_COLUMNS.join(", ")}.`);
  }
  const headerIndex = rows.findIndex((row) => Array.isArray(row) && hasRequiredColumns(row));
  if (headerIndex === -1) {
    throw new Error(`Não foi possível encontrar as colunas obrigatórias: ${requiredColumnLabels()}.`);
  }

  const header = rows[headerIndex].map((cell) => String(cell).trim());
  const indexByColumn = buildColumnIndex(header);
  const missing = REQUIRED_COLUMNS.filter((name) => !indexByColumn.has(name));
  if (missing.length) throw new Error(`Colunas obrigatórias ausentes: ${missing.map(labelForColumn).join(", ")}.`);

  const get = (row, column) => row[indexByColumn.get(column)];
  const byMl = new Map();
  const items = [];
  let sequence = 1;
  const percentage = parseNumber(lotInput.auctionPercent) / 100;

  for (const row of rows.slice(headerIndex + 1)) {
    const codigoMl = String(get(row, "codigoMl") ?? "").trim().toUpperCase();
    const codigoRz = String(get(row, "codigoRz") ?? "").trim();
    if (!codigoMl || !codigoRz) continue;

    const qtd = Math.max(0, Math.round(parseNumber(get(row, "qtd"))));
    const valorUnit = parseNumber(get(row, "valorUnit"));
    const valorTotal = parseNumber(get(row, "valorTotal"));
    const descricao = String(get(row, "descricao") ?? "").trim();
    const categoria = String(get(row, "categoria") ?? "").trim();
    const subcategoria = String(get(row, "subcategoria") ?? "").trim();
    const ean = String(get(row, "ean") ?? "").trim();
    const foto = String(get(row, "foto") ?? "").trim();
    const link = String(get(row, "link") ?? "").trim();

    if (!byMl.has(codigoMl)) {
      byMl.set(codigoMl, {
        id: randomUUID(),
        codigoMl,
        sku: formatSku(lotInput.skuPrefix, sequence++),
        descricao,
        valorUnit,
        precoCusto: roundMoney(valorUnit * percentage),
        qtdTotal: 0,
        categoria,
        subcategoria,
        ean,
        foto,
        link,
        origem: "planilha",
        createdAt: new Date().toISOString()
      });
    }

    const product = byMl.get(codigoMl);
    product.qtdTotal += qtd;
    items.push({
      id: randomUUID(),
      productTempId: product.id,
      codigoRz,
      enderecoWms: String(get(row, "enderecoWms") ?? "").trim(),
      qtdEsperada: qtd,
      qtdConferida: 0,
      condicaoGrade: String(get(row, "condicaoGrade") || "").trim(),
      valorTotal,
      tipoItem: "esperado",
      createdAt: new Date().toISOString()
    });
  }

  if (!byMl.size) throw new Error("Nenhum item válido foi encontrado na aba importada.");

  return {
    products: [...byMl.values()],
    items,
    nextSequence: sequence
  };
}

function findImportableSheet(sheets) {
  // Sheet names vary between suppliers; the importable sheet is identified by its columns.
  return sheets.find((sheet) => {
    const rows = sheet.data || [];
    return rows.some((row) => {
      if (!Array.isArray(row)) return false;
      return hasRequiredColumns(row);
    });
  });
}

function hasRequiredColumns(row) {
  const index = buildColumnIndex(row.map((cell) => String(cell ?? "").trim()));
  return REQUIRED_COLUMNS.every((name) => index.has(name));
}

function buildColumnIndex(header) {
  const normalizedHeader = new Map(header.map((name, index) => [normalizeKey(name), index]));
  const index = new Map();
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const alias = aliases.find((name) => normalizedHeader.has(normalizeKey(name)));
    if (alias) index.set(canonical, normalizedHeader.get(normalizeKey(alias)));
  }
  return index;
}

function labelForColumn(column) {
  return COLUMN_ALIASES[column]?.[0] || column;
}

function requiredColumnLabels() {
  return REQUIRED_COLUMNS.map(labelForColumn).join(", ");
}

export function buildBlingCsv(products, lot) {
  const rows = products.map((product) => {
    const row = Object.fromEntries(BLING_HEADERS.map((header) => [header, ""]));
    row["Código"] = product.sku;
    row["Descrição"] = product.descricao;
    row["Unidade"] = "UN";
    row["Origem"] = "0";
    row["Preço"] = formatBrMoney(product.valorUnit);
    row["Valor IPI fixo"] = "0";
    row["Situação"] = "Ativo";
    row["Estoque"] = String(product.qtdTotal);
    row["Preço de custo"] = formatBrMoney(product.precoCusto);
    row["Fornecedor"] = lot.fornecedor;
    row["Marca"] = product.codigoMl;
    row["GTIN/EAN"] = product.ean || "";
    row["GTIN/EAN da Embalagem"] = product.ean || "";
    row["URL Imagens Externas"] = product.foto || "";
    row["Link Externo"] = product.link || "";
    row["Estoque máximo"] = "0";
    row["Estoque mínimo"] = "0";
    row["Peso líquido (Kg)"] = "0";
    row["Peso bruto (Kg)"] = "0";
    row["Largura do produto"] = "0";
    row["Altura do Produto"] = "0";
    row["Profundidade do produto"] = "0";
    row["Itens p/ caixa"] = "0";
    row["Tipo Produção"] = "Terceiros";
    row["Tributos"] = "0";
    row["Código Integração"] = "0";
    row["Volumes"] = "0";
    row["Cross-Docking"] = "0";
    row["Meses Garantia no Fornecedor"] = "0";
    row["Clonar dados do pai"] = "NÃO";
    row["Condição do Produto"] = "NÃO ESPECIFICADO";
    row["Frete Grátis"] = "NÃO";
    row["Unidade de Medida"] = "Centímetro";
    row["Preço de Compra"] = "0";
    row["Valor base ICMS ST para retenção"] = "0";
    row["Valor ICMS ST para retenção"] = "0";
    row["Valor ICMS próprio do substituto"] = "0";
    return row;
  });

  return [BLING_HEADERS, ...rows.map((row) => BLING_HEADERS.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n");
}

export function buildBlingStockEntryCsv(items, { deposito = "Geral", observacao = "" } = {}) {
  const rows = items.map((item) => ({
    "ID Produto": "",
    "Código SKU*": item.sku || "",
    "GTIN/EAN**": item.ean || "",
    "Nome do Produto": item.descricao || "",
    "Depósito*": deposito,
    "Movimentação de Estoque*": String(Number(item.qtdConferida || item.quantidade || 0)),
    "Tipo de lançamento*": "Entrada",
    "Preço de Compra*": formatBrMoney(item.precoCusto || 0),
    "Preço de Custo": formatBrMoney(item.precoCusto || 0),
    "Observação": observacao
  }));

  return [BLING_STOCK_ENTRY_HEADERS, ...rows.map((row) => BLING_STOCK_ENTRY_HEADERS.map((header) => row[header]))]
    .map((row) => row.map(csvQuotedCell).join(","))
    .join("\r\n");
}

export function buildBlingStockTransferCsv(items, { depositoOrigem = "", depositoDestino = "", observacao = "" } = {}) {
  const rows = items.map((item) => ({
    "Codigo SKU*": item.sku || "",
    "GTIN/EAN": item.ean || "",
    "Nome do Produto": item.descricao || "",
    "Deposito origem*": depositoOrigem,
    "Deposito destino*": depositoDestino,
    "Quantidade*": String(Number(item.quantidade || item.qtdConferida || 0)),
    Observacao: observacao
  }));

  return [BLING_STOCK_TRANSFER_HEADERS, ...rows.map((row) => BLING_STOCK_TRANSFER_HEADERS.map((header) => row[header]))]
    .map((row) => row.map(csvQuotedCell).join(","))
    .join("\r\n");
}

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function formatBrMoney(value) {
  return roundMoney(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return /[;"\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function csvQuotedCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}
