// Pass GiftBox 2026-07-16: cross-action live — delete template CON istanze
// emesse (detach/sopravvivenza), edit template NON retroattivo sull'istanza,
// annullo istanza -> non riscattabile, voci Log (fase 2c).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG = "centroesteticoelite", T = 25, LOC = 21;
const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role: "admin", perms: ["giftbox.manage", "giftbox.settings"], needsEmailVerification: false, currentLocationId: LOC, needsLocationSelection: false, locationIds: [] }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
const cookie = `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
const api = (b) => fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const get = (qs) => fetch(`http://localhost:3000/api/manage/giftboxes?slug=${SLUG}&${qs}`, { headers: { cookie } }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
async function conn() { for (let i = 0; i < 10; i++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch {} if (i === 9) throw e; await new Promise((r) => setTimeout(r, 5000)); } } }
const db = await conn();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let tpl = 0, inst = 0, svcId = 0, cli = 0;
try {
  svcId = Number((await db.query("INSERT INTO services (tenant_id,name,price,is_active) VALUES (25,$1,60,1) RETURNING id", [`ZZ GbMutSvc${RUN}`])).rows[0].id);
  cli = Number((await db.query("INSERT INTO clients (tenant_id,full_name,location_id) VALUES (25,$1,21) RETURNING id", [`ZZ GbMutCli${RUN}`])).rows[0].id);
  // template via API
  let r = await api({ action: "save", name: `ZZ GbMut${RUN}`, eligibility: "all_clients", active: "1", items_json: JSON.stringify([{ item_type: "service", service_id: svcId, qty: 2 }]) });
  tpl = Number(r.j.template?.id ?? 0);
  check("S1 template creato", r.s === 200 && tpl > 0, JSON.stringify(r.j.error));
  // istanza emessa (seed diretto, l'emissione è solo-POS) con snapshot congelato
  const tplItem = (await db.query("SELECT id FROM giftbox_items WHERE tenant_id=25 AND giftbox_id=$1 LIMIT 1", [tpl])).rows[0];
  inst = Number((await db.query(`INSERT INTO giftbox_instances (tenant_id, giftbox_id, code, client_id, status, issued_at, points_cost, created_by, created_at, location_id, location_name)
    VALUES (25,$1,$2,$3,'issued',NOW(),0,20,NOW(),21,'Sede1') RETURNING id`, [tpl, `GBX-ZZ${RUN}`, cli])).rows[0].id);
  await db.query(`INSERT INTO giftbox_instance_items (tenant_id, instance_id, giftbox_item_id, item_type, service_id, qty, sort_order, service_snapshot_json)
    VALUES (25,$1,$2,'service',$3,2,0,$4)`, [inst, tplItem?.id ?? 0, svcId, JSON.stringify({ id: svcId, name: `ZZ GbMutSvc${RUN}`, price: 60 })]);
  // === N1: edit template NON retroattivo ===
  r = await api({ action: "save", id: String(tpl), name: `ZZ GbMut${RUN} V2`, eligibility: "all_clients", active: "1", items_json: JSON.stringify([{ item_type: "service", service_id: svcId, qty: 5 }]) });
  const instItems = (await db.query("SELECT qty, service_snapshot_json FROM giftbox_instance_items WHERE tenant_id=25 AND instance_id=$1", [inst])).rows;
  check("N1 edit template: istanza NON toccata (qty 2 + snapshot)", r.s === 200 && instItems.length === 1 && Number(instItems[0].qty) === 2 && String(instItems[0].service_snapshot_json ?? "").includes("GbMutSvc"), JSON.stringify(instItems.map((i) => i.qty)));
  // === D1: delete template con istanza emessa -> istanza sopravvive ===
  r = await api({ action: "delete", id: String(tpl) });
  const tplRow = (await db.query("SELECT id, deleted_at FROM giftboxes WHERE tenant_id=25 AND id=$1", [tpl])).rows[0];
  const instRow = (await db.query("SELECT id, status FROM giftbox_instances WHERE tenant_id=25 AND id=$1", [inst])).rows[0];
  check("D1 delete template: SOFT (deleted_at) + istanza intatta", r.s === 200 && !!tplRow && tplRow.deleted_at !== null && !!instRow && instRow.status === "issued", JSON.stringify({ del: !!tplRow?.deleted_at, inst: instRow?.status }));
  const v = await get(`action=view&id=${inst}`);
  check("D2 dettaglio istanza ancora consultabile post-delete (snapshot)", v.s === 200 && JSON.stringify(v.j).includes("GbMutSvc"), "");
  const tl = await get("action=templates");
  check("D3 template sparito dalla lista modelli", !(tl.j.templates ?? []).some((t) => t.id === tpl), `templates=${(tl.j.templates ?? []).length}`);
  // === C1: annullo istanza -> non riscattabile (verbatim) ===
  r = await api({ action: "cancel_instance", instance_id: String(inst) });
  check("C1 annullo istanza ok", r.s === 200 && r.j.ok === true, JSON.stringify(r.j.error));
  r = await api({ action: "redeem_full", instance_id: String(inst) });
  check("C2 riscatto su annullata -> verbatim", r.j.ok === false && r.j.error === "GiftBox annullata: non riscattabile.", JSON.stringify(r.j.error));
  // === L1: voci Log ===
  await new Promise((s) => setTimeout(s, 800));
  const logs = (await db.query("SELECT action FROM activity_logs WHERE tenant_id=25 AND module='giftbox' ORDER BY id DESC LIMIT 6")).rows.map((x) => x.action);
  check("L1 log giftbox: crea+modifica+elimina+annulla presenti", ["crea", "modifica", "elimina", "annulla"].every((a) => logs.includes(a)), JSON.stringify(logs));
} finally {
  if (inst) { await db.query("DELETE FROM giftbox_redemption_items WHERE tenant_id=25 AND redemption_id IN (SELECT id FROM giftbox_redemptions WHERE tenant_id=25 AND instance_id=$1)", [inst]).catch(() => {}); await db.query("DELETE FROM giftbox_redemptions WHERE tenant_id=25 AND instance_id=$1", [inst]).catch(() => {}); await db.query("DELETE FROM giftbox_transactions WHERE tenant_id=25 AND instance_id=$1", [inst]).catch(() => {}); await db.query("DELETE FROM giftbox_instance_items WHERE tenant_id=25 AND instance_id=$1", [inst]); await db.query("DELETE FROM giftbox_instances WHERE tenant_id=25 AND id=$1", [inst]); }
  if (tpl) { await db.query("DELETE FROM giftbox_items WHERE tenant_id=25 AND giftbox_id=$1", [tpl]); await db.query("DELETE FROM giftboxes WHERE tenant_id=25 AND id=$1", [tpl]); }
  if (cli) await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1", [cli]);
  if (svcId) await db.query("DELETE FROM services WHERE tenant_id=25 AND id=$1", [svcId]);
  const left = (await db.query("SELECT (SELECT COUNT(*)::int FROM giftboxes WHERE tenant_id=25 AND name LIKE 'ZZ GbMut%') a, (SELECT COUNT(*)::int FROM giftbox_instances WHERE tenant_id=25 AND code LIKE 'GBX-ZZ%') b, (SELECT COUNT(*)::int FROM clients WHERE tenant_id=25 AND full_name LIKE 'ZZ GbMut%') c, (SELECT COUNT(*)::int FROM services WHERE tenant_id=25 AND name LIKE 'ZZ GbMut%') d")).rows[0];
  console.log("cleanup ZZ residui:", JSON.stringify(left));
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ===`);
  await db.end();
}
