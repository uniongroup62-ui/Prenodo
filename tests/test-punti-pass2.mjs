// Punti pass 2 (2026-07-17) — angoli non coperti:
//  A) livello = punti MATURATI nel periodo (earn), NON il saldo (redeem non declassa)
//  B) periodo livelli: earn fuori finestra escluso; period_days=0 -> all-time
//  C) tiers campagna: dedup per minSpend tenendo il MAX punti + ordinamento
// Stato livelli/settings snapshottato e ripristinato.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["fidelity.manage", "fidelity.points", "fidelity.levels", "fidelity.wallet"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/fidelity?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let cid = 0, cardId = 0, campId = 0;
const snap = await q1("SELECT fidelity_levels_enabled le, fidelity_card_levels_json lj, fidelity_level_period_days pd FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
try {
  // Livelli attivi: Bronzo 0 / Argento 50 (period 365)
  await q("UPDATE businesses SET fidelity_levels_enabled=1, fidelity_card_levels_json=$2, fidelity_level_period_days=365 WHERE tenant_id=$1",
    [T, JSON.stringify({ levels: [{ key: "bronzo", name: "Bronzo", min_points: 0 }, { key: "argento", name: "Argento", min_points: 50 }] })]);

  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, points, created_at) VALUES ($1,$2,21,0,NOW()) RETURNING id", [T, `ZZ PuntiP2 ${RUN}`])).rows[0].id);
  cardId = Number((await q("INSERT INTO cards (tenant_id, code, client_id, issued_at, status) VALUES ($1,$2,$3,CURRENT_DATE,'active') RETURNING id", [T, `ZZPT${RUN}`, cid])).rows[0].id);

  // A: earn 60 nel periodo, poi redeem 50 -> saldo 10 ma livello ARGENTO (maturati 60)
  await api({ action: "wallet_move", client_id: cid, op: "add", points: 60, note: "zz p2 earn" });
  await api({ action: "wallet_move", client_id: cid, op: "remove", points: 50, note: "zz p2 redeem" });
  const a1 = await q1("SELECT points, fidelity_level FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]);
  check("A1 saldo 10 ma livello 'argento' (maturati 60 nel periodo, il redeem non declassa)", Number(a1.points) === 10 && a1.fidelity_level === "argento", JSON.stringify(a1));

  // B: earn FUORI periodo (2 anni fa) non conta -> con solo quello, livello bronzo
  await q("UPDATE transactions SET created_at = NOW() - interval '2 years' WHERE tenant_id=$1 AND client_id=$2 AND delta_points > 0", [T, cid]);
  await api({ action: "wallet_move", client_id: cid, op: "add", points: 1, note: "zz p2 trigger" }); // trigger ricalcolo
  const b1 = await q1("SELECT fidelity_level FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]);
  check("B1 earn fuori finestra escluso -> livello 'bronzo' (solo +1 nel periodo)", b1.fidelity_level === "bronzo", JSON.stringify(b1));
  // period_days=0 -> all-time: il 60 di 2 anni fa torna a contare
  await q("UPDATE businesses SET fidelity_level_period_days=0 WHERE tenant_id=$1", [T]);
  await api({ action: "wallet_move", client_id: cid, op: "add", points: 1, note: "zz p2 trigger2" });
  const b2 = await q1("SELECT fidelity_level FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]);
  check("B2 period_days=0 = all-time -> 'argento' (60+2 maturati totali)", b2.fidelity_level === "argento", JSON.stringify(b2));

  // C: tiers con duplicati -> dedup-max per minSpend + sort
  const c1 = await api({ action: "campaign_save", id: 0, name: `ZZ TiersP2${RUN}`, active: "0", earn_mode: "tiers", tiers_json: JSON.stringify([{ minSpend: 100, points: 5 }, { minSpend: 50, points: 3 }, { minSpend: 100, points: 9 }, { minSpend: 100, points: 2 }]) });
  campId = Number(c1.j?.campaign?.id ?? 0);
  const tiers = c1.j?.campaign?.tiers ?? [];
  check("C1 tiers dedup-max + ordinati: [50:3, 100:9]", campId > 0 && JSON.stringify(tiers) === JSON.stringify([{ minSpend: 50, points: 3 }, { minSpend: 100, points: 9 }]), JSON.stringify(tiers));
  const c2 = await api({ action: "campaign_save", id: 0, name: `ZZ TiersP2b${RUN}`, active: "0", earn_mode: "tiers", tiers_json: JSON.stringify([{ minSpend: 10, points: 0 }]) });
  check("C2 tiers tutti a 0 punti -> 'Aggiungi almeno uno scaglione punti valido.'", c2.j?.ok !== true && /almeno uno scaglione/.test(String(c2.j?.error ?? "")), JSON.stringify(c2.j?.error));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (campId) await q("DELETE FROM fidelity_campaigns WHERE tenant_id=$1 AND id=$2", [T, campId]).catch(() => {});
  if (cid) {
    await q("DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    if (cardId) await q("DELETE FROM cards WHERE tenant_id=$1 AND id=$2", [T, cardId]).catch(() => {});
    await q("DELETE FROM card_code_registry WHERE tenant_id=$1 AND code=$2", [T, `ZZPT${RUN}`]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='fidelity' AND entity_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  await q("UPDATE businesses SET fidelity_levels_enabled=$2, fidelity_card_levels_json=$3, fidelity_level_period_days=$4 WHERE tenant_id=$1", [T, snap?.le ?? 0, snap?.lj ?? null, snap?.pd ?? 365]).catch(() => {});
  const fin = await q1("SELECT fidelity_levels_enabled le, fidelity_level_period_days pd FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
  const bizOk = String(fin?.le) === String(snap?.le) && String(fin?.pd) === String(snap?.pd);
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM fidelity_campaigns WHERE tenant_id=$1 AND name LIKE $3) n", [T, cid || 0, `ZZ TiersP2%`])).n);
  console.log(`CLEANUP: residui=${left} biz=${bizOk ? "OK" : "CAMBIATO!"} -> ${left === 0 && bizOk ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 && bizOk ? 0 : 1);
}
