import "server-only";

// AREA CLIENTE — Prenotazioni. Port of the legacy booking.php customer-area
// modes: my_appointments (:6525), cancel_appointment (:6632) and ics (:7182),
// with the cancel policy from booking_customer_cancel_policy /
// booking_customer_can_cancel_appointment (lib/Helpers.php:5384/:5424 — the
// policy lives on the businesses row: booking_customer_cancel_enabled /
// _before_value / _before_unit).
//
// Model note: the legacy customer area is PER-TENANT (the booking page's own
// session). The Next account is a GLOBAL marketplace account linked to tenant
// clients via public_customer_tenant_links, so the list aggregates the
// appointments of every linked activity (same per-appointment payload as the
// legacy, plus tenantSlug/tenantName for grouping). Ownership keeps the legacy
// rule: the linked client_id OR a client with the same email.

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery, quoteIdentifier, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import {
  appointmentPhpStatus,
  restoreAppointmentRedeems,
  updateDbAppointmentStatus,
} from "@/lib/db-repositories";
import { lifecycleKindForStatusChange, sendAppointmentLifecycleEmail } from "@/lib/appointment-lifecycle-email";
import { publicCustomerActivities, type PublicCustomerActivity } from "@/lib/public-customer-account";

// Legacy appt_lifecycle_status_label (In attesa / Prenotato / Eseguito / ...).
const STATUS_LABELS: Record<string, string> = {
  pending: "In attesa",
  scheduled: "Prenotato",
  done: "Eseguito",
  canceled: "Annullato",
  no_show: "No show",
};

export type PublicCustomerAppointment = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  publicCode: string;
  startsAt: string;
  endsAt: string;
  status: string;
  statusLabel: string;
  services: string[];
  operators: string[];
  locationName: string;
  totalPrice: number;
  canCancel: boolean;
  cancelReason: string | null;
};

type CancelPolicy = { enabled: boolean; seconds: number; label: string };

// Port of booking_customer_cancel_policy (Helpers.php:5384): the toggle + the
// minimum notice (hours/days, hard-clamped) read from the businesses row.
async function customerCancelPolicy(slug: string): Promise<CancelPolicy> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "booking_customer_cancel_enabled, booking_customer_cancel_before_value, booking_customer_cancel_before_unit",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const row = rows[0];
  const enabled = Number(row?.booking_customer_cancel_enabled ?? 0) === 1;
  let value = Math.max(0, Math.trunc(Number(row?.booking_customer_cancel_before_value ?? 0)) || 0);
  let unit = String(row?.booking_customer_cancel_before_unit ?? "hours");
  if (unit !== "hours" && unit !== "days") unit = "hours";
  if (unit === "days" && value > 365) value = 365;
  if (unit === "hours" && value > 8760) value = 8760;
  const seconds = value * (unit === "days" ? 86400 : 3600);
  const label = value <= 0
    ? "fino all'inizio dell'appuntamento"
    : `${value} ${unit === "days" ? (value === 1 ? "giorno" : "giorni") : (value === 1 ? "ora" : "ore")}`;
  return { enabled, seconds, label };
}

// Port of booking_customer_can_cancel_appointment (Helpers.php:5424) with the
// exact legacy reason strings. `startsAt` is the SQL datetime (local time).
function canCancelAppointment(
  startsAt: string,
  status: string,
  policy: CancelPolicy,
): { canCancel: boolean; reason: string | null } {
  if (!policy.enabled) return { canCancel: false, reason: "Cancellazione non disponibile." };
  const norm = appointmentPhpStatus(status);
  if (norm !== "pending" && norm !== "scheduled") {
    return { canCancel: false, reason: "Questo appuntamento non può essere annullato." };
  }
  const trimmed = String(startsAt ?? "").trim();
  if (!trimmed) return { canCancel: false, reason: "Data appuntamento non valida." };
  const startMs = new Date(trimmed.replace(" ", "T")).getTime();
  if (!Number.isFinite(startMs) || Number.isNaN(startMs)) {
    return { canCancel: false, reason: "Data appuntamento non valida." };
  }
  const nowMs = Date.now();
  if (startMs <= nowMs) return { canCancel: false, reason: "L'appuntamento è già iniziato o passato." };
  if (policy.seconds > 0 && (startMs - nowMs) / 1000 < policy.seconds) {
    return { canCancel: false, reason: `Puoi annullare solo entro ${policy.label} prima dell'appuntamento.` };
  }
  return { canCancel: true, reason: null };
}

