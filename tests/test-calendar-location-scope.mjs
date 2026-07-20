// Scope per-sede in LETTURA del feed calendario (port di api_appointments
// action=list 8044-8052): utente ristretto a Sede1 vede SOLO gli appuntamenti
// della sua sede; l'admin vede SEDE PER SEDE (a sede 0 in un tenant
// multi-sede il legacy fail-chiude: app_user_location_ids>0 -> j([]) —
// sanato 18/07, prima la suite attendeva "admin a sede 0 vede tutto").
// AUTO-SEMINANTE (la prima versione cablava id di una semina precedente).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL = ""; for (const l of envText.split(/\r?\n/)) { const m = l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/); if (m) DBURL = m[1].trim().replace(/^["']|["']$/g, ""); }
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();

const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const SLUG = "centroesteticoelite";
const COOKIE_NAME = "beautysuite_session_t_centroesteticoelite";
const T = 25;
const DAY = "2026-08-27";
const URL_CAL = `http://localhost:3000/api/manage/calendar?slug=${SLUG}&date=${DAY}&start=${DAY}&end=2026-08-28`;

function sign(session) {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function mkSession({ role, locationIds, currentLocationId }) {
  return {
    tenantSlug: SLUG,
    user: {
      id: 20, email: "info@artebrand.it", name: "luca", role,
      perms: ["calendar.view", "appointments.manage", "appointments.quick_booking"],
      needsEmailVerification: false,
      currentLocationId, needsLocationSelection: false, locationIds,
    },
    issuedAt: Date.now(), epoch: 1_000_000_000,
  };
}
const restricted = sign(mkSession({ role: "staff", locationIds: [21], currentLocationId: 21 }));
const admin0 = sign(mkSession({ role: "admin", locationIds: [], currentLocationId: 0 }));
const admin21 = sign(mkSession({ role: "admin", locationIds: [], currentLocationId: 21 }));
const admin51 = sign(mkSession({ role: "admin", locationIds: [], currentLocationId: 51 }));

async function calFeed(token) {
  const res = await fetch(URL_CAL, { headers: { "x-tenant-slug": SLUG, cookie: `${COOKIE_NAME}=${token}` } });
  const json = await res.json();
  const ids = (json.appointments ?? []).map((a) => Number(a.id));
  return { status: res.status, ids: new Set(ids), count: ids.length };
}

const ids = { clients: [], appts: [] };
let pass = 0, fail = 0;
try {
  ids.clients.push(Number((await db.query(`INSERT INTO clients (tenant_id,full_name) VALUES ($1,'ZZ CalScope Cli') RETURNING id`, [T])).rows[0].id));
  const mkAppt = async (loc) => Number((await db.query(
    `INSERT INTO appointments (tenant_id,client_id,location_id,starts_at,ends_at,status) VALUES ($1,$2,$3,'${DAY} 10:00:00','${DAY} 11:00:00','scheduled') RETURNING id`,
    [T, ids.clients[0], loc],
  )).rows[0].id);
  const a21 = await mkAppt(21);
  const a51 = await mkAppt(51);
  ids.appts.push(a21, a51);

  const r = await calFeed(restricted);
  const a0 = await calFeed(admin0);
  const a1 = await calFeed(admin21);
  const a5 = await calFeed(admin51);
  const checks = [
    ["RESTRICTED[21] http 200", r.status === 200],
    [`RESTRICTED[21] SEES Sede1 appt ${a21}`, r.ids.has(a21)],
    [`RESTRICTED[21] HIDES Sede2 appt ${a51}`, !r.ids.has(a51)],
    ["ADMIN sede 0 http 200", a0.status === 200],
    ["ADMIN sede 0 -> VUOTO (fail-closed multi-sede)", !a0.ids.has(a21) && !a0.ids.has(a51)],
    [`ADMIN@21 SEES Sede1 ${a21} e HIDES Sede2`, a1.ids.has(a21) && !a1.ids.has(a51)],
    [`ADMIN@51 SEES Sede2 ${a51} e HIDES Sede1`, a5.ids.has(a51) && !a5.ids.has(a21)],
  ];
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} | ${label}`);
    ok ? pass++ : fail++;
  }
  console.log(`\nrestricted: ${r.count} | admin0: ${a0.count} | admin21: ${a1.count} | admin51: ${a5.count}`);
} catch (e) {
  console.log("FATAL", e);
  fail++;
} finally {
  if (ids.appts.length) await db.query(`DELETE FROM appointments WHERE tenant_id=$1 AND id=ANY($2)`, [T, ids.appts]).catch(() => {});
  if (ids.clients.length) await db.query(`DELETE FROM clients WHERE tenant_id=$1 AND id=ANY($2) AND full_name LIKE 'ZZ%'`, [T, ids.clients]).catch(() => {});
  const after = (await db.query(`SELECT COUNT(*)::int n FROM appointments WHERE tenant_id=$1`, [T])).rows[0];
  console.log(`[after-cleanup] appointments=${after.n} (atteso 10)`);
  await db.end();
  console.log(`=== ${pass} PASS / ${fail} FAIL ===`);
}
