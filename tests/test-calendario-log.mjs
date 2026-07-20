// Calendario — miglioria log attività (2026-07-18): note_save (crea/modifica)
// e note_delete loggano nel modulo 'calendario'. Segnali DOPO il successo:
// validazioni respinte e delete di nota inesistente NON loggano.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["calendar.view", "appointments.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function apiPost(body) {
  const res = await fetch(`${BASE}/api/manage/calendar?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const freshLogs = () => q("SELECT module, action, entity_type, entity_id, label, location_id FROM activity_logs WHERE tenant_id=$1 AND id>$2 ORDER BY id", [T, logWatermark]);
const noteIds = [];
try {
  // L1: validazione respinta -> nessuna voce
  await apiPost({ action: "note_save", note_date: "2027-06-15", note_text: "   " });
  await sleep(400);
  let rows = (await freshLogs()).rows;
  check("L1 validazione respinta -> nessuna voce", rows.length === 0, JSON.stringify(rows));

  // L2: create -> calendario/crea 'Salvata nota calendario del 15/6/2027'
  const c1 = await apiPost({ action: "note_save", note_date: "2027-06-15", title: `ZZ log ${RUN}`, note_text: `t ${RUN}` });
  const nid = Number(c1.j?.note?.id ?? 0);
  if (nid) noteIds.push(nid);
  await sleep(500);
  rows = (await freshLogs()).rows;
  const l2 = rows.find((r) => Number(r.entity_id) === nid);
  check("L2 create loggato: calendario/crea, label d/m/Y, sede 21", c1.j?.ok === true && rows.length === 1 && !!l2 && l2.module === "calendario" && l2.action === "crea" && l2.entity_type === "calendar_note" && l2.label === "Salvata nota calendario del 15/6/2027" && Number(l2.location_id) === LOC, JSON.stringify(rows));

  // L3: edit -> calendario/modifica
  const c2 = await apiPost({ action: "note_save", id: String(nid), note_date: "2027-06-16", note_text: `t2 ${RUN}` });
  await sleep(500);
  rows = (await freshLogs()).rows;
  check("L3 edit loggato: azione modifica, data POST-edit 16/6/2027", c2.j?.ok === true && rows.length === 2 && rows[1].action === "modifica" && rows[1].label === "Salvata nota calendario del 16/6/2027", JSON.stringify(rows.map((r) => `${r.action}:${r.label}`)));

  // L4: delete nota INESISTENTE (idempotente ok) -> nessuna voce
  const d0 = await apiPost({ action: "note_delete", id: "999999" });
  await sleep(400);
  rows = (await freshLogs()).rows;
  check("L4 delete inesistente: ok senza voce", d0.j?.ok === true && rows.length === 2, String(rows.length));

  // L5: delete reale -> calendario/elimina con data
  const d1 = await apiPost({ action: "note_delete", id: String(nid) });
  await sleep(500);
  rows = (await freshLogs()).rows;
  const gone = await q1("SELECT id FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, nid]);
  if (!gone) noteIds.length = 0;
  check("L5 delete loggato: elimina, 'Eliminata nota calendario del 16/6/2027'", d1.j?.ok === true && !gone && rows.length === 3 && rows[2].action === "elimina" && rows[2].label === "Eliminata nota calendario del 16/6/2027", JSON.stringify(rows[2] ?? null));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of noteIds) await q("DELETE FROM calendar_notes WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const notes = Number((await q1("SELECT COUNT(*) n FROM calendar_notes WHERE tenant_id=$1", [T]))?.n);
  const logs = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]))?.n);
  console.log(`CLEANUP: notes=${notes} logs=${logs} -> ${notes === 0 && logs === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && notes === 0 && logs === 0 ? 0 : 1);
}
