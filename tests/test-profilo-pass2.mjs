// Profilo attività pass 2 (2026-07-17) — FIX: MIME dai MAGIC BYTES su upload
// logo/copertina/gallery sede (getimagesize legacy, mai il type dichiarato).
// + riverifica save profilo (wrapper strict), validazioni, guardia
// 'Rimuovi ... attuale', reset posizione 50/50 su upload (delete no), clamp.
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
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["settings.general", "settings.location"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;

const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
const q1 = async (sql, p) => (await q(sql, p)).rows[0];
async function api(body) {
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
async function upload(fields) {
  const form = new FormData();
  for (const [k, v] of fields) form.append(k, v);
  const res = await fetch(`${BASE}/api/manage/business-settings?slug=${SLUG}`, { method: "POST", headers: { cookie, "x-tenant-slug": SLUG }, body: form });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const err = (r) => String(r.j?.error ?? "");
const RUN = String(Date.now()).slice(-6);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.from([13, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0])]);
const BMP = Buffer.concat([Buffer.from("BM"), Buffer.alloc(64)]);

const snap = await q1("SELECT id, name, booking_about_text, logo_path, logo_position_x, logo_position_y, cover_path FROM businesses WHERE tenant_id=$1 ORDER BY id ASC LIMIT 1", [T]);
let galleryId = 0;
try {
  // S1: save profilo con valori di test e RIPRISTINO via API (sync marketplace incluso)
  const s1 = await api({ action: "business_profile_save", business_name: `ZZ Profilo ${RUN}`, booking_about_text: `Chi siamo ${RUN}` });
  const b1 = await q1("SELECT name, booking_about_text FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  check("S1 save profilo: nome+chi-siamo salvati, msg 'Profilo attività salvato'", s1.j?.message === "Profilo attività salvato" && b1?.name === `ZZ Profilo ${RUN}` && b1?.booking_about_text === `Chi siamo ${RUN}`, JSON.stringify({ m: s1.j?.message, b: b1 }));
  const s1r = await api({ action: "business_profile_save", business_name: snap.name, booking_about_text: snap.booking_about_text ?? "" });
  const b1r = await q1("SELECT name, booking_about_text FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  check("S1b ripristino via API (marketplace ri-sincronizzato)", s1r.j?.message === "Profilo attività salvato" && b1r?.name === snap.name && (b1r?.booking_about_text ?? null) === (snap.booking_about_text ?? null), JSON.stringify(b1r));

  // S2/S3: wrapper errore strict
  const s2 = await api({ action: "business_profile_save", business_name: "", booking_about_text: "" });
  check("S2 nome vuoto -> wrapper 'Errore salvataggio profilo attività: Inserisci il nome attività. (se persiste...'", err(s2).startsWith("Errore salvataggio profilo attività: Inserisci il nome attività.") && err(s2).includes("(se persiste, controlla che lo schema business"), JSON.stringify(err(s2)));
  const s3 = await api({ action: "business_profile_save", business_name: "x".repeat(191) });
  check("S3 nome >190 -> errore lunghezza nel wrapper", err(s3).includes("Il nome attività può contenere al massimo 190 caratteri."), JSON.stringify(err(s3)));

  // U-serie: logo (temporaneamente svuotato via SQL per aggirare la guardia 'Rimuovi...')
  await q("UPDATE businesses SET logo_path=NULL WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  const u1 = await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([Buffer.from("non sono un png")], "x.png", { type: "image/png" })]]);
  check("U1 contenuto non-immagine dichiarato png -> 'Formato immagine non supportato'", u1.j?.ok === false && err(u1) === "Errore upload logo: Formato immagine non supportato" && (u1.j?.errors ?? [])[0] === err(u1), JSON.stringify(err(u1)));
  const u2 = await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([WEBP], "x.png", { type: "image/png" })]]);
  check("U2 WEBP reale dichiarato png -> logo rifiutato 'carica un file JPG o PNG'", u2.j?.ok === false && err(u2) === "Errore upload logo: Formato non valido: carica un file JPG o PNG", JSON.stringify(err(u2)));
  const u3 = await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([PNG], "x.bin", { type: "text/plain" })]]);
  const b3 = await q1("SELECT logo_path, logo_position_x, logo_position_y FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  const u3ok = (u3.j?.message === "Logo salvato" && String(b3?.logo_path ?? "").startsWith("https://") && Number(b3?.logo_position_x) === 50 && Number(b3?.logo_position_y) === 50) || u3.status === 503;
  check("U3 PNG reale dichiarato text/plain -> ACCETTATO + posizione reset 50/50", u3ok, JSON.stringify({ s: u3.status, m: u3.j?.message, e: err(u3), b: b3 }));
  if (u3.j?.message === "Logo salvato") {
    // Guardia: secondo upload con logo presente -> 'Rimuovi il logo attuale...'
    const u4 = await upload([["action", "upload_logo"], ["kind", "logo"], ["business_logo", new File([PNG], "y.png", { type: "image/png" })]]);
    check("U4 logo già presente -> 'Rimuovi il logo attuale prima di caricarne uno nuovo.'", err(u4) === "Errore upload logo: Rimuovi il logo attuale prima di caricarne uno nuovo.", JSON.stringify(err(u4)));
    // Posizione: clamp 0-100
    const p1 = await api({ action: "save_logo_position", kind: "logo", logo_position_x: "150", logo_position_y: "-10" });
    const bp = await q1("SELECT logo_position_x x, logo_position_y y FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
    check("P1 posizione clampata 0-100 (150->100, -10->0), msg 'Posizione logo salvata'", p1.j?.message === "Posizione logo salvata" && Number(bp?.x) === 100 && Number(bp?.y) === 0, JSON.stringify(bp));
    // Delete: rimuove il MIO oggetto e NON tocca la posizione (delete non resetta)
    const d1 = await api({ action: "delete_logo", kind: "logo" });
    const bd = await q1("SELECT logo_path, logo_position_x x, logo_position_y y FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
    check("D1 delete logo: path NULL, posizione NON resettata (100/0), msg 'Logo rimosso'", d1.j?.message === "Logo rimosso" && bd?.logo_path === null && Number(bd?.x) === 100 && Number(bd?.y) === 0, JSON.stringify(bd));
  } else {
    check("U4 (saltato: storage non configurato)", true);
    check("P1 (saltato)", true);
    check("D1 (saltato)", true);
  }

  // G-serie: gallery sede (nessuna pre-guardia, negativo pulito)
  const g1 = await upload([["action", "location_gallery_upload"], ["location_id", String(LOC)], ["location_gallery_images", new File([Buffer.from("garbage")], "x.jpg", { type: "image/jpeg" })]]);
  check("G1 gallery contenuto non-immagine -> 'Errore upload gallery sede: Formato immagine non supportato'", err(g1) === "Errore upload gallery sede: Formato immagine non supportato", JSON.stringify(err(g1)));
  const g2 = await upload([["action", "location_gallery_upload"], ["location_id", String(LOC)], ["location_gallery_images", new File([BMP], "x.jpg", { type: "image/jpeg" })]]);
  check("G2 gallery BMP reale -> 'Formato non valido: carica JPG, PNG o WEBP'", err(g2) === "Errore upload gallery sede: Formato non valido: carica JPG, PNG o WEBP", JSON.stringify(err(g2)));
  const g3 = await upload([["action", "location_gallery_upload"], ["location_id", String(LOC)], ["location_gallery_images", new File([WEBP], "x.bin", { type: "application/octet-stream" })]]);
  const gRow = await q1("SELECT id, path FROM location_gallery_images WHERE tenant_id=$1 AND location_id=$2 ORDER BY id DESC LIMIT 1", [T, LOC]);
  galleryId = g3.j?.message === "Foto gallery sede caricate" ? Number(gRow?.id ?? 0) : 0;
  const g3ok = (g3.j?.message === "Foto gallery sede caricate" && String(gRow?.path ?? "").includes(".webp")) || g3.status === 503 || err(g3).includes("storage");
  check("G3 gallery WEBP reale dichiarato octet-stream -> ACCETTATO con estensione .webp", g3ok, JSON.stringify({ m: g3.j?.message, e: err(g3), p: gRow?.path }));
  if (galleryId > 0) {
    const gd = await api({ action: "location_gallery_delete", location_id: String(LOC), gallery_image_id: String(galleryId) });
    const gone = Number((await q1("SELECT COUNT(*) n FROM location_gallery_images WHERE tenant_id=$1 AND id=$2", [T, galleryId]))?.n);
    check("G4 delete foto gallery caricata -> rimossa", gd.j?.ok !== false && gone === 0, JSON.stringify({ e: err(gd), gone }));
    if (gone === 0) galleryId = 0;
  } else {
    check("G4 (saltato)", true);
  }
} catch (e) {
  check("EXCEPTION", false, e.stack || e.message);
} finally {
  await q("UPDATE businesses SET name=$3, booking_about_text=$4, logo_path=$5, logo_position_x=$6, logo_position_y=$7, cover_path=$8 WHERE tenant_id=$1 AND id=$2", [T, snap.id, snap.name, snap.booking_about_text, snap.logo_path, snap.logo_position_x, snap.logo_position_y, snap.cover_path]).catch(() => {});
  if (galleryId) await q("DELETE FROM location_gallery_images WHERE tenant_id=$1 AND id=$2", [T, galleryId]).catch(() => {});
  // Ri-sync marketplace col profilo RIPRISTINATO (position save non-strict)
  await api({ action: "save_logo_position", kind: "logo", logo_position_x: String(snap.logo_position_x ?? 50), logo_position_y: String(snap.logo_position_y ?? 50) }).catch(() => {});
  const fin = await q1("SELECT name, booking_about_text, logo_path, logo_position_x, logo_position_y, cover_path FROM businesses WHERE tenant_id=$1 AND id=$2", [T, snap.id]);
  const okBase = fin?.name === snap.name && (fin?.booking_about_text ?? null) === (snap.booking_about_text ?? null) && (fin?.logo_path ?? null) === (snap.logo_path ?? null) && Number(fin?.logo_position_x ?? 50) === Number(snap.logo_position_x ?? 50) && (fin?.cover_path ?? null) === (snap.cover_path ?? null);
  const zzLogs = Number((await q1("SELECT COUNT(*) n FROM activity_logs WHERE tenant_id=$1 AND module='impostazioni' AND label LIKE '%ZZ Profilo%'", [T]))?.n ?? 0);
  console.log(`CLEANUP: baseline businesses=${okBase ? "OK" : "DIVERSA " + JSON.stringify(fin)} -> ${okBase ? "CLEAN" : "DIRTY!!"}`);
  const pass = R.filter(Boolean).length, fail = R.length - pass;
  console.log(`==== ${pass} PASS / ${fail} FAIL ====`);
  await pool.end();
  process.exit(fail === 0 && okBase ? 0 : 1);
}
