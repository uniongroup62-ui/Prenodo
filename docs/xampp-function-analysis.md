# Analisi app XAMPP BeautySuite

Origine analizzata: `C:\xampp\htdocs`, servita da Apache/PHP su `http://localhost/`.

## Router principale

File: `index.php`.

- `/` e `/attivita[/...]`: marketplace pubblico centrale.
- `/saloni[/...]`: alias legacy con redirect a `/attivita`.
- `/account/...`: account cliente globale del marketplace.
- `/manage/...`: login, registrazione, verifica email e recupero password del gestionale.
- `/admin/...`: pannello SaaS.
- `/{slug}/...`: contesto tenant. Esempio: `/centroesteticoelite/`.
- `/{slug}/index.php?page=booking&public=1`: booking pubblico del tenant.
- `/{slug}/index.php?page=dashboard`: gestionale tenant, protetto da login.

Nel comportamento reale XAMPP, `/centroesteticoelite/` non e la scheda pubblica: se l'utente non e autenticato reindirizza a `/manage/login?slug=centroesteticoelite`.

## Marketplace

File principali:

- `app/pages/public_marketplace.php`
- `app/lib/Marketplace.php`
- `assets/js/pages/public_marketplace.js`

Funzioni chiave:

- creazione/repair tabelle marketplace (`ensureTables`);
- profili tenant pubblici (`publicProfiles`, `publicProfileBySlug`);
- sedi pubblicate (`publicLocations`, `publicLocationBySlug`);
- categorie attivita e categorie servizi;
- ricerca per query, citta, categoria e servizio;
- preferiti account cliente;
- condivisione scheda;
- prodotti/servizi in evidenza;
- branding live da tenant;
- link booking con handoff account cliente.

Replica Next:

- `/` marketplace landing;
- `/attivita` lista/ricerca;
- `/attivita/centroesteticoelite` scheda pubblica;
- CTA booking verso `/{slug}/booking`.

## Gestionale

File principali:

- `app/pages/manage_account.php`
- `app/lib/SaasProfessionalSignup.php`
- `app/lib/TenantProvisioner.php`
- `app/lib/Auth.php`

Funzioni chiave:

- login centrale tramite slug attivita + email + password;
- registrazione professionista;
- verifica email con codice;
- disponibilita slug (`/manage/check-url`);
- provisioning tenant;
- sessione tenant separata;
- permessi/ruoli;
- redirect a landing page in base ai permessi.

Replica Next:

- `/manage/login?slug=centroesteticoelite`;
- `/manage/register`;
- `/manage/verify`;
- `/manage/forgot-password`;
- `/manage/reset-password`;
- `/manage/check-url` come endpoint JSON;
- `/{slug}/dashboard` come gestionale demo.

## Booking pubblico

File principali:

- `app/pages/booking.php`
- `app/lib/BookingAuth.php`
- `app/lib/BookingPublicUi.php`
- `assets/js/pages/booking-wizard.js`
- `assets/js/pages/booking-gate.js`

Funzioni chiave:

- gate login/registrazione cliente;
- selezione sede;
- selezione categoria;
- selezione uno o piu servizi;
- scelta professionista o assegnazione automatica;
- calcolo slot disponibili;
- hold temporaneo dello slot;
- coupon, promozioni, GiftCard, credito e Fidelity;
- riepilogo costi;
- conferma prenotazione;
- area cliente con appuntamenti.

Replica Next:

- `/{slug}/booking`;
- compatibilita URL stile PHP: `/{slug}/index.php?page=booking&public=1`;
- wizard a step con sede, categoria, servizi, professionista, ora, vantaggi e conferma.

## Aggiornamento sviluppo Next - 2026-06-28

Accesso verificato sul PHP originale da `/manage/login?slug=centroesteticoelite`: il POST autentica e reindirizza a `/centroesteticoelite/index.php?page=dashboard`.

Analisi tecnica delle logiche applicative: `docs/xampp-logic-analysis.md`.

La dashboard autenticata espone queste aree operative principali:

- Panoramica: `dashboard`, `calendar`, `notifications`.
- Appuntamenti: `appointments`, `appointments_plan`, `booking`.
- Pagamenti: `pos`, `pos_history`, `pos_prepaids`, `pos_preorders`, `installments_manage`, `pos_settings`.
- Amministrazione: `costs`, `commissions`, `quotes`, `quote_settings`, `reports`.
- Magazzino: `products`, `product_categories`, `stock_moves`, `suppliers`, `coupons`.
- Clienti: `clients`, `client_sheets`, `client_consents`, `packages`.
- Fidelizzazione: `fidelity`, `recharges`, `wallet`, `promotions`, `gifts`, `giftbox`, `giftcard`.
- Risorse: `resources`, `services`, `service_categories`, `service_recommendations`, `cabins`, `staff`, `staff_availability`, `hours`.
- Impostazioni: `business_profile`, `locations`, `consent_modules`, `accessibility`, `roles`, `automation`, `marketplace`.

Replica Next aggiornata:

- `components/management-app.tsx` ora usa la sidebar completa a gruppi, con ricerca funzione, dashboard operativa e viste demo per tutti i moduli rilevati.
- `lib/role-permissions.ts` porta in TypeScript il catalogo `RolePermissions`, ereditarieta, normalizzazione e landing page da permessi.
- `lib/tenant-runtime.ts` porta slug/prefix/session suffix tenant e location gate demo.
- `lib/appointment-engine.ts` porta disponibilita slot, conflitti operatore, hold temporanei e save appuntamento demo.
- `lib/tenant-store.ts` centralizza lo store demo tenant-aware per appuntamenti, clienti, servizi, prodotti e movimenti stock.
- `lib/tenant-store.ts` include anche vendite POS, item, pagamenti, annullamenti e summary report.
- `/api/manage/permissions`, `/api/manage/appointments`, `/api/manage/clients`, `/api/manage/services`, `/api/manage/products`, `/api/manage/pos`, `/api/manage/reports` espongono le prime funzioni clonate come API Next.
- `/api/manage/costs`, `/api/manage/quotes`, `/api/manage/fidelity`, `/api/manage/giftcards`, `/api/manage/notifications`, `/api/manage/automation` espongono il nuovo blocco amministrazione, fidelity e comunicazioni.
- `/api/manage/packages`, `/api/manage/prepaids`, `/api/manage/preorders`, `/api/manage/coupons`, `/api/manage/promotions`, `/api/manage/giftboxes`, `/api/manage/gifts`, `/api/manage/installments`, `/api/manage/commissions` espongono residui, marketing, rate e provvigioni.
- `/api/manage/configuration?module=...` espone impostazioni, risorse, categorie, staff, orari, consensi, marketplace e ruoli con record configurabili.
- Le viste Clienti, Servizi e Magazzino sono collegate alle API demo per create/archive/disattivazione e stock rapido.
- Le viste Pagamenti, Movimenti e Report sono collegate alle API demo per checkout, storico, annullamento e KPI.
- Le viste Scadenziario e Costi, Preventivi, Fidelity, Wallet, Ricariche, GiftCard, Notifiche e Automazione sono collegate alle API demo con azioni operative.
- La replica ora copre pagamento costi ricorrenti, accettazione/conversione preventivi in vendita POS, movimenti credito/punti, emissione GiftCard, lettura notifiche e run manuale automazioni.
- Le viste Pacchetti, Prepagati, Preordini, Buoni, Promozioni, GiftBox, Omaggi, Gestione Rate e Commissioni sono collegate alle API demo con azioni operative.
- Il POS demo accetta righe speciali `prepaid`, `giftcard`, `package`, `giftbox`, coupon, promozioni e rate; genera residui, piani rateali e commissioni staff.
- Le viste Impostazioni preventivi/POS, categorie, stock, fornitori, schede, consensi, template schede, categorie costi, impostazioni pacchetti, adesione/livelli fidelity, impostazioni GiftBox/GiftCard, risorse, servizi consigliati, cabine, staff, disponibilita, orari, profilo, sedi, accessibilita, ruoli e marketplace sono collegate alla route configurazione.
- `lib/xampp-config.ts`, `lib/tenant-db.ts`, `lib/manage-auth.ts` e `lib/db-repositories.ts` introducono il collegamento server-side al DB XAMPP reale.
- `/api/manage/auth/login` verifica la password nel DB reale con bcrypt PHP, crea cookie sessione tenant e protegge `/{slug}/dashboard` e `/{slug}/index.php?page=...`.
- `/api/manage/auth/forgot-password` e `/api/manage/auth/reset-password` replicano il reset admin PHP su `password_resets`; `/manage/reset-password?slug=...&token=...` valida il token e salva la nuova password.
- `/api/manage/accessibility` replica `accessibility.php`: cambio password interno, verifica email corrente, richiesta cambio email con password attuale, reinvio codice, conferma codice e invalidazione reset pendenti.
- `/api/manage/signup/register`, `/api/manage/signup/resend` e `/api/manage/signup/verify` replicano `SaasProfessionalSignup`: registrazione professionista, codice verifica 6 cifre con TTL/cooldown/tentativi/lock, provisioning tenant shared, seed admin/sede/orari/permessi/POS/automazioni/onboarding e sessione owner.
- Le API operative `/api/manage/*` risolvono il tenant da `slug`, `x-tenant-slug` o `Referer`, quindi un nuovo gestionale non legge piu implicitamente `centroesteticoelite`.
- `/api/manage/onboarding`, `/{slug}/onboarding` e `/{slug}/index.php?page=onboarding` replicano il gate iniziale PHP: step business, sede, categorie attivita, orari, operatori, cabine, categorie servizi, servizi e booking.
- `/manage/check-url` controlla slug reali su DB (`saas_tenants`), signup pendenti e tabelle tenant.
- Clienti, Servizi, Magazzino, Appuntamenti, POS, Report, Costi, Preventivi e Permessi sono DB-first: leggono MySQL quando disponibile e mantengono fallback demo durante il porting.
- Sedi e appuntamenti gestionali sono DB-first: la sede corrente viene salvata in sessione, availability/hold/release/renew usano `business_hours`, staff e `appointment_holds`, e il salvataggio crea snapshot/segmenti marcando l'hold convertito; la stessa sede DB viene propagata a clienti, servizi, prodotti, stock, POS e costi.
- GiftCard, Wallet/Fidelity, Pacchetti, Prepagati, Preordini, Coupon, Promozioni, GiftBox, Omaggi, Rate, Commissioni, Automazioni e Notifiche sono DB-first: leggono e aggiornano le tabelle XAMPP quando presenti, con fallback demo solo per compatibilita.
- La route `configuration` e DB-first per impostazioni preventivi/POS, categorie, stock, fornitori, schede, consensi, risorse, categorie servizi, consigliati, cabine, staff, disponibilita, orari, profilo, sedi, accessibilita, ruoli e marketplace.
- Il booking pubblico e DB-first: `/api/booking` legge business, sedi, categorie, servizi, staff, coupon/promozioni, calcola slot da `business_hours`/eccezioni, crea hold su `appointment_holds` e conferma appuntamenti su `appointments`, snapshot servizi, staff, sedi e segmenti.
- `components/public-booking-wizard.tsx` consuma la nuova API pubblica: selezione sede/categoria/servizi/staff, slot reali ogni 5 minuti, hold temporaneo al click e conferma reale con cliente.
- `components/public-center-page.tsx` usa lo stesso contesto DB per scheda attivita, sedi, servizi, staff e richiesta rapida; mantiene solo asset visivi demo quando nel DB non ci sono immagini pubbliche.
- Il marketplace pubblico e DB-first: `/api/marketplace` legge `saas_tenants`, `businesses`, `locations`, `services`, `service_categories` e categorie marketplace; `/attivita` e `/` consumano profili tenant reali con fallback demo.
- POS checkout/cancel e annullamento vendita scrivono su `sales`, `sale_items`, scorte prodotto, residui prepagati/pacchetti/giftcard e piani rateali; l'annullo ripristina stock e marca residui/rate come annullati.
- Smoke test booking pubblico su `centroesteticoelite`: contesto DB, slot DB per servizio 9/sede 21/staff 22, hold DB + release, conferma DB + cleanup righe test.
- Smoke test appuntamento gestionale su `centroesteticoelite`: login DB, sede 21, availability/hold/save DB, `appointments.location_id=21`, pivot sede, segmento, hold `converted` e cleanup righe test.
- Smoke test reset password gestionale: richiesta token DB, validazione token, reset a una password di test e login DB riuscito.
- Smoke test accessibilita: cambio password interno a una password di test con sessione DB e login successivo riuscito.
- Smoke test verifica email: codice DB per email corrente, conferma codice, pending rimosso e sessione verificata.
- Smoke test signup professionista: registrazione DB con codice locale, verifica codice, creazione tenant/admin/sede/orari/permessi/onboarding, redirect dashboard e cleanup tenant temporaneo.
- Smoke test onboarding nuovo tenant: verifica signup reindirizza a `index.php?page=onboarding`, stato `not_started/business`, dashboard 307 verso onboarding e cleanup tenant temporaneo.
- Smoke test GET su `giftcards`, `fidelity`, `packages`, `prepaids`, `installments`, `coupons`, `promotions`, `commissions`, `automation`, `notifications`, `giftboxes`, `gifts`, `preorders`, `pos` e `reports`: `sourceMode=database`.
- Smoke test GET configurazione su 27 moduli: `sourceMode=database`.
- `/{slug}/dashboard` apre la mappa gestionale con `Dashboard` come sezione iniziale.
- `/{slug}/index.php?page=...` apre la sezione gestionale corrispondente quando non si tratta del booking pubblico.
- `/{slug}/index.php?page=booking&public=1` resta collegato al wizard pubblico.
- `/manage/login?slug=centroesteticoelite` e allineato allo screen di accesso fornito.
- `/admin/login` e `/admin` sono ora route Next: replicano bootstrap/login SaaS, dashboard, tenant manager, dettaglio tenant, health, support access, backup, controlli, piani SMS, movimenti invii, maintenance, audit e admin SaaS dal pannello PHP `admin/`.
- `/api/admin/auth/status`, `/api/admin/auth/login`, `/api/admin/auth/logout`, `/api/admin/tenants` e `/api/admin/admins` portano in API Next le logiche `SaasAuth`, `SaasTenantManager`, `SaasTenantAudit`, `SaasSupportAccessManager` e `SaasAdminManager`.
- `lib/saas-operations.ts` replica `SaasBackupManager`, `SaasSmsBilling`, `SaasCommunicationMonitor` e diagnostica SMS di `SaasTenantManager`: schema backup, payload tenant/upload, piani/prezzi SMS, ordini, accredito wallet tenant e movimenti invii SMS/email.
- `/api/admin/operations` espone `controls`, `sms_plans`, `send_movements`, `backups`, download backup e azioni POST per impostazioni prezzo, piani, attivazione/riordino, ricarica manuale e creazione backup.
- `/{slug}?support_token=...` consuma token supporto monouso e apre il gestionale tenant con sessione Next, senza usare PHP.
- Smoke test SaaS Admin: `/admin/login` 200, API tenant protetta 401 senza cookie, login `info@artebrand.it`/password fornita riuscito, `/admin` 200 autenticato e dettaglio tenant `elite` letto da DB.
- Smoke test operazioni SaaS Admin: `controls`, `sms_plans`, `send_movements` e `backups` su `/api/admin/operations` rispondono 200 con cookie admin.

Prossime priorita consigliate:

- Rifinire sync marketplace/validazioni avanzate onboarding e completare restore backup/pagamenti provider reali per ricariche SMS.
- Rafforzare il booking/appuntamenti con transazioni SQL esplicite, risorse condivise, cabine avanzate, assenze staff e lifecycle rollback identico al PHP.
- Rafforzare checkout POS con transazione SQL esplicita per garantire rollback atomico su vendite complesse.
- Sostituire la route configurazione generica con CRUD dedicati dove servono allegati, audit, regole granulari e permessi per azione.
- Separare i moduli piu grandi in componenti dedicati quando si passa da mappa funzionale a CRUD reale.
- Espandere la UI dei moduli DB-first per esporre tutti i campi avanzati PHP, non solo le azioni operative principali.
