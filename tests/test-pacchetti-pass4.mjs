// Pacchetti pass 4 (2026-07-18) — FIX classe TZ: addDaysDate (base dei DEFAULT
// scadenza: pacchetti +validity_days, condiviso con giftcard +365 e preventivi
// +30) partiva da new Date() locale del server -> base OGGI di ROMA.
// P1: emissione pacchetto senza expires_at -> purchase/start = oggi Roma,
// expires = oggi Roma + validity_days; snapshot items presente.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgm = require("pg");
const url = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m)[1].trim();
const SLUG = "centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", T = 25;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["packages.clients", "packages.catalog", "packages.manage", "packages.access"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "FAIL" === l ? "FAIL" : "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const pool = new pgm.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const romeToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", dateStyle: "short" }).format(new Date());
const RUN = String(Date.now()).slice(-6);
const wm = Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=25")).rows[0].m);
let catId = 0, cpId = 0;
try {
  catId = Number((await pool.query("INSERT INTO packages (tenant_id, name, price, validity_days, is_active, service_id, sessions_total) VALUES ($1,$2,100,60,1,9,10) RETURNING id", [T, `ZZ PackTZ ${RUN}`])).rows[0].id);
  await pool.query("INSERT INTO package_services (tenant_id, package_id, service_id, sessions_total) VALUES ($1,$2,9,10)", [T, catId]).catch(() => {});
  const iss = await api({ action: "issue", package_id: String(catId), client_id: "9" });
  const row = (await pool.query("SELECT id, purchase_date::text pd, start_date::text sd, expires_at::text ea, sessions_remaining FROM client_packages WHERE tenant_id=$1 AND package_id=$2 ORDER BY id DESC LIMIT 1", [T, catId])).rows[0];
  cpId = Number(row?.id ?? 0);
  const expected = (() => { const [y, m, d] = romeToday.split("-").map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + 60); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`; })();
  check("P1 emissione: purchase/start = OGGI Roma, expires = +60gg da Roma", !!row && String(row.pd).slice(0, 10) === romeToday && String(row.sd).slice(0, 10) === romeToday && String(row.ea).slice(0, 10) === expected, JSON.stringify({ e: iss?.error, row, expected }));
  const items = (await pool.query("SELECT COUNT(*)::int n FROM client_package_items WHERE tenant_id=$1 AND client_package_id=$2", [T, cpId])).rows[0];
  const sv = (await pool.query("SELECT COUNT(*)::int n FROM client_package_services WHERE tenant_id=$1 AND client_package_id=$2", [T, cpId])).rows[0];
  check("P1b snapshot: items + sedute servizio presenti", items.n >= 1 && sv.n >= 1, JSON.stringify({ items: items.n, sv: sv.n }));
} catch (e) { check("EXCEPTION", false, e.stack || e.message); }
finally {
  if (cpId) {
    for (const t of ["client_package_usages", "client_package_items", "client_package_services"]) await pool.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND client_package_id=$2`, [T, cpId]).catch(() => {});
    await pool.query("DELETE FROM client_packages WHERE tenant_id=$1 AND id=$2", [T, cpId]).catch(() => {});
  }
  if (catId) {
    for (const t of ["package_services", "package_items"]) await pool.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND package_id=$2`, [T, catId]).catch(() => {});
    await pool.query("DELETE FROM packages WHERE tenant_id=$1 AND id=$2", [T, catId]).catch(() => {});
  }
  await pool.query("DELETE FROM activity_logs WHERE tenant_id=25 AND id>$1", [wm]).catch(() => {});
  const fin = (await pool.query("SELECT (SELECT COUNT(*) FROM packages WHERE tenant_id=25 AND name LIKE 'ZZ%')::int p,(SELECT COUNT(*) FROM client_packages WHERE tenant_id=25 AND package_name LIKE 'ZZ%')::int cp,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=25 AND id>$1)::int l", [wm])).rows[0];
  const clean = fin.p === 0 && fin.cp === 0 && fin.l === 0;
  console.log(`CLEANUP: catZZ=${fin.p} cpZZ=${fin.cp} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
