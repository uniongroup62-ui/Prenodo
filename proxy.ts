import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 Proxy (formerly Middleware). Tre compiti:
// 1. Shim URL legacy del gestionale: /<slug>/index.php?page=X[&tab=Y] ->
//    route pulite /<slug>/X[/Y] (vecchi link e bookmark restano vivi).
// 2. Blindatura pannello SaaS Admin (Fase 1, 2026-07-18) su /admin e
//    /api/admin: host-gate opzionale (ADMIN_HOST -> il pannello risponde SOLO
//    su quell'host, altrove 404), IP allowlist opzionale (ADMIN_IP_ALLOWLIST,
//    lista separata da virgole) e header di sicurezza (no-store, DENY frame,
//    noindex).
// 3. Separazione domini Fase 3 (2026-07-23, vedi docs/domini-routing.md):
//    gestionale su app.<dominio>, superfici pubbliche sul dominio principale.
//    Va fatto QUI e non nel CDN perché sotto /<slug>/… pubblico e gestionale
//    si distinguono solo dalla QUERY STRING, che il CDN non vede.

// Parametri che rendono PUBBLICA la pagina /<slug>/booking: lista tenuta
// allineata a app/[tenantSlug]/booking/page.tsx (isPublicRequest). Se cambia
// là, va aggiornata qui, altrimenti una pagina pubblica verrebbe spedita
// sull'host del gestionale.
const BOOKING_PUBLIC_PARAMS = [
  "public", "start", "hub", "confirmed", "mode", "service_ids", "location_id", "service_id",
  "book_package", "book_prepaid", "book_giftbox", "book_omaggio",
  "my", "quotes", "packs", "prepaids", "credit", "giftcards", "giftboxes", "fidelity",
  "gifts", "preorders", "profile", "settings", "products", "showcase", "auth",
];

// Prefissi di primo livello che appartengono sempre al dominio PUBBLICO.
const PUBLIC_PREFIXES = ["/attivita", "/account", "/legal", "/login"];

type Surface = "public" | "app" | "neutral";

// A quale dominio appartiene questa richiesta. "neutral" = non spostare
// (admin, api, asset, cron: hanno regole proprie o devono funzionare ovunque).
function domainSurface(pathname: string, params: URLSearchParams): Surface {
  if (pathname === "/") return "public";
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return "public";
  if (pathname === "/manage" || pathname.startsWith("/manage/")) return "app";

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const page = segments[1];
    // Superfici pubbliche a TOKEN sotto il path del tenant: voucher, firma
    // privacy/consensi, preventivo pubblico. I link sono già stati inviati per
    // email: devono restare validi sul dominio pubblico.
    const tokenPages = ["giftcard_voucher", "giftbox_voucher", "gift_voucher", "gdpr_public", "consent_public", "quote_public"];
    if (tokenPages.includes(page)) return params.get("token") ? "public" : "app";
    if (page === "booking") {
      return BOOKING_PUBLIC_PARAMS.some((p) => (params.get(p) ?? "") !== "") ? "public" : "app";
    }
  }
  // Resto di /<slug>/… (dashboard, POS, clienti, impostazioni) + l'entry /<slug>.
  if (segments.length >= 1) return "app";
  return "neutral";
}

export function proxy(request: NextRequest) {
  const url = request.nextUrl;

  // ---- 2. Gate del pannello admin -----------------------------------------
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin/")) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";

    const adminHost = String(process.env.ADMIN_HOST ?? "").trim().toLowerCase();
    if (adminHost && host.toLowerCase() !== adminHost) {
      return new NextResponse("Not found", { status: 404 });
    }

    const allowlist = String(process.env.ADMIN_IP_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (allowlist.length > 0) {
      const fwd = request.headers.get("x-forwarded-for") ?? "";
      // IP = valore più a DESTRA di X-Forwarded-For: è quello APPESO dall'edge
      // fidato (CloudFront/ALB). Il primo (leftmost) è controllato dal client:
      // bastava inviare "X-Forwarded-For: <ip-in-allowlist>" per superare il gate.
      const parts = fwd.split(",").map((entry) => entry.trim()).filter(Boolean);
      const ip = parts[parts.length - 1] || request.headers.get("x-real-ip") || "";
      if (!ip || !allowlist.includes(ip)) {
        return new NextResponse("Not found", { status: 404 });
      }
    }

    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  // ---- 3. Separazione domini (gestionale su app.<dominio>) -----------------
  // INERTE finché non sono configurati ENTRAMBI gli host: senza env il sito
  // resta a dominio unico e questo blocco non fa nulla.
  const appHost = String(process.env.PRENODO_APP_HOST ?? "").trim().toLowerCase();
  const publicHost = String(process.env.PRENODO_PUBLIC_HOST ?? "").trim().toLowerCase();
  // appHost === publicHost sarebbe una misconfigurazione: reindirizzerebbe
  // all'infinito. In quel caso non si fa nulla.
  if (appHost && publicHost && appHost !== publicHost) {
    const rawHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").toLowerCase();
    // Host senza porta (in locale/preview arriva "host:3000").
    const host = rawHost.split(":")[0];
    // Solo richieste di PAGINA: mai API (una redirect romperebbe le POST) né
    // asset. E solo su host noti: da un host non previsto (IP, anteprima di
    // deploy) non si tocca nulla.
    const isPage = !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/_next/");
    if (isPage && (host === appHost || host === publicHost)) {
      const surface = domainSurface(url.pathname, url.searchParams);
      const target = surface === "public" ? publicHost : surface === "app" ? appHost : "";
      if (target && target !== host) {
        const dest = url.clone();
        dest.host = target;
        dest.port = "";
        dest.protocol = "https:";
        // 308 verso il dominio pubblico: è la URL canonica, va consolidata per
        // i motori. 307 verso il gestionale: nessuna SEO in gioco e resta
        // reversibile senza cache permanenti nei browser.
        return NextResponse.redirect(dest, surface === "public" ? 308 : 307);
      }
      // Il gestionale non va indicizzato nemmeno per errore.
      if (host === appHost) {
        const response = NextResponse.next();
        response.headers.set("X-Robots-Tag", "noindex, nofollow");
        return response;
      }
    }
  }

  // ---- 1. Shim legacy index.php -------------------------------------------
  const match = url.pathname.match(/^\/([^/]+)\/index\.php$/);
  if (!match) return NextResponse.next();

  const slug = match[1];
  const page = url.searchParams.get("page");

  const dest = url.clone();
  // page becomes the path segment; tab/action/public/token/embed stay as query.
  dest.pathname = page ? `/${slug}/${page}` : `/${slug}/dashboard`;
  dest.searchParams.delete("page");
  return NextResponse.redirect(dest);
}

export const config = {
  matcher: [
    "/:slug/index.php",
    "/admin/:path*",
    "/admin",
    "/api/admin/:path*",
    // Separazione domini (Fase 3): serve vedere TUTTE le pagine per poterle
    // instradare sull'host giusto. Esclusi API, file statici, ottimizzazione
    // immagini e i file di metadati: un redirect su quelli bloccherebbe CSS,
    // JS e immagini (vedi doc "Negative matching" del Proxy).
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|assets|uploads).*)",
  ],
};
