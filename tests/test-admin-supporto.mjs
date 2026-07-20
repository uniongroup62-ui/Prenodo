// Tab Supporto rivista (2026-07-20): didascalia, date senza secondi, colonna
// Esito unica (Usato/Revocato/Scaduto), bottone Copia, empty-state parlante.
// Ciclo COMPLETO verificato: genera -> consuma (used) / revoca / forgia
// scaduto -> esiti distinti nello storico. Fixture ZZ, cleanup per id.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const ENV = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = (k) => (ENV.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)\\s*$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: env("PRENODO_DATABASE_URL"), ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.supp${RUN}@example.test`;
const SLUG = `zz-supp${RUN}`;
let adminId = 0, tid = 0, browser = null;

try {
  const ins = await db.query("INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id", ["ZZ Supp", EMAIL, bcrypt.hashSync("Sp!12345", 10)]);
  adminId = Number(ins.rows[0].id);
  const login = await fetch(`${BASE}/api/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: "Sp!12345" }) });
  const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(";")[0]).find((c) => c.includes("prenodo_admin_session"));
  const t = await db.query("INSERT INTO saas_tenants(slug,name,db_prefix,is_active,status) VALUES($1,'ZZ Supp',$2,1,'active') RETURNING id", [SLUG, `t_zzsp${RUN}_`]);
  tid = Number(t.rows[0].id);
  await db.query("INSERT INTO users(tenant_id,name,email,password_hash,role) VALUES($1,'ZZ Supp',$2,$3,'admin')", [tid, EMAIL, bcrypt.hashSync("Sp!12345", 10)]);

  const post = (body) => fetch(`${BASE}/api/admin/tenants`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) });

  // 3 token via API: uno da CONSUMARE, uno da REVOCARE, uno da far SCADERE
  const links = [];
  for (const reason of ["ZZ da usare", "ZZ da revocare", "ZZ da scadere"]) {
    const res = await (await post({ action: "support_create", slug: SLUG, reason, minutes: "15" })).json();
    links.push(String(res.token?.link ?? ""));
  }
  const tokens = (await db.query("SELECT id, reason FROM saas_support_access_tokens WHERE tenant_id=$1 ORDER BY id ASC", [tid])).rows;
  check("S1 tre token creati con link", tokens.length === 3 && links.every(Boolean), `tok=${tokens.length} links=${links.filter(Boolean).length}`);

  // consumo del primo (catena di redirect fino al gestionale + used_at)
  const consume = await fetch(links[0]);
  const used = (await db.query("SELECT used_at FROM saas_support_access_tokens WHERE id=$1", [tokens[0].id])).rows[0];
  check("S2 link consumato: risposta valida + used_at registrato", consume.status < 400 && Boolean(used?.used_at), `http=${consume.status} used=${Boolean(used?.used_at)}`);

  // revoca del secondo via API; il terzo forgiato SCADUTO (fixture ZZ propria)
  await post({ action: "support_revoke", slug: SLUG, token_id: String(tokens[1].id) });
  await db.query("UPDATE saas_support_access_tokens SET expires_at='2026-01-01 00:00:00' WHERE id=$1", [tokens[2].id]);

  // --- UI ---
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [cn, cv] = cookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin?page=tenants&slug=${SLUG}&tab=support`, { waitUntil: "domcontentloaded" });
  await page.locator("text=Storico accessi supporto").waitFor({ timeout: 30000 });

  const caption = await page.locator("text=sessione si chiude alla scadenza del token").count();
  const noActive = await page.locator("text=Nessun token attivo.").count();
  check("S3 didascalia presente + empty-state parlante (tutti consumati)", caption === 1 && noActive === 1, `caption=${caption} empty=${noActive}`);

  const body = await page.locator("main, body").first().innerText();
  const esiti = ["Usato il", "Revocato il", "Scaduto senza uso"].map((e) => body.includes(e));
  check("S4 storico: tre esiti distinti nella colonna Esito", esiti.every(Boolean), esiti.join(","));

  const rawSeconds = /\d{2}:\d{2}:\d{2}/.test(body);
  // gli header tabella sono uppercase via CSS: match case-insensitive
  const formatted = /Creato il[\s\S]*\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/i.test(body);
  check("S5 date formattate senza secondi + colonna Creato il", formatted && !rawSeconds, `fmt=${formatted} secondi=${rawSeconds}`);

  // genera dal FORM -> box verde col bottone Copia + token attivo formattato
  await page.fill("input[name='reason']", "ZZ dal form");
  await page.locator("button", { hasText: "Genera accesso supporto" }).click();
  await page.locator("text=Link monouso generato").waitFor({ timeout: 20000 });
  const copyBtn = await page.locator("button", { hasText: "Copia" }).count();
  await page.locator("text=Token disponibili").waitFor({ timeout: 10000 });
  const activeRow = await page.locator("tr", { hasText: "ZZ dal form" }).locator("button", { hasText: "Revoca" }).count();
  check("S6 form: box link con Copia + token attivo con Revoca", copyBtn === 1 && activeRow === 1, `copia=${copyBtn} revoca=${activeRow}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (tid) {
      for (const tab of ["saas_support_access_tokens", "users", "tenant_onboarding_progress", "permissions", "saas_tenant_health_checks", "saas_tenant_audit_logs"]) {
        await db.query(`DELETE FROM ${tab} WHERE tenant_id=$1`, [tid]).catch(() => {});
      }
      await db.query("DELETE FROM saas_tenants WHERE id=$1", [tid]).catch(() => {});
    }
    if (adminId) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [adminId]).catch(() => {});
      await db.query("DELETE FROM saas_admins WHERE id=$1", [adminId]).catch(() => {});
    }
    await db.query("DELETE FROM saas_admin_login_attempts WHERE email=$1", [EMAIL]).catch(() => {});
    console.log("CLEANUP: ok (token, tenant ZZ, admin per id)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await db.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
