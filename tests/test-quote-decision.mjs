import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<8;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.message))){await new Promise(r=>setTimeout(r,2500));continue;}throw e;}}}
const one=async(sql,p=[])=>(await db(sql,p)).rows[0];
const sha256=(s)=>crypto.createHash("sha256").update(s).digest("hex");
const SLUG="centroesteticoelite";
const ACC_COOKIE="beautysuite_customer_session";
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? r?.err ?? "");
const T=25, C=9;
const EMAIL="zzquotetest@example.com";
let token="", accId=0;
const trk={quote:[]};

// account POST helper (sessione cliente forgiata)
const acc=(body)=>fetch(`http://localhost:3000/api/account`,{method:"POST",headers:{"content-type":"application/json",cookie:`${ACC_COOKIE}=${token}`},body:JSON.stringify(body)}).then(r=>r.json());

async function mkQuote(number, email, status, validUntil){
  // client-less (client_id NULL): il match my_quotes per email richiede client_id IS NULL,
  // e l'ownership della decisione usa comunque il match email. Stato naturale del preventivo
  // per un prospect senza scheda cliente.
  const id=(await one(`INSERT INTO quotes (tenant_id,number,quote_date,valid_until,client_id,client_name,client_email,status,subtotal,discount_total,tax_total,total,notes,location_id,created_by)
    VALUES ($1,$2,CURRENT_DATE,$3,NULL,'ZZ Cliente',$4,$5,100,0,0,100,'ZZtest',21,20) RETURNING id`,[T,number,validUntil,email,status])).id;
  trk.quote.push(id);
  await db(`INSERT INTO quote_items (tenant_id,quote_id,position,item_type,item_id,description,qty,unit_price,tax_rate,discount_percent,line_subtotal,line_tax,line_total) VALUES ($1,$2,0,'custom',NULL,'ZZ riga',1,100,0,0,100,0,100)`,[T,id]);
  return id;
}

