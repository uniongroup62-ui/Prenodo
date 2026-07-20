// Moduli consenso pass 2 (2026-07-17) — FIX: delete transazionale (bozze+modulo),
// check firmati NORMALIZZATO ('Signed' conta), guardia toggle sistema, mirror
// gdpr su PRIMA riga businesses. + riverifica save/slug/duplicato/ensure.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25, SYS_ID = 3;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["consent_modules.manage"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/configuration?slug=${SLUG}&module=consent_modules`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify({ module: "consent_modules", ...body }) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
const sysSnap = await q1("SELECT name, slug, body_template FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, SYS_ID]);
const bizSnap = await q1("SELECT id, gdpr_template_body FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
let idA = 0, idB = 0, idC = 0, cid = 0;
try {
  // S1: nuovo modulo informato
  const s1 = await api({ action: "save_module", name: `ZZ Consenso ${RUN}`, type: "informed_consent", body_template: "Testo modulo {{cliente}}", is_active: "1" });
  idA = Number(s1.j?.consentModule?.id ?? 0);
  const a = await q1("SELECT slug, type, footer_mode, footer_title, is_system, is_active FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, idA]);
  check("S1 create informato: slug derivato + footer del tipo", s1.j?.ok === true && idA > 0 && a.slug === `zz-consenso-${RUN}` && a.type === "informed_consent" && a.footer_mode === "signature_only" && a.footer_title === "Conferma e firma cliente" && Number(a.is_system) === 0, JSON.stringify(a));

  // S2: stesso nome -> slug -2
  const s2 = await api({ action: "save_module", name: `ZZ Consenso ${RUN}`, type: "informed_consent", body_template: "Altro testo" });
  idB = Number(s2.j?.consentModule?.id ?? 0);
  check("S2 nome duplicato -> slug unico '-2'", s2.j?.ok === true && s2.j?.consentModule?.slug === `zz-consenso-${RUN}-2`, JSON.stringify(s2.j?.consentModule?.slug));

  // S3: privacy_gdpr duplicato vietato; S4: body vuoto
  const s3 = await api({ action: "save_module", name: "ZZ Dup GDPR", type: "privacy_gdpr", body_template: "x" });
  check("S3 nuovo privacy_gdpr vietato (unico)", err(s3) === "Il modulo PDF privacy GDPR e unico e non puo essere duplicato.", JSON.stringify(err(s3)));
  const s4 = await api({ action: "save_module", name: "ZZ Vuoto", type: "informed_consent", body_template: "   " });
  check("S4 template vuoto rifiutato", err(s4) === "Il template del modulo non puo essere vuoto.", JSON.stringify(err(s4)));

  // S5: edit SISTEMA: body nuovo + nome custom (NON forzato) -> mirror su businesses
  const s5 = await api({ action: "save_module", id: String(SYS_ID), name: `ZZ GDPR Ren ${RUN}`, body_template: `INFORMATIVA ZZ ${RUN}`, is_active: "0" });
  const sys = await q1("SELECT name, slug, type, is_active, body_template FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, SYS_ID]);
  const biz = await q1("SELECT gdpr_template_body FROM businesses WHERE tenant_id=$1 AND id=$2", [T, bizSnap.id]);
  check("S5 sistema: nome NON forzato, type/slug/attivo blindati, MIRROR su gdpr_template_body", s5.j?.ok === true && sys.name === `ZZ GDPR Ren ${RUN}` && sys.slug === "pdf-privacy-gdpr" && sys.type === "privacy_gdpr" && Number(sys.is_active) === 1 && sys.body_template === `INFORMATIVA ZZ ${RUN}` && biz.gdpr_template_body === `INFORMATIVA ZZ ${RUN}`, JSON.stringify({ n: sys.name, a: sys.is_active, mirror: biz.gdpr_template_body }));
  // Ripristino sistema via save (mirror incluso)
  const s5r = await api({ action: "save_module", id: String(SYS_ID), name: sysSnap.name, body_template: sysSnap.body_template });
  check("S5b ripristino sistema ok", s5r.j?.ok === true, JSON.stringify(err(s5r)));

  // T1 (FIX): toggle OFF sul sistema -> guardia
  const t1 = await api({ action: "toggle", record_id: String(SYS_ID), active: "0" });
  const sysT = await q1("SELECT is_active FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, SYS_ID]);
  check("T1 toggle OFF sistema rifiutato, is_active resta 1", err(t1) === "Il modulo PDF privacy GDPR e di sistema e non puo essere disattivato." && Number(sysT.is_active) === 1, JSON.stringify({ e: err(t1), a: sysT.is_active }));
  // T2: toggle su modulo normale funziona
  const t2 = await api({ action: "toggle", record_id: String(idB), active: "0" });
  const bT = await q1("SELECT is_active FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, idB]);
  check("T2 toggle OFF modulo informato ok", t2.j?.ok === true && Number(bT.is_active) === 0, JSON.stringify(bT));

  // D1: delete con BOZZA associata -> cascata transazionale + conteggio
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ CliCons ${RUN}`])).rows[0].id);
  await q("INSERT INTO client_consent_records (tenant_id, client_id, module_id, status) VALUES ($1,$2,$3,'draft')", [T, cid, idA]);
  const d1 = await api({ action: "delete_module", id: String(idA) });
  const d1left = await q1("SELECT (SELECT COUNT(*) FROM consent_modules WHERE tenant_id=$1 AND id=$2)::int m,(SELECT COUNT(*) FROM client_consent_records WHERE tenant_id=$1 AND module_id=$2)::int r", [T, idA]);
  check("D1 delete con bozza: associationCount=1, modulo+bozze rimossi in tx", d1.j?.ok === true && Number(d1.j?.associationCount) === 1 && d1left.m === 0 && d1left.r === 0, JSON.stringify({ c: d1.j?.associationCount, left: d1left }));
  if (d1left.m === 0) idA = 0;

  // D2 (FIX normalize): record con status 'Signed' (case strano, senza documento) -> BLOCCA
  idC = idB;
  await q("INSERT INTO client_consent_records (tenant_id, client_id, module_id, status) VALUES ($1,$2,$3,'Signed')", [T, cid, idC]);
  const d2 = await api({ action: "delete_module", id: String(idC) });
  const d2still = Number((await q1("SELECT COUNT(*) n FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, idC]))?.n);
  check("D2 record 'Signed' (case) blocca la delete, modulo intatto", err(d2) === "Il modulo ha documenti firmati collegati e non puo essere eliminato. Disattivalo per non usarlo nei nuovi consensi e conserva lo storico cliente." && d2still === 1, JSON.stringify(err(d2)).slice(0, 80));
  await q("DELETE FROM client_consent_records WHERE tenant_id=$1 AND module_id=$2", [T, idC]);
  const d2b = await api({ action: "delete_module", id: String(idC) });
  check("D2b senza firmati la delete passa (associationCount=0)", d2b.j?.ok === true && Number(d2b.j?.associationCount) === 0, JSON.stringify(d2b.j?.associationCount));
  if (d2b.j?.ok === true) idB = 0;

  // D3/D4: sistema protetto + non trovato
  const d3 = await api({ action: "delete_module", id: String(SYS_ID) });
  check("D3 delete sistema rifiutata", err(d3) === "Il modulo PDF privacy GDPR e di sistema e non puo essere eliminato.", JSON.stringify(err(d3)));
  const d4 = await api({ action: "delete_module", id: "999999" });
  check("D4 id inesistente -> 'Modulo consenso non trovato.'", err(d4) === "Modulo consenso non trovato.", JSON.stringify(err(d4)));

  // E1: ensure non duplica il sistema (GET lista lo garantisce)
  await fetch(`${BASE}/api/manage/configuration?slug=${SLUG}&module=consent_modules`, { headers: { cookie, "x-tenant-slug": SLUG } });
  const sysCount = Number((await q1("SELECT COUNT(*) n FROM consent_modules WHERE tenant_id=$1 AND system_key='privacy_gdpr'", [T]))?.n);
  check("E1 ensure: modulo di sistema UNICO", sysCount === 1, `n=${sysCount}`);
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  for (const i of [idA, idB, idC]) if (i && i !== SYS_ID) {
    await q("DELETE FROM client_consent_records WHERE tenant_id=$1 AND module_id=$2", [T, i]).catch(() => {});
    await q("DELETE FROM consent_modules WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  }
  if (cid) {
    await q("DELETE FROM client_consent_records WHERE tenant_id=$1 AND client_id=$2", [T, cid]).catch(() => {});
    await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  }
  await q("UPDATE consent_modules SET name=$3, body_template=$4 WHERE tenant_id=$1 AND id=$2", [T, SYS_ID, sysSnap.name, sysSnap.body_template]).catch(() => {});
  await q("UPDATE businesses SET gdpr_template_body=$3 WHERE tenant_id=$1 AND id=$2", [T, bizSnap.id, bizSnap.gdpr_template_body]).catch(() => {});
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='impostazioni' AND id > $2", [T, logWatermark]).catch(() => {});
  const fin = await q1("SELECT (SELECT COUNT(*) FROM consent_modules WHERE tenant_id=$1)::int m,(SELECT name FROM consent_modules WHERE tenant_id=$1 AND id=$2) n,(SELECT COUNT(*) FROM client_consent_records WHERE tenant_id=$1)::int r, (SELECT LEFT(gdpr_template_body,20) FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1) b", [T, SYS_ID]);
  const okBase = fin.m === 1 && fin.n === sysSnap.name && fin.r === 0 && String(fin.b) === String(bizSnap.gdpr_template_body).slice(0, 20);
  console.log(`CLEANUP: ${okBase ? "baseline OK" : "DIVERSA " + JSON.stringify(fin)} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
