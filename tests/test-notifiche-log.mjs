// Notifiche — miglioria log attività (2026-07-17): approve/cancel dalla route
// notifications ora loggano nel registro (modulo appuntamenti). Segnali DOPO
// il successo: le guardie respinte NON devono loggare.
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
function makeCookie(perms) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const fullCookie = makeCookie(["notifications.view", "appointments.manage"]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function apiPost(body) {
  const res = await fetch(`${BASE}/api/manage/notifications?slug=${SLUG}`, { method: "POST", headers: { cookie: fullCookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const freshLogs = () => q(`SELECT module, action, entity_type, entity_id, label, location_id FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id`, [T, logWatermark]);
let cid = 0, aApp = 0, aCan = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ NotifLog ${RUN}`, `zz.nlog.${RUN}@example.com`, LOC])).rows[0].id);
  aApp = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-15 10:00','2027-06-15 11:00','pending',$4) RETURNING id", [T, cid, LOC, `ZZLA${RUN}`])).rows[0].id);
  aCan = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-15 12:00','2027-06-15 13:00','pending',$4) RETURNING id", [T, cid, LOC, `ZZLC${RUN}`])).rows[0].id);

  // L1: guardia respinta (non-pending? no — id di altra sede? usiamo id inesistente) NON logga
  await apiPost({ action: "approve", id: "999999" });
  await sleep(400);
  let rows = (await freshLogs()).rows;
  check("L1 guardia respinta -> nessuna voce", rows.length === 0, JSON.stringify(rows));

  // L2: approve ok -> voce appuntamenti/modifica 'Approvata prenotazione #id'
  const a = await apiPost({ action: "approve", id: String(aApp) });
  await sleep(500);
  rows = (await freshLogs()).rows;
  const l2 = rows.find((r) => Number(r.entity_id) === aApp);
  check("L2 approve loggato: modulo appuntamenti, azione modifica, label verbatim, sede 21", a.j?.ok === true && rows.length === 1 && !!l2 && l2.module === "appuntamenti" && l2.action === "modifica" && l2.entity_type === "appointment" && l2.label === `Approvata prenotazione #${aApp}` && Number(l2.location_id) === LOC, JSON.stringify(rows));

  // L3: cancel ok -> voce appuntamenti/annulla 'Annullata prenotazione #id'
  const c = await apiPost({ action: "cancel", id: String(aCan) });
  await sleep(500);
  rows = (await freshLogs()).rows;
  const l3 = rows.find((r) => Number(r.entity_id) === aCan);
  check("L3 cancel loggato: azione annulla, label verbatim (voci totali 2 — nessun doppio log)", c.j?.ok === true && rows.length === 2 && !!l3 && l3.module === "appuntamenti" && l3.action === "annulla" && l3.label === `Annullata prenotazione #${aCan}`, JSON.stringify(rows.map((r) => r.label)));

  // L4: doppio approve respinto ('non piu in attesa') -> nessuna voce nuova
  await apiPost({ action: "approve", id: String(aApp) });
  await sleep(400);
  rows = (await freshLogs()).rows;
  check("L4 doppio approve respinto -> nessuna voce aggiuntiva", rows.length === 2, String(rows.length));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const a of [aApp, aCan].filter(Boolean)) {
    await q("DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id=$2", [T, a]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const appts = Number((await q1("SELECT COUNT(*) n FROM appointments WHERE tenant_id=$1 AND public_code LIKE 'ZZL%'", [T]))?.n);
  const logs = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]))?.n);
  console.log(`CLEANUP: appts=${appts} logs=${logs} -> ${appts === 0 && logs === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && appts === 0 && logs === 0 ? 0 : 1);
}