let accBase=0;
try {
  // === SETUP: account + sessione forgiata ===
  // Snapshot RELATIVO (healing 2026-07-16): public_customer_accounts e' un
  // registro GLOBALE — i conteggi assoluti (era ===9) derivano da account che
  // possono sparire legittimamente tra i run.
  accBase=Number((await one(`SELECT COUNT(*) c FROM public_customer_accounts`)).c);
  accId=Number((await one(`INSERT INTO public_customer_accounts (email,email_verified_at,created_at,updated_at) VALUES ($1,NOW(),NOW(),NOW()) RETURNING id`,[EMAIL])).id);
  token=crypto.randomBytes(32).toString("hex");
  await db(`INSERT INTO public_customer_sessions (account_id,token_hash,created_at,last_seen_at,expires_at) VALUES ($1,$2,NOW(),NOW(),NOW()+interval '1 day')`,[accId,sha256(token)]);

  // preventivi: owned(accept), owned(reject), scaduto, non-owned
  const Qacc=await mkQuote("ZZ-QD-ACC", EMAIL, "sent", "2030-12-31");
  const Qrej=await mkQuote("ZZ-QD-REJ", EMAIL, "sent", "2030-12-31");
  const Qexp=await mkQuote("ZZ-QD-EXP", EMAIL, "sent", "2020-01-01");
  const Qoth=await mkQuote("ZZ-QD-OTH", "zzother@example.com", "sent", "2030-12-31");

  // === QD1: my_quotes lista i preventivi owned con canRespond ===
  const myq=await acc({action:"quotes", tenant:SLUG, tenantName:"Centro"});
  const listed=(myq.quotes||[]).filter(x=>[Qacc,Qrej].includes(Number(x.id)));
  check("QD1 my_quotes elenca i preventivi 'sent' owned con canRespond=true", listed.length===2 && listed.every(x=>x.canRespond===true), `trovati=${listed.length} ${JSON.stringify(listed.map(x=>({id:x.id,cr:x.canRespond})))}`);

  // === QD2: ACCETTA ===
  const a=await acc({action:"quote_decision", tenant_slug:SLUG, tenant:SLUG, quote_id:String(Qacc), decision:"accept"});
  const accRow=await one(`SELECT status,customer_decision_at,customer_decision_source FROM quotes WHERE id=$1`,[Qacc]);
  check("QD2 accetta -> status accepted + customer_decision_at + source booking", !errOf(a) && accRow.status==="accepted" && !!accRow.customer_decision_at && accRow.customer_decision_source==="booking", errOf(a)||JSON.stringify(accRow));

  // === QD3: già risposto ===
  const a3=await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qacc), decision:"accept"});
  check("QD3 ri-accetta -> 'Hai gia risposto a questo preventivo'", /gi.? risposto/i.test(errOf(a3)), errOf(a3));

  // === QD4: RIFIUTA (altro preventivo) ===
  const a4=await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qrej), decision:"reject"});
  const rejRow=await one(`SELECT status,customer_decision_source FROM quotes WHERE id=$1`,[Qrej]);
  check("QD4 rifiuta -> status rejected + source booking", !errOf(a4) && rejRow.status==="rejected" && rejRow.customer_decision_source==="booking", errOf(a4)||JSON.stringify(rejRow));

  // === QD5: scaduto ===
  const a5=await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qexp), decision:"accept"});
  const expRow=await one(`SELECT status FROM quotes WHERE id=$1`,[Qexp]);
  check("QD5 preventivo scaduto -> 'Preventivo scaduto' + status forzato expired", /Preventivo scaduto/.test(errOf(a5)) && expRow.status==="expired", `err=${errOf(a5)} status=${expRow.status}`);

  // === QD6: non autorizzato (email diversa, nessun link) ===
  const a6=await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qoth), decision:"accept"});
  check("QD6 preventivo non-owned -> 'Non autorizzato'", /Non autorizzato/.test(errOf(a6)), errOf(a6));

  // === QD7/QD8: validazioni input ===
  check("QD7 quote_id<=0 -> 'Preventivo non valido'", /Preventivo non valido/.test(errOf(await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:"0", decision:"accept"}))));
  check("QD8 decision non valida -> 'Azione non valida'", /Azione non valida/.test(errOf(await acc({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qoth), decision:"xxx"}))));

  // === QD9: senza sessione -> 'Accesso cliente richiesto' ===
  const noSess=await fetch(`http://localhost:3000/api/account`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"quote_decision", tenant_slug:SLUG, quote_id:String(Qoth), decision:"accept"})}).then(r=>r.json());
  check("QD9 senza sessione -> 401 'Accesso cliente richiesto'", /Accesso cliente richiesto/.test(errOf(noSess)), errOf(noSess));

} finally {
  for(const id of trk.quote){ await db(`DELETE FROM quote_items WHERE quote_id=$1`,[id]).catch(()=>{}); await db(`DELETE FROM quotes WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  if(accId>0){ await db(`DELETE FROM public_customer_sessions WHERE account_id=$1`,[accId]).catch(()=>{}); await db(`DELETE FROM public_customer_tenant_links WHERE account_id=$1`,[accId]).catch(()=>{}); await db(`DELETE FROM public_customer_accounts WHERE id=$1`,[accId]).catch(()=>{}); }
  // safety net
  await db(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE tenant_id=$1 AND (number LIKE 'ZZ-QD%' OR notes LIKE '%ZZtest%'))`,[T]).catch(()=>{});
  await db(`DELETE FROM quotes WHERE tenant_id=$1 AND (number LIKE 'ZZ-QD%' OR notes LIKE '%ZZtest%')`,[T]).catch(()=>{});
  await db(`DELETE FROM public_customer_sessions WHERE account_id IN (SELECT id FROM public_customer_accounts WHERE email LIKE 'zzquotetest%')`).catch(()=>{});
  await db(`DELETE FROM public_customer_accounts WHERE email LIKE 'zzquotetest%'`).catch(()=>{});
  const residQ=Number((await one(`SELECT COUNT(*) c FROM quotes WHERE tenant_id=$1 AND (number LIKE 'ZZ-QD%' OR notes LIKE '%ZZtest%')`,[T])).c);
  const residA=Number((await one(`SELECT COUNT(*) c FROM public_customer_accounts WHERE email LIKE 'zzquotetest%'`)).c);
  const accTot=Number((await one(`SELECT COUNT(*) c FROM public_customer_accounts`)).c);
  const realCli=Number((await one(`SELECT COUNT(*) c FROM clients WHERE tenant_id=$1`,[T])).c);
  check("CLEANUP: 0 residui (quotes+account) + account tornati al baseline + 5 clienti reali intatti", residQ===0 && residA===0 && accTot===accBase && realCli===5, `residQ=${residQ} residA=${residA} accTot=${accTot}/base=${accBase} realCli=${realCli}`);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
  process.exit(R.every(Boolean)?0:1);
}
