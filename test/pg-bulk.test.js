import assert from "node:assert/strict";
import test from "node:test";
import { buildInsertBatches } from "../src/pg-bulk.js";

test("buildInsertBatches creates parameterized multi-row inserts", () => {
  const batches = buildInsertBatches(
    "users",
    ["id", "email"],
    [
      ["u1", "one@example.com"],
      ["u2", "two@example.com"]
    ],
    { batchSize: 100 }
  );

  assert.deepEqual(batches, [
    {
      sql: "insert into users (id, email) values ($1, $2), ($3, $4)",
      params: ["u1", "one@example.com", "u2", "two@example.com"]
    }
  ]);
});

test("buildInsertBatches splits rows by batch size", () => {
  const batches = buildInsertBatches("labels", ["id"], [["l1"], ["l2"], ["l3"]], { batchSize: 2 });

  assert.deepEqual(
    batches.map((batch) => batch.params),
    [["l1", "l2"], ["l3"]]
  );
  assert.equal(batches[0].sql, "insert into labels (id) values ($1), ($2)");
  assert.equal(batches[1].sql, "insert into labels (id) values ($1)");
});
