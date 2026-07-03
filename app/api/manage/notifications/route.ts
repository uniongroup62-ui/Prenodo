import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { getAutomationSettings, saveClientBirthdayAlertDays } from "@/lib/automation-reminders";
import { listDbNotifications, markDbNotificationRead } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { getNotificationSummary } from "@/lib/manage-shell-context";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso notifiche mancante.", 403);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";

  try {
    // Port del poller legacy ?page=notifications&action=count: ritorna il
    // notificationSummary corrente (badge topbar) con no-store.
    if (action === "count") {
      const locationContext = await getManageLocationContext(tenantSlug);
      const summary = await getNotificationSummary(
        tenantSlug,
        session.user,
        locationContext.currentLocationId,
        locationContext.needsLocationSelection,
      );
      return Response.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
    }

    // Impostazioni avvisi lette dalle pagine notifiche (giorni compleanni/rate).
    if (action === "settings") {
      const settings = await getAutomationSettings(tenantSlug);
      return Response.json({
        ok: true,
        client_birthday_alert_days: settings.client_birthday_alert_days,
        installment_alert_days: settings.installment_alert_days,
      });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      notifications: await listDbNotifications(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso notifiche mancante.", 403);

  const body = await parseRequestBody(request);
  const action = String(body.action ?? "read");

  try {
    // Port di notifications_birthdays.php action=save_settings: clamp 0..365 e
    // persistenza di client_birthday_alert_days, messaggio legacy.
    if (action === "save_birthday_days") {
      if (!canAny(session.user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"])) {
        return jsonError("Operazione non autorizzata", 403);
      }
      const days = await saveClientBirthdayAlertDays(tenantSlug, parseInteger(body.client_birthday_alert_days ?? body.days, 7));
      return Response.json({ ok: true, message: "Impostazioni salvate", days });
    }

    const id = parseInteger(body.id);
    const notification = await markDbNotificationRead(id, tenantSlug);
    return Response.json({ ok: true, source: "notifications?action=read", sourceMode: "database", notification, notifications: await listDbNotifications(tenantSlug) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}
