import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("updateUserLotOperatorVisibility hides and shows a lot for operators", async () => {
  const originalCwd = process.cwd();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-lot-visibility-"));

  process.chdir(tempDir);
  delete process.env.DATABASE_URL;

  try {
    const storeUrl = pathToFileURL(path.join(originalCwd, "src", "store.js"));
    storeUrl.search = `?test=${Date.now()}`;
    const { getUserLotSummaries, isUserLotHiddenFromOperators, updateUserLotOperatorVisibility, writeDb } = await import(storeUrl.href);

    await writeDb({
      users: [{ id: "user-1", name: "Usuario", email: "u@example.com" }],
      lots: [{ id: "lot-1", userId: "user-1", nomeArquivo: "Lote", createdAt: "2026-10-06T00:00:00.000Z" }],
      products: [],
      rzItems: [],
      scans: [],
      labels: []
    });

    assert.equal(await isUserLotHiddenFromOperators("user-1", "lot-1"), false);

    const hidden = await updateUserLotOperatorVisibility("user-1", "lot-1", true);
    assert.equal(hidden.ocultoOperadores, true);
    assert.equal(await isUserLotHiddenFromOperators("user-1", "lot-1"), true);
    assert.equal((await getUserLotSummaries("user-1"))[0].ocultoOperadores, true);

    const shown = await updateUserLotOperatorVisibility("user-1", "lot-1", false);
    assert.equal(shown.ocultoOperadores, false);
    assert.equal(await isUserLotHiddenFromOperators("user-1", "lot-1"), false);

    await assert.rejects(() => updateUserLotOperatorVisibility("user-2", "lot-1", true), /Lote nao encontrado/);
  } finally {
    process.chdir(originalCwd);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
