// GiftCard pass 2 (2026-07-16) — edge non coperti da e2e-giftcard:
// gate legacy giftcard.manage (fix ombrello pos.manage), sync vendita anonima
// (GiftLoyaltyAttribution), compat update_note, clamp qty item, event_type invalido.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const mk = (perms, role = "staff") => {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
};
const GC = mk(["giftcard.manage"]);
const POSONLY = mk(["pos.manage"]);
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const api = (cookie, body) => fetch(`http://localhost:3000/api/manage/giftcards?slug=${SLUG}`, { method: "POST", headers: { cookie: `beautysuite_session_t_${SLUG}=${cookie}`, "content-type": "application/json", "x-tenant-slug": SLUG }, body: JSON.stringify(body) });
const apiGet = (cookie, qs) => fetch(`http://localhost:3000/api/manage/giftcards?slug=${SLUG}&${qs}`, { headers: { cookie: `beautysuite_session_t_${SLUG}=${cookie}`, "x-tenant-slug": SLUG } });

let sender = 0, recip = 0, cardA = 0, cardB = 0, itemB = 0, saleAnon = 0, saleItemAnon = 0, saleNorm = 0, saleItemNorm = 0, cardC = 0;
const CODE_A = `GC-ZZP2A${RUN}`, CODE_B = `GC-ZZP2B${RUN}`, CODE_C = `GC-ZZP2C${RUN}`;
const mkCard = async (code, over = {}) => {
  const v = { client_id: sender, initial: 50, balance: 50, status: "active", ...over };
  const r = await db.query(
    `INSERT INTO giftcards (tenant_id, code, client_id, recipient_client_id, recipient_name, recipient_email, initial_amount, balance, status, issued_at, expires_at, event_type, voucher_hide_amount, location_id, location_name, created_at, updated_at)
     VALUES ($1,$2,$3,NULL,'','',$4,$5,$6,NOW(),CURRENT_DATE+60,'giftcard',0,$7,'Sede1',NOW(),NOW()) RETURNING id`,
    [T, code, v.client_id, v.initial, v.balance, v.status, LOC]);
  return Number(r.rows[0].id);
};
try {
  sender = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES ($1,$2,$3) RETURNING id", [T, `ZZ GcP2Snd${RUN}`, LOC])).rows[0].id);
  recip = Number((await db.query("INSERT INTO clients (tenant_id,full_name,email,location_id) VALUES ($1,$2,$3,$4) RETURNING id", [T, `ZZ GcP2Rcp${RUN}`, `zzp2rcp${RUN}@test.local`, LOC])).rows[0].id);
  cardA = await mkCard(CODE_A);
  cardB = await mkCard(CODE_B);
  itemB = Number((await db.query("INSERT INTO giftcard_items (tenant_id, giftcard_id, item_type, item_id, item_name, qty, redeemed_qty, created_at) VALUES ($1,$2,'service',0,'ZZ Item P2',3,0,NOW()) RETURNING id", [T, cardB])).rows[0].id);

  // ---- G1-G3: GATE (legacy: Auth::requirePerm('giftcard.manage') pagina intera) ----
  const g1 = await api(POSONLY, { action: "update", id: cardA });
  check("G1 POST update con solo pos.manage -> 403", g1.status === 403, `status=${g1.status}`);
  const g2 = await apiGet(POSONLY, "action=manage_list");
  check("G2 GET manage_list con solo pos.manage -> 403", g2.status === 403, `status=${g2.status}`);
  const g3 = await fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}`, { method: "POST", headers: { cookie: `beautysuite_session_t_${SLUG}=${POSONLY}`, "content-type": "application/json", "x-tenant-slug": SLUG }, body: JSON.stringify({ action: "update_instance", instance_id: "0" }) });
  check("G3 POST giftbox con solo pos.manage -> 403", g3.status === 403, `status=${g3.status}`);
  const g4 = await apiGet(GC, `action=view&id=${cardA}`);
  check("G4 giftcard.manage continua a leggere il dettaglio", g4.status === 200 && (await g4.json()).ok === true, `status=${g4.status}`);

  // ---- S1-S3: sync vendita ANONIMA (GiftLoyaltyAttribution) ----
  saleAnon = Number((await db.query("INSERT INTO sales (tenant_id, client_id, total, status, location_id, sale_date, created_at) VALUES ($1,NULL,50,'paid',$2,NOW(),NOW()) RETURNING id", [T, LOC])).rows[0].id);
  saleItemAnon = Number((await db.query("INSERT INTO sale_items (tenant_id, sale_id, item_type, item_id, item_name, qty, unit_price, line_total) VALUES ($1,$2,'product',NULL,$3,1,50,50) RETURNING id", [T, saleAnon, `GiftCard ${CODE_A}`])).rows[0].id);
  const s1 = await api(GC, { action: "update", id: cardA, client_id: String(sender), recipient_client_id: String(recip), event_type: "giftcard" });
  const s1j = await s1.json();
  const saleCli1 = (await db.query("SELECT client_id FROM sales WHERE tenant_id=$1 AND id=$2", [T, saleAnon])).rows[0].client_id;
  check("S1 vendita anonima intestata al destinatario abbinato", s1j.ok === true && Number(saleCli1) === recip, `ok=${s1j.ok} sale.client_id=${saleCli1}`);
  // Legacy: dopo S1 la vendita HA un cliente reale -> sync early-return, la
  // rimozione dell'abbinamento NON la riporta anonima (no-op fedele).
  const s2 = await api(GC, { action: "update", id: cardA, client_id: String(sender), recipient_client_id: "0", recipient_name: "", recipient_email: "", event_type: "giftcard" });
  const s2j = await s2.json();
  const saleCli2 = (await db.query("SELECT client_id FROM sales WHERE tenant_id=$1 AND id=$2", [T, saleAnon])).rows[0].client_id;
  check("S2 rimozione abbinamento: vendita ormai intestata NON toccata (early-return legacy)", s2j.ok === true && Number(saleCli2) === recip, `sale.client_id=${JSON.stringify(saleCli2)}`);
  // vendita NON anonima: mai toccata
  saleNorm = Number((await db.query("INSERT INTO sales (tenant_id, client_id, total, status, location_id, sale_date, created_at) VALUES ($1,$2,50,'paid',$3,NOW(),NOW()) RETURNING id", [T, sender, LOC])).rows[0].id);
  saleItemNorm = Number((await db.query("INSERT INTO sale_items (tenant_id, sale_id, item_type, item_id, item_name, qty, unit_price, line_total) VALUES ($1,$2,'product',NULL,$3,1,50,50) RETURNING id", [T, saleNorm, `GiftCard ${CODE_C}`])).rows[0].id);
  cardC = await mkCard(CODE_C);
  const s3 = await api(GC, { action: "update", id: cardC, client_id: String(sender), recipient_client_id: String(recip), event_type: "giftcard" });
  const saleCli3 = Number((await db.query("SELECT client_id FROM sales WHERE tenant_id=$1 AND id=$2", [T, saleNorm])).rows[0].client_id);
  check("S3 vendita con cliente reale NON toccata", (await s3.json()).ok === true && saleCli3 === sender, `sale.client_id=${saleCli3}`);

  // ---- C1-C2: compat update_note ----
  const c1 = await api(GC, { action: "update_note", id: cardB, note: `ZZ nota cliente ${RUN}` });
  const c1j = await c1.json();
  const noteDb = (await db.query("SELECT note FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, cardB])).rows[0].note;
  check("C1 update_note compat salva la nota cliente", c1j.ok === true && /Nota per il cliente salvata/.test(c1j.message || "") && noteDb === `ZZ nota cliente ${RUN}`, JSON.stringify({ msg: c1j.message, noteDb }));
  await db.query("UPDATE giftcards SET status='cancelled' WHERE tenant_id=$1 AND id=$2", [T, cardA]);
  const c2 = await api(GC, { action: "update_note", id: cardA, note: "x" });
  check("C2 update_note su annullata bloccata (verbatim)", (await c2.json()).error === "Non è possibile modificare una GiftCard annullata.", "");
  await db.query("UPDATE giftcards SET status='active' WHERE tenant_id=$1 AND id=$2", [T, cardA]);

  // ---- E1: event_type invalido -> conserva il corrente ----
  const e1 = await api(GC, { action: "update", id: cardB, client_id: String(sender), event_type: "evento_inesistente" });
  const evDb = (await db.query("SELECT event_type FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, cardB])).rows[0].event_type;
  check("E1 event_type invalido -> resta quello corrente", (await e1.json()).ok === true && evDb === "giftcard", `event_type=${evDb}`);

  // ---- Q1: redeem_item qty 0 -> trattata come 1 (legacy: if qty<=0 qty=1) ----
  const q1 = await api(GC, { action: "redeem_item", id: cardB, item_row_id: String(itemB), item_qty: "0" });
  const q1j = await q1.json();
  const redQty = Number((await db.query("SELECT redeemed_qty FROM giftcard_items WHERE tenant_id=$1 AND id=$2", [T, itemB])).rows[0].redeemed_qty);
  check("Q1 redeem_item qty=0 -> riscatta 1 (clamp legacy)", q1j.ok === true && redQty === 1, `redeemed_qty=${redQty}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const [t2, id] of [["giftcard_transactions", null]]) void t2, void id;
  for (const cid of [cardA, cardB, cardC]) if (cid) {
    await db.query("DELETE FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2", [T, cid]).catch(() => {});
    await db.query("DELETE FROM giftcard_items WHERE tenant_id=$1 AND giftcard_id=$2", [T, cid]).catch(() => {});
    await db.query("DELETE FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  if (saleItemAnon) await db.query("DELETE FROM sale_items WHERE tenant_id=$1 AND id=$2", [T, saleItemAnon]).catch(() => {});
  if (saleItemNorm) await db.query("DELETE FROM sale_items WHERE tenant_id=$1 AND id=$2", [T, saleItemNorm]).catch(() => {});
  for (const sid of [saleAnon, saleNorm]) if (sid) await db.query("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, sid]).catch(() => {});
  for (const cid of [sender, recip]) if (cid) await db.query("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  const left = Number((await db.query("SELECT (SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND code LIKE 'GC-ZZP2%')+(SELECT COUNT(*) FROM sales WHERE tenant_id=$1 AND id IN ($2,$3))+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id IN ($4,$5)) n", [T, saleAnon || 0, saleNorm || 0, sender || 0, recip || 0])).rows[0].n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await db.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
