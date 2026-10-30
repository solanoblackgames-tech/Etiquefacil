import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("promotion persists for owners and operators and preserves their login and workspace", async () => {
  const originalCwd = process.cwd();
  const databaseUrl = process.env.DATABASE_URL;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "etiquefacil-admin-"));
  process.chdir(tempDir);
  delete process.env.DATABASE_URL;
  try {
    const url = pathToFileURL(path.join(originalCwd, "src/store.js"));
    url.search = `?admin-test=${Date.now()}`;
    const store = await import(url.href);
    const owner = await store.createUser({ name: "Principal", email: "owner@example.com", password: "teste123" });
    const operator = await store.createUser({ name: "Operador", email: "operator@example.com", password: "teste456", parentUserId: owner.id });
    const second = await store.createUser({ name: "Segundo", email: "second@example.com", password: "teste789", parentUserId: owner.id });
    for (const target of [operator, second]) {
      const result = await store.updateOperatorAccountAdmin({ ownerUserId: owner.id, operatorUserId: target.id, accountAdminAccess: true });
      assert.equal(result.operator.role, "account_admin");
      assert.equal(result.operator.workspaceUserId, owner.id);
    }
    await assert.rejects(store.updateOperatorAccountAdmin({ ownerUserId: "another-account", operatorUserId: operator.id, accountAdminAccess: true }), /Operador nao encontrado/);
    assert.equal((await store.verifyUser(operator.email, "teste456")).role, "account_admin");
    await store.updateOperatorAccountAdmin({ ownerUserId: owner.id, operatorUserId: second.id, accountAdminAccess: false });
    assert.equal((await store.getPublicUserById(second.id)).role, "operator");
    for (const [user, password] of [[owner, "teste123"], [operator, "teste456"]]) {
      const result = await store.promoteUserToAdmin(user.id);
      assert.equal(result.user.role, "admin");
      assert.equal(result.user.parentUserId, user.parentUserId);
      assert.equal(result.user.tenantId, user.tenantId);
      assert.equal(result.user.passwordHash, undefined);
      assert.equal((await store.verifyUser(user.email, password)).role, "admin");
      assert.equal((await store.getPublicUserById(user.id)).role, "admin");
      assert.equal((await store.promoteUserToAdmin(user.id)).user.role, "admin");
    }
    const listed = await store.listUsersForAdmin();
    assert.equal(listed[0].role, "admin");
    assert.equal(listed[0].operators.find(item => item.id === operator.id).role, "admin");
    await assert.rejects(store.promoteUserToAdmin("missing"), /Usuario nao encontrado/);
  } finally {
    process.chdir(originalCwd);
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
