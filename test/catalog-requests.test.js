import assert from "node:assert/strict";
import test from "node:test";
import { mergePendingCatalogRequest } from "../src/store.js";

test("mergePendingCatalogRequest groups repeated pending create suggestions by Codigo ML", () => {
  const requests = [
    {
      id: "request-1",
      userId: "user-1",
      lotId: "lot-1",
      productId: "product-1",
      type: "create",
      status: "pending",
      codigoMl: "ML123",
      descricao: "Produto inicial",
      valorUnit: 100,
      precoCusto: 0,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  const merged = mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "user-2",
    lotId: "lot-2",
    productId: "product-2",
    type: "create",
    status: "pending",
    codigoMl: " ml123 ",
    descricao: "Produto confirmado",
    valorUnit: 105,
    precoCusto: 0,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 1);
  assert.equal(merged.id, "request-1");
  assert.equal(requests[0].doubleChecks.length, 1);
  assert.equal(requests[0].doubleChecks[0].userId, "user-2");
  assert.equal(requests[0].doubleChecks[0].descricao, "Produto confirmado");
});

test("mergePendingCatalogRequest keeps rejected suggestions separated", () => {
  const requests = [
    {
      id: "request-1",
      type: "create",
      status: "rejected",
      codigoMl: "ML123",
      descricao: "Produto rejeitado",
      valorUnit: 100,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "user-2",
    type: "create",
    status: "pending",
    codigoMl: "ML123",
    descricao: "Nova tentativa",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].id, "request-2");
});
