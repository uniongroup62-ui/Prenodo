// Portafoglio pass 2 (2026-07-17) — angoli non coperti dalla suite pass-1:
//  A) disponibile RAW NEGATIVO (riservati > saldo, availablePointsRaw legacy)
//  B) refs 'Vincolati su' inline troncati a 3 con '+N' (5 prenotazioni)
//  C) lock-lots SCADUTI: quota 'vincolata' nel calendario + lockedExpired
//     (esclusi da nextExpiry); done/canceled NON riservano
//  D) clamp txPage oltre l'ultima pagina
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["fidelity.manage", "fidelity.wallet"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function wallet(cid, page = 1) {
  const r = await fetch(`${BASE}/api/manage/fidelity?slug=${SLUG}&action=wallet&client_id=${cid}&p=${page}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  return (await r.json())?.wallet?.detail ?? null;
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let cid = 0, cardId = 0, cid2 = 0, card2 = 0, snapExp = null; const apptIds = [];
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, points, created_at) VALUES ($1,$2,21,10,NOW()) RETURNING id", [T, `ZZ WalP2 ${RUN}`])).rows[0].id);
  cardId = Number((await q("INSERT INTO cards (tenant_id, code, client_id, issued_at, status) VALUES ($1,$2,$3,CURRENT_DATE,'active') RETURNING id", [T, `ZZWP${RUN}`, cid])).rows[0].id);

  // 5 prenotazioni aperte con punti (10+5*4=30 riservati > saldo 10) + 1 done e 1 canceled (NON riservano)
  for (let i = 0; i < 5; i++) {
    const r = await q("INSERT INTO appointments (tenant_id, client_id, public_code, starts_at, ends_at, status, fidelity_points_used) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [T, cid, `ZZWP${RUN}${i}`, `2027-03-0${i + 1} 10:00`, `2027-03-0${i + 1} 11:00`, i % 2 === 0 ? "pending" : "scheduled", i === 0 ? 10 : 5]);
    apptIds.push(Number(r.rows[0].id));
  }
  for (const st of ["done", "canceled"]) {
    const r = await q("INSERT INTO appointments (tenant_id, client_id, starts_at, ends_at, status, fidelity_points_used) VALUES ($1,$2,'2027-03-10 10:00','2027-03-10 11:00',$3,50) RETURNING id", [T, cid, st]);
    apptIds.push(Number(r.rows[0].id));
  }

  // A+B: saldo 10, riservati 30 -> disponibile RAW -20; refs inline 3 + '+2'
  const d1 = await wallet(cid);
  check("A1 riservati SOLO pending/scheduled (30, done/canceled esclusi)", d1 && d1.reserved === 30, `res=${d1?.reserved}`);
  check("A2 disponibile RAW negativo (10-30=-20, mai clampato)", d1 && d1.pointsBalance === 10 && d1.available === -20, `bal=${d1?.pointsBalance} av=${d1?.available}`);
  check("B1 sospesi: 5 righe, totale sconto 30", d1 && d1.pendingCount === 5 && d1.pendingDiscountTotal === 30, `n=${d1?.pendingCount} tot=${d1?.pendingDiscountTotal}`);
  check("B2 refs inline troncati '+2'", d1 && /\+2$/.test(d1.pendingLockRefsInline) && d1.pendingLockRefsInline.split(",").length === 3, JSON.stringify(d1?.pendingLockRefsInline));
  check("B3 refs title completi (5)", d1 && d1.pendingLockRefsTitle.split(",").length === 5, JSON.stringify(d1?.pendingLockRefsTitle));

  // C: flusso REALE lock-lots — punti da lotto in scadenza + prenotazione che li
  // protegge (created_at < oggi): l'expire-on-read SPOSTA il residuo in lock-lot
  // (quota 'vincolata' nel calendario, esclusa da nextExpiry).
  // NB: il primo tentativo con lotti seminati a mano era irrealistico: il motore
  // sblocca (unlock) i lock non coperti da prenotazioni protette — comportamento corretto.
  snapExp = await q1("SELECT fidelity_expire_enabled ee, fidelity_expire_days ed FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  await q("UPDATE businesses SET fidelity_expire_enabled=1, fidelity_expire_days=30 WHERE tenant_id=$1", [T]);
  cid2 = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, points, created_at) VALUES ($1,$2,21,0,NOW()) RETURNING id", [T, `ZZ WalP2b ${RUN}`])).rows[0].id);
  card2 = Number((await q("INSERT INTO cards (tenant_id, code, client_id, issued_at, status) VALUES ($1,$2,$3,CURRENT_DATE,'active') RETURNING id", [T, `ZZWQ${RUN}`, cid2])).rows[0].id);
  // +10 punti via API (crea tx + lotto con scadenza +30gg)
  await fetch(`${BASE}/api/manage/fidelity?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify({ action: "wallet_move", client_id: cid2, op: "add", points: 10, note: "zz walp2b" }) });
  // backdate: lotto scaduto IERI + prenotazione protetta (created_at ieri) che riserva 10
  await q("UPDATE point_lots SET expires_at = (CURRENT_DATE - 1)::timestamp + interval '23 hours 59 minutes 59 seconds' WHERE tenant_id=$1 AND client_id=$2", [T, cid2]);
  const ap2 = await q("INSERT INTO appointments (tenant_id, client_id, public_code, starts_at, ends_at, status, fidelity_points_used, created_at) VALUES ($1,$2,$3,'2027-04-01 10:00','2027-04-01 11:00','scheduled',10, NOW() - interval '1 day') RETURNING id", [T, cid2, `ZZWQ${RUN}A`]);
  apptIds.push(Number(ap2.rows[0].id));

  const d2 = await wallet(cid2);
  const lockRow = (d2?.schedule || []).find((r) => r.lockedPoints > 0);
  check("C1 expire-on-read: residuo protetto spostato in lock-lot (quota vincolata nel calendario)", !!lockRow && lockRow.points === 10 && lockRow.lockedPoints === 10, JSON.stringify(d2?.schedule));
  check("C2 lockedExpired=10 esposto + saldo intatto (protetto, non scaduto)", d2 && d2.lockedExpired === 10 && d2.pointsBalance === 10, `le=${d2?.lockedExpired} bal=${d2?.pointsBalance}`);
  check("C3 nextExpiry NON indica il lock scaduto", d2 && d2.nextExpiryPoints === 0 && d2.nextExpiryAt === "", `next=${JSON.stringify(d2?.nextExpiryAt)} pts=${d2?.nextExpiryPoints}`);
  check("C4 riservati 10 / disponibile RAW 0", d2 && d2.reserved === 10 && d2.available === 0, `res=${d2?.reserved} av=${d2?.available}`);

  // D: 25 transazioni -> 2 pagine; p=99 clampa all'ultima
  for (let i = 0; i < 23; i++) {
    await q("INSERT INTO transactions (tenant_id, client_id, kind, source_type, delta_points, note, created_at) VALUES ($1,$2,'manual','manual',1,$3,NOW())", [T, cid, `zzwp2 filler ${i}`]);
  }
  const d3 = await wallet(cid, 99);
  const expRows = d3 ? d3.txTotal - 20 * (d3.txPages - 1) : -1;
  check("D1 txPage clampata all'ultima + righe coerenti col totale", d3 && d3.txPages >= 2 && d3.txPage === d3.txPages && d3.movements.length === expRows, `pages=${d3?.txPages} page=${d3?.txPage} rows=${d3?.movements.length} tot=${d3?.txTotal}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptIds.length) await q("DELETE FROM appointments WHERE tenant_id=$1 AND id = ANY($2::int[])", [T, apptIds]).catch(() => {});
  await q("UPDATE businesses SET fidelity_expire_enabled=COALESCE($2,0), fidelity_expire_days=COALESCE($3,365) WHERE tenant_id=$1", [T, (typeof snapExp !== "undefined" && snapExp) ? snapExp.ee : 0, (typeof snapExp !== "undefined" && snapExp) ? snapExp.ed : 365]).catch(() => {});
  for (const c2 of [cid2]) if (c2) {
    await q("DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2", [T, c2]).catch(() => {});
    await q("DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, c2]).catch(() => {});
    if (card2) await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, card2]).catch(() => {});
    await q("DELETE FROM card_code_registry WHERE tenant_id=$1 AND code=$2", [T, `ZZWQ${RUN}`]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='fidelity' AND entity_id=$2", [T, c2]).catch(() => {});
  }
  if (cid2) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid2]).catch(() => {});
  if (cid) {
    await q("DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    if (cardId) await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, cardId]).catch(() => {});
    await q("DELETE FROM card_code_registry WHERE tenant_id=$1 AND code=$2", [T, `ZZWP${RUN}`]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='fidelity' AND entity_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id = ANY($3::int[])) n", [T, cid || 0, apptIds.length ? apptIds : [0]])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
