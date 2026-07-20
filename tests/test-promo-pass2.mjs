// Promozioni pass 2 (2026-07-17) — percorsi non coperti dalle suite:
//  A) lock strutturale sul SAVE diretto (bypass del form): regola cambiata con
//     utilizzi collegati -> errore verbatim; modifica NON-strutturale (titolo) OK
//  B) esclusioni dal riepilogo: target mismatch + associazione esistente (guardie verbatim)
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["promotions.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/promotions?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const LOCK_MSG = "Questa promozione ha gia prenotazioni, vendite o utilizzi collegati: puoi clonare la campagna, ma non modificare direttamente la regola esistente.";

let promoId = 0, cliA = 0, cliB = 0, apptId = 0;
const SAVE_BASE = (over = {}) => ({
  action: "save", title: `ZZ PromoLock${RUN}`, apply_services_mode: "all", discount_type: "percent", discount_value: "10",
  target_type: "all", location_ids_json: JSON.stringify([21]), active: "0", ...over,
});
try {
  cliA = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ PrmCliA${RUN}`])).rows[0].id);
  cliB = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,21,NOW()) RETURNING id", [T, `ZZ PrmCliB${RUN}`])).rows[0].id);

  // Promo INATTIVA (nessun conflitto scope) creata via API
  const s1 = await api(SAVE_BASE());
  promoId = Number(s1.j?.promotion?.id ?? 0);
  check("S1 create ok", s1.j?.ok === true && promoId > 0, JSON.stringify(s1.j?.error ?? ""));

  // Utilizzo collegato: prenotazione con promotion_id (stato scheduled)
  apptId = Number((await q("INSERT INTO appointments (tenant_id, client_id, starts_at, ends_at, status, promotion_id) VALUES ($1,$2,'2027-05-01 10:00','2027-05-01 11:00','scheduled',$3) RETURNING id", [T, cliA, promoId])).rows[0].id);

  // A1: SAVE diretto che CAMBIA la regola (sconto 10->20) -> lock verbatim
  const s2 = await api(SAVE_BASE({ id: promoId, discount_value: "20" }));
  check("A1 save strutturale con utilizzi -> lock verbatim", s2.j?.ok !== true && s2.j?.error === LOCK_MSG, JSON.stringify(s2.j?.error));
  const dv = await q1("SELECT discount_value::float d, title FROM promotions WHERE tenant_id=$1 AND id=$2", [T, promoId]);
  check("A2 regola NON modificata (sconto resta 10)", dv && dv.d === 10, JSON.stringify(dv));

  // A3: modifica NON-strutturale (solo titolo) -> consentita
  const s3 = await api(SAVE_BASE({ id: promoId, title: `ZZ PromoLock${RUN} rinominata` }));
  const dv2 = await q1("SELECT title FROM promotions WHERE tenant_id=$1 AND id=$2", [T, promoId]);
  check("A3 modifica solo-titolo consentita con utilizzi", s3.j?.ok === true && dv2.title === `ZZ PromoLock${RUN} rinominata`, JSON.stringify({ ok: s3.j?.ok, t: dv2?.title }));

  // B1: esclusione del cliente ASSOCIATO -> guardia verbatim
  const e1 = await api({ action: "exclusion_add", promotion_id: promoId, client_id: cliA });
  check("B1 esclusione cliente con prenotazione associata -> guardia verbatim", e1.j?.ok !== true && e1.j?.error === "Il cliente ha già una prenotazione o vendita associata a questa promozione.", JSON.stringify(e1.j?.error));

  // B2: target 'new' (nuovi clienti entro 30gg) — cliB creato ora rientra; poi
  //     target mismatch con cliente vecchio simulato (created_at 2 anni fa)
  await q("UPDATE promotions SET target_type='new', new_within_days=30 WHERE tenant_id=$1 AND id=$2", [T, promoId]);
  const e2 = await api({ action: "exclusion_add", promotion_id: promoId, client_id: cliB });
  check("B2 esclusione cliente nel target -> ok", e2.j?.ok === true, JSON.stringify(e2.j?.error ?? ""));
  // Legacy (Promotions.php 3038-3043): per target NON-fidelity l'esclusione è una
  // blacklist esplicita, NON filtrata dinamicamente (nuovo/inattivo/compleanno).
  await q("UPDATE clients SET created_at = NOW() - interval '2 years' WHERE tenant_id=$1 AND id=$2", [T, cliB]);
  await api({ action: "exclusion_remove", promotion_id: promoId, client_id: cliB });
  const e3 = await api({ action: "exclusion_add", promotion_id: promoId, client_id: cliB });
  check("B3 target 'new': cliente vecchio ESCLUDIBILE comunque (blacklist esplicita legacy)", e3.j?.ok === true, JSON.stringify(e3.j?.error ?? ""));
  // B4: target FIDELITY con cliente NON aderente -> guardia verbatim
  await api({ action: "exclusion_remove", promotion_id: promoId, client_id: cliB });
  await q("UPDATE promotions SET target_type='fidelity', new_within_days=NULL WHERE tenant_id=$1 AND id=$2", [T, promoId]);
  const e4 = await api({ action: "exclusion_add", promotion_id: promoId, client_id: cliB });
  check("B4 target fidelity + non aderente -> 'Il cliente non rientra nel target attuale della promozione.'", e4.j?.ok !== true && e4.j?.error === "Il cliente non rientra nel target attuale della promozione.", JSON.stringify(e4.j?.error));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (apptId) await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  if (promoId) {
    for (const t of ["promotion_services", "promotion_products", "promotion_locations", "promotion_time_windows", "promotion_blackout_dates"]) {
      await q(`DELETE FROM ${t} WHERE tenant_id=$1 AND promotion_id=$2`, [T, promoId]).catch(() => {});
    }
    await q("DELETE FROM promotions WHERE tenant_id=$1 AND id=$2", [T, promoId]).catch(() => {});
  }
  for (const c of [cliA, cliB]) if (c) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, c]).catch(() => {});
  const left = Number((await q1("SELECT (SELECT COUNT(*) FROM promotions WHERE tenant_id=$1 AND id=$2)+(SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND id IN ($3,$4))+(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1 AND id=$5) n", [T, promoId || 0, cliA || 0, cliB || 0, apptId || 0])).n);
  console.log(`CLEANUP: residui=${left} -> ${left === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && left === 0 ? 0 : 1);
}
