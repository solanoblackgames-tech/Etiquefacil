import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('reconnection resumes only that account and preserves stock job IDs and remaining quantities', async () => {
  const originalCwd = process.cwd();
  const databaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'etiquefacil-resume-bling-'));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;
  try {
    const url = pathToFileURL(path.join(originalCwd, 'src', 'store.js'));
    url.search = '?resume-test';
    const { writeDb, readDb, resumeUserBlingSyncJobs, listDueBlingSyncJobs } = await import(url.href);
    const job = { id: 'entry-1', userId: 'owner-1', productId: 'product-1', sku: 'SKU-1', type: 'stock_entry', status: 'failed', attempts: 7, payload: { item: { sku: 'SKU-1', quantidade: 3 } }, nextRunAt: '2099-01-01T00:00:00.000Z' };
    await writeDb({ users: [], lots: [], products: [], rzItems: [], scans: [], labels: [], blingIntegrations: [], blingSyncJobs: [job, { ...job, id: 'entry-2', userId: 'owner-2' }, { ...job, id: 'completed', status: 'completed' }] });
    assert.equal((await listDueBlingSyncJobs()).length, 0);
    assert.deepEqual(await resumeUserBlingSyncJobs('owner-1'), { resumed: 1 });
    const due = await listDueBlingSyncJobs();
    assert.equal(due.length, 1);
    assert.equal(due[0].id, 'entry-1');
    assert.equal(due[0].payload.item.quantidade, 3);
    assert.equal(due[0].attempts, 7);
    const db = await readDb();
    assert.equal(db.blingSyncJobs.length, 3);
    assert.equal(db.blingSyncJobs.find(j => j.id === 'entry-2').nextRunAt, job.nextRunAt);
    assert.equal(db.blingSyncJobs.find(j => j.id === 'completed').nextRunAt, job.nextRunAt);
  } finally {
    process.chdir(originalCwd);
    if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
