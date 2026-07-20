// Pass Clienti 2026-07-16: validazioni ostili + ciclo vita + cascata delete
// con ripristino stock PER-SEDE (fix restoreProductStockForSales).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["clients.manage", "appointments.quick_booking"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
let cid = 0, pid = 0, saleId = 0, apptId = 0;
try {
  // === A. validazioni ostili (create) ===
  let j = await api({ action: "create", first_name: "", last_name: "" });
  check("A1 nome vuoto", j.error === "Nome e cognome obbligatori", JSON.stringify(j.error));
  j = await api({ action: "create", first_name: "ZZ", last_name: "Mut", email: "rotta@" });
  check("A2 email invalida", j.error === "Email non valida.", JSON.stringify(j.error));
  j = await api({ action: "create", first_name: "ZZ", last_name: "Mut", pec: "x@y" });
  check("A3 PEC invalida", j.error === "PEC non valida.", JSON.stringify(j.error));
  j = await api({ action: "create", first_name: "ZZ", last_name: "Mut", birth_date: "2020-99-99" });
  check("A4 data nascita 2020-99-99", j.error === "Data di nascita non valida.", JSON.stringify(j.error));
  j = await api({ action: "create", first_name: "ZZ", last_name: "Mut", registration_date: "2026-02-30" });
  check("A5 data iscrizione 30 feb", j.error === "Data iscrizione non valida.", JSON.stringify(j.error));
  j = await api({ action: "create", first_name: "ZZ", last_name: "Mut", location_id: "999999" });
  check("A6 sede inesistente", j.error === "Seleziona una sede valida.", JSON.stringify(j.error));
  // === B. ciclo vita ===
  j = await api({ action: "create", first_name: "ZZ", last_name: "MutCycle", email: "zz-mut@test.local", location_id: String(LOC) });
  cid = Number(j.client?.id ?? 0);
  check("B1 create ok", j.ok === true && cid > 0, `id=${cid}`);
  const row = (await db.query("SELECT points,credit_balance,is_blocked,location_id FROM clients WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("B2 default: punti 0, credito 0, non bloccato, sede 21", Number(row.points) === 0 && Number(row.credit_balance) === 0 && Number(row.is_blocked) === 0 && Number(row.location_id) === LOC, JSON.stringify(row));
  j = await api({ action: "update", id: cid, first_name: "ZZ", last_name: "MutCycle2", email: "zz-mut2@test.local", location_id: "51" });
  check("B3 update nome+sede 51", j.ok === true && /MutCycle2/.test(j.client?.name ?? "") && Number(j.client?.locationId ?? 0) === 51, JSON.stringify([j.client?.name, j.client?.locationId]));
  j = await api({ action: "update", id: cid, first_name: "ZZ", last_name: "MutCycle2" });
  check("B4 update SENZA sede postata -> errore (edit la esige)", j.error === "Seleziona una sede valida.", JSON.stringify(j.error));
  j = await api({ action: "update", id: 999999, first_name: "X", last_name: "Y", location_id: String(LOC) });
  check("B5 update id inesistente -> errore", j.ok !== true, JSON.stringify(j.error ?? j.ok));
  j = await api({ action: "block", id: cid, blocked_internal_note: "" });
  check("B6 block senza nota -> errore verbatim", j.error === "Inserisci una nota interna con il motivo della disattivazione.", JSON.stringify(j.error));
  j = await api({ action: "block", id: cid, blocked_internal_note: "ZZ motivo test" });
  check("B7 block ok (sparisce dalla lista default)", j.ok === true && !(j.clients ?? []).some((c) => c.id === cid), JSON.stringify(j.client?.name));
  j = await api({ action: "unblock", id: cid });
  const rowU = (await db.query("SELECT is_blocked,blocked_at,blocked_internal_note FROM clients WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("B8 unblock pulisce nota+data", j.ok === true && Number(rowU.is_blocked) === 0 && rowU.blocked_at === null && rowU.blocked_internal_note === null, JSON.stringify(rowU));
  // tag case-insensitive
  j = await api({ action: "add_tag", id: cid, tag: "ZZTagMut" });
  check("B9 add_tag", j.ok === true && (j.tags ?? []).some((t) => t.name === "ZZTagMut"), JSON.stringify(j.tags));
  j = await api({ action: "add_tag", id: cid, tag: "zztagmut" });
  const tagRows = (await db.query("SELECT id,name FROM customer_tags WHERE tenant_id=25 AND LOWER(name)='zztagmut'")).rows;
  check("B10 add_tag case-insensitive: 1 solo tag", tagRows.length === 1, JSON.stringify(tagRows));
  j = await api({ action: "remove_tag", id: cid, tag_id: tagRows[0]?.id });
  check("B11 remove_tag smappa", j.ok === true && !(j.tags ?? []).some((t) => Number(t.id) === Number(tagRows[0]?.id)), JSON.stringify(j.tags));
  // === C. cascata delete con restore stock PER-SEDE ===
  pid = Number((await db.query("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ MutStock',10,5,1) RETURNING id")).rows[0].id);
  await db.query("INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES (25,$1,$2,5,1)", [pid, LOC]);
  saleId = Number((await db.query("INSERT INTO sales (tenant_id,client_id,total,sale_date,status,location_id) VALUES (25,$1,20,NOW(),'completed',$2) RETURNING id", [cid, LOC])).rows[0].id);
  await db.query("INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES (25,$1,'product',$2,'ZZ MutStock',2,10,20)", [saleId, pid]);
  apptId = Number((await db.query("INSERT INTO appointments (tenant_id,client_id,starts_at,ends_at,status,location_id,notes) VALUES (25,$1,'2027-11-05 10:00:00','2027-11-05 11:00:00','scheduled',$2,'ZZ mut appt') RETURNING id", [cid, LOC])).rows[0].id);
  j = await api({ action: "delete", id: cid, delete_reason: "", delete_confirm_text: "ELIMINA" });
  check("C1 delete senza motivo -> errore", String(j.error ?? "").includes("motivazione"), JSON.stringify(j.error));
  j = await api({ action: "delete", id: cid, delete_reason: "ZZ test", delete_confirm_text: "elimina" });
  check("C2 conferma sbagliata -> errore verbatim", j.error === "Per confermare scrivi ELIMINA.", JSON.stringify(j.error));
  j = await api({ action: "delete", id: cid, delete_reason: "ZZ pass clienti", delete_confirm_text: "ELIMINA", stock_restore_mode: "restore_stock" });
  check("C3 delete ok + restoredStockQty=2", j.ok === true && Number(j.restoredStockQty ?? 0) === 2, JSON.stringify([j.ok, j.restoredStockQty, j.counts]));
  const gone = await db.query("SELECT (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND id=$1) c,(SELECT COUNT(*)::int FROM appointments WHERE tenant_id=25 AND id=$2) a,(SELECT COUNT(*)::int FROM sales WHERE tenant_id=25 AND id=$3) s,(SELECT COUNT(*)::int FROM sale_items WHERE tenant_id=25 AND sale_id=$3) si", [cid, apptId, saleId]);
  check("C4 cascata: cliente+appt+vendita+items eliminati", Object.values(gone.rows[0]).every((v) => Number(v) === 0), JSON.stringify(gone.rows[0]));
  const ps = (await db.query("SELECT stock FROM product_stocks WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC])).rows[0];
  const pTot = (await db.query("SELECT stock FROM products WHERE tenant_id=25 AND id=$1", [pid])).rows[0];
  check("C5 stock PER-SEDE ripristinato 5->7 (fix)", Number(ps?.stock) === 7, `per-sede=${ps?.stock}`);
  check("C6 products.stock risincronizzato = 7", Number(pTot?.stock) === 7, `tot=${pTot?.stock}`);
  cid = 0; saleId = 0; apptId = 0;
  // baseline
  const base = await db.query("SELECT (SELECT COUNT(*)::int FROM appointments WHERE tenant_id=25) a,(SELECT COUNT(*)::int FROM sales WHERE tenant_id=25) s,(SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ %') z");
  check("C7 baseline intatto (10 appt / 9 sales / 0 ZZ)", Number(base.rows[0].a) === 10 && Number(base.rows[0].s) === 9 && Number(base.rows[0].z) === 0, JSON.stringify(base.rows[0]));
} finally {
  if (apptId) await db.query("DELETE FROM appointments WHERE tenant_id=25 AND id=$1", [apptId]).catch(() => {});
  if (saleId) { await db.query("DELETE FROM sale_items WHERE tenant_id=25 AND sale_id=$1", [saleId]).catch(() => {}); await db.query("DELETE FROM sales WHERE tenant_id=25 AND id=$1", [saleId]).catch(() => {}); }
  if (cid) { await db.query("DELETE FROM customer_tag_map WHERE tenant_id=25 AND client_id=$1", [cid]).catch(() => {}); await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cid]).catch(() => {}); }
  await db.query("DELETE FROM customer_tags WHERE tenant_id=25 AND LOWER(name)='zztagmut'").catch(() => {});
  if (pid) { await db.query("DELETE FROM product_stocks WHERE tenant_id=25 AND product_id=$1", [pid]).catch(() => {}); await db.query("DELETE FROM products WHERE tenant_id=25 AND id=$1", [pid]).catch(() => {}); }
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
