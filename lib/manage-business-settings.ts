import "server-only";

import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "@/lib/tenant-db";
import { emptyToNull, parseInteger } from "@/lib/api-utils";
import {
  STORAGE_NOT_CONFIGURED_ERROR,
  deletePublicObject,
  putPublicObject,
  storageConfigured,
  storageKeyFromPublicUrl,
  tenantStorageKey,
} from "@/lib/storage";
import {
  columnExists,
  dbExecute,
  dbQuery,
  quoteIdentifier,
  tableExists,
  tenantDelete,
  tenantIdForSlug,
  tenantInsert,
  tenantSelect,
  tenantTable,
  tenantUpdate,
} from "@/lib/tenant-db";

type TenantTarget = Awaited<ReturnType<typeof tenantTable>>;

const legalLocationFields = [
  "legal_company_name",
  "legal_vat_number",
  "legal_tax_code",
  "legal_sdi",
  "legal_pec",
  "legal_address",
  "legal_cap",
  "legal_city",
  "legal_province",
  "legal_region",
  "legal_phone",
  "legal_email",
  "legal_website",
] as const;

const historyBlockerTables = [
  "sales",
  "quotes",
  "recharges",
  "credit_adjustments",
  "transactions",
  "events",
  "client_packages",
  "client_prepaid_services",
  "client_package_usages",
  "giftcards",
  "giftcard_transactions",
  "giftbox_instances",
  "giftbox_redemptions",
  "gift_instances",
  "gift_transactions",
  "promotion_redemptions",
  "stock_docs",
  "stock_moves",
  "costs",
  "staff_commission_payments",
] as const;

const locationCleanupTables = [
  "business_hours",
  "business_hours_exceptions",
  "closures",
  "cabins",
  "staff_availability",
  "staff_timeoff",
  "user_locations",
  "product_stocks",
  "location_gallery_images",
  "service_locations",
  "staff_locations",
  "package_locations",
  "coupon_locations",
  "gift_locations",
  "promotion_locations",
  "supplier_locations",
  "resource_locations",
] as const;

const imageMimeToExt: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function getBusinessSettingsContext(slug: string, publicOrigin = "") {
  await ensureMarketplaceDirectoryTables();
  const tenant = await getTenant(slug);
  const business = await getBusinessProfile(slug);
  const locations = await listBusinessLocations(slug, publicOrigin);
  const activityCategories = await listMarketplaceActivityCategories();
  const mappings = await listLocationActivityMappings(slug);
  const centralProfile = tenant ? await getCentralDirectoryProfile(tenant.id) : null;
  const deletePreview = locations.length ? await previewLocationDelete(slug, locations[0].id) : null;

  return {
    ok: true,
    tenant,
    featureFlags: {
      bookingPublicAllowed: Boolean(Number(tenant?.booking_public_allowed ?? 1)),
      marketplacePublicAllowed: Boolean(Number(tenant?.marketplace_public_allowed ?? 1)),
      unavailableMessage: "Funzione non disponibile nel piano attuale.",
    },
    business,
    branding: {
      logoUrl: business.logoUrl,
      coverUrl: business.coverUrl,
      logoPosition: { x: business.logoPositionX, y: business.logoPositionY },
      coverPosition: { x: business.coverPositionX, y: business.coverPositionY },
    },
    locations,
    marketplace: {
      profile: centralProfile,
      activityCategories,
      mappings,
      visibleLocations: locations.filter((location) => location.isActive && location.marketplaceEnabled),
      publicUrl: tenant ? `${publicOrigin || ""}/attivita/${encodeURIComponent(tenant.slug)}` : "",
    },
    deletePreview,
  };
}

// Impostazioni Prenotazioni online (port of the legacy booking.php admin POST
// ~:2893): booking_choose_staff_enabled + the customer cancel policy, saved on
// the businesses row with the legacy clamps (>=0, hours<=8760 / days<=365).
export async function saveBookingSettings(slug: string, input: Record<string, unknown>) {
  const truthy = (v: unknown) => ["1", "true", "on", "yes"].includes(String(v ?? "").trim().toLowerCase());
  const chooseStaff = truthy(input.booking_choose_staff_enabled) ? 1 : 0;
  const cancelEnabled = truthy(input.booking_customer_cancel_enabled) ? 1 : 0;
  let cancelValue = Math.trunc(Number(input.booking_customer_cancel_before_value ?? 0)) || 0;
  if (cancelValue < 0) cancelValue = 0;
  let cancelUnit = String(input.booking_customer_cancel_before_unit ?? "hours").trim().toLowerCase();
  if (cancelUnit !== "hours" && cancelUnit !== "days") cancelUnit = "hours";
  if (cancelUnit === "days" && cancelValue > 365) cancelValue = 365;
  if (cancelUnit === "hours" && cancelValue > 8760) cancelValue = 8760;

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "id", orderBy: "id ASC", limit: 1 });
  const businessId = Number(rows[0]?.id ?? 0);
  if (businessId <= 0) throw new Error("Business non trovato");
  await tenantUpdate({
    slug,
    table: "businesses",
    id: businessId,
    values: {
      booking_choose_staff_enabled: chooseStaff,
      booking_customer_cancel_enabled: cancelEnabled,
      booking_customer_cancel_before_value: cancelValue,
      booking_customer_cancel_before_unit: cancelUnit,
    },
  });
  return {
    ok: true as const,
    message: "Impostazioni booking salvate",
    settings: {
      booking_choose_staff_enabled: chooseStaff === 1,
      booking_customer_cancel_enabled: cancelEnabled === 1,
      booking_customer_cancel_before_value: cancelValue,
      booking_customer_cancel_before_unit: cancelUnit,
    },
  };
}

// Current booking settings for the settings form prefill.
export async function getBookingSettings(slug: string) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "booking_choose_staff_enabled, booking_customer_cancel_enabled, booking_customer_cancel_before_value, booking_customer_cancel_before_unit",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const row = rows[0];
  let unit = String(row?.booking_customer_cancel_before_unit ?? "hours").trim().toLowerCase();
  if (unit !== "hours" && unit !== "days") unit = "hours";
  return {
    booking_choose_staff_enabled: Number(row?.booking_choose_staff_enabled ?? 0) === 1,
    booking_customer_cancel_enabled: Number(row?.booking_customer_cancel_enabled ?? 0) === 1,
    booking_customer_cancel_before_value: Math.max(0, Math.trunc(Number(row?.booking_customer_cancel_before_value ?? 0)) || 0),
    booking_customer_cancel_before_unit: unit,
  };
}

