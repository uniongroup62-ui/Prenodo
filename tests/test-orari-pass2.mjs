// Orari pass 2 (2026-07-17) — FIX transazione+upsert nativo su orari/chiusure/
// straordinari (ON CONFLICT sugli indici univoci, semantica ON DUPLICATE KEY
// legacy). + riverifica validazioni aggregate, conflitti incrociati, delete
// range con filtro reason, fallback globale NULL, guardia sede (ripiego).
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 51;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
function makeCookie(user) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["hours.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] });
const mgrCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "manager", perms: ["hours.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [21] });

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");

const HOURS = (over = {}) => {
  const base = {
    0: { is_closed: "1" },
    1: { opens: "08:30", closes: "18:30" },
    2: { opens: "09:00", closes: "13:00", opens2: "14:00", closes2: "19:00" },
    3: { opens: "09:00", closes: "19:00" },
    4: { opens: "09:00", closes: "19:00" },
    5: { opens: "09:00", closes: "19:00" },
    6: { opens: "09:00", closes: "13:00" },
  };
  Object.assign(base, over);
  return JSON.stringify(Object.entries(base).map(([dow, r]) => ({ dow: Number(dow), ...r })));
};

let cid = 0, apptId = 0;
// Watermark log: dal 17/07 le azioni orari LOGGANO — a fine run si eliminano
// le righe module='orari' create da questa sessione (id > watermark).
const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const pre = await q1("SELECT (SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1 AND location_id=$2)::int bh,(SELECT COUNT(*) FROM closures WHERE tenant_id=$1 AND location_id=$2)::int cl,(SELECT COUNT(*) FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2)::int ex", [T, LOC]);
try {
  if (pre.bh !== 0 || pre.cl !== 0 || pre.ex !== 0) throw new Error(`Sede ${LOC} non vergine: ${JSON.stringify(pre)} — probe abortito`);

  // H1: save orari -> 7 righe upsertate per la sede 51
  const h1 = await api({ action: "hours_save", location_id: String(LOC), hours_json: HOURS() });
  const rows1 = (await q("SELECT dow, opens::text o, closes::text c, opens2::text o2, closes2::text c2, is_closed FROM business_hours WHERE tenant_id=$1 AND location_id=$2 ORDER BY dow", [T, LOC])).rows;
  check("H1 hours_save crea le 7 righe della sede (spezzato incluso)", h1.j?.ok === true && rows1.length === 7 && rows1[1].o === "08:30:00" && rows1[2].o2 === "14:00:00" && Number(rows1[0].is_closed) === 1, JSON.stringify(rows1.slice(0, 3)));

  // H2: ri-save con valori diversi -> UPDATE via ON CONFLICT (sempre 7 righe)
  const h2 = await api({ action: "hours_save", location_id: String(LOC), hours_json: HOURS({ 1: { opens: "10:00", closes: "17:00" } }) });
  const rows2 = (await q("SELECT COUNT(*)::int n, MIN(opens::text) FILTER (WHERE dow=1) o FROM business_hours WHERE tenant_id=$1 AND location_id=$2", [T, LOC])).rows[0];
  check("H2 ri-save: upsert aggiorna (7 righe, lun 10:00)", h2.j?.ok === true && rows2.n === 7 && rows2.o === "10:00:00", JSON.stringify(rows2));

  // H3: validazione aggregata '; ' con wrapper e etichetta giorno
  const h3 = await api({ action: "hours_save", location_id: String(LOC), hours_json: HOURS({ 1: { opens: "10:00", closes: "" }, 2: { opens: "19:00", closes: "09:00" } }) });
  check("H3 errori aggregati 'Orari non validi: ...; ...'", h3.j?.ok !== true && err(h3).startsWith("Orari non validi: ") && err(h3).includes("; ") && err(h3).includes("apertura e chiusura") && err(h3).includes("successiva"), JSON.stringify(err(h3)));

  // H4: (int) PHP — 'aa:bb' = 00:00 accettato e SALVATO 00:00 (chiusura > apertura)
  const h4 = await api({ action: "hours_save", location_id: String(LOC), hours_json: HOURS({ 3: { opens: "aa:bb", closes: "19:00" } }) });
  const dow3 = await q1("SELECT opens::text o FROM business_hours WHERE tenant_id=$1 AND location_id=$2 AND dow=3", [T, LOC]);
  check("H4 quirk (int) PHP: 'aa:bb' -> 00:00 salvato", h4.j?.ok === true && dow3?.o === "00:00:00", JSON.stringify({ ok: h4.j?.ok, e: err(h4), o: dow3?.o }));

  // C1: chiusura 3 giorni + ri-save con reason diverso -> UPDATE non duplica
  const c1 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-08-10", date_to: "2027-08-12", kind: "Ferie", note: "estive" });
  const c1b = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-08-10", date_to: "2027-08-12", kind: "Chiusura", note: "" });
  const cl1 = (await q("SELECT date::text d, reason FROM closures WHERE tenant_id=$1 AND location_id=$2 ORDER BY date", [T, LOC])).rows;
  check("C1 chiusura upsert: 3 righe, reason aggiornato a 'Chiusura'", c1.j?.ok === true && c1b.j?.ok === true && cl1.length === 3 && cl1.every((r) => r.reason === "Chiusura"), JSON.stringify(cl1));

  // C2: chiusura su data con straordinario -> conflitto d/m/Y
  await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-08-20", opens: "10:00", closes: "14:00", note: "zz" });
  const c2 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-08-20" });
  check("C2 chiusura su straordinario -> conflitto con data 20/08/2027", c2.j?.ok !== true && err(c2).includes("esistono già aperture straordinarie nelle seguenti date: 20/08/2027") && err(c2).includes("Rimuovi prima lo straordinario"), JSON.stringify(err(c2)));

  // C3: chiusura su data con appuntamento attivo
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,$3,NOW()) RETURNING id", [T, "ZZ OrariCli P2", LOC])).rows[0].id);
  apptId = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-08-25 10:00','2027-08-25 11:00','scheduled','ZZOR27') RETURNING id", [T, cid, LOC])).rows[0].id);
  const c3 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-08-25" });
  check("C3 chiusura su appuntamento attivo bloccata (25/08/2027)", c3.j?.ok !== true && err(c3).includes("esistono appuntamenti in sospeso o prenotati nelle seguenti date: 25/08/2027") && err(c3).includes("Sposta o annulla prima gli appuntamenti."), JSON.stringify(err(c3)));

  // E1: straordinario su data chiusa -> bloccato
  const e1 = await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-08-11", opens: "10:00", closes: "12:00" });
  check("E1 straordinario su data chiusa -> 'le seguenti date sono impostate come chiuse: 11/08/2027'", e1.j?.ok !== true && err(e1).includes("le seguenti date sono impostate come chiuse: 11/08/2027") && err(e1).includes("tab Chiusure"), JSON.stringify(err(e1)));

  // E2: straordinario upsert (ri-save stessa data con orario diverso)
  await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-08-20", opens: "09:00", closes: "15:00", note: "agg" });
  const ex1 = (await q("SELECT COUNT(*)::int n, MIN(opens::text) o, MIN(note) nt FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2 AND date='2027-08-20'", [T, LOC])).rows[0];
  check("E2 straordinario upsert: 1 riga aggiornata (09:00, note 'agg')", ex1.n === 1 && ex1.o === "09:00:00" && ex1.nt === "agg", JSON.stringify(ex1));

  // E3: errori standalone aggregati con spazio, wrapper 'Impossibile salvare: '
  const e3 = await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-09-01", opens: "15:00", closes: "10:00", opens2: "16:00", closes2: "" });
  check("E3 errori aggregati con spazio (chiusura successiva + spezzato incompleto)", e3.j?.ok !== true && err(e3).startsWith("Impossibile salvare: ") && err(e3).includes("La chiusura deve essere successiva all'apertura.") && err(e3).includes("Per l'orario spezzato devi compilare sia riapertura sia chiusura 2."), JSON.stringify(err(e3)));

  // D1: delete_range chiusure con filtro reason NON combaciante -> 0 rimozioni
  const d1 = await api({ action: "closure_delete_range", location_id: String(LOC), from: "2027-08-10", to: "2027-08-12", reason: "Ferie - estive" });
  const clAfterD1 = Number((await q1("SELECT COUNT(*) n FROM closures WHERE tenant_id=$1 AND location_id=$2", [T, LOC]))?.n);
  check("D1 delete_range con reason sbagliato non elimina nulla", d1.j?.ok === true && clAfterD1 === 3, `n=${clAfterD1}`);
  // D2: reason giusto -> eliminate; date invertite accettate (swap)
  const d2 = await api({ action: "closure_delete_range", location_id: String(LOC), from: "2027-08-12", to: "2027-08-10", reason: "Chiusura" });
  const clAfterD2 = Number((await q1("SELECT COUNT(*) n FROM closures WHERE tenant_id=$1 AND location_id=$2", [T, LOC]))?.n);
  check("D2 delete_range reason 'Chiusura' + date invertite -> 0 residue", d2.j?.ok === true && clAfterD2 === 0, `n=${clAfterD2}`);
  // D3: delete_range straordinari
  const d3 = await api({ action: "exception_delete_range", location_id: String(LOC), from: "2027-08-20", to: "2027-08-20" });
  const exAfter = Number((await q1("SELECT COUNT(*) n FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2", [T, LOC]))?.n);
  check("D3 exception_delete_range elimina lo straordinario", d3.j?.ok === true && exAfter === 0, `n=${exAfter}`);

  // G1: guardia sede — manager ristretto a 21 posta sede 51 -> ripiego DOCUMENTATO
  // sulla sede di sessione (21): la 51 NON viene toccata.
  const g1 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-09-15", kind: "Ferie" }, mgrCookie);
  const leak51 = Number((await q1("SELECT COUNT(*) n FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date='2027-09-15'", [T, LOC]))?.n);
  const wrote21 = Number((await q1("SELECT COUNT(*) n FROM closures WHERE tenant_id=$1 AND location_id=21 AND date='2027-09-15'", [T]))?.n);
  check("G1 manager ristretto: la sede 51 NON viene scritta (ripiego sede sessione 21)", leak51 === 0 && wrote21 === 1 && g1.j?.ok === true, JSON.stringify({ leak51, wrote21 }));
  await q("DELETE FROM closures WHERE tenant_id=$1 AND location_id=21 AND date='2027-09-15'", [T]);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("DELETE FROM business_hours WHERE tenant_id=$1 AND location_id=$2", [T, LOC]).catch(() => {});
  await q("DELETE FROM closures WHERE tenant_id=$1 AND location_id=$2", [T, LOC]).catch(() => {});
  await q("DELETE FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2", [T, LOC]).catch(() => {});
  await q("DELETE FROM closures WHERE tenant_id=$1 AND location_id=21 AND date='2027-09-15'", [T]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='orari' AND id > $2", [T, logWatermark]).catch(() => {});
  if (apptId) await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1 AND location_id=$2)::int bh,(SELECT COUNT(*) FROM closures WHERE tenant_id=$1 AND location_id=$2)::int cl,(SELECT COUNT(*) FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2)::int ex,(SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1)::int tot", [T, LOC]);
  const okBase = fin.bh === 0 && fin.cl === 0 && fin.ex === 0 && fin.tot === 14;
  console.log(`CLEANUP: sede51 azzerata, business_hours totali=${fin.tot} -> ${okBase ? "CLEAN" : "DIRTY!! " + JSON.stringify(fin)}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
