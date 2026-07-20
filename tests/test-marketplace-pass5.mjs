// Marketplace giro 4 (2026-07-18): ciclo di vita AUTH completo — register
// (duplicati/overwrite pre-verifica), verify, resend, forgot/reset (token
// single-use, anti-enumeration), logout, cookie manomessi, gate pagine
// /account/*. Account temporaneo rimosso per id.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const api = (body, cookie = "") => fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const EMAIL = `zz.mk5_${RUN}@example.test`;
let accountId = 0, cookieA = "";

try {
  // ===== R. register =====
  const r1 = await api({ action: "register", first_name: "ZZ", last_name: "Mk5", email: "non-una-email", password: "Passw0rd!123", password_confirm: "Passw0rd!123" }).then((r) => r.json());
  check("R1 email invalida -> 'Email non valida.'", r1.ok === false && /Email non valida/.test(r1.error || ""), r1.error);
  const r2 = await api({ action: "register", first_name: "ZZ", last_name: "Mk5", email: EMAIL, password: "abc", password_confirm: "abc" }).then((r) => r.json());
  check("R2 password corta -> 'almeno 6 caratteri'", r2.ok === false && /almeno 6/.test(r2.error || ""), r2.error);

  const reg1 = await api({ action: "register", first_name: "ZZ", last_name: "Mk5", email: EMAIL, password: "Passw0rd!123", password_confirm: "Passw0rd!123" }).then((r) => r.json());
  accountId = Number(reg1.accountId ?? 0);
  check("R3 register ok -> accountId + devCode", reg1.ok === true && accountId > 0 && /^\d{6}$/.test(String(reg1.devCode ?? "")), JSON.stringify([reg1.ok, accountId]));

  // HARDENING: re-register/resend entro 60s dall'ultimo invio -> COOLDOWN
  const reg2cold = await api({ action: "register", first_name: "ZZ2", last_name: "Mk5b", email: EMAIL, password: "AltraPass!9", password_confirm: "AltraPass!9" }).then((r) => r.json());
  check("H1 re-register entro 60s -> cooldown 'Attendi un minuto…'", reg2cold.ok === false && /Attendi un minuto/.test(reg2cold.error || ""), reg2cold.error);
  const backdate = () => db.query("UPDATE public_customer_accounts SET email_verification_sent_at = email_verification_sent_at - interval '2 minutes' WHERE id=$1", [accountId]);
  await backdate();

  // Re-register sulla STESSA email NON verificata -> overwrite consentito
  // (stesso id, nuovo codice; il vecchio codice diventa invalido)
  const reg2 = await api({ action: "register", first_name: "ZZ2", last_name: "Mk5b", email: EMAIL, password: "AltraPass!9", password_confirm: "AltraPass!9" }).then((r) => r.json());
  check("R4 re-register pre-verifica (post-cooldown) -> overwrite, STESSO id, nuovo codice", reg2.ok === true && Number(reg2.accountId) === accountId && reg2.devCode !== reg1.devCode, JSON.stringify([Number(reg2.accountId), reg2.devCode !== reg1.devCode]));
  const vOld = await api({ action: "verify", account_id: accountId, code: String(reg1.devCode) }).then((r) => r.json());
  check("R5 il VECCHIO codice non vale più", vOld.ok === false, JSON.stringify(vOld.error));

  // ===== RS. resend =====
  const rsCold = await api({ action: "resend_verification", account_id: accountId }).then((r) => r.json());
  check("H2 resend entro 60s -> cooldown (anti email-bombing)", rsCold.ok === false && /Attendi un minuto/.test(rsCold.error || ""), rsCold.error);
  await backdate();
  const rs = await api({ action: "resend_verification", account_id: accountId }).then((r) => r.json());
  check("RS1 resend post-cooldown -> nuovo codice valido", rs.ok === true && /^\d{6}$/.test(String(rs.devCode ?? "")) && rs.devCode !== reg2.devCode, JSON.stringify([rs.ok, rs.devCode !== reg2.devCode]));

  // ===== V. verify + CAP TENTATIVI =====
  const v1 = await api({ action: "verify", account_id: accountId, code: "000000" }).then((r) => r.json());
  check("V1 codice errato -> errore", v1.ok === false && !!v1.error, JSON.stringify(v1.error));
  // altri 3 errati (tot 4), il 5° INVALIDA il codice
  for (let i = 0; i < 3; i++) await api({ action: "verify", account_id: accountId, code: "000000" });
  const v5 = await api({ action: "verify", account_id: accountId, code: "000000" }).then((r) => r.json());
  check("H3 5° tentativo errato -> 'Troppi tentativi' + codice INVALIDATO", v5.ok === false && /Troppi tentativi/.test(v5.error || ""), v5.error);
  const vDead = await api({ action: "verify", account_id: accountId, code: String(rs.devCode) }).then((r) => r.json());
  check("H4 anche il codice GIUSTO ormai non vale più", vDead.ok === false, JSON.stringify(vDead.error));
  await backdate();
  const rs2 = await api({ action: "resend_verification", account_id: accountId }).then((r) => r.json());
  const v2 = await api({ action: "verify", account_id: accountId, code: String(rs2.devCode) });
  cookieA = (v2.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const v2j = await v2.json();
  check("V2 nuovo codice post-cap -> verificato + sessione", v2j.ok === true && cookieA.includes("beautysuite_customer_session"), cookieA.split("=")[0]);

  // ===== F. forgot / reset =====
  const f1 = await api({ action: "forgot", email: "non-una-email" }).then((r) => r.json());
  check("F1 forgot email invalida -> 'Email non valida.'", f1.ok === false && /Email non valida/.test(f1.error || ""), f1.error);
  const f2 = await api({ action: "forgot", email: `inesistente_${RUN}@example.test` }).then((r) => r.json());
  check("F2 email SCONOSCIUTA -> risposta generica SENZA devToken (anti-enumeration)", f2.ok === true && /Se l'email e registrata/.test(f2.message || "") && !f2.devToken, JSON.stringify([f2.ok, !!f2.devToken]));
  const f3 = await api({ action: "forgot", email: EMAIL }).then((r) => r.json());
  check("F3 email nota -> devToken 64 hex (stessa risposta generica)", f3.ok === true && /^[a-f0-9]{64}$/.test(String(f3.devToken ?? "")) && f3.message === f2.message, JSON.stringify([!!f3.devToken, f3.message === f2.message]));
  // HARDENING: secondo forgot entro 60s -> cooldown SILENZIOSO (stessa frase
  // generica, NESSUN token emesso: un errore dedicato sarebbe enumeration)
  const f3b = await api({ action: "forgot", email: EMAIL }).then((r) => r.json());
  check("H5 forgot in cooldown -> generico SENZA devToken (anti-enumeration)", f3b.ok === true && f3b.message === f2.message && !f3b.devToken, JSON.stringify([f3b.ok, !!f3b.devToken]));
  const f4 = await api({ action: "reset", email: EMAIL, token: "a".repeat(64), password: "ResetPass!7" }).then((r) => r.json());
  check("F4 token sbagliato -> 'Link di reset non valido.'", f4.ok === false && /non valido/.test(f4.error || ""), f4.error);
  const f5 = await api({ action: "reset", email: EMAIL, token: String(f3.devToken), password: "ResetPass!7" }).then((r) => r.json());
  const loginReset = await api({ action: "login", email: EMAIL, password: "ResetPass!7" }).then((r) => r.json());
  check("F5 reset ok -> login con la password nuova", f5.ok === true && loginReset.ok === true, JSON.stringify([f5.ok, loginReset.ok]));
  const f6 = await api({ action: "reset", email: EMAIL, token: String(f3.devToken), password: "Ancora!123" }).then((r) => r.json());
  check("F6 STESSO token riusato -> respinto (single-use)", f6.ok === false && /non valido/.test(f6.error || ""), f6.error);

  // ===== L. logout + cookie manomesso =====
  const lo = await fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieA }, body: JSON.stringify({ action: "logout" }) });
  const loJ = await lo.json();
  const afterLogout = await fetch(`${BASE}/api/account`, { headers: { cookie: cookieA } }).then((r) => r.json());
  check("L1 logout -> sessione invalidata anche col VECCHIO cookie", loJ.ok === true && !afterLogout.user, JSON.stringify([loJ.ok, afterLogout.user ?? null]));
  const tampered = cookieA.replace(/=(.{8})/, "=deadbeef");
  const tamperedRes = await api({ action: "update_profile", first_name: "X", last_name: "Y" }, tampered).then((r) => r.json());
  check("L2 cookie manomesso -> 'Accesso cliente richiesto.'", tamperedRes.ok === false && /Accesso cliente richiesto/.test(tamperedRes.error || ""), tamperedRes.error);

  // ===== G. gate pagine /account/* =====
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/account/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  check("G1 /account/profile SENZA sessione -> login", /\/account\/login/.test(page.url()), page.url().slice(0, 60));
  // login fresco via API per i gate col cookie
  const logNew = await api({ action: "login", email: EMAIL, password: "ResetPass!7" });
  const freshCookie = (logNew.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const [cn, cv] = freshCookie.split("; ")[0].split("=");
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx2.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/account/activities`, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(3500);
  const actBody = await p2.locator("main, body").first().textContent();
  check("G2 /account/activities CON sessione -> resta + stato vuoto (nessuna attività collegata)", /\/account\/activities/.test(p2.url()) && /(Nessuna attivit|non hai ancora)/i.test(actBody || ""), p2.url().slice(0, 60));
  await browser.close();

  // ===== EC. hardening cambio email: cooldown + cap tentativi =====
  const ec1 = await api({ action: "request_email_change", new_email: `zz.mk5c_${RUN}@example.test`, current_password: "ResetPass!7" }, freshCookie).then((r) => r.json());
  check("EC1 richiesta cambio email -> devCode", ec1.ok === true && /^\d{6}$/.test(String(ec1.devCode ?? "")), JSON.stringify([ec1.ok, !!ec1.devCode]));
  const ec2 = await api({ action: "request_email_change", new_email: `zz.mk5d_${RUN}@example.test`, current_password: "ResetPass!7" }, freshCookie).then((r) => r.json());
  check("EC2 seconda richiesta entro 60s -> cooldown", ec2.ok === false && /Attendi un minuto/.test(ec2.error || ""), ec2.error);
  for (let i = 0; i < 4; i++) await api({ action: "confirm_email_change", code: "000000" }, freshCookie);
  const ec3 = await api({ action: "confirm_email_change", code: "000000" }, freshCookie).then((r) => r.json());
  const rowEc = (await db.query("SELECT pending_email FROM public_customer_accounts WHERE id=$1", [accountId])).rows[0];
  check("EC3 5° codice errato -> 'Troppi tentativi' + richiesta ANNULLATA", ec3.ok === false && /Troppi tentativi/.test(ec3.error || "") && rowEc.pending_email === null, JSON.stringify([ec3.error, rowEc.pending_email]));
} finally {
  if (accountId > 0) {
    await db.query("DELETE FROM public_customer_favorites WHERE account_id=$1", [accountId]).catch(() => 0);
    await db.query("DELETE FROM public_customer_sessions WHERE account_id=$1", [accountId]).catch(() => 0);
    await db.query("DELETE FROM public_customer_accounts WHERE id=$1 AND email LIKE 'zz.mk5%'", [accountId]);
  }
  const resid = (await db.query("SELECT COUNT(*)::int AS n FROM public_customer_accounts WHERE email LIKE $1", [`zz.mk5_${RUN}%`])).rows[0]?.n ?? -1;
  console.log(`CLEANUP: residui=${resid} (id=${accountId}) -> ${resid === 0 ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
