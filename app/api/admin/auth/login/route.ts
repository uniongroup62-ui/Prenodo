import { headers } from "next/headers";
import { jsonError, parseRequestBody } from "@/lib/api-utils";
import {
  bootstrapSaasAdmin,
  isSaasBootstrapped,
  loginSaasAdmin,
  setSaasAdminSessionCookie,
  verifyTotpLogin,
} from "@/lib/saas-admin-auth";
import { assertSameOrigin, logSaasAdminAction } from "@/lib/saas-admin-security";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Richiesta non valida.", 403);
  }
  const body = await parseRequestBody(request);
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for") ?? "";
  const ip = forwardedFor.split(",")[0]?.trim() || headerStore.get("x-real-ip") || "";

  // Secondo passo del login 2FA: challenge firmata + codice TOTP/backup.
  if (body.mode === "totp") {
    const result = await verifyTotpLogin({ challenge: body.challenge || "", code: body.code || "", ip });
    if (!result.ok) return jsonError(result.error, 401);
    if ("needsTotp" in result) return jsonError("Verifica non valida.", 401);
    await setSaasAdminSessionCookie(result.session, request);
    void logSaasAdminAction({ adminId: result.session.user.id, adminEmail: result.session.user.email, action: "login_2fa", request });
    return Response.json({ ok: true, redirectTo: "/admin", user: result.session.user });
  }

  if (body.mode === "bootstrap" || !await isSaasBootstrapped()) {
    // Il bootstrap del PRIMO owner in produzione esige il token di deploy:
    // senza, la finestra fra deploy e primo login sarebbe una porta aperta.
    const requiredToken = String(process.env.ADMIN_BOOTSTRAP_TOKEN ?? "").trim();
    if (process.env.NODE_ENV === "production" && (!requiredToken || String(body.bootstrap_token ?? "").trim() !== requiredToken)) {
      return jsonError("Bootstrap non autorizzato: token mancante o errato (ADMIN_BOOTSTRAP_TOKEN).", 403);
    }
    try {
      const session = await bootstrapSaasAdmin({
        name: body.name || "Admin",
        email: body.email || "",
        password: body.password || "",
      });
      await setSaasAdminSessionCookie(session, request);
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "bootstrap_owner", request });
      return Response.json({ ok: true, redirectTo: "/admin", user: session.user });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Bootstrap non riuscito.", 400);
    }
  }

  const result = await loginSaasAdmin({
    email: body.email || "",
    password: body.password || "",
    ip,
  });
  if (!result.ok) return jsonError(result.error, 401);
  if ("needsTotp" in result) {
    return Response.json({ ok: true, needsTotp: true, challenge: result.challenge });
  }

  await setSaasAdminSessionCookie(result.session, request);
  void logSaasAdminAction({ adminId: result.session.user.id, adminEmail: result.session.user.email, action: "login", request });
  return Response.json({ ok: true, redirectTo: "/admin", user: result.session.user });
}
