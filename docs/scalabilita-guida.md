# Guida scalabilità — passaggi da fare a mano (2026-07-20)

Tre interventi che richiedono azioni sul pannello Supabase / sulle variabili
d'ambiente, quindi vanno fatti da te. In ordine di urgenza.

---

## 1. Backup del database — scaletta rivista (piano Supabase Free, 20/07)

Il backup per-tenant del pannello copre il ripristino chirurgico di un singolo
tenant. Per la catastrofe totale (database corrotto, cancellazione massiva)
la scaletta giusta, visto che oggi sei sul piano Free, è:

1. **Ora (Free)**: nessun upgrade necessario. Il backup per-tenant su R2 è già
   attivo; se vuoi coprire anche le tabelle di piattaforma (saas_*) a costo
   zero, chiedimi il backup di piattaforma su R2 via cron (offerta in sospeso).
2. **Al lancio (clienti veri)**: passa a **Pro ($25/mese)** → Daily Backups
   7 giorni inclusi. Dashboard → Settings → Billing → Upgrade.
3. **Solo a volume (quando il fatturato lo giustifica)**: aggiungi **PITR**
   (da ~$100/mese): Database → Backups → Point in Time → Enable.

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

## 4. Certificato CA di Supabase — FATTO (20/07)

`db/supabase-ca.crt` è nel repo (la CA è pubblica, non un segreto): la
connessione al database ora verifica il certificato del server, in locale e
in deploy, senza variabili aggiuntive. Se in futuro Supabase ruota la CA,
basta riscaricarla dal pannello (Settings → Database → SSL Configuration) e
sostituire il file; in alternativa `PRENODO_DATABASE_CA` (contenuto PEM) ha
la precedenza sul file.

---

## Nel frattempo, già attivo nel repo

- `npm run check:tenant-scope` — la guardia anti-leak: scandisce lib/ e app/
  cercando query su tabelle tenant senza filtro tenant_id. Le eccezioni
  legittime sono annotate nel codice con `// cross-tenant: <motivo>`.
  Gira anche in CI (`.github/workflows/ci.yml`) insieme al type-check.
- Audit indici: fatto — chiavi primarie composite (tenant_id, id) e indici
  compositi sui percorsi caldi sono già nello schema. Niente da aggiungere.
- **Migrazioni numerate** (`db/migrations/` + `npm run db:migrate`): lo schema
  è congelato alla baseline 0001 (20/07). Da qui in avanti ogni modifica di
  schema è un file numerato applicato dal runner (registro in
  `schema_migrations`, una transazione per file); i file applicati non si
  modificano mai. Niente più DDL a mano o "ensure" runtime per le novità.
- **Batterie di verifica versionate** (`prenodo/tests/`, 117+ suite): vedi
  `tests/README.md`. Prima di ogni deploy: batterie dei moduli toccati in
  locale; la CI copre type-check e guardia anti-leak a ogni push.
