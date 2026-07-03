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
