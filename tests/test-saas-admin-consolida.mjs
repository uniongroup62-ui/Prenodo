// Consolidamento pannello (2026-07-19): menu 11->8 con sottotab e deep-link
// legacy, piano come select (create/update), retention backup 10+1/mese,
// audit con filtri/paginazione/export. Fixture zz-cons* rimosse per id.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.cons${RUN}@example.test`;
const SLUG = `zz-cons${RUN}`;
let adminId = 0, tid = 0, planId = 0; const r2Keys = []; let browser = null;
const s3 = new S3Client({ region: "auto", endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") } });
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Cons", EMAIL, bcrypt.hashSync("Cons!1234", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Cons!1234" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // P1: piano di test + overview espone plans per le select
  const ps = await (await post(cookie, "/api/admin/operations", { action: "plan_save", name: `ZZ Cons ${RUN}`, price_month: "9.90", max_locations: "", max_staff: "", sms_included_month: "0" })).json();
  planId = Number(ps?.id ?? 0);
  const ov = await (await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } })).json();
  check("P1 overview.plans per le select (piano ZZ presente)", planId > 0 && (ov.plans ?? []).some((p) => p.id === planId), `plans=${ov.plans?.length}`);

  // P2: create con plan_id -> tenant nasce col piano assegnato (entita', non testo)
  const cRes = await post(cookie, "/api/admin/tenants", { action: "create", slug: SLUG, tenant_name: "ZZ Cons", admin_name: "ZZ", admin_email: `zz.consadmin${RUN}@example.test`, admin_pass: "Cons!Ten1", plan_id: String(planId) });
  const cBody = await cRes.json().catch(() => ({}));
  tid = Number(cBody?.tenant?.id ?? 0);
  const trow = (await db.query("SELECT plan, plan_id FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  check("P2 create con plan_id -> plan_id + etichetta dal piano", cRes.status === 200 && Number(trow?.plan_id) === planId && String(trow?.plan) === `ZZ Cons ${RUN}`, JSON.stringify(trow));

  // P3: update con plan_id=0 -> piano staccato
  await post(cookie, "/api/admin/tenants", { action: "update", slug: SLUG, name: "ZZ Cons", plan_id: "0" });
  const trow2 = (await db.query("SELECT plan, plan_id FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  check("P3 update con plan_id=0 -> unassign", trow2?.plan_id === null, JSON.stringify(trow2));

  // P4: RETENTION — 14 righe backup vecchie seminate (12 nel mese A, 2 nel mese B)
  //     + backup reale -> restano le ultime 10 + 1 per mese vecchio
  // Il prune taglia per ID desc: i due backup di APRILE devono stare sugli id
  // PIU' BASSI per finire fra i "vecchi" e attivare il keep per-mese.
  for (let i = 0; i < 14; i += 1) {
    const month = i < 2 ? "2026-04" : "2026-05";
    await db.query(
      "INSERT INTO saas_tenant_backups(tenant_id,tenant_slug,backup_path,backup_size,status,created_at) VALUES($1,$2,$3,100,'completed',$4)",
      [tid, SLUG, `storage/saas_backups/${SLUG}/zz-old-${i}.json`, `${month}-${String(2 + i).padStart(2, "0")} 10:00:00`],
    );
  }
  const bk = await (await post(cookie, "/api/admin/operations", { action: "backup_create", slug: SLUG, reason: "ZZ retention" })).json();
  if (String(bk?.backup?.path ?? "").startsWith("r2:")) r2Keys.push(String(bk.backup.path).slice(3));
  await new Promise((resolve) => setTimeout(resolve, 2500)); // prune fire-and-forget
  const left = (await db.query("SELECT COUNT(*) c FROM saas_tenant_backups WHERE tenant_id=$1", [tid])).rows[0];
  const pruneAudit = (await db.query("SELECT COUNT(*) c FROM saas_tenant_audit_logs WHERE tenant_id=$1 AND action='tenant.backup_prune'", [tid])).rows[0];
  // 15 totali -> ultime 10 + mese 2026-05 (1) + mese 2026-04 (1) = 12
  check("P4 retention: 15 backup -> 12 (ultimi 10 + 1 per mese vecchio) + audit prune", Number(left.c) === 12 && Number(pruneAudit.c) === 1, `left=${left.c} audit=${pruneAudit.c}`);

  // P5: audit_search con filtri + paginazione
  const as = await (await fetch(`${BASE}/api/admin/operations?section=audit_search&audit_action=tenant.backup_prune&tenant=${SLUG}`, { headers: { cookie } })).json();
  check("P5 audit_search: filtro azione+tenant -> 1 risultato con totale", as.ok === true && as.total === 1 && as.rows?.[0]?.action === "tenant.backup_prune" && as.perPage === 30, `total=${as.total}`);

  // P6: export_audit CSV coi filtri + audit dell'export
  const csv = await fetch(`${BASE}/api/admin/operations?section=export_audit&tenant=${SLUG}`, { headers: { cookie } });
  const csvBody = await csv.text();
  check("P6 export_audit -> CSV filtrato", csv.status === 200 && (csv.headers.get("content-type") || "").includes("text/csv") && csvBody.includes('"id";"data";"azione"') && csvBody.includes("tenant.backup_prune"), `status=${csv.status}`);

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();

  // P7: menu a 8 voci con Fatturazione e Operazioni
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("aside nav button", { hasText: "Fatturazione" }).waitFor({ timeout: 30000 });
  const navCount = await page.locator("aside nav button").count();
  const opsNav = await page.locator("aside nav button", { hasText: "Operazioni" }).count();
  check("P7 menu consolidato: 8 voci con Fatturazione + Operazioni", navCount === 8 && opsNav === 1, `nav=${navCount}`);

  // P8: legacy ?page=sms_plans -> Fatturazione con sottotab Pacchetti SMS
  await page.goto(`${BASE}/admin?page=sms_plans`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Impostazioni prezzo").waitFor({ timeout: 30000 });
  const h1 = (await page.locator("header h1").textContent()) || "";
  const smsTabActive = await page.locator('button[class*="bg-[#182238]"]', { hasText: "Pacchetti SMS" }).count();
  check("P8 legacy sms_plans -> Fatturazione/Pacchetti SMS attiva", h1.trim() === "Fatturazione" && smsTabActive === 1, `h1=${h1.trim()} tab=${smsTabActive}`);

  // P9: sottotab Abbonamenti -> vista piani, URL senza sec (default)
  await page.locator("button", { hasText: "Abbonamenti & Ricavi" }).click();
  await page.locator("text=Piani e MRR").waitFor({ timeout: 20000 });
  check("P9 switch sottotab -> Abbonamenti con URL pulito", /page=billing/.test(page.url()) && !/sec=/.test(page.url()), page.url().slice(-30));

  // P10: legacy ?page=maintenance -> Operazioni/Manutenzione col Ripristino
  await page.goto(`${BASE}/admin?page=maintenance`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Ripristino da backup").waitFor({ timeout: 30000 });
  const h1ops = (await page.locator("header h1").textContent()) || "";
  check("P10 legacy maintenance -> Operazioni/Manutenzione", h1ops.trim() === "Operazioni", `h1=${h1ops.trim()}`);

  // P11: vista Audit con filtri -> filtro azione via UI
  await page.goto(`${BASE}/admin?page=audit`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Registro attività").waitFor({ timeout: 30000 });
  await page.fill("input[placeholder*='tenant.suspend']", "tenant.backup_prune");
  await page.locator("button", { hasText: "Filtra" }).click();
  await page.waitForTimeout(2500);
  // 20/07: l'azione e' un BOTTONE cliccabile (filtro a un click), non piu' <code>
  const pruneRow = await page.locator("button", { hasText: "tenant.backup_prune" }).count();
  const exportBtn = await page.locator("a", { hasText: "Esporta CSV" }).count();
  check("P11 vista Audit: filtro azione + bottone export", pruneRow >= 1 && exportBtn === 1, `rows=${pruneRow}`);

  // P12: select Piano nella tab Dati del dettaglio (opzione ZZ presente)
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=settings`, { waitUntil: "domcontentloaded" });
  // Attendere l'OPTION del piano (la overview con plans arriva in fetch separata).
  await page.locator("select[name='plan_id'] option", { hasText: `ZZ Cons ${RUN}` }).first().waitFor({ state: "attached", timeout: 30000 });
  const options = await page.locator("select[name='plan_id'] option").allTextContents();
  check("P12 tab Dati: select Piano con 'Nessun piano' + piano ZZ", options.some((o) => o.includes("Nessun piano")) && options.some((o) => o.includes(`ZZ Cons ${RUN}`)), options.join("|").slice(0, 80));
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    for (const key of r2Keys) await s3.send(new DeleteObjectCommand({ Bucket: env("R2_BUCKET_PRIVATE"), Key: key })).catch(() => {});
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (tid) {
      const tabs = await db.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'`);
      for (const { table_name } of tabs.rows) if (table_name !== "saas_tenants") await db.query(`DELETE FROM "${table_name}" WHERE tenant_id=$1`, [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    const residui = Number((await db.query("SELECT COUNT(*) c FROM saas_tenants WHERE slug=$1", [SLUG])).rows[0].c);
    console.log(`CLEANUP: tenant residuo=${residui} -> ${residui === 0 ? "CLEAN" : "ATTENZIONE"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
