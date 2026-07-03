import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("scanTransferLot adds an item by EAN in the JSON store", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-transfer-scan-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { scanTransferLot, readDb, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-07-03T00:00:00.000Z" }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "ML123",
          sku: "SKU123",
          descricao: "Produto",
          ean: "7891234567890",
          origem: "planilha",
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
      transferLots: [
        {
          id: "transfer-1",
          userId: "user-1",
          name: "TRF-1",
          descricao: "",
          depositoOrigem: "CD",
          depositoDestino: "Loja",
          status: "open",
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
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

    const result = await scanTransferLot({ userId: "user-1", transferLotId: "transfer-1", code: "7891234567890" });
    const db = await readDb();

    assert.equal(result.status, "added");
    assert.equal(result.product.id, "product-1");
    assert.equal(result.lot.totalSkus, 1);
    assert.equal(db.transferItems.length, 1);
    assert.equal(db.transferItems[0].ean, "7891234567890");
    assert.equal(db.transferItems[0].quantidade, 1);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
