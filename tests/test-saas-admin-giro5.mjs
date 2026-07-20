// Giro verifica completo SaaS Admin (2026-07-19): ruoli, ciclo vita tenant su
// tenant USA-E-GETTA zz-giro5*, guardie, wallet SMS, backup, delete completa
// (sweep dinamico), token supporto (frame Roma), rate-limit. Cleanup per ID.
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const ENVSRC = readFileSync(`${ROOT}/.env.local`, "utf8");
const env = (k) => (ENVSRC.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const DBURL = env("PRENODO_DATABASE_URL");
const s3 = new S3Client({
  region: "auto",
  endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const SLUG = `zz-giro5${RUN}`;
const OWNER = `zz.saas5o${RUN}@example.test`;
const VIEWER = `zz.saas5v${RUN}@example.test`;
const RLMAIL = `zz.rl${RUN}@example.test`;
const localSql = (offsetMs = 0) => { const d = new Date(Date.now() + offsetMs); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
let ownerId = 0, viewerId = 0, tid = 0; const tokenIds = []; const backupFiles = [];
const KEEP = new Set(["saas_tenants", "saas_tenant_audit_logs", "saas_tenant_backups", "saas_sms_orders"]);

const login = async (email, pass) => {
  const res = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: pass }) });
  const cookie = (res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  return { status: res.status, cookie };
};
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });
const get = (cookie, url) => fetch(`${BASE}${url}`, { headers: { cookie } });

