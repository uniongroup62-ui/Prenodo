// Feature "Log" (registro attività, 2026-07-16): helper+API+pagina, admin-only,
// strumentazione fase 1, retention 30 giorni.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21;
const forge = (over = {}) => {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["clients.manage", "suppliers.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [], ...over }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
};
const cookie = forge();
const cookieStaff = forge({ role: "staff", perms: ["clients.manage"] });
const api = (b, ck = cookie) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const logsGet = (qs, ck = cookie) => fetch(`http://localhost:3000/api/manage/logs?slug=${SLUG}${qs}`, { headers: { cookie: ck } }).then(async (r) => ({ s: r.status, j: await r.json() }));
async function conn() { for (let i = 0; i < 8; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 7) throw e; await new Promise((r) => setTimeout(r, 4000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let cid = 0, supId = 0;
try {
  // === Strumentazione: ciclo cliente ===
  let j = await api({ action: "create", first_name: "ZZ", last_name: `LogT${RUN}`, email: "zz-log@test.local", location_id: String(LOC) });
  cid = Number(j.client?.id ?? 0);
  j = await api({ action: "update", id: cid, first_name: "ZZ", last_name: `LogT${RUN}B`, location_id: String(LOC) });
  j = await api({ action: "delete", id: cid, delete_reason: "ZZ log test", delete_confirm_text: "ELIMINA" });
  cid = 0;
  await new Promise((r) => setTimeout(r, 800)); // fire-and-forget: attesa flush
  const acts = (await db.query(`SELECT module, action, label, user_label FROM activity_logs WHERE tenant_id=25 AND label LIKE '%LogT${RUN}%' ORDER BY id`)).rows;
  check("L1 crea+modifica+elimina cliente tracciati", acts.length === 3 && acts[0].action === "crea" && acts[1].action === "modifica" && acts[2].action === "elimina", JSON.stringify(acts.map((a) => a.action)));
  check("L2 label leggibili + snapshot operatore", acts.every((a) => a.user_label === "luca") && /motivo: ZZ log test/.test(acts[2]?.label ?? ""), JSON.stringify(acts[2]?.label));
  // === Fornitori (superficie diversa) ===
  const sup = await fetch(`http://localhost:3000/api/manage/products?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "supplier_save", name: `ZZ LogF${RUN}`, location_ids: "21", cost_location_ids: "21" }) }).then((r) => r.json());
  supId = Number(sup.supplier?.id ?? sup.id ?? 0);
  if (!supId) supId = Number((await db.query("SELECT id FROM suppliers WHERE tenant_id=25 AND name=$1", [`ZZ LogF${RUN}`])).rows[0]?.id ?? 0);
  if (!supId) console.log("  (supplier_save response:", JSON.stringify(sup).slice(0, 160), ")");
  await fetch(`http://localhost:3000/api/manage/products?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "supplier_delete", id: String(supId || 0) }) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 800));
  const supActs = (await db.query(`SELECT action FROM activity_logs WHERE tenant_id=25 AND module='fornitori' AND label LIKE '%LogF${RUN}%' OR (tenant_id=25 AND module='fornitori' AND action='elimina' AND entity_id = ${supId || -1}) ORDER BY id`)).rows;
  check("L3 fornitore crea+elimina tracciati", supActs.length >= 2, JSON.stringify(supActs.map((a) => a.action)));
  // === Login reale tracciato ===
  // Password SOLO da .env.local (PRENODO_TEST_ADMIN_PASSWORD, mai committata):
  // senza, il check L4 viene saltato invece di fallire l'intera batteria.
  const TESTPW = ((readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_TEST_ADMIN_PASSWORD\s*=\s*(.*)\s*$/m) || [])[1] ?? "").trim().replace(/^["']|["']$/g, "");
  if (TESTPW) {
    const login = await fetch(`http://localhost:3000/api/manage/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: SLUG, email: "info@artebrand.it", password: TESTPW }) });
    await new Promise((r) => setTimeout(r, 800));
    const loginActs = (await db.query("SELECT label FROM activity_logs WHERE tenant_id=25 AND module='accessi' ORDER BY id DESC LIMIT 1")).rows;
    check("L4 login tracciato (modulo accessi)", login.ok && loginActs.length >= 1 && /Accesso di/.test(loginActs[0]?.label ?? ""), JSON.stringify(loginActs[0]?.label));
  } else {
    console.log("SKIP | L4 login tracciato (PRENODO_TEST_ADMIN_PASSWORD assente in .env.local)");
  }
  // === API admin-only ===
  let r = await logsGet("");
  check("L5 GET logs (admin): righe + filtri select", r.s === 200 && r.j.ok === true && r.j.rows.length >= 4 && r.j.modules.includes("clienti") && r.j.pageSize === 25, `rows=${r.j.rows?.length} modules=${JSON.stringify(r.j.modules)}`);
  r = await logsGet("&module=clienti&action=elimina");
  check("L6 filtro modulo+azione", r.s === 200 && r.j.rows.length >= 1 && r.j.rows.every((x) => x.module === "clienti" && x.action === "elimina"), `rows=${r.j.rows?.length}`);
  r = await logsGet(`&q=LogT${RUN}B`);
  check("L7 ricerca testo", r.s === 200 && r.j.rows.length >= 1 && r.j.rows.every((x) => x.label.includes(`LogT${RUN}B`)), `rows=${r.j.rows?.length}`);
  r = await logsGet("", cookieStaff);
  check("L8 non-admin SENZA permessi -> 403 Accesso negato", r.s === 403 && r.j.error === "Accesso negato.", JSON.stringify([r.s, r.j.error]));
  // === Permessi granulari (logs.view / logs.deletions, 2026-07-16 bis) ===
  const cookieViewer51 = forge({ role: "staff", perms: ["logs.view"], locationIds: [51] });
  const cookieDeletions = forge({ role: "staff", perms: ["logs.deletions"] });
  await db.query("INSERT INTO activity_logs (tenant_id, created_at, user_id, user_label, location_id, module, action, label) VALUES (25, NOW(), 20, 'luca', 51, 'clienti', 'crea', $1)", [`ZZ SEDE51 ${RUN}`]);
  r = await logsGet("", cookieViewer51);
  const onlyAllowed = (r.j.rows ?? []).every((x) => Number(x.locationId) === 0 || Number(x.locationId) === 51);
  // Il seed va cercato via ?q= (le voci dell'app hanno orologio LOCALE +2h vs
  // NOW() del DB: il seed ordina piu' vecchio e puo' uscire dalla pagina 1).
  const rSeek = await logsGet(`&q=ZZ SEDE51 ${RUN}`, cookieViewer51);
  const seenSede51 = (rSeek.j.rows ?? []).some((x) => x.label.includes(`ZZ SEDE51 ${RUN}`));
  check("L12 logs.view ristretto a sede 51: SOLO voci sede 51/senza-sede", r.s === 200 && onlyAllowed && seenSede51 && r.j.views?.activity === true && r.j.views?.deletions === false, `rows=${r.j.rows?.length} onlyAllowed=${onlyAllowed} seen=${seenSede51}`);
  const leakSede21 = (r.j.rows ?? []).some((x) => Number(x.locationId) === 21);
  check("L13 nessuna voce di sede 21 visibile al ristretto", !leakSede21, "");
  r = await logsGet("&view=deletions", cookieViewer51);
  check("L14 logs.view senza sotto-permesso -> deletions 403 (con views)", r.s === 403 && r.j.views?.activity === true, JSON.stringify([r.s, r.j.views]));
  r = await logsGet("&view=deletions", cookieDeletions);
  check("L15 logs.deletions: vista eliminazioni OK", r.s === 200 && Array.isArray(r.j.rows), `rows=${r.j.rows?.length}`);
  r = await logsGet("", cookieDeletions);
  check("L16 logs.deletions SENZA logs.view -> activity 403 + views.deletions", r.s === 403 && r.j.views?.deletions === true, JSON.stringify([r.s, r.j.views]));
  await db.query("DELETE FROM activity_logs WHERE tenant_id=25 AND label = $1", [`ZZ SEDE51 ${RUN}`]);
  // === Vista eliminazioni permanente ===
  r = await logsGet("&view=deletions");
  check("L9 vista eliminazioni: righe con motivo + operatore", r.s === 200 && r.j.rows.length >= 1 && r.j.rows.some((x) => /ZZ log test/.test(x.reason)) && r.j.rows.every((x) => x.deletedByLabel !== ""), `rows=${r.j.rows?.length}`);
  // === Retention 30 giorni ===
  await db.query("INSERT INTO activity_logs (tenant_id, created_at, user_id, user_label, module, action, label) VALUES (25, NOW() - interval '40 days', 20, 'luca', 'clienti', 'crea', 'ZZ VOCE VECCHIA da purgare')");
  r = await logsGet("&q=VOCE VECCHIA");
  const still = (await db.query("SELECT COUNT(*)::int n FROM activity_logs WHERE tenant_id=25 AND label LIKE '%VOCE VECCHIA%'")).rows[0].n;
  check("L10 purge 30gg: voce di 40 giorni fa eliminata al load", r.j.rows.length === 0 && Number(still) === 0, `apiRows=${r.j.rows?.length} db=${still}`);
  // === Pagina SSR ===
  const html = await fetch(`http://localhost:3000/${SLUG}/log`, { headers: { cookie } }).then((x) => x.text());
  check("L11 SSR pagina Log: titolo+tab+menu", html.includes("Registro delle attività") && html.includes("Eliminazioni clienti (permanente)") && html.includes(">Log<"), "");
} finally {
  if (cid) await api({ action: "delete", id: cid, delete_reason: "ZZ cleanup", delete_confirm_text: "ELIMINA" }).catch(() => {});
  await db.query(`DELETE FROM suppliers WHERE tenant_id=25 AND name = 'ZZ LogF${RUN}'`).catch(() => {});
  // Le voci di log ZZ di questo test restano volutamente (sono attività reale del registro).
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
