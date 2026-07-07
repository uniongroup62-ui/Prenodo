import "server-only";

import { randomBytes } from "crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

export type PublicBookingBusiness = {
  name: string;
  about: string;
  email: string;
  phone: string;
  website: string;
};

export type PublicBookingLocation = {
  id: number;
  name: string;
  address: string;
  email: string;
  phone: string;
  bookingEnabled: boolean;
  hoursToday: string;
};

export type PublicBookingCategory = {
  id: number;
  name: string;
  // service_categories.image_url (URL pubblico R2, o path legacy passato
  // invariato) — la card categoria dello step 2 la mostra, con l'SVG di
  // fallback quando vuota (booking.php 13097-13104).
  imageUrl: string;
};

export type PublicBookingService = {
  id: number;
  name: string;
  description: string;
  categoryId: number | null;
  duration: number;
  price: number;
  noOperator: boolean;
  locationIds: number[];
};

export type PublicBookingStaff = {
  id: number;
  name: string;
  serviceIds: number[];
  active: boolean;
};

export type PublicBookingBenefit = {
  id: string;
  type: "coupon" | "promotion" | "giftcard";
  label: string;
  detail: string;
  code?: string;
  promotionId?: number;
  discountType?: "percent" | "fixed";
  discountValue?: number;
};

export type PublicBookingContext = {
  business: PublicBookingBusiness;
  locations: PublicBookingLocation[];
  categories: PublicBookingCategory[];
  services: PublicBookingService[];
  staff: PublicBookingStaff[];
  benefits: PublicBookingBenefit[];
  today: string;
  // businesses.booking_choose_staff_enabled (booking.php $choose_staff_step):
  // se false il wizard SALTA lo step Professionista e auto-assegna l'operatore.
  chooseStaffEnabled: boolean;
  // Badge promo di catalogo per-servizio (booking.php serviceCatalogPromotions):
  // popolato dalla route action=context (dipende da cliente/sede della richiesta),
  // reso sulle card servizio prima che sia scelta una data.
  serviceCatalogPromotions?: Record<string, {
    promotion_id: number;
    display_mode: "discounted_price" | "badge";
    badge_title: string;
    badge_detail: string;
    discount_label: string;
    old_price: number;
    new_price: number;
  }>;
};

export type PublicBookingSlot = {
  time: string;
  available: boolean;
  staffId: number | null;
  staffName: string;
  reason: string;
};

export type PublicBookingHold = {
  token: string;
  expiresAt: string;
  date: string;
  time: string;
  staffId: number | null;
  staffName: string;
};

export type PublicBookingConfirmation = {
  id: number;
  publicCode: string;
  status: string;
  date: string;
  time: string;
  total: number;
  discount: number;
  clientId: number;
  staffId: number | null;
  locationId: number | null;
  // Righe costi per-servizio (listino + prezzo scontato + badge promo).
  services: Array<{ serviceId: number; name: string; listPrice: number; price: number; badge: string }>;
};

type ServiceRow = RowDataPacket & {
  id: number;
  name: string;
  category_id: number | null;
  duration_min: number;
  price: number | string;
  no_operator: number;
};

type StaffCandidate = {
  id: number | null;
  name: string;
  serviceIds: Set<number>;
};

export type BusyRange = {
  start: number;
  end: number;
  locationId: number | null;
  staffIds: number[];
};

// Conteggio sedi prenotabili (stesso filtro di publicBookingContext.locations):
// il gate lo usa per sapere se saltare lo step "Scegli la sede" (sede unica)
// GIÀ al primo render, senza flash lato client (il PHP lo sa server-side).
export async function bookableLocationCount(slug: string): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id",
    where: "COALESCE(is_active, 1) = 1 AND COALESCE(booking_enabled, 1) = 1",
  }).catch(() => [] as RowDataPacket[]);
  return rows.length;
}

export async function publicBookingContext(slug: string): Promise<PublicBookingContext> {
  const [businessRows, locationRows, categoryRows, serviceRows, serviceLocationRows, staffRows, staffServiceRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }),
    tenantSelect<RowDataPacket>({
      slug,
      table: "locations",
      where: "COALESCE(is_active, 1) = 1 AND COALESCE(booking_enabled, 1) = 1",
      orderBy: "sort_order ASC, name ASC",
    }),
    tenantSelect<RowDataPacket>({ slug, table: "service_categories", orderBy: "sort_order ASC, name ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<ServiceRow>({
      slug,
      table: "services",
      where: "COALESCE(is_active, 1) = 1 AND COALESCE(booking_enabled, 1) = 1",
      orderBy: "sort_order ASC, name ASC",
    }),
    tenantSelect<RowDataPacket>({ slug, table: "service_locations" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "staff",
      where: "COALESCE(is_active, 1) = 1",
      orderBy: "full_name ASC, id ASC",
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "staff_services" }).catch(() => [] as RowDataPacket[]),
  ]);

  const business = businessRows[0] ?? {};
  const serviceLocations = groupNumberMap(serviceLocationRows, "service_id", "location_id");
  const staffServices = groupNumberMap(staffServiceRows, "staff_id", "service_id");
  const today = todayIsoLocal();

  // Come il legacy (booking.php 2959: WHERE EXISTS servizio bookable): mostra
  // solo le categorie con almeno un servizio prenotabile — niente categorie
  // vuote o con servizi di sole altre sedi.
  const usedCategoryIds = new Set(
    serviceRows.map((service) => nullableNumber(service.category_id)).filter((id): id is number => !!id),
  );
  const categories = categoryRows
    .map((row) => ({
      id: Number(row.id ?? 0),
      name: String(row.name ?? "Servizi"),
      // Solo URL http assoluti (R2) arrivano al wizard; i path locali legacy
      // (/uploads/...) non esistono nel Next e cadrebbero sul fallback comunque.
      imageUrl: /^https?:\/\//i.test(String(row.image_url ?? "").trim()) ? String(row.image_url).trim() : "",
    }))
    .filter((category) => usedCategoryIds.has(category.id));
  const serviceCategoryIds = new Set(categories.map((category) => category.id));
  // Fallback SOLO per category_id orfani (categoria cancellata) referenziati da
  // un servizio bookable, così quei servizi restano raggiungibili.
  for (const service of serviceRows) {
    const categoryId = nullableNumber(service.category_id);
    if (categoryId && !serviceCategoryIds.has(categoryId)) {
      serviceCategoryIds.add(categoryId);
      categories.push({ id: categoryId, name: `Categoria #${categoryId}`, imageUrl: "" });
    }
  }

  const locations = await Promise.all(locationRows.map(async (row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Sede"),
    // Card sede: solo la colonna address (il legacy NON concatena legal_city).
    address: String(row.address ?? "").trim(),
    city: String(row.legal_city ?? "").trim(),
    region: String(row.legal_region ?? "").trim(),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? "").trim(),
    // Contatti social della sede (salon-social-actions legacy).
    whatsapp: String(row.whatsapp ?? "").trim(),
    facebook: String(row.facebook_url ?? "").trim(),
    instagram: String(row.instagram_url ?? "").trim(),
    tiktok: String(row.tiktok_url ?? "").trim(),
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
    hoursToday: await hoursLabel(slug, nullableNumber(row.id), today),
    hoursWeek: await locationWeekHours(slug, nullableNumber(row.id)),
  })));

  return {
    business: {
      name: String(business.name ?? "BeautySuite"),
      about: String(business.booking_about_text ?? ""),
      email: String(business.email ?? ""),
      phone: String(business.phone ?? ""),
      website: String(business.website ?? ""),
    },
    locations,
    categories,
    services: serviceRows.map((row) => ({
      id: Number(row.id ?? 0),
      name: String(row.name ?? "Servizio"),
      description: "",
      categoryId: nullableNumber(row.category_id),
      duration: Math.max(5, Number(row.duration_min ?? 30)),
      price: roundMoney(Number(row.price ?? 0)),
      noOperator: Number(row.no_operator ?? 0) === 1,
      locationIds: serviceLocations.get(Number(row.id ?? 0)) ?? [],
    })),
    staff: staffRows.map((row) => ({
      id: Number(row.id ?? 0),
      name: String(row.full_name ?? "Operatore"),
      serviceIds: staffServices.get(Number(row.id ?? 0)) ?? [],
      active: Number(row.is_active ?? 1) === 1,
    })),
    benefits: await publicBookingBenefits(slug),
    today,
    chooseStaffEnabled: Number(business.booking_choose_staff_enabled ?? 0) === 1,
  };
}

// ============================================================================
// RISORSE CONDIVISE (V4) — port del vincolo di capacità concorrente legacy:
// shared_resources_requirements_by_service (Helpers.php:12299), totali per sede
// via resource_locations (app_resource_location_qty, 0 se is_enabled!=1,
// fallback resources.qty_total), blocchi occupati [start,end,units] dagli
// appuntamenti pending/scheduled del giorno (shared_resources_blocks_for_range
// ~12492) e PEAK sweep-line per finestra (shared_resources_peak_used_for_
// segment): uno slot cade se peak+need > totale (filter ~13705-13795); al
// salvataggio la stessa verifica LANCIA i messaggi legacy (ensure_..._for_
// sequence ~13804-13884).
// ============================================================================

type ResourceRequirement = { resourceId: number; qtyRequired: number; resourceName: string };

async function sharedResourceRequirementsByService(slug: string, serviceIds: number[]): Promise<Map<number, ResourceRequirement[]>> {
  const map = new Map<number, ResourceRequirement[]>();
  if (!serviceIds.length) return map;
  try {
    const srTable = await tenantTable(slug, "service_resources");
    const resTable = await tenantTable(slug, "resources");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT sr.service_id, sr.resource_id, COALESCE(sr.qty_required, 1) AS qty_required, r.name AS resource_name
         FROM ${quoteIdentifier(srTable.name)} sr
         JOIN ${quoteIdentifier(resTable.name)} r ON r.id = sr.resource_id AND r.tenant_id = sr.tenant_id
        WHERE sr.tenant_id = ? AND sr.service_id IN (${serviceIds.map(() => "?").join(",")})`,
      [srTable.tenantId ?? 0, ...serviceIds],
    );
    for (const r of rows) {
      const sid = Number(r.service_id ?? 0);
      const list = map.get(sid) ?? [];
      list.push({ resourceId: Number(r.resource_id ?? 0), qtyRequired: Math.max(1, Number(r.qty_required ?? 1) || 1), resourceName: String(r.resource_name ?? "") });
      map.set(sid, list);
    }
  } catch { /* tabella assente: nessun vincolo */ }
  return map;
}

// Totale disponibile per risorsa nella sede (resource_locations.qty_total se
// is_enabled=1 e la riga sede esiste; altrimenti fallback resources.qty_total).
async function sharedResourceTotals(slug: string, resourceIds: number[], locationId: number | null): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  if (!resourceIds.length) return totals;
  const resTable = await tenantTable(slug, "resources");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id, COALESCE(qty_total, 0) AS qty_total FROM ${quoteIdentifier(resTable.name)} WHERE tenant_id = ? AND id IN (${resourceIds.map(() => "?").join(",")})`,
    [resTable.tenantId ?? 0, ...resourceIds],
  ).catch(() => [] as RowDataPacket[]);
  for (const r of rows) totals.set(Number(r.id), Math.max(0, Number(r.qty_total ?? 0) || 0));
  if (locationId && locationId > 0) {
    try {
      const rlTable = await tenantTable(slug, "resource_locations");
      const locRows = await dbQuery<RowDataPacket[]>(
        `SELECT resource_id, COALESCE(qty_total, 0) AS qty_total, COALESCE(is_enabled, 1) AS is_enabled
           FROM ${quoteIdentifier(rlTable.name)} WHERE tenant_id = ? AND location_id = ? AND resource_id IN (${resourceIds.map(() => "?").join(",")})`,
        [rlTable.tenantId ?? 0, locationId, ...resourceIds],
      );
      for (const r of locRows) {
        totals.set(Number(r.resource_id), Number(r.is_enabled) === 1 ? Math.max(0, Number(r.qty_total ?? 0) || 0) : 0);
      }
    } catch { /* tabella assente: resta il fallback */ }
  }
  return totals;
}

type ResourceBlock = { start: number; end: number; units: number };

