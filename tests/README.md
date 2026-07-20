# Batterie di verifica

117+ suite end-to-end accumulate durante la migrazione PHP → Next.js: ogni
modulo ha la sua batteria (API + DB + DOM via Playwright) con fixture `ZZ *`
tracciate e cleanup per id a fine run.

## Prerequisiti

- Dev server attivo su `http://localhost:3000` (`npm run dev`) — UN SOLO
  processo: il pooler Supabase in session mode regge ~15 client.
- `prenodo/.env.local` con `PRENODO_DATABASE_URL` (le suite lo leggono con un
  path relativo alla cartella `tests/`).
- Playwright installato (`npx playwright install chromium` la prima volta).

## Regole

- **MAI contro un database di produzione.** Le suite scrivono dati veri
  (prefisso `ZZ`), li cancellano per id tracciato, e alcune toccano baseline
  reali che poi ripristinano esatte: su un DB di sviluppo è sicuro, altrove no.
- Esecuzione **sequenziale**, mai in parallelo (conflitti su fixture, log e
  pool di connessioni): usa `node tests/run-all.mjs` o lancia i singoli file.
- Una suite verde stampa `TOT: n/n PASS` (o `n PASS / 0 FAIL`) ed esce 0.
- Nuove suite: stesso schema (fixture ZZ, cleanup per id in `finally`,
  exit code) e path SEMPRE relativi a `import.meta.url`.

## Esecuzione

```bash
node tests/test-saas-admin-ux.mjs      # singola suite
node tests/run-all.mjs                 # tutte, sequenziali (lento: ore)
node tests/run-all.mjs saas-admin      # solo le suite il cui nome contiene il filtro
```

La CI (`.github/workflows/ci.yml`) NON esegue queste suite (richiedono server
e DB vivi): esegue `tsc --noEmit` e la guardia anti-leak
`npm run check:tenant-scope`. Le batterie si lanciano in locale prima di ogni
deploy.
