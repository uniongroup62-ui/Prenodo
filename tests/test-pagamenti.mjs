// E2E live PAGAMENTI (POS pass 1): checkout core — vendita servizio+prodotto
// (righe, stock, note 'Tipo pagamento'), sconto manuale, esclusività ricariche/
// GiftCard, scelta unico/rateizzato obbligatoria, piano rate (plans+installments+
// nota), coupon inesistente, stock insufficiente, annullo con ripristino stock e
// delete della vendita annullata. Gate permessi cassa/movimenti.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL = ""; for (const l of envText.split(/\r?\n/)) { const m = l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/); if (m) DBURL = m[1].trim().replace(/^["']|["']$/g, ""); }
async function db(sql, p = []) { for (let a = 0; a < 8; a++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); const r = await c.query(sql, p); await c.end(); return r; } catch (e) { try { await c.end(); } catch {} if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EMAXCONN|max clients/i.test(String(e.message))) { await new Promise(r => setTimeout(r, 4000)); continue; } throw e; } } }
const one = async (sql, p = []) => (await db(sql, p)).rows[0];
const SLUG = "centroesteticoelite", COOKIE = "beautysuite_session_t_centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", BASE = "http://localhost:3000", T = 25;
const mk = (perms, extra = {}) => { const p = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "ZZ POS", role: extra.role ?? "admin", perms, needsEmailVerification: false, currentLocationId: extra.loc ?? 21, needsLocationSelection: false, locationIds: extra.locIds ?? [] }, issuedAt: Date.now(), epoch: 1e9 }), "utf8").toString("base64url"); return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`; };
const FULL = mk(["pos.manage", "pos.movements", "pos.preorders", "pos.prepaids"]);
const api = async (path, opts = {}, sess = FULL) => { const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "x-tenant-slug": SLUG, cookie: `${COOKIE}=${sess}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } }); return { status: r.status, j: await r.json().catch(() => null) }; };
const post = (body, sess = FULL) => api(`/api/manage/pos?slug=${SLUG}`, { method: "POST", body: JSON.stringify(body) }, sess);
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const ids = { clients: [], sales: [], productId: 0 };
const items = (arr) => JSON.stringify(arr);
const pays = (arr) => JSON.stringify(arr);
const pad = (n) => String(n).padStart(2, "0");
const plusDays = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const base = (extra) => ({ action: "checkout", client_id: String(ids.clients[0] ?? 0), client_name: "ZZ POS Cli", location_id: "21", installment_choice: "single", ...extra });

async function cleanup() {
  if (ids.sales.length) {
    await db(`DELETE FROM sale_installments WHERE tenant_id=$1 AND plan_id IN (SELECT id FROM sale_installment_plans WHERE tenant_id=$1 AND sale_id=ANY($2))`, [T, ids.sales]).catch(() => {});
    await db(`DELETE FROM sale_installment_plans WHERE tenant_id=$1 AND sale_id=ANY($2)`, [T, ids.sales]).catch(() => {});
    for (const t of ["sale_items", "payments"]) await db(`DELETE FROM ${t} WHERE tenant_id=$1 AND sale_id=ANY($2)`, [T, ids.sales]).catch(() => {});
    await db(`DELETE FROM sales WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.sales]).catch(() => {});
  }
  if (ids.productId) {
    await db(`DELETE FROM product_stocks WHERE tenant_id=$1 AND product_id=$2`, [T, ids.productId]).catch(() => {});
    await db(`DELETE FROM stock_documents WHERE tenant_id=$1 AND notes LIKE '%ZZ Prodotto POS%'`, [T]).catch(() => {});
    await db(`DELETE FROM products WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`, [T, ids.productId]).catch(() => {});
  }
  if (ids.clients.length) {
    await db(`DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=ANY($2)`, [T, ids.clients]).catch(() => {});
    await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=ANY($2) AND full_name LIKE 'ZZ%'`, [T, ids.clients]).catch(() => {});
  }
}

