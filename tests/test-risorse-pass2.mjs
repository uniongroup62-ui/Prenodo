// Risorse pass 2 (2026-07-17) — fix TZ del picco prenotazioni: 'futuro' in ora
// BUSINESS (Roma), non NOW() UTC del DB. Un appuntamento finito 1h fa (Roma)
// NON blocca più la riduzione (prima il confronto UTC lo contava come futuro
// per ~2h); uno che finisce tra 1h la blocca ancora.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21, SVC = 9;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["resources.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
// Ora business (Roma) come businessNowDateTime.
function romeNow(offsetMin = 0) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return f.format(d).replace("T", " ");
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let resId = 0, cid = 0; const apptIds = [];
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ RisP2 ${RUN}`])).rows[0].id);
  // Risorsa qty 2 in sede 21, collegata al servizio 9 con qty_required 1
  const s1 = await api({ action: "resource_save", id: "0", name: `ZZ RisP2 ${RUN}`, description: "", qty_total: "2", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 2 }]) });
  resId = Number(s1.j?.resource?.id ?? 0);
  check("S1 risorsa creata (qty 2)", s1.j?.ok === true && resId > 0, JSON.stringify(s1.j?.error ?? ""));
  await q("INSERT INTO service_resources (tenant_id, service_id, resource_id, qty_required) VALUES ($1,$2,$3,1)", [T, SVC, resId]);

  // Appuntamento FINITO 1h fa (Roma) col servizio 9
  const a1 = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5,'scheduled') RETURNING id", [T, cid, LOC, romeNow(-120), romeNow(-60)])).rows[0].id);
  apptIds.push(a1);
  await q("INSERT INTO appointment_services (tenant_id, appointment_id, service_id, service_name, qty, price) VALUES ($1,$2,$3,'test',1,12)", [T, a1, SVC]);

  // A1: riduzione a 1 — l'appuntamento PASSATO (Roma) non deve bloccare
  const r1 = await api({ action: "resource_save", id: String(resId), name: `ZZ RisP2 ${RUN}`, description: "", qty_total: "1", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 1 }]) });
  check("A1 fix TZ: appuntamento finito 1h fa (Roma) NON blocca la riduzione", r1.j?.ok === true, JSON.stringify(r1.j?.error ?? ""));

  // A2: due appuntamenti FUTURI sovrapposti (picco 2) -> riduzione a 1 bloccata col popup
  for (let i = 0; i < 2; i++) {
    const a = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5,'scheduled') RETURNING id", [T, cid, LOC, romeNow(60), romeNow(120)])).rows[0].id);
    apptIds.push(a);
    await q("INSERT INTO appointment_services (tenant_id, appointment_id, service_id, service_name, qty, price) VALUES ($1,$2,$3,'test',1,12)", [T, a, SVC]);
  }
  await api({ action: "resource_save", id: String(resId), name: `ZZ RisP2 ${RUN}`, description: "", qty_total: "2", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 2 }]) });
  const r2 = await api({ action: "resource_save", id: String(resId), name: `ZZ RisP2 ${RUN}`, description: "", qty_total: "1", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 1 }]) });
  check("A2 picco futuro 2 > 1: riduzione bloccata con popup (fino a 2 unità)", r2.j?.ok !== true && /prenotazioni esistenti oltre il nuovo limite/.test(String(r2.j?.error ?? "")) && /fino a 2 unita/.test(String(r2.j?.popup?.message ?? "")), JSON.stringify({ e: r2.j?.error, m: r2.j?.popup?.message }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const a of apptIds) {
    await q("DELETE FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2", [T, a]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a]).catch(() => {});
  }
  if (resId) {
    await q("DELETE FROM service_resources WHERE tenant_id=$1 AND resource_id=$2", [T, resId]).catch(() => {});
    await q("DELETE FROM resource_locations WHERE tenant_id=$1 AND resource_id=$2", [T, resId]).catch(() => {});
    await q("DELETE FROM resources WHERE tenant_id=$1 AND id=$2", [T, resId]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM resources WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$3)+(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id = ANY($4::int[])) n", [T, resId || 0, cid || 0, apptIds.length ? apptIds : [0]])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
