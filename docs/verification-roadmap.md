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
1. **Promozioni nel drawer** (il più grosso): auto-rilevamento promo nel
   pannello prezzi (promotion_preview) + persistenza server-side al save dei
   prezzi scontati per servizio con regole di stacking (coupon/fidelity
   conflict_policy). L'engine di valutazione esiste già (Block 3, action=
   evaluate): manca il wiring drawer + il blocco promo del save legacy
   (api_appointments.php:9914 in poi).
2. **fidelity_gift_redeem + conflict_policy radios** nel drawer (riscatto
   premi fidelity; legato al punto 1 per i conflitti promo/punti).
3. **swap_segment**: child-rows segmenti + frecce riordino nella lista
   appuntamenti Next.
4. **Cabine nel drawer (solo UI)**: select cabina filtrata sulle LIBERE
   (legacy refreshCabinsForServices); oggi il Next mostra tutte quelle della
   sede e il server valida al save (esito corretto, UX meno guidata).
5. **Hold: cabin_ids_json** — il Next riserva la cabina di default del
   servizio; il legacy auto-sceglie una cabina LIBERA dalla lista allowed.
   Con 1 cabina per servizio (dato reale attuale) identico; divergenza solo
   con pool di cabine condivise.

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
