import { jsonError } from "@/lib/api-utils";
import { getManageDashboard } from "@/lib/manage-dashboard";
import { getDashboardAlerts } from "@/lib/manage-dashboard-alerts";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dashboard manage — port fedele di app/pages/dashboard.php +
// api_dashboard_performance.php (calcoli in lib/manage-dashboard.ts, avvisi in
// lib/manage-dashboard-alerts.ts). Gating legacy: pagina dietro dashboard.view;
// "Prossimi appuntamenti" dietro calendar.view; "Scadenziario e Costi" dietro
// costs.manage|costs.items (le card mancano dal payload senza permesso).
export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "dashboard.view")) return jsonError("Permesso dashboard mancante.", 403);

  try {
    const locationContext = await getManageLocationContext(tenantSlug);
    // $dashboardLocationFailClosed (dashboard.php 18-27): fail-closed quando il
    // tenant HA sedi attive e (l'utente non ne ha di consentite — es. cookie con
    // sedi revocate — oppure nessuna sede selezionata). Con locations.length===1
    // la sede è auto-selezionata, quindi current>0; il tenant SENZA sedi calcola
    // tenant-wide (hasLocationContext false, come il legacy). La stessa regola
    // gata KPI, settimanale, upcoming, costi e TUTTI gli avvisi (righe 60-361).
    const locationFailClosed =
      locationContext.allLocations.length > 0 &&
      (locationContext.locations.length === 0 || locationContext.currentLocationId <= 0);
    const [dashboard, alerts] = await Promise.all([
      getManageDashboard(tenantSlug, {
        locationId: locationContext.currentLocationId,
        canSeeCalendar: can(session.user.perms, "calendar.view"),
        canSeeCosts: canAny(session.user.perms, ["costs.manage", "costs.items"]),
        needsLocationSelection: locationFailClosed,
      }),
      // Avvisi raggruppati (port dedicato con permessi + sede come dashboard.php).
      getDashboardAlerts(tenantSlug, {
        perms: session.user.perms,
        currentLocationId: locationContext.currentLocationId,
        needsLocationSelection: locationFailClosed,
      }),
    ]);

    return Response.json({ ok: true, sourceMode: "database", locationFailClosed, alerts, ...dashboard });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore dashboard.");
  }
}
