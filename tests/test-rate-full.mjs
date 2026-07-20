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
// Sede 21 (fix 18/07: sede 0 in tenant multi-sede = route FAIL-CLOSED; le
// vendite del seed sono a location NULL = visibili con lo scope NULL-permissivo).
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:["installments.manage"],needsEmailVerification:false,currentLocationId:21,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const get=(qs)=>fetch(`http://localhost:3000/api/manage/installments?slug=${SLUG}${qs}`,{headers:{"x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`}}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const has=(g,id)=>(g.plans||[]).some(p=>p.id===id);
const find=(g,id)=>(g.plans||[]).find(p=>p.id===id);

const yest=(await db("SELECT to_char(now()-interval '1 day','YYYY-MM-DD') d")).rows[0].d;
const fut=(await db("SELECT to_char(now()+interval '40 days','YYYY-MM-DD') d")).rows[0].d;
async function mkPlan(status, mkInst){
  const s=(await db(`INSERT INTO sales (tenant_id,client_id,location_id,sale_date,subtotal,discount,total,status,operator_name,created_by) VALUES (25,9,NULL,now(),300,0,300,'done','test-ratefull',20) RETURNING id`)).rows[0];
  const p=(await db(`INSERT INTO sale_installment_plans (tenant_id,sale_id,client_id,payment_type,status,sale_total,down_payment_amount,financed_amount,installments_count,interval_value,interval_unit,first_due_date,last_due_date,created_by,updated_by) VALUES (25,$1,9,'card',$2,300,100,200,2,1,'month',$3,$4,20,20) RETURNING id`,[s.id,status,yest,fut])).rows[0];
  await mkInst(p.id,s.id);
  return {saleId:s.id,planId:p.id};
}
const ins=(pid,sid,no,due,st)=>db(`INSERT INTO sale_installments (tenant_id,plan_id,sale_id,client_id,installment_no,due_date,amount,status,payment_type,paid_at,created_by,updated_by) VALUES (25,$1,$2,9,$3,$4,100,$5,'card',${st==='paid'?'now()':'NULL'},20,20)`,[pid,sid,no,due,st]);
// A = ATTIVO/SCADUTO (1 rata scaduta pending + 1 futura pending); B = COMPLETATO (2 paid); C = ANNULLATO
const A=await mkPlan('active',(pid,sid)=>Promise.all([ins(pid,sid,1,yest,'pending'),ins(pid,sid,2,fut,'pending')]));
const B=await mkPlan('completed',(pid,sid)=>Promise.all([ins(pid,sid,1,yest,'paid'),ins(pid,sid,2,fut,'paid')]));
const C=await mkPlan('cancelled',(pid,sid)=>Promise.all([ins(pid,sid,1,yest,'cancelled'),ins(pid,sid,2,fut,'cancelled')]));
console.log(`[setup] A(scaduto)=${A.planId} B(completato)=${B.planId} C(annullato)=${C.planId}`);

// --- FILTRI STATO ---
const all=await get("&status=all");
check("status=all: A,B,C tutti presenti", has(all,A.planId)&&has(all,B.planId)&&has(all,C.planId));
const open=await get("&status=open");
check("status=open (Aperte): A si, B(completato)/C(annullato) no", has(open,A.planId)&&!has(open,B.planId)&&!has(open,C.planId));
const overdue=await get("&status=overdue");
check("status=overdue (Scadute): A si (overdueCount>0), B/C no", has(overdue,A.planId)&&!has(overdue,B.planId)&&!has(overdue,C.planId));
const paid=await get("&status=paid");
check("status=paid (Completate): B si, A/C no", has(paid,B.planId)&&!has(paid,A.planId)&&!has(paid,C.planId));
const canc=await get("&status=cancelled");
check("status=cancelled (Annullate): C si, A/B no", has(canc,C.planId)&&!has(canc,A.planId)&&!has(canc,B.planId));

// --- FILTRO DATE (il bug appena sistemato) ---
const dOk=await get(`&status=all&due_from=${fut}&due_to=${fut}`);
check("FIX filtro date: due_from/due_to sulla rata futura di A -> A presente (prima ERRORE SQL)", has(dOk,A.planId)&&has(dOk,B.planId), `err=${dOk.error||""} n=${(dOk.plans||[]).length}`);
const dEmpty=await get("&status=all&due_from=2020-01-01&due_to=2020-12-31");
check("filtro date: range 2020 senza rate -> nessun piano (no errore)", (dEmpty.ok!==false) && !has(dEmpty,A.planId)&&!has(dEmpty,B.planId)&&!has(dEmpty,C.planId), `ok=${dEmpty.ok} n=${(dEmpty.plans||[]).length}`);

// --- FILTRI cliente/vendita/ricerca ---
const byClient=await get("&status=all&client_id=9");
check("filtro client_id=9: A,B,C presenti", has(byClient,A.planId)&&has(byClient,B.planId));
const bySale=await get(`&status=all&sale_id=${A.saleId}`);
check("filtro sale_id: solo A", has(bySale,A.planId)&&!has(bySale,B.planId));
const byQ=await get(`&status=all&q=${A.saleId}`);
check("ricerca q=sale_id: A presente", has(byQ,A.planId));

// --- CAMPI/STATI dei piani ---
const pa=find(all,A.planId), pb=find(all,B.planId), pc=find(all,C.planId);
check("A: statusLabel 'Scaduto', overdueCount 1, paymentType chiave 'card', intervalLabel", pa?.statusLabel==="Scaduto"&&Number(pa?.overdueCount)===1&&pa?.paymentType==="card"&&/mese/.test(pa?.intervalLabel||""), `${pa?.statusLabel}/${pa?.overdueCount}/${pa?.paymentType}/${pa?.intervalLabel}`);
check("A: rata1 'Scaduta' + rata2 'Da incassare' (installmentStatusMeta)", (pa?.installments||[]).find(i=>i.installmentNo===1)?.statusLabel==="Scaduta"&&(pa?.installments||[]).find(i=>i.installmentNo===2)?.statusLabel==="Da incassare");
check("B: statusLabel 'Completato', remaining 0, paidCount 2", pb?.statusLabel==="Completato"&&Number(pb?.remaining)<0.01&&Number(pb?.paidCount)===2, `${pb?.statusLabel}/${pb?.remaining}/${pb?.paidCount}`);
check("C: statusLabel 'Annullato'", pc?.statusLabel==="Annullato", `${pc?.statusLabel}`);

// cleanup
for(const x of [A,B,C]){ await db("DELETE FROM sale_installments WHERE plan_id=$1",[x.planId]); await db("DELETE FROM sale_installment_plans WHERE id=$1",[x.planId]); await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[x.saleId]); }
const left=Number((await db("SELECT COUNT(*) c FROM sales WHERE tenant_id=25 AND operator_name='test-ratefull'")).rows[0].c);
check("cleanup: piani/rate/vendite test rimossi", left===0);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