try {
  const base0 = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM sale_items WHERE tenant_id=$1)::int si,(SELECT COUNT(*) FROM sale_installment_plans WHERE tenant_id=$1)::int pl,(SELECT COUNT(*) FROM sale_installments WHERE tenant_id=$1)::int ins,(SELECT COUNT(*) FROM coupons WHERE tenant_id=$1)::int cp`, [T]);
  console.log(`[baseline] ${JSON.stringify(base0)}`);
  ids.clients.push(Number((await one(`INSERT INTO clients (tenant_id,full_name) VALUES ($1,'ZZ POS Cli') RETURNING id`, [T])).id));
  const CLI = ids.clients[0];
  ids.productId = Number((await one(`INSERT INTO products (tenant_id,name,price,purchase_price,incoming_qty,stock,min_stock,reorder_qty,created_at,is_active,sell_online) VALUES ($1,'ZZ Prodotto POS',10.00,4.00,0,0,0,0,NOW(),1,0) RETURNING id`, [T])).id);
  const PID = ids.productId;
  await db(`INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,min_stock,reorder_qty,incoming_qty,is_enabled) VALUES ($1,$2,21,5.00,0,0,0,1)`, [T, PID]);

  // ============ Gate ============
  const g1 = await post(base({ items_json: items([{ type: "service", refId: 9, quantity: 1 }]), payments_json: pays([{ method: "cash", amount: 12 }]) }), mk(["pos.movements"], { role: "staff" }));
  check("G1 checkout senza pos.manage -> 403 'Permesso cassa mancante.'", g1.status === 403 && g1.j?.error === "Permesso cassa mancante.", JSON.stringify(g1.j));

  // ============ Vendita felice servizio+prodotto ============
  const s1 = await post(base({
    items_json: items([
      { type: "service", refId: 9, quantity: 1, status: "executed" },
      { type: "product", refId: PID, quantity: 2, status: "collected" },
    ]),
    payments_json: pays([{ method: "cash", amount: 32 }]),
  }));
  const s1Id = Number(s1.j?.sale?.id ?? 0); if (s1Id > 0) ids.sales.push(s1Id);
  const s1Row = s1Id ? await one(`SELECT subtotal, discount, total, client_id, location_id, notes, status, operator_name FROM sales WHERE tenant_id=$1 AND id=$2`, [T, s1Id]) : null;
  const s1Items = s1Id ? (await db(`SELECT item_type, item_id, qty, unit_price, line_total, item_status FROM sale_items WHERE tenant_id=$1 AND sale_id=$2 ORDER BY id`, [T, s1Id])).rows : [];
  const s1Stock = await one(`SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=21`, [T, PID]);
  check("S1 checkout servizio+prodotto SENZA prezzi nel payload -> RI-PREZZATO dal listino (32€), 2 righe, stock 5->3, metodo cash marcato",
    s1.j?.ok !== false && s1Id > 0 && s1Row && Number(s1Row.subtotal) === 32 && Number(s1Row.total) === 32 && Number(s1Row.client_id) === CLI && Number(s1Row.location_id) === 21
    && s1Items.length === 2 && s1Items.some((r) => r.item_type === "service" && Number(r.item_id) === 9 && Number(r.unit_price) === 12)
    && s1Items.some((r) => r.item_type === "product" && Number(r.item_id) === PID && Number(r.qty) === 2 && Number(r.unit_price) === 10)
    && Number(s1Stock.stock) === 3 && /posmethod:cash/.test(String(s1Row.notes ?? "")),
    JSON.stringify({ id: s1Id, row: s1Row && { st: s1Row.subtotal, t: s1Row.total, n: s1Row.notes }, items: s1Items, stock: s1Stock }));

  // ============ Sconto manuale ============
  const s2 = await post(base({ discount: "2", items_json: items([{ type: "service", refId: 9, quantity: 1 }]), payments_json: pays([{ method: "card", amount: 10 }]) }));
  const s2Id = Number(s2.j?.sale?.id ?? 0); if (s2Id > 0) ids.sales.push(s2Id);
  const s2Row = s2Id ? await one(`SELECT discount, total, notes FROM sales WHERE tenant_id=$1 AND id=$2`, [T, s2Id]) : null;
  check("S2 sconto manuale 2€ -> discount=2, total=10, nota 'Sconto manuale: -€ 2,00' (fmt_money) + metodo card",
    s2Id > 0 && s2Row && Number(s2Row.discount) === 2 && Number(s2Row.total) === 10 && /Sconto manuale: -€ 2,00/.test(String(s2Row.notes ?? "")) && /posmethod:card/.test(String(s2Row.notes ?? "")),
    JSON.stringify(s2Row));

  // ============ Esclusività ============
  const v1 = await post(base({
    items_json: items([{ type: "recharge", refId: 0, quantity: 1, unitPrice: 20, baseAmount: 20, totalAmount: 20 }, { type: "service", refId: 9, quantity: 1 }]),
    payments_json: pays([{ method: "cash", amount: 32 }]),
  }));
  check("V1 ricarica+servizio -> 'Una vendita con ricariche non può contenere altri elementi (servizi, prodotti, pacchetti, GiftCard). Effettua una vendita separata.'",
    v1.j?.error === "Una vendita con ricariche non può contenere altri elementi (servizi, prodotti, pacchetti, GiftCard). Effettua una vendita separata.", JSON.stringify(v1.j?.error));
  const v2 = await post(base({
    items_json: items([{ type: "giftcard", refId: 0, quantity: 1, unitPrice: 25, recipientName: "ZZ Dest", eventType: "compleanno" }, { type: "service", refId: 9, quantity: 1 }]),
    payments_json: pays([{ method: "cash", amount: 37 }]),
  }));
  check("V2 giftcard+servizio -> 'Una vendita con GiftCard non può contenere altri elementi (servizi, prodotti, pacchetti, ricariche). Effettua due vendite separate.'",
    v2.j?.error === "Una vendita con GiftCard non può contenere altri elementi (servizi, prodotti, pacchetti, ricariche). Effettua due vendite separate.", JSON.stringify(v2.j?.error));

  // ============ Scelta unico/rateizzato obbligatoria ============
  const v3 = await post(base({ installment_choice: "", items_json: items([{ type: "service", refId: 9, quantity: 1 }]), payments_json: pays([{ method: "cash", amount: 12 }]) }));
  if (Number(v3.j?.sale?.id ?? 0) > 0) ids.sales.push(Number(v3.j.sale.id));
  check("V3 senza scelta con totale>0 -> 'Seleziona se il cliente paga in unica soluzione o rateizzato prima di concludere la vendita.'",
    v3.j?.error === "Seleziona se il cliente paga in unica soluzione o rateizzato prima di concludere la vendita.", JSON.stringify(v3.j ?? null));

  // ============ Rate ============
  const r1 = await post(base({
    installment_choice: "installment",
    items_json: items([{ type: "service", refId: 9, quantity: 1 }]),
    payments_json: pays([{ method: "cash", amount: 4 }]),
    installment_plan: JSON.stringify({ count: 3, down_payment: 4, interval_value: 1, interval_unit: "month", first_due_date: plusDays(30), note: "ZZ piano" }),
  }));
  const r1Id = Number(r1.j?.sale?.id ?? 0); if (r1Id > 0) ids.sales.push(r1Id);
  const r1Plan = r1Id ? await one(`SELECT id, installments_count, down_payment_amount FROM sale_installment_plans WHERE tenant_id=$1 AND sale_id=$2`, [T, r1Id]).catch(() => null) : null;
  const r1Inst = r1Plan ? (await db(`SELECT amount FROM sale_installments WHERE tenant_id=$1 AND plan_id=$2 ORDER BY id`, [T, r1Plan.id])).rows : [];
  const r1Notes = r1Id ? String((await one(`SELECT notes FROM sales WHERE tenant_id=$1 AND id=$2`, [T, r1Id])).notes ?? "") : "";
  const instSum = r1Inst.reduce((s, r) => s + Number(r.amount), 0);
  check("R1 piano rate 3x su 12€ con acconto 4 -> plan row + 3 rate (somma 8.00) + nota 'Rateizzazione: acconto € 4.00 • residuo € 8.00 • 3 rate'",
    r1Id > 0 && r1Plan && Number(r1Plan.installments_count) === 3 && r1Inst.length === 3 && Math.abs(instSum - 8) < 0.001
    && r1Notes.includes("Rateizzazione: acconto € 4,00 • residuo € 8,00 • 3 rate"),
    JSON.stringify({ plan: r1Plan, rate: r1Inst.map((r) => r.amount), note: r1Notes.split("\n").find((l) => l.startsWith("Rateizzazione")) }));

  // ============ Coupon inesistente + stock insufficiente ============
  const c1 = await post(base({ coupon_code: "ZZNOPE", items_json: items([{ type: "service", refId: 9, quantity: 1 }]), payments_json: pays([{ method: "cash", amount: 12 }]) }));
  check("C1 coupon inesistente -> 'Coupon non trovato.'", c1.j?.error === "Coupon non trovato.", JSON.stringify(c1.j?.error));
  const k1 = await post(base({ items_json: items([{ type: "product", refId: PID, quantity: 99 }]), payments_json: pays([{ method: "cash", amount: 990 }]) }));
  check("K1 stock insufficiente -> 'Stock insufficiente per ZZ Prodotto POS'", k1.j?.error === "Stock insufficiente per ZZ Prodotto POS", JSON.stringify(k1.j?.error));

  // ============ Annullo + delete ============
  const x1 = await post({ action: "cancel", id: s1Id, reason: "ZZ storno test" });
  const x1Row = await one(`SELECT status FROM sales WHERE tenant_id=$1 AND id=$2`, [T, s1Id]);
  const x1Stock = await one(`SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=21`, [T, PID]);
  check("X1 annullo vendita -> status cancelled + stock RIPRISTINATO 3->5",
    x1.j?.ok !== false && String(x1Row.status) === "cancelled" && Number(x1Stock.stock) === 5, JSON.stringify({ st: x1Row.status, stock: x1Stock.stock }));
  const x2 = await post({ action: "delete_sale", id: s1Id });
  const x2Gone = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1 AND id=$2)::int s,(SELECT COUNT(*) FROM sale_items WHERE tenant_id=$1 AND sale_id=$2)::int si`, [T, s1Id]);
  if (x2Gone.s === 0) ids.sales = ids.sales.filter((x) => x !== s1Id);
  check("X2 delete vendita annullata -> riga e figli eliminati", x2.j?.deleted === true && x2Gone.s === 0 && x2Gone.si === 0, JSON.stringify({ x2: x2.j?.deleted, gone: x2Gone }));
  const x3 = await post({ action: "cancel", id: s2Id }, mk(["clients.manage"], { role: "staff" }));
  check("X3 annullo senza permessi POS -> 403 'Permesso movimenti POS mancante.'", x3.status === 403 && x3.j?.error === "Permesso movimenti POS mancante.", JSON.stringify(x3.j));
  const x4 = await post({ action: "cancel", id: s2Id, reason: "" });
  check("X4 annullo senza motivazione -> 'La motivazione è obbligatoria per annullare una vendita.'",
    x4.j?.ok === false && x4.j?.error === "La motivazione è obbligatoria per annullare una vendita.", JSON.stringify(x4.j?.error));
} catch (e) {
  console.log("FATAL", e);
  R.push(false);
} finally {
  await cleanup();
  const base1 = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM sale_items WHERE tenant_id=$1)::int si,(SELECT COUNT(*) FROM sale_installment_plans WHERE tenant_id=$1)::int pl,(SELECT COUNT(*) FROM sale_installments WHERE tenant_id=$1)::int ins,(SELECT COUNT(*) FROM coupons WHERE tenant_id=$1)::int cp,(SELECT COUNT(*) FROM products WHERE tenant_id=$1)::int p`, [T]).catch(() => null);
  console.log(`[after-cleanup] ${JSON.stringify(base1)} (atteso s=9, si=9, pl=1, ins=3, cp=0, p=0)`);
  console.log(`TOTALE: ${R.filter(Boolean).length}/${R.length} PASS`);
}
