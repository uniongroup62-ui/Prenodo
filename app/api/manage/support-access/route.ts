import { NextResponse } from "next/server";
import { manageSessionCookiePayload } from "@/lib/manage-auth";
import { consumeSupportAccessToken } from "@/lib/saas-tenant-manager";

export const dynamic = "force-dynamic";

// Consumo del support token (Fase 4 SaaS Admin, 2026-07-19). Vive in un Route
// Handler e NON nella pagina /[tenantSlug]: cookies().set è vietato durante il
// render dei Server Component (500 runtime) — la pagina inoltra qui.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, url.origin), 307);
  if (!slug || !token) return redirectTo("/manage/login");

  try {
    const result = await consumeSupportAccessToken({
      slug,
      token,
      ip,
      userAgent: request.headers.get("user-agent") ?? "",
    });
    if (result.ok) {
      const cookie = manageSessionCookiePayload(result.session);
      const response = redirectTo(`/${encodeURIComponent(slug)}/dashboard`);
      response.cookies.set(cookie.name, cookie.value, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: cookie.maxAge,
      });
      return response;
    }
    return redirectTo(`/manage/login?slug=${encodeURIComponent(slug)}&msg=${encodeURIComponent(result.error)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Accesso supporto non riuscito.";
    return redirectTo(`/manage/login?slug=${encodeURIComponent(slug)}&msg=${encodeURIComponent(message)}`);
  }
}
