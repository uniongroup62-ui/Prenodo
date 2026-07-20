// Accessibilità pass 2 (2026-07-17) — FIX: confirm email TRANSAZIONALE
// (users+staff sync+pending), last_attempt_at/used_at in ora app-locale.
// + riverifica flussi: verify/cooldown/tentativi/scadenza/cambio email con
// sync staff/resend su scaduta/cambio password. Utente ZZ dedicato.
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
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: userId, email, name: "ZZ Acc", role: "staff", perms: [], needsEmailVerification: true, currentLocationId: 21, needsLocationSelection: false, locationIds: [21] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
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
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const E1 = `zz.acc.${RUN}@example.com`, E2 = `zz.acc2.${RUN}@example.com`;
const localHhmm = () => { const d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; };

let uid = 0, staffId = 0;
try {
  const hash = bcrypt.hashSync("Password1!", 10);
  uid = Number((await q("INSERT INTO users (tenant_id, name, email, password_hash, role, email_verified_at) VALUES ($1,$2,$3,$4,'staff',NULL) RETURNING id", [T, `ZZ Acc ${RUN}`, E1, hash])).rows[0].id);
  staffId = Number((await q("INSERT INTO staff (tenant_id, full_name, email, is_active) VALUES ($1,$2,$3,1) RETURNING id", [T, `ZZ Acc ${RUN}`, E1])).rows[0].id);
  let cookie = cookieFor(uid, E1);

  // R1: invio codice verifica email attuale (SES off in dev -> codice esposto)
  const r1 = await api({ action: "request_email_verify" }, cookie);
  const code1 = String(r1.j?.verificationCode ?? "");
  check("R1 request_email_verify: 'Codice inviato alla tua email' + pending + codice (dev)", r1.j?.ok === true && r1.j?.message === "Codice inviato alla tua email" && /^\d{6}$/.test(code1) && r1.j?.pending?.email === E1, JSON.stringify({ m: r1.j?.message, c: !!code1 }));

  // R2: cooldown 60s
  const r2 = await api({ action: "request_email_verify" }, cookie);
  check("R2 cooldown: 'Attendi N secondi...'", /^Attendi \d+ secondi prima di richiedere un nuovo codice\.$/.test(err(r2)), JSON.stringify(err(r2)));

  // C1: codice sbagliato -> tentativo + last_attempt_at LOCALE
  const c1 = await api({ action: "confirm_email_change", code: "000000" }, cookie);
  const pend1 = await q1("SELECT attempt_count, last_attempt_at::text la FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]);
  const laH = Number(String(pend1?.la ?? "").slice(11, 13));
  const { h: nowH } = localHhmm();
  const hourOk = Math.abs(laH - nowH) <= 1 || Math.abs(laH - nowH) === 23;
  check("C1 codice errato: 'Codice non valido', attempt=1, last_attempt_at in ora LOCALE", err(c1) === "Codice non valido" && Number(pend1?.attempt_count) === 1 && hourOk, JSON.stringify({ e: err(c1), p: pend1, nowH }));

  // C2: altri 4 errori -> 5o = troppi tentativi + pending rimossa
  let lastErr = "";
  for (let i = 0; i < 4; i++) lastErr = err(await api({ action: "confirm_email_change", code: "000001" }, cookie));
  const pendGone = Number((await q1("SELECT COUNT(*) n FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]))?.n);
  check("C2 5o tentativo: 'Troppi tentativi non validi...' + pending rimossa", lastErr === "Troppi tentativi non validi. Richiedi un nuovo codice." && pendGone === 0, JSON.stringify({ lastErr, pendGone }));

  // C3: nuovo codice + conferma corretta -> verificata (tx) + verified_at locale
  const r3 = await api({ action: "request_email_verify" }, cookie);
  const code3 = String(r3.j?.verificationCode ?? "");
  const c3 = await api({ action: "confirm_email_change", code: code3 }, cookie);
  const u3 = await q1("SELECT email, email_verified_at::text v FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]);
  const p3 = Number((await q1("SELECT COUNT(*) n FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]))?.n);
  const vH = Number(String(u3?.v ?? "").slice(11, 13));
  check("C3 conferma ok: 'Email verificata', verified_at LOCALE, pending rimossa", c3.j?.ok === true && c3.j?.message === "Email verificata" && u3?.email === E1 && (Math.abs(vH - nowH) <= 1 || Math.abs(vH - nowH) === 23) && p3 === 0, JSON.stringify({ m: c3.j?.message, u: u3, p3 }));

  // E-serie: cambio email
  const e0 = await api({ action: "request_email_change", new_email: E1, current_password_email: "Password1!" }, cookie);
  check("E0 stessa email -> 'L email e gia questa'", err(e0) === "L email e gia questa", JSON.stringify(err(e0)));
  const e1b = await api({ action: "request_email_change", new_email: E2, current_password_email: "sbagliata" }, cookie);
  check("E1 password errata -> 'Password attuale non corretta'", err(e1b) === "Password attuale non corretta", JSON.stringify(err(e1b)));
  const e2b = await api({ action: "request_email_change", new_email: "INFO@ARTEBRAND.IT", current_password_email: "Password1!" }, cookie);
  check("E2 email di altro account (case) -> 'Email gia utilizzata da un altro account o operatore'", err(e2b) === "Email gia utilizzata da un altro account o operatore", JSON.stringify(err(e2b)));
  const e3 = await api({ action: "request_email_change", new_email: E2, current_password_email: "Password1!" }, cookie);
  const code4 = String(e3.j?.verificationCode ?? "");
  check("E3 cambio valido: 'Codice inviato alla nuova email'", e3.j?.ok === true && e3.j?.message === "Codice inviato alla nuova email" && /^\d{6}$/.test(code4), JSON.stringify(e3.j?.message));

  // RS1: resend su pending SCADUTA -> permesso (get_pending senza cleanup)
  await q("UPDATE user_email_verifications SET expires_at=(NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour', created_at=created_at - INTERVAL '2 minutes' WHERE tenant_id=$1 AND user_id=$2", [T, uid]);
  const rs1 = await api({ action: "resend_email_code" }, cookie);
  const code5 = String(rs1.j?.verificationCode ?? "");
  check("RS1 resend su pending scaduta -> 'Codice reinviato' (nuovo codice)", rs1.j?.ok === true && rs1.j?.message === "Codice reinviato" && /^\d{6}$/.test(code5), JSON.stringify(rs1.j?.message));

  // C4: conferma cambio -> users + STAFF sincronizzato in transazione
  const c4 = await api({ action: "confirm_email_change", code: code5 }, cookie);
  const u4 = await q1("SELECT email FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]);
  const s4 = await q1("SELECT email FROM staff WHERE tenant_id=$1 AND id=$2", [T, staffId]);
  check("C4 conferma cambio: users + staff email SINCRONIZZATE (tx)", c4.j?.ok === true && u4?.email === E2 && s4?.email === E2, JSON.stringify({ u: u4?.email, s: s4?.email }));
  cookie = cookieFor(uid, E2);

  // X1: conferma con codice SCADUTO -> flash e pending rimossa
  await q("INSERT INTO user_email_verifications (tenant_id, user_id, new_email, code_hash, expires_at, created_at, attempt_count) VALUES ($1,$2,$3,$4,'2020-01-01 10:00:00','2020-01-01 09:45:00',0)", [T, uid, E2, crypto.createHash("sha256").update("123456").digest("hex")]);
  const x1 = await api({ action: "confirm_email_change", code: "123456" }, cookie);
  const x1gone = Number((await q1("SELECT COUNT(*) n FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]))?.n);
  check("X1 codice scaduto -> 'Codice scaduto: richiedi un nuovo codice' + pending rimossa", err(x1) === "Codice scaduto: richiedi un nuovo codice" && x1gone === 0, JSON.stringify({ e: err(x1), x1gone }));

  // P-serie: cambio password (flash verbatim)
  const p1 = await api({ action: "change_password", current_password: "", new_password: "", new_password_confirm: "" }, cookie);
  check("P1 campi vuoti -> 'Compila tutti i campi password'", err(p1) === "Compila tutti i campi password", JSON.stringify(err(p1)));
  const p2 = await api({ action: "change_password", current_password: "Password1!", new_password: "NuovaPass1", new_password_confirm: "Diversa1" }, cookie);
  check("P2 non coincidono", err(p2) === "Le nuove password non coincidono", JSON.stringify(err(p2)));
  const p3b = await api({ action: "change_password", current_password: "Password1!", new_password: "corta1", new_password_confirm: "corta1" }, cookie);
  check("P3 corta -> 'almeno 8 caratteri'", err(p3b) === "La nuova password deve avere almeno 8 caratteri", JSON.stringify(err(p3b)));
  const p4 = await api({ action: "change_password", current_password: "Sbagliata1", new_password: "NuovaPass1", new_password_confirm: "NuovaPass1" }, cookie);
  check("P4 password attuale errata", err(p4) === "Password attuale non corretta", JSON.stringify(err(p4)));
  const oldHash = (await q1("SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]))?.password_hash;
  const p5 = await api({ action: "change_password", current_password: "Password1!", new_password: "NuovaPass1", new_password_confirm: "NuovaPass1" }, cookie);
  const newHash = (await q1("SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]))?.password_hash;
  check("P5 cambio ok: 'Password aggiornata' + hash sostituito", p5.j?.ok === true && p5.j?.message === "Password aggiornata" && newHash !== oldHash && bcrypt.compareSync("NuovaPass1", String(newHash).replace(/^\$2y\$/, "$2a$")), JSON.stringify(p5.j?.message));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (uid) {
    await q("DELETE FROM user_email_verifications WHERE tenant_id=$1 AND user_id=$2", [T, uid]).catch(() => {});
    await q("DELETE FROM password_resets WHERE tenant_id=$1 AND user_id=$2", [T, uid]).catch(() => {});
    await q("DELETE FROM users WHERE tenant_id=$1 AND id=$2", [T, uid]).catch(() => {});
  }
  if (staffId) {
    await q("DELETE FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2", [T, staffId]).catch(() => {});
    await q("DELETE FROM staff WHERE tenant_id=$1 AND id=$2", [T, staffId]).catch(() => {});
  }
  const fin = await q1("SELECT (SELECT COUNT(*) FROM users WHERE tenant_id=$1)::int u,(SELECT COUNT(*) FROM staff WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM user_email_verifications WHERE tenant_id=$1)::int v", [T]);
  const okBase = fin.u === 2 && fin.s === 2 && fin.v === 0;
  console.log(`CLEANUP: ${okBase ? "baseline OK" : "DIVERSA " + JSON.stringify(fin)} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
