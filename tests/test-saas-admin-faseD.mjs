// Pannello admin Fase D (2026-07-19): timeline unificata del tenant (audit +
// diagnostica + backup + supporto + SMS) — API e tab UI con deep-link.
// Fixture zz-fased* rimosse per id/chiave tracciati.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.fased${RUN}@example.test`;
const SLUG = `zz-fased${RUN}`;
let adminId = 0, tid = 0, orderId = 0; const r2Keys = []; let browser = null;
const s3 = new S3Client({ region: "auto", endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") } });
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ FaseD", EMAIL, bcrypt.hashSync("FaseD!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "FaseD!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ FaseD',$2,1,'active') RETURNING id", [SLUG, `t_zzfased${RUN}_`]);
  tid = Number(t.rows[0].id);

  // Semina eventi su tutte e 5 le fonti: audit NON-duplicato (update — i
  // support./backup_create/sms_credit. sono filtrati come doppioni dal fix
  // UX 19/07), health, backup (R2), supporto creato+revocato, ordine SMS.
  await post(cookie, "/api/admin/tenants", { action: "update", slug: SLUG, name: "ZZ FaseD" });
  await post(cookie, "/api/admin/tenants", { action: "record_health", slug: SLUG });
  const bk = await (await post(cookie, "/api/admin/operations", { action: "backup_create", slug: SLUG, reason: "ZZ faseD backup" })).json();
  if (String(bk?.backup?.path ?? "").startsWith("r2:")) r2Keys.push(String(bk.backup.path).slice(3));
  const tok = await (await post(cookie, "/api/admin/tenants", { action: "support_create", slug: SLUG, reason: `ZZ faseD supporto ${RUN}`, minutes: "10" })).json();
  await post(cookie, "/api/admin/tenants", { action: "support_revoke", slug: SLUG, token_id: String(tok?.token?.id ?? 0) });
  const topup = await (await post(cookie, "/api/admin/operations", { action: "sms_manual_topup", tenant_slug: SLUG, credits: "5", amount_gross: "3", note: "ZZ faseD" })).json();
  orderId = Number(topup?.id ?? 0);

  // J1: timeline API con tutte e 5 le fonti, ordinata DESC
  const det = await (await fetch(`${BASE}/api/admin/tenants?slug=${SLUG}`, { headers: { cookie } })).json();
  const tl = det.timeline ?? [];
  const kinds = new Set(tl.map((e) => e.kind));
  const sorted = tl.every((e, i) => i === 0 || tl[i - 1].at >= e.at);
  check("J1 timeline API: 5 fonti fuse e ordinate DESC", tl.length >= 6 && ["audit", "health", "backup", "support", "sms"].every((k) => kinds.has(k)) && sorted, `n=${tl.length} kinds=${[...kinds].join(",")} sorted=${sorted}`);

  // J2: eventi supporto espansi (creato + revocato dalla stessa riga)
  const supTitles = tl.filter((e) => e.kind === "support").map((e) => e.title);
  check("J2 supporto: evento creazione + revoca", supTitles.includes("Token supporto creato") && supTitles.includes("Token supporto revocato"), supTitles.join(","));

  // J3: deep-link ?tab=timeline -> feed renderizzato con badge
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=timeline`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Token supporto revocato").first().waitFor({ timeout: 30000 });
  const badges = await Promise.all(["Diagnostica", "Backup", "Supporto", "SMS"].map((b) => page.locator(`span:text-is("${b}")`).count()));
  check("J3 deep-link tab=timeline -> feed con badge di ogni fonte", badges.every((n) => n >= 1) && /tab=timeline/.test(page.url()), `badges=${badges.join(",")}`);

  // J4: click sulla tab dal dettaglio -> URL sincronizzato
  await page.locator("button", { hasText: "Panoramica" }).first().click();
  await page.waitForURL((u) => !String(u).includes("tab=timeline"), { timeout: 20000 }).catch(() => undefined);
  await page.locator("button", { hasText: "Timeline" }).first().click();
  await page.waitForURL(/tab=timeline/, { timeout: 20000 });
  check("J4 click tab Timeline -> URL ?tab=timeline", /tab=timeline/.test(page.url()), page.url().slice(-40));
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    for (const key of r2Keys) await s3.send(new DeleteObjectCommand({ Bucket: env("R2_BUCKET_PRIVATE"), Key: key })).catch(() => {});
    if (orderId) {
      await db.query("DELETE FROM saas_sms_order_events WHERE order_id=$1", [orderId]).catch(() => {});
      await db.query("DELETE FROM saas_sms_orders WHERE id=$1", [orderId]).catch(() => {});
    }
    if (tid) {
      for (const tab of ["saas_tenant_backups", "saas_tenant_audit_logs", "saas_tenant_health_checks", "saas_support_access_tokens", "sms_credit_movements", "sms_credit_wallet", "tenant_onboarding_progress"]) {
        await db.query(`DELETE FROM "${tab}" WHERE tenant_id=$1`, [tid]).catch(() => {});
      }
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (R2, ordine, righe tenant, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
