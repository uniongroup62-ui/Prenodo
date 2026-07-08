import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessViaParent, resolveManageLocationId, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { collectDbPreorder, createDbPreorder, listDbPreorders } from "@/lib/db-repositories";
import { can } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "pos.preorders")) return jsonError("Permesso preordini mancante.", 403);

  const url = new URL(request.url);
  // "Tutte" (explicit location_id=0) means all locations / non-location-aware stock,
  // like the legacy page; a valid selected location makes the stock location-aware.
  const locationId = await resolveManageLocationId({
    slug: tenantSlug,
    raw: url.searchParams.get("location_id"),
    fallbackCurrent: false,
  });

  try {
    return Response.json({
      ok: true,
      sourceMode: "database",
      preorders: await listDbPreorders(tenantSlug, { locationId }),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preordini.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "pos.preorders")) return jsonError("Permesso preordini mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? body.do ?? "create";

  try {
    if (action === "create") {
      const preorder = await createDbPreorder({
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        productId: parseInteger(body.product_id, 0),
        quantity: parseInteger(body.quantity, 1),
        deposit: parseNumber(body.deposit, 0),
        dueDate: body.due_date,
      }, tenantSlug);
      return Response.json({
        ok: true,
        source: "pos_preorders?action=create",
        sourceMode: "database",
        preorder,
        preorders: await listDbPreorders(tenantSlug),
      });
    }

    if (action === "collect" || action === "mark_collected") {
      const saleItemId = parseInteger(body.id ?? body.sale_item_id);
      // Guardia per-sede: il preordine (sale_item) eredita la sede dalla vendita.
      await assertLocationAccessViaParent(tenantSlug, "sale_items", saleItemId, "sale_id", "sales", sessionAllowedLocationIds(session), "Preordine non disponibile per le tue sedi.");
      const preorder = await collectDbPreorder(saleItemId, tenantSlug);
      return Response.json({
        ok: true,
        source: "pos_preorders?action=collect",
        sourceMode: "database",
        preorder,
        preorders: await listDbPreorders(tenantSlug),
      });
    }

    return jsonError("Azione preordini non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preordini.");
  }
}
