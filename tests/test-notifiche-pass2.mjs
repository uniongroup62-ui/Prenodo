// Notifiche pass 2 (2026-07-17) — FIX TZ server-safe (timeoff 'assente ora',
// oggi-compleanni, seed feed). + riverifica: pending list sede-scoped, guardie
// approva/annulla (permesso, bridge sede, pending-only coi sinonimi), approve
// con doppia guardia + rischedulazione promemoria, cancel via lifecycle, feed.
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
const fullCookie = makeCookie(["notifications.view", "appointments.manage", "fidelity.membership"]);
const viewOnlyCookie = makeCookie(["notifications.view"]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function apiGet(params, cookie = fullCookie) {
  const res = await fetch(`${BASE}/api/manage/notifications?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function apiPost(body, cookie = fullCookie) {
  const res = await fetch(`${BASE}/api/manage/notifications?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const rome = (dMin = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(Date.now() + dMin * 60000)).replace("T", " ");

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let cid = 0, a21 = 0, a51 = 0, aSched = 0, timeoffId = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ Notif ${RUN}`, `zz.notif.${RUN}@example.com`, LOC])).rows[0].id);
  a21 = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-10 10:00','2027-06-10 11:00','pending',$4) RETURNING id", [T, cid, LOC, `ZZN21${RUN}`])).rows[0].id);
  a51 = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,51,'2027-06-10 12:00','2027-06-10 13:00','pending',$3) RETURNING id", [T, cid, `ZZN51${RUN}`])).rows[0].id);
  aSched = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-11 10:00','2027-06-11 11:00','scheduled',$4) RETURNING id", [T, cid, LOC, `ZZNS${RUN}`])).rows[0].id);
  timeoffId = Number((await q("INSERT INTO staff_timeoff (tenant_id, staff_id, starts_at, ends_at, reason) VALUES ($1,22,$2,$3,'ZZ ferie') RETURNING id", [T, rome(-60), rome(60)])).rows[0].id);

  // P1: lista pending sede-scoped
  const p1 = await apiGet("&action=pending");
  const ids = (p1.j?.pending ?? []).map((a) => a.id);
  check("P1 pending: sede 21 visibile, sede 51 esclusa", ids.includes(a21) && !ids.includes(a51), JSON.stringify({ has21: ids.includes(a21), has51: ids.includes(a51) }));

  // A1: guardie approva
  const g1 = await apiPost({ action: "approve", id: String(a21) }, viewOnlyCookie);
  check("A1 senza appointments.manage -> 'Operazione non autorizzata'", g1.status === 403 && err(g1) === "Operazione non autorizzata", JSON.stringify(err(g1)));
  const g2 = await apiPost({ action: "approve", id: "999999" });
  check("A1b id inesistente -> 'Operazione non valida'", err(g2) === "Operazione non valida", JSON.stringify(err(g2)));
  const g3 = await apiPost({ action: "approve", id: String(a51) });
  check("A1c appuntamento di ALTRA sede -> 'Operazione non valida' (bridge guard)", err(g3) === "Operazione non valida", JSON.stringify(err(g3)));
  const g4 = await apiPost({ action: "approve", id: String(aSched) });
  check("A1d non-pending -> 'Appuntamento non piu in attesa' (senza accento)", err(g4) === "Appuntamento non piu in attesa", JSON.stringify(err(g4)));

  // A2: approve ok -> scheduled + promemoria rischedulato (email cliente presente)
  const a2 = await apiPost({ action: "approve", id: String(a21) });
  const st2 = await q1("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a21]);
  const rem = await q1("SELECT COUNT(*)::int n, MIN(scheduled_at)::text sa FROM reminders WHERE tenant_id=$1 AND appointment_id=$2 AND status='pending'", [T, a21]);
  check("A2 approve: 'Appuntamento approvato', status scheduled, promemoria pending a inizio-24h", a2.j?.ok === true && a2.j?.message === "Appuntamento approvato" && st2?.status === "scheduled" && rem.n >= 1 && String(rem.sa).startsWith("2027-06-09 10:00"), JSON.stringify({ m: a2.j?.message, st: st2?.status, rem }));

  // A3: doppio approve -> non piu in attesa
  const a3 = await apiPost({ action: "approve", id: String(a21) });
  check("A3 doppio approve -> 'Appuntamento non piu in attesa'", err(a3) === "Appuntamento non piu in attesa", JSON.stringify(err(a3)));

  // C1: cancel di un pending -> canceled via lifecycle + promemoria ripuliti
  const aP2 = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-12 10:00','2027-06-12 11:00','pending',$4) RETURNING id", [T, cid, LOC, `ZZNC${RUN}`])).rows[0].id);
  const c1 = await apiPost({ action: "cancel", id: String(aP2) });
  const stc = await q1("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2", [T, aP2]);
  const remC = Number((await q1("SELECT COUNT(*) n FROM reminders WHERE tenant_id=$1 AND appointment_id=$2 AND status='pending'", [T, aP2]))?.n);
  check("C1 cancel: 'Appuntamento annullato', status canceled, niente promemoria pending", c1.j?.ok === true && c1.j?.message === "Appuntamento annullato" && ["canceled", "cancelled"].includes(String(stc?.status)) && remC === 0, JSON.stringify({ m: c1.j?.message, st: stc?.status, remC }));
  await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, aP2]);

  // T1: count col timeoff attivo ADESSO (Roma) — la query non esplode e risponde
  const t1 = await apiGet("&action=count");
  check("T1 action=count ok con timeoff attivo-adesso (parametri TZ corretti)", t1.status === 200 && t1.j?.ok === true, JSON.stringify(Object.keys(t1.j ?? {}).slice(0, 6)));

  // F1: feed con evento appointment_pending del nostro appuntamento? (a21 ora
  // approvato: usa a51? fuori sede). Nuovo pending in sede per il feed.
  const aP3 = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code, created_at) VALUES ($1,$2,$3,'2027-06-13 10:00','2027-06-13 11:00','pending',$4,NOW()) RETURNING id", [T, cid, LOC, `ZZNF${RUN}`])).rows[0].id);
  const f1 = await apiGet("&action=feed&limit=30");
  const ev = (f1.j?.events ?? []).find((e) => e.type === "appointment_pending" && e.key.startsWith(`appointment_pending:${aP3}:`));
  check("F1 feed: evento appointment_pending con chiave seedata e body composto", Boolean(ev) && String(ev?.body ?? "").includes(`ZZ Notif ${RUN}`) && String(ev?.body ?? "").includes(`#ZZNF${RUN}`), JSON.stringify({ key: ev?.key, body: ev?.body }));
  await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, aP3]);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const a of [a21, a51, aSched]) if (a) {
    await q("DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id=$2", [T, a]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a]).catch(() => {});
  }
  await q("DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id NOT IN (SELECT id FROM appointments WHERE tenant_id=$1)", [T]).catch(() => {});
  if (timeoffId) await q("DELETE FROM staff_timeoff WHERE tenant_id=$1 AND id=$2", [T, timeoffId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id > $2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND public_code LIKE 'ZZN%')::int a,(SELECT COUNT(*) FROM reminders WHERE tenant_id=$1)::int r,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM staff_timeoff WHERE tenant_id=$1 AND reason='ZZ ferie')::int t", [T]);
  const okBase = fin.a === 0 && fin.r === 0 && fin.c === 5 && fin.t === 0;
  console.log(`CLEANUP: ${okBase ? "baseline OK" : "DIVERSA " + JSON.stringify(fin)} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
