// SaaS Admin Fase 3 (2026-07-19): SPA montata con URL VERI — deep-link,
// navigazione con pushState, tasto Indietro, vista Sicurezza, mapping dei
// nomi pagina legacy, robots. Admin temporaneo rimosso per id.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let adminId = 0;

try {
  const ins = await db.query(
    "INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id",
    ["ZZ Fase3", `zz.saas3${RUN}@example.test`, bcrypt.hashSync("Fase3Test!12", 10)],
  );
  adminId = Number(ins.rows[0].id);

  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `zz.saas3${RUN}@example.test`, password: "Fase3Test!12" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const [cn, cv] = cookie.split("=");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // D1: /admin -> SPA con sidebar a 9 voci
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const navCount = await page.locator("aside nav button").count();
  const h1 = await page.locator("header h1").textContent();
  // 8 voci (Registrazioni fusa in Tenant, 20/07).
  check("D1 /admin -> SPA con nav completa + Dashboard", navCount === 8 && (h1 || "").trim() === "Dashboard", `nav=${navCount} h1=${h1}`);

  // D2: click nav 'Audit' -> vista + URL aggiornato con pushState
  await page.locator("aside nav button", { hasText: "Audit" }).click();
  await page.waitForTimeout(800);
  check("D2 nav Audit -> URL ?page=audit", page.url().endsWith("/admin?page=audit"), page.url());

  // D3: tasto INDIETRO -> torna alla Dashboard
  await page.goBack();
  await page.waitForTimeout(800);
  const h1Back = await page.locator("header h1").textContent();
  check("D3 back -> Dashboard ripristinata", /\/admin$/.test(page.url()) && (h1Back || "").trim() === "Dashboard", `url=${page.url()} h1=${h1Back}`);

  // D4: deep-link diretto ?page=security -> vista Sicurezza con pannello 2FA
  await page.goto(`${BASE}/admin?page=security`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const secH1 = await page.locator("header h1").textContent();
  const totpBtn = await page.locator("button", { hasText: "Attiva 2FA" }).count();
  const sessTable = await page.locator("table").count();
  check("D4 deep-link security -> pannello 2FA + sessioni", (secH1 || "").trim() === "Sicurezza" && totpBtn === 1 && sessTable >= 1, `h1=${secH1} 2fa=${totpBtn}`);

  // D5: deep-link tenant legacy ?page=tenant_detail&slug=... -> dettaglio caricato
  await page.goto(`${BASE}/admin?page=tenant_detail&slug=centroesteticoelite`, { waitUntil: "domcontentloaded" });
  await page.locator("h2", { hasText: "elite" }).first().waitFor({ timeout: 20000 });
  const tabCount = await page.locator("button", { hasText: "Panoramica" }).count();
  const urlNorm = /page=tenants&slug=centroesteticoelite/.test(page.url());
  check("D5 legacy ?page=tenant_detail&slug -> dettaglio con tab + URL normalizzato", tabCount >= 1 && urlNorm, `tab=${tabCount} url=${page.url()}`);

  // D6: cambio tab -> URL con &tab= (sync a fetch completata: waitForURL)
  await page.locator("button", { hasText: "Diagnostica" }).first().click();
  await page.waitForURL(/tab=health/, { timeout: 20000 }).catch(() => undefined);
  check("D6 tab Diagnostica -> URL ?page=tenants&slug=..&tab=health", /page=tenants&slug=centroesteticoelite&tab=health/.test(page.url()), page.url());

  // D7: refresh sul deep-link tab -> stato ripristinato
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("h2", { hasText: "elite" }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  // Tab attiva = ink navy #182238 (restyle Fase F).
  const healthActive = await page.locator('button[class*="bg-[#182238]"]', { hasText: "Diagnostica" }).count();
  check("D7 refresh -> tab Diagnostica ancora attiva", healthActive === 1, `active=${healthActive}`);

  // D8: sezioni dati-pesanti caricano senza errori (controls + sms)
  await page.goto(`${BASE}/admin?page=controls`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const controlsBody = await page.locator("section, main").first().textContent();
  check("D8 ?page=controls carica la vista (legacy -> Operazioni)", /Operazioni/.test((await page.locator("header h1").textContent()) || ""), "");
  await page.screenshot({ path: "admin-fase3.png", fullPage: false });
  await browser.close();

  // R1: robots.txt con Disallow /admin
  const robots = await fetch(`${BASE}/robots.txt`).then((r) => r.text());
  check("R1 robots.txt: Disallow /admin", /Disallow:\s*\/admin/.test(robots), robots.replace(/\n/g, " ").slice(0, 80));
} finally {
  if (adminId > 0) {
    await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => 0);
    await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => 0);
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email LIKE 'zz.saas3%'").catch(() => 0);
    await db.query("DELETE FROM saas_admins WHERE id=$1 AND email LIKE 'zz.saas3%'", [adminId]);
  }
  const resid = (await db.query("SELECT COUNT(*)::int AS n FROM saas_admins WHERE email LIKE 'zz.saas3%'")).rows[0]?.n ?? -1;
  console.log(`CLEANUP: residui=${resid} (id=${adminId}) -> ${resid === 0 ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
