import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { consumeDbPrepaid, issueDbPrepaid, listDbPrepaids } from "@/lib/db-repositories";
import { can } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "pos.prepaids")) return jsonError("Permesso prepagati mancante.", 403);

  try {
    // Filtro sede server-side (audit giro 3: il select della pagina era cosmetico).
    const locationId = parseInteger(new URL(request.url).searchParams.get("location_id"), 0);
    return Response.json({
      ok: true,
      sourceMode: "database",
      prepaids: await listDbPrepaids(tenantSlug, { locationId }),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore prepagati.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "pos.prepaids")) return jsonError("Permesso prepagati mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "issue";

  try {
    if (action === "issue") {
      const prepaid = await issueDbPrepaid({
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        serviceId: parseInteger(body.service_id, 0),
        quantity: parseInteger(body.quantity, 1),
        expiresAt: body.expires_at,
      }, tenantSlug);
      return Response.json({
        ok: true,
        source: "pos_prepaids?action=issue",
        sourceMode: "database",
        prepaid,
        prepaids: await listDbPrepaids(tenantSlug),
      });
    }

    if (action === "use") {
      const prepaid = await consumeDbPrepaid(parseInteger(body.id), parseInteger(body.quantity, 1), tenantSlug);
      return Response.json({
        ok: true,
        source: "pos_prepaids?action=use",
        sourceMode: "database",
        prepaid,
        prepaids: await listDbPrepaids(tenantSlug),
      });
    }

    return jsonError("Azione prepagati non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore prepagati.");
  }
}
