// Vista Statistiche + dashboard executive (2026-07-19): aggregati coerenti
// col DB, snapshot giornaliero dal cron, piano piu' venduto, grafici SVG
// renderizzati. Fixture zz-stat* rimosse per id; snapshot ricalcolato pulito
// a fine test (upsert dello stesso giorno).
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
const EMAIL = `zz.stat${RUN}@example.test`;
const SLUG = `zz-stat${RUN}`;
let adminId = 0, tid = 0, planId = 0, browser = null;
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Stat", EMAIL, bcrypt.hashSync("Stat!1234", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Stat!1234" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // Fixture: piano 9.90 + tenant finto assegnato
  const ps = await (await post(cookie, "/api/admin/operations", { action: "plan_save", name: `ZZ Stat ${RUN}`, price_month: "9.90", max_locations: "", max_staff: "", sms_included_month: "0" })).json();
  planId = Number(ps?.id ?? 0);
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ Stat',$2,1,'active') RETURNING id", [SLUG, `t_zzstat${RUN}_`]);
  tid = Number(t.rows[0].id);
  await post(cookie, "/api/admin/operations", { action: "plan_assign", tenant_slug: SLUG, plan_id: String(planId) });

  // U1: payload stats coerente col DB (utenti marketplace, funnel, utilizzo)
  const stats = (await (await fetch(`${BASE}/api/admin/operations?section=stats`, { headers: { cookie } })).json()).stats;
  const dbAccounts = Number((await db.query("SELECT COUNT(*) c FROM public_customer_accounts")).rows[0].c);
  const dbSignups = Number((await db.query("SELECT COUNT(*) c FROM saas_professional_signups")).rows[0].c);
  const dbUsers = Number((await db.query("SELECT COUNT(*) c FROM users")).rows[0].c);
  check("U1 stats: marketplace/funnel/utilizzo coerenti col DB", stats.growth.marketplace.total === dbAccounts && stats.growth.signup_funnel.requests === dbSignups && stats.usage.totals.gestionale_users === dbUsers, `mk=${stats.growth.marketplace.total}/${dbAccounts} f=${stats.growth.signup_funnel.requests}/${dbSignups}`);

  // U2: piano piu' venduto = ZZ Stat (unico piano con tenant assegnato) + MRR
  const zzPlan = (stats.plans.by_plan ?? []).find((p) => p.id === planId);
  check("U2 stats: piano ZZ con 1 tenant e MRR 9.90 + top venduto", zzPlan?.tenants === 1 && zzPlan?.mrr === 9.9 && stats.plans.top_by_tenants === `ZZ Stat ${RUN}` && stats.revenue.mrr_total >= 9.9, `top=${stats.plans.top_by_tenants} mrr=${stats.revenue.mrr_total}`);

  // U3: cron -> snapshot del giorno in saas_metrics_daily
  const cron = await (await fetch(`${BASE}/api/cron/admin-health`)).json();
  const today = new Date(); const p2 = (n) => String(n).padStart(2, "0");
  const day = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
  const snapRow = (await db.query("SELECT mrr, tenants_active, marketplace_accounts FROM saas_metrics_daily WHERE day=$1", [day])).rows[0];
  check("U3 cron -> snapshot giornaliero scritto (mrr/tenant/account)", cron.snapshot === day && !!snapRow && Number(snapRow.mrr) >= 9.9 && Number(snapRow.tenants_active) >= 1 && Number(snapRow.marketplace_accounts) === dbAccounts, `snap=${JSON.stringify(snapRow)}`);

  // U4: exec nella overview (dashboard): mrr e utenti marketplace correnti
  const ov = await (await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } })).json();
  check("U4 overview.exec: mrr>=9.90 + account marketplace", Number(ov.exec?.mrr) >= 9.9 && Number(ov.exec?.marketplace_accounts) === dbAccounts, `exec=${JSON.stringify(ov.exec)}`);

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // U5: vista Statistiche — Crescita con grafico SVG renderizzato
  await page.goto(`${BASE}/admin?page=stats`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Nuovi tenant per mese").waitFor({ timeout: 45000 });
  const svgCount = await page.locator("svg[role='img']").count();
  const mkMetric = await page.locator("text=Utenti marketplace").count();
  check("U5 UI Statistiche/Crescita: grafici SVG + metriche", svgCount >= 1 && mkMetric >= 1, `svg=${svgCount}`);

  // U6: sottotab Piani -> piano piu' venduto visibile
  await page.locator("button", { hasText: "Piani" }).last().click();
  await page.locator("text=Piano più venduto").waitFor({ timeout: 20000 });
  const topPlan = await page.locator(`text=ZZ Stat ${RUN}`).count();
  check("U6 UI Statistiche/Piani: top venduto renderizzato", topPlan >= 1, `top=${topPlan}`);

  // U7: sottotab Entrate -> MRR + sezione trend
  await page.locator("button", { hasText: "Entrate" }).click();
  await page.locator("text=Ricavo mensile da abbonamenti").first().waitFor({ timeout: 20000 });
  const trendHead = await page.locator("text=Andamento MRR").count();
  check("U7 UI Statistiche/Entrate: MRR + Andamento", trendHead === 1, `trend=${trendHead}`);

  // U8: dashboard executive — MRR/marketplace/nav 9 voci
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Ricavo abbonamenti (MRR)").first().waitFor({ timeout: 30000 });
  const navCount = await page.locator("aside nav button").count();
  const mkCard = await page.locator("text=Utenti marketplace").count();
  check("U8 dashboard executive + nav 9 voci con Statistiche", navCount === 9 && mkCard >= 1, `nav=${navCount}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (tid) {
      await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenant_health_checks WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    // Ri-fotografa il giorno SENZA i fixture (upsert stesso giorno).
    await fetch(`${BASE}/api/cron/admin-health`).catch(() => {});
    console.log("CLEANUP: ok (piano/tenant/admin per id; snapshot ricalcolato pulito)");
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
