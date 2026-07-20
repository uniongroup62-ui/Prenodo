// Pagamenti pass 2 (2026-07-18) — FIX classe TZ server-safe su TUTTA la
// superficie di scrittura POS (~26 punti): sale_date (guida Report/Commissioni!),
// promoDate/promoTime (frame MISTI UTC+locale), issued_at emissioni,
// cancelled_at/voided_at annullo, created_at ledger, marker [ANNULLATA ts],
// updated_at prepagati; + Commissioni: confini periodi da UTC a ROMA (premessa
// 'sale_date è UTC' smentita empiricamente — a chiusura periodo si perdevano
// fino a 2h di vendite). Verifica live sui punti osservabili.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["pos.manage", "pos.movements"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/pos?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const diffMin = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeNowMs()) / 60000;

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let cid = 0; const saleIds = []; let gcId = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id", [T, `ZZ Pag2 ${RUN}`, `zz.pag2.${RUN}@example.com`, LOC])).rows[0].id);

  // P1: checkout servizio -> sale_date in ORA DI ROMA
  const items1 = [{ type: "service", refId: 9, name: "test", quantity: 1, unitPrice: 12, status: "executed" }];
  const c1 = await api({ action: "checkout", client_id: cid, items_json: JSON.stringify(items1), payments_json: JSON.stringify([{ method: "cash", amount: 12 }]), discount: 0, installment_choice: "single" });
  const s1 = Number(c1.j?.sale?.id ?? 0);
  if (s1) saleIds.push(s1);
  const row1 = await q1("SELECT sale_date::text sd, total FROM sales WHERE tenant_id=$1 AND id=$2", [T, s1]);
  check("P1 checkout: sale_date in ORA DI ROMA (±5min; pre-fix wall del server)", c1.j?.ok !== false && s1 > 0 && diffMin(row1?.sd) < 5, JSON.stringify({ e: c1.j?.error, sd: row1?.sd, d: row1 ? Math.round(diffMin(row1.sd)) : null }));

  // P2: annullo vendita -> cancelled_at ROMA + nota rate/ledger coerenti
  const a1 = await api({ action: "cancel", sale_id: String(s1), reason: `ZZ storno ${RUN}`, stock_cancel_mode: "restore", points_storno_mode: "normal" });
  const row2 = await q1("SELECT status, cancelled_at::text ca, cancelled_reason FROM sales WHERE tenant_id=$1 AND id=$2", [T, s1]);
  check("P2 annullo: cancelled -> cancelled_at ROMA + reason", a1.j?.ok === true && row2?.status === "cancelled" && diffMin(row2?.ca) < 5 && row2?.cancelled_reason === `ZZ storno ${RUN}`, JSON.stringify({ ok: a1.j?.ok, e: a1.j?.error, row: row2 }));

  // P3: emissione GiftCard dal POS -> issued_at ROMA + movimento issue created_at ROMA
  const items2 = [{ type: "giftcard", refId: 0, name: "GiftCard test", quantity: 1, unitPrice: 25, status: "prepaid", recipientClientId: cid, recipientName: `ZZ Pag2 ${RUN}`, recipientEmail: "", code: "", eventType: "compleanno", expiresAt: "", message: "", hideAmount: 0, note: "", internalNote: "", sendMode: "none", sendOn: "", showAmount: 1 }];
  const c2 = await api({ action: "checkout", client_id: cid, items_json: JSON.stringify(items2), payments_json: JSON.stringify([{ method: "cash", amount: 25 }]), discount: 0, installment_choice: "single" });
  const s2 = Number(c2.j?.sale?.id ?? 0);
  if (s2) saleIds.push(s2);
  const gc = await q1("SELECT id, issued_at::text ia, balance FROM giftcards WHERE tenant_id=$1 AND source_sale_id=$2 ORDER BY id DESC LIMIT 1", [T, s2]).catch(() => null)
    ?? await q1("SELECT id, issued_at::text ia, balance FROM giftcards WHERE tenant_id=$1 AND recipient_client_id=$2 ORDER BY id DESC LIMIT 1", [T, cid]);
  gcId = Number(gc?.id ?? 0);
  check("P3 emissione GiftCard: issued_at in ORA DI ROMA (±5min), saldo 25", c2.j?.ok !== false && gcId > 0 && diffMin(gc?.ia) < 5 && Number(gc?.balance) === 25, JSON.stringify({ e: c2.j?.error, gc }));
  const gtx = await q1("SELECT created_at::text c FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2 ORDER BY id DESC LIMIT 1", [T, gcId]);
  check("P3b movimento emissione: created_at ROMA (±5min)", !gtx || diffMin(gtx.c) < 5, JSON.stringify(gtx));

  // P4: fidelity earn della vendita servizio -> created_at transazione ROMA
  const ftx = await q1("SELECT created_at::text c, points FROM fidelity_transactions WHERE tenant_id=$1 AND sale_id=$2 ORDER BY id DESC LIMIT 1", [T, s1]).catch(() => null);
  check("P4 fidelity earn (se emessa): created_at ROMA", !ftx || diffMin(ftx.c) < 5, JSON.stringify(ftx));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const sid of saleIds) {
    for (const t of ["sale_installments", "sale_installment_plans", "sale_items", "fidelity_transactions", "fidelity_point_lots", "giftcard_transactions", "pos_sale_stock_cancel_actions"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND sale_id=$2`, [T, sid]).catch(() => {});
    }
    await q("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, sid]).catch(() => {});
  }
  if (gcId) {
    await q("DELETE FROM giftcard_transactions WHERE tenant_id=$1 AND giftcard_id=$2", [T, gcId]).catch(() => {});
    await q("DELETE FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, gcId]).catch(() => {});
  }
  if (cid) {
    await q("DELETE FROM fidelity_transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM fidelity_point_lots WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2 AND full_name LIKE 'ZZ%'", [T, cid]).catch(() => {});
  }
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND recipient_name LIKE 'ZZ%')::int g,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.s === 9 && fin.c === 5 && fin.g === 0 && fin.l === 0;
  console.log(`CLEANUP: sales=${fin.s}/9 clients=${fin.c}/5 gc=${fin.g} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
