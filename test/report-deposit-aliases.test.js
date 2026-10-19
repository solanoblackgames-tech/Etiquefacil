import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("relatorios da Solano Black Games mostram Panobianco Ibiti como SOLDIM MATRIZ", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-report-aliases-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-report-aliases`;
    const { getOperationalDashboardStats, getTvDashboardStats, readDb, writeDb } = await import(storeUrl.href);
    const now = new Date();
    const at = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    const day = (days) => at(days).slice(0, 10);
    const lotsFor = (userId) => [
      { id: `${userId}-pano`, userId, name: "Antiga", depositoOrigem: "Geral", depositoDestino: "Panobianco Ibiti", status: "synced", source: "manual", receivedTotal: 2, receivedAt: at(0), createdAt: at(0) },
      { id: `${userId}-matriz`, userId, name: "Nova", depositoOrigem: "Geral", depositoDestino: "SOLDIM MATRIZ", status: "synced", source: "manual", receivedTotal: 3, receivedAt: at(0), createdAt: at(0) }
    ];

    await writeDb({
      users: [
        { id: "solano", tenantId: "solano", tenantName: "Solano", role: "owner", name: "Solano", email: "SolanoBlackGames@gmail.com", createdAt: at(90) },
        { id: "outro", tenantId: "outro", tenantName: "Outro", role: "owner", name: "Outro", email: "outro@example.com", createdAt: at(90) }
      ],
      lots: [],
      products: [],
      rzItems: [],
      scans: [],
      transferLots: [...lotsFor("solano"), ...lotsFor("outro")],
      transferItems: ["solano", "outro"].flatMap((userId) => [
        { id: `${userId}-i1`, transferLotId: `${userId}-pano`, codigoMl: "M", sku: "S1", descricao: "P", quantidade: 2, createdAt: at(0) },
        { id: `${userId}-i2`, transferLotId: `${userId}-matriz`, codigoMl: "M", sku: "S1", descricao: "P", quantidade: 3, createdAt: at(0) }
      ]),
      triageItems: [],
      operatorActivities: [],
      userSettings: []
    });

    const solano = await getOperationalDashboardStats("solano", { startDate: day(6), endDate: day(0) });
    assert.equal(solano.overview.store.sent, 5, "Panobianco conta como envio para a loja");
    assert.deepEqual(solano.transfers.destinations.map((row) => row.destination), ["SOLDIM MATRIZ"]);
    assert.ok(!JSON.stringify(solano).toLowerCase().includes("panobianco"));

    const tv = await getTvDashboardStats("solano", now);
    assert.deepEqual(tv.destinations.map((row) => [row.destination, row.year]), [["SOLDIM MATRIZ", 5]]);

    const outro = await getOperationalDashboardStats("outro", { startDate: day(6), endDate: day(0) });
    assert.equal(outro.overview.store.sent, 3, "outras contas nao mudam");
    const outroTv = await getTvDashboardStats("outro", now);
    assert.ok(outroTv.destinations.some((row) => row.destination === "Panobianco Ibiti"));

    const db = await readDb();
    assert.equal(db.transferLots.find((lot) => lot.id === "solano-pano").depositoDestino, "Panobianco Ibiti", "dados gravados nao mudam");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
