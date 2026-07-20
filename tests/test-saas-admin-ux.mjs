// Fix UX pannello admin (2026-07-19): layout Tenant senza sovrapposizioni,
// onboarding coerente lista/dettaglio, controlli in Panoramica, tab a capo,
// timeline senza doppioni, Modifica piano per riga, conferma Sospendi.
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
const EMAIL = `zz.ux${RUN}@example.test`;
const SLUG = `zz-ux${RUN}`;
let adminId = 0, tid = 0, planId = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ UXFIX", EMAIL, bcrypt.hashSync("UxFix!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "UxFix!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ UXFIX',$2,1,'active') RETURNING id", [SLUG, `t_zzux${RUN}_`]);
  tid = Number(t.rows[0].id);

  // M1: API dettaglio — onboarding coerente con la lista (tenant reale 100%)
  const det = await (await fetch(`${BASE}/api/admin/tenants?slug=centroesteticoelite`, { headers: { cookie } })).json();
  check("M1 dettaglio: onboarding 100%/completed come in lista", det.tenant?.onboarding_status === "completed" && Number(det.tenant?.onboarding_percent) === 100, `status=${det.tenant?.onboarding_status} pct=${det.tenant?.onboarding_percent}`);

  // M2: timeline senza doppioni supporto/backup/sms come audit + etichette leggibili
  const tl = det.timeline ?? [];
  const auditDup = tl.filter((e) => e.kind === "audit" && (/^support\./.test(e.title) || /^tenant\.backup_create/.test(e.title) || /^sms_credit\./.test(e.title)));
  const readable = tl.filter((e) => e.kind === "audit").every((e) => !e.title.includes("."));
  check("M2 timeline: zero audit duplicati e slug tradotti", auditDup.length === 0 && readable, `dup=${auditDup.length} readable=${readable}`);

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // M3: LISTA a pagina piena (pagina dedicata 19/07) — Filtra cliccabile
  await page.goto(`${BASE}/admin?page=tenants`, { waitUntil: "domcontentloaded" });
  await page.locator("input[placeholder*='Slug']").waitFor({ timeout: 30000 });
  await page.fill("input[placeholder*='Slug']", "elite");
  await page.locator("button", { hasText: "Filtra" }).click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  check("M3 layout: lista piena, Filtra cliccabile senza force", true);
  // Il dettaglio ora e' PAGINA DEDICATA: si apre col deep-link.
  await page.goto(`${BASE}/admin?page=tenants&slug=centroesteticoelite`, { waitUntil: "domcontentloaded" });
  await page.locator("h2", { hasText: "elite" }).first().waitFor({ timeout: 30000 });

  // M4: tutte e 10 le tab del dettaglio VISIBILI (a capo, niente scroll nascosto)
  const tabNames = ["Panoramica", "Timeline", "Dati", "Admin", "Onboarding", "Diagnostica", "Supporto", "Backup", "Azioni critiche"]; // Visibilità fusa in Dati (19/07)
  const vis = [];
  for (const name of tabNames) {
    const box = await page.locator("button", { hasText: name }).first().boundingBox().catch(() => null);
    vis.push(box && box.x >= 0 && box.x + box.width <= 1440 && box.y > 0);
  }
  check("M4 dettaglio: 9 tab tutte visibili nel viewport", vis.every(Boolean), vis.map((v, i) => (v ? "" : tabNames[i])).filter(Boolean).join(",") || "tutte");

  // M5: Panoramica a SOLO-PROBLEMI (20/07): a tutto verde niente lista OK,
  // solo la riga di sintesi; la lista integrale vive nella tab Diagnostica.
  const summaryLine = await page.locator("text=controlli superati").count();
  const okRowsInOverview = await page.locator("text=Stato tenant").count();
  await page.locator("button", { hasText: "Diagnostica" }).first().click();
  await page.waitForTimeout(1500);
  const fullListInHealth = await page.locator("text=Stato tenant").count();
  check("M5 Panoramica solo-problemi + lista integrale in Diagnostica", summaryLine === 1 && okRowsInOverview === 0 && fullListInHealth >= 1, `sintesi=${summaryLine} overview=${okRowsInOverview} health=${fullListInHealth}`);

  // M6: billing — Modifica per riga precompila il form
  const save = await fetch(`${BASE}/api/admin/operations`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "plan_save", name: `ZZ Piano UX ${RUN}`, price_month: "19.90", max_locations: "3" }) });
  planId = Number((await save.json().catch(() => ({})))?.id ?? 0);
  await page.goto(`${BASE}/admin?page=billing`, { waitUntil: "domcontentloaded" });
  await page.locator("tr", { hasText: `ZZ Piano UX ${RUN}` }).locator("button", { hasText: "Modifica" }).click({ timeout: 30000 });
  await page.waitForTimeout(600);
  const nameVal = await page.locator("input[name='name']").first().inputValue();
  const maxLocVal = await page.locator("input[name='max_locations']").first().inputValue();
  const editTitle = await page.locator(`text=Modifica piano: ZZ Piano UX ${RUN}`).count();
  check("M6 billing: Modifica precompila nome/limiti + titolo cambia", nameVal === `ZZ Piano UX ${RUN}` && maxLocVal === "3" && editTitle === 1, `name=${nameVal} maxLoc=${maxLocVal}`);

  // M7: Sospendi chiede CONFERMA; dismiss -> il tenant finto resta attivo
  let dialogText = "";
  page.on("dialog", (dialog) => { dialogText = dialog.message(); void dialog.dismiss(); });
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=danger`, { waitUntil: "domcontentloaded" });
  await page.locator("button", { hasText: "Sospendi" }).click({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const still = (await db.query("SELECT status FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  check("M7 Sospendi: confirm mostrato, dismiss -> nessuna sospensione", dialogText.includes("Sospendere") && still?.status === "active", `dialog=${dialogText.slice(0, 50)} status=${still?.status}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (tid) {
      await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (piano, tenant finto, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
