// Nuovo tenant in POPUP modale (2026-07-20): si apre sopra la lista, Esc e
// click sul fondo chiudono, il submit crea davvero il tenant. Cleanup per id.
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
const EMAIL = `zz.popup${RUN}@example.test`;
const SLUG = `zz-popup${RUN}`;
let adminId = 0, tid = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Popup", EMAIL, bcrypt.hashSync("Pp!12345", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Pp!12345" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=tenants`, { waitUntil: "domcontentloaded" });
  await page.locator("input[placeholder*='Slug, nome']").waitFor({ timeout: 30000 });

  // P1: click "Nuovo tenant" -> dialog modale visibile
  await page.locator("button", { hasText: "Nuovo tenant" }).first().click();
  await page.locator("div[role='dialog']").waitFor({ timeout: 10000 });
  const dialogForm = await page.locator("div[role='dialog'] input[name='slug']").count();
  check("P1 popup aperto con form dentro il dialog", dialogForm === 1, `form=${dialogForm}`);

  // P2: Esc chiude
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const afterEsc = await page.locator("div[role='dialog']").count();
  check("P2 Esc chiude il popup", afterEsc === 0, `dialog=${afterEsc}`);

  // P3: click sul fondo chiude
  await page.locator("button", { hasText: "Nuovo tenant" }).first().click();
  await page.locator("div[role='dialog']").waitFor({ timeout: 10000 });
  await page.locator("div[role='dialog']").click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(600);
  const afterBackdrop = await page.locator("div[role='dialog']").count();
  check("P3 click sul fondo chiude il popup", afterBackdrop === 0, `dialog=${afterBackdrop}`);

  // P4: submit dal popup crea il tenant (fixture ZZ tracciata)
  await page.locator("button", { hasText: "Nuovo tenant" }).first().click();
  await page.locator("div[role='dialog']").waitFor({ timeout: 10000 });
  await page.fill("div[role='dialog'] input[name='tenant_name']", "ZZ Popup");
  await page.fill("div[role='dialog'] input[name='slug']", SLUG);
  await page.fill("div[role='dialog'] input[name='admin_email']", EMAIL);
  await page.fill("div[role='dialog'] input[name='admin_pass']", "Pp!12345");
  await page.locator("div[role='dialog'] button", { hasText: "Crea tenant" }).click();
  await page.waitForTimeout(6000);
  const row = (await db.query("SELECT id FROM saas_tenants WHERE slug=$1", [SLUG])).rows[0];
  tid = Number(row?.id ?? 0);
  check("P4 submit dal popup: tenant creato", tid > 0, `id=${tid}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (tid) {
      for (const tab of ["tenant_onboarding_progress", "permissions", "users", "staff", "locations", "businesses", "business_hours", "automation_settings", "pos_settings", "user_locations", "staff_locations", "saas_tenant_health_checks", "saas_tenant_audit_logs"]) {
        await db.query(`DELETE FROM ${tab} WHERE tenant_id=$1`, [tid]).catch(() => {});
      }
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (tenant ZZ per id + tabelle provisioning, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
