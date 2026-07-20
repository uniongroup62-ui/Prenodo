// Fornitori pass 2 (2026-07-18) — FIX classe PG case-sensitivity sul match
// products.supplier_name (MySQL _ci nel legacy): (1) blocker delete contava
// solo il case esatto ('ZZ FORN X' non bloccava il fornitore 'ZZ Forn X');
// (2) propagazione RENAME sui prodotti idem; (3) conteggio 'Uso' della lista.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["products.manage", "suppliers.manage", "stock_moves.manage", "product_categories.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/products?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let supId = 0, pid = 0;
const NAME = `ZZ Forn ${RUN}`;
try {
  // Fornitore + prodotto col supplier_name in MAIUSCOLO (variante di case)
  const s1 = await api({ action: "supplier_save", id: "0", name: NAME, location_ids: "21", cost_location_ids: "21", is_active: "1", is_active_costs: "1" });
  supId = Number((await q1("SELECT id FROM suppliers WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1", [T, NAME]))?.id ?? 0);
  check("PRE fornitore creato", s1.j?.ok !== false && supId > 0, JSON.stringify(err(s1)));
  pid = Number((await q("INSERT INTO products (tenant_id, name, price, is_active, stock, supplier_name) VALUES ($1,$2,10,1,0,$3) RETURNING id", [T, `ZZ ProdF ${RUN}`, NAME.toUpperCase()])).rows[0].id);

  // F1 (FIX): delete BLOCCATO dal prodotto con case diverso (verbatim)
  const d1 = await api({ action: "supplier_delete", id: String(supId) });
  check("F1 delete bloccato dal prodotto 'MAIUSCOLO' (match _ci come il legacy)", err(d1) === "Fornitore usato in prodotti o costi: non puo essere eliminato, disattivalo dai moduli.", JSON.stringify(err(d1)));

  // F2 (FIX): conteggio 'Uso' della lista conta la variante di case
  const g1 = await fetch(`${BASE}/api/manage/products?slug=${SLUG}`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  const supRow = (g1.suppliers ?? []).find((s) => Number(s.id) === supId);
  check("F2 lista: productCount=1 (variante di case contata)", Number(supRow?.productCount ?? -1) === 1, JSON.stringify({ pc: supRow?.productCount }));

  // F3 (FIX): rename -> propagazione sul prodotto con case diverso
  const NEW = `ZZ FornR ${RUN}`;
  const s2 = await api({ action: "supplier_save", id: String(supId), name: NEW, location_ids: "21", cost_location_ids: "21", is_active: "1", is_active_costs: "1" });
  const prod = await q1("SELECT supplier_name FROM products WHERE tenant_id=$1 AND id=$2", [T, pid]);
  check("F3 rename: supplier_name del prodotto (era MAIUSCOLO) aggiornato al nuovo nome", s2.j?.ok !== false && prod?.supplier_name === NEW, JSON.stringify({ e: err(s2), sn: prod?.supplier_name }));

  // F4: senza referenze -> delete ok + mapping rimossi
  await q("UPDATE products SET supplier_name=NULL WHERE tenant_id=$1 AND id=$2", [T, pid]);
  const d2 = await api({ action: "supplier_delete", id: String(supId) });
  const left = await q1("SELECT (SELECT COUNT(*) FROM suppliers WHERE tenant_id=$1 AND id=$2)::int s,(SELECT COUNT(*) FROM supplier_locations WHERE tenant_id=$1 AND supplier_id=$2)::int m", [T, supId]);
  check("F4 delete senza referenze: fornitore + mapping sedi rimossi", d2.j?.ok !== false && left.s === 0 && left.m === 0, JSON.stringify({ e: err(d2), left }));
  if (left.s === 0) supId = 0;

  // F5: univocità nome case-insensitive (guardia già indurita — sanity)
  const s3 = await api({ action: "supplier_save", id: "0", name: `zz dup ${RUN}`, location_ids: "21", cost_location_ids: "21" });
  const dupId = Number((await q1("SELECT id FROM suppliers WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [T, `zz dup ${RUN}`]))?.id ?? 0);
  const s4 = await api({ action: "supplier_save", id: "0", name: `ZZ DUP ${RUN}`, location_ids: "21", cost_location_ids: "21" });
  check("F5 dup case-insensitive -> 'Esiste gia un fornitore con questo nome.'", s3.j?.ok !== false && err(s4) === "Esiste gia un fornitore con questo nome.", JSON.stringify(err(s4)));
  if (dupId) await q("DELETE FROM supplier_locations WHERE tenant_id=$1 AND supplier_id=$2", [T, dupId]).catch(() => {});
  if (dupId) await q("DELETE FROM suppliers WHERE tenant_id=$1 AND id=$2", [T, dupId]).catch(() => {});
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (pid) await q("DELETE FROM products WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'", [T, pid]).catch(() => {});
  if (supId) {
    await q("DELETE FROM supplier_locations WHERE tenant_id=$1 AND supplier_id=$2", [T, supId]).catch(() => {});
    await q("DELETE FROM suppliers WHERE tenant_id=$1 AND id=$2", [T, supId]).catch(() => {});
  }
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM suppliers WHERE tenant_id=$1 AND name LIKE 'ZZ%')::int s,(SELECT COUNT(*) FROM products WHERE tenant_id=$1)::int p,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.s === 0 && fin.p === 0 && fin.l === 0;
  console.log(`CLEANUP: fornitoriZZ=${fin.s} prodotti=${fin.p}/0 logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
