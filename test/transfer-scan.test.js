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

test("getTransferLotDetail returns newest transfer items first", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-transfer-order-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-order`;
    const { getTransferLotDetail, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [],
      products: [],
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
      transferItems: [
        {
          id: "old-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-1",
          productId: "product-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto antigo",
          ean: "",
          quantidade: 1,
          quantidadeConferida: 0,
          createdAt: "2026-07-03T10:00:00.000Z"
        },
        {
          id: "new-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-1",
          productId: "product-2",
          codigoMl: "ML2",
          sku: "SKU2",
          descricao: "Produto novo",
          ean: "",
          quantidade: 1,
          quantidadeConferida: 0,
          createdAt: "2026-07-03T10:05:00.000Z"
        }
      ],
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

    const lot = await getTransferLotDetail("user-1", "transfer-1");

    assert.deepEqual(lot.items.map((item) => item.id), ["new-item", "old-item"]);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scanTransferLot moves an existing item to the top after a new scan", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-transfer-rescan-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-rescan`;
    const { scanTransferLot, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-07-03T00:00:00.000Z" }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto antigo rebipado",
          ean: "",
          origem: "planilha",
          createdAt: "2026-07-03T00:00:00.000Z"
        },
        {
          id: "product-2",
          lotId: "lot-1",
          codigoMl: "ML2",
          sku: "SKU2",
          descricao: "Produto novo",
          ean: "",
          origem: "planilha",
          createdAt: "2026-07-03T00:01:00.000Z"
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
      transferItems: [
        {
          id: "old-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-1",
          productId: "product-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto antigo rebipado",
          ean: "",
          quantidade: 1,
          quantidadeConferida: 0,
          createdAt: "2026-07-03T10:00:00.000Z"
        },
        {
          id: "new-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-1",
          productId: "product-2",
          codigoMl: "ML2",
          sku: "SKU2",
          descricao: "Produto novo",
          ean: "",
          quantidade: 1,
          quantidadeConferida: 0,
          createdAt: "2026-07-03T10:05:00.000Z"
        }
      ],
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

    const result = await scanTransferLot({ userId: "user-1", transferLotId: "transfer-1", code: "ML1" });

    assert.equal(result.status, "updated");
    assert.deepEqual(result.lot.items.map((item) => item.id), ["old-item", "new-item"]);
    assert.equal(result.lot.items[0].quantidade, 2);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scanTransferLot accepts a product that exists only in Bling", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-transfer-bling-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-bling`;
    const { scanTransferLot, readDb, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [],
      products: [],
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

    const externalProduct = {
      sku: "BLING123",
      productCode: "BLING123",
      descricao: "Produto existente no Bling",
      ean: "7890000000001"
    };
    const first = await scanTransferLot({ userId: "user-1", transferLotId: "transfer-1", code: "BLING123", externalProduct });
    const second = await scanTransferLot({ userId: "user-1", transferLotId: "transfer-1", code: "BLING123", externalProduct });
    const db = await readDb();

    assert.equal(first.status, "added");
    assert.equal(second.status, "updated");
    assert.equal(db.transferItems.length, 1);
    assert.equal(db.transferItems[0].productId, null);
    assert.equal(db.transferItems[0].sourceLotId, null);
    assert.equal(db.transferItems[0].sku, "BLING123");
    assert.equal(db.transferItems[0].quantidade, 2);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("receiveTransferLotScan uses a pending duplicate SKU occurrence", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-transfer-receive-duplicate-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-receive-duplicate`;
    const { receiveTransferLotScan, readDb, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [],
      products: [],
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
          status: "waiting_store",
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      transferItems: [
        {
          id: "complete-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-1",
          productId: "product-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto duplicado completo",
          ean: "",
          quantidade: 1,
          quantidadeConferida: 1,
          createdAt: "2026-07-03T10:00:00.000Z"
        },
        {
          id: "pending-item",
          transferLotId: "transfer-1",
          sourceLotId: "lot-2",
          productId: "product-2",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto duplicado pendente",
          ean: "",
          quantidade: 3,
          quantidadeConferida: 0,
          createdAt: "2026-07-03T10:05:00.000Z"
        }
      ],
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

    const result = await receiveTransferLotScan({ userId: "user-1", transferLotId: "transfer-1", code: "SKU1" });
    const db = await readDb();

    assert.equal(result.item.id, "pending-item");
    assert.equal(result.item.quantidadeConferida, 1);
    assert.equal(result.lot.totalReceived, 2);
    assert.equal(result.lot.totalPending, 2);
    assert.equal(db.transferItems.find((item) => item.id === "complete-item").quantidadeConferida, 1);
    assert.equal(db.transferItems.find((item) => item.id === "pending-item").quantidadeConferida, 1);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
