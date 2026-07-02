import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  deleteBusinessBrandingImage,
  deleteBusinessLocation,
  getBusinessSettingsContext,
  moveBusinessLocation,
  previewLocationDelete,
  saveBusinessBrandingPosition,
  saveBusinessLocation,
  getBookingSettings,
  saveBookingSettings,
  saveBusinessProfile,
  saveLocationMarketplace,
  uploadBusinessBrandingImage,
} from "@/lib/manage-business-settings";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);
  const url = new URL(request.url);
  // Booking-settings prefill for the Prenotazioni online page (booking.manage).
  if (url.searchParams.get("section") === "booking") {
    if (!canAny(session.user.perms, ["booking.manage", "settings.general"])) return jsonError("Permesso negato.", 403);
    try {
      return Response.json({ ok: true, bookingSettings: await getBookingSettings(tenantSlug) });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Impostazioni non caricate.");
    }
  }
  if (!canAny(session.user.perms, ["settings.general", "settings.location"])) return jsonError("Permesso negato.", 403);

  try {
    return Response.json(await getBusinessSettingsContext(tenantSlug, publicOrigin(request)));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Impostazioni non caricate.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = String(form.get("action") ?? "");
      const kind = normalizeBrandingKind(String(form.get("kind") ?? ""));
      if (!kind) return jsonError("Tipo immagine non valido.", 422);
      if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);

      if (action === "upload_logo" || action === "upload_cover" || action === "branding_upload") {
        const fileKey = kind === "logo" ? "business_logo" : "business_cover";
        const file = form.get(fileKey) ?? form.get("file");
        if (!(file instanceof File)) return jsonError(kind === "logo" ? "Seleziona un file (JPG o PNG) da caricare." : "Seleziona un file immagine da caricare.", 422);
        return Response.json(await uploadBusinessBrandingImage(tenantSlug, kind, file, publicOrigin(request)));
      }

      return jsonError("Azione upload non valida.", 400);
    }

    const body = await parseRequestBody(request);
    const action = body.action ?? "";
    switch (action) {
      case "save_profile_name":
      case "save_profile_activity":
      case "business_profile_save":
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        return Response.json(await saveBusinessProfile(tenantSlug, body, publicOrigin(request)));

      case "save_logo_position":
      case "save_cover_position":
      case "branding_position": {
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        const kind = normalizeBrandingKind(body.kind ?? (action === "save_logo_position" ? "logo" : "cover"));
        if (!kind) return jsonError("Tipo immagine non valido.", 422);
        const x = parseInteger(body[`${kind}_position_x`] ?? body.x, 50);
        const y = parseInteger(body[`${kind}_position_y`] ?? body.y, 50);
        return Response.json(await saveBusinessBrandingPosition(tenantSlug, kind, x, y, publicOrigin(request)));
      }

      case "delete_logo":
      case "delete_cover":
      case "branding_delete": {
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        const kind = normalizeBrandingKind(body.kind ?? (action === "delete_logo" ? "logo" : "cover"));
        if (!kind) return jsonError("Tipo immagine non valido.", 422);
        return Response.json(await deleteBusinessBrandingImage(tenantSlug, kind, publicOrigin(request)));
      }

      // Impostazioni Prenotazioni online (legacy booking.php admin POST):
      // choose-staff step + customer cancel policy on the businesses row.
      case "booking_settings_save":
        if (!canAny(session.user.perms, ["booking.manage", "settings.general"])) return jsonError("Permesso Prenotazioni online richiesto.", 403);
        return Response.json(await saveBookingSettings(tenantSlug, body));

      case "location_save":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await saveBusinessLocation(tenantSlug, body, publicOrigin(request)));

      case "location_move":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await moveBusinessLocation(
          tenantSlug,
          parseInteger(body.id ?? body.location_id, 0),
          body.direction === "up" ? "up" : "down",
          publicOrigin(request),
        ));

      case "location_marketplace_save":
        if (!canAny(session.user.perms, ["settings.location", "settings.general"])) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await saveLocationMarketplace(tenantSlug, body, publicOrigin(request)));

      case "location_delete_preview":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json({ ok: true, deletePreview: await previewLocationDelete(tenantSlug, parseInteger(body.id ?? body.location_id, 0)) });

      case "location_delete":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await deleteBusinessLocation(
          tenantSlug,
          parseInteger(body.id ?? body.location_id, 0),
          body.confirm_text ?? "",
          body.reason ?? "",
          publicOrigin(request),
        ));

      case "marketplace_sync":
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        return Response.json(await getBusinessSettingsContext(tenantSlug, publicOrigin(request)));

      default:
        return jsonError("Azione non valida.", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.");
  }
}

function normalizeBrandingKind(value: string): "logo" | "cover" | null {
  const kind = value.trim().toLowerCase();
  if (kind === "logo" || kind === "cover") return kind;
  return null;
}

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
