// Risorse migliorie 2026-07-17: log attività su crea/modifica/elimina risorsa
// (module 'risorse'); nessun log su azione bloccata (delete con servizi).
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["resources.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let resId = 0, srSeeded = false;
try {
  const s1 = await api({ action: "resource_save", id: "0", name: `ZZ RisLog ${RUN}`, description: "", qty_total: "3", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 3 }]) });
  resId = Number(s1.j?.resource?.id ?? 0);
  check("S1 create ok", s1.j?.ok === true && resId > 0, JSON.stringify(s1.j?.error ?? ""));
  await api({ action: "resource_save", id: String(resId), name: `ZZ RisLog ${RUN} bis`, description: "", qty_total: "4", locations_json: JSON.stringify([{ locationId: LOC, isEnabled: true, qtyTotal: 4 }]) });
  // delete BLOCCATA (servizio collegato) -> nessun log
  await q("INSERT INTO service_resources (tenant_id, service_id, resource_id, qty_required) VALUES ($1,$2,$3,1)", [T, SVC, resId]); srSeeded = true;
  const dBlock = await api({ action: "resource_delete", id: String(resId) });
  check("S2 delete bloccata dai servizi (guardia verbatim)", dBlock.j?.ok !== true && /associata a uno o più servizi/.test(String(dBlock.j?.error ?? "")), JSON.stringify(dBlock.j?.error));
  await q("DELETE FROM service_resources WHERE tenant_id=$1 AND resource_id=$2", [T, resId]); srSeeded = false;
  const d1 = await api({ action: "resource_delete", id: String(resId) });
  check("S3 delete ok", d1.j?.ok === true, JSON.stringify(d1.j?.error ?? ""));

  await new Promise((r) => setTimeout(r, 800));
  const logs = (await q("SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND module='risorse' AND entity_id=$2 ORDER BY id ASC", [T, resId])).rows;
  check("L1 log: creata con qtà", logs.some((r) => r.action === "crea" && r.label === `Creata risorsa "ZZ RisLog ${RUN}" (qtà 3)`), JSON.stringify(logs.map((r) => r.label)));
  check("L2 log: modificata con qtà", logs.some((r) => r.action === "modifica" && r.label === `Modificata risorsa "ZZ RisLog ${RUN} bis" (qtà 4)`), "");
  check("L3 log: eliminata; NESSUN log dal delete bloccato (3 righe totali)", logs.some((r) => r.action === "elimina" && r.label === `Eliminata risorsa #${resId}`) && logs.length === 3, `n=${logs.length}`);
  const lg = await fetch(`${BASE}/api/manage/logs?slug=${SLUG}&module=risorse`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("L4 pagina Log: righe module=risorse", (lg.rows || []).some((r) => r.module === "risorse"), `n=${(lg.rows || []).length}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (srSeeded) await q("DELETE FROM service_resources WHERE tenant_id=$1 AND resource_id=$2", [T, resId]).catch(() => {});
  if (resId) {
    await q("DELETE FROM resource_locations WHERE tenant_id=$1 AND resource_id=$2", [T, resId]).catch(() => {});
    await q("DELETE FROM resources WHERE tenant_id=$1 AND id=$2", [T, resId]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='risorse' AND entity_id=$2", [T, resId]).catch(() => {});
  }
  const left = Number((await q1("SELECT COUNT(*) n FROM resources WHERE tenant_id=$1 AND name LIKE $2", [T, `ZZ RisLog%`])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
