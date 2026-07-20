// Gestione Rate pass 4 (2026-07-18) — FIX: (1) classe TZ: paid_at default del
// mark_paid, cancelled_at + marker [ANNULLATA ts] dell'annullo piano (era
// toISOString = UTC anche in dev), paid_at di payDbInstallment -> ora di Roma;
// (2) annullo piano ATOMICO (piano + tutte le rate in una tx); (3) FAIL-CLOSED
// sedi revocate su lista e mutazioni (prima: scope 0 = tenant-wide).
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
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms: ["installments.manage"], needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = mkCookie("admin", [], 21);
const revokedCookie = mkCookie("manager", [9999], 9999);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/installments?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
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

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let saleId = 0, planId = 0, i1 = 0, i2 = 0;
try {
  saleId = Number((await q("INSERT INTO sales (tenant_id, client_id, location_id, sale_date, subtotal, discount, total, status, operator_name, notes) VALUES ($1,9,$2,NOW(),100,0,100,'done','luca','ZZ rate-pass4') RETURNING id", [T, LOC])).rows[0].id);
  planId = Number((await q("INSERT INTO sale_installment_plans (tenant_id, sale_id, client_id, status, sale_total, down_payment_amount, financed_amount, installments_count, payment_type) VALUES ($1,$2,9,'active',100,20,80,2,'cash') RETURNING id", [T, saleId])).rows[0].id);
  i1 = Number((await q("INSERT INTO sale_installments (tenant_id, sale_id, plan_id, client_id, installment_no, due_date, amount, status, payment_type) VALUES ($1,$2,$3,9,1,'2027-08-01',40,'pending','cash') RETURNING id", [T, saleId, planId])).rows[0].id);
  i2 = Number((await q("INSERT INTO sale_installments (tenant_id, sale_id, plan_id, client_id, installment_no, due_date, amount, status, payment_type) VALUES ($1,$2,$3,9,2,'2027-09-01',40,'pending','cash') RETURNING id", [T, saleId, planId])).rows[0].id);

  // R1 (FIX TZ): mark_paid SENZA paid_at -> default in ORA DI ROMA
  const m1 = await api({ action: "mark_paid", installment_id: String(i1), paid_amount: "", payment_type: "cash", note: "" });
  const row1 = await q1("SELECT status, paid_at::text pa, paid_amount FROM sale_installments WHERE tenant_id=$1 AND id=$2", [T, i1]);
  check("R1 mark_paid senza data: paid_at in ORA DI ROMA (±5min; guida l'Incasso Report)", m1.j?.ok === true && row1?.status === "paid" && diffMin(row1?.pa) < 5 && Number(row1?.paid_amount) === 40, JSON.stringify({ e: err(m1), row: row1, d: row1 ? Math.round(diffMin(row1.pa)) : null }));

  // R2: guardia annullo con rate pagate (senza allow_paid)
  const c0 = await api({ action: "cancel_plan", plan_id: String(planId), reason: "ZZ no" });
  check("R2 annullo con rata pagata -> guardia verbatim", err(c0) === "Esistono rate gia incassate: non e possibile annullare il piano.", JSON.stringify(err(c0)));

  // R3 (FIX TZ+ATOMICO): annullo con allow_paid -> piano+rate cancellati in tx, marker Roma
  const c1 = await api({ action: "cancel_plan", plan_id: String(planId), reason: `ZZ annullo ${RUN}`, allow_paid: "1" });
  const plan1 = await q1("SELECT status, cancelled_at::text ca, cancelled_reason FROM sale_installment_plans WHERE tenant_id=$1 AND id=$2", [T, planId]);
  const rate1 = (await q("SELECT status, note FROM sale_installments WHERE tenant_id=$1 AND plan_id=$2 ORDER BY installment_no", [T, planId])).rows;
  const romeTs = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  check("R3 annullo allow_paid: piano cancelled + cancelled_at ROMA + reason", c1.j?.ok === true && plan1?.status === "cancelled" && diffMin(plan1?.ca) < 5 && plan1?.cancelled_reason === `ZZ annullo ${RUN}`, JSON.stringify({ e: err(c1), plan: plan1 }));
  check("R3b ATOMICO: TUTTE le rate cancelled con marker [ANNULLATA <ts Roma>]", rate1.length === 2 && rate1.every((r) => r.status === "cancelled" && String(r.note ?? "").includes(`[ANNULLATA ${romeTs.slice(0, 10)}`)), JSON.stringify(rate1.map((r) => `${r.status}:${String(r.note).slice(0, 30)}`)));

  // R4 (FIX fail-closed): sessione sedi REVOCATE — lista vuota, mutazione bloccata
  const g1 = await fetch(`${BASE}/api/manage/installments?slug=${SLUG}`, { headers: { cookie: revokedCookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("R4 lista con sedi revocate -> VUOTA (fail-closed)", g1.ok === true && Array.isArray(g1.plans) && g1.plans.length === 0, JSON.stringify({ n: (g1.plans ?? []).length }));
  const g2 = await api({ action: "mark_pending", installment_id: String(i2) }, revokedCookie);
  // i2 è 'cancelled' dall'annullo R3: la mutazione bloccata NON deve toccarla.
  const row2 = await q1("SELECT status FROM sale_installments WHERE tenant_id=$1 AND id=$2", [T, i2]);
  check("R4b mutazione con sedi revocate -> 'Sede non autorizzata per questa operazione.' e rata intatta", err(g2) === "Sede non autorizzata per questa operazione." && row2?.status === "cancelled", JSON.stringify({ e: err(g2), st: row2?.status }));
  const g3 = await api({ action: "mark_paid", installment_id: String(i2), all_locations: "1", paid_amount: "", payment_type: "cash" }, revokedCookie);
  check("R4c revocato con all_locations -> scope [9999] = 'Rata non trovata o non aggiornata.'", err(g3) === "Rata non trovata o non aggiornata.", JSON.stringify(err(g3)));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of [i1, i2].filter(Boolean)) await q("DELETE FROM sale_installments WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  if (planId) await q("DELETE FROM sale_installment_plans WHERE tenant_id=$1 AND id=$2", [T, planId]).catch(() => {});
  if (saleId) await q("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, saleId]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND id>$2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM sale_installment_plans WHERE tenant_id=$1)::int p,(SELECT COUNT(*) FROM sale_installments WHERE tenant_id=$1)::int i,(SELECT COUNT(*) FROM activity_logs WHERE tenant_id=$1 AND id>$2)::int l", [T, logWatermark]);
  const clean = fin.s === 9 && fin.p === 1 && fin.i === 3 && fin.l === 0;
  console.log(`CLEANUP: sales=${fin.s}/9 plans=${fin.p}/1 rate=${fin.i}/3 logs=${fin.l} -> ${clean ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && clean ? 0 : 1);
}
