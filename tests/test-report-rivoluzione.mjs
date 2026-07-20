// Report "rivoluzione" (2026-07-20) — nuove sezioni backend:
// R1-R3 nuovi vs di ritorno (nuovo = prima vendita ASSOLUTA nel periodo,
//        scope sede sulla finestra, prima-vendita tenant-wide);
// R4-R6 breakdown per sede (SOLO con all_locations; venduto NETTO + vendite
//        + prenotazioni attive; nomi decorati dalla route);
// R7-R8 fidelityPeriod (punti earn/redeem, ricariche non-void per base,
//        giftcard emesse non-cancellate, utilizzi credito/giftcard in vendita);
// R9    locationsCount esposto per lo switch "Tutte le sedi".
// Finestra isolata 2027-04. Fixture ZZ per id, cleanup tracciato.
import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const pgmod = require("pg");
const { chromium } = require("playwright");
const DBURL = (fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^PRENODO_DATABASE_URL=(.+)$/m) || [])[1].trim();
const BASE = "http://localhost:3000", SLUG = "centroesteticoelite", T = 25;
const SECRET = "dev-only-change-me-7f3a9c2e8b1d4056a1c9e7b5d3f20846";
function makeCookie(role, perms, locationIds, current = 21) {
  const p64 = Buffer.from(JSON.stringify({ tenantSlug: SLUG, user: { id: 20, email: "info@artebrand.it", name: "luca", role, perms, needsEmailVerification: false, currentLocationId: current, needsLocationSelection: false, locationIds }, issuedAt: Date.now(), epoch: 1e9 })).toString("base64url");
  return `beautysuite_session_t_${SLUG}=${p64}.${crypto.createHmac("sha256", SECRET).update(p64).digest("base64url")}`;
}
const adminCookie = makeCookie("admin", ["reports.view"], []);
const pool = new pgmod.Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 2 });
async function q(sql, p) { for (let i = 0; i < 8; i++) { try { return await pool.query(sql, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 1200)); } } }
async function report(params, cookie = adminCookie) {
  const res = await fetch(`${BASE}/api/manage/reports?slug=${SLUG}${params}`, { headers: { cookie, "x-tenant-slug": SLUG } });
  let j = {}; try { j = await res.json(); } catch {}
  return { status: res.status, j };
}
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
const W = "&from=2027-04-01&to=2027-04-30"; // finestra remota isolata

