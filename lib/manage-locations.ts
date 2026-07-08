import "server-only";

import { listDbLocations } from "@/lib/db-repositories";
import { currentManageSession, type ManageSession } from "@/lib/manage-auth";
import { tenantSelect, type RowDataPacket } from "@/lib/tenant-db";

type SourceMode = "database";
type Location = {
  id: number;
  tenantSlug: string;
  slug: string;
  name: string;
  address: string;
  city: string;
  area: string;
  phone: string;
  hoursToday: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
};

export type ManageLocationContext = {
  session: ManageSession | null;
  sourceMode: SourceMode;
  locations: Location[];
  allLocations: Location[];
  currentLocationId: number;
  needsLocationSelection: boolean;
};

export async function getManageLocationContext(
  slug: string,
  options: { bookingOnly?: boolean } = {},
): Promise<ManageLocationContext> {
  const session = await currentManageSession(slug);
  const activeUser = session?.user;
  const allLocationRows = await listDbLocations(slug);
  const allLocations = options.bookingOnly
    ? allLocationRows.filter((location) => location.bookingEnabled)
    : allLocationRows;
  const locations = filterLocationsForManageSession(allLocations, activeUser?.locationIds ?? [], activeUser?.role);
  const currentLocationId = resolveCurrentManageLocationId(session?.user.currentLocationId ?? 0, locations);

  return {
    session,
    sourceMode: "database",
    allLocations,
    locations,
    currentLocationId,
    needsLocationSelection: locations.length > 1 && currentLocationId <= 0,
  };
}

export async function resolveManageLocationId({
  slug,
  raw,
  fallbackCurrent = true,
  bookingOnly = false,
}: {
  slug: string;
  raw?: string | number | null;
  fallbackCurrent?: boolean;
  bookingOnly?: boolean;
}): Promise<number> {
  const context = await getManageLocationContext(slug, { bookingOnly });
  const hasRaw = raw !== null && raw !== undefined && String(raw).trim() !== "";
  const rawId = Number.parseInt(String(raw ?? "0"), 10);

  if (rawId > 0) {
    return context.locations.some((location) => location.id === rawId) ? rawId : 0;
  }

  if (hasRaw) return 0;
  if (fallbackCurrent && context.currentLocationId > 0) return context.currentLocationId;
  return context.locations.length === 1 ? context.locations[0]?.id ?? 0 : 0;
}

export function filterLocationsForManageSession<T extends { id: number }>(
  locations: T[],
  locationIds: number[],
  role?: string,
): T[] {
  if ((role ?? "").toLowerCase() === "admin" || locationIds.length === 0) return locations;
  const allowed = new Set(locationIds);
  return locations.filter((location) => allowed.has(location.id));
}

export function resolveCurrentManageLocationId<T extends { id: number }>(
  currentLocationId: number,
  locations: T[],
): number {
  if (locations.some((location) => location.id === currentLocationId)) return currentLocationId;
  return locations.length === 1 ? locations[0]?.id ?? 0 : 0;
}

// ---- Guardia accesso-record per-SEDE (condivisa) --------------------------------------------
// Un operatore ristretto a un sottoinsieme di sedi non puo' aprire/modificare/eliminare record
// di ALTRE sedi via id diretto. Cardine legacy: app_location_allowed_for_user(loc,user).

// Sedi consentite dell'operatore per il controllo accesso: [] = admin o utente senza restrizioni
// (tutte le sedi); altrimenti le sedi assegnate (session.user.locationIds).
export function sessionAllowedLocationIds(
  session: { user: { role?: string; locationIds?: number[] } } | null,
): number[] {
  if (!session) return [];
  if (String(session.user.role ?? "").toLowerCase() === "admin") return [];
  return session.user.locationIds ?? [];
}

