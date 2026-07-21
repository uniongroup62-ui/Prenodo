// Marketplace pass 2 (2026-07-18, post-redesign v2): API + comportamenti
// cablati live. Account cliente TEMPORANEO creato via register (devCode) e
// RIMOSSO per id tracciato a fine suite.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const pg = require("pg");
const { chromium } = require("playwright");
const DBURL = (readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^\s*PRENODO_DATABASE_URL\s*=\s*(.*)\s*$/m) || [])[1].trim().replace(/^["']|["']$/g, "");
const BASE = "http://localhost:3000";
const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
await db.connect();
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };
const RUN = String(Date.now()).slice(-6);
let accountId = 0, accountCookie = "";

try {
  // ===== A. API /api/marketplace =====
  const mk = await fetch(`${BASE}/api/marketplace`).then((r) => r.json());
  const elite = (mk.profiles ?? []).find((p) => p.slug === "centroesteticoelite");
  check("A1 payload: ok + profili + elite presente", mk.ok === true && Array.isArray(mk.profiles) && !!elite, `profili=${(mk.profiles ?? []).length}`);
  check("A2 elite: 2 sedi marketplace (21,51) con dati sede", !!elite && elite.locations.length === 2 && elite.locations.map((l) => l.id).sort().join(",") === "21,51", JSON.stringify(elite?.locations?.map((l) => [l.id, l.name])));
  check("A3 niente foto stock FINTA: image/logoUrl vuoti senza cover/logo caricati", !!elite && elite.image === "" && (elite.logoUrl ?? "") === "", JSON.stringify([elite?.image, elite?.logoUrl]));
  check("A4 payload PUBBLICO: nessun campo sensibile (email/phone/vat/tenant_id)", !!elite && !JSON.stringify(elite).match(/"(email|phone|vat|tenant_id|created_by)"/), "");
  check("A5 categorie attivita + suggerimenti servizi presenti", Array.isArray(mk.categories) && mk.categories.length > 0 && Array.isArray(mk.serviceSuggestions), `cat=${mk.categories?.length} sugg=${mk.serviceSuggestions?.length}`);

  // ===== B. comportamenti Playwright =====
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });

  // B1: ricerca con filtro città via URL (filtro client-side)
  await page.goto(`${BASE}/attivita/ricerca?city=Altino`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  let cardCount = await page.locator(".result-card").count();
  check("B1 ricerca ?city=Altino -> 2 card (sedi di Altino)", cardCount === 2, `cards=${cardCount}`);

  // B2: filtro categoria
  await page.goto(`${BASE}/attivita/ricerca?category=${encodeURIComponent("Unghie")}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  cardCount = await page.locator(".result-card").count();
  const b2title = await page.locator(".results-heading h1").textContent();
  check("B2 ?category=Unghie -> 1 card + titolo dinamico", cardCount === 1 && /Unghie/.test(b2title || ""), `cards=${cardCount} titolo=${b2title}`);

  // B3: nessun risultato -> empty state con reset
  await page.goto(`${BASE}/attivita/ricerca?q=zzz_inesistente_${RUN}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const emptyText = await page.locator(".empty").textContent().catch(() => "");
  check("B3 q inesistente -> 'Nessuna attività trovata' + link reset", /Nessuna attivit/.test(emptyText || "") && /Vedi tutte/.test(emptyText || ""), (emptyText || "").slice(0, 60));

  // B4: sidebar filtri visibile su desktop, bottone Filtri nascosto
  await page.goto(`${BASE}/attivita/ricerca`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const sideVisible = await page.locator(".results-side .filter-card").isVisible();
  const filterBtnVisible = await page.locator(".results-filter-button").isVisible();
  check("B4 desktop: filtri in SIDEBAR, bottone modal nascosto", sideVisible && !filterBtnVisible, `side=${sideVisible} btn=${filterBtnVisible}`);

  // B5: mobile: sidebar nascosta, modal apribile
  const mob = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await mob.goto(`${BASE}/attivita/ricerca`, { waitUntil: "domcontentloaded" });
  await mob.waitForTimeout(2500);
  const sideMob = await mob.locator(".results-side .filter-card").isVisible();
  await mob.locator(".results-filter-button").click();
  await mob.waitForTimeout(400);
  const modalOpen = await mob.locator(".filter-modal.is-open .filter-card").isVisible();
  check("B5 mobile: sidebar nascosta + modal Filtri apre", !sideMob && modalOpen, `side=${sideMob} modal=${modalOpen}`);
  await mob.close();

  // B6: treatment picker home — apri, scegli categoria, label+hidden aggiornati
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".search-box [data-marketplace-treatment-trigger]").click();
  await page.locator('.search-box [data-marketplace-treatment-option][data-treatment-label="Unghie"]').click();
  const label = await page.locator(".search-box [data-marketplace-treatment-label]").textContent();
  const hiddenCat = await page.locator('.search-box input[name="category"]').inputValue();
  check("B6 picker: selezione 'Unghie' -> label + hidden category", (label || "").trim() === "Unghie" && hiddenCat === "Unghie", `label=${label} cat=${hiddenCat}`);

  // B7: validazione città — testo non in lista -> setCustomValidity blocca il submit
  await page.locator("#marketplace-home-city").fill(`CittaInventata${RUN}`);
  await page.locator(".search-box > button[type=submit]").click();
  await page.waitForTimeout(600);
  const stillHome = page.url() === `${BASE}/` || page.url().startsWith(`${BASE}/?`);
  const validity = await page.locator("#marketplace-home-city").evaluate((el) => el.validationMessage);
  check("B7 città non in lista -> submit bloccato con 'Seleziona una città dalla lista.'", stillHome && /Seleziona una citt/.test(validity || ""), `url=${page.url().slice(0, 40)} msg=${validity}`);

  // B8: dettaglio valido — orari + Prenota ora con location_id
  await page.goto(`${BASE}/attivita/centroesteticoelite/sedi/altino-sede1-21`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const orari = await page.locator(".salon-week-list .salon-week-row").count();
  const prenotaHref = await page.locator(".salon-side-book").getAttribute("href");
  check("B8 dettaglio sede: 7 righe orari + Prenota con location_id=21", orari === 7 && /location_id=21/.test(prenotaHref || ""), `orari=${orari} href=${prenotaHref}`);

  // B9: share button — data-share-url RELATIVO in SSR/idratazione poi assoluto (fix mismatch)
  const shareUrl = await page.locator("[data-share-button]").getAttribute("data-share-url");
  check("B9 share url assoluto post-mount con slug sede", /^http:\/\/localhost:3000\/attivita\/centroesteticoelite\/sedi\/altino-sede1-21$/.test(shareUrl || ""), shareUrl || "");

  // B10: console PULITA sul dettaglio (l'hydration mismatch è sparito)
  const hydrationErr = consoleErrors.find((e) => /hydrat/i.test(e));
  check("B10 console senza hydration mismatch (fix shareUrl)", !hydrationErr, hydrationErr || "clean");

  // B11: slug inesistente -> empty-state legacy
  await page.goto(`${BASE}/attivita/slug-inesistente-${RUN}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const notFound = await page.locator(".empty").textContent().catch(() => "");
  check("B11 slug inesistente -> 'Attività non trovata' verbatim", /Attività non trovata/.test(notFound || "") && /non è pubblicato/.test(notFound || ""), (notFound || "").slice(0, 50));

  // B12: preferito da SLOGGATO -> redirect al login cliente
  await page.goto(`${BASE}/attivita/ricerca`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".result-card [data-favorite-button]").first().click();
  await page.waitForTimeout(1500);
  check("B12 preferito sloggato -> login cliente con return", /\/account\/login/.test(page.url()), page.url().slice(0, 70));
  await browser.close();

  // ===== C. preferiti via API con account temporaneo =====
  const reg = await fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "register", privacy_accepted: "1", first_name: "ZZ", last_name: `MkFav${RUN}`, email: `zz.mkfav${RUN}@example.test`, password: "Passw0rd!123", password_confirm: "Passw0rd!123" }) }).then((r) => r.json());
  const devCode = reg.devCode ?? reg.verificationCode ?? "";
  check("C1 register account temporaneo ok (devCode esposto senza SES)", reg.ok === true && devCode !== "", JSON.stringify([reg.ok, !!devCode, reg.error]));
  accountId = Number(reg.accountId ?? 0);
  const verify = await fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", account_id: accountId, code: String(devCode) }) });
  accountCookie = (verify.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const verifyJson = await verify.json();
  check("C2 verify -> sessione cliente", verifyJson.ok === true && accountCookie.includes("beautysuite_customer_session"), JSON.stringify([verifyJson.ok, accountCookie.split("=")[0]]));
  
  // toggle preferito sede 21
  const fav = await fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json", cookie: accountCookie }, body: JSON.stringify({ action: "toggle_favorite", tenant_slug: "centroesteticoelite", location_id: 21, location_slug: "altino-sede1-21" }) }).then((r) => r.json());
  const favList = await fetch(`${BASE}/api/account`, { headers: { cookie: accountCookie } }).then((r) => r.json());
  const favs = favList.favorites ?? [];
  check("C3 toggle_favorite ON + in lista", fav.ok === true && fav.active === true && favs.some((f) => String(f.tenantSlug ?? "").includes("centroesteticoelite")), JSON.stringify([fav.ok, fav.active, favs.length]));
  const favOff = await fetch(`${BASE}/api/account`, { method: "POST", headers: { "content-type": "application/json", cookie: accountCookie }, body: JSON.stringify({ action: "toggle_favorite", tenant_slug: "centroesteticoelite", location_id: 21, location_slug: "altino-sede1-21" }) }).then((r) => r.json());
  const favList2 = await fetch(`${BASE}/api/account`, { headers: { cookie: accountCookie } }).then((r) => r.json());
  const favs2 = favList2.favorites ?? [];
  check("C4 toggle_favorite OFF -> lista vuota", favOff.ok === true && favOff.active === false && favs2.length === 0, JSON.stringify([favOff.ok, favOff.active, favs2.length]));

  // C5: parametri ostili all'API ricerca (pagina) -> 200
  const hostile = await fetch(`${BASE}/attivita/ricerca?q=${encodeURIComponent("'\";--<script>")}&city=${encodeURIComponent("' OR 1=1")}`);
  check("C5 parametri ostili -> 200 senza errore", hostile.status === 200, `status=${hostile.status}`);
} finally {
  // cleanup account temporaneo per ID TRACCIATO
  if (accountId > 0) {
    await db.query("DELETE FROM public_customer_favorites WHERE account_id=$1", [accountId]).catch(() => 0);
    await db.query("DELETE FROM public_customer_email_codes WHERE account_id=$1", [accountId]).catch(() => 0);
    await db.query("DELETE FROM public_customer_accounts WHERE id=$1 AND email LIKE 'zz.mkfav%'", [accountId]);
  }
  const resid = (await db.query("SELECT COUNT(*)::int AS n FROM public_customer_accounts WHERE email LIKE $1", [`zz.mkfav${RUN}%`])).rows[0]?.n ?? -1;
  console.log(`CLEANUP: account residui=${resid} (id=${accountId}) -> ${resid === 0 ? "CLEAN" : "VERIFICA!"}`);
  await db.end();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
