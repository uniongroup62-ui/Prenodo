// GiftBox pass 2 — sonda input OSTILI su riscatto/scadenza/destinatario.
// Self-seeding (dati ZZ tracciati), sessione forgiata sede 21 (harness-multisede-trap).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL = ""; for (const l of envText.split(/\r?\n/)) { const m = l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/); if (m) DBURL = m[1].trim().replace(/^["']|["']$/g, ""); }
async function db(sql, p = []) { for (let a = 0; a < 6; a++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); const r = await c.query(sql, p); await c.end(); return r; } catch (e) { try { await c.end(); } catch { } if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EMAXCONNSESSION/.test(String(e.message))) { await new Promise(r => setTimeout(r, 2500)); continue; } throw e; } } }
const one = async (sql, p = []) => (await db(sql, p)).rows[0];

const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", T = 25, L1 = 21;
const payload = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftbox.manage", "giftbox.settings", "pos.manage"], needsEmailVerification: false, currentLocationId: L1, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 }), "utf8").toString("base64url");
const cookie = `beautysuite_session_t_centroesteticoelite=${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
const post = (b) => fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-tenant-slug": SLUG }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
const get = (qs) => fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}&${qs}`, { headers: { cookie, "x-tenant-slug": SLUG } }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));

const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const errOf = (r) => String(r?.j?.error ?? "");
const trk = { tpl: [], inst: [], svc: [], prod: [], cli: [] };

