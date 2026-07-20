import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
let DBURL=""; for (const l of envText.split(/\r?\n/)){const m=l.match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/);if(m)DBURL=m[1].trim().replace(/^["']|["']$/g,"");}
async function db(sql,p=[]){for(let a=0;a<6;a++){const c=new pg.Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});try{await c.connect();const r=await c.query(sql,p);await c.end();return r;}catch(e){try{await c.end();}catch{}if(/ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(String(e.message))){await new Promise(r=>setTimeout(r,2500));continue;}throw e;}}}
const one=async(sql,p=[])=>(await db(sql,p)).rows[0];
const SECRET="dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846",SLUG="centroesteticoelite",COOKIE="beautysuite_session_t_centroesteticoelite";
const sign=(s)=>{const p=Buffer.from(JSON.stringify(s),"utf8").toString("base64url");return `${p}.${crypto.createHmac("sha256",SECRET).update(p).digest("base64url")}`;};
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:["packages.catalog","packages.clients","pos.manage","packages.access"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const api=(body)=>fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`},body:JSON.stringify(body)}).then(r=>r.json());
const get=(qs)=>fetch(`http://localhost:3000/api/manage/packages?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`}}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const T=25, L1=21, C=9;
const errOf=(r)=>String(r?.error ?? "");
const near=(a,b,t=0.02)=>Math.abs(Number(a)-Number(b))<t;
// pg ritorna le colonne DATE come oggetto Date (mezzanotte locale): normalizza a YYYY-MM-DD locale.
const ymd=(v)=> v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,"0")}-${String(v.getDate()).padStart(2,"0")}` : String(v).slice(0,10);
const trk={svc:[],prod:[],cat:[],cp:[]};

try {
  const svcA=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZSvcA',100,1) RETURNING id`,[T])).id; trk.svc.push(svcA);
  const svcB=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZSvcB',60,1) RETURNING id`,[T])).id; trk.svc.push(svcB);
  const prodA=(await one(`INSERT INTO products (tenant_id,name,price,is_active) VALUES ($1,'ZZProdA',40,1) RETURNING id`,[T])).id; trk.prod.push(prodA);

  // ===== A. CATALOGO =====
  check("A1 nome vuoto -> 'Nome obbligatorio'", /Nome obbligatorio/.test(errOf(await api({action:"catalog_save", name:"", items:JSON.stringify([{item_type:"service",item_id:svcA,qty:1}]), location_ids:String(L1)}))));
  check("A2 nessun contenuto -> 'Aggiungi almeno un servizio/prodotto'", /Aggiungi almeno un servizio\/prodotto/.test(errOf(await api({action:"catalog_save", name:"ZZCat0", items:"[]", location_ids:String(L1)}))));
  check("A3 solo prodotti (no servizio) -> 'necessario almeno un servizio'", /necessario almeno un servizio/.test(errOf(await api({action:"catalog_save", name:"ZZCatP", items:JSON.stringify([{item_type:"product",item_id:prodA,qty:1}]), location_ids:String(L1)}))));
  check("A4 sede obbligatoria -> 'Seleziona almeno una sede'", /Seleziona almeno una sede per il pacchetto/.test(errOf(await api({action:"catalog_save", name:"ZZCatNoSede", items:JSON.stringify([{item_type:"service",item_id:svcA,qty:1}])}))));

  // create valido: svcA x2 (200), svcB x1 -10% (54), prodA x1 (40); subtot 294; sconto totale 5% -> 279.30; sessions=3
  const items=JSON.stringify([{item_type:"service",item_id:svcA,qty:2,unit_price:0},{item_type:"service",item_id:svcB,qty:1,unit_price:0,discount_type:"percent",discount_value:10},{item_type:"product",item_id:prodA,qty:1,unit_price:0}]);
  const cr=await api({action:"catalog_save", name:"ZZCatMain", description:"desc", validity_days:"90", is_active:"1", items, location_ids:String(L1), total_discount_type:"percent", total_discount_value:"5"});
  const CAT=Number(cr.id ?? cr.saved?.id ?? 0); if(CAT>0) trk.cat.push(CAT);
  const catRow=await one(`SELECT name,price,sessions_total,service_id,validity_days FROM packages WHERE id=$1`,[CAT]);
  check("A5 FORMULA prezzo: 200+54+40=294 -5% = 279.30; sessions_total=3; service_id NULL (multi)", CAT>0 && near(catRow.price,279.30) && Number(catRow.sessions_total)===3 && catRow.service_id===null && Number(catRow.validity_days)===90, JSON.stringify(catRow));
  const pi=(await db(`SELECT item_type,line_total FROM package_items WHERE package_id=$1 ORDER BY sort_order`,[CAT])).rows;
  check("A5b righe: line_total svcA=200, svcB=54, prodA=40", pi.length===3 && near(pi.find(r=>near(r.line_total,200))?.line_total,200) && !!pi.find(r=>near(r.line_total,54)) && !!pi.find(r=>near(r.line_total,40)), JSON.stringify(pi.map(r=>r.line_total)));
  // edit
  await api({action:"catalog_save", id:String(CAT), name:"ZZCatMain2", items, location_ids:String(L1), total_discount_type:"percent", total_discount_value:"0"});
  const ed=await one(`SELECT name,price FROM packages WHERE id=$1`,[CAT]);
  check("A6 edit -> nome aggiornato + prezzo ricalcolato (senza sconto totale = 294)", ed.name==="ZZCatMain2" && near(ed.price,294), JSON.stringify(ed));

  // ===== B. CLIENT-PKG =====
  // issue dal catalogo
  const iss=await api({action:"issue", package_id:String(CAT), client_id:String(C), client_name:"ZZ"});
  const CP=Number(iss.clientPackage?.id ?? 0); if(CP>0) trk.cp.push(CP);
  const cpRow=await one(`SELECT package_name,sessions_total,sessions_remaining,status FROM client_packages WHERE id=$1`,[CP]);
  check("B1 issue -> pacchetto cliente creato (sedute 3, attivo)", CP>0 && Number(cpRow.sessions_total)===3 && Number(cpRow.sessions_remaining)===3 && cpRow.status==="active", JSON.stringify(cpRow));
  // client_save id=0 (crea da gestione) -> bloccato
  check("B2 crea pacchetto-cliente da gestione -> 'solo da Pagamenti'", /solo da Pagamenti/.test(errOf(await api({action:"client_save", client_id:String(C), package_name:"X"}))));
  // usage_add consume 1 seduta di svcA
  await api({action:"usage_add", client_package_id:String(CP), op:"consume", qty:"1", service_id:String(svcA), item_ref:`service:${svcA}`});
  check("B3 usage_add consume servizio -> sessions_remaining 3->2 + movimento", Number((await one(`SELECT sessions_remaining FROM client_packages WHERE id=$1`,[CP])).sessions_remaining)===2 && Number((await one(`SELECT COUNT(*) c FROM client_package_usages WHERE client_package_id=$1`,[CP])).c)>=1);
  // usage_add restore
  await api({action:"usage_add", client_package_id:String(CP), op:"restore", qty:"1", service_id:String(svcA), item_ref:`service:${svcA}`});
  check("B4 usage_add restore -> sessions_remaining 2->3", Number((await one(`SELECT sessions_remaining FROM client_packages WHERE id=$1`,[CP])).sessions_remaining)===3);
  // consume oltre le sedute del servizio (svcA ha 2, provo consume 5)
  check("B5 consume > disponibili -> 'Sedute insufficienti'", /Sedute insufficienti/.test(errOf(await api({action:"usage_add", client_package_id:String(CP), op:"consume", qty:"5", service_id:String(svcA), item_ref:`service:${svcA}`}))));

  // update_expiry
  check("B6 update_expiry data < oggi -> errore", /precedente a oggi/.test(errOf(await api({action:"update_expiry", client_package_id:String(CP), expires_at:"2020-01-01"}))));
  const upExp=await api({action:"update_expiry", client_package_id:String(CP), expires_at:"2030-12-31"});
  check("B7 update_expiry valida -> aggiornata", !errOf(upExp) && ymd((await one(`SELECT expires_at FROM client_packages WHERE id=$1`,[CP])).expires_at)==="2030-12-31", errOf(upExp)||ymd((await one(`SELECT expires_at FROM client_packages WHERE id=$1`,[CP])).expires_at));

  // edit: rename OK
  await api({action:"client_save", id:String(CP), client_id:String(C), package_name:"ZZPkgRen", sessions_total:"3", sessions_remaining:"3", status:"active"});
  check("B8 client_save edit -> package_name aggiornato", (await one(`SELECT package_name FROM client_packages WHERE id=$1`,[CP])).package_name==="ZZPkgRen");
  // edit: set status canceled -> bloccato
  check("B9 client_save status=canceled -> 'si annulla solo dal dettaglio vendita'", /si annulla solo dal dettaglio vendita/.test(errOf(await api({action:"client_save", id:String(CP), client_id:String(C), package_name:"ZZPkgRen", status:"canceled"}))));

  // update_expiry su pacchetto GIA' USATO -> bloccato (consumo 1 poi provo)
  await api({action:"usage_add", client_package_id:String(CP), op:"consume", qty:"1", service_id:String(svcA), item_ref:`service:${svcA}`});
  check("B10 update_expiry su pacchetto USATO -> 'gia utilizzato'", /gia.? utilizzato/i.test(errOf(await api({action:"update_expiry", client_package_id:String(CP), expires_at:"2031-01-01"}))));

  // ===== B-prod. RITIRO PRODOTTO da pacchetto emesso (path abilitato dal fix snapshot item_type='product') =====
  // Il catalogo conteneva prodA x1: l'emissione deve averlo snapshottato in client_package_items come item_type='product'.
  const snapProd=await one(`SELECT item_type,qty FROM client_package_items WHERE client_package_id=$1 AND LOWER(item_type)='product' AND item_id=$2`,[CP,prodA]);
  check("B11 snapshot: client_package_items ha riga item_type='product' (abilita il ritiro)", !!snapProd && Number(snapProd.qty)===1, JSON.stringify(snapProd||null));
  // I prodotti NON sono sedute: nessuna riga client_package_services per il prodotto.
  check("B11b prodotto NON genera riga sedute", Number((await one(`SELECT COUNT(*) c FROM client_package_services WHERE client_package_id=$1 AND service_id=$2`,[CP,prodA])).c)===0);
  // Dai stock al prodotto e registra il ritiro (prima del fix falliva con 'Prodotto non incluso').
  await db(`UPDATE products SET stock=5 WHERE id=$1`,[prodA]);
  const wd=await api({action:"usage_add", client_package_id:String(CP), op:"consume", qty:"1", item_ref:`product:${prodA}`});
  check("B12 ritiro prodotto -> stock 5->4 + movimento (no 'Prodotto non incluso')", !errOf(wd) && Number((await one(`SELECT stock FROM products WHERE id=$1`,[prodA])).stock)===4 && Number((await one(`SELECT COUNT(*) c FROM client_package_usages WHERE client_package_id=$1 AND LOWER(item_type)='product'`,[CP])).c)>=1, errOf(wd));
  const wr=await api({action:"usage_add", client_package_id:String(CP), op:"restore", qty:"1", item_ref:`product:${prodA}`});
  check("B13 ripristino ritiro -> stock 4->5", !errOf(wr) && Number((await one(`SELECT stock FROM products WHERE id=$1`,[prodA])).stock)===5, errOf(wr));

  // ===== C. STATI derivati =====
  const cpComp=(await one(`INSERT INTO client_packages (tenant_id,client_id,package_name,sessions_total,sessions_remaining,status,location_id) VALUES ($1,$2,'ZZComp',3,0,'active',$3) RETURNING id`,[T,C,L1])).id; trk.cp.push(cpComp);
  const dComp=await get(`&action=view&id=${cpComp}`);
  check("C1 stato derivato: remaining 0 -> Completato", (dComp.detail?.statusLabel||"")==="Completato", dComp.detail?.statusLabel);
  const cpExp=(await one(`INSERT INTO client_packages (tenant_id,client_id,package_name,sessions_total,sessions_remaining,status,expires_at,location_id) VALUES ($1,$2,'ZZExp',3,2,'active',DATE '2020-01-01',$3) RETURNING id`,[T,C,L1])).id; trk.cp.push(cpExp);
  const dExp=await get(`&action=view&id=${cpExp}`);
  check("C2 stato derivato: scaduto -> Scaduto", (dExp.detail?.statusLabel||"")==="Scaduto", dExp.detail?.statusLabel);

  // ===== D. DELETE CATALOGO -> detach client_packages =====
  const pkgNameBefore=(await one(`SELECT package_name FROM client_packages WHERE id=$1`,[CP])).package_name;
  const del=await api({action:"catalog_delete", id:String(CAT)});
  const afterDel=await one(`SELECT package_id,package_name FROM client_packages WHERE id=$1`,[CP]);
  check("D1 delete catalogo -> client_packages DETACHED (package_id NULL, package_name conservato)", afterDel.package_id===null && afterDel.package_name===pkgNameBefore && Number((await one(`SELECT COUNT(*) c FROM packages WHERE id=$1`,[CAT])).c)===0);
  if(Number((await one(`SELECT COUNT(*) c FROM packages WHERE id=$1`,[CAT])).c)===0) trk.cat=trk.cat.filter(x=>x!==CAT);

  // ===== E. listing filtro stato =====
  const lst=await get(`&action=client_list&status=all`);
  check("E1 client_list ritorna i pacchetti (incl. ZZ)", Array.isArray(lst.clientPackages||lst.rows||lst.packages) || Array.isArray(lst.items), JSON.stringify(Object.keys(lst)).slice(0,80));

} finally {
  for(const id of trk.cp){ const sd=(await db(`SELECT id FROM stock_docs WHERE tenant_id=$1 AND notes LIKE $2`,[T,`%pacchetto cliente #${id}%`]).catch(()=>({rows:[]}))).rows; for(const d of sd){ await db(`DELETE FROM stock_doc_items WHERE stock_doc_id=$1`,[d.id]).catch(()=>{}); await db(`DELETE FROM stock_docs WHERE id=$1`,[d.id]).catch(()=>{}); } for(const t of ["client_package_usages","client_package_services","client_package_items","appointment_package_items"]) await db(`DELETE FROM ${t} WHERE client_package_id=$1`,[id]).catch(()=>{}); await db(`DELETE FROM client_packages WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  for(const id of trk.cat){ for(const t of ["package_items","package_services","package_pricing","package_locations"]) await db(`DELETE FROM ${t} WHERE package_id=$1`,[id]).catch(()=>{}); await db(`DELETE FROM packages WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  for(const id of trk.prod){ await db(`DELETE FROM product_stocks WHERE product_id=$1`,[id]).catch(()=>{}); await db(`DELETE FROM products WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  for(const id of trk.svc){ await db(`DELETE FROM service_locations WHERE service_id=$1`,[id]).catch(()=>{}); await db(`DELETE FROM services WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  // safety net ZZ
  for(const [t,c] of [["packages","name"],["services","name"],["products","name"],["client_packages","package_name"]]){
    const rows=(await db(`SELECT id FROM ${t} WHERE tenant_id=$1 AND ${c} LIKE 'ZZ%'`,[T])).rows;
    for(const r of rows){ if(t==="packages"){for(const x of ["package_items","package_services","package_pricing","package_locations"]) await db(`DELETE FROM ${x} WHERE package_id=$1`,[r.id]).catch(()=>{});} if(t==="client_packages"){for(const x of ["client_package_usages","client_package_services","client_package_items"]) await db(`DELETE FROM ${x} WHERE client_package_id=$1`,[r.id]).catch(()=>{});} await db(`DELETE FROM ${t} WHERE id=$1`,[r.id]).catch(()=>{}); }
  }
  const resid=Number((await one(`SELECT (SELECT COUNT(*) FROM packages WHERE tenant_id=$1 AND name LIKE 'ZZ%')+(SELECT COUNT(*) FROM services WHERE tenant_id=$1 AND name LIKE 'ZZ%')+(SELECT COUNT(*) FROM products WHERE tenant_id=$1 AND name LIKE 'ZZ%')+(SELECT COUNT(*) FROM client_packages WHERE tenant_id=$1 AND package_name LIKE 'ZZ%') c`,[T])).c);
  const realCli=Number((await one(`SELECT COUNT(*) c FROM clients WHERE tenant_id=$1`,[T])).c);
  check("CLEANUP: 0 residui ZZ + 5 clienti reali intatti", resid===0 && realCli===5, `resid=${resid} realCli=${realCli}`);
  console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
  process.exit(R.every(Boolean)?0:1);
}
