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
const PERMS=["fidelity.recharges","fidelity.manage","pos.manage","pos.movements","credit_movements.manage"];
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:PERMS,needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const H={"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`};
const rc=(body)=>fetch(`http://localhost:3000/api/manage/recharges?slug=${SLUG}`,{method:"POST",headers:H,body:JSON.stringify(body)}).then(r=>r.json());
const rcget=(qs)=>fetch(`http://localhost:3000/api/manage/recharges?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`}}).then(r=>r.json());
const pos=(body)=>fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}`,{method:"POST",headers:H,body:JSON.stringify(body)}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? r?.err ?? "");
const near=(a,b,t=0.02)=>Math.abs(Number(a)-Number(b))<t;
const T=25, L1=21;
const trk={cli:[],tpl:[],sale:[]};
const bal=async(cid)=>{const r=await one(`SELECT credit_balance,points FROM clients WHERE id=$1`,[cid]);return {c:Number(r.credit_balance),p:Number(r.points)};};

async function cleanup(){
  for(const id of trk.tpl){ await db(`DELETE FROM recharge_templates WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  for(const cid of trk.cli){
    const ss=(await db(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>({rows:[]}))).rows;
    for(const s of ss){ await db(`DELETE FROM sale_items WHERE sale_id=$1`,[s.id]).catch(()=>{}); await db(`DELETE FROM sale_payments WHERE sale_id=$1`,[s.id]).catch(()=>{}); await db(`DELETE FROM sales WHERE id=$1`,[s.id]).catch(()=>{}); }
    await db(`DELETE FROM recharges WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM cards WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=$2`,[T,cid]).catch(()=>{});
  }
  await db(`DELETE FROM services WHERE tenant_id=$1 AND name LIKE 'ZZRC%'`,[T]).catch(()=>{});
}

