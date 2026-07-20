// Rifiniture pannello (2026-07-19): crediti SMS nel dettaglio, Esegui-ora
// cron dal pannello, alert multipli con anti-spam 24h, policy 2FA
// obbligatoria con blocco soft. Fixture zz-rif* rimosse per id; la policy
// viene SEMPRE disattivata nel cleanup.
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
const OWNER = `zz.rifo${RUN}@example.test`;
const VIEWER = `zz.rifv${RUN}@example.test`;
const SLUG = `zz-rif${RUN}`;
let ownerId = 0, viewerId = 0, tid = 0, failTid = 0, orderId = 0, cronWatermark = 0, browser = null;
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });
const localSql = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

try {
  const insO = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ RifO", OWNER, bcrypt.hashSync("Rif!12345", 10)]);
  ownerId = Number(insO.rows[0].id);
  const insV = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'viewer',1) RETURNING id", ["ZZ RifV", VIEWER, bcrypt.hashSync("Rif!12345", 10)]);
  viewerId = Number(insV.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: OWNER, password: "Rif!12345" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const loginV = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: VIEWER, password: "Rif!12345" }) });
  const cookieV = (loginV.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // Fixture: tenant finto + ricarica 7 crediti
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ Rif',$2,1,'active') RETURNING id", [SLUG, `t_zzrif${RUN}_`]);
  tid = Number(t.rows[0].id);
  const topup = await (await post(cookie, "/api/admin/operations", { action: "sms_manual_topup", tenant_slug: SLUG, credits: "7", amount_gross: "3", note: "ZZ rif" })).json();
  orderId = Number(topup?.id ?? 0);

  // R1: dettaglio con smsCredits + riga 'Crediti SMS' in Panoramica
  const det = await (await fetch(`${BASE}/api/admin/tenants?slug=${SLUG}`, { headers: { cookie } })).json();
  check("R1 dettaglio API: smsCredits=7", Number(det.smsCredits) === 7, `credits=${det.smsCredits}`);

  // R2: Esegui ora dal pannello -> cron vero con registro
  cronWatermark = Number((await db.query("SELECT COALESCE(MAX(id),0) m FROM saas_cron_runs")).rows[0].m);
  const run = await (await post(cookie, "/api/admin/operations", { action: "cron_run", job: "admin-health" })).json();
  const runRow = (await db.query("SELECT id FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark])).rows.length;
  check("R2 cron_run admin-health -> eseguito e registrato", run.ok === true && run.result?.ok === true && runRow >= 1, `checked=${run.result?.checked}`);

  // R3: alert multipli — cron fallito + tenant failed seminati -> chiavi nel payload
  await db.query("INSERT INTO saas_cron_runs(job,status,started_at,duration_ms,message) VALUES('zz-cron-rif','error',$1,5,'ZZ errore')", [localSql()]);
  const ft = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status,provisioning_error) VALUES($1,'ZZ RifFail',$2,0,'failed','ZZ provisioning ko') RETURNING id", [`${SLUG}-fail`, `t_zzriff${RUN}_`]);
  failTid = Number(ft.rows[0].id);
  const cron1 = await (await fetch(`${BASE}/api/cron/admin-health`)).json();
  check("R3 alert multipli: cron_error + tenants_failed segnalati", (cron1.alerts ?? []).includes("cron_error:zz-cron-rif") && (cron1.alerts ?? []).includes("tenants_failed"), JSON.stringify(cron1.alerts));

  // R4: anti-spam — chiave marcata di recente NON si ripete
  await db.query("INSERT INTO saas_admin_alerts(alert_key,last_sent_at) VALUES('cron_error:zz-cron-rif',$1) ON CONFLICT (alert_key) DO UPDATE SET last_sent_at=EXCLUDED.last_sent_at", [localSql()]);
  const cron2 = await (await fetch(`${BASE}/api/cron/admin-health`)).json();
  check("R4 anti-spam 24h: chiave recente esclusa, le altre restano", !(cron2.alerts ?? []).includes("cron_error:zz-cron-rif") && (cron2.alerts ?? []).includes("tenants_failed"), JSON.stringify(cron2.alerts));

  // R5: policy 2FA — il viewer NON puo' impostarla
  const vSet = await post(cookieV, "/api/admin/security", { action: "totp_policy_set", value: "1" });
  check("R5 policy 2FA: viewer respinto (solo owner)", vSet.status === 403, `status=${vSet.status}`);

  // R6: owner attiva la policy -> blocco SOFT per chi non ha la 2FA
  const oSet = await (await post(cookie, "/api/admin/security", { action: "totp_policy_set", value: "1" })).json();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("text=2FA obbligatoria").first().waitFor({ timeout: 30000 });
  const dashboardHidden = await page.locator("text=Da fare adesso").count();
  check("R6 policy attiva -> blocco soft (dashboard nascosta)", oSet.totpPolicyRequired === true && dashboardHidden === 0, `hidden=${dashboardHidden === 0}`);

  // R7: il blocco porta alla Sicurezza, che resta usabile
  await page.locator("button", { hasText: "Configura la 2FA" }).click();
  await page.locator("text=Autenticazione a due fattori").waitFor({ timeout: 20000 });
  const policyToggle = await page.locator("button", { hasText: "Disattiva policy" }).count();
  check("R7 vista Sicurezza usabile + toggle policy owner visibile", /page=security/.test(page.url()) && policyToggle === 1, page.url().slice(-20));

  // R8: owner disattiva la policy -> pannello di nuovo pieno
  await post(cookie, "/api/admin/security", { action: "totp_policy_set", value: "0" });
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Da fare adesso").waitFor({ timeout: 30000 });
  check("R8 policy off -> dashboard di nuovo visibile", true);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    await db.query("DELETE FROM saas_admin_settings WHERE key='require_totp'").catch(() => {});
    await db.query("DELETE FROM saas_admin_alerts WHERE alert_key IN ('cron_error:zz-cron-rif','tenants_failed','health_errors','login_anomaly')").catch(() => {});
    await db.query("DELETE FROM saas_cron_runs WHERE job='zz-cron-rif'").catch(() => {});
    if (cronWatermark >= 0) await db.query("DELETE FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark]).catch(() => {});
    if (orderId) {
      await db.query("DELETE FROM saas_sms_order_events WHERE order_id=$1", [orderId]).catch(() => {});
      await db.query("DELETE FROM saas_sms_orders WHERE id=$1", [orderId]).catch(() => {});
    }
    for (const id of [tid, failTid].filter(Boolean)) {
      for (const tab of ["sms_credit_movements", "sms_credit_wallet", "saas_tenant_audit_logs", "saas_tenant_health_checks", "tenant_onboarding_progress"]) {
        await db.query(`DELETE FROM "${tab}" WHERE tenant_id=$1`, [id]).catch(() => {});
      }
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [id]).catch(() => {});
    }
    for (const id of [ownerId, viewerId].filter(Boolean)) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [id]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [id]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [id]).catch(() => {});
    }
    for (const mail of [OWNER, VIEWER]) await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [mail]).catch(() => {});
    const policy = (await db.query("SELECT value FROM saas_admin_settings WHERE key='require_totp'")).rows[0];
    console.log(`CLEANUP: policy=${policy ? policy.value : "assente"} -> ${!policy ? "CLEAN" : "ATTENZIONE"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