// Blocchi occupati per risorsa nel giorno: righe servizio degli appuntamenti
// pending/scheduled i cui servizi richiedono le risorse date. La finestra è il
// segmento del servizio quando esiste, altrimenti l'intero appuntamento.
async function sharedResourceBlocksForDate(
  slug: string,
  resourceIds: number[],
  date: string,
  excludeAppointmentId: number | null,
): Promise<Map<number, ResourceBlock[]>> {
  const blocks = new Map<number, ResourceBlock[]>();
  if (!resourceIds.length) return blocks;
  try {
    const apptTable = await tenantTable(slug, "appointments");
    const asTable = await tenantTable(slug, "appointment_services");
    const srTable = await tenantTable(slug, "service_resources");
    const segTable = await tenantTable(slug, "appointment_segments").catch(() => null);
    const segJoin = segTable
      ? `LEFT JOIN ${quoteIdentifier(segTable.name)} sg ON sg.appointment_id = a.id AND sg.tenant_id = a.tenant_id AND sg.service_id = sv.service_id`
      : "";
    const segCols = segTable ? ", sg.starts_at AS seg_start, sg.ends_at AS seg_end" : ", NULL AS seg_start, NULL AS seg_end";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT a.id, a.starts_at, a.ends_at, sr.resource_id, COALESCE(sr.qty_required, 1) AS units${segCols}
         FROM ${quoteIdentifier(apptTable.name)} a
         JOIN ${quoteIdentifier(asTable.name)} sv ON sv.appointment_id = a.id AND sv.tenant_id = a.tenant_id
         JOIN ${quoteIdentifier(srTable.name)} sr ON sr.service_id = sv.service_id AND sr.tenant_id = a.tenant_id
         ${segJoin}
        WHERE a.tenant_id = ? AND a.starts_at::date = ?
          AND LOWER(TRIM(COALESCE(a.status,''))) IN ('pending','scheduled')
          AND sr.resource_id IN (${resourceIds.map(() => "?").join(",")})
          ${excludeAppointmentId ? "AND a.id <> ?" : ""}`,
      excludeAppointmentId
        ? [apptTable.tenantId ?? 0, date, ...resourceIds, excludeAppointmentId]
        : [apptTable.tenantId ?? 0, date, ...resourceIds],
    );
    const toMin = (v: unknown): number | null => {
      const s = v instanceof Date
        ? `${String(v.getHours()).padStart(2, "0")}:${String(v.getMinutes()).padStart(2, "0")}`
        : String(v ?? "").replace("T", " ").slice(11, 16);
      return timeToMinutes(s);
    };
    for (const r of rows) {
      const start = toMin(r.seg_start) ?? toMin(r.starts_at);
      const end = toMin(r.seg_end) ?? toMin(r.ends_at);
      if (start === null || end === null || end <= start) continue;
      const rid = Number(r.resource_id ?? 0);
      const list = blocks.get(rid) ?? [];
      list.push({ start, end, units: Math.max(1, Number(r.units ?? 1) || 1) });
      blocks.set(rid, list);
    }
  } catch { /* tabelle assenti */ }
  return blocks;
}

// Picco di unità usate della risorsa dentro [start,end) — sweep sugli estremi.
function resourcePeakInWindow(blocks: ResourceBlock[], start: number, end: number): number {
  const overlapping = blocks.filter((b) => b.start < end && b.end > start);
  if (!overlapping.length) return 0;
  const points = [...new Set(overlapping.flatMap((b) => [Math.max(b.start, start), Math.min(b.end, end)]))];
  let peak = 0;
  for (const p of points) {
    const used = overlapping.filter((b) => b.start <= p && b.end > p).reduce((s, b) => s + b.units, 0);
    peak = Math.max(peak, used);
  }
  return peak;
}

// Contesto risorse per una sequenza di servizi: prepara requisiti/totali/blocchi
// una volta e ritorna il checker per-slot (per il filtro) e l'assert (per il save).
export async function sharedResourcesContext(
  slug: string,
  services: Array<{ id: number; durationMin: number }>,
  locationId: number | null,
  date: string,
  excludeAppointmentId: number | null = null,
): Promise<{
  hasRequirements: boolean;
  slotFree: (startMin: number) => boolean;
  assertAvailable: (startMin: number) => void;
}> {
  const serviceIds = services.map((s) => s.id).filter((n) => n > 0);
  const reqs = await sharedResourceRequirementsByService(slug, serviceIds);
  const allResourceIds = [...new Set([...reqs.values()].flat().map((r) => r.resourceId))];
  if (!allResourceIds.length) {
    return { hasRequirements: false, slotFree: () => true, assertAvailable: () => undefined };
  }
  const totals = await sharedResourceTotals(slug, allResourceIds, locationId);
  const blocks = await sharedResourceBlocksForDate(slug, allResourceIds, date, excludeAppointmentId);

  // Finestre sequenziali per servizio (come il filtro cabine).
  const windows: Array<{ offset: number; duration: number; reqs: ResourceRequirement[] }> = [];
  let offset = 0;
  for (const service of services) {
    const dur = Math.max(5, service.durationMin);
    const serviceReqs = reqs.get(service.id) ?? [];
    if (serviceReqs.length) windows.push({ offset, duration: dur, reqs: serviceReqs });
    offset += dur;
  }

  const evaluate = (startMin: number): { ok: boolean; resourceName: string; need: number; available: number; exhausted: boolean } => {
    for (const win of windows) {
      const segStart = startMin + win.offset;
      const segEnd = segStart + win.duration;
      for (const req of win.reqs) {
        const total = totals.get(req.resourceId) ?? 0;
        if (total <= 0) return { ok: false, resourceName: req.resourceName, need: req.qtyRequired, available: 0, exhausted: true };
        const peak = resourcePeakInWindow(blocks.get(req.resourceId) ?? [], segStart, segEnd);
        if (peak + req.qtyRequired > total) {
          return { ok: false, resourceName: req.resourceName, need: req.qtyRequired, available: Math.max(0, total - peak), exhausted: false };
        }
      }
    }
    return { ok: true, resourceName: "", need: 0, available: 0, exhausted: false };
  };

  return {
    hasRequirements: true,
    slotFree: (startMin) => evaluate(startMin).ok,
    assertAvailable: (startMin) => {
      const res = evaluate(startMin);
      if (res.ok) return;
      // Messaggi legacy (Helpers.php:13865 / 13876).
      if (res.exhausted) throw new Error(`Orario non più disponibile: risorsa "${res.resourceName}" non disponibile.`);
      throw new Error(`Orario non più disponibile: risorsa "${res.resourceName}" esaurita (richieste ${res.need}, disponibili ${res.available}).`);
    },
  };
}

export async function publicBookingSlots({
  slug,
  date,
  serviceIds,
  staffId,
  staffMap = null,
  locationId,
  excludeAppointmentId = null,
}: {
  slug: string;
  date: string;
  serviceIds: number[];
  staffId?: number | null;
  // Mappa per-servizio serviceId -> staffId (booking.php staff_map): quando ogni
  // servizio ha un operatore assegnato si calcolano slot SEGMENT-AWARE
  // (build_slots_multi_staff_segments), ognuno libero nella sua finestra.
  staffMap?: Record<number, number> | null;
  locationId?: number | null;
  // Manage edit flow: the edited appointment must not block its own slot.
  excludeAppointmentId?: number | null;
}): Promise<PublicBookingSlot[]> {
  const normalizedDate = normalizeDate(date);
  const services = await publicServicesByIds(slug, serviceIds, locationId ?? null);
  const duration = services.reduce((sum, service) => sum + Math.max(5, Number(service.duration_min ?? 30)), 0);
  if (duration <= 0) throw new Error("Servizio non valido.");

  // SEGMENT-AWARE quando ogni servizio ha un operatore nel staff_map e non è
  // tutto no_operator: ogni segmento (in sequenza) dev'essere libero per il suo
  // operatore. Altrimenti: candidato unico/qualsiasi per l'intero appuntamento.
  const useSegmentStaff = Boolean(
    staffMap
      && services.length > 0
      && !services.every((service) => Number(service.no_operator ?? 0) === 1)
      && services.every((service) => Number(staffMap[Number(service.id)] ?? 0) > 0),
  );

  const candidates = useSegmentStaff ? [] : await eligibleStaffCandidates(slug, services, staffId ?? null);
  if (!useSegmentStaff && !candidates.length) {
    return [];
  }

  const intervals = await businessIntervals(slug, locationId ?? null, normalizedDate);
  if (!intervals.length) {
    return [];
  }

  const busyRanges = await busyRangesForDate(slug, normalizedDate, { excludeAppointmentId });

  // CABIN filter (live-parity fix 2026-07-02, port of booking_filter_slots_by_cabins):
  // the legacy removes slots whose service cabin is already occupied; the Next only
  // checked cabins at SAVE time (assertAppointmentSlotAvailable), so the drawer/public
  // list offered slots the save would then refuse. Model: each service occupies its
  // primary cabin (services.cabin_id — the same resolution the save uses) for its own
  // sequential segment window; a start is cabin-free when every such window has no
  // overlap with that cabin's busy ranges (appointments + segments + active holds).
  const segmentWindows: Array<{ cabinId: number; offset: number; duration: number }> = [];
  {
    let offset = 0;
    for (const service of services) {
      const dur = Math.max(5, Number(service.duration_min ?? 30));
      const cabinId = Number(service.cabin_id ?? 0) || 0;
      if (cabinId > 0) segmentWindows.push({ cabinId, offset, duration: dur });
      offset += dur;
    }
  }
  const busyCabins = segmentWindows.length
    ? await busyCabinRangesForDate(slug, normalizedDate).catch(() => [] as CabinBusyRange[])
    : [];
  const cabinFree = (start: number): boolean =>
    segmentWindows.every(({ cabinId, offset, duration: dur }) => {
      const segStart = start + offset;
      const segEnd = segStart + dur;
      return !busyCabins.some((busy) => busy.cabinId === cabinId && busy.start < segEnd && busy.end > segStart);
    });

  // RISORSE CONDIVISE (V4, port di shared_resources_filter_slots): uno slot
  // cade se il picco d'uso concorrente + le unità richieste supera il totale
  // della sede per una risorsa di un servizio della sequenza.
  const resourcesCtx = await sharedResourcesContext(
    slug,
    services.map((s) => ({ id: Number(s.id ?? 0), durationMin: Math.max(5, Number(s.duration_min ?? 30)) })),
    locationId ?? null,
    normalizedDate,
    excludeAppointmentId,
  ).catch(() => ({ hasRequirements: false, slotFree: () => true, assertAvailable: () => undefined }));

  const slots: PublicBookingSlot[] = [];
  const minStart = minimumStartForDate(normalizedDate);

  // Segmenti per la modalità staff_map: [operatore, durata] in ordine servizio.
  const staffSegments = useSegmentStaff
    ? services.map((service) => ({
        staffId: Number(staffMap![Number(service.id)]),
        duration: Math.max(5, Number(service.duration_min ?? 30)),
      }))
    : [];
  const segmentDistinctStaff = new Set(staffSegments.map((seg) => seg.staffId));

  // Libero a `start`: in modalità segment ogni segmento dev'essere libero per il
  // suo operatore nella propria finestra; altrimenti un candidato copre l'intero
  // appuntamento. Ritorna l'operatore dello slot (null se ambiguo/qualsiasi).
  const resolveStaff = (start: number): { ok: boolean; staffId: number | null; staffName: string } => {
    if (useSegmentStaff) {
      let offset = 0;
      for (const seg of staffSegments) {
        const cand: StaffCandidate = { id: seg.staffId, name: "", serviceIds: new Set<number>() };
        if (!candidateFree(cand, start + offset, start + offset + seg.duration, locationId ?? null, busyRanges)) {
          return { ok: false, staffId: null, staffName: "" };
        }
        offset += seg.duration;
      }
      return { ok: true, staffId: segmentDistinctStaff.size === 1 ? staffSegments[0].staffId : null, staffName: "" };
    }
    const free = candidates.find((candidate) =>
      candidateFree(candidate, start, start + duration, locationId ?? null, busyRanges),
    );
    return { ok: Boolean(free), staffId: free?.id ?? null, staffName: free?.name ?? "" };
  };

  for (const [opens, closes] of intervals) {
    for (let start = opens; start + duration <= closes; start += 5) {
      if (start < minStart) continue;
      const resolved = resolveStaff(start);
      const available = resolved.ok && cabinFree(start) && resourcesCtx.slotFree(start);
      slots.push({
        time: minutesToTime(start),
        available,
        staffId: available ? resolved.staffId : null,
        staffName: available ? resolved.staffName : "",
        reason: available ? "Disponibile" : "Orario occupato",
      });
    }
  }

  return slots;
}

// Legacy hold TTL per channel (appointment_holds_ttl_seconds_for_channel,
// Helpers.php:12871): 150s for the public wizard, 5 minutes for the backend
// quick-booking drawer (its countdown starts at 5:00).
function holdTtlSecondsForChannel(channel: string): number {
  return channel === "public" ? 150 : 300;
}

// ---------------------------------------------------------------------------
// "Disponibilità" BROWSER for the manage quick-booking modal (port of the legacy
// action=availability with range/summary params — api_appointments.php:6467).
// Per day it returns the exact legacy payload the modal renders:
//  * slots           — bookable starts INSIDE business hours (blue bars), the
//                      same engine as publicBookingSlots (closures, staff,
//                      cabins, past-time filter);
//  * override_slots  — full-day starts OUTSIDE hours / on closed days that an
//                      admin can still book (orange "Fuori orario / Chiusura
//                      (selezionabile)"): staff conflict+time-off free and
//                      cabin free — the legacy isStartSelectable, which skips
//                      the SOFT shift check;
//  * booked/booked_outside — the selected operator's busy ticks (red bars);
//                      empty in any-staff mode, like the legacy;
//  * is_closed/opens/closes/opens2/closes2 — the day's hour intervals;
//  * summary mode (week/month) returns counts + first slots only.
export type ManageAvailabilityDay = {
  date: string;
  label: string;
  label_full: string;
  slots: string[];
  override_slots: string[];
  regular_slot_count: number;
  override_slot_count: number;
  first_regular_slot: string | null;
  first_override_slot: string | null;
  booked: string[];
  booked_outside: string[];
  dst_gap: string[];
  dst_fold: string[];
  is_closed: 0 | 1;
  opens: string | null;
  closes: string | null;
  opens2: string | null;
  closes2: string | null;
};
export type ManageAvailabilityMonth = { label: string; days: ManageAvailabilityDay[] };

const IT_MONTHS = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
const IT_DOW = ["DOM", "LUN", "MAR", "MER", "GIO", "VEN", "SAB"];
const IT_DOW_FULL = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

// All time-off windows of the date, batched by staff id (minutes-of-day, with
// the multi-day clamp of staffTimeoffReasonForRange) — the per-tick override
// scan would otherwise hit the DB hundreds of times per day.
async function staffTimeoffWindowsForDate(slug: string, date: string): Promise<Map<number, Array<[number, number]>>> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_timeoff",
    columns: "staff_id, starts_at, ends_at",
    where: "starts_at::date <= ? AND ends_at::date >= ?",
    params: [date, date],
  }).catch(() => [] as RowDataPacket[]);
  const map = new Map<number, Array<[number, number]>>();
  for (const row of rows) {
    const staffId = Number(row.staff_id ?? 0) || 0;
    if (staffId <= 0) continue;
    const offStart = timeToMinutes(timeFromSql(row.starts_at));
    const offEnd = timeToMinutes(timeFromSql(row.ends_at));
    const effStart = dateFromSql(row.starts_at) < date ? 0 : offStart;
    const effEnd = dateFromSql(row.ends_at) > date ? 24 * 60 : offEnd;
    if (!Number.isFinite(effStart) || !Number.isFinite(effEnd)) continue;
    if (!map.has(staffId)) map.set(staffId, []);
    map.get(staffId)!.push([effStart, effEnd]);
  }
  return map;
}

export async function manageAvailabilityBrowser({
  slug,
  date,
  range,
  months = 1,
  summary = false,
  serviceIds,
  staffId = null,
  locationId = null,
  excludeAppointmentId = null,
}: {
  slug: string;
  date: string;
  range: string;
  months?: number;
  summary?: boolean;
  serviceIds: number[];
  staffId?: number | null;
  locationId?: number | null;
  excludeAppointmentId?: number | null;
}): Promise<{ months: ManageAvailabilityMonth[]; rangeStart: string; rangeEnd: string }> {
  const services = await publicServicesByIds(slug, serviceIds, locationId ?? null);
  const duration = services.reduce((sum, service) => sum + Math.max(5, Number(service.duration_min ?? 30)), 0);
  if (duration <= 0) throw new Error("Durata servizio non valida.");
  const candidates = await eligibleStaffCandidates(slug, services, staffId ?? null);

  // Per-service cabin windows (same model as publicBookingSlots).
  const segmentWindows: Array<{ cabinId: number; offset: number; duration: number }> = [];
  {
    let offset = 0;
    for (const service of services) {
      const dur = Math.max(5, Number(service.duration_min ?? 30));
      const cabinId = Number(service.cabin_id ?? 0) || 0;
      if (cabinId > 0) segmentWindows.push({ cabinId, offset, duration: dur });
      offset += dur;
    }
  }

  // Range (legacy): the start never falls before today; day = 1 day, week = 7
  // days from the anchor, month = from the anchor to the end of its month(s).
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const anchor = new Date(`${normalizeDate(date)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = anchor < today ? new Date(today) : anchor;
  const mode = ["day", "week", "month"].includes(range) ? range : "month";
  const end = new Date(start);
  if (mode === "day") {
    // single day
  } else if (mode === "week") {
    end.setDate(end.getDate() + 6);
  } else {
    const monthsClamped = Math.max(1, Math.min(3, Math.trunc(months) || 1));
    end.setDate(1);
    end.setMonth(end.getMonth() + monthsClamped);
    end.setDate(end.getDate() - 1);
    if (end < start) end.setTime(start.getTime());
  }
  const summaryOnly = summary && mode !== "day";

  const monthsOut: ManageAvailabilityMonth[] = [];
  let currentMonthKey = "";
  const cursor = new Date(start);
  while (cursor <= end) {
    const d = ymd(cursor);
    const monthKey = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      monthsOut.push({ label: `${IT_MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`, days: [] });
    }
    const dow = cursor.getDay();
    const label = `${cursor.getDate()} ${IT_DOW[dow]}`;
    const labelFull = `${cursor.getDate()} ${IT_DOW_FULL[dow]}`;

    const intervals = await businessIntervals(slug, locationId ?? null, d).catch(() => [] as Array<[number, number]>);
    const isClosed = intervals.length === 0;
    const [int1, int2] = intervals;
    const busyRanges = await busyRangesForDate(slug, d, { excludeAppointmentId }).catch(() => [] as BusyRange[]);
    const busyCabins = segmentWindows.length
      ? await busyCabinRangesForDate(slug, d, { excludeAppointmentId }).catch(() => [] as CabinBusyRange[])
      : [];
    const cabinFree = (startMin: number): boolean =>
      segmentWindows.every(({ cabinId, offset, duration: dur }) => {
        const segStart = startMin + offset;
        const segEnd = segStart + dur;
        return !busyCabins.some((busy) => busy.cabinId === cabinId && busy.start < segEnd && busy.end > segStart);
      });
    const minStart = minimumStartForDate(d);

    // Normal slots (blue): the publicBookingSlots loop inline (shared ranges).
    const slots: string[] = [];
    if (!isClosed && candidates.length > 0) {
      for (const [opens, closes] of intervals) {
        for (let s = opens; s + duration <= closes; s += 5) {
          if (s < minStart) continue;
          const free = candidates.find((candidate) => candidateFree(candidate, s, s + duration, locationId ?? null, busyRanges));
          if (free && cabinFree(s)) slots.push(minutesToTime(s));
        }
      }
    }

    // Override slots (orange, day mode only): full-day starts outside hours a
    // manage user can still book (staff busy+time-off free, cabin free).
    const overrideSlots: string[] = [];
    let dstGap: string[] = [];
    if (!summaryOnly && candidates.length > 0) {
      const timeoffByStaff = await staffTimeoffWindowsForDate(slug, d);
      const normalSet = new Set(slots);
      const fitsBusiness = (s: number) => intervals.some(([o, c]) => s >= o && s + duration <= c);
      for (let s = 0; s + duration <= 24 * 60; s += 5) {
        if (s < minStart) continue;
        const time = minutesToTime(s);
        if (normalSet.has(time)) continue;
        const selectable = candidates.some((candidate) => {
          if (!candidateFree(candidate, s, s + duration, locationId ?? null, busyRanges)) return false;
          const offs = candidate.id !== null ? timeoffByStaff.get(candidate.id) ?? [] : [];
          return !offs.some(([o, c]) => overlaps(s, s + duration, o, c));
        });
        if (!selectable) continue;
        if (!cabinFree(s)) continue;
        if (isClosed || !fitsBusiness(s)) overrideSlots.push(time);
      }

      // DST gap ticks (Europe/Rome spring-forward): a local time that does not
      // exist normalizes to a different wall-clock time. Fold detection needs
      // zone-offset APIs unavailable here — the legacy uses both only for
      // tooltips, so gap-only is an accepted approximation.
      dstGap = [];
      for (let s = 0; s < 24 * 60; s += 5) {
        const time = minutesToTime(s);
        const probe = new Date(`${d}T${time}:00`);
        if (!Number.isNaN(probe.getTime())) {
          const back = `${pad(probe.getHours())}:${pad(probe.getMinutes())}`;
          if (back !== time) dstGap.push(time);
        }
      }
    }

    // Booked ticks (red), only with a SPECIFIC operator (legacy any-staff => []).
    const booked: string[] = [];
    const bookedOutside: string[] = [];
    if (!summaryOnly && staffId && staffId > 0) {
      const staffBusy = busyRanges.filter(
        (rangeRow) => sameLocation(locationId ?? null, rangeRow.locationId) && (!rangeRow.staffIds.length || rangeRow.staffIds.includes(staffId)),
      );
      for (let s = 0; s < 24 * 60; s += 5) {
        if (!staffBusy.some((busy) => overlaps(s, s + 5, busy.start, busy.end))) continue;
        const time = minutesToTime(s);
        const inside = intervals.some(([o, c]) => s >= o && s < c);
        if (inside) booked.push(time);
        else bookedOutside.push(time);
      }
    }

    monthsOut[monthsOut.length - 1].days.push({
      date: d,
      label,
      label_full: labelFull,
      slots: summaryOnly ? [] : slots,
      override_slots: summaryOnly ? [] : overrideSlots,
      regular_slot_count: slots.length,
      override_slot_count: overrideSlots.length,
      first_regular_slot: slots[0] ?? null,
      first_override_slot: overrideSlots[0] ?? null,
      booked,
      booked_outside: bookedOutside,
      dst_gap: dstGap,
      dst_fold: [],
      is_closed: isClosed ? 1 : 0,
      opens: int1 ? minutesToTime(int1[0]) : null,
      closes: int1 ? minutesToTime(int1[1]) : null,
      opens2: int2 ? minutesToTime(int2[0]) : null,
      closes2: int2 ? minutesToTime(int2[1]) : null,
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  return { months: monthsOut, rangeStart: ymd(start), rangeEnd: ymd(end) };
}

export async function holdPublicBookingSlot({
  slug,
  date,
  time,
  serviceIds,
  staffId,
  staffMap = null,
  locationId,
  ownerKey,
  channel = "public",
}: {
  slug: string;
  date: string;
  time: string;
  serviceIds: number[];
  staffId?: number | null;
  staffMap?: Record<number, number> | null;
  locationId?: number | null;
  ownerKey: string;
  channel?: string;
}): Promise<PublicBookingHold> {
  const normalizedDate = normalizeDate(date);
  const normalizedTime = normalizeTime(time);
  const slots = await publicBookingSlots({ slug, date: normalizedDate, serviceIds, staffId, staffMap, locationId });
  const selected = slots.find((slot) => slot.time === normalizedTime && slot.available);
  // Exact legacy hold refusal (booking.php:5259 / api_appointments.php:6378).
  if (!selected) throw new Error("Orario non piu disponibile. Ricarica e scegli un altro slot.");

  const services = await publicServicesByIds(slug, serviceIds, locationId ?? null);
  const start = timeToMinutes(normalizedTime);
  const duration = services.reduce((sum, service) => sum + Math.max(5, Number(service.duration_min ?? 30)), 0);
  const expiresAt = addSecondsSqlDate(new Date(), holdTtlSecondsForChannel(channel));
  const token = randomHex(64);
  // Operatori distinti del staff_map (per staff_ids_json + hold single-op).
  const mapOps = staffMap ? Array.from(new Set(Object.values(staffMap).map(Number).filter((n) => n > 0))) : [];
  const selectedStaffId = staffId && staffId > 0 ? staffId : (mapOps.length === 1 ? mapOps[0] : selected.staffId);

  await tenantInsert(await tenantTable(slug, "appointment_holds"), {
    token,
    channel,
    owner_key: ownerKey || "public",
    location_id: locationId && locationId > 0 ? locationId : null,
    starts_at: sqlDateTime(normalizedDate, normalizedTime),
    ends_at: sqlDateTime(normalizedDate, minutesToTime(start + duration)),
    service_ids_json: JSON.stringify(services.map((service) => Number(service.id))),
    staff_ids_json: JSON.stringify(mapOps.length ? mapOps : (selectedStaffId ? [selectedStaffId] : [])),
    cabin_ids_json: JSON.stringify(services.map((service) => nullableNumber(service.cabin_id)).filter(Boolean)),
    segments_json: JSON.stringify(buildSegments(normalizedDate, normalizedTime, services, selectedStaffId, staffMap)),
    resource_blocks_json: JSON.stringify([]),
    status: "active",
    expires_at: expiresAt,
  });

  return {
    token,
    expiresAt,
    date: normalizedDate,
    time: normalizedTime,
    staffId: selectedStaffId ?? null,
    staffName: selected.staffName,
  };
}

export async function releasePublicBookingHold({
  slug,
  token,
  ownerKey,
}: {
  slug: string;
  token: string;
  ownerKey: string;
}): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    where: "token = ? AND owner_key = ? AND status = 'active'",
    params: [token, ownerKey || "public"],
    limit: 1,
  });
  const id = Number(rows[0]?.id ?? 0);
  if (id <= 0) return false;
  return (await tenantUpdate({ slug, table: "appointment_holds", id, values: { status: "released" } })) > 0;
}

export async function renewPublicBookingHold({
  slug,
  token,
  ownerKey,
}: {
  slug: string;
  token: string;
  ownerKey: string;
}): Promise<PublicBookingHold> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    where: "token = ? AND owner_key = ? AND status = 'active'",
    params: [token, ownerKey || "public"],
    limit: 1,
  });
  const row = rows[0];
  const id = Number(row?.id ?? 0);
  if (id <= 0) throw new Error("Hold non trovato.");

  // Renew with the TTL of the hold's own channel (legacy appointment_hold_renew
  // passes the channel through to the per-channel TTL).
  const expiresAt = addSecondsSqlDate(new Date(), holdTtlSecondsForChannel(String(row.channel ?? "public")));
  await tenantUpdate({ slug, table: "appointment_holds", id, values: { expires_at: expiresAt } });
  const staffId = parseNumberArray(row.staff_ids_json)[0] ?? null;

  return {
    token,
    expiresAt,
    date: dateFromSql(row.starts_at),
    time: timeFromSql(row.starts_at),
    staffId,
    staffName: staffId ? `Operatore #${staffId}` : "",
  };
}

