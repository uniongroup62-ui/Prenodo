import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { emptyToNull, parseInteger, parseNumber } from "@/lib/api-utils";
import {
  applyServiceNameSnapshotUpdates,
  applyServicePriceCatalogUpdates,
  fetchImpactedAppointments,
  freezeAppointmentSnapshots,
  freezeSoldServiceSnapshots,
  serviceDeactivationBlockers,
  serviceDeleteBlockersLegacy,
  serviceNameUpdateImpacts,
  servicePriceUpdateImpacts,
  serviceStatusMeta,
  type ImpactedAppointment,
  type ServiceImpactRow,
} from "@/lib/manage-services-impacts";

export { serviceDeleteBlockersLegacy, serviceStatusMeta };
export type { ServiceImpactRow };
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

export type ManageServiceContext = {
  ok: true;
  sourceMode: "database";
  featureFlags: {
    bookingPublicAllowed: boolean;
    marketplacePublicAllowed: boolean;
  };
  stats: {
    services: number;
    activeServices: number;
    categories: number;
    recommendedLinks: number;
  };
  services: ManageServiceRow[];
  categories: ServiceCategoryRow[];
  locations: ServiceLocationRow[];
  cabins: ServiceCabinRow[];
  staff: ServiceStaffRow[];
  resources: ServiceResourceRow[];
  marketplace: {
    taxonomyCategories: MarketplaceTaxonomyCategory[];
    categoryMappings: ServiceCategoryMarketplaceMapping[];
  };
};

export type ManageServiceRow = {
  id: number;
  name: string;
  durationMin: number;
  duration: string;
  priceValue: number;
  price: string;
  categoryId: number | null;
  categoryName: string;
  categoryImageUrl: string;
  cabinId: number | null;
  sortOrder: number;
  isActive: boolean;
  active: boolean;
  bookingEnabled: boolean;
  noOperator: boolean;
  locationIds: number[];
  cabinIds: number[];
  staffIds: number[];
  resources: Array<{ resourceId: number; qtyRequired: number }>;
  recommendationIds: number[];
  recoCount: number;
};

export type ServiceCategoryRow = {
  id: number;
  name: string;
  imageUrl: string;
  sortOrder: number;
  isDefault: boolean;
  serviceCount: number;
  marketplaceCategoryId: number | null;
  marketplaceCategorySlug: string;
  marketplaceCategoryName: string;
};

export type ServiceLocationRow = {
  id: number;
  name: string;
  isActive: boolean;
};

export type ServiceCabinRow = {
  id: number;
  name: string;
  isActive: boolean;
  locationId: number | null;
  position: number;
};

export type ServiceStaffRow = {
  id: number;
  fullName: string;
  email: string;
  isActive: boolean;
  locationIds: number[];
};

export type ServiceResourceRow = {
  id: number;
  name: string;
  qtyTotal: number;
};

export type MarketplaceTaxonomyCategory = {
  id: number;
  slug: string;
  name: string;
  sortOrder: number;
};

export type ServiceCategoryMarketplaceMapping = {
  tenantCategoryId: number;
  tenantCategoryName: string;
  marketplaceCategoryId: number | null;
  marketplaceCategorySlug: string;
  marketplaceCategoryName: string;
};

type NormalizedServiceInput = {
  id: number;
  name: string;
  durationMin: number;
  price: number;
  categoryId: number | null;
  isActive: boolean;
  bookingEnabled: boolean;
  noOperator: boolean;
  locationIds: number[];
  cabinIds: number[];
  staffIds: number[];
  resourceQty: Map<number, number>;
};


export async function getManageServicesContext(slug: string, options: { query?: string; locationId?: number; includeInactive?: boolean } = {}): Promise<ManageServiceContext> {
  const tenant = await getTenant(slug);
  const [locations, cabins, staff, resources, categories, mappings, taxonomyCategories] = await Promise.all([
    listServiceLocations(slug),
    listServiceCabins(slug),
    listServiceStaff(slug),
    listServiceResources(slug),
    listServiceCategories(slug),
    listServiceCategoryMarketplaceMappings(slug),
    listMarketplaceTaxonomyCategories(),
  ]);
  const services = await listManageServices(slug, {
    query: options.query ?? "",
    locationId: options.locationId ?? 0,
    includeInactive: options.includeInactive ?? true,
  });
  const categoriesWithCounts = categories.map((category) => {
    const mapping = mappings.find((item) => item.tenantCategoryId === category.id);
    return {
      ...category,
      serviceCount: services.filter((service) => service.categoryId === category.id).length,
      marketplaceCategoryId: mapping?.marketplaceCategoryId ?? null,
      marketplaceCategorySlug: mapping?.marketplaceCategorySlug ?? "",
      marketplaceCategoryName: mapping?.marketplaceCategoryName ?? "",
    };
  });
  const recommendedLinks = services.reduce((sum, service) => sum + service.recommendationIds.length, 0);

  return {
    ok: true,
    sourceMode: "database",
    featureFlags: {
      bookingPublicAllowed: Boolean(Number(tenant?.booking_public_allowed ?? 1)),
      marketplacePublicAllowed: Boolean(Number(tenant?.marketplace_public_allowed ?? 1)),
    },
    stats: {
      services: services.length,
      activeServices: services.filter((service) => service.isActive).length,
      categories: categoriesWithCounts.length,
      recommendedLinks,
    },
    services,
    categories: categoriesWithCounts,
    locations,
    cabins,
    staff,
    resources,
    marketplace: {
      taxonomyCategories,
      categoryMappings: mappings,
    },
  };
}

// Single-service reader for the faithful service NEW/EDIT form prefill (route
// action=get). Mirrors clients?action=get: returns ONE fully-mapped service row
// (with its location/cabin/staff/resource links) so the editor can prefill all
// fields. Reuses the same listManageServices pipeline, then narrows to the id.
export async function getManageService(slug: string, serviceId: number): Promise<ManageServiceRow | null> {
  if (serviceId <= 0) return null;
  const services = await listManageServices(slug, { includeInactive: true });
  return services.find((service) => service.id === serviceId) ?? null;
}

// Pannelli di conferma legacy (pendingService*Review): il save li restituisce
// al posto di salvare; il form ripete il POST con i confirm_* accumulati.
export type ServicePendingReview = {
  kind: "deactivation_block" | "deactivation_appointments" | "name_update" | "price_update" | "impacted_appointments";
  serviceId: number;
  serviceName: string;
  serviceNameBefore: string;
  count: number;
  blockers?: ServiceImpactRow[];
  impacts?: ServiceImpactRow[];
  appointments?: Array<ImpactedAppointment & { statusMeta: { class: string; label: string } }>;
  changedFields?: string[];
  oldPrice?: number;
  newPrice?: number;
};

export type ServiceSaveResult = { ok: true; msg: string; pending: null; context: ManageServiceContext } | { ok: true; msg: ""; pending: ServicePendingReview; context: null };

const svcConfirm = (body: Record<string, string>, field: string): boolean => String(body[field] ?? "") === "1";

