import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("searchProducts finds previous products by description, EAN, SKU and RZ", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-product-search-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-product-search`;
    const { searchProducts, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-07-01T00:00:00.000Z" }],
      lots: [
        { id: "lot-1", userId: "owner-1", nomeArquivo: "Lote Cafeteiras", fornecedor: "", prefixoSku: "SKU", percentualArremate: 0, proximoSequencialSku: 1, createdAt: "2026-07-14T09:00:00.000Z" },
        { id: "lot-2", userId: "other-owner", nomeArquivo: "Outro dono", fornecedor: "", prefixoSku: "SKU", percentualArremate: 0, proximoSequencialSku: 1, createdAt: "2026-07-14T09:00:00.000Z" }
      ],
      products: [
        { id: "product-1", lotId: "lot-1", codigoMl: "MLB123", sku: "AMZ04L0001", descricao: "Cafeteira Mondial inox", valorUnit: 129.9, precoCusto: 60, qtdTotal: 1, ean: "7891234567890", foto: "https://img.example/cafeteira.jpg", createdAt: "2026-07-14T10:00:00.000Z" },
        { id: "product-2", lotId: "lot-2", codigoMl: "MLB999", sku: "OTHER1", descricao: "Produto de outro dono", valorUnit: 10, precoCusto: 5, qtdTotal: 1, ean: "7899999999999", createdAt: "2026-07-14T10:00:00.000Z" }
      ],
      rzItems: [{ id: "item-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-CAF-01", qtdEsperada: 1, qtdConferida: 1, valorUnit: 129.9, valorTotal: 129.9 }],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
      userSettings: [],
      transferLots: [],
      transferItems: [],
      transferForcedOccurrences: [],
      transferDivergenceReports: [],
      operatorActivities: [],
      operatorInvites: [],
      catalogProducts: [],
      catalogRequests: [],
      catalogRejectedRequests: [],
      noSheetSuggestions: [],
      triageItems: [],
      triageEvents: []
    });

    assert.equal((await searchProducts("owner-1", "cafeteira mondial"))[0].id, "product-1");
    assert.equal((await searchProducts("owner-1", "7891234567890"))[0].id, "product-1");
    assert.equal((await searchProducts("owner-1", "AMZ04L0001"))[0].id, "product-1");
    assert.equal((await searchProducts("owner-1", "RZ-CAF-01"))[0].id, "product-1");
    assert.equal((await searchProducts("owner-1", "outro dono")).length, 0);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
