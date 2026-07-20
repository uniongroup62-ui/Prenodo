// Preventivo giro 2 (2026-07-18): probe chirurgico sui 2 fix TZ del giro —
// (a) link pubblico: 'Scaduto' calcolato su OGGI di ROMA (businessTodayIso);
// (b) action=seen: customer_decision_seen_at = wall-time ROMA (non NOW() UTC).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", LOC = 21, SVC = 9;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["quotes.manage", "clients.manage"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const qapi = (b) => fetch(`http://localhost:3000/api/manage/quotes?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const pub = (tok) => fetch(`http://localhost:3000/api/public/quote?slug=${SLUG}&token=${tok}`).then(async (r) => ({ s: r.status, j: await r.json() }));
const capi = (b) => fetch(`http://localhost:3000/api/manage/clients?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const romeParts = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d).replace("T", " ");
const romeToday = () => romeParts().slice(0, 10);
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const items = JSON.stringify([{ item_type: "service", item_id: SVC, description: "ZZ riga p4", qty: 1, unit_price: 40, tax_rate: 0, discount_percent: 0 }]);
let cid = 0, qid = 0;
try {
  const cj = await capi({ action: "create", first_name: "ZZ", last_name: `QP4_${RUN}`, location_id: String(LOC) });
  cid = Number(cj.client?.id ?? 0);
  const r0 = await qapi({ action: "save", mode: "new", client_id: String(cid), quote_date: romeToday(), status: "draft", location_id: String(LOC), items_json: items });
  qid = Number(r0.j.id ?? 0);
  if (!(qid > 0)) throw new Error("seed quote fallito: " + JSON.stringify(r0.j));
  const tok = crypto.randomBytes(16).toString("hex");
  // ieri e oggi in frame ROMA
  const today = romeToday();
  const yest = romeParts(new Date(Date.now() - 864e5)).slice(0, 10);
  // (a1) sent + valid_until IERI-Roma -> 'expired'
  await db.query("UPDATE quotes SET status='sent', public_token=$2, valid_until=$3 WHERE tenant_id=25 AND id=$1", [qid, tok, yest]);
  let r = await pub(tok);
  check("A1 pubblico: sent + valid_until ieri(Roma) -> Scaduto", r.s === 200 && r.j.ok === true && r.j.quote?.statusKey === "expired" && r.j.quote?.statusLabel === "Scaduto", JSON.stringify([r.j.quote?.statusKey, r.j.quote?.statusLabel]));
  // (a2) valid_until OGGI-Roma -> resta 'sent' (confronto STRETTO <, fedele)
  await db.query("UPDATE quotes SET valid_until=$2 WHERE tenant_id=25 AND id=$1", [qid, today]);
  r = await pub(tok);
  check("A2 pubblico: valid_until oggi(Roma) -> resta Inviato (strict <)", r.s === 200 && r.j.quote?.statusKey === "sent", JSON.stringify(r.j.quote?.statusKey));
  // (b) accepted + decision_at, poi action=seen -> seen_at wall-time ROMA
  await db.query("UPDATE quotes SET status='accepted', customer_decision_at=$2, customer_decision_seen_at=NULL WHERE tenant_id=25 AND id=$1", [qid, romeParts()]);
  const rs = await qapi({ action: "seen", id: String(qid) });
  const seenRaw = (await db.query("SELECT customer_decision_seen_at::text AS s FROM quotes WHERE tenant_id=25 AND id=$1", [qid])).rows[0]?.s ?? "";
  const nowRome = romeParts();
  const diffMin = Math.abs((new Date(seenRaw.replace(" ", "T")) - new Date(nowRome.replace(" ", "T"))) / 60000);
  check("B1 action=seen ok", rs.s === 200 && rs.j.ok === true, JSON.stringify(rs.j.message));
  check("B2 customer_decision_seen_at = wall-time ROMA (|delta|<3min; UTC sarebbe ~120min)", seenRaw !== "" && diffMin < 3, JSON.stringify({ seenRaw, nowRome, diffMin: Math.round(diffMin) }));
  // (b2) idempotenza: secondo seen non trova righe (seen_at gia' stampato) ma ok
  const rs2 = await qapi({ action: "seen", id: String(qid) });
  const seenRaw2 = (await db.query("SELECT customer_decision_seen_at::text AS s FROM quotes WHERE tenant_id=25 AND id=$1", [qid])).rows[0]?.s ?? "";
  check("B3 secondo seen: ok e timestamp INVARIATO", rs2.j.ok === true && seenRaw2 === seenRaw, JSON.stringify([seenRaw, seenRaw2]));
} finally {
  // cleanup con soli id tracciati in-sessione + purge log delle entita' morte
  if (qid > 0) { await db.query("DELETE FROM quote_items WHERE tenant_id=25 AND quote_id=$1", [qid]); await db.query("DELETE FROM quotes WHERE tenant_id=25 AND id=$1", [qid]); }
  if (cid > 0) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1 AND first_name='ZZ'", [cid]);
  if (qid > 0) await db.query("DELETE FROM activity_logs WHERE tenant_id=25 AND ((entity_type='quote' AND entity_id=$1) OR (entity_type='client' AND entity_id=$2))", [qid, cid]);
  const base = (await db.query("SELECT (SELECT COUNT(*) FROM clients WHERE tenant_id=25) c, (SELECT COUNT(*) FROM quotes WHERE tenant_id=25 AND client_name LIKE 'ZZ%') zq")).rows[0];
  console.log(`CLEANUP: clients=${base.c}/5 quoteZZ=${base.zq} -> ${base.c === "5" && base.zq === "0" ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
