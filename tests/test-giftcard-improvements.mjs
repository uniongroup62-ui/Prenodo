// GiftCard migliorie 2026-07-17: paginazione 25/pagina (?p=), log attività
// (module giftcard: modifica/scadenza/riscatti/invio), compat senza ?p (cap 200).
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftcard.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body) {
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { cookie, "x-tenant-slug": SLUG, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let cid = 0, gcIds = [];
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ GcImp${RUN}`])).rows[0].id);
  const seeded = await q(`INSERT INTO giftcards (tenant_id, code, client_id, initial_amount, balance, currency, status, issued_at, event_type, voucher_hide_amount, created_at, updated_at, location_id, location_name)
    SELECT $1, 'ZZGCP-${RUN}-'||g, $2, 10, 10, 'EUR', 'active', NOW(), 'giftcard', 0, NOW(), NOW(), 21, 'Sede1' FROM generate_series(1,27) g RETURNING id`, [T, cid]);
  gcIds = seeded.rows.map((r) => Number(r.id));

  // P1: pagina 1 = 25 righe, totale 27
  const p1 = await api(`/api/manage/giftcards?slug=${SLUG}&action=manage_list&all_locations=1&q=ZZGCP-${RUN}&p=1`);
  check("P1 pagina 1: 25 righe, totalCount 27, currentPage 1", (p1.j.rows || []).length === 25 && Number(p1.j.totalCount) === 27 && Number(p1.j.currentPage) === 1 && Number(p1.j.pageSize) === 25, `rows=${(p1.j.rows || []).length} tot=${p1.j.totalCount}`);
  // P2: pagina 2 = 2 righe residue
  const p2 = await api(`/api/manage/giftcards?slug=${SLUG}&action=manage_list&all_locations=1&q=ZZGCP-${RUN}&p=2`);
  check("P2 pagina 2: 2 righe residue", (p2.j.rows || []).length === 2 && Number(p2.j.totalCount) === 27, `rows=${(p2.j.rows || []).length}`);
  // P3: nessuna sovrapposizione tra le pagine
  const ids1 = new Set((p1.j.rows || []).map((r) => r.id));
  check("P3 pagine disgiunte", (p2.j.rows || []).every((r) => !ids1.has(r.id)));
  // P4: compat senza ?p -> tutte le 27 (cap storico 200)
  const p0 = await api(`/api/manage/giftcards?slug=${SLUG}&action=manage_list&all_locations=1&q=ZZGCP-${RUN}`);
  check("P4 senza ?p: comportamento storico (27 righe)", (p0.j.rows || []).length === 27, `rows=${(p0.j.rows || []).length}`);

  // L1-L3: log attività sulle mutazioni
  const gc = gcIds[0];
  await api(`/api/manage/giftcards?slug=${SLUG}`, { action: "update", id: gc, client_id: cid, event_type: "giftcard", voucher_hide_amount: "0", recipient_client_id: 0, recipient_name: `ZZ Dest${RUN}`, recipient_email: "", note: "", gift_message: "" });
  await api(`/api/manage/giftcards?slug=${SLUG}`, { action: "redeem", id: gc, redeem_amount: 3, redeem_note: "zz log" });
  const dPlus = new Date(); dPlus.setDate(dPlus.getDate() + 60);
  const dIso = `${dPlus.getFullYear()}-${String(dPlus.getMonth() + 1).padStart(2, "0")}-${String(dPlus.getDate()).padStart(2, "0")}`;
  const gc2 = gcIds[1]; // card VERGINE: la scadenza di una card riscattata è bloccata
  await api(`/api/manage/giftcards?slug=${SLUG}`, { action: "update_expiry", id: gc2, expires_at: dIso });
  await new Promise((r) => setTimeout(r, 800));
  const logs = await q(`SELECT action, label FROM activity_logs WHERE tenant_id=$1 AND module='giftcard' AND entity_id = ANY($2::int[]) ORDER BY id ASC`, [T, [gc, gc2]]);
  const acts = logs.rows.map((r) => r.action);
  check("L1 log: modifica dati registrata", logs.rows.some((r) => r.action === "modifica" && /Modificati dati GiftCard/.test(r.label)), JSON.stringify(acts));
  check("L2 log: riscatto credito con importo", logs.rows.some((r) => r.action === "riscatta" && /Riscatto credito GiftCard/.test(r.label) && /3,00/.test(r.label)), JSON.stringify(logs.rows.map((r) => r.label)));
  check("L3 log: scadenza aggiornata", logs.rows.some((r) => r.action === "modifica" && /Aggiornata scadenza GiftCard/.test(r.label)), JSON.stringify(acts));
  // L4: la pagina Log espone il modulo giftcard
  const lg = await api(`/api/manage/logs?slug=${SLUG}&module=giftcard`);
  check("L4 pagina Log: righe module=giftcard visibili", (lg.j.rows || []).some((r) => r.module === "giftcard" && Number(r.entityId ?? r.entity_id ?? 0) === gc), `n=${(lg.j.rows || []).length}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (gcIds.length) {
    await q("DELETE FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id = ANY($2::int[])", [T, gcIds]).catch(() => {});
    await q("DELETE FROM giftcards WHERE tenant_id=$1 AND id = ANY($2::int[])", [T, gcIds]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='giftcard' AND entity_id = ANY($2::int[])", [T, gcIds]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND code LIKE $2)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$3) n", [T, `ZZGCP-${RUN}%`, cid || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