export async function saveManageService(slug: string, body: Record<string, string>): Promise<ServiceSaveResult> {
  const input = await normalizeServiceInput(slug, body);
  const table = await tenantTable(slug, "services");
  const values = await filterColumns(table.name, {
    category_id: input.categoryId,
    cabin_id: input.cabinIds[0] ?? null,
    name: input.name,
    duration_min: input.durationMin,
    price: input.price,
    is_active: input.isActive ? 1 : 0,
    booking_enabled: input.bookingEnabled ? 1 : 0,
    no_operator: input.noOperator ? 1 : 0,
  });

  let serviceId = input.id;
  let msg = "Servizio creato";
  if (serviceId > 0) {
    const existing = await getServiceById(slug, serviceId);

    // Stato db vs post (svc_service_state_from_db/from_post) per decidere
    // conferme e aggiornamenti dei riferimenti operativi.
    const dbState = await serviceStateFromDb(slug, serviceId, existing);
    const nameChanged = String(dbState.name).trim() !== input.name.trim();
    const oldPrice = roundMoney(dbState.price);
    const newPrice = roundMoney(input.price);
    const priceChanged = Math.round(oldPrice * 100) !== Math.round(newPrice * 100);
    const deactivationRequested = dbState.isActive && !input.isActive;
    const changedFields: string[] = [];
    if (dbState.durationMin !== input.durationMin) changedFields.push("Durata");
    if (!sameIds(dbState.cabinIds, input.cabinIds)) changedFields.push("Cabine");
    if (dbState.noOperator !== input.noOperator || !sameIds(dbState.staffIds, input.staffIds)) changedFields.push("Operatori");
    if (!sameResourceQty(dbState.resourceQty, input.resourceQty)) changedFields.push("Risorse necessarie");

    const basePending = { serviceId, serviceName: input.name, serviceNameBefore: String(dbState.name ?? input.name) };

    if (deactivationRequested) {
      const blockers = await serviceDeactivationBlockers(slug, serviceId);
      if (blockers.length) {
        return { ok: true, msg: "", context: null, pending: { kind: "deactivation_block", ...basePending, blockers, count: blockers.length } };
      }
      const appointments = await fetchImpactedAppointments(slug, serviceId);
      if (appointments.length && !svcConfirm(body, "confirm_service_deactivation_appointments")) {
        return { ok: true, msg: "", context: null, pending: { kind: "deactivation_appointments", ...basePending, appointments: appointments.map((a) => ({ ...a, statusMeta: serviceStatusMeta(a.status) })), count: appointments.length } };
      }
    }
    let serviceNameImpacts: ServiceImpactRow[] = [];
    if (nameChanged) {
      serviceNameImpacts = await serviceNameUpdateImpacts(slug, serviceId);
      if (serviceNameImpacts.length && !svcConfirm(body, "confirm_service_name_update")) {
        return { ok: true, msg: "", context: null, pending: { kind: "name_update", ...basePending, impacts: serviceNameImpacts, count: serviceNameImpacts.length } };
      }
    }
    if (priceChanged && !svcConfirm(body, "confirm_service_price_update")) {
      const impacts = await servicePriceUpdateImpacts(slug, serviceId);
      return { ok: true, msg: "", context: null, pending: { kind: "price_update", ...basePending, impacts, count: impacts.length, oldPrice, newPrice } };
    }
    if (changedFields.length) {
      const impacted = await fetchImpactedAppointments(slug, serviceId);
      if (impacted.length && !svcConfirm(body, "confirm_impacted_appointments")) {
        return { ok: true, msg: "", context: null, pending: { kind: "impacted_appointments", ...basePending, appointments: impacted.map((a) => ({ ...a, statusMeta: serviceStatusMeta(a.status) })), count: impacted.length, changedFields } };
      }
    }

    await ensureLocationRemovalAllowed(slug, serviceId, input.locationIds);
    // Congela gli snapshot storici PRIMA dell'update (services.php 4500-4501).
    await freezeAppointmentSnapshots(slug, serviceId).catch(() => undefined);
    await freezeSoldServiceSnapshots(slug, serviceId).catch(() => undefined);
    await tenantUpdate({ slug, table: "services", id: serviceId, values });
    await syncServiceLinks(slug, serviceId, input);

    msg = "Servizio aggiornato";
    if (nameChanged) {
      const counts = await applyServiceNameSnapshotUpdates(slug, serviceId, input.name).catch(() => ({} as Record<string, number>));
      const refs = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
      if (refs > 0) msg += ` • nome aggiornato nei riferimenti operativi: ${refs}`;
    }
    if (priceChanged) {
      const counts = await applyServicePriceCatalogUpdates(slug, serviceId, newPrice, oldPrice).catch(() => ({} as Record<string, number>));
      const refs = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
      if (refs > 0) msg += ` • prezzi catalogo/promozioni aggiornati: ${refs}`;
    }
  } else {
    serviceId = await tenantInsert(table, {
      ...values,
      sort_order: await nextServiceSortOrder(slug, input.categoryId),
    });
    await syncServiceLinks(slug, serviceId, input);
  }

  await syncTenantDirectoryServices(slug);
  return { ok: true, msg, pending: null, context: await getManageServicesContext(slug, { includeInactive: true }) };
}

// svc_service_state_from_db: stato normalizzato per il diff.
async function serviceStateFromDb(slug: string, serviceId: number, row: RowDataPacket) {
  const cabinIds = (await groupedIds(slug, "service_cabins", "service_id", "cabin_id", [serviceId])).get(serviceId)
    ?? fallbackPositive(row.cabin_id);
  const staffIds = (await groupedIds(slug, "staff_services", "service_id", "staff_id", [serviceId])).get(serviceId) ?? [];
  const resources = (await groupedResources(slug, [serviceId])).get(serviceId) ?? [];
  return {
    name: String(row.name ?? "").trim(),
    categoryId: nullableNumber(row.category_id),
    durationMin: Number(row.duration_min ?? 0) || 0,
    price: Number(row.price ?? 0) || 0,
    isActive: Number(row.is_active ?? 1) === 1,
    noOperator: Number(row.no_operator ?? 0) === 1,
    cabinIds: uniquePositive(cabinIds).sort((a, b) => a - b),
    staffIds: uniquePositive(staffIds).sort((a, b) => a - b),
    resourceQty: new Map(resources.map((item) => [item.resourceId, Math.max(1, item.qtyRequired)])),
  };
}

function sameIds(a: number[], b: number[]): boolean {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((value, index) => value === sb[index]);
}

