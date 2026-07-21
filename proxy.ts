import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 Proxy (formerly Middleware). Due compiti:
// 1. Shim URL legacy del gestionale: /<slug>/index.php?page=X[&tab=Y] ->
//    route pulite /<slug>/X[/Y] (vecchi link e bookmark restano vivi).
// 2. Blindatura pannello SaaS Admin (Fase 1, 2026-07-18) su /admin e
//    /api/admin: host-gate opzionale (ADMIN_HOST -> il pannello risponde SOLO
//    su quell'host, altrove 404), IP allowlist opzionale (ADMIN_IP_ALLOWLIST,
//    lista separata da virgole) e header di sicurezza (no-store, DENY frame,
//    noindex).
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
  matcher: ["/:slug/index.php", "/admin/:path*", "/admin", "/api/admin/:path*"],
};
