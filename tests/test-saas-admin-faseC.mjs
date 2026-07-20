// Pannello admin Fase C (2026-07-19): backup su R2 (put+presigned download),
// registro cron saas_cron_runs, stato cron nel pannello e in work queue.
// Fixture: admin temp (email minuscola), tenant finto zz-fasec*; oggetti R2
// e righe rimossi per chiave/id tracciati.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const DBURL = env("PRENODO_DATABASE_URL");
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.fasec${RUN}@example.test`;
const SLUG = `zz-fasec${RUN}`;
let adminId = 0, tid = 0, backupId = 0, cronWatermark = 0, fakeCronId = 0; const r2Keys = []; let browser = null;

const s3 = new S3Client({
  region: "auto",
  endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ FaseC", EMAIL, bcrypt.hashSync("FaseC!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "FaseC!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ FaseC',$2,1,'active') RETURNING id", [SLUG, `t_zzfasec${RUN}_`]);
  tid = Number(t.rows[0].id);
  cronWatermark = Number((await db.query("SELECT COALESCE(MAX(id),0) m FROM saas_cron_runs").catch(() => ({ rows: [{ m: 0 }] }))).rows?.[0]?.m ?? 0);

  // I1: backup_create -> path r2: + meta storage r2
  const bk = await fetch(`${BASE}/api/admin/operations`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ action: "backup_create", slug: SLUG, reason: "ZZ faseC" }) });
  const bkBody = await bk.json().catch(() => ({}));
  const bkPath = String(bkBody?.backup?.path ?? "");
  backupId = Number(bkBody?.backup?.id ?? 0);
  if (bkPath.startsWith("r2:")) r2Keys.push(bkPath.slice(3));
  const bkRow = backupId ? (await db.query("SELECT meta_json, backup_size FROM saas_tenant_backups WHERE id=$1", [backupId])).rows[0] : null;
  const meta = bkRow ? JSON.parse(bkRow.meta_json ?? "{}") : {};
  check("I1 backup su R2: path r2:saas-backups/... + meta storage=r2", bk.status === 200 && bkPath.startsWith(`r2:saas-backups/${SLUG}/`) && meta.storage === "r2" && Number(bkRow?.backup_size) > 1000, `path=${bkPath.slice(0, 60)} storage=${meta.storage}`);

  // I2: lista backup include la riga
  const list = await (await fetch(`${BASE}/api/admin/operations?section=backups&slug=${SLUG}`, { headers: { cookie } })).json();
  check("I2 lista backup con la riga R2", (list.backups ?? []).some((b) => Number(b.id) === backupId), `n=${list.backups?.length}`);

  // I3: download -> 302 presigned -> contenuto JSON corretto
  const dl = await fetch(`${BASE}/api/admin/operations?section=backup_download&slug=${SLUG}&id=${backupId}`, { headers: { cookie }, redirect: "manual" });
  const presigned = dl.headers.get("location") ?? "";
  let payloadOk = false, contentInfo = "";
  if (presigned) {
    const content = await fetch(presigned);
    const payload = await content.json().catch(() => null);
    payloadOk = content.status === 200 && payload?.tenant?.slug === SLUG && Object.keys(payload?.tables ?? {}).length > 50;
    contentInfo = `tables=${Object.keys(payload?.tables ?? {}).length}`;
  }
  check("I3 download -> redirect presigned -> JSON del tenant", dl.status === 302 && /X-Amz-Signature|Signature=/.test(presigned) && payloadOk, `status=${dl.status} ${contentInfo}`);

  // I4: cron admin-health -> riga nel registro con esito ok e durata
  const cron = await fetch(`${BASE}/api/cron/admin-health`);
  const runRow = (await db.query("SELECT job,status,duration_ms,message FROM saas_cron_runs WHERE id > $1 AND job='admin-health' ORDER BY id DESC LIMIT 1", [cronWatermark])).rows[0];
  check("I4 registro cron: run admin-health registrata ok", cron.status === 200 && runRow?.status === "ok" && Number(runRow?.duration_ms) > 0 && String(runRow?.message ?? "").includes("checked"), JSON.stringify(runRow ?? null).slice(0, 120));

  // I5: section=controls espone cron.jobs con admin-health
  const controls = await (await fetch(`${BASE}/api/admin/operations?section=controls&check_endpoint=0`, { headers: { cookie } })).json();
  const jobRow = (controls.cron?.jobs ?? []).find((j) => j.job === "admin-health");
  check("I5 controls: cron.jobs con ultima esecuzione per job", controls.ok === true && !!jobRow && jobRow.status === "ok", `jobs=${(controls.cron?.jobs ?? []).map((j) => j.job).join(",")}`);

  // I6: run FALLITA forgiata -> work queue segnala 'Cron in errore'
  const fc = await db.query("INSERT INTO saas_cron_runs(job,status,started_at,duration_ms,message) VALUES('zz-cron-fasec','error',$1,10,'ZZ errore finto') RETURNING id", [new Date().toISOString().slice(0, 19).replace("T", " ")]);
  fakeCronId = Number(fc.rows[0].id);
  const ov = await (await fetch(`${BASE}/api/admin/tenants`, { headers: { cookie } })).json();
  const cronItem = (ov.workQueue ?? []).find((w) => w.key === "cron_error:zz-cron-fasec");
  // Menu consolidato: la vista e' 'operations' con sezione 'controls'.
  check("I6 work queue: 'Cron in errore' severita' error -> Operazioni/Controlli", !!cronItem && cronItem.severity === "error" && cronItem.view === "operations" && cronItem.section === "controls", JSON.stringify(cronItem ?? null).slice(0, 110));

  // I7: UI Controlli renderizza la tabella cron
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=controls`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Cron: ultima esecuzione per job").waitFor({ timeout: 30000 });
  await page.locator("table strong", { hasText: "admin-health" }).first().waitFor({ timeout: 15000 });
  const errBadge = await page.locator("tr", { hasText: "zz-cron-fasec" }).locator("text=Errore").count();
  check("I7 UI Controlli: tabella cron con job ok + job in errore", errBadge >= 1, `errBadge=${errBadge}`);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    for (const key of r2Keys) await s3.send(new DeleteObjectCommand({ Bucket: env("R2_BUCKET_PRIVATE"), Key: key })).catch(() => {});
    if (backupId) await db.query("DELETE FROM saas_tenant_backups WHERE id=$1", [backupId]).catch(() => {});
    if (fakeCronId) await db.query("DELETE FROM saas_cron_runs WHERE id=$1", [fakeCronId]).catch(() => {});
    if (cronWatermark >= 0) await db.query("DELETE FROM saas_cron_runs WHERE id > $1 AND job='admin-health'", [cronWatermark]).catch(() => {});
    if (tid) {
      await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenant_health_checks WHERE tenant_id=$1", [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (R2 keys, righe cron/backup/tenant/admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
