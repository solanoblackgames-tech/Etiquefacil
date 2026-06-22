import assert from "node:assert/strict";
import test from "node:test";
import { buildBlingProductPayload, buildBlingStockEntryPayload, buildBlingStockTransferPayload } from "../src/bling-api.js";

test("Bling product payload maps Etiquefacil product to API v3 product", () => {
  const payload = buildBlingProductPayload({
    sku: "AMZ04L0001",
    codigoMl: "JQQR53377",
    descricao: "Alternador Lifan",
    valorUnit: 1659.17,
    ean: "7891234567890",
    foto: "https://img.example/produto.jpg",
    link: "https://example/produto"
  });

  assert.equal(payload.nome, "Alternador Lifan");
  assert.equal(payload.codigo, "AMZ04L0001");
  assert.equal(payload.preco, 1659.17);
  assert.equal(payload.tipo, "P");
  assert.equal(payload.situacao, "A");
  assert.equal(payload.formato, "S");
  assert.equal(payload.unidade, "UN");
  assert.equal(payload.gtin, "7891234567890");
  assert.equal(payload.marca, "JQQR53377");
  assert.equal(payload.imagemURL, "https://img.example/produto.jpg");
  assert.equal(payload.linkExterno, "https://example/produto");
});

test("Bling stock entry payload maps checked RZ item to stock entry", () => {
  const payload = buildBlingStockEntryPayload(
    {
      sku: "AMZ04L0001",
      qtdConferida: 2,
      precoCusto: 331.83
    },
    {
      productId: 123,
      depositoId: 456,
      observacao: "Entrada por conferencia RZ RZ-01"
    }
  );

  assert.deepEqual(payload.produto, { id: 123, codigo: "AMZ04L0001" });
  assert.deepEqual(payload.deposito, { id: 456 });
  assert.equal(payload.operacao, "E");
  assert.equal(payload.quantidade, 2);
  assert.equal(payload.preco, 331.83);
  assert.equal(payload.custo, 331.83);
  assert.equal(payload.observacoes, "Entrada por conferencia RZ RZ-01");
});

test("Bling stock transfer payload maps origin and destination deposits", () => {
  const payload = buildBlingStockTransferPayload(
    {
      sku: "AMZ04L0001",
      quantidade: 3
    },
    {
      productId: 123,
      depositoOrigemId: 456,
      depositoDestinoId: 789,
      observacao: "Transferencia Etiquefacil"
    }
  );

  assert.deepEqual(payload.produto, { id: 123, codigo: "AMZ04L0001" });
  assert.deepEqual(payload.deposito, { id: 456 });
  assert.deepEqual(payload.depositoDestino, { id: 789 });
  assert.equal(payload.operacao, "T");
  assert.equal(payload.quantidade, 3);
  assert.equal(payload.observacoes, "Transferencia Etiquefacil");
});
