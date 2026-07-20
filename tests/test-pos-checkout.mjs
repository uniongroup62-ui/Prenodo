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
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["pos.manage","pos.movements","pos.preorders","pos.prepaids","pos.history","pos.settings"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const HDR={"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`};
const BASE="http://localhost:3000/api/manage/pos?slug="+SLUG;
const CLIENT=9, SVC=9, PRICE=12;
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const money=(v)=>Number(Number(v).toFixed(2));
async function checkout(body){const r=await fetch(BASE,{method:"POST",headers:HDR,body:JSON.stringify({action:"checkout",installment_choice:"single",...body})});return r.json();}
async function saleRow(id){return (await db("SELECT id, client_id, subtotal, discount, total, status, notes FROM sales WHERE id=$1 AND tenant_id=25",[id])).rows[0]||null;}
async function saleItems(id){return (await db("SELECT item_type, item_id, item_name, qty, unit_price, line_total FROM sale_items WHERE sale_id=$1 ORDER BY id",[id])).rows;}
async function apiCancel(id){return fetch(BASE,{method:"POST",headers:HDR,body:JSON.stringify({action:"cancel",reason:"ZZ storno checkout",id})}).then(r=>r.json());}
async function apiDelete(id){return fetch(BASE,{method:"POST",headers:HDR,body:JSON.stringify({action:"delete_sale",id})}).then(r=>r.json());}
async function sqlSweep(id){if(!id)return;for(const t of["sale_items","promotion_redemptions","installments","installment_plans","commissions"])await db(`DELETE FROM ${t} WHERE sale_id=$1`,[id]).catch(()=>{});await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[id]).catch(()=>{});}

const created=[];
// T1: vendita cash servizio 9 (12€)
{ const j=await checkout({client_id:CLIENT,items_json:JSON.stringify([{type:"service",refId:SVC,quantity:1,unitPrice:PRICE}]),payments_json:JSON.stringify([{method:"cash",amount:PRICE}])});
  const id=Number(j?.sale?.id ?? 0); if(id)created.push(id);
  const s=await saleRow(id); const it=await saleItems(id);
  check("T1 checkout cash: vendita creata + totale 12", !!s && money(s.total)===12 && money(s.subtotal)===12 && money(s.discount)===0, `id=${id} tot=${s?.total} sub=${s?.subtotal} disc=${s?.discount} err=${j.error||""}`);
  check("T1: 1 riga servizio corretta (id 9, prezzo 12)", it.length===1 && it[0].item_type==="service" && Number(it[0].item_id)===9 && money(it[0].line_total)===12, `items=${JSON.stringify(it)}`);
  check("T1: cliente collegato", !!s && Number(s.client_id)===CLIENT, `client=${s?.client_id}`);
}
// T2: vendita con sconto manuale 3€
{ const j=await checkout({client_id:CLIENT,discount:3,items_json:JSON.stringify([{type:"service",refId:SVC,quantity:1,unitPrice:PRICE}]),payments_json:JSON.stringify([{method:"cash",amount:9}])});
  const id=Number(j?.sale?.id ?? 0); if(id)created.push(id);
  const s=await saleRow(id);
  check("T2 sconto manuale 3€: subtotale 12, sconto 3, totale 9", !!s && money(s.subtotal)===12 && money(s.discount)===3 && money(s.total)===9, `sub=${s?.subtotal} disc=${s?.discount} tot=${s?.total} err=${j.error||""}`);
  check("T2: nota vendita contiene 'Sconto'", !!s && /Sconto/i.test(String(s.notes||"")), `notes="${(s?.notes||"").slice(0,120)}"`);
}
// T3: annulla + elimina (flusso cancel/delete) sulla T1
{ const id=created[0];
  const jc=await apiCancel(id);
  const sc=await saleRow(id);
  check("T3 annulla: status -> cancelled", jc.ok!==false && sc && /cancel/i.test(String(sc.status)), `ok=${jc.ok} status=${sc?.status} err=${jc.error||""}`);
  const jd=await apiDelete(id);
  const sd=await saleRow(id);
  check("T3 elimina vendita annullata -> rimossa", (jd.ok!==false || jd.deleted) && !sd, `deleted=${jd.deleted} err=${jd.error||""} exists=${!!sd}`);
  if(!sd) created.splice(created.indexOf(id),1);
}
// carrello vuoto -> errore
{ const j=await checkout({client_id:CLIENT,items_json:JSON.stringify([]),payments_json:JSON.stringify([])});
  check("Carrello vuoto -> errore 'Carrello vuoto.'", j.error && /Carrello vuoto|Aggiungi almeno/i.test(j.error), `err="${j.error||""}"`);
}

// cleanup
for(const id of created){ await apiCancel(id).catch(()=>{}); await apiDelete(id).catch(()=>{}); await sqlSweep(id); }
const resid=(await db("SELECT COUNT(*)::int c FROM sales WHERE id = ANY($1::int[])",[created.length?created:[0]])).rows[0].c;
console.log(`\nCLEANUP vendite residue: ${resid} (create: ${JSON.stringify(created)})`);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
