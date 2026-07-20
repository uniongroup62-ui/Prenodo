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
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"info@artebrand.it",name:"luca",role:"admin",perms:["commissions.manage","commissions.view"],needsEmailVerification:false,currentLocationId:0,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const api=(m,b,qs="")=>fetch(`http://localhost:3000/api/manage/commissions?slug=${SLUG}${qs}`,{method:m,headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`},...(b?{body:JSON.stringify(b)}:{})}).then(r=>r.json());
const getSettings=()=>api("GET",null,"&action=settings");
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const T=25, S22=22, S56=56, U22=20, U56=52, CLIENT=9, L1=21, L2=51;
const near=(a,b,t=0.02)=>Math.abs(Number(a)-Number(b))<t;
const FEB="&from=2025-02-01&to=2025-02-28";
const createdSales=[], createdAppts=[], tmpStaff=[];

// ---------- BASELINE ----------
const payBefore=(await db(`SELECT id,staff_id,source_group,source_id,entry_status,commission_amount FROM staff_commission_payments WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
const setBefore=Number((await db(`SELECT COUNT(*) c FROM staff_commission_settings WHERE tenant_id=$1`,[T])).rows[0].c);
const perBefore=Number((await db(`SELECT COUNT(*) c FROM staff_commission_periods WHERE tenant_id=$1`,[T])).rows[0].c);
const mperBefore=Number((await db(`SELECT COUNT(*) c FROM staff_commission_module_periods WHERE tenant_id=$1`,[T])).rows[0].c);
const mod0=Number((await db(`SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=$1 AND id=1`,[T])).rows[0]?.is_enabled ?? 0);
if(setBefore!==0||perBefore!==0||mperBefore!==0){console.log(`ABORT baseline non vuota: set=${setBefore} per=${perBefore} mper=${mperBefore}`);process.exit(1);}
const svc=(await db(`SELECT id FROM services WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[T])).rows[0]?.id ?? 9;
const prod=(await db(`SELECT id FROM products WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[T]).catch(()=>({rows:[]}))).rows[0]?.id ?? 7;
console.log(`[baseline] payments=${payBefore.length} svc=${svc} prod=${prod} module=${mod0}`);

const blanketPeriods=async()=>{
  await db(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1`,[T]);
  await db(`INSERT INTO staff_commission_module_periods (tenant_id,started_at,ended_at) VALUES ($1,TIMESTAMP '2025-01-01 00:00:00',NULL)`,[T]);
  for(const sid of [S22,S56]){ await db(`DELETE FROM staff_commission_periods WHERE tenant_id=$1 AND staff_id=$2`,[T,sid]);
    await db(`INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES ($1,$2,TIMESTAMP '2025-01-01 00:00:00',NULL)`,[T,sid]); }
};
async function mkSale({by,loc=L1,date="2025-02-15 12:00:00",subtotal,discount=0,total,status="done",items}){
  const cb=by===null?"NULL":String(by);
  const s=(await db(`INSERT INTO sales (tenant_id,client_id,location_id,sale_date,subtotal,discount,total,status,operator_name,created_by) VALUES ($1,$2,$3,TIMESTAMP '${date}',$4,$5,$6,$7,'op',${cb}) RETURNING id`,[T,CLIENT,loc,subtotal,discount,total,status])).rows[0];
  createdSales.push(s.id);
  for(const it of items){ await db(`INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,[T,s.id,it.type,it.id,it.name,it.amt]); }
  return s.id;
}
async function mkAppt({date="2025-02-16 10:00:00",end="2025-02-16 11:00:00",status="done",loc=L1,svcId=svc,price=100,list=100,pkg=null,seg=null,apptStaff=null}){
  const a=(await db(`INSERT INTO appointments (tenant_id,client_id,starts_at,ends_at,status,location_id) VALUES ($1,$2,TIMESTAMP '${date}',TIMESTAMP '${end}',$3,$4) RETURNING id`,[T,CLIENT,status,loc])).rows[0];
  createdAppts.push(a.id);
  await db(`INSERT INTO appointment_services (tenant_id,appointment_id,service_id,service_name,qty,price,list_price,client_package_id) VALUES ($1,$2,$3,'Svc',1,$4,$5,$6)`,[T,a.id,svcId,price,list,pkg]);
  if(seg!==null) await db(`INSERT INTO appointment_segments (tenant_id,appointment_id,service_id,staff_id,position,starts_at,ends_at,duration_minutes) VALUES ($1,$2,$3,$4,0,TIMESTAMP '${date}',TIMESTAMP '${end}',60)`,[T,a.id,svcId,seg]);
  if(apptStaff!==null) await db(`INSERT INTO appointment_staff (tenant_id,appointment_id,staff_id) VALUES ($1,$2,$3)`,[T,a.id,apptStaff]);
  return a.id;
}
const posRows=(qs)=>db(`SELECT source_id,staff_id,entry_status,base_amount,percent_value,commission_amount,item_label FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='pos' ${qs}`,[T]).then(r=>r.rows);

try {
  // ============ SEZIONE 1: IMPOSTAZIONI & MODULO ============
  const m1=await api("POST",{action:"save_module_settings",enabled:true});
  check("1.1 save_module ON -> settings.moduleEnabled true & DB is_enabled=1", m1.settings?.moduleEnabled===true && Number((await db(`SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=$1 AND id=1`,[T])).rows[0].is_enabled)===1);
  const sv=await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({
    [S22]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:10,posServicePercent:20,posProductPercent:10,posOtherPercent:5,notes:"n22"},
    [S56]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:10,posServicePercent:10,posProductPercent:0,posOtherPercent:0,notes:""},
  })});
  const r22=(await db(`SELECT is_enabled,pos_service_percent,pos_product_percent,appointment_percent,calculation_mode,notes FROM staff_commission_settings WHERE tenant_id=$1 AND staff_id=$2`,[T,S22])).rows[0];
  check("1.2 save_settings #22 -> riga persistita (enabled, %, mode, notes)", Number(r22?.is_enabled)===1 && near(r22?.pos_service_percent,20) && near(r22?.appointment_percent,10) && r22?.calculation_mode==="paid_amount" && r22?.notes==="n22");
  check("1.3 configuredRates >= 2 (due operatori con % > 0)", Number(sv.settings?.configuredRates)>=2, `configuredRates=${sv.settings?.configuredRates}`);
  await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[S22]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:0,posServicePercent:0,posProductPercent:0,posOtherPercent:0,notes:""}})});
  const zr=Number((await db(`SELECT is_enabled FROM staff_commission_settings WHERE tenant_id=$1 AND staff_id=$2`,[T,S22])).rows[0].is_enabled);
  check("1.4 ZERO-RATE auto-disable: salvo enabled ma tutte %=0 -> is_enabled=0", zr===0, `is_enabled=${zr}`);
  // ripristino #22
  await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[S22]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:10,posServicePercent:20,posProductPercent:10,posOtherPercent:5,notes:""}})});
  const sso=(await db(`INSERT INTO staff (tenant_id,full_name) VALUES ($1,'SSO') RETURNING id`,[T])).rows[0]; tmpStaff.push(sso.id);
  const st=await getSettings();
  check("1.5 SSO exclusion: staff 'SSO' NON compare in settings.staff", !(st.settings?.staff||[]).some(s=>s.staffId===sso.id), `ids=${(st.settings?.staff||[]).map(s=>s.staffId).join(",")}`);

  await blanketPeriods();

  // ============ SEZIONE 2: ACCRUAL POS (risoluzione email) ============
  const SB=await mkSale({by:U22,subtotal:300,discount:50,total:250,items:[{type:"product",id:prod,name:"Prod",amt:100},{type:"service",id:svc,name:"Svc",amt:100},{type:"service",id:0,name:"Altro",amt:100}]});
  const S100=await mkSale({by:U22,subtotal:100,discount:100,total:0,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const SCANC=await mkSale({by:U22,status:"cancelled",subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const SOMA=await mkSale({by:U22,subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const SOMB=await mkSale({by:U56,subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const SNUL=await mkSale({by:null,subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  await api("GET",null,FEB+"&source=pos&staff_id=0");
  const bk=Object.fromEntries((await posRows(`AND source_id=${SB} AND entry_status='active'`)).map(r=>[r.item_label,r]));
  const nf=250/300;
  check("2.1 POS bucket prodotto 10%: base~83.33 comm~8.33", near(bk['Prod']?.base_amount,100*nf) && near(bk['Prod']?.commission_amount,100*nf*0.10), JSON.stringify(bk['Prod']));
  check("2.2 POS bucket servizio 20%: comm~16.67", Number(bk['Svc']?.percent_value)===20 && near(bk['Svc']?.commission_amount,100*nf*0.20));
  check("2.3 POS bucket ALTRO (item_id=0) 5%: comm~4.17", Number(bk['Altro']?.percent_value)===5 && near(bk['Altro']?.commission_amount,100*nf*0.05));
  check("2.4 sconto 100% (total=0) -> nessuna commissione", (await posRows(`AND source_id=${S100} AND entry_status='active'`)).length===0);
  check("2.5 vendita ANNULLATA -> nessuna commissione", (await posRows(`AND source_id=${SCANC} AND entry_status='active'`)).length===0);
  const oa=(await posRows(`AND source_id=${SOMA} AND entry_status='active'`))[0], ob=(await posRows(`AND source_id=${SOMB} AND entry_status='active'`))[0];
  check("2.6 OMONIMI: created_by 20 -> #22, created_by 52 -> #56 (staff diversi)", Number(oa?.staff_id)===S22 && Number(ob?.staff_id)===S56 && oa?.staff_id!==ob?.staff_id, `A=${oa?.staff_id} B=${ob?.staff_id}`);
  check("2.7 created_by NULL -> nessuna commissione", (await posRows(`AND source_id=${SNUL} AND entry_status='active'`)).length===0);

  // ============ SEZIONE 3: ACCRUAL APPUNTAMENTI ============
  const AP_SEG=await mkAppt({seg:S22});
  const AP_FALL=await mkAppt({apptStaff:S22});
  const AP_RED=await mkAppt({seg:S22,pkg:999});
  const AP_SCHED=await mkAppt({status:"scheduled",seg:S22});
  await api("GET",null,FEB+"&source=appointments&staff_id=0");
  const arows=(sid)=>db(`SELECT staff_id,commission_amount FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='appointments' AND source_id=$2 AND entry_status='active'`,[T,sid]).then(r=>r.rows);
  check("3.1 appuntamento done + segmento #22 -> commissione ~10", (await arows(AP_SEG)).length===1 && near((await arows(AP_SEG))[0].commission_amount,10));
  check("3.2 fallback appointment_staff (nessun segmento) -> commissione ~10", (await arows(AP_FALL)).length===1 && near((await arows(AP_FALL))[0].commission_amount,10));
  check("3.3 riscatto (client_package_id set) -> SALTATO (no commissione)", (await arows(AP_RED)).length===0);
  check("3.4 appuntamento NON 'done' (scheduled) -> nessuna commissione", (await arows(AP_SCHED)).length===0);

  // ============ SEZIONE 4: GATE PERIODI (#16) ============
  // 4a MODULO gap: periodo modulo [02-10,02-20], staff aperto
  await db(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1`,[T]);
  await db(`INSERT INTO staff_commission_module_periods (tenant_id,started_at,ended_at) VALUES ($1,TIMESTAMP '2025-02-10 00:00:00',TIMESTAMP '2025-02-20 23:59:59')`,[T]);
  await db(`DELETE FROM staff_commission_periods WHERE tenant_id=$1 AND staff_id=$2`,[T,S22]);
  await db(`INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES ($1,$2,TIMESTAMP '2025-01-01 00:00:00',NULL)`,[T,S22]);
  const GB_OUT=await mkSale({by:U22,date:"2025-02-05 12:00:00",subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const GB_IN=await mkSale({by:U22,date:"2025-02-15 12:00:00",subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  await api("GET",null,FEB+"&source=pos&staff_id=0");
  check("4.1 MODULO gap: vendita fuori periodo modulo -> NON commissionata", (await posRows(`AND source_id=${GB_OUT} AND entry_status='active'`)).length===0);
  check("4.2 MODULO: vendita dentro periodo modulo -> commissionata", (await posRows(`AND source_id=${GB_IN} AND entry_status='active'`)).length===1);
  // 4b STAFF gap: modulo aperto, staff [02-14,NULL]
  await db(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1`,[T]);
  await db(`INSERT INTO staff_commission_module_periods (tenant_id,started_at,ended_at) VALUES ($1,TIMESTAMP '2025-01-01 00:00:00',NULL)`,[T]);
  await db(`DELETE FROM staff_commission_periods WHERE tenant_id=$1 AND staff_id=$2`,[T,S22]);
  await db(`INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES ($1,$2,TIMESTAMP '2025-02-14 00:00:00',NULL)`,[T,S22]);
  await api("GET",null,FEB+"&source=pos&staff_id=0");
  check("4.3 STAFF gap: vendita prima del periodo operatore -> NON commissionata", (await posRows(`AND source_id=${GB_OUT} AND entry_status='active'`)).length===0);
  check("4.4 STAFF: vendita dentro periodo operatore -> commissionata", (await posRows(`AND source_id=${GB_IN} AND entry_status='active'`)).length===1);
  await blanketPeriods();

  // ============ SEZIONE 5: FILTRO SEDE ============
  const SD1=await mkSale({by:U22,loc:L1,subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const SD2=await mkSale({by:U22,loc:L2,subtotal:100,total:100,items:[{type:"service",id:svc,name:"Svc",amt:100}]});
  const gAll=await api("GET",null,FEB+"&source=pos&staff_id=0");
  const dash=gAll.dashboard||{};
  check("5.1 dashboard.locations multi-sede (>=2)", Array.isArray(dash.locations)&&dash.locations.length>=2, `locations=${(dash.locations||[]).length}`);
  const idsIn=(d)=> (d.dashboard?.entries||[]).map(e=>Number(String(e.sourceReference||"").replace(/[^0-9]/g,""))||0);
  const g21=idsIn(await api("GET",null,FEB+"&source=pos&staff_id=0&location_id="+L1));
  const g51=idsIn(await api("GET",null,FEB+"&source=pos&staff_id=0&location_id="+L2));
  check("5.2 location_id=21 -> include SD1, esclude SD2", g21.includes(SD1)&&!g21.includes(SD2));
  check("5.3 location_id=51 -> include SD2, esclude SD1", g51.includes(SD2)&&!g51.includes(SD1));

  // ============ SEZIONE 6: AGGREGAZIONE + MARK PAID + RECONCILE ============
  const gAgg=await api("GET",null,FEB+"&source=all&staff_id=0");
  const D=gAgg.dashboard;
  const sumEntries=(D.entries||[]).filter(e=>e.entryStatus!=='cancelled').reduce((s,e)=>s+Number(e.commissionAmount),0);
  check("6.1 summary.totalCommission == somma commissioni entries attive", near(D.summary?.totalCommission,sumEntries,0.05), `sum=${D.summary?.totalCommission} vs ${sumEntries.toFixed(2)}`);
  const op22=(D.operatorSummary||[]).find(o=>o.staffId===S22);
  check("6.2 operatorSummary contiene #22 con totalCommission > 0", !!op22 && Number(op22.totalCommission)>0, `op22=${JSON.stringify(op22?.totalCommission)}`);
  // mark paid su una entry POS di SD1
  const ek=(await db(`SELECT entry_key FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='pos' AND source_id=$2 AND entry_status='active' LIMIT 1`,[T,SD1])).rows[0]?.entry_key;
  const gp=await api("POST",{action:"toggle_commission_paid",entry_key:ek,mark_paid:"1",from:"2025-02-01",to:"2025-02-28",source:"pos",staff_id:0});
  const paidRow=Number((await db(`SELECT is_paid FROM staff_commission_payments WHERE tenant_id=$1 AND entry_key=$2`,[T,ek])).rows[0]?.is_paid);
  check("6.3 mark-paid: toggle_commission_paid -> is_paid=1 & dashboard.summary.paidCommission>0", paidRow===1 && Number(gp.dashboard?.summary?.paidCommission)>0, `is_paid=${paidRow} paid=${gp.dashboard?.summary?.paidCommission}`);
  // reconcile: cancello la vendita SOMA e ricalcolo -> entry cancellata
  const before=(await posRows(`AND source_id=${SOMA} AND entry_status='active'`)).length;
  await db(`DELETE FROM sale_items WHERE sale_id=$1 AND tenant_id=$2`,[SOMA,T]);
  await db(`DELETE FROM sales WHERE id=$1 AND tenant_id=$2`,[SOMA,T]);
  // NB: NON rimuovo SOMA da createdSales -> il cleanup elimina anche il suo snapshot (cancellato).
  await api("GET",null,FEB+"&source=pos&staff_id=0");
  const cancelled=(await db(`SELECT entry_status FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='pos' AND source_id=$2`,[T,SOMA])).rows.every(r=>r.entry_status==='cancelled');
  check("6.4 reconcile: vendita eliminata -> entry commissione CANCELLATA", before===1 && cancelled, `before=${before} allCancelled=${cancelled}`);

  // ============ SEZIONE 7: FUSO ORARIO (confine periodo seminato in UTC, non Rome) ============
  // Bug #16: i confini periodo erano seminati con businessNowDateTime (Europe/Rome, +2h d'estate) ma
  // confrontati con sale_date UTC -> una vendita "adesso" risultava PRIMA del periodo appena aperto.
  // Verifica SICURA (nessuna vendita, nessun dato reale toccato): apro un periodo modulo via API e
  // controllo che lo started_at sia in ORA DI ROMA (fix 18/07: la premessa 'sale_date è UTC' era
  // FALSA — il driver scrive wall locale, sale_date è Roma; i confini devono stare nello stesso
  // frame, prima erano UTC e un periodo chiuso perdeva fino a 2h di vendite).
  await db(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1`,[T]);
  await db(`UPDATE staff_commission_module_settings SET is_enabled=0 WHERE tenant_id=$1 AND id=1`,[T]);
  await api("POST",{action:"save_module_settings",enabled:true}); // OFF->ON: apre periodo modulo (ora Rome-wall)
  const per=(await db(`SELECT to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SS') s FROM staff_commission_module_periods WHERE tenant_id=$1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,[T])).rows[0];
  const romeNow=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date()).replace(" ","T");
  const deltaSec=per?Math.abs(Date.parse(per.s+"Z")-Date.parse(romeNow+"Z"))/1000:NaN;
  check("7.1 FUSO: started_at del periodo aperto via API e' in ORA DI ROMA (~adesso Rome)", per && deltaSec<300, `started_at=${per?.s} romeNow=${romeNow} delta=${isNaN(deltaSec)?'NaN':deltaSec.toFixed(0)}s`);

} finally {
  // ---------- CLEANUP TOTALE (solo dati creati) ----------
  for(const sid of createdSales){ await db(`DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='pos' AND source_id=$2`,[T,sid]); await db(`DELETE FROM sale_items WHERE sale_id=$1 AND tenant_id=$2`,[sid,T]); await db(`DELETE FROM sales WHERE id=$1 AND tenant_id=$2`,[sid,T]); }
  for(const aid of createdAppts){ await db(`DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND source_group='appointments' AND source_id=$2`,[T,aid]); await db(`DELETE FROM appointment_staff WHERE appointment_id=$1 AND tenant_id=$2`,[aid,T]); await db(`DELETE FROM appointment_segments WHERE appointment_id=$1 AND tenant_id=$2`,[aid,T]); await db(`DELETE FROM appointment_services WHERE appointment_id=$1 AND tenant_id=$2`,[aid,T]); await db(`DELETE FROM appointments WHERE id=$1 AND tenant_id=$2`,[aid,T]); }
  await db(`DELETE FROM staff_commission_settings WHERE tenant_id=$1 AND staff_id IN ($2,$3)`,[T,S22,S56]);
  await db(`DELETE FROM staff_commission_periods WHERE tenant_id=$1 AND staff_id IN ($2,$3)`,[T,S22,S56]);
  await db(`DELETE FROM staff_commission_module_periods WHERE tenant_id=$1`,[T]);
  for(const sid of tmpStaff){ await db(`DELETE FROM staff WHERE id=$1 AND tenant_id=$2`,[sid,T]); }
  await db(`UPDATE staff_commission_module_settings SET is_enabled=$1 WHERE tenant_id=$2 AND id=1`,[mod0,T]);
  // verifica ripristino
  const payAfter=(await db(`SELECT id,staff_id,source_group,source_id,entry_status,commission_amount FROM staff_commission_payments WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
  const setA=Number((await db(`SELECT COUNT(*) c FROM staff_commission_settings WHERE tenant_id=$1`,[T])).rows[0].c);
  const perA=Number((await db(`SELECT COUNT(*) c FROM staff_commission_periods WHERE tenant_id=$1`,[T])).rows[0].c);
  const mperA=Number((await db(`SELECT COUNT(*) c FROM staff_commission_module_periods WHERE tenant_id=$1`,[T])).rows[0].c);
  const modA=Number((await db(`SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=$1 AND id=1`,[T])).rows[0]?.is_enabled ?? 0);
  check("CLEANUP: baseline ripristinata (settings/periodi/modPeriodi=0, modulo iniziale)", setA===0&&perA===0&&mperA===0&&modA===mod0, `set=${setA} per=${perA} mper=${mperA} mod=${modA}`);
  check("CLEANUP: 2 righe payments pre-esistenti INTATTE", JSON.stringify(payBefore)===JSON.stringify(payAfter), `before=${payBefore.map(p=>p.id)} after=${payAfter.map(p=>p.id)}`);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
  process.exit(R.every(Boolean)?0:1);
}
