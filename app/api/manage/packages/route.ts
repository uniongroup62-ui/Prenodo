import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { addManageClientPackageUsage, consumeDbClientPackage, deleteManagePackageCatalog, getClientPackageCancelInfo, getManageClientPackage, getManageClientPackageForEdit, getManagePackageCatalog, getManagePackagesFilters, getPackageCatalogFormContext, issueDbClientPackage, listDbPackageState, listManageClientPackagesPaged, listManagePackageCatalog, saveManageClientPackage, saveManagePackageCatalog, updateManageClientPackageExpiry } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessById, getManageLocationContext, sessionAllowedLocationIds } from "@/lib/manage-locations";

// Messaggio legacy per un pacchetto cliente di un'altra sede (packages.php).
const PKG_SEDE_ERR = "Pacchetto cliente non disponibile per la sede selezionata.";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

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
    // contents (servizi+prodotti con riserve) + movimenti (reali+virtuali) +
    // voci registrabili + availability + expiry-edit flags.
    if (url.searchParams.get("action") === "view" || url.searchParams.get("action") === "client_view") {
      await assertLocationAccessById(tenantSlug, "client_packages", parseInteger(url.searchParams.get("id"), 0), sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      const detail = await getManageClientPackage(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      // Messaggio querystring legacy (senza punto).
      if (!detail) return jsonError("Pacchetto cliente non trovato", 404);
      return Response.json({
        ok: true,
        sourceMode: "database",
        detail,
        perms: {
          packagesClients: can(session.user.perms, "packages.clients"),
          packagesCatalog: can(session.user.perms, "packages.catalog"),
          packagesSettings: can(session.user.perms, "packages.settings"),
          openSaleDetail: canAny(session.user.perms, ["pos.manage", "pos.movements", "pos.prepaids", "pos.preorders"]),
          clientLinks: canAny(session.user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"]),
          quotesManage: can(session.user.perms, "quotes.manage"),
        },
      });
    }

    // Prefill form client_edit (tab=clients action=client_edit).
    if (url.searchParams.get("action") === "client_get") {
      await assertLocationAccessById(tenantSlug, "client_packages", parseInteger(url.searchParams.get("id"), 0), sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      const edit = await getManageClientPackageForEdit(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!edit) return jsonError("Pacchetto non trovato", 404);
      return Response.json({ ok: true, sourceMode: "database", edit });
    }

    // Info redirect per client_cancel/client_delete (il legacy manda al
    // dettaglio vendita quando esiste).
    if (url.searchParams.get("action") === "client_cancel_info") {
      const info = await getClientPackageCancelInfo(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      return Response.json({ ok: true, sourceMode: "database", ...info });
    }

    // Filtri lista (clienti + nomi pacchetto + catalogo per il form).
    if (url.searchParams.get("action") === "filters") {
      const filters = await getManagePackagesFilters(tenantSlug);
      return Response.json({ ok: true, sourceMode: "database", ...filters });
    }

    // LISTA pacchetti clienti fedele (tab=clients action=list): filtri
    // cliente/pacchetto/stato + sede corrente (all_locations=1 la disattiva).
    if (url.searchParams.get("action") === "client_list") {
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      // Paginazione 25 (2026-07-16): SOLO con ?p= — gli altri consumer restano
      // sul comportamento storico (cap 300 senza finestra).
      const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 0;
      const paged = await listManageClientPackagesPaged(tenantSlug, {
        clientId: parseInteger(url.searchParams.get("client_id"), 0),
        packageName: url.searchParams.get("package_name") ?? "",
        q: url.searchParams.get("q") ?? "",
        status: url.searchParams.get("status") ?? "active",
        locationId: filterLocationId,
        page,
      });
      const filters = await getManagePackagesFilters(tenantSlug);
      return Response.json({
        ok: true,
        sourceMode: "database",
        clientPackages: paged.rows,
        totalCount: paged.totalCount,
        pageSize: paged.pageSize,
        currentPage: page >= 1 ? page : 1,
        clients: filters.clients,
        packageNames: filters.packageNames,
        hasAnyClientPackages: filters.hasAnyClientPackages,
        locationsCount: locationContext?.locations.length ?? 0,
        perms: {
          packagesClients: can(session.user.perms, "packages.clients"),
          packagesCatalog: can(session.user.perms, "packages.catalog"),
          packagesSettings: can(session.user.perms, "packages.settings"),
          posManage: can(session.user.perms, "pos.manage"),
          clientLinks: canAny(session.user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"]),
        },
      });
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
        // Sede di sessione (igiene dati 2026-07-16): come il path POS.
        locationId: Number(session.user.currentLocationId ?? 0) || 0,
      };
      const clientPackage = await issueDbClientPackage(input, tenantSlug);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: "crea", entityType: "client_package", entityId: clientPackage.id, label: `Emesso pacchetto "${clientPackage.name}" a ${clientPackage.clientName || `cliente #${clientPackage.clientId}`}` });
      return Response.json({ ok: true, source: "packages?action=issue", sourceMode: "database", clientPackage, ...await listDbPackageState(tenantSlug) });
    }

    if (action === "use") {
      const id = parseInteger(body.id);
      await assertLocationAccessById(tenantSlug, "client_packages", id, sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      const sessions = parseInteger(body.sessions, 1);
      const clientPackage = await consumeDbClientPackage(id, sessions, tenantSlug);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: "scala", entityType: "client_package", entityId: id, label: `Scalate ${sessions} sedute dal pacchetto cliente #${id}` });
      return Response.json({ ok: true, source: "packages?action=use", sourceMode: "database", clientPackage, ...await listDbPackageState(tenantSlug) });
    }

    // Create / update a catalog template (port of catalog_new/catalog_edit).
    if (action === "catalog_save" || action === "catalog_new" || action === "catalog_edit") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      const isEdit = parseInteger(body.id, 0) > 0;
      const saved = await saveManagePackageCatalog(tenantSlug, body, parseInteger(body.id, 0));
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: isEdit ? "modifica" : "crea", entityType: "package", entityId: saved.id, label: `${isEdit ? "Modificato" : "Creato"} pacchetto catalogo "${String(body.name ?? "").trim() || `#${saved.id}`}"` });
      return Response.json({ ok: true, source: "packages?action=catalog_save", sourceMode: "database", ...saved, catalog: await listManagePackageCatalog(tenantSlug) });
    }

    // Update a client package's expiry (port of update_client_package_expiry).
    // Esiti legacy: msg "Scadenza pacchetto aggiornata" / err "Errore: <detail>".
    if (action === "update_expiry" || action === "update_client_package_expiry") {
      const cpId = parseInteger(body.client_package_id ?? body.id, 0);
      await assertLocationAccessById(tenantSlug, "client_packages", cpId, sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      try {
        await updateManageClientPackageExpiry(tenantSlug, cpId, String(body.expires_at ?? ""));
      } catch (error) {
        const detailMsg = error instanceof Error ? error.message : "Errore aggiornamento scadenza";
        return Response.json({ ok: false, error: `Errore: ${detailMsg}` }, { status: 400 });
      }
      const detail = await getManageClientPackage(tenantSlug, cpId);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: "modifica", entityType: "client_package", entityId: cpId, label: `Aggiornata scadenza pacchetto cliente #${cpId} (${String(body.expires_at ?? "").trim() || "—"})` });
      return Response.json({ ok: true, source: "packages?action=update_expiry", sourceMode: "database", message: "Scadenza pacchetto aggiornata", detail });
    }

    // Register a manual usage movement (port of usage_add): servizi (sedute con
    // riserve) e prodotti (ritiro/ripristino con stock + documento magazzino).
    if (action === "usage_add") {
      const cpId = parseInteger(body.client_package_id ?? body.id, 0);
      await assertLocationAccessById(tenantSlug, "client_packages", cpId, sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const result = await addManageClientPackageUsage(
        tenantSlug,
        cpId,
        String(body.op ?? ""),
        parseInteger(body.qty, 1),
        parseInteger(body.service_id, 0),
        String(body.note ?? ""),
        session.user.id,
        {
          itemRef: String(body.item_ref ?? ""),
          usedAt: String(body.used_at ?? ""),
          operatorName: session.user.name,
          locationId: locationContext?.currentLocationId ?? 0,
        },
      );
      const detail = await getManageClientPackage(tenantSlug, cpId);
      const usageOp = String(body.op ?? "").trim().toLowerCase();
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: usageOp === "restore" ? "ripristina" : "scala", entityType: "client_package", entityId: cpId, label: `${result.message} — pacchetto cliente #${cpId}` });
      return Response.json({ ok: true, source: "packages?action=usage_add", sourceMode: "database", message: result.message, detail });
    }

    // Salvataggio edit pacchetto cliente (client_edit). client_new è bloccato
    // dal legacy ("La vendita/assegnazione dei pacchetti avviene solo da Pagamenti.").
    if (action === "client_save") {
      await assertLocationAccessById(tenantSlug, "client_packages", parseInteger(body.id ?? body.client_package_id, 0), sessionAllowedLocationIds(session), PKG_SEDE_ERR);
      const result = await saveManageClientPackage(tenantSlug, body);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: "modifica", entityType: "client_package", entityId: result.id, label: `Modificato pacchetto cliente #${result.id} ("${String(body.package_name ?? "").trim() || "senza nome"}")` });
      return Response.json({ ok: true, source: "packages?action=client_save", sourceMode: "database", ...result });
    }

    // Delete a catalog template (port of action=catalog_delete): detach client
    // packages + drop the template's child rows. Gated by packages.catalog.
    if (action === "catalog_delete") {
      if (!canAny(session.user.perms, packageCatalogPerms)) return jsonError("Permesso catalogo pacchetti mancante.", 403);
      await deleteManagePackageCatalog(tenantSlug, parseInteger(body.id, 0));
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pacchetti", action: "elimina", entityType: "package", entityId: parseInteger(body.id, 0), label: `Eliminato pacchetto dal catalogo #${parseInteger(body.id, 0)} (assegnazioni clienti conservate)` });
      return Response.json({ ok: true, source: "packages?action=catalog_delete", sourceMode: "database", catalog: await listManagePackageCatalog(tenantSlug) });
    }

    return jsonError("Azione pacchetti non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore pacchetti.");
  }
}