try {
  const insO = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Giro5 Owner", OWNER, bcrypt.hashSync("Giro5Own!12", 10)]);
  ownerId = Number(insO.rows[0].id);
  const insV = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'viewer',1) RETURNING id", ["ZZ Giro5 Viewer", VIEWER, bcrypt.hashSync("Giro5View!12", 10)]);
  viewerId = Number(insV.rows[0].id);
  const own = await login(OWNER, "Giro5Own!12");
  const view = await login(VIEWER, "Giro5View!12");

  // G1: viewer puo' VEDERE i tenant
  const vList = await get(view.cookie, "/api/admin/tenants");
  check("G1 viewer -> GET tenants consentito", own.status === 200 && view.status === 200 && vList.status === 200, `own=${own.status} view=${vList.status}`);

  // G2: viewer NON puo' mutare tenant ne' vedere gli admin
  const vMut = await post(view.cookie, "/api/admin/tenants", { action: "suspend", slug: "centroesteticoelite", reason: "zz" });
  const vAdm = await get(view.cookie, "/api/admin/admins");
  check("G2 viewer -> POST tenant 403 + GET admins 403", vMut.status === 403 && vAdm.status === 403, `mut=${vMut.status} adm=${vAdm.status}`);

  // G3: slug riservato e slug duplicato respinti
  const rRes = await post(own.cookie, "/api/admin/tenants", { action: "create", slug: "admin", admin_email: "zz@example.test", admin_pass: "x" });
  const rDup = await post(own.cookie, "/api/admin/tenants", { action: "create", slug: "centroesteticoelite", admin_email: "zz@example.test", admin_pass: "x" });
  const rResB = await rRes.json().catch(() => ({})); const rDupB = await rDup.json().catch(() => ({}));
  check("G3 slug riservato + duplicato respinti", rRes.status !== 200 && rDup.status !== 200 && /esistente/i.test(String(rDupB.error ?? "")), `res=${JSON.stringify(rResB.error)} dup=${JSON.stringify(rDupB.error)}`);

  // G4: crea tenant usa-e-getta -> provisioning completo
  const cRes = await post(own.cookie, "/api/admin/tenants", { action: "create", slug: SLUG, tenant_name: "ZZ Giro5", admin_name: "ZZ Admin", admin_email: `zz.giro5admin${RUN}@example.test`, admin_pass: "Giro5Tenant!12", plan: "Test", notes: "tenant usa-e-getta giro5" });
  const cBody = await cRes.json().catch(() => ({}));
  tid = Number(cBody?.tenant?.id ?? 0);
  const seeded = tid ? (await db.query(`SELECT (SELECT COUNT(*) FROM users WHERE tenant_id=$1) u, (SELECT COUNT(*) FROM staff WHERE tenant_id=$1) s, (SELECT COUNT(*) FROM locations WHERE tenant_id=$1) l, (SELECT COUNT(*) FROM businesses WHERE tenant_id=$1) b`, [tid])).rows[0] : {};
  check("G4 create tenant -> attivo e seedato (users/staff/locations/businesses)", cRes.status === 200 && tid > 0 && String(cBody?.tenant?.status) === "active" && Number(seeded.u) >= 1 && Number(seeded.s) >= 1 && Number(seeded.l) >= 1 && Number(seeded.b) >= 1, `tid=${tid} seed=${JSON.stringify(seeded)}`);

  // G5: record_health -> riga in health_checks + livello sul tenant
  await post(own.cookie, "/api/admin/tenants", { action: "record_health", slug: SLUG });
  const hRow = await db.query("SELECT level FROM saas_tenant_health_checks WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1", [tid]);
  check("G5 record_health -> riga registrata", hRow.rows.length === 1 && ["ok", "warning", "error"].includes(String(hRow.rows[0].level)), `level=${hRow.rows[0]?.level}`);

  // G6: update + visibilita' 0/0 sincronizzata sulle locations
  await post(own.cookie, "/api/admin/tenants", { action: "update", slug: SLUG, name: "ZZ Giro5 Rinominato", plan: "Pro" });
  await post(own.cookie, "/api/admin/tenants", { action: "visibility", slug: SLUG, booking_public_allowed: "0", marketplace_public_allowed: "0" });
  const meta = (await db.query("SELECT name, plan, booking_public_allowed FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  const locVis = (await db.query("SELECT COALESCE(MAX(booking_enabled),0) be, COALESCE(MAX(marketplace_enabled),0) me FROM locations WHERE tenant_id=$1", [tid])).rows[0];
  check("G6 update+visibility -> meta aggiornata e locations spente", meta.name === "ZZ Giro5 Rinominato" && meta.plan === "Pro" && Number(meta.booking_public_allowed) === 0 && Number(locVis.be) === 0 && Number(locVis.me) === 0, JSON.stringify({ meta, locVis }));

  // G7: suspend con motivo -> riattivazione pulisce i campi
  await post(own.cookie, "/api/admin/tenants", { action: "suspend", slug: SLUG, reason: "ZZ motivo test" });
  const susp = (await db.query("SELECT status, is_active, suspended_reason FROM saas_tenants WHERE id=$1", [tid])).rows[0];

  // G9 (mentre e' sospeso): token supporto su tenant NON attivo -> consumo respinto
  const tokRes = await post(own.cookie, "/api/admin/tenants", { action: "support_create", slug: SLUG, reason: "ZZ giro5 guardia", minutes: "30" });
  const tokBody = await tokRes.json().catch(() => ({}));
  if (tokBody?.token?.id) tokenIds.push(Number(tokBody.token.id));
  const consume = await fetch(String(tokBody?.token?.link ?? "").replace(/^https?:\/\/[^/]+/, BASE), { redirect: "manual" });
  const consume2 = await fetch(`${BASE}${consume.headers.get("location") ?? "/x"}`, { redirect: "manual" });
  const guardLoc = String(consume2.headers.get("location") ?? "");
  check("G9 consumo su tenant sospeso -> respinto 'non attivo'", /non%20attivo/i.test(guardLoc), guardLoc.slice(0, 110));

  await post(own.cookie, "/api/admin/tenants", { action: "activate", slug: SLUG });
  const act = (await db.query("SELECT status, is_active, suspended_reason FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  check("G7 suspend->activate coerente", susp.status === "suspended" && Number(susp.is_active) === 0 && susp.suspended_reason === "ZZ motivo test" && act.status === "active" && Number(act.is_active) === 1 && !act.suspended_reason, JSON.stringify({ susp, act }));

  // G8: archive -> deleted; restore -> active
  await post(own.cookie, "/api/admin/tenants", { action: "archive", slug: SLUG, reason: "ZZ archivio" });
  const arch = (await db.query("SELECT status FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  await post(own.cookie, "/api/admin/tenants", { action: "restore", slug: SLUG });
  const rest = (await db.query("SELECT status, is_active FROM saas_tenants WHERE id=$1", [tid])).rows[0];
  check("G8 archive->restore coerente", arch.status === "deleted" && rest.status === "active" && Number(rest.is_active) === 1, JSON.stringify({ arch, rest }));

  // G16: token scaduto nel frame LOCALE non deve comparire fra gli attivi
  const insTokE = await db.query(`INSERT INTO saas_support_access_tokens(tenant_id,tenant_slug,token_hash,reason,created_by_email,expires_at) VALUES($1,$2,$3,'ZZ SCADUTO locale','zz@example.test',$4) RETURNING id`, [tid, SLUG, "e".repeat(63) + RUN.slice(-1), localSql(-60_000)]);
  const insTokV = await db.query(`INSERT INTO saas_support_access_tokens(tenant_id,tenant_slug,token_hash,reason,created_by_email,expires_at) VALUES($1,$2,$3,'ZZ VALIDO','zz@example.test',$4) RETURNING id`, [tid, SLUG, "f".repeat(63) + RUN.slice(-1), localSql(30 * 60_000)]);
  tokenIds.push(Number(insTokE.rows[0].id), Number(insTokV.rows[0].id));
  const detail = await (await get(own.cookie, `/api/admin/tenants?slug=${SLUG}`)).json();
  const activeReasons = (detail.activeTokens ?? []).map((t) => String(t.reason));
  check("G16 activeTokens: frame Roma coerente (scaduto ESCLUSO, valido incluso)", !activeReasons.includes("ZZ SCADUTO locale") && activeReasons.includes("ZZ VALIDO"), activeReasons.join(","));

  // G10: ricarica SMS manuale -> ordine paid + wallet accreditato
  const topup = await post(own.cookie, "/api/admin/operations", { action: "sms_manual_topup", tenant_slug: SLUG, credits: "10", amount_gross: "5", note: "ZZ giro5 topup" });
  const topupBody = await topup.json().catch(() => ({}));
  const order = topupBody.id ? (await db.query("SELECT status, credits FROM saas_sms_orders WHERE id=$1", [topupBody.id])).rows[0] : {};
  const plansData = await (await get(own.cookie, "/api/admin/operations?section=sms_plans")).json();
  const walletRow = (plansData.tenants ?? []).find((t) => t.slug === SLUG);
  check("G10 topup manuale -> ordine paid + wallet 10 crediti", topup.status === 200 && order?.status === "paid" && Number(order?.credits) === 10 && Number(walletRow?.wallet_balance) === 10, `status=${topup.status} err=${JSON.stringify(topupBody.error)} order=${JSON.stringify(order)} wallet=${walletRow?.wallet_balance}`);

  // G11: backup manuale -> su R2 (Fase C): contenuto letto via download presigned
  const bk = await post(own.cookie, "/api/admin/operations", { action: "backup_create", slug: SLUG, reason: "ZZ giro5 backup" });
  const bkBody = await bk.json().catch(() => ({}));
  const bkStored = String(bkBody?.backup?.path ?? "");
  if (bkStored.startsWith("r2:")) backupFiles.push(bkStored.slice(3));
  let bkOk = false, bkTables = 0;
  if (bkBody?.backup?.id) {
    const dl = await fetch(`${BASE}/api/admin/operations?section=backup_download&slug=${SLUG}&id=${bkBody.backup.id}`, { headers: { cookie: own.cookie }, redirect: "manual" });
    const presigned = dl.headers.get("location") ?? "";
    if (presigned) {
      const payload = await (await fetch(presigned)).json().catch(() => null);
      bkTables = Object.keys(payload?.tables ?? {}).length;
      bkOk = bkTables > 50 && (payload?.tables?.users?.rows ?? []).some((u) => String(u.email).includes(`zz.giro5admin${RUN}`));
    }
  }
  check("G11 backup su R2 -> JSON completo via presigned con admin incluso", bk.status === 200 && bkStored.startsWith("r2:") && bkOk, `tables=${bkTables} path=${bkStored.slice(0, 50)}`);

  // G12: delete con conferma sbagliata -> respinta, tenant intatto
  const delBad = await post(own.cookie, "/api/admin/tenants", { action: "delete", slug: SLUG, confirm_slug: "sbagliato" });
  const still = (await db.query("SELECT id FROM saas_tenants WHERE id=$1", [tid])).rows.length;
  check("G12 delete con conferma errata -> respinta", delBad.status !== 200 && still === 1, `status=${delBad.status}`);

  // G13: delete con conferma corretta -> ok + pre-backup automatico
  const delOk = await post(own.cookie, "/api/admin/tenants", { action: "delete", slug: SLUG, confirm_slug: SLUG });
  const delBody = await delOk.json().catch(() => ({}));
  if (delBody?.preBackup && !String(delBody.preBackup).startsWith("FALLITO")) backupFiles.push(`saas-backups/${SLUG}/${String(delBody.preBackup)}`);
  check("G13 delete -> ok con pre-backup automatico", delOk.status === 200 && delBody.ok === true && delBody.preBackup && !String(delBody.preBackup).startsWith("FALLITO"), `preBackup=${delBody.preBackup} rows=${delBody?.result?.shared_rows_deleted}`);

  // G14: SWEEP — nessuna riga orfana in NESSUNA tabella con tenant_id
  const tabs = await db.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'`);
  let leftovers = [];
  for (const { table_name } of tabs.rows) {
    if (KEEP.has(table_name)) continue;
    const n = Number((await db.query(`SELECT COUNT(*) c FROM "${table_name}" WHERE tenant_id=$1`, [tid])).rows[0].c);
    if (n > 0) leftovers.push(`${table_name}=${n}`);
  }
  const gone = (await db.query("SELECT id FROM saas_tenants WHERE id=$1", [tid])).rows.length === 0;
  check("G14 delete COMPLETA: zero righe orfane su tutte le tabelle tenant", gone && leftovers.length === 0, leftovers.slice(0, 8).join(",") || "clean");

  // G15: registri di piattaforma CONSERVATI (audit, backup, ordini SMS)
  const kept = (await db.query(`SELECT (SELECT COUNT(*) FROM saas_tenant_audit_logs WHERE tenant_id=$1) a, (SELECT COUNT(*) FROM saas_tenant_backups WHERE tenant_id=$1) b, (SELECT COUNT(*) FROM saas_sms_orders WHERE tenant_id=$1) o`, [tid])).rows[0];
  check("G15 audit/backup/ordini SMS conservati dopo la delete", Number(kept.a) > 0 && Number(kept.b) >= 2 && Number(kept.o) === 1, JSON.stringify(kept));

  // G17: rate-limit login (10 falliti -> blocco)
  let rlMsg = "";
  for (let i = 0; i < 11; i += 1) {
    const res = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ email: RLMAIL, password: "sbagliata" }) });
    rlMsg = String((await res.json().catch(() => ({}))).error ?? "");
  }
  check("G17 rate-limit login -> blocco dopo 10 tentativi", /Troppi tentativi/i.test(rlMsg), rlMsg);
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  // Cleanup per ID/prefissi TRACCIATI in-sessione
  try {
    if (tid) {
      const tabs = await db.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'`);
      for (const { table_name } of tabs.rows) if (table_name !== "saas_tenants") await db.query(`DELETE FROM "${table_name}" WHERE tenant_id=$1`, [tid]).catch(() => {});
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    for (const tk of tokenIds) await db.query("DELETE FROM saas_support_access_tokens WHERE id=$1", [tk]).catch(() => {});
    // Oggetti R2 tracciati (chiavi saas-backups/...): delete dal bucket privato.
    for (const key of backupFiles) {
      await s3.send(new DeleteObjectCommand({ Bucket: env("R2_BUCKET_PRIVATE"), Key: key })).catch(() => {});
      const local = path.join(ROOT, "storage", "saas_backups", key.replace(/^saas-backups\//, ""));
      try { if (existsSync(local)) unlinkSync(local); } catch {}
    }
    for (const id of [ownerId, viewerId].filter(Boolean)) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [id]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [id]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [id]).catch(() => {});
    }
    for (const mail of [OWNER, VIEWER, RLMAIL]) await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [mail]).catch(() => {});
    const residui = tid ? Number((await db.query("SELECT COUNT(*) c FROM saas_tenants WHERE id=$1", [tid])).rows[0].c) : 0;
    console.log(`CLEANUP: tenant residuo=${residui} admin=(${ownerId},${viewerId}) -> ${residui === 0 ? "CLEAN" : "ATTENZIONE"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