// Benefit resolution computed SERVER-SIDE by the booking route (see
// lib/public-booking-benefits.ts) and applied at insert: per-service promo
// prices, coupon/promo notes lines and the applied promotion id. The legacy
// public confirm persists NO discount columns — coupon in notes, promo in the
// per-service prices — so `benefits` replaces the old discount_type/value shim.
export type PublicBookingConfirmBenefits = {
  couponCode: string | null;
  couponDiscount: number;
  promotionId: number | null;
  promotionTitle: string;
  promoDiscount: number;
  serviceOverrides: Array<{ serviceId: number; price: number; listPrice: number; badge: string }>;
  noteLines: string[];
  totalDiscount: number;
};

export async function confirmPublicBooking({
  slug,
  date,
  time,
  serviceIds,
  staffId,
  staffMap = null,
  locationId,
  ownerKey,
  holdToken,
  clientName,
  clientEmail,
  clientPhone,
  couponCode,
  promotionId,
  notes,
  benefits = null,
}: {
  slug: string;
  date: string;
  time: string;
  serviceIds: number[];
  staffId?: number | null;
  staffMap?: Record<number, number> | null;
  locationId?: number | null;
  ownerKey: string;
  holdToken?: string | null;
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  couponCode?: string;
  promotionId?: number | null;
  notes?: string;
  benefits?: PublicBookingConfirmBenefits | null;
}): Promise<PublicBookingConfirmation> {
  const normalizedDate = normalizeDate(date);
  const normalizedTime = normalizeTime(time);
  const services = await publicServicesByIds(slug, serviceIds, locationId ?? null);
  const start = timeToMinutes(normalizedTime);
  const duration = services.reduce((sum, service) => sum + Math.max(5, Number(service.duration_min ?? 30)), 0);
  // Operatori distinti del staff_map: se uno solo diventa lo staff dell'appuntamento,
  // se molti l'appuntamento resta multi-operatore (uno per segmento).
  const mapOps = staffMap ? Array.from(new Set(Object.values(staffMap).map(Number).filter((n) => n > 0))) : [];
  const selectedStaffId = staffId && staffId > 0 ? staffId : (mapOps.length === 1 ? mapOps[0] : null);

  if (holdToken) {
    await assertActivePublicHold({
      slug,
      token: holdToken,
      ownerKey,
      date: normalizedDate,
      time: normalizedTime,
      serviceIds: services.map((service) => Number(service.id)),
      staffId: selectedStaffId,
      locationId: locationId ?? null,
    });
  } else {
    const slots = await publicBookingSlots({ slug, date: normalizedDate, serviceIds, staffId: selectedStaffId, staffMap, locationId });
    if (!slots.some((slot) => slot.time === normalizedTime && slot.available)) {
      throw new Error("Orario non disponibile.");
    }
  }

  const client = await resolvePublicClient({
    slug,
    name: clientName,
    email: clientEmail ?? "",
    phone: clientPhone ?? "",
    locationId: locationId ?? null,
  });
  const subtotal = services.reduce((sum, service) => sum + Number(service.price ?? 0), 0);
  // Legacy-faithful benefit application when the route resolved them; the plain
  // discount shim stays as the fallback for direct API callers.
  const legacyBenefits = benefits ?? null;
  const discount = legacyBenefits
    ? { amount: legacyBenefits.totalDiscount, label: "" }
    : await publicDiscount(slug, subtotal, couponCode, promotionId ?? null);
  const publicCode = randomHex(10).toUpperCase();
  const appointments = await tenantTable(slug, "appointments");
  // autoNote (legacy): "Servizi: ..." + the coupon/promo lines -> appointments.notes.
  const autoNoteLines = legacyBenefits
    ? [
        `Servizi: ${services.map((service) => String(service.name ?? "").trim()).filter(Boolean).join(", ")}`,
        ...legacyBenefits.noteLines,
      ]
    : [];
  const values: Record<string, unknown> = {
    client_id: client.id,
    service_id: Number(services[0]?.id ?? 0) || null,
    cabin_id: nullableNumber(services[0]?.cabin_id),
    starts_at: sqlDateTime(normalizedDate, normalizedTime),
    ends_at: sqlDateTime(normalizedDate, minutesToTime(start + duration)),
    status: "pending",
    // Legacy public INSERT writes NO discount columns: the coupon lives in the
    // notes lines and the promotion in per-service prices (+ promotion_id).
    discount_type: legacyBenefits ? null : (discount.amount > 0 ? "fixed" : null),
    discount_value: legacyBenefits ? 0 : discount.amount,
    promotion_id: legacyBenefits
      ? (legacyBenefits.promotionId && legacyBenefits.promotionId > 0 ? legacyBenefits.promotionId : null)
      : (promotionId && promotionId > 0 ? promotionId : null),
    location_id: locationId && locationId > 0 ? locationId : null,
    notes: autoNoteLines.length ? autoNoteLines.join("\n") : null,
    customer_notes: legacyBenefits
      ? (String(notes ?? "").trim() || null)
      : ([notes, discount.label].filter(Boolean).join("\n") || null),
  };
  if (await columnExists(appointments.name, "public_code")) values.public_code = publicCode;
  const appointmentId = await tenantInsert(appointments, values);

  await insertPublicAppointmentServices(slug, appointmentId, services, legacyBenefits?.serviceOverrides ?? []);
  // staff dell'appuntamento: tutti gli operatori distinti (staff_map) o il singolo.
  const staffToInsert = mapOps.length ? mapOps : (selectedStaffId ? [selectedStaffId] : []);
  for (const opId of staffToInsert) await insertPublicAppointmentStaff(slug, appointmentId, opId);
  if (locationId && locationId > 0) await insertPublicAppointmentLocation(slug, appointmentId, locationId);
  await insertPublicAppointmentSegments(slug, appointmentId, normalizedDate, normalizedTime, services, selectedStaffId, staffMap);
  if (holdToken) await markPublicHoldConverted(slug, holdToken, ownerKey, appointmentId);

  // Promotion redemption record (same shape the manage save writes; removed by
  // the delete/cancel cleanup). Best-effort like every voucher side-write.
  if (legacyBenefits?.promotionId && legacyBenefits.promotionId > 0 && legacyBenefits.promoDiscount > 0) {
    const redTable = await tenantTable(slug, "promotion_redemptions").catch(() => null);
    if (redTable) {
      await tenantInsert(redTable, {
        promotion_id: legacyBenefits.promotionId,
        client_id: client.id > 0 ? client.id : null,
        appointment_id: appointmentId,
        discount_amount: roundMoney(legacyBenefits.promoDiscount),
        location_id: locationId && locationId > 0 ? locationId : null,
        redeemed_at: new Date(),
      }).catch(() => 0);
    }
  }

  // Righe per-servizio con prezzo di listino + prezzo scontato + badge (dai
  // serviceOverrides della promozione), per il dettaglio costi della conferma
  // (booking.php 8957-8987: prezzo barrato + scontato + badge).
  const serviceLines = services.map((service) => {
    const serviceId = Number(service.id ?? 0) || 0;
    const override = (legacyBenefits?.serviceOverrides ?? []).find((o) => o.serviceId === serviceId);
    return {
      serviceId,
      name: String(service.name ?? "").trim(),
      listPrice: roundMoney(override ? override.listPrice : Number(service.price ?? 0)),
      price: roundMoney(override ? override.price : Number(service.price ?? 0)),
      badge: String(override?.badge ?? ""),
    };
  });
  return {
    id: appointmentId,
    publicCode,
    status: "pending",
    date: normalizedDate,
    time: normalizedTime,
    total: roundMoney(Math.max(0, subtotal - discount.amount)),
    discount: discount.amount,
    clientId: client.id,
    staffId: selectedStaffId,
    locationId: locationId ?? null,
    services: serviceLines,
  };
}

