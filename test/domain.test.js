import assert from "node:assert/strict";
import test from "node:test";
import { buildBlingCsv, buildBlingStockEntryCsv, buildBlingStockTransferCsv, formatSku, roundMoney } from "../src/domain.js";

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
