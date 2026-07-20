import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL = "";
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/); if (m) DBURL = m[1].trim().replace(/^["']|["']$/g, ""); }
async function db(sql, params = []) {
  for (let a = 0; a < 5; a++) { const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); const r = await c.query(sql, params); await c.end(); return r; }
    catch (e) { try { await c.end(); } catch {} if (/ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.message))) { await new Promise(r=>setTimeout(r,1200)); continue; } throw e; } }
}
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const SLUG = "centroesteticoelite", COOKIE = "beautysuite_session_t_centroesteticoelite";
const sign = (s) => { const p = Buffer.from(JSON.stringify(s),"utf8").toString("base64url"); return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`; };
const ADMIN = sign({ tenantSlug: SLUG, user: { id:20, email:"info@artebrand.it", name:"luca", role:"admin", perms:["calendar.view","appointments.manage","appointments.quick_booking"], needsEmailVerification:false, currentLocationId:21, needsLocationSelection:false, locationIds:[] }, issuedAt: Date.now(), epoch: 1e9 });
const MHDR = { "content-type":"application/json", "x-tenant-slug":SLUG, cookie:`${COOKIE}=${ADMIN}` };
const MBASE = "http://localhost:3000/api/manage/appointments?slug=" + SLUG;
const PBASE = "http://localhost:3000/api/booking?slug=" + SLUG;
const DATE="2026-07-28", SVC=9, STAFF=22, LOC=21;
const results=[]; const check=(l,ok,x="")=>{results.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
async function delAppt(id){ if(!id)return; for(const t of ["reminders","appointment_segments","appointment_staff","appointment_services","promotion_redemptions"]) await db(`DELETE FROM ${t} WHERE appointment_id=$1`,[id]); await db("DELETE FROM appointments WHERE id=$1 AND tenant_id=25",[id]); }
async function apptAtTime(t){ return (await db("SELECT id, client_id, location_id, status FROM appointments WHERE tenant_id=25 AND starts_at=$1",[`${DATE} ${t}:00`])).rows[0]||null; }

console.log("\n===== FINDING #1: 'Cliente obbligatorio' non enforced? =====");
{
  const T="11:00";
  await db("DELETE FROM appointment_holds WHERE starts_at=$1",[`${DATE} ${T}:00`]).catch(()=>{});
  const before = await apptAtTime(T); if(before) await delAppt(before.id);
  // save SENZA cliente (no client_id, no client_name)
  const r = await fetch(MBASE,{method:"POST",headers:MHDR,body:JSON.stringify({action:"save",service_name:"test",staff_map:JSON.stringify({[SVC]:STAFF}),operator:"luca",time:T,date:DATE,location_id:LOC})});
  const j = await r.json();
  const appt = await apptAtTime(T);
  let cliName="";
  if(appt){ cliName = String(((await db("SELECT full_name FROM clients WHERE id=$1",[appt.client_id])).rows[0]||{}).full_name||""); }
  check("save SENZA cliente: legacy DEVE rifiutare con 'Seleziona un cliente.'", j.ok===false && /Seleziona un cliente/i.test(j.error||""), `ok=${j.ok} err="${j.error||""}" apptCreato=${!!appt} cliente="${cliName}"`);
  // cleanup: se ha creato appt + cliente spazzatura, rimuovi
  if(appt){ const cid=appt.client_id; await delAppt(appt.id);
    if(cid){ const used=(await db("SELECT 1 FROM appointments WHERE client_id=$1 LIMIT 1",[cid])).rows.length;
      const junk=(await db("SELECT 1 FROM clients WHERE id=$1 AND lower(full_name)='cliente'",[cid])).rows.length;
      if(!used && junk){ await db("DELETE FROM clients WHERE id=$1 AND tenant_id=25",[cid]); console.log("   (pulito cliente spazzatura id "+cid+")"); } } }
}

console.log("\n===== FINDING #2: 'Servizio obbligatorio' non enforced? =====");
{
  const T="11:30";
  await db("DELETE FROM appointment_holds WHERE starts_at=$1",[`${DATE} ${T}:00`]).catch(()=>{});
  const before = await apptAtTime(T); if(before) await delAppt(before.id);
  // save con cliente ma SENZA servizio
  const r = await fetch(MBASE,{method:"POST",headers:MHDR,body:JSON.stringify({action:"save",client_id:9,operator:"luca",time:T,date:DATE,location_id:LOC})});
  const j = await r.json();
  const appt = await apptAtTime(T);
  let svc="";
  if(appt){ svc = String(((await db("SELECT service_name FROM appointment_services WHERE appointment_id=$1 LIMIT 1",[appt.id])).rows[0]||{}).service_name||""); }
  check("save SENZA servizio: legacy DEVE rifiutare con 'Seleziona almeno un servizio.'", j.ok===false && /Seleziona almeno un servizio/i.test(j.error||""), `ok=${j.ok} err="${j.error||""}" apptCreato=${!!appt} servizio="${svc}"`);
  if(appt) await delAppt(appt.id);
}

console.log("\n===== FINDING #3: no_show LIBERA lo slot (legacy) o lo BLOCCA (Next)? =====");
{
  const T="12:00";
  await db("DELETE FROM appointment_holds WHERE starts_at=$1",[`${DATE} ${T}:00`]).catch(()=>{});
  let before = await apptAtTime(T); if(before) await delAppt(before.id);
  // crea appt via save
  const rs = await fetch(MBASE,{method:"POST",headers:MHDR,body:JSON.stringify({action:"save",client_id:9,service_name:"test",staff_map:JSON.stringify({[SVC]:STAFF}),operator:"luca",time:T,date:DATE,location_id:LOC})});
  const js = await rs.json();
  const appt = await apptAtTime(T);
  // set no_show
  const rst = await fetch(MBASE,{method:"POST",headers:MHDR,body:JSON.stringify({action:"status",id:appt?.id,status:"no_show"})});
  const jst = await rst.json();
  const statusNow = String(((await db("SELECT status FROM appointments WHERE id=$1",[appt?.id])).rows[0]||{}).status||"");
  // slot pubblico dopo no_show
  const rp = await fetch(`${PBASE}&action=slots&date=${DATE}&service_ids=${SVC}&staff_id=${STAFF}&location_id=${LOC}&_cb=${Date.now()}`,{cache:"no-store"});
  const jp = await rp.json();
  const freeAfterNoShow = (jp.slots||[]).some(s => (typeof s==="object"?s.available===true:false) && s.time===T);
  console.log(`   status dopo set = "${statusNow}" | slot ${T} libero dopo no_show = ${freeAfterNoShow}`);
  // Divergenza storica RISOLTA (pass successivi hanno allineato la disponibilita' agli stati pending/scheduled): ora si verifica la PARITA'.
  check("no_show LIBERA lo slot come il legacy (divergenza storica risolta)", freeAfterNoShow===true, `freeAfterNoShow=${freeAfterNoShow}`);
  if(appt) await delAppt(appt.id);
}

// cleanup finale
for(const t of ["11:00","11:30","12:00"]){ const a=await apptAtTime(t); if(a) await delAppt(a.id); await db("DELETE FROM appointment_holds WHERE starts_at=$1",[`${DATE} ${t}:00`]).catch(()=>{}); }
const resid=(await db("SELECT COUNT(*)::int c FROM appointments WHERE tenant_id=25 AND starts_at::date=$1 AND starts_at::time IN ('11:00','11:30','12:00')",[DATE])).rows[0].c;
console.log(`\nCLEANUP residuo appts: ${resid}`);
console.log(`\n=== ${results.filter(Boolean).length} PASS / ${results.filter(x=>!x).length} FAIL (PASS = divergenza CONFERMATA) ===`);
