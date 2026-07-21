# Audit qualità codice — 2026-07-21

Audit completo su richiesta ("controlla che il codice sia ben ottimizzato e programmato bene"):
~188k righe TS/TSX (components 91k, lib 76k, app 20k). Metodo: metriche automatiche
(tsc, eslint, check tenant-scope) + tre revisioni approfondite parallele (componenti
React, lib server/SQL, route API/architettura); i finding di severità ALTA sono stati
riverificati a mano sul sorgente prima di entrare in questo documento.

## Metriche

- `tsc --noEmit`: PULITO (strict: true).
- `check:tenant-scope`: OK, 148 tabelle tenant tutte scopate.
- ESLint: 221 errori + 1743 warning. Errori: 173 `no-html-link-for-pages` (pagine
  pubbliche faithful, `<a>` deliberato), 36 `set-state-in-effect` (render doppio
  evitabile), 9 regole React compiler serie (refs/immutability/purity) da guardare
  una a una, 2 auto-fixabili. Warning: quasi tutti unused-vars nei test.

## BUG CONFERMATI (verificati a mano)

1. **Storico cliente irraggiungibile** — `app/[tenantSlug]/[...segments]/page.tsx:939 vs 953`:
   il branch generico `if (page === "clients")` precede `clients && action === "history"`,
   che è codice morto. "Vedi tutto" (client_detail:317, client_consents:278) apre la
   LISTA clienti. Fix: spostare il branch history prima del generico.
2. **Rate fuori transazione nel checkout POS** — `lib/manage-pos.ts:1254`: il piano usa
   `insertRow` tx-aware (1219-1220) ma le `sale_installments` usano `tenantInsert`
   liscio → connessione diversa dalla tx del checkout: FK su plan_id non committato /
   righe orfane su rollback. Fix: usare `insertRow` anche a 1254.
3. **Race sui fetch filtrati** — `components/modules/pos_history-content.tsx:153-173`
   (`alive` protegge solo setLoading, non `setCtx`), `reports-content.tsx:389-410`,
   `staff-content.tsx:88-108`, `giftbox-content.tsx:139-163`: cambiando filtri in
   rapida successione vince la risposta più LENTA, non l'ultima richiesta → dati del
   filtro precedente mostrati come attuali. Il pattern corretto (seq-guard) esiste già
   in pos-content/quick-booking-drawer, va condiviso.

## ALTA — performance/robustezza (verificati dai revisori con file:riga)

- **Report API senza LIMIT + N+1 doppio** — `lib/db-repositories.ts:5899-5928` +
  `app/api/manage/reports/route.ts:59-61`: `listDbSales` carica TUTTO lo storico e
  `mapSale` fa 2 query per vendita; la route lo esegue DUE volte (posDbSummary +
  chiamata diretta) → ~2×(1+2N) query per apertura pagina, cresce senza limite.
  Stessa famiglia: `listDbQuotes` (6117-6123), `checkoutDbSale` rilegge la singola
  vendita caricando l'intera lista (6046-6048).
- **Emissioni satellite POS ingoiate** — `lib/manage-pos.ts:5861 (GiftCard), 6098
  (GiftBox), 5481-5489 (Ricariche)`: `.catch(() => 0)` su scritture monetarie: la
  vendita conclude ma il voucher non esiste, senza log. Idem storni in
  `cancelLinkedSaleResidues` (4934-4979) e `reverseIssuedSaleRecharges` (5178-5187).
  Minimo: log dell'errore + segnalazione.
- **Browser disponibilità: centinaia di query sequenziali** —
  `lib/public-booking-db.ts:733-846`: ~8-12 query per giorno × fino a 92 giorni per
  una singola apertura del modal.

## MEDIA (selezione)

- Poller shell re-renderizza tutto ogni 5s anche a conteggi invariati
  (`components/manage-shell.tsx:520-531`): bail-out banale mancante. [verificato a mano]
- TZ: `new Date()`/`NOW()` in scritture business (`db-repositories.ts:6002, 6079,
  6111`; `gift-issue-details.ts:191`; 25158+, 25298+) — drift 1-2h vs standard Roma.
- `verifySession` può lanciare (timingSafeEqual su buffer di lunghezza diversa,
  `lib/manage-auth.ts:431-436`) → 500 globale con cookie malformato invece di 401.
