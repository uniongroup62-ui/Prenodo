// Fatturazione rifinita (2026-07-20): Disattiva/Attiva piano dalla lista
// (senza toccare i tenant assegnati), niente tabella SMS duplicata in
// Abbonamenti, etichette con unita', wallet leggibile. Fixture ZZ per id.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.bilr${RUN}@example.test`;
const PLAN = `ZZ BilR ${RUN}`;
let adminId = 0, planId = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ BilR", EMAIL, bcrypt.hashSync("Br!12345", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Br!12345" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const save = await (await fetch(`${BASE}/api/admin/operations`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "plan_save", name: PLAN, price_month: "12.50", max_locations: "2" }) })).json();
  planId = Number(save?.id ?? 0);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=billing`, { waitUntil: "domcontentloaded" });
  await page.locator("tr", { hasText: PLAN }).waitFor({ timeout: 30000 });

  // B1: niente tabella SMS duplicata in Abbonamenti
  const dupTable = await page.locator("text=Ricavo SMS per mese (ordini pagati)").count();
  check("B1 Abbonamenti senza tabella SMS duplicata", dupTable === 0, `dup=${dupTable}`);

  // B2: Disattiva dalla riga -> is_active 0 in DB, limiti INTATTI
  await page.locator("tr", { hasText: PLAN }).locator("button", { hasText: "Disattiva" }).click();
  await page.waitForTimeout(2500);
  let row = (await db.query("SELECT is_active, max_locations, price_month FROM saas_plans WHERE id=$1", [planId])).rows[0];
  check("B2 Disattiva: is_active=0, prezzo e limiti intatti", Number(row?.is_active) === 0 && Number(row?.max_locations) === 2 && Number(row?.price_month) === 12.5, JSON.stringify(row));

  // B3: la riga ora dice (disattivo) e offre Attiva -> ritorno a 1
  await page.locator("tr", { hasText: PLAN }).locator("text=(disattivo)").waitFor({ timeout: 15000 });
  await page.locator("tr", { hasText: PLAN }).locator("button", { hasText: "Attiva" }).click();
  await page.waitForTimeout(2500);
  row = (await db.query("SELECT is_active FROM saas_plans WHERE id=$1", [planId])).rows[0];
  check("B3 Attiva: is_active torna 1", Number(row?.is_active) === 1, `active=${row?.is_active}`);

  // B4: Pacchetti SMS — unita' nelle etichette + wallet leggibile + tooltip frecce
  await page.locator("button", { hasText: "Pacchetti SMS" }).first().click();
  await page.locator("text=Costo provider (euro/SMS)").waitFor({ timeout: 20000 });
  const units = await page.locator("text=Prezzo suggerito (euro/SMS)").count();
  const wallet = await page.locator("option", { hasText: "crediti" }).count();
  const arrowTitle = await page.locator("button[title='Sposta su nella vetrina']").count();
  check("B4 SMS: unita' misura + '— N crediti' nel select + frecce con tooltip", units === 1 && wallet >= 1 && arrowTitle >= 1, `units=${units} wallet=${wallet} arrow=${arrowTitle}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_tenant_audit_logs WHERE action LIKE 'saas_plan.%' AND details_json LIKE $1", [`%${PLAN}%`]).catch(() => {});
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (piano e admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
