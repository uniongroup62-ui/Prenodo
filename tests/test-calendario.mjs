// E2E live CALENDARIO (pass 1): contesto (staff ordine naturale + colore ''
// + currentStaffId + permessi), note CRUD coi testi verbatim, list col
// fail-closed legacy e testi 403 per-azione, move con guardie/conflitti.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL = ""; for (const l of envText.split(/\r?\n/)) { const m = l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/); if (m) DBURL = m[1].trim().replace(/^["']|["']$/g, ""); }
async function db(sql, p = []) { for (let a = 0; a < 8; a++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); const r = await c.query(sql, p); await c.end(); return r; } catch (e) { try { await c.end(); } catch {} if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EMAXCONN|max clients/i.test(String(e.message))) { await new Promise(r => setTimeout(r, 4000)); continue; } throw e; } } }
const one = async (sql, p = []) => (await db(sql, p)).rows[0];
const SLUG = "centroesteticoelite", COOKIE = "beautysuite_session_t_centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", BASE = "http://localhost:3000", T = 25;
const mk = (perms, extra = {}) => { const p = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: extra.email ?? "info@artebrand.it", name: "ZZ Cal", role: extra.role ?? "admin", perms, needsEmailVerification: false, currentLocationId: extra.loc ?? 21, needsLocationSelection: false, locationIds: extra.locIds ?? [] }, issuedAt: Date.now(), epoch: 1e9 }), "utf8").toString("base64url"); return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`; };
const FULL = mk(["calendar.view", "appointments.manage", "appointments.quick_booking"]);
const api = async (path, opts = {}, sess = FULL) => { const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "x-tenant-slug": SLUG, cookie: `${COOKIE}=${sess}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } }); return { status: r.status, j: await r.json().catch(() => null) }; };
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const ids = { cli: 0, appts: [], notes: [] };
let staff22EmailSnap = null, orderSnap = null;
const pad = (n) => String(n).padStart(2, "0");
const at = new Date(Date.now() + 3 * 864e5);
const DAY = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const at2 = new Date(at.getTime() + 864e5);
const DAY2 = `${at2.getFullYear()}-${pad(at2.getMonth() + 1)}-${pad(at2.getDate())}`;

async function cleanup() {
  if (ids.appts.length) {
    await db(`DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id=ANY($2)`, [T, ids.appts]).catch(() => {});
    await db(`DELETE FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=ANY($2)`, [T, ids.appts]).catch(() => {});
    await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.appts]).catch(() => {});
  }
  if (ids.notes.length) await db(`DELETE FROM calendar_notes WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.notes]).catch(() => {});
  if (ids.cli) await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'`, [T, ids.cli]).catch(() => {});
  await db(`UPDATE staff SET email=$1 WHERE tenant_id=$2 AND id=22`, [staff22EmailSnap, T]).catch(() => {});
  await db(`UPDATE users SET calendar_day_staff_order=$1 WHERE tenant_id=$2 AND id=20`, [orderSnap, T]).catch(() => {});
  // Endpoint strumentati (note 'calendario' + move/save 'appuntamenti', utente
  // forgiato 'ZZ Cal'): le voci del registro vanno ripulite a watermark.
  if (logWatermark !== null) await db(`DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2`, [T, logWatermark]).catch(() => {});
}
let logWatermark = null;

