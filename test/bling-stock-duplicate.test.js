import assert from 'node:assert/strict';
import test from 'node:test';
import { syncBlingStockEntries, syncBlingStockMovement, syncBlingProducts } from '../src/bling-api.js';
import { getBlingRateLimiter } from '../src/bling-rate-limit.js';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
const duplicate = response({ error: { description: 'Produto rejeitado', fields: [{ element: 'codigo', msg: 'O código SKU-1 já foi cadastrado para outro produto' }] } }, 400);

for (const kind of ['incremental', 'batch', 'permission']) {
  test(`stock ${kind}: duplicate metadata does not block entries; permission errors still do`, async () => {
    const integration = { userId: `stock-duplicate-${kind}`, accessToken: 'token' };
    const limiter = getBlingRateLimiter(integration);
    let now = Date.now();
    limiter.now = () => now;
    limiter.sleep = async (ms) => { now += ms; };
    const responses = [
      response({ data: [{ id: 456, descricao: 'Geral' }] }),
      response({ data: [{ id: 123, codigo: 'SKU-1' }] }),
      response({ data: { id: 123, codigo: 'SKU-1' } }),
      kind === 'permission' ? response({ error: { description: 'Sem permissao' } }, 403) : duplicate,
      response({ data: { id: 789 } }, 201)
    ];
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
      assert.ok(responses.length, 'unexpected retry or duplicate stock write');
      return responses.shift();
    };
    try {
      const options = { integration, depositoName: 'Geral', item: { sku: 'SKU-1', quantidade: 2, qtdConferida: 2 } };
      if (kind === 'permission') {
        await assert.rejects(syncBlingStockMovement(options), /Sem permissao/);
        assert.equal(calls.filter(x => x.method === 'POST').length, 0);
      } else {
        const result = kind === 'batch' ? await syncBlingStockEntries({ ...options, items: [options.item] }) : await syncBlingStockMovement(options);
        const writes = calls.filter(x => x.method === 'POST' && x.url.endsWith('/estoques'));
        assert.equal(writes.length, 1);
        assert.equal(writes[0].body.produto.id, 123);
        assert.equal(writes[0].body.quantidade, 2);
        assert.equal(writes[0].body.operacao, 'E');
        assert.match(result.results[0].alerts[0].message, /atualizacao.*pendente/);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
}

test('a product update rejected for duplicate SKU is still reported as failed', async () => {
  const integration = { userId: 'duplicate-product-job', accessToken: 'token' };
  let now = Date.now();
  const limiter = getBlingRateLimiter(integration);
  limiter.now = () => now;
  limiter.sleep = async (ms) => { now += ms; };
  const responses = [response({ data: [{ id: 123, codigo: 'SKU-1' }] }), response({ data: { id: 123, codigo: 'SKU-1' } }), duplicate];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responses.shift();
  try {
    const result = await syncBlingProducts({ integration, products: [{ sku: 'SKU-1' }] });
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].status, 'error');
  } finally { globalThis.fetch = originalFetch; }
});
