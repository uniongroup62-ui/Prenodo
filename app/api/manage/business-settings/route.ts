import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  deleteBusinessBrandingImage,
  deleteBusinessLocation,
  deleteLocationGalleryImage,
  getBusinessSettingsContext,
  moveBusinessLocation,
  moveLocationGalleryImage,
  previewLocationDelete,
  saveBusinessBrandingPosition,
  saveBusinessLocation,
  getBookingSettings,
  saveBookingSettings,
  saveBusinessProfile,
  saveLocationMarketplace,
  uploadBusinessBrandingImage,
  uploadLocationGalleryImages,
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

      // Gallery sede (locations.php location_gallery_upload): upload multiplo
      // JPG/PNG/WEBP max 5MB — permesso Sedi come tutta la pagina.
      if (action === "location_gallery_upload") {
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        const locationId = parseInteger(String(form.get("location_id") ?? "0"), 0);
        const files = form.getAll("location_gallery_images").filter((f): f is File => f instanceof File);
        return Response.json(await uploadLocationGalleryImages(tenantSlug, locationId, files, publicOrigin(request)));
      }

      const kind = normalizeBrandingKind(String(form.get("kind") ?? ""));
      if (!kind) return jsonError("Tipo immagine non valido.", 422);
      if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);

      if (action === "upload_logo" || action === "upload_cover" || action === "branding_upload") {
        // Errori impacchettati come l'AJAX legacy: {ok:false, errors:['Errore
        // upload logo: ...']} — il client mostra errors.join(' ').
        try {
          const fileKey = kind === "logo" ? "business_logo" : "business_cover";
          const file = form.get(fileKey) ?? form.get("file");
          // File mancante gestito nella lib DOPO la guardia "Rimuovi ... attuale"
          // (ordine legacy business_profile.php 125-132).
          return Response.json(await uploadBusinessBrandingImage(tenantSlug, kind, file instanceof File ? file : null, publicOrigin(request)));
        } catch (error) {
          const wrapped = `Errore upload ${kind === "logo" ? "logo" : "copertina"}: ${error instanceof Error ? error.message : "Upload non valido"}`;
          return Response.json({ ok: false, error: wrapped, errors: [wrapped] }, { status: 400 });
        }
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
        // Wrapper errore della pagina legacy (business_profile.php 118).
        try {
          return Response.json(await saveBusinessProfile(tenantSlug, body, publicOrigin(request)));
        } catch (error) {
          const inner = error instanceof Error ? error.message : "Operazione non riuscita.";
          return jsonError(`Errore salvataggio profilo attività: ${inner} (se persiste, controlla che lo schema business sia aggiornato e che il DB possa eseguire ALTER/UPDATE)`);
        }

      case "save_logo_position":
      case "save_cover_position":
      case "branding_position": {
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        const kind = normalizeBrandingKind(body.kind ?? (action === "save_logo_position" ? "logo" : "cover"));
        if (!kind) return jsonError("Tipo immagine non valido.", 422);
        const x = parseInteger(body[`${kind}_position_x`] ?? body.x, 50);
        const y = parseInteger(body[`${kind}_position_y`] ?? body.y, 50);
        try {
          return Response.json(await saveBusinessBrandingPosition(tenantSlug, kind, x, y, publicOrigin(request)));
        } catch (error) {
          const inner = error instanceof Error ? error.message : "Operazione non riuscita.";
          return jsonError(`Errore salvataggio posizione ${kind === "logo" ? "logo" : "copertina"}: ${inner}`);
        }
      }

      case "delete_logo":
      case "delete_cover":
      case "branding_delete": {
        if (!can(session.user.perms, "settings.general")) return jsonError("Permesso Profilo attivita richiesto.", 403);
        const kind = normalizeBrandingKind(body.kind ?? (action === "delete_logo" ? "logo" : "cover"));
        if (!kind) return jsonError("Tipo immagine non valido.", 422);
        // Errori come l'AJAX legacy: {errors:['Errore rimozione logo: ...']}.
        try {
          return Response.json(await deleteBusinessBrandingImage(tenantSlug, kind, publicOrigin(request)));
        } catch (error) {
          const wrapped = `Errore rimozione ${kind === "logo" ? "logo" : "copertina"}: ${error instanceof Error ? error.message : "Operazione non riuscita."}`;
          return Response.json({ ok: false, error: wrapped, errors: [wrapped] }, { status: 400 });
        }
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

      case "location_gallery_delete":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await deleteLocationGalleryImage(tenantSlug, parseInteger(body.location_id, 0), parseInteger(body.gallery_image_id ?? body.id, 0), publicOrigin(request)));

      case "location_gallery_move":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json(await moveLocationGalleryImage(tenantSlug, parseInteger(body.location_id, 0), parseInteger(body.gallery_image_id ?? body.id, 0), body.direction === "up" ? "up" : "down", publicOrigin(request)));

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