// SQL datetime string from a driver value (Date object or string), LOCAL time.
function sqlLocal(value: unknown): string {
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  return String(value ?? "").replace("T", " ").slice(0, 19);
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Detail rows for ONE appointment of a tenant: service names (appointment_services,
// insertion order), operator names (segments' staff, then the appointment_staff
// fallback — the legacy segments + staff_name fallback), location name and the
// legacy total cascade (subtotal − sconto manuale − fidelity − giftcard − credito,
// each clamped to the remainder — Helpers.php appointment_details).
async function appointmentCustomerDetail(slug: string, appt: RowDataPacket): Promise<{
  services: string[];
  operators: string[];
  locationName: string;
  totalPrice: number;
}> {
  const id = Number(appt.id ?? 0);
  const serviceRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_services",
    columns: "service_name, price",
    where: "appointment_id = ?",
    params: [id],
  }).catch(() => [] as RowDataPacket[]);
  const services: string[] = [];
  let subtotal = 0;
  for (const row of serviceRows) {
    const name = String(row.service_name ?? "").trim();
    if (name && !services.includes(name)) services.push(name);
    subtotal += Math.max(0, Number(row.price ?? 0) || 0);
  }
  subtotal = round2(subtotal);

  // Operators: per-segment staff first, appointment_staff as the fallback.
  const staffTable = await tenantTable(slug, "staff");
  const segTable = await tenantTable(slug, "appointment_segments");
  const apptStaffTable = await tenantTable(slug, "appointment_staff");
  const operators: string[] = [];
  const pushStaff = (name: unknown) => {
    const trimmed = String(name ?? "").trim();
    if (trimmed && !operators.includes(trimmed)) operators.push(trimmed);
  };
  const segRows = await dbQuery<RowDataPacket[]>(
    `SELECT st.full_name FROM ${quoteIdentifier(segTable.name)} sg JOIN ${quoteIdentifier(staffTable.name)} st ON st.id = sg.staff_id AND st.tenant_id = sg.tenant_id WHERE sg.tenant_id = ? AND sg.appointment_id = ? ORDER BY sg.position ASC`,
    [segTable.tenantId ?? 0, id],
  ).catch(() => [] as RowDataPacket[]);
  for (const row of segRows) pushStaff(row.full_name);
  if (!operators.length) {
    const staffRows = await dbQuery<RowDataPacket[]>(
      `SELECT st.full_name FROM ${quoteIdentifier(apptStaffTable.name)} ast JOIN ${quoteIdentifier(staffTable.name)} st ON st.id = ast.staff_id AND st.tenant_id = ast.tenant_id WHERE ast.tenant_id = ? AND ast.appointment_id = ?`,
      [apptStaffTable.tenantId ?? 0, id],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of staffRows) pushStaff(row.full_name);
  }

  let locationName = "";
  const locationId = Number(appt.location_id ?? 0) || 0;
  if (locationId > 0) {
    const locRows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "name", where: "id = ?", params: [locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    locationName = String(locRows[0]?.name ?? "").trim();
  }

  // Legacy price cascade: sconto manuale, then fidelity, giftcard, credito —
  // each clamped to what remains so the total never goes negative.
  const dtype = String(appt.discount_type ?? "").toLowerCase();
  const dval = Math.max(0, Number(appt.discount_value ?? 0) || 0);
  let discount = 0;
  if (dtype === "percent" && dval > 0) discount = round2((subtotal * Math.min(100, dval)) / 100);
  else if (dtype === "fixed" && dval > 0) discount = Math.min(subtotal, round2(dval));
  let remaining = Math.max(0, round2(subtotal - discount));
  const fidelityDiscount = Math.min(remaining, Math.abs(round2(Number(appt.fidelity_discount ?? 0) || 0)));
  remaining = Math.max(0, round2(remaining - fidelityDiscount));
  const giftcardUsed = Math.min(remaining, Math.abs(round2(Number(appt.giftcard_used ?? 0) || 0)));
  remaining = Math.max(0, round2(remaining - giftcardUsed));
  const creditUsed = Math.min(remaining, Math.abs(round2(Number(appt.credit_used ?? 0) || 0)));
  const totalPrice = Math.max(0, round2(remaining - creditUsed));

  return { services, operators, locationName, totalPrice };
}

// Attività "sintetica" per il tenant CORRENTE dell'hub quando l'account non ha
// ancora un link (public_customer_tenant_links) verso quel centro: il legacy
// (adoptGlobalSession/my_appointments) risolve comunque il cliente PER EMAIL
// presso il tenant corrente, quindi appuntamenti/preventivi restano visibili
// anche per i clienti creati offline (staff/walk-in) senza link. clientId=0 →
// nella query resta solo il ramo email.
function syntheticCurrentTenantActivity(tenantSlug: string, tenantName: string): PublicCustomerActivity {
  const name = tenantName.trim() || tenantSlug;
  return {
    tenantSlug, tenantName: name, title: name, subtitle: "", city: "", province: "",
    address: "", phone: "", email: "", bookingUrl: "", linkedAt: null, lastSeenAt: null,
    clientId: 0, referenceLocationId: 0, locations: [],
  };
}

// Aggiunge il tenant corrente alla lista delle attività se non già collegato,
// così il ramo email lo interroga (parità con adoptGlobalSession del legacy).
function withCurrentTenant(activities: PublicCustomerActivity[], extraTenantSlug: string, extraTenantName: string): PublicCustomerActivity[] {
  const slugLc = String(extraTenantSlug ?? "").trim().toLowerCase();
  if (!slugLc || activities.some((a) => a.tenantSlug === slugLc)) return activities;
  return [...activities, syntheticCurrentTenantActivity(slugLc, String(extraTenantName ?? ""))];
}

// mode=my_appointments: the account's appointments across every linked activity
// (per activity: client_id OR same-email clients, newest first, LIMIT 200 like
// the legacy single-tenant query), each with the legacy payload + can_cancel.
// extraTenantSlug: hub per-sede corrente (visibile per email anche senza link).
export async function listPublicCustomerAppointments(accountId: number, email: string, extraTenantSlug = "", extraTenantName = ""): Promise<PublicCustomerAppointment[]> {
  const linked = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const activities = withCurrentTenant(linked, extraTenantSlug, extraTenantName);
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const out: PublicCustomerAppointment[] = [];

  for (const activity of activities) {
    const slug = activity.tenantSlug;
    try {
      const appts = await tenantTable(slug, "appointments");
      const clients = await tenantTable(slug, "clients");
      const where: string[] = [];
      const params: unknown[] = [appts.tenantId ?? 0];
      if (activity.clientId > 0) {
        where.push("a.client_id = ?");
        params.push(activity.clientId);
      }
      if (normalizedEmail) {
        where.push("LOWER(TRIM(COALESCE(c.email,''))) = ?");
        params.push(normalizedEmail);
      }
      if (!where.length) continue;
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT a.* FROM ${quoteIdentifier(appts.name)} a JOIN ${quoteIdentifier(clients.name)} c ON c.id = a.client_id AND c.tenant_id = a.tenant_id WHERE a.tenant_id = ? AND (${where.join(" OR ")}) ORDER BY a.starts_at DESC, a.id DESC LIMIT 200`,
        params,
      ).catch(() => [] as RowDataPacket[]);
      if (!rows.length) continue;
      const policy = await customerCancelPolicy(slug);
      for (const row of rows) {
        const startsAt = sqlLocal(row.starts_at);
        const status = appointmentPhpStatus(String(row.status ?? ""));
        const gate = canCancelAppointment(startsAt, String(row.status ?? ""), policy);
        const detail = await appointmentCustomerDetail(slug, row);
        out.push({
          id: Number(row.id ?? 0),
          tenantSlug: slug,
          tenantName: activity.tenantName,
          publicCode: String(row.public_code ?? "").trim(),
          startsAt,
          endsAt: sqlLocal(row.ends_at),
          status,
          statusLabel: STATUS_LABELS[status] ?? (status ? status[0].toUpperCase() + status.slice(1) : "—"),
          services: detail.services,
          operators: detail.operators,
          locationName: detail.locationName,
          totalPrice: detail.totalPrice,
          canCancel: gate.canCancel,
          cancelReason: gate.canCancel ? null : gate.reason,
        });
      }
    } catch {
      // A broken tenant never hides the others' appointments (best-effort).
    }
  }

  out.sort((a, b) => (a.startsAt < b.startsAt ? 1 : a.startsAt > b.startsAt ? -1 : b.id - a.id));
  return out;
}

// Ownership: the appointment's client must be the linked client OR share the
// account email (legacy cancel_appointment/ics rule). Returns the row or null.
async function ownedAppointment(
  slug: string,
  activity: PublicCustomerActivity | undefined,
  email: string,
  where: string,
  params: unknown[],
): Promise<RowDataPacket | null> {
  const appts = await tenantTable(slug, "appointments");
  const clients = await tenantTable(slug, "clients");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT a.*, c.email AS client_email FROM ${quoteIdentifier(appts.name)} a JOIN ${quoteIdentifier(clients.name)} c ON c.id = a.client_id AND c.tenant_id = a.tenant_id WHERE a.tenant_id = ? AND ${where} LIMIT 1`,
    [appts.tenantId ?? 0, ...params],
  ).catch(() => [] as RowDataPacket[]);
  const row = rows[0];
  if (!row) return null;
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const linkedClientId = Number(activity?.clientId ?? 0);
  if (linkedClientId > 0 && Number(row.client_id ?? 0) === linkedClientId) return row;
  const clientEmail = String(row.client_email ?? "").trim().toLowerCase();
  if (normalizedEmail && clientEmail && clientEmail === normalizedEmail) return row;
  return null;
}

// mode=cancel_appointment: ownership + policy, then the SAME cancel path the
// manage status action uses for pending/scheduled → canceled (restore the
// consumed redeems, flip the status, fire the lifecycle email best-effort) with
// the legacy reason note semantics. Throws the exact legacy error strings.
export async function cancelPublicCustomerAppointment({
  accountId,
  email,
  tenantSlug,
  appointmentId,
}: {
  accountId: number;
  email: string;
  tenantSlug: string;
  appointmentId: number;
}): Promise<void> {
  if (appointmentId <= 0) throw new Error("Appuntamento non valido");
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const activity = activities.find((a) => a.tenantSlug === tenantSlug);
  if (!activity && !String(email ?? "").trim()) throw new Error("Non autorizzato");

  const row = await ownedAppointment(tenantSlug, activity, email, "a.id = ?", [appointmentId]);
  if (!row) {
    // The legacy distinguishes not-found from not-owned; a cross-tenant id is
    // indistinguishable here, so surface the ownership error for both.
    throw new Error("Appuntamento non trovato");
  }
  const policy = await customerCancelPolicy(tenantSlug);
  const gate = canCancelAppointment(sqlLocal(row.starts_at), String(row.status ?? ""), policy);
  if (!gate.canCancel) throw new Error(gate.reason || "Non puoi annullare questo appuntamento");

  const oldPhpStatus = appointmentPhpStatus(String(row.status ?? ""));
  await restoreAppointmentRedeems(tenantSlug, appointmentId);
  await updateDbAppointmentStatus(tenantSlug, appointmentId, "canceled");
  try {
    const kind = lifecycleKindForStatusChange(oldPhpStatus, "canceled");
    if (kind) await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId, kind });
  } catch {
    // best-effort, like the legacy automation hook
  }
}

