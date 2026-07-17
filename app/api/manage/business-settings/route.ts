import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
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
  getBusinessName,
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
  // Booking-settings prefill (booking.php riga 3: requirePerm('booking.manage')
  // — settings.general NON lo copre: la gerarchia permessi sale solo ai padri).
  if (url.searchParams.get("section") === "booking") {
    if (!can(session.user.perms, "booking.manage")) return jsonError("Permesso Prenotazioni online richiesto.", 403);
    try {
      // businessName per la card 'Link prenotazione online' (setting_get('name')
      // legacy, visibile a chiunque abbia booking.manage).
      return Response.json({ ok: true, bookingSettings: await getBookingSettings(tenantSlug), businessName: await getBusinessName(tenantSlug) });
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
        // 'Sede non valida per la gallery.' arriva NUDO (locations.php 381),
        // gli altri errori col wrapper AJAX 'Errore upload gallery sede: '.
        if (locationId <= 0) return jsonError("Sede non valida per la gallery.", 422);
        try {
          const files = form.getAll("location_gallery_images").filter((f): f is File => f instanceof File);
          return Response.json(await uploadLocationGalleryImages(tenantSlug, locationId, files, publicOrigin(request)));
        } catch (error) {
          return jsonError(`Errore upload gallery sede: ${error instanceof Error ? error.message : "Operazione non riuscita."}`);
        }
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
          const out = await saveBusinessProfile(tenantSlug, body, publicOrigin(request));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: "modifica", entityType: "business", entityId: 0, label: "Salvato profilo attività" });
          return Response.json(out);
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
          const out = await deleteBusinessBrandingImage(tenantSlug, kind, publicOrigin(request));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: "elimina", entityType: "business", entityId: 0, label: `Rimosso ${kind === "logo" ? "logo" : "copertina"} attività` });
          return Response.json(out);
        } catch (error) {
          const wrapped = `Errore rimozione ${kind === "logo" ? "logo" : "copertina"}: ${error instanceof Error ? error.message : "Operazione non riuscita."}`;
          return Response.json({ ok: false, error: wrapped, errors: [wrapped] }, { status: 400 });
        }
      }

      // Impostazioni Prenotazioni online (legacy booking.php admin POST):
      // choose-staff step + customer cancel policy on the businesses row.
      case "booking_settings_save":
        // requirePerm('booking.manage') legacy: settings.general non basta.
        if (!can(session.user.perms, "booking.manage")) return jsonError("Permesso Prenotazioni online richiesto.", 403);
        // Wrapper errore verbatim di booking.php 2926.
        try {
          const out = await saveBookingSettings(tenantSlug, body);
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: "modifica", entityType: "business", entityId: 0, label: "Salvate impostazioni Prenotazioni online" });
          return Response.json(out);
        } catch (error) {
          const inner = error instanceof Error ? error.message : "Operazione non riuscita.";
          return jsonError(`Errore salvataggio impostazioni booking: ${inner} (verifica schema o permessi ALTER TABLE)`);
        }

      case "location_save":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        // Come locations.php 297-353: le validazioni (sede_location_validation
        // _error + gate piano) escono NUDE, gli errori imprevisti col wrapper
        // 'Errore salvataggio sede: '.
        try {
          const isLocEdit = parseInteger(body.id ?? body.location_id, 0) > 0;
          const out = await saveBusinessLocation(tenantSlug, body, publicOrigin(request));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: isLocEdit ? "modifica" : "crea", entityType: "location", entityId: parseInteger(body.id ?? body.location_id, 0), label: `${isLocEdit ? "Modificata" : "Creata"} sede "${String(body.name ?? "").trim() || "senza nome"}"` });
          return Response.json(out);
        } catch (error) {
          const inner = error instanceof Error ? error.message : "Operazione non riuscita.";
          const isValidation = inner === "Inserisci il nome della sede."
            || inner === "Email non valida."
            || inner.endsWith(" non valido.")
            || inner === "Esiste gia una sede con questo nome."
            || inner === "Funzione non disponibile per il tuo account";
          return jsonError(isValidation ? inner : `Errore salvataggio sede: ${inner}`);
        }

      // Azione MORTA del legacy (locations.php 356-358): risponde sempre con
      // l'errore fisso — il toggle attiva/disattiva non esiste più.
      case "location_disable":
      case "location_enable":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return jsonError("La funzione Attiva/Disattiva sede non e piu disponibile. Usa Abilita in prenotazioni online oppure Elimina sede.");

      case "location_move": {
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        // Validazione legacy nuda + wrapper 'Errore ordinamento sedi: '.
        const moveId = parseInteger(body.id ?? body.location_id, 0);
        const moveDirection = String(body.direction ?? "");
        if (moveId <= 0 || (moveDirection !== "up" && moveDirection !== "down")) return jsonError("Spostamento sede non valido.", 422);
        try {
          return Response.json(await moveBusinessLocation(tenantSlug, moveId, moveDirection, publicOrigin(request)));
        } catch (error) {
          return jsonError(`Errore ordinamento sedi: ${error instanceof Error ? error.message : "Operazione non riuscita."}`);
        }
      }

      case "location_marketplace_save":
        if (!canAny(session.user.perms, ["settings.location", "settings.general"])) return jsonError("Permesso Sedi richiesto.", 403);
        // Wrapper legacy: TUTTI gli errori del try (inclusa la validazione
        // categorie) escono come 'Errore salvataggio marketplace sede: ...';
        // solo 'Sede non valida per il marketplace.' arriva nudo (427).
        try {
          const out = await saveLocationMarketplace(tenantSlug, body, publicOrigin(request));
          void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: "modifica", entityType: "location", entityId: parseInteger(body.location_id ?? body.id, 0), label: `Salvato marketplace sede #${parseInteger(body.location_id ?? body.id, 0)}` });
          return Response.json(out);
        } catch (error) {
          const inner = error instanceof Error ? error.message : "Operazione non riuscita.";
          if (inner === "Sede non valida per il marketplace.") return jsonError(inner, 422);
          return jsonError(`Errore salvataggio marketplace sede: ${inner}`);
        }

      case "location_delete_preview":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        return Response.json({ ok: true, deletePreview: await previewLocationDelete(tenantSlug, parseInteger(body.id ?? body.location_id, 0)) });

      case "location_delete":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        {
          const delOut = await deleteBusinessLocation(
            tenantSlug,
            parseInteger(body.id ?? body.location_id, 0),
            body.confirm_text ?? "",
            body.reason ?? "",
            publicOrigin(request),
          );
          if ((delOut as { ok?: boolean }).ok !== false) {
            void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "impostazioni", action: "elimina", entityType: "location", entityId: parseInteger(body.id ?? body.location_id, 0), label: `Eliminata sede #${parseInteger(body.id ?? body.location_id, 0)}` });
          }
          return Response.json(delOut);
        }

      case "location_gallery_delete":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        try {
          return Response.json(await deleteLocationGalleryImage(tenantSlug, parseInteger(body.location_id, 0), parseInteger(body.gallery_image_id ?? body.id, 0), publicOrigin(request)));
        } catch (error) {
          return jsonError(`Errore rimozione foto gallery sede: ${error instanceof Error ? error.message : "Operazione non riuscita."}`);
        }

      case "location_gallery_move":
        if (!can(session.user.perms, "settings.location")) return jsonError("Permesso Sedi richiesto.", 403);
        try {
          return Response.json(await moveLocationGalleryImage(tenantSlug, parseInteger(body.location_id, 0), parseInteger(body.gallery_image_id ?? body.id, 0), body.direction === "up" ? "up" : "down", publicOrigin(request)));
        } catch (error) {
          return jsonError(`Errore ordinamento gallery sede: ${error instanceof Error ? error.message : "Operazione non riuscita."}`);
        }

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
