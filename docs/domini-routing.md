# Separazione domini: vetrina, marketplace, gestionale

Deciso il 2026-07-23. Stato: **Fase 1 implementata nel codice**, Fasi 2 e 3 da fare.

## Assetto obiettivo

| URL | Contenuto | Progetto |
|---|---|---|
| `prenodo.it/` | sito vetrina (marketing, prezzi, funzioni) | `PrenodoFrontend` |
| `prenodo.it/attivita/…` | marketplace pubblico (SEO) | `Prenodo` (app) |
| `prenodo.it/{slug}/booking?public=1` | booking pubblico dei centri | `Prenodo` (app) |
| `prenodo.it/{slug}/…?token=…` | voucher GiftCard/GiftBox/Omaggio, firma privacy e consensi, preventivo pubblico | `Prenodo` (app) |
| `prenodo.it/account/…` | area clienti | `Prenodo` (app) |
| `prenodo.it/legal/…` | privacy, cookie, termini, note legali | `Prenodo` (app) |
| `app.prenodo.it/{slug}/…` | gestionale (Fase 3) | `Prenodo` (app) |
| `admin.prenodo.it` | pannello SaaS (già supportato da `ADMIN_HOST`) | `Prenodo` (app) |

Il marketplace resta in **sottocartella** e non su un sottodominio: è il motore SEO del
prodotto e su un sottodominio non accumulerebbe autorità per il dominio principale.

## Perché il gestionale NON si separa con regole del CDN

Sotto `/{slug}/…` convivono superfici **pubbliche** e **gestionali**, distinte solo
dalla query string e non dal percorso:

- pubbliche: `/{slug}/booking?public=1`, `giftcard_voucher`, `giftbox_voucher`,
  `gift_voucher`, `gdpr_public`, `consent_public`, `quote_public` (tutte con `token=`);
- gestionale: le stesse radici di path senza quei parametri (es. `/{slug}/booking`
  è la pagina *impostazioni* booking) più le ~60 pagine del catch-all.

Un CDN instrada per percorso e non vede la query: non può distinguerle. La separazione
del gestionale va quindi fatta **nel middleware dell'app** (`proxy.ts`), che la query la
vede e ha già il pattern host-gate usato per `/admin`. Vedi Fase 3.

## Regole di routing del CDN (Fase 1)

L'ordine conta. La vetrina ha un elenco **finito** di percorsi; l'app ha il catch-all
`/{slug}` dei tenant, quindi non è enumerabile: si elencano i path della vetrina e
**tutto il resto va all'app**.

1. `/_vetrina/*` → **vetrina** (asset), rimuovendo il prefisso `/_vetrina`
2. `/` (esatto) → **vetrina**
3. `/chi-siamo`, `/chi-siamo/*` → **vetrina**
4. `/features`, `/features/*` → **vetrina**
5. `/pricing` → **vetrina**
6. `/settori`, `/settori/*` → **vetrina**
7. `/*` (qualsiasi altro) → **app** (marketplace, `/{slug}/…`, `/account`, `/legal`,
   `/manage`, `/admin`, `/api`, `/_next`)

Se in futuro la vetrina aggiunge sezioni di primo livello (es. `/blog`, `/supporto`),
va aggiunta una regola: **senza di essa quel path finirebbe all'app** e verrebbe
interpretato come slug di un tenant.

### Variabile richiesta dalla vetrina

Impostare sul deploy della vetrina:

```
NEXT_PUBLIC_ASSET_PREFIX=/_vetrina
```

Senza questa variabile le due build Next si contendono `/_next/*` e gli asset di una
sovrascrivono quelli dell'altra. In sviluppo la variabile va lasciata assente.

Il valore è validato dal config della vetrina: sono ammessi solo un path assoluto
(`/_vetrina`) o un URL `http(s)` (CDN dedicato); un valore malformato viene **ignorato
con un avviso**, così non si finisce con asset irraggiungibili. Attenzione se lo si
prova in locale da Git Bash su Windows: `NEXT_PUBLIC_ASSET_PREFIX=/_vetrina` viene
riscritto in `C:/Program Files/Git/_vetrina` dalla conversione automatica dei path
(usare `MSYS_NO_PATHCONV=1`).

## Fase 1 — cosa è già stato fatto nel codice

- `app/page.tsx` dell'app non serve più il marketplace: fa un **redirect permanente
  (308) a `/attivita`**. I vecchi link alla root non perdono valore SEO e in sviluppo
  la root porta comunque al marketplace.
- `next.config.mjs` della vetrina supporta `NEXT_PUBLIC_ASSET_PREFIX`.
- Il progetto vetrina si chiama ora `prenodo-vetrina` (era `my-project`).

## Fase 2 — basi URL da sdoppiare (prerequisito della Fase 3)

Oggi **una sola** variabile (`PRENODO_PUBLIC_BASE_URL`) genera i link di quattro
superfici diverse. Va divisa in due:

- **pubblica** (dominio principale): marketplace/canonical, voucher, booking,
  area clienti, pagine legali;
- **app** (`app.prenodo.it`): reset password staff (`/manage/reset-password`),
  verifica email del signup professionista (`/manage/verify`), link di accesso di
  supporto generati dall'admin.

Inoltre alcuni link **nascono dall'`origin` della richiesta** invece che da una
configurazione, e questo è già un difetto oggi:

| Punto | Problema |
|---|---|
| `lib/manage-business-settings.ts` (`booking_url`, `publicUrl`) | vengono **salvati nel database** con l'origin di chi preme "salva" nel gestionale; il marketplace poi li pubblica ai clienti |
| `app/api/manage/client-gdpr/route.ts` | le email di richiesta firma privacy/consensi usano l'origin del gestionale |
| `lib/saas-tenant-manager.ts` | il link di accesso di supporto usa l'origin del pannello admin |
| `components/modules/booking-content.tsx` | il link "booking pubblico" che il gestore copia per i clienti usa `window.location.origin` |

## Fase 3 — `app.prenodo.it` per il gestionale

Stesso deploy che risponde su entrambi gli host, con redirect selettivi nel middleware:

- su `prenodo.it`: le pagine **gestionali** reindirizzano a `app.prenodo.it`;
- su `app.prenodo.it`: le pagine **pubbliche** reindirizzano a `prenodo.it`;
- `X-Robots-Tag: noindex` su tutto `app.prenodo.it`.

**Regola ferma:** le sei superfici a token e il booking pubblico restano **sempre** sul
dominio principale, perché i link già inviati per email (voucher, richieste di firma)
devono continuare a funzionare.
