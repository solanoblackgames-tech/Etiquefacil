import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("updateTriageDiagnosis stores diagnosis history for the triage item", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-history-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { createTriageItem, getTriageStats, listTriageDiagnosisHistory, updateTriageDiagnosis, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [
        { id: "owner-1", name: "Usuario", email: "user@example.com" },
        { id: "operator-1", name: "Operador", email: "op@example.com", parentUserId: "owner-1", role: "operator" }
      ],
      lots: [],
      products: [],
      rzItems: [],
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

    const item = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { descricao: "Produto teste", sku: "SKU-1" }
    });

    await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "OK_FUNCIONANDO", diagnosis: "Primeiro laudo", destination: "LOJA" }
    });
    await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "FUNCIONANDO_COM_DETALHES", diagnosis: "Segundo laudo", destination: "VENDA_DIRETA" }
    });

    const history = await listTriageDiagnosisHistory({ userId: "owner-1", code: item.code });
    const stats = await getTriageStats("owner-1");

    assert.equal(history.length, 2);
    assert.equal(history[0].diagnosis, "Segundo laudo");
    assert.equal(history[0].diagnosisCondition, "FUNCIONANDO_COM_DETALHES");
    assert.equal(history[0].destination, "VENDA_DIRETA");
    assert.equal(history[1].diagnosis, "Primeiro laudo");
    assert.equal(history[1].diagnosisCondition, "OK_FUNCIONANDO");
    assert.deepEqual(stats.diagnosisConditions, [{ condition: "FUNCIONANDO_COM_DETALHES", total: 1, totalValue: 0 }]);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
