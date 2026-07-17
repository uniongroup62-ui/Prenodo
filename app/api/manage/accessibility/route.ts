import { jsonError, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import {
  confirmEmailCode,
  getEmailVerificationPending,
  requestCurrentEmailVerification,
  requestEmailChange,
  resendEmailCode,
} from "@/lib/manage-accessibility";
import { currentManageSession, setManageSessionCookie } from "@/lib/manage-auth";
import { changeManagePassword } from "@/lib/manage-password-reset";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);
  const pending = await getEmailVerificationPending(tenantSlug, session.user.id, true);

  return Response.json({
    ok: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      needsEmailVerification: session.user.needsEmailVerification,
    },
    pendingEmailVerification: pending,
    password: {
      minLength: 8,
    },
  });
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  const body = await parseRequestBody(request);
  const action = String(body.action ?? "change_password");

  try {
    if (action === "request_email_verify") {
      const result = await requestCurrentEmailVerification({
        slug: tenantSlug,
        userId: session.user.id,
        email: session.user.email,
      });
      return Response.json(result);
    }

    if (action === "request_email_change") {
      const result = await requestEmailChange({
        slug: tenantSlug,
        userId: session.user.id,
        currentEmail: session.user.email,
        newEmail: String(body.new_email ?? ""),
        currentPassword: String(body.current_password_email ?? body.current_password ?? ""),
      });
      return Response.json(result);
    }

    if (action === "resend_email_code") {
      const result = await resendEmailCode({
        slug: tenantSlug,
        userId: session.user.id,
        currentEmail: session.user.email,
      });
      return Response.json(result);
    }

    if (action === "confirm_email_change") {
      const result = await confirmEmailCode({
        slug: tenantSlug,
        userId: session.user.id,
        currentEmail: session.user.email,
        code: String(body.code ?? ""),
      });
      await setManageSessionCookie({
        ...session,
        user: {
          ...session.user,
          email: result.email,
          needsEmailVerification: false,
        },
        issuedAt: Date.now(),
      });
      // Evento di sicurezza nel registro (module 'accessi'), SOLO dopo il
      // successo: cambio email vs semplice verifica dell'attuale.
      const emailChanged = result.email !== String(session.user.email ?? "").trim().toLowerCase();
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "accessi", action: "modifica", entityType: "user", entityId: session.user.id, label: emailChanged ? `Cambiata email di accesso in ${result.email}` : "Email di accesso verificata" });
      return Response.json(result);
    }

    if (action === "change_password") {
      // Ordine e flash verbatim di accessibility.php action=change_password
      // (campi vuoti -> coincidenza -> lunghezza min 8 -> password attuale).
      const currentPassword = String(body.current_password ?? "");
      const newPassword = String(body.new_password ?? body.password ?? "");
      const newPasswordConfirm = String(body.new_password_confirm ?? body.password_confirm ?? "");
      if (!currentPassword.trim() || !newPassword.trim() || !newPasswordConfirm.trim()) {
        return jsonError("Compila tutti i campi password", 400);
      }
      if (newPassword !== newPasswordConfirm) return jsonError("Le nuove password non coincidono", 400);
      if (Array.from(newPassword).length < 8) {
        return jsonError("La nuova password deve avere almeno 8 caratteri", 400);
      }

      await changeManagePassword({
        slug: tenantSlug,
        userId: session.user.id,
        currentPassword,
        newPassword,
      });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "accessi", action: "modifica", entityType: "user", entityId: session.user.id, label: "Password di accesso aggiornata" });
      return Response.json({ ok: true, message: "Password aggiornata" });
    }

    return jsonError("Azione accessibilita non supportata.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore accessibilita.", 400);
  }
}