// Regola record: allowedLocationIds vuoto = nessuna restrizione; location_id NULL/0 = accessibile a
// tutti (includeNoLocation legacy); altrimenti deve essere in una sede consentita.
export function locationAllowedForSedi(locationId: number, allowedLocationIds: number[]): boolean {
  const allowed = (allowedLocationIds ?? []).map((n) => Number(n) || 0).filter((n) => n > 0);
  if (allowed.length === 0) return true;
  const loc = Number(locationId) || 0;
  if (loc <= 0) return true;
  return allowed.includes(loc);
}

// Verifica un RECORD con colonna `location_id` diretta. Record inesistente -> ritorna (lo gestisce
// il chiamante con il suo "non trovato"); non accessibile -> throw con il messaggio dato.
export async function assertLocationAccessById(
  slug: string,
  table: string,
  id: number,
  allowedLocationIds: number[],
  message = "Record non disponibile per le tue sedi.",
): Promise<void> {
  if (id <= 0) return;
  const allowed = (allowedLocationIds ?? []).map((n) => Number(n) || 0).filter((n) => n > 0);
  if (allowed.length === 0) return;
  const rows = await tenantSelect<RowDataPacket>({ slug, table, columns: "location_id", where: "id = ?", params: [id], limit: 1 }).catch(
    () => [] as RowDataPacket[],
  );
  if (!rows[0]) return;
  if (!locationAllowedForSedi(Number(rows[0].location_id ?? 0) || 0, allowed)) throw new Error(message);
}

// Come assertLocationAccessById ma la sede e' EREDITATA da un record PADRE via una FK (es. un
// preordine = sale_item la cui sede sta su sales.location_id). Se il padre manca -> nessun blocco.
export async function assertLocationAccessViaParent(
  slug: string,
  childTable: string,
  childId: number,
  parentFkColumn: string,
  parentTable: string,
  allowedLocationIds: number[],
  message = "Record non disponibile per le tue sedi.",
): Promise<void> {
  if (childId <= 0) return;
  const allowed = (allowedLocationIds ?? []).map((n) => Number(n) || 0).filter((n) => n > 0);
  if (allowed.length === 0) return;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: childTable, columns: parentFkColumn, where: "id = ?", params: [childId], limit: 1 }).catch(
    () => [] as RowDataPacket[],
  );
  const parentId = Number(rows[0]?.[parentFkColumn] ?? 0) || 0;
  if (parentId <= 0) return;
  await assertLocationAccessById(slug, parentTable, parentId, allowed, message);
}

export type ManageLocationEdit = {
  id: number;
  name: string;
  address: string;
  legalRegion: string;
  legalProvince: string;
  legalCity: string;
  legalCap: string;
  phone: string;
  email: string;
  whatsapp: string;
  facebookUrl: string;
  instagramUrl: string;
  tiktokUrl: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
};

// Edit-form prefill for ONE location. Port of locations.php loadLocationForm
// (the locationModal data-location-edit prefill): returns the editable fields
// posted by the locationModalForm (action=location_save). Narrowed by id from
// the same tenant-scoped locations table the list/context pipeline uses.
export async function getManageLocation(slug: string, id: number): Promise<ManageLocationEdit | null> {
  if (!(id > 0)) return null;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "*",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id ?? id),
    name: String(row.name ?? ""),
    address: String(row.address ?? ""),
    legalRegion: String(row.legal_region ?? ""),
    legalProvince: String(row.legal_province ?? ""),
    legalCity: String(row.legal_city ?? ""),
    legalCap: String(row.legal_cap ?? ""),
    phone: String(row.phone ?? ""),
    email: String(row.email ?? ""),
    whatsapp: String(row.whatsapp ?? ""),
    facebookUrl: String(row.facebook_url ?? ""),
    instagramUrl: String(row.instagram_url ?? ""),
    tiktokUrl: String(row.tiktok_url ?? ""),
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
    marketplaceEnabled: Number(row.marketplace_enabled ?? 0) === 1,
  };
}
