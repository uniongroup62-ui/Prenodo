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
  withTenantTransaction,
  type TenantTxQuery,
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

// MIME REALE dai magic bytes come getimagesize del legacy (process_uploaded_
// logo/branding_image/gallery): mai fidarsi del Content-Type dichiarato dal
// browser. Contenuto non riconoscibile -> 'Formato immagine non supportato'
// (il messaggio getimagesize-fail legacy), immagine riconosciuta ma non
// ammessa -> messaggio 'Formato non valido' specifico del chiamante.
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return null;
}

// LocationDeletion::mappingSpecs (LocationDeletion.php 59-153): per ogni gruppo
// il master, la label, la tabella di mapping sede e i FIGLI da cancellare in
// cascata quando il master è ESCLUSIVO della sede eliminata.
type LocationMappingSpec = {
  table: string;
  labelColumn: string;
  mapping: string;
  mappingColumn: string;
  children: Array<{ table: string; column: string }>;
};

const locationMappingSpecs: Record<string, LocationMappingSpec> = {
  services: {
    table: "services",
    labelColumn: "name",
    mapping: "service_locations",
    mappingColumn: "service_id",
    children: [
      { table: "service_locations", column: "service_id" },
      { table: "service_cabins", column: "service_id" },
      { table: "service_resources", column: "service_id" },
      { table: "staff_services", column: "service_id" },
      { table: "service_recommendations", column: "service_id" },
    ],
  },
  staff: {
    table: "staff",
    labelColumn: "full_name",
    mapping: "staff_locations",
    mappingColumn: "staff_id",
    children: [
      { table: "staff_locations", column: "staff_id" },
      { table: "staff_services", column: "staff_id" },
      { table: "staff_timeoff", column: "staff_id" },
      { table: "staff_availability", column: "staff_id" },
      { table: "staff_commission_settings", column: "staff_id" },
      { table: "staff_commission_periods", column: "staff_id" },
      { table: "staff_commission_payments", column: "staff_id" },
    ],
  },
  packages: {
    table: "packages",
    labelColumn: "name",
    mapping: "package_locations",
    mappingColumn: "package_id",
    children: [
      { table: "package_locations", column: "package_id" },
      { table: "package_services", column: "package_id" },
      { table: "package_items", column: "package_id" },
      { table: "package_pricing", column: "package_id" },
    ],
  },
  coupons: {
    table: "coupons",
    labelColumn: "code",
    mapping: "coupon_locations",
    mappingColumn: "coupon_id",
    children: [{ table: "coupon_locations", column: "coupon_id" }],
  },
  gifts: {
    table: "gifts",
    labelColumn: "name",
    mapping: "gift_locations",
    mappingColumn: "gift_id",
    children: [{ table: "gift_locations", column: "gift_id" }],
  },
  promotions: {
    table: "promotions",
    labelColumn: "title",
    mapping: "promotion_locations",
    mappingColumn: "promotion_id",
    children: [
      { table: "promotion_locations", column: "promotion_id" },
      { table: "promotion_services", column: "promotion_id" },
      { table: "promotion_products", column: "promotion_id" },
      { table: "promotion_time_windows", column: "promotion_id" },
      { table: "promotion_blackout_dates", column: "promotion_id" },
      { table: "promotion_redemptions", column: "promotion_id" },
    ],
  },
  suppliers: {
    table: "suppliers",
    labelColumn: "name",
    mapping: "supplier_locations",
    mappingColumn: "supplier_id",
    children: [{ table: "supplier_locations", column: "supplier_id" }],
  },
  resources: {
    table: "resources",
    labelColumn: "name",
    mapping: "resource_locations",
    mappingColumn: "resource_id",
    children: [
      { table: "resource_locations", column: "resource_id" },
      { table: "service_resources", column: "resource_id" },
    ],
  },
};

// productSpec (LocationDeletion.php 155-166): i prodotti mappano per giacenza.
const locationProductSpec: LocationMappingSpec = {
  table: "products",
  labelColumn: "name",
  mapping: "product_stocks",
  mappingColumn: "product_id",
  children: [
    { table: "product_stocks", column: "product_id" },
    { table: "product_images", column: "product_id" },
  ],
};

// clientActivitySpecs (LocationDeletion.php 274-287): tabelle e pesi con cui
// scegliere la sede residua migliore per ogni cliente.
const clientActivitySpecs: Array<{
  table: string;
  clientColumns: string[];
  dateColumns: string[];
  priority: number;
  futurePriority?: number;
  futureColumn?: string;
  futureStatusColumn?: string;
}> = [
  { table: "appointments", clientColumns: ["client_id"], dateColumns: ["starts_at", "created_at"], priority: 200, futurePriority: 300, futureColumn: "starts_at", futureStatusColumn: "status" },
  { table: "sales", clientColumns: ["client_id"], dateColumns: ["sale_date", "created_at"], priority: 200 },
  { table: "quotes", clientColumns: ["client_id"], dateColumns: ["quote_date", "created_at"], priority: 150 },
  { table: "client_packages", clientColumns: ["client_id"], dateColumns: ["start_date", "purchase_date", "created_at"], priority: 120 },
  { table: "giftcards", clientColumns: ["client_id", "recipient_client_id"], dateColumns: ["issued_at", "created_at", "redeemed_at"], priority: 120 },
  { table: "giftbox_instances", clientColumns: ["client_id", "recipient_client_id"], dateColumns: ["issued_at", "created_at", "redeemed_at"], priority: 120 },
  { table: "gift_instances", clientColumns: ["client_id"], dateColumns: ["unlocked_at", "redeemed_at", "created_at"], priority: 120 },
  { table: "recharges", clientColumns: ["client_id"], dateColumns: ["created_at"], priority: 80 },
  { table: "credit_adjustments", clientColumns: ["client_id"], dateColumns: ["created_at"], priority: 80 },
  { table: "transactions", clientColumns: ["client_id"], dateColumns: ["created_at"], priority: 80 },
];

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
      unavailableMessage: "Funzione non disponibile per il tuo account",
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
  // (int) PHP: parse a prefisso ('12abc' -> 12, 'abc' -> 0), non Number().
  let cancelValue = parseInt(String(input.booking_customer_cancel_before_value ?? 0), 10) || 0;
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

