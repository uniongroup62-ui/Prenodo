// Ricariche migliorie 2026-07-17: log attività su crea/modifica/elimina modello
// (module 'ricariche') + verbo compat 'save' + nessun log su azione fallita.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["fidelity.recharges", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body) {
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { cookie, "x-tenant-slug": SLUG, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let tplIds = [];
try {
  // crea + modifica + elimina via API
  const c1 = await api(`/api/manage/recharges?slug=${SLUG}`, { action: "create_template", title: `ZZ RicLog${RUN}`, base_amount: "50", bonus_kind: "none", bonus_value: "0", earn_points: "1", is_active: "1" });
  const tpl = (c1.j?.templates || []).find((t) => t.title === `ZZ RicLog${RUN}`);
  const tplId = Number(tpl?.id ?? 0); if (tplId) tplIds.push(tplId);
  check("S1 create ok", c1.j?.ok === true && tplId > 0, JSON.stringify(c1.j?.error ?? ""));
  const c2 = await api(`/api/manage/recharges?slug=${SLUG}`, { action: "update_template", template_id: tplId, title: `ZZ RicLog${RUN} bis`, base_amount: "60", bonus_kind: "fixed", bonus_value: "10", earn_points: "1", is_active: "1" });
  check("S2 update ok", c2.j?.ok === true, JSON.stringify(c2.j?.error ?? ""));
  // compat 'save' senza id -> crea
  const c3 = await api(`/api/manage/recharges?slug=${SLUG}`, { action: "save", title: `ZZ RicLog${RUN} compat`, base_amount: "30", bonus_kind: "none", bonus_value: "0", is_active: "1" });
  const tpl2 = (c3.j?.templates || []).find((t) => t.title === `ZZ RicLog${RUN} compat`);
  if (tpl2?.id) tplIds.push(Number(tpl2.id));
  check("S3 compat save (create) ok", c3.j?.ok === true && Number(tpl2?.id ?? 0) > 0, JSON.stringify(c3.j?.error ?? ""));
  // azione FALLITA (titolo vuoto) -> nessun log
  await api(`/api/manage/recharges?slug=${SLUG}`, { action: "create_template", title: "", base_amount: "50" });
  const d1 = await api(`/api/manage/recharges?slug=${SLUG}`, { action: "delete_template", template_id: tplId });
  check("S4 delete ok", d1.j?.ok === true, JSON.stringify(d1.j?.error ?? ""));

  await new Promise((r) => setTimeout(r, 800));
  const logs = (await q("SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND module='ricariche' AND label LIKE $2 ORDER BY id ASC", [T, `%ZZ RicLog${RUN}%`])).rows;
  const dele = (await q("SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND module='ricariche' AND action='elimina' AND entity_id=$2", [T, tplId])).rows;
  check("L1 log: creato modello", logs.some((r) => r.action === "crea" && r.label === `Creato modello ricarica "ZZ RicLog${RUN}"`), JSON.stringify(logs.map((r) => r.label)));
  check("L2 log: modificato modello con #id", logs.some((r) => r.action === "modifica" && r.label === `Modificato modello ricarica "ZZ RicLog${RUN} bis" (#${tplId})`), "");
  check("L3 log: compat save -> crea", logs.some((r) => r.action === "crea" && /compat/.test(r.label)), "");
  check("L4 log: eliminato modello", dele.length === 1 && dele[0].label === `Eliminato modello ricarica #${tplId}`, JSON.stringify(dele));
  const failedLog = (await q("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND module='ricariche' AND label LIKE '%\"\"%'", [T])).rows[0];
  check("L5 nessun log dall'azione fallita (titolo vuoto)", Number(failedLog.n) === 0, `n=${failedLog.n}`);
  const lg = await api(`/api/manage/logs?slug=${SLUG}&module=ricariche`);
  check("L6 pagina Log: righe module=ricariche", (lg.j.rows || []).some((r) => r.module === "ricariche"), `n=${(lg.j.rows || []).length}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of tplIds) await q("DELETE FROM recharge_templates WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='ricariche' AND (label LIKE $2 OR entity_id = ANY($3::int[]))", [T, `%ZZ RicLog${RUN}%`, tplIds.length ? tplIds : [0]]).catch(() => {});
  const left = Number((await q1("SELECT COUNT(*) n FROM recharge_templates WHERE tenant_id=$1 AND title LIKE $2", [T, `ZZ RicLog${RUN}%`])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
