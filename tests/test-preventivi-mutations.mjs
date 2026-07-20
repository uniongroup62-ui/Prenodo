// Pass Preventivi 2026-07-16: ciclo mutazioni live cross-action — save/edit
// lock, delete draft-only, numerazione, conversione POS (accepted-only +
// idempotenza + quota->paid) e voci nel Log attivita'.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21, SVC = 9;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["quotes.manage", "pos.manage", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const qapi = (b) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const qget = (qs) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}${qs}`, { headers: { cookie } }).then((r) => r.json());
const pget = (qs) => fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}${qs}`, { headers: { cookie } }).then(async (r) => ({ s: r.status, j: await r.json() }));
const ppost = (b) => fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const capi = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let cid = 0, qDraft = 0, qConv = 0, saleId = 0;
const items = JSON.stringify([{ item_type: "service", item_id: SVC, description: "ZZ riga", qty: 1, unit_price: 50, tax_rate: 0, discount_percent: 0 }]);
try {
  let j = await capi({ action: "create", first_name: "ZZ", last_name: `QuoteMut${RUN}`, location_id: String(LOC) });
  cid = Number(j.client?.id ?? 0);
  // === numerazione automatica N/YYYY ===
  const nn = await qget("&action=next_number");
  const year = new Date().getFullYear();
  check("M1 next_number formato N/YYYY dell'anno corrente", new RegExp(`^\\d+/${year}$`).test(String(nn.number ?? "")), JSON.stringify(nn.number));
  // === crea bozza ===
  let r = await qapi({ action: "save", mode: "new", client_id: String(cid), quote_date: "2026-07-16", status: "draft", location_id: String(LOC), items_json: items });
  qDraft = Number(r.j.id ?? 0);
  check("M2 crea bozza ok", r.s === 200 && r.j.ok === true && qDraft > 0, JSON.stringify(r.j.error));
  // === modifica bozza: 'sent' NON e' selezionabile dall'editor (fedele: si
  // raggiunge solo con l'invio email) -> resta draft ===
  const numRow = (await db.query("SELECT number FROM quotes WHERE tenant_id=25 AND id=$1", [qDraft])).rows[0] ?? { number: "" };
  r = await qapi({ action: "save", mode: "edit", id: String(qDraft), number: numRow.number, client_id: String(cid), quote_date: "2026-07-16", status: "sent", location_id: String(LOC), items_json: items, notes: `ZZ edit ${RUN}` });
  const st3 = (await db.query("SELECT status FROM quotes WHERE tenant_id=25 AND id=$1", [qDraft])).rows[0]?.status;
  check("M3 edit ok ma 'sent' NON impostabile dall'editor (resta draft)", r.s === 200 && r.j.ok === true && st3 === "draft", JSON.stringify([r.j.error, st3]));
  // === delete su NON-bozza rifiutato verbatim (sent via invio: qui forzato DB) ===
  await db.query("UPDATE quotes SET status='sent', sent_at=NOW() WHERE tenant_id=25 AND id=$1", [qDraft]);
  r = await qapi({ action: "delete", id: String(qDraft) });
  check("M4 delete su 'sent' -> guardia verbatim", r.j.ok === false && String(r.j.err ?? "").startsWith("Puoi eliminare solo preventivi in bozza."), JSON.stringify(r.j.err));
  // === conversione POS: gate accepted-only ===
  r = await pget(`&action=quote_cart&quote_id=${qDraft}`);
  const gateErr = String(r.j.error ?? r.j.err ?? "");
  check("M5 quote_cart su 'sent' -> verbatim accepted-only", /Solo i preventivi in stato Accettato/.test(gateErr), gateErr.slice(0, 80));
  // accepted VIA EDITOR (stato ammesso dall'editor legacy)
  r = await qapi({ action: "save", mode: "edit", id: String(qDraft), number: numRow.number, client_id: String(cid), quote_date: "2026-07-16", status: "accepted", location_id: String(LOC), items_json: items, notes: `ZZ edit ${RUN}` });
  check("M5b editor -> accepted ok", r.s === 200 && r.j.ok === true, JSON.stringify(r.j.error));
  r = await pget(`&action=quote_cart&quote_id=${qDraft}`);
  const gate6 = String(r.j.error ?? r.j.err ?? "");
  const cart = r.j.cart ?? r.j;
  check("M6 quote_cart su 'accepted' -> carrello bloccato dal preventivo", r.s === 200 && gate6 === "" && JSON.stringify(cart).includes("ZZ riga"), JSON.stringify(r.j.error ?? "ok"));
  // === checkout con source_quote_id -> vendita + preventivo paid ===
  const items2 = (cart.items ?? []).map((it) => ({ type: it.type ?? it.item_type ?? "service", refId: Number(it.refId ?? it.item_id ?? SVC), quantity: Number(it.quantity ?? it.qty ?? 1), unitPrice: Number(it.unitPrice ?? it.unit_price ?? 50) }));
  r = await ppost({ action: "checkout", installment_choice: "single", client_id: String(cid), location_id: String(LOC), source_quote_id: String(qDraft), items_json: JSON.stringify(items2.length ? items2 : [{ type: "service", refId: SVC, quantity: 1, unitPrice: 50 }]), payments_json: JSON.stringify([{ method: "cash", amount: 50 }]) });
  saleId = Number(r.j.sale?.id ?? 0);
  const qRow = (await db.query("SELECT status FROM quotes WHERE tenant_id=25 AND id=$1", [qDraft])).rows[0] ?? { status: "?" };
  check("M7 checkout da preventivo -> vendita + stato paid", r.s === 200 && saleId > 0 && qRow.status === "paid", JSON.stringify([r.j.error, qRow.status]));
  // === idempotenza: secondo import dello stesso preventivo bloccato ===
  r = await pget(`&action=quote_cart&quote_id=${qDraft}`);
  const gate2 = String(r.j.error ?? r.j.err ?? "");
  check("M8 secondo import dello stesso preventivo -> bloccato", r.s !== 200 || r.j.ok === false || gate2 !== "", gate2.slice(0, 80));
  // === delete bozza vera: eliminata con le righe ===
  r = await qapi({ action: "save", mode: "new", client_id: String(cid), quote_date: "2026-07-16", status: "draft", location_id: String(LOC), items_json: items });
  qConv = Number(r.j.id ?? 0);
  r = await qapi({ action: "delete", id: String(qConv) });
  const gone = await db.query("SELECT (SELECT COUNT(*)::int FROM quotes WHERE tenant_id=25 AND id=$1) q, (SELECT COUNT(*)::int FROM quote_items WHERE tenant_id=25 AND quote_id=$1) i", [qConv]);
  check("M9 delete bozza -> quote+items rimossi", r.j.ok === true && Number(gone.rows[0].q) === 0 && Number(gone.rows[0].i) === 0, JSON.stringify(gone.rows[0]));
  qConv = 0;
  // === Log attivita' (fase 2b) ===
  await new Promise((s) => setTimeout(s, 800));
  const logs = (await db.query("SELECT action, label FROM activity_logs WHERE tenant_id=25 AND module='preventivi' ORDER BY id DESC LIMIT 6")).rows;
  const acts = logs.map((x) => x.action);
  check("L1 log preventivi: crea+modifica+elimina presenti", acts.includes("crea") && acts.includes("modifica") && acts.includes("elimina"), JSON.stringify(acts));
} finally {
  if (saleId) { await ppost({ action: "cancel", id: saleId, reason: "ZZ cleanup" }).catch(() => {}); await ppost({ action: "delete_sale", id: saleId }).catch(() => {}); }
  if (qDraft) { await db.query("DELETE FROM quote_items WHERE tenant_id=25 AND quote_id=$1", [qDraft]); await db.query("DELETE FROM quotes WHERE tenant_id=25 AND id=$1", [qDraft]); }
  if (qConv) { await db.query("DELETE FROM quote_items WHERE tenant_id=25 AND quote_id=$1", [qConv]); await db.query("DELETE FROM quotes WHERE tenant_id=25 AND id=$1", [qConv]); }
  if (cid) await capi({ action: "delete", id: cid, delete_reason: "ZZ preventivi pass", delete_confirm_text: "ELIMINA" }).catch(() => {});
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM quotes WHERE tenant_id=25 AND notes LIKE '%ZZ edit%') q, (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ QuoteMut%') c, (SELECT COUNT(*)::int FROM sales WHERE tenant_id=25) s, (SELECT COUNT(*)::int FROM appointments WHERE tenant_id=25) a")).rows[0];
  console.log("cleanup: residui ZZ + baseline:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
