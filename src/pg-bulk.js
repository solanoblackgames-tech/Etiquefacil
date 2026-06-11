const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function buildInsertBatches(table, columns, rows, { batchSize = 500 } = {}) {
  const safeTable = identifier(table);
  const safeColumns = columns.map(identifier);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive integer.");
  if (!safeColumns.length) throw new Error("At least one column is required.");
  if (!rows.length) return [];

  const batches = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const batchRows = rows.slice(start, start + batchSize);
    const params = [];
    const values = batchRows.map((row) => {
      if (row.length !== safeColumns.length) {
        throw new Error(`Expected ${safeColumns.length} values for ${safeTable}, received ${row.length}.`);
      }
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    batches.push({
      sql: `insert into ${safeTable} (${safeColumns.join(", ")}) values ${values.join(", ")}`,
      params
    });
  }

  return batches;
}

export async function insertRows(client, table, columns, rows, options) {
  for (const batch of buildInsertBatches(table, columns, rows, options)) {
    await client.query(batch.sql, batch.params);
  }
}

function identifier(value) {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