function sameResourceQty(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

// Popup di blocco eliminazione (svc_flash_delete_block_popup, session flash).
export type ServiceDeleteBlockPopup = {
  title: string;
  service_name: string;
  message: string;
  blockers: ServiceImpactRow[];
};

export async function deleteManageService(slug: string, serviceId: number): Promise<ManageServiceContext> {
  if (serviceId <= 0) throw new Error("Servizio non trovato");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id,name", where: "id = ?", params: [serviceId], limit: 1 }).catch(() => []);
  // services.php 4177-4178: flash 'Servizio non trovato' (senza punto).
  if (!rows[0]) throw new Error("Servizio non trovato");

  const blockers = await serviceDeleteBlockersLegacy(slug, serviceId);
  if (blockers.length) {
    // services.php 4182-4184: err 'Servizio non eliminabile' + popup in sessione.
    const error = new Error("Servizio non eliminabile") as Error & { popup?: ServiceDeleteBlockPopup };
    error.popup = {
      title: "Impossibile eliminare il servizio",
      service_name: String(rows[0].name ?? "Servizio"),
      message: "Il servizio non può essere eliminato perché è associato a elementi attivi o ancora da eseguire. Rimuovi o chiudi prima le associazioni elencate.",
      blockers,
    };
    throw error;
  }

  // Congela gli snapshot mancanti PRIMA dell'eliminazione (services.php 4188-4189).
  await freezeAppointmentSnapshots(slug, serviceId).catch(() => undefined);
  await freezeSoldServiceSnapshots(slug, serviceId).catch(() => undefined);

  await deleteByOwner(slug, "service_resources", "service_id", serviceId);
  await deleteByOwner(slug, "service_cabins", "service_id", serviceId);
  await deleteByOwner(slug, "staff_services", "service_id", serviceId);
  await deleteByOwner(slug, "service_locations", "service_id", serviceId);
  await deleteRecommendationsForService(slug, serviceId);
  await tenantDelete({ slug, table: "services", id: serviceId });
  await syncTenantDirectoryServices(slug);
  return getManageServicesContext(slug, { includeInactive: true });
}

export async function saveServiceCategory(slug: string, body: Record<string, string>): Promise<ManageServiceContext> {
  const table = await tenantTable(slug, "service_categories");
  const id = parseInteger(body.id, 0);
  const name = String(body.name ?? "").trim();
  // Flash legacy senza punto (services.php 3641, 3601-3605).
  if (!name) throw new Error("Nome categoria obbligatorio");

  // MIGLIORIA deliberata (approvata 2026-07-17, diverge dal legacy che
  // inseriva senza guardie, services.php 3648): niente categorie duplicate —
  // match case-insensitive (Postgres è case-sensitive, MySQL no) escludendo
  // la riga in modifica.
  const dup = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_categories",
    columns: "id",
    where: "LOWER(name) = ? AND id <> ?",
    params: [name.toLowerCase(), id],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (dup.length > 0) throw new Error("Esiste già una categoria con questo nome");

  const imageUrl = truthy(body.delete_image ?? body.remove_image) ? null : emptyToNull(clean(body.image_url ?? body.imageUrl, 255));
  if (id > 0) {
    const existing = await getCategoryById(slug, id);
    if (!existing) throw new Error("Categoria non trovata");
    await tenantUpdate({
      slug,
      table: "service_categories",
      id,
      values: await filterColumns(table.name, { name, image_url: imageUrl }),
    });
  } else {
    await tenantInsert(table, await filterColumns(table.name, {
      name,
      image_url: imageUrl,
      sort_order: await nextCategorySortOrder(slug),
    }));
  }

  await normalizeCategoryOrder(slug);
  await syncTenantDirectoryServices(slug);
  return getManageServicesContext(slug, { includeInactive: true });
}

// Popup 'Categoria non eliminabile' (services.php 3566-3577, session flash).
export type CategoryDeleteBlockPopup = {
  category_name: string;
  services: Array<{ id: number; name: string; active: boolean }>;
};

export async function deleteServiceCategory(slug: string, categoryId: number): Promise<ManageServiceContext> {
  const category = await getCategoryById(slug, categoryId);
  if (!category) throw new Error("Categoria non trovata");
  if (isDefaultCategoryName(String(category.name ?? ""))) throw new Error("Non puoi eliminare la categoria di default");

  const linked = await tenantSelect<RowDataPacket>({
    slug,
    table: "services",
    columns: "id,name,is_active",
    where: "category_id = ?",
    params: [categoryId],
    orderBy: "name ASC",
    limit: 200,
  }).catch(() => []);
  if (linked.length) {
    const error = new Error("Categoria non eliminabile") as Error & { popup?: CategoryDeleteBlockPopup };
    error.popup = {
      category_name: String(category.name ?? "Categoria"),
      services: linked.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? "Servizio"), active: Number(row.is_active ?? 1) === 1 })),
    };
    throw error;
  }

  await tenantDelete({ slug, table: "service_categories", id: categoryId });
  await deleteServiceCategoryMarketplaceMapping(slug, categoryId);
  await normalizeCategoryOrder(slug);
  await syncTenantDirectoryServices(slug);
  return getManageServicesContext(slug, { includeInactive: true });
}

// service_category_move: `moved` decide il flash 'Ordine categorie aggiornato'
// vs 'Impossibile spostare la categoria' (services.php 3520-3523).
export async function moveServiceCategory(slug: string, categoryId: number, direction: "up" | "down"): Promise<ManageServiceContext & { moved: boolean }> {
  const rows = await normalizeCategoryOrder(slug);
  const index = rows.findIndex((row) => row.id === categoryId);
  const fail = async () => ({ ...(await getManageServicesContext(slug, { includeInactive: true })), moved: false });
  if (index < 0) return fail();
  if (rows[index]?.isDefault) return fail();

  const targetIndex = direction === "down" ? index + 1 : index - 1;
  const target = rows[targetIndex];
  const current = rows[index];
  if (!target || !current || target.isDefault) return fail();

  await tenantUpdate({ slug, table: "service_categories", id: current.id, values: { sort_order: target.sortOrder } });
  await tenantUpdate({ slug, table: "service_categories", id: target.id, values: { sort_order: current.sortOrder } });
  await normalizeCategoryOrder(slug);
  await syncTenantDirectoryServices(slug);
  return { ...(await getManageServicesContext(slug, { includeInactive: true })), moved: true };
}

