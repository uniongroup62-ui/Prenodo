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
const mkSess=(loc,perms,role="admin")=>sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role,perms,needsEmailVerification:false,currentLocationId:loc,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const PERMS=["resources.manage","cabins.manage","staff.manage","staff_availability.manage","hours.manage"];
const S21=mkSess(21,PERMS), S51=mkSess(51,PERMS), S0=mkSess(0,PERMS), SNOPERM=mkSess(21,["clients.view"],"staff");
const post=(body,sess=S21)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`},body:JSON.stringify(body)}).then(r=>r.json());
const get=(qs,sess=S21)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`}}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? "");
const T=25, L1=21, L2=51, CAB1=9, CAB45=45;
const trk={svc:[],appt:[],seg:[],cab:[]};
const bulk=(loc,rows,sess=S21)=>post({action:"cabins_save",location_id:String(loc??""),cabins_count:String(rows.length),cabin_names_json:JSON.stringify(rows.map(r=>r[1])),cabin_ids_json:JSON.stringify(rows.map(r=>r[0]))},sess);
const cabRow=async(id)=>one(`SELECT id,name,position,is_active,location_id FROM cabins WHERE tenant_id=$1 AND id=$2`,[T,id]);
let NAME9G="";
const cab9ok=async(l)=>{const c=await cabRow(CAB1);check(l,!!c&&c.name===NAME9G&&Number(c.position)===1&&Number(c.is_active)===1&&Number(c.location_id)===L1,JSON.stringify(c));};

async function cleanup(){
  for(const id of trk.seg) await db(`DELETE FROM appointment_segments WHERE tenant_id=$1 AND id=$2`,[T,id]).catch(()=>{});
  for(const id of trk.appt) await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,id]).catch(()=>{});
  await db(`DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id = ANY($2::int[])`,[T,trk.svc.length?trk.svc:[0]]).catch(()=>{});
  for(const id of trk.svc) await db(`DELETE FROM services WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`,[T,id]).catch(()=>{});
  await db(`DELETE FROM cabins WHERE tenant_id=$1 AND name LIKE 'ZZ%'`,[T]).catch(()=>{});
  // Il delete senza sede (C7) rinumera TUTTE le attive (fedele al legacy):
  // ripristino le position di produzione delle 3 cabine reali.
  await db(`UPDATE cabins SET position=1 WHERE tenant_id=$1 AND id IN (9,45)`,[T]).catch(()=>{});
  await db(`UPDATE cabins SET position=50 WHERE tenant_id=$1 AND id=10`,[T]).catch(()=>{});
}

