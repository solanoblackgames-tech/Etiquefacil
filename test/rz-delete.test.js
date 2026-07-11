import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("deleteLotRzItem removes the full scanned row and orphan product", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-rz-delete-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { deleteLotRzItem, readDb, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-07-03T00:00:00.000Z" }],
      products: [{ id: "product-1", lotId: "lot-1", codigoMl: "ML1", sku: "SKU1", descricao: "Produto", origem: "planilha" }],
      rzItems: [
        { id: "item-1", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 1, qtdConferida: 1, tipoItem: "esperado" },
        { id: "item-2", lotId: "lot-1", productId: "product-1", codigoRz: "RZ-1", qtdEsperada: 2, qtdConferida: 0, tipoItem: "esperado" }
      ],
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

    const result = await deleteLotRzItem({ userId: "user-1", lotId: "lot-1", codigoRz: "RZ-1", itemId: "item-1" });
    const db = await readDb();

    assert.equal(result.lot.items.length, 0);
    assert.equal(db.rzItems.length, 0);
    assert.equal(db.products.length, 0);
    assert.equal(db.scans.at(-1).status, "item_excluido");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
