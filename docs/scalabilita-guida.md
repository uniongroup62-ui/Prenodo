# Guida scalabilità — passaggi da fare a mano (2026-07-20)

Tre interventi che richiedono azioni sul pannello Supabase / sulle variabili
d'ambiente, quindi vanno fatti da te. In ordine di urgenza.

---

## 1. PITR (Point-in-Time Recovery) su Supabase — 5 minuti, da fare SUBITO

Il backup per-tenant del pannello copre il ripristino chirurgico di un singolo
tenant. Per la catastrofe totale (database corrotto, cancellazione massiva)
serve il PITR di Supabase: ti permette di riportare l'INTERO database a un
qualsiasi istante degli ultimi N giorni.

Passi:
1. Dashboard Supabase → il tuo progetto → **Database** → **Backups**.
2. Tab **Point in Time** → **Enable PITR**.
3. Scegli la finestra di retention (7 giorni bastano per iniziare; è un
   add-on a pagamento — il prezzo dipende dal piano).
4. Fine: da quel momento ogni transazione è recuperabile.

Nota: se PITR non è disponibile sul tuo piano, verifica che almeno i **Daily
Backups** siano attivi (lo sono di default sui piani a pagamento).

---

## 2. Connection pooling in TRANSACTION MODE — prima del lancio

Oggi l'app si collega in **session mode** (porta 5432 del pooler, limite ~15
client): due processi di sviluppo sono bastati a saturarlo. In produzione,
con le funzioni di Amplify che aprono connessioni in parallelo, è il primo
collo di bottiglia.

Passi:
1. Dashboard Supabase → **Settings** → **Database** → sezione **Connection
   string** → scegli **Transaction mode** (porta **6543**).
2. Copia la stringa e sostituisci `PRENODO_DATABASE_URL`:
   - in locale: `prenodo/.env.local`
   - su Amplify: Console → App → **Environment variables**.
3. Riavvia (in locale: riavvia `npm run dev`; su Amplify: redeploy).

Cosa sapere (già verificato nel codice):
- Il codice NON usa prepared statements a livello di protocollo né stato di
  sessione critico, quindi il transaction mode è compatibile.
- Unica eccezione nota: delete/restore tenant usano
  `SET session_replication_role='replica'` (disabilita i vincoli FK durante
  lo sweep). In transaction mode quel SET può non "restare attaccato" alle
  query successive: le operazioni funzionano comunque (gli errori FK vengono
  raccolti come warning riga per riga), solo in modo meno silenzioso. Se dopo
  il passaggio noti warning FK nelle delete, dimmelo: incapsulo lo sweep in
  una transazione unica e il SET torna efficace.

---

## 3. Row-Level Security (RLS) — in agenda pre-lancio, insieme

La difesa in profondità definitiva: politiche a livello di DATABASE che
filtrano per tenant anche se una query dell'app dimenticasse il WHERE. Da
fare insieme (serve una modifica coordinata app+database), indicativamente:

1. L'app imposta a inizio richiesta `SET LOCAL app.tenant_id = <id>` dentro
   una transazione.
2. Sulle tabelle tenant si abilita RLS con una policy tipo:
   `USING (tenant_id = current_setting('app.tenant_id')::int)`.
3. Le operazioni di piattaforma (pannello admin, cron) usano un ruolo che
   BYPASSA la policy.

Non farlo a mano dal pannello Supabase: attivare RLS su una tabella senza le
policy giuste blocca TUTTE le query dell'app. Quando decidi di farlo, lo
prepariamo con uno script e una batteria di verifica come sempre.

---

## Nel frattempo, già attivo nel repo

- `npm run check:tenant-scope` — la guardia anti-leak: scandisce lib/ e app/
  cercando query su tabelle tenant senza filtro tenant_id. Le eccezioni
  legittime sono annotate nel codice con `// cross-tenant: <motivo>`.
  Falla girare (o mettila in CI) prima di ogni deploy.
- Audit indici: fatto — chiavi primarie composite (tenant_id, id) e indici
  compositi sui percorsi caldi sono già nello schema. Niente da aggiungere.
