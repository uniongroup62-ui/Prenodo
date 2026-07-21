"use client";

import { useEffect } from "react";

// Flash moderno (campagna 2026-07-21): sostituisce il giro legacy PHP del
// "?msg= nell'URL". L'esito di un'azione viaggia in sessionStorage attraverso
// la navigazione (Post/Redirect/Get conservato, URL SEMPRE puliti, F5 non
// ripropone il banner né ripete l'azione). La LETTURA di ?msg=/?err= resta
// nei moduli come fallback per i vecchi deep-link e per i flussi server.
const KEY = "prenodo:flash";

// `type` è la variante Buoni (success/warning/danger del flash legacy coupon).
export type FlashPayload = { msg?: string; err?: string; warn?: string; type?: string };

export function stashFlash(flash: FlashPayload): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash));
  } catch {
    // sessionStorage non disponibile: il banner semplicemente non sopravvive
    // alla navigazione (nessun errore per l'utente).
  }
}

export function takeFlash(): FlashPayload {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) sessionStorage.removeItem(KEY);
    return raw ? (JSON.parse(raw) as FlashPayload) : {};
  } catch {
    return {};
  }
}

// Naviga con flash: da usare al posto di `window.location.href = url?msg=...`.
export function flashNavigate(url: string, flash: FlashPayload): void {
  stashFlash(flash);
  // Se il bersaglio è la STESSA pagina e differisce solo per l'ancora #, il
  // browser non ricarica (scroll soltanto): il flash resterebbe in storage
  // fino al prossimo F5. In quel caso forziamo il reload dopo aver applicato
  // l'ancora.
  const target = new URL(url, window.location.href);
  const sameDocument =
    target.hash !== "" &&
    target.pathname === window.location.pathname &&
    target.search === window.location.search;
  window.location.href = url;
  if (sameDocument) window.location.reload();
}

// Consumo al mount (solo client, mai negli initializer: SSR mismatch).
export function useTakenFlash(apply: (flash: FlashPayload) => void): void {
  useEffect(() => {
    const flash = takeFlash();
    if (flash.msg || flash.err || flash.warn) apply(flash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
