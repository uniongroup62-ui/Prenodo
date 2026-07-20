// Log attività 2026-07-17 — SERVIZI (servizio crea/modifica/elimina, categoria
// crea/elimina) + IMPOSTAZIONI (ruoli save idempotente, modulo consenso
// crea/elimina). Log DOPO il successo; niente log da azioni fallite.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["services.manage", "service_categories.manage", "settings.general", "settings.location", "consents.manage", "logs.view"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(path, body) {
  const res = await fetch(`${BASE}${path}?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);

let svcId = 0, catId = 0, consId = 0;
try {
  // ---- SERVIZI ----
  const s1 = await api("/api/manage/services", { action: "save", name: `ZZ SvcLog${RUN}`, duration_min: "30", price: "20", category_id: "", is_active: "1", booking_enabled: "0", no_operator: "1", location_ids: String(LOC), cabin_ids: "9" });
  svcId = Number((await q1("SELECT id FROM services WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ SvcLog${RUN}`]))?.id ?? 0);
  check("S1 servizio creato", s1.j?.ok === true && svcId > 0, JSON.stringify(s1.j?.error ?? "").slice(0, 120));
  // L'edit col cambio nome apre il pannello name_update (promo scope-all):
  // pending NON salva e NON logga (verificato); si ripete col confirm_*.
  const editBody = { action: "save", id: String(svcId), name: `ZZ SvcLog${RUN} bis`, duration_min: "30", price: "25", category_id: "", is_active: "1", booking_enabled: "0", no_operator: "1", location_ids: String(LOC), cabin_ids: "9" };
  const sPend = await api("/api/manage/services", editBody);
  check("S1b edit -> pending name_update SENZA salvare", sPend.j?.pending?.kind === "name_update", JSON.stringify(sPend.j?.pending?.kind));
  const s2 = await api("/api/manage/services", { ...editBody, confirm_service_name_update: "1", confirm_service_price_update: "1", confirm_impacted_appointments: "1" });
  check("S1c edit confermato ok", s2.j?.ok === true && !s2.j?.pending, JSON.stringify(s2.j?.pending ?? s2.j?.error ?? "").slice(0, 120));
  // fallita: nome vuoto -> nessun log
  await api("/api/manage/services", { action: "save", name: "", duration_min: "30", price: "20" });
  const c1 = await api("/api/manage/services", { action: "category_save", name: `ZZ CatLog${RUN}` });
  catId = Number((await q1("SELECT id FROM service_categories WHERE tenant_id=$1 AND name=$2 ORDER BY id DESC LIMIT 1", [T, `ZZ CatLog${RUN}`]))?.id ?? 0);
  check("S2 categoria creata", c1.j?.ok === true && catId > 0, JSON.stringify(c1.j?.error ?? "").slice(0, 120));
  await api("/api/manage/services", { action: "category_delete", id: String(catId) });
  await api("/api/manage/services", { action: "delete", id: String(svcId) });

  await new Promise((r) => setTimeout(r, 800));
  const svcLogs = (await q("SELECT action, entity_type, label FROM activity_logs WHERE tenant_id=$1 AND module='servizi' AND (entity_id IN ($2,$3) OR label LIKE $4) ORDER BY id ASC", [T, svcId, catId, `%ZZ %Log${RUN}%`])).rows;
  const hasS = (a, et, re) => svcLogs.some((r) => r.action === a && r.entity_type === et && re.test(String(r.label)));
  check("L1 servizi: creato + modificato", hasS("crea", "service", new RegExp(`Creato servizio "ZZ SvcLog${RUN}"`)) && hasS("modifica", "service", new RegExp(`Modificato servizio "ZZ SvcLog${RUN} bis"`)), JSON.stringify(svcLogs.map((l) => l.label)));
  check("L2 servizi: eliminato + categoria creata/eliminata; nessun log dal save fallito", hasS("elimina", "service", new RegExp(`Eliminato servizio #${svcId}`)) && hasS("crea", "service_category", new RegExp(`Creata categoria servizi "ZZ CatLog${RUN}"`)) && hasS("elimina", "service_category", new RegExp(`#${catId}`)) && !svcLogs.some((l) => /"senza nome"/.test(l.label)), `n=${svcLogs.length}`);

  // ---- IMPOSTAZIONI: ruoli (save idempotente coi permessi correnti) ----
  const cur = await fetch(`${BASE}/api/manage/permissions?slug=${SLUG}`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  const staffPerms = (cur?.assignments?.staff ?? []).join(",");
  const rp = await api("/api/manage/permissions", { action: "save_role_perms", role: "staff", perms: staffPerms });
  check("S3 ruoli save ok (idempotente)", rp.j?.ok === true, JSON.stringify(rp.j?.error ?? "").slice(0, 120));

  // ---- IMPOSTAZIONI: modulo consenso crea + elimina ----
  const cm = await api("/api/manage/configuration", { module: "consent_modules", action: "save_module", name: `ZZ ConsLog${RUN}`, body_template: "Testo di test {NOME_CLIENTE}", type: "informed_consent" });
  consId = Number(cm.j?.consentModule?.id ?? 0);
  check("S4 modulo consenso creato", cm.j?.ok === true && consId > 0, JSON.stringify(cm.j?.error ?? "").slice(0, 150));
  await api("/api/manage/configuration", { module: "consent_modules", action: "delete_module", id: String(consId) });

  await new Promise((r) => setTimeout(r, 800));
  const impLogs = (await q("SELECT action, entity_type, label FROM activity_logs WHERE tenant_id=$1 AND module='impostazioni' AND (label LIKE $2 OR label LIKE $3 OR entity_id=$4) ORDER BY id ASC", [T, `Salvati permessi ruolo "staff"`, `%ZZ ConsLog${RUN}%`, consId || 0])).rows;
  const hasI = (a, et, re) => impLogs.some((r) => r.action === a && r.entity_type === et && re.test(String(r.label)));
  check("L3 impostazioni: permessi ruolo salvati", hasI("modifica", "role", /Salvati permessi ruolo "staff"/), JSON.stringify(impLogs.map((l) => l.label)));
  check("L4 impostazioni: modulo consenso creato + eliminato", hasI("crea", "consent_module", new RegExp(`Creato modulo consenso "ZZ ConsLog${RUN}"`)) && hasI("elimina", "consent_module", new RegExp(`#${consId}`)), "");
  const lg = await fetch(`${BASE}/api/manage/logs?slug=${SLUG}&module=impostazioni`, { headers: { cookie, "x-tenant-slug": SLUG } }).then((r) => r.json());
  check("L5 pagina Log: moduli servizi+impostazioni visibili", (lg.rows || []).some((r) => r.module === "impostazioni"), `n=${(lg.rows || []).length}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (svcId) {
    await q("DELETE FROM service_locations WHERE tenant_id=$1 AND service_id=$2", [T, svcId]).catch(() => {});
    await q("DELETE FROM services WHERE tenant_id=$1 AND id=$2", [T, svcId]).catch(() => {});
  }
  if (catId) await q("DELETE FROM service_categories WHERE tenant_id=$1 AND id=$2", [T, catId]).catch(() => {});
  if (consId) await q("DELETE FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, consId]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND (label LIKE $2 OR label LIKE $3 OR (module='impostazioni' AND label = 'Salvati permessi ruolo \"staff\"' AND created_at > NOW() - interval '30 minutes'))", [T, `%Log${RUN}%`, `%ConsLog${RUN}%`]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM services WHERE tenant_id=$1 AND name LIKE $2)+(SELECT COUNT(*) FROM service_categories WHERE tenant_id=$1 AND name LIKE $3)+(SELECT COUNT(*) FROM consent_modules WHERE tenant_id=$1 AND name LIKE $4) n", [T, `ZZ SvcLog%`, `ZZ CatLog%`, `ZZ ConsLog%`])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
