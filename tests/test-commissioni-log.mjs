// Commissioni — miglioria log attività (2026-07-18): modulo NUOVO 'commissioni'
// su pay / toggle_commission_paid / save_module_settings / save_settings.
// Segnali DOPO il successo (lib throwano). Disciplina trappola 5: l'enable
// AUTO-APRE i periodi modulo -> snapshot pre-run + cleanup dei soli nuovi +
// restore is_enabled.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["commissions.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/commissions?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const fresh = async () => (await q("SELECT module, action, entity_id, label, details_json FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, logWatermark])).rows;
const mod0 = Number((await q1("SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=$1 AND id=1", [T]))?.is_enabled ?? 0);
const perSnap = (await q("SELECT id FROM staff_commission_module_periods WHERE tenant_id=$1", [T])).rows.map((r) => Number(r.id));
let payId = 0; const KEY = `zz-clog-${RUN}`;
try {
  payId = Number((await q("INSERT INTO staff_commission_payments (tenant_id, staff_id, source_group, source_id, entry_key, movement_datetime, base_amount, percent_value, commission_amount, is_paid, entry_status) VALUES ($1,22,'pos',999998,$2,'2027-08-01 10:00:00',100,10,10,0,'active') RETURNING id", [T, KEY])).rows[0].id);

  // L1: pay respinto (id inesistente) -> nessuna voce
  await api({ action: "pay", id: "999999" });
  await sleep(400);
  check("L1 pay respinto -> nessuna voce", (await fresh()).length === 0, "");

  // L2: pay ok -> commissioni/paga
  const p1 = await api({ action: "pay", id: String(payId) });
  await sleep(500);
  let rows = await fresh();
  check("L2 pay loggato: 'Commissione #id segnata pagata'", p1.j?.ok === true && rows.length === 1 && rows[0].module === "commissioni" && rows[0].action === "paga" && rows[0].label === `Commissione #${payId} segnata pagata`, JSON.stringify(rows));

  // L3: toggle su entry_key -> 'da pagare' (modifica) con entry_key nei details
  const t1 = await api({ action: "toggle_commission_paid", entry_key: KEY, mark_paid: "0" });
  await sleep(500);
  rows = await fresh();
  let det = {}; try { det = JSON.parse(String(rows[1]?.details_json ?? "{}")); } catch {}
  check("L3 toggle loggato: 'Commissione segnata da pagare' + entry_key nei details", t1.j?.ok === true && rows.length === 2 && rows[1].action === "modifica" && rows[1].label === "Commissione segnata da pagare" && det.entry_key === KEY, JSON.stringify({ r: rows[1], det }));

  // L4: modulo ON -> 'attivato' (riattiva); poi OFF -> 'disattivato'
  const m1 = await api({ action: "save_module_settings", enabled: "1" });
  const m2 = await api({ action: "save_module_settings", enabled: "0" });
  await sleep(500);
  rows = await fresh();
  check("L4 modulo ON/OFF loggati", m1.j?.ok === true && m2.j?.ok === true && rows.length === 4 && rows[2].label === "Modulo commissioni attivato" && rows[2].action === "riattiva" && rows[3].label === "Modulo commissioni disattivato" && rows[3].action === "disattiva", JSON.stringify(rows.slice(2).map((r) => `${r.action}:${r.label}`)));

  // L5: save settings rows vuote -> voce '(0)' (wiring)
  const s1 = await api({ action: "save_commission_settings", rows_json: "{}" });
  await sleep(500);
  rows = await fresh();
  check("L5 save settings loggato: 'Salvate impostazioni commissioni operatori (0)'", s1.j?.ok === true && rows.length === 5 && rows[4].label === "Salvate impostazioni commissioni operatori (0)", JSON.stringify(rows[4] ?? null));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (payId) await q("DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2", [T, payId]).catch(() => {});
  // Trappola 5: rimuovo SOLO i periodi modulo nuovi + restore is_enabled.
  await q(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1${perSnap.length ? ` AND id NOT IN (${perSnap.join(",")})` : ""}`, [T]).catch(() => {});
  await q("UPDATE staff_commission_module_settings SET is_enabled=$2 WHERE tenant_id=$1 AND id=1", [T, mod0]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM staff_commission_payments WHERE tenant_id=$1 AND entry_key LIKE 'zz-clog-%')::int p,(SELECT COUNT(*) FROM staff_commission_module_periods WHERE tenant_id=$1)::int per,(SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=$1 AND id=1)::int en,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.p === 0 && fin.per === perSnap.length && fin.en === mod0 && fin.l === 0;
  console.log(`CLEANUP: pay=${fin.p} periods=${fin.per}/${perSnap.length} enabled=${fin.en}/${mod0} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
