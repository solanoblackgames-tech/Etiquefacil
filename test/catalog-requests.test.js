import assert from "node:assert/strict";
import test from "node:test";
import { buildRejectedCatalogRequest, isStandardMlCode, mergePendingCatalogRequest, selectCatalogApprovalPayload } from "../src/store.js";

test("mergePendingCatalogRequest groups repeated pending create suggestions by Codigo ML", () => {
  const requests = [
    {
      id: "request-1",
      userId: "user-1",
      lotId: "lot-1",
      productId: "product-1",
      type: "create",
      status: "pending",
      codigoMl: "ABCD12345",
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
    codigoMl: " abcd12345 ",
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
      codigoMl: "ABCD12345",
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
    codigoMl: "ABCD12345",
    descricao: "Nova tentativa",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].id, "request-2");
});

test("mergePendingCatalogRequest ignores repeated confirmations from the same actor", () => {
  const requests = [
    {
      id: "request-1",
      userId: "owner-1",
      createdByUserId: "operator-1",
      type: "create",
      status: "pending",
      codigoMl: "ABCD12345",
      descricao: "Produto inicial",
      valorUnit: 100,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  const merged = mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "owner-1",
    createdByUserId: "operator-1",
    type: "create",
    status: "pending",
    codigoMl: "ABCD12345",
    descricao: "Produto repetido",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(merged.id, "request-1");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].doubleChecks || [], []);
});

test("mergePendingCatalogRequest accepts double check from another operator in the same workspace", () => {
  const requests = [
    {
      id: "request-1",
      userId: "owner-1",
      createdByUserId: "operator-1",
      type: "create",
      status: "pending",
      codigoMl: "ABCD12345",
      descricao: "Produto inicial",
      valorUnit: 100,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "owner-1",
    createdByUserId: "operator-2",
    operatorUserId: "operator-2",
    type: "create",
    status: "pending",
    codigoMl: "ABCD12345",
    descricao: "Produto confirmado",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].doubleChecks.length, 1);
  assert.equal(requests[0].doubleChecks[0].userId, "owner-1");
  assert.equal(requests[0].doubleChecks[0].createdByUserId, "operator-2");
  assert.equal(requests[0].doubleChecks[0].operatorUserId, "operator-2");
});

test("mergePendingCatalogRequest promotes manual suggestion to lot suggestion when spreadsheet confirms the same ML", () => {
  const requests = [
    {
      id: "request-1",
      userId: "owner-1",
      createdByUserId: "owner-1",
      type: "create",
      status: "pending",
      scope: "individual",
      codigoMl: "ABCD12345",
      descricao: "Produto manual",
      valorUnit: 100,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "owner-1",
    createdByUserId: "owner-1",
    lotId: "lot-2",
    productId: "product-2",
    type: "create",
    status: "pending",
    scope: "lot",
    alertMessage: "Codigo ML ja cadastrado previamente no banco historico: Produto aprovado.",
    codigoMl: "ABCD12345",
    descricao: "Produto da planilha",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].scope, "lot");
  assert.equal(requests[0].alertMessage, "Codigo ML ja cadastrado previamente no banco historico: Produto aprovado.");
  assert.equal(requests[0].doubleChecks.length, 1);
  assert.equal(requests[0].doubleChecks[0].scope, "lot");
  assert.equal(requests[0].doubleChecks[0].descricao, "Produto da planilha");
});

test("mergePendingCatalogRequest keeps non-matching manual suggestions in the individual list", () => {
  const requests = [
    {
      id: "request-1",
      userId: "owner-1",
      type: "create",
      status: "pending",
      scope: "individual",
      codigoMl: "ABCD12345",
      descricao: "Produto manual",
      valorUnit: 100,
      createdAt: "2026-06-18T10:00:00.000Z"
    }
  ];

  mergePendingCatalogRequest(requests, {
    id: "request-2",
    userId: "owner-1",
    type: "create",
    status: "pending",
    scope: "lot",
    codigoMl: "WXYZ45678",
    descricao: "Produto da planilha",
    valorUnit: 105,
    createdAt: "2026-06-18T11:00:00.000Z"
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].scope, "individual");
  assert.equal(requests[1].scope, "lot");
});

test("mergePendingCatalogRequest ignores suggestions outside the standard ML pattern", () => {
  const requests = [];

  const merged = mergePendingCatalogRequest(requests, {
    id: "request-1",
    userId: "owner-1",
    type: "create",
    status: "pending",
    scope: "individual",
    codigoMl: "ML123",
    descricao: "Produto fora do padrao",
    valorUnit: 100,
    createdAt: "2026-06-18T10:00:00.000Z"
  });

  assert.equal(merged, null);
  assert.equal(requests.length, 0);
  assert.equal(isStandardMlCode("ABCD12345"), true);
  assert.equal(isStandardMlCode("ML123"), false);
});

test("selectCatalogApprovalPayload uses the selected double check values", () => {
  const request = {
    id: "request-1",
    codigoMl: "ABCD12345",
    descricao: "Produto inicial",
    valorUnit: 100,
    precoCusto: 0,
    doubleChecks: [
      {
        id: "check-1",
        codigoMl: "ABCD12345",
        descricao: "Produto confirmado",
        valorUnit: 105,
        precoCusto: 7,
        ean: "7891234567890",
        link: "https://example/produto",
        foto: "https://img.example/produto.jpg"
      }
    ]
  };

  const selected = selectCatalogApprovalPayload(request, "check-1");

  assert.equal(selected.id, "request-1");
  assert.equal(selected.codigoMl, "ABCD12345");
  assert.equal(selected.descricao, "Produto confirmado");
  assert.equal(selected.valorUnit, 105);
  assert.equal(selected.precoCusto, 7);
  assert.equal(selected.ean, "7891234567890");
  assert.equal(selected.link, "https://example/produto");
  assert.equal(selected.foto, "https://img.example/produto.jpg");
});

test("buildRejectedCatalogRequest archives rejected suggestion data", () => {
  const archived = buildRejectedCatalogRequest(
    {
      id: "request-1",
      userId: "user-1",
      lotId: "lot-1",
      productId: "product-1",
      type: "create",
      status: "pending",
      codigoMl: " abcd12345 ",
      descricao: "Produto rejeitado",
      valorUnit: 100,
      precoCusto: 7,
      doubleChecks: [{ id: "check-1", descricao: "Conferencia" }],
      createdAt: "2026-06-18T10:00:00.000Z"
    },
    "2026-06-18T11:00:00.000Z"
  );

  assert.equal(archived.originalRequestId, "request-1");
  assert.equal(archived.status, "rejected");
  assert.equal(archived.codigoMl, "ABCD12345");
  assert.equal(archived.rejectedAt, "2026-06-18T11:00:00.000Z");
  assert.deepEqual(archived.doubleChecks, [{ id: "check-1", descricao: "Conferencia" }]);
});
