// Profilo attività — log su upload branding + posizione (miglioria 2026-07-17):
// upload logo/copertina e save posizione loggano SOLO dopo il successo
// (module 'impostazioni'); errori/guardie NON loggano.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["settings.general"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function upload(fields) {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG }, body: form });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const impLogs = async () => (await q("SELECT id, action, label FROM activity_logs WHERE tenant_id=$1 AND module='impostazioni' ORDER BY id", [T])).rows;
const baseIds = new Set((await impLogs()).map((r) => Number(r.id)));
const fresh = async () => (await impLogs()).filter((r) => !baseIds.has(Number(r.id)));
const tracked = new Set();
const snap = await q1("SELECT id, logo_path, logo_position_x, logo_position_y FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
try {
  await q("UPDATE businesses SET logo_path=NULL WHERE tenant_id=$1 AND id=$2", [T, snap.id]);

  // L1: upload FALLITO (garbage) -> nessun log
  await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([Buffer.from("junk")], "x.png", { type: "image/png" })]]);
  await sleep(1200);
  let rows = await fresh();
  check("L1 upload fallito NON logga", rows.length === 0, JSON.stringify(rows));

  // L2: upload ok -> 'Caricato logo attività'
  const u = await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([PNG], "x.png", { type: "image/png" })]]);
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L2 upload ok logga 'Caricato logo attività'", u.j?.message === "Logo salvato" && rows.length === 1 && rows[0].label === "Caricato logo attività" && rows[0].action === "modifica", JSON.stringify(rows));

  // L3: posizione ok -> 'Salvata posizione logo'
  const p = await api({ action: "save_logo_position", kind: "logo", logo_position_x: "40", logo_position_y: "60" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L3 posizione ok logga 'Salvata posizione logo'", p.j?.message === "Posizione logo salvata" && rows.length === 2 && rows.some((r) => r.label === "Salvata posizione logo"), JSON.stringify(rows.map((r) => r.label)));

  // L4: guardia upload con logo presente -> nessun log nuovo
  await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([PNG], "y.png", { type: "image/png" })]]);
  await sleep(1200);
  rows = await fresh();
  check("L4 upload bloccato dalla guardia NON logga", rows.length === 2, `rows=${rows.length}`);

  // L5: delete (già strumentata) -> 'Rimosso logo attività'
  const d = await api({ action: "delete_logo", kind: "logo" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L5 delete logga 'Rimosso logo attività' (pre-esistente)", d.j?.message === "Logo rimosso" && rows.length === 3 && rows.some((r) => r.label === "Rimosso logo attività" && r.action === "elimina"), JSON.stringify(rows.map((r) => r.label)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("UPDATE businesses SET logo_path=$3, logo_position_x=$4, logo_position_y=$5 WHERE tenant_id=$1 AND id=$2", [T, snap.id, snap.logo_path, snap.logo_position_x, snap.logo_position_y]).catch(() => {});
  await api({ action: "save_logo_position", kind: "logo", logo_position_x: String(snap.logo_position_x ?? 50), logo_position_y: String(snap.logo_position_y ?? 50) }).catch(() => {});
  await sleep(1200);
  (await fresh()).forEach((r) => tracked.add(Number(r.id)));
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = (await fresh()).length;
  const fin = await q1("SELECT logo_path, logo_position_x x, logo_position_y y FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  const okBase = (fin?.logo_path ?? null) === (snap.logo_path ?? null) && Number(fin?.x) === Number(snap.logo_position_x) && Number(fin?.y) === Number(snap.logo_position_y);
  console.log(`CLEANUP: businesses=${okBase ? "OK" : JSON.stringify(fin)} logResidui=${left} -> ${okBase && left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase && left === 0 ? 0 : 1);
}
