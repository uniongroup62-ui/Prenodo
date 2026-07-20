// Cabine log attività (miglioria 2026-07-17): cabins_save/cabin_delete loggano
// SOLO dopo il successo (module 'cabine'); errori/blocchi NON loggano; etichetta
// 'Cabine' renderizzata nella pagina Log (Playwright DOM).
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const { chromium } = require("playwright");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["cabins.manage", "logs.view", "logs.deletions"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const COOKIE_VAL = `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const cookie = `beautysuite_session_t_${SLUG}=${COOKIE_VAL}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const save = (namesIds, locId = LOC) => api({ action: "cabins_save", location_id: String(locId || ""), cabins_count: String(namesIds.length), cabin_names_json: JSON.stringify(namesIds.map(([n]) => n)), cabin_ids_json: JSON.stringify(namesIds.map(([, i]) => i)) });
const cabLogs = async () => (await q("SELECT id, action, label, location_id, user_label FROM activity_logs WHERE tenant_id=$1 AND module='cabine' ORDER BY id", [T])).rows;
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const NA = `ZZ CabLog ${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idA = 0, browser = null;
const trackedLogIds = new Set();
const baseLogIds = new Set((await cabLogs()).map((r) => Number(r.id)));
const fresh = async () => (await cabLogs()).filter((r) => !baseLogIds.has(Number(r.id)));
try {
  // L1: save ok -> 1 riga 'modifica' con conteggio e sede
  const l1 = await save([["cabina1", 9], [NA, 0]]);
  idA = Number((await q1("SELECT id FROM cabins WHERE tenant_id=$1 AND name=$2", [T, NA]))?.id ?? 0);
  await sleep(1500); // logActivity è fire-and-forget
  let rows = await fresh();
  rows.forEach((r) => trackedLogIds.add(Number(r.id)));
  check("L1 cabins_save ok logga 'Salvate cabine (2 cabine)' sede 21", l1.j?.ok === true && rows.length === 1 && rows[0].action === "modifica" && rows[0].label === "Salvate cabine (2 cabine)" && Number(rows[0].location_id) === LOC && rows[0].user_label === "luca", JSON.stringify(rows));

  // L2: save in ERRORE (nome vuoto) -> nessuna riga nuova
  const l2 = await save([["cabina1", 9], ["", idA]]);
  await sleep(1200);
  rows = await fresh();
  check("L2 save in errore NON logga", l2.j?.ok === false && rows.length === 1, `rows=${rows.length}`);

  // L3: save BLOCCATO dai blockers (rimozione cabina1) -> nessuna riga nuova
  const l3 = await save([[NA, idA]]);
  await sleep(1200);
  rows = await fresh();
  check("L3 save bloccato dai blockers NON logga", l3.j?.ok === false && rows.length === 1, `rows=${rows.length}`);

  // L4: delete BLOCCATA (cabina1 collegata al servizio 9) -> nessuna riga
  const l4 = await api({ action: "cabin_delete", id: "9", location_id: String(LOC) });
  await sleep(1200);
  rows = await fresh();
  check("L4 delete bloccata NON logga", l4.j?.ok === false && rows.length === 1, `rows=${rows.length}`);

  // L5: delete ok -> riga 'elimina'
  const l5 = await api({ action: "cabin_delete", id: String(idA), location_id: String(LOC) });
  await sleep(1500);
  rows = await fresh();
  rows.forEach((r) => trackedLogIds.add(Number(r.id)));
  const del = rows.find((r) => r.action === "elimina");
  check("L5 cabin_delete ok logga 'Eliminata cabina #id'", l5.j?.ok === true && rows.length === 2 && del?.label === `Eliminata cabina #${idA}`, JSON.stringify(rows.map((r) => r.label)));

  // L6: DOM pagina Log — modulo 'Cabine' renderizzato con le due voci
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: `beautysuite_session_t_${SLUG}`, value: COOKIE_VAL, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${SLUG}/log?module=cabine`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('table tbody tr:has-text("Salvate cabine")', { timeout: 30000 });
  const bodyTxt = await page.locator("table tbody").innerText();
  check("L6 pagina Log filtro cabine: etichetta 'Cabine' + entrambe le voci", bodyTxt.includes("Cabine") && bodyTxt.includes("Salvate cabine (2 cabine)") && bodyTxt.includes(`Eliminata cabina #${idA}`), JSON.stringify(bodyTxt.slice(0, 200)));
  const badgeDel = await page.locator(`table tbody tr:has-text("Eliminata cabina #${idA}") .badge.text-bg-danger`).count();
  check("L7 badge ROSSO sull'azione 'elimina'", badgeDel >= 1, `n=${badgeDel}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (idA) await q("DELETE FROM cabins WHERE tenant_id=$1 AND id=$2", [T, idA]).catch(() => {});
  await q("UPDATE cabins SET position=1 WHERE tenant_id=$1 AND id=9", [T]).catch(() => {});
  for (const lid of trackedLogIds) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, lid]).catch(() => {});
  const leftLogs = (await cabLogs()).filter((r) => !baseLogIds.has(Number(r.id))).length;
  const fin = (await q("SELECT id, is_active, location_id FROM cabins WHERE tenant_id=$1 ORDER BY id", [T])).rows;
  const okBase = JSON.stringify(fin.map((r) => [r.id, r.is_active, r.location_id])) === JSON.stringify([[9, 1, 21], [10, 0, 21], [45, 1, 51]]);
  console.log(`CLEANUP: baseline=${okBase ? "OK" : JSON.stringify(fin)} logResidui=${leftLogs} -> ${okBase && leftLogs === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase && leftLogs === 0 ? 0 : 1);
}
