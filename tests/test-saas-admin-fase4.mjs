// SaaS Admin Fase 4 (2026-07-19): banner supporto nel gestionale, export CSV,
// cron health-check, attest backup pre-delete. Dati temporanei rimossi per ID
// tracciati (admin zz.saas4*, token supporto creato in-sessione).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const BASE = "http://localhost:3000";
const SLUG = "centroesteticoelite";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.saas4${RUN}@example.test`;
let adminId = 0; let tokenId = 0; let browser = null; let cronWatermark = 0;

try {
  // E1: admin temporaneo + login -> cookie sessione
  const ins = await db.query(
    "INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id",
    ["ZZ Fase4", EMAIL, bcrypt.hashSync("Fase4Test!12", 10)],
  );
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Fase4Test!12" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  check("E1 login admin temp -> cookie sessione", login.status === 200 && !!cookie, `status=${login.status}`);

  // E2: export CSV tenant -> text/csv, intestazione, tenant reale presente
  const csvT = await fetch(`${BASE}/api/admin/operations?section=export_tenants`, { headers: { cookie } });
  const csvTBody = await csvT.text();
  const csvTType = csvT.headers.get("content-type") || "";
  const csvTDisp = csvT.headers.get("content-disposition") || "";
  check("E2 export_tenants -> CSV con header+dati", csvT.status === 200 && csvTType.includes("text/csv") && csvTDisp.includes("tenants.csv") && csvTBody.includes('"id";"slug";"nome";"stato";"creato_il"') && csvTBody.includes(SLUG), `type=${csvTType}`);

  // E3: export senza sessione -> respinto (mai CSV)
  const csvNo = await fetch(`${BASE}/api/admin/operations?section=export_tenants`);
  const csvNoType = csvNo.headers.get("content-type") || "";
  check("E3 export senza sessione -> respinto", csvNo.status !== 200 || !csvNoType.includes("text/csv"), `status=${csvNo.status} type=${csvNoType}`);

  // E4: export ordini SMS -> CSV con intestazione
  const csvS = await fetch(`${BASE}/api/admin/operations?section=export_sms_orders`, { headers: { cookie } });
  const csvSBody = await csvS.text();
  check("E4 export_sms_orders -> CSV con header", csvS.status === 200 && (csvS.headers.get("content-type") || "").includes("text/csv") && csvSBody.includes('"id";"tenant";"crediti"'), `status=${csvS.status}`);

  // E5: audit registra gli export — la scrittura e' fire-and-forget: POLL
  // fino a 6s invece di leggere subito (flake nota sotto carico).
  let audActions = [];
  for (let i = 0; i < 6; i++) {
    const aud = await db.query("SELECT action FROM saas_admin_audit WHERE admin_id=$1 AND action LIKE 'ops_export%'", [adminId]);
    audActions = aud.rows.map((r) => r.action);
    if (audActions.includes("ops_export_tenants") && audActions.includes("ops_export_sms_orders")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check("E5 audit ops_export_tenants + ops_export_sms_orders", audActions.includes("ops_export_tenants") && audActions.includes("ops_export_sms_orders"), audActions.join(","));

  // E6: crea token supporto via API -> link con support_token
  const tok = await fetch(`${BASE}/api/admin/tenants`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "support_create", slug: SLUG, reason: `ZZ test banner ${RUN}`, minutes: "30" }) });
  const tokData = await tok.json();
  tokenId = Number(tokData?.token?.id ?? 0);
  const tokLink = String(tokData?.token?.link ?? "");
  check("E6 support_create -> token con link", tok.status === 200 && tokenId > 0 && tokLink.includes("support_token="), `id=${tokenId}`);

  // E7: consumo token in browser pulito -> dashboard con banner supporto
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(tokLink.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/centroesteticoelite\/dashboard/, { timeout: 30000 });
  const banner = page.locator("div.alert-info", { hasText: "Accesso supporto attivo." });
  await banner.waitFor({ timeout: 20000 });
  const bannerText = (await banner.textContent()) || "";
  check("E7 banner supporto visibile con generato-da + motivo", bannerText.includes(EMAIL) && bannerText.includes(`ZZ test banner ${RUN}`), bannerText.slice(0, 120));

  // E8: token marcato used_at; secondo uso -> respinto al login con errore
  const used = await db.query("SELECT used_at FROM saas_support_access_tokens WHERE id=$1", [tokenId]);
  const page2 = await ctx.newPage();
  await page2.goto(tokLink.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(1500);
  const reuseUrl = page2.url();
  check("E8 used_at valorizzato + riuso -> login con errore", !!used.rows[0]?.used_at && /manage\/login/.test(reuseUrl) && /utilizzato|msg=/.test(decodeURIComponent(reuseUrl)), reuseUrl.slice(0, 120));
  await page2.close();

  // E9: revoca token (anche se gia' usato) -> la sessione supporto MUORE:
  //     al reload si viene respinti al login del gestionale
  const rev = await fetch(`${BASE}/api/admin/tenants`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "support_revoke", slug: SLUG, token_id: String(tokenId) }) });
  const revoked = await db.query("SELECT revoked_at FROM saas_support_access_tokens WHERE id=$1", [tokenId]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(/manage\/login/, { timeout: 20000 }).catch(() => undefined);
  check("E9 revoca post-uso -> revoked_at + sessione terminata (login)", rev.status === 200 && !!revoked.rows[0]?.revoked_at && /manage\/login/.test(page.url()), `status=${rev.status} url=${page.url().slice(0, 90)}`);

  // E10: cron health -> 200 con conteggi, nessuna email (SES non configurato)
  cronWatermark = Number((await db.query("SELECT COALESCE(MAX(id),0) m FROM saas_cron_runs").catch(() => ({ rows: [{ m: -1 }] }))).rows?.[0]?.m ?? -1);
  const cron = await fetch(`${BASE}/api/cron/admin-health`);
  const cronData = await cron.json().catch(() => ({}));
  check("E10 cron admin-health -> ok, checked>0, alerted=0", cron.status === 200 && cronData.ok === true && Number(cronData.checked) > 0 && Number(cronData.alerted) === 0, JSON.stringify(cronData));

  // E11: attest codice — cron protetto da assertCronAuth; delete con backup
  //      automatico PRIMA di deleteSaasTenant + audit dedicato (nessuna
  //      cancellazione live: tenant reali intoccabili).
  const cronSrc = readFileSync(new URL("../app/api/cron/admin-health/route.ts", import.meta.url), "utf8");
  const tenSrc = readFileSync(new URL("../app/api/admin/tenants/route.ts", import.meta.url), "utf8");
  const preIdx = tenSrc.indexOf("createSaasTenantBackup(slug, \"pre-delete automatico\")");
  const delIdx = tenSrc.indexOf("await deleteSaasTenant(slug");
  check("E11 attest: cron con assertCronAuth + pre-backup PRIMA del delete + audit", cronSrc.includes("assertCronAuth(request)") && preIdx > -1 && delIdx > preIdx && tenSrc.includes('"tenant_delete_prebackup"'), `pre=${preIdx} del=${delIdx}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  // Cleanup per ID tracciati (mai per inferenza)
  if (cronWatermark >= 0) await db.query("DELETE FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark]).catch(() => {});
  if (tokenId) await db.query("DELETE FROM saas_support_access_tokens WHERE id=$1", [tokenId]).catch(() => {});
  if (adminId) {
    await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
    await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
    await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
  }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