export async function saveBusinessProfile(slug: string, input: Record<string, string>, publicOrigin = "") {
  const name = clean(input.business_name ?? input.name ?? "", 190);
  const aboutText = (input.booking_about_text ?? input.aboutText ?? "").trim();
  if (!name) throw new Error("Inserisci il nome attivita.");
  if (stringLength(name) > 190) throw new Error("Il nome attivita puo contenere al massimo 190 caratteri.");
  if (stringLength(aboutText) > 3000) throw new Error("Il testo Chi siamo puo contenere al massimo 3000 caratteri.");

  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato.");

  await tenantUpdate({
    slug,
    table: "businesses",
    id: Number(business.id ?? 0),
    values: {
      name,
      booking_about_text: emptyToNull(aboutText),
    },
  });
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function saveBusinessBrandingPosition(slug: string, kind: "logo" | "cover", x: number, y: number, publicOrigin = "") {
  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato.");
  const prefix = kind === "logo" ? "logo" : "cover";
  await tenantUpdate({
    slug,
    table: "businesses",
    id: Number(business.id ?? 0),
    values: {
      [`${prefix}_position_x`]: clampPosition(x),
      [`${prefix}_position_y`]: clampPosition(y),
    },
  });
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function uploadBusinessBrandingImage(slug: string, kind: "logo" | "cover", file: File, publicOrigin = "") {
  if (!file || file.size <= 0) throw new Error(kind === "logo" ? "Seleziona un file (JPG o PNG) da caricare." : "Seleziona un file immagine da caricare.");
  if (file.size > 5 * 1024 * 1024) throw new Error(kind === "logo" ? "Logo troppo grande (max 5 MB)." : "Immagine di copertina troppo grande (max 5 MB).");
  if (kind === "logo" && !["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Formato non valido: carica un file JPG o PNG.");
  }
  if (kind === "cover" && !imageMimeToExt[file.type]) throw new Error("Formato non valido.");

  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato.");
  const currentPath = clean(String(kind === "logo" ? business.logo_path ?? "" : business.cover_path ?? ""), 255);
  if (currentPath) {
    throw new Error(kind === "logo" ? "Rimuovi il logo attuale prima di caricarne uno nuovo." : "Rimuovi la copertina attuale prima di caricarne una nuova.");
  }

  // Cloudflare R2 PUBBLICO (come foto staff / immagini prodotto): su Amplify il
  // filesystem è effimero, quindi il branding vive su R2 e nel DB si salva
  // l'URL pubblico completo (publicAssetUrl/withOrigin fanno pass-through degli
  // URL assoluti). I vecchi path /uploads/... restano leggibili finché non
  // vengono sostituiti.
  if (!storageConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const ext = imageMimeToExt[file.type] ?? "jpg";
  const target = await tenantTable(slug, "businesses");
  const key = tenantStorageKey(
    Number(target.tenantId ?? 0),
    "branding",
    kind === "logo" ? `logo-${Number(business.id ?? 1)}-${Date.now()}.${ext}` : `cover-${Date.now()}.${ext}`,
  );
  const publicPath = await putPublicObject(key, new Uint8Array(await file.arrayBuffer()), file.type);

  const values: Record<string, unknown> = kind === "logo"
    ? { logo_path: publicPath, logo_position_x: 50, logo_position_y: 50 }
    : { cover_path: publicPath, cover_position_x: 50, cover_position_y: 50 };
  if (kind === "logo") {
    if (await columnExists(target.name, "logo_blob")) values.logo_blob = null;
    if (await columnExists(target.name, "logo_mime")) values.logo_mime = null;
    if (await columnExists(target.name, "logo_updated_at")) values.logo_updated_at = null;
  }

  await tenantUpdate({ slug, table: "businesses", id: Number(business.id ?? 0), values });
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function deleteBusinessBrandingImage(slug: string, kind: "logo" | "cover", publicOrigin = "") {
  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato.");
  const currentPath = String(kind === "logo" ? business.logo_path ?? "" : business.cover_path ?? "");
  // Nuovi asset su R2 (URL assoluto) -> delete dell'oggetto; path legacy
  // /uploads/... -> pulizia filesystem come prima.
  const r2Key = storageKeyFromPublicUrl(currentPath);
  if (r2Key) {
    await deletePublicObject(r2Key).catch(() => undefined);
  } else {
    await deletePublicUpload(currentPath);
    await removeDeterministicBusinessImageFiles(slug, Number(business.id ?? 1), kind);
  }
  const values: Record<string, unknown> = kind === "logo" ? { logo_path: null } : { cover_path: null };
  if (kind === "logo") {
    const target = await tenantTable(slug, "businesses");
    if (await columnExists(target.name, "logo_blob")) values.logo_blob = null;
    if (await columnExists(target.name, "logo_mime")) values.logo_mime = null;
    if (await columnExists(target.name, "logo_updated_at")) values.logo_updated_at = null;
  }
  await tenantUpdate({ slug, table: "businesses", id: Number(business.id ?? 0), values });
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function saveBusinessLocation(slug: string, input: Record<string, string>, publicOrigin = "") {
  const tenant = await getTenant(slug);
  const bookingPublicAllowed = Boolean(Number(tenant?.booking_public_allowed ?? 1));
  const target = await tenantTable(slug, "locations");
  const id = parseInteger(input.id, 0);
  const data = normalizeLocationPayload(input);

  if (!bookingPublicAllowed && data.booking_enabled === 1) throw new Error("Funzione non disponibile nel piano attuale.");
  if (!bookingPublicAllowed) {
    data.booking_enabled = id > 0 ? await currentLocationBookingEnabled(slug, id) : 0;
  }

  await validateLocationPayload(slug, data, id);

  if (id > 0) {
    const values = await filterExistingColumns(target.name, {
      name: data.name,
      address: emptyToNull(String(data.address ?? "")),
      is_active: 1,
      phone: emptyToNull(String(data.phone ?? "")),
      email: emptyToNull(String(data.email ?? "")),
      whatsapp: emptyToNull(String(data.whatsapp ?? "")),
      facebook_url: emptyToNull(String(data.facebook_url ?? "")),
      instagram_url: emptyToNull(String(data.instagram_url ?? "")),
      tiktok_url: emptyToNull(String(data.tiktok_url ?? "")),
      booking_enabled: data.booking_enabled,
      ...legalFieldValues(data),
    });
    await tenantUpdate({ slug, table: "locations", id, values });
  } else {
    const values = await filterExistingColumns(target.name, {
      name: data.name,
      address: emptyToNull(String(data.address ?? "")),
      is_active: 1,
      phone: emptyToNull(String(data.phone ?? "")),
      email: emptyToNull(String(data.email ?? "")),
      whatsapp: emptyToNull(String(data.whatsapp ?? "")),
      facebook_url: emptyToNull(String(data.facebook_url ?? "")),
      instagram_url: emptyToNull(String(data.instagram_url ?? "")),
      tiktok_url: emptyToNull(String(data.tiktok_url ?? "")),
      booking_enabled: data.booking_enabled,
      marketplace_enabled: 0,
      sort_order: await nextLocationSortOrder(slug),
      ...legalFieldValues(data),
    });
    await tenantInsert(target, values);
  }

  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function moveBusinessLocation(slug: string, locationId: number, direction: "up" | "down", publicOrigin = "") {
  const target = await tenantTable(slug, "locations");
  if (!await columnExists(target.name, "sort_order")) throw new Error("Campo sort_order non disponibile.");
  const rows = await normalizeLocationOrder(slug);
  const index = rows.findIndex((row) => Number(row.id ?? 0) === locationId);
  if (index < 0) throw new Error("Sede non trovata.");
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= rows.length) return getBusinessSettingsContext(slug, publicOrigin);
  await tenantUpdate({ slug, table: "locations", id: Number(rows[index].id), values: { sort_order: Number(rows[targetIndex].sort_order ?? 0) } });
  await tenantUpdate({ slug, table: "locations", id: Number(rows[targetIndex].id), values: { sort_order: Number(rows[index].sort_order ?? 0) } });
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function saveLocationMarketplace(slug: string, input: Record<string, string>, publicOrigin = "") {
  const tenant = await getTenant(slug);
  const marketplacePublicAllowed = Boolean(Number(tenant?.marketplace_public_allowed ?? 1));
  const locationId = parseInteger(input.location_id ?? input.id, 0);
  if (locationId <= 0) throw new Error("Sede non valida per il marketplace.");
  const location = await getLocationById(slug, locationId);
  if (!location) throw new Error("Sede non trovata.");

  let enabled = truthy(input.marketplace_enabled) ? 1 : 0;
  if (!marketplacePublicAllowed) {
    if (enabled === 1) throw new Error("Funzione non disponibile nel piano attuale.");
    enabled = Number(location.marketplace_enabled ?? 0) || 0;
  }

  const categoryIds = parseIdList(input.activity_category_ids ?? input.category_ids);
  const orderedCategoryIds = orderSelectedIds(categoryIds, parseIdList(input.activity_category_order));
  const primaryCategoryId = parseInteger(input.primary_activity_category_id, 0);
  if (marketplacePublicAllowed && enabled === 1 && orderedCategoryIds.length === 0) {
    throw new Error("Seleziona almeno una categoria attivita per rendere visibile la sede.");
  }

  await tenantUpdate({ slug, table: "locations", id: locationId, values: { marketplace_enabled: enabled } });
  await saveLocationActivityCategories(slug, locationId, orderedCategoryIds, primaryCategoryId);
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

// GALLERY SEDE (Helpers.php ~11642-11903 + locations.php location_gallery_*):
// upload multiplo JPG/PNG/WEBP max 5MB in /uploads/tenants/<slug>/branding/
// locations/<id>/gallery, righe location_gallery_images con sort_order a passo
// 10; delete con rimozione file + ricompattazione; move = swap col vicino.
// (Il resize GD 1600x1200/JPEG q84 del legacy non è replicato: si salvano i
// byte originali — lo stesso fallback che il PHP usa senza GD.)
const galleryMimeToExt: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function uploadLocationGalleryImages(slug: string, locationId: number, files: File[], publicOrigin = "") {
  const location = await getLocationById(slug, locationId);
  if (!location) throw new Error("Sede non valida per la gallery.");
  const valid = files.filter((f) => f && f.size > 0);
  if (!valid.length) throw new Error("Seleziona almeno una foto da caricare.");
  const table = await tenantTable(slug, "location_gallery_images");
  for (const file of valid) {
    if (file.size > 5 * 1024 * 1024) throw new Error("Foto troppo grande (max 5 MB)");
    const ext = galleryMimeToExt[file.type];
    if (!ext) throw new Error("Formato non valido: carica JPG, PNG o WEBP");
    if (!storageConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
    const stamp = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const ymdhis = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}`;
    const rand = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    // R2 pubblico: nel DB va l'URL completo (i path legacy /uploads restano validi).
    const key = tenantStorageKey(Number(table.tenantId ?? 0), "branding", `locations-${locationId}-gallery-${ymdhis}_${rand}.${ext}`);
    const publicPath = await putPublicObject(key, new Uint8Array(await file.arrayBuffer()), file.type);
    const sortRows = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "COALESCE(MAX(sort_order), 0) AS m", where: "location_id = ?", params: [locationId] }).catch(() => [] as RowDataPacket[]);
    await tenantInsert(table, { location_id: locationId, path: publicPath, sort_order: Number(sortRows[0]?.m ?? 0) + 10, is_active: 1 });
  }
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function deleteLocationGalleryImage(slug: string, locationId: number, imageId: number, publicOrigin = "") {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "id, path", where: "id = ? AND location_id = ?", params: [imageId, locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) throw new Error("Foto gallery non trovata per questa sede");
  const storedPath = String(rows[0].path ?? "");
  const galleryR2Key = storageKeyFromPublicUrl(storedPath);
  if (galleryR2Key) await deletePublicObject(galleryR2Key).catch(() => undefined);
  else await deletePublicUpload(storedPath);
  await tenantDelete({ slug, table: "location_gallery_images", id: imageId });
  // Ricompatta il sort_order a passo 10 (normalize_location_gallery_sort_order).
  const remaining = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "id", where: "location_id = ?", params: [locationId], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  for (let i = 0; i < remaining.length; i += 1) {
    await tenantUpdate({ slug, table: "location_gallery_images", id: Number(remaining[i].id), values: { sort_order: (i + 1) * 10 } }).catch(() => 0);
  }
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function moveLocationGalleryImage(slug: string, locationId: number, imageId: number, direction: "up" | "down", publicOrigin = "") {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "id, sort_order", where: "location_id = ?", params: [locationId], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const index = rows.findIndex((r) => Number(r.id) === imageId);
  if (index < 0) throw new Error("Foto gallery non trovata per questa sede");
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex >= 0 && targetIndex < rows.length) {
    await tenantUpdate({ slug, table: "location_gallery_images", id: Number(rows[index].id), values: { sort_order: Number(rows[targetIndex].sort_order ?? 0) } });
    await tenantUpdate({ slug, table: "location_gallery_images", id: Number(rows[targetIndex].id), values: { sort_order: Number(rows[index].sort_order ?? 0) } });
  }
  return getBusinessSettingsContext(slug, publicOrigin);
}

export async function previewLocationDelete(slug: string, locationId: number) {
  const location = await getLocationById(slug, locationId);
  if (!location) {
    return { ok: false, error: "Sede non trovata.", confirmText: "ELIMINA" };
  }
  const locationCount = await countTenantRows(slug, "locations", "COALESCE(is_active,1)=1", []);
  const appointments = await scopedAppointmentCount(slug, locationId);
  const blockingCounts: Record<string, number> = {};
  if (appointments > 0) blockingCounts.appointments = appointments;
  for (const table of historyBlockerTables) {
    const count = await countRowsWithLocation(slug, table, locationId);
    if (count > 0) blockingCounts[table] = count;
  }
  const directCounts: Record<string, number> = {};
  for (const table of locationCleanupTables) {
    const count = await countRowsWithLocation(slug, table, locationId);
    if (count > 0) directCounts[table] = count;
  }
  const canDelete = locationCount > 1 && Object.keys(blockingCounts).length === 0;
  return {
    ok: true,
    location,
    activeCount: locationCount,
    locationCount,
    canDelete,
    deleteBlockReason: locationCount <= 1
      ? "Deve restare almeno una sede."
      : (Object.keys(blockingCounts).length ? "La sede contiene storico operativo o contabile. Archiviala/nascondila o sposta prima i dati storici." : ""),
    blockingCounts,
    directCounts,
    confirmText: "ELIMINA",
  };
}

export async function deleteBusinessLocation(slug: string, locationId: number, confirmText: string, reason = "", publicOrigin = "") {
  if (confirmText.trim() !== "ELIMINA") throw new Error("Conferma non valida.");
  const preview = await previewLocationDelete(slug, locationId);
  if (!preview.ok) throw new Error(preview.error ?? "Sede non trovata.");
  if (!preview.canDelete) throw new Error(preview.deleteBlockReason || "Sede non eliminabile in sicurezza.");

  await ensureLocationDeletionLogTables(slug);
  const locationName = clean(String(preview.location?.name ?? `Sede #${locationId}`), 190);
  await insertLocationDeletionLog(slug, locationId, locationName, reason, preview);
  for (const table of locationCleanupTables) {
    await deleteRowsWithLocation(slug, table, locationId);
  }
  await deleteLocationActivityCategories(slug, locationId);
  // RIASSEGNAZIONE CLIENTI (LocationDeletion::reassignSharedClientLocations
  // ~698-720, forma semplificata): i clienti della sede eliminata passano alla
  // prima sede residua per sort_order (il ranking per attività del legacy è
  // parte del multi-sede completo, P11). Mai lasciare location_id orfani.
  try {
    const residual = await tenantSelect<RowDataPacket>({
      slug,
      table: "locations",
      columns: "id",
      where: "id <> ?",
      params: [locationId],
      orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
      limit: 1,
    });
    const fallbackId = Number(residual[0]?.id ?? 0) || null;
    const clientsTable = await tenantTable(slug, "clients");
    if (await columnExists(clientsTable.name, "location_id")) {
      await dbQuery(
        `UPDATE ${quoteIdentifier(clientsTable.name)} SET location_id = ${fallbackId === null ? "NULL" : fallbackId} WHERE tenant_id = ? AND location_id = ?`,
        [clientsTable.tenantId ?? 0, locationId],
      );
    }
  } catch { /* best-effort */ }
  await tenantDelete({ slug, table: "locations", id: locationId });
  await normalizeLocationOrder(slug);
  await syncMarketplaceProfile(slug, publicOrigin);
  return getBusinessSettingsContext(slug, publicOrigin);
}

async function getTenant(slug: string) {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) return null;
  const rows = await dbQuery<RowDataPacket[]>("SELECT id, slug, name, booking_public_allowed, marketplace_public_allowed FROM saas_tenants WHERE id=? LIMIT 1", [tenantId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id ?? 0),
    slug: String(row.slug ?? slug),
    name: String(row.name ?? slug),
    booking_public_allowed: Number(row.booking_public_allowed ?? 1),
    marketplace_public_allowed: Number(row.marketplace_public_allowed ?? 1),
  };
}

async function firstBusinessRow(slug: string) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "*",
    orderBy: "id ASC",
    limit: 1,
  });
  return rows[0] ?? null;
}

async function getBusinessProfile(slug: string) {
  const business = await firstBusinessRow(slug);
  const tenant = await getTenant(slug);
  const id = Number(business?.id ?? 0);
  const logoPath = clean(String(business?.logo_path ?? ""), 255) || await deterministicExistingLogoPath(slug, id);
  const coverPath = clean(String(business?.cover_path ?? ""), 255) || await deterministicExistingCoverPath(slug);
  return {
    id,
    name: String(business?.name ?? tenant?.name ?? slug),
    bookingAboutText: String(business?.booking_about_text ?? ""),
    address: String(business?.address ?? ""),
    phone: String(business?.phone ?? ""),
    email: String(business?.email ?? ""),
    website: String(business?.website ?? ""),
    logoPath,
    coverPath,
    logoUrl: await publicAssetUrl(logoPath),
    coverUrl: await publicAssetUrl(coverPath),
    logoPositionX: clampPosition(business?.logo_position_x ?? 50),
    logoPositionY: clampPosition(business?.logo_position_y ?? 50),
    coverPositionX: clampPosition(business?.cover_position_x ?? 50),
    coverPositionY: clampPosition(business?.cover_position_y ?? 50),
  };
}

async function listBusinessLocations(slug: string, publicOrigin = "") {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "*",
    orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
  });
  const galleries = await listLocationGalleryImages(slug);
  const mappings = await listLocationActivityMappings(slug);
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    const bookingUrl = `${publicOrigin || ""}/${encodeURIComponent(slug)}/booking?public=1&location_id=${id}`;
    return {
      id,
      name: String(row.name ?? ""),
      address: String(row.address ?? ""),
      isActive: Number(row.is_active ?? 1) === 1,
      phone: String(row.phone ?? ""),
      email: String(row.email ?? ""),
      whatsapp: String(row.whatsapp ?? ""),
      facebookUrl: String(row.facebook_url ?? ""),
      instagramUrl: String(row.instagram_url ?? ""),
      tiktokUrl: String(row.tiktok_url ?? ""),
      bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
      marketplaceEnabled: Number(row.marketplace_enabled ?? 1) === 1,
      sortOrder: Number(row.sort_order ?? 0),
      legal: Object.fromEntries(legalLocationFields.map((field) => [field, String(row[field] ?? "")])),
      galleryImages: galleries[id] ?? [],
      activityCategories: mappings[id] ?? [],
      bookingUrl,
    };
  });
}

