// Servizi miglioria 2026-07-17: guardia anti-duplicato sul nome categoria
// (case-insensitive; il rename che conserva il proprio nome resta permesso).
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["service_categories.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/services?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let idA = 0, idB = 0;
try {
  const c1 = await api({ action: "category_save", name: `ZZ CatDup${RUN}` });
  idA = Number((await q1("SELECT id FROM service_categories WHERE tenant_id=$1 AND name=$2", [T, `ZZ CatDup${RUN}`]))?.id ?? 0);
  check("S1 prima categoria creata", c1.j?.ok === true && idA > 0, JSON.stringify(c1.j?.error ?? ""));

  const d1 = await api({ action: "category_save", name: `ZZ CatDup${RUN}` });
  check("D1 duplicato esatto rifiutato", d1.j?.ok !== true && d1.j?.error === "Esiste già una categoria con questo nome", JSON.stringify(d1.j?.error));
  const d2 = await api({ action: "category_save", name: `zz catdup${RUN}` });
  check("D2 duplicato case-insensitive rifiutato ('zz catdup')", d2.j?.ok !== true && d2.j?.error === "Esiste già una categoria con questo nome", JSON.stringify(d2.j?.error));
  const n1 = Number((await q1("SELECT COUNT(*) n FROM service_categories WHERE tenant_id=$1 AND LOWER(name)=LOWER($2)", [T, `ZZ CatDup${RUN}`]))?.n ?? -1);
  check("D3 nessuna riga duplicata scritta", n1 === 1, `n=${n1}`);

  const c2 = await api({ action: "category_save", name: `ZZ CatDupB${RUN}` });
  idB = Number((await q1("SELECT id FROM service_categories WHERE tenant_id=$1 AND name=$2", [T, `ZZ CatDupB${RUN}`]))?.id ?? 0);
  check("S2 seconda categoria creata", c2.j?.ok === true && idB > 0, "");
  const r1 = await api({ action: "category_save", id: String(idB), name: `ZZ CatDup${RUN}` });
  check("D4 rename su nome altrui rifiutato", r1.j?.ok !== true && r1.j?.error === "Esiste già una categoria con questo nome", JSON.stringify(r1.j?.error));
  const r2 = await api({ action: "category_save", id: String(idB), name: `ZZ CatDupB${RUN}` });
  check("D5 rename che conserva il PROPRIO nome permesso", r2.j?.ok === true, JSON.stringify(r2.j?.error ?? ""));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const i of [idA, idB]) if (i) await q("DELETE FROM service_categories WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='servizi' AND label LIKE $2", [T, `%ZZ CatDup%`]).catch(() => {});
  const left = Number((await q1("SELECT COUNT(*) n FROM service_categories WHERE tenant_id=$1 AND name LIKE $2", [T, `ZZ CatDup%`]))?.n ?? -1);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
