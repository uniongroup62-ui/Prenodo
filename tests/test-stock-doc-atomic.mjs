import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const DBURL=(readFileSync(new URL("../.env.local", import.meta.url),"utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m)||[])[1].trim().replace(/^["']|["']$/g,"");
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
const p64=Buffer.from(JSON.stringify({tenantSlug:"centroesteticoelite",user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["products.manage","stock_moves.manage"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9})).toString("base64url");
const cookie="beautysuite_session_t_centroesteticoelite="+p64+"."+crypto.createHmac("sha256",SECRET).update(p64).digest("base64url");
const api=(body)=>fetch("http://localhost:3000/api/manage/products?slug=centroesteticoelite",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}));
async function conn(){for(let i=0;i<6;i++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();return c;}catch(e){try{await c.end();}catch{}if(i===5)throw e;await new Promise(r=>setTimeout(r,3000));}}}
const db=await conn();
const pA=Number((await db.query("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ StockA',10,5,1) RETURNING id")).rows[0].id);
const pB=Number((await db.query("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ StockB',10,1,1) RETURNING id")).rows[0].id);
await db.query("INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES (25,$1,21,5,1),(25,$2,21,1,1)",[pA,pB]);
const stk=async(p)=>Number((await db.query("SELECT stock FROM product_stocks WHERE tenant_id=25 AND product_id=$1 AND location_id=21",[p])).rows[0].stock);
try{
  console.log("stock iniziale: A="+await stk(pA)+" (5), B="+await stk(pB)+" (1)");
  const r=await api({action:"stock_move_save",type:"scarico",location_id:21,items_json:JSON.stringify([{product_id:pA,qty:3},{product_id:pB,qty:5}])});
  console.log("save multi-scarico (A ok, B eccede) ->",JSON.stringify(r.j?.error??r.j?.ok).slice(0,90));
  const sA=await stk(pA),sB=await stk(pB);
  console.log("DOPO fallimento: A="+sA+" (legacy atteso 5 ROLLBACK) | B="+sB+" (1)");
  const docs=Number((await db.query("SELECT COUNT(*)::int c FROM stock_docs WHERE tenant_id=25 AND created_at > now() - interval '2 minutes'").catch(()=>({rows:[{c:-1}]}))).rows[0].c);
  console.log("documenti stock creati:",docs,"(atteso 0 se atomico)");
  console.log(sA===5 ? "VERDETTO: ATOMICO come legacy (A resta 5)" : "VERDETTO: MUTAZIONE PARZIALE (A="+sA+", bug fedelta') — il legacy fa ROLLBACK");
}finally{
  await db.query("DELETE FROM stock_doc_items WHERE tenant_id=25 AND product_id = ANY($1)",[[pA,pB]]).catch(()=>{});
  await db.query("DELETE FROM stock_docs WHERE tenant_id=25 AND created_at > now() - interval '5 minutes'").catch(()=>{});
  await db.query("DELETE FROM stock_moves WHERE tenant_id=25 AND product_id = ANY($1)",[[pA,pB]]).catch(()=>{});
  await db.query("DELETE FROM product_stocks WHERE tenant_id=25 AND product_id = ANY($1)",[[pA,pB]]);
  await db.query("DELETE FROM products WHERE tenant_id=25 AND id = ANY($1)",[[pA,pB]]);
  console.log("CLEANUP:",(await db.query("SELECT COUNT(*)::int c FROM products WHERE tenant_id=25")).rows[0].c,"prodotti (baseline 0)");
  await db.end();
}