async function getLocationById(slug: string, id: number) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "*",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  return rows[0] ?? null;
}

async function listLocationGalleryImages(slug: string) {
  if (!await tableExistsForTenant(slug, "location_gallery_images")) return {} as Record<number, Array<Record<string, unknown>>>;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "location_gallery_images",
    columns: "id, location_id, path, sort_order, is_active, created_at",
    orderBy: "location_id ASC, COALESCE(sort_order,999999) ASC, id ASC",
  }).catch(() => []);
  const grouped: Record<number, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    if (Number(row.is_active ?? 1) !== 1) continue;
    const locationId = Number(row.location_id ?? 0);
    if (locationId <= 0) continue;
    grouped[locationId] ??= [];
    grouped[locationId].push({
      id: Number(row.id ?? 0),
      path: String(row.path ?? ""),
      url: await publicAssetUrl(String(row.path ?? "")),
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: row.created_at ? String(row.created_at) : "",
    });
  }
  return grouped;
}

async function listMarketplaceActivityCategories() {
  await ensureMarketplaceDirectoryTables();
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT id, slug, name, icon_key, sort_order, is_active FROM marketplace_activity_categories WHERE is_active=1 ORDER BY sort_order ASC, name ASC",
  ).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    iconKey: String(row.icon_key ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
  }));
}

