# Roadmap di verifica migrazione PHP → Next (2026-07-02)

Verifica end-to-end che il Next (localhost:3000, Supabase) replichi il PHP
(localhost, MySQL): logiche, funzioni, dati e grafica. Metodo: sessioni live su
entrambi (login tenant `centroesteticoelite`), confronto pagina-per-pagina
HTML/API + e2e già eseguiti area per area (vedi cronologia commit).

## Stato harness
- ✅ Login PHP (`POST /manage/login`, csrf) e Next (`POST /api/manage/auth/login`) funzionanti.
- ✅ Inventario sidebar: **49/49 pagine identiche** (stessi slug, stessi `<h1>`).
- ✅ Sweep live 48 pagine (logout escluso): tutte **200/200** con intestazioni identiche.

## ⚠️ Divergenza DATI MySQL ↔ Supabase (decisione richiesta)
La migrazione dati è uno snapshot: da allora i due DB sono stati usati in parallelo.
- **Supabase** ha 4 clienti di test ("Luca Rossi" id 21/22/26/27, creati 30/06,
  anagrafiche vuote) + vendita 17 (0€, senza cliente) + vendita 19 (12€, annullata,
  cliente 21) + appuntamenti di test — assenti in MySQL. Gli appuntamenti di OGGI
  (id 138/139, cliente 22) sono quelli visibili in dashboard: dati di test attivi
  dell'utente → NON eliminati automaticamente.
- **MySQL** ha un cliente registrato il 29/06 (creato nel PHP dopo lo snapshot)
  assente in Supabase.
- **Azione al cutover**: ri-export finale MySQL → Supabase (o freeze del PHP) +
  pulizia concordata dei record di test. Fino ad allora i confronti numerici
  KPI/liste NON possono coincidere per definizione.

## Aree già migrate + verificate e2e (storico sessioni, tutte committate)
Calendario (Blocks 1-6, engine disponibilità/lifecycle/planner/price-panel),
Quick-booking drawer (Blocks 1,3-6), POS completo (Blocks 1-7 + sub-pagine +
sale detail + storno), Gestione Rate, Scadenziario e Costi, Commissioni (POS +
appuntamenti), Magazzino, Fornitori, Buoni/Coupon, Pacchetti, Preventivi,
GiftBox, GiftCard, Fidelity (toggle, punti, campagne, livelli, adesione/tessere,
portafoglio punti), Omaggi (campagne), Ricariche, Portafoglio (movimenti
credito), Promozioni (lista/editor avanzato/engine applicazione + POS),
Report/Statistiche (analytics filtrate per data), editor catalogo (16 moduli),
Clienti (form/detail/cascade-delete/tag/storico).

## Verifiche live PHP↔Next — risultati (2026-07-02)
1. ✅ **Slot engine (disponibilità)**: stesso giorno/servizio/sede (2026-07-06,
   servizio 9, sede 21) → **109/109 slot IDENTICI** (09:00→18:00 passo 5') sia
   sull'endpoint drawer (`action=availability`, param `service_name`) sia su
   quello pubblico (`/api/booking?action=slots`). Engine equivalente al PHP.
2. ✅ **Dashboard KPI**: stessa finestra settimanale (29/06–05/07), stessi 4
   indicatori (appuntamenti/ricavi/ore/nuovi clienti) + serie giornaliera; i
   numeri divergono SOLO per il drift dati documentato sopra (verificato campo
   per campo: ogni differenza è spiegata dai record di test).
3. ✅ **Pagine pubbliche**: /attivita, /attivita/<slug>, /account/login,
   /account/register → 200/200 su entrambi. Nota: la scheda attività Next è
   client-rendered (h1 placeholder "Attivita" pre-hydration, poi "elite" dal
   context API — nessun bug funzionale; eventuale SSR per SEO è un'ottimizzazione
   futura).
4. ✅ **POS — stessa vendita su entrambi** (cliente 9, servizio "test" €12, contanti):
   PHP #23 e Next #91 → **numeri IDENTICI** (Subtotale €12,00 / Sconto €0,00 /
   Totale €12,00 / 0 punti — nessuna campagna attiva su entrambi). Storno +
   eliminazione definitiva eseguiti su entrambi (DB ripuliti). Nota tecnica PHP:
   il checkout richiede `installment_choice_mode=single|installment` (obbligatorio).
5. ✅ **Drawer — stesso appuntamento su entrambi** (06/07 09:00–10:00, cliente 9,
   staff luca): creato su entrambi; con l'occupazione identica la disponibilità
   perde **gli stessi 12 slot** (09:00–09:55) → **97/97 disponibili identici**.
   Differenza di FORMATO (non logica): il PHP restituisce solo gli slot liberi,
   il Next tutti gli slot con flag `available`/`reason` (la UI filtra il flag).
   Cleanup completo su entrambi.
   ✅ **Guardia delete ALLINEATA al legacy** (scelta utente, commit e016982): un
   appuntamento si elimina solo se già Annullato (msg legacy identico; il bulk
   salta i non annullati e riporta `skipped`). Il fix ha smascherato un BUG
   latente reale: cancel→delete faceva DOPPIO restore dei redeem (pacchetto +2
   sessioni) — restoreAppointmentRedeems ora è idempotente (azzera i linkage su
   appointment_services [PK composita, niente colonna id] + giftcard_used dopo
   il rimborso). e2e 9/9 CLEAN.
6. ✅ **Campagna deep Calendario/Appuntamenti/Quick-Booking (2026-07-02, stesso
   dato su entrambi, tutto ripulito dopo)**:
   - Lifecycle identico su entrambi: create(pending) → move (14:00) → resize
     (90') → pending→scheduled→done OK; done→scheduled RIFIUTATO con messaggio
     IDENTICO carattere-per-carattere; cancel_done preview+apply OK su entrambi.
   - 🐛→✅ **BUG PARITY TROVATO+FIXATO (commit 1e94b1d)**: sul done il Next
     accreditava punti flat floor(importo/step) (1pt su €12) dove il legacy dà 0
     senza campagna attiva. Ora earn appuntamenti + ricariche usano
     computeCampaignEarn (campaign-aware come il POS); rimosso l'helper flat
     morto. Verificato live: done → 0 punti = PHP.
   - Multi-servizio (test 60' €12 + test2 30' €20 creati su entrambi):
     availability 103/103 identica; appuntamento 2 servizi → prezzi/righe
     identici (12+20); conflitto col multi in agenda → 73/73 identici.
   - Coupon TEST10 (10%): stessa validazione sede (messaggio IDENTICO), preview
     drawer identica (sconto 3,20 su 32,00) su stesso contesto/data.
   - Conferma LIVE del quirk legacy documentato: con 1 sede la lista coupon PHP
     NON renderizza la tabella (il coupon esisteva ma invisibile); il Next la
     mostra correttamente (bug legacy non replicato, intenzionale).
   - Nota minore: default scadenza coupon Next = +30gg, PHP = nessuna → da
     allineare (creazione senza date esplicite).
7. ✅ **Motore HOLD (booking)**: hold sullo stesso slot (14/07 10:00) su entrambi
   → la disponibilità perde gli STESSI slot (86/86 identici, blocca anche gli
   inizi precedenti che sconfinerebbero); release → 109 ripristinati su entrambi.
   Token+TTL 300s identici come semantica.
8. ✅ **Note calendario**: save/list/delete parity (stesso payload, autore
   risolto identico); campi snake_case (PHP) vs camelCase (Next) — interna UI.
9. ✅ **Coupon senza scadenza** (fix 2bc3978): mapCoupon inventava una finestra
   finta oggi/+30gg per date NULL → un coupon senza scadenza previewato per un
   appuntamento a >30gg veniva rifiutato (il PHP lo accetta). Ora bound vuoti =
   illimitati (activeWindow già compatibile). Verificato live a +75gg.
10. ⏳ **Booking confirm end-to-end cross-sistema**: richiede un account cliente
    pubblico verificato via email su entrambi (codice di verifica) — da fare a
    mano o con accesso alla mailbox/log mailer. Le componenti sottostanti (slot,
    hold, conferma lato Next) sono già verificate singolarmente.
11. ⏳ **Voucher pubblici** giftcard/giftbox + **Admin SaaS** + cron.
12. ✅ **Deep round 2 Quick-Booking/Calendario (2026-07-02, secondo operatore +
    secondo servizio creati su entrambi, poi ripuliti) — 3 BUG PARITY TROVATI +
    FIXATI (commit 3f3ebc9)**:
    - **Guardia staff-servizio**: il save legacy rifiuta un operatore non
      abilitato al servizio ("Operatore non abilitato per il servizio ..."); il
      Next accettava chiunque. Portata la semantica esatta (staff_services con
      staff ATTIVI = allow-list; nessuna riga = tutti ammessi; 'SSO' esente) in
      createDbAppointment + updateDbAppointment. Messaggio identico verificato.
    - **Filtro CABINA negli slot** (publicBookingSlots): il legacy toglie gli
      slot con cabina occupata (booking_filter_slots_by_cabins); il Next li
      offriva (il save poi rifiutava). Ora ogni servizio occupa la sua cabina
      primaria per la propria finestra sequenziale contro
      busyCabinRangesForDate. Retest 4 combinazioni: 80/80, 92/92, 92/92,
      73/73 (prima il Next mostrava +30 slot fantasma).
    - **Blocchi per-segmento nel calendario Day**: il legacy emette un evento
      PER SEGMENTO per-operatore; il Next un solo blocco sotto l'operatore
      primario → la colonna del secondo operatore sembrava LIBERA mentre era
      occupata. Ora mapAppointment espone `segments` (solo quando >1 operatore)
      e la Day view renderizza un blocco virtuale per segmento nella colonna
      giusta (click → stesso drawer di modifica).
    - Verificati inoltre: staff_for_service (stessi operatori listati),
      availability per-segmento su 4 combinazioni, calendario list API
      (eventi per-segmento PHP ≡ appointment+segments Next).
13. ✅ **Chiusure + Straordinari cross-engine (fix bf1105f)**: il motore slot
    Next IGNORAVA la tabella closures (giorno chiuso = 109 slot prenotabili!).
    Ora priorità legacy (straordinario > chiusura > orari settimanali).
    Verificato live: chiusura 17/07 → 0/0; domenica straordinaria 19/07
    10:00–13:00 → 25/25 identici (10:00→12:00 per 60'); domenica normale → 0/0;
    delete chiusura → 109 ripristinati.
14. ✅ **Redeem PACCHETTO cross-sistema end-to-end (2026-07-02)**: template
    ZZPack (3× test, €30) creato su entrambi → venduto via POS a cliente 9 su
    entrambi → redeem nel drawer su entrambi → **parità perfetta**: riga
    servizio price 0 / list_price 12 / badge "Pacchetto" IDENTICI; il Next
    scala la seduta 3→2 alla creazione (modello prenotazione, divergenza
    documentata: il legacy scala al done) e la RIPRISTINA 2→3 all'annullo.
    Cleanup completo: appuntamenti, storno vendite (il delete PHP riporta
    "Artefatti vendita eliminati: Pacchetti 1" ≡ il void Next annulla il
    client_package), template eliminati da entrambi.
    Nota harness: il campo Next è `item_id` (non `id`) nelle righe pacchetto;
    la delete catalogo PHP è un GET (action=catalog_delete&id&_csrf).
15. ✅ **Matrice COMPLETA azioni api_appointments PHP ↔ Next (2026-07-02, flusso quick booking)**
    Tutte le 20 azioni reali del PHP mappate e verificate:
    | PHP | Next | Esito |
    |---|---|---|
    | availability | availability | ✅ verificata live (più volte) |
    | cabins_for_services | (client-side su context.cabins) | ⚠️ il legacy lista solo le cabine LIBERE nell'orario; il Next tutte quelle della sede. Solo UI: il save ora valida/auto-assegna (vedi item 16) |
    | cancel_done_preview/apply | cancel_done_preview / cancel_done | ✅ verificate live |
    | coupon_preview | /api/manage/coupons action=preview | ✅ verificata live (3.20/32) |
    | delete | delete / bulk_delete | ✅ guardia "Annullato prima" identica |
    | fidelity_preview | calcolo client-side nel drawer (Block 4) | ✅ stesso esito, meccanismo diverso; conflict_policy/gift radios NON portati (vedi gap) |
    | fidelity_gift_redeem | — | ❌ GAP: riscatto premio-fidelity dal drawer non portato |
    | get | get | ✅ verificata live |
    | hold_availability / release_hold / renew_hold | idem | ✅ round-trip live ok; **fix TTL**: canale backend ora 300s (era 150s fisso; legacy Helpers.php:12871). NB: countdown/auto-renew nel drawer legacy sono DISATTIVATI da qbStartHoldCountdown ("short technical hold") → il Next senza countdown è fedele |
    | list | /api/manage/calendar | ✅ verificata live |
    | move | move | ✅ + ora risolve la cabina come il legacy (mantieni se libera, altrimenti auto-pick) |
    | promotion_preview | — | ❌ GAP MAGGIORE: il drawer legacy auto-rileva la migliore promozione (prezzi barrati + badge, persistiti al save server-side con regole di stacking coupon/fidelity). Drawer Next non wired (engine action=evaluate esiste, Block 3) |
    | qb_residui_check | rivalidazione al save | ✅ esito equivalente (il legacy pre-valida al toggle; il Next rivalida sempre in createDbAppointment e riporta warnings) |
    | save | default POST (create/update) | ✅ verificata estensivamente |
    | staff_for_service(s) | context payload staff | ✅ verificata live |
    | swap_segment | — | ❌ GAP: riordino ↑/↓ segmenti multi-servizio dalla lista appuntamenti (assets/js/pages/appointments.js:138). La lista Next non ha le child-row segmenti; equivalente ottenibile ri-salvando i servizi in altro ordine |
    | (extra Next) resize / status / context / plan_* | — | ✅ status≡save legacy; resize è additivo |
    - **Nuovo cliente dal drawer**: legacy `client_id=__new__` dentro il save
      (transazionale); Next POST /api/manage/clients action=create poi save.
      Esito equivalente (divergenza: se il save fallisce il Next ha già creato
      il cliente).
16. ✅ **CABINE al save — port completo resolve_cabin_id_for_range (fix di oggi)**
    Il save Next NON validava/assegnava le cabine: un appuntamento con cabina
    AUTO restava NULL → non consumava capacità cabine (il legacy rifiuta con
    "Nessuna cabina disponibile"), e una cabina-servizio occupata faceva
    rifiutare prenotazioni che il legacy accetta auto-scegliendo la successiva.
    Portati in lib/db-repositories.ts: allowed per servizio (service_cabins →
    services.cabin_id → tutte le attive, INTERSEZIONE multi-servizio, ordine
    position), occupazione (segmenti + appuntamenti + hold, filtro sede),
    auto-pick prima libera, per-segmento nel multi-servizio (cabin_map
    esplicita = validazione severa; altrimenti mantieni-posizione → cabina
    appuntamento → auto), appointments.cabin_id NULL in multi (modalità
    segment del legacy), edit "mantieni la corrente se libera altrimenti
    auto". Gate multi-tenant: tenant senza cabine ⇒ nessuna risoluzione
    (equivalente del table_exists per-tenant legacy).
    **Verifica live (T1–T5, dati identici sui 2 stack: 1 cabina attiva)**:
    T1 create senza cabina → ok + cabina 9 auto su ENTRAMBI; T2 overlap senza
    cabina → "Nessuna cabina disponibile nell'orario selezionato." identico;
    T3 cabina 9 esplicita occupata → "Cabina selezionata occupata nell'orario
    selezionato." identico; T4 cabina 10 inattiva → "La cabina selezionata non
    è abilitata per i servizi scelti." identico; T5 edit 10:00→15:00 → cabina
    mantenuta (appuntamento + segmento) su entrambi. Cleanup DB completo.
17. ✅ **Guardia CLIENTE BLOCCATO al save (fix di oggi)**: il legacy rifiuta un
    cliente is_blocked=1 al save (api_appointments.php:9995) con eccezione
    "stesso cliente già sull'appuntamento" in edit. Il Next non aveva la
    guardia. Portata in create+update. Verifica live su ENTRAMBI: create
    bloccato → messaggio identico ("Questo cliente è disattivato e non può
    essere utilizzato in Pagamenti o Quick Booking finché non viene
    riattivato."); edit stesso cliente bloccato → ok su entrambi. Flag
    ripristinato + appuntamenti test eliminati da entrambi i DB.

## Gap residui del flusso Quick Booking (da decidere/pianificare)
1. ~~Promozioni nel drawer~~ ✅ **FATTO (2026-07-02, vedi item 18)**.
2. **fidelity_gift_redeem**: ✅ FATTO (2026-07-02): action portata sulla route
   Next (fidelityGiftRedeemForAppointment) — riscatto dell'INTERA istanza
   omaggio su appuntamento esistente ("Registra gift" del modal calendario):
   auto-pick prima istanza disponibile senza gift_idx, catena guardie legacy
   (istanza del cliente/attiva/disponibile/non scaduta), istanza →
   'riscattato' con source appointment + riga gift_transactions, campi
   fidelity_gift_* dell'appuntamento azzerati. **Verifica live IDENTICA sui 2
   stack** (redeem ok {points_used:0}, "Nessun omaggio riscattabile",
   "Appuntamento non coerente con il cliente selezionato."). Cleanup completo.
   RESTA UI: radios "Scelta cliente" (conflict_policy='choice') nel drawer.
3. **swap_segment**: ✅ BACKEND portato (2026-07-02): action=swap_segment sulla
   route Next con semantica legacy esatta (solo pending/scheduled; scambio
   position+finestre orarie mantenendo la finestra appuntamento; guardie staff
   time-off/conflitto e ri-risoluzione cabina per segmento; appointments
   riallineato a MIN/MAX segmenti). Verificato live su Next: swap up/down
   corretti, 5 messaggi-guardia identici al legacy ("Spostamento non
   disponibile", "Direzione non valida", "Segmento non trovato", ecc.).
   NOTA: il PHP LOCALE non è testabile per confronto diretto — il rewriter
   tenant del suo Db inietta `appointments.tenant_id` dentro la subquery
   MIN/MAX (bug dell'import locale a tabelle condivise; in produzione con
   tabelle prefissate non accade) → lo swap PHP locale fallisce sempre con
   "Errore durante l'aggiornamento della prenotazione.". Semantica presa dal
   codice sorgente (:9386-9605). RESTA UI: child-rows multi-servizio + frecce
   ↑/↓ nella lista appuntamenti Next.
4. **Cabine nel drawer**: ✅ FATTO (2026-07-02): action=cabins_for_services
   portata (cabinsForServicesContext: allowed per servizi + stato occupata
   nella finestra, ends_at auto da durata totale, auto_select su singola
   libera — shape legacy {cabins, free_ids, auto_select}); **verifica live:
   risposta IDENTICA sui 2 stack** (occupata alle 10:30 con appuntamento
   sovrapposto, libera+auto_select alle 14:00). Drawer: select #qb_cabin_id e
   picker multi mostrano le occupate col suffisso "(occupata)" disabilitate,
   auto-select sulla singola LIBERA (come refreshCabinsForServices).
5. **Hold: cabin_ids_json** — il Next riserva la cabina di default del
   servizio; il legacy auto-sceglie una cabina LIBERA dalla lista allowed.
   Con 1 cabina per servizio (dato reale attuale) identico; divergenza solo
   con pool di cabine condivise.
6. **Coupon su base ridotta dalla promo**: ✅ FATTO (2026-07-02): il preview
   coupon Next (route coupons action=preview) ora valuta la promo automatica
   dei servizi e, se NON cumulabile col coupon, riduce la base ai soli servizi
   non scontati; tutto scontato ⇒ rifiuto con la reason legacy ("Il coupon non
   è applicabile agli elementi già in promozione per questa campagna.").
   **Verifica live IDENTICA sui 2 stack**: rifiuto carattere-per-carattere con
   promo non cumulabile; sconto 1.08 su base post-promo 10.80 con promo
   cumulabile; 1.20 senza promo. I preview POS (solo code+subtotal) invariati.

## Item 18 — PROMOZIONI nel quick booking (2026-07-02, port completo + verifica live)
- **Engine** (lib/db-repositories.ts): computePromoDiscountCents riscritto con
  l'allocazione PER-UNITÀ legacy (Promotions.php ~4380): percent = round per
  unità; fixed su riga selected = min(unit, valore) per unità; fixed globale =
  pro-rata largest-remainder. Ora produce anche il breakdown per servizio
  {old, now, discount, badge} ("-10%" / "-€ 5,00" formato it-IT) — lo stesso
  che alimentava solo il POS ora è condiviso.
- **evalBestPromotionForAppointment**: migliore promo automatica eleggibile
  (le promo con coupon_code sono escluse come nel preview legacy) + flag
  stackable dal bitmask legacy (raw 1 => tutto; bit 4 fidelity, bit 8 coupon).
- **Route action=promotion_preview**: shape identica al legacy. **Verifica
  live: risposta IDENTICA al centesimo e al carattere** (servizio 12€, promo
  -10% => list 12 / booked 10.8 / badge "-10%", stessi flag stackable).
- **Save (create+edit)**: rivalutazione server-side (il preview del drawer non
  è mai fidato) → appointment_services.price/list_price/discount_badge coi
  prezzi promo, appointments.promotion_id, riga promotion_redemptions
  (discount_amount) — su edit ricreata/rimossa; gate legacy "non su done".
  **Verifica live: persistenza IDENTICA sui 2 stack** (10.80/12.00/-10%,
  redemption 1.20).
- **Catena FIDELITY al save** (ogni step verificato LIVE contro PHP, stessi
  dati sui 2 stack): (1) redeem disabilitato => richiesta azzerata in
  silenzio, save ok con fidelity_points_used=0; (2) cliente senza tessera
  attiva => "Cliente non aderisce alla Fidelity"; (3) conflitto promo non
  cumulabile sulla richiesta GREZZA (prima del saldo!) => "Sconto punti
  Fidelity non cumulabile con la promozione \"T\"."; (4) saldo => "Punti non
  disponibili." / "Punti insufficienti." / minimo. Tre errori riprodotti
  carattere-per-carattere su Next (test A/B/C).
- **Drawer**: fetch promotion_preview su cambio cliente/servizi/data/ora/sede
  (req-id + cache key come qbPromoKey legacy); pannello prezzi con prezzo di
  listino barrato + prezzo scontato + badge verde (stesso ramo visivo dei
  redeem, generalizzato list>price come renderPriceDetails).
- Cleanup test completo: promo ZZPromoTest, tessera ZZTESTCARD, appuntamenti
  e redemption eliminati da entrambi i DB; punti cliente 9 ripristinati
  (22 su Supabase, 0 su MySQL), redeem flag MySQL ripristinato.
- Nota drift dati: su Supabase fidelity_redeem_enabled=1 e cliente 9 con 22
  punti; su MySQL redeem 0 e 0 punti — divergenza PRE-esistente dei dati, non
  di codice (riallineare all'export finale).

## Item 19 — Modal "Disponibilità" del quick booking (2026-07-02, segnalato dall'utente)
Il bottone "Disponibilità" del drawer Next faceva solo l'hold diretto dell'ora
digitata; il legacy apre il MODAL XL "Orari disponibili" (#qbAvailabilityModal)
con browser navigabile. Portato per intero:
- **Backend** (`manageAvailabilityBrowser`, public-booking-db.ts + route
  action=availability con range/summary): payload legacy per giorno {slots blu
  in orario, override_slots arancioni fuori orario/chiusura selezionabili
  (staff libero + no timeoff + cabina libera, senza il check turno SOFT),
  booked/booked_outside (solo con operatore specifico), conteggi + primo slot
  in modalità summary, is_closed + orari 1°/2° intervallo, label giorno
  "24 GIO"/"24 Giovedì", label mese "Settembre 2026"}.
  **Verifica live campo-per-campo IDENTICA a PHP**: giorno normale (109 slot +
  168 override, tutti i 18 campi), domenica chiusa (277 override identici),
  summary settimana 7/7 giorni (conteggi/primo orario/chiuso), giorno con
  prenotazione (86 slot + 12 tick occupati identici).
- **Drawer**: modal React con la stessa markup/classi CSS legacy (qb-avail-*
  già in public/assets/css/app.css): vista Giorno = timeline 00:00-24:00 a
  barrette 5' (blu/arancione/rosso/grigio + tooltip title), Settimana/Mese =
  lista giorni riassuntiva (label, "Primo orario:", "Orari:"/Chiuso, badge
  "N slot") con drill-down al giorno; nav ◀ Oggi ▶ per periodo, gruppo
  Giorno/Settimana/Mese, date picker; click su barra selezionabile → hold →
  compila data/ora (setter raw per non rilasciare l'hold) → chiude.
- **Flusso e2e verificato**: settimana → drill giorno → click 11:00 → hold →
  save con token → ok; cleanup completo.
- **Quirk legacy preservato**: le barre arancioni "selezionabili" falliscono
  l'hold anche su PHP ("Orario non piu disponibile. Ricarica e scegli un
  altro slot." — verificato live 21:00/03:00); Next ora risponde con il
  messaggio identico (stringa hold allineata anche nel wizard pubblico).
- Differenze minori documentate: niente infinite-scroll/auto-refresh/tooltip
  bootstrap (title nativo) e date-picker nativo al posto del popover; dst_fold
  non calcolato (solo tooltip nel legacy).
- publicBookingSlots ora accetta excludeAppointmentId (edit: l'appuntamento in
  modifica non blocca il proprio slot nel browser).

## Item 20 — AUDIT COMPLETO flusso booking (2026-07-02): quick booking / calendario / booking PUBBLICO
Inventario completo booking.php (13.665 righe, 16 modes API + confirm + area
cliente) confrontato col Next.

### Quick booking + calendario manage: A PARITÀ
Tutte le 20 azioni api_appointments coperte e verificate live (item 15-19).
Restano SOLO due rifiniture UI documentate: frecce ↑/↓ riordino segmenti nella
lista appuntamenti (child-rows già presenti, API swap_segment già portata) e
radios "Scelta cliente" conflict_policy nel drawer.

### Booking PUBBLICO (booking.php): matrice modes → Next
| PHP mode | Next | Stato |
|---|---|---|
| staff | context (Step 4 operatore) | ✅ |
| slots | action=slots | ✅ (verificato identico in passato) |
| hold_slot / release_hold | action=hold / release_hold | ✅ |
| closures | — | ⚠️ il date strip disabilita solo i giorni PASSATI, non i chiusi (lo slot vuoto copre il caso ma la UX legacy li spegne) |
| coupon (validazione free-text) | — | ❌ box coupon solo markup ("markup only" nel wizard) |
| promotions | benefits list nel context | ⚠️ lista statica di promo/coupon ATTIVI; il legacy valuta per carrello |
| promotion_preview | — | ❌ nessuna valutazione best-promo per carrello lato pubblico (engine ora esiste, manca il wiring) |
| fidelity_preview | — | ❌ pannelli fidelity/credito/giftcard in Step 6 renderizzati ma STATICI e nascosti |
| confirm (POST) | action=confirm | ⚠️ base ok (hold, cliente, sconto coupon/promo a livello appuntamento, segments, public_code, pending) MA mancano: fidelity_points_use, giftcard_redeem, giftbox_redeem, fidelity_choice/gift_idx, note automatiche legacy ("Gia pagato: ...", righe coupon/promo formattate), prezzi promo PER-SERVIZIO su appointment_services |
| my_appointments | — | ❌ AREA CLIENTE: /account "Attività" elenca solo i CENTRI collegati, non le prenotazioni |
| cancel_appointment | — | ❌ il cliente non può annullare da sé |
| my_packages | — | ❌ pacchetti/residui cliente assenti |
| my_quotes / quote_decision | — | ❌ preventivi cliente + accetta/rifiuta assenti |
| ics | — | ❌ download calendario assente |
| customer_login/register/verify/resend/forgot/logout/update_profile/verify_profile_email | /api/account (login/register/verify/resend/forgot/reset/logout/update_profile/email-change) | ✅ |
| customer_update_reference_location | — | ❌ (minore) |
| (extra Next) favorites | toggle/remove_favorite | ✅ additivo |

### Priorità suggerite per chiudere il pubblico
1. ✅ **Area cliente prenotazioni** — FATTO (2026-07-02, item 21 sotto).
2. ✅ **Step 6 wizard (coupon + promozioni)** — FATTO (2026-07-02, item 22).
   Restano deferred i pannelli fidelity/credito/giftcard (richiedono cliente
   loggato con saldi; nascosti anche nel legacy di default).
3. ✅ **my_packages + my_quotes + quote_decision** — FATTO (2026-07-02, item 23).
4. Date strip: spegnere i giorni chiusi (mode=closures o riuso businessIntervals).
5. Minori: update_reference_location, prezzi promo per-servizio al confirm.
Nota infra: email conferma/OTP su SES già documentata come rinviata.

## Item 21 — Area cliente PRENOTAZIONI (2026-07-02, blocco 1 del pubblico)
Port di booking.php mode=my_appointments (:6525) + cancel_appointment (:6632) +
ics (:7182) + policy booking_customer_can_cancel_appointment (Helpers:5424, le
colonne booking_customer_cancel_* vivono su businesses — attive: 24 ore).
- **lib/public-customer-appointments.ts**: lista aggregata su tutte le attività
  collegate all'account globale (regola ownership legacy: client_id del link O
  email uguale), payload legacy per appuntamento (codice, orari, stato+label,
  servizi, operatori, sede, totale con la cascata sconto→fidelity→giftcard→
  credito, can_cancel+cancel_reason con le stringhe esatte); annullo via il
  percorso pending/scheduled→canceled del manage (restore redeems + status +
  email lifecycle best-effort); ICS identico al legacy (VTIMEZONE Europe/Rome,
  summary "Appuntamento • …", descrizione Servizi/Totale/Sede/Codice, VALARM
  -15').
- **API**: /api/account action=appointments + action=cancel_appointment;
  GET /api/account/ics?code=… (text/calendar, 404 legacy).
- **UI**: nuova voce "Prenotazioni" nell'account (+ /account/appointments):
  card per prenotazione con badge stato, "Aggiungi al calendario" e "Annulla"
  (o il motivo policy quando non annullabile).
- **Verifica live e2e**: lista 3 appuntamenti (futuro annullabile + 2 annullati
  con reason legacy), ICS 200 con corpo conforme, annullo <24h → "Puoi
  annullare solo entro 24 ore prima dell'appuntamento.", annullo lontano → ok e
  stato Annullato, appuntamento altrui → "Appuntamento non trovato". Cleanup
  completo (appuntamenti test, account test, link ripristinato).
- **BUG PRE-ESISTENTE trovato e fixato**: le scadenze dei codici OTP/reset
  erano scritte con SQL NOW() (UTC) ma rilette come naive-local (+2h) → ogni
  codice risultava "scaduto" su CET/CEST. Ora scadenza scritta da JS (verifica
  email, reset password, cambio email). Verificato live: prima "Codice
  scaduto…", dopo verify ok.
- NOTA scoperta collegata: il form Impostazioni→Prenotazioni (policy annullo)
  in Next è ancora uno STUB (onSubmit preventDefault, non salva) — i valori
  esistono in DB e la policy funziona; il salvataggio del form è da wire-are.
- Divergenza documentata: package/prepaid/gift summary della lista/ICS non
  popolate (sotto-engine ClientPackages::appointmentPackageSummary non portato;
  campi vuoti).

## Item 22 — Booking pubblico: coupon free-text + promozioni (2026-07-02, blocco 2)
Port di booking.php mode=coupon (:5322), mode=promotion_preview (:5580) e del
blocco benefit del confirm (:7600-7960).
- **Engine**: evalBestPromotionForAppointment accetta preferredPromotionId
  (legacy: la promo pre-selezionata eleggibile vince); nuova
  evalPromotionCodeForAppointment (promo con coupon_code = PROMOZIONE, mai
  coupon — port di Promotions::discountForCode).
- **lib/public-booking-benefits.ts**: risoluzione benefit del confirm — promo
  per codice > coupon classico (base ridotta ai servizi non scontati con promo
  NON cumulabile, base post-promo con promo cumulabile) > migliore promo
  automatica; client per le regole target risolto da email/telefono (port di
  booking_resolve_client_id_for_promos).
- **Route /api/booking**: action=coupon e action=promotion_preview (shape
  legacy); il confirm risolve i benefit SERVER-SIDE (mai fidato il wizard).
- **Confirm fedele al legacy**: NIENTE colonne discount — coupon nelle note
  ("Servizi: …" + "Coupon: X" + "Sconto coupon: - € y,yy"), promo nei prezzi
  per-servizio (price/list_price/badge) + promotion_id + riga
  promotion_redemptions; customer_notes = solo note del cliente.
- **Wizard Step 6**: box coupon wired (Applica/Rimuovi, promo-da-codice
  riconosciuta), banner promo automatica rilevata, sconto/etichette reali in
  Step 6/7.
- **Verifica live vs PHP (public=1)**: promotion_preview identico (12→10.8,
  badge -10%); coupon nei 3 casi identici (rifiuto char-per-char con promo non
  cumulabile; 1.20 senza promo; ZZPROMOCODE → is_promotion=1, sconto 5, tot 7);
  confirm verificati su DB: coupon → note legacy esatte + nessuna colonna
  discount; promo → 10.80/12.00/-10% + promotion_id + redemption 1.20.
  Cleanup completo su entrambi i DB (promo/coupon/appuntamenti/cliente test).
- Nota parametri legacy: mode=promotion_preview usa `date`, mode=coupon usa
  `appt_date` (rispecchiati).

## Item 23 — Area cliente: PACCHETTI + PREVENTIVI (2026-07-02, blocco 3)
Port di booking.php mode=my_packages (:6817), my_quotes (:6708) e
quote_decision (:7060).
- **Lib** (public-customer-appointments.ts): pacchetti per attività collegata
  (client_packages + righe per-servizio, normalizzazione stato legacy
  canceled→completed→expired→active con label italiane); preventivi non-draft
  (LIMIT 50, override 'sent'→'expired' oltre valid_until, can_respond, regola
  ownership legacy client_id o email su preventivi senza cliente); decisione
  accept/reject con le guardie e le stringhe legacy esatte ("Preventivo
  scaduto", "Hai già risposto a questo preventivo.", "Questo preventivo non è
  modificabile.", "Non autorizzato") + stamp customer_decision_at/source
  ='booking' condizionato (status='sent' AND decision IS NULL).
- **API** /api/account: action=packages | quotes | quote_decision.
- **UI**: voci "Pacchetti" e "Preventivi" nell'account (+ /account/packages,
  /account/quotes): card pacchetto con sedute residue/totali, scadenza e badge
  stato; card preventivo con numero/date/totale/badge + Accetta/Rifiuta sui
  'sent'.
- **Verifica live e2e**: pacchetto 3/5 Attivo listato; preventivo sent
  rispondibile + scaduto forzato expired non rispondibile; accept → Accettato
  con decision stampata; secondo accept → "Hai già risposto…"; decisione su
  scaduto → "Preventivo scaduto". Cleanup completo (quotes/pacchetto/account
  test, link ripristinato).
- Divergenze documentate: sedute RISERVATE (prenotazioni pending) non scisse
  dal residuo per-servizio; public_url/pdf_url del preventivo non esposti (la
  pagina quote_public + PDF è nell'infra rinviata); il check disponibilità
  catalogo all'accettazione (quote_catalog_availability_check) non portato —
  la conversione in vendita lato manage rivalida comunque gli articoli.

## Item 24 — Rifiniture finali (2026-07-02): impostazioni booking, chiusure strip, sede riferimento, frecce riordino
- **Form Impostazioni → Prenotazioni** (era uno stub che non salvava):
  action=booking_settings_save su business-settings (4 colonne businesses coi
  clamp legacy 8760h/365g) + prefill GET section=booking. Verificato live:
  prefill corretto, clamp 9999→8760, ripristino.
- **Date strip wizard**: action=closures su /api/booking (port di
  mode=closures: closed_dows dalle business_hours effettive, closed_dates
  dalle closures 365gg, open_dates dagli straordinari che riaprono) —
  **risposta identica a PHP** (domenica chiusa). La strip ora spegne i giorni
  chiusi oltre ai passati.
- **Sede di riferimento** (port di customer_update_reference_location):
  update clients.location_id del cliente collegato con validazione sede
  attiva/prenotabile e stringhe legacy; select nella card attività (visibile
  con 2+ sedi), referenceLocationId esposto nelle activities.
- **Frecce ↑/↓ riordino segmenti** nella lista appuntamenti (legacy
  .ms-seg-move): le righe servizio ora portano segmentId e seguono l'ORDINE
  di posizione segmento; i bottoni chiamano action=swap_segment e ricaricano.
  Verificato live: swap up → ordine invertito nella lista; cleanup completo.
  → Con questo, del flusso quick booking resta SOLO la UI conflict_policy
  radios (fidelity choice) come rifinitura documentata.

## Item 25 — Modal "Scheda semplificata" cliente nel quick booking (2026-07-02, segnalato dall'utente)
Il link "Apri scheda" dello Storico cliente navigava alla pagina clienti; il
legacy apre il MODAL scheda semplificata (qbOpenClientCard -> api_clients
action=card -> #qbClientCardModal, View.php:1650).
- **API** quickBookClientCard (route clients action=card): anagrafica+punti,
  summary (contatori stato, ultima/prossima visita, totale vendite non
  annullate), ultimi appuntamenti (nomi servizi da snapshot, operatori,
  totale col solo sconto manuale come il legacy card, limit 0..50), ultime 10
  vendite, tag (customer_tags) e documenti (senza URL: infra allegati S3
  rinviata — il modal mostra "Non disponibile" come il legacy senza href).
  **Verificata live**: payload allineato a PHP (unica differenza il drift
  punti 22 vs 0 già noto + campi extra legacy non usati dal render).
- **Drawer**: modal XL con la markup legacy (header "Scheda semplificata" +
  "Apri in nuova scheda", colonna Fidelity/Tag/Documenti, tabelle Storico
  appuntamenti con badge stato e Storico vendite); "Apri scheda" ora lo apre
  (href intatto per middle-click/nuova scheda).
- **Sweep completo id drawer legacy** (~110 elementi qb*): tutti presenti in
  Next — l'unica mancanza era questo modal.

## Item 26 — Caricamento calendario: bande indisponibilità per-operatore + fix label stato (2026-07-02, segnalato dall'utente)
Analisi completa del caricamento eventi legacy (calendar.js events() ->
action=list con range/filtri; filtri server-side ≡ client-side Next per esito;
restyle soft-card degli eventi ≡). Due differenze reali trovate e chiuse:
- **Bande grigie per-operatore mancanti** (legacy include_unavailability=1
  nella vista Giorno a colonne): fuori-turno (complemento di
  staff_availability, solo per operatori che usano la feature; presenza >
  turno; righe sede-specifiche preferite) + assenze staff_timeoff, uniti e
  RITAGLIATI sugli orari di apertura. Port: staffUnavailabilityForDate
  (public-booking-db) + staffUnavailability nel context /api/manage/calendar
  + bande nella colonna operatore della vista Giorno con la CSS legacy
  (.staff-unavailability: strisce diagonali + pillola "Non disponibile").
  **Verifica live**: assenza 14-16 -> banda {22, 840, 960} ≡ PHP
  (22, 14:00->16:00). Cleanup completo.
- **BUG label stato**: uiStatus collassava canceled/no_show in "Confermato" —
  un appuntamento annullato mostrava badge "Confermato" ovunque si usasse la
  label (es. lista appuntamenti). Ora 5 label (Annullato / No show aggiunte al
  tipo + statusStyles). Verificato live: 138 canceled -> "Annullato".

## Item 27 — Lock prenotazioni annullate/No show nel quick booking (2026-07-02, segnalato dall'utente)
Segnalazione: "nelle prenotazioni annullate non c'è alcun blocco della modifica".
Analisi legacy completa (qbApplyCancellationState / qbSetLockedAppointmentMode /
qbRenderCancellationAlert + guard save api_appointments.php ~10222-10233 +
routing submit app.js ~11336-11343). Chiuso su 4 fronti:
- **Guard server-side sul save** (updateDbAppointment): originale canceled/no_show
  -> throw "La prenotazione annullata non è più modificabile." (stringa legacy
  esatta; prima il save ANDAVA A BUON FINE). action=status aveva già il guard.
- **Lock UI del drawer**: fieldset disabled + classe .qb-locked (link cliente e
  multiselect servizi inerti: pointer-events none / opacity .65 ≡
  qbSetClickableLocked), alert #qbCancellationAlert (titolo "Prenotazione
  annullata"/"Prenotazione No show", motivazione o riga fallback "Questa
  prenotazione è in stato finale...", "Annullata il/Segnata il gg/mm/aaaa
  hh:mm"), submit disabilitato con label di stato, Elimina attivo SOLO per
  canceled (no_show: disabilitato, ≡ keepDeleteEnabled), guard nel submit.
- **cancelledAt/cancelledReason in action=get** (con fallback [ANNULLATA ...]
  dalle notes come nel PHP ~8686-8694).
- **Annullamento 'reserved' (pending/scheduled)**: nel legacy OGNI annullamento
  passa dal popup dedicato (cancel_mode reserved|executed) che timbra
  cancelled_at/by/reason (default "Annullamento prenotazione da backend" /
  "No show prenotazione da backend"). Prima in Next pending/scheduled->annullato
  era un bare status-write senza timbro né popup. Ora: cancelDonePreview/
  cancelDoneAppointment estesi al modo reserved (righe "Verranno sbloccati ...",
  errori legacy esatti), il drawer apre il popup per pending/scheduled/done, e
  action=status delega il cancel reserved allo stesso apply (timbro garantito
  per ogni caller). Email lifecycle mappata sul VERO stato precedente.
**Verifica live** (appuntamenti test 169/170/171, creati+eliminati, DB pulito):
save/status su annullata -> rifiutati con stringa legacy; preview reserved ok;
cancel_done con motivazione -> get {canceled, "2026-07-02 18:06:00", "cliente ha
cambiato idea"}; status->no_show -> timbro default "No show prenotazione da
backend"; delete su no_show rifiutato ("...deve essere in stato Annullato...").
Gap residuo documentato: segment_view (modifica singolo segmento dal calendario,
#qbSegmentViewAlert) non portato — il drawer Next apre sempre l'appuntamento
completo.

## Item 28 — Calendario: overlay "Caricamento prenotazioni..." + frecce giorno (2026-07-02, segnalato dall'utente)
Due mancanze vs PHP nella toolbar/griglia del calendario:
- **Overlay di caricamento mancante**: il legacy inietta #calendarLoadingOverlay
  (card con spinner, "Caricamento prenotazioni..." / "Aggiornamento del calendario
  in corso.", 120ms anti-flicker, hide dopo 100ms, stato errore "Impossibile
  caricare le prenotazioni" + bottone Riprova su fetch eventi fallita). Il CSS
  (.calendar-loading-*) era GIÀ nel calendar.css portato ma il componente non
  renderizzava mai il markup (solo un testo piccolo nella colonna staff). Portato
  in calendar-content.tsx: stati overlayVisible/loadError con gli stessi timer,
  card nel .fc-view-harness, errore legacy esatto ("Non e stato possibile
  aggiornare gli appuntamenti del calendario.") + Riprova che rilancia loadContext.
- **Frecce ‹ › invisibili**: i bottoni prev/next esistevano ma i glifi usano il
  font "fcicons" di FullCalendar, che nel legacy viene iniettato dal JS del CDN
  (il <link> css del legacy è in realtà un 404 — v6 non ha css separato). Il Next
  non carica FullCalendar -> icone vuote. Fix: @font-face fcicons (base64) +
  .fc-icon/.fc-icon-chevron-left/right + sizing .fc .fc-button .fc-icon estratti
  da fullcalendar@6.1.11/index.global.min.js e aggiunti a
  public/assets/css/pages/calendar.css.
- **Griglia a tutta pagina invece che con scroll interno**: il legacy imposta
  l'altezza del calendario al viewport (computeCalendarViewportHeight: innerHeight
  - top shell - footer - gap, min 360/400/420 per breakpoint) e la timegrid
  scorre DENTRO lo scroller FullCalendar; il Next dava all'harness l'altezza
  dell'intero contenuto (slot x 88px) facendo crescere la pagina. Port:
  harnessRef + agendaViewportHeight (stessa formula, ricalcolo su resize),
  .fc-scroller interno (overflow auto, entrambi gli assi) per Giorno/Settimana,
  header colonne (operatori/giorni) sticky-top, asse orari sticky-left con
  corner spacer sticky (il wrapper overflowX annidato è stato rimosso: con uno
  scroller solo gli sticky funzionano). Mese resta auto-height come nel legacy.

## Item 29 — AUDIT COMPLETO n.2 (2026-07-02): booking / quick booking / calendario
Catalogo integrale del legacy (calendar.js 5204 righe, app.js qb* + api_appointments
20 action, booking.php 13665 righe) confrontato feature-per-feature col Next +
test live su entrambi gli stack. MANCANZE RILEVATE (non ancora fixate):

CALENDARIO
- C1 Card evento: manca la riga orario "HH:mm - HH:mm (NN')" come prima riga;
  in legacy dot+badge stanno DENTRO la riga cliente (eventContent calendar.js
  4301-4379 + prepend 4446-4531); ordine attuale Next: badge/dot riga 1, poi
  "HH:mm Cliente". Vale per vista Giorno e Settimana.
- C2 Multi-servizio: badge "MS" con colore accento univoco per gruppo/giorno
  (calendar.js 4408-4444, palette 3865-3959) + hover ms-active che evidenzia
  tutti i segmenti dello stesso appuntamento (4538-4558) — mancanti.
- C3 Densità adattiva card corte (appt-event-tiny/compact, 4007-4030) — mancante.
- C4 Marker note in vista GIORNO (pallino sul titolo toolbar, 759-858) —
  mancante (Settimana/Mese presenti).
- C5 Gating drag/resize client-side per stato (legacy: editable solo
  pending/scheduled) — Next: blocchi sempre trascinabili, il server rifiuta
  correttamente ("La prenotazione non e modificabile da calendario." — testato
  live su done). Solo UX, esito identico.
- C6 Colonna "SSO / Senza Operatore" se esistono servizi senza operatore
  (calendar.php 54-58) — mancante (edge case).
OK verificati: viste, filtri, note sett/mese+modale, now-indicator multi-colonna,
bande indisponibilità, chiusure, BREAK TIME, asse dinamico fuori-orario
(expandWindowForAppointments), ordina colonne persistente, date picker
tri-modale, contatori, overlay caricamento, guard multi-servizio su move/resize.

QUICK BOOKING
- Q1 action qb_residui_check (conflitti redeem già usati su ALTRI appuntamenti,
  con segnalazione + deselezione, api 5879 + app.js 770/2456-3158) — mancante.
- Q2 Modali dettaglio residui: #qbGiftboxInfoModal, #qbPackageInfoModal,
  #qbGiftInfoModal, #qbPrepaidServiceInfoModal, #qbGiftcardInfoModal
  (View.php 1741-1896) — mancanti (la lista residui c'è, i 5 popup no).
- Q3 Auto-rinnovo hold a metà TTL (qbScheduleHoldRenew app.js 3315; drawer
  aperto >5 min = hold scade) — l'action renew_hold esiste nel Next ma il
  drawer non la schedula mai.
- Q4 Fidelity conflict choice: #qbFidelityChoiceBox radio discount/gift/later
  con policy 'choice' + riga omaggio #qbFidelityGiftRow + auto-pick best gift
  (app.js 4722-4797, 7654-7720) — mancante (fidelity_gift_redeem API già
  portata, UI no). Già documentato.
- Q5 segment_view (già documentato Item 27).
- Q6 staff_for_service(s): il legacy mostra nel select operatore anche gli
  occupati con motivo (api 5909-6171); il Next calcola l'eleggibilità
  client-side senza stato occupato — divergenza minore.
OK verificati: 20/20 action coperte o equivalenti, lock annullate, cancel
reserved/executed, hold expiry recovery, coupon/promo/sconto/redeem, modale
disponibilità, scheda cliente, trova/nuovo cliente (form completo).

BOOKING PUBBLICO / AREA CLIENTE
- P1 Step 6 "Vantaggi": i pannelli Fidelity/Credito/GiftCard esistono nel
  markup Next ma sono statici d-none — manca mode=fidelity_preview pubblico
  (booking.php 5700-6522) e l'applicazione al confirm. (Nel tenant di test i
  pannelli legacy sono comunque nascosti: nessun beneficio attivo.)
- P2 Deep-link prenotazione da residuo: book_package/book_prepaid/
  book_giftbox/book_omaggio + service_id precompilano il wizard
  (booking.php 2226-2331, 3034-3167) — mancanti.
- P3 Sezioni area cliente tenant mancanti: Credito, GiftCard, Prepagati,
  Preordini, Fidelity, Omaggi (BookingPublicUi.php 33-60; Next ha
  Attività/Prenotazioni/Pacchetti/Preventivi/Preferiti/Profilo).
- P4 Pagine pubbliche via token: quote_public.php (preventivo + PDF),
  gdpr_public.php (firma GDPR), consent_public.php (firma consenso) —
  mancanti (dipendono da infra PDF/S3 rinviata).
- P5 Vista conferma post-invio: il legacy ha pagina dedicata con pulsanti
  ".ics" e "Stampa" (booking.php 8824-8982); il Next mostra solo l'alert
  "Richiesta inviata" con codice — mancano ICS/Stampa post-conferma.
- P6 embed=1 (incorporamento su sito esterno, booking.php 9166) — mancante.
OK verificati: gate login obbligatorio, wizard 7 step con consigliati/badge
promo, coupon/promo step 6-7, hold countdown 150s, chiusure/eccezioni, area
cliente (appuntamenti+annulla+ICS, pacchetti, preventivi+decisione, profilo
con cambio email OTP, sede riferimento), impostazioni Booking (3 controlli),
OTP/reset (fix TZ), conferme su DB.

### Esiti fix audit n.2 (stessa data)
- C1+C2+C3+C4 CHIUSI (calendar-content.tsx): card evento rifatta fedele
  (riga 1 "HH:mm - HH:mm (NN')" via apptTimeLine, riga 2 dot+badge stato+
  [badge MS]+nome cliente in .fc-event-title/.appt-client-name, "• operatore"
  solo Settimana, righe "• servizio" con bullet legacy); badge MS con accent
  per gruppo/giorno (palette MS_ACCENT_PALETTE portata, msAccentByAppt) +
  --ms-accent/ms-has-accent + hover ms-active su tutti i blocchi del gruppo;
  split per-segmento anche in Settimana (expandSegments); densità adattiva
  (tiny <28px / compact 28-54px, soglie legacy); marker note sul titolo
  toolbar in vista Giorno. Il CSS ms-*/densità era GIÀ nel app.css portato.
- Q3 CHIUSO (quick-booking-drawer.tsx): auto-rinnovo hold ogni 60s (clamp
  legacy ttl/2 30-60s su TTL backend 300s), retry 30s su errore, stop a token
  rilasciato/tab nascosta. Ciclo hold->renew->release verificato live.
- Q1 RISOLTO SENZA PORT (analisi): qb_residui_check protegge il modello
  legacy "consuma al done" (residui solo prenotati su appuntamenti attivi ->
  serve sottrarre le riserve). Il Next consuma i redeem alla CREAZIONE
  (divergenza approvata): i residui nel drawer escludono già i consumi delle
  altre prenotazioni e il save re-valida con packageWarnings/prepaid/giftbox/
  gift warnings. Copertura equivalente per costruzione; nessun check separato.
- Q4 NON È UN GAP (verificato nel sorgente legacy): Fidelity.php ~624-631 —
  "Conflitto tra Sconto tramite punti e Omaggi: funzionalità rimossa", la
  conflict_policy è FORZATA a 'discount' e la lista premi è vuota; il box
  #qbFidelityChoiceBox (radio discount/gift/later) è codice morto anche nel
  PHP (qbUpdateFidelityChoiceVisibility richiede policy==='choice' che non può
  più verificarsi). Gli omaggi v2 dinamici per cliente sono già portati
  (gift redeem + fidelity_gift_redeem).
- P1 CHIUSO (verificato live end-to-end): Vantaggi step 6 pubblici.
  * API: action=fidelity_preview su /api/booking (clientId SOLO dalla sessione
    cliente — publicSessionClientId; anonimo => pannelli vuoti): punti
    disponibili + suggerito (min(punti, floor(dovuto/euroPerPoint)), azzerato
    sotto il minimo), credito, giftcard attive del cliente.
  * Confirm: fidelity_points_use/credit_use/giftcard_redeem applicati POST
    insert con gate sessione===client prenotato (parità col gate legacy
    BookingAuth::user().client_id): riserva punti (colonne fidelity_points_used/
    fidelity_discount + riga note legacy "Fidelity: -€ x (N Punti prenotati,
    scalati quando eseguito)"), giftcard via applyAppointmentGiftcardRedeem,
    credito con clamp legacy (dovuto - sconti - fidelity, giftcard NON
    sottratta — quirk fedele a booking.php 8355) + addebito wallet + colonne.
  * Wizard: pannelli Punti Fidelity / Credito / GiftCard collegati (toggle +
    scelta giftcard), righe di sconto nel riepilogo step 7 e nell'aside,
    totale pagabile aggiornato, nota #recFidelityNote sui punti prenotati.
  * Test live (setup usa-e-getta client 28 + card + giftcard, TUTTO ripulito):
    preview {50 punti -> €5, credito 20, giftcard 15}; confirm con fidelity+
    giftcard -> colonne {50, 5, gc_used 7} + saldo giftcard 15->8 + note; 2a
    prenotazione con credito -> wallet 20->8 + credit_used_by_customer; il
    DELETE ha ripristinato correttamente giftcard e credito (stesso restore
    del manage). DB pulito a fine test.
- P2 CHIUSO: deep-link "prenota da residuo". La pagina booking legge
  book_package/book_prepaid/book_giftbox(+giftbox_item_id)/book_omaggio
  (+reward_item_index)+service_id, precompila il wizard (servizio+categoria
  selezionati) e il confirm invia il redeem JSON; la route lo applica POST
  insert con gli stessi applier server-side del manage
  (applyAppointmentPackage/Prepaid/Giftbox/GiftRedeems, re-validazione +
  azzeramento riga), gate di sessione come i Vantaggi. Da collegare in P3 i
  link dalle sezioni area cliente ancora mancanti.
- P3 CHIUSO (verificato live): sezioni area cliente Credito / GiftCard /
  Prepagati / Omaggi / Fidelity / Preordini (port del menu tenant-panel
  BookingPublicUi.php 33-60, aggregate per attività collegata come le sezioni
  esistenti). Lib: listPublicCustomerCredit (saldo + ledger credit_adjustments),
  Giftcards (stato leggibile Attiva/Esaurita/Scaduta/Utilizzata/Annullata),
  Prepaids (residuo/qty/prezzo + stato), Gifts (gift_instances + stato legacy
  In accumulo/Disponibile/...), Fidelity (punti + tessera + movimenti
  transactions), Preorders (sale_items prodotto ordered/collected, port di
  booking.php 10548-10620 — stati Ordinato/Ritirato/Scaduto). Route
  /api/account: azioni credit/giftcards/prepaids/gifts/fidelity/preorders (+
  alias my_*). UI: 6 voci nav + view con badge stato, empty state e lazy-load;
  la view Prepagati espone il deep-link P2 "Prenota"
  (/slug/booking?book_prepaid=id&service_id=). Test live con setup usa-e-getta
  (credito+movimenti, giftcard, punti+tessera, sezioni vuote gracefully),
  cleanup completo incluso il ledger credit_adjustments.
- P5 CHIUSO: azioni post-conferma del wizard pubblico (booking.php ~8928-8931):
  pulsante "Aggiungi al calendario" (.ics via /api/account/ics?code=, mostrato
  solo con sessione cliente attiva E prenotazione collegata all'account —
  l'endpoint serve solo le prenotazioni del cliente loggato, come il legacy
  login-gated) + pulsante "Stampa" (window.print) nell'alert di conferma.
- C6 CHIUSO: colonna SSO "Senza Operatore" nel calendario (calendar.php 54-60):
  calendarStaff ora include la riga staff 'SSO' SOLO se esiste almeno un
  servizio attivo no_operator (altrimenti la filtra), la crea se manca
  (ensure_sso_staff_exists) e la ordina per ULTIMA.
- P4-parziale CHIUSO (verificato live): pagina PREVENTIVO PUBBLICO via token
  (port di quote_public.php, accesso senza login). API /api/public/quote
  (?slug&token 32/64hex): draft -> 404 (mai pubblico), sent oltre valid_until
  -> Scaduto, stato effettivo con label/badge legacy; payload con anagrafiche
  azienda (profilo quote_* + override location) e cliente (snapshot), voci
  (SKU/sconto%/IVA), totali, nota pubblica, metodi di pagamento (JSON o
  newline), termini, footer. Componente QuotePublicFaithful su
  /<slug>/quote_public?token= (l'URL che le email preventivo già linkano!)
  con markup legacy + quote_public.css portato + Stampa. Test live: token
  invalido 404, bozza 404, inviato -> payload completo e pagina 200; delete
  del preventivo di test rifiutato dal guard legacy ("solo bozze") -> pulito
  via SQL. NON portato: "Scarica PDF" (QuotePdf = infra rinviata); restano
  gdpr_public/consent_public (firma elettronica + PDF, stessa infra).
- EMBED (P6) COPERTO BY-DESIGN: la pagina /slug/booking del Next è già
  chrome-less (body embed-body, nessuna topbar marketplace) e iframabile;
  embed=1 nel legacy serviva a nascondere la UI del portale. Il parametro
  viene accettato senza effetti (nessun X-Frame-Options bloccante).
- Q2 CHIUSO: modali dettaglio residui nel drawer. quickBookClientResidualsDetail
  esteso con gli id sorgente (prepaid id/service_id, giftcard id, package id +
  service_id per seduta, giftbox instance_id + giftbox_item_id/service_id,
  gift instance_id/reward_item_index/service_id — verificato live nel payload).
  Drawer: click sulla PILL del servizio collegato a un redeem (priorità legacy
  giftbox>gift>pacchetto>prepagato, data-* di tracciabilità) o sulla label
  "GiftCard (codice)" del pannello prezzi -> modal dettaglio React-driven con
  gli id legacy (#qbPackageInfoModal ecc.): header tipo+titolo+"Apri in nuova
  scheda"+sottotitolo legacy, body con Stato/Scade (end-of-day)/Residuo
  complessivo, riga "Servizio selezionato", card "Dettaglio sedute"/"Contenuto
  GiftBox" con highlight della riga selezionata ("Selezionato in questa
  prenotazione") e badge rem/tot. Dati dal payload residuals condiviso
  (fetchResidualsDetail rifattorizzato). Non portato: lista movimenti
  dell'omaggio (qbGiftTxLabel) — il payload non traccia le transazioni gift.

## Item 30 — STORAGE FILE su Cloudflare R2 (2026-07-02, decisione utente)
Deciso: i file vanno su Cloudflare R2 (S3-compatibile) invece di S3 — zero
egress per le immagini pubbliche, custom domain via CDN Cloudflare, bucket con
giurisdizione EU per il GDPR. Lo stack resta: Amplify (app) + Supabase (DB) +
R2 (file) + SES (email) + OpenAPI (SMS) + EventBridge (cron).

Implementato:
- lib/storage.ts: client S3 su endpoint R2, DUE bucket (PUBLIC per immagini
  servite via R2_PUBLIC_BASE_URL con cache immutabile; PRIVATE per documenti,
  solo presigned GET a TTL breve dopo i check sessione+tenant), chiavi sempre
  namespaced t{tenantId}/<area>/..., storageConfigured() gate (pattern
  emailConfigured) con errore chiaro "Storage file non configurato...".
- PRIMO CONSUMATORE end-to-end: FOTO OPERATORE (port dell'upload
  operator_photo di staff.php). Route /api/manage/staff-photo (multipart,
  max 5MB legacy, jpeg/png/webp/gif, guard SSO, delete del vecchio oggetto
  alla sostituzione, remove_photo=1 per la rimozione); in staff.photo_path
  si salva l'URL PUBBLICO completo (staff_photo_url legacy passa gli http
  assoluti invariati -> compatibile nei due sensi; calendario/booking/lista
  usano già photoPath cosi com'è). Editor staff: box "Foto operatore" con
  anteprima circolare, input file, "Rimuovi foto"; upload DOPO staff_save
  (serve l'id in creazione). Divergenza documentata: niente crop/zoom client
  (photo_crop_data) — immagine salvata come caricata.
- Test live (senza credenziali): upload PNG -> "Storage file non
  configurato..." (503, nessuna scrittura DB), mime non valido -> "Formato
  immagine non supportato...". L'upload reale si verifica appena esistono i
  bucket.

SETUP R2 — COMPLETATO (2026-07-02): bucket prenodo-public/prenodo-private
(giurisdizione EU), token creato, variabili in .env.local. NOTA: i bucket EU
usano un ENDPOINT dedicato (...eu.r2.cloudflarestorage.com) -> aggiunta la
variabile R2_ENDPOINT (fallback: endpoint standard dall'account id).
R2_PUBLIC_BASE_URL per ora è il sottodominio r2.dev DI SVILUPPO
(pub-...r2.dev); quando i DNS del custom domain (media.<dominio>) sono
propagati va SOSTITUITO (+ ricaricati gli eventuali photo_path già salvati,
che contengono l'URL completo r2.dev). Le stesse variabili vanno replicate
negli env Amplify al deploy.

VERIFICA LIVE end-to-end (foto operatore, staff di test poi ripristinato):
  - upload PNG -> oggetto su t25/staff/<id>-<ts>.png, photo_path = URL
    pubblico, GET pubblico 200 image/png, photoPath presente nel context
    calendario (avatar colonna Giorno);
  - sostituzione -> nuovo oggetto, il VECCHIO risponde 404 (cancellato);
  - remove_photo -> photo_path NULL e oggetto 404;
  - round-trip bucket PRIVATO: PUT + presigned GET (200, contenuto identico)
    + DELETE, con cleanup.

CONSUMATORI R2 IMPLEMENTATI E VERIFICATI LIVE (2026-07-02, dati test ripuliti):
- FOTO OPERATORE (vedi sopra).
- IMMAGINE CATEGORIA SERVIZI (port dell'upload image_file di services.php
  tab=categories, max 5MB jpg/png/webp/gif): route /api/manage/category-image
  (upload/sostituzione con delete del vecchio/remove_image), image_url = URL
  pubblico; i modal Nuova/Modifica categoria hanno file input collegato +
  anteprima + "Rimuovi immagine" (in creazione l'id è risolto dalla lista
  restituita dal save). Il WIZARD pubblico ora riceve imageUrl nel context
  (PublicBookingCategory — prima le card step 2 non avevano proprio il campo)
  e la card mostra l'immagine con l'SVG di fallback legacy. Verificato:
  upload -> R2 -> GET 200 -> imageUrl nel context booking -> remove -> 404.
  Divergenza doc.: niente compressione/resize server (legacy 1600px).
- ALLEGATO COSTO (port del campo attachment di costs.php, SOLO PDF o JPG max
  5MB): route /api/manage/cost-attachment — POST multipart su bucket PRIVATO
  (attachment_path = KEY R2, + mime/name/size), GET = check sessione+tenant e
  302 verso presigned URL (5 min); path legacy non migrati -> messaggio
  chiaro. Editor costo: campo Allegato con link al file corrente + "Rimuovi
  allegato" (upload dopo save_cost, id risolto dalla lista in creazione);
  lista costi: il link graffetta ora punta alla route presigned (prima era
  un URL legacy inesistente). Verificato: upload PDF -> download 302 ->
  presigned 200 con contenuto %PDF -> remove -> colonne azzerate. Divergenza
  doc.: niente compressione GD/Ghostscript.

- DOCUMENTI CLIENTE (port del blocco customer_documents di clients.php
  ~2118-2179, era un TODO dichiarato del dettaglio cliente): route
  /api/manage/client-document — GET ?client_id= elenco / ?id= download (302
  presigned 5 min), POST multipart upload (titolo + doc, 10MB
  PDF/PNG/JPG/WEBP, estensione forzata dal MIME, nome random) o delete con i
  GUARD legacy (il documento GDPR ufficiale e i documenti ufficiali dei
  moduli consenso non si eliminano da qui — stringhe esatte). file_path =
  KEY R2 privata. UI: card "Documenti" nel dettaglio cliente (lista con link
  presigned, upload titolo+file, cestino con conferma; i path legacy non
  migrati sono mostrati senza link). La scheda semplificata del quick booking
  (quickBookClientCard) ora espone url funzionanti per i documenti R2 (prima
  sempre "" -> "Non disponibile"). Verificato live: upload -> lista ->
  download presigned 200 %PDF -> delete; dati test ripuliti.

- GALLERIA IMMAGINI PRODOTTO (port delle azioni AJAX di products.php:
  upload_image_ajax/delete_image_ajax/set_main_image + ProductPageHelpers):
  route /api/manage/product-image — GET lista, POST multipart con upload
  multiplo `images` (MAX 5 per prodotto, 5MB l'una, jpg/png/webp/gif, errori
  per-file come il legacy), delete (oggetto R2 + riga + rinormalizzazione
  ordinamento) e set_main (riordino legacy 0,10,20...; la prima è la
  principale). image_path = URL pubblico R2. Form prodotto: sezione
  "Immagini prodotto" — in EDIT galleria interattiva (thumb, badge/bottone
  Principale, cestino, upload immediato); in CREAZIONE i file selezionati
  partono dopo il save (id risolto dalla lista). Verificato live: upload x2
  -> set main (riordino 0/10) -> delete (lista rinormalizzata) -> pulizia.
  Divergenza doc.: niente compressione/resize server (legacy 2000px).

- PDF PREVENTIVO (port di QuotePdf.php quote_pdf_render — il MiniPdf
  hand-rolled del legacy — con pdfkit, font Helvetica standard senza asset):
  lib/quote-pdf.ts replica il layout 1:1 (A4/margine 40, header azienda,
  titolo PREVENTIVO, meta N./Data/Valido, blocco Cliente, tabella bordata con
  header grigio e re-header al salto pagina, righe multi-linea con SKU e
  "Sconto: N%", numerici allineati a destra, box totali grigio 240pt con
  Totale bold, paragrafi Nota/Metodi di pagamento/Condizioni/Footer, wrap
  testo port di MiniPdf::wrapText, fallback Condizioni = quote_terms del
  profilo). Route /api/public/quote/pdf (stesso gate token/bozza della pagina;
  filename legacy Preventivo_<num>.pdf); la page redirige ?format=pdf alla
  route — così l'URL PDF già presente nelle EMAIL preventivo funziona; nuovo
  bottone "Scarica PDF" nella pagina pubblica. next.config:
  serverExternalPackages pdfkit (legge i font AFM da node_modules a runtime).
  VERIFICATO VISIVAMENTE: PDF 200 application/pdf, layout identico al legacy,
  conti corretti (2x12 -10% = 21,60 + IVA 4,75 = 26,35). Dati test ripuliti.
  NB dev: dopo la modifica di next.config è servito rm -rf .next (la cache
  Turbopack corrotta faceva 404 su tutte le /api/manage).

- FIRMA GDPR PUBBLICA (port di gdpr_public.php + gdpr_public.js +
  PrivacyConsent.php + PrivacyPdf.php — verificata VISIVAMENTE):
  * lib/privacy-consent.ts: etichette consensi (+ fallback snapshot v1),
    template con variabili case-insensitive ({{nome}}, {{Dati anagrafici}} =
    profilo quote_*, {{dati_sede}} = site_*), lookup template dal modulo di
    sistema consent_modules privacy_gdpr -> businesses.gdpr_template_body ->
    default testuale identico, snapshot v2, stati draft/pending/signed
    normalizzati, filename GDPR_<NOME>_<COGNOME>.pdf. Divergenza doc.:
    niente override profilo legale per-sede (tenant mono-sede).
  * lib/privacy-pdf.ts: renderer pdfkit del privacy_pdf_build (titolo F2 15,
    heading GDPR noti in bold, bullet indentati, box firma bordato con righe
    [X]/[ ], Data, immagine firma max 210x50 con riga e caption "Firmato
    elettronicamente il ..." o riga "Firma cliente: ___"); la firma arriva
    come data URL png/jpeg (pdfkit embedda PNG direttamente — il legacy
    convertiva in JPEG solo per il suo MiniPdf). Stringhe errore legacy
    (Firma troppo grande/Formato firma non valido/...).
  * /api/public/gdpr: GET dati pagina (token 64hex su gdpr_public_token,
    solo pending/signed), GET format=pdf inline/download (pending = snapshot
    con riga firma; signed = documento UFFICIALE da customer_documents/R2
    privato, byte proxyati con gli header legacy), POST firma (valida,
    genera PDF firmato, salva 'Privacy firmata' su R2 + customer_documents,
    aggiorna clients document_id/status/signed_at/locked_at/snapshot; guard
    "Il documento privacy risulta gia confermato."; publicErrorMessage che
    non espone errori tecnici).
  * Pagina /<slug>/gdpr_public?token= (GdprPublicFaithful): header cliente +
    badge stato, Apri/Scarica PDF, iframe anteprima, riquadro FIRMA con
    canvas pointer-events (mouse/trackpad/dito), Pulisci, Conferma abilitato
    solo con tratto; dopo la firma la pagina passa a Firmato e l'iframe
    ricarica il documento ufficiale.
  * Test live end-to-end su cliente di test: pending -> PDF non firmato ->
    firma -> stato signed + PDF ufficiale (2 pagine: informativa dal
    TEMPLATE DEL TENANT via consent_modules + box consensi con firma e
    caption) -> doppia firma respinta col messaggio legacy. Cleanup totale
    (oggetto R2 + customer_documents + campi gdpr del cliente ripristinati).
  * ~~NON ancora portato: il lato MANAGE della richiesta firma e
    consent_public.php~~ -> FATTO, vedi blocco successivo.

- CONSENSI CLIENTE MANAGE + MODULI CONSENSO PUBBLICI (port COMPLETO di
  client_consents.php + ConsentModules.php lato record + consent_public.php —
  testato live end-to-end, PDF verificato visivamente):
  * lib/consent-records.ts: record client_consent_records (stati
    draft/pending/signed normalizzati come il GDPR), snapshot modulo
    (consent_module_snapshot_create: footer_mode/footer_title, v2 per
    gdpr_consents / v1 per signature_only), filename
    CONSENSO_<SLUG>_<NOME>_<COGNOME>.pdf, associa/pending/signed/reset,
    moduli attivi disponibili (esclude privacy_gdpr e i gia' associati) e le
    4 email legacy (firma GDPR, PDF privacy ufficiale, firma modulo, PDF
    modulo firmato) con bottone brand #8a1d52 dentro il template moderno;
    mittente privacy_mail_sender -> con SES il From resta il dominio
    verificato e l'email del business va in Reply-To (divergenza doc.).
  * /api/manage/client-gdpr (perm client_consents.manage): GET stato pagina
    completo (box GDPR + record raggruppati per stato + moduli associabili),
    GET do=gdpr_print / do=consent_print (PDF solo in bozza, guard legacy),
    POST _mode=gdpr_action (save_consents/send_signature/manual_upload/
    send_privacy/reset — messaggi esatti, ROLLBACK di token/stato se l'email
    non parte, consensi salvati prima di ogni azione in bozza come il form
    legacy), _mode=associate_module, _mode=consent_record_action
    (send_signature/manual_upload/send_pdf/remove/reset con i guard "Il
    modulo e bloccato..." / documento ufficiale collegato / modulo
    disattivato). Upload PDF firmato: 10MB, solo application/pdf, R2 privato
    t{tid}/clients/{cid}/<random>.pdf + customer_documents.
  * client_consents-content.tsx ricablato da forma-morta-verso-index.php a
    interamente DB-backed: checkbox consensi (bloccati fuori bozza), bottoni
    per stato, upload manuale, conferme window.confirm coi testi
    data-client-consents-confirm, Apri richiesta di firma / Apri PDF
    ufficiale, associazione moduli con select, gruppi Da completare/In
    attesa/Firmati.
  * /api/public/consent + /<slug>/consent_public?token= (ConsentPublicFaithful):
    gemella della pagina GDPR sul record modulo (GET dati/PDF con footer del
    modulo, POST firma con caption "Firmato elettronicamente il ...",
    documento 'X firmato', guard "Il documento risulta gia confermato.").
  * FIX robustezza scoperto nei test: un PNG firma CORROTTO mandava pdfkit
    in Z_DATA_ERROR asincrono (uncaughtException + richiesta appesa minuti)
    — ora privacyDecodeSignature valida l'integrita' (signature PNG + IDAT
    inflateSync, SOI per JPEG) e risponde subito "Firma non valida".
  * Test live (cliente + modulo usa-e-getta, tutto ripulito incl. R2):
    save_consents, stampa PDF bozza, send_signature con rollback (email non
    configurata), manual_upload -> signed, guard su save/print/remove/delete
    documento, send_privacy/send_pdf, reset, associa/rimuovi modulo,
    pending -> firma pubblica -> signed con PDF ufficiale (visivamente
    corretto: footer "Conferma e firma cliente", firma embedded, caption),
    doppia firma respinta, firma corrotta respinta.

Prossimi consumatori (stesso pattern): foto nelle schede cliente
(client_sheet_records values_json — legato al porting completo delle schede,
oggi display-only). Le immagini prodotto nel marketplace/showcase si
collegano quando si porta quella vista.

## Divergenze intenzionali documentate (non bug)
- Redeem consumati alla CREAZIONE appuntamento (modello prenotazione, più sicuro;
  legacy consuma al "done") — approvato.
- Promozioni: applicazione con click esplicito "Rileva" (legacy auto-applica).
- point_lots/scadenza punti non scritti (subsystem dormiente anche di fatto nel legacy).
- Allegati: costi/documenti/foto operatori/gallery prodotti/categorie FATTI su
  R2; restano foto schede cliente (col porting schede) e immagini marketplace.
- PDF preventivi/GDPR/consensi FATTI (pdfkit); invio email attivo appena SES
  e' configurato (emailConfigured) — i flussi gestiscono gia' il fallimento.
- Limiti per-cliente/giorno promozioni registrati ma non applicati al checkout.

## Bug trovati + fixati in questa verifica (2026-07-02)
- **Griglia Orari settimanali**: era uno stub (nessun prefill, form senza handler →
  non salvava nulla). Ora componente controllato: prefill dal context + POST
  `action=hours_save`. e2e verde.
- **Lettura business_hours (Postgres NULLS)**: `ORDER BY location_id ASC` mette i
  NULL per ULTIMI su Postgres (su MySQL per primi) → la riga globale sovrascriveva
  quella per-sede in lettura. Fix: `(location_id IS NULL) DESC` (fedele al legacy).
  Lo slot-engine del booking non era affetto (match esplicito per sede).
- Nota multi-sede: il calendario unisce le business_hours di TUTTE le sedi
  (irrilevante con 1 sede) — item nel backlog multi-sede.
- Verificata parità campi form Impostazioni (business_profile, automation,
  accessibility, hours, roles, pos_settings): 100% presenti nei componenti Next.

## Pulizia codice fatta in questa sessione
- FOUC pagine auth eliminato (CSS SSR + precedence).
- `/logout` reale (route dedicata, cancella cookie sessione).
- Home `/` = marketplace migrato; eliminato `public-marketplace.tsx` (465 righe morte).

## AUDIT PAGAMENTI/POS (2026-07-03) — matrice di parita legacy <-> Next

Metodo: 4 mappe complete (pos.php 7148 righe, pos_history/pos_sale_detail/
rate/prepagati/preordini/CreditRechargeCancel, sottosistema credito/wallet,
implementazione Next) + batteria di 30+ test live sull'API Next con verifica
dei side-effect su DB (cliente/prodotto usa-e-getta, tutto ripulito).

VERDETTO: il modulo e' molto piu' completo di quanto dicano i commenti header
di pos-content.tsx (righe 53-56 e 2224 sono STALE: dichiarano "non-wired"
flussi che sono cablati e testati). Checkout, sconti, coupon/promo/punti,
ricariche con bonus, tender wallet/giftcard, rate, preordini (anche ritiro
PARZIALE con split riga), prepagati, annullo con ripristini (wallet,
giftcard, stock, punti, void ricariche), delete vendite annullate, Movimenti,
dettaglio vendita, impostazioni scadenze: TUTTI verificati live e funzionanti.

GAP CONFERMATI DAI TEST (in ordine di gravita'):
- [CHIUSO 2026-07-03] P1 ESCLUSIVITA' CARRELLO: il Next accetta ricarica+servizio e
  giftcard+servizio nella stessa vendita (emettendo pure gli artefatti).
  Legacy vieta (pos.php 3327-3415, 3966-3999): ricarica non cumulabile,
  giftcard esclusiva e max 1, GiftBox<->GiftCard/ricariche vietate, niente
  credito/giftcard/coupon/promo/punti/rate su vendite con ricariche.
- [CHIUSO 2026-07-03] P2 RATE: markInstallmentPaid non validava l'importo (accettato 5 su rata da
  3, salvato paid_amount=5). Legacy: "L'importo incassato deve corrispondere
  all'importo della rata." (tol 0.005) + validazione data. Messaggi diversi
  ("Rata annullata." vs "Non puoi incassare una rata annullata.").
- [CHIUSO 2026-07-03] P3 default item_status servizio con cliente = 'prepaid' (manage-pos.ts
  normalizeItemStatus) — legacy default 'executed'. La UI manda sempre lo
  status esplicito, ma a livello API i dati divergono.
- [CHIUSO 2026-07-03] P4 righe vendita speciali: recharge/giftcard scritte come item_type
  'service' con nome nudo "Ricarica"/"GiftCard" (legacy: 'product' +
  "GiftCard (CODE)" / "Ricarica credito - titolo (+bonus)"). Impatta le
  etichette dinamiche dei Movimenti e il matching R#/GC nelle note.
- [CHIUSO 2026-07-03] P5 rateizzazione semantica tender: il server esige pagamento pieno
  ("Pagamento insufficiente") e la UI aggira inviando l'intero totale anche
  quando in cassa entra solo l'acconto; il legacy non valida gli importi e
  annota "acconto X - residuo Y".
- [PARZIALE 2026-07-03] P6 credito: solo clients.credit_balance (manca il modello cards.credit del
  legacy); scalo manuale senza sede obbligatoria ne' colonne location/card su
  credit_adjustments.
- P7 fidelity_wallet: manca il sottosistema lotti/scadenze punti
  (point_lots): calendario scadenze, in-scadenza, avvisi cron/lock-lots,
  tabella warn_locked; clients.points aggiornato direttamente.
- [PARZIALE 2026-07-03] P8 paginazioni server (20/pag) mancanti su credit_movements (cap 300) e
  fidelity_wallet.
- [PARZIALE 2026-07-03] P9 formattazione messaggi: importi con punto invece di virgola nei
  messaggi credito; label punti hardcoded "Punti" invece della label tenant.
- [CHIUSO 2026-07-03] P10 deleteCancelledSale non purgava gli artefatti emessi ne' i movimenti
  commissioni (TODO dichiarato manage-pos.ts:1002) e senza le guardie
  profonde legacy (giftcard collegata ad altre vendite/prenotazioni ecc.).
- P11 installments_manage: scoping sede ignorato; acconto solo informativo.
- P12 non verificato: guardia legacy "ricarica collegata ad ALTRA vendita"
  (allocazione FIFO CreditRechargeCancel) nello storno — il Next ha una
  guardia sui punti ma la FIFO non e' riscontrata.
- P14 earn punti: TODO per-item eligibility + adhesion gate (dichiarato).
Non-gap: omaggi v2 (gift_instance_id) spenti anche nel legacy; email voucher
delegate al cron (scelta documentata); nessuna IVA/resto nel legacy.

### Chiusura gap POS P1/P2/P3 (2026-07-03, 24/24 test live PASS)
- P1 (commit sotto): assertCartExclusivityRules in checkoutManageSale — tutte
  le regole legacy con messaggi esatti: max 1 GiftCard/ricarica, ricarica e
  GiftCard vendite esclusive, GiftBox<->GiftCard/ricariche vietate, cliente
  obbligatorio per servizi/prodotti/ricariche/pacchetti (GiftBox esonera come
  il giftbox_draft legacy), divieti su vendita-ricarica (credito, GiftCard,
  coupon/promo, sconto manuale, punti, rateizzazione). NOTA: "Cliente banco"
  ora rifiutato al checkout col messaggio legacy (il PHP fa lo stesso).
- P2: markInstallmentPaid ora valida importo (= importo rata, tol 0.005,
  virgola/migliaia gestite; vuoto o 0 = importo pieno), data, tipo pagamento
  (set canonico cash/card/check/bank con TUTTI gli alias legacy, fallback
  rata -> piano) e rata/piano annullati ("Non puoi incassare una rata
  annullata."); markInstallmentPending idem ("Non puoi riaprire...").
- P3: default item_status servizio = 'executed' (era 'prepaid' con cliente).
Restano aperti: P4 (righe ricarica/giftcard item_type+nome), P5 (semantica
tender con rate), P6 (credito card-based + sede), P7 (point_lots), P8-P11.

### Chiusura gap POS P4 (2026-07-03, 8/8 test live PASS)
Righe sale_items nel formato legacy: giftcard/giftbox -> item_type 'product'
item_id NULL con nome "GiftCard • <code>" / "GiftBox • <code>" (update
post-emissione col codice reale); ricarica -> 'product' item_id 0 con
"Ricarica credito[ • titolo modello]"; pacchetto -> item_id = template id e
nome "Pacchetto: <nome> • Inizio dd/mm/YYYY - Fine dd/mm/YYYY" (troncato
190); prepagato -> riga 'service' con item_id del servizio + status prepaid;
item_status NULL sulle righe speciali (come gli INSERT legacy). SCOPERTA:
il MySQL legacy e' NON-strict e troncava l'enum 'package' a stringa vuota —
il Next implementa l'INTENTO ('package' reale) con capability-check sul
CHECK constraint: finche' il vincolo non e' allargato scrive 'service'
(fallback identico a prima, nessuna rottura). MIGRAZIONE DA APPLICARE
(schema.sql gia' aggiornato per le installazioni nuove):
  ALTER TABLE sale_items DROP CONSTRAINT sale_items_item_type_check;
  ALTER TABLE sale_items ADD CONSTRAINT sale_items_item_type_check
    CHECK (item_type IN ('service','product','package'));
Verificato anche che l'annullo vendita continua a matchare giftcard/giftbox
per codice col nuovo formato nome.

### Chiusura gap POS P5/P6/P8/P9 (2026-07-03, 14/14 test live PASS)
- P5 CHIUSO: con piano rate attivo il checkout richiede l'ACCONTO (non piu'
  il totale) — la UI mostra/invia come dovuto-ora l'acconto (dueNow) e il
  server ha il floor sull'acconto; nota vendita legacy "Rateizzazione:
  acconto € X • residuo € Y • N rate • prima scadenza YYYY-MM-DD".
- P6 CHIUSO (lato scalo manuale): sede obbligatoria col messaggio legacy
  "Seleziona una sede dalla barra superiore...", colonne location_id/
  location_name + card_id/card_code (tessera attiva via
  creditWalletActiveCard) su credit_adjustments; messaggio cliente bloccato
  = client_block_operational_message legacy. RESTA (deferred, sottosistema
  card-credit): il fallback saldo su cards.credit del legacy.
- P8 CHIUSO (credit_movements): paginazione server 20/pagina con clamp +
  controlli Precedente/Successiva in pagina. RESTA: paginazione
  fidelity_wallet (sottosistema punti/lotti, deferred con P7).
- P9 CHIUSO (credito): messaggi con fmt_money italiano (virgola/migliaia).
  RESTA: label punti dinamica del tenant (con P7/fidelity).

### Chiusura gap POS P10 (2026-07-03, 11/11 test live PASS)
deleteCancelledSale ora purga gli artefatti emessi dalla vendita con le
guardie legacy esatte (pos_sale_detail.php 2913-3060): GiftCard (deve essere
annullata; blockers prenotazioni/altre vendite; cancella transazioni+righe),
GiftBox (annullata; blockers appointment_giftbox_items/riscatti storici;
cancella transazioni/item/istanza + template orfano), Pacchetti (blocker
prenotazioni; cancella usi/transazioni/servizi/item), Prepagati (blocker
prenotazioni; cancella usi), Ricariche (devono essere stornate). Tutto in
UNA transazione tenant-scoped. Divergenze documentate: il blocker FIFO
"ricarica collegata a prenotazioni" non serve (il void Next ripristina il
credito) e i movimenti Commissioni restano al reconcile compute-on-view.
BONUS: le pulizie dei test ora sfruttano il purge automaticamente.

### Migrazione CHECK sale_items APPLICATA (2026-07-03, approvata dall'utente)
ALTER TABLE sale_items ... CHECK (item_type IN ('service','product','package'))
eseguito su Supabase: verificato e2e che la vendita pacchetto ora scrive
item_type='package' con item_id del template (capability-check attivo senza
riavvii aggiuntivi). NOTA operativa: dopo un riavvio del dev server la porta
3000 puo' restare occupata da un processo zombie che serve 404/500 — killare
il PID su :3000 prima di riavviare (visto oggi: login 404/500 ingannevoli).

AUDIT PAGAMENTI: TUTTI i gap azionabili sono chiusi (P1-P6, P8-P10 +
migrazione). Restano solo i differiti di sottosistema: FIDELITY (P7
point_lots/scadenze punti, label punti dinamica, paginazione fidelity_wallet,
campagne/adesione card, fallback saldo cards.credit) e MULTI-SEDE (P11
scoping Gestione Rate + filtri all_locations trasversali).

## AUDIT FIDELITY (2026-07-03) — matrice di parita legacy <-> Next

Metodo: 4 mappe (Fidelity.php 3609 + 2 cron; 5 pagine fidelity ~8k righe;
implementazione Next; motore omaggi Gifts.php 12.7k). Stato DB t25: cards,
point_lots, fidelity_campaigns, item_rules, gifts/events tutti VUOTI; 16
transactions (il ledger punti base e' vivo).

GIA' A PARITA' (verificato dalle mappe): toggle globale con blocchi promo/
omaggi + conferma prenotazioni; settings punti (persistenza); campagne CRUD
complete (amount/tiers, min_spend, periodo con no-overlap, livelli target,
soft-delete); tessere (emissione con registro codici anti-riuso, stati,
riattiva, elimina con reset punti); livelli (editor split JSON, base level);
wallet (movimenti manuali con protezione reserved); earn SOLO sotto campagna
attiva (= legacy con schema campagne presente); redeem su 3 percorsi; dedup
transazioni transactions_uq_fid_src; punti interi.

NON-GAP scoperti (il legacy li ha RIMOSSI — il Next e' gia' corretto):
- label punti personalizzata: legacy FISSA 'Punti' (Fidelity.php:329) — la
  "label dinamica" segnata come TODO in P9/P7 NON esiste piu' nel legacy.
- item_rules per-item nelle campagne: legacy le salva sempre vuote
  (fidelity_points.php:2647, save_rule/delete_rule deprecati) e le applica
  SOLO nel ramo senza-schema-campagne, che nel Next non esiste mai.
- earn_mode/conflict_policy/redeem_auto_discount: costanti nel legacy.

GAP CONFERMATI (ordine di gravita'):
- [CHIUSO 2026-07-03] F1 POINT_LOTS mai scritti: scadenza punti configurabile ma NON operativa.
  Manca l'intero motore lotti (creazione su earn, consumo FIFO con lock
  first, lotto legacy-init, expire con lock/unlock per prenotazioni
  protette, reconcile, applyExpirySettingsToOpenLots al salvataggio, punti
  in scadenza/scaduti nel wallet, calendario scadenze, 2 cron).
- [CHIUSO 2026-07-03] F2 ADESIONE TESSERA incoerente: earn POS + redeem POS non chiamano
  fidelityIsClientAdhering (prenotazioni e pubblico si'). Legacy: earn/
  manual bloccati per non-aderenti, availablePoints=0 senza tessera; il
  fallback adhesion_mode (all/include/exclude) si applica SOLO se la
  tabella cards NON esiste. Include eligibility earn ricariche.
- [CHIUSO 2026-07-03] F3 TOGGLE: mancava il RIPRISTINO su riattivazione (promotions/gifts
  auto_disabled_by_fidelity -> riattivati) + auto_disabled_by_points sulle
  campagne quando si spengono i punti + messaggi composti legacy.
- [CHIUSO 2026-07-03] F4 LIVELLI mai promossi: clients.fidelity_level mai ricalcolato
  (legacy: recalcClientLevelLocked su ogni transazione, earnedPointsInLastDays
  su level_period_days) -> le campagne per-livello sono inerti. Manca anche
  la cascata cleanup livelli eliminati (promo/omaggi/campagne aggiornati o
  disattivati + prenotazioni pulite) e i preview/conferme.
- [CHIUSO 2026-07-03] F5 TESSERE: rinnovo automatico su attivita' (fidelity_card_try_auto_renew
  _by_activity su earn sale/appointment) non implementato; membership
  settings senza applyMode (preserve/disable_expiry con snapshot/
  restore_existing_from_snapshot), campi restore non inviati, modal
  conferma morta, "Nessuna modifica da salvare.".
- [CHIUSO 2026-07-03] F6 SAVE_SETTINGS punti: mancavano conferme popup legacy (rimozione sconti
  da prenotazioni aperte su disattivazione, conferma cambio scadenza) +
  messaggi composti + applyExpirySettingsToOpenLots post-commit (dipende F1).
- [CHIUSO 2026-07-03] F7 UI MORTA in fidelity_points-content.tsx: 5 modali senza handler
  (161-390), form livelli duplicato inerte (563-747), seconda tabella
  campagne statica (749-787), statistiche hardcoded 0 (795-826), banner
  campagna statico (143-151), header obsoleto.
- [CHIUSO 2026-07-03] F8 fidelity_wallet: paginazione 20/pag + sezioni scadenze (con F1).
- F12 GIFTS V2 (omaggi): portato ~30-35% (CRUD campagne + redeem in
  prenotazione). MANCA il motore: tabella events mai scritta (recordSale/
  recordAppointmentDone/recordProductOrder), recalcClient/evaluateRules
  (5 tipi regola, set AND/OR, finestra anti-retroattiva, gift_progress_
  resets), detail istanza + azioni operatore (riscatto parziale, annullo,
  eliminazione, note, voucher email), assegnazione manuale, riscatto in
  POS (gift_instance_id), editor avanzato (livelli/esclusioni/multi-set/
  clone), GiftLoyaltyAttribution. Tenant 25: 0 omaggi (dormiente).

PIANO BLOCCHI (ordine proposto):
1. F1 motore point_lots + scadenze + wallet UI + cron (il piu' grande del
   core fidelity; abilita anche la parte scadenze di F6/F8)
2. F2 adesione coerente + eligibility ricariche + auto-renew tessera (F5a)
3. F4 promozione livelli + cascata cleanup + preview
4. F3+F6 toggle/settings parity (ripristini, conferme, messaggi composti)
5. F5b membership settings applyMode/snapshot + F7 pulizia UI morta
6. F12 Gifts v2 (area a se', 4-5 sotto-blocchi — solo se vuoi il modulo
   omaggi operativo: oggi il tenant non lo usa)

### Chiusura gap FIDELITY F1+F8 (2026-07-03, 11/11 comportamenti verificati live)
Nuovo lib/fidelity-lots.ts — port di Fidelity.php ~2138-3594: lotto per ogni
earn (expires_at = fine giornata earned_at+expire_days), init 'legacy' sui
saldi senza lotti, consumo FIFO sui redeem (lock-first, scadenza crescente,
NULL per ultimi; senza filtro con scadenza off), scadenza con lock/unlock
(protectedReserved = prenotazioni aperte create prima di oggi; requiredLocked
= min(protetti, lock+scaduti); lock@YmdHis con expires NULL e source_id del
lotto origine; unlock con scadenza dal metadato, fallback just-before-now),
transazioni kind='expire' source='lot' idempotenti sul vincolo unico,
reconcile che NON tocca clients.points, applyExpirySettingsToOpenLots al
salvataggio impostazioni, expiringSoonPoints e calendario lotti.
AGGANCI: addDbWalletMovement (tutte le transazioni punti: earn POS/appuntamenti,
redeem, storni) + fidelityWalletManualMove + expire-on-read su wallet detail,
residui POS e resolveFidelityRedemption + saveFidelityPointsSettings.
UI wallet: card "In scadenza (N gg)", Calendario scadenze, avvisi (disponibile
negativo, punti vincolati, scaduti non processati), paginazione 20/pag su
movimenti e prenotati (chiude F8).
SCOPERTA: i 2 cron (api/cron/fidelity-expire + fidelity-reconcile-lots)
ESISTEVANO gia' come port completi self-contained (l'audit li aveva mancati) —
mantenuti; la lib e' allineata al loro comportamento (stesso fallback
parseLockExpiry, stessi source_id). Duplicazione della logica lotti tra lib e
cron annotata come debito tecnico accettato.
Test live: earn->lotto, manuale->lotto, FIFO 7 su 2 lotti, expire-on-read con
transazione -8 e saldo ridotto, lock parziale min(prenotati,disponibili)=1
con avviso UI, unlock->expire al giro successivo, cambio scadenza 30->60gg
riallinea, expiringSoon nella warn window, cron ok. Cleanup completo; il
lotto legacy-init di Luca Rossi (22pt, senza scadenza) e' il backfill
CORRETTO del motore sul saldo preesistente.

### Chiusura gap FIDELITY F2 + auto-renew F5a (2026-07-03, 10/10 test live PASS)
Adesione tessera (fidelityIsClientAdhering) ora richiesta OVUNQUE come nel
legacy: earn al checkout POS, earn al completamento appuntamento
(handleAppointmentStatusChange ~2603), eligibility punti sulle ricariche
(credit_wallet_recharge_points_eligible), redeem in cassa
(resolveFidelityRedemption -> "Cliente non aderisce alla Fidelity.") e residui
POS (punti spendibili = 0 senza tessera attiva, box redeem non offerto).
I percorsi prenotazioni/pubblico erano gia' gated. NOTA OPERATIVA: senza
tessere emesse i punti NON si accumulano piu' (comportamento PHP identico) —
le tessere si emettono da Fidelity -> Adesione.
AUTO-RENEW tessera (fidelity_card_try_auto_renew_by_activity, Helpers ~4975):
un earn da vendita/appuntamento dentro la finestra di rinnovo estende
expires_at di una durata piena (validity da fidelity_adhesion_json); fuori
finestra o dopo la scadenza nessun rinnovo. Agganciato in addDbWalletMovement
(earn>0 con source sale/appointment). Verificato: +12 mesi in finestra,
invariata fuori finestra.

### Chiusura gap FIDELITY F4 (2026-07-03, 9/9 test live PASS)
- calcClientFidelityLevelKey (port calcClientLevelPoints ~2774 +
  earnedPointsInLastDays): livello dal MATURATO (delta positivi in
  transactions nel periodo fidelity_level_period_days, 0=sempre), ''
  per non aderenti o sezione spenta; il redeem non abbassa il livello.
- recalcClientFidelityLevel agganciato a: ogni transazione punti
  (addDbWalletMovement), emissione/stato/riattivazione tessera, e
  save_levels (ricalcolo di massa: titolari tessera + livelli residui).
- CASCATA livelli eliminati (port fidelity_levels_cleanup_deleted_levels):
  key rimosse da fidelity_campaigns.eligible_points_levels,
  promotions.target_fidelity_levels (target_type=fidelity) e
  gifts.eligible_levels_points; righe rimaste senza livelli target ->
  disattivate; prenotazioni aperte delle promo disattivate ripulite.
  Guard conferma legacy ("Conferma prima l'eliminazione del livello a punti
  \"X\".") + confirm nella UI livelli con flag fidelity_delete_confirmed;
  messaggio composto "Livelli Card salvati. N campagne punti disattivate...".
Verificato live: base->argento->oro con gli earn, redeem non retrocede,
eliminazione livello senza conferma rifiutata, con conferma cascata su
campagna target (svuotata+disattivata) e livello cliente ricalcolato oro->
argento. RESTA (minore): la firma-hash legacy per la conferma cambio soglie
(qui la conferma copre le eliminazioni; il cambio soglie ricalcola e basta).

### Chiusura gap FIDELITY F3+F6 (2026-07-03, 13/13 test live PASS)
- F3 toggle_fidelity: riattivazione ripristina promozioni/omaggi
  auto_disabled_by_fidelity (messaggi "N campagna/e Promozioni target Fidelity
  riattivata/e" / "N campagna/e Omaggi..."); disattivazione marca le campagne
  punti con auto_disabled_by_points=1 e compone il messaggio legacy
  ("Fidelity disattivata. N campagna punti attiva disattivata. Rimosse
  automaticamente le agevolazioni Fidelity da N prenotazioni"); blocco promo/
  omaggi attivi gia' presente e riverificato.
- F6 save_settings: conferme popup legacy come round-trip server->confirm->
  retry con flag (disattivazione punti/redeem con prenotazioni aperte
  impattate: 'Prima di disattivare "X" conferma dal popup...'; cambio
  scadenza: 'Prima di modificare la scadenza punti conferma dal popup...');
  strip confermato delle agevolazioni (punti riservati ripristinati al saldo
  nel modello a detrazione del Next); campagne disattivate con auto flag ai
  punti-off; messaggio composto completo. applyExpirySettingsToOpenLots
  spostato sotto il guard expiryChanged unico.

### Chiusura gap FIDELITY F5b+F7 (2026-07-03, 11/11 comportamenti verificati)
- F5b saveFidelityCardValidityDefault ora e' il port COMPLETO del legacy:
  applyMode preserve_existing / disable_expiry (snapshot {cardId: scadenza} +
  card_existing_restore_value/unit nel JSON, tessere rese senza scadenza,
  scadute-inactive riattivate) / restore_existing_from_snapshot (scadenze
  recuperate dallo snapshot, fallback issued_at+durata, ripristinate-scadute
  -> inactive); "Nessuna modifica da salvare."; conferma obbligatoria come
  round-trip confirm+flag (modal statica rimossa); clamp finestra rinnovo <
  durata con suffisso messaggio; messaggi legacy per modalita' passati dal
  dispatcher configuration.
- F7 fidelity_points-content dimezzato (38.8k -> 19k): rimosse le 5 modali
  morte, il form livelli duplicato inerte (sostituito da card riepilogo ->
  editor fidelity_levels) e la seconda tabella campagne statica; banner
  "nessuna campagna attiva" ora DINAMICO (stats.activeCampaignToday);
  statistiche reali via getFidelityPointsStats (emessi/usati/scaduti dal
  ledger transactions + campagne attive) esposte su GET points_settings;
  header aggiornato.

## AREA FIDELITY CORE COMPLETA (F1-F8 tutti chiusi, 2026-07-03).
Resta solo F12 Gifts v2 (motore omaggi, ~65% mancante) come area opzionale
dedicata + i non-gap documentati (label punti fissa, item_rules dismesse).

### CHIUSURA F12 BLOCCO 1 — MOTORE GIFTS V2 (2026-07-03, 24 test live PASS)
Nuovo `lib/gifts-engine.ts`, port del motore di app/lib/Gifts.php (tracking
~4137-4716, resets/finestre ~6150-6660, recalcClient ~7258-7996,
evaluateRulesForClient ~8151-8526, scadenze ~10759-10883):
- EVENTI: giftUpsertTrackingEvent = INSERT ... ON CONFLICT sull'indice unico
  events_uq_fid_events_src (tenant_id,event_type,source_type,source_id,
  source_line_id) — idempotente, is_valid torna 1 al re-record; invalidazione
  SOLO via UPDATE is_valid=0 per sorgente (giftInvalidateSource, con recalc
  forceRecheck dei clienti coinvolti). giftRecordSale: righe service/product
  con sconto vendita ripartito proporzionalmente (source_line_id =
  sale_item_id); giftRecordAppointmentDone: righe appointment_services NON
  residuali (esclusi i service_id riscattati via appointment_gift/giftbox/
  package/prepaid_service_items), raggruppate per servizio (source_line_id =
  service_id), sconto appuntamento ripartito; se non resta nulla invalida gli
  eventi della sorgente. recordProductOrder legacy = no-op, NON portato.
- REGOLE: service_qty/product_qty contano COUNT(DISTINCT source_type:source_id)
  (2 righe stessa vendita = 1, verificato B1), appointments_count DISTINCT
  source_id, total_spend SUM(amount) netto sconti (B2), first_visit forzata a
  appointments_count>=1; comparatori >,>=,=,<=,< con eps 1e-7; set in OR tra
  loro, and/or dentro il set. Finestra anti-retroattiva: from = max(valid_from,
  gifts.created_at, ultimo riscatto+1s, reset persistiti+1s, created_at di
  set/regola), to = valid_to; doppio filtro anche su events.created_at.
  fidelity_only: adesione attuale richiesta + contano solo gli eventi dentro
  la finestra di validita' di una tessera del cliente (granularita' a giorno
  come il DATE legacy: same-day emesso = coperto; verificato B3 con eventi
  retrodatati esclusi).
- MATURAZIONE (giftRecalcClient): esclusioni excluded_client_ids, campagna
  attiva ORA (fuori periodo: accumulo->scaduto a fine campagna, congelamento
  altrimenti), single-use = un'istanza disponibile/riscattato/scaduto blocca
  nuovi cicli (T6), una sola istanza attiva per gift+cliente (duplicate
  chiuse), istanza accumulo creata solo al primo progresso, unlock
  accumulo->disponibile al MOMENTO del ricalcolo (unlocked_at=now, expires_at
  = fine giornata now+expires_after_days), regressione disponibile->accumulo
  SOLO con forceRecheck (storni, T4: la rivalutazione usa la finestra congelata
  a unlocked_at), progress_json = esito valutazione + stato.
- SCADENZE: giftExpireInstance (disponibile oltre expires_at -> 'scaduto' +
  annullo prenotazioni pending/scheduled collegate via appointment_gift_items);
  giftExpireDueInstancesBatch agganciato al cron api/cron/fidelity-expire
  (campo giftsExpired nel risultato per tenant, T8 verificato via CRON_SECRET).
- AGGANCI: checkoutManageSale -> giftRecordSale (best-effort, dopo l'insert
  righe); cancelManageSale -> giftInvalidateSource('sale'); appointments route
  status->done -> giftRecordAppointmentDone; cancel_done da 'done' ->
  giftInvalidateSource('appointment') (T9); sync-on-read in
  quickBookClientGifts (drawer "Usa Omaggio") = Gifts::syncClientProgressOnRead.
- DIVERGENZE DOCUMENTATE: filtro residuali applicato alla REGISTRAZIONE (gli
  eventi Next nascono gia' filtrati; il filtro gemello in valutazione del
  legacy serve solo per dati storici MySQL); intervalli di sospensione
  campagna (gift_progress_resets campaign_disabled_start/end) NON ancora
  esclusi dal conteggio (i marker sono pero' gia' esclusi dal calcolo del
  reset-floor); token voucher lazy ensureGiftVoucherToken pronto per Blocco 2.
- TEST (2 batterie, 24 PASS, cleanup CLEAN): T1-T9 ciclo completo (evento
  vendita, accumulo 1/2, unlock con scadenza 23:59:59, idempotenza, storno ->
  is_valid=0 + regressione, ri-unlock, single-use, appointment_done con
  amount netto, cron scadenza, cancel-done); B1-B3 meccaniche fini (DISTINCT
  per vendita, sconto ripartito su total_spend, fidelity_only con copertura
  tessera per-evento).
Prossimi blocchi F12: B2 pagina istanza + azioni (riscatto parziale/annullo/
note/voucher email), B3 assegnazione manuale + redeem POS, B4 editor avanzato
(livelli/esclusioni/multi-set/clona) + GiftLoyaltyAttribution.

### CHIUSURA F12 BLOCCO 2 — DETTAGLIO ISTANZA + AZIONI (2026-07-03, 21 test PASS)
Port di gift_instance.php (1188 righe) + le funzioni istanza di Gifts.php.
Nuovo `lib/gifts-instances.ts`:
- DETTAGLIO (getGiftInstanceDetail = instanceDetails ~4931 + pagina): codice
  OM-000000, stato con badge legacy, date (creato/sbloccato/scadenza/annullo),
  progressione regole da progress_json (✅/⏳ label: current/needed + badge
  ASSEGNAZIONE MANUALE), reward items "Tot/Usati/Da riscattare" via
  redeemedRewardQtyByInstance (SUM redeem-cancel da gift_transactions per
  chiave reward_item_index:service_id + fallback appointment_gift_items
  redeemed_at senza doppi conteggi), quantità "in sospeso" su prenotazioni
  pending/scheduled, movimenti (listTransactions, label italiane per tipo +
  riga virtuale Emissione), prenotazioni collegate, token voucher lazy.
- STATO DERIVATO (applyDerivedInstanceState ~2095-2171): fully-redeemed ->
  chiusura a 'riscattato'; riscattato con residuo tornato >0 -> REOPEN a
  'disponibile' con redeemed_* azzerati (verificato C5); accumulo oltre
  valid_to -> scaduto; disponibile oltre expires_at -> scaduto via engine.
- RISCATTO PARZIALE (redeemGiftInstanceItems ~5152): selezione per item
  troncata al residuo, pre-validazione "Quantità non disponibile per "X". N
  già in sospeso su prenotazioni.", guardie legacy (non attivo/non
  disponibile/scaduto/"Cliente non aderisce alla Fidelity" con override
  manuale), tx redeem per item (nota default "Riscatto manuale"/"Riscatto su
  prenotazione #N"), stock premio prodotto decrementato best-effort, chiusura
  SOLO a residuo 0 con points_spent=0 e recalc per i ripetibili; messaggi
  "Riscatto registrato"/"Omaggio riscattato completamente". Il parametro API
  è redeem_qty_json (stringa JSON: parseRequestBody appiattisce gli oggetti).
- ANNULLO (cancelGiftInstance ~5395): solo da disponibile ("Solo un omaggio
  disponibile può essere annullato"), blocco con conferma popup se esistono
  prenotazioni collegate ("Sono presenti prenotazioni collegate... Conferma
  l'annullamento dal popup per procedere." -> round-trip confirm UI), annullo
  automatico prenotazioni + suffisso ": annullate automaticamente N...",
  progress_json con marcatori reset (reset_window_from = now+1s), tx
  gift_cancel, chiusura altre istanze attive dello stesso gift/cliente.
- ELIMINAZIONE (deleteClosedGiftInstance ~5529): solo accumulo/annullato/
  scaduto, elimina prenotazioni collegate via deleteDbAppointment (con
  redeem-restore), purga appointment_gift_items + gift_transactions, scrive il
  marker in gift_progress_resets (source_state = stato alla delete) e ricalcola.
- NOTE: nota cliente (visibile su voucher/email) e nota interna (solo
  backend), max 2000, messaggi "Nota cliente salvata"/"Nota interna salvata".
- EMAIL VOUCHER (sendGiftVoucherEmailManage ~12200): guardie per stato
  (annullato/scaduto/già riscattato/non ancora disponibile), HTML legacy
  (header verde, codice OM + "MOSTRA QUESTO CODICE IN CASSA", bottone "Vedi
  Voucher" -> /slug/gift_voucher?public=1&embed=1&token=, dettagli, contenuto,
  nota cliente, condizioni), oggetto legacy, last_email_sent_at/to aggiornati.
- ASSEGNAZIONE MANUALE (assignGiftManual ~5883): validità obbligatoria del
  gift, idoneità con force_ineligible round-trip (ineligible+canForce ->
  confirm UI), doppioni ("Omaggio già disponibile...", "Campagna già maturata
  ..."), nasce DISPONIBILE con unlocked_at=now e scadenza fine giornata
  (+expires_days override o expires_after_days), progress_json manual=true,
  riusa un accumulo attivo se presente.
- UI: components/modules/gift_instance-content.tsx (layout legacy 2 colonne:
  riepilogo/invio voucher/riscatta anche parziale con "Seleziona tutti i
  rimanenti"/nota cliente/nota interna + colonna Movimenti a 7 colonne),
  sezione "Omaggi assegnati" in gifts-content (filtri stato+cliente,
  paginazione 25, badge stato legacy, link occhio al dettaglio, form
  "Assegna gift manualmente" con datalist clienti), route fedele
  /slug/gift_instance?id=N nel router.
- VOUCHER PUBBLICO: /slug/gift_voucher?public=1&embed=1&token=<64hex> (router
  pre-sessione) -> components/public/gift-voucher-faithful.tsx (watermark per
  stato, tabella VOCE/TOT/USATA/RIMANENTE, nota cliente, condizioni con
  default 3 righe, barcode JsBarcode, stampa) su /api/public/gift-voucher
  (token-only 64hex, 404 sul miss).
- TEST (21 PASS, cleanup CLEAN): dettaglio completo, riscatto parziale con tx,
  chiusura completa points_spent=0, guard su riscattato, reopen derivato,
  annullo con tx gift_cancel, note, guard email, voucher pubblico (+404 e
  pagina senza login), delete con marker source_state e purge, assegnazione
  manuale con scadenza fine giornata e blocco doppione, lista filtrata,
  pagina manage 200.
Restano: B3 redeem POS con gift_instance_id (assegnazione manuale ANTICIPATA
qui), B4 editor avanzato (livelli/esclusioni/multi-set/clona/termini) +
GiftLoyaltyAttribution + esclusione intervalli sospensione dal conteggio.

### CHIUSURA F12 BLOCCO 3 — CICLO APPUNTAMENTI + POS (2026-07-03, 12 test PASS)
NON-GAP SCOPERTO (agente sul legacy): il riscatto omaggi dal POS e' CODICE
MORTO in pos.php — `$giftsV2Enabled = false` hard-coded (pos.php:96),
`$gift_instance_id = 0` mai popolato dal POST (pos.php:3156), UI rimossa con
commento esplicito ("l'assegnazione manuale degli omaggi da POS (tasto gift)
e' stata rimossa", pos.php:2073; "azione assign_gift rimossa", 2967) e
nessun riferimento in pos.js. Il design congelato (riga a 0 con prefisso
[giftsO], redeemInstance sourceType 'sale') NON e' raggiungibile dal PHP di
produzione: NON portato, per parita' 1:1. gift_transactions non ha sale_id
(solo appointment_id) — un eventuale futuro redeem POS richiederebbe schema.
Il flusso ATTIVO legacy e' solo quello appuntamenti, PENDING-UNTIL-DONE, e il
Next e' stato ALLINEATO (prima consumava al salvataggio senza transazioni):
- PRENOTAZIONE (applyAppointmentGiftRedeems, modello legacy
  saveAppointmentSelection ~11076): la riga appointment_gift_items nasce con
  redeemed_at NULL + transazione 'pending' ("In sospeso su prenotazione #N");
  l'istanza NON viene chiusa; il residuo prenotabile sottrae anche le unita'
  in sospeso su prenotazioni aperte (giftRewardPendingQty — la doppia
  prenotazione dello stesso premio resta senza copertura, E7); il drawer
  (quickBookClientGifts) esclude i premi gia' riservati.
- DONE (giftRedeemAppointmentSelectionIfAny in gifts-instances, port ~11565):
  legge le righe NULL, raggruppa per istanza e riscatta con sourceType
  'appointment' (transazioni 'redeem' con appointment_id, nota "Riscatto su
  prenotazione #N", chiusura istanza SOLO a residuo 0 con points_spent=0),
  poi marca redeemed_at sulle righe. Hook: appointments route status->done
  (PRIMA di giftRecordAppointmentDone, cosi' le righe omaggio risultano
  residuali per il tracking) e checkout POS con appointmentId.
- ROLLBACK (giftRollbackAppointmentSelection in gifts-engine, port ~11698):
  per ogni riga transazione 'cancel' (riscattata o rollback da annullo,
  "Annullato su prenotazione #N") o 'unlink' (in sospeso senza annullo,
  "Rimosso da prenotazione #N"), DELETE appointment_gift_items, riapertura a
  'disponibile' SOLO delle istanze chiuse da QUESTO appuntamento
  (redeemed_source_type='appointment' AND redeemed_source_id=id, ~11851-56),
  recalc forceRecheck. Hook: restoreAppointmentRedeems (percorso unico di
  cancel/no_show/cancel-done/delete) — il vecchio restoreGiftInstance
  per-riga e' stato RIMOSSO (riapriva anche istanze chiuse da altre fonti e
  lasciava righe consumate che lo stato derivato del Blocco 2 avrebbe
  richiuso). Il netto riscattato usa redeem - cancel: lo storno di UN
  appuntamento non tocca i riscatti degli altri (E5c).
- TEST (12 PASS, cleanup CLEAN): prenotazione con omaggio (pending + tx +
  prezzo 0 badge Omaggio), dettaglio con pendingQty, done parziale (istanza
  resta disponibile), done ultima unita' (chiusura source appointment),
  cancel-done (riapertura + tx cancel + usati netti corretti), annullo
  pending (tx pending->cancel), oversubscribe rifiutato.

### CHIUSURA F12 BLOCCO 4 — EDITOR AVANZATO + SOSPENSIONI (2026-07-03, 16
### test PASS + regression 16+12 PASS) — F12 GIFTS V2 COMPLETO
NON-GAP CONFERMATI dall'agente sul legacy:
- MULTI-SET REGOLE: lo schema li supporta ma gifts.php/saveGift impongono UN
  solo set (AND) e UNA sola regola ("E' consentita una sola regola di sblocco
  per campagna", saveGift ~3029; window_type forzato 'all_time'). L'editor
  Next a regola singola era GIA' fedele.
- REPEATABLE/max_redemptions: rimossi dalla UI legacy, forzati repeatable=0 /
  max=1 al save (~2976-2978) — ora forzati anche nel Next.
- GiftLoyaltyAttribution (1048 righe): ORTOGONALE a Gifts v2 — gestisce il
  cliente DESTINATARIO di GiftCard/GiftBox (recipient_client_id) garantendo
  che punti/omaggi della vendita di emissione restino al compratore. Non fa
  parte del modulo campagne; eventuale port nell'area GiftCard/GiftBox.
PORTATO in questo blocco:
- LIVELLI PUNTI (eligible_levels_points, JSON array chiavi lowercase):
  checkbox nell'editor (visibili con fidelity_only, whitelist dai livelli
  configurati, obbligo "Seleziona almeno un livello Punti."), gate nel motore
  (recalc: annulla accumulo con cancel_reason 'Livello non idoneo'; redeem
  manuale: "Livello cliente non idoneo per questo gift"). Il livello cliente
  e' clients.fidelity_level (snapshot mantenuto da F4 a ogni movimento —
  equivalente del calcolo runtime legacy Fidelity::calcClientLevelPoints).
- ESCLUSIONI (excluded_client_ids JSON): picker aggiungi/rimuovi nell'editor;
  il gate motore esisteva dal Blocco 1 ('Cliente escluso dalla campagna').
- CLONE (action=clone): prefill con date ricalcolate se passate + alert +
  "Salva clone"; al salvataggio nuovo insert con cloned_from_gift_id, ritiro
  sorgente (active=0, replaced_by_gift_id, replaced_at, marker
  campaign_disabled_start 'Campagna clonata' se era attiva, sorgente esclusa
  dal conflict-check), messaggio "Clone campagna creato".
- VALIDAZIONI SAVE legacy: "Nome obbligatorio" (trunc 120), "Validita' dal e
  Validita' al sono obbligatori.", "Validita' al deve essere almeno il giorno
  successivo...", anti-retroattivita' creazione ("Validita' dal non puo'
  essere nel passato..."), CONFLITTO campagne attive stesso target
  servizio/prodotto e periodo sovrapposto ("Esiste gia' una campagna omaggio
  attiva per questi servizi/prodotti nello stesso periodo (ID #x): Nome...").
- CREATED_AT PRESERVATION (saveGift ~3207-3305): il DELETE+reinsert di
  set/regola preserva created_at quando la firma della regola
  (tipo/comparatore/soglia/target) e' invariata — created_at e' il floor
  anti-retroattivo della finestra eventi e un semplice risalvataggio non deve
  azzerare i progressi (verificato G5: v1 -> resave -> v2 -> unlock).
- INTERVALLI DI SOSPENSIONE (globalDisabledIntervalsForGift ~6465 +
  appendGiftDisabledIntervalsEventExclusion ~6566): marker globali client_id=0
  in gift_progress_resets scritti da toggle campagna (campaign_disabled_start
  'Campagna disattivata' / _end 'Campagna riattivata'), creazione disattivata
  ('Campagna creata disattivata'), clone ('Campagna clonata'), riattivazione
  Fidelity (fidelity_disabled_end 'Campagna riattivata dalla Fidelity' per i
  gift auto_disabled ripristinati); la valutazione regole esclude gli eventi
  negli intervalli accoppiati start->end (NOT(occurred_at >= from AND < to),
  bound sup. esclusivo; start APERTO = esclusione fino a fine finestra).
  Verificato G4: vendita durante la sospensione non conta mai.
- TEST (16 PASS batteria G + regression 16 motore + 12 ciclo appuntamenti,
  cleanup CLEAN): anti-retroattivita' creazione, repeatable forzato,
  conflitto, marker toggle e clone, esclusione eventi sospesi (2/3 dopo 3
  vendite di cui 1 sospesa), created_at preservation, gate livelli
  (non idoneo/idoneo), esclusioni via editor, clone completo con retire.

## F12 GIFTS V2 COMPLETO (Blocchi 1-4 chiusi 2026-07-03, ~85 test live).
Tutte le aree del modulo Omaggi legacy sono portate o documentate non-gap.
Divergenza minore documentata: il filtro residuali in valutazione e' applicato
alla registrazione degli eventi (input-side) anziche' rifiltrato in SQL.

# CAMPAGNA DI VERIFICA FUNZIONE-PER-FUNZIONE (avviata 2026-07-03)
Confronto sistematico PHP (localhost/manage, 86 pagine in app/pages/) vs Next.
Metodo per area: 1) agente Explore sul sorgente PHP (comportamenti, query,
messaggi esatti); 2) test live sulle API/pagine Next con dati throwaway e
cleanup; 3) fix delle divergenze con messaggi legacy; 4) chiusura qui.

## FIX APERTURA CAMPAGNA — Orari -> Calendario (2026-07-03, commit 0fd0d3f)
Bug segnalato dall'utente: cambiare l'orario (es. venerdi chiusura 16/17)
non aggiornava i limiti del calendario (restava 19:00).
CAUSA: business_hours ha righe PER SEDE (location_id=21, aggiornate dal
salvataggio Orari) + righe GLOBALI legacy (location_id NULL, ferme al seed
09-19 di ensure_default_hours, Helpers.php:6698-6700). Il contesto calendario
Next restituiva TUTTE le righe e il componente faceva min/max sull'unione:
max(16:00, 19:00) = 19:00.
FIX (fedele a calendar.php:171-181): fallback PER GIORNO sede -> globale (la
riga della sede sovrascrive la globale per quel dow); chiusure ed eccezioni
filtrate per sede corrente o globali; fallback componente allineato al legacy
(min/max settimanali, 07:00-22:00 solo senza orari; bound del giorno =
chiusura di QUEL weekday incl. seconda fascia closes2). Il booking pubblico
era GIA' corretto (preferredLocationRow). Verificato live (4 PASS, restore
pulito). Comportamenti legacy confermati dall'agente e gia' presenti nel Next:
appuntamenti esistenti fuori orario restano visibili (asse espanso
dinamicamente, port di _computeDynamicAxisForEvents); il calendario interno
NON blocca il salvataggio fuori orario (solo il booking pubblico filtra gli
slot); giorni chiusi = colonna grigia. Allineati anche i messaggi di
validazione Orari mancanti ("se il giorno non e chiuso devi compilare
apertura e chiusura.", "per l'orario spezzato devi compilare sia riapertura
sia chiusura 2.", "la chiusura 2 deve essere successiva alla riapertura.",
"(prima fascia)").

## MATRICE PAGINE LEGACY -> NEXT (stato al 2026-07-03)
GIA' VERIFICATE CON TEST LIVE (aree chiuse nelle sezioni sopra):
pos, pos_history, pos_sale_detail, pos_prepaids, pos_preorders, pos_settings,
pos_success (schermata in pos-content), installments_manage, fidelity,
fidelity_points, fidelity_levels, fidelity_membership(+settings),
fidelity_wallet, gifts, gift_instance, gift_voucher, giftcard(+settings,
voucher, detail), giftbox(+settings, voucher, instance), packages,
package_settings, recharges, credit_movements, wallet, coupons, promotions,
quotes, quote_settings, quote_public, suppliers, clients (lista, drawer,
GDPR, consensi, cascade-delete), client_sheets, client_sheet_templates,
consent_modules, consent_public, gdpr_public, appointments, calendar (+fix
orari), hours/resources (+fix e messaggi), services, service_categories,
products, costs, stock_moves, onboarding.

DA VERIFICARE (in ordine di priorita' — un'area per "procedi"):
- V1 DASHBOARD (dashboard.php + api_dashboard_performance): la prima
  schermata del gestionale — widget, KPI, agenda del giorno. Mai testata.
- V2 SETTINGS (settings.php) + configuration: impostazioni generali tenant.
- V3 STAFF + STAFF_AVAILABILITY: anagrafica operatori, turni/presenze
  (staff_availability kind turno/presenza, serie ricorrenti), intersezione
  con gli orari di apertura nel calendario e negli slot.
- V4 CABINS + RESOURCES: l'audit iniziale segnalava il form cabine stub.
- V5 BOOKING PUBBLICO end-to-end (booking.php wizard: servizi -> operatore
  -> slot -> conferma; build_slots con orari/turni/cabine) + PUBLIC_ACCOUNT
  (area cliente: login, prenotazioni, annullo) + PUBLIC_MARKETPLACE.
- V6 AUTH: login/logout/forgot_password/reset_password (manage) +
  manage_account (profilo/cambio password) + roles/permissions.
- V7 NOTIFICATIONS + AUTOMATION (+ notifications_birthdays/installments/
  quotes): regole, invii email, badge campanella.
- V8 REPORTS + api_dashboard_performance: parita' NUMERICA dei report
  (incassi, servizi, operatori) su dati identici.
- V9 ALLEGATI/BINARI: client-document, cost-attachment, staff-photo,
  product-image, category-image (R2), stock_doc_attachment,
  client_sheet_attachment, endpoint logo (index.php?page=logo).
- V10 RESIDUE: accessibility, marketplace (impostazioni), business_profile,
  locations (multi-sede: P11 differito), appointments_plan, commissions,
  api_sms_callback (OpenAPI SMS), api_user_prefs.

## V1 DASHBOARD — CHIUSA (2026-07-03, 13 test PASS, commit sotto)
Confronto con dashboard.php (737 righe) + api_dashboard_performance.php (281)
+ dashboard.js. La UI Next era gia' fedele (KPI, statistica settimanale con
grafico, prossimi appuntamenti, avvisi, scadenziario); i CALCOLI divergevano
e sono stati riscritti in lib/manage-dashboard.ts con le query legacy:
- KPI Clienti: con sede = COUNT(DISTINCT client_id) dall'UNION di clients/
  appointments/sales della sede (dashboard.php:59-95); senza sede COUNT(*).
  (Prima: length della lista clienti, nessuna sede.)
- KPI Appuntamenti oggi: blacklist stati legacy (canceled/no_show/rejected/
  annullato/rifiutato... dashboard.php:34) + filtro sede permissivo
  (location_id = sede OR IS NULL). (Prima: contava anche gli annullati.)
- KPI Vendite ultimi 30gg: SUM(total) con sale_date >= NOW()-30gg, stati
  attivi, sede. (Prima: createdAt, nessuna sede.)
- STATISTICA SETTIMANALE (api_dashboard_performance): conta SOLO
  status='scheduled' (diverso dai KPI top!); RICAVI = SUM(
  appointment_services.price*qty, fallback services.price) degli appuntamenti
  scheduled — NON le vendite POS (verificato T5c: una vendita non muove i
  ricavi weekly); ore = SUM(ends_at-starts_at); nuovi clienti su created_at;
  delta % vs settimana precedente con regola _pct_change (null quando prev=0
  e cur>0 -> reso "—" muted, port di setDelta); serie = ricavi appuntamenti
  per giorno lun->dom. (Prima: tutti gli stati, ricavi dalle vendite,
  fallback 60min sulle ore, +100% sul delta da zero.)
- PROSSIMI APPUNTAMENTI: starts_at in [NOW(), +7gg), SOLO pending/scheduled,
  LIMIT 10, servizi STRING_AGG, formato d/m H:i, gated calendar.view (card
  assente senza permesso). (Prima: da oggi in poi senza finestra, stati
  !=Completato, limit 8, nessun gating.)
- SCADENZIARIO E COSTI: is_paid=0 con residuo GREATEST(amount-paid_amount,0),
  Scaduti = due_date < oggi, Questo mese = BETWEEN 1..fine mese, sede, gated
  costs.manage|costs.items. (Prima: status derivato, niente residuo/gating.)
- Rimosso il campo notifications dal payload (il legacy non ha quella card;
  la UI non la rendeva). Avvisi: gia' port dedicato fedele
  (manage-dashboard-alerts) con permessi + sede — invariato.
- TEST (13 PASS, cleanup CLEAN): parita' numerica KPI con query legacy
  indipendenti, scheduled/pending/canceled esercitati sui tre contatori
  (blacklist vs scheduled-only), ricavi weekly da appointment_services e non
  dalle vendite, serie giornaliera, upcoming con finestra e stati, vendita
  POS che muove solo il KPI 30gg, delta null, gating card admin. Confermato
  anche il filtro sede permissivo (un appuntamento su altra sede resta fuori).
Non-gap: la dashboard legacy e' read-only (nessuna azione rapida ne' cambio
stato dalla lista); l'avviso Tessere Fidelity legacy NON filtra per sede.

## V2 SETTINGS/SEDI — CHIUSA (2026-07-03, 18 test PASS)
SCOPERTA CHIAVE (agente sul legacy): settings.php e' uno SHIM di 3 righe
("Backward-compat: old Impostazioni page is now Sede" -> require
locations.php). Non esiste una pagina impostazioni a tab: le voci del gruppo
"Impostazioni" del menu (View.php:726-750) sono PAGINE separate gia' portate
(business_profile, consent_modules, accessibility, roles, automation,
reports, booking) — la pagina da verificare era SEDI (locations.php).
STATO TROVATO: il backend Next era GIA' completo e fedele
(manage-business-settings.ts: location_save con le validazioni/messaggi
esatti di sede_location_validation_error, move, marketplace con categorie
attivita' centrali, preview/delete con blocchi legacy) ma la UI era una
LISTA display-only coi bottoni verso il fallback Tailwind. PORTATO:
- Router: shim page=settings -> LocationsContent (come il PHP).
- UI locations-content riscritta fedele: header "Impostazioni / Sedi" con
  bottoni Orari e Booking; tabella Sede|Contatti|Booking|Marketplace|
  Categorie attive|Ordine|Azioni; modale sede (nome/indirizzo/regione/
  provincia/citta'/CAP/telefono/email/whatsapp/facebook/instagram/tiktok/
  booking con gate di piano); modale Marketplace sede (switch + categorie con
  principale + GALLERY); modale eliminazione con anteprima e conferma
  ELIMINA.
- GALLERY SEDE (nuova, Helpers.php ~11642-11903): upload multiplo JPG/PNG/
  WEBP max 5MB ("Foto troppo grande (max 5 MB)", "Formato non valido: carica
  JPG, PNG o WEBP") in /uploads/tenants/<slug>/branding/locations/<id>/
  gallery, righe location_gallery_images con sort_order a passo 10, delete
  con rimozione file + ricompattazione, move a scambio; messaggi legacy
  ("Foto gallery sede caricate/rimossa", "Ordine gallery sede aggiornato").
  Divergenza documentata: il resize GD 1600x1200/JPEG q84 non e' replicato
  (si salvano i byte originali, lo stesso fallback del PHP senza GD).
- DELETE: aggiunta la RIASSEGNAZIONE CLIENTI della sede eliminata alla prima
  sede residua (forma semplificata di reassignSharedClientLocations — il
  ranking per attivita' e la gestione exclusive/shared masters del legacy
  LocationDeletion sono parte del multi-sede completo P11, documentato).
- TEST (18 PASS, cleanup CLEAN): validazioni (nome/email/duplicato
  case-insensitive), creazione con tutti i campi incl. sede legale,
  ordinamento up/down, marketplace (rifiuto senza categorie + salvataggio con
  categoria principale, 16 categorie seed presenti), gallery upload/move/
  delete end-to-end, preview eliminabile vs bloccata da storico (messaggio
  legacy), conferma ELIMINA case-sensitive, eliminazione con riassegnazione
  cliente verificata, shim /settings e /locations 200.

## V3 OPERATORI + DISPONIBILITA' — CHIUSA (2026-07-03, 16 test PASS)
Confronto con staff.php (1499 righe) + staff_availability.php (2199) +
Helpers (staff_schedule_blocks_for_date, foto). STATO TROVATO: backend Next
gia' molto fedele (saveStaffMember con account users via email + invito
"Conferma email account", vincoli eliminazione legacy, saveAvailabilityEvent
con serie w1/w2/w3/m1 + dows + override presenza>turno gia' negli slot
pubblici, foto operatore su route dedicata R2, form operatore fedele gia'
esistente e instradato) MA i form della pagina Disponibilita' NON salvavano
(method=post nativi senza handler) e mancavano Duplica settimana e l'avviso
conflitti. PORTATO/FIXATO:
- WIRING Disponibilita': submit "Nuovo evento" ora salva via
  availability_save (msg legacy "Disponibilità salvata"/"Periodo salvato"),
  con PRIMA l'avviso NON bloccante sui conflitti (nuova action
  availability_check_conflicts, port di do=check_appt_conflicts: appuntamenti
  pending/scheduled dell'operatore sovrapposti alle occorrenze, via bridge
  appointment_staff — appointments non ha staff_id); barre evento con
  Modifica (precompila il form legacy event_id/event_table) ed Elimina
  (conferme legacy "Rimuovere questo evento?/l'intera serie?/questo periodo?"
  + scope serie); alert msg/err.
- DUPLICA SETTIMANA (nuova, do=copy_week ~723-908): copia SOLO turno/
  presenza dal lunedi' origine->destinazione, filtro operatore, overwrite o
  skip duplicati esatti, series_uid rimappati; messaggi legacy ("Settimana
  duplicata: N eventi", "Nessun evento copiato (già presenti)", "La settimana
  di destinazione è uguale a quella di origine", "Seleziona settimana di
  origine e destinazione", "Nessun turno da copiare"). BUGFIX: weekRange.end
  e' il lunedi' successivo (bound esclusivo) — il +1 iniziale allargava la
  finestra e ricopiava la copia.
- MESSAGGI legacy allineati: staff ("Email obbligatoria", "Password
  obbligatoria", "Seleziona almeno una sede per l'operatore." quando il
  tenant ha sedi, "Nome operatore riservato (SSO)"); availability ("Compila
  tutti i campi obbligatori (Al, Dalle, Alle)", "Inserisci orari validi
  (HH:MM)", "Gli orari selezionati non sono validi", "Nessun orario di
  apertura per il giorno X (controlla Orari/Straordinari/Chiusure)").
- LISTA STAFF: "Elimina" era un link al fallback -> ora POST staff_delete
  con conferma e messaggi vincolo dal server; messaggio post-redirect
  "Operatore salvato" dal form.
- SCHEMA: staff_timeoff.id era l'UNICA colonna id senza IDENTITY nello
  schema migrato (rompeva la creazione ferie con NOT NULL violation) —
  applicato ALTER ... ADD GENERATED BY DEFAULT AS IDENTITY su Supabase.
- TEST (16 PASS, cleanup CLEAN): validazioni staff, creazione con account
  users role=staff + sede, turno singolo, giorno chiuso rifiutato col
  messaggio esatto, orari invertiti, serie mar+gio x2 settimane (4 occorrenze
  1 uid), conflitto appuntamento rilevato dal check, eliminazione serie,
  ferie multi-giorno (1 riga range reason=Ferie), duplica settimana +
  idempotenza + origine=destinazione, delete bloccata da prenotazioni poi
  completata con rimozione account e righe collegate.
RESIDUO documentato: vista SETTIMANA della pagina Disponibilita' (griglia
7 colonne con chip e bottone + per cella) — il Next rende la vista giorno;
il toggle Settimana esiste ma usa lo stesso layout. Vincoli di modifica
sedi/disattivazione con servizio-scoperto per sede (messaggi con nome
servizio/sede) coperti in forma semplificata da ensureStaffCanDeactivate.

## V4 CABINE + RISORSE — CHIUSA (2026-07-03, 14 test PASS)
Confronto con cabins.php (626 righe) + resources.php (859) + il motore
condiviso di Helpers.php/booking.php. STATO TROVATO: cabine gia' portate
(bulk per sede con anti-bypass blockingServices, soft delete is_active=0,
blocker = service_cabins + services.cabin_id + appuntamenti futuri; vincolo
cabina sugli slot gia' attivo); risorse col server CRUD fedele ma UI
display-only con shape sbagliata E — gap sostanziale — NESSUN vincolo
risorse su slot e salvataggio. PORTATO:
- MOTORE RISORSE (nuovo, lib/public-booking-db sharedResourcesContext —
  port di shared_resources_requirements_by_service:12299 + totali per sede
  via resource_locations (qty 0 se is_enabled!=1, fallback qty_total) +
  shared_resources_blocks_for_range:12492 + PEAK sweep-line per finestra):
  gli slot cadono quando peak+unita' richieste > totale sede
  (shared_resources_filter_slots:13705) e il SALVATAGGIO rilancia i messaggi
  legacy (ensure_shared_resources_available_for_sequence:13804): 'Orario non
  più disponibile: risorsa "X" non disponibile.' / '... esaurita (richieste
  N, disponibili M).'. Integrato in publicBookingSlots (accanto al filtro
  cabine) e in createDbAppointment (dopo assertAppointmentSlotAvailable).
  Verificato live: con qty sede 2, due appuntamenti sovrapposti passano, il
  terzo cade col messaggio esatto, uno slot non sovrapposto passa.
- PEAK-GUARD riduzione quantita' (resources_resource_peak_usage:278-314):
  la riduzione e' bloccata anche quando le prenotazioni future usano piu'
  unita' contemporanee del nuovo limite ("Quantita non aggiornata:
  prenotazioni esistenti oltre il nuovo limite.") oltre al vincolo servizi
  gia' presente (messaggi sede/globale legacy).
- UI RISORSE riscritta (era lista display-only con campi inesistenti):
  lista Nome | Sedi/Quantita' | Descrizione | Azioni, form Nuova/Modifica
  nella stessa pagina (name, description, qty_total, per-sede Attiva +
  Quantita' sede), delete con popup bloccante legacy sui servizi collegati
  + confirm "Eliminare questa risorsa?", messaggi "Risorsa creata/
  aggiornata/eliminata".
- MESSAGGI allineati: "Nome risorsa obbligatorio" (senza punto), "Risorsa
  non eliminata: è associata a uno o più servizi." (accenti come il file
  legacy), "Quantita non aggiornata: risorsa ancora utilizzata nei servizi
  della sede.".
- TEST (14 PASS, cleanup CLEAN): validazioni, creazione con qty sede,
  capacita' concorrente (2 ok / 3o rifiutato / slot libero ok — con 3
  cabine temporanee per isolare il vincolo risorse da quello cabine),
  peak-guard su riduzione, vincolo servizi, delete bloccata/fisica completa,
  cabine bulk add + soft delete.
NON-GAP: bug legacy del filtro "Tutte le sedi" (variabile usata prima della
definizione, sempre disattivo) NON replicato; hold/lock di concorrenza sul
salvataggio risorse (shared_resources_acquire_resource_locks) demandato al
check transazionale del save.

## V5 AREA PUBBLICA (booking wizard + area cliente + marketplace) — CHIUSA
## (2026-07-03, 14 test e2e PASS)
Confronto con booking.php (~8000 righe wizard+book+customer API),
public_account.php (account centrale marketplace), public_marketplace.php.
STATO TROVATO: port Next molto avanzato (wizard 85k con step legacy, hold
150s, benefit server-side promo>coupon>auto, 5 pagine account fedeli,
marketplace /attivita con dettaglio, API /api/account con l'intero
perimetro cliente: prenotazioni+annullo, pacchetti/credito/giftcard/
prepagati/omaggi/fidelity/preordini/preventivi con decisione, preferiti,
ICS; cancel policy con i messaggi legacy esatti).
BUG POSTGRES TROVATI E CORRETTI (classe zero-date MySQL):
- tenantBySlug (public-customer-account:1181) filtrava con
  "deleted_at = '0000-00-00 00:00:00'": su Postgres la zero-date LANCIA
  (date out of range) e il .catch mascherava l'errore -> il tenant risultava
  sempre "non trovato" -> upsertPublicCustomerFromBooking NON creava mai
  l'account/link dal booking (accountLinked sempre false, area cliente
  vuota). Fix: deleted_at IS NULL. Verificato: il booking ora crea/linka
  l'account e la lista prenotazioni del cliente lo vede.
- countUpcomingBirthdays (manage-shell-context:216) confrontava birth_date
  (DATE) con '0000-00-00' -> query sempre fallita -> campanella COMPLEANNI
  sempre a 0 dal giorno del port. Fix: birth_date IS NOT NULL (il filtro
  zero-date resta nel parser JS).
VERIFICATO E2E (14 PASS, cleanup CLEAN incl. ripristino cancel policy):
register cliente (devCode 6 cifre senza SES) -> verify -> login con
sessione; hold_slot -> confirm -> appuntamento PENDING con public_code +
cliente tenant creato + account linkato; stesso slot rifiutato; campanella
manage (shell-context notif.appointments) conta il pending; area cliente
vede la prenotazione con canCancel; annullo rifiutato con policy off
("Cancellazione non disponibile.") e riuscito con policy on (status
canceled); directory /attivita e dettaglio 200; pagina wizard 200.
DIVERGENZA DOCUMENTATA: il legacy OBBLIGA il login cliente prima del book
(redirect auth=1, dati presi dall'account, booking.php:7311); il Next
permette il GUEST BOOKING dal wizard (dati dal form) con creazione/link
automatico dell'account via upsert. Funzionalmente piu' permissivo; da
allineare solo su richiesta (gate UI+server nel wizard).
NON-GAP: il book legacy NON invia email (ne' cliente ne' attivita'):
"Ti avviseremo via email" arriva solo all'approvazione manage; la
campanella intercetta i pending via conteggio (come il Next).
OPS: durante i test il dev server e' morto di nuovo con lo zombie su :3000
(404 su route esistenti) — kill PID + rm -rf .next + restart risolve.

## V6 AUTH MANAGE + RUOLI — CHIUSA (2026-07-03, 16 test e2e PASS)
Fonte legacy: manage_account.php (E' la pagina auth: modes login/register/
verify/forgot/reset), SaasProfessionalSignup.php, PasswordReset.php,
Auth/roles.php. Batteria: e2e-auth-roles.mjs (scratchpad).
VERIFICATO 1:1: login slug+email+password con messaggi legacy verbatim
("Credenziali non valide.", "Account operatore disattivato.", "Gestionale
non trovato o non attivo."); rate limit 10 fail/15min su login_attempts
("Troppi tentativi di login. Riprova tra qualche minuto."); forgot/reset:
messaggio generico anti-enumeration "Se l'email esiste...", token 64-hex
sha256 TTL 60min, single-use ("Link non valido o scaduto."), mismatch
"Le password non coincidono."; signup validazioni (slug in uso, password
<8, mismatch); matrice permessi: ruoli FISSI (admin sempre-tutto,
staff/altro configurabili via role_permissions, 61 definizioni), GET
matrice + save_role_perms ok.
FIX APPLICATI:
1. lib/manage-auth.ts: loginManageUser ora controlla saas_tenants
   (is_active/status/deleted_at) PRIMA della lookup utente -> "Gestionale
   non trovato o non attivo." su slug inesistente/sospeso (prima
   rispondeva "Credenziali non valide.").
2. REVOCA LOGOUT server-side: le sessioni manage sono cookie firmati
   stateless e il logout cancellava solo il cookie browser (un cookie
   trattenuto restava valido 12h — il legacy fa session_destroy).
   Aggiunta colonna users.session_epoch (INT DEFAULT 0, ALTER applicato
   su Supabase): il login incorpora l'epoch nella sessione firmata,
   currentManageSession la confronta col DB (undefined->0 per sessioni
   pre-esistenti; errore DB transitorio -> allow), la route logout fa
   UPDATE session_epoch+1 prima di cancellare il cookie -> API successive 401.
   NB: le sessioni browser emesse prima del fix risultano invalidate al
   primo logout dell'utente (re-login necessario, una tantum).
NON-GAP (test corretto, non il codice): il messaggio "URL attivita gia
in uso. Scegline un altro." e' SENZA accenti anche nel legacy
(SaasProfessionalSignup.php:157) — la batteria si aspettava "già" e
falliva a torto; parita' verbatim confermata.
Cleanup: login_attempts svuotata, role_permissions 'altro' ripristinata,
operatore/users/password_resets/signups zzv6* rimossi -> CLEAN.

## V7 NOTIFICHE + AUTOMATION — CHIUSA (2026-07-03, 19 test e2e PASS)
Fonte legacy: automation.php, notifications.php + notifications_{quotes,
installments,birthdays}.php, View::notificationSummary (View.php 67-193),
Helpers automation_schedule_reminder (9315-9413) / client_birthday_* /
fidelity_card_notification_groups (5147-5356), cron/reminders.php.
Batteria: e2e-notifications-automation.mjs (scratchpad).
GAP GRAVI TROVATI E FIXATI:
1. NESSUN CODICE creava le righe `reminders`: il cron Next le invia soltanto,
   quindi i promemoria appuntamento (email+SMS) non sarebbero MAI partiti.
   Nuovo lib/automation-reminders.ts (port di automation_schedule_reminder):
   una riga pending per canale (email se il cliente ha email, sms se il
   telefono normalizza E.164), scheduled_at = inizio - ore (3/6/12/24/48,
   fallback 24), target passato -> now+5min. Hook in
   app/api/manage/appointments: create/edit/move/resize/status/cancel_done
   (annullo = clear pending), delete (pulizia orfani).
2. Il form della pagina Automazione postava su una route INESISTENTE
   (/[slug]/automation): "Salva" non salvava nulla e reminder_hours /
   sms_reminder_hours non venivano mai persistite. Ora POST
   /api/manage/automation action=save (port automation.php 24-71): toggle
   (incl. modified/rejected prima hardcoded true) + ore + sender forzato
   'Prenodo', poi RISCHEDULAZIONE di tutti i promemoria futuri (57-68).
   Messaggio legacy "Automazione salvata"; GET espone `settings` per il prefill.
3. Impostazione compleanni non persistita (preventDefault + stato locale):
   ora POST notifications action=save_birthday_days -> "Impostazioni salvate",
   clamp 0..365 su automation_settings.client_birthday_alert_days; il
   componente rilegge il valore da action=settings.
4. Risposte preventivi senza seen/seen_all: aggiunte a /api/manage/quotes
   (SQL legacy: status accepted/rejected + customer_decision_at NOT NULL +
   seen NULL + filtro sede corrente), messaggi "Preventivo segnato come
   letto" / "Preventivi segnati come letti"; la lista API espone
   customerDecisionAt/SeenAt e la pagina notifiche filtra le NON lette.
5. Contatore campanella fidelity_cards fisso a 0: portato il conteggio
   (tessere scadute sempre + in scadenza entro la finestra quando
   fidelity_expiry_reminder_enabled=1; disattivato -> 0 come il legacy).
   Formula campanella confermata: count = appointments + fidelity_cards.
6. Aggiunto GET notifications action=count (port del poller legacy
   ?page=notifications&action=count, no-store).
NON-GAP DOCUMENTATI (il legacy NON ha queste funzioni):
- Compleanni e rate NON inviano MAI email/SMS nel legacy: solo contatori
  topbar + pagine dedicate. Nessuna email di auguri, nessun promemoria rata.
- I subject/body delle email automatiche NON sono modificabili dall'utente
  (il save legacy li riscrive sempre coi default); il Next li genera dal
  codice. I default DB legacy contengono mojibake (Ã¨ = è) che NON
  riproduciamo: le email Next escono con gli accenti corretti (miglioria
  deliberata, il testo e' identico).
- runDbAutomationRule (action=run) non esiste nel legacy: resta uno stub.
DIFFERITI: preferenze notifiche browser per-utente (BrowserNotifications
feed/prefs legacy) e barra support-access topbar (getSupportAccess null);
saldo SMS reale in pagina Automazione (wallet gia' usato dal cron).
Cleanup: cliente/appuntamento/preventivi/tessera ZZV7 rimossi, righe
reminders create durante i test eliminate (anche quelle delle
rischedulazioni su appuntamenti reali), automation_settings ripristinata
al valore pre-test -> CLEAN.

## V8 REPORT — CHIUSA (2026-07-03, 20 test e2e PASS, parita' numerica)
Fonte legacy: app/pages/reports.php (2156 righe) + api_dashboard_performance.php.
Batteria: e2e-reports.mjs (dati sintetici in finestra isolata gen-2020, cleanup
completo; verifica i NUMERI, non solo le shape).
GAP GRAVI TROVATI E FIXATI (lib/manage-reports.ts riscritta + componente):
1. "INCASSO" SBAGLIATO: il Next sommava sales.total; il legacy usa il modello a
   EVENTI DI INCASSO (fetchCollectionEvents 585-765) = vendite SENZA piano rate
   (per sale_date) + acconti dei piani + rate PAGATE (per paid_at, cash-basis).
   Con una vendita da 90 a rate (acconto 30 + 1 rata pagata 30) il legacy
   incassa 60, il vecchio Next mostrava 90. Ora identico (test K1: 210 vs
   venduto 240). Aggiunti Movimenti incasso + ripartizione METODI DI PAGAMENTO
   (regex legacy "Tipo pagamento: X" nelle note; ordine Contanti/Carte/
   Assegno/Bonifico/Non indicato, share % a 1 decimale).
2. Scontrino medio ora = AVG(s.total) come il legacy (prima sold/cnt — uguale
   in assenza di NULL ma allineato); Venduto/Lordo (SUM total/subtotal) e
   sconti visibili (discount+fidelity_discount) esposti.
3. Tile HARDCODED ora calcolate: Genere prevalente (Equilibrato/Donne/Uomini/
   Non indicato + "N con genere indicato"), Eta' media (>=1900-01-01, <= oggi,
   fasce <18..65+, N/D senza date), Costi (due_date BETWEEN inclusivo, pagato:
   is_paid=1 con paid_amount 0 vale amount; residuo GREATEST(amount-paid,0)),
   Commissioni (staff_commission_payments per COALESCE(movement_datetime,
   created_at), entry_status='cancelled' escluse) — entrambe perm-gated come
   il legacy (costs.manage|costs.items / commissions.manage).
4. Prenotazioni: aggiunti i bucket legacy (pending/scheduled/done/canceled/
   no_show con i set di sinonimi IT/EN 914-918) + trend attive + filtro sede
   dual-schema (location_id diretto O bridge appointment_locations).
5. Top servizi/prodotti: aggiunte le esclusioni legacy per nome (%giftcard%,
   %giftbox%, %ricarica%, %pacchetto%) e tipo IN (service,product), conteggio
   vendite DISTINCT s.id; etichette fallback top clienti ("Cliente #id",
   "Cliente non associato"). Tipologie di vendita (donut) con etichette
   Servizio/Prodotto/Pacchetto/GiftCard/GiftBox/Ricarica/Voce (Prodotto sempre
   presente).
6. Operatori: fusione vendite (operator_name) + ORE LAVORATE dai segmenti
   degli appuntamenti eseguiti (duration_minutes o ends-starts) + numero app.
   + scontrino medio (prima solo vendite).
7. COMPONENTE: i 10 canvas Chart.js erano MORTI (nessun codice di disegno) —
   ora tutti disegnati (window.Chart, palette legacy reports.php:1330);
   raggruppamento auto/giorno/settimana/mese attivo (auto: <=45gg giorno,
   <=180 settimana, altrimenti mese); modalita' confronto attive (auto/
   periodo precedente/anno precedente/mese/personalizzato -> compare_from/
   compare_to all'API) con "Confronto effettivo" reale; delta con semantica
   legacy formatDeltaInfo ("Nuovo rispetto al confronto", "Nessuna
   variazione", "Non confrontabile" per lo scontrino medio); i 3 modali
   "Mostra altro" popolati con ricerca; date default dinamiche (erano
   hardcoded 2026-06-01/29).
NON-GAP: export CSV/PDF dei report NON esiste nemmeno nel legacy.
NOTE SCHEMA: il CHECK migrato su sale_items.item_type ammette solo
service/product/package (il POS Next scrive solo questi) — le etichette
GiftCard/GiftBox/Ricarica restano mappate per parita' se il CHECK verra'
esteso. api_dashboard_performance: gia' portato dentro /api/manage/dashboard
(V1, status='scheduled' secco + pctChange null-semantics verificati).
DIFFERITO: fail-closed sedi multi-utente (l'utente admin vede tutto; il
fail-closed 1=0 legacy scatta con operatori senza sedi autorizzate — da
riverificare in V10 multi-sede P11).

## V9 ALLEGATI/BINARI — CHIUSA (2026-07-03, 24 test e2e PASS su R2 reale)
Fonte legacy: uploads/.htaccess (privati: clients|client_sheets|costs|
stock_docs), client_document.php, costs.php $handleCostUpload,
stock_moves.php $handleUpload + stock_doc_attachment.php, staff.php +
process_uploaded_staff_photo, ProductPageHelpers products_handle_images_upload,
services.php categorie, business_profile.php logo/cover, PrivacyConsent/
PrivacyPdf. Batteria: e2e-uploads.mjs (multipart reali contro R2, cleanup via
azioni API che cancellano anche gli oggetti R2).
GAP FIXATO: ALLEGATO DOCUMENTO MAGAZZINO mancava del tutto (TODO esplicito
nel form). Nuova route /api/manage/stock-doc-attachment (gemella di
cost-attachment): upload/rimozione multipart su R2 PRIVATO
(t{tenant}/stock_docs/{docId}/{random}.{ext}), solo PDF/JPG max 5 MB con i
messaggi legacy verbatim ("File troppo grande (max 5 MB)", "Formato non
supportato (solo PDF o JPG)"), download 302 presigned gated su
stock_moves.manage (come stock_doc_attachment.php via .htaccess+streaming).
saveStockMovement ora ritorna stockDocId; il form Nuovo carico/scarico ha il
campo file e carica DOPO il salvataggio (errore upload non annulla il
movimento, come il legacy); lista+dettaglio movimenti mostrano il link
allegato (attachmentName esposto).
VERIFICATO 1:1 (live): documenti cliente (10MB pdf/png/jpg/webp, 302
presigned, delete, guardie GDPR gia' V-precedenti), allegati costi (5MB
pdf/jpg), foto staff (URL pubblico R2, rimozione), immagini prodotto (max 5
con comportamento legacy riempi-fino-a-5 + errore "Limite massimo: 5
immagini per prodotto." per le eccedenti, set main, delete), immagine
categoria, allegato magazzino. Tutti i pulsanti upload della UI cablati.
DIVERGENZE DOCUMENTATE (accettate):
- Niente compressione server-side (GD resize/WebP, Ghostscript /ebook):
  file salvati come caricati su R2.
- Il Next valida il MIME DICHIARATO dal client; il legacy sniffa il
  contenuto (app_detect_file_mime). L'estensione e' comunque forzata dal
  MIME e R2 serve col content-type salvato (niente esecuzione lato server).
- Logo/cover/gallery sedi su FILESYSTEM public/uploads (non R2): su Amplify
  (filesystem effimero) andranno migrati a R2 PRIMA del deploy — gia'
  tracciato nella memoria storage.
MODULO MANCANTE RIMANDATO (non solo allegati): SCHEDE CLIENTE
(client_sheets) — il componente Next e' solo markup: nessun salvataggio
record (client_sheet_records.values JSON), nessun upload foto/documenti
(5 file x campo, 5MB, jpg/png o pdf/doc/docx/odt/xls/xlsx), nessun serving
(client_sheet_attachment.php). Area dedicata in V10/P-schede.
NON-GAP: PDF privacy/consensi generati on-the-fly + firmati su R2 privato
(gia' verificati); PDF preventivo generato on demand non salvato (legacy
uguale).

## V10-SCHEDE CLIENTE — MODULO COSTRUITO E CHIUSO (2026-07-03, 26 test e2e PASS)
Fonte legacy: app/lib/ClientSheets.php (1817 righe) + client_sheets.php +
client_sheet_templates.php + client_sheet_attachment.php. Stato di partenza
Next: SOLO impalcatura UI (markup fedele ma form morti, nessuna route,
nessuna persistenza; la pagina Configura schede leggeva perfino la tabella
sbagliata client_sheet_presets). Batteria: e2e-client-sheets.mjs.
COSTRUITO DA ZERO:
1. lib/client-sheets.ts — port completo di ClientSheets.php:
   - normalizzazione campi (10 tipi: text/textarea/number/date/select/
     checkbox/photo_before/photo_after/photo/document; id slugificati e
     dedupati _2/_3; placeholder solo text/textarea/number, unit solo number,
     options solo select; campo nascosto "note seduta" scartato);
   - validazioni template coi messaggi legacy VERBATIM incl. virgolette
     curve ('Compila "Unità" per il campo "X".');
   - regole di LOCK con compilazioni esistenti: nome/descrizione bloccati,
     campi esistenti immutabili (confronto per firma JSON) con append-only
     in fondo, sedi usate non rimovibili; conflitto slug+sede tra attivi;
   - sedi per template (client_sheet_template_locations upsert + disable);
   - delete template: HARD senza record, SOFT (deleted_at) con record
     (storico conservato, verificato in D2);
   - salvataggio record: values_json = {fieldId: value} con coercizione
     legacy (numero virgola->punto + check numerico, checkbox '1'/'0',
     data normalizzata, select dentro le opzioni, required), header
     (titolo/data seduta/prossima/operatore/note), fields_snapshot_json
     congelato al salvataggio (i vecchi record restano coerenti);
   - allegati su R2 PRIVATO (t{tenant}/client_sheets/{clientId}/record_{id}/
     photos|documents/{fieldSlug}_{random}.{ext}): max 5 per campo, 5MB,
     foto JPG/PNG, documenti PDF/DOC/DOCX/ODT/XLS/XLSX, messaggi legacy;
     insert-poi-upload-poi-update come il legacy con rollback best-effort;
     rimozioni differite a salvataggio riuscito;
   - delete_attachment immediato, delete_record con pulizia oggetti R2,
     download via presigned (equivalente di client_sheet_attachment.php).
2. app/api/manage/client-sheets/route.ts — dispatcher _action legacy
   (save_template/delete_template/save_record/delete_record/
   delete_attachment) + GET templates/records/KPI + download allegato,
   perm client_sheets.manage.
3. Componenti riscritti FUNZIONANTI: client_sheets-content (3 colonne,
   tiles reali, form dinamico dai campi del template o dallo snapshot,
   allegati con rimozione+download, storico con riepilogo "label: value"
   formato legacy Sì/No / N foto / d/m/Y / numero+unità) e
   client_sheet_templates-content (builder React con righe campo, UI
   per-tipo come TYPE_UI, preset dimagrimento/viso/laser, sedi, edit
   con lock visivo, delete coi confirm legacy).
Messaggi verificati: "Tab salvato correttamente.", "Tab eliminato.",
"Scheda tecnica salvata correttamente.", "Scheda tecnica eliminata.",
"File eliminato." + tutte le validazioni (26 assert).
DIVERGENZA DOCUMENTATA: layout meta allegati (note/posizione da
attachment_meta) portato come passthrough minimale (posizione = ordine).

## V10 RESIDUO — CHIUSA (2026-07-03, 17 test e2e PASS) — CAMPAGNA V1-V10 COMPLETA
Batteria: e2e-v10-residuo.mjs. Verifiche + fix:
1. SMS CALLBACK (api_sms_callback.php) — MANCAVA la route ricevente: il cron
   passava il callback URL al provider ma nessun endpoint riceveva le DLR
   (stati consegna persi). Nuova app/api/public/sms-callback: POST only
   (405 "Metodo non consentito."), secret obbligatorio timing-safe da
   ?token= / X-OpenAPI-SMS-Secret / X-Callback-Secret (403 "Callback SMS non
   configurata." / "Token callback non valido."), ricerca ricorsiva
   case-insensitive di rid/message_id/stato nei payload annidati (anche JSON
   dentro stringhe), 422 payload vuoto / identificativi mancanti, mapping
   legacy (DELIVERED -> sent+delivered_at; UNDELIVERABLE/REJECTED/EXPIRED ->
   failed + last_error "SMS provider: STATO"), update reminders per rid o
   per provider_message_id, 404 "Reminder SMS non trovato.",
   provider_response_json troncato a 65000. Env: OPENAPI_SMS_CALLBACK_SECRET
   + OPENAPI_SMS_CALLBACK_URL (da puntare a /api/public/sms-callback in prod).
2. USER PREFS (api_user_prefs.php) — MANCAVA: nuova
   app/api/manage/user-prefs con le colonne legacy su users
   (calendar_day_staff_order: array id unici positivi max 200, perm
   calendar.view; browser_notification_preferences: quotes/installments/
   birthdays/fidelity_cards con appointments SEMPRE locked, perm
   notifications.view), shapes JSON identiche ({ok,order}, {ok,preferences,
   locked:["appointments"],configurable}), "Azione non valida." /
   "Permesso negato.". Colonne aggiunte su Supabase (ALTER additive).
   NB client: preferences va inviato come stringa JSON (parseRequestBody
   appiattisce gli oggetti annidati).
3. GATE MULTI-SEDE (port di View::locationGate + index.php 606-638) —
   MANCAVA il chooser: un operatore multi-sede senza sede corrente vedeva
   shell vuota. Ora manage-shell mostra il gate a schermo intero ("Seleziona
   sede" / "Sede operativa" / "Scegli la sede su cui vuoi lavorare. Il
   gestionale verra caricato dopo la selezione." / "Continua con questa
   sede" / messaggio nessuna-sede legacy) finche' la sede non e' scelta
   (switch via POST /api/manage/locations, che riscrive la sessione).
   Verificato live: operatore con 2 sedi -> needsLocationSelection=true,
   switch -> sede corrente impostata, sede non consentita -> 403.
VERIFICATE GIA' COMPLETE (nessun fix): accessibility (pagina credenziali
account: verifica email a codice, cambio email, cambio password — GET/POST
DB-backed), marketplace settings (flag centrale marketplace_public_allowed
solo SaaS-admin fail-closed + modal per-sede con categorie e sync directory).
DIFFERITO OLTRE LA CAMPAGNA: barra support-access topbar (getSupportAccess
stub null); "all locations" mode per-request (app_all_locations_filter_enabled)
usato dal legacy su alcune liste — il Next filtra per sede corrente di sessione.

## DEPLOY-PREP 1 — BRANDING SU R2 (2026-07-03, 12 test e2e PASS)
Rimosso l'ultimo consumatore di filesystem locale tra gli upload: logo/cover
attivita' e gallery sedi ora scrivono su Cloudflare R2 PUBBLICO
(t{tenant}/branding/...) e nel DB va l'URL pubblico completo — come foto
staff e immagini prodotto. publicAssetUrl/withOrigin fanno gia' pass-through
degli URL assoluti, quindi nessun cambiamento ai consumer (profilo, booking
pubblico, marketplace sync). I vecchi path /uploads/... restano leggibili
(sono committati nel repo e deployano con l'app); i delete sono R2-aware
(URL assoluto -> deletePublicObject, path legacy -> unlink filesystem).
Verificato live: upload logo/cover -> URL R2 raggiungibile (200), guard
legacy "Rimuovi il logo attuale prima di caricarne uno nuovo.", delete ->
NULL + oggetto R2 rimosso (404); gallery sede throwaway: upload multiplo
(sort 10/20), formato invalido rifiutato col messaggio legacy, move up,
delete con rimozione oggetti. NB parametri route: gallery_image_id (non
image_id). Con questo NESSUN upload dipende piu' dal filesystem: il deploy
Amplify (filesystem effimero) e' sbloccato lato storage.

## PROMOZIONI — CHIUSA (2026-07-03, 38 test e2e PASS)
Fonte legacy: app/lib/Promotions.php (5436 righe) + promotions.php (2271) +
consumer pos.php/api_appointments.php/booking.php. Batteria: e2e-promotions.mjs
(tenant a 0 promozioni: campo libero; cleanup completo).
STATO DI PARTENZA (molto meglio del previsto): motore di eleggibilita' e
sconto gia' portato e fedele (percent per-unit, fixed pro-rata con
largest-remainder, min_qty di gruppo, blackout, fasce orarie 1=Lun..7=Dom,
esclusi, target new/inactive/birthday/fidelity coi reason verbatim,
stackable bitmask 4/8), applicazione cablata su drawer/POS/booking pubblico
con redemption. NON-GAP confermati dal sorgente legacy: total_limit,
per_day_limit, min_subtotal, max_discount, discounted_qty, priority,
show_in_booking sono COLONNE MORTE anche nel PHP (sempre NULL/forzate);
il ranking legacy e' max-sconto (niente priority); coupon_code promo senza
editor anche nel legacy; discount_mode 'price' legacy-data-only.
GAP FIXATI:
1. PER_CUSTOMER_LIMIT (unico limite che il legacy applica) NON era
   enforced: portato promotionUsageCount (conteggio DEDUPLICATO su chiavi
   appt:/sale:/red: con set annullati appuntamenti E vendite
   +void/storno/rimborso, fail-open) + enforcement in
   evaluatePromotionsForCart con reason "Limite utilizzi cliente raggiunto."
   e EXCLUDE-SELF threading (evalBestPromotionForAppointment
   excludeAppointmentId <- updateDbAppointment) cosi' la modifica di una
   prenotazione non si auto-blocca (U3 verificato).
2. clearPendingAppointmentsForPromotion era PARZIALE: ora come il legacy
   (1381-1494) ripristina appointment_services.price = list_price + azzera
   discount_badge, rimuove le righe "Promozione:" dalle note, stacca
   promotion_id/conditions sul set pending legacy (sinonimi IT/EN) ed
   elimina le redemption degli appuntamenti (quelle vendite restano:
   storico). Verificato in T2 (90 -> 100, badge/redemption rimossi).
3. Guardie di riattivazione mancanti: "Campagna completata: non può essere
   riattivata." (ends_at passata), gate Fidelity ('Attiva prima la
   Fidelity...'), fix etichetta elemento eliminato nel messaggio contenuti.
4. LOCK STRUTTURALE: una promo con utilizzi collegati non e' modificabile
   nella regola (confronto per firma JSON di date/sconti/scope/target/
   fasce/sedi/mappings) — messaggio legacy verbatim; consentiti solo
   titolo/descrizione/condizioni/esclusioni/stato (K1/K1b).
5. GUARDIA ANTI-DUPLICATO (validateNoDuplicateScope): validita'
   sovrapposta + stesso target(+finestra numerica) + stesse fasce/date
   escluse + sedi sovrapposte + scope sovrapposto -> i 6 messaggi legacy
   verbatim (all-vs-all, selected-vs-all, selected∩selected x
   servizi/prodotti).
6. CLONA-E-SOSTITUISCI: replace_source_id ritira la sorgente (is_active=0
   SENZA staccare i pending: storico conservato, C1 verificato) +
   messaggio "Campagna clonata salvata".
7. Validazioni save allineate al legacy: sede obbligatoria, messaggi
   "Se hai scelto...", per-item sconto>0 / percent<=100, prodotti globali,
   fasce orarie ('Completa sia "Da" sia "A"...' / '"A" deve essere
   successivo'), date escluse (con parse reale: 2026-13-45 rifiutata),
   condizioni senza testo, selezionati disattivati/mancanti, gate Fidelity
   sul target; messaggi route toggle/delete/save legacy.
VERIFICA NUMERICA: 10% su 100+50 -> 15; fixed 30 pro-rata -> 20+10;
min_qty gate; badge "-10%" e prezzi 100->90 sia in preview drawer sia
sulle righe appointment_services dell'appuntamento reale (U1b).

## PROMOZIONI — ALLINEAMENTO GRAFICO EDITOR (2026-07-03, segnalazione utente)
L'editor Next divergeva visivamente dal PHP (screenshot a confronto). Il form
e' stato RISCRITTO sul markup estratto dall'istanza PHP LIVE
(promotions.php action=new via sessione autenticata, 25KB):
- form dentro card con header interno (titolo + "Configura regole, target e
  validità. La promozione verrà applicata automaticamente anche nel booking."
  + Salva/Annulla in alto E in basso);
- Informazioni: Attiva + "Cumulabile (opz.)" AFFIANCATI col sub-box
  "Cumulabile con:" (Sconto punti Fidelity / Coupon) e la nota legacy
  "Se non selezioni alcun metodo, verra' abilitato lo Sconto punti Fidelity."
  (default 4 replicato al submit); Sedi abilitate come TABELLA Sede|Valida;
- Servizi/Prodotti: picker coi pannelli "Sconto rapido (selezionati)"
  (Tipo/Valore/Qta min + Applica + suggerimento), ricerca, righe con
  controlli sconto inline; sezione "Sconto" con help dinamico e i box
  globali; colonna destra: Validità con "Giorni / orari validi" (righe
  Giorno/Da/A/X + Aggiungi) e "Date escluse (blackout)" SOTTO le date (non
  piu' a sinistra); Target clienti coi box condizionali e "Clienti esclusi"
  a select + "Aggiungi all'esclusione" + lista selezionati con rimozione
  (non piu' checkbox-list di tutti i clienti); Limiti utilizzo con l'help
  legacy completo ("...In sospeso / Prenotato; le prenotazioni annullate
  liberano il limite.").
- RIMOSSO il select "Visibilità marketplace": il legacy NON lo mostra
  (backend salva sempre 'auto'); il valore caricato in edit e' conservato.
- COPIATO public/assets/css/pages/promotions.css dal legacy (mancava:
  classi promo-* senza stili). Verifica: tutti i marker legacy presenti nel
  bundle, "Visibilità marketplace" assente; batteria 38/38 riconfermata.

## FIX — "Nuova promozione" irraggiungibile (ERR_NAME_NOT_RESOLVED)
Il bottone portava a "//promotions?action=new": slug vuoto in SSR (helper
window-only) -> URL protocol-relative col browser che cerca l'host
"promotions". Stessa classe del bug //appointments gia' visto sul calendario.
FIX: PromotionsContent/PromotionFormContent (+ 8 moduli con lo stesso pattern:
client_consents, client_sheets, client_sheet_templates, gift_instance,
locations, reports, resources, staff_availability) ora accettano la prop
slug dal server (`slug={tenantSlug}` gia' passata dalla pagina) con fallback
window; PromotionFormContent riceve la prop anche dal ramo action=new|edit.
Verificato in SSR: href corretto /centroesteticoelite/promotions?action=new,
nessun link protocol-relative residuo nella pagina.

## PUNTI (cluster Fidelity) — PASSATA GRAFICA+FUNZIONALE (2026-07-03)
Fonte: fidelity_points.php (3846 righe) + fidelity_levels.php (handler POST,
redirige a fidelity_points su GET) + fidelity_wallet.php; confronto ANCHE
con l'istanza PHP LIVE (markup e KPI estratti dalla sessione autenticata).
Il core funzionale era gia' chiuso (F1-F8); questa passata allinea la GRAFICA
e completa il cablaggio dati:
1. KPI colonna destra: erano hardcoded a 0 nonostante l'API esponesse gia'
   `stats` (il componente non li leggeva!) — ora Punti emessi/usati/scaduti/
   Campagne attive sono live (verificato: 49/9/0/0 sui dati reali del tenant;
   il PHP live mostra 0 perche' il suo MySQL non ha transazioni punti — le
   formule coincidono).
2. Banner "nessuna campagna punti attiva": era SEMPRE visibile; ora
   condizionale come il legacy (punti attivi + nessuna campagna attiva oggi,
   alert-info) usando stats.activeCampaignToday.
3. Caption "Statistiche operative sede:": era hardcoded "Sede1" — ora nome
   sede corrente da /api/manage/locations (fallback "tutte le sedi").
4. Top clienti: azione "Apri"->scheda cliente sostituita con la legacy
   "Dettagli" -> fidelity_wallet&client_id.
5. LIVELLI CARD INLINE: il legacy ha l'editor DENTRO la pagina Punti
   (#livelli-card; fidelity_levels.php e' solo un handler POST che redirige)
   — il Next mostrava solo un bottone verso pagina separata. Ora
   FidelityLevelsContent accetta `embedded` e l'editor completo (righe
   dinamiche, livello base bloccato, Aggiungi/Salva livelli) e' incorporato
   nella pagina Punti; la pagina dedicata resta per l'URL legacy.
6. Campagne punti: sottotitolo legacy ("Crea campagne temporanee o sempre
   attive..."), riga "Campagna attiva oggi:" + badge (nome/"Nessuna"),
   colonne in ordine legacy Nome|Periodo|Accredito|Stato|Azioni, Periodo
   "Subito"/"Mai", Accredito "Fisso: 1 punto ogni X" / "Scaglioni (N)",
   empty state "Nessuna campagna punti configurata.".
7. Portafoglio (fidelity_wallet): etichette KPI legacy "Prenotati (lock)" /
   "In scadenza entro N giorni", colonne movimenti in ordine legacy
   Data|Tipo|Δ|Nota.
VERIFICA: marker legacy tutti presenti nel bundle della pagina Punti,
"Gestisci Livelli Card" (bottone non-legacy) rimosso, stats API corrette.
RESIDUI MINORI (documentati): i confirm di impatto usano window.confirm coi
testi legacy invece dei modali Bootstrap (Riepilogo impatto); il form
campagna e' inline invece che in modale; wallet filtro "Filtra/Reset" GET vs
ricerca live; colonne calendario scadenze piu' ricche del legacy.
BONUS: completato lo sweep slug-SSR sui file CRLF che il primo giro aveva
saltato (74 componenti) — stessa classe del bug //promotions.

## PUNTI — RESIDUI PIXEL-PERFECT CHIUSI (2026-07-03)
Completati i residui grafici della passata Punti (testi estratti dal PHP live
con ?new_campaign=1):
1. FORM CAMPAGNA IN MODALE (fidelityCampaignFormModal) come il legacy:
   titolo "Nuova campagna"/"Modifica campagna" + "Per una campagna sempre
   attiva lascia vuote le date...", campi Nome campagna / Data attivazione
   ("Vuota = subito.") / Data scadenza + checkbox "Mai" / Stato switch;
   sezione "Accredito in campagna" con radio Fisso/Scaglioni, input-group
   "1 punto ogni ... EUR", "Spesa minima ... EUR" ("0 = nessun minimo."),
   tabella scaglioni Spesa minima|Punti + "Aggiungi scaglione" + "Regola:
   si applica lo scaglione piu alto raggiunto."; sezione "Destinatari
   campagna" con radio "Tutti i livelli" + "Livelli Punti" per livello
   (lista da action=levels, prima era un input free-text). Footer "Salva
   campagna". Round-trip API verificato (save/toggle/delete ok, cleanup).
2. MODALE "Disattivare campagna punti?" (toggle-off) con "Disattiva
   campagna" e MODALE "Eliminare campagna punti?" con "Riepilogo impatto"
   verbatim ("Se la campagna ha storico operativo, verra rimossa
   dall'elenco e disattivata...") + "Motivo eliminazione (opzionale)"
   inviato all'API + "Elimina campagna" (prima window.confirm).
3. MODALI conferma impostazioni: "Disattiva sconto tramite punti" (Cosa
   succede continuando / Conferma disattivazione) e "Confermare scadenza
   punti?" (Riepilogo impatto / Cosa non cambia / Conferma e salva) — il
   testo di impatto arriva dal round-trip server come prima, ma renderizzato
   nel modale legacy invece che in window.confirm.
Verifica: tutti i 15 marker verbatim presenti nel bundle della pagina.
Restano window.confirm SOLO nei flussi livelli (threshold/delete cascade),
gia' documentati.

## PUNTI — FIX LAYOUT DA CONFRONTO SCREENSHOT (2026-07-03, segnalazione utente)
Confronto side-by-side PHP live vs Next: (1) ORDINE SEZIONI — nel legacy la
colonna sinistra e' Impostazioni -> Livelli Card -> Campagne punti (tutte in
col-lg-7); il Next aveva le Campagne punti SOPRA a tutto e a tutta larghezza
-> spostate in fondo alla colonna sinistra come Card C legacy. (2) Il banner
"Punti Fidelity attivi, ma nessuna campagna..." nel PHP live e' GIALLO
(alert-warning), non alert-info -> ripristinato alert-warning (la conferma
visiva dello screenshot batte la classificazione dell'audit sorgente).

## OMAGGI (gifts / gift_instance) — PARITA GRAFICA + FUNZIONALE (2026-07-03)
Legacy gifts.php ha DUE viste mutuamente esclusive; il Next mostrava una
pagina unica divergente -> riscritta gifts-content.tsx:
1. VISTA DEFAULT "Omaggi assegnati ai clienti": card con sottotitolo "Lista
   di tutte le istanze generate (accumulo / disponibile / riscattato /
   scaduto / annullato)." + meta "25 risultati per pagina"; filtri
   Cliente/gift/Stato con "Filtra"/"Reset" condizionale; tabella
   Data|Cliente(+badge Manuale)|gift|Sede|Stato|Scadenza|Dettagli(occhio ->
   gift_instance?id=); paginazione "Pagina X di Y • Totale: N" con
   "« Prev"/"Next »". Header: [Assegna gift outline-success][Campagne gift
   outline-primary].
2. VISTA ?action=campaigns "Campagne gift": header [<- Omaggi assegnati]
   [Nuova campagna]; tabella Nome|Uso|Sede|Premio|Stato|Azioni con kebab
   dropdown (Riepilogo/Modifica/Clona campagna/Disattiva-Attiva/Elimina con
   confirm legacy "Eliminare questa campagna e tutti i movimenti
   associati?"); badge stato Attiva/Completata/Sospesa/Disattivata/
   Programmata come statusMeta legacy. Router: carve-out esplicito in
   page.tsx per gifts&action=campaigns (FaithfulContent copre solo !action).
3. MODALE "Assegna gift manualmente" (#assignGiftModal, prima form inline):
   intro verbatim "Crea un'istanza in stato Disponibile...", Cliente
   (datalist), gift filtrato sugli attivi + help "Sono visibili solo gli
   omaggi attivi...", "Scadenza (giorni) (opzionale)" + help "Se vuoto, usa
   la scadenza configurata sull'omaggio.", footer Annulla + "Assegna"
   btn-success; round-trip force_ineligible conservato.
4. MODALE "Riepilogo" campagna (mancava del tutto): card Configurazione
   (Stato/Validita/Uso/Sedi abilitate/Premio/Descrizione) + card Statistiche
   (Clienti coinvolti/Istanze totali/Accumulo/Disponibile/Riscattato/
   Scaduto/Annullato/Ultimo sblocco/Ultimo riscatto/Ultimo annullamento/
   Ultima attivita) con "Calcolo impatto in corso..." — nuova API GET
   action=campaign_summary (giftCampaignSummaryStats, COUNT FILTER per
   stato su gift_instances).
5. gift_instance-content: card "Operazioni" con sotto-titolo "Riscatta gift
   (anche parziale)", intestazione "Stato e date" sopra la tabella date,
   testo contestuale stato disponibile ("Questo gift è disponibile. Puoi
   registrare riscatti parziali dalla box Operazioni oppure annullarlo.").
Verifica: 32/32 marker verbatim nel bundle (entrambe le viste + istanza);
battery e2e 20/20 (save campagna -> lista -> summary a zero ->
assign_manual_check -> assign_manual con scadenza 5gg -> istanza
disponibile+Manuale -> summary 1/1/1 + lastUnlock -> cancel (annullato=1,
lastCancel) -> delete_instance -> toggle off/on -> delete campagna, cleanup
CLEAN; la cascata delete campagna rimuove istanze/transazioni/regole).
DIVERGENZE DOCUMENTATE: modali ricchi cancel/delete della pagina istanza
restano window.confirm con testo server; il modale Riepilogo non include
l'editing inline Condizioni/esclusioni (coperto dall'editor).

## BUONI / COUPON (coupons.php) — PARITA GRAFICA + FUNZIONALE (2026-07-03)
UI gia' molto fedele (lista 10 colonne, editor, modale disattivazione); i gap
veri erano nel motore preview e nel filtro sede. Fatto:
1. MOTORE PREVIEW RISCRITTO (previewDbCoupon = coupon_validate_row +
   coupon_eval_discount): rimossi i reason inventati ("Coupon non attivo.",
   "Coupon esaurito.", "Minimo carrello non raggiunto.") a favore dei verbatim
   legacy: "Coupon non trovato." / "Coupon disattivato." / "Coupon non valido
   per questa sede." / "Coupon non ancora attivo per la data selezionata." /
   "Coupon scaduto per la data selezionata." / "Seleziona un cliente per usare
   questo coupon." / "Limite di utilizzo per cliente raggiunto (used/limit)." /
   "Importo minimo richiesto: X." / "Nessun servizio/prodotto selezionato
   rientra nel coupon." / "Coupon non applicabile.". Il LIMITE era applicato
   sul conteggio GLOBALE: ora e' PER CLIENTE come il legacy (conteggio attivo
   da sales.coupon_code/marker note + appointments marker note, stati annullati
   esclusi). apply_scope ORA ONORATO: base eleggibile calcolata sugli item del
   carrello (coupon_item_matches_scope su servizi/prodotti/categorie), minimo
   confrontato con l'eleggibile per scope ristretti, sconto cappato a
   eleggibile e subtotale. Vincolo sede via coupon_locations (vuoto = tutte).
2. CALL-SITE: il checkout POS (manage-pos) passa il carrello reale + cliente +
   sede e mappa i reason eval nelle varianti Cassa verbatim ("Coupon non
   applicabile: importo minimo richiesto X." / "Coupon non applicabile agli
   articoli presenti nel carrello."); il POS UI invia items_json + client_id
   al preview; drawer e booking pubblico passavano gia' service_ids (ora la
   preview costruisce gli item dal listino servizi). Fix: la route trattava
   client_id=0 come assente -> "Seleziona un cliente" non scattava mai.
3. FIX VALIDAZIONE CODICE: normalizeCouponCode strippava i caratteri invalidi
   PRIMA della regex ("??bad!!" -> "BAD" salvato!); ora normalizzazione legacy
   (upper + solo spazi rimossi) e la regex rifiuta davvero.
4. LISTA: filtro sede implementato (default = sede corrente di sessione via
   coupon_locations, all_locations=1 disattiva; empty state e bottone "Nuovo
   coupon" sul conteggio NON filtrato come il legacy). Card filtro "Tutte le
   sedi" solo per tenant multi-sede ($couponShowAllLocationsFilter). FIX
   DELIBERATO di un bug legacy: coupons.php racchiude ANCHE la tabella nel
   gate multi-sede, quindi un tenant mono-sede non vede MAI i coupon creati
   (verificato sul PHP live: coupon creato -> lista vuota); nel Next la
   tabella resta visibile.
5. EDITOR: back-button "← Buoni" come il legacy (era "Torna ai coupon");
   codice PRE-GENERATO server-side all'apertura del form new + bottone
   "Genera" via nuova GET action=gen_code (charset senza 0/1/I/L/O, unicita'
   vs coupons E promozioni, fallback client); modale disattivazione completata
   con "Storico collegato: X vendite e Y prenotazioni." (salesCount/
   appointmentsCount aggiunti a action=get); classe coupons-location-valid-cell
   sulla colonna Valido; slug prop al carve-out router (bug SSR //pagina).
Verifica: 39/39 marker verbatim nel bundle (lista + editor new/edit); battery
e2e 38/38 (gen_code, 6 validazioni save verbatim, duplicato, lista filtrata
sede/all_locations, preview base/scope/fuori-scope/minimo/date/as-of/limite
cliente/sede, cancel+audit+doppio, delete hard, cleanup CLEAN). Coupon
temporaneo creato sul PHP live per il confronto markup rimosso dal MySQL.
DIVERGENZE DOCUMENTATE: il preview coupon del POS Next non cumula con le promo
AUTO (il POS Next usa promozioni selezionate dall'operatore, divergenza M1 gia'
approvata); "Tutto il carrello (legacy)" visibile solo su coupon storici con
scope=all, come il legacy.

## PACCHETTI CATALOGO (packages.php tab=catalog) — PARITA GRAFICA + FUNZIONALE (2026-07-03)
Il CRUD era gia' portato (packages/package_services/package_items/
package_pricing/package_locations, prezzo SEMPRE calcolato dalle righe);
i gap erano grafici e di validazione. Fatto:
1. HEADER LEGACY su lista ed editor: il legacy usa lo STESSO header su tutti
   i tab (titolo "Pacchetti", kicker "Gestione pacchetti e sedute",
   sottotitolo "Configura catalogo, assegnazioni clienti e sedute residue.")
   con bottoni [Impostazioni][Pacchetti clienti][Nuovo pacchetto|Catalogo];
   il Next aveva titoli propri ("Catalogo pacchetti", "Nuovo pacchetto") ->
   riscritti come il live.
2. FORM EDITOR RISCRITTO sul markup live estratto (action=catalog_new):
   ordine campi legacy (Nome -> Contenuto pacchetto -> Validita -> Stato ->
   Sedi abilitate -> Descrizione); box #pkgItemsBox con colonne Servizio /
   Prodotto | Quantita | Prezzo listino | Sconto | Totale riga; COMBOBOX
   RICERCABILE per riga (port di .app-combobox: bottone form-control +
   dropdown con "Cerca…") al posto della select piatta; bottoni separati
   "Aggiungi servizio" / "Aggiungi prodotto" (disabilitato con title
   "Nessun prodotto disponibile in Magazzino") al posto della colonna Tipo;
   totali DENTRO il box (Subtotale righe / Sconto sul totale / Totale
   pacchetto readonly + "Calcolato automaticamente." + hint "Sedute servizi:
   N • Prodotti: M"); Stato select Attivo/Disattivo (era uno switch); Sedi
   abilitate come TABELLA Sede|Vendibile (era una checkbox-list); campo
   DESCRIZIONE aggiunto (mancava del tutto nella UI; il backend lo salvava
   gia'); validita placeholder "Es. 365" + help verbatim.
3. STATO BLOCCATO (packages.php 3678-3704) portato: con catalog_new e nessun
   servizio attivo -> sezione .package-catalog-blocked "Nessun contenuto
   attivo disponibile" con testi verbatim e bottoni Nuovo servizio / Nuovo
   prodotto / Torna al catalogo (il CSS esisteva gia' ma era orfano).
4. VALIDAZIONI SERVER mancanti aggiunte a saveManagePackageCatalog:
   "Nome obbligatorio" (senza punto, come il legacy); righe con servizio/
   prodotto inesistente O DISATTIVO rifiutate ("Servizio non valido o non
   attivo nel pacchetto." / "Prodotto non valido...); compatibilita' sede
   per ogni riga via service_locations / product_stocks ("Un servizio del
   pacchetto non e abilitato per tutte le sedi selezionate." / "Un
   prodotto..."). Ordinamento lista legacy (attivi prima, poi nome).
5. FILTRO SEDE LISTA: default = sede corrente di sessione (package_locations
   vuoto = ovunque), all_locations=1 disattiva; card "Tutte le sedi" solo
   multi-sede; empty state sul conteggio NON filtrato.
6. Slug prop ai carve-out router (PackagesCatalogFormContent +
   ClientPackageDetailContent) — stessa classe del bug SSR //pagina.
Verifica: 44/44 marker verbatim nel bundle (lista + editor new/edit + stato
bloccato); battery e2e 27/27 (context, 6 validazioni verbatim, calcolo prezzo
97.20 = righe scontate -10% totale, round-trip catalog_get con description/
sconti/sedi, edit con ricalcolo 52, filtro sede, issue istanza -> soldCount 1
-> delete con detach (storico conservato, package_id=NULL), cleanup CLEAN
incluse le istanze cliente via pg). Pacchetto temporaneo creato sul PHP live
per il confronto markup rimosso dal MySQL (packages + 4 tabelle figlie).
DIVERGENZE DOCUMENTATE: i bottoni dello stato bloccato non sono gated sui
permessi services.manage/products.manage (il componente non ha le perms;
la pagina di destinazione resta comunque protetta); il bug legacy del filtro
(hidden page=pacchetti invece di packages, riga 3989) non riprodotto.

## GIFTBOX / GIFTCARD MANAGE (giftcard.php / giftbox.php / *_settings) — PARITA (2026-07-03)
Le pagine settings e i voucher pubblici erano gia' fedeli; dettagli e liste
avevano UI semplificate. Fatto in questa passata:
1. LISTE EMESSE RISCRITTE (giftcard action=list / giftbox tab=instances):
   filtri legacy Mittente / Cerca ("Codice, destinatario...") / Stato
   (Tutti/Attiva/Riscattata/Scaduta/Annullata) + "Tutte le sedi" solo
   multi-sede; colonne legacy Codice | Mittente | Destinatario | [Sede] |
   (Iniziale | Saldo per giftcard) | Stato | Emessa | Scadenza | (Riscatto per
   giftbox) | Azioni; Codice e bottone stampa linkano il voucher pubblico via
   token; azione "Dettaglio" (era "Apri"). Nuove API action=manage_list con
   righe arricchite (mittente da clients, sede, badge legacy, token voucher)
   filtrate per sede corrente salvo all_locations=1; empty state su conteggio
   NON filtrato. BADGE LEGACY: redeemed -> "Riscattata" bg-info (il Next
   mostrava "Utilizzata" bg-secondary), expired -> bg-warning, cancelled ->
   bg-danger; per giftbox issued -> "Attiva". Stato effettivo: expires_at
   passato + attiva => Scaduta (il legacy esegue expireDue* a ogni accesso).
2. HEADER LEGACY: giftcard [Torna alla lista][Crea GiftCard -> pos se non
   vuota]; giftbox [← Fidelity][Impostazioni][Crea GiftBox se non vuota] —
   rimosso il bottone "Template GiftBox" inventato dal Next (il legacy
   raggiunge tab=boxes dalla hub Fidelity).
3. TAB TEMPLATE (tab=boxes) riscritto sul markup live: barra "Template
   GiftBox (contenuti + regole base)" + [Nuova GiftBox]; card header "GiftBox"
   + "N totali"; colonne Nome | Stato (Attiva/Disattiva) | Costo punti |
   Livello (Tutti i clienti / Punti: keys / Fidelity) | Contenuti | Istanze |
   Validita (d/m/Y → d/m/Y); vuoto "Nessuna GiftBox."; confirm delete legacy
   "Eliminare questa GiftBox?" (era un testo inventato).
4. EDITOR TEMPLATE: aggiunto il blocco "Livelli Card (obbligatorio)" /
   "Livelli Punti" (gbLevelsWrap) visibile con "Solo clienti con Fidelity",
   con PERSISTENZA eligible_levels_points (whitelist dai livelli configurati)
   e validazione verbatim "Errore: seleziona almeno un livello Punti." —
   era un TODO dichiarato. Header pagina legacy (Fidelity / GiftBox + barra
   template) al posto del titolo inventato "Nuova/Modifica GiftBox".
5. FIX getFidelityLevelsSettings: senza livelli JSON configurati ricostruisce
   i default legacy Bronze/Silver/Gold dalle soglie (Fidelity.php ~579,
   default 200/500) — il PHP live elenca i livelli anche prima della prima
   configurazione, il Next tornava lista vuota (blocco Livelli invisibile).
6. Slug prop ai 3 carve-out (dettaglio giftcard, dettaglio istanza giftbox,
   editor template) — classe bug SSR //pagina.
Verifica: 55/55 marker verbatim nel bundle (liste, tab template, editor,
entrambe le settings); battery e2e 23/23 (validazioni template verbatim,
livelli obbligatori/azzerati, colonna Livello, manage_list giftbox+giftcard,
issue giftcard -> mittente risolto + badge Attiva -> redeem parziale/totale ->
"Riscattata" bg-info -> update destinatario da anagrafica; cleanup CLEAN via
pg incluse le righe da tentativi di validazione).
RESIDUI DOCUMENTATI (dettagli card/istanza — UI semplificata funzionante):
- giftcard edit legacy: card riepilogo completa (Evento, Voucher nascondi
  importo, Inizio validita), modale "Modifica scadenza GiftCard", card "Invio
  email al destinatario", riscatto per-item (giftcard_items), colonne
  movimenti Sede/Operatore, select Mittente/Evento. Il Next copre riscatto
  importo, destinatario+cliente, messaggio/nota interna, movimenti base.
- giftbox edit_instance legacy: riscatto PARZIALE per-item con tabella
  Tot/Usati/Da riscattare + "Seleziona tutti i rimanenti", modale scadenza,
  invio email, movimenti virtuali. Il Next copre riscatto totale, annulla,
  destinatario (gli appuntamenti riscattano gia' i singoli item).
- Topup/cancel giftcard assenti anche nel legacy (disabilitati): parita'.

## IMPOSTAZIONI BOOKING (booking.php manage + hours + locations/services) — PARITA (2026-07-03)
L'area era gia' molto coperta: la pagina manage "Booking / Opzioni della
prenotazione online" (scelta operatore, annullamento cliente + tempo minimo
con clamp 8760h/365gg, card "Link prenotazione online"), la pagina "Orari &
chiusure" (3 tab con orario spezzato/chiusure/straordinari), il toggle
"Abilita in prenotazioni online" per sede (con gating piano) e per servizio,
e booking_about_text nel Profilo attivita' erano gia' fedeli e verificati coi
marker. PARITA' CONFERMATE (comportamenti fissi identici al legacy, NON
configurabili nemmeno li'): step slot HARDCODED 5 minuti (build_slots
$step=5*60), prenotazione pubblica SEMPRE 'pending' ("Richiesta inviata / In
attesa di approvazione"), nessun anticipo minimo/massimo configurabile (solo
"no slot passati oggi"), cancel policy consumata SOLO dall'area cliente.
FIX DI QUESTA PASSATA:
1. booking_choose_staff_enabled ERA SALVATO MA INERTE lato pubblico: il
   wizard mostrava sempre lo step "Professionista". Ora il context pubblico
   espone chooseStaffEnabled (businesses.booking_choose_staff_enabled) e il
   wizard SALTA lo step 4 quando disattivato, forzando "Qualsiasi" con
   auto-assegnazione dallo slot — port di CHOOSE_STAFF_ENABLED /
   skippedStaffStep di booking-wizard.js (211/233/4161).
Verifica: 20/20 marker verbatim (pagina Booking, Orari & chiusure, Sedi);
battery e2e 12/12 con snapshot/restore delle impostazioni reali (save
round-trip 4 campi, clamp legacy 99999h->8760 e 999gg->365, context
chooseStaffEnabled true/false, filtri booking_enabled sede+servizio nel
context, griglia slot a passo 5 minuti).
DIVERGENZA DELIBERATA (decisione utente PENDENTE, gia' tracciata): il legacy
RICHIEDE il login cliente per prenotare (BookingAuth, verifica email 6 cifre,
guest esplicitamente rimosso — booking.php 2940/7307/9313); il Next consente
la prenotazione guest con auto-link dell'account per email
(upsertPublicCustomerFromBooking), coi benefici cliente comunque gated sulla
sessione. Da decidere prima del deploy se riprodurre il gate legacy.

## GIFTBOX/GIFTCARD — DETTAGLI COME PHP + FIX VOUCHER (2026-07-03, segnalazione utente)
Confronto screenshot PHP live (edit_instance id=3) vs Next: i dettagli erano
UI semplificate e il bottone Voucher non funzionava. RISCRITTI ENTRAMBI I
DETTAGLI sul layout legacy, con nuovo modulo lib/gift-issue-details.ts:
1. DETTAGLIO ISTANZA GIFTBOX (giftbox.php edit_instance): card riepilogo
   (Codice+badge, Evento, Emessa il, Inizio validita, Scadenza con matita ->
   modale "Modifica scadenza GiftBox" con validazioni verbatim, Riscatto
   "X / Y utilizzati · Z disponibili" + badge PARZIALE + "in sospeso su
   prenotazioni", Contenuto regalo); form "Dati GiftBox" (Mittente select con
   "Seleziona un cliente", Evento con i 12 template legacy, Sede emissione
   readonly + help verbatim, "Nascondi importo nel voucher pubblico (QR)",
   Destinatario + "Destinatario già cliente" con ricerca e alert-info
   verbatim, Nota per il cliente, Messaggio di dedica); card "Invio email al
   destinatario" (send_email con "Mostra contenuto nella mail", Ultimo invio,
   Invio programmato); card "Riscatta GiftBox (anche parziale)" con tabella
   Elemento|Tot|Usati|Da riscattare, badge esaurito/in sospeso, "Seleziona
   tutti i rimanenti"/"Svuota selezione", confirm "Registrare il riscatto
   selezionato?", messaggi "Riscatto registrato (parziale)"/"GiftBox
   riscattata completamente"; card "Nota interna"; colonna dx "Movimenti"
   virtuali legacy (Data|Tipo|Quantita|Servizio/Prodotto|Sede|Nota|Operatore:
   issue/redeem/pending/cancel/expire con note "Emissione GiftBox",
   "In sospeso su prenotazione #X" ecc.). Header legacy [Lista GiftBox]
   [Dettagli vendita][Voucher][Impostazioni][Crea GiftBox]. NOTA PARITA': il
   legacy NON ha "Annulla GiftBox" in questa vista -> bottone rimosso (l'API
   cancel resta per i flussi POS).
2. DETTAGLIO GIFTCARD (giftcard.php edit): card riepilogo (Importo iniziale,
   Saldo, Emessa il, Scadenza+matita, Evento, Sede emissione, Voucher
   "Importo nascosto/visibile", Contenuto regalo con residui, Messaggio di
   dedica); alert readonly "GiftCard annullata: dati, note, invii email e
   operazioni non sono modificabili."; form "Dati GiftCard" ("Seleziona un
   mittente."); "Invio email" con "Mostra importo e contenuto nella mail";
   "Operazioni" con "Riscatta (scala credito)" + riscatto per-item
   ("Segna come utilizzato", giftcard_items.redeemed_qty, messaggi verbatim
   "Voce non trovata."/"Quantità eccede il residuo"); "Nota interna";
   Movimenti con Sede e Operatore dal ledger.
3. NUOVE AZIONI API: giftbox update_instance esteso (mittente/evento/hide/
   dedica), update_instance_expiry, redeem_instance_partial (giftbox_
   redemptions + redemption_items per-item, flip a redeemed quando tutto
   consumato), update_instance_internal_note, send_email; giftcard update
   esteso, update_expiry (+ledger expiry_change, riattivazione da scaduta),
   update_internal_note, redeem_item, send_email. Email con template moderno
   (SES-gated: "Invio email non disponibile" senza SES).
4. FIX BOTTONE VOUCHER: token voucher_public_token BACKFILLATO lazy quando
   mancante (64 hex generato e persistito alla lettura del dettaglio) e
   bottoni/link puntati su /slug/gift*_voucher?public=1&embed=1&token= —
   verificato end-to-end (pagina 200 + API pubblica risolve il token nel
   codice) per entrambi.
Verifica: 64/64 marker verbatim nel bundle dei due dettagli; battery e2e
33/33 (istanza creata via pg su template throwaway: detail Full, eventi=12,
validazioni verbatim su dati/scadenza/riscatto, parziale 1/3 -> PARZIALE ->
completamento, contatori per-item, movimenti con operatore, giftcard update/
expiry/redeem/nota, voucher pubblici; cleanup CLEAN).

## POS PAGAMENTI — EMETTI GIFTBOX/GIFTCARD COME PHP (2026-07-03, segnalazione utente)
Confronto screenshot: i modali POS divergevano dal legacy (GiftBox con
template+prezzo inventati; GiftCard senza note/invio email). RIFATTI sul
markup live estratto (#posModalGiftbox / #posModalGiftcard):
1. MODALE "Emetti GiftBox" = MODELLO DRAFT LEGACY: niente piu' tab "Da
   modello/Personalizzata", select template e campo Prezzo — la GiftBox
   AVVOLGE le righe del carrello (box "Contenuto GiftBox" con i due testi
   verbatim e tabella Tipo|Elemento|Q.ta'); i servizi devono essere
   Prepagato e i prodotti Ordinato (messaggio blocco verbatim "Per creare
   una GiftBox, i servizi devono essere impostati come Prepagato (...) e i
   prodotti ... Ordinato (...)"); "Salva" memorizza il DRAFT (nessuna riga
   carrello; footer con link "Elimina" + confirm "Eliminare la GiftBox?");
   al Concludi le righe eleggibili diventano il contenuto (customItems) e la
   vendita registra UNA riga "GiftBox • {code}" col totale, come pos.php.
   Campi legacy completi: Evento (giftbox generica), Valida dal/al,
   Destinatario+Email, "Destinatario già cliente" con ricerca e box
   selezionato, Nascondi importo (help "prezzi listino"), Dedica, Nota per
   il cliente, Nota interna, Invio email (Non inviare / subito / programmata
   + Data invio + "Mostra importo e contenuto nella mail"). Validazioni JS
   verbatim (mittente, evento, date, destinatario, email, data invio).
2. MODALE "Emetti GiftCard": riordinato sul live (Importo/Evento/Valida/
   Destinatario) + AGGIUNTI i campi che erano solo DOM morto o assenti:
   "Destinatario già cliente" con ricerca (era una select), Nota per il
   cliente, Nota interna, sezione Invio email completa; RIMOSSO il campo
   "Codice (opzionale)" (non esiste nel legacy, codice sempre auto GC-...);
   footer "Aggiungi alla lista"; etichetta riga carrello legacy
   "GiftCard • {evento} • {destinatario}"; una sola GiftCard per vendita.
3. TOGGLE STATO RIGA CARRELLO (pos.js buildItemStatusControl): badge +
   switch "Eseguito / Prepagato" sui servizi e "Ritirato / Ordinato" sui
   prodotti — mancava del tutto; item_status del toggle ora PERSISTITO al
   checkout (buildSaleItems gia' normalizzava, la UI non lo esponeva).
4. BACKEND EMISSIONE ESTESO (issueGiftcardFromSale/issueGiftboxFromSale):
   nota cliente (giftcards/giftbox_instances.note + marker vendita), nota
   interna (internal_note), invio email none|now|date (scheduled_send_on per
   il cron *-send; invio IMMEDIATO best-effort al Concludi via
   sendGiftCardEmailManage/sendGiftBoxInstanceEmail, SES-gated),
   email_show_amount/email_show_details dal checkbox dedicato (prima
   derivato erroneamente da hide-amount). Nuovi campi item pipeline:
   internalNote/sendMode/sendOn/showAmount (tenant-store + route parsing).
5. COLONNA DESTRA: "Tipo pagamento" a RADIO btn-check 2x2 (Contanti/Carta/
   Assegno/Bonifico) come pos.php 6298-6319 (era una select).
Verifica: 38/38 marker verbatim nel bundle POS; battery e2e 11/11 (checkout
giftcard con note+scheduled_send_on+show_amount=0 senza invio immediato;
checkout giftbox dal carrello: riga vendita "GiftBox • GBX-...", istanza con
evento/hide/note/interna e contenuti servizio x2 dal carrello; item_status
prepaid persistito; cleanup CLEAN via pg incluse vendite).
RESIDUI DOCUMENTATI (colonna destra): card Residui legacy con link "Apri
scheda" + #posResidualsModal (il Next usa i controlli inline equivalenti);
pacchetti "in GiftBox" (badge GiftBox sulla riga pacchetto + inclusione nel
contenuto); percorso diretto posAction=issue_giftbox/issue_giftcard non
usato dalla UI legacy attuale.

## PAGAMENTI — AUDIT COMPLETO FUNZIONE-PER-FUNZIONE (2026-07-04, richiesta utente)
Doppio inventario esaustivo (pos.php 7148 righe + pos.js 5948 + pagine
pos_history/pos_prepaids/pos_preorders/pos_settings/pos_sale_detail/
pos_success) vs Next. PARITA' GIA' PRESENTI e confermate: sidebar completa
(Movimenti/Prepagati/Preordini/Impostazioni), checkout completo, vendita da
preventivo (quote_cart + lock + converted), residui/punti/coupon/promo/rate,
annulla vendita (motivazione obbligatoria + magazzino restore/no_restore +
storno punti normal/negative/skip anche per-ricarica), elimina vendita
annullata, ritiri preordini e esecuzioni prepagati con qty parziale e
timeline, ricevuta stampabile con Buoni emessi, header Cassa e Movimenti.
FALSI GAP smontati dall'inventario legacy (parita' senza intervento):
- modali "Nuovo cliente"/"Trova"/"Scheda semplificata" NON esistono nel POS
  legacy (sono del quick-booking drawer globale); in cassa c'e' solo il link
  alla rubrica, come nel Next;
- creazione "Buono" in cassa (new_coupon): backend+JS legacy pronti ma gli
  hidden NON sono renderizzati nel form corrente -> feature DORMIENTE anche
  nel legacy, non portata;
- "Codice tessera": display statico "—" ANCHE nel legacy (pos.js non lo
  popola mai);
- pos_success come pagina autonoma: nel Next e' la ricevuta inline (parita'
  funzionale, divergenza di navigazione documentata).
FIX DI QUESTA PASSATA:
1. RESIDUI COME IL LEGACY: il box mostra SOLO il riepilogo dinamico
   ("Credito disponibile € X • N GiftCard disponibili • Non utilizzabili con
   una ricarica in carrello • In uso: ...") + link "Apri scheda" che apre il
   modale #posResidualsModal ORA WIRED (card Credito con checkbox+Importo da
   usare+Usa max; card GiftCard con lista radio+importo+Usa max; "Applica"
   copia nei valori applicati). Prima i controlli erano inline nel box e il
   modale era markup morto con id duplicati.
2. STATO VUOTO CLIENTI (pos.php 5943-5959): card "Nessun cliente
   disponibile" con testo verbatim + bottoni Nuovo cliente/Apri Clienti.
3. posRedeemInfo default verbatim: "Seleziona un cliente per vedere punti,
   credito, omaggi disponibili." (era "...credito disponibili.").
4. FILTRO AREE CATALOGO wired: select "Tutte le aree" ora filtra per
   categoria (distinte da servizi/prodotti correnti, reset al cambio tab) —
   era una select statica.
5. RICEVUTA: blocco "Fidelity" con Punti usati / Punti guadagnati
   (pos_success.php card Totali) — checkout ora ritorna
   fidelityPointsEarned.
Verifica: 19/19 marker verbatim; battery e2e 6/6 (fidelityPointsEarned nella
risposta, item_status executed persistito, client_residuals, snapshot/restore
punti cliente, cleanup CLEAN).
RESIDUI DOCUMENTATI: modes AJAX legacy client_gifts_v2/preview_auto_promo/
catalog_promos coperti da flussi equivalenti Next (omaggi auto al checkout da
appuntamento, Rileva promozione); vendita da appuntamento e' un EXTRA Next
(il legacy incassa gli appuntamenti dal quick-booking); pacchetti "in
GiftBox" (badge) ancora da portare.

## Pagamenti — logiche dinamiche pos.js (2026-07-04)

Porting COMPLETO delle logiche runtime di pos.js (recalcTotals ->
syncPaymentTypeControls -> syncInstallmentPlanForContext ->
renderInstallmentCard -> syncConcludeState + pre-check bottom bar) in
pos-content.tsx, su segnalazione screenshot utente (stati dinamici mancanti).

1. TOTALE NETTO legacy: il "Totale" del dettaglio prezzi e tutte le logiche
   di pagamento usano currentPosTotal = totale al NETTO dei residui applicati
   (GiftCard poi Credito). Al checkout i residui restano tender distinti.
2. TIPO PAGAMENTO (syncPaymentTypeControls): markup legacy
   pos-payment-type-grid/option/label (id posPaymentTypeCash/Card/Check/Bank),
   radio disabilitati + card is-disabled con totale a 0, help a due stati
   verbatim ("Seleziona come paga il cliente." / "Totale a 0: nessun tipo di
   pagamento selezionabile."). Rimosse le righe extra non-legacy (importo
   base, Residui applicati, Pagato, Rimanente).
3. RATEIZZAZIONE (renderInstallmentCard): scelta '' | single | installment
   che parte VUOTA ed e' OBBLIGATORIA con totale > 0 (badge fisso "Scelta
   obbligatoria" + card is-required); headline a 5 stati; bottone Rateizzato
   con testo dinamico (Rateizzato/Configura piano/Modifica piano) e classi
   is-selected/is-pending; help in cascata a 8 stati + 2 override ricariche +
   notice contestuale; piano come SNAPSHOT salvato dal modale (riepilogo
   "Acconto oggi • Residuo • N rate • Cadenza • Prima scadenza" + Note: +
   tabella "Rata N" con date dd/mm/yyyy); syncInstallmentPlanForContext
   (totale a 0 -> reset scelta; ricarica -> forza Pagamento unico; cambio
   cliente/totale>0.02/tipo pagamento -> piano rimosso col notice verbatim);
   reset scelta a VUOTO dopo ogni vendita. Backend: financed sul totale
   NETTO dei tender wallet/giftcard (semantica legacy sale_total del piano).
4. CONCLUDI (getConcludeBlockReason + syncConcludeState): catena completa dei
   motivi di blocco SEMPRE visibile in posConcludeHelp + bottone disabilitato
   con title (carrello vuoto, mittente GiftBox diverso/mancante, cliente
   richiesto, mittente GiftCard, 7 motivi rateizzazione verbatim).
5. BOTTOM BAR pre-check al click (alert verbatim): GiftBox (GiftCard in
   carrello, ricarica, mittente, "Aggiungi prima almeno un contenuto nella
   lista...", messaggio eleggibilita'), GiftCard (GiftBox attiva, solo-
   GiftCard, mittente), Ricariche (4 alert esclusivita' + "Seleziona prima un
   cliente."), Pacchetti (GiftCard/ricarica, "Nessun pacchetto configurato.").
   gbDraft ora memorizza il mittente (senderClientId) per il blocco
   "GiftBox collegata a un mittente diverso".
6. BADGE + posRedeemInfo (syncClientMetaUI): "Fidelity: SI/NO/—" dall'
   adesione reale (tessera attiva), "Punti: …" durante il caricamento;
   posRedeemInfo a 3 stati (default dinamico / "Caricamento punti
   disponibili…" / vuoto) — rimossi i testi inventati "Residui disponibili".
7. BOX PUNTI (pos.js sync + calcMaxPointsUse): label legacy "Punti da usare",
   visibile solo con max spendibile > 0 (0 con ricarica o sotto il minimo),
   help CONCATENATO verbatim "Disponibili: N Punti • Max: M Punti • Saldo •
   Prenotati • [Saldo negativo...] • Min • Stai usando ~€ X,XX". API
   client_residuals estesa: points = DISPONIBILI (saldo - prenotati da
   appuntamenti aperti, Fidelity::reservedPoints) + pointsBalance/
   pointsReserved/fidelityAdhering.
8. COUPON (fetchPreview + syncRechargeExclusivePricingState): esito valido
   SILENZIOSO (niente "Coupon applicato."), input readOnly a coupon
   applicato, "Puoi applicare un solo coupon per vendita...", esiti
   reason/"Codice non trovato."; lock ricarica con azzeramento di coupon/
   sconti/punti/promo + controlli disabilitati + help verbatim "Con una
   ricarica in carrello coupon, buoni, promozioni, sconti e punti non sono
   applicabili."; righe dettaglio con etichette legacy ("Coupon / Promo",
   "Promozione: {nome}").
9. AUTO-PROMOZIONI (preview_auto_promo): rilevazione SILENZIOSA debounced
   250ms su cambio carrello/cliente senza coupon/ricarica — rimosso il
   bottone non-legacy "Rileva promozione".
Verifica: 60/60 marker verbatim nel bundle; battery e2e 16/16 (residuals con
saldo/prenotati/adesione, non aderente a 0 punti, piano rate financed=totale-
acconto, piano su totale NETTO con GiftCard residuo 100-20=80, guardia
"Pagamento insufficiente." sull'acconto, cleanup CLEAN con dati throwaway).
RESIDUI DOCUMENTATI: fidLabel fisso "Punti" (config etichetta non portata);
badge Fidelity mostra "—" durante il fetch (il legacy ha l'adesione
pre-renderizzata nelle option); promo AUTO non cumulata col coupon (M1).

## Pagamenti — AUDIT ESAUSTIVO legacy vs Next (2026-07-04, seconda passata)

Doppio inventario completo (agent su pos.php 7148 righe + pos.js 5948 righe vs
route/manage-pos/pos-content) + test live sugli endpoint AJAX PHP (curl con
sessione). GAP REALI trovati e chiusi:

1. PROMO TILE CATALOGO (mode=catalog_promos): nel Next il badge "Promo" e il
   prezzo barrato erano markup statico d-none. Portato: nuova
   evaluateCatalogTilePromos (ogni tile valutato da solo qty=1, prezzi da DB,
   promo "su codice" e per-cliente-senza-cliente escluse, limite utilizzi
   contato una volta per promo), azione POST catalog_promos, effetto UI
   debounced 220ms con chiave cid|mode|ids (pos.js loadTilePromos) e render
   tileSetPromo (badge "-N%" o "Promo", title=nome promo, prezzo promo).
   Il click aggiunge a prezzo pieno (sconto dall'auto-promo, come legacy).
2. AUTO-PROMO auto_only: l'evaluate del POS ora esclude le promo con
   coupon_code ("su codice", pos.php 1545-1548) e, senza cliente, quelle con
   per_customer_limit (pos_promotion_requires_client).
3. CAP PUNTI CON PROMO NON CUMULABILE (stackable bitmask): client
   (calcMaxPointsUse 1942-1947) e server (pos.php 4466-4512) ora limitano i
   punti alla parte NON scontata dalla promo (nonDiscountedSubtotal ESATTO dal
   motore, con ripartizione proporzionale dello sconto manuale); senza parte
   non-promo la richiesta punti si azzera IN SILENZIO come il legacy.
4. SCELTA UNICO/RATEIZZATO OBBLIGATORIA ANCHE SERVER-SIDE (pos.php 4631):
   nuovo input installment_choice; con totale netto > 0 e scelta assente il
   checkout fallisce con "Seleziona se il cliente paga in unica soluzione o
   rateizzato prima di concludere la vendita."; ricariche solo con single;
   installment richiede cliente + piano.
5. NOTE VENDITA LEGACY: "Promozione: {nome} -{importo}", "Coupon: {CODE}" +
   "Sconto coupon: - € {n}", "Sconto manuale: -€ {n}", "GiftCard utilizzata
   ({code}): -€ {n}", "Credito utilizzato: -€ {n}", "Tipo pagamento:
   {Contanti|Carta di Credito|Assegno|Bonifico}", e post-emissione
   "Pacchetti: CP#12, CP#13" / "Ricariche: R#5" (fmt_money it-IT).
6. MESSAGGI RESIDUI VERBATIM (pos.php 3187-4013 + 5717-5749): "Per usare il
   credito/una GiftCard devi selezionare un cliente.", "Seleziona la GiftCard
   da usare tra i residui del cliente.", "La GiftCard selezionata non è
   disponibile tra i residui del cliente.", "Saldo GiftCard non disponibile.",
   "Credito insufficiente (saldo modificato da un'altra operazione). Riprova.";
   stock: "Stock insufficiente per {nome}".
7. MITTENTE GIFTCARD: la riga giftcard memorizza il mittente (gc_client_id);
   cambio cliente -> Concludi bloccato con "La GiftCard è collegata a un
   mittente diverso. Rimuovila e ricreala per il mittente selezionato.".
8. GUARDIE TILE (pos.js addItem 189-198): con GiftCard/ricarica in carrello i
   tile alert-ano "Non puoi aggiungere altri elementi..." / "Non puoi
   aggiungere servizi o prodotti...".
9. PREVIEW PUNTI RICARICA (mode=preview_recharge_points): nuova azione
   recharge_points_preview + riga legacy "Punti accreditati" nel modale
   (debounced, '...' in caricamento, campagna nel title); avviso "Nessun
   modello di ricarica disponibile..." a lista modelli vuota.
10. BLOCCO INFO FIDELITY sotto Concludi (pos.php 6399-6411): "Fidelity attivo:
    accredito secondo la campagna punti valida al momento della vendita • /
    nessuna campagna punti attiva oggi • 1 punto = € X" (contesto:
    fidelityEarnInfo con campaignActiveToday).
11. ETICHETTA "Sconto Fidelity (N Punti)" (pos.js 3497) + notice "Pagamento in
    unica soluzione selezionato." al click su Pagamento unico (pos.js 3635).
12. QUOTE LOCK (pos.js 1833-1865 + pos.php 5996-6170): con ?quote= il POS ora
    BLOCCA righe (qty readonly, rimozione disabilitata con title "Riga
    bloccata dal preventivo collegato"), catalogo (alert + tile/bottom bar
    disabilitati, "Catalogo bloccato: ..."), coupon/promozioni ("Con un
    preventivo collegato coupon e promozioni non sono applicabili."), sconti e
    cliente; banner legacy "Preventivo #N • Cliente: X caricato in Pagamenti."
    + "Torna al preventivo".
FALSI GAP confermati dormienti ANCHE nel legacy (nessuna azione): omaggi v2
(client_gifts_v2, $giftsV2Enabled=false hardcoded; gift_instance_id mai letto
da POST), Buono new_coupon_* (hidden non renderizzati), pos_action
issue_giftbox/issue_giftcard/create_recharge/sell_package (handler standalone
mai invocati dalla UI), mode=client_credit (mai chiamato dal JS),
pkSyncExpiryHint duplicata. DIVERGENZA DATI (non codice): il confronto live
cliente 9 differisce tra MySQL e Supabase per drift di dati di test (la query
e la semantica credito clients.credit_balance sono identiche).
RESIDUI DELIBERATI: coupon+promo AUTO non cumulati (M1 approvato; il legacy
tenta lo stacking coupon_eval_after_promotion), pacchetti come contenuto
GiftBox (in_giftbox) non portati (la GiftBox Next avvolge servizi/prodotti),
lock credito "informativo" del modale Residui (hint legacy 3062-3063) non
mostrato.
Verifica: batteria audit2 14/14 (scelta obbligatoria verbatim, catalog_promos
-20% con prezzo/percent/nome, auto_only esclude promo su codice, punti azzerati
con promo non cumulabile + sconto promo applicato, note legacy Promozione/
Sconto manuale/Tipo pagamento, preview ricarica) + regressione batteria piano
rate 16/16 + 18/18 marker bundle nuovi + typecheck.

## Pagamenti — pos_success come PAGINA DEDICATA (2026-07-04, su segnalazione utente)

Il legacy al Concludi REINDIRIZZA a index.php?page=pos_success&id=N (pagina
dedicata "Vendita completata"); il Next mostrava invece uno scontrino in
OVERLAY dentro la cassa con "Stampa scontrino" — flusso inventato (la
divergenza "pos_success inlined" era documentata; l'utente l'ha rifiutata).

1. NUOVA PAGINA /{slug}/pos_success?id=N (pos_success-content.tsx +
   getManagePosSuccess + GET action=sale_success), port 1:1 di pos_success.php:
   header "Vendita completata" / kicker "Pagamenti" / "ID vendita #N - data"
   con azioni contestuali (Nuova vendita, Apri in Movimenti, Apri Pacchetto
   (n), Apri GiftCard (n), Apri GiftBox, Ricariche cliente, Stampa
   window.print — il bottone Stampa QUI esiste anche nel legacy, righe
   705/742); alert flash "Operazione completata con successo. / Vendita
   registrata (ID N) • GiftBox emessa (code) • GiftCard emessa (codes) •
   Email programmata per .../Email destinatario: ..." solo arrivando dalla
   cassa (?flash=1, l'equivalente del flash di sessione legacy); Riepilogo
   articoli (badge stato riga, sub "tipo • ID n", "Nessun dettaglio righe
   disponibile.") + Note ripulite dalle righe tecniche; Totali con breakdown
   ("Sconti", "Buoni / promozioni / sconti"/"Altri sconti / promozioni",
   dettagli Promozione/Coupon/Sconto manuale, "Punti Fidelity (n)", "GiftCard
   utilizzata (code)", "Credito utilizzato", blocco Fidelity Punti usati/
   guadagnati con i punti delle ricariche sommati da transactions); card
   Cliente (nome/ID/Email/Telefono/Apri scheda cliente); stato "Vendita non
   trovata" con "Non riesco a caricare i dettagli della vendita." + Torna a
   Pagamenti/Apri Movimenti; pos_success.css legacy. Tutti i dati ricostruiti
   dal DB per sale_id (voucher dai nomi riga GC-/GBX-, pacchetti da CP#n,
   ricariche da R#n nelle note — gli stessi fallback del legacy).
2. CASSA: al successo il Concludi REINDIRIZZA a pos_success?id=N&flash=1
   (redirect legacy pos.php 5904). RIMOSSO l'overlay scontrino inventato
   (ReceiptData/lastSale/printReceipt/successMsg, ~300 righe).
3. DETTAGLIO VENDITA (Movimenti): rimosso il bottone "Stampa scontrino" +
   overlay ricevuta — pos_sale_detail.php NON ha alcuna funzione di stampa
   (verificato: nessun print/Stampa in pagina né in pos_sale_detail.js).
Verifica: battery pos_success 12/12 (dati pagina, breakdown Sconto manuale,
note ripulite, GiftCard emessa rilevata con id+code, vendita inesistente) +
regressioni 16/16 e 14/14 + 30/30 marker (inclusa l'ASSENZA di "Stampa
scontrino"/overlay nei bundle della cassa e del dettaglio) + typecheck.

## Fix flash errore SSR sulle pagine dettaglio (2026-07-04, su segnalazione utente)

Sintomo: aprendo pos_success/pos_sale_detail/client_detail si vedeva PRIMA lo
stato d'errore ("Vendita non valida." / "Cliente non valido.") e poi la pagina
corretta. Causa: l'HTML server-renderizzato (dove window non esiste) veniva
prodotto con id=0 -> ramo errore, visibile finché il client non si idrata e
rilegge l'URL. Fix:
1. pos_success + pos_sale_detail: id/flash letti SOLO dopo il mount (effect),
   loading=true iniziale -> l'SSR mostra "Caricamento…" (pattern già usato
   dagli altri dettagli).
2. client_detail: il ramo `if (!clientId)` ("Cliente non valido.") veniva
   PRIMA del ramo loading -> riordinato (loading first).
Verifica: scansione SSR su 14 pagine (dettagli POS/clienti/pacchetti/giftcard/
giftbox/preventivi/omaggi + liste): nessun testo d'errore nell'HTML iniziale.

## Lista appuntamenti — AUDIT COMPLETO legacy vs Next (2026-07-04)

Doppio inventario (agent su appointments.php 1211 righe + appointments.js 205
righe vs appointments-content/route/db-repositories) + cattura live del markup
PHP con sessione. GAP chiusi:

1. "INCASSA" RIMOSSO: non esiste in appointments.php (confermato: nessun
   collegamento alla cassa dalla lista) — le azioni riga legacy sono SOLO
   Modifica (drawer quick-booking via data-qb-edit) ed Elimina.
2. ELIMINAZIONE SOLO PER ANNULLATI (deleteLocked legacy): il bottone Elimina
   per riga appare solo con stato Annullato; le checkbox delle altre righe
   sono disabled col title verbatim "La prenotazione deve essere in stato
   Annullato. Annullala prima per poterla eliminare."; il seleziona-tutti
   opera solo sulle selezionabili. La guardia server già esisteva.
3. DATA "dd/mm/yyyy HH:MM → HH:MM" (fine solo ora) sulla riga padre; righe
   figlie multi-servizio "↳ HH:MM → HH:MM" (orari per segmento ora esposti da
   appointmentServiceLines: starts/ends/staff del segmento).
4. CODICE PRENOTAZIONE: <code>#CODICE</code> non cliccabile, "—" quando
   assente (prima: codice senza # o fallback #id).
5. STATI VERBATIM legacy: In attesa / Prenotato / Eseguito / Annullato /
   No show (+ --other per stati sconosciuti) mappati da statusCode — prima la
   lista mostrava le etichette uiStatus "Confermato"/"Completato".
6. MULTI-SERVIZIO legacy: riga padre "Multi-servizio (N)" + badge arancione
   "Multi-servizio" + elenco servizi small + pallini colore operatori (max 6)
   + nomi; figli con orario segmento, operatore (pallino+nome), badge stato,
   riordino Sposta prima/Sposta dopo e toast "Ordine multi-servizio
   aggiornato." (prima: toggle "N servizi" e prezzo nella colonna Operatore).
7. RIEPILOGHI "Pacchetto: X"/"Pacchetti: X, Y" e "Prepagato" sotto il servizio
   (small text-primary con icone) + PALLINO COLORE operatore: nuova
   appointmentListDecorations (appointment_package_items/client_packages,
   appointment_prepaid_service_items, appointment_staff/staff.calendar_color)
   agganciata a GET action=list.
8. ESITI ELIMINAZIONE come alert in testa (View::alert legacy): "Appuntamento
   eliminato", "1 appuntamento eliminato."/"N appuntamenti eliminati.",
   "N prenotazioni non annullate non eliminate: annullale prima.",
   "N prenotazioni non eliminate perche non disponibili nella sede corrente.",
   "Nessuna prenotazione eliminata." — la route bulk_delete ora ritorna i
   contatori blockedNotCanceled/blockedUnavailable. Conferma bulk col testo
   FISSO legacy "Eliminare gli appuntamenti selezionati?" (prima "Eliminare N
   appuntamenti selezionati?").
9. STATI VUOTI legacy: card globale "Nessuna prenotazione presente" (icona
   calendar-plus, testo verbatim, bottoni "Nuova prenotazione" data-qb-new e
   "Apri calendario") quando non esistono prenotazioni in sede — il bottone
   header "Calendario" appare solo quando la lista non è globalmente vuota;
   vuoto filtro: "Nessun appuntamento nel periodo." (prima "Nessun
   appuntamento.").
10. DEEP-LINK legacy: ?created=<id,id> forza l'inclusione fuori range (cap
    300); ?action=edit&id= / ?action=new aprono il drawer quick-booking
    (openEditId/openNew di appointmentsPageConfig, via click sintetico sui
    delegati data-qb-edit/data-qb-new del drawer globale).
PARITÀ CONFERMATE (nessuna azione): header/kicker/subtitle, filtri Dal/Al/
Cerca con default mese corrente e placeholder verbatim, Filtra/Reset,
"N selezionati", conferma singola "Eliminare questo appuntamento?", nessuna
paginazione (ordinamento starts_at ASC), CSS identico. RESIDUO DELIBERATO:
filtri applicati client-side sulla lista fetchata (stesso risultato del GET
server legacy; ricerca su cliente+codice come il LIKE legacy).
Verifica: battery 13/13 (statusCode/endTime/publicCode/decorazioni in list,
guardia verbatim su delete non-annullato, bulk misto deleted=1+blocked=1,
delete su annullato ok, cleanup CLEAN) + 27/27 marker bundle (inclusa
l'ASSENZA del vecchio "Incassa") + typecheck.

## Pianifica (appointments_plan) — AUDIT COMPLETO legacy vs Next (2026-07-04)

Doppio inventario agent (appointments_plan.php 2383 righe + appointments_plan.js
789 righe vs appointments_plan-content/manage-planner/route) + cattura live del
markup PHP + WORKFLOW di verifica adversariale sui gap incerti (5/5 confermati
+ 2 deep-dive cabine). GAP chiusi:

1. REDIRECT POST-CREAZIONE legacy (2013-2023): il "Crea appuntamenti" ora
   REINDIRIZZA alla Lista appuntamenti con ?from=<min-1g>&to=<max+1g>&
   created=<id,id>&msg="Pianificazione completata: creati N appuntamenti"
   (rimosso l'alert inline non-legacy); la lista legge ?msg/?err/?from/?to/?q
   dall'URL (alert + filtri seedati come il GET legacy).
2. CABINE NEL PLANNER (erano del tutto assenti nella UI Next): select "Cabina"
   per servizio GATED fino all'Anteprima ("(Premi Anteprima)"), poi cabine
   LIBERE sullo slot di riferimento (prima riga OK, per-segmento come il legacy
   1906-1950): 0 -> "Nessuna cabina" disabled, 1 -> auto-selezionata disabled,
   >1 -> select senza "(Auto)" (scelta precedente mantenuta se ancora libera,
   altrimenti la prima); cabin_map inviata a preview/create; planPreview
   ritorna cabinsEnabled + cabinAvail (riuso cabinsForServicesContext);
   validazioni server verbatim "Nessuna cabina disponibile per il servizio: X"
   / "Seleziona una cabina valida per il servizio: X" + auto-assegnazione con
   una sola consentita (legacy 1698-1723). Il create scrive cabin_id sui
   segmenti (resolvePlanCabins già esistente).
3. VALIDAZIONI SERVER mancanti (verdetti workflow CONFERMATI): finestra vs
   durata '"Alle ore" deve essere >= "Dalle ore" + durata servizi.' (legacy
   1644-1651, con precedenza legacy servizi->finestra->operatori); servizi
   fuori sede "Servizio non disponibile nella sede corrente." (legacy
   1613-1621, semantica service_locations); cliente BLOCCATO in preview E
   create (guardia riusata assertClientNotBlockedForSave, legacy 1609-1611);
   "Impossibile creare il nuovo cliente." (legacy 1603).
4. REASON VERBATIM: "Nessuno slot disponibile nella finestra scelta" (era
   "nella fascia oraria").
5. DINAMICHE CLIENT legacy (appointments_plan.js): auto-calcolo "Alle ore" =
   "Dalle ore" + durata servizi (min + clamp 23:59, valori inferiori bloccati);
   "Dal giorno" ancorato al primo giorno selezionato (Lun→Dom) alla prossima
   occorrenza dopo oggi, mai retroattivo (min oggi); default time_to 09:00.
6. SELECT OPERATORE stati legacy: 0 eligibili -> "Nessun operatore" disabled;
   1 -> auto-assegnato select disabled col nome; >1 -> placeholder
   "(seleziona)" (era "Seleziona operatore…"); name legacy staff_map[id].
7. MODAL TROVA CLIENTE: righe legacy "Email: x"/"Telefono: y" ("—" se vuoti),
   nome text-primary, stato vuoto "Nessun risultato.".
PARITÀ CONFERMATE (nessuna azione): header/kicker/subtitle/azioni Lista+
Calendario, form Impostazioni completo (Cliente Nuovo/Trova/annulla, multiselect
servizi con gruppi e "• N min", Ripeti per 1-200, giorni Lun.-Dom., ricorrenza
weekly/2/3/monthly, testi help verbatim), anteprima (badge durata/prezzo,
Servizi selezionati:, tabella Data/Ora/Operatore/Esito con OK/Saltato),
generazione date (ancoraggio lunedì, monthly 1 data/ciclo, non retroattivo,
clamp repeat 200), niente reminders alla creazione (ANCHE il legacy non li
crea), nuovo cliente creato solo allo step create, public_code 5 cifre.
RESIDUI DELIBERATI: slot finder = primo slot disponibile nella finestra via
publicBookingSlots+guard (il DFS permutazioni legacy non è portato — semantica
documentata nel modulo); reason "Risorsa non disponibile/esaurita" del legacy
non distinta (lo slot con risorse esaurite è comunque scartato, etichettato
"Operatore occupato"); probe cabinsEnabled via cabins_for_services al primo
servizio selezionato (il legacy lo server-renderizza nel config).
Verifica: battery 14/14 (preview con cabinAvail nominato, finestra corta
verbatim, cliente bloccato, fuori orario -> reason verbatim, create con
public_code 5 cifre + segmenti con cabina auto e staff, details con
appointmentId per ?created=, cleanup CLEAN) + 18/18 marker bundle + typecheck.

## Calendario — audit di parità 2 (2026-07-04)
Metodo: doppio inventario agent (legacy calendar.js 5204 righe + api_appointments
move/list; port Next 3888 righe) + cattura live PHP (php-calendar.html 88KB).
GAP CHIUSI:
1. TEMA SOFT PER STATO sui blocchi (Day/Week/Month): port verbatim di
   calendarAppointmentStatusTheme + applyCalendarSoftAppointmentStyle — palette
   pending #fff7ed/#f59e0b, scheduled #eff6ff/#4e6da5, done #ecfdf5/#22c55e,
   canceled #f1f5f9/#64748b, no_show #f9fafb/#374151, rejected #fdf2f8/#ec4899,
   fallback other #f8fafc — classi appt-soft-<key> + CSS var --appt-soft-* (le
   regole !important erano GIÀ in app.css ma il componente non le alimentava:
   i blocchi avevano sfondo fisso #f4f8ff e barra col colore OPERATORE invece
   dell'accento di STATO; il colore operatore resta solo sul pallino).
2. MOVE PARITY COMPLETA (rotta+repo riscritti su api_appointments.php 9092-9380,
   nuova moveDbAppointmentCalendar): contratto legacy starts_at/ends_at (durata
   trascinata persistita AS IS — prima updateDbAppointment RICALCOLAVA la durata
   dal servizio, perdendo i resize custom), staff_id numerico (upsert/clear
   appointment_staff + sync segmento singolo; sentinel 0 per lo schema NOT NULL),
   segment_id+old_starts_at/old_ends_at -> DELTA-SHIFT dell'intera prenotazione
   (prima il drag di un segmento non-primo TELETRASPORTAVA l'appuntamento sul
   suo orario); guardie che PRIMA MANCAVANO DEL TUTTO sul move: time-off
   "Impossibile spostare: <nome> risulta non disponibile (<motivo>) nel periodo
   selezionato.", conflitti "Conflitto: l'operatore ha già un altro appuntamento
   in quell'orario." / "Conflitto: uno degli operatori ha già...", risorse
   condivise (sharedResourcesContext), operatore-abilitato, cabine ri-risolte
   (corrente -> appuntamento -> auto) per segmento e singole; errori 'Non
   trovato' (era "Appuntamento non trovato.") a 200 {ok:false} come j() PHP.
3. AZIONE RESIZE RIMOSSA (il legacy NON ce l'ha: eventResize POSTA action=move
   con stesso inizio e nuova fine) — resizeDbAppointmentEnd eliminata; il client
   ora fa resize via move; maniglia resize NASCOSTA sui blocchi-segmento
   (durationEditable:false legacy) + guardia alert verbatim "Ridimensionamento
   non supportato per prenotazioni multi-servizio (segmentate)."; guardia
   client-side cross-colonna sui segmenti "Per cambiare operatore su
   prenotazioni multi-servizio, modifica l'appuntamento (non tramite drag &
   drop)." (alert PRIMA della richiesta, come calendar.js 4961).
4. ERRORI MOVE/RESIZE via window.alert(resp.error || 'Impossibile spostare' /
   'Impossibile ridimensionare') + revert — rimosso l'alert inline inventato.
5. EVENTI PER SEGMENTO: soglia legacy HAVING COUNT(*)>1 sui SEGMENTI (prima il
   Next espandeva solo con >1 OPERATORE: un 2-servizi mono-operatore mostrava
   UN blocco solo) — appointmentSegmentsForCalendar ora restituisce segments[]
   (con segmentId per il contratto move) per ogni prenotazione segmentata;
   espansione anche in Week e Month.
6. HOVER TIME INDICATOR: label HH:MM INLINE nel chunk centrale toolbar
   (calendar-hover-time-display--inline — prima flottante accanto al cursore,
   variante che il legacy usa solo senza toolbar), linea guida a TUTTA
   LARGHEZZA su tutte le colonne (come la line appesa a .fc-timegrid-cols),
   semantica riga-floor (la riga 5' sotto il cursore, non il round).
7. MESE: nav ±1 MESE di calendario (era ±30 giorni fissi); chip = CARD complete
   legacy (riga orario, pallino+badge+MS+cliente, "• operatore", "• servizio",
   tema soft) e TUTTI i chip (il legacy non ha dayMaxEvents: rimosso il cap 4 +
   "+N altri"); chip trascinabili su un'altra cella (cambio DATA, orario
   conservato; segmenti delta-shift); click su giorno vuoto -> quick-book
   prefillato 00:00 + operatore del filtro (port della select FullCalendar in
   dayGridMonth — prima saltava alla vista Giorno, comportamento inventato);
   celle chiusura con classe store-closure-date (dayCellClassNames) salvo
   apertura straordinaria.
8. NOTE: validazioni SEPARATE 'Seleziona un giorno valido.' / 'Scrivi il testo
   della nota.' (era un messaggio unico inventato); esiti success 'Nota salvata
   con successo.' + variante lunga fuori-periodo verbatim (senza accenti: "e
   fuori", "mostrera") e 'Nota eliminata.'; fallback errori per azione 'Errore
   nel salvataggio.' / 'Errore in eliminazione.' (era "Operazione non
   riuscita."); dopo il salvataggio la nota resta caricata nel form (come
   fillCalendarNoteForm); empty state "Nessuna nota PER il giorno selezionato"
   (era "nel").
9. Week: click/drag-select su cella vuota prefilla l'operatore del FILTRO
   (legacy staffId = currentStaff), non "nessuno".
RESIDUI DELIBERATI: filtro sede resta hidden non wired (parità col legacy
mono-sessione); la variante staff-allowed del move non applica il filtro sede
legacy ('Operatore non disponibile nella sede selezionata.') — tenant mono-sede,
stessa semplificazione del save; hold advisory day-lock del PHP non portato;
tema rejected irraggiungibile finché phpStatus collassa rejected->canceled (port
verbatim comunque); appointment_segments.staff_id usa sentinel 0 (schema NOT
NULL) dove il PHP scrive NULL.
Verifica: battery 33/33 (move as-is + sync segmento/cabina, resize via move con
durata custom preservata anche al move successivo, Dati mancanti/Data-ora non
valida/Non trovato/non modificabile verbatim, conflitto singolo+multi verbatim,
time-off col nome operatore, clear/riassegna operatore, segments[] con soglia
>1 segmento mono-operatore + segmentId, delta-shift dal secondo segmento,
fallback delta senza segment_id, staff_id ignorato sul multi, cleanup CLEAN) +
48/48 marker bundle (palette soft completa, alert verbatim, note, chiusure,
hover inline) + typecheck pulito (lint: soli rilievi preesistenti a HEAD).

## Quick booking — audit di parità, PASSATA 1 (2026-07-04)
Metodo: doppio inventario agent (legacy View.php 1019-1974 + app.js SERVITO da
public/ 11462 righe + api_appointments/api_clients; port Next quick-booking-
drawer.tsx 5539 righe) + estrazione live del drawer (php-qb-drawer.html 18KB) +
payload action=get live (php-qb-get.json).
NOTA CHIAVE: esistono DUE copie divergenti di app.js; fa fede quella SERVITA
(public/assets/js/app.js). In quella build il countdown hold è "tecnico
invisibile" (solo auto-renew) e le radio Cb/scelta-sconto sono INERTI (id non
presenti nel markup) → i TODO Next "countdown non wired" e "fidelity choice non
portata" sono in realtà GIÀ PARITÀ.
GAP CHIUSI (passata 1):
1. ESITI VIA TOAST (window.notify) + NIENTE RELOAD: il legacy dopo save/delete/
   annullo NON ricarica la pagina — chiude il drawer, toast success
   ("Appuntamento salvato"/"Appuntamento eliminato"/"Prenotazione annullata"/
   "Prenotazione marcata No show"/"Cliente creato"), warnings[] come toast
   warning, e refetch del SOLO calendario. Port: qbNotify + evento
   qb:appointments-changed ascoltato da calendar-content (loadContext in place).
   Prima: window.location.reload() che uccideva ogni feedback.
2. ROUTING ANNULLAMENTO PRIMA DEL SAVE (app.js:11340): la richiesta canceled/
   no_show da pending/scheduled/done apre il popup dedicato SENZA salvare gli
   altri campi (prima: save + transizione dopo, e messaggio inventato
   "Annullamento non confermato..."). Popup chiuso = nessuna azione.
3. VALIDAZIONI SUBMIT legacy: toast warning "Seleziona o crea un cliente" /
   "Inserisci data e orario" (senza punto), lock "La prenotazione annullata non
   è modificabile." warning; il check servizi è SOLO server. Errori save =
   toast danger (fallback "Errore salvataggio" senza punto); recovery hold
   scaduto SOLO con hold attivo → pulizia token/orari/cabina + IL MESSAGGIO DEL
   SERVER come toast warning (prima: testo inventato "Disponibilità scaduta...").
4. DELETE legacy: guardia client-side stato Annullato (toast verbatim), confirm
   "Eliminare questo appuntamento?" (era testo inventato), esiti toast, niente
   reload.
5. BOTTONE SUBMIT edit: "Modifica prenotazione" (app.js:5562; era "Salva
   modifiche"); i testi locked "Prenotazione annullata"/"Prenotazione No show"
   ora keyed sullo stato TERMINALE caricato (app.js:5084), non sulla select.
6. TROVA CLIENTE: righe risultato legacy "Email: x"/"Telefono: y" con "—"
   (era "email • phone"), vuoto "Nessun risultato." (era "Nessun cliente
   trovato."); confermata parità exclude_blocked (listDbClients nasconde i
   bloccati — test live con cliente ZZ bloccato).
7. OPERATORE: placeholder singolo "(qualsiasi)" (era "Operatore automatico");
   cambio operatore in CREATE (singolo e per-servizio) invalida lo slot come il
   legacy: azzera orari + release hold + toast "Hai cambiato operatore:
   seleziona di nuovo una disponibilità" (solo se c'era uno slot e il cambio è
   tra due operatori pieni, app.js:8806-8817).
8. FIDELITY hint verbatim (app.js:7504-7511): "Max utilizzabili: N Punti
   (- € X). Minimo: N Punti." (era formato inventato "1 punto = ... • Usabili").
9. PRE-CHECK "Disponibilità" come toast warning (eran alert inline).
10. Pill servizi: toast rimozione "Servizio rimosso dalla prenotazione: X";
    "Cliente creato" success dopo create-quick; loading NEW "Preparo nuova
    prenotazione..." (app.js:9910) durante il primo caricamento master data.
PARITÀ CONFERMATE (nessuna azione): markup drawer 1:1 (verificato sul live:
header/kicker/codice, multiselect pills+search+gruppi, gating data/disponibilità,
cabina hint, stato/note, Dettaglio prezzi con Coupon/Sconto/GiftCard/Credito/
Punti Fidelity/Totale, Crea prenotazione/Elimina appuntamento); modale
Disponibilità (Orari disponibili, viste Giorno/Settimana/Mese default week,
tooltip stati slot); hold TTL 300s + renew 60s/retry 30s + release keepalive;
coupon (messaggi identici); promo auto senza riga dedicata (prezzi barrati +
badge); popup annullamento eseguito (preview/blockers/motivazione 255);
permessi; storico/residui box con "Apri scheda".
RESIDUI DA CHIUDERE (PASSATA 2 — NON deliberati):
A. REDEEM IN EDIT: il get legacy restituisce giftbox/package/prepaid/gift/
   giftcard_redeem esistenti e il drawer li prefilla (pills collegate, righe
   "Incluso nel pacchetto..."); il save in edit li ri-applica/aggiorna. Nel Next
   getDbAppointmentForEdit non li restituisce e updateDbAppointment li IGNORA
   (TODO(redeem-on-edit)).
B. SELEZIONE REDEEM NELLA MODALE RESIDUI: nel legacy i controlli interattivi
   (credito toggle+importo+Usa max, GiftCard select+importo+applica/rimuovi con
   toast "GiftCard applicata alla prenotazione."/"GiftCard rimossa...", check
   servizi da GiftBox/Pacchetti/Omaggi/Prepagati che AGGIUNGONO il servizio
   alla prenotazione con toast "Servizi aggiunti alla prenotazione: ..."/
   "Seduta pacchetto collegata: ..." ecc. + qb_residui_check) vivono DENTRO
   #qbClientResidualsModal; il form NON ha i box inline che il Next ha
   inventato (il markup live del drawer ha solo gli hidden input).
C. staff_for_service: stati select con verifica server ("Verifico operatori
   disponibili...", opzioni occupate disabilitate "nome — Occupato" in edit,
   fallback "Operatore assegnato (ID n)"); il Next filtra client-side senza
   disponibilità.
D. minori: credit_use_from_booking sempre 0; allocazione staff/cabina dall'hold
   non consumata (equivalente di fatto: l'effect cabins_for_services riseleziona
   la cabina libera dopo lo slot).
Verifica passata 1: 24/24 marker bundle + test live search bloccati (cleanup
CLEAN) + typecheck pulito.

## Quick booking — PASSATA 2A+2C (2026-07-04)
A. REDEEM IN EDIT — CHIUSO (era il TODO(redeem-on-edit)):
   • getDbAppointmentForEdit ora restituisce i redeem collegati (packageRedeem/
     prepaidServiceRedeem/giftboxRedeem/giftRedeem/giftcardRedeem, forme identiche
     a quelle che il drawer serializza al save — la linkage vive su
     appointment_services.{client_package_id,client_package_service_id,
     client_prepaid_service_id,giftbox_instance_id+giftbox_item_id,
     gift_instance_id+reward_item_index} + appointments.giftcard_id/giftcard_used)
     e un redeemBoost con le istanze consumate da QUESTA prenotazione (nome/
     etichetta; giftcard con balance = saldo attuale + quota usata) che il drawer
     fonde nelle liste residui del cliente (le liste correnti non elencano più le
     unità già scalate).
   • Il drawer prefilla le selezioni per-servizio + la GiftCard (pick + importo)
     in openEditAppointment; il booster viene fuso sia subito sia quando arriva
     il contesto cliente (qbMergeBoost, dedup per chiave), disarmato al reset.
   • updateDbAppointment su prenotazione VIVA (pending/scheduled): PRIMA degli
     insert chiama restoreAppointmentRedeems in modalità redeemLinksOnly (nuova
     opzione: ridà le unità ai pool e rimborsa la GiftCard SENZA toccare credito
     né fidelity), poi ri-applica i redeem del payload con la stessa catena/
     dedupe del create (pacchetto->prepagato->giftbox->omaggio->giftcard) e i
     warning best-effort nel response. Un re-save con gli stessi redeem è NEUTRO;
     togliere un redeem in edit RESTITUISCE l'unità; su DONE i redeem sono
     settled e non vengono riprocessati. NB: questo chiude anche un LEAK dati:
     prima l'edit re-inseriva appointment_services SENZA linkage, rendendo le
     unità consumate non più ripristinabili da delete/annullo.
   Battery 28/28: create con pacchetto (2->1 + linkage), get prefill+boost, edit
   neutro (resta 1, linkage intatto), edit senza redeem (torna 2, linkage NULL),
   ri-aggiunta (1), ciclo giftcard 10->5->0 (saldo 40/45/50, used 10/5/0, boost
   balance 50 = 40+10), guard done (sessioni invariate). Nota schema: la
   ownership giftcard fa fede su recipient_client_id quando la colonna esiste.
C. STAFF_FOR_SERVICE — CHIUSO: nuova action GET staff_for_service (port di
   api_appointments.php ~5909 via staffForServiceManage): eleggibili = staff
   attivi no-SSO filtrati dall'allow-list staff_services (vuota = tutti); con
   finestra (l'EDIT passa date/start/end/exclude_id) ogni operatore è marcato
   available/unavailable_reason (time-off verbatim es. "Ferie", altrimenti
   "Occupato"). La select SINGOLA del drawer ora carica gli eleggibili dal
   server con gli stati legacy: "Verifico operatori disponibili..." durante il
   fetch, "Nessun operatore disponibile" + hint "Nessun operatore disponibile
   per il servizio selezionato." a 0, auto-selezione+disabled con 1, opzioni
   occupate disabilitate "nome — motivo", fallback errore "Impossibile caricare
   operatori" + hint "Impossibile caricare gli operatori disponibili.", opzione
   "Operatore assegnato (ID n)" per lo staff salvato fuori lista. Battery 6/6
   (eleggibile, timeoff 'Ferie', conflitto 'Occupato', exclude_id) + 5/6 marker
   (" — Occupato" composito è concat compile-time, literal presente).
RESTA (passata 2B, NON deliberato): selezione redeem DENTRO la modale Residui
(credito toggle/importo/Usa max, GiftCard applica/rimuovi con toast, spunte
GiftBox/Pacchetti/Omaggi/Prepagati che AGGIUNGONO il servizio) al posto dei box
inline inventati; picker multi-servizio ancora con eleggibilità client-side
(manca staff_for_services multi).

## Quick booking — PASSATA 2B (2026-07-04): MODALE RESIDUI INTERATTIVA
Chiusa l'ultima divergenza del drawer (spec estratta dal JS legacy con agent
dedicato: qbRenderClientResiduals app.js:983-1350 + handler change 2845-3236 +
credito 4294-4336/9068-9100 + giftcard 2348-2422 + qb_residui_check 5879-5906):
1. RIMOSSI i 5 box redeem INLINE inventati dal form (Pacchetti/Prepagati/
   GiftBox/Omaggi/GiftCard) e il box Credito inline: come nel legacy il form ha
   SOLO gli hidden input; verifica negativa sul bundle (i 5 testi descrittivi
   inventati sono ASSENTI). Restano le pill collegate (badge + dettagli) e le
   righe riepilogo Coupon/GiftCard/Credito/Fidelity/Totale.
2. La modale #qbClientResidualsModal è ora INTERATTIVA con l'ordine legacy:
   riga "Cliente: <nome>", empty state "Nessun residuo disponibile per il
   cliente selezionato.", card CREDITO (toggle "Disponibile: €", "Importo da
   usare" con clamp [0, min(saldo, dovuto)], "Usa max", hint "Saldo tessera: € X
   • Max utilizzabile: € Y[ • Aggiungi prima i servizi per usare il credito.]" /
   "Credito non disponibile."), poi Servizi → Omaggi → GiftBox → GiftCard →
   Pacchetti con gli hint verbatim "Seleziona o deseleziona i servizi
   acquistati/omaggio/…: verranno aggiunti o rimossi automaticamente dalla
   prenotazione.", badge residuo/N, "Acquistato[ con vendita #n] • Scade:",
   "Servizi residui:"/"Sedute residue:", vuoti "Nessun servizio residuo
   selezionabile."/"Nessuna seduta residua selezionabile.".
3. SPUNTE = COLLEGAMENTO (port dell'handler change): il check verifica i
   conflitti (nuova action qb_residui_check), AGGIUNGE il servizio al
   multiselect (o warning verbatim "Il servizio non è disponibile nel listino e
   non può essere aggiunto: X"), scrive la mappa redeem del tipo garantendo UN
   residuo per servizio, e notifica "Seduta pacchetto collegata/Servizio
   aggiunto dal pacchetto: X" (e varianti prepagato/GiftBox/omaggio a seconda
   che il servizio fosse già in prenotazione); l'uncheck rimuove servizio+mappe
   con "Servizio rimosso dalla prenotazione: X". Lock del checkbox durante la
   verifica; errori "Errore durante la verifica dei/degli …" come toast danger.
4. GIFTCARD single-select con radio ("Saldo non disponibile" se 0), "Importo da
   usare" precompilato al max, "Usa max", "Applica" con le guardie verbatim
   ("Seleziona una GiftCard.", "Non c'è importo da applicare: il totale
   prenotazione è 0. Aggiungi prima i servizi.", "Inserisci un importo
   valido."), toast "GiftCard applicata alla prenotazione."; "Rimuovi GiftCard
   applicata" -> "GiftCard rimossa dalla prenotazione.". Stato sincronizzato con
   la riga GiftCard del form (stessi stati giftcardPick/importo).
5. Nuova action POST qb_residui_check (qbResiduiConflictsLite, port LITE del
   collector legacy): omaggi con regola stretta (stessa reward su altra
   prenotazione ATTIVA pending/scheduled -> blocco, con exclude dell'appuntamento
   corrente in edit), pacchetti/prepagati bloccati a pool esaurito (nei nostri
   flussi il consumo avviene al save, quindi il pool è già al netto delle
   prenotazioni attive), giftbox demandata all'apply del save. Messaggi default
   verbatim; i messaggi ricchi con refs ("disponibili solo N quantità libere; già
   presente nella prenotazione #…") NON portati (residuo documentato).
INCIDENTE RIENTRATO: un primo tentativo di rimozione dei setter orfani con
markers line-based ha corrotto il file (rimossa la prima riga "use client" per
CRLF); recuperato con git checkout del file e ri-applicazione completa con
script paren-balanced + sanity check. Lint finale = identico a HEAD (6 errori/2
warning preesistenti), typecheck pulito.
Verifica: battery qb_residui_check 8/8 (pacchetto ok/esaurito verbatim, omaggio
su prenotazione attiva + exclude in edit, cleanup CLEAN) + re-run redeem-edit
28/28 + 38/38 marker modale + 5/5 verifiche NEGATIVE (testi inline spariti).
Nota infra: DNS flaky del router sul pooler Supabase aggirato nei test con
connection string a IP diretto (ssl rejectUnauthorized:false).

## Pagamenti — AUDIT v4 (2026-07-04): Dettaglio vendita + area completa
Metodo: doppio inventario agent sull'INTERA area (nav legacy: Pagamenti/
Movimenti/Prepagati/Preordini/Impostazioni/Gestione Rate; NON esiste api_pos.php
— le azioni sono mode= dentro pos.php e do= nelle pagine) + catture live di
pos_history/pos_preorders/pos_prepaids/pos_settings/installments_manage/
pos_sale_detail(#27).
PARITÀ CONFERMATE (non-gap, verificati): niente Svuota carrello / prezzo libero
/ barcode / IVA / stampa / scorciatoie (solo Enter coupon) nel legacy; nessun
prefill cassa da cliente/appuntamento nel legacy (il ?appointment= Next resta
capability latente senza UI); il secondo form filtri di Movimenti in d-none è
NEL LEGACY (residuo anche là); Movimenti senza paginazione (cap + footer);
"Stock: N" anche a 0; riga "Acconto iniziale" con badge "Incassato in vendita"
nelle Rate; etichette riduzioni già verbatim (Buoni / promozioni / sconti ecc.).
GAP CHIUSI:
1. RIMOSSO il bottone "Annulla piano"/"(forza)" dalla Gestione Rate: INVENTATO
   (installments_manage.php ha solo Incassa/Riapri; il piano si annulla SOLO
   dall'annullo della vendita collegata). Verifica negativa sul bundle; l'action
   API cancel resta per l'annullo vendita.
2. DETTAGLIO VENDITA — struttura legacy completata:
   • page header con kicker Pagamenti, titolo, sottotitolo "Dettaglio della
     vendita selezionata dalla pagina X." e azione "Torna a Movimenti/Preordini/
     Prepagati" pilotata da ?back= (movimenti default);
   • meta header + "Pagamento: <label>" (derivato dal metodo base dei pagamenti:
     lo schema Next non ha sales.payment_type);
   • quick-link "Apri GiftBox/GiftCard/Pacchetto" (+" (N)" se >1) con gli href
     legacy (giftbox tab=instances edit_instance / giftcard edit / packages
     tab=clients client_view) — GC/GiftBox risaliti dalle righe vendita,
     pacchetti da client_packages.sale_id;
   • "Stato annullamento" con Stato badge + Operatore (nuovo cancelledByName);
   • card Note (notesClean in <pre>) che era nel payload ma NON renderizzata;
   • card Gestione Rate con link "Apri Gestione Rate" (?plan_id=);
   • riepilogo a 3 COLONNE legacy (Elemento/Qtà/Totale — via la colonna Prezzo).
3. MODALE ANNULLO verbatim: sezione "Vendita annullabile" con badge "N
   decisione/i richiesta/e"/"Nessuna decisione extra", "Questa operazione
   annullerà definitivamente la vendita.", "I progressi Fidelity collegati alla
   vendita verranno ricalcolati."; "Cosa viene annullato" (era "Verranno
   annullati / ripristinati:"); "Prodotti coinvolti: ..."; radio magazzino
   legacy "Ripristina quantita a magazzino"/"Annulla senza ripristinare il
   magazzino" con gli help verbatim; label "Motivazione" + placeholder
   "Es. errore operatore / cliente ha cambiato idea..." + "Campo obbligatorio,
   massimo 255 caratteri.".
4. MODALE ELIMINA verbatim: titolo "Elimina vendita annullata #N", "Conferma
   eliminazione definitiva", "Cosa viene eliminato" con le righe legacy
   ("Vendita annullata #N del <data>: verrà eliminata dai Movimenti.", "Righe
   vendita: ...", "Gestione Rate: verrà eliminato definitivamente il piano rate
   collegato (tipo • acconto € • residuo € • rate incassate: N).", avviso
   prenotazioni per storico), footer Chiudi/Elimina definitivamente.
5. CONFERME legacy prima dei POST (data-confirm): ritiro / rimozione ritiro
   (con accenti) ed esecuzione/annullo esecuzione manuale (senza accenti, come
   il PHP), + esiti verbatim: "Vendita annullata con successo.", "Ritiro
   parziale registrato (X su Y). Magazzino aggiornato." / "Prodotto segnato
   come ritirato. Magazzino aggiornato correttamente.", "Ritiro rimosso. Il
   prodotto è tornato in Preordini." (è).
6. ACCENTI server ripristinati dove il legacy li ha: "La motivazione è
   obbligatoria per annullare una vendita.", "Vendita già annullata.",
   "La vendita è annullata: il ritiro non può essere registrato." / "... non è
   possibile modificare il ritiro." (le guardie prepagati restano senza accenti
   come nel PHP).
RESIDUI DOCUMENTATI: suffissi esito legacy non portati ("... Commissioni
operatore annullate: N (totale € X)." — il checkout Next non registra movimenti
commissioni da stornare; " Piano rate collegato eliminato..." e conteggi
artefatti nel delete); righe delete "Artefatti creati dalla vendita/Commissioni/
Scelte magazzino: N" richiedono conteggi server non esposti; filtri Rate senza
bottoni Filtra/Reset (aggiornamento live equivalente); all_locations resta il
residuo di area documentato.
Verifica: battery 15/15 (paymentLabel Contanti, notesClean, quickPackageIds,
accenti è/già, cancelledByName, guardia ritiro su annullata verbatim,
delete_sale, cleanup CLEAN) + 32/32 marker + 2/2 negativi + typecheck; lint =
baseline (l'unico error set-state-in-effect preesistente).

## Pagamenti v4 — coda sotto-pagine (2026-07-04)
Diff su catture live di Preordini/Prepagati/Impostazioni (le tre pagine non
ancora diffate): PREORDINI e PREPAGATI già a parità (Vista con i valori/label
legacy Aperti/Pronti al ritiro/Stock insufficiente / parziale/Scaduti/Solo
ordinati/Solo pacchetti/Solo GiftBox/Tutti e Attivi/Già prenotati/Scaduti/
Esauriti/Annullati/Tutti; colonne, ricerca "Cliente, prodotto, SKU, vendita..."
/ "Servizio, vendita...", empty state verbatim, azione "Dettaglio vendita").
FIX: i VALORI ?back= dei link live sono INGLESI (back=preorders/prepaids) —
corretta la mappa del dettaglio vendita (le chiavi italiane non matchavano);
IMPOSTAZIONI: esiti verbatim legacy ("Impostazioni Pagamenti salvate.",
"1 preordine aggiornato."/"N preordini aggiornati.", "1 prepagato aggiornato."/
"N prepagati aggiornati." dal count della route, prefissi errore per azione
"Errore salvataggio impostazioni."/"Errore aggiornamento preordini/prepagati.").
Residuo minore: i link "Dettaglio vendita" legacy preservano anche i filtri
correnti nella query di ritorno (il Next torna alla pagina base).
Verifica: 16/18 marker (2 falsi negativi da template-concat "Torna a X",
componenti presenti come literal separati) + typecheck.

## RIMOSSA la vecchia app Tailwind di fallback (2026-07-04)
Segnalazione utente: /{slug}/giftbox_voucher?id=6&embed=1 mostrava il vecchio
"Gestionale Tenant" (prototipo Tailwind). Causa: il router rendeva
ManagementApp per (a) ogni pagina NON in FAITHFUL_MODULES e (b) ogni pagina
registrata con ?action= non special-cased (es. appointments?action=view aperto
in nuova scheda). Interventi:
1. VOUCHER variante MANAGE (?id=N[&embed=1] — i link "Voucher" di Movimenti e
   dei dettagli istanza): giftbox_voucher/giftcard_voucher/gift_voucher ora
   risolvono il token pubblico dall'istanza (nuovi helper
   giftboxVoucherTokenById/giftcardVoucherTokenById/giftVoucherTokenById sul
   backfill lazy ensureVoucherToken) e riusano lo stesso viewer fedele della
   variante pubblica, dietro login come il legacy.
2. Il gate dei moduli fedeli non esclude più ?action=: i moduli leggono
   l'action dall'URL client-side (appointments apre il drawer; un'action ignota
   rende la lista, come il legacy). Le action con pagina dedicata restano negli
   special-case.
3. Pagina sconosciuta -> 404 legacy (index.php ~517-521): card "Pagina non
   trovata" nel layout.
4. ELIMINATO components/management-app.tsx (7003 righe, importava solo lib
   condivise: nessun orfano) + legacyPageToSection.
Verifica live 7/7: pagina inesistente -> "Pagina non trovata" senza vecchia
app; giftbox_voucher?id=6&embed=1 -> viewer voucher; appointments?action=view
-> modulo fedele. Typecheck pulito.

## Gestione Rate (installments_manage) — audit dedicato (2026-07-04)
Diff diretto su cattura live (php-installments_manage.html) + sorgente
app/pages/installments_manage.php (496 righe) e SaleInstallments.php.
GIÀ A PARITÀ: KPI (Piani aperti/Rate scadute/Incassato/Residuo attivo su lista
FILTRATA, skip cancelled sul residuo), header actions (Movimenti sempre, Nuova
vendita se piani in scope), empty-state card, lista piani (celle Cliente+badge/
Vendita #id+data/Scadenza+importo/Residuo+N rate, "N risultati"), dettaglio
(KPI 8 voci, Note piano, alert "Piano annullato il ...", tabella Rata/Scadenza/
Importo/Stato/Incasso, riga pending Tipo/Importo readonly/Data/Incassa,
riga paid "€ X • tipo"+Riapri), flash "Rata registrata"/"Rata riaperta"/
"Operazione non completata.", label rata Pagata/Annullata/Scaduta/Da incassare
e piano Attivo/Scaduto/Completato/Annullato (server-side).
FIX PORTATI:
1. URL legacy: ?status/client_id/sale_id/due_from/due_to/plan_id ora inoltrati
   dal router come prop server-side (come $_GET del PHP; special-case in
   page.tsx) — il deep-link "Apri Gestione Rate" da pos_sale_detail (?plan_id)
   ora seleziona il piano; catena selezione legacy plan_id -> risultato unico
   -> sale_id (loadPlanBySaleId); whitelist status (invalido -> open); click
   riga aggiorna l'URL (replaceState) come i data-href legacy + aria-label
   "Apri piano rateale X" + classe js-plan-row.
2. Form filtri legacy: draft applicato SOLO con submit "Filtra" (btn
   outline-primary + bi-search, classi installments-filter-submit
   app-filter-submit) + "Reset" come anchor alla pagina base; RIMOSSO il campo
   "Cerca" libero (il legacy non ha q: il "Cerca…" sta DENTRO il combobox
   cliente); Filtra azzera plan_id/sale_id come il form GET legacy.
3. Combobox cliente .app-combobox (port di initCombobox): toggle
   outline-secondary con placeholder "Tutti", ricerca accent-insensitive,
   Enter=primo risultato, "Nessun risultato", item "Tutti"; la GET
   /api/manage/installments ora restituisce clients = lista clienti COMPLETA
   (ORDER BY full_name ASC, id ASC come la query legacy), non solo i clienti
   con piani.
4. Sottotitolo " Sede: X" (label sede corrente da /api/manage/locations,
   "Tutte" se scope globale).
5. Label pagamento display: paymentTypeLabel legacy con card="Carta di
   Credito" (il select resta "Carta") su KPI Pagamento, riga Acconto e riga
   paid "€ X • tipo" (separatore sempre presente); riga "Acconto iniziale"
   SEMPRE renderizzata (senza sottotesto inventato); select pending
   preseleziona tipo rata -> tipo piano -> cash.
6. Riga annullata: aggiunta la riga legacy "Incassata il <dt> • € X" sotto
   "Rata annullata" quando paid_at presente.
7. RIMOSSA invenzione input "Nota (facoltativa)" nel form incasso (il legacy
   non ce l'ha; note='' -> NULL come la lib legacy).
8. Route: RIMOSSA guardia inventata "Rata gia pagata." (il re-incasso legacy è
   idempotente e aggiorna paid_at/tipo); messaggi id invalido/rata mancante
   allineati a "Rata non trovata o non aggiornata."; empty-state "La gestione
   rate e ancora vuota." SENZA accento (verbatim legacy).
9. Annullo vendita: cancelled_reason del piano e cancel_note dei prepagati ora
   ricevono la NOTA STANDARD legacy ("Vendita #N annullata dall'operatore X.\n
   Motivo: r.", troncata 255) e ogni rata riceve in APPEND
   "[ANNULLATA <ts>] <nota standard>" conservando paid_at/paid_amount nello
   storico (SaleInstallments::cancelPlanBySaleId con allowPaid=true, come
   pos_history cancel_sale).
RESIDUI DELIBERATI: scoping per sede dei piani (all_locations checkbox se >1
sedi, location_id nei POST con guardia "Sede non autorizzata per questa
operazione.") non portato — l'API scopa per tenant (residuo già tracciato);
timestamp [ANNULLATA] in UTC (convenzione cancelNote esistente) vs ora locale
PHP.
Verifica: battery e2e 43/43 (piano da checkout rateizzato 12€/acconto 4/2 rate,
financed/count DB, GET filtri status/client_id/sale_id/due_from + clients
full-list, 4 guardie mark_paid verbatim senza accenti, incasso con nota NULL,
RE-incasso idempotente, Completato/riapertura/Attivo, annullo vendita ->
cancelled con nota standard + [ANNULLATA] + paid_at conservato, 2 guardie su
annullata, filtro cancelled/open, delete, cleanup CLEAN) + 49/49 marker bundle
(incluse negative: niente "Nota (facoltativa)", niente "Cerca" libero, niente
"è" nell'empty-state, niente "Annulla piano") + typecheck/lint puliti (warning
pre-esistenti invariati).

## Scadenziario e Costi (costs) — audit dedicato (2026-07-04)
Diff su costs.php (2829 righe: tab scadenziario+categories, POST save_cost/
save_category/bulk, GET delete/toggle/edit/export CSV+PDF), cost_attachment.php,
assets/js/pages/costs.js e i 3 moduli Next + /api/manage/costs + cost-attachment.
PROBLEMI GROSSI TROVATI E RISOLTI:
1. Le azioni riga "Segna pagato"/"Elimina" e i bottoni CSV/PDF erano ANCHOR a
   URL ?action=... che il router ignorava: NON FACEVANO NULLA. Ora: toggle/
   delete POSTano all'API con conferme e flash verbatim ("Stato aggiornato",
   "Costo eliminato", "Voci eliminate"; confirm "Eliminare definitivamente
   questa voce? Questa operazione non puo essere annullata."), CSV/PDF puntano
   all'export API reale.
2. EXPORT mancante: implementato action=export nella route — CSV fedele (BOM
   UTF-8, delimitatore ';', header Scadenza;Titolo;Sede;...;Ricorrente;Note,
   date d/m/Y, "Pagato il" d/m/Y H:i, Si/No, riga vuota + Totali/Scaduti/
   In scadenza/Pagati su colonne Residuo/Pagato, filename
   scadenziario_costi_<Ymd_His>.csv) e PDF via nuovo lib/cost-pdf.ts (pdfkit,
   port del layout MiniPdf: titolo, "Generato il", riga filtri
   "Periodo ... | Sede ... | Stato ...", tabella a colonne fisse con wrap
   legacy, sfondo rosa scaduti, re-header per pagina, blocco Totali).
3. Formattazione importi: toLocaleString('it-IT') NON raggruppa 1000-9999
   (CLDR minimumGroupingDigits=2) mentre number_format PHP dà "1.234,56" —
   fmtMoney manuale nei moduli costi, nel CSV e nel PDF. NB: gli ALTRI moduli
   fedeli usano ancora toLocaleString (residuo GLOBALE da campagna dedicata).
4. Tab categorie riscritta fedele: filtri legacy (Cerca per nome / combobox
   Categoria / Stato Tutte-Attive-Disattive + Filtra/Reset, filtro client-side
   come l'array_filter PHP), toolbar "N selezionato/i" + bulk "Disattiva
   selezionate"/"Elimina selezionate" (nuove action API
   bulk_deactivate_categories/bulk_delete_categories con guardie verbatim
   "Seleziona almeno una categoria" / "Una o piu categorie sono associate a N
   costi e non possono essere eliminate. ..."), badge stato custom
   .costs-category-status-badge is-active/is-inactive, azioni con conferme
   VERBATIM senza accenti ("Non sara piu selezionabile...", "Questa categoria
   non e associata ad alcun costo. Eliminazione definitiva. Continuare?",
   alert "...e non puo essere eliminata. Puoi disattivarla..."), bottone header
   "Nuova categoria" -> MODAL legacy (costCategoryCreateModal, ?action=cat_new
   lo apre) e pagina inline per ?action=cat_edit&id; PRIMA c'era un form inline
   sempre visibile + conferme inventate con nome categoria e accenti.
5. Scadenziario: combobox categoria .app-combobox (port initCombobox, "Cerca..."
   a TRE PUNTI, "Tutte", items con " (disattiva)"), bulk "Elimina selezionati"
   sempre visibile disabled (riga sopra tabella come il legacy, non nel toolbar
   Voci con count), modal "Riepilogo costo" riscritto fedele (modal-lg
   scrollable, row g-3 con TUTTI i campi a "-", Ricorrente Si/No, Note in box
   grigio, link allegato, SENZA footer — prima: dl centrato con campi
   condizionali, IVA e "Ogni N mesi — senza fine" inventati, footer
   Modifica/Chiudi), gate empty-state/bottone header su hasAnyCosts (COUNT in
   scope, prima usava la lista filtrata), query GET legacy come prop dal router
   (?from/to/status/cat/q con whitelist status) + replaceState su Filtra.
6. Form costo: header di pagina IDENTICO alla lista + tab nav (prima titolo
   pagina cambiato e bottone back inventato), label allegato verbatim "Carica
   documento (PDF o JPG, max 5MB)" + "Il file verrà salvato e compresso (JPG
   sempre, PDF best-effort)." + "Documento attuale: <link>", RIMOSSO il
   checkbox "Rimuovi allegato" (il legacy consente solo la sostituzione),
   select Sede visibile anche con UNA sede, preview "Residuo: €" live
   (paid_remaining_preview), "Pagato"+tracking riempie Già pagato col totale,
   wrap data fine ricorrenza NASCOSTO con "Mai" (non solo disabled), "Salva"
   fisso, validazioni client senza punto.
7. Lib manage-costs: TUTTI i messaggi allineati verbatim SENZA punto finale
   ("Titolo obbligatorio", "Totale non valido", "IVA non valida", "Importo gia
   pagato non valido", "Categoria disattivata: non puo essere usata su nuovi
   costi", "Fornitore disattivato per Scadenziario e Costi", "Costo non
   trovato", "Nessuna voce autorizzata da eliminare", ...; delete categoria
   linkata: "Categoria associata a N costi: non puo essere eliminata.
   Disattivala per non usarla nei nuovi costi."), parseMoney/parsePercent con
   le regex legacy (errori contestuali Totale/Importo gia pagato), mapCost
   senza default inventati ("Generale"/#0f766e -> vuoto, isPaid SOLO da
   is_paid), summary legacy (In scadenza ESCLUDE gli scaduti; Pagati somma il
   TOTALE), ricerca solo titolo+doc_number (prima anche fornitore), toggle
   pagato conserva paid_at preesistente (COALESCE), delete/bulk eliminano
   anche l'oggetto R2 dell'allegato, hasAnyCosts nel context.
RESIDUI DELIBERATI: compressione allegati server-side non portata (testo
verbatim mantenuto); allegati legacy /uploads non migrati rispondono con
messaggio dedicato; multi-sede (colonna Sede lista/CSV con >1 sedi e checkbox
"Tutte le sedi") non esercitabile sul tenant single-sede.
Verifica: battery e2e 52/52 (validazioni verbatim, parziali con residuo,
filtri+summary, toggle con generazione ricorrenza +1 mese e DEDUP su
ri-pagamento, export CSV con BOM/header/totali e PDF %PDF, delete/bulk costi e
categorie con guardie, cleanup CLEAN) + 82/82 marker bundle su lista+form+
categorie (incluse negative sulle invenzioni rimosse) + typecheck/lint puliti
(4 warning no-css-tags pre-esistenti).

## Commissioni (commissions) — audit dedicato (2026-07-05)
Diff su commissions.php (741 righe, tab overview+settings) + Commissions.php
(2890 righe: settings/moduleSettings/saveSettings/buildDashboard/
setEntryPaidStatus/cancel+deleteSaleCommissionMovements) vs i 2 moduli Next +
/api/manage/commissions + manage-commissions.ts (engine accrual già portato).
GIÀ A PARITÀ: header/badge stato modulo, tab, 3 empty-state (testi), alert
disattivata inline, card KPI (Base commissionabile/Commissioni calcolate con
Pagate/Da pagare/Annullate, Appuntamenti, Pagamenti), "Come funziona", warning
percentuali, Riepilogo per operatore (colonne+righe+Annullate N • €), dettaglio
Movimenti operatore (KPI 4 voci + tabella Data/Origine/Cliente/Voce/Riferimento/
Base/%/Commissione/Stato con badge+timestamp/Azione Pagato-Da pagare/Nota),
settings (switch Funzione Commissioni, card Configurazione, tabella operatori
con Attiva/Calcolo %/4 percentuali/Note, guardia "La commissione annullata non
può essere modificata.", engine POS prodotto/servizio + Appuntamento).
FIX PORTATI:
1. ANNULLO VENDITA: il legacy marca SUBITO gli snapshot commissione della
   vendita come 'cancelled' (Commissions::cancelSaleCommissionMovements con la
   nota standard) — il Next li lasciava 'active' fino al primo rebuild della
   dashboard (mai, a modulo spento). Ora cancelLinkedSaleResidues aggiorna
   entry_status/cancelled_at/cancelled_by/cancellation_reason/note.
2. DELETE DEFINITIVO vendita: eliminazione degli snapshot commissione
   (Commissions::deleteSaleCommissionMovements) dentro la transazione di
   deleteCancelledSale — prima restavano orfani.
3. Empty-state gate legacy: aggiunte le probe hasStoredHistory (COUNT snapshot
   nel periodo/filtri) e hasSourceInScope (appuntamenti done / vendite non
   annullate nel periodo) — prima il "Nessun movimento commissionabile
   presente" appariva anche con dati sorgente presenti; ora le 3 condizioni
   sono quelle di commissions.php ~250-253. Aggiunto il bottone "Nuova
   prenotazione" (data-qb-new, gated dal permesso Quick Booking via
   canQuickBook nella response).
4. Select Operatore: lista COMPLETA degli staff (staffOptions dalla dashboard,
   ordine legacy is_active DESC + filtro tecnico "SSO" normalizzato) — prima
   solo gli operatori con movimenti.
5. Filtri come il form GET legacy: draft applicato solo con "Aggiorna" (prima
   ogni change rifetchava), swap from>to, Reset come anchor alla pagina base,
   query iniziale da prop del router (?from/to/staff_id/source/detail_staff_id
   con la regola detail=staff se in conflitto) + replaceState su Aggiorna/
   Movimenti/Chiudi ("Movimenti" APRE senza toggle, come il link legacy).
6. Flash verbatim spostati sopra i tab (posizione View::alert): toggle ->
   "Commissione segnata come pagata"/"Commissione riportata da pagare";
   settings -> "Impostazioni commissioni salvate" e "Funzione Commissioni
   attivata"/"Funzione Commissioni disattivata" (prima flash inventati).
7. Settings: option del Calcolo % verbatim "Importo pagato"/"Prezzo di
   listino" (erano "Sul pagato"/"Su listino"), bottone "Salva impostazioni"
   (era "Salva percentuali"), "Ricarica" come anchor, niente "Salvataggio…".
8. markCommissionEntryPaid: messaggio not-found allineato alla pagina legacy
   "Movimento commissione non trovato nel filtro selezionato."; fmtMoney
   manuale (trap toLocaleString it-IT) nel modulo overview.
RESIDUI DELIBERATI: colonna "Sede" nel dettaglio e checkbox "Tutte le sedi"
(solo multi-sede, non esercitabili sul tenant) come le altre aree; l'annullo
APPUNTAMENTO non marca subito gli snapshot (lo fa il primo rebuild della
dashboard — il flusso legacy cancelAppointmentCommissionMovements da QB/
calendario è tracciato per l'area appuntamenti); blocco "unassigned"
(movimenti senza operatore) non reso — nemmeno la pagina legacy lo mostra.
Verifica: battery e2e 32/32 (settings con clamp 150->100 e mode whitelist,
accrual da vendita reale con operator_name staff -> entry 'POS servizio' 20%
su 12€ = 2,40€, staffOptions/probe/canQuickBook, filtro source, toggle pagato
con DB+guardie verbatim, annullo -> snapshot SUBITO cancelled con nota
standard, toggle su annullata -> guardia, delete -> snapshot eliminati,
ripristino stato modulo/settings originale, cleanup CLEAN) + 63/63 marker
bundle (incluse negative sulle invenzioni) + typecheck/lint puliti (3 warning
no-css-tags pre-esistenti).

## Magazzino (products + stock_moves) — audit dedicato (2026-07-05)
Diff su products.php (1787 righe: lista+form+categorie+immagini+delete blockers)
e stock_moves.php (1486 righe: lista+view+print+new+cancel+export CSV) +
ProductPageHelpers/stock JS, vs i 5 moduli Next + /api/manage/products +
manage-products.ts.
PROBLEMI GROSSI RISOLTI:
1. LISTA PRODOTTI riscritta: era una versione ridotta con filtri inventati
   ("Cerca" libero + Categoria) e tabella a 7 colonne con colonna "Stato
   Attivo/Non attivo" INVENTATA; delete come anchor morto. Ora: filtri legacy
   (combobox Prodotto con display_name "Nome (SKU)", Brand, Categoria,
   Fornitore, Codice prodotto, Codice interno, "Quasi esauriti", Filtra/Reset
   con query GET dal router), tabella a 11 colonne (Prodotto/Categoria/Brand/
   Codice/Prezzo/Prezzo acquisto/Fornitore/Stock/In arrivo/ETA/Azioni) con
   evidenza low-stock (table-warning + border-danger + icona + badge "Quasi
   esaurito" + "(min: N)"), modal "Dettagli prodotto" fedele, Elimina
   funzionante con modal "Impossibile eliminare il prodotto" + "Associazioni
   rilevate" (blockers strutturati dalla route) e flash verbatim.
2. VISTA CATEGORIE PRODOTTI: NON ESISTEVA (action=categories cadeva sulla
   lista). Nuovo modulo product_categories-content: filtro "Cerca per nome",
   form "Modifica categoria" inline (?edit_id), modal "Nuova categoria",
   modal-blocco con l'elenco prodotti associati (derivato client-side come il
   productCategoryProductsMap), header "Torna al magazzino"+"Nuova categoria",
   flash verbatim INCLUSI i quirk legacy dove "Nome categoria obbligatorio" e
   "Errore: categoria gia esistente o non valida" sono alert VERDI (&msg=).
3. STOCK_MOVES: vista DETTAGLIO (?action=view&id) ora pagina fedele (era un
   modal inventato) con Stato + "Annullato il: ... • da: ...", righe con
   colonna Fornitore, card allegato, azioni Torna alla lista/Stampa / PDF/
   Annulla movimento (conferma verbatim "Confermi annullamento del movimento?
   Verrà applicato lo storno sulla giacenza." — era inventata); vista STAMPA
   (?action=print&id) NUOVA con autoprint; lista fedele (causale raw
   text-uppercase, Documento=tipo+#numero+data, Prodotti=CONTEGGIO righe — non
   nomi, badge text-bg-danger/success, azione SOLO "Apri", niente
   allegato/Annulla in riga) + PAGINAZIONE 10/pagina ("Pagina X di Y • Totale:
   N", Prev/Next) + flash "Documento annullato (con storno)"/"Documento già
   annullato"/"Movimento salvato".
4. EXPORT CSV movimenti: era client-side con colonne inventate; ora GET
   action=export server-side col formato legacy ESATTO (Documento ID;Data
   movimento;...;Stato;Creato il, date raw, SI/NO, ANNULLATO/ATTIVO, filename
   movimenti_magazzino_<Y-m-d_H-i>.csv, senza BOM come fputcsv).
5. FORM MOVIMENTO: header actions come la lista, allegato spostato IN FONDO
   con label/help verbatim ("Carica documento (PDF o JPG, max 5MB)" / "Il file
   verrà salvato e compresso..."), righe con display_name + checkbox con label
   "Prodotto in arrivo" + placeholder "Es. 24" + bottone "Rimuovi" (era ✕),
   errori client verbatim senza accenti/punto e SEPARATI (quantita in arrivo /
   data stimata), dopo-save naviga alla vista dettaglio con "Movimento
   salvato", Salva fisso.
6. FORM PRODOTTO: header actions legacy (Categorie + Nuovo prodotto in edit,
   era "Torna al magazzino" inventato), label immagini verbatim "(max 5, max
   5MB ciascuna)" + "Le immagini vengono compresse automaticamente..." (era
   "JPG, PNG, WEBP o GIF..." inventato), Salva fisso, Annulla anchor.
7. LIB: messaggi querystring verbatim SENZA punto ("Prodotto non trovato",
   "Documento non trovato", "Nome categoria obbligatorio", "Aggiungi almeno un
   prodotto", "Seleziona almeno una sede per il prodotto", "Inserisci la
   quantita per tutte le righe" — e una riga qty=0 ora ERRA invece di essere
   scartata), guardie mancanti aggiunte ("Causale non valida", "Tipo documento
   non valido", "Prodotto non abbinato alla sede selezionata", "Scarico
   superiore alla giacenza attuale per un prodotto", "Impossibile annullare:
   storno porta giacenza negativa", "Nessuna riga prodotto"), dup categoria
   ("Errore: categoria gia esistente o non valida"), messaggi rimozione sedi
   con i NOMI delle sedi, delete prodotto con "associazioni attive presenti."
   + blockers strutturati.
RESIDUI DELIBERATI: popup di CONFERMA nome/codice/prezzo del form prodotto
(productUpdateConfirmModal/productPriceUpdateConfirmModal — gli aggiornamenti
snapshot/prezzi collegati sono GIÀ applicati automaticamente dal lib
updateProductSnapshots, manca solo il passaggio di conferma UI); dettaglio
blockers legacy più ricco (gruppi giftbox/promozioni con titoli specifici —
il Next riporta conteggi per tabella); upload immagini su R2 senza
compressione server-side (GD) — testi verbatim mantenuti; colonna Sede lista
prodotti multi-sede.
Verifica: battery e2e 39/39 (categorie dup/vuoto/bloccata, prodotto con
validazioni verbatim + product_stocks sede, movimenti con TUTTE le guardie
verbatim, carico 10+incoming, scarico, oltre-giacenza, guardia sede, export
CSV header/righe legacy, delete con blockers, storno scarico/carico con
ricalcolo incoming, cleanup CLEAN) + 84/84 marker bundle su 5 viste +
typecheck/lint puliti (7 warning no-css-tags pre-esistenti).

## Fornitori (suppliers) — audit dedicato (2026-07-05)
Diff su suppliers.php (865 righe, lista+form in un file) vs suppliers-content +
supplier_form-content + /api/manage/products (supplier_save/supplier_delete/
get&type=supplier) + manage-products.ts.
GIÀ A PARITÀ: header/kicker/empty-state, filtri (Cerca/Ambito/Stato/Filtra),
tabella (Fornitore/Contatti/Località "City (PR)"/Stato 2 badge/Sedi abilitate/
Uso Prodotti-Costi/Azioni), form a card (Fornitore con Nome+2 switch Stato,
Sedi abilitate con tabella checkbox per ambito, Intestazione, Informazioni
fiscali, Contatti) con placeholder verbatim, rename fornitore -> prodotti
aggiornati, guardie sedi per ambito attivo.
FIX PORTATI:
1. SEMANTICA SEDI legacy (app_supplier_location_map/allowed): un fornitore
   SENZA righe supplier_locations è abilitato per TUTTE le sedi — nuovo campo
   hasLocationRows su record e lista; la colonna "Sedi abilitate" ora mostra
   'Tutte' (prima 'Nessuna': INVERTITO!), il filtro Ambito filtra per la SEDE
   CORRENTE con il default-tutte (prima guardava solo se la lista sedi era
   vuota), e il form in EDIT di un fornitore senza righe pre-seleziona TUTTE
   le sedi (prima partiva vuoto e il salvataggio con stato attivo si bloccava
   con "Seleziona almeno una sede...").
2. NEW: tutte le sedi attive partono selezionate in entrambi gli ambiti
   (legacy formWarehouseLocationMap/formCostsLocationMap) — prima vuote.
3. Filtri draft applicati solo con "Filtra" + query GET dal router
   (?q/scope/status) + replaceState; flash ?msg/?err dal redirect del form.
4. Flash/errori in pagina (niente window.alert): "Fornitore eliminato",
   "Fornitore creato"/"Fornitore aggiornato" (redirect con ?msg= come il
   legacy), errori delete verbatim.
5. Messaggi verbatim: "Nome fornitore obbligatorio" (senza punto), "Fornitore
   non trovato" (senza punto), delete usato "Fornitore usato in prodotti o
   costi: non puo essere eliminato, disattivalo dai moduli." (prima
   accorciato), title bottone disabled "Fornitore usato: disattivalo invece
   di eliminarlo" (prima inventato).
6. Form: sottotitolo pagina verbatim "Gestisci dati, sedi abilitate e contatti
   del fornitore." (prima quello della lista), "Aggiunto il: d/m/Y" in coda
   (createdAt, mancava), "Salva" fisso, Annulla come anchor.
RESIDUI DELIBERATI: checkbox "Tutte le sedi" nei filtri (solo multi-sede);
gating permessi granulare legacy (canSupplierWarehouse/canSupplierCosts
disabilitano singoli switch/checkbox per ruoli senza permessi modulo) — la
route richiede suppliers.manage, la distinzione per-campo multi-ruolo è
tracciata con Ruoli.
Verifica: battery e2e 21/21 (validazioni verbatim, creazione con anagrafica
completa + supplier_locations, dup, hasLocationRows true/false, productCount,
delete bloccata verbatim, rename -> prodotti aggiornati, delete + pulizia
supplier_locations, cleanup CLEAN) + 49/49 marker bundle + typecheck/lint
puliti (warning no-css-tags pre-esistenti).

## Buoni (coupons.php) — 2026-07-05
AUDIT COMPLETO lista + form NEW/EDIT vs coupons.php (1253 righe) + coupons.js
+ coupons.css + helpers coupon_* (Helpers.php) + capture live (empty state,
form new, create/edit/cancel/delete con redirect flash). Tenant di test
mono-sede: verificato dal vivo il BUG legacy dell'endif mal posizionato
(coupons.php 1168/1250): con coupon esistenti la lista mono-sede non
renderizza ne' filtro ne' tabella (coupon ingestibili dalla UI).
FIX PRINCIPALI (Next):
1. mapCoupon: valid_from/valid_to sono colonne DATE -> node-pg da' Date
   local-midnight e String().slice(0,10) produceva "Sat Jul 05" (date rotte
   in lista/edit E nei confronti activeWindow) -> dateIsoLocal. createdAt/
   cancelledAt (timestamp senza tz) formattati locali "Y-m-d H:i:s" (prima
   toIso spostava a UTC, -2h vs live).
2. INSERT coupon: created_by (mancava, legacy lo salva) + created_at con ora
   LOCALE app (il DEFAULT CURRENT_TIMESTAMP Postgres e' UTC, il MySQL legacy
   salva wall-clock locale).
3. Ordine validazioni legacy: EDIT existing/deleted check PRIMA dei campi
   ("Coupon non trovato" / "Coupon gia eliminato dalla gestione", senza
   punto, con redirect lista danger/warning); NEW code vuoto/regex prima di
   value; "Seleziona almeno una sede abilitata." SOVRASCRIVE lo scope error
   (sede vince). Dup code SENZA filtro deleted (un soft-deleted riserva il
   codice) e msg accentato "Esiste già un coupon con questo codice.".
4. cancelManageCoupon: ordine legacy not-found -> is_active (soft-deleted
   risponde "Coupon già disattivato." accentato, warning); delete hard msg
   "Coupon eliminato" senza punto; esiti delete mappati come il legacy
   (open-appts -> warning con redirect all'EDIT, not-found danger, gia
   eliminato warning) e flash in pagina (niente window.alert).
5. couponUsageStats: lista cancelled legacy completa (cancelled/canceled/
   annullato/.../rejected, senza no_show che consuma) per sales E appts;
   open appts anche 'in sospeso'/'prenotato'; esposti partial/residual per
   l'alert del modale.
6. Lista: ORDER BY id DESC (prima code ASC); sconto percent raw "10.00%";
   fmt_money manuale (niente toLocaleString); flash ?msg=&type= con markup
   View::alert (icona bi-info-circle) sopra il page header (SSR via
   initialQuery dal router); filtro "Tutte le sedi" con replaceState.
7. Form: NEW pre-seleziona SOLO la sede corrente (prima tutte; legacy
   current-or-all) via currentLocationId nel form_context; blocco "Sedi
   abilitate" sempre renderizzato con "Nessuna sede disponibile."; opzione
   "Tutto il carrello (legacy)" persiste finche' il RECORD e' scope all;
   bottone "Disattiva coupon" solo con stato Attiva (non su Programmato/
   Scaduto, come il legacy); modale con alert "Storico collegato" per fixed
   parziale con residuo; redirect legacy post-azione (create -> lista
   "Coupon creato", update -> edit "Coupon aggiornato", disattiva -> edit
   "Coupon disattivato"); "Salva" fisso + Annulla anchor; label prodotti
   con guard product_display_name; ordinamenti opzioni legacy (categorie
   servizi non-categorizzato last + sort_order, servizi raggruppati per
   categoria, sedi per sort_order/id).
8. syncCouponLocations: scarta id sede non del tenant (port
   app_coupon_sync_locations); usage_limit troncato come (int) PHP;
   discount_value default '10'.
RESIDUI DELIBERATI: la tabella lista resta visibile anche mono-sede (il bug
legacy dell'endif renderebbe i coupon ingestibili; solo la card filtro
"Tutte le sedi" e' gated multi-sede). Il fallback sede-corrente di
app_coupon_sync_locations con selezione vuota non e' replicato (irraggiungibile:
la validazione sede blocca prima quando esistono sedi attive).
Verifica: battery e2e 52/52 (ordine validazioni verbatim, clamp/virgola/
trunc, dup + promo clash + code riservato da soft-deleted, GET record con
date senza shift e createdAt locale, audit created/cancelled by "luca",
lista id DESC + filtro sede + activeUsedCount, update code immutabile,
cancel doppio "già disattivato.", delete hard/soft/bloccata da appt aperto
con redirectEdit, soft-delete audit + esclusione lista, cleanup CLEAN) +
70/70 marker bundle + typecheck/lint puliti (warning no-css-tags
pre-esistenti).

## Clienti (clients.php) — 2026-07-05
AUDIT COMPLETO del monolite clients.php (3897 righe: lista, view, storico,
form new/edit, delete_confirm/delete, block/unblock, tag) vs i 4 moduli Next +
route + lib, con capture live (lista, view id=17, history, edit, delete_confirm
su MySQL legacy — solo lettura). Riscritti lista/detail/history/form + NUOVA
pagina delete_confirm.
FIX PRINCIPALI:
1. mapClient: birth_date/registration_date DATE -> node-pg Date local-midnight
   (String() dava "Sat Jul 05"); created_at/blocked_at in wall-clock locale;
   split_full_name ("Cognome, Nome") per i record con solo full_name (port
   client_profile_defaults). Aggiunti blockedAt/blockedInternalNote al tipo.
2. Lista: ordine legacy created_at DESC LIMIT 200 (era full_name ASC);
   filtro "Sconosciuto" auto-creato; filtro sede STRETTO (i clienti senza sede
   sono esclusi con sede attiva — verificato live; prima inclusi); blocked
   INCLUSI con badge "Disattivato" (prima nascosti); ricerca estesa
   phone_home/phone2 con escape legacy ('!'); empty state "Nessun cliente
   presente" + gating hasAnyClients del bottone "Nuovo"; citta/provincia
   sotto il nome (prima "—" statico); badge compleanno legacy ("Oggi è il suo
   compleanno" pill rossa / "Tra N giorni|giorno" badge-soft); Iscrizione da
   registration_date con fallback created_at; flash ?msg/?err; colonna Sede
   con '-'; via i tag inventati dalle righe. Vincoli legacy opt-in
   (legacyList) per non toccare i consumer fidelity/gift/QB.
3. Permessi come il legacy: pagina accessibile con ANY di clients/schede/
   consensi (prima solo clients.manage bloccava anche la lista); history/get/
   delete_summary gated clients.manage ("Permessi insufficienti per questa
   azione sui clienti."); perms nel payload per il gating di header/azioni
   (Configura schede, Nuovo, Modifica, Moduli consenso, Compilazioni, Storico,
   Nuovo appuntamento, Apri per sezione, Gestisci movimenti).
4. Scheda (view): RIMOSSE le invenzioni (alert blocked+Riattiva, card Azioni
   con Blocca/Elimina, card Documenti — la view legacy non li ha; blocca/
   elimina vivono nella pagina Modifica), aggiunta la stats row "Iscritto da/
   Età/Compleanno" (since_human/age_years/birthday_label portati server-side),
   card Fidelity SOLO se aderente (tessera attiva, gate
   fidelityIsClientAdhering) con label/enabled dal profilo + scadenza punti +
   "Gestisci movimenti" DENTRO Fidelity (prima in Credito), card Credito senza
   bottone, Tag card fedele (placeholder "Es. VIP, Allergie, Promo", bottone
   "Aggiungi", rimozione "×" con title Rimuovi, flash "Tag aggiunto"/"Tag
   rimosso"), label header verbatim ("Moduli consenso", "Compilazioni",
   "Storico", "Nuovo appuntamento" — prima "Consensi / GDPR"/"Schede
   tecniche"), "Nessun dato" senza punto, Sede '-' quando manca, errori di
   accesso -> redirect lista con ?err= come client_load_accessible.
5. Storico: riscrittura fedele — summary nel card-header dei "fissati"
   (Appuntamenti: N • Ultimo • Prossimo [• Vendite: € X]), bucket status
   legacy (client_history_appt_status_sql: prenotato/in sospeso/eseguito/
   executed/annullato/rifiutato; no_show FUORI da elenchi e conteggi — prima
   contato negli annullati), label/badge legacy (In attesa warning, Prenotato
   primary, Eseguito success, Annullato secondary, No show dark), fallback
   servizio da appointments.service_id, tabelle Pacchetti/GiftBox/GiftCard
   attive (destinatario, con emissione/codice/importi e status meta legacy),
   Preventivi con stato effettivo (sent+scaduto -> "Scaduto"), Storico vendite
   (Data/Totale/Elemento acquistato), empty rows verbatim, date d/m/Y H:i
   locali (niente shift UTC).
6. Form: card "Azioni cliente" su edit (badge Attivo/Disattivato,
   "Disattivato il d/m/Y H:i" + nota, "Riattiva cliente" con confirm
   "Riattivare questo cliente?", "Disattiva cliente" con modale verbatim e
   nota obbligatoria, "Elimina" -> delete_confirm); combobox Regione→
   Provincia→Città (app-combobox + italy-geo.js iniettato post-mount, submit
   legge gli hidden gestiti dallo script); redirect legacy (new -> view
   "Cliente creato", edit -> view "Cliente aggiornato", block/unblock ->
   edit con i flash verbatim "Cliente disattivato. Nessun dato associato e
   stato eliminato e potrai riattivarlo in qualsiasi momento." / "Cliente
   riattivato. Tutti i dati associati sono rimasti disponibili."); default
   sede NEW = sede corrente di sessione (non la prima); "Salva" fisso +
   Annulla anchor; validazioni server verbatim (Nome e cognome obbligatori /
   Email non valida. / PEC non valida. / Data di nascita non valida. / Data
   iscrizione non valida. / Seleziona una sede valida.).
7. NUOVA pagina "Rimozione cliente" (delete_confirm): subtitle "<nome>
   (email) ID: N", alert conferma verbatim, card "Cosa verrà eliminato" con le
   26 voci legacy nell'ordine live (incluso il quirk "gifts" minuscolo e
   Punti in fmt_money "12,40"), Motivazione (500) + Conferma testuale
   "Scrivi ELIMINA", stock_restore_mode=no_restore hidden (la scelta radio
   inventata è stata rimossa col vecchio modale), esito -> lista con
   "Clienti eliminati definitivamente: N[ - Stock ripristinato: N pezzi]".
8. Delete summary esteso alle chiavi legacy complete (righe_vendita, rate,
   piani_rate, commissioni via VEN#/APP#/#public_code, gifts, preventivi,
   tessere, account_booking, movimenti_fidelity, ricariche, rettifiche,
   riferimenti_campagne da excluded_client_ids, prodotti scalati/ordinati,
   documenti_magazzino via nota "Vendita #id", file_allegati) con punti/
   credito RAW (non arrotondati); giftcard/giftbox contate sent+received come
   il legacy. Guardie delete della route: "La motivazione e obbligatoria."
   (senza accento) e "Per confermare scrivi ELIMINA.".
RESIDUI DELIBERATI: livelli-punti Fidelity nella scheda (badge livello +
progress verso il prossimo livello + earnedPointsInLastDays) non portati — il
profilo test ha levels disattivi e 0 tessere; il ramo base (punti, label,
"Punti disattivati", scadenza) è fedele. account_cliente_attivita = 0 (il
registro globale Marketplace non è migrato). I POST GDPR/documenti/
update_profile della view legacy non hanno UI nella pagina (il markup live
non li renderizza): l'upload documenti resta disponibile via client_consents
e l'API client-document.
Verifica: battery e2e 50/50 (validazioni verbatim, create/update completi,
date senza shift, split_full_name, lista ordine/filtri/blocked/perms,
ricerca phone_home, block/unblock con DB audit, detail stats "10 maggio"/età/
since, fidelity gate con tessera vera, tag add/remove, history con fixture
reali su 4 status + vendita + preventivo scaduto + pacchetto con snapshot +
giftcard/giftbox destinatario, delete_summary conteggi + saldi raw, cascade
con guardie e 0 residui) + 113/113 marker bundle + regression coupons 52/52 +
typecheck/lint puliti (warning no-css-tags pre-esistenti).

## Pacchetti (packages.php) — 2026-07-05
AUDIT COMPLETO del monolite packages.php (4891 righe: tab clients + catalog,
client_view/client_edit/client_cancel/client_delete/usage_add/
update_client_package_expiry, catalog_new/catalog_edit/catalog_delete) +
ClientPackages.php (updateClientPackageExpiry/packageRedeemedForExpiry) vs i
moduli Next, con capture live (empty state clients verificato — il tenant
legacy ha 0 pacchetti). Riscritti lista clients e detail, NUOVO form
client_edit + redirect client_cancel/client_delete; catalogo esteso.
FIX PRINCIPALI:
1. Lista pacchetti clienti riscritta (prima solo 5 colonne senza filtri):
   filtri legacy Cliente/Pacchetto (combobox ricercabili "Tutti") + Stato
   (Attivi default/Completati/Scaduti/Annullati/Tutti, regole calcolate
   canceled>completed>expired>active) + [Tutte le sedi] multi-sede + Filtra;
   tabella 9 colonne (Cliente linkato se permessi clienti/schede/consensi,
   Sede da location_id o dalla vendita, Contenuto da snapshot con fallback
   catalogo/servizio "Nome ×qty", Rimanenti/Totali, Scadenza, Stato badge,
   Dettagli+Modifica); ordine updated_at DESC LIMIT 300; header actions gated
   (Impostazioni packagesSettings, Catalogo packagesCatalog e non su empty);
   empty state con Nuova vendita (pos.manage) + Catalogo; flash ?msg/?err;
   "Nessun pacchetto trovato con i filtri selezionati.".
2. Dettaglio (client_view) riscritto: header legacy (Pacchetto cliente, nome,
   Cliente linkato - Sede - Servizio/Servizi/Contenuto - Creato da preventivo
   #N linkato con quotes.manage), badge stato + Dettaglio vendita (saleId da
   sale_id O dalla nota vendita "CP#id" — port packages_find_sale_id) +
   Modifica; alert riattivazione ("Questo pacchetto non può essere
   riattivato." / "Contenuti disattivati presenti." con le voci '"X" è stato
   eliminato/disattivato.'); riga Sedute totali/rimanenti ("N in sospeso su
   prenotazioni" dalle prenotazioni APERTE via appointment_package_items
   pending/scheduled non riscattate) /Inizio/Scadenza con matita -> modale
   "Modifica scadenza pacchetto" verbatim (min oggi/inizio, lock con
   messaggio se riattivazione impossibile); tabella "Contenuto pacchetto"
   (Tipo/Voce/Totali/Rimanenti, prodotti con rimanenze da net delta usages);
   Note; form "Registra seduta/ritiro" (Voce "Servizio • Nome — X/Y sedute
   disponibili (N in sospeso)", Operazione Scala|Segna ritirato / Ripristina|
   Ripristina ritiro con unità sedute/pz e help contestuali verbatim,
   Data/ora, Nota con placeholder dinamico, Conferma) + "Torna alla lista";
   tabella Movimenti (Quando/Quantità +N vd. unità/Tipo pending|redeem|
   restore|cancel|adjust/Voce/Nota normalizzata "In sospeso|Annullato|
   Riscatto su prenotazione #X"/Operatore) con i MOVIMENTI VIRTUALI legacy
   (in sospeso per prenotazioni aperte; coppia sospeso+annullato per le
   cancellate senza storico reale).
3. usage_add completo: path PRODOTTI (ritiro/ripristino con quantità incluse
   da snapshot, net delta, stock per sede product_stocks con guard enabled,
   documento magazzino stock_docs scarico/carico con nota verbatim "Ritiro
   prodotto da Pacchetti • pacchetto cliente #N • cliente: X • prodotto: Y
   xQ", note default e messaggi "Ritiro prodotto registrato"/"Ripristino
   ritiro prodotto registrato", errori verbatim su quantità/stock); path
   SERVIZI con RISERVE (le sedute in sospeso su prenotazioni riducono le
   scalabili: "Sedute insufficienti per il servizio selezionato: N già in
   sospeso su prenotazioni"); used_at dall'input; guardie annullato/scaduto
   verbatim; messaggi querystring senza punto (Quantità non valida,
   Operazione non valida, Pacchetto non trovato, Seleziona la voce da
   registrare, Seleziona il servizio da scalare, Superi le sedute totali...).
4. Scadenza (update_client_package_expiry) allineata a ClientPackages:
   guard "gia utilizzato" = packageRedeemedForExpiry (completed o
   remaining<total — NON il conteggio usages: consume+restore in pari resta
   modificabile), blocco riattivazione se contenuti eliminati con il
   messaggio composito legacy, esiti "Scadenza pacchetto aggiornata" /
   "Errore: <dettaglio>", riattivazione automatica da scaduto.
5. NUOVO form client_edit fedele: Cliente*/Sede/Da catalogo (— personalizzato
   —, precompila nome/servizio/sedute)/Servizio combobox, sedute totali/
   rimanenti "(se vuoto = totali)", date, Scadenza disabilitata se usato
   ("Scadenza non modificabile perche il pacchetto risulta gia utilizzato."),
   Stato con Attivo disabilitato se riattivazione bloccata + annullato
   readonly "Annullato (solo da dettaglio vendita)" e help "L'annullamento è
   disponibile solo dal dettaglio vendita.", alert availability; POST con le
   guardie legacy (Seleziona un cliente / Nome pacchetto obbligatorio / Il
   pacchetto si annulla solo dal dettaglio vendita. / autofill catalogo con
   validity_days / clamp rimanenti / snapshot) -> client_view "Pacchetto
   aggiornato". client_new BLOCCATO come il legacy ("La vendita/assegnazione
   dei pacchetti avviene solo da Pagamenti."); client_cancel/client_delete
   -> redirect al dettaglio vendita (o al dettaglio pacchetto) con i
   messaggi verbatim.
6. Catalogo: lista con fmt_money manuale, flash ?msg/?err + "Pacchetto
   eliminato" dopo il delete; form con redirect legacy ("Pacchetto creato"/
   "Pacchetto aggiornato") e "Salva" fisso; già fedeli le validazioni server
   (Nome obbligatorio, Seleziona almeno una sede..., Aggiungi almeno un
   servizio/prodotto..., Per creare un pacchetto è necessario almeno un
   servizio (sedute)., righe attive e abilitate per tutte le sedi) e il
   calcolo prezzi (sconti riga percent/amount + sconto totale, prezzo
   pacchetto = totale calcolato, package_services aggregato per sedute).
RESIDUI DELIBERATI: package_settings è pagina separata (audit non incluso in
questo giro); il form usage legacy aggiorna label/max via packages.js — il
port ricalcola le stesse label da stato React; i "frozen service names" da
snapshot appuntamenti usano appointment_services.service_name (snapshot Next)
invece del decode JSON legacy; la lista lega la ricerca q legacy (UI rimossa
nel PHP, supportata via API).
Verifica: battery e2e 48/48 (validazioni catalogo verbatim, save con sconti e
prezzo calcolato 118.00 + figli DB, lista/prefill, riserve da prenotazione
aperta con movimento virtuale e saleId da nota CP#, usage servizi con guardie
e riserve, usage prodotti con stock/stock_docs/note verbatim, scadenza con
guardie legacy e riattivazione, client_save con guardie, client_new bloccato,
catalog_delete con detach, cleanup CLEAN) + 92/92 marker bundle + typecheck/
lint puliti (warning no-css-tags pre-esistenti).

## Pacchetti / Impostazioni (package_settings.php) — 2026-07-05
Audit del residuo dell'area Pacchetti (131 righe): il componente Next era gia
sostanzialmente fedele (layout card Scadenza predefinita + info box "Come
funziona", clamp 0..36500 e whitelist unit days/months/years nel backend).
FIX: messaggio di salvataggio verbatim del redirect legacy ("Impostazioni
scadenza Pacchetti salvate. I pacchetti gia presenti rimarranno invariati." —
prima troncato senza la coda) e flash con il markup View::alert (icona
bi-info-circle + d-flex). Verifica: battery e2e 6/6 (msg verbatim, 90 months,
clamp 36500 + unit fallback days, negativo->0, RIPRISTINO dei valori business
originali) + 16/16 marker bundle + typecheck/lint puliti.

## Preventivi (quotes.php) — 2026-07-05
AUDIT COMPLETO del monolite quotes.php (2647 righe: list/view/new/edit/print/
pdf/delete/send/next_number) + QuoteSale.php + QuoteAvailability.php +
assets/js/pages/quotes.js vs i moduli Next, con capture live (lista con 1
preventivo reale, view, form new/edit, print). I 3 componenti Next erano un
"CORE port" divergente (lista client-side senza sede/filtri veri, form a
layout inventato senza numero/stato/sede/metodi pagamento, detail ridotto):
riscritti tutti + NUOVA stampa.
FIX PRINCIPALI:
1. Stato EFFETTIVO legacy portato sul server (quote_effective_status):
   Annullato prevale; Pagato se stato paid O vendita ATTIVA collegata
   (source_quote_id oppure marker note "Preventivo collegato: Q#id",
   annullate escluse); sent con validita scaduta -> Scaduto. Badge legacy
   (sent=primary, expired=warning, canceled=dark...). AUTO-EXPIRE e
   AUTO-SYNC PAID stampati sul DB a ogni load lista (tenant-scoped, con
   refresh dello snapshot sede prima del paid).
2. Lista riscritta: filtri server-side Cliente (combobox ricercabile con
   TUTTI i clienti ordinati per nome, non solo quelli con preventivi) /
   Stato (paid matcha anche la vendita attiva collegata via EXISTS) / Data /
   Numero LIKE / "Tutte le sedi" multi-sede; scoping sede legacy
   (location_id = corrente OR NULL); ORDER q.id DESC LIMIT 300; colonna Sede
   (location_name o lookup); Elimina SOLO per bozze con confirm "Eliminare
   questo preventivo?"; header Impostazioni (perm quotes.settings) + Nuovo
   preventivo solo se hasAnyQuotes; empty state legacy; "Nessun preventivo
   trovato con i filtri selezionati."; flash ?msg/?err; fmt_money manuale.
   RIMOSSO il bottone "Incassa" inventato (non esiste nel legacy).
3. Dettaglio riscritto: subtitle Data • Valido fino al • Sede • Stato badge;
   azioni condizionali legacy (Modifica solo se non accepted/paid/canceled;
   Dettaglio vendita success/outline se annullata; "Vai a Pagamenti" solo
   accepted senza blocchi, href pos?quote_id= — pos-content ora accetta
   anche quote_id oltre a quote; PDF; Invia email nei 4 stati con i title
   disabled verbatim; Stampa _blank embed=1); alert vendita collegata
   (annullata warning / acquistato success con "Apri dettaglio vendita" /
   accettato info/warning); ALERT DISPONIBILITA (QuoteAvailability port
   completo: eliminato=error, disattivato=warning, componenti dei pacchetti
   via package_items+package_services+service_id con contesto 'Pacchetto
   "X"', dedupe, label prodotto con SKU, messaggi verbatim con accenti
   legacy '"X" è stato eliminato.' / 'non e abilitato per la sede'),
   nascosti su stato Pagato; card Cliente con campi fiscali + riga CAP
   citta (prov); card Note interne / Nota per il cliente / Metodi di
   pagamento; righe con product_display_name + SKU + "Sconto: X%", q.tà e
   IVA raw dal DB ("2.00", "22.00%"); modale invio con apostrofi tipografici
   verbatim e Link pubblico (già generato) se token presente.
4. Form new/edit riscritto da zero sul layout legacy a 2 colonne: numero
   AUTOMATICO N/YYYY (endpoint next_number, aggiornato al cambio data finche
   non modificato a mano, MAX(split_part) per anno); stato con SOLO gli
   editabili + opzione "Inviato/Scaduto (automatico)" per gli stati gestiti
   dal sistema; sede hidden mono-sede o select con confirm+reload verbatim;
   combobox Cliente che prefilla lo snapshot (split "Cognome, Nome" o ultima
   parola) e triggera la cascata italy-geo; Regione/Provincia/Citta js-it-*
   con italy-geo.js iniettato; Info fiscali; metodi di pagamento CHECKBOX
   dai metodi configurati in Preventivi/Impostazioni con resa strutturata
   "Nome: dettagli"; condizioni con default quote_terms; box righe con
   PREZZO BLOCCATO readonly per servizio/prodotto/pacchetto (title legacy),
   alert() verbatim (Seleziona un servizio. / Inserisci una descrizione. /
   ...), descrizioni composte legacy (prodotto "Nome (SKU)", pacchetto
   "Nome (N sedute)"); tabella righe 7 colonne con SKU/sconto; totali col
   toLocaleString it-IT (fedele a quotes.js, NON number_format).
5. SAVE legacy completo lato server: ordine validazioni e messaggi verbatim
   (Seleziona una sede valida / Numero troppo lungo max 32 / Riga non
   valida: seleziona un elemento valido per X / Aggiungi almeno una riga /
   'Tipo "desc" non abilitato per la sede "Sede1".' / blocco Accettato con
   messaggio composito 'Non sara possibile impostare il preventivo in stato
   "Accettato" ne inviarlo via email perche ... Correggi le righe indicate
   dal preventivo per rimuovere il blocco.'); PREZZI CATALOGO BLOCCATI (in
   edit lo snapshot della riga esistente resta anche se il catalogo cambia,
   le righe nuove prendono il prezzo corrente); nome+cognome uniti con
   regex legacy; backfill snapshot dal cliente selezionato; CLIENTE
   AUTO-CREATO dallo snapshot manuale (notes 'Creato automaticamente dal
   salvataggio di un preventivo.', registration_date oggi, sede); numero
   manuale con duplicato -> 'Numero preventivo già esistente. Scegli un
   numero diverso.'; numero automatico con retry 30 -> 'Impossibile
   generare un numero preventivo univoco.'; __keep_auto__/stati non
   editabili -> stato precedente (expired torna sent solo se sent_at);
   sent+validita passata -> expired; metodi pagamento filtrati sui
   configurati (JSON); snapshot sede location_* dal profilo business;
   created_by + created_at/updated_at localtime; redirect view con
   'Preventivo salvato'.
6. DELETE legacy: accesso sedi, solo bozza EFFETTIVA ('Puoi eliminare solo
   preventivi in bozza. Per preventivi inviati o storicizzati usa lo stato
   Annullato/Rifiutato.' -> redirect view), 'Preventivo eliminato' /
   'Preventivo non trovato' (senza punto) / 'Errore eliminazione: X'.
7. SEND legacy con guardie in ordine (validita scaduta 'Aggiorna la data di
   validita prima di inviare il preventivo.' / stato 'Invio email non
   consentito per preventivi in stato "X".' / blocco disponibilita / 'Email
   destinatario non valida.'), token pubblico 32-hex garantito con retry,
   corpo email legacy (Ciao <nome>, Apri preventivo, Scarica PDF),
   mark-sent (draft->sent + sent_at/sent_to_email) SOLO a invio riuscito,
   'Email inviata a X' / 'Invio email fallito (controlla configurazione
   server).' — prima il route flippava lo stato a sent PRIMA dell'invio.
8. NUOVA pagina STAMPA (print&embed=1, senza chrome): toolbar no-print
   Torna/Stampa (window.print), intestazione attivita dal profilo preventivo
   (app_quote_profile_from_quote: profilo business + nome sede live +
   snapshot congelato per Pagato/Annullato), meta N./Data/Valido/Stato,
   cliente con indirizzo "CAP citta (prov)" separato da •, righe, totali,
   Nota, Metodi di pagamento, Condizioni con fallback quote_terms, footer.
RESIDUI DELIBERATI: action=pdf serve la vista stampabile (nessun renderer
PDF server-side in Next; il bottone e l'URL legacy restano); il checkout POS
marca la quote 'converted' invece di 'paid' — lo stato effettivo e il
paid-sync la normalizzano a 'paid' al primo load della lista; quote_settings
è pagina separata (audit a parte); il feed GET default resta per
notifications_quotes.
Verifica: battery e2e 80/80 (next_number, guardie save verbatim, save
completo con numero auto/prezzi bloccati/cliente auto/snapshot sede/metodi
filtrati/matematica righe e totali, duplicati, edit con snapshot prezzi,
availability disattivato/eliminato con blocchi Accettato+send, send guardie
+ token, lock edit per stato effettivo, __keep_auto__, auto-expire e
paid-sync su DB, vendita collegata attiva/annullata, filtri lista, print,
delete draft-only, cleanup CLEAN + ripristino businesses) + 84/84 marker
bundle + regressione Pacchetti 48/48 + typecheck/lint puliti (warning
no-css-tags pre-esistenti).

## Preventivi / Impostazioni (quote_settings.php) — 2026-07-05
Audit della pagina impostazioni preventivi (546 righe: dati anagrafici e
intestazione documenti, condizioni preventivo, metodi di pagamento
strutturati) + quote_settings.js vs il modulo Next, con capture live (GET +
POST reali: redirect flash e alert errore verbatim verificati sul PHP).
Il markup Next era gia vicino; fix su comportamenti e messaggi:
1. Combobox Regione/Provincia/Citta erano MORTE (hidden controllati, nessuna
   iniezione di italy-geo.js): ora hidden non controllati con defaultValue,
   span app-combobox-text vuoti (li riempie lo script), italy-geo.js
   iniettato post-mount con cache-buster, valori letti dal DOM al submit.
2. Flash legacy: i salvataggi ora fanno redirect con ?msg= come il PHP
   ('Dati anagrafici salvati' / 'Condizioni preventivo salvate' / 'Metodi di
   pagamento salvati' — SENZA punto finale; prima la route rispondeva con il
   punto e il componente mostrava un feedback in pagina senza reload);
   markup View::alert con icona; errore in pagina senza redirect (mantiene i
   valori inseriti) + scroll top.
3. Wrapper errori verbatim nella route: profilo 'Errore salvataggio dati
   anagrafici: <msg> (se persiste, controlla che lo schema business sia
   aggiornato e che il DB possa eseguire ALTER/UPDATE)' (avvolge anche le
   validazioni, verificato live); condizioni 'Colonne mancanti: aggiorna il
   DB...' / 'Errore salvataggio condizioni preventivo: <msg>'; metodi
   'Colonna mancante: ...' / 'Errore salvataggio metodi di pagamento: <msg>'.
4. Header actions (Preventivi + Nuovo preventivo) ora gated su quotes.manage
   come Auth::can del legacy (la route configuration espone canQuotesManage
   per il modulo quote_settings).
5. Metodi di pagamento: il form ora invia pm_name[]/pm_details[] (come il
   POST legacy, serializzati JSON perche il body della route appiattisce gli
   array) e la normalizzazione resta al SERVER (nome 120 char, dettagli 400,
   newline->spazio, righe vuote saltate, max 50, join 'Nome: dettagli',
   troncamento 8000, vuoto->NULL) — prima il client costruiva il raw senza i
   limiti legacy.
6. isUrl allineato a FILTER_VALIDATE_URL: il WHATWG URL di Node accettava
   host con caratteri invalidi (es. '!') che il PHP rifiuta -> aggiunta la
   validazione hostname ('Sito web non valido.' ora scatta come il legacy,
   dopo la normalizzazione https://).
Gia fedeli: campi/lunghezze profilo (255/40/.../190), messaggi 'PEC non
valida.'/'Email documenti non valida.'/'Uno dei campi anagrafici supera la
lunghezza massima consentita.', troncamento condizioni 12000, split UI
'Nome: dettagli' con nome max 80, riga vuota minima nei metodi.
Verifica: battery e2e 20/20 (validazioni profilo con wrapper, save profilo
con normalizzazione https e flash senza punto, condizioni con troncamento e
NULL, metodi strutturati con limiti server e ricostruzione righe dal raw,
vuoto->NULL, ripristino businesses) + 37/37 marker bundle + regressione
package_settings 6/6 e Preventivi 80/80 + typecheck/lint puliti.

## GiftBox (giftbox.php) — 2026-07-05
AUDIT COMPLETO del monolite giftbox.php (3127 righe: tab instances + boxes,
edit_instance con movimenti virtuali, riscatto parziale, riserve
prenotazioni, invio email) + GiftBox.php (4962 righe) +
GiftBoxAvailability.php + GiftLoyaltyAttribution + giftbox.js vs i moduli
Next, con capture live (lista con 2 istanze reali, dettaglio, boxes, form).
FIX PRINCIPALI:
1. Lista istanze riscritta su filtri SERVER-SIDE legacy: Mittente (combobox
   app-combobox ricercabile con TUTTI i clienti, non solo quelli in lista),
   Cerca (LIKE su codice/destinatario/email — NON sul mittente), Stato,
   "Tutte le sedi" multi-sede con filtro sede STRETTO (gi.location_id = ?,
   le istanze senza sede spariscono come nel PHP); JOIN giftboxes con
   deleted_at IS NULL (le istanze di template eliminati escono dalla lista);
   ORDER gi.id DESC LIMIT 200; AUTO-EXPIRE stampato sul DB a ogni load
   (GiftBox::expireDueInstances); colonna Sede con giftbox_page_location_label
   ('Sede1'/'Sede #N'/'-'); date RAW YYYY-MM-DD ('—' se vuote) con Emessa =
   created_at fallback issued_at; badge `bg-<colore>`; voucher link legacy
   ?id=N&embed=1 (shim token) al posto del link pubblico col token; header
   gated (Impostazioni giftbox.settings, Crea GiftBox pos.manage e nascosto
   sull'empty state); flash ?msg/?err.
2. Dettaglio istanza: MOVIMENTI rifatti fedeli — transazioni REALI
   giftbox_transactions (prima assenti: cambio destinatario, modifica
   scadenza, storni POS) + virtuali legacy (emissione con la NOTA CLIENTE
   come nota e amount +unità totali, "In sospeso su prenotazione #CODICE"
   solo per prenotazioni APERTE con public_code e data creazione
   appuntamento, coppia sospeso+annullato/no-show per le prenotazioni chiuse
   senza storico reale, riscatti con voci "×q" e nota normalizzata
   'Riscatto su prenotazione #COD' anche da [appt_deleted:#], annullamento
   con la riga [ANNULLATA ...] della vendita, scadenza) ordinati desc con
   Sede e Operatore risolti; QUANTITÀ col colore +/-; date d/m/Y H:i.
3. Contatori legacy: disponibili = rimanenti − riserve prenotazioni APERTE
   (pending/scheduled non riscattate; prima contava anche le annullate) e
   NON azzerati su annullata/riscattata; hint 'N in sospeso su prenotazione
   #COD'; badge esaurito/in sospeso (text-bg-light); PARZIALE solo su issued.
4. Riscatto parziale: chiavi redeem_qty per giftbox_item_id come i name
   legacy; CHECKBOX quando resta 1 unità; guardia pagina 'Quantità non
   disponibile per "X". N già in sospeso su prenotazioni.'; guardie
   GiftBox::redeemInstanceItems verbatim (Istanza non riscattabile /
   GiftBox non ancora valida / GiftBox scaduta con stampa expired /
   Elemento non valido (id=N) / Servizio GiftBox non disponibile nella sede
   selezionata / Seleziona almeno un elemento da riscattare.); SCALA LO
   STOCK dei prodotti sulla sede corrente ('Prodotto non abbinato alla sede
   selezionata: X.' / 'Stock insufficiente per il prodotto "X" nella sede
   selezionata.'); layout Operazioni legacy (bordered form, bottoni
   outline-primary/outline-secondary/outline-light, confirm 'Registrare il
   riscatto selezionato?'); redeemed_source_type manual al completamento.
5. Scadenza: modale con min = max(oggi, inizio validità), valore clampato,
   frase condizionale sull'inizio validità; guardie verbatim ('Seleziona una
   nuova data di scadenza valida.' / '...non può essere precedente a oggi.'
   / "...precedente all'inizio validità della GiftBox." / annullata /
   RISCATTATA ANCHE PARZIALE via isInstanceRedeemedForExpiry); riattivazione
   da Scaduta BLOCCATA se contenuti eliminati (GiftBoxAvailability port con
   messaggio composito 'Non sarà possibile riattivare la GiftBox perché ...
   Elimina o sostituisci gli elementi indicati prima di riattivarla.') e
   pencil/modale disabilitati; MOVIMENTO 'Modifica scadenza GiftBox:
   <vecchia|nessuna scadenza> -> <nuova> (GiftBox riattivata)'; alert
   'Contenuti eliminati/disattivati nella GiftBox' sulle istanze scadute.
6. Dati GiftBox: LOCK DESTINATARIO (recipientEditLockInfo) con messaggi
   verbatim (annullata / riscattata / 'anche solo parzialmente' / scaduta),
   campi readonly + toggle/remove disabilitati + alert warning, enforcement
   anche server-side (lo snapshot resta quello corrente); ricerca cliente
   SERVER-SIDE (port api_clients action=search: LIKE ESCAPE '!' su
   nome/email/telefono + variante solo-cifre, LIMIT 50) con debounce 250ms,
   risultati '#id • email • telefono' e 'Nessun cliente trovato.';
   selezione: nome readonly, email readonly solo se presente in anagrafica;
   MOVIMENTO 'Cambio destinatario: X -> Y' (adjust + meta);
   update consentito anche su annullate (come il legacy — bloccata è solo la
   scadenza); evento default 'giftbox' con la mappa eventi GiftBox verbatim
   (prima usava la lista GiftCard con default 'giftcard'); 'Seleziona un
   cliente' / 'Cliente destinatario non trovato.'; Sede emissione sempre
   visibile; flash 'Istanza aggiornata' e redirect legacy (?msg/?err).
7. Invio email: guardie in ordine legacy (email non valida -> mail fn
   mancante -> stato non valido -> scaduta con stampa expired) e CORPO EMAIL
   legacy completo (hero evento con emoji+titolo+immagine, 'Hai ricevuto una
   GiftBox acquistata da X.', box dedica, tabella Dettagli GiftBox
   GiftBox/Mittente/Destinatario/Valida dal/al, Contenuto con '(Contenuto
   non mostrato. Per scoprirlo, mostra il codice in cassa.)', Codice di
   riscatto, Vedi Voucher, Condizioni con default legacy e {BUSINESS_NAME},
   subject evento + codice + attività, nomi template POS mascherati);
   salvataggio gift_message + last_email_* + azzeramento
   email_send_claimed_at; 'Ultimo invio: <raw> (<email>)'; 'Email inviata a
   X' / 'Invio email fallito.'.
8. Dettaglio header: 'Dettagli vendita' dal lookup sale_items legacy
   (item_name LIKE 'GiftBox%' + codice; prima cercava 'Vendita #N' nella
   nota), Voucher ?id=&embed=1, Impostazioni/Crea GiftBox gated; redirect
   'Istanza non trovata' alla lista.
9. Template (tab boxes): ordine legacy sort_order ASC id DESC; Costo punti
   '0' quando zero (prima '—'); niente sottoriga descrizione; Modifica
   btn-outline-primary; Elimina come link con confirm + flash 'GiftBox
   eliminata' (redirect legacy che torna alle istanze); form con i 3
   selettori riga sempre in DOM (d-none), rimozione righe senza minimo,
   validazione client SOLO alert 'Seleziona almeno un livello Punti.'
   (le altre guardie restano al server come il PHP), livelli richiesti con
   fidelity_only SENZA whitelist sui livelli configurati (fedele a
   normalizeLevelKeys), redirect post-save su action=edit&id con flash
   'GiftBox salvata', 'GiftBox non trovata' -> redirect lista.
10. Fix date PG in gift-issue-details: i timestamp "without time zone" erano
    formattati con toISOString (shift UTC) — ora formatter locali.
RESIDUI DELIBERATI: GiftLoyaltyAttribution::syncAnonymousSaleClientByRecipient
(riassegnazione cliente sulla vendita anonima al cambio destinatario) non
portato — viene salvato recipient_client_id come il fallback legacy senza la
classe; i nomi storici servizio da snapshot appuntamenti usano
service_snapshot_json delle righe istanza (non il decode degli snapshot
appuntamento); activeUsageLinkCounts approssimato a prenotazioni aperte +
riscatti (il conteggio sales del legacy non è replicato); con SES non
configurato l'invio email risponde con la guardia 'mail_send_html mancante'
(stesso ordine guardie del PHP); giftbox_settings è pagina separata (già
fedele da audit precedente, non inclusa).
Verifica: battery e2e 63/63 (template save/list/delete con messaggi e soft
delete, lista con filtri e auto-expire su DB, dettaglio con contatori/labels/
movimenti/operatore, update con log cambio destinatario e guardie, scadenza
con guardie+movimento+riattivazione bloccata e ok, riserve da prenotazione
aperta con blocco doppio riscatto e coppia virtuale annullato, riscatto
parziale/completo con stock prodotti e lock conseguenti, nota interna, email
guardie, ricerca clienti, cleanup CLEAN) + 101/101 marker bundle +
regressioni Preventivi 80/80 e Pacchetti 48/48 + typecheck/lint puliti.

## GiftBox / Impostazioni (giftbox_settings.php) — 2026-07-05
Audit della pagina impostazioni GiftBox (234 righe: scadenza predefinita +
condizioni) + giftbox_settings.js vs il modulo Next, con POST live sul PHP a
conferma dei flash. Il markup era gia fedele; fix su messaggi e comportamenti:
1. Flash redirect legacy verbatim: 'Impostazioni scadenza GiftBox salvate. Le
   GiftBox già presenti rimarranno invariate.' (prima mancava la coda),
   'Condizioni GiftBox salvate' e 'Condizioni GiftBox ripristinate' SENZA
   punto finale (prima col punto); salvataggi con redirect ?msg= e markup
   View::alert con icona (prima feedback in pagina senza reload).
2. Wrapper errori verbatim nella route ('Errore salvataggio impostazioni
   scadenza GiftBox: X' / 'Colonne mancanti: ... (scadenza GiftBox).' /
   'Errore salvataggio condizioni GiftBox: X' / 'Errore ripristino condizioni
   GiftBox: X' / 'Colonna mancante: ... (GiftBox condizioni).').
3. Header actions gated come Auth::can legacy (GiftBox su giftbox.manage,
   Crea GiftBox su pos.manage — la route configuration espone
   canGiftboxManage/canCreate per il modulo giftbox_settings).
4. Prefill dal payload settings (value/unit/terms raw) invece del parsing dei
   record aggregati; testo default mostrato quando le condizioni sono vuote.
Gia fedeli: clamp 0..36500 + unit whitelist con fallback days, condizioni
troncate a 12000 con newline normalizzati e vuoto/reset -> NULL, confirm
'Ripristinare il testo predefinito delle condizioni GiftBox?'.
Verifica: battery e2e 15/15 (flash verbatim, clamp/fallback, troncamento,
vuoto->NULL, reset, prefill, ripristino businesses) + 23/23 marker bundle +
regressioni GiftBox 63/63, package_settings 6/6, quote_settings 20/20 +
typecheck/lint puliti.

## GiftCard (giftcard.php) — 2026-07-05
AUDIT COMPLETO di giftcard.php (1927 righe: lista + edit con riscatto credito
e per-item, lock destinatario, scadenza, email, movimenti normalizzati) +
GiftCard.php (funzioni list/get/update/updateExpiry/redeem/redeemItem/
sendEmail/scheduled/expireDue/recipientEditLockInfo) + giftcard.js vs i moduli
Next, con capture live (lista con 1 card reale, edit) e dati MySQL tenant 25.
FIX PRINCIPALI:
1. Lista riscritta su filtri SERVER-SIDE legacy (GiftCard::listGiftCards):
   Mittente (combobox app-combobox con TUTTI i clienti), Cerca (LIKE su
   codice/destinatario/email), Stato whitelist, "Tutte le sedi" con filtro
   sede STRETTO (gc.location_id = ? — le card senza sede spariscono); ORDER
   gc.id DESC LIMIT 200; AUTO-EXPIRE (expires_at DATE < oggi) e INVII
   PROGRAMMATI (sendDueScheduledGiftCards 20 con claim 15min) a ogni load;
   colonna Sede sempre presente con gc_page_location_label; Emessa =
   gc_page_date_only (Y-m-d), Scadenza raw ('—' se vuota); € fmt_money
   manuale (prima toLocaleString); badge bg-*; voucher/codice -> link manage
   ?id=&embed=1 (prima token pubblico); header legacy [Torna alla lista]
   [Crea GiftCard pos.manage, nascosto sull'empty state] SENZA Impostazioni
   (solo nell'empty state, gated giftcard.settings); empty state su conteggio
   NON filtrato; action=new -> lista con flash 'Per creare una GiftCard vai
   in "Pagamenti" e usa il pulsante GiftCard.'; flash ?msg/?err; route con
   permesso stretto giftcard.manage su lista/dettaglio.
2. Dettaglio: riepilogo legacy completo (Importo iniziale/Saldo € fmt_money,
   Emessa il e Inizio validità SOLO DATA da issued_at, Scadenza con matita,
   Evento, Sede emissione, Voucher 'Importo nascosto/visibile', Contenuto
   regalo 'Label: Nome — Q (residuo R)' con product_display_name '(SKU)',
   Messaggio di dedica); readonly TOTALE su annullata (alert verbatim +
   js-gc-readonly-form: tutti i campi disabilitati); nota cliente ripulita
   dagli append [ANNULLATA|INFO]; 'Dettaglio vendita' dal lookup sale_items
   LIKE 'GiftCard%'+codice (prima 'Vendita #N' nella nota); ogni _mode fa
   redirect flash come il PHP (prima stato in pagina).
3. MOVIMENTI fedeli: ledger reale con JOIN users (Operatore) e sede
   (gc_page_location_label), Data raw, Importo € colorato +/-, e la
   normalizzazione prenotazioni gc_prepare_movement_display: nota
   'Uso GiftCard|Riscatto su prenotazione #REF' risolta sull'appuntamento
   (public_code, fallback id, giftcard_used>0) -> eseguito = redeem
   'Riscatto su prenotazione #COD', aperto = pending 'In sospeso su
   prenotazione #COD' con data di creazione prenotazione; fallback
   'Riscatto su prenotazione #ref'; ordinati per data desc (id desc a pari).
4. Dati GiftCard: guardie verbatim in ordine legacy ('Seleziona un
   mittente.' / 'Mittente selezionato non valido.' / 'Cliente destinatario
   non trovato.' / 'Non è possibile modificare una GiftCard annullata.');
   LOCK DESTINATARIO (recipientEditLockInfo) con i 4 messaggi verbatim
   (annullata / item riscattati o usi attivi su prenotazioni+vendite o saldo
   diverso dall'iniziale -> 'anche solo parzialmente' / riscattata /
   scaduta), enforcement server-side (lo snapshot resta quello corrente);
   nome/email forzati dall'anagrafica del cliente selezionato; MOVIMENTO
   'Cambio destinatario: X -> Y' (adjust 0 + meta) solo se cambia; clamp
   120/190/1000/2000; ricerca cliente SERVER-SIDE (port api_clients
   action=search) con debounce 250ms; flash 'GiftCard aggiornata'.
5. Scadenza: salvata come DATA (prima datetime 23:59:59 su colonna DATE);
   guardie verbatim in ordine legacy ('Seleziona una nuova data di scadenza
   valida.' / '...non può essere precedente a oggi.' / 'La data "Valida al"
   deve essere almeno il giorno successivo a "Valida dal".' / annullata /
   RISCATTATA ANCHE PARZIALE via isGiftCardRedeemedForExpiry: prima
   bloccava solo status redeemed); minimo modale = max(oggi, emissione+1g)
   con frase condizionale; MOVIMENTO adjust 'Modifica scadenza GiftCard:
   <vecchia d/m/Y|nessuna scadenza> -> <nuova> (GiftCard riattivata)' + meta
   (prima type 'expiry_change' fuori enum e nota inventata, scartato in
   silenzio dal CHECK); nessun movimento se la data non cambia;
   riattivazione automatica da Scaduta.
6. NUOVO riscatto credito (port addTransaction): 'Importo non valido.' /
   'GiftCard non utilizzabile (stato: X).' / scaduta per data con stampa
   expired + 'GiftCard scaduta.' / 'Saldo insufficiente.'; nota default
   'Riscatto GiftCard'; movimento redeem -importo con sede corrente e
   operatore; flip 'redeemed' SOLO con credito 0 E item esauriti
   (redeemed_at NULL quando resta attiva); flash 'Riscatto registrato';
   topup/cancel -> 'Operazione non disponibile.'.
7. Riscatto per-item: guardie verbatim (voce/residuo/'Quantità eccede il
   residuo (residuo: N).'), qty clamp 1..999, SEDE ('Servizio non abilitato
   per la sede selezionata: X.' / 'Prodotto non abbinato alla sede
   selezionata: X.') e SCALA LO STOCK del prodotto sulla sede corrente
   ('Stock insufficiente per il prodotto "X" nella sede selezionata.') —
   prima assenti; nota default legacy 'Riscatto servizio/prodotto: <label>
   xN' (prima 'Riscatto item: ... × q'); meta kind item_redeem + location;
   layout Operazioni legacy (form bordered, badge bg-light text-dark border,
   'Riscatta (scala credito)' Importo/Nota col-5/7, box 'Riscatta credito'
   per card solo servizi/prodotti, bottoni btn-outline-primary).
8. Email: guardie in ordine legacy (email -> annullata -> scaduta con stampa
   expired) SENZA la guardia mail-fn del GiftBox: il fallimento (o SES non
   configurato) risponde 'Invio email non riuscito. Verifica la
   configurazione email del server.'; CORPO legacy completo (hero teal 'Hai
   ricevuto una GiftCard!' con badge importo e immagine evento, dedica, Nota
   per il cliente, Dettagli Mittente/Destinatario/Emessa d/m/Y H:i/Scadenza/
   Esaurita il/Annullata il, Valore + 'Contenuto regalo:' o nota 'recati in
   negozio', Codice di riscatto, Vedi Voucher, Condizioni default con nome
   attività interpolato e {BUSINESS_NAME}); subject per evento; salvataggio
   last_email_* + gift_message + scheduled_send_on=NULL + claim azzerato;
   checkbox 'Mostra importo e contenuto nella mail' SEMPRE spuntato di
   default (prima seguiva l'ultimo invio); alert 'Invio programmato: d/m/Y'
   quando scheduled_send_on e nessun invio tracciato.
9. Eventi GiftCard dal map legacy (ordine giftcard/compleanno/anniversario/
   capodanno/... già corretto in GIFT_EVENT_OPTIONS); nota interna con
   blocco su annullata + clamp 2000; compat _mode=update_note.
RESIDUI DELIBERATI: GiftLoyaltyAttribution::assignRecipientClient non portato
(salvato recipient_client_id come il fallback legacy senza warn Fidelity);
'Saldo insufficiente.' su card redeemed a saldo 0 (fedele: addTransaction non
guarda lo stato redeemed); e2e-pos-gift.mjs non rieseguibile (script vecchio
senza fix DNS pooler, fallisce in connessione a prescindere).
Verifica: battery e2e 93/93 (lista con filtri/expire-due/sede stretta,
dettaglio con date/min scadenza/labels, update con guardie+lock server-side+
movimento cambio destinatario, scadenza con guardie/movimento/riattivazione/
blocco parziale, riscatto credito con saldo/flip/note default, riscatto item
con sede+stock e flip redeemed, scaduta per data, email guardie SES-off,
nota interna, movimenti pending/redeem da prenotazione con data prenotazione,
link vendita, invii programmati con claim reset, ricerca clienti, cleanup
CLEAN) + 92/92 marker bundle + regressioni GiftBox 63/63 e giftbox_settings
15/15 + typecheck/lint puliti.

## GiftCard / Impostazioni (giftcard_settings.php) — 2026-07-05
Audit della pagina impostazioni GiftCard (237 righe: scadenza predefinita +
condizioni) + giftcard_settings.js vs il modulo Next, con capture live sul
PHP. Il markup era gia fedele; fix su messaggi e comportamenti:
1. Flash redirect legacy verbatim: 'Impostazioni scadenza GiftCard salvate.
   Le GiftCard già presenti rimarranno invariate.' (prima mancava la coda),
   'Condizioni GiftCard salvate' e 'Condizioni GiftCard ripristinate' SENZA
   punto finale (prima col punto); salvataggi con redirect ?msg= e markup
   View::alert con icona (prima feedback in pagina senza reload); errori in
   pagina con scrollTo come le altre settings.
2. Wrapper errori verbatim nella route ('Errore salvataggio impostazioni
   scadenza GiftCard: X' / 'Colonne mancanti: ... (scadenza GiftCard).' /
   'Errore salvataggio condizioni GiftCard: X' / 'Errore ripristino
   condizioni GiftCard: X' / 'Colonna mancante: ... (GiftCard condizioni).').
3. Header actions gated come Auth::can legacy (GiftCard su giftcard.manage,
   Crea GiftCard su pos.manage — la route configuration espone
   canGiftcardManage/canCreate per il modulo giftcard_settings).
4. Testo condizioni predefinito con il NOME ATTIVITÀ interpolato nell'ultima
   riga ('In caso di smarrimento, contatta <nome> indicando il codice
   GiftCard.') dal payload settings.business_name (biz.name, fallback 'La
   mia attività') — prima era hardcoded 'elite'.
5. Prefill dal payload settings (value/unit/terms raw) invece del parsing dei
   record aggregati; branch page.tsx dedicato con initialQuery ?msg/?err.
Gia fedeli: clamp 0..36500 + unit whitelist con fallback days, condizioni
troncate a 12000 con newline normalizzati e vuoto/reset -> NULL, confirm
'Ripristinare il testo predefinito delle condizioni GiftCard?'.
Verifica: battery e2e 16/16 (flash verbatim, clamp/fallback, troncamento,
vuoto->NULL, reset, prefill con business_name, ripristino businesses) +
36/36 marker bundle + regressioni giftbox_settings 15/15 e GiftCard 93/93 +
typecheck/lint puliti.

## Fidelity (fidelity.php) — 2026-07-05
AUDIT COMPLETO della pagina hub Fidelity (1134 righe: toggle generale con
guardie di disattivazione, modale campagne bloccanti / prenotazioni
coinvolte, strip agevolazioni, ripristini alla riattivazione) + fidelity.js
vs il modulo Next, con capture live. FIX PRINCIPALI:
1. BUG DOPPIO ACCREDITO: lo strip Next riaccreditava clients.points per i
   punti delle prenotazioni aperte — nel legacy i punti su In sospeso/
   Prenotato sono solo LOCKATI virtualmente (Fidelity::reservedPoints:
   disponibile = saldo - riservato; AppointmentLifecycle ~974 'i punti erano
   solo prenotati/lockati... non accreditarli di nuovo'). Ora lo strip
   azzera SOLO le colonne fidelity (points_used/discount/gift_points_used=0,
   gift_idx/conflict_choice=NULL — senza toccare fidelity_campaign_id come
   il legacy) e il saldo cliente resta invariato.
2. Pulizia note automatiche legacy allo strip
   (fidelity_page_strip_appointment_auto_notes): rimosse le righe
   /^Fidelity:\s*(-|omaggio prenotato|scelta in negozio)/i dalle note delle
   prenotazioni coinvolte (nota utente mantenuta, note vuote -> NULL) —
   prima assente.
3. Guardie POST verbatim: campagne bloccanti 'Per disattivare l'impostazione
   generale Fidelity devi prima disattivare le campagne collegate: N
   campagna/e Promozioni collegate alla Fidelity e N campagna/e Omaggi
   collegate alla Fidelity.'; conferma popup 'Prima di disattivare Fidelity
   conferma dal popup la rimozione delle agevolazioni Fidelity da N
   prenotazione/i in stato In sospeso/Prenotato.' (prima shape JSON
   needsConfirm non legacy).
4. Messaggio disattivazione composto verbatim: 'Fidelity disattivata. N
   campagna/e punti attiva/e disattivata/e. rimosse automaticamente le
   agevolazioni Fidelity da N prenotazione/i (N con agevolazioni)' —
   'rimosse' minuscolo e dettaglio '(N con agevolazioni)' come il legacy
   (prima 'Rimosse' maiuscolo senza dettaglio); disattivazione a flag già
   spento passa dal ramo generico e disattiva comunque le campagne punti
   attive (prima early-return).
5. GET action=state con l'IMPATTO calcolato al load come il GET legacy:
   campagne Promozioni/Omaggi bloccanti (nomi, ordine title/name ASC,
   fallback 'omaggio #id' minuscolo) e — solo senza campagne bloccanti — le
   prenotazioni coinvolte DETTAGLIATE (public_code, date, stato, cliente,
   servizi aggregati 'Nome ×q' da appointment_services, punti/sconto/
   omaggio/scelta normalizzati, ordine starts_at ASC id ASC).
6. Componente riscritto: submit intercettato come fidelity.js (solo
   disattivando con impatto) con le DUE varianti modale legacy — 'campaigns'
   (info bloccante modal-xl con le liste 'Campagne Promozioni/Omaggi da
   disattivare', badge 'Promozione'/'gift', bottoni 'Apri Promozioni'/'Apri
   Omaggi'/'Chiudi') e 'appointments' (conferma con pannello 'Prenotazioni
   coinvolte' + 'Visualizzate fino a 3 prenotazioni alla volta...', righe
   con badge Prenotato/In sospeso, data 'd/m/Y H:i - H:i' o '→', 'Punti: N
   Punti • sconto € X'/'Sconto punti: € X', 'gift/scelta Fidelity:
   prenotato/scelta in negozio/collegata', link 'Apri' alla prenotazione,
   card warning-subtle 'Continuando perderai le agevolazioni Fidelity gia
   prenotate', footer Annulla/'Conferma disattivazione') — prima una
   conferma generica senza liste; POST con redirect flash ?msg/?err e markup
   View::alert (prima stato in pagina senza reload); branch page.tsx
   dedicato con initialQuery; fmt_points legacy (intero troncato).
7. Riattivazione: ripristino promozioni/omaggi auto-disattivati con filtro
   target legacy (promotions target_type='fidelity', gifts
   eligibility='fidelity_only' — prima senza filtro), updated_at aggiornato,
   messaggi 'N campagna/e Promozioni target Fidelity riattivata/e' / 'N
   campagna/e Omaggi Solo clienti con Fidelity riattivata/e' e marker
   gift_progress_resets 'fidelity_disabled_end' (già presenti).
RESIDUI DELIBERATI: gli errori inattesi del toggle rispondono col messaggio
grezzo (il prefisso legacy 'Errore salvataggio: ' copriva solo le eccezioni
impreviste del blocco POST); le vecchie battery e2e-fidelity/e2e-fidpoints
(campagna F) codificano la shape pre-fix (needsConfirm/riaccredito +5) e una
guardia fidpoints aggiunta dopo la loro scrittura — non rieseguibili così.
Verifica: battery e2e 27/27 (state con impatto, blocco campagne con flag
invariato, dettagli prenotazioni coinvolte con servizi ×q, conferma popup,
strip con saldo INVARIATO + note ripulite + campagne punti auto-disattivate,
riattivazione con ripristini e marker, rami idempotenti, ripristino
businesses e zero residui ZZ) + 45/45 marker bundle + regressioni fidcamp
11/11 e fidwallet 11/11 + typecheck/lint puliti.

## Punti Fidelity (fidelity_points.php) — 2026-07-05
AUDIT COMPLETO della pagina Punti (3845 righe: impostazioni con conferme,
livelli inline, campagne punti con preview di impatto, KPI sede, top clienti)
+ fidelity_points.js (1334 righe) vs i moduli Next. FIX PRINCIPALI:
1. SECONDO BUG DOPPIO ACCREDITO: lo strip di "disattiva sconto/punti"
   riaccreditava clients.points — come per il toggle generale, i punti sulle
   prenotazioni aperte sono lockati virtualmente: ora azzera solo
   fidelity_points_used/discount (+ conflict_choice solo se discount/later).
2. Strip col PERIMETRO legacy (remove_disable_redeem_impacted_associations):
   variante REDEEM — i campi omaggio (gift_points_used/gift_idx) NON vengono
   toccati nemmeno spegnendo il modulo Punti; WHERE con conflict_choice IN
   (discount,later); note automatiche ripulite in scope redeem ('Fidelity: -'
   e 'scelta in negozio'; 'omaggio prenotato' resta).
3. GUARDIE PRIMA DELLE SCRITTURE: prima conferma redeem/points, poi conferma
   scadenza, POI le scritture (prima lo strip avveniva anche quando la
   conferma scadenza falliva dopo); blocco legacy con Fidelity generale OFF
   ('Fidelity e disattivata. Attiva la funzione in "Impostazione generale"
   per utilizzare questa sezione.') su settings e campagne.
4. Campagne punti: messaggio overlap VERBATIM ('Esiste gia una campagna punti
   attiva nello stesso periodo: "X" (ID N) (Subito|d/m/Y -> Mai|d/m/Y).
   Modifica le date, disattiva l'altra campagna oppure salva questa campagna
   come inattiva.' — prima testo inventato); guardie 'Attiva prima Punti
   Fidelity...' sulla condizione legacy globale && modulo Punti (prima solo
   globale); delete con RIFERIMENTI COMPLETI (prenotazioni + vendite +
   ricariche, prima solo prenotazioni), deleted_reason salvato, messaggi per
   modalita (hard 'eliminata definitivamente.' / soft 'rimossa dall elenco
   operativo...' / 'Campagna punti gia rimossa.'); ordine lista legacy
   (attive prima, poi per date); payload con auto_disabled_by_points.
5. PREVIEW di impatto legacy (preview_fidelity_campaign_toggle/delete):
   endpoint campaign_preview con i contatori del PHP (prenotazioni
   aperte/storiche per stato, vendite attive/annullate, ricariche
   attive/stornate, movimenti earn con UNION su appuntamenti/vendite/
   ricariche) e le modali col rendering di fidelity_points.js (alert
   condizionali, card contatori, accordion eliminazione, 'Riferimenti
   totali', motivo con placeholder 'Es. campagna sostituita').
6. KPI colonna destra fedeli: emessi/usati/scaduti FILTRATI SULLA SEDE
   corrente (transactions.location_id), 'Saldo totale globale' e 'Clienti con
   punti globali' limitati ai clienti con TESSERA attiva non scaduta (EXISTS
   su cards), Top clienti = top 10 server-side con link Dettagli +
   location_id (prima client-side su tutti i clienti senza filtro tessere);
   caption 'Statistiche operative sede: <nome|tutte le sedi>'; fmt_points.
7. Componente: stato 'Fidelity disattivata' (points-disabled-card con
   empty-promotions.svg e link Impostazione generale gated fidelity.manage) —
   prima assente; sezioni operative NASCOSTE con modulo Punti off (prima solo
   le sottosezioni); banner 'nessuna campagna punti attiva' sul CONTEGGIO
   attive (prima su 'attiva oggi'); vista solo-Livelli (perm fidelity.levels
   senza fidelity.points: titolo 'Livelli Card', settings/campagne/stats
   nascosti); modali conferma CLIENT-SIDE come fidelity_points.js (redeem/
   points con pannello 'Prenotazioni coinvolte' in variante ASCII della
   pagina e testi dinamici Punti-vs-sconto; scadenza con le 3 varianti
   Attivare/Disattivare/Aggiornare + 'Cosa non cambia'); redirect flash
   ?msg/?err + branch page.tsx; form campagna con i default legacy ('Nuova
   campagna punti', attiva, inizio oggi, step dalle impostazioni, modal-xl,
   maxlength 120) e formati legacy ('Fisso: 1 punto ogni 12,50 EUR',
   'Subito -> Mai', riga 'ID: N', badge 'Disattivata da Punti').
RESIDUI DELIBERATI: alert ?warn_locked&client_id (punti bloccati su
prenotazioni, redirect da flussi wallet legacy) non replicato; le preview
threshold/delete dei LIVELLI restano nel modulo Livelli (audit F4);
e2e-fidcamp (campagna F) codifica il vecchio messaggio overlap non verbatim
-> 1 FAIL atteso.
Verifica: battery e2e 42/42 (guardie in ordine con DB invariato, strip senza
riaccredito e omaggi intatti, note redeem-scope, preferenze preservate con
punti off + campagne auto-disattivate, overlap/livello/date/scaglioni
verbatim, guardie operative e globale off, delete hard/soft/already con
motivo, preview refs, ordine lista, KPI sede+tessere+top clienti, ripristino
businesses e zero residui) + 102/102 marker bundle + regressioni
fidelity-toggle 27/27 e fidcamp 10/11 (1 FAIL atteso sul messaggio overlap
corretto) + typecheck/lint puliti.

## Portafoglio punti (fidelity_wallet.php) — 2026-07-05
AUDIT COMPLETO della pagina Portafoglio (1288 righe: stati disabilitati,
movimento manuale con protezione punti prenotati, dettaglio cliente con
calendario scadenze, movimenti paginati, punti in sospeso, lista clienti) +
fidelity_wallet.js vs il modulo Next. FIX PRINCIPALI:
1. 'Disponibili' RAW legacy (availablePointsRaw): può scendere sotto zero —
   prima la riserva veniva clampata al saldo e il disponibile non andava mai
   negativo; alert 'Disponibile negativo' col testo verbatim.
2. Calendario scadenze RAGGRUPPATO PER GIORNO (23:59:59) come il legacy
   (prima una riga per LOTTO con colonne inventate 'Guadagnati il/Origine'):
   quota 'vincolati' dai lock-lots scaduti (parse lock@YYYYMMDD...),
   'Vincolati su: Prenotazione #X, #Y +N' (title completo), 'Da rimuovere
   (cron): N', righe table-warning/table-info sul passato, 'ore H:i',
   'Prossima scadenza: d/m/Y H:i (N Punti).', vuoto -> 'Nessun punto con
   scadenza rilevata (saldo consumato o storico vuoto).'; alert legacy
   'Punti già scaduti (cron non eseguito)' (expiredPending) e 'Punti scaduti
   ma vincolati' con link 'Vedi punti in sospeso'.
3. Movimenti punti fedeli: colonna SEDE (location_name con fallback nome
   sede/'Sede non disponibile', mostrata quando transactions.location_id
   esiste), tipi legacy ('scadenza' per expire, 'kind • source #id' — prima
   etichette inventate 'Accredito/Riscatto/...'), Δ '+N'/-N colorato,
   PAGINAZIONE SERVER 20/pagina via ?p=N con 'Pagina X di Y • Totale: N' e
   link « Prev / Next » (prima slice client su 100 movimenti max).
4. Punti in sospeso legacy: badge riepilogo ('Totale sospesi: N Punti',
   'Voci: N', 'Sconto: N', 'omaggio: N'), colonne Quando/Sede/Prenotazione
   #cod/Stato/Punti/Dettaglio ('Sconto: <b>N</b> • omaggio: <b>N</b>')/Apri,
   paginazione ?p_pending=N con 'Totale voci: N'.
5. Flusso warn_locked legacy: il movimento manuale fa REDIRECT FLASH
   (?msg/?err + &warn_locked=N quando restano punti prenotati) e la pagina
   mostra l'alert 'Punti prenotati su appuntamenti' con la tabella delle
   prenotazioni che li vincolano (Data/Stato/Sconto/gift/Totale/Codice/Apri)
   — prima feedback in pagina senza né redirect né alert; la route espone
   warnLocked anche sull'errore 'tutti prenotati'.
6. Vista elenco legacy: filtro Cliente come COMBOBOX app-combobox 'Tutti i
   clienti' guidato dalla querystring (?client_id) con Filtra/Reset (prima
   input testo con filtro client-side), 'Dettagli' come link, paginazione
   ?p_list=N con 'Totale clienti: N' o hint verbatim; il dettaglio si apre
   SOLO con cliente selezionato (prima lista sempre visibile sotto).
7. Stato disabilitato legacy con EARLY RETURN dedicato: header con azione
   'Portafoglio' (-> page=wallet) + alert-info con i link alle sezioni —
   prima solo l'alert; blocco intestazione cliente con 'Scadenza punti: N
   giorni'/'Avviso: entro N giorni'/'Scadenza punti: disattivata'; box KPI
   'In scadenza entro N giorni' sempre visibile; nota form con la frase
   scadenza legacy ('La scadenza dei punti viene calcolata dalla data del
   movimento/accredito...') e senza la frase extra non legacy.
8. Messaggio errore movimento allineato ('Operazione non riuscita (punti
   insufficienti o movimento duplicato).'); 'Cliente non trovato.' ->
   'Seleziona un cliente.' come il legacy; branch page.tsx con initialQuery
   (client_id/p/p_pending/p_list/msg/err/warn_locked).
GIA FEDELI: guardie del movimento manuale (punti interi >=1, cliente,
adesione tessera), protezione punti prenotati con rimozione parziale e i
messaggi composti ('Rimossi N Punti. N Punti non rimossi perché prenotati
su appuntamenti in sospeso/prenotati.' / 'N Punti non rimossi per saldo
insufficiente.'), kind manual/adjust, expire-on-read dei lotti.
RESIDUI DELIBERATI: la paginazione di punti-in-sospeso e lista clienti è
slice client-side sulla stessa querystring (dati identici al legacy, che
pagina in SQL le stesse liste); il warn_locked mostra le prenotazioni dal
dettaglio (equivalente a reservedAppointmentsList, limit 50).
Verifica: battery e2e 29/29 (stati disabilitati verbatim, guardie, add con
tx manual+nota, riserva 30/50 con disponibile RAW, rimozione parziale con
messaggi e warnLocked, saldo zero/resto insufficiente, kind adjust, lista
titolari tessera anche disattiva, calendario per giorno con expire-on-read
e saldo riallineato, paginazione movimenti, ripristino businesses e zero
residui) + 72/72 marker bundle + regressioni fidelity_points 42/42 e
fidelity-toggle 27/27 + typecheck/lint puliti.

## Adesione (fidelity_membership.php) — 2026-07-05
AUDIT COMPLETO della pagina Adesione (1170 righe: tessere con crea/aggiorna/
riattiva/elimina, registro anti-riuso codici, release agevolazioni) +
fidelity_membership.js vs il modulo Next. FIX PRINCIPALI:
1. TERZO BUG DOPPIO ACCREDITO: releasePendingAppointmentFidelityForClient
   (usato da disattivazione ed eliminazione tessera) riaccreditava
   clients.points — il release legacy azzera SOLO le colonne fidelity (punti
   lockati virtualmente): ora nessun riaccredito, fidelity_conflict_choice a
   NULL (prima stringa vuota), fidelity_campaign_id NON toccato (prima
   azzerato) e note automatiche 'Fidelity: ...' ripulite (prima assente).
2. Lista fedele: filtro q in SQL (codice/nome/email — prima client-side su
   500 tessere), PAGINAZIONE 20/pagina via ?p con 'Pagina X di Y • Totale:
   N', stato EFFETTIVO ('Disattivata (scaduta)' per attive scadute),
   '(in fase di scadenza)' nella finestra di rinnovo (parse renewal window),
   scadenza di riattivazione per riga, sync legacy delle scadute al load
   (active + expires < oggi -> inactive, solo con scadenza tessera abilitata,
   fidelity_card_sync_expired_statuses); expiredCount = scadute della PAGINA
   (per l'alert 'Tessere scadute rilevate' col testo lungo verbatim — prima
   un contatore nell'header non legacy).
3. Messaggi composti verbatim con REDIRECT FLASH ?msg/?err (prima stato in
   pagina): disattivazione 'Tessera disattivata. Le prenotazioni in stato In
   sospeso / Prenotato hanno perso le agevolazioni prenotate (N prenotazione/i
   con agevolazioni Fidelity). Le prenotazioni in stato Eseguito restano
   invariate.'; eliminazione 'Tessera eliminata. Credito cliente mantenuto.
   Il codice tessera resta riservato e non potra essere riutilizzato.' +
   'Rimossi N gift/omaggi in accumulo legati a campagne Solo clienti con
   Fidelity.' + release + coda Eseguito; confirm eliminazione LUNGO legacy
   ('ATTENZIONE: questa operazione resetta completamente PUNTI e
   MOVIMENTI...'); confirm disattivazione dal JS legacy ('Impostando
   "Disattiva" il cliente perderà...Continuare?' — prima assente).
4. Modale Modifica legacy: help scadenza dinamico ('Tessera scaduta. Con la
   riattivazione la nuova scadenza sarà d/m/Y.' / '...imposta prima una
   durata tessera...'), 'Riattiva tessera' DISABILITATO senza durata
   configurata, Salva sempre presente (prima nascosto su scaduta e select
   disabilitata), nota completa a 4 righe ('Nota: se la regola adesione è
   Solo clienti con tessera...' — prima 2 righe), bottoni tabella legacy
   (Modifica btn-warning icona, Elimina icona).
5. Ricerca cliente della Nuova tessera SERVER-SIDE (api_clients search, min
   2 caratteri, debounce — prima filtro client-side sui soli titolari
   wallet); risultati '#id • email • telefono'; scadenza anteprima '—' e
   form-text con la coda 'Non modificabile qui.'; warning gia-scaduta col
   testo verbatim.
6. Riattivazione: sincronizza il CREDITO wallet sulla tessera riattivata
   (credit_wallet_sync_active_cards — prima assente); stato disabilitato con
   early-return, header 'Fidelity' gated fidelity.manage e testo alternativo
   'Chiedi a un Admin...' (perms canFidelityManage/canLevels dal payload).
GIA FEDELI: guardie create/update/reactivate verbatim, codice auto 6 cifre
progressivo su registro anti-riuso permanente, credito wallet sulla tessera
alla creazione, blocco emissione gia scaduta, reset punti/lotti/movimenti e
codice riservato all'eliminazione.
RESIDUI DELIBERATI: gli snapshot legacy pre-eliminazione
(fidelity_loyalty_preserve_card_on_sources_before_delete /
snapshot_executed_appointments) non sono portati — servono agli avvisi di
storno post-eliminazione del flusso annullamenti legacy; il POST con Fidelity
globale off risponde con la guardia 'Attiva prima la Fidelity...' (il legacy
ignora il POST con l'early-return della pagina).
Verifica: battery e2e 32/32 (guardie verbatim, codice auto + registro,
scadenza +365gg e credito alla creazione, filtro q SQL, stato effettivo,
finestra rinnovo, sync scadute, release senza riaccredito con campaign_id
intatto e note ripulite, riattivazione con credito sync e guardia senza
durata, eliminazione con reset e codice bloccato, client_search, ripristino
businesses e zero residui) + 60/60 marker bundle + regressioni wallet 29/29
e toggle 27/27 + typecheck/lint puliti.

## Impostazioni tessera Fidelity (fidelity_membership_settings.php) — 2026-07-05
AUDIT COMPLETO della pagina (539 righe: form scadenza/rinnovo/promemoria con
handler save_fidelity_card_validity_default) + fidelity_membership_settings.js
(222 righe) vs saveFidelityCardValidityDefault/getFidelityMembershipSettings +
componente Next. FIX PRINCIPALI:
1. CLAMP finestra rinnovo riscritto con ARITMETICA DI CALENDARIO legacy
   (fidelity_card_duration_compare su base 2001-01-01 + max_strictly_smaller
   con binary search per unità years->months->days): prima usava
   un'approssimazione in giorni e CORROMPEVA l'unità (2 anni vs 365 giorni
   scriveva 18008/years invece di 11/months); confronto Y-m-d numerico
   (compare_ymd) perché con anni a 5 cifre il confronto stringa passava.
   Clamp applicato SOLO con scadenza+rinnovo attivi; display GET con finestra
   memorizzata già clampata + flag renewalClamped per il warning legacy.
2. renewal_enabled NON più forzato a 0 con scadenza off (il legacy salva il
   posted); confronto "Nessuna modifica da salvare." fedele: finestra
   precedente CLAMPATA sulla durata precedente, reminder normalizzato,
   expiryEnabledChanged||durationChanged||renewalChanged.
3. Apply-to-existing fedele: contatori su flip di USABILITÀ (stato attivo E
   non scaduta) — prima disable riattivava solo le inactive scadute perdendo
   le attive-scadute; restore ora mantiene inattive le tessere disattivate
   manualmente nel periodo senza scadenza, ripristina PRIMA la data snapshot
   per-card e per le tessere senza snapshot usa emissione+durata memorizzata
   (con clamp fine mese); durata di ripristino = posted>0 altrimenti durata
   precedente (disable) / snapshot->default->posted (restore).
4. RELEASE agevolazioni mancante: le tessere risultate scadute al restore
   tolgono le agevolazioni prenotate (pending/scheduled) dei loro clienti via
   releasePendingAppointmentFidelityForClient — colonne azzerate, note
   automatiche ripulite, NESSUN riaccredito punti (erano solo lockati) — con
   coda messaggio 'Alcune tessere sono risultate scadute e N prenotazione/i
   con agevolazioni Fidelity hanno perso le agevolazioni prenotate su
   appuntamenti in stato In sospeso / Prenotato.'; refresh dei clienti con
   flip: ricalcolo livello + credito wallet sincronizzato sulle tessere attive
   (credit_wallet_sync_active_cards); pulizia card_reminders pending
   expiry_window in tutte le modalità.
5. MESSAGGI VERBATIM per modalità (confermati 1:1 contro il PHP live): disable
   con coda riattivate ('N tessera precedentemente scaduta è tornata attiva.')
   + coda durata memorizzata ('Se riattiverai in futuro la scadenza
   automatica... (N giorni).') prima assenti; restore col testo lungo legacy
   ('hanno recuperato prima l'ultima data di scadenza memorizzata quando la
   scadenza automatica era stata disattivata; ... (label).') + 'restano
   scadute / non attive finché non usi Riattiva tessera.'; preserve con coda
   'Rinnovo automatico e promemoria di scadenza sono stati aggiornati anche
   per le tessere già presenti.' (prima assente); etichetta durata legacy
   singolare/plurale ('1 giorno/mese/anno', '0 giorni').
6. SYNC scadute legacy estesa: nuova syncExpiredFidelityCardStatuses
   (UPDATE inactive + release per TUTTI i clienti con tessere scadute) usata
   al load della pagina (GET modulo), sul POST prima del salvataggio (come il
   legacy che sincronizza prima del blocco _mode) e in getFidelityMembership
   (prima la sync di Adesione non rilasciava le agevolazioni).
7. Componente riscritto sul JS legacy: show/hide dinamico (campi durata/
   sezioni dipendenti nascoste con scadenza off, notice 'Scadenza tessera
   disattivata.' solo da spenta, promemoria alternativo al rinnovo), bottone
   Salva DISABILITATO senza modifiche (title 'Nessuna modifica da salvare' /
   'Salva le modifiche alla tessera Fidelity'), MODAL 'Aggiorna tessere
   Fidelity' con testi per modalità (generic/disable/restore/renewal_only) e
   impatto rosso solo su restore (prima window.confirm con testo inventato),
   redirect flash ?msg/#fidelity_card_settings (errori in pagina come il
   legacy), stato disabilitato con Fidelity globale off (alert + header
   Adesione/Fidelity gated fidelity.manage), 'Livelli Card' gated
   fidelity.levels, warning clamp display; branch page.tsx con initialQuery;
   GET route espone canFidelityManage/canLevels.
GIA FEDELI: guardie durata/conferma verbatim, ordine guardie (durata ->
nessuna modifica -> conferma), snapshot per-card al disable, testi statici.
RESIDUI DELIBERATI: il POST con Fidelity globale off risponde 'Attiva prima la
Fidelity per gestire le tessere.' (il legacy lo ignora con l'early-return);
l'alert 'DB da aggiornare' senza tabella cards non è portato (schema Next
completo); reminders_cleared non compare in nessun messaggio (come legacy).
Verifica: battery e2e 29/29 (guardie, nessuna-modifica, clamp calendario
2anni->11mesi e 11mesi->5mesi con JSON persistito, display 400g->364g con
warning, preserve senza toccare le attive, disable con snapshot+2 riattivate+
credito sync, restore da snapshot con release senza riaccredito e note
ripulite, tessera senza snapshot da emissione+durata, sync su GET con release,
ripristino businesses e zero residui) + confronto LIVE PHP dei flash
(preserve/disable/restore/unchanged identici, JSON clamp identico) + 65/65
marker bundle + regressione Adesione 32/32 + typecheck/lint puliti.

## Livelli Card (fidelity_levels.php + editor #livelli-card) — 2026-07-05
AUDIT COMPLETO dell'endpoint solo-POST fidelity_levels.php (1124 righe:
save_levels con conferme e cascata) + editor inline di fidelity_points.php
(#livelli-card, righe 3398-3489) + fidelity_points.js (326-858: validazioni,
preview soglie/eliminazione, token conferma) + preview endpoints
(preview_fidelity_level_thresholds / preview_fidelity_level_delete) vs
saveFidelityLevels/FidelityLevelsContent. FIX PRINCIPALI:
1. BASE LEVEL DINAMICO: il base è il PRIMO livello a 0 punti della lista
   esistente (fidelity_levels_base_key, es. 'bronze' dalla migrazione legacy
   Bronze/Silver/Gold) — prima era hardcoded 'base' (un tenant migrato avrebbe
   avuto un doppio base e il bronze trattato come eliminabile); nome base
   preservato, punti forzati a 0; guardia verbatim 'Solo il livello base
   predefinito puo avere 0 punti.' (prima assente, cadeva nel messaggio
   sbagliato dei punti duplicati); punti normalizzati col troncamento intero
   legacy (normalizePoints) + clamp 0..100000000.
2. CONFERMA FIRMATA SOGLIE (prima assente): modifiche ai punti necessari dei
   livelli esistenti richiedono fidelity_threshold_change_confirmed = sha256
   delle modifiche (preview -> firma -> save), guardia 'Conferma prima la
   modifica dei punti necessari dal popup.'; nuovo endpoint preview con
   changes/firma, clienti ricalcolati (aderenti, salgono/scendono/invariati) e
   regole collegate (campagne/promozioni/omaggi/giftbox eligible+required_level
   /prenotazioni aperte).
3. ELIMINAZIONE PER-KEY: conferma 'points:KEY' per OGNI livello eliminato
   (prima un flag unico) con guardia verbatim col NOME ('Conferma prima
   l'eliminazione del livello a punti "Gold".'); nuovo endpoint preview
   impatto (clienti che perdono il livello + livello di destinazione,
   campagne/promozioni/omaggi aggiornati o disattivati, prenotazioni aperte)
   SENZA scritture.
4. CASCATA FEDELE: token 'family:key' parsati (prima match esatto che mancava
   'points:gold' nei target promozione), righe SVUOTATE solo disattivate senza
   riscrivere la lista (prima scriveva '[]'), target promozione ri-prefissati
   'points:' sui restanti, omaggi filtrati eligibility='fidelity_only' (prima
   tutti) + compat regole legacy gift_rules.target_level_key (disattivazione),
   prenotazioni aperte ripulite per TUTTE le promozioni toccate con la logica
   centralizzata Promotions (prezzi riga ripristinati, note 'Promozione:'
   rimosse, redemption aperte eliminate — prima un UPDATE secco solo sulle
   disattivate), updated_by sui cleanup.
5. TOGGLE-DISABLE (prima assente): guardie 'Conferma prima la disattivazione
   dei Livelli Card dal popup.' / '...dei livelli card a punti dal popup.'
   (token all/points); alla disattivazione i collegati vengono SOLO disattivati
   (liste intatte) con la seconda frase di stats nel messaggio; lista livelli
   preservata nel JSON con points_enabled=0; renewal non forzato.
6. MESSAGGIO COMPOSTO legacy con entrambe le frasi ('Livelli Card salvati' +
   'N promozioni aggiornate/disattivate, N campagne omaggio ..., N campagne
   punti ..., N prenotazioni aggiornate.'), guardia globale off ('Attiva prima
   la Fidelity per configurare i livelli card.'), ricalcolo livelli di TUTTI i
   clienti con UPDATE incondizionato (azzera i residui quando spento — prima
   skippava la scrittura), errore col prefisso flash 'Errore salvataggio
   livelli card: '.
7. EDITOR RIFATTO sul JS legacy: hint d'uso per riga ('N clienti hanno questo
   livello. Se cambi i punti, ti verra richiesto un riepilogo...') dai conteggi
   server (calcClientLevelPoints con fallback fidelity_level), label punti
   configurabile nell'input-group, validazioni client verbatim, modal 'Elimina
   livello card' con accordion impatto e 'Rimuovi livello' (token accumulati),
   modal 'Modifica livello card' con soglie X -> Y (toLocaleString it-IT come
   il JS), 'Conferma e salva' con firma, righe nuove rimosse senza preview;
   successo/errore via redirect flash su fidelity_points; GET editor esteso
   (levels+baseKey+usage+label); /fidelity_levels ora REDIRIGE a
   fidelity_points portando ?msg/?err (la pagina standalone non esiste nel
   legacy); array postati come stringhe JSON (parseRequestBody appiattisce gli
   array in CSV).
GIA FEDELI: dedup key _N, sort per punti, nome cap 50/key cap 64, formato JSON
{"format":"split",...} (confermato identico al live), righe base senza bottone
rimozione.
RESIDUI DELIBERATI: normalizeFidelityPoints condiviso usa Math.round (legacy
trunc) fuori dal perimetro livelli; il sample di clienti nel preview soglie
(max 8, non renderizzato dal JS legacy) non è popolato.
Verifica: battery e2e 31/31 (migrazione+baseKey bronze, guardie verbatim,
preview soglie con firma e cliente che scende, save con firma + ricalcolo
cliente, preview delete senza scritture, cascata completa con messaggio
composto e liste intatte, toggle-disable con guardie+stats+lista preservata+
livelli azzerati, ripristino businesses e zero residui) + confronto LIVE PHP
(msg/err flash identici incl. prefisso, JSON persistito identico) + 58/58
marker bundle + regressione Punti 42/42 + redirect /fidelity_levels 307 con
flash + typecheck/lint puliti.

## Ricariche (recharges.php) — 2026-07-05
AUDIT COMPLETO della pagina Ricariche (535 righe: CRUD modelli di ricarica +
handler dormienti) + recharges.js (100 righe: confirm eliminazione, modal
prefill, bonus none) vs manage-recharges.ts/RechargesContent. FIX PRINCIPALI:
1. FLASH LEGACY mancanti: successo via redirect ?msg ('Modello creato.',
   'Modello aggiornato.', 'Modello eliminato.') con branch page.tsx e alert
   View::alert — prima la modal si chiudeva in silenzio senza alcun messaggio;
   gli ERRORI del POST ora chiudono la modal e vanno nell'alert danger a
   inizio pagina (il POST full-page legacy renderizza $err in alto), prima
   erano dentro la modal.
2. MESSAGGI verbatim confermati 1:1 col PHP live: massimali con fmt_money
   ('Importo ricarica troppo alto. Massimo 99.999.999,99.', 'Valore bonus
   troppo alto. ...', 'Totale credito troppo alto. ...' — prima senza coda),
   update con id non valido 'Modello non valido.' (prima un id 0 su
   update_template CREAVA un nuovo modello!) e id inesistente 'Modello non
   trovato.'; confirm eliminazione del JS legacy 'Eliminare il modello:
   TITOLO?' (prima 'Eliminare il modello "TITOLO"?').
3. parse importi col $nfloat legacy (virgola->punto naive, round 2 — prima un
   parser "intelligente" delle migliaia non legacy); formati tabella con i
   port fmt_money (punto migliaia/virgola decimali, trappola toLocaleString
   1000-9999) e fmt_points per il bonus percentuale (troncamento intero);
   prefill modal edit con importi a 2 decimali come i data-* legacy.
4. Modal fedele al JS: cambio bonus a 'none' DISABILITA E AZZERA il valore
   (prima manteneva il vecchio); avviso earn_points con Fidelity off verbatim
   ('Disponibile solo con la Fidelity generale attiva. Con Fidelity
   disattivata i nuovi modelli non possono attivare questa opzione.' — prima
   assente); etichetta punti dinamica ($fidLabel) nel help e nell'info box;
   markup hidden/_mode/id legacy; value="1" sulle checkbox.
5. Header: campagna attiva oggi con la selezione di Fidelity::campaignForDate
   (ordine legacy via listFidelityCampaigns) e fallback nome 'Campagna punti';
   stub create_recharge portato ('Le ricariche credito si registrano dalla
   pagina Pagamenti.').
GIA FEDELI: tabella modelli (colonne, riga table-light + 'Disattivo',
'Importo + bonus'/'Solo importo', 'Nessun modello.'), ordinamento is_active
DESC/sort_order ASC/id DESC, cap titolo 120/sort ±1000000, earn_points gated
dalla Fidelity generale (create forzato 0, update mantiene l'esistente),
info box, permesso fidelity.recharges.
RESIDUI DELIBERATI: void_recharge non portato — nel legacy NESSUNA UI posta
quel _mode (handler raggiungibile solo con POST manuale; lo storno ricariche
del flusso reale è già coperto dal void vendita di Pagamenti,
reverseIssuedSaleRecharges); la card 'DB non aggiornato' senza tabelle non è
portata (schema Next completo); il ramo header 'Step attuale: 1 Punti ogni
€ X' è irraggiungibile (compare solo senza schema campagne).
Verifica: battery e2e 23/23 (contesto, 5 guardie verbatim coi massimali,
create con calcoli percent/fixed, parse virgola + bonus none azzerato, update
guardie+ok, ordinamento lista, earn_points con Fidelity off su create/update,
header campagna attiva/spenta, stub create_recharge, delete, ripristino
businesses e zero residui) + confronto LIVE PHP (flash msg e testi errore
identici, incl. 'Modello non valido./non trovato.' e massimali) + 63/63
marker bundle + typecheck/lint puliti.

## Portafoglio — SECONDA PASSATA di verifica (fidelity_wallet.php) — 2026-07-05
Ri-audit completo su richiesta: riletto l'intero legacy (1288 righe + js) e
riconfrontato riga per riga col port F5 (commit a951253). BASELINE CONFERMATA:
battery e2e 29/29 e 72/72 marker ancora verdi prima dei ritocchi. Verificati
fedeli: guardie POST disabilitato coi due messaggi accentati ('Fidelity è
disattivata...' / 'Punti Fidelity sono disattivati...'), stati disabilitati
early-return con header 'Portafoglio'->wallet e alert-info variantati, tutte
le guardie del movimento manuale (intero>=1, cliente, adesione tessera, i TRE
errori di rimozione con e senza warn_locked, code successo '. N non rimossi
perché prenotati... N non rimossi per saldo insufficiente.', warn_locked anche
sul redirect di successo), clamp remove su liberi=saldo-prenotati, kind
adjust/manual, alert warn_locked con tabella prenotazioni (Data/Stato/Sconto/
gift/Totale/Codice/Apri) e 'Nessun appuntamento trovato.', KPI 4 card,
'Disponibile negativo', 'Punti già scaduti (cron non eseguito)', 'scaduti ma
vincolati' con link #points-pending, calendario per giorno con badge
'vincolati'/righe table-info/table-warning/'ore HH:MM'/'Vincolati su:'+title/
'Da rimuovere (cron):'/'Prossima scadenza:', movimenti con badge kind/
'scadenza'/'kind • source #id'/paginazione che preserva p_pending, punti in
sospeso con badge riepilogo e paginazione che preserva p, lista clienti con
paginazione p_list e nota footer, filtro combobox, form Operazione manuale.
DUE RITOCCHI TROVATI E APPLICATI:
1. La nota sotto 'Operazione manuale' ('La scadenza dei punti viene calcolata
   dalla data del movimento/accredito: N giorni, con validità fino alle
   23:59...') nel legacy viene dalle impostazioni GLOBALI e compare anche
   SENZA cliente selezionato; il Next la legava a detail (solo con cliente).
   Ora expireEnabled/expireDays sono esposti a livello wallet.
2. Etichetta punti DINAMICA ($s['label'], businesses.fidelity_points_label):
   era la costante 'Punti' sia nel componente sia nei messaggi del movimento
   manuale ('Impossibile rimuovere N {label}...', 'Aggiunti/Rimossi N
   {label}', code non-rimossi) — ora letta dal DB con fallback 'Punti'
   (per il tenant il rendering resta identico).
NON-GAP verificati: la colonna Sede di 'Punti in sospeso' è condizionale nel
legacy solo per compat colonna (schema Next completo -> sempre presente come
sul live); l'alert 'Fidelity disattivata' a riga 724 del legacy è codice morto
(irraggiungibile dopo l'early-return); la select nascosta client_id_legacy è
markup inerte.
Verifica: payload wallet con expireEnabled/expireDays/label senza cliente +
battery e2e 29/29 + 72/72 marker rieseguiti dopo i ritocchi + typecheck/lint
puliti.
