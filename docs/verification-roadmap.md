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

## Divergenze intenzionali documentate (non bug)
- Redeem consumati alla CREAZIONE appuntamento (modello prenotazione, più sicuro;
  legacy consuma al "done") — approvato.
- Promozioni: applicazione con click esplicito "Rileva" (legacy auto-applica).
- point_lots/scadenza punti non scritti (subsystem dormiente anche di fatto nel legacy).
- Allegati (costi/magazzino/schede/foto) rinviati a infra S3.
- PDF preventivi/GDPR + email voucher rinviati (infra SES).
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
