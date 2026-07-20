// Automazioni — log save (miglioria 2026-07-17): il save della pagina logga
// nel modulo 'automazioni' con il riepilogo dei toggle/ore; errori non loggano.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["automation.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/automation?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settingsSnap = await q1("SELECT * FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
const baseIds = new Set((await q("SELECT id FROM activity_logs WHERE tenant_id=$1 AND module='automazioni'", [T])).rows.map((r) => Number(r.id)));
const fresh = async () => (await q("SELECT id, action, label FROM activity_logs WHERE tenant_id=$1 AND module='automazioni' ORDER BY id", [T])).rows.filter((r) => !baseIds.has(Number(r.id)));
const tracked = new Set();
try {
  const s1 = await api({ action: "save", reminder_enabled: "1", reminder_hours: "12", sms_reminder_enabled: "0", approved_enabled: "1", modified_enabled: "1", rejected_enabled: "1" });
  await sleep(1500);
  let rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L1 save logga il riepilogo (email 12h, SMS OFF)", s1.j?.ok === true && rows.length === 1 && rows[0].label === "Salvate impostazioni automazioni (promemoria email 12h, SMS OFF)" && rows[0].action === "modifica", JSON.stringify(rows));
  const s2 = await api({ action: "save", reminder_enabled: "0", reminder_hours: "24", sms_reminder_enabled: "1", sms_reminder_hours: "6" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L2 save logga (email OFF, SMS 6h)", s2.j?.ok === true && rows.length === 2 && rows.some((r) => r.label === "Salvate impostazioni automazioni (promemoria email OFF, SMS 6h)"), JSON.stringify(rows.map((r) => r.label)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (settingsSnap) {
    const cols = Object.keys(settingsSnap).filter((k) => k !== "id" && k !== "tenant_id");
    const sets = cols.map((c, i) => `"${c}" = $${i + 3}`).join(", ");
    await q(`UPDATE automation_settings SET ${sets} WHERE tenant_id=$1 AND id=$2`, [T, settingsSnap.id, ...cols.map((c) => settingsSnap[c])]).catch(() => {});
  }
  await q("DELETE FROM reminders WHERE tenant_id=$1 AND status='pending'", [T]).catch(() => {});
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = (await fresh()).length;
  const fin = await q1("SELECT (SELECT COUNT(*) FROM reminders WHERE tenant_id=$1)::int r,(SELECT reminder_hours FROM automation_settings WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1)::int h", [T]);
  const okBase = left === 0 && fin.r === 0 && fin.h === Number(settingsSnap?.reminder_hours);
  console.log(`CLEANUP: reminders=${fin.r} logResidui=${left} settings=${fin.h} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
