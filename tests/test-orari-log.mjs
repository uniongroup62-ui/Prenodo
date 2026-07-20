// Orari — log su chiusure/straordinari (miglioria 2026-07-17): closure_save/
// delete_range + exception_save/delete_range loggano SOLO dopo il successo
// (module 'orari', label con range d/m/Y); errori NON loggano.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 51;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["hours.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oLogs = async () => (await q("SELECT id, action, label, location_id FROM activity_logs WHERE tenant_id=$1 AND module='orari' ORDER BY id", [T])).rows;
const baseIds = new Set((await oLogs()).map((r) => Number(r.id)));
const fresh = async () => (await oLogs()).filter((r) => !baseIds.has(Number(r.id)));
const tracked = new Set();
try {
  // L1: chiusura range -> 'Salvata chiusura 05/09/2027 - 07/09/2027' (crea, sede 51)
  const c1 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-09-05", date_to: "2027-09-07", kind: "Ferie" });
  await sleep(1500);
  let rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L1 closure_save logga range d/m/Y con sede", c1.j?.ok === true && rows.length === 1 && rows[0].label === "Salvata chiusura 05/09/2027 - 07/09/2027" && rows[0].action === "crea" && Number(rows[0].location_id) === LOC, JSON.stringify(rows));

  // L2: chiusura in ERRORE (conflitto con se stessa? no — data invalida) -> nessun log
  const c2 = await api({ action: "closure_save", location_id: String(LOC), date_from: "2027-13-40" });
  await sleep(1200);
  rows = await fresh();
  check("L2 closure_save in errore NON logga", c2.j?.ok !== true && rows.length === 1, `rows=${rows.length}`);

  // L3: straordinario singola data -> 'Salvato straordinario 10/09/2027'
  const e1 = await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-09-10", opens: "10:00", closes: "14:00" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L3 exception_save logga singola data", e1.j?.ok === true && rows.length === 2 && rows.some((r) => r.label === "Salvato straordinario 10/09/2027" && r.action === "crea"), JSON.stringify(rows.map((r) => r.label)));

  // L4: straordinario su data CHIUSA -> errore, nessun log
  const e2 = await api({ action: "exception_save", location_id: String(LOC), date_from: "2027-09-05", opens: "10:00", closes: "14:00" });
  await sleep(1200);
  rows = await fresh();
  check("L4 exception_save bloccato NON logga", e2.j?.ok !== true && rows.length === 2, `rows=${rows.length}`);

  // L5: delete range chiusure + straordinario -> 2 log 'elimina'
  const d1 = await api({ action: "closure_delete_range", location_id: String(LOC), from: "2027-09-05", to: "2027-09-07", reason: "Ferie" });
  const d2 = await api({ action: "exception_delete_range", location_id: String(LOC), from: "2027-09-10", to: "2027-09-10" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L5 delete_range loggano 'Eliminata chiusura ...' / 'Eliminato straordinario ...'", d1.j?.ok === true && d2.j?.ok === true && rows.length === 4 && rows.some((r) => r.label === "Eliminata chiusura 05/09/2027 - 07/09/2027" && r.action === "elimina") && rows.some((r) => r.label === "Eliminato straordinario 10/09/2027" && r.action === "elimina"), JSON.stringify(rows.map((r) => r.label)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("DELETE FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date BETWEEN '2027-09-05' AND '2027-09-07'", [T, LOC]).catch(() => {});
  await q("DELETE FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2 AND date='2027-09-10'", [T, LOC]).catch(() => {});
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = (await fresh()).length;
  const res = (await q("SELECT (SELECT COUNT(*) FROM closures WHERE tenant_id=$1 AND location_id=$2)::int c,(SELECT COUNT(*) FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2)::int e", [T, LOC])).rows[0];
  const okBase = res.c === 0 && res.e === 0 && left === 0;
  console.log(`CLEANUP: sede51 c=${res.c} e=${res.e} logResidui=${left} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
