// Copy all rows from the legacy MySQL DB into the Supabase Postgres.
// Run via the network-enabled PowerShell tool (reaches both localhost MySQL
// and Supabase). Reads MySQL creds from config.php, Postgres from SUPA_URL.
//
//   SUPA_URL=postgres://... node db/tools/migrate-data.mjs
//
//  - dateStrings: preserve naive datetime/date/time values exactly (no tz shift)
//  - excludes generated columns (e.g. business_hours_exceptions.location_id_norm)
//  - truncates each target table first (idempotent re-runs)
//  - resets identity sequences to MAX(id) after load
//  - verifies row counts MySQL vs Postgres

import fs from "node:fs";
import mysql from "mysql2/promise";
import pg from "pg";

const XAMPP = process.env.PRENODO_XAMPP_ROOT || "C:\\xampp\\htdocs";
const cfg = fs.readFileSync(`${XAMPP}/config.php`, "utf8");
const phpVal = (k) => (cfg.match(new RegExp(`['"]${k}['"]\\s*=>\\s*['"]([^'"]*)['"]`)) || [])[1] || null;
const DB = phpVal("name");

const my = await mysql.createConnection({
  host: phpVal("host") || "localhost", user: phpVal("user"),
  password: phpVal("pass") || "", database: DB, dateStrings: true,
});
// GUARDIA (audit 21/07): questo tool fa TRUNCATE ... CASCADE di TUTTE le
// tabelle di destinazione. Niente fallback silenzioso al DB live: SUPA_URL
// esplicita E conferma esplicita, altrimenti abort.
const cs = process.env.SUPA_URL;
if (!cs) {
  console.error("SUPA_URL non impostata. Questo tool AZZERA il database di destinazione:");
  console.error("va puntato ESPLICITAMENTE (niente fallback a PRENODO_DATABASE_URL).");
  process.exit(1);
}
if (process.env.CONFIRM_WIPE !== "1") {
  console.error("Rifiutato: imposta CONFIRM_WIPE=1 per confermare il TRUNCATE totale del DB di destinazione.");
  process.exit(1);
}
const pgc = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
await pgc.connect();

const qid = (s) => `"${s}"`;
const tables = (await my.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY table_name`, [DB]
))[0].map((r) => r.TABLE_NAME ?? r.table_name);

let totalRows = 0, mismatches = [];
// 1) truncate all targets
await pgc.query(`TRUNCATE ${tables.map(qid).join(", ")} RESTART IDENTITY CASCADE`);

for (const t of tables) {
  // non-generated columns from Postgres (source of truth for insertable cols)
  const cols = (await pgc.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER'
     ORDER BY ordinal_position`, [t]
  )).rows.map((r) => r.column_name);

  const rows = (await my.query(`SELECT ${cols.map((c) => "`" + c + "`").join(", ")} FROM \`${t}\``))[0];
  if (rows.length === 0) continue;

  const colList = cols.map(qid).join(", ");
  const CHUNK = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const valuesSql = slice.map((row) => {
      const ph = cols.map((c) => { params.push(row[c] === undefined ? null : row[c]); return `$${params.length}`; });
      return `(${ph.join(", ")})`;
    }).join(", ");
    await pgc.query(`INSERT INTO ${qid(t)} (${colList}) VALUES ${valuesSql}`, params);
  }
  totalRows += rows.length;

  // reset identity if 'id' present
  if (cols.includes("id")) {
    await pgc.query(
      `SELECT setval(pg_get_serial_sequence($1,'id'), (SELECT COALESCE(MAX(id),1) FROM ${qid(t)}), true)`, [t]
    ).catch(() => {});
  }

  // verify
  const pgCount = (await pgc.query(`SELECT COUNT(*)::int n FROM ${qid(t)}`)).rows[0].n;
  if (pgCount !== rows.length) mismatches.push(`${t}: mysql=${rows.length} pg=${pgCount}`);
  console.log(`${t}: ${rows.length}`);
}

console.log(`\nTOTAL rows migrated: ${totalRows}`);
if (mismatches.length) { console.log("MISMATCHES:"); mismatches.forEach((m) => console.log("  " + m)); }
else console.log("All row counts match ✓");

await my.end();
await pgc.end();
