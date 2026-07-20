// Verifica 2026-07-16 — Promozioni form: picker "Clienti esclusi" server-side.
// API: context senza anagrafica, client_search gated, get con excludedClientRows,
// save round-trip. DOM: combobox nel form + aggiungi/rimuovi esclusione + nomi in edit.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const mk = (perms) => {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
};
const COOKIE_VAL = mk(["promotions.manage", "pos.manage"]);
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const H = { cookie: `beautysuite_session_t_${SLUG}=${COOKIE_VAL}`, "x-tenant-slug": SLUG };
const api = (qs, opts = {}) => fetch(`http://localhost:3000/api/manage/promotions?slug=${SLUG}${qs}`, { headers: { ...H, ...(opts.body ? { "content-type": "application/json" } : {}) }, ...(opts.body ? { method: "POST", body: JSON.stringify(opts.body) } : {}) });
let browser = null, cli = 0, promoId = 0;
try {
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ PromoCli${RUN}`])).rows[0].id);

  // A1: context non trasporta più l'anagrafica
  const c1 = await (await api("&action=context")).json();
  check("A1 context senza campo clients", c1.ok === true && !("clients" in c1) && Array.isArray(c1.services), JSON.stringify(Object.keys(c1)));

  // A2: client_search trova il seed; A3: gate promotions.manage (pos.manage solo NON basta)
  const c2 = await (await api(`&action=client_search&q=ZZ PromoCli${RUN}`)).json();
  check("A2 client_search trova il seed", (c2.clients || []).some((c) => c.id === cli), `n=${(c2.clients || []).length}`);
  const posOnly = mk(["pos.manage"]);
  const c3 = await fetch(`http://localhost:3000/api/manage/promotions?slug=${SLUG}&action=client_search&q=zz`, { headers: { cookie: `beautysuite_session_t_${SLUG}=${posOnly}`, "x-tenant-slug": SLUG } });
  check("A3 client_search negato senza promotions.manage", c3.status === 403, `status=${c3.status}`);

  // A4: save con esclusione + get con excludedClientRows
  const save = await (await api("", { body: { action: "save", title: `ZZ PromoEx${RUN}`, apply_services_mode: "all", discount_type: "percent", discount_value: "10", target_type: "all", excluded_client_ids_json: JSON.stringify([cli]), location_ids_json: JSON.stringify([21]) } })).json();
  promoId = Number(save?.promotion?.id ?? save?.id ?? 0);
  check("A4 save promo con esclusione", save.ok === true && promoId > 0, JSON.stringify({ ok: save.ok, id: promoId, err: save.error }));
  const g = await (await api(`&action=get&id=${promoId}`)).json();
  const rows = g?.promotion?.excludedClientRows || [];
  check("A5 get: excludedClientRows con nome risolto", g.ok === true && rows.length === 1 && rows[0].id === cli && rows[0].name === `ZZ PromoCli${RUN}`, JSON.stringify(rows));

  // DOM: form NUOVA promo — combobox esclusioni cerca server-side e aggiunge
  browser = await chromium.launch();
  const ctxB = await browser.newContext();
  await ctxB.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctxB.newPage();
  await page.goto(`http://localhost:3000/${SLUG}/promotions?action=new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-combobox-toggle", { timeout: 20000 });
  await page.locator(".app-combobox-toggle").first().click();
  await page.locator(".app-combobox-search:visible").first().fill(`ZZ PromoCli${RUN}`);
  await page.waitForTimeout(900);
  await page.locator(`.app-combobox-list button:has-text("ZZ PromoCli${RUN}")`).first().click();
  await page.locator("#promoExcludeAddBtn").click();
  await page.waitForTimeout(300);
  const rowTxt = await page.locator(`#promoExcludedClientsList`).textContent();
  check("DOM1 aggiungi esclusione via combobox", String(rowTxt ?? "").includes(`ZZ PromoCli${RUN}`), JSON.stringify(rowTxt));
  const comboTxt = await page.locator(".app-combobox-toggle").first().textContent();
  check("DOM2 combobox resettato dopo l'aggiunta", !String(comboTxt ?? "").includes(`ZZ PromoCli${RUN}`), JSON.stringify(comboTxt));

  // DOM3: EDIT della promo salvata — nome escluso risolto senza anagrafica
  await page.goto(`http://localhost:3000/${SLUG}/promotions?action=edit&id=${promoId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#promoExcludedClientsList", { timeout: 20000 });
  await page.waitForTimeout(800);
  const editTxt = await page.locator(`#promoExcludedClientsList`).textContent();
  check("DOM3 edit: escluso col nome da excludedClientRows", String(editTxt ?? "").includes(`ZZ PromoCli${RUN}`), JSON.stringify(editTxt));
  // DOM4: rimozione
  await page.locator("#promoExcludedClientsList .btn-outline-danger").first().click();
  await page.waitForTimeout(200);
  const afterTxt = await page.locator(`#promoExcludedClientsList`).textContent();
  check("DOM4 rimozione esclusione", String(afterTxt ?? "").includes("Nessun cliente escluso"), JSON.stringify(afterTxt));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (promoId) {
    await db.query("DELETE FROM promotion_locations WHERE tenant_id=25 AND promotion_id=$1", [promoId]).catch(() => {});
    await db.query("DELETE FROM promotions WHERE tenant_id=25 AND id=$1", [promoId]).catch(() => {});
  }
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]).catch(() => {});
  const leftP = promoId ? Number((await db.query("SELECT COUNT(*) n FROM promotions WHERE tenant_id=25 AND id=$1", [promoId])).rows[0].n) : 0;
  const leftC = cli ? Number((await db.query("SELECT COUNT(*) n FROM clients WHERE tenant_id=25 AND id=$1", [cli])).rows[0].n) : 0;
  console.log(`CLEANUP: promo residua=${leftP} client residuo=${leftC} -> ${leftP + leftC === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && leftP + leftC === 0 ? 0 : 1);
}
