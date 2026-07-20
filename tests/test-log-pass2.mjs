// Log pass 2 (2026-07-17) — FIX: created_at/cutoff retention in ORA DI ROMA
// server-safe. + riverifica: retention 30gg forzata sul list, scoping per-sede
// dei NON-admin (righe E distinct dei filtri), gate a permessi con mappa
// views, ricerca con escape dei metacaratteri LIKE, filtri esatti.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
function makeCookie(role, perms, locationIds) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie("admin", [], []);
const mgrCookie = makeCookie("manager", ["logs.view"], [21]);
const mgrNoPermCookie = makeCookie("manager", ["clients.manage"], [21]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(params, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/logs?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const rome = (deltaDays = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(Date.now() + deltaDays * 86400000)).replace("T", " ");
const MOD = `zzlog${RUN}`;

const tracked = [];
async function seed(over = {}) {
  const r = await q(`INSERT INTO activity_logs (tenant_id, created_at, user_id, user_label, location_id, module, action, entity_type, entity_id, label, details_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,NULL) RETURNING id`,
    [T, over.created_at ?? rome(0), 20, over.user_label ?? "ZZ LogUser", over.location_id ?? 21, MOD, over.action ?? "modifica", over.label ?? `ZZ voce ${RUN}`]);
  tracked.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}
try {
  // Semina: sede 21, sede 51 (con user distintivo), senza sede, vecchia 31gg, recente 29gg
  await seed({ location_id: 21, label: `ZZ ventuno ${RUN}` });
  await seed({ location_id: 51, label: `ZZ cinquantuno ${RUN}`, user_label: "ZZ SoloSede51" });
  await seed({ location_id: null, label: `ZZ globale ${RUN}` });
  const oldId = await seed({ created_at: rome(-31), label: `ZZ vecchissima ${RUN}` });
  await seed({ created_at: rome(-29), label: `ZZ ventinove ${RUN}` });
  await seed({ location_id: 21, action: "elimina", label: `ZZ 100% sconto ${RUN}` });

  // L1: la voce API (logActivity reale) e la retention forzata sul list
  const l1 = await api(`&module=${MOD}&q=${encodeURIComponent(RUN)}`);
  const labels = (l1.j?.rows ?? []).map((r) => r.label);
  const oldGone = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, oldId]))?.n);
  check("L1 retention 30gg FORZATA sul list: la voce di 31gg sparisce, quella di 29 resta", oldGone === 0 && labels.some((x) => x.includes("ventinove")) && !labels.some((x) => x.includes("vecchissima")), JSON.stringify({ oldGone, n: labels.length }));

  // L2: created_at in ORA DI ROMA
  const rowNow = (l1.j?.rows ?? []).find((r) => r.label.includes("ventuno"));
  const hourOk = rowNow && Math.abs(Number(rowNow.createdAt.slice(11, 13)) - Number(rome().slice(11, 13))) <= 1;
  check("L2 created_at wall-time di Roma", Boolean(hourOk), JSON.stringify({ ca: rowNow?.createdAt, rome: rome().slice(0, 16) }));

  // L3: non-admin ristretto a 21 -> vede 21 + senza-sede, NON la 51; distinct scoped
  const l3 = await api(`&module=${MOD}`, mgrCookie);
  const l3labels = (l3.j?.rows ?? []).map((r) => r.label);
  check("L3 scoping sede: 21+NULL visibili, 51 nascosta", l3labels.some((x) => x.includes("ventuno")) && l3labels.some((x) => x.includes("globale")) && !l3labels.some((x) => x.includes("cinquantuno")), JSON.stringify(l3labels));
  check("L3b DISTINCT operatori scoped (ZZ SoloSede51 assente per il ristretto)", !(l3.j?.users ?? []).includes("ZZ SoloSede51"), JSON.stringify((l3.j?.users ?? []).filter((u) => u.startsWith("ZZ"))));

  // L4: admin vede tutto (51 inclusa) e il distinct completo
  const l4 = await api(`&module=${MOD}`);
  check("L4 admin: sede 51 visibile + distinct completo", (l4.j?.rows ?? []).some((r) => r.label.includes("cinquantuno")) && (l4.j?.users ?? []).includes("ZZ SoloSede51"), "");

  // L5: gates
  const l5 = await api("", mgrNoPermCookie);
  check("L5 senza permessi log -> 403 'Accesso negato.'", l5.status === 403 && String(l5.j?.error) === "Accesso negato.", JSON.stringify(l5.j?.error));
  const l5b = await api("&view=deletions", mgrCookie);
  check("L5b logs.view senza logs.deletions -> 403 con mappa views", l5b.status === 403 && l5b.j?.views?.activity === true && l5b.j?.views?.deletions === false, JSON.stringify(l5b.j?.views));

  // L6: ricerca con '%' letterale (escape LIKE)
  const l6 = await api(`&module=${MOD}&q=${encodeURIComponent("100%")}`);
  const l6labels = (l6.j?.rows ?? []).map((r) => r.label);
  check("L6 q='100%' matcha SOLO la voce col % letterale", l6labels.length === 1 && l6labels[0].includes("100% sconto"), JSON.stringify(l6labels));

  // L7: filtro azione esatto
  const l7 = await api(`&module=${MOD}&action=elimina`);
  check("L7 filtro azione esatto (solo 'elimina')", (l7.j?.rows ?? []).every((r) => r.action === "elimina") && (l7.j?.rows ?? []).length === 1, JSON.stringify((l7.j?.rows ?? []).map((r) => r.action)));

  // L8: vista eliminazioni (admin) risponde con shape corretta
  const l8 = await api("&view=deletions");
  check("L8 vista Eliminazioni clienti (permanente) ok", l8.j?.ok === true && Array.isArray(l8.j?.rows) && typeof l8.j?.totalCount === "number", JSON.stringify({ n: l8.j?.rows?.length, t: l8.j?.totalCount }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of tracked) await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND module=$2", [T, MOD]))?.n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
