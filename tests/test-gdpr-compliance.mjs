// GDPR compliance (audit 2026-07-21): pagine legali, consenso obbligatorio su
// booking pubblico e registrazione area clienti (con prova timestamp/IP),
// export dati cliente (do=gdpr_export), throttle login clienti, min password 8,
// cascata delete con documenti presenti. Cleanup SOLO per id tracciati.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const SLUG = "centroesteticoelite";
const TID = 25;
const LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

const perms = ["clients.manage", "client_consents.manage", "client_sheets.manage"];
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const ADMIN_COOKIE = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

let apptId = 0, bookClientId = 0, accId = 0, throttleAccId = 0, expClientId = 0, delClientId = 0;
const BOOK_EMAIL = `zz.gdprbook${RUN}@example.test`;
const REG_EMAIL = `zz.gdprreg${RUN}@example.test`;
const THR_EMAIL = `zz.gdprthr${RUN}@example.test`;

try {
  // ===== 1. Pagine legali =====
  for (const doc of ["privacy", "cookie", "termini", "note-legali"]) {
    const res = await fetch(`${BASE}/legal/${doc}`);
    const html = await res.text();
    check(`L pagine legali /legal/${doc} 200 + contenuto`, res.status === 200 && /Prenodo/.test(html) && /legal-body/.test(html), `status=${res.status}`);
  }
  const attivita = await (await fetch(`${BASE}/attivita`)).text();
  check("L footer marketplace linka le informative", attivita.includes("/legal/privacy") && attivita.includes("/legal/cookie") && attivita.includes("/legal/note-legali"));
  const legal404 = await fetch(`${BASE}/legal/inesistente`);
  check("L slug legale sconosciuto -> 404", legal404.status === 404, `status=${legal404.status}`);

  // ===== 2. Booking pubblico: consenso obbligatorio + flag salvati =====
  const svc = (await db.query("SELECT id FROM services WHERE tenant_id=$1 AND COALESCE(is_active,1)=1 ORDER BY id LIMIT 1", [TID])).rows[0];
  if (!svc) throw new Error("nessun servizio attivo");
  const serviceId = Number(svc.id);
  let date = "", time = "";
  for (let ahead = 2; ahead <= 9 && !time; ahead++) {
    const d = new Date(); d.setDate(d.getDate() + ahead);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const res = await (await fetch(`${BASE}/api/booking?action=slots&slug=${SLUG}&date=${iso}&service_ids=${serviceId}&location_id=${LOC}`)).json();
    const free = (res.slots ?? []).find((s) => s.available);
    if (free) { date = iso; time = free.time; }
  }
  if (!time) throw new Error("nessuno slot libero in 8 giorni");

  const noConsent = await (await fetch(`${BASE}/api/booking`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ slug: SLUG, action: "confirm", date, time, service_ids: [serviceId], location_id: LOC, client_name: `ZZ GdprBook ${RUN}`, client_email: BOOK_EMAIL, client_phone: "3330000091" }),
  })).json();
  check("B1 confirm SENZA privacy_accepted -> 400 con messaggio", noConsent.ok === false && /informativa sulla privacy/.test(noConsent.error || ""), JSON.stringify(noConsent.error));
  const noClient = (await db.query("SELECT id FROM clients WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)", [TID, BOOK_EMAIL])).rows[0];
  check("B2 rifiuto consenso: NESSUN cliente creato", !noClient, noClient ? `id=${noClient.id}` : "");

  const conf = await (await fetch(`${BASE}/api/booking`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ slug: SLUG, action: "confirm", privacy_accepted: "1", marketing_opt_in: "1", date, time, service_ids: [serviceId], location_id: LOC, client_name: `ZZ GdprBook ${RUN}`, client_email: BOOK_EMAIL, client_phone: "3330000091" }),
  })).json();
  apptId = Number(conf?.confirmation?.id ?? 0);
  bookClientId = Number(conf?.confirmation?.clientId ?? 0);
  check("B3 confirm CON consenso ok", Boolean(conf?.ok) && apptId > 0 && bookClientId > 0, `appt=${apptId} client=${bookClientId} ${conf?.error ?? ""}`);
  const bc = (await db.query("SELECT gdpr_consent_data_processing, gdpr_consent_marketing FROM clients WHERE tenant_id=$1 AND id=$2", [TID, bookClientId])).rows[0];
  check("B4 flag consensi salvati sul cliente (privacy=1, marketing=1)", Number(bc?.gdpr_consent_data_processing) === 1 && Number(bc?.gdpr_consent_marketing) === 1, JSON.stringify(bc));

  // ===== 3. Registrazione area clienti: consenso + prova =====
  const regNo = await (await fetch(`${BASE}/api/account`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "register", first_name: "ZZ", last_name: `Gdpr${RUN}`, email: REG_EMAIL, password: "Passw0rd!123", password_confirm: "Passw0rd!123" }),
  })).json();
  check("R1 register SENZA consenso -> errore", regNo.ok === false && /informativa sulla privacy/.test(regNo.error || ""), JSON.stringify(regNo.error));

  const regShort = await (await fetch(`${BASE}/api/account`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "register", privacy_accepted: "1", first_name: "ZZ", last_name: `Gdpr${RUN}`, email: REG_EMAIL, password: "corta7!", password_confirm: "corta7!" }),
  })).json();
  check("R2 password 7 caratteri -> 'almeno 8'", regShort.ok === false && /almeno 8/.test(regShort.error || ""), JSON.stringify(regShort.error));

  const reg = await (await fetch(`${BASE}/api/account`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ action: "register", privacy_accepted: "1", marketing_opt_in: "1", first_name: "ZZ", last_name: `Gdpr${RUN}`, email: REG_EMAIL, password: "Passw0rd!123", password_confirm: "Passw0rd!123" }),
  })).json();
  accId = Number(reg?.accountId ?? 0);
  check("R3 register CON consenso ok", reg.ok === true && accId > 0, JSON.stringify([reg.ok, reg.error]));
  const accRow = (await db.query("SELECT privacy_accepted_at, privacy_accept_ip, marketing_opt_in FROM public_customer_accounts WHERE id=$1", [accId])).rows[0];
  check("R4 prova consenso: timestamp + IP + opt-in marketing", Boolean(accRow?.privacy_accepted_at) && accRow?.privacy_accept_ip === "203.0.113.7" && Number(accRow?.marketing_opt_in) === 1, JSON.stringify(accRow));

  // ===== 4. Throttle login password (10 fallimenti/15min) =====
  const thrHash = bcrypt.hashSync("GiustaPass!1", 10);
  throttleAccId = Number((await db.query(
    "INSERT INTO public_customer_accounts (email, password_hash, full_name, first_name, last_name, email_verified_at) VALUES ($1,$2,'ZZ Thr','ZZ','Thr',NOW()) RETURNING id",
    [THR_EMAIL, thrHash],
  )).rows[0].id);
  let lastErr = "";
  for (let i = 0; i < 10; i++) {
    const bad = await (await fetch(`${BASE}/api/account`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "login", email: THR_EMAIL, password: "Sbagliata!1" }),
    })).json();
    lastErr = String(bad.error || "");
  }
  check("T1 10 fallimenti -> 'Credenziali non valide.'", /Credenziali non valide/.test(lastErr), lastErr);
  const blocked = await (await fetch(`${BASE}/api/account`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", email: THR_EMAIL, password: "GiustaPass!1" }),
  })).json();
  check("T2 11° tentativo (anche con password GIUSTA) -> throttled", blocked.ok === false && /Troppi tentativi/.test(blocked.error || ""), JSON.stringify(blocked.error));
  await db.query("UPDATE public_customer_accounts SET password_login_attempts=0, password_login_last_attempt_at=NULL WHERE id=$1", [throttleAccId]);
  const okLogin = await (await fetch(`${BASE}/api/account`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", email: THR_EMAIL, password: "GiustaPass!1" }),
  })).json();
  check("T3 finestra azzerata -> login ok e contatore resettato", okLogin.ok === true, JSON.stringify(okLogin.error ?? "ok"));

  // ===== 5. Export dati cliente (do=gdpr_export) =====
  expClientId = Number((await db.query(
    "INSERT INTO clients (tenant_id, full_name, first_name, last_name, email, location_id, gdpr_consent_data_processing) VALUES ($1,$2,'ZZ','Export',$3,$4,1) RETURNING id",
    [TID, `ZZ Export ${RUN}`, `zz.gdprexp${RUN}@example.test`, LOC],
  )).rows[0].id);
  const expRes = await fetch(`${BASE}/api/manage/client-gdpr?slug=${SLUG}&client_id=${expClientId}&do=gdpr_export`, { headers: { cookie: ADMIN_COOKIE } });
  const disp = expRes.headers.get("content-disposition") || "";
  const payload = await expRes.json();
  check("E1 export 200 + attachment JSON", expRes.status === 200 && /attachment/.test(disp), `status=${expRes.status} disp=${disp}`);
  check("E2 export contiene anagrafica + consensi + sezioni", payload?.export_type === "gdpr_data_export" && payload?.client?.full_name === `ZZ Export ${RUN}` && payload?.consents?.data_processing === true && Array.isArray(payload?.appointments) && Array.isArray(payload?.sales), JSON.stringify(Object.keys(payload ?? {})));
  const expNoAuth = await fetch(`${BASE}/api/manage/client-gdpr?slug=${SLUG}&client_id=${expClientId}&do=gdpr_export`);
  check("E3 export senza sessione -> 401", expNoAuth.status === 401, `status=${expNoAuth.status}`);

  // ===== 6. Delete cascata con documenti presenti (raccolta chiavi R2) =====
  delClientId = Number((await db.query(
    "INSERT INTO clients (tenant_id, full_name, first_name, last_name, email, location_id) VALUES ($1,$2,'ZZ','Del',$3,$4) RETURNING id",
    [TID, `ZZ GdprDel ${RUN}`, `zz.gdprdel${RUN}@example.test`, LOC],
  )).rows[0].id);
  await db.query(
    "INSERT INTO customer_documents (tenant_id, client_id, title, file_path, mime, created_at) VALUES ($1,$2,'ZZ Doc',$3,'application/pdf',NOW())",
    [TID, delClientId, `t${TID}/clients/${delClientId}/zz-fake-${RUN}.pdf`],
  );
  const delRes = await (await fetch(`${BASE}/api/manage/clients?slug=${SLUG}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: ADMIN_COOKIE },
    body: JSON.stringify({ action: "delete", id: delClientId, delete_reason: "test GDPR cascade", delete_confirm_text: "ELIMINA" }),
  })).json();
  const delGone = (await db.query("SELECT id FROM clients WHERE tenant_id=$1 AND id=$2", [TID, delClientId])).rows[0];
  const docGone = (await db.query("SELECT id FROM customer_documents WHERE tenant_id=$1 AND client_id=$2", [TID, delClientId])).rows[0];
  check("D1 cascata con documenti: cliente e righe documento rimossi", Boolean(delRes?.ok) && !delGone && !docGone, JSON.stringify([delRes?.ok, delRes?.error]));
  if (delRes?.ok) delClientId = 0;
} catch (e) {
  console.log("ERRORE:", e?.stack ?? e);
  R.push(false);
} finally {
  try {
    if (apptId) {
      for (const t of ["appointment_services", "appointment_segments", "appointment_staff", "appointment_locations"]) {
        await db.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [TID, apptId]).catch(() => {});
      }
      await db.query("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [TID, apptId]).catch(() => {});
    }
    if (bookClientId) await db.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [TID, bookClientId]).catch(() => {});
    if (delClientId) {
      await db.query("DELETE FROM customer_documents WHERE tenant_id=$1 AND client_id=$2", [TID, delClientId]).catch(() => {});
      await db.query("DELETE FROM client_deletion_logs WHERE tenant_id=$1 AND client_ids=$2", [TID, String(delClientId)]).catch(() => {});
      await db.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [TID, delClientId]).catch(() => {});
    }
    await db.query("DELETE FROM client_deletion_logs WHERE tenant_id=$1 AND client_names LIKE $2", [TID, `ZZ GdprDel ${RUN}%`]).catch(() => {});
    if (expClientId) await db.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [TID, expClientId]).catch(() => {});
    for (const email of [BOOK_EMAIL, REG_EMAIL, THR_EMAIL]) {
      const acc = (await db.query("SELECT id FROM public_customer_accounts WHERE LOWER(email)=LOWER($1)", [email])).rows[0];
      if (acc) {
        await db.query("DELETE FROM public_customer_tenant_links WHERE account_id=$1", [acc.id]).catch(() => {});
        await db.query("DELETE FROM public_customer_sessions WHERE account_id=$1", [acc.id]).catch(() => {});
        await db.query("DELETE FROM public_customer_favorites WHERE account_id=$1", [acc.id]).catch(() => {});
        await db.query("DELETE FROM public_customer_accounts WHERE id=$1", [acc.id]).catch(() => {});
      }
    }
    const left = Number((await db.query("SELECT COUNT(*) n FROM clients WHERE tenant_id=$1 AND full_name LIKE $2", [TID, `ZZ Gdpr%${RUN}%`])).rows[0].n)
      + Number((await db.query("SELECT COUNT(*) n FROM clients WHERE tenant_id=$1 AND full_name LIKE $2", [TID, `ZZ Export ${RUN}%`])).rows[0].n);
    console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
