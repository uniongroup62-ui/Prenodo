import "server-only";

// Basi URL delle superfici pubbliche e dell'app (Fase 2 separazione domini,
// 2026-07-23 — vedi docs/domini-routing.md).
//
// Prima esisteva UNA sola variabile (PRENODO_PUBLIC_BASE_URL) usata per
// generare i link di quattro superfici diverse, e in vari punti la base veniva
// addirittura dedotta dall'`origin` della richiesta. Quest'ultima cosa è un
// difetto già oggi: `booking_url` e l'URL pubblico del profilo vengono SALVATI
// NEL DATABASE con l'indirizzo da cui il gestore ha premuto "salva", e poi
// serviti ai clienti finali dal marketplace.
//
// Da qui in avanti:
//  - publicBaseUrl()  → dominio PUBBLICO   (marketplace, booking, voucher,
//                       area clienti, pagine legali)
//  - appBaseUrl()     → dominio dell'APP   (login gestionale: reset password
//                       staff, verifica signup, accesso di supporto)
//
// Retrocompatibilità: finché `PRENODO_APP_BASE_URL` non è impostata, l'app
// ricade sulla base pubblica, cioè il comportamento odierno a dominio unico.
// Nessuna configurazione esistente si rompe attivando questo modulo.
//
// SICUREZZA: l'origin della richiesta è solo l'ULTIMO fallback (sviluppo). Gli
// header Origin/Host sono controllabili dal client: farne derivare i link dei
// reset password significherebbe consegnare token validi verso un dominio
// altrui (token theft) — vedi audit 21/07.

function clean(value: string | undefined | null): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Base del dominio PUBBLICO (marketplace, booking, voucher, area clienti).
 * `requestOrigin` va passato solo dove esiste una richiesta: è il fallback di
 * sviluppo, mai la fonte preferita.
 */
export function publicBaseUrl(requestOrigin?: string | null): string {
  return (
    clean(process.env.PRENODO_PUBLIC_BASE_URL)
    || clean(process.env.NEXT_PUBLIC_APP_URL)
    || clean(requestOrigin)
    || "http://localhost:3000"
  );
}

/**
 * Base del dominio dell'APP/gestionale (app.<dominio> quando sarà separato).
 * Ricade sulla base pubblica finché `PRENODO_APP_BASE_URL` non è impostata.
 */
export function appBaseUrl(requestOrigin?: string | null): string {
  return clean(process.env.PRENODO_APP_BASE_URL) || publicBaseUrl(requestOrigin);
}

/** Compone un URL assoluto sul dominio pubblico. `path` deve iniziare con "/". */
export function publicUrl(path: string, requestOrigin?: string | null): string {
  return `${publicBaseUrl(requestOrigin)}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Compone un URL assoluto sul dominio dell'app. `path` deve iniziare con "/". */
export function appUrl(path: string, requestOrigin?: string | null): string {
  return `${appBaseUrl(requestOrigin)}${path.startsWith("/") ? path : `/${path}`}`;
}