// setting_get('name') legacy: nome attività dalla prima riga businesses.
export async function getBusinessName(slug: string): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "name", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.name ?? "").trim();
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

// Port di business_profile.php action=save_profile_activity: messaggi legacy
// verbatim ("attività"/"può" accentate ma "puo" del Chi siamo NON accentato,
// quirk del sorgente) e validazione lunghezza PRIMA di salvare — niente
// clean(190) che troncava rendendo irraggiungibile l'errore dei 190 caratteri.
export async function saveBusinessProfile(slug: string, input: Record<string, string>, publicOrigin = "") {
  const name = String(input.business_name ?? input.name ?? "").trim();
  const aboutText = String(input.booking_about_text ?? input.aboutText ?? "").trim();
  if (!name) throw new Error("Inserisci il nome attività.");
  if (stringLength(name) > 190) throw new Error("Il nome attività può contenere al massimo 190 caratteri.");
  if (stringLength(aboutText) > 3000) throw new Error("Il testo Chi siamo puo contenere al massimo 3000 caratteri.");

  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato");

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
  // Flash del redirect legacy: index.php?page=business_profile&msg=...
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Profilo attività salvato" };
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
  // Sync marketplace BEST-EFFORT come il legacy (business_profile.php 157-158,
  // strict=false): un errore di sync non fa fallire il salvataggio posizione.
  await syncMarketplaceProfile(slug, publicOrigin).catch(() => undefined);
  return {
    ...await getBusinessSettingsContext(slug, publicOrigin),
    message: kind === "logo" ? "Posizione logo salvata" : "Posizione copertina salvata",
  };
}

// Ordine guardie e messaggi legacy esatti (business_profile.php upload_* +
// process_uploaded_logo/branding_image, SENZA punto finale): prima
// "Rimuovi ... attuale", poi "Seleziona un file", poi size/formato.
export async function uploadBusinessBrandingImage(slug: string, kind: "logo" | "cover", file: File | null, publicOrigin = "") {
  const business = await firstBusinessRow(slug);
  if (!business) throw new Error("Business non trovato.");
  const currentPath = clean(String(kind === "logo" ? business.logo_path ?? "" : business.cover_path ?? ""), 255);
  if (currentPath) {
    throw new Error(kind === "logo" ? "Rimuovi il logo attuale prima di caricarne uno nuovo." : "Rimuovi la copertina attuale prima di caricarne una nuova.");
  }
  if (!file) throw new Error(kind === "logo" ? "Seleziona un file (JPG o PNG) da caricare." : "Seleziona un file immagine da caricare.");
  if (file.size <= 0) throw new Error("Upload non valido");
  if (file.size > 5 * 1024 * 1024) throw new Error(kind === "logo" ? "Logo troppo grande (max 5 MB)" : "Immagine di copertina troppo grande (max 5 MB)");
  // Tipo AUTORITATIVO dal contenuto (magic bytes), come getimagesize legacy:
  // il type dichiarato dal browser viene ignorato.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffedMime = sniffImageMime(bytes);
  if (!sniffedMime) throw new Error("Formato immagine non supportato");
  if (kind === "logo" && !["image/jpeg", "image/png"].includes(sniffedMime)) {
    throw new Error("Formato non valido: carica un file JPG o PNG");
  }
  if (kind === "cover" && !imageMimeToExt[sniffedMime]) throw new Error("Formato non valido");

  // Cloudflare R2 PUBBLICO (come foto staff / immagini prodotto): su Amplify il
  // filesystem è effimero, quindi il branding vive su R2 e nel DB si salva
  // l'URL pubblico completo (publicAssetUrl/withOrigin fanno pass-through degli
  // URL assoluti). I vecchi path /uploads/... restano leggibili finché non
  // vengono sostituiti.
  if (!storageConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
  const ext = imageMimeToExt[sniffedMime] ?? "jpg";
  const target = await tenantTable(slug, "businesses");
  const key = tenantStorageKey(
    Number(target.tenantId ?? 0),
    "branding",
    kind === "logo" ? `logo-${Number(business.id ?? 1)}-${Date.now()}.${ext}` : `cover-${Date.now()}.${ext}`,
  );
  const publicPath = await putPublicObject(key, bytes, sniffedMime);

  const values: Record<string, unknown> = kind === "logo"
    ? { logo_path: publicPath, logo_position_x: 50, logo_position_y: 50 }
    : { cover_path: publicPath, cover_position_x: 50, cover_position_y: 50 };
  if (kind === "logo") {
    if (await columnExists(target.name, "logo_blob")) values.logo_blob = null;
    if (await columnExists(target.name, "logo_mime")) values.logo_mime = null;
    if (await columnExists(target.name, "logo_updated_at")) values.logo_updated_at = null;
  }

  await tenantUpdate({ slug, table: "businesses", id: Number(business.id ?? 0), values });
  // strict=false come il legacy (business_profile.php 134-135): il sync
  // marketplace non deve far fallire un upload riuscito.
  await syncMarketplaceProfile(slug, publicOrigin).catch(() => undefined);
  return {
    ...await getBusinessSettingsContext(slug, publicOrigin),
    message: kind === "logo" ? "Logo salvato" : "Immagine di copertina salvata",
  };
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
  // strict=false come il legacy (business_profile.php 168-169).
  await syncMarketplaceProfile(slug, publicOrigin).catch(() => undefined);
  return {
    ...await getBusinessSettingsContext(slug, publicOrigin),
    message: kind === "logo" ? "Logo rimosso" : "Immagine di copertina rimossa",
  };
}

export async function saveBusinessLocation(slug: string, input: Record<string, string>, publicOrigin = "") {
  const tenant = await getTenant(slug);
  const bookingPublicAllowed = Boolean(Number(tenant?.booking_public_allowed ?? 1));
  const target = await tenantTable(slug, "locations");
  const id = parseInteger(input.id, 0);
  const data = normalizeLocationPayload(input);

  if (!bookingPublicAllowed && data.booking_enabled === 1) throw new Error("Funzione non disponibile per il tuo account");
  if (!bookingPublicAllowed) {
    data.booking_enabled = id > 0 ? await currentLocationBookingEnabled(slug, id) : 0;
  }

  // GATE PIANO (Fase E SaaS Admin, 2026-07-19): se il tenant ha un piano con
  // limite sedi, la CREAZIONE oltre il limite viene bloccata. Nessun piano o
  // limite NULL = illimitato (comportamento invariato per i tenant esistenti).
  if (id <= 0) {
    const { tenantPlanMaxLocations } = await import("@/lib/saas-plans");
    const maxLocations = await tenantPlanMaxLocations(slug);
    if (maxLocations !== null) {
      const activeRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "locations",
        columns: "COUNT(*) AS count",
        where: "COALESCE(is_active,1) = 1",
        params: [],
      });
      if (Number(activeRows[0]?.count ?? 0) >= maxLocations) {
        throw new Error("Limite sedi del piano raggiunto: contatta l'assistenza per un upgrade");
      }
    }
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
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Sede salvata" };
}