async function publicBookingBenefits(slug: string): Promise<PublicBookingBenefit[]> {
  const today = todayIsoLocal();
  const [coupons, promotions] = await Promise.all([
    tenantSelect<RowDataPacket>({
      slug,
      table: "coupons",
      where: "COALESCE(is_active, 1) = 1 AND deleted_at IS NULL AND cancelled_at IS NULL AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)",
      params: [today, today],
      orderBy: "created_at DESC, id DESC",
      limit: 4,
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "promotions",
      where: "COALESCE(is_active, 1) = 1 AND COALESCE(show_in_booking, 1) = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)",
      params: [today, today],
      orderBy: "priority DESC, id DESC",
      limit: 4,
    }).catch(() => [] as RowDataPacket[]),
  ]);

  return [
    ...coupons.map((row) => ({
      id: `coupon:${row.id}`,
      type: "coupon" as const,
      label: String(row.code ?? "Coupon"),
      detail: benefitDetail(row.discount_type, row.discount_value),
      code: String(row.code ?? ""),
      discountType: discountKind(row.discount_type),
      discountValue: roundMoney(Number(row.discount_value ?? 0)),
    })),
    ...promotions.map((row) => ({
      id: `promotion:${row.id}`,
      type: "promotion" as const,
      label: String(row.title ?? "Promozione"),
      detail: benefitDetail(row.discount_type, row.discount_value),
      promotionId: Number(row.id ?? 0),
      discountType: discountKind(row.discount_type),
      discountValue: roundMoney(Number(row.discount_value ?? 0)),
    })),
  ];
}

async function publicServicesByIds(slug: string, rawServiceIds: number[], locationId: number | null): Promise<ServiceRow[]> {
  const ids = Array.from(new Set(rawServiceIds.map((id) => Math.floor(id)).filter((id) => id > 0)));
  if (!ids.length) throw new Error("Seleziona almeno un servizio.");
  const placeholders = ids.map(() => "?").join(",");
  const rows = await tenantSelect<ServiceRow>({
    slug,
    table: "services",
    where: `id IN (${placeholders}) AND COALESCE(is_active, 1) = 1 AND COALESCE(booking_enabled, 1) = 1`,
    params: ids,
    orderBy: "sort_order ASC, id ASC",
  });
  if (rows.length !== ids.length) throw new Error("Uno o piu servizi non sono prenotabili.");
  if (locationId && locationId > 0) {
    const locationRows = await tenantSelect<RowDataPacket>({ slug, table: "service_locations" }).catch(() => [] as RowDataPacket[]);
    const byService = groupNumberMap(locationRows, "service_id", "location_id");
    const blocked = rows.find((row) => {
      const allowed = byService.get(Number(row.id ?? 0)) ?? [];
      return allowed.length > 0 && !allowed.includes(locationId);
    });
    if (blocked) throw new Error("Servizio non disponibile nella sede selezionata.");
  }
  return rows;
}

async function eligibleStaffCandidates(slug: string, services: ServiceRow[], requestedStaffId: number | null): Promise<StaffCandidate[]> {
  if (services.every((service) => Number(service.no_operator ?? 0) === 1)) {
    return [{ id: null, name: "", serviceIds: new Set() }];
  }

  const [staffRows, staffServiceRows] = await Promise.all([
    tenantSelect<RowDataPacket>({
      slug,
      table: "staff",
      where: requestedStaffId ? "id = ? AND COALESCE(is_active, 1) = 1" : "COALESCE(is_active, 1) = 1",
      params: requestedStaffId ? [requestedStaffId] : [],
      orderBy: "full_name ASC, id ASC",
    }),
    tenantSelect<RowDataPacket>({ slug, table: "staff_services" }).catch(() => [] as RowDataPacket[]),
  ]);
  const serviceIds = services.filter((service) => Number(service.no_operator ?? 0) !== 1).map((service) => Number(service.id));
  const mappedByStaff = new Map<number, Set<number>>();
  const mappedServiceIds = new Set<number>();
  for (const row of staffServiceRows) {
    const staffId = Number(row.staff_id ?? 0);
    const serviceId = Number(row.service_id ?? 0);
    if (!mappedByStaff.has(staffId)) mappedByStaff.set(staffId, new Set());
    mappedByStaff.get(staffId)!.add(serviceId);
    mappedServiceIds.add(serviceId);
  }

  return staffRows
    .map((row) => ({
      id: Number(row.id ?? 0),
      name: String(row.full_name ?? "Operatore"),
      serviceIds: mappedByStaff.get(Number(row.id ?? 0)) ?? new Set<number>(),
    }))
    .filter((staff) => serviceIds.every((serviceId) => !mappedServiceIds.has(serviceId) || staff.serviceIds.has(serviceId)));
}

export type PublicBookingStaffGroup = {
  serviceId: number;
  name: string;
  staff: Array<{ id: number; name: string }>;
};

