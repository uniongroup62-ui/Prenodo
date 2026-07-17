import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { currentManageSession } from "@/lib/manage-auth";
import { resolveManageLocationId } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  deleteManageService,
  deleteServiceCategory,
  getManageService,
  getManageServicesContext,
  moveServiceCategory,
  saveManageService,
  saveServiceCategory,
  saveServiceCategoryMarketplace,
  saveServiceOrder,
  saveServiceRecommendations,
  serviceDeleteBlockersLegacy,
} from "@/lib/manage-services";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);
  if (!canAny(session.user.perms, ["services.manage", "service_categories.manage", "service_recommendations.manage"])) {
    return jsonError("Permesso negato.", 403);
  }

  try {
    const url = new URL(request.url);

    // Edit-form prefill: return ONE service's editable fields for one id. Port of
    // services.php action=edit (loads services row + its location/cabin/staff/
    // resource links). Gated by services.manage like the save action.
    if (url.searchParams.get("action") === "get") {
      if (!can(session.user.perms, "services.manage")) return jsonError("Permesso Servizi richiesto.", 403);
      const serviceId = parseInteger(url.searchParams.get("id"), 0);
      if (serviceId <= 0) return jsonError("ID servizio mancante.");
      const service = await getManageService(tenantSlug, serviceId);
      if (!service) return jsonError("Servizio non trovato.", 404);
      return Response.json({ ok: true, source: "services?action=get", sourceMode: "database", service });
    }

    // Blocchi eliminazione per il popup della lista (svc_delete_blockers, il
    // legacy li embedda nelle righe come data-service-delete-blockers).
    if (url.searchParams.get("action") === "delete_blockers") {
      if (!can(session.user.perms, "services.manage")) return jsonError("Permesso Servizi richiesto.", 403);
      const serviceId = parseInteger(url.searchParams.get("id"), 0);
      if (serviceId <= 0) return jsonError("ID servizio mancante.");
      const blockers = await serviceDeleteBlockersLegacy(tenantSlug, serviceId);
      return Response.json({ ok: true, sourceMode: "database", blockers });
    }

    const locationId = await resolveManageLocationId({
      slug: tenantSlug,
      raw: url.searchParams.get("location_id"),
      fallbackCurrent: true,
    });
    return Response.json(await getManageServicesContext(tenantSlug, {
      query: url.searchParams.get("q") ?? "",
      locationId,
      includeInactive: ["1", "true", "yes", "all"].includes((url.searchParams.get("include_inactive") ?? "1").toLowerCase()),
    }));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Servizi non caricati.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  try {
    const body = await parseRequestBody(request);
    const url = new URL(request.url);
    const action = String(body.action ?? url.searchParams.get("action") ?? "create");

    switch (action) {
      case "create":
      case "new":
      case "save":
      case "service_save":
      case "update":
      case "edit": {
        if (!can(session.user.perms, "services.manage")) return jsonError("Permesso Servizi richiesto.", 403);
        // Il save legacy puo' rispondere con un pannello di CONFERMA (pending)
        // invece di salvare; il form ripete il POST con i confirm_* accumulati.
        const isSvcEdit = parseInteger(body.id ?? body.service_id, 0) > 0;
        const result = await saveManageService(tenantSlug, body);
        // Il pannello di CONFERMA (pending) non salva nulla: niente log.
        if (result.pending) return Response.json({ ok: true, pending: result.pending });
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "servizi", action: isSvcEdit ? "modifica" : "crea", entityType: "service", entityId: parseInteger(body.id ?? body.service_id, 0), label: `${isSvcEdit ? "Modificato" : "Creato"} servizio "${String(body.name ?? "").trim() || "senza nome"}"` });
        return Response.json({ ...result.context, ok: true, msg: result.msg });
      }

      case "delete":
      case "service_delete": {
        if (!can(session.user.perms, "services.manage")) return jsonError("Permesso Servizi richiesto.", 403);
        try {
          const context = await deleteManageService(tenantSlug, parseInteger(body.id ?? body.service_id, 0));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "servizi", action: "elimina", entityType: "service", entityId: parseInteger(body.id ?? body.service_id, 0), label: `Eliminato servizio #${parseInteger(body.id ?? body.service_id, 0)}` });
          return Response.json({ ...context, ok: true, msg: "Servizio eliminato" });
        } catch (error) {
          const popup = error instanceof Error ? (error as Error & { popup?: unknown }).popup : undefined;
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore servizi.", ...(popup ? { popup } : {}) }, { status: 400 });
        }
      }

      case "category_save":
      case "service_category_save":
      case "category_new":
      case "category_edit": {
        if (!can(session.user.perms, "service_categories.manage")) return jsonError("Permesso Categorie servizi richiesto.", 403);
        const context = await saveServiceCategory(tenantSlug, body);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "servizi", action: parseInteger(body.id, 0) > 0 ? "modifica" : "crea", entityType: "service_category", entityId: parseInteger(body.id, 0), label: `${parseInteger(body.id, 0) > 0 ? "Modificata" : "Creata"} categoria servizi "${String(body.name ?? "").trim() || "senza nome"}"` });
        return Response.json({ ...context, ok: true, msg: parseInteger(body.id, 0) > 0 ? "Categoria aggiornata" : "Categoria creata" });
      }

      case "category_delete":
      case "service_category_delete": {
        if (!can(session.user.perms, "service_categories.manage")) return jsonError("Permesso Categorie servizi richiesto.", 403);
        try {
          const context = await deleteServiceCategory(tenantSlug, parseInteger(body.id ?? body.category_id, 0));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "servizi", action: "elimina", entityType: "service_category", entityId: parseInteger(body.id ?? body.category_id, 0), label: `Eliminata categoria servizi #${parseInteger(body.id ?? body.category_id, 0)}` });
          return Response.json({ ...context, ok: true, msg: "Categoria eliminata" });
        } catch (error) {
          const popup = error instanceof Error ? (error as Error & { popup?: unknown }).popup : undefined;
          return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore categorie.", ...(popup ? { popup } : {}) }, { status: 400 });
        }
      }

      case "category_move":
      case "service_category_move": {
        if (!can(session.user.perms, "service_categories.manage")) return jsonError("Permesso Categorie servizi richiesto.", 403);
        const context = await moveServiceCategory(
          tenantSlug,
          parseInteger(body.id ?? body.category_id, 0),
          body.direction === "down" ? "down" : "up",
        );
        // services.php 3520-3523.
        if (!context.moved) return Response.json({ ...context, ok: false, error: "Impossibile spostare la categoria" }, { status: 400 });
        return Response.json({ ...context, ok: true, msg: "Ordine categorie aggiornato" });
      }

      case "save_service_order":
      case "service_order_save": {
        if (!can(session.user.perms, "service_categories.manage")) return jsonError("Permesso Categorie servizi richiesto.", 403);
        const context = await saveServiceOrder(tenantSlug, body);
        // services.php 3538-3540: entrambi come msg (alert success solo per il primo).
        return Response.json({ ...context, ok: true, msg: context.ordered ? "Ordine servizi aggiornato" : "Nessun servizio da ordinare" });
      }

      case "category_marketplace_save":
      case "service_category_marketplace_save":
        if (!canAny(session.user.perms, ["service_categories.manage", "settings.general"])) return jsonError("Permesso Marketplace richiesto.", 403);
        return Response.json(await saveServiceCategoryMarketplace(tenantSlug, body));

      case "recommendations_save":
      case "service_recommendations_save":
      case "recommended_save": {
        if (!can(session.user.perms, "service_recommendations.manage")) return jsonError("Permesso Servizi consigliati richiesto.", 403);
        const context = await saveServiceRecommendations(tenantSlug, body);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "servizi", action: "modifica", entityType: "service", entityId: 0, label: "Salvati servizi consigliati" });
        return Response.json({ ...context, ok: true, msg: "Servizi consigliati aggiornati" });
      }

      default:
        return jsonError("Azione servizi non supportata.", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione servizi non riuscita.");
  }
}