async function listLocationActivityMappings(slug: string) {
  await ensureMarketplaceDirectoryTables();
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) return {} as Record<number, Array<Record<string, unknown>>>;
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT m.location_id,
            m.marketplace_category_id,
            m.marketplace_category_slug,
            m.is_primary,
            m.sort_order,
            c.name AS marketplace_category_name,
            c.icon_key
       FROM marketplace_location_activity_categories m
       JOIN marketplace_activity_categories c ON c.id=m.marketplace_category_id
      WHERE m.tenant_id=? AND c.is_active=1
      ORDER BY m.location_id ASC, m.is_primary DESC, m.sort_order ASC, c.sort_order ASC, c.name ASC`,
    [tenantId],
  ).catch(() => []);
  const grouped: Record<number, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    const locationId = Number(row.location_id ?? 0);
    if (locationId <= 0) continue;
    grouped[locationId] ??= [];
    grouped[locationId].push({
      marketplaceCategoryId: Number(row.marketplace_category_id ?? 0),
      marketplaceCategorySlug: String(row.marketplace_category_slug ?? ""),
      marketplaceCategoryName: String(row.marketplace_category_name ?? ""),
      iconKey: String(row.icon_key ?? ""),
      isPrimary: Number(row.is_primary ?? 0) === 1,
      sortOrder: Number(row.sort_order ?? 0),
    });
  }
  return grouped;
}

async function saveLocationActivityCategories(slug: string, locationId: number, categoryIds: number[], primaryCategoryId: number) {
  await ensureMarketplaceDirectoryTables();
  const tenant = await getTenant(slug);
  if (!tenant) throw new Error("Tenant non trovato.");
  const requested = Array.from(new Set(categoryIds.filter((id) => id > 0))).slice(0, 5);
  const selected = await selectedActivityCategories(requested, primaryCategoryId);
  if (requested.length && !selected.length) throw new Error("Categorie attivita marketplace non valide.");
  await dbExecute("DELETE FROM marketplace_location_activity_categories WHERE tenant_id=? AND location_id=?", [tenant.id, locationId]);
  for (const [index, row] of selected.entries()) {
    await dbExecute(
      `INSERT INTO marketplace_location_activity_categories
        (tenant_id, tenant_slug, location_id, marketplace_category_id, marketplace_category_slug, is_primary, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [tenant.id, tenant.slug, locationId, row.id, row.slug, row.isPrimary ? 1 : 0, row.sortOrder ?? index],
    );
  }
}

async function deleteLocationActivityCategories(slug: string, locationId: number) {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId || !await tableExists("marketplace_location_activity_categories")) return;
  await dbExecute("DELETE FROM marketplace_location_activity_categories WHERE tenant_id=? AND location_id=?", [tenantId, locationId]);
  if (await tableExists("tenant_directory_location_categories")) {
    await dbExecute("DELETE FROM tenant_directory_location_categories WHERE tenant_id=? AND location_id=?", [tenantId, locationId]);
  }
}

