import "server-only";

import bcrypt from "bcryptjs";
import type { RowDataPacket } from "@/lib/tenant-db";
import { parseInteger } from "@/lib/api-utils";
import { dbExecute, dbQuery, quoteIdentifier, columnExists, tenantDelete, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import { sendStaffInviteEmailCode } from "@/lib/manage-accessibility";
import { deletePublicObject, storageKeyFromPublicUrl } from "@/lib/storage";

export type ManageResourceContext = {
  source?: string;
  sourceMode: "database";
  activeLocationId: number;
  locations: ResourceLocation[];
  services: ResourceService[];
  resources: SharedResource[];
  // Totale risorse PRIMA del filtro sede (resources.php $resourcesTotal):
  // decide l'empty-state anche quando la sede corrente non ne abilita nessuna.
  resourcesTotal: number;
  cabins: ResourceCabin[];
  staff: ResourceStaff[];
  hours: BusinessHourRow[];
  closures: CalendarDateRange[];
  exceptions: CalendarExceptionRange[];
  availability: StaffAvailabilityEvent[];
};

// Payload del modal #resourceBlockModal legacy (resources.php
// resources_flash_block_popup): titolo + messaggio + servizi collegati.
export type ResourceBlockPopup = {
  title: string;
  message: string;
  services: Array<{ service_name: string; qty_required: number }>;
};

function resourceBlockError(message: string, popup: ResourceBlockPopup): Error {
  const err = new Error(message) as Error & { popup?: ResourceBlockPopup };
  err.popup = popup;
  return err;
}

export type ResourceLocation = {
  id: number;
  name: string;
  isActive: boolean;
};

export type ResourceService = {
  id: number;
  name: string;
  isActive: boolean;
};

export type LinkedService = {
  serviceId: number;
  serviceName: string;
  qtyRequired?: number;
  isActive: boolean;
};

export type SharedResourceLocation = {
  locationId: number;
  locationName: string;
  qtyTotal: number;
  isEnabled: boolean;
};

export type SharedResource = {
  id: number;
  name: string;
  description: string;
  qtyTotal: number;
  locations: SharedResourceLocation[];
  serviceLinks: LinkedService[];
};

export type ResourceCabin = {
  id: number;
  name: string;
  position: number;
  isActive: boolean;
  locationId: number | null;
  locationName: string;
  serviceLinks: LinkedService[];
  // Blocchi legacy (servizi + prenotazioni future) per il popup della riga.
  blockers?: CabinBlockerItem[];
};

export type ResourceStaff = {
  id: number;
  fullName: string;
  phone: string;
  email: string;
  role: "admin" | "staff" | "altro";
  isActive: boolean;
  color: string;
  photoPath: string;
  locationIds: number[];
  locations: ResourceLocation[];
  serviceLinks: LinkedService[];
  isOwner: boolean;
};

export type BusinessHourRow = {
  id: number;
  dow: number;
  dayLabel: string;
  locationId: number | null;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  isClosed: boolean;
};

export type CalendarDateRange = {
  start: string;
  end: string;
  reason: string;
  ids: number[];
};

export type CalendarExceptionRange = {
  start: string;
  end: string;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  note: string;
};

export type StaffAvailabilityEvent = {
  id: number;
  table: "availability" | "timeoff";
  staffId: number;
  staffName: string;
  type: string;
  startsAt: string;
  endsAt: string;
  dateFrom: string;
  dateTo: string;
  timeFrom: string;
  timeTo: string;
  locationId: number | null;
  seriesUid: string;
};

const dayLabels = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

export async function resourceContext({
  slug,
  locationId,
  date,
  rawLocation,
}: {
  slug: string;
  locationId?: number;
  date?: string;
  rawLocation?: boolean;
}): Promise<ManageResourceContext> {
  await ensureResourceColumns(slug);
  const locations = await listLocations(slug);
  // rawLocation (pagina Cabine): cabins.php usa app_current_location_id senza
  // fallback alla prima sede attiva — 0 e' lo stato legittimo 'Tutte', e una
  // sede inesistente resta tale (nome 'Sede #id', cabins.php 356-360).
  const activeLocationId = rawLocation ? Math.max(0, Number(locationId ?? 0)) : normalizeActiveLocation(locationId, locations);
  const range = weekRange(normalizeDate(date) || todayIsoLocal());
  const [services, resourcesAll, cabins, staff, hours, closures, exceptions, availability] = await Promise.all([
    listServices(slug),
    listResources(slug, 0, locations),
    listCabins(slug, activeLocationId, locations),
    listStaff(slug, activeLocationId, locations),
    listBusinessHours(slug, activeLocationId),
    listClosureRanges(slug, activeLocationId),
    listExceptionRanges(slug, activeLocationId),
    listStaffAvailability(slug, activeLocationId, range.start, range.end),
  ]);
  // Filtro sede legacy (resources.php 557-576): via le risorse non abilitate
  // nella sede corrente; il totale pre-filtro decide l'empty-state.
  const resources = resourcesAll.filter((item) => !activeLocationId || item.locations.length === 0 || item.locations.some((loc) => loc.locationId === activeLocationId && loc.isEnabled));

  return {
    sourceMode: "database",
    activeLocationId,
    locations,
    services,
    resources,
    resourcesTotal: resourcesAll.length,
    cabins,
    staff,
    hours,
    closures,
    exceptions,
    availability,
  };
}

// Lista operatori per la pagina di gestione Operatori (staff.php).
// locationId > 0 = solo gli operatori con riga staff_locations per QUELLA sede
// (default legacy = $staffCurrentLocationId, la sede corrente); locationId = 0 =
// TUTTE le sedi (toggle "Tutte le sedi"). Uno staff SENZA sedi assegnate compare
// SOLO senza filtro sede (semantica app_filter_ids_by_location, variante staff).
export async function listManageStaff(slug: string, locationId = 0): Promise<ResourceStaff[]> {
  const locations = await listLocations(slug);
  return listStaff(slug, Math.max(0, Number(locationId) || 0), locations);
}

// Prefill del form Modifica risorsa (resources.php action=edit): legge la riga
// per id ANCHE se non abilitata nella sede corrente. Null se mancante.
export async function getSharedResource(slug: string, id: number): Promise<SharedResource | null> {
  if (!(id > 0)) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "resources", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
  if (!rows[0]) return null;
  const locations = await listLocations(slug);
  const [locationMap, serviceMap] = await Promise.all([resourceLocations(slug, [id], locations), resourceServiceLinks(slug, [id])]);
  return {
    id,
    name: String(rows[0].name ?? ""),
    description: String(rows[0].description ?? ""),
    qtyTotal: Number(rows[0].qty_total ?? 0),
    locations: locationMap.get(id) ?? [],
    serviceLinks: serviceMap.get(id) ?? [],
  };
}

export async function saveSharedResource(slug: string, body: Record<string, string>): Promise<SharedResource> {
  const table = await tenantTable(slug, "resources");
  const id = parseInteger(body.id, 0);
  const name = cleanName(body.name, 190);
  const description = cleanText(body.description ?? "", 5000);
  let qtyTotal = clampInt(body.qty_total ?? body.qtyTotal, 0, 1_000_000);
  const locations = parseJsonArray<Partial<SharedResourceLocation>>(body.locations_json ?? body.locations ?? "[]");
  if (!name) throw new Error("Nome risorsa obbligatorio");

  if (locations.length) {
    const enabledQty = locations.filter((item) => truthy(item.isEnabled)).map((item) => clampInt(item.qtyTotal, 0, 1_000_000));
    if (!enabledQty.length) throw new Error("Seleziona almeno una sede in cui la risorsa e disponibile.");
    qtyTotal = Math.max(...enabledQty, 0);
  }

  if (id > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "resources", columns: "id,qty_total", where: "id = ?", params: [id], limit: 1 });
    // Messaggio legacy senza punto (resources.php 396).
    if (!existing[0]) throw new Error("Risorsa non trovata");
    await ensureResourceQtyCanChange(slug, id, qtyTotal, locations, Math.max(0, Number(existing[0].qty_total ?? 0)));
    try {
      await tenantUpdate({ slug, table: "resources", id, values: await filterColumns(table.name, { name, description: description || null, qty_total: qtyTotal }) });
      await saveResourceLocations(slug, id, locations, qtyTotal);
    } catch {
      // Nome duplicato o schema non aggiornato (resources.php 486-489).
      throw new Error("Errore salvataggio: verifica nome duplicato o schema DB (schema aggiornato).");
    }
    return mustFindResource(slug, id);
  }

  try {
    const newId = await tenantInsert(table, await filterColumns(table.name, { name, description: description || null, qty_total: qtyTotal }));
    await saveResourceLocations(slug, newId, locations, qtyTotal);
    return mustFindResource(slug, newId);
  } catch {
    throw new Error("Errore salvataggio: verifica nome duplicato o schema DB (schema aggiornato).");
  }
}

export async function deleteSharedResource(slug: string, id: number): Promise<void> {
  const resourceId = Math.max(0, Number(id) || 0);
  if (!resourceId) throw new Error("Risorsa non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "resources", columns: "id", where: "id = ?", params: [resourceId], limit: 1 }).catch(() => []);
  // resources.php 352: id inesistente -> flash 'Risorsa non trovata'.
  if (!rows[0]) throw new Error("Risorsa non trovata");
  const linked = (await resourceServiceLinks(slug, [resourceId])).get(resourceId) ?? [];
  if (linked.length) {
    // resources.php 338-345: flash err + popup di blocco in sessione.
    throw resourceBlockError("Risorsa non eliminata: è associata a uno o più servizi.", {
      title: "Impossibile eliminare la risorsa",
      message: "La risorsa non può essere eliminata perché è presente nei servizi elencati. Rimuovi prima la risorsa dai servizi collegati.",
      services: linked.map((l) => ({ service_name: l.serviceName, qty_required: Math.max(1, Number(l.qtyRequired ?? 1) || 1) })),
    });
  }
  await deleteByOwner(slug, "resource_locations", "resource_id", resourceId);
  await deleteByOwner(slug, "service_resources", "resource_id", resourceId);
  await tenantDelete({ slug, table: "resources", id: resourceId });
}

// Edit-form prefill for ONE cabin. Port of cabins.php action=edit (the cabin
// modal data-cabin-edit prefill): reads the single cabins row by id directly
// (so a cabin in any location is editable, not only those in the active sede)
// and shapes it like the list rows. Returns null when missing so the route can
// answer a clean 404.
export async function getManageCabin(slug: string, id: number): Promise<ResourceCabin | null> {
  if (!(id > 0)) return null;
  await ensureResourceColumns(slug);
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cabins", columns: "*", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  const locations = await listLocations(slug);
  const serviceMap = await cabinServiceLinks(slug, [id]);
  const locationId = nullableNumber(row.location_id);
  return {
    id: Number(row.id ?? id),
    name: String(row.name ?? ""),
    position: Number(row.position ?? 0),
    isActive: Number(row.is_active ?? 1) === 1,
    locationId,
    locationName: locationName(locations, locationId),
    serviceLinks: serviceMap.get(id) ?? [],
  };
}

// Edit-form prefill for ONE operator. Port of staff.php action=edit (the
// operator edit form prefill): reads the single staff row by id directly (with
// its login user role + assigned locations), independent of the active-sede
// filter, and shapes it like the list rows.
export async function getManageStaffMember(slug: string, id: number): Promise<ResourceStaff | null> {
  if (!(id > 0)) return null;
  await ensureResourceColumns(slug);
  const ownerUserId = await tenantOwnerUserId(slug);
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "*", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  // NB: la riga SSO viene RESTITUITA — l'ordine guardie del legacy (1072-1084:
  // non trovato -> Solo Admin -> SSO) è applicato dalla route action=get.
  const locations = await listLocations(slug);
  const email = normalizeEmail(row.email ?? "");
  const [locationsMap, serviceMap, userRows] = await Promise.all([
    staffLocations(slug, [id]),
    staffServiceLinks(slug, [id]),
    email
      ? tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id,name,email,role", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => [])
      : Promise.resolve([] as RowDataPacket[]),
  ]);
  const user = userRows[0] ?? null;
  const locationIds = locationsMap.get(id) ?? [];
  const resolvedLocations = locationIds.length ? locations.filter((location) => locationIds.includes(location.id)) : locations;
  return {
    id: Number(row.id ?? id),
    fullName: String(row.full_name ?? ""),
    phone: String(row.phone ?? ""),
    email,
    role: normalizeRole(user?.role),
    isActive: Number(row.is_active ?? 1) === 1,
    // Colore RAW per il prefill del form: con NULL/invalido il form usa il
    // default #93c5fd (staff.php 1266). La palette per-indice di listStaff qui
    // stamperebbe un colore mai scelto che poi VERREBBE SALVATO al submit.
    color: /^#[0-9a-f]{6}$/i.test(String(row.calendar_color ?? "").trim()) ? String(row.calendar_color ?? "").trim() : "",
    photoPath: String(row.photo_path ?? ""),
    locationIds,
    locations: resolvedLocations,
    serviceLinks: serviceMap.get(id) ?? [],
    isOwner: ownerUserId > 0 && Number(user?.id ?? 0) === ownerUserId && String(user?.role ?? "") === "admin",
  };
}

// NB: il legacy NON ha un salvataggio per singola cabina (cabins.php espone solo
// il bulk #cabinsForm + action=delete): l'ex azione API cabin_save e' stata
// rimossa perche' permetteva di creare cabine fuori dalle regole legacy (senza
// sede, inattive, senza reorder).

export type SaveCabinsBulkResult =
  | { ok: true; cabins: ResourceCabin[] }
  | { ok: false; error: string; blockingServices?: CabinBlockerItem[]; popup?: CabinDeleteBlockPopup; cabins: ResourceCabin[] };

// Faithful port of cabins.php POST bulk-save (the #cabinsForm with cabins_count
// + cabin_names[] + cabin_ids[], scoped to location_id). Upserts the kept rows
// (position = index+1, is_active=1), deactivates the removed ones, and blocks
// the whole save when a removed cabin is still linked to services / future
// appointments — returning the blocking services so the UI can show the same
// "Impossibile eliminare la cabina" popup the legacy page does.
export async function saveCabinsBulk(slug: string, body: Record<string, string>): Promise<SaveCabinsBulkResult> {
  await ensureResourceColumns(slug);
  const table = await tenantTable(slug, "cabins");
  const hasLocationCol = await columnExists(table.name, "location_id");
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);

  let count = parseInteger(body.cabins_count ?? body.cabinsCount, 0);
  if (count < 0) count = 0;
  if (count > 50) count = 50;

  // Names/ids arrive as JSON arrays to preserve order and exact name content
  // (cabin names may contain commas/spaces, so a CSV split would corrupt them).
  const names = parseJsonArray<unknown>(body.cabin_names_json ?? body.cabin_names ?? "[]")
    .slice(0, count)
    .map((value) => cleanName(value, 120));
  while (names.length < count) names.push("");
  const ids = parseJsonArray<unknown>(body.cabin_ids_json ?? body.cabin_ids ?? "[]")
    .slice(0, count)
    .map((value) => Math.max(0, Number.parseInt(String(value ?? "0"), 10) || 0));
  while (ids.length < count) ids.push(0);

  // Ordine legacy (cabins.php 426-436): l'errore sede viene assegnato prima ma
  // il check nomi lo SOVRASCRIVE — a parita' di violazioni vince 'Inserisci un
  // nome per tutte le cabine.'.
  for (let i = 0; i < count; i++) {
    if ((names[i] ?? "") === "") {
      return { ok: false, error: "Inserisci un nome per tutte le cabine.", cabins: await listCabins(slug, locationId, await listLocations(slug)) };
    }
  }
  if (hasLocationCol && locationId <= 0) {
    return { ok: false, error: "Seleziona una sede per configurare le cabine.", cabins: await listCabins(slug, locationId, await listLocations(slug)) };
  }

  // Active rows for this scope, keyed by id (legacy cabin_fetch_active_rows:
  // con sede attiva le cabine location NULL ordinano per ULTIME).
  const activeRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "*",
    where: hasLocationCol && locationId > 0 ? "COALESCE(is_active,1)=1 AND (location_id = ? OR location_id IS NULL)" : "COALESCE(is_active,1)=1",
    params: hasLocationCol && locationId > 0 ? [locationId] : [],
    orderBy: hasLocationCol && locationId > 0 ? "(location_id IS NULL) ASC, position ASC, id ASC" : "position ASC, id ASC",
  }).catch(() => []);
  const activeById = new Map<number, RowDataPacket>();
  for (const row of activeRows) {
    const rid = Number(row.id ?? 0);
    if (rid > 0) activeById.set(rid, row);
  }

  // Removed = active rows whose id was not resubmitted. Block if any of those is
  // still linked to a service / future appointment.
  const submittedExistingIds = new Set<number>();
  for (const pid of ids) {
    if (pid > 0 && activeById.has(pid)) submittedExistingIds.add(pid);
  }
  const blockingServices: CabinBlockerItem[] = [];
  for (const rid of activeById.keys()) {
    if (!submittedExistingIds.has(rid)) {
      const blockers = await cabinDeleteBlockersLegacy(slug, rid, String(activeById.get(rid)?.name ?? ""));
      if (blockers.length) blockingServices.push(...blockers);
    }
  }
  if (blockingServices.length) {
    return {
      ok: false,
      error: "Impostazioni non salvate: una o piu cabine sono associate a servizi o prenotazioni future.",
      blockingServices,
      popup: cabinBlockPopup(
        "Impossibile eliminare la cabina",
        "Una o più cabine che stai rimuovendo sono associate ai servizi elencati. Rimuovi prima la cabina dai servizi collegati e poi riprova.",
        blockingServices,
      ),
      cabins: await listCabins(slug, locationId, await listLocations(slug)),
    };
  }

  // Upsert kept rows in submitted order (position = index+1), then deactivate
  // the removed ones.
  const keptIds = new Set<number>();
  for (let i = 0; i < count; i++) {
    const name = cleanName(names[i] ?? "", 120);
    const id = ids[i] ?? 0;
    const position = i + 1;
    if (id > 0 && activeById.has(id)) {
      const existingLocationId = hasLocationCol ? Number(activeById.get(id)?.location_id ?? 0) : 0;
      const values: Record<string, unknown> = { name, position, is_active: 1 };
      if (hasLocationCol && locationId > 0 && existingLocationId > 0) values.location_id = locationId;
      await tenantUpdate({ slug, table: "cabins", id, values: await filterColumns(table.name, values) });
      keptIds.add(id);
    } else {
      const values: Record<string, unknown> = { name, position, is_active: 1 };
      if (hasLocationCol && locationId > 0) values.location_id = locationId;
      const newId = await tenantInsert(table, await filterColumns(table.name, values));
      if (newId > 0) keptIds.add(newId);
    }
  }
  for (const rid of activeById.keys()) {
    if (!keptIds.has(rid)) {
      await tenantUpdate({ slug, table: "cabins", id: rid, values: { is_active: 0 } });
    }
  }
  // cabin_reorder_active dopo il salvataggio (cabins.php 508).
  await reorderActiveCabins(slug, hasLocationCol ? locationId : 0);

  return { ok: true, cabins: await listCabins(slug, locationId, await listLocations(slug)) };
}

