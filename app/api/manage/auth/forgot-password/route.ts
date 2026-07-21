import { headers } from "next/headers";
import { jsonError, parseRequestBody } from "@/lib/api-utils";
import { requestManagePasswordReset } from "@/lib/manage-password-reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for") ?? "";
  // XFF lato DESTRO (audit 21/07, come il login): il leftmost è controllato
  // dal client e renderebbe il rate-limit per-IP eludibile.
  const forwardedParts = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  const ip = forwardedParts[forwardedParts.length - 1] || headerStore.get("x-real-ip") || "";
  // MAI l'header Origin (client-controlled): la base del link viene da env in
  // manage-password-reset; l'origin della request resta solo fallback dev.
  const origin = new URL(request.url).origin;

  try {
    const result = await requestManagePasswordReset({
      slug: body.slug ?? "",
      email: body.email ?? "",
      ip,
      userAgent: headerStore.get("user-agent") ?? "",
      origin,
    });
    return Response.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Reset password non disponibile.", 400);
  }
}