async function selectedActivityCategories(categoryIds: number[], primaryCategoryId: number) {
  if (!categoryIds.length) return [] as Array<{ id: number; slug: string; name: string; isPrimary: boolean; sortOrder: number }>;
  const ph = categoryIds.map(() => "?").join(",");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id, slug, name, sort_order FROM marketplace_activity_categories WHERE id IN (${ph}) AND is_active=1`,
    categoryIds,
  );
  const byId = new Map(rows.map((row) => [Number(row.id ?? 0), row]));
  let primary = primaryCategoryId > 0 && categoryIds.includes(primaryCategoryId) ? primaryCategoryId : categoryIds[0];
  if (!byId.has(primary)) primary = Number(rows[0]?.id ?? 0);
  return categoryIds
    .map((id, index) => {
      const row = byId.get(id);
      if (!row) return null;
      return { id, slug: String(row.slug ?? ""), name: String(row.name ?? ""), isPrimary: id === primary, sortOrder: index };
    })
    .filter((row): row is { id: number; slug: string; name: string; isPrimary: boolean; sortOrder: number } => Boolean(row));
}

async function syncMarketplaceProfile(slug: string, publicOrigin = "") {
  await ensureMarketplaceDirectoryTables();
  const tenant = await getTenant(slug);
  if (!tenant) return;
  const current = await getCentralDirectoryProfile(tenant.id);
  const profile = await defaultDirectoryProfile(slug, publicOrigin);
  const visible = await hasMarketplaceVisibleLocation(slug);
  const categoryText = await currentTenantMarketplaceCategoryText(slug);
  const isVisible = visible ? 1 : 0;
  const status = visible ? "published" : "hidden";
  const bookingUrl = `${publicOrigin || ""}/${encodeURIComponent(slug)}/booking?public=1`;
  const values = {
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    is_visible: isVisible,
    status,
    title: emptyToNull(profile.title),
    subtitle: null,
    description: emptyToNull(profile.description),
    category_text: emptyToNull(clean(categoryText, 255)),
    city: emptyToNull(profile.city),
    province: emptyToNull(profile.province),
    region: emptyToNull(profile.region),
    address: emptyToNull(profile.address),
    phone: emptyToNull(profile.phone),
    email: emptyToNull(profile.email),
    website: emptyToNull(normalizeUrl(profile.website)),
    logo_image: emptyToNull(profile.logoImage),
    cover_image: emptyToNull(profile.coverImage),
    logo_position_x: profile.logoPositionX,
    logo_position_y: profile.logoPositionY,
    cover_position_x: profile.coverPositionX,
    cover_position_y: profile.coverPositionY,
    booking_url: bookingUrl,
    search_text: profileSearchText({ ...profile, categoryText }),
    featured: Number(current?.featured ?? 0) ? 1 : 0,
    sort_order: Math.max(0, Number(current?.sort_order ?? 0)),
    published_status: status,
    published_visible: isVisible,
  };
  await dbExecute(
    `INSERT INTO tenant_directory_profiles
      (tenant_id,tenant_slug,is_visible,status,title,subtitle,description,category_text,city,province,region,address,phone,email,website,logo_image,cover_image,logo_position_x,logo_position_y,cover_position_x,cover_position_y,booking_url,search_text,featured,sort_order,published_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ?='published' AND ?=1 THEN NOW() ELSE NULL END)
     ON CONFLICT (tenant_id) DO UPDATE SET
      tenant_id=EXCLUDED.tenant_id,
      tenant_slug=EXCLUDED.tenant_slug,
      is_visible=EXCLUDED.is_visible,
      status=EXCLUDED.status,
      title=EXCLUDED.title,
      subtitle=EXCLUDED.subtitle,
      description=EXCLUDED.description,
      category_text=EXCLUDED.category_text,
      city=EXCLUDED.city,
      province=EXCLUDED.province,
      region=EXCLUDED.region,
      address=EXCLUDED.address,
      phone=EXCLUDED.phone,
      email=EXCLUDED.email,
      website=EXCLUDED.website,
      logo_image=EXCLUDED.logo_image,
      cover_image=EXCLUDED.cover_image,
      logo_position_x=EXCLUDED.logo_position_x,
      logo_position_y=EXCLUDED.logo_position_y,
      cover_position_x=EXCLUDED.cover_position_x,
      cover_position_y=EXCLUDED.cover_position_y,
      booking_url=EXCLUDED.booking_url,
      search_text=EXCLUDED.search_text,
      featured=EXCLUDED.featured,
      sort_order=EXCLUDED.sort_order,
      published_at=CASE WHEN EXCLUDED.status='published' AND EXCLUDED.is_visible=1 AND tenant_directory_profiles.published_at IS NULL THEN NOW() ELSE tenant_directory_profiles.published_at END`,
    Object.values(values),
  );
  await syncDirectoryLocations(slug, { ...profile, isVisible, status, title: profile.title }, publicOrigin);
}

async function defaultDirectoryProfile(slug: string, publicOrigin = "") {
  const tenant = await getTenant(slug);
  const business = await getBusinessProfile(slug);
  const firstLocation = (await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "*",
    orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
    limit: 1,
  }))[0] ?? {};
  const logoImage = business.logoUrl ? withOrigin(business.logoUrl, publicOrigin) : "";
  const coverImage = business.coverUrl ? withOrigin(business.coverUrl, publicOrigin) : "";
  return {
    tenantId: tenant?.id ?? 0,
    tenantSlug: tenant?.slug ?? slug,
    title: clean(business.name || tenant?.name || slug, 190),
    description: String(business.bookingAboutText ?? ""),
    address: clean(String(firstLocation.address ?? business.address ?? ""), 255),
    city: clean(String(firstLocation.legal_city ?? ""), 120),
    province: clean(String(firstLocation.legal_province ?? ""), 80),
    region: clean(String(firstLocation.legal_region ?? ""), 120),
    phone: clean(String(business.phone || firstLocation.phone || ""), 50),
    email: clean(String(business.email || firstLocation.email || ""), 190),
    website: clean(String(business.website || firstLocation.legal_website || ""), 255),
    logoImage,
    coverImage,
    logoPositionX: business.logoPositionX,
    logoPositionY: business.logoPositionY,
    coverPositionX: business.coverPositionX,
    coverPositionY: business.coverPositionY,
  };
}

async function syncDirectoryLocations(slug: string, profile: Record<string, unknown>, publicOrigin = "") {
  await ensureMarketplaceDirectoryTables();
  const tenant = await getTenant(slug);
  if (!tenant) return;
  if (!tenant.marketplace_public_allowed) {
    await dbExecute("DELETE FROM tenant_directory_locations WHERE tenant_id=?", [tenant.id]);
    await dbExecute("DELETE FROM tenant_directory_location_categories WHERE tenant_id=?", [tenant.id]);
    return;
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "*",
    where: "COALESCE(is_active,1)=1 AND COALESCE(marketplace_enabled,1)=1",
    orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
  }).catch(() => []);
  const categoryRowsByLocation = await listCentralActivityRowsByLocation(tenant.id);
  const visible = Boolean(profile.isVisible);
  const status = visible ? "published" : "hidden";
  const seenIds: number[] = [];
  await dbExecute("DELETE FROM tenant_directory_location_categories WHERE tenant_id=?", [tenant.id]);
  for (const row of rows) {
    const locationId = Number(row.id ?? 0);
    if (locationId <= 0) continue;
    seenIds.push(locationId);
    const activityRows = categoryRowsByLocation[locationId] ?? [];
    const primaryActivity = activityRows.find((activity) => Number(activity.is_primary ?? 0) === 1) ?? activityRows[0] ?? {};
    const primaryCategorySlug = clean(String(primaryActivity.marketplace_category_slug ?? ""), 120);
    const primaryCategoryName = clean(String(primaryActivity.marketplace_category_name ?? ""), 190);
    const categoryText = activityCategoryText(activityRows);
    const locationSlug = locationSlugFor(row);
    const bookingUrl = `${publicOrigin || ""}/${encodeURIComponent(slug)}/booking?public=1&location_id=${locationId}`;
    const locationValues = [
      tenant.id,
      tenant.slug,
      locationId,
      locationSlug,
      visible ? 1 : 0,
      status,
      emptyToNull(clean(String(profile.title ?? ""), 190)),
      emptyToNull(clean(String(row.name ?? "Sede"), 190)),
      emptyToNull(clean(String(row.legal_city ?? ""), 120)),
      emptyToNull(clean(String(row.legal_province ?? ""), 80)),
      emptyToNull(clean(String(row.legal_region ?? ""), 120)),
      emptyToNull(clean(String(row.address ?? ""), 255)),
      emptyToNull(clean(String(row.phone ?? ""), 50)),
      emptyToNull(clean(String(row.whatsapp ?? ""), 50)),
      emptyToNull(clean(String(row.facebook_url ?? ""), 255)),
      emptyToNull(clean(String(row.instagram_url ?? ""), 255)),
      emptyToNull(clean(String(row.tiktok_url ?? ""), 255)),
      emptyToNull(clean(String(row.email ?? ""), 190)),
      bookingUrl,
      tenant.booking_public_allowed && Number(row.booking_enabled ?? 1) === 1 ? 1 : 0,
      tenant.marketplace_public_allowed && Number(row.marketplace_enabled ?? 1) === 1 ? 1 : 0,
      emptyToNull(primaryCategorySlug),
      emptyToNull(primaryCategoryName),
      emptyToNull(categoryText),
      emptyToNull(locationSearchText(profile, row, { primaryCategorySlug, primaryCategoryName, categoryText })),
      Math.max(0, Number(row.sort_order ?? 0)),
    ];
    await dbExecute(
      `INSERT INTO tenant_directory_locations
        (tenant_id,tenant_slug,location_id,location_slug,is_visible,status,tenant_title,location_name,city,province,region,address,phone,whatsapp,facebook_url,instagram_url,tiktok_url,email,booking_url,booking_enabled,marketplace_enabled,primary_category_slug,primary_category_name,category_text,search_text,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id, location_id) DO UPDATE SET
        tenant_id=EXCLUDED.tenant_id,
        tenant_slug=EXCLUDED.tenant_slug,
        location_id=EXCLUDED.location_id,
        location_slug=EXCLUDED.location_slug,
        is_visible=EXCLUDED.is_visible,
        status=EXCLUDED.status,
        tenant_title=EXCLUDED.tenant_title,
        location_name=EXCLUDED.location_name,
        city=EXCLUDED.city,
        province=EXCLUDED.province,
        region=EXCLUDED.region,
        address=EXCLUDED.address,
        phone=EXCLUDED.phone,
        whatsapp=EXCLUDED.whatsapp,
        facebook_url=EXCLUDED.facebook_url,
        instagram_url=EXCLUDED.instagram_url,
        tiktok_url=EXCLUDED.tiktok_url,
        email=EXCLUDED.email,
        booking_url=EXCLUDED.booking_url,
        booking_enabled=EXCLUDED.booking_enabled,
        marketplace_enabled=EXCLUDED.marketplace_enabled,
        primary_category_slug=EXCLUDED.primary_category_slug,
        primary_category_name=EXCLUDED.primary_category_name,
        category_text=EXCLUDED.category_text,
        search_text=EXCLUDED.search_text,
        sort_order=EXCLUDED.sort_order`,
      locationValues,
    );

    for (const activityRow of activityRows) {
      const categoryId = Number(activityRow.marketplace_category_id ?? 0);
      const categorySlug = clean(String(activityRow.marketplace_category_slug ?? ""), 120);
      const categoryName = clean(String(activityRow.marketplace_category_name ?? ""), 190);
      if (categoryId <= 0 || !categorySlug || !categoryName) continue;
      await dbExecute(
        `INSERT INTO tenant_directory_location_categories
          (tenant_id,tenant_slug,location_id,location_slug,marketplace_category_id,marketplace_category_slug,marketplace_category_name,is_primary,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, location_id, marketplace_category_id) DO UPDATE SET
          tenant_slug=EXCLUDED.tenant_slug,
          location_slug=EXCLUDED.location_slug,
          marketplace_category_slug=EXCLUDED.marketplace_category_slug,
          marketplace_category_name=EXCLUDED.marketplace_category_name,
          is_primary=EXCLUDED.is_primary,
          sort_order=EXCLUDED.sort_order`,
        [tenant.id, tenant.slug, locationId, locationSlug, categoryId, categorySlug, categoryName, Number(activityRow.is_primary ?? 0) ? 1 : 0, Number(activityRow.sort_order ?? 0)],
      );
    }
  }
  if (seenIds.length) {
    const ph = seenIds.map(() => "?").join(",");
    await dbExecute(`DELETE FROM tenant_directory_locations WHERE tenant_id=? AND location_id NOT IN (${ph})`, [tenant.id, ...seenIds]);
    await dbExecute(`DELETE FROM tenant_directory_location_categories WHERE tenant_id=? AND location_id NOT IN (${ph})`, [tenant.id, ...seenIds]);
  } else {
    await dbExecute("DELETE FROM tenant_directory_locations WHERE tenant_id=?", [tenant.id]);
    await dbExecute("DELETE FROM tenant_directory_location_categories WHERE tenant_id=?", [tenant.id]);
  }
}

async function getCentralDirectoryProfile(tenantId: number) {
  if (!await tableExists("tenant_directory_profiles")) return null;
  const rows = await dbQuery<RowDataPacket[]>("SELECT * FROM tenant_directory_profiles WHERE tenant_id=? LIMIT 1", [tenantId]).catch(() => []);
  return rows[0] ?? null;
}

async function listCentralActivityRowsByLocation(tenantId: number) {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT m.location_id,
            m.marketplace_category_id,
            m.marketplace_category_slug,
            m.is_primary,
            m.sort_order,
            c.name AS marketplace_category_name
       FROM marketplace_location_activity_categories m
       JOIN marketplace_activity_categories c ON c.id=m.marketplace_category_id
      WHERE m.tenant_id=? AND c.is_active=1
      ORDER BY m.location_id ASC, m.is_primary DESC, m.sort_order ASC, c.sort_order ASC, c.name ASC`,
    [tenantId],
  ).catch(() => []);
  const grouped: Record<number, RowDataPacket[]> = {};
  for (const row of rows) {
    const locationId = Number(row.location_id ?? 0);
    if (locationId <= 0) continue;
    grouped[locationId] ??= [];
    grouped[locationId].push(row);
  }
  return grouped;
}

