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
