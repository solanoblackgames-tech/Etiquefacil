import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("Bling sync queue stores pending product alert and clears it after success", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-bling-queue-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-bling-queue`;
    const {
      enqueueBlingSyncJob,
      listDueBlingSyncJobs,
      markBlingSyncJobFailed,
      markBlingSyncJobSucceeded,
      readDb,
      writeDb
    } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-07-03T00:00:00.000Z" }],
      products: [
        {
          id: "product-1",
          lotId: "lot-1",
          codigoMl: "ML1",
          sku: "SKU1",
          descricao: "Produto",
          valorUnit: 10,
          precoCusto: 2,
          qtdTotal: 1,
          origem: "planilha",
          createdAt: "2026-07-03T00:00:00.000Z"
        }
      ],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: []
    });

    const job = await enqueueBlingSyncJob({
      userId: "user-1",
      lotId: "lot-1",
      productId: "product-1",
      sku: "SKU1",
      type: "product",
      payload: { product: { sku: "SKU1" } },
      errorMessage: "Erro 504 na API do Bling"
    });

    let db = await readDb();
    assert.equal(db.blingSyncJobs.length, 1);
    assert.match(db.products[0].blingAlertMessage, /Produto pendente de envio ao Bling/);

    const dueJobs = await listDueBlingSyncJobs();
    assert.equal(dueJobs[0].id, job.id);

    await markBlingSyncJobFailed(job.id, "Erro 504 na API do Bling");
    db = await readDb();
    assert.equal(db.blingSyncJobs[0].status, "failed");
    assert.equal(db.blingSyncJobs[0].attempts, 1);
    assert.match(db.products[0].blingAlertMessage, /Erro 504/);

    await markBlingSyncJobSucceeded(job.id);
    db = await readDb();
    assert.equal(db.blingSyncJobs.length, 0);
    assert.equal(db.products[0].blingAlertMessage, "");
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Bling sync queue prioritizes pending product jobs before older stock retries", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-bling-queue-priority-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-bling-queue-priority`;
    const { listDueBlingSyncJobs, writeDb } = await import(storeUrl.href);
    const now = new Date().toISOString();

    await writeDb({
      users: [],
      lots: [],
      products: [],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      blingSyncJobs: [
        {
          id: "stock-old",
          userId: "user-1",
          lotId: "lot-1",
          productId: "product-1",
          sku: "SKU1",
          type: "stock_entry",
          status: "failed",
          attempts: 10,
          payload: {},
          errorMessage: "Bling demorou para responder.",
          nextRunAt: "2026-07-03T00:00:00.000Z",
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z"
        },
        {
          id: "product-new",
          userId: "user-1",
          lotId: "lot-1",
          productId: "product-2",
          sku: "SKU2",
          type: "product",
          status: "pending",
          attempts: 0,
          payload: {},
          errorMessage: "Produto aguardando envio ao Bling.",
          nextRunAt: now,
          createdAt: now,
          updatedAt: now
        }
      ]
    });

    const dueJobs = await listDueBlingSyncJobs();
    assert.equal(dueJobs[0].id, "product-new");
    assert.equal(dueJobs[1].id, "stock-old");
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
