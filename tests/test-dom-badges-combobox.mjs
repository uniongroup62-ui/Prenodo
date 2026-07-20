// Verifica DOM (Playwright) 2026-07-16: i badge 'Scade tra N giorni' RENDERIZZATI
// (pacchetti/preventivi/giftbox — lezione: la regex quotes era corrotta e i probe
// su dati+bundle non l'avevano colto) + combobox ricerca server-side.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["packages.clients", "packages.catalog", "quotes.manage", "giftbox.manage", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cpId = 0, qId = 0, giId = 0, tpl = 0, cli = 0;
try {
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ DomCli${RUN}`])).rows[0].id);
  cpId = Number((await db.query(`INSERT INTO client_packages (tenant_id, client_id, package_name, purchase_date, start_date, expires_at, sessions_total, sessions_remaining, status, location_id, updated_at)
    VALUES (25,$1,'ZZ DomPkg${RUN}',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE+5,5,3,'active',21,NOW()) RETURNING id`, [cli])).rows[0].id);
  qId = Number((await db.query(`INSERT INTO quotes (tenant_id, number, quote_date, valid_until, client_name, client_email, status, sent_at, subtotal, discount_total, tax_total, total, notes, location_id, created_by)
    VALUES (25,'ZZ-DOM${RUN}',CURRENT_DATE,CURRENT_DATE+3,'ZZ DomCli','zz@t.local','sent',NOW(),10,0,0,10,'ZZdom${RUN}',21,20) RETURNING id`)).rows[0].id);
  tpl = Number((await db.query("INSERT INTO giftboxes (tenant_id, name, active, created_at) VALUES (25,$1,1,NOW()) RETURNING id", [`ZZ DomGb${RUN}`])).rows[0].id);
  giId = Number((await db.query(`INSERT INTO giftbox_instances (tenant_id, giftbox_id, code, status, issued_at, expires_at, points_cost, created_by, created_at, location_id, location_name)
    VALUES (25,$1,'GBD-ZZ${RUN}','issued',NOW(),CURRENT_DATE+5,0,20,NOW(),21,'Sede1') RETURNING id`, [tpl])).rows[0].id);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // --- badge Pacchetti (DOM) ---
  await page.goto(`http://localhost:3000/${SLUG}/packages?tab=clients&status=all`, { waitUntil: "networkidle" });
  const pkgBadge = await page.locator(`tr:has-text("ZZ DomPkg${RUN}") .badge.text-bg-warning`).first().textContent().catch(() => null);
  check("DOM1 badge pacchetto renderizzato", String(pkgBadge ?? "").includes("Scade tra 5 giorni"), JSON.stringify(pkgBadge));

  // --- badge Preventivi (DOM) — la regex corrotta qui sarebbe stata invisibile ai probe dati ---
  await page.goto(`http://localhost:3000/${SLUG}/quotes?number=ZZ-DOM${RUN}`, { waitUntil: "networkidle" });
  const qBadge = await page.locator(`tr:has-text("ZZ-DOM${RUN}") .badge.text-bg-warning`).first().textContent().catch(() => null);
  check("DOM2 badge preventivo renderizzato (regex riparata)", String(qBadge ?? "").includes("Scade tra 3 giorni"), JSON.stringify(qBadge));

  // --- badge GiftBox (DOM) ---
  await page.goto(`http://localhost:3000/${SLUG}/giftbox?q=GBD-ZZ${RUN}`, { waitUntil: "networkidle" });
  const gBadge = await page.locator(`tr:has-text("GBD-ZZ${RUN}") .badge.text-bg-warning`).first().textContent().catch(() => null);
  check("DOM3 badge giftbox renderizzato", String(gBadge ?? "").includes("Scade tra 5 giorni"), JSON.stringify(gBadge));

  // --- combobox ricerca server-side (GiftBox Mittente) ---
  await page.goto(`http://localhost:3000/${SLUG}/giftbox`, { waitUntil: "networkidle" });
  await page.locator(".app-combobox-toggle").first().click();
  await page.locator(".app-combobox-search").first().fill("ZZ DomCli");
  await page.waitForTimeout(900); // debounce 300ms + fetch
  const item = await page.locator(`.app-combobox-list button:has-text("ZZ DomCli${RUN}")`).first().textContent().catch(() => null);
  check("DOM4 combobox: digitando trova il cliente via server", String(item ?? "").includes(`ZZ DomCli${RUN}`), JSON.stringify(item));
  await page.locator(`.app-combobox-list button:has-text("ZZ DomCli${RUN}")`).first().click();
  const toggleTxt = await page.locator(".app-combobox-toggle").first().textContent();
  check("DOM5 selezione mostra il label", String(toggleTxt ?? "").includes(`ZZ DomCli${RUN}`), JSON.stringify(toggleTxt));

  // --- payload senza anagrafica completa ---
  const j = await page.evaluate(async (slug) => {
    const r = await fetch(`/api/manage/giftboxes?slug=${slug}&action=manage_list`);
    return await r.json();
  }, SLUG);
  check("DOM6 payload lista SENZA clientItems", j.clientItems === undefined && typeof j.selectedClientLabel === "string", JSON.stringify(Object.keys(j)));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (giId) await db.query("DELETE FROM giftbox_instances WHERE tenant_id=25 AND id=$1", [giId]).catch(() => {});
  if (tpl) await db.query("DELETE FROM giftboxes WHERE tenant_id=25 AND id=$1", [tpl]).catch(() => {});
  if (qId) { await db.query("DELETE FROM quote_items WHERE tenant_id=25 AND quote_id=$1", [qId]).catch(() => {}); await db.query("DELETE FROM quotes WHERE tenant_id=25 AND id=$1", [qId]).catch(() => {}); }
  if (cpId) await db.query("DELETE FROM client_packages WHERE tenant_id=25 AND id=$1", [cpId]).catch(() => {});
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]).catch(() => {});
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM quotes WHERE tenant_id=25 AND number LIKE 'ZZ-DOM%') a, (SELECT COUNT(*)::int FROM client_packages WHERE tenant_id=25 AND package_name LIKE 'ZZ DomPkg%') b, (SELECT COUNT(*)::int FROM giftbox_instances WHERE tenant_id=25 AND code LIKE 'GBD-ZZ%') c, (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ DomCli%') d")).rows[0];
  console.log("cleanup ZZ residui:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