async function hasMarketplaceVisibleLocation(slug: string) {
  const tenant = await getTenant(slug);
  if (!tenant?.marketplace_public_allowed) return false;
  return await countTenantRows(slug, "locations", "COALESCE(is_active,1)=1 AND COALESCE(marketplace_enabled,1)=1", []) > 0;
}

async function currentTenantMarketplaceCategoryText(slug: string) {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) return "";
  const visibleLocations = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id",
    where: "COALESCE(is_active,1)=1 AND COALESCE(marketplace_enabled,1)=1",
  }).catch(() => []);
  const ids = visibleLocations.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  if (!ids.length) return "";
  const ph = ids.map(() => "?").join(",");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT DISTINCT c.name, c.sort_order
       FROM marketplace_location_activity_categories m
       JOIN marketplace_activity_categories c ON c.id=m.marketplace_category_id
      WHERE m.tenant_id=? AND m.location_id IN (${ph}) AND c.is_active=1
      ORDER BY c.sort_order ASC, c.name ASC`,
    [tenantId, ...ids],
  ).catch(() => []);
  return activityCategoryText(rows);
}

function normalizeLocationPayload(input: Record<string, string>): Record<string, string | number> {
  const data: Record<string, string | number> = {
    name: clean(input.name ?? "", 190),
    address: clean(input.address ?? "", 255),
    phone: clean(input.phone ?? "", 60),
    email: clean(input.email ?? "", 190),
    whatsapp: clean(input.whatsapp ?? "", 60),
    facebook_url: normalizeSocialUrl("facebook", input.facebook_url ?? input.facebookUrl ?? ""),
    instagram_url: normalizeSocialUrl("instagram", input.instagram_url ?? input.instagramUrl ?? ""),
    tiktok_url: normalizeSocialUrl("tiktok", input.tiktok_url ?? input.tiktokUrl ?? ""),
    booking_enabled: truthy(input.booking_enabled ?? input.bookingEnabled) ? 1 : 0,
  };
  for (const field of legalLocationFields) data[field] = clean(input[field] ?? "", 255);
  return data;
}

async function validateLocationPayload(slug: string, data: Record<string, string | number>, id: number) {
  if (!String(data.name ?? "").trim()) throw new Error("Inserisci il nome della sede.");
  const email = String(data.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email non valida.");
  for (const [field, label] of Object.entries({ facebook_url: "Facebook", instagram_url: "Instagram", tiktok_url: "TikTok" })) {
    const url = String(data[field] ?? "").trim();
    if (url && !isValidUrl(url)) throw new Error(`${label} non valido.`);
  }
  const duplicate = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id",
    where: "LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id <> ?",
    params: [String(data.name), id],
    limit: 1,
  });
  if (duplicate.length) throw new Error("Esiste gia una sede con questo nome.");
}

function legalFieldValues(data: Record<string, string | number>) {
  return Object.fromEntries(legalLocationFields.map((field) => [field, emptyToNull(String(data[field] ?? ""))]));
}

async function filterExistingColumns(tableName: string, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (await columnExists(tableName, key)) out[key] = value;
  }
  return out;
}

async function currentLocationBookingEnabled(slug: string, id: number) {
  const row = await getLocationById(slug, id);
  return Number(row?.booking_enabled ?? 0) === 1 ? 1 : 0;
}

async function nextLocationSortOrder(slug: string) {
  const target = await tenantTable(slug, "locations");
  if (!await columnExists(target.name, "sort_order")) return 0;
  const { where, params } = await tenantScope(target, [], []);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM ${quoteIdentifier(target.name)}${where}`,
    params,
  );
  return Number(rows[0]?.next_order ?? 0);
}