// Operatori idonei PER SINGOLO servizio (booking.php mode=staff -> staff_for_service):
// il wizard, quando la scelta operatore è attiva, rende un gruppo per servizio.
// Un servizio senza righe staff_services è aperto a TUTTI gli operatori attivi
// (come eligibleStaffCandidates); SSO è escluso; no_operator => nessun operatore.
export async function publicBookingStaffPerService(slug: string, serviceIds: number[], locationId: number | null): Promise<PublicBookingStaffGroup[]> {
  const ids = Array.from(new Set(serviceIds.map(Number).filter((n) => n > 0)));
  if (!ids.length) return [];
  const services = await publicServicesByIds(slug, ids, locationId);
  if (!services.length) return [];

  const [staffRows, staffServiceRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "staff", where: "COALESCE(is_active, 1) = 1 AND UPPER(COALESCE(full_name, '')) <> 'SSO'", orderBy: "full_name ASC, id ASC" }),
    tenantSelect<RowDataPacket>({ slug, table: "staff_services" }).catch(() => [] as RowDataPacket[]),
  ]);
  const mappedByStaff = new Map<number, Set<number>>();
  const mappedServiceIds = new Set<number>();
  for (const row of staffServiceRows) {
    const staffId = Number(row.staff_id ?? 0);
    const serviceId = Number(row.service_id ?? 0);
    if (!mappedByStaff.has(staffId)) mappedByStaff.set(staffId, new Set());
    mappedByStaff.get(staffId)!.add(serviceId);
    mappedServiceIds.add(serviceId);
  }
  const active = staffRows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.full_name ?? "Operatore"),
    serviceIds: mappedByStaff.get(Number(row.id ?? 0)) ?? new Set<number>(),
  }));

  const svcById = new Map(services.map((svc) => [Number(svc.id), svc]));
  const out: PublicBookingStaffGroup[] = [];
  for (const sid of ids) {
    const svc = svcById.get(sid);
    if (!svc) continue;
    if (Number(svc.no_operator ?? 0) === 1) {
      out.push({ serviceId: sid, name: String(svc.name ?? ""), staff: [] });
      continue;
    }
    const serviceMapped = mappedServiceIds.has(sid);
    const eligible = active.filter((member) => !serviceMapped || member.serviceIds.has(sid));
    out.push({ serviceId: sid, name: String(svc.name ?? ""), staff: eligible.map((member) => ({ id: member.id, name: member.name })) });
  }
  return out;
}

async function businessIntervals(slug: string, locationId: number | null, date: string): Promise<Array<[number, number]>> {
  // Priority faithful to the legacy getStoreScheduleForDate:
  //   0) a business_hours_exceptions row for the date WINS over everything (a
  //      normally-closed day can special-open, or get custom hours);
  //   1) a CLOSURE for the date => fully closed (no slots);
  //   2) otherwise the weekly business_hours.
  const exceptionRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours_exceptions",
    where: locationId ? "date = ? AND (location_id = ? OR location_id IS NULL)" : "date = ? AND location_id IS NULL",
    params: locationId ? [date, locationId] : [date],
    orderBy: "location_id DESC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const exception = preferredLocationRow(exceptionRows, locationId);
  if (exception) return intervalsFromHoursRow(exception);

  // CLOSURE check (live-parity fix 2026-07-02): the slot engine ignored the
  // closures table entirely — a closed day still offered its full weekly grid,
  // so a customer could book on a closure (the PHP returns zero slots).
  const closureRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "closures",
    columns: "id",
    where: locationId ? "date = ? AND (location_id = ? OR location_id IS NULL)" : "date = ?",
    params: locationId ? [date, locationId] : [date],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (closureRows.length > 0) return [];

  const dow = new Date(`${date}T12:00:00`).getDay();
  const hourRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours",
    where: locationId ? "dow = ? AND (location_id = ? OR location_id IS NULL)" : "dow = ? AND location_id IS NULL",
    params: locationId ? [dow, locationId] : [dow],
    orderBy: "location_id DESC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const hours = preferredLocationRow(hourRows, locationId);
  if (!hours) return [[9 * 60, 19 * 60]];
  return intervalsFromHoursRow(hours);
}

// Port of booking.php mode=closures (:4866): the closed day-of-weeks (weekly
// business_hours), the specific closure DATES over the next 365 days and the
// special-open dates (business_hours_exceptions is_closed=0, which REOPEN a
// day) — the public date strip disables closed days like the legacy wizard.
export async function publicBookingClosures(slug: string, locationId: number | null): Promise<{ closedDows: number[]; closedDates: string[]; openDates: string[]; closureRanges: Array<{ start: string; end: string; reason: string }> }> {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Giorno di calendario successivo (UTC, per evitare shift da fuso) — usato per
  // raggruppare le chiusure consecutive (booking_dates_consecutive_asc: +1 day).
  const nextYmd = (ymd: string): string => {
    const [y, m, d] = ymd.split("-").map((n) => Number.parseInt(n, 10));
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  const today = new Date();
  const from = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const toDateObj = new Date(today);
  toDateObj.setDate(toDateObj.getDate() + 365);
  const to = `${toDateObj.getFullYear()}-${pad(toDateObj.getMonth() + 1)}-${pad(toDateObj.getDate())}`;

  const closureRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "closures",
    columns: "date, reason",
    where: locationId
      ? "(location_id IS NULL OR location_id = ?) AND date BETWEEN ? AND ?"
      : "location_id IS NULL AND date BETWEEN ? AND ?",
    params: locationId ? [locationId, from, to] : [from, to],
    orderBy: "date ASC",
  }).catch(() => [] as RowDataPacket[]);
  // date => motivazione (l'ultima riga vince, come il foreach del legacy).
  const closedMap = new Map<string, string>();
  for (const row of closureRows) {
    const d = dateFromSql(row.date);
    if (d) closedMap.set(d, String(row.reason ?? ""));
  }

  // Special opens override closures (the legacy removes them from closed_dates).
  const openRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours_exceptions",
    columns: "date",
    where: locationId
      ? "COALESCE(is_closed,0) = 0 AND (location_id IS NULL OR location_id = ?) AND date BETWEEN ? AND ?"
      : "COALESCE(is_closed,0) = 0 AND location_id IS NULL AND date BETWEEN ? AND ?",
    params: locationId ? [locationId, from, to] : [from, to],
    orderBy: "date ASC",
  }).catch(() => [] as RowDataPacket[]);
  const openDates = Array.from(new Set(openRows.map((row) => dateFromSql(row.date)).filter(Boolean)));
  for (const date of openDates) closedMap.delete(date);

  // Weekly closed dows: the effective business_hours row (location-preferred)
  // yields no intervals (is_closed / empty hours). A missing row = open (the
  // slot engine's 9-19 default).
  const weeklyRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours",
    where: locationId ? "(location_id IS NULL OR location_id = ?)" : "location_id IS NULL",
    params: locationId ? [locationId] : [],
    orderBy: "dow ASC, location_id DESC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const closedDows: number[] = [];
  for (let dow = 0; dow <= 6; dow++) {
    const rowsForDow = weeklyRows.filter((row) => Number(row.dow ?? -1) === dow);
    const preferred = preferredLocationRow(rowsForDow, locationId);
    if (preferred && intervalsFromHoursRow(preferred).length === 0) closedDows.push(dow);
  }

  // Raggruppa chiusure CONSECUTIVE con la STESSA motivazione in intervalli per
  // la notifica del wizard (booking.php 4971-4993).
  const closedDates = Array.from(closedMap.keys()).sort();
  const closureRanges: Array<{ start: string; end: string; reason: string }> = [];
  for (let i = 0; i < closedDates.length; ) {
    const start = closedDates[i];
    const reason = closedMap.get(start) ?? "";
    let end = start;
    let j = i + 1;
    while (
      j < closedDates.length
      && nextYmd(closedDates[j - 1]) === closedDates[j]
      && (closedMap.get(closedDates[j]) ?? "") === reason
    ) {
      end = closedDates[j];
      j++;
    }
    closureRanges.push({ start, end, reason });
    i = j;
  }
  return { closedDows, closedDates, openDates, closureRanges };
}

// Per-staff UNAVAILABILITY bands for the calendar staff-day view (port of the
// legacy action=list include_unavailability=1, api_appointments.php:8218):
// per active operator (SSO excluded), the grey ranges = OFF-SHIFT gaps (the
// day complement of staff_availability, ONLY when the operator uses the
// availability feature — no rows at all => unconstrained) merged with the
// TIME-OFF windows, clipped to the store's open intervals. Minutes-of-day.
export type StaffUnavailabilityBand = { staffId: number; start: number; end: number };

export async function staffUnavailabilityForDate(
  slug: string,
  date: string,
  locationId: number | null,
): Promise<StaffUnavailabilityBand[]> {
  const openIntervals = await businessIntervals(slug, locationId, date).catch(() => [] as Array<[number, number]>);
  // Store fully closed: the calendar's store bands already shade the whole
  // column (the legacy emits store_closed events; same visual outcome).
  if (!openIntervals.length) return [];

  const staffRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id",
    where: "COALESCE(is_active,1) = 1 AND full_name <> 'SSO'",
    orderBy: "full_name ASC",
  }).catch(() => [] as RowDataPacket[]);
  const staffIds = staffRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  if (!staffIds.length) return [];

  // Batch loads: every availability row overlapping the date + every timeoff.
  const availRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_availability",
    columns: "staff_id, kind, starts_at, ends_at, location_id",
    where: locationId
      ? "(location_id = ? OR location_id IS NULL) AND starts_at::date <= ? AND ends_at::date >= ?"
      : "starts_at::date <= ? AND ends_at::date >= ?",
    params: locationId ? [locationId, date, date] : [date, date],
    orderBy: "starts_at ASC",
  }).catch(() => [] as RowDataPacket[]);
  // Feature gate (staff_availability_has_any): ANY row for the staff (this
  // location or global), not just today's.
  const anyRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_availability",
    columns: "DISTINCT staff_id",
    where: locationId ? "(location_id = ? OR location_id IS NULL)" : "1 = 1",
    params: locationId ? [locationId] : [],
  }).catch(() => [] as RowDataPacket[]);
  const usesAvailability = new Set(anyRows.map((row) => Number(row.staff_id ?? 0)).filter((id) => id > 0));
  const timeoffRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_timeoff",
    columns: "staff_id, starts_at, ends_at",
    where: "starts_at::date <= ? AND ends_at::date >= ?",
    params: [date, date],
  }).catch(() => [] as RowDataPacket[]);

  const mergeRanges = (ranges: Array<[number, number]>): Array<[number, number]> => {
    const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of sorted) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  };
  const dayMinutes = (value: unknown, endOfRange: boolean): number => {
    const day = dateFromSql(value);
    if (endOfRange) return day > date ? 24 * 60 : timeToMinutes(timeFromSql(value));
    return day < date ? 0 : timeToMinutes(timeFromSql(value));
  };

  const out: StaffUnavailabilityBand[] = [];
  for (const staffId of staffIds) {
    const blocks: Array<[number, number]> = [];

    // OFF-SHIFT gaps (staff_schedule_blocks_for_date): only when the operator
    // uses the availability feature. Location-specific rows win; 'presenza'
    // rows override 'turno' rows (same preference as the slot-engine check).
    if (usesAvailability.has(staffId)) {
      const own = availRows.filter((row) => Number(row.staff_id ?? 0) === staffId);
      let rows = own;
      if (locationId) {
        const specific = own.filter((row) => Number(row.location_id ?? 0) === locationId);
        if (specific.length) rows = specific;
      }
      const presence = rows.filter((row) => String(row.kind ?? "").trim().toLowerCase() === "presenza");
      const used = presence.length ? presence : rows;
      const avail = mergeRanges(used.map((row): [number, number] => [dayMinutes(row.starts_at, false), dayMinutes(row.ends_at, true)]));
      if (!avail.length) {
        blocks.push([0, 24 * 60]); // configured but no shift today => whole day off
      } else {
        let cursor = 0;
        for (const [s, e] of avail) {
          if (s > cursor) blocks.push([cursor, s]);
          cursor = Math.max(cursor, e);
        }
        if (cursor < 24 * 60) blocks.push([cursor, 24 * 60]);
      }
    }

    // TIME-OFF windows clamped to the day.
    for (const row of timeoffRows) {
      if (Number(row.staff_id ?? 0) !== staffId) continue;
      const s = dayMinutes(row.starts_at, false);
      const e = dayMinutes(row.ends_at, true);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) blocks.push([s, e]);
    }
    if (!blocks.length) continue;

    // Merge, then clip to the store's open intervals (the legacy intersects).
    for (const [bs, be] of mergeRanges(blocks)) {
      for (const [os, oe] of openIntervals) {
        const s = Math.max(bs, os);
        const e = Math.min(be, oe);
        if (e > s) out.push({ staffId, start: s, end: e });
      }
    }
  }
  return out;
}

async function hoursLabel(slug: string, locationId: number | null, date: string): Promise<string> {
  const intervals = await businessIntervals(slug, locationId, date);
  if (!intervals.length) return "Oggi chiuso";
  return `Oggi ${intervals.map(([start, end]) => `${minutesToTime(start)} - ${minutesToTime(end)}`).join(" / ")}`;
}

