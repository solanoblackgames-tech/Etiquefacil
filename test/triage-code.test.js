import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

function emptyDb() {
  return {
    users: [{ id: "owner-1", name: "Usuario", email: "user@example.com" }],
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
  };
}

test("createTriageItem keeps code sequence after deleting an earlier label", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-code-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { createTriageItem, deleteTriageItem, writeDb } = await import(storeUrl.href);

    await writeDb(emptyDb());

    const first = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { descricao: "Produto 1", sku: "SKU-1" }
    });
    const second = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { descricao: "Produto 2", sku: "SKU-2" }
    });
    const third = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { descricao: "Produto 3", sku: "SKU-3" }
    });

    await deleteTriageItem({ userId: "owner-1", code: second.code });

    const next = await createTriageItem({
      userId: "owner-1",
      createdByUserId: "owner-1",
      payload: { descricao: "Produto 4", sku: "SKU-4" }
    });

    assert.match(first.code, /^LAB-\d{8}-000001$/);
    assert.match(third.code, /^LAB-\d{8}-000003$/);
    assert.equal(next.code.slice(0, -6), first.code.slice(0, -6));
    assert.equal(next.code.endsWith("000004"), true);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("operator can delete only their last five generated triage labels", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-triage-delete-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-delete`;
    const { canDeleteTriageItem, deleteTriageItem, writeDb } = await import(storeUrl.href);
    const db = emptyDb();
    db.users.push({ id: "operator-1", name: "Operador", email: "op@example.com", parentUserId: "owner-1", role: "operator" });
    db.triageItems = Array.from({ length: 6 }, (_, index) => ({
      id: `triage-${index + 1}`,
      userId: "owner-1",
      createdByUserId: "operator-1",
      operatorUserId: "operator-1",
      code: `LAB-20260707-${String(index + 1).padStart(6, "0")}`,
      productCode: `SKU-${index + 1}`,
      sku: `SKU-${index + 1}`,
      ean: "",
      asin: "",
      codigoBling2: "",
      descricao: `Produto ${index + 1}`,
      serial: "",
      status: "aguardando_teste",
      destination: "",
      diagnosis: "",
      diagnosisPhoto: "",
      createdAt: `2026-07-07T10:0${index}:00.000Z`,
      updatedAt: `2026-07-07T10:0${index}:00.000Z`,
      diagnosedAt: null
    }));
    db.triageItems.push({
      ...db.triageItems[5],
      id: "triage-other",
      createdByUserId: "operator-2",
      operatorUserId: "operator-2",
      code: "LAB-20260707-000007",
      createdAt: "2026-07-07T10:06:00.000Z",
      updatedAt: "2026-07-07T10:06:00.000Z"
    });
    await writeDb(db);

    assert.equal(await canDeleteTriageItem({ userId: "owner-1", code: "LAB-20260707-000006", requesterUserId: "operator-1" }), true);
    assert.equal(await canDeleteTriageItem({ userId: "owner-1", code: "LAB-20260707-000001", requesterUserId: "operator-1" }), false);
    assert.equal(await canDeleteTriageItem({ userId: "owner-1", code: "LAB-20260707-000007", requesterUserId: "operator-1" }), false);

    await assert.rejects(
      () => deleteTriageItem({ userId: "owner-1", code: "LAB-20260707-000001", requesterUserId: "operator-1", isOwner: false }),
      /5 ultimas etiquetas/
    );

    const deleted = await deleteTriageItem({
      userId: "owner-1",
      code: "LAB-20260707-000006",
      requesterUserId: "operator-1",
      isOwner: false
    });
    assert.equal(deleted.code, "LAB-20260707-000006");
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
