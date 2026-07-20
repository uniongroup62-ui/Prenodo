// Preventivi pass 3 (2026-07-18) — FIX: (1) classe TZ: created_at (testata,
// righe, cliente auto-creato), updated_at edit (vince sul trigger), sent_at
// invio, customer_decision_at pubblico -> Roma; (2) EDIT/CREATE/DELETE ATOMICI
// (tx legacy quotes.php 273/1097: edit in tx piena, create con compensativo
// per il retry-numero, delete righe+testata in tx); (3) FAIL-CLOSED sedi
// revocate sul SAVE ('Seleziona una sede valida per il preventivo.' anche con
// lista autorizzata vuota — prima creava preventivi a sede NULL globali).
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgm = require("pg");
const url = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m)[1].trim();
const SLUG = "centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", T = 25, LOC = 21;
function mk(role, locationIds, current) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms: ["quotes.manage"], needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = mk("admin", [], 21);
const revokedCookie = mk("manager", [9999], 9999);
const api = (b, cookie = adminCookie) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const pool = new pgm.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const romeMs = () => { const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); return new Date(s.replace(" ", "T")).getTime(); };
const dm = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeMs()) / 60000;
const RUN = String(Date.now()).slice(-6);
const wm = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=25")).m);
const items = JSON.stringify([{ item_type: "custom", description: `ZZ voce ${RUN}`, qty: 1, unit_price: 100, vat_percent: 22, discount_value: 0 }]);
let qid = 0, autoCid = 0;
try {
  // P1 create: testata+righe+cliente auto-creato con timestamp ROMA
  const c1 = await api({ action: "save", mode: "new", client_name: `ZZ QuoteCli ${RUN}`, quote_date: "2026-07-18", status: "draft", location_id: String(LOC), items_json: items });
  qid = Number(c1?.id ?? 0);
  const head = await q1("SELECT created_at::text ca, location_id FROM quotes WHERE tenant_id=$1 AND id=$2", [T, qid]);
  const item = await q1("SELECT created_at::text ca FROM quote_items WHERE tenant_id=$1 AND quote_id=$2 LIMIT 1", [T, qid]);
  autoCid = Number((await q1("SELECT id, created_at::text ca FROM clients WHERE tenant_id=$1 AND full_name=$2", [T, `ZZ QuoteCli ${RUN}`]))?.id ?? 0);
  const autoCli = await q1("SELECT created_at::text ca FROM clients WHERE tenant_id=$1 AND id=$2", [T, autoCid]);
  check("P1 create: created_at ROMA su testata+riga+cliente auto-creato", c1?.ok === true && qid > 0 && dm(head?.ca) < 5 && dm(item?.ca) < 5 && autoCid > 0 && dm(autoCli?.ca) < 5, JSON.stringify({ e: c1?.error, h: head?.ca, i: item?.ca, c: autoCli?.ca }));

  // P2 edit ATOMICO: righe sostituite + updated_at ROMA (vince sul trigger)
  const num = (await q1("SELECT number FROM quotes WHERE tenant_id=$1 AND id=$2", [T, qid]))?.number;
  await new Promise((r) => setTimeout(r, 1300));
  const items2 = JSON.stringify([{ item_type: "custom", description: `ZZ voce2 ${RUN}`, qty: 2, unit_price: 50, vat_percent: 22, discount_value: 0 }, { item_type: "custom", description: `ZZ voce3 ${RUN}`, qty: 1, unit_price: 10, vat_percent: 0, discount_value: 0 }]);
  const e1 = await api({ action: "save", mode: "edit", id: String(qid), number: num, client_id: String(autoCid), quote_date: "2026-07-18", status: "draft", location_id: String(LOC), items_json: items2 });
  const rows = (await pool.query("SELECT description FROM quote_items WHERE tenant_id=$1 AND quote_id=$2 ORDER BY id", [T, qid])).rows;
  const up = await q1("SELECT updated_at::text ua FROM quotes WHERE tenant_id=$1 AND id=$2", [T, qid]);
  check("P2 edit atomico: 2 righe nuove (vecchia sparita) + updated_at ROMA", e1?.ok === true && rows.length === 2 && rows.every((r) => /voce[23]/.test(r.description)) && dm(up?.ua) < 5, JSON.stringify({ e: e1?.error, rows: rows.map((r) => r.description), ua: up?.ua }));

  // P3 FAIL-CLOSED revocato: save senza sede -> guardia verbatim
  const g1 = await api({ action: "save", mode: "new", client_id: String(autoCid), quote_date: "2026-07-18", status: "draft", items_json: items }, revokedCookie);
  check("P3 revocato senza sede -> 'Seleziona una sede valida per il preventivo.'", g1?.ok !== true && String(g1?.error ?? "").includes("Seleziona una sede valida per il preventivo."), JSON.stringify(g1?.error));

  // P4 delete ATOMICO (bozza): righe + testata rimosse
  const d1 = await api({ action: "delete", id: String(qid) });
  const left = await q1("SELECT (SELECT COUNT(*) FROM quotes WHERE tenant_id=$1 AND id=$2)::int q,(SELECT COUNT(*) FROM quote_items WHERE tenant_id=$1 AND quote_id=$2)::int i", [T, qid]);
  check("P4 delete bozza atomico: testata+righe a 0", (d1?.msg === "Preventivo eliminato" || d1?.redirect === "list") && left.q === 0 && left.i === 0, JSON.stringify({ d: d1, left }));
  if (left.q === 0) qid = 0;
} catch (e) { check("EXCEPTION", false, e.stack || e.message); }
finally {
  if (qid) { await pool.query("DELETE FROM quote_items WHERE tenant_id=$1 AND quote_id=$2", [T, qid]).catch(() => {}); await pool.query("DELETE FROM quotes WHERE tenant_id=$1 AND id=$2", [T, qid]).catch(() => {}); }
  if (autoCid) await pool.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, autoCid]).catch(() => {});
  await pool.query("DELETE FROM activity_logs WHERE tenant_id=25 AND id>$1", [wm]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=25)::int c,(SELECT COUNT(*) FROM quotes WHERE tenant_id=25 AND notes LIKE 'ZZ%' OR quotes.id IN (SELECT quote_id FROM quote_items WHERE tenant_id=25 AND description LIKE 'ZZ%'))::int qz,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=25 AND id>$1)::int l", [wm]);
  const clean = fin.c === 5 && fin.qz === 0 && fin.l === 0;
  console.log(`CLEANUP: clients=${fin.c}/5 quoteZZ=${fin.qz} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
