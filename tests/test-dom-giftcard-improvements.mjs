// DOM 2026-07-17 — GiftCard migliorie: badge 'Scade tra N giorni' in lista e
// dettaglio + pager 25/pagina renderizzati (Playwright).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftcard.manage", "pos.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cli = 0, gcIds = [];
try {
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ GcDomImp${RUN}`])).rows[0].id);
  // 26 card (pager) di cui la prima scade tra 5 giorni (badge)
  const seeded = await db.query(`INSERT INTO giftcards (tenant_id, code, client_id, initial_amount, balance, currency, status, issued_at, expires_at, event_type, voucher_hide_amount, created_at, updated_at, location_id, location_name)
    SELECT 25, 'ZZGDI-${RUN}-'||g, $1, 10, 10, 'EUR', 'active', NOW(), CASE WHEN g=26 THEN CURRENT_DATE+5 ELSE CURRENT_DATE+300 END, 'giftcard', 0, NOW(), NOW(), 21, 'Sede1' FROM generate_series(1,26) g RETURNING id, code`, [cli]);
  gcIds = seeded.rows.map((r) => Number(r.id));
  const warnCode = seeded.rows[25].code; // g=26 (id piu' alto -> prima riga pagina 1) scade tra 5 giorni

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // Lista filtrata sui seed, pagina 1
  await page.goto(`http://localhost:3000/${SLUG}/giftcard?q=ZZGDI-${RUN}&all_locations=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  const nRows = await page.locator("table tbody tr").count();
  check("DOM1 pagina 1: 25 righe renderizzate", nRows === 25, `rows=${nRows}`);
  const header = await page.locator(".card-header .text-muted").first().textContent();
  check("DOM2 header '26 GiftCard · pagina 1 di 2'", /26 GiftCard · pagina 1 di 2/.test(String(header ?? "")), JSON.stringify(header));
  const badge = await page.locator(`tr:has-text("${warnCode}") .badge.text-bg-warning`).first().textContent().catch(() => null);
  check("DOM3 badge 'Scade tra 5 giorni' in lista", String(badge ?? "").includes("Scade tra 5 giorni"), JSON.stringify(badge));
  // Pager -> pagina 2
  await page.locator(".card-header button:has(.bi-chevron-right)").click();
  await page.waitForURL(/p=2/, { timeout: 15000 });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  const nRows2 = await page.locator("table tbody tr").count();
  check("DOM4 pagina 2: 1 riga", nRows2 === 1, `rows=${nRows2}`);

  // Dettaglio della card in scadenza: badge accanto allo Stato
  await page.goto(`http://localhost:3000/${SLUG}/giftcard?action=edit&id=${gcIds[25]}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".badge", { timeout: 20000 });
  const detBadge = await page.locator(".badge.text-bg-warning").first().textContent().catch(() => null);
  check("DOM5 badge scadenza nel dettaglio", String(detBadge ?? "").includes("Scade tra 5 giorni"), JSON.stringify(detBadge));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (gcIds.length) await db.query("DELETE FROM giftcards WHERE tenant_id=25 AND id = ANY($1::int[])", [gcIds]).catch(() => {});
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]).catch(() => {});
  const left = Number((await db.query("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=25 AND code LIKE $1)+(SELECT COUNT(*) FROM clients WHERE tenant_id=25 AND id=$2) n", [`ZZGDI-${RUN}%`, cli || 0])).rows[0].n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
