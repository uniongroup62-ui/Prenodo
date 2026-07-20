import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL=(readFileSync(new URL("../.env.local", import.meta.url),"utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m)||[])[1].trim().replace(/^["']|["']$/g,"");
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", SLUG="centroesteticoelite", LOC=21;
const p64=Buffer.from(JSON.stringify({tenantSlug:SLUG,user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["coupons.manage","promotions.manage","pos.manage","appointments.manage"],needsEmailVerification:false,currentLocationId:LOC,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9})).toString("base64url");
const cookie=`beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256",SECRET).update(p64).digest("base64url")}`;
const api=(body)=>fetch(`http://localhost:3000/api/manage/coupons?slug=${SLUG}`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}));
async function conn(){for(let i=0;i<6;i++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();return c;}catch(e){try{await c.end();}catch{}if(i===5)throw e;await new Promise(r=>setTimeout(r,3000));}}}
const db=await conn();
const CODE="ZZEDITAUDIT";
let cid=0, apptId=0;
try{
  // crea buono fisso 20, sede 21
  const c=await api({action:"save",id:0,code:CODE,discount_type:"fixed",discount_value:"20",apply_scope:"all_services_products",coupon_location_ids:"21",valid_from:"",valid_to:""});
  cid=Number((await db.query("SELECT id FROM coupons WHERE tenant_id=25 AND code=$1",[CODE])).rows[0]?.id??0);
  console.log("creato buono",cid,"| ok:",c.j?.ok);
  // MIGLIORIA 2 — MODIFICA: cambia valore a 15 -> audit updated_by/updated_at
  const e1=await api({action:"save",id:cid,code:CODE,discount_type:"fixed",discount_value:"15",apply_scope:"all_services_products",coupon_location_ids:"21",valid_from:"",valid_to:""});
  const arow=(await db.query("SELECT updated_by, updated_at, discount_value FROM coupons WHERE tenant_id=25 AND id=$1",[cid])).rows[0];
  console.log("dopo modifica: valore",arow.discount_value,"| updated_by",arow.updated_by,"(atteso 20) | updated_at set:",!!arow.updated_at);
  console.log("  audit nel record: updatedByLabel",JSON.stringify(e1.j?.coupon?.updatedByLabel),"| updatedAt len",String(e1.j?.coupon?.updatedAt??"").length);
  // MIGLIORIA 1 — AVVISO: seed appuntamento APERTO che usa il buono (notes marker 'Coupon: CODE')
  const nc=Number((await db.query("SELECT COALESCE(MAX(id),0)+1 n FROM clients WHERE tenant_id=25")).rows[0].n);
  await db.query("INSERT INTO clients (tenant_id,id,full_name,email,points,created_at) VALUES (25,$1,'ZZ CpnEdit','zz-ce@test.local',0,NOW())",[nc]);
  apptId=Number((await db.query("SELECT COALESCE(MAX(id),0)+1 n FROM appointments WHERE tenant_id=25")).rows[0].n);
  await db.query("INSERT INTO appointments (tenant_id,id,client_id,starts_at,ends_at,status,location_id,notes) VALUES (25,$1,$2,'2027-12-20 10:00:00','2027-12-20 11:00:00','scheduled',21,$3)",[apptId,nc,`Coupon: ${CODE}`]);
  // modifica di nuovo -> deve tornare l'avviso
  const e2=await api({action:"save",id:cid,code:CODE,discount_type:"fixed",discount_value:"10",apply_scope:"all_services_products",coupon_location_ids:"21",valid_from:"",valid_to:""});
  console.log("dopo modifica CON appt aperto -> warning:",JSON.stringify(e2.j?.warning),"| ok:",e2.j?.ok);
  console.log("VERDETTO: audit persistito + avviso su appt aperto:", Number(arow.updated_by)===20 && !!arow.updated_at && /prenotazion/i.test(e2.j?.warning??""));
  // cleanup appuntamento+cliente
  for(const t of ['appointment_services','appointment_staff','appointment_segments','appointment_locations','reminders']) await db.query('DELETE FROM '+t+' WHERE tenant_id=25 AND appointment_id=$1',[apptId]).catch(()=>{});
  await db.query("DELETE FROM appointments WHERE tenant_id=25 AND id=$1",[apptId]); apptId=0;
  await db.query("DELETE FROM clients WHERE tenant_id=25 AND id=$1",[nc]);
}finally{
  if(apptId){ for(const t of ['appointment_services','appointment_staff','appointment_segments','appointment_locations','reminders']) await db.query('DELETE FROM '+t+' WHERE tenant_id=25 AND appointment_id=$1',[apptId]).catch(()=>{}); await db.query("DELETE FROM appointments WHERE tenant_id=25 AND id=$1",[apptId]); }
  if(cid){ await db.query("DELETE FROM coupon_locations WHERE tenant_id=25 AND coupon_id=$1",[cid]).catch(()=>{}); await db.query("DELETE FROM coupons WHERE tenant_id=25 AND id=$1",[cid]); }
  console.log("CLEANUP: coupon ZZ residui:",(await db.query("SELECT COUNT(*)::int c FROM coupons WHERE tenant_id=25 AND code LIKE 'ZZ%'")).rows[0].c);
  await db.end();
}