// Voce del popup #cabinDeleteBlockModal legacy (cabin_delete_blockers_for_cabin:
// servizi collegati via service_cabins E services.cabin_id + prenotazioni
// future pending/scheduled con dettaglio data/cliente/stato).
export type CabinBlockerItem = {
  block_kind?: "appointment";
  service_id: number;
  service_name: string;
  service_active: number;
  cabin_id: number;
  cabin_name: string;
  detail?: string;
};

export type CabinDeleteBlockPopup = { title: string; message: string; services: CabinBlockerItem[] };

export async function cabinDeleteBlockersLegacy(slug: string, cabinId: number, cabinName = ""): Promise<CabinBlockerItem[]> {
  if (!(cabinId > 0)) return [];
  const out: CabinBlockerItem[] = [];

  // Servizi collegati (service_cabins + colonna legacy services.cabin_id).
  const byServiceId = new Map<number, CabinBlockerItem>();
  const services = await tenantTable(slug, "services").catch(() => null);
  if (services) {
    const svcScope = services.mode === "shared" ? " AND s.tenant_id = ?" : "";
    const svcParams = services.mode === "shared" ? [services.tenantId ?? 0] : [];
    const sc = await tenantTable(slug, "service_cabins").catch(() => null);
    if (sc) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT s.id AS service_id, COALESCE(NULLIF(TRIM(s.name), ''), CONCAT('Servizio #', s.id)) AS service_name, COALESCE(s.is_active, 1) AS service_active
           FROM ${quoteIdentifier(sc.name)} scx
           JOIN ${quoteIdentifier(services.name)} s ON s.id = scx.service_id
          WHERE scx.cabin_id = ?${svcScope}
          ORDER BY s.name ASC, s.id ASC`,
        [cabinId, ...svcParams],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const sid = Number(row.service_id ?? 0);
        if (sid > 0) byServiceId.set(sid, { service_id: sid, service_name: String(row.service_name ?? `Servizio #${sid}`), service_active: Number(row.service_active ?? 1), cabin_id: cabinId, cabin_name: cabinName });
      }
    }
    if (await columnExists(services.name, "cabin_id")) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT s.id AS service_id, COALESCE(NULLIF(TRIM(s.name), ''), CONCAT('Servizio #', s.id)) AS service_name, COALESCE(s.is_active, 1) AS service_active
           FROM ${quoteIdentifier(services.name)} s
          WHERE s.cabin_id = ?${svcScope}
          ORDER BY s.name ASC, s.id ASC`,
        [cabinId, ...svcParams],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const sid = Number(row.service_id ?? 0);
        if (sid > 0) byServiceId.set(sid, { service_id: sid, service_name: String(row.service_name ?? `Servizio #${sid}`), service_active: Number(row.service_active ?? 1), cabin_id: cabinId, cabin_name: cabinName });
      }
    }
  }
  out.push(...byServiceId.values());

  // Prenotazioni FUTURE pending/scheduled (appointments.cabin_id, servizio
  // legacy con cabin_id e appointment_segments.cabin_id).
  const appt = await tenantTable(slug, "appointments").catch(() => null);
  if (appt) {
    const seen = new Set<number>();
    const clients = await tenantTable(slug, "clients").catch(() => null);
    const clientJoin = clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} cl ON cl.id = a.client_id` : "";
    const clientSelect = clients ? "cl.full_name AS client_name" : "NULL AS client_name";
    const hasPublicCode = await columnExists(appt.name, "public_code");
    const hasApptCabin = await columnExists(appt.name, "cabin_id");
    const hasServiceCabin = services ? await columnExists(services.name, "cabin_id") : false;
    const scope = appt.mode === "shared" ? " AND a.tenant_id = ?" : "";
    const scopeParams = appt.mode === "shared" ? [appt.tenantId ?? 0] : [];
    const pushAppt = (row: RowDataPacket) => {
      const aid = Number(row.appointment_id ?? 0);
      if (!(aid > 0) || seen.has(aid)) return;
      seen.add(aid);
      const raw = row.starts_at instanceof Date
        ? `${row.starts_at.getFullYear()}-${String(row.starts_at.getMonth() + 1).padStart(2, "0")}-${String(row.starts_at.getDate()).padStart(2, "0")} ${String(row.starts_at.getHours()).padStart(2, "0")}:${String(row.starts_at.getMinutes()).padStart(2, "0")}`
        : String(row.starts_at ?? "").replace("T", " ");
      const when = /^\d{4}-\d{2}-\d{2}/.test(raw) ? `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)} ${raw.length >= 16 ? raw.slice(11, 16) : "00:00"}` : "";
      const code = String(row.public_code ?? "").trim();
      const detail: string[] = [];
      if (when) detail.push(when);
      const client = String(row.client_name ?? "").trim();
      if (client) detail.push(client);
      const status = String(row.status ?? "").trim();
      if (status) detail.push(status);
      out.push({
        block_kind: "appointment",
        service_id: 0,
        service_name: `Prenotazione ${code !== "" ? code : `#${aid}`}`,
        service_active: 1,
        cabin_id: cabinId,
        cabin_name: cabinName,
        detail: detail.join(" - "),
      });
    };

    const segments = await tenantTable(slug, "appointment_segments").catch(() => null);
    const hasSegCabin = segments ? await columnExists(segments.name, "cabin_id") : false;
    if (segments && hasSegCabin) {
      // COALESCE legacy a 3 livelli (cabins.php 232-237): sg.cabin_id, poi
      // a.cabin_id, poi sv.cabin_id via sg.service_id — solo se le colonne esistono.
      const hasSegServiceId = await columnExists(segments.name, "service_id");
      const segCabinParts = ["sg.cabin_id"];
      if (hasApptCabin) segCabinParts.push("a.cabin_id");
      const segSvcJoin = services && hasServiceCabin && hasSegServiceId ? `LEFT JOIN ${quoteIdentifier(services.name)} sv ON sv.id = sg.service_id` : "";
      if (segSvcJoin) segCabinParts.push("sv.cabin_id");
      const segCabinExpr = segCabinParts.length > 1 ? `COALESCE(${segCabinParts.join(", ")})` : segCabinParts[0];
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT DISTINCT a.id AS appointment_id, ${hasPublicCode ? "a.public_code" : "NULL AS public_code"}, a.starts_at, a.status, ${clientSelect}
           FROM ${quoteIdentifier(segments.name)} sg
           JOIN ${quoteIdentifier(appt.name)} a ON a.id = sg.appointment_id
           ${segSvcJoin}
           ${clientJoin}
          WHERE a.status IN ('pending','scheduled') AND sg.ends_at >= NOW()
            AND ${segCabinExpr} = ?${scope}
          ORDER BY a.starts_at ASC, a.id ASC`,
        [cabinId, ...scopeParams],
      ).catch(() => [] as RowDataPacket[]);
      rows.forEach(pushAppt);
    }
    // Query diretta (cabins.php 254-290): condizioni costruite per esistenza
    // colonne; esclude gli appuntamenti gia' coperti dai segmenti.
    if (hasApptCabin || hasServiceCabin) {
      const excludeSegmented = segments && hasSegCabin ? ` AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(segments.name)} sg2 WHERE sg2.appointment_id = a.id)` : "";
      const svcJoin = services && hasServiceCabin ? `LEFT JOIN ${quoteIdentifier(services.name)} sv ON sv.id = a.service_id` : "";
      const conditions: string[] = [];
      const conditionParams: number[] = [];
      if (hasApptCabin) {
        conditions.push("a.cabin_id = ?");
        conditionParams.push(cabinId);
      }
      if (hasApptCabin && svcJoin) {
        conditions.push("(a.cabin_id IS NULL AND sv.cabin_id = ?)");
        conditionParams.push(cabinId);
      } else if (svcJoin) {
        conditions.push("sv.cabin_id = ?");
        conditionParams.push(cabinId);
      }
      if (conditions.length) {
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT DISTINCT a.id AS appointment_id, ${hasPublicCode ? "a.public_code" : "NULL AS public_code"}, a.starts_at, a.status, ${clientSelect}
             FROM ${quoteIdentifier(appt.name)} a
             ${svcJoin}
             ${clientJoin}
            WHERE a.status IN ('pending','scheduled') AND a.ends_at >= NOW()${excludeSegmented}
              AND (${conditions.join(" OR ")})${scope}
            ORDER BY a.starts_at ASC, a.id ASC`,
          [...conditionParams, ...scopeParams],
        ).catch(() => [] as RowDataPacket[]);
        rows.forEach(pushAppt);
      }
    }
  }

  return out;
}

// cabin_flash_delete_block_popup: con prenotazioni il messaggio cambia (senza accento).
function cabinBlockPopup(title: string, message: string, services: CabinBlockerItem[]): CabinDeleteBlockPopup {
  const hasAppointment = services.some((item) => item.block_kind === "appointment");
  return {
    title,
    message: hasAppointment ? "La cabina e associata a servizi o prenotazioni future. Rimuovi prima i collegamenti o sposta le prenotazioni e poi riprova." : message,
    services,
  };
}

// cabin_reorder_active: ricompatta position 1..N per le cabine attive della sede.
async function reorderActiveCabins(slug: string, locationId: number): Promise<void> {
  const table = await tenantTable(slug, "cabins").catch(() => null);
  if (!table) return;
  const hasLocation = await columnExists(table.name, "location_id");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "id",
    where: hasLocation && locationId > 0 ? "COALESCE(is_active,1)=1 AND location_id = ?" : "COALESCE(is_active,1)=1",
    params: hasLocation && locationId > 0 ? [locationId] : [],
    orderBy: "position ASC, id ASC",
  }).catch(() => []);
  let position = 1;
  for (const row of rows) {
    const rid = Number(row.id ?? 0);
    if (rid > 0) await tenantUpdate({ slug, table: "cabins", id: rid, values: { position: position++ } }).catch(() => undefined);
  }
}

// Port di cabins.php action=delete (363-398): soft delete con guardie e popup.
export async function deleteCabin(slug: string, id: number, locationId = 0): Promise<void> {
  const cabinId = Math.max(0, Number(id) || 0);
  const table = await tenantTable(slug, "cabins").catch(() => null);
  const hasLocation = table ? await columnExists(table.name, "location_id") : false;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "id, name",
    where: hasLocation && locationId > 0 ? "id = ? AND COALESCE(is_active,1)=1 AND (location_id = ? OR location_id IS NULL)" : "id = ? AND COALESCE(is_active,1)=1",
    params: hasLocation && locationId > 0 ? [cabinId, locationId] : [cabinId],
    limit: 1,
  }).catch(() => []);
  if (!rows[0]) throw new Error("Cabina non trovata");

  const blockers = await cabinDeleteBlockersLegacy(slug, cabinId, String(rows[0].name ?? ""));
  if (blockers.length) {
    // Messaggio flash SENZA accento su 'e' (cabins.php 384) + popup di sessione.
    const error = new Error("Cabina non eliminata: e associata a servizi o prenotazioni future.") as Error & { popup?: CabinDeleteBlockPopup };
    error.popup = cabinBlockPopup(
      "Impossibile eliminare la cabina",
      "La cabina è associata ai servizi elencati. Rimuovi prima la cabina dai servizi collegati: finché è presente in un servizio non può essere eliminata.",
      blockers,
    );
    throw error;
  }
  await tenantUpdate({ slug, table: "cabins", id: cabinId, values: { is_active: 0 } });
  await reorderActiveCabins(slug, locationId);
}

// Errori che il legacy veicola come ?msg= (alert VERDE, staff.php 883-955) vs
// gli err rossi di staff_form_error_redirect: flashKind li distingue.
function staffFlashError(message: string, flashKind: "msg" | "err" = "err"): Error {
  const error = new Error(message) as Error & { flashKind?: "msg" | "err" };
  error.flashKind = flashKind;
  return error;
}

export async function saveStaffMember(slug: string, body: Record<string, string>, options: { actorIsAdmin?: boolean } = {}): Promise<ResourceStaff> {
  const actorIsAdmin = options.actorIsAdmin !== false;
  const table = await tenantTable(slug, "staff");
  const id = parseInteger(body.id, 0);
  const fullName = cleanName(body.full_name ?? body.fullName, 190);
  const email = normalizeEmail(body.email ?? "");
  const phone = cleanName(body.phone ?? "", 40);
  let role = normalizeRole(body.role ?? body.ui_role);
  const password = String(body.password ?? "");
  let isActive = truthy(body.is_active ?? body.isActive ?? "1");
  const locationIds = parseIdList(body.location_ids ?? body.locationIds);

  // ORDINE VALIDAZIONI LEGACY (staff.php 742-896): SSO -> Solo-Admin-edit ->
  // colore -> Solo-Admin-assegna -> owner-email -> sede obbligatoria -> guardie
  // sedi/disattivazione -> email/password/unicita.
  // SSO: operatore tecnico non gestibile da questa pagina (staff.php 754-764).
  if (id > 0) {
    const ssoRows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "full_name", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
    if (String(ssoRows[0]?.full_name ?? "").trim().toUpperCase() === "SSO") throw staffFlashError("Operatore SSO non modificabile", "msg");
  }
  // Check protettivo NON presente nel legacy (required solo client-side): evita
  // insert con nome vuoto da POST diretto.
  if (!fullName) throw new Error("Nome operatore obbligatorio.");
  if (fullName.toUpperCase() === "SSO") throw staffFlashError("Nome operatore riservato (SSO)", "msg");

  // Owner (primo utente admin del tenant) + gating 'Solo Admin' (staff.php 779-781).
  const current = id > 0 ? await staffRowWithUser(slug, id) : null;
  const ownerUserId = await tenantOwnerUserId(slug);
  const isOwnerEditing = Boolean(current && ownerUserId > 0 && Number(current.user_id ?? 0) === ownerUserId && String(current.user_role ?? "") === "admin");
  if (!actorIsAdmin && current && String(current.user_role ?? "") === "admin") {
    throw new Error("Solo Admin puo modificare account Admin.");
  }

  // Colore calendario: formato #RRGGBB o vuoto (staff.php 784-796, come msg).
  let colorRaw = String(body.calendar_color ?? body.color ?? "").trim();
  let color: string | null = null;
  if (colorRaw !== "") {
    if (!colorRaw.startsWith("#")) colorRaw = `#${colorRaw}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(colorRaw)) throw staffFlashError("Colore non valido", "msg");
    color = colorRaw;
  }

  if (role === "admin" && !actorIsAdmin) throw new Error("Solo Admin puo assegnare il ruolo Admin.");
  if (isOwnerEditing) {
    if (!email) throw staffFlashError("Email obbligatoria per Admin", "msg");
    isActive = true;
    role = "admin";
  }

  // "Seleziona almeno una sede per l'operatore." (staff.php:823) — solo quando
  // il tenant ha sedi configurate (con la tabella assente il legacy salta il check).
  const allLocations = await listLocations(slug);
  if (locationIds.length === 0 && allLocations.length > 0) {
    throw new Error("Seleziona almeno una sede per l'operatore.");
  }

  // Guardie sede/disattivazione legacy (staff.php 828-873), solo in edit non-owner.
  if (id > 0 && !isOwnerEditing) {
    const allLocationIds = allLocations.map((location) => location.id);
    const oldStoredRows = await tenantSelect<RowDataPacket>({ slug, table: "staff_locations", columns: "location_id", where: "staff_id = ?", params: [id], orderBy: "location_id ASC" }).catch(() => []);
    const oldStored = uniquePositive(oldStoredRows.map((row) => Number(row.location_id ?? 0)));
    const oldEffective = oldStored.filter((lid) => allLocationIds.includes(lid));
    const newEffective = locationIds.filter((lid) => allLocationIds.includes(lid));
    const removedLocationIds = oldEffective.filter((lid) => !newEffective.includes(lid));
    if (removedLocationIds.length) {
      if (await staffHasOpenAppointmentsInLocations(slug, id, removedLocationIds)) {
        throw new Error("Non puoi rimuovere questa sede: l'operatore ha prenotazioni in sospeso o prenotate collegate.");
      }
      const blockers = await staffServiceLocationBlockers(slug, id, removedLocationIds, allLocations);
      if (blockers.length) {
        throw new Error(`Non puoi rimuovere la sede "${blockers[0].locationName}": il servizio "${blockers[0].serviceName}" resterebbe senza operatori abilitati.`);
      }
    }
    const oldActive = Number(current?.is_active ?? 1) === 1;
    if (!isActive && oldActive) {
      if (await staffHasAppointmentRefs(slug, id, true)) {
        throw new Error("Non puoi disattivare l'operatore: ha prenotazioni in sospeso o prenotate collegate.");
      }
      const blockers = await staffServiceLocationBlockers(slug, id, oldEffective.length ? oldEffective : allLocationIds, allLocations);
      if (blockers.length) {
        throw new Error(`Non puoi disattivare l'operatore: il servizio "${blockers[0].serviceName}" resterebbe senza operatori abilitati in "${blockers[0].locationName}".`);
      }
    }
  }

  // Email/password/unicita DOPO le guardie sedi (ordine legacy 880-896 new /
  // 947-958 edit). 'Email obbligatoria'/'Password obbligatoria'/'Email già
  // utilizzata' viaggiano come ?msg= (alert VERDE, quirk del legacy).
  if (id <= 0 && !email) throw staffFlashError("Email obbligatoria", "msg");
  if (id <= 0 && !password) throw staffFlashError("Password obbligatoria", "msg");
  if (email) await ensureStaffEmailAvailable(slug, email, id);

  // Capture the prior staff email and whether a login user already existed under it
  // BEFORE we write — these drive the legacy staff-invite "Conferma email account"
  // code email below (the legacy edit handler keys its email-change branch on the
  // user found by the OLD email: `$oldUserId > 0 && oldEmail !== newEmail`).
  const oldStaffRows = id > 0
    ? await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "email", where: "id = ?", params: [id], limit: 1 }).catch(() => [])
    : [];
  const oldStaffEmail = normalizeEmail(String(oldStaffRows[0]?.email ?? ""));
  const oldLoginUser = oldStaffEmail
    ? await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id", where: "LOWER(email) = ?", params: [oldStaffEmail], limit: 1 }).catch(() => [])
    : [];
  const oldLoginUserId = Number(oldLoginUser[0]?.id ?? 0);
  const newEmailUserRows = email
    ? await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => [])
    : [];
  const newEmailUserId = Number(newEmailUserRows[0]?.id ?? 0);
  // staff.php 956-958: in edit, email nuova senza NESSUN account esistente e
  // senza password -> errore PRIMA di ogni scrittura (il legacy abortisce la
  // transazione: nulla persiste).
  if (id > 0 && email && newEmailUserId <= 0 && oldLoginUserId <= 0 && !password) {
    throw new Error("Password obbligatoria per creare l'account login dell'operatore.");
  }

  const values = await filterColumns(table.name, {
    full_name: fullName,
    phone: phone || null,
    email: email || null,
    is_active: isActive ? 1 : 0,
    calendar_color: color,
  });

  let staffId = id;
  if (id > 0) {
    await tenantUpdate({ slug, table: "staff", id, values });
  } else {
    staffId = await tenantInsert(table, values);
  }

  // L'utente login va risolto con l'email PRE-write (oldLoginUserId): la riga
  // staff è già stata aggiornata, rileggerla troverebbe l'email NUOVA e il
  // cambio-email non aggancerebbe mai l'account esistente (staff.php 970-998).
  if (email) await upsertStaffLoginUser(slug, { staffId, fullName, email, role, password, oldLoginUserId });
  else if (id > 0) await deleteLoginUserForStaffWithoutEmail(slug, oldLoginUserId);
  await replaceOwnerLinks(slug, "staff_locations", "staff_id", staffId, "location_id", locationIds);

  // Staff-invite email (port of the "Conferma email account" code mail in
  // staff.php). It fires in the same two cases as the legacy handler:
  //   - NEW staff with an email (a fresh login account)  -> updated=false intro;
  //   - EDIT of an existing login user whose email changed -> updated=true intro.
  // It is best-effort / tenant-scoped / SES-gated (see sendStaffInviteEmailCode):
  // we resolve the user id AFTER the user row is written, never failing this flow.
  if (email) {
    const isNew = id <= 0;
    const emailChangedOnEdit = !isNew && oldLoginUserId > 0 && oldStaffEmail !== "" && oldStaffEmail !== email;
    // staff.php 1007-1012: in edit l'account creato "tardi" (nessun utente né
    // sotto la vecchia né sotto la nuova email) manda lo stesso invito ma con
    // la variante SENZA accenti di staff_prepare_email_verification (147-148).
    const lateCreateOnEdit = !isNew && oldLoginUserId <= 0 && newEmailUserId <= 0;
    if (isNew || emailChangedOnEdit || lateCreateOnEdit) {
      const userRows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => []);
      const userId = Number(userRows[0]?.id ?? 0);
      if (userId > 0) {
        await sendStaffInviteEmailCode({ slug, userId, email, updated: emailChangedOnEdit, plain: lateCreateOnEdit });
      }
    }
  }

  return mustFindStaff(slug, staffId);
}

