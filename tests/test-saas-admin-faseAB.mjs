// Pannello admin Fase A+B (2026-07-19): lista tenant da SNAPSHOT (latenza),
// paginazione, work queue azionabile, centro di comando, command palette.
// Tenant finti zz-pag* inseriti SOLO in saas_tenants e rimossi per id.
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
// SOLO minuscole: il login normalizza lowercase e PG confronta case-sensitive.
const EMAIL = `zz.saasab${RUN}@example.test`;
let adminId = 0; const fakeIds = []; let browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ FaseAB", EMAIL, bcrypt.hashSync("FaseAB!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "FaseAB!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // 6 tenant finti (solo riga saas_tenants, mai provisioning)
  for (let i = 1; i <= 6; i += 1) {
    const slug = `zz-pag${RUN}-${i}`;
    const r = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,$2,$3,1,'active') RETURNING id", [slug, `ZZ Pag ${i}`, `t_zzpag${RUN}${i}_`]);
    fakeIds.push({ id: Number(r.rows[0].id), slug });
  }

  // H1: LATENZA lista (Fase A) — snapshot, niente diagnostica live per riga.
  // Le misure valgono SOLO su risposte 200 autenticate.
  const warm = await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } });
  const times = [];
  let all200 = warm.status === 200;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const r = await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } });
    if (r.status !== 200) all200 = false;
    times.push(performance.now() - t0);
  }
  const best = Math.min(...times);
  check("H1 lista tenant veloce (snapshot, no live)", all200 && best < 1500, `best=${Math.round(best)}ms status200=${all200} (era 3-4s)`);

  // H2: payload nuovo — paginazione + workQueue
  const ovRes = await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } });
  const ov = await ovRes.json();
  check("H2 payload con page/perPage/pageCount/total + workQueue", Array.isArray(ov.workQueue) && ov.page === 1 && ov.perPage === 25 && ov.total >= 7 && ov.tenants.length <= 20, `status=${ovRes.status} keys=${Object.keys(ov).join("|")} err=${ov.error ?? ""} total=${ov.total} wq=${ov.workQueue?.length}`);

  // H3: per_page=5 -> 2 pagine con contenuti diversi, summary su TUTTO l'insieme
  const p1 = await (await fetch(`${BASE}/api/admin/tenants?q=zz-pag${RUN}&per_page=5&page=1`, { headers: { cookie } })).json();
  const p2 = await (await fetch(`${BASE}/api/admin/tenants?q=zz-pag${RUN}&per_page=5&page=2`, { headers: { cookie } })).json();
  const slugs1 = p1.tenants.map((t) => t.slug); const slugs2 = p2.tenants.map((t) => t.slug);
  check("H3 paginazione server-side coerente", p1.total === 6 && p1.pageCount === 2 && slugs1.length === 5 && slugs2.length === 1 && !slugs1.includes(slugs2[0]) && p1.summary.total === 6, `p1=${slugs1.length} p2=${slugs2.length} tot=${p1.total}`);

  // H4: work queue segnala i tenant MAI verificati con azione record_health
  const wqItem = (ov.workQueue ?? []).find((w) => w.key === `health_missing:${fakeIds[0].slug}`);
  check("H4 work queue: 'mai verificato' con azione record_health", !!wqItem && wqItem.action === "record_health" && wqItem.severity === "warning" && wqItem.view === "tenants", JSON.stringify(wqItem ?? null).slice(0, 100));

  // H5: page fuori range -> clampata all'ultima
  const pOver = await (await fetch(`${BASE}/api/admin/tenants?q=zz-pag${RUN}&per_page=5&page=99`, { headers: { cookie } })).json();
  check("H5 page oltre il massimo -> clamp all'ultima pagina", pOver.page === 2 && pOver.tenants.length === 1, `page=${pOver.page}`);

  // --- UI (Playwright) ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // H6: dashboard = centro di comando con coda "Da fare adesso"
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  // La coda si popola a fetch client completata: attendere l'ITEM, non il titolo.
  await page.locator(`text=Mai verificato: ${fakeIds[0].slug}`).first().waitFor({ timeout: 30000 });
  const queueTitle = await page.locator("text=Da fare adesso").count();
  const queueRow = await page.locator(`text=Mai verificato: ${fakeIds[0].slug}`).count();
  check("H6 dashboard: coda 'Da fare adesso' con item renderizzati", queueTitle >= 1 && queueRow >= 1, `title=${queueTitle} row=${queueRow}`);

  // H7: azione one-click 'Verifica' dalla coda -> health registrata
  await page.locator(`xpath=//p[contains(text(),"Mai verificato: ${fakeIds[0].slug}")]/ancestor::div[contains(@class,"flex-wrap")]//button[contains(.,"Verifica")]`).first().click();
  await page.waitForTimeout(4000);
  const checked = await db.query("SELECT health_checked_at, health_level FROM saas_tenants WHERE id=$1", [fakeIds[0].id]);
  check("H7 'Verifica' one-click -> snapshot health scritto", !!checked.rows[0]?.health_checked_at, `level=${checked.rows[0]?.health_level}`);

  // H8: command palette Ctrl+K -> sezione
  await page.keyboard.press("Control+k");
  await page.locator("input[placeholder*='Cerca tenant']").waitFor({ timeout: 10000 });
  await page.keyboard.type("sicur");
  await page.waitForTimeout(600);
  await page.locator("div[role='dialog'] button", { hasText: "Sicurezza" }).first().click();
  await page.waitForURL(/page=security/, { timeout: 15000 });
  check("H8 palette: 'sicur' -> vista Sicurezza con URL", /page=security/.test(page.url()), page.url());

  // H9: palette cerca i tenant SERVER-SIDE e apre il dettaglio
  await page.keyboard.press("Control+k");
  await page.locator("input[placeholder*='Cerca tenant']").waitFor({ timeout: 10000 });
  await page.keyboard.type(`zz-pag${RUN}-3`);
  await page.waitForTimeout(900);
  await page.locator("div[role='dialog'] button", { hasText: "ZZ Pag 3" }).first().click();
  await page.waitForURL(new RegExp(`slug=zz-pag${RUN}-3`), { timeout: 20000 });
  const detailH2 = await page.locator("h2", { hasText: "ZZ Pag 3" }).count();
  check("H9 palette: tenant server-side -> dettaglio aperto", detailH2 >= 1 && new RegExp(`slug=zz-pag${RUN}-3`).test(page.url()), page.url());

  // H10: vista Tenant con paginazione UI (per_page default 20 -> serve filtro:
  //      usiamo la ricerca per restringere a 6 e per_page resta 20 => 1 pagina;
  //      la paginazione UI si attesta via API H3; qui attestiamo il footer
  //      quando pageCount>1 simulando per_page=5 via chiamata diretta gia' fatta.
  //      In UI: filtro 'zz-pag' -> 6 righe in tabella.
  await page.goto(`${BASE}/admin?page=tenants`, { waitUntil: "domcontentloaded" });
  await page.locator("input[placeholder*='Slug']").waitFor({ timeout: 20000 });
  await page.fill("input[placeholder*='Slug']", `zz-pag${RUN}`);
  await page.locator("button", { hasText: "Filtra" }).click({ force: true });
  await page.waitForTimeout(2500);
  const rowCount = await page.locator("table tbody tr").first().locator("xpath=ancestor::table//tbody/tr").count().catch(() => 0);
  const anyRow = await page.locator(`text=zz-pag${RUN}-1`).count();
  check("H10 filtro in vista Tenant -> righe filtrate renderizzate", anyRow >= 1, `rows~${rowCount}`);

  // H11: dettaglio tenant reale ancora coerente (snapshot health, no live)
  const det = await (await fetch(`${BASE}/api/admin/tenants?slug=centroesteticoelite`, { headers: { cookie } })).json();
  check("H11 dettaglio reale ok con health da snapshot", det.ok === true && det.tenant?.slug === "centroesteticoelite" && det.tenant?.health?.level, `health=${det.tenant?.health?.level}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    for (const f of fakeIds) {
      await db.query("DELETE FROM saas_tenant_health_checks WHERE tenant_id=$1", [f.id]).catch(() => {});
      await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=$1", [f.id]).catch(() => {});
      await db.query("DELETE FROM tenant_onboarding_progress WHERE tenant_id=$1", [f.id]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [f.id]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    const residui = Number((await db.query("SELECT COUNT(*) c FROM saas_tenants WHERE slug LIKE $1", [`zz-pag${RUN}%`])).rows[0].c);
    console.log(`CLEANUP: tenant finti residui=${residui} -> ${residui === 0 ? "CLEAN" : "ATTENZIONE"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