const ids = { sales: [], clients: [], appts: [], tx: [], rech: [], gc: [], cards: [] };
let browser = null;
try {
  // --- Fixtures -----------------------------------------------------------
  const mkClient = async (name) => {
    const r = await q("INSERT INTO clients (tenant_id, full_name, email, location_id, created_at) VALUES ($1,$2,$3,21,NOW()) RETURNING id", [T, name, `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`]);
    const id = Number(r.rows[0].id); ids.clients.push(id); return id;
  };
  const cliNew = await mkClient(`ZZ RepNew ${RUN}`);       // prima vendita DENTRO la finestra
  const cliRet = await mkClient(`ZZ RepRet ${RUN}`);       // vendita storica + vendita in finestra
  const cliNew51 = await mkClient(`ZZ RepN51 ${RUN}`);     // nuovo, sede 51
  const mkSale = async (over) => {
    const r = await q(`INSERT INTO sales (tenant_id, sale_date, status, total, subtotal, discount, fidelity_discount, credit_used, giftcard_used, location_id, operator_name, notes, client_id)
      VALUES ($1,$2,'done',$3,$3,0,0,$4,$5,$6,'luca','Tipo pagamento: Contanti',$7) RETURNING id`,
      [T, over.date, over.total, over.credit ?? 0, over.gc ?? 0, over.loc ?? 21, over.client]);
    const id = Number(r.rows[0].id); ids.sales.push(id); return id;
  };
  await mkSale({ date: "2026-01-10 10:00:00", total: 30, client: cliRet });                    // storica (fuori finestra)
  await mkSale({ date: "2027-04-10 10:00:00", total: 100, client: cliNew });                   // sede 21, netto 100
  await mkSale({ date: "2027-04-12 11:00:00", total: 50, client: cliRet, credit: 5, gc: 8 }); // sede 21, netto 37
  await mkSale({ date: "2027-04-15 12:00:00", total: 77, client: cliNew51, loc: 51 });         // sede 51, netto 77
  const ap = await q("INSERT INTO appointments (tenant_id, client_id, location_id, starts_at, ends_at, status, public_code) VALUES ($1,$2,21,'2027-04-20 10:00','2027-04-20 11:00','scheduled',$3) RETURNING id", [T, cliNew, `ZZRP${RUN}`]);
  ids.appts.push(Number(ap.rows[0].id));
  // Fidelity: ledger punti (earn 10, redeem -4), ricarica 60 (+una VOID esclusa), giftcard 40 (+una cancellata esclusa)
  const tx1 = await q("INSERT INTO transactions (tenant_id, client_id, kind, delta_points, location_id, created_at) VALUES ($1,$2,'earn',10,21,'2027-04-10 10:05:00') RETURNING id", [T, cliNew]);
  const tx2 = await q("INSERT INTO transactions (tenant_id, client_id, kind, delta_points, location_id, created_at) VALUES ($1,$2,'redeem',-4,21,'2027-04-12 11:05:00') RETURNING id", [T, cliRet]);
  ids.tx.push(Number(tx1.rows[0].id), Number(tx2.rows[0].id));
  const card = await q("INSERT INTO cards (tenant_id, code, client_id, issued_at) VALUES ($1,$2,$3,'2027-04-01') RETURNING id", [T, `ZZRC${RUN}`, cliNew]);
  ids.cards.push(Number(card.rows[0].id));
  const rc1 = await q("INSERT INTO recharges (tenant_id, client_id, card_id, base_amount, bonus_amount, total_amount, is_void, location_id, created_at) VALUES ($1,$2,$3,60,10,70,0,21,'2027-04-11 10:00:00') RETURNING id", [T, cliNew, card.rows[0].id]);
  const rc2 = await q("INSERT INTO recharges (tenant_id, client_id, card_id, base_amount, bonus_amount, total_amount, is_void, location_id, created_at) VALUES ($1,$2,$3,999,0,999,1,21,'2027-04-11 10:10:00') RETURNING id", [T, cliNew, card.rows[0].id]);
  ids.rech.push(Number(rc1.rows[0].id), Number(rc2.rows[0].id));
  const gc1 = await q("INSERT INTO giftcards (tenant_id, code, client_id, initial_amount, balance, status, issued_at, location_id, created_at) VALUES ($1,$2,$3,40,40,'active','2027-04-13',21,NOW()) RETURNING id", [T, `ZZRG${RUN}A`, cliNew]);
  const gc2 = await q("INSERT INTO giftcards (tenant_id, code, client_id, initial_amount, balance, status, issued_at, location_id, created_at) VALUES ($1,$2,$3,500,500,'cancelled','2027-04-13',21,NOW()) RETURNING id", [T, `ZZRG${RUN}B`, cliNew]);
  ids.gc.push(Number(gc1.rows[0].id), Number(gc2.rows[0].id));

  // --- R1-R3: nuovi vs di ritorno ----------------------------------------
  const one = await report(W); // sede di sessione = 21
  const a1 = one.j?.analytics ?? {};
  check("R1 sede 21: clienti finestra 2, nuovi 1 (RepNew), di ritorno 1 (RepRet, prima vendita 2026)",
    a1.newVsReturning?.windowClients === 2 && a1.newVsReturning?.newClients === 1 && a1.newVsReturning?.returningClients === 1,
    JSON.stringify(a1.newVsReturning));
  const all = await report(`${W}&all_locations=1`);
  const a2 = all.j?.analytics ?? {};
  check("R2 tutte le sedi: clienti finestra 3, nuovi 2, di ritorno 1", a2.newVsReturning?.windowClients === 3 && a2.newVsReturning?.newClients === 2 && a2.newVsReturning?.returningClients === 1, JSON.stringify(a2.newVsReturning));
  check("R3 sede 21: breakdown VUOTO senza all_locations", Array.isArray(a1.locationsBreakdown) && a1.locationsBreakdown.length === 0, JSON.stringify(a1.locationsBreakdown));

  // --- R4-R6: breakdown per sede ------------------------------------------
  const bl = Object.fromEntries((a2.locationsBreakdown ?? []).map((l) => [String(l.name), l]));
  check("R4 breakdown: Sede1 venduto netto 137 (100 + 50-5-8), vendite 2, prenotazioni 1",
    bl.Sede1?.soldRevenue === 137 && bl.Sede1?.saleCount === 2 && bl.Sede1?.appointmentCount === 1, JSON.stringify(bl.Sede1));
  check("R5 breakdown: Sede 2 venduto 77, vendite 1, prenotazioni 0", bl["Sede 2"]?.soldRevenue === 77 && bl["Sede 2"]?.saleCount === 1 && bl["Sede 2"]?.appointmentCount === 0, JSON.stringify(bl["Sede 2"]));
  check("R6 breakdown ordinato per venduto (Sede1 prima)", (a2.locationsBreakdown ?? [])[0]?.name === "Sede1", JSON.stringify((a2.locationsBreakdown ?? []).map((l) => l.name)));

  // --- R7-R8: fidelityPeriod ----------------------------------------------
  const fp = a1.fidelityPeriod ?? {};
  check("R7 fidelity sede 21: punti emessi 10 / usati 4, ricariche 1 da 60 (void esclusa)",
    fp.pointsIssued === 10 && fp.pointsUsed === 4 && fp.rechargesCount === 1 && fp.rechargesAmount === 60, JSON.stringify(fp));
  check("R8 fidelity: giftcard emesse 1 da 40 (cancellata esclusa), utilizzi gc 8 + credito 5",
    fp.giftcardsIssued === 1 && fp.giftcardsIssuedAmount === 40 && fp.giftcardUsedAmount === 8 && fp.creditUsedAmount === 5, JSON.stringify(fp));

  // --- R9: locationsCount per lo switch -----------------------------------
  check("R9 locationsCount admin = 2 (switch Tutte le sedi visibile)", Number(one.j?.locationsCount) === 2, JSON.stringify(one.j?.locationsCount));

  // --- UI (Playwright): drill-down, export, sezioni nuove ------------------
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const [cn, cv] = adminCookie.split("=");
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${SLUG}/reports?range=custom&from=2027-04-01&to=2027-04-30&all_locations=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".report-anchor-nav").waitFor({ timeout: 60000 });
  await page.locator("#rep-sedi").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  // D1: nav ancorata con tutte le pillole (incluse Sedi e Fidelity)
  const pills = await page.locator(".report-anchor-pill").allInnerTexts();
  check("D1 nav sezioni: Andamento/Composizione/Top 10/Finanza/Sedi/Fidelity", ["Andamento", "Composizione", "Top 10", "Finanza", "Sedi", "Fidelity"].every((p) => pills.includes(p)), JSON.stringify(pills));

  // D2: KPI Incasso è un link a Movimenti col periodo
  const kpiHref = await page.locator("a.report-kpi-link").first().getAttribute("href");
  check("D2 KPI Incasso -> pos_history col periodo", String(kpiHref).includes("pos_history?from=2027-04-01&to=2027-04-30"), String(kpiHref));

  // D3: Sedi a confronto con Sede1 a 137
  const sediTable = await page.locator("#rep-sedi").innerText();
  check("D3 Sedi a confronto: Sede1 venduto 137,00 e Sede 2 77,00", sediTable.includes("Sede1") && sediTable.includes("137,00") && sediTable.includes("77,00"), sediTable.replace(/\s+/g, " ").slice(0, 140));

  // D4: sezione Fidelity nel periodo
  // Trappola nota: le label KPI sono UPPERCASE via CSS -> match case-insensitive.
  const fidSec = (await page.locator("#rep-fidelity").innerText()).toLowerCase();
  check("D4 Fidelity nel periodo: punti emessi 10, ricariche 60", fidSec.includes("punti emessi") && fidSec.includes("10") && fidSec.includes("60,00"), fidSec.replace(/\s+/g, " ").slice(0, 140));

  // D5: export CSV scarica un file col nome atteso
  const dlPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.locator('#rep-andamento button[title="Esporta CSV"]').first().click();
  const dl = await dlPromise;
  check("D5 CSV andamento scaricato", /incasso_2027-04-01_2027-04-30\.csv/.test(dl.suggestedFilename()), dl.suggestedFilename());

  // D6: bottone Stampa presente
  check("D6 bottone Stampa presente", (await page.locator("#reportPrintBtn").count()) === 1);

  // D7: card Clienti nel periodo con nuovi/di ritorno
  const bodyTxt = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("D7 card Clienti nel periodo: Nuovi 2 / Di ritorno 1 (tutte le sedi)", /clienti nel periodo/i.test(bodyTxt) && /Nuovi 2 \/ Di ritorno 1/.test(bodyTxt), "");

  // D8: percentuali prenotazioni nel KPI
  check("D8 percentuali prenotazioni (Eseguite/Annullate/No show)", /Eseguite 0,0% · Annullate 0,0% · No show 0,0%/.test(bodyTxt), "");

  // D9: modal top clienti con link alla scheda
  await page.locator('button[data-bs-target="#reportClientsModal"]').click();
  await page.locator("#reportClientsModal a[href*='action=view']").first().waitFor({ timeout: 15000 });
  const cliHref = await page.locator("#reportClientsModal a[href*='action=view']").first().getAttribute("href");
  check("D9 top clienti: link alla scheda cliente", /clients\?action=view&id=\d+/.test(String(cliHref)), String(cliHref));
  await page.keyboard.press("Escape");

  // D10: drill-down su Movimenti: ?from/?to prefillano i filtri
  await page.goto(`${BASE}/${SLUG}/pos_history?from=2027-04-10&to=2027-04-10`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="from"]').first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  const fromVal = await page.locator('input[name="from"]').first().inputValue();
  const toVal = await page.locator('input[name="to"]').first().inputValue();
  check("D10 pos_history prefilla from/to dall'URL", fromVal === "2027-04-10" && toVal === "2027-04-10", `${fromVal}..${toVal}`);
} catch (e) {
  console.log("ERRORE:", e?.message ?? e);
  R.push(false);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    if (ids.gc.length) await q(`DELETE FROM giftcards WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.gc]);
    if (ids.rech.length) await q(`DELETE FROM recharges WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.rech]);
    if (ids.cards.length) await q(`DELETE FROM cards WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.cards]);
    if (ids.tx.length) await q(`DELETE FROM transactions WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.tx]);
    if (ids.appts.length) await q(`DELETE FROM appointments WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.appts]);
    if (ids.sales.length) await q(`DELETE FROM sales WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.sales]);
    if (ids.clients.length) await q(`DELETE FROM clients WHERE tenant_id=$1 AND id = ANY($2)`, [T, ids.clients]);
    console.log("CLEANUP: ok (tutti gli id tracciati)");
  } catch (e) { console.log("CLEANUP ERRORE:", e?.message ?? e); }
  await pool.end();
  console.log(`\nTOT: ${R.filter(Boolean).length}/${R.length} PASS`);
  process.exit(R.every(Boolean) ? 0 : 1);
}
