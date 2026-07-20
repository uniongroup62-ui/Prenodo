// Feature restore + signups (2026-07-19): ripristino guidato del tenant
// eliminato (ciclo completo crea->backup->delete->restore su tenant
// USA-E-GETTA) e vista Registrazioni con guardie. Cleanup per id/chiave.
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
const EMAIL = `zz.rest${RUN}@example.test`;
const SLUG = `zz-rest${RUN}`;
let adminId = 0, tid = 0; const r2Keys = []; const signupIds = []; let browser = null;
const s3 = new S3Client({ region: "auto", endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") } });
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });
const KEEP = new Set(["saas_tenants", "saas_tenant_audit_logs", "saas_tenant_backups", "saas_sms_orders"]);

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Restore", EMAIL, bcrypt.hashSync("Rest!1234", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Rest!1234" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // Ciclo: crea tenant vero -> backup -> delete
  const cRes = await post(cookie, "/api/admin/tenants", { action: "create", slug: SLUG, tenant_name: "ZZ Restore", admin_name: "ZZ Admin", admin_email: `zz.restadmin${RUN}@example.test`, admin_pass: "Rest!Tenant1" });
  const cBody = await cRes.json().catch(() => ({}));
  tid = Number(cBody?.tenant?.id ?? 0);
  const seededBefore = (await db.query(`SELECT (SELECT COUNT(*) FROM users WHERE tenant_id=$1) u, (SELECT COUNT(*) FROM staff WHERE tenant_id=$1) s, (SELECT COUNT(*) FROM locations WHERE tenant_id=$1) l, (SELECT COUNT(*) FROM businesses WHERE tenant_id=$1) b`, [tid])).rows[0];
  const delRes = await post(cookie, "/api/admin/tenants", { action: "delete", slug: SLUG, confirm_slug: SLUG });
  const delBody = await delRes.json().catch(() => ({}));
  if (delBody?.preBackup) r2Keys.push(`saas-backups/${SLUG}/${delBody.preBackup}`);
  const gone = (await db.query("SELECT id FROM saas_tenants WHERE id=$1", [tid])).rows.length === 0;

  // N1: il tenant eliminato compare nei candidati al ripristino
  const cand = await (await fetch(`${BASE}/api/admin/operations?section=restore_candidates`, { headers: { cookie } })).json();
  const candidate = (cand.candidates ?? []).find((b) => b.tenant_slug === SLUG);
  check("N1 candidati restore: backup del tenant eliminato in lista", tid > 0 && gone && !!candidate, `tid=${tid} gone=${gone} cand=${candidate?.id}`);

  // N2: conferma sbagliata -> respinto
  const bad = await post(cookie, "/api/admin/operations", { action: "backup_restore", backup_id: String(candidate.id), confirm_slug: "sbagliato" });
  check("N2 restore con conferma errata -> respinto", bad.status !== 200, `status=${bad.status}`);

  // N3: RESTORE -> tenant ricreato con id ORIGINALE, attivo, dati seedati tornati
  const res = await post(cookie, "/api/admin/operations", { action: "backup_restore", backup_id: String(candidate.id), confirm_slug: SLUG });
  const resBody = await res.json().catch(() => ({}));
  const back = (await db.query("SELECT id, status, is_active, deleted_at FROM saas_tenants WHERE slug=$1", [SLUG])).rows[0];
  const seededAfter = (await db.query(`SELECT (SELECT COUNT(*) FROM users WHERE tenant_id=$1) u, (SELECT COUNT(*) FROM staff WHERE tenant_id=$1) s, (SELECT COUNT(*) FROM locations WHERE tenant_id=$1) l, (SELECT COUNT(*) FROM businesses WHERE tenant_id=$1) b`, [tid])).rows[0];
  const dataBack = ["u", "s", "l", "b"].every((k) => String(seededAfter[k]) === String(seededBefore[k]));
  check("N3 restore -> stesso id, attivo, righe users/staff/locations/businesses tornate", res.status === 200 && Number(back?.id) === tid && back?.status === "active" && Number(back?.is_active) === 1 && !back?.deleted_at && dataBack, `rows=${resBody?.result?.rows_restored} before=${JSON.stringify(seededBefore)} after=${JSON.stringify(seededAfter)}`);

  // N4: restore su slug ESISTENTE -> rifiutato (mai sovrascrivere)
  const again = await post(cookie, "/api/admin/operations", { action: "backup_restore", backup_id: String(candidate.id), confirm_slug: SLUG });
  const againBody = await again.json().catch(() => ({}));
  check("N4 restore su tenant vivo -> rifiutato", again.status !== 200 && /esiste gia/i.test(String(againBody?.error ?? "")), `err=${againBody?.error}`);

  // N5: signups censurata (mai hash) + riga finta ZZ presente
  const sf = await db.query("INSERT INTO saas_professional_signups(business_name,slug,owner_name,owner_email,password_hash,status) VALUES($1,$2,'ZZ Owner',$3,'x','failed') RETURNING id", [`ZZ Signup ${RUN}`, `zz-signup${RUN}`, `zz.signup${RUN}@example.test`]);
  signupIds.push(Number(sf.rows[0].id));
  const sg = await (await fetch(`${BASE}/api/admin/operations?section=signups`, { headers: { cookie } })).json();
  const sRow = (sg.signups ?? []).find((r) => r.id === signupIds[0]);
  const noHash = (sg.signups ?? []).every((r) => !("password_hash" in r) && !("verification_hash" in r));
  check("N5 signups: lista censurata (niente hash) con la richiesta ZZ", !!sRow && sRow.status === "failed" && noHash, `row=${!!sRow} noHash=${noHash}`);

  // N6: guardia delete — richiesta col tenant VIVO non eliminabile
  const sg2 = await db.query("INSERT INTO saas_professional_signups(business_name,slug,owner_name,owner_email,password_hash,status,tenant_id) VALUES('ZZ Linked',$1,'ZZ','zz.linked@example.test','x','active',$2) RETURNING id", [SLUG, tid]);
  signupIds.push(Number(sg2.rows[0].id));
  const delLinked = await post(cookie, "/api/admin/operations", { action: "signup_delete", id: String(sg2.rows[0].id) });
  const delLinkedBody = await delLinked.json().catch(() => ({}));
  check("N6 signup di tenant vivo -> delete rifiutata", delLinked.status !== 200 && /esiste ancora/i.test(String(delLinkedBody?.error ?? "")), `err=${delLinkedBody?.error}`);

  // N7: delete della richiesta morta -> ok
  const delDead = await post(cookie, "/api/admin/operations", { action: "signup_delete", id: String(signupIds[0]) });
  const deadGone = (await db.query("SELECT id FROM saas_professional_signups WHERE id=$1", [signupIds[0]])).rows.length === 0;
  check("N7 signup morta -> eliminata", delDead.status === 200 && deadGone, `status=${delDead.status}`);

  // N8: UI — vista Registrazioni + sezione Ripristino renderizzate
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=signups`, { waitUntil: "domcontentloaded" });
  // Prima visita in dev = compile lag: attendere la RIGA, non il titolo (il
  // testo dell'empty-state matcha 'richieste di registrazione' case-insensitive).
  await page.locator("text=ZZ Linked").first().waitFor({ timeout: 45000 });
  const linkedRow = await page.locator("text=ZZ Linked").count();
  const openBtn = await page.locator("tr", { hasText: "ZZ Linked" }).locator("button", { hasText: "Apri tenant" }).count();
  await page.goto(`${BASE}/admin?page=maintenance`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Ripristino da backup").waitFor({ timeout: 30000 });
  check("N8 UI: Registrazioni con 'Apri tenant' + sezione Ripristino", linkedRow >= 1 && openBtn === 1, `linked=${linkedRow} open=${openBtn}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    for (const key of r2Keys) await s3.send(new DeleteObjectCommand({ Bucket: env("R2_BUCKET_PRIVATE"), Key: key })).catch(() => {});
    for (const id of signupIds) await db.query("DELETE FROM saas_professional_signups WHERE id=$1", [id]).catch(() => {});
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
