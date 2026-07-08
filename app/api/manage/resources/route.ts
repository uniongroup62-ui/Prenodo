import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessById, assertLocationAccessByJunction, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  checkAvailabilityConflicts,
  copyWeekAvailability,
  deleteAvailabilityEvent,
  deleteCabin,
  deleteClosureRange,
  deleteExceptionRange,
  deleteSharedResource,
  deleteStaffMember,
  getManageCabin,
  getManageStaffMember,
  getSharedResource,
  resourceContext,
  type ResourceBlockPopup,
  saveAvailabilityEvent,
  saveBusinessHours,
  saveCabin,
  saveCabinsBulk,
  saveClosure,
  saveException,
  saveSharedResource,
  saveStaffMember,
} from "@/lib/manage-resources";
import { can, canAny, permissionForFeature } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  if (!canAny(activeUser.perms, ["resources.manage", "cabins.manage", "staff.manage", "staff_availability.manage", "hours.manage"])) {
    return jsonError("Permesso negato.", 403);
  }

  const url = new URL(request.url);
  const section = url.searchParams.get("section") ?? "resources";
  if (!can(activeUser.perms, permissionForResourceSection(section))) return jsonError("Permesso negato.", 403);

  // Edit-form prefill: return ONE staff/cabin record for one id. Port of
  // staff.php / cabins.php action=edit. Gated by the same section permission as
  // the matching save (staff.manage / cabins.manage).
  if (url.searchParams.get("action") === "get") {
    const id = parseInteger(url.searchParams.get("id"), 0);
    if (id <= 0) return jsonError("ID mancante.");
    try {
      if (section === "staff") {
        if (!can(activeUser.perms, "staff.manage")) return jsonError("Permesso Operatori richiesto.", 403);
        await assertLocationAccessByJunction(tenantSlug, "staff_locations", "staff_id", id, sessionAllowedLocationIds(session), "Operatore non disponibile per le tue sedi.");
        const staff = await getManageStaffMember(tenantSlug, id);
        if (!staff) return jsonError("Operatore non trovato.", 404);
        return Response.json({ ok: true, source: "resources?section=staff&action=get", sourceMode: "database", staff });
      }
      if (section === "cabins") {
        if (!can(activeUser.perms, "cabins.manage")) return jsonError("Permesso Cabine richiesto.", 403);
        await assertLocationAccessById(tenantSlug, "cabins", id, sessionAllowedLocationIds(session), "Cabina non disponibile per le tue sedi.");
        const cabin = await getManageCabin(tenantSlug, id);
        if (!cabin) return jsonError("Cabina non trovata.", 404);
        return Response.json({ ok: true, source: "resources?section=cabins&action=get", sourceMode: "database", cabin });
      }
      // Prefill Modifica risorsa (resources.php action=edit): per id, anche se
      // non abilitata nella sede corrente; mancante -> 'Risorsa non trovata'.
      if (section === "resources") {
        if (!can(activeUser.perms, "resources.manage")) return jsonError("Permesso Risorse richiesto.", 403);
        await assertLocationAccessByJunction(tenantSlug, "resource_locations", "resource_id", id, sessionAllowedLocationIds(session), "Risorsa non disponibile per le tue sedi.");
        const resource = await getSharedResource(tenantSlug, id);
        if (!resource) return jsonError("Risorsa non trovata", 404);
        return Response.json({ ok: true, source: "resources?section=resources&action=get", sourceMode: "database", resource });
      }
      return jsonError("Sezione non supportata per il get.", 400);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Record non disponibile.", 400);
    }
  }

  try {
    const context = await resourceContext({
      slug: tenantSlug,
      locationId: parseInteger(url.searchParams.get("location_id") ?? url.searchParams.get("locationId"), 0),
      date: url.searchParams.get("date") ?? undefined,
    });
    // hours.php gates il bottone header "Attivita" su Auth::can('settings.location').
    return Response.json({ ok: true, canSettingsLocation: can(activeUser.perms, "settings.location"), ...context });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Risorse non disponibili.", 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const action = String(body.action ?? url.searchParams.get("action") ?? "");

  try {
    // Le guardie qty/delete legacy allegano il payload del popup di blocco
    // (#resourceBlockModal via session flash): propagato nel JSON di errore.
    if (action === "resource_save") {
      if (!can(activeUser.perms, "resources.manage")) return jsonError("Permesso Risorse richiesto.", 403);
      try {
        await assertLocationAccessByJunction(tenantSlug, "resource_locations", "resource_id", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Risorsa non disponibile per le tue sedi.");
        const resource = await saveSharedResource(tenantSlug, body);
        return Response.json({ ok: true, resource });
      } catch (error) {
        const popup = error instanceof Error ? (error as Error & { popup?: ResourceBlockPopup }).popup : undefined;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore risorse.", ...(popup ? { popup } : {}) }, { status: 400 });
      }
    }

    if (action === "resource_delete") {
      if (!can(activeUser.perms, "resources.manage")) return jsonError("Permesso Risorse richiesto.", 403);
      try {
        await assertLocationAccessByJunction(tenantSlug, "resource_locations", "resource_id", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Risorsa non disponibile per le tue sedi.");
        await deleteSharedResource(tenantSlug, parseInteger(body.id, 0));
        return Response.json({ ok: true });
      } catch (error) {
        const popup = error instanceof Error ? (error as Error & { popup?: ResourceBlockPopup }).popup : undefined;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore risorse.", ...(popup ? { popup } : {}) }, { status: 400 });
      }
    }

    if (action === "cabin_save") {
      if (!can(activeUser.perms, "cabins.manage")) return jsonError("Permesso Cabine richiesto.", 403);
      await assertLocationAccessById(tenantSlug, "cabins", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Cabina non disponibile per le tue sedi.");
      const cabin = await saveCabin(tenantSlug, body);
      return Response.json({ ok: true, cabin });
    }

    // Bulk cabins save (port of cabins.php #cabinsForm POST): count + names +
    // ids for the active location. Returns ok:false + blockingServices when a
    // removed cabin is still linked to a service / future appointment.
    if (action === "cabins_save") {
      if (!can(activeUser.perms, "cabins.manage")) return jsonError("Permesso Cabine richiesto.", 403);
      const result = await saveCabinsBulk(tenantSlug, body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    // Eliminazione singola cabina (cabins.php action=delete): flash 'Cabina
    // eliminata' / err + popup di blocco legacy.
    if (action === "cabin_delete") {
      if (!can(activeUser.perms, "cabins.manage")) return jsonError("Permesso Cabine richiesto.", 403);
      try {
        await assertLocationAccessById(tenantSlug, "cabins", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Cabina non disponibile per le tue sedi.");
        await deleteCabin(tenantSlug, parseInteger(body.id, 0), parseInteger(body.location_id ?? body.locationId, 0));
        return Response.json({ ok: true, msg: "Cabina eliminata" });
      } catch (error) {
        const popup = error instanceof Error ? (error as Error & { popup?: unknown }).popup : undefined;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore cabine.", ...(popup ? { popup } : {}) }, { status: 400 });
      }
    }

    // Save/delete operatore: gli errori portano flashKind ('msg' = alert VERDE
    // come i redirect &msg= del legacy) ed eventuale popup di blocco servizi.
    if (action === "staff_save") {
      if (!can(activeUser.perms, "staff.manage")) return jsonError("Permesso Operatori richiesto.", 403);
      try {
        await assertLocationAccessByJunction(tenantSlug, "staff_locations", "staff_id", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Operatore non disponibile per le tue sedi.");
        const staff = await saveStaffMember(tenantSlug, body, { actorIsAdmin: String(activeUser.role ?? "").toLowerCase() === "admin" });
        return Response.json({ ok: true, msg: "Operatore salvato", staff });
      } catch (error) {
        const flashKind = error instanceof Error ? (error as Error & { flashKind?: string }).flashKind : undefined;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore operatori.", ...(flashKind ? { flashKind } : {}) }, { status: 400 });
      }
    }

    if (action === "staff_delete") {
      if (!can(activeUser.perms, "staff.manage")) return jsonError("Permesso Operatori richiesto.", 403);
      try {
        await assertLocationAccessByJunction(tenantSlug, "staff_locations", "staff_id", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "Operatore non disponibile per le tue sedi.");
        await deleteStaffMember(tenantSlug, parseInteger(body.id, 0), { actorIsAdmin: String(activeUser.role ?? "").toLowerCase() === "admin" });
        return Response.json({ ok: true, msg: "Operatore eliminato" });
      } catch (error) {
        const err = error as Error & { popup?: unknown; flashKind?: string };
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore operatori.", ...(err.popup ? { popup: err.popup } : {}), ...(err.flashKind ? { flashKind: err.flashKind } : {}) }, { status: 400 });
      }
    }

    if (action === "hours_save") {
      if (!can(activeUser.perms, "hours.manage")) return jsonError("Permesso Orari richiesto.", 403);
      const hours = await saveBusinessHours(tenantSlug, body);
      return Response.json({ ok: true, hours });
    }

    if (action === "closure_save") {
      if (!can(activeUser.perms, "hours.manage")) return jsonError("Permesso Orari richiesto.", 403);
      const closures = await saveClosure(tenantSlug, body);
      return Response.json({ ok: true, closures });
    }

    if (action === "closure_delete_range") {
      if (!can(activeUser.perms, "hours.manage")) return jsonError("Permesso Orari richiesto.", 403);
      const closures = await deleteClosureRange(tenantSlug, body);
      return Response.json({ ok: true, closures });
    }

    if (action === "exception_save") {
      if (!can(activeUser.perms, "hours.manage")) return jsonError("Permesso Orari richiesto.", 403);
      const exceptions = await saveException(tenantSlug, body);
      return Response.json({ ok: true, exceptions });
    }

    if (action === "exception_delete_range") {
      if (!can(activeUser.perms, "hours.manage")) return jsonError("Permesso Orari richiesto.", 403);
      const exceptions = await deleteExceptionRange(tenantSlug, body);
      return Response.json({ ok: true, exceptions });
    }

    // Duplica settimana (staff_availability.php do=copy_week).
    if (action === "availability_copy_week") {
      if (!can(activeUser.perms, "staff_availability.manage")) return jsonError("Permesso Disponibilita richiesto.", 403);
      const result = await copyWeekAvailability(tenantSlug, body);
      return Response.json({ ok: true, ...result });
    }

    // Avviso conflitti appuntamenti (do=check_appt_conflicts) — non bloccante.
    if (action === "availability_check_conflicts") {
      if (!can(activeUser.perms, "staff_availability.manage")) return jsonError("Permesso Disponibilita richiesto.", 403);
      const conflicts = await checkAvailabilityConflicts(tenantSlug, body);
      return Response.json({ ok: true, conflicts });
    }

    if (action === "availability_save") {
      if (!can(activeUser.perms, "staff_availability.manage")) return jsonError("Permesso Disponibilita richiesto.", 403);
      const availability = await saveAvailabilityEvent(tenantSlug, body);
      return Response.json({ ok: true, availability });
    }

    if (action === "availability_delete") {
      if (!can(activeUser.perms, "staff_availability.manage")) return jsonError("Permesso Disponibilita richiesto.", 403);
      const availability = await deleteAvailabilityEvent(tenantSlug, body);
      return Response.json({ ok: true, availability });
    }

    return jsonError("Azione risorse non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore risorse.", 400);
  }
}

function permissionForResourceSection(section: string): string {
  if (section === "resources" || section === "hub") return "resources.manage";
  return permissionForFeature(section);
}