- XFF leftmost su ADMIN_IP_ALLOWLIST e rate-limit login (`proxy.ts:29-31`,
  `login/route.ts:9-10`): header spoofabile, prendere il valore destro/edge.
- Cron fail-open se `CRON_SECRET` manca (`lib/cron.ts:15-22`) + secret in query.
- `/api/manage/db-status` senza gate (unica route manage non-auth).
- Errori interni inoltrati al client in 152 punti + ZERO console.error nelle route
  manage → debugging cieco su Amplify.
- Guard conflitti booking fail-open (`public-booking-db.ts:1700-1714, 2162-2166`):
  timeout DB = double-booking senza log.
- Discount POS senza guardia NaN (`manage-pos.ts:624`).
- `marketplaceSeoProfile` eseguita 2× per richiesta senza `cache()` (`app/attivita/
  [slug]/page.tsx:26,63`).
- Bundle: 95 import statici di *Content nel catch-all, zero next/dynamic — chunking
  client demandato alle euristiche, bundle SSR con tutti i moduli. Verificare con
  `next build` + analisi chunks; se fusi → mappa next/dynamic.
- Non-atomicità multi-statement residue (moveDbAppointmentCalendar, saveAvailability
  Event, copyWeekAvailability con DELETE swallowed, ritiro preordine).
- Typeahead drawer senza seq-guard (`quick-booking-drawer.tsx:2270-2295`).

## Manutenibilità

- Monoliti: db-repositories.ts 26k righe; quick-booking-drawer 5.8k/95 useState;
  manage-pos 6.6k; pos-content 4.7k/99 useState; calendar-content 4.6k; funzioni da
  400-530 righe (checkoutManageSale, updateDbAppointment, saveManageQuote).
- Duplicazione: `tenantSlug()` copiato in 93 file, scaffold fetch/loading in 71,
  markup flash in 47, `href()` in 18. Con useModuleFetch (con seq-guard → risolve
  anche le race), usePagination, useFlash + 3 componenti condivisi: ~2.5-4k righe in
  meno e un punto unico di fix.
- Zero React.memo/next-dynamic; label senza htmlFor (601 vs 154); Bootstrap da CDN
  senza SRI; mysql2 in dependencies (solo tool one-off → devDependencies);
  images.remotePatterns config morta.

## Fatto bene (consenso di tutti e tre i revisori)

- Autorizzazione uniforme: sessione+permesso PRIMA delle query in tutte le route
  campionate; sessione HMAC timing-safe, fail-hard senza secret in prod, revoca epoch.
- SQL sempre parametrizzato, zero injection/cross-tenant trovati; scoping in CI.
- Anti-oversell atomico, prezzi autoritativi server, FOR UPDATE sui prepagati.
- Guardie anti-race professionali dove gira il denaro (POS search, residui, drawer).
- Cleanup timer/listener quasi perfetto; slot engine pubblico O(1) query per data.
- Commenti-contratto con riferimento riga PHP legacy e eslint-disable sempre motivati.

## Giudizio

Sopra la media per una migrazione 1:1: sicurezza SQL/authz solide, concorrenza curata
nei percorsi di cassa, scelte anti-idiomatiche documentate. I problemi si concentrano
in: 3 bug puntuali (storico, rate, race), il ceppo perf dei repository legacy senza
LIMIT (Report è il caso peggiore e cresce con lo storico), catch silenziosi su
scritture monetarie, hardening (XFF/cron/db-status/logging) e l'assenza del layer
condiviso client (hook comuni). Piano suggerito: (1) bug confermati, (2) Report+
listDbSales, (3) logging errori + hardening, (4) hook condivisi, (5) split monoliti.

---

# GIRO 2 (stesso giorno) — superfici non coperte dal giro 1

Tre revisioni profonde: superficie PUBBLICA (booking/account/marketplace/voucher,
letti integralmente), infrastruttura (8 cron, email SES, SMS, R2, PDF, log),
monoliti client (calendar 4.6k e quick-booking-drawer 5.8k letti INTEGRALMENTE,
saas-admin). I 47 lint "seri" verificati nel contesto: quasi tutti benigni
(pattern SSR-safety deliberati); nessuno e' un bug runtime.

