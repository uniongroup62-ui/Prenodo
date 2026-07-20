// GUARDIA ANTI-LEAK multi-tenant (2026-07-20).
//
// Nel modello a tabelle condivise ogni query su una tabella tenant DEVE
// essere filtrata per tenant_id: una query che lo dimentica restituisce i
// dati di TUTTI i tenant. Questo script scandisce lib/ e app/ cercando
// chiamate dirette dbQuery/dbExecute su tabelle tenant il cui SQL non
// contiene tenant_id, e fallisce se ne trova di non giustificate.
//
// Eccezioni legittime (aggregati di piattaforma del pannello admin, scoping
// costruito dinamicamente): vanno ANNOTATE con un commento nelle 3 righe
// sopra la chiamata:   // cross-tenant: <motivo>
//
// Uso:  node scripts/check-tenant-scoping.mjs   (exit 1 se trova violazioni)
// La lista tabelle viene dal DB (.env.local) e viene cacheata in
// scripts/tenant-tables.json per l'uso offline/CI.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scripts", "tenant-tables.json");

async function tenantTables() {
  try {
    const env = readFileSync(join(ROOT, ".env.local"), "utf8");
    const url = (env.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
    if (!url) throw new Error("no db url");
    const pg = require("pg");
    const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const rows = await db.query(`
      SELECT DISTINCT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
      ORDER BY 1`);
    await db.end();
    const tables = rows.rows.map((r) => String(r.table_name));
    writeFileSync(CACHE, JSON.stringify(tables, null, 2));
    return tables;
  } catch {
    if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
    throw new Error("DB non raggiungibile e nessuna cache scripts/tenant-tables.json");
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name)) {
      yield full;
    }
  }
}

// Estrae il primo argomento stringa (template `...` o "..."/'...') di una
// chiamata a partire dalla parentesi aperta.
function extractSql(src, callStart) {
  let i = src.indexOf("(", callStart);
  if (i < 0) return null;
  i += 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const quote = src[i];
  if (quote !== "`" && quote !== '"' && quote !== "'") return null;
  let out = "";
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
    // Interpolazione ${...} nei template: si salta il blocco bilanciato
    // (può contenere template annidati con backtick reali) e si tiene un
    // segnaposto, così il terminatore vero non viene confuso.
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
        j += 1;
      }
      // Si conserva il TESTO dell'espressione: se contiene tenant/scope, la
      // clausola di scoping e' costruita dinamicamente (pattern del codebase).
      out += " ${" + src.slice(i + 2, j - 1) + "} ";
      i = j;
      continue;
    }
    if (c === quote) break;
    out += c;
    i += 1;
  }
  return out;
}

const tables = await tenantTables();
// Tabelle amministrative della piattaforma: portano tenant_id ma le liste
// cross-tenant del pannello admin sono il loro uso NORMALE (protette dalla
// sessione admin, non esposte ai tenant).
const ADMIN_PLANE = new Set(tables.filter((t) => t.startsWith("saas_")));
const tableRe = new RegExp("(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM)\\s+[`\"']?(" + tables.join("|") + ")[`\"']?\\b", "gi");

const violations = [];
for (const dir of ["lib", "app"]) {
  for (const file of walk(join(ROOT, dir))) {
    // Il motore di scoping costruisce SQL dinamico per definizione.
    if (/tenant-db\.ts$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const re = /\bdb(Query|Execute)\s*(<[^>]*>)?\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const sql = extractSql(src, m.index);
      if (!sql) continue;
      tableRe.lastIndex = 0;
      const hit = [...sql.matchAll(tableRe)].map((x) => x[1].toLowerCase());
      const tenantHits = [...new Set(hit)].filter((t) => !ADMIN_PLANE.has(t));
      if (!tenantHits.length) continue;
      if (/tenant_id/i.test(sql)) continue;
      // Interpolazioni di scoping dinamico (tenantScope/tenantP/scope.sql...).
      if (/\$\{[^}]*(tenant|scope)[^}]*\}/i.test(sql)) continue;
      const lineNo = src.slice(0, m.index).split("\n").length;
      const context = lines.slice(Math.max(0, lineNo - 4), lineNo - 1).join("\n");
      if (/cross-tenant:/.test(context)) continue;
      violations.push({ file: file.replace(ROOT + "\\", "").replace(/\\/g, "/"), line: lineNo, tables: tenantHits, sql: sql.replace(/\s+/g, " ").slice(0, 110) });
    }
  }
}

if (violations.length) {
  console.log(`VIOLAZIONI DI SCOPING TENANT: ${violations.length}\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  [${v.tables.join(", ")}]`);
    console.log(`    ${v.sql}\n`);
  }
  console.log("Ogni query su tabelle tenant deve filtrare per tenant_id, oppure va");
  console.log("annotata con '// cross-tenant: <motivo>' nelle 3 righe precedenti.");
  process.exit(1);
}
console.log(`OK: nessuna query non-scopata su ${tables.length} tabelle tenant (lib/ + app/).`);
