// Testo tab Admin del tenant (2026-07-20): il riquadro spiega cosa fa il
// bottone Verifica admin tenant (riparazione accesso + regola password).
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
const EMAIL = `zz.repairtxt${RUN}@example.test`;
let adminId = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ RepairTxt", EMAIL, bcrypt.hashSync("Repair!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Repair!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=tenants&slug=centroesteticoelite&tab=admin`, { waitUntil: "domcontentloaded" });
  await page.locator("button", { hasText: "Verifica admin tenant" }).waitFor({ timeout: 30000 });
  const newText = await page.locator("text=Ripara l'accesso del titolare").count();
  const oldText = await page.locator("text=Verifica o ricrea utente admin").count();
  const passRule = await page.locator("text=La password cambia solo se ne scrivi una nuova").count();
  check("Riquadro Admin: testo nuovo renderizzato, vecchio assente", newText === 1 && passRule === 1 && oldText === 0, `new=${newText} rule=${passRule} old=${oldText}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