// Popup 'Impossibile eliminare l'operatore' (staff_flash_delete_block_popup).
export type StaffDeleteBlockPopup = {
  title: string;
  operator_name: string;
  message: string;
  services: Array<{ service_id: number; service_name: string; service_active: number }>;
};

// Port completo di staff.php action=delete (626-703): guardie in ordine
// (SSO come msg, Admin protetto, gating Solo Admin, storico prenotazioni,
// servizi con popup, storico commissioni), poi hard delete con account login
// e righe collegate.
export async function deleteStaffMember(slug: string, id: number, options: { actorIsAdmin?: boolean } = {}): Promise<void> {
  const actorIsAdmin = options.actorIsAdmin !== false;
  const staffId = Math.max(0, Number(id) || 0);
  const row = staffId > 0 ? await staffRowWithUser(slug, staffId) : null;
  if (row && String(row.full_name ?? "").trim().toUpperCase() === "SSO") throw staffFlashError("Operatore SSO non eliminabile", "msg");
  const ownerUserId = await tenantOwnerUserId(slug);
  if (row && ownerUserId > 0 && Number(row.user_id ?? 0) === ownerUserId && String(row.user_role ?? "") === "admin") throw new Error("Admin non può essere eliminato");
  if (!row) throw new Error("Operatore non trovato");
  if (!actorIsAdmin && String(row.user_role ?? "") === "admin") throw new Error("Solo Admin puo eliminare o modificare account Admin.");
  if (await staffHasAppointmentRefs(slug, staffId, false)) throw new Error("Operatore non eliminabile: risulta gia usato in prenotazioni. Disattivalo per mantenere lo storico.");

  const linked = (await staffServiceLinks(slug, [staffId])).get(staffId) ?? [];
  if (linked.length) {
    const error = new Error("Operatore non eliminabile: associato a uno o più servizi") as Error & { popup?: StaffDeleteBlockPopup };
    error.popup = {
      title: "Impossibile eliminare l'operatore",
      operator_name: String(row.full_name ?? "Operatore"),
      message: "L'operatore non può essere eliminato perché è associato ai servizi elencati. Rimuovi prima l'operatore dai servizi collegati.",
      services: linked.map((link) => ({ service_id: link.serviceId, service_name: link.serviceName, service_active: link.isActive ? 1 : 0 })),
    };
    throw error;
  }
  if (await staffHasCommissionHistory(slug, staffId)) throw new Error("Operatore non eliminabile: risulta usato nello storico commissioni. Disattivalo per mantenere lo storico.");

  const email = normalizeEmail(row.email ?? "");
  if (email && !await staffEmailUsed(slug, email, staffId)) {
    const users = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => []);
    const loginUserId = Number(users[0]?.id ?? 0);
    if (loginUserId > 0) {
      await deleteByOwner(slug, "user_email_verifications", "user_id", loginUserId);
      await deleteByOwner(slug, "user_locations", "user_id", loginUserId);
      await tenantDelete({ slug, table: "users", id: loginUserId }).catch(() => undefined);
    }
  }
  // staff_delete_related_rows (staff.php 188-196).
  for (const tableName of ["staff_locations", "staff_availability", "staff_timeoff", "staff_services", "staff_commission_settings", "staff_commission_periods"]) {
    await deleteByOwner(slug, tableName, "staff_id", staffId);
  }
  await tenantDelete({ slug, table: "staff", id: staffId });
  // staff.php 699-701: il file foto rimosso DOPO il commit (best-effort, su R2).
  const photoKey = storageKeyFromPublicUrl(String(row.photo_path ?? "").trim());
  if (photoKey) await deletePublicObject(photoKey).catch(() => undefined);
}

export async function saveBusinessHours(slug: string, body: Record<string, string>): Promise<BusinessHourRow[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  if (locationId <= 0) throw new Error("Seleziona una sede.");
  const rows = parseHoursRows(body.hours_json ?? body.hours ?? "[]");

  // hours.php 145-241: valida TUTTE le righe accumulando gli errori; il flash
  // danger unisce i primi 8 con "; " (suffisso " ..." se ce ne sono di più).
  const errors = rows.flatMap((row) => hoursRowErrors(row));
  if (errors.length) throw new Error(`Orari non validi: ${errors.slice(0, 8).join("; ")}${errors.length > 8 ? " ..." : ""}`);

  const table = await tenantTable(slug, "business_hours");
  for (const row of rows) {
    const existing = await tenantSelect<RowDataPacket>({
      slug,
      table: "business_hours",
      columns: "id",
      where: "location_id = ? AND dow = ?",
      params: [locationId, row.dow],
      limit: 1,
    }).catch(() => []);
    const values = await filterColumns(table.name, {
      location_id: locationId,
      dow: row.dow,
      opens: hourTimeOrNull(row.opens),
      closes: hourTimeOrNull(row.closes),
      opens2: hourTimeOrNull(row.opens2),
      closes2: hourTimeOrNull(row.closes2),
      is_closed: row.is_closed,
    });
    if (existing[0]?.id) await tenantUpdate({ slug, table: "business_hours", id: Number(existing[0].id), values });
    else await tenantInsert(table, values);
  }
  return listBusinessHours(slug, locationId);
}

