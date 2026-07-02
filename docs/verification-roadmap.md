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

## Verifiche live PHP↔Next da eseguire (step successivi)
1. **Dashboard**: KPI via API (`api_dashboard_performance.php` vs `/api/manage/...`)
   — confronto formule, non numeri (dati divergenti).
2. **Calendario/Drawer**: creare lo stesso appuntamento su entrambi → confrontare
   slot proposti, conflitti, prezzi, redeem.
3. **POS**: stessa vendita su entrambi → confrontare totali, sconti, punti, residui.
4. **Booking pubblico**: slot generati per lo stesso giorno/servizio su entrambi.
5. **Impostazioni** (business_profile, hours, roles, automation, accessibility,
   notifications): confronto campo-per-campo dei form. ← area non ancora auditata
   in profondità.
6. **Pagine pubbliche**: marketplace (/attivita vs /), scheda attività, account
   cliente, voucher pubblici.
7. **Admin SaaS** + cron (EventBridge in prod).

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
