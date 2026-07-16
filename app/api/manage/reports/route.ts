import { jsonError, parseInteger } from "@/lib/api-utils";
import { countDbClients, listDbProducts, listDbSales, posDbSummary } from "@/lib/db-repositories";
import { getManageReports } from "@/lib/manage-reports";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "reports.view")) return jsonError("Permesso report mancante.", 403);

  try {
    const url = new URL(request.url);
    const compare = ["1", "true", "yes", "on"].includes((url.searchParams.get("compare") ?? "").toLowerCase());
    // Sede legacy (reports.php 296-338): filtra sulla SEDE CORRENTE di sessione
    // (app_current_location_id) con fallback alla PRIMA sede autorizzata;
    // all_locations=1/true/on/yes/all estende alla LISTA delle sedi autorizzate
    // (IN (...)), con righe location_id NULL incluse SOLO per l'admin
    // (reportCanIncludeNullLocation). FAIL-CLOSED (1=0 + alert) quando il
    // tenant ha sedi ma l'utente non ne ha di autorizzate.
    // location_id esplicito è un extra dell'API Next (la pagina non lo manda).
    const allLocations = ["1", "true", "yes", "on", "all"].includes((url.searchParams.get("all_locations") ?? "").toLowerCase());
    const locationContext = await getManageLocationContext(tenantSlug);
    const allowed = locationContext.locations;
    const allowedIds = allowed.map((l) => Number(l.id)).filter((n) => n > 0);
    const isAdminLike = String(session.user.role ?? "").toLowerCase() === "admin";
    const failClosed = locationContext.allLocations.length > 0 && allowedIds.length === 0;
    const requestedLocation = parseInteger(url.searchParams.get("location_id"), 0);
    let locationIds: number[];
    if (failClosed) {
      locationIds = [];
    } else if (requestedLocation > 0) {
      locationIds = [requestedLocation];
    } else if (allLocations) {
      locationIds = allowedIds;
    } else {
      let current = Number(locationContext.currentLocationId ?? 0);
      if (current <= 0 || !allowedIds.includes(current)) current = allowedIds[0] ?? 0;
      locationIds = current > 0 ? [current] : [];
    }
    const includeNull = allLocations && !failClosed && isAdminLike;
    // locationLabel() legacy (reports.php 328-337).
    const locationLabel = failClosed
      ? "Nessuna sede autorizzata"
      : allLocations && locationIds.length > 1
        ? "Tutte le sedi autorizzate"
        : locationIds.length === 1
          ? String(locationContext.allLocations.find((l) => Number(l.id) === locationIds[0])?.name ?? `Sede #${locationIds[0]}`)
          : "Tutte le sedi";
    const [summary, sales, clientsCount, products, analytics] = await Promise.all([
      posDbSummary(tenantSlug),
      listDbSales({ slug: tenantSlug }),
      // Solo il CONTEGGIO (2026-07-16): la lista completa serviva solo per .length.
      countDbClients({ slug: tenantSlug }),
      listDbProducts({ slug: tenantSlug }),
      // Date-filtered analytics (from/to = YYYY-MM-DD; default = current month).
      // Costi/Commissioni sono perm-gated come nel legacy (reports.php:1203/1268);
      // compare_from/compare_to permettono le modalita' di confronto della pagina.
      getManageReports(tenantSlug, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "", { ids: locationIds, includeNull, failClosed }, compare, {
        includeCosts: canAny(session.user.perms, ["costs.manage", "costs.items"]),
        includeCommissions: can(session.user.perms, "commissions.manage"),
        compareFrom: url.searchParams.get("compare_from") ?? undefined,
        compareTo: url.searchParams.get("compare_to") ?? undefined,
      }),
    ]);

    return Response.json({
      ok: true,
      sourceMode: "database",
      kpis: {
        activeSales: summary.saleCount,
        revenue: summary.activeTotal,
        cancelledRevenue: summary.cancelledTotal,
        averageTicket: summary.saleCount > 0 ? Math.round((summary.activeTotal / summary.saleCount) * 100) / 100 : 0,
        clients: clientsCount,
        lowStock: products.filter((product) => product.stock <= product.minStock).length,
      },
      paymentTotals: summary.paymentTotals,
      mix: {
        services: summary.serviceTotal,
        products: summary.productTotal,
      },
      latestSales: sales.slice(0, 5),
      // Etichetta sede per il sottotitolo legacy e 'Profilo clienti {sede}'.
      locationLabel,
      // Alert legacy 'Seleziona una sede valida per visualizzare i dati.'
      locationFailClosed: failClosed,
      analytics,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore report.");
  }
}
