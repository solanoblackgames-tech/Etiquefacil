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

test("operator cannot generate a new label while one of theirs is still without diagnosis", async () => {
  await withTriageStore("open-label", async ({ createTriageItem, deleteTriageItem, readDb }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "SKU-CEL" } });
    const sameSku = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "sku-cel" } });
    const otherSku = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "SKU-TV", serial: "SN-TV-1" } });
    const otherOperator = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-2", operatorUserId: "operator-2", payload: { sku: "SKU-CEL" } });

    assert.equal(first.openPending, undefined);
    assert.equal(sameSku.openPending, true);
    assert.equal(sameSku.code, first.code);
    assert.equal(otherSku.openPending, true);
    assert.equal(otherSku.code, first.code);
    assert.notEqual(otherOperator.code, first.code);
    assert.equal((await readDb()).triageItems.length, 2);

    await deleteTriageItem({ userId: "owner-1", code: first.code, requesterUserId: "operator-1", isOwner: false });
    const afterDelete = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", operatorUserId: "operator-1", payload: { sku: "SKU-TV" } });
    assert.equal(afterDelete.openPending, undefined);
    assert.notEqual(afterDelete.code, first.code);
  });
});

test("open label rule ignores pending labels created before the rule started", async () => {
  await withTriageStore("open-label-legacy", async ({ createTriageItem, readDb, writeDb }) => {
    const old = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-VELHO" } });
    const db = await readDb();
    db.triageItems.find((item) => item.code === old.code).createdAt = "2026-10-06T15:00:00.000Z";
    await writeDb(db);

    const next = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-NOVO" } });
    assert.equal(next.openPending, undefined);
    assert.notEqual(next.code, old.code);
  });
});

test("scanning a label QR or security seal in the SKU field opens the existing label", async () => {
  await withTriageStore("scan-in-sku", async ({ createTriageItem, updateTriageDiagnosis, readDb }) => {
    const item = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL", serial: "SN-CEL-1", securitySealCode: "1000042881758" } });
    await updateTriageDiagnosis({ userId: "owner-1", code: item.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO" } });

    const byMangledQr = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: `HTTPSÇ;;ETIQUEFACIL.COM.BR;LAUDO;${item.code}` } });
    const bySeal = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "1000042881758" } });

    assert.equal(byMangledQr.scanned, true);
    assert.equal(byMangledQr.code, item.code);
    assert.equal(bySeal.scanned, true);
    assert.equal(bySeal.code, item.code);
    await assert.rejects(
      createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "LAB-20990101-000001" } }),
      /QR de uma etiqueta/
    );
    assert.equal((await readDb()).triageItems.length, 1);
  });
});

test("updateTriageDiagnosis saves serial and seal together with the diagnosis", async () => {
  await withTriageStore("diagnosis-with-serial", async ({ createTriageItem, updateTriageDiagnosis }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL" } });
    const saved = await updateTriageDiagnosis({
      userId: "owner-1",
      code: first.code,
      operatorUserId: "operator-1",
      payload: { diagnosisCondition: "OK_FUNCIONANDO", serial: "IMEI-1", securitySealCode: "LACRE-1" }
    });
    assert.equal(saved.serial, "IMEI-1");
    assert.equal(saved.securitySealCode, "LACRE-1");

    const second = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-CEL" } });
    await assert.rejects(
      updateTriageDiagnosis({ userId: "owner-1", code: second.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO", serial: "imei-1" } }),
      new RegExp(first.code)
    );
    await assert.rejects(
      updateTriageDiagnosis({ userId: "owner-1", code: second.code, operatorUserId: "operator-1", payload: { diagnosisCondition: "OK_FUNCIONANDO", serial: "IMEI-2", securitySealCode: "LACRE-1" } }),
      /lacre/
    );
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

test("labels saved with a repeated serial before the rule stay editable while the serial is unchanged", async () => {
  await withTriageStore("serial-legacy", async ({ readDb, writeDb, createTriageItem, updateTriageItemDetails }) => {
    const first = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-1", payload: { sku: "SKU-TV", serial: "TV-123" } });
    const second = await createTriageItem({ userId: "owner-1", createdByUserId: "operator-2", payload: { sku: "SKU-TV" } });
    const db = await readDb();
    db.triageItems.find((item) => item.code === second.code).serial = "TV-123";
    await writeDb(db);

    const edited = await updateTriageItemDetails({ userId: "owner-1", code: second.code, payload: { sku: "SKU-TV", serial: "TV-123", descricao: "TV editada" } });
    assert.equal(edited.descricao, "TV editada");
    await assert.rejects(
      updateTriageItemDetails({ userId: "owner-1", code: second.code, payload: { sku: "SKU-TV", serial: "TV-999" } }).then(() =>
        updateTriageItemDetails({ userId: "owner-1", code: second.code, payload: { sku: "SKU-TV", serial: "TV-123" } })
      ),
      new RegExp(first.code)
    );
  });
});
