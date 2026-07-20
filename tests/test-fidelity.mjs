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
const PERMS=["fidelity.manage","fidelity.wallet","fidelity.recharges","fidelity.points","fidelity.membership","fidelity.levels","credit_movements.manage","pos.manage","pos.movements"];
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:PERMS,needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const H={"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`};
const fid=(body)=>fetch(`http://localhost:3000/api/manage/fidelity?slug=${SLUG}`,{method:"POST",headers:H,body:JSON.stringify(body)}).then(r=>r.json());
const fidget=(qs)=>fetch(`http://localhost:3000/api/manage/fidelity?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`}}).then(r=>r.json());
const pos=(body)=>fetch(`http://localhost:3000/api/manage/pos?slug=${SLUG}`,{method:"POST",headers:H,body:JSON.stringify(body)}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const errOf=(r)=>String(r?.error ?? r?.err ?? "");
const near=(a,b,t=0.02)=>Math.abs(Number(a)-Number(b))<t;
const T=25, L1=21;
const trk={cli:[],camp:[],cards:[],codes:[],sale:[]};

// ---- baseline settings (from fid-baseline.json) for guaranteed restore ----
const BASE=JSON.parse(readFileSync(new URL("./fid-baseline.json", import.meta.url),"utf8"));
async function restoreSettings(){
  const s=BASE.settings; const cols=Object.keys(s);
  const sets=cols.map((c,i)=>`${c}=$${i+2}`).join(", ");
  const vals=cols.map(c=>s[c]);
  await db(`UPDATE businesses SET ${sets} WHERE tenant_id=$1`,[T,...vals]).catch(e=>console.log("restore err",e.message));
}

async function cleanup(){
  // ZZ campaigns
  for(const id of trk.camp){ await db(`DELETE FROM fidelity_campaigns WHERE id=$1 AND tenant_id=$2`,[id,T]).catch(()=>{}); }
  // ZZ clients: wipe all child fidelity data then the client
  for(const cid of trk.cli){
    await db(`DELETE FROM transactions WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM point_lots WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    await db(`DELETE FROM cards WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>{});
    // sales + sale_items for this ZZ client
    const ss=(await db(`SELECT id FROM sales WHERE tenant_id=$1 AND client_id=$2`,[T,cid]).catch(()=>({rows:[]}))).rows;
    for(const s of ss){ await db(`DELETE FROM sale_items WHERE sale_id=$1`,[s.id]).catch(()=>{}); await db(`DELETE FROM sale_payments WHERE sale_id=$1`,[s.id]).catch(()=>{}); await db(`DELETE FROM sales WHERE id=$1`,[s.id]).catch(()=>{}); }
    await db(`DELETE FROM clients WHERE tenant_id=$1 AND id=$2`,[T,cid]).catch(()=>{});
  }
  // ZZ card codes from the permanent registry (only MY test codes)
  for(const code of trk.codes){ await db(`DELETE FROM card_code_registry WHERE tenant_id=$1 AND code=$2`,[T,code]).catch(()=>{}); }
  // ZZ services
  await db(`DELETE FROM services WHERE tenant_id=$1 AND name LIKE 'ZZFID%'`,[T]).catch(()=>{});
  // settings back to exact baseline
  await restoreSettings();
}

let baseSnap=null;
try {
  // ============ SETUP ============
  const base=(await db(`SELECT
     (SELECT COUNT(*) FROM transactions WHERE tenant_id=$1) tx,
     (SELECT COUNT(*) FROM point_lots WHERE tenant_id=$1) lots,
     (SELECT COUNT(*) FROM credit_adjustments WHERE tenant_id=$1) cadj,
     (SELECT COUNT(*) FROM fidelity_campaigns WHERE tenant_id=$1) camp,
     (SELECT COUNT(*) FROM cards WHERE tenant_id=$1) cards,
     (SELECT COUNT(*) FROM card_code_registry WHERE tenant_id=$1) ccr,
     (SELECT COUNT(*) FROM clients WHERE tenant_id=$1) cli`,[T])).rows[0];
  console.log("BASELINE live:",JSON.stringify(base)); baseSnap=base;
  const camp37=await one(`SELECT id,name,active,earn_mode,earn_step_euro,ends_at FROM fidelity_campaigns WHERE tenant_id=$1 AND id=37`,[T]);
  console.log("campagna produzione 37:",JSON.stringify(camp37));

  const svc80=(await one(`INSERT INTO services (tenant_id,name,price,is_active) VALUES ($1,'ZZFIDSvc80',80,1) RETURNING id`,[T])).id;
  const cliA=(await one(`INSERT INTO clients (tenant_id,full_name,location_id,points,credit_balance) VALUES ($1,'ZZ Fidelity A',$2,0,0) RETURNING id`,[T,L1])).id; trk.cli.push(cliA);
  const cliB=(await one(`INSERT INTO clients (tenant_id,full_name,location_id,points,credit_balance) VALUES ($1,'ZZ Fidelity B (no card)',$2,0,0) RETURNING id`,[T,L1])).id; trk.cli.push(cliB);
  console.log(`ZZ setup: svc80=${svc80} cliA=${cliA} cliB=${cliB}`);

  // ============ A. READ ENDPOINTS ============
  const st=await fidget(`&action=state`);
  check("A1 state: enabled=true + impact object", st.ok===true && st.enabled===true && !!st.impact && Array.isArray(st.impact.blockingPromotions), JSON.stringify({en:st.enabled}));
  const psr=await fidget(`&action=points_settings`);
  check("A2 points_settings: settings + stats", psr.ok===true && !!psr.settings && psr.settings.globalEnabled===true && psr.settings.pointsEnabled===true && !!psr.stats, JSON.stringify({epp:psr.settings?.euroPerPoint,step:psr.settings?.earnStepEuro}));
  check("A2b redeemEuroPerPoint=0.10 + earnStep=10 + redeem on", near(psr.settings.redeemEuroPerPoint,0.10) && near(psr.settings.earnStepEuro,10) && psr.settings.redeemEnabled===true, JSON.stringify({epp:psr.settings?.redeemEuroPerPoint}));
  const cl=await fidget(`&action=campaigns`);
  check("A3 campaigns: lista contiene 37", cl.ok===true && Array.isArray(cl.campaigns) && cl.campaigns.some(c=>Number(c.id)===37));
  const lv=await fidget(`&action=levels`);
  check("A4 levels: editor data (levels[] + baseKey)", lv.ok===true && !!lv.levels && Array.isArray(lv.levels.levels) && typeof lv.levels.baseKey==="string");
  const mb=await fidget(`&action=membership`);
  check("A5 membership: rows array + canFidelityManage", mb.ok===true && !!mb.membership, JSON.stringify({total:mb.membership?.total}));
  const cs=await fidget(`&action=client_search&q=ZZ%20Fidelity%20A`);
  check("A6 client_search trova cliente ZZ A", cs.ok===true && Array.isArray(cs.clients) && cs.clients.some(c=>Number(c.id)===cliA));
  const wl=await fidget(`&action=wallet&client_id=${cliA}`);
  check("A7 wallet cliente ZZ A: pointsBalance 0 + non aderente", wl.ok===true && !!wl.wallet?.detail && Number(wl.wallet.detail.pointsBalance)===0 && wl.wallet.detail.adhering===false, JSON.stringify({adh:wl.wallet?.detail?.adhering,pts:wl.wallet?.detail?.pointsBalance}));
  const cr=await fidget(`&action=credit&client_id=${cliA}`);
  check("A8 credit ledger cliente ZZ A", cr.ok===true && !!cr.credit && Array.isArray(cr.credit.movements));

  // ============ B. SETTINGS SAVE + VALIDATION + RESTORE ============
  const b1=await fid({action:"save_points_settings", fidelity_points_enabled:"1", fidelity_expire_enabled:"1", fidelity_expire_days:"0"});
  check("B1 save settings expire senza giorni -> errore 'maggiore di 0'", /Per abilitare la scadenza punti inserisci un valore maggiore di 0/.test(errOf(b1)), errOf(b1));
  // valid save: change euro_per_point 0.10 -> 0.15 (no confirm needed), keep rest = baseline
  const b2=await fid({action:"save_points_settings", fidelity_points_enabled:"1", fidelity_redeem_enabled:"1", fidelity_redeem_euro_per_point:"0.15", fidelity_redeem_min_points:"0", fidelity_expire_enabled:"1", fidelity_expire_days:"365", fidelity_expire_warn_days:"30", fidelity_earn_step_euro:"10", fidelity_expiry_confirmed:"1"});
  const eppDb=Number((await one(`SELECT fidelity_redeem_euro_per_point FROM businesses WHERE tenant_id=$1`,[T])).fidelity_redeem_euro_per_point);
  check("B2 save settings valido euro_per_point 0.15 persistito", b2.ok===true && near(eppDb,0.15), JSON.stringify({ok:b2.ok,epp:eppDb,err:errOf(b2)}));
  await restoreSettings();
  const eppBack=Number((await one(`SELECT fidelity_redeem_euro_per_point FROM businesses WHERE tenant_id=$1`,[T])).fidelity_redeem_euro_per_point);
  check("B3 restore -> euro_per_point torna 0.10", near(eppBack,0.10), `epp=${eppBack}`);

  // ============ C. LEVELS VALIDATION (nessun persist) ============
  // NB: la base (0 punti) viene aggiunta automaticamente da ensureBasePointsLevel;
  // due livelli NON-base agli stessi punti (100) devono scatenare la guardia duplicati.
  const c1=await fid({action:"save_levels", fidelity_levels_enabled:"1", fidelity_levels_points_enabled:"1",
    levels_json:JSON.stringify([{key:"zza",name:"ZZ Uno",minPoints:100},{key:"zzb",name:"ZZ Due",minPoints:100}])});
  check("C1 save_levels 2 livelli stessi punti -> errore 'due livelli card con gli stessi punti'", /Non puoi salvare due livelli card con gli stessi punti necessari/.test(errOf(c1)), errOf(c1));
  const lvlEnabledDb=Number((await one(`SELECT fidelity_levels_enabled FROM businesses WHERE tenant_id=$1`,[T])).fidelity_levels_enabled);
  check("C2 validazione fallita -> levels_enabled resta 0 (nessun persist)", lvlEnabledDb===0, `enabled=${lvlEnabledDb}`);

  // ============ D. CAMPAIGN CRUD (ZZ) ============
  // D1 create inactive ZZ campaign (evita overlap con 37)
  const d1=await fid({action:"campaign_save", name:"ZZ Camp Inattiva", active:"0", earn_mode:"amount", earn_step_euro:"5", starts_at:"2027-01-01", ends_at:"2027-12-31", min_spend:"0"});
  const zzCamp=d1.campaign; if(zzCamp?.id) trk.camp.push(Number(zzCamp.id));
  check("D1 campaign_save inattiva -> creata active=0 step 5", d1.ok===true && !!zzCamp && zzCamp.active===false && near(zzCamp.earnStepEuro,5), JSON.stringify({id:zzCamp?.id,act:zzCamp?.active,err:errOf(d1)}));
  // D2 tiers senza scaglioni
  const d2=await fid({action:"campaign_save", name:"ZZ Camp Tiers", active:"0", earn_mode:"tiers", tiers_json:JSON.stringify([])});
  check("D2 campaign_save tiers senza scaglioni -> 'Aggiungi almeno uno scaglione'", /Aggiungi almeno uno scaglione punti valido/.test(errOf(d2)), errOf(d2));
  // D3 end < start
  const d3=await fid({action:"campaign_save", name:"ZZ Camp Date", active:"0", earn_mode:"amount", starts_at:"2027-06-01", ends_at:"2027-01-01"});
  check("D3 campaign_save fine<inizio -> 'data di scadenza non puo essere precedente'", /La data di scadenza non puo essere precedente alla data di attivazione/.test(errOf(d3)), errOf(d3));
  // D4 toggle ZZ -> active : overlaps open-ended active 37
  const d4=await fid({action:"campaign_toggle", id:String(zzCamp.id), active:"1"});
  check("D4 campaign_toggle attiva (overlap con 37 aperta) -> 'Esiste gia una campagna punti attiva'", /Esiste gia una campagna punti attiva nello stesso periodo/.test(errOf(d4)), errOf(d4));
  const d4db=Number((await one(`SELECT active FROM fidelity_campaigns WHERE id=$1`,[zzCamp.id])).active);
  check("D4b overlap rifiutato -> ZZ campagna resta inattiva", d4db===0, `active=${d4db}`);
  // D5 save directly active overlapping -> same guard
  const d5=await fid({action:"campaign_save", id:String(zzCamp.id), name:"ZZ Camp Inattiva", active:"1", earn_mode:"amount", starts_at:"", ends_never:"1"});
  check("D5 campaign_save active aperta (overlap 37) -> overlap", /Esiste gia una campagna punti attiva nello stesso periodo/.test(errOf(d5)), errOf(d5));
  // D6 delete ZZ (0 refs) -> hard
  const d6=await fid({action:"campaign_delete", id:String(zzCamp.id)});
  const d6exists=await one(`SELECT id FROM fidelity_campaigns WHERE id=$1`,[zzCamp.id]);
  check("D6 campaign_delete (0 refs) -> hard delete", d6.ok===true && d6.mode==="hard" && !d6exists, JSON.stringify({mode:d6.mode}));
  if(d6.ok && d6.mode==="hard"){ const i=trk.camp.indexOf(Number(zzCamp.id)); if(i>=0) trk.camp.splice(i,1); }
  // D7 campaign 37 intatta
  const c37=await one(`SELECT active,earn_mode,ends_at FROM fidelity_campaigns WHERE id=37`,[]);
  check("D7 campagna produzione 37 INTATTA (active=1 amount aperta)", Number(c37.active)===1 && c37.earn_mode==="amount" && c37.ends_at===null, JSON.stringify(c37));

  // ============ E. CARDS CRUD (ZZ) ============
  const e1=await fid({action:"card_create", client_id:String(cliA)});
  const cardA=Number(e1.cardId||0); if(cardA) trk.cards.push(cardA); if(e1.code) trk.codes.push(String(e1.code));
  check("E1 card_create cliente ZZ A -> ok + code + cardId", e1.ok===true && cardA>0 && !!e1.code, JSON.stringify({code:e1.code,id:cardA,err:errOf(e1)}));
  const adh=(await fidget(`&action=wallet&client_id=${cliA}`)).wallet?.detail;
  check("E1b dopo tessera -> cliente ADERENTE", adh?.adhering===true, `adh=${adh?.adhering}`);
  const e2=await fid({action:"card_create", client_id:String(cliA)});
  check("E2 card_create doppione -> 'Questo cliente ha gia una tessera'", /Questo cliente ha gi.* una tessera/.test(errOf(e2)), errOf(e2));
  const e3=await fid({action:"card_create", client_id:String(cliB), code:String(e1.code)});
  check("E3 card_create con codice gia usato -> 'gia utilizzato in passato'", /Codice tessera gi.* utilizzato in passato/.test(errOf(e3)), errOf(e3));
  const e5=await fid({action:"card_reactivate", card_id:String(cardA)});
  check("E5 card_reactivate tessera non scaduta -> 'La tessera non e scaduta'", /La tessera non . scaduta/.test(errOf(e5)), errOf(e5));

  // ============ F. WALLET MANUAL MOVE (ZZ A aderente) ============
  const f1=await fid({action:"wallet_move", client_id:String(cliA), op:"add", points:"50", note:"ZZ add"});
  const f1pts=Number((await one(`SELECT points FROM clients WHERE id=$1`,[cliA])).points);
  const f1tx=await one(`SELECT kind,source_type,delta_points FROM transactions WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("F1 wallet_move add 50 -> points 50 + tx manual +50", f1.ok===true && f1pts===50 && f1tx.kind==="manual" && f1tx.source_type==="manual" && Number(f1tx.delta_points)===50, JSON.stringify({ok:f1.ok,pts:f1pts,tx:f1tx,err:errOf(f1)}));
  const f1lot=await one(`SELECT COUNT(*) c FROM point_lots WHERE tenant_id=$1 AND client_id=$2`,[T,cliA]);
  check("F1b point_lot creato per l'accumulo", Number(f1lot.c)>=1, `lots=${f1lot.c}`);
  const f2=await fid({action:"wallet_move", client_id:String(cliA), op:"remove", points:"20", note:"ZZ rem"});
  const f2pts=Number((await one(`SELECT points FROM clients WHERE id=$1`,[cliA])).points);
  const f2tx=await one(`SELECT kind,delta_points FROM transactions WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("F2 wallet_move remove 20 -> points 30 + tx adjust -20", f2.ok===true && f2pts===30 && f2tx.kind==="adjust" && Number(f2tx.delta_points)===-20, JSON.stringify({ok:f2.ok,pts:f2pts,tx:f2tx}));
  // F3 faithful: remove 999 con solo 30 disponibili -> rimuove i 30 disponibili (ok),
  // segnala i 969 mancanti nel messaggio (comportamento legacy manual_move_points).
  const f3=await fid({action:"wallet_move", client_id:String(cliA), op:"remove", points:"999", note:"ZZ over"});
  const f3pts=Number((await one(`SELECT points FROM clients WHERE id=$1`,[cliA])).points);
  check("F3 wallet_move remove 999 (disp 30) -> rimozione PARZIALE 30, punti 0, missing segnalato", f3.ok===true && f3pts===0 && Number(f3.removed)===30 && Number(f3.missing)===969, JSON.stringify({ok:f3.ok,pts:f3pts,removed:f3.removed,missing:f3.missing}));
  // F3b: ora saldo 0 -> rimozione ulteriore lancia l'errore vero "disponibili 0"
  const f3b=await fid({action:"wallet_move", client_id:String(cliA), op:"remove", points:"10", note:"ZZ zero-bal"});
  check("F3b wallet_move remove con saldo 0 -> 'saldo insufficiente (disponibili 0)'", /saldo insufficiente \(disponibili 0\)/.test(errOf(f3b)), errOf(f3b));
  const f4=await fid({action:"wallet_move", client_id:String(cliA), op:"add", points:"0", note:"ZZ zero"});
  check("F4 wallet_move add 0 -> 'Inserisci un numero intero di punti valido'", /Inserisci un numero intero di punti valido/.test(errOf(f4)), errOf(f4));
  const f5=await fid({action:"wallet_move", client_id:String(cliB), op:"add", points:"10", note:"ZZ noadh"});
  check("F5 wallet_move cliente senza tessera -> 'Cliente non aderisce alla Fidelity'", /Cliente non aderisce alla Fidelity/.test(errOf(f5)), errOf(f5));

  // ============ G. CREDIT DEBIT (ZZ A) ============
  await db(`UPDATE clients SET credit_balance=100 WHERE id=$1 AND tenant_id=$2`,[cliA,T]);
  const g1=await fid({action:"credit_debit", client_id:String(cliA), amount:"30", note:"ZZ scalo test"});
  const g1bal=Number((await one(`SELECT credit_balance FROM clients WHERE id=$1`,[cliA])).credit_balance);
  const g1adj=await one(`SELECT direction,amount,delta_amount,balance_after,note FROM credit_adjustments WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("G1 credit_debit 30 -> saldo 70 + credit_adjustments debit -30", g1.ok===true && near(g1bal,70) && g1adj.direction==="debit" && near(g1adj.amount,30) && near(g1adj.delta_amount,-30) && near(g1adj.balance_after,70), JSON.stringify({ok:g1.ok,bal:g1bal,adj:g1adj,err:errOf(g1)}));
  const g2=await fid({action:"credit_debit", client_id:String(cliA), amount:"10", note:""});
  check("G2 credit_debit senza nota -> 'Inserisci una nota per motivare lo scalo manuale'", /Inserisci una nota per motivare lo scalo manuale/.test(errOf(g2)), errOf(g2));
  const g3=await fid({action:"credit_debit", client_id:String(cliA), amount:"999", note:"ZZ over"});
  check("G3 credit_debit > saldo -> 'Credito insufficiente'", /Credito insufficiente/.test(errOf(g3)), errOf(g3));
  const g4=await fid({action:"credit_debit", client_id:String(cliA), amount:"0", note:"ZZ zero"});
  check("G4 credit_debit importo 0 -> 'Inserisci un importo valido'", /Inserisci un importo valido/.test(errOf(g4)), errOf(g4));

  // ============ H. POS EARN (ZZ A aderente, campagna 37 amount step 10) ============
  const ptsBefore=Number((await one(`SELECT points FROM clients WHERE id=$1`,[cliA])).points);
  const co=await pos({action:"checkout", client_id:String(cliA), location_id:String(L1), installment_choice:"single",
    items_json:JSON.stringify([{type:"service", refId:svc80, name:"ZZFIDSvc80", quantity:1, unitPrice:80}]),
    payments_json:JSON.stringify([{method:"cash", amount:80}])});
  const hSale=await one(`SELECT id,fidelity_points_earned,fidelity_campaign_id FROM sales WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 1`,[T,cliA]);
  if(hSale?.id) trk.sale.push(Number(hSale.id));
  const ptsAfter=Number((await one(`SELECT points FROM clients WHERE id=$1`,[cliA])).points);
  const hTx=await one(`SELECT kind,source_type,source_id,delta_points FROM transactions WHERE tenant_id=$1 AND client_id=$2 AND source_type='sale' ORDER BY id DESC LIMIT 1`,[T,cliA]);
  check("H1 checkout 80€ servizio -> earn 8 punti (floor 80/10) su vendita", !errOf(co) && Number(hSale?.fidelity_points_earned)===8 && (ptsAfter-ptsBefore)===8, JSON.stringify({err:errOf(co),earned:hSale?.fidelity_points_earned,delta:ptsAfter-ptsBefore}));
  check("H1b transaction earn source=sale delta +8 + campagna 37 stampata", !!hTx && hTx.kind==="earn" && hTx.source_type==="sale" && Number(hTx.delta_points)===8 && Number(hSale?.fidelity_campaign_id)===37, JSON.stringify({tx:hTx,camp:hSale?.fidelity_campaign_id}));

  // ============ I. CARD DELETE reset fidelity (ZZ A) ============
  const i1=await fid({action:"card_delete", card_id:String(cardA)});
  const i1cli=await one(`SELECT points,fidelity_level FROM clients WHERE id=$1`,[cliA]);
  const i1tx=Number((await one(`SELECT COUNT(*) c FROM transactions WHERE tenant_id=$1 AND client_id=$2`,[T,cliA])).c);
  const i1lots=Number((await one(`SELECT COUNT(*) c FROM point_lots WHERE tenant_id=$1 AND client_id=$2`,[T,cliA])).c);
  const i1card=await one(`SELECT id FROM cards WHERE id=$1`,[cardA]);
  const i1ccr=await one(`SELECT id,note FROM card_code_registry WHERE tenant_id=$1 AND code=$2`,[T,e1.code]);
  check("I1 card_delete -> points 0 + level '' + tx/lots azzerati + card rimossa", i1.ok===true && Number(i1cli.points)===0 && String(i1cli.fidelity_level)==="" && i1tx===0 && i1lots===0 && !i1card, JSON.stringify({ok:i1.ok,pts:i1cli.points,lvl:i1cli.fidelity_level,tx:i1tx,lots:i1lots}));
  check("I1b codice tessera resta PERMANENTE nel registry (anti-riuso)", !!i1ccr, JSON.stringify({ccr:i1ccr?.id}));
  if(cardA){ const j=trk.cards.indexOf(cardA); if(j>=0) trk.cards.splice(j,1); }

  // ============ SUMMARY ============
  const passed=R.filter(Boolean).length;
  console.log(`\n===== ${passed}/${R.length} PASS =====`);
} catch(e){
  console.log("FATAL", e.message, e.stack);
} finally {
  await cleanup();
  // verify baseline restoration
  const after=(await db(`SELECT
     (SELECT COUNT(*) FROM transactions WHERE tenant_id=$1) tx,
     (SELECT COUNT(*) FROM point_lots WHERE tenant_id=$1) lots,
     (SELECT COUNT(*) FROM credit_adjustments WHERE tenant_id=$1) cadj,
     (SELECT COUNT(*) FROM fidelity_campaigns WHERE tenant_id=$1) camp,
     (SELECT COUNT(*) FROM cards WHERE tenant_id=$1) cards,
     (SELECT COUNT(*) FROM card_code_registry WHERE tenant_id=$1) ccr,
     (SELECT COUNT(*) FROM clients WHERE tenant_id=$1) cli`,[T])).rows[0];
  console.log("AFTER CLEANUP:",JSON.stringify(after));
  // Healing 2026-07-17: confronto RELATIVO col snapshot pre-run (i conteggi
  // assoluti driftano legittimamente: bonifica orfani 12/07, lots dei clienti
  // reali, registry anti-riuso che cresce by-design). Unica eccezione: ccr
  // cresce di +N per le tessere emesse nel run (codici PERMANENTI by design).
  const baseLive = baseSnap;
  const ok = baseLive
    ? Number(after.tx) === Number(baseLive.tx) && Number(after.lots) === Number(baseLive.lots) && Number(after.cadj) === Number(baseLive.cadj) && Number(after.camp) === Number(baseLive.camp) && Number(after.cli) === Number(baseLive.cli) && Number(after.cards) === Number(baseLive.cards) && Number(after.ccr) >= Number(baseLive.ccr)
    : false;
  console.log(ok ? `CLEANUP OK: baseline relativo ripristinato (tx${after.tx}/lots${after.lots}/cadj${after.cadj}/camp${after.camp}/cli${after.cli}; ccr ${baseLive?.ccr}->${after.ccr} permanente by-design)` : "!!! CLEANUP MISMATCH — verifica manuale !!!");
  const s=(await db(`SELECT fidelity_redeem_euro_per_point epp, fidelity_levels_enabled lvl, fidelity_enabled en, fidelity_points_enabled pts FROM businesses WHERE tenant_id=$1`,[T])).rows[0];
  console.log("SETTINGS after:",JSON.stringify(s), (Number(s.epp)===0.1 && Number(s.lvl)===0 && Number(s.en)===1 && Number(s.pts)===1)?"OK":"!!! SETTINGS MISMATCH !!!");
}
