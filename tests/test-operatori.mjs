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
const mkSess=(role,perms)=>sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role,perms,needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const PERMS=["resources.manage","cabins.manage","staff.manage","staff_availability.manage","hours.manage"];
const S21=mkSess("admin",PERMS), SSTAFF=mkSess("staff",["staff.manage"]), SNOPERM=mkSess("staff",["clients.view"]);
const post=(body,sess=S21)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`},body:JSON.stringify(body)}).then(r=>r.json());
const get=(qs,sess=S21)=>fetch(`http://localhost:3000/api/manage/resources?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`}}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? "");
const T=25, L1=21, L2=51, OWNER_STAFF=22, STAFF2=56;
const trk={staff:[],users:[],svc:[],appt:[],seg:[],scp:[]};
const save=(body,sess=S21)=>post({action:"staff_save",...body},sess);
const del=(id,sess=S21)=>post({action:"staff_delete",id:String(id)},sess);
const staffRow=async(id)=>one(`SELECT id,full_name,phone,email,is_active,calendar_color,photo_path FROM staff WHERE tenant_id=$1 AND id=$2`,[T,id]);
const userByEmail=async(e)=>one(`SELECT id,name,email,role,email_verified_at,password_hash FROM users WHERE tenant_id=$1 AND LOWER(email)=$2`,[T,e]);
const locsOf=async(id)=>(await db(`SELECT location_id FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2 ORDER BY location_id`,[T,id])).rows.map(r=>Number(r.location_id));
const mkAppt=async(loc,status,staffId)=>{const a=(await one(`INSERT INTO appointments (tenant_id,client_id,service_id,starts_at,ends_at,status,location_id) VALUES ($1,0,$2,NOW()+INTERVAL '4 days',NOW()+INTERVAL '4 days 1 hour',$3,$4) RETURNING id`,[T,trk.svc[0],status,loc])).id;trk.appt.push(a);const sg=(await one(`INSERT INTO appointment_segments (tenant_id,id,appointment_id,service_id,service_name,staff_id,position,starts_at,ends_at,duration_minutes) VALUES ($1,(SELECT COALESCE(MAX(id),0)+1 FROM appointment_segments),$2,$3,'ZZStaffSvc',$4,1,NOW()+INTERVAL '4 days',NOW()+INTERVAL '4 days 1 hour',60) RETURNING id`,[T,a,trk.svc[0],staffId])).id;trk.seg.push(sg);return a;};
const dropAppt=async()=>{for(const id of trk.seg.splice(0)) await db(`DELETE FROM appointment_segments WHERE tenant_id=$1 AND id=$2`,[T,id]);for(const id of trk.appt.splice(0)) await db(`DELETE FROM appointments WHERE tenant_id=$1 AND id=$2`,[T,id]);};
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const photo=async(fields,sess=S21)=>{const fd=new FormData();for(const [k,v] of Object.entries(fields)){if(v instanceof Blob)fd.set(k,v,"zz.png");else fd.set(k,String(v));}const r=await fetch(`http://localhost:3000/api/manage/staff-photo?slug=${SLUG}`,{method:"POST",headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`},body:fd});return r.json();};

async function cleanup(){
  await dropAppt().catch(()=>{});
  for(const id of trk.scp) await db(`DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2`,[T,id]).catch(()=>{});
  await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND service_id = ANY($2::int[])`,[T,trk.svc.length?trk.svc:[0]]).catch(()=>{});
  await db(`DELETE FROM service_locations WHERE tenant_id=$1 AND service_id = ANY($2::int[])`,[T,trk.svc.length?trk.svc:[0]]).catch(()=>{});
  for(const id of trk.svc) await db(`DELETE FROM services WHERE tenant_id=$1 AND id=$2 AND name LIKE 'ZZ%'`,[T,id]).catch(()=>{});
  const zzStaff=(await db(`SELECT id FROM staff WHERE tenant_id=$1 AND (full_name LIKE 'ZZ%' OR id = ANY($2::int[]))`,[T,trk.staff.length?trk.staff:[0]])).rows.map(r=>r.id);
  for(const id of zzStaff){
    await db(`DELETE FROM staff_locations WHERE tenant_id=$1 AND staff_id=$2`,[T,id]).catch(()=>{});
    await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=$2`,[T,id]).catch(()=>{});
    await db(`DELETE FROM staff WHERE tenant_id=$1 AND id=$2`,[T,id]).catch(()=>{});
  }
  await db(`DELETE FROM user_email_verifications WHERE tenant_id=$1 AND user_id IN (SELECT id FROM users WHERE tenant_id=$1 AND email LIKE 'zz-%')`,[T]).catch(()=>{});
  await db(`DELETE FROM users WHERE tenant_id=$1 AND email LIKE 'zz-%'`,[T]).catch(()=>{});
}

try {
  const base=await one(`SELECT (SELECT COUNT(*) FROM staff WHERE tenant_id=$1)::int st,(SELECT COUNT(*) FROM users WHERE tenant_id=$1)::int u,(SELECT COUNT(*) FROM staff_locations WHERE tenant_id=$1)::int sl,(SELECT COUNT(*) FROM staff_services WHERE tenant_id=$1)::int ss,(SELECT COUNT(*) FROM staff_commission_payments WHERE tenant_id=$1)::int scp,(SELECT COUNT(*) FROM user_locations WHERE tenant_id=$1)::int ul,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  const snap22=await staffRow(OWNER_STAFF), snap56=await staffRow(STAFF2);
  console.log("BASELINE:",JSON.stringify(base));
  const svcZ=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZStaffSvc',30,1) RETURNING id`,[T])).id; trk.svc.push(svcZ);
  console.log(`[setup] svcZ=${svcZ}`);

  // ============ A. LISTA (section=staff, filtro sede) ============
  const a1=await get(`&section=staff`);
  const a1ids=(a1.staff??[]).map(s=>Number(s.id));
  check("A1 lista sede corrente (21): include 22 (sedi 21+51), ESCLUDE 56 (solo 51)",a1ids.includes(OWNER_STAFF)&&!a1ids.includes(STAFF2),JSON.stringify({ids:a1ids}));
  const a2=await get(`&section=staff&all_locations=1`);
  const a2ids=(a2.staff??[]).map(s=>Number(s.id));
  check("A2 'Tutte le sedi': include entrambi",a2ids.includes(OWNER_STAFF)&&a2ids.includes(STAFF2),JSON.stringify({ids:a2ids}));
  const noloc=(await one(`INSERT INTO staff (tenant_id,full_name,is_active) VALUES ($1,'ZZ NoSedi',1) RETURNING id`,[T])).id; trk.staff.push(noloc);
  const a3a=await get(`&section=staff`), a3b=await get(`&section=staff&all_locations=1`);
  const a3row=(a3b.staff??[]).find(s=>Number(s.id)===Number(noloc));
  check("A3 staff SENZA sedi: NASCOSTO col filtro sede, visibile con 'Tutte le sedi' (badge Tutte)",!(a3a.staff??[]).some(s=>Number(s.id)===Number(noloc))&&!!a3row&&(a3row.locationIds??[]).length===0,JSON.stringify({inSede:(a3a.staff??[]).some(s=>Number(s.id)===Number(noloc)),locIds:a3row?.locationIds}));
  await db(`DELETE FROM staff WHERE tenant_id=$1 AND id=$2`,[T,noloc]);
  const a4=await get(`&section=staff`,SNOPERM);
  check("A4 senza permesso -> Permesso negato",/Permesso negato/.test(errOf(a4)),errOf(a4));
  const a5=(a2.staff??[]).find(s=>Number(s.id)===OWNER_STAFF);
  check("A5 owner in lista: isOwner=true, role admin, foto R2 presente",!!a5&&a5.isOwner===true&&a5.role==="admin"&&String(a5.photoPath).startsWith("https://"),JSON.stringify({o:a5?.isOwner,r:a5?.role}));

  // ============ B. action=get (prefill) ============
  const b1=await get(`&section=staff&action=get&id=${OWNER_STAFF}`);
  check("B1 get owner: isOwner, colore RAW '' (calendar_color NULL -> il form usa #93c5fd)",b1.ok===true&&b1.staff?.isOwner===true&&b1.staff?.color===""&&b1.staff?.role==="admin",JSON.stringify({c:b1.staff?.color,o:b1.staff?.isOwner}));
  const b2=await get(`&section=staff&action=get&id=999999`);
  check("B2 get id inesistente -> 'Operatore non trovato' (senza punto)",errOf(b2)==="Operatore non trovato",errOf(b2));
  const b3=await get(`&section=staff&action=get&id=${OWNER_STAFF}`,SSTAFF);
  check("B3 get admin da NON-admin -> 'Solo Admin puo modificare account Admin.'",errOf(b3)==="Solo Admin puo modificare account Admin.",errOf(b3));
  const sso=(await one(`INSERT INTO staff (tenant_id,full_name,is_active) VALUES ($1,'SSO',1) RETURNING id`,[T])).id; trk.staff.push(sso);
  const b4=await get(`&section=staff&action=get&id=${sso}`);
  check("B4 get riga SSO -> 'Operatore SSO non modificabile'",errOf(b4)==="Operatore SSO non modificabile",errOf(b4));

  // ============ C. CREATE ============
  check("C1 nome vuoto -> 'Nome operatore obbligatorio.' (check protettivo)",errOf(await save({id:"0",full_name:"",email:"zz-x@example.com",password:"p",location_ids:String(L1)}))==="Nome operatore obbligatorio.");
  const c2=await save({id:"0",full_name:"sso",email:"zz-x@example.com",password:"p",location_ids:String(L1)});
  check("C2 nome riservato 'sso' -> msg VERDE 'Nome operatore riservato (SSO)'",errOf(c2)==="Nome operatore riservato (SSO)"&&c2.flashKind==="msg",JSON.stringify({e:errOf(c2),k:c2.flashKind}));
  const c3=await save({id:"0",full_name:"ZZ Op X",email:"",password:"",calendar_color:"zzz",location_ids:String(L1)});
  check("C3 ORDINE legacy: colore invalido PRIMA di email mancante -> 'Colore non valido' msg",errOf(c3)==="Colore non valido"&&c3.flashKind==="msg",JSON.stringify({e:errOf(c3),k:c3.flashKind}));
  const c4=await save({id:"0",full_name:"ZZ Op X",email:"",password:"",location_ids:""});
  check("C4 ORDINE legacy: sede mancante PRIMA di email mancante -> 'Seleziona almeno una sede per l'operatore.'",errOf(c4)==="Seleziona almeno una sede per l'operatore.",errOf(c4));
  const c5=await save({id:"0",full_name:"ZZ Op X",email:"",password:"p",location_ids:String(L1)});
  check("C5 email mancante -> msg 'Email obbligatoria'",errOf(c5)==="Email obbligatoria"&&c5.flashKind==="msg");
  const c6=await save({id:"0",full_name:"ZZ Op X",email:"zz-x@example.com",password:"",location_ids:String(L1)});
  check("C6 password mancante -> msg 'Password obbligatoria'",errOf(c6)==="Password obbligatoria"&&c6.flashKind==="msg");
  const c7=await save({id:"0",full_name:"ZZ Op X",email:snap22.email,password:"p",location_ids:String(L1)});
  check("C7 email di un altro operatore -> msg 'Email già utilizzata'",errOf(c7)==="Email già utilizzata"&&c7.flashKind==="msg",errOf(c7));
  const c8=await save({id:"0",full_name:"ZZ Op A",ui_role:"staff",email:"zz-a@example.com",password:"segreta1",phone:"333 1234567",calendar_color:"112233",is_active:"1",location_ids:String(L1)});
  const idA=Number(c8.staff?.id||0); if(idA)trk.staff.push(idA);
  const c8u=await userByEmail("zz-a@example.com");
  check("C8 create ok: staff+user (bcrypt, email_verified_at NULL), sede [21], colore #112233 (senza #)",c8.ok===true&&c8.msg==="Operatore salvato"&&idA>0&&!!c8u&&c8u.role==="staff"&&c8u.email_verified_at===null&&String(c8u.password_hash).startsWith("$2")&&(await locsOf(idA)).join(",")===String(L1)&&(await staffRow(idA)).calendar_color==="#112233",JSON.stringify({id:idA,err:errOf(c8)}));
  const c9=await save({id:"0",full_name:"ZZ Op Adm2",ui_role:"admin",email:"zz-adm2@example.com",password:"p",location_ids:String(L1)},SSTAFF);
  check("C9 NON-admin assegna ruolo Admin -> 'Solo Admin puo assegnare il ruolo Admin.'",errOf(c9)==="Solo Admin puo assegnare il ruolo Admin.",errOf(c9));
  const c10=await save({id:"0",full_name:"ZZ Op C",ui_role:"staff",email:"zz-c@example.com",password:"p",location_ids:String(L1)},SSTAFF);
  const idC=Number(c10.staff?.id||0); if(idC)trk.staff.push(idC);
  check("C10 NON-admin crea staff normale -> ok (basta staff.manage)",c10.ok===true&&idC>0,errOf(c10));

  // ============ D. EDIT ============
  const cB=await save({id:"0",full_name:"ZZ Op B",ui_role:"staff",email:"zz-b@example.com",password:"segreta1",location_ids:`${L1},${L2}`});
  const idB=Number(cB.staff?.id||0); if(idB)trk.staff.push(idB);
  const d1=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b@example.com",phone:"333 999",calendar_color:"#445566",is_active:"1",location_ids:`${L1},${L2}`});
  const d1u=await userByEmail("zz-b@example.com");
  check("D1 edit: rename+phone+colore persistiti, users.name sincronizzato",d1.ok===true&&(await staffRow(idB)).full_name==="ZZ Op B1"&&(await staffRow(idB)).calendar_color==="#445566"&&d1u.name==="ZZ Op B1",JSON.stringify({err:errOf(d1)}));
  const d2=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b2@example.com",is_active:"1",location_ids:`${L1},${L2}`});
  const d2u=await userByEmail("zz-b2@example.com");
  check("D2 cambio email: users.email aggiornata + email_verified_at azzerata",d2.ok===true&&!!d2u&&d2u.email_verified_at===null&&!(await userByEmail("zz-b@example.com")),JSON.stringify({err:errOf(d2)}));
  const d3=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"",is_active:"1",location_ids:`${L1},${L2}`});
  check("D3 email svuotata -> account login ELIMINATO (con cascata verifiche/user_locations)",d3.ok===true&&!(await userByEmail("zz-b2@example.com")),JSON.stringify({err:errOf(d3)}));
  const d4=await save({id:String(idB),full_name:"ZZ NON PERSISTERE",ui_role:"staff",email:"zz-b3@example.com",password:"",is_active:"1",location_ids:`${L1},${L2}`});
  check("D4 email nuova SENZA password -> errore PRE-write, NULLA persistito (nome invariato)",errOf(d4)==="Password obbligatoria per creare l'account login dell'operatore."&&(await staffRow(idB)).full_name==="ZZ Op B1",JSON.stringify({e:errOf(d4),n:(await staffRow(idB)).full_name}));
  const d5=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",password:"segreta2",is_active:"1",location_ids:`${L1},${L2}`});
  check("D5 email nuova CON password -> account creato (late-create)",d5.ok===true&&!!(await userByEmail("zz-b3@example.com")),errOf(d5));
  await mkAppt(L2,"pending",idB);
  const d6=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"1",location_ids:String(L1)});
  check("D6 rimozione sede con prenotazione aperta -> blocco verbatim",errOf(d6)==="Non puoi rimuovere questa sede: l'operatore ha prenotazioni in sospeso o prenotate collegate.",errOf(d6));
  await dropAppt();
  await db(`INSERT INTO staff_services (tenant_id,staff_id,service_id) VALUES ($1,$2,$3)`,[T,idB,svcZ]);
  const d7=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"1",location_ids:String(L1)});
  check("D7 rimozione sede che orfana il servizio -> 'Non puoi rimuovere la sede \"Sede 2\": il servizio \"ZZStaffSvc\"...'",errOf(d7)==='Non puoi rimuovere la sede "Sede 2": il servizio "ZZStaffSvc" resterebbe senza operatori abilitati.',errOf(d7));
  await mkAppt(L1,"scheduled",idB);
  const d8=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"0",location_ids:`${L1},${L2}`});
  check("D8 disattivazione con prenotazione aperta -> blocco verbatim",errOf(d8)==="Non puoi disattivare l'operatore: ha prenotazioni in sospeso o prenotate collegate.",errOf(d8));
  await dropAppt();
  const d9=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"0",location_ids:`${L1},${L2}`});
  check("D9 disattivazione che orfana il servizio -> blocco con sede nel messaggio",errOf(d9)==='Non puoi disattivare l\'operatore: il servizio "ZZStaffSvc" resterebbe senza operatori abilitati in "Sede1".',errOf(d9));
  await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=$2`,[T,idB]);
  const d10=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"0",location_ids:`${L1},${L2}`});
  const d10b=await save({id:String(idB),full_name:"ZZ Op B1",ui_role:"staff",email:"zz-b3@example.com",is_active:"1",location_ids:`${L1},${L2}`});
  check("D10 disattivazione senza vincoli -> ok, poi riattivato",d10.ok===true&&d10b.ok===true&&Number((await staffRow(idB)).is_active)===1,JSON.stringify({e1:errOf(d10)}));
  const d11=await save({id:String(OWNER_STAFF),full_name:"luca",ui_role:"admin",email:snap22.email,is_active:"1",location_ids:`${L1},${L2}`},SSTAFF);
  check("D11 NON-admin edita l'owner admin -> bloccato PRIMA di ogni write",errOf(d11)==="Solo Admin puo modificare account Admin."&&JSON.stringify(await staffRow(OWNER_STAFF))===JSON.stringify(snap22),errOf(d11));
  const d12=await save({id:String(sso),full_name:"SSO",email:"",location_ids:String(L1)});
  check("D12 save su riga SSO -> msg 'Operatore SSO non modificabile'",errOf(d12)==="Operatore SSO non modificabile"&&d12.flashKind==="msg",errOf(d12));

  // ============ E. DELETE ============
  check("E1 delete id inesistente -> 'Operatore non trovato'",errOf(await del(999999))==="Operatore non trovato");
  const e2=await del(OWNER_STAFF);
  check("E2 delete owner -> 'Admin non può essere eliminato' (accentato) + riga intatta",errOf(e2)==="Admin non può essere eliminato"&&JSON.stringify(await staffRow(OWNER_STAFF))===JSON.stringify(snap22),errOf(e2));
  const cAdm=await save({id:"0",full_name:"ZZ Op Adm",ui_role:"admin",email:"zz-adm@example.com",password:"p",location_ids:String(L1)});
  const idAdm=Number(cAdm.staff?.id||0); if(idAdm)trk.staff.push(idAdm);
  const e3=await del(idAdm,SSTAFF);
  check("E3 NON-admin elimina un admin -> 'Solo Admin puo eliminare o modificare account Admin.'",errOf(e3)==="Solo Admin puo eliminare o modificare account Admin.",errOf(e3));
  await mkAppt(L1,"done",idB);
  const e4=await del(idB);
  check("E4 delete con prenotazione di QUALSIASI stato (done) -> 'risulta gia usato in prenotazioni'",errOf(e4)==="Operatore non eliminabile: risulta gia usato in prenotazioni. Disattivalo per mantenere lo storico.",errOf(e4));
  await dropAppt();
  await db(`INSERT INTO staff_services (tenant_id,staff_id,service_id) VALUES ($1,$2,$3)`,[T,idB,svcZ]);
  const e5=await del(idB);
  check("E5 delete con servizio collegato -> err + popup (title/operator_name/services)",errOf(e5)==="Operatore non eliminabile: associato a uno o più servizi"&&e5.popup?.title==="Impossibile eliminare l'operatore"&&e5.popup?.operator_name==="ZZ Op B1"&&(e5.popup?.services??[])[0]?.service_name==="ZZStaffSvc"&&e5.popup?.message==="L'operatore non può essere eliminato perché è associato ai servizi elencati. Rimuovi prima l'operatore dai servizi collegati.",JSON.stringify({e:errOf(e5),svc:e5.popup?.services}));
  await db(`DELETE FROM staff_services WHERE tenant_id=$1 AND staff_id=$2`,[T,idB]);
  const scp=(await one(`INSERT INTO staff_commission_payments (tenant_id,id,entry_key,staff_id) VALUES ($1,(SELECT COALESCE(MAX(id),0)+1 FROM staff_commission_payments),'ZZK1',$2) RETURNING id`,[T,idB])).id; trk.scp.push(scp);
  const e6=await del(idB);
  check("E6 delete con storico commissioni -> blocco verbatim",errOf(e6)==="Operatore non eliminabile: risulta usato nello storico commissioni. Disattivalo per mantenere lo storico.",errOf(e6));
  await db(`DELETE FROM staff_commission_payments WHERE tenant_id=$1 AND id=$2`,[T,scp]); trk.scp.pop();
  const e7=await del(idB);
  check("E7 delete pulita -> hard delete: staff+users+staff_locations rimossi, msg 'Operatore eliminato'",e7.ok===true&&e7.msg==="Operatore eliminato"&&!(await staffRow(idB))&&!(await userByEmail("zz-b3@example.com"))&&(await locsOf(idB)).length===0,JSON.stringify({err:errOf(e7)}));
  const e8=await del(idAdm);
  check("E8 admin elimina un admin NON-owner -> ok (utente login rimosso)",e8.ok===true&&!(await userByEmail("zz-adm@example.com")),errOf(e8));
  const e9=await del(sso);
  check("E9 delete riga SSO -> msg VERDE 'Operatore SSO non eliminabile'",errOf(e9)==="Operatore SSO non eliminabile"&&e9.flashKind==="msg",JSON.stringify({e:errOf(e9),k:e9.flashKind}));
  await db(`DELETE FROM staff WHERE tenant_id=$1 AND id=$2`,[T,sso]);

  // ============ F. FOTO (R2) ============
  const f1=await photo({staff_id:idA,operator_photo:new Blob([PNG],{type:"image/png"})});
  check("F1 upload PNG -> photo_path = URL pubblico R2",f1.ok===true&&String(f1.photoPath).startsWith("https://")&&String((await staffRow(idA)).photo_path).startsWith("https://"),JSON.stringify({e:errOf(f1)}));
  // FIX 17/07: il MIME e' sniffato dai MAGIC BYTES (come getimagesize legacy):
  // un PNG REALE dichiarato text/plain viene ACCETTATO (la vecchia attesa
  // codificava il comportamento pre-fix basato sul type dichiarato); il
  // rifiuto per contenuto non-immagine e' coperto da test-operatori-pass2.
  const f2=await photo({staff_id:idA,operator_photo:new Blob([PNG],{type:"text/plain"})});
  check("F2 PNG reale dichiarato text/plain -> ACCETTATO (magic bytes)",f2.ok===true&&String(f2.photoPath).startsWith("https://"),errOf(f2));
  const f3=await photo({staff_id:idA,remove_photo:"1"});
  check("F3 remove_photo -> photo_path NULL",f3.ok===true&&(await staffRow(idA)).photo_path===null,JSON.stringify({e:errOf(f3)}));
  const f4=await photo({staff_id:0,operator_photo:new Blob([PNG],{type:"image/png"})});
  check("F4 id non valido -> 'Operatore non valido' (senza punto)",errOf(f4)==="Operatore non valido",errOf(f4));
  const f5=await photo({staff_id:idA,operator_photo:new Blob([PNG],{type:"image/png"})},SNOPERM);
  check("F5 senza permesso -> 'Permesso Operatori richiesto.'",errOf(f5)==="Permesso Operatori richiesto.",errOf(f5));
  await photo({staff_id:idA,operator_photo:new Blob([PNG],{type:"image/png"})});
  const e10=await del(idA);
  check("F6 delete operatore CON foto -> ok (cleanup oggetto R2 best-effort)",e10.ok===true&&!(await staffRow(idA)),errOf(e10));
  const e11=await del(idC);
  check("F7 delete ZZ Op C -> ok",e11.ok===true,errOf(e11));
} catch(e){ console.log("ERRORE FATALE:",e.message); R.push(false); }
finally {
  await cleanup();
  const fin=await one(`SELECT (SELECT COUNT(*) FROM staff WHERE tenant_id=$1)::int st,(SELECT COUNT(*) FROM users WHERE tenant_id=$1)::int u,(SELECT COUNT(*) FROM staff_locations WHERE tenant_id=$1)::int sl,(SELECT COUNT(*) FROM staff_services WHERE tenant_id=$1)::int ss,(SELECT COUNT(*) FROM staff_commission_payments WHERE tenant_id=$1)::int scp,(SELECT COUNT(*) FROM user_locations WHERE tenant_id=$1)::int ul,(SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int cl`,[T]);
  const cur22=await staffRow(OWNER_STAFF), cur56=await staffRow(STAFF2);
  const users=(await db(`SELECT id,email,role FROM users WHERE tenant_id=$1 ORDER BY id`,[T])).rows;
  // 17/07: baseline staff_locations = 2 (22@21, 56@51 — fixture canonica); il
  // vecchio 3 includeva una riga sparita tra il 12/07 e oggi (non ricostruibile,
  // nessuna suite la assume). MAI reinserirla per inferenza.
  const okBase=fin.st===2&&fin.u===2&&fin.sl===2&&fin.ss===3&&fin.scp===2&&fin.ul===1&&fin.cl===5;
  const okRows=JSON.stringify(cur22)===JSON.stringify(await (async()=>{const s=await staffRow(OWNER_STAFF);return s;})())&&cur22.full_name==="luca"&&cur56.full_name==="Luca"&&Number(cur22.is_active)===1&&Number(cur56.is_active)===1&&String(cur22.photo_path).startsWith("https://")&&users.length===2&&users[0].role==="admin";
  check("CLEANUP baseline: staff=2 intatti (22 con foto, 56), users=2, junctions 3/3, commissioni=2, clients=5",okBase&&okRows,JSON.stringify({fin,u:users.map(x=>x.email)}));
  console.log(`\nTOTALE: ${R.filter(Boolean).length}/${R.length} PASS${R.every(Boolean)?"":"  <<< FALLIMENTI"}`);
}
