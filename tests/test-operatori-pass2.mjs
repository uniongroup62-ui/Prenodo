// Operatori pass 2-bis (2026-07-17) — FIX: (1) location_ids filtrati alle sedi
// ATTIVE (sede inesistente scartata, solo-invalide = errore), (2) save/delete
// ATOMICI in transazione (staff+users+staff_locations), (3) foto con MIME dai
// magic bytes. + riverifica guardie edit/disattivazione/delete e owner.
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
function makeCookie(user) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["staff.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] });
const mgrCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "manager", perms: ["staff.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [LOC] });

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function photoApi(fields) {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  const res = await fetch(`${BASE}/api/manage/staff-photo?slug=${SLUG}`, { method: "POST", headers: { cookie: adminCookie, "x-tenant-slug": SLUG }, body: form });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const NA = `ZZ OpP2A ${RUN}`, NB = `ZZ OpP2B ${RUN}`;
const EA = `zz.opp2a.${RUN}@example.com`, EA2 = `zz.opp2a2.${RUN}@example.com`, EB = `zz.opp2b.${RUN}@example.com`;

let staffA = 0, staffB = 0, userA = 0, userB = 0, cid = 0, apptId = 0, svcId = 0, cpId = 0;
const sedeName = (await q1("SELECT name FROM locations WHERE tenant_id=$1 AND id=$2", [T, LOC]))?.name ?? "Sede1";
const baseStaffIds = (await q("SELECT id FROM staff WHERE tenant_id=$1 ORDER BY id", [T])).rows.map((r) => Number(r.id));
const baseUserIds = (await q("SELECT id FROM users WHERE tenant_id=$1 ORDER BY id", [T])).rows.map((r) => Number(r.id));
const owner22 = await q1("SELECT full_name, phone, email, is_active, calendar_color FROM staff WHERE tenant_id=$1 AND id=22", [T]);
try {
  // S1: creazione completa
  const s1 = await api({ action: "staff_save", full_name: NA, email: EA, password: "Password1!", ui_role: "staff", is_active: "1", location_ids: String(LOC), calendar_color: "#112233" });
  staffA = Number((await q1("SELECT id FROM staff WHERE tenant_id=$1 AND full_name=$2", [T, NA]))?.id ?? 0);
  const uA = await q1("SELECT id, role, email_verified_at, name FROM users WHERE tenant_id=$1 AND LOWER(email)=$2", [T, EA]);
  userA = Number(uA?.id ?? 0);
  const slA = (await q("SELECT location_id FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2", [T, staffA])).rows.map((r) => Number(r.location_id));
  check("S1 create: staff + account (role staff, non verificato) + sede 21", s1.j?.ok === true && staffA > 0 && userA > 0 && uA.role === "staff" && uA.email_verified_at === null && JSON.stringify(slA) === "[21]", JSON.stringify({ ok: s1.j?.ok, e: s1.j?.error, u: uA, slA }));

  // P1 (FIX sedi): solo sede inesistente -> errore e NESSUNA scrittura
  const p1 = await api({ action: "staff_save", full_name: NB, email: EB, password: "Password1!", ui_role: "staff", is_active: "1", location_ids: "9999" });
  const bRow = Number((await q1("SELECT COUNT(*) n FROM staff WHERE tenant_id=$1 AND full_name=$2", [T, NB]))?.n ?? -1);
  check("P1 location_ids inesistente -> 'Seleziona almeno una sede per l'operatore.' senza scritture", p1.j?.ok === false && p1.j?.error === "Seleziona almeno una sede per l'operatore." && bRow === 0, JSON.stringify({ e: p1.j?.error, rows: bRow }));

  // P1b: sedi miste -> l'inesistente viene FILTRATA
  const p1b = await api({ action: "staff_save", full_name: NB, email: EB, password: "Password1!", ui_role: "staff", is_active: "1", location_ids: "21,9999" });
  staffB = Number((await q1("SELECT id FROM staff WHERE tenant_id=$1 AND full_name=$2", [T, NB]))?.id ?? 0);
  userB = Number((await q1("SELECT id FROM users WHERE tenant_id=$1 AND LOWER(email)=$2", [T, EB]))?.id ?? 0);
  const slB = (await q("SELECT location_id FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2 ORDER BY location_id", [T, staffB])).rows.map((r) => Number(r.location_id));
  check("P1b '21,9999' -> salvato SOLO con la sede 21", p1b.j?.ok === true && staffB > 0 && JSON.stringify(slB) === "[21]", JSON.stringify(slB));

  // P2: rename propaga a users.name; P2b cambio email STESSO account + reset verifica
  const p2 = await api({ action: "staff_save", id: String(staffA), full_name: `${NA} Ren`, email: EA, ui_role: "staff", is_active: "1", location_ids: String(LOC) });
  const uA2 = await q1("SELECT name FROM users WHERE tenant_id=$1 AND id=$2", [T, userA]);
  check("P2 rename in edit aggiorna users.name", p2.j?.ok === true && uA2?.name === `${NA} Ren`, JSON.stringify(uA2));
  await q("UPDATE users SET email_verified_at=NOW() WHERE tenant_id=$1 AND id=$2", [T, userA]);
  const p2b = await api({ action: "staff_save", id: String(staffA), full_name: `${NA} Ren`, email: EA2, ui_role: "staff", is_active: "1", location_ids: String(LOC) });
  const uA3 = await q1("SELECT id, email, email_verified_at FROM users WHERE tenant_id=$1 AND id=$2", [T, userA]);
  check("P2b cambio email: STESSO account, email nuova, verifica azzerata", p2b.j?.ok === true && uA3?.email === EA2 && uA3?.email_verified_at === null, JSON.stringify(uA3));

  // P3/P4: guardie con appuntamento APERTO agganciato via appointment_staff
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,$3,NOW()) RETURNING id", [T, `ZZ OpP2Cli ${RUN}`, LOC])).rows[0].id);
  apptId = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,$3,'2027-06-01 10:00','2027-06-01 11:00','scheduled',$4) RETURNING id", [T, cid, LOC, `ZZOP${RUN}`])).rows[0].id);
  await q("INSERT INTO appointment_staff (tenant_id, appointment_id, staff_id) VALUES ($1,$2,$3)", [T, apptId, staffA]);
  const p3 = await api({ action: "staff_save", id: String(staffA), full_name: `${NA} Ren`, email: EA2, ui_role: "staff", is_active: "1", location_ids: "51" });
  check("P3 rimozione sede con prenotazione aperta bloccata", p3.j?.ok === false && p3.j?.error === "Non puoi rimuovere questa sede: l'operatore ha prenotazioni in sospeso o prenotate collegate.", JSON.stringify(p3.j?.error));
  const p4 = await api({ action: "staff_save", id: String(staffA), full_name: `${NA} Ren`, email: EA2, ui_role: "staff", is_active: "0", location_ids: String(LOC) });
  check("P4 disattivazione con prenotazione aperta bloccata", p4.j?.ok === false && p4.j?.error === "Non puoi disattivare l'operatore: ha prenotazioni in sospeso o prenotate collegate.", JSON.stringify(p4.j?.error));

  // P5: unico operatore di un servizio attivo -> disattivazione bloccata col nome sede
  await q("UPDATE appointments SET status='done' WHERE tenant_id=$1 AND id=$2", [T, apptId]);
  svcId = Number((await q("INSERT INTO services (tenant_id, name, duration_min, price, sort_order, is_active, booking_enabled, no_operator) VALUES ($1,$2,30,10,0,1,0,0) RETURNING id", [T, `ZZ SvcOp ${RUN}`])).rows[0].id);
  await q("INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1,$2,$3)", [T, staffA, svcId]);
  await q("INSERT INTO service_locations (tenant_id, service_id, location_id) VALUES ($1,$2,$3)", [T, svcId, LOC]);
  const p5 = await api({ action: "staff_save", id: String(staffA), full_name: `${NA} Ren`, email: EA2, ui_role: "staff", is_active: "0", location_ids: String(LOC) });
  check("P5 disattivazione bloccata: servizio senza altri operatori nella sede", p5.j?.ok === false && p5.j?.error === `Non puoi disattivare l'operatore: il servizio "ZZ SvcOp ${RUN}" resterebbe senza operatori abilitati in "${sedeName}".`, JSON.stringify(p5.j?.error));

  // P6: catena guardie delete nell'ordine legacy
  await q("INSERT INTO appointment_staff (tenant_id, appointment_id, staff_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [T, apptId, staffA]);
  const p6a = await api({ action: "staff_delete", id: String(staffA) });
  check("P6a delete con storico prenotazioni bloccata", p6a.j?.ok === false && /risulta gia usato in prenotazioni/.test(String(p6a.j?.error)), JSON.stringify(p6a.j?.error));
  await q("DELETE FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]);
  const p6b = await api({ action: "staff_delete", id: String(staffA) });
  check("P6b delete con servizio collegato: popup con il servizio", p6b.j?.ok === false && p6b.j?.error === "Operatore non eliminabile: associato a uno o più servizi" && (p6b.j?.popup?.services ?? []).some((s) => s.service_name === `ZZ SvcOp ${RUN}`), JSON.stringify({ e: p6b.j?.error, p: p6b.j?.popup?.services }));
  await q("DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=$2", [T, staffA]);
  cpId = Number((await q("INSERT INTO staff_commission_payments (tenant_id, entry_key, staff_id, source_group, base_amount, percent_value, commission_amount, is_paid, entry_status) VALUES ($1,$2,$3,'sale',10,10,1,0,'pending') RETURNING id", [T, `ZZOPP2-${RUN}`, staffA])).rows[0].id);
  const p6c = await api({ action: "staff_delete", id: String(staffA) });
  check("P6c delete con storico commissioni bloccata", p6c.j?.ok === false && /storico commissioni/.test(String(p6c.j?.error)), JSON.stringify(p6c.j?.error));
  await q("DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2", [T, cpId]);
  cpId = 0;
  const p6d = await api({ action: "staff_delete", id: String(staffA) });
  const leftA = await q1("SELECT (SELECT COUNT(*) FROM staff WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM users WHERE tenant_id=$1 AND id=$3)+(SELECT COUNT(*) FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2) n", [T, staffA, userA]);
  check("P6d delete pulita: cascata atomica staff+account+sedi", p6d.j?.ok === true && Number(leftA?.n) === 0, JSON.stringify({ ok: p6d.j?.ok, left: leftA?.n }));
  if (p6d.j?.ok === true) { staffA = 0; userA = 0; }

  // P7: email duplicata -> flash VERDE (msg)
  const p7 = await api({ action: "staff_save", full_name: `ZZ OpP2C ${RUN}`, email: EB, password: "Password1!", ui_role: "staff", is_active: "1", location_ids: String(LOC) });
  check("P7 email duplicata -> 'Email già utilizzata' con flashKind msg", p7.j?.ok === false && p7.j?.error === "Email già utilizzata" && p7.j?.flashKind === "msg", JSON.stringify({ e: p7.j?.error, k: p7.j?.flashKind }));

  // P8 (FIX foto): magic bytes autoritativi
  const garbage = new File([Buffer.from("questo non e' un png")], "x.png", { type: "image/png" });
  const f1 = await photoApi([["staff_id", String(staffB)], ["operator_photo", garbage]]);
  check("P8a bytes non-immagine dichiarati png -> 'Formato immagine non supportato'", f1.j?.ok !== true && f1.j?.error === "Formato immagine non supportato", JSON.stringify(f1.j?.error));
  const bmp = new File([Buffer.concat([Buffer.from("BM"), Buffer.alloc(64)])], "x.png", { type: "image/png" });
  const f2 = await photoApi([["staff_id", String(staffB)], ["operator_photo", bmp]]);
  check("P8b BMP reale dichiarato png -> 'Formato non valido: carica JPG, PNG, WEBP o GIF'", f2.j?.ok !== true && f2.j?.error === "Formato non valido: carica JPG, PNG, WEBP o GIF", JSON.stringify(f2.j?.error));
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const png = new File([pngBytes], "x.bin", { type: "application/octet-stream" });
  const f3 = await photoApi([["staff_id", String(staffB)], ["operator_photo", png]]);
  const f3ok = f3.j?.ok === true || f3.status === 503;
  check("P8c PNG reale dichiarato octet-stream -> accettato dallo sniffing (o storage non configurato)", f3ok, JSON.stringify({ s: f3.status, e: f3.j?.error }));
  if (f3.j?.ok === true) await photoApi([["staff_id", String(staffB)], ["remove_photo", "1"]]);

  // P9: guardie ruolo/attore + SSO
  const p9 = await api({ action: "staff_save", full_name: "SSO", email: `zz.sso.${RUN}@example.com`, password: "Password1!", ui_role: "staff", is_active: "1", location_ids: String(LOC) });
  check("P9 nome 'SSO' riservato (flash msg)", p9.j?.ok === false && p9.j?.error === "Nome operatore riservato (SSO)" && p9.j?.flashKind === "msg", JSON.stringify(p9.j?.error));
  const p9b = await api({ action: "staff_save", full_name: `ZZ OpP2D ${RUN}`, email: `zz.opp2d.${RUN}@example.com`, password: "Password1!", ui_role: "admin", is_active: "1", location_ids: String(LOC) }, mgrCookie);
  check("P9b non-admin non assegna il ruolo Admin", p9b.j?.ok === false && p9b.j?.error === "Solo Admin puo assegnare il ruolo Admin.", JSON.stringify(p9b.j?.error));
  const p9c = await api({ action: "staff_save", id: "22", full_name: "luca", email: "info@artebrand.it", ui_role: "staff", is_active: "1", location_ids: String(LOC) }, mgrCookie);
  check("P9c non-admin non modifica account Admin", p9c.j?.ok === false && p9c.j?.error === "Solo Admin puo modificare account Admin.", JSON.stringify(p9c.j?.error));

  // P10: owner forzato attivo+admin anche postando il contrario
  const p10 = await api({ action: "staff_save", id: "22", full_name: owner22.full_name, phone: owner22.phone ?? "", email: owner22.email, ui_role: "staff", is_active: "0", location_ids: String(LOC), calendar_color: owner22.calendar_color ?? "" });
  const o2 = await q1("SELECT s.is_active, u.role FROM staff s JOIN users u ON u.tenant_id=s.tenant_id AND LOWER(u.email)=LOWER(s.email) WHERE s.tenant_id=$1 AND s.id=22", [T]);
  check("P10 owner: is_active/ruolo FORZATI (attivo+admin)", p10.j?.ok === true && Number(o2?.is_active) === 1 && o2?.role === "admin", JSON.stringify({ ok: p10.j?.ok, e: p10.j?.error, o: o2 }));
  const p11 = await api({ action: "staff_delete", id: "22" });
  check("P11 delete owner rifiutata", p11.j?.ok === false && p11.j?.error === "Admin non può essere eliminato", JSON.stringify(p11.j?.error));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (cpId) await q("DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2", [T, cpId]).catch(() => {});
  if (svcId) {
    await q("DELETE FROM staff_services WHERE tenant_id=$1 AND service_id=$2", [T, svcId]).catch(() => {});
    await q("DELETE FROM service_locations WHERE tenant_id=$1 AND service_id=$2", [T, svcId]).catch(() => {});
    await q("DELETE FROM services WHERE tenant_id=$1 AND id=$2", [T, svcId]).catch(() => {});
  }
  if (apptId) {
    await q("DELETE FROM appointment_staff WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  for (const sid of [staffA, staffB]) if (sid) {
    await q("DELETE FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2", [T, sid]).catch(() => {});
    await q("DELETE FROM staff WHERE tenant_id=$1 AND id=$2", [T, sid]).catch(() => {});
  }
  for (const uid of [userA, userB]) if (uid) {
    await q("DELETE FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]).catch(() => {});
    await q("DELETE FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]).catch(() => {});
  }
  const finStaff = (await q("SELECT id FROM staff WHERE tenant_id=$1 ORDER BY id", [T])).rows.map((r) => Number(r.id));
  const finUsers = (await q("SELECT id FROM users WHERE tenant_id=$1 ORDER BY id", [T])).rows.map((r) => Number(r.id));
  const okBase = JSON.stringify(finStaff) === JSON.stringify(baseStaffIds) && JSON.stringify(finUsers) === JSON.stringify(baseUserIds);
  console.log(`CLEANUP: baseline=${okBase ? "OK" : "DIVERSA " + JSON.stringify({ finStaff, finUsers })} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