// Sede di riferimento (port of BookingAuth::updateReferenceLocation, chiamata
// da mode=customer_update_reference_location): sets clients.location_id for
// the account's linked client of that tenant. Legacy validation + strings.
export async function updatePublicCustomerReferenceLocation({
  accountId,
  tenantSlug,
  locationId,
}: {
  accountId: number;
  tenantSlug: string;
  locationId: number;
}): Promise<void> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const activity = activities.find((a) => a.tenantSlug === tenantSlug);
  if (!activity || activity.clientId <= 0) throw new Error("Sessione cliente non valida. Accedi di nuovo.");
  const locId = Math.max(0, Math.trunc(Number(locationId)) || 0);
  if (locId <= 0) throw new Error("Seleziona una sede valida.");
  const locRows = await tenantSelect<RowDataPacket>({
    slug: tenantSlug,
    table: "locations",
    columns: "id",
    where: "id = ? AND COALESCE(is_active,1) = 1 AND COALESCE(booking_enabled,1) = 1",
    params: [locId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (!locRows[0]) throw new Error("Seleziona una sede valida.");
  await tenantUpdate({ slug: tenantSlug, table: "clients", id: activity.clientId, values: { location_id: locId } });
}

// ---------------------------------------------------------------------------
// AREA CLIENTE — Pacchetti (port of booking.php mode=my_packages :6817) and
// Preventivi (mode=my_quotes :6708 + mode=quote_decision :7060).

const PACKAGE_STATUS_LABELS: Record<string, string> = {
  active: "Attivo",
  completed: "Completato",
  expired: "Scaduto",
  canceled: "Annullato",
};

export type PublicCustomerPackage = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  packageName: string;
  serviceName: string;
  purchaseDate: string | null;
  expiresAt: string | null;
  sessionsTotal: number;
  sessionsRemaining: number;
  status: string;
  statusLabel: string;
  services: Array<{ serviceName: string; sessionsTotal: number; sessionsRemaining: number }>;
};

// mode=my_packages: the linked clients' packages with the legacy status
// normalization (canceled > esaurito > scaduto > attivo). The legacy also
// splits RESERVED sessions (pending bookings) per service — not ported here
// (documented): the remaining figures are the raw client_package(_services).
export async function listPublicCustomerPackages(accountId: number): Promise<PublicCustomerPackage[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerPackage[] = [];
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_packages",
        columns: "id, package_name, service_id, purchase_date, expires_at, sessions_total, sessions_remaining, status",
        where: "client_id = ?",
        params: [activity.clientId],
        orderBy: "purchase_date DESC, id DESC",
      }).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const id = Number(row.id ?? 0);
        if (id <= 0) continue;
        const remaining = Math.max(0, Number(row.sessions_remaining ?? 0) || 0);
        const expires = row.expires_at ? String(row.expires_at instanceof Date ? sqlLocal(row.expires_at).slice(0, 10) : String(row.expires_at).slice(0, 10)) : "";
        const statusRaw = String(row.status ?? "").trim().toLowerCase();
        let status = "active";
        if (statusRaw === "canceled" || statusRaw === "cancelled") status = "canceled";
        else if (remaining <= 0) status = "completed";
        else if (expires && expires < todayYmd) status = "expired";
        // Per-service rows (multi-service packages) — best-effort.
        const serviceRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "client_package_services",
          columns: "service_id, sessions_total, sessions_remaining",
          where: "client_package_id = ?",
          params: [id],
          orderBy: "sort_order ASC, id ASC",
        }).catch(() => [] as RowDataPacket[]);
        const serviceIds = Array.from(new Set([Number(row.service_id ?? 0), ...serviceRows.map((s) => Number(s.service_id ?? 0))].filter((n) => n > 0)));
        const nameById = new Map<number, string>();
        if (serviceIds.length) {
          const ph = serviceIds.map(() => "?").join(", ");
          const svcNames = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name", where: `id IN (${ph})`, params: serviceIds }).catch(() => [] as RowDataPacket[]);
          for (const s of svcNames) nameById.set(Number(s.id ?? 0), String(s.name ?? ""));
        }
        out.push({
          id,
          tenantSlug: slug,
          tenantName: activity.tenantName,
          packageName: String(row.package_name ?? ""),
          serviceName: nameById.get(Number(row.service_id ?? 0)) ?? "",
          purchaseDate: row.purchase_date ? sqlLocal(row.purchase_date).slice(0, 10) : null,
          expiresAt: expires || null,
          sessionsTotal: Math.max(0, Number(row.sessions_total ?? 0) || 0),
          sessionsRemaining: remaining,
          status,
          statusLabel: PACKAGE_STATUS_LABELS[status] ?? status,
          services: serviceRows.map((s) => ({
            serviceName: nameById.get(Number(s.service_id ?? 0)) ?? `Servizio #${Number(s.service_id ?? 0)}`,
            sessionsTotal: Math.max(0, Number(s.sessions_total ?? 0) || 0),
            sessionsRemaining: Math.max(0, Number(s.sessions_remaining ?? 0) || 0),
          })),
        });
      }
    } catch {
      // best-effort per activity
    }
  }
  return out;
}

