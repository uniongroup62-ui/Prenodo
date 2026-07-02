// Appointment domain types + pure scheduling/formatting helpers.
//
// This module used to also host an in-memory demo appointment/hold store
// (seeded from the prototype's fake data) used as a DB-down fallback. That
// store has been removed: the app is now purely DB-backed. The live booking and
// calendar flows read/write through lib/db-repositories.ts and
// lib/public-booking-db.ts. What remains here are (1) the shared appointment
// types and (2) tenant-agnostic pure helpers (status/duration/price parsing,
// time math) with no data-source coupling.

export type AppointmentStatus = "Confermato" | "In attesa" | "Completato";

export type Appointment = {
  id: number;
  time: string;
  client: string;
  service: string;
  operator: string;
  room: string;
  price: string;
  status: AppointmentStatus;
};

export type AppointmentWithMeta = Appointment & {
  date?: string;
  locationId?: number | null;
  holdToken?: string;
  // End time HH:MM (from appointments.ends_at) so the calendar can render a block at
  // its REAL persisted duration instead of a fixed default — additive, ignored by
  // every other consumer (e.g. the list). Powers the duration-preserving resize.
  endTime?: string;
  // Real 5-digit booking code (appointments.public_code) when present; the list
  // shows it in the "Codice prenotazione" column, falling back to #id when absent.
  publicCode?: string | null;
  // The appointment's ordered service list (one entry per appointment_services row).
  // Lets the list render a multi-service appointment as a parent row + per-service
  // child rows (legacy ms-parent / ms-children Bootstrap collapse). Single-service
  // appointments carry a single entry; the existing `service` string is unchanged.
  services?: AppointmentServiceLine[];
  // The REAL php status code (pending|scheduled|done|canceled|no_show). `status`
  // above is the 3-value UI label (uiStatus) which collapses canceled/no_show/
  // scheduled to "Confermato"; statusCode preserves the true status so the calendar
  // can render the right pill/colour for canceled + no_show appointments.
  statusCode?: string;
  // Per-service SEGMENTS (appointment_segments) when the appointment's services run
  // under DIFFERENT operators: the Day calendar renders one block per segment in the
  // respective staff column (like the legacy per-segment events) — otherwise the
  // second operator's column would look free while they are busy on their segment.
  // Present only when the appointment spans more than one operator.
  segments?: Array<{ serviceId: number; serviceName: string; staffId: number; staffName: string; time: string; endTime: string }>;
};

// One service line on an appointment (from appointment_services), used for the
// multi-service parent/child rendering in the appointments list.
export type AppointmentServiceLine = {
  serviceId: number;
  name: string;
  price: string;
  // Segment id (multi-service): drives the ↑/↓ reorder in the appointments
  // list (action=swap_segment, legacy data-seg).
  segmentId?: number | null;
};

export type AppointmentHold = {
  token: string;
  channel: "backend" | "public";
  ownerKey: string;
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  serviceNames: string[];
  staffNames: string[];
  locationId: number | null;
  expiresAt: string;
  convertedAppointmentId?: number;
};

export type SlotAvailability = {
  time: string;
  available: boolean;
  operator: string | null;
  reason: string;
};

const statusAliases: Record<string, AppointmentStatus> = {
  confirmed: "Confermato",
  confermato: "Confermato",
  pending: "In attesa",
  waiting: "In attesa",
  requested: "In attesa",
  "in attesa": "In attesa",
  completed: "Completato",
  complete: "Completato",
  completato: "Completato",
};

export function normalizeAppointmentStatus(value: unknown): AppointmentStatus {
  const key = String(value ?? "").trim().toLowerCase();
  return statusAliases[key] ?? "In attesa";
}

export function statusLabel(status: AppointmentStatus): string {
  return status;
}

export function parseDurationMinutes(value: string | number | null | undefined, fallback = 30): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);

  const match = String(value ?? "").match(/(\d+)/);
  if (!match) return fallback;

  const minutes = Number.parseInt(match[1], 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

export function parseEuroAmount(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const normalized = String(value ?? "")
    .replace(",", ".")
    .match(/\d+(?:\.\d+)?/);

  return normalized ? Number.parseFloat(normalized[0]) : 0;
}

export function timeToMinutes(time: string): number {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return Number.NaN;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours * 60 + minutes;
}

export function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function normalizeTime(time: string): string {
  const minutes = timeToMinutes(time);
  return Number.isFinite(minutes) ? minutesToTime(minutes) : time;
}

export function dateTimeLabel(date: string, time: string): string {
  return `${date} ${normalizeTime(time)}:00`;
}

export function rangeOverlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && otherStart < end;
}

export function updateAppointmentStatus(
  appointments: AppointmentWithMeta[],
  id: number,
  status: AppointmentStatus | string,
): AppointmentWithMeta[] {
  const normalizedStatus = normalizeAppointmentStatus(status);

  return appointments.map((appointment) =>
    appointment.id === id ? { ...appointment, status: normalizedStatus } : appointment,
  );
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
