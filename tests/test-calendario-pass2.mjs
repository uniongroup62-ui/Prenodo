// Calendario pass 2 (2026-07-18) — FIX: (1) guardia sede sul param extra
// location_id delle bande di indisponibilità (ristretto NON legge altre sedi,
// fallback sede di sessione RISOLTA); (2) classe TZ server-safe: default
// "oggi" businessTodayIso + created_at/updated_at note in ora di Roma
// esplicita (era NOW() UTC su Supabase). + riverifica logiche note CRUD
// (validazioni/permessi/scoping) e ordine colonne.
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
function makeCookie(role, perms, locationIds) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie("admin", ["calendar.view", "appointments.manage"], []);
const viewOnlyCookie = makeCookie("admin", ["calendar.view"], []);
const noCalCookie = makeCookie("admin", ["appointments.manage"], []);
const mgrCookie = makeCookie("manager", ["calendar.view"], [21]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function apiGet(params, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/calendar?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function apiPost(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/calendar?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime(); // wall-time Roma come ms "naive"
};
const wallMs = (s) => new Date(String(s).replace(" ", "T")).getTime();

const noteIds = [];
let timeoffId = 0, closureId = 0, orderBackup = null;
// note_save/note_delete ora loggano (modulo 'calendario'): cleanup a watermark.
const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
try {
  orderBackup = (await q1("SELECT calendar_day_staff_order o FROM users WHERE tenant_id=$1 AND id=20", [T]))?.o ?? null;

  // Data futura con sede 21 APERTA (dalla riga business_hours @21 o globale del dow)
  const bh = (await q("SELECT dow, location_id, opens, closes, COALESCE(is_closed,0) c FROM business_hours WHERE tenant_id=$1 AND (location_id=21 OR location_id IS NULL) ORDER BY dow, (location_id IS NULL)", [T])).rows;
  const byDow = new Map();
  for (const r of bh) if (!byDow.has(r.dow)) byDow.set(r.dow, r); // @21 vince (ordine)
  let openDow = -1;
  for (const [d, r] of byDow) if (Number(r.c) === 0 && r.opens && r.closes) { openDow = Number(d); break; }
  check("PRE dow aperto per sede 21 trovato", openDow >= 0, JSON.stringify([...byDow.values()]));
  const base = new Date("2027-06-13T12:00:00"); // domenica dow 0
  base.setDate(base.getDate() + openDow);
  const D = base.toISOString().slice(0, 10);

  // Fixtures guardia: timeoff staff 22 su D (bande attese in sede 21) +
  // chiusura SOLO sede 51 su D (bande vuote in sede 51: negozio chiuso).
  timeoffId = Number((await q("INSERT INTO staff_timeoff (tenant_id, staff_id, starts_at, ends_at, reason) VALUES ($1,22,$2,$3,'ZZ cal2') RETURNING id", [T, `${D} 00:00:00`, `${D} 23:59:00`])).rows[0].id);
  closureId = Number((await q("INSERT INTO closures (tenant_id, date, location_id, reason) VALUES ($1,$2,51,'ZZ chiusura cal2') RETURNING id", [T, D])).rows[0].id);

  // G1: admin con location_id=51 -> sede 51 onorata (chiusa => zero bande)
  const g1 = await apiGet(`&date=${D}&location_id=51`);
  check("G1 admin location_id=51 onorato: sede chiusa -> 0 bande", g1.j?.ok === true && Array.isArray(g1.j?.staffUnavailability) && g1.j.staffUnavailability.length === 0, JSON.stringify(g1.j?.staffUnavailability));

  // G2 (FIX): manager ristretto a 21 chiede location_id=51 -> IGNORATO (ripiego 21: bande timeoff)
  const g2 = await apiGet(`&date=${D}&location_id=51`, mgrCookie);
  const bands2 = g2.j?.staffUnavailability ?? [];
  check("G2 guardia sede: ristretto con location_id=51 -> ripiego sede 21 (bande staff 22 presenti)", g2.j?.ok === true && bands2.some((b) => Number(b.staffId) === 22), JSON.stringify(bands2));

  // G3: param invalido (9999) -> ripiego sede sessione 21 (bande presenti)
  const g3 = await apiGet(`&date=${D}&location_id=9999`);
  check("G3 location_id invalido -> ripiego sede sessione (bande presenti)", (g3.j?.staffUnavailability ?? []).some((b) => Number(b.staffId) === 22), JSON.stringify((g3.j?.staffUnavailability ?? []).length));

  // G4: sanity sede 21 esplicita
  const g4 = await apiGet(`&date=${D}&location_id=21`);
  check("G4 sede 21 esplicita: bande timeoff staff 22", (g4.j?.staffUnavailability ?? []).some((b) => Number(b.staffId) === 22), "");

  // N1 (FIX TZ): create nota -> created_at/updated_at in ORA DI ROMA (±5min, non UTC -2h)
  const n1 = await apiPost({ action: "note_save", note_date: D, title: `ZZ nota ${RUN}`, note_text: `testo ${RUN}\nseconda riga` });
  const note = n1.j?.note ?? {};
  if (note.id) noteIds.push(Number(note.id));
  const dbNote = await q1("SELECT created_at::text c, updated_at::text u, note_text FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, note.id ?? 0]);
  const diffMin = Math.abs(wallMs(dbNote?.c ?? 0) - romeNowMs()) / 60000;
  check("N1 create: created_at in ora di ROMA (±5min, pre-fix UTC=-120)", n1.j?.ok === true && Number(note.id) > 0 && diffMin < 5, JSON.stringify({ c: dbNote?.c, diffMin: Math.round(diffMin) }));
  check("N1b a-capo conservati + autore nel payload", String(dbNote?.note_text ?? "").includes("\nseconda riga") && note.createdByName === "luca", JSON.stringify({ t: dbNote?.note_text, a: note.createdByName }));

  // N2: update -> testo/titolo/data aggiornati, updated_at Roma.
  // Pausa >1s: il trigger app_touch_updated_at tocca quando NEW==OLD (stesso
  // secondo = indistinguibile da "non assegnato" in PG); un edit reale non
  // cade mai nello stesso secondo della creazione.
  await new Promise((r) => setTimeout(r, 1300));
  const n2 = await apiPost({ action: "note_save", id: String(note.id), note_date: D, title: "", note_text: `agg ${RUN}` });
  const dbNote2 = await q1("SELECT title, note_text, updated_at::text u FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, note.id]);
  const diffMin2 = Math.abs(wallMs(dbNote2?.u ?? 0) - romeNowMs()) / 60000;
  check("N2 update: testo/titolo NULL, updated_at Roma", n2.j?.ok === true && dbNote2?.title === null && dbNote2?.note_text === `agg ${RUN}` && diffMin2 < 5, JSON.stringify(dbNote2));

  // N3: validazioni verbatim
  const v1 = await apiPost({ action: "note_save", note_date: D, note_text: "   " });
  check("N3 testo vuoto -> 'Il testo della nota e obbligatorio.'", err(v1) === "Il testo della nota e obbligatorio.", JSON.stringify(err(v1)));
  const v2 = await apiPost({ action: "note_save", note_date: "13/06/2027", note_text: "x" });
  check("N3b data non ISO -> 'Seleziona un giorno valido.'", err(v2) === "Seleziona un giorno valido.", JSON.stringify(err(v2)));
  const v3 = await apiPost({ action: "note_save", id: "999999", note_date: D, note_text: "x" });
  check("N3c edit id inesistente -> 'Nota non trovata.'", err(v3) === "Nota non trovata.", JSON.stringify(err(v3)));

  // N4: permessi — scrittura SOLO appointments.manage; senza calendar.view 403 secco
  const p1 = await apiPost({ action: "note_save", note_date: D, note_text: "x" }, viewOnlyCookie);
  check("N4 senza appointments.manage -> 403 'Permesso Appuntamenti richiesto.'", p1.status === 403 && err(p1) === "Permesso Appuntamenti richiesto.", JSON.stringify(err(p1)));
  const p2 = await apiGet(`&date=${D}`, noCalCookie);
  check("N4b senza calendar.view -> 403 'Permesso negato.'", p2.status === 403 && err(p2) === "Permesso negato.", JSON.stringify(err(p2)));
  const p3 = await apiPost({ action: "note_delete", id: String(note.id) }, viewOnlyCookie);
  check("N4c delete senza appointments.manage -> 403", p3.status === 403 && err(p3) === "Permesso Appuntamenti richiesto.", JSON.stringify(err(p3)));

  // N5: lista con count_by_date + intervallo non valido
  const l1 = await apiGet(`&action=notes&start=${D}&end=2027-07-01`);
  check("N5 lista note: nota presente, count_by_date", l1.j?.ok === true && (l1.j?.notes ?? []).some((n) => Number(n.id) === Number(note.id)) && Number(l1.j?.count_by_date?.[D] ?? 0) >= 1, JSON.stringify({ t: l1.j?.total, c: l1.j?.count_by_date }));
  const l2 = await apiGet(`&action=notes&start=${D}&end=${D}`);
  check("N5b end<=start -> 'Intervallo non valido.'", l2.status === 400 && err(l2) === "Intervallo non valido.", JSON.stringify(err(l2)));

  // N6: delete -> sparita
  const d1 = await apiPost({ action: "note_delete", id: String(note.id) });
  const gone = await q1("SELECT id FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, note.id]);
  check("N6 delete: ok e riga rimossa", d1.j?.ok === true && !gone, JSON.stringify(gone));
  if (!gone) noteIds.length = 0;

  // O1: ordine colonne — normalizzazione (dedup, >0, numeri) + JSON tollerante.
  // Contratto CLIENT-fedele: order è una STRINGA JSON (saveStaffOrder invia
  // JSON.stringify(ids), come il form legacy) — un array nel body non arriva.
  const o1 = await apiPost({ action: "set_calendar_day_staff_order", order: JSON.stringify([22, "22", 0, -5, "x", 56]) });
  check("O1 set ordine: normalizzato [22,56]", JSON.stringify(o1.j?.order) === "[22,56]", JSON.stringify(o1.j?.order));
  const o2 = await apiGet("&action=get_calendar_day_staff_order");
  check("O1b get ordine: [22,56]", JSON.stringify(o2.j?.order) === "[22,56]", JSON.stringify(o2.j?.order));
  const o3 = await apiPost({ action: "set_calendar_day_staff_order", order: "{corrotto" });
  check("O1c JSON corrotto tollerato -> []", JSON.stringify(o3.j?.order) === "[]", JSON.stringify(o3.j?.order));

  // C1: contesto — flag permessi e appuntamenti scopati alla sede
  const c1 = await apiGet(`&date=${D}`, viewOnlyCookie);
  check("C1 flag permessi: canManage=false/canCreate=false per view-only", c1.j?.canManageAppointments === false && c1.j?.canCreateAppointments === false, JSON.stringify({ m: c1.j?.canManageAppointments, c: c1.j?.canCreateAppointments }));

  // F (FIX fail-closed COMPLETO): sessione con sedi TUTTE revocate — né la
  // list né il context devono servire l'unione del tenant (check debole
  // locations-filtrata vs allLocations).
  function rawCookie(role, perms, locationIds, current) {
    const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
    return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
  }
  const revokedCookie = rawCookie("manager", ["calendar.view"], [9999], 9999);
  const admin0Cookie = rawCookie("admin", ["calendar.view"], [], 0);
  const f1 = await fetch(`${BASE}/api/manage/appointments?slug=${SLUG}&action=list&from=2026-01-01&to=2027-12-31`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("F1 list sedi revocate -> 0 eventi (fail-closed su allLocations)", Array.isArray(f1.appointments) && f1.appointments.length === 0, String((f1.appointments ?? []).length ?? f1.error));
  const f2 = await apiGet(`&date=${D}&start=2026-01-01&end=2027-12-31`, revokedCookie);
  check("F2 context sedi revocate -> 0 appuntamenti e 0 bande", (f2.j?.appointments ?? []).length === 0 && (f2.j?.staffUnavailability ?? []).length === 0, JSON.stringify({ a: (f2.j?.appointments ?? []).length, b: (f2.j?.staffUnavailability ?? []).length }));
  const f3 = await fetch(`${BASE}/api/manage/appointments?slug=${SLUG}&action=list&from=2026-01-01&to=2027-12-31`, { headers: { cookie: admin0Cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("F3 admin sede 0 multi-sede -> 0 eventi (selezione sede obbligatoria)", Array.isArray(f3.appointments) && f3.appointments.length === 0, String((f3.appointments ?? []).length ?? f3.error));
  const f4 = await apiGet(`&date=${D}&location_id=21&start=2026-01-01&end=2027-12-31`, admin0Cookie);
  check("F4 admin sede 0 con location_id=21 esplicito -> bande onorate", (f4.j?.staffUnavailability ?? []).some((b) => Number(b.staffId) === 22), JSON.stringify((f4.j?.staffUnavailability ?? []).length));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of noteIds) await q("DELETE FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  if (timeoffId) await q("DELETE FROM staff_timeoff WHERE tenant_id=$1 AND id=$2", [T, timeoffId]).catch(() => {});
  if (closureId) await q("DELETE FROM closures WHERE tenant_id=$1 AND id=$2", [T, closureId]).catch(() => {});
  await q("UPDATE users SET calendar_day_staff_order=$2 WHERE tenant_id=$1 AND id=20", [T, orderBackup]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const notes = Number((await q1("SELECT COUNT(*) n FROM calendar_notes WHERE tenant_id=$1", [T]))?.n);
  const rest = await q1("SELECT (SELECT COUNT(*) FROM staff_timeoff WHERE tenant_id=$1 AND reason='ZZ cal2') t, (SELECT COUNT(*) FROM closures WHERE tenant_id=$1 AND reason='ZZ chiusura cal2') c", [T]);
  const ord = (await q1("SELECT calendar_day_staff_order o FROM users WHERE tenant_id=$1 AND id=20", [T]))?.o ?? null;
  const clean = notes === 0 && Number(rest?.t) === 0 && Number(rest?.c) === 0 && ord === orderBackup;
  console.log(`CLEANUP: notes=${notes} timeoff=${rest?.t} closures=${rest?.c} orderRestored=${ord === orderBackup} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
