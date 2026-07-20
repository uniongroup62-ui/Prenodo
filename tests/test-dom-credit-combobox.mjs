// Verifica DOM (Playwright) 2026-07-16 — Credito: entrambe le select clienti
// sostituite da ClientSearchCombobox server-side (filtro + scalo manuale).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["fidelity.manage", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cli = 0;
try {
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id,credit_balance) VALUES (25,$1,21,42.5) RETURNING id", [`ZZ CredCli${RUN}`])).rows[0].id);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  await page.goto(`http://localhost:3000/${SLUG}/credit_movements`, { waitUntil: "networkidle" });

  // DOM1: due combobox presenti (filtro + scalo manuale), nessuna vecchia <select> clienti
  const nCombo = await page.locator(".app-combobox-toggle").count();
  check("DOM1 due ClientSearchCombobox renderizzati", nCombo === 2, `count=${nCombo}`);

  // DOM2: filtro — digitando trova il cliente via server e mostra il saldo dopo la selezione
  await page.locator(".app-combobox-toggle").first().click();
  await page.locator(".app-combobox-search").first().fill(`ZZ CredCli${RUN}`);
  await page.waitForTimeout(900);
  const item = await page.locator(`.app-combobox-list button:has-text("ZZ CredCli${RUN}")`).first().textContent().catch(() => null);
  check("DOM2 filtro: ricerca server trova il cliente", String(item ?? "").includes(`ZZ CredCli${RUN}`), JSON.stringify(item));
  await page.locator(`.app-combobox-list button:has-text("ZZ CredCli${RUN}")`).first().click();
  await page.waitForTimeout(1200);
  const toggleTxt = await page.locator(".app-combobox-toggle").first().textContent();
  check("DOM3 selezione filtro: label con nome + saldo (selectedClient)", String(toggleTxt ?? "").includes(`ZZ CredCli${RUN}`) && /42,50/.test(String(toggleTxt ?? "")), JSON.stringify(toggleTxt));

  // DOM4: header movimenti filtrati (0 movimenti per il seed)
  const total = await page.locator(".bs-page-actions .text-muted").first().textContent().catch(() => null);
  check("DOM4 lista filtrata per il cliente (0 movimenti)", /0 movimenti/.test(String(total ?? "")), JSON.stringify(total));

  // DOM5: combobox scalo manuale — stessa ricerca server
  await page.locator(".app-combobox-toggle").nth(1).click();
  await page.locator(".app-combobox-search:visible").first().fill(`ZZ CredCli${RUN}`);
  await page.waitForTimeout(900);
  const item2 = await page.locator(`.app-combobox-list button:has-text("ZZ CredCli${RUN}")`).first().textContent().catch(() => null);
  check("DOM5 scalo manuale: ricerca server trova il cliente", String(item2 ?? "").includes(`ZZ CredCli${RUN}`), JSON.stringify(item2));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]).catch(() => {});
  const left = cli ? Number((await db.query("SELECT COUNT(*) n FROM clients WHERE tenant_id=25 AND id=$1", [cli])).rows[0].n) : 0;
  console.log(`CLEANUP: client residuo=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