const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Bozza",
  sent: "Inviato",
  expired: "Scaduto",
  accepted: "Accettato",
  paid: "Pagato",
  rejected: "Rifiutato",
  canceled: "Annullato",
};

export type PublicCustomerQuote = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  number: string;
  quoteDate: string | null;
  validUntil: string | null;
  status: string;
  statusLabel: string;
  total: number;
  canRespond: boolean;
  customerDecisionAt: string | null;
};

// mode=my_quotes: the linked clients' quotes (non-draft), with the legacy
// expired override on 'sent' past valid_until and the can_respond gate.
// extraTenantSlug: hub per-sede corrente (visibile per email anche senza link).
export async function listPublicCustomerQuotes(accountId: number, email: string, extraTenantSlug = "", extraTenantName = ""): Promise<PublicCustomerQuote[]> {
  const linked = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const activities = withCurrentTenant(linked, extraTenantSlug, extraTenantName);
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const out: PublicCustomerQuote[] = [];

  for (const activity of activities) {
    const slug = activity.tenantSlug;
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (activity.clientId > 0) {
        where.push("client_id = ?");
        params.push(activity.clientId);
      }
      if (normalizedEmail) {
        where.push("(client_id IS NULL AND LOWER(TRIM(COALESCE(client_email,''))) = ?)");
        params.push(normalizedEmail);
      }
      if (!where.length) continue;
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "quotes",
        columns: "id, number, quote_date, valid_until, status, total, customer_decision_at",
        where: `(${where.join(" OR ")}) AND status <> 'draft'`,
        params,
        orderBy: "quote_date DESC, id DESC",
        limit: 50,
      }).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const id = Number(row.id ?? 0);
        if (id <= 0) continue;
        let status = String(row.status ?? "").trim().toLowerCase();
        if (status === "cancelled") status = "canceled";
        const validUntil = row.valid_until ? sqlLocal(row.valid_until).slice(0, 10) : "";
        let canRespond = status === "sent";
        if (status === "sent" && validUntil && validUntil < todayYmd) {
          status = "expired";
          canRespond = false;
        }
        if (["accepted", "paid", "rejected", "expired", "canceled"].includes(status)) canRespond = false;
        out.push({
          id,
          tenantSlug: slug,
          tenantName: activity.tenantName,
          number: String(row.number ?? ""),
          quoteDate: row.quote_date ? sqlLocal(row.quote_date).slice(0, 10) : null,
          validUntil: validUntil || null,
          status,
          statusLabel: QUOTE_STATUS_LABELS[status] ?? (status || "—"),
          total: Math.round((Number(row.total ?? 0) + Number.EPSILON) * 100) / 100,
          canRespond,
          customerDecisionAt: row.customer_decision_at ? sqlLocal(row.customer_decision_at) : null,
        });
      }
    } catch {
      // best-effort per activity
    }
  }
  return out;
}

