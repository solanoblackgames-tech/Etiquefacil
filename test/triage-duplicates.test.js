import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function withTriageStore(suffix, run) {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `etiquefacil-triage-${suffix}-`));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}-${suffix}`;
    const store = await import(storeUrl.href);
    await store.writeDb({
      users: [
        { id: "owner-1", name: "Usuario", email: "user@example.com" },
        { id: "operator-1", name: "Operador 1", email: "op1@example.com", parentUserId: "owner-1", role: "operator" },
        { id: "operator-2", name: "Operador 2", email: "op2@example.com", parentUserId: "owner-1", role: "operator" }
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
    await run(store);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("createTriageItem reuses the pending label when the same operator scans the same SKU again", async () => {
  await withTriageStore("duplicate", async ({ createTriageItem, readDb }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "SKU-CEL" } });
    const repeated = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "sku-cel" } });
    const otherOperator = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-2", operatorUserId: "operator-2", payload: { sku: "SKU-CEL" } });

    assert.equal(first.reused, undefined);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.code, first.code);
    assert.notEqual(otherOperator.code, first.code);
    assert.equal((await readDb()).triageItems.length, 2);
  });
});

test("createTriageItem creates a new label once the pending one has serial or diagnosis", async () => {
  await withTriageStore("after-diagnosis", async ({ createTriageItem, updateTriageDiagnosis }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL", serial: "SN-CEL-1" } });
    await updateTriageDiagnosis({ userId: "owner-1", code: first.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO" } });
    const second = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL" } });
    const withSerial = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-TV", serial: "SN-TV-1" } });
    const nextTv = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-TV" } });

    assert.notEqual(second.code, first.code);
    assert.equal(second.reused, undefined);
    assert.notEqual(nextTv.code, withSerial.code);
  });
});

test("updateTriageDiagnosis keeps the diagnosing operator when only a photo is added", async () => {
  await withTriageStore("photo-only", async ({ createTriageItem, updateTriageDiagnosis, listTriageDiagnosisHistory }) => {
    const item = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "SKU-CEL", serial: "SN-CEL-1" } });
    const diagnosed = await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "OK_FUNCIONANDO", diagnosis: "Laudo" }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const withPhoto = await updateTriageDiagnosis({
      userId: "owner-1",
      code: item.code,
      operatorUserId: "operator-2",
      photoOnly: true,
      payload: { diagnosisCondition: "OK_FUNCIONANDO", diagnosis: "Laudo", diagnosisPhoto: "data:image/png;base64,iVBORw0KGgo=" }
    });
    const history = await listTriageDiagnosisHistory({ userId: "owner-1", code: item.code });

    assert.equal(withPhoto.operatorUserId, "operator-1");
    assert.equal(withPhoto.diagnosedAt, diagnosed.diagnosedAt);
    assert.equal(withPhoto.diagnosisPhoto, "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(history[0].operatorUserId, "operator-2");
  });
});

test("updateTriageDiagnosis requires a serial number", async () => {
  await withTriageStore("serial-required", async ({ createTriageItem, updateTriageDiagnosis, updateTriageItemDetails }) => {
    const item = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL" } });

    await assert.rejects(
      updateTriageDiagnosis({ userId: "owner-1", code: item.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO" } }),
      /numero de serie/
    );

    await updateTriageItemDetails({ userId: "owner-1", code: item.code, payload: { sku: "SKU-CEL", serial: "SN-CEL-1" } });
    const diagnosed = await updateTriageDiagnosis({ userId: "owner-1", code: item.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO" } });
    assert.equal(diagnosed.status, "diagnosticado");
  });
});

test("triage serial numbers cannot repeat across labels", async () => {
  await withTriageStore("serial-unique", async ({ createTriageItem, updateTriageItemDetails }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL", serial: "sn-abc-1" } });
    const second = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-2", payload: { sku: "SKU-CEL" } });

    await assert.rejects(
      createTriageItem({ userId: "owner-1", createdByUserId: "operator-2", payload: { sku: "SKU-OUTRO", serial: "SN-ABC-1" } }),
      new RegExp(first.code)
    );
    await assert.rejects(
      updateTriageItemDetails({ userId: "owner-1", code: second.code, payload: { sku: "SKU-CEL", serial: " SN-ABC-1 " } }),
      new RegExp(first.code)
    );
    const kept = await updateTriageItemDetails({ userId: "owner-1", code: first.code, payload: { sku: "SKU-CEL", serial: "SN-ABC-1" } });
    assert.equal(kept.code, first.code);
  });
});
