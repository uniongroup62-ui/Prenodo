// Appuntamenti pass 2 (2026-07-18) — FIX: (1) cascata delete ATOMICA (parità
// col beginTransaction legacy 9688: figli + link QB + release promo + riga in
// una tx); (2) classe TZ server-safe: cancelled_at del cancel_done e
// created_at dello storno giftcard al delete -> ora di Roma esplicita.
// + riverifica: guardia 'solo da Annullato', bulk contatori, log delete.
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
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const diffMin = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeNowMs()) / 60000;

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let cid = 0, a1 = 0, a2 = 0, aGc = 0, gcId = 0;
const gcTx = [];
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ Appt2 ${RUN}`, `zz.appt2.${RUN}@example.com`, LOC])).rows[0].id);

  // A1: create via API (figli popolati), poi cancel_done -> cancelled_at ROMA
  const s1 = await api({ action: "save", client_id: String(cid), client_name: `ZZ Appt2 ${RUN}`, service_ids: JSON.stringify([9]), date: "2027-07-13", time: "10:00", status: "scheduled", location_id: "21" });
  a1 = Number(s1.j?.appointment?.id ?? 0);
  const c1 = await api({ action: "cancel_done", id: String(a1), target_status: "canceled", reason: `ZZ motivo ${RUN}` });
  const row1 = await q1("SELECT status, cancelled_at::text ca, cancelled_reason, cancelled_by FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a1]);
  check("A1 cancel_done: canceled + cancelled_at in ORA DI ROMA (±5min) + reason/by", c1.j?.ok === true && row1?.status === "canceled" && diffMin(row1?.ca) < 5 && row1?.cancelled_reason === `ZZ motivo ${RUN}` && Number(row1?.cancelled_by) === 20, JSON.stringify({ ok: c1.j?.ok, e: c1.j?.error, row: row1, d: row1 ? Math.round(diffMin(row1.ca)) : null }));

  // A2: guardia delete 'solo da Annullato' (verbatim) su uno scheduled
  const s2 = await api({ action: "save", client_id: String(cid), client_name: `ZZ Appt2 ${RUN}`, service_ids: JSON.stringify([9]), date: "2027-07-14", time: "10:00", status: "scheduled", location_id: "21" });
  a2 = Number(s2.j?.appointment?.id ?? 0);
  const d0 = await api({ action: "delete", id: String(a2) });
  check("A2 delete di scheduled -> guardia verbatim", d0.j?.ok === false && String(d0.j?.error ?? "") === "La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.", JSON.stringify(d0.j?.error));

  // A3: delete del canceled -> CASCATA ATOMICA: riga + figli + reminders spariti, log
  const kidsBefore = await q1(`SELECT (SELECT COUNT(*) FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2)::int s,(SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2)::int g`, [T, a1]);
  const d1 = await api({ action: "delete", id: String(a1) });
  const after = await q1(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$2)::int a,
    (SELECT COUNT(*) FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2)::int s,
    (SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2)::int g,
    (SELECT COUNT(*) FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2)::int st,
    (SELECT COUNT(*) FROM appointment_locations WHERE tenant_id=$1 AND appointment_id=$2)::int l,
    (SELECT COUNT(*) FROM reminders WHERE tenant_id=$1 AND appointment_id=$2)::int r`, [T, a1]);
  check("A3 delete canceled: cascata completa (riga+figli+reminders a 0; figli presenti prima)", d1.j?.ok === true && d1.j?.deleted === 1 && kidsBefore.s >= 1 && after.a === 0 && after.s === 0 && after.g === 0 && after.st === 0 && after.l === 0 && after.r === 0, JSON.stringify({ ok: d1.j?.ok, kidsBefore, after }));
  if (after.a === 0) a1 = 0;
  await sleep(500);
  const lg = (await q("SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND id>$2 AND action='elimina'", [T, logWatermark])).rows;
  check("A3b delete loggato", lg.length === 1 && lg[0].label.startsWith("Eliminato appuntamento #"), JSON.stringify(lg));

  // A4: storno GIFTCARD al delete (dati stile-migrato: canceled con giftcard_used>0)
  gcId = Number((await q("INSERT INTO giftcards (tenant_id, code, status, initial_amount, balance, issued_at) VALUES ($1,$2,'active',100,40,NOW()) RETURNING id", [T, `ZZGC${RUN}`])).rows[0].id);
  aGc = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, giftcard_id, giftcard_used, public_code) VALUES ($1,$2,$3,'2027-07-15 10:00','2027-07-15 11:00','canceled',$4,25,$5) RETURNING id", [T, cid, LOC, gcId, `ZZA2${RUN}`])).rows[0].id);
  const d2 = await api({ action: "delete", id: String(aGc) });
  const gc = await q1("SELECT balance FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcId]);
  const tx = await q1("SELECT id, type, amount, note, created_at::text c FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2 ORDER BY id DESC LIMIT 1", [T, gcId]);
  if (tx?.id) gcTx.push(Number(tx.id));
  check("A4 delete con giftcard: rimborso 40+25=65, movimento type=topup 'Storno eliminazione appuntamento'", d2.j?.ok === true && Number(gc?.balance) === 65 && tx?.type === "topup" && Number(tx?.amount) === 25 && tx?.note === "Storno eliminazione appuntamento", JSON.stringify({ ok: d2.j?.ok, gc, tx }));
  check("A4b created_at storno in ORA DI ROMA (±5min)", !!tx && diffMin(tx.c) < 5, JSON.stringify({ c: tx?.c, d: tx ? Math.round(diffMin(tx.c)) : null }));
  if (d2.j?.ok) aGc = 0;

  // A5: bulk_delete contatori (a2 scheduled -> blockedNotCanceled; id inesistente -> unavailable... nel bulk l'access guard conta 'unavailable')
  const b1 = await api({ action: "bulk_delete", ids: `${a2},999999` });
  check("A5 bulk: 0 eliminati, 1 non-annullato, 1 non disponibile", b1.j?.ok === true && b1.j?.deleted === 0 && b1.j?.blockedNotCanceled === 1 && b1.j?.blockedUnavailable === 1, JSON.stringify({ d: b1.j?.deleted, n: b1.j?.blockedNotCanceled, u: b1.j?.blockedUnavailable }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of [a1, a2, aGc].filter(Boolean)) {
    for (const t of ["promotion_redemptions", "appointment_services", "appointment_staff", "appointment_locations", "appointment_segments", "reminders"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [T, id]).catch(() => {});
    }
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  }
  for (const id of gcTx) await q("DELETE FROM giftcard_transactions WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  if (gcId) await q("DELETE FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND code LIKE 'ZZGC%')::int g,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.a === 10 && fin.c === 5 && fin.g === 0 && fin.l === 0;
  console.log(`CLEANUP: appts=${fin.a}/10 clients=${fin.c}/5 gc=${fin.g} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
