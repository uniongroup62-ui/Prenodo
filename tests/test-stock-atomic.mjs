import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<5;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.message))){await new Promise(r=>setTimeout(r,1200));continue;}throw e;}}}
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846",SLUG="centroesteticoelite",COOKIE="beautysuite_session_t_centroesteticoelite";
const sign=(s)=>{const p=Buffer.from(JSON.stringify(s),"utf8").toString("base64url");return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`;};
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["pos.manage","pos.movements"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const post=(b)=>fetch("http://localhost:3000/api/manage/pos?slug="+SLUG,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`},body:JSON.stringify(b)}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const LOC=21;
// Il tenant 25 non ha prodotti fissi (product 15 dell'old dataset non esiste
// piu'): semino un prodotto ZZ dedicato con prezzo listino 15 (il checkout
// prezza dal listino) e stock 1, e lo elimino nel cleanup.
const PID=Number((await db("INSERT INTO products (tenant_id,name,price,stock,is_active) VALUES (25,'ZZ Stock Atomic',15,1,1) RETURNING id")).rows[0].id);
await db("INSERT INTO product_stocks (tenant_id,product_id,location_id,stock,is_enabled) VALUES (25,$1,$2,1,1)",[PID,LOC]);
const psStock=async()=>Number((await db("SELECT stock FROM product_stocks WHERE product_id=$1 AND location_id=$2",[PID,LOC])).rows[0]?.stock ?? 0);

const s0=1, p0=1; // seed noti
console.log(`[snap] prodotto ZZ #${PID} product_stocks=${await psStock()} (stock 1)`);

const sale=()=>post({action:"checkout",installment_choice:"single",client_id:9,location_id:LOC,items_json:JSON.stringify([{type:"product",refId:PID,quantity:1,unitPrice:15}]),payments_json:JSON.stringify([{method:"cash",amount:15}])});
// DUE checkout PARALLELI sull'ultima unità
const [a,b]=await Promise.all([sale(), sale()]);
const oks=[a,b].filter(x=>x.ok!==false).length;
const fails=[a,b].filter(x=>x.ok===false);
const stockAfter=await psStock();
check("concorrenza: esattamente 1 checkout riesce (no oversell)", oks===1, `okA=${a.ok} okB=${b.ok}`);
check("l'altro fallisce per giacenza insufficiente", fails.length===1 && /insufficiente/i.test(fails[0]?.error||""), `err="${(fails[0]?.error||"").slice(0,70)}"`);
check("stock finale = 0 (mai negativo)", Math.abs(stockAfter-0)<0.001, `stock=${stockAfter}`);

// cleanup: elimina TUTTE le vendite create nel test per il prodotto 15 (incluso eventuale orfano del perdente)
const saleIds=[a?.sale?.id, b?.sale?.id].filter(Boolean);
const orphans=(await db("SELECT DISTINCT s.id FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE si.item_id=$1 AND s.tenant_id=25 AND s.sale_date > now() - interval '5 minutes'",[PID])).rows.map(r=>r.id);
for(const sid of new Set([...saleIds,...orphans])){ await post({action:"cancel",id:sid,reason:"cleanup"}).catch(()=>{}); await post({action:"delete_sale",id:sid}).catch(()=>{}); await db("DELETE FROM sale_items WHERE sale_id=$1",[sid]).catch(()=>{}); await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[sid]).catch(()=>{}); }
// nessun orfano prodotto ZZ prima di eliminarlo
const noOrphan=(await db("SELECT COUNT(*) c FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE si.item_id=$1 AND s.sale_date > now() - interval '5 minutes'",[PID])).rows[0].c==='0';
// elimina il prodotto ZZ + la sua riga di stock
await db("DELETE FROM product_stocks WHERE product_id=$1",[PID]).catch(()=>{});
await db("DELETE FROM products WHERE id=$1 AND tenant_id=25",[PID]).catch(()=>{});
check("cleanup: prodotto ZZ rimosso + nessuna vendita orfana", noOrphan && Number((await db("SELECT COUNT(*)::int c FROM products WHERE id=$1",[PID])).rows[0].c)===0, `noOrphan=${noOrphan}`);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