// `ordered` decide 'Ordine servizi aggiornato' vs 'Nessun servizio da ordinare'
// (services.php 3538-3540).
export async function saveServiceOrder(slug: string, body: Record<string, string>): Promise<ManageServiceContext & { ordered: boolean }> {
  const categoryId = parseInteger(body.category_id ?? body.categoryId, 0);
  const ids = parseIdList(body.service_order ?? body.serviceOrder ?? body.ids);
  if (categoryId <= 0 || !ids.length) return { ...(await getManageServicesContext(slug, { includeInactive: true })), ordered: false };

  const table = await tenantTable(slug, "services");
  let sortOrder = 0;
  for (const id of ids) {
    const clauses = ["id = ?", "category_id = ?"];
    const params: unknown[] = [id, categoryId];
    if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(table.tenantId ?? 0);
    }
    await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET sort_order=? WHERE ${clauses.join(" AND ")}`, [sortOrder, ...params]);
    sortOrder += 1;
  }

  await syncTenantDirectoryServices(slug);
  return { ...(await getManageServicesContext(slug, { includeInactive: true })), ordered: true };
}

export async function saveServiceCategoryMarketplace(slug: string, body: Record<string, string>): Promise<ManageServiceContext> {
  const tenantCategoryId = parseInteger(body.tenant_category_id ?? body.category_id ?? body.id, 0);
  const marketplaceCategoryId = parseInteger(body.marketplace_category_id ?? body.marketplaceCategoryId, 0);
  if (tenantCategoryId <= 0) throw new Error("Categoria servizio non valida.");
  const category = await getCategoryById(slug, tenantCategoryId);
  if (!category) throw new Error("Categoria servizio non trovata.");

  await saveServiceCategoryMarketplaceMapping(slug, tenantCategoryId, String(category.name ?? ""), marketplaceCategoryId);
  await syncTenantDirectoryServices(slug);
  return getManageServicesContext(slug, { includeInactive: true });
}

export async function saveServiceRecommendations(slug: string, body: Record<string, string>): Promise<ManageServiceContext> {
  const serviceId = parseInteger(body.service_id ?? body.id, 0);
  // services.php 3128: ramo fallito -> 'Seleziona un servizio valido'.
  if (serviceId <= 0) throw new Error("Seleziona un servizio valido");
  await getServiceById(slug, serviceId);
  const requestedIds = parseIdList(body.recommended_ids ?? body.recommendedIds).filter((id) => id !== serviceId);
  const existingIds = new Set((await servicesByIds(slug, requestedIds)).map((row) => Number(row.id ?? 0)));
  const ids = uniquePositive(requestedIds.filter((id) => existingIds.has(id)));

  await deleteByOwner(slug, "service_recommendations", "service_id", serviceId);
  const table = await tenantTable(slug, "service_recommendations").catch(() => null);
  if (!table) throw new Error("Tabella service_recommendations mancante.");
  let sortOrder = 0;
  for (const recommendedId of ids) {
    await tenantInsert(table, await filterColumns(table.name, {
      service_id: serviceId,
      recommended_service_id: recommendedId,
      sort_order: sortOrder,
    }));
    sortOrder += 1;
  }

  await syncTenantDirectoryServices(slug);
  return getManageServicesContext(slug, { includeInactive: true });
}

// Validazione VERBATIM di services.php 4289-4308 (stesso ordine, stessi testi:
// cabina/sede con gli accenti, guardie cabina/staff/risorse per sede SENZA).
async function normalizeServiceInput(slug: string, body: Record<string, string>): Promise<NormalizedServiceInput> {
  const id = parseInteger(body.id, 0);
  const name = String(body.name ?? "").trim();
  const durationMin = parseInteger(body.duration_min ?? body.duration, 0);
  const price = roundMoney(parseMoneyValue(body.price));
  const categoryId = parseInteger(body.category_id ?? body.categoryId, 0) || null;
  const isActive = body.is_active === undefined && body.active === undefined ? true : truthy(body.is_active ?? body.active);
  const bookingEnabled = body.booking_enabled === undefined && body.bookingEnabled === undefined ? true : truthy(body.booking_enabled ?? body.bookingEnabled);
  const noOperator = truthy(body.no_operator ?? body.noOperator);

  const activeLocations = await listServiceLocations(slug);
  const activeLocationIds = new Set(activeLocations.filter((location) => location.isActive).map((location) => location.id));
  const locationIds = uniquePositive(parseIdList(body.location_ids ?? body.locationIds).filter((lid) => activeLocationIds.has(lid)));
  const cabinIds = uniquePositive(parseIdList(body.cabin_ids ?? body.cabin_id ?? body.cabinIds));
  const staffIds = noOperator ? [] : uniquePositive(parseIdList(body.staff_ids ?? body.staffIds));
  const resourceQty = await normalizeResourceQty(slug, body);

  if (!name) throw new Error("Nome servizio obbligatorio");
  if (durationMin <= 0) throw new Error("La durata del servizio deve essere maggiore di zero");
  if (price < 0) throw new Error("Il prezzo del servizio non puo essere negativo");
  if (!(cabinIds[0] > 0)) throw new Error("Seleziona almeno una cabina in cui verrà effettuato il servizio");
  if (await tableExistsForTenant(slug, "service_locations") && activeLocations.length && !locationIds.length) {
    throw new Error("Seleziona almeno una sede in cui il servizio sarà disponibile");
  }

  const cabinError = await serviceCabinLocationError(slug, cabinIds, locationIds);
  if (cabinError) throw new Error(cabinError);
  const staffError = await serviceStaffLocationError(slug, staffIds, locationIds, noOperator);
  if (staffError) throw new Error(staffError);
  const resourceError = await serviceResourceLocationError(slug, resourceQty, locationIds.length ? locationIds : activeLocations.map((location) => location.id));
  if (resourceError) throw new Error(resourceError);

  return {
    id,
    name,
    durationMin,
    price,
    categoryId,
    isActive,
    bookingEnabled,
    noOperator,
    locationIds,
    cabinIds,
    staffIds,
    resourceQty,
  };
}

// service_cabin_location_error (services.php 358-396, testi senza accenti).
async function serviceCabinLocationError(slug: string, cabinIds: number[], locationIds: number[]): Promise<string> {
  if (!cabinIds.length || !locationIds.length) return "";
  const activeCabins = (await listServiceCabins(slug)).filter((cabin) => cabin.isActive);
  const byId = new Map(activeCabins.map((cabin) => [cabin.id, cabin]));
  const selected: ServiceCabinRow[] = [];
  for (const cabinId of cabinIds) {
    const cabin = byId.get(cabinId);
    if (!cabin) return "Una cabina selezionata non e piu disponibile.";
    if (cabin.locationId && !locationIds.includes(cabin.locationId)) {
      const name = cabin.name.trim();
      return `La cabina "${name !== "" ? name : `#${cabinId}`}" non e abilitata nelle sedi selezionate.`;
    }
    selected.push(cabin);
  }
  const names = new Map((await listServiceLocations(slug)).map((location) => [location.id, location.name]));
  for (const locationId of locationIds) {
    const covered = selected.some((cabin) => !cabin.locationId || cabin.locationId === locationId);
    if (!covered) return `Per la sede "${names.get(locationId) ?? `Sede #${locationId}`}" seleziona almeno una cabina abilitata.`;
  }
  return "";
}

// service_staff_location_error (services.php 691-729).
async function serviceStaffLocationError(slug: string, staffIds: number[], locationIds: number[], noOperator: boolean): Promise<string> {
  if (noOperator) return "";
  if (!staffIds.length) return 'Seleziona almeno un operatore oppure attiva "Servizio senza operatore".';
  if (!locationIds.length || !await tableExistsForTenant(slug, "staff_locations")) return "";
  const staffRows = await listServiceStaff(slug);
  const byId = new Map(staffRows.map((staff) => [staff.id, staff]));
  const names = new Map((await listServiceLocations(slug)).map((location) => [location.id, location.name]));
  for (const staffId of staffIds) {
    const staff = byId.get(staffId);
    if (!staff) return "Uno degli operatori selezionati non esiste piu. Aggiorna la pagina e riprova.";
    // service_staff_matches_locations: staff senza sedi = non abilitato.
    if (!staff.locationIds.length || !locationIds.some((lid) => staff.locationIds.includes(lid))) {
      const name = staff.fullName.trim() || `Operatore #${staffId}`;
      return `L'operatore "${name}" non e abilitato in nessuna delle sedi selezionate per il servizio.`;
    }
  }
  for (const locationId of locationIds) {
    const covered = staffIds.some((sid) => byId.get(sid)?.locationIds.includes(locationId));
    if (!covered) return `Per la sede "${names.get(locationId) ?? `Sede #${locationId}`}" seleziona almeno un operatore abilitato oppure attiva "Servizio senza operatore".`;
  }
  return "";
}

