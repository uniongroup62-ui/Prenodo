// Fidelity migliorie 2026-07-17: log attività su tessere/campagne/wallet/credito
// + GET compat rimosso. Campagna di test SEMPRE inattiva (overlap con la 37 attiva).
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["fidelity.manage", "fidelity.wallet", "fidelity.membership", "fidelity.points", "credit_movements.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body) {
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { cookie, "x-tenant-slug": SLUG, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let cid = 0, cardId = 0, campId = 0; const cardCode = `ZZFI${RUN}`;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, points, credit_balance, created_at) VALUES ($1,$2,21,0,50,NOW()) RETURNING id", [T, `ZZ FidImp${RUN}`])).rows[0].id);

  // Tessera: crea (API) -> disattiva -> elimina
  const c1 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "card_create", client_id: cid, code: cardCode });
  cardId = Number(c1.j?.cardId ?? 0);
  check("S1 card_create ok", c1.j?.ok === true && cardId > 0, JSON.stringify(c1.j?.error ?? ""));
  await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "card_update", card_id: cardId, status: "inactive" });
  // Wallet: riattivo la tessera per l'adesione, aggiungo e rimuovo punti
  await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "card_update", card_id: cardId, status: "active" });
  const w1 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "wallet_move", client_id: cid, op: "add", points: 8, note: "zz imp" });
  const w2 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "wallet_move", client_id: cid, op: "remove", points: 3, note: "zz imp" });
  check("S2 wallet add/remove ok", w1.j?.ok === true && w2.j?.ok === true, JSON.stringify([w1.j?.error, w2.j?.error]));
  // Credito: scalo manuale
  const cd = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "credit_debit", client_id: cid, amount: 10, note: "zz imp" });
  check("S3 credit_debit ok", cd.j?.ok === true, JSON.stringify(cd.j?.error ?? ""));
  // Campagna: crea INATTIVA -> modifica -> elimina (hard, 0 riferimenti)
  const cp1 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "campaign_save", id: 0, name: `ZZ CampImp${RUN}`, active: "0", earn_mode: "amount", earn_step_euro: "10" });
  campId = Number(cp1.j?.campaign?.id ?? 0);
  const cp2 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "campaign_save", id: campId, name: `ZZ CampImp${RUN} bis`, active: "0", earn_mode: "amount", earn_step_euro: "10" });
  const cp3 = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "campaign_delete", id: campId });
  check("S4 campagna crea/modifica/elimina ok", campId > 0 && cp2.j?.ok === true && cp3.j?.ok === true && cp3.j?.mode === "hard", JSON.stringify({ id: campId, mode: cp3.j?.mode }));
  // Tessera: elimina
  const cdel = await api(`/api/manage/fidelity?slug=${SLUG}`, { action: "card_delete", card_id: cardId });
  check("S5 card_delete ok", cdel.j?.ok === true, JSON.stringify(cdel.j?.error ?? ""));

  await new Promise((r) => setTimeout(r, 800));
  const logs = (await q("SELECT action, entity_type, entity_id, label FROM activity_logs WHERE tenant_id=$1 AND module='fidelity' AND (entity_id = ANY($2::int[]) OR entity_type='fidelity_campaign') ORDER BY id ASC", [T, [cardId, cid, campId]])).rows;
  const has = (action, entityType, re) => logs.some((r) => r.action === action && r.entity_type === entityType && re.test(String(r.label)));
  check("L1 log tessera: crea + disattiva + riattiva + elimina", has("crea", "fidelity_card", /Emessa tessera Fidelity ZZFI/) && has("disattiva", "fidelity_card", /disattivata/) && has("riattiva", "fidelity_card", /attivata/) && has("elimina", "fidelity_card", /Eliminata tessera/), JSON.stringify(logs.filter((l) => l.entity_type === "fidelity_card").map((l) => l.action)));
  check("L2 log wallet: aggiunti 8 + rimossi 3", has("crea", "client", /Aggiunti 8 punti/) && has("scala", "client", /Rimossi 3 punti/), JSON.stringify(logs.filter((l) => l.entity_type === "client").map((l) => l.label)));
  check("L3 log credito: scalo € 10,00", has("scala", "client", /Scalo manuale credito .*10,00/), "");
  check("L4 log campagna: crea + modifica + elimina", has("crea", "fidelity_campaign", /Creata campagna punti "ZZ CampImp/) && has("modifica", "fidelity_campaign", /Modificata campagna/) && has("elimina", "fidelity_campaign", /Eliminata campagna punti #/), JSON.stringify(logs.filter((l) => l.entity_type === "fidelity_campaign").map((l) => l.action)));
  // Pagina Log: modulo fidelity visibile
  const lg = await api(`/api/manage/logs?slug=${SLUG}&module=fidelity`);
  check("L5 pagina Log: righe module=fidelity", (lg.j.rows || []).some((r) => r.module === "fidelity"), `n=${(lg.j.rows || []).length}`);
  // GET compat rimosso
  const g = await api(`/api/manage/fidelity?slug=${SLUG}`);
  check("G1 GET senza action: 'Azione fidelity non supportata.' (niente anagrafica)", g.j?.ok === false && /non supportata/.test(String(g.j?.error ?? "")) && !g.j?.clients, JSON.stringify(g.j?.error));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (campId) await q("DELETE FROM fidelity_campaigns WHERE tenant_id=$1 AND id=$2", [T, campId]).catch(() => {});
  if (cid) {
    await q("DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM cards WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM card_code_registry WHERE tenant_id=$1 AND code=$2", [T, cardCode]).catch(() => {});
    await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='fidelity' AND (entity_id = ANY($2::int[]) OR label LIKE $3)", [T, [cardId, cid, campId], `%ZZ CampImp${RUN}%`]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM fidelity_campaigns WHERE tenant_id=$1 AND id=$3)+(SELECT COUNT(*) FROM cards WHERE tenant_id=$1 AND id=$4) n", [T, cid || 0, campId || 0, cardId || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
