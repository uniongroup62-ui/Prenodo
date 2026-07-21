// Booking pass 2 (2026-07-17) — FIX TZ server-safe: scadenze hold in ora di
// Roma (erano confrontate con NOW() UTC: slot BLOCCATI 2h oltre la scadenza e
// hold scaduti accettati al confirm), cutoff "oggi/adesso" Rome-based,
// todayIso condiviso non piu' UTC. + riverifica flusso: slot in orario, hold,
// janitor, confirm completo (cliente per email case-insensitive, righe
// servizio/staff/sede/segmenti, hold converted), doppia prenotazione rifiutata.
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21, SVC = 9, STAFF = 22;
const DATE = "2027-05-05"; // mercoledi', orario 09-19

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function apiGet(params) {
  const res = await fetch(`${BASE}/api/booking?slug=${SLUG}&${params}`);
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function apiPost(body) {
  const res = await fetch(`${BASE}/api/booking?slug=${SLUG}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const rome = (deltaSec = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(Date.now() + deltaSec * 1000)).replace("T", " ");
const OWNER = `zzbook-${RUN}`;

let apptId = 0, cid = 0;
const holdTokens = [];
async function seedHold(startHHMM, endHHMM, expiresAt, token) {
  await q(`INSERT INTO appointment_holds (tenant_id, token, channel, owner_key, location_id, starts_at, ends_at, service_ids_json, staff_ids_json, cabin_ids_json, segments_json, resource_blocks_json, status, expires_at)
    VALUES ($1,$2,'public',$3,$4,$5,$6,$7,$8,$9,'[]','[]','active',$10)`,
    [T, token, OWNER, LOC, `${DATE} ${startHHMM}:00`, `${DATE} ${endHHMM}:00`, JSON.stringify([SVC]), JSON.stringify([STAFF]), JSON.stringify([9]), expiresAt]);
  holdTokens.push(token);
}
try {
  // Fixture cliente esistente con email in case misto (match LOWER al confirm)
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ Book ${RUN}`, `ZZ.Book.${RUN}@Example.com`, LOC])).rows[0].id);
  const baseClients = Number((await q1("SELECT COUNT(*) n FROM clients WHERE tenant_id=$1", [T]))?.n);

  // S1: slot del giorno futuro dentro l'orario (09:00-18:00 per 60')
  const s1 = await apiGet(`action=slots&date=${DATE}&service_ids=${SVC}&location_id=${LOC}`);
  const avail = (s1.j?.slots ?? []).filter((s) => s.available).map((s) => s.time);
  check("S1 slot futuri disponibili dentro l'orario (>=09:00, <=18:00)", avail.length > 0 && avail.every((t) => t >= "09:00" && t <= "18:00"), JSON.stringify({ n: avail.length, first: avail[0], last: avail[avail.length - 1] }));

  // S2: cutoff OGGI in ora di Roma (nessuno slot nel passato locale)
  const todayRome = rome().slice(0, 10);
  const nowHHMM = rome().slice(11, 16);
  const s2 = await apiGet(`action=slots&date=${todayRome}&service_ids=${SVC}&location_id=${LOC}`);
  const availToday = (s2.j?.slots ?? []).filter((s) => s.available).map((s) => s.time);
  check("S2 cutoff oggi: nessuno slot prima dell'adesso di Roma", availToday.every((t) => t >= nowHHMM), JSON.stringify({ nowHHMM, first: availToday[0] ?? null, n: availToday.length }));

  // H2 (FIX): hold SCADUTO (Roma -60s) NON blocca lo slot; hold ATTIVO sì
  await seedHold("10:00", "11:00", rome(-60), `zzexp-${RUN}`);
  await seedHold("11:00", "12:00", rome(300), `zzact-${RUN}`);
  const h2 = await apiGet(`action=slots&date=${DATE}&service_ids=${SVC}&location_id=${LOC}`);
  const h2avail = (h2.j?.slots ?? []).filter((s) => s.available).map((s) => s.time);
  check("H2 hold SCADUTO non blocca (10:00 libero), hold ATTIVO blocca (11:00 occupato)", h2avail.includes("10:00") && !h2avail.includes("11:00"), JSON.stringify({ ten: h2avail.includes("10:00"), eleven: h2avail.includes("11:00") }));

  // H1: hold reale via API -> expires_at in ORA DI ROMA (+150s), non UTC
  const h1 = await apiPost({ action: "hold", date: DATE, time: "10:00", service_ids: String(SVC), location_id: String(LOC), owner_key: OWNER });
  const tok = String(h1.j?.hold?.token ?? "");
  if (tok) holdTokens.push(tok);
  const hrow = await q1("SELECT expires_at::text ea, status FROM appointment_holds WHERE tenant_id=$1 AND token=$2", [T, tok]);
  const expExpect = rome(150).slice(0, 15); // confronto al minuto (tolleranza sotto)
  const eaOk = hrow && Math.abs(Date.parse(String(hrow.ea).replace(" ", "T")) - Date.parse(rome(150).replace(" ", "T"))) < 90000;
  check("H1 hold API: expires_at = adesso-Roma +150s (mai wall UTC)", h1.j?.ok === true && eaOk, JSON.stringify({ ea: hrow?.ea, expExpect }));

  // H3: il janitor (girato con l'hold) ha marcato 'expired' il seed scaduto
  const jrow = await q1("SELECT status FROM appointment_holds WHERE tenant_id=$1 AND token=$2", [T, `zzexp-${RUN}`]);
  check("H3 janitor: hold scaduto marcato 'expired' (mai delete)", jrow?.status === "expired", JSON.stringify(jrow));

  // H4 (FIX): confirm con hold SCADUTO -> rifiutato
  await seedHold("15:00", "16:00", rome(-30), `zzexp2-${RUN}`);
  const h4 = await apiPost({ action: "confirm", privacy_accepted: "1", date: DATE, time: "15:00", service_ids: String(SVC), location_id: String(LOC), owner_key: OWNER, hold_token: `zzexp2-${RUN}`, client_name: "ZZ Book", client_email: `zz.book.${RUN}@example.com` });
  check("H4 confirm con hold scaduto -> 'Riserva non disponibile o scaduta.'", h4.j?.ok !== true && err(h4) === "Riserva non disponibile o scaduta.", JSON.stringify(err(h4)));

  // C1: confirm con hold valido -> appuntamento pending completo + cliente ESISTENTE riusato (email case-insensitive)
  // staff_id esplicito: nel legacy la riga appointment_staff nasce SOLO con
  // operatore scelto (any-staff = nessuna riga, fedele nel port).
  const c1 = await apiPost({ action: "confirm", privacy_accepted: "1", date: DATE, time: "10:00", service_ids: String(SVC), staff_id: String(STAFF), location_id: String(LOC), owner_key: OWNER, hold_token: tok, client_name: `ZZ Book ${RUN}`, client_email: `zz.book.${RUN}@example.com` });
  apptId = Number(c1.j?.confirmation?.id ?? c1.j?.id ?? 0);
  if (!apptId) apptId = Number((await q1("SELECT id FROM appointments WHERE tenant_id=$1 AND client_id=$2 AND starts_at=$3", [T, cid, `${DATE} 10:00:00`]))?.id ?? 0);
  const arow = await q1("SELECT status, client_id, location_id FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]);
  const rel = await q1(`SELECT (SELECT COUNT(*) FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2)::int svc,
    (SELECT COUNT(*) FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2 AND staff_id=$3)::int st,
    (SELECT COUNT(*) FROM appointment_locations WHERE tenant_id=$1 AND appointment_id=$2 AND location_id=$4)::int loc,
    (SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2)::int seg`, [T, apptId, STAFF, LOC]);
  const clientsNow = Number((await q1("SELECT COUNT(*) n FROM clients WHERE tenant_id=$1", [T]))?.n);
  const holdRow = await q1("SELECT status FROM appointment_holds WHERE tenant_id=$1 AND token=$2", [T, tok]);
  check("C1 confirm: pending + cliente riusato per email (case-insensitive, no duplicato)", apptId > 0 && arow?.status === "pending" && Number(arow.client_id) === cid && Number(arow.location_id) === LOC && clientsNow === baseClients, JSON.stringify({ arow, clientsNow, baseClients }));
  check("C1b righe collegate: servizio+staff+sede+segmento, hold 'converted'", rel.svc === 1 && rel.st === 1 && rel.loc === 1 && rel.seg === 1 && holdRow?.status === "converted", JSON.stringify({ rel, hold: holdRow?.status }));

  // C2: doppia prenotazione stesso slot -> rifiutata
  const c2 = await apiPost({ action: "confirm", privacy_accepted: "1", date: DATE, time: "10:00", service_ids: String(SVC), location_id: String(LOC), owner_key: `${OWNER}-b`, client_name: "ZZ Book Due", client_email: `zz.book2.${RUN}@example.com` });
  check("C2 doppia prenotazione stesso slot -> 'Orario non disponibile.'", c2.j?.ok !== true && err(c2) === "Orario non disponibile.", JSON.stringify(err(c2)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) {
    for (const t of ["appointment_services", "appointment_staff", "appointment_locations", "appointment_segments"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [T, apptId]).catch(() => {});
    }
    await q("DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  for (const t of holdTokens) await q("DELETE FROM appointment_holds WHERE tenant_id=$1 AND token=$2", [T, t]).catch(() => {});
  await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ Book%'", [T, cid]).catch(() => {});
  await q("DELETE FROM clients WHERE tenant_id=$1 AND full_name='ZZ Book Due' AND email LIKE 'zz.book2.%'", [T]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointment_holds WHERE tenant_id=$1 AND owner_key LIKE 'zzbook%')::int h,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND starts_at::date='2027-05-05')::int a", [T]);
  const okBase = fin.h === 0 && fin.c === 5 && fin.a === 0;
  console.log(`CLEANUP: holds=${fin.h} clients=${fin.c}/5 appt2027=${fin.a} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