// Port fedele di hours.php tab=closures POST (243-341): accumula gli errori
// nell'ordine legacy e li impacchetta in "Impossibile salvare: " + primi 3
// separati da spazio (" ..." oltre). Le date nei conflitti sono d/m/Y.
export async function saveClosure(slug: string, body: Record<string, string>): Promise<CalendarDateRange[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  if (locationId <= 0) throw new Error("Seleziona una sede.");
  const from = String(body.date_from ?? body.from ?? "").trim();
  let to = String(body.date_to ?? body.to ?? "").trim();
  if (to === "") to = from;
  const kind = String(body.kind ?? "").trim();
  const note = String(body.note ?? "").trim();
  const reason = (kind + (note ? ` - ${note}` : "")).trim() || null;

  const errors: string[] = [];
  if (from === "") errors.push("Seleziona una data di inizio.");
  let start = normalizeDate(from) || null;
  let end = normalizeDate(to) || null;
  if (!start) errors.push("Data inizio non valida.");
  if (!end) errors.push("Data fine non valida.");
  if (start && end && end < start) [start, end] = [end, start];
  if (!errors.length && start && end && daysDiff(start, end) + 1 > 370) {
    errors.push("Intervallo troppo lungo. Seleziona un periodo più breve.");
  }
  if (!errors.length && start && end) {
    const conflicts = await exceptionDatesInRange(slug, locationId, start, end);
    if (conflicts.length) {
      errors.push(`Impossibile salvare la chiusura: esistono già aperture straordinarie nelle seguenti date: ${conflicts.slice(0, 6).map(isoToDmy).join(", ")}${conflicts.length > 6 ? " ..." : ""}. Rimuovi prima lo straordinario o modifica le date.`);
    }
  }
  if (!errors.length && start && end) {
    const activeDates = await activeAppointmentDates(slug, locationId, start, end);
    if (activeDates.length) {
      errors.push(`Impossibile salvare la chiusura: esistono appuntamenti in sospeso o prenotati nelle seguenti date: ${dateSampleIt(activeDates)}. Sposta o annulla prima gli appuntamenti.`);
    }
  }
  if (errors.length) throw new Error(`Impossibile salvare: ${errors.slice(0, 3).join(" ")}${errors.length > 3 ? " ..." : ""}`);

  const table = await tenantTable(slug, "closures");
  const dates = datesBetween(start!, end!);
  for (const date of dates) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "closures", columns: "id", where: "location_id = ? AND date = ?", params: [locationId, date], limit: 1 }).catch(() => []);
    if (existing[0]?.id) await tenantUpdate({ slug, table: "closures", id: Number(existing[0].id), values: { reason } });
    else await tenantInsert(table, await filterColumns(table.name, { location_id: locationId, date, reason }));
  }
  return listClosureRanges(slug, locationId);
}

export async function deleteClosureRange(slug: string, body: Record<string, string>): Promise<CalendarDateRange[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  const from = normalizeDate(body.from ?? body.date_from);
  const to = normalizeDate(body.to ?? body.date_to) || from;
  if (locationId <= 0 || !from || !to) throw new Error("Intervallo non valido.");
  const [start, end] = orderedDates(from, to);
  await deleteDateRange(slug, "closures", locationId, start, end, body.reason ?? "");
  return listClosureRanges(slug, locationId);
}

// Port fedele di hours.php tab=exceptions POST (345-473): errori accumulati
// nell'ordine legacy, wrap "Impossibile salvare: " + primi 6 separati da
// spazio (" ..." oltre). I messaggi orario sono frasi standalone (non
// prefissate dal giorno come nel tab Orari).
export async function saveException(slug: string, body: Record<string, string>): Promise<CalendarExceptionRange[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  if (locationId <= 0) throw new Error("Seleziona una sede.");
  const from = String(body.date_from ?? body.from ?? "").trim();
  let to = String(body.date_to ?? body.to ?? "").trim();
  if (to === "") to = from;
  const note = String(body.note ?? "").trim();
  const opens = String(body.opens ?? "").trim();
  const closes = String(body.closes ?? "").trim();
  const opens2 = String(body.opens2 ?? "").trim();
  const closes2 = String(body.closes2 ?? "").trim();

  const errors: string[] = [];
  if (from === "") errors.push("Seleziona una data di inizio.");
  let start = normalizeDate(from) || null;
  let end = normalizeDate(to) || null;
  if (!start) errors.push("Data inizio non valida.");
  if (!end) errors.push("Data fine non valida.");
  if (start && end && end < start) [start, end] = [end, start];

  if (opens === "" || closes === "") {
    errors.push("Per un'apertura straordinaria devi compilare apertura e chiusura.");
  } else {
    const open1 = phpTimeToMinutes(opens);
    const close1 = phpTimeToMinutes(closes);
    if (open1 === null || close1 === null) errors.push("Formato orario non valido.");
    else if (close1 <= open1) errors.push("La chiusura deve essere successiva all'apertura.");
  }
  if (opens2 !== "" || closes2 !== "") {
    if (opens2 === "" || closes2 === "") {
      errors.push("Per l'orario spezzato devi compilare sia riapertura sia chiusura 2.");
    } else if (opens === "" || closes === "") {
      errors.push("Per l'orario spezzato devi compilare anche apertura e chiusura (prima fascia).");
    } else {
      const close1 = phpTimeToMinutes(closes);
      const open2 = phpTimeToMinutes(opens2);
      const close2 = phpTimeToMinutes(closes2);
      if (open2 === null || close2 === null || close1 === null) {
        errors.push("Formato orario spezzato non valido.");
      } else {
        if (open2 < close1) errors.push("La riapertura deve essere uguale o successiva alla chiusura (prima fascia).");
        if (close2 <= open2) errors.push("La chiusura 2 deve essere successiva alla riapertura.");
      }
    }
  }
  if (!errors.length && start && end && daysDiff(start, end) + 1 > 370) {
    errors.push("Intervallo troppo lungo. Seleziona un periodo più breve.");
  }
  if (!errors.length && start && end) {
    const closureConflicts = await closureDatesInRange(slug, locationId, start, end);
    if (closureConflicts.length) {
      errors.push(`Impossibile salvare lo straordinario: le seguenti date sono impostate come chiuse: ${closureConflicts.slice(0, 6).map(isoToDmy).join(", ")}${closureConflicts.length > 6 ? " ..." : ""}. Rimuovi prima la chiusura (tab Chiusure) o modifica le date.`);
    }
  }
  if (errors.length) throw new Error(`Impossibile salvare: ${errors.slice(0, 6).join(" ")}${errors.length > 6 ? " ..." : ""}`);

  const table = await tenantTable(slug, "business_hours_exceptions");
  const dates = datesBetween(start!, end!);
  for (const date of dates) {
    const existing = await tenantSelect<RowDataPacket>({
      slug,
      table: "business_hours_exceptions",
      columns: "id",
      where: "location_id = ? AND date = ?",
      params: [locationId, date],
      limit: 1,
    }).catch(() => []);
    const values = await filterColumns(table.name, {
      location_id: locationId,
      date,
      opens: hourTimeOrNull(opens),
      closes: hourTimeOrNull(closes),
      opens2: hourTimeOrNull(opens2),
      closes2: hourTimeOrNull(closes2),
      is_closed: 0,
      note: note || null,
    });
    if (existing[0]?.id) await tenantUpdate({ slug, table: "business_hours_exceptions", id: Number(existing[0].id), values });
    else await tenantInsert(table, values);
  }
  return listExceptionRanges(slug, locationId);
}

export async function deleteExceptionRange(slug: string, body: Record<string, string>): Promise<CalendarExceptionRange[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  const from = normalizeDate(body.from ?? body.date_from);
  const to = normalizeDate(body.to ?? body.date_to) || from;
  if (locationId <= 0 || !from || !to) throw new Error("Intervallo non valido.");
  const [start, end] = orderedDates(from, to);
  await deleteDateRange(slug, "business_hours_exceptions", locationId, start, end);
  return listExceptionRanges(slug, locationId);
}

export async function saveAvailabilityEvent(slug: string, body: Record<string, string>): Promise<StaffAvailabilityEvent[]> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  const staffId = parseInteger(body.staff_id ?? body.staffId, 0);
  const type = normalizeAvailabilityType(body.event_type ?? body.type ?? "turno");
  const startDateRaw = normalizeDate(body.date_from ?? body.dateFrom);
  const endDateRaw = normalizeDate(body.date_to ?? body.dateTo) || startDateRaw;
  const timeFrom = normalizeTime(body.time_from ?? body.timeFrom);
  const timeTo = normalizeTime(body.time_to ?? body.timeTo);
  const editId = parseInteger(body.event_id ?? body.id, 0);
  const editTable = String(body.event_table ?? body.table ?? "");
  const applySeries = truthy(body.apply_series ?? body.applySeries);
  if (staffId <= 0 || !startDateRaw || !endDateRaw || !timeFrom || !timeTo) throw new Error("Compila tutti i campi obbligatori (Al, Dalle, Alle)");
  if (hhmmToMin(timeTo) === null || hhmmToMin(timeFrom) === null) throw new Error("Inserisci orari validi (HH:MM)");
  if ((hhmmToMin(timeTo) ?? 0) <= (hhmmToMin(timeFrom) ?? 0)) throw new Error("Gli orari selezionati non sono validi");
  await ensureStaffAvailableForLocation(slug, staffId, locationId);

  const [startDate, endDate] = orderedDates(startDateRaw, endDateRaw);
  const repeat = String(body.repeat ?? "none");
  const occDates = type === "turno" || type === "presenza"
    ? occurrenceDates(startDate, repeat, normalizeDate(body.repeat_until ?? body.repeatUntil), parseIdList(body.dows))
    : repeat === "none"
      ? [startDate]
      : occurrenceDates(startDate, repeat, normalizeDate(body.repeat_until ?? body.repeatUntil), parseIdList(body.dows));
  if (!occDates.length) throw new Error("Controlla ripetizione e data fine.");

  if (type === "turno" || type === "presenza") {
    for (const date of occDates) await ensureWithinBusinessHours(slug, locationId, date, timeFrom, timeTo, true);
    await deleteEditedAvailability(slug, editTable, editId, staffId, applySeries);
    const table = await tenantTable(slug, "staff_availability");
    const seriesUid = occDates.length > 1 ? randomSeriesUid() : null;
    for (const date of occDates) {
      await tenantInsert(table, await filterColumns(table.name, {
        staff_id: staffId,
        location_id: locationId || null,
        kind: type,
        starts_at: mysqlDateTime(date, timeFrom),
        ends_at: mysqlDateTime(date, timeTo),
        series_uid: seriesUid,
      }));
    }
  } else {
    const datesToValidate = repeat === "none" ? datesBetween(startDate, endDate) : occDates;
    for (const date of datesToValidate) await ensureWithinBusinessHours(slug, locationId, date, timeFrom, timeTo, false);
    await deleteEditedAvailability(slug, editTable, editId, staffId, applySeries);
    const table = await tenantTable(slug, "staff_timeoff");
    const reason = type === "ferie" ? "Ferie" : type === "malattia" ? "Malattia" : "Assenza";
    if (repeat === "none") {
      await tenantInsert(table, await filterColumns(table.name, {
        staff_id: staffId,
        starts_at: mysqlDateTime(startDate, timeFrom),
        ends_at: mysqlDateTime(endDate, timeTo),
        reason,
      }));
    } else {
      for (const date of occDates) {
        await tenantInsert(table, await filterColumns(table.name, {
          staff_id: staffId,
          starts_at: mysqlDateTime(date, timeFrom),
          ends_at: mysqlDateTime(date, timeTo),
          reason,
        }));
      }
    }
  }

  const range = weekRange(startDate);
  return listStaffAvailability(slug, locationId, range.start, range.end);
}

function hhmmToMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h >= 0 && h <= 23 && mm >= 0 && mm <= 59 ? h * 60 + mm : null;
}

// DUPLICA SETTIMANA (staff_availability.php do=copy_week ~723-908): copia SOLO
// turno/presenza dal lunedì della settimana origine a quella di destinazione,
// filtro operatore opzionale, overwrite = svuota prima la destinazione,
// altrimenti salta i duplicati esatti; le serie vengono rimappate a nuovi uid.
export async function copyWeekAvailability(slug: string, body: Record<string, string>): Promise<{ message: string; events: StaffAvailabilityEvent[] }> {
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  const sourceRaw = normalizeDate(body.source_week);
  const targetRaw = normalizeDate(body.target_week);
  if (!sourceRaw || !targetRaw) throw new Error("Seleziona settimana di origine e destinazione");
  const source = weekRange(sourceRaw);
  const target = weekRange(targetRaw);
  if (source.start === target.start) throw new Error("La settimana di destinazione è uguale a quella di origine");
  const copyStaffId = parseInteger(body.copy_staff_id, 0);
  const overwrite = truthy(body.overwrite);
  if (copyStaffId > 0) await ensureStaffAvailableForLocation(slug, copyStaffId, locationId);

  const table = await tenantTable(slug, "staff_availability");
  const hasLocation = await columnExists(table.name, "location_id");
  const where: string[] = ["kind IN ('turno','presenza')", "starts_at >= ?", "starts_at < ?"];
  const params: unknown[] = [`${source.start} 00:00:00`, `${source.end} 00:00:00`];
  if (copyStaffId > 0) { where.push("staff_id = ?"); params.push(copyStaffId); }
  if (hasLocation && locationId > 0) { where.push("(location_id = ? OR location_id IS NULL)"); params.push(locationId); }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff_availability", where: where.join(" AND "), params, orderBy: "starts_at ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  if (!rows.length) throw new Error("Nessun turno da copiare");

  if (overwrite) {
    const delWhere: string[] = ["kind IN ('turno','presenza')", "starts_at >= ?", "starts_at < ?"];
    const delParams: unknown[] = [table.tenantId ?? 0, `${target.start} 00:00:00`, `${target.end} 00:00:00`];
    if (copyStaffId > 0) { delWhere.push("staff_id = ?"); delParams.push(copyStaffId); }
    await dbExecute(
      `DELETE FROM ${quoteIdentifier(table.name)} WHERE tenant_id = ? AND ${delWhere.join(" AND ")}`,
      delParams,
    ).catch(() => ({ affectedRows: 0 }));
  }
  const existing = overwrite
    ? []
    : await tenantSelect<RowDataPacket>({ slug, table: "staff_availability", where: "kind IN ('turno','presenza') AND starts_at >= ? AND starts_at < ?", params: [`${target.start} 00:00:00`, `${target.end} 00:00:00`], orderBy: "" }).catch(() => [] as RowDataPacket[]);
  const existingKeys = new Set(existing.map((r) => `${Number(r.staff_id)}|${String(r.kind)}|${dateTimeString(r.starts_at)}|${dateTimeString(r.ends_at)}`));

  // Rimappa le serie a nuovi uid, coerenti per serie di origine.
  const seriesMap = new Map<string, string>();
  const offsetDays = Math.round((new Date(`${target.start}T12:00:00`).getTime() - new Date(`${source.start}T12:00:00`).getTime()) / 86400000);
  let copied = 0;
  for (const row of rows) {
    const starts = dateTimeString(row.starts_at);
    const ends = dateTimeString(row.ends_at);
    const newStart = `${addDays(starts.slice(0, 10), offsetDays)} ${starts.slice(11, 19)}`;
    const newEnd = `${addDays(ends.slice(0, 10), offsetDays)} ${ends.slice(11, 19)}`;
    const key = `${Number(row.staff_id)}|${String(row.kind)}|${newStart}|${newEnd}`;
    if (existingKeys.has(key)) continue;
    const srcSeries = String(row.series_uid ?? "");
    let newSeries: string | null = null;
    if (srcSeries) {
      if (!seriesMap.has(srcSeries)) seriesMap.set(srcSeries, randomSeriesUid());
      newSeries = seriesMap.get(srcSeries) ?? null;
    }
    await tenantInsert(table, await filterColumns(table.name, {
      staff_id: Number(row.staff_id),
      location_id: hasLocation ? (row.location_id ?? null) : undefined,
      kind: String(row.kind),
      starts_at: newStart,
      ends_at: newEnd,
      series_uid: newSeries,
    }));
    copied += 1;
  }
  const events = await listStaffAvailability(slug, locationId, target.start, target.end);
  if (copied === 0) return { message: "Nessun evento copiato (già presenti)", events };
  return { message: `Settimana duplicata: ${copied} eventi`, events };
}

