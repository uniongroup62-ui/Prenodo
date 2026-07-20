// Migliorie Preventivi 2026-07-16 (approvate): (1) paginazione 25, (2) badge
// 'Scade tra N giorni' sugli INVIATI (dati riga), (3) Duplica preventivo.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21, SVC = 9;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["quotes.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const qapi = (b) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const qget = (qs) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}${qs}`, { headers: { cookie } }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let dupSrc = 0, dupNew = 0;
try {
  // seed 30 preventivi bozza + 1 inviato in scadenza tra 3 giorni
  await db.query(`INSERT INTO quotes (tenant_id, number, quote_date, client_name, status, subtotal, discount_total, tax_total, total, notes, location_id, created_by)
    SELECT 25, 'ZZ-PG${RUN}-'||g, CURRENT_DATE, 'ZZ PagerQ', 'draft', 10, 0, 0, 10, 'ZZpager${RUN}', 21, 20 FROM generate_series(1, 30) g`);
  await db.query(`INSERT INTO quotes (tenant_id, number, quote_date, valid_until, client_name, client_email, status, sent_at, subtotal, discount_total, tax_total, total, notes, location_id, created_by)
    VALUES (25, 'ZZ-PG${RUN}-SENT', CURRENT_DATE, CURRENT_DATE + 3, 'ZZ PagerQ', 'zz@t.local', 'sent', NOW(), 10, 0, 0, 10, 'ZZpager${RUN}', 21, 20)`);
  // === 1. paginazione ===
  const p1 = await qget(`&action=list&number=ZZ-PG${RUN}&p=1`);
  const p2 = await qget(`&action=list&number=ZZ-PG${RUN}&p=2`);
  const noP = await qget(`&action=list&number=ZZ-PG${RUN}`);
  const s1 = new Set((p1.rows ?? []).map((x) => x.id));
  const overlap = (p2.rows ?? []).some((x) => s1.has(x.id));
  check("P1 p=1: 25 righe + totale 31 + pageSize 25", (p1.rows ?? []).length === 25 && Number(p1.totalCount) === 31 && Number(p1.pageSize) === 25, `rows=${(p1.rows ?? []).length} tot=${p1.totalCount}`);
  check("P2 p=2: 6 righe, zero overlap", (p2.rows ?? []).length === 6 && !overlap, `rows2=${(p2.rows ?? []).length}`);
  check("P3 senza ?p= storico (tutte e 31, cap 300)", (noP.rows ?? []).length === 31, `rows=${(noP.rows ?? []).length}`);
  // === 2. dati badge scadenza ===
  const sentRow = (p1.rows ?? []).concat(p2.rows ?? []).find((x) => x.number === `ZZ-PG${RUN}-SENT`);
  check("B1 riga inviata: statusKey sent + validUntil presente (3gg)", !!sentRow && sentRow.statusKey === "sent" && String(sentRow.validUntil ?? "") !== "", JSON.stringify(sentRow ? { k: sentRow.statusKey, v: sentRow.validUntil } : null));
  const days = sentRow ? Math.round((new Date(sentRow.validUntil + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : -1;
  check("B2 giorni = 3 (finestra badge <= 7)", days === 3, `days=${days}`);
  const html = await fetch(`http://localhost:3000/${SLUG}/quotes`, { headers: { cookie } }).then((r) => r.text());
  let blob = html;
  for (const m of html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)) blob += await fetch(`http://localhost:3000${m[0]}`).then((r) => r.text()).catch(() => "");
  check("B3 bundle quotes contiene i testi del badge", blob.includes("Scade domani") && blob.includes("Scade oggi"), "");
  // === 3. Duplica ===
  let r = await qapi({ action: "save", mode: "new", client_name: `ZZ DupQ${RUN}`, quote_date: "2026-07-16", status: "draft", location_id: String(LOC), notes: `ZZdup${RUN}`, items_json: JSON.stringify([{ item_type: "service", item_id: SVC, description: "ZZ svc", qty: 2, unit_price: 999, tax_rate: 0, discount_percent: 0 }, { item_type: "custom", description: "ZZ custom", qty: 1, unit_price: 33, tax_rate: 0, discount_percent: 0 }]) });
  dupSrc = Number(r.j.id ?? 0);
  check("D1 sorgente creato", r.s === 200 && r.j.ok === true && dupSrc > 0, JSON.stringify(r.j.error));
  r = await qapi({ action: "duplicate", id: String(dupSrc) });
  dupNew = Number(r.j.id ?? 0);
  check("D2 duplica ok -> nuovo id diverso + msg", r.s === 200 && r.j.ok === true && dupNew > 0 && dupNew !== dupSrc && r.j.message === "Preventivo duplicato", JSON.stringify([r.j.error, dupNew]));
  const src = (await db.query("SELECT number, status FROM quotes WHERE tenant_id=25 AND id=$1", [dupSrc])).rows[0];
  const neu = (await db.query("SELECT number, status, quote_date::text d, client_name FROM quotes WHERE tenant_id=25 AND id=$1", [dupNew])).rows[0];
  const items = (await db.query("SELECT item_type, description, qty::float q, unit_price::float up FROM quote_items WHERE tenant_id=25 AND quote_id=$1 ORDER BY position", [dupNew])).rows;
  check("D3 nuovo: bozza, numero NUOVO, data odierna, cliente copiato", neu.status === "draft" && neu.number !== src.number && neu.client_name.includes("ZZ DupQ") , JSON.stringify(neu));
  const svcItem = items.find((i) => i.item_type === "service");
  const customItem = items.find((i) => i.item_type === "custom");
  check("D4 righe copiate: servizio RI-BLOCCATO al listino (non 999) + custom conservato (33)", items.length === 2 && svcItem && Number(svcItem.up) !== 999 && customItem && Number(customItem.up) === 33, JSON.stringify(items));
  await new Promise((s) => setTimeout(s, 700));
  const logRow = (await db.query("SELECT label FROM activity_logs WHERE tenant_id=25 AND module='preventivi' AND label LIKE $1 ORDER BY id DESC LIMIT 1", [`%duplicato da #${dupSrc}%`])).rows[0];
  check("D5 voce nel Log 'duplicato da #src'", !!logRow, JSON.stringify(logRow?.label));
} finally {
  for (const id of [dupSrc, dupNew]) if (id > 0) { await db.query("DELETE FROM quote_items WHERE tenant_id=25 AND quote_id=$1", [id]); await db.query("DELETE FROM quotes WHERE tenant_id=25 AND id=$1", [id]); }
  await db.query(`DELETE FROM quotes WHERE tenant_id=25 AND notes = 'ZZpager${RUN}'`);
  // Il save con solo client_name AUTO-CREA l'anagrafica (fedele al legacy):
  // va rimossa col suffisso del run.
  await db.query(`DELETE FROM clients WHERE tenant_id=25 AND full_name = 'ZZ DupQ${RUN}'`);
  const left = (await db.query(`SELECT COUNT(*)::int n FROM quotes WHERE tenant_id=25 AND (notes LIKE 'ZZpager%' OR notes LIKE 'ZZdup%')`)).rows[0].n;
  console.log("cleanup ZZ residui:", left);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