try {
  // ===== SEED =====
  const svc = (await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZHostSvc',80,1) RETURNING id`, [T])).id; trk.svc.push(svc);
  const prod = (await one(`INSERT INTO products (tenant_id,name,price,is_active,stock) VALUES ($1,'ZZHostProd',30,1,10) RETURNING id`, [T])).id; trk.prod.push(prod);
  await db(`INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES ($1,$2,$3,10,1)`, [T, prod, L1]);
  const cli = (await one(`INSERT INTO clients (tenant_id,full_name,location_id) VALUES ($1,'ZZHostCli',$2) RETURNING id`, [T, L1])).id; trk.cli.push(cli);

  const sv = await post({ action: "save", name: "ZZ GB Hostile", eligibility: "all_clients", active: "1", items_json: JSON.stringify([{ item_type: "service", service_id: svc, qty: 3 }, { item_type: "product", product_id: prod, qty: 2 }]) });
  const TPL = Number(sv.j?.template?.id ?? 0); if (TPL > 0) trk.tpl.push(TPL);
  if (TPL <= 0) throw new Error("seed template fallito: " + JSON.stringify(sv.j));
  const tplItems = (await db(`SELECT id,item_type,service_id,product_id,qty,sort_order FROM giftbox_items WHERE giftbox_id=$1 ORDER BY sort_order`, [TPL])).rows;
  const svcItemId = Number(tplItems.find(x => x.item_type === "service").id);

  async function mkInstance(code, status = "issued", expiresAt = null) {
    const tok = crypto.randomBytes(32).toString("hex");
    const id = (await one(`INSERT INTO giftbox_instances (tenant_id,voucher_public_token,giftbox_id,code,client_id,status,issued_at,expires_at,event_type,points_cost,location_id) VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,'giftbox',0,$8) RETURNING id`, [T, tok, TPL, code, cli, status, expiresAt, L1])).id;
    trk.inst.push(id);
    for (const it of tplItems) { await db(`INSERT INTO giftbox_instance_items (tenant_id,instance_id,giftbox_item_id,item_type,service_id,product_id,qty,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [T, id, it.id, it.item_type, it.service_id, it.product_id, it.qty, it.sort_order]); }
    return id;
  }
  const INST = await mkInstance("ZZHOST1");

  // ===== H1: qty negative (filtrate come il legacy (int)+skip) =====
  const h1 = await post({ action: "redeem_instance_partial", instance_id: String(INST), redeem_qty_json: JSON.stringify({ [svcItemId]: -3 }) });
  check("H1 qty negativa -> 'Seleziona almeno un elemento da riscattare.'", /Seleziona almeno un elemento da riscattare\./.test(errOf(h1)), errOf(h1));

  // ===== H2: qty overflow =====
  const h2 = await post({ action: "redeem_instance_partial", instance_id: String(INST), redeem_qty_json: JSON.stringify({ [svcItemId]: 999 }) });
  check("H2 qty 999 > residuo -> 'Quantità non disponibile per ...'", /Quantità non disponibile per/.test(errOf(h2)), errOf(h2));

  // ===== H3: qty decimale '1.7' -> trunc a 1 (legacy (int) cast) =====
  const h3 = await post({ action: "redeem_instance_partial", instance_id: String(INST), redeem_qty_json: JSON.stringify({ [svcItemId]: "1.7" }) });
  const red = (await db(`SELECT ri.qty FROM giftbox_redemptions r JOIN giftbox_redemption_items ri ON ri.redemption_id=r.id WHERE r.instance_id=$1`, [INST])).rows;
  check("H3 qty '1.7' -> riscattata 1 unità (trunc come (int) PHP)", h3.j?.ok === true && red.length === 1 && Number(red[0].qty) === 1, JSON.stringify({ ok: h3.j?.ok, red }));

  // ===== H4: scadenza rollover '2026-02-30' -> errore flash, NESSUNA scrittura =====
  const before = await one(`SELECT expires_at,status FROM giftbox_instances WHERE id=$1`, [INST]);
  const h4 = await post({ action: "update_instance_expiry", instance_id: String(INST), expires_at: "2026-02-30" });
  const after = await one(`SELECT expires_at,status FROM giftbox_instances WHERE id=$1`, [INST]);
  check("H4 scadenza 2026-02-30 -> flash 'Errore:' senza crash né scrittura", h4.status === 200 && h4.j?.ok === false && /^Errore:/.test(errOf(h4)) && String(after.expires_at) === String(before.expires_at) && after.status === before.status, JSON.stringify({ s: h4.status, e: errOf(h4).slice(0, 80) }));

  // ===== H5: scadenza garbage -> guardia verbatim =====
  const h5 = await post({ action: "update_instance_expiry", instance_id: String(INST), expires_at: "garbage!!" });
  check("H5 scadenza garbage -> 'Seleziona una nuova data di scadenza valida.'", errOf(h5) === "Errore: Seleziona una nuova data di scadenza valida.", errOf(h5));

  // ===== H6: scadenza nel passato =====
  const h6 = await post({ action: "update_instance_expiry", instance_id: String(INST), expires_at: "2020-01-01" });
  check("H6 scadenza passata -> 'non può essere precedente a oggi.'", /non può essere precedente a oggi\./.test(errOf(h6)), errOf(h6));

  // ===== H7: destinatario cross-tenant =====
  const foreignCli = await one(`SELECT id FROM clients WHERE tenant_id <> $1 ORDER BY id LIMIT 1`, [T]);
  if (foreignCli) {
    const h7 = await post({ action: "update_instance", instance_id: String(INST), recipient_client_id: String(foreignCli.id), event_type: "giftbox" });
    check("H7 destinatario di ALTRO tenant -> 'Cliente destinatario non trovato.'", /Cliente destinatario non trovato\./.test(errOf(h7)), errOf(h7));
  } else check("H7 skip (nessun cliente estero nel DB)", true);

  // ===== H8: istanza di ALTRO tenant -> non raggiungibile =====
  const foreignInst = await one(`SELECT id FROM giftbox_instances WHERE tenant_id <> $1 ORDER BY id LIMIT 1`, [T]);
  if (foreignInst) {
    const h8v = await get(`action=view&id=${foreignInst.id}`);
    const h8r = await post({ action: "redeem_instance_partial", instance_id: String(foreignInst.id), redeem_qty_json: JSON.stringify({ 1: 1 }) });
    check("H8 istanza cross-tenant: view+redeem negati senza leak", !h8v.j?.detail && (h8v.j?.ok === false || h8v.status !== 200) && h8r.j?.ok === false, JSON.stringify({ v: errOf(h8v).slice(0, 60), r: errOf(h8r).slice(0, 60) }));
  } else check("H8 skip (nessuna istanza estera nel DB)", true);

  // ===== H9: riscatto su istanza annullata =====
  const CINST = await mkInstance("ZZHOST2", "cancelled");
  const h9 = await post({ action: "redeem_instance_partial", instance_id: String(CINST), redeem_qty_json: JSON.stringify({ [svcItemId]: 1 }) });
  check("H9 riscatto su annullata -> 'Istanza non riscattabile'", /Istanza non riscattabile/.test(errOf(h9)), errOf(h9));

  // ===== H10: elemento inesistente =====
  const h10 = await post({ action: "redeem_instance_partial", instance_id: String(INST), redeem_qty_json: JSON.stringify({ 99999999: 1 }) });
  check("H10 giftbox_item_id inesistente -> 'Quantità non disponibile'/'Elemento non valido'", /Elemento non valido|Quantità non disponibile/.test(errOf(h10)), errOf(h10));

} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of trk.inst) {
    const rids = (await db(`SELECT id FROM giftbox_redemptions WHERE instance_id=$1 AND tenant_id=$2`, [id, T])).rows.map(r => r.id);
    for (const rid of rids) await db(`DELETE FROM giftbox_redemption_items WHERE redemption_id=$1 AND tenant_id=$2`, [rid, T]).catch(() => { });
    await db(`DELETE FROM giftbox_redemptions WHERE instance_id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
    await db(`DELETE FROM giftbox_transactions WHERE instance_id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
    await db(`DELETE FROM giftbox_instance_items WHERE instance_id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
    await db(`DELETE FROM giftbox_instances WHERE id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
  }
  for (const id of trk.tpl) { await db(`DELETE FROM giftbox_items WHERE giftbox_id=$1 AND tenant_id=$2`, [id, T]).catch(() => { }); await db(`DELETE FROM giftboxes WHERE id=$1 AND tenant_id=$2`, [id, T]).catch(() => { }); }
  for (const id of trk.prod) { await db(`DELETE FROM product_stocks WHERE product_id=$1 AND tenant_id=$2`, [id, T]).catch(() => { }); await db(`DELETE FROM products WHERE id=$1 AND tenant_id=$2`, [id, T]).catch(() => { }); }
  for (const id of trk.svc) await db(`DELETE FROM services WHERE id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
  for (const id of trk.cli) await db(`DELETE FROM clients WHERE id=$1 AND tenant_id=$2`, [id, T]).catch(() => { });
  const resid = Number((await one(`SELECT (SELECT COUNT(*) FROM giftboxes WHERE tenant_id=$1 AND name LIKE 'ZZ%') + (SELECT COUNT(*) FROM giftbox_instances WHERE tenant_id=$1 AND code LIKE 'ZZHOST%') + (SELECT COUNT(*) FROM services WHERE tenant_id=$1 AND name LIKE 'ZZHost%') + (SELECT COUNT(*) FROM products WHERE tenant_id=$1 AND name LIKE 'ZZHost%') + (SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND full_name LIKE 'ZZHost%') AS c`, [T])).c);
  const cli5 = Number((await one(`SELECT COUNT(*) c FROM clients WHERE tenant_id=$1`, [T])).c);
  check("CLEANUP: 0 residui ZZ + 5 clienti reali", resid === 0 && cli5 === 5, `resid=${resid} cli=${cli5}`);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x => !x).length} FAIL ===`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
