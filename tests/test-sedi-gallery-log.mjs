// Sedi — log gallery (miglioria 2026-07-17): upload/delete/move della gallery
// sede loggano SOLO dopo il successo (module 'impostazioni'); errori NON loggano.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["settings.location"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function upload(files) {
  const form = new FormData();
  form.append("action", "location_gallery_upload");
  form.append("location_id", String(LOC));
  for (const f of files) form.append("location_gallery_images", f);
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
let imgIds = [];
try {
  // L1: upload fallito -> nessun log
  await upload([new File([Buffer.from("junk")], "x.png", { type: "image/png" })]);
  await sleep(1200);
  let rows = await fresh();
  check("L1 upload fallito NON logga", rows.length === 0, JSON.stringify(rows));

  // L2: upload 2 foto ok -> 'Caricate foto gallery sede #21 (2)' (crea)
  const u = await upload([new File([PNG], "a.png", { type: "image/png" }), new File([PNG], "b.png", { type: "image/png" })]);
  imgIds = (await q("SELECT id FROM location_gallery_images WHERE tenant_id=$1 AND location_id=$2 ORDER BY id DESC LIMIT 2", [T, LOC])).rows.map((r) => Number(r.id));
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L2 upload ok logga 'Caricate foto gallery sede #21 (2)'", u.j?.message === "Foto gallery sede caricate" && rows.length === 1 && rows[0].label === "Caricate foto gallery sede #21 (2)" && rows[0].action === "crea", JSON.stringify(rows));

  // L3: move -> 'Riordinata gallery sede #21' (sposta)
  const m = await api({ action: "location_gallery_move", location_id: String(LOC), gallery_image_id: String(imgIds[0]), direction: "up" });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  check("L3 move logga 'Riordinata gallery sede #21' (sposta)", m.j?.ok !== false && rows.length === 2 && rows.some((r) => r.label === "Riordinata gallery sede #21" && r.action === "sposta"), JSON.stringify(rows.map((r) => r.label)));

  // L4: delete FALLITA (foto inesistente) -> nessun log nuovo
  const dBad = await api({ action: "location_gallery_delete", location_id: String(LOC), gallery_image_id: "999999" });
  await sleep(1200);
  rows = await fresh();
  check("L4 delete fallita NON logga", String(dBad.j?.error ?? "").includes("Foto gallery non trovata") && rows.length === 2, `rows=${rows.length}`);

  // L5: delete ok x2 -> 'Rimossa foto gallery sede #21'
  for (const id of imgIds) await api({ action: "location_gallery_delete", location_id: String(LOC), gallery_image_id: String(id) });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => tracked.add(Number(r.id)));
  const delRows = rows.filter((r) => r.label === "Rimossa foto gallery sede #21" && r.action === "elimina");
  check("L5 delete ok logga 'Rimossa foto gallery sede #21' (x2)", delRows.length === 2 && rows.length === 4, JSON.stringify(rows.map((r) => r.label)));
  imgIds = [];
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of imgIds) await q("DELETE FROM location_gallery_images WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = (await fresh()).length;
  const gal = Number((await q1("SELECT COUNT(*) n FROM location_gallery_images WHERE tenant_id=$1", [T]))?.n);
  console.log(`CLEANUP: gallery=${gal} logResidui=${left} -> ${gal === 0 && left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && gal === 0 && left === 0 ? 0 : 1);
}
