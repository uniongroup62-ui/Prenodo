// Clienti pass 5 (2026-07-18) — FIX classe TZ: created_at del create (era il
// default CURRENT_TIMESTAMP UTC del DB), blocked_at del block (Date al driver),
// deleted_at di client_deletion_logs (vista permanente Eliminazioni) -> Roma.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgm = require("pg");
const url = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m)[1].trim();
const SLUG = "centroesteticoelite", SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", T = 25;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["clients.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const pool = new pgm.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const romeMs = () => { const s = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()); return new Date(s.replace(" ", "T")).getTime(); };
const dm = (s) => Math.abs(new Date(String(s).replace(" ", "T")).getTime() - romeMs()) / 60000;
const RUN = String(Date.now()).slice(-6);
const wm = Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=25")).rows[0].m);
const delLogSnap = Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM client_deletion_logs WHERE tenant_id=25")).rows[0].m);
let cid = 0;
try {
  const c = await api({ action: "create", first_name: "ZZ CliTZ", last_name: RUN, email: `zz.clitz.${RUN}@example.com` });
  const row = (await pool.query("SELECT id, created_at::text ca FROM clients WHERE tenant_id=25 AND full_name=$1", [`ZZ CliTZ ${RUN}`])).rows[0];
  cid = Number(row?.id ?? 0);
  check("P1 create: created_at ROMA (era default UTC del DB)", !!row && dm(row.ca) < 5, JSON.stringify({ ca: row?.ca, e: c?.error }));
  const b = await api({ action: "block", id: String(cid), blocked_internal_note: `ZZ nota ${RUN}` });
  const r2 = (await pool.query("SELECT is_blocked, blocked_at::text ba FROM clients WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  check("P2 block: blocked_at ROMA", Number(r2?.is_blocked) === 1 && dm(r2?.ba) < 5, JSON.stringify({ ba: r2?.ba, e: b?.error }));
  const d = await api({ action: "delete", id: String(cid), delete_reason: `ZZ del ${RUN}`, delete_confirm_text: "ELIMINA", stock_restore_mode: "no_restore" });
  const gone = (await pool.query("SELECT COUNT(*) n FROM clients WHERE tenant_id=25 AND id=$1", [cid])).rows[0];
  const lg = (await pool.query("SELECT id, deleted_at::text da, client_names FROM client_deletion_logs WHERE tenant_id=25 AND id>$1 ORDER BY id DESC LIMIT 1", [delLogSnap])).rows[0];
  check("P3 delete cascata: cliente rimosso + deletion-log con deleted_at ROMA", Number(gone.n) === 0 && !!lg && dm(lg.da) < 5 && String(lg.client_names).includes(`ZZ CliTZ ${RUN}`), JSON.stringify({ e: d?.error, gone: gone.n, lg }));
  if (Number(gone.n) === 0) cid = 0;
  if (lg?.id) await pool.query("DELETE FROM client_deletion_logs WHERE tenant_id=25 AND id=$1", [lg.id]);
} catch (e) { check("EXCEPTION", false, e.stack || e.message); }
finally {
  if (cid) await pool.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1 AND full_name LIKE 'ZZ%'", [cid]).catch(() => {});
  await pool.query("DELETE FROM activity_logs WHERE tenant_id=25 AND id>$1", [wm]).catch(() => {});
  const fin = (await pool.query("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=25)::int c,(SELECT COUNT(*) FROM client_deletion_logs WHERE tenant_id=25 AND id>$1)::int d,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=25 AND id>$2)::int l", [delLogSnap, wm])).rows[0];
  const clean = fin.c === 5 && fin.d === 0 && fin.l === 0;
  console.log(`CLEANUP: clients=${fin.c}/5 delLogs=${fin.d} logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