let baseSnap=null;
try {
  baseSnap=(await db(`SELECT
    (SELECT COUNT(*) FROM recharge_templates WHERE tenant_id=$1) tpl,
    (SELECT COUNT(*) FROM recharges WHERE tenant_id=$1) rech,
    (SELECT COUNT(*) FROM transactions WHERE tenant_id=$1) tx,
    (SELECT COUNT(*) FROM credit_adjustments WHERE tenant_id=$1) cadj,
    (SELECT COUNT(*) FROM point_lots WHERE tenant_id=$1) lots,
    (SELECT COUNT(*) FROM cards WHERE tenant_id=$1) cards,
    (SELECT COUNT(*) FROM clients WHERE tenant_id=$1) cli`,[T])).rows[0];
  console.log("BASELINE:",JSON.stringify(baseSnap));
  // Il ciclo ricarica+storno sul client 9 (produzione) lascia la coppia nel
  // ledger credit_adjustments: snapshot per rimuovere SOLO le righe in-run.
  var snapCadjMax=Number((await db(`SELECT COALESCE(MAX(id),0) m FROM credit_adjustments WHERE tenant_id=$1`,[T])).rows[0].m);

  const cliA=(await one(`INSERT INTO clients (tenant_id,full_name,location_id,points,credit_balance) VALUES ($1,'ZZ Recharge A',$2,0,0) RETURNING id`,[T,L1])).id; trk.cli.push(cliA);
  const cliB=(await one(`INSERT INTO clients (tenant_id,full_name,location_id,points,credit_balance) VALUES ($1,'ZZ Recharge B (no card)',$2,0,0) RETURNING id`,[T,L1])).id; trk.cli.push(cliB);
  // tessera attiva per cliA -> aderente (adhering) => idoneo punti ricarica
  await db(`INSERT INTO cards (tenant_id,code,client_id,issued_at,expires_at,status,credit) VALUES ($1,$2,$3,CURRENT_DATE,'2035-12-31','active',0)`,[T,"ZZRC"+Math.floor(Math.random()*900000+100000),cliA]);
  console.log(`ZZ setup: cliA(aderente)=${cliA} cliB(non-aderente)=${cliB}`);

  // ============ A. CONTEXT ============
  const ctx=await rcget("");
  check("A1 context: ok + templates[] + fidelityEnabled + earnStep 10 + label Punti", ctx.ok===true && Array.isArray(ctx.templates) && ctx.fidelityEnabled===true && near(ctx.earnStep,10) && ctx.label==="Punti", JSON.stringify({en:ctx.fidelityEnabled,step:ctx.earnStep,lbl:ctx.label,camp:ctx.activeCampaignName}));

  // ============ B. TEMPLATE CRUD ============
  const b1=await rc({action:"create_template", title:"ZZ Ricarica 100+20%", base_amount:"100", bonus_kind:"percent", bonus_value:"20", earn_points:"1", is_active:"1", sort_order:"5"});
  const b1row=await one(`SELECT id,title,base_amount,bonus_kind,bonus_value,earn_points,is_active,sort_order FROM recharge_templates WHERE tenant_id=$1 AND title='ZZ Ricarica 100+20%'`,[T]);
  if(b1row?.id) trk.tpl.push(Number(b1row.id));
  check("B1 create_template -> 'Modello creato.' + riga base100/percent/20/attivo", b1.message==="Modello creato." && !!b1row && near(b1row.base_amount,100) && b1row.bonus_kind==="percent" && near(b1row.bonus_value,20) && Number(b1row.earn_points)===1 && Number(b1row.is_active)===1 && Number(b1row.sort_order)===5, JSON.stringify({msg:b1.message,row:b1row}));
  // context computes bonus/total
  const b1tpl=(await rcget("")).templates.find(t=>Number(t.id)===Number(b1row.id));
  check("B1b context: bonusAmount 20 + totalAmount 120", b1tpl && near(b1tpl.bonusAmount,20) && near(b1tpl.totalAmount,120), JSON.stringify({b:b1tpl?.bonusAmount,t:b1tpl?.totalAmount}));

  check("B2 create senza titolo -> 'Inserisci un titolo per il modello.'", /Inserisci un titolo per il modello\./.test(errOf(await rc({action:"create_template", title:"  ", base_amount:"50"}))));
  check("B3 create importo 0 -> 'Inserisci un importo ricarica valido.'", /Inserisci un importo ricarica valido\./.test(errOf(await rc({action:"create_template", title:"ZZ x", base_amount:"0"}))));
  check("B4 create importo > max -> 'Importo ricarica troppo alto. Massimo 99.999.999,99.'", /Importo ricarica troppo alto\. Massimo 99\.999\.999,99\./.test(errOf(await rc({action:"create_template", title:"ZZ x", base_amount:"100000000"}))));
  check("B5 create bonus_value > max -> 'Valore bonus troppo alto. Massimo 99.999.999,99.'", /Valore bonus troppo alto\. Massimo 99\.999\.999,99\./.test(errOf(await rc({action:"create_template", title:"ZZ x", base_amount:"10", bonus_kind:"fixed", bonus_value:"100000000"}))));
  check("B6 create total > max -> 'Totale credito troppo alto. Massimo 99.999.999,99.'", /Totale credito troppo alto\. Massimo 99\.999\.999,99\./.test(errOf(await rc({action:"create_template", title:"ZZ x", base_amount:"99000000", bonus_kind:"fixed", bonus_value:"2000000"}))));

  const b7=await rc({action:"update_template", template_id:String(b1row.id), title:"ZZ Ricarica MOD", base_amount:"150", bonus_kind:"fixed", bonus_value:"30", earn_points:"1", is_active:"1"});
  const b7row=await one(`SELECT title,base_amount,bonus_kind,bonus_value FROM recharge_templates WHERE id=$1`,[b1row.id]);
  check("B7 update_template -> 'Modello aggiornato.' + base150/fixed/30", b7.message==="Modello aggiornato." && b7row.title==="ZZ Ricarica MOD" && near(b7row.base_amount,150) && b7row.bonus_kind==="fixed" && near(b7row.bonus_value,30), JSON.stringify({msg:b7.message,row:b7row}));
  check("B8 update id<=0 -> 'Modello non valido.'", /Modello non valido\./.test(errOf(await rc({action:"update_template", template_id:"0", title:"x", base_amount:"10"}))));
  check("B9 update inesistente -> 'Modello non trovato.'", /Modello non trovato\./.test(errOf(await rc({action:"update_template", template_id:"99999999", title:"x", base_amount:"10"}))));

  const b10=await rc({action:"create_template", title:"ZZ None Bonus", base_amount:"80", bonus_kind:"none", bonus_value:"50", is_active:"1"});
  const b10row=await one(`SELECT id,bonus_value,bonus_kind FROM recharge_templates WHERE tenant_id=$1 AND title='ZZ None Bonus'`,[T]);
  if(b10row?.id) trk.tpl.push(Number(b10row.id));
  check("B10 bonus_kind none -> bonus_value forzato 0", b10.message==="Modello creato." && Number(b10row.bonus_value)===0 && b10row.bonus_kind==="none", JSON.stringify(b10row));

  const b11=await rc({action:"create_template", title:"ZZ Clamp Sort", base_amount:"10", sort_order:"9999999"});
  const b11row=await one(`SELECT id,sort_order FROM recharge_templates WHERE tenant_id=$1 AND title='ZZ Clamp Sort'`,[T]);
  if(b11row?.id) trk.tpl.push(Number(b11row.id));
  check("B11 sort_order clamp a 1000000", Number(b11row.sort_order)===1000000, `so=${b11row.sort_order}`);

  const b12=await rcget(`&action=get&id=${b1row.id}`);
  check("B12 action=get prefill modello", b12.ok===true && !!b12.template && b12.template.title==="ZZ Ricarica MOD" && near(b12.template.baseAmount,150), JSON.stringify({t:b12.template?.title}));

  const b13=await rc({action:"delete_template", template_id:String(b11row.id)});
  check("B13 delete_template -> 'Modello eliminato.' + rimosso", b13.message==="Modello eliminato." && !(await one(`SELECT id FROM recharge_templates WHERE id=$1`,[b11row.id])), b13.message);
  if(b13.message==="Modello eliminato."){ const i=trk.tpl.indexOf(Number(b11row.id)); if(i>=0) trk.tpl.splice(i,1); }
  check("B14 delete id<=0 -> 'Modello non valido.'", /Modello non valido\./.test(errOf(await rc({action:"delete_template", template_id:"0"}))));
  const b15=await rc({action:"create_recharge", client_id:String(cliA), amount:"50"});
  check("B15 create_recharge -> 'Le ricariche credito si registrano dalla pagina Pagamenti.' (info)", /Le ricariche credito si registrano dalla pagina Pagamenti\./.test(String(b15.message ?? "")) && b15.type==="info", JSON.stringify({m:b15.message,t:b15.type}));

  // template attivo per il POS (base 100 + 20% bonus, earn on)
  const posTplId=Number(b1row.id); // ZZ Ricarica MOD -> base150/fixed30 now; re-set to a clean POS template
  const posTpl=(await one(`UPDATE recharge_templates SET title='ZZ POS Tpl',base_amount=100,bonus_kind='percent',bonus_value=20,earn_points=1,is_active=1 WHERE id=$1 RETURNING id`,[posTplId])).id;

  // ============ C1. POS ISSUANCE (aderente, flag ON) ============
  const a0=await bal(cliA);
  const c1=await pos({action:"checkout", client_id:String(cliA), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"recharge", refId:posTpl, baseAmount:100, bonusKind:"percent", bonusValue:20, earnPoints:true, note:"ZZ ric"}]),
    payments_json:JSON.stringify([{method:"cash", amount:100}])});
  const c1sale=await one(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]); if(c1sale?.id) trk.sale.push(Number(c1sale.id));
  const c1r=await one(`SELECT id,base_amount,bonus_kind,bonus_value,bonus_amount,total_amount,earn_points,points_earned,is_void,note FROM recharges WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  const a1=await bal(cliA);
  check("C1 POS ricarica: riga base100/bonus20/total120/earn_points1/points12", !errOf(c1) && !!c1r && near(c1r.base_amount,100) && near(c1r.bonus_amount,20) && near(c1r.total_amount,120) && Number(c1r.earn_points)===1 && Number(c1r.points_earned)===12, JSON.stringify({err:errOf(c1),r:c1r}));
  check("C1b credito +120 + punti +12 (campagna 37, base=totale)", near(a1.c-a0.c,120) && (a1.p-a0.p)===12, JSON.stringify({dC:a1.c-a0.c,dP:a1.p-a0.p}));
  const c1tx=await one(`SELECT kind,source_type,delta_points FROM transactions WHERE tenant_id=$1 AND client_id=$2 AND source_type='recharge' ORDER BY id DESC LIMIT 1`,[T,cliA]);
  const c1adj=await one(`SELECT direction,delta_amount FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("C1c ledger: transaction earn/recharge +12 + credit_adjustments credit +120", !!c1tx && c1tx.kind==="earn" && Number(c1tx.delta_points)===12 && c1adj.direction==="credit" && near(c1adj.delta_amount,120), JSON.stringify({tx:c1tx,adj:c1adj}));
  check("C1d nota ricarica legacy 'Ricarica credito: € 100,00 • bonus € 20,00 • +12 Punti • ZZ ric'", /^Ricarica credito: € 100,00 • bonus € 20,00 • \+12 Punti/.test(String(c1r.note)), c1r.note);

  // ============ C2. RECHARGE PAYMENT GUARDS ============
  const g=(extra)=>pos(Object.assign({action:"checkout", client_id:String(cliA), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"recharge", refId:posTpl, baseAmount:100, bonusKind:"percent", bonusValue:20, earnPoints:true}]),
    payments_json:JSON.stringify([{method:"cash", amount:100}])}, extra));
  check("C2a credito su ricarica -> 'Non è possibile usare il credito per pagare una ricarica'", /Non è possibile usare il credito per pagare una ricarica credito in carrello/.test(errOf(await g({payments_json:JSON.stringify([{method:"wallet",amount:50},{method:"cash",amount:50}])}))));
  check("C2b GiftCard su ricarica -> 'Non è possibile usare una GiftCard per pagare una ricarica'", /Non è possibile usare una GiftCard per pagare una ricarica credito in carrello/.test(errOf(await g({payments_json:JSON.stringify([{method:"giftcard",amount:50},{method:"cash",amount:50}])}))));
  check("C2c coupon su ricarica -> 'Coupon, buoni e promozioni non possono essere applicati'", /Coupon, buoni e promozioni non possono essere applicati a una ricarica credito/.test(errOf(await g({coupon_code:"ZZANY"}))));
  check("C2d sconto manuale su ricarica -> 'Lo sconto manuale non può essere applicato'", /Lo sconto manuale non può essere applicato a una ricarica credito/.test(errOf(await g({discount:10}))));
  check("C2e punti su ricarica -> 'I punti Fidelity non possono essere usati'", /I punti Fidelity non possono essere usati per pagare una ricarica credito/.test(errOf(await g({fidelity_points_use:10}))));
  check("C2f rate su ricarica -> 'solo con pagamento in unica soluzione'", /Le ricariche credito possono essere concluse solo con pagamento in unica soluzione/.test(errOf(await g({installment_choice:"installment", installment_plan_json:JSON.stringify({count:2, down_payment:0})}))));

  // ============ C3. flag OFF -> punti solo su base + earn_points col 0 ============
  const posTplOff=(await one(`INSERT INTO recharge_templates (tenant_id,title,base_amount,bonus_kind,bonus_value,earn_points,is_active) VALUES ($1,'ZZ POS NoFlag',100,'percent',20,0,1) RETURNING id`,[T])).id; trk.tpl.push(Number(posTplOff));
  const a2=await bal(cliA);
  const c3=await pos({action:"checkout", client_id:String(cliA), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"recharge", refId:posTplOff, baseAmount:100, bonusKind:"percent", bonusValue:20, earnPoints:false}]),
    payments_json:JSON.stringify([{method:"cash", amount:100}])});
  const c3sale=await one(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]); if(c3sale?.id) trk.sale.push(Number(c3sale.id));
  const c3r=await one(`SELECT earn_points,points_earned,total_amount FROM recharges WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  const a3=await bal(cliA);
  check("C3 flag OFF: credito +120, punti +10 (base 100/step 10), earn_points col 0", near(a3.c-a2.c,120) && (a3.p-a2.p)===10 && Number(c3r.earn_points)===0 && Number(c3r.points_earned)===10, JSON.stringify({dC:a3.c-a2.c,dP:a3.p-a2.p,r:c3r}));

  // ============ C4. NON-ADERENTE (flag ON) -> 0 punti + earn_points col 0 (IL FIX) ============
  const b0=await bal(cliB);
  const c4=await pos({action:"checkout", client_id:String(cliB), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"recharge", refId:posTpl, baseAmount:100, bonusKind:"percent", bonusValue:20, earnPoints:true}]),
    payments_json:JSON.stringify([{method:"cash", amount:100}])});
  const c4sale=await one(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliB]); if(c4sale?.id) trk.sale.push(Number(c4sale.id));
  const c4r=await one(`SELECT earn_points,points_earned FROM recharges WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliB]);
  const b1b=await bal(cliB);
  check("C4 [FIX] cliente NON aderente flag ON: credito +120, punti 0, earn_points col 0 (=legacy earnOnTotal)", near(b1b.c-b0.c,120) && (b1b.p-b0.p)===0 && Number(c4r.earn_points)===0 && Number(c4r.points_earned)===0, JSON.stringify({dC:b1b.c-b0.c,dP:b1b.p-b0.p,r:c4r}));

  // ============ C5. STORNO via annullo vendita (della C1) ============
  const a4=await bal(cliA);
  const c5=await pos({action:"cancel", sale_id:String(c1sale.id), reason:"ZZ storno test", recharge_points_storno_mode:"normal"});
  const c5r=await one(`SELECT is_void,voided_at,voided_by FROM recharges WHERE id=$1`,[c1r.id]);
  const a5=await bal(cliA);
  check("C5 annullo vendita ricarica -> is_void=1 + credito -120 + punti -12", !errOf(c5) && Number(c5r.is_void)===1 && c5r.voided_at!==null && near(a5.c-a4.c,-120) && (a5.p-a4.p)===-12, JSON.stringify({err:errOf(c5),void:c5r.is_void,dC:a5.c-a4.c,dP:a5.p-a4.p}));
  const c5tx=await one(`SELECT kind,source_type,delta_points FROM transactions WHERE tenant_id=$1 AND client_id=$2 AND source_type='recharge' AND delta_points<0 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("C5b storno punti: transaction redeem/recharge -12", !!c5tx && c5tx.kind==="redeem" && Number(c5tx.delta_points)===-12, JSON.stringify(c5tx));

  // ============ C6. STORNO NON FATTIBILE: credito già speso ============
  const c6co=await pos({action:"checkout", client_id:String(cliA), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"recharge", refId:posTpl, baseAmount:100, bonusKind:"percent", bonusValue:20, earnPoints:false}]),
    payments_json:JSON.stringify([{method:"cash", amount:100}])});
  const c6sale=await one(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]); if(c6sale?.id) trk.sale.push(Number(c6sale.id));
  // simula credito già consumato: porto il saldo cliente sotto il totale della ricarica (120)
  await db(`UPDATE clients SET credit_balance=50 WHERE id=$1 AND tenant_id=$2`,[cliA,T]);
  const c6=await pos({action:"cancel", sale_id:String(c6sale.id), reason:"ZZ storno insuff", recharge_points_storno_mode:"normal"});
  const c6r=await one(`SELECT is_void FROM recharges WHERE tenant_id=$1 AND client_id=$2 AND sale_id=$3 ORDER BY id DESC LIMIT 1`,[T,cliA,c6sale.id]);
  check("C6 storno con credito insufficiente -> 'credito insufficiente per lo storno' + ricarica NON stornata", /credito insufficiente per lo storno/.test(errOf(c6)) && Number(c6r.is_void)===0, JSON.stringify({err:errOf(c6),void:c6r?.is_void}));

  const passed=R.filter(Boolean).length;
  console.log(`\n===== ${passed}/${R.length} PASS =====`);
} catch(e){
  console.log("FATAL", e.message, e.stack);
} finally {
  await cleanup();
  if (typeof snapCadjMax === "number") await db(`DELETE FROM credit_adjustments WHERE tenant_id=$1 AND id>$2 AND (note LIKE 'Ricarica vendita #%' OR note LIKE 'Storno ricarica vendita #%')`,[T,snapCadjMax]).catch(()=>{});
  const after=(await db(`SELECT
    (SELECT COUNT(*) FROM recharge_templates WHERE tenant_id=$1) tpl,
    (SELECT COUNT(*) FROM recharges WHERE tenant_id=$1) rech,
    (SELECT COUNT(*) FROM transactions WHERE tenant_id=$1) tx,
    (SELECT COUNT(*) FROM credit_adjustments WHERE tenant_id=$1) cadj,
    (SELECT COUNT(*) FROM point_lots WHERE tenant_id=$1) lots,
    (SELECT COUNT(*) FROM cards WHERE tenant_id=$1) cards,
    (SELECT COUNT(*) FROM clients WHERE tenant_id=$1) cli`,[T])).rows[0];
  console.log("AFTER CLEANUP:",JSON.stringify(after));
  // tx 82->80: bonifica orfani autorizzata 2026-07-12 (tx 29/30 del client 11).
  // Healing 2026-07-17: confronto RELATIVO col snapshot pre-run (i conteggi assoluti driftano).
  const ok=Number(after.tpl)===Number(baseSnap.tpl) && Number(after.rech)===Number(baseSnap.rech) && Number(after.tx)===Number(baseSnap.tx) && Number(after.cadj)===Number(baseSnap.cadj) && Number(after.lots)===Number(baseSnap.lots) && Number(after.cards)===Number(baseSnap.cards) && Number(after.cli)===Number(baseSnap.cli);
  console.log(ok?`CLEANUP OK: baseline relativo ripristinato (${JSON.stringify(after)})`:"!!! CLEANUP MISMATCH — verifica manuale !!!");
}
