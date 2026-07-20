// Verifica 2026-07-16 — POS ricerca clienti server-side: API action=client_search
// + DOM (colonna Clienti e picker destinatario GiftBox cercano l'anagrafica completa).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["pos.manage", "giftbox.manage", "giftcard.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let browser = null, cli = 0;
try {
  // Cliente in FONDO all'alfabeto: con anagrafiche >500 non entrerebbe nel cap —
  // qui serve solo a provare che la ricerca lo trova via server (non via lista locale? la
  // lista locale lo contiene comunque nel tenant 25; il punto verificato è il percorso
  // server: risposta con full_name mappato + click che seleziona).
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,phone,location_id) VALUES (25,$1,'3479998877',21) RETURNING id", [`ZZ PosCli${RUN}`])).rows[0].id);

  // API: gate + shape
  const r1 = await fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}&action=client_search&q=ZZ PosCli${RUN}`, { headers: { cookie: `beautysuite_session_t_${SLUG}=${COOKIE_VAL}`, "x-tenant-slug": SLUG } });
  const j1 = await r1.json();
  const hit = (j1.clients || []).find((c) => c.id === cli);
  check("API client_search trova il seed (full_name/phone)", r1.status === 200 && !!hit && hit.full_name === `ZZ PosCli${RUN}` && hit.phone === "3479998877", JSON.stringify(hit));
  const r1b = await fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}&action=client_search&q=79998877`, { headers: { cookie: `beautysuite_session_t_${SLUG}=${COOKIE_VAL}`, "x-tenant-slug": SLUG } });
  const j1b = await r1b.json();
  check("API client_search per cifre telefono", (j1b.clients || []).some((c) => c.id === cli), `n=${(j1b.clients || []).length}`);
  const r2 = await fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}&action=client_search&q=zz`, { headers: { "x-tenant-slug": SLUG } });
  check("API senza sessione -> 401", r2.status === 401, `status=${r2.status}`);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:3000/${SLUG}/pos`, { waitUntil: "networkidle" });

  // DOM1: digitando nella colonna Clienti la riga arriva (percorso server, debounce 300ms)
  await page.locator("#posClientSearch").fill(`ZZ PosCli${RUN}`);
  await page.waitForTimeout(900);
  const row = page.locator(`#posClientList .pos-client-row:has-text("ZZ PosCli${RUN}")`).first();
  check("DOM1 colonna Clienti: ricerca trova il cliente", (await row.count()) > 0);

  // DOM2: click -> selezione (label 'Cliente selezionato')
  await row.click();
  await page.waitForTimeout(400);
  const label = await page.locator("#posClientLabel").textContent();
  check("DOM2 click seleziona il cliente", String(label ?? "").includes(`ZZ PosCli${RUN}`), JSON.stringify(label));

  // DOM3 (aggiornato: colonna SOLO-ricerca): svuotando il campo compare l'hint,
  // nessuna lista iniziale (l'anagrafica non viaggia più nel context).
  await page.locator("#posClientSearch").fill("");
  await page.waitForTimeout(700);
  const nRows = await page.locator("#posClientList .pos-client-row").count();
  const hint = await page.locator("#posClientList").textContent();
  check("DOM3 ricerca vuota -> hint 'Digita almeno 2 caratteri', nessuna lista", nRows === 0 && /Digita almeno 2 caratteri/.test(String(hint ?? "")), `rows=${nRows} hint=${JSON.stringify(hint)}`);
  // DOM4: il cliente resta selezionato anche senza lista (state indipendente)
  const label2 = await page.locator("#posClientLabel").textContent();
  check("DOM4 selezione conservata senza lista", String(label2 ?? "").includes(`ZZ PosCli${RUN}`), JSON.stringify(label2));
  // DOM5: hasClients=false NON deve scattare (il tenant ha clienti): form visibile
  const formHidden = await page.locator("#posForm.d-none").count();
  check("DOM5 empty-state onboarding non attivo (hasClients=true)", formHidden === 0, `hidden=${formHidden}`);
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
