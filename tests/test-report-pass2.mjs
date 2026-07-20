// Report pass 2 (2026-07-17) — FIX: guardia sede sul param extra location_id
// (ristretto NON legge altre sedi) + default date in ora LOCALE. + riverifica
// motore: incasso a eventi di cassa (istantanee + acconti + rate per paid_at),
// netto credito/giftcard, annullate escluse, metodi da note, composizione con
// typeLabel dal nome, costi perm-gated.
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
function makeCookie(role, perms, locationIds, current = 21) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie("admin", ["reports.view", "costs.manage", "commissions.manage"], []);
const adminNoCostCookie = makeCookie("admin", ["reports.view"], []);
const mgrCookie = makeCookie("manager", ["reports.view"], [21]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
async function report(params, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/reports?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const W = "&from=2027-02-01&to=2027-02-28"; // finestra remota, isolata

const ids = { sales: [], items: [], plans: [], inst: [] };
async function seedSale(over = {}) {
  const r = await q(`INSERT INTO sales (tenant_id, sale_date, status, total, subtotal, discount, fidelity_discount, credit_used, giftcard_used, location_id, operator_name, notes, client_id)
    VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [T, over.sale_date ?? "2027-02-10 10:00:00", over.status ?? "done", over.total ?? 100, over.subtotal ?? over.total ?? 100, over.discount ?? 0, over.credit_used ?? 0, over.giftcard_used ?? 0, over.location_id ?? 21, "luca", over.notes ?? "Tipo pagamento: Contanti", over.client_id ?? null]);
  ids.sales.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}
try {
  // Fixtures finestra 2027-02:
  const s1 = await seedSale({ total: 100, notes: "Tipo pagamento: Contanti" });            // istantanea 100 contanti
  const s2 = await seedSale({ total: 80, credit_used: 30, notes: "Tipo pagamento: Carta di credito" }); // netto 50 carte
  const s3 = await seedSale({ total: 999, status: "cancelled" });                            // esclusa
  const s4 = await seedSale({ total: 200, sale_date: "2027-02-12 15:00:00", notes: "Tipo pagamento: Bonifico" }); // piano rate
  const p4 = await q("INSERT INTO sale_installment_plans (tenant_id, sale_id, down_payment_amount) VALUES ($1,$2,50) RETURNING id", [T, s4]);
  ids.plans.push(Number(p4.rows[0].id));
  // Track IMMEDIATO per riga (trappola: push cumulativo dopo il 2° insert =
  // orfano non tracciato se il 2° fallisce — successo il 17/07, rata 239).
  const i1 = await q("INSERT INTO sale_installments (tenant_id, sale_id, plan_id, installment_no, due_date, amount, paid_amount, status, paid_at) VALUES ($1,$2,$3,1,'2027-02-20',75,75,'paid','2027-02-20 09:00:00') RETURNING id", [T, s4, p4.rows[0].id]);
  ids.inst.push(Number(i1.rows[0].id));
  const i2 = await q("INSERT INTO sale_installments (tenant_id, sale_id, plan_id, installment_no, due_date, amount, status) VALUES ($1,$2,$3,2,'2027-03-20',75,'pending') RETURNING id", [T, s4, p4.rows[0].id]);
  ids.inst.push(Number(i2.rows[0].id));
  const it1 = await q("INSERT INTO sale_items (tenant_id, sale_id, item_type, item_name, qty, line_total) VALUES ($1,$2,'service','ZZ Taglio',1,100),($1,$3,'product','Ricarica Credito ZZ',1,50) RETURNING id", [T, s1, s2]);
  ids.items.push(...it1.rows.map((r) => Number(r.id)));

  // K1: incasso a eventi = 100 (istantanea) + 50 (netto s2) + 50 (acconto) + 75 (rata pagata) = 275; venduto = 100+50+200 = 350
  const k1 = await report(W);
  const a = k1.j?.analytics ?? {};
  check("K1 incasso EVENTI DI CASSA (istantanee+netto+acconto+rata paid) = 275, movimenti 4", a.summary?.totalRevenue === 275 && a.summary?.collectionMovements === 4, JSON.stringify(a.summary));
  check("K1b venduto NETTO = 350 (annullata esclusa, credito scalato), vendite 3", a.summary?.soldRevenue === 350 && a.summary?.saleCount === 3, JSON.stringify({ s: a.summary?.soldRevenue, c: a.summary?.saleCount }));
  const pm = Object.fromEntries((a.paymentMethods ?? []).map((m) => [m.label, m.amount]));
  check("K1c metodi dalle note: Contanti 100, Carte 50, Bonifico 125 (acconto+rata)", pm.Contanti === 100 && pm.Carte === 50 && pm.Bonifico === 125, JSON.stringify(pm));
  const daily = Object.fromEntries((a.daily ?? []).map((d) => [d.day, d.revenue]));
  check("K1d daily per data-evento: 10/02=150, 12/02=50, 20/02=75", daily["2027-02-10"] === 150 && daily["2027-02-12"] === 50 && daily["2027-02-20"] === 75, JSON.stringify(daily));
  const comp = Object.fromEntries((a.composition ?? []).map((c) => [c.label, c.revenue]));
  check("K1e composizione: 'Ricarica' dal NOME (type product) + Prodotto sempre presente", comp.Servizio === 100 && comp.Ricarica === 50 && "Prodotto" in comp, JSON.stringify(comp));

  // K2: costi/commissioni perm-gated
  const k2 = await report(W, adminNoCostCookie);
  check("K2 senza permessi costi/commissioni -> sezioni null", k2.j?.analytics?.costs === null && k2.j?.analytics?.commissions === null, JSON.stringify({ c: k2.j?.analytics?.costs, m: k2.j?.analytics?.commissions }));

  // G1 (FIX): manager ristretto a 21 chiede location_id=51 -> IGNORATO (ripiego 21)
  const zz51 = await seedSale({ total: 77, location_id: 51, sale_date: "2027-02-15 10:00:00" });
  const g1 = await report(`${W}&location_id=51`, mgrCookie);
  const g1a = g1.j?.analytics ?? {};
  check("G1 guardia sede: ristretto con location_id=51 NON vede la vendita di sede 51 (ripiego 21)", g1.j?.locationLabel === "Sede1" && g1a.summary?.soldRevenue === 350, JSON.stringify({ l: g1.j?.locationLabel, s: g1a.summary?.soldRevenue }));
  const g2 = await report(`${W}&location_id=51`, adminCookie);
  check("G1b admin con location_id=51 vede SOLO la sede 51 (77)", g2.j?.locationLabel === "Sede 2" && g2.j?.analytics?.summary?.soldRevenue === 77, JSON.stringify({ l: g2.j?.locationLabel, s: g2.j?.analytics?.summary?.soldRevenue }));

  // G3: all_locations per il ristretto = solo le SUE sedi (21) senza NULL
  const g3 = await report(`${W}&all_locations=1`, mgrCookie);
  check("G3 all_locations ristretto: resta sede 21 (350)", g3.j?.analytics?.summary?.soldRevenue === 350, JSON.stringify(g3.j?.analytics?.summary?.soldRevenue));
  const g4 = await report(`${W}&all_locations=1`, adminCookie);
  check("G4 all_locations admin: 21+51 (427)", g4.j?.analytics?.summary?.soldRevenue === 427, JSON.stringify(g4.j?.analytics?.summary?.soldRevenue));

  // K3: default date LOCALI (senza from/to): from = primo del mese, to = oggi (Roma)
  const rome = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const k3 = await report("");
  check("K3 default date in ora locale (from=1° mese, to=oggi Roma)", k3.j?.analytics?.from === `${rome.slice(0, 7)}-01` && k3.j?.analytics?.to === rome, JSON.stringify({ f: k3.j?.analytics?.from, t: k3.j?.analytics?.to, rome }));

  // K4: confronto periodo precedente di pari durata
  const k4 = await report(`${W}&compare=1`);
  const cmp = k4.j?.analytics?.comparison;
  check("K4 confronto: finestra precedente di pari durata (04/01-31/01)", cmp?.from === "2027-01-04" && cmp?.to === "2027-01-31", JSON.stringify({ f: cmp?.from, t: cmp?.to }));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const i of ids.inst) await q("DELETE FROM sale_installments WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  for (const i of ids.plans) await q("DELETE FROM sale_installment_plans WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  for (const i of ids.items) await q("DELETE FROM sale_items WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  for (const i of ids.sales) await q("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  const fin = Number((await q("SELECT COUNT(*) n FROM sales WHERE tenant_id=$1", [T])).rows[0].n);
  const okBase = fin === 9;
  console.log(`CLEANUP: sales=${fin}/9 -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