async function normalizeLocationOrder(slug: string) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id, COALESCE(sort_order,999999) AS sort_order",
    orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
  });
  for (const [pos, row] of rows.entries()) {
    if (Number(row.sort_order ?? -1) !== pos) {
      await tenantUpdate({ slug, table: "locations", id: Number(row.id ?? 0), values: { sort_order: pos } });
      row.sort_order = pos;
    }
  }
  return rows;
}

async function countTenantRows(slug: string, table: string, where: string, params: unknown[]) {
  if (!await tableExistsForTenant(slug, table)) return 0;
  const target = await tenantTable(slug, table);
  const scope = await tenantScope(target, where ? [where] : [], params);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(target.name)}${scope.where}`, scope.params).catch(() => []);
  return Number(rows[0]?.count ?? 0);
}

async function countRowsWithLocation(slug: string, table: string, locationId: number) {
  if (!await tableExistsForTenant(slug, table)) return 0;
  const target = await tenantTable(slug, table);
  if (!await columnExists(target.name, "location_id")) return 0;
  return countTenantRows(slug, table, "location_id = ?", [locationId]);
}

async function scopedAppointmentCount(slug: string, locationId: number) {
  let count = await countRowsWithLocation(slug, "appointments", locationId);
  if (await tableExistsForTenant(slug, "appointment_locations")) {
    count += await countTenantRows(slug, "appointment_locations", "location_id = ?", [locationId]);
  }
  return count;
}

async function deleteRowsWithLocation(slug: string, table: string, locationId: number) {
  if (!await tableExistsForTenant(slug, table)) return 0;
  const target = await tenantTable(slug, table);
  if (!await columnExists(target.name, "location_id")) return 0;
  const scope = await tenantScope(target, ["location_id = ?"], [locationId]);
  const result = await dbExecute(`DELETE FROM ${quoteIdentifier(target.name)}${scope.where}`, scope.params);
  return result.affectedRows;
}

async function tableExistsForTenant(slug: string, table: string) {
  try {
    await tenantTable(slug, table);
    return true;
  } catch {
    return false;
  }
}

async function tenantScope(target: TenantTarget, clauses: string[], params: unknown[]) {
  const scopedClauses = [...clauses];
  const scopedParams = [...params];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    scopedClauses.unshift("tenant_id = ?");
    scopedParams.unshift(target.tenantId ?? 0);
  }
  return {
    where: scopedClauses.length ? ` WHERE ${scopedClauses.join(" AND ")}` : "",
    params: scopedParams,
  };
}

async function ensureLocationDeletionLogTables(slug: string) {
  const locations = await tenantTable(slug, "locations");
  const tenantColumn = locations.mode === "shared" ? "`tenant_id` INT NULL DEFAULT NULL," : "";
  const logsTable = locations.mode === "prefixed" ? locations.name.replace(/locations$/, "location_deletion_logs") : "location_deletion_logs";
  const itemsTable = locations.mode === "prefixed" ? locations.name.replace(/locations$/, "location_deletion_log_items") : "location_deletion_log_items";
  if (!await tableExists(logsTable)) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(logsTable)} (
        id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        ${tenantColumn}
        location_id INT NOT NULL,
        location_name VARCHAR(190) NULL,
        reason TEXT NULL,
        summary_json TEXT NULL,
        deleted_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  }
  if (!await tableExists(itemsTable)) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(itemsTable)} (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        ${tenantColumn}
        log_id INT NOT NULL,
        group_name VARCHAR(80) NULL,
        table_name VARCHAR(80) NULL,
        entity_id INT NULL,
        entity_label VARCHAR(255) NULL,
        action VARCHAR(80) NULL,
        meta_json TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  }
}

async function insertLocationDeletionLog(slug: string, locationId: number, locationName: string, reason: string, preview: unknown) {
  const table = await tenantTable(slug, "location_deletion_logs");
  const values: Record<string, unknown> = {
    location_id: locationId,
    location_name: locationName,
    reason: emptyToNull(reason),
    summary_json: JSON.stringify(preview),
    deleted_by: null,
  };
  await tenantInsert(table, values);
}

async function ensureMarketplaceDirectoryTables() {
  if (!await tableExists("tenant_directory_profiles")) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS tenant_directory_profiles (
        id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        tenant_id INT NOT NULL,
        tenant_slug VARCHAR(80) NOT NULL,
        is_visible SMALLINT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        title VARCHAR(190) NULL,
        subtitle VARCHAR(255) NULL,
        description TEXT NULL,
        category_text VARCHAR(255) NULL,
        city VARCHAR(120) NULL,
        province VARCHAR(80) NULL,
        region VARCHAR(120) NULL,
        address VARCHAR(255) NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        phone VARCHAR(50) NULL,
        email VARCHAR(190) NULL,
        website VARCHAR(255) NULL,
        logo_image VARCHAR(255) NULL,
        cover_image VARCHAR(255) NULL,
        logo_position_x SMALLINT NOT NULL DEFAULT 50,
        logo_position_y SMALLINT NOT NULL DEFAULT 50,
        cover_position_x SMALLINT NOT NULL DEFAULT 50,
        cover_position_y SMALLINT NOT NULL DEFAULT 50,
        booking_url VARCHAR(255) NULL,
        search_text TEXT NULL,
        featured SMALLINT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        published_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_tenant_directory_profiles_tenant UNIQUE (tenant_id),
        CONSTRAINT uq_tenant_directory_profiles_slug UNIQUE (tenant_slug)
      )`,
    );
  }
  if (!await tableExists("tenant_directory_locations")) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS tenant_directory_locations (
        id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        tenant_id INT NOT NULL,
        tenant_slug VARCHAR(80) NOT NULL,
        location_id INT NOT NULL,
        location_slug VARCHAR(160) NOT NULL,
        is_visible SMALLINT NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'published',
        tenant_title VARCHAR(190) NULL,
        location_name VARCHAR(190) NULL,
        city VARCHAR(120) NULL,
        province VARCHAR(80) NULL,
        region VARCHAR(120) NULL,
        address VARCHAR(255) NULL,
        phone VARCHAR(50) NULL,
        whatsapp VARCHAR(50) NULL,
        facebook_url VARCHAR(255) NULL,
        instagram_url VARCHAR(255) NULL,
        tiktok_url VARCHAR(255) NULL,
        email VARCHAR(190) NULL,
        booking_url VARCHAR(255) NULL,
        booking_enabled SMALLINT NOT NULL DEFAULT 1,
        marketplace_enabled SMALLINT NOT NULL DEFAULT 1,
        primary_category_slug VARCHAR(120) NULL,
        primary_category_name VARCHAR(190) NULL,
        category_text VARCHAR(255) NULL,
        search_text TEXT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_tenant_directory_locations_location UNIQUE (tenant_id, location_id),
        CONSTRAINT uq_tenant_directory_locations_slug UNIQUE (tenant_slug, location_slug)
      )`,
    );
  }
  if (!await tableExists("tenant_directory_location_categories")) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS tenant_directory_location_categories (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        tenant_id INT NOT NULL,
        tenant_slug VARCHAR(80) NOT NULL,
        location_id INT NOT NULL,
        location_slug VARCHAR(160) NOT NULL,
        marketplace_category_id INT NOT NULL,
        marketplace_category_slug VARCHAR(120) NOT NULL,
        marketplace_category_name VARCHAR(190) NOT NULL,
        is_primary SMALLINT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_tenant_directory_location_category UNIQUE (tenant_id, location_id, marketplace_category_id)
      )`,
    );
  }
}

