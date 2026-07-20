// Verifica DOM 2026-07-16 — Mittente server-side nei dettagli GiftBox/GiftCard:
// il payload view non trasporta più l'anagrafica; il combobox mostra senderName
// e cerca via action=client_search; il save update con nuovo mittente persiste.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftbox.manage", "giftcard.manage", "pos.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cliA = 0, cliB = 0, tpl = 0, giId = 0, gcId = 0;
try {
  cliA = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ GiftSndA${RUN}`])).rows[0].id);
  cliB = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ GiftSndB${RUN}`])).rows[0].id);
  tpl = Number((await db.query("INSERT INTO giftboxes (tenant_id, name, active, created_at) VALUES (25,$1,1,NOW()) RETURNING id", [`ZZ GbSnd${RUN}`])).rows[0].id);
  giId = Number((await db.query(`INSERT INTO giftbox_instances (tenant_id, giftbox_id, client_id, code, status, issued_at, expires_at, points_cost, created_by, created_at, location_id, location_name)
    VALUES (25,$1,$2,'GBS-ZZ${RUN}','issued',NOW(),CURRENT_DATE+30,0,20,NOW(),21,'Sede1') RETURNING id`, [tpl, cliA])).rows[0].id);
  gcId = Number((await db.query(`INSERT INTO giftcards (tenant_id, code, client_id, recipient_client_id, recipient_name, recipient_email, initial_amount, balance, status, issued_at, expires_at, note, gift_message, internal_note, event_type, voucher_hide_amount, location_id, location_name, created_at, updated_at)
    VALUES (25,'GCS-ZZ${RUN}',$1,0,'','',50,50,'active',NOW(),CURRENT_DATE+30,'','','','giftcard',0,21,'Sede1',NOW(),NOW()) RETURNING id`, [cliA])).rows[0].id);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // --- GiftBox instance detail ---
  await page.goto(`http://localhost:3000/${SLUG}/giftbox?tab=instances&action=edit_instance&id=${giId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-combobox-toggle", { timeout: 20000 });
  const gbLabel = await page.locator(".app-combobox-toggle").first().textContent();
  check("GB1 Mittente mostra senderName senza anagrafica", String(gbLabel ?? "").includes(`ZZ GiftSndA${RUN}`), JSON.stringify(gbLabel));
  await page.locator(".app-combobox-toggle").first().click();
  await page.locator(".app-combobox-search:visible").first().fill(`ZZ GiftSndB${RUN}`);
  await page.waitForTimeout(900);
  await page.locator(`.app-combobox-list button:has-text("ZZ GiftSndB${RUN}")`).first().click();
  await page.locator('button:has-text("Salva dati")').first().click().catch(async () => {
    await page.locator('#giftboxDataForm button[type="submit"], form button[type="submit"]').first().click();
  });
  await page.waitForTimeout(2500);
  const gbSender = Number((await db.query("SELECT client_id FROM giftbox_instances WHERE tenant_id=25 AND id=$1", [giId])).rows[0].client_id);
  check("GB2 save: nuovo mittente persistito", gbSender === cliB, `client_id=${gbSender} atteso=${cliB}`);

  // --- GiftCard detail ---
  await page.goto(`http://localhost:3000/${SLUG}/giftcard?action=edit&id=${gcId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-combobox-toggle", { timeout: 20000 });
  const gcLabel = await page.locator(".app-combobox-toggle").first().textContent();
  check("GC1 Mittente mostra senderName senza anagrafica", String(gcLabel ?? "").includes(`ZZ GiftSndA${RUN}`), JSON.stringify(gcLabel));
  await page.locator(".app-combobox-toggle").first().click();
  await page.locator(".app-combobox-search:visible").first().fill(`ZZ GiftSndB${RUN}`);
  await page.waitForTimeout(900);
  const found = await page.locator(`.app-combobox-list button:has-text("ZZ GiftSndB${RUN}")`).count();
  check("GC2 ricerca server nel combobox Mittente", found > 0, `found=${found}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (gcId) await db.query("DELETE FROM giftcards WHERE tenant_id=25 AND id=$1", [gcId]).catch(() => {});
  if (giId) await db.query("DELETE FROM giftbox_instances WHERE tenant_id=25 AND id=$1", [giId]).catch(() => {});
  if (tpl) await db.query("DELETE FROM giftboxes WHERE tenant_id=25 AND id=$1", [tpl]).catch(() => {});
  for (const c of [cliA, cliB]) if (c) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [c]).catch(() => {});
  const left = Number((await db.query("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=25 AND id=$1)+(SELECT COUNT(*) FROM giftbox_instances WHERE tenant_id=25 AND id=$2)+(SELECT COUNT(*) FROM giftboxes WHERE tenant_id=25 AND id=$3)+(SELECT COUNT(*) FROM clients WHERE tenant_id=25 AND id IN ($4,$5)) n", [gcId || 0, giId || 0, tpl || 0, cliA || 0, cliB || 0])).rows[0].n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
