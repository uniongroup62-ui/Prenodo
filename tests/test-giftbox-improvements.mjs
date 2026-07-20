// Migliorie GiftBox 2026-07-16 (approvate): (1) paginazione 25 lista istanze,
// (2) badge 'Scade tra N giorni' (dati riga: status issued + expiresDate 14gg).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftbox.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const get = (qs) => fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}&${qs}`, { headers: { cookie } }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let tpl = 0;
try {
  tpl = Number((await db.query("INSERT INTO giftboxes (tenant_id, name, active, created_at) VALUES (25, $1, 1, NOW()) RETURNING id", [`ZZ GbPag${RUN}`])).rows[0].id);
  // 30 istanze + 1 in scadenza tra 5 giorni
  await db.query(`INSERT INTO giftbox_instances (tenant_id, giftbox_id, code, status, issued_at, points_cost, created_by, created_at, location_id, location_name)
    SELECT 25, $1, 'GBP-ZZ${RUN}-'||g, 'issued', NOW(), 0, 20, NOW(), 21, 'Sede1' FROM generate_series(1, 30) g`, [tpl]);
  await db.query(`INSERT INTO giftbox_instances (tenant_id, giftbox_id, code, status, issued_at, expires_at, points_cost, created_by, created_at, location_id, location_name)
    VALUES (25, $1, 'GBP-ZZ${RUN}-EXP', 'issued', NOW(), CURRENT_DATE + 5, 0, 20, NOW(), 21, 'Sede1')`, [tpl]);
  // === paginazione (filtro q sul codice del run) ===
  const p1 = await get(`action=manage_list&q=GBP-ZZ${RUN}&p=1`);
  const p2 = await get(`action=manage_list&q=GBP-ZZ${RUN}&p=2`);
  const noP = await get(`action=manage_list&q=GBP-ZZ${RUN}`);
  const s1 = new Set((p1.j.rows ?? []).map((x) => x.id));
  const overlap = (p2.j.rows ?? []).some((x) => s1.has(x.id));
  check("P1 p=1: 25 righe + totale 31 + pageSize 25", (p1.j.rows ?? []).length === 25 && Number(p1.j.totalCount) === 31 && Number(p1.j.pageSize) === 25, `rows=${(p1.j.rows ?? []).length} tot=${p1.j.totalCount}`);
  check("P2 p=2: 6 righe, zero overlap", (p2.j.rows ?? []).length === 6 && !overlap, `rows2=${(p2.j.rows ?? []).length}`);
  check("P3 senza ?p= storico (31, cap 200)", (noP.j.rows ?? []).length === 31, `rows=${(noP.j.rows ?? []).length}`);
  // === dati badge ===
  const expRow = (p1.j.rows ?? []).concat(p2.j.rows ?? []).find((x) => x.code === `GBP-ZZ${RUN}-EXP`);
  check("B1 riga in scadenza: status issued + expiresDate a 5gg", !!expRow && expRow.status === "issued" && /^\d{4}-\d{2}-\d{2}$/.test(String(expRow.expiresDate ?? "")), JSON.stringify(expRow ? { s: expRow.status, e: expRow.expiresDate } : null));
  const days = expRow ? Math.round((new Date(expRow.expiresDate + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : -1;
  check("B2 giorni = 5 (finestra 14)", days === 5, `days=${days}`);
  const html = await fetch(`http://localhost:3000/${SLUG}/giftbox`, { headers: { cookie } }).then((r) => r.text());
  let blob = html;
  for (const m of html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)) blob += await fetch(`http://localhost:3000${m[0]}`).then((r) => r.text()).catch(() => "");
  check("B3 bundle giftbox contiene i testi del badge", blob.includes("Scade domani") && blob.includes("Scade oggi"), "");
} finally {
  await db.query(`DELETE FROM giftbox_instances WHERE tenant_id=25 AND code LIKE 'GBP-ZZ${RUN}-%'`);
  if (tpl) { await db.query("DELETE FROM giftbox_items WHERE tenant_id=25 AND giftbox_id=$1", [tpl]).catch(() => {}); await db.query("DELETE FROM giftboxes WHERE tenant_id=25 AND id=$1", [tpl]); }
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM giftbox_instances WHERE tenant_id=25 AND code LIKE 'GBP-ZZ%') a, (SELECT COUNT(*)::int FROM giftboxes WHERE tenant_id=25 AND name LIKE 'ZZ GbPag%') b")).rows[0];
  console.log("cleanup ZZ residui:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