export async function moveBusinessLocation(slug: string, locationId: number, direction: "up" | "down", publicOrigin = "") {
  const target = await tenantTable(slug, "locations");
  // Messaggio verbatim locations.php 367.
  if (!await columnExists(target.name, "sort_order")) throw new Error("Per ordinare le sedi importa il dump SQL completo aggiornato.");
  // sede_move_location legacy (locations.php 253-292): normalize + swap DENTRO
  // una transazione (rollback su errore).
  let moved = false;
  await withTenantTransaction(slug, async (q) => {
    const rows = await normalizeLocationOrder(slug, q);
    const index = rows.findIndex((row) => Number(row.id ?? 0) === locationId);
    if (index < 0) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    const scopeA = await tenantScope(target, ["id = ?"], [Number(rows[index].id)]);
    await q(`UPDATE ${quoteIdentifier(target.name)} SET sort_order = ${Number(rows[targetIndex].sort_order ?? 0)}${scopeA.where}`, scopeA.params);
    const scopeB = await tenantScope(target, ["id = ?"], [Number(rows[targetIndex].id)]);
    await q(`UPDATE ${quoteIdentifier(target.name)} SET sort_order = ${Number(rows[index].sort_order ?? 0)}${scopeB.where}`, scopeB.params);
    moved = true;
  });
  // Flash legacy: msg='Ordine sedi aggiornato' se spostata, msg='La sede e gia
  // in posizione limite.' altrimenti (entrambi SUCCESS in locations.php 372).
  if (!moved) return { ...await getBusinessSettingsContext(slug, publicOrigin), moved: false, message: "La sede e gia in posizione limite." };
  await syncMarketplaceProfile(slug, publicOrigin);
  return { ...await getBusinessSettingsContext(slug, publicOrigin), moved: true, message: "Ordine sedi aggiornato" };
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
    if (enabled === 1) throw new Error("Funzione non disponibile per il tuo account");
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
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Marketplace sede aggiornato" };
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
    // Magic bytes autoritativi (getimagesize legacy), mai il type dichiarato.
    const galleryBytes = new Uint8Array(await file.arrayBuffer());
    const galleryMime = sniffImageMime(galleryBytes);
    if (!galleryMime) throw new Error("Formato immagine non supportato");
    const ext = galleryMimeToExt[galleryMime];
    if (!ext) throw new Error("Formato non valido: carica JPG, PNG o WEBP");
    if (!storageConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);
    const stamp = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const ymdhis = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}`;
    const rand = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    // R2 pubblico: nel DB va l'URL completo (i path legacy /uploads restano validi).
    const key = tenantStorageKey(Number(table.tenantId ?? 0), "branding", `locations-${locationId}-gallery-${ymdhis}_${rand}.${ext}`);
    const publicPath = await putPublicObject(key, galleryBytes, galleryMime);
    const sortRows = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "COALESCE(MAX(sort_order), 0) AS m", where: "location_id = ?", params: [locationId] }).catch(() => [] as RowDataPacket[]);
    await tenantInsert(table, { location_id: locationId, path: publicPath, sort_order: Number(sortRows[0]?.m ?? 0) + 10, is_active: 1 });
  }
  await syncMarketplaceProfile(slug, publicOrigin);
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Foto gallery sede caricate", uploaded: valid.length };
}

export async function deleteLocationGalleryImage(slug: string, locationId: number, imageId: number, publicOrigin = "") {
  // Guardie di delete_location_gallery_image (Helpers.php 11854-11868), verbatim.
  if (locationId <= 0) throw new Error("Sede non valida");
  if (imageId <= 0) throw new Error("Foto gallery non valida");
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
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Foto gallery sede rimossa" };
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
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Ordine gallery sede aggiornato" };
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

  // Sezioni exclusive/shared del LocationDeletion (preview 513-526): per ogni
  // gruppo i master mappati SOLO a questa sede (eliminati) vs anche altrove
  // (mantenuti, staccata solo la mappatura). Gruppi vuoti filtrati via.
  const exclusive: Record<string, Record<string, string>> = {};
  const shared: Record<string, Record<string, string>> = {};
  for (const [key, spec] of Object.entries({ ...locationMappingSpecs, products: locationProductSpec })) {
    const exclusiveIds = await exclusiveMappedIds(slug, spec, locationId);
    const sharedIds = await sharedMappedIds(slug, spec, locationId);
    const exclusiveLabels = await entityLabels(slug, spec.table, spec.labelColumn, exclusiveIds);
    const sharedLabels = await entityLabels(slug, spec.table, spec.labelColumn, sharedIds);
    if (Object.keys(exclusiveLabels).length) exclusive[key] = exclusiveLabels;
    if (Object.keys(sharedLabels).length) shared[key] = sharedLabels;
  }
  const clients = await clientsForLocationDeletion(slug, locationId);
  if (Object.keys(clients.shared).length) shared.clients = clients.shared;

  return {
    ok: true,
    location,
    activeCount: locationCount,
    locationCount,
    canDelete,
    deleteBlockReason: locationCount <= 1
      ? "Deve restare almeno una sede."
      : (Object.keys(blockingCounts).length ? "La sede contiene storico operativo o contabile. Archiviala/nascondila o sposta prima i dati storici: non viene eliminata per evitare perdita di dati." : ""),
    blockingCounts,
    directCounts,
    exclusive,
    shared,
    clientReassignments: clients.reassignments,
    confirmText: "ELIMINA",
  };
}

export async function deleteBusinessLocation(slug: string, locationId: number, confirmText: string, reason = "", publicOrigin = "") {
  // Ordine legacy (locations.php 488 PRIMA di LocationDeletion::delete): id
  // non valido -> 'Sede non valida.', poi la conferma ELIMINA (case-sensitive).
  if (locationId <= 0) throw new Error("Sede non valida.");
  if (confirmText.trim() !== "ELIMINA") throw new Error("Conferma non valida.");
  const preview = await previewLocationDelete(slug, locationId);
  if (!preview.ok) throw new Error(preview.error ?? "Sede non trovata.");
  if (!preview.canDelete) throw new Error(preview.deleteBlockReason || "Sede non eliminabile in sicurezza.");

  await ensureLocationDeletionLogTables(slug);
  const locationName = clean(String(preview.location?.name ?? `Sede #${locationId}`), 190);
  const deleted: Record<string, number> = {};
  // LocationDeletion 591-599: i file della gallery vengono eliminati PRIMA
  // delle righe (oggetti R2 / path legacy, best-effort NON transazionale —
  // come il delete_local_upload legacy dentro il try).
  const galleryRows = await tenantSelect<RowDataPacket>({ slug, table: "location_gallery_images", columns: "path", where: "location_id = ?", params: [locationId] }).catch(() => [] as RowDataPacket[]);
  for (const row of galleryRows) {
    const storedPath = String(row.path ?? "");
    const key = storageKeyFromPublicUrl(storedPath);
    if (key) await deletePublicObject(key).catch(() => undefined);
    else await deletePublicUpload(storedPath).catch(() => undefined);
  }

  // CASCATA ATOMICA come il legacy (LocationDeletion 557-646: beginTransaction
  // -> log + cleanup + master/mappature + riassegnazione clienti + delete sede
  // + reorder + log items -> commit, rollback su QUALSIASI errore): mai una
  // sede semi-svuotata.
  const logsTable = await tenantTable(slug, "location_deletion_logs");
  const locationsTable = await tenantTable(slug, "locations");
  await withTenantTransaction(slug, async (q) => {
    const exec = txExec(q);
    const inserted = await q(
      `INSERT INTO ${quoteIdentifier(logsTable.name)} (location_id, location_name, reason, summary_json, deleted_by) VALUES (?, ?, ?, ?, NULL) RETURNING id`,
      [locationId, locationName, emptyToNull(reason), JSON.stringify(preview)],
    );
    const logId = Number(inserted[0]?.id ?? 0);
    for (const table of locationCleanupTables) {
      const count = await deleteRowsWithLocation(slug, table, locationId, exec);
      if (count > 0) deleted[table] = (deleted[table] ?? 0) + count;
    }
    await deleteLocationActivityCategories(slug, locationId, exec);

    // LocationDeletion 604-624: per ogni gruppo stacca le mappature dei master
    // CONDIVISI e cancella i master ESCLUSIVI con i figli (gifts = grafo dedicato,
    // prodotti via productSpec). Ids presi dal preview appena calcolato.
    const exclusiveGroups = (preview.exclusive ?? {}) as Record<string, Record<string, string>>;
    const sharedGroups = (preview.shared ?? {}) as Record<string, Record<string, string>>;
    for (const [key, spec] of Object.entries(locationMappingSpecs)) {
      const exclusiveIds = Object.keys(exclusiveGroups[key] ?? {}).map(Number).filter((id) => id > 0);
      const sharedIds = Object.keys(sharedGroups[key] ?? {}).map(Number).filter((id) => id > 0);
      if (sharedIds.length) {
        const count = await deleteMappingRowsForLocation(slug, spec, locationId, sharedIds, exec);
        if (count > 0) deleted[spec.mapping] = (deleted[spec.mapping] ?? 0) + count;
      }
      if (exclusiveIds.length) {
        await deleteMappedMasters(slug, spec, exclusiveIds, deleted, exec);
      }
    }
    const productExclusive = Object.keys(exclusiveGroups.products ?? {}).map(Number).filter((id) => id > 0);
    const productShared = Object.keys(sharedGroups.products ?? {}).map(Number).filter((id) => id > 0);
    if (productShared.length) {
      const count = await deleteMappingRowsForLocation(slug, locationProductSpec, locationId, productShared, exec);
      if (count > 0) deleted.product_stocks = (deleted.product_stocks ?? 0) + count;
    }
    if (productExclusive.length) {
      await deleteMappedMasters(slug, locationProductSpec, productExclusive, deleted, exec);
    }

    // RIASSEGNAZIONE CLIENTI (LocationDeletion 626-634 + 698-720): piano del
    // preview (sede con più attività) con ricalcolo/fallback per-cliente; mai
    // lasciare location_id orfani.
    const clientIds = Object.keys(sharedGroups.clients ?? {}).map(Number).filter((id) => id > 0);
    if (clientIds.length) {
      const planned = (preview.clientReassignments ?? {}) as Record<string, { location_id?: number }>;
      const result = await reassignSharedClientLocations(slug, clientIds, locationId, planned, exec);
      if (result.reassigned > 0) deleted.clients_reassigned = result.reassigned;
      if (result.withoutLocation > 0) deleted.clients_without_location = result.withoutLocation;
    }

    const locScope = await tenantScope(locationsTable, ["id = ?"], [locationId]);
    await q(`DELETE FROM ${quoteIdentifier(locationsTable.name)}${locScope.where}`, locScope.params);
    deleted.locations = (deleted.locations ?? 0) + 1;
    await normalizeLocationOrder(slug, q);
    await logLocationDeletionItems(slug, logId, preview, deleted, q);
  });
  await syncMarketplaceProfile(slug, publicOrigin);
  return { ...await getBusinessSettingsContext(slug, publicOrigin), message: "Sede eliminata definitivamente" };
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

