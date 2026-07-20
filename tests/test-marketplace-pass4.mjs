// Marketplace giro 3 (2026-07-18): MUTAZIONI dell'area account cliente —
// profilo, cambio password, cambio email (codici/scadenze/duplicati),
// preferiti remove, sede di riferimento, pagina Preferiti live.
// DUE account temporanei (per il test email duplicata), rimossi per id.
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
const EMAIL_A = `zz.mk4a${RUN}@example.test`, EMAIL_B = `zz.mk4b${RUN}@example.test`, EMAIL_A2 = `zz.mk4a2${RUN}@example.test`;
let idA = 0, idB = 0, cookieA = "";

async function mkAccount(email) {
  const reg = await api({ action: "register", first_name: "ZZ", last_name: `Mk4_${RUN}`, email, password: "Passw0rd!123", password_confirm: "Passw0rd!123" }).then((r) => r.json());
  const ver = await api({ action: "verify", account_id: Number(reg.accountId), code: String(reg.devCode) });
  const cookie = (ver.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  return { id: Number(reg.accountId), cookie, ok: reg.ok && (await ver.json()).ok };
}

try {
  const A = await mkAccount(EMAIL_A);
  const B = await mkAccount(EMAIL_B);
  idA = A.id; idB = B.id; cookieA = A.cookie;
  check("S0 due account temporanei creati", A.ok && B.ok && idA > 0 && idB > 0, JSON.stringify([idA, idB]));

  // ===== login =====
  const badLogin = await api({ action: "login", email: EMAIL_A, password: "sbagliata" }).then((r) => r.json());
  check("L1 login password errata -> errore, mai sessione", badLogin.ok === false && !!badLogin.error, JSON.stringify(badLogin.error));

  // ===== update_profile =====
  const up1 = await api({ action: "update_profile", first_name: "ZZeta", last_name: `Mk4X_${RUN}`, phone: "+39 333 000 1122" }, cookieA).then((r) => r.json());
  const row1 = (await db.query("SELECT first_name, last_name, full_name, phone FROM public_customer_accounts WHERE id=$1", [idA])).rows[0];
  check("P1 update_profile persiste (full_name sincronizzato)", up1.ok === true && row1.first_name === "ZZeta" && row1.full_name === `ZZeta Mk4X_${RUN}` && row1.phone === "+39 333 000 1122", JSON.stringify(row1));
  const up2 = await api({ action: "update_profile", first_name: "ZZeta", last_name: "" }, cookieA).then((r) => r.json());
  check("P2 cognome mancante -> 'Inserisci nome e cognome.'", up2.ok === false && /nome e cognome/.test(up2.error || ""), up2.error);

  // ===== change_password =====
  const cp1 = await api({ action: "change_password", current_password: "sbagliata", new_password: "NuovaPass!1", confirm_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  check("W1 password attuale errata -> guardia", cp1.ok === false && /attuale non e corretta/.test(cp1.error || ""), cp1.error);
  const cp2 = await api({ action: "change_password", current_password: "Passw0rd!123", new_password: "abc", confirm_password: "abc" }, cookieA).then((r) => r.json());
  check("W2 nuova corta -> 'almeno 6 caratteri'", cp2.ok === false && /almeno 6/.test(cp2.error || ""), cp2.error);
  const cp3 = await api({ action: "change_password", current_password: "Passw0rd!123", new_password: "NuovaPass!1", confirm_password: "Diversa!1" }, cookieA).then((r) => r.json());
  check("W3 conferma diversa -> 'non coincidono'", cp3.ok === false && /non coincidono/.test(cp3.error || ""), cp3.error);
  const cp4 = await api({ action: "change_password", current_password: "Passw0rd!123", new_password: "NuovaPass!1", confirm_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  const loginOld = await api({ action: "login", email: EMAIL_A, password: "Passw0rd!123" }).then((r) => r.json());
  const loginNew = await api({ action: "login", email: EMAIL_A, password: "NuovaPass!1" }).then((r) => r.json());
  check("W4 cambio ok: vecchia NEGATA, nuova ACCETTATA", cp4.ok === true && loginOld.ok === false && loginNew.ok === true, JSON.stringify([cp4.ok, loginOld.ok, loginNew.ok]));

  // ===== email change =====
  const e1 = await api({ action: "request_email_change", new_email: EMAIL_A2, current_password: "sbagliata" }, cookieA).then((r) => r.json());
  check("E1 richiesta con password errata -> guardia", e1.ok === false && /attuale non e corretta/.test(e1.error || ""), e1.error);
  const e2 = await api({ action: "request_email_change", new_email: EMAIL_A, current_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  check("E2 stessa email -> 'coincide con quella attuale'", e2.ok === false && /coincide/.test(e2.error || ""), e2.error);
  const e3 = await api({ action: "request_email_change", new_email: EMAIL_B, current_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  check("E3 email di un ALTRO account -> 'gia collegata'", e3.ok === false && /gia collegata/.test(e3.error || ""), e3.error);
  const e4 = await api({ action: "request_email_change", new_email: EMAIL_A2, current_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  check("E4 richiesta valida -> pending + devCode", e4.ok === true && /^\d{6}$/.test(String(e4.devCode ?? "")), JSON.stringify([e4.ok, !!e4.devCode]));
  const e5 = await api({ action: "confirm_email_change", code: "000000" }, cookieA).then((r) => r.json());
  check("E5 codice sbagliato -> 'Codice non valido.'", e5.ok === false && /Codice non valido/.test(e5.error || ""), e5.error);
  const e6 = await api({ action: "confirm_email_change", code: String(e4.devCode) }, cookieA).then((r) => r.json());
  const rowE = (await db.query("SELECT email, pending_email FROM public_customer_accounts WHERE id=$1", [idA])).rows[0];
  check("E6 conferma -> email cambiata e pending pulita", e6.ok === true && rowE.email === EMAIL_A2 && rowE.pending_email === null, JSON.stringify(rowE));
  const loginNewMail = await api({ action: "login", email: EMAIL_A2, password: "NuovaPass!1" }).then((r) => r.json());
  check("E7 login con la NUOVA email", loginNewMail.ok === true, JSON.stringify(loginNewMail.ok));
  // cancel: nuova richiesta poi annulla
  const e8 = await api({ action: "request_email_change", new_email: `zz.mk4tmp${RUN}@example.test`, current_password: "NuovaPass!1" }, cookieA).then((r) => r.json());
  const e9 = await api({ action: "cancel_email_change" }, cookieA).then((r) => r.json());
  const rowC = (await db.query("SELECT pending_email FROM public_customer_accounts WHERE id=$1", [idA])).rows[0];
  check("E8 cancel_email_change -> pending annullata", e8.ok === true && e9.ok === true && rowC.pending_email === null, JSON.stringify(rowC));

  // ===== preferiti: toggle + REMOVE dedicato + sede riferimento =====
  await api({ action: "toggle_favorite", tenant_slug: "centroesteticoelite", location_id: 21, location_slug: "altino-sede1-21" }, cookieA);
  await api({ action: "toggle_favorite", tenant_slug: "centroesteticoelite", location_id: 51, location_slug: "altino-sede-2-51" }, cookieA);
  const st1 = await fetch(`${BASE}/api/account`, { headers: { cookie: cookieA } }).then((r) => r.json());
  check("F1 due preferiti aggiunti", (st1.favorites ?? []).length === 2, `favs=${(st1.favorites ?? []).length}`);
  const rm = await api({ action: "remove_favorite", tenant_slug: "centroesteticoelite", location_id: 51 }, cookieA).then((r) => r.json());
  check("F2 remove_favorite -> resta solo sede 21", rm.ok === true && (rm.favorites ?? []).length === 1 && (rm.favorites ?? [])[0]?.locationId === 21, JSON.stringify((rm.favorites ?? []).map((f) => f.locationId)));
  // Account NON collegato al tenant (nessun client record): la sede di
  // riferimento scrive su clients del tenant -> guardia fail-closed CORRETTA.
  const rl = await api({ action: "update_reference_location", tenant_slug: "centroesteticoelite", location_id: 21 }, cookieA).then((r) => r.json());
  check("F3 reference_location da account NON collegato -> guardia fail-closed", rl.ok === false && /Sessione cliente non valida/.test(rl.error || ""), JSON.stringify([rl.ok, rl.error]));

  // ===== pagina Preferiti live: card + rimozione via UI =====
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cName, cVal] = cookieA.split("; ")[0].split("=");
  await ctx.addCookies([{ name: cName, value: cVal, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/account/favorites`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const favCards = await page.locator(".result-card, .tenant-card, [data-favorite-card], article").count();
  check("U1 pagina Preferiti: la card della sede 21 c'è", favCards >= 1, `cards=${favCards}`);
  const removeBtn = page.locator("button", { hasText: /Rimuovi/i }).first();
  const hasRemove = await removeBtn.count();
  if (hasRemove) {
    await removeBtn.click();
    await page.waitForTimeout(1500);
  }
  const favAfter = (await fetch(`${BASE}/api/account`, { headers: { cookie: cookieA } }).then((r) => r.json())).favorites ?? [];
  check("U2 rimozione dalla UI -> lista vuota", hasRemove >= 1 && favAfter.length === 0, `removeBtn=${hasRemove} favs=${favAfter.length}`);
  await browser.close();
} finally {
  for (const id of [idA, idB]) {
    if (id > 0) {
      await db.query("DELETE FROM public_customer_favorites WHERE account_id=$1", [id]).catch(() => 0);
      await db.query("DELETE FROM public_customer_accounts WHERE id=$1 AND (email LIKE 'zz.mk4%' OR email LIKE 'zz.mk4a2%')", [id]);
    }
  }
  const resid = (await db.query("SELECT COUNT(*)::int AS n FROM public_customer_accounts WHERE email LIKE $1", [`zz.mk4%${RUN}%`])).rows[0]?.n ?? -1;
  console.log(`CLEANUP: residui=${resid} (idA=${idA} idB=${idB}) -> ${resid === 0 ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
