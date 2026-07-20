// SaaS Admin Fase 1 blindatura (2026-07-18): sessioni server-side con revoca,
// 2FA TOTP end-to-end (codice calcolato in-test, RFC 6238), origin-check,
// header middleware, audit. Admin TEMPORANEO creato in DB e rimosso per id.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const bcrypt = require("bcryptjs");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const EMAIL = `zz.saas${RUN}@example.test`;
let adminId = 0, admin2Id = 0;

// --- TOTP RFC 6238 replicato in-test ---------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const d = crypto.createHmac("sha1", b32decode(secret)).update(msg).digest();
  const o = d[d.length - 1] & 15;
  return ((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const api = (path, body, cookie = "", extraHeaders = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders }, body: JSON.stringify(body) });
const cookieOf = (res) => (res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).filter((c) => c.includes("prenodo_admin_session")).join("; ");

try {
  // seed admin temporaneo (owner: serve per admins route e sessioni globali)
  const hash = bcrypt.hashSync("SaasTest!123", 10);
  const ins = await db.query(
    "INSERT INTO saas_admins(name,email,password_hash,role,is_active) VALUES($1,$2,$3,'owner',1) RETURNING id",
    ["ZZ SaasTest", EMAIL, hash],
  );
  adminId = Number(ins.rows[0].id);
  check("S0 admin temporaneo creato", adminId > 0, `id=${adminId}`);

  // M1: header middleware su /admin/login
  const page = await fetch(`${BASE}/admin/login`);
  check("M1 proxy: DENY frame + noindex (cache-control sovrascritto dal dev server)", page.headers.get("x-frame-options") === "DENY" && /noindex/.test(page.headers.get("x-robots-tag") || ""), JSON.stringify([page.headers.get("x-frame-options"), page.headers.get("x-robots-tag")]));

  // O1: origin ostile -> 403
  const evil = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }, "", { origin: "http://evil.example" });
  check("O1 Origin ostile -> 403 bloccato", evil.status === 403, `status=${evil.status}`);

  // L1: password errata
  const bad = await api("/api/admin/auth/login", { email: EMAIL, password: "sbagliata" }).then((r) => r.json());
  check("L1 password errata -> 'Credenziali non valide.'", bad.ok !== true && /Credenziali/.test(bad.error || ""), bad.error);

  // L2: login ok -> cookie opaco 64hex + riga sessione server-side
  const login1 = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" });
  const cookie1 = cookieOf(login1);
  const token1 = (cookie1.split("=")[1] || "");
  const sessRows = await db.query("SELECT COUNT(*)::int AS n FROM saas_admin_sessions WHERE admin_id=$1 AND revoked_at IS NULL", [adminId]);
  check("L2 login ok -> token opaco 64hex + sessione in DB", /^[a-f0-9]{64}$/.test(token1) && sessRows.rows[0].n === 1, `token=${token1.slice(0, 8)}… sessioni=${sessRows.rows[0].n}`);

  // ST1: status con sessione
  const st = await fetch(`${BASE}/api/admin/auth/status`, { headers: { cookie: cookie1 } }).then((r) => r.json());
  check("ST1 status -> user + totp OFF + suggerimento setup (owner)", st.user?.email === EMAIL && st.totpEnabled === false && st.totpSetupSuggested === true, JSON.stringify([st.user?.email, st.totpEnabled, st.totpSetupSuggested]));

  // T1-T3: setup TOTP end-to-end
  const t1 = await api("/api/admin/security", { action: "totp_start" }, cookie1).then((r) => r.json());
  check("T1 totp_start -> secret base32 + otpauth uri", t1.ok === true && /^[A-Z2-7]{16,}$/.test(t1.secret || "") && /^otpauth:\/\/totp\//.test(t1.uri || ""), (t1.secret || "").slice(0, 8) + "…");
  const t2bad = await api("/api/admin/security", { action: "totp_confirm", code: "000000" }, cookie1).then((r) => r.json());
  check("T2 conferma con codice errato -> respinta", t2bad.ok !== true, t2bad.error);
  const t3 = await api("/api/admin/security", { action: "totp_confirm", code: totp(t1.secret) }, cookie1).then((r) => r.json());
  check("T3 conferma con codice CALCOLATO -> 2FA attiva + 8 backup codes", t3.ok === true && Array.isArray(t3.backupCodes) && t3.backupCodes.length === 8, `codes=${t3.backupCodes?.length}`);

  // LO1: logout -> revoca SERVER-SIDE (il vecchio cookie muore)
  await api("/api/admin/auth/logout", {}, cookie1);
  const afterLogout = await fetch(`${BASE}/api/admin/auth/status`, { headers: { cookie: cookie1 } }).then((r) => r.json());
  check("LO1 logout -> vecchio cookie NON risolve più la sessione", afterLogout.user === null, JSON.stringify(afterLogout.user));

  // T4-T6: login con 2FA
  const l2 = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }).then((r) => r.json());
  check("T4 password ok con 2FA -> needsTotp + challenge (NIENTE sessione)", l2.ok === true && l2.needsTotp === true && !!l2.challenge, JSON.stringify([l2.needsTotp, !!l2.challenge]));
  const l2bad = await api("/api/admin/auth/login", { mode: "totp", challenge: l2.challenge, code: "000000" }).then((r) => r.json());
  check("T5 codice 2FA errato -> respinto", l2bad.ok !== true && /2FA/.test(l2bad.error || ""), l2bad.error);
  const l2ok = await api("/api/admin/auth/login", { mode: "totp", challenge: l2.challenge, code: totp(t1.secret) });
  const cookie2 = cookieOf(l2ok);
  check("T6 codice 2FA giusto -> sessione", (await l2ok.json()).ok === true && cookie2 !== "", cookie2.split("=")[0]);

  // B1: codice di BACKUP one-time
  await api("/api/admin/auth/logout", {}, cookie2);
  const l3 = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }).then((r) => r.json());
  const backup = t3.backupCodes[0];
  const l3ok = await api("/api/admin/auth/login", { mode: "totp", challenge: l3.challenge, code: backup });
  const cookie3 = cookieOf(l3ok);
  const l3resp = await l3ok.json();
  const l4 = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }).then((r) => r.json());
  const l4reuse = await api("/api/admin/auth/login", { mode: "totp", challenge: l4.challenge, code: backup }).then((r) => r.json());
  check("B1 backup code: valido UNA volta, riuso respinto", l3resp.ok === true && cookie3 !== "" && l4reuse.ok !== true, JSON.stringify([l3resp.ok, l4reuse.ok !== true]));

  // SE1: sessioni attive + revoca remota
  const sec = await fetch(`${BASE}/api/admin/security`, { headers: { cookie: cookie3 } }).then((r) => r.json());
  check("SE1 lista sessioni attive", sec.ok === true && Array.isArray(sec.sessions) && sec.sessions.length >= 1, `sessioni=${sec.sessions?.length}`);
  // seconda sessione da revocare
  const lX = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }).then((r) => r.json());
  const lXok = await api("/api/admin/auth/login", { mode: "totp", challenge: lX.challenge, code: totp(t1.secret) });
  const cookieX = cookieOf(lXok); await lXok.json();
  const secList = await fetch(`${BASE}/api/admin/security`, { headers: { cookie: cookie3 } }).then((r) => r.json());
  const tokenXHash = crypto.createHash("sha256").update(cookieX.split("=")[1]).digest("hex");
  const rowX = (await db.query("SELECT id FROM saas_admin_sessions WHERE token_hash=$1", [tokenXHash])).rows[0];
  const rev = await api("/api/admin/security", { action: "session_revoke", id: Number(rowX.id) }, cookie3).then((r) => r.json());
  const afterRevoke = await fetch(`${BASE}/api/admin/auth/status`, { headers: { cookie: cookieX } }).then((r) => r.json());
  check("SE2 revoca remota -> la sessione revocata muore subito", rev.ok === true && afterRevoke.user === null, JSON.stringify([rev.ok, afterRevoke.user]));
  check("SE3 la lista includeva la sessione poi revocata", secList.sessions.some((s) => s.id === Number(rowX.id)), "");

  // AD1: azione mutativa admins (create) -> audit admin_create
  const cr = await api("/api/admin/admins", { action: "create", name: "ZZ Temp2", email: `zz.saas2_${RUN}@example.test`, password: "AltroTest!123", role: "viewer" }, cookie3).then((r) => r.json());
  const row2 = (await db.query("SELECT id FROM saas_admins WHERE email=$1", [`zz.saas2_${RUN}@example.test`])).rows[0];
  admin2Id = Number(row2?.id ?? 0);
  const audit = await db.query("SELECT action FROM saas_admin_audit WHERE admin_id=$1 ORDER BY id", [adminId]);
  const actions = audit.rows.map((r) => r.action);
  check("AD1 audit: login/2fa/totp_enable/session_revoke/admin_create registrati", cr.ok === true && actions.includes("login") && actions.includes("login_2fa") && actions.includes("totp_enable") && actions.includes("session_revoke") && actions.includes("admin_create"), JSON.stringify(actions));

  // T7: disattivazione 2FA (password + codice)
  const dis = await api("/api/admin/security", { action: "totp_disable", password: "SaasTest!123", code: totp(t1.secret) }, cookie3).then((r) => r.json());
  const plainLogin = await api("/api/admin/auth/login", { email: EMAIL, password: "SaasTest!123" }).then((r) => r.json());
  check("T7 disattiva 2FA -> login torna a un solo passo", dis.ok === true && plainLogin.ok === true && !plainLogin.needsTotp, JSON.stringify([dis.ok, !plainLogin.needsTotp]));
} finally {
  for (const id of [adminId, admin2Id]) {
    if (id > 0) {
      await db.query("DELETE FROM saas_admin_sessions WHERE admin_id=$1", [id]).catch(() => 0);
      await db.query("DELETE FROM saas_admin_audit WHERE admin_id=$1", [id]).catch(() => 0);
      await db.query("DELETE FROM saas_admin_login_attempts WHERE email IN (SELECT email FROM saas_admins WHERE id=$1)", [id]).catch(() => 0);
      await db.query("DELETE FROM saas_admins WHERE id=$1 AND email LIKE 'zz.saas%'", [id]);
    }
  }
  const resid = (await db.query("SELECT COUNT(*)::int AS n FROM saas_admins WHERE email LIKE 'zz.saas%'")).rows[0]?.n ?? -1;
  console.log(`CLEANUP: admin residui=${resid} (ids=${adminId},${admin2Id}) -> ${resid === 0 ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
