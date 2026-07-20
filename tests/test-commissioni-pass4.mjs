// Commissioni pass 4 (2026-07-18) — FIX classe TZ: paid_at di action=pay
// (markDbCommissionPaid era Date al driver) e currentMonthRange del default
// dashboard (mese del SERVER -> mese di Roma; stessa classe, code-level).
// I confini periodo Roma erano già del pass Pagamenti 2 (suite 7.1 sanata).
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
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const diffMin = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeNowMs()) / 60000;

let payId = 0;
try {
  // Riga payments ZZ diretta (nessun enable: i periodi non vengono toccati).
  payId = Number((await q("INSERT INTO staff_commission_payments (tenant_id, staff_id, source_group, source_id, entry_key, movement_datetime, base_amount, percent_value, commission_amount, is_paid, entry_status) VALUES ($1,22,'pos',999999,'zz-pass4-'||$2,'2027-08-01 10:00:00',100,10,10,0,'active') RETURNING id", [T, String(Date.now())])).rows[0].id);
  const r = await fetch(`${BASE}/api/manage/commissions?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify({ action: "pay", id: String(payId) }) });
  const j = await r.json().catch(() => ({}));
  const row = await q1("SELECT is_paid, paid_at::text pa FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2", [T, payId]);
  check("P1 action=pay: is_paid=1 + paid_at in ORA DI ROMA (±5min)", j?.ok === true && Number(row?.is_paid) === 1 && diffMin(row?.pa) < 5, JSON.stringify({ ok: j?.ok, e: j?.error, row, d: row?.pa ? Math.round(diffMin(row.pa)) : null }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (payId) await q("DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2", [T, payId]).catch(() => {});
  const fin = await q1("SELECT COUNT(*)::int n FROM staff_commission_payments WHERE tenant_id=$1 AND entry_key LIKE 'zz-pass4-%'", [T]);
  console.log(`CLEANUP: residui=${fin.n} -> ${fin.n === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && fin.n === 0 ? 0 : 1);
}
