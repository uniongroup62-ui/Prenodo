// Tab Diagnostica riorganizzata (2026-07-20): riga di sintesi con data
// formattata + origine tradotta, didascalia bottoni, lista integrale, storico
// SOLO problemi (empty-state verde a tutto ok, tabella Problemi recenti se no).
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
const EMAIL = `zz.diag${RUN}@example.test`;
const SLUG = `zz-diag${RUN}`;
let adminId = 0, tid = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Diag", EMAIL, bcrypt.hashSync("Diag!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Diag!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // --- Ramo tenant SANO (centroesteticoelite: tutti i check ok) ---
  await page.goto(`${BASE}/admin?page=tenants&slug=centroesteticoelite&tab=health`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Ultima diagnostica:").waitFor({ timeout: 30000 });
  const body = await page.locator("main, body").first().innerText();
  const dateFmt = /Ultima diagnostica:\s*\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/.test(body);
  const microsec = /\d{2}:\d{2}:\d{2}\.\d+/.test(body);
  const origin = /Automatica|Manuale|Riparazione/.test(body);
  check("D1 sintesi: data formattata + origine tradotta, niente microsecondi", dateFmt && origin && !microsec, `fmt=${dateFmt} orig=${origin} micro=${microsec}`);
  // 20/07: la Verifica ingloba l'auto-riparazione — il bottone Ripara NON esiste piu'.
  const caption = await page.locator("text=ripara da sola i buchi additivi").count();
  const verifyButton = await page.locator("button", { hasText: "Verifica diagnostica" }).count();
  const repairButton = await page.locator("button", { hasText: "Ripara" }).count();
  check("D2 solo Verifica diagnostica (auto-riparante), niente bottone Ripara", caption === 1 && verifyButton === 1 && repairButton === 0, `caption=${caption} verify=${verifyButton} repair=${repairButton}`);
  const fullList = await page.locator("text=Stato tenant").count();
  const oldTable = await page.locator("text=Storico diagnostica").count();
  const emptyState = await page.locator("text=Nessun problema negli ultimi").count();
  const problemsTable = await page.locator("text=Problemi recenti").count();
  check("D3 sano: lista integrale + empty-state verde, niente muro di OK", fullList >= 1 && oldTable === 0 && emptyState === 1 && problemsTable === 0, `list=${fullList} old=${oldTable} empty=${emptyState} probl=${problemsTable}`);

  // --- Ramo tenant con PROBLEMI (ZZ senza admin -> check error) ---
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ Diag',$2,1,'active') RETURNING id", [SLUG, `t_zzdiag${RUN}_`]);
  tid = Number(t.rows[0].id);
  await fetch(`${BASE}/api/admin/tenants`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "record_health", slug: SLUG }) });
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=health`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Problemi recenti").waitFor({ timeout: 30000 });
  // 20/07: record_health manuale ingloba l'auto-riparazione -> il ZZ senza
  // admin resta in errore (non riparabile) ma onboarding/permessi vengono
  // chiusi e la diagnostica e' registrata come 'Automatica (riparazione)'.
  const zzBody = await page.locator("main, body").first().innerText();
  const zzOrigin = /Problemi recenti[\s\S]*(Automatica \(riparazione\)|Manuale)/.test(zzBody);
  const zzEmpty = await page.locator("text=Nessun problema negli ultimi").count();
  check("D4 con problemi: tabella Problemi recenti (origine tradotta), niente empty-state", zzOrigin && zzEmpty === 0, `origin=${zzOrigin} empty=${zzEmpty}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (tid) {
      await db.query("DELETE FROM saas_tenant_health_checks WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (tenant ZZ, health, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
