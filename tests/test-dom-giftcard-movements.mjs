// DOM 2026-07-17 — dettaglio GiftCard: il riscatto POS ora scrive -12 e la
// tabella Movimenti lo renderizza in ROSSO (text-danger) con nota vendita.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f2" + "0846", SLUG = "centroesteticoelite";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftcard.manage", "pos.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cli = 0, gc = 0, txId = 0;
try {
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ GcDom${RUN}`])).rows[0].id);
  gc = Number((await db.query("INSERT INTO giftcards (tenant_id, code, client_id, initial_amount, balance, currency, status, issued_at, event_type, voucher_hide_amount, created_at, updated_at, location_id, location_name) VALUES (25,$1,$2,50,38,'EUR','active',NOW(),'giftcard',0,NOW(),NOW(),21,'Sede1') RETURNING id", [`ZZGCD-${RUN}`, cli])).rows[0].id);
  txId = Number((await db.query("INSERT INTO giftcard_transactions (tenant_id, giftcard_id, type, amount, note, created_at, created_by, location_id, location_name) VALUES (25,$1,'redeem',-12,$2,NOW(),20,21,'Sede1') RETURNING id", [gc, `Riscatto GiftCard in vendita #999999 (ZZGCD-${RUN})`])).rows[0].id);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:3000/${SLUG}/giftcard?action=edit&id=${gc}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  const row = page.locator(`tr:has-text("Riscatto GiftCard in vendita #999999")`).first();
  check("DOM1 riga movimento con nota vendita presente", (await row.count()) > 0);
  const red = await row.locator("span.text-danger").textContent().catch(() => null);
  check("DOM2 importo -12 renderizzato in ROSSO (text-danger)", /-12,00/.test(String(red ?? "")), JSON.stringify(red));
  const cells = await row.locator("td").allTextContents().catch(() => []);
  check("DOM3 sede e operatore visibili sulla riga", cells.some((t) => t.includes("Sede1")) && cells.some((t) => t.trim() === "luca"), JSON.stringify(cells));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (txId) await db.query("DELETE FROM giftcard_transactions WHERE tenant_id=25 AND id=$1", [txId]).catch(() => {});
  if (gc) await db.query("DELETE FROM giftcards WHERE tenant_id=25 AND id=$1", [gc]).catch(() => {});
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]).catch(() => {});
  const left = Number((await db.query("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=25 AND id=$1)+(SELECT COUNT(*) FROM clients WHERE tenant_id=25 AND id=$2) n", [gc || 0, cli || 0])).rows[0].n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