// VERIFICA CONFLITTI APPUNTAMENTI (staff_availability.php do=check_appt_conflicts
// ~436-720): avviso NON bloccante — appuntamenti pending/scheduled dell'operatore
// che si sovrappongono alle occorrenze del nuovo evento.
export async function checkAvailabilityConflicts(slug: string, body: Record<string, string>): Promise<Array<{ date: string; timeFrom: string; timeTo: string; client: string; service: string }>> {
  const staffId = parseInteger(body.staff_id ?? body.staffId, 0);
  const startDate = normalizeDate(body.date_from ?? body.dateFrom);
  const endDate = normalizeDate(body.date_to ?? body.dateTo) || startDate;
  const timeFrom = normalizeTime(body.time_from ?? body.timeFrom);
  const timeTo = normalizeTime(body.time_to ?? body.timeTo);
  if (staffId <= 0 || !startDate || !timeFrom || !timeTo) return [];
  const type = normalizeAvailabilityType(body.event_type ?? body.type ?? "turno");
  const repeat = String(body.repeat ?? "none");
  const occDates = repeat === "none" && !["turno", "presenza"].includes(type)
    ? datesBetween(startDate, endDate ?? startDate)
    : repeat === "none"
      ? [startDate]
      : occurrenceDates(startDate, repeat, normalizeDate(body.repeat_until ?? body.repeatUntil), parseIdList(body.dows));
  if (!occDates.length) return [];

  const apptTable = await tenantTable(slug, "appointments");
  const clientsTable = await tenantTable(slug, "clients");
  const staffLinkTable = await tenantTable(slug, "appointment_staff").catch(() => null);
  // L'operatore vive sul bridge appointment_staff (appointments non ha
  // staff_id in questo schema); la colonna diretta è usata solo se esiste.
  const hasDirectStaff = await columnExists(apptTable.name, "staff_id");
  if (!staffLinkTable && !hasDirectStaff) return [];
  const out: Array<{ date: string; timeFrom: string; timeTo: string; client: string; service: string }> = [];
  for (const date of occDates.slice(0, 62)) {
    const from = `${date} ${timeFrom}:00`;
    const to = `${date} ${timeTo}:00`;
    const staffJoin = staffLinkTable ? `LEFT JOIN ${quoteIdentifier(staffLinkTable.name)} ast ON ast.appointment_id = a.id AND ast.tenant_id = a.tenant_id` : "";
    const conds: string[] = [];
    const condParams: unknown[] = [];
    if (hasDirectStaff) { conds.push("a.staff_id = ?"); condParams.push(staffId); }
    if (staffLinkTable) { conds.push("ast.staff_id = ?"); condParams.push(staffId); }
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT a.id, a.starts_at, a.ends_at, c.full_name AS client_name
         FROM ${quoteIdentifier(apptTable.name)} a
         ${staffJoin}
         LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND LOWER(TRIM(COALESCE(a.status,''))) IN ('pending','scheduled')
          AND (${conds.join(" OR ")})
          AND a.starts_at < ? AND a.ends_at > ?
        ORDER BY a.starts_at ASC`,
      [apptTable.tenantId ?? 0, ...condParams, to, from],
    ).catch(() => [] as RowDataPacket[]);
    for (const r of rows) {
      const s = dateTimeString(r.starts_at);
      const e = dateTimeString(r.ends_at);
      out.push({ date, timeFrom: s.slice(11, 16), timeTo: e.slice(11, 16), client: String(r.client_name ?? "") || "—", service: "" });
    }
  }
  return out;
}

export async function deleteAvailabilityEvent(slug: string, body: Record<string, string>): Promise<StaffAvailabilityEvent[]> {
  const id = parseInteger(body.id, 0);
  const tableName = String(body.table ?? body.event_table ?? "availability") === "timeoff" ? "staff_timeoff" : "staff_availability";
  const locationId = parseInteger(body.location_id ?? body.locationId, 0);
  const date = normalizeDate(body.date ?? body.date_from) || todayIsoLocal();
  if (id <= 0) throw new Error("Evento non valido.");
  if (tableName === "staff_availability" && truthy(body.apply_series ?? body.applySeries)) {
    const row = await tenantSelect<RowDataPacket>({ slug, table: "staff_availability", columns: "series_uid", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
    const series = String(row[0]?.series_uid ?? "");
    if (series) await deleteByColumn(slug, "staff_availability", "series_uid", series);
    else await tenantDelete({ slug, table: "staff_availability", id });
  } else {
    await tenantDelete({ slug, table: tableName, id });
  }
  const range = weekRange(date);
  return listStaffAvailability(slug, locationId, range.start, range.end);
}

async function listLocations(slug: string): Promise<ResourceLocation[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", orderBy: "is_active DESC, sort_order ASC, id ASC" }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? `Sede #${row.id ?? ""}`).trim(),
    isActive: Number(row.is_active ?? 1) === 1,
  })).filter((item) => item.id > 0);
}

async function listServices(slug: string): Promise<ResourceService[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "*", orderBy: "is_active DESC, name ASC, id ASC" }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? `Servizio #${row.id ?? ""}`).trim(),
    isActive: Number(row.is_active ?? 1) === 1,
  })).filter((item) => item.id > 0);
}

async function listResources(slug: string, activeLocationId: number, locations: ResourceLocation[]): Promise<SharedResource[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "resources", orderBy: "name ASC, id ASC" }).catch(() => []);
  const ids = rows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const [locationMap, serviceMap] = await Promise.all([resourceLocations(slug, ids, locations), resourceServiceLinks(slug, ids)]);
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    const configs = locationMap.get(id) ?? defaultResourceLocations(locations, Number(row.qty_total ?? 1));
    return {
      id,
      name: String(row.name ?? ""),
      description: String(row.description ?? ""),
      qtyTotal: Number(row.qty_total ?? 0),
      locations: configs,
      serviceLinks: serviceMap.get(id) ?? [],
    };
  }).filter((item) => item.id > 0 && (!activeLocationId || item.locations.length === 0 || item.locations.some((loc) => loc.locationId === activeLocationId && loc.isEnabled)));
}

async function listCabins(slug: string, activeLocationId: number, locations: ResourceLocation[]): Promise<ResourceCabin[]> {
  // cabin_fetch_active_rows: con sede attiva le cabine location NULL (condivise)
  // ordinano per ULTIME — chiave (location_id IS NULL) ASC (cabins.php 105).
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    where: activeLocationId ? "COALESCE(is_active,1)=1 AND (location_id = ? OR location_id IS NULL)" : "COALESCE(is_active,1)=1",
    params: activeLocationId ? [activeLocationId] : [],
    orderBy: activeLocationId ? "(location_id IS NULL) ASC, position ASC, id ASC" : "position ASC, id ASC",
  }).catch(() => []);
  const serviceMap = await cabinServiceLinks(slug, rows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0));
  const out: ResourceCabin[] = [];
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    if (!(id > 0)) continue;
    const locationId = nullableNumber(row.location_id);
    out.push({
      id,
      name: String(row.name ?? ""),
      position: Number(row.position ?? 0),
      isActive: Number(row.is_active ?? 1) === 1,
      locationId,
      locationName: locationName(locations, locationId),
      serviceLinks: serviceMap.get(id) ?? [],
      // Blocchi legacy per il popup della riga (cabins.php initialCabins[].services).
      blockers: await cabinDeleteBlockersLegacy(slug, id, String(row.name ?? "")),
    });
  }
  return out;
}

async function listStaff(slug: string, activeLocationId: number, locations: ResourceLocation[]): Promise<ResourceStaff[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", orderBy: "created_at DESC, id DESC" }).catch(() => []);
  const filtered = rows.filter((row) => String(row.full_name ?? "").trim().toUpperCase() !== "SSO");
  const staffIds = filtered.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const [locationsMap, serviceMap, users] = await Promise.all([
    staffLocations(slug, staffIds),
    staffServiceLinks(slug, staffIds),
    tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id,name,email,role", orderBy: "id ASC" }).catch(() => []),
  ]);
  const usersByEmail = new Map(users.map((row) => [normalizeEmail(row.email ?? ""), row]));
  // Owner = primo utente del tenant con ruolo admin (equivalente PG di users.id=1).
  const firstUser = users[0];
  const ownerUserId = firstUser && String(firstUser.role ?? "") === "admin" ? Number(firstUser.id ?? 0) : 0;
  return filtered.map((row, index) => {
    const id = Number(row.id ?? 0);
    const email = normalizeEmail(row.email ?? "");
    const user = email ? usersByEmail.get(email) : null;
    const locationIds = locationsMap.get(id) ?? [];
    const resolvedLocations = locationIds.length ? locations.filter((location) => locationIds.includes(location.id)) : locations;
    return {
      id,
      fullName: String(row.full_name ?? ""),
      phone: String(row.phone ?? ""),
      email,
      role: normalizeRole(user?.role),
      isActive: Number(row.is_active ?? 1) === 1,
      color: normalizeColor(row.calendar_color, index),
      photoPath: String(row.photo_path ?? ""),
      locationIds,
      locations: resolvedLocations,
      serviceLinks: serviceMap.get(id) ?? [],
      isOwner: ownerUserId > 0 && Number(user?.id ?? 0) === ownerUserId && String(user?.role ?? "") === "admin",
    };
  // app_filter_ids_by_location (Helpers.php 1058-1085, variante staff): passa
  // SOLO chi ha la riga staff_locations per la sede — un operatore senza sedi
  // assegnate NON compare con un filtro sede attivo (a differenza dei servizi,
  // dove i non-ristretti passano: il return legacy usa solo $allowed).
  }).filter((item) => item.id > 0 && (!activeLocationId || item.locationIds.includes(activeLocationId)));
}

async function listBusinessHours(slug: string, locationId: number): Promise<BusinessHourRow[]> {
  // Ordering (faithful to hours.php "ORDER BY dow ASC, (location_id IS NULL) DESC"):
  // the global NULL row comes FIRST so the per-location row, coming last, WINS in the
  // byDow map below. NB: a plain "location_id ASC" is NOT equivalent on Postgres —
  // NULLs sort LAST in ASC (MySQL sorts them first), which made the global row
  // silently override the per-location one on read.
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours",
    where: locationId ? "location_id IS NULL OR location_id = ?" : "",
    params: locationId ? [locationId] : [],
    orderBy: "dow ASC, (location_id IS NULL) DESC, id ASC",
  }).catch(() => []);
  const byDow = new Map<number, RowDataPacket>();
  for (const row of rows) byDow.set(Number(row.dow ?? 0), row);
  // Fallback = ensure_default_hours legacy: Domenica chiusa, Sabato 09-13,
  // gli altri giorni 09-19.
  return Array.from({ length: 7 }, (_, dow) => mapHourRow(byDow.get(dow) ?? (dow === 0
    ? { dow, is_closed: 1 }
    : { dow, is_closed: 0, opens: "09:00", closes: dow === 6 ? "13:00" : "19:00" })));
}

async function listClosureRanges(slug: string, locationId: number): Promise<CalendarDateRange[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "closures",
    where: locationId ? "location_id = ?" : "",
    params: locationId ? [locationId] : [],
    orderBy: "date DESC",
    limit: 400,
  }).catch(() => []);
  return groupDateRanges(rows.map((row) => ({ id: Number(row.id ?? 0), date: normalizeDate(row.date) || "", reason: String(row.reason ?? "") })));
}

async function listExceptionRanges(slug: string, locationId: number): Promise<CalendarExceptionRange[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours_exceptions",
    where: locationId ? "location_id = ? AND COALESCE(is_closed,0)=0" : "COALESCE(is_closed,0)=0",
    params: locationId ? [locationId] : [],
    orderBy: "date DESC",
    limit: 400,
  }).catch(() => []);
  return groupExceptionRanges(rows);
}

async function listStaffAvailability(slug: string, locationId: number, start: string, end: string): Promise<StaffAvailabilityEvent[]> {
  const staff = await listStaff(slug, locationId, await listLocations(slug));
  const names = new Map(staff.map((item) => [item.id, item.fullName]));
  const availabilityRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_availability",
    where: locationId ? "(location_id = ? OR location_id IS NULL) AND starts_at < ? AND ends_at > ?" : "starts_at < ? AND ends_at > ?",
    params: locationId ? [locationId, end, start] : [end, start],
    orderBy: "staff_id ASC, starts_at ASC",
  }).catch(() => []);
  const timeoffRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_timeoff",
    where: "starts_at < ? AND ends_at > ?",
    params: [end, start],
    orderBy: "staff_id ASC, starts_at ASC",
  }).catch(() => []);
  return [
    ...availabilityRows.map((row) => mapAvailabilityRow(row, "availability", names)),
    ...timeoffRows.map((row) => mapAvailabilityRow(row, "timeoff", names)),
  ].sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.staffName.localeCompare(right.staffName));
}

