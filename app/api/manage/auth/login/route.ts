import { headers } from "next/headers";
import { jsonError, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { loginManageUser, setManageSessionCookie } from "@/lib/manage-auth";

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for") ?? "";
  // Valore più a DESTRA di X-Forwarded-For (appeso dall'edge fidato): il primo
  // è controllato dal client e renderebbe il rate-limit per-IP eludibile
  // ruotando header fasulli.
  const forwardedParts = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  const ip = forwardedParts[forwardedParts.length - 1] || headerStore.get("x-real-ip") || "";

  const result = await loginManageUser({
    slug: body.slug ?? "",
    email: body.email ?? "",
    password: body.password ?? "",
    ip,
  });

  if (!result.ok) return jsonError(result.error, 401);

  await setManageSessionCookie(result.session);
  // Accesso riuscito nel registro attività (feature Log 2026-07-16): fire-and-
  // forget, non può fallire il login.
  void logActivity(String(body.slug ?? ""), { user: result.session.user, locationId: result.session.user.currentLocationId, module: "accessi", action: "login", label: `Accesso di ${result.session.user.name || result.session.user.email}${ip ? ` (IP ${ip})` : ""}` });
  return Response.json({
    ok: true,
    redirectTo: result.redirectTo,
    user: result.session.user,
    source: result.source,
  });
}