// mode=quote_decision: accept/reject a SENT quote the account owns (legacy
// ownership: linked client_id, or client-less quote with the same email).
// Exact legacy guards + error strings; the decision stamps customer_decision_*.
export async function decidePublicCustomerQuote({
  accountId,
  email,
  tenantSlug,
  quoteId,
  decision,
}: {
  accountId: number;
  email: string;
  tenantSlug: string;
  quoteId: number;
  decision: "accept" | "reject";
}): Promise<void> {
  if (quoteId <= 0) throw new Error("Preventivo non valido");
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const activity = activities.find((a) => a.tenantSlug === tenantSlug);
  const normalizedEmail = String(email ?? "").trim().toLowerCase();

  const rows = await tenantSelect<RowDataPacket>({
    slug: tenantSlug,
    table: "quotes",
    columns: "id, status, valid_until, client_id, client_email",
    where: "id = ?",
    params: [quoteId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const quote = rows[0];
  if (!quote) throw new Error("Preventivo non trovato");

  let owned = false;
  if (activity && activity.clientId > 0 && Number(quote.client_id ?? 0) === activity.clientId) owned = true;
  if (!owned && normalizedEmail && String(quote.client_email ?? "").trim().toLowerCase() === normalizedEmail) owned = true;
  if (!owned) throw new Error("Non autorizzato");

  let status = String(quote.status ?? "").trim().toLowerCase();
  if (status === "cancelled") status = "canceled";
  const validUntil = quote.valid_until ? sqlLocal(quote.valid_until).slice(0, 10) : "";
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  if (status === "sent" && validUntil && validUntil < todayYmd) {
    const quotesTable = await tenantTable(tenantSlug, "quotes");
    await dbQuery(`UPDATE ${quoteIdentifier(quotesTable.name)} SET status='expired' WHERE tenant_id = ? AND id = ? AND status='sent'`, [quotesTable.tenantId ?? 0, quoteId]).catch(() => undefined);
    throw new Error("Preventivo scaduto");
  }
  if (status === "accepted" || status === "rejected") throw new Error("Hai già risposto a questo preventivo.");
  if (status !== "sent") throw new Error("Questo preventivo non è modificabile.");
  // NOTA: il check disponibilità catalogo del legacy (quote_catalog_availability_check
  // all'accettazione) non è portato — la conversione in vendita lato manage
  // rivalida comunque gli articoli.

  const quotesTable = await tenantTable(tenantSlug, "quotes");
  const newStatus = decision === "accept" ? "accepted" : "rejected";
  await dbQuery(
    `UPDATE ${quoteIdentifier(quotesTable.name)}
        SET status = ?, customer_decision_at = ?, customer_decision_source = 'booking', customer_decision_seen_at = NULL
      WHERE tenant_id = ? AND id = ? AND status = 'sent' AND customer_decision_at IS NULL`,
    [newStatus, sqlLocal(new Date()), quotesTable.tenantId ?? 0, quoteId],
  );
}

// mode=ics: the .ics file for an OWNED appointment found by public_code across
// the linked activities (the legacy is per-tenant; the global account searches
// its linked tenants). Exact legacy calendar body: Europe/Rome VTIMEZONE,
// "Appuntamento • <servizi>" summary, description with Servizi/Totale/Sede/
// Codice and the -15' VALARM.
export async function publicCustomerAppointmentIcs(
  accountId: number,
  email: string,
  code: string,
  host: string,
): Promise<{ filename: string; content: string } | null> {
  const trimmedCode = String(code ?? "").trim();
  if (!trimmedCode) return null;
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);

  for (const activity of activities) {
    const slug = activity.tenantSlug;
    let row: RowDataPacket | null = null;
    try {
      row = await ownedAppointment(slug, activity, email, "a.public_code = ?", [trimmedCode]);
    } catch {
      row = null;
    }
    if (!row) continue;

    const detail = await appointmentCustomerDetail(slug, row);
    const start = sqlLocal(row.starts_at);
    const end = sqlLocal(row.ends_at);
    const compact = (v: string) => v.replace(/[-:]/g, "").replace(" ", "T");
    const dtStamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const svcList = detail.services.length ? detail.services.join(", ") : "Appuntamento";
    const summary = `Appuntamento • ${svcList}`;
    // The legacy appends the address to the location line; the address lives on
    // the activity profile here.
    const locLine = [detail.locationName, activity.address].filter(Boolean).join(", ");
    const uid = `${trimmedCode || row.id}@${host || "prenodo"}`;

    const esc = (s: string) => s
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\n|\r/g, "\\n");
    const fold = (line: string) => {
      let out = "";
      let rest = line;
      while (rest.length > 72) {
        out += rest.slice(0, 72) + "\r\n ";
        rest = rest.slice(72);
      }
      return out + rest;
    };
    const money = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const descParts: string[] = [];
    if (svcList) descParts.push(`Servizi: ${svcList}`);
    descParts.push(`Totale: € ${money(detail.totalPrice)}`);
    if (locLine) descParts.push(`Sede: ${locLine}`);
    descParts.push(`Codice prenotazione: ${trimmedCode}`);

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//BeautySuite//Booking//IT",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-TIMEZONE:Europe/Rome",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Rome",
      "X-LIC-LOCATION:Europe/Rome",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "TZNAME:CEST",
      "DTSTART:19700329T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "TZNAME:CET",
      "DTSTART:19701025T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      `UID:${esc(uid)}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;TZID=Europe/Rome:${compact(start)}`,
      `DTEND;TZID=Europe/Rome:${compact(end)}`,
      `SUMMARY:${esc(summary.replace(/[\r\n]/g, " "))}`,
      ...(locLine ? [`LOCATION:${esc(locLine.replace(/[\r\n]/g, " "))}`] : []),
      `DESCRIPTION:${esc(descParts.join("\n"))}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Promemoria appuntamento",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    const content = lines.map(fold).join("\r\n") + "\r\n";
    return { filename: `appuntamento-${trimmedCode || row.id}.ics`, content };
  }

  return null;
}

// ===================== Sezioni area cliente (P3) =====================
// Port of the remaining tenant-panel sections (BookingPublicUi.php 33-60 menu):
// Credito, GiftCard, Prepagati, Omaggi, Fidelity, Preordini — read-only lists,
// aggregated per linked activity like the appointments/packages above.

const ymdLocal = (value: unknown): string | null => {
  if (!value) return null;
  const s = value instanceof Date ? sqlLocal(value) : String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
};
const todayYmdLocal = (): string => {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};

// --- Credito: saldo + movimenti (credit_adjustments, il ledger del wallet). ---
export type PublicCustomerCreditSection = {
  tenantSlug: string;
  tenantName: string;
  balance: number;
  movements: Array<{ date: string | null; amount: number; note: string }>;
};
export async function listPublicCustomerCredit(accountId: number): Promise<PublicCustomerCreditSection[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerCreditSection[] = [];
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      const clientRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "clients",
        columns: "credit_balance",
        where: "id = ?",
        params: [activity.clientId],
        limit: 1,
      });
      if (!clientRows[0]) continue;
      const balance = Math.round((Math.max(0, Number(clientRows[0].credit_balance ?? 0) || 0) + Number.EPSILON) * 100) / 100;
      const moveRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "credit_adjustments",
        columns: "delta_amount, note, created_at",
        where: "client_id = ?",
        params: [activity.clientId],
        orderBy: "id DESC",
        limit: 30,
      }).catch(() => [] as RowDataPacket[]);
      out.push({
        tenantSlug: slug,
        tenantName: activity.tenantName,
        balance,
        movements: moveRows.map((row) => ({
          date: ymdLocal(row.created_at),
          amount: Math.round((Number(row.delta_amount ?? 0) + Number.EPSILON) * 100) / 100,
          note: String(row.note ?? ""),
        })),
      });
    } catch {
      // tolerate a tenant without the tables
    }
  }
  return out;
}

// --- GiftCard: le carte intestate al cliente con stato leggibile. ---
export type PublicCustomerGiftcard = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  code: string;
  balance: number;
  expiresAt: string | null;
  statusLabel: string;
};
export async function listPublicCustomerGiftcards(accountId: number): Promise<PublicCustomerGiftcard[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerGiftcard[] = [];
  const today = todayYmdLocal();
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      // Ownership come il legacy (booking_public_list_client_giftcards,
      // booking.php 318-343): carte con recipient_client_id = client OPPURE,
      // quando l'intestatario è vuoto (NULL/0), quelle acquistate dal client
      // stesso (client_id). view='all' => tutti gli stati. Fallback a
      // client_id solo se la colonna recipient_client_id non esiste.
      const gcOwnerWhere =
        "(recipient_client_id IS NOT NULL AND recipient_client_id > 0 AND recipient_client_id = ?) OR ((recipient_client_id IS NULL OR recipient_client_id = 0) AND client_id = ?)";
      const gcOrderBy =
        "CASE WHEN status='active' THEN 0 ELSE 1 END ASC, CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC, expires_at ASC, id DESC";
      let rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftcards",
        columns: "id, code, balance, status, expires_at",
        where: gcOwnerWhere,
        params: [activity.clientId, activity.clientId],
        orderBy: gcOrderBy,
        limit: 200,
      }).catch(() => null);
      if (rows === null) {
        rows = await tenantSelect<RowDataPacket>({
          slug,
          table: "giftcards",
          columns: "id, code, balance, status, expires_at",
          where: "client_id = ?",
          params: [activity.clientId],
          orderBy: gcOrderBy,
          limit: 200,
        }).catch(() => [] as RowDataPacket[]);
      }
      for (const row of rows) {
        const balance = Math.round((Math.max(0, Number(row.balance ?? 0) || 0) + Number.EPSILON) * 100) / 100;
        const status = String(row.status ?? "").trim().toLowerCase();
        const expires = ymdLocal(row.expires_at);
        const statusLabel =
          status === "active" && expires && expires < today
            ? "Scaduta"
            : status === "active" && balance <= 0
              ? "Esaurita"
              : status === "active"
                ? "Attiva"
                : status === "redeemed"
                  ? "Utilizzata"
                  : status === "cancelled" || status === "canceled"
                    ? "Annullata"
                    : status || "—";
        out.push({
          tenantSlug: slug,
          tenantName: activity.tenantName,
          id: Number(row.id ?? 0),
          code: String(row.code ?? ""),
          balance,
          expiresAt: expires,
          statusLabel,
        });
      }
    } catch {
      // tolerate a tenant without the table
    }
  }
  return out;
}

// --- Prepagati: i servizi prepagati con residuo + deep-link "prenota". ---
export type PublicCustomerPrepaid = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  serviceId: number;
  serviceName: string;
  remainingQty: number;
  purchasedQty: number;
  unitPrice: number;
  expiresAt: string | null;
  statusLabel: string;
};
export async function listPublicCustomerPrepaids(accountId: number): Promise<PublicCustomerPrepaid[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerPrepaid[] = [];
  const today = todayYmdLocal();
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_prepaid_services",
        columns: "id, service_id, service_name, purchased_qty, remaining_qty, unit_price, status, expires_at",
        where: "client_id = ?",
        params: [activity.clientId],
        orderBy: "id DESC",
        limit: 100,
      }).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const remaining = Math.max(0, Number(row.remaining_qty ?? 0) || 0);
        const status = String(row.status ?? "").trim().toLowerCase();
        const expires = ymdLocal(row.expires_at);
        const statusLabel =
          status !== "active"
            ? status === "completed"
              ? "Esaurito"
              : status || "—"
            : expires && expires < today
              ? "Scaduto"
              : remaining <= 0
                ? "Esaurito"
                : "Attivo";
        out.push({
          tenantSlug: slug,
          tenantName: activity.tenantName,
          id: Number(row.id ?? 0),
          serviceId: Number(row.service_id ?? 0),
          serviceName: String(row.service_name ?? "") || `Servizio #${Number(row.service_id ?? 0)}`,
          remainingQty: remaining,
          purchasedQty: Math.max(0, Number(row.purchased_qty ?? 0) || 0),
          unitPrice: Math.round((Math.max(0, Number(row.unit_price ?? 0) || 0) + Number.EPSILON) * 100) / 100,
          expiresAt: expires,
          statusLabel,
        });
      }
    } catch {
      // tolerate a tenant without the table
    }
  }
  return out;
}