try {
  logWatermark = Number((await one(`SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1`, [T])).m ?? 0);
  staff22EmailSnap = (await one(`SELECT email FROM staff WHERE tenant_id=$1 AND id=22`, [T])).email;
  orderSnap = (await one(`SELECT calendar_day_staff_order o FROM users WHERE tenant_id=$1 AND id=20`, [T])).o;
  const base = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM calendar_notes WHERE tenant_id=$1)::int n`, [T]);
  console.log(`[baseline] ${JSON.stringify(base)} staff22Email=${staff22EmailSnap} order=${orderSnap}`);

  // ============ CONTESTO ============
  const cDenied = await api(`/api/manage/calendar?slug=${SLUG}&date=${DAY}`, {}, mk(["clients.manage"], { role: "staff" }));
  check("C1 contesto senza calendar.view -> 403 'Permesso negato.'", cDenied.status === 403 && cDenied.j?.error === "Permesso negato.", JSON.stringify(cDenied.j));

  await db(`UPDATE staff SET email=$1 WHERE tenant_id=$2 AND id=22`, ["info@artebrand.it", T]); // link utente->staff per email
  const ctx = (await api(`/api/manage/calendar?slug=${SLUG}&date=${DAY}&start=${DAY}&end=${DAY2}`, {})).j;
  const sqlOrder = (await db(`SELECT id, full_name, calendar_color FROM staff WHERE tenant_id=$1 AND COALESCE(is_active,1)=1 AND full_name <> 'SSO' ORDER BY (CASE WHEN full_name='SSO' THEN 1 ELSE 0 END) ASC, full_name ASC, id ASC`, [T])).rows;
  // Filtro sede STRICT legacy (app_filter_staff_ids_by_location): con righe
  // staff_locations presenti restano SOLO gli operatori con riga per la sede 21.
  const slRows = (await db(`SELECT staff_id, location_id FROM staff_locations WHERE tenant_id=$1 AND staff_id = ANY($2)`, [T, sqlOrder.map((r) => r.id)])).rows;
  const expectedIds = slRows.length === 0
    ? sqlOrder.map((r) => r.id)
    : sqlOrder.filter((r) => slRows.some((x) => Number(x.staff_id) === r.id && Number(x.location_id) === 21)).map((r) => r.id);
  check("C2 staff = ordine naturale FILTRATO per sede (staff_locations strict) + colore '' quando calendar_color NULL",
    JSON.stringify((ctx?.staff ?? []).map((s) => s.id)) === JSON.stringify(expectedIds)
    && (ctx?.staff ?? []).every((s) => (s.id === 22 ? s.color === "" : true) && (s.id === 56 ? s.color === "#93c5fd" : true)),
    JSON.stringify({ api: ctx?.staff?.map((s) => [s.id, s.color]), expected: expectedIds, sl: slRows }));
  check("C3 currentStaffId risolto per EMAIL utente->staff (22) + permessi canManage/canCreate true",
    ctx?.currentStaffId === 22 && ctx?.canManageAppointments === true && ctx?.canCreateAppointments === true,
    JSON.stringify({ cs: ctx?.currentStaffId, m: ctx?.canManageAppointments, c: ctx?.canCreateAppointments }));

  // Ordine colonne: roundtrip set/get + snapshot ripristinato a fine test.
  const setOrd = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "set_calendar_day_staff_order", order: JSON.stringify([56, 22]) }) });
  const getOrd = (await api(`/api/manage/calendar?slug=${SLUG}&action=get_calendar_day_staff_order`, {})).j;
  check("C4 set/get ordine colonne (calendar_day_staff_order) roundtrip [56,22]",
    setOrd.j?.ok === true && JSON.stringify(getOrd?.order) === "[56,22]", JSON.stringify({ set: setOrd.j, get: getOrd }));

  // ============ NOTE ============
  const nDenied = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_save", note_date: DAY, note_text: "ZZ" }) }, mk(["calendar.view"], { role: "staff" }));
  check("N1 nota senza appointments.manage -> 403 'Permesso Appuntamenti richiesto.'", nDenied.status === 403 && nDenied.j?.error === "Permesso Appuntamenti richiesto.", JSON.stringify(nDenied.j));
  const nBadDate = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_save", note_date: "12/07/2026", note_text: "ZZ" }) });
  const nNoText = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_save", note_date: DAY, note_text: "   " }) });
  check("N2 validazioni verbatim: 'Seleziona un giorno valido.' + 'Il testo della nota e obbligatorio.'",
    nBadDate.j?.error === "Seleziona un giorno valido." && nNoText.j?.error === "Il testo della nota e obbligatorio.", JSON.stringify({ d: nBadDate.j?.error, t: nNoText.j?.error }));
  const nSave = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_save", note_date: DAY, title: "ZZ Titolo", note_text: "ZZ riga1\nriga2" }) });
  const noteId = Number(nSave.j?.note?.id ?? 0); if (noteId > 0) ids.notes.push(noteId);
  check("N3 salvataggio nota: payload con id, updatedAtLabel dd/mm/yyyy HH:MM, a-capo CONSERVATI",
    nSave.j?.ok === true && noteId > 0 && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(nSave.j?.note?.updatedAtLabel ?? "") && nSave.j?.note?.noteText === "ZZ riga1\nriga2",
    JSON.stringify(nSave.j?.note));
  const nList = (await api(`/api/manage/calendar?slug=${SLUG}&action=notes&start=${DAY}&end=${DAY2}`, {})).j;
  check("N4 list note: count_by_date del giorno include la ZZ", Number(nList?.count_by_date?.[DAY] ?? 0) >= 1 && (nList?.notes ?? []).some((n) => n.id === noteId), JSON.stringify({ c: nList?.count_by_date }));
  const nMissing = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_save", id: 999999, note_date: DAY, note_text: "x" }) });
  const nDelBad = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_delete", id: 0 }) });
  check("N5 'Nota non trovata.' su update inesistente + 'Nota non valida.' su delete id 0",
    nMissing.j?.error === "Nota non trovata." && nDelBad.j?.error === "Nota non valida.", JSON.stringify({ u: nMissing.j?.error, d: nDelBad.j?.error }));
  const nDel = await api(`/api/manage/calendar?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "note_delete", id: noteId }) });
  if (nDel.j?.ok === true) ids.notes = ids.notes.filter((n) => n !== noteId);
  check("N6 delete nota ok", nDel.j?.ok === true, JSON.stringify(nDel.j));

  // ============ LIST (calendario) ============
  const lPerm = await api(`/api/manage/appointments?slug=${SLUG}&action=list&date=${DAY}`, {}, mk(["appointments.quick_booking"], { role: "staff" }));
  check("L1 list con SOLO quick_booking -> 403 'Permesso Calendario richiesto.' (testo per-azione legacy)",
    lPerm.status === 403 && lPerm.j?.error === "Permesso Calendario richiesto.", JSON.stringify(lPerm.j));
  const gPerm = await api(`/api/manage/appointments?slug=${SLUG}&action=get&id=1`, {}, mk(["appointments.quick_booking"], { role: "staff" }));
  check("L2 get senza permessi -> 'Permesso non sufficiente per aprire la prenotazione.'",
    gPerm.status === 403 && gPerm.j?.error === "Permesso non sufficiente per aprire la prenotazione.", JSON.stringify(gPerm.j));
  const lFail = await api(`/api/manage/appointments?slug=${SLUG}&action=list&date=${DAY}`, {}, mk(["calendar.view"], { role: "staff", loc: 0, locIds: [21, 51] }));
  check("L3 fail-closed legacy: nessuna sede risolta con sedi assegnate -> appointments []",
    lFail.j?.ok === true && Array.isArray(lFail.j?.appointments) && lFail.j.appointments.length === 0, JSON.stringify({ n: lFail.j?.appointments?.length }));

  // ============ MOVE ============
  ids.cli = Number((await one(`INSERT INTO clients (tenant_id,full_name) VALUES ($1,'ZZ Cal Cli') RETURNING id`, [T])).id);
  const seed = async (start, end, status = "scheduled") => { const id = Number((await one(`INSERT INTO appointments (tenant_id,client_id,starts_at,ends_at,status,location_id,service_id) VALUES ($1,$2,$3,$4,$5,21,9) RETURNING id`, [T, ids.cli, `${DAY} ${start}:00`, `${DAY} ${end}:00`, status])).id); ids.appts.push(id); return id; };
  const a1 = await seed("09:00", "10:00");
  await db(`INSERT INTO appointment_staff (tenant_id,appointment_id,staff_id) VALUES ($1,$2,22)`, [T, a1]);
  const a2 = await seed("11:00", "12:00");
  await db(`INSERT INTO appointment_staff (tenant_id,appointment_id,staff_id) VALUES ($1,$2,22)`, [T, a2]);
  const aCanceled = await seed("14:00", "15:00", "canceled");

  const mPerm = await api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "move", id: a1, starts_at: `${DAY} 09:30:00`, ends_at: `${DAY} 10:30:00` }) }, mk(["calendar.view", "appointments.quick_booking"], { role: "staff" }));
  check("M1 move senza appointments.manage -> 403 'Permesso Appuntamenti richiesto.'", mPerm.status === 403 && mPerm.j?.error === "Permesso Appuntamenti richiesto.", JSON.stringify(mPerm.j));
  const mMissing = await api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "move", id: a1, starts_at: `${DAY} 09:30:00` }) });
  check("M2 move senza ends_at -> ok:false 'Dati mancanti'", mMissing.j?.ok === false && mMissing.j?.error === "Dati mancanti", JSON.stringify(mMissing.j));
  const mOk = await api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "move", id: a1, starts_at: `${DAY} 08:00:00`, ends_at: `${DAY} 09:00:00`, staff_id: "22" }) });
  const rowA1 = await one(`SELECT starts_at, ends_at FROM appointments WHERE tenant_id=$1 AND id=$2`, [T, a1]);
  const hhmm = (v) => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  check("M3 move ok -> DB aggiornato al nuovo orario 08:00-09:00", mOk.j?.ok === true && hhmm(rowA1.starts_at) === "08:00" && hhmm(rowA1.ends_at) === "09:00", JSON.stringify({ ok: mOk.j?.ok, s: String(rowA1.starts_at), e: String(rowA1.ends_at) }));
  const mConflict = await api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "move", id: a2, starts_at: `${DAY} 08:30:00`, ends_at: `${DAY} 09:30:00`, staff_id: "22" }) });
  check("M4 conflitto operatore -> 'Conflitto: l'operatore ha già un altro appuntamento in quell'orario.'",
    mConflict.j?.ok === false && mConflict.j?.error === "Conflitto: l'operatore ha già un altro appuntamento in quell'orario.", JSON.stringify(mConflict.j));
  const mCanceled = await api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify({ action: "move", id: aCanceled, starts_at: `${DAY} 15:00:00`, ends_at: `${DAY} 16:00:00` }) });
  check("M5 move su ANNULLATO -> 'La prenotazione non e modificabile da calendario.' (senza accento)",
    mCanceled.j?.ok === false && mCanceled.j?.error === "La prenotazione non e modificabile da calendario.", JSON.stringify(mCanceled.j));
  const lDay = (await api(`/api/manage/appointments?slug=${SLUG}&action=list&date=${DAY}`, {})).j;
  const l1 = (lDay?.appointments ?? []).find((x) => x.id === a1);
  check("M6 list del giorno: l'appuntamento spostato compare alle 08:00 con operatorId 22",
    Boolean(l1) && l1.time === "08:00" && Number(l1.operatorId ?? 0) === 22, JSON.stringify({ t: l1?.time, op: l1?.operatorId }));
} catch (e) { console.log("ERRORE FATALE:", e.message); R.push(false); }
finally {
  await cleanup();
  const fin = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM calendar_notes WHERE tenant_id=$1)::int n,(SELECT email FROM staff WHERE tenant_id=$1 AND id=22) e,(SELECT calendar_day_staff_order FROM users WHERE tenant_id=$1 AND id=20) o`, [T]);
  check("CLEANUP: baseline + email staff 22 + ordine colonne utente 20 ripristinati",
    fin.a === 10 && fin.c === 5 && fin.n === 0 && String(fin.e ?? "null") === String(staff22EmailSnap ?? "null") && String(fin.o ?? "null") === String(orderSnap ?? "null"),
    JSON.stringify({ a: fin.a, c: fin.c, n: fin.n, eOk: String(fin.e ?? "null") === String(staff22EmailSnap ?? "null"), oOk: String(fin.o ?? "null") === String(orderSnap ?? "null") }));
  console.log(`\nTOTALE: ${R.filter(Boolean).length}/${R.length} PASS${R.every(Boolean) ? "" : "  <<< FALLIMENTI"}`);
}
