import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { buildBlingCsv, buildBlingStockEntryCsv, buildBlingStockTransferCsv, formatSku, importSpecialistWorkbook, parseNumber, roundMoney } from "../src/domain.js";

test("formatSku uses uppercase prefix and four digit sequence", () => {
  assert.equal(formatSku("amz04l", 1), "AMZ04L0001");
  assert.equal(formatSku("ABC", 42), "ABC0042");
});

test("Bling stock entry CSV maps checked quantity for inventory entry", () => {
  const csv = buildBlingStockEntryCsv(
    [
      {
        sku: "AMZ04L0001",
        descricao: "Alternador Lifan",
        precoCusto: 331.83,
        qtdConferida: 2
      }
    ],
    { deposito: "Geral", observacao: "Entrada por conferência RZ RZ-01" }
  );

  const [headerLine, dataLine] = csv.split("\r\n");

  assert.equal(
    headerLine,
    '"ID Produto","Código SKU*","GTIN/EAN**","Nome do Produto","Depósito*","Movimentação de Estoque*","Tipo de lançamento*","Preço de Compra*","Preço de Custo","Observação"'
  );
  assert.equal(
    dataLine,
    '"","AMZ04L0001","","Alternador Lifan","Geral","2","Entrada","331,83","331,83","Entrada por conferência RZ RZ-01"'
  );
});

test("Bling stock transfer CSV maps origin destination and quantity", () => {
  const csv = buildBlingStockTransferCsv(
    [
      {
        sku: "AMZ04L0001",
        codigoMl: "JQQR53377",
        descricao: "Alternador Lifan",
        quantidade: 3
      }
    ],
    { depositoOrigem: "Deposito Geral", depositoDestino: "Picking", observacao: "Transferencia do dia" }
  );

  const [headerLine, dataLine] = csv.split("\r\n");

  assert.equal(headerLine, '"Codigo SKU*","GTIN/EAN","Nome do Produto","Deposito origem*","Deposito destino*","Quantidade*","Observacao"');
  assert.equal(dataLine, '"AMZ04L0001","","Alternador Lifan","Deposito Geral","Picking","3","Transferencia do dia"');
});

test("auction cost rounds to Brazilian money precision", () => {
  assert.equal(roundMoney(1659.17 * 0.2), 331.83);
});

test("parseNumber accepts Amazon decimal prices with trailing zeros", () => {
  assert.equal(parseNumber("1305.000"), 1305);
  assert.equal(parseNumber("1344.04140"), 1344.0414);
  assert.equal(parseNumber("1659.17"), 1659.17);
  assert.equal(parseNumber("1.305,00"), 1305);
  assert.equal(parseNumber("1.305.000"), 1305000);
});

test("specialist import sums Saldo 1 to Saldo 4 when quantity column is absent", async () => {
  const rows = [
    ["Codigo ML", "Codigo RZ", "Saldo 1", "Saldo 2", "Saldo 3", "Saldo 4", "Descricao", "Valor Unit", "Valor Total"],
    ["ML-1", "RZ-1", 1, 2, 0, 3, "Produto com saldos", 10, 60],
    ["ML-1", "RZ-2", 0, 1, 1, 0, "Produto com saldos", 10, 20]
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Itens");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

  const result = await importSpecialistWorkbook(buffer, { skuPrefix: "sal", auctionPercent: 20 });

  assert.equal(result.products[0].qtdTotal, 8);
  assert.equal(result.items[0].qtdEsperada, 6);
  assert.equal(result.items[1].qtdEsperada, 2);
});

test("specialist import uses explicit product cost when provided", async () => {
  const rows = [
    ["Codigo ML", "Codigo RZ", "Qtd", "Descricao", "Valor Unit", "Valor Total", "Preco de custo"],
    ["ML-COST", "RZ-1", 1, "Produto com custo informado", 100, 100, 37.45],
    ["ML-PERCENT", "RZ-1", 1, "Produto com custo percentual", 200, 200, ""]
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Produtos");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

  const result = await importSpecialistWorkbook(buffer, { skuPrefix: "cst", auctionPercent: 20 });

  assert.equal(result.products.find((product) => product.codigoMl === "ML-COST").precoCusto, 37.45);
  assert.equal(result.products.find((product) => product.codigoMl === "ML-PERCENT").precoCusto, 40);
});

test("Bling CSV maps SKU, ML brand and total stock", () => {
  const csv = buildBlingCsv(
    [
      {
        sku: "AMZ04L0001",
        codigoMl: "JQQR53377",
        descricao: "Alternador Lifan",
        valorUnit: 1659.17,
        precoCusto: 331.83,
        qtdTotal: 3,
        ean: "7891234567890",
        foto: "https://img.example/produto.jpg",
        link: "https://example/produto"
      }
    ],
    { fornecedor: "AMZ04LOTE" }
  );

  const [headerLine, dataLine] = csv.split("\r\n");
  const headers = headerLine.split(";");
  const data = dataLine.split(";");
  const value = (column) => data[headers.indexOf(column)];

  assert.equal(value("Código"), "AMZ04L0001");
  assert.equal(value("Marca"), "JQQR53377");
  assert.equal(value("Estoque"), "3");
  assert.equal(value("Fornecedor"), "AMZ04LOTE");
  assert.equal(value("GTIN/EAN"), "7891234567890");
  assert.equal(value("URL Imagens Externas"), "https://img.example/produto.jpg");
  assert.equal(value("Link Externo"), "https://example/produto");
  assert.equal(value("Preço"), "1.659,17");
  assert.equal(value("Preço de custo"), "331,83");
});