// --- Omaggi: le istanze gift del cliente con lo stato legacy. ---
const GIFT_STATE_LABELS: Record<string, string> = {
  accumulo: "In accumulo",
  disponibile: "Disponibile",
  riscattato: "Riscattato",
  scaduto: "Scaduto",
  annullato: "Annullato",
};
export type PublicCustomerGift = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  name: string;
  stateLabel: string;
  expiresAt: string | null;
};
export async function listPublicCustomerGifts(accountId: number): Promise<PublicCustomerGift[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerGift[] = [];
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      // Come Gifts::clientAvailableInstances (booking.php sezione omaggi):
      // la sezione mostra SOLO gli omaggi 'disponibile', non accumulo/
      // riscattato/scaduto/annullato. (Residuo: il deep-link 'Prenota'
      // book_omaggio e il badge "Prenotato" dipendono dai reward-item +
      // riserve, non ancora portati.)
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "gift_instances",
        columns: "id, gift_id, state, expires_at",
        where: "client_id = ? AND state = 'disponibile'",
        params: [activity.clientId],
        orderBy: "id DESC",
        limit: 50,
      }).catch(() => [] as RowDataPacket[]);
      if (!rows.length) continue;
      const giftIds = Array.from(new Set(rows.map((r) => Number(r.gift_id ?? 0)).filter((n) => n > 0)));
      const nameById = new Map<number, string>();
      if (giftIds.length) {
        const ph = giftIds.map(() => "?").join(", ");
        const gifts = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id, name", where: `id IN (${ph})`, params: giftIds }).catch(() => [] as RowDataPacket[]);
        for (const g of gifts) nameById.set(Number(g.id ?? 0), String(g.name ?? ""));
      }
      for (const row of rows) {
        const state = String(row.state ?? "").trim().toLowerCase();
        out.push({
          tenantSlug: slug,
          tenantName: activity.tenantName,
          id: Number(row.id ?? 0),
          name: nameById.get(Number(row.gift_id ?? 0)) || "Omaggio",
          stateLabel: GIFT_STATE_LABELS[state] ?? (state || "—"),
          expiresAt: ymdLocal(row.expires_at),
        });
      }
    } catch {
      // tolerate a tenant without the tables
    }
  }
  return out;
}

