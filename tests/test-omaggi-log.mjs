// Omaggi migliorie 2026-07-17: log attività su campagne (crea/modifica/
// disattiva/condizioni/esclusioni/elimina) + istanze (riscatta/annulla/
// elimina/assegnazione manuale). Log DOPO il successo.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, LOC = 21, SVC = 9;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["gifts.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/gifts?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

let cid = 0, giftId = 0, instA = 0, instB = 0;
try {
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ OmgLog ${RUN}`])).rows[0].id);

  // Campagna: crea (inattiva) -> modifica -> disattiva (toggle off) -> condizioni -> esclusioni
  const SAVE_BASE = { action: "save", clone_source_id: "0", description: "zz log", fidelity_only: "0", eligible_levels_points_json: "[]", excluded_client_ids_json: "[]", terms_enabled: "0", terms_text: "", valid_from: from, valid_to: to, expires_after_days: "", location_ids: String(LOC), reward_items_json: JSON.stringify([{ type: "service", service_id: SVC, qty: 1 }]), rule_type: "appointments_count", rule_service_id: "0", rule_product_id: "0", rule_threshold: "1" };
  const s1 = await api({ ...SAVE_BASE, id: "0", name: `ZZ OmgLog${RUN}`, active: "0" });
  giftId = Number(s1.j?.gift?.id ?? 0);
  check("S1 create campagna ok", s1.j?.ok === true && giftId > 0, JSON.stringify(s1.j?.error ?? "").slice(0, 120));
  await api({ ...SAVE_BASE, id: String(giftId), name: `ZZ OmgLog${RUN} bis`, active: "0" });
  await api({ action: "toggle_active", id: giftId, active: "0" });
  await api({ action: "gift_terms_update", gift_id: giftId, terms_enabled: "1", terms_text: "zz condizioni" });
  await api({ action: "gift_exclusion_add", gift_id: giftId, client_id: cid });
  await api({ action: "gift_exclusion_remove", gift_id: giftId, client_id: cid });

  // Istanze (seed SQL; la campagna resta inattiva ma le istanze vivono da sole)
  instA = Number((await q("INSERT INTO gift_instances (tenant_id, gift_id, client_id, state, is_active, unlocked_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,'disponibile',1,NOW(),NOW() + interval '10 days',NOW(),NOW()) RETURNING id", [T, giftId, cid])).rows[0].id);
  instB = Number((await q("INSERT INTO gift_instances (tenant_id, gift_id, client_id, state, is_active, unlocked_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,'disponibile',1,NOW(),NOW() + interval '10 days',NOW(),NOW()) RETURNING id", [T, giftId, cid])).rows[0].id);
  const r1 = await api({ action: "redeem_instance_partial", instance_id: String(instA), redeem_qty_json: JSON.stringify({ "0": 1 }), redeem_note: "zz log" });
  check("S2 riscatto completo ok", /riscattato completamente/.test(String(r1.j?.message ?? "")), JSON.stringify(r1.j?.error ?? r1.j?.message));
  // Guardia legacy: eliminabili solo accumulo/annullati/scaduti (NON i riscattati)
  const dGuard = await api({ action: "delete_instance", instance_id: String(instA) });
  check("S3 delete su riscattato RIFIUTATO (guardia verbatim)", dGuard.j?.ok !== true && /solo omaggi in accumulo, annullati o scaduti/.test(String(dGuard.j?.error ?? "")), JSON.stringify(dGuard.j?.error));
  await api({ action: "cancel_instance", instance_id: String(instB), cancel_reason: "zz log annullo" });
  const dd = await api({ action: "delete_instance", instance_id: String(instB) });
  check("S4 delete su annullato ok", dd.j?.ok === true, JSON.stringify(dd.j?.error ?? "").slice(0, 120));
  // Eliminazione campagna
  await api({ action: "delete", id: giftId });

  await new Promise((r) => setTimeout(r, 800));
  const logs = (await q("SELECT action, entity_type, label FROM activity_logs WHERE tenant_id=$1 AND module='omaggi' AND (entity_id = ANY($2::int[]) OR label LIKE $3) ORDER BY id ASC", [T, [giftId, instA, instB], `%ZZ OmgLog${RUN}%`])).rows;
  const has = (a, et, re) => logs.some((r) => r.action === a && r.entity_type === et && re.test(String(r.label)));
  check("L1 campagna: creata + modificata", has("crea", "gift", new RegExp(`Creata campagna omaggio "ZZ OmgLog${RUN}"`)) && has("modifica", "gift", new RegExp(`Modificata campagna omaggio "ZZ OmgLog${RUN} bis" \\(#${giftId}\\)`)), JSON.stringify(logs.filter((l) => l.entity_type === "gift").map((l) => l.action)));
  check("L2 campagna: disattivata + condizioni + escluso/riammesso + eliminata", has("disattiva", "gift", /disattivata/) && has("modifica", "gift", /Aggiornate condizioni/) && has("modifica", "gift", new RegExp(`Cliente #${cid} escluso`)) && has("modifica", "gift", new RegExp(`Cliente #${cid} riammesso`)) && has("elimina", "gift", /Eliminata campagna omaggio/), "");
  check("L3 istanza: riscatto completo con unità", has("riscatta", "gift_instance", new RegExp(`Riscatto completo omaggio #${instA} \\(1 unità\\)`)), JSON.stringify(logs.filter((l) => l.entity_type === "gift_instance").map((l) => l.label)));
  check("L4 istanza: annullata + eliminata (annullato); NESSUN log del delete rifiutato", has("annulla", "gift_instance", new RegExp(`Annullato omaggio #${instB}`)) && has("elimina", "gift_instance", new RegExp(`Eliminato omaggio chiuso #${instB}`)) && !has("elimina", "gift_instance", new RegExp(`#${instA}`)), JSON.stringify(logs.filter((l) => l.entity_type === "gift_instance").map((l) => l.label)));
  const lg = await fetch(`${BASE}/api/manage/logs?slug=${SLUG}&module=omaggi`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("L5 pagina Log: righe module=omaggi", (lg.rows || []).some((r) => r.module === "omaggi"), `n=${(lg.rows || []).length}`);
  // Negativo: riscatto su istanza inesistente -> nessun log
  await api({ action: "redeem_instance_partial", instance_id: "999999", redeem_qty_json: JSON.stringify({ "0": 1 }) });
  const bad = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND module='omaggi' AND entity_id=999999", [T])).n);
  check("L6 nessun log da azione fallita", bad === 0, `n=${bad}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const i of [instA, instB]) if (i) {
    await q("DELETE FROM gift_transactions WHERE tenant_id=$1 AND instance_id=$2", [T, i]).catch(() => {});
    await q("DELETE FROM gift_instances WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  }
  if (giftId) {
    await q("DELETE FROM gift_rules WHERE tenant_id=$1 AND rule_set_id IN (SELECT id FROM gift_rule_sets WHERE tenant_id=$1 AND gift_id=$2)", [T, giftId]).catch(() => {});
    await q("DELETE FROM gift_rule_sets WHERE tenant_id=$1 AND gift_id=$2", [T, giftId]).catch(() => {});
    await q("DELETE FROM gift_locations WHERE tenant_id=$1 AND gift_id=$2", [T, giftId]).catch(() => {});
    await q("DELETE FROM gifts WHERE tenant_id=$1 AND id=$2", [T, giftId]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='omaggi' AND (entity_id = ANY($2::int[]) OR label LIKE $3)", [T, [giftId || 0, instA || 0, instB || 0], `%ZZ OmgLog${RUN}%`]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM gifts WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM gift_instances WHERE tenant_id=$1 AND id IN ($3,$4))+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id=$5) n", [T, giftId || 0, instA || 0, instB || 0, cid || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
