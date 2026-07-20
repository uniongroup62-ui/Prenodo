// E2E live APPUNTAMENTI: lista (flag permessi, delete singola con guardie e
// cascata, bulk mixed coi 3 contatori, swap_segment) + PIANIFICA (gate
// appointments.plan, plan_context, ordine validazioni verbatim, generazione
// date weekly/weekly2/monthly + ancora weekday, pool operatori per sede
// STRICT, Chiuso/Operatore occupato, create con snapshot + nuovo cliente).
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
const mk = (perms, extra = {}) => { const p = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: extra.email ?? "info@artebrand.it", name: "ZZ Appt", role: extra.role ?? "admin", perms, needsEmailVerification: false, currentLocationId: extra.loc ?? 21, needsLocationSelection: false, locationIds: extra.locIds ?? [] }, issuedAt: Date.now(), epoch: 1e9 }), "utf8").toString("base64url"); return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`; };
const FULL = mk(["calendar.view", "appointments.manage", "appointments.quick_booking", "appointments.plan"]);
const SEDE51 = mk(["calendar.view", "appointments.manage", "appointments.plan"], { loc: 51 });
const api = async (path, opts = {}, sess = FULL) => { const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "x-tenant-slug": SLUG, cookie: `${COOKIE}=${sess}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } }); return { status: r.status, j: await r.json().catch(() => null) }; };
const post = (body, sess = FULL) => api(`/api/manage/appointments?slug=${SLUG}`, { method: "POST", body: JSON.stringify(body) }, sess);
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const ids = { clients: [], appts: [], ssRow: false };
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (isoS, days) => { const [y, m, d] = isoS.split("-").map(Number); return iso(new Date(y, m - 1, d + days)); };
const TODAY = iso(new Date());
// Prossimo martedì (dow 2) STRETTAMENTE dopo oggi + almeno 14 giorni avanti (per
// non pestare prenotazioni esistenti); il planner ancora al primo weekday scelto.
const nextDow = (dow, minAhead = 1) => { const d = new Date(); d.setDate(d.getDate() + minAhead); while (d.getDay() !== dow) d.setDate(d.getDate() + 1); return iso(d); };
const TUE1 = nextDow(2, 14); // martedì futuro
const TUE2 = shift(TUE1, 7);
// addMonths clamp fine-mese (semantica PHP '+1 month' del port).
const addMonthsIso = (isoS, months) => { const [y, m, d] = isoS.split("-").map(Number); const mm = m - 1 + months; const ty = y + Math.floor(mm / 12), tm = ((mm % 12) + 12) % 12; const last = new Date(ty, tm + 1, 0).getDate(); return iso(new Date(ty, tm, Math.min(d, last))); };
const planBody = (extra) => ({ action: "plan_preview", client_id: String(ids.clients[0] ?? 0), new_full_name: "", new_phone: "", new_email: "", service_ids: "9", repeat: "1", staff_id: "0", staff_map: "{}", cabin_map: "{}", recurrence: "weekly", weekdays: "", start_date: TUE1, time_from: "14:00", time_to: "16:00", ...extra });

