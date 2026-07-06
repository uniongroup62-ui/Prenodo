// Port di account_after_auth_url + account_booking_params (public_account.php
// 54-120): dopo login/verifica, se la richiesta arriva da un tenant
// (?tenant=&next=) si atterra sul flusso del tenant — next=start apre il
// wizard di prenotazione; i target dell'area cliente per-tenant del legacy
// sono mappati sulle pagine account CENTRALI del port; showcase torna al
// profilo marketplace. Senza tenant vale il `return` (default /attivita).
const NEXT_ROUTES: Record<string, string> = {
  hub: "/account",
  my: "/account/appointments",
  quotes: "/account/quotes",
  packs: "/account/packages",
  prepaids: "/account/packages",
  credit: "/account/packages",
  giftcards: "/account/packages",
  giftboxes: "/account/packages",
  preorders: "/account/packages",
  fidelity: "/account/packages",
  gifts: "/account/packages",
  profile: "/account/profile",
  settings: "/account/profile",
};

export function accountAuthDestination(tenant: string, next: string, returnTarget: string, locationId = ""): string {
  const slug = tenant.trim();
  if (slug) {
    let key = next.trim().toLowerCase();
    if (key === "products") key = "showcase"; // account_next_key legacy
    if (key === "showcase") return `/attivita/${encodeURIComponent(slug)}`;
    const mapped = NEXT_ROUTES[key];
    if (mapped) return mapped;
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
