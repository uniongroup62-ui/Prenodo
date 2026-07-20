import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL=(readFileSync(new URL("../.env.local", import.meta.url),"utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m)||[])[1].trim().replace(/^["']|["']$/g,"");
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64=Buffer.from(JSON.stringify({tenantSlug:"centroesteticoelite",user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["suppliers.manage","products.manage","costs.manage"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9})).toString("base64url");
const cookie="beautysuite_session_t_centroesteticoelite="+p64+"."+crypto.createHmac("sha256",SECRET).update(p64).digest("base64url");
const api=(body)=>fetch("http://localhost:3000/api/manage/products?slug=centroesteticoelite",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}));
async function conn(){for(let i=0;i<6;i++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();return c;}catch(e){try{await c.end();}catch{}if(i===5)throw e;await new Promise(r=>setTimeout(r,3000));}}}
const db=await conn();
let supId=0, costId=0;
try{
  // crea fornitore ZZ (sede 21 per magazzino+costi)
  const c1=await api({action:"supplier_save",name:"ZZ CaseProbe",warehouse_location_ids:"21",cost_location_ids:"21",is_active:"1",is_active_costs:"1"});
  supId=Number((await db.query("SELECT id FROM suppliers WHERE tenant_id=25 AND name='ZZ CaseProbe'")).rows[0]?.id??0);
  console.log("creato fornitore",supId,"| ok:",c1.j?.ok!==false);
  // 1) UNIVOCITA' CASE-INSENSITIVE (fix b11e34d): 'zz caseprobe' MAIUSC/minusc diverso -> deve rifiutare
  const dup=await api({action:"supplier_save",name:"zz CASEPROBE",warehouse_location_ids:"21",cost_location_ids:"21",is_active:"1",is_active_costs:"1"});
  console.log("dup case-variant ->",JSON.stringify(dup.j?.error??dup.j?.ok),"(atteso 'Esiste gia un fornitore...')");
  // 2) BLOCKER VIA COSTI: costo collegato per supplier_id -> delete bloccata
  costId=Number((await db.query("INSERT INTO costs (tenant_id,title,amount,due_date,is_paid,supplier_id,location_id,created_at) VALUES (25,'ZZ Costo forn',10,CURRENT_DATE,0,$1,21,NOW()) RETURNING id",[supId])).rows[0].id);
  const delBlocked=await api({action:"supplier_delete",id:supId});
  console.log("delete con COSTO collegato ->",JSON.stringify(delBlocked.j?.error??delBlocked.j?.ok),"(atteso blocker verbatim)");
  // rimuovi il costo -> delete ok
  await db.query("DELETE FROM costs WHERE tenant_id=25 AND id=$1",[costId]); costId=0;
  const delOk=await api({action:"supplier_delete",id:supId});
  const gone=Number((await db.query("SELECT COUNT(*)::int c FROM suppliers WHERE tenant_id=25 AND id=$1",[supId])).rows[0].c)===0;
  console.log("delete dopo rimozione costo ->",delOk.j?.ok!==false?"ok":delOk.j?.error,"| fornitore rimosso:",gone);
  if(gone) supId=0;
  console.log("VERDETTO: case-insensitive + blocker costi corretti:",/Esiste gia/.test(dup.j?.error??"")&&/usato in prodotti o costi/.test(delBlocked.j?.error??"")&&gone);
}finally{
  if(costId) await db.query("DELETE FROM costs WHERE tenant_id=25 AND id=$1",[costId]).catch(()=>{});
  if(supId){ await db.query("DELETE FROM supplier_locations WHERE tenant_id=25 AND supplier_id=$1",[supId]).catch(()=>{}); await db.query("DELETE FROM suppliers WHERE tenant_id=25 AND id=$1",[supId]); }
  console.log("CLEANUP: fornitori ZZ residui:",(await db.query("SELECT COUNT(*)::int c FROM suppliers WHERE tenant_id=25 AND name ILIKE 'ZZ %'")).rows[0].c);
  await db.end();
}
