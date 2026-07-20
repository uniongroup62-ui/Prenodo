// Pannello admin Fase E (2026-07-19): piani veri (saas_plans) con limiti che
// governano il gate sedi del gestionale + vista Piani & Ricavi (MRR, SMS/mese,
// wallet). Il gate e' provato sul tenant REALE 25 (centroesteticoelite, 2 sedi
// attive) SENZA creare nulla: piano limitato assegnato -> create respinta;
// piano illimitato -> passa il gate e si ferma sulla VALIDAZIONE nome vuoto.
// plan/plan_id del tenant reale letti PRIMA e ripristinati nel cleanup.
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const REAL_SLUG = "centroesteticoelite";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.fasee${RUN}@example.test`;
let adminId = 0, planId = 0, origPlan = null, browser = null;

// Sessione manage FORGIATA (ricetta nota, sede 21, utente reale 20)
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const payload = { tenantSlug: REAL_SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["settings.location", "settings.general"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 };
const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
const manageCookie = `beautysuite_session_t_${REAL_SLUG}=${b64}.${crypto.createHmac("sha256", SECRET).update(b64).digest("base64url")}`;
const manageSave = (body) => fetch(`${BASE}/api/manage/business-settings`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: manageCookie, "x-tenant-slug": REAL_SLUG }, body: JSON.stringify({ action: "location_save", ...body }) });
const post = (cookie, url, body) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ FaseE", EMAIL, bcrypt.hashSync("FaseE!123", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "FaseE!123" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));

  // Il primo GET billing esegue l'ensure (tabella saas_plans + colonna
  // plan_id): solo DOPO si puo' leggere lo stato originale del tenant reale.
  await fetch(`${BASE}/api/admin/operations?section=billing`, { headers: { cookie } });
  origPlan = (await db.query("SELECT plan, plan_id FROM saas_tenants WHERE slug=$1", [REAL_SLUG])).rows[0] ?? null;

  // K1: crea piano con limite 2 sedi
  const save = await post(cookie, "/api/admin/operations", { action: "plan_save", name: `ZZ Piano E ${RUN}`, price_month: "49.90", max_locations: "2", max_staff: "", sms_included_month: "100" });
  const saveBody = await save.json().catch(() => ({}));
  planId = Number(saveBody?.id ?? 0);
  const planRow = planId ? (await db.query("SELECT name, price_month, max_locations, max_staff FROM saas_plans WHERE id=$1", [planId])).rows[0] : null;
  check("K1 plan_save -> piano con limite sedi 2, staff illimitato", save.status === 200 && planId > 0 && Number(planRow?.price_month) === 49.9 && Number(planRow?.max_locations) === 2 && planRow?.max_staff === null, JSON.stringify(planRow));

  // K2: assegna al tenant reale -> plan_id + etichetta sincronizzata
  const assign = await post(cookie, "/api/admin/operations", { action: "plan_assign", tenant_slug: REAL_SLUG, plan_id: String(planId) });
  const trow = (await db.query("SELECT plan, plan_id FROM saas_tenants WHERE slug=$1", [REAL_SLUG])).rows[0];
  check("K2 plan_assign -> plan_id + etichetta", assign.status === 200 && Number(trow?.plan_id) === planId && String(trow?.plan) === `ZZ Piano E ${RUN}`, JSON.stringify(trow));

  // K3: GATE — 2 sedi attive, limite 2: creazione RESPINTA col messaggio nudo
  const blocked = await manageSave({ name: `ZZ Sede oltre limite ${RUN}` });
  const blockedBody = await blocked.json().catch(() => ({}));
  const noNewLoc = Number((await db.query("SELECT COUNT(*) c FROM locations WHERE tenant_id=25 AND name LIKE $1", [`ZZ Sede oltre limite%`])).rows[0].c);
  check("K3 gate: creazione oltre il limite respinta NUDA, nessuna sede scritta", String(blockedBody?.error ?? "").startsWith("Limite sedi del piano raggiunto") && noNewLoc === 0, `err=${blockedBody?.error}`);

  // K4: EDIT di una sede esistente NON e' bloccato dal gate (solo create).
  // Edit IDEMPOTENTE: si ripassano TUTTI i campi letti dal DB (i campi assenti
  // verrebbero azzerati dal normalize legacy).
  const FIELDS = "name,address,phone,email,whatsapp,facebook_url,instagram_url,tiktok_url,booking_enabled,legal_region,legal_province,legal_city,legal_cap";
  const loc21 = (await db.query(`SELECT ${FIELDS} FROM locations WHERE id=21 AND tenant_id=25`)).rows[0];
  const editPayload = { id: "21" };
  for (const f of FIELDS.split(",")) editPayload[f] = f === "booking_enabled" ? (Number(loc21[f]) === 1 ? "1" : "") : String(loc21[f] ?? "");
  const edit = await manageSave(editPayload);
  const editBody = await edit.json().catch(() => ({}));
  const loc21After = (await db.query(`SELECT ${FIELDS} FROM locations WHERE id=21 AND tenant_id=25`)).rows[0];
  const unchanged = FIELDS.split(",").every((f) => String(loc21[f] ?? "") === String(loc21After[f] ?? ""));
  check("K4 gate solo in creazione: edit sede esistente passa e resta IDENTICA", edit.status === 200 && editBody?.message === "Sede salvata" && unchanged, `msg=${editBody?.message ?? editBody?.error} unchanged=${unchanged}`);

  // K5: piano ILLIMITATO -> il gate passa e si ferma la VALIDAZIONE (nome vuoto)
  await post(cookie, "/api/admin/operations", { action: "plan_save", plan_id: String(planId), name: `ZZ Piano E ${RUN}`, price_month: "49.90", max_locations: "", max_staff: "", sms_included_month: "100" });
  const valid = await manageSave({ name: "" });
  const validBody = await valid.json().catch(() => ({}));
  check("K5 limite rimosso -> gate passa, blocca la validazione nome", String(validBody?.error ?? "") === "Inserisci il nome della sede.", `err=${validBody?.error}`);

  // K6: billing section — MRR include il piano assegnato, wallet e sms_monthly presenti
  const billing = await (await fetch(`${BASE}/api/admin/operations?section=billing`, { headers: { cookie } })).json();
  const byPlan = (billing.revenue?.by_plan ?? []).find((p) => p.id === planId);
  const tenantOpt = (billing.tenants ?? []).find((t) => t.slug === REAL_SLUG);
  check("K6 billing: MRR per piano (1 tenant x 49.90) + tenant con plan_id", billing.ok === true && byPlan?.tenants === 1 && byPlan?.mrr === 49.9 && billing.revenue.mrr_total >= 49.9 && Number(tenantOpt?.plan_id) === planId && Array.isArray(billing.revenue.sms_monthly) && typeof billing.revenue.wallet_credits_total === "number", `byPlan=${JSON.stringify(byPlan)}`);

  // K7: UI Piani & Ricavi renderizzata (nav 10 voci, metriche, tabella piani)
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=billing`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Piani e MRR").waitFor({ timeout: 30000 });
  const navCount = await page.locator("aside nav button").count();
  const planCell = await page.locator(`text=ZZ Piano E ${RUN}`).count();
  const mrrMetric = await page.locator("text=MRR").count();
  check("K7 UI billing: nav 8 voci + piano in tabella + metrica MRR", navCount === 8 && planCell >= 1 && mrrMetric >= 1, `nav=${navCount} plan=${planCell}`);

  // K8: unassign -> tenant torna senza piano (illimitato)
  const un = await post(cookie, "/api/admin/operations", { action: "plan_assign", tenant_slug: REAL_SLUG, plan_id: "0" });
  const trow2 = (await db.query("SELECT plan_id FROM saas_tenants WHERE slug=$1", [REAL_SLUG])).rows[0];
  check("K8 unassign -> plan_id NULL", un.status === 200 && trow2?.plan_id === null, JSON.stringify(trow2));
} catch (e) {
  console.log("ERRORE:", e && e.message ? e.message : e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    // Ripristino ESATTO del tenant reale (plan + plan_id letti a inizio test)
    if (origPlan) await db.query("UPDATE saas_tenants SET plan=$1, plan_id=$2 WHERE slug=$3", [origPlan.plan, origPlan.plan_id, REAL_SLUG]).catch(() => {});
    if (planId) await db.query("DELETE FROM saas_plans WHERE id=$1", [planId]).catch(() => {});
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    await db.query("DELETE FROM saas_tenant_audit_logs WHERE tenant_id=25 AND action LIKE 'saas_plan.%' AND created_at > NOW() - interval '30 minutes'", []).catch(() => {});
    const verify = (await db.query("SELECT plan, plan_id FROM saas_tenants WHERE slug=$1", [REAL_SLUG])).rows[0];
    console.log(`CLEANUP: tenant reale ripristinato plan=${verify?.plan} plan_id=${verify?.plan_id} -> ${String(verify?.plan) === String(origPlan?.plan) && String(verify?.plan_id) === String(origPlan?.plan_id) ? "CLEAN" : "ATTENZIONE"}`);
  } catch (e) { console.log("CLEANUP ERRORE:", e.message); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
