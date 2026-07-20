// QB — miglioria log attività (2026-07-18): swap_segment e fidelity_gift_redeem
// loggano (modulo appuntamenti, azione modifica) DOPO il successo; guardie
// respinte senza voce. + verifica replace strutturale ATOMICO dell'edit
// (multi-servizio: figli coerenti dopo l'edit via nuova transazione).
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["calendar.view", "appointments.manage", "appointments.quick_booking"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/appointments?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const freshLogs = () => q("SELECT module, action, entity_id, label FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, logWatermark]);
let cid = 0, apptId = 0, giftId = 0, instId = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ QBLog ${RUN}`, `zz.qblog.${RUN}@example.com`, LOC])).rows[0].id);

  // Appuntamento MULTI-servizio (9 + 82) via API save -> 2 segmenti (esercita il
  // nuovo replace strutturale transazionale sull'EDIT sotto).
  const s1 = await api({ action: "save", client_id: String(cid), client_name: `ZZ QBLog ${RUN}`, service_ids: JSON.stringify([9, 82]), date: "2027-07-06", time: "10:00", status: "scheduled", location_id: "21" });
  apptId = Number(s1.j?.appointment?.id ?? 0);
  const segs0 = (await q("SELECT id, service_id, position FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY position", [T, apptId])).rows;
  check("PRE save multi: 2 segmenti (9,82)", s1.j?.ok === true && apptId > 0 && segs0.length === 2 && Number(segs0[0].service_id) === 9, JSON.stringify({ ok: s1.j?.ok, e: s1.j?.error, segs: segs0 }));

  // T1: EDIT (cambio orario) -> figli coerenti post-transazione
  const e1 = await api({ action: "save", id: String(apptId), client_id: String(cid), client_name: `ZZ QBLog ${RUN}`, service_ids: JSON.stringify([9, 82]), date: "2027-07-06", time: "11:00", location_id: "21" });
  const kids = await q1(`SELECT (SELECT COUNT(*) FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2)::int s,
    (SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2)::int g,
    (SELECT COUNT(*) FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2)::int st,
    (SELECT COUNT(*) FROM appointment_locations WHERE tenant_id=$1 AND appointment_id=$2)::int l,
    (SELECT starts_at::text FROM appointments WHERE tenant_id=$1 AND id=$2) sa`, [T, apptId]);
  check("T1 edit multi: riga + figli coerenti (2 services, 2 segmenti, staff>0, 1 location, 11:00)", e1.j?.ok === true && kids.s === 2 && kids.g === 2 && kids.st >= 1 && kids.l === 1 && String(kids.sa).startsWith("2027-07-06 11:00"), JSON.stringify({ e: e1.j?.error, kids }));

  // Watermark locale POST-edit: il save di T1 logga 'Modificato appuntamento'
  // (corretto) — i conteggi L* partono da qui.
  await sleep(400);
  const wm2 = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
  const fresh2 = async () => (await q("SELECT module, action, entity_id, label FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, wm2])).rows;

  // L1: swap guardia respinta (direzione invalida) -> nessuna voce
  await api({ action: "swap_segment", id: String(apptId), segment_id: "1", direction: "sideways" });
  await sleep(400);
  check("L1 swap respinto -> nessuna voce", (await fresh2()).length === 0, "");

  // L2: swap ok -> 'Riordinati servizi appuntamento #id'
  const segId = Number((await q("SELECT id FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2 AND position=0", [T, apptId])).rows[0].id);
  const sw = await api({ action: "swap_segment", id: String(apptId), segment_id: String(segId), direction: "down" });
  await sleep(500);
  let rows = await fresh2();
  const segsAfter = (await q("SELECT service_id FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY position", [T, apptId])).rows.map((r) => Number(r.service_id));
  check("L2 swap loggato + ordine invertito (82,9)", sw.j?.ok === true && rows.length === 1 && rows[0].label === `Riordinati servizi appuntamento #${apptId}` && JSON.stringify(segsAfter) === "[82,9]", JSON.stringify({ ok: sw.j?.ok, e: sw.j?.error, rows: rows.map((r) => r.label), segsAfter }));

  // L3: gift redeem — istanza disponibile del cliente, riscatto su appuntamento
  giftId = Number((await q("INSERT INTO gifts (tenant_id, name, eligibility, reward_type, reward_service_id, reward_items_json, active, valid_from, valid_to, sort_order) VALUES ($1,'ZZ GiftLog','all_clients','service',9,$2,1,NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',0) RETURNING id", [T, JSON.stringify([{ type: "service", service_id: 9, qty: 1 }])])).rows[0].id);
  instId = Number((await q("INSERT INTO gift_instances (tenant_id, gift_id, client_id, state, is_active) VALUES ($1,$2,$3,'disponibile',1) RETURNING id", [T, giftId, cid])).rows[0].id);
  const gr = await api({ action: "fidelity_gift_redeem", client_id: String(cid), appointment_id: String(apptId), gift_idx: String(instId) });
  await sleep(500);
  rows = await fresh2();
  check("L3 gift redeem loggato: 'Registrato omaggio su appuntamento #id'", gr.j?.ok === true && rows.length === 2 && rows[1].label === `Registrato omaggio su appuntamento #${apptId}`, JSON.stringify({ ok: gr.j?.ok, e: gr.j?.error, rows: rows.map((r) => r.label) }));

  // L4: gift redeem respinto (cliente incoerente) -> nessuna voce nuova
  await api({ action: "fidelity_gift_redeem", client_id: "9", appointment_id: String(apptId) });
  await sleep(400);
  rows = await fresh2();
  check("L4 gift redeem respinto -> nessuna voce nuova", rows.length === 2, String(rows.length));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) {
    for (const t of ["appointment_gift_items", "gift_transactions", "promotion_redemptions", "appointment_services", "appointment_staff", "appointment_locations", "appointment_segments", "reminders"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [T, apptId]).catch(() => {});
    }
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  if (instId) {
    await q("DELETE FROM gift_transactions WHERE tenant_id=$1 AND instance_id=$2", [T, instId]).catch(() => {});
    await q("DELETE FROM gift_instances WHERE tenant_id=$1 AND id=$2", [T, instId]).catch(() => {});
  }
  if (giftId) await q("DELETE FROM gifts WHERE tenant_id=$1 AND id=$2", [T, giftId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM gifts WHERE tenant_id=$1 AND name='ZZ GiftLog')::int g,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.a === 10 && fin.c === 5 && fin.g === 0 && fin.l === 0;
  console.log(`CLEANUP: appts=${fin.a}/10 clients=${fin.c}/5 gifts=${fin.g} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
