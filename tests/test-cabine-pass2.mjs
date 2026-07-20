// Cabine pass 2 (2026-07-17) — bulk save (blocco rimozione con link, ordine =
// posizione, rename), delete (blockers servizi/prenotazioni + TZ Rome, soft
// delete + reorder), precedenza errori, GUARDIA SEDE (fix: location_id
// non assegnata/inesistente risolve a 0 come app_location_allowed_for_user).
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
function makeCookie(user) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["cabins.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] });
// Non-admin ristretto alla sede 21 (Modello A): stesse perms, ruolo manager.
const mgrCookie = makeCookie({ id: 20, email: "info@artebrand.it", name: "luca", role: "manager", perms: ["cabins.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [LOC] });

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function getCtx(params, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/resources?slug=${SLUG}&section=cabins${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const save = (namesIds, locId = LOC) => api({
  action: "cabins_save",
  location_id: String(locId || ""),
  cabins_count: String(namesIds.length),
  cabin_names_json: JSON.stringify(namesIds.map(([n]) => n)),
  cabin_ids_json: JSON.stringify(namesIds.map(([, i]) => i)),
});
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
// "adesso" Rome-local naive, offset in minuti
function romeNow(deltaMin = 0) {
  const d = new Date(Date.now() + deltaMin * 60000);
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
  return p.replace("T", " ");
}

let idA = 0, idB = 0, cid = 0, apptId = 0, linkAdded = false;
const NA = `ZZ CabP2A ${RUN}`, NB = `ZZ CabP2B ${RUN}`;
try {
  // S0: contesto sede 21
  const c0 = await getCtx(`&location_id=${LOC}`);
  const base9 = (c0.j?.cabins ?? []).find((c) => c.id === 9);
  check("S0 GET sede 21: activeLocationId 21 + cabina1 in lista", Number(c0.j?.activeLocationId) === LOC && Boolean(base9), JSON.stringify({ a: c0.j?.activeLocationId, n: (c0.j?.cabins ?? []).length }));

  // P1: rimozione via conteggio di cabina1 (id 9, collegata al servizio 9) -> BLOCCATA, nessuna insert
  const p1 = await save([[NA, 0]]);
  const p1rows = Number((await q1("SELECT COUNT(*) n FROM cabins WHERE tenant_id=$1 AND name=$2", [T, NA]))?.n ?? -1);
  check("P1 rimozione cabina collegata BLOCCA il save", p1.j?.ok === false && p1.j?.error === "Impostazioni non salvate: una o piu cabine sono associate a servizi o prenotazioni future.", JSON.stringify(p1.j?.error));
  check("P1b popup presente e NESSUNA riga nuova scritta (guardia pre-mutazione)", Boolean(p1.j?.popup) && p1rows === 0, `popup=${!!p1.j?.popup} rows=${p1rows}`);

  // P2: save valido [cabina1, A, B]
  const p2 = await save([["cabina1", 9], [NA, 0], [NB, 0]]);
  idA = Number((await q1("SELECT id FROM cabins WHERE tenant_id=$1 AND name=$2", [T, NA]))?.id ?? 0);
  idB = Number((await q1("SELECT id FROM cabins WHERE tenant_id=$1 AND name=$2", [T, NB]))?.id ?? 0);
  const rowsP2 = (await q("SELECT id, position, location_id, is_active FROM cabins WHERE tenant_id=$1 AND id = ANY($2) ORDER BY position", [T, [9, idA, idB]])).rows;
  check("P2 bulk create ok: 3 attive, posizioni 1-2-3, sede 21", p2.j?.ok === true && idA > 0 && idB > 0 && JSON.stringify(rowsP2.map((r) => [r.id, r.position, r.location_id, r.is_active])) === JSON.stringify([[9, 1, LOC, 1], [idA, 2, LOC, 1], [idB, 3, LOC, 1]]), JSON.stringify(rowsP2));

  // P3: swap A/B -> l'ordine di submit e' la posizione
  const p3 = await save([["cabina1", 9], [NB, idB], [NA, idA]]);
  const posP3 = (await q("SELECT id, position FROM cabins WHERE tenant_id=$1 AND id = ANY($2) ORDER BY position", [T, [9, idA, idB]])).rows.map((r) => [r.id, r.position]);
  check("P3 swap: ordine submit = position (cabina1,B,A)", p3.j?.ok === true && JSON.stringify(posP3) === JSON.stringify([[9, 1], [idB, 2], [idA, 3]]), JSON.stringify(posP3));

  // P4: rename B via bulk (stesso id)
  const p4 = await save([["cabina1", 9], [`${NB} Ren`, idB], [NA, idA]]);
  const nameB = (await q1("SELECT name FROM cabins WHERE tenant_id=$1 AND id=$2", [T, idB]))?.name;
  check("P4 rename via bulk conserva l'id", p4.j?.ok === true && nameB === `${NB} Ren`, JSON.stringify(nameB));

  // P5/P6/P7: errori e precedenza
  const p5 = await save([["cabina1", 9], ["", idA], [`${NB} Ren`, idB]]);
  check("P5 nome vuoto -> 'Inserisci un nome per tutte le cabine.'", p5.j?.ok === false && p5.j?.error === "Inserisci un nome per tutte le cabine.", JSON.stringify(p5.j?.error));
  const p6 = await save([["ZZ X", 0]], 0);
  check("P6 senza sede -> 'Seleziona una sede per configurare le cabine.'", p6.j?.ok === false && p6.j?.error === "Seleziona una sede per configurare le cabine.", JSON.stringify(p6.j?.error));
  const p7 = await save([["", 0]], 0);
  check("P7 precedenza: nome vuoto VINCE sull'errore sede", p7.j?.ok === false && p7.j?.error === "Inserisci un nome per tutte le cabine.", JSON.stringify(p7.j?.error));

  // P8: blocco delete da SERVIZIO collegato (link servizio 9 -> cabina A)
  await q("INSERT INTO service_cabins (tenant_id, service_id, cabin_id) VALUES ($1, 9, $2)", [T, idA]);
  linkAdded = true;
  const p8 = await api({ action: "cabin_delete", id: String(idA), location_id: String(LOC) });
  const p8svc = (p8.j?.popup?.services ?? []).map((s) => s.service_name);
  check("P8 delete con servizio collegato BLOCCATA (flash senza accento)", p8.j?.ok === false && p8.j?.error === "Cabina non eliminata: e associata a servizi o prenotazioni future.", JSON.stringify(p8.j?.error));
  check("P8b popup variante SERVIZI con 'test' elencato", String(p8.j?.popup?.message ?? "").includes("finché è presente in un servizio") && p8svc.includes("test"), JSON.stringify({ m: p8.j?.popup?.message, s: p8svc }));
  await q("DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id=9 AND cabin_id=$2", [T, idA]);
  linkAdded = false;

  // P9: blocco delete da PRENOTAZIONE futura (appointments.cabin_id)
  cid = Number((await q("INSERT INTO clients (tenant_id, full_name, location_id, created_at) VALUES ($1,$2,$3,NOW()) RETURNING id", [T, `ZZ CabP2Cli ${RUN}`, LOC])).rows[0].id);
  apptId = Number((await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code, cabin_id) VALUES ($1,$2,$3,'2027-06-01 10:00','2027-06-01 11:00','scheduled',$4,$5) RETURNING id", [T, cid, LOC, `ZZCB${RUN}`, idA])).rows[0].id);
  const p9 = await api({ action: "cabin_delete", id: String(idA), location_id: String(LOC) });
  const p9item = (p9.j?.popup?.services ?? []).find((s) => s.block_kind === "appointment");
  check("P9 delete con prenotazione futura BLOCCATA, popup variante prenotazioni", p9.j?.ok === false && String(p9.j?.popup?.message ?? "") === "La cabina e associata a servizi o prenotazioni future. Rimuovi prima i collegamenti o sposta le prenotazioni e poi riprova.", JSON.stringify(p9.j?.popup?.message));
  check("P9b blocker 'Prenotazione CODE' con dettaglio data - cliente - stato", p9item?.service_name === `Prenotazione ZZCB${RUN}` && String(p9item?.detail ?? "").includes("01/06/2027 10:00") && String(p9item?.detail ?? "").includes(`ZZ CabP2Cli ${RUN}`) && String(p9item?.detail ?? "").includes("scheduled"), JSON.stringify(p9item));

  // P10: TZ Rome — appuntamento finito 30' fa (ora di Roma) NON blocca piu'
  await q("UPDATE appointments SET starts_at=$1, ends_at=$2 WHERE tenant_id=$3 AND id=$4", [romeNow(-90), romeNow(-30), T, apptId]);
  const p10 = await api({ action: "cabin_delete", id: String(idA), location_id: String(LOC) });
  const afterA = await q1("SELECT is_active FROM cabins WHERE tenant_id=$1 AND id=$2", [T, idA]);
  const posP10 = (await q("SELECT id, position FROM cabins WHERE tenant_id=$1 AND location_id=$2 AND is_active=1 ORDER BY position", [T, LOC])).rows.map((r) => [r.id, r.position]);
  check("P10 TZ: finita 30' fa (Rome) -> delete OK, soft delete", p10.j?.ok === true && Number(afterA?.is_active) === 0, JSON.stringify({ ok: p10.j?.ok, a: afterA?.is_active }));
  check("P10b reorder compatta le posizioni (cabina1=1, B=2)", JSON.stringify(posP10) === JSON.stringify([[9, 1], [idB, 2]]), JSON.stringify(posP10));

  // P11: GUARDIA SEDE (fix) — manager ristretto a 21 non scrive nella 51
  const p11 = await api({ action: "cabins_save", location_id: "51", cabins_count: "1", cabin_names_json: JSON.stringify([`ZZ CabP2X ${RUN}`]), cabin_ids_json: JSON.stringify([0]) }, mgrCookie);
  const leak51 = Number((await q1("SELECT COUNT(*) n FROM cabins WHERE tenant_id=$1 AND location_id=51 AND name LIKE 'ZZ CabP2%'", [T]))?.n ?? -1);
  check("P11 sede NON assegnata risolve a 0 -> 'Seleziona una sede...'", p11.j?.ok === false && p11.j?.error === "Seleziona una sede per configurare le cabine." && leak51 === 0, JSON.stringify({ e: p11.j?.error, leak: leak51 }));
  const c11 = await getCtx("&location_id=51", mgrCookie);
  check("P11b GET sede 51 da ristretto -> activeLocationId 0 ('Tutte')", Number(c11.j?.activeLocationId) === 0, JSON.stringify(c11.j?.activeLocationId));
  const p11c = await save([[`ZZ CabP2Y ${RUN}`, 0]], 9999);
  check("P11c sede INESISTENTE (anche admin) -> errore sede", p11c.j?.ok === false && p11c.j?.error === "Seleziona una sede per configurare le cabine.", JSON.stringify(p11c.j?.error));
  const c11d = await getCtx("&location_id=51");
  check("P11d admin senza restrizioni: sede 51 resta onorata", Number(c11d.j?.activeLocationId) === 51, JSON.stringify(c11d.j?.activeLocationId));

  // P12: delete B pulita
  const p12 = await api({ action: "cabin_delete", id: String(idB), location_id: String(LOC) });
  const finalRows = (await q("SELECT id, position FROM cabins WHERE tenant_id=$1 AND location_id=$2 AND is_active=1 ORDER BY position", [T, LOC])).rows.map((r) => [r.id, r.position]);
  check("P12 delete senza blocchi ok, resta solo cabina1 pos 1", p12.j?.ok === true && p12.j?.msg === "Cabina eliminata" && JSON.stringify(finalRows) === JSON.stringify([[9, 1]]), JSON.stringify(finalRows));
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  if (linkAdded && idA) await q("DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id=9 AND cabin_id=$2", [T, idA]).catch(() => {});
  if (apptId) await q("DELETE FROM appointments WHERE tenant_id=$1 AND id=$2", [T, apptId]).catch(() => {});
  if (cid) await q("DELETE FROM clients WHERE tenant_id=$1 AND id=$2", [T, cid]).catch(() => {});
  for (const i of [idA, idB]) if (i) await q("DELETE FROM cabins WHERE tenant_id=$1 AND id=$2", [T, i]).catch(() => {});
  await q("UPDATE cabins SET position=1 WHERE tenant_id=$1 AND id=9", [T]).catch(() => {});
  const fin = (await q("SELECT id, name, position, is_active, location_id FROM cabins WHERE tenant_id=$1 ORDER BY id", [T])).rows;
  const okBase = JSON.stringify(fin.map((r) => [r.id, r.is_active, r.location_id])) === JSON.stringify([[9, 1, 21], [10, 0, 21], [45, 1, 51]]);
  const leftZ = Number((await q1("SELECT COUNT(*) n FROM cabins WHERE tenant_id=$1 AND name LIKE 'ZZ CabP2%'", [T]))?.n ?? -1);
  console.log(`CLEANUP: baseline=${okBase ? "OK" : "DIVERSA " + JSON.stringify(fin)} residuiZZ=${leftZ} -> ${okBase && leftZ === 0 ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase && leftZ === 0 ? 0 : 1);
}
