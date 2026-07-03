import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { addManageClientPackageUsage, consumeDbClientPackage, deleteManagePackageCatalog, getManageClientPackage, getManagePackageCatalog, getPackageCatalogFormContext, issueDbClientPackage, listDbPackageState, listManagePackageCatalog, saveManagePackageCatalog, updateManageClientPackageExpiry } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const packageReadPerms = ["packages.access", "packages.clients", "packages.catalog", "pos.manage"];
const packageWritePerms = ["packages.clients", "pos.manage"];
const packageCatalogPerms = ["packages.catalog", "pos.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, packageReadPerms)) return jsonError("Permesso pacchetti mancante.", 403);

  try {
    const url = new URL(request.url);

    // Faithful catalog LIST (tab=catalog): the package templates + contents/sedi/
    // price/validity/sold columns. Come il legacy la lista è filtrata sulla sede
    // corrente ([] sedi = vendibile ovunque) salvo all_locations=1; empty state e
    // filtro "Tutte le sedi" (solo multi-sede) si basano sul conteggio NON filtrato.
    if (url.searchParams.get("action") === "catalog") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      const allRows = await listManagePackageCatalog(tenantSlug);
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      const catalog = filterLocationId > 0
        ? allRows.filter((r) => r.locationIds.length === 0 || r.locationIds.includes(filterLocationId))
        : allRows;
      return Response.json({ ok: true, sourceMode: "database", catalog, totalCount: allRows.length, locationsCount: locationContext?.locations.length ?? 0 });
    }

    // Catalog editor context (services + products + sedi for the contents rows).
    if (url.searchParams.get("action") === "catalog_form_context") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", context: await getPackageCatalogFormContext(tenantSlug) });
    }

    // Catalog editor prefill (catalog_edit): one template's header + lines + sedi.
    if (url.searchParams.get("action") === "catalog_get") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      const template = await getManagePackageCatalog(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!template) return jsonError("Pacchetto catalogo non trovato.", 404);
      return Response.json({ ok: true, sourceMode: "database", template });
    }

    // Client-package DETAIL (tab=clients action=view/client_view): header +
    // per-service contents + usage history + expiry-edit flag.
    if (url.searchParams.get("action") === "view" || url.searchParams.get("action") === "client_view") {
      const detail = await getManageClientPackage(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("Pacchetto cliente non trovato.", 404);
      return Response.json({ ok: true, sourceMode: "database", detail });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      ...await listDbPackageState(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore pacchetti.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  // Top gate: any package write permission (clients OR catalog OR pos); each
  // action re-checks its finer permission below.
  if (!canAny(session.user.perms, [...packageWritePerms, ...packageCatalogPerms])) return jsonError("Permesso pacchetti mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "issue";

  try {
    if (action === "issue") {
      const input = {
        packageId: parseInteger(body.package_id, 0),
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        expiresAt: body.expires_at,
      };
      const clientPackage = await issueDbClientPackage(input, tenantSlug);
      return Response.json({ ok: true, source: "packages?action=issue", sourceMode: "database", clientPackage, ...await listDbPackageState(tenantSlug) });
    }

    if (action === "use") {
      const id = parseInteger(body.id);
      const sessions = parseInteger(body.sessions, 1);
      const clientPackage = await consumeDbClientPackage(id, sessions, tenantSlug);
      return Response.json({ ok: true, source: "packages?action=use", sourceMode: "database", clientPackage, ...await listDbPackageState(tenantSlug) });
    }

    // Create / update a catalog template (port of catalog_new/catalog_edit).
    if (action === "catalog_save" || action === "catalog_new" || action === "catalog_edit") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      const saved = await saveManagePackageCatalog(tenantSlug, body, parseInteger(body.id, 0));
      return Response.json({ ok: true, source: "packages?action=catalog_save", sourceMode: "database", ...saved, catalog: await listManagePackageCatalog(tenantSlug) });
    }

    // Update a client package's expiry (port of update_client_package_expiry).
    if (action === "update_expiry" || action === "update_client_package_expiry") {
      const cpId = parseInteger(body.client_package_id ?? body.id, 0);
      await updateManageClientPackageExpiry(tenantSlug, cpId, String(body.expires_at ?? ""));
      const detail = await getManageClientPackage(tenantSlug, cpId);
      return Response.json({ ok: true, source: "packages?action=update_expiry", sourceMode: "database", detail });
    }

    // Register a manual usage movement (port of usage_add, service path):
    // scala/ripristina sedute on a client package. Gated by packages.clients.
    if (action === "usage_add") {
      const cpId = parseInteger(body.client_package_id ?? body.id, 0);
      await addManageClientPackageUsage(tenantSlug, cpId, String(body.op ?? ""), parseInteger(body.qty, 1), parseInteger(body.service_id, 0), String(body.note ?? ""), session.user.id);
      const detail = await getManageClientPackage(tenantSlug, cpId);
      return Response.json({ ok: true, source: "packages?action=usage_add", sourceMode: "database", detail });
    }

    // Delete a catalog template (port of action=catalog_delete): detach client
    // packages + drop the template's child rows. Gated by packages.catalog.
    if (action === "catalog_delete") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      await deleteManagePackageCatalog(tenantSlug, parseInteger(body.id, 0));
      return Response.json({ ok: true, source: "packages?action=catalog_delete", sourceMode: "database", catalog: await listManagePackageCatalog(tenantSlug) });
    }

    return jsonError("Azione pacchetti non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore pacchetti.");
  }
}
