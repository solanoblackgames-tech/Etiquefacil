import test from "node:test";
import assert from "node:assert/strict";
import { createBlingAuctionKit } from "../src/bling-api.js";

for (const type of ["leilao", "transferencia"]) {
test(`${type} kit aggregates components and reuses the same SKU on retry`, async () => {
  const originalFetch = globalThis.fetch;
  let saved;
  let posts = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    let data;
    if (options.method === "POST") {
      posts++;
      saved = { ...JSON.parse(options.body), id: 123 };
      data = { id: 123 };
    } else if (url.pathname.endsWith("/123")) data = saved;
    else data = url.searchParams.get("codigos[]") === "SKU-A" ? [{ id: 10, codigo: "SKU-A" }] : saved ? [saved] : [];
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  try {
    const options = { integration: { accessToken: `kit-test-${type}` }, lot: { id: "test", name: "Teste", type, status: type === "leilao" ? "ready_sync" : "open", items: [{ sku: "SKU-A", quantidade: 1 }, { sku: "SKU-A", quantidade: 2 }] } };
    assert.equal((await createBlingAuctionKit(options)).id, 123);
    assert.deepEqual(saved.estrutura, { tipoEstoque: "V", lancamentoEstoque: "M", componentes: [{ produto: { id: 10 }, quantidade: 3 }] });
    assert.equal(saved.codigo, `${type === "leilao" ? "LEILAO" : "LOTE"}-test`);
    assert.equal(saved.nome, `${type === "leilao" ? "Lote de leilao" : "Lote"} - Teste`);
    assert.equal((await createBlingAuctionKit(options)).existing, true);
    assert.equal(posts, 1);
    options.lot.items[0].quantidade = 5;
    await assert.rejects(createBlingAuctionKit(options), /outra composicao/);
    options.lot.status = "open";
    if (type === "leilao") await assert.rejects(createBlingAuctionKit(options), /Feche/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
}