// --- Fidelity: punti, tessera e ultimi movimenti (transactions). ---
export type PublicCustomerFidelitySection = {
  tenantSlug: string;
  tenantName: string;
  points: number;
  cardCode: string;
  cardActive: boolean;
  movements: Array<{ date: string | null; kind: string; deltaPoints: number; note: string }>;
};
export async function listPublicCustomerFidelity(accountId: number): Promise<PublicCustomerFidelitySection[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerFidelitySection[] = [];
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      const clientRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "clients",
        columns: "points",
        where: "id = ?",
        params: [activity.clientId],
        limit: 1,
      });
      if (!clientRows[0]) continue;
      const cardRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "cards",
        columns: "code, status",
        where: "client_id = ?",
        params: [activity.clientId],
        orderBy: "id DESC",
        limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      const txRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "transactions",
        columns: "kind, delta_points, note, created_at",
        where: "client_id = ?",
        params: [activity.clientId],
        orderBy: "id DESC",
        limit: 30,
      }).catch(() => [] as RowDataPacket[]);
      out.push({
        tenantSlug: slug,
        tenantName: activity.tenantName,
        points: Math.max(0, Math.round(Number(clientRows[0].points ?? 0) || 0)),
        cardCode: String(cardRows[0]?.code ?? ""),
        cardActive: String(cardRows[0]?.status ?? "").trim().toLowerCase() === "active",
        movements: txRows
          .filter((row) => Number(row.delta_points ?? 0) !== 0)
          .map((row) => ({
            date: ymdLocal(row.created_at),
            kind: String(row.kind ?? ""),
            deltaPoints: Math.round(Number(row.delta_points ?? 0) || 0),
            note: String(row.note ?? ""),
          })),
      });
    } catch {
      // tolerate a tenant without the tables
    }
  }
  return out;
}