// Port di marketplace_location_week_hours (public_marketplace.php 323-395):
// orari settimanali REALI per sede dal weekly business_hours (opens/closes/
// opens2/closes2/is_closed), non fabbricati. Ordine lun→dom, flag today/closed.
export type WeekHourItem = { label: string; hours: string; closed: boolean; today: boolean };
async function locationWeekHours(slug: string, locationId: number | null): Promise<WeekHourItem[]> {
  const days: Array<[number, string]> = [
    [1, "lunedi"], [2, "martedi"], [3, "mercoledi"], [4, "giovedi"], [5, "venerdi"], [6, "sabato"], [0, "domenica"],
  ];
  const todayDow = new Date().getDay(); // 0=domenica..6=sabato, come date('w')
  const items: WeekHourItem[] = [];
  for (const [dow, label] of days) {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "business_hours",
      where: locationId ? "dow = ? AND (location_id = ? OR location_id IS NULL)" : "dow = ? AND location_id IS NULL",
      params: locationId ? [dow, locationId] : [dow],
      orderBy: "location_id DESC, id ASC",
      limit: 2,
    }).catch(() => [] as RowDataPacket[]);
    const row = preferredLocationRow(rows, locationId);
    const closed = row != null && Number(row.is_closed ?? 0) === 1;
    let hours = "Su appuntamento";
    if (row != null && !closed) {
      const intervals = intervalsFromHoursRow(row);
      if (intervals.length) hours = intervals.map(([s, e]) => `${minutesToTime(s)} - ${minutesToTime(e)}`).join(" / ");
    }
    if (closed) hours = "Chiuso";
    items.push({ label, hours, closed, today: dow === todayDow });
  }
  return items;
}

// Gather the busy ranges for a date. Optional exclusions let a manage save check
// availability against everyone EXCEPT (a) the appointment it is editing
// (excludeAppointmentId — its appointments row + its appointment_staff rows) and
// (b) the booking's own active hold (excludeHoldToken). Without these exclusions a
// save would conflict with itself / its own [Disponibilità] hold. The public slot
// finder calls this with no exclusions, so its behavior is unchanged.
//
// M3 (segment-level staff conflicts): mirrors the legacy `staff_has_conflict_in_range`
// (api_appointments.php:4213), which judges overlap per-SEGMENT (appointment_segments
// windows) rather than against an appointment's single rolled-up span. We therefore
// emit ONE busy range PER segment (its own staff_id + starts_at + ends_at), so a
// multi-service appointment whose operator is busy in only one segment no longer
// blocks the whole rolled-up window. Appointments that have NO segments fall back to
// the appointment span with its aggregated appointment_staff ids (the legacy
// "legacy-appointments-missing-a-segment" handling). The no-staff-range-blocks-everyone
// rule is preserved by candidateFree (a range with an empty staffIds list blocks any
// operator).
// Whitelist stati "attivi" (occupanti) — port di api_appt_active_status_sql
// (api_appointments.php:28-57): pending/scheduled/done (+ sinonimi legacy). Gli stati
// NON in whitelist (canceled/cancelled/no_show/rejected/...) LIBERANO lo slot, come nel
// legacy sia pubblico (booking.php) sia backend. Prima il Next usava una blacklist
// `status NOT IN ('canceled','cancelled')` che teneva erroneamente occupato un no_show.
const ACTIVE_APPOINTMENT_STATUS_SQL =
  "LOWER(TRIM(COALESCE(status,''))) IN ('pending','scheduled','done','prenotato','prenotata','confirmed','confermato','confermata','approved','booked','in sospeso','in attesa','attesa','eseguito','eseguita','executed','completed','completato','completata')";

export async function busyRangesForDate(
  slug: string,
  date: string,
  options: { excludeAppointmentId?: number | null; excludeHoldToken?: string | null } = {},
): Promise<BusyRange[]> {
  const excludeAppointmentId = options.excludeAppointmentId && options.excludeAppointmentId > 0 ? options.excludeAppointmentId : null;
  const excludeHoldToken = (options.excludeHoldToken ?? "").trim();

  const appointmentWhere = excludeAppointmentId
    ? `starts_at::date = ? AND ${ACTIVE_APPOINTMENT_STATUS_SQL} AND id <> ?`
    : `starts_at::date = ? AND ${ACTIVE_APPOINTMENT_STATUS_SQL}`;
  const appointmentParams = excludeAppointmentId ? [date, excludeAppointmentId] : [date];

  const segmentWhere = excludeAppointmentId
    ? "starts_at::date = ? AND appointment_id <> ?"
    : "starts_at::date = ?";
  const segmentParams = excludeAppointmentId ? [date, excludeAppointmentId] : [date];

  const holdWhere = excludeHoldToken
    ? "starts_at::date = ? AND status = 'active' AND expires_at > NOW() AND token <> ?"
    : "starts_at::date = ? AND status = 'active' AND expires_at > NOW()";
  const holdParams = excludeHoldToken ? [date, excludeHoldToken] : [date];

  const [appointmentRows, segmentRows, holdRows] = await Promise.all([
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      where: appointmentWhere,
      params: appointmentParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_segments",
      where: segmentWhere,
      params: segmentParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_holds",
      where: holdWhere,
      params: holdParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
  ]);

  // Un segmento occupa SOLO se il suo appuntamento padre è in uno stato ATTIVO
  // (whitelist api_appt_active_status_sql, applicata dal legacy anche alla query
  // segmenti di staff_has_conflict_in_range). La query appuntamenti sopra è già
  // filtrata per whitelist, quindi i suoi id sono l'insieme attivo: un no_show/annullato
  // non compare e i suoi segmenti vanno scartati (altrimenti terrebbero occupato lo slot).
  const activeAppointmentIds = new Set<number>(
    appointmentRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0),
  );
  const activeSegmentRows = segmentRows.filter((row) => activeAppointmentIds.has(Number(row.appointment_id ?? 0)));

  // Per-segment ranges (M3). Each segment contributes a busy range for ITS OWN
  // staff only. Segments WITHOUT a real operator (staff_id 0/null — the "Senza
  // Operatore" case) do NOT constrain any specific operator and are dropped: the
  // legacy `staff_has_conflict_in_range` segment query matches `sg.staff_id = ?`
  // (the requested staff) and treats SSO as never-busy (is_sso_staff short-circuit),
  // so an unassigned segment must NOT block everyone. The conservative
  // "no-staff-range-blocks-everyone" rule applies only to legacy whole-appointment
  // ranges (the fallback below) and holds, mirroring the legacy clause 3.
  const segmentRanges: BusyRange[] = activeSegmentRows
    .filter((row) => nullableNumber(row.staff_id))
    .map((row) => ({
      start: timeToMinutes(timeFromSql(row.starts_at)),
      end: timeToMinutes(timeFromSql(row.ends_at)),
      locationId: null,
      staffIds: [Number(row.staff_id)],
    }));
  // Appointment ids that already have at least one segment row for the date — those
  // appointments are represented by their segments, so we skip their rolled-up span.
  const appointmentsWithSegments = new Set<number>(
    activeSegmentRows.map((row) => Number(row.appointment_id ?? 0)).filter((id) => id > 0),
  );

  // Appointment-span fallback ONLY for appointments missing segments (legacy bookings).
  const fallbackAppointments = appointmentRows.filter((row) => !appointmentsWithSegments.has(Number(row.id ?? 0)));
  const appointments = await Promise.all(fallbackAppointments.map(async (row) => ({
    start: timeToMinutes(timeFromSql(row.starts_at)),
    end: timeToMinutes(timeFromSql(row.ends_at)),
    locationId: nullableNumber(row.location_id),
    staffIds: await appointmentStaffIds(slug, Number(row.id ?? 0)),
  })));

  const holds = holdRows.map((row) => ({
    start: timeToMinutes(timeFromSql(row.starts_at)),
    end: timeToMinutes(timeFromSql(row.ends_at)),
    locationId: nullableNumber(row.location_id),
    staffIds: parseNumberArray(row.staff_ids_json),
  }));

  return [...segmentRanges, ...appointments, ...holds].filter(
    (range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start,
  );
}

// H2 (cabin double-booking): mirrors the legacy `occupied_cabin_ids_for_range`
// (api_appointments.php:2770). Gathers the date's busy CABIN ranges so a save/move
// can refuse booking a cabin already taken in the same window. Sources, like the
// legacy: (1) appointment_segments.cabin_id (per-segment occupancy), (2) the
// appointments.cabin_id span for appointments WITHOUT segments (legacy fallback),
// and (3) active holds' reserved cabins (cabin_ids_json). Same exclusions as
// busyRangesForDate (the edited appointment + the booking's own hold). Best-effort:
// a failed/missing query yields no ranges (never blocks).
export type CabinBusyRange = { start: number; end: number; locationId: number | null; cabinId: number };

export async function busyCabinRangesForDate(
  slug: string,
  date: string,
  options: { excludeAppointmentId?: number | null; excludeHoldToken?: string | null } = {},
): Promise<CabinBusyRange[]> {
  const excludeAppointmentId = options.excludeAppointmentId && options.excludeAppointmentId > 0 ? options.excludeAppointmentId : null;
  const excludeHoldToken = (options.excludeHoldToken ?? "").trim();

  const appointmentWhere = excludeAppointmentId
    ? `starts_at::date = ? AND ${ACTIVE_APPOINTMENT_STATUS_SQL} AND id <> ?`
    : `starts_at::date = ? AND ${ACTIVE_APPOINTMENT_STATUS_SQL}`;
  const appointmentParams = excludeAppointmentId ? [date, excludeAppointmentId] : [date];

  const segmentWhere = excludeAppointmentId
    ? "starts_at::date = ? AND appointment_id <> ?"
    : "starts_at::date = ?";
  const segmentParams = excludeAppointmentId ? [date, excludeAppointmentId] : [date];

  const holdWhere = excludeHoldToken
    ? "starts_at::date = ? AND status = 'active' AND expires_at > NOW() AND token <> ?"
    : "starts_at::date = ? AND status = 'active' AND expires_at > NOW()";
  const holdParams = excludeHoldToken ? [date, excludeHoldToken] : [date];

  const [appointmentRows, segmentRows, holdRows] = await Promise.all([
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      where: appointmentWhere,
      params: appointmentParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_segments",
      where: segmentWhere,
      params: segmentParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_holds",
      where: holdWhere,
      params: holdParams,
      orderBy: "starts_at ASC",
    }).catch(() => [] as RowDataPacket[]),
  ]);

  const out: CabinBusyRange[] = [];

  // Solo i segmenti di appuntamenti ATTIVI occupano una cabina (come per lo staff:
  // un no_show/annullato libera anche la cabina). La query appuntamenti è già filtrata
  // per whitelist -> i suoi id sono l'insieme attivo.
  const activeAppointmentIds = new Set<number>(
    appointmentRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0),
  );
  const activeSegmentRows = segmentRows.filter((row) => activeAppointmentIds.has(Number(row.appointment_id ?? 0)));

  // (1) Per-segment cabins.
  for (const row of activeSegmentRows) {
    const cabinId = nullableNumber(row.cabin_id);
    if (!cabinId) continue;
    out.push({
      start: timeToMinutes(timeFromSql(row.starts_at)),
      end: timeToMinutes(timeFromSql(row.ends_at)),
      locationId: null,
      cabinId,
    });
  }

  // (2) Appointment-level cabin for appointments WITHOUT segments (legacy fallback).
  const appointmentsWithSegments = new Set<number>(
    activeSegmentRows.map((row) => Number(row.appointment_id ?? 0)).filter((id) => id > 0),
  );
  for (const row of appointmentRows) {
    if (appointmentsWithSegments.has(Number(row.id ?? 0))) continue;
    const cabinId = nullableNumber(row.cabin_id);
    if (!cabinId) continue;
    out.push({
      start: timeToMinutes(timeFromSql(row.starts_at)),
      end: timeToMinutes(timeFromSql(row.ends_at)),
      locationId: nullableNumber(row.location_id),
      cabinId,
    });
  }

  // (3) Active holds' reserved cabins.
  for (const row of holdRows) {
    const cabinIds = parseNumberArray(row.cabin_ids_json);
    if (!cabinIds.length) continue;
    const start = timeToMinutes(timeFromSql(row.starts_at));
    const end = timeToMinutes(timeFromSql(row.ends_at));
    const locationId = nullableNumber(row.location_id);
    for (const cabinId of cabinIds) out.push({ start, end, locationId, cabinId });
  }

  return out.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
}

// H3 time-off (HARD block): mirrors the legacy `staff_timeoff_reason_for_range`
// (api_appointments.php:3479). Returns the time-off reason (ferie/malattia/assenza)
// when the staff has any staff_timeoff window overlapping [start,end] on this date,
// else null. Always enforced (cannot be overridden). Best-effort: a failed query
// returns null (never blocks). Compared in minutes-of-day within the single date,
// matching the rest of this guard.
export async function staffTimeoffReasonForRange(
  slug: string,
  staffId: number,
  date: string,
  start: number,
  end: number,
): Promise<string | null> {
  if (staffId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_timeoff",
    columns: "starts_at, ends_at, reason",
    where: "staff_id = ? AND starts_at::date <= ? AND ends_at::date >= ?",
    params: [staffId, date, date],
    orderBy: "starts_at ASC",
  }).catch(() => [] as RowDataPacket[]);
  for (const row of rows) {
    const offStart = timeToMinutes(timeFromSql(row.starts_at));
    const offEnd = timeToMinutes(timeFromSql(row.ends_at));
    // A timeoff window may span the whole day (or multiple days). For a multi-day
    // window whose start/end fall outside this date, treat it as covering the day.
    const offStartDay = dateFromSql(row.starts_at);
    const offEndDay = dateFromSql(row.ends_at);
    const effStart = offStartDay < date ? 0 : offStart;
    const effEnd = offEndDay > date ? 24 * 60 : offEnd;
    if (!Number.isFinite(effStart) || !Number.isFinite(effEnd)) continue;
    if (overlaps(start, end, effStart, effEnd)) {
      const reason = String(row.reason ?? "").trim();
      return reason !== "" ? reason : "Non disponibile";
    }
  }
  return null;
}

