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
import { dbQuery, quoteIdentifier, tenantSelect, tenantTable } from "@/lib/tenant-db";
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

// mode=my_appointments: the account's appointments across every linked activity
// (per activity: client_id OR same-email clients, newest first, LIMIT 200 like
// the legacy single-tenant query), each with the legacy payload + can_cancel.
export async function listPublicCustomerAppointments(accountId: number, email: string): Promise<PublicCustomerAppointment[]> {
  const activities = await publicCustomerActivities(accountId).catch(() => [] as PublicCustomerActivity[]);
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
