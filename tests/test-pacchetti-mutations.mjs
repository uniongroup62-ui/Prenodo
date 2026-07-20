// Pass Pacchetti 2026-07-16: guardie client_save, usage PRODOTTI (stock
// per-sede + documento magazzino), non-retroattività edit catalogo,
// update_expiry lock. Complementare a e2e-pkg-usage/editor/catalog.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21, SVC = 9;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["packages.clients", "packages.catalog", "packages.manage", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const capi = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
let cid = 0, pid = 0, pkgId = 0, cpId = 0;
try {
  // === setup: cliente + prodotto con stock per-sede + template catalogo ===
  let j = await capi({ action: "create", first_name: "ZZ", last_name: "PkgMut", location_id: String(LOC) });
  cid = Number(j.client?.id ?? 0);
  pid = Number((await db.query("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ PkgProd',15,5,1) RETURNING id")).rows[0].id);
  await db.query("INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES (25,$1,$2,5,1)", [pid, LOC]);
  let r = await api({ action: "catalog_save", id: "0", name: "ZZ PkgMut", validity_days: "30", location_ids: JSON.stringify([LOC]), items: JSON.stringify([{ item_type: "service", item_id: SVC, qty: 2, unit_price: 50, discount_type: "percent", discount_value: 0 }, { item_type: "product", item_id: pid, qty: 2, unit_price: 15, discount_type: "percent", discount_value: 0 }]), total_discount_type: "percent", total_discount_value: "0" });
  pkgId = Number(r.j.id ?? 0);
  check("S1 setup template ok", r.s === 200 && pkgId > 0, JSON.stringify(r.j.error ?? pkgId));
  r = await api({ action: "issue", package_id: String(pkgId), client_id: String(cid) });
  cpId = Number(r.j.clientPackage?.id ?? 0);
  check("S2 emissione ok (sedute = SOLO servizi: 2)", r.s === 200 && cpId > 0 && Number(r.j.clientPackage?.totalSessions ?? 0) === 2, JSON.stringify([r.j.error, r.j.clientPackage?.totalSessions]));
  await db.query("UPDATE client_packages SET location_id=$2 WHERE tenant_id=25 AND id=$1", [cpId, LOC]);
  // === non-retroattività edit catalogo ===
  r = await api({ action: "catalog_save", id: String(pkgId), name: "ZZ PkgMut RINOMINATO", validity_days: "60", location_ids: JSON.stringify([LOC]), items: JSON.stringify([{ item_type: "service", item_id: SVC, qty: 5, unit_price: 40, discount_type: "percent", discount_value: 0 }]), total_discount_type: "percent", total_discount_value: "0" });
  const cpRow = (await db.query("SELECT package_name, sessions_total FROM client_packages WHERE tenant_id=25 AND id=$1", [cpId])).rows[0];
  const snapCount = Number((await db.query("SELECT COUNT(*)::int n FROM client_package_items WHERE tenant_id=25 AND client_package_id=$1", [cpId])).rows[0].n);
  check("N1 edit catalogo NON retroattivo (nome congelato + snapshot 2 voci)", r.s === 200 && cpRow.package_name === "ZZ PkgMut" && Number(cpRow.sessions_total) === 2 && snapCount === 2, JSON.stringify([cpRow, snapCount]));
  // === usage PRODOTTI: ritiro scala stock per-sede + crea documento ===
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "consume", qty: "1", item_ref: `product:${pid}` });
  const ps1 = Number((await db.query("SELECT stock FROM product_stocks WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC])).rows[0]?.stock ?? -1);
  const docs1 = (await db.query("SELECT id, cause FROM stock_docs WHERE tenant_id=25 AND notes LIKE $1 ORDER BY id", [`%pacchetto cliente #${cpId}%`])).rows;
  check("U1 ritiro prodotto: stock sede 5->4 + doc scarico", r.s === 200 && ps1 === 4 && docs1.length === 1 && docs1[0].cause === "scarico", JSON.stringify([r.j.error, ps1, docs1.map((d) => d.cause)]));
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "restore", qty: "1", item_ref: `product:${pid}` });
  const ps2 = Number((await db.query("SELECT stock FROM product_stocks WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC])).rows[0]?.stock ?? -1);
  const docs2 = (await db.query("SELECT cause FROM stock_docs WHERE tenant_id=25 AND notes LIKE $1 ORDER BY id", [`%pacchetto cliente #${cpId}%`])).rows;
  check("U2 ripristino: stock 4->5 + doc carico", r.s === 200 && ps2 === 5 && docs2.length === 2 && docs2[1].cause === "carico", JSON.stringify([r.j.error, ps2]));
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "consume", qty: "3", item_ref: `product:${pid}` });
  check("U3 ritiro oltre quantità pacchetto -> rifiutato", r.s !== 200 && /insufficienti/i.test(r.j.error ?? ""), JSON.stringify(r.j.error));
  await db.query("UPDATE product_stocks SET stock=1 WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC]);
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "consume", qty: "2", item_ref: `product:${pid}` });
  check("U4 stock sede insufficiente -> verbatim", r.s !== 200 && /Stock insufficiente per registrare il ritiro/.test(r.j.error ?? ""), JSON.stringify(r.j.error));
  await db.query("UPDATE product_stocks SET stock=5 WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC]);
  // === guardie client_save ===
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "consume", qty: "1", item_ref: `service:${SVC}` });
  check("G0 seduta servizio scalata (rem 1)", r.s === 200 && Number((await db.query("SELECT sessions_remaining FROM client_packages WHERE tenant_id=25 AND id=$1", [cpId])).rows[0].sessions_remaining) === 1, JSON.stringify(r.j.error));
  const cpNow = (await db.query("SELECT expires_at::text e, purchase_date::text p, start_date::text s FROM client_packages WHERE tenant_id=25 AND id=$1", [cpId])).rows[0];
  r = await api({ action: "client_save", id: String(cpId), client_id: String(cid), package_id: String(pkgId), package_name: "ZZ PkgMut", sessions_total: "2", sessions_remaining: "1", status: "active", location_id: String(LOC), purchase_date: cpNow.p, start_date: cpNow.s, expires_at: "2099-01-01" });
  check("G1 scadenza su pacchetto USATO -> lock verbatim", r.s !== 200 && r.j.error === "Non e possibile modificare la scadenza di un pacchetto gia utilizzato.", JSON.stringify(r.j.error));
  r = await api({ action: "update_expiry", client_package_id: String(cpId), expires_at: "2099-01-01" });
  check("G2 update_expiry stesso lock (prefisso Errore:)", r.s !== 200 && /^Errore: Non e possibile modificare la scadenza/.test(r.j.error ?? ""), JSON.stringify(r.j.error));
  r = await api({ action: "client_save", id: String(cpId), client_id: String(cid), package_id: String(pkgId), package_name: "ZZ PkgMut", sessions_total: "2", sessions_remaining: "1", status: "canceled", location_id: String(LOC), purchase_date: cpNow.p, start_date: cpNow.s, expires_at: cpNow.e });
  check("G3 annullo da edit -> 'solo dal dettaglio vendita'", r.s !== 200 && r.j.error === "Il pacchetto si annulla solo dal dettaglio vendita.", JSON.stringify(r.j.error));
  r = await api({ action: "client_save", id: String(cpId), client_id: String(cid), package_id: String(pkgId), package_name: "ZZ PkgMut", sessions_total: "2", sessions_remaining: "1", status: "active", location_id: "51", purchase_date: cpNow.p, start_date: cpNow.s, expires_at: cpNow.e });
  check("G4 sede non abilitata dal catalogo -> verbatim", r.s !== 200 && r.j.error === "Pacchetto catalogo non abilitato per la sede selezionata.", JSON.stringify(r.j.error));
  // === usage su annullato ===
  await db.query("UPDATE client_packages SET status='canceled' WHERE tenant_id=25 AND id=$1", [cpId]);
  r = await api({ action: "usage_add", client_package_id: String(cpId), op: "consume", qty: "1", item_ref: `service:${SVC}` });
  check("G5 usage su annullato -> verbatim", r.s !== 200 && r.j.error === "Pacchetto annullato: non puoi registrare sedute o ritiri", JSON.stringify(r.j.error));
  await db.query("UPDATE client_packages SET status='active' WHERE tenant_id=25 AND id=$1", [cpId]);
} finally {
  // cleanup tracciato: cascata cliente (porta via client_packages+usages+figli), poi template, prodotto, documenti ZZ del pacchetto
  if (cid) await capi({ action: "delete", id: cid, delete_reason: "ZZ pacchetti pass", delete_confirm_text: "ELIMINA" }).catch(() => {});
  if (pkgId) await api({ action: "catalog_delete", id: String(pkgId) }).catch(() => {});
  if (cpId) {
    const docIds = (await db.query("SELECT id FROM stock_docs WHERE tenant_id=25 AND notes LIKE $1", [`%pacchetto cliente #${cpId}%`])).rows.map((r) => r.id);
    for (const d of docIds) { await db.query("DELETE FROM stock_doc_items WHERE tenant_id=25 AND stock_doc_id=$1", [d]); await db.query("DELETE FROM stock_docs WHERE tenant_id=25 AND id=$1", [d]); }
  }
  if (pid) { await db.query("DELETE FROM product_stocks WHERE tenant_id=25 AND product_id=$1", [pid]); await db.query("DELETE FROM products WHERE tenant_id=25 AND id=$1", [pid]); }
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM client_packages WHERE tenant_id=25 AND package_name LIKE 'ZZ Pkg%') a, (SELECT COUNT(*)::int FROM packages WHERE tenant_id=25 AND name LIKE 'ZZ Pkg%') b, (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ Pkg%') c")).rows[0];
  console.log("cleanup ZZ residui:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
