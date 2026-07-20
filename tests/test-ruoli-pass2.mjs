// Ruoli pass 2 (2026-07-17) — FIX: replace permessi TRANSAZIONALE (roles.php
// 119-128) + created_at audit in ora app-locale. + riverifica gate solo-Admin
// (legacyCan), filtro non-assegnabili, normalize (auto access + scarta
// ereditati), validate requireChild, audit skip-se-identico e old RAW.
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
function makeCookie(role, perms) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie("admin", []);
const mgrCookie = makeCookie("manager", ["roles.manage"]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/permissions?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");

const auditWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM role_permission_audit_log WHERE tenant_id=$1", [T]))?.m ?? 0);
const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const dbPerms = async (role) => (await q("SELECT perm FROM role_permissions WHERE tenant_id=$1 AND role=$2 ORDER BY perm", [T, role])).rows.map((r) => r.perm);
const freshAudit = async () => (await q("SELECT id, role, old_perms, new_perms, created_at::text ca FROM role_permission_audit_log WHERE tenant_id=$1 AND id > $2 ORDER BY id", [T, auditWatermark])).rows;
try {
  // S0: gate — non-admin ANCHE con roles.manage in sessione viene negato
  const s0 = await api({ action: "save_role_perms", role: "staff", perms: ["clients.manage"] }, mgrCookie);
  check("S0 non-admin con roles.manage NEGATO (non-assegnabile => solo Admin)", s0.status === 403 && err(s0) === "Non hai i permessi per accedere a questa sezione.", JSON.stringify(err(s0)));
  const g0 = await fetch(`${BASE}/api/manage/permissions?slug=${SLUG}`, { headers: { cookie: mgrCookie, "x-tenant-slug": SLUG } });
  check("S0b GET non-admin 403", g0.status === 403, String(g0.status));

  // S1: save staff con figlio pacchetti -> normalize AUTO-aggiunge packages.access
  const s1 = await api({ action: "save_role_perms", role: "staff", perms: ["clients.manage", "packages.clients"] });
  const p1 = await dbPerms("staff");
  check("S1 save staff: normalize auto-aggiunge packages.access", s1.j?.ok === true && p1.includes("clients.manage") && p1.includes("packages.clients") && p1.includes("packages.access"), JSON.stringify(p1));
  const a1 = await freshAudit();
  const caH = Number(String(a1[0]?.ca ?? "").slice(11, 13));
  const nowH = new Date().getHours();
  check("S1b audit: old=[] RAW, new ordinato, created_at ORA LOCALE", a1.length === 1 && a1[0].role === "staff" && a1[0].old_perms === "[]" && JSON.parse(a1[0].new_perms).includes("packages.access") && (Math.abs(caH - nowH) <= 1 || Math.abs(caH - nowH) === 23), JSON.stringify({ n: a1.length, ca: a1[0]?.ca, nowH }));

  // S2: save IDENTICO -> audit SKIP (nessuna riga nuova)
  const s2 = await api({ action: "save_role_perms", role: "staff", perms: p1 });
  const a2 = await freshAudit();
  check("S2 save identico: audit skip-se-identico", s2.j?.ok === true && a2.length === 1, `audit=${a2.length}`);

  // S3: permesso NON assegnabile filtrato (roles.manage non finisce nel DB)
  const s3 = await api({ action: "save_role_perms", role: "altro", perms: ["roles.manage", "clients.manage"] });
  const p3 = await dbPerms("altro");
  check("S3 non-assegnabile filtrato: 'altro' salva solo clients.manage", s3.j?.ok === true && !p3.includes("roles.manage") && p3.includes("clients.manage"), JSON.stringify(p3));

  // S4: validate requireChild — access senza figli -> errore modulo
  const s4 = await api({ action: "save_role_perms", role: "altro", perms: ["packages.access"] });
  check("S4 access senza figli -> 'seleziona almeno una funzione del modulo'", s4.j?.ok !== true && /seleziona almeno una funzione del modulo\.$/.test(err(s4)), JSON.stringify(err(s4)));
  const p4 = await dbPerms("altro");
  check("S4b il save fallito NON tocca i permessi esistenti", JSON.stringify(p4) === JSON.stringify(p3), JSON.stringify(p4));

  // S5: ruolo sconosciuto -> coerce a staff (legacy 'if !isset -> staff')
  const s5 = await api({ action: "save_role_perms", role: "boh", perms: ["clients.manage"] });
  check("S5 ruolo sconosciuto coerce a 'staff'", s5.j?.ok === true && s5.j?.role === "staff", JSON.stringify(s5.j?.role));

  // S6: svuota entrambi i ruoli (restore baseline) via API
  const s6a = await api({ action: "save_role_perms", role: "staff", perms: [] });
  const s6b = await api({ action: "save_role_perms", role: "altro", perms: [] });
  const pf = { staff: await dbPerms("staff"), altro: await dbPerms("altro") };
  check("S6 svuotamento ruoli ok (baseline vuota ripristinata)", s6a.j?.ok === true && s6b.j?.ok === true && pf.staff.length === 0 && pf.altro.length === 0, JSON.stringify(pf));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("DELETE FROM role_permissions WHERE tenant_id=$1", [T]).catch(() => {});
  await q("DELETE FROM role_permission_audit_log WHERE tenant_id=$1 AND id > $2", [T, auditWatermark]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id > $2 AND module='impostazioni'", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM role_permissions WHERE tenant_id=$1)::int rp,(SELECT COUNT(*) FROM role_permission_audit_log WHERE tenant_id=$1 AND id > $2)::int au", [T, auditWatermark]);
  const okBase = fin.rp === 0 && fin.au === 0;
  console.log(`CLEANUP: role_perms=${fin.rp} auditExtra=${fin.au} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
