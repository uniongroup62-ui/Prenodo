// Verifica del confirm pubblico ATOMICO (2026-07-20): l'aggregato appuntamento
// (riga + servizi + segmenti + sede) nasce in una withTenantTransaction.
// B1: happy path completo via API pubblica; B2: nessuna riga orfana su slot
// occupato (il confirm rifiuta PRIMA di scrivere); cleanup per id tracciati.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const SLUG = "centroesteticoelite";
const TID = 25;
const LOC = 21;
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.booktx${RUN}@example.test`;
let apptId = 0, clientId = 0;

try {
  // servizio prenotabile del tenant (visibile in booking)
  const svc = (await db.query(
    "SELECT id, duration_min FROM services WHERE tenant_id=$1 AND COALESCE(is_active,1)=1 ORDER BY id LIMIT 1", [TID],
  )).rows[0];
  if (!svc) throw new Error("nessun servizio attivo per il tenant di prova");
  const serviceId = Number(svc.id);

  // slot disponibile su un giorno futuro (salta i giorni chiusi)
  let date = "", time = "";
  for (let ahead = 2; ahead <= 9 && !time; ahead++) {
    const d = new Date(); d.setDate(d.getDate() + ahead);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const res = await (await fetch(`${BASE}/api/booking?action=slots&slug=${SLUG}&date=${iso}&service_ids=${serviceId}&location_id=${LOC}`)).json();
    const free = (res.slots ?? []).find((s) => s.available);
    if (free) { date = iso; time = free.time; }
  }
  if (!time) throw new Error("nessuno slot libero trovato in 8 giorni");

  // B1: confirm senza hold -> aggregato completo
  const conf = await (await fetch(`${BASE}/api/booking`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ slug: SLUG, action: "confirm", date, time, service_ids: [serviceId], location_id: LOC, client_name: `ZZ BookTx ${RUN}`, client_email: EMAIL, client_phone: "3330000001" }),
  })).json();
  apptId = Number(conf?.confirmation?.id ?? conf?.id ?? 0);
  clientId = Number(conf?.confirmation?.clientId ?? conf?.clientId ?? 0);
  check("B1 confirm API ok con id appuntamento", Boolean(conf?.ok) && apptId > 0, `id=${apptId} client=${clientId} ${conf?.error ?? ""}`);

  const cnt = async (t) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [TID, apptId])).rows[0].n);
  const appt = (await db.query("SELECT status FROM appointments WHERE tenant_id=$1 AND id=$2", [TID, apptId])).rows[0];
  const [nSvc, nSeg, nLoc] = [await cnt("appointment_services"), await cnt("appointment_segments"), await cnt("appointment_locations")];
  check("B1 aggregato completo in DB (servizi+segmenti+sede, status pending)", appt?.status === "pending" && nSvc === 1 && nSeg === 1 && nLoc === 1, `status=${appt?.status} svc=${nSvc} seg=${nSeg} loc=${nLoc}`);

  // B2: stesso slot ora occupato -> il confirm DEVE rifiutare senza scrivere nulla
  const before = Number((await db.query("SELECT COALESCE(MAX(id),0) AS m FROM appointments WHERE tenant_id=$1", [TID])).rows[0].m);
  const dup = await (await fetch(`${BASE}/api/booking`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ slug: SLUG, action: "confirm", date, time, service_ids: [serviceId], location_id: LOC, client_name: `ZZ BookTx dup ${RUN}`, client_email: `zz.booktxdup${RUN}@example.test`, client_phone: "3330000002" }),
  })).json();
  const after = Number((await db.query("SELECT COALESCE(MAX(id),0) AS m FROM appointments WHERE tenant_id=$1", [TID])).rows[0].m);
  check("B2 slot occupato: rifiuto senza scritture", dup?.ok === false && after === before, `ok=${dup?.ok} err=${String(dup?.error ?? "").slice(0, 40)} max ${before}->${after}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try {
    if (apptId) {
      for (const t of ["appointment_services", "appointment_segments", "appointment_staff", "appointment_locations"]) {
        await db.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [TID, apptId]).catch(() => {});
      }
      await db.query("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [TID, apptId]).catch(() => {});
    }
    if (clientId) await db.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [TID, clientId]).catch(() => {});
    // account cliente-pubblico creato dal confirm (tracciato per email della run)
    const acc = (await db.query("SELECT id FROM public_customer_accounts WHERE LOWER(email)=LOWER($1)", [EMAIL])).rows[0];
    if (acc) {
      await db.query("DELETE FROM public_customer_links WHERE account_id=$1", [acc.id]).catch(() => {});
      await db.query("DELETE FROM public_customer_sessions WHERE account_id=$1", [acc.id]).catch(() => {});
      await db.query("DELETE FROM public_customer_accounts WHERE id=$1", [acc.id]).catch(() => {});
    }
    console.log("CLEANUP: ok (appuntamento, cliente, account per id/email tracciati)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