// Marketplace::activityCategoryIconSvg (Marketplace.php 556-609): icona
// Bootstrap per icon_key, default bi-grid-3x3-gap.
const activityIconClasses: Record<string, string> = {
  hair: "bi-scissors", capelli: "bi-scissors", parrucchiere: "bi-scissors",
  beauty: "bi-shop", "salone-bellezza": "bi-shop",
  sparkles: "bi-stars", estetica: "bi-stars", estetista: "bi-stars",
  barber: "bi-person-badge", barbiere: "bi-person-badge",
  nails: "bi-hand-index-thumb", unghie: "bi-hand-index-thumb",
  eye: "bi-eye", sopracciglia: "bi-eye", "sopracciglia-ciglia": "bi-eye",
  epilation: "bi-magic", epilazione: "bi-magic", laser: "bi-magic",
  massage: "bi-person-heart", massaggi: "bi-person-heart",
  spa: "bi-water", benessere: "bi-water", "spa-sauna": "bi-water",
  medspa: "bi-gem",
  sun: "bi-brightness-high", solarium: "bi-brightness-high", "centro-abbronzatura": "bi-brightness-high",
  tattoo: "bi-gem", tatuaggi: "bi-gem", "tatuaggi-piercing": "bi-gem",
  physio: "bi-heart-pulse", fisioterapia: "bi-heart-pulse",
  fitness: "bi-bicycle", "fitness-recupero": "bi-bicycle",
  health: "bi-hospital", "centro-sanitario": "bi-hospital", odontoiatria: "bi-hospital",
  pet: "bi-heart", "toelettatura-animali": "bi-heart",
  podologia: "bi-universal-access",
  viso: "bi-emoji-smile",
  rimodellamento: "bi-activity",
  corpo: "bi-person",
  trucco: "bi-palette",
  sposa: "bi-gem",
  olistico: "bi-flower1",
  trattamenti: "bi-stars",
};