## URGENTE (azione utente + codice)
- CREDENZIALI REALI COMMITTATE: db/tools/admin-shot.mjs:11,24 e auth-shot.mjs:20,27
  contengono email+password admin in chiaro (valide per gestionale E pannello SaaS),
  anche nella history git. Ruotare la password SUBITO e spostare in env. [verificato]

## ALTA
- Stored XSS server-rendered: JSON-LD marketplace (attivita/[slug]/page.tsx:69 e
  sedi/[locationSlug]) — JSON.stringify in dangerouslySetInnerHTML senza escape di
  `<`: nome attivita' con `</script>` esegue JS su ogni visitatore. Fix one-liner
  .replace(/</g,"\u003c"). [verificato]
- Cron reminders SENZA claim atomico (route.ts:549-575, sent marcato DOPO l'invio):
  run sovrapposti = email/SMS doppi con doppio addebito wallet; giftbox/giftcard
  hanno gia' il pattern giusto (claim 15min). Vale anche per card_reminders. [verificato]
- 6 cron su 8 senza try/catch per-tenant: un tenant rotto salta TUTTI i successivi
  (ordine alfabetico) a ogni run, in silenzio. Pattern giusto in saas-tenant-health.
- Drawer: hold "orfano" rinnovato all'infinito a drawer chiuso — runAvailability/
  applyAvailabilitySlot sono le UNICHE fetch senza guardia anti-stale: risposta che
  arriva dopo resetForm setta holdToken e l'auto-renew blocca lo slot per sempre.

## MEDIA (selezione)
- Open redirect post-auth: account-auth-destination accetta //evil.com e /\evil.com.
- javascript: URL nei social sede (normalizeSocialUrl non allow-lista https/http)
  → XSS-on-click su marketplace-detail 853/858/863.
- Login cliente senza rate-limit (unico endpoint credenziale senza throttle).
- Double-escape nelle email "plain": L'Estetica → L&#039;Estetica (buildReminderEmail/
  buildFidelityEmail + ramo rejected di appointment-lifecycle-email).
- TZ server (UTC) nei confini di fidelity-expire/reconcile, todayYmd reminders,
  timestamp firma GDPR nel PDF (documento legale 2h indietro), localSqlNow registro cron.
- Promemoria falliti → status='failed' MAI ritentati (contraddice il commento in testa).
- migrate-data.mjs: TRUNCATE CASCADE con fallback silenzioso al DB live se manca
  SUPA_URL — serve guardia/conferma.
- Calendario: loadContext senza seq (risposta lenta di un range vecchio vince),
  revert del move su snapshot stale (perde aggiornamenti concorrenti; meglio
  ricaricare), action=move risponde con TUTTO lo storico appuntamenti.
- SaaS admin: errori nel banner VERDE di successo (delete fallita sembra riuscita);
  popstate con filtri stale; ricerca palette senza seq; bulk reset senza confirm.
- Booking pubblico: chooseSlot senza guardia anti-stale + hold mai rilasciati sui
  ripensamenti (slot bloccati per altri fino al TTL); coupon non ri-validato al
  cambio carrello (solo display, il server ri-risolve).

## BASSA (selezione)
- fromName email non sanificato RFC5322 (nome con <> = SES rifiuta tutto);
  assertCronAuth non timing-safe + secret in query; token nei GET (parita' legacy);
  error.message nei GET pubblici; PRENODO_EXPOSE_ACCOUNT_DEBUG foot-gun;
  user-enumeration su register (parita'?); CDN senza SRI; ghost calendario su liste
  filtrate; filtro servizio per NOME (omonimi); resetForm drawer non azzera 7 stati
  redeem (oggi schermato); pdfkit .notdef su caratteri fuori WinAnsi.

## Fatto bene (giro 2)
Confirm booking blindato server-side (hold atomico, prezzi/coupon sempre ri-risolti);
auth cliente robusta (bcrypt, codici hashati timing-safe, cap+cooldown); storage R2
multi-tenant pulito con anti-traversal; privacy-pdf valida i PNG prima di pdfkit;
drawer con 10 fetch guardate da req-id e redeem come derived-state; admin con
conferme proporzionate al rischio e zero superfici innerHTML.