// H3 shift (SOFT block): mirrors the legacy `staff_schedule_reason_for_range`
// (lib/Helpers.php:6935) reached via staff_timeoff_reason_for_range when
// includeSchedule is true. If the staff uses the availability feature (has any
// staff_availability row), a day with NO availability interval means NOT available,
// and a segment outside all the day's intervals is "Fuori turno". Returns the
// "Fuori turno" string or null. Best-effort: a failed query returns null. Only
// consulted when includeSchedule is true (the legacy override path: bookings that
// fit inside business hours enforce the shift; out-of-hours override bookings skip
// it — appt_include_staff_schedule_for_range, api_appointments.php:3598).
async function staffScheduleReasonForRange(
  slug: string,
  staffId: number,
  date: string,
  start: number,
  end: number,
  locationId: number | null,
): Promise<string | null> {
  if (staffId <= 0) return null;
  // Does this operator use the availability feature at all (this location or global)?
  const anyRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_availability",
    columns: "id",
    where: locationId
      ? "staff_id = ? AND (location_id = ? OR location_id IS NULL)"
      : "staff_id = ?",
    params: locationId ? [staffId, locationId] : [staffId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (!anyRows.length) return null; // legacy: no availability configured → unconstrained.

  // Availability intervals for THIS date (minutes-of-day). presenza overrides turno.
  const dayRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_availability",
    columns: "kind, starts_at, ends_at, location_id",
    where: locationId
      ? "staff_id = ? AND (location_id = ? OR location_id IS NULL) AND starts_at::date <= ? AND ends_at::date >= ?"
      : "staff_id = ? AND starts_at::date <= ? AND ends_at::date >= ?",
    params: locationId ? [staffId, locationId, date, date] : [staffId, date, date],
    orderBy: "starts_at ASC",
  }).catch(() => [] as RowDataPacket[]);

  // Prefer location-specific rows when a location is in play (legacy specific filter).
  let rows = dayRows;
  if (locationId) {
    const specific = dayRows.filter((row) => Number(row.location_id ?? 0) === locationId);
    if (specific.length) rows = specific;
  }

  const presence = rows.filter((row) => String(row.kind ?? "").trim().toLowerCase() === "presenza");
  const used = presence.length ? presence : rows;

  const intervals: Array<[number, number]> = [];
  for (const row of used) {
    const rowStartDay = dateFromSql(row.starts_at);
    const rowEndDay = dateFromSql(row.ends_at);
    const s = rowStartDay < date ? 0 : timeToMinutes(timeFromSql(row.starts_at));
    const e = rowEndDay > date ? 24 * 60 : timeToMinutes(timeFromSql(row.ends_at));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    intervals.push([s, e]);
  }

  // Legacy: no interval that day → operator NOT available → "Fuori turno".
  if (!intervals.length) return "Fuori turno";

  // Union must fully cover [start, end] (intervals_cover_range). Merge then test.
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let cursor = start;
  for (const [s, e] of merged) {
    if (s > cursor) break;
    if (e >= end) return null; // fully covered
    if (e > cursor) cursor = e;
  }
  if (cursor >= end) return null;
  return "Fuori turno";
}

async function appointmentStaffIds(slug: string, appointmentId: number): Promise<number[]> {
  if (appointmentId <= 0) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_staff",
    where: "appointment_id = ?",
    params: [appointmentId],
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => Number(row.staff_id ?? 0)).filter((id) => id > 0);
}

function candidateFree(candidate: StaffCandidate, start: number, end: number, locationId: number | null, busyRanges: BusyRange[]): boolean {
  for (const busy of busyRanges) {
    if (!sameLocation(locationId, busy.locationId)) continue;
    if (!overlaps(start, end, busy.start, busy.end)) continue;
    if (candidate.id === null) return false;
    if (!busy.staffIds.length || busy.staffIds.includes(candidate.id)) return false;
  }
  return true;
}

// Find the busy range an assigned operator overlaps with at [start, end], reusing
// the candidateFree staff-overlap rule (same location, overlapping window, and the
// range either has no staff or includes this operator). Returns the first
// conflicting range (so the caller can name the time) or null when free.
function firstConflictingRange(staffId: number, start: number, end: number, locationId: number | null, busyRanges: BusyRange[]): BusyRange | null {
  const candidate: StaffCandidate = { id: staffId, name: "", serviceIds: new Set<number>() };
  for (const busy of busyRanges) {
    if (!candidateFree(candidate, start, end, locationId, [busy])) return busy;
  }
  return null;
}

export type AppointmentSlotSegment = {
  staffId: number | null;
  startsAt: string;
  endsAt: string;
  // Servizio del segmento — usato dal messaggio time-off per la variante "servizio
  // gestito solo da {operatore}" (timeoff_user_message, api_appointments.php:3568).
  serviceId?: number | null;
  locationId?: number | null;
  // H2: the cabin this segment occupies (appointments.cabin_id primary / per-segment
  // cabin). Optional so legacy callers compile; a positive value enables the cabin
  // double-booking check for the segment.
  cabinId?: number | null;
};

// Resource-availability guard for the manage save (quick-booking drawer + any save /
// move / resize). Faithful to the legacy guards run on every save/move:
//
//  * STAFF OVERLAP (M3): per-segment, via candidateFree against the date's busy
//    ranges (now per-segment too) — `staff_has_conflict_in_range` (api_appointments.php:4213).
//  * CABIN (H2, HARD): refuse a segment whose cabin overlaps a busy cabin range —
//    `occupied_cabin_ids_for_range` / `resolve_cabin_id_for_range` (:2770 / :3117).
//  * TIME-OFF (H3, HARD): refuse a staffed segment overlapping any staff_timeoff
//    window — `staff_timeoff_reason_for_range` (:3479). Cannot be overridden.
//  * SHIFT (H3, SOFT): refuse a staffed segment outside the staff's staff_availability
//    intervals — `staff_schedule_reason_for_range` (Helpers.php:6935), but ONLY when
//    the segment fits inside business hours (`appt_include_staff_schedule_for_range`,
//    :3598); out-of-business-hours override bookings skip the shift check (and the
//    manage save passes this same include flag, so we mirror it rather than inventing
//    a stricter rule).
//
// Excludes the appointment being edited (excludeAppointmentId) and the booking's own
// active hold (excludeHoldToken). Best-effort throughout: a failed/missing-table query
// never blocks a booking — only a REAL detected conflict throws.
// Operatore UNICO per un servizio (port di unique_staff_for_service,
// api_appointments.php:3511-3563): operatori attivi non-SSO abbinati al servizio in
// staff_services, filtrati per sede (STRICT, app_filter_staff_ids_by_location). Ritorna
// l'id se esattamente uno, altrimenti null. Query tenant-safe via tenantSelect.
export async function uniqueStaffForService(slug: string, serviceId: number, locationId: number | null): Promise<number | null> {
  if (!(serviceId > 0)) return null;
  const ssRows = await tenantSelect<RowDataPacket>({ slug, table: "staff_services", columns: "staff_id", where: "service_id = ?", params: [serviceId] }).catch(() => [] as RowDataPacket[]);
  const staffIds = [...new Set(ssRows.map((r) => Number(r.staff_id ?? 0)).filter((n) => n > 0))];
  if (staffIds.length === 0) return null;
  const activeRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id",
    where: `id IN (${staffIds.map(() => "?").join(",")}) AND COALESCE(is_active,1) = 1 AND full_name <> 'SSO'`,
    params: staffIds,
  }).catch(() => [] as RowDataPacket[]);
  let ids = activeRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  if (locationId && locationId > 0 && ids.length) {
    const slRows = await tenantSelect<RowDataPacket>({ slug, table: "staff_locations", columns: "staff_id, location_id", where: `staff_id IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
    // STRICT ma con la stessa safety anti-vuoto del calendario: se NESSUNO ha righe,
    // non filtrare (feature non configurata); altrimenti tieni solo gli ammessi in sede.
    if (slRows.length) {
      const allowedHere = new Set<number>();
      for (const r of slRows) { if (Number(r.location_id ?? 0) === locationId) allowedHere.add(Number(r.staff_id ?? 0)); }
      ids = ids.filter((id) => allowedHere.has(id));
    }
  }
  return ids.length === 1 ? ids[0] : null;
}

async function staffFullNameById(slug: string, staffId: number): Promise<string> {
  if (!(staffId > 0)) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "full_name", where: "id = ?", params: [staffId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.full_name ?? "");
}

async function serviceNameById(slug: string, serviceId: number): Promise<string> {
  if (!(serviceId > 0)) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "name", where: "id = ?", params: [serviceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.name ?? "").trim();
}

// Messaggio time-off/turno del SAVE backend (port di timeoff_user_message,
// api_appointments.php:3568-3596): usa il NOME dell'operatore e, se il servizio è
// gestito da un SOLO operatore, la variante che invita ad abbinarne un altro.
async function buildTimeoffMessage(slug: string, staffId: number, serviceId: number | null | undefined, locationId: number | null | undefined, reason: string): Promise<string> {
  const who = (await staffFullNameById(slug, staffId)) || "Operatore";
  const svcId = Number(serviceId ?? 0) || 0;
  if (svcId > 0) {
    const uniq = await uniqueStaffForService(slug, svcId, locationId ?? null).catch(() => null);
    if (uniq !== null && uniq === staffId) {
      const svcName = await serviceNameById(slug, svcId).catch(() => "");
      const base = svcName
        ? `Prenotazione non creata: il servizio "${svcName}" è gestito solo da ${who} e risulta non disponibile (${reason}) nel giorno/orario selezionato.`
        : `Prenotazione non creata: il servizio è gestito solo da ${who} e risulta non disponibile (${reason}) nel giorno/orario selezionato.`;
      return `${base} Per procedere, abbina un altro operatore a questo servizio nella pagina del servizio (Servizi → Modifica servizio).`;
    }
  }
  return `Prenotazione non creata: ${who} risulta non disponibile (${reason}) nel giorno/orario selezionato.`;
}

export async function assertAppointmentSlotAvailable({
  slug,
  date,
  segments,
  excludeAppointmentId = null,
  excludeHoldToken = null,
}: {
  slug: string;
  date: string;
  segments: AppointmentSlotSegment[];
  excludeAppointmentId?: number | null;
  excludeHoldToken?: string | null;
}): Promise<void> {
  const normSegments = segments
    .map((seg) => {
      const start = timeToMinutes(timeFromSql(seg.startsAt));
      const end = timeToMinutes(timeFromSql(seg.endsAt));
      const staffId = typeof seg.staffId === "number" && (seg.staffId ?? 0) > 0 ? (seg.staffId as number) : 0;
      const cabinId = nullableNumber(seg.cabinId === undefined ? null : seg.cabinId) ?? 0;
      const locationId = seg.locationId === undefined ? null : nullableNumber(seg.locationId);
      const serviceId = Number(seg.serviceId ?? 0) || 0;
      return { start, end, staffId, cabinId, locationId, serviceId };
    })
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start);
  if (normSegments.length === 0) return;

  const staffedSegments = normSegments.filter((seg) => seg.staffId > 0);
  const cabinSegments = normSegments.filter((seg) => seg.cabinId > 0);

  // Gather only the resource ranges we actually need (best-effort, each guarded).
  const [busyRanges, cabinRanges] = await Promise.all([
    staffedSegments.length
      ? busyRangesForDate(slug, date, { excludeAppointmentId, excludeHoldToken }).catch(() => [] as BusyRange[])
      : Promise.resolve([] as BusyRange[]),
    cabinSegments.length
      ? busyCabinRangesForDate(slug, date, { excludeAppointmentId, excludeHoldToken }).catch(() => [] as CabinBusyRange[])
      : Promise.resolve([] as CabinBusyRange[]),
  ]);

  // --- STAFF OVERLAP (M3) ---
  for (const seg of staffedSegments) {
    if (!busyRanges.length) break;
    const conflict = firstConflictingRange(seg.staffId, seg.start, seg.end, seg.locationId, busyRanges);
    if (conflict) {
      // Messaggio conflitto del SAVE backend (api_appointments.php:11202 single /
      // :12713 multi), non quello del wizard pubblico. Multi-servizio = >1 segmento.
      throw new Error(
        normSegments.length > 1
          ? "Conflitto: uno degli operatori ha già un altro appuntamento in quell'orario."
          : "Conflitto: l'operatore ha già un altro appuntamento in quell'orario.",
      );
    }
  }

  // --- CABIN (H2, HARD) ---
  for (const seg of cabinSegments) {
    if (!cabinRanges.length) break;
    const busy = cabinRanges.find(
      (range) => range.cabinId === seg.cabinId && sameLocation(seg.locationId, range.locationId) && overlaps(seg.start, seg.end, range.start, range.end),
    );
    if (busy) {
      throw new Error(
        `Cabina già occupata dalle ${minutesToTime(busy.start)} alle ${minutesToTime(busy.end)}. Scegli un'altra cabina o orario.`,
      );
    }
  }

  if (staffedSegments.length === 0) return;

  // --- TIME-OFF (H3, HARD) + SHIFT (H3, SOFT) ---
  // includeSchedule mirrors appt_include_staff_schedule_for_range: the shift is only
  // enforced for segments that fit inside the day's business hours. Compute once per
  // location used by the staffed segments.
  const businessByLocation = new Map<number, Array<[number, number]>>();
  async function intervalsFor(locationId: number | null): Promise<Array<[number, number]>> {
    const key = locationId ?? 0;
    const cached = businessByLocation.get(key);
    if (cached) return cached;
    const intervals = await businessIntervals(slug, locationId, date).catch(() => [] as Array<[number, number]>);
    businessByLocation.set(key, intervals);
    return intervals;
  }

  for (const seg of staffedSegments) {
    // HARD time-off (always enforced).
    const timeoffReason = await staffTimeoffReasonForRange(slug, seg.staffId, date, seg.start, seg.end);
    if (timeoffReason) {
      throw new Error(await buildTimeoffMessage(slug, seg.staffId, seg.serviceId, seg.locationId, timeoffReason));
    }

    // SOFT shift: only when the segment fits inside the day's business hours.
    const intervals = await intervalsFor(seg.locationId);
    const includeSchedule = intervals.some(([s, e]) => seg.start >= s && seg.end <= e);
    if (!includeSchedule) continue;
    const shiftReason = await staffScheduleReasonForRange(slug, seg.staffId, date, seg.start, seg.end, seg.locationId);
    if (shiftReason) {
      throw new Error(await buildTimeoffMessage(slug, seg.staffId, seg.serviceId, seg.locationId, shiftReason));
    }
  }
}

