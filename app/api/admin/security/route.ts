import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  confirmTotpSetup,
  disableTotp,
  listSaasAdminSessions,
  requireSaasAdminSession,
  revokeSaasAdminSessionById,
  saasAdminTotpEnabled,
  startTotpSetup,
} from "@/lib/saas-admin-auth";
import { assertSameOrigin, logSaasAdminAction, totpUri } from "@/lib/saas-admin-security";

// Sicurezza account admin (Fase 1 blindatura 2026-07-18): setup/disattivazione
// 2FA TOTP e gestione delle sessioni attive (lista + revoca remota).

export async function GET() {
  try {
    const session = await requireSaasAdminSession();
    const { getAdminSetting } = await import("@/lib/saas-admin-security");
    return Response.json({
      ok: true,
      totpEnabled: await saasAdminTotpEnabled(session.user.id),
      totpPolicyRequired: (await getAdminSetting("require_totp")) === "1",
      isOwner: session.user.role === "owner",
      sessions: await listSaasAdminSessions(session.user),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Accesso admin richiesto.", 401);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSaasAdminSession();
    const body = await parseRequestBody(request);
    const action = body.action || "";

    if (action === "totp_start") {
      const { secret } = await startTotpSetup(session.user.id);
      return Response.json({ ok: true, secret, uri: totpUri(session.user.email, secret) });
    }

    if (action === "totp_confirm") {
      const result = await confirmTotpSetup(session.user.id, body.code || "");
      if (!result.ok) return jsonError(result.error, 400);
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "totp_enable", request });
      return Response.json({ ok: true, backupCodes: result.backupCodes });
    }

    if (action === "totp_disable") {
      const result = await disableTotp(session.user.id, body.password || "", body.code || "");
      if (!result.ok) return jsonError(result.error, 400);
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "totp_disable", request });
      return Response.json({ ok: true });
    }

    // Policy "2FA obbligatoria" (rifiniture 2026-07-19): solo l'OWNER puo'
    // attivarla/disattivarla; chi non ha la 2FA viene bloccato (soft) sul
    // pannello finche' non la configura.
    if (action === "totp_policy_set") {
      if (session.user.role !== "owner") return jsonError("Solo un owner puo' cambiare la policy 2FA.", 403);
      const { setAdminSetting } = await import("@/lib/saas-admin-security");
      const value = body.value === "1" ? "1" : "0";
      await setAdminSetting("require_totp", value);
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "totp_policy_set", target: value, request });
      return Response.json({ ok: true, totpPolicyRequired: value === "1" });
    }

    if (action === "session_revoke") {
      const revoked = await revokeSaasAdminSessionById(session.user, parseInteger(body.id, 0));
      if (!revoked) return jsonError("Sessione non trovata o non revocabile.", 400);
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "session_revoke", target: `session#${body.id}`, request });
      return Response.json({ ok: true, sessions: await listSaasAdminSessions(session.user) });
    }

    return jsonError("Azione sicurezza non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}
