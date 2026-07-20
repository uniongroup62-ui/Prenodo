import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<6;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.message))){await new Promise(r=>setTimeout(r,2500));continue;}throw e;}}}
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846",SLUG="centroesteticoelite",COOKIE="beautysuite_session_t_centroesteticoelite";
const sign=(s)=>{const p=Buffer.from(JSON.stringify(s),"utf8").toString("base64url");return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`;};
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:["commissions.manage"],needsEmailVerification:false,currentLocationId:0,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const api=(m,b,qs="")=>fetch(`http://localhost:3000/api/manage/commissions?slug=${SLUG}${qs}`,{method:m,headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`},...(b?{body:JSON.stringify(b)}:{})}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const OP="ZZCOMM sede op";
const ROME_NOW=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(Date.now()+120000)).replace("T"," ");
const ROME_DAY=ROME_NOW.slice(0,10);
const mod0=Number((await db("SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=25 AND id=1")).rows[0]?.is_enabled ?? 0);
// Operatore risolto per EMAIL (b541360): utente+staff ZZ con email univoca +
// created_by su quell'utente (created_by=20 andrebbe su luca/22).
const ZZEMAIL="zz-comm-sede@test.local";
const usr=(await db("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (25,'ZZCOMM sede user',$1,'x','staff') RETURNING id",[ZZEMAIL])).rows[0];
const stf=(await db("INSERT INTO staff (tenant_id, full_name, email) VALUES (25,$1,$2) RETURNING id",[OP,ZZEMAIL])).rows[0];
await api("POST",{action:"save_module_settings",enabled:true});
await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[stf.id]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:0,posServicePercent:10,posProductPercent:0,posOtherPercent:0,notes:""}})});
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES (25,$1,TIMESTAMP '2025-01-01 00:00:00',NULL)",[stf.id]);
async function mkSale(loc){
  // Trappola probe (18/07): data CABLATA '2026-07-15' era futura al primo run e
  // oggi cade PRIMA del periodo modulo (aperto a Rome-now dall'enable API) ->
  // gate chiuso. Seed a Rome-now (+2min) e range dashboard dinamico sotto.
  const s=(await db(`INSERT INTO sales (tenant_id,client_id,location_id,sale_date,subtotal,discount,total,status,operator_name,created_by) VALUES (25,9,$1,$4,100,0,100,'done',$2,$3) RETURNING id`,[loc,OP,usr.id,ROME_NOW])).rows[0];
  await db("INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES (25,$1,'service',9,'Svc',1,100,100)",[s.id]);
  return s.id;
}
const s21=await mkSale(21), s51=await mkSale(51);
console.log(`[setup] staff #${stf.id} | vendita Sede1=${s21} Sede2=${s51}`);

const PER="&from="+ROME_DAY+"&to="+ROME_DAY+"&source=pos&staff_id=0";
const gAll=await api("GET",null,PER);
const dash=gAll.dashboard||{};
const idsOf=(d)=>(d.dashboard?.entries||d.entries||[]).map(e=>Number(String(e.sourceReference||"").replace(/[^0-9]/g,""))||0);
check("dashboard ritorna 'locations' (2 sedi)", Array.isArray(dash.locations) && dash.locations.length===2, `locations=${JSON.stringify((dash.locations||[]).map(l=>l.name))}`);
const all=idsOf(gAll);
check("location_id=0 (tutte): entrambe le vendite presenti", all.includes(s21)&&all.includes(s51), `ids=${JSON.stringify(all)}`);
const g21=idsOf(await api("GET",null,PER+"&location_id=21"));
check("location_id=21: SOLO Sede1", g21.includes(s21)&&!g21.includes(s51), `ids=${JSON.stringify(g21)}`);
const g51=idsOf(await api("GET",null,PER+"&location_id=51"));
check("location_id=51: SOLO Sede2", g51.includes(s51)&&!g51.includes(s21), `ids=${JSON.stringify(g51)}`);

// zero-rate auto-disable
await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[stf.id]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:0,posServicePercent:0,posProductPercent:0,posOtherPercent:0,notes:""}})});
const enAfter=Number((await db("SELECT is_enabled FROM staff_commission_settings WHERE tenant_id=25 AND staff_id=$1",[stf.id])).rows[0]?.is_enabled);
check("ZERO-RATE: salvato enabled=true ma tutte le % a 0 -> auto-disabilitato (is_enabled=0)", enAfter===0, `is_enabled=${enAfter}`);

// cleanup
await db("DELETE FROM staff_commission_payments WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
for(const id of [s21,s51]){ await db("DELETE FROM sale_items WHERE sale_id=$1",[id]); await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[id]); }
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff_commission_module_periods WHERE tenant_id=25");
await db("DELETE FROM staff_commission_settings WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff WHERE id=$1 AND tenant_id=25",[stf.id]);
await db("DELETE FROM users WHERE id=$1 AND tenant_id=25",[usr.id]);
await db("UPDATE staff_commission_module_settings SET is_enabled=$1 WHERE tenant_id=25 AND id=1",[mod0]);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
