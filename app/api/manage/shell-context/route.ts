import { jsonError } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  getClosureRange,
  getNotificationSummary,
  getSupportAccess,
} from "@/lib/manage-shell-context";
import { can, canAny, isAssignable } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Drives the global manage chrome (components/manage-shell.tsx): notification
// bell counts, the topbar location selector, and the support/closure sticky
// alerts. Faithful port of the View.php topbar context. Always tenant-scoped.
export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  const locationContext = await getManageLocationContext(tenantSlug);
  const currentLocationId = locationContext.currentLocationId;
  const needsLocationSelection = locationContext.needsLocationSelection;

  const [notif, closureRange, supportAccess] = await Promise.all([
    getNotificationSummary(tenantSlug, session.user, currentLocationId, needsLocationSelection),
    needsLocationSelection ? Promise.resolve(null) : getClosureRange(tenantSlug, currentLocationId),
    getSupportAccess(tenantSlug),
  ]);

  // Gate per-icona della topbar legacy (View.php 796-824): la campanella
  // compleanni richiede notifications.view + canAny(clients...), rate
  // installments.manage, preventivi quotes.manage; il bottone "+ Prenotazione"
  // appointments.quick_booking. viewerUserId alimenta lo scope localStorage del
  // poller notifiche browser (beautysuite_browser_notifications:tenant:user:loc).
  const perms = session.user.perms;
  // Auth::can legacy per il dropdown account (View.php 830-844): admin passa
  // sempre; i permessi NON-assegnabili (roles.manage) sono negati ai non-admin
  // anche se presenti in DB (stessa regola della pagina Ruoli); Accessibilità
  // ed Esci sono per qualsiasi utente autenticato (gate lato client).
  const isAdmin = String(session.user.role ?? "").toLowerCase() === "admin";
  const authCan = (perm: string): boolean => {
    if (isAdmin) return true;
    if (!isAssignable(perm)) return false;
    return can(perms, perm);
  };
  const authCanAny = (list: string[]): boolean => isAdmin || canAny(perms, list.filter(isAssignable));
  const topbar = {
    canViewNotifications: authCan("notifications.view"),
    bellBirthdays: authCanAny(["clients.manage", "client_sheets.manage", "client_consents.manage"]),
    bellInstallments: authCan("installments.manage"),
    bellQuotes: authCan("quotes.manage"),
    quickBooking: authCan("appointments.quick_booking"),
    accountBusinessProfile: authCan("settings.general"),
    accountLocations: authCan("settings.location"),
    accountConsentModules: authCan("consent_modules.manage"),
    accountRoles: authCan("roles.manage"),
  };

  return Response.json({
    ok: true,
    sourceMode: locationContext.sourceMode,
    notif,
    topbar,
    viewerUserId: Number(session.user.id ?? 0),
    locations: locationContext.locations.map((location) => ({ id: location.id, name: location.name })),
    currentLocationId,
    needsLocationSelection,
    supportAccess,
    closureRange,
  });
}
