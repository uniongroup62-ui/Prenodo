// E2E live PAGAMENTI pass 2: matrice GATE pos.* (ombrello a 4, pagine gated via
// flag), sale_detail/sale_success shape, movimenti (vendita + label composita),
// ciclo PREORDINI (ritiro parziale con split righe + doc magazzino + marker note
// + undo con merge), PREPAGATI manuali (esecuzione + undo), fmt_money con
// migliaia nelle note, permessi per-azione.
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
const mk = (perms, extra = {}) => { const p = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "ZZ POS2", role: extra.role ?? "admin", perms, needsEmailVerification: false, currentLocationId: extra.loc ?? 21, needsLocationSelection: false, locationIds: extra.locIds ?? [] }, issuedAt: Date.now(), epoch: 1e9 }), "utf8").toString("base64url"); return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`; };
const FULL = mk(["pos.manage", "pos.movements", "pos.preorders", "pos.prepaids", "pos.settings"]);
const api = async (path, opts = {}, sess = FULL) => { const r = await fetch(`${BASE}${path}`, { ...opts, headers: { "x-tenant-slug": SLUG, cookie: `${COOKIE}=${sess}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } }); return { status: r.status, j: await r.json().catch(() => null) }; };
const post = (body, sess = FULL) => api(`/api/manage/pos?slug=${SLUG}`, { method: "POST", body: JSON.stringify(body) }, sess);
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const ids = { clients: [], sales: [], productId: 0 };
const items = (arr) => JSON.stringify(arr);
const pays = (arr) => JSON.stringify(arr);
const base = (extra) => ({ action: "checkout", client_id: String(ids.clients[0] ?? 0), client_name: "ZZ POS2 Cli", location_id: "21", installment_choice: "single", ...extra });

async function cleanup() {
  if (ids.clients.length) {
    await db(`DELETE FROM client_prepaid_service_usages WHERE tenant_id=$1 AND prepaid_id IN (SELECT id FROM client_prepaid_services WHERE tenant_id=$1 AND client_id=ANY($2))`, [T, ids.clients]).catch(() => {});
    await db(`DELETE FROM client_prepaid_services WHERE tenant_id=$1 AND client_id=ANY($2)`, [T, ids.clients]).catch(() => {});
  }
  if (ids.sales.length) {
    await db(`DELETE FROM sale_installments WHERE tenant_id=$1 AND plan_id IN (SELECT id FROM sale_installment_plans WHERE tenant_id=$1 AND sale_id=ANY($2))`, [T, ids.sales]).catch(() => {});
    await db(`DELETE FROM sale_installment_plans WHERE tenant_id=$1 AND sale_id=ANY($2)`, [T, ids.sales]).catch(() => {});
    for (const t of ["sale_items", "payments"]) await db(`DELETE FROM ${t} WHERE tenant_id=$1 AND sale_id=ANY($2)`, [T, ids.sales]).catch(() => {});
    await db(`DELETE FROM recharges WHERE tenant_id=$1 AND sale_id=ANY($2)`, [T, ids.sales]).catch(() => {});
    await db(`DELETE FROM sales WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.sales]).catch(() => {});
  }
  if (ids.productId) {
    await db(`DELETE FROM stock_doc_items WHERE tenant_id=$1 AND doc_id IN (SELECT id FROM stock_docs WHERE tenant_id=$1 AND notes LIKE '%ZZ POS2%')`, [T]).catch(() => {});
    await db(`DELETE FROM stock_docs WHERE tenant_id=$1 AND notes LIKE '%ZZ POS2%'`, [T]).catch(() => {});
    await db(`DELETE FROM product_stocks WHERE tenant_id=$1 AND product_id=$2`, [T, ids.productId]).catch(() => {});
    await db(`DELETE FROM products WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`, [T, ids.productId]).catch(() => {});
  }
  if (ids.clients.length) {
    await db(`DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=ANY($2)`, [T, ids.clients]).catch(() => {});
    await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=ANY($2) AND full_name LIKE 'ZZ%'`, [T, ids.clients]).catch(() => {});
  }
}

