// Marketplace pass 3 (giro 2, 2026-07-18): angoli non coperti dal pass 2 —
// sede inesistente, modali servizi, carosello sedi, condivisione clipboard,
// suggerimenti città, tab Servizi del picker (fix), topbar search.
import { createRequire } from "node:module";
const require = createRequire(new URL("../", import.meta.url));
const { chromium } = require("playwright");
const BASE = "http://localhost:3000";
const R = []; const check = (l, ok, x = "") => { R.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${l}${x ? " | " + x : ""}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();

try {
  // S1: sede con id INESISTENTE -> 'Sede non trovata' fedele (fix giro 2)
  await page.goto(`${BASE}/attivita/centroesteticoelite/sedi/finta-sede-99999`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const sedeEmpty = await page.locator(".empty").textContent().catch(() => "");
  check("S1 id sede inesistente -> 'Sede non trovata' + torna all'attività", /Sede non trovata/.test(sedeEmpty || "") && /Torna all/.test(sedeEmpty || ""), (sedeEmpty || "").slice(0, 60));
  const tornaHref = await page.locator(".empty a").getAttribute("href");
  check("S2 link torna -> /attivita/centroesteticoelite", tornaHref === "/attivita/centroesteticoelite", tornaHref || "");

  // S3: slug sede senza suffisso numerico -> vista attività (fallback prima sede), 200
  await page.goto(`${BASE}/attivita/centroesteticoelite/sedi/senza-id`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const s3name = await page.locator(".salon-name").textContent().catch(() => "");
  check("S3 slug sede senza id -> scheda attività (no crash)", (s3name || "").trim().length > 0, s3name || "");

  // M1: modale SERVIZI — apre, 2 servizi raggruppati, link categoria, book href
  await page.goto(`${BASE}/attivita/centroesteticoelite/sedi/altino-sede1-21`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.locator("[data-salon-services-open]").click();
  await page.waitForTimeout(400);
  const modalVisible = await page.locator("#salonServicesModal.is-open").isVisible();
  const svcCount = await page.locator("#salonServicesModal .salon-service-card").count();
  check("M1 modale Servizi apre con i 2 servizi", modalVisible && svcCount === 2, `open=${modalVisible} servizi=${svcCount}`);
  const bookHref = await page.locator("#salonServicesModal .salon-service-book").first().getAttribute("href");
  check("M2 Prenota servizio -> booking con location_id=21 e service_ids", /\/centroesteticoelite\/booking\?start=1&location_id=21&service_ids=\d+/.test(bookHref || ""), bookHref || "");
  const catLinks = await page.locator("#salonServicesModal .salon-modal-category-link").count();
  check("M3 nav categorie della modale presente", catLinks >= 1, `cat=${catLinks}`);
  await page.locator("#salonServicesModal [data-salon-services-close]").last().click();
  await page.waitForTimeout(300);
  const modalClosed = !(await page.locator("#salonServicesModal.is-open").isVisible().catch(() => false));
  check("M4 modale Servizi chiude", modalClosed, "");

  // M5: bottone Prodotti ASSENTE (tenant 25 senza prodotti pubblicati)
  const prodBtn = await page.locator("[data-salon-products-open]").count();
  check("M5 bottone Prodotti assente senza prodotti (quick-actions is-single)", prodBtn === 0, `btn=${prodBtn}`);

  // SH1: condivisione — click copia negli appunti + stato is-copied
  await page.locator("[data-share-button]").click();
  await page.waitForTimeout(500);
  const copied = await page.locator("[data-share-button].is-copied").count();
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check("SH1 share: is-copied + URL sede negli appunti", copied === 1 && /\/attivita\/centroesteticoelite\/sedi\/altino-sede1-21$/.test(clip), `copied=${copied} clip=${clip.slice(0, 60)}`);

  // C1: carosello sedi sulla scheda ATTIVITÀ (2 sedi) con link coerenti
  await page.goto(`${BASE}/attivita/centroesteticoelite`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const locCards = await page.locator(".salon-location-card").count();
  check("C1 carosello sedi: 2 card sede", locCards === 2, `cards=${locCards}`);
  const locBook = await page.locator(".salon-location-card .btn-primary").first().getAttribute("href");
  const locScheda = await page.locator('.salon-location-card a.btn:not(.btn-primary)').first().getAttribute("href");
  check("C2 card sede: Prenota con location_id + Scheda /sedi/<slug>", /location_id=\d+/.test(locBook || "") && /\/attivita\/centroesteticoelite\/sedi\/.+-\d+$/.test(locScheda || ""), JSON.stringify([locBook, locScheda]));

  // CS1: suggerimenti città della hero — digita 'Alt' -> 'Altino' -> submit
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator("#marketplace-home-city").fill("Alt");
  await page.waitForTimeout(600);
  const sugg = await page.locator("[data-marketplace-topbar-city-suggestions] .marketplace-topbar-city-suggestion").allTextContents();
  check("CS1 digitando 'Alt' compaiono suggerimenti con Altino", sugg.some((s) => /Altino/.test(s)), JSON.stringify(sugg.slice(0, 3)));
  await page.locator("[data-marketplace-topbar-city-suggestions] .marketplace-topbar-city-suggestion", { hasText: "Altino" }).first().click();
  const cityVal = await page.locator("#marketplace-home-city").inputValue();
  check("CS2 click suggerimento -> input valorizzato", /Altino/.test(cityVal), cityVal);
  await page.locator(".search-box > button[type=submit]").click();
  await page.waitForURL(/\/attivita\/ricerca/, { timeout: 8000 });
  check("CS3 submit -> /attivita/ricerca?city=Altino…", /city=Altino/.test(page.url()), page.url().slice(0, 70));

  // P1: tab SERVIZI del picker home (fix giro 2: prima era VUOTA)
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".search-box [data-marketplace-treatment-trigger]").click();
  await page.locator('.search-box [data-marketplace-treatment-tab="services"]').click();
  await page.waitForTimeout(300);
  const svcOptions = await page.locator('.search-box [data-marketplace-treatment-list="services"] [data-marketplace-treatment-option]').count();
  check("P1 tab Servizi POPOLATA (era vuota)", svcOptions >= 1, `opzioni=${svcOptions}`);
  await page.locator('.search-box [data-marketplace-treatment-list="services"] [data-marketplace-treatment-option]').first().click();
  const svcHidden = await page.locator('.search-box input[name="service"]').inputValue();
  const svcLabel = await page.locator(".search-box [data-marketplace-treatment-label]").textContent();
  check("P2 selezione servizio -> hidden service + label", svcHidden.length > 0 && (svcLabel || "").trim() === svcHidden, `service=${svcHidden} label=${svcLabel}`);
  await page.locator(".search-box > button[type=submit]").click();
  await page.waitForURL(/\/attivita\/ricerca/, { timeout: 8000 });
  await page.waitForTimeout(3500); // fetch client di /api/marketplace post-navigazione
  const svcCards = await page.locator(".result-card").count();
  check("P3 submit servizio -> risultati filtrati per service", /service=/.test(page.url()) && svcCards >= 1, `url=${decodeURIComponent(page.url()).slice(0, 80)} cards=${svcCards}`);

  // T1: tab ATTIVITÀ del picker — opzione elite seleziona q
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".search-box [data-marketplace-treatment-trigger]").click();
  await page.locator('.search-box [data-marketplace-treatment-tab="salons"]').click();
  await page.waitForTimeout(300);
  const salonOpt = await page.locator('.search-box [data-marketplace-treatment-list="salons"] [data-marketplace-treatment-option]').count();
  check("T1 tab Attività popolata con i profili", salonOpt >= 2, `opzioni=${salonOpt}`);

  // T2: topbar search della pagina ricerca — submit con città
  await page.goto(`${BASE}/attivita/ricerca`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator("#marketplace-topbar-city").fill("Alt");
  await page.waitForTimeout(600);
  const topSugg = await page.locator("[data-marketplace-topbar-city-suggestions] .marketplace-topbar-city-suggestion").count();
  check("T2 suggerimenti città anche nella topbar ricerca", topSugg >= 1, `sugg=${topSugg}`);
} finally {
  await browser.close();
  console.log(`\n==== ${R.filter(Boolean).length} PASS / ${R.filter((x) => !x).length} FAIL ====`);
}