async function resourceLocations(slug: string, resourceIds: number[], locations: ResourceLocation[]): Promise<Map<number, SharedResourceLocation[]>> {
  const map = new Map<number, SharedResourceLocation[]>();
  if (!resourceIds.length || !await tenantTable(slug, "resource_locations").then(() => true).catch(() => false)) return map;
  const rows = await selectOwnerRows(slug, "resource_locations", "resource_id", resourceIds);
  for (const row of rows) {
    const resourceId = Number(row.resource_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (!resourceId || !locationId) continue;
    const list = map.get(resourceId) ?? [];
    list.push({
      locationId,
      locationName: locationName(locations, locationId),
      qtyTotal: Number(row.qty_total ?? 0),
      isEnabled: Number(row.is_enabled ?? 1) === 1,
    });
    map.set(resourceId, list);
  }
  return map;
}

async function resourceServiceLinks(slug: string, resourceIds: number[]): Promise<Map<number, LinkedService[]>> {
  return linkedServicesByOwner(slug, "service_resources", "resource_id", resourceIds, "qty_required");
}

async function cabinServiceLinks(slug: string, cabinIds: number[]): Promise<Map<number, LinkedService[]>> {
  return linkedServicesByOwner(slug, "service_cabins", "cabin_id", cabinIds);
}

async function staffServiceLinks(slug: string, staffIds: number[]): Promise<Map<number, LinkedService[]>> {
  return linkedServicesByOwner(slug, "staff_services", "staff_id", staffIds);
}

async function linkedServicesByOwner(slug: string, tableName: string, ownerColumn: string, ownerIds: number[], qtyColumn?: string): Promise<Map<number, LinkedService[]>> {
  const map = new Map<number, LinkedService[]>();
  if (!ownerIds.length || !await tenantTable(slug, tableName).then(() => true).catch(() => false)) return map;
  const [links, services] = await Promise.all([
    selectOwnerRows(slug, tableName, ownerColumn, ownerIds),
    listServices(slug),
  ]);
  const servicesById = new Map(services.map((service) => [service.id, service]));
  for (const row of links) {
    const ownerId = Number(row[ownerColumn] ?? 0);
    const serviceId = Number(row.service_id ?? 0);
    if (!ownerId || !serviceId) continue;
    const service = servicesById.get(serviceId);
    const list = map.get(ownerId) ?? [];
    list.push({
      serviceId,
      serviceName: service?.name ?? `Servizio #${serviceId}`,
      qtyRequired: qtyColumn ? Number(row[qtyColumn] ?? 1) : undefined,
      isActive: service?.isActive ?? true,
    });
    map.set(ownerId, list);
  }
  return map;
}

async function staffLocations(slug: string, staffIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (!staffIds.length || !await tenantTable(slug, "staff_locations").then(() => true).catch(() => false)) return map;
  const rows = await selectOwnerRows(slug, "staff_locations", "staff_id", staffIds);
  for (const row of rows) {
    const staffId = Number(row.staff_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (!staffId || !locationId) continue;
    const list = map.get(staffId) ?? [];
    list.push(locationId);
    map.set(staffId, list);
  }
  return map;
}

async function selectOwnerRows(slug: string, tableName: string, ownerColumn: string, ownerIds: number[]): Promise<RowDataPacket[]> {
  const ids = uniquePositive(ownerIds);
  if (!ids.length) return [];
  const table = await tenantTable(slug, tableName);
  const clauses = [`${quoteIdentifier(ownerColumn)} IN (${ids.map(() => "?").join(",")})`];
  const params: unknown[] = [...ids];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  return dbQuery<RowDataPacket[]>(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
}

async function replaceOwnerLinks(slug: string, tableName: string, ownerColumn: string, ownerId: number, valueColumn: string, values: number[]): Promise<void> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || !ownerId) return;
  await deleteByOwner(slug, tableName, ownerColumn, ownerId);
  for (const value of uniquePositive(values)) {
    await tenantInsert(table, await filterColumns(table.name, { [ownerColumn]: ownerId, [valueColumn]: value })).catch(() => undefined);
  }
}

async function deleteByOwner(slug: string, tableName: string, ownerColumn: string, ownerId: number): Promise<void> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || !ownerId) return;
  const clauses = [`${quoteIdentifier(ownerColumn)} = ?`];
  const params: unknown[] = [ownerId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

async function deleteByColumn(slug: string, tableName: string, column: string, value: unknown): Promise<void> {
  const table = await tenantTable(slug, tableName);
  const clauses = [`${quoteIdentifier(column)} = ?`];
  const params: unknown[] = [value];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
}

async function saveResourceLocations(slug: string, resourceId: number, configs: Array<Partial<SharedResourceLocation>>, fallbackQty: number): Promise<void> {
  const table = await tenantTable(slug, "resource_locations").catch(() => null);
  if (!table || !configs.length) return;
  await deleteByOwner(slug, "resource_locations", "resource_id", resourceId);
  for (const config of configs) {
    const locationId = Number(config.locationId ?? 0);
    if (!locationId) continue;
    await tenantInsert(table, await filterColumns(table.name, {
      resource_id: resourceId,
      location_id: locationId,
      // La qty postata resta com'è (anche 0, sede disattiva); il fallback alla
      // qty globale vale solo quando il campo manca del tutto (legacy 190).
      qty_total: config.qtyTotal === undefined || config.qtyTotal === null ? fallbackQty : clampInt(config.qtyTotal, 0, 1_000_000),
      is_enabled: truthy(config.isEnabled) ? 1 : 0,
    }));
  }
}

// Guardie riduzione quantità legacy (resources.php 406-469): SOLO le riduzioni
// vengono verificate (newQty < oldQty), per sede quando c'è la config sedi.
// Gli errori portano il payload del popup #resourceBlockModal (session flash).
async function ensureResourceQtyCanChange(slug: string, resourceId: number, qtyTotal: number, configs: Array<Partial<SharedResourceLocation>>, oldQtyTotal: number): Promise<void> {
  const allLinks = (await resourceServiceLinks(slug, [resourceId])).get(resourceId) ?? [];
  const popupServices = (list: LinkedService[]) => list.map((l) => ({ service_name: l.serviceName, qty_required: Math.max(1, Number(l.qtyRequired ?? 1) || 1) }));
  const oldQty = Math.max(0, oldQtyTotal);

  if (configs.length) {
    const oldRows = await resourceLocations(slug, [resourceId], await listLocations(slug));
    const oldByLocation = new Map((oldRows.get(resourceId) ?? []).map((row) => [row.locationId, row]));
    for (const config of configs) {
      const locationId = Number(config.locationId ?? 0);
      if (!locationId) continue;
      const newLocQty = truthy(config.isEnabled) ? clampInt(config.qtyTotal, 0, 1_000_000) : 0;
      const oldRow = oldByLocation.get(locationId);
      const oldLocQty = oldRow ? (oldRow.isEnabled ? Math.max(0, oldRow.qtyTotal) : 0) : oldQty;
      if (newLocQty >= oldLocQty) continue;

      const locName = String(config.locationName ?? "").trim() || (await listLocations(slug)).find((l) => l.id === locationId)?.name || `Sede #${locationId}`;
      const locLinks = await filterLinksByServiceLocation(slug, allLinks, locationId);
      const blocking = locLinks.filter((l) => Math.max(1, Number(l.qtyRequired ?? 1) || 1) > newLocQty);
      if (blocking.length) {
        throw resourceBlockError("Quantita non aggiornata: risorsa ancora utilizzata nei servizi della sede.", {
          title: "Quantita non modificabile",
          message: `La nuova quantita per ${locName} non puo essere salvata perche una o piu unita sono ancora utilizzate nei servizi collegati a questa sede.`,
          services: popupServices(blocking),
        });
      }

      const peak = await resourceFuturePeakUsage(slug, resourceId, locationId);
      if (peak > newLocQty) {
        throw resourceBlockError("Quantita non aggiornata: prenotazioni esistenti oltre il nuovo limite.", {
          title: "Quantita non modificabile",
          message: `La nuova quantita per ${locName} non puo essere salvata perche le prenotazioni gia presenti usano fino a ${peak} unita contemporaneamente.`,
          services: popupServices(locLinks),
        });
      }
    }
    return;
  }

  // Ramo senza config sedi (resources.php 445-469).
  if (qtyTotal >= oldQty) return;
  const blocking = allLinks.filter((l) => Math.max(1, Number(l.qtyRequired ?? 1) || 1) > qtyTotal);
  if (blocking.length) {
    throw resourceBlockError("Quantità non aggiornata: risorsa ancora utilizzata nei servizi.", {
      title: "Quantità non modificabile",
      message: "La nuova quantità non può essere salvata perché una o più unità sono ancora utilizzate nei servizi collegati. Scala la risorsa dal servizio e rendila disponibile prima di modificare la quantità.",
      services: popupServices(blocking),
    });
  }
  const peak = await resourceFuturePeakUsage(slug, resourceId, 0);
  if (peak > qtyTotal) {
    throw resourceBlockError("Quantita non aggiornata: prenotazioni esistenti oltre il nuovo limite.", {
      title: "Quantita non modificabile",
      message: `La nuova quantita non puo essere salvata perche le prenotazioni gia presenti usano fino a ${peak} unita contemporaneamente.`,
      services: popupServices(allLinks),
    });
  }
}

// app_service_location_allowed: nessuna riga in service_locations = servizio
// valido ovunque; altrimenti valido solo nelle sedi elencate.
async function filterLinksByServiceLocation(slug: string, links: LinkedService[], locationId: number): Promise<LinkedService[]> {
  if (!(locationId > 0) || !links.length) return links;
  const hasTable = await tenantTable(slug, "service_locations").then(() => true).catch(() => false);
  if (!hasTable) return links;
  const out: LinkedService[] = [];
  for (const link of links) {
    const anyRows = await tenantSelect<RowDataPacket>({ slug, table: "service_locations", columns: "location_id", where: "service_id = ?", params: [link.serviceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (!anyRows[0]) { out.push(link); continue; }
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "service_locations", columns: "location_id", where: "service_id = ? AND location_id = ?", params: [link.serviceId, locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (rows[0]) out.push(link);
  }
  return out;
}

// Picco di unità concorrenti usate dalla risorsa negli appuntamenti futuri
// pending/scheduled (righe servizio dei servizi che la richiedono); con
// locationId > 0 conta solo la sede (resources_resource_peak_usage legacy).
async function resourceFuturePeakUsage(slug: string, resourceId: number, locationId = 0): Promise<number> {
  try {
    const apptTable = await tenantTable(slug, "appointments");
    const asTable = await tenantTable(slug, "appointment_services");
    const srTable = await tenantTable(slug, "service_resources");
    const locationClause = locationId > 0 && (await columnExists(apptTable.name, "location_id")) ? " AND a.location_id = ?" : "";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT a.starts_at, a.ends_at, COALESCE(sr.qty_required, 1) AS units
         FROM ${quoteIdentifier(apptTable.name)} a
         JOIN ${quoteIdentifier(asTable.name)} sv ON sv.appointment_id = a.id AND sv.tenant_id = a.tenant_id
         JOIN ${quoteIdentifier(srTable.name)} sr ON sr.service_id = sv.service_id AND sr.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND sr.resource_id = ? AND a.ends_at >= NOW()
          AND LOWER(TRIM(COALESCE(a.status,''))) IN ('pending','scheduled')${locationClause}`,
      locationClause ? [apptTable.tenantId ?? 0, resourceId, locationId] : [apptTable.tenantId ?? 0, resourceId],
    );
    const blocks = rows
      .map((r) => ({
        start: new Date(dateTimeString(r.starts_at).replace(" ", "T")).getTime(),
        end: new Date(dateTimeString(r.ends_at).replace(" ", "T")).getTime(),
        units: Math.max(1, Number(r.units ?? 1) || 1),
      }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
    let peak = 0;
    for (const b of blocks) {
      const used = blocks.filter((x) => x.start <= b.start && x.end > b.start).reduce((s, x) => s + x.units, 0);
      peak = Math.max(peak, used);
    }
    return peak;
  } catch {
    return 0;
  }
}

// (Le vecchie cabinBlockers/futureCabinAppointmentCount — pseudo-voce
// 'N prenotazioni future' — sono state rimosse: superate dal port fedele
// cabinDeleteBlockersLegacy con le voci block_kind='appointment' del legacy.)

// Owner del tenant: nel legacy per-tenant è users.id=1 (primo utente creato,
// staff.php 560-561); nello schema PG condiviso gli id sono globali, quindi
// l'equivalente è il PRIMO utente del tenant (MIN(id)) con ruolo admin.
async function tenantOwnerUserId(slug: string): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id, role", orderBy: "id ASC", limit: 1 }).catch(() => []);
  return rows[0] && String(rows[0].role ?? "") === "admin" ? Number(rows[0].id ?? 0) : 0;
}

async function staffRowWithUser(slug: string, staffId: number): Promise<RowDataPacket | null> {
  const staffRows = await tenantSelect<RowDataPacket>({ slug, table: "staff", where: "id = ?", params: [staffId], limit: 1 }).catch(() => []);
  const row = staffRows[0];
  if (!row) return null;
  const email = normalizeEmail(row.email ?? "");
  if (!email) return row;
  const userRows = await tenantSelect<RowDataPacket>({ slug, table: "users", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => []);
  return { ...row, user_id: userRows[0]?.id, user_role: userRows[0]?.role };
}

async function ensureStaffEmailAvailable(slug: string, email: string, currentStaffId: number): Promise<void> {
  // 'Email già utilizzata' arriva come ?msg= nel legacy (staff.php 892-955).
  if (await staffEmailUsed(slug, email, currentStaffId)) throw staffFlashError("Email già utilizzata", "msg");
  const old = currentStaffId > 0 ? await staffRowWithUser(slug, currentStaffId) : null;
  const oldUserId = Number(old?.user_id ?? 0);
  const users = await tenantSelect<RowDataPacket>({ slug, table: "users", where: "LOWER(email) = ?", params: [email], limit: 1 }).catch(() => []);
  const existingUserId = Number(users[0]?.id ?? 0);
  if (existingUserId > 0 && existingUserId !== oldUserId) throw staffFlashError("Email già utilizzata", "msg");
}

async function staffEmailUsed(slug: string, email: string, currentStaffId: number): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id",
    where: "LOWER(email) = ? AND id <> ? AND full_name <> 'SSO'",
    params: [email, currentStaffId],
    limit: 1,
  }).catch(() => []);
  return rows.length > 0;
}

async function upsertStaffLoginUser(slug: string, input: { staffId: number; fullName: string; email: string; role: string; password: string; oldLoginUserId: number }): Promise<void> {
  const users = await tenantTable(slug, "users");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id,email", where: "LOWER(email) = ?", params: [input.email], limit: 1 }).catch(() => []);
  const values: Record<string, unknown> = { name: input.fullName, email: input.email, role: input.role };
  if (input.password) values.password_hash = await bcrypt.hash(input.password, 10);
  if (existing[0]?.id) {
    await tenantUpdate({ slug, table: "users", id: Number(existing[0].id), values: await filterColumns(users.name, values) });
    return;
  }

  // Cambio email (staff.php 970-998): l'account trovato sotto la VECCHIA email
  // (risolto dal chiamante PRIMA delle scritture) viene aggiornato alla nuova
  // con email_verified_at azzerata — nessuna password richiesta.
  if (input.oldLoginUserId > 0) {
    await tenantUpdate({ slug, table: "users", id: input.oldLoginUserId, values: await filterColumns(users.name, { ...values, email_verified_at: null }) });
    return;
  }

  if (!input.password) throw new Error("Password obbligatoria per creare l'account login dell'operatore.");
  await tenantInsert(users, await filterColumns(users.name, { ...values, email_verified_at: null }));
}

// staff.php 999-1004: email svuotata in edit -> l'account login (risolto dal
// chiamante con l'email PRE-write) viene eliminato con le verifiche email e le
// user_locations. L'owner (primo admin del tenant, equivalente PG di users.id=1)
// non è raggiungibile qui (email obbligatoria), ma la guardia resta per sicurezza.
async function deleteLoginUserForStaffWithoutEmail(slug: string, userId: number): Promise<void> {
  if (userId <= 0) return;
  const ownerUserId = await tenantOwnerUserId(slug);
  if (ownerUserId > 0 && userId === ownerUserId) return;
  await deleteByOwner(slug, "user_email_verifications", "user_id", userId);
  await deleteByOwner(slug, "user_locations", "user_id", userId);
  await tenantDelete({ slug, table: "users", id: userId }).catch(() => undefined);
}

// Scope tenant per le query manuali (tabelle shared).
function tenantClause(table: Awaited<ReturnType<typeof tenantTable>>): { sql: string; params: unknown[] } {
  if (table.mode === "shared") return { sql: " AND tenant_id = ?", params: [table.tenantId ?? 0] };
  return { sql: "", params: [] };
}

// staff_operator_appointment_refs con filtro sedi (staff.php 347-398).
async function staffHasOpenAppointmentsInLocations(slug: string, staffId: number, locationIds: number[]): Promise<boolean> {
  const appointments = await tenantTable(slug, "appointments").catch(() => null);
  if (!appointments || !locationIds.length || !await columnExists(appointments.name, "location_id")) {
    return staffHasAppointmentRefs(slug, staffId, true);
  }
  const checks: string[] = [];
  const params: unknown[] = [];
  const segments = await tenantTable(slug, "appointment_segments").catch(() => null);
  if (segments && await columnExists(segments.name, "staff_id")) {
    checks.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(segments.name)} sg WHERE sg.appointment_id=a.id AND sg.staff_id=?)`);
    params.push(staffId);
  }
  const appointmentStaff = await tenantTable(slug, "appointment_staff").catch(() => null);
  if (appointmentStaff && await columnExists(appointmentStaff.name, "staff_id")) {
    checks.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(appointmentStaff.name)} ast WHERE ast.appointment_id=a.id AND ast.staff_id=?)`);
    params.push(staffId);
  }
  if (!checks.length) return false;
  const clauses = [`(${checks.join(" OR ")})`, "a.status IN ('pending','scheduled')", `a.location_id IN (${locationIds.map(() => "?").join(",")})`];
  params.push(...locationIds);
  if (appointments.mode === "shared" && await columnExists(appointments.name, "tenant_id")) {
    clauses.unshift("a.tenant_id = ?");
    params.unshift(appointments.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT a.id FROM ${quoteIdentifier(appointments.name)} a WHERE ${clauses.join(" AND ")} LIMIT 1`, params).catch(() => []);
  return rows.length > 0;
}

// staff_service_location_blockers (staff.php 401-477): servizi ATTIVI con
// operatore che nella sede resterebbero senza ALTRI operatori abilitati.
async function staffServiceLocationBlockers(slug: string, staffId: number, locationIds: number[], allLocations: ResourceLocation[]): Promise<Array<{ serviceId: number; serviceName: string; locationId: number; locationName: string }>> {
  const out: Array<{ serviceId: number; serviceName: string; locationId: number; locationName: string }> = [];
  const ids = uniquePositive(locationIds);
  if (!(staffId > 0) || !ids.length) return out;
  const services = await tenantTable(slug, "services").catch(() => null);
  const staffServices = await tenantTable(slug, "staff_services").catch(() => null);
  if (!services || !staffServices) return out;
  const allLocationIds = allLocations.map((location) => location.id);
  const names = new Map(allLocations.map((location) => [location.id, location.name]));
  const hasNoOperator = await columnExists(services.name, "no_operator");

  const svcScope = tenantClause(staffServices);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT DISTINCT s.id, s.name, COALESCE(s.is_active,1) AS is_active${hasNoOperator ? ", COALESCE(s.no_operator,0) AS no_operator" : ", 0 AS no_operator"}
       FROM ${quoteIdentifier(staffServices.name)} ss
       JOIN ${quoteIdentifier(services.name)} s ON s.id = ss.service_id
      WHERE ss.staff_id = ?${svcScope.sql.replace(" AND ", " AND ss.")}
      ORDER BY s.name ASC, s.id ASC`,
    [staffId, ...svcScope.params],
  ).catch(() => [] as RowDataPacket[]);

  for (const svc of rows) {
    const serviceId = Number(svc.id ?? 0);
    if (!(serviceId > 0) || Number(svc.is_active ?? 1) !== 1 || Number(svc.no_operator ?? 0) === 1) continue;

    // Sedi effettive del servizio (service_locations; vuoto = tutte).
    let serviceLocationIds: number[] = [];
    const serviceLocations = await tenantTable(slug, "service_locations").catch(() => null);
    if (serviceLocations) {
      const locRows = await tenantSelect<RowDataPacket>({ slug, table: "service_locations", columns: "location_id", where: "service_id = ?", params: [serviceId] }).catch(() => []);
      serviceLocationIds = uniquePositive(locRows.map((row) => Number(row.location_id ?? 0)));
    }
    const effective = serviceLocationIds.length ? serviceLocationIds : allLocationIds;

    for (const locationId of ids) {
      if (!effective.includes(locationId)) continue;
      // Altri operatori ATTIVI abilitati al servizio e alla sede.
      const others = await dbQuery<RowDataPacket[]>(
        `SELECT st.id FROM ${quoteIdentifier(staffServices.name)} ss
           JOIN ${quoteIdentifier((await tenantTable(slug, "staff")).name)} st ON st.id = ss.staff_id
          WHERE ss.service_id = ? AND st.id <> ? AND COALESCE(st.is_active,1) = 1 AND st.full_name <> 'SSO'${svcScope.sql.replace(" AND ", " AND ss.")}`,
        [serviceId, staffId, ...svcScope.params],
      ).catch(() => [] as RowDataPacket[]);
      let otherIds = uniquePositive(others.map((row) => Number(row.id ?? 0)));
      if (otherIds.length) {
        // app_filter_staff_ids_by_location: operatore valido nella sede se ha la riga.
        const staffLocationRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "staff_locations",
          columns: "staff_id",
          where: `location_id = ? AND staff_id IN (${otherIds.map(() => "?").join(",")})`,
          params: [locationId, ...otherIds],
        }).catch(() => []);
        otherIds = uniquePositive(staffLocationRows.map((row) => Number(row.staff_id ?? 0)));
      }
      if (otherIds.length) continue;
      out.push({ serviceId, serviceName: String(svc.name ?? `Servizio #${serviceId}`), locationId, locationName: names.get(locationId) ?? `Sede #${locationId}` });
    }
  }
  return out;
}

