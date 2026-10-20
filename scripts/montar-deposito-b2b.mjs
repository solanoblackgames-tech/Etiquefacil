// Monta o deposito WMS "Venda B2B" com a mesma grade do WMS do JZ Separacao (ruas A-F, 4 niveis por coluna + patio).
// Uso: node scripts/montar-deposito-b2b.mjs <email-da-conta-dona>            -> so mostra o que vai gravar
//      node scripts/montar-deposito-b2b.mjs <email-da-conta-dona> --gravar   -> grava
import "dotenv/config";
import pg from "pg";
import { buildWmsPositionCodes, normalizeWmsDeposit } from "../src/wms-labels.js";

const DEPOSIT_NAME = "VENDA B2B";
const ROWS = [
  { label: "A", columns: 26, positions: 4 },
  { label: "B", columns: 20, positions: 4 },
  { label: "C", columns: 20, positions: 4 },
  { label: "D", columns: 11, positions: 4 },
  { label: "E", columns: 15, positions: 4 },
  { label: "F", columns: 15, positions: 4 },
  { label: "PATIO", columns: 1, positions: 1 }
];

const email = String(process.argv[2] || "").trim().toLowerCase();
const write = process.argv.includes("--gravar");
if (!email) {
  console.error("Informe o e-mail da conta dona: node scripts/montar-deposito-b2b.mjs <email> [--gravar]");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const user = (await client.query("select id, email, role from users where lower(email) = $1 limit 1", [email])).rows[0];
  if (!user) throw new Error(`Conta ${email} nao encontrada.`);
  if (user.role !== "owner") throw new Error(`Conta ${email} nao e dona (role ${user.role}).`);

  const current = (await client.query(
    "select value from user_settings where user_id = $1 and key = 'triage_transfer' limit 1",
    [user.id]
  )).rows[0]?.value || {};
  const wmsDeposits = Array.isArray(current.wmsDeposits) ? current.wmsDeposits : [];
  const existing = wmsDeposits.find((deposit) => String(deposit.depositName || "").trim().toLowerCase() === DEPOSIT_NAME.toLowerCase());

  // Mantem conta Bling e lojas se o deposito ja existia; troca so a grade.
  const deposit = normalizeWmsDeposit({
    ...(existing || {}),
    depositName: existing?.depositName || DEPOSIT_NAME,
    prefix: "B2B",
    rowsConfig: ROWS
  });
  const codes = buildWmsPositionCodes(deposit);
  const next = {
    ...current,
    wmsDeposits: existing
      ? wmsDeposits.map((item) => (item === existing ? deposit : item))
      : [...wmsDeposits, deposit]
  };

  console.log(`Conta: ${user.email}`);
  console.log(`Depositos WMS atuais: ${wmsDeposits.map((item) => item.depositName).join(", ") || "nenhum"}`);
  console.log(`${existing ? "Atualiza" : "Cria"} ${deposit.depositName}: ${codes.length} posicoes, de ${codes[0]} ate ${codes[codes.length - 1]}`);
  console.table(deposit.rowsConfig);

  if (!write) {
    console.log("Nada gravado. Rode de novo com --gravar para salvar.");
  } else {
    await client.query(
      `insert into user_settings (user_id, key, value, updated_at)
       values ($1, 'triage_transfer', $2, now())
       on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [user.id, next]
    );
    console.log("Deposito WMS gravado. Abra Perfil no Etiquefacil para conferir e imprimir os QR.");
  }
} finally {
  await client.end();
}