let snap9, snap45, snap10;
try {
  snap9=await cabRow(9); snap45=await cabRow(45); snap10=await cabRow(10);
  const NAME9=String(snap9.name), NAME45=String(snap45.name); NAME9G=NAME9;
  const base=await one(`SELECT (SELECT COUNT(*) FROM cabins WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM service_cabins WHERE tenant_id=$1)::int sc,(SELECT COUNT(*) FROM services WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1)::int sg,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  console.log("BASELINE:",JSON.stringify(base));
  const clientNullable=(await one(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments' AND column_name='client_id'`)).is_nullable==="YES";
  const CLI=clientNullable?null:0;
  const svcZ=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZCabSvc',30,1) RETURNING id`,[T])).id; trk.svc.push(svcZ);
  const staffId=Number((await one(`SELECT id FROM staff WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[T]))?.id||0);
  console.log(`[setup] svcZ=${svcZ} clientNullable=${clientNullable} staffId=${staffId}`);

  // ============ A. GET lista / sede sessione / 'Tutte' ============
  const a1=await get(`&section=cabins`);
  check("A1 GET senza param, sessione sede21 -> activeLocationId=21 e lista=[cabina 9]",Number(a1.activeLocationId)===L1&&(a1.cabins??[]).length===1&&Number(a1.cabins[0].id)===CAB1,JSON.stringify({al:a1.activeLocationId,ids:(a1.cabins??[]).map(c=>c.id)}));
  const a2=await get(`&section=cabins`,S51);
  check("A2 sessione sede51 senza param -> [cabina 45]",Number(a2.activeLocationId)===L2&&(a2.cabins??[]).length===1&&Number(a2.cabins[0].id)===CAB45,JSON.stringify({al:a2.activeLocationId,ids:(a2.cabins??[]).map(c=>c.id)}));
  const a3=await get(`&section=cabins`,S0);
  check("A3 sessione 'Tutte le sedi' (0) -> activeLocationId=0 e lista TUTTE le attive [9,45]",Number(a3.activeLocationId)===0&&(a3.cabins??[]).map(c=>Number(c.id)).join(",")==="9,45",JSON.stringify({al:a3.activeLocationId,ids:(a3.cabins??[]).map(c=>c.id)}));
  const a4=await get(`&section=cabins&location_id=${L2}`);
  check("A4 param location_id=51 vince sulla sessione sede21 -> [45]",Number(a4.activeLocationId)===L2&&(a4.cabins??[]).map(c=>Number(c.id)).join(",")==="45",JSON.stringify({al:a4.activeLocationId}));
  const a5=await get(`&section=cabins&location_id=9999`);
  // FIX 17/07 (pass 2): app_resolve_location_id VALIDA l'esistenza della sede
  // (app_location_allowed_for_user -> app_location_exists): inesistente -> 0
  // = 'Tutte' con la lista completa (la vecchia attesa 'resta 9999' era una
  // lettura sbagliata di cabins.php 356-360).
  check("A5 sede inesistente 9999 -> risolve a 0 'Tutte' (lista completa)",Number(a5.activeLocationId)===0&&(a5.cabins??[]).map(c=>Number(c.id)).join(",")==="9,45",JSON.stringify({al:a5.activeLocationId,n:(a5.cabins??[]).length}));
  const c9=(a1.cabins??[])[0]??{};
  const c9svc=(c9.blockers??[]).filter(b=>!b.block_kind), c9app=(c9.blockers??[]).filter(b=>b.block_kind==="appointment");
  const svcFirst=(c9.blockers??[]).findIndex(b=>b.block_kind==="appointment");
  check("A6 blockers cabina 9: 2 servizi (test,test2) PRIMA + prenotazioni future dopo",c9svc.length===2&&c9svc.map(b=>b.service_name).join(",")==="test,test2"&&c9app.length>=1&&c9app.every(b=>/^Prenotazione /.test(b.service_name))&&(svcFirst===-1||svcFirst>=2),JSON.stringify({svc:c9svc.map(b=>b.service_name),app:c9app.map(b=>b.service_name)}));
  const a7=await get(`&section=cabins`,SNOPERM);
  check("A7 senza permesso cabins.manage -> Permesso negato",/Permesso negato/.test(errOf(a7))&&!a7.cabins,errOf(a7));

  // ============ B. BULK SAVE (#cabinsForm) sede 21 ============
  const b1=await bulk(L1,[[CAB1,NAME9],[0,"ZZ Cab A"],[0,"ZZ Cab B"]]);
  const idA=Number((b1.cabins??[]).find(c=>c.name==="ZZ Cab A")?.id||0), idB=Number((b1.cabins??[]).find(c=>c.name==="ZZ Cab B")?.id||0);
  if(idA)trk.cab.push(idA); if(idB)trk.cab.push(idB);
  const b1a=await cabRow(idA), b1b=await cabRow(idB);
  check("B1 add 2 nuove -> create attive loc21 con position 2,3",b1.ok===true&&idA>0&&idB>0&&Number(b1a.position)===2&&Number(b1b.position)===3&&Number(b1a.location_id)===L1&&Number(b1a.is_active)===1,JSON.stringify({idA,idB,pa:b1a?.position,pb:b1b?.position,err:errOf(b1)}));
  await cab9ok("B1b cabina 9 di produzione intatta (pos1 attiva loc21)");
  const b2=await bulk(L1,[[CAB1,NAME9],[idB,"ZZ Cab B2"],[idA,"ZZ Cab A"]]);
  const b2b=await cabRow(idB), b2a=await cabRow(idA);
  check("B2 rename+swap ordine -> B2 pos2 rinominata, A pos3",b2.ok===true&&b2b.name==="ZZ Cab B2"&&Number(b2b.position)===2&&Number(b2a.position)===3,JSON.stringify({b:b2b,a:b2a}));
  const b3=await bulk(L1,[[CAB1,NAME9],[idB,"ZZ  Cab \t B2"],[idA,"ZZ Cab A"]]);
  check("B3 whitespace multipli collassati a singolo spazio",b3.ok===true&&(await cabRow(idB)).name==="ZZ Cab B2",JSON.stringify(await cabRow(idB)));
  const b4=await bulk(L1,[[CAB1,NAME9],[idB,""],[idA,"ZZ Cab A"]]);
  check("B4 nome vuoto -> 'Inserisci un nome per tutte le cabine.'",errOf(b4)==="Inserisci un nome per tutte le cabine."&&Number((await cabRow(idB)).is_active)===1,errOf(b4));
  const b5=await bulk("",[[CAB1,NAME9],[idB,"ZZ Cab B2"],[idA,"ZZ Cab A"]]);
  check("B5 sede mancante -> 'Seleziona una sede per configurare le cabine.'",errOf(b5)==="Seleziona una sede per configurare le cabine.",errOf(b5));
  const b6=await bulk("",[[CAB1,NAME9],[idB,""],[idA,"ZZ Cab A"]]);
  check("B6 sede mancante + nome vuoto -> vince l'errore nomi (ordine legacy)",errOf(b6)==="Inserisci un nome per tutte le cabine.",errOf(b6));
  const b7=await bulk(L1,[]);
  const b7all=[await cabRow(CAB1),await cabRow(idA),await cabRow(idB)];
  check("B7 count=0 (rimuove tutte incl. 9) -> bloccata, flash senza accento + popup variante prenotazioni",errOf(b7)==="Impostazioni non salvate: una o piu cabine sono associate a servizi o prenotazioni future."&&b7.popup?.message==="La cabina e associata a servizi o prenotazioni future. Rimuovi prima i collegamenti o sposta le prenotazioni e poi riprova."&&(b7.blockingServices??[]).some(x=>x.service_name==="test")&&b7all.every(c=>Number(c.is_active)===1),JSON.stringify({err:errOf(b7),msg:b7.popup?.message}));
  await db(`INSERT INTO service_cabins (tenant_id,service_id,cabin_id) VALUES ($1,$2,$3)`,[T,svcZ,idB]);
  const b8=await bulk(L1,[[CAB1,NAME9],[idA,"ZZ Cab A"]]);
  check("B8 rimozione ZZ B2 con servizio collegato -> bloccata + popup ACCENTATO solo-servizi",errOf(b8)==="Impostazioni non salvate: una o piu cabine sono associate a servizi o prenotazioni future."&&b8.popup?.message==="Una o più cabine che stai rimuovendo sono associate ai servizi elencati. Rimuovi prima la cabina dai servizi collegati e poi riprova."&&(b8.blockingServices??[]).length===1&&b8.blockingServices[0].service_name==="ZZCabSvc"&&Number((await cabRow(idB)).is_active)===1,JSON.stringify({msg:b8.popup?.message,bs:b8.blockingServices}));
  await db(`DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id=$2`,[T,svcZ]);
  const ap1=(await one(`INSERT INTO appointments (tenant_id,client_id,service_id,cabin_id,starts_at,ends_at,status,location_id) VALUES ($1,$2,$3,$4,NOW()+INTERVAL '5 days',NOW()+INTERVAL '5 days 1 hour','scheduled',$5) RETURNING id`,[T,CLI,svcZ,idB,L1])).id; trk.appt.push(ap1);
  const b9=await bulk(L1,[[CAB1,NAME9],[idA,"ZZ Cab A"]]);
  const b9app=(b9.blockingServices??[]).find(x=>x.block_kind==="appointment");
  check("B9 rimozione ZZ B2 con prenotazione futura diretta -> bloccata, voce 'Prenotazione #id' + detail",errOf(b9).startsWith("Impostazioni non salvate")&&!!b9app&&b9app.service_name===`Prenotazione #${ap1}`&&/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/.test(String(b9app.detail))&&/scheduled/.test(String(b9app.detail))&&Number((await cabRow(idB)).is_active)===1,JSON.stringify({app:b9app}));
  await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,ap1]); trk.appt.pop();
  const b10=await bulk(L1,[[CAB1,NAME9],[idB,"ZZ Cab B2"],[idA,"ZZ Cab A"],[CAB45,"ZZ Dup45"]]);
  const dup=await one(`SELECT id,name,location_id FROM cabins WHERE tenant_id=$1 AND name='ZZ Dup45'`,[T]);
  const c45=await cabRow(CAB45);
  check("B10 id di ALTRA sede (45) su sede21 -> INSERT nuova riga, cabina 45 INTATTA su Sede2",b10.ok===true&&!!dup&&Number(dup.id)!==CAB45&&Number(dup.location_id)===L1&&c45.name===NAME45&&Number(c45.location_id)===L2&&Number(c45.is_active)===1&&Number(c45.position)===1,JSON.stringify({dup,c45}));
  if(dup)trk.cab.push(Number(dup.id));
  const nullCab=(await one(`INSERT INTO cabins (tenant_id,name,position,is_active,location_id) VALUES ($1,'ZZ NullLoc',1,1,NULL) RETURNING id`,[T])).id; trk.cab.push(nullCab);
  const b11=await get(`&section=cabins`);
  const b11ids=(b11.cabins??[]).map(c=>Number(c.id));
  check("B11 cabina location NULL: visibile in sede21 ma ordinata ULTIMA (chiave NULL-last) nonostante position 1",b11ids.length===5&&b11ids[b11ids.length-1]===Number(nullCab)&&b11ids[0]===CAB1,JSON.stringify({ids:b11ids}));
  const b12=await bulk(L1,[[CAB1,NAME9],[idB,"ZZ Cab B2"],[idA,"ZZ Cab A"],[Number(dup.id),"ZZ Dup45"],[Number(nullCab),"ZZ NullLoc"]]);
  const nrow=await cabRow(nullCab);
  check("B12 resubmit cabina NULL-loc -> location_id RESTA NULL (stamp solo se esistente >0)",b12.ok===true&&nrow.location_id===null&&Number(nrow.position)===5,JSON.stringify({nrow}));
  await cab9ok("B13 cabina 9 ancora intatta dopo tutti i bulk");

  // ============ C. DELETE singola ============
  const c1=await post({action:"cabin_delete",id:String(dup.id),location_id:String(L1)});
  const c1pos=(await db(`SELECT id,position FROM cabins WHERE tenant_id=$1 AND COALESCE(is_active,1)=1 AND location_id=$2 ORDER BY position,id`,[T,L1])).rows;
  check("C1 delete ZZ Dup45 senza blocchi -> ok msg 'Cabina eliminata' + soft delete + reorder 1..N",c1.ok===true&&c1.msg==="Cabina eliminata"&&Number((await cabRow(dup.id)).is_active)===0&&c1pos.map(r=>Number(r.position)).join(",")===c1pos.map((_,i)=>i+1).join(","),JSON.stringify({msg:c1.msg,pos:c1pos}));
  await db(`INSERT INTO service_cabins (tenant_id,service_id,cabin_id) VALUES ($1,$2,$3)`,[T,svcZ,idB]);
  const c2=await post({action:"cabin_delete",id:String(idB),location_id:String(L1)});
  check("C2 delete con servizio collegato -> 'Cabina non eliminata: e associata...' + popup accentato solo-servizi",errOf(c2)==="Cabina non eliminata: e associata a servizi o prenotazioni future."&&c2.popup?.title==="Impossibile eliminare la cabina"&&c2.popup?.message==="La cabina è associata ai servizi elencati. Rimuovi prima la cabina dai servizi collegati: finché è presente in un servizio non può essere eliminata."&&(c2.popup?.services??[]).length===1&&Number((await cabRow(idB)).is_active)===1,JSON.stringify({err:errOf(c2),msg:c2.popup?.message}));
  await db(`DELETE FROM service_cabins WHERE tenant_id=$1 AND service_id=$2`,[T,svcZ]);
  const ap2=(await one(`INSERT INTO appointments (tenant_id,client_id,service_id,starts_at,ends_at,status,location_id) VALUES ($1,$2,$3,NOW()+INTERVAL '6 days',NOW()+INTERVAL '6 days 1 hour','pending',$4) RETURNING id`,[T,CLI,svcZ,L1])).id; trk.appt.push(ap2);
  const sg1=(await one(`INSERT INTO appointment_segments (tenant_id,id,appointment_id,service_id,service_name,staff_id,position,starts_at,ends_at,duration_minutes,cabin_id) VALUES ($1,(SELECT COALESCE(MAX(id),0)+1 FROM appointment_segments),$2,$3,'ZZCabSvc',$5,1,NOW()+INTERVAL '6 days',NOW()+INTERVAL '6 days 1 hour',60,$4) RETURNING id`,[T,ap2,svcZ,idB,staffId])).id; trk.seg.push(sg1);
  const c3=await post({action:"cabin_delete",id:String(idB),location_id:String(L1)});
  const c3app=(c3.popup?.services??[]).find(x=>x.block_kind==="appointment");
  check("C3 delete con prenotazione via SEGMENTO -> bloccata, popup variante prenotazioni + voce unica",errOf(c3)==="Cabina non eliminata: e associata a servizi o prenotazioni future."&&c3.popup?.message==="La cabina e associata a servizi o prenotazioni future. Rimuovi prima i collegamenti o sposta le prenotazioni e poi riprova."&&(c3.popup?.services??[]).length===1&&c3app?.service_name===`Prenotazione #${ap2}`,JSON.stringify({msg:c3.popup?.message,svcs:c3.popup?.services}));
  await db(`UPDATE appointment_segments SET cabin_id=NULL WHERE tenant_id=$1 AND id=$2`,[T,sg1]);
  await db(`UPDATE services SET cabin_id=$3 WHERE tenant_id=$1 AND id=$2`,[T,svcZ,idB]);
  const c4=await post({action:"cabin_delete",id:String(idB),location_id:String(L1)});
  const c4svcBlock=(c4.popup?.services??[]).some(x=>x.service_name==="ZZCabSvc")&&(c4.popup?.services??[]).some(x=>x.block_kind==="appointment"&&x.service_name===`Prenotazione #${ap2}`);
  check("C4 fallback COALESCE sv.cabin_id: segmento e appuntamento senza cabina, services.cabin_id=B2 -> bloccata (servizio + prenotazione)",errOf(c4)==="Cabina non eliminata: e associata a servizi o prenotazioni future."&&c4svcBlock,JSON.stringify({svcs:c4.popup?.services}));
  await db(`UPDATE services SET cabin_id=NULL WHERE tenant_id=$1 AND id=$2`,[T,svcZ]);
  await db(`DELETE FROM appointment_segments WHERE tenant_id=$1 AND id=$2`,[T,sg1]); trk.seg.pop();
  await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,ap2]); trk.appt.pop();
  const c5=await post({action:"cabin_delete",id:"999999",location_id:String(L1)});
  check("C5 delete id inesistente -> 'Cabina non trovata'",errOf(c5)==="Cabina non trovata",errOf(c5));
  const s2save=await bulk(L2,[[CAB45,NAME45],[0,"ZZ Cab S2"]],S51);
  const idS2=Number((s2save.cabins??[]).find(c=>c.name==="ZZ Cab S2")?.id||0); if(idS2)trk.cab.push(idS2);
  const c6=await post({action:"cabin_delete",id:String(idS2),location_id:String(L1)});
  const c7=await post({action:"cabin_delete",id:String(idS2),location_id:String(L2)},S51);
  check("C6 scoping sede: delete cabina di Sede2 con location_id=21 -> 'Cabina non trovata'; con 51 -> ok",errOf(c6)==="Cabina non trovata"&&c7.ok===true&&Number((await cabRow(idS2)).is_active)===0,JSON.stringify({c6:errOf(c6),c7ok:c7.ok}));
  const c45b=await cabRow(CAB45);
  check("C6b cabina 45 di produzione intatta (pos1 attiva loc51)",c45b.name===NAME45&&Number(c45b.position)===1&&Number(c45b.is_active)===1&&Number(c45b.location_id)===L2,JSON.stringify(c45b));
  const c8=await post({action:"cabin_delete",id:String(idA),location_id:""});
  check("C7 delete senza sede (0) -> lookup unscoped, eliminata",c8.ok===true&&Number((await cabRow(idA)).is_active)===0,JSON.stringify({ok:c8.ok}));

  // ============ D. action=get + cabin_save rimossa ============
  const d1=await get(`&section=cabins&action=get&id=${idB}`);
  check("D1 GET action=get -> prefill cabina per id",d1.ok===true&&d1.cabin?.name==="ZZ Cab B2"&&Number(d1.cabin?.locationId)===L1,JSON.stringify({n:d1.cabin?.name}));
  const d2=await get(`&section=cabins&action=get&id=999999`);
  check("D2 GET action=get id inesistente -> 'Cabina non trovata.'",errOf(d2)==="Cabina non trovata.",errOf(d2));
  const d3=await post({action:"cabin_save",name:"ZZ Bypass",location_id:""});
  check("D3 cabin_save (bypass regole sede legacy) RIMOSSA -> 'Azione risorse non valida.'",errOf(d3)==="Azione risorse non valida."&&!(await one(`SELECT id FROM cabins WHERE tenant_id=$1 AND name='ZZ Bypass'`,[T])),errOf(d3));
  const d4=await post({action:"cabins_save",location_id:String(L1),cabins_count:"1",cabin_names_json:JSON.stringify(["x"]),cabin_ids_json:"[]"},SNOPERM);
  check("D4 cabins_save senza permesso -> 'Permesso Cabine richiesto.'",errOf(d4)==="Permesso Cabine richiesto.",errOf(d4));
} catch(e){ console.log("ERRORE FATALE:",e.message); R.push(false); }
finally {
  await cleanup();
  const fin=await one(`SELECT (SELECT COUNT(*) FROM cabins WHERE tenant_id=$1)::int c,(SELECT COUNT(*) FROM service_cabins WHERE tenant_id=$1)::int sc,(SELECT COUNT(*) FROM services WHERE tenant_id=$1)::int s,(SELECT COUNT(*) FROM appointments WHERE tenant_id=$1)::int a,(SELECT COUNT(*) FROM appointment_segments WHERE tenant_id=$1)::int sg,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  const rows=(await db(`SELECT id,name,position,is_active,location_id FROM cabins WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
  const okBase=fin.c===3&&fin.sc===2&&fin.cl===5&&JSON.stringify(rows)===JSON.stringify([{...snap9,position:1},{...snap10},{...snap45,position:1}]);
  const svcCab=(await db(`SELECT id,cabin_id FROM services WHERE tenant_id=$1 AND id IN (9,82) ORDER BY id`,[T])).rows;
  const okSvc=svcCab.length===2&&Number(svcCab[0].cabin_id)===9&&Number(svcCab[1].cabin_id)===9;
  check("CLEANUP baseline: cabins=3 identiche, service_cabins=2, services.cabin_id 9/82 -> 9, clients=5",okBase&&okSvc,JSON.stringify({fin,rows,svcCab}));
  console.log(`\nTOTALE: ${R.filter(Boolean).length}/${R.length} PASS${R.every(Boolean)?"":"  <<< FALLIMENTI"}`);
}