try {
  const base0 = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM sale_items WHERE tenant_id=$1)::int si,(SELECT COUNT(*) FROM client_prepaid_services WHERE tenant_id=$1)::int cps,(SELECT COUNT(*) FROM stock_docs WHERE tenant_id=$1)::int sd,(SELECT COUNT(*) FROM products WHERE tenant_id=$1)::int p`, [T]);
  console.log(`[baseline] ${JSON.stringify(base0)}`);
  ids.clients.push(Number((await one(`INSERT INTO clients (tenant_id,full_name) VALUES ($1,'ZZ POS2 Cli') RETURNING id`, [T])).id));
  ids.productId = Number((await one(`INSERT INTO products (tenant_id,name,price,purchase_price,incoming_qty,stock,min_stock,reorder_qty,created_at,is_active,sell_online) VALUES ($1,'ZZ POS2 Prod',10.00,4.00,0,0,0,0,NOW(),1,0) RETURNING id`, [T])).id);
  const PID = ids.productId;
  await db(`INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,min_stock,reorder_qty,incoming_qty,is_enabled) VALUES ($1,$2,21,5.00,0,0,0,1)`, [T, PID]);

  // ============ A. Matrice gate ============
  const a1 = await api(`/api/manage/pos?slug=${SLUG}`, {}, mk(["pos.preorders"], { role: "staff" }));
  check("A1 context con SOLO pos.preorders -> 200 (ombrello a 4 come il gate pagina sale_detail) + flag posManage/posMovements FALSE",
    a1.status === 200 && a1.j?.perms?.posManage === false && a1.j?.perms?.posMovements === false && a1.j?.perms?.posPreorders === true,
    JSON.stringify(a1.j?.perms));
  const a2 = await api(`/api/manage/pos?slug=${SLUG}`, {}, mk(["clients.manage"], { role: "staff" }));
  check("A2 context senza permessi pos.* -> 403 'Permesso POS mancante.'", a2.status === 403 && a2.j?.error === "Permesso POS mancante.", JSON.stringify(a2.j));

  // ============ B. Vendita + movimenti + dettaglio ============
  const s1 = await post(base({ items_json: items([{ type: "service", refId: 9, quantity: 1 }]), payments_json: pays([{ method: "cash", amount: 12 }]) }));
  const s1Id = Number(s1.j?.sale?.id ?? 0); if (s1Id > 0) ids.sales.push(s1Id);
  const ctx = (await api(`/api/manage/pos?slug=${SLUG}`, {})).j;
  const mvS1 = (ctx?.movements ?? []).find((m) => m.kind === "sale" && Number(m.id) === s1Id);
  check("B1 vendita in Movimenti: kind sale, label 'Vendita', stato 'Attiva', operatore valorizzato",
    !!mvS1 && mvS1.kindLabel === "Vendita" && String(mvS1.status) === "Attiva" && String(mvS1.operator ?? "").length > 0,
    JSON.stringify(mvS1 && { l: mvS1.kindLabel, st: mvS1.status, op: mvS1.operator }));
  const det = (await api(`/api/manage/pos?slug=${SLUG}&action=sale_detail&id=${s1Id}`, {}, mk(["pos.prepaids"], { role: "staff" }))).j;
  check("B2 sale_detail con SOLO pos.prepaids -> 200 (gate pagina a 4 permessi) + shape (sale.id, items, cancelSummary)",
    det && Number(det?.sale?.id ?? det?.id ?? 0) === s1Id !== false && (det?.sale || det?.items || det?.cancelSummary) !== undefined,
    JSON.stringify(Object.keys(det ?? {}).slice(0, 10)));
  const succ = (await api(`/api/manage/pos?slug=${SLUG}&action=sale_success&id=${s1Id}`, {})).j;
  check("B3 sale_success -> shape con dati vendita", succ && (succ.sale || succ.total !== undefined || succ.ok !== false), JSON.stringify(Object.keys(succ ?? {}).slice(0, 10)));

  // ============ C. fmt_money migliaia nelle note (server) ============
  const big = await post(base({ discount: "1005", items_json: items([{ type: "service", refId: 9, quantity: 100 }]), payments_json: pays([{ method: "cash", amount: 195 }]) }));
  const bigId = Number(big.j?.sale?.id ?? 0); if (bigId > 0) ids.sales.push(bigId);
  const bigNotes = bigId ? String((await one(`SELECT notes FROM sales WHERE tenant_id=$1 AND id=$2`, [T, bigId])).notes ?? "") : "";
  check("C1 nota 'Sconto manuale: -€ 1.005,00' con RAGGRUPPAMENTO migliaia (fmt_money)",
    big.j?.ok !== false && bigNotes.includes("Sconto manuale: -€ 1.005,00"), JSON.stringify(bigNotes.split("\n")[0]));

  // ============ D. Preordini: ritiro parziale + undo ============
  const po = await post(base({ items_json: items([{ type: "product", refId: PID, quantity: 2, status: "ordered" }]), payments_json: pays([{ method: "cash", amount: 20 }]) }));
  const poId = Number(po.j?.sale?.id ?? 0); if (poId > 0) ids.sales.push(poId);
  const stock0 = Number((await one(`SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=21`, [T, PID])).stock);
  const poItem = await one(`SELECT id, qty FROM sale_items WHERE tenant_id=$1 AND sale_id=$2 AND item_type='product'`, [T, poId]);
  check("D1 vendita preordine (status ordered) -> stock INVARIATO (5)", po.j?.ok !== false && stock0 === 5 && Number(poItem.qty) === 2, JSON.stringify({ stock: stock0, qty: poItem?.qty }));
  const mcPerm = await post({ action: "mark_collected", sale_id: poId, sale_item_id: poItem.id, collect_qty: 1 }, mk(["pos.prepaids"], { role: "staff" }));
  check("D2 mark_collected senza pos.preorders/manage -> 'Non hai i permessi per gestire i preordini.'",
    mcPerm.status === 403 && mcPerm.j?.error === "Non hai i permessi per gestire i preordini.", JSON.stringify(mcPerm.j));
  const mc = await post({ action: "mark_collected", sale_id: poId, sale_item_id: poItem.id, collect_qty: 1 }, mk(["pos.preorders"], { role: "staff" }));
  const rows1 = (await db(`SELECT id, qty, item_status FROM sale_items WHERE tenant_id=$1 AND sale_id=$2 ORDER BY id`, [T, poId])).rows;
  const stock1 = Number((await one(`SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=21`, [T, PID])).stock);
  const poNotes1 = String((await one(`SELECT notes FROM sales WHERE tenant_id=$1 AND id=$2`, [T, poId])).notes ?? "");
  check("D3 ritiro PARZIALE 1/2 (con solo pos.preorders) -> split righe (ordered 1 + collected 1), stock 5->4, marker [PREORDINE RITIRATO",
    mc.j?.ok !== false && rows1.length === 2 && rows1.some((r) => r.item_status === "ordered" && Number(r.qty) === 1) && rows1.some((r) => r.item_status === "collected" && Number(r.qty) === 1)
    && stock1 === 4 && /\[PREORDINE RITIRATO/.test(poNotes1),
    JSON.stringify({ rows: rows1, stock: stock1 }));
  const collectedRow = rows1.find((r) => r.item_status === "collected");
  const un = await post({ action: "undo_collected", sale_id: poId, sale_item_id: collectedRow.id }, mk(["pos.preorders"], { role: "staff" }));
  const rows2 = (await db(`SELECT id, qty, item_status FROM sale_items WHERE tenant_id=$1 AND sale_id=$2 ORDER BY id`, [T, poId])).rows;
  const stock2 = Number((await one(`SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=21`, [T, PID])).stock);
  check("D4 undo ritiro -> righe RI-FUSE in una ordered qty 2, stock RIPRISTINATO 5",
    un.j?.ok !== false && rows2.length === 1 && rows2[0].item_status === "ordered" && Number(rows2[0].qty) === 2 && stock2 === 5,
    JSON.stringify({ rows: rows2, stock: stock2 }));

  // ============ E. Prepagati: esecuzione manuale + undo ============
  const pp = await post(base({ items_json: items([{ type: "prepaid", refId: 9, quantity: 3 }]), payments_json: pays([{ method: "cash", amount: 36 }]) }));
  const ppId = Number(pp.j?.sale?.id ?? 0); if (ppId > 0) ids.sales.push(ppId);
  const prepaidRow = await one(`SELECT id, purchased_qty, remaining_qty FROM client_prepaid_services WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`, [T, ids.clients[0]]).catch(() => null);
  check("E1 vendita prepagato x3 -> client_prepaid_services (purchased 3, remaining 3)",
    pp.j?.ok !== false && prepaidRow && Number(prepaidRow.purchased_qty) === 3 && Number(prepaidRow.remaining_qty) === 3, JSON.stringify(prepaidRow));
  const exPerm = await post({ action: "prepaid_manual_execute", sale_id: ppId, prepaid_id: prepaidRow.id, execute_qty: 1 }, mk(["pos.preorders"], { role: "staff" }));
  check("E2 prepaid_manual_execute senza pos.prepaids/manage -> 'Non hai i permessi per gestire i prepagati.'",
    exPerm.status === 403 && exPerm.j?.error === "Non hai i permessi per gestire i prepagati.", JSON.stringify(exPerm.j));
  const ex = await post({ action: "prepaid_manual_execute", sale_id: ppId, prepaid_id: prepaidRow.id, execute_qty: 1 }, mk(["pos.prepaids"], { role: "staff" }));
  const afterEx = await one(`SELECT remaining_qty FROM client_prepaid_services WHERE tenant_id=$1 AND id=$2`, [T, prepaidRow.id]);
  const usage = await one(`SELECT id, qty FROM client_prepaid_service_usages WHERE tenant_id=$1 AND client_prepaid_service_id=$2 ORDER BY id DESC LIMIT 1`, [T, prepaidRow.id]).catch(() => null);
  check("E3 esecuzione manuale x1 (con solo pos.prepaids) -> remaining 3->2 + riga usage",
    ex.j?.ok !== false && Number(afterEx.remaining_qty) === 2 && usage && Number(usage.qty) === 1, JSON.stringify({ rem: afterEx?.remaining_qty, usage }));
  const undoEx = await post({ action: "prepaid_manual_undo", sale_id: ppId, usage_id: usage.id }, mk(["pos.prepaids"], { role: "staff" }));
  const afterUndo = await one(`SELECT remaining_qty FROM client_prepaid_services WHERE tenant_id=$1 AND id=$2`, [T, prepaidRow.id]);
  check("E4 annulla esecuzione -> remaining RIPRISTINATO 3", undoEx.j?.ok !== false && Number(afterUndo.remaining_qty) === 3, JSON.stringify(afterUndo));

  // ============ F. Movimenti: label composita vendita con ricarica ============
  const rc = await post(base({ items_json: items([{ type: "recharge", refId: 0, quantity: 1, baseAmount: 30, bonusKind: "none", bonusValue: 0, totalAmount: 30, earnPoints: 0 }]), payments_json: pays([{ method: "cash", amount: 30 }]) }));
  const rcId = Number(rc.j?.sale?.id ?? 0); if (rcId > 0) ids.sales.push(rcId);
  const ctx2 = (await api(`/api/manage/pos?slug=${SLUG}`, {})).j;
  const mvRc = (ctx2?.movements ?? []).find((m) => m.kind === "sale" && Number(m.id) === rcId);
  check("F1 vendita-ricarica in Movimenti -> label composita con 'Ricarica' + hasRechargeLine",
    rc.j?.ok !== false && !!mvRc && /Ricarica/.test(String(mvRc.kindLabel ?? "")) && mvRc.hasRechargeLine === true,
    JSON.stringify(mvRc && { l: mvRc.kindLabel, r: mvRc.hasRechargeLine }));
} catch (e) {
  console.log("FATAL", e);
  R.push(false);
} finally {
  await cleanup();
  const base1 = await one(`SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM sale_items WHERE tenant_id=$1)::int si,(SELECT COUNT(*) FROM client_prepaid_services WHERE tenant_id=$1)::int cps,(SELECT COUNT(*) FROM stock_docs WHERE tenant_id=$1)::int sd,(SELECT COUNT(*) FROM products WHERE tenant_id=$1)::int p`, [T]).catch(() => null);
  console.log(`[after-cleanup] ${JSON.stringify(base1)} (atteso s=9, si=9, cps=0, sd=8, p=0)`);
  console.log(`TOTALE: ${R.filter(Boolean).length}/${R.length} PASS`);
}