// service_resource_location_error (services.php 263-298, testi CON accenti).
async function serviceResourceLocationError(slug: string, resourceQty: Map<number, number>, locationIds: number[]): Promise<string> {
  if (!resourceQty.size || !locationIds.length) return "";
  if (!await tableExistsForTenant(slug, "resource_locations")) return "";
  const names = new Map((await listServiceLocations(slug)).map((location) => [location.id, location.name]));
  for (const [resourceId, requiredRaw] of resourceQty.entries()) {
    const requiredQty = Math.max(1, requiredRaw);
    const resourceRows = await tenantSelect<RowDataPacket>({ slug, table: "resources", columns: "name,qty_total", where: "id = ?", params: [resourceId], limit: 1 }).catch(() => []);
    const resourceName = String(resourceRows[0]?.name ?? "").trim() || `Risorsa #${resourceId}`;
    for (const locationId of locationIds) {
      if (!(locationId > 0)) continue;
      // app_resource_location_qty: riga sede (0 se disattiva), fallback qty globale.
      const locRows = await tenantSelect<RowDataPacket>({ slug, table: "resource_locations", columns: "qty_total,is_enabled", where: "resource_id = ? AND location_id = ?", params: [resourceId, locationId], limit: 1 }).catch(() => []);
      const availableQty = locRows[0]
        ? (Number(locRows[0].is_enabled ?? 0) === 1 ? Math.max(0, Number(locRows[0].qty_total ?? 0)) : 0)
        : Math.max(0, Number(resourceRows[0]?.qty_total ?? 0));
      const locationName = names.get(locationId) ?? `Sede #${locationId}`;
      if (availableQty <= 0) return `La risorsa "${resourceName}" non è disponibile per la sede ${locationName}.`;
      if (requiredQty > availableQty) return `La risorsa "${resourceName}" richiede ${requiredQty} unità, ma nella sede ${locationName} sono disponibili ${availableQty}.`;
    }
  }
  return "";
}

async function listManageServices(slug: string, options: { query?: string; locationId?: number; includeInactive?: boolean }): Promise<ManageServiceRow[]> {
  const servicesTable = await tenantTable(slug, "services");
  const categoriesTable = await tenantTable(slug, "service_categories").catch(() => null);
  const hasCategoryTenant = Boolean(categoriesTable && await columnExists(categoriesTable.name, "tenant_id"));
  const categoryJoin = categoriesTable
    ? `LEFT JOIN ${quoteIdentifier(categoriesTable.name)} c ON c.id=s.category_id${hasCategoryTenant && servicesTable.mode === "shared" ? " AND c.tenant_id=s.tenant_id" : ""}`
    : "";
  const categoryColumns = categoriesTable
    ? "c.name AS category_name, c.image_url AS category_image_url, COALESCE(c.sort_order,0) AS category_sort_order"
    : "NULL AS category_name, NULL AS category_image_url, 0 AS category_sort_order";
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (servicesTable.mode === "shared" && await columnExists(servicesTable.name, "tenant_id")) {
    clauses.push("s.tenant_id = ?");
    params.push(servicesTable.tenantId ?? 0);
  }
  const query = clean(options.query ?? "", 120).toLowerCase();
  if (query) {
    clauses.push("LOWER(s.name) LIKE ?");
    params.push(`%${query}%`);
  }
  if (!options.includeInactive) clauses.push("COALESCE(s.is_active,1)=1");

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.*, ${categoryColumns}
       FROM ${quoteIdentifier(servicesTable.name)} s
       ${categoryJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ${serviceCategoryJoinOrderSql(Boolean(categoriesTable))}, COALESCE(s.sort_order,0) ASC, s.name ASC`,
    params,
  );
  const ids = rows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const [locations, cabins, staff, resources, recommendations] = await Promise.all([
    groupedIds(slug, "service_locations", "service_id", "location_id", ids),
    groupedIds(slug, "service_cabins", "service_id", "cabin_id", ids),
    groupedIds(slug, "staff_services", "service_id", "staff_id", ids),
    groupedResources(slug, ids),
    groupedRecommendations(slug, ids),
  ]);

  const services = rows.map((row) => mapService(row, {
    locationIds: locations.get(Number(row.id ?? 0)) ?? [],
    cabinIds: cabins.get(Number(row.id ?? 0)) ?? fallbackPositive(row.cabin_id),
    staffIds: staff.get(Number(row.id ?? 0)) ?? [],
    resources: resources.get(Number(row.id ?? 0)) ?? [],
    recommendationIds: recommendations.get(Number(row.id ?? 0)) ?? [],
  }));
  const filterLocationId = Number(options.locationId ?? 0);
  if (filterLocationId <= 0) return services;
  return services.filter((service) => service.locationIds.length === 0 || service.locationIds.includes(filterLocationId));
}

function mapService(
  row: RowDataPacket,
  links: {
    locationIds: number[];
    cabinIds: number[];
    staffIds: number[];
    resources: Array<{ resourceId: number; qtyRequired: number }>;
    recommendationIds: number[];
  },
): ManageServiceRow {
  const durationMin = Number(row.duration_min ?? 0) || 0;
  const priceValue = roundMoney(Number(row.price ?? 0) || 0);
  const categoryName = String(row.category_name ?? "Non categorizzato");
  const isActive = Number(row.is_active ?? 1) === 1;
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Servizio"),
    durationMin,
    duration: `${durationMin} min`,
    priceValue,
    price: `${formatMoney(priceValue)} euro`,
    categoryId: nullableNumber(row.category_id),
    categoryName,
    categoryImageUrl: String(row.category_image_url ?? ""),
    cabinId: nullableNumber(row.cabin_id),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    isActive,
    active: isActive,
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
    noOperator: Number(row.no_operator ?? 0) === 1,
    locationIds: uniquePositive(links.locationIds),
    cabinIds: uniquePositive(links.cabinIds),
    staffIds: uniquePositive(links.staffIds),
    resources: links.resources,
    recommendationIds: uniquePositive(links.recommendationIds),
    recoCount: uniquePositive(links.recommendationIds).length,
  };
}

async function listServiceCategories(slug: string): Promise<ServiceCategoryRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_categories",
    columns: "id,name,image_url,COALESCE(sort_order,0) AS sort_order",
    orderBy: categoryOrderSql(),
  }).catch(() => []);
  const mappings = await listServiceCategoryMarketplaceMappings(slug);
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    const mapping = mappings.find((item) => item.tenantCategoryId === id);
    return {
      id,
      name: String(row.name ?? ""),
      imageUrl: String(row.image_url ?? ""),
      sortOrder: Number(row.sort_order ?? 0) || 0,
      isDefault: isDefaultCategoryName(String(row.name ?? "")),
      serviceCount: 0,
      marketplaceCategoryId: mapping?.marketplaceCategoryId ?? null,
      marketplaceCategorySlug: mapping?.marketplaceCategorySlug ?? "",
      marketplaceCategoryName: mapping?.marketplaceCategoryName ?? "",
    };
  });
}

async function listServiceLocations(slug: string): Promise<ServiceLocationRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id,name,is_active",
    where: "COALESCE(is_active,1)=1",
    orderBy: "COALESCE(sort_order,999999) ASC, name ASC, id ASC",
  }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? `Sede #${row.id}`),
    isActive: Number(row.is_active ?? 1) === 1,
  }));
}

