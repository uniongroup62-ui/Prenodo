// Report audit blocco server (2026-07-21): (bug 2) classificazione metodo di
// pagamento dalla colonna strutturata payment_methods {base} con fallback nota
// e "Non indicato" quando manca tutto; (bug 3) eventi fidelity scritti in UTC
// (transactions.created_at / giftcards.issued_at) attribuiti al giorno di ROMA
// al confine di mezzanotte. Finestre remote isolate; cleanup per id tracciati.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["reports.view"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1000)); } } }
async function report(params) {
  const res = await fetch(`${BASE}/api/manage/reports?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const ids = { sales: [], tx: [], gc: [] };

try {
  // ===== BUG 2: metodi di pagamento =====
  const PW = "&from=2027-05-01&to=2027-05-31"; // finestra isolata
  const seedSale = async (over) => {
    const r = await q(
      `INSERT INTO sales (tenant_id, sale_date, status, total, subtotal, discount, credit_used, giftcard_used, location_id, operator_name, notes, payment_methods, client_id)
       VALUES ($1,$2,'done',$3,$3,0,0,0,21,'luca',$4,$5,NULL) RETURNING id`,
      [T, over.sale_date, over.total, over.notes ?? null, over.payment_methods ?? null],
    );
    const id = Number(r.rows[0].id); ids.sales.push(id); return id;
  };
  // A: solo colonna strutturata {base:cash}, nessuna nota -> Contanti
  await seedSale({ sale_date: "2027-05-05 10:00:00", total: 100, notes: null, payment_methods: '{"base":"cash"}' });
  // B: solo nota legacy -> Bonifico
  await seedSale({ sale_date: "2027-05-06 10:00:00", total: 70, notes: "Tipo pagamento: Bonifico", payment_methods: null });
  // C: né colonna né nota -> Non indicato
  await seedSale({ sale_date: "2027-05-07 10:00:00", total: 40, notes: "Solo una nota qualsiasi", payment_methods: null });
  // D: colonna {base:card} vince anche se la nota dicesse altro (qui coerente)
  await seedSale({ sale_date: "2027-05-08 10:00:00", total: 30, notes: null, payment_methods: '{"base":"card"}' });

  const pm = (await report(PW)).j?.analytics?.paymentMethods ?? [];
  const amtOf = (label) => pm.find((m) => m.label === label)?.amount ?? 0;
  check("B2 struttura {base:cash} -> Contanti 100", amtOf("Contanti") === 100, JSON.stringify(pm.map((m) => [m.label, m.amount])));
  check("B2 nota legacy -> Bonifico 70", amtOf("Bonifico") === 70);
  check("B2 senza metodo -> Non indicato 40", amtOf("Non indicato") === 40);
  check("B2 struttura {base:card} -> Carte 30", amtOf("Carte") === 30);
  check("B2 totale incasso coerente (240)", (await report(PW)).j?.analytics?.summary?.totalRevenue === 240);

  // ===== BUG 3: confine mezzanotte fidelity (Roma vs UTC) =====
  // Estate (+2): un evento a UTC 2027-08-14 23:30 è 2027-08-15 01:30 a Roma.
  const cid = Number((await q("SELECT id FROM clients WHERE tenant_id=$1 ORDER BY id LIMIT 1", [T])).rows[0].id);
  const seedTx = async (createdAtUtc, pts) => {
    const r = await q(
      `INSERT INTO transactions (tenant_id, client_id, kind, delta_points, note, created_by, location_id, location_name, created_at)
       VALUES ($1,$2,'earn',$3,'ZZ audit',20,21,'Sede1',$4) RETURNING id`,
      [T, cid, pts, createdAtUtc],
    );
    const id = Number(r.rows[0].id); ids.tx.push(id); return id;
  };
  await seedTx("2027-08-14 23:30:00", 50);  // -> Roma 15/08 01:30 : DENTRO il 15
  await seedTx("2027-08-15 23:30:00", 7);   // -> Roma 16/08 01:30 : FUORI dal 15

  const seedGc = async (issuedUtc, amt) => {
    const r = await q(
      `INSERT INTO giftcards (tenant_id, code, initial_amount, balance, currency, status, issued_at, location_id, location_name, created_at, updated_at)
       VALUES ($1,$2,$3,$3,'EUR','active',$4,21,'Sede1',NOW(),NOW()) RETURNING id`,
      [T, `ZZAUD-${RUN}`, amt, issuedUtc],
    );
    const id = Number(r.rows[0].id); ids.gc.push(id); return id;
  };
  await seedGc("2027-08-14 23:30:00", 25); // -> Roma 15/08 : DENTRO

  const fp15 = (await report("&from=2027-08-15&to=2027-08-15")).j?.analytics?.fidelityPeriod ?? {};
  check("B3 punti evento 23:30 UTC del 14 contati nel 15 Roma (=50)", Number(fp15.pointsIssued) === 50, JSON.stringify(fp15.pointsIssued));
  check("B3 giftcard emessa 23:30 UTC del 14 contata nel 15 Roma (=25)", Number(fp15.giftcardsIssuedAmount) === 25, JSON.stringify(fp15.giftcardsIssuedAmount));

  const fp14 = (await report("&from=2027-08-14&to=2027-08-14")).j?.analytics?.fidelityPeriod ?? {};
  check("B3 il 14 Roma NON contiene l'evento (0 punti)", Number(fp14.pointsIssued) === 0, JSON.stringify(fp14.pointsIssued));
  const fp16 = (await report("&from=2027-08-16&to=2027-08-16")).j?.analytics?.fidelityPeriod ?? {};
  check("B3 il 16 Roma contiene solo il secondo evento (=7)", Number(fp16.pointsIssued) === 7, JSON.stringify(fp16.pointsIssued));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const id of ids.tx) await q("DELETE FROM transactions WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  for (const id of ids.gc) await q("DELETE FROM giftcards WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  for (const id of ids.sales) await q("DELETE FROM sales WHERE tenant_id=$1 AND id=$2", [T, id]).catch(() => {});
  const left = Number((await q("SELECT (SELECT COUNT(*) FROM sales WHERE tenant_id=$1 AND id=ANY($2)) + (SELECT COUNT(*) FROM transactions WHERE tenant_id=$1 AND id=ANY($3)) + (SELECT COUNT(*) FROM giftcards WHERE tenant_id=$1 AND id=ANY($4)) n", [T, ids.sales.length ? ids.sales : [0], ids.tx.length ? ids.tx : [0], ids.gc.length ? ids.gc : [0]])).rows[0].n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  await pool.end();
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`\nTOT: ${pass}/${R.length} PASS`);
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
