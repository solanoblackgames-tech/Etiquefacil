import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { ensureStore, hasPostgres, writeDb } from "../src/store.js";

const source = process.argv[2] || path.resolve("data", "db.json");

if (!hasPostgres()) {
  console.error("Defina DATABASE_URL antes de migrar para PostgreSQL.");
  process.exit(1);
}

const raw = await fs.readFile(source, "utf8");
const db = JSON.parse(raw);

await ensureStore();
await writeDb({
  users: db.users || [],
  lots: db.lots || [],
  products: db.products || [],
  rzItems: db.rzItems || [],
  scans: db.scans || [],
  labels: db.labels || []
});

console.log(`Migração concluída a partir de ${source}.`);
