// Servizi pass 2 (2026-07-17) — SEQUENZA dei pannelli di conferma su un edit
// che cambia nome+prezzo con appuntamento aperto: name_update -> price_update
// -> impacted_appointments -> save; SNAPSHOT-FREEZE (appointment_services
// conserva nome/prezzo storici, il catalogo si aggiorna). + delete categoria
// default protetta.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["services.manage", "service_categories.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/services?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let svcId = 0, cid = 0, apptId = 0, defCatId = 0;
const SAVE = (over = {}) => ({ action: "save", name: `ZZ SvcP2 ${RUN}`, duration_min: "30", price: "50", category_id: "", is_active: "1", booking_enabled: "0", no_operator: "1", location_ids: String(LOC), cabin_ids: "9", ...over });
try {
  const s1 = await api(SAVE());
  svcId = Number((await q1("SELECT id FROM services WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ SvcP2 ${RUN}`]))?.id ?? 0);
  check("S1 servizio creato (50€)", s1.j?.ok === true && svcId > 0, JSON.stringify(s1.j?.error ?? "").slice(0, 120));

  // Appuntamento APERTO con snapshot riga (nome+prezzo storici)
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ SvcP2Cli ${RUN}`])).rows[0].id);
  apptId = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, service_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,$4,'2027-06-01 10:00','2027-06-01 11:00','scheduled',$5) RETURNING id", [T, cid, LOC, svcId, `ZZSP2${RUN}`])).rows[0].id);
  await q("INSERT INTO appointment_services (tenant_id, appointment_id, service_id, service_name, qty, price) VALUES ($1,$2,$3,$4,1,50)", [T, apptId, svcId, `ZZ SvcP2 ${RUN}`]);

  // Edit nome+prezzo: sequenza pannelli
  // Durata cambiata (30->45) per innescare ANCHE il pannello impacted_appointments
  // (scatta solo per Durata/Cabine/Operatori/Risorse, non per nome/prezzo).
  const edit = SAVE({ id: String(svcId), name: `ZZ SvcP2 ${RUN} NUOVO`, price: "60", duration_min: "45" });
  const p1 = await api(edit);
  check("P1 primo pannello: name_update", p1.j?.pending?.kind === "name_update", JSON.stringify(p1.j?.pending?.kind ?? p1.j?.error));
  const p2 = await api({ ...edit, confirm_service_name_update: "1" });
  check("P2 secondo pannello: price_update (50 -> 60)", p2.j?.pending?.kind === "price_update" && Number(p2.j?.pending?.oldPrice) === 50 && Number(p2.j?.pending?.newPrice) === 60, JSON.stringify({ k: p2.j?.pending?.kind, o: p2.j?.pending?.oldPrice, n: p2.j?.pending?.newPrice }));
  const p3 = await api({ ...edit, confirm_service_name_update: "1", confirm_service_price_update: "1" });
  check("P3 terzo pannello: impacted_appointments con la prenotazione", p3.j?.pending?.kind === "impacted_appointments" && (p3.j?.pending?.appointments ?? []).some((a) => a.publicCode === `ZZSP2${RUN}`), JSON.stringify(p3.j?.pending?.kind));
  const p4 = await api({ ...edit, confirm_service_name_update: "1", confirm_service_price_update: "1", confirm_impacted_appointments: "1" });
  check("P4 tutte confermate: salvato", p4.j?.ok === true && !p4.j?.pending, JSON.stringify(p4.j?.pending ?? p4.j?.error ?? "").slice(0, 100));

  // SNAPSHOT-FREEZE: catalogo aggiornato, riga appuntamento CONGELATA
  const cat = await q1("SELECT name, price::float p FROM services WHERE tenant_id=$1 AND id=$2", [T, svcId]);
  const snap = await q1("SELECT service_name, price::float p FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]);
  check("F1 catalogo aggiornato (nome NUOVO, 60€)", cat.name === `ZZ SvcP2 ${RUN} NUOVO` && cat.p === 60, JSON.stringify(cat));
  // Legacy 4555: la conferma name_update PROPAGA il nome agli snapshot
  // (svc_apply_service_name_snapshot_updates); il PREZZO resta congelato.
  check("F2 snapshot: nome PROPAGATO, prezzo CONGELATO a 50", snap.service_name === `ZZ SvcP2 ${RUN} NUOVO` && snap.p === 50, JSON.stringify(snap));

  // Delete servizio con appuntamento aperto: pannello/blocco? (delete_blockers)
  const d1 = await api({ action: "delete", id: String(svcId) });
  check("D1 delete con prenotazione aperta RIFIUTATA (blockers)", d1.j?.ok !== true, JSON.stringify(d1.j?.error ?? "").slice(0, 140));
  // Chiudo l'appuntamento e riprovo
  await q("UPDATE appointments SET status='done' WHERE tenant_id=$1 AND id=$2", [T, apptId]);
  const d2 = await api({ action: "delete", id: String(svcId) });
  check("D2 delete dopo la chiusura ok", d2.j?.ok === true, JSON.stringify(d2.j?.error ?? "").slice(0, 140));
  if (d2.j?.ok === true) svcId = 0;

  // Categoria default protetta (creo/uso la PIU' RECENTE e la pulisco a fine run).
  // NOTA 17/07: il port ora BLOCCA i duplicati di nome in creazione (miglioria
  // approvata, diverge dal legacy 3648): questo create funziona solo perché la
  // baseline non ha "Non categorizzato" — se mai esistesse, adattare il probe.
  const cd = await api({ action: "category_save", name: "Non categorizzato" });
  defCatId = Number((await q1("SELECT id FROM service_categories WHERE tenant_id=$1 AND LOWER(name)='non categorizzato' ORDER BY id DESC LIMIT 1", [T]))?.id ?? 0);
  const cdel = await api({ action: "category_delete", id: String(defCatId) });
  check("C1 categoria default NON eliminabile", defCatId > 0 && cdel.j?.ok !== true && /Non puoi eliminare la categoria di default/.test(String(cdel.j?.error ?? "")), JSON.stringify({ ok: cd.j?.ok, err: cdel.j?.error }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) {
    await q("DELETE FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  if (svcId) {
    await q("DELETE FROM service_locations WHERE tenant_id=$1 AND service_id=$2", [T, svcId]).catch(() => {});
    await q("DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id=$2", [T, svcId]).catch(() => {});
    await q("DELETE FROM services WHERE tenant_id=$1 AND id=$2", [T, svcId]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  if (defCatId) await q("DELETE FROM service_categories WHERE tenant_id=$1 AND id=$2", [T, defCatId]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='servizi' AND (label LIKE $2 OR label LIKE '%Non categorizzato%')", [T, `%ZZ SvcP2%`]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM services WHERE tenant_id=$1 AND name LIKE $2)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$3) n", [T, `ZZ SvcP2%`, cid || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