// --- Preordini: sale_items prodotto con item_status ordinato/ritirato (port di
//     booking.php 10548-10620: la vista Preordini del pannello cliente). ---
export type PublicCustomerPreorder = {
  tenantSlug: string;
  tenantName: string;
  itemName: string;
  qty: number;
  statusLabel: string;
  saleDate: string | null;
  expiresAt: string | null;
};
export async function listPublicCustomerPreorders(accountId: number): Promise<PublicCustomerPreorder[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
  const out: PublicCustomerPreorder[] = [];
  const today = todayYmdLocal();
  for (const activity of activities) {
    if (activity.clientId <= 0) continue;
    const slug = activity.tenantSlug;
    try {
      const sales = await tenantTable(slug, "sales");
      const saleItems = await tenantTable(slug, "sale_items");
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT si.item_name, si.qty, si.item_status, si.preorder_expires_at, s.sale_date, s.created_at
           FROM ${quoteIdentifier(saleItems.name)} si
           JOIN ${quoteIdentifier(sales.name)} s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
          WHERE s.tenant_id = ?
            AND s.client_id = ?
            AND si.item_type = 'product'
            AND LOWER(TRIM(COALESCE(si.item_status,''))) IN ('ordered','ordinato','collected','ritirato')
            AND LOWER(TRIM(COALESCE(s.status,''))) NOT IN ('cancelled','canceled','annullato','annullata')
          ORDER BY COALESCE(s.sale_date, s.created_at) DESC, si.id DESC
          LIMIT 150`,
        [sales.tenantId ?? 0, activity.clientId],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const status = String(row.item_status ?? "ordered").trim().toLowerCase();
        const collected = status === "collected" || status === "ritirato";
        const expires = ymdLocal(row.preorder_expires_at);
        const statusLabel = collected ? "Ritirato" : expires && expires < today ? "Scaduto" : "Ordinato";
        out.push({
          tenantSlug: slug,
          tenantName: activity.tenantName,
          itemName: String(row.item_name ?? "Prodotto"),
          qty: Math.max(1, Math.round(Number(row.qty ?? 1) || 1)),
          statusLabel,
          saleDate: ymdLocal(row.sale_date ?? row.created_at),
          expiresAt: expires,
        });
      }
    } catch {
      // tolerate a tenant without the sales tables
    }
  }
  return out;
}