export function activityCategoryIconClass(iconKey: string): string {
  return activityIconClasses[iconKey.trim().toLowerCase()] ?? "bi-grid-3x3-gap";
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
    iconClass: activityCategoryIconClass(String(row.icon_key ?? "")),
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

async function deleteLocationActivityCategories(slug: string, locationId: number, exec: WriteExec = poolExec) {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId || !await tableExists("marketplace_location_activity_categories")) return;
  await exec("DELETE FROM marketplace_location_activity_categories WHERE tenant_id=? AND location_id=?", [tenantId, locationId]);
  if (await tableExists("tenant_directory_location_categories")) {
    await exec("DELETE FROM tenant_directory_location_categories WHERE tenant_id=? AND location_id=?", [tenantId, locationId]);
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

// Con `q` (transazione delete-sede / move) legge E scrive sul client
// transazionale: la lettura dal pool NON vedrebbe la sede appena cancellata
// (delete non committata) e la rimetterebbe in conteggio.
async function normalizeLocationOrder(slug: string, q?: TenantTxQuery) {
  const target = await tenantTable(slug, "locations");
  const scope = await tenantScope(target, [], []);
  const sql = `SELECT id, COALESCE(sort_order,999999) AS sort_order FROM ${quoteIdentifier(target.name)}${scope.where} ORDER BY COALESCE(sort_order,999999) ASC, id ASC`;
  const rows = q
    ? await q<RowDataPacket>(sql, scope.params)
    : await dbQuery<RowDataPacket[]>(sql, scope.params);
  for (const [pos, row] of rows.entries()) {
    if (Number(row.sort_order ?? -1) !== pos) {
      const upScope = await tenantScope(target, ["id = ?"], [Number(row.id ?? 0)]);
      const upSql = `UPDATE ${quoteIdentifier(target.name)} SET sort_order = ${pos}${upScope.where}`;
      if (q) await q(upSql, upScope.params);
      else await dbExecute(upSql, upScope.params);
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

async function deleteRowsWithLocation(slug: string, table: string, locationId: number, exec: WriteExec = poolExec) {
  if (!await tableExistsForTenant(slug, table)) return 0;
  const target = await tenantTable(slug, table);
  if (!await columnExists(target.name, "location_id")) return 0;
  const scope = await tenantScope(target, ["location_id = ?"], [locationId]);
  return exec(`DELETE FROM ${quoteIdentifier(target.name)}${scope.where}`, scope.params);
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

// Esecutore scritture della cascata delete-sede: di default il pool
// (dbExecute); DENTRO withTenantTransaction è il client transazionale, con le
// righe toccate contate via RETURNING (in PG affectedRows richiede RETURNING
// sul client raw). Le letture di catalogo (tableExists/columnExists/tenantScope)
// restano sul pool: non dipendono dallo stato non committato.
type WriteExec = (sql: string, params: unknown[]) => Promise<number>;
const poolExec: WriteExec = async (sql, params) => (await dbExecute(sql, params)).affectedRows;
function txExec(q: TenantTxQuery): WriteExec {
  return async (sql, params) => {
    const needsReturning = /^\s*(delete|update)\s/i.test(sql) && !/\breturning\b/i.test(sql);
    const rows = await q(needsReturning ? `${sql} RETURNING 1 AS one` : sql, params);
    return rows.length;
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

// NB: l'insert del log di eliminazione ora vive DENTRO la transazione di
// deleteBusinessLocation (come il legacy: rollback = niente log fantasma).

// exclusiveMappedIds (LocationDeletion.php 182-200): master con mappature SOLO
// verso la sede eliminata. In PG l'HAVING non può usare gli alias del SELECT.
async function exclusiveMappedIds(slug: string, spec: LocationMappingSpec, locationId: number) {
  return mappedIdsByShare(slug, spec, locationId, "COUNT(*) = SUM(CASE WHEN location_id = ? THEN 1 ELSE 0 END)");
}

// sharedMappedIds (202-220): mappati a questa sede E ad altre.
async function sharedMappedIds(slug: string, spec: LocationMappingSpec, locationId: number) {
  return mappedIdsByShare(slug, spec, locationId, "COUNT(*) > SUM(CASE WHEN location_id = ? THEN 1 ELSE 0 END)");
}

async function mappedIdsByShare(slug: string, spec: LocationMappingSpec, locationId: number, totalClause: string) {
  if (!await tableExistsForTenant(slug, spec.mapping)) return [] as number[];
  const target = await tenantTable(slug, spec.mapping);
  if (!await columnExists(target.name, spec.mappingColumn) || !await columnExists(target.name, "location_id")) return [] as number[];
  const scope = await tenantScope(target, [], []);
  const col = quoteIdentifier(spec.mappingColumn);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT ${col} AS entity_id
       FROM ${quoteIdentifier(target.name)}${scope.where}
      GROUP BY ${col}
     HAVING SUM(CASE WHEN location_id = ? THEN 1 ELSE 0 END) > 0 AND ${totalClause}`,
    [...scope.params, locationId, locationId],
  ).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => Number(row.entity_id ?? 0)).filter((id) => id > 0);
}

// labels (222-237): id -> etichetta, fallback '<tabella> #<id>'.
async function entityLabels(slug: string, table: string, labelColumn: string, ids: number[]) {
  const out: Record<string, string> = {};
  const unique = Array.from(new Set(ids.filter((id) => id > 0)));
  if (!unique.length || !await tableExistsForTenant(slug, table)) return out;
  const target = await tenantTable(slug, table);
  const select = await columnExists(target.name, labelColumn) ? quoteIdentifier(labelColumn) : "id";
  const scope = await tenantScope(target, [`id IN (${unique.map(() => "?").join(",")})`], unique);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id, ${select} AS label FROM ${quoteIdentifier(target.name)}${scope.where}`,
    scope.params,
  ).catch(() => [] as RowDataPacket[]);
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    if (id > 0) out[String(id)] = String(row.label ?? "").trim() || `${table} #${id}`;
  }
  return out;
}

// clientsForLocation (239-272): i clienti della sede sono sempre 'shared' con
// un piano di riassegnazione (sede con più attività, fallback prima residua).
async function clientsForLocationDeletion(slug: string, locationId: number) {
  const out = { shared: {} as Record<string, string>, reassignments: {} as Record<string, Record<string, unknown>> };
  if (!await tableExistsForTenant(slug, "clients")) return out;
  const clientsTable = await tenantTable(slug, "clients");
  if (!await columnExists(clientsTable.name, "location_id")) return out;
  const fallback = await fallbackClientReassignmentLocation(slug, locationId);
  const cols = ["id"];
  for (const col of ["full_name", "first_name", "last_name", "name"]) {
    if (await columnExists(clientsTable.name, col)) cols.push(col);
  }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: Array.from(new Set(cols)).join(","), where: "location_id = ?", params: [locationId] }).catch(() => [] as RowDataPacket[]);
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    if (id <= 0) continue;
    let label = String(row.full_name ?? row.name ?? "").trim();
    if (!label) label = `${String(row.first_name ?? "").trim()} ${String(row.last_name ?? "").trim()}`.trim();
    if (!label) label = `Cliente #${id}`;
    out.shared[String(id)] = label;
    const best = await bestClientReassignmentLocation(slug, id, locationId) ?? fallback;
    if (best) out.reassignments[String(id)] = { client_id: id, client_label: label, ...best };
  }
  return out;
}

async function remainingLocationsForDeletion(slug: string, excludeLocationId: number) {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id, name, COALESCE(sort_order,999999) AS sort_order",
    where: excludeLocationId > 0 ? "id <> ?" : "",
    params: excludeLocationId > 0 ? [excludeLocationId] : [],
    orderBy: "COALESCE(sort_order,999999) ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const out = new Map<number, { id: number; name: string; sort_order: number }>();
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    if (id > 0) out.set(id, { id, name: String(row.name ?? "").trim() || `Sede #${id}`, sort_order: Number(row.sort_order ?? 999999) });
  }
  return out;
}

async function fallbackClientReassignmentLocation(slug: string, deletedLocationId: number) {
  const locations = await remainingLocationsForDeletion(slug, deletedLocationId);
  const first = locations.values().next().value;
  if (!first) return null;
  return { location_id: first.id, location_name: first.name, sort_order: first.sort_order, priority: 0, activity_count: 0, last_activity: "" };
}

// bestClientReassignmentLocation (388-481): candida ogni sede residua con
// priorità per tipo attività (appuntamenti FUTURI pending/scheduled pesano di
// più), poi ultima attività, conteggio, sort_order, id.
async function bestClientReassignmentLocation(slug: string, clientId: number, deletedLocationId: number) {
  const locations = await remainingLocationsForDeletion(slug, deletedLocationId);
  if (clientId <= 0 || deletedLocationId <= 0 || !locations.size) return null;
  const candidates = new Map<number, { location_id: number; location_name: string; sort_order: number; priority: number; activity_count: number; last_activity: string }>();

  for (const spec of clientActivitySpecs) {
    if (!await tableExistsForTenant(slug, spec.table)) continue;
    const target = await tenantTable(slug, spec.table);
    if (!await columnExists(target.name, "location_id")) continue;
    const clientColumns: string[] = [];
    for (const col of spec.clientColumns) {
      if (await columnExists(target.name, col)) clientColumns.push(col);
    }
    if (!clientColumns.length) continue;

    const dateParts: string[] = [];
    for (const col of spec.dateColumns) {
      if (await columnExists(target.name, col)) dateParts.push(`COALESCE(t.${quoteIdentifier(col)}::timestamp, TIMESTAMP '1970-01-01 00:00:00')`);
    }
    const dateExpr = dateParts.length === 0 ? "TIMESTAMP '1970-01-01 00:00:00'" : (dateParts.length === 1 ? dateParts[0] : `GREATEST(${dateParts.join(",")})`);

    let futureExpr = "0";
    if (spec.futureColumn && await columnExists(target.name, spec.futureColumn)) {
      let statusSql = "";
      if (spec.futureStatusColumn && await columnExists(target.name, spec.futureStatusColumn)) {
        statusSql = ` AND COALESCE(t.${quoteIdentifier(spec.futureStatusColumn)},'') IN ('pending','scheduled')`;
      }
      futureExpr = `CASE WHEN t.${quoteIdentifier(spec.futureColumn)} >= NOW()${statusSql} THEN 1 ELSE 0 END`;
    }

    const clientWhere = clientColumns.map((col) => `t.${quoteIdentifier(col)} = ?`).join(" OR ");
    const params: unknown[] = [...clientColumns.map(() => clientId)];
    const clauses = [`(${clientWhere})`, "t.location_id > 0", "t.location_id <> ?"];
    params.push(deletedLocationId);
    if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
      clauses.unshift("t.tenant_id = ?");
      params.unshift(target.tenantId ?? 0);
    }
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT t.location_id,
              COUNT(*) AS activity_count,
              MAX(${dateExpr}) AS last_activity,
              MAX(${futureExpr}) AS future_activity
         FROM ${quoteIdentifier(target.name)} t
        WHERE ${clauses.join(" AND ")}
        GROUP BY t.location_id`,
      params,
    ).catch(() => [] as RowDataPacket[]);

    for (const row of rows) {
      const locId = Number(row.location_id ?? 0);
      const location = locations.get(locId);
      if (!location) continue;
      let priority = spec.priority;
      if (Number(row.future_activity ?? 0) > 0 && spec.futurePriority) priority = Math.max(priority, spec.futurePriority);
      const current = candidates.get(locId) ?? { location_id: locId, location_name: location.name, sort_order: location.sort_order, priority: 0, activity_count: 0, last_activity: "" };
      current.priority = Math.max(current.priority, priority);
      current.activity_count += Number(row.activity_count ?? 0);
      const lastActivity = normalizeActivityTimestamp(row.last_activity);
      if (lastActivity && lastActivity > current.last_activity) current.last_activity = lastActivity;
      candidates.set(locId, current);
    }
  }

  if (!candidates.size) return null;
  const items = Array.from(candidates.values()).sort((a, b) =>
    (b.priority - a.priority)
    || (Date.parse(b.last_activity || "1970-01-01") - Date.parse(a.last_activity || "1970-01-01"))
    || (b.activity_count - a.activity_count)
    || (a.sort_order - b.sort_order)
    || (a.location_id - b.location_id));
  const best = items[0];
  // Il modale mostra last_activity com'è: formato d/m/Y H:i come la view legacy.
  return { ...best, last_activity: best.last_activity ? formatActivityDmy(best.last_activity) : "" };
}

function normalizeActivityTimestamp(value: unknown): string {
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  return String(value ?? "").trim();
}

function formatActivityDmy(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw);
  if (!m) return raw;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}

// deleteMappingRows (654-659): stacca le mappature della sede per i CONDIVISI.
async function deleteMappingRowsForLocation(slug: string, spec: LocationMappingSpec, locationId: number, ids: number[], exec: WriteExec = poolExec) {
  if (!ids.length || !await tableExistsForTenant(slug, spec.mapping)) return 0;
  const target = await tenantTable(slug, spec.mapping);
  const scope = await tenantScope(target, [`location_id = ?`, `${quoteIdentifier(spec.mappingColumn)} IN (${ids.map(() => "?").join(",")})`], [locationId, ...ids]);
  return exec(`DELETE FROM ${quoteIdentifier(target.name)}${scope.where}`, scope.params);
}

async function deleteByIdsScoped(slug: string, table: string, ids: number[], column = "id", exec: WriteExec = poolExec) {
  const unique = Array.from(new Set(ids.filter((id) => id > 0)));
  if (!unique.length || !await tableExistsForTenant(slug, table)) return 0;
  const target = await tenantTable(slug, table);
  if (!await columnExists(target.name, column)) return 0;
  const scope = await tenantScope(target, [`${quoteIdentifier(column)} IN (${unique.map(() => "?").join(",")})`], unique);
  return exec(`DELETE FROM ${quoteIdentifier(target.name)}${scope.where}`, scope.params);
}

// deleteMappedMasters (661-675): figli poi master; i gifts passano dal grafo.
async function deleteMappedMasters(slug: string, spec: LocationMappingSpec, ids: number[], deleted: Record<string, number>, exec: WriteExec = poolExec) {
  if (spec.table === "gifts") {
    await deleteGiftGraphForLocation(slug, ids, deleted, exec);
    return;
  }
  for (const child of spec.children) {
    const count = await deleteByIdsScoped(slug, child.table, ids, child.column, exec);
    if (count > 0) deleted[child.table] = (deleted[child.table] ?? 0) + count;
  }
  const count = await deleteByIdsScoped(slug, spec.table, ids, "id", exec);
  if (count > 0) deleted[spec.table] = (deleted[spec.table] ?? 0) + count;
}

// deleteGiftGraph (677-696): transazioni -> voci appuntamento -> reset ->
// istanze -> regole -> rule_sets -> mappature -> campagne.
async function deleteGiftGraphForLocation(slug: string, giftIds: number[], deleted: Record<string, number>, exec: WriteExec = poolExec) {
  const ids = Array.from(new Set(giftIds.filter((id) => id > 0)));
  if (!ids.length) return;
  const instanceRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "id", where: `gift_id IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
  const instanceIds = instanceRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const ruleSetRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_rule_sets", columns: "id", where: `gift_id IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
  const ruleSetIds = ruleSetRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);

  const steps: Array<[string, number[], string]> = [
    ["gift_transactions", instanceIds, "instance_id"],
    ["appointment_gift_items", ids, "gift_id"],
    ["gift_progress_resets", ids, "gift_id"],
    ["gift_instances", ids, "gift_id"],
    ["gift_rules", ruleSetIds, "rule_set_id"],
    ["gift_rule_sets", ids, "gift_id"],
    ["gift_locations", ids, "gift_id"],
    ["gifts", ids, "id"],
  ];
  for (const [table, stepIds, column] of steps) {
    if (!stepIds.length) continue;
    const count = await deleteByIdsScoped(slug, table, stepIds, column, exec);
    if (count > 0) deleted[table] = (deleted[table] ?? 0) + count;
  }
}

// reassignSharedClientLocations (698-720): piano del preview con ricalcolo di
// riserva; senza sede valida -> location_id NULL.
async function reassignSharedClientLocations(slug: string, clientIds: number[], deletedLocationId: number, planned: Record<string, { location_id?: number }>, exec: WriteExec = poolExec) {
  const out = { reassigned: 0, withoutLocation: 0 };
  const clientsTable = await tenantTable(slug, "clients");
  if (!await columnExists(clientsTable.name, "location_id")) return out;
  for (const clientId of Array.from(new Set(clientIds.filter((id) => id > 0)))) {
    let newLocationId = Number(planned[String(clientId)]?.location_id ?? 0);
    if (newLocationId <= 0 || newLocationId === deletedLocationId || !await locationExistsForTenant(slug, newLocationId)) {
      const recomputed = await bestClientReassignmentLocation(slug, clientId, deletedLocationId);
      newLocationId = Number(recomputed?.location_id ?? 0);
    }
    if (newLocationId > 0 && newLocationId !== deletedLocationId && await locationExistsForTenant(slug, newLocationId)) {
      const scope = await tenantScope(clientsTable, ["id = ?", "location_id = ?"], [clientId, deletedLocationId]);
      out.reassigned += await exec(`UPDATE ${quoteIdentifier(clientsTable.name)} SET location_id = ${newLocationId}${scope.where}`, scope.params);
    } else {
      const scope = await tenantScope(clientsTable, ["id = ?", "location_id = ?"], [clientId, deletedLocationId]);
      out.withoutLocation += await exec(`UPDATE ${quoteIdentifier(clientsTable.name)} SET location_id = NULL${scope.where}`, scope.params);
    }
  }
  return out;
}

async function locationExistsForTenant(slug: string, locationId: number) {
  if (locationId <= 0) return false;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", where: "id = ?", params: [locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

// logItems (733-762): conteggi per tabella + voce per ogni entita esclusiva
// (delete_master) / condivisa (detach_location; clients = reassign_location con
// il piano nel meta).
async function logLocationDeletionItems(slug: string, logId: number, preview: Record<string, unknown>, deleted: Record<string, number>, q?: TenantTxQuery) {
  if (logId <= 0 || !await tableExistsForTenant(slug, "location_deletion_log_items")) return;
  const table = await tenantTable(slug, "location_deletion_log_items");
  // In transazione niente catch per-insert (in PG un errore aborta comunque la
  // tx, come il logItems legacy dentro il beginTransaction).
  const insert = async (values: Record<string, unknown>) => {
    if (q) {
      await q(
        `INSERT INTO ${quoteIdentifier(table.name)} (log_id, group_name, table_name, entity_id, entity_label, action, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [values.log_id, values.group_name, values.table_name, values.entity_id, values.entity_label, values.action, values.meta_json],
      );
      return 1;
    }
    return tenantInsert(table, values).catch(() => 0);
  };
  for (const [tableName, count] of Object.entries(deleted)) {
    if (count <= 0) continue;
    await insert({ log_id: logId, group_name: "deleted_count", table_name: tableName, entity_id: null, entity_label: null, action: "delete", meta_json: JSON.stringify({ count }) });
  }
  const reassignments = (preview.clientReassignments ?? {}) as Record<string, unknown>;
  for (const [group, defaultAction] of [["exclusive", "delete_master"], ["shared", "detach_location"]] as const) {
    const groups = (preview[group] ?? {}) as Record<string, Record<string, string>>;
    for (const [tableName, rows] of Object.entries(groups)) {
      for (const [id, label] of Object.entries(rows)) {
        const action = group === "shared" && tableName === "clients" ? "reassign_location" : defaultAction;
        const meta = action === "reassign_location" ? JSON.stringify(reassignments[id] ?? {}) : null;
        await insert({ log_id: logId, group_name: group, table_name: tableName, entity_id: Number(id) || null, entity_label: label, action, meta_json: meta });
      }
    }
  }
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
    // Allow-list http/https: `javascript://x/%0aalert(1)` ha protocol+host e
    // passerebbe — renderizzato come href diretto sulla scheda marketplace
    // diventerebbe XSS-on-click per i visitatori.
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && Boolean(parsed.host);
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
