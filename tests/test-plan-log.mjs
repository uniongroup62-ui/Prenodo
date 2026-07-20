// Pianifica — miglioria log attività (2026-07-18): plan_create logga la voce
// riassuntiva del batch ("Pianificati N appuntamenti", ids nei details) DOPO
// il successo; un create fallito/0 non logga.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["appointments.plan", "calendar.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/appointments?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let cid = 0; const created = [];
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ PlanLog ${RUN}`, `zz.planlog.${RUN}@example.com`, LOC])).rows[0].id);

  const PLAN = {
    action: "plan_create", client_id: String(cid),
    new_full_name: "", new_phone: "", new_email: "",
    service_ids: "9", repeat: "2", staff_id: "0",
    staff_map: JSON.stringify({ 9: 22 }), cabin_map: JSON.stringify({}),
    recurrence: "weekly", weekdays: "1",
    start_date: "2027-07-05", time_from: "09:00", time_to: "12:00",
    location_id: "21",
  };
  const p1 = await api(PLAN);
  const ids = (p1.j?.details ?? []).filter((d) => d.ok).map((d) => Number(d.appointmentId)).filter((n) => n > 0);
  created.push(...ids);
  check("PRE plan_create ok (2 create)", p1.j?.ok === true && Number(p1.j?.created) === 2 && ids.length === 2, JSON.stringify({ ok: p1.j?.ok, c: p1.j?.created, e: p1.j?.error }));

  await sleep(500);
  const rows = (await q("SELECT action, label, details_json FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, logWatermark])).rows;
  const lg = rows.find((r) => String(r.label).startsWith("Pianificati"));
  let detIds = [];
  try { detIds = JSON.parse(String(lg?.details_json ?? "{}")).ids ?? []; } catch {}
  check("L1 voce riassuntiva 'Pianificati 2 appuntamenti' con ids nei details", rows.length === 1 && !!lg && lg.action === "crea" && lg.label === "Pianificati 2 appuntamenti" && JSON.stringify(detIds) === JSON.stringify(ids), JSON.stringify({ rows: rows.map((r) => r.label), detIds, ids }));

  // L2: create fallita (finestra troppo corta -> validazione) non logga
  const wm2 = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
  const p2 = await api({ ...PLAN, time_from: "09:00", time_to: "09:10" });
  await sleep(400);
  const n2 = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, wm2]))?.n);
  check("L2 plan_create respinto -> nessuna voce", p2.j?.ok !== true && n2 === 0, JSON.stringify({ ok: p2.j?.ok, e: String(p2.j?.error ?? "").slice(0, 60), n2 }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of created) {
    for (const t of ["appointment_services", "appointment_staff", "appointment_locations", "appointment_segments", "reminders"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND appointment_id=$2`, [T, id]).catch(() => {});
    }
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.a === 10 && fin.c === 5 && fin.l === 0;
  console.log(`CLEANUP: appts=${fin.a}/10 clients=${fin.c}/5 logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
