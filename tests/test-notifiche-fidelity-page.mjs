// Pagina dedicata "Tessere in scadenza" (deviazione approvata 2026-07-20):
// la sezione Fidelity esce dal hub notifiche — API action=fidelity_groups
// (gate fidelity.membership, anteprima 25), pagina notifications_fidelity nel
// gruppo Fidelizzazione, hub con SOLO riga compatta+contatore (a zero
// sparisce). Fixture ZZ (cliente+tessera scaduta) su tenant 25, cleanup per id.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const { chromium } = require("playwright");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
function makeCookie(perms) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const fullCookie = makeCookie(["notifications.view", "appointments.manage", "fidelity.membership"]);
const noFidelityCookie = makeCookie(["notifications.view"]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let cid = 0, cardId = 0, browser = null;

async function apiGet(params, cookie = fullCookie) {
  const res = await fetch(`${BASE}/api/manage/notifications?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}

try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ CardFid ${RUN}`, `zz.cardfid.${RUN}@example.com`, LOC])).rows[0].id);
  cardId = Number((await q("INSERT INTO cards (tenant_id, code, client_id, issued_at, expires_at) VALUES ($1,$2,$3,'2025-01-01','2026-01-15') RETURNING id", [T, `ZF${RUN}`, cid])).rows[0].id);

  // F1: API fidelity_groups — gate + gruppo con la tessera ZZ (scaduta)
  const f1 = await apiGet("&action=fidelity_groups");
  const hasCard = (f1.j?.groups ?? []).some((g) => (g.previewRows ?? []).some((r) => r.cardCode === `ZF${RUN}`));
  check("F1 API fidelity_groups: ok + tessera ZZ nei gruppi", f1.status === 200 && f1.j?.ok === true && f1.j?.canSee === true && f1.j?.enabled === true && hasCard, `status=${f1.status} card=${hasCard}`);

  // F2: senza fidelity.membership -> canSee false e zero gruppi
  const f2 = await apiGet("&action=fidelity_groups", noFidelityCookie);
  check("F2 gate: senza fidelity.membership canSee=false e gruppi vuoti", f2.j?.canSee === false && (f2.j?.groups ?? []).length === 0, JSON.stringify({ canSee: f2.j?.canSee, n: (f2.j?.groups ?? []).length }));

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const [cn, cv] = fullCookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // F3: pagina dedicata renderizzata con la tessera ZZ + voce nel menu
  await page.goto(`${BASE}/${SLUG}/notifications_fidelity`, { waitUntil: "domcontentloaded" });
  await page.locator(`text=ZZ CardFid ${RUN}`).first().waitFor({ timeout: 45000 });
  const title = await page.locator("h1", { hasText: "Tessere Fidelity in scadenza / scadute" }).count();
  const navVoice = await page.locator("aside").locator("text=Tessere in scadenza").count();
  check("F3 pagina dedicata: titolo + tessera ZZ + voce nel menu Fidelizzazione", title === 1 && navVoice >= 1, `title=${title} nav=${navVoice}`);

  // F4: hub asciugato — riga compatta col contatore e link Vedi, NIENTE card integrali
  await page.goto(`${BASE}/${SLUG}/notifications`, { waitUntil: "domcontentloaded" });
  await page.locator("#fidelity_cards_notifications").waitFor({ timeout: 45000 });
  const compact = await page.locator("#fidelity_cards_notifications").locator("a", { hasText: "Vedi" }).count();
  const fullCards = await page.locator("text=Apri in Fidelity / Adesione").count();
  check("F4 hub: riga compatta con Vedi, card integrali assenti", compact === 1 && fullCards === 0, `vedi=${compact} card=${fullCards}`);

  // F5: il Vedi porta alla pagina dedicata
  await page.locator("#fidelity_cards_notifications").locator("a", { hasText: "Vedi" }).click();
  await page.waitForURL(/notifications_fidelity/, { timeout: 20000 });
  check("F5 Vedi -> pagina dedicata", /notifications_fidelity/.test(page.url()), page.url().slice(-30));

  // F6: senza tessere la riga del hub SPARISCE
  await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, cardId]);
  cardId = 0;
  await page.goto(`${BASE}/${SLUG}/notifications`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Appuntamenti in attesa").first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  const gone = await page.locator("#fidelity_cards_notifications").count();
  check("F6 hub a zero tessere: riga assente", gone === 0, `row=${gone}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (cardId) await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, cardId]);
    if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]);
    console.log("CLEANUP: ok (tessera e cliente ZZ per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await pool.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