async function listServiceCabins(slug: string): Promise<ServiceCabinRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "*",
    orderBy: "COALESCE(position,999999) ASC, name ASC, id ASC",
  }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? `Cabina #${row.id}`),
    isActive: Number(row.is_active ?? 1) === 1,
    locationId: nullableNumber(row.location_id),
    position: Number(row.position ?? 0) || 0,
  }));
}

async function listServiceStaff(slug: string): Promise<ServiceStaffRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id,full_name,email,is_active",
    where: "full_name <> 'SSO'",
    orderBy: "full_name ASC, id ASC",
  }).catch(() => []);
  const staffIds = rows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const locationMap = await groupedIds(slug, "staff_locations", "staff_id", "location_id", staffIds);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    fullName: String(row.full_name ?? `Operatore #${row.id}`),
    email: String(row.email ?? ""),
    isActive: Number(row.is_active ?? 1) === 1,
    locationIds: locationMap.get(Number(row.id ?? 0)) ?? [],
  }));
}

async function listServiceResources(slug: string): Promise<ServiceResourceRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "resources",
    columns: "id,name,qty_total",
    orderBy: "name ASC, id ASC",
  }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? `Risorsa #${row.id}`),
    qtyTotal: Number(row.qty_total ?? 0) || 0,
  }));
}

async function groupedIds(slug: string, tableName: string, ownerColumn: string, valueColumn: string, ownerIds: number[]): Promise<Map<number, number[]>> {
  const ids = uniquePositive(ownerIds);
  const map = new Map<number, number[]>();
  if (!ids.length || !await tableExistsForTenant(slug, tableName)) return map;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: tableName,
    columns: `${quoteIdentifier(ownerColumn)},${quoteIdentifier(valueColumn)}`,
    where: `${quoteIdentifier(ownerColumn)} IN (${ids.map(() => "?").join(",")})`,
    params: ids,
    orderBy: `${quoteIdentifier(ownerColumn)} ASC, ${quoteIdentifier(valueColumn)} ASC`,
  }).catch(() => []);
  for (const row of rows) {
    const ownerId = Number(row[ownerColumn] ?? 0);
    const value = Number(row[valueColumn] ?? 0);
    if (ownerId <= 0 || value <= 0) continue;
    const list = map.get(ownerId) ?? [];
    list.push(value);
    map.set(ownerId, list);
  }
  return map;
}

async function groupedResources(slug: string, serviceIds: number[]): Promise<Map<number, Array<{ resourceId: number; qtyRequired: number }>>> {
  const ids = uniquePositive(serviceIds);
  const map = new Map<number, Array<{ resourceId: number; qtyRequired: number }>>();
  if (!ids.length || !await tableExistsForTenant(slug, "service_resources")) return map;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_resources",
    columns: "service_id,resource_id,qty_required",
    where: `service_id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
    orderBy: "service_id ASC, resource_id ASC",
  }).catch(() => []);
  for (const row of rows) {
    const serviceId = Number(row.service_id ?? 0);
    const resourceId = Number(row.resource_id ?? 0);
    if (serviceId <= 0 || resourceId <= 0) continue;
    const list = map.get(serviceId) ?? [];
    list.push({ resourceId, qtyRequired: Math.max(1, Number(row.qty_required ?? 1) || 1) });
    map.set(serviceId, list);
  }
  return map;
}

async function groupedRecommendations(slug: string, serviceIds: number[]): Promise<Map<number, number[]>> {
  const ids = uniquePositive(serviceIds);
  const map = new Map<number, number[]>();
  if (!ids.length || !await tableExistsForTenant(slug, "service_recommendations")) return map;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_recommendations",
    columns: "service_id,recommended_service_id,sort_order",
    where: `service_id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
    orderBy: "service_id ASC, sort_order ASC, recommended_service_id ASC",
  }).catch(() => []);
  for (const row of rows) {
    const serviceId = Number(row.service_id ?? 0);
    const recommendedId = Number(row.recommended_service_id ?? 0);
    if (serviceId <= 0 || recommendedId <= 0) continue;
    const list = map.get(serviceId) ?? [];
    list.push(recommendedId);
    map.set(serviceId, list);
  }
  return map;
}




async function normalizeResourceQty(slug: string, body: Record<string, string>): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  const resourcesJson = parseJsonArray<{ resourceId?: number; resource_id?: number; qtyRequired?: number; qty_required?: number }>(body.resources_json ?? body.resources);
  for (const item of resourcesJson) {
    const resourceId = Number(item.resourceId ?? item.resource_id ?? 0);
    if (resourceId > 0) ids.set(Math.floor(resourceId), Math.max(1, Number(item.qtyRequired ?? item.qty_required ?? 1) || 1));
  }

  for (const resourceId of parseIdList(body.resource_ids ?? body.resourceIds)) {
    const qty = parseInteger(body[`resource_qty_${resourceId}`] ?? body[`resource_qty[${resourceId}]`], ids.get(resourceId) ?? 1);
    ids.set(resourceId, Math.max(1, qty));
  }

  if (!ids.size) return ids;
  const existing = new Set((await tenantSelect<RowDataPacket>({
    slug,
    table: "resources",
    columns: "id",
    where: `id IN (${Array.from(ids.keys()).map(() => "?").join(",")})`,
    params: Array.from(ids.keys()),
  }).catch(() => [])).map((row) => Number(row.id ?? 0)));
  for (const resourceId of Array.from(ids.keys())) {
    if (!existing.has(resourceId)) ids.delete(resourceId);
  }
  return ids;
}

async function syncServiceLinks(slug: string, serviceId: number, input: NormalizedServiceInput): Promise<void> {
  await replaceOwnerLinks(slug, "service_cabins", "service_id", serviceId, "cabin_id", input.cabinIds);
  await replaceOwnerLinks(slug, "staff_services", "service_id", serviceId, "staff_id", input.staffIds);
  await replaceOwnerLinks(slug, "service_locations", "service_id", serviceId, "location_id", input.locationIds);

  await deleteByOwner(slug, "service_resources", "service_id", serviceId);
  const resourcesTable = await tenantTable(slug, "service_resources").catch(() => null);
  if (!resourcesTable) return;
  for (const [resourceId, qtyRequired] of input.resourceQty.entries()) {
    await tenantInsert(resourcesTable, await filterColumns(resourcesTable.name, {
      service_id: serviceId,
      resource_id: resourceId,
      qty_required: Math.max(1, qtyRequired),
    }));
  }
}

async function replaceOwnerLinks(slug: string, tableName: string, ownerColumn: string, ownerId: number, valueColumn: string, values: number[]): Promise<void> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || ownerId <= 0) return;
  await deleteByOwner(slug, tableName, ownerColumn, ownerId);
  for (const value of uniquePositive(values)) {
    await tenantInsert(table, await filterColumns(table.name, { [ownerColumn]: ownerId, [valueColumn]: value })).catch(() => undefined);
  }
}


