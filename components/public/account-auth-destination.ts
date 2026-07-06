// Port di account_after_auth_url + account_booking_params (public_account.php
// 54-120): dopo login/verifica, se la richiesta arriva da un tenant
// (?tenant=&next=) si atterra sul flusso del tenant — next=start apre il
// wizard di prenotazione; i target dell'hub per-sede tornano all'hub
// (/<slug>/booking?<key>=1, reso da PerTenantHub); showcase torna al profilo
// marketplace. Senza tenant vale il `return` (default /attivita).
// NB fedeltà: l'allow-list PHP account_next_key (public_account.php:57)
// contiene start/hub/my/quotes/packs/prepaids/credit/preorders/fidelity/gifts/
// profile/settings/showcase — NON giftcards/giftboxes, che quindi collassano su
// 'start' (wizard) post-login. profile/settings nel PHP tornano alla pagina
// per-sede (?profile=1/?settings=1); il port li manda all'account CENTRALE
// /account/profile (deviazione deliberata: l'area profilo cliente è centrale).
const HUB_KEYS = new Set([
  "hub", "my", "credit", "packs", "prepaids", "preorders", "quotes", "fidelity", "gifts",
]);

export function accountAuthDestination(tenant: string, next: string, returnTarget: string, locationId = ""): string {
  const slug = tenant.trim();
  if (slug) {
    let key = next.trim().toLowerCase();
    if (key === "products") key = "showcase"; // account_next_key legacy
    if (key === "showcase") return `/attivita/${encodeURIComponent(slug)}`;
    if (key === "profile" || key === "settings") return "/account/profile";
    if (HUB_KEYS.has(key)) return `/${encodeURIComponent(slug)}/booking?${key}=1`;
    // default legacy: 'start' (anche per chiavi sconosciute)
    const params = new URLSearchParams({ start: "1" });
    const loc = locationId.trim();
    if (loc && Number.parseInt(loc, 10) > 0) params.set("location_id", loc);
    return `/${encodeURIComponent(slug)}/booking?${params.toString()}`;
  }
  const target = returnTarget.trim();
  if (target.startsWith("/")) return target;
  return "/attivita";
}
