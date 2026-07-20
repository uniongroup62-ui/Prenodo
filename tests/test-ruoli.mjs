import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<8;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET|EMAXCONN|max clients/i.test(String(e.message))){await new Promise(r=>setTimeout(r,4000));continue;}throw e;}}}
const one=async(sql,p=[])=>(await db(sql,p)).rows[0];
const SLUG="centroesteticoelite", COOKIE="beautysuite_session_t_centroesteticoelite", SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846", BASE="http://localhost:3000", T=25;
const mk=(role,perms)=>{const p=Buffer.from(JSON.stringify({tenantSlug:SLUG,user:{id:20,email:"x",name:"ZZ Roles Tester",role,perms,needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9}),"utf8").toString("base64url");return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`;};
const SA=mk("admin",[]), SSTAFF=mk("staff",["clients.manage"]), SSTAFFR=mk("staff",["roles.manage"]);
const gget=async(qs="",sess=SA)=>{const r=await fetch(`${BASE}/api/manage/permissions?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:sess?`${COOKIE}=${sess}`:""}});return {status:r.status,j:await r.json()};};
const post=async(body,sess=SA)=>{const r=await fetch(`${BASE}/api/manage/permissions?slug=${SLUG}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${sess}`},body:JSON.stringify({slug:SLUG,action:"save_role_perms",...body})});return {status:r.status,j:await r.json()};};
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.j?.error ?? "");
const setEq=(a,b)=>a.length===b.length&&[...a].sort().join("|")===[...b].sort().join("|");
const dbPerms=async(role)=>(await db(`SELECT perm FROM role_permissions WHERE tenant_id=$1 AND role=$2 ORDER BY perm`,[T,role])).rows.map(r=>r.perm);
const permsSnap=async()=>(await db(`SELECT perm,label,group_name,sort_order FROM permissions WHERE tenant_id=$1 ORDER BY perm`,[T])).rows;
const DENIED="Non hai i permessi per accedere a questa sezione.";
let auditBase=0, snap0=null;

async function cleanup(){
  await db(`DELETE FROM role_permissions WHERE tenant_id=$1 AND role IN ('staff','altro')`,[T]).catch(()=>{});
  await db(`DELETE FROM role_permission_audit_log WHERE tenant_id=$1 AND actor_name='ZZ Roles Tester'`,[T]).catch(()=>{});
}

