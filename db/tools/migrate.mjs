// Migrazioni numerate: applica in ordine i file db/migrations/*.sql non ancora
// registrati in schema_migrations, ciascuno nella propria transazione.
//
//   node db/tools/migrate.mjs            # applica le pendenti
//   node db/tools/migrate.mjs --status   # elenca applicate/pendenti, non tocca nulla
//
// Legge PRENODO_DATABASE_URL (o SUPA_URL) dall'ambiente, con fallback su
// .env.local. REGOLA: dal 2026-07-20 ogni nuova modifica di schema è un file
// qui dentro (mai a mano sul pannello, mai "ensure" runtime per nuove DDL);
// i file applicati non si modificano MAI, si aggiunge il successivo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = path.join(root, "db", "migrations");

function connectionString() {
  const fromEnv = process.env.PRENODO_DATABASE_URL || process.env.SUPA_URL;
  if (fromEnv) return fromEnv;
  try {
    const envFile = fs.readFileSync(path.join(root, ".env.local"), "utf8");
    const m = envFile.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

const cs = connectionString();
if (!cs) { console.error("PRENODO_DATABASE_URL mancante (env o .env.local)."); process.exit(2); }

const statusOnly = process.argv.includes("--status");
const files = fs.readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
if (!files.length) { console.log("Nessuna migrazione in db/migrations/."); process.exit(0); }

const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await client.connect();
try {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f) ? "APPLICATA" : "PENDENTE "} ${f}`);
    process.exit(pending.length ? 1 : 0);
  }

  for (const f of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`APPLICATA ${f}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`FALLITA ${f}: ${e.message}`);
      if (e.position) console.error("vicino a: ...", sql.slice(Math.max(0, e.position - 120), Number(e.position) + 40).replace(/\n/g, " "));
      process.exit(1);
    }
  }
  console.log(pending.length ? `Fatto: ${pending.length} migrazioni applicate.` : "Nessuna migrazione pendente.");
} finally {
  await client.end();
}
