// Promozioni migliorie 2026-07-17: log attività su crea/modifica/clona/toggle/
// elimina/condizioni/esclusioni (module 'promozioni'); nessun log su azione fallita.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["promotions.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, method = "POST") {
  const res = await fetch(`${BASE}/api/manage/promotions?slug=${SLUG}`, { method, headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let promoId = 0, cli = 0;
const SAVE = (over = {}) => ({ action: "save", title: `ZZ PromoLog${RUN}`, apply_services_mode: "all", discount_type: "percent", discount_value: "10", target_type: "all", location_ids_json: JSON.stringify([21]), active: "0", ...over });
try {
  cli = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ PrmLogCli${RUN}`])).rows[0].id);

  const s1 = await api(SAVE());
  promoId = Number(s1.j?.promotion?.id ?? 0);
  check("S1 create ok", s1.j?.ok === true && promoId > 0, JSON.stringify(s1.j?.error ?? ""));
  await api(SAVE({ id: promoId, title: `ZZ PromoLog${RUN} bis` }));
  await api({ action: "toggle", id: promoId, active: "0" });
  await api({ action: "conditions_update", promotion_id: promoId, promo_conditions_enabled: "1", promo_conditions: "zz condizioni" });
  await api({ action: "exclusion_add", promotion_id: promoId, client_id: cli });
  await api({ action: "exclusion_remove", promotion_id: promoId, client_id: cli });
  // azione FALLITA: save senza titolo -> nessun log
  await api(SAVE({ title: "" }));
  await api({ action: "delete", id: promoId });

  await new Promise((r) => setTimeout(r, 800));
  const logs = (await q("SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND module='promozioni' AND entity_id=$2 ORDER BY id ASC", [T, promoId])).rows;
  const has = (a, re) => logs.some((r) => r.action === a && re.test(String(r.label)));
  check("L1 log: creata", has("crea", new RegExp(`Creata promozione "ZZ PromoLog${RUN}"`)), JSON.stringify(logs.map((r) => r.action)));
  check("L2 log: modificata con #id", has("modifica", new RegExp(`Modificata promozione "ZZ PromoLog${RUN} bis" \\(#${promoId}\\)`)), "");
  check("L3 log: disattivata", has("disattiva", /disattivata/), "");
  check("L4 log: condizioni aggiornate", has("modifica", new RegExp(`Aggiornate condizioni promozionali #${promoId}`)), "");
  check("L5 log: cliente escluso + riammesso", has("modifica", new RegExp(`Cliente #${cli} escluso`)) && has("modifica", new RegExp(`Cliente #${cli} riammesso`)), JSON.stringify(logs.filter((r) => /Cliente #/.test(r.label)).map((r) => r.label)));
  check("L6 log: eliminata", has("elimina", new RegExp(`Eliminata promozione #${promoId}`)), "");
  const badLog = (await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND module='promozioni' AND label LIKE '%\"\"%'", [T]));
  check("L7 nessun log dal save fallito (titolo vuoto)", Number(badLog.n) === 0, `n=${badLog.n}`);
  const lg = await fetch(`${BASE}/api/manage/logs?slug=${SLUG}&module=promozioni`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("L8 pagina Log: righe module=promozioni", (lg.rows || []).some((r) => r.module === "promozioni"), `n=${(lg.rows || []).length}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (promoId) {
    for (const t of ["promotion_services", "promotion_products", "promotion_locations", "promotion_time_windows", "promotion_blackout_dates"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND promotion_id=$2`, [T, promoId]).catch(() => {});
    }
    await q("DELETE FROM promotions WHERE tenant_id=$1 AND id=$2", [T, promoId]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='promozioni' AND entity_id=$2", [T, promoId]).catch(() => {});
  }
  if (cli) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cli]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM promotions WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$3) n", [T, promoId || 0, cli || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
