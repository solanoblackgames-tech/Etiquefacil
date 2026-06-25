import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBlingProductPayload,
  buildBlingProductSupplierPayload,
  buildBlingSupplierContactPayload,
  buildBlingStockEntryPayload,
  buildBlingStockExitPayload,
  buildBlingStockTransferPayload,
  syncBlingProducts
} from "../src/bling-api.js";

test("Bling product payload maps Etiquefacil product to API v3 product", () => {
  const payload = buildBlingProductPayload({
    sku: "AMZ04L0001",
    codigoMl: "JQQR53377",
    descricao: "Alternador Lifan",
    valorUnit: 1659.17,
    precoCusto: 331.83,
    ean: "7891234567890",
    foto: "https://img.example/produto.jpg",
    link: "https://example/produto"
  });

  assert.equal(payload.nome, "Alternador Lifan");
  assert.equal(payload.codigo, "AMZ04L0001");
  assert.equal(payload.preco, 1659.17);
  assert.equal(payload.precoCusto, 331.83);
  assert.equal(payload.tipo, "P");
  assert.equal(payload.situacao, "A");
  assert.equal(payload.formato, "S");
  assert.equal(payload.unidade, "UN");
  assert.equal(payload.gtin, "7891234567890");
  assert.equal(payload.marca, "JQQR53377");
  assert.equal(payload.imagemURL, "https://img.example/produto.jpg");
  assert.equal(payload.linkExterno, "https://example/produto");
});

test("Bling product supplier payload maps supplier cost relationship", () => {
  const payload = buildBlingProductSupplierPayload(
    {
      sku: "AMZ04L0001",
      descricao: "Alternador Lifan",
      precoCusto: 331.83
    },
    {
      productId: 123,
      supplierId: 456
    }
  );

  assert.deepEqual(payload.produto, { id: 123 });
  assert.deepEqual(payload.fornecedor, { id: 456 });
  assert.equal(payload.descricao, "Alternador Lifan");
  assert.equal(payload.codigo, "AMZ04L0001");
  assert.equal(payload.precoCusto, 331.83);
  assert.equal(payload.precoCompra, 331.83);
  assert.equal(payload.padrao, true);
});

test("Bling supplier contact payload marks contact as supplier", () => {
  const payload = buildBlingSupplierContactPayload("AMZ04LOTE", { id: 2, descricao: "Fornecedor" }, { tiposContato: [{ id: 1, descricao: "Cliente" }] });

  assert.equal(payload.nome, "AMZ04LOTE");
  assert.equal(payload.tipo, "J");
  assert.equal(payload.situacao, "A");
  assert.deepEqual(payload.tiposContato, [
    { id: 1, descricao: "Cliente" },
    { id: 2, descricao: "Fornecedor" }
  ]);
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

  assert.deepEqual(payload.saida.produto, { id: 123, codigo: "AMZ04L0001" });
  assert.deepEqual(payload.saida.deposito, { id: 456 });
  assert.equal(payload.saida.operacao, "S");
  assert.equal(payload.saida.quantidade, 3);
  assert.equal(payload.saida.observacoes, "Transferencia Etiquefacil");

  assert.deepEqual(payload.entrada.produto, { id: 123, codigo: "AMZ04L0001" });
  assert.deepEqual(payload.entrada.deposito, { id: 789 });
  assert.equal(payload.entrada.operacao, "E");
  assert.equal(payload.entrada.quantidade, 3);
  assert.equal(payload.entrada.observacoes, "Transferencia Etiquefacil");
});

test("Bling stock transfer payload prefers explicit quantity over accumulated conference count", () => {
  const payload = buildBlingStockTransferPayload(
    {
      sku: "AMZ04L0001",
      quantidade: 1,
      quantidadeConferida: 7
    },
    {
      productId: 123,
      depositoOrigemId: 456,
      depositoDestinoId: 789,
      observacao: "Transferencia Etiquefacil - conferencia QR"
    }
  );

  assert.equal(payload.saida.quantidade, 1);
  assert.equal(payload.entrada.quantidade, 1);
});

test("Bling stock exit payload maps decremented item to stock output", () => {
  const payload = buildBlingStockExitPayload(
    {
      sku: "AMZ04L0001",
      quantidade: 1
    },
    {
      productId: 123,
      depositoId: 456,
      observacao: "Saida automatica por diminuicao RZ RZ-01"
    }
  );

  assert.deepEqual(payload.produto, { id: 123, codigo: "AMZ04L0001" });
  assert.deepEqual(payload.deposito, { id: 456 });
  assert.equal(payload.operacao, "S");
  assert.equal(payload.quantidade, 1);
  assert.equal(payload.observacoes, "Saida automatica por diminuicao RZ RZ-01");
});

test("Bling product sync keeps retrying while API rate limit is reached", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const responses = [
    {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      json: async () => ({ error: { description: "O limite de requisicoes por segundo foi atingido" } })
    },
    {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      json: async () => ({ error: { description: "O limite de requisicoes por segundo foi atingido" } })
    },
    {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      json: async () => ({ error: { description: "O limite de requisicoes por segundo foi atingido" } })
    },
    {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [] })
    },
    {
      ok: true,
      status: 201,
      headers: new Headers(),
      json: async () => ({ data: { id: 987 } })
    }
  ];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method || "GET" });
    return responses.shift();
  };

  try {
    const result = await syncBlingProducts({
      integration: { accessToken: "token" },
      products: [{ sku: "AMZ04L0001", descricao: "Produto novo", valorUnit: 10 }]
    });

    assert.equal(result.created, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.results[0].blingProductId, 987);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET", "GET", "POST"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
