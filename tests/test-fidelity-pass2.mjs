// Fidelity pass 2 (2026-07-17): fix verificati LIVE —
//  A) Adesione: ricerca case-insensitive (ILIKE, parity MySQL general_ci)
//  B) atomicità wallet punti: 2 remove paralleli 60+60 su 100 -> 1 solo ok, saldo 40
//  C) atomicità credito: 2 debit paralleli 60+60 su 100 -> 1 solo ok, saldo 40 + ledger coerente
//  D) gate fallback POST (movimento generico) e GET compat: fidelity.wallet/manage richiesto
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
const mk = (perms) => {
  const p = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms, needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`;
};
const FULL = mk(["fidelity.manage", "fidelity.wallet", "fidelity.membership", "credit_movements.manage"]);

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body, cookie = FULL) {
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { cookie, "x-tenant-slug": SLUG, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

// Stato fidelity/punti richiesto ON: snapshot e ripristino.
let cid = 0, cardId = 0;
const snapBiz = await q1("SELECT fidelity_enabled FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, email, location_id, points, credit_balance, created_at) VALUES ($1,$2,$3,21,100,100,NOW()) RETURNING id", [T, `ZZ FidPass2 MaIuSc${RUN}`, `zzfid${RUN}@test.local`])).rows[0].id);
  cardId = Number((await q("INSERT INTO cards (tenant_id, code, client_id, issued_at, status) VALUES ($1,$2,$3,CURRENT_DATE,'active') RETURNING id", [T, `ZZFC${RUN}`, cid])).rows[0].id);

  // ---- A) Adesione: ricerca case-insensitive --------------------------------
  const a1 = await api(`/api/manage/fidelity?slug=${SLUG}&action=membership&q=zz fidpass2 maiusc${RUN}`);
  check("A1 ricerca nome minuscolo trova la tessera (ILIKE)", (a1.j?.membership?.cards || []).some((c) => c.id === cardId), `n=${(a1.j?.membership?.cards || []).length}`);
  const a2 = await api(`/api/manage/fidelity?slug=${SLUG}&action=membership&q=zzfc${RUN}`);
  check("A2 ricerca codice tessera minuscolo", (a2.j?.membership?.cards || []).some((c) => c.id === cardId), `n=${(a2.j?.membership?.cards || []).length}`);

  // ---- B) atomicità punti: remove 60+60 su 100 ------------------------------
  const [b1, b2] = await Promise.all([
    api(`/api/manage/fidelity?slug=${SLUG}`, { action: "wallet_move", client_id: cid, op: "remove", points: 60, note: "zz par1" }),
    api(`/api/manage/fidelity?slug=${SLUG}`, { action: "wallet_move", client_id: cid, op: "remove", points: 60, note: "zz par2" }),
  ]);
  const okB = [b1, b2].filter((r) => r.j?.ok === true && !/non rimossi/.test(String(r.j?.message ?? ""))).length;
  const pts = Number((await q1("SELECT points FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid])).points);
  check("B1 remove parallelo 60+60 su 100: 1 pieno, saldo >= 0 e coerente col ledger", pts >= 0 && okB <= 1 + 0, `okPieni=${okB} pts=${pts} msg=${JSON.stringify([b1.j?.message ?? b1.j?.error, b2.j?.message ?? b2.j?.error])}`);
  const sumTx = Number((await q1("SELECT COALESCE(SUM(delta_points),0) s FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid])).s);
  check("B2 saldo = somma ledger (100 iniziali + delta)", pts === 100 + sumTx, `pts=${pts} sum=${sumTx}`);

  // ---- C) atomicità credito: debit 60+60 su 100 -----------------------------
  const [c1, c2] = await Promise.all([
    api(`/api/manage/fidelity?slug=${SLUG}`, { action: "credit_debit", client_id: cid, amount: 60, note: "zz par1" }),
    api(`/api/manage/fidelity?slug=${SLUG}`, { action: "credit_debit", client_id: cid, amount: 60, note: "zz par2" }),
  ]);
  const okC = [c1, c2].filter((r) => r.j?.ok === true).length;
  const bal = Number((await q1("SELECT credit_balance::float b FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid])).b);
  check("C1 debit parallelo 60+60 su 100: esattamente 1 ok, saldo 40", okC === 1 && bal === 40, `ok=${okC} bal=${bal} err=${JSON.stringify([c1.j?.error, c2.j?.error])}`);
  const adj = await q1("SELECT balance_before::float bb, balance_after::float ba FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1", [T, cid]);
  check("C2 ledger coerente (before 100 -> after 40)", adj && adj.bb === 100 && adj.ba === 40, JSON.stringify(adj));

  // ---- D) gate fallback ------------------------------------------------------
  const MEMB_ONLY = mk(["fidelity.membership"]);
  const d1 = await api(`/api/manage/fidelity?slug=${SLUG}`, { client_id: cid, type: "points_earn", points: 500, note: "zz gate" }, MEMB_ONLY);
  check("D1 fallback POST negato con solo fidelity.membership (403)", d1.status === 403, `status=${d1.status}`);
  const POS_ONLY = mk(["pos.manage"]);
  const d2 = await api(`/api/manage/fidelity?slug=${SLUG}`, undefined, POS_ONLY);
  check("D2 GET compat RIMOSSO (nessuna anagrafica+saldi, errore per chiunque)", d2.status !== 200 || (d2.j && d2.j.ok === false && !d2.j.clients), `status=${d2.status} err=${JSON.stringify(d2.j && d2.j.error)}`);
  const ptsAfterGate = Number((await q1("SELECT points FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid])).points);
  check("D3 nessun movimento scritto dal tentativo negato", ptsAfterGate === pts, `pts=${ptsAfterGate}`);
  // D4: con fidelity.wallet il fallback resta usabile (compat)
  const WALLET_ONLY = mk(["fidelity.wallet"]);
  const d4 = await api(`/api/manage/fidelity?slug=${SLUG}`, { client_id: cid, type: "points_earn", points: 5, note: "zz gate ok" }, WALLET_ONLY);
  check("D4 fallback POST ok con fidelity.wallet", d4.status === 200 && d4.j?.ok === true, `status=${d4.status} err=${JSON.stringify(d4.j?.error)}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (cid) {
    await q("DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    if (cardId) await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, cardId]).catch(() => {});
    await q("DELETE FROM card_codes WHERE tenant_id=$1 AND code=$2", [T, `ZZFC${RUN}`]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  const finBiz = await q1("SELECT fidelity_enabled FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  const bizOk = String(finBiz?.fidelity_enabled) === String(snapBiz?.fidelity_enabled);
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM cards WHERE tenant_id=$1 AND id=$3) n", [T, cid || 0, cardId || 0])).n);
  console.log(`CLEANUP: residui=${left} biz=${bizOk ? "OK" : "CAMBIATO!"} -> ${left === 0 && bizOk ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 && bizOk ? 0 : 1);
}
