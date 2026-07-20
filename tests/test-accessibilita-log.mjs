// Accessibilità — log eventi sicurezza (miglioria 2026-07-17): verifica email,
// cambio email e cambio password loggano nel modulo 'accessi' SOLO dopo il
// successo; errori (codice sbagliato, password errata) NON loggano.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const bcrypt = require("bcryptjs");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
function cookieFor(userId, email) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: userId, email, name: "ZZ AccLog", role: "staff", perms: [], needsEmailVerification: true, currentLocationId: 21, needsLocationSelection: false, locationIds: [21] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie) {
  const res = await fetch(`${BASE}/api/manage/accessibility?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = String(Date.now()).slice(-6);
const E1 = `zz.acclog.${RUN}@example.com`, E2 = `zz.acclog2.${RUN}@example.com`;

const accLogs = async () => (await q("SELECT id, action, label, user_label FROM activity_logs WHERE tenant_id=$1 AND module='accessi' ORDER BY id", [T])).rows;
const baseIds = new Set((await accLogs()).map((r) => Number(r.id)));
const fresh = async () => (await accLogs()).filter((r) => !baseIds.has(Number(r.id)));
const tracked = new Set();
let uid = 0;
try {
  uid = Number((await q("INSERT INTO users (tenant_id, name, email, password_hash, role, email_verified_at) VALUES ($1,$2,$3,$4,'staff',NULL) RETURNING id", [T, `ZZ AccLog ${RUN}`, E1, bcrypt.hashSync("Password1!", 10)])).rows[0].id);
  let cookie = cookieFor(uid, E1);

  // L1: codice sbagliato NON logga
  const r1 = await api({ action: "request_email_verify" }, cookie);
  await api({ action: "confirm_email_change", code: "000000" }, cookie);
  await sleep(1200);
  check("L1 codice errato NON logga", (await fresh()).length === 0, "");

  // L2: verifica email attuale -> 'Email di accesso verificata'
  await api({ action: "confirm_email_change", code: String(r1.j?.verificationCode ?? "") }, cookie);
  await sleep(1500);
  let rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L2 verifica ok logga 'Email di accesso verificata'", rows.length === 1 && rows[0].label === "Email di accesso verificata" && rows[0].action === "modifica", JSON.stringify(rows));

  // L3: cambio email -> 'Cambiata email di accesso in <nuova>'
  await q("DELETE FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]);
  const r3 = await api({ action: "request_email_change", new_email: E2, current_password_email: "Password1!" }, cookie);
  await api({ action: "confirm_email_change", code: String(r3.j?.verificationCode ?? "") }, cookie);
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L3 cambio email logga 'Cambiata email di accesso in ...'", rows.length === 2 && rows.some((r) => r.label === `Cambiata email di accesso in ${E2}`), JSON.stringify(rows.map((r) => r.label)));
  cookie = cookieFor(uid, E2);

  // L4: password errata NON logga; L5: cambio password ok logga
  await api({ action: "change_password", current_password: "Sbagliata1", new_password: "NuovaPass1", new_password_confirm: "NuovaPass1" }, cookie);
  await sleep(1200);
  check("L4 password errata NON logga", (await fresh()).length === 2, "");
  const p5 = await api({ action: "change_password", current_password: "Password1!", new_password: "NuovaPass1", new_password_confirm: "NuovaPass1" }, cookie);
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L5 cambio password logga 'Password di accesso aggiornata'", p5.j?.ok === true && rows.length === 3 && rows.some((r) => r.label === "Password di accesso aggiornata"), JSON.stringify(rows.map((r) => r.label)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (uid) {
    await q("DELETE FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]).catch(() => {});
    await q("DELETE FROM password_resets WHERE tenant_id=$1 AND user_id=$2", [T, uid]).catch(() => {});
    await q("DELETE FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]).catch(() => {});
  }
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = (await fresh()).length;
  const fin = await q1("SELECT (SELECT COUNT(*) FROM users WHERE tenant_id=$1)::int u", [T]);
  const okBase = fin.u === 2 && left === 0;
  console.log(`CLEANUP: users=${fin.u} logResidui=${left} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
