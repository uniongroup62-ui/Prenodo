import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<8;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET|EMAXCONN|max clients/i.test(String(e.message))){await new Promise(r=>setTimeout(r,4000));continue;}throw e;}}}
const one=async(sql,p=[])=>(await db(sql,p)).rows[0];
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846",SLUG="centroesteticoelite",COOKIE="beautysuite_session_t_centroesteticoelite";
const sign=(s)=>{const p=Buffer.from(JSON.stringify(s),"utf8").toString("base64url");return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`;};
const mk=(loc,perms,role="admin",locIds=[])=>sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role,perms,needsEmailVerification:false,currentLocationId:loc,needsLocationSelection:false,locationIds:locIds},issuedAt:Date.now(),epoch:1e9});
const FULL=["resources.manage","cabins.manage","staff.manage","staff_availability.manage","hours.manage","settings.location"];
const post=(body,sess)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`},body:JSON.stringify(body)}).then(r=>r.json());
const get=(qs,sess)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`}}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? "");
const T=25, L1=21;
const day=(n)=>one(`SELECT to_char(CURRENT_DATE + $1::int,'YYYY-MM-DD') d`,[n]).then(r=>r.d);
const dmy=(iso)=>{const p=iso.split("-");return `${p[2]}/${p[1]}/${p[0]}`;};
const hrow=(dow,opens,closes,opens2="",closes2="",closed=0)=>({dow,opens,closes,opens2,closes2,is_closed:closed});
const OPEN7=(over={})=>[hrow(0,"","", "","",1),hrow(1,"09:00","19:00"),hrow(2,"09:00","19:00"),hrow(3,"09:00","19:00"),hrow(4,"09:00","19:00"),hrow(5,"09:00","19:00"),hrow(6,"09:00","13:00")].map(r=>over[r.dow]?{...r,...over[r.dow]}:r);
const hoursSave=(loc,rows,sess)=>post({action:"hours_save",location_id:String(loc),hours_json:JSON.stringify(rows)},sess);
let L3=0, S3="", SOP21="", SOP3="", SNOPERM="", SNOSET="";
const trk={svc:[],appt:[]};
// Watermark log (17/07: chiusure/straordinari LOGGANO): a fine run si tolgono
// le righe module='orari' create dalla sessione.
const logWatermark=Number((await one(`SELECT COALESCE(MAX(id),0) m FROM activity_logs WHERE tenant_id=$1`,[T]))?.m??0);

async function cleanup(){
  await db(`DELETE FROM activity_logs WHERE tenant_id=$1 AND module='orari' AND id > $2`,[T,logWatermark]).catch(()=>{});
  for(const id of trk.appt) await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,id]).catch(()=>{});
  for(const id of trk.svc) await db(`DELETE FROM services WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`,[T,id]).catch(()=>{});
  if(L3>0){
    await db(`DELETE FROM business_hours WHERE tenant_id=$1 AND location_id=$2`,[T,L3]).catch(()=>{});
    await db(`DELETE FROM closures WHERE tenant_id=$1 AND location_id=$2`,[T,L3]).catch(()=>{});
    await db(`DELETE FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2`,[T,L3]).catch(()=>{});
    await db(`DELETE FROM locations WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`,[T,L3]).catch(()=>{});
  }
}

let snapBH;
try {
  snapBH=(await db(`SELECT id,location_id,dow,opens,closes,opens2,closes2,is_closed FROM business_hours WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
  const base=await one(`SELECT (SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1)::int bh,(SELECT COUNT(*) FROM closures WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM business_hours_exceptions WHERE tenant_id=$1)::int e,(SELECT COUNT(*) FROM locations WHERE tenant_id=$1)::int l,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  console.log("BASELINE:",JSON.stringify(base));
  L3=Number((await one(`INSERT INTO locations (tenant_id,id,name,is_active) VALUES ($1,(SELECT COALESCE(MAX(id),0)+1 FROM locations),'ZZ Sede Orari',1) RETURNING id`,[T])).id);
  S3=mk(L3,FULL); SOP21=mk(L1,["hours.manage"],"staff",[L1]); SOP3=mk(L3,["hours.manage"],"staff",[L3]); SNOPERM=mk(L3,["clients.view"],"staff"); SNOSET=mk(L3,["hours.manage"],"staff",[L3]);
  const svcZ=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZOrariSvc',30,1) RETURNING id`,[T])).id; trk.svc.push(svcZ);
  console.log(`[setup] L3=${L3} svcZ=${svcZ}`);

  // ============ A. GET (fallback globale, per-sede vince, gating) ============
  const a1=await get(`&section=hours`,S3);
  const a1sat=(a1.hours??[]).find(h=>h.dow===6), a1sun=(a1.hours??[]).find(h=>h.dow===0);
  check("A1 sede ZZ fresca -> fallback righe GLOBALI (Dom chiusa, Sab 09-13) + liste vuote",Number(a1.activeLocationId)===L3&&(a1.hours??[]).length===7&&a1sun?.isClosed===true&&a1sat?.opens==="09:00"&&a1sat?.closes==="13:00"&&(a1.closures??[]).length===0&&(a1.exceptions??[]).length===0,JSON.stringify({al:a1.activeLocationId,sab:a1sat}));
  const a2=await get(`&section=hours&location_id=${L1}`,S3);
  const a2fri=(a2.hours??[]).find(h=>h.dow===5);
  check("A2 Sede1: la riga per-sede VINCE sulla globale (Ven 09-16)",a2fri?.opens==="09:00"&&a2fri?.closes==="16:00",JSON.stringify(a2fri));
  check("A3 canSettingsLocation true con permesso, false senza",a1.canSettingsLocation===true&&(await get(`&section=hours`,SNOSET)).canSettingsLocation===false);
  check("A4 senza permesso -> Permesso negato",/Permesso negato/.test(errOf(await get(`&section=hours`,SNOPERM))));
  const a5=await get(`&section=hours&location_id=${L3}`,SOP21);
  check("A5 non-admin con sede FUORI lista -> ripiega sulla sede di sessione (21)",Number(a5.activeLocationId)===L1,JSON.stringify({al:a5.activeLocationId}));
  check("A6 dayLabel Domenica su dow 0",String((a1.hours??[])[0]?.dayLabel)==="Domenica",JSON.stringify((a1.hours??[])[0]));

  // ============ B. hours_save ============
  const b1=await hoursSave("",OPEN7(),S3);
  check("B1 sede mancante -> 'Seleziona una sede.' (guardia Next; il legacy ripiega sulla prima attiva)",errOf(b1)==="Seleziona una sede.",errOf(b1));
  const b2=await hoursSave(L3,OPEN7({1:{opens:"09:00",closes:"13:00",opens2:"14:00",closes2:"19:00"}}),S3);
  const b2db=(await db(`SELECT dow,opens,closes,opens2,closes2,is_closed FROM business_hours WHERE tenant_id=$1 AND location_id=$2 ORDER BY dow`,[T,L3])).rows;
  check("B2 salvataggio 7 giorni con spezzato Lun -> 7 righe per-sede, globali intatte",b2.ok===true&&b2db.length===7&&String(b2db[1].opens2).startsWith("14:00")&&Number(b2db[0].is_closed)===1&&(await one(`SELECT COUNT(*)::int n FROM business_hours WHERE tenant_id=$1 AND location_id IS NULL`,[T])).n===7,JSON.stringify({err:errOf(b2),lun:b2db[1]}));
  const b3=await hoursSave(L3,OPEN7({1:{opens:"10:00",closes:"18:00"}}),S3);
  const b3lun=await one(`SELECT opens,closes,opens2 FROM business_hours WHERE tenant_id=$1 AND location_id=$2 AND dow=1`,[T,L3]);
  const b3n=(await one(`SELECT COUNT(*)::int n FROM business_hours WHERE tenant_id=$1 AND location_id=$2`,[T,L3])).n;
  check("B3 upsert: risalvataggio aggiorna la stessa riga (count 7, spezzato azzerato)",b3.ok===true&&b3n===7&&String(b3lun.opens).startsWith("10:00")&&b3lun.opens2===null,JSON.stringify({lun:b3lun}));
  const b4=await hoursSave(L3,OPEN7({1:{opens:"",closes:""},2:{opens:"10:00",closes:"09:00"},3:{opens:"25:00",closes:"19:00"},4:{opens2:"15:00"},5:{opens:"",closes:"",opens2:"15:00",closes2:"18:00"}}),S3);
  const b4msgs=errOf(b4);
  check("B4 messaggi verbatim per riga (vuoto/ordine/formato/spezzato) con prefisso giorno",b4msgs.startsWith("Orari non validi: ")&&b4msgs.includes("Lunedì: se il giorno non e chiuso devi compilare apertura e chiusura.")&&b4msgs.includes("Martedì: la chiusura deve essere successiva all'apertura.")&&b4msgs.includes("Mercoledì: formato orario non valido.")&&b4msgs.includes("Giovedì: per l'orario spezzato devi compilare sia riapertura sia chiusura 2.")&&b4msgs.includes("Venerdì: per l'orario spezzato devi compilare anche apertura e chiusura."),b4msgs);
  const b5=await hoursSave(L3,OPEN7({2:{opens:"14:00",closes:"19:00",opens2:"13:00",closes2:"20:00"},3:{opens:"09:00",closes:"13:00",opens2:"13:00",closes2:"13:00"}}),S3);
  check("B5 riapertura < chiusura1 e chiusura2 <= riapertura -> errori; riapertura == chiusura1 CONSENTITA",errOf(b5).includes("Martedì: la riapertura deve essere uguale o successiva alla chiusura (prima fascia).")&&errOf(b5).includes("Mercoledì: la chiusura 2 deve essere successiva alla riapertura.")&&!errOf(b5).includes("Mercoledì: la riapertura"),errOf(b5));
  const b6rows=OPEN7();for(const r of b6rows){if(r.dow>0){r.opens="";r.closes="";r.opens2="15:00";}}
  const b6=await hoursSave(L3,b6rows,S3);
  const b6parts=errOf(b6).replace(/^Orari non validi: /,"").split("; ");
  check("B6 oltre 8 errori -> primi 8 con '; ' + suffisso ' ...'",b6parts.length===8&&errOf(b6).endsWith(" ...")&&(await one(`SELECT COUNT(*)::int n FROM business_hours WHERE tenant_id=$1 AND location_id=$2`,[T,L3])).n===7,JSON.stringify({n:b6parts.length}));
  const b7=await hoursSave(L3,OPEN7({6:{opens:"aa:bb",closes:"10:00"}}),S3);
  const b7sab=await one(`SELECT opens FROM business_hours WHERE tenant_id=$1 AND location_id=$2 AND dow=6`,[T,L3]);
  check("B7 semantica PHP (int): 'aa:bb' vale 00:00 e viene SALVATO (niente errore formato)",b7.ok===true&&String(b7sab.opens).startsWith("00:00"),JSON.stringify({sab:b7sab,err:errOf(b7)}));
  const snap21=JSON.stringify((await db(`SELECT dow,opens,closes,is_closed FROM business_hours WHERE tenant_id=$1 AND location_id=$2 ORDER BY dow`,[T,L1])).rows);
  const b8=await hoursSave(L1,OPEN7(),SOP3);
  const b8db=(await db(`SELECT dow,opens,closes,is_closed FROM business_hours WHERE tenant_id=$1 AND location_id=$2 ORDER BY dow`,[T,L1])).rows;
  check("B8 non-admin posta sede FUORI lista (21) -> risolta alla SUA sede (L3), Sede1 INTATTA",b8.ok===true&&JSON.stringify(b8db)===snap21,JSON.stringify({ok:b8.ok}));
  await hoursSave(L3,OPEN7(),S3); // reset L3 allo schema default per i tab successivi

  // ============ C. Chiusure ============
  const c1=await post({action:"closure_save",location_id:String(L3),date_from:"",date_to:"",kind:"Chiusura",note:""},S3);
  check("C1 senza data -> wrap 'Impossibile salvare: ' cap 3 join spazio",errOf(c1)==="Impossibile salvare: Seleziona una data di inizio. Data inizio non valida. Data fine non valida.",errOf(c1));
  const c2=await post({action:"closure_save",location_id:String(L3),date_from:"2026-02-31",kind:"Chiusura",note:""},S3);
  check("C2 data inesistente (31 feb, no roll-over) -> 'Data inizio non valida.'",errOf(c2).includes("Data inizio non valida."),errOf(c2));
  const [d1,d2,d3]=await Promise.all([day(20),day(21),day(22)]);
  const c3=await post({action:"closure_save",location_id:String(L3),date_from:d1,date_to:d3,kind:"Ferie",note:"Ponte"},S3);
  const c3db=(await db(`SELECT date,reason FROM closures WHERE tenant_id=$1 AND location_id=$2 ORDER BY date`,[T,L3])).rows;
  check("C3 range 3 giorni Ferie+nota -> 3 righe reason 'Ferie - Ponte' + 1 gruppo",c3.ok===true&&c3db.length===3&&c3db.every(r=>r.reason==="Ferie - Ponte")&&(c3.closures??[]).length===1&&c3.closures[0].start===d3&&c3.closures[0].end===d1,JSON.stringify({n:c3db.length,g:c3.closures}));
  const c4=await post({action:"closure_save",location_id:String(L3),date_from:await day(30),kind:"Chiusura",note:""},S3);
  check("C4 singolo giorno (Al vuoto) -> 1 riga reason 'Chiusura'",c4.ok===true&&(await one(`SELECT reason FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date=CURRENT_DATE+30`,[T,L3]))?.reason==="Chiusura");
  const c5=await post({action:"closure_save",location_id:String(L3),date_from:await day(41),date_to:await day(40),kind:"Chiusura",note:""},S3);
  check("C5 date invertite -> swap silenzioso (2 righe salvate)",c5.ok===true&&(await one(`SELECT COUNT(*)::int n FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date BETWEEN CURRENT_DATE+40 AND CURRENT_DATE+41`,[T,L3])).n===2);
  const c6=await post({action:"closure_save",location_id:String(L3),date_from:await day(1),date_to:await day(380),kind:"Chiusura",note:""},S3);
  check("C6 oltre 370 giorni -> 'Intervallo troppo lungo. Seleziona un periodo più breve.'",errOf(c6)==="Impossibile salvare: Intervallo troppo lungo. Seleziona un periodo più breve.",errOf(c6));
  const dX=await day(50);
  await post({action:"exception_save",location_id:String(L3),date_from:dX,opens:"10:00",closes:"14:00",note:""},S3);
  const c7=await post({action:"closure_save",location_id:String(L3),date_from:dX,kind:"Chiusura",note:""},S3);
  check("C7 conflitto con straordinario -> messaggio verbatim con data d/m/Y",errOf(c7)===`Impossibile salvare: Impossibile salvare la chiusura: esistono già aperture straordinarie nelle seguenti date: ${dmy(dX)}. Rimuovi prima lo straordinario o modifica le date.`,errOf(c7));
  await post({action:"exception_delete_range",location_id:String(L3),from:dX,to:dX},S3);
  const dY=await day(60);
  const ap=(await one(`INSERT INTO appointments (tenant_id,client_id,service_id,starts_at,ends_at,status,location_id) VALUES ($1,0,$2,(CURRENT_DATE+60)::timestamp + interval '10 hours',(CURRENT_DATE+60)::timestamp + interval '11 hours','pending',$3) RETURNING id`,[T,trk.svc[0],L3])).id; trk.appt.push(ap);
  const c8=await post({action:"closure_save",location_id:String(L3),date_from:dY,kind:"Chiusura",note:""},S3);
  check("C8 conflitto con appuntamento attivo -> messaggio verbatim",errOf(c8)===`Impossibile salvare: Impossibile salvare la chiusura: esistono appuntamenti in sospeso o prenotati nelle seguenti date: ${dmy(dY)}. Sposta o annulla prima gli appuntamenti.`,errOf(c8));
  await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,ap]); trk.appt.pop();
  const c9=await post({action:"closure_save",location_id:String(L3),date_from:d1,kind:"Chiusura",note:"Cambiata"},S3);
  check("C9 upsert su data esistente -> reason aggiornato senza duplicati",c9.ok===true&&(await one(`SELECT reason FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date=$3`,[T,L3,d1]))?.reason==="Chiusura - Cambiata"&&(await one(`SELECT COUNT(*)::int n FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date=$3`,[T,L3,d1])).n===1);
  const c10=await post({action:"closure_delete_range",location_id:String(L3),from:d1,to:d3,reason:"Ferie - Ponte"},S3);
  const c10left=(await db(`SELECT date,reason FROM closures WHERE tenant_id=$1 AND location_id=$2 AND date BETWEEN $3 AND $4`,[T,L3,d1,d3])).rows;
  check("C10 delete_range CON reason -> cancella solo le righe con quel reason esatto",c10.ok===true&&c10left.length===1&&c10left[0].reason==="Chiusura - Cambiata",JSON.stringify({left:c10left}));
  const c11=await post({action:"closure_delete_range",location_id:String(L3),from:d1,to:await day(60),reason:""},S3);
  check("C11 delete_range senza reason -> cancella tutto il range",c11.ok===true&&(await one(`SELECT COUNT(*)::int n FROM closures WHERE tenant_id=$1 AND location_id=$2`,[T,L3])).n===0);

  // ============ D. Straordinari ============
  const e1=await post({action:"exception_save",location_id:String(L3),date_from:await day(70),opens:"",closes:"",note:""},S3);
  check("D1 orari mancanti -> 'Per un'apertura straordinaria devi compilare apertura e chiusura.'",errOf(e1)==="Impossibile salvare: Per un'apertura straordinaria devi compilare apertura e chiusura.",errOf(e1));
  const e2=await post({action:"exception_save",location_id:String(L3),date_from:await day(70),opens:"15:00",closes:"14:00"},S3);
  check("D2 chiusura <= apertura -> messaggio verbatim",errOf(e2)==="Impossibile salvare: La chiusura deve essere successiva all'apertura.",errOf(e2));
  const e3=await post({action:"exception_save",location_id:String(L3),date_from:await day(70),opens:"10:00",closes:"14:00",opens2:"15:00",closes2:""},S3);
  check("D3 spezzato incompleto -> messaggio verbatim",errOf(e3)==="Impossibile salvare: Per l'orario spezzato devi compilare sia riapertura sia chiusura 2.",errOf(e3));
  const e4=await post({action:"exception_save",location_id:String(L3),date_from:await day(70),opens:"10:00",closes:"14:00",opens2:"13:00",closes2:"13:00"},S3);
  check("D4 riapertura<chiusura1 E chiusura2<=riapertura -> 2 errori join spazio",errOf(e4)==="Impossibile salvare: La riapertura deve essere uguale o successiva alla chiusura (prima fascia). La chiusura 2 deve essere successiva alla riapertura.",errOf(e4));
  const [x1,x2]=await Promise.all([day(70),day(71)]);
  const e5=await post({action:"exception_save",location_id:String(L3),date_from:x1,date_to:x2,opens:"08:00",closes:"12:00",opens2:"14:00",closes2:"20:00",note:"Evento"},S3);
  const e5db=(await db(`SELECT date,opens,closes,opens2,closes2,is_closed,note FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2 ORDER BY date`,[T,L3])).rows;
  check("D5 salvataggio range con spezzato+nota -> 2 righe is_closed=0 raggruppate in 1",e5.ok===true&&e5db.length===2&&e5db.every(r=>Number(r.is_closed)===0&&r.note==="Evento")&&(e5.exceptions??[]).length===1&&e5.exceptions[0].opens==="08:00"&&e5.exceptions[0].closes2==="20:00",JSON.stringify({g:e5.exceptions}));
  const dZ=await day(80);
  await post({action:"closure_save",location_id:String(L3),date_from:dZ,kind:"Chiusura",note:""},S3);
  const e6=await post({action:"exception_save",location_id:String(L3),date_from:dZ,opens:"10:00",closes:"12:00"},S3);
  check("D6 conflitto con chiusura -> messaggio verbatim con data d/m/Y",errOf(e6)===`Impossibile salvare: Impossibile salvare lo straordinario: le seguenti date sono impostate come chiuse: ${dmy(dZ)}. Rimuovi prima la chiusura (tab Chiusure) o modifica le date.`,errOf(e6));
  await post({action:"closure_delete_range",location_id:String(L3),from:dZ,to:dZ,reason:""},S3);
  const e7=await post({action:"exception_save",location_id:String(L3),date_from:x1,opens:"09:30",closes:"11:30",note:"Evento2"},S3);
  check("D7 upsert su data esistente -> orari/nota aggiornati senza duplicati",e7.ok===true&&(await one(`SELECT COUNT(*)::int n FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2 AND date=$3`,[T,L3,x1])).n===1&&String((await one(`SELECT opens FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2 AND date=$3`,[T,L3,x1])).opens).startsWith("09:30"));
  const e8=await post({action:"exception_delete_range",location_id:String(L3),from:x1,to:x2},S3);
  check("D8 delete_range straordinari -> righe rimosse",e8.ok===true&&(await one(`SELECT COUNT(*)::int n FROM business_hours_exceptions WHERE tenant_id=$1 AND location_id=$2`,[T,L3])).n===0);
  const e9=await post({action:"exception_save",location_id:String(L3),date_from:await day(1),date_to:await day(380),opens:"10:00",closes:"12:00"},S3);
  check("D9 oltre 370 giorni -> intervallo troppo lungo",errOf(e9)==="Impossibile salvare: Intervallo troppo lungo. Seleziona un periodo più breve.",errOf(e9));
  const e10=await post({action:"hours_save",location_id:String(L3),hours_json:"[]"},SNOPERM);
  check("D10 hours_save senza permesso -> 'Permesso Orari richiesto.'",errOf(e10)==="Permesso Orari richiesto.",errOf(e10));
  const [g1,g3]=await Promise.all([day(90),day(92)]);
  await post({action:"closure_save",location_id:String(L3),date_from:g1,kind:"Chiusura",note:""},S3);
  const g=await post({action:"closure_save",location_id:String(L3),date_from:g3,kind:"Chiusura",note:""},S3);
  check("D11 chiusure NON consecutive stesso reason -> 2 gruppi distinti",(g.closures??[]).length===2,JSON.stringify({g:g.closures}));
  await post({action:"closure_delete_range",location_id:String(L3),from:g1,to:g3,reason:""},S3);
} catch(e){ console.log("ERRORE FATALE:",e.message); R.push(false); }
finally {
  await cleanup();
  const fin=await one(`SELECT (SELECT COUNT(*) FROM business_hours WHERE tenant_id=$1)::int bh,(SELECT COUNT(*) FROM closures WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM business_hours_exceptions WHERE tenant_id=$1)::int e,(SELECT COUNT(*) FROM locations WHERE tenant_id=$1)::int l,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  const finBH=(await db(`SELECT id,location_id,dow,opens,closes,opens2,closes2,is_closed FROM business_hours WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
  check("CLEANUP baseline: business_hours=14 IDENTICHE (globali+Sede1), chiusure/straordinari=0, locations=2, clients=5",fin.bh===14&&fin.c===0&&fin.e===0&&fin.l===2&&fin.cl===5&&JSON.stringify(finBH)===JSON.stringify(snapBH),JSON.stringify(fin));
  console.log(`\nTOTALE: ${R.filter(Boolean).length}/${R.length} PASS${R.every(Boolean)?"":"  <<< FALLIMENTI"}`);
}