// service_location_removal_blockers (services.php 181-212 + guardia 4307-4308):
// prenotazioni APERTE del servizio nelle sedi che si stanno rimuovendo.
async function ensureLocationRemovalAllowed(slug: string, serviceId: number, newLocationIds: number[]): Promise<void> {
  if (!await tableExistsForTenant(slug, "service_locations")) return;
  const oldIds = (await groupedIds(slug, "service_locations", "service_id", "location_id", [serviceId])).get(serviceId) ?? [];
  if (!oldIds.length) return;
  const next = new Set(newLocationIds);
  const removed = new Set(oldIds.filter((id) => !next.has(id)));
  if (!removed.size) return;

  const appointments = await fetchImpactedAppointments(slug, serviceId);
  if (!appointments.length) return;
  const table = await tenantTable(slug, "appointments").catch(() => null);
  if (!table || !await columnExists(table.name, "location_id")) return;
  let blocked = 0;
  for (const appt of appointments) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "location_id", where: "id = ?", params: [appt.id], limit: 1 }).catch(() => []);
    const locationId = Number(rows[0]?.location_id ?? 0) || 0;
    if (locationId > 0 && removed.has(locationId)) blocked += 1;
  }
  if (blocked > 0) throw new Error(`Non puoi rimuovere la sede dal servizio: ci sono prenotazioni aperte collegate (${blocked}).`);
}



async function normalizeCategoryOrder(slug: string): Promise<ServiceCategoryRow[]> {
  const categories = await listServiceCategories(slug);
  let sortOrder = 0;
  for (const category of categories) {
    if (category.sortOrder !== sortOrder) {
      await tenantUpdate({ slug, table: "service_categories", id: category.id, values: { sort_order: sortOrder } }).catch(() => undefined);
    }
    category.sortOrder = sortOrder;
    sortOrder += 10;
  }
  return categories;
}

async function nextCategorySortOrder(slug: string): Promise<number> {
  const table = await tenantTable(slug, "service_categories");
  const scope = await tenantScope(table, [], []);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(MAX(sort_order),-10)+10 AS next_sort FROM ${quoteIdentifier(table.name)}${scope.where}`,
    scope.params,
  ).catch(() => []);
  return Number(rows[0]?.next_sort ?? 0) || 0;
}

async function nextServiceSortOrder(slug: string, categoryId: number | null): Promise<number> {
  const table = await tenantTable(slug, "services");
  const scope = await tenantScope(table, ["category_id IS NOT DISTINCT FROM ?"], [categoryId]);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(MAX(sort_order),-1)+1 AS next_sort FROM ${quoteIdentifier(table.name)}${scope.where}`,
    scope.params,
  ).catch(() => []);
  return Number(rows[0]?.next_sort ?? 0) || 0;
}

async function getServiceById(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Servizio non trovato.");
  return rows[0];
}

async function servicesByIds(slug: string, ids: number[]): Promise<RowDataPacket[]> {
  const unique = uniquePositive(ids);
  if (!unique.length) return [];
  return tenantSelect<RowDataPacket>({
    slug,
    table: "services",
    columns: "id,name",
    where: `id IN (${unique.map(() => "?").join(",")})`,
    params: unique,
  }).catch(() => []);
}

async function getCategoryById(slug: string, id: number): Promise<RowDataPacket | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "service_categories", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
  return rows[0] ?? null;
}

async function getTenant(slug: string) {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) return null;
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT id, slug, name, booking_public_allowed, marketplace_public_allowed FROM saas_tenants WHERE id=? LIMIT 1",
    [tenantId],
  ).catch(() => []);
  return rows[0] ?? null;
}

async function listMarketplaceTaxonomyCategories(): Promise<MarketplaceTaxonomyCategory[]> {
  if (!await tableExists("marketplace_taxonomy_categories")) return [];
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT id,slug,name,sort_order FROM marketplace_taxonomy_categories WHERE COALESCE(is_active,1)=1 ORDER BY sort_order ASC, name ASC, id ASC",
  ).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    sortOrder: Number(row.sort_order ?? 0) || 0,
  }));
}

