// Quick Booking pass 4 (2026-07-18) — FIX classe TZ server-safe nella catena
// save: promotion_redemptions.redeemed_at (create+edit), giftbox_redemptions/
// giftbox_instances redeemed_at, gift_transactions created_at, used_at
// pacchetti — tutti Date-al-driver (wall del SERVER: UTC su Amplify) -> ora di
// Roma esplicita. Verifica live sul path PROMO (create + edit rinfrescano la
// redemption con timestamp Roma); gli altri percorsi = stessa classe one-line,
// coperti dalla batteria di regressione.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["calendar.view", "appointments.manage", "appointments.quick_booking", "promotions.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body) {
  const res = await fetch(`${BASE}${path}?slug=${SLUG}`, { method: body ? "POST" : "GET", headers: { cookie, "x-tenant-slug": SLUG, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const wallMs = (s) => new Date(String(s).replace(" ", "T")).getTime();
const diffMin = (s) => Math.abs(wallMs(s) - romeNowMs()) / 60000;

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const basePromos = Number((await q1("SELECT COUNT(*) n FROM promotions WHERE tenant_id=$1", [T]))?.n ?? 0);
let cid = 0, promoId = 0, apptId = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ QB4 ${RUN}`, `zz.qb4.${RUN}@example.com`, LOC])).rows[0].id);

  // Promo attiva 10% su tutti i servizi via API (motore-valida garantita)
  const ps = await api("/api/manage/promotions", { action: "save", title: `ZZ QB4Promo${RUN}`, apply_services_mode: "all", discount_type: "percent", discount_value: "10", target_type: "all", location_ids_json: JSON.stringify([21]), starts_at: "2027-06-01", ends_at: "2027-06-30" });
  promoId = Number(ps.j?.promotion?.id ?? ps.j?.id ?? 0);
  // L'attivazione è un action=toggle SEPARATO (il save crea disattiva).
  const tg = await api("/api/manage/promotions", { action: "toggle", id: String(promoId), active: "1" });
  check("PRE promo attiva creata", ps.j?.ok === true && promoId > 0 && tg.j?.ok === true, JSON.stringify({ ok: ps.j?.ok, id: promoId, t: tg.j?.ok, e: ps.j?.error ?? tg.j?.error }));

  // P1: CREATE con auto-promo -> redemption con redeemed_at in ORA DI ROMA
  const s1 = await api("/api/manage/appointments", { action: "save", client_id: String(cid), client_name: `ZZ QB4 ${RUN}`, service_ids: JSON.stringify([9]), date: "2027-06-15", time: "10:00", status: "scheduled", location_id: "21" });
  apptId = Number(s1.j?.appointment?.id ?? 0);
  const red1 = await q1("SELECT redeemed_at::text ra, discount_amount, promotion_id FROM promotion_redemptions WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]);
  check("P1 create: promo applicata (redemption presente, sconto 1.20 su 12)", s1.j?.ok === true && apptId > 0 && Number(red1?.promotion_id) === promoId && Number(red1?.discount_amount) === 1.2, JSON.stringify({ ok: s1.j?.ok, appt: apptId, red: red1 }));
  check("P1b redeemed_at in ora di ROMA (±5min; pre-fix wall del server)", !!red1 && diffMin(red1.ra) < 5, JSON.stringify({ ra: red1?.ra, d: red1 ? Math.round(diffMin(red1.ra)) : null }));

  // P2: EDIT (cambio orario) -> redemption RINFRESCATA, ancora Roma
  await new Promise((r) => setTimeout(r, 1300));
  const s2 = await api("/api/manage/appointments", { action: "save", id: String(apptId), client_id: String(cid), client_name: `ZZ QB4 ${RUN}`, service_ids: JSON.stringify([9]), date: "2027-06-15", time: "11:00", location_id: "21" });
  const red2 = await q1("SELECT redeemed_at::text ra FROM promotion_redemptions WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]);
  const st2 = await q1("SELECT starts_at::text s, promotion_id FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]);
  check("P2 edit: orario aggiornato, redemption rinfrescata con Roma (±5min)", s2.j?.ok === true && String(st2?.s).startsWith("2027-06-15 11:00") && Number(st2?.promotion_id) === promoId && !!red2 && diffMin(red2.ra) < 5 && red2.ra !== red1?.ra, JSON.stringify({ s: st2?.s, ra: red2?.ra }));

  // P3: prezzo scontato nello snapshot servizi (10.80 con list 12)
  const svc = await q1("SELECT price, list_price FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]);
  check("P3 snapshot servizio: price 10.80 / list_price 12.00", Number(svc?.price) === 10.8 && Number(svc?.list_price) === 12, JSON.stringify(svc));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) {
    for (const t of ["promotion_redemptions", "appointment_services", "appointment_staff", "appointment_locations", "appointment_segments", "reminders"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [T, apptId]).catch(() => {});
    }
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  if (promoId) {
    await q("DELETE FROM promotion_locations WHERE tenant_id=$1 AND promotion_id=$2", [T, promoId]).catch(() => {});
    await q("DELETE FROM promotions WHERE tenant_id=$1 AND id=$2", [T, promoId]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM promotions WHERE tenant_id=$1)::int p,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.a === 10 && fin.c === 5 && fin.p === basePromos && fin.l === 0;
  console.log(`CLEANUP: appts=${fin.a}/10 clients=${fin.c}/5 promos=${fin.p}/${basePromos} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