async function cleanup() {
  if (ids.appts.length) {
    for (const t of ["reminders", "appointment_segments", "appointment_services", "appointment_staff"]) {
      await db(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=ANY($2)`, [T, ids.appts]).catch(() => {});
    }
    await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.appts]).catch(() => {});
  }
  if (ids.clients.length) await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=ANY($2) AND full_name LIKE 'ZZ%'`, [T, ids.clients]).catch(() => {});
  if (ids.ssRow) await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=56 AND service_id=9`, [T]).catch(() => {});
  if (ids.slRow) await db(`DELETE FROM staff_locations WHERE tenant_id=$1 AND staff_id=22 AND location_id=51`, [T]).catch(() => {});
}

try {
  const base0 = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM staff_services WHERE tenant_id=$1)::int s`, [T]);
  console.log(`[baseline] ${JSON.stringify(base0)} TODAY=${TODAY} TUE1=${TUE1}`);

  // ============ LISTA: flag permessi ============
  const lFull = (await api(`/api/manage/appointments?slug=${SLUG}&action=list&from=${TODAY}&to=${TODAY}`, {})).j;
  check("L1 list FULL -> flag canManageAppointments/canQuickBook/canSeeCalendar tutti true",
    lFull?.ok === true && lFull?.canManageAppointments === true && lFull?.canQuickBook === true && lFull?.canSeeCalendar === true,
    JSON.stringify({ m: lFull?.canManageAppointments, q: lFull?.canQuickBook, c: lFull?.canSeeCalendar }));
  const lView = (await api(`/api/manage/appointments?slug=${SLUG}&action=list&from=${TODAY}&to=${TODAY}`, {}, mk(["calendar.view"], { role: "staff" }))).j;
  check("L2 list con SOLO calendar.view -> canManageAppointments=false, canQuickBook=false (card Accesso negato lato pagina)",
    lView?.ok === true && lView?.canManageAppointments === false && lView?.canQuickBook === false && lView?.canSeeCalendar === true,
    JSON.stringify({ m: lView?.canManageAppointments, q: lView?.canQuickBook }));

  // ============ LISTA: delete singola ============
  ids.clients.push(Number((await one(`INSERT INTO clients (tenant_id,full_name) VALUES ($1,'ZZ Appt Cli') RETURNING id`, [T])).id));
  const CLI = ids.clients[0];
  const seed = async (day, start, end, status = "scheduled", loc = 21) => { const id = Number((await one(`INSERT INTO appointments (tenant_id,client_id,starts_at,ends_at,status,location_id,service_id) VALUES ($1,$2,$3,$4,$5,$6,9) RETURNING id`, [T, CLI, `${day} ${start}:00`, `${day} ${end}:00`, status, loc])).id); ids.appts.push(id); return id; };
  const D1 = shift(TUE1, 1); // mercoledì futuro
  const aCanc = await seed(D1, "09:00", "10:00", "canceled");
  await db(`INSERT INTO appointment_staff (tenant_id,appointment_id,staff_id) VALUES ($1,$2,22)`, [T, aCanc]);
  await db(`INSERT INTO appointment_services (tenant_id,appointment_id,service_id,qty,price) VALUES ($1,$2,9,1,12.00)`, [T, aCanc]).catch(() => {});
  const aSched = await seed(D1, "10:00", "11:00", "scheduled");

  const dPerm = await post({ action: "delete", id: aCanc }, mk(["calendar.view", "appointments.quick_booking"], { role: "staff" }));
  check("D1 delete senza appointments.manage -> 403 'Permesso Appuntamenti richiesto.'",
    dPerm.status === 403 && dPerm.j?.error === "Permesso Appuntamenti richiesto.", JSON.stringify(dPerm.j));
  const dGuard = await post({ action: "delete", id: aSched });
  check("D2 delete su NON-annullato -> guardia verbatim 'La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.'",
    dGuard.j?.ok === false && dGuard.j?.error === "La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.", JSON.stringify(dGuard.j?.error));
  const dNone = await post({ action: "delete", id: 0 });
  check("D3 delete senza id -> 'Nessun appuntamento selezionato.'", dNone.j?.error === "Nessun appuntamento selezionato.", JSON.stringify(dNone.j));
  const dOk = await post({ action: "delete", id: aCanc });
  const dResidui = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$2)::int a,(SELECT COUNT(*) FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2)::int st,(SELECT COUNT(*) FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2)::int sv,(SELECT COUNT(*) FROM reminders WHERE tenant_id=$1 AND appointment_id=$2)::int r`, [T, aCanc]);
  if (dOk.j?.ok === true) ids.appts = ids.appts.filter((x) => x !== aCanc);
  check("D4 delete su annullato -> ok deleted=1 + cascata figli a 0",
    dOk.j?.ok === true && dOk.j?.deleted === 1 && dResidui.a === 0 && dResidui.st === 0 && dResidui.sv === 0 && dResidui.r === 0,
    JSON.stringify({ ok: dOk.j?.ok, del: dOk.j?.deleted, residui: dResidui }));

  // ============ LISTA: bulk mixed (sede ristretta) ============
  const bCanc = await seed(D1, "11:00", "12:00", "canceled");
  const bOther = await seed(D1, "12:00", "13:00", "canceled", 51);
  const RESTR = mk(["appointments.manage"], { role: "staff", loc: 21, locIds: [21] });
  const bulk = await post({ action: "bulk_delete", ids: `${bCanc},${aSched},${bOther}` }, RESTR);
  const bLeft = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$2)::int c1,(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$3)::int c2,(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$4)::int c3`, [T, bCanc, aSched, bOther]);
  if (bLeft.c1 === 0) ids.appts = ids.appts.filter((x) => x !== bCanc);
  check("B1 bulk mixed -> deleted=1, blockedNotCanceled=1 (scheduled), blockedUnavailable=1 (altra sede, utente ristretto 21)",
    bulk.j?.ok === true && bulk.j?.deleted === 1 && bulk.j?.blockedNotCanceled === 1 && bulk.j?.blockedUnavailable === 1
    && bLeft.c1 === 0 && bLeft.c2 === 1 && bLeft.c3 === 1,
    JSON.stringify({ r: { d: bulk.j?.deleted, nc: bulk.j?.blockedNotCanceled, un: bulk.j?.blockedUnavailable }, left: bLeft }));
  const dOther = await post({ action: "delete", id: bOther }, RESTR);
  check("B2 delete singola fuori sede (ristretto) -> 403 'Prenotazione non trovata o non disponibile nella sede corrente.'",
    dOther.status === 403 && dOther.j?.error === "Prenotazione non trovata o non disponibile nella sede corrente.", JSON.stringify(dOther.j));

  // ============ LISTA: swap_segment ============
  const sw = await seed(D1, "14:00", "16:00", "scheduled");
  const seg1 = Number((await one(`INSERT INTO appointment_segments (tenant_id,appointment_id,service_id,service_name,staff_id,position,starts_at,ends_at,duration_minutes) VALUES ($1,$2,9,'test',22,1,$3,$4,60) RETURNING id`, [T, sw, `${D1} 14:00:00`, `${D1} 15:00:00`])).id);
  const seg2 = Number((await one(`INSERT INTO appointment_segments (tenant_id,appointment_id,service_id,service_name,staff_id,position,starts_at,ends_at,duration_minutes) VALUES ($1,$2,82,'test2',22,2,$3,$4,60) RETURNING id`, [T, sw, `${D1} 15:00:00`, `${D1} 16:00:00`])).id);
  const swBadDir = await post({ action: "swap_segment", id: sw, segment_id: seg1, direction: "left" });
  check("S1 direction invalida -> 400 'Direzione non valida'", swBadDir.status === 400 && swBadDir.j?.error === "Direzione non valida", JSON.stringify(swBadDir.j));
  const swUpFirst = await post({ action: "swap_segment", id: sw, segment_id: seg1, direction: "up" });
  check("S2 swap up sul PRIMO segmento -> 'Spostamento non disponibile'", swUpFirst.j?.ok === false && swUpFirst.j?.error === "Spostamento non disponibile", JSON.stringify(swUpFirst.j));
  const swOk = await post({ action: "swap_segment", id: sw, segment_id: seg1, direction: "down" });
  const segRows = (await db(`SELECT id, starts_at, ends_at FROM appointment_segments WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY starts_at ASC`, [T, sw])).rows;
  const hhmm = (v) => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  check("S3 swap down -> finestre orarie scambiate (test2 14:00-15:00, test 15:00-16:00)",
    swOk.j?.ok === true && Number(segRows[0]?.id) === seg2 && hhmm(segRows[0]?.starts_at) === "14:00" && Number(segRows[1]?.id) === seg1 && hhmm(segRows[1]?.starts_at) === "15:00",
    JSON.stringify({ ok: swOk.j?.ok, rows: segRows.map((r) => [r.id, hhmm(r.starts_at), hhmm(r.ends_at)]) }));
  const swSingle = await seed(D1, "16:00", "17:00", "scheduled");
  const swNoSeg = await post({ action: "swap_segment", id: swSingle, segment_id: 1, direction: "down" });
  check("S4 appuntamento senza segmenti -> 'Questa prenotazione non è multi-servizio.'",
    swNoSeg.j?.ok === false && swNoSeg.j?.error === "Questa prenotazione non è multi-servizio.", JSON.stringify(swNoSeg.j));

  // ============ PIANIFICA: gate + plan_context ============
  const pcFull = (await api(`/api/manage/appointments?slug=${SLUG}&action=plan_context`, {})).j;
  check("P1 plan_context FULL -> canPlan/canManageAppointments/canSeeCalendar true",
    pcFull?.ok === true && pcFull?.canPlan === true && pcFull?.canManageAppointments === true && pcFull?.canSeeCalendar === true, JSON.stringify(pcFull));
  const pcMng = (await api(`/api/manage/appointments?slug=${SLUG}&action=plan_context`, {}, mk(["appointments.manage"], { role: "staff" }))).j;
  check("P2 plan_context con SOLO manage -> canPlan=false (pagina: card Accesso negato)", pcMng?.ok === true && pcMng?.canPlan === false, JSON.stringify(pcMng));
  const pvMng = await post(planBody({}), mk(["appointments.manage"], { role: "staff" }));
  check("P3 plan_preview con SOLO appointments.manage -> 403 (gate legacy requirePerm('appointments.plan'))",
    pvMng.status === 403 && pvMng.j?.error === "Permesso pianificazione appuntamenti mancante.", JSON.stringify(pvMng.j));

  // ============ PIANIFICA: ordine validazioni verbatim ============
  const vEmail = await post(planBody({ client_id: "0", new_email: "nonvalida", new_full_name: "" }));
  check("V1 email invalida PRIMA della scelta cliente -> 'Email nuovo cliente non valida.'",
    vEmail.j?.ok === false && vEmail.j?.error === "Email nuovo cliente non valida.", JSON.stringify(vEmail.j?.error));
  const vCli = await post(planBody({ client_id: "0" }));
  check("V2 nessun cliente -> 'Seleziona un cliente o inserisci un nuovo cliente.'", vCli.j?.error === "Seleziona un cliente o inserisci un nuovo cliente.", JSON.stringify(vCli.j?.error));
  const vSvc = await post(planBody({ service_ids: "" }));
  check("V3 nessun servizio -> 'Seleziona almeno un servizio.'", vSvc.j?.error === "Seleziona almeno un servizio.", JSON.stringify(vSvc.j?.error));
  const vDate = await post(planBody({ start_date: "12/07/2026" }));
  check("V4 data invalida -> 'Data di partenza non valida.'", vDate.j?.error === "Data di partenza non valida.", JSON.stringify(vDate.j?.error));
  const vTime = await post(planBody({ time_from: "9x00" }));
  check("V5 orario invalido -> 'Orario non valido.'", vTime.j?.error === "Orario non valido.", JSON.stringify(vTime.j?.error));
  const vRange = await post(planBody({ time_from: "15:00", time_to: "14:00" }));
  check("V6 alle<dalle -> '\"Alle ore\" deve essere >= \"Dalle ore\".'", vRange.j?.error === '"Alle ore" deve essere >= "Dalle ore".', JSON.stringify(vRange.j?.error));
  const vWin = await post(planBody({ time_from: "14:00", time_to: "14:30" }));
  check("V7 finestra < durata -> '\"Alle ore\" deve essere >= \"Dalle ore\" + durata servizi.'", vWin.j?.error === '"Alle ore" deve essere >= "Dalle ore" + durata servizi.', JSON.stringify(vWin.j?.error));
  const vGhost = await post(planBody({ client_id: "999999" }));
  check("V8 cliente inesistente -> 'Cliente non valido o non disponibile nella sede scelta.'", vGhost.j?.error === "Cliente non valido o non disponibile nella sede scelta.", JSON.stringify(vGhost.j?.error));
  const vBadSvc = await post(planBody({ service_ids: "999999" }));
  check("V9 servizio inesistente -> 'Servizio non valido: 999999'", vBadSvc.j?.error === "Servizio non valido: 999999", JSON.stringify(vBadSvc.j?.error));
  const blockedCli = Number((await one(`INSERT INTO clients (tenant_id,full_name,is_blocked) VALUES ($1,'ZZ Appt Bloccato',1) RETURNING id`, [T])).id); ids.clients.push(blockedCli);
  const vBlk = await post(planBody({ client_id: String(blockedCli) }));
  check("V10 cliente bloccato -> messaggio operativo legacy", /disattivato e non può essere utilizzato/.test(String(vBlk.j?.error ?? "")), JSON.stringify(vBlk.j?.error));
  const vSede = await post(planBody({ service_ids: "82" }), SEDE51);
  check("V11 servizio fuori sede (82 solo sede 21, cookie sede 51) -> 'Servizio non disponibile nella sede corrente.'",
    vSede.j?.error === "Servizio non disponibile nella sede corrente.", JSON.stringify(vSede.j?.error));

  // ============ PIANIFICA: pool operatori per sede (STRICT) ============
  await db(`INSERT INTO staff_services (tenant_id,staff_id,service_id) VALUES ($1,56,9)`, [T]); ids.ssRow = true;
  // Healing 2026-07-17: da quando staff 22 ha la riga staff_locations(21) il pool sede-51
  // sarebbe {56} (auto-pick corretto). Semino TEMPORANEAMENTE 22->51 per ricreare
  // l'ambiguita' {luca,Luca} che O2 verifica.
  await db(`INSERT INTO staff_locations (tenant_id,staff_id,location_id) VALUES ($1,22,51)`, [T]); ids.slRow = true;
  const pool21 = await post(planBody({ weekdays: "2", repeat: "1" }));
  check("O1 sede 21: staff 56 (solo sede 51) FILTRATO dal pool -> auto-assegnato 'luca' senza staff_map",
    pool21.j?.ok === true && (pool21.j?.dates ?? []).some((r) => r.ok === true && r.operator === "luca"),
    JSON.stringify((pool21.j?.dates ?? []).map((r) => [r.date, r.ok, r.operator, r.reason])));
  const pool51 = await post(planBody({ weekdays: "2", repeat: "1" }), SEDE51);
  check("O2 sede 51: pool {luca,Luca} -> senza scelta 'Seleziona un operatore per il servizio: test'",
    pool51.j?.ok === false && pool51.j?.error === "Seleziona un operatore per il servizio: test", JSON.stringify(pool51.j?.error));
  const pool51ok = await post(planBody({ weekdays: "2", repeat: "1", staff_map: JSON.stringify({ 9: 56 }) }), SEDE51);
  check("O3 sede 51 con staff_map {9:56} -> ok, operatore 'Luca'",
    pool51ok.j?.ok === true && (pool51ok.j?.dates ?? []).every((r) => !r.ok || r.operator === "Luca"),
    JSON.stringify((pool51ok.j?.dates ?? []).map((r) => [r.date, r.ok, r.operator, r.reason])));
  await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=56 AND service_id=9`, [T]); ids.ssRow = false;
  await db(`DELETE FROM staff_locations WHERE tenant_id=$1 AND staff_id=22 AND location_id=51`, [T]); ids.slRow = false;

  // ============ PIANIFICA: generazione date ============
  const gW = await post(planBody({ weekdays: "2", repeat: "2" }));
  const gwDates = (gW.j?.dates ?? []).map((r) => r.date);
  check("G1 weekly repeat=2 weekday=Mar -> [TUE1, TUE1+7]", gW.j?.ok === true && JSON.stringify(gwDates) === JSON.stringify([TUE1, TUE2]), JSON.stringify(gwDates));
  const gW2 = await post(planBody({ weekdays: "2", repeat: "2", recurrence: "weekly2" }));
  const gw2Dates = (gW2.j?.dates ?? []).map((r) => r.date);
  check("G2 weekly2 repeat=2 -> cicli a 14 giorni [TUE1, TUE1+14]", JSON.stringify(gw2Dates) === JSON.stringify([TUE1, shift(TUE1, 14)]), JSON.stringify(gw2Dates));
  const gM = await post(planBody({ weekdays: "2", repeat: "2", recurrence: "monthly" }));
  const gmDates = (gM.j?.dates ?? []).map((r) => r.date);
  // Mensile: base = TUE1 + 1 mese (clamp), poi scansione avanti max 14gg fino al primo martedì.
  let exp2 = addMonthsIso(TUE1, 1); { const [y, m, d] = exp2.split("-").map(Number); const dd = new Date(y, m - 1, d); for (let k = 0; k < 14 && dd.getDay() !== 2; k++) dd.setDate(dd.getDate() + 1); exp2 = iso(dd); }
  check("G3 monthly repeat=2 -> 1 data/mese [TUE1, primo Mar >= TUE1+1mese]", JSON.stringify(gmDates) === JSON.stringify([TUE1, exp2]), JSON.stringify({ got: gmDates, exp: [TUE1, exp2] }));
  const gAnchor = await post(planBody({ weekdays: String(new Date().getDay()), repeat: "1", start_date: TODAY }));
  const gaDates = (gAnchor.j?.dates ?? []).map((r) => r.date);
  check("G4 ancora weekday: start=OGGI + weekday=oggi -> prima data OGGI+7 (strettamente dopo oggi)",
    JSON.stringify(gaDates) === JSON.stringify([shift(TODAY, 7)]), JSON.stringify(gaDates));
  const gClamp = await post(planBody({ weekdays: "", repeat: "1", start_date: shift(TODAY, -3) }));
  const gcDates = (gClamp.j?.dates ?? []).map((r) => r.date);
  check("G5 non-retroattivo: start nel passato SENZA weekday -> clampato a OGGI (dow di oggi)",
    JSON.stringify(gcDates) === JSON.stringify([TODAY]), JSON.stringify(gcDates));

  // ============ PIANIFICA: esiti slot ============
  const rowsChiuso = await post(planBody({ weekdays: "0", repeat: "1" })); // domenica = chiusa (dow 0 senza orari)
  check("E1 giorno chiuso (domenica) -> riga Saltato reason 'Chiuso'",
    rowsChiuso.j?.ok === true && (rowsChiuso.j?.dates ?? []).length === 1 && rowsChiuso.j.dates[0].ok === false && rowsChiuso.j.dates[0].reason === "Chiuso",
    JSON.stringify(rowsChiuso.j?.dates));
  const cf = await seed(TUE1, "14:00", "15:00", "scheduled");
  await db(`INSERT INTO appointment_staff (tenant_id,appointment_id,staff_id) VALUES ($1,$2,22)`, [T, cf]);
  const rowsBusy = await post(planBody({ weekdays: "2", repeat: "1", time_from: "14:00", time_to: "15:00" }));
  const busyRow = (rowsBusy.j?.dates ?? [])[0] ?? {};
  check("E2 operatore occupato sull'unico slot della finestra -> Saltato 'Operatore occupato'",
    rowsBusy.j?.ok === true && busyRow.ok === false && busyRow.reason === "Operatore occupato", JSON.stringify(rowsBusy.j?.dates));
  const crNone = await post({ ...planBody({ weekdays: "2", repeat: "1", time_from: "14:00", time_to: "15:00" }), action: "plan_create" });
  check("E3 plan_create con tutte le date non disponibili -> 'Nessuna prenotazione creabile (tutte non disponibili).'",
    crNone.j?.ok === false && crNone.j?.error === "Nessuna prenotazione creabile (tutte non disponibili).", JSON.stringify(crNone.j?.error));

  // ============ PIANIFICA: create felice + snapshot ============
  const pv = await post(planBody({ weekdays: "2", repeat: "2", time_from: "16:00", time_to: "18:00" }));
  const pvRows = (pv.j?.dates ?? []).map((r) => [r.date, r.ok, r.start, r.operator, r.reason]);
  check("H1 preview felice: 2 righe OK, badge totale 60min/€12, operatore 'luca'",
    pv.j?.ok === true && pv.j?.totalDuration === 60 && Number(pv.j?.totalPrice) === 12 && (pv.j?.dates ?? []).filter((r) => r.ok).length === 2,
    JSON.stringify({ rows: pvRows, dur: pv.j?.totalDuration, price: pv.j?.totalPrice }));
  const cr = await post({ ...planBody({ weekdays: "2", repeat: "2", time_from: "16:00", time_to: "18:00" }), action: "plan_create" });
  const crIds = (cr.j?.details ?? []).filter((d) => d.ok).map((d) => Number(d.appointmentId)).filter((n) => n > 0);
  ids.appts.push(...crIds);
  const crRows = crIds.length ? (await db(`SELECT id, client_id, status, public_code, cabin_id, starts_at FROM appointments WHERE tenant_id=$1 AND id=ANY($2) ORDER BY starts_at`, [T, crIds])).rows : [];
  const crSvc = crIds.length ? (await db(`SELECT appointment_id, service_id, price FROM appointment_services WHERE tenant_id=$1 AND appointment_id=ANY($2)`, [T, crIds])).rows : [];
  const crStaff = crIds.length ? (await db(`SELECT appointment_id, staff_id FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=ANY($2)`, [T, crIds])).rows : [];
  check("H2 plan_create -> created=2, righe scheduled con client, public_code, snapshot servizi (9, €12) e staff 22",
    cr.j?.ok === true && cr.j?.created === 2 && crRows.length === 2
    && crRows.every((r) => r.status === "scheduled" && Number(r.client_id) === CLI && String(r.public_code ?? "").length === 5)
    && crSvc.length === 2 && crSvc.every((r) => Number(r.service_id) === 9 && Number(r.price) === 12)
    && crStaff.length === 2 && crStaff.every((r) => Number(r.staff_id) === 22),
    JSON.stringify({ created: cr.j?.created, rows: crRows.map((r) => [r.id, r.status, r.public_code, r.cabin_id, String(r.starts_at)]), svc: crSvc, staff: crStaff }));

  // ============ PIANIFICA: create con NUOVO cliente (solo in create, non in preview) ============
  const pvNew = await post(planBody({ client_id: "0", new_full_name: "ZZ Plan Nuovo", new_phone: "333", new_email: "zzplan@test.it", weekdays: "2", repeat: "1", time_from: "16:00", time_to: "18:00" }));
  const ghostCli = await one(`SELECT COUNT(*)::int c FROM clients WHERE tenant_id=$1 AND full_name='ZZ Plan Nuovo'`, [T]);
  check("N1 preview con nuovo cliente NON crea il cliente (creazione solo allo step create)",
    pvNew.j?.ok === true && ghostCli.c === 0, JSON.stringify({ ok: pvNew.j?.ok, count: ghostCli.c }));
  const crNew = await post({ ...planBody({ client_id: "0", new_full_name: "ZZ Plan Nuovo", new_phone: "333", new_email: "zzplan@test.it", weekdays: "3", repeat: "1", time_from: "10:00", time_to: "12:00" }), action: "plan_create" });
  const newCliRow = await one(`SELECT id, phone, email FROM clients WHERE tenant_id=$1 AND full_name='ZZ Plan Nuovo'`, [T]).catch(() => null);
  if (newCliRow?.id) ids.clients.push(Number(newCliRow.id));
  const crNewIds = (crNew.j?.details ?? []).filter((d) => d.ok).map((d) => Number(d.appointmentId)).filter((n) => n > 0);
  ids.appts.push(...crNewIds);
  check("N2 plan_create nuovo cliente -> cliente creato (tel/email) + newClientId + appuntamento legato",
    crNew.j?.ok === true && Number(crNew.j?.newClientId ?? 0) === Number(newCliRow?.id ?? -1) && newCliRow?.phone === "333" && newCliRow?.email === "zzplan@test.it" && crNewIds.length === 1,
    JSON.stringify({ ok: crNew.j?.ok, newId: crNew.j?.newClientId, row: newCliRow, appts: crNewIds }));
} catch (e) {
  console.log("FATAL", e);
  R.push(false);
} finally {
  await cleanup();
  const base1 = await one(`SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM staff_services WHERE tenant_id=$1)::int s`, [T]).catch(() => null);
  console.log(`[after-cleanup] ${JSON.stringify(base1)} (atteso a=10, c=5, s=3)`);
  console.log(`TOTALE: ${R.filter(Boolean).length}/${R.length} PASS`);
}
