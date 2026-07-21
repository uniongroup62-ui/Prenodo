import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession, setManageSessionCookie } from "@/lib/manage-auth";
import { filterLocationsForManageSession, getManageLocation, getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);

  // Edit-form prefill: return ONE location's editable fields for one id. Port of
  // locations.php locationModal data-location-edit prefill. Gated by
  // settings.location like the location_save action (handled by the
  // business-settings route).
  const url = new URL(request.url);
  if (url.searchParams.get("action") === "get") {
    const session = await currentManageSession(tenantSlug);
    if (!session) return jsonError("Sessione gestionale scaduta.", 401);
    if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
    const locationId = parseInteger(url.searchParams.get("id"), 0);
    if (locationId <= 0) return jsonError("ID sede mancante.");
    const location = await getManageLocation(tenantSlug, locationId);
    if (!location) return jsonError("Sede non trovata.", 404);
    return Response.json({ ok: true, source: "locations?action=get", sourceMode: "database", location });
  }

  // Gate sessione (audit giro 3): il ramo lista era l'unico senza — un probe
  // ANONIMO leggeva l'anagrafica sedi del tenant (nomi, indirizzi, telefoni).
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  const locationContext = await getManageLocationContext(tenantSlug);

  return Response.json({
    ok: true,
    sourceMode: locationContext.sourceMode,
    locations: locationContext.locations,
    currentLocationId: locationContext.currentLocationId,
    needsLocationSelection: locationContext.needsLocationSelection,
  });
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  const body = await parseRequestBody(request);
  const locationId = parseInteger(body.location_id, 0);
  const locationContext = await getManageLocationContext(tenantSlug);
  const sourceMode = locationContext.sourceMode;
  const locations = filterLocationsForManageSession(locationContext.allLocations, session.user.locationIds, session.user.role);
  const selected = locations.find((location) => location.id === locationId);
  if (!selected) return jsonError("Sede non disponibile per questo utente.", 403);

  const nextSession = {
    ...session,
    user: {
      ...session.user,
      currentLocationId: selected.id,
      needsLocationSelection: false,
    },
    issuedAt: Date.now(),
  };
  await setManageSessionCookie(nextSession);

  return Response.json({
    ok: true,
    source: "location?action=select",
    sourceMode,
    location: selected,
    locations,
    currentLocationId: selected.id,
    needsLocationSelection: false,
  });
}