async function listServiceCategoryMarketplaceMappings(slug: string): Promise<ServiceCategoryMarketplaceMapping[]> {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId || !await tableExists("marketplace_service_category_mappings")) return [];
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT m.tenant_category_id,m.tenant_category_name,m.marketplace_category_id,m.marketplace_category_slug,c.name AS marketplace_category_name
       FROM marketplace_service_category_mappings m
       LEFT JOIN marketplace_taxonomy_categories c ON c.id=m.marketplace_category_id
      WHERE m.tenant_id=?
      ORDER BY m.tenant_category_name ASC, m.tenant_category_id ASC`,
    [tenantId],
  ).catch(() => []);
  return rows.map((row) => ({
    tenantCategoryId: Number(row.tenant_category_id ?? 0),
    tenantCategoryName: String(row.tenant_category_name ?? ""),
    marketplaceCategoryId: nullableNumber(row.marketplace_category_id),
    marketplaceCategorySlug: String(row.marketplace_category_slug ?? ""),
    marketplaceCategoryName: String(row.marketplace_category_name ?? ""),
  }));
}

async function saveServiceCategoryMarketplaceMapping(slug: string, tenantCategoryId: number, tenantCategoryName: string, marketplaceCategoryId: number): Promise<void> {
  const tenant = await getTenant(slug);
  const tenantId = Number(tenant?.id ?? 0);
  const tenantSlug = String(tenant?.slug ?? slug);
  if (tenantId <= 0 || tenantCategoryId <= 0 || !await tableExists("marketplace_service_category_mappings")) return;

  let taxonomy: RowDataPacket | null = null;
  if (marketplaceCategoryId > 0) {
    const rows = await dbQuery<RowDataPacket[]>(
      "SELECT id,slug FROM marketplace_taxonomy_categories WHERE id=? AND COALESCE(is_active,1)=1 LIMIT 1",
      [marketplaceCategoryId],
    );
    taxonomy = rows[0] ?? null;
    if (!taxonomy) throw new Error("Categoria marketplace non valida.");
  }

  await dbExecute(
    `INSERT INTO marketplace_service_category_mappings
      (tenant_id,tenant_slug,tenant_category_id,tenant_category_name,marketplace_category_id,marketplace_category_slug)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (tenant_id,tenant_category_id) DO UPDATE SET
      tenant_slug=EXCLUDED.tenant_slug,
      tenant_category_name=EXCLUDED.tenant_category_name,
      marketplace_category_id=EXCLUDED.marketplace_category_id,
      marketplace_category_slug=EXCLUDED.marketplace_category_slug`,
    [
      tenantId,
      tenantSlug,
      tenantCategoryId,
      emptyToNull(clean(tenantCategoryName, 190)),
      taxonomy ? Number(taxonomy.id ?? 0) : null,
      taxonomy ? String(taxonomy.slug ?? "") : null,
    ],
  );
}

async function deleteServiceCategoryMarketplaceMapping(slug: string, tenantCategoryId: number): Promise<void> {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId || tenantCategoryId <= 0 || !await tableExists("marketplace_service_category_mappings")) return;
  await dbExecute("DELETE FROM marketplace_service_category_mappings WHERE tenant_id=? AND tenant_category_id=?", [tenantId, tenantCategoryId]).catch(() => undefined);
}

export async function syncTenantDirectoryServices(slug: string): Promise<void> {
  const tenant = await getTenant(slug);
  const tenantId = Number(tenant?.id ?? 0);
  const tenantSlug = String(tenant?.slug ?? slug);
  if (tenantId <= 0 || !tenantSlug || !await tableExists("tenant_directory_services")) return;
  if (Number(tenant?.marketplace_public_allowed ?? 1) !== 1) {
    await dbExecute("DELETE FROM tenant_directory_services WHERE tenant_id=?", [tenantId]).catch(() => undefined);
    return;
  }

  const services = await listManageServices(slug, { includeInactive: true });
  const mappings = await listServiceCategoryMarketplaceMappings(slug);
  const mappingByCategory = new Map(mappings.map((mapping) => [mapping.tenantCategoryId, mapping]));
  const bookingPublicAllowed = Number(tenant?.booking_public_allowed ?? 1) === 1;
  const seenIds: number[] = [];

  for (const service of services) {
    if (!service.name.trim()) continue;
    seenIds.push(service.id);
    const mapping = service.categoryId ? mappingByCategory.get(service.categoryId) : null;
    const marketplaceCategoryId = mapping?.marketplaceCategoryId ?? null;
    const marketplaceCategorySlug = mapping?.marketplaceCategorySlug ?? "";
    const marketplaceCategoryName = mapping?.marketplaceCategoryName ?? "";
    const searchText = serviceSearchText(service.name, service.categoryName, marketplaceCategoryName, marketplaceCategorySlug);
    await dbExecute(
      `INSERT INTO tenant_directory_services
        (tenant_id,tenant_slug,service_id,service_name,service_category_id,service_category_name,marketplace_category_id,marketplace_category_slug,marketplace_category_name,is_active,booking_enabled,search_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id,service_id) DO UPDATE SET
        tenant_slug=EXCLUDED.tenant_slug,
        service_name=EXCLUDED.service_name,
        service_category_id=EXCLUDED.service_category_id,
        service_category_name=EXCLUDED.service_category_name,
        marketplace_category_id=EXCLUDED.marketplace_category_id,
        marketplace_category_slug=EXCLUDED.marketplace_category_slug,
        marketplace_category_name=EXCLUDED.marketplace_category_name,
        is_active=EXCLUDED.is_active,
        booking_enabled=EXCLUDED.booking_enabled,
        search_text=EXCLUDED.search_text`,
      [
        tenantId,
        tenantSlug,
        service.id,
        clean(service.name, 190),
        service.categoryId,
        emptyToNull(clean(service.categoryName, 190)),
        marketplaceCategoryId,
        emptyToNull(clean(marketplaceCategorySlug, 120)),
        emptyToNull(clean(marketplaceCategoryName, 190)),
        service.isActive ? 1 : 0,
        bookingPublicAllowed && service.bookingEnabled ? 1 : 0,
        emptyToNull(searchText),
      ],
    );
  }

  if (seenIds.length) {
    await dbExecute(
      `DELETE FROM tenant_directory_services WHERE tenant_id=? AND service_id NOT IN (${seenIds.map(() => "?").join(",")})`,
      [tenantId, ...seenIds],
    );
  } else {
    await dbExecute("DELETE FROM tenant_directory_services WHERE tenant_id=?", [tenantId]);
  }
}

async function updateRowsByColumn(slug: string, tableName: string, column: string, value: unknown, values: Record<string, unknown>): Promise<void> {
  const table = await tenantTable(slug, tableName);
  const filtered = await filterColumns(table.name, values);
  const entries = Object.entries(filtered).filter(([, entryValue]) => entryValue !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",");
  const clauses = [`${quoteIdentifier(column)}=?`];
  const params = [...entries.map(([, entryValue]) => entryValue), value];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET ${assignments} WHERE ${clauses.join(" AND ")}`, params);
}

async function countRowsByColumn(slug: string, tableName: string, column: string, value: unknown, extraWhere = ""): Promise<number> {
  if (!await tableExistsForTenant(slug, tableName)) return 0;
  const table = await tenantTable(slug, tableName);
  if (!await columnExists(table.name, column)) return 0;
  const clauses = [`${quoteIdentifier(column)}=?`];
  const params: unknown[] = [value];
  if (extraWhere) clauses.push(`(${extraWhere})`);
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id=?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
  return Number(rows[0]?.count ?? 0) || 0;
}

async function deleteByOwner(slug: string, tableName: string, ownerColumn: string, ownerId: number): Promise<void> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || ownerId <= 0 || !await columnExists(table.name, ownerColumn)) return;
  const clauses = [`${quoteIdentifier(ownerColumn)} = ?`];
  const params: unknown[] = [ownerId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

async function deleteRecommendationsForService(slug: string, serviceId: number): Promise<void> {
  const table = await tenantTable(slug, "service_recommendations").catch(() => null);
  if (!table) return;
  const clauses = ["(service_id=? OR recommended_service_id=?)"];
  const params: unknown[] = [serviceId, serviceId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id=?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
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

async function tableExistsForTenant(slug: string, table: string): Promise<boolean> {
  try {
    await tenantTable(slug, table);
    return true;
  } catch {
    return false;
  }
}

function categoryOrderSql(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `CASE WHEN LOWER(${prefix}name)='non categorizzato' THEN 1 ELSE 0 END ASC`,
    `COALESCE(${prefix}sort_order,999999) ASC`,
    `${prefix}name ASC`,
    `${prefix}id ASC`,
  ].join(", ");
}

function serviceCategoryJoinOrderSql(hasCategory: boolean): string {
  if (!hasCategory) return "COALESCE(s.sort_order,0) ASC";
  return [
    "CASE WHEN c.id IS NULL OR LOWER(c.name)='non categorizzato' THEN 1 ELSE 0 END ASC",
    "COALESCE(c.sort_order,999999) ASC",
    "COALESCE(c.name,'Non categorizzato') ASC",
    "COALESCE(c.id,999999) ASC",
  ].join(", ");
}

function serviceSearchText(...parts: string[]): string {
  return parts.map((part) => clean(part, 190).toLowerCase()).filter(Boolean).join(" ");
}

function isDefaultCategoryName(value: string): boolean {
  return value.trim().toLowerCase() === "non categorizzato";
}

function parseIdList(value: unknown): number[] {
  if (Array.isArray(value)) return uniquePositive(value.map(Number));
  const raw = String(value ?? "");
  if (!raw) return [];
  return uniquePositive(raw.split(/[,\s]+/).map((item) => Number.parseInt(item, 10)));
}

function parseJsonArray<T>(value: unknown): T[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function uniquePositive(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.floor(value))));
}

function fallbackPositive(value: unknown): number[] {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) && numberValue > 0 ? [Math.floor(numberValue)] : [];
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["1", "true", "yes", "on", "si", "sì"].includes(String(value ?? "").trim().toLowerCase());
}

function parseMoneyValue(value: unknown): number {
  const normalized = String(value ?? "0").replace(/\s*euro\s*/i, "").replace(",", ".");
  return parseNumber(normalized, 0);
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function formatMoney(value: number): string {
  return roundMoney(value).toFixed(2).replace(".", ",");
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