function clean(value: unknown, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function stringLength(value: string) {
  return Array.from(value).length;
}

function truthy(value: unknown) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function clampPosition(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeUrl(value: string) {
  const url = clean(value, 255);
  if (!url) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function normalizeSocialUrl(platform: "facebook" | "instagram" | "tiktok", value: string) {
  const raw = value.trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const handle = raw.replace(/^@+/, "");
    const knownDomain = /^(www\.|m\.|facebook\.com|instagram\.com|tiktok\.com|vm\.tiktok\.com|fb\.me)/i.test(handle);
    if (handle && !handle.includes("/") && !knownDomain) {
      const bases = {
        facebook: "https://www.facebook.com/",
        instagram: "https://www.instagram.com/",
        tiktok: "https://www.tiktok.com/@",
      };
      return bases[platform] + encodeURIComponent(handle);
    }
  }
  return normalizeUrl(raw);
}

function isValidUrl(value: string) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

function parseIdList(value: unknown) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function orderSelectedIds(selected: number[], order: number[]) {
  const selectedSet = new Set(selected);
  const ordered = order.filter((id) => selectedSet.has(id));
  for (const id of selected) if (!ordered.includes(id)) ordered.push(id);
  return Array.from(new Set(ordered));
}

function businessLogoFileBase(slug: string, businessId: number) {
  return `${safeSlug(slug)}_${businessId > 0 ? businessId : 1}`;
}

function safeSlug(slug: string) {
  return (slug || "tenant").replace(/[^A-Za-z0-9_-]/g, "") || "tenant";
}

async function deterministicExistingLogoPath(slug: string, businessId: number) {
  const base = businessLogoFileBase(slug, businessId || 1);
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    const pub = `/uploads/logo/${base}.${ext}`;
    if (await publicFileExists(pub)) return pub;
  }
  return "";
}

async function deterministicExistingCoverPath(slug: string) {
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    const pub = `/uploads/tenants/${safeSlug(slug)}/branding/cover.${ext}`;
    if (await publicFileExists(pub)) return pub;
  }
  return "";
}

async function publicAssetUrl(publicPath: string) {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized) return "";
  if (/^https?:\/\//i.test(normalized)) return normalized;
  const abs = path.join(process.cwd(), "public", ...normalized.split("/").filter(Boolean));
  let suffix = "";
  try {
    const info = await stat(abs);
    if (info.size > 0) suffix = `?v=${Math.floor(info.mtimeMs / 1000)}`;
  } catch {
    return normalized;
  }
  return `${normalized}${suffix}`;
}

function withOrigin(value: string, origin: string) {
  if (!value || /^https?:\/\//i.test(value) || !origin) return value;
  return `${origin.replace(/\/$/, "")}${value}`;
}

function normalizePublicPath(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/uploads/")) return "";
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}

async function publicFileExists(publicPath: string) {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized) return false;
  try {
    const info = await stat(path.join(process.cwd(), "public", ...normalized.split("/").filter(Boolean)));
    return info.size > 0;
  } catch {
    return false;
  }
}

async function deletePublicUpload(publicPath: string) {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized) return;
  const abs = path.join(process.cwd(), "public", ...normalized.split("/").filter(Boolean));
  if (!abs.startsWith(path.join(process.cwd(), "public"))) return;
  try {
    await unlink(abs);
  } catch {}
}

async function removeSiblingImages(publicPath: string) {
  const normalized = normalizePublicPath(publicPath);
  const ext = path.extname(normalized).slice(1).toLowerCase();
  const dir = path.dirname(normalized);
  const stem = path.basename(normalized, path.extname(normalized));
  for (const candidateExt of ["jpg", "jpeg", "png", "webp", "gif"]) {
    if (candidateExt === ext) continue;
    await deletePublicUpload(`${dir}/${stem}.${candidateExt}`);
  }
}

async function removeDeterministicBusinessImageFiles(slug: string, businessId: number, kind: "logo" | "cover") {
  if (kind === "logo") {
    const base = businessLogoFileBase(slug, businessId);
    for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) await deletePublicUpload(`/uploads/logo/${base}.${ext}`);
    return;
  }
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) await deletePublicUpload(`/uploads/tenants/${safeSlug(slug)}/branding/cover.${ext}`);
}

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "sede";
}

function locationSlugFor(row: RowDataPacket) {
  const id = Number(row.id ?? row.location_id ?? 0);
  const city = clean(String(row.legal_city ?? row.city ?? ""), 80);
  const name = clean(String(row.name ?? row.location_name ?? ""), 100);
  return `${slugify(`${city} ${name}`.trim() || "sede")}${id > 0 ? `-${id}` : ""}`;
}

function activityCategoryText(rows: Array<Record<string, unknown>>) {
  const names: string[] = [];
  for (const row of rows) {
    const name = clean(String(row.marketplace_category_name ?? row.name ?? ""), 80);
    if (name && !names.includes(name)) names.push(name);
  }
  return clean(names.join(", "), 255);
}

function profileSearchText(profile: Record<string, unknown>) {
  return clean([
    profile.title,
    profile.subtitle,
    profile.description,
    profile.categoryText,
    profile.city,
    profile.province,
    profile.region,
    profile.address,
  ].map((item) => String(item ?? "").trim()).filter(Boolean).join(" "), 2000);
}

function locationSearchText(profile: Record<string, unknown>, location: RowDataPacket, category: Record<string, string>) {
  return clean([
    profile.title,
    profile.subtitle,
    profile.description,
    profile.categoryText,
    location.name,
    location.location_name,
    location.address,
    location.legal_city,
    location.city,
    location.legal_province,
    location.province,
    location.legal_region,
    location.region,
    category.primaryCategoryName,
    category.primaryCategorySlug,
    category.categoryText,
    location.phone,
    location.whatsapp,
    location.facebook_url,
    location.instagram_url,
    location.tiktok_url,
    location.email,
  ].map((item) => String(item ?? "").trim()).filter(Boolean).filter((item, index, items) => items.indexOf(item) === index).join(" "), 2000);
}
