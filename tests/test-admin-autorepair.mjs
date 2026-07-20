// Auto-riparazione dal cron admin-health (2026-07-20): i buchi ADDITIVI
// (riga onboarding, voci permessi di catalogo) si riparano da soli; admin
// mancante resta un alert umano. Fixture ZZ completa tranne i due buchi.
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
const EMAIL = `zz.autorep${RUN}@example.test`;
const SLUG = `zz-autorep${RUN}`;
let adminId = 0, tid = 0, browser = null;

try {
  // Fixture: tenant ZZ con admin+staff+sede+business (tutto ok) ma SENZA riga
  // onboarding e SENZA permessi -> i due buchi auto-riparabili.
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ AutoRep',$2,1,'active') RETURNING id", [SLUG, `t_zzar${RUN}_`]);
  tid = Number(t.rows[0].id);
  await db.query("INSERT INTO users(tenant_id,name,email,password_hash,role) VALUES($1,'ZZ AR',$2,$3,'admin')", [tid, EMAIL, bcrypt.hashSync("Ar!12345", 10)]);
  await db.query("INSERT INTO staff(tenant_id,full_name,email,is_active) VALUES($1,'ZZ AR',$2,1)", [tid, EMAIL]);
  await db.query("INSERT INTO locations(tenant_id,name,is_active) VALUES($1,'ZZ Sede AR',1)", [tid]);
  await db.query("INSERT INTO businesses(tenant_id,name) VALUES($1,'ZZ Business AR')", [tid]);

  // Cron admin-health (Bearer CRON_SECRET): deve auto-riparare il tenant ZZ.
  const res = await (await fetch(`${BASE}/api/cron/admin-health`, { headers: { authorization: `Bearer ${env("CRON_SECRET")}` } })).json();
  const mine = (res.auto_repaired ?? []).find((r) => r.slug === SLUG);
  check("A1 cron: tenant ZZ in auto_repaired con i due buchi", Boolean(res.ok) && Boolean(mine) && mine.repaired.includes("onboarding_state") && mine.repaired.includes("permissions"), JSON.stringify(mine ?? res).slice(0, 120));

  // Buchi chiusi davvero in DB
  const onb = Number((await db.query("SELECT COUNT(*) AS n FROM tenant_onboarding_progress WHERE tenant_id=$1", [tid])).rows[0].n);
  const perms = Number((await db.query("SELECT COUNT(*) AS n FROM permissions WHERE tenant_id=$1", [tid])).rows[0].n);
  check("A2 DB: riga onboarding creata + permessi seminati", onb === 1 && perms > 10, `onb=${onb} perms=${perms}`);

  // Diagnostica post-riparazione registrata come auto_repair, checks verdi sui due
  const hRow = (await db.query("SELECT source, checks_json FROM saas_tenant_health_checks WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1", [tid])).rows[0];
  const checks = JSON.parse(String(hRow?.checks_json ?? "[]"));
  const okKeys = ["onboarding_state", "permissions"].every((k) => checks.find((c) => c.key === k)?.level === "ok");
  check("A3 diagnostica post-riparazione: source auto_repair + i due check ok", hRow?.source === "auto_repair" && okKeys, `source=${hRow?.source}`);

  // Audit tracciato
  const audit = (await db.query("SELECT message FROM saas_tenant_audit_logs WHERE tenant_id=$1 AND action='tenant.auto_repair'", [tid])).rows;
  check("A4 audit: tenant.auto_repair con dettaglio", audit.length === 1 && /Riparazione automatica/.test(String(audit[0].message)), String(audit[0]?.message ?? "").slice(0, 80));

  // UI: sintesi Diagnostica mostra l'origine tradotta "Automatica (riparazione)"
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ AutoRep", EMAIL, bcrypt.hashSync("Ar!12345", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Ar!12345" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=health`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Ultima diagnostica:").waitFor({ timeout: 30000 });
  const srcLabel = await page.locator("text=Automatica (riparazione)").count();
  check("A5 UI: origine 'Automatica (riparazione)' nella sintesi", srcLabel >= 1, `label=${srcLabel}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (tid) {
      for (const tab of ["tenant_onboarding_progress", "permissions", "users", "staff", "locations", "businesses", "saas_tenant_health_checks", "saas_tenant_audit_logs"]) {
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
    console.log("CLEANUP: ok (tenant ZZ completo, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
