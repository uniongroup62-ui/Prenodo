// Magazzino pass 2 (2026-07-18) — FIX: (1) classe TZ: move_date default,
// canceled_at annullo documento, stamp filename export -> ora di Roma;
// (2) FAIL-CLOSED per il RISTRETTO senza sede risolta: GET contesto (la lista
// documenti a scope-0 = UNIONE) e doc save a sede 0/assente bloccati; admin a
// sede 0 = unione FEDELE (invariata).
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
function mkCookie(role, locationIds, current) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms: ["products.manage", "stock_moves.manage", "product_categories.manage"], needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = mkCookie("admin", [], 21);
const admin0Cookie = mkCookie("admin", [], 0);
const restrictedCookie = mkCookie("manager", [21], 21);
const revokedCookie = mkCookie("manager", [9999], 9999);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/products?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const romeToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", dateStyle: "short" }).format(new Date());
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const diffMin = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeNowMs()) / 60000;

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let pid = 0; const docIds = [];
try {
  pid = Number((await q("INSERT INTO products (tenant_id, name, price, is_active, stock) VALUES ($1,$2,10,1,0) RETURNING id", [T, `ZZ Prod ${RUN}`])).rows[0].id);
  await q("INSERT INTO product_stocks (tenant_id, product_id, location_id, stock) VALUES ($1,$2,$3,0)", [T, pid, LOC]);

  // M1 (FIX TZ): carico senza move_date -> move_date = OGGI di Roma
  const c1 = await api({ action: "move_stock", location_id: String(LOC), cause: "carico", items_json: JSON.stringify([{ product_id: pid, qty: 10 }]) });
  const doc1 = Number(c1.j?.stockDocId ?? 0);
  if (doc1) docIds.push(doc1);
  const row1 = await q1("SELECT move_date::text md FROM stock_docs WHERE tenant_id=$1 AND id=$2", [T, doc1]);
  check("M1 carico: move_date default = OGGI di ROMA", c1.j?.ok !== false && doc1 > 0 && String(row1?.md).slice(0, 10) === romeToday, JSON.stringify({ e: err(c1), md: row1?.md, atteso: romeToday }));

  // M2 (FIX TZ): annullo doc -> canceled_at ROMA
  const a1 = await api({ action: "stock_doc_cancel", id: String(doc1) });
  const row2 = await q1("SELECT is_canceled, canceled_at::text ca FROM stock_docs WHERE tenant_id=$1 AND id=$2", [T, doc1]);
  check("M2 annullo doc: canceled_at in ORA DI ROMA (±5min) + stock ripristinato", a1.j?.ok !== false && Number(row2?.is_canceled) === 1 && diffMin(row2?.ca) < 5, JSON.stringify({ e: err(a1), row: row2 }));

  // M3 (FIX fail-closed): ristretto a sede 0/assente -> bloccato; revocato GET -> 403
  const g1 = await api({ action: "move_stock", cause: "carico", items_json: JSON.stringify([{ product_id: pid, qty: 1 }]) }, restrictedCookie);
  check("M3 ristretto SENZA location_id -> 'Sede non disponibile per le tue sedi.'", g1.status === 403 && err(g1) === "Sede non disponibile per le tue sedi.", JSON.stringify(err(g1)));
  const g2 = await fetch(`${BASE}/api/manage/products?slug=${SLUG}`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("M3b GET revocato -> 403 fail-closed", String(g2.error ?? "") === "Sede non disponibile per le tue sedi.", JSON.stringify(g2.error));
  const g3 = await fetch(`${BASE}/api/manage/products?slug=${SLUG}`, { headers: { cookie: admin0Cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("M3c GET admin sede 0 -> OK (unione fedele)", g3.ok === true || Array.isArray(g3.products), JSON.stringify({ ok: g3.ok, e: g3.error }));

  // M4: sanity ristretto sede 21 -> carico ok
  const c2 = await api({ action: "move_stock", location_id: String(LOC), cause: "carico", items_json: JSON.stringify([{ product_id: pid, qty: 2 }]) }, restrictedCookie);
  const doc2 = Number(c2.j?.stockDocId ?? 0);
  if (doc2) docIds.push(doc2);
  const st = await q1("SELECT stock FROM product_stocks WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3", [T, pid, LOC]);
  check("M4 ristretto sede 21: carico ok (stock 2 dopo annullo del 10)", c2.j?.ok !== false && doc2 > 0 && Number(st?.stock) === 2, JSON.stringify({ e: err(c2), st: st?.stock }));

  // M5 (FIX TZ): export CSV -> filename con stamp ROMA
  const ex = await fetch(`${BASE}/api/manage/products?slug=${SLUG}&action=export`, { headers: { cookie: adminCookie, "x-tenant-slug": SLUG } });
  const disp = String(ex.headers.get("content-disposition") ?? "");
  check("M5 export: filename movimenti_magazzino_<data Roma>", disp.includes(`movimenti_magazzino_${romeToday}_`), JSON.stringify(disp));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of docIds) {
    await q("DELETE FROM stock_doc_items WHERE tenant_id=$1 AND stock_doc_id=$2", [T, id]).catch(() => {});
    await q("DELETE FROM stock_docs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  }
  if (pid) {
    await q("DELETE FROM product_stocks WHERE tenant_id=$1 AND product_id=$2", [T, pid]).catch(() => {});
    await q("DELETE FROM products WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'", [T, pid]).catch(() => {});
  }
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM products WHERE tenant_id=$1)::int p,(SELECT COUNT(*) FROM stock_docs WHERE tenant_id=$1 AND id=ANY($2::int[]))::int d,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$3)::int l", [T, docIds.length ? docIds : [0], logWatermark]);
  const clean = fin.p === 0 && fin.d === 0 && fin.l === 0;
  console.log(`CLEANUP: prodotti=${fin.p}/0 docs=${fin.d} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