try {
  snap0=await permsSnap();
  auditBase=Number((await one(`SELECT COUNT(*)::int n FROM role_permission_audit_log WHERE tenant_id=$1`,[T])).n);
  console.log(`[setup] permissions=${snap0.length} audit=${auditBase} role_permissions staff=${(await dbPerms('staff')).length} altro=${(await dbPerms('altro')).length}`);

  // ============ A. GET + gate + ensure ============
  const a1=await gget();
  const rp=a1.j.rolePermissions;
  const groupOrder=(rp?.groups??[]).map(g=>g.groupName).join("|");
  // 17/07: catalogo cresciuto a 63 (aggiunti logs.view + logs.deletions con la
  // feature Log del 16/07 — la vecchia attesa 61 era pre-Log).
  check("A1 GET admin: catalogo 63 definizioni (61+2 log), gruppi in ordine preferito, ruoli Staff/Altro, staff selezionato, assegnazioni vuote",a1.status===200&&(rp?.definitions??[]).length===63&&(rp?.definitions??[]).some(d=>d.perm==="logs.view")&&groupOrder==="Generale|Appuntamenti|Pagamenti|Scadenziario e Costi|Magazzino|Anagrafiche|Clienti|Pacchetti|Preventivi|Fidelizzazione|Risorse|Impostazioni|Amministrazione"&&rp?.manageableRoles?.staff==="Staff"&&rp?.manageableRoles?.altro==="Altro"&&rp?.selectedRole==="staff"&&setEq(rp?.assignments?.staff??["x"],[])&&setEq(rp?.assignments?.altro??["x"],[]),JSON.stringify({defs:(rp?.definitions??[]).length,g:groupOrder.slice(0,40)}));
  const a2=await gget("&role=altro");
  const a2b=await gget("&role=boh");
  check("A2 ?role=altro selezionato; ruolo ignoto -> 'staff'",a2.j.rolePermissions?.selectedRole==="altro"&&a2b.j.rolePermissions?.selectedRole==="staff");
  check("A3 GET staff (clients.manage) -> 403 'Accesso negato' verbatim",(await gget("",SSTAFF)).status===403&&errOf(await gget("",SSTAFF))===DENIED);
  check("A4 GET staff CON roles.manage nei perms -> COMUNQUE 403 (non-assegnabile riservato all'Admin)",errOf(await gget("",SSTAFFR))===DENIED);
  check("A5 401 senza sessione",(await gget("",""))?.status===401);
  const a6=await permsSnap();
  check("A6 ensureDb: tabella permissions INVARIATA dopo i GET (61 righe byte-identiche)",JSON.stringify(a6)===JSON.stringify(snap0),`rows=${a6.length}`);
  await db(`UPDATE permissions SET label='ZZ X', group_name='ZZ G', sort_order=999 WHERE tenant_id=$1 AND perm='calendar.view'`,[T]);
  await db(`DELETE FROM permissions WHERE tenant_id=$1 AND perm='coupons.manage'`,[T]);
  await gget();
  const a7=await one(`SELECT label,group_name,sort_order FROM permissions WHERE tenant_id=$1 AND perm='calendar.view'`,[T]);
  const a7b=await one(`SELECT label,group_name,sort_order FROM permissions WHERE tenant_id=$1 AND perm='coupons.manage'`,[T]);
  check("A7 ensureDb RIPARA: riga manomessa risincronizzata + riga cancellata reinserita",a7?.label==="Calendario"&&a7?.group_name==="Generale"&&Number(a7?.sort_order)===20&&a7b?.label==="Buoni"&&Number(a7b?.sort_order)===50,JSON.stringify({c:a7,b:a7b}));

  // ============ B. Salvataggio + normalizzazione ============
  const b1=await post({role:"staff",perms:["clients.manage","client_sheets.manage"]});
  check("B1 save: figlio ereditato (client_sheets) SCARTATO dalla normalizzazione -> DB solo clients.manage",b1.j.ok===true&&setEq(await dbPerms("staff"),["clients.manage"])&&setEq(b1.j.perms??[],["clients.manage"]),JSON.stringify({db:await dbPerms("staff")}));
  const b1a=await one(`SELECT old_perms,new_perms,actor_name,role FROM role_permission_audit_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1`,[T]);
  check("B1b audit: riga con actor + old [] -> new ['clients.manage']",b1a?.actor_name==="ZZ Roles Tester"&&b1a?.role==="staff"&&b1a?.old_perms==="[]"&&b1a?.new_perms===JSON.stringify(["clients.manage"]),JSON.stringify(b1a));
  const b2=await gget();
  check("B2 GET: assignments.staff normalizzato = ['clients.manage']",setEq(b2.j.rolePermissions?.assignments?.staff??[],["clients.manage"]));

  // Auto-grant nuovo sotto-permesso (staff ha il padre clients.manage)
  await db(`DELETE FROM permissions WHERE tenant_id=$1 AND perm='client_sheets.manage'`,[T]);
  await gget();
  const b3raw=await dbPerms("staff");
  check("B3 ensureDb auto-grant: perm NUOVO (client_sheets) + staff col padre -> riga staff aggiunta (RAW), display invariato (ereditato)",b3raw.includes("client_sheets.manage")&&setEq((await gget()).j.rolePermissions?.assignments?.staff??[],["clients.manage"]),JSON.stringify({raw:b3raw}));

  // Validazione modulo Pacchetti
  const b4=await post({role:"staff",perms:["packages.access"]});
  check("B4 modulo senza figli -> 'Per attivare Pacchetti seleziona almeno una funzione del modulo.' + DB invariato",b4.status===400&&errOf(b4)==="Per attivare Pacchetti seleziona almeno una funzione del modulo."&&setEq(await dbPerms("staff"),["clients.manage","client_sheets.manage"]),errOf(b4));
  const b5=await post({role:"staff",perms:["packages.clients"]});
  check("B5 figlio modulo -> packages.access AUTO-AGGIUNTO dalla normalizzazione",b5.j.ok===true&&setEq(await dbPerms("staff"),["packages.access","packages.clients"]),JSON.stringify({db:await dbPerms("staff")}));
  const b5a=await one(`SELECT old_perms FROM role_permission_audit_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1`,[T]);
  check("B5b audit old_perms = lettura RAW precedente (clients.manage + client_sheets auto-grant)",b5a?.old_perms===JSON.stringify(["client_sheets.manage","clients.manage"]),String(b5a?.old_perms));

  // Migrazione legacy packages.manage (ruolo altro)
  await db(`INSERT INTO role_permissions (tenant_id,role,perm) VALUES ($1,'altro','packages.manage')`,[T]);
  const b6=await gget("&role=altro");
  const b6db=await dbPerms("altro");
  check("B6 migrazione legacy-full: packages.manage -> access+3 figli, riga legacy RIMOSSA",!b6db.includes("packages.manage")&&setEq(b6db,["packages.access","packages.catalog","packages.clients","packages.settings"])&&setEq(b6.j.rolePermissions?.assignments?.altro??[],["packages.access","packages.catalog","packages.clients","packages.settings"]),JSON.stringify({db:b6db}));

  // Audit skip su non-cambiamento
  const auditMid=Number((await one(`SELECT COUNT(*)::int n FROM role_permission_audit_log WHERE tenant_id=$1`,[T])).n);
  const b7=await post({role:"staff",perms:["packages.clients","packages.access"]});
  const auditAfter=Number((await one(`SELECT COUNT(*)::int n FROM role_permission_audit_log WHERE tenant_id=$1`,[T])).n);
  check("B7 salvataggio identico -> NESSUNA riga audit (old==new)",b7.j.ok===true&&auditAfter===auditMid,JSON.stringify({mid:auditMid,after:auditAfter}));

  // Svuota + POST gate staff
  const b8=await post({role:"staff",perms:[]});
  const b8b=await post({role:"altro",perms:[]});
  check("B8 save vuoto -> 0 righe per entrambi i ruoli",b8.j.ok===true&&b8b.j.ok===true&&(await dbPerms("staff")).length===0&&(await dbPerms("altro")).length===0);
  check("B9 POST staff -> 403 verbatim",errOf(await post({role:"staff",perms:["clients.manage"]},SSTAFF))===DENIED);
  check("B10 azione ignota -> 'Azione ruoli non valida.'",errOf(await post({action:"boh",role:"staff",perms:[]}))==="Azione ruoli non valida.");
  check("B11 ruolo ignoto nel POST -> normalizzato a staff",(await post({role:"admin",perms:["clients.manage"]})).j.role==="staff"&&setEq(await dbPerms("staff"),["clients.manage"]));
  await post({role:"staff",perms:[]});
} catch(e){ console.log("ERRORE FATALE:",e.message); R.push(false); }
finally {
  await cleanup();
  const finSnap=await permsSnap();
  const finAudit=Number((await one(`SELECT COUNT(*)::int n FROM role_permission_audit_log WHERE tenant_id=$1`,[T])).n);
  const finRoles=Number((await one(`SELECT COUNT(*)::int n FROM role_permissions WHERE tenant_id=$1`,[T])).n);
  check("CLEANUP: permissions 61 byte-identiche, role_permissions=0, audit=baseline",JSON.stringify(finSnap)===JSON.stringify(snap0)&&finRoles===0&&finAudit===auditBase,JSON.stringify({p:finSnap.length,r:finRoles,a:finAudit,base:auditBase}));
  console.log(`\nTOTALE: ${R.filter(Boolean).length}/${R.length} PASS${R.every(Boolean)?"":"  <<< FALLIMENTI"}`);
}
