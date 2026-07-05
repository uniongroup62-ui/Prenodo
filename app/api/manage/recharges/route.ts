import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  deleteManageRechargeTemplate,
  getManageRechargesContext,
  getManageRechargeTemplate,
  saveManageRechargeTemplate,
} from "@/lib/manage-recharges";
import { can } from "@/lib/role-permissions";

// DB-backed port of the recharge_templates CRUD from app/pages/recharges.php
// (the "Modelli di ricarica" list + its create/edit modal + delete). Gated by
// fidelity.recharges like the legacy page (Auth::requirePerm('fidelity.recharges')).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "fidelity.recharges")) return jsonError("Permesso Ricariche mancante.", 403);

  try {
    const url = new URL(request.url);

    // Edit-form prefill: one template's editable fields. Port of the modal
    // data-mode=edit prefill.
    if (url.searchParams.get("action") === "get") {
      const templateId = parseInteger(url.searchParams.get("id"), 0);
      if (templateId <= 0) return jsonError("ID modello mancante.");
      const template = await getManageRechargeTemplate(tenantSlug, templateId);
      if (!template) return jsonError("Modello non trovato.", 404);
      return Response.json({ ok: true, source: "recharges?action=get", sourceMode: "database", template });
    }

    return Response.json(await getManageRechargesContext(tenantSlug));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore ricariche.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "fidelity.recharges")) return jsonError("Permesso Ricariche mancante.", 403);

  try {
    const body = await parseRequestBody(request);
    const url = new URL(request.url);
    // Accept both the new action= verbs and the legacy _mode= names.
    const action = String(body.action ?? body._mode ?? url.searchParams.get("action") ?? "save");

    switch (action) {
      case "create_template":
        return Response.json(await saveManageRechargeTemplate(tenantSlug, body, "create"));

      case "update_template":
        return Response.json(await saveManageRechargeTemplate(tenantSlug, body, "update"));

      // Compat: il vecchio verbo unico distingue per id.
      case "save":
        return Response.json(await saveManageRechargeTemplate(tenantSlug, body, parseInteger(body.template_id ?? body.id, 0) > 0 ? "update" : "create"));

      case "delete":
      case "delete_template":
        return Response.json(await deleteManageRechargeTemplate(tenantSlug, parseInteger(body.template_id ?? body.id, 0)));

      // Stub legacy: le ricariche si registrano dalla cassa (recharges.php ~178).
      case "create_recharge":
        return Response.json({ ok: true, message: "Le ricariche credito si registrano dalla pagina Pagamenti.", type: "info" });

      default:
        return jsonError("Azione ricariche non supportata.", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione ricariche non riuscita.");
  }
}