async function assertActivePublicHold({
  slug,
  token,
  ownerKey,
  date,
  time,
  serviceIds,
  staffId,
  locationId,
}: {
  slug: string;
  token: string;
  ownerKey: string;
  date: string;
  time: string;
  serviceIds: number[];
  staffId: number | null;
  locationId: number | null;
}): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    where: "token = ? AND owner_key = ? AND status = 'active' AND expires_at > NOW()",
    params: [token, ownerKey || "public"],
    limit: 1,
  });
  const hold = rows[0];
  if (!hold) throw new Error("Riserva non disponibile o scaduta.");
  const sameServices = serviceIds.every((id) => parseNumberArray(hold.service_ids_json).includes(id));
  const holdStaff = parseNumberArray(hold.staff_ids_json);
  const sameStaff = !staffId || !holdStaff.length || holdStaff.includes(staffId);
  const sameDateTime = dateFromSql(hold.starts_at) === date && timeFromSql(hold.starts_at) === time;
  const sameLocationId = sameLocation(locationId, nullableNumber(hold.location_id));
  if (!sameServices || !sameStaff || !sameDateTime || !sameLocationId) {
    throw new Error("La riserva non corrisponde alla prenotazione.");
  }
}

async function resolvePublicClient({
  slug,
  name,
  email,
  phone,
  locationId,
}: {
  slug: string;
  name: string;
  email: string;
  phone: string;
  locationId: number | null;
}): Promise<{ id: number; name: string }> {
  const normalizedName = name.trim() || email.trim() || phone.trim() || "Cliente online";
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPhone = phone.trim();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (normalizedEmail) {
    clauses.push("LOWER(email) = ?");
    params.push(normalizedEmail);
  }
  if (normalizedPhone) {
    clauses.push("phone = ?");
    params.push(normalizedPhone);
  }
  if (!clauses.length) {
    clauses.push("LOWER(full_name) = ?");
    params.push(normalizedName.toLowerCase());
  }
  const existing = await tenantSelect<RowDataPacket>({
    slug,
    table: "clients",
    columns: "id,full_name",
    where: clauses.join(" OR "),
    params,
    limit: 1,
  });
  if (existing[0]) return { id: Number(existing[0].id), name: String(existing[0].full_name ?? normalizedName) };

  const id = await tenantInsert(await tenantTable(slug, "clients"), {
    full_name: normalizedName,
    first_name: firstName(normalizedName),
    last_name: lastName(normalizedName),
    email: normalizedEmail || null,
    phone: normalizedPhone || null,
    registration_date: todayIsoLocal(),
    points: 0,
    credit_balance: 0,
    is_blocked: 0,
    location_id: locationId,
  });
  return { id, name: normalizedName };
}

async function publicDiscount(slug: string, subtotal: number, couponCode?: string, promotionId?: number | null): Promise<{ amount: number; label: string }> {
  const today = todayIsoLocal();
  if (couponCode?.trim()) {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "coupons",
      where: "UPPER(code) = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL AND cancelled_at IS NULL AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)",
      params: [couponCode.trim().toUpperCase(), today, today],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const coupon = rows[0];
    if (coupon && subtotal >= Number(coupon.min_subtotal ?? 0)) {
      return {
        amount: discountAmount(coupon.discount_type, coupon.discount_value, subtotal),
        label: `Coupon ${String(coupon.code ?? "").trim()}`,
      };
    }
  }

  if (promotionId && promotionId > 0) {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "promotions",
      where: "id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(show_in_booking, 1) = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)",
      params: [promotionId, today, today],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const promotion = rows[0];
    if (promotion && subtotal >= Number(promotion.min_subtotal ?? 0)) {
      return {
        amount: discountAmount(promotion.discount_type, promotion.discount_value, subtotal),
        label: `Promozione ${String(promotion.title ?? "").trim()}`,
      };
    }
  }

  return { amount: 0, label: "" };
}

// `overrides` carries the promo per-service prices (price = discounted,
// list_price = original, discount_badge) resolved by the confirm benefits.
async function insertPublicAppointmentServices(
  slug: string,
  appointmentId: number,
  services: ServiceRow[],
  overrides: Array<{ serviceId: number; price: number; listPrice: number; badge: string }> = [],
): Promise<void> {
  const overrideById = new Map(overrides.map((o) => [o.serviceId, o]));
  for (const service of services) {
    const override = overrideById.get(Number(service.id ?? 0));
    await tenantInsert(await tenantTable(slug, "appointment_services"), {
      appointment_id: appointmentId,
      service_id: Number(service.id ?? 0),
      service_name: String(service.name ?? ""),
      service_category_id: nullableNumber(service.category_id),
      qty: 1,
      price: override ? override.price : Number(service.price ?? 0),
      list_price: override ? override.listPrice : Number(service.price ?? 0),
      discount_badge: override && override.badge ? override.badge : null,
      duration_min: Number(service.duration_min ?? 30),
    }).catch(() => 0);
  }
}

async function insertPublicAppointmentStaff(slug: string, appointmentId: number, staffId: number): Promise<void> {
  await tenantInsert(await tenantTable(slug, "appointment_staff"), { appointment_id: appointmentId, staff_id: staffId }).catch(() => 0);
}

async function insertPublicAppointmentLocation(slug: string, appointmentId: number, locationId: number): Promise<void> {
  await tenantInsert(await tenantTable(slug, "appointment_locations"), { appointment_id: appointmentId, location_id: locationId }).catch(() => 0);
}

async function insertPublicAppointmentSegments(slug: string, appointmentId: number, date: string, time: string, services: ServiceRow[], staffId: number | null, staffMap: Record<number, number> | null = null): Promise<void> {
  let cursor = timeToMinutes(time);
  let position = 1;
  for (const service of services) {
    const duration = Math.max(5, Number(service.duration_min ?? 30));
    const segStaffId = Number(staffMap?.[Number(service.id ?? 0)] ?? 0) || Number(staffId ?? 0) || 0;
    await tenantInsert(await tenantTable(slug, "appointment_segments"), {
      appointment_id: appointmentId,
      service_id: Number(service.id ?? 0),
      service_name: String(service.name ?? ""),
      staff_id: segStaffId,
      position,
      starts_at: sqlDateTime(date, minutesToTime(cursor)),
      ends_at: sqlDateTime(date, minutesToTime(cursor + duration)),
      duration_minutes: duration,
      cabin_id: nullableNumber(service.cabin_id),
    }).catch(() => 0);
    cursor += duration;
    position += 1;
  }
}

async function markPublicHoldConverted(slug: string, token: string, ownerKey: string, appointmentId: number): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    where: "token = ? AND owner_key = ?",
    params: [token, ownerKey || "public"],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const id = Number(rows[0]?.id ?? 0);
  if (id > 0) {
    await tenantUpdate({ slug, table: "appointment_holds", id, values: { status: "converted", appointment_id: appointmentId } }).catch(() => 0);
  }
}

function buildSegments(date: string, time: string, services: ServiceRow[], staffId: number | null, staffMap: Record<number, number> | null = null): Array<Record<string, unknown>> {
  let cursor = timeToMinutes(time);
  return services.map((service, index) => {
    const duration = Math.max(5, Number(service.duration_min ?? 30));
    const segStaffId = Number(staffMap?.[Number(service.id ?? 0)] ?? 0) || Number(staffId ?? 0) || null;
    const segment = {
      position: index + 1,
      service_id: Number(service.id ?? 0),
      service_name: String(service.name ?? ""),
      staff_id: segStaffId,
      starts_at: sqlDateTime(date, minutesToTime(cursor)),
      ends_at: sqlDateTime(date, minutesToTime(cursor + duration)),
      duration_minutes: duration,
      cabin_id: nullableNumber(service.cabin_id),
    };
    cursor += duration;
    return segment;
  });
}

function groupNumberMap(rows: RowDataPacket[], keyColumn: string, valueColumn: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const key = Number(row[keyColumn] ?? 0);
    const value = Number(row[valueColumn] ?? 0);
    if (key <= 0 || value <= 0) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
  }
  return map;
}

function preferredLocationRow(rows: RowDataPacket[], locationId: number | null): RowDataPacket | null {
  if (!rows.length) return null;
  return rows.find((row) => nullableNumber(row.location_id) === locationId) ?? rows.find((row) => nullableNumber(row.location_id) === null) ?? rows[0] ?? null;
}

function intervalsFromHoursRow(row: RowDataPacket): Array<[number, number]> {
  if (Number(row.is_closed ?? 0) === 1) return [];
  const intervals: Array<[number, number]> = [];
  const first = intervalFromTimes(row.opens, row.closes);
  const second = intervalFromTimes(row.opens2, row.closes2);
  if (first) intervals.push(first);
  if (second) intervals.push(second);
  return intervals;
}

function intervalFromTimes(open: unknown, close: unknown): [number, number] | null {
  const start = timeToMinutes(timeFromSql(open));
  const end = timeToMinutes(timeFromSql(close));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [start, end];
}

function benefitDetail(type: unknown, value: unknown): string {
  const amount = roundMoney(Number(value ?? 0));
  return discountKind(type) === "percent" ? `${amount}% di sconto` : `${amount} euro di sconto`;
}

function discountKind(type: unknown): "percent" | "fixed" {
  return String(type ?? "") === "fixed" ? "fixed" : "percent";
}

function discountAmount(type: unknown, value: unknown, subtotal: number): number {
  const amount = discountKind(type) === "percent" ? subtotal * (Number(value ?? 0) / 100) : Number(value ?? 0);
  return roundMoney(Math.max(0, Math.min(subtotal, amount)));
}

function parseNumberArray(value: unknown): number[] {
  if (!value) return [];
  try {
    const decoded = JSON.parse(String(value));
    if (Array.isArray(decoded)) return decoded.map((item) => Number(item)).filter((item) => item > 0);
  } catch {
    // fallback below
  }
  return String(value)
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => item > 0);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDate(value: string): string {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}$/);
  if (match) return match[0];
  return todayIsoLocal();
}

function normalizeTime(value: string): string {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "09:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function timeToMinutes(value: string): number {
  const match = normalizeTime(value).match(/^(\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(minutes: number): string {
  const safe = Math.max(0, Math.floor(minutes));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function timeFromSql(value: unknown): string {
  if (value instanceof Date) {
    return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  }
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
}

function dateFromSql(value: unknown): string {
  if (value instanceof Date) return dateIsoLocal(value);
  const match = String(value ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? todayIsoLocal();
}

function sqlDateTime(date: string, time: string): string {
  return `${normalizeDate(date)} ${normalizeTime(time)}:00`;
}

function addSecondsSqlDate(date: Date, seconds: number): string {
  const next = new Date(date.getTime() + seconds * 1000);
  return `${dateIsoLocal(next)} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}:${String(next.getSeconds()).padStart(2, "0")}`;
}

function todayIsoLocal(): string {
  return dateIsoLocal(new Date());
}

function dateIsoLocal(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function minimumStartForDate(date: string): number {
  if (date !== todayIsoLocal()) return 0;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && otherStart < end;
}

function sameLocation(left: number | null, right: number | null): boolean {
  if (!left || !right) return true;
  return left === right;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}
