// GiftCard pass 2b (2026-07-17): fix verificati LIVE —
//  A) lista: ricerca case-insensitive (ILIKE, parity MySQL general_ci)
//  B) POS tender: ledger redeem NEGATIVO + nota 'Riscatto GiftCard in vendita #id (CODE)'
//     + created_by + location; void vendita ripristina il saldo (topup)
//  C) card IBRIDA: saldo a 0 con item residui -> status resta 'active' (non 'redeemed')
//  D) prenotazione: nota 'Riscatto su prenotazione #code' -> dettaglio normalizza 'In sospeso'
//  E) atomicità: 2 riscatti paralleli 60+60 su saldo 100 -> esattamente 1 ok, saldo 40
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, SVC = 9, LOC = 21;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["pos.manage", "giftcard.manage", "appointments.manage", "appointments.plan", "appointments.quick_booking", "clients.manage", "fidelity.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
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

let cid = 0; const gcIds = [], saleIds = []; let itemRowId = 0, apptId = 0;
const mkCard = async (code, bal, init) => {
  const r = await q("INSERT INTO giftcards (tenant_id, code, client_id, recipient_client_id, initial_amount, balance, currency, status, issued_at, event_type, voucher_hide_amount, created_at, updated_at, location_id, location_name) VALUES ($1,$2,$3,$3,$4,$5,'EUR','active',NOW(),'giftcard',0,NOW(),NOW(),21,'Sede1') RETURNING id", [T, code, cid, init, bal]);
  gcIds.push(Number(r.rows[0].id)); return Number(r.rows[0].id);
};

try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ GcPass2 MiXeD${RUN}`])).rows[0].id);

  // ---- A) lista case-insensitive -------------------------------------------
  const gcA = await mkCard(`ZZGC2-${RUN}`, 100, 100);
  await q("UPDATE giftcards SET recipient_name=$1 WHERE tenant_id=$2 AND id=$3", [`ZZ DestMaiusc${RUN}`, T, gcA]);
  const l1 = await api(`/api/manage/giftcards?slug=${SLUG}&action=manage_list&all_locations=1&q=zzgc2-${RUN}`);
  check("A1 ricerca codice minuscolo trova la card (ILIKE)", (l1.j.rows || []).some((r) => r.id === gcA), `n=${(l1.j.rows || []).length}`);
  const l2 = await api(`/api/manage/giftcards?slug=${SLUG}&action=manage_list&all_locations=1&q=zz destmaiusc${RUN}`);
  check("A2 ricerca destinatario case-insensitive", (l2.j.rows || []).some((r) => r.id === gcA), `n=${(l2.j.rows || []).length}`);

  // ---- B) POS tender: ledger fedele + void ---------------------------------
  const items = [{ type: "service", refId: SVC, name: "test", quantity: 1, unitPrice: 12, status: "executed" }];
  const co = await api("/api/manage/pos", { action: "checkout", slug: SLUG, client_id: cid, items_json: JSON.stringify(items), payments_json: JSON.stringify([{ method: "giftcard", amount: 12, giftcardId: gcA }]), discount: 0, installment_choice: "single" });
  const saleId = Number(co.j?.sale?.id ?? 0); if (saleId) saleIds.push(saleId);
  check("B1 checkout con tender giftcard ok", co.status === 200 && saleId > 0, JSON.stringify(co.j?.error ?? "").slice(0, 150));
  const tx = await q1("SELECT type, amount::float a, note, created_by, location_id FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2 AND type='redeem' ORDER BY id DESC LIMIT 1", [T, gcA]);
  check("B2 ledger: redeem NEGATIVO -12", tx && tx.a === -12, JSON.stringify(tx));
  check("B3 ledger: nota vendita legacy con codice", tx && tx.note === `Riscatto GiftCard in vendita #${saleId} (ZZGC2-${RUN})`, JSON.stringify(tx && tx.note));
  check("B4 ledger: operatore + sede snapshot", tx && Number(tx.created_by) === 20 && Number(tx.location_id) === 21, JSON.stringify({ by: tx && tx.created_by, loc: tx && tx.location_id }));
  const balB = Number((await q1("SELECT balance::float b FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcA])).b);
  check("B5 saldo scalato 100->88", balB === 88, `bal=${balB}`);
  const dv = await api(`/api/manage/giftcards?slug=${SLUG}&action=view&id=${gcA}`);
  const mv = (dv.j?.detail?.movements || []).find((m) => m.type === "redeem" && m.amount === -12);
  check("B6 dettaglio: movimento -12 con nota e sede", !!mv && /Riscatto GiftCard in vendita #/.test(mv.note) && mv.locationLabel === "Sede1" && mv.operatorName !== "—", JSON.stringify(mv));
  const vc = await api("/api/manage/pos", { action: "cancel", slug: SLUG, id: saleId, reason: "Test pass2" });
  check("B7 annullo vendita ok", vc.status === 200 && vc.j?.ok !== false, JSON.stringify(vc.j?.error ?? "").slice(0, 120));
  const balB2 = Number((await q1("SELECT balance::float b FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcA])).b);
  const topup = await q1("SELECT amount::float a FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2 AND type='topup' ORDER BY id DESC LIMIT 1", [T, gcA]);
  check("B8 void: saldo ripristinato 100 + topup +12", balB2 === 100 && topup && topup.a === 12, `bal=${balB2} topup=${JSON.stringify(topup)}`);

  // ---- C) card ibrida: saldo 0 con item residui -> resta 'active' ----------
  const gcC = await mkCard(`ZZGC2H-${RUN}`, 10, 10);
  itemRowId = Number((await q("INSERT INTO giftcard_items (tenant_id, giftcard_id, item_type, item_id, item_name, qty, redeemed_qty, created_at) VALUES ($1,$2,'service',$3,'test',1,0,NOW()) RETURNING id", [T, gcC, SVC])).rows[0].id);
  const co2 = await api("/api/manage/pos", { action: "checkout", slug: SLUG, client_id: cid, items_json: JSON.stringify(items), payments_json: JSON.stringify([{ method: "giftcard", amount: 10, giftcardId: gcC }, { method: "cash", amount: 2 }]), discount: 0, installment_choice: "single" });
  const sale2 = Number(co2.j?.sale?.id ?? 0); if (sale2) saleIds.push(sale2);
  const cRow = await q1("SELECT balance::float b, status FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcC]);
  check("C1 ibrida: saldo 0 ma item residuo -> status ACTIVE", sale2 > 0 && cRow.b === 0 && cRow.status === "active", JSON.stringify(cRow));
  const ri = await api(`/api/manage/giftcards?slug=${SLUG}`, { action: "redeem_item", id: gcC, item_row_id: itemRowId, item_qty: 1, item_note: "zz pass2" });
  const cRow2 = await q1("SELECT status FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcC]);
  check("C2 item esaurito + saldo 0 -> status REDEEMED", ri.j?.ok === true && cRow2.status === "redeemed", JSON.stringify({ ok: ri.j?.ok, st: cRow2.status }));

  // ---- D) prenotazione: nota + normalizzazione 'In sospeso' ----------------
  const gcD = await mkCard(`ZZGC2A-${RUN}`, 50, 50);
  const d = new Date(); d.setDate(d.getDate() + 28); while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
  const D0 = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sv = await api(`/api/manage/appointments?slug=${SLUG}`, {
    action: "save", id: "", client_name: `ZZ GcPass2 MiXeD${RUN}`, client_id: String(cid),
    service_ids: String(SVC), service_names: ["test"], staff_name: "luca",
    staff_map: JSON.stringify({ [String(SVC)]: 22 }), cabin_map: "", cabin_id: "", discount_type: "", discount_value: "", coupon_code: "", coupon_discount: 0,
    fidelity_points_use: 0, credit_use: 0, date: D0, time: "11:00", location_id: String(LOC),
    status: "scheduled", staff_notes: "", customer_notes: "", appointment_hold_token: "",
    package_redeem: "", prepaid_service_redeem: "", giftbox_redeem: "", gift_redeem: "",
    giftcard_redeem: JSON.stringify([{ giftcard_id: gcD, amount: 10 }]),
  });
  apptId = Number(sv.j?.appointment?.id ?? 0);
  check("D1 save appuntamento con giftcard_redeem ok", sv.j?.ok === true && apptId > 0, JSON.stringify(sv.j?.error ?? "").slice(0, 150));
  const apRow = await q1("SELECT public_code, giftcard_used::float gu FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]);
  const ref = String((apRow && apRow.public_code) || "").trim() || String(apptId);
  const txD = await q1("SELECT amount::float a, note, location_id, created_by FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2 AND type='redeem' ORDER BY id DESC LIMIT 1", [T, gcD]);
  check("D2 ledger: nota 'Riscatto su prenotazione #<code>' + importo NEGATIVO + sede + OPERATORE", txD && txD.a === -10 && txD.note === `Riscatto su prenotazione #${ref}` && Number(txD.location_id) === LOC && Number(txD.created_by) === 20, JSON.stringify(txD));
  const dv2 = await api(`/api/manage/giftcards?slug=${SLUG}&action=view&id=${gcD}`);
  const mvD = (dv2.j?.detail?.movements || []).find((m) => /prenotazione #/.test(m.note));
  check("D3 dettaglio: normalizzato 'In sospeso su prenotazione' (pending)", !!mvD && mvD.type === "pending" && mvD.note === `In sospeso su prenotazione #${ref}`, JSON.stringify(mvD));

  // ---- E) atomicità: 2 riscatti paralleli su saldo 100 ----------------------
  const gcE = await mkCard(`ZZGC2X-${RUN}`, 100, 100);
  const [r1, r2] = await Promise.all([
    api(`/api/manage/giftcards?slug=${SLUG}`, { action: "redeem", id: gcE, redeem_amount: 60, redeem_note: "zz par1" }),
    api(`/api/manage/giftcards?slug=${SLUG}`, { action: "redeem", id: gcE, redeem_amount: 60, redeem_note: "zz par2" }),
  ]);
  const okCount = [r1, r2].filter((r) => r.j?.ok === true).length;
  const balE = Number((await q1("SELECT balance::float b FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcE])).b);
  check("E1 parallelo 60+60 su 100: esattamente 1 ok, saldo 40 (no double-spend)", okCount === 1 && balE === 40, `ok=${okCount} bal=${balE} err=${JSON.stringify([r1.j && r1.j.error, r2.j && r2.j.error])}`);
  const over = await api(`/api/manage/giftcards?slug=${SLUG}`, { action: "redeem", id: gcE, redeem_amount: 999, redeem_note: "zz" });
  check("E2 over-redeem rifiutato 'Saldo insufficiente.'", over.j?.ok !== true && /Saldo insufficiente/.test(over.j?.error || ""), JSON.stringify(over.j && over.j.error));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) {
    await q("DELETE FROM appointment_services WHERE tenant_id=$1 AND appointment_id=$2", [T, apptId]).catch(() => {});
    await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  }
  for (const sid of saleIds) {
    await q("DELETE FROM sale_payments WHERE tenant_id=$1 AND sale_id=$2", [T, sid]).catch(() => {});
    await q("DELETE FROM sale_items WHERE tenant_id=$1 AND sale_id=$2", [T, sid]).catch(() => {});
    await q("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, sid]).catch(() => {});
  }
  for (const g of gcIds) {
    await q("DELETE FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2", [T, g]).catch(() => {});
    await q("DELETE FROM giftcard_items WHERE tenant_id=$1 AND giftcard_id=$2", [T, g]).catch(() => {});
    await q("DELETE FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, g]).catch(() => {});
  }
  if (cid) {
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND details LIKE $2", [T, `%ZZ GcPass2%`]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND code LIKE $2)+(SELECT COUNT(*) FROM sales WHERE tenant_id=$1 AND id = ANY($3::int[]))+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$4) n", [T, `ZZGC2%${RUN}`, saleIds.length ? saleIds : [0], cid || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
