import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const APPLY = process.argv.includes("--apply");
const REOPEN = process.argv.includes("--reopen");

const REQUIRED_FIELDS_SQL = `
  coalesce(trim(descricao), '') = ''
  or coalesce(trim(sku), '') = ''
  or coalesce(trim(ean), '') = ''
  or coalesce(altura_caixa, 0) <= 0
  or coalesce(largura_caixa, 0) <= 0
  or coalesce(comprimento_caixa, 0) <= 0
  or coalesce(peso_caixa, 0) <= 0
`;

const FIELD_KEYS = ["descricao", "sku", "ean", "alturaCaixa", "larguraCaixa", "comprimentoCaixa", "pesoCaixa"];

function norm(value) {
  return String(value || "").trim().toUpperCase();
}

function hasText(value) {
  return String(value || "").trim() !== "";
}

function hasPositive(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0;
}

function isIncomplete(item) {
  return !hasText(item.descricao)
    || !hasText(item.sku)
    || !hasText(item.ean)
    || !hasPositive(item.alturaCaixa)
    || !hasPositive(item.larguraCaixa)
    || !hasPositive(item.comprimentoCaixa)
    || !hasPositive(item.pesoCaixa);
}

function itemFromRow(row) {
  return {
    id: row.id,
    code: row.code,
    productCode: row.product_code || row.codigo_ml || "",
    sku: row.sku || "",
    ean: row.ean || "",
    descricao: row.descricao || "",
    alturaCaixa: row.altura_caixa,
    larguraCaixa: row.largura_caixa,
    comprimentoCaixa: row.comprimento_caixa,
    pesoCaixa: row.peso_caixa,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function candidateScore(candidate) {
  return FIELD_KEYS.reduce((score, key) => score + (key.includes("Caixa") ? hasPositive(candidate[key]) : hasText(candidate[key]) ? 1 : 0), 0);
}

function candidateKeyMatches(item, candidate) {
  const itemKeys = [item.sku, item.productCode, item.ean].map(norm).filter(Boolean);
  const candidateKeys = [candidate.sku, candidate.productCode, candidate.ean].map(norm).filter(Boolean);
  return itemKeys.some((key) => candidateKeys.includes(key));
}

function fillMissing(item, candidate) {
  const next = { ...item };
  if (!hasText(next.descricao) && hasText(candidate.descricao)) next.descricao = candidate.descricao;
  if (!hasText(next.sku) && hasText(candidate.sku)) next.sku = candidate.sku;
  if (!hasText(next.ean) && hasText(candidate.ean)) next.ean = candidate.ean;
  for (const key of ["alturaCaixa", "larguraCaixa", "comprimentoCaixa", "pesoCaixa"]) {
    if (!hasPositive(next[key]) && hasPositive(candidate[key])) next[key] = candidate[key];
  }
  return next;
}

function diffPatch(original, repaired) {
  const patch = {};
  for (const key of FIELD_KEYS) {
    if (String(original[key] ?? "") !== String(repaired[key] ?? "")) patch[key] = repaired[key];
  }
  return patch;
}

async function queryCandidates(client, table, badItems) {
  const skus = [...new Set(badItems.map((item) => norm(item.sku)).filter(Boolean))];
  const productCodes = [...new Set(badItems.map((item) => norm(item.productCode)).filter(Boolean))];
  const eans = [...new Set(badItems.map((item) => String(item.ean || "").trim()).filter(Boolean))];
  const rows = [];

  if (table === "products" && skus.length) {
    const result = await client.query(
      `select * from ${table} where upper(trim(sku)) = any($1) order by created_at desc nulls last`,
      [skus]
    );
    rows.push(...result.rows);
  }
  if (productCodes.length) {
    const codeColumn = table === "catalog_products" ? "codigo_ml" : "codigo_ml";
    const result = await client.query(
      `select * from ${table} where upper(trim(${codeColumn})) = any($1) order by created_at desc nulls last`,
      [productCodes]
    );
    rows.push(...result.rows);
  }
  if (eans.length) {
    const result = await client.query(
      `select * from ${table} where trim(ean) = any($1) order by created_at desc nulls last`,
      [eans]
    );
    rows.push(...result.rows);
  }

  return rows.map(itemFromRow).filter((candidate) => candidateScore(candidate) > 0);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL nao configurado.");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    const badResult = await client.query(`
      select *
      from triage_items
      where status = 'diagnosticado'
        and (${REQUIRED_FIELDS_SQL})
      order by diagnosed_at desc nulls last, updated_at desc
    `);
    const badItems = badResult.rows.map(itemFromRow);

    const transferResult = await client.query(`
      select
        count(distinct t.id)::int as incomplete,
        count(distinct tl.id)::int as transfer_lots,
        count(distinct tl.id) filter (where tl.status = 'synced')::int as synced_transfers,
        count(distinct tl.id) filter (where tl.status <> 'synced')::int as open_transfers
      from triage_items t
      left join transfer_lots tl on tl.triage_item_id = t.id and tl.source = 'triage'
      where t.status = 'diagnosticado'
        and (${REQUIRED_FIELDS_SQL.replaceAll("descricao", "t.descricao").replaceAll("sku", "t.sku").replaceAll("ean", "t.ean").replaceAll("altura_caixa", "t.altura_caixa").replaceAll("largura_caixa", "t.largura_caixa").replaceAll("comprimento_caixa", "t.comprimento_caixa").replaceAll("peso_caixa", "t.peso_caixa")})
    `);

    const candidates = [
      ...await queryCandidates(client, "products", badItems),
      ...await queryCandidates(client, "catalog_products", badItems)
    ];

    const triageHistoryResult = await client.query(`
      select *
      from triage_items
      where status = 'diagnosticado'
        and not (${REQUIRED_FIELDS_SQL})
      order by diagnosed_at desc nulls last, updated_at desc
    `);
    candidates.push(...triageHistoryResult.rows.map(itemFromRow));

    const repairs = [];
    for (const item of badItems) {
      const repaired = candidates
        .filter((candidate) => candidate.id !== item.id && candidateKeyMatches(item, candidate))
        .sort((a, b) => candidateScore(b) - candidateScore(a))
        .reduce((current, candidate) => isIncomplete(current) ? fillMissing(current, candidate) : current, item);
      const patch = diffPatch(item, repaired);
      if (Object.keys(patch).length) repairs.push({ item, patch, repaired });
    }

    const afterBackfill = badItems.map((item) => {
      const repair = repairs.find((entry) => entry.item.id === item.id);
      return repair?.repaired || item;
    });
    const stillIncomplete = afterBackfill.filter(isIncomplete);

    const summary = {
      apply: APPLY,
      reopen: REOPEN,
      beforeIncompleteDiagnosed: badItems.length,
      transferImpact: transferResult.rows[0],
      repairableByHistory: repairs.length,
      stillIncompleteAfterBackfill: stillIncomplete.length,
      sampleStillIncomplete: stillIncomplete.slice(0, 20).map((item) => ({
        code: item.code,
        sku: item.sku,
        descricao: item.descricao,
        ean: item.ean,
        alturaCaixa: item.alturaCaixa,
        larguraCaixa: item.larguraCaixa,
        comprimentoCaixa: item.comprimentoCaixa,
        pesoCaixa: item.pesoCaixa
      }))
    };

    if (!APPLY) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    await client.query("begin");
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    await client.query(`
      create table if not exists maintenance_triage_incomplete_backup_${stamp} as
      select *
      from triage_items
      where status = 'diagnosticado'
        and (${REQUIRED_FIELDS_SQL})
    `);
    await client.query(`
      create table if not exists maintenance_triage_transfer_lots_backup_${stamp} as
      select tl.*
      from transfer_lots tl
      join triage_items t on t.id = tl.triage_item_id
      where tl.source = 'triage'
        and t.status = 'diagnosticado'
        and (${REQUIRED_FIELDS_SQL.replaceAll("descricao", "t.descricao").replaceAll("sku", "t.sku").replaceAll("ean", "t.ean").replaceAll("altura_caixa", "t.altura_caixa").replaceAll("largura_caixa", "t.largura_caixa").replaceAll("comprimento_caixa", "t.comprimento_caixa").replaceAll("peso_caixa", "t.peso_caixa")})
    `);
    await client.query(`
      create table if not exists maintenance_triage_transfer_items_backup_${stamp} as
      select ti.*
      from transfer_items ti
      join transfer_lots tl on tl.id = ti.transfer_lot_id
      join triage_items t on t.id = tl.triage_item_id
      where tl.source = 'triage'
        and t.status = 'diagnosticado'
        and (${REQUIRED_FIELDS_SQL.replaceAll("descricao", "t.descricao").replaceAll("sku", "t.sku").replaceAll("ean", "t.ean").replaceAll("altura_caixa", "t.altura_caixa").replaceAll("largura_caixa", "t.largura_caixa").replaceAll("comprimento_caixa", "t.comprimento_caixa").replaceAll("peso_caixa", "t.peso_caixa")})
    `);

    for (const repair of repairs) {
      await client.query(
        `update triage_items
         set descricao = coalesce(nullif($2, ''), descricao),
             sku = coalesce(nullif($3, ''), sku),
             ean = coalesce(nullif($4, ''), ean),
             altura_caixa = coalesce($5, altura_caixa),
             largura_caixa = coalesce($6, largura_caixa),
             comprimento_caixa = coalesce($7, comprimento_caixa),
             peso_caixa = coalesce($8, peso_caixa),
             updated_at = now()
         where id = $1`,
        [
          repair.item.id,
          repair.patch.descricao || "",
          repair.patch.sku || "",
          repair.patch.ean || "",
          hasPositive(repair.patch.alturaCaixa) ? repair.patch.alturaCaixa : null,
          hasPositive(repair.patch.larguraCaixa) ? repair.patch.larguraCaixa : null,
          hasPositive(repair.patch.comprimentoCaixa) ? repair.patch.comprimentoCaixa : null,
          hasPositive(repair.patch.pesoCaixa) ? repair.patch.pesoCaixa : null
        ]
      );
    }

    let reopened = 0;
    let removedWaitingTransfers = 0;
    if (REOPEN) {
      const deleteTransfers = await client.query(`
        delete from transfer_lots tl
        using triage_items t
        where tl.triage_item_id = t.id
          and tl.source = 'triage'
          and tl.status = 'waiting_store'
          and t.status = 'diagnosticado'
          and (${REQUIRED_FIELDS_SQL.replaceAll("descricao", "t.descricao").replaceAll("sku", "t.sku").replaceAll("ean", "t.ean").replaceAll("altura_caixa", "t.altura_caixa").replaceAll("largura_caixa", "t.largura_caixa").replaceAll("comprimento_caixa", "t.comprimento_caixa").replaceAll("peso_caixa", "t.peso_caixa")})
      `);
      removedWaitingTransfers = deleteTransfers.rowCount;

      const reopenResult = await client.query(`
        update triage_items
        set status = 'aguardando_teste',
            destination = '',
            diagnosis_condition = '',
            diagnosed_at = null,
            updated_at = now()
        where status = 'diagnosticado'
          and (${REQUIRED_FIELDS_SQL})
          and not exists (
            select 1
            from transfer_lots tl
            where tl.triage_item_id = triage_items.id
              and tl.source = 'triage'
              and tl.status = 'synced'
          )
      `);
      reopened = reopenResult.rowCount;
    }

    await client.query("commit");
    console.log(JSON.stringify({
      ...summary,
      backupTable: `maintenance_triage_incomplete_backup_${stamp}`,
      transferLotsBackupTable: `maintenance_triage_transfer_lots_backup_${stamp}`,
      transferItemsBackupTable: `maintenance_triage_transfer_items_backup_${stamp}`,
      appliedRepairs: repairs.length,
      removedWaitingTransfers,
      reopened
    }, null, 2));
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
