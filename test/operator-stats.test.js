import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("operator entry items count scans and manual registrations once", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-operator-stats-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-operator-stats`;
    const { listOperatorsForUser, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", role: "owner", name: "Loja", email: "loja@example.com", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "operator-1", parentUserId: "owner-1", role: "operator", operatorCode: 1001, name: "Ana", email: "ana@example.com", createdAt: "2026-07-01T00:00:00.000Z" }
      ],
      lots: [],
      products: [],
      rzItems: [],
      scans: [],
      labels: [],
      blingIntegrations: [],
      appSettings: {},
      userSettings: [],
      transferLots: [],
      transferItems: [],
      transferForcedOccurrences: [],
      transferDivergenceReports: [],
      operatorActivities: [
        { id: "a1", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_ml", metadata: { codigoMl: "ML1" }, createdAt: "2026-07-14T10:00:00.000Z" },
        { id: "a2", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "create_manual_product", metadata: { codigoMl: "ML2" }, createdAt: "2026-07-14T10:01:00.000Z" },
        { id: "a3", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_ml", metadata: { codigoMl: "ML3", source: "diverse_lot", status: "cadastro_manual" }, createdAt: "2026-07-14T10:02:00.000Z" },
        { id: "a4", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "create_manual_product", metadata: { codigoMl: "ML3", source: "diverse_lot" }, createdAt: "2026-07-14T10:03:00.000Z" },
        { id: "a5", ownerUserId: "owner-1", operatorUserId: "operator-1", action: "scan_transfer", metadata: { code: "TRF1" }, createdAt: "2026-07-14T10:04:00.000Z" }
      ],
      operatorInvites: [],
      catalogProducts: [],
      catalogRequests: [],
      catalogRejectedRequests: [],
      noSheetSuggestions: [],
      triageItems: [],
      triageEvents: []
    });

    const [operator] = await listOperatorsForUser("owner-1", { startDate: "2026-07-14", endDate: "2026-07-14" });

    assert.equal(operator.stats.registrationScans, 2);
    assert.equal(operator.stats.creates, 2);
    assert.equal(operator.stats.transferScans, 1);
    assert.equal(operator.stats.entryItems, 3);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