async function ensureStaffAvailableForLocation(slug: string, staffId: number, locationId: number): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "id,is_active,full_name", where: "id = ? AND COALESCE(is_active,1)=1", params: [staffId], limit: 1 }).catch(() => []);
  if (!rows[0] || String(rows[0].full_name ?? "").toUpperCase() === "SSO") throw new Error("Operatore non valido.");
  if (locationId <= 0 || !await tenantTable(slug, "staff_locations").then(() => true).catch(() => false)) return;
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "staff_locations", columns: "location_id", where: "staff_id = ?", params: [staffId] }).catch(() => []);
  if (locRows.length && !locRows.some((row) => Number(row.location_id ?? 0) === locationId)) throw new Error("Operatore non abilitato nella sede selezionata.");
}

async function staffHasAppointmentRefs(slug: string, staffId: number, openOnly: boolean): Promise<boolean> {
  const appointments = await tenantTable(slug, "appointments").catch(() => null);
  if (!appointments) return false;
  const checks: string[] = [];
  const params: unknown[] = [];
  const segments = await tenantTable(slug, "appointment_segments").catch(() => null);
  if (segments && await columnExists(segments.name, "staff_id")) {
    checks.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(segments.name)} sg WHERE sg.appointment_id=a.id AND sg.staff_id=?)`);
    params.push(staffId);
  }
  const appointmentStaff = await tenantTable(slug, "appointment_staff").catch(() => null);
  if (appointmentStaff && await columnExists(appointmentStaff.name, "staff_id")) {
    checks.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(appointmentStaff.name)} ast WHERE ast.appointment_id=a.id AND ast.staff_id=?)`);
    params.push(staffId);
  }
  if (!checks.length) return false;
  const clauses = [`(${checks.join(" OR ")})`];
  if (openOnly && await columnExists(appointments.name, "status")) clauses.push("LOWER(COALESCE(a.status,'')) IN ('pending','scheduled','in sospeso','prenotato')");
  if (appointments.mode === "shared" && await columnExists(appointments.name, "tenant_id")) {
    clauses.unshift("a.tenant_id = ?");
    params.unshift(appointments.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT a.id FROM ${quoteIdentifier(appointments.name)} a WHERE ${clauses.join(" AND ")} LIMIT 1`, params).catch(() => []);
  return rows.length > 0;
}

async function staffHasCommissionHistory(slug: string, staffId: number): Promise<boolean> {
  if (!await tenantTable(slug, "staff_commission_payments").then(() => true).catch(() => false)) return false;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff_commission_payments", columns: "id", where: "staff_id = ?", params: [staffId], limit: 1 }).catch(() => []);
  return rows.length > 0;
}

async function activeAppointmentDates(slug: string, locationId: number, from: string, to: string): Promise<string[]> {
  const appointments = await tenantTable(slug, "appointments").catch(() => null);
  if (!appointments || !await columnExists(appointments.name, "starts_at") || !await columnExists(appointments.name, "ends_at")) return [];
  const clauses = ["starts_at < ?", "ends_at > ?"];
  const params: unknown[] = [addDays(to, 1) + " 00:00:00", `${from} 00:00:00`];
  if (await columnExists(appointments.name, "status")) clauses.push("LOWER(COALESCE(status,'')) IN ('pending','scheduled','in sospeso','prenotato')");
  if (locationId && await columnExists(appointments.name, "location_id")) {
    clauses.push("(location_id = ? OR location_id IS NULL)");
    params.push(locationId);
  }
  if (appointments.mode === "shared" && await columnExists(appointments.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(appointments.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT starts_at,ends_at FROM ${quoteIdentifier(appointments.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => []);
  const set = new Set<string>();
  for (const row of rows) {
    const start = normalizeDate(row.starts_at);
    const end = normalizeDate(row.ends_at) || start;
    if (!start) continue;
    for (const date of datesBetween(maxDate(start, from), minDate(end, to))) set.add(date);
  }
  return Array.from(set).sort();
}

async function closureDatesInRange(slug: string, locationId: number, from: string, to: string): Promise<string[]> {
  return datesInTable(slug, "closures", locationId, from, to);
}

async function exceptionDatesInRange(slug: string, locationId: number, from: string, to: string): Promise<string[]> {
  return datesInTable(slug, "business_hours_exceptions", locationId, from, to, "COALESCE(is_closed,0)=0");
}

async function datesInTable(slug: string, tableName: string, locationId: number, from: string, to: string, extraWhere = ""): Promise<string[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: tableName,
    columns: "date",
    where: [`(location_id = ? OR location_id IS NULL)`, "date BETWEEN ? AND ?", extraWhere].filter(Boolean).join(" AND "),
    params: [locationId, from, to],
    orderBy: "date ASC",
  }).catch(() => []);
  return rows.map((row) => normalizeDate(row.date)).filter(Boolean);
}

async function deleteDateRange(slug: string, tableName: string, locationId: number, from: string, to: string, reason?: string): Promise<void> {
  const table = await tenantTable(slug, tableName);
  const clauses = ["location_id = ?", "date BETWEEN ? AND ?"];
  const params: unknown[] = [locationId, from, to];
  if (reason !== undefined && reason !== "") {
    clauses.push("(reason = ? OR (reason IS NULL AND ? = ''))");
    params.push(reason, reason);
  }
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
}

async function ensureWithinBusinessHours(slug: string, locationId: number, date: string, from: string, to: string, requireOpen: boolean): Promise<void> {
  if (locationId <= 0) return;
  const intervals = await businessIntervalsForDate(slug, locationId, date);
  if (!intervals.length) {
    if (requireOpen) throw new Error(`Nessun orario di apertura per il giorno ${date} (controlla Orari/Straordinari/Chiusure)`);
    return;
  }
  const fromMin = timeToMinutes(from);
  const toMin = timeToMinutes(to);
  if (fromMin === null || toMin === null || toMin <= fromMin) throw new Error("Gli orari selezionati non sono validi.");
  if (requireOpen) {
    if (intervals.some(([open, close]) => fromMin >= open && toMin <= close)) return;
    throw new Error(`Gli orari devono rientrare in un singolo intervallo di apertura per il giorno ${date}.`);
  }
  const minOpen = Math.min(...intervals.map(([open]) => open));
  const maxClose = Math.max(...intervals.map(([, close]) => close));
  if (fromMin < minOpen || toMin > maxClose) throw new Error(`Gli orari devono essere compresi tra ${minutesToTime(minOpen)} e ${minutesToTime(maxClose)} per il giorno ${date}.`);
}

async function businessIntervalsForDate(slug: string, locationId: number, date: string): Promise<Array<[number, number]>> {
  const closed = await closureDatesInRange(slug, locationId, date, date);
  if (closed.length) return [];
  const exceptionRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours_exceptions",
    where: "(location_id = ? OR location_id IS NULL) AND date = ?",
    params: [locationId, date],
    orderBy: "location_id DESC, id DESC",
    limit: 1,
  }).catch(() => []);
  const exception = exceptionRows[0];
  if (exception) {
    if (Number(exception.is_closed ?? 0) === 1) return [];
    return intervalsFromRow(exception);
  }
  const dow = new Date(`${date}T12:00:00`).getDay();
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "business_hours",
    where: "(location_id = ? OR location_id IS NULL) AND dow = ?",
    params: [locationId, dow],
    orderBy: "location_id DESC, id DESC",
    limit: 1,
  }).catch(() => []);
  const row = rows[0];
  if (!row || Number(row.is_closed ?? 0) === 1) return [];
  return intervalsFromRow(row);
}

function intervalsFromRow(row: RowDataPacket): Array<[number, number]> {
  const pairs = [
    [timeString(row.opens ?? row.open_time), timeString(row.closes ?? row.close_time)],
    [timeString(row.opens2 ?? row.open_time2), timeString(row.closes2 ?? row.close_time2)],
  ];
  const intervals: Array<[number, number]> = [];
  for (const [open, close] of pairs) {
    const openMin = timeToMinutes(open);
    const closeMin = timeToMinutes(close);
    if (openMin !== null && closeMin !== null && closeMin > openMin) intervals.push([openMin, closeMin]);
  }
  return intervals;
}

async function deleteEditedAvailability(slug: string, editTable: string, editId: number, staffId: number, applySeries: boolean): Promise<void> {
  if (editId <= 0) return;
  if (editTable === "availability") {
    if (applySeries) {
      const row = await tenantSelect<RowDataPacket>({ slug, table: "staff_availability", columns: "series_uid", where: "id = ?", params: [editId], limit: 1 }).catch(() => []);
      const series = String(row[0]?.series_uid ?? "");
      if (series) {
        await deleteByColumn(slug, "staff_availability", "series_uid", series);
        return;
      }
    }
    await tenantDelete({ slug, table: "staff_availability", id: editId }).catch(() => undefined);
  }
  if (editTable === "timeoff") {
    await deleteByOwnerId(slug, "staff_timeoff", editId, staffId);
  }
}

async function deleteByOwnerId(slug: string, tableName: string, id: number, staffId: number): Promise<void> {
  const table = await tenantTable(slug, tableName);
  const clauses = ["id = ?", "staff_id = ?"];
  const params: unknown[] = [id, staffId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
}

async function mustFindResource(slug: string, id: number): Promise<SharedResource> {
  const context = await resourceContext({ slug });
  const item = context.resources.find((resource) => resource.id === id);
  if (!item) throw new Error("Risorsa non trovata.");
  return item;
}

async function mustFindStaff(slug: string, id: number): Promise<ResourceStaff> {
  // Lookup per-id SENZA filtro sede: la conferma post-salvataggio deve trovare
  // l'operatore anche se assegnato a una sede diversa da quella corrente/default
  // (altrimenti creando un operatore su Sede2 il re-fetch via resourceContext,
  // filtrato sulla prima sede attiva, falliva con "Operatore non trovato.").
  const item = await getManageStaffMember(slug, id);
  if (!item) throw new Error("Operatore non trovato.");
  return item;
}

async function ensureResourceColumns(slug: string): Promise<void> {
  const [staff, cabins] = await Promise.all([
    tenantTable(slug, "staff").catch(() => null),
    tenantTable(slug, "cabins").catch(() => null),
  ]);
  if (staff) {
    await addColumnIfMissing(staff.name, "calendar_color", "`calendar_color` VARCHAR(16) DEFAULT NULL");
    await addColumnIfMissing(staff.name, "photo_path", "`photo_path` VARCHAR(255) DEFAULT NULL");
  }
  if (cabins) await addColumnIfMissing(cabins.name, "location_id", "`location_id` INTEGER DEFAULT NULL");
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(table, column)) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

function mapHourRow(row: Record<string, unknown>): BusinessHourRow {
  const dow = Number(row.dow ?? 0);
  return {
    id: Number(row.id ?? 0),
    dow,
    dayLabel: dayLabels[dow] ?? `Giorno ${dow}`,
    locationId: nullableNumber(row.location_id),
    opens: timeString(row.opens ?? row.open_time),
    closes: timeString(row.closes ?? row.close_time),
    opens2: timeString(row.opens2 ?? row.open_time2),
    closes2: timeString(row.closes2 ?? row.close_time2),
    isClosed: Number(row.is_closed ?? 0) === 1,
  };
}

function mapAvailabilityRow(row: RowDataPacket, table: "availability" | "timeoff", names: Map<number, string>): StaffAvailabilityEvent {
  const startsAt = dateTimeString(row.starts_at);
  const endsAt = dateTimeString(row.ends_at);
  const staffId = Number(row.staff_id ?? 0);
  return {
    id: Number(row.id ?? 0),
    table,
    staffId,
    staffName: names.get(staffId) ?? `Operatore #${staffId}`,
    type: table === "availability" ? String(row.kind ?? "turno") : String(row.reason ?? "Assenza"),
    startsAt,
    endsAt,
    dateFrom: startsAt.slice(0, 10),
    dateTo: endsAt.slice(0, 10),
    timeFrom: startsAt.slice(11, 16),
    timeTo: endsAt.slice(11, 16),
    locationId: nullableNumber(row.location_id),
    seriesUid: String(row.series_uid ?? ""),
  };
}

