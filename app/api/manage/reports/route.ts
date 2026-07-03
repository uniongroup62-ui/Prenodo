import { jsonError, parseInteger } from "@/lib/api-utils";
import { listDbClients, listDbProducts, listDbSales, posDbSummary } from "@/lib/db-repositories";
import { getManageReports } from "@/lib/manage-reports";
import { currentManageSession } from "@/lib/manage-auth";
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
    const [summary, sales, clients, products, analytics] = await Promise.all([
      posDbSummary(tenantSlug),
      listDbSales({ slug: tenantSlug }),
      listDbClients({ slug: tenantSlug }),
      listDbProducts({ slug: tenantSlug }),
      // Date-filtered analytics (from/to = YYYY-MM-DD; default = current month).
      // Costi/Commissioni sono perm-gated come nel legacy (reports.php:1203/1268);
      // compare_from/compare_to permettono le modalita' di confronto della pagina.
      getManageReports(tenantSlug, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "", parseInteger(url.searchParams.get("location_id"), 0), compare, {
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
        clients: clients.length,
        lowStock: products.filter((product) => product.stock <= product.minStock).length,
      },
      paymentTotals: summary.paymentTotals,
      mix: {
        services: summary.serviceTotal,
        products: summary.productTotal,
      },
      latestSales: sales.slice(0, 5),
      analytics,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore report.");
  }
}
