// Automazioni pass 2 (2026-07-17) — FIX TZ: finestra futura della
// rischedulazione e dueness del cron su ORA LOCALE (era NOW() UTC: promemoria
// in ritardo di 2h e appuntamenti passati rischedulati). + riverifica save
// (ore whitelist, sender Prenodo, testi default), upsert per-canale, toggle
// OFF=clear, fallback ore SMS, gate fidelity.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["automation.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/automation?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
// Ora di Roma wall-time (equivalente businessNowDateTime del server)
function rome(deltaMin = 0, seconds = true) {
  const d = new Date(Date.now() + deltaMin * 60000);
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d).replace("T", " ");
  return seconds ? s : s.slice(0, 16);
}

const settingsSnap = await q1("SELECT * FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
// SNAPSHOT COMPLETO delle pending di produzione: il save della pagina
// rischedula TUTTI gli appuntamenti futuri del tenant (comportamento legacy),
// quindi a fine run le righe vengono ripristinate byte-uguali (id a parte).
const pendingSnap = (await q("SELECT appointment_id, channel, scheduled_at::text sa FROM reminders WHERE tenant_id=$1 AND status='pending' ORDER BY appointment_id, channel", [T])).rows;
const basePending = pendingSnap.length;
let cid = 0, apptFut = 0, apptPast = 0, dueRowId = 0;
const SAVE = (over = {}) => api({ action: "save", reminder_enabled: "1", reminder_hours: "24", sms_reminder_enabled: "1", sms_reminder_hours: "24", approved_enabled: "1", modified_enabled: "1", rejected_enabled: "1", ...over });
try {
  // Fixture: cliente con email+telefono, appt FUTURO (+30h) e appt INIZIATO 1h fa
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, phone, location_id, created_at) VALUES ($1,$2,$3,'3331234567',$4,NOW()) RETURNING id", [T, `ZZ AutoCli ${RUN}`, `zz.auto.${RUN}@example.com`, LOC])).rows[0].id);
  const futStart = rome(30 * 60);
  apptFut = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,$4,$5,'scheduled',$6) RETURNING id", [T, cid, LOC, futStart, rome(31 * 60), `ZZAU${RUN}`])).rows[0].id);
  apptPast = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,$4,$5,'scheduled',$6) RETURNING id", [T, cid, LOC, rome(-60), rome(30), `ZZAP${RUN}`])).rows[0].id);

  // S1: GET pagina
  const g = await fetch(`${BASE}/api/manage/automation?slug=${SLUG}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  const gj = await g.json();
  check("S1 GET: settings + esempio SMS con conteggio segmenti", gj.ok === true && typeof gj.settings?.reminder_hours === "number" && gj.page?.smsExampleSegments >= 1 && /credito|crediti/.test(String(gj.page?.smsExampleCreditsLabel)), JSON.stringify({ h: gj.settings?.reminder_hours, seg: gj.page?.smsExampleSegments }));

  // S2: save 24h email+sms -> schedula SOLO il futuro (TZ: il passato è escluso)
  const s2 = await SAVE();
  const remFut = (await q("SELECT channel, scheduled_at::text sa, status FROM reminders WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY channel", [T, apptFut])).rows;
  const remPast = Number((await q1("SELECT COUNT(*) n FROM reminders WHERE tenant_id=$1 AND appointment_id=$2", [T, apptPast]))?.n);
  const expected24 = `${futStart.slice(0, 13)}`; // stessa ora del giorno prima: verifica sulle date sotto
  const expSched = (h) => {
    const d = new Date(Date.parse(futStart.replace(" ", "T")) - h * 3600000); // parse local
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  check("S2 save: email+sms pending sul futuro con scheduled_at = inizio-24h LOCALE", s2.j?.ok === true && s2.j?.message === "Automazione salvata" && remFut.length === 2 && remFut.every((r) => r.status === "pending") && remFut.every((r) => String(r.sa).slice(0, 16) === expSched(24)), JSON.stringify({ remFut, exp: expSched(24) }));
  check("S2b TZ: l'appuntamento INIZIATO 1h fa NON viene rischedulato (niente promemoria spurio)", remPast === 0, `rows=${remPast}`);

  // S3: ore 12 -> UPSERT delle stesse righe (no duplicati) con nuova scheduled_at
  await SAVE({ reminder_hours: "12", sms_reminder_hours: "12" });
  const remFut12 = (await q("SELECT channel, scheduled_at::text sa FROM reminders WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY channel", [T, apptFut])).rows;
  check("S3 upsert: sempre 2 righe, scheduled_at = inizio-12h", remFut12.length === 2 && remFut12.every((r) => String(r.sa).slice(0, 16) === expSched(12)), JSON.stringify(remFut12));

  // S4: ore INVALIDE -> whitelist fallback (7 -> 24; sms 99 -> ore email)
  await SAVE({ reminder_hours: "7", sms_reminder_hours: "99" });
  const s4row = await q1("SELECT reminder_hours, sms_reminder_hours, sms_reminder_sender, approved_subject FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  check("S4 whitelist ore: 7->24, sms 99->24; sender 'Prenodo'; testi default riscritti", Number(s4row.reminder_hours) === 24 && Number(s4row.sms_reminder_hours) === 24 && s4row.sms_reminder_sender === "Prenodo" && s4row.approved_subject === "Appuntamento approvato", JSON.stringify(s4row));

  // S5: fidelity toggle gated dalla config tessera (config NON ok -> resta 0)
  const s5 = await SAVE({ fidelity_expiry_reminder_enabled: "1" });
  const s5row = await q1("SELECT fidelity_expiry_reminder_enabled FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  const cfgOk = s5.j?.settings?.fidelity_expiry_reminder_enabled === true;
  check("S5 fidelity gated dalla config tessera (flag = configOk && toggle)", s5.j?.ok === true && (cfgOk ? Number(s5row.fidelity_expiry_reminder_enabled) === 1 : Number(s5row.fidelity_expiry_reminder_enabled) === 0), JSON.stringify({ db: s5row, api: s5.j?.settings?.fidelity_expiry_reminder_enabled }));

  // S6: toggle OFF entrambi -> CLEAR delle pending (non skip)
  await SAVE({ reminder_enabled: "0", sms_reminder_enabled: "0" });
  const remOff = Number((await q1("SELECT COUNT(*) n FROM reminders WHERE tenant_id=$1 AND appointment_id=$2 AND status='pending'", [T, apptFut]))?.n);
  check("S6 toggle OFF = CLEAR pending del futuro", remOff === 0, `rows=${remOff}`);

  // D1: replica della dueness del cron — riga schedulata 30' fa (LOCALE):
  // con il confronto FIXATO (<= ora Roma) è due; col vecchio NOW() UTC no.
  await SAVE({ reminder_hours: "24", sms_reminder_enabled: "0" });
  dueRowId = Number((await q("INSERT INTO reminders (tenant_id, appointment_id, channel, scheduled_at, status) VALUES ($1,$2,'email',$3,'pending') RETURNING id", [T, apptFut, rome(-30)])).rows[0].id);
  const dueFixed = Number((await q1("SELECT COUNT(*) n FROM reminders WHERE tenant_id=$1 AND id=$2 AND status='pending' AND scheduled_at <= $3", [T, dueRowId, rome(0)]))?.n);
  const dueLegacyUtc = Number((await q1("SELECT COUNT(*) n FROM reminders WHERE tenant_id=$1 AND id=$2 AND status='pending' AND scheduled_at <= NOW()", [T, dueRowId]))?.n);
  check("D1 dueness: <= ora-Roma la becca SUBITO; <= NOW() UTC l'avrebbe vista solo 2h dopo", dueFixed === 1 && dueLegacyUtc === 0, JSON.stringify({ dueFixed, dueLegacyUtc }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const a of [apptFut, apptPast]) if (a) {
    await q("DELETE FROM reminders WHERE tenant_id=$1 AND appointment_id=$2", [T, a]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, a]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  if (settingsSnap) {
    const cols = Object.keys(settingsSnap).filter((k) => k !== "id" && k !== "tenant_id");
    const sets = cols.map((c, i) => `"${c}" = $${i + 3}`).join(", ");
    await q(`UPDATE automation_settings SET ${sets} WHERE tenant_id=$1 AND id=$2`, [T, settingsSnap.id, ...cols.map((c) => settingsSnap[c])]).catch(() => {});
  }
  // Ripristino BYTE-uguale delle pending di produzione (i save hanno
  // rischedulato/resettato le righe di tutto il tenant).
  await q("DELETE FROM reminders WHERE tenant_id=$1 AND status='pending'", [T]).catch(() => {});
  for (const r of pendingSnap) {
    await q("INSERT INTO reminders (tenant_id, appointment_id, channel, scheduled_at, status) VALUES ($1,$2,$3,$4,'pending')", [T, r.appointment_id, r.channel, r.sa]).catch(() => {});
  }
  const finRows = (await q("SELECT appointment_id, channel, scheduled_at::text sa FROM reminders WHERE tenant_id=$1 AND status='pending' ORDER BY appointment_id, channel", [T])).rows;
  const finH = await q1("SELECT reminder_hours::int h, sms_reminder_enabled::int s FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  const okBase = JSON.stringify(finRows) === JSON.stringify(pendingSnap) && finH.h === Number(settingsSnap?.reminder_hours) && finH.s === Number(settingsSnap?.sms_reminder_enabled);
  console.log(`CLEANUP: pending=${finRows.length}/${basePending} settings ripristinate=${okBase} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
