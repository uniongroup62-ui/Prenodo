// Costi — miglioria log attività (2026-07-18): modulo NUOVO 'costi' su
// save/delete/bulk/toggle-pagato + categorie (crea/modifica/elimina/toggle).
// Segnali DOPO il successo: guardie/validazioni respinte senza voce.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["costs.manage", "costs.items", "costs.categories"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const fresh = async () => (await q("SELECT module, action, entity_type, entity_id, label FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, logWatermark])).rows;
const costIds = []; let catId = 0;
try {
  // L1: validazione respinta -> nessuna voce
  await api({ action: "save_cost", id: "0", title: "", amount: "10", due_date: "2027-08-01", location_id: "21" });
  await sleep(400);
  check("L1 validazione respinta -> nessuna voce", (await fresh()).length === 0, "");

  // L2: create costo -> costi/crea con titolo
  const s1 = await api({ action: "save_cost", id: "0", title: `ZZ CLog ${RUN}`, amount: "10", vat_percent: "0", due_date: "2027-08-01", location_id: "21" });
  const c1 = Number((await q1("SELECT id FROM costs WHERE tenant_id=$1 AND title=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ CLog ${RUN}`]))?.id ?? 0);
  if (c1) costIds.push(c1);
  await sleep(500);
  let rows = await fresh();
  check("L2 create loggato: costi/crea 'Creato costo \"...\"'", s1.j?.ok !== false && rows.length === 1 && rows[0].module === "costi" && rows[0].action === "crea" && rows[0].label === `Creato costo "ZZ CLog ${RUN}"`, JSON.stringify(rows));

  // L3: toggle pagato -> 'paga' con stato post-toggle
  await api({ action: "toggle_paid", id: String(c1), location_id: "21" });
  await sleep(500);
  rows = await fresh();
  check("L3 toggle loggato: 'Costo #id segnato pagato' (azione paga)", rows.length === 2 && rows[1].action === "paga" && rows[1].label === `Costo #${c1} segnato pagato`, JSON.stringify(rows[1] ?? null));

  // L4: categoria crea + toggle disattiva
  const cs = await api({ action: "save_category", id: "0", name: `ZZ CatLog ${RUN}`, color: "#ff8800", is_active: "1" });
  catId = Number((await q1("SELECT id FROM cost_categories WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ CatLog ${RUN}`]))?.id ?? 0);
  await api({ action: "toggle_category", id: String(catId) });
  await sleep(500);
  rows = await fresh();
  check("L4 categoria: crea + toggle disattiva loggati", cs.j?.ok !== false && rows.length === 4 && rows[2].label === `Creata categoria costi "ZZ CatLog ${RUN}"` && rows[3].action === "disattiva" && rows[3].label === `Categoria costi #${catId} disattivata`, JSON.stringify(rows.slice(2).map((r) => `${r.action}:${r.label}`)));

  // L5: delete costo + delete categoria
  await api({ action: "delete", id: String(c1), location_id: "21" });
  await api({ action: "delete_category", id: String(catId) });
  await sleep(500);
  rows = await fresh();
  check("L5 delete costo+categoria loggati", rows.length === 6 && rows[4].label === `Eliminato costo #${c1}` && rows[5].label === `Eliminata categoria costi #${catId}`, JSON.stringify(rows.slice(4).map((r) => r.label)));
  if (rows.length === 6) { costIds.length = 0; catId = 0; }
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of costIds) await q("DELETE FROM costs WHERE tenant_id=$1 AND id=$2 AND title LIKE 'ZZ%'", [T, id]).catch(() => {});
  if (catId) await q("DELETE FROM cost_categories WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'", [T, catId]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM costs WHERE tenant_id=$1 AND title LIKE 'ZZ%')::int c,(SELECT COUNT(*) FROM cost_categories WHERE tenant_id=$1 AND name LIKE 'ZZ%')::int k,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.c === 0 && fin.k === 0 && fin.l === 0;
  console.log(`CLEANUP: costi=${fin.c} cat=${fin.k} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
