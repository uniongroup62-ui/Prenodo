// Migliorie Clienti 2026-07-16 (approvate): (1) avviso duplicati non bloccante,
// (2) paginazione 50/pagina, (3) checkbox ripristino magazzino nel delete.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const apiFull = (b, ck = cookie) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
// Sessione con SOLO quick_booking (drawer QB): il gate duplicati deve coprire anche lei.
const p64qb = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "staff", perms: ["appointments.quick_booking"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookieQb = `beautysuite_session_t_${SLUG}=${p64qb}.${crypto.createHmac("sha256", SECRET).update(p64qb).digest("base64url")}`;
const get = (qs) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}${qs}`, { headers: { cookie } }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const ids = [];
try {
  // === 1. BLOCCO duplicati con conferma (409 -> duplicate_confirmed=1) ===
  let j = await api({ action: "create", first_name: "ZZ", last_name: "DupA", email: "zz-dup@test.local", phone: "+39 333 7654321", location_id: String(LOC) });
  ids.push(Number(j.client?.id ?? 0));
  check("D1 primo create: nessun blocco", j.ok === true && ids[0] > 0, JSON.stringify(j.error));
  let r = await apiFull({ action: "create", first_name: "ZZ", last_name: "DupB", email: "ZZ-DUP@test.local", location_id: String(LOC) });
  check("D2 stessa email (case diverso) -> 409 BLOCCATO prima di creare", r.s === 409 && r.j.needsDuplicateConfirm === true && /questa email: ZZ DupA/.test(String(r.j.error ?? "")), JSON.stringify([r.s, r.j.error]));
  const nBefore = Number((await db.query("SELECT COUNT(*)::int n FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ Dup%'")).rows[0].n);
  check("D2b il blocco NON ha creato nulla", nBefore === 1, `ZZ Dup=${nBefore}`);
  r = await apiFull({ action: "create", first_name: "ZZ", last_name: "DupB", email: "ZZ-DUP@test.local", location_id: String(LOC), duplicate_confirmed: "1" });
  ids.push(Number(r.j.client?.id ?? 0));
  check("D3 conferma esplicita -> crea", r.s === 200 && r.j.ok === true && ids[1] > 0, JSON.stringify(r.j.error));
  r = await apiFull({ action: "create", first_name: "ZZ", last_name: "DupC", phone: "3337654321", location_id: String(LOC) });
  check("D4 stesso telefono (formato diverso, +39 vs nudo) -> 409", r.s === 409 && /questo telefono: ZZ DupA/.test(String(r.j.error ?? "")), JSON.stringify([r.s, r.j.error]));
  // Percorso QB (drawer): sessione con SOLO appointments.quick_booking -> stesso gate.
  r = await apiFull({ action: "create", first_name: "ZZ", last_name: "DupQB", email: "zz-dup@test.local", location_id: String(LOC) }, cookieQb);
  check("D5 percorso QB (solo perm quick_booking) -> 409 BLOCCATO", r.s === 409 && r.j.needsDuplicateConfirm === true, JSON.stringify([r.s, r.j.error]));
  r = await apiFull({ action: "create", first_name: "ZZ", last_name: "DupQB", email: "zz-dup@test.local", location_id: String(LOC), duplicate_confirmed: "1" }, cookieQb);
  ids.push(Number(r.j.client?.id ?? 0));
  check("D6 percorso QB con conferma -> crea", r.s === 200 && r.j.ok === true && ids[2] > 0, JSON.stringify(r.j.error));
  // === 2. paginazione ===
  const p1 = await get("&p=1");
  const p2 = await get("&p=2");
  const noP = await get("");
  const total = Number(p1.totalCount ?? 0);
  check("P1 p=1: max 25 righe + pageSize 25 + totale filtrato", (p1.clients ?? []).length <= 25 && Number(p1.pageSize) === 25 && total >= (p1.clients ?? []).length, `rows=${(p1.clients ?? []).length} total=${total}`);
  const ids1 = new Set((p1.clients ?? []).map((c) => c.id));
  const overlap = (p2.clients ?? []).some((c) => ids1.has(c.id));
  check("P2 p=2: nessuna sovrapposizione con p=1", !overlap && (total > 25 ? (p2.clients ?? []).length > 0 : (p2.clients ?? []).length === 0), `rows2=${(p2.clients ?? []).length}`);
  check("P3 somma pagine coerente col totale", total <= 25 ? (p1.clients ?? []).length === total : true, "");
  check("P4 senza ?p= comportamento storico (LIMIT 200)", (noP.clients ?? []).length <= 200 && Number(noP.currentPage ?? 1) === 1, `rows=${(noP.clients ?? []).length}`);
  // === 3. delete summary + restore esposto ===
  const pid = Number((await db.query("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ DupStock',10,3,1) RETURNING id")).rows[0].id);
  await db.query("INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES (25,$1,$2,3,1)", [pid, LOC]);
  const saleId = Number((await db.query("INSERT INTO sales (tenant_id,client_id,total,sale_date,status,location_id) VALUES (25,$1,10,NOW(),'completed',$2) RETURNING id", [ids[2], LOC])).rows[0].id);
  await db.query("INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES (25,$1,'product',$2,'ZZ DupStock',1,10,10)", [saleId, pid]);
  const sum = await get(`&action=delete_summary&id=${ids[2]}`);
  check("S1 summary espone prodotti_scalati_stock=1", Number(sum.summary?.prodotti_scalati_stock ?? 0) === 1, JSON.stringify(sum.summary?.prodotti_scalati_stock));
  j = await api({ action: "delete", id: ids[2], delete_reason: "ZZ improvements", delete_confirm_text: "ELIMINA", stock_restore_mode: "restore_stock" });
  const ps = (await db.query("SELECT stock FROM product_stocks WHERE tenant_id=25 AND product_id=$1 AND location_id=$2", [pid, LOC])).rows[0];
  check("S2 delete con restore -> per-sede 3->4", j.ok === true && Number(ps?.stock) === 4, `stock=${ps?.stock} restored=${j.restoredStockQty}`);
  ids[2] = 0;
  await db.query("DELETE FROM product_stocks WHERE tenant_id=25 AND product_id=$1", [pid]);
  await db.query("DELETE FROM products WHERE tenant_id=25 AND id=$1", [pid]);
} finally {
  for (const id of ids) if (id > 0) await api({ action: "delete", id, delete_reason: "ZZ cleanup", delete_confirm_text: "ELIMINA" }).catch(() => {});
  const left = (await db.query("SELECT COUNT(*)::int n FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ Dup%'")).rows[0].n;
  console.log("cleanup: ZZ Dup residui =", left);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
