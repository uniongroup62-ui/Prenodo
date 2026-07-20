// Sedi pass 2 (2026-07-17) — FIX: cascata delete-sede e move ordinamento in
// TRANSAZIONE (LocationDeletion 557-646 / sede_move_location legacy).
// Verifica live: delete completa (cleanup+master esclusivi+condivisi staccati+
// riassegnazione clienti+log permanente+reorder), guardie (ELIMINA
// case-sensitive, storico blocca), gate piano, duplicato nome, move+limite.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["settings.general", "settings.location"], needsEmailVerification: false, currentLocationId: 21, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);
const ZNAME = `ZZ SedeP2 ${RUN}`;

const logWatermark = Number((await q1("SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1", [T]))?.m ?? 0);
let zId = 0, resExcl = 0, resShared = 0, cid = 0, delLogId = 0;
try {
  // S1: nuova sede -> marketplace_enabled=0, sort appeso
  const s1 = await api({ action: "location_save", name: ZNAME, address: "Via ZZ 9" });
  const zRow = await q1("SELECT id, marketplace_enabled, sort_order, is_active, booking_enabled FROM locations WHERE tenant_id=$1 AND name=$2", [T, ZNAME]);
  zId = Number(zRow?.id ?? 0);
  check("S1 nuova sede: marketplace OFF, sort in coda, attiva", s1.j?.message === "Sede salvata" && zId > 0 && Number(zRow.marketplace_enabled) === 0 && Number(zRow.sort_order) === 2, JSON.stringify(zRow));

  // S2: duplicato case/trim -> errore verbatim
  const s2 = await api({ action: "location_save", name: "  sede1  " });
  check("S2 duplicato nome case/trim-insensitive", err(s2) === "Esiste gia una sede con questo nome.", JSON.stringify(err(s2)));

  // S3: gate piano (flip flag saas_tenants) su booking e marketplace
  await q("UPDATE saas_tenants SET booking_public_allowed=0, marketplace_public_allowed=0 WHERE id=$1", [T]);
  const s3 = await api({ action: "location_save", id: String(zId), name: ZNAME, booking_enabled: "1" });
  check("S3 gate piano booking: 'Funzione non disponibile per il tuo account' (senza punto)", err(s3) === "Funzione non disponibile per il tuo account", JSON.stringify(err(s3)));
  // Gli errori marketplace viaggiano col wrapper legacy (locations.php 447).
  const s3b = await api({ action: "location_marketplace_save", location_id: String(zId), marketplace_enabled: "1", activity_category_ids: "1" });
  check("S3b gate piano marketplace: wrapper legacy + messaggio senza punto", err(s3b) === "Errore salvataggio marketplace sede: Funzione non disponibile per il tuo account", JSON.stringify(err(s3b)));
  await q("UPDATE saas_tenants SET booking_public_allowed=1, marketplace_public_allowed=1 WHERE id=$1", [T]);

  // S4: marketplace ON senza categorie -> guardia (wrappata)
  const s4 = await api({ action: "location_marketplace_save", location_id: String(zId), marketplace_enabled: "1" });
  check("S4 marketplace senza categorie bloccato (wrapper legacy)", err(s4) === "Errore salvataggio marketplace sede: Seleziona almeno una categoria attivita per rendere visibile la sede.", JSON.stringify(err(s4)));

  // SEMINA dominio nella sede ZZ: cleanup tables + master esclusivo/condiviso + cliente
  await q("INSERT INTO business_hours (tenant_id, location_id, dow, opens, closes, is_closed) VALUES ($1,$2,1,'09:00','18:00',0)", [T, zId]);
  await q("INSERT INTO cabins (tenant_id, name, position, is_active, location_id) VALUES ($1,$2,1,1,$3)", [T, `ZZ CabSede ${RUN}`, zId]);
  await q("INSERT INTO staff_locations (tenant_id, staff_id, location_id) VALUES ($1,56,$2)", [T, zId]);
  resExcl = Number((await q("INSERT INTO resources (tenant_id, name, qty_total) VALUES ($1,$2,1) RETURNING id", [T, `ZZ ResExcl ${RUN}`])).rows[0].id);
  await q("INSERT INTO resource_locations (tenant_id, resource_id, location_id, qty_total, is_enabled) VALUES ($1,$2,$3,1,1)", [T, resExcl, zId]);
  resShared = Number((await q("INSERT INTO resources (tenant_id, name, qty_total) VALUES ($1,$2,2) RETURNING id", [T, `ZZ ResShared ${RUN}`])).rows[0].id);
  await q("INSERT INTO resource_locations (tenant_id, resource_id, location_id, qty_total, is_enabled) VALUES ($1,$2,$3,1,1),($1,$2,21,1,1)", [T, resShared, zId]);
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,$3,NOW()) RETURNING id", [T, `ZZ CliSede ${RUN}`, zId])).rows[0].id);
  await q("INSERT INTO location_gallery_images (tenant_id, location_id, path, sort_order, is_active) VALUES ($1,$2,'uploads/zz-fake.png',10,1)", [T, zId]);

  // P1: preview -> eliminabile, esclusivi/condivisi classificati
  const pv = await api({ action: "location_delete_preview", id: String(zId) });
  const pj = pv.j?.deletePreview ?? pv.j;
  check("P1 preview: canDelete + resource esclusiva/condivisa classificate + cliente nel piano", pj?.canDelete === true && pj?.confirmText === "ELIMINA" && (pj?.exclusive?.resources ?? {})[String(resExcl)] === `ZZ ResExcl ${RUN}` && (pj?.shared?.resources ?? {})[String(resShared)] === `ZZ ResShared ${RUN}` && Boolean((pj?.shared?.clients ?? {})[String(cid)]), JSON.stringify({ can: pj?.canDelete, ex: pj?.exclusive?.resources, sh: pj?.shared?.resources, cl: pj?.shared?.clients }));

  // D1: conferma sbagliata (case) -> 'Conferma non valida.'
  const d1 = await api({ action: "location_delete", id: String(zId), confirm_text: "elimina" });
  check("D1 conferma 'elimina' minuscola rifiutata", err(d1) === "Conferma non valida.", JSON.stringify(err(d1)));

  // D2: DELETE COMPLETA in transazione
  const d2 = await api({ action: "location_delete", id: String(zId), confirm_text: "ELIMINA", reason: "probe pass2" });
  const after = await q1(`SELECT
    (SELECT COUNT(*) FROM locations WHERE tenant_id=$1 AND id=$2)::int loc,
    (SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1 AND location_id=$2)::int bh,
    (SELECT COUNT(*) FROM cabins WHERE tenant_id=$1 AND location_id=$2)::int cab,
    (SELECT COUNT(*) FROM staff_locations WHERE tenant_id=$1 AND location_id=$2)::int sl,
    (SELECT COUNT(*) FROM location_gallery_images WHERE tenant_id=$1 AND location_id=$2)::int gal,
    (SELECT COUNT(*) FROM resources WHERE tenant_id=$1 AND id=$3)::int rex,
    (SELECT COUNT(*) FROM resources WHERE tenant_id=$1 AND id=$4)::int rsh,
    (SELECT COUNT(*) FROM resource_locations WHERE tenant_id=$1 AND resource_id=$4 AND location_id=21)::int rshmap,
    (SELECT COUNT(*) FROM resource_locations WHERE tenant_id=$1 AND location_id=$2)::int rmapz`, [T, zId, resExcl, resShared]);
  check("D2 delete: sede+righe sede azzerate, resource ESCLUSIVA eliminata", d2.j?.message === "Sede eliminata definitivamente" && after.loc === 0 && after.bh === 0 && after.cab === 0 && after.sl === 0 && after.gal === 0 && after.rex === 0 && after.rmapz === 0, JSON.stringify(after));
  check("D2b resource CONDIVISA conservata con la mappatura sede 21", after.rsh === 1 && after.rshmap === 1, JSON.stringify({ rsh: after.rsh, rshmap: after.rshmap }));
  const cli = await q1("SELECT location_id FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]);
  check("D2c cliente riassegnato (mai orfano sulla sede eliminata)", cli && Number(cli.location_id ?? 0) !== zId, JSON.stringify(cli));
  const staff56 = await q1("SELECT COUNT(*)::int n FROM staff_locations WHERE tenant_id=$1 AND staff_id=56 AND location_id=51", [T]);
  check("D2d staff condiviso intatto (56@51 conservata)", Number(staff56?.n) === 1, JSON.stringify(staff56));
  const dlog = await q1("SELECT id, location_name, reason FROM location_deletion_logs WHERE tenant_id=$1 AND location_id=$2 ORDER BY id DESC LIMIT 1", [T, zId]);
  delLogId = Number(dlog?.id ?? 0);
  const items = Number((await q1("SELECT COUNT(*) n FROM location_deletion_log_items WHERE tenant_id=$1 AND log_id=$2", [T, delLogId]))?.n ?? 0);
  check("D2e log PERMANENTE scritto (riga + items, reason conservata)", delLogId > 0 && dlog.location_name === ZNAME && dlog.reason === "probe pass2" && items > 0, JSON.stringify({ dlog, items }));
  const ord = (await q("SELECT id, sort_order FROM locations WHERE tenant_id=$1 ORDER BY sort_order", [T])).rows.map((r) => [r.id, r.sort_order]);
  check("D2f ordinamento ricompattato (21=0, 51=1)", JSON.stringify(ord) === JSON.stringify([[21, 0], [51, 1]]), JSON.stringify(ord));

  // D3: sede con storico NON eliminabile (sede 21 intatta)
  const d3 = await api({ action: "location_delete", id: "21", confirm_text: "ELIMINA" });
  const still21 = Number((await q1("SELECT COUNT(*) n FROM locations WHERE tenant_id=$1 AND id=21", [T]))?.n);
  check("D3 sede con storico bloccata e intatta", err(d3).includes("La sede contiene storico operativo o contabile") && still21 === 1, JSON.stringify(err(d3)).slice(0, 120));

  // M1: move 51 su -> swap; ancora su -> limite; giu -> ripristino
  const m1 = await api({ action: "location_move", id: "51", direction: "up" });
  const ordM1 = (await q("SELECT id FROM locations WHERE tenant_id=$1 ORDER BY sort_order", [T])).rows.map((r) => Number(r.id));
  check("M1 move up: swap (51 prima di 21)", m1.j?.message === "Ordine sedi aggiornato" && JSON.stringify(ordM1) === "[51,21]", JSON.stringify(ordM1));
  const m2 = await api({ action: "location_move", id: "51", direction: "up" });
  check("M2 move oltre il limite: messaggio SUCCESS legacy", m2.j?.message === "La sede e gia in posizione limite.", JSON.stringify(m2.j?.message));
  const m3 = await api({ action: "location_move", id: "51", direction: "down" });
  const ordM3 = (await q("SELECT id FROM locations WHERE tenant_id=$1 ORDER BY sort_order", [T])).rows.map((r) => Number(r.id));
  check("M3 move down: ordine produzione ripristinato", m3.j?.message === "Ordine sedi aggiornato" && JSON.stringify(ordM3) === "[21,51]", JSON.stringify(ordM3));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("UPDATE saas_tenants SET booking_public_allowed=1, marketplace_public_allowed=1 WHERE id=$1", [T]).catch(() => {});
  if (zId) {
    for (const [t, c] of [["business_hours", "location_id"], ["cabins", "location_id"], ["staff_locations", "location_id"], ["location_gallery_images", "location_id"], ["resource_locations", "location_id"], ["locations", "id"]]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND ${c}=$2`, [T, zId]).catch(() => {});
    }
  }
  for (const r of [resExcl, resShared]) if (r) {
    await q("DELETE FROM resource_locations WHERE tenant_id=$1 AND resource_id=$2", [T, r]).catch(() => {});
    await q("DELETE FROM resources WHERE tenant_id=$1 AND id=$2", [T, r]).catch(() => {});
  }
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  if (delLogId) {
    await q("DELETE FROM location_deletion_log_items WHERE tenant_id=$1 AND log_id=$2", [T, delLogId]).catch(() => {});
    await q("DELETE FROM location_deletion_logs WHERE tenant_id=$1 AND id=$2", [T, delLogId]).catch(() => {});
  }
  await q("DELETE FROM activity_logs WHERE tenant_id=$1 AND module='impostazioni' AND id > $2", [T, logWatermark]).catch(() => {});
  const fin = await q1(`SELECT
    (SELECT COUNT(*) FROM locations WHERE tenant_id=$1)::int locs,
    (SELECT string_agg(id::text, ',' ORDER BY sort_order) FROM locations WHERE tenant_id=$1) ord,
    (SELECT booking_public_allowed FROM saas_tenants WHERE id=$1)::int bpa,
    (SELECT COUNT(*) FROM resources WHERE tenant_id=$1 AND name LIKE 'ZZ Res%')::int zres,
    (SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cli`, [T]);
  const okBase = fin.locs === 2 && fin.ord === "21,51" && fin.bpa === 1 && fin.zres === 0 && fin.cli === 5;
  console.log(`CLEANUP: ${okBase ? "baseline OK" : "DIVERSA " + JSON.stringify(fin)} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
