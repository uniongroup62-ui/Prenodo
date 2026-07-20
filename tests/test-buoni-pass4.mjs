// Buoni pass 4 (2026-07-18) — FIX classe TZ: created_at (new), updated_at
// (audit edit, ora VINCE sul trigger app_touch fedele a MySQL), cancelled_at
// (disattiva + fallback del soft-delete), deleted_at (soft) -> businessNowDateTime.
// P1-P4: create/edit/disattiva/hard-delete con timestamp Roma.
// Payload create: coupon_location_ids obbligatorio ('Seleziona almeno una sede abilitata.').
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgm = require("pg");
const url = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m)[1].trim();
const SLUG = "centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["coupons.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/coupons?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const pool = new pgm.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const romeMs = () => { const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); return new Date(s.replace(" ", "T")).getTime(); };
const dm = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeMs()) / 60000;
const RUN = String(Date.now()).slice(-6);
const wm = Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=25")).rows[0].m);
let cid = 0;
try {
  const c = await api({ action: "save", id: "0", code: `ZZTZ${RUN}`, discount_value: "10", coupon_location_ids: "21" });
  const row = (await pool.query("SELECT id, created_at::text ca FROM coupons WHERE tenant_id=25 AND code=$1", [`ZZTZ${RUN}`])).rows[0];
  cid = Number(row?.id ?? 0);
  check("P1 create: created_at Roma", !!row && dm(row.ca) < 5, JSON.stringify({ ca: row?.ca, e: c?.error }));
  await api({ action: "save", id: String(cid), code: `ZZTZ${RUN}`, discount_value: "20", coupon_location_ids: "21" });
  const r2 = (await pool.query("SELECT updated_at::text ua FROM coupons WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("P2 edit: updated_at audit Roma (vince sul trigger)", !!r2?.ua && dm(r2.ua) < 5, JSON.stringify(r2));
  await api({ action: "cancel", id: String(cid) });
  const r3 = (await pool.query("SELECT is_active, cancelled_at::text cca FROM coupons WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("P3 disattiva: cancelled_at Roma", Number(r3?.is_active) === 0 && dm(r3?.cca) < 5, JSON.stringify(r3));
  const del = await api({ action: "delete", id: String(cid) });
  const r4 = (await pool.query("SELECT COUNT(*) n FROM coupons WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("P4 hard delete (mai usato)", Number(r4.n) === 0 && del?.mode === "hard", JSON.stringify(del?.mode ?? del?.error));
  if (Number(r4.n) === 0) cid = 0;
} catch (e) { check("EXCEPTION", false, e.stack || e.message); }
finally {
  if (cid) { await pool.query("DELETE FROM coupon_locations WHERE tenant_id=25 AND coupon_id=$1", [cid]).catch(() => {}); await pool.query("DELETE FROM coupons WHERE tenant_id=25 AND id=$1", [cid]).catch(() => {}); }
  await pool.query("DELETE FROM activity_logs WHERE tenant_id=25 AND id>$1", [wm]).catch(() => {});
  const fin = (await pool.query("SELECT (SELECT COUNT(*) FROM coupons WHERE tenant_id=25 AND code LIKE 'ZZ%')::int c,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=25 AND id>$1)::int l", [wm])).rows[0];
  const clean = fin.c === 0 && fin.l === 0;
  console.log(`CLEANUP: couponZZ=${fin.c} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