// Righe orari come le POSTa il form legacy: SOLO i dow presenti nel payload
// (hours.php itera $_POST['hours']); i valori restano stringhe raw perché la
// validazione legacy distingue "campo vuoto" da "formato non valido".
type PostedHourRow = { dow: number; opens: string; closes: string; opens2: string; closes2: string; is_closed: number };

function parseHoursRows(value: string): PostedHourRow[] {
  const rows = parseJsonArray<Record<string, unknown>>(value);
  // Chiave assoc come $_POST['hours'][dow]: un dow duplicato vince per ultimo.
  const byDow = new Map<number, Record<string, unknown>>();
  for (const row of rows) byDow.set(Math.trunc(Number(row.dow) || 0), row);
  return Array.from(byDow.entries()).map(([dow, row]) => {
    const isClosed = truthy(row.is_closed ?? row.isClosed) ? 1 : 0;
    return {
      dow,
      opens: isClosed ? "" : String(row.opens ?? "").trim(),
      closes: isClosed ? "" : String(row.closes ?? "").trim(),
      opens2: isClosed ? "" : String(row.opens2 ?? "").trim(),
      closes2: isClosed ? "" : String(row.closes2 ?? "").trim(),
      is_closed: isClosed,
    };
  });
}

// _time_to_minutes legacy (hours.php 14-25): PHP (int) sulle parti, quindi
// "aa:bb" vale 00:00; null solo se vuoto, senza ":" o fuori range.
function phpTimeToMinutes(raw: string): number | null {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const parts = value.split(":");
  if (parts.length < 2) return null;
  const hours = phpIntVal(parts[0]);
  const minutes = phpIntVal(parts[1]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function phpIntVal(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Orario da persistere: il legacy salva la stringa raw e lascia normalizzare a
// MySQL; qui canonizziamo in HH:MM (equivalente) per non far fallire il cast PG.
function hourTimeOrNull(raw: string): string | null {
  const minutes = phpTimeToMinutes(raw);
  return minutes === null ? null : minutesToTime(minutes);
}

function isoToDmy(iso: string): string {
  const parts = String(iso ?? "").split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : String(iso ?? "");
}

// hours_format_date_sample (hours.php 27-38): unique+sort, max 6 in d/m/Y,
// " ..." se l'elenco è più lungo.
function dateSampleIt(dates: string[]): string {
  const unique = Array.from(new Set(dates.filter(Boolean))).sort();
  const sample = unique.slice(0, 6);
  return sample.map(isoToDmy).join(", ") + (unique.length > sample.length ? " ..." : "");
}

// Errori di una riga del tab Orari, messaggi e ordine legacy esatti
// (hours.php 161-199); una riga può produrne più di uno.
function hoursRowErrors(row: PostedHourRow): string[] {
  const label = dayLabels[row.dow] ?? `Giorno ${row.dow}`;
  const errors: string[] = [];
  if (row.is_closed) return errors;
  const { opens, closes, opens2, closes2 } = row;
  if (opens === "" || closes === "") {
    errors.push(`${label}: se il giorno non e chiuso devi compilare apertura e chiusura.`);
  } else {
    const open1 = phpTimeToMinutes(opens);
    const close1 = phpTimeToMinutes(closes);
    if (open1 === null || close1 === null) errors.push(`${label}: formato orario non valido.`);
    else if (close1 <= open1) errors.push(`${label}: la chiusura deve essere successiva all'apertura.`);
  }
  if (opens2 !== "" || closes2 !== "") {
    if (opens2 === "" || closes2 === "") {
      errors.push(`${label}: per l'orario spezzato devi compilare sia riapertura sia chiusura 2.`);
    } else if (opens === "" || closes === "") {
      errors.push(`${label}: per l'orario spezzato devi compilare anche apertura e chiusura.`);
    } else {
      const close1 = phpTimeToMinutes(closes);
      const open2 = phpTimeToMinutes(opens2);
      const close2 = phpTimeToMinutes(closes2);
      if (open2 === null || close2 === null || close1 === null) {
        errors.push(`${label}: formato orario spezzato non valido.`);
      } else {
        if (open2 < close1) errors.push(`${label}: la riapertura deve essere uguale o successiva alla chiusura (prima fascia).`);
        if (close2 <= open2) errors.push(`${label}: la chiusura 2 deve essere successiva alla riapertura.`);
      }
    }
  }
  return errors;
}

function groupDateRanges(rows: Array<{ id: number; date: string; reason: string }>): CalendarDateRange[] {
  const sorted = rows.filter((row) => row.date).sort((a, b) => b.date.localeCompare(a.date));
  const out: CalendarDateRange[] = [];
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index];
    const start = first.date;
    let end = first.date;
    const ids = [first.id].filter(Boolean);
    let next = index + 1;
    while (next < sorted.length && sorted[next].reason === first.reason && addDays(sorted[next].date, 1) === end) {
      end = sorted[next].date;
      ids.push(sorted[next].id);
      next++;
    }
    out.push({ start, end, reason: first.reason, ids });
    index = next;
  }
  return out;
}

function groupExceptionRanges(rows: RowDataPacket[]): CalendarExceptionRange[] {
  const normalized = rows.map((row) => ({
    date: normalizeDate(row.date) || "",
    opens: timeString(row.opens ?? row.open_time),
    closes: timeString(row.closes ?? row.close_time),
    opens2: timeString(row.opens2 ?? row.open_time2),
    closes2: timeString(row.closes2 ?? row.close_time2),
    note: String(row.note ?? ""),
  })).filter((row) => row.date).sort((a, b) => b.date.localeCompare(a.date));
  const out: CalendarExceptionRange[] = [];
  let index = 0;
  while (index < normalized.length) {
    const first = normalized[index];
    const start = first.date;
    let end = first.date;
    let next = index + 1;
    while (next < normalized.length && exceptionSignature(normalized[next]) === exceptionSignature(first) && addDays(normalized[next].date, 1) === end) {
      end = normalized[next].date;
      next++;
    }
    out.push({ start, end, opens: first.opens, closes: first.closes, opens2: first.opens2, closes2: first.closes2, note: first.note });
    index = next;
  }
  return out;
}

function exceptionSignature(row: { opens: string; closes: string; opens2: string; closes2: string; note: string }): string {
  return [row.opens, row.closes, row.opens2, row.closes2, row.note].join("|");
}

function occurrenceDates(start: string, repeat: string, repeatUntil: string, dows: number[]): string[] {
  if (repeat === "none") return [start];
  const until = repeatUntil && repeatUntil >= start ? repeatUntil : addDays(start, 28);
  const max = datesBetween(start, until).slice(0, 370);
  const startDow = new Date(`${start}T12:00:00`).getDay();
  const selectedDows = dows.length ? new Set(dows.map((dow) => ((dow % 7) + 7) % 7)) : new Set([startDow]);
  if (repeat === "w1") return max.filter((date) => selectedDows.has(new Date(`${date}T12:00:00`).getDay()));
  if (repeat === "w2") return max.filter((date) => selectedDows.has(new Date(`${date}T12:00:00`).getDay()) && Math.floor(daysDiff(start, date) / 7) % 2 === 0);
  if (repeat === "w3") return max.filter((date) => selectedDows.has(new Date(`${date}T12:00:00`).getDay()) && Math.floor(daysDiff(start, date) / 7) % 3 === 0);
  if (repeat === "m1") {
    const day = Number(start.slice(8, 10));
    return max.filter((date) => Number(date.slice(8, 10)) === day);
  }
  return [start];
}

function defaultResourceLocations(locations: ResourceLocation[], qty: number): SharedResourceLocation[] {
  return locations.map((location) => ({
    locationId: location.id,
    locationName: location.name,
    qtyTotal: Math.max(0, qty),
    isEnabled: true,
  }));
}

function normalizeActiveLocation(value: number | undefined, locations: ResourceLocation[]): number {
  const id = Number(value ?? 0);
  if (id > 0 && locations.some((location) => location.id === id)) return id;
  return locations.find((location) => location.isActive)?.id ?? locations[0]?.id ?? 0;
}

function locationName(locations: ResourceLocation[], id: number | null): string {
  if (!id) return "Tutte";
  return locations.find((location) => location.id === id)?.name ?? `Sede #${id}`;
}

function parseJsonArray<T>(value: unknown): T[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseIdList(value: unknown): number[] {
  if (Array.isArray(value)) return uniquePositive(value.map(Number));
  const raw = String(value ?? "");
  if (!raw) return [];
  return uniquePositive(raw.split(/[,\s]+/).map((item) => Number(item)));
}

function uniquePositive(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.floor(value))));
}

function normalizeRole(value: unknown): "admin" | "staff" | "altro" {
  const role = String(value ?? "staff").trim().toLowerCase();
  return role === "admin" || role === "altro" ? role : "staff";
}

function normalizeAvailabilityType(value: unknown): string {
  const type = String(value ?? "turno").trim().toLowerCase();
  if (["turno", "presenza", "ferie", "malattia", "assenza"].includes(type)) return type;
  return "turno";
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function cleanName(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["1", "true", "yes", "on", "si", "sì"].includes(String(value ?? "").trim().toLowerCase());
}

function normalizeColor(value: unknown, index: number): string {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const palette = ["#0f766e", "#2563eb", "#7c3aed", "#be123c", "#a16207", "#0369a1"];
  return palette[index % palette.length] ?? "#0f766e";
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return dateIsoLocal(value);
  const raw = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const date = new Date(`${raw}T12:00:00`);
  // Round-trip check (hours_parse_ymd legacy): "2026-02-31" NON deve rollare a marzo.
  if (!Number.isFinite(date.getTime()) || dateIsoLocal(date) !== raw) return "";
  return raw;
}

function normalizeTime(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function timeString(value: unknown): string {
  return normalizeTime(value) ?? "";
}

function dateTimeString(value: unknown): string {
  if (value instanceof Date) return mysqlDate(value);
  return String(value ?? "").replace("T", " ").slice(0, 19);
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timeToMinutes(value: string | null): number | null {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function orderedDates(left: string, right: string): [string, string] {
  return left <= right ? [left, right] : [right, left];
}

function datesBetween(from: string, to: string): string[] {
  if (!from || !to) return [];
  const [start, end] = orderedDates(from, to);
  const dates: string[] = [];
  for (let cursor = new Date(`${start}T12:00:00`); dateIsoLocal(cursor) <= end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(dateIsoLocal(cursor));
    if (dates.length > 730) break;
  }
  return dates;
}

function weekRange(date: string): { start: string; end: string } {
  const current = new Date(`${date}T12:00:00`);
  const mondayOffset = (current.getDay() + 6) % 7;
  current.setDate(current.getDate() - mondayOffset);
  const start = dateIsoLocal(current);
  current.setDate(current.getDate() + 7);
  return { start, end: dateIsoLocal(current) };
}

function todayIsoLocal(): string {
  return dateIsoLocal(new Date());
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return dateIsoLocal(next);
}

function daysDiff(from: string, to: string): number {
  return Math.floor((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86400000);
}

function maxDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function minDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function dateIsoLocal(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function mysqlDateTime(date: string, time: string): string {
  return `${date} ${time}:00`;
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function randomSeriesUid(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}
