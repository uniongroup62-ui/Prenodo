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
const OP="ZZCOMM fix op";
const mod0=Number((await db("SELECT is_enabled FROM staff_commission_module_settings WHERE tenant_id=25 AND id=1")).rows[0]?.is_enabled ?? 0);
// Operatore risolto per EMAIL (b541360): utente+staff ZZ con email univoca +
// created_by su quell'utente (created_by=20 andrebbe su luca/22).
const ZZEMAIL="zz-comm-fixes@test.local";
const usr=(await db("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (25,'ZZCOMM fixes user',$1,'x','staff') RETURNING id",[ZZEMAIL])).rows[0];
const stf=(await db("INSERT INTO staff (tenant_id, full_name, email) VALUES (25,$1,$2) RETURNING id",[OP,ZZEMAIL])).rows[0];
await api("POST",{action:"save_module_settings",enabled:true});
await api("POST",{action:"save_commission_settings",rows_json:JSON.stringify({[stf.id]:{isEnabled:true,calculationMode:"paid_amount",appointmentPercent:0,posServicePercent:10,posProductPercent:10,posOtherPercent:0,notes:""}})});
// periodi MODULO controllati: P1[gen-giu 2025 chiuso] + P2[ago 2025 aperto]; periodo STAFF aperto da gen 2025
await db("DELETE FROM staff_commission_module_periods WHERE tenant_id=25");
await db("INSERT INTO staff_commission_module_periods (tenant_id,started_at,ended_at) VALUES (25,TIMESTAMP '2025-01-01 00:00:00',TIMESTAMP '2025-06-30 23:59:59'),(25,TIMESTAMP '2025-08-01 00:00:00',NULL)");
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("INSERT INTO staff_commission_periods (tenant_id,staff_id,started_at,ended_at) VALUES (25,$1,TIMESTAMP '2025-01-01 00:00:00',NULL)",[stf.id]);

async function mkSale(date,sub,disc,tot,itemId,itemType){
  const s=(await db(`INSERT INTO sales (tenant_id,client_id,location_id,sale_date,subtotal,discount,total,status,operator_name,created_by) VALUES (25,9,21,TIMESTAMP '${date} 12:00:00',$1,$2,$3,'done',$4,$5) RETURNING id`,[sub,disc,tot,OP,usr.id])).rows[0];
  await db("INSERT INTO sale_items (tenant_id,sale_id,item_type,item_id,item_name,qty,unit_price,line_total) VALUES (25,$1,$2,$3,'X',1,$4,$4)",[s.id,itemType,itemId, itemType==='product'?sub:sub]);
  return s.id;
}
const A=await mkSale('2025-03-15',100,20,80,9,'service');   // modulo P1 + normale -> comm base 80
const B=await mkSale('2025-07-15',100,20,80,9,'service');   // modulo GAP -> NIENTE
const C=await mkSale('2025-09-15',100,100,0,9,'service');   // modulo P2 + sconto100% -> base 0 -> NIENTE
const D=await mkSale('2025-09-15',50,0,50,0,'product');     // modulo P2 + item_id=0 -> pos_other 0% -> NIENTE
const E=await mkSale('2025-09-15',50,0,50,9,'service');     // modulo P2 + normale -> comm base 50
console.log(`[setup] staff #${stf.id} | A=${A} B=${B} C=${C} D=${D} E=${E}`);

await api("GET",null,"&from=2024-01-01&to=2030-12-31&source=pos&staff_id=0");
const rows=(await db("SELECT source_id, base_amount, commission_amount, entry_status FROM staff_commission_payments WHERE tenant_id=25 AND staff_id=$1 AND source_id IN ($2,$3,$4,$5,$6)",[stf.id,A,B,C,D,E])).rows;
const by=Object.fromEntries(rows.map(r=>[Number(r.source_id),{base:Number(r.base_amount),comm:Number(r.commission_amount),st:r.entry_status}]));
console.log(`[entries] ${JSON.stringify(by)}`);
const active=(id)=>by[id]&&by[id].st==="active";

check("A (modulo P1, normale): commissione base 80 comm 8", active(A) && by[A].base===80 && Math.abs(by[A].comm-8)<0.01, `A=${JSON.stringify(by[A]??null)}`);
check("FIX gate MODULO: B (nel GAP tra periodi modulo) -> NESSUNA commissione", !active(B), `B=${JSON.stringify(by[B]??null)}`);
check("FIX sconto 100% (total=0): C -> NESSUNA commissione (base 0)", !active(C), `C=${JSON.stringify(by[C]??null)}`);
check("FIX pos_other: D (prodotto item_id=0, 0%) -> NESSUNA commissione", !active(D), `D=${JSON.stringify(by[D]??null)}`);
check("E (modulo P2, normale): commissione base 50 comm 5", active(E) && by[E].base===50 && Math.abs(by[E].comm-5)<0.01, `E=${JSON.stringify(by[E]??null)}`);

// cleanup
await db("DELETE FROM staff_commission_payments WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
for(const id of [A,B,C,D,E]){ await db("DELETE FROM sale_items WHERE sale_id=$1",[id]); await db("DELETE FROM sales WHERE id=$1 AND tenant_id=25",[id]); }
await db("DELETE FROM staff_commission_periods WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff_commission_module_periods WHERE tenant_id=25");
await db("DELETE FROM staff_commission_settings WHERE tenant_id=25 AND staff_id=$1",[stf.id]);
await db("DELETE FROM staff WHERE id=$1 AND tenant_id=25",[stf.id]);
await db("DELETE FROM users WHERE id=$1 AND tenant_id=25",[usr.id]);
await db("UPDATE staff_commission_module_settings SET is_enabled=$1 WHERE tenant_id=25 AND id=1",[mod0]);
console.log(`\n=== ${R.filter(Boolean).length} PASS / ${R.filter(x=>!x).length} FAIL ===`);
