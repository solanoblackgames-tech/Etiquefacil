import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUser } from "../src/store.js";

test("sanitizeUser exposes explicit tenant context", () => {
  assert.deepEqual(
    sanitizeUser({
      id: "user-1",
      tenantId: "tenant-1",
      tenantName: "Empresa 1",
      parentUserId: null,
      workspaceUserId: "user-1",
      role: "owner",
      operatorCode: null,
      name: "Lucas",
      email: "lucas@example.com"
    }),
    {
      id: "user-1",
      tenantId: "tenant-1",
      tenantName: "Empresa 1",
      parentUserId: null,
      workspaceUserId: "user-1",
      role: "owner",
      operatorCode: null,
      name: "Lucas",
      email: "lucas@example.com"
    }
  );
});

test("sanitizeUser keeps legacy users compatible with tenant context", () => {
  assert.deepEqual(
    sanitizeUser({
      id: "user-1",
      name: "Lucas",
      email: "lucas@example.com"
    }),
    {
      id: "user-1",
      tenantId: "user-1",
      tenantName: "Lucas",
      parentUserId: null,
      workspaceUserId: "user-1",
      role: "owner",
      operatorCode: null,
      name: "Lucas",
      email: "lucas@example.com"
    }
  );
});

test("sanitizeUser points operators at the owner workspace", () => {
  assert.deepEqual(
    sanitizeUser({
      id: "operator-1",
      tenantId: "tenant-1",
      tenantName: "Empresa 1",
      parentUserId: "user-1",
      role: "operator",
      operatorCode: 1001,
      name: "Ana",
      email: "ana@example.com"
    }),
    {
      id: "operator-1",
      tenantId: "tenant-1",
      tenantName: "Empresa 1",
      parentUserId: "user-1",
      workspaceUserId: "user-1",
      role: "operator",
      operatorCode: 1001,
      name: "Ana",
      email: "ana@example.com"
    }
  );
});
