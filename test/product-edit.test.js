import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildBlingProductPayload } from "../src/bling-api.js";

test("updateLotProduct replaces spreadsheet reference with real ML code for Etiquefacil and Bling", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-product-edit-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-product-edit`;
    const { readDb, updateLotProduct, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote.xlsx", createdAt: "2026-07-27T00:00:00.000Z" }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "47465992142",
          sku: "228L0529",
          descricao: "Produto da planilha",
          valorUnit: 29.9,
          precoCusto: 0,
          qtdTotal: 1,
          origem: "planilha",
          createdAt: "2026-07-27T00:00:00.000Z"
        }
      ],
      rzItems: [{ id: "item-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 1, qtdConferida: 0, tipoItem: "esperado" }],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
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

    const result = await updateLotProduct({
      userId: "user-1",
      lotId: "lot-1",
      productId: "product-1",
      payload: {
        codigoMl: "abcd12345",
        descricao: "Produto corrigido",
        valorUnit: 29.9,
        precoCusto: 0
      }
    });
    const db = await readDb();
    const blingPayload = buildBlingProductPayload(result.product);

    assert.equal(result.product.codigoMl, "ABCD12345");
    assert.equal(db.products[0].codigoMl, "ABCD12345");
    assert.equal(result.lot.items[0].product.codigoMl, "ABCD12345");
    assert.equal(blingPayload.marca, "ABCD12345");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
