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
const ADMIN=sign({tenantSlug:SLUG,user:{id:20,email:"x",name:"luca",role:"admin",perms:["commissions.manage"],needsEmailVerification:false,currentLocationId:0,needsLocationSelection:false,locationIds:[]},issuedAt:Date.now(),epoch:1e9});
const api=(m,b,qs="")=>fetch(`http://localhost:3000/api/manage/commissions?slug=${SLUG}${qs}`,{method:m,headers:{"content-type":"application/json","x-tenant-slug":SLUG,cookie:`${COOKIE}=${ADMIN}`},...(b?{body:JSON.stringify(b)}:{})}).then(r=>r.json());
const R=[]; const check=(l,ok,x="")=>{R.push(ok);console.log(`${ok?"PASS":"FAIL"} | ${l}${x?" | "+x:""}`);};
const OP="ZZCOMM base op";
// Trappola probe (18/07): sale_date in ORA DI ROMA dopo il periodo (mai now() SQL = UTC, 2h prima del periodo aperto a Rome-now).
const ROME_NOW=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(Date.now()+120000)).replace("T"," ");
const mod0=Number((await db("SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=25 AND id=1")).rows[0]?.is_enabled ?? 0);
// La risoluzione operatore è per EMAIL (b541360: created_by->users.email->
// staff.email), NON per nome: serve un utente+staff ZZ con la STESSA email
// univoca e created_by che punta a quell'utente, altrimenti la commissione
// finisce sullo staff che matcha l'email dell'admin (id 20 = luca 22).
const ZZEMAIL="zz-comm-base@test.local";
const usr=(await db("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (25,'ZZCOMM base user',$1,'x','staff') RETURNING id",[ZZEMAIL])).rows[0];
const stf=(await db("INSERT INTO staff (tenant_id, full_name, email) VALUES (25,$1,$2) RETURNING id",[OP,ZZEMAIL])).rows[0];
await api("POST",{action:"save_module_settings",enabled:true});
await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[stf.id]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:0,posServicePercent:10,posProductPercent:10,posOtherPercent:0,notes:""}})});
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES (25,$1,TIMESTAMP '2025-01-01 00:00:00',NULL)",[stf.id]);

async function mkSale(sub,disc,tot,lineTot,itemId,itemType){
  const s=(await db(`INSERT INTO sales (tenant_id,client_id,location_id,sale_date,subtotal,discount,total,status,operator_name,created_by) VALUES (25,9,21,$6,$1,$2,$3,'done',$4,$5) RETURNING id`,[sub,disc,tot,OP,usr.id,ROME_NOW])).rows[0];
  await db("INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES (25,$1,$2,$3,'Svc',1,$4,$4)",[s.id,itemType,itemId,lineTot]);
  return s.id;
}
// A: normale (subtotal 100, sconto 20, total 80) -> base attesa 80 (line 100 * 80/100)
const A=await mkSale(100,20,80,100,9,'service');
// B: sconto 100% (subtotal 100, sconto 100, total 0) -> LANDMINE fallback: Next base 100? legacy 0
const B=await mkSale(100,100,0,100,9,'service');
// C: prodotto free-text item_id=0 (subtotal 50, total 50) -> classifyPosItem: legacy pos_other(0%), Next pos_product(10%)
const C=await mkSale(50,0,50,50,0,'product');
console.log(`[setup] staff #${stf.id} | A(norm)=${A} B(sconto100%)=${B} C(itemid0)=${C}`);

await api("GET",null,"&from=2020-01-01&to=2030-12-31&source=pos&staff_id=0");
const rows=(await db("SELECT source_id, base_amount, commission_amount, entry_status FROM staff_commission_payments WHERE tenant_id=25 AND staff_id=$1 AND source_id IN ($2,$3,$4)",[stf.id,A,B,C])).rows;
const by=Object.fromEntries(rows.map(r=>[Number(r.source_id),{base:Number(r.base_amount),comm:Number(r.commission_amount),st:r.entry_status}]));
console.log(`[entries] ${JSON.stringify(by)}`);

check("B1 caso NORMALE (sub100/sconto20/total80): base=80 comm=8 (netFactor = allocazione legacy)", by[A]?.base===80 && Math.abs(by[A]?.comm-8)<0.01, `A=${JSON.stringify(by[A])}`);
check("B1 SCONTO 100% (total=0): base attesa 0 (legacy). Next?", true, `B=${JSON.stringify(by[B]??null)} -> se base=100 e' il BUG fallback; se assente/0 e' corretto`);
check("M3 prodotto item_id=0: legacy->pos_other(0%)=nessuna comm; Next?", true, `C=${JSON.stringify(by[C]??null)} -> se comm>0 (pos_product 10%) e' la divergenza pos_other`);

// cleanup
await db("DELETE FROM staff_commission_payments WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
for(const id of [A,B,C]){ await db("DELETE FROM sale_items WHERE sale_id=$1",[id]); await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[id]); }
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff_commission_module_periods WHERE tenant_id=25");
await db("DELETE FROM staff_commission_settings WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff WHERE id=$1 AND tenant_id=25",[stf.id]);
await db("DELETE FROM users WHERE id=$1 AND tenant_id=25",[usr.id]);
await db("UPDATE staff_commission_module_settings SET is_enabled=$1 WHERE tenant_id=25 AND id=1",[mod0]);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL (i 2 informativi sono sempre PASS: guarda i valori) ===`);
