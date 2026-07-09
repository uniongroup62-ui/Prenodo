# Roadmap di verifica migrazione PHP → Next (2026-07-02)

## Accesso-per-sede: chiusi i 7 GAP DI FEDELTA' (2026-07-08)

Implementati i 7 gap di fedelta' della mappa accesso-sede (dove il PHP GIA' restringe e il Next no o
parziale). Helper condivisi in `lib/manage-locations.ts`: `sessionAllowedLocationIds(session)` ([] =
admin/tutte le sedi), `locationAllowedForSedi(loc, allowed)`, `assertLocationAccessById(slug, table,
id, allowed, msg)` (record con location_id diretta), `assertLocationAccessViaParent(...)` (sede
ereditata dal padre, es. preordine=sale_item -> sales). Moduli chiusi:
- **appointments**: guardia `appointmentLocationAllowedForUser` aggiunta su GET `action=get`,
  `cancel_done`, `swap_segment` (prima solo su edit/delete/status/move).
- **quotes**: guardia su `convert` (era l'unico buco).
- **installments**: `createDbInstallmentPlan`/`cancelDbInstallmentPlan` accettano `scopeLocationId`
  (via la vendita padre), coerente con mark_paid/pending; cancel_plan e create ora scoped.
- **packages**: guardia record `client_packages` su view/client_get/use/update_expiry/usage_add/
  client_save ("Pacchetto cliente non disponibile per la sede selezionata.").
- **preorders**: guardia su `collect` (via `sale_items` -> `sales.location_id`).
- **stock-doc-attachment**: guardia su download/upload/remove (`stock_docs.location_id`) -> 404
  "File non trovato".
- **products**: guardia su `stock_doc_cancel` (annullo documento di altra sede) + `move_stock`
  (registrazione in una sede non propria).
Semantica: admin o `locationIds` vuoto = nessuna restrizione (invariato). Verificato live: 16 check
(test-sede-guards: op(Sede1) NEGATO su ogni record Sede2, admin/Sede1 OK, record intatti dopo i
tentativi) + regressione magazzino 41/41 (flusso admin invariato), typecheck 0, 5 clienti reali intatti.
Restano gli 8 ENHANCEMENT (coupons/promotions/resources/giftcard/giftbox/gift/commissions/fidelity) —
il PHP non li restringe, opzionali (vedi mappa in cima all'audit precedente).

## Accesso-per-sede: chiusi anche gli 8 ENHANCEMENT (2026-07-08)

Completata la copertura: aggiunta la guardia accesso-record per-sede anche dove il PHP NON restringe
(enhancement, come i Clienti). Nuovo helper `assertLocationAccessByJunction(slug, junctionTable,
fkColumn, id, allowed, msg)` per le entita' con sedi via tabella di giunzione (accessibile se ha una
riga in una sede consentita OPPURE nessuna riga = tutte le sedi). Moduli:
- **fidelity**: guardia sul CLIENTE (riuso `assertClientAccessibleForSedi`) su credit_debit, wallet_move,
  card_create, movimento default, GET wallet/credit.
- **commissions**: `markDbCommissionPaid` (route pay) via `staff_commission_payments.location_id`;
  `markCommissionEntryPaid` (toggle) accetta `allowedLocationIds` e verifica la location dell'entry.
- **giftcards / giftboxes / gifts**: guardia istanze via location_id diretta (`giftcards`,
  `giftbox_instances`, `gift_instances`) su view/detail + tutte le mutazioni per-id (blocco unico per
  route). NB: location_id istanza spesso NULL (valorizzato solo al riscatto/POS) -> NULL = accessibile.
- **coupons / promotions**: junction `coupon_locations`/`promotion_locations` su get/save(edit)/delete/
  cancel(coupon) e get/toggle/delete/save(promo).
- **resources**: cabine via `cabins.location_id` (diretta) + staff via `staff_locations` + risorse via
  `resource_locations` (junction), su get/save/delete di ciascuna sotto-entita'.
Semantica invariata: admin/`locationIds` vuoto = tutte le sedi. Verificato live: 18 check
(test-enh-guards: op(Sede1) NEGATO su ogni record Sede2, admin OK, entita' senza-sede accessibile,
record intatti) + regressione buoni 33/33, commissioni 30/30, sede-guards 16/16, typecheck 0, 5 clienti
reali intatti. COPERTURA COMPLETA: tutti i moduli con record per-sede ora bloccano l'accesso cross-sede.

## MAPPA accesso-per-sede: dove serve la guardia record (audit completo 2026-07-08)

Dopo l'aggiunta della guardia per-sede sui Clienti (`assertClientAccessibleForSedi`), audit completo
(1 agente legacy + 6 agenti Next) di TUTTI i moduli manage per mappare dove un operatore ristretto a
un sottoinsieme di sedi puo' ancora accedere a record di ALTRE sedi via id diretto. Funzione-cardine
legacy: `app_location_allowed_for_user(loc,user)` = loc ∈ sedi utente (admin=tutte). Regola record:
location_id NULL/0 = accessibile a tutti; altrimenti deve essere in una sede consentita (o attivita').

STATO PER MODULO (record per-sede | lista scoped alle sedi utente | guardia accesso record | legacy):
- **GIA' OK (ENFORCED)**: clients (fatto), costs, cost-attachment, pos/sales (il piu' completo:
  `assertSaleLocationAccess` su dettaglio + tutte le mutazioni).
- **GAP DI FEDELTA' (il PHP restringe, il Next NO o parziale)** — priorita' ALTA:
  - appointments: guardia su edit/delete/status/move OK, ma MANCA su GET `action=get` (dettaglio),
    `cancel_done`, `swap_segment`.
  - quotes: guardia su view/edit/delete/pdf/send OK, ma MANCA su `convert` (converti in vendita).
  - installments (rate): guardia su mark_paid/pending OK, ma MANCA su `cancel_plan` e `create`.
  - packages (pacchetti CLIENTE, `client_packages.location_id`): il PHP restringe use/edit/delete;
    il Next e' solo LIST-ONLY -> nessuna guardia record.
  - preorders (preordini): il PHP restringe (pos_preorders); il Next `collect` non guardato.
  - stock-doc-attachment: il PHP blocca il download dell'allegato di un doc magazzino di altra sede;
    il Next NON legge nemmeno `stock_docs.location_id` -> download/replace/delete cross-sede.
  - products/stock_docs: `cancelStockDocument`/`saveStockMovement` non verificano la sede del documento.
- **ENHANCEMENT (il PHP NON restringe l'accesso-record per sede; guardia = extra come i clienti)** —
  priorita' MEDIA/opzionale: coupons (LIST-ONLY, per-sede via coupon_locations), promotions (NONE,
  per-sede via promotion_locations, nessuno scoping lista), resources/cabine/staff (LIST-ONLY debole:
  sede attiva scelta liberamente tra tutte le sedi, nessuna guardia record), giftcards/giftboxes
  (istanze con location_id, LIST-ONLY), gifts (istanze con location_id, nessuno scoping), commissions
  (mark-paid per id senza check; lista solo filtro utente), fidelity (wallet/credito/tessere per
  client_id senza check).
- **N/A (tenant-wide per design, nessun location_id)**: prepaids, recharge templates, catalogo
  packages, template gift/giftbox, definizioni promozioni/coupon, note calendario, definizioni fidelity,
  catalogo prodotti.

Pattern gia' presenti nel Next da standardizzare: `assertSaleLocationAccess` (pos), `assertClient
AccessibleForSedi` (clients), `appointmentLocationAllowedForUser`, `quoteUserCanAccess`, `getCostById`
scoping. Raccomandato: un helper unico `assertLocationAccessById(slug, table, id, allowedLocationIds)`
per i record con `location_id` diretto. Decisione scope implementazione: da concordare con l'utente.

## Clienti: audit + fix tag case-insensitive + validazione data-calendario (2026-07-08)

Audit dedicato Clienti/anagrafica (clients.php 3897 vs Next clients/route.ts + db-repositories client
fns + componenti) con 2 agenti. VERDETTO: port largamente fedele — campi (full_name derivato da
first+last, phone/email, gender M/F, birth_date/birth_place, registration_date def oggi, indirizzo
completo, job_title=professione, company/vat/tax/sdi/pec, notes, location_id; NO source/marketing/
lingua come il legacy), validazioni verbatim ("Nome e cognome obbligatori", "Email/PEC non valida.",
"Seleziona una sede valida."), NESSUNA unicita' phone/email (duplicati ammessi come il legacy),
block/unblock (nota interna OBBLIGATORIA), delete HARD a cascata (~20 tabelle, motivazione + conferma
"ELIMINA", stock_restore_mode, log, riepilogo ~33 contatori), listing (ILIKE full_name/phone/email/
phone_home/phone2, sede, created_at DESC LIMIT 200), tag M:N. Verificato live: 24 check (test-clienti,
5 clienti reali intatti). Fix applicati:
- **Tag find-or-create CASE-INSENSITIVE**: `addManageClientTag` cercava il tag con `name=?` (Postgres
  case-sensitive) mentre `customer_tags` ha UNIQUE(tenant_id,name) MySQL general_ci (case-insensitive)
  -> il Next creava "VIP" e "vip" come tag DISTINTI (il legacy ne riusa uno). FIX: `LOWER(name)=
  LOWER(?)` (riusa il tag esistente con la sua grafia). Stessa classe del fix Fornitori.
- **Validazione DATA-CALENDARIO**: la validazione date (birth_date/registration_date) usava solo il
  regex `^\d{4}-\d{2}-\d{2}$` -> "2020-99-99" passava e il cliente veniva creato con la data nulled in
  SILENZIO, invece del messaggio legacy. Il legacy normalize_date usa regex + checkdate. FIX: aggiunto
  `isValidClientCalendarDate` (regex + esistenza calendario) -> "2020-99-99" ora rifiutato con "Data
  di nascita/iscrizione non valida." come il legacy.
Divergenze deliberate/note (NON fixate): unblock azzera blocked_at/blocked_internal_note (il legacy li
lascia come storico — Next piu' pulito); action `archive` = alias di block con nota fissa, NON usato
dalla UI (residuo); email validata via regex Next vs FILTER_VALIDATE_EMAIL PHP (equivalente sui casi
comuni).
CORREZIONE (2026-07-08, verifica sul codice legacy REALE): l'accesso per-SEDE su edit/delete/detail
NON e' una divergenza. Il legacy `client_can_access_id` -> `app_client_accessible` (Helpers.php
1139-1150) fa SOLO `SELECT 1 FROM clients WHERE id=?` (esistenza nel tenant, ignora location_id):
il PHP NON restringe modifica/eliminazione per sede. Quindi il Next tenant-scoped e' FEDELE.
L'unica vera (minore) divergenza sede e' nella LISTA: il Next `legacyList` filtra `location_id = ?`
(stretto) mentre il legacy `app_client_location_access_where('c',[sede],false)` include anche i clienti
con attivita' (appuntamenti/vendite/preventivi) in quella sede -> il Next mostra MENO clienti del PHP
nella lista filtrata per sede (residuo minore non toccato).

ENHANCEMENT applicato (scelta utente 2026-07-08 — funzione IN PIU' rispetto al PHP, non fedelta'):
su richiesta esplicita e' stata AGGIUNTA una restrizione per-sede su modifica/eliminazione cliente
che il PHP NON ha. `assertClientAccessibleForSedi(slug, clientId, allowedLocationIds)` (db-repositories)
riusa la logica del filtro-sede legacy (location_id ∈ sedi utente OR senza sede NULL/0 OR attivita'
appuntamenti/vendite/preventivi in quelle sedi) ed e' invocata dalla route su get/detail/history/
delete_summary (GET) e update/archive/block/unblock/add_tag/remove_tag/delete (POST). Un operatore
NON admin con `locationIds` ristretto non puo' aprire/modificare/eliminare clienti di altre sedi ->
"Cliente non trovato o non disponibile per le tue sedi." (403). Admin o `locationIds` vuoto = tutte le
sedi, nessuna restrizione (comportamento invariato). `create` (nuovo cliente) escluso. La LISTA resta
gia' filtrata per sede. Verificato live: 18 check (test-clienti-sede: admin vede tutto; op(Sede1) ok su
Sede1/NoSede/Sede2-con-attivita', NEGATO su Sede2; dati intatti dopo i tentativi) + regressione 24
(test-clienti, sessione admin invariata).


## Buoni (Coupon): audit — port FEDELE, nessun fix necessario (2026-07-08)

Audit dedicato di "Buoni" (= modulo Coupon; legacy coupons.php 1253 + Helpers.php coupon_*; Next
lib/db-repositories.ts funzioni coupon + coupons/route.ts + coupon_form/coupons-content) con 2 agenti.
VERDETTO: **port fedele su tutta la linea, nessun bug reale trovato.** Verificato live: 33 check
(test-buoni). Aree confermate 1:1:
- **Campi**: code, description, discount_type(percent|fixed), discount_value, min_subtotal, valid_from/
  valid_to, is_active, usage_limit (= limite PER-CLIENTE, 0=illim.), apply_scope + *_ids_json, coupon_
  locations(M:N), created/cancelled/deleted audit. NESSUN client_id/max_discount/used_count/stackable
  (identico al legacy; l'uso e' calcolato a runtime).
- **Validazioni verbatim**: "Inserisci un codice.", "Codice non valido. Usa solo lettere, numeri, - e
  _. (Max 40)" (regex ^[A-Z0-9][A-Z0-9_-]{0,39}$), "Inserisci un valore valido.", percent cap 100,
  "Formato data non valido.", ordine date, "Seleziona almeno una sede abilitata." + scope-specifici,
  unicita' su coupons ("Esiste gia un coupon...") E su promotions ("...gia utilizzato da una
  Promozione..."), codice IMMUTABILE in edit.
- **Generazione codice**: charset ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/1/I/L/O), 10 char, 50 tentativi
  unici vs coupons+promotions, fallback rand(12).
- **Formula sconto**: percent = eligibleSubtotal×value/100, fixed = value; floor 0; cap eligible poi
  subtotal; NESSUN max_discount; spesa minima su minimumBase (subtotal se scope=all, altrimenti
  eligible); eligibleSubtotal per apply_scope.
- **Validita' riscatto**: "Coupon disattivato." / "Coupon scaduto per la data selezionata." / "Coupon
  non ancora attivo..." / "Seleziona un cliente per usare questo coupon." / "Limite di utilizzo per
  cliente raggiunto (N/M)." — limite conteggiato a runtime da sales.coupon_code + marker note
  "Coupon: CODE" (UPPER(...) LIKE, case-insensitive) su sales+appointments, esclusi annullati.
- **Cancel/Delete cascata**: cancel = is_active=0 + cancelled_* ("Coupon gia disattivato." se off);
  delete = blocca se prenotazioni aperte -> soft-delete (deleted_at) se usato -> hard-delete +
  coupon_locations se mai usato. Badge Attiva/Programmato/Scaduto/Disattivato. Listing esclude
  soft-deleted, ORDER BY id DESC.
- **Scope tenant + sede** (coupon_locations, [] = tutte le sedi).
Divergenze deliberate/innocue (NON bug): endpoint `create` quick-create Next-specifico (usage_limit
def 100, valid_to +30gg, description=code) NON usato dal form (che usa `save` fedele) ne' dal POS;
messaggio preview "Nessun servizio/prodotto selezionato rientra..." vs legacy "...del carrello..."
(equivalente). Il POS Next non crea buoni via API (applica coupon esistenti scrivendo coupon_code +
marker note), a differenza della bozza-Buono legacy a chiusura vendita.


## Fornitori: audit + fix univocita' nome case-insensitive (2026-07-08)

Audit dedicato Fornitori (suppliers.php 865 + Helpers.php app_supplier_*) vs Next (manage-products.ts
saveSupplier/getManageSupplier/deleteSupplier + suppliers-content). VERDETTO: port fedele — campi
(name obblig+univoco, business_name, indirizzi, cap/city/province, country def 'Italia'/ISO 'IT',
vat_number, tax_code, sdi_code, phone/fax/mobile, email, pec, website, is_active Magazzino +
is_active_costs Costi; NO iban/referente/note come il legacy), validazioni verbatim (sede magazzino/
costi obbligatoria se attivo; NESSUNA validazione formato P.IVA/CF/email server-side), rename cascade
su products.supplier_name, sync supplier_locations (warehouse_enabled/costs_enabled per sede, "Tutte"
se nessuna riga), delete-blockers (products.supplier_name + costs.supplier_id -> "Fornitore usato in
prodotti o costi..."), filtri listing q/scope/status/all_locations (client-side, fedeli), conteggi
Prodotti/Costi, scope tenant. Verificato live: 17 check (test-fornitori).
- **FIX univocita' nome CASE-INSENSITIVE**: `ensureSupplierNameAvailable` usava `name=?` (Postgres,
  case-SENSITIVE) mentre il legacy MySQL `utf8mb4_general_ci` e' case-INSENSITIVE -> il Next
  permetteva "Acme" e "acme" come due fornitori distinti che il legacy blocca (e il delete-blocker
  per-nome poteva mancare il ref con case diverso). FIX: `LOWER(name)=LOWER(?)` come il dedup
  categorie. Verificato: 'zzfornFULL' bloccato contro 'ZZFornFull' (nessun secondo record creato).
Non-bug verificati (fedeli): is_active/is_active_costs -> il form invia sempre "1"/"0" esplicito
(disattivazione funziona); filtri listing presenti client-side; sync sedi corretto. Divergenza
deliberata: modello permessi (Next usa `suppliers.manage` unico invece di canSupplierWarehouse/
canSupplierCosts separati del legacy) -> il flag attivo non e' permission-gated per-ruolo.


## Magazzino: audit + fix delete-blockers prodotto (rotti/incompleti) + ordinamento (2026-07-08)

Audit di Magazzino (products.php 1787 + stock_moves.php 1487 + suppliers.php 865 + ProductPageHelpers
1436 + helpers) con 4 agenti. VERDETTO: port largamente fedele — campi prodotto/fornitore/categoria,
validazioni verbatim, giacenza PER-SEDE (product_stocks, rollup SUM su products.stock), carico/scarico
incrementale con guardia non-negativa, rettifica (Next la risolve in carico/scarico via delta),
annullo soft (is_canceled) + storno inverso + recompute incoming dall'ultimo carico attivo, NESSUN
costo medio ponderato (come il legacy), export CSV movimenti, allegati (R2). Fix applicati (verificati
live: 40 check — test-magazzino: categorie 3, fornitori 3, prodotti validazioni+CRUD 8, movimenti 12,
delete-blockers 11+2 negativi, categoria/fornitore block 2):
- **BUG (grave): delete-blockers prodotto rotti/incompleti**. Il DELETE prodotto e' FISICO
  (hard-delete di products + product_images + product_stocks). I blocchi erano:
  - `sale_items/product_id` -> colonna INESISTENTE (sale_items usa `item_id`+`item_type`, non
    `product_id`) -> blocco MORTO (catch->0).
  - `preorders/product_id` -> tabella INESISTENTE in questo schema -> blocco MORTO.
  - `quote_items/item_id` -> senza `item_type='product'` ne' `quotes.status accepted` -> falsi
    positivi (collisione con item_id di servizi) e non fedele.
  - MANCAVANO del tutto: giacenza/in-arrivo, pacchetti cliente attivi, catalogo pacchetti,
    giftbox attive, campagne omaggio (gift), omaggi emessi.
  Rischio: eliminare un prodotto ancora referenziato in un pacchetto/giftbox/gift/preventivo
  attivo orfanizzava i riferimenti. FIX: riscritta `productDeleteBlockers` (port fedele di
  products_delete_blockers, ProductPageHelpers.php:333-777) con 11 blocchi adattati allo schema
  Next e JOIN tenant-scoped: giacenza (products.stock/incoming), stock_doc_items, stock_moves,
  preordini (sale_items item_type=product + item_status ordered/ordinato + vendita non annullata),
  pacchetti cliente attivi (client_packages.status='active'), preventivi accettati (quotes accepted),
  catalogo pacchetti (packages.is_active), giftbox attive (giftboxes.active + deleted_at NULL),
  promozioni attive (promotions.is_active), campagne omaggio (gifts.reward_product_id + active),
  omaggi emessi (gift_instances non riscattate). Verificato: ogni blocco scatta col ref attivo;
  bozza-preventivo ed executed-vendita NON bloccano (filtri di stato corretti); prodotto pulito
  (0 ref, giacenza 0) resta eliminabile.
- **Ordinamento lista prodotti**: era `ORDER BY p.name ASC` -> riportato a `ORDER BY p.id DESC`
  (fedele a products.php:851, piu' recenti in cima).
Divergenze deliberate/innocue (non-bug): `products.is_active` colonna extra sempre 1 (nessun toggle,
legacy non ha stato attivo/inattivo sui prodotti); `rettifica` come tipo UI esplicito (nel DB si
risolve comunque in carico/scarico); listing documenti magazzino `LIMIT 50` vs legacy 10/pagina
(paginazione UI non ancora portata); storage R2 + niente compressione immagini/allegati (scelte di
migrazione). Fornitori/categorie: gia' fedeli (delete-blockers, messaggi, univocita', scope tenant).


## Commissioni: risoluzione operatore POS per EMAIL + fallback appointment_staff (2026-07-08)

Completato l'ULTIMO residuo dell'audit Commissioni (prima "fuori scope"): il meccanismo di
abbinamento vendita→operatore. Verificato live: 15 check (test-operator 8, test-operator-regress 7),
typecheck 0, nessun residuo, 2 righe payments pre-esistenti INTATTE.
- **POS: created_by → users.email → staff.email (era operator_name → staff.full_name)**. Il legacy
  (`Commissions.php:2293-2294` buildPosEntries + `resolveSaleOperator` 2446-2492) risolve l'operatore
  della vendita per EMAIL: `sales.created_by` (utente loggato) → `users.email` → `staff.email`
  (LOWER+TRIM). Il Next confrontava invece la STRINGA `operator_name` col `full_name` normalizzato.
  NON era solo cosmetico: nel tenant reale esistono due staff OMONIMI — #22 'luca' info@artebrand.it
  (user 20) e #56 'Luca' info@vivamed.it (user 52). Il match-per-nome li fondeva (`LOWER('luca')==
  LOWER('Luca')`) → tutte le vendite finivano all'UNICO staff scelto dal tie-break, potenzialmente
  quello SBAGLIATO. L'email è univoca: le 4 vendite reali (`created_by=20`) risolvono correttamente a
  #22. FIX: `buildStaffByUserId(slug, staff)` mappa `users.id → staff` per email (una query
  tenant-scoped su `public.users`); `resolveSaleStaffByUser(created_by, staffByUserId)` sostituisce
  `resolveSaleStaff(operator_name, staffByName)`. Display operatore = `staff.full_name` (poi
  operator_name), fedele a `resolved_operator_name = COALESCE(stop.full_name, s.operator_name, uop.name)`.
  Verificato: SA(created_by 20)→#22, SB(created_by 52)→#56 (staff DIVERSI, impossibile per-nome),
  created_by NULL→nessuna commissione.
- **Appuntamenti: fallback `appointment_staff`**. Il legacy (`Commissions.php:2097-2098,2131-2133`):
  se una prestazione non ha un `appointment_segments.staff_id`, ripiega sul PRIMO `appointment_staff`
  dell'appuntamento. Il Next saltava (nessuna commissione). FIX: caricato `appointment_staff`,
  costruita `fallbackStaffByAppt` (primo staff ordinato), usata quando la coda-segmenti è vuota.
  Verificato: servizio senza segmento ma con appointment_staff→commissione al fallback; senza→niente.
- **Display omonimi in mapPersistedEntry**: la risoluzione del nome per una entry persistita senza
  operator_name ora usa `staffById.get(id)` (lookup esatto) invece di iterare una mappa per-nome che
  poteva aver scartato l'omonimo. Rimossa la mappa `staffByName` e il suo tie-break (superati dall'email).

## Commissioni: audit + fix (bug reali + config + Sede UI + BUG FUSO #16) (2026-07-08)

Audit di Commissioni (Commissions.php 2890 + commissions.php ~900) con 3 agenti. VERDETTO: port
largamente fedele (messaggi verbatim, aggregazione dashboard, mark-paid, snapshot lifecycle, formato
it-IT, isolamento tenant, periodi STAFF del #16). Fix applicati (verificati live: 52 check —
test-comm-fixes 5, test-comm-sede 5, test-commission-periods 4, test-comm-toggles 6, e2e-commissions 32):
- **BUG FUSO periodi (#16, il piu' grave)**: i confini dei periodi commissione erano seminati con
  `businessNowDateTime()` (Europe/Rome) ma il DB e' UTC e `sale_date`/`starts_at` sono in UTC ->
  offset 1-2h -> un movimento creato "adesso" (UTC) risultava PRIMA del periodo appena aperto (Rome)
  -> MAI commissionato. Non emerso nei test #16 (usavano date 2025 manuali). FIX: helper
  `commissionNowUtc()` (UTC) al posto di businessNowDateTime nei 4 punti periodo + nowDateTime.
- **#16 completo — gate periodi MODULO per-movimento**: il legacy buildDashboard NON ha outer guard
  sul flag; gate ogni movimento con isModuleActiveAt (periodi MODULO) E isCommissionActiveAt (staff).
  Il Next aveva solo il gate staff + outer `if moduleEnabled`. FIX: loadCommissionActivity carica i
  periodi modulo, aggiunto `moduleActiveAt`, rimosso l'outer guard (reconcile anche a modulo OFF),
  filtro accrual su ENTRAMBI i gate. Verificato: vendita nel GAP tra periodi modulo NON commissionata.
- **sconto 100% (total=0)**: il netFactor faceva fallback `total>0?total:subtotal` -> con total=0 dava
  netFactor=1 -> commissione sull'intero importo di una vendita a costo zero. FIX: base =
  `commercialNet = max(0, subtotal-discount)` come il legacy (usa discount, non il total col fallback).
  Verificato: sconto 100% -> nessuna commissione.
- **bucket pos_other**: classifyPosItem ora richiede item_id CATALOGO > 0 per product/service;
  altrimenti (item_id=0 free-text, non-catalogo) -> pos_other (pos_other_percent) come il legacy.
- **list_price fallback**: appuntamenti in modalita' list_price con list_price=0 -> ora fallback a price.
- **redemption needle**: allineata al legacy esatto (['pacchetto','giftbox','gift','servizio',
  'giftcard','prepag']) — 'omaggio' rimossa (gli omaggi hanno comunque le FK esplicite).
- **zero-rate auto-disable**: saveCommissionSettings auto-disabilita (is_enabled=0) un operatore con
  TUTTE le % <=0 (port normalizeZeroRateSettings) + chiude il periodo.
- **OMONIMI (tie-break staffByName)**: a parita' di nome vince lo staff ABILITATO (prima "luca"/"Luca"
  -> l'omonimo non configurato rubava la risoluzione). [SUPERATO il 2026-07-08 dal passaggio alla
  risoluzione per EMAIL created_by->users.email->staff.email — vedi entry in cima.]
- **Sede UI**: buildCommissionDashboard ritorna `locations`; il componente ha il dropdown "Tutte le
  sedi"/per-sede (multi-sede) che invia location_id + la colonna "Sede" nel dettaglio.
NON fatti (fuori scope per scelta): [cambio meccanismo risoluzione operatore -> FATTO il 2026-07-08,
vedi entry in cima]; default sede corrente (il Next default = tutte); entry_key appuntamento diverso
(rileva solo migrando snapshot legacy, non accade); atomicita' saveSettings; display "annullate"
(Next piu' corretto del legacy). NB SSO id: l'agente lo segnalava mancante ma is_sso_staff(id) =
staff con full_name='SSO' esatto, gia' coperto dal filtro-nome normalizzato del Next.

## Scadenziario e Costi: audit + fix 2 BLOCKER + parse + 3 minori (2026-07-08)

Audit di "Scadenziario e Costi" (costs.php 2829 righe) con 2 agenti (backend/ricorrenze + UI/form/
allegati/export). VERDETTO: port molto fedele (badge/filtri/colonne/form/categorie/allegati MIME+
size/export CSV+PDF/validazioni tutte verbatim/stats/copia campi ricorrenza/isolamento tenant). Fix
applicati (verificati live: fixes 14/14 + minori 4/4 + e2e-costs 52/0):
- **BLOCKER ricorrenza clamp fine-mese** (manage-costs.ts nextDueDate): `setMonth`/`setFullYear`
  facevano OVERFLOW -> un costo ricorrente mensile/annuale con scadenza 29/30/31 (o 29 feb)
  generava l'occorrenza con data SBAGLIATA (31 gen +1m -> 3 mar invece di 28 feb; 29 feb +1y ->
  1 mar invece di 28 feb). Riscritto: aggiungi i mesi e CLAMPA il giorno all'ultimo del mese
  risultante (port $addMonthsSafe). Verificato 31gen->28feb, 29feb->28feb, 30mag->30giu, 15->15.
- **BLOCKER scope per-sede** (getCostById + getManageCost + saveCost/toggle/delete/bulk + download/
  upload allegato): nessun filtro sede sui fetch-by-id -> su tenant multi-sede un utente ristretto
  poteva GET/toggle/delete/MODIFICARE-SPOSTARE/scaricare-allegato costi di altre sedi. Aggiunto scope
  `(location_id = ? OR location_id IS NULL)` su getCostById (propagato locationId da tutti i
  chiamanti + saveCost scopeLocationId) e su loadCost del cost-attachment; la route risolve la sede
  con resolveManageLocationId. Costo di altra sede -> "Costo non trovato" (come il legacy). Verificato
  Sede1 bloccato / Sede2 consentito su get/toggle/delete/allegato.
- **MAJOR parse importo migliaia** (parseMoneyOrNull): mancava l'euristica migliaia a separatore
  SINGOLO -> "1.234" (=1234 IT) letto 1,23; "1,234,567" -> 1,23. Portato fedelmente $parseMoney
  (separatore + esattamente 3 cifre con parte intera 1-3 = migliaia; multi-sep validato; max 2
  decimali o invalido). Verificato "1.234"->1234, "1,234,567"->1234567, "1.234,56"->1234.56.
- **minore colore categoria**: listCostCategories iniettava "#0f766e" su colore NULL -> badge
  colorato invece di "—" e edit inline #0f766e invece di #6c757d. Ora ritorna "" (la UI gia'
  gestisce vuoto: badge "—", edit default #6c757d). Verificato.
- **minore flash post-salvataggio**: dopo Salva costo mancava "Costo creato/aggiornato". Ora
  backToList passa ?msg e costs-content lo legge (mount-effect) + ripulisce l'URL.
- **minore download allegato scope-sede**: incluso nel BLOCKER scope (loadCost scoped su GET+POST).
COMPLETAMENTI (2026-07-08, su richiesta "se sono da completare procedi" — verificati live 9/9 +
regressione e2e 52/0):
- **ricerca accent-insensitive**: `unaccent` non c'e' ma uso `translate()` (folding vocali/consonanti
  accentate IT) su colonna + termine -> "societa" trova "società" (come utf8_general_ci legacy).
- **fuso TODAY**: `todayIso()` e il default periodo ora usano `businessTodayIso()` (Europe/Rome)
  invece del fuso server -> stato scaduto/da-pagare e filtri open/overdue corretti a mezzanotte IT.
- **fornitore inattivo in modifica**: `getManageCost` recupera il `supplierName` (getCostById fa
  SELECT * senza JOIN) e il form aggiunge l'opzione "Nome (non attivo o non abilitato)" se il
  fornitore del costo non e' tra quelli elencati (port legacy).
- **"Tutte le sedi" (all_locations)**: checkbox nella barra filtri (multi-sede); getManageCostsContext
  con allLocations=true -> locationId=0 -> buildLocationScope scopa a IN(sedi permesse) OR NULL;
  le mutazioni (toggle/delete/bulk/save/get) ricevono `allowedIds` (sedi permesse) cosi' in modalita'
  "tutte" un costo visibile e' anche gestibile; getCostById supporta la modalita' allowedIds.
- **MIME sniffing upload allegato** (FATTO): la route cost-attachment ora determina il tipo dai
  MAGIC BYTES del contenuto (%PDF -> application/pdf; FF D8 FF -> image/jpeg) invece di fidarsi del
  Content-Type dichiarato dal browser (port di app_detect_file_mime). Un file rinominato/non valido
  viene rifiutato "Formato non supportato (solo PDF o JPG)"; un file valido con tipo dichiarato
  errato viene comunque accettato col MIME reale. Verificato 5/5. Non resta nulla di rinviato.


## Gestione Rate: audit + fix 2 MAJOR + 2 minori (2026-07-08)

Audit della pagina "Gestione Rate" (installments_manage.php) con 2 agenti paralleli (pagina UI +
logica backend). VERDETTO: port largamente FEDELE — stati (Scaduto/overdueCount/Scaduta), badge
VERBATIM (planStatusMeta + installmentStatusMeta), effetti mark_paid/mark_pending, filtri
searchPlans + ORDER BY, stati sintetici (Aperte/Scadute/Completate), stats, fuso orario risolto
(businessTodayIso). Fix applicati (verificati live 10/10 + e2e-installments-manage 37 OK):
- **#1 MAJOR metodo pagamento vuoto**: `mapInstallmentPlan` restituiva `paymentType` gia'
  convertito in LABEL ("Carta di Credito"), ma la UI lo tratta come CHIAVE (payLabel(), value
  della select) -> payLabel(label) non matchava -> KPI "Pagamento" e metodo dell'acconto VUOTI +
  select rata pending non pre-selezionata. FIX: il mapper ora ritorna la CHIAVE grezza
  (cash/card/check/bank) come mapInstallment (db-repositories.ts:21071). Consumato solo dalla
  pagina Rate (il config piano del POS e il dettaglio vendita usano oggetti/campi diversi).
- **#2 MAJOR scope sede assente** (autorizzazione intra-tenant): searchDbInstallmentPlans e
  mark_paid/mark_pending non filtravano per sede -> su tenant multi-sede un utente ristretto a
  Sede A vedeva E incassava rate di Sede B (unica route manage senza scope; le altre 26 lo hanno).
  FIX: `InstallmentPlanSearchFilters.locationId` + IN-subquery non correlata su sales.location_id
  (NULL-permissiva come listPosSales) in searchDbInstallmentPlans; `installmentRow(…, locationId)`
  con lo stesso filtro (row assente -> "Rata non trovata" come il legacy locationScopeSql); la
  route GET/POST risolve la sede con resolveManageLocationId (fallbackCurrent). Verificato: Sede51
  vede/incassa, Sede21 no ("Rata non trovata"); currentLocationId=0 (admin multi-sede) -> nessuno
  scope (vede tutto), coerente col resto del Next.
- **minore updated_by su incasso**: refreshInstallmentPlanStatus ora riceve userId anche su
  mark_paid (prima solo su mark_pending) -> plan.updated_by aggiornato come il legacy.
- **minore formato it-IT**: fmtMoney del componente ora usa un formatter MANUALE (raggruppa sempre
  le migliaia, fedele a number_format) invece di toLocaleString (trappola 1000-9999).
- **bug FILTRO DATE (due_from/due_to) SISTEMATO**: l'EXISTS in searchDbInstallmentPlans usava
  `i.plan_id = p.id` ma tenantSelect NON aliasa la tabella esterna -> `p` inesistente -> query in
  ERRORE ogni volta che si filtrava per data. Riscritto come IN-subquery NON correlata
  (`id IN (SELECT plan_id FROM sale_installments WHERE tenant AND due_date >= ? AND <= ?)`),
  tenant-scoped. Verificato: filtro data sulle rate future ritorna i piani giusti; range vuoto ->
  nessun piano (niente errore).
VERIFICA COMPLETA (2026-07-08, 68 check totali, 0 fail): test-rate-fixes 10/10 (paymentType/scope
sede/updated_by/formato), test-rate-full 15/15 (filtri stato open/overdue/paid/cancelled/all +
filtro date + client/sale/q + campi/stati piani), e2e-installments-manage 43/43 (create via
checkout, GET campi/filtri, guardie incasso importo/data/tipo/not-found, incasso + re-incasso
idempotente, completamento, riapertura, annullo->cancelled con nota standard + rata [ANNULLATA],
guardie su annullata, badge). Cleanup CLEAN.
NON fatti (residui deliberati): reset filtri post-azione (il Next preserva i filtri, comportamento
difendibile); deep-link ?plan_id fuori dal filtro corrente (edge); flash lista non filtrata nella
risposta POST (transiente, la UI ri-fetcha scoped); stato "tabelle rateizzazione mancanti" (non
riproducibile su Supabase).


## Pagamenti AUDIT-2 batch 6: #16 periodi commissione (gate attività) (2026-07-07)

Il motore commissioni Next accumulava su TUTTE le vendite/appuntamenti nel range ignorando le
finestre attive per operatore → commissioni calcolate anche su periodi in cui l'operatore era
DISATTIVATO. Il legacy commissiona un movimento solo se il suo datetime cade in un PERIODO
APERTO dell'operatore (isCommissionActiveAt, Commissions.php:2156/2361). Le tabelle
staff_commission_periods / _module_periods ESISTEVANO ma erano VUOTE (Next non le scriveva).
PORT COMPLETO (manage-commissions.ts):
- bootstrapCommissionModulePeriods / bootstrapCommissionStaffPeriods: seminano il periodo iniziale
  (modulo: epoch 1970 al primo ON → copre lo storico; staff: created_at della config), chiudono
  gli aperti su disabilitato, dedup multi-open.
- synchronizeCommissionStaffPeriod / synchronizeCommissionModulePeriod: apri/chiudi ai TOGGLE
  (wiring in saveCommissionSettings per-staff su transizione is_enabled + setCommissionModuleEnabled).
- loadCommissionActivity + commissionActiveAt: gate PER-MOVIMENTO su SOLI periodi STAFF (fallback
  is_enabled se nessun periodo) — fedele al legacy (i periodi MODULO sono bookkeeping, il gate
  modulo è l'outer "if moduleEnabled"). Applicato come POST-FILTRO sulle ProducedEntry (staffId+
  datetime) in buildCommissionDashboard, PRIMA di syncEntrySnapshots.
VERIFICATO live: **gate 4/4** (staff con P1[gen-giu 2025 chiuso]+P2[ago aperto]: vendita marzo→
commissione €10, vendita LUGLIO nel GAP→NON commissionata, vendita settembre→€10) + **toggle
6/6** (modulo/staff on→periodo aperto, off→chiuso, on→nuovo aperto = GAP). Test con staff a nome
UNIVOCO (la collisione omonimi luca/Luca sul match-per-nome è limite pre-esistente, non di #16).
NON regressivo finché le tabelle erano vuote (fallback is_enabled). Tenant 25 ripristinato
(modulo OFF, 0 periodi/settings, nessun residuo). NB comportamento fedele: il seed staff da
created_at esclude retroattivamente i movimenti pre-configurazione (come il legacy).

### Nota: TRANSAZIONALITÀ checkout/annullo — TENTATA e funzionante ma TROPPO LENTA (revert)
AGGIORNAMENTO (2026-07-08): implementata e VERIFICATA funzionante (atomicità provata: un errore
a metà checkout NON lascia più vendita orfana, test concorrenza stock). Approccio: AsyncLocalStorage
in tenant-db.ts che instrada dbQuery/dbExecute su un client dedicato serializzato, con SAVEPOINT
per-query (necessario perché checkout/annullo usano molte operazioni best-effort `.catch(...)` su
tabelle opzionali: in una tx un singolo errore avvelena l'intera tx, il savepoint isola il fallimento).
PROBLEMA: il checkout è passato da ~1.4s a ~5.7s (4x) — i savepoint TRIPLICANO i round-trip verso
Supabase remoto (~24ms l'uno) e la singola connessione serializza le letture normalmente parallele
(getManagePosContext = 8 liste in Promise.all). 5.7s a vendita è inaccettabile per una cassa →
REVERTATO (checkout torna a ~1.4s). Il gap "vendita orfana su errore raro a metà" resta coperto in
pratica dai PRE-CHECK già committati (stock atomico b3, guardia storno ricarica b1, feasibility punti/
credito) che falliscono PRIMA di mutare. Per un checkout atomico E veloce serve un task dedicato:
split writes-only in tx (letture fuori, parallele) + rendere le ~15 operazioni best-effort tx-safe
SENZA savepoint (guardhandole con tableExists cachato) — stimato ~1.3s. Non fatto: refactor delicato,
non da rushare. Blocco storico sotto (filterColumns concorrente) confermato e risolto dai savepoint,
ma il costo savepoint è il vero collo di bottiglia.

### Nota storica: blocco concreto identificato pre-tentativo
Esiste `withTenantTransaction` (tenant-db.ts) ma attivarla sul checkout richiede o filtrare `q`
in ~15 funzioni, o un context AsyncLocalStorage nel layer DB CORE. Investigazione: checkout/annullo
DIRETTI non hanno Promise.all (mutazioni sequenziali), MA `filterColumns` (usato in tutta la fase
mutazione via insertSaleItem/issue*FromSale) fa `Promise.all(columnExists(...))` = query schema
CONCORRENTI → dentro una tx a client singolo romperebbe con "another query is already in progress"
a CACHE FREDDA (columnExists è cachato → safe a caldo, fragile a freddo); inoltre 34 siti Promise.all
in db-repositories richiedono un audit transitivo esaustivo dell'intero albero di mutazione, fragile
a modifiche future. Il test concorrenza b3 ha confermato il gap reale (checkout perdente → vendita
orfana prima del throw sullo stock). CONCLUSIONE: non è un drop-in sicuro; task DEDICATO con
prerequisito = rendere l'albero mutazione concurrent-query-free (filterColumns sequenziale/prewarm +
audit Promise.all) + regressione app-wide. #8 (errore piano rate → vendita orfana) è entangled: la
vendita è committata prima del piano, senza tx né un-swallow né compensazione sono sicuri.

## Pagamenti AUDIT-2 batch 5: storico #11 filtro data SERVER-SIDE (2026-07-07)

Lo storico Movimenti caricava le 250 vendite piu' recenti e filtrava date/tipo/cliente/servizio
CLIENT-SIDE → una ricerca per data oltre le 250 righe piu' recenti non trovava nulla
(limit-then-filter invece di filter-then-limit come il legacy pos_history). FIX: intervallo data
SERVER-SIDE. listPosSales accetta from/to e aggiunge `sale_date >= from 00:00 AND < to+1g 00:00`
(finestra legacy) PRIMA del LIMIT 250; getManagePosContext e la route GET propagano from/to
(searchParams); la UI pos_history-content li invia e RIFETCHA quando cambiano (useEffect deps).
Gli altri filtri (tipo/cliente/servizio) restano raffinamento client-side sull'insieme in-range;
le sorgenti standalone (basso volume) restano filtrate client-side. VERIFICATO live: vendita del
2025-03-10 compare col range che la copre, esclusa dal range recente (filtro server-side attivo);
regressione checkout 8/8. (La troncatura >250 non e' riproducibile su tenant 25 che ha <250
vendite, ma il filtro gira ora prima del LIMIT per costruzione.)

## Pagamenti AUDIT-2 batch 4b: date/ora ancorate a Europe/Rome (Pagamenti) (2026-07-07)

Il legacy usa date()/DateTimeZone('Europe/Rome'); il Next su Amplify/Lambda gira in UTC, quindi
gli helper "oggi/adesso" sfasavano di un giorno nella finestra serale (23-24 UTC = 01-02 Rome).
Nuovo modulo `lib/business-datetime.ts` (businessTodayIso / businessNowDateTime via
Intl.DateTimeFormat timeZone:'Europe/Rome', con normalizzazione mezzanotte 24->00). Instradati
gli helper in scope PAGAMENTI:
- manage-pos.ts todayIso/nowDateTime (date prepagati, prime scadenze rate, timestamp note).
- db-repositories.ts todayIso (ERA toISOString()=UTC: boundary "oggi/scaduto" rate + data-cutoff
  adesione fedelta').
- manage-commissions.ts nowDateTime (movement_datetime commissioni).
No-op sul dev (gia' TZ italiana), CORRETTO su prod UTC. VERIFICATO: businessTodayIso(23:30 UTC)
= giorno Rome corretto (UTC darebbe il giorno prima); mezzanotte Rome -> "...00:00:00".
Regressione 21/21 (checkout 8, D1 4, report 4, storno 3, giftcard 2).
NON instradati (fuori scope Pagamenti, campagna TZ app-wide separata): appointment-engine,
manage-calendar, gift-issue, manage-costs, manage-products, manage-resources, public-booking
todayIso*, computeExpiry (aritmetica mesi/anni) e fidelity-lots dayStart/dayEnd (toccano la
scadenza punti — da fare con verifica dedicata).

## Pagamenti AUDIT-2 batch 4a: guardie Tier 2 tractabili (2026-07-07)

Due fix puliti dell'audit Tier 2:
- normalizeCommissionPercent (manage-commissions.ts): port fedele di Commissions::normalizePercent
  (797-808) — ora rimuove PRIMA '%' e spazi, poi ','->'.' (input "10%"/"10 %" davano NaN->0,
  ora 10). Typecheck ok.
- #15 promo senza cliente (manage-pos.ts evalPromotionById): una promo con per_customer_limit>0
  su vendita senza cliente ora e' rifiutata con il messaggio verbatim (Promotions.php:5146)
  "Richiede un cliente selezionato per applicare il limite per cliente.". Caso raggiungibile solo
  nel path stretto giftbox-only + promotionId + senza cliente (per servizi/prodotti il cliente e'
  gia' obbligatorio a monte, assertCartExclusivityRules:4208), ma allinea al legacy.
Regressione checkout 8/8.

RESTANTI Tier 2 (piu' grandi/rischiosi, da prioritizzare): #11 storico filter-then-limit
(full-stack UI+API+query), #12 dedup transazioni fedelta' (tocca il ledger wallet), #16 periodi
commissione (staff_commission_periods, complesso), fuso orario Europe/Rome (infra su piu' helper;
sul dev in TZ italiana non e' verificabile a runtime), #9/#10 validazioni rate (cambio di UX:
throw invece di clamp/fallback). Da fare come sotto-batch dedicati con verifica mirata.

## Pagamenti AUDIT-2 batch 3: scarico stock ATOMICO (anti-oversell) (2026-07-07)

`adjustProductStock` faceva read-compute-write (leggeva la giacenza, calcolava next, poi
UPDATE) → NON atomico: due casse concorrenti sullo stesso prodotto/sede leggevano la stessa
giacenza e scrivevano entrambe → OVERSELL. Il legacy usa `app_product_stock_adjust` con
check+decrement atomico ("Hardening: evita oversell in caso di concorrenza"). FIX: decremento
ATOMICO via UPDATE condizionale con il guard nel WHERE (`COALESCE(stock,0)+delta >= -eps`),
sia sul ramo product_stocks sia sul fallback products; se 0 righe toccate → "Giacenza
insufficiente per {nome}." (il DB serializza gli UPDATE sulla riga, quindi il secondo vede il
decremento del primo). VERIFICATO live 4/4 con test di CONCORRENZA REALE: stock=1, due checkout
paralleli sull'ultima unità → esattamente 1 riesce, l'altro "Giacenza insufficiente", stock
finale 0 (mai negativo); regressione checkout 8/8 + report netto 4/4.

TRANSAZIONALITA' checkout/annullo + errore piano rate (#8) — NON FATTO in questo batch,
richiede infrastruttura: checkout/cancel NON sono avvolti in transazione (il legacy usa un
unico $pdo->beginTransaction/commit/rollBack). Esiste gia' `withTenantTransaction` (tenant-db.ts)
ma checkout usa i primitivi pool-based (tenantInsert/dbExecute) in ~15 funzioni annidate:
renderlo atomico richiede o (a) filtrare il client `q` per tutte le funzioni, o (b) un context
AsyncLocalStorage nel layer DB CORE — entrambi con blast radius APP-WIDE (ogni pagina) e
regressione app-wide. Il test di concorrenza sopra CONFERMA il gap: il checkout perdente aveva
gia' inserito una vendita ORFANA prima del throw sullo stock. #8 (errore creazione piano rate
ingoiato dal catch{}) e' entangled: senza transazione, la vendita e' gia' committata prima del
piano, quindi ne un-swallow ne compensazione sono sicuri. Da fare come task infrastrutturale
dedicato con regressione app-wide (non solo Pagamenti).

## Pagamenti AUDIT-2 batch 2: ricavo NETTO nei report (no doppio conteggio) (2026-07-07)

Il legacy MEMORIZZA sales.total gia' al netto dei residui (pos.php:4585/4605: $total -=
giftcard_used -= credit_used), quindi ogni SUM(total)/AVG(total) legacy nei report e' NETTO.
Il Next memorizza total LORDO — scelta CORRETTA e DA MANTENERE perche' il netFactor delle
Commissioni (manage-commissions netFactor = saleTotal/subtotal) vuole subtotal-sconto, NON
netto-di-residui (il base commissioni legacy `allocated_net`, Commissions.php:2123-2124, netta
solo lo SCONTO, non i residui: flippare lo stored total a netto ROMPEREBBE le commissioni).
Ma i report di Next leggevano s.total LORDO → l'Incasso/Venduto/KPI contava DUE VOLTE il
credito (gia' incassato quando la ricarica/giftcard fu venduta). FIX: ricavo netto ricostruito
ESPLICITAMENTE negli aggregati, lasciando lo stored total lordo:
- manage-reports.ts: nuova costante NET_SALE_REV = total - credit_used - giftcard_used, usata
  nel modello incassi (collection instant), nel riepilogo vendite (sold/avg_ticket), nei top
  clienti e negli operatori (SUM/AVG). Il "Lordo" resta SUM(subtotal); credit_used/giftcard_used
  restano voci separate come nel legacy (reports.php:777-778).
- manage-pos.ts summarizeSales: netTotal = total - wallet - giftcard (via paymentAmount).
- db-repositories.ts posDbSummary: la sua mapSale accorpa i pagamenti in un unico tender 'card'
  (payments non granulari), quindi il netto e' calcolato via AGGREGATO SQL sulle righe vendita
  (CASE su status per active/cancelled, match con mapSale: solo 'cancelled' esatto = annullata).
VERIFICATO live 4/4: inserita una vendita controllata (total 100, credito 40, giftcard 10 =>
netto 50) → KPI revenue, Incasso (collection) e Venduto crescono di 50 NETTO (non 100);
vendita test rimossa. Regressione OK (checkout 8/8, D1 4/4, storno ricarica 3/3). Commissioni
NON toccate (stored total invariato).
NON fatto (fuori scope doppio-conteggio): posDbSummary.paymentTotals accorpa tutto su 'card'
(ripartizione metodo grezza) — la ripartizione fedele e' gia' in getManageReports.payment_methods.

## Pagamenti AUDIT-2 batch 1: guardia saldo storno ricarica (2026-07-07)

Audit completo dei Pagamenti (6 aree, diff riga-per-riga legacy↔Next). Primo fix: la
GUARDIA SALDO sullo storno del CREDITO ricarica. PRIMA: `reverseIssuedSaleRecharges`
(manage-pos.ts:4960) debitava il wallet di `-total_amount` con `.catch(()=>undefined)`
SENZA controllo saldo → se il credito emesso dalla ricarica era già stato speso (altra
vendita/prenotazione), l'annullo portava il wallet in NEGATIVO silenziosamente (rompe la
simmetria create↔storno). ORA: nuovo preflight `assertRechargeCreditFeasible` (gemello di
`assertNormalStornoFeasible`) chiamato in `cancelManageSale` PRIMA di ogni mutazione: per ogni
ricarica non-void della vendita proietta `saldo credito + credit_used` (l'ordine reale:
cancelLinkedSaleResidues ripristina i residui PRIMA di stornare la ricarica) e, se il debito
porterebbe sotto zero, blocca con il messaggio verbatim legacy (CreditRechargeCancel.php:
869-874) `R#N: credito insufficiente per lo storno (saldo attuale € X).`. Blocca prima di
markSaleCancelled → nessun half-cancel.
VERIFICATO live 3/3: credito speso→annullo bloccato (wallet resta a 0, ricarica non void);
credito presente→annullo consentito (wallet 50→0, mai negativo); residuo 0, cliente 9
invariato (credito 25, punti 22).
RESIDUI (finding #4/#5 dell'audit, NON portati): il blocker FIFO "ricarica collegata a
un'altra vendita da Pagamenti" e il popup prenotazioni-collegate-al-credito-ricarica
(recharge_cancel_load_links) darebbero solo un messaggio più specifico — il danno (wallet
negativo) è già impedito dalla guardia saldo. Il porting FIFO di attribuzione credito è
grande e solo-messaggistica: rinviato come task dedicato se richiesto.

## Pagamenti D1: blocker annullo con prenotazioni collegate (2026-07-07)

Chiuso il nucleo di integrità dati di D1 (port di appt_lifecycle_apply_sale_cancel_
reservation_policy, AppointmentLifecycle.php:1931-1980). PRIMA: annullare una vendita che
aveva emesso un pacchetto/giftbox/prepagato NON bloccava, anche se una prenotazione
ATTIVA/ESEGUITA lo usava ancora → il residuo diventava 'canceled' lasciando la prenotazione
a referenziarlo (incoerenza, riprodotta abilitando temporaneamente fidelity+campagna). ORA:
- saleCancelLinkedAppointments(slug, saleId) raccoglie le prenotazioni collegate a
  pacchetti/prepagati (client_*_.sale_id) + giftbox (marker note) via le tabelle-link
  appointment_package_items / appointment_giftbox_items / appointment_prepaid_service_items;
  le prenotazioni NON annullate diventano BLOCKER con messaggi verbatim ("Prenotazione {code}
  collegata a {source}: apri la prenotazione e rimuovi manualmente il servizio/credito oppure
  annulla la prenotazione..." / "...in stato Eseguito...: annulla/storna prima...").
- buildCancelSummary espone linkedAppointments + aggiunge i blocker (canCancel=false; il
  modale già rende blockers + disabilita il submit).
- cancelManageSale ENFORCE server-side (throw) — non solo UI.
VERIFICATO live 4/4: annullo bloccato con prenotazione scheduled collegata; consentito dopo
averla annullata; nessuna regressione (checkout/cancel 8/8). Setup fidelity di test
(campagna+carta+template) creato e RIMOSSO (residuo 0, cliente 9 invariato).
Estesa poi la copertura del blocker anche alla sorgente GIFTCARD (appointments.giftcard_id +
giftcard_used>0, giftcard emesse dalla vendita via marker 'issue' in giftcard_transactions;
port di appt_lifecycle_load_giftcard_linked_appointments) — VERIFICATO 2/2. Il blocker copre
ora pacchetti/prepagati/giftbox/giftcard.
PARTE 2 (2026-07-07): gestita anche la prenotazione GIÀ ANNULLATA che conserva ancora la
giftcard della vendita come credito (giftcard_used>0) — port di AppointmentLifecycle.php:
1996-2005. saleCancelLinkedAppointments non salta più incondizionatamente le annullate: se
una annullata è nel branch GiftCard (quindi giftcard_used>0 = credito residuo) diventa BLOCKER
verbatim "Prenotazione {code} già annullata ma con credito ancora applicato a {source}:
ripulisci manualmente la prenotazione prima di annullare la vendita."; le annullate di
pacchetto/giftbox/prepagato o pulite (giftcard_used=0) restano consentite (preserve history,
:2007-2020). VERIFICATO 2/2: annullo bloccato con prenotazione annullata-con-credito; consentito
con annullata pulita. Regressione OK (checkout 8/8, D1 package 4/4, D1 giftcard 2/2). Residuo 0.
RESIDUI D1 non fatti: sorgente RICARICA (credito fungibile, nessun loader legacy dedicato —
escluso come nel legacy); decisione storno punti PER-prenotazione con i radio negative/skip
sulle annullate (deriva dall'enrichment non tracciato, marginale/rara — non portata).

## Pagamenti AUDIT + fix batch 1 (2026-07-07)

Ri-audit completo di Pagamenti (5 analisi parallele + test live). Core checkout verificato
live 8/8; sotto-pagine e logiche pacchetti/giftcard/giftbox/rate/cap-punti fedeli. FIX
applicati (verificati live 5/5 dove testabile, nessuna regressione sul 8/8):
- P1 (🔴) PROMO-CON-CODICE nel POS: un codice che coincide con una promotions.coupon_code
  ATTIVA ora si applica come PROMOZIONE (non coupon), con fallback al coupon classico
  (port di pos.php:4304-4336; riusa evaluatePromotionsForCart via lookup coupon_code->id).
  Nota "Promozione: NAME (CODE) -importo". VERIFICATO live (sconto 50%, nota col codice).
- R5 (🟡) piano rate SCARTATO con scelta "unica soluzione" (installment_choice='single'):
  activePlan ora null se single (pos.php:4633-4636). VERIFICATO: nessun piano, niente nota.
- R2 (🟡) vendita PREPAGATI: issuePrepaidFromSale ora imposta expires_at (+ purchase_date)
  da prepaidExpiryForPurchaseDate (port di PosSettings::prepaidExpiryForPurchaseDate/
  computeExpiry, PosSettings.php:247/209) — prima i prepagati non scadevano mai. VERIFICATO
  con scadenza attiva (+6 mesi).
- R1 (🔴) RICARICHE: punti ora maturano quando il cliente è idoneo (programma attivo +
  aderente) A PRESCINDERE dal flag earn_points del template; il flag decide solo la BASE
  (attivo=base+bonus, disattivo=sola base) — port di pos.php:5570-5575. Prima col flag OFF
  un cliente idoneo riceveva ZERO punti. Fix a livello codice (fidelity disabilitata su
  questo tenant, non live-testabile qui).
Residui (batch successivi / opzionali): D1 (decisione storno punti per-prenotazione
nell'annullo), R3 (blocco prepagato scaduto in exec manuale), F1/F2 (cap riscatto su
saldo-prenotati + hint modale), C2 (preorder_expires_at), + messaggi verbatim 🟢.

## Quick Booking drawer: stile grigio dei campi disabilitati (2026-07-07)

Fedeltà UI: nel legacy i select non ancora cliccabili del drawer (Operatore prima del
servizio, Cabina prima della disponibilità, + i select per-servizio multi-servizio) sono
GRIGI via la classe qb-field-muted (app.css:880-886: sfondo #f1f5f9, bordo #cbd5e1, testo
#64748b, cursor:not-allowed), toggolata da app.js (8064-8089). Il drawer Next NON applicava
mai la classe -> i campi disabilitati restavano bianchi (app.css forza .form-select bianco
con specificità che batte il :disabled di Bootstrap; solo #quickBooking .qb-field-muted, con
#id, vince). FIX: aggiunta qb-field-muted ai select Operatore/Cabina (singoli + per-riga
multi-servizio) quando disabilitati, e qb-field-loading all'Operatore durante il controllo.
Ora di Fine (.form-control) e bottone Disponibilità restano come nel legacy (bianco/opacity
Bootstrap: il legacy non li muta via qb-field-muted).

## Quick Booking AUDIT + comunicazione booking pubblico (2026-07-07)

Audit completo del quick booking (4 analisi parallele + test live) e verifica della
comunicazione col booking pubblico. **Comunicazione CONFERMATA CORRETTA (19/19 test live)**:
QB interno e pubblico condividono lo stesso motore (busyRangesForDate + holdPublicBookingSlot
+ publicBookingSlots, stessa tabella appointment_holds senza filtro per canale). T1 appt
interno blocca slot pubblico+manage; T2 hold pubblico blocca pubblico+manage; T3 hold interno
(backend 300s) blocca pubblico; T4 conferma pubblica visibile e bloccante lato manage. Nessun
bug di isolamento hold.

BATCH 1 fix (tutti verificati live 7/7, nessuna regressione sul 19/19):
- #1 Cliente obbligatorio: resolveClientForAppointment lancia "Seleziona un cliente." se manca
  id E nome (prima creava un cliente spazzatura "Cliente"). api_appointments.php:9992.
- #2 Servizio obbligatorio: planAppointmentServices lancia "Seleziona almeno un servizio." se
  nessun nome (prima prenotava il primo servizio attivo). api_appointments.php:10047.
- #8 Sede non valida: route.ts save -> "Sede non valida o non disponibile." per un location_id
  positivo che non risolve (prima procedeva senza sede). api_appointments.php:9974.
- #9 Ora obbligatoria: route.ts save -> "Inserisci inizio e fine." per time vuoto (prima
  default 09:00); + "Durata servizio non valida." in planAppointmentServices per durata 0.
  api_appointments.php:10940/10952.
- #3 no_show LIBERA lo slot: busyRangesForDate/busyCabinRangesForDate portano la WHITELIST
  api_appt_active_status_sql (pending/scheduled/done + sinonimi) al posto della blacklist NOT
  IN ('canceled','cancelled'); inoltre i SEGMENTI ora sono filtrati per stato-attivo del padre
  (prima il segmento di un no_show teneva occupato lo slot). Simmetrico pubblico/interno.
BATCH 2 fix (messaggi verbatim del SAVE backend, verificati live 4/4, nessuna regressione):
- #4 Conflitto operatore: assertAppointmentSlotAvailable ora lancia il messaggio backend
  "Conflitto: l'operatore ha già un altro appuntamento in quell'orario." (single) /
  "...uno degli operatori..." (multi, >1 segmento) invece di quello del wizard pubblico.
  api_appointments.php:11202/12713. NB: la funzione è usata SOLO da manage save + planner,
  non dal pubblico, quindi il messaggio pubblico resta invariato. Aggiornata la regex del
  planner (reasonFromGuardError) per matchare anche "conflitto".
- #5 Time-off/turno: buildTimeoffMessage (port di timeoff_user_message :3568) usa il NOME
  dell'operatore e, se il servizio è gestito da un SOLO operatore (uniqueStaffForService,
  port di unique_staff_for_service :3511, staff_services filtrati per sede), la variante
  "il servizio \"X\" è gestito solo da {nome}... Per procedere, abbina un altro operatore...".
  Aggiunto serviceId ad AppointmentSlotSegment (popolato in create/update).
BATCH 3 fix (verificato live 2/2, nessuna regressione):
- #6 Auto-assegnazione operatore UNICO nel save (port di unique_staff_for_service,
  api_appointments.php:10893-10919): planAppointmentServices, quando un segmento resta
  senza operatore, assegna l'unico eleggibile del servizio (uniqueStaffForService, ora
  esportata da public-booking-db + locationId propagato). Additivo/sicuro: se non c'è un
  operatore unico (0/2+ eleggibili o no_operator) resta invariato; operatore esplicito
  preservato. NON portato il guard hard "Seleziona un operatore per X" né l'auto-pick del
  primo operatore libero (appt_auto_staff_for_single_service) — più rischiosi e coperti
  dal drawer che auto-seleziona.
BATCH 4 fix (#10/#11 qb_residui_check, verificato live 6/6, nessuna regressione):
- #10 GIFTBOX: la modale Residui ora VERIFICA i conflitti giftbox (prima non controllati):
  blocca se la voce (instance_id+giftbox_item_id) è già collegata a un'altra prenotazione
  attiva (reservation-aware), con label verbatim "GiftBox {code} ({nome}) • \"{voce}\": ...".
- #11 Pacchetti/prepagati: ESCLUSIONE dell'appuntamento corrente in edit (se lo collega già,
  la riselezione NON blocca — nel modello Next il consumo è al create, quindi il pool è già
  scalato da questo stesso appuntamento) + messaggi VERBATIM con nome + refs delle altre
  prenotazioni ("Pacchetto \"X\" • \"Y\": già presente nella prenotazione {codici}." /
  "Servizio prepagato \"X\": ..."). Portati i label helper qb_service_name/qb_package_name/
  qb_giftbox_instance_label/qb_giftbox_item_label (api_appointments.php:1456-1565) + refs
  (public_code delle prenotazioni attive collegate, escluso il corrente).
Residue (opzionali, DISCUTIBILI/RISCHIOSI/NULLI, lasciati per scelta): filtro slot
past-time backend (#12, il comportamento Next è probabilmente migliore), modello cabine
slot primaria-vs-any (#13, complesso/rischioso), staff_for_service hold-exclude (#14,
plumbing drawer, basso impatto), floor durata 5vs10min (#15, zero impatto su dati attuali),
DIV-1 fidLabel hardcoded "Punti" (solo se il tenant rinomina la fidelity), DIV-2 storno
punti done→cancel (complesso/edge), #7 __new__ inline client (moot: il drawer pre-crea).

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

## Promozioni — SECONDA PASSATA: LISTA riscritta (promotions.php action=list) — 2026-07-05
Ri-audit su richiesta. BASELINE: la battery motore del primo audit (38 test,
save/engine/toggle/delete/clone/per_customer_limit) era ancora verde, MA la
LISTA Next era il vecchio prototipo non fedele: colonne inventate (Canale!),
badge 'Sospesa' per le disattivate, toggle/delete con messaggi inventati e
confirm non legacy, NESSUN modal Riepilogo, nessuna conferma con prenotazioni
interessate, nessuna gestione condizioni/esclusioni, niente flash redirect.
RISCRITTURA COMPLETA:
1. LISTA legacy: colonne Nome/Sconto/Validità/Target/Scope/Sedi/Stato/Azioni;
   badge stato port di promotions_page_status_meta (Attiva success, Programmata
   info, Disattivata secondary, Sospesa warning con Fidelity off+target
   fidelity+auto_disabled, Completata dark non riattivabile); label sconto port
   di Promotions::formatDiscountLabel (percent zeri trimmati, fixed fmt_money,
   ereditarietà prodotti, compat coupon v1, fallback 'Per elementi
   selezionati'); validità 'Sempre'/'Da d/m/Y'/'Fino al d/m/Y'/'X → Y'; target
   labels legacy; scope 'Servizi: Tutti • Prodotti: Selezionati'; sedi; ordine
   is_active DESC, starts_at DESC, id DESC (cap 500); header 'Nuova promozione'
   nascosto nello stato vuoto; 'Nessuna promozione trovata per la sede
   selezionata.'; btn-group Riepilogo · Modifica|'Clona campagna' (lock
   strutturale) · Disattiva/Attiva/'Riattiva con Fidelity' disabled/label
   disabled · Elimina.
2. MODAL 'Conferma operazione' (promotions.js): titolo 'Elimina promozione - X'
   / 'Disattiva promozione - X', avvisi verbatim ('Eliminazione definitiva...',
   'Conferma disattivazione...'), accordion 'Prenotazioni interessate' con
   count, 'N prenotazione aperta perdera/prenotazioni aperte perderanno la
   promozione.'/'Non risultano prenotazioni aperte collegate alla promozione.',
   voci 'Prenotazione #ID - d/m/Y H:i • stato' (set stati ESTESO della pagina,
   16 sinonimi) e 'Altre N prenotazioni non mostrate.', footer Annulla/Continua.
3. MODAL RIEPILOGO per campagna (auto-open via ?open_summary, anche post-save):
   Configurazione (stato/validità/target/livelli Fidelity/sconto/scope/sedi/
   'Cumulabile con' dal bitmask/clienti esclusi/creata/aggiornata/descrizione),
   Statistiche da promotion_redemptions (clienti coinvolti/utilizzi/sconto
   totale fmt_money/primo/ultimo utilizzo), Servizi-Prodotti con righe
   'NOME — sconto • q.tà min. N' (prodotti con SKU), Validità dettagliata
   (fasce 'Lun 09:00–12:00'/'Tutti i giorni / orari', 'Nessuna'), Limiti
   ('Senza limiti'), alert 'Promozione non riattivabile' con lista voci.
4. CONDIZIONI BOOKING nel riepilogo (updatePromotionConditions port): switch
   'Mostra testo nel booking' + textarea, guardia 'Inserisci il testo delle
   condizioni promozionali oppure disattiva il flag.', flash 'Condizioni
   promozionali aggiornate' con redirect ?open_summary, testo NULL a flag off.
5. ESCLUSIONI CLIENTI nel riepilogo (add/remove port con guardie verbatim:
   'Cliente non trovato', 'Il cliente non rientra nel target attuale della
   promozione.' per target fidelity via snapshot adesione+livello punti, 'Il
   cliente ha già una prenotazione o vendita associata a questa promozione.'
   su redemption/appuntamenti non annullati/vendite non annullate); candidati
   filtrati; esclusi con meta 'Fidelity attiva • Punti: X'/'No Fidelity';
   flash "Cliente aggiunto all'esclusione"/"Cliente rimosso dall'esclusione".
6. FIX sul toggle esistente: virgolette tipografiche nella guardia Fidelity
   ('...target “Solo clienti con Fidelity”.'), azzeramento
   auto_disabled_by_fidelity a toggle riuscito (prima assente), nomi legacy
   nei blocchi riattivazione ('Servizio "NOME (SKU)" è stato disattivato',
   fallback 'Servizio #N' sugli eliminati).
7. FORM: modalità CLONA CAMPAGNA (action=duplicate, prima ASSENTE nel
   componente — il link legacy 404ava di fatto): prefill dalla sorgente con
   replace_source_id, titolo 'Clona campagna', submit 'Salva clone';
   GUARDIA lock strutturale su action=edit (nuovo endpoint edit_guard con la
   reason verbatim 'Questa promozione ha gia prenotazioni, vendite o utilizzi
   collegati: puoi clonare la campagna, ma non modificare direttamente la
   regola esistente.') con redirect lista ?open_summary&err; submit label
   'Aggiorna' in modifica; post-save redirect flash ?msg&open_summary=ID
   (confermato identico al live).
RESIDUI DELIBERATI: filtro 'Tutte le sedi' non renderizzato (tenant mono-sede:
il legacy lo nasconde e locationScopeSql è no-op con sede attiva unica; per
multi-sede va aggiunto il filtro server); stats del riepilogo senza filtro
sede corrente (sede unica: identiche); il fallback lista per-nome-sede di
promotions.php 1112-1128 non portato (stesso motivo).
Verifica: battery LISTA 30/30 (payload page con tutti i label/badge/pending/
canEdit/activation items, toggle verbatim + reset flag, condizioni, esclusioni
con tutte le guardie, edit_guard, clone con anti-duplicato rispettato, delete,
ripristino) + regressione motore 38/38 + 80/80 marker bundle + LIVE PHP
(create->'Promozione salvata'+open_summary, toggle on/off e delete flash
identici) + typecheck/lint puliti.

## Punti — SECONDA PASSATA di verifica (fidelity_points.php) — 2026-07-05
Ri-audit su richiesta della pagina Punti (3845 righe + fidelity_points.js).
BASELINE CONFERMATA prima dei ritocchi: battery e2e 42/42 e 102/102 marker
ancora verdi (settings/toggle generale/campagne/KPI del primo audit F7 +
l'editor Livelli Card riscritto nell'audit fidelity_levels con la sua battery
31/31). Riletti integralmente i blocchi non ancora ri-verificati: gate permessi
POST (pointsOnlyPostModes con 403 JSON sulle preview), guardia globale off,
toggle_fidelity coi messaggi composti (campagne bloccanti / conferma
appuntamenti / code riattivazione promo-omaggi), save_settings (preserva le
preferenze a modulo spento, guardia scadenza>0, conferme firmate
expiry/redeem, code messaggi '. Scadenze punti aggiornate sui saldi residui'
/'. Punti Fidelity disattivati/attivati'/'. N campagna punti attiva
disattivata'/'. Rimosse automaticamente le agevolazioni punti da N
prenotazioni'), preview campagne (delete/toggle), KPI con filtro sede e
clienti con tessera attiva, top clienti con link
fidelity_wallet&client_id&location_id (gia fedele nel componente), tabella e
form campagne (badge 'Disattivata da Punti', 'ID: N', scaglioni, destinatari,
'Vuota = subito.'/'Mai'), banner nessuna-campagna, modali conferma.
RITOCCO APPLICATO: portati i due handler compat DORMIENTI (raggiungibili solo
con POST manuale, verificati 1:1 sul PHP live):
- _mode=manual_move -> 'Il movimento manuale e stato spostato in "Fidelity ->
  Portafoglio".' (il legacy redirige al Portafoglio con quell'err);
- _mode=save_rule/delete_rule -> 'Le regole per singolo servizio/prodotto non
  sono piu usate nelle campagne Punti.'
RESIDUI DELIBERATI: l'alert warn_locked su QUESTA pagina (?client_id federated
+ ?warn_locked, righe 3024-3085, variante senza accenti e con '--') e un
dead-path: nessun flusso vi redirige piu (il movimento manuale vive nel
Portafoglio, dove l'alert e portato); il deep-link ?campaign_id=N /
?new_campaign=1 apre il form lato client senza URL (nessuna pagina esterna
li linka).
Verifica: compat testati su Next e LIVE PHP (messaggi identici) + regressioni
complete 42/42 + 102/102 marker + Livelli 31/31 + typecheck pulito.

## Omaggi — SECONDA PASSATA: LISTA + RIEPILOGO riscritti (gifts.php) — 2026-07-05
Ri-audit su richiesta. BASELINE: motore/istanze verdi (93 test su 6 battery,
ripatchate con installment_choice), MA la vista campagne Next era un prototipo:
flash locali inventati, badge stato con ordine sbagliato (Completata dopo il
toggle), date senza ora, badge 'Manuale' e description in tabella inventati,
filtri campagne dead-code, riepilogo monco (niente regola/condizioni/esclusioni/
livelli/scadenza), niente ?open_summary, Modifica non gated dal lock.
RISCRITTURA COMPLETA:
1. LIB listManageGiftPage: righe con badge stato port di campaignStatusMeta
   (ordine legacy Completata->Sospesa->Disattivata->Programmata->Attiva),
   uso/sedi/livelli ('Punti: X' / 'Tutti i livelli Fidelity' / '—'), validita
   e date d/m/Y H:i in ORA LOCALE (fix TZ: i Date del driver pg resi con
   sqlDateTimePrefix, non toISOString che scala -2h), scadenza gift ('N giorni
   dallo sblocco'/'Nessuna scadenza automatica'), regola di sblocco verbatim
   (5 tipi, fmt_money con migliaia col punto: 'Spesa totale >= € 1.234,50'),
   termini (default 3 righe legacy), esclusi con meta snapshot + candidati
   filtrati (eligibility+livelli+istanze bloccanti), stats istanze (aggregata
   inline per evitare il ciclo import con gifts-instances), lock strutturale
   giftUsageSummary (istanze+collegamenti+movimenti).
2. GUARDIE toggle legacy: activation issues con items {type,name,label,context}
   e messaggio 'Non è possibile riattivare la campagna omaggio perché ...';
   allineati al legacy anche i target regola (solo service_qty/product_qty) e
   il soft-delete (deleted_at -> 'eliminato' col nome reale, SKU inclusa);
   'Campagna completata: non può essere riattivata' (con open_summary);
   fidelity_only a Fidelity off -> resta sospesa con err verbatim; flash
   'Campagna attivata'/'Campagna disattivata'/'Campagna eliminata'/'Errore
   eliminazione campagna'; gli errori propagano open_summary nel JSON.
3. ROUTE: GET action=page / edit_guard (reason 'La campagna omaggio ha gia
   generato dati operativi (N istanze, ...): usa Clona campagna ...'); POST
   gift_terms_update ('Condizioni gift aggiornate' + open_summary, testo
   normalizzato, vuoto -> default), gift_exclusion_add/remove ("Cliente
   aggiunto/rimosso dall'esclusione", guardie 'Cliente non trovato'/'Il
   cliente non rientra nelle impostazioni attuali della campagna.'/'Il cliente
   ha già un accumulo oppure un omaggio disponibile/riscattato per questa
   campagna.', marker gift_progress_resets client_exclusion_start/end con
   reason legacy, remove -> giftRecalcClient).
4. COMPONENTE gifts-content riscritto: flash redirect ?msg/?err (msg che inizia
   con 'errore:' -> danger, gifts.php 684), header count 'N campagne', colonna
   Nome solo nome, dropdown gated legacy (Modifica solo senza dati operativi;
   Attiva con window.alert(blockMsg) se bloccata; niente toggle su Completata;
   confirm eliminazione verbatim), riepilogo COMPLETO (alert non riattivabile
   con items, Configurazione 11 voci, Statistiche 11 righe, Regola di sblocco
   con help, Condizioni gift form, Clienti esclusi con candidates/help/Rimuovi),
   auto-open ?open_summary, istanze con filtri/paginazione via querystring GET
   (come il form GET legacy) e date d/m/Y H:i, assign_manual con redirect flash
   ?inst_client_id&msg. page.tsx: branch gifts default+campaigns con initialQuery.
5. FORM: edit guard con redirect ?open_summary&err (gifts.php 626-642),
   'Campagna non trovata' su id inesistente, post-save redirect flash
   'Campagna salvata'/'Clone campagna creato' + open_summary (gifts.php 533-539).
Verifica: battery NUOVA e2e-gifts-page 51/51 (payload page completo, stati,
guardie toggle con openSummary, condizioni con normalizzazione/default,
esclusioni con tutte le guardie + marker, lock strutturale/edit_guard, delete,
ripristino) + LIVE PHP (toggle on/off/completata, condizioni update+default,
esclusioni add/remove/guardia fidelity_only, marker resets, delete: redirect
Location IDENTICI) + regressioni 6 battery gift 93/93 + 80/80 marker bundle +
smoke SSR flash + typecheck/lint puliti.
RESIDUI DELIBERATI: filtri istanze con select semplici (il combobox ricerca
legacy e solo UI); filtro 'Tutte le sedi' non renderizzato (tenant mono-sede);
GiftLoyaltyAttribution non portato (residuo standing).

## Omaggi — SECONDA PASSATA (parte 2): FORM campagna riscritto (gifts.php new/edit/clone) — 2026-07-05
Continuazione dell'audit Omaggi: diff campo-per-campo del form (gifts.php
720-1147 + validazioni pagina 444-549) contro gift_form-content.
DIVERGENZE TROVATE E CORRETTE:
1. BUG TZ nel prefill (getManageGift): valid_from/valid_to resi con toIso (UTC)
   scalavano di -1 giorno le date a mezzanotte locale; ora sqlDateTimePrefix.
2. GUARDIE Fidelity-off del save (gifts.php 489-521) ASSENTI in saveManageGift:
   - nuova campagna (o switch di eligibility) fidelity_only a Fidelity spenta ->
     'Attiva prima la Fidelity per poter usare “Solo clienti con Fidelity”.'
     (virgolette curve U+201C/201D verificate sui byte del sorgente);
   - campagna GIA' fidelity_only -> salvata SOSPESA: active forzato 0,
     auto_disabled_by_fidelity=1 se Attivo=Si' desiderato (riattivazione
     automatica al ritorno della Fidelity), 0 con Attivo=No; il flag viene
     azzerato sui salvataggi normali; conflitto campagne e marker usano
     l'active effettivo.
   - messaggio livelli allineato al display legacy ('Errore: seleziona almeno
     un livello Punti.', gifts.php 548).
3. CONTEXT esteso: fidelityEnabled, snapshot clienti (adhering + pointsLevel,
   port di giftClientEligibilitySnapshots) e currentLocationId.
4. COMPONENTE form riscritto sul markup legacy: header interno card con
   sottotitoli clone/edit; alert clone VERBATIM (il testo Next era inventato);
   ordine campi legacy (Nome | fidelity_only -> Descrizione -> Livelli ->
   Esclusioni -> Attivo -> Sedi -> Premio -> Date); sezione Livelli Punti
   con testi legacy + 'Nessun livello Punti configurato.'; picker 'Escludi
   clienti dalla campagna (opzionale)' con select candidati FILTRATI per
   snapshot (adesione+livelli selezionati), lock 'Seleziona prima almeno un
   Livello Punti' + help dinamico, lista 'Clienti esclusi selezionati';
   checkbox fidelity_only disabled a Fidelity spenta (con alert warning e
   form-text sospensione verbatim); 'Attivo' con nota sospensione e
   giftDesiredActive (sospesa con auto_disabled mostra Si'); default sede
   corrente in creazione (gifts.php 811-813); min 'Valido dal' anche in CLONE
   (prima solo new) e min 'Valido al' = giorno successivo; form-text delle
   date verbatim; help regola completo (3 frasi) + hint sotto i select
   servizio/prodotto; rimossi i testi inventati ('Nessun elemento specifico
   richiesto.', validazioni client-side custom, alert clone divergente);
   titolo pagina 'Fidelity / Omaggi' come il legacy.
Verifica: battery NUOVA e2e-gifts-form 17/17 (context, prefill senza shift,
guardie fid-off nuova/switch/esistente con entrambi i rami del flag, livelli,
anti-retroattivo, azzeramento flag, ripristino) + LIVE PHP (guardia verbatim
senza insert, edit fid-off active=1 -> 0/1 e active=0 -> 0/0 con redirect
'Campagna salvata&open_summary' IDENTICI) + regressioni 7 battery gift
144/144 + 63/63 marker form + typecheck/lint puliti.
NOTA: gift_instance (dettaglio) gia' coperto dal primo audit (21 test, verdi
in regressione oggi); nessun nuovo diff aperto su quella pagina.

## Risorse — SECONDA PASSATA: pagina riscritta (resources.php + resources.js) — 2026-07-06
Audit su richiesta della pagina Risorse condivise. Letti integralmente
resources.php (859 righe) e resources.js (177).
DIVERGENZE TROVATE E CORRETTE:
1. GUARDIA QTY NON FEDELE (lib): il Next bloccava QUALSIASI salvataggio con
   qty sotto il richiesto dai servizi, anche invariata o in aumento; il legacy
   verifica SOLO le riduzioni (newQty < oldQty), PER SEDE (servizi filtrati con
   app_service_location_allowed via service_locations, peak prenotazioni per
   sede con a.location_id). Riscritta ensureResourceQtyCanChange con la
   semantica legacy (oldLocQty dalla riga sede, fallback alla qty globale per
   righe mancanti; sede disattivata = riduzione a 0) + ramo globale senza
   config sedi (messaggi CON accento 'Quantità...' vs per-sede senza, come nel
   sorgente). resourceFuturePeakUsage ora accetta locationId.
2. POPUP DI BLOCCO (#resourceBlockModal) ASSENTE: il Next usava window.alert;
   ora gli errori di guardia portano il payload legacy {title, message,
   services[{service_name, qty_required}]} (session flash del PHP), la route
   lo propaga nel JSON e il componente rende il modal legacy (header
   small-muted 'Risorse', alert-warning, accordion 'Servizi collegati' con
   badge count e righe 'NOME — quantità risorsa nel servizio: N', footer
   Chiudi btn-pill). Guardie client di resources.js portate: delete con
   servizi collegati (messaggio client distinto da quello server) e riduzione
   qty globale in edit sotto il richiesto (popup senza POST).
3. QTY SEDI DISATTIVE CORROTTA: saveResourceLocations forzava qty>0 col
   fallback (|| fallbackQty) anche quando la sede era spenta con qty 0; ora la
   qty postata resta com'è (fallback solo a campo mancante).
4. FORM SU PAGINA DEDICATA: il Next usava un form inline; ora ?action=new|edit
   &id= come il legacy (titolo pagina 'Nuova/Modifica risorsa', header
   'Indietro' btn-pill, card sinistra col-lg-7 con form-text verbatim
   ('Esempio: "Lettino abbronzante"...', 'La quantità rappresenta il numero
   massimo...', 'La disponibilità per sede viene usata in prenotazioni,
   agenda e servizi...'), tabella Sedi abilitate (Attiva + Quantità sede
   readonly da spenta), Salva/Annulla/Elimina (edit, ms-auto), info-box destro
   'Come funziona la quantità' con i 3 esempi). Default creazione: SOLO la
   sede corrente abilitata (prima: tutte).
5. LISTA: colonna 'Quantità sede' col badge qty (prima 'Sedi / Quantità' con
   join inventato e badge 'N servizi' inesistente), descrizione troncata a 80
   (77+'…'), azioni icona matita/cestino, 'Nessuna risorsa abilitata per la
   sede selezionata.'; empty-state deciso dal TOTALE pre-filtro sede
   (resourcesTotal nel context, prima una risorsa disabilitata nella sede
   faceva sparire la lista in favore dell'empty state).
6. FLASH REDIRECT legacy: 'Risorsa creata/aggiornata/eliminata' e gli err via
   ?msg/?err con alert View::alert; 'Risorsa non trovata' (senza punto) su
   edit/delete di id inesistente; nome duplicato -> 'Errore salvataggio:
   verifica nome duplicato o schema DB (schema aggiornato).' (il vincolo
   UNIQUE(tenant_id,name) esisteva gia' in PG come nel MySQL).
7. GET action=get&section=resources nuovo per il prefill edit per id (anche
   fuori sede corrente), branch page.tsx con initialQuery.
RESIDUI DELIBERATI: filtro 'Tutte le sedi' non renderizzato (nel legacy è
di fatto MORTO: $resourceShowAllLocationsFilter usa $hasResourceLocationsTable
PRIMA della definizione, riga 34 vs 44 -> sempre false); il banner 'tabella
mancante' non portato (schema PG sempre presente); lock advisory
shared_resources_acquire_resource_locks non portato (dbQuery singola, niente
race multi-processo equivalente).
Verifica: battery NUOVA e2e-resources 25/25 (create con nome collassato e
qty=max sedi, guardie nome/sedi/duplicato, get 404, filtro sede vs totale,
riduzione bloccata con popup verbatim, invariata ok, aumento libero, peak con
2 prenotazioni sovrapposte + riduzione al picco esatto ok, delete con guardia
popup e pulizia righe, ripristino) + LIVE PHP (create/guardie/duplicato/
riduzione con popup in sessione IDENTICO campo per campo/invariata/aumento/
delete bloccata e pulita/id inesistente: redirect e payload identici) +
regressioni condivise endpoint (cabins 14, hours 4, staff-availability 16,
staff-for-service 6) + 36/36 marker bundle + typecheck/lint puliti.

## Servizi — AUDIT FUNZIONALE COMPLETO (services.php, 3 tab) — 2026-07-06
Primo audit funzionale della pagina piu grande del legacy (5653 righe +
services.js 775; la parita grafica era gia stata verificata in B6, upload
immagine categoria in un audit precedente). Letto tutto il legacy (parte via
3 subagenti con estrazione verbatim). Il Next aveva un port PARZIALE: save
senza i flussi di conferma, delete con messaggi inventati, modale consigliati
MORTA (form senza handler), niente flash/paginazione, guardie divergenti.
RISCRITTURA/PORT:
1. NUOVO lib/manage-services-impacts.ts: pipeline legacy 1:1 —
   svc_fetch_impacted_appointments (4 stati con sinonimi IT), name_update_
   impacts (9 gruppi), delete_blockers (10 gruppi attivi/aperti),
   deactivation_blockers (campagne con Validita), price_update_impacts,
   APPLY nome (colonna+snapshot json su 7 famiglie di tabelle, walk json
   ricorsivo su gifts.reward_items_json) e APPLY prezzo (package_items con
   line_total, fallback packages.service_id, ricalcolo package_pricing,
   promotion_services price-mode riallineato), FREEZE snapshot storici
   (payload version 3, riempie solo campi vuoti, refresh json incompleti,
   INSERT righe mancanti; sold: prepagati nome/prezzo bloccati, righe
   pacchetto, giftbox items).
2. SAVE orchestrato come services.php 4212-4583: validazioni VERBATIM in
   ordine (cabina con accento, sede con accento, guardie cabina/staff per
   sede SENZA accenti e risorse CON, byte-verificati), diff stato db/post e
   CATENA DI CONFERME con confirm_* accumulati (blocco disattivazione ->
   disattivazione con prenotazioni -> nome -> prezzo anche a 0 impatti ->
   modifica non retroattiva con changedFields); freeze PRIMA dell update;
   messaggi con suffissi conteggio nome/prezzo.
3. DELETE legacy: Servizio non trovato / Servizio non eliminabile + popup
   verbatim + freeze + cleanup mapping incluse raccomandazioni bidirezionali.
4. ROUTE: pending/popup/msg + GET action=delete_blockers.
5. COMPONENTI: form con i 5 pannelli di conferma verbatim e re-submit coi
   flag + redirect flash; lista con flash, paginazione 20/pg, filtro
   ?service_id, empty-state cabine, delete con popup accordion o confirm
   verbatim; CATEGORIE con flash legacy, popup Categoria non eliminabile
   (Servizi collegati + badge Attivo/Disattivo), confirm verbatim, vista
   ORDINA SERVIZI (?action=order&id) prima ASSENTE, paginazione, auto-open
   modali; CONSIGLIATI: la modale ora SALVA (dedup, no-self, sort_order ->
   Servizi consigliati aggiornati), badge primi 3 + +N, Non attivo (era
   Inattivo), pannello ordine funzionante, flash/filtri/paginazione,
   auto-open con Servizio non trovato. page.tsx: routing tab con
   initialQuery + fix del branch form che catturava anche
   tab=categories&action=edit.
DIVERGENZA DELIBERATA (bug legacy verificato sul LIVE): l apply del cambio
nome legacy fallisce SILENZIOSAMENTE sugli UPDATE con JOIN (il rewriter
multi-tenant di Db::q li rompe: ROW_COUNT 0 via PHP, 1 con lo stesso SQL
raw) -> sul live la colonna service_name resta vecchia e il suffisso
conteggi non appare mai, mentre gli update semplici per-riga (snapshot
json) funzionano. Il Next applica l INTENTO del pannello di conferma
(colonna + json + conteggio). Altri residui: compressione immagine
categoria (gia documentata), filtro Tutte le sedi (mono-sede).
Verifica: battery NUOVA e2e-services 40/40 (validazioni, create+links,
catena conferme completa con snapshot congelato, disattivazione bloccata
da promo attiva poi confermata, delete blockers+popup+404, categorie
crea/aggiorna/404/default/popup/ordina/elimina, consigliati dedup+
sort_order+guardia, ripristino) + LIVE PHP (create, guardie nell HTML,
pannello conferma nome coi medesimi testi, redirect identici, popup delete
di sessione IDENTICO campo per campo) + 60/60 marker su 4 viste +
regressioni 45/45 + typecheck/lint puliti.

## Cabine — SECONDA PASSATA: pagina completa (cabins.php + cabins.js) — 2026-07-06
Ri-audit su richiesta (il motore bulk era gia' coperto da V4). DIVERGENZE
TROVATE E CORRETTE:
1. DELETE SINGOLA MORTA: il cestino della riga era un link a
   ?action=delete&id mai gestito dal routing Next (click = ricarica pagina
   senza effetto). Ora POST cabin_delete con il flusso legacy completo:
   'Cabina non trovata' su id inesistente/fuori sede, blocchi -> err
   'Cabina non eliminata: e associata a servizi o prenotazioni future.'
   (senza accento, come il sorgente) + popup di sessione, soft delete +
   cabin_reorder_active (position ricompattate 1..N) + flash 'Cabina
   eliminata'.
2. BLOCKERS INCOMPLETI: il Next usava solo service_cabins e riduceva le
   prenotazioni a un conteggio generico. Portato
   cabin_delete_blockers_for_cabin 1:1: servizi via service_cabins E
   colonna legacy services.cabin_id (con service_active), prenotazioni
   FUTURE pending/scheduled dettagliate (appointments.cabin_id, servizio
   legacy, appointment_segments.cabin_id con esclusione dei segmentati)
   con voce 'Prenotazione CODE' e detail 'd/m/Y H:i - cliente - stato'.
3. POPUP: etichette di cabins.js portate ('NomeCabina → Servizio
   (Attivo/Disattivo)' con freccia unicode; 'NomeCabina -> Prenotazione X -
   dettaglio' con freccia ASCII per gli appuntamenti; prima il Next
   scriveva 'Cabina' generico), messaggio SCAMBIATO quando c'e' una
   prenotazione ('La cabina e associata a servizi o prenotazioni
   future...', senza accenti), accordion 'Servizi collegati' con badge
   count (prima lista piatta), empty 'Sono presenti servizi associati.'.
4. FLASH legacy: 'Impostazioni salvate' via redirect (prima reload
   silenzioso), 'Cabina eliminata', err del bulk bloccato con form
   ricaricato dallo stato reale (cabins.php 468-471); alert in testa alla
   pagina (prima dentro la card); branch page.tsx con initialQuery.
5. BULK: popup del blocco dal payload server (legacy-shaped) e
   cabin_reorder_active dopo il salvataggio.
Verifica: battery NUOVA e2e-cabins-page 20/20 (validazioni verbatim, bulk
con nome collassato/posizioni/sede, blockers nel context, anti-bypass con
servizi e con prenotazione dettagliata + messaggio scambiato, delete
bloccata/pulita/404 + reorder, ripristino) + LIVE PHP (bulk 'Impostazioni
salvate' con gli stessi dati, anti-bypass identico, delete bloccata da
servizio e da prenotazione con popup di sessione IDENTICI campo per campo,
delete pulite con reorder) + 24/24 marker bundle + regressioni (cabins 14,
resources 25, services 40) + typecheck/lint puliti.

## Operatori — SECONDA PASSATA: pagina completa (staff.php + staff.js) — 2026-07-06
Ri-audit su richiesta (motore V3 gia' verde; chiuso anche il residuo V3
"guardie sedi/disattivazione semplificate"). BUG e DIVERGENZE CORRETTI:
1. OWNER MAI RICONOSCIUTO SU PG (bug reale): le protezioni Admin usavano
   users.id===1 (convenzione del DB per-tenant legacy) ma nello schema PG
   condiviso gli id sono identity GLOBALI (per questo tenant l'owner e' id
   20) -> "Protetto", blocco eliminazione e lock ruolo/stato non scattavano
   MAI. Equivalente portabile: primo utente del tenant (MIN(id)) con ruolo
   admin (tenantOwnerUserId), applicato a lista/prefill/save/delete.
2. PROTEZIONI OWNER portate (staff.php 806-814): 'Email obbligatoria per
   Admin' (come msg), attivo e ruolo FORZATI (non disattivabile, non
   degradabile), 'Admin non può essere eliminato' (accento).
3. GUARDIE SEDE/DISATTIVAZIONE legacy complete (staff.php 828-873, prima
   "in forma semplificata" e TROPPO restrittive — bloccavano la
   disattivazione con qualunque servizio attivo collegato): ora solo alla
   TRANSIZIONE attivo->disattivo e solo se un servizio (attivo, con
   operatore, coperto nella sede) resterebbe senza ALTRI operatori
   abilitati (staff_service_location_blockers con service_locations e
   filtro staff_locations): 'Non puoi disattivare l'operatore: il servizio
   "X" resterebbe senza operatori abilitati in "Y".'; rimozione sede con
   'Non puoi rimuovere la sede "Y": il servizio "X" resterebbe senza
   operatori abilitati.' e la variante prenotazioni aperte per sede.
4. FLASH KIND legacy: gli errori che staff.php veicola come &msg= sono
   alert VERDI (Email obbligatoria / Password obbligatoria / Email già
   utilizzata (accentata) / Colore non valido / Nome operatore riservato
   (SSO) / Operatore SSO non modificabile-eliminabile / Email obbligatoria
   per Admin) — il server li marca flashKind='msg' e i componenti li
   rendono verdi; gli altri (sede mancante, guardie, Solo Admin) restano
   rossi. Aggiunta la validazione colore (prima il Next ripiegava in
   silenzio sulla palette) e il gating 'Solo Admin puo modificare/assegnare
   ...' col ruolo di sessione.
5. DELETE: catena guardie nell'ORDINE legacy (SSO msg -> owner -> non
   trovato -> Solo Admin -> storico prenotazioni ANCHE annullate ->
   servizi con POPUP {title, operator_name, message, services} -> storico
   commissioni con 'Disattivalo per mantenere lo storico.') + cleanup
   completo (user_email_verifications, user_locations, users,
   staff_commission_settings/periods) — prima messaggi con
   punteggiatura/accenti divergenti, niente popup ne' cleanup commissioni.
6. LISTA: filtri q/ruolo/stato dal querystring (form GET legacy), flash
   ?msg (VERDE, salvo i duplicati timeoff) /?err, badge Staff text-bg-info
   (era secondary), sedi max 3 + '+N' e 'Tutte' a lista vuota, badge
   'Protetto' per l'owner al posto di Elimina, confirm 'Eliminare questo
   operatore?' (senza nome), popup 'Servizi associati' con accordion e
   voci 'nome — non attivo'. FORM: redirect flash 'Operatore salvato',
   flashKind, label 'Immagine operatore' (era 'Foto operatore').
   page.tsx: branch staff con initialQuery.
RESIDUO UI documentato: il 'Nuovo operatore' legacy apre il form in un
MODAL sulla lista (il Next usa la pagina dedicata action=new, stesso form
e stessi flussi); cropper foto senza drag/zoom interattivo (upload+crop
server gia' coperti dalla route dedicata).
Verifica: battery NUOVA e2e-staff-page 27/27 (6 validazioni con flashKind,
create con account users role/non verificato e colore normalizzato, owner
reale protetto SENZA modifiche distruttive, guardie disattivazione nei due
rami + sblocco con secondo operatore, guardie rimozione sede con sede
temporanea ZZ creata/rimossa, delete: catena completa nell'ordine legacy
con popup verbatim e cleanup account, ripristino owner+zero residui) +
LIVE PHP (msg verdi identici, 'Operatore salvato', disattivazione bloccata
col messaggio esatto nomi-inclusi alla transizione — e conferma che senza
transizione il legacy salva, come il port —, delete popup di sessione
IDENTICO) + 35/35 marker + regressioni (staff-availability 16,
staff-for-service 6, cabins 20, services 40) + typecheck/lint puliti.

## AUDIT COMPLETO — Orari & chiusure (hours.php) (2026-07-06)

Audit funzionale completo di hours.php (875 righe) + assets/js/pages/hours.js
(279) vs hours-content.tsx + saveBusinessHours/saveClosure/saveException/
deleteClosureRange/deleteExceptionRange (manage-resources.ts) + route
resources. Prima esisteva solo il fix parziale calendario (0fd0d3f).
Bug trovati e corretti:
1. VALIDAZIONE AGGREGATA: il legacy accumula TUTTI gli errori — tab Orari
   'Orari non validi: ' + primi 8 uniti da '; ' (+' ...'), Chiusure
   'Impossibile salvare: ' + primi 3 uniti da spazio, Straordinari idem
   con primi 6 — il Next lanciava solo il PRIMO errore senza wrapper.
   Riscritte le tre save con raccolta errori nell'ordine legacy esatto.
2. MESSAGGI VERBATIM: dayLabels senza accenti ('Lunedi' vs 'Lunedì');
   'più breve' senza accento; conflitti chiusura/straordinario con testi
   inventati e date ISO — ora 'esistono già aperture straordinarie nelle
   seguenti date: d/m/Y ... Rimuovi prima lo straordinario o modifica le
   date.', 'esistono appuntamenti in sospeso o prenotati nelle seguenti
   date: ... Sposta o annulla prima gli appuntamenti.', 'le seguenti date
   sono impostate come chiuse: ... Rimuovi prima la chiusura (tab
   Chiusure) o modifica le date.' (hours_format_date_sample: max 6 date
   d/m/Y + ' ...'). Messaggi straordinari standalone ('Per un'apertura
   straordinaria devi compilare...', 'Formato orario spezzato non
   valido.') non più prefissati con 'Apertura straordinaria:'.
   Errori data legacy accumulati ('Seleziona una data di inizio.' + 'Data
   inizio non valida.' + 'Data fine non valida.').
3. SEMANTICA PHP: _time_to_minutes portato con (int) PHP ('aa:bb' = 00:00,
   '9:30' valido — normalizeTime li scartava trasformandoli in falsi
   "campo vuoto"); normalizeDate ora rifiuta le date rollate (2026-02-31
   non diventa più 03-03, come hours_parse_ymd); parseHoursRows salva solo
   i dow POSTati (raw strings); reason = kind + ' - ' + note senza
   troncature cleanName; fallback default = ensure_default_hours (Domenica
   chiusa, Sabato 09-13, altri 09-19 — il Sabato era 09-19).
4. COMPONENT: flash legacy con markup View::alert (d-flex align-items-start
   gap-2 + bi-info-circle) SOPRA il bs-page-header (era alert semplice
   sotto le pills); messaggi successo dei redirect ('Orari salvati',
   'Chiusura salvata', 'Chiusura eliminata', 'Straordinario salvato',
   'Straordinario eliminato') prima ASSENTI per chiusure/straordinari;
   porting integrale della validazione live hours.js (setCustomValidity +
   is-invalid + min dinamici + blocco submit con focus/reportValidity,
   testi 'Compila anche l'apertura'...); confirm 'Rimuovere l'orario
   spezzato per questo giorno?' sul Rimuovi settimanale (mancava); giorno
   chiuso = split e bottoni nascosti SENZA disabilitare/cancellare gli
   orari (il Next disabilitava gli input); reset forced-split alla
   chiusura del giorno; subtitle multi-sede ('Segue la sede selezionata
   nella barra superiore.'); bottone 'Attivita' gated su
   settings.location (canSettingsLocation nel GET della route); cambio
   tab = URL aggiornato (replaceState) + flash azzerato come la
   navigazione legacy. page.tsx: branch hours con initialQuery
   {tab, location_id, msg} per i deep-link legacy.
Verifica: battery NUOVA e2e-hours-page 37/37 (context+override sede,
salvataggi, giorno chiuso azzera orari, 8 validazioni orari verbatim
inclusi quirk PHP 'aa:bb' e troncamento a 8 errori, chiusure con
grouping/swap/conflitti straordinario+appuntamento scheduled/canceled,
straordinari con split e 5 validazioni, delete_range con/senza reason,
fallback Sabato 09-13; snapshot/restore integrale business_hours 14/14 +
closures/exceptions/clients ZZ a zero) + LIVE PHP byte-per-byte (alert
'Orari non validi: Lunedì: ...; Martedì: ...', 'Impossibile salvare:
Seleziona una data di inizio. Data inizio non valida. Data fine non
valida.', conflitti chiusura<->straordinario identici, redirect
msg=Chiusura%20salvata/Straordinario%20salvato/Chiusura%20eliminata/
Straordinario%20eliminato, live ripulito) + 62/62 marker + regressioni
(hours-calendar 4, resources 25, cabins-page 20, cabins-resources 14,
staff-page 27, staff-availability 16) + typecheck/lint puliti.

## AUDIT COMPLETO — Profilo attività (business_profile.php) (2026-07-06)

Audit funzionale completo di business_profile.php (475 righe) +
assets/js/pages/business_profile.js (444) vs business_profile-content.tsx +
saveBusinessProfile/uploadBusinessBrandingImage/saveBusinessBrandingPosition/
deleteBusinessBrandingImage (manage-business-settings.ts) + route
business-settings. Bug trovati e corretti:
1. MESSAGGI VERBATIM: 'Inserisci il nome attività.' e 'Il nome attività può
   contenere al massimo 190 caratteri.' erano senza accenti ("puo" del Chi
   siamo resta NON accentato: quirk del sorgente); errori upload legacy
   SENZA punto finale ('Logo troppo grande (max 5 MB)', 'Formato non
   valido: carica un file JPG o PNG', 'Formato non valido' secco per la
   cover, 'Upload non valido').
2. VALIDAZIONE 190 MORTA: clean(input,190) troncava il nome PRIMA del check
   di lunghezza → l'errore dei 190 caratteri era irraggiungibile; ora trim
   puro + check codepoint (nome esattamente 190 passa, 191 no).
3. WRAPPER ERRORI LEGACY nella route: profilo → 'Errore salvataggio profilo
   attività: {msg} (se persiste, controlla che lo schema business sia
   aggiornato e che il DB possa eseguire ALTER/UPDATE)'; upload/delete AJAX
   → {ok:false, errors:['Errore upload logo: ...']} / 'Errore rimozione
   logo/copertina: ...'; posizioni → 'Errore salvataggio posizione
   logo/copertina: ...'. Prima gli errori uscivano nudi.
4. MESSAGE NEI PAYLOAD: 'Profilo attività salvato', 'Posizione logo
   salvata', 'Posizione copertina salvata', 'Logo salvato', 'Immagine di
   copertina salvata', 'Logo rimosso', 'Immagine di copertina rimossa' —
   prima assenti (il component mostrava 'Operazione completata.').
5. ORDINE GUARDIE UPLOAD legacy: 'Rimuovi il logo/la copertina attuale...'
   PRIMA di 'Seleziona un file...' e dei check size/formato (prima il
   formato veniva controllato per primo).
6. COMPONENT riscritto: accenti UI ('Logo attività', 'Verrà visualizzato/
   mostrato/ridimensionato...'); flash globale View::alert SOPRA il page
   header con type INFO per i msg (default View::alert legacy, non
   success!) e danger per gli err + initialQuery {msg,err} (branch
   page.tsx); feedback per-kind negli alert branding-feedback (upload/
   delete AJAX come il legacy, non più alert globale); card pending 'Da
   salvare' con anteprima objectURL, nome file, size it 'X,X MB', bottone
   clear e testi 'Logo pronto - .. MB'/'Nessun nuovo logo selezionato.';
   validazione client verbatim ('File troppo grande: max 5 MB.', 'Formato
   non valido: carica JPG o PNG.'/'...JPG, PNG o WEBP.', 'Seleziona un
   logo/una copertina da salvare.'); selezione ignorata se immagine già
   presente; DRAG dell'anteprima con pointer events (clamp 0-100 +
   object-position live su <img>, prima era background statico senza
   drag); visibilità legacy branding-image-hidden sugli elementi
   without-image (prima dropzone e Salva restavano visibili col logo
   caricato); spinner 'Salvataggio...'/'Rimozione...'; dropzone
   is-dragover/is-disabled; bottone form nascosto 'Aggiorna'/'Carica'.
Residuo deliberato (già documentato nel codice): il legacy ricomprime con
GD e salva su filesystem; il Next carica l'originale su Cloudflare R2
(Amplify ha filesystem effimero) e valida il mime dichiarato.
Verifica: battery NUOVA e2e-business-profile 25/25 (context, save profilo +
3 validazioni col wrapper, nome esattamente 190, about→NULL, posizioni con
clamp e non-numerico→50, ciclo upload/guardia/delete logo e cover con
messaggi AJAX verbatim, delete senza immagine non fallisce; restore VIA API
così il sync marketplace torna coerente, stato finale CLEAN) + LIVE PHP
byte-per-byte (alert wrapper nome vuoto/>190, redirect 'Profilo attività
salvato'/'Posizione logo salvata', AJAX senza file, ciclo upload→guardia→
delete con 'Logo salvato'/'Logo rimosso', live ripulito) + 73/73 marker +
regressioni (locations 18, branding-r2 12 con aspettativa aggiornata al
wrapper, booking-settings 12) + typecheck/lint puliti.

## AUDIT COMPLETO — Sedi (locations.php, seconda passata) (2026-07-06)

Audit funzionale completo di locations.php (1253 righe) + assets/js/pages/
locations.js (711) + italy-geo.js vs locations-content.tsx + lib
manage-business-settings.ts + route business-settings. La V2 (2026-07-03)
aveva chiuso il backend; la UI era una versione funzionale ma NON fedele.
Bug/divergenze trovate e corrette:
1. WRAPPER ERRORI LEGACY nella route: 'Errore salvataggio marketplace sede:'
   (anche sulla validazione categorie, come nel try legacy), 'Errore upload
   gallery sede:', 'Errore rimozione foto gallery sede:', 'Errore
   ordinamento gallery sede:', 'Errore ordinamento sedi:', 'Errore
   salvataggio sede:' (solo errori non-validazione: le validazioni di
   sede_location_validation_error escono NUDE); 'Sede non valida per la
   gallery.'/'per il marketplace.' e 'Spostamento sede non valido.' nudi.
2. MOVE: flash legacy 'La sede e gia in posizione limite.' (msg SUCCESS,
   anche per id inesistente) / 'Ordine sedi aggiornato' via flag moved —
   prima il limite era silenzioso.
3. PREVIEW DELETE: block reason completato (': non viene eliminata per
   evitare perdita di dati.' mancava); shape exclusive/shared/
   clientReassignments esposta per il modale (calcolo P11 documentato).
4. MESSAGE nei payload di tutte le azioni ('Sede salvata', 'Marketplace
   sede aggiornato', 'Foto gallery sede caricate' + uploaded, 'Foto gallery
   sede rimossa', 'Ordine gallery sede aggiornato', 'Sede eliminata
   definitivamente'); iconClass legacy (activityCategoryIconSvg → mappa
   icon_key→classe bi-*, default bi-grid-3x3-gap) sulle categorie.
5. COMPONENT riscritto fedele:
   - flash View::alert (msg success/err danger) SOPRA il page header +
     initialQuery {msg, err, action, id} con deep-link
     action=delete_preview&id (branch page.tsx per locations E settings);
   - header actions btn-pill con bi-clock-history/bi-link-45deg;
   - tabella legacy: contatti testuali (telefono / 'WhatsApp: x' / email,
     '-' se vuoti — prima icone e ordine diverso), badge
     Visibile/Bloccata(+title gate piano)/Nascosta per Booking e
     Marketplace (prima Attivo/Disattivo senza gate), categorie con chip
     location-category-chip e 'Da impostare' warning, Ordine text-center
     con title 'Sposta su'/'Sposta giu', azioni Modifica/Marketplace/
     Elimina senza icone, empty 'Nessuna sede configurata.';
   - modale sede modal-xl col markup legacy: subtitle dinamico ('Aggiorna i
     dati e la visibilità della sede: NAME.'), label 'Nome sede', combobox
     Regione→Provincia→Città di italy-geo.js (pattern GeoCombobox: hidden
     non controllati + iniezione script a ogni apertura), CAP maxlength 20,
     placeholder social legacy, warning dinamico 'Disattivando le
     prenotazioni online, la scheda può restare accessibile ma i pulsanti
     Prenota non verranno mostrati.' (edit + marketplace visibile + booking
     deselezionato) o alert-danger di gate, bottoni 'Salva sede'/'Annulla'
     nel body — prima input di testo liberi e layout inventato;
   - modale Marketplace sede col pannello legacy: summary sede, switch
     Visibile + help, card categorie con icona/badge Principale/posizione,
     counter N/5, max 5 con alert legacy, dblclick = principale, guardia
     submit client ('...per rendere visibile la sede nel marketplace.',
     testo DIVERSO dal server); GALLERY legacy completa: grid card 'Foto
     N' con frecce e delete AJAX (confirm 'Rimuovere questa foto dalla
     gallery della sede?' + feedback nel modale), pending 'Da salvare' con
     anteprime objectURL/size it/rimozione singola/Svuota, dropzone con
     is-dragover, validazione client (alert 'Alcune foto non sono state
     aggiunte: ... supera 5 MB.'), 'Salva gallery' con spinner e '1 foto
     pronta - X,X MB totali'; move gallery = flash globale (redirect
     legacy) — prima un semplice input file con upload immediato;
   - modale eliminazione col markup legacy completo: kicker 'Sedi', titoli
     'Eliminazione definitiva sede'/'Impossibile eliminare la sede', alert
     'Non puoi eliminare NAME.', accordion 3 sezioni (Configurazioni della
     sede eliminate / Dati globali eliminati perche esclusivi / mantenuti
     perche condivisi) con badge e righe label+count, rendering clients
     riassegnati ('Riassegnato a', 'Attivita residue', 'Ultima attivita'),
     'Motivo eliminazione' con placeholder legacy, 'Scrivi ELIMINA per
     confermare' (senza disabilitare il submit client-side: 'Conferma non
     valida.' arriva dal server come nel legacy), footer 'Annulla'/'Elimina
     sede'; TABLE_LABELS completa verbatim (~90 voci + 'Dato collegato' —
     prima 18 voci con testi inventati).
Verifica: battery NUOVA e2e-locations-page 32/32 (context con iconClass,
4 validazioni nude, social @handle normalizzati, sort_order/marketplace_
enabled=0 su create, move con flash limite/swap/restore + direction e id
invalidi, marketplace wrapper + ordine/primary + troncamento a 5, gallery
0/senza file/gif/5MB coi wrapper + upload/move/delete con ricompattazione,
preview eliminabile vs Sede1 bloccata con reason verbatim completo, confirm
case-sensitive, delete con cleanup gallery/mappings e cliente ZZ
riassegnato a Sede1, 'Deve restare almeno una sede.'; restore CLEAN con
Sede1 intatta) + LIVE PHP byte-per-byte (err validazioni nudi, msg 'Sede
salvata' con instagram @handle normalizzato e sort/marketplace_enabled
identici, 'La sede e gia in posizione limite.' come MSG, wrapper
marketplace, 'Conferma non valida.', 'Sede eliminata definitivamente',
live ripulito) + 119/119 marker + regressioni (locations 18 e branding-r2
12 con aspettative aggiornate ai wrapper, booking-settings 12,
business-profile 25, shim /settings e flash ?msg= verificati) +
typecheck/lint puliti.

## AUDIT COMPLETO — Moduli consenso (consent_modules.php) (2026-07-06)

Audit funzionale completo di consent_modules.php (426 righe) +
assets/js/pages/consent_modules.js (70) + ConsentModules.php vs
consent_modules-content.tsx + consent_module_form-content.tsx +
manage-consent-modules.ts + route configuration. Bug/divergenze corrette:
1. ELIMINA SENZA CONFERMA (lista): il link Elimina puntava a ?action=delete
   mai gestito (click a vuoto) e il markup del modale era decorativo senza
   handler. Portato il MODALE legacy funzionante (consent_modules.js):
   titolo 'Eliminare il modulo "NAME"?', body diverso con/senza
   associazioni ('Questo modulo e associato a N cliente/i. Se prosegui,
   saranno rimosse le associazioni non firmate...'), bottone 'Elimina
   definitivamente' → delete + flash legacy ('Modulo consenso eliminato.' /
   '... Rimosse anche N associazione/i non firmate dai clienti.'). Stesso
   modale nel form (prima un window.confirm con testo inventato).
2. FLASH legacy assenti: lista e form ora leggono ?msg/?err (branch
   page.tsx con initialQuery, alert sotto il page header come il PHP);
   il save NON tornava alla lista ma nel legacy resta sull'EDIT col flash
   'Modulo consenso salvato con successo.' → redirect fedele (anche su
   NEW: action=edit&id=nuovo).
3. PAGE HEADER del form: il legacy usa SEMPRE 'Moduli consenso' con
   subtitle fisso e i bottoni [Lista moduli][Nuovo modulo]; il Next metteva
   il titolo del modulo nell'header e mancava 'Nuovo modulo'.
4. COLONNA DESTRA dell'editor (prima assente, dichiarata TODO):
   - 'Chiusura automatica del PDF' con consent_module_system_preview_text
     (informed: 'Data: {{data}}' + 'Firma cliente: ...'; sistema GDPR:
     '[ ] label' per ogni consenso privacy + data/firma, dal GET);
   - 'Anteprima contenuto' con 'Apri anteprima PDF': NUOVO endpoint
     action=preview_pdf che porta il preview legacy (dati demo Mario
     Rossi, fallback del blocco 'Beauty Suite S.r.l....' per
     {{dati_sede}}/{{Dati anagrafici}} vuote, snapshot + renderPrivacyPdf
     con footer del tipo, filename safe) e lo mostra nel modale iframe
     legacy 'Anteprima template PDF' via blob URL — funziona anche sui
     valori NON salvati del form come il legacy;
   - 'Variabili disponibili' (8 voci verbatim) + 'Workflow cliente'.
5. LISTA: 'Associato a N cliente/i' sotto lo slug (associationCounts nel
   GET, consent_module_count_associations); ensure del modulo di sistema
   (consent_module_ensure_system_gdpr: creazione al primo accesso col
   template del tenant + riparazione campi chiave) su lista e get;
   ordinamento legacy is_system DESC nel repo config; tipo fallback
   'Modulo consenso' (via le voci inventate 'Firma cliente'/'Modulo
   personalizzato'); date senza new Date() (niente shift TZ).
6. Rimossa la validazione client inventata 'Inserisci il nome del modulo.'
   (il legacy ha solo required browser; name vuoto via API → default
   'Modulo consenso', verificato).
Verifica: battery NUOVA e2e-consent-modules 18/18 (lista con sistema in
cima + counts, get con systemPreviewText/8 variabili, save con slug unici
-2/newline normalizzate/footer meta, name vuoto → default, body vuoto e
clone GDPR verbatim, sistema con forzature type/nome/attivo + mirror
businesses.gdpr_template_body, delete: sistema bloccato/draft rimossi con
count/firmati bloccati/inesistente, preview PDF %PDF sia informed sia
sistema; restore CLEAN con body GDPR 958 byte ripristinato ovunque) +
LIVE PHP byte-per-byte (redirect edit&msg=salvato, err inline body vuoto,
delete sistema/draft con suffisso count/firmato bloccato — con tenant_id
25 nei record manuali: anche il MySQL live è schema-shared —, preview=pdf
200 application/pdf, live ripulito) + 88/88 marker + regressioni
configuration verdi (quote/giftcard/giftbox/package settings 20/16/15/6,
client-sheets 26) + typecheck/lint puliti.

## AUDIT COMPLETO — Accessibilità (accessibility.php) (2026-07-06)

Audit funzionale completo di accessibility.php (539 righe) +
assets/js/pages/accessibility.js (38) vs accessibility-content.tsx +
manage-accessibility.ts + route accessibility. Era marcata "verificata già
completa": la seconda passata ha trovato DUE bug bloccanti e vari verbatim.
1. TZ PENDING (GRAVE, scoperto dalla battery): expires_at/created_at delle
   verifiche email erano scritti con NOW() del DB (UTC su Supabase) ma
   riletti in ora locale → i codici risultavano GIA' SCADUTI alla nascita
   (verifica email impossibile) e il cooldown dei 60s non scattava mai.
   Fix: timestamp espliciti in ora locale del server Node (come date() in
   PHP) in storeAndReturnCode e sendStaffInviteEmailCode.
2. EMAIL DEL CODICE MAI INVIATA: i flussi verify/change/resend salvavano il
   codice senza spedirlo (in produzione l'utente non l'avrebbe mai
   ricevuto; l'invito staff invece lo spediva). Fix: invio con subject/
   intro legacy per flusso ('Conferma email account' / 'Conferma cambio
   email', intro nuove per il resend), mittente businesses name/email,
   template moderno; su fallimento pending rimossa + flash legacy 'Invio
   codice fallito (controlla mail() del server)'. Con SES non configurato
   (dev) il codice resta esposto nel payload per i test.
3. MESSAGGI VERBATIM (il legacy NON ha il punto finale su quasi tutti):
   'Codice inviato alla tua email/alla nuova email', 'Codice reinviato',
   'Email verificata', 'Password aggiornata', 'Email non valida', 'L email
   e gia questa', 'Password attuale non corretta', 'Email gia utilizzata da
   un altro account o operatore', 'Inserisci il codice', 'Nessuna richiesta
   di cambio email attiva', 'Codice scaduto: richiedi un nuovo codice',
   'Codice non valido', 'Compila tutti i campi password', 'Le nuove
   password non coincidono', 'La nuova password deve avere almeno 8
   caratteri' — con la sottigliezza legacy: 'Email non valida: richiedi un
   nuovo codice' senza punto nel confirm (316) e CON punto nel resend (264).
4. ORDINE GUARDIE: il cooldown va controllato PRIMA delle validazioni
   (accessibility_enforce_code_cooldown in testa) — prima 'Email non
   valida' vinceva sul 'Attendi N secondi'; change_password con l'ordine
   legacy campi-vuoti → coincidenza → lunghezza (mb_strlen) → password
   attuale (prima la lunghezza era dopo il check password).
5. 5° TENTATIVO: al raggiungimento del limite il flash legacy è 'Troppi
   tentativi non validi. Richiedi un nuovo codice.' — prima usciva sempre
   'Codice non valido.' anche quando la pending veniva azzerata.
6. COMPONENT: port di accessibility.js (countdown 'Reinvia tra Ns' che
   scala e riabilita il bottone; avviso 'Il codice e scaduto. Reinvia un
   nuovo codice.' allo scadere del TTL — prima markup statico morto);
   flash View::alert SOPRA il page header + initialQuery {msg, err}
   (branch page.tsx); pending expiresAt/createdAt normalizzati server-side
   in ora locale e display d/m/Y H:i senza Date.parse.
Verifica: battery NUOVA e2e-accessibility 34/34 su UTENTE ZZ DEDICATO
(l'account reale mai toccato): GET, cooldown sui 3 flussi con ordine
guardie, 4 tentativi 'Codice non valido' + 5° con messaggio dedicato e
pending rimossa, confirm/resend/codice vuoto senza pending, verifica
completata con email_verified_at + needsEmailVerification false (cookie
riscritto: verificato con nuova sessione), guardie cambio email in ordine
(invalida/uguale/password vuota/errata/email di un altro account), codice
scaduto con cleanup in GET, resend dopo cooldown che invalida il codice
precedente, cambio email applicato, cambio password con 4 errori in ordine
+ login con nuove credenziali; RESTORE CLEAN (utente ZZ e verifiche
rimossi, account reale intatto) + LIVE PHP byte-per-byte (10 redirect err
identici + 'Invio codice fallito (controlla mail() del server)' con
pending auto-ripulita, live pulito) + 40/40 marker + regressioni
(auth-roles 16, staff-page 27) + typecheck/lint puliti.

## AUDIT COMPLETO — Ruoli (roles.php) (2026-07-06)

Audit funzionale completo di roles.php (310 righe) + assets/js/pages/
roles.js (153) + RolePermissions.php (584) vs roles-content.tsx +
lib/role-permissions.ts + route permissions. La V6 aveva verificato il
MOTORE permessi (can/parents) e l'auth; la PAGINA aveva bug reali:
1. SEZIONE PACCHETTI MAI RENDERIZZATA: buildGroupTrees scartava le
   definizioni non assegnabili PRIMA di costruire l'albero, ma nel gruppo
   Pacchetti ogni nodo discende dalla radice non assegnabile
   'packages.manage' (il padre legacy) → nessuna root → sezione vuota.
   Port fedele di groupedTree+renderPermNode: l'albero include le radici
   non assegnabili come contenitori, i nodi assegnabili si renderizzano
   col livello legacy ($childLevel = assignable ? level+1 : level), un
   tree entra solo con almeno un nodo assegnabile; display_parent
   esplicito (anche '') vince, poi parent, poi il primo dei parents
   presente nel catalogo (alias assente → radice); ordinamento
   sort_order poi label.
2. SUBMIT SENZA FEEDBACK: il salvataggio non mostrava né successo né
   errori (.catch vuoto) — ora flash legacy 'Permessi {Staff|Altro}
   aggiornati' (verbatim, senza punto), errori server (validazione modulo
   'Per attivare Pacchetti seleziona almeno una funzione del modulo.' /
   'Impossibile aggiornare i permessi: verifica schema DB e riprova.')
   come alert danger; via l'alert validationError non-legacy nella card.
3. LABEL SENZA ACCENTI nel catalogo Next: 'Disponibilità', 'Profilo
   attività', 'Accessibilità' (il legacy sincronizza i label accentati
   nella tabella permissions via ensureDb).
4. FLASH + deep-link: initialQuery {msg, err, role} (branch page.tsx),
   flash View::alert PRIMA del page header, cambio ruolo = URL ?role=
   aggiornato (replaceState) + flash azzerato come la navigazione legacy.
NON-GAP verificati: normalizeSelectedPerms/validateSelectedPerms/can/
isInheritedFromAssigned/moduleAccessRules identici al PHP;
autoEnableParentRules legacy è VUOTO → il ramo auto-parent di roles.js
è morto anche nel legacy (il Next senza è equivalente); il POST invia le
selezioni dirette come il form legacy (disabled non postati) e il server
normalizza gli ereditati; audit log già completo nella route (actor,
old/new ordinati, skip senza modifiche, best-effort).
Verifica: battery NUOVA e2e-roles-page 16/16 (GET con label accentati e
gruppi nell'ordine legacy, ruolo invalido→staff, save base, figli
ereditati rimossi dalla normalizzazione, packages.access auto dal figlio,
validazione modulo verbatim, non-assegnabili/sconosciuti filtrati, audit
con actor + NESSUNA riga su save identico, ruolo altro; snapshot/restore
integrale role_permissions + audit) + LIVE PHP byte-per-byte (redirect
'Permessi Staff aggiornati' con normalizzazione identica clients.manage
senza figlio ereditato, err modulo verbatim, 'Permessi Altro aggiornati'
con packages.access auto; live ripristinato) + 35/35 marker + regressioni
(auth-roles 16, residui-check 8) + typecheck/lint puliti.

## AUDIT COMPLETO — Automazione (automation.php, seconda passata) (2026-07-06)

Audit funzionale completo di automation.php (537 righe) vs
automation-content.tsx + automation-reminders.ts + route automation. La V7
aveva fixato i gap gravi del backend (reminders mai creati, save su route
inesistente); la PAGINA aveva ancora molti dati FINTI:
1. SALDO CREDITI SMS hardcoded '0 crediti' (card + modale): ora dal wallet
   reale (sms_credit_wallet del tenant, port sms_credit_wallet_row) — era
   il differito "saldo SMS reale" di V7.
2. BADGE 'Stato promemoria SMS' hardcoded 'Attivo' verde: ora dai settings
   salvati (Attivo/Disattivo come il legacy).
3. ESEMPI email/SMS hardcoded ('Puoi annullare ... fino a 24 ore prima.'
   fisso): ora costruiti server-side col port di
   booking_customer_cancel_policy (Helpers 5384-5416) — notice email
   'Puoi annullare l'appuntamento fino a {label} prima.' / 'fino
   all'inizio dell'appuntamento.' / ASSENTE con policy off, notice SMS
   'Annulla entro {label}.' / 'Annulla fino all'inizio.', singolare/
   plurale (1 ora/N ore, 1 giorno/N giorni), clamp 365gg/8760h; nome
   attività reale (fallback 'La mia attivita') al posto di 'elite' fisso.
4. COSTO STIMATO hardcoded '1 credito': ora da smsSegmentCount (port GSM-7
   di sms_credit_segment_count: basic 1 unità/extended 2, 160/153; UCS-2
   70/67) sul testo d'esempio reale; l'avviso 'Crediti SMS insufficienti'
   era mostrato SEMPRE — ora solo con promemoria SMS attivo e saldo
   insufficiente (condizione legacy).
5. PACCHETTI SMS hardcoded (4 piani copiati): ora dal listino centrale
   saas_sms_plans (attivi, sort legacy, featured='Consigliato' e default
   selezionato, prezzi number_format it '17,50 EUR' e per-credito a 4
   decimali '0,0700 EUR', descrizione) con gli stati legacy 'Nessun
   pacchetto SMS disponibile al momento.' / 'Pacchetti SMS momentaneamente
   non disponibili.'.
6. FIDELITY: il toggle era SEMPRE disabled col warning fisso — ora
   fidelityCardExpiryReminderConfig (port di fidelity_card_default_
   validity_config + renewal_window_config da fidelity_adhesion_json,
   value effettivo 0 a interruttore spento, clamp finestra, label
   legacy '6 mesi'/'30 giorni') decide warning vs box 'Configurazione
   attuale: durata tessera X • finestra rinnovo Y.' e abilita il toggle;
   il save ora INVIA il flag e la lib applica la guardia legacy
   (automation.php 48): salvato 1 solo con config ok, azzerato quando il
   POST non lo contiene (form completo legacy) — prima il flag non veniva
   mai inviato e in lib veniva toccato solo se presente.
7. FLASH legacy: 'Automazione salvata' come View::alert SOPRA il page
   header (prima alert dentro il form) + initialQuery ?msg= (branch
   page.tsx) + scroll top; rimosso il fetch delle rules generiche non
   più usato dal prefill.
Verifica: battery NUOVA e2e-automation-page 18/18 (context con saldo/
piani/formattazioni/fidelity-off, 4 varianti cancel policy incl.
singolare e policy off, wallet dinamico, save con ore+toggle+sender
Prenodo, guardia fidelity con config non ok, fallback ore invalide
7→24 e 99→eredita, fidelity configurata → labels e flag salvabile, POST
senza flag → azzerato; snapshot/restore integrale con save API finale
che rischedula coi valori originali) + LIVE PHP byte-per-byte (esempi
con notice 24 ore/1 ora... encodate h(), 'fino all'inizio', policy off,
redirect msg=Automazione salvata, fallback sms hours 99→12 eredita
email, saldo '0 crediti' e 'Costo stimato: 1 credito'; live ripristinato
riga-per-riga incl. sms_reminder_enabled del tenant) + 77/77 marker +
regressioni (notifications-automation 19, fidelity-membership-settings
29) + typecheck/lint puliti.

## AUDIT COMPLETO — Report (reports.php, seconda passata) (2026-07-06)
Verificato contro reports.php + reports.js + PHP live con dati gemelli
(vendite/costi/commissioni ZZ gennaio 2019, poi ripristinato). Bug reali
trovati e corretti:
- **Sede di sessione ignorata**: la route non filtrava sulla sede corrente
  (il legacy usa app_current_location_id con fallback alla PRIMA sede
  autorizzata; all_locations estende alle autorizzate — con 1 sola sede il
  filtro resta e la label mostra il nome). Ora locationId dal contesto sedi
  + `locationLabel` nel payload ('Sede1'/'Tutte le sedi autorizzate'/
  'Sede #N'/'Tutte le sedi') per il sottotitolo composito legacy
  (`Preset / dal - al / Sede / Grafici per giorno [/ Confronto ...]`).
- **Comparison senza costi/commissioni**: aggiunti costsTotal/
  commissionsTotal (chiusure costSummaryFor/commissionSummaryFor sul
  periodo di confronto) + serie daily/appointmentTrend del confronto per i
  dataset tratteggiati 'Periodo precedente' dei grafici trend.
- **Grafici non fedeli a reports.js**: riscritti — trend con ZERO-FILL
  dell'intero periodo e bucket legacy (weekly di 7gg dall'inizio range con
  label 'd/m - d/m' clippata, monthly 'm/Y'), allineamento serie confronto
  ($alignCompareSeries), finance e tipologie DOUGHNUT cutout 62% bordo
  bianco, metodi di pagamento/top/età BAR ORIZZONTALI con palette ciclica
  borderRadius 5, tooltip it-IT (€, 'Utilizzi: N', 'Movimenti: N', % genere),
  moneyShort/integerShort sugli assi, legend bottom pointStyle solo con
  confronto, empty-state 'Nessun dato disponibile nel periodo selezionato.',
  Chart.defaults font Inter/#344054.
- **Tipologie donut**: classificazione port fedele di $itemTypeLabel (il
  NOME vince su GiftCard/GiftBox/Ricarica/Pacchetto per i tipi non-service),
  composition raggruppata per tipo+nome, 'Voce'→'Altro', esclusi i tipi a 0
  (Prodotto sempre presente). Confermato sul live: type product + nome
  'GiftCard X' → fetta GiftCard.
- **Formatter it**: number_format manuale (toLocaleString non raggruppa
  1000-9999), $qtyFmt/$hoursFmt/$intFmt nei KPI e nei 3 modali (badge tipo
  text-bg-light, Quantità, fw-semibold sul Totale, contatori 'N risultati').
- **Delta KPI legacy**: formatDeltaInfo port completo (is-good/is-bad/
  is-flat, '±€ X (±Y,Z%)', 'Nuovo rispetto al confronto', 'Non confrontabile'
  requires_both per scontrino medio, goodWhenUp=false per Costi/Commissioni)
  reso con markup report-delta + bi-arrow-left-right nei KPI e nel finance
  summary (mt-1). Verificato 1:1 col live (id-good per costi in calo).
- **Markup**: rimosse 5 card tabellari extra non-legacy; 'Movimenti incasso'
  solo se >0; 'Profilo clienti {sede minuscolo}'; età media a 1 decimale
  ('31,0 anni'); bottoni 'Mostra altro' (btn-outline-primary bi-search)
  condizionali nei 3 pannelli top; righe Costi/Commissioni del finance
  summary solo coi permessi.
- **TZ preset**: resolveRange/compare window in date LOCALI (localYmd) con
  clamp giorno legacy (makeYmd) su mesi/anni; deep-link ?range=&from=&to=&
  granularity=&compare=&compare_mode=&compare_month=&compare_from=&compare_to=
  letti dal page.tsx (initialQuery) e riscritti con replaceState al submit.
Battery: e2e-reports-page.mjs 15/15 (sede default/all_locations/label,
tipologie per nome, comparison costi+serie, deep-link SSR) + regressione
e2e-reports.mjs 20/20, baseline CLEAN; live MySQL ripristinato (0 residui);
114/114 marker bundle; typecheck/lint puliti.

## AUDIT COMPLETO — Booking admin (booking.php manage mode) (2026-07-06)
Verificato contro booking.php (modalità manage, righe 2860-2940 POST +
8740-8830 markup) + booking.js (syncCustomerCancelFields) + PHP live
(POST reale con clamp e flash, poi ripristinato). Bug reali corretti:
- **Sidebar "Booking" apriva il wizard PUBBLICO**: la route dedicata
  app/[tenantSlug]/booking/page.tsx rendeva sempre BookingFaithful; nel
  legacy page=booking SENZA public=1 è la pagina ADMIN delle impostazioni
  (requirePerm booking.manage). Ora il /slug/booking "nudo" con sessione
  gestionale rende ManageShell+BookingSettingsContent; senza sessione →
  redirect al login manage; i link pubblici (public=1/start/hub/confirmed/
  mode/service_ids/location_id/book_*) continuano a servire il wizard.
- **Campi "Tempo minimo per annullare" sempre attivi**: booking.js li
  disabilita quando l'annullamento cliente è spento → disabled legato al
  checkbox.
- **Flash legacy**: il salvataggio mostrava un alert inline nel form; il
  legacy fa redirect a ?msg=Impostazioni booking salvate con View::alert
  SOPRA il pageHeader (danger se il msg contiene 'non'/'chiusi', quirk
  incluso). Ora flash top + replaceState ?msg= + scroll, e deep-link ?msg=
  letto dalla route (initialQuery) per i redirect legacy proxati.
- **Wrapper errore verbatim**: 'Errore salvataggio impostazioni booking:
  {inner} (verifica schema o permessi ALTER TABLE)' nella route API.
- **Fallback nome**: card link con setting_get('name','La mia attività')
  → 'La mia attività' invece di '—'.
Già fedeli (confermati): clamp legacy (>=0, hours<=8760, days<=365, unit
fallback hours), permesso booking.manage|settings.general, prefill da
businesses, markup form (id, btn-pill, form-text con strong).
Battery: e2e-booking-admin.mjs 9/9 (prefill, clamp/checkbox off, 401,
flash SSR sopra header success/danger, markup, link ?public=1) + regressione
e2e-booking-settings.mjs 12/12, RESTORE CLEAN; live PHP: POST 99999 ore →
302 ?msg=Impostazioni booking salvate + DB 8760 + flash alert-success
sopra bs-page-header, poi ripristinato (0/1/24/hours); wizard pubblico
verificato raggiungibile (public=1/start/hub/book_prepaid) e /booking nudo
anonimo → 307 login; 31/31 marker bundle; typecheck/lint puliti.

## AUDIT COMPLETO — Booking pubblico del MARKETPLACE (booking.php public + public_account.php) (2026-07-06)
Verificato contro booking.php (gate 9307-9340, confirmed screen 8889-9152,
bottom nav 13413), booking-wizard.js (hasBenefitsAvailable 761,
syncProgress 3140-3174, showStep 3212, fillClientStepFromUser 4631,
refreshCustomerUI 4782), public_account.php (account_next_key /
account_booking_params / account_after_auth_url 54-120) + live PHP con
account cliente ZZ reale (creato e rimosso). Bug reali corretti:
- **GATE mancante (divergenza V5 ora allineata)**: il legacy OBBLIGA il
  login cliente: start/my/hub/... senza sessione → 302 al login CENTRALE
  (/account/login?tenant=&next=[&location_id]), tab=register → register;
  public=1 nudo/showcase/products → 302 /attivita/<slug>. Il Next rendeva
  il wizard a chiunque. Ora la route /slug/booking applica il gate
  server-side (currentPublicCustomerSession): confirmed=1 resta senza gate
  (chiave=code); i target dell'area cliente per-tenant (hub/my/quotes/
  packs/prepaids/credit/giftcards/giftboxes/preorders/fidelity/gifts/
  profile/settings) da loggato vanno alle pagine account CENTRALI del port
  (/account, /account/appointments, /account/quotes, /account/packages,
  /account/profile) — l'hub per-tenant legacy nel port è l'area centrale
  (decisione architetturale V5, ora instradata coerentemente).
- **destination() post-auth ignorava tenant+next**: login/verify centrale
  atterravano sempre su `return` (/attivita) — il flusso marketplace →
  login → WIZARD si rompeva. Port di account_after_auth_url in
  account-auth-destination.ts (start→wizard+location_id, mapping target,
  showcase→/attivita/<slug>, next sconosciuto→start, senza tenant→return
  sanificato); login propaga tenant/location_id anche al verify step.
- **Step counter/progress**: il Next mostrava sempre 'Step X di 7'; il
  legacy nasconde 'Vantaggi' (d-none) quando hasBenefitsAvailable()=false
  → contatore 'di 6', skip 6→7 all'avanti e 7→5 all'indietro con azzeramento
  selezioni benefit. Port completo (fidelity_preview caricata al variare
  del carrello, non più solo allo step 6).
- **Wizard cieco all'account**: nessun prefill; ora port di
  refreshCustomerUI/fillClientStepFromUser: dati cliente precompilati
  dall'account (solo campi vuoti, split full_name), email READONLY da
  loggato, bottone header 'I miei appuntamenti' (→/account/appointments) /
  'Accedi' (→login centrale con tenant+next).
- **Schermata di conferma NON legacy**: c'era un alert inline nello step 7;
  il legacy rende la pagina dedicata ?confirmed=1 (confirm-modal: check,
  'Richiesta inviata', 'In attesa di approvazione. Ti avviseremo via
  email.', 'CODICE PRENOTAZIONE #', date-box con mese INGLESE date('M'),
  'd/m/Y, H:i', titolo '+N servizi', Aggiungi al calendario/Stampa,
  Operatore/Posizione/Cliente, Dettaglio costi con righe sconto
  Coupon/Fidelity/Credito/GiftCard, 'Pagamenti e crediti € 0,00',
  'Saldo dovuto', bottom nav). Port completo client-side.
- **Bottom nav 'Home' puntava all'ADMIN**: /slug/booking nudo (= pagina
  impostazioni manage) invece del profilo marketplace /attivita/<slug>
  (booking.php 13414); 'Pannello' ?hub=1 ora instradato dal gate.
RESIDUI DELIBERATI: (a) /api/booking confirm resta guest-friendly a
livello API (il gate legacy è sulla pagina; l'upsert account V5 copre il
linking) — il flusso UI è comunque login-gated; (b) la schermata confirmed
è client-state: il RELOAD di ?confirmed=1&code non rilegge i dettagli dal
DB (il legacy sì); (c) hub/my/... per-tenant → area account centrale.
Battery: e2e-booking-marketplace.mjs 26/26 (gate anonimo 7 casi, register
devCode→verify→sessione, prefill me, wizard loggato con 'Step 1 di 6' +
benefits d-none SSR, mapping loggato 5 target, unit accountAuthDestination
7 casi, cleanup account Supabase CLEAN) + regressioni e2e-public-area
14/14, e2e-booking-settings 12/12, e2e-booking-admin 9/9; live PHP:
redirect catturati 1:1 (302 /attivita, 302 login centrale con tenant+next,
post-login 302 wizard con customer_handoff, wizard loggato 'Step 1 di 6');
account ZZ live rimosso; 64/64 marker bundle; typecheck/lint puliti
(8 errori lint pre-esistenti nel wizard, invariati).

## AUDIT COMPLETO — MARKETPLACE pubblico (public_marketplace.php, seconda passata) (2026-07-06)
Verificato contro public_marketplace.php (2099 righe: routing 15-50, vista
ricerca 1720-1892, card 1836-1885) + snapshot live di lista/ricerca/
dettaglio/sede. Bug reali corretti:
- **Pagina RICERCA inesistente**: /attivita/ricerca?city=... (target della
  search bar, delle city-card e dei filtri) finiva nel dettaglio attività
  "ricerca" (inesistente). Nuova route app/attivita/ricerca + alias legacy
  cerca|risultati (public_marketplace.php 30) + componente
  marketplace-search-faithful: breadcrumb 'Home > Ricerca', titoli dinamici
  con precedenza legacy (city 'Attività disponibili a X' > service
  'Attività per "Y"' > q 'Risultati per "Z"' > category 'Attività per C' >
  'Tutte le attività disponibili'), sottotitoli, toolbar 'N risultato/i
  trovato/i|disponibili.', bottone Filtri con modale (form GET
  q/città/categoria + service hidden, datalist città, Cerca/Reset), empty
  'Nessuna attività trovata', results-grid di result-card per SEDE
  (preferiti, cover/logo initial, Dove:/Categorie:, Prenota via login
  centrale, Scheda alla pagina sede). Titoli confermati 1:1 col live
  (&quot; incluse).
- **Scheda SEDE 404**: /attivita/<slug>/sedi/<citta-nome-id> (link 'Scheda'
  e media delle card legacy) cadeva nel catch-all manage (307 login!).
  Nuova route con estrazione dell'id dal suffisso; MarketplaceDetailFaithful
  accetta locationId e la sede selezionata guida booking link, indirizzo e
  preferiti (fallback prima sede).
- **Card lista non fedele**: 'Scheda' e il media linkavano /attivita/<slug>
  invece della scheda sede; la meta mostrava la categoria SERVIZI ('genera')
  invece della categoria ATTIVITÀ della sede ('Unghie'). API /api/marketplace
  estesa con activityCategories/categoryText per sede (join
  marketplace_location_activity_categories + marketplace_activity_categories,
  is_primary/sort_order).
- **Login/register da GIÀ loggato mostravano il form**: il legacy
  (public_account.php 213) redirige subito alla destinazione post-auth.
  Ora al mount /api/account -> user -> replace(accountAuthDestination(...)).
RESIDUO DELIBERATO: i risultati/card sono client-side (SSR mostra 0 e i
conteggi con i commenti React) come le altre pagine marketplace del port;
cover/logo reali delle card usano il fallback initial (branding live
per-card legacy marketplace_profile_with_live_branding non portato).
Battery: e2e-marketplace.mjs 15/15 (API categorie sede, directory, titoli
dinamici e precedenza, filtri, alias, scheda sede) + regressioni
e2e-public-area 14/14 e e2e-booking-marketplace 26/26 CLEAN; live PHP
confrontato (titoli h1 verbatim, '1 risultato/i trovato/i.', card 'Unghie',
link /sedi/altino-sede1-21); 88/88 marker bundle su lista+ricerca+sede;
typecheck pulito, lint con i soli pattern-fedeli pre-esistenti (<a> verbatim).

## MARKETPLACE — TERZA PASSATA: comportamenti JS cablati (segnalazione utente) (2026-07-06)
L'utente ha segnalato: ricerca non simile, menu che non funziona, scheda
attività non simile. Verificato contro MarketplaceTopbar.php
(marketplace_topbar_script 472-856: treatment picker, suggerimenti città,
initAccountMenus) + public_marketplace.js (419 righe: preferiti, share,
city-image, object-position, filtri) + markup menu loggato
(public_marketplace.php 1005-1066). Fix:
- **Menu topbar MORTO**: il dropdown 'Menu' era markup statico; ora
  components/public/marketplace-shared.tsx MarketplaceAccountNav cablato su
  tutte e 3 le pagine: toggle con chiusura su click-fuori/Escape; da
  SLOGGATO 'Promuovi la tua attività' + Menu (Accedi/Registrati con
  return); da LOGGATO chip avatar/nome/email con Attività(/account/
  activities)/Preferiti(/account/favorites)/Profilo(/account/profile)/Esci
  (logout API + redirect /attivita, markup marketplace-account-chip legacy).
- **Ricerca non simile**: (a) la hero della home NON navigava (preventDefault
  + filtro in-place) — ora il form GET naviga a /attivita/ricerca come il
  legacy; (b) le chips 'Servizi più cercati' filtravano client-side — ora
  sono LINK a /attivita/ricerca?category=; (c) il treatment picker della
  topbar (ricerca+dettaglio) era statico — port 1:1 di
  marketplace_topbar_script (tab Categorie/Attività/Servizi, filtro,
  scelta -> hidden inputs); (d) i suggerimenti città erano morti — port
  completo: dataset = città sedi pubblicate + comuni italy_geo.json +
  preferite (publicSearchCitySuggestions), pannello suggerimenti (max 8),
  validazione submit 'Seleziona una città dalla lista.' (setCustomValidity).
- **Preferiti morti** su tutte le card: cablati (toggle_favorite con payload
  legacy, 401 -> login, is-active/aria sync su tutte le card con la stessa
  key, stato iniziale da favoriteKeys del GET /api/account).
  BUG POSTGRES trovato dal test: togglePublicCustomerFavorite usava
  'DELETE ... LIMIT 1' (MySQL-only) -> la RIMOZIONE di un preferito
  falliva sempre ('syntax error at or near LIMIT'). Fix: DELETE per PK.
- **Share scheda**: 'Condividi scheda' cablato (navigator.share ->
  fallback clipboard con 'Link copiato' 1600ms is-copied, come il legacy).
- **Sfondi city-card + object-position**: applicati (--city-image CSS var
  e objectPosition dai data-attr, port di public_marketplace.js 13-25).
- **Scheda attività**: la card Contatti (salon-contact-actions con Chiama)
  e salon-service-book ESISTONO già (il diff SSR ingannava: sono
  client-side); aggiunti gli effetti condivisi (share/picker/città).
Battery: e2e-marketplace.mjs estesa 24/24 (F: italy_geo.json servito,
toggle preferito ON/OFF round-trip, favoriteKeys nel GET, user per il menu
loggato, 401 anonimo, logout, hero GET + chips link) + regressioni
e2e-booking-marketplace 26/26 e e2e-public-area 14/14 CLEAN; 100/100
marker bundle (inclusi 'Rimuovi dai preferiti', 'Seleziona una città dalla
lista.', 'Link copiato', chip menu loggato); typecheck pulito, lint solo
pattern-fedeli pre-esistenti.

## MARKETPLACE — QUARTA PASSATA: home filtri navigano + account cliente centrale rifatto (segnalazione utente) (2026-07-06)
L'utente ha segnalato: (1) in home i filtri aggiornano il contenuto invece di
portare alla pagina di ricerca (come nel PHP); (2) l'account cliente
(/account/*) è totalmente diverso dal PHP. Verificato contro
public_marketplace.php (home 1897-1997) + public_account.php (modi
activities/favorites/profile) + PHP live.
- **Home filtri**: la home filtrava le card in-place (filteredCards) e la
  hero faceva preventDefault. Il legacy mostra SEMPRE tutte le attività
  (count($profiles)) e la ricerca avviene su /attivita/ricerca. Fix: la
  griglia "Le nostre attività" mostra sempre allCards; il form hero fa GET
  → /attivita/ricerca; le chips 'Servizi più cercati' sono link category
  ('Tutti' sempre active); input città non controllato (suggerimenti +
  validazione dal DOM); empty-state legacy 'Nessuna attività pubblicata /
  Configura la visibilità marketplace da Profilo attività...'.
- **Account cliente centrale RIFATTO**: il Next serviva a /account/* la
  dashboard residui a sidebar (12 sezioni aggregate su tutti i tenant),
  mentre il PHP central account è topbar marketplace + chip account
  (Attività/Preferiti/Profilo/Esci) + un account-panel con 3 pannelli.
  Nuovo components/public/account-faithful.tsx (port 1:1 di public_account.php):
  - Attività: grid attività collegate (logo iniziale, chip sedi, 'Apri area
    cliente'→hub per-tenant, 'Scheda'→profilo), empty 'Nessuna attività
    collegata.'.
  - Preferiti: favorite-grid con 'Scheda'/'Prenota'/'Rimuovi' (remove_favorite
    → 'Preferito rimosso.'), empty 'Nessun preferito salvato.'.
  - Profilo: form update_profile (nome/cognome/telefono, email readonly →
    'Profilo aggiornato.') + form change_password (attuale/nuova/conferma →
    'Password aggiornata.'), con account-section-divider e testi verbatim.
  Route /account, /account/activities, /account/favorites, /account/profile →
  AccountFaithful; /account → /account/activities. La dashboard residui
  (PublicAccountPage) resta l'HUB per-tenant, raggiunta da 'Apri area cliente'
  e dai target hub/my/packs/... del gate booking (hub ora → /account/appointments,
  non più /account).
- **Gate booking**: public=1 "nudo" da LOGGATO ora → /attivita/<slug>
  (showcase default, booking.php 9188+9307) come da anonimo, non più /account.
- **BUG Postgres**: (già dalla terza passata) DELETE...LIMIT nei preferiti.
Battery: e2e-account-faithful.mjs 15/15 (home naviga, 3 pannelli, update_profile
+ change_password + remove_favorite round-trip, password errata gestita) +
regressioni e2e-marketplace 24/24, e2e-booking-marketplace 26/26,
e2e-public-area 14/14 (tutte CLEAN); struttura confrontata 1:1 col PHP live
(account-page/panel, eyebrow 'Account cliente', h1+subtitle, empty-state,
2 form profilo); 46/46 marker account + 100/100 marketplace + 64/64 wizard;
typecheck pulito.

## MARKETPLACE — QUINTA PASSATA: fedeltà GRAFICA account cliente (segnalazione utente) (2026-07-06)
L'utente ha segnalato che l'account cliente graficamente non è uguale al PHP.
Analisi CSS completa: public_account.php carica `app.css` (base: btn/form/
alert/body/reset) + `public_account.css` (:root vars + layout account:
account-page/main--wide/panel/activity-grid/favorite-grid/profile-form) +
`marketplace_topbar_style()` inline. Il componente Next caricava invece
`public_marketplace.css` (per lista/dettaglio) + TOKEN/FOOTER style, SENZA
app.css → mancavano tutti gli stili base (bottoni/form/tipografia) e la
pagina risultava visivamente rotta. Fix:
- account-faithful.tsx ora carica ESATTAMENTE come il PHP: /assets/css/app.css
  + /assets/css/pages/public_account.css + TOPBAR_STYLE inline; rimossi
  public_marketplace.css, TOKEN_STYLE, FOOTER_STYLE (public_account.css
  definisce già tutti i :root: --brand/--ink/--line/--bg/--marketplace-page-*/
  --marketplace-shell-max).
- Aggiunto l'input filtro `marketplace-topbar-treatment-search` nel dropdown
  del picker (account + ricerca) che mancava → DOM skeleton ora identico al
  PHP (topbar + treatment panel).
Verifica: skeleton DOM (tag+classi) di /account/activities confrontato 1:1 col
PHP live (topbar → treatment picker → panel), unica differenza risolta era il
filter input. 46/46 marker account + 100/100 marketplace, batterie
e2e-account-faithful 15/15, e2e-marketplace 24/24, e2e-booking-marketplace
26/26, e2e-public-area 14/14 CLEAN; typecheck pulito.

## MARKETPLACE — SESTA PASSATA: audit grafico completo (titoli, picker categorie/salons, CSS per pagina) (2026-07-06)
Audit sistematico di TUTTE le pagine marketplace (/, /attivita, ricerca,
dettaglio, sede, auth) con diff CSS + DOM skeleton + testi vs PHP live.
Delta trovati e corretti:
- **Titoli <title>**: root era "BeautySuite - Prenota..." → "Cerca attività"
  (legacy); le 5 pagine auth (login/register/verify/forgot/reset) avevano
  titoli diversi → "Area cliente - BeautySuite" (unico titolo legacy per
  tutte); scheda dettaglio/sede: il tab mostra ora il NOME attività ("elite")
  via document.title client-side (era lo slug), come il legacy server-side.
- **Picker ricerca nelle pagine AUTH mai cablato**: login/register/verify/
  forgot/reset avevano il picker con solo "Tutte le attività" (mancavano le
  16 categorie) e nessun wiring (dropdown non si apriva). Aggiunto
  useMarketplacePageEffects + iniezione client-side delle 16 categorie
  legacy (initCategoryOptions: solo nei picker "corti") → dropdown completo
  e funzionante ovunque.
- **Tab "Attività" (salons) del picker vuota**: il legacy la rende server-side
  con una voce per attività (avatar + nome + meta 'categoria - città -
  provincia'). initSalonOptions ora la popola client-side da /api/marketplace
  in tutte le topbar (list/search/detail/account/auth).
- **Filter input del picker** aggiunto anche in account + ricerca (mancava)
  → DOM skeleton del treatment panel identico al PHP.
Confermato che i CSS caricati per pagina combaciano col PHP: marketplace
(list/search/detail/sede/root) → public_marketplace.css; auth+account →
app.css + public_account.css + topbar inline. Le differenze residue nello
skeleton SSR (tenant-card, salon-service-group, salon-side-info) sono il
pattern client-render dell'intera area pubblica (dati caricati via fetch,
markup presente nel bundle e reso dopo l'hydration).
Battery: e2e-marketplace.mjs 28/28 (incl. G: titoli, picker categorie auth,
salon data, document.title dettaglio, CSS per pagina) + regressioni
e2e-public-area 14/14, e2e-account-faithful 15/15, e2e-booking-marketplace
26/26 CLEAN; 100/100 + 46/46 marker; typecheck/lint puliti.

## MARKETPLACE — SETTIMA PASSATA: layout rotto (body flex) — misurazione Playwright (2026-07-06)
L'utente ha mostrato che la scheda sede/dettaglio era visibilmente rotta
(contenuto stretto ~670px invece di 1520px, copertina piccola, avatar
sovrapposto), mentre lista/ricerca sembravano quasi ok. Diagnosi con
Playwright (misura larghezze reali a 1900px):
- CAUSA: il layout root di Next aveva `<body class="min-h-full flex flex-col">`.
  Con body a display:flex column, `.wrap{margin:0 auto;max-width:1520px}` (e
  `.salon-detail-layout`, `.results-wrap`) NON si stira alla larghezza del
  contenitore ma si restringe al contenuto (margin:auto su flex item annulla
  lo stretch) → `.wrap` misurava 672px invece di 1520px, hero 208px invece
  di 1056px. Il PHP ha body block, quindi 1520/1056.
- FIX: rimosso `flex flex-col` dal body (rimane `min-h-full`). Le pagine
  pubbliche usano `.wrap`/`.account-page` con margin:auto+max-width (richiedono
  body block); il gestionale usa `.app-shell{display:flex;min-height:100vh}` e
  le auth `.account-page{min-height:100vh;display:grid}` — nessuno richiede il
  body flex, quindi zero regressioni.
Verifica Playwright (parità pixel PHP vs Next a 1900px):
- /attivita: hero 1900, grid 1440, wrap 1520, topbar 1440 — MATCH
- /attivita/ricerca: results-wrap 1520, results-grid 1440, result-card 348 — MATCH
- /attivita/<slug>: wrap 1520, salon-detail-layout 1440, salon-hero 1056 — MATCH
- font body = Inter su entrambi ovunque.
Battery: e2e-marketplace-layout.mjs 3/3 (parità larghezze) + regressioni
e2e-marketplace 28/28, e2e-account-faithful 15/15, e2e-public-area 14/14,
e2e-booking-marketplace 26/26 + 100/100 e 46/46 marker; typecheck pulito;
manage login/app verificati non regrediti (usano wrapper propri).

## MARKETPLACE — OTTAVA PASSATA: freccia .salon-action-arrow scentrata (line-height) (2026-07-06)
L'utente ha notato che la freccia circolare a destra di "Servizi" non era
centrata nel cerchio. Diagnosi Playwright (posizione del glifo nel cerchio
34px): markup e CSS identici al PHP (&rsaquo; + place-items:center;
font-size:24px), ma:
- PHP: .salon-action-arrow line-height 'normal' → glifo centrato (1px sopra,
  1px sotto).
- Next: line-height 36px (24px×1.5) ereditato dal preflight di Tailwind
  (html{line-height:1.5}) → glifo scentrato (2px sopra, 0 sotto).
Nessun CSS (app/public_marketplace/public_account/globals) impostava una
line-height sul body; il PHP usa quindi 'normal' ovunque, il Next 1.5.
FIX: app/globals.css body{line-height:normal} — riallinea il default al PHP.
I componenti che richiedono interlinea specifica la impostano da sé
(Bootstrap del gestionale, .salon-*/.result-*/... del marketplace), quindi
nessuna regressione; anzi il body del gestionale ora combacia col PHP.
Verifica Playwright: freccia centrata (1px/1px) e line-height 'normal' come
il PHP; manage body line-height ora 'normal' (era 1.5). Battery
e2e-marketplace-arrow.mjs PASS + e2e-marketplace-layout 3/3 + regressioni
28/28, 15/15, 14/14, 26/26 + 100/100 marker; typecheck pulito.

## MARKETPLACE — NONA PASSATA: audit funzionale con workflow (bug "Prenota ora" + funzioni dettaglio) (2026-07-06)
Segnalazione utente: "Prenota ora" nella scheda attività, da NON loggato,
portava al login GESTIONALE (/manage/login) invece del login CLIENTE.
Lanciato un workflow di audit (5 agenti Review + verifica avversariale,
17 subagent): 10 finding confermati. Corretti:
- **[HIGH] CTA prenotazione -> login gestionale**: bookHref della scheda era
  /<slug>/booking "nudo" (= pagina admin -> /manage/login). Ora TUTTE le CTA
  Prenota (Prenota ora, per-servizio, card home, card ricerca, preferiti)
  usano /<slug>/booking?start=1&location_id=X: il gate replica il PHP
  (anonimo -> /account/login CLIENTE?tenant=..&next=start&location_id; loggato
  -> wizard). Verificato con curl: 307 -> /account/login (mai /manage).
- **[HIGH] Modale Servizi inerte**: il bottone "Servizi" non apriva nulla
  (nessun handler; .salon-modal restava display:none). Aggiunto
  initSalonModals in marketplace-shared (port di wireSalonModal: .is-open su
  open, rimozione su close/Escape) invocato da useMarketplacePageEffects.
- **[MEDIUM] Orari settimanali fabbricati**: il Next usava lo stesso range
  lun-sab + domenica hardcoded chiusa. Ora orari REALI per giorno via API
  (locationWeekHours in public-booking-db: weekly business_hours con
  opens/closes/opens2/closes2/is_closed, flag today/closed), port di
  marketplace_location_week_hours. NB: venerdì differisce (Supabase 16:00 vs
  MySQL 19:00) — drift dati tra i due DB, non un bug di codice.
- **[MEDIUM] Contatti social assenti**: reso solo il telefono. Ora
  salon-social-actions con WhatsApp (wa.me), Facebook, Instagram, TikTok
  (icone SVG legacy) quando valorizzati; tel: normalizzato a [^\d+]. Campi
  esposti dall'API context (whatsapp/facebook/instagram/tiktok).
- **[MEDIUM] Tab "Servizi" del picker vuota**: aggiunto serviceSuggestions
  a /api/marketplace (nomi servizio pubblicati + 'categoria - N attività') e
  initServiceOptions in shared; ora la tab è popolata in ricerca/dettaglio/
  account.
- **[MEDIUM] Chi siamo assente**: aggiunta la sezione salon-section "Chi
  siamo" (business.about) quando valorizzata.
- **[LOW] share senza data-share-url**: aggiunto l'URL canonico
  /attivita/<slug>[/sedi/<loc-slug>].
RESIDUI DELIBERATI (documentati): [HIGH] showcase Prodotti (bottone+modale+
dettaglio prodotto: porta grande, nessun tenant demo ha prodotti); [MEDIUM]
carosello "Altre sedi" (profili demo con 1 sede); [LOW] tab salons/services
non cliccabili nel picker della HOME (react-wired; categorie ok); [LOW]
subtitle salon con provincia invece di regione; [LOW] /account/login da già
loggato senza tenant -> /attivita invece del messaggio "già connesso".
Battery: e2e-marketplace-detail-fn.mjs 5/5 (Playwright: modale Servizi,
orari reali ven/sab/dom, tab Servizi, Prenota->login cliente, share url) +
regressioni e2e-marketplace 28/28, e2e-booking-marketplace 26/26,
e2e-public-area 14/14, layout 3/3, 100/100 marker; typecheck/lint puliti.


---

## Account cliente per-sede: rimosso il pannello centralizzato fabbricato, ricostruito l'hub per-tenant fedele (2026-07-06)

Segnalazione: "vedo un pannello di account cliente totalmente diverso, elimina
completamente ciò che non centra nulla". Il Next rendeva un PublicAccountPage
CENTRALIZZATO (nav a 12 voci aggregate su tutti i tenant) che NON esiste nel PHP.
Il legacy ha due aree distinte: (1) account CENTRALE /account/* = Attività/
Preferiti/Profilo (public_account.php, già fedele = AccountFaithful); (2) HUB
PER-SEDE booking.php?public=1&hub=1 = dashboard "residui" del cliente presso UNA
attività (BookingPublicUi.php shell + "Ciao 👋").

Fatto:
- **Nuovo PerTenantHub** (components/public/per-tenant-hub.tsx): port fedele
  della shell booking-public-account (topbar marketplace + sidebar 220px con le
  11 voci Dashboard/Prenotazioni/Credito/GiftCard/Pacchetti/Prepagati/GiftBox/
  Preordini/Preventivi/Fidelity/Omaggi con icone/ordine legaci + bottom-nav
  Home/Pannello/Prenota + footer marketplace) e della landing "Ciao 👋"
  (kicker "Area cliente", testo verbatim, CTA Prenota ora/Scheda attività,
  empty-state "Nessuna sede disponibile per la prenotazione online.").
- **Sezioni riusate** (components/public/hub-sections.tsx, estratte dal monolite):
  i renderer data-fedeli (Prenotazioni/Pacchetti/Prepagati/Credito/GiftCard/
  Omaggi/Fidelity/Preordini/Preventivi) alimentati da /api/account FILTRATO sul
  tenant corrente (item.tenantSlug === slug).
- **Gate riscritto** (app/[tenantSlug]/booking/page.tsx): i target hub/my/credit/
  giftcards/packs/prepaids/giftboxes/preorders/quotes/fidelity/gifts sono resi
  IN LOCO da PerTenantHub (business.name + sedi prenotabili via
  publicBookingContext); profile/settings -> /account/profile; start -> wizard.
- **auth-destination + booking-faithful**: i link post-login e "I miei
  appuntamenti" puntano ora a /<slug>/booking?<key>=1 (hub), non più a
  /account/*.
- **Rimossi**: routes /account/{appointments,packages,quotes} + il monolite
  public-account-page.tsx (1552 righe). /account/* ora = activities/favorites/
  profile + auth, come public_account.php.

Verifica live: gate anonimo -> 307 /account/login?tenant=..&next=hub; loggato
(sessione ZZ mint+cleanup+RESTORE) -> hub 200 con shell/sidebar/landing fedeli
(screenshot), active sidebar corretto per sezione (Dashboard/Prenotazioni/
Pacchetti), sezioni con empty-state. typecheck pulito.

RESIDUI DELIBERATI: [MEDIUM] lo styling delle CARD di sezione riusa i renderer
Tailwind estratti (dati/testi fedeli) dentro la shell corretta — non ancora
allineato pixel al booking-account-card legacy; [MEDIUM] sezione GiftBox senza
sorgente dati in /api/account (mai portata nell'aggregato) -> empty-state;
[LOW] profile/settings dell'hub -> /account/profile centrale (scelta di port).


---

## Hub cliente per-sede: verifica avversariale (workflow) + fix dei difetti (2026-07-06)

Lanciato un workflow di verifica avversariale (5 dimensioni × review+verify, 28
subagent) confrontando l'hub Next col PHP legacy: 23 finding, 21 CONFERMATI, 2
refutati. Corretti in questo giro:

- **[HIGH] Ownership GiftCard**: listPublicCustomerGiftcards filtrava solo
  `recipient_client_id = client`, nascondendo le carte auto-acquistate
  (recipient NULL/0, ownership su client_id) — il caso tipico. Ora replica il
  legacy (booking_public_list_client_giftcards): `recipient_client_id=? OR
  ((recipient NULL/0) AND client_id=?)`, LIMIT 200, ORDER attive-first/scadenza/
  id DESC, con fallback a client_id se la colonna recipient manca.
- **[MEDIUM] Chip account in SSR**: l'hub è client-side (user=null iniziale) →
  in SSR/no-JS mostrava il bottone "Accedi" invece del chip cliente. Ora il gate
  passa `initialUser` (cliente noto lato server) → il chip è renderizzato al
  primo paint come nel PHP (BookingPublicUi 296-313). Inoltre caricato
  public_account.css: le classi marketplace-account-chip/wrap/menu non erano in
  app.css/TOPBAR_STYLE, quindi il chip/menu erano di fatto NON stilizzati.
- **[MEDIUM] auth-destination**: giftcards/giftboxes non sono nell'allow-list
  PHP account_next_key → post-login collassano su 'start' (wizard); rimossi da
  HUB_KEYS. Corretto anche il commento (profile/settings → account centrale è una
  deviazione deliberata, non ciò che fa il PHP).
- **[MEDIUM] GiftBox**: la sezione era un empty-state fisso (nessuna sorgente in
  /api/account) → mostrava "Nessuna GiftBox" anche a chi ne possiede. Una lista
  fedele richiede GiftBox::getInstanceFull + redemption + riserve (sottosistema a
  sé, rischio conteggi errati). Scelta: RIMOSSA la voce/sezione GiftBox dall'hub
  (voce sempre-vuota = peggio dell'assenza) — il riscatto resta dal wizard
  (deep-link book_giftbox). ?giftboxes=1 → fallback showcase /attivita/<slug>.
- **[MEDIUM] Omaggi**: listPublicCustomerGifts elencava tutti gli stati; il PHP
  (Gifts::clientAvailableInstances) mostra solo 'disponibile'. Ora filtra
  `state='disponibile'`.
- **[LOW] Link/CSS shell**: bottom-nav Home → profilo tenant /attivita/<slug>
  (era /attivita); brand topbar → root "/" (era /attivita); sidebar sticky
  top:96px (era 68px); footer store link senza ?return=%2Fattivita.

Verifica live (sessione ZZ mint+cleanup+RESTORE): hub SSR con chip account (0
"Accedi"), sidebar 10 voci senza GiftBox, brand href="/", bottom-nav Home →
/attivita/<slug>, store link puliti, ?giftboxes=1 → 307 /attivita/<slug>;
typecheck pulito; screenshot chip/menu stilizzati.

RESIDUI DELIBERATI (documentati): [MEDIUM] deep-link 'Prenota' book_omaggio +
badge "Prenotato" nella sezione Omaggi (dipende dai reward-item + riserve, non
portati); [MEDIUM] appuntamenti/preventivi visibili solo per i tenant COLLEGATI
(no fallback per-email al tenant corrente come adoptGlobalSession); [LOW] payload
/api/account aggregato multi-centro filtrato lato client; [LOW] profile/settings
dell'hub → /account/profile centrale (email read-only, no 'Sede di riferimento');
[LOW] enablement-gating sidebar giftcards (schema-based, dormiente); [LOW] campi
Prepagati/Preordini (Totale pagato/Prenotati/Sede/Codice) non tutti mostrati;
[LOW] messaggio landing 'no sedi' non varia per booking_public_allowed;
lo styling delle card di sezione resta Tailwind (residuo pre-esistente).
Refutati (2): filtro tenant e altri due presunti difetti non confermati.


---

## Hub cliente: fallback per-email al tenant corrente (2026-07-06)

Chiuso il residuo [MEDIUM] "appuntamenti/preventivi visibili solo per i tenant
COLLEGATI". Il legacy (adoptGlobalSession + my_appointments/my_quotes) risolve il
cliente PER EMAIL presso il tenant corrente anche senza link, quindi un cliente
creato offline (staff/walk-in) che poi si registra sul marketplace vede comunque
i suoi appuntamenti/preventivi presso quel centro.

- listPublicCustomerAppointments/Quotes accettano extraTenantSlug/extraTenantName:
  se il tenant corrente non è tra le attività collegate, viene aggiunto come
  attività "sintetica" (clientId=0) così resta solo il ramo email della query
  (scoping tenant_id invariato — nessun leak cross-tenant).
- /api/account (appointments/quotes + refresh di cancel/quote_decision) passa
  body.tenant/tenantName; PerTenantHub li invia in ogni fetch di sezione.
  L'account CENTRALE (/account/*) non usa queste azioni, quindi resta aggregato.

Verifica live (ZZ: account marketplace + cliente offline stessa email SENZA link
+ appuntamento, mint→test→cleanup→RESTORE): POST appointments SENZA tenant → 0
(bug); CON tenant → 1 (ZZFB0001, "In attesa", 16/07/2026); l'hub ?my=1 lo mostra
(Playwright). Residue DB = 0. typecheck/lint puliti.

Residuo ancora aperto: deep-link 'Prenota' book_omaggio nella sezione Omaggi —
richiede il port del sottosistema reward-item + redemption/riserve (Gifts::
instanceRewardItemsState), e il cliente di riferimento (client 9) NON ha gift
instances, quindi un port sarebbe non verificabile su dati reali. La rotta di
consumo book_omaggio è già pronta (gate + wizard + re-validazione server);
manca solo l'entry-point, deliberatamente rimandato per mancanza di dati di test.


---

## Hub cliente: deep-link "Prenota" degli Omaggi (book_omaggio) (2026-07-06)

Chiuso l'ultimo residuo MEDIUM funzionale: la sezione Omaggi ora espone il
pulsante "Prenota" per i reward di tipo SERVIZIO ancora prenotabili, come il
legacy (booking.php 11708-11785).

- listPublicCustomerGifts calcola bookableServices per ogni omaggio 'disponibile':
  port di Gifts::rewardItemsFromRow/normalizeRewardItems (reward_items_json o
  fallback legacy reward_type/reward_service_id, reward_item_index = posizione
  nell'array normalizzato) + redeemedRewardQtyByInstance (gift_transactions net
  + appointment_gift_items redeemed, deduplicati) + booking_public_active_gift_
  reserved_qty (appuntamenti attivi non riscattati). remaining = qty - riscattato
  - riservato; tutte le query tenant-scoped (tenant_id, nessun leak).
- GiftsView rende il pulsante con /<slug>/booking?book_omaggio=instanceId&
  service_id&reward_item_index; la rotta di consumo (gate → wizard gift_redeem
  {instance_id,reward_item_index,service_id}) era già pronta e re-valida al confirm.

Verifica live (ZZ: account linkato + cliente + omaggio 'disponibile' reward
servizio, mint→test→cleanup→RESTORE): API gifts → bookableServices
[{serviceId:9,serviceName:'test',rewardItemIndex:0}]; hub ?gifts=1 mostra
"Prenota" con deep-link book_omaggio=81&service_id=9&reward_item_index=0;
visita loggata → 200 wizard (servizio prefill), anonima → 307 /account/login
next=start. Residue DB=0. typecheck/lint puliti.

Residuo residuo (badge "Prenotato" per omaggi già riservati): minore, la lista
mostra solo i 'disponibile' e i reward riservati non espongono più il pulsante
(reserved sottratto), quindi nessuna doppia-prenotazione offerta.


---

## Hub cliente: feature-gate booking_public_allowed + normalizzazione slug (2026-07-06)

Chiusi due residui LOW di correttezza:

- **booking_public_allowed (TenantFeatureGate::allowsPublicBooking)**: se il
  tenant ha disattivato la prenotazione online (saas_tenants.booking_public_allowed=0),
  il PHP nasconde "Prenota ora" e mostra 'Prenotazione online non disponibile.'
  (booking.php 2981-2985), e blocca il wizard. Il Next lo ignorava (mostrava il
  CTA). Ora il gate legge il flag: hasBookableLocations = allowed && sedi
  prenotabili; noLocationsMessage varia; ?start=1 e i deep-link redeem con
  booking disattivato → showcase /attivita/<slug>.
- **Case-sensitivity slug**: onlyTenant/sidebar usavano lo slug grezzo della
  route; uno slug URL non minuscolo svuotava le liste. Il gate ora passa
  slug.toLowerCase() a PerTenantHub → link e filtro coerenti.

Verifica live (toggle saas_tenants.booking_public_allowed su centroesteticoelite,
save→set 0→test→RESTORE 1): flag=1 → "Prenota ora" + start 200; flag=0 → nessun
CTA + 'Prenotazione online non disponibile.' + start=1 → 307 /attivita/<slug>;
ripristino a 1 verificato (baseline OK). URL mixed-case → link sidebar
lowercased. typecheck/lint puliti; nessun dato reale alterato.


---

## Hub cliente: scoping server-side del payload di sezione (2026-07-06)

Chiuso il residuo LOW "data-exposure": /api/account restituiva le liste di
sezione AGGREGATE su tutti i centri collegati (credito/giftcard/punti/... di
altri tenant nel payload di rete), filtrate solo lato client. Il legacy
per-sede trasmette solo il tenant corrente.

- /api/account POST: quando arriva body.tenant (solo l'hub lo invia), ogni lista
  di sezione (appointments/packages/credit/giftcards/prepaids/gifts/fidelity/
  preorders/quotes + refresh di cancel/quote_decision) è filtrata server-side su
  quel tenant (scopeToHub) PRIMA di serializzare. Senza tenant (account CENTRALE)
  resta invariato (aggregato).
- PerTenantHub invia tenant anche nei POST di cancel/quote_decision.

Verifica live (ZZ omaggio a centroesteticoelite): POST gifts tenant=
centroesteticoelite → 1 (mantenuto); tenant=altro → 0 (rimosso dal payload);
senza tenant → 1 (invariato). typecheck/lint puliti; ZZ cleanup+RESTORE.


---

## Hub cliente: parità campi Prepagati/Preordini (2026-07-06)

Chiuso il residuo LOW sui campi delle sezioni Prepagati/Preordini:

- **Prepagati** (booking.php 10503-10531): rimosso "Prezzo unitario" (il legacy
  non lo mostra); aggiunti purchase_date + total_paid → meta "Acquisto • Scadenza
  • Totale pagato"; "Quantità residua R/P" sostituito da "Servizi utilizzati
  used/purchased" (used = purchased - remaining). (Residuo minore: "Prenotati" =
  qty riservata, dipende dal link appuntamenti-prepagato, non portato.)
- **Preordini** (booking.php 10707-10716): qty NON più arrotondata (2.5 restava
  3) e formattata a 2 decimali it-IT come fmt_money; aggiunto line_total →
  "€ X totale". (Residuo minore: Sede/Codice richiedono join a locations/products.)

Verifica live (ZZ prepagato linkato, mint→test→cleanup→RESTORE): API prepaids →
totalPaid 50, purchaseDate 2026-06-01, used 2/5; hub ?prepaids=1 →
"Acquisto: 01/06/2026 • Scadenza: 31/12/2026 • Totale pagato: € 50,00 •
Servizi utilizzati: 2 / 5", nessun "Prezzo unitario". typecheck/lint puliti;
residue DB=0.


---

## Wizard booking pubblico: skip step "Scegli la sede" con sede unica (2026-07-06)

Segnalazione (screenshot): il PHP con una sola sede mostra "Step 1 di 5 — Scegli
una categoria" (step Sede SALTATO), il Next mostrava "Step 1 di 6 — Scegli la
sede". Confermato: il JS SERVITO (authoritative) ha
`const skipLocationStep = locationCards.length === 1` + shouldSkipLocationStep()
+ bookingVisibleProgressOrder che filtra 'location' (il file locale
booking-wizard.js è una build più VECCHIA senza questa logica — un agente del
workflow l'ha letto e ha erroneamente concluso "nessun skip").

Fix (BookingFaithful): quando ctx.locations.length===1 → skipLocationStep:
visibleOrder esclude 'location' (contatore -1), lo step iniziale diventa 2
(Categoria), handleBack non torna mai allo step Sede, il pulsante Indietro è
nascosto sul primo step visibile. Aggiunto anche il rispetto di ?location_id=
(sede d'ingresso valida, altrimenti la prima). Verifica live: il Next ora rende
"Step 1 di 5 — Scegli una categoria" con la card 'genera' — pixel-match allo
screenshot PHP. typecheck/lint puliti.

NB: audit avversariale del wizard (workflow, 6 dimensioni, 50 subagent) = 41
finding confermati (6 HIGH, 23 MEDIUM, 12 LOW) — questo chiude l'anchor; i
restanti (staff per-servizio, slot occupati/raggruppati, auto-select data,
redeem a prezzo pieno, punti fidelity lordi, testi verbatim, ecc.) sono in coda.


---

## Wizard booking: slot solo disponibili + auto-select prima data aperta (2026-07-06)

Due finding HIGH del wizard chiusi:
- **Slot occupati**: il Next mostrava gli orari occupati come pulsanti
  disabilitati (muro grigio); il PHP restituisce/mostra SOLO gli orari liberi.
  Fix: la griglia rende solo freeSlots (available===true), nessun pulsante
  disabilitato; "Nessuna disponibilità" quando 0 liberi.
- **Auto-select data**: il Next restava su oggi anche se chiuso; il PHP
  (ensureDateSelectionReady) auto-seleziona la prima data non chiusa entrando
  nello step Data/Ora. Fix: effetto su step===5 che, se la data è chiusa/passata,
  salta alla prima data aperta (allineando lo strip).

Verifica live (Playwright): giorno 7/7 → 109 slot available, 0 disabled; oggi
(aperto ma senza slot) → "Nessuna disponibilità", 0 disabled; domenica greyed
(chiusa) non selezionabile. NB: >12 slot il PHP li RAGGRUPPA (Mattina/Pomeriggio/
Sera) — porting del raggruppamento in coda (finding HIGH slot-grouping).
Minor: breve flash step Sede prima del load del context (client-render).
typecheck pulito.


---

## Wizard booking: punti fidelity al netto dei riservati + ownership GiftCard (2026-07-06)

Due finding sui Vantaggi (step 6) chiusi:
- **[HIGH] Punti fidelity lordi**: preview e apply usavano clients.points LORDO;
  il PHP usa availablePoints = punti − riservati (su altri appuntamenti pending).
  Fix: available = max(0, floor(saldo − fidelityReservedPoints(slug, clientId)))
  sia in publicCustomerBenefitsPreview sia in applyPublicCustomerBenefits —
  niente più sconto gonfiato né sovra-riserva al confirm.
- **[MEDIUM] Ownership GiftCard**: la lista giftcard filtrava solo
  recipient_client_id=cliente; il PHP include anche le carte del cliente
  (client_id) con recipient NULL/0. Fix: stessa clausola OR del legacy (con
  fallback a client_id) — stesso pattern già verificato live nell'hub.

typecheck/lint puliti. (benefit-apply-order credito↔giftcard rimandato: il
totale pagato è già corretto, cambia solo l'asset consumato per primo.)


---

## Wizard booking: testi step VERBATIM dal runtime legacy (2026-07-06)

Chiusi 4 finding testi (verbatim-text-step-title/description/cta + text-step-headers):
i titoli/descrizioni di STEP_HEAD e l'etichetta #btnNext divergevano dai testi
che il legacy imposta a runtime (booking-wizard.js showStep 3241-3288). Allineati
VERBATIM (quirk preservati: 'piu' senza accento, "l'orario"):
- 2 desc "Scegli da dove iniziare il percorso."; 3 "Servizi"/"Seleziona uno o piu
  trattamenti e continua quando sei pronto."; 4 "Professionista"/"Scegli il
  professionista per ogni servizio selezionato."; 5 "Data e ora"/"Scegli la data
  e poi l'orario che preferisci."; 6 "Vantaggi"/"Applica Punti Fidelity, credito
  o GiftCard disponibili prima della conferma."; 7 desc "Controlla tutti i
  dettagli e invia la prenotazione."
- #btnNext: step 1-2 "Continua", 3-6 "Avanti", 7 "Invia".

Verifica live: step 2 "Scegli da dove iniziare il percorso."/"Continua"; step 3
"Servizi"/"Seleziona uno o piu trattamenti..."/"Avanti". typecheck pulito.


---

## Wizard booking: preselezione categoria + reset servizi al cambio categoria (2026-07-06)

Due finding MEDIUM step Categoria/Servizi:
- **Preselezione categoria**: il Next preselezionava sempre la prima categoria
  (card 'active' + Avanti abilitato); il legacy non seleziona nulla con più
  categorie (validateStep step 2 richiede la scelta). Fix: auto-select SOLO con
  una categoria (come lo screenshot 'genera'), altrimenti null; computeCanContinue
  step 2 → categoryId != null.
- **Reset servizi al cambio categoria**: il Next non azzerava i servizi cambiando
  categoria (restavano nel carrello/prenotazione); il legacy applyCategorySelection
  svuota il carrello + reset data/ora. Fix: al cambio categoria azzera
  serviceIds/slot/hold.

Verifica live (sede+categoria uniche): 'genera' auto-selected, Continua abilitato.
typecheck pulito. (data-shown-categories: filtro categorie per sede/non-vuote —
backend, in coda.)


---

## Wizard booking: formato migliaia + accento verbatim (2026-07-06)

- **[LOW] Formato migliaia**: fmtMoney (toLocaleString it-IT) non inseriva il
  separatore migliaia per 1000-9999 (limite ICU/Node); il PHP number_format sì.
  Fix: formatter manuale ('.' migliaia + ',' decimali) — 1234.5 -> "1.234,50".
- **[LOW] Accento**: "l'appuntamento sarà eseguito" -> "sara" (senza accento)
  come il legacy (booking.php 13224).

typecheck pulito.


---

## Wizard booking: raggruppamento slot Mattina/Pomeriggio/Sera (2026-07-06) [HIGH]

Chiuso il finding HIGH slot-grouping. Sopra 12 slot il legacy (renderGroupedSlots,
booking-wizard.js 3800-3964) raggruppa gli orari in periodi (Mattina<12/
Pomeriggio<18/Sera) con "N orari", e in card per-ora con "N disponibilita",
mostrando di default gli orari consigliati (minuti multipli di 15, o i primi 3) +
toggle "Mostra tutti"/"Nascondi"; il Next rendeva una griglia piatta (es. 109
pulsanti). Portati SLOT_GROUP_THRESHOLD=12, periodi/ore, getInitialHourSlots,
expand per-ora e la classe has-groups.

Verifica live (giorno con 109 slot): has-groups; periodi Mattina(36 orari)/
Pomeriggio(72)/Sera(1); 10 card ora con "12 disponibilita" + "Mostra tutti";
09:00 mostra 09:00/09:15/09:30/09:45 (consigliati). typecheck pulito.


---

## Wizard booking: label sconto conferma + rimozione box coupon morto (2026-07-06)

Due finding MEDIUM della schermata di conferma:
- **discount-label**: la riga sconto della conferma era sempre "Coupon" e leggeva
  il codice solo da selectedBenefit; una PROMOZIONE appariva come "Coupon " vuoto.
  Fix: etichetta calcolata (promozione → titolo, coupon → "Coupon <codice>") da
  couponApplied/autoPromo/selectedBenefit.
- **dead-markup**: rimosso il box coupon/promozioni STATICO dello step 7 (markup
  morto senza handler + id DOM DUPLICATI couponInput/couponBox/couponMsg già nello
  step 6 funzionante). Residuo dichiarato: nel legacy il coupon è inseribile anche
  allo step 7; nel port l'inserimento free-text vive nello step 6.

typecheck pulito. RESIDUI del cluster conferma (server-side): post-book-amounts
(importi dal client invece che dal DB) e cost-breakdown (prezzi barrati/sconto
per-servizio) richiedono che confirmPublicBooking restituisca gli importi
realmente applicati (fidelity/credito/giftcard) + i prezzi per-servizio — non
ancora fatto.


---

## Wizard booking: importi conferma dal server (post-book-amounts) (2026-07-06)

Chiuso il finding MEDIUM post-book-amounts. La schermata di conferma calcolava
sconto Fidelity/Credito/GiftCard e Saldo dovuto dallo STATO CLIENT ottimistico
(custBenefits, payableTotal): se il server clampava un benefit (es. credito
richiesto 50€ ma disponibile 30€), la conferma mostrava -50€ e un saldo errato.
Il server GIÀ restituisce gli importi realmente applicati (route.ts 368-371:
fidelity_points_used/fidelity_discount/credit_used/giftcard_used), ma il client
li scartava (teneva solo confirmation+accountLinked).

Fix: il confirm cattura gli importi applicati (appliedAmounts) e la conferma li
usa per le righe Fidelity/Credito/GiftCard e per il Saldo dovuto = totale server
− fidelity − credito − giftcard. typecheck pulito. (Verifica: contratto API già
confermato; test dello scenario di clamp saltato per non creare prenotazioni
reali + debiti benefit. Residuo cost-breakdown: prezzi per-servizio barrati/0€
redeem non ancora dal server.)


---

## Wizard booking: categorie filtrate (non vuote / per sede) (2026-07-06)

Chiuso il finding MEDIUM data-shown-categories. Il Next mostrava TUTTE le
service_categories (anche vuote o con servizi di sole altre sedi) + creava
categorie sintetiche "Categoria #N"; il PHP mostra solo quelle con >=1 servizio
prenotabile visibile nella sede (booking.php 2959 EXISTS + 3061-3070
$visibleCategoryIds).

Fix:
- publicBookingContext: le categorie sono filtrate a quelle referenziate da >=1
  servizio bookable (usedCategoryIds); il fallback "Categoria #N" resta SOLO per
  category_id orfani (categoria cancellata) di un servizio bookable.
- BookingFaithful: lo step 2 mostra categoriesForLocation (categorie con >=1
  servizio nella sede selezionata); l'auto-select categoria unica considera la
  sede d'ingresso.

Verifica live (centroesteticoelite): categorie=["genera"], auto-selected; niente
categorie vuote né "Categoria #N". typecheck/lint puliti.


---

## Wizard booking conferma: dettaglio costi per-servizio (cost-breakdown) (2026-07-06)

Chiuso il finding MEDIUM cost-breakdown (parte CONFERMA). Il dettaglio costi della
conferma mostrava prezzi pieni piatti; il legacy (renderPriceHtml, booking.php
8957-8987) mostra per-servizio il prezzo di LISTINO barrato + badge sconto/
residuo + prezzo scontato/0€.

Fix: confirmPublicBooking restituisce services[] (serviceId, name, listPrice,
price, badge) dai serviceOverrides della promozione; la conferma rende per-
servizio price-old barrato + discount-badge + price-now, e 0€ + badge residuo
(Pacchetto/Prepagato/GiftBox/gift) per i servizi coperti da deep-link redeem.

Verifica live (prenotazione ZZ completa mint→book→confirm→cleanup, appuntamento
eliminato, residue=0): conferma "CODICE PRENOTAZIONE #...", price-now "€ 12,00",
"Saldo dovuto € 12,00" (caso pieno, nessun crash). typecheck/lint puliti.
RESIDUO: il recap dello STEP 7 (pre-conferma) mostra ancora prezzi pieni +
sconto aggregato — la risoluzione per-servizio lato client (computeCouponBreakdown)
non è portata.


---

## Wizard booking: countdown live dell'hold + gating scadenza (2026-07-06)

Chiuso il finding MEDIUM hold-countdown-and-gating. Il Next mostrava un banner
statico "Orario riservato fino alle HH:MM." e permetteva Invia con hold scaduto
(rifiutato solo dal confirm). Il legacy (booking-wizard.js 341-424) fa un
countdown 1s "Slot riservato per M:SS.", warning poi rosso, e alla scadenza
rilascia l'hold + riporta allo step Data/Ora; validateStep 5/6/7 richiede un
hold non scaduto.

Fix: tick 1s (holdNow), "Slot riservato per M:SS." con alert-warning <30s /
alert-danger <10s; alla scadenza release_hold + azzera slot + torna a step 5 +
messaggio; computeCanContinue 5/6/7 richiede hold && !holdExpired.

Verifica live: dopo aver scelto uno slot il banner mostra "Slot riservato per
2:29." e dopo 3s "2:26." (tick attivo). typecheck/lint puliti.


---

## Wizard booking: batch bounded (indirizzo, riepilogo, data slot, calendario, auto-refresh) (2026-07-06)

Cinque finding chiusi:
- **[MED] data-shown-address**: la card sede mostra la sola colonna address (niente
  concat legal_city) — public-booking-db.ts.
- **[MED] data-shown-summary**: il testo di selezione mostra il nome per 1 servizio /
  "N servizi selezionati" per 2+ SEMPRE con "• {durata} min"; la riga "Servizi" del
  riepilogo mostra i nomi (join ", ") invece del conteggio.
- **[LOW] slot-date-label-format**: "Scegli uno slot per" usa "07 luglio 2026"
  (giorno 2 cifre + mese lungo + anno) invece di "lun 7 luglio".
- **[LOW] add-to-calendar-gating**: il pulsante .ics compare quando la conferma è
  del cliente collegato (accountLinked), senza il doppio gate logged.
- **[LOW] slot-auto-refresh**: refresh silenzioso della disponibilità ogni 15s
  sullo step Data/Ora (in pausa se la tab è nascosta), senza azzerare selezione/hold.

Verifica live: slotDateLabel "07 luglio 2026", summary "test • 60 min", Servizi
"test". typecheck/lint puliti.


---

## Wizard booking: testo slot vuoto/errore in loco + LOW documentati (2026-07-06)

- **[LOW] verbatim-text-empty-error**: #slotEmpty ora dice "Nessuna disponibilità
  per questo giorno." (non "per questa data") e mostra l'errore di disponibilità
  IN LOCO ("Errore nel caricamento delle disponibilità. Ricarica la pagina.")
  invece che nel banner globale (nuovo stato slotError).

RESIDUI LOW DOCUMENTATI (non modificati, deliberati):
- **initial-step-divergence-wizardstep**: il Next non onora ?wizard_step= — ma i
  link del Next non emettono MAI wizard_step≠1, quindi è irraggiungibile.
- **entry-auth-redirect-params**: il redirect al login propaga location_id +
  next=start — miglioria additiva (preserva la sede attraverso il login), non un
  bug; il PHP droppa location_id al guest-gate ma lo ri-onora post-login.


---

## Wizard booking: ordine benefit Credito→GiftCard (2026-07-06)

Chiuso il finding MEDIUM benefit-apply-order. Il Next applicava GiftCard poi
Credito (giftcard sul residuo dopo fidelity, credito sul residuo dopo giftcard);
il legacy applica prima il Credito (su totale−sconto−fidelity) e poi la GiftCard
sul residuo dopo il credito. Totale pagato identico, ma cambiava l'asset consumato
per primo.

Fix (client): creditAppliedAmount = min(creditAvailable, dueAfterFidelity); poi
giftcardAppliedAmount = min(balance, dueAfterFidelity − credito). Il server
applica gli importi pre-calcolati dal client (ogni sezione clampa in modo
indipendente, nessuna doppia applicazione), quindi il consumo asset ora combacia
col legacy senza toccare la money-calc server. typecheck pulito.


---

## Wizard booking: redeem = servizio residuo a 0€ + skip Vantaggi (2026-07-06) [HIGH]

Chiuso il finding HIGH redeem-benefit-base. Con un deep-link redeem attivo
(book_package/prepaid/giftbox/omaggio) il Next lasciava il servizio coperto a
prezzo pieno e mostrava lo step Vantaggi; il legacy azzera il servizio (residuo)
e salta del tutto i Vantaggi.

Fix (BookingFaithful): redeemedServiceId (servizio coperto in carrello) →
prezzo effettivo 0 nel subtotal (quindi finalTotal/summary/Saldo a 0€);
hasBenefitsAvailable=false (step 6 saltato) e fidelity_preview NON fetchato con
redeem attivo.

Verifica live (deep-link book_prepaid&service_id=9): summary "test • 60 min",
Prezzo Totale "€ 0,00", step Vantaggi saltato. typecheck pulito. RESIDUO: la
RIGA per-servizio del recap step 7 (pre-conferma) mostra ancora il prezzo pieno
sul singolo servizio (il totale è corretto) — parte del residuo cost-breakdown
recap; la CONFERMA invece mostra già 0€ + badge residuo.


---

## Wizard booking: auto-advance del flusso "prenota da residuo" (2026-07-06)

Chiuso il finding MEDIUM step-skip-divergence-residual. Con un deep-link redeem
(book_package/prepaid/giftbox/omaggio) il Next preselezionava solo servizio+
categoria e RESTAVA sullo step iniziale; il legacy (advanceResidualBookingFlow)
salta Sede/Categoria/Servizi (servizio precompilato) e va direttamente a
Data/Ora (staff auto-assegnato).

Fix: nel ctx-load con redeem risolto, setOperatorId('any') + setStep(5 se
chooseStaffEnabled=false, altrimenti 4). Verifica live (book_prepaid&service_id=9):
il wizard atterra su "Data e ora". typecheck pulito.


---

## Wizard booking: filtro operatori idonei (SSO/eligibilità) + residui staff/LOW (2026-07-06)

Chiusa la parte BOUNDED di staff-selection-structure: lo step Professionista
mostra ora solo gli operatori abilitati ad almeno un servizio selezionato,
escluso l'operatore interno "SSO" (eligibleStaff), invece di TUTTO lo staff
attivo. (Lo step Professionista è comunque saltato quando la scelta operatore è
disattivata — default su centroesteticoelite.)

RESIDUI DELIBERATI (documentati) — richiedono un port MAGGIORE o dati backend, e
NON toccano il flusso default (scelta operatore OFF di default):
- **Staff per-servizio completo** [HIGH/MED] (staff-selection-structure gruppi +
  step-skip-divergence-staff/staff-step-skip-condition skip dinamico + multi-
  service-staff-map + confirm-payload staff_map): il legacy rende un GRUPPO per
  servizio (solo operatori idonei, location-filtered, auto-assegnazione singolo
  operatore), invia uno staff_map per-servizio e calcola slot segment-aware per
  carrelli multi-servizio. È un sottosistema a sé, rilevante solo con la scelta
  operatore attiva. NON portato.
- **prices-promo-badge** [LOW]: la card servizio (step 3) non mostra prezzo promo
  barrato + badge — serve serviceCatalogPromotions nel context (backend).
- **closure-notice** [LOW]: l'avviso "Il negozio sara chiuso dal.. al.." non è
  reso — serve il calcolo dei range di chiusura contigui.
- **confirmation-copy** [LOW]: la conferma hardcoda l'etichetta fidelity "Punti" e
  omette le righe omaggio Fidelity/"scelta in negozio" e "Condizioni promozionali".
- **recap step 7 per-servizio** (cost-breakdown recap): prezzi per-servizio
  barrati/0€ nel recap PRE-conferma (la CONFERMA li mostra già).


---

## Wizard booking: avviso "Chiusura negozio" (closure-notice) — CHIUSO (2026-07-06)

Chiuso il residuo LOW closure-notice (prima elencato come deliberato). Lo step
"Data e ora" ha sempre avuto il markup #closureNotice/#closureNoticeText ma era
MORTO (hardcoded d-none, testo vuoto: nulla lo popolava).

Port fedele di booking.php mode=closures (4971-4993) + booking-wizard.js
renderClosureNotice (3761-3777):
- **Backend** (publicBookingClosures): la query chiusure ora legge anche `reason`;
  costruisce una mappa date→motivazione (ultima riga vince, come il foreach PHP),
  toglie le aperture straordinarie, poi raggruppa le date CONSECUTIVE con la
  STESSA motivazione in `closureRanges` [{start,end,reason}]
  (booking_dates_consecutive_asc = +1 giorno).
- **API** /api/booking?action=closures: ritorna `closure_ranges`.
- **Wizard**: lo stato closures cattura `ranges`; #closureNotice mostra fino a 3
  range (slice(0,3)) — "Il negozio sarà chiuso il <b>DATA</b>." (singolo) o
  "Il negozio sarà chiuso dal <b>A</b> al <b>B</b>." (intervallo), date via
  formatSlotDateLabel ("10 agosto 2026").

VERIFICA LIVE (Playwright, step "Data e ora", 5 chiusure di test su tenant 25):
- 10-08→12-08 stessa motivazione "ZZ Ferie" → 1 riga "dal 10 agosto 2026 al 12
  agosto 2026." (raggruppate);
- 13-08 "ZZ Altro" (consecutiva a 12 ma motivazione diversa) → riga separata
  "il 13 agosto 2026." (la motivazione spezza il range);
- 20-08 "ZZ Chiuso" (gap) → riga separata.
Notice visibile (no d-none), heading "Chiusura negozio". Dati di test poi
ELIMINATI (residuo=0). typecheck pulito.


---

## Wizard booking: badge promo di catalogo sulle card servizio (prices-promo-badge) — CHIUSO (2026-07-06)

Chiuso il residuo prices-promo-badge (prima deliberato per assenza dati). Le card
servizio dello step 3 non mostravano il prezzo promo barrato + badge. Port fedele
di booking.php serviceCatalogPromotions (3081-3126, Promotions::marketplaceBadges
ForItems) + updateServiceCardsPrices/renderPriceHtml (booking-wizard.js 1498-1594).

- **Backend** (db-repositories publicBookingServiceCatalogPromos): per ogni
  servizio prenotabile valuta la MIGLIOR promo automatica su un carrello di UNA
  unità RIUSANDO lo stesso motore del carrello (evaluateOnePromotion), così i
  prezzi restano coerenti con la conferma. Esclude promo su coupon_code e con
  condizioni manuali; senza cliente esclude quelle a limite per-cliente. Calcola
  display_mode ('discounted_price' vs 'badge'), badge_title (target label:
  Promo/Nuovi clienti/Bentornato/Compleanno/Fidelity), badge_detail
  (discount_label + "fino al gg/mm/aaaa"), old_price/new_price.
- **API** action=context: popola context.serviceCatalogPromotions col cliente
  loggato (publicSessionClientId) + sede di default.
- **Wizard**: sulle card, finché non è scelto uno slot (canUseCatalogPromotion
  Fallback) e mai sul servizio a residuo, rende price-old barrato + discount-badge
  + price-now + service-promo-detail (o service-promo-note per display_mode badge).

VERIFICA LIVE (Playwright, promo test -20% su tenant 25, scadenza 31/12/2026):
- context API: svc 9 => display_mode 'discounted_price', badge_title 'Promo',
  badge_detail '-20% fino al 31/12/2026', old 12, new 9.6;
- step "Servizi": card "test" con € 12,00 barrato + badge "Promo" + € 9,60 +
  "-20% fino al 31/12/2026". Promo di test poi ELIMINATA (residuo 0). typecheck pulito.

RESIDUO minore: promo in modalità 'badge' pura (time-windowed / min_qty>1) — il
motore Next valuta su 1 unità al tempo corrente, quindi rende badge solo per le
promo attive-ora; le promo min_qty>1 (che nel legacy darebbero un badge senza
prezzo) non emettono badge. Non tocca il caso prezzo-barrato (il cuore del finding).


---

## Wizard booking: etichetta unità Punti Fidelity dinamica (confirmation-copy label) — CHIUSO (2026-07-06)

Chiusa la parte etichetta-fidelity del residuo confirmation-copy. Il wizard
hardcodava "Punti" dove il legacy usa fidLabel (= businesses.fidelity_points_label,
default 'Punti'). Port fedele di FIDELITY_LABEL / recFidelityAvail / recFidelityHint
(booking-wizard.js 162, 2323, 2327).

DISCRIMINAZIONE dinamico vs fisso (verificata sul legacy per non sovra-sostituire):
- DINAMICO (unità punti, = fidLabel): "Disponibili: N <label>" (recFidelityAvail),
  "Sconto applicabile con N <label>." (recFidelityHint).
- FISSO (nome feature, MAI sostituito): "Punti Fidelity" (titolo card + toggle
  "Usa sconto Punti Fidelity"), descrizione step "Applica Punti Fidelity...".

- **Backend**: getFidelityPointsSettings espone pointsLabel; il preview benefit
  espone out.fidelity.label SEMPRE (indipendente da adesione/punti, come la
  costante FIDELITY_LABEL lato page); action=fidelity_preview ritorna points_label.
- **Wizard**: custBenefits.pointsLabel usato in #recFidelityAvail ("Disponibili:
  N <label>") e #recFidelityHint (prima VUOTO — ora popolato fedelmente
  "Sconto applicabile con N <label>."). Titolo "Punti Fidelity" invariato.

VERIFICA LIVE (Playwright, tenant 25 con label temporanea "Gemme", cliente con
500 punti + tessera attiva): step Vantaggi → titolo "Punti Fidelity" (fisso),
"Disponibili: 500 Gemme", "Sconto applicabile con 120 Gemme.", toggle "Usa sconto
Punti Fidelity" (fisso). Dati di test RIPRISTINATI (label→Punti, punti→22, tessera
rimossa; residuo 0). typecheck pulito.

RESIDUO confirmation-copy restante: righe omaggio Fidelity ("Puoi ottenere in
gift...") e "Condizioni promozionali" — richiedono fidelity_gifts_json e promo_
conditions configurati (assenti sul tenant), sottosistema gift a sé.


---

## Wizard booking: scelta operatore PER SERVIZIO + slot segment-aware (staff cluster) — CHIUSO (2026-07-06)

Chiuso il residuo MAGGIORE della scelta operatore: il wizard usava un modello
PIATTO (un operatore per tutto l'appuntamento, "Qualsiasi" + lista), il legacy usa
GRUPPI PER SERVIZIO + staff_map + slot segment-aware. Port completo di booking.php
mode=staff / build_slots_multi_staff_segments / parse_staff_map + booking-wizard.js
renderStaffList / syncStaffMapInput / needsStaffStep.

- **Backend endpoint** action=staff (publicBookingStaffPerService): operatori idonei
  PER SERVIZIO (staff_for_service: un servizio senza righe staff_services è aperto
  a tutti gli attivi; SSO escluso; no_operator => nessuno).
- **Motore slot segment-aware** (publicBookingSlots, param staffMap): quando ogni
  servizio ha un operatore nel staff_map, ogni segmento (in sequenza) dev'essere
  libero per il SUO operatore nella propria finestra (build_slots_multi_staff_
  segments, riusa candidateFree). Altrimenti candidato unico/qualsiasi.
- **hold/confirm** accettano staffMap: staff_ids_json = operatori distinti,
  segments (buildSegments/insertPublicAppointmentSegments) con staff_id per-servizio,
  appointment_staff per ogni operatore distinto.
- **Route** parse_staff_map (JSON {serviceId: staffId}) in slots/hold/confirm.
- **Wizard**: fetch mode=staff al cambio carrello (anche con scelta OFF, per lo
  staff_map deterministico dei servizi a operatore unico); gruppi per-servizio
  (renderStaffList) con auto-assegnazione dell'operatore unico ("Assegnato
  automaticamente") e selezione per i multi-operatore ("Seleziona"); skip dinamico
  (needsStaffStep = scelta attiva E almeno un servizio con ≥2 operatori);
  staff_map inviato a slots/hold/confirm; Avanti bloccato finché incompleto.

VERIFICA LIVE (Playwright + API, tenant 25 con choose_staff=1 e 2 operatori su
svc 9): step "Professionista" mostrato (non saltato), gruppo "test" con "luca" e
"ZZ Op2" ("Seleziona"), Avanti disabilitato finché non si sceglie, staff_map
{"9":54}, 30 slot per l'operatore scelto; hold.staffId=54; confirm -> appointment_
segments(svc 9, staff 54) + appointment_staff 54. Appuntamento e setup di test
ELIMINATI (residuo 0). typecheck pulito.

RESIDUO minore: multi-servizio con operatori DIVERSI per servizio (slot segment
combinati) è supportato dal motore ma non verificato live end-to-end (il tenant di
test ha 1 servizio prenotabile alla sede). Righe conferma omaggio Fidelity /
condizioni promozionali restano l'unico residuo (feature non configurate).


---

## Wizard booking: multi-servizio operatori diversi (verifica) + "Condizioni promozionali" (2026-07-07)

Chiusi gli ultimi due residui.

### (B) Slot segment-aware multi-servizio con operatori DIVERSI — VERIFICATO
Il motore (publicBookingSlots segment-aware, commit precedente) era supportato ma
non verificato end-to-end. Con 2 servizi prenotabili e operatori distinti su
tenant 25 (setup temporaneo): staff_map {9:22, 80:55} -> slot dove il segmento 1
(svc 9, luca, 60') e il segmento 2 (svc 80, ZZ Op2, 30') sono entrambi liberi in
sequenza; confirm -> appointment_segments(pos1 svc9 staff22, pos2 svc80 staff55) +
appointment_staff 22,55. Dati di test rimossi (residuo 0). NESSUN cambio codice.

### (A) Riga "Condizioni promozionali" (confirmation-copy) — CHIUSO
Lo step Conferma aveva il markup #recPromoConditions ma era MORTO (d-none fisso,
nessun testo). Port di booking-wizard.js 2772-2790 + booking.php 7886-7892:
- **Backend**: evalBestPromotionForAppointment / evalPromotionCodeForAppointment
  espongono promotion.promoConditions (da promotions.promo_conditions_enabled +
  promo_conditions); resolvePublicBookingBenefits.promotionConditions; le action
  promotion_preview e coupon ritornano promo_conditions.
- **Wizard**: autoPromo e couponApplied catturano `conditions`; #recPromoConditions
  reso quando il testo è presente (newline -> <br>), verbatim "Condizioni promozionali".

VERIFICA LIVE (Playwright, promo -10% con promo_conditions su tenant 25): step
Conferma -> box "Condizioni promozionali" con "Valida dal lunedi al venerdi." +
"Non cumulabile con altre offerte."; promo anche nel Dettaglio Costi (-€ 1,20,
totale € 10,80). Promo di test rimossa (residuo 0). typecheck pulito.

RESIDUO UNICO rimasto: nota omaggio Fidelity ("Puoi ottenere in gift...") — richiede
fidelity_gifts_json configurato + il sottosistema gift-matching (bestFidelityGift
ForRemaining + conflitto sconto/gift), niente sul tenant. Sub-feature a sé.


---

## Nota di completamento wizard (2026-07-07)

Verificato che la nota "omaggio Fidelity" ("Puoi ottenere in gift...") NON è un
residuo di copy ma dipende dal sottosistema **Gifts v2 (istanze omaggio dinamiche
per cliente)**: nel legacy la lista statica degli omaggi è stata RIMOSSA
(Fidelity.php 631: "legacy list rimossa: gli omaggi sono dinamici per cliente
(istanze v2)"); `Fidelity::settings()['gifts']` = [] e `gift_enabled =
Gifts::hasActiveGifts()`. La nota si popola solo da `fidelityPreview.gifts`
alimentato da Gifts v2. È quindi un SOTTOSISTEMA a sé (come GiftBox, già documentato
come non portato), non una riga di testo aggiungibile. Resta l'unico elemento del
wizard non portato, per dipendenza da un sottosistema maggiore non ancora migrato.

Tutto il resto del wizard di prenotazione pubblica è ora portato 1:1 e verificato
live (sede/categoria/servizi/professionista-per-servizio/data-ora/vantaggi/conferma,
promo di catalogo, chiusure, fidelity/credito/giftcard, redeem, condizioni promo,
slot segment-aware multi-operatore).


---

## Wizard booking: audit Conferma/recap vs legacy — divergenze corrette (2026-07-07)

Dopo il fix "Cliente in sola lettura" e "formato data", audit sistematico del recap
(step 6 Vantaggi + step 7 Conferma + riepilogo laterale) contro booking.php
13160-13330 + booking-wizard.js updateSummary. Divergenze CORRETTE + verificate:

- **Simbolo € DOPO l'importo nel recap** ("12,00 €", legacy euro() = Intl currency),
  distinto dalle CARD servizio che usano "€ 12,00" (euroCard). Applicato a
  recCostLines, recTotal, recFidelityDiscountAmount, recCreditAvail, giftcard,
  sumCostLines, sumTotal (helper euroRecap). Verificato live: Conferma "12,00 €".
- **Etichetta sconto Fidelity**: "Sconto Fidelity (N <label>)" con i punti usati e
  l'etichetta configurabile (era "Sconto Punti Fidelity" fisso).
- **Ordine righe sconto**: Fidelity → Credito → GiftCard (era Fidelity → GiftCard →
  Credito). Aggiunta classe summary-row--success.
- **Etichetta operatore recap**: nomi unici assegnati per servizio (join ", ", " …"
  se indeterminato) o "Qualsiasi" (era "Qualsiasi professionista" / "Più
  professionisti", stringhe inesistenti nel legacy).
- **Dettaglio operatore per-servizio** (recStaffDetails/sumStaffDetails): con più
  servizi rende "Servizio → Operatore" per riga (era vuoto).
- **Riepilogo laterale**: mostra gli sconti + totale scontato SOLO al riepilogo
  finale (step 7); fino ad allora prezzi di listino e totale = subtotale
  (sideSummaryDisableDiscounts legacy).
- **Box "Nessun vantaggio disponibile"**: nascosto quando ci sono benefit
  fidelity/credito/giftcard (hasBenefitsAvailable), non solo coupon.
- **Servizio a residuo** (redeem): riga costo a 0€ nel recap.

RESIDUI (documentati, richiedono dati/porting maggiore):
- Prezzi PER-SERVIZIO barrati+badge nel recap quando c'è una promo (renderPriceHtml
  per-servizio invece della riga sconto aggregata) — richiede il breakdown per-
  servizio da autoPromo/coupon nel recap PRE-conferma.
- Nota Fidelity earn ("Se questa prenotazione sarà eseguita, guadagnerai N Punti.")
  + saldo negativo + credito in sospeso — richiede l'esposizione dei punti maturati/
  saldo nella preview; la nota omaggio resta legata a Gifts v2 (non portato).


---

## Wizard booking: nota Fidelity "guadagnerai N Punti" (earn) — CHIUSO (2026-07-07)

Chiusa la parte earn del residuo nota-Fidelity. #recFidelityNote mostra ora anche
l'avviso di MATURAZIONE punti ("Se questa prenotazione sarà eseguita, guadagnerai N
<label>.", booking-wizard.js 2856-2859), oltre alla riserva dei punti riscattati.

- **Backend**: la action fidelity_preview calcola i punti maturati riusando il
  motore POS (computeCampaignEarn + getFidelityEarnSettings, ora esportati): come al
  POS, i punti si accreditano SOLO sotto una campagna earn ATTIVA (0 senza campagna),
  con fidelity attiva + tessera del cliente. Ritorna earn_points.
- **Wizard**: custBenefits.earnPoints; #recFidelityNote rende la nota earn (label
  dinamica) + la nota riserva se c'è sconto fidelity.

VERIFICA LIVE (Playwright, tenant 25 con campagna earn amount step 10 + tessera
cliente): fidelity_preview earn_points=1 (12€/10); Conferma → "Se questa
prenotazione sarà eseguita, guadagnerai 1 Punti." Campagna/tessera di test rimosse
(residuo 0). typecheck pulito.

RESIDUI FIDELITY rimasti (note niche/blocked): saldo NEGATIVO + credito in sospeso
(richiedono i dettagli wallet nella preview), e la nota OMAGGIO ("Puoi ottenere in
gift…") legata a Gifts v2 (sottosistema non portato).


---

## Wizard booking: note Fidelity saldo negativo + credito in sospeso — CHIUSO (2026-07-07)

Chiuse le ultime due note Fidelity portabili del recap (booking-wizard.js 2794-2836).
#recFidelityNote è ora una nota MULTI-RIGA (saldo negativo → credito in sospeso →
maturazione → riserva riscatto), non più singola.

- **Backend**: fidelity_preview espone balance_points (saldo GREZZO, può essere
  negativo, da dbWalletBalance) + pending_credit/pending_credit_codes (credito
  usato su appuntamenti pending/scheduled del cliente, con i public_code).
- **Wizard**: fidelityNoteParts costruisce le righe: "Il tuo saldo <label> è
  negativo di N…" e "Hai €X di credito in sospeso nella/nelle prenotazione/i
  #code…. Finché non sarà/saranno eseguita/e…" (codici slice 0-3 + "e altri N").

VERIFICA LIVE (Playwright, client9 punti=-5 + appuntamento pending credit 10 #ZZ-PEND):
Conferma → "Il tuo saldo Punti è negativo di 5…" + "Hai 10,00 € di credito in
sospeso nella prenotazione #ZZ-PEND. Finché non sarà eseguita…". Dati di test
rimossi (residuo 0). typecheck pulito.

UNICO residuo del wizard: nota OMAGGIO Fidelity ("Puoi ottenere in gift…") — legata
al sottosistema Gifts v2 (istanze dinamiche per cliente), non portato (come GiftBox).


---

## Pagina Notifiche "Appuntamenti in attesa" — port fedele (2026-07-07)

La pagina notifiche Next era un port SUPERFICIALE: card ridotte a titolo+messaggio+
"Apri" da una lista generica (listDbNotifications, che includeva anche gli scheduled),
senza dettagli né azioni. Portata 1:1 a notifications.php:

- **Backend** listNotificationPendingAppointments(slug, locationId): appuntamenti
  SOLO in attesa (pending/in sospeso/in attesa/attesa), tenant-safe (tenantSelect +
  batch query), con cliente (nome/tel/email), operatore (nome/tel/email), sede
  (nome/indirizzo), servizi (nomi + totale), sconto coupon dalle note
  (extractCouponMetaFromNotes), riepilogo pacchetto/prepagato (appointmentList
  Decorations), filtro sede corrente.
- **Route** action=pending: pending + gruppi Tessere Fidelity (riusa
  notificationFidelityCardGroups) + canManage + locationLabel.
- **Component**: card RICCHE 1:1 (servizio/data/ora, codice prenotazione,
  pacchetto/prepagato, operatore, sede, cliente, totale) + azioni Approva/Modifica/
  Annulla; Approva/Annulla riusano /api/manage/appointments (action=status) con
  l'INTERA lifecycle (restore hold su cancel + email approved/rejected). Sezione
  Tessere Fidelity in scadenza/scadute. Sottotitolo "Sede: <label>" dalla sede corrente.

VERIFICA LIVE (Playwright + sessione manage firmata, tenant 25 con appuntamento
pending di test): action=pending -> 5 card ricche (cliente Luca Rossi, operatore
luca+email, Sede1 Via Tremiti 6, totale € 12,00, codice); Approva -> lo stato passa
a scheduled; UI 1:1 col legacy ("Appuntamenti in attesa", Approva/Modifica/Annulla,
"Mostrando appuntamenti da 1 a N di N totali"). Appuntamento di test rimosso (residuo 0).

RESIDUO: il wiring completo delle NOTIFICHE BROWSER (permesso desktop + persistenza
preferenze + feed polling) resta un sottosistema JS a sé (BrowserNotifications.php);
i controlli sono presenti come markup. Modifica linka al calendario (il drawer
quick-booking inline non è portato in questa pagina).


---

## Pagina Notifiche: wiring notifiche browser (permesso + preferenze + feed) — CHIUSO (2026-07-07)

Chiuso il residuo del wiring desktop (era markup morto). Port di View.php 2000-2450
+ BrowserNotifications.php:

- **Preferenze**: il component carica (GET user-prefs get_browser_notification_
  preferences) e salva (POST) le preferenze; il tipo "appointments" resta locked+ON.
  Le chiavi vanno FLAT nel body (parseRequestBody stringifica gli oggetti annidati).
- **Permesso**: "Attiva notifiche browser" chiama Notification.requestPermission();
  l'etichetta/stile riflettono lo stato (Attiva / Notifiche browser attive /
  Notifiche bloccate / Notifiche non supportate), come updatePermissionButtons.
- **Feed**: route action=feed (port di BrowserNotifications::feed evento
  appointment_pending) ritorna gli appuntamenti in attesa come eventi {key,title,
  body,url}; il component fa polling ogni 15s, marca "visto" alla prima lettura
  (feedHydrated) e mostra una notifica desktop per ogni NUOVO evento (seen in
  localStorage).

VERIFICA LIVE (sessione manage firmata): action=feed -> 4 eventi con body
"test - Luca Rossi - 02/07/2026 10:15 - 11:15 - #11348"; prefs GET/SET (flat)
persistono; UI modal "Personalizza notifiche" coi toggle caricati (Prenotazioni in
attesa ON+locked), pulsante permesso che riflette lo stato del browser. typecheck pulito.

RESIDUO minore: il feed espone SOLO l'evento appointment_pending (il tipo sempre
attivo); gli eventi opt-in preventivi/rate/compleanni/tessere non sono nel feed
(estendibile). Modifica linka al Calendario (drawer quick-booking non portato).


---

## Notifiche: feed tipi opt-in + Modifica → drawer edit (2026-07-07)

Chiusi gli ultimi due residui della pagina notifiche.

### Feed browser: tutti i tipi opt-in
Il feed esponeva solo appointment_pending. Aggiunti gli eventi opt-in (port di
BrowserNotifications::feed): quote_response (countUnseenQuoteDecisions),
installment_due (notificationInstallmentGroups), client_birthday
(countUpcomingBirthdays), fidelity_cards (notificationFidelityCardGroups) — ognuno
gated dal permesso. Il component filtra per tipo secondo le preferenze utente
(appointment_pending sempre attivo). VERIFICATO: con un compleanno di test il feed
include {type:client_birthday, "Compleanno cliente", "1 cliente compie gli anni a
breve."}; dato ripristinato.

### Modifica → drawer quick-booking in EDIT mode
"Modifica" linkava al Calendario; ora è un elemento data-qb-edit={id} (+ data-qb-
reload-on-save) che apre il drawer quick-booking GLOBALE (montato in ManageShell)
in EDIT mode via il listener [data-qb-edit], come il legacy. VERIFICA LIVE
(Playwright): click Modifica su appt 139 -> "Modifica prenotazione" #11348 con
Cliente Luca Rossi, Servizi "test", Operatore luca, 02/07/2026 10:15-11:15, Cabina,
Stato "In attesa", note — il drawer completo prefillato.

RESIDUO minore: il drawer Next non gestisce data-qb-reload-on-save, quindi dopo un
salvataggio dal drawer la lista pending non si auto-aggiorna (refresh manuale o
Approva/Annulla la aggiorna). Il sistema notifiche è per il resto completo.


---

## Notifiche: auto-refresh lista dopo salvataggio dal drawer (2026-07-07)

Chiuso l'ultimo residuo minore: dopo un salvataggio/modifica dal drawer quick-
booking la lista "Appuntamenti in attesa" si aggiorna. Il component ascolta
l'evento "qb:appointments-changed" (già emesso dal drawer, come per il calendario)
e ri-carica action=pending — più fedele/reattivo del reload di pagina del legacy
(data-qb-reload-on-save). VERIFICATO live (Playwright): dispatch dell'evento ->
una nuova richiesta action=pending (la lista si ricarica).

Il sistema notifiche è ora COMPLETO: card ricche + Approva/Modifica/Annulla, sezione
Tessere Fidelity, notifiche browser (permesso + preferenze + feed con tutti i tipi),
Modifica -> drawer edit, auto-refresh post-salvataggio. Nessun residuo.


---

## Dashboard: fedeltà 1:1 con dashboard.php + api_dashboard_performance.php (2026-07-07)

Analisi approfondita di TUTTA la dashboard (KPI, statistica settimanale, grafico,
prossimi appuntamenti, avvisi, costi) vs il legacy. La struttura, la tabella
appuntamenti e i 6 avvisi (ordine/key/icone/gating identici) erano già fedeli; le
divergenze erano concentrate nella statistica settimanale e nei link. Chiuse tutte:

### Ricavi settimanali/serie: LEFT JOIN + fallback (era INNER JOIN)
Il port usava `JOIN appointment_services` (inner): gli appuntamenti senza righe
servizio contribuivano 0. Ora port fedele del CASE legacy — `LEFT JOIN
appointment_services` e, se l'appuntamento non ha righe servizio, fallback su
`services.price` via `a.service_id` (join guardato da columnExists). qty:
`COALESCE(NULLIF(sv.qty,0),1)` (0 -> 1, come il legacy). Applicato sia alla
settimana sia alla serie giornaliera. VERIFICATO live: Ricavi settimana "€ 12,00",
serie con 12 su 10/07.

### Formattazione numerica it-IT (raggruppamento manuale server-side)
Node non raggruppa 1000-9999 con toLocaleString('it-IT'): aggiunti formattatori
manuali. Ricavi/Vendite = "€ 1.234,56" (simbolo PRIMA, come fmt_money/fmtEUR);
Appuntamenti/Nuovi clienti = fmtNum raggruppato; Ore lavorate = "3,5" SENZA " h"
(era "3,5 h"). VERIFICATO live: Ore "1" senza unità.

### Delta a 1 decimale (era intero)
pctChange restituisce ora la percentuale GREZZA; il rendering (deltaText, port di
setDelta) arrotonda a 1 decimale con virgola ("+12,5%"). Colori invariati
(success/danger/muted). VERIFICATO live: delta "—" (null) e "-100%".

### Grafico ricavi: stile 1:1 con dashboard.js
Colore #2f63f4 (era #0d6efd), tension 0.4 (curva morbida, era 0 spezzata), point
radius 2.5/hover 4, borderWidth 2.25, interaction index, tooltip con valuta it-IT,
assi con griglie/colori #405693 e tick asse Y "€ N" (Intl it-IT, 0 decimali).
VERIFICATO live (Playwright): borderColor #2f63f4, tension 0.4, canvas dipinto.

### Nuovi clienti per sede: EXISTS cross-tabella
Il conteggio per sede considerava solo `clients.location_id`; ora (come il legacy
client_location_sql) conta il cliente se ha la sua location OPPURE un appuntamento
(location o NULL) o una vendita in quella sede (EXISTS guardati da columnExists,
tenant-safe).

### Costi: filtro residuo, MIN(due_date), sede stretta, link con date
Aggiunto `AND residuo > 0.00001` (quando esiste paid_amount, come il legacy),
filtro sede STRETTO `location_id=?` (era permissivo OR NULL), MIN(due_date) per il
link "scaduti". I due link ora portano le date: "Vedi scaduti" from=MIN(due_date)
(fallback inizio mese) to=oggi; "Vedi mese" from=inizio mese to=fine mese (prima
erano identici e senza date). VERIFICATO live: from/to presenti su entrambi.

### Fail-closed statistica settimanale + KPI
Come dashboard.php ($dashboardLocationFailClosed): tenant multi-sede senza sede
selezionata -> KPI a 0, empty response settimanale (delta 0.0, serie a zero),
card "Prossimi appuntamenti" e "Costi" nascoste. Prima Next azzerava solo gli
avvisi e calcolava i KPI/settimanali su tutte le sedi.

VERIFICA LIVE: GET /api/manage/dashboard (centroesteticoelite, sede 21) ->
Clienti 6, Vendite 30gg "€ 40,00", settimana 06/07-12/07 con Ricavi "€ 12,00";
render pagina 200, nessun errore JS, grafico dipinto. Nessuna scrittura DB
(solo SELECT), residuo test = 0.


---

## Lista appuntamenti: filtro sede + segmenti duplicati + operatore riga padre (2026-07-07)

Analisi/confronto approfondito di appointments.php vs il port Next
(components/modules/appointments-content.tsx + app/api/manage/appointments +
listDbAppointments/appointmentServiceLines). Il MULTI-SERVIZIO era già completo e
funzionante (riga padre "Multi-servizio (N)" espandibile + figli con orari/
operatore per segmento + riordino ↑/↓ swap_segment): non compariva solo perché il
tenant di test ha UN solo servizio. Dimostrato con test live (2° servizio temp +
prenotazione multi-servizio → rendering + riordino OK, poi ripristino, residuo=0).

Chiuse le 3 divergenze reali trovate:

### #1 Filtro sede nella lista (era assente)
listDbAppointments non filtrava per sede → elencava gli appuntamenti di TUTTE le
sedi (il legacy filtra per la sede corrente, permissivo location_id=? OR NULL).
Aggiunto il parametro opzionale `locationId` (guardato da columnExists) e il route
GET (lista + calendario) ora risolve la sede corrente via resolveManageLocationId e
la propaga. VERIFICATO live: un appuntamento spostato su una sede diversa (9999)
sparisce dalla lista (sede corrente 21), mentre gli appuntamenti loc 21/NULL restano.

### #3 Righe segmento per servizio DUPLICATO (collisione)
appointmentServiceLines mappava i segmenti per service_id: due segmenti dello STESSO
servizio nello stesso appuntamento collidevano (il 2° ereditava segmentId/orario del
1°, riordino rotto). Riscritto per costruire UNA RIGA PER SEGMENTO in ordine di
posizione (come il legacy che raggruppa per segmento), nome/prezzo risolti da
appointment_services con fallback su services. VERIFICATO live: "test,test" ora dà 2
segmentId distinti (319/320) con orari 09:00-10:00 e 10:00-11:00.

### #2 Operatore riga padre multi-operatore
La cella operatore della riga padre mostrava solo il primo operatore; il legacy
($opSummary) con operatori DIVERSI mostra i nomi uniti "A, B", altrimenti l'unico
nome. Portato 1:1 (parentStaffNames dai segmenti). Verificato via typecheck (non
testabile live: il tenant ha un solo operatore).

Confermate fedeli senza modifiche: filtri Dal/Al/Cerca, badge stato, codice
prenotazione, azioni Modifica/Elimina (solo Annullati) + guard, bulk delete +
messaggi/contatori, riepiloghi pacchetto/prepagato, pallini colore, stati vuoti,
deep-link, conferme, toast riordino. Nessuna scrittura DB residua (test ripristinati,
residuo=0).

### Follow-up: key React univoca sulle righe figlie multi-servizio
Il Fix #3 (righe per segmento) ha esposto una key React duplicata quando due
segmenti hanno lo STESSO servizio (es. appt 175: 2 segmenti service_id 9 →
"Encountered two children with the same key `175-svc-9`" all'espansione). La key
delle righe figlie ora usa il segmentId (univoco) + index invece del serviceId.
VERIFICATO live (Playwright): espansione di appt 175 senza errori console, 2 righe
figlie corrette (↳ 14:00→15:00 test/luca, ↳ 13:50→14:50 test/—) con riordino.

### Follow-up: toggle multi-servizio ("non accade nulla" al click sulla freccia)
Il pulsante di espansione aveva SIA data-bs-toggle="collapse"/data-bs-target (plugin
Bootstrap Collapse, caricato globalmente) SIA l'onClick React (toggleExpanded): due
handler sullo stesso click che si annullavano nel browser reale → la riga non si
apriva. Rimossi gli attributi Bootstrap: l'apertura è ora gestita SOLO da React
(stato expanded + classe show + display inline sulle righe figlie). VERIFICATO
(Playwright): click ripetuti 0→2→0→2 righe visibili, freccia chevron-right/down.

### Fix definitivo toggle multi-servizio: conditional rendering
La rimozione dei soli attributi Bootstrap non bastava nel browser reale (in Playwright
headless l'ordine eventi mascherava il problema). Fix definitivo: le righe figlie
(tr.ms-child) vengono RENDERIZZATE solo quando `expanded` è true (`isMulti && expanded
&& lines.map(...)`), senza più classi Bootstrap collapse/show né display inline —
nessuna dipendenza dal CSS globale .collapse:not(.show) né dal plugin Collapse. Il
toggle è ora puro stato React, deterministico su ogni browser. VERIFICATO con workflow
adversariale (3 verificatori Playwright indipendenti sul codice live): (A) 6 click →
2,0,2,0,2,0 figlie visibili + freccia che gira, 0 errori; (B) click utente + reload →
2 figlie col contenuto esatto in entrambe le sessioni; (C) 0 tr.ms-child da chiuso,
toggle solo sulle righe multi, nessun errore duplicate-key, badge presente.


---

## Dashboard: 2° audit completo (workflow) — residui chiusi (2026-07-07)

Audit indipendente (workflow: 6 lettori paralleli per sotto-area + verifica
adversariale di ogni divergenza; 28 confermate su 31 candidate, 3 già-risolte).
Verifica numerica live PASS (ogni valore API == ricalcolo dal DB). Chiusi i residui
materiali; le cosmetiche (BETWEEN vs semiaperto, guardia pct_change) e il modello
location cross-cutting (userHasNoLocations) lasciati come deliberati.

### KPI: filtro sede STRETTO su clients/sales/Vendite30 (era permissivo)
Il legacy usa `location_id=?` STRETTO per i rami clients (dashboard.php:66) e sales
(:75) dell'UNION Clienti e per Vendite 30gg (:110); solo il ramo appuntamenti è
permissivo (:71/48). Il Next li aveva resi tutti permissivi (OR IS NULL) →
sovrastima con anagrafiche/vendite a sede NULL. Aggiunto helper locStrict; ramo
appuntamenti resta locFilter. VERIFICATO live: Clienti 6→4, identico al ricalcolo
STRETTO legacy (2 clienti sede-NULL senza appuntamenti/vendite in sede correttamente
esclusi).

### Ricavi settimanali: simbolo € DOPO (Intl it-IT)
Il KPI settimanale "Ricavi" del legacy usa dashboard.js fmtEUR = Intl currency it-IT
= "1.234,56 €" (simbolo DOPO), mentre il KPI "Vendite 30gg" usa `€ fmt_money` (PRIMA).
Erano stati unificati a "€ ...". Separati: fmtEuroBefore (Vendite 30gg) / fmtEuroAfter
(Ricavi settimanale). VERIFICATO live: Vendite "€ 40,00", Ricavi "24,00 €".

### Avviso Tessere Fidelity: gate su sorgente corretta + renewal + reminder-days
getFidelityConfig leggeva automation_settings.fidelity_expiry_reminder_enabled (toggle
EMAIL) invece della config scadenza tessera da businesses.fidelity_adhesion_json →
falsi negativi/positivi. Nuovo fidelityCardExpiryNotificationConfig (db-repositories,
port di fidelity_card_expiry_notification_config): disabled se scadenza spenta,
altrimenti renewal (rinnovo attivo) o reminder (expiry_reminder_days). Aggiunta
modalità renewal in getFidelityCardAlertGroups (finestra [scadenza-window, scadenza],
status "In finestra rinnovo") e window/segno via fidelityAddCardDurationYmd. Verifica
adversariale (agente indipendente): FEDELE punti 1-6. No-op per tenant senza tessere.

### Prossimi appuntamenti: nome servizio snapshot + fallback a.service_id
Usato lo SNAPSHOT appointment_services.service_name (fallback nome corrente) e, se
l'appuntamento non ha righe servizio, fallback su a.service_id → services.name (come
COALESCE(sv.services_name, s.name) legacy). Prima gli appuntamenti senza righe
mostravano "—" e i servizi rinominati il nome corrente.

### Altri residui
- Fail-closed: card "Prossimi appuntamenti" resta VISIBILE ma VUOTA (upcoming [])
  se calendar.view, invece che nascosta (dashboard.php:214-215,594).
- Ore lavorate: delta sul valore GREZZO (no round2) come il legacy.
- Avvisi: overflow "…e altri" per staff_off (maschile, dashboard.php:668) vs "…e
  altre" per gli altri (:654).
- Importo rate: raggruppamento migliaia MANUALE (trappola toLocaleString it-IT Node).
- Grafico: fallback "Grafico non disponibile al momento." + elemento #perfError se
  Chart.js non carica entro ~3s (port di setPerfError).
- previewLimit parametrizzato (3 dashboard / 5 pagina notifiche, notifications.php:322)
  — fix collaterale trovato dalla verifica adversariale.

VERIFICATO: tsc pulito; render Playwright senza errori console; KPI/€/grafico/avvisi
corretti; nessuna scrittura DB (solo letture).


---

## Calendario: audit completo (workflow) — batch 1: permessi + note + accenti (2026-07-07)

Audit indipendente (workflow: 11 lettori paralleli + verifica adversariale; 57
divergenze confermate su 60, 3 già-risolte). Verifica live PASS (render Giorno/
Settimana/Mese senza errori). Chiuso per primo il cluster 🔴 PERMESSI (sicurezza).

### 🔴 Escalation permessi (server + client) — CHIUSA
Il legacy separa appointments.manage (modifica/sposta/ridimensiona/note) da
quick_booking (solo crea). Il port non lo replicava.
- SERVER (appointments route): aggiunto gate `appointments.manage` su action=move,
  action=status e save-in-modifica (isEdit); create richiede quick_booking. Prima
  l'unico check era l'ombrello canAny([manage,plan,quick_booking]) → un utente
  quick_booking-only poteva spostare/ridimensionare/modificare.
- SERVER (calendar route): note_save/note_delete ora richiedono SOLO
  appointments.manage (api_calendar_notes.php:19), non più manage|quick_booking.
- CLIENT: il contesto /api/manage/calendar espone canManageAppointments/
  canCreateAppointments; calendar-content li usa per gatare gli handler
  (postMove, beginResize, openGlobalEdit → manage; openGlobalQuickBook → create).
VERIFICATO live: token quick_booking-only → 403 su move/status/save-edit/note
(prima 200); admin → passa il gate (200/400). Nessuna regressione admin (2 eventi
draggable, render pulito).

### Note: perdita a-capo (M18)
clean() faceva .replace(/\s+/g," ") → note multi-riga appiattite. Ora solo trim +
taglio (calendar_notes_trim, api_calendar_notes.php:37-48).

### Accenti giorni (L5/L9)
IT_WEEKDAYS: "lunedi/martedi/..." → "lunedì/martedì/mercoledì/giovedì/venerdì".
VERIFICATO live: titolo "Martedì 7 luglio 2026".

Restano da chiudere (batch successivi): filtri Giorno/Settimana (colonne/totali/
multi-servizio), note in vista Mese (marker/griglia 42gg/data default), titoli
Settimana/Mese, gating UI note read-only, e i residui 🟡/⚪.

## Calendario batch 2: titoli Settimana/Mese + note read-only (2026-07-07)

### Titoli toolbar (M4/L4)
Settimana: aggiunti i NOMI dei giorni come updateCalendarTitle (calendar.js:1226-1236)
-> "Lunedì 6 - Domenica 12 luglio 2026" (era "6 - 12 luglio 2026"); a cavallo mese/
anno anno su entrambi. Mese: range primo-ultimo giorno del mese (monthViewTitle) ->
"Mercoledì 1 - Venerdì 31 luglio 2026" (era "Luglio 2026"); monthTitle resta per il
mini-picker. VERIFICATO live entrambi.

### Note read-only (M21)
I controlli di scrittura (Nuova / Salva nota / Elimina) sono nascosti senza
appointments.manage — completa il gate note lato client.

## Calendario batch 3: filtri (2026-07-07)

Filtro Operatore (Giorno): non riduce più le colonne (M6) — tutte visibili come il
legacy STAFF_DAY_COLS; è applicato agli EVENTI (visibleAppts) come il filtro
server-side staff_id, così il totale lo riflette (M7). Conteggio per colonna =
appuntamenti DISTINTI, non i blocchi/segmenti (M8). Filtri Operatore e Servizio
SEGMENT-AWARE (M16/M17): un multi-servizio matcha se un QUALSIASI segmento/servizio
corrisponde (apptInvolvesStaff/apptIncludesService), non solo il primario — come il
filtro server staff_id/service_id. VERIFICATO live: filtrando per "test2" (servizio
non primario di #42806) l'appuntamento resta visibile; total conta 1 (distinto) con 2
segmenti; filtro stato canceled -> 0. M2 (servizi per sede) non rilevante (1 sede).

## Calendario batch 4: note vista Mese (2026-07-07)

- M19: il marker nota in vista Mese ora APRE le note del giorno (onClick +
  stopPropagation) invece della prenotazione rapida (prima il click ricadeva sulla
  cella). VERIFICATO live: click marker -> modale note aperta, drawer quick-book NON
  aperto.
- M22: il "periodo visibile" delle note in Mese è il MESE ESATTO (1..ultimo), non la
  griglia di 42 giorni (periodNotes); marker solo sui giorni del mese (no spillover);
  badge/conteggio esatto-mese. VERIFICATO: 1 marker + badge "1" su nota del 15/07.
- M23: la data della nuova nota è prefillata sul giorno CLICCATO (resetNotesForm(iso))
  invece del giorno focalizzato. VERIFICATO: form date "2026-07-15".
- L24: etichetta "Periodo visibile" mostra il range della vista (settimana/mese),
  non sempre un singolo giorno.
Nota: a-capo note preservati (M18 batch 1) riconfermato live ("Riga 1\nRiga 2").

## Calendario batch 5: multi-servizio conteggio segmenti (L16) (2026-07-07)

msCountOf ora conta i SEGMENTI (a.segments.length>1) e non più max(segments,services):
un appuntamento con più appointment_services ma UN solo segmento non è multi-servizio
nel legacy (rende un evento per segmento, MS = HAVING COUNT(segments)>1). VERIFICATO
live: il multi-servizio reale (#42806, 2 segmenti) rende ancora correttamente.

Residui deliberatamente NON chiusi (cosmetici/edge, basso valore / alto costo di
verifica su calendar.js 5204 righe): L13 (label HH:MM sull'indicatore ora — aggiunta
utile, non un bug), M5/L10-L12 (ombreggiatura chiusure Settimana + eccezioni is_closed),
L14 (hover su scroll/resize), L15 (palette accenti MS), L17 (colore pallino operatore),
e ~12 minori (deep-link ?calendar_date/view, picker responsive/align-right, eventAllow
oltre orario, meta card note, autofocus, badge 99+, ecc.). Elencati nell'audit.

## Calendario batch 6: giorno con sola fascia pomeridiana = CHIUSO (L12) (2026-07-07)

Come getStoreScheduleForDow (effectiveClosed = isClosed || !opens || !closes) un
giorno con la PRIMA fascia (mattino) vuota è CHIUSO anche se la seconda (pomeriggio)
è valorizzata; il port lo apriva rendendo solo il pomeriggio. Corretto nel calcolo
schedule standard (salta la riga se manca la fascia mattutina). VERIFICATO: gli orari
normali del tenant restano invariati (grid + eventi ok, nessun errore).

Batch 6 chiude L12. Gli altri 🟡 restano deliberatamente aperti perché o discutibili
(L13 label ora = aggiunta utile, L10 eccezione is_closed = chiusura sensata) o
complessi/cosmetici ad alto costo di verifica e impatto quasi nullo (L14 hover su
scroll, L15 palette accenti MS, L17 colore pallino operatore senza calendar_color,
M5 banda "Chiuso" in Settimana, L11 estensione asse): elencati nell'audit calendario.

## Calendario batch 7: now-indicator senza label + accenti MS fedeli (2026-07-07)

- L13: rimossa la label HH:MM sull'indicatore ora (Giorno+Settimana) — il legacy
  (FullCalendar nowIndicator) rende solo linea + freccia. VERIFICATO: 0 label,
  line+arrow presenti.
- L15: accenti multi-servizio col PORT FEDELE di getMsAccentForGroup (calendar.js
  3887-3959): palette-first evitando i colori di STATO (MS_STATUS_COLORS) e i colori
  OPERATORE del giorno, poi fallback golden-angle hslToHex(idx*137.508,0.78,0.48).
  Prima: palette[seq%15] senza evitare collisioni. VERIFICATO: #42806 -> #7c3aed.

Residui calendario FINALI (deliberati): L14 (hover su scroll — complesso, basso
valore), L17 (colore pallino operatore senza calendar_color — rischio accent reuse),
M5 (banda Chiuso Settimana), L10 (eccezione is_closed = chiusura sensata), L11
(estensione asse). Tutto il resto (sicurezza, funzionale, visibile, cosmetico
verificabile) è chiuso.

## Appuntamenti: rilascio prenotazione promozione su annulla/elimina (2026-07-07)

Audit backend Appuntamenti (3 analisi parallele: delete+restore, cancel_done+status,
save) + test live del ciclo di vita. FIX della sola divergenza HIGH a impatto reale
(le altre erano multi-sede o dati-migrati): il rilascio della prenotazione promozione
mancava del tutto. createDbAppointment scrive una riga promotion_redemptions
(appointment_id) che conta nel per_customer_limit, ma né deleteDbAppointment né
cancelDoneAppointment la cancellavano → il cliente perdeva PERMANENTEMENTE uno slot
promo. Aggiunto releaseAppointmentPromotionReservation (port di
Promotions::releaseAppointmentReservation, Promotions.php:5365/5163): DELETE
promotion_redemptions WHERE appointment_id=? AND (sale_id IS NULL/0) + UPDATE
appointments SET promotion_id=NULL, promotion_conditions=NULL. Chiamato all'ANNULLO
(cancelDoneAppointment, come AppointmentLifecycle.php:1294) e all'ELIMINAZIONE
(deleteDbAppointment, come appointments.php:256/469). VERIFICATO live: appuntamento con
redemption -> annullo -> redemption rilasciata (count 0) + promotion_id azzerato;
residuo=0.

Divergenze NON corrette (confermate ma a impatto nullo su questo tenant mono-sede/dati
nativi, elencate per riferimento): save senza validazione sede-servizio/sede-operatore
(multi-sede), earn non su create-as-done (dipende dal drawer), cleanup tabelle-link QB
giftbox/package/prepaid (solo dati migrati), guard per-sede su delete/edit (multi-sede),
points_storno_mode/preview blockers (TODO nel codice), notes non specchia staff_notes,
public_code [10000-99999] senza zeri iniziali, reminders cleanup solo pending.

## Appuntamenti: fix universali (public_code + cleanup delete) (2026-07-07)

Batch di fix a impatto universale (anche dati nativi/mono-sede), basso rischio:
- public_code: 5 CIFRE INDIPENDENTI 0-9 con zeri iniziali conservati (port di
  generate_public_code, Helpers.php:7921 — es. "04812"), non più [10000-99999].
  VERIFICATO: ~10% dei codici con zero iniziale (prima 0%).
- deleteDbAppointment ora cancella TUTTI i reminder dell'appuntamento (legacy
  appointments.php:259/470 `DELETE FROM reminders WHERE appointment_id=?`, non solo i
  pending) + le tabelle-link QB legacy appointment_giftbox_items/appointment_package_
  items/appointment_prepaid_service_items (dati MIGRATI; best-effort, no-op sui nativi).
  VERIFICATO live: reminder 'sent' + appointment_package_items rimossi all'elimina.
NB: gli orfani reminders pre-esistenti (da eliminazioni precedenti) NON toccati (dati
non creati in sessione); il fix previene nuovi orfani.

## Appuntamenti multi-sede: validazione sede↔servizio/operatore nel save (2026-07-07)

Attivato il MULTI-SEDE (creata Sede 2 id 51 + assegnazioni service_locations/
staff_locations/cabins) e chiusa la divergenza HIGH #2: il save del drawer non
validava sede↔servizio/operatore (booking cross-sede possibile). Aggiunto
assertServicesAndStaffAllowedInLocation (port di app_service_location_allowed /
app_staff_location_allowed via app_entity_location_allowed, Helpers.php:1154-1165):
un servizio/operatore con righe service_locations/staff_locations DEVE includere la
sede scelta; senza righe vale ovunque. Chiamato in createDbAppointment E
updateDbAppointment dopo assertStaffAllowedForServices. Errori verbatim del drawer
(api_appointments.php:3736/3823). VERIFICATO live a stadi: operatore fuori sede ->
"Operatore non disponibile nella sede selezionata."; servizio fuori sede -> "Servizio
non disponibile nella sede selezionata."; entrambi in sede + cabina -> prenotazione OK.
Setup Sede 2 lasciato attivo (indirizzo placeholder "Via Roma 1" da rinominare via UI).

## Appuntamenti multi-sede: guard per-sede su edit/delete/move/status (2026-07-07)

Chiusa l'ultima divergenza multi-sede (#8 MEDIUM): mancava il gate per-sede
sull'accesso all'appuntamento nelle azioni di gestione. Portato
api_appt_require_appointment_access -> app_location_allowed_for_user
(api_appointments.php:3675 / Helpers.php:660) come helper esportato
appointmentLocationAllowedForUser(slug, user, appointmentId): admin o utente senza
restrizioni di sede (locationIds vuoto) -> sempre; appuntamento senza sede (location_id
NULL/<=0) -> permissivo; altrimenti la sede dell'appuntamento DEVE essere tra quelle
assegnate all'utente. Cablato in app/api/manage/appointments/route.ts nelle azioni
status, move, save (ramo isEdit) e delete/bulk_delete (single -> errore 403, bulk ->
skip contato tra "non disponibili"). Errore verbatim "Prenotazione non trovata o non
disponibile nella sede corrente." (403). VERIFICATO live (6/6) con token firmati ad
hoc: utente ristretto a Sede1 [21] -> 403 su status/move/delete/save del Sede2 (417);
consentito sul Sede1 (416); admin (locationIds vuoto) consentito ovunque. Appuntamenti
di test creati e rimossi (residuo=0, inclusi i reminder generati dalle chiamate status).
Nota: la sessione è interamente serializzata nel cookie firmato, quindi locationIds/role
vengono letti dal token (impostati al login da loginLocationState su user_locations).

## Calendario: match colonna operatore PER ID (bug operatori omonimi) (2026-07-07)

BUG (emerso creando un 2° operatore quasi omonimo, "luca" id22 / "Luca" id56): il
calendario assegnava gli appuntamenti alle colonne PER NOME operatore (case-insensitive),
non per staff_id come il legacy → un appuntamento dell'operatore 22 compariva DUPLICATO
anche nella colonna dell'operatore 56 (stesso nome). FIX: match per ID con fallback al
nome (dati senza id). (1) mapAppointment espone operatorId (da appointment_staff, la
tabella appointments non ha staff_id) — appointmentStaffName→appointmentStaffRef {id,name};
AppointmentWithMeta.operatorId. (2) client calendar-content: helper staffColMatches(col,
staffId, staffName) usato in apptsForStaff (colonne Giorno, per-segmento seg.staffId +
singolo a.operatorId), apptInvolvesStaff (filtro Operatore), moveBlockDay (no-op drag
"stesso operatore" per id), findOperatorStaff (pallino colore/foto Settimana/Mese per id).
VERIFICATO live (4/4): l'API espone operatorId=22 + segments[].staffId; simulando il
matching, appt 408 → colonna 22 PRESENTE (2 segmenti), colonna 56 ASSENTE (no duplicato).
NB: le colonne restano PER TUTTI gli operatori (legacy STAFF_DAY_COLS) — un operatore
senza appuntamenti mostra colonna vuota, corretto; NON "solo operatore loggato".

## Appuntamenti multi-sede: scope per-sede in LETTURA (calendario + refresh) (2026-07-07)

Chiuso il leak cross-sede in lettura: il feed legacy (api_appointments.php action=list
:8044-8052) e la lista pagina (appointments.php :752-774) filtrano gli appuntamenti per
sede corrente ("a.location_id = ? OR a.location_id IS NULL"). Nel Next la lista Gift
principale (GET /api/manage/appointments) era già scoped via resolveManageLocationId ->
listDbAppointments(locationId), ma mancavano due superfici:
- calendarContext (lib/manage-calendar.ts): l'INIT del calendario caricava
  listDbAppointments senza sede -> aggiunto filtro in-memory scopedAppointments
  (location_id = currentLocationId OR NULL; currentLocationId<=0 -> tutti, come le
  chiusure/eccezioni già portate). currentLocationId da getManageLocationContext (sessione).
- Le 6 risposte POST post-mutazione (status/move/save/delete/... -> "appointments:
  listDbAppointments({slug})") tornavano la lista NON filtrata: aggiunto locationId:
  postListLocationId (risolto una volta a inizio POST). Admin/sede-non-attiva -> 0 ->
  nessun filtro (storico).
VERIFICATO live (12/12, token firmati ad hoc): (feed) ristretto a Sede1 [21] vede solo
l'appuntamento della sua sede, nasconde il Sede2; admin vede entrambi. (refresh) status
del ristretto sul proprio Sede1 -> lista di ritorno esclude il Sede2 (count 10 vs admin
11). Appuntamenti di test creati e rimossi (residuo=0, inclusi reminder da status).
Le COLONNE staff e la TENDINA servizi del calendario sono ora entrambe filtrate per
sede (vedi voci dedicate sotto). Multi-sede calendario: nessun residuo di filtro sede.

## Calendario multi-sede: filtro COLONNE operatore per sede (2026-07-07)

Chiuso il residuo colonne: il calendario mostrava TUTTI gli operatori come colonne
anche se assegnati ad altre sedi. Portato app_filter_staff_ids_by_location ->
app_filter_ids_by_location (Helpers.php:1057-1087) come helper filterStaffByLocation
in calendarContext: STRICT come il legacy — un operatore con righe staff_locations è
mostrato SOLO nelle sedi elencate; chi ha righe solo per altre sedi viene nascosto.
currentLocationId<=0 (single-sede/nessuna) -> tutti. DIFFERENZA DI SICUREZZA voluta:
se NESSUN operatore ha alcuna riga staff_locations (feature non configurata o errore
query) si restituisce lo staff invariato invece di azzerare le colonne (il legacy
mostrerebbe zero colonne -> calendario vuoto). Filtra sia le colonne Giorno sia la
tendina Operatore e il resolve currentStaffId (tutti da context.staff). VERIFICATO live
(4/4, dati esistenti, nessuna modifica): Sede1 -> operatori 22 (21+51) e 56 (solo 21)
entrambi presenti; Sede2 -> solo 22, il 56 filtrato via. NB: le colonne restano PER
TUTTI gli operatori ammessi nella sede (non "solo loggato"); un operatore ammesso senza
appuntamenti mostra colonna vuota, corretto.

## Calendario multi-sede: filtro TENDINA servizi per sede (2026-07-07)

Chiuso l'ultimo residuo sede del calendario: la tendina "Servizio" del filtro mostrava
tutti i servizi. Portato app_service_location_allowed / app_filter_service_ids_by_location
(Helpers.php:1160-1210) come helper filterServicesByLocation in calendarContext,
applicato a context.services. PERMISSIVO (a differenza dello staff che è strict): un
servizio SENZA righe service_locations resta disponibile ovunque; un servizio CON righe
è mostrato solo nelle sedi elencate. currentLocationId<=0 -> tutti. TRAPPOLA: il param
locationId di listDbServices NON basta — mapService imposta sempre locationIds:[] quindi
quel filtro è un no-op; per questo si interroga service_locations direttamente. Tocca
SOLO la tendina filtro del calendario (il drawer QB è il componente globale separato
quick-booking-drawer.tsx, non usa context.services). VERIFICATO live (4/4, dati
esistenti): Sede1 -> servizi 9 (21+51) e 82 (solo 21); Sede2 -> solo 9, l'82 filtrato via.

## Pacchetti: emissione fedele — snapshot non-retroattivo, sedute solo-servizi, sede (2026-07-08)

Audit completo del modulo Pacchetti (catalogo + pacchetti cliente) confrontato con
pos.php / packages.php / ClientPackages.php / ClientPackageSnapshot.php. FEDELI e
verificati: catalogo CRUD, formula prezzo (line_total = round(qty*unit − clamp(disc));
total = round(Σ line − clamp(totalDisc)); sessions_total = Σ qty dei soli SERVIZI),
validazioni (nome, ≥1 servizio, sede obbligatoria), delete-detach (package_id→NULL,
package_name conservato, figli droppati), consume/restore per-servizio con riserve su
prenotazioni aperte, update_expiry (guard "già utilizzato" = remaining<total o completed;
riattivazione bloccata se un contenuto è stato eliminato), stati derivati
(attivo/completato/scaduto/annullato), blocco creazione manuale ("solo da Pagamenti").

TRE bug di EMISSIONE trovati e corretti (i prodotti dentro un pacchetto erano gestiti male):

1. issueDbClientPackage (packages route action=issue). sessions_total sommava anche i
   PRODOTTI: mapPackageCatalogItem assegna sessions=qty a OGNI item (prodotti inclusi),
   quindi un pacchetto svcA×2 + svcB×1 + prodA×1 emetteva 4 sedute invece di 3. Ora usa il
   sessions_total memorizzato (calcolato in salvataggio dai soli servizi).
   insertClientPackageItemsFromCatalog riscritto: legge i package_items grezzi, snapshotta
   ogni item col SUO item_type, crea client_package_services SOLO per i servizi. Prima
   salvava tutto come item_type='service' → il ritiro-prodotto (usage_add product, che cerca
   client_package_items con type='product') era ROTTO.

2. issueDbPackageFromSale (conversione preventivo→vendita, via checkoutDbSale). Impostava
   sessions_total = qty venduta e NESSUNO snapshot. Ora delega a issueDbClientPackage
   (sedute dal catalogo + snapshot completo) e imposta location_id.

3. issuePackageFromSale (checkout POS di PRODUZIONE, manage-pos). sessions_total già corretto
   (packageSessionsTotal) e client_package_services già creati, MA nessuno snapshot
   client_package_items — il legacy chiama ClientPackageSnapshot::snapshotFromCatalog
   ("Snapshot contenuto pacchetti cliente (non retroattivo)"). Aggiunto
   snapshotClientPackageItemsFromCatalog (preferisce package_items servizi+prodotti, fallback
   sui servizi) + location_id (legacy pos_update_client_package_context $posLocationId). Senza
   lo snapshot, se il catalogo veniva in seguito eliminato/modificato il contenuto PRODOTTI del
   pacchetto cliente andava perso (il fallback su catalogo di clientPackageSnapshotItems non
   aveva più il package_id) → il ritiro-prodotto smetteva di funzionare.

VERIFICATO live:
- test-pacchetti (26/26): catalogo+validazioni+formula prezzo+righe; issue (sedute 3, non 4);
  consume/restore servizio; SNAPSHOT prodotto item_type='product' + niente riga sedute per il
  prodotto; ritiro prodotto (stock 5→4→5); update_expiry (data valida/passata/pacchetto usato);
  client_save edit/annullo bloccato; stati derivati; delete-detach; listing.
- test-pkg-pos (8/8): checkout POS reale con riga pacchetto → sessions_total=3 (dal catalogo,
  NON dalla qty), sede=21, client_package_services solo-servizi, client_package_items snapshot
  con prodotto item_type='product'; poi DELETE catalogo → CP detached ma snapshot CONSERVATO;
  ritiro prodotto post-delete ancora funzionante (prova del "non retroattivo").
- Regression: test-pos-checkout 8/8 (checkout servizi/sconto/annulla/elimina intatto),
  test-magazzino 41/41, typecheck 0 errori.
Residui ZZ=0 in services/products/packages/client_packages/sale_items/stock_docs; 5 clienti reali intatti.

## Preventivi: audit completo + fix conversione POS (accepted-only, idempotenza, pacchetti, prezzo, stato paid) (2026-07-08)

Audit 1:1 del modulo Preventivi confrontato con quotes.php (2647 righe) + QuoteSale/
QuotePackage/QuoteAvailability/QuotePdf + il flusso di conversione in pos.php. Due famiglie
di funzioni nel Next: quelle "Legacy-fedeli" (cablate nella UI) e quelle "compat" (non
cablate nella UI). La route /api/manage/quotes usa le Legacy per next_number/list/view/print/
form/save/send/delete; la conversione avviene dalla UI via "Vai a Pagamenti" -> import POS
(pos?quote_id=X), NON via l'azione compat action=convert.

FEDELI e verificati LIVE (test-preventivi 18/18): numerazione N/YYYY = MAX(seq)+1 per anno
(anno da quote_date), formula totali (subtotal = imponibili GIA' scontati, IVA sull'imponibile
scontato, round per riga prima di sommare), PREZZO CATALOGO BLOCCATO per righe service/
product/package (unit_price dal catalogo, non dal POST), validazioni con messaggi verbatim
(sede obbligatoria, numero >32, duplicato, riga senza item_id, "Aggiungi almeno una riga"),
lista con filtri + badge stato effettivo, view/print (biz + snapshot sede + terms fallback),
edit-lock su accepted ("Preventivo in stato ... non modificabile"), send-guard valid_until
scaduto ("Aggiorna la data di validita"), delete solo-bozza (messaggi verbatim), stati
effettivi (paid via vendita collegata, expired per sent scaduto).

CONVERSIONE (import POS getManagePosQuoteCart + checkoutManageSale sourceQuoteId) — 5
divergenze trovate e corrette (test-preventivi 25/25):
1. PRECONDIZIONE: il Next permetteva l'import di qualsiasi preventivo (unica guardia
   status==='converted'). Il legacy (pos.php ~2122) consente SOLO gli 'accepted'. Fix:
   gate su status effettivo 'accepted' ("Solo i preventivi in stato Accettato possono essere
   riportati in Pagamenti"). Un accepted resta convertibile anche oltre valid_until.
2. IDEMPOTENZA (bug reale): dopo la conversione quoteAutoExpireAndSyncPaid porta lo stato da
   'converted' a 'paid' al load lista; la vecchia guardia status==='converted' non scattava
   piu' -> RE-IMPORT e DOPPIA CONVERSIONE possibili. Fix: blocco su vendita ATTIVA collegata
   (sales.source_quote_id, fallback marker nota), come il legacy ("Questo preventivo e' gia'
   stato trasformato in vendita").
3. PACCHETTI non esplosi: quoteLines (mapper compat) collassa item_type package->service, quindi
   convertire un preventivo con riga pacchetto NON emetteva il client_package. Fix:
   getManagePosQuoteCart legge quote_items grezzi con item_type REALE (package resta package ->
   emesso in cassa via issuePackageFromSale; custom->service).
4. PREZZO import: usava unit_price grezzo + discount_total (perdeva l'IVA). Fix: prezzo effettivo
   = line_total/qty (IVA+sconto inclusi, come pos_quote_import_effective_unit_price), sconto
   carrello 0 -> il totale vendita coincide col totale preventivo.
5. STATO post-conversione: markQuoteConvertedFromSale scriveva status='converted' (non nel
   dizionario stati legacy -> label grezza). Fix: status='paid' come quote_sale_mark_quote_paid.

VERIFICATO live: test-preventivi 25/25 (18 fedeli + F0-F6 conversione: pacchetto emesso sedute 2,
sede collegata, stato paid, re-import bloccato, draft bloccato). Regression: e2e-quotes 80/80,
test-pos-checkout 8/8, test-pkg-pos 8/8, typecheck 0. Residui ZZ=0 (quotes/quote_items/services/
products/packages/client_packages/sale_items); 5 clienti reali intatti.

RESIDUI DELIBERATI (documentati, non UI-cablati / fuori scope):
- Endpoint compat non usati dalla UI: action=convert (convertDbQuoteToSale), create (createDbQuote,
  numerazione Q-00042), update (updateDbQuote). Divergenti ma irraggiungibili dalla UI (che usa
  save/POS import). Da rimuovere o rendere fedeli in un intervento dedicato.
- Accettazione/rifiuto PUBBLICO del cliente: la pagina pubblica Next (/api/public/quote) e'
  read-only (view + PDF + stampa); l'email preventivo punta al sito pubblico legacy
  (PRENODO_PUBLIC_BASE_URL/.../quote_public) per la decisione cliente. Il writer Next di
  customer_decision_at/status non e' cablato. Da portare se/quando il pubblico passa a Next.

## Preventivi: chiusura residui — accept/reject pubblico verificato + endpoint compat rimossi (2026-07-08)

Seguito della voce precedente: chiusi i due "residui" indicati.

1. ACCETTAZIONE/RIFIUTO PUBBLICO — NON era un buco (correzione). L'accept/reject del cliente è
   GIÀ implementato e fedele, nell'AREA ACCOUNT cliente (non nella view token-based /api/public/
   quote, dove la ricerca iniziale si era fermata). Componenti:
   - decidePublicCustomerQuote (lib/public-customer-appointments.ts) — port 1:1 di booking.php
     mode=quote_decision: ownership per client_id linkato o email; guardie + messaggi verbatim
     (Preventivo non trovato / Non autorizzato / Preventivo scaduto [+ forza expired] / Hai gia
     risposto a questo preventivo / Questo preventivo non e modificabile); UPDATE status +
     customer_decision_at + customer_decision_source='booking' + customer_decision_seen_at=NULL
     WHERE status='sent' AND customer_decision_at IS NULL.
   - listPublicCustomerQuotes (mode=my_quotes) con gate canRespond.
   - Route: app/api/account POST action=quotes / action=quote_decision.
   - UI: components/public/hub-sections.tsx (pulsanti Accetta/Rifiuta su canRespond) +
     per-tenant-hub.tsx (decideQuote -> action=quote_decision).
   Unica deviazione documentata (già annotata nel codice): il check disponibilità catalogo
   all'accettazione non è portato (la conversione in vendita lato manage rivalida gli articoli).
   VERIFICATO live (test-quote-decision 10/10, sessione cliente forgiata): my_quotes con
   canRespond; accept->accepted+decision_at+source booking; reject->rejected; ri-risposta
   'Hai gia risposto'; scaduto 'Preventivo scaduto'+expired; non-owned 'Non autorizzato';
   validazioni input; no-sessione 'Accesso cliente richiesto'. 9 account preesistenti + 5
   clienti reali intatti, 0 residui.

2. ENDPOINT COMPAT DIVERGENTI — RIMOSSI. Le azioni POST /api/manage/quotes action=convert
   (convertDbQuoteToSale), create (createDbQuote, numerazione Q-00042), update (updateDbQuote)
   erano shim divergenti non presenti nel legacy e non usati da UI/test/codice. Rimosse dalla
   route (+ helper quoteSaveInputFromBody e import inutilizzati): ora ritornano "Azione
   preventivi non supportata.", allineando la superficie API al legacy (save/send/delete/seen +
   GET list/view/print/form/next_number). La conversione resta SOLO via import POS
   (pos?quote_id=X), l'unico path fedele. Le funzioni compat restano come export morti
   (irraggiungibili); pulizia del codice morto rimandata. Aggiornato il commento di
   markQuoteConvertedFromSale (unico path, stato 'paid').

VERIFICATO: test-preventivi 25/25, e2e-quotes 80/80, test-quote-decision 10/10, typecheck 0.
Nessuna regressione. Modifiche: app/api/manage/quotes/route.ts (rimozione branch+helper),
lib/manage-pos.ts (commento). NESSUN residuo aperto sui Preventivi.

## GiftBox: audit completo + fix riscatto-completo (stock+per-item) e snapshot; rimossi compat issue/redeem (2026-07-08)

Audit 1:1 del modulo GiftBox vs giftbox.php (143KB) + GiftBox.php (193KB) + GiftBoxAvailability
+ giftbox_voucher/settings + emissione POS (Gifts.php NON contiene logica giftbox: è l'engine
Omaggi). Tre livelli di codice Next: FEDELE (gift-issue-details, cablato UI), COMPAT (issue/redeem/
GET-default), MORTO (updateManageGiftBoxInstance, listManageGiftboxRows). Emissione reale = solo
POS (issueGiftboxFromSale), come il legacy dove l'azione 'issue' è forzata a 'list'.

FEDELI e verificati LIVE (test-giftbox 27/27): template CRUD (validazioni verbatim: "Nome GiftBox
obbligatorio", "seleziona almeno un livello Punti", "Aggiungi almeno un contenuto"; save items;
soft-delete deleted_at+active=0), view dettaglio (stati Attiva/Riscattata/Scaduta/Annullata),
riscatto PARZIALE per-item (scrive giftbox_redemption_items + scala products.stock + status
redeemed a esaurimento), modifica istanza (evento/destinatario/nota/dedica) + update_instance_expiry
(guardie: scaduta<oggi, annullata, riscattata) + internal_note, annullamento (guardie già
annullata / già riscattata), send_email (guardia email), auto-expire al load (issued+scaduta ->
expired).

CORRETTO:
1. RISCATTO COMPLETO (redeem_full / redeem_instance): redeemManageGiftBoxInstanceFull flippava
   status='redeemed' ma NON scriveva giftbox_redemption_items né scalava lo stock prodotti ->
   incoerenza col reader fedele (getGiftBoxInstanceFull calcola il residuo per-item dai
   redemption_items: mostrava "Riscattata" con ogni item ancora pieno + stock non decrementato).
   Ora la route delega al motore FEDELE redeemGiftBoxInstancePartial su tutti i rimanenti
   disponibili (per-item + stock + note "Riscatto totale GiftBox"), come il legacy redeemInstance
   -> redeemInstanceItems. Guardie stato preservate (annullata/scaduta/già riscattata).
2. SNAPSHOT nome servizio all'emissione POS: issueGiftboxFromSale non popolava
   giftbox_instance_items.service_snapshot_json (port di ensureInstanceItemsSnapshot ->
   service_master_snapshot_json). Ora congela {name} così voucher/dettaglio restano corretti se il
   servizio viene poi rinominato/eliminato (stessa classe di fix dei Pacchetti).
3. RIMOSSI gli endpoint compat divergenti issue (issueDbGiftBox: stub demo che emetteva su un
   template arbitrario - PERICOLOSO) e redeem (redeemDbGiftBox: no per-item, no stock). Non usati
   da UI/test (la UI emette da POS e riscatta via redeem_instance_partial). Ora "Azione GiftBox
   non supportata". Funzioni compat lasciate come export morti.

VERIFICATO: test-giftbox 27/27 (incl. emissione POS con snapshot + redeem_full corretto),
typecheck 0. Modifiche isolate al path giftbox: app/api/manage/giftboxes/route.ts (redeem_full
delega + rimozione issue/redeem) + lib/manage-pos.ts (service_snapshot_json in issueGiftboxFromSale).
Residui ZZ=0; produzione intatta (template id16 + istanza id15); 5 clienti reali intatti.
REGRESSION cross-modulo VERDE (dopo drain del pooler): test-pkg-pos 8/8, test-pos-checkout 8/8,
test-preventivi 25/25, test-giftbox 27/27, e2e-giftbox 64/64.
I 2 fail iniziali di e2e-giftbox (movimento riscatto locationLabel="-" + stock prodotto per-sede
non scalato) NON erano un bug dell'app (verificato col codice pre-fix: stesso esito) ma un difetto
di SETUP del test: il login reale lascia needsLocationSelection=true / currentLocationId=0 e il
test non selezionava la sede, mentre il riscatto per-sede (movimento + scalo product_stocks) la
richiede. Verificato empiricamente che l'app è corretta con una sede attiva: Sede21 -> scala
product_stocks(21) e movimento Sede1; Sede51 -> blocca "Prodotto non abbinato alla sede
selezionata"; nessuna sede -> salta la scalatura per-sede. Fix applicato al TEST (selezione sede
Sede1 dopo il login via POST /api/manage/locations), come il flusso reale operatore -> e2e-giftbox 64/64.

## GiftCard: audit completo + fix ledger storno (refund->topup) e blocco issue (2026-07-08)

Audit 1:1 del modulo GiftCard vs giftcard.php (91KB) + GiftCard.php (104KB) + giftcard_voucher/
settings + emissione POS + riscatto appuntamento. Modello IBRIDO: saldo monetario (balance/
initial_amount) + item (giftcard_items con redeemed_qty sulla riga); status 'redeemed' solo con
balance<=0 E item residui<=0. La route usa le funzioni FEDELI (gift-issue-details) per view/
manage_list/update/update_expiry/update_internal_note/update_note/redeem/redeem_item/send_email;
'issue' era compat; topup/cancel già bloccati ("Operazione non disponibile", come il legacy).
Emissione reale = solo POS (issueGiftcardFromSale). Funzioni compat/morte: redeemDbGiftCard (solo
appuntamenti), getManageGiftCard, updateManageGiftCard, listManageGiftcardRows.

FEDELI e verificati LIVE (test-giftcard 22/22): emissione POS (code GC-XXXX-XXXX-XXXX, balance,
token 64hex), view/lista, riscatto a CREDITO (scala balance, tx 'redeem' -amount, redeemed a 0,
"Saldo insufficiente"/"Importo non valido"), riscatto per-ITEM (redeemed_qty + scala product_stocks
per-sede + status a esaurimento, "Quantità eccede il residuo"), modifica (evento/destinatario/
nota/dedica) + update_expiry (guardia "GiftCard riscattata") + internal_note, lock destinatario su
card parzialmente riscattata (balance!=initial), send_email guard, topup/cancel rifiutati.

CORRETTO:
1. LEDGER STORNO (bug reale): restoreGiftcardBalance (annullo appuntamento) e refundDbGiftCard
   (storno vendita) inserivano giftcard_transactions.type='refund', ma il CHECK Postgres ammette
   solo issue/redeem/topup/cancel/adjust -> l'insert falliva SILENZIOSAMENTE (il saldo veniva
   ripristinato ma la riga di ledger andava persa = audit-trail incompleto). Il legacy usa
   topupGiftCard (type='topup') per gli storni/rimborsi. Fix: type 'refund' -> 'topup' in entrambe.
   Verificato (test-giftcard J2): annullo vendita pagata con giftcard -> saldo ripristinato +
   transazione 'topup' 30 con nota "Storno vendita #N" (prima persa).
2. EMISSIONE da gestione: 'issue' chiamava lo stub issueDbGiftCard (creava una giftcard su input
   arbitrario). Il legacy rifiuta _mode=issue con "La creazione delle GiftCard avviene da Pagamenti
   (pulsante GiftCard)." Fix: la route 'issue' ora ritorna quel messaggio verbatim (emissione solo POS).

3. EMAIL CRON UNIFICATA (chiuso 2026-07-09): il cron app/api/cron/giftcard-send reimplementava il
   body email (buildGiftcardEmail) OMETTENDO l'immagine hero evento (con un commento errato: "non
   servita da Next" — invece public/assets/img/giftcard-events/*.png ESISTONO) e usando subject
   diversi. Ora il cron DELEGA a sendGiftCardEmailManage (lo stesso identico builder fedele usato
   dal page-load sendDueScheduledGiftCards e dal POS): l'email programmata è fedele per costruzione
   (immagine hero + subject + condizioni identici). Rimossi il builder duplicato + gli helper +
   loadBusinessSettings + import inutilizzati; SELECT ridotto ai soli campi necessari (WHERE
   invariato). Verificato: typecheck 0, eslint pulito, GET /api/cron/giftcard-send risponde
   {ok, job:"giftcard-send", sendEnabled:false, due:0} senza errori (il ramo d'invio SES non è
   live-testabile in dev, ma usa ora il builder fedele già verificato dal path page-load/manage).

VERIFICATO: test-giftcard 22/22, e2e-giftcard 94/94 (dopo aver aggiunto al vecchio test la selezione
sede post-login, come per e2e-giftbox: era l'unica falla, un problema di setup del test - la lista a
filtro sede STRETTO richiede una sede attiva), test-pos-checkout 8/8, test-pkg-pos 8/8, typecheck 0.
Residui ZZ=0; tenant 25 giftcards baseline=0 preservato; 5 clienti reali intatti.

## Fidelity: audit completo + fix invariante punti normalizeFidelityPoints (2026-07-09)

Audit 1:1 del modulo Fidelity vs Fidelity.php (~104KB) + le pagine fidelity.php / fidelity_points.php
/ fidelity_levels.php / fidelity_membership.php / fidelity_wallet.php / credit_movements.php. Modello:
transactions (ledger punti, kind earn/redeem/manual/adjust/expire, delta_points, idempotenza
client+kind+source), point_lots (FIFO+scadenza con lock@YYYYMMDDHHMMSS), clients.points (saldo),
clients.credit_balance (portafoglio €), clients.fidelity_level, cards (adesione active|inactive),
credit_adjustments (ledger credito €), fidelity_campaigns, card_code_registry (anti-riuso permanente),
settings fidelity_* su businesses. La route app/api/manage/fidelity è interamente cablata alle
funzioni FEDELI (getFidelity*/save*/issueFidelityCard/fidelityWalletManualMove/manualCreditDebit/
*Campaign*); i rami compat legacy (_mode=manual_move / save_rule / delete_rule) rispondono con i
messaggi legacy di reindirizzamento ("Il movimento manuale e stato spostato in Portafoglio", ecc.).

CORRETTO:
1. INVARIANTE PUNTI (unica divergenza confermata): db-repositories.normalizeFidelityPoints usava
   Math.round(v), mentre l'invariante legacy Fidelity::normalizePoints (Fidelity.php:28-33) è
   floor(+1e-9) sui positivi / ceil(-1e-9) sui negativi, MAI round (un round arrotonderebbe per
   eccesso i frazionari, accreditando punti in più). Fix: allineata a v>=0 ? floor(v+1e-9) :
   ceil(v-1e-9), coerente con fidelity-lots.normPoints e manage-pos.normalizePoints. Impatto pratico
   ~nullo (i punti sono sempre interi: fidelity_points_used/earned, clients.points, aggregati) —
   floor/ceil di un intero = l'intero — ma è la corretta incarnazione dell'invariante 1:1 e difende
   da qualsiasi input frazionario futuro. I molti Math.round residui operano tutti su valori STORED
   già interi (nessuna divergenza pratica) e non sono stati toccati per non introdurre churn.

NON bug (valutati e scartati): (a) gli statuti prenotazione "reserved" non esistono nel Next (solo
pending/scheduled/canceled) quindi nessun ramo mancante; (b) i vari Math.round su interi memorizzati
sono equivalenti a floor/ceil.

FEDELI e verificati LIVE (test-fidelity 42/42, con cliente ZZ usa-e-getta + ripristino settings da
baseline): letture state/points_settings(+stats)/campaigns/levels/membership/client_search/wallet/
credit; save_points_settings (validazione "scadenza > 0" + save/restore euro_per_point); save_levels
(guardia duplicati "Non puoi salvare due livelli card con gli stessi punti necessari" senza persist);
campagne CRUD (create inattiva, tiers senza scaglioni, fine<inizio, overlap "Esiste gia una campagna
punti attiva nello stesso periodo" su toggle E su save attiva, hard-delete a 0 riferimenti);
tessere CRUD (create + adesione, doppione "Questo cliente ha già una tessera", codice riusato
"gia utilizzato in passato", reactivate "La tessera non è scaduta", delete che azzera punti/livello/
tx/lots ma MANTIENE il codice nel registry); wallet manual move (add +50 tx manual, remove -20 tx
adjust, rimozione PARZIALE fedele con segnalazione mancanti, "saldo insufficiente (disponibili 0)",
"Inserisci un numero intero di punti valido", "Cliente non aderisce alla Fidelity"); credit_debit
(scalo -30 con credit_adjustments direction=debit, "Inserisci una nota", "Credito insufficiente",
"Inserisci un importo valido"); POS earn campagna-aware (checkout 80€ -> floor(80/10)=8 punti,
tx kind=earn source=sale, campagna 37 stampata).

VERIFICATO: test-fidelity 42/42, typecheck 0; regressione VERDE test-pos-checkout 8/8, test-giftcard
22/22, test-giftbox 27/27 (il fix floor/ceil non tocca gli interi). PRODUZIONE INTATTA: dopo il
cleanup i conteggi tornano esatti alla baseline (transactions=82, point_lots=36, credit_adjustments=49,
fidelity_campaigns=1 [campagna 37 attiva/amount/aperta preservata], cards=0, card_code_registry=11,
clients=5) e le settings fidelity_* ripristinate al valore originale (euro_per_point 0.10, levels 0,
enabled 1, points 1). Nessun dato di produzione modificato in via definitiva.

## Ricariche: audit completo + fix double-earn punti in vendita (2026-07-09)

Audit 1:1 del modulo Ricariche vs recharges.php (535 righe) + CreditRechargeCancel.php (940 righe,
motore storno) + il path di emissione/annullo in pos.php. Struttura come GiftCard/GiftBox: la pagina
Ricariche gestisce SOLO i "Modelli di ricarica" (recharge_templates); l'emissione reale avviene in
Pagamenti (POS), lo storno tramite annullo della vendita.

FEDELI e verificati LIVE (test-recharges 32/32):
- TEMPLATE CRUD (manage-recharges.ts, route app/api/manage/recharges): create/update/delete con
  messaggi verbatim ("Modello creato/aggiornato/eliminato.", "Modello non valido/non trovato.",
  "Inserisci un titolo per il modello.", "Inserisci un importo ricarica valido.", massimali
  "... troppo alto. Massimo 99.999.999,99." per importo/bonus/totale), bonus percent/fixed/none
  (none forza bonus 0), sort_order clamp ±1000000, earn_points gated dalla Fidelity generale, prefill
  action=get. create_recharge BLOCCATO ("Le ricariche credito si registrano dalla pagina Pagamenti.").
- POS ISSUANCE (issueRechargeFromSale): base/bonus/total, punti campagna-aware, nota legacy
  "Ricarica credito: € X • bonus € Y • +N Punti • nota", credito wallet +total + punti taggati sale.
- GUARDIE PAGAMENTO ricarica (verbatim): niente credito/GiftCard/coupon-buoni-promo/sconto-manuale/
  punti per pagare una ricarica; GiftBox+ricarica incompatibili; solo pagamento unica soluzione.
- STORNO (annullo vendita -> reverseIssuedSaleRecharges + assertRechargeCreditFeasible + modi punti
  skip/negative/normal): is_void/voided_at/voided_by, credito ridato indietro, punti stornati
  (redeem/recharge), guardia fattibilità "R#N: credito insufficiente per lo storno (saldo attuale
  € X)." quando il credito è già stato speso. Idempotente (re-void salta).
- LEDGER: source_type "recharge" + kind redeem sullo storno + source_id NULL — convenzione del
  Next ALLINEATA ai dati di produzione/migrati (NON i grezzi legacy 'credit_recharge'/'
  credit_recharge_void'/'adjust'); nessuna collisione con l'indice unico transactions_uq_fid_src
  (Postgres tratta i NULL come distinti — verificato: cliente 9 ha 13 earn/recharge + 27 earn/sale,
  tutti source_id NULL, coesistenti).

CORRETTO:
1. DOUBLE-EARN PUNTI IN VENDITA (bug reale): la base punti a livello vendita (earnBase in
   checkoutManageSale) usava il TOTALE vendita, che INCLUDE le righe speciali (ricarica/GiftCard/
   GiftBox). Nel legacy la base punti (Fidelity::calcEarnPointsForCartWithCampaign su
   $subtotal_eligible + $loyaltyClean, pos.php 3745/3960/4718) contiene SOLO servizi/prodotti/
   pacchetti: la ricarica NON entra ("rechargesDraft"), GiftCard "non entra nel calcolo" (pos.php
   4728), GiftBox esclusa. Conseguenza nel Next: una vendita RICARICA maturava DUE volte
   (livello vendita + issueRechargeFromSale) e le vendite GiftCard/GiftBox maturavano punti che nel
   legacy non maturano. Fix: earnBase = somma delle sole righe che maturano (servizi/prodotti/
   pacchetti/prepagati; recharge/giftcard/giftbox escluse via NON_EARNING_SALE_LINE_TYPES) al netto
   di sconto + residui. Verificato: ricarica €100+20% -> 12 punti (prima 22 = 12+10); flag OFF ->
   10 (su base 100); GiftCard/GiftBox -> 0 punti vendita; servizi/prodotti/pacchetti INVARIATI
   (test-pos-checkout 8/8, test-pkg-pos 8/8, test-giftcard 22/22, test-giftbox 27/27, test-fidelity
   42/42 incl. H1 servizio €80 -> 8 punti). Nota: eventuali punti sovra-maturati in PRODUZIONE da
   vendite ricarica/GiftCard/GiftBox passate NON vengono corretti retroattivamente (fuori scope,
   dati di produzione preservati); le nuove vendite sono ora corrette.
2. earn_points PERSISTITO sulla riga ricarica (micro-1:1): il Next salvava earn_points=flag del
   modello; il legacy salva earnOnTotal = flag AND idoneità cliente (pos.php:5594). Allineato
   (colonna mai riletta a valle -> zero impatto funzionale, puro 1:1 del dato persistito).

VERIFICATO: test-recharges 32/32, typecheck 0; regressione VERDE test-pos-checkout 8/8, test-pkg-pos
8/8, test-giftcard 22/22, test-giftbox 27/27, test-fidelity 42/42. Produzione tenant 25 intatta
(baseline: recharge_templates=0, recharges=1, transactions=82, credit_adjustments=49, point_lots=36,
cards=0, clients=5 — tutti ripristinati dopo il cleanup).

## Portafoglio (Punti): audit completo — modulo FEDELE, nessun bug (2026-07-09)

Audit 1:1 del "Portafoglio" vs il hub wallet.php (2 tile: Portafoglio Punti + Movimenti Credito) +
la pagina sostanziale fidelity_wallet.php (1288 righe) + Fidelity::reservedPoints/availablePointsRaw/
clientPoints/expiringSoonPoints. Il lato Credito (credit_movements) è già coperto nell'audit Fidelity;
qui il focus è il Portafoglio PUNTI. Route: app/api/manage/fidelity action=wallet (GET) + wallet_move
(POST). Funzioni: getFidelityWallet / getFidelityWalletDetail / fidelityReservedPoints /
fidelityWalletManualMove (db-repositories) + expireClientLots / pointLotsSchedule / expiringSoonPoints
(fidelity-lots). UI: components/modules/fidelity_wallet-content.tsx.

FEDELI e verificati LIVE (test-portafoglio 14/14):
- VISTA ELENCO: clienti = titolari tessera (JOIN cards, anche disattiva), label "Punti".
- SALDO/RISERVATO/DISPONIBILE: saldo = clients.points (normalizzato int); riservato = SUM(
  fidelity_points_used + fidelity_gift_points_used) sulle prenotazioni APERTE; disponibile RAW =
  saldo - riservato, NON clampato (può essere negativo, come availablePointsRaw). Verificato:
  scheduled(used30+gift10)+pending(used15+gift5) -> riservato 60; done/canceled con punti NON
  riservano; disponibile negativo quando riservato > saldo.
- MOVIMENTI: transactions paginati 20/pagina ORDER id DESC, con Sede e tipo 'kind • source #id'.
- PUNTI IN SOSPESO: prenotazioni pending/scheduled con punti, LIMIT 200, totali sconto/omaggio,
  lock refs inline (primi 3 + "+N") e title (tutti) "Prenotazione #<code>".
- CALENDARIO SCADENZE: lotti per giorno (23:59:59), lock-lots, prossima scadenza.
- OPERAZIONE MANUALE (wallet_move): add (kind 'manual') / remove (kind 'adjust'), source_type
  'manual'; interi (floor), min 1 "Inserisci un numero intero di punti valido.", cap 1e8, adesione
  "Cliente non aderisce alla Fidelity (tessera non attiva/scaduta)."; rimozione protegge i punti
  riservati (rimuove solo il free = saldo - riservato; lockedReserved = min(riservato, remainder),
  missing = remainder - lockedReserved) con messaggi verbatim ("Rimossi N Punti", "N Punti non
  rimossi perché prenotati su appuntamenti in sospeso/prenotati.", "... per saldo insufficiente.",
  "Impossibile rimuovere N Punti: i punti disponibili sono già prenotati ...", "... saldo
  insufficiente (disponibili X).") + warnLocked. Guardie Fidelity off / Punti off verbatim.

ANALISI DIVERGENZE (nessun fix funzionale necessario):
1. SET STATI "riservati": il legacy Fidelity::reservedPoints usa un set AMPIO
   (pending/scheduled/in sospeso/in attesa/attesa/prenotato/prenotata/confirmed/confermato/
   confermata/approved/booked, case/spazio-insensibile) per gestire i dati MySQL un-normalizzati.
   Il Next usa ('pending','scheduled'): è PROVATAMENTE COMPLETO perché il CHECK
   appointments_status_check ammette SOLO {pending,scheduled,done,canceled,no_show} e solo
   pending+scheduled trattengono punti non regolati (done=regolato, canceled/no_show=rilasciato).
   Le varianti IT/EN del legacy NON possono esistere nel DB Next. Aggiunto solo un COMMENTO che
   documenta il ragionamento (evita "widening" errati futuri); nessun cambio logico. Verificato:
   done/canceled con punti NON riservano.
2. expiringSoonPoints: il legacy cappa la KPI "in scadenza" a availablePoints() (clampato); il Next
   somma i lotti in finestra senza cap. Divergenza solo se riservato>0 (feature redenzione-in-
   prenotazione attualmente inerte, 0 appuntamenti con punti in tutti i tenant) e comunque solo di
   display KPI. Documentata, non modificata (expiringSoonPoints è un helper condiviso; il cap
   introdurrebbe accoppiamento con availablePoints per un caso non raggiungibile).

VERIFICATO: test-portafoglio 14/14, typecheck 0; regressione test-fidelity 42/42 (path wallet_move
F1-F5). Produzione tenant 25 intatta (baseline transactions=82/point_lots=36/appointments=9/cards=0/
clients=5, ripristinato dopo cleanup). Nessun dato di produzione modificato.

## Accesso-per-sede: adottato il MODELLO A "sedi = reparti di un'unica azienda" (2026-07-09)

Rivalutazione con l'utente della strategia accesso-per-sede. DECISIONE (Modello A, scelto dall'utente):
regola unica **"le operazioni di una sede restano nella sede; il cliente e ciò che possiede lo
seguono ovunque"**. È anche il comportamento del PHP originale. Motivazione: l'isolamento aggiunto
oltre il legacy su clienti + 8 moduli "client-owned" (giftcard/giftbox/coupon/ecc.) creava
incoerenza (bloccare la giftcard di un cliente ma non il cliente stesso) e rompeva flussi cross-sede
legittimi (prenotare un cliente di un'altra sede, riscattare punti/giftcard cross-sede — la fidelity
è già tenant-wide). Permesso di ruolo scartato: sarebbe per-RUOLO (tutti gli "staff" uguali), mentre
serve il controllo per-OPERATORE.

**1) WIRING assegnazione sedi (il vero abilitatore).** `loginLocationState` (lib/manage-auth.ts)
leggeva `user_locations` (popolata solo dal provisioning admin) mentre l'editor Operatori scrive
`staff_locations` → l'isolamento operatori era di fatto SPENTO (ogni operatore vedeva tutte le sedi).
Ora il login risolve utente→staff per email→`staff_locations` (fonte legacy, port di
app_user_location_options), con fallback compat su `user_locations` e ultimo fallback = tutte le sedi
attive (scelta PRUDENTE anti-lockout: l'operatore senza assegnazione lavora ovunque finché l'admin
non gli assegna ≥1 sede; il PHP invece lo bloccherebbe). Admin = tutte. Verificato sui dati reali:
info@vivamed.it (staff, staff_locations={21}) → locationIds=[21] (ristretto a Sede1); admin → [].

**2) TENANT-WIDE (guardie rimosse, = PHP).** Il "mondo cliente" torna condiviso: rimosso il lucchetto
cliente `assertClientAccessibleForSedi` (clients GET/POST + fidelity wallet/credit/credit_debit/
wallet_move/card_create/movimento) e le 8 guardie-record enhancement (commissions mark-paid/toggle,
giftcards, giftbox_instances, gift_instances, coupons, promotions, resources: cabine/staff/risorse).
Ogni operatore può aprire/prenotare qualsiasi cliente e i suoi strumenti (giftcard/giftbox/punti),
come app_client_accessible del legacy (che ignora la sede).

**3) PER-SEDE (guardie FAITHFUL tenute, il PHP le impone).** Restano isolate le OPERAZIONI di una
sede: appuntamenti/calendario (appointmentLocationAllowedForUser), POS/vendite (assertSaleLocationAccess),
preventivi, rate (scopeLocationId), pacchetti cliente (client_packages), preordini (sale_items→sales),
magazzino/documenti (stock_docs), costi. Nessun file di questi moduli è stato toccato.

VERIFICATO LIVE: test-model-a 12/12 — op(Sede1) ORA accede a cliente/giftcard/coupon/cabina/wallet di
Sede2 (guardie rimosse), resta NEGATO su appuntamento/pacchetto di Sede2 (guardie tenute), admin vede
tutto, operatore assegnato a 2 sedi opera su entrambe. test-sede-guards (guardie faithful) invariato
15/16 (l'unico FAIL è stale: azione quotes `convert` rimossa nell'audit Preventivi, non attinente).
Regressione moduli con route toccate VERDE: test-giftcard 22/22, test-giftbox 27/27, test-fidelity
42/42, test-portafoglio 14/14. typecheck 0, eslint 0-errori. 5 clienti reali intatti; nessun dato di
produzione modificato. NB: superate (non più valide) le voci "8 ENHANCEMENT" e "restrizione cliente"
delle sezioni 2026-07-08 qui sopra — deliberatamente rimosse per il Modello A.

## Fix editor Operatori: hydration slug + "Operatore non trovato" su sede non-default (2026-07-09)

Due bug emersi testando il Modello A (creazione/assegnazione operatore a una sede):
1. HYDRATION MISMATCH: la pagina renderizzava `<StaffFormContent />` senza `slug` (unico *Content
   della page senza il prop), quindi il componente cadeva sul fallback window-only `tenantSlug()` =
   "" in SSR e "centroesteticoelite" sul client -> link assoluti rotti "//staff" e albero non
   idratato. FIX: `<StaffFormContent slug={tenantSlug} />` (app/[tenantSlug]/[...segments]/page.tsx),
   come tutti gli altri componenti.
2. "Operatore non trovato." al salvataggio di un operatore assegnato a una sede diversa dalla prima
   sede attiva: `saveStaffMember` termina con `mustFindStaff`, che ri-leggeva via `resourceContext({slug})`
   (senza locationId -> `listStaff` filtrato sulla PRIMA sede attiva, Sede1). Un operatore creato solo
   su Sede2 non compariva -> il salvataggio riusciva ma la conferma lanciava l'errore. FIX: `mustFindStaff`
   usa `getManageStaffMember(slug,id)` (lookup per-id SENZA filtro sede, gia' usato dal prefill edit).
Verificato: test-staff-sede2 4/4 (crea operatore solo-Sede2 -> ok + staff_locations=[51]; update a 2
sedi -> ok), typecheck 0, eslint 0-errori, 5 clienti reali intatti.

## Editor Operatori: hydration action + lista Operatori "tutte le sedi" (2026-07-09)

Ancora sul flusso Modello A (gestione operatori multi-sede), due fix:
1. HYDRATION su `?action=edit`: il titolo (`<h1>{title}`) era "Nuovo operatore" in SSR e "Modifica
   operatore" sul client, perché `action` veniva risolto solo da `window.location` (`resolveAction()`
   -> "new" in SSR). Stessa classe del bug slug. FIX: `StaffFormContent` accetta le prop `action` e
   `staffId` dal server (`app/[tenantSlug]/[...segments]/page.tsx` le passa da `query.action`/`query.id`);
   il componente le usa per lo stato iniziale + lo useEffect (fallback window per robustezza).
2. "Operatore creato ma non visibile": la lista Operatori (`staff-content.tsx` -> GET
   `resources?section=staff`) NON inviava `location_id`, quindi la route defaultava a
   `normalizeActiveLocation(0)` = PRIMA sede attiva (Sede1); `listStaff` filtrava su Sede1 -> un
   operatore assegnato solo a Sede2 non compariva MAI (né rispettava la sede corrente). Il legacy
   (staff.php:1091) mostra TUTTI gli operatori (la query non filtra per sede; il filtro sede-corrente
   è solo un default con toggle "Tutte le sedi"). FIX: nuovo `listManageStaffAll(slug)` (activeLocationId=0
   = nessun filtro) usato dalla route quando `section=staff` -> la pagina di gestione mostra tutti gli
   operatori di ogni sede (coerente col Modello A: lo staff non è isolato per sede). resourceContext
   invariato per gli altri consumatori (calendario, ecc.).
Verificato: test-staff-list 4/4 (lista include l'operatore solo-Sede2, = tutti gli operatori del
tenant), test-staff-sede2 4/4, typecheck 0, eslint 0-errori, 5 clienti reali intatti.

## Correzione lista Operatori: filtro SEDE CORRENTE + toggle "Tutte le sedi" (2026-07-09)

Correzione del fix precedente (che mostrava SEMPRE tutti gli operatori): il legacy staff.php filtra
la lista per la SEDE CORRENTE per default (`$staffFilterLocationId = $staffCurrentLocationId`), con
una checkbox "Tutte le sedi" (all_locations) per azzerare il filtro. Ora fedele:
- route resources GET section=staff: filtra `listManageStaff(slug, session.currentLocationId)`; con
  `?all_locations=1` passa 0 = tutte le sedi. Uno staff senza sedi assegnate compare ovunque.
  (Il bug originale: la lista defaultava alla PRIMA sede attiva ignorando la sede corrente.)
- `listManageStaffAll` -> `listManageStaff(slug, locationId=0)` (generalizzata).
- UI staff-content: checkbox "Tutte le sedi" nel form filtri (querystring all_locations, come il
  legacy) + il fetch/i link propagano il flag.
Verificato: test-staff-filter 4/4 (Sede1 selezionata -> solo op Sede1; Sede2 -> solo op Sede2; Tutte
le sedi -> entrambi), typecheck 0, eslint 0-errori, 5 clienti reali intatti.
