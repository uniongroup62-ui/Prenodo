// Omaggi pass 2 (2026-07-17) — race riscatto: due riscatti PARALLELI della
// stessa unità residua -> esattamente uno passa (insert guardato, il legacy
// serializzava con FOR UPDATE); il ledger non supera mai qty totale.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21, SVC = 9;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["gifts.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/gifts?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let cid = 0, giftId = 0, instId = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ OmgP2 ${RUN}`])).rows[0].id);
  giftId = Number((await q(`INSERT INTO gifts (tenant_id, name, eligibility, reward_items_json, repeatable, active, valid_from, valid_to, expires_after_days, created_at)
    VALUES ($1,$2,'all','[{"type":"service","service_id":${SVC},"qty":1}]',0,1, NOW() - interval '1 day', NOW() + interval '30 days', 15, NOW()) RETURNING id`, [T, `ZZ OmgP2 Camp ${RUN}`])).rows[0].id);
  instId = Number((await q("INSERT INTO gift_instances (tenant_id, gift_id, client_id, state, is_active, unlocked_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,'disponibile',1,NOW(),NOW() + interval '10 days',NOW(),NOW()) RETURNING id", [T, giftId, cid])).rows[0].id);

  // A1: due riscatti PARALLELI dell'UNICA unità -> esattamente 1 ok
  const [r1, r2] = await Promise.all([
    api({ action: "redeem_instance_partial", instance_id: String(instId), redeem_qty_json: JSON.stringify({ "0": 1 }), redeem_note: "zz par1" }),
    api({ action: "redeem_instance_partial", instance_id: String(instId), redeem_qty_json: JSON.stringify({ "0": 1 }), redeem_note: "zz par2" }),
  ]);
  const oks = [r1, r2].filter((r) => r.j?.ok === true || /Riscatto|riscattato/.test(String(r.j?.message ?? ""))).length;
  const net = Number((await q1("SELECT COALESCE(SUM(CASE WHEN type='redeem' THEN qty WHEN type='cancel' THEN -qty ELSE 0 END),0) s FROM gift_transactions WHERE tenant_id=$1 AND instance_id=$2", [T, instId])).s);
  check("A1 parallelo 1+1 su qty 1: ledger MAI oltre il totale (net<=1)", net <= 1, `net=${net} esiti=${JSON.stringify([r1.j?.message ?? r1.j?.error, r2.j?.message ?? r2.j?.error])}`);
  check("A2 almeno un riscatto riuscito e uno rifiutato", oks === 1, `oks=${oks}`);
  const st = await q1("SELECT state, is_active FROM gift_instances WHERE tenant_id=$1 AND id=$2", [T, instId]);
  check("A3 istanza chiusa correttamente (riscattato, residuo 0)", st.state === "riscattato" && Number(st.is_active) === 0, JSON.stringify(st));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (instId) {
    await q("DELETE FROM gift_transactions WHERE tenant_id=$1 AND instance_id=$2", [T, instId]).catch(() => {});
    await q("DELETE FROM gift_instances WHERE tenant_id=$1 AND id=$2", [T, instId]).catch(() => {});
  }
  if (giftId) await q("DELETE FROM gifts WHERE tenant_id=$1 AND id=$2", [T, giftId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM gift_instances WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM gifts WHERE tenant_id=$1 AND id=$3)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$4) n", [T, instId || 0, giftId || 0, cid || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
