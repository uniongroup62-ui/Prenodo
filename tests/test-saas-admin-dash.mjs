// Redesign dashboard (2026-07-19): niente onboarding in coda, card Stato
// sistema con azioni rapide, Attività recente al posto di Tenant recenti.
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
const EMAIL = `zz.dash${RUN}@example.test`;
let adminId = 0, cronWatermark = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Dash", EMAIL, bcrypt.hashSync("Dash!1234", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Dash!1234" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  cronWatermark = Number((await db.query("SELECT COALESCE(MAX(id),0) m FROM saas_cron_runs")).rows[0].m);

  // V1: coda SENZA onboarding (il tenant reale 'elite' e' fermo da settimane:
  //     prima produceva l'item, ora non deve piu')
  const ov = await (await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } })).json();
  const onboardingItems = (ov.workQueue ?? []).filter((w) => String(w.key).startsWith("onboarding:"));
  check("V1 coda: nessun item onboarding", onboardingItems.length === 0, `items=${onboardingItems.length}`);

  // V2: overview.system con cron/backup/policy
  const sys = ov.system ?? {};
  check("V2 overview.system: cron/backup/policy presenti", typeof sys.cron_ok === "number" && typeof sys.cron_error === "number" && "last_backup_at" in sys && typeof sys.totp_policy === "boolean", JSON.stringify(sys));

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // V3: dashboard con Stato sistema + Attivita' recente, senza Tenant recenti
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Stato sistema").waitFor({ timeout: 30000 });
  await page.locator("text=Attività recente").waitFor({ timeout: 15000 });
  const oldSection = await page.locator("text=Tenant recenti").count();
  const backupRow = await page.locator("text=Ultimo backup").count();
  check("V3 dashboard: Stato sistema + Attività recente, niente Tenant recenti", oldSection === 0 && backupRow === 1, `old=${oldSection}`);

  // V4: azione rapida 'Vedi statistiche' -> ?page=stats
  await page.locator("button", { hasText: "Vedi statistiche" }).click();
  await page.waitForURL(/page=stats/, { timeout: 20000 });
  check("V4 azione rapida -> vista Statistiche", /page=stats/.test(page.url()), page.url().slice(-15));

  // V5: azione rapida 'Esegui diagnostica' -> cron registrato
  await page.goBack();
  await page.locator("button", { hasText: "Esegui diagnostica" }).waitFor({ timeout: 20000 });
  await page.locator("button", { hasText: "Esegui diagnostica" }).click();
  await page.waitForTimeout(12000);
  const runRows = (await db.query("SELECT id FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark])).rows.length;
  check("V5 Esegui diagnostica -> run admin-health registrata", runRows >= 1, `rows=${runRows}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (cronWatermark >= 0) await db.query("DELETE FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark]).catch(() => {});
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok");
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
