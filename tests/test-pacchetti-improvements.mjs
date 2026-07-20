// Migliorie Pacchetti 2026-07-16 (approvate): (1) paginazione 25 lista clienti,
// (2) sede all'emissione compat, (3) badge 'Scade tra N giorni' (statusKey+dati API).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f0846".replace("3f0846", "3f20846"), SLUG = "centroesteticoelite", LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["packages.clients", "packages.catalog", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const get = (qs) => fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}${qs}`, { headers: { cookie } }).then((r) => r.json());
const post = (b) => fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const capi = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
let cid = 0, pkgId = 0;
try {
  let j = await capi({ action: "create", first_name: "ZZ", last_name: "PagerPkg", location_id: String(LOC) });
  cid = Number(j.client?.id ?? 0);
  // 30 pacchetti cliente seminati per la paginazione (+1 in scadenza tra 5 giorni)
  await db.query(`INSERT INTO client_packages (tenant_id, client_id, package_name, purchase_date, start_date, expires_at, sessions_total, sessions_remaining, status, location_id, updated_at)
    SELECT 25, $1, 'ZZ PagerPkg '||g, CURRENT_DATE, CURRENT_DATE, CURRENT_DATE + 200, 5, 5, 'active', $2, NOW() - (g||' seconds')::interval FROM generate_series(1, 30) g`, [cid, LOC]);
  await db.query(`INSERT INTO client_packages (tenant_id, client_id, package_name, purchase_date, start_date, expires_at, sessions_total, sessions_remaining, status, location_id, updated_at)
    VALUES (25, $1, 'ZZ PagerPkg SCADENTE', CURRENT_DATE, CURRENT_DATE, CURRENT_DATE + 5, 5, 3, 'active', $2, NOW())`, [cid, LOC]);
  // === 1. paginazione ===
  const p1 = await get("&action=client_list&status=all&q=ZZ PagerPkg&p=1");
  const p2 = await get("&action=client_list&status=all&q=ZZ PagerPkg&p=2");
  const noP = await get("&action=client_list&status=all&q=ZZ PagerPkg");
  const s1 = new Set((p1.clientPackages ?? []).map((x) => x.id));
  const overlap = (p2.clientPackages ?? []).some((x) => s1.has(x.id));
  check("P1 p=1: 25 righe + totale 31 + pageSize 25", (p1.clientPackages ?? []).length === 25 && Number(p1.totalCount) === 31 && Number(p1.pageSize) === 25, `rows=${(p1.clientPackages ?? []).length} tot=${p1.totalCount}`);
  check("P2 p=2: 6 righe, zero overlap", (p2.clientPackages ?? []).length === 6 && !overlap, `rows2=${(p2.clientPackages ?? []).length} overlap=${overlap}`);
  check("P3 senza ?p= comportamento storico (tutte, cap 300)", (noP.clientPackages ?? []).length === 31, `rows=${(noP.clientPackages ?? []).length}`);
  // === 3. dati badge scadenza: statusKey + expiresAt della riga in scadenza ===
  const expRow = (p1.clientPackages ?? []).find((x) => x.packageName === "ZZ PagerPkg SCADENTE");
  check("B1 riga in scadenza: statusKey active + sedute residue + data entro 14gg", !!expRow && expRow.statusKey === "active" && expRow.sessionsRemaining === 3 && expRow.expiresAt !== "", JSON.stringify(expRow ? { k: expRow.statusKey, r: expRow.sessionsRemaining, e: expRow.expiresAt } : null));
  const days = expRow ? Math.round((new Date(expRow.expiresAt + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : -1;
  check("B2 giorni alla scadenza = 5 (finestra badge <= 14)", days === 5, `days=${days}`);
  // marker del testo badge nel bundle della pagina
  const html = await fetch(`http://localhost:3000/${SLUG}/packages?tab=clients`, { headers: { cookie } }).then((r) => r.text());
  let blob = html;
  for (const m of html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)) blob += await fetch(`http://localhost:3000${m[0]}`).then((r) => r.text()).catch(() => "");
  check("B3 bundle contiene i testi del badge", blob.includes("Scade domani") && blob.includes("Scade oggi"), "");
  // === 2. sede all'emissione compat ===
  let r = await post({ action: "catalog_save", id: "0", name: "ZZ PagerPkg CAT", validity_days: "30", location_ids: JSON.stringify([LOC]), items: JSON.stringify([{ item_type: "service", item_id: 9, qty: 1, unit_price: 50, discount_type: "percent", discount_value: 0 }]), total_discount_type: "percent", total_discount_value: "0" });
  pkgId = Number(r.j.id ?? 0);
  r = await post({ action: "issue", package_id: String(pkgId), client_id: String(cid) });
  const issuedId = Number(r.j.clientPackage?.id ?? 0);
  const issuedLoc = Number((await db.query("SELECT location_id FROM client_packages WHERE tenant_id=25 AND id=$1", [issuedId])).rows[0]?.location_id ?? 0);
  check("S1 emissione compat: location_id = sede sessione (21)", r.s === 200 && issuedId > 0 && issuedLoc === LOC, `loc=${issuedLoc}`);
} finally {
  if (cid) await capi({ action: "delete", id: cid, delete_reason: "ZZ pacchetti improvements", delete_confirm_text: "ELIMINA" }).catch(() => {});
  if (pkgId) await post({ action: "catalog_delete", id: String(pkgId) }).catch(() => {});
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM client_packages WHERE tenant_id=25 AND package_name LIKE 'ZZ PagerPkg%') a, (SELECT COUNT(*)::int FROM packages WHERE tenant_id=25 AND name LIKE 'ZZ PagerPkg%') b, (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ PagerPkg%') c")).rows[0];
  console.log("cleanup ZZ residui:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
