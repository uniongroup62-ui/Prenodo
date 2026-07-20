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
let adminId = 0, planId = 0, smsPlanId = 0, browser = null;

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

  // B4: Pacchetti SMS — le tre sezioni vivono in POPUP (20/07): la pagina e'
  // KPI + Ordini recenti; ogni popup si apre dal suo bottone ed Esc chiude.
  await page.locator("button", { hasText: "Pacchetti SMS" }).first().click();
  await page.locator("text=Ordini recenti").waitFor({ timeout: 20000 });
  const inlineForms = await page.locator("input[name='provider_cost_per_segment']").count();
  await page.locator("button", { hasText: "Impostazioni prezzo" }).click();
  await page.locator("div[role='dialog'] input[name='provider_cost_per_segment']").waitFor({ timeout: 10000 });
  const units = await page.locator("div[role='dialog']").locator("text=Prezzo suggerito (euro/SMS)").count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: "Ricarica manuale" }).click();
  await page.locator("div[role='dialog'] select[name='tenant_slug']").waitFor({ timeout: 10000 });
  const wallet = await page.locator("div[role='dialog'] option", { hasText: "crediti" }).count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: "Gestisci piani" }).click();
  await page.locator("div[role='dialog'] button[title='Sposta su nella vetrina']").first().waitFor({ timeout: 10000 });
  const arrowTitle = await page.locator("div[role='dialog'] button[title='Sposta su nella vetrina']").count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("B4 SMS: popup Impostazioni/Ricarica/Piani con unita', crediti e frecce", inlineForms === 0 && units === 1 && wallet >= 1 && arrowTitle >= 1, `inline=${inlineForms} units=${units} wallet=${wallet} arrow=${arrowTitle}`);

  // B5: "Porta a target" su un pacchetto ZZ fuori target (DISATTIVO: mai in
  // vetrina) — precompila il campo, NON salva; il Salva poi persiste.
  await fetch(`${BASE}/api/admin/operations`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "sms_save_plan", name: `ZZ Target ${RUN}`, credits: "200", price_gross: "9.00", description: "zz test", is_active: "0" }) });
  smsPlanId = Number((await db.query("SELECT id FROM saas_sms_plans WHERE name=$1", [`ZZ Target ${RUN}`])).rows[0]?.id ?? 0);
  const suggested = Number((await db.query("SELECT suggested_credit_price FROM saas_sms_pricing_settings ORDER BY id ASC LIMIT 1")).rows[0]?.suggested_credit_price ?? 0);
  const expected = (Math.round(200 * suggested * 100) / 100).toFixed(2);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("button", { hasText: "Pacchetti SMS" }).first().click();
  await page.locator("text=Ordini recenti").waitFor({ timeout: 20000 });
  await page.locator("button", { hasText: "Gestisci piani" }).click();
  // il nome sta nel VALUE di un input: hasText non lo vede, serve :has(...)
  const zzForm = page.locator(`form:has(input[name='name'][value='ZZ Target ${RUN}'])`);
  await zzForm.locator("button", { hasText: "Porta a target" }).waitFor({ timeout: 20000 });
  await zzForm.locator("button", { hasText: "Porta a target" }).click();
  const filled = await zzForm.locator("input[name='price_gross']").inputValue();
  let dbPrice = Number((await db.query("SELECT price_gross FROM saas_sms_plans WHERE id=$1", [smsPlanId])).rows[0]?.price_gross);
  check("B5 Porta a target: campo precompilato (crediti x suggerito), DB intatto", filled === expected && dbPrice === 9, `filled=${filled} atteso=${expected} db=${dbPrice}`);

  // B6: Salva persiste il prezzo precompilato
  await zzForm.locator("button", { hasText: "Salva" }).click();
  await page.waitForTimeout(2500);
  dbPrice = Number((await db.query("SELECT price_gross FROM saas_sms_plans WHERE id=$1", [smsPlanId])).rows[0]?.price_gross);
  check("B6 Salva dopo il target: prezzo persistito", dbPrice === Number(expected), `db=${dbPrice} atteso=${expected}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (smsPlanId) await db.query("DELETE FROM saas_sms_plans WHERE id=$1", [smsPlanId]).catch(() => {});
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
