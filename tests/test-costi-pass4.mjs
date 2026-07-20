// Scadenziario e Costi pass 4 (2026-07-18) — FIX: (1) classe TZ: paid_at del
// save e del toggle_paid (era Date al driver = wall del server), timestamp
// export filename/PDF -> ora di Roma; (2) FAIL-CLOSED sedi revocate su lista,
// get, azioni costi e ALLEGATO (prima: scope-0 = lettura/mutazione tenant-wide;
// con all_locations la lista autorizzata vuota AZZERAVA la clausola).
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
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms: ["costs.manage", "costs.items", "costs.categories"], needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = mkCookie("admin", [], 21);
const revokedCookie = mkCookie("manager", [9999], 9999);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const romeNowMs = () => {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return new Date(s.replace(" ", "T")).getTime();
};
const diffMin = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeNowMs()) / 60000;

const costIds = [];
try {
  // C1 (FIX TZ): save costo PAGATO -> paid_at in ORA DI ROMA. La risposta del
  // save non espone l'id: recupero DB per titolo (ricetta e2e-costs).
  const s1 = await api({ action: "save_cost", id: "0", title: `ZZ Costo ${RUN}`, amount: "100", vat_percent: "22", due_date: "2027-08-01", is_paid: "1", location_id: "21" });
  const row1 = await q1("SELECT id, is_paid, paid_at::text pa FROM costs WHERE tenant_id=$1 AND title=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ Costo ${RUN}`]);
  const c1 = Number(row1?.id ?? 0);
  if (c1) costIds.push(c1);
  check("C1 save pagato: paid_at in ORA DI ROMA (±5min)", s1.j?.ok !== false && c1 > 0 && Number(row1?.is_paid) === 1 && diffMin(row1?.pa) < 5, JSON.stringify({ e: err(s1), row: row1, d: row1?.pa ? Math.round(diffMin(row1.pa)) : null }));

  // C2 (FIX TZ): toggle_paid su costo aperto -> paid_at ROMA
  const s2 = await api({ action: "save_cost", id: "0", title: `ZZ Costo2 ${RUN}`, amount: "50", vat_percent: "0", due_date: "2027-08-02", is_paid: "0", location_id: "21" });
  const c2 = Number((await q1("SELECT id FROM costs WHERE tenant_id=$1 AND title=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ Costo2 ${RUN}`]))?.id ?? 0);
  if (c2) costIds.push(c2);
  check("PRE C2 creato aperto", s2.j?.ok !== false && c2 > 0, JSON.stringify(err(s2)));
  const t2 = await api({ action: "toggle_paid", id: String(c2), location_id: "21" });
  const row2 = await q1("SELECT is_paid, paid_at::text pa FROM costs WHERE tenant_id=$1 AND id=$2", [T, c2]);
  check("C2 toggle_paid: paid_at in ORA DI ROMA (±5min)", t2.j?.ok !== false && Number(row2?.is_paid) === 1 && diffMin(row2?.pa) < 5, JSON.stringify({ e: err(t2), row: row2 }));

  // C3 (FIX fail-closed): sessione sedi REVOCATE
  const g1 = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("C3 lista revocato -> vuota failClosed", g1.ok === true && Array.isArray(g1.costs) && g1.costs.length === 0 && g1.failClosed === true, JSON.stringify({ n: (g1.costs ?? []).length, fc: g1.failClosed }));
  const g2 = await api({ action: "toggle_paid", id: String(c1) }, revokedCookie);
  check("C3b toggle revocato -> 'Sede non valida o non autorizzata'", err(g2) === "Sede non valida o non autorizzata", JSON.stringify(err(g2)));
  const g3 = await api({ action: "toggle_paid", id: String(c1), all_locations: "1" }, revokedCookie);
  check("C3c toggle revocato con all_locations (lista autorizzata VUOTA) -> stessa guardia", err(g3) === "Sede non valida o non autorizzata", JSON.stringify(err(g3)));
  const g4 = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}&action=get&id=${c1}`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("C3d get revocato -> 'Costo non trovato.'", String(g4.error ?? "") === "Costo non trovato.", JSON.stringify(g4.error));
  const g5 = await fetch(`${BASE}/api/manage/cost-attachment?slug=${SLUG}&id=${c1}`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG }, redirect: "manual" });
  let g5err = ""; try { g5err = String((await g5.json()).error ?? ""); } catch {}
  check("C3e allegato revocato -> 'Costo non trovato.'", g5err === "Costo non trovato.", JSON.stringify(g5err));

  // C4: export CSV — filename con timestamp ROMA
  const ex = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}&action=export&format=csv`, { headers: { cookie: adminCookie, "x-tenant-slug": SLUG } });
  const disp = String(ex.headers.get("content-disposition") ?? "");
  const romeStamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).format(new Date()).replace(/[^0-9]/g, "");
  check("C4 export: filename scadenziario_costi_<YmdH..> in ORA DI ROMA", disp.includes(`scadenziario_costi_${romeStamp.slice(0, 8)}_${romeStamp.slice(8, 10)}`), JSON.stringify({ disp, atteso: romeStamp }));

  // C5: sanity admin sede 21 — costo visibile in lista
  // Entrambi i costi sono PAGATI: la vista default (open) li esclude -> status=paid.
  const l1 = await fetch(`${BASE}/api/manage/costs?slug=${SLUG}&from=2027-08-01&to=2027-08-31&status=paid`, { headers: { cookie: adminCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("C5 lista admin sede 21 (status=paid): i 2 costi ZZ presenti", (l1.costs ?? []).filter((c) => String(c.title ?? "").startsWith("ZZ Costo")).length === 2, JSON.stringify((l1.costs ?? []).length));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of costIds) await q("DELETE FROM costs WHERE tenant_id=$1 AND id=$2 AND title LIKE 'ZZ%'", [T, id]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM costs WHERE tenant_id=$1 AND title LIKE 'ZZ%')::int c", [T]);
  const clean = fin.c === 0;
  console.log(`CLEANUP: costi ZZ residui=${fin.c} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
