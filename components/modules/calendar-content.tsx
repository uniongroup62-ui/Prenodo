"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";

// Faithful port of the PHP calendar page (app/pages/calendar.php / ?page=calendar),
// fed by the existing DB-backed /api/manage/calendar and /api/manage/appointments.
//
// IMPORTANT — what is faithful-but-static vs wired:
//   The legacy page renders the agenda grid (<div id="calendar">) entirely via
//   FullCalendar 6.x driven by /assets/js/pages/calendar.js. That script wires the
//   header toolbar (Giorno/Settimana/Mese tabs, prev/next/today/Data/Ordina), drag &
//   drop, resize, and quick-book-from-cell against api_appointments. Here we reproduce
//   the SAME markup/classes (the FullCalendar header toolbar uses .fc-* classes so the
//   page CSS at /assets/css/pages/calendar.css applies) and render a real
//   staff-columns x time-rows agenda from the API, positioning appointment blocks by
//   time. Interaction parity (added on top of the unchanged rendering):
//     - MOVE: appointment blocks are HTML5-draggable. In the Giorno grid, dropping on a
//       staff column computes the target time (snapped to SNAP_MIN, like calendar.js
//       snapDuration 00:05:00) and target OPERATOR (date unchanged); in the Settimana
//       grid, dropping on a day column computes the target DATE (which of the 7 day
//       columns) + time, keeping the operator. Both optimistically update, POST
//       action=move, and reconcile with the server (revert on error).
//     - EDIT: clicking an appointment block opens the GLOBAL quick-booking drawer
//       (components/quick-booking-drawer.tsx) in EDIT mode — the block carries
//       data-qb-edit={id} and a plain click (vs a drag) triggers the drawer's
//       document-level [data-qb-edit] listener (full services/redeems/pricing).
//     - QUICK-BOOK: clicking an empty cell opens the GLOBAL quick-booking drawer in
//       CREATE mode (the [data-qb-new] path), prefilled with the clicked cell's
//       date/time/operator (data-qb-date/data-qb-time/data-qb-staff). The legacy
//       static #apptModal markup is kept but no longer used for quick-book.
//     - RESIZE (duration change): blocks carry a bottom-edge resize handle (in BOTH the
//       Giorno and Settimana grids); dragging it snaps the new end to SNAP_MIN and POSTs
//       action=resize (a duration-preserving end write, optimistic + revert on error).
//   Modals are reproduced verbatim as static Bootstrap markup but are now
//   controller-less for quick-book (the global drawer handles create/edit); only the
//   calendar-notes modal behavior is still attached.

type CalendarStaff = {
  id: number;
  name: string;
  email: string;
  color: string;
  photoPath: string;
};

type CalendarService = {
  id: number;
  name: string;
  duration?: string;
  price?: string;
  locationIds?: number[];
};

type CalendarLocation = { id: number; name: string };

type CalendarNote = {
  id: number;
  noteDate: string;
  title: string;
  noteText: string;
  createdByName: string;
  updatedByName: string;
  updatedAtLabel: string;
};

type CalendarBusinessHour = {
  dow: number;
  locationId: number | null;
  openTime: string;
  closeTime: string;
  // Second (afternoon) interval of a split schedule, e.g. 09:00-13:00 + 15:00-19:00.
  // The lunch BREAK is the gap between closeTime and openTime2. Empty when the day
  // is a single interval. (Faithful port of business_hours.opens2/closes2.)
  openTime2?: string;
  closeTime2?: string;
  isClosed: boolean;
};

// A date the store is fully CLOSED (Impostazioni → Chiusure). Faithful to the
// closures table (calendar.php) — drives the whole-column "Chiuso" shading.
type CalendarClosure = {
  date: string;
  locationId: number | null;
};

// A per-date business-hours override (Impostazioni → Straordinari). When present it
// REPLACES the day-of-week hours for that date and wins even over closures
// (specialOpenRowForDateKey in calendar.js): a normally-closed date can be opened,
// or a date given custom (possibly split) hours.
type CalendarBusinessHourException = {
  date: string;
  locationId: number | null;
  openTime: string;
  closeTime: string;
  openTime2?: string;
  closeTime2?: string;
  isClosed: boolean;
};

type CalendarContextResponse = {
  ok?: boolean;
  date?: string;
  staff?: CalendarStaff[];
  // The logged-in operator's linked staff id (0 = none). Pinned first in the Day view.
  currentStaffId?: number;
  // Saved per-user column order for the OTHER operators (the pinned one is excluded).
  staffOrder?: number[];
  locations?: CalendarLocation[];
  services?: CalendarService[];
  notes?: CalendarNote[];
  countByDate?: Record<string, number>;
  businessHours?: CalendarBusinessHour[];
  closures?: CalendarClosure[];
  exceptions?: CalendarBusinessHourException[];
  // Per-staff grey unavailability ranges for the Day view (minutes-of-day) —
  // port of the legacy include_unavailability background events (off-shift +
  // time-off clipped to the store's open intervals).
  staffUnavailability?: Array<{ staffId: number; start: number; end: number }>;
  // Permessi (calendar.php:7-8): manage = drag/resize/click-Modifica/note-write;
  // quick_booking = crea da slot vuoto.
  canManageAppointments?: boolean;
  canCreateAppointments?: boolean;
};

type Appointment = {
  id: number;
  date: string;
  locationId?: number;
  time: string;
  // End time HH:MM (from the API's additive endTime / appointments.ends_at). Drives
  // the rendered block height when present, so a custom (resized) duration shows;
  // falls back to DEFAULT_DURATION_MIN when absent. Optimistically patched on resize.
  endTime?: string;
  client: string;
  service: string;
  // ALL ordered service lines (one per appointment_services row) returned by the
  // appointments list API (services: [{serviceId,name,price}]). `service` above is
  // just the PRIMARY (first) line; the calendar blocks list EVERY service name here,
  // faithful to the legacy multi-service block (operator bullet + a bullet per
  // service). Absent/empty -> the blocks fall back to the single `service`.
  services?: { serviceId: number; name: string; price?: string }[];
  operator: string;
  // Id dell'operatore primario (appointment_staff). Il calendario piazza i blocchi
  // nella colonna PER ID (come il legacy per staff_id): il solo `operator` (nome) non
  // distingue due operatori omonimi. Assente sui dati vecchi -> fallback al nome.
  operatorId?: number;
  room?: string;
  price?: string;
  status: string;
  // Real php status code (pending|scheduled|done|canceled|no_show); the list API's
  // `status` is the collapsed 3-state UI label, so prefer statusCode for the pill.
  statusCode?: string;
  // Per-segment windows (present when the appointment has >1 appointment_segments
  // row, legacy HAVING COUNT(*) > 1): the calendar renders one block PER SEGMENT
  // (in the matching staff column in the Day view). segmentId feeds the drag-move
  // delta payload (move + segment_id + old_starts_at/old_ends_at).
  segments?: { segmentId: number; serviceId: number; serviceName: string; staffId: number; staffName: string; time: string; endTime: string }[];
};

type CalendarView = "staffTimeGridDay" | "timeGridWeek" | "dayGridMonth";

// staffColorHex (calendar.js 1052-1071): colore colonna dell'operatore, con
// FALLBACK deterministico dalla palette pastello per abs(id)%10 quando il
// colore salvato manca/è invalido; id<=0 (colonna fittizia/na) -> #e5e7eb.
const STAFF_FALLBACK_PALETTE = ["#fca5a5", "#fdba74", "#fcd34d", "#fde68a", "#a7f3d0", "#6ee7b7", "#67e8f9", "#93c5fd", "#c4b5fd", "#f9a8d4"];
function staffColorHex(staffId: number, color?: string): string {
  const sid = Number(staffId) || 0;
  if (sid <= 0) return "#e5e7eb";
  let c = String(color ?? "").trim();
  if (c && !c.startsWith("#")) c = `#${c}`;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return STAFF_FALLBACK_PALETTE[Math.abs(sid) % STAFF_FALLBACK_PALETTE.length];
}

// Un blocco/segmento appartiene alla colonna operatore `col` se corrisponde per ID
// (robusto agli operatori OMONIMI, come il legacy che piazza per staff_id); fallback
// al NOME solo quando l'id non è disponibile su uno dei due lati (dati vecchi).
function staffColMatches(col: { id: number; name: string }, staffId: number | undefined, staffName: string | undefined): boolean {
  if (col.id > 0 && staffId && staffId > 0) return staffId === col.id;
  const t = (col.name || "").trim().toLowerCase();
  if (!t) return false;
  return (staffName || "").trim().toLowerCase() === t;
}

// Match SEGMENT-AWARE per i filtri calendario. Il legacy filtra lato server per
// staff_id / service_id, che matchano QUALSIASI operatore/servizio dell'appuntamento
// (anche di un segmento non primario), non solo il primario.
function apptInvolvesStaff(a: Appointment, col: { id: number; name: string }): boolean {
  if (!(col.id > 0) && !col.name.trim()) return true;
  if (staffColMatches(col, a.operatorId, a.operator)) return true;
  return (a.segments ?? []).some((seg) => staffColMatches(col, seg.staffId, seg.staffName));
}
// Risolve l'operatore (pallino colore/foto nelle viste Settimana/Mese) PER ID quando
// disponibile — due operatori OMONIMI mostrano così il colore corretto; fallback al
// nome per i dati senza id.
function findOperatorStaff(
  staff: CalendarStaff[],
  block: { operatorId?: number; segStaffId?: number; operator?: string },
): CalendarStaff | undefined {
  const id = Number(block.segStaffId ?? block.operatorId ?? 0) || 0;
  if (id > 0) {
    const byId = staff.find((s) => s.id === id);
    if (byId) return byId;
  }
  const t = (block.operator || "").trim().toLowerCase();
  if (!t) return undefined;
  return staff.find((s) => (s.name || "").trim().toLowerCase() === t);
}

function apptIncludesService(a: Appointment, serviceName: string): boolean {
  const t = serviceName.trim().toLowerCase();
  if (!t) return true;
  if ((a.service || "").trim().toLowerCase() === t) return true;
  if ((a.services ?? []).some((s) => (s.name || "").trim().toLowerCase() === t)) return true;
  return (a.segments ?? []).some((seg) => (seg.serviceName || "").trim().toLowerCase() === t);
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}

const IT_WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const IT_MONTHS = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

function capFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function longTitle(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${capFirst(IT_WEEKDAYS[d.getDay()] ?? "")} ${d.getDate()} ${IT_MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`;
}

// Group calendar notes by their date (preserving the list's note_date ASC order) so the
// notes modal renders one .calendar-note-day-group per day with a header + count badge,
// faithful to the legacy renderCalendarNotesList (calendar.js:708-746).
function groupNotesByDate<T extends { noteDate: string }>(items: T[]): Array<{ date: string; items: T[] }> {
  const byDate = new Map<string, T[]>();
  const groups: Array<{ date: string; items: T[] }> = [];
  for (const item of items) {
    let bucket = byDate.get(item.noteDate);
    if (!bucket) {
      bucket = [];
      byDate.set(item.noteDate, bucket);
      groups.push({ date: item.noteDate, items: bucket });
    }
    bucket.push(item);
  }
  return groups.sort((a, b) => a.date.localeCompare(b.date));
}

// Monday-first IT short weekday headers (Lun..Dom), matching itShortWeekdayLabel
// in calendar.js (index 0 == Monday).
const IT_SHORT_WEEKDAYS_MON = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

// Monday of the week containing `iso` (FullCalendar's firstDay=1 / startOfWeek).
function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const dow = d.getDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  return addDays(iso, -back);
}

// The 7 ISO dates Mon..Sun for the week containing `iso`.
function weekDates(iso: string): string[] {
  const start = weekStart(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// First cell (Monday-aligned) of the 6x7 month grid containing `iso`, and the 42
// ISO dates that fill it (mirrors FullCalendar's dayGridMonth fixed 6-week grid).
function monthGridStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const firstOfMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
  return weekStart(firstOfMonth);
}
function monthGridDates(iso: string): string[] {
  const start = monthGridStart(iso);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

// Titolo toolbar vista SETTIMANA — port FEDELE di updateCalendarTitle
// (calendar.js:1226-1236): include i NOMI dei giorni. Stessa settimana/mese:
// "Lunedì 6 - Domenica 12 luglio 2026"; a cavallo mese/anno: "Lunedì 29 giugno
// 2026 - Domenica 5 luglio 2026" (anno su entrambi).
function weekRangeTitle(iso: string): string {
  const dates = weekDates(iso);
  const a = new Date(`${dates[0]}T12:00:00`);
  const b = new Date(`${dates[6]}T12:00:00`);
  const sameMY = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const wa = capFirst(IT_WEEKDAYS[a.getDay()] ?? "");
  const wb = capFirst(IT_WEEKDAYS[b.getDay()] ?? "");
  const ma = IT_MONTHS[a.getMonth()] ?? "";
  const mb = IT_MONTHS[b.getMonth()] ?? "";
  if (sameMY) return `${wa} ${a.getDate()} - ${wb} ${b.getDate()} ${mb} ${b.getFullYear()}`;
  return `${wa} ${a.getDate()} ${ma} ${a.getFullYear()} - ${wb} ${b.getDate()} ${mb} ${b.getFullYear()}`;
}

// Titolo toolbar vista MESE — port FEDELE di updateCalendarTitle
// (calendar.js:1239-1245): range dal PRIMO all'ULTIMO giorno del mese coi nomi
// giorni, es. "Mercoledì 1 - Venerdì 31 luglio 2026".
function monthViewTitle(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const wf = capFirst(IT_WEEKDAYS[first.getDay()] ?? "");
  const wl = capFirst(IT_WEEKDAYS[last.getDay()] ?? "");
  return `${wf} ${first.getDate()} - ${wl} ${last.getDate()} ${IT_MONTHS[last.getMonth()] ?? ""} ${last.getFullYear()}`;
}

// Etichetta mese+anno (port di itLongMonthYear), capitalizzata: "Giugno 2026" —
// usata SOLO dal mini date-picker (header in modalità giorno/settimana).
function monthTitle(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return capFirst(`${IT_MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`);
}

// === Mini date-picker helpers (port of the calendar.js datePicker labels) ===
// IT short month labels (Gen..Dic), matching itShortMonthLabel (Intl 'short',
// '.' stripped) — used by the Week range sub-label and the Month grid cells.
const IT_SHORT_MONTHS = [
  "Gen",
  "Feb",
  "Mar",
  "Apr",
  "Mag",
  "Giu",
  "Lug",
  "Ago",
  "Set",
  "Ott",
  "Nov",
  "Dic",
];

// First-of-month / first-of-year ISO anchors for the picker "cursor".
function monthStartIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
// Step the cursor month (Day/Week modes) by ±1 keeping the 1st of the month.
function shiftMonthIso(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00`);
  const next = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-01`;
}
// Step the cursor year (Month mode) by ±1, anchored to 1 January.
function shiftYearIso(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${d.getFullYear() + delta}-01-01`;
}

// Full IT long date for the Day picker footer (port of itLongDate), lowercase —
// the .calendar-mini-picker__selected CSS capitalizes it: "lunedi 1 giugno 2026".
function pickerLongDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${IT_WEEKDAYS[d.getDay()] ?? ""} ${d.getDate()} ${IT_MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`;
}

// Week-range main label (port of itWeekRangeShortLabel): "29-5".
function pickerWeekMain(startIso: string): string {
  const a = new Date(`${startIso}T12:00:00`);
  const b = new Date(`${addDays(startIso, 6)}T12:00:00`);
  return `${a.getDate()}-${b.getDate()}`;
}
// Week-range sub label (port of itWeekRangeSubLabel): same month -> "Giugno";
// cross-month same year -> "Giu · Lug"; cross-year -> "Giu 2026 · Lug 2027".
function pickerWeekSub(startIso: string): string {
  const a = new Date(`${startIso}T12:00:00`);
  const b = new Date(`${addDays(startIso, 6)}T12:00:00`);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameMonth) return capFirst(IT_MONTHS[a.getMonth()] ?? "");
  if (sameYear) return `${IT_SHORT_MONTHS[a.getMonth()] ?? ""} · ${IT_SHORT_MONTHS[b.getMonth()] ?? ""}`;
  return `${IT_SHORT_MONTHS[a.getMonth()] ?? ""} ${a.getFullYear()} · ${IT_SHORT_MONTHS[b.getMonth()] ?? ""} ${b.getFullYear()}`;
}
// Week-range long label for the footer/aria (port of itWeekRangeLongLabel):
// same month -> "29 - 5 giugno 2026"; cross-month -> "29 giugno - 5 luglio 2026".
function pickerWeekLong(startIso: string): string {
  const a = new Date(`${startIso}T12:00:00`);
  const b = new Date(`${addDays(startIso, 6)}T12:00:00`);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const sameYear = a.getFullYear() === b.getFullYear();
  const ma = IT_MONTHS[a.getMonth()] ?? "";
  const mb = IT_MONTHS[b.getMonth()] ?? "";
  if (sameMonth) return `${a.getDate()} - ${b.getDate()} ${mb} ${b.getFullYear()}`;
  if (sameYear) return `${a.getDate()} ${ma} - ${b.getDate()} ${mb} ${b.getFullYear()}`;
  return `${a.getDate()} ${ma} ${a.getFullYear()} - ${b.getDate()} ${mb} ${b.getFullYear()}`;
}

// The 42 ISO dates (6x7, Monday-first) filling the picker's Day grid for the month
// containing `cursorIso` — mirrors renderCalendarDatePickerDays' gridStart logic.
function pickerDayGridDates(cursorIso: string): string[] {
  return monthGridDates(monthStartIso(cursorIso));
}
// The week-start ISO dates (Mondays) whose week overlaps the cursor month —
// mirrors renderCalendarDatePickerWeeks (startOfWeek(first) .. <= endOfMonth).
function pickerWeekStarts(cursorIso: string): string[] {
  const d = new Date(`${cursorIso}T12:00:00`);
  const lastIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
  )}`;
  const out: string[] = [];
  let ws = weekStart(monthStartIso(cursorIso));
  while (ws <= lastIso) {
    out.push(ws);
    ws = addDays(ws, 7);
  }
  return out;
}

// Month number (0-11) of the focused date — used to dim days outside the month in
// the 6-week grid (FullCalendar's fc-day-other).
function monthOf(iso: string): number {
  return new Date(`${iso}T12:00:00`).getMonth();
}

function timeToMin(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Legacy event first row "HH:mm - HH:mm (NN′)" (calendar.js eventContent ~4350-4365):
// start - end + duration in minutes with the prime mark; start only when no end.
function apptTimeLine(time: string, endTime: string | null | undefined): string {
  if (!time) return "";
  const start = timeToMin(time);
  const end = endTime ? timeToMin(endTime) : null;
  if (start === null || end === null) return time;
  const mins = end - start;
  return `${time} - ${endTime}${mins > 0 ? ` (${mins}′)` : ""}`;
}

// Multi-servizio accent palette (calendar.js MS_ACCENT_PALETTE ~3871): colors chosen
// to never collide with the appointment STATUS colors; same group -> same accent.
const MS_ACCENT_PALETTE = [
  "#7c3aed", "#06b6d4", "#f97316", "#84cc16", "#e11d48", "#14b8a6", "#a855f7", "#0ea5e9",
  "#fb7185", "#10b981", "#8b5cf6", "#22c55e", "#eab308", "#ef4444", "#4e6da5",
];
// Colori di STATO da EVITARE per gli accenti MS (calendar.js:3870 MS_STATUS_COLORS).
const MS_STATUS_COLORS = ["#0d6efd", "#f59e0b", "#20c997", "#6c757d", "#dc3545", "#fd7e14"];
// Port di clamp01 + hslToHex (calendar.js:3887-3906) per il fallback golden-angle.
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Conteggio "multi-servizio" = numero di SEGMENTI (il legacy rende un evento per
// segmento; è multi-servizio con HAVING COUNT(segments) > 1). NON usare
// services.length: un appuntamento con più appointment_services ma UN solo segmento
// non è multi-servizio nel legacy (L16). `segments` è popolato solo quando >1.
function msCountOf(a: Appointment): number {
  return a.segments && a.segments.length > 1 ? a.segments.length : 1;
}

// A renderable calendar block: either a whole appointment or ONE segment of a
// multi-servizio booking (the legacy per-segment events). Segment blocks carry
// the segment identity + the ORIGINAL window so the drag-move can post the legacy
// delta contract (move + segment_id + old_starts_at/old_ends_at) and the resize
// handle can be hidden (legacy durationEditable:false on segment events).
type CalBlock = Appointment & {
  segmentId?: number;
  segStaffId?: number;
};

// One VIRTUAL block per segment (the legacy per-segment list events, one event per
// appointment_segments row when the booking has >1) — used by the Week/Month views;
// the Day view does the same inside apptsForStaff with the staff filter.
function expandSegments(list: Appointment[]): CalBlock[] {
  return list.flatMap((a) =>
    a.segments && a.segments.length > 1
      ? a.segments.map((seg) => ({
          ...a,
          time: seg.time,
          endTime: seg.endTime,
          service: seg.serviceName,
          services: [{ serviceId: seg.serviceId, name: seg.serviceName }],
          operator: seg.staffName,
          segmentId: seg.segmentId,
          segStaffId: seg.staffId,
        }))
      : [a as CalBlock],
  );
}

// === GHOST DI SPOSTAMENTO (miglioria UX approvata 2026-07-12) ===
// Durante il drag-move la snapshot HTML5 del browser segue il cursore pixel
// per pixel mentre il drop viene SNAPPATO ai 5' — l'utente non vede dove il
// blocco atterrerà né se la posizione è valida. Il ghost è una banda
// renderizzata nella colonna sotto il cursore, già snappata CON LA STESSA
// matematica del drop (mai una bugia), con orario live e stato pre-verificato
// client-side: 'bad' = fuori finestra o sovrapposto a un altro appuntamento
// (dati già sul client), 'warn' = dentro una banda non-disponibile (il server
// potrebbe rifiutare), 'ok' = libera. Il SERVER resta l'autorità: le guardie
// di action=move non cambiano, il ghost è solo feedback.
type MoveGhost = { col: string; top: number; height: number; label: string; state: "ok" | "warn" | "bad"; note: string };

// Durata del blocco trascinato (fallback alla durata di default come il render).
function moveBlockDurationMin(block: CalBlock): number {
  const s = timeToMin(block.time);
  const e = timeToMin(block.endTime ?? "");
  return s !== null && e !== null && e > s ? e - s : DEFAULT_DURATION_MIN;
}

// Stato di validità della posizione snappata: sovrapposizione con gli ALTRI
// blocchi della colonna (i blocchi dello stesso appuntamento sono esclusi:
// un multi-segmento viene shiftato tutto per delta dal server), sforamento
// della finestra visibile, bande non-disponibile (solo vista Giorno).
function moveGhostStateFor(
  startMin: number,
  durMin: number,
  colBlocks: CalBlock[],
  apptId: number,
  winEnd: number,
  bands?: Array<{ start: number; end: number }>,
): { state: MoveGhost["state"]; note: string } {
  const endMin = startMin + durMin;
  if (endMin > winEnd) return { state: "bad", note: "fuori orario" };
  for (const o of colBlocks) {
    if (Number(o.id) === apptId) continue;
    const os = timeToMin(o.time);
    if (os === null) continue;
    const oe = timeToMin(o.endTime ?? "");
    const oEnd = oe !== null && oe > os ? oe : os + DEFAULT_DURATION_MIN;
    if (startMin < oEnd && endMin > os) return { state: "bad", note: "occupato" };
  }
  if (bands && bands.some((b) => startMin < b.end && endMin > b.start)) {
    return { state: "warn", note: "non disponibile" };
  }
  return { state: "ok", note: "" };
}

// Banda ghost (posizionata dentro il body colonna, non-interattiva).
function renderMoveGhostBand(g: MoveGhost) {
  const palette = g.state === "bad"
    ? { bg: "rgba(220,38,38,.12)", border: "#dc2626", text: "#b91c1c" }
    : g.state === "warn"
      ? { bg: "rgba(245,158,11,.16)", border: "#d97706", text: "#92400e" }
      : { bg: "rgba(47,99,244,.14)", border: "#2f63f4", text: "#1d4ed8" };
  return (
    <div
      className={`cal-move-ghost is-${g.state}`}
      style={{
        position: "absolute",
        left: 2,
        right: 2,
        top: g.top,
        height: g.height,
        zIndex: 7,
        pointerEvents: "none",
        background: palette.bg,
        border: `2px dashed ${palette.border}`,
        borderRadius: 6,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "flex-start",
        padding: "2px 6px",
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: palette.text, background: "rgba(255,255,255,.88)", borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>
        {g.label}
        {g.note ? ` • ${g.note}` : ""}
      </span>
    </div>
  );
}

// === TEMA SOFT PER STATO (port fedele di calendarAppointmentStatusTheme,
// calendar.js 3961-3979 + applyCalendarSoftAppointmentStyle 3981-4008) ===
// Ogni blocco appuntamento riceve sfondo/bordo/testo pastello per STATO + la barra
// accento sinistra (via box-shadow inset su .appt-soft-event in app.css, pilotata
// da --appt-soft-accent). Il pallino operatore resta col colore dell'operatore.
type CalendarStatusTheme = { key: string; bg: string; border: string; accent: string; text: string; muted: string };
const CALENDAR_STATUS_THEMES: Record<string, CalendarStatusTheme> = {
  pending: { key: "pending", bg: "#fff7ed", border: "#fed7aa", accent: "#f59e0b", text: "#7c2d12", muted: "#9a3412" },
  scheduled: { key: "scheduled", bg: "#eff6ff", border: "#bfdbfe", accent: "#4e6da5", text: "#1e3a8a", muted: "#475569" },
  done: { key: "done", bg: "#ecfdf5", border: "#bbf7d0", accent: "#22c55e", text: "#14532d", muted: "#166534" },
  canceled: { key: "canceled", bg: "#f1f5f9", border: "#94a3b8", accent: "#64748b", text: "#334155", muted: "#475569" },
  no_show: { key: "no_show", bg: "#f9fafb", border: "#d1d5db", accent: "#374151", text: "#111827", muted: "#4b5563" },
  rejected: { key: "rejected", bg: "#fdf2f8", border: "#fbcfe8", accent: "#ec4899", text: "#831843", muted: "#9d174d" },
};
const CALENDAR_STATUS_THEME_OTHER: CalendarStatusTheme = { key: "other", bg: "#f8fafc", border: "#dbe4ef", accent: "#64748b", text: "#334155", muted: "#64748b" };
function statusThemeOf(rawStatus: string): CalendarStatusTheme {
  let st = String(rawStatus || "").toLowerCase().trim();
  if (st === "cancelled") st = "canceled";
  if (st === "confirmed") st = "scheduled";
  if (st === "completed") st = "done";
  if (st === "no show" || st === "no-show" || st === "noshow" || st === "non presentato") st = "no_show";
  return CALENDAR_STATUS_THEMES[st] ?? CALENDAR_STATUS_THEME_OTHER;
}
// Stili inline del tema (le CSS var alimentano le regole !important di
// .appt-soft-event in app.css; bg/bordo/testo replicano gli inline del legacy).
function softEventStyle(theme: CalendarStatusTheme): React.CSSProperties {
  return {
    "--appt-soft-bg": theme.bg,
    "--appt-soft-border": theme.border,
    "--appt-soft-accent": theme.accent,
    "--appt-soft-text": theme.text,
    "--appt-soft-muted": theme.muted,
    backgroundColor: theme.bg,
    border: `1px solid ${theme.border}`,
    color: theme.text,
  } as React.CSSProperties;
}

// SQL datetime "YYYY-MM-DD HH:MM:00" per il contratto move legacy (starts_at/ends_at).
function sqlAt(iso: string, time: string): string {
  return `${iso} ${time}:00`;
}
// Shift di un HH:MM di delta minuti (clampato in giornata); orario invalido -> invariato.
function shiftTime(time: string | undefined, deltaMin: number): string | undefined {
  const m = timeToMin(time ?? "");
  if (m === null) return time;
  return minToTime(Math.min(Math.max(m + deltaMin, 0), 24 * 60 - 5));
}
// Durata (minuti) di un blocco dal suo intervallo, col default legacy di 60'.
function blockDurationMin(b: CalBlock): number {
  const s = timeToMin(b.time);
  const e = timeToMin(b.endTime ?? "");
  return s !== null && e !== null && e > s ? e - s : DEFAULT_DURATION_MIN;
}

// Bootstrap modal helpers. Bootstrap's bundle is already loaded by the manage shell
// (the page uses data-bs-* modals elsewhere); we just drive show programmatically for
// the calendar-notes modal. Falls back to a no-op when the API is unavailable so the
// modal degrades to "nothing happens" rather than crashing. (The #apptModal quick-book
// helpers were RETIRED — quick-book now opens the global quick-booking drawer.)
type BootstrapModalApi = {
  getOrCreateInstance: (el: Element) => { show: () => void; hide: () => void };
};
function bootstrapModal(): BootstrapModalApi | null {
  if (typeof window === "undefined") return null;
  const bs = (window as unknown as { bootstrap?: { Modal?: BootstrapModalApi } }).bootstrap;
  return bs?.Modal ?? null;
}
function showNotesModal(): void {
  const el = typeof document !== "undefined" ? document.getElementById("calendarNotesModal") : null;
  const api = bootstrapModal();
  if (el && api) api.getOrCreateInstance(el).show();
}
function showStaffOrderModal(): void {
  const el = typeof document !== "undefined" ? document.getElementById("staffOrderModal") : null;
  const api = bootstrapModal();
  if (el && api) api.getOrCreateInstance(el).show();
}
function hideStaffOrderModal(): void {
  const el = typeof document !== "undefined" ? document.getElementById("staffOrderModal") : null;
  const api = bootstrapModal();
  if (el && api) api.getOrCreateInstance(el).hide();
}

// Sanitize a saved staff-column order list (port of calendar.js normalizeStaffOrder):
// positive integers only, de-duplicated, capped at 200 ids.
function normalizeStaffOrder(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const id = Math.floor(n);
    if (id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

// Reorder the Day-view staff columns: the pinned (logged-in) operator first, then the
// OTHER operators in the saved order, then any remaining operators in natural order.
// Faithful port of calendar.js applyStaffDayColumnsOrdering. The incoming `cols` is the
// operator-FILTERED list, so the filter composes with the ordering.
function applyStaffDayColumnsOrdering<T extends { id: number }>(
  cols: T[],
  pinnedStaffId: number,
  otherOrderIds: number[],
): T[] {
  const pinnedId = Number(pinnedStaffId || 0) || 0;
  let pinned: T | null = null;
  const others: T[] = [];
  for (const s of cols) {
    const sid = Number(s?.id || 0) || 0;
    if (pinnedId > 0 && sid === pinnedId && pinned === null) pinned = s;
    else others.push(s);
  }

  const wanted = normalizeStaffOrder(otherOrderIds);
  const byId = new Map<number, T>();
  for (const s of others) {
    const sid = Number(s?.id || 0) || 0;
    if (sid > 0) byId.set(sid, s);
  }

  const orderedOthers: T[] = [];
  for (const id of wanted) {
    if (pinnedId > 0 && id === pinnedId) continue;
    const s = byId.get(id);
    if (!s) continue;
    orderedOthers.push(s);
    byId.delete(id);
  }
  // Append the operators not in the saved order, keeping their current order.
  for (const s of others) {
    const sid = Number(s?.id || 0) || 0;
    if (sid > 0 && byId.has(sid)) {
      orderedOthers.push(s);
      byId.delete(sid);
    }
  }

  const result = pinned ? [pinned, ...orderedOthers] : orderedOthers;
  return result.length ? result : cols; // safety
}

// Map the Italian status label returned by /api/manage/appointments back to the
// legacy calendar badge key (see calendar.js status map).
function statusKeyFromLabel(label: string): { key: string; label: string } {
  const v = String(label || "").trim().toLowerCase();
  if (v === "in attesa" || v === "pending") return { key: "pending", label: "In attesa" };
  if (v === "prenotato" || v === "scheduled" || v === "confermato" || v === "confirmed")
    return { key: "scheduled", label: "Prenotato" };
  if (v === "eseguito" || v === "done" || v === "completato" || v === "completed")
    return { key: "done", label: "Eseguito" };
  if (v === "annullato" || v === "canceled" || v === "cancelled" || v === "rejected")
    return { key: "canceled", label: "Annullato" };
  if (v === "no show" || v === "no_show" || v === "no-show" || v === "non presentato")
    return { key: "no_show", label: "No show" };
  return { key: "other", label: label || "—" };
}

// The ordered list of ALL service names on an appointment, faithful to the legacy
// multi-service block (it lists each booked service as its own bulleted line, not
// just the primary). Uses the additive `services[]` returned by the appointments
// list API; falls back to the single primary `service` string when `services` is
// absent/empty (single-service or older payloads). Empty names are dropped, and an
// empty result still yields one entry (the primary) so the block always shows a line.
function serviceNamesOf(a: Appointment): string[] {
  const names = (a.services ?? [])
    .map((s) => String(s?.name ?? "").trim())
    .filter(Boolean);
  if (names.length > 0) return names;
  const primary = String(a.service ?? "").trim();
  return primary ? [primary] : [];
}

// All service names joined with " • " for a block's title (hover) attribute, so the
// native tooltip lists EVERY booked service. Falls back to "" when none.
function serviceTitleOf(a: Appointment): string {
  return serviceNamesOf(a).join(" • ");
}

// Pixel grid constants for the static agenda. Faithful to calendar.js
// slotDuration 00:05 + slotLabelInterval 00:30: the grid draws a slot LINE every 5
// minutes (ROW_HEIGHT=17px per 5-min row, matching .fc-timegrid-slot{height:17px} in
// calendar.css) and shows a time LABEL only on the :00/:30 major rows. PX_PER_MIN
// (17/5 = 3.4) drives EVERY vertical position (blocks, now-indicator, store bands,
// hover, drag-select), so the whole grid scales from these two numbers.
const SLOT_MIN_PER_ROW = 5;
const ROW_HEIGHT = 17; // px per 5-min row (calendar.css .fc-timegrid-slot height)
const PX_PER_MIN = ROW_HEIGHT / SLOT_MIN_PER_ROW; // 3.4
// Minutes between LABELLED (major) rows — legacy slotLabelInterval 00:30. Rows whose
// minute-of-day is NOT a multiple of this get the .fc-timegrid-slot-minor class (no
// label, lighter line), like FullCalendar's minor slots.
const SLOT_LABEL_INTERVAL_MIN = 30;
const DEFAULT_DURATION_MIN = 60;
// Snap step for drag-move / quick-book, matching calendar.js snapDuration 00:05:00
// (AXIS_STEP_MINUTES = 5). A dropped/clicked Y position is rounded to this step.
const SNAP_MIN = 5;

function minToTime(min: number): string {
  const clamped = Math.max(0, min);
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

// A grid row is MAJOR (labelled, darker line) when its minute-of-day is a multiple of
// the label interval (30) — like FullCalendar's slotLabelInterval 00:30; otherwise it is
// a MINOR 5-min row (no label, lighter line, .fc-timegrid-slot-minor). Absolute
// minute-of-day is used (not offset from the window start) so labels land on the real
// :00/:30 clock ticks, matching FullCalendar even when the axis opens off a half-hour.
function isMajorRow(min: number): boolean {
  return min % SLOT_LABEL_INTERVAL_MIN === 0;
}
// Border colours for the 5-min slot lines, mirroring calendar.css: major (:00/:30) rows
// get the darker #cfdaea top border, minor rows the lighter #edf2f8. Kept inline (in
// addition to the .fc-timegrid-slot-minor class) so the grid renders correctly even
// where the scoped CSS does not match.
const SLOT_LINE_MAJOR = "#cfdaea";
const SLOT_LINE_MINOR = "#edf2f8";

function snapMin(min: number, step: number): number {
  return Math.round(min / step) * step;
}

// Slot-rounding for the dynamic axis (port of calendar.js _roundDown / _roundUp):
// round a minute-of-day DOWN / UP to the slot granularity (SLOT_MIN_PER_ROW).
function roundDownToSlot(min: number): number {
  return Math.floor(min / SLOT_MIN_PER_ROW) * SLOT_MIN_PER_ROW;
}
function roundUpToSlot(min: number): number {
  return Math.ceil(min / SLOT_MIN_PER_ROW) * SLOT_MIN_PER_ROW;
}

// DYNAMIC AXIS (port of calendar.js _computeDynamicAxisForEvents): expand the
// business-hours window [open, close] so every appointment fits. If any appointment
// STARTS before `open`, drop the window start down to that start (rounded DOWN to the
// slot); if any ENDS after `close`, push the window end up to that end (rounded UP to
// the slot). With no events the window stays at the business-hours baseline.
function expandWindowForAppointments(
  open: number,
  close: number,
  appts: Appointment[],
): { open: number; close: number } {
  let evMin: number | null = null;
  let evMax: number | null = null;
  for (const a of appts) {
    const sMin = timeToMin(a.time);
    if (sMin !== null) evMin = evMin === null ? sMin : Math.min(evMin, sMin);
    // End falls back to the start when no end is recorded (mirrors the legacy, which
    // uses the start as the end when ev.end is null).
    let eMin = timeToMin(a.endTime ?? "");
    if (eMin === null) eMin = sMin;
    if (eMin !== null) evMax = evMax === null ? eMin : Math.max(evMax, eMin);
  }
  let outOpen = open;
  let outClose = close;
  if (evMin !== null) outOpen = Math.min(outOpen, roundDownToSlot(evMin));
  if (evMax !== null) outClose = Math.max(outClose, roundUpToSlot(evMax));
  // Sanity: keep a positive range (port of the legacy outMax <= outMin guard).
  if (outClose <= outOpen) outClose = Math.min(24 * 60, outOpen + SLOT_MIN_PER_ROW);
  return { open: outOpen, close: outClose };
}

// Current minute-of-day from the local clock — drives the now-indicator line.
function nowMinutesOfDay(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// === STORE-BACKGROUND BANDS (port of buildStoreBreakEventsForView + the FullCalendar
// non-business / closed-day shading) ===
// A single absolutely-positioned background band inside a column body. `top`/`height`
// are px (mapped like an appointment block: minutes-from-window-start * PX_PER_MIN).
// `kind` selects the legacy CSS class: a lunch BREAK gap (store-break-time), the
// before-open / after-close non-business region (fc-non-business — transparent in this
// theme, faithful to the legacy), or a fully-closed day (store-closed-day).
type StoreBand = { key: string; kind: "break" | "nonbusiness" | "closed"; top: number; height: number };

// Compute the background bands for one column-date given its effective schedule
// (closed flag + open intervals, minutes-of-day) and the visible window [winMin,
// winMax] (minutes). Mirrors storeBreakRangesForDate (gaps between consecutive open
// intervals) plus the FullCalendar non-business shading before the first open / after
// the last close, and the whole-column closed shading when the day has no intervals.
function storeBandsForColumn(
  schedule: { closed: boolean; intervals: { start: number; end: number }[] },
  winMin: number,
  winMax: number,
): StoreBand[] {
  const out: StoreBand[] = [];
  const toPx = (min: number) => (min - winMin) * PX_PER_MIN;
  // Clamp a [start,end] range to the visible window and emit a band if it has height.
  const emit = (kind: StoreBand["kind"], start: number, end: number, key: string) => {
    const s = Math.max(start, winMin);
    const e = Math.min(end, winMax);
    if (e <= s) return;
    out.push({ key, kind, top: toPx(s), height: (e - s) * PX_PER_MIN });
  };

  // Fully closed (is_closed / in closures / special-open with no intervals): shade the
  // whole visible window as closed.
  if (schedule.closed || schedule.intervals.length === 0) {
    emit("closed", winMin, winMax, "closed");
    return out;
  }

  const intervals = schedule.intervals;
  const firstOpen = intervals[0].start;
  const lastClose = intervals[intervals.length - 1].end;

  // Non-business BEFORE the first open and AFTER the last close, within the window.
  emit("nonbusiness", winMin, firstOpen, "pre");
  emit("nonbusiness", lastClose, winMax, "post");

  // BREAK gaps between consecutive open intervals (closes -> next opens).
  for (let i = 0; i < intervals.length - 1; i++) {
    const gapStart = intervals[i].end;
    const gapEnd = intervals[i + 1].start;
    if (gapEnd > gapStart) emit("break", gapStart, gapEnd, `break-${i}`);
  }

  return out;
}

// Map a band to its legacy CSS classes. In the Day view the break/closed bands carry
// the per-staff-column suffix (-staffday / -master on the first column) like
// buildStoreBreakEventsForView, so calendar/app.css styles them identically. The
// non-business band reuses .fc-non-business (transparent via --fc-non-business-color,
// faithful to the legacy, which does NOT visibly shade out-of-hours time).
function storeBandClass(kind: StoreBand["kind"], dayView: boolean, firstCol: boolean): string {
  if (kind === "nonbusiness") return "fc-non-business";
  if (kind === "break") {
    const cls = ["store-break-time"];
    if (dayView) {
      cls.push("store-break-time-staffday");
      if (firstCol) cls.push("store-break-time-master");
    }
    return cls.join(" ");
  }
  // closed
  const cls = ["store-closed-day"];
  if (dayView) {
    cls.push("store-closed-day-staffday");
    if (firstCol) cls.push("store-closed-day-master");
  }
  return cls.join(" ");
}

// Drag payload moved between an appointment block and a staff/grid drop target.
type CalendarDrag = {
  id: number;
  // Pointer offset (px) from the top of the dragged block to the grab point, so the
  // drop maps the block's TOP (its start time), not the cursor, to the new slot.
  grabOffsetPx: number;
  // The dragged BLOCK (whole appointment or one segment): carries the original
  // window + segment identity for the legacy move payload (segment_id + old_*).
  block: CalBlock;
};

// In-flight RESIZE payload: which appointment's bottom edge is being dragged, the
// block's start time (kept fixed), the column-body top (page Y) so the live end time
// can be mapped from the cursor, and the latest snapped end (committed on mouseup).
// winStart/winEnd are the dragged column body's visible window (minutes) so the
// cursor->time map + clamp work for BOTH the Day (minMin/maxMin) and the Week
// (weekMinMin/weekMaxMin) grids — captured at mousedown from the body's data-* attrs,
// so the resize effect never has to depend on the active view.
type CalendarResize = {
  id: number;
  startMin: number;
  bodyTopPx: number;
  winStart: number;
  winEnd: number;
  endTime: string;
};

export function CalendarContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prefer the slug passed by the server page so SSR-rendered links (e.g. the toolbar
  // "Lista" button) use the real tenant slug instead of "" (window is unavailable on the
  // server), avoiding a "//appointments" href + hydration mismatch. Falls back to the
  // window-derived slug when rendered without the prop.
  const slug = slugProp || tenantSlug();

  const [date, setDate] = useState<string>(() => isoLocal(new Date()));
  const [view, setView] = useState<CalendarView>("staffTimeGridDay");
  const [staff, setStaff] = useState<CalendarStaff[]>([]);
  const [services, setServices] = useState<CalendarService[]>([]);
  const [notes, setNotes] = useState<CalendarNote[]>([]);
  // GAP 5: when a day's note marker is clicked (week view) the notes modal filters to just
  // that day ("Giorno selezionato"); null = show the whole visible period ("Periodo visibile").
  const [notesFilterDate, setNotesFilterDate] = useState<string | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [businessHours, setBusinessHours] = useState<CalendarBusinessHour[]>([]);
  // Date-level overrides used to shade the grid: closures (fully closed dates) and
  // business_hours_exceptions / special-open (per-date custom or extra opening). Both
  // are already returned by /api/manage/calendar (calendarContext) for the visible
  // range; they feed the per-column open-interval computation below.
  const [closures, setClosures] = useState<CalendarClosure[]>([]);
  const [exceptions, setExceptions] = useState<CalendarBusinessHourException[]>([]);
  // Staff-column ordering (Day view). currentStaffId is the logged-in operator's
  // own column (always pinned first); savedStaffOrder is the persisted order of the
  // OTHER operators (port of CURRENT_STAFF_ID + SAVED_DAY_STAFF_ORDER).
  const [currentStaffId, setCurrentStaffId] = useState<number>(0);
  const [savedStaffOrder, setSavedStaffOrder] = useState<number[]>([]);
  // Note count per ISO date for the visible range (Week/Month note markers).
  const [countByDate, setCountByDate] = useState<Record<string, number>>({});
  // Per-staff grey unavailability ranges for the Day view (legacy
  // include_unavailability: off-shift + time-off, clipped to store hours).
  const [staffUnavail, setStaffUnavail] = useState<Array<{ staffId: number; start: number; end: number }>>([]);
  // Permessi (dal contesto /api/manage/calendar): come il legacy calendar.php:7-8.
  // canManage = drag/resize/click-Modifica/scrittura note; canCreate = crea da slot
  // vuoto. Default false: nessuna affordance finché il contesto non è caricato
  // (il calendario è comunque vuoto/loading fino ad allora). Il server resta il
  // vero confine di autorizzazione.
  const [canManage, setCanManage] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  // Loading overlay lifecycle (port of calendarSetLoading / calendarSetLoadError,
  // calendar.js ~88-140): the "Caricamento prenotazioni..." card appears only after
  // 120ms of loading (anti-flicker) and hides 100ms after the load settles; a failed
  // appointments fetch flips it to the error state with the Riprova button.
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (loading) {
      const t = window.setTimeout(() => setOverlayVisible(true), 120);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setOverlayVisible(false), 100);
    return () => window.clearTimeout(t);
  }, [loading]);
  // Viewport-height agenda (port of computeCalendarViewportHeight /
  // syncCalendarViewportHeight, calendar.js ~347-397): the legacy sizes the whole
  // calendar to the visible viewport (shell minimum 360/400/420 by breakpoint) and
  // FullCalendar's inner scroller scrolls the time grid — the PAGE does not grow
  // with the day's slots. We measure the grid harness top and give it the
  // remaining viewport space; the inner .fc-scroller scrolls vertically with
  // sticky column headers (Day/Week; Month stays auto-height like the legacy grid).
  const harnessRef = useRef<HTMLDivElement | null>(null);
  const [agendaViewportHeight, setAgendaViewportHeight] = useState(0);
  useEffect(() => {
    const compute = () => {
      const el = harnessRef.current;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (!el || !vh) return;
      const width = window.innerWidth || 0;
      const gap = width <= 575 ? 12 : 16;
      // Legacy minimums are for the whole shell (toolbar included, ~72px above
      // the harness): 360 / 400 / 420 — the harness keeps what remains.
      const minShell = width <= 575 ? 360 : width <= 991 ? 400 : 420;
      const available = Math.floor(vh - Math.max(0, el.getBoundingClientRect().top) - gap);
      setAgendaViewportHeight(Math.max(minShell - 72, available));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Current minute-of-day for the now-indicator line (port of FullCalendar's
  // nowIndicator + calendar.js installStaffNowIndicatorFix). Ticked every 30s by an
  // effect-scoped interval; only set inside the interval callback (never synchronously
  // in the effect body), so it never re-binds per render and stays lint-clean.
  const [nowMinutes, setNowMinutes] = useState<number>(() => nowMinutesOfDay());

  // === HOVER TIME INDICATOR (port of calendar.js ensureCalendarHoverTimeIndicator /
  // getCalendarHoverTimeInfoFromPoint / renderCalendarHoverTimeFromPoint) ===
  // As the pointer moves over a column body, `hover` carries the column it is over
  // (`col`: staff id in Day / iso date in Week), the snapped time's pixel offset
  // (`lineTop`, from the window start), the SLOT band offset (`slotTop` — the 5-min
  // row), and the HH:MM `label` (snapped to SNAP_MIN). null hides the overlay. It is
  // set ONLY inside the rAF callback driven by the pointer handler (never in an
  // effect), so there is no set-state-in-effect. A rAF id + last-point ref throttle the
  // updates (port of scheduleCalendarHoverTimeUpdate).
  const [hover, setHover] = useState<{ col: string; lineTop: number; slotTop: number; label: string } | null>(null);
  const hoverRafRef = useRef<number>(0);
  const hoverPendingRef = useRef<{ col: string; lineTop: number; slotTop: number; label: string } | null>(null);

  // === DRAG-SELECT (port of the FullCalendar `select:` handler) ===
  // While the pointer is pressed and dragging on an empty column body, `dragSelect`
  // carries the column (`col`), the staff id to quick-book against (`staffId`, Day =
  // the column's operator, Week = none), the press time (`startMin`) and the current
  // pointer time (`curMin`), both snapped to SNAP_MIN within the window. A live band is
  // drawn from min(start,cur) to max(start,cur); on release (mouseup) a span of >= one
  // SNAP_MIN slot opens the quick-book drawer prefilled with both times (honoring the
  // duration); a zero-length drag (a plain click) is handled by the body onClick.
  const dragSelectRef = useRef<{ col: string; staffId: number; cellDate?: string; bodyTopPx: number; startMin: number; curMin: number } | null>(null);
  const [dragSelect, setDragSelect] = useState<{ col: string; startMin: number; curMin: number } | null>(null);
  // Set true on the mouseup that COMMITS a range (the drawer opened); the body's onClick
  // checks + clears it so the trailing click of a drag does not also single-slot
  // quick-book (a double-open). A zero-length drag leaves it false so the click books.
  const dragSelectJustCommittedRef = useRef(false);

  // Filters (drive React state; faithful to #filterStaff/#filterService/#filterStatus).
  const [filterStaff, setFilterStaff] = useState("");
  const [filterService, setFilterService] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  // Drag-move state. dragRef holds the in-flight payload (the dragged block + the
  // grab offset); move/resize errors are surfaced via window.alert (legacy parity).
  const dragRef = useRef<CalendarDrag | null>(null);
  // GHOST di spostamento: banda snappata con orario/validità nella colonna sotto
  // il cursore (vedi MoveGhost a livello modulo). Il ref evita setState ripetuti
  // sulla stessa posizione snappata (dragover spara a ogni pixel).
  const [moveGhost, setMoveGhost] = useState<MoveGhost | null>(null);
  const moveGhostRef = useRef<MoveGhost | null>(null);
  const updateMoveGhost = useCallback((g: MoveGhost | null) => {
    const prev = moveGhostRef.current;
    if (g && prev && prev.col === g.col && prev.top === g.top && prev.height === g.height && prev.state === g.state) return;
    if (!g && !prev) return;
    moveGhostRef.current = g;
    setMoveGhost(g);
  }, []);
  // Appuntamento in trascinamento: TUTTI i suoi blocchi/segmenti vengono
  // attenuati (il server shifta l'intero booking per delta) così è chiaro
  // COSA si sta spostando e il ghost resta l'unica destinazione.
  const [draggingApptId, setDraggingApptId] = useState(0);
  // Drag-image trasparente: sopprime la snapshot nativa del browser (che si
  // muove non-snappata e confonderebbe rispetto al ghost).
  const dragImageRef = useRef<HTMLImageElement | null>(null);
  const applyGhostDragImage = useCallback((e: ReactDragEvent<HTMLElement>) => {
    try {
      if (!dragImageRef.current && typeof document !== "undefined") {
        const img = document.createElement("img");
        img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        dragImageRef.current = img;
      }
      if (dragImageRef.current) e.dataTransfer.setDragImage(dragImageRef.current, 0, 0);
    } catch { /* ignore */ }
  }, []);
  const clearMoveGhost = useCallback(() => {
    updateMoveGhost(null);
    setDraggingApptId(0);
  }, [updateMoveGhost]);
  // AUTO-SCROLL ai bordi durante il drag (port del dragScroll di FullCalendar):
  // i browser non auto-scrollano affidabilmente gli scroller INTERNI durante un
  // drag HTML5 (Firefox mai; Chrome quasi mai senza drag-image nativa, che qui
  // è soppressa). Chiamato da ogni dragover: quando il cursore è entro EDGE px
  // dal bordo dello .fc-scroller, scorre di un passo proporzionale alla
  // vicinanza (il dragover rispara di continuo → scroll fluido). Verticale +
  // orizzontale (la vista Giorno scorre anche in X con molti operatori);
  // fallback sulla finestra per la vista Mese (nessuno scroller interno).
  const autoScrollOnDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    const EDGE = 56;
    const MAX_STEP = 26;
    const step = (dist: number) => Math.ceil(((EDGE - dist) / EDGE) * MAX_STEP);
    const scroller = (e.currentTarget as HTMLElement).closest(".fc-scroller") as HTMLElement | null;
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      const r = scroller.getBoundingClientRect();
      if (e.clientY < r.top + EDGE) scroller.scrollTop -= step(e.clientY - r.top);
      else if (e.clientY > r.bottom - EDGE) scroller.scrollTop += step(r.bottom - e.clientY);
    }
    if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
      const r = scroller.getBoundingClientRect();
      if (e.clientX < r.left + EDGE) scroller.scrollLeft -= step(e.clientX - r.left);
      else if (e.clientX > r.right - EDGE) scroller.scrollLeft += step(r.right - e.clientX);
    }
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) {
      // Mese (o griglia non scrollabile): scorre la PAGINA.
      const vh = window.innerHeight;
      if (e.clientY < EDGE) window.scrollBy(0, -step(e.clientY));
      else if (e.clientY > vh - EDGE) window.scrollBy(0, step(vh - e.clientY));
    }
  }, []);
  // In-flight resize (bottom-edge drag). Held in a ref (no re-render per mouse move);
  // a non-null `resizePreview` mirrors the live snapped end so the block stretches.
  const resizeRef = useRef<CalendarResize | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: number; endTime: string } | null>(null);
  // Esito nel #calendarNotesAlert: errore (danger) o conferma (success), come
  // showCalendarNotesAlert(msg, type) del legacy.
  const [notesAlert, setNotesAlert] = useState<{ text: string; kind: "danger" | "success" } | null>(null);

  // === Staff-column ordering modal (#staffOrderModal) state ===
  // staffOrderRows is the working order of the OTHER operators (excludes the pinned
  // one) being edited in the modal; it seeds from the live staffCols when opened and
  // is mutated by drag-drop / up-down before Save. staffOrderError mirrors #staffOrderErr.
  const [staffOrderRows, setStaffOrderRows] = useState<CalendarStaff[]>([]);
  const [staffOrderError, setStaffOrderError] = useState("");
  const [staffOrderSaving, setStaffOrderSaving] = useState(false);
  // Index of the row being dragged (HTML5 DnD), or null.
  const staffOrderDragIndexRef = useRef<number | null>(null);

  // === "Data" date-picker popover (port of the calendar.js mini date-picker) ===
  // Whether the popover is open, and the browse "cursor" (ISO) — the month/year being
  // browsed by the ‹ › steppers, which moves WITHOUT changing the selected `date`
  // until a cell is clicked (faithful to __calendarDatePickerCursor). The picker MODE
  // (day/week/month grid) follows the current `view`, like getCalendarDatePickerMode.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<string>(() => isoLocal(new Date()));
  // Wraps the toolbar chunk that hosts the Data button; used as the positioned
  // ancestor for the absolutely-placed popover and for outside-click detection.
  const pickerHostRef = useRef<HTMLDivElement | null>(null);

  // The visible date RANGE (half-open [from, to)) for the active view, used to
  // fetch appointments + notes across the whole grid (not just one day):
  //   - Day  -> [date, date+1)        (single day, unchanged behavior)
  //   - Week -> [Monday, Monday+7)    (Mon..Sun of the focused week)
  //   - Month-> [gridStart, +42 days) (FullCalendar's fixed 6x7 month grid)
  // listDbAppointments treats start/end as a half-open starts_at window, and the
  // calendar context's countByDate covers the same start/end span.
  const visibleRange = useMemo(() => {
    if (view === "timeGridWeek") {
      const from = weekStart(date);
      return { from, to: addDays(from, 7) };
    }
    if (view === "dayGridMonth") {
      const from = monthGridStart(date);
      return { from, to: addDays(from, 42) };
    }
    return { from: date, to: addDays(date, 1) };
  }, [view, date]);

  const loadContext = useCallback(
    (forDate: string, range: { from: string; to: string }) => {
      // Reset in microtask: loadContext parte anche dall'effect di mount/nav e un
      // setState sincrono lì innescherebbe render a cascata (lint). loading parte
      // già true al mount; il .finally della fetch arriva sempre dopo.
      Promise.resolve().then(() => {
        setLoading(true);
        setLoadError("");
      });
      // Context (staff/services/notes/businessHours + per-date note counts) for the
      // whole visible range. `date` keeps the day-of-week business-hours fallback
      // working; start/end widen the notes window so Week/Month markers are complete.
      const params = new URLSearchParams({ slug, date: forDate, start: range.from, end: range.to });
      fetch(`/api/manage/calendar?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j: CalendarContextResponse) => {
          setStaff(Array.isArray(j.staff) ? j.staff : []);
          setServices(Array.isArray(j.services) ? j.services : []);
          setNotes(Array.isArray(j.notes) ? j.notes : []);
          setBusinessHours(Array.isArray(j.businessHours) ? j.businessHours : []);
          setClosures(Array.isArray(j.closures) ? j.closures : []);
          setExceptions(Array.isArray(j.exceptions) ? j.exceptions : []);
          setCountByDate(j.countByDate && typeof j.countByDate === "object" ? j.countByDate : {});
          setStaffUnavail(Array.isArray(j.staffUnavailability) ? j.staffUnavailability : []);
          setCurrentStaffId(Number(j.currentStaffId ?? 0) || 0);
          setSavedStaffOrder(normalizeStaffOrder(j.staffOrder));
          setCanManage(j.canManageAppointments === true);
          setCanCreate(j.canCreateAppointments === true);
        })
        .catch(() => {
          setStaff([]);
          setServices([]);
          setNotes([]);
          setBusinessHours([]);
          setClosures([]);
          setExceptions([]);
          setCountByDate({});
          setCurrentStaffId(0);
          setStaffUnavail([]);
          setSavedStaffOrder([]);
          setCanManage(false);
          setCanCreate(false);
        });

      // Appointments: a single-day `date` for the Day view (unchanged), or a
      // from/to range for Week/Month (the route lists the half-open span once).
      const apptParams =
        range.to === addDays(range.from, 1)
          ? new URLSearchParams({ slug, action: "list", date: forDate })
          : new URLSearchParams({ slug, action: "list", from: range.from, to: range.to });
      fetch(`/api/manage/appointments?${apptParams.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j: { appointments?: Appointment[] }) => {
          setAppointments(Array.isArray(j.appointments) ? j.appointments : []);
        })
        .catch(() => {
          setAppointments([]);
          // Legacy events-failure message (calendar.js ~4778) -> error overlay + Riprova.
          setLoadError("Non e stato possibile aggiornare gli appuntamenti del calendario.");
        })
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    loadContext(date, visibleRange);
  }, [loadContext, date, visibleRange]);

  // Port di window.calendar.refetchEvents(): il quick-booking drawer NON ricarica
  // la pagina dopo save/delete/annullo (come il legacy) — emette questo evento e
  // il calendario, se montato, ricarica i propri dati in place.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChanged = () => loadContext(date, visibleRange);
    window.addEventListener("qb:appointments-changed", onChanged);
    return () => window.removeEventListener("qb:appointments-changed", onChanged);
  }, [loadContext, date, visibleRange]);

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${`${page}`.replace("&", "?")}`;
  }

  // Open/close window (minutes) for a single day-of-week from business hours.
  // Fallback legacy (calendar.js getStoreScheduleForDow ~2084-2085): un dow
  // senza righe usa il MIN/MAX SETTIMANALE (storeWeekMin/MaxTime), e solo in
  // assenza totale di orari i default 07:00–22:00 (calendar.js:148-149).
  const windowForDow = useCallback(
    (dow: number): { open: number; close: number } => {
      const allOpen = businessHours.filter((b) => !b.isClosed && b.openTime && b.closeTime);
      const weekMin = allOpen.length ? Math.min(...allOpen.map((b) => timeToMin(b.openTime) ?? 7 * 60)) : 7 * 60;
      const weekMax = allOpen.length
        ? Math.max(...allOpen.map((b) => timeToMin(b.closeTime2 || b.closeTime) ?? 22 * 60))
        : 22 * 60;
      const todays = allOpen.filter((b) => b.dow === dow);
      let open = weekMin;
      let close = weekMax;
      if (todays.length) {
        // Vista Giorno legacy: il bound è la chiusura DI QUEL weekday
        // (closes2 || closes), non il massimo settimanale.
        open = Math.min(...todays.map((b) => timeToMin(b.openTime) ?? weekMin));
        close = Math.max(...todays.map((b) => timeToMin(b.closeTime2 || b.closeTime) ?? weekMax));
      }
      return { open, close };
    },
    [businessHours],
  );

  // === STORE SCHEDULE PER DATE (port of getStoreScheduleForDate) ===
  // The effective open INTERVALS (in minutes-of-day) for a specific column-date,
  // applying the same priority as the legacy:
  //   0) special-open / business_hours_exceptions for that date wins over everything
  //      (a normally-closed date can open, or get custom — possibly split — hours);
  //   1) a closure for that date => fully closed (no intervals);
  //   2) otherwise the standard day-of-week business hours, incl. the second
  //      (opens2/closes2) interval. is_closed / missing opens => closed.
  // Intervals are sorted by start; the gaps between consecutive intervals are the
  // store BREAK(s). Returns { closed, intervals: [{start,end}] }.
  const scheduleForDate = useCallback(
    (iso: string): { closed: boolean; intervals: { start: number; end: number }[] } => {
      const pushInterval = (
        list: { start: number; end: number }[],
        open: string | undefined,
        close: string | undefined,
      ) => {
        const s = timeToMin(open ?? "");
        const e = timeToMin(close ?? "");
        if (s !== null && e !== null && e > s) list.push({ start: s, end: e });
      };
      const sortIntervals = (list: { start: number; end: number }[]) =>
        list.sort((a, b) => a.start - b.start);

      // 0) Special-open / exception override for this exact date.
      const sp = exceptions.find((x) => x.date === iso);
      if (sp) {
        if (sp.isClosed) return { closed: true, intervals: [] };
        const intervals: { start: number; end: number }[] = [];
        pushInterval(intervals, sp.openTime, sp.closeTime);
        pushInterval(intervals, sp.openTime2, sp.closeTime2);
        return { closed: intervals.length === 0, intervals: sortIntervals(intervals) };
      }

      // 1) Closure for this date => fully closed.
      if (closures.some((c) => c.date === iso)) return { closed: true, intervals: [] };

      // 2) Standard day-of-week business hours (with the second interval).
      const dow = new Date(`${iso}T12:00:00`).getDay();
      const todays = businessHours.filter((b) => b.dow === dow);
      const intervals: { start: number; end: number }[] = [];
      for (const b of todays) {
        if (b.isClosed) continue;
        // L12: come getStoreScheduleForDow (effectiveClosed = !opens || !closes) il
        // giorno è CHIUSO se manca la PRIMA fascia (mattino), anche se la seconda
        // (pomeriggio) è valorizzata. Salta la riga senza aprire la sola fascia 2.
        const ms = timeToMin(b.openTime ?? "");
        const me = timeToMin(b.closeTime ?? "");
        if (ms === null || me === null || me <= ms) continue;
        pushInterval(intervals, b.openTime, b.closeTime);
        pushInterval(intervals, b.openTime2, b.closeTime2);
      }
      return { closed: intervals.length === 0, intervals: sortIntervals(intervals) };
    },
    [businessHours, closures, exceptions],
  );

  // Render the store-background bands for one column body: the unavailable / break /
  // closed shading for `iso` within the visible window [winMin, winMax]. Each band is
  // an absolutely-positioned, pointer-events:none div at a LOW z-index (0) so it sits
  // BEHIND the slot lines' content, appointment blocks (z auto/positioned), the
  // now-indicator (z 6-7) and quick-book/drag/resize stay fully interactive on top.
  // `dayView` toggles the Day-view per-staff-column class suffixes; `firstCol` marks
  // the first staff column (the -master that carries the single centered label).
  const renderStoreBands = useCallback(
    (iso: string, winMin: number, winMax: number, dayView: boolean, firstCol: boolean) => {
      const schedule = scheduleForDate(iso);
      const bands = storeBandsForColumn(schedule, winMin, winMax);
      if (!bands.length) return null;
      return (
        <>
          {bands.map((b) => (
            <div
              key={b.key}
              className={storeBandClass(b.kind, dayView, firstCol)}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: b.top,
                height: b.height,
                zIndex: 0,
                pointerEvents: "none",
              }}
            />
          ))}
        </>
      );
    },
    [scheduleForDate],
  );

  // Visible time window for the focused date (Day view). Faithful to the legacy
  // getStoreScheduleForDate: the axis bounds are the EFFECTIVE schedule of THIS date,
  // so a special-open (business_hours_exceptions) or closure overrides the standard
  // day-of-week hours. We take the first interval's start (min) and the last interval's
  // end (max) from scheduleForDate(date); when it resolves nothing (closed day / no
  // rows) we fall back to the plain day-of-week window (like the legacy's STORE_WEEK_*
  // baseline). The dynamic axis then EXPANDS this so out-of-hours appointments on `date`
  // are not clipped (a booking starting before open / ending after close widens it,
  // rounded to the slot).
  const { minMin, maxMin } = useMemo(() => {
    const dow = new Date(`${date}T12:00:00`).getDay();
    const fallback = windowForDow(dow);
    const sched = scheduleForDate(date);
    let open = fallback.open;
    let close = fallback.close;
    if (sched.intervals.length) {
      open = sched.intervals[0].start;
      close = sched.intervals[sched.intervals.length - 1].end;
    }
    const dayAppts = appointments.filter((a) => a.date === date);
    const { open: o, close: c } = expandWindowForAppointments(open, close, dayAppts);
    return { minMin: o, maxMin: c };
  }, [windowForDow, scheduleForDate, date, appointments]);

  // Week time window: the UNION (min open .. max close) of the 7 days' EFFECTIVE
  // schedules, so every day's appointments fit in the shared Week grid. Faithful to the
  // legacy buildWeekBusinessHoursForRange, which maps each visible date to its effective
  // schedule (honouring special-opens / closures) rather than the plain day-of-week
  // hours. For each date we take the first interval's start and the last interval's end
  // from scheduleForDate, falling back to windowForDow when a date resolves nothing
  // (closed / no rows). Then EXPANDED by the dynamic axis over the whole week's
  // appointments (any booking starting before / ending after the union window widens it,
  // rounded to the slot).
  const { weekMinMin, weekMaxMin } = useMemo(() => {
    const days = weekDates(date);
    const opens: number[] = [];
    const closes: number[] = [];
    for (const d of days) {
      const fallback = windowForDow(new Date(`${d}T12:00:00`).getDay());
      const sched = scheduleForDate(d);
      if (sched.intervals.length) {
        opens.push(sched.intervals[0].start);
        closes.push(sched.intervals[sched.intervals.length - 1].end);
      } else {
        opens.push(fallback.open);
        closes.push(fallback.close);
      }
    }
    const baseOpen = Math.min(...opens);
    const baseClose = Math.max(...closes);
    const weekSet = new Set(days);
    const weekAppts = appointments.filter((a) => weekSet.has(a.date));
    const { open: o, close: c } = expandWindowForAppointments(baseOpen, baseClose, weekAppts);
    return { weekMinMin: o, weekMaxMin: c };
  }, [windowForDow, scheduleForDate, date, appointments]);

  const rows = useMemo(() => {
    const out: number[] = [];
    for (let m = minMin; m <= maxMin; m += SLOT_MIN_PER_ROW) out.push(m);
    return out;
  }, [minMin, maxMin]);

  const weekRows = useMemo(() => {
    const out: number[] = [];
    for (let m = weekMinMin; m <= weekMaxMin; m += SLOT_MIN_PER_ROW) out.push(m);
    return out;
  }, [weekMinMin, weekMaxMin]);

  // Staff columns (apply the operator filter, then the saved Day-view ordering;
  // faithful to STAFF_DAY_COLS). The filter composes with the order: the pinned
  // (logged-in) operator is first, then the saved order of the others, then the rest.
  const staffCols = useMemo(() => {
    // Colonne = TUTTI gli operatori (legacy STAFF_DAY_COLS): il filtro Operatore
    // NON riduce le colonne (M6), filtra gli EVENTI (vedi visibleAppts) come il
    // filtro server-side staff_id del legacy. Senza operatori attivi il legacy
    // rende UNA colonna fittizia 'Operatore' grigia (calendar.js:170 fallback
    // STAFF_DAY_COLS), mai una vista a zero colonne.
    const base: CalendarStaff[] = staff.length
      ? staff
      : [{ id: 0, name: "Operatore", email: "", color: "#999999", photoPath: "" }];
    return applyStaffDayColumnsOrdering(base, currentStaffId, savedStaffOrder);
  }, [staff, currentStaffId, savedStaffOrder]);

  // Shared filter predicate (operator/service/status) WITHOUT any date constraint —
  // applied by Week/Month so the toolbar filters affect those views too. Operatore e
  // servizio sono SEGMENT-AWARE (M16/M17): un multi-servizio matcha se un QUALSIASI
  // segmento corrisponde (come il filtro server staff_id/service_id).
  const passesFilters = useCallback(
    (a: Appointment): boolean => {
      if (filterStaff) {
        const s = staff.find((st) => String(st.id) === filterStaff);
        if (s && !apptInvolvesStaff(a, s)) return false;
      }
      if (filterStatus) {
        if (statusKeyFromLabel(a.statusCode ?? a.status).key !== filterStatus) return false;
      }
      if (filterService) {
        const svc = services.find((s) => String(s.id) === filterService);
        if (svc && !apptIncludesService(a, svc.name)) return false;
      }
      return true;
    },
    [filterStaff, filterStatus, filterService, staff, services],
  );

  // Appointments visible for the current real day, after filters (Day view). Il
  // filtro Operatore è applicato QUI sugli eventi (come il filtro server-side
  // legacy), così il totale (M7) lo riflette e tutte le colonne restano visibili.
  const visibleAppts = useMemo(() => {
    const staffCol = filterStaff ? staff.find((s) => String(s.id) === filterStaff) : undefined;
    const svcName = filterService ? services.find((s) => String(s.id) === filterService)?.name ?? "" : "";
    return appointments.filter((a) => {
      if (a.date && a.date !== date) return false;
      if (filterStatus && statusKeyFromLabel(a.statusCode ?? a.status).key !== filterStatus) return false;
      if (svcName && !apptIncludesService(a, svcName)) return false;
      if (staffCol && !apptInvolvesStaff(a, staffCol)) return false;
      return true;
    });
  }, [appointments, date, filterStatus, filterService, filterStaff, staff, services]);

  // Range-filtered appointments (Week/Month) — all filters incl. operator, no
  // single-day constraint. Grouped by ISO date for fast per-cell/per-column lookup,
  // each group sorted by start time.
  const rangeApptsByDate = useMemo(() => {
    const map: Record<string, Appointment[]> = {};
    for (const a of appointments) {
      if (!passesFilters(a)) continue;
      const key = a.date || "";
      if (!key) continue;
      (map[key] ??= []).push(a);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((x, y) => (timeToMin(x.time) ?? 0) - (timeToMin(y.time) ?? 0));
    }
    return map;
  }, [appointments, passesFilters]);

  function apptsForStaff(col: { id: number; name: string }): CalBlock[] {
    const out: CalBlock[] = [];
    for (const a of visibleAppts) {
      // Segmented appointment (>1 segment, legacy per-segment events): one VIRTUAL
      // block per segment in the matching column — otherwise a second operator's
      // column would look free while they are busy on their own segment. The virtual
      // block keeps the appointment id (click still opens the same edit drawer) but
      // takes the segment's window/service/operator + the segment identity for the
      // drag-move delta payload. Match PER ID (operatori omonimi), fallback al nome.
      if (a.segments && a.segments.length > 1) {
        for (const seg of a.segments) {
          if (!staffColMatches(col, seg.staffId, seg.staffName)) continue;
          out.push({
            ...a,
            time: seg.time,
            endTime: seg.endTime,
            service: seg.serviceName,
            services: [{ serviceId: seg.serviceId, name: seg.serviceName }],
            operator: seg.staffName,
            segmentId: seg.segmentId,
            segStaffId: seg.staffId,
          });
        }
        continue;
      }
      if (staffColMatches(col, a.operatorId, a.operator)) out.push(a);
    }
    return out;
  }

  // --- Multi-servizio (MS) group accents (port of getMsAccentForGroup, calendar.js
  // 3865-3959): each multi-service appointment gets a per-day accent from the MS
  // palette; same group -> same accent, different groups the same day -> different
  // accents. Assignment order = start time (the legacy assigns on mount order,
  // which is chronological within the day). ---
  const msAccentByAppt = useMemo(() => {
    const map: Record<number, string> = {};
    // Port di getMsAccentForGroup: per giorno tiene i colori USATI (stato + colore
    // operatore degli appuntamenti del giorno + accenti già assegnati) e la sequenza
    // fallback golden-angle. Palette-first evitando collisioni, poi HSL generato.
    const usedByDay: Record<string, Set<string>> = {};
    const fallbackSeqByDay: Record<string, number> = {};
    // Colore operatore (per nome) dalla lista staff — usato per evitare che un
    // accento MS collida col pallino operatore del giorno.
    const staffColorByName = (name?: string): string | null => {
      const op = staff.find((s) => (s.name || "").trim().toLowerCase() === (name || "").trim().toLowerCase());
      if (!op) return null;
      // Come il legacy: il colore "usato" del giorno è quello EFFETTIVO del
      // pallino (staffColorHex, palette fallback inclusa).
      return staffColorHex(op.id, op.color).toLowerCase();
    };
    const seedDay = (day: string): Set<string> => {
      let set = usedByDay[day];
      if (set) return set;
      set = new Set<string>();
      for (const c of MS_STATUS_COLORS) set.add(c.toLowerCase());
      for (const a of appointments) {
        if (a.date !== day) continue;
        const c = staffColorByName(a.operator);
        if (c) set.add(c);
        for (const seg of a.segments ?? []) { const sc = staffColorByName(seg.staffName); if (sc) set.add(sc); }
      }
      usedByDay[day] = set;
      fallbackSeqByDay[day] = 0;
      return set;
    };
    const groups = appointments
      .filter((a) => msCountOf(a) > 1)
      .sort((x, y) =>
        x.date < y.date ? -1 : x.date > y.date ? 1 : ((timeToMin(x.time) ?? 0) - (timeToMin(y.time) ?? 0)) || x.id - y.id,
      );
    for (const a of groups) {
      const used = seedDay(a.date);
      let pick: string | null = null;
      for (const c of MS_ACCENT_PALETTE) {
        if (!used.has(c.toLowerCase())) { pick = c; break; }
      }
      if (!pick) {
        let tries = 0;
        while (tries < 120) {
          const idx = (fallbackSeqByDay[a.date] || 0) + 1;
          fallbackSeqByDay[a.date] = idx;
          const cand = hslToHex((idx * 137.508) % 360, 0.78, 0.48);
          if (!used.has(cand.toLowerCase())) { pick = cand; break; }
          tries++;
        }
      }
      pick = pick || "#7c3aed";
      map[a.id] = pick;
      used.add(pick.toLowerCase());
    }
    return map;
  }, [appointments, staff]);
  // Hovering ANY block of a multi-service group highlights ALL its blocks
  // (port of eventMouseEnter/Leave -> .ms-active, calendar.js 4538-4558).
  const [msHoverGroup, setMsHoverGroup] = useState(0);

  // Toolbar total reflects the visible range: the focused day (Day) or the whole
  // visible week/month grid (Week/Month).
  const totalAppts = useMemo(() => {
    if (view === "staffTimeGridDay") return visibleAppts.length;
    const dates = view === "timeGridWeek" ? weekDates(date) : monthGridDates(date);
    return dates.reduce((sum, d) => sum + (rangeApptsByDate[d]?.length ?? 0), 0);
  }, [view, visibleAppts, rangeApptsByDate, date]);
  const totalLabel = totalAppts === 1 ? "appuntamento totale" : "appuntamenti totali";
  // M22: nella vista MESE il "periodo visibile" delle note è il MESE ESATTO
  // (1..ultimo), non la griglia di 42 giorni usata per il fetch/gli appuntamenti
  // (Settimana/Giorno hanno già un fetch esatto).
  const periodNotes = useMemo(() => {
    if (view !== "dayGridMonth") return notes;
    const d = new Date(`${date}T12:00:00`);
    const first = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    const last = isoLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return notes.filter((n) => n.noteDate >= first && n.noteDate <= last);
  }, [notes, view, date]);
  const notesCount = periodNotes.length;
  // GAP 5: the notes actually shown in the modal — all visible-period notes, or just the
  // single selected day when a marker was clicked.
  const displayNotes = notesFilterDate ? notes.filter((n) => n.noteDate === notesFilterDate) : periodNotes;
  const gridHeight = (rows.length - 1) * ROW_HEIGHT + ROW_HEIGHT;
  const weekGridHeight = (weekRows.length - 1) * ROW_HEIGHT + ROW_HEIGHT;
  // The 7 Week column dates (Mon..Sun) + today, lifted to component scope so the Week
  // grid can render INLINE in the main return (rather than from a nested render helper).
  // Inlining matters for the block drag/resize handlers: the React Compiler's
  // react-hooks/refs rule allows ref-touching event handlers (onWeekBlockDragStart /
  // beginResize, which write dragRef/resizeRef) in the component's OWN render JSX — as it
  // already does for the identical Day-view handlers — but flags them inside a separately
  // defined nested function. So the Week view is built inline below, like the Day view.
  const weekTodayIso = isoLocal(new Date());
  const weekDays = weekDates(date);

  // === NOW-INDICATOR position/visibility (port of FullCalendar nowIndicator +
  // updateStaffNowIndicator) ===
  // Day view: the line shows only when the focused day IS today and the current
  // minute-of-day falls inside the (dynamically-expanded) visible window
  // [minMin, maxMin]; its Y is mapped like an appointment block (minutes from the
  // window start * PX_PER_MIN). It spans ALL staff columns (the line lives in the
  // staff-columns container), matching updateStaffNowIndicator stretching the red
  // line across every fake-day column.
  const dayNowIndicator = useMemo(() => {
    if (view !== "staffTimeGridDay") return null;
    if (date !== isoLocal(new Date())) return null;
    if (nowMinutes < minMin || nowMinutes > maxMin) return null;
    return { top: (nowMinutes - minMin) * PX_PER_MIN, label: minToTime(nowMinutes) };
  }, [view, date, nowMinutes, minMin, maxMin]);

  // Week view: the line shows only when the visible week CONTAINS today and now is
  // inside the union window [weekMinMin, weekMaxMin]; Y uses weekMinMin. It spans all
  // 7 day columns (the line lives in the day-columns container), like FullCalendar's
  // nowIndicator drawn across the timegrid body.
  const weekNowIndicator = useMemo(() => {
    if (view !== "timeGridWeek") return null;
    const todayIso = isoLocal(new Date());
    if (!weekDates(date).includes(todayIso)) return null;
    if (nowMinutes < weekMinMin || nowMinutes > weekMaxMin) return null;
    return { top: (nowMinutes - weekMinMin) * PX_PER_MIN, label: minToTime(nowMinutes) };
  }, [view, date, nowMinutes, weekMinMin, weekMaxMin]);

  function go(deltaDays: number) {
    setDate((d) => addDays(d, deltaDays));
  }

  // Nav Mese: FullCalendar prev/next in dayGridMonth naviga di UN MESE DI
  // CALENDARIO (l'anchor diventa il primo del mese), non di 30 giorni fissi.
  function goMonth(delta: number) {
    setDate((d) => {
      const cur = new Date(`${monthStartIso(d)}T12:00:00`);
      cur.setMonth(cur.getMonth() + delta);
      return `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-01`;
    });
  }

  // Map a Y offset (px, relative to the top of a column's slot body) to a snapped
  // time string, clamped to the visible business-hours window. The slot body starts
  // at minMin, ROW_HEIGHT px per SLOT_MIN_PER_ROW (PX_PER_MIN px per minute).
  const timeFromY = useCallback(
    (offsetPx: number): string => {
      const rawMin = minMin + offsetPx / PX_PER_MIN;
      const snapped = snapMin(rawMin, SNAP_MIN);
      const clamped = Math.min(Math.max(snapped, minMin), maxMin);
      return minToTime(clamped);
    },
    [minMin, maxMin],
  );

  // Map a Y offset (px, relative to a column body top) to a snapped MINUTE-of-day,
  // clamped to the given window. Port of the calendar.js hover/select Y->time math:
  //   minutes = winStart + round((offsetY) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN
  // The window start/end are passed so this serves both the Day (minMin/maxMin) and the
  // Week (weekMinMin/weekMaxMin) grids with the SAME math the blocks/now-indicator use.
  const snappedMinFromY = useCallback((offsetPx: number, winStart: number, winEnd: number): number => {
    const rawMin = winStart + offsetPx / PX_PER_MIN;
    const snapped = winStart + Math.round((rawMin - winStart) / SNAP_MIN) * SNAP_MIN;
    return Math.min(Math.max(snapped, winStart), winEnd);
  }, []);

  // === HOVER INDICATOR + DRAG-SELECT START installer (faithful port of
  // installCalendarHoverTimeIndicator + scheduleCalendarHoverTimeUpdate) ===
  // A single root-level listener set (pointermove + mousedown + leave) on #calendar,
  // attached imperatively in an effect — so every ref read/write happens inside the
  // effect (never via a function passed to a JSX prop), keeping the no-ref-access-during-
  // render lint clean while still serving BOTH the Day and Week grids. Each column body
  // carries the geometry the handler needs as data-* attributes (data-cal-body, data-col,
  // data-winstart/-winend, and for drag-select data-staffid/-celldate); the handler reads
  // them from the .cal-col-body under the pointer, so it is view-agnostic.
  //   - pointermove: computes the snapped time/line/slot for the hovered body, stores it
  //     in a ref, and rAF-throttles a single setHover per frame (port of
  //     scheduleCalendarHoverTimeUpdate). Hidden over an appointment block (.fc-event) or
  //     while a block move / resize / range-select gesture is active.
  //   - mousedown: starts a drag-select on an empty body (primary button, not on a block
  //     / resize handle / store band), seeding dragSelectRef + the live band state.
  // The window-level mousemove/mouseup that EXTEND + COMMIT the active drag-select live in
  // their own effect (below). The listeners + any pending rAF are removed on unmount.
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const root = document.getElementById("calendar");
    if (!root) return;

    const flushHover = () => {
      hoverRafRef.current = 0;
      setHover(hoverPendingRef.current);
    };
    const scheduleHover = () => {
      if (!hoverRafRef.current) hoverRafRef.current = window.requestAnimationFrame(flushHover);
    };

    const onMove = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const body = target?.closest<HTMLElement>(".cal-col-body[data-cal-body]");
      const overEvent = target?.closest?.(".fc-event") != null;
      if (!body || overEvent || dragRef.current || resizeRef.current || dragSelectRef.current) {
        hoverPendingRef.current = null;
        scheduleHover();
        return;
      }
      const col = body.getAttribute("data-col") || "";
      const winStart = Number(body.getAttribute("data-winstart"));
      const winEnd = Number(body.getAttribute("data-winend"));
      if (!col || !Number.isFinite(winStart) || !Number.isFinite(winEnd)) {
        hoverPendingRef.current = null;
        scheduleHover();
        return;
      }
      const rect = body.getBoundingClientRect();
      // Semantica legacy (getCalendarHoverTimeInfoFromPoint): la RIGA da 5' in cui
      // si trova il cursore (floor, non round) — la linea guida sta sul bordo
      // superiore della riga, l'evidenziazione copre la riga, l'etichetta HH:MM è
      // l'inizio riga (clampato alla fine finestra, port di __cal_actual_max_time).
      const rowMin = winStart + Math.floor((ev.clientY - rect.top) / ROW_HEIGHT) * SLOT_MIN_PER_ROW;
      const minutes = Math.min(Math.max(rowMin, winStart), winEnd);
      const top = (minutes - winStart) * PX_PER_MIN;
      hoverPendingRef.current = { col, lineTop: top, slotTop: top, label: minToTime(minutes) };
      scheduleHover();
    };

    const onLeave = () => {
      hoverPendingRef.current = null;
      scheduleHover();
    };

    const onDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return; // primary button only
      if (dragRef.current || resizeRef.current) return; // never during a block move/resize
      const target = ev.target as HTMLElement | null;
      // Never start a range-select on a block, its resize handle, or a store band.
      if (target?.closest(".fc-event") || target?.closest(".cal-resize-handle")) return;
      const body = target?.closest<HTMLElement>(".cal-col-body[data-cal-body]");
      if (!body) return;
      const col = body.getAttribute("data-col") || "";
      const winStart = Number(body.getAttribute("data-winstart"));
      const winEnd = Number(body.getAttribute("data-winend"));
      if (!col || !Number.isFinite(winStart) || !Number.isFinite(winEnd)) return;
      const staffId = Number(body.getAttribute("data-staffid")) || 0;
      const cellDate = body.getAttribute("data-celldate") || undefined;
      const bodyTopPx = body.getBoundingClientRect().top;
      const startMin = snappedMinFromY(ev.clientY - bodyTopPx, winStart, winEnd);
      dragSelectRef.current = { col, staffId, cellDate, bodyTopPx, startMin, curMin: startMin };
      // Hide the hover indicator for the duration of the gesture (the live band leads).
      hoverPendingRef.current = null;
      setHover(null);
      setDragSelect({ col, startMin, curMin: startMin });
    };

    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    root.addEventListener("mousedown", onDown);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      root.removeEventListener("mousedown", onDown);
      if (hoverRafRef.current) {
        window.cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = 0;
      }
    };
  }, [snappedMinFromY]);

  // Render the hover slot-highlight + live drag-select band for one column body
  // (`col` is the column key, `winStart` the body's window start min). Both are
  // absolutely-positioned, pointer-events:none overlays so they never block the
  // underlying empty-cell click / drag, reusing the legacy CSS classes. The hover
  // GUIDE LINE is NOT here: like the legacy (appended to .fc-timegrid-cols) it is a
  // single line spanning ALL the view's columns, rendered by the columns wrapper;
  // the HH:MM label lives INLINE in the toolbar's center chunk (the legacy
  // .calendar-hover-time-display--inline placement).
  const renderHoverOverlay = useCallback(
    (col: string, winStart: number) => {
      const showHover = hover && hover.col === col;
      const showSelect = dragSelect && dragSelect.col === col;
      if (!showHover && !showSelect) return null;
      const selA = showSelect ? Math.min(dragSelect.startMin, dragSelect.curMin) : 0;
      const selB = showSelect ? Math.max(dragSelect.startMin, dragSelect.curMin) : 0;
      const selTop = (selA - winStart) * PX_PER_MIN;
      const selHeight = Math.max((selB - selA) * PX_PER_MIN, 2);
      return (
        <>
          {showHover ? (
            <div
              className="calendar-hover-slot-highlight is-visible"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: hover.slotTop,
                height: ROW_HEIGHT,
                zIndex: 4,
                pointerEvents: "none",
                // Minimal inline fallback in case the scoped CSS does not match.
                background: "rgba(47,99,216,.13)",
                boxShadow: "inset 0 0 0 1px rgba(47,99,216,.22)",
              }}
            />
          ) : null}
          {showSelect ? (
            <div
              className="calendar-hover-slot-highlight is-visible"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: selTop,
                height: selHeight,
                zIndex: 5,
                pointerEvents: "none",
                background: "rgba(47,99,216,.20)",
                boxShadow: "inset 0 0 0 1px rgba(47,99,216,.40)",
              }}
            />
          ) : null}
        </>
      );
    },
    [hover, dragSelect],
  );

  // Linea guida hover a TUTTA LARGHEZZA per un wrapper colonne (port della
  // .calendar-hover-time-line appesa a .fc-timegrid-cols nel legacy: attraversa
  // tutte le colonne della vista, non solo quella sotto il cursore). `prefix`
  // scopa la linea alla vista attiva ("day-"/"week-"); `headerPx` è l'offset
  // dell'intestazione colonne sopra i body.
  const renderHoverGuideLine = useCallback(
    (prefix: string, headerPx: number) => {
      if (!hover || !hover.col.startsWith(prefix)) return null;
      return (
        <div
          className="calendar-hover-time-line is-visible"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: headerPx + hover.lineTop,
            zIndex: 5,
            pointerEvents: "none",
            borderTop: "1px dashed rgba(59,130,246,.7)",
          }}
        />
      );
    },
    [hover],
  );

  // POST action=move con il CONTRATTO LEGACY (eventDrop/eventResize -> api move):
  // starts_at/ends_at completi [+staff_id nella vista a colonne] [+segment_id/old_*
  // per i blocchi-segmento]. Patch ottimistico; su errore revert + window.alert
  // (verbatim legacy: alert(resp.error || fallback) + info.revert()); su ok
  // riconcilia con la lista autorevole del server.
  const postMove = useCallback(
    async (
      payload: Record<string, unknown>,
      patch: (list: Appointment[]) => Appointment[],
      fallbackMsg: string,
    ) => {
      // Gate manage (legacy editable:CAN_MANAGE_APPOINTMENTS): senza il permesso
      // niente drag/resize (il server rifiuta comunque action=move).
      if (!canManage) return;
      const prev = appointments;
      setAppointments(patch);
      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ action: "move", ...payload }),
        });
        const json: { ok?: boolean; error?: string; appointments?: Appointment[] } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          setAppointments(prev); // revert (port di info.revert())
          window.alert(String(json.error || fallbackMsg));
          return;
        }
        if (Array.isArray(json.appointments)) setAppointments(json.appointments);
        else loadContext(date, visibleRange);
      } catch {
        setAppointments(prev); // revert su errore di rete
        window.alert(fallbackMsg);
      }
    },
    [appointments, date, loadContext, slug, visibleRange, canManage],
  );

  // Drop nella vista GIORNO (port di eventDrop in staffTimeGridDay): cambia l'ORA
  // e, trascinando tra colonne, l'OPERATORE (staff_id sempre inviato per i blocchi
  // non-segmento, come payload.staff_id legacy). Un blocco-SEGMENTO su un'ALTRA
  // colonna è bloccato client-side con l'alert legacy; nella stessa colonna sposta
  // l'INTERA prenotazione per delta (segment_id + old_starts_at/old_ends_at).
  const moveBlockDay = useCallback(
    (block: CalBlock, newTime: string, targetStaffId: number, targetStaffName: string) => {
      if (block.segmentId) {
        const curStaffId = Number(block.segStaffId ?? 0) || 0;
        if (targetStaffId !== curStaffId) {
          window.alert("Per cambiare operatore su prenotazioni multi-servizio, modifica l'appuntamento (non tramite drag & drop).");
          return;
        }
        if (block.time === newTime) return; // no-op sullo stesso slot
        const deltaMin = (timeToMin(newTime) ?? 0) - (timeToMin(block.time) ?? 0);
        void postMove(
          {
            id: block.id,
            starts_at: sqlAt(date, newTime),
            ends_at: sqlAt(date, shiftTime(block.endTime ?? block.time, deltaMin) ?? newTime),
            segment_id: block.segmentId,
            old_starts_at: sqlAt(date, block.time),
            old_ends_at: sqlAt(date, block.endTime ?? block.time),
          },
          (list) => list.map((a) => (a.id === block.id
            ? {
                ...a,
                time: shiftTime(a.time, deltaMin) ?? a.time,
                endTime: shiftTime(a.endTime, deltaMin),
                segments: a.segments?.map((seg) => ({ ...seg, time: shiftTime(seg.time, deltaMin) ?? seg.time, endTime: shiftTime(seg.endTime, deltaMin) ?? seg.endTime })),
              }
            : a)),
          "Impossibile spostare",
        );
        return;
      }
      // Stesso operatore PER ID (robusto agli omonimi); fallback al nome se l'id manca.
      const blockStaffId = Number(block.segStaffId ?? block.operatorId ?? 0) || 0;
      const sameOperator = targetStaffId > 0 && blockStaffId > 0
        ? blockStaffId === targetStaffId
        : (block.operator || "").trim().toLowerCase() === targetStaffName.trim().toLowerCase();
      if (block.time === newTime && sameOperator) return; // no-op sullo stesso slot/colonna
      void postMove(
        {
          id: block.id,
          starts_at: sqlAt(date, newTime),
          ends_at: sqlAt(date, shiftTime(newTime, blockDurationMin(block)) ?? newTime),
          staff_id: String(targetStaffId || ""),
        },
        (list) => list.map((a) => (a.id === block.id
          ? { ...a, time: newTime, endTime: shiftTime(newTime, blockDurationMin(block)), operator: targetStaffName }
          : a)),
        "Impossibile spostare",
      );
    },
    [date, postMove],
  );

  // Drop su una colonna-giorno (Settimana) o cella (Mese): cambia DATA (+ ora nel
  // Week; il Mese conserva l'orario del chip), operatore invariato (nessuno
  // staff_id, come il legacy fuori dalla vista a colonne). I blocchi-segmento
  // spostano l'intera prenotazione per delta anche cross-data.
  const moveBlockToDate = useCallback(
    (block: CalBlock, iso: string, newTime: string) => {
      if (block.date === iso && block.time === newTime) return; // no-op
      const fromIso = block.date || date;
      const deltaMin = (timeToMin(newTime) ?? 0) - (timeToMin(block.time) ?? 0);
      void postMove(
        block.segmentId
          ? {
              id: block.id,
              starts_at: sqlAt(iso, newTime),
              ends_at: sqlAt(iso, shiftTime(block.endTime ?? block.time, deltaMin) ?? newTime),
              segment_id: block.segmentId,
              old_starts_at: sqlAt(fromIso, block.time),
              old_ends_at: sqlAt(fromIso, block.endTime ?? block.time),
            }
          : {
              id: block.id,
              starts_at: sqlAt(iso, newTime),
              ends_at: sqlAt(iso, shiftTime(newTime, blockDurationMin(block)) ?? newTime),
            },
        (list) => list.map((a) => (a.id === block.id
          ? (block.segmentId
              ? {
                  ...a,
                  date: iso,
                  time: shiftTime(a.time, deltaMin) ?? a.time,
                  endTime: shiftTime(a.endTime, deltaMin),
                  segments: a.segments?.map((seg) => ({ ...seg, time: shiftTime(seg.time, deltaMin) ?? seg.time, endTime: shiftTime(seg.endTime, deltaMin) ?? seg.endTime })),
                }
              : { ...a, date: iso, time: newTime, endTime: shiftTime(newTime, blockDurationMin(block)) })
          : a)),
        "Impossibile spostare",
      );
    },
    [date, postMove],
  );

  // RESIZE -> action=move con lo stesso inizio e la NUOVA fine (il legacy
  // eventResize POSTA action='move': non esiste un'azione resize dedicata; la
  // durata custom viene persistita così com'è). Solo blocchi non-segmento: sui
  // segmenti la maniglia non è renderizzata (port di durationEditable:false).
  const resizeAppointment = useCallback(
    async (id: number, newEndTime: string) => {
      const target = appointments.find((a) => a.id === id);
      if (!target) return;
      // No-op quando la fine non cambia o non sarebbe oltre l'inizio.
      const startMin = timeToMin(target.time);
      const endMinVal = timeToMin(newEndTime);
      if (startMin === null || endMinVal === null || endMinVal <= startMin) return;
      if ((target.endTime || "") === newEndTime) return;
      const iso = target.date || date;
      await postMove(
        { id, starts_at: sqlAt(iso, target.time), ends_at: sqlAt(iso, newEndTime) },
        (list) => list.map((a) => (a.id === id ? { ...a, endTime: newEndTime } : a)),
        "Impossibile ridimensionare",
      );
    },
    [appointments, date, postMove],
  );

  // RESIZE drag wiring (bottom-edge handle). Mousedown on the handle records the
  // resize payload (in resizeRef) + seeds a render preview; document mousemove tracks
  // the live snapped end (updating both the ref and the preview so the block
  // stretches), mouseup commits via resizeAppointment. The window listeners are
  // attached only while a resize is in flight — the effect keys off whether
  // resizePreview is set, NOT its value, so it doesn't re-bind on every mouse move.
  const beginResize = useCallback(
    (e: ReactMouseEvent, appt: CalBlock) => {
      e.preventDefault();
      e.stopPropagation();
      // Gate manage (legacy editable:CAN_MANAGE_APPOINTMENTS): niente resize senza
      // il permesso (il commit postMove è comunque gatato e il server rifiuta).
      if (!canManage) return;
      // Guardia legacy (eventResize, calendar.js ~5015): i blocchi-segmento non si
      // ridimensionano. La maniglia non è nemmeno renderizzata sui segmenti
      // (durationEditable:false), quindi questa è la cintura verbatim del legacy.
      if (appt.segmentId) {
        window.alert("Ridimensionamento non supportato per prenotazioni multi-servizio (segmentate).");
        return;
      }
      const startMin = timeToMin(appt.time);
      // The column body (the positioned slot container) is the resize handle's
      // nearest .cal-col-body ancestor; its page-top anchors the cursor->time map.
      const bodyEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".cal-col-body");
      if (startMin === null || !bodyEl) return;
      const bodyTopPx = bodyEl.getBoundingClientRect().top;
      // The dragged column's visible window (minutes), read off the body's data-*
      // attrs — Day columns carry minMin/maxMin, Week day columns weekMinMin/
      // weekMaxMin — so the same resize math serves both views. Fall back to the Day
      // window if the attrs are missing.
      const winStart = Number(bodyEl.getAttribute("data-winstart"));
      const winEnd = Number(bodyEl.getAttribute("data-winend"));
      const wStart = Number.isFinite(winStart) ? winStart : minMin;
      const wEnd = Number.isFinite(winEnd) ? winEnd : maxMin;
      // Seed the end at the current block end so the first render is stable.
      const currentEnd = appt.endTime || minToTime(Math.min(startMin + DEFAULT_DURATION_MIN, wEnd));
      resizeRef.current = { id: appt.id, startMin, bodyTopPx, winStart: wStart, winEnd: wEnd, endTime: currentEnd };
      setResizePreview({ id: appt.id, endTime: currentEnd });
    },
    [minMin, maxMin, canManage],
  );

  // `resizing` is just whether a resize is active; the effect depends on this boolean
  // so the document listeners bind once per resize gesture, not once per mouse move.
  const resizing = resizePreview !== null;
  useEffect(() => {
    if (!resizing) return;
    if (typeof window === "undefined") return;

    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      // Map cursor Y -> minutes from the column body top, snap, clamp to >start within
      // the dragged column's own window (Day or Week, captured at mousedown).
      const rawMin = r.winStart + (ev.clientY - r.bodyTopPx) / PX_PER_MIN;
      let snapped = snapMin(rawMin, SNAP_MIN);
      snapped = Math.min(Math.max(snapped, r.startMin + SNAP_MIN), r.winEnd);
      const endTime = minToTime(snapped);
      r.endTime = endTime; // keep the ref's end in sync for the commit on mouseup
      setResizePreview((cur) => (cur && cur.id === r.id ? { id: r.id, endTime } : cur));
    };

    const onUp = () => {
      const r = resizeRef.current;
      resizeRef.current = null;
      setResizePreview(null);
      if (r) void resizeAppointment(r.id, r.endTime);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, resizeAppointment]);

  // WEEK block drag-move drop target wiring. Component-scope callbacks attached by the
  // inline Week view JSX to each day column's body. (The Week grid is built inline in the
  // main return — see the weekView const — so these handlers already sit in the render
  // scope and the dragRef writes are lint-clean; they are extracted here only to keep the
  // JSX readable, mirroring beginResize / moveAppointment.)
  //   - onWeekColumnDragOver: allow the drop (the browser only fires onDrop when the
  //     dragover default is prevented), but only while a block move is in flight.
  //   - onWeekColumnDrop(iso, e): map the dropped block TOP (cursor - grab offset) to a
  //     snapped time in the WEEK window, and move the appointment to THIS column's date
  //     (iso) + that time, operator unchanged (moveAppointmentToDate).
  // dragover con GHOST: oltre ad abilitare il drop, calcola la posizione
  // snappata (STESSA matematica del drop qui sotto) e aggiorna la banda
  // fantasma con orario live + validità contro i blocchi della colonna.
  const onWeekColumnDragOver = useCallback(
    (iso: string, colBlocks: CalBlock[], e: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
      autoScrollOnDragOver(e);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const startMin = snappedMinFromY(e.clientY - rect.top - drag.grabOffsetPx, weekMinMin, weekMaxMin);
      const durMin = moveBlockDurationMin(drag.block);
      const v = moveGhostStateFor(startMin, durMin, colBlocks, Number(drag.block.id), weekMaxMin);
      updateMoveGhost({
        col: `week-${iso}`,
        top: (startMin - weekMinMin) * PX_PER_MIN,
        height: Math.max(durMin * PX_PER_MIN - 2, 18),
        label: `${minToTime(startMin)} - ${minToTime(startMin + durMin)}`,
        state: v.state,
        note: v.note,
      });
    },
    [snappedMinFromY, weekMinMin, weekMaxMin, updateMoveGhost],
  );
  const onWeekColumnDrop = useCallback(
    (iso: string, e: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Map the block TOP (cursor minus the grab offset), snapped within the week window.
      const topPx = e.clientY - rect.top - drag.grabOffsetPx;
      const minutes = snappedMinFromY(topPx, weekMinMin, weekMaxMin);
      moveBlockToDate(drag.block, iso, minToTime(minutes));
      dragRef.current = null;
      clearMoveGhost();
    },
    [snappedMinFromY, weekMinMin, weekMaxMin, moveBlockToDate, clearMoveGhost],
  );
  // WEEK/MONTH block drag START / END — extracted callbacks (lint parity with the drop
  // handlers above). onDragStart records the grabbed BLOCK + the pointer offset from
  // the block top, so the drop maps the block's start time (and the segment payload).
  // onDragEnd clears the ref shortly after so the synthetic click trailing a drag
  // doesn't open edit on the column.
  const onWeekBlockDragStart = useCallback((block: CalBlock, e: ReactDragEvent<HTMLElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { id: block.id, grabOffsetPx: e.clientY - rect.top, block };
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(block.id));
    } catch { /* ignore */ }
    // Ghost: snapshot nativa soppressa + originale attenuato.
    applyGhostDragImage(e);
    setDraggingApptId(Number(block.id));
  }, [applyGhostDragImage]);
  const onWeekBlockDragEnd = useCallback(() => {
    setTimeout(() => { dragRef.current = null; }, 0);
    clearMoveGhost();
  }, [clearMoveGhost]);
  // MONTH chip drop on a day cell (port of the legacy dayGridMonth eventDrop:
  // FullCalendar month drag keeps the chip's TIME and changes the DATE; segment
  // chips shift the whole appointment by the date delta server-side).
  const onMonthCellDrop = useCallback(
    (iso: string, e: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      moveBlockToDate(drag.block, iso, drag.block.time);
      dragRef.current = null;
      clearMoveGhost();
    },
    [moveBlockToDate, clearMoveGhost],
  );

  // NOW-INDICATOR tick (port of installStaffNowIndicatorFix): keep nowMinutes in sync
  // with the wall clock via a 30s interval, mirroring FullCalendar's minute-based
  // nowIndicator refresh. setState is called ONLY inside the interval callback (never
  // synchronously in the effect body) so the effect binds once and stays lint-clean;
  // the interval is cleared on unmount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => {
      setNowMinutes(nowMinutesOfDay());
    }, 30000);
    return () => window.clearInterval(id);
  }, []);

  // Open the GLOBAL quick-booking drawer in EDIT mode for an appointment block. The
  // drawer's document-level [data-qb-edit] listener catches a click on any element
  // carrying data-qb-edit; from the block's onClick we dispatch a click on a hidden
  // anchor we set to data-qb-edit={id}, so a plain click (not a drag) opens edit while
  // the block's own drag handlers keep MOVE working.
  // The hidden bridge anchors are looked up by id (not a ref) so these openers do not
  // read a ref — keeping them usable from the nested render helpers (renderWeekView /
  // renderMonthView) without tripping the no-ref-access-during-render lint.
  const openGlobalEdit = useCallback((id: number) => {
    if (typeof document === "undefined") return;
    // Gate manage (legacy: click->Modifica solo con appointments.manage,
    // calendar.js:4916). Senza il permesso il click non apre l'editor.
    if (!canManage) return;
    const anchor = document.getElementById("calQbEditAnchor");
    if (!anchor) return;
    anchor.setAttribute("data-qb-edit", String(id));
    anchor.click();
  }, [canManage]);

  // Open the GLOBAL quick-booking drawer in CREATE mode, prefilled with the clicked
  // empty cell's date/time/operator. The drawer's [data-qb-new] listener reads the
  // data-qb-date/data-qb-time/data-qb-staff attributes we set on a hidden anchor, then
  // shows the offcanvas. Replaces the legacy #apptModal quick-book entirely.
  const openGlobalQuickBook = useCallback(
    (cellTime: string, staffId: number, endTime?: string, cellDate?: string) => {
      if (typeof document === "undefined") return;
      // Gate quick_booking (legacy selectable:CAN_CREATE_APPOINTMENTS,
      // calendar.js:4063): senza il permesso il click su slot vuoto non crea.
      if (!canCreate) return;
      const anchor = document.getElementById("calQbNewAnchor");
      if (!anchor) return;
      // cellDate lets the Week view book against the clicked DAY column's date (each
      // column is a different day); the Day view omits it and uses the focused `date`.
      anchor.setAttribute("data-qb-date", cellDate || date);
      anchor.setAttribute("data-qb-time", cellTime);
      anchor.setAttribute("data-qb-staff", staffId > 0 ? String(staffId) : "");
      // DRAG-SELECT end (port of the FullCalendar `select:` handler): when the user
      // drag-selected a TIME RANGE (not a plain click), pass the chosen end so the
      // drawer honors the DURATION (the drawer reads data-qb-endtime; see
      // quick-booking-drawer.tsx's [data-qb-new] handler). Cleared otherwise so a plain
      // click keeps the services-derived end. The drawer ignores an end <= start.
      if (endTime && endTime !== cellTime) anchor.setAttribute("data-qb-endtime", endTime);
      else anchor.removeAttribute("data-qb-endtime");
      anchor.click();
    },
    [date, canCreate],
  );

  // While a drag-select is active, track the live end with a window mousemove and commit
  // on mouseup. The effect keys off whether a select is active (a boolean), NOT its
  // value, so the listeners bind once per gesture (not per mouse move), mirroring the
  // resize wiring. A span of >= one SNAP_MIN slot opens the quick-book drawer prefilled
  // with the start AND end (honoring the duration); a zero-length drag is left to the
  // body onClick (the existing single-slot quick-book). The view's window (Day vs Week)
  // is captured via the dependencies so the cursor->time map matches the active grid.
  // (Placed after openGlobalQuickBook so it can call it.)
  const dragSelecting = dragSelect !== null;
  const dragWinStart = view === "timeGridWeek" ? weekMinMin : minMin;
  const dragWinEnd = view === "timeGridWeek" ? weekMaxMin : maxMin;
  useEffect(() => {
    if (!dragSelecting) return;
    if (typeof window === "undefined") return;

    const onMove = (ev: MouseEvent) => {
      const r = dragSelectRef.current;
      if (!r) return;
      const curMin = snappedMinFromY(ev.clientY - r.bodyTopPx, dragWinStart, dragWinEnd);
      r.curMin = curMin; // keep the ref's live end in sync for the commit on mouseup
      setDragSelect((cur) => (cur && cur.col === r.col ? { col: r.col, startMin: r.startMin, curMin } : cur));
    };

    // The commit reads the final range from the ref (no side effects inside the state
    // updater, which React may invoke twice) and opens the drawer once on mouseup.
    const onUp = () => {
      const sel = dragSelectRef.current;
      dragSelectRef.current = null;
      setDragSelect(null);
      if (!sel) return;
      const a = Math.min(sel.startMin, sel.curMin);
      const b = Math.max(sel.startMin, sel.curMin);
      // A real range (>= one SNAP_MIN slot) -> open the drawer with start + end so the
      // duration is honored. A zero-length drag falls through to the body onClick (the
      // existing single-slot quick-book).
      if (b - a >= SNAP_MIN) {
        dragSelectJustCommittedRef.current = true;
        openGlobalQuickBook(minToTime(a), sel.staffId, minToTime(b), sel.cellDate);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragSelecting, dragWinStart, dragWinEnd, snappedMinFromY, openGlobalQuickBook]);

  // WEEK empty-cell quick-book click — extracted callback (the drag / resize /
  // just-committed ref guards), like the Day body's inline onClick. Ignores the click
  // right after a block drag / resize or a committed drag-select range; otherwise opens
  // the global quick-book drawer prefilled with this column's date + the clicked time.
  // (Placed after openGlobalQuickBook so it can call it.)
  const onWeekColumnClick = useCallback(
    (iso: string, e: ReactMouseEvent) => {
      if (dragRef.current || resizeRef.current) return;
      if (dragSelectJustCommittedRef.current) {
        dragSelectJustCommittedRef.current = false;
        return;
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const rawMin = snappedMinFromY(e.clientY - rect.top, weekMinMin, weekMaxMin);
      // Fuori dalla vista a colonne il legacy prefilla l'operatore del FILTRO
      // (select handler: staffId = currentStaff || '').
      openGlobalQuickBook(minToTime(rawMin), Number(filterStaff) || 0, undefined, iso);
    },
    [snappedMinFromY, weekMinMin, weekMaxMin, openGlobalQuickBook, filterStaff],
  );

  // QUICK-BOOK is now handled by the GLOBAL quick-booking drawer
  // (components/quick-booking-drawer.tsx) via openGlobalQuickBook above — the legacy
  // static #apptModal create flow was RETIRED so the calendar reuses the full drawer
  // (services/redeems/pricing). The #apptModal markup is kept (verbatim) but unwired.

  // The global "+ Prenotazione" topbar button opens the faithful global
  // quick-booking offcanvas IN PLACE (components/quick-booking-drawer.tsx),
  // so there is no longer a ?qbnew=1 navigation to auto-open here.

  // CALENDAR NOTES: open the (static) #calendarNotesModal from the header "Note"
  // button and wire its form save/delete to /api/manage/calendar (note_save /
  // note_delete). Markup is verbatim — only behavior is attached. The note list is
  // rendered by React from `notes`; saving/deleting reloads the day to refresh it.
  const notesModalRef = useRef<HTMLDivElement | null>(null);

  // Reset the notes form to "new note" mode for the current day (clears id, hides
  // the Delete button) — mirrors the legacy #calendarNotesNewBtn behavior.
  const resetNotesForm = useCallback((prefillDate?: string) => {
    if (typeof document === "undefined") return;
    const root = notesModalRef.current ?? document.getElementById("calendarNotesModal");
    if (!root) return;
    const idEl = root.querySelector<HTMLInputElement>("#calendar_note_id");
    const dateEl = root.querySelector<HTMLInputElement>("#calendar_note_date");
    const titleEl = root.querySelector<HTMLInputElement>("#calendar_note_title");
    const textEl = root.querySelector<HTMLTextAreaElement>("#calendar_note_text");
    const deleteBtn = root.querySelector<HTMLButtonElement>("#calendarNoteDeleteBtn");
    if (idEl) idEl.value = "";
    // M23: prefill del giorno CLICCATO quando si apre da un marker, altrimenti il
    // giorno focalizzato (apertura dal pulsante in testata).
    if (dateEl) dateEl.value = prefillDate || date;
    if (titleEl) titleEl.value = "";
    if (textEl) textEl.value = "";
    deleteBtn?.classList.add("d-none");
  }, [date]);

  const postNote = useCallback(
    async (payload: Record<string, unknown>, fallbackError: string): Promise<{ ok: boolean; note?: CalendarNote | null }> => {
      try {
        const res = await fetch(`/api/manage/calendar?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ slug, ...payload }),
        });
        const json: { ok?: boolean; error?: string; note?: CalendarNote | null } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          // Fallback legacy per azione: 'Errore nel salvataggio.' / 'Errore in eliminazione.'
          setNotesAlert({ text: String(json.error || fallbackError), kind: "danger" });
          return { ok: false };
        }
        loadContext(date, visibleRange);
        return { ok: true, note: json.note ?? null };
      } catch {
        setNotesAlert({ text: fallbackError, kind: "danger" });
        return { ok: false };
      }
    },
    [slug, date, loadContext, visibleRange],
  );

  // Attach the notes form submit / delete / "Nuova" / card-click handlers once the
  // static modal is in the DOM. Re-runs when `notes` change so card clicks always
  // reference the freshest list, and is idempotent (listeners removed on cleanup).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.getElementById("calendarNotesModal");
    if (!root) return;
    notesModalRef.current = root as HTMLDivElement;

    const form = root.querySelector<HTMLFormElement>("#calendarNotesForm");
    const newBtn = root.querySelector<HTMLButtonElement>("#calendarNotesNewBtn");
    const deleteBtn = root.querySelector<HTMLButtonElement>("#calendarNoteDeleteBtn");
    const idEl = root.querySelector<HTMLInputElement>("#calendar_note_id");
    const dateEl = root.querySelector<HTMLInputElement>("#calendar_note_date");
    const titleEl = root.querySelector<HTMLInputElement>("#calendar_note_title");
    const textEl = root.querySelector<HTMLTextAreaElement>("#calendar_note_text");
    const list = root.querySelector<HTMLElement>("#calendarNotesList");

    const onSubmit = async (e: Event) => {
      e.preventDefault();
      const noteDate = String(dateEl?.value ?? "").trim();
      const noteText = String(textEl?.value ?? "").trim();
      // Validazioni legacy SEPARATE (calendar.js 979-986).
      if (!noteDate || !/^\d{4}-\d{2}-\d{2}$/.test(noteDate)) {
        setNotesAlert({ text: "Seleziona un giorno valido.", kind: "danger" });
        return;
      }
      if (!noteText) {
        setNotesAlert({ text: "Scrivi il testo della nota.", kind: "danger" });
        return;
      }
      // Calcolato PRIMA del salvataggio, come noteIsVisibleInCurrentRange (il periodo
      // visibile è la finestra note della vista corrente, half-open [from, to)).
      const noteIsVisible = noteDate >= visibleRange.from && noteDate < visibleRange.to;
      const { ok, note } = await postNote({
        action: "note_save",
        id: Number(idEl?.value ?? 0) || 0,
        note_date: noteDate,
        title: String(titleEl?.value ?? "").trim(),
        note_text: noteText,
      }, "Errore nel salvataggio.");
      if (!ok) return;
      // Legacy: la nota salvata resta caricata nel form (fillCalendarNoteForm) se il
      // server ne restituisce l'id; altrimenti reset in modalità nuova.
      if (note && Number(note.id ?? 0) > 0) {
        if (idEl) idEl.value = String(note.id);
        if (dateEl) dateEl.value = note.noteDate ?? noteDate;
        if (titleEl) titleEl.value = note.title ?? "";
        if (textEl) textEl.value = note.noteText ?? noteText;
        deleteBtn?.classList.remove("d-none");
      } else {
        resetNotesForm();
      }
      setNotesAlert({
        text: noteIsVisible
          ? "Nota salvata con successo."
          : "Nota salvata con successo. La data selezionata e fuori dal periodo visibile: la vedrai in elenco quando il calendario mostrera quel giorno.",
        kind: "success",
      });
    };

    const onDelete = async () => {
      const id = Number(idEl?.value ?? 0) || 0;
      if (id <= 0) return;
      if (!window.confirm("Eliminare questa nota?")) return;
      const { ok } = await postNote({ action: "note_delete", id }, "Errore in eliminazione.");
      if (!ok) return;
      resetNotesForm();
      setNotesAlert({ text: "Nota eliminata.", kind: "success" });
    };

    const onNew = () => resetNotesForm();

    // Load an existing note into the form for editing when its card is clicked.
    const onCardClick = (e: Event) => {
      const card = (e.target as HTMLElement)?.closest<HTMLElement>(".calendar-note-card[data-note-id]");
      if (!card) return;
      const id = Number(card.dataset.noteId ?? 0) || 0;
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      if (idEl) idEl.value = String(note.id);
      if (dateEl) dateEl.value = note.noteDate;
      if (titleEl) titleEl.value = note.title ?? "";
      if (textEl) textEl.value = note.noteText ?? "";
      deleteBtn?.classList.remove("d-none");
    };

    form?.addEventListener("submit", onSubmit);
    deleteBtn?.addEventListener("click", onDelete);
    newBtn?.addEventListener("click", onNew);
    list?.addEventListener("click", onCardClick);
    return () => {
      form?.removeEventListener("submit", onSubmit);
      deleteBtn?.removeEventListener("click", onDelete);
      newBtn?.removeEventListener("click", onNew);
      list?.removeEventListener("click", onCardClick);
    };
  }, [notes, postNote, resetNotesForm, visibleRange]);

  // Open the notes modal from the header button, starting in "new note" mode.
  const openNotesModal = useCallback(() => {
    setNotesFilterDate(null);
    resetNotesForm();
    setNotesAlert(null);
    showNotesModal();
  }, [resetNotesForm]);

  // GAP 5: open the notes modal filtered to a single day (clicking a day's note marker in
  // the week view), switching the caption to "Giorno selezionato".
  const openNotesModalForDate = useCallback((iso: string) => {
    setNotesFilterDate(iso);
    resetNotesForm(iso); // M23: prefill del giorno cliccato
    setNotesAlert(null);
    showNotesModal();
  }, [resetNotesForm]);

  // === Staff-column ordering modal ===
  // The pinned (logged-in) operator, resolved from the live staff list (its own
  // column is always rendered first and is NOT part of the reorderable list).
  const pinnedStaff = useMemo(
    () => (currentStaffId > 0 ? staff.find((s) => s.id === currentStaffId) ?? null : null),
    [staff, currentStaffId],
  );

  // The OTHER operators (everything except the pinned one), in the CURRENT applied
  // order (i.e. the live Day-view column order minus the pinned column). Port of
  // getOtherStaffCols — this is what the modal lists for reordering.
  const otherStaffCols = useMemo(
    () => staffCols.filter((s) => !(currentStaffId > 0 && s.id === currentStaffId)),
    [staffCols, currentStaffId],
  );

  const openStaffOrderModal = useCallback(() => {
    setStaffOrderError("");
    // Seed the editable rows from the current applied order of the other operators.
    setStaffOrderRows(otherStaffCols.slice());
    showStaffOrderModal();
  }, [otherStaffCols]);

  // Move a row up/down within the modal list (port of the chevron buttons).
  const moveStaffOrderRow = useCallback((index: number, delta: number) => {
    setStaffOrderRows((prev) => {
      const next = prev.slice();
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });
  }, []);

  // Reorder via drag-drop: move the dragged row to the drop row's position
  // (port of ensureStaffOrderDnD's insertBefore behavior).
  const dropStaffOrderRow = useCallback((dropIndex: number) => {
    const from = staffOrderDragIndexRef.current;
    staffOrderDragIndexRef.current = null;
    if (from === null || from === dropIndex) return;
    setStaffOrderRows((prev) => {
      const next = prev.slice();
      const [row] = next.splice(from, 1);
      next.splice(dropIndex > from ? dropIndex - 1 : dropIndex, 0, row);
      return next;
    });
  }, []);

  const saveStaffOrder = useCallback(async () => {
    setStaffOrderError("");
    setStaffOrderSaving(true);
    try {
      const ids = staffOrderRows.map((s) => Number(s.id) || 0).filter((n) => n > 0);
      const res = await fetch(`/api/manage/calendar?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, action: "set_calendar_day_staff_order", order: JSON.stringify(ids) }),
      });
      const json: { ok?: boolean; error?: string; order?: number[] } = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false || json.error) {
        throw new Error(String(json.error || "Impossibile salvare l'ordinamento"));
      }
      // Apply immediately (staffCols re-derives from savedStaffOrder) and reload so
      // the persisted order survives subsequent refetches.
      setSavedStaffOrder(normalizeStaffOrder(Array.isArray(json.order) ? json.order : ids));
      hideStaffOrderModal();
      loadContext(date, visibleRange);
    } catch (err) {
      setStaffOrderError(err instanceof Error ? err.message : "Errore");
    } finally {
      setStaffOrderSaving(false);
    }
  }, [staffOrderRows, slug, date, visibleRange, loadContext]);

  // === Date-picker open/close (port of toggle/open/closeCalendarDatePicker) ===
  // The Data button toggles the popover; opening seeds the browse cursor from the
  // selected `date` (setCalendarDatePickerCursor(getCalendarFocusDate())).
  const togglePicker = useCallback(() => {
    setPickerOpen((open) => {
      if (!open) setPickerCursor(date);
      return !open;
    });
  }, [date]);

  // Close the popover on outside-click + Esc (port of the body click / keydown wiring
  // in the legacy). Bound only while open. A click inside pickerHostRef (the toolbar
  // chunk that contains both the Data button and the popover) is ignored so toggling
  // and cell clicks are handled by their own onClick, not closed here first.
  useEffect(() => {
    if (!pickerOpen) return;
    if (typeof document === "undefined") return;
    const onDocClick = (ev: MouseEvent) => {
      const host = pickerHostRef.current;
      if (host && ev.target instanceof Node && host.contains(ev.target)) return;
      setPickerOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // Switch the active view and close any open picker (mirrors syncCalendarDatePicker-
  // State, which closes the open picker on a view change). Used by the Giorno/
  // Settimana/Mese tabs so a mode switch never leaves a stale-mode popover open.
  const switchView = useCallback((target: CalendarView) => {
    setView(target);
    setPickerOpen(false);
  }, []);

  // The picker mode follows the active view (getCalendarDatePickerMode):
  //   Day view -> day grid, Week view -> week list, Month view -> month grid.
  const pickerMode: "day" | "week" | "month" =
    view === "timeGridWeek" ? "week" : view === "dayGridMonth" ? "month" : "day";

  // Header label above the grid (port of currentLabel): month+year while browsing
  // days/weeks, just the year while browsing months.
  const pickerHeaderLabel =
    pickerMode === "month" ? String(new Date(`${pickerCursor}T12:00:00`).getFullYear()) : monthTitle(pickerCursor);

  // Footer "selected" label (port of the selectedLabel block).
  const pickerSelectedLabel =
    pickerMode === "week"
      ? `Settimana ${pickerWeekLong(weekStart(date))}`
      : pickerMode === "month"
        ? `Mese selezionato: ${IT_MONTHS[monthOf(date)] ?? ""} ${new Date(`${date}T12:00:00`).getFullYear()}`
        : pickerLongDate(date);

  // Footer "today" link label per mode (port of cfg.todayLabel).
  const pickerTodayLabel =
    pickerMode === "week" ? "Questa settimana" : pickerMode === "month" ? "Questo mese" : "Oggi";
  // Nav button aria-labels per mode (port of cfg.navPrev / navNext).
  const pickerNavPrev = pickerMode === "month" ? "Anno precedente" : "Mese precedente";
  const pickerNavNext = pickerMode === "month" ? "Anno successivo" : "Mese successivo";
  const pickerToolbarLabel =
    pickerMode === "week" ? "Seleziona una settimana" : pickerMode === "month" ? "Seleziona un mese" : "Seleziona una data";

  // ‹ › steppers: Day/Week step the cursor MONTH, Month steps the cursor YEAR. They
  // move the browse cursor only — the selected `date` is unchanged until a cell click
  // (port of shiftCalendarDatePickerCursor).
  const stepPicker = useCallback(
    (dir: -1 | 1) => {
      setPickerCursor((cur) => (pickerMode === "month" ? shiftYearIso(cur, dir) : shiftMonthIso(cur, dir)));
    },
    [pickerMode],
  );

  // The "today" footer link: jump the selected date to today and close (port of the
  // data-cal-action="today" handler, which gotoDate(today) then closes).
  const pickerGoToday = useCallback(() => {
    setDate(isoLocal(new Date()));
    setPickerOpen(false);
  }, []);

  // Selecting a cell sets the selected date and closes (port of the data-cal-target-
  // date handler: gotoDate(selected) then close). For Week mode the value passed is
  // already the week's Monday; for Month mode it is the first of the month.
  const pickerSelect = useCallback((iso: string) => {
    setDate(iso);
    setPickerOpen(false);
  }, []);

  function viewBtn(target: CalendarView, label: string) {
    const active = view === target;
    return (
      <button
        type="button"
        className={`fc-button fc-button-primary fc-${target}-button${active ? " fc-button-active" : ""}`}
        aria-pressed={active}
        onClick={() => switchView(target)}
      >
        {label}
      </button>
    );
  }

  // === WEEK (timeGridWeek) ===
  // A 7-column (Mon..Sun) x time-rows grid over the union of the week's business
  // hours. Each appointment is positioned in its day column at its start time, with
  // height from endTime (PX_PER_MIN), styled with the operator color + status badge
  // like the Day view, listing the operator + EVERY booked service as bulleted lines.
  // Clicking a block opens the GLOBAL edit drawer. Uses the FullCalendar
  // .fc-timegrid-* / .fc-col-header-cell classes so the page CSS applies.
  // INTERACTION (same set as the Day view, just per-DAY columns instead of per-operator):
  //   - MOVE: blocks are HTML5-draggable; dropping on a day column moves the appointment
  //     to THAT day + the snapped drop time, operator unchanged (onWeekColumn*/onWeekBlock*
  //     -> moveAppointmentToDate, which posts a new date+time via action=move — the route
  //     already accepts a target date and reuses the conflict check, no route/repo change).
  //   - RESIZE: the bottom-edge cal-resize-handle changes the end time (beginResize reads
  //     the day column's window from its data-* attrs, so the same flow serves Week).
  //   - QUICK-BOOK / drag-select / hover: unchanged (the empty-cell click books that DAY).
  // Built as a component-scope const (not a nested function) so its ref-touching block
  // drag/resize handlers sit in the component's OWN render scope — lint-clean, like the
  // inline Day view. Uses the lifted weekTodayIso / weekDays. Guarded by the view so the
  // heavy per-day JSX is only built when the Week view is active (parity with the lazy
  // renderMonthView()/Day branch), and null otherwise.
  const weekView = view !== "timeGridWeek" ? null : (
      <div className="cal-static-grid" style={{ display: "flex", minHeight: weekGridHeight }}>
        {/* Time axis */}
        <div className="cal-static-axis" style={{ flex: "0 0 56px", borderRight: "1px solid var(--calendar-line, #e2e8f0)", position: "relative" }}>
          {/* 44px corner spacer — sticky-top like the week header cells. */}
          <div style={{ height: 44, position: "sticky", top: 0, zIndex: 10, background: "#fff" }} />
          {/* NOW-INDICATOR axis side (Settimana): red arrow + HH:MM label at the now
              line's Y plus the 44px header offset. */}
          {weekNowIndicator ? (
            <>
              <span
                className="fc-timegrid-now-indicator-arrow"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: 0,
                  top: 44 + weekNowIndicator.top,
                  marginTop: -5,
                  width: 0,
                  height: 0,
                  borderTop: "5px solid transparent",
                  borderBottom: "5px solid transparent",
                  borderRight: "6px solid #ef4444",
                  pointerEvents: "none",
                  zIndex: 7,
                }}
              />
              {/* L13: nessuna label HH:MM sull'indicatore ora — il legacy
                  (FullCalendar nowIndicator) rende solo linea + freccia. */}
            </>
          ) : null}
          {weekRows.map((m) => {
            const major = isMajorRow(m);
            return (
              <div
                key={m}
                className={`fc-timegrid-slot-label${major ? "" : " fc-timegrid-slot-minor"}`}
                style={{ height: ROW_HEIGHT, fontSize: 11, color: "#64748b", textAlign: "right", paddingRight: 6, boxSizing: "border-box" }}
              >
                {major ? `${pad(Math.floor(m / 60))}:${pad(m % 60)}` : ""}
              </div>
            );
          })}
        </div>

        {/* Day columns */}
        <div style={{ display: "flex", flex: "1 1 auto", minWidth: 0, position: "relative" }}>
          {/* NOW-INDICATOR line (Settimana): a single red line spanning all 7 day
              columns, like FullCalendar's nowIndicator across the timegrid body.
              Reuses the legacy .fc-timegrid-now-indicator-line class; positioned at
              the now Y plus the 44px column-header offset. */}
          {weekNowIndicator ? (
            <div
              className="fc-timegrid-now-indicator-line"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 44 + weekNowIndicator.top,
                borderTop: "2px solid #ef4444",
                pointerEvents: "none",
                zIndex: 6,
              }}
            />
          ) : null}
          {/* HOVER guide line spanning ALL 7 day columns (legacy: the line is
              appended to .fc-timegrid-cols, crossing the whole grid). */}
          {renderHoverGuideLine("week-", 44)}
          {weekDays.map((iso, i) => {
            const d = new Date(`${iso}T12:00:00`);
            const isToday = iso === weekTodayIso;
            const noteCount = countByDate[iso] ?? 0;
            const dayAppts = rangeApptsByDate[iso] ?? [];
            return (
              <div
                key={iso}
                className={`fc-timegrid-col${isToday ? " fc-day-today" : ""}`}
                style={{ flex: "1 1 0", minWidth: 0, borderRight: "1px solid var(--calendar-line, #e2e8f0)", position: "relative" }}
              >
                <div
                  data-date={iso}
                  className={`fc-col-header-cell${isToday ? " fc-day-today" : ""}${noteCount > 0 ? " has-calendar-notes" : ""}`}
                  // sticky: pinned at the top of the .fc-scroller while the week grid
                  // scrolls; the page CSS provides the (today-tinted) opaque background.
                  style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--calendar-line, #e2e8f0)", position: "sticky", top: 0, zIndex: 8 }}
                >
                  <span className="fc-col-header-cell-cushion">
                    <span className="calendar-weekday-full">
                      <span className="calendar-weekday-short">{IT_SHORT_WEEKDAYS_MON[i]}</span>
                      <span className="calendar-weekday-date">{`${pad(d.getDate())}/${pad(d.getMonth() + 1)}`}</span>
                    </span>
                    {noteCount > 0 ? (
                      <button
                        type="button"
                        className="calendar-note-marker-wrap"
                        onClick={() => openNotesModalForDate(iso)}
                        title={`${noteCount} note — apri il giorno selezionato`}
                        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
                      >
                        <span className="calendar-note-marker" aria-label={`${noteCount} note`}>
                          <i className="bi bi-stickies" aria-hidden="true" />
                          <span>{noteCount}</span>
                        </span>
                      </button>
                    ) : null}
                  </span>
                </div>

                {/* Slot rows (background) + positioned appointment blocks. Doubles as the
                    day column's quick-book surface (empty-cell click) + drag-select +
                    hover indicator, mapping the Y offset within this body (window =
                    weekMinMin..weekMaxMin). */}
                <div
                  className="cal-col-body"
                  // Geometry the root-level hover / drag-select listeners read (see the
                  // installer effect). data-staffid: fuori dalla vista a colonne il
                  // legacy prefilla l'operatore del FILTRO (select handler: staffId =
                  // currentStaff); data-celldate is this column's day for quick-book.
                  data-cal-body="1"
                  data-col={`week-${iso}`}
                  data-winstart={weekMinMin}
                  data-winend={weekMaxMin}
                  data-staffid={Number(filterStaff) || 0}
                  data-celldate={iso}
                  style={{ position: "relative", height: weekGridHeight }}
                  // Block drag-move DROP target: a Week block dropped here moves to THIS
                  // column's day + the snapped drop time (operator unchanged). onDragOver
                  // must allow the drop for the browser to fire onDrop; aggiorna anche il
                  // GHOST snappato con la validità contro i blocchi di QUESTA colonna.
                  onDragOver={(e) => onWeekColumnDragOver(iso, expandSegments(dayAppts), e)}
                  onDrop={(e) => onWeekColumnDrop(iso, e)}
                  // Plain-click quick-book on the empty background (blocks stopPropagation);
                  // guarded against the click trailing a drag / resize / drag-select.
                  onClick={(e) => onWeekColumnClick(iso, e)}
                >
                  {/* Store-background shading per DAY column (unavailable / lunch break /
                      closed), computed from THIS column's date over the shared week
                      window. Behind the slot lines + blocks + now-indicator and
                      non-interactive (pointer-events:none). */}
                  {renderStoreBands(iso, weekMinMin, weekMaxMin, false, false)}
                  {/* HOVER guide-line / slot-highlight / time label + live drag-select
                      band overlays for this day column (non-interactive). */}
                  {renderHoverOverlay(`week-${iso}`, weekMinMin)}
                  {/* GHOST di spostamento: destinazione snappata + orario + validità. */}
                  {moveGhost && moveGhost.col === `week-${iso}` ? renderMoveGhostBand(moveGhost) : null}
                  {weekRows.map((m) => {
                    const major = isMajorRow(m);
                    return (
                      <div
                        key={m}
                        className={`fc-timegrid-slot${major ? "" : " fc-timegrid-slot-minor"}`}
                        style={{ height: ROW_HEIGHT, borderTop: `1px solid ${major ? SLOT_LINE_MAJOR : SLOT_LINE_MINOR}`, boxSizing: "border-box" }}
                      />
                    );
                  })}

                  {/* One VIRTUAL block per segment (legacy per-segment list events) so a
                      multi-operator booking shows each operator's own window. */}
                  {expandSegments(dayAppts).map((a) => {
                    const startMin = timeToMin(a.time);
                    if (startMin === null) return null;
                    const top = (startMin - weekMinMin) * PX_PER_MIN;
                    // Block height from the REAL end (a.endTime) — or the live resize
                    // preview while THIS block is being resized — falling back to the
                    // default duration when no end is known, mirroring the Day view.
                    const previewEnd = resizePreview?.id === a.id ? resizePreview.endTime : null;
                    const endMinVal = timeToMin(previewEnd ?? a.endTime ?? "");
                    const durationMin = endMinVal !== null && endMinVal > startMin ? endMinVal - startMin : DEFAULT_DURATION_MIN;
                    const height = Math.max(durationMin * PX_PER_MIN - 2, 18);
                    const st = statusKeyFromLabel(a.statusCode ?? a.status);
                    // Tema soft per STATO (port di applyCalendarSoftAppointmentStyle);
                    // il colore operatore resta solo sul pallino.
                    const theme = statusThemeOf(a.statusCode ?? a.status);
                    const op = findOperatorStaff(staff, a);
                    // Pallino con staffColorHex legacy: colore salvato valido, altrimenti
                    // palette per abs(id)%10; operatore ignoto -> #e5e7eb.
                    const accent = staffColorHex(Number(a.segStaffId ?? a.operatorId ?? op?.id ?? 0) || 0, op?.color);
                    // editable legacy (api list :8030+8100): drag/resize SOLO con manage
                    // E stato pending/scheduled (annullati/eseguiti non trascinabili).
                    const canDragBlock = canManage && (st.key === "pending" || st.key === "scheduled");
                    // MS group meta + adaptive density (tiny <28px, compact 28-54px).
                    const msCount = msCountOf(a);
                    const msAccent = msCount > 1 ? msAccentByAppt[a.id] : "";
                    const density = height < 28 ? " appt-event-tiny" : height < 54 ? " appt-event-compact" : "";
                    return (
                      <a
                        key={`${a.id}-${a.time}`}
                        href={href(`appointments&action=view&id=${a.id}`)}
                        className={`fc-event fc-timegrid-event appt-soft-event appt-soft-${theme.key}${density}${msAccent ? " ms-has-accent" : ""}${msAccent && msHoverGroup === a.id ? " ms-active" : ""}`}
                        data-ms-group={msAccent ? a.id : undefined}
                        onMouseEnter={msAccent ? () => setMsHoverGroup(a.id) : undefined}
                        onMouseLeave={msAccent ? () => setMsHoverGroup(0) : undefined}
                        title={`${a.time} ${a.client} • ${serviceTitleOf(a)}${a.operator ? ` (${a.operator})` : ""}`}
                        // DRAG-MOVE: a Week block is HTML5-draggable to another day column /
                        // time (changes the DATE, operator unchanged). Component-scope drag
                        // handlers keep the dragRef writes out of this render helper.
                        draggable={canDragBlock}
                        // A press on a block must not start the column drag-select.
                        onMouseDown={(e) => e.stopPropagation()}
                        onDragStart={(e) => onWeekBlockDragStart(a, e)}
                        onDragEnd={onWeekBlockDragEnd}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // A drag/resize just ended -> swallow the trailing click (no edit).
                          if (dragRef.current || resizeRef.current) return;
                          openGlobalEdit(a.id);
                        }}
                        style={{
                          position: "absolute",
                          top,
                          height,
                          left: 2,
                          right: 2,
                          overflow: "hidden",
                          borderRadius: 6,
                          padding: "3px 6px",
                          fontSize: 12,
                          textDecoration: "none",
                          boxSizing: "border-box",
                          // Above the store-background bands (z 0) so blocks stay
                          // visible/clickable over the shading.
                          zIndex: 3,
                          ...softEventStyle(theme),
                          // In trascinamento: tutti i blocchi del booking attenuati.
                          ...(draggingApptId === Number(a.id) ? { opacity: 0.35 } : {}),
                          ...(msAccent ? ({ "--ms-accent": msAccent } as React.CSSProperties) : null),
                        }}
                      >
                        {/* Card rows, faithful to the legacy eventContent + prepends:
                            row 1 = time range + duration, row 2 = dot + status badge +
                            [MS] + client, "• operator" (showStaff=true in Week), then
                            one "• service" row each. */}
                        <div className="fc-event-main">
                          <div className="appt-event">
                            <div className="appt-time">{apptTimeLine(a.time, previewEnd ?? a.endTime)}</div>
                            <div className="fc-event-title appt-client" style={{ lineHeight: 1.15 }}>
                              <span className="appt-staff-dot" title="Operatore" style={{ background: accent }} />
                              <span className={`appt-status-badge status-${st.key}`} title={`Stato: ${st.label}`}>
                                {st.label}
                              </span>
                              {msAccent ? (
                                <span className="ms-badge" title={`Prenotazione multi-servizio (${msCount})`}>
                                  <span className="ms-dot" />
                                  <span className="ms-label">MS</span>
                                </span>
                              ) : null}
                              <span className="appt-client-name">{a.client}</span>
                            </div>
                            {a.operator ? (
                              <div className="text-truncate appt-staff">{`• ${a.operator}`}</div>
                            ) : null}
                            {serviceNamesOf(a).map((name, i) => (
                              <div key={i} className="text-truncate appt-service">
                                {`• ${name}`}
                              </div>
                            ))}
                          </div>
                        </div>
                        {/* RESIZE handle (bottom edge): drag to change the end time (custom
                            duration), identical to the Day view, positioned in this day
                            column. NOT rendered on segment blocks (legacy
                            durationEditable:false) né sui blocchi non-editable
                            (annullati/eseguiti). beginResize reads the body's window
                            from its data-* attrs. */}
                        {a.segmentId || !canDragBlock ? null : (
                          <span
                            className="cal-resize-handle"
                            role="presentation"
                            onMouseDown={(e) => beginResize(e, a)}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              bottom: 0,
                              height: 8,
                              cursor: "ns-resize",
                            }}
                          />
                        )}
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
  );

  // === MONTH (dayGridMonth) ===
  // A 6x7 Monday-first grid; each cell shows the date number + ALL of that day's
  // appointment cards (the legacy has NO dayMaxEvents cap, so there is no "+N"
  // overflow link — cells grow). Cards use the SAME legacy eventContent rows as the
  // time grids (time range, dot + status badge + [MS] + client, "• operator" —
  // shown in Week/Month — and one "• service" row each) with the per-status soft
  // theme; segmented bookings render one card PER SEGMENT (expandSegments).
  // INTERACTIONS (port of the legacy dayGridMonth):
  //   - chip click -> GLOBAL edit drawer;
  //   - chip DRAG onto another day cell -> action=move keeping the chip's TIME and
  //     changing the DATE (segments shift the whole appointment by the date delta);
  //   - empty-day click -> quick-book drawer prefilled with that date + 00:00 and
  //     the operator filter (port of the FullCalendar `select` on a month cell,
  //     which fires with the day's 00:00 start);
  //   - closure dates carry .store-closure-date (dayCellClassNames port) unless a
  //     special opening overrides them.
  // Built as a component-scope const (not a nested function) so its ref-touching
  // drag/drop/click handlers sit in the component's OWN render scope — lint-clean,
  // like the inline Week/Day views.
  const monthFocus = monthOf(date);
  const monthTodayIso = isoLocal(new Date());
  const monthDates = monthGridDates(date);
  const monthView = view !== "dayGridMonth" ? null : (
      <div className="fc-daygrid-body" style={{ width: "100%" }}>
        {/* Weekday header row (Mon..Dom) */}
        <div className="fc-col-header" style={{ display: "flex", borderBottom: "1px solid var(--calendar-line, #e2e8f0)" }}>
          {IT_SHORT_WEEKDAYS_MON.map((wd, i) => (
            <div key={i} className="fc-col-header-cell" style={{ flex: "1 1 0", minWidth: 0, textAlign: "center" }}>
              <span className="fc-col-header-cell-cushion">
                <span className="calendar-weekday-full">{wd}</span>
              </span>
            </div>
          ))}
        </div>

        {/* 6 week rows */}
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} className="fc-daygrid-row" style={{ display: "flex", minHeight: 104 }}>
            {monthDates.slice(week * 7, week * 7 + 7).map((iso) => {
              const dnum = new Date(`${iso}T12:00:00`).getDate();
              const inMonth = monthOf(iso) === monthFocus;
              const isToday = iso === monthTodayIso;
              const dayAppts = rangeApptsByDate[iso] ?? [];
              const noteCount = countByDate[iso] ?? 0;
              // Chiusura evidenziata SOLO senza un'apertura straordinaria che la
              // scavalca (port di dayCellClassNames + specialOpenRowForDateKey).
              const isClosure = closures.some((c) => c.date === iso)
                && !exceptions.some((x) => x.date === iso && !x.isClosed);
              return (
                <div
                  key={iso}
                  data-date={iso}
                  className={`fc-daygrid-day${inMonth ? "" : " fc-day-other"}${isToday ? " fc-day-today" : ""}${noteCount > 0 ? " has-calendar-notes" : ""}${isClosure ? " store-closure-date" : ""}`}
                  style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    borderRight: "1px solid var(--calendar-line, #e2e8f0)",
                    borderBottom: "1px solid var(--calendar-line, #e2e8f0)",
                    padding: 4,
                    opacity: inMonth ? 1 : 0.45,
                    cursor: "pointer",
                    // GHOST mese: cella di destinazione evidenziata durante il drag
                    // (il chip conserva l'ORARIO, cambia solo la data).
                    ...(moveGhost && moveGhost.col === `month-${iso}`
                      ? { background: "rgba(47,99,244,.10)", boxShadow: "inset 0 0 0 2px #2f63f4", borderRadius: 4 }
                      : {}),
                  }}
                  // Drop target del drag chip (cambio DATA, orario conservato).
                  onDragOver={(e) => {
                    const drag = dragRef.current;
                    if (drag) {
                      e.preventDefault();
                      try { e.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
                      autoScrollOnDragOver(e);
                      updateMoveGhost({
                        col: `month-${iso}`,
                        top: 0,
                        height: 0,
                        label: `${drag.block.time}`,
                        state: "ok",
                        note: "",
                      });
                    }
                  }}
                  onDrop={(e) => onMonthCellDrop(iso, e)}
                  onClick={(e) => {
                    // Click su giorno vuoto -> quick-book prefillato su quel giorno
                    // alle 00:00 (port della select FullCalendar in dayGridMonth,
                    // che parte dalla mezzanotte della cella) con l'operatore del
                    // filtro. I chip fermano la propagazione.
                    if ((e.target as HTMLElement).closest(".fc-daygrid-event")) return;
                    if (dragRef.current) return;
                    openGlobalQuickBook("00:00", Number(filterStaff) || 0, undefined, iso);
                  }}
                >
                  <div className="fc-daygrid-day-top" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                    <a className="fc-daygrid-day-number" style={{ textDecoration: "none", color: "inherit", fontSize: 12, fontWeight: 600 }}>
                      {dnum}
                    </a>
                    {/* M22: marker solo sui giorni DEL MESE (non sugli spillover della
                        griglia 42gg), coerente col conteggio esatto-mese del modale. */}
                    {inMonth && noteCount > 0 ? (
                      <span
                        className="calendar-note-marker-wrap"
                        role="button"
                        tabIndex={0}
                        // M19: il marker apre le NOTE del giorno (prima il click
                        // ricadeva sulla cella -> quick-book). stopPropagation evita
                        // che la cella apra la prenotazione rapida.
                        onClick={(e) => { e.stopPropagation(); openNotesModalForDate(iso); }}
                      >
                        <span className="calendar-note-marker" role="img" aria-label={`${noteCount} note`}>
                          <i className="bi bi-stickies" aria-hidden="true" />
                          <span>{noteCount}</span>
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <div className="fc-daygrid-day-events" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                    {expandSegments(dayAppts).map((a) => {
                      const st = statusKeyFromLabel(a.statusCode ?? a.status);
                      const theme = statusThemeOf(a.statusCode ?? a.status);
                      const op = findOperatorStaff(staff, a);
                      const accent = staffColorHex(Number(a.segStaffId ?? a.operatorId ?? op?.id ?? 0) || 0, op?.color);
                      const canDragBlock = canManage && (st.key === "pending" || st.key === "scheduled");
                      const msCount = msCountOf(a);
                      const msAccent = msCount > 1 ? msAccentByAppt[a.id] : "";
                      return (
                        <a
                          key={`${a.id}-${a.time}`}
                          href={href(`appointments&action=view&id=${a.id}`)}
                          className={`fc-event fc-daygrid-event appt-soft-event appt-soft-${theme.key}${msAccent ? " ms-has-accent" : ""}${msAccent && msHoverGroup === a.id ? " ms-active" : ""}`}
                          data-ms-group={msAccent ? a.id : undefined}
                          onMouseEnter={msAccent ? () => setMsHoverGroup(a.id) : undefined}
                          onMouseLeave={msAccent ? () => setMsHoverGroup(0) : undefined}
                          title={`${a.time} ${a.client} • ${serviceTitleOf(a)}${a.operator ? ` (${a.operator})` : ""} (${st.label})`}
                          // DRAG-MOVE: il chip è trascinabile su un'altra cella-giorno
                          // (cambia la DATA, l'orario resta quello del chip); editable
                          // legacy = manage && pending/scheduled.
                          draggable={canDragBlock}
                          onDragStart={(e) => onWeekBlockDragStart(a, e)}
                          onDragEnd={onWeekBlockDragEnd}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (dragRef.current) return;
                            openGlobalEdit(a.id);
                          }}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            borderRadius: 5,
                            padding: "1px 5px",
                            fontSize: 11,
                            textDecoration: "none",
                            ...softEventStyle(theme),
                            ...(msAccent ? ({ "--ms-accent": msAccent } as React.CSSProperties) : null),
                          }}
                        >
                          {/* Stesse righe card del legacy eventContent (Week/Month
                              mostrano anche la riga "• operatore"). */}
                          <div className="fc-event-main">
                            <div className="appt-event">
                              <div className="appt-time">{apptTimeLine(a.time, a.endTime)}</div>
                              <div className="fc-event-title appt-client" style={{ lineHeight: 1.15 }}>
                                <span className="appt-staff-dot" title="Operatore" style={{ background: accent }} />
                                <span className={`appt-status-badge status-${st.key}`} title={`Stato: ${st.label}`}>
                                  {st.label}
                                </span>
                                {msAccent ? (
                                  <span className="ms-badge" title={`Prenotazione multi-servizio (${msCount})`}>
                                    <span className="ms-dot" />
                                    <span className="ms-label">MS</span>
                                  </span>
                                ) : null}
                                <span className="appt-client-name">{a.client}</span>
                              </div>
                              {a.operator ? (
                                <div className="text-truncate appt-staff">{`• ${a.operator}`}</div>
                              ) : null}
                              {serviceNamesOf(a).map((name, i) => (
                                <div key={i} className="text-truncate appt-service">
                                  {`• ${name}`}
                                </div>
                              ))}
                            </div>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
  );

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/calendar.css" />

      {/* Hidden anchors that bridge calendar interactions to the GLOBAL quick-booking
          drawer's document-level listeners. Clicking an appointment block sets the
          edit anchor's data-qb-edit and clicks it (drawer opens in EDIT mode);
          clicking an empty cell sets the new anchor's data-qb-date/time/staff and
          clicks it (drawer opens prefilled in CREATE mode). Visually hidden. */}
      <a id="calQbEditAnchor" data-qb-edit="" href="#" className="d-none" aria-hidden="true" tabIndex={-1} onClick={(e) => e.preventDefault()} />
      <a id="calQbNewAnchor" data-qb-new="1" href="#" className="d-none" aria-hidden="true" tabIndex={-1} onClick={(e) => e.preventDefault()} />

      <div className="bs-page-header calendar-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Agenda</div>
          <h1 className="bs-page-title">Calendario</h1>
          <div className="bs-page-subtitle">Consulta disponibilita, appuntamenti e note della sede.</div>
        </div>
        <div className="bs-page-actions">
          <button type="button" className="btn btn-outline-secondary btn-sm calendar-notes-top-btn" id="calendarNotesBtn" onClick={openNotesModal}>
            <i className="bi bi-stickies me-1" />
            Note
            <span
              className={`badge rounded-pill text-bg-danger calendar-notes-top-btn__badge${notesCount ? "" : " d-none"}`}
              id="calendarNotesBtnBadge"
            >
              {notesCount}
            </span>
          </button>
          {/* 'Lista' SOLO con appointments.manage (calendar.php 301-303). */}
          {canManage ? (
            <a className="btn btn-outline-secondary btn-sm" href={href("appointments")}>
              <i className="bi bi-list-task me-1" />
              Lista
            </a>
          ) : null}
        </div>
      </div>

      <div className="calendar-page">
        <div className="calendar-filter-bar">
          <input type="hidden" id="filterLocation" value="" />
          <div className="calendar-filter-field calendar-filter-field--staff">
            <label className="form-label small text-muted">Operatore</label>
            <select className="form-select" id="filterStaff" value={filterStaff} onChange={(e) => setFilterStaff(e.target.value)}>
              <option value="">Tutti gli operatori</option>
              {staff.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="calendar-filter-field calendar-filter-field--service">
            <label className="form-label small text-muted">Servizio</label>
            <select
              className="form-select"
              id="filterService"
              value={filterService}
              onChange={(e) => setFilterService(e.target.value)}
            >
              <option value="">Tutti i servizi</option>
              {services.map((s) => (
                <option key={s.id} value={String(s.id)} data-location-ids={(s.locationIds ?? []).join(",")}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="calendar-filter-field calendar-filter-field--status">
            <label className="form-label small text-muted">Stato</label>
            <select className="form-select" id="filterStatus" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">Tutti</option>
              <option value="pending">In attesa</option>
              <option value="scheduled">Prenotato</option>
              <option value="done">Eseguito</option>
              <option value="canceled">Annullato</option>
              <option value="no_show">No show</option>
            </select>
          </div>
        </div>

        <div className="calendar-shell calendar-shell--agenda">
          {/*
            Reproduces the FullCalendar header toolbar + timegrid. Uses .fc-* class names
            so /assets/css/pages/calendar.css styles the toolbar and grid the same way it
            does for the live FullCalendar instance. The grid body is a custom static
            agenda (staff columns x time rows); drag/drop & resize from calendar.js are
            not wired (see file header).
          */}
          <div id="calendar">
            <div className="fc fc-media-screen fc-direction-ltr fc-theme-standard">
              <div className="fc-header-toolbar fc-toolbar fc-toolbar-ltr">
                <div className="fc-toolbar-chunk">
                  <button type="button" className="fc-dayApptTotal-button fc-button fc-button-primary calendar-day-total-indicator">
                    <span className="calendar-day-total-icon" aria-hidden="true">
                      <i className="bi bi-calendar-check" />
                    </span>
                    <span className="calendar-day-total-number">{totalAppts}</span>
                    <span className="calendar-day-total-label">{totalLabel}</span>
                  </button>
                </div>
                <div className="fc-toolbar-chunk" ref={pickerHostRef} style={{ position: "relative" }}>
                  <div className="fc-button-group">
                    <button type="button" className="fc-prev-button fc-button fc-button-primary" aria-label="prev" onClick={() => (view === "dayGridMonth" ? goMonth(-1) : go(view === "timeGridWeek" ? -7 : -1))}>
                      <span className="fc-icon fc-icon-chevron-left" />
                    </button>
                    <button type="button" className="fc-next-button fc-button fc-button-primary" aria-label="next" onClick={() => (view === "dayGridMonth" ? goMonth(1) : go(view === "timeGridWeek" ? 7 : 1))}>
                      <span className="fc-icon fc-icon-chevron-right" />
                    </button>
                  </div>
                  <h2 className="fc-toolbar-title">
                    {view === "timeGridWeek" ? weekRangeTitle(date) : view === "dayGridMonth" ? monthViewTitle(date) : longTitle(date)}
                    {/* Day-view note marker ON the toolbar title (legacy places the
                        paperclip+count there in staffTimeGridDay, calendar.js 759-858);
                        click opens the notes modal filtered on the focused day. */}
                    {view === "staffTimeGridDay" && (countByDate[date] ?? 0) > 0 ? (
                      <button
                        type="button"
                        className="calendar-note-marker-wrap"
                        onClick={() => openNotesModalForDate(date)}
                        title={`${countByDate[date]} note — apri il giorno selezionato`}
                        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", marginLeft: 6 }}
                      >
                        <span className="calendar-note-marker" aria-label={`${countByDate[date]} note`}>
                          <i className="bi bi-stickies" aria-hidden="true" />
                          <span>{countByDate[date]}</span>
                        </span>
                      </button>
                    ) : null}
                  </h2>
                  <button type="button" className="fc-today-button fc-button fc-button-primary" onClick={() => setDate(isoLocal(new Date()))}>
                    Oggi
                  </button>
                  {/* "Data" → toggles the mini date-picker popover. The button carries the
                      legacy calendar-jump-date-btn class + the calendar icon set by
                      enhanceCalendarToolbar (the visible "Data" text is replaced by a
                      visually-hidden label, like the live FullCalendar toolbar). When open
                      it gets fc-button-active, like openCalendarDatePicker. */}
                  <button
                    type="button"
                    className={`fc-jumpDate-button fc-button fc-button-primary calendar-jump-date-btn${pickerOpen ? " fc-button-active" : ""}`}
                    title={pickerToolbarLabel}
                    aria-label={pickerToolbarLabel}
                    aria-haspopup="dialog"
                    aria-expanded={pickerOpen}
                    onClick={togglePicker}
                  >
                    <i className="bi bi-calendar3" aria-hidden="true" />
                    <span className="visually-hidden">{pickerToolbarLabel}</span>
                  </button>

                  {/* === Mini date-picker popover (port of calendar-mini-picker). Rendered
                      as a controlled JSX child of the toolbar chunk so the page CSS
                      (.calendar-shell .calendar-mini-picker*) styles it identically; the
                      grid content + footer depend on the picker mode (= current view). === */}
                  {pickerOpen ? (
                    <div
                      id="calendarDatePickerPopover"
                      className={`calendar-mini-picker is-open is-mode-${pickerMode}`}
                      role="dialog"
                      aria-modal="false"
                      aria-label={pickerToolbarLabel}
                    >
                      <div className="calendar-mini-picker__header">
                        <button
                          type="button"
                          className="calendar-mini-picker__nav-btn"
                          aria-label={pickerNavPrev}
                          onClick={() => stepPicker(-1)}
                        >
                          <i className="bi bi-chevron-left" />
                        </button>
                        <div className="calendar-mini-picker__current-label" aria-live="polite">
                          {pickerHeaderLabel}
                        </div>
                        <button
                          type="button"
                          className="calendar-mini-picker__nav-btn"
                          aria-label={pickerNavNext}
                          onClick={() => stepPicker(1)}
                        >
                          <i className="bi bi-chevron-right" />
                        </button>
                      </div>

                      {/* Weekday header row — shown only in Day mode (like weekdays.hidden). */}
                      {pickerMode === "day" ? (
                        <div className="calendar-mini-picker__weekdays" aria-hidden="true">
                          {IT_SHORT_WEEKDAYS_MON.map((wd, i) => (
                            <span key={i}>{wd}</span>
                          ))}
                        </div>
                      ) : null}

                      <div className={`calendar-mini-picker__grid calendar-mini-picker__grid--${pickerMode}`} role="grid">
                        {pickerMode === "day"
                          ? pickerDayGridDates(pickerCursor).map((iso) => {
                              const cur = new Date(`${iso}T12:00:00`);
                              const outside = cur.getMonth() !== monthOf(pickerCursor);
                              const isToday = iso === isoLocal(new Date());
                              const isSelected = iso === date;
                              return (
                                <button
                                  key={iso}
                                  type="button"
                                  role="gridcell"
                                  aria-label={pickerLongDate(iso)}
                                  aria-current={isSelected ? "date" : undefined}
                                  className={`calendar-mini-picker__day${outside ? " is-outside" : ""}${
                                    isToday ? " is-today" : ""
                                  }${isSelected ? " is-selected" : ""}`}
                                  onClick={() => pickerSelect(iso)}
                                >
                                  {cur.getDate()}
                                </button>
                              );
                            })
                          : pickerMode === "week"
                            ? pickerWeekStarts(pickerCursor).map((ws) => {
                                const we = addDays(ws, 6);
                                const todayIso = isoLocal(new Date());
                                const isToday = todayIso >= ws && todayIso <= we;
                                const isSelected = date >= ws && date <= we;
                                return (
                                  <button
                                    key={ws}
                                    type="button"
                                    role="gridcell"
                                    aria-label={`Settimana ${pickerWeekLong(ws)}`}
                                    aria-current={isSelected ? "true" : undefined}
                                    className={`calendar-mini-picker__week${isToday ? " is-today" : ""}${
                                      isSelected ? " is-selected" : ""
                                    }`}
                                    onClick={() => pickerSelect(ws)}
                                  >
                                    <span className="calendar-mini-picker__item-main">{pickerWeekMain(ws)}</span>
                                    <span className="calendar-mini-picker__item-sub">{pickerWeekSub(ws)}</span>
                                  </button>
                                );
                              })
                            : Array.from({ length: 12 }, (_, m) => {
                                const year = new Date(`${pickerCursor}T12:00:00`).getFullYear();
                                const firstIso = `${year}-${pad(m + 1)}-01`;
                                const now = new Date();
                                const isToday = now.getFullYear() === year && now.getMonth() === m;
                                const sel = new Date(`${date}T12:00:00`);
                                const isSelected = sel.getFullYear() === year && sel.getMonth() === m;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    role="gridcell"
                                    aria-label={`${IT_MONTHS[m] ?? ""} ${year}`}
                                    aria-current={isSelected ? "true" : undefined}
                                    className={`calendar-mini-picker__month${isToday ? " is-today" : ""}${
                                      isSelected ? " is-selected" : ""
                                    }`}
                                    onClick={() => pickerSelect(firstIso)}
                                  >
                                    {IT_SHORT_MONTHS[m]}
                                  </button>
                                );
                              })}
                      </div>

                      <div className="calendar-mini-picker__footer">
                        <div className="calendar-mini-picker__selected">{pickerSelectedLabel}</div>
                        <button type="button" className="calendar-mini-picker__today-btn" onClick={pickerGoToday}>
                          {pickerTodayLabel}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* HH:MM dell'ora sotto il cursore, INLINE nel chunk centrale della
                      toolbar (port di ensureCalendarHoverTimeDisplay: con il centerChunk
                      presente il legacy usa la variante --inline, non la flottante). */}
                  <div
                    className={`calendar-hover-time-display calendar-hover-time-display--inline${hover ? " is-visible" : ""}`}
                    aria-hidden="true"
                  >
                    {hover ? hover.label : ""}
                  </div>
                </div>
                <div className="fc-toolbar-chunk">
                  <div className="fc-button-group">
                    {viewBtn("staffTimeGridDay", "Giorno")}
                    {viewBtn("timeGridWeek", "Settimana")}
                    {viewBtn("dayGridMonth", "Mese")}
                  </div>
                  {/* Ordina: only in the Day view with more than one staff column,
                      faithful to toggleStaffOrderButton. Opens #staffOrderModal. */}
                  <button
                    type="button"
                    className="fc-orderStaffCols-button fc-button fc-button-primary"
                    onClick={openStaffOrderModal}
                    style={{ display: view === "staffTimeGridDay" && staffCols.length > 1 ? "" : "none" }}
                  >
                    Ordina
                  </button>
                </div>
              </div>

              <div
                className="fc-view-harness"
                ref={harnessRef}
                // Day/Week: fixed viewport-derived height (legacy cal.setOption('height', …));
                // the grid scrolls INSIDE the .fc-scroller below. Fallback to the full
                // content height only before the first client-side measure.
                style={{
                  height:
                    view === "dayGridMonth"
                      ? "auto"
                      : agendaViewportHeight || (view === "timeGridWeek" ? weekGridHeight : gridHeight) + 44,
                }}
              >
                {/* Loading/error overlay card over the agenda (port of the legacy
                    #calendarLoadingOverlay injected by calendarEnsureLoadingOverlay):
                    spinner + "Caricamento prenotazioni..." while loading (after the
                    120ms anti-flicker delay); on a failed events fetch it becomes the
                    error card ("Impossibile caricare le prenotazioni") with Riprova.
                    The page CSS (.calendar-loading-*) styles it identically. */}
                {overlayVisible || loadError ? (
                  <div
                    id="calendarLoadingOverlay"
                    className={`calendar-loading-overlay${loadError ? " is-error" : ""}`}
                    role="status"
                    aria-live="polite"
                  >
                    <div className="calendar-loading-panel">
                      <div className="spinner-border text-primary calendar-loading-spinner" aria-hidden="true" />
                      <div className="calendar-loading-copy">
                        <div className="calendar-loading-title">
                          {loadError ? "Impossibile caricare le prenotazioni" : "Caricamento prenotazioni..."}
                        </div>
                        <div className="calendar-loading-text">
                          {loadError || "Aggiornamento del calendario in corso."}
                        </div>
                        {loadError ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-primary calendar-loading-retry"
                            onClick={() => {
                              setLoadError("");
                              loadContext(date, visibleRange);
                            }}
                          >
                            Riprova
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                {/* Inner scroller (the FullCalendar .fc-scroller role): Day/Week scroll
                    the time grid vertically (and horizontally with many staff columns)
                    inside the fixed-height harness; the sticky headers below stay pinned. */}
                <div className="fc-scroller" style={view === "dayGridMonth" ? undefined : { height: "100%", overflow: "auto" }}>
                <div
                  className={
                    view === "dayGridMonth"
                      ? "fc-view fc-daygrid fc-dayGridMonth-view"
                      : view === "timeGridWeek"
                        ? "fc-view fc-timegrid fc-timeGridWeek-view"
                        : // The Day view carries fc-staffTimeGridDay-view so the legacy
                          // store-break-time-staffday / -master (single centered label)
                          // and closed-day master-label rules in app.css apply, like the
                          // real FullCalendar staffTimeGridDay view.
                          "fc-view fc-timegrid fc-staffTimeGridDay-view"
                  }
                >
                  {view === "dayGridMonth" ? (
                    monthView
                  ) : view === "timeGridWeek" ? (
                    weekView
                  ) : (
                    <div className="cal-static-grid" style={{ display: "flex", minHeight: gridHeight }}>
                      {/* Time axis — sticky-left so it stays visible when many staff
                          columns make the scroller scroll horizontally (the FullCalendar
                          pinned-axis behavior); the 44px corner spacer is also sticky-top. */}
                      <div className="cal-static-axis" style={{ flex: "0 0 56px", borderRight: "1px solid var(--calendar-line, #e2e8f0)", position: "sticky", left: 0, zIndex: 9, background: "#fff" }}>
                        <div style={{ height: 44, position: "sticky", top: 0, zIndex: 10, background: "#fff" }} />
                        {/* NOW-INDICATOR axis side: the red arrow (legacy
                            .fc-timegrid-now-indicator-arrow) + the current HH:MM label.
                            Positioned at the now line's Y plus the 44px header offset. */}
                        {dayNowIndicator ? (
                          <>
                            <span
                              className="fc-timegrid-now-indicator-arrow"
                              aria-hidden="true"
                              style={{
                                position: "absolute",
                                right: 0,
                                top: 44 + dayNowIndicator.top,
                                marginTop: -5,
                                width: 0,
                                height: 0,
                                borderTop: "5px solid transparent",
                                borderBottom: "5px solid transparent",
                                borderRight: "6px solid #ef4444",
                                pointerEvents: "none",
                                zIndex: 7,
                              }}
                            />
                            {/* L13: nessuna label HH:MM sull'indicatore ora (solo
                                linea + freccia come il legacy FullCalendar). */}
                          </>
                        ) : null}
                        {rows.map((m) => {
                          const major = isMajorRow(m);
                          return (
                            <div
                              key={m}
                              className={`fc-timegrid-slot-label${major ? "" : " fc-timegrid-slot-minor"}`}
                              style={{
                                height: ROW_HEIGHT,
                                fontSize: 11,
                                color: "#64748b",
                                textAlign: "right",
                                paddingRight: 6,
                                boxSizing: "border-box",
                              }}
                            >
                              {major ? `${pad(Math.floor(m / 60))}:${pad(m % 60)}` : ""}
                            </div>
                          );
                        })}
                      </div>

                      {/* Staff columns. The per-column min-width (--calendar-staff-col-min,
                          FullCalendar's dayMinWidth) makes the columns overflow this wrapper
                          with many operators; the overflow now scrolls in the OUTER
                          .fc-scroller (one scroller for both axes, so the sticky headers +
                          sticky axis keep working), instead of a nested overflowX here. */}
                      <div style={{ display: "flex", flex: "1 1 auto", minWidth: 0, position: "relative" }}>
                        {/* NOW-INDICATOR line (Giorno): a single red line spanning ALL
                            staff columns, faithful to updateStaffNowIndicator. Uses the
                            legacy .fc-timegrid-now-indicator-line class (calendar.css
                            paints it red) + an explicit 2px top border; positioned at the
                            now Y plus the 44px column-header offset. */}
                        {dayNowIndicator ? (
                          <div
                            className="fc-timegrid-now-indicator-line"
                            aria-hidden="true"
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              top: 44 + dayNowIndicator.top,
                              borderTop: "2px solid #ef4444",
                              pointerEvents: "none",
                              zIndex: 6,
                            }}
                          />
                        ) : null}
                        {/* HOVER guide line spanning ALL staff columns (legacy: the
                            line is appended to .fc-timegrid-cols, crossing the grid). */}
                        {renderHoverGuideLine("day-", 44)}
                        {(
                          staffCols.map((s, colIndex) => {
                            const first = (Array.from(s.name.trim())[0] || "O").toUpperCase();
                            const colAppts = apptsForStaff(s);
                            // Conteggio = appuntamenti DISTINTI (non i blocchi/segmenti):
                            // un multi-servizio con 2 segmenti nella stessa colonna conta 1 (M8).
                            const colCount = new Set(colAppts.map((b) => b.id)).size;
                            return (
                              <div
                                key={s.id}
                                className="fc-timegrid-col"
                                // flex-grow to fill the width with one / a few columns, but
                                // never shrink below --calendar-staff-col-min (dayMinWidth):
                                // once the columns overflow the container the wrapper scrolls.
                                style={{ flex: "1 1 0", minWidth: "var(--calendar-staff-col-min, 140px)", borderRight: "1px solid var(--calendar-line, #e2e8f0)", position: "relative" }}
                              >
                                <div
                                  className="fc-col-header-cell"
                                  // sticky: pinned at the top of the .fc-scroller while the
                                  // grid scrolls (the FullCalendar header-section behavior);
                                  // the page CSS provides the opaque background.
                                  style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--calendar-line, #e2e8f0)", position: "sticky", top: 0, zIndex: 8 }}
                                >
                                  <div className="staff-col-head" data-staff-id={s.id}>
                                    {s.photoPath ? (
                                      <span className="staff-col-avatar">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={s.photoPath} alt="" />
                                      </span>
                                    ) : (
                                      <span className="staff-col-avatar staff-col-avatar-fallback" data-staff-id={s.id} style={{ background: staffColorHex(s.id, s.color) }}>
                                        {first}
                                      </span>
                                    )}
                                    <span className="staff-col-copy">
                                      <span className="staff-col-name">{s.name}</span>
                                      <span className="staff-col-count" data-staff-id={s.id}>
                                        {colCount === 1 ? "1 appuntamento" : `${colCount} appuntamenti`}
                                      </span>
                                    </span>
                                  </div>
                                </div>

                                {/* Slot rows (background). Doubles as the staff column's
                                    drop target (MOVE) and quick-book surface (empty-cell
                                    click). The handlers compute the Y offset within this
                                    body, which starts at minMin. */}
                                <div
                                  className="cal-col-body"
                                  // Geometry the root-level hover / drag-select listeners read
                                  // (see the installer effect). data-col scopes the overlay to
                                  // this column; data-winstart/-winend map Y->time; data-staffid
                                  // is the column's operator for a drag-select quick-book.
                                  data-cal-body="1"
                                  data-col={`day-${s.id}`}
                                  data-winstart={minMin}
                                  data-winend={maxMin}
                                  data-staffid={s.id}
                                  style={{ position: "relative", height: gridHeight }}
                                  onDragOver={(e) => {
                                    // Required so the browser fires onDrop on this element.
                                    const drag = dragRef.current;
                                    if (!drag) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    autoScrollOnDragOver(e);
                                    // GHOST snappato: STESSA matematica del drop (timeFromY sul
                                    // top del blocco = cursore - grab offset), validità contro i
                                    // blocchi di QUESTA colonna operatore + bande non-disponibile.
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const startMin = timeToMin(timeFromY(e.clientY - rect.top - drag.grabOffsetPx));
                                    if (startMin === null) return;
                                    const durMin = moveBlockDurationMin(drag.block);
                                    const v = moveGhostStateFor(
                                      startMin,
                                      durMin,
                                      colAppts,
                                      Number(drag.block.id),
                                      maxMin,
                                      staffUnavail.filter((band) => band.staffId === s.id),
                                    );
                                    updateMoveGhost({
                                      col: `day-${s.id}`,
                                      top: (startMin - minMin) * PX_PER_MIN,
                                      height: Math.max(durMin * PX_PER_MIN - 2, 18),
                                      label: `${minToTime(startMin)} - ${minToTime(startMin + durMin)}`,
                                      state: v.state,
                                      note: v.note,
                                    });
                                  }}
                                  onDrop={(e) => {
                                    const drag = dragRef.current;
                                    if (!drag) return;
                                    e.preventDefault();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    // Map the block TOP (cursor - grab offset), not the cursor.
                                    const topPx = e.clientY - rect.top - drag.grabOffsetPx;
                                    moveBlockDay(drag.block, timeFromY(topPx), s.id, s.name);
                                    dragRef.current = null;
                                    clearMoveGhost();
                                  }}
                                  onClick={(e) => {
                                    // Quick-book only on the empty background, never on a block
                                    // (blocks stopPropagation). Ignore right after a drag/resize
                                    // or a committed drag-select range (which already opened it).
                                    if (dragRef.current || resizeRef.current) return;
                                    if (dragSelectJustCommittedRef.current) {
                                      dragSelectJustCommittedRef.current = false;
                                      return;
                                    }
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    // Open the GLOBAL quick-booking drawer in CREATE mode,
                                    // prefilled with this cell's date/time/operator.
                                    openGlobalQuickBook(timeFromY(e.clientY - rect.top), s.id);
                                  }}
                                >
                                  {/* Store-background shading (unavailable / lunch break /
                                      closed) for the focused date, applied to every staff
                                      column like the legacy. Behind the slot lines + blocks
                                      + now-indicator, pointer-events:none so quick-book /
                                      drag / resize still work on top. */}
                                  {renderStoreBands(date, minMin, maxMin, true, colIndex === 0)}
                                  {/* Per-OPERATOR unavailability shading (legacy
                                      include_unavailability: fuori turno + assenze,
                                      clipped to store hours) — the striped grey band
                                      with the "Non disponibile" pill (CSS ::after). */}
                                  {staffUnavail
                                    .filter((band) => band.staffId === s.id)
                                    .map((band, bandIndex) => {
                                      const bandStart = Math.max(band.start, minMin);
                                      const bandEnd = Math.min(band.end, maxMin);
                                      if (bandEnd <= bandStart) return null;
                                      return (
                                        <div
                                          key={`unavail-${s.id}-${bandIndex}`}
                                          className="staff-unavailability"
                                          style={{
                                            position: "absolute",
                                            left: 0,
                                            right: 0,
                                            top: (bandStart - minMin) * PX_PER_MIN,
                                            height: (bandEnd - bandStart) * PX_PER_MIN,
                                            zIndex: 1,
                                            pointerEvents: "none",
                                          }}
                                        />
                                      );
                                    })}
                                  {/* HOVER guide-line / slot-highlight / time label + live
                                      drag-select band overlays (non-interactive). */}
                                  {renderHoverOverlay(`day-${s.id}`, minMin)}
                                  {/* GHOST di spostamento: destinazione snappata + orario + validità. */}
                                  {moveGhost && moveGhost.col === `day-${s.id}` ? renderMoveGhostBand(moveGhost) : null}
                                  {rows.map((m) => {
                                    const major = isMajorRow(m);
                                    return (
                                      <div
                                        key={m}
                                        className={`fc-timegrid-slot${major ? "" : " fc-timegrid-slot-minor"}`}
                                        style={{ height: ROW_HEIGHT, borderTop: `1px solid ${major ? SLOT_LINE_MAJOR : SLOT_LINE_MINOR}`, boxSizing: "border-box" }}
                                      />
                                    );
                                  })}

                                  {/* Appointment blocks positioned by time */}
                                  {colAppts.map((a) => {
                                    const startMin = timeToMin(a.time);
                                    if (startMin === null) return null;
                                    const top = (startMin - minMin) * PX_PER_MIN;
                                    // Height from the REAL end (a.endTime) — or the live resize
                                    // preview while this block is being resized — falling back to
                                    // DEFAULT_DURATION_MIN when no end is known. Clamped to >0.
                                    const previewEnd = resizePreview?.id === a.id ? resizePreview.endTime : null;
                                    const endMinVal = timeToMin(previewEnd ?? a.endTime ?? "");
                                    const durationMin = endMinVal !== null && endMinVal > startMin ? endMinVal - startMin : DEFAULT_DURATION_MIN;
                                    const height = Math.max(durationMin * PX_PER_MIN - 2, 18);
                                    const st = statusKeyFromLabel(a.statusCode ?? a.status);
                                    // Tema soft per STATO (port di applyCalendarSoftAppointmentStyle):
                                    // sfondo/bordo/testo pastello + barra accento via CSS var.
                                    const theme = statusThemeOf(a.statusCode ?? a.status);
                                    // editable legacy: drag/resize SOLO manage && pending/scheduled.
                                    const canDragBlock = canManage && (st.key === "pending" || st.key === "scheduled");
                                    // MS group meta + adaptive density (legacy
                                    // applyCalendarAppointmentDensity: tiny <28px, compact 28-54px).
                                    const msCount = msCountOf(a);
                                    const msAccent = msCount > 1 ? msAccentByAppt[a.id] : "";
                                    const density = height < 28 ? " appt-event-tiny" : height < 54 ? " appt-event-compact" : "";
                                    return (
                                      <a
                                        key={`${a.id}-${a.time}`}
                                        href={href(`appointments&action=view&id=${a.id}`)}
                                        // EDIT in the GLOBAL drawer: a plain click (not a drag)
                                        // routes to the drawer's document-level [data-qb-edit]
                                        // listener via the hidden edit anchor (openGlobalEdit).
                                        // The block itself does NOT carry data-qb-edit so its own
                                        // click can stopPropagation (to suppress the column
                                        // quick-book) without losing the edit-open path.
                                        className={`fc-event fc-timegrid-event appt-soft-event appt-soft-${theme.key}${density}${msAccent ? " ms-has-accent" : ""}${msAccent && msHoverGroup === a.id ? " ms-active" : ""}`}
                                        data-ms-group={msAccent ? a.id : undefined}
                                        onMouseEnter={msAccent ? () => setMsHoverGroup(a.id) : undefined}
                                        onMouseLeave={msAccent ? () => setMsHoverGroup(0) : undefined}
                                        title={`${a.time} ${a.client} • ${serviceTitleOf(a)}`}
                                        draggable={canDragBlock}
                                        // Keep a press on the block from starting a column
                                        // drag-select; the HTML5 move-drag (onDragStart) and the
                                        // hover-suppress-on-block are unaffected.
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onDragStart={(e) => {
                                          // Record the grabbed BLOCK (whole appt or segment) + the
                                          // pointer offset, so the drop maps the block start and
                                          // can post the segment delta payload.
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          dragRef.current = { id: a.id, grabOffsetPx: e.clientY - rect.top, block: a };
                                          e.dataTransfer.effectAllowed = "move";
                                          // Some browsers require data to start a drag.
                                          try { e.dataTransfer.setData("text/plain", String(a.id)); } catch { /* ignore */ }
                                          // Ghost: snapshot nativa soppressa + originale attenuato.
                                          applyGhostDragImage(e);
                                          setDraggingApptId(Number(a.id));
                                        }}
                                        onDragEnd={() => {
                                          // Clear shortly after so the synthetic click that follows
                                          // a drag does not trigger quick-book / edit on the column.
                                          setTimeout(() => { dragRef.current = null; }, 0);
                                          clearMoveGhost();
                                        }}
                                        onClick={(e) => {
                                          // Always suppress navigation to the legacy view URL +
                                          // keep the click off the column's quick-book.
                                          e.preventDefault();
                                          e.stopPropagation();
                                          // A drag/resize just ended -> do nothing (no edit open).
                                          if (dragRef.current || resizeRef.current) return;
                                          // Plain click -> open the GLOBAL drawer in EDIT mode.
                                          openGlobalEdit(a.id);
                                        }}
                                        style={{
                                          position: "absolute",
                                          top,
                                          height,
                                          left: 2,
                                          right: 2,
                                          overflow: "hidden",
                                          borderRadius: 6,
                                          padding: "3px 6px",
                                          fontSize: 12,
                                          textDecoration: "none",
                                          boxSizing: "border-box",
                                          // Above the store-background bands (z 0, and the
                                          // -master break band at z 2) so blocks stay
                                          // visible/clickable over the shading.
                                          zIndex: 3,
                                          ...softEventStyle(theme),
                                          ...(msAccent ? ({ "--ms-accent": msAccent } as React.CSSProperties) : null),
                                          // In trascinamento: tutti i blocchi del booking attenuati.
                                          ...(draggingApptId === Number(a.id) ? { opacity: 0.35 } : {}),
                                        }}
                                      >
                                        {/* Card rows, faithful to the legacy eventContent (calendar.js
                                            4367-4374) + eventDidMount prepends (dot -> badge -> MS ->
                                            client name, 4408-4531): row 1 = time range + duration,
                                            row 2 = dot + status badge + [MS] + client, then one
                                            "• service" row each. The operator row is NOT shown here:
                                            the Day view already has per-operator columns. */}
                                        <div className="fc-event-main">
                                          <div className="appt-event">
                                            <div className="appt-time">{apptTimeLine(a.time, previewEnd ?? a.endTime)}</div>
                                            <div className="fc-event-title appt-client" style={{ lineHeight: 1.15 }}>
                                              <span className="appt-staff-dot" title="Operatore" style={{ background: staffColorHex(s.id, s.color) }} />
                                              <span className={`appt-status-badge status-${st.key}`} title={`Stato: ${st.label}`}>
                                                {st.label}
                                              </span>
                                              {msAccent ? (
                                                <span className="ms-badge" title={`Prenotazione multi-servizio (${msCount})`}>
                                                  <span className="ms-dot" />
                                                  <span className="ms-label">MS</span>
                                                </span>
                                              ) : null}
                                              <span className="appt-client-name">{a.client}</span>
                                            </div>
                                            {serviceNamesOf(a).map((name, i) => (
                                              <div key={i} className="text-truncate appt-service">
                                                {`• ${name}`}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                        {/* RESIZE handle (bottom edge): drag to change the end
                                            time (a custom duration). NOT rendered on segment
                                            blocks (legacy durationEditable:false on per-segment
                                            events) né sui blocchi non-editable (annullati/
                                            eseguiti). Not draggable itself; it uses mousedown so
                                            the block's HTML5 drag doesn't fire, and stops the
                                            click so neither edit nor quick-book triggers. */}
                                        {a.segmentId || !canDragBlock ? null : (
                                          <span
                                            className="cal-resize-handle"
                                            role="presentation"
                                            onMouseDown={(e) => beginResize(e, a)}
                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                            onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                            style={{
                                              position: "absolute",
                                              left: 0,
                                              right: 0,
                                              bottom: 0,
                                              height: 8,
                                              cursor: "ns-resize",
                                            }}
                                          />
                                        )}
                                      </a>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal appuntamento (editor rapido) — static markup; controller not wired. */}
      <div className="modal fade" id="apptModal" tabIndex={-1}>
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Appuntamento</div>
                <h5 className="modal-title fw-bold m-0" id="modalTitle">
                  Nuovo appuntamento
                </h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" />
            </div>
            <div className="modal-body">
              <div id="modalAlert" />
              <form id="apptForm">
                <input type="hidden" name="id" id="appt_id" />
                <div className="row g-3">
                  <div className="col-md-6">
                    <div className="d-flex justify-content-between align-items-center">
                      <label className="form-label mb-0">Cliente</label>
                      <div className="d-flex gap-3 small">
                        <a
                          href="#"
                          id="linkNewClient"
                          className="text-decoration-none"
                          onClick={(e) => {
                            e.preventDefault();
                            // Legacy intent: switch to "new client" — select the inline
                            // new-client option and reveal #newClientBox for free-text entry.
                            const sel = document.getElementById("client_id") as HTMLSelectElement | null;
                            if (sel) sel.value = "__new__";
                            const box = document.getElementById("newClientBox") as HTMLElement | null;
                            if (box) box.hidden = false;
                            const nameInput = document.querySelector<HTMLInputElement>('#newClientBox input[name="new_full_name"]');
                            nameInput?.focus();
                          }}
                        >
                          <i className="bi bi-plus-lg" /> Nuovo
                        </a>
                        <a
                          href="#"
                          id="linkFindClient"
                          className="text-decoration-none"
                          onClick={(e) => {
                            e.preventDefault();
                            // Legacy intent: switch back to "existing client" — hide the
                            // new-client box and focus the existing client search field.
                            const box = document.getElementById("newClientBox") as HTMLElement | null;
                            if (box) box.hidden = true;
                            const sel = document.getElementById("client_id") as HTMLSelectElement | null;
                            if (sel) {
                              if (sel.value === "__new__") sel.value = "";
                              sel.focus();
                            }
                          }}
                        >
                          <i className="bi bi-search" /> Trova
                        </a>
                      </div>
                    </div>
                    <select className="form-select" name="client_id" id="client_id" required defaultValue="">
                      <option value="">Seleziona…</option>
                      <option value="__new__">+ Nuovo cliente…</option>
                    </select>
                    <div className="form-text">Seleziona un cliente o creane uno nuovo.</div>
                  </div>

                  <div className="col-md-6" id="newClientBox" hidden>
                    <label className="form-label">Nuovo cliente</label>
                    <div className="row g-2">
                      <div className="col-12">
                        <input className="form-control" name="new_full_name" placeholder="Nome e cognome" />
                      </div>
                      <div className="col-md-6">
                        <input className="form-control" name="new_phone" placeholder="Telefono" />
                      </div>
                      <div className="col-md-6">
                        <input className="form-control" name="new_email" placeholder="Email" />
                      </div>
                    </div>
                  </div>

                  <div className="col-md-4">
                    <label className="form-label">Servizio</label>
                    <select className="form-select" name="service_id" id="service_id" defaultValue="">
                      <option value="">(nessuno)</option>
                      {services.map((s) => (
                        <option
                          key={s.id}
                          value={String(s.id)}
                          data-location-ids={(s.locationIds ?? []).join(",")}
                        >
                          {s.name}
                          {s.duration ? ` • ${s.duration}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-md-4">
                    <label className="form-label">Operatore</label>
                    <select className="form-select" name="staff_id" id="staff_id" defaultValue="">
                      <option value="">(non assegnato)</option>
                      {staff.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <input type="hidden" name="location_id" id="location_id" value="" />

                  <div className="col-md-6">
                    <label className="form-label">Inizio</label>
                    <input className="form-control" type="datetime-local" name="starts_at" id="starts_at" required />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Fine</label>
                    <input className="form-control" type="datetime-local" name="ends_at" id="ends_at" required />
                  </div>

                  <div className="col-md-4">
                    <label className="form-label">Stato</label>
                    <select className="form-select" name="status" id="status" defaultValue="pending">
                      <option value="pending">In attesa</option>
                      <option value="scheduled">Prenotato</option>
                      <option value="done">Eseguito</option>
                      <option value="canceled">Annullato</option>
                      <option value="no_show">No show</option>
                    </select>
                  </div>

                  <div className="col-md-8">
                    <label className="form-label">Note</label>
                    <input className="form-control" name="notes" id="notes" placeholder="(opzionale)" />
                  </div>
                </div>
              </form>
            </div>
            <div className="modal-footer d-flex justify-content-between">
              <button type="button" className="btn btn-outline-danger btn-pill" id="btnDelete" hidden>
                <i className="bi bi-trash me-1" />
                Elimina
              </button>
              <div className="d-flex gap-2">
                <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                  Chiudi
                </button>
                <button type="button" className="btn btn-primary btn-pill" id="btnSave">
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Trova cliente */}
      <div className="modal fade" id="clientFindModal" tabIndex={-1}>
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Cliente</div>
                <h5 className="modal-title fw-bold m-0">Trova</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" />
            </div>
            <div className="modal-body">
              <div className="input-group mb-3">
                <span className="input-group-text">
                  <i className="bi bi-search" />
                </span>
                <input type="text" className="form-control" id="clientFindQuery" placeholder="Inizia a digitare per cercare..." />
                <button className="btn btn-outline-secondary" type="button" id="clientFindClear">
                  Annulla
                </button>
              </div>
              <div id="clientFindHint" className="text-muted small mb-2">
                Cerca per nome, cognome, email o telefono.
              </div>
              <div className="list-group" id="clientFindResults" />
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Ordina colonne operatori (vista Giorno) */}
      <div className="modal fade" id="staffOrderModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Calendario</div>
                <h5 className="modal-title fw-bold m-0">Ordina colonne operatori</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" />
            </div>
            <div className="modal-body">
              <div className="text-muted small mb-3">
                La <strong>prima colonna</strong> è sempre la tua. Puoi ordinare le colonne degli altri operatori (trascina oppure usa
                le frecce).
              </div>
              <div
                id="staffOrderPinnedInfo"
                className="alert alert-light border d-flex align-items-center gap-2 py-2 px-3"
                hidden={!(pinnedStaff && pinnedStaff.name.trim())}
              >
                <i className="bi bi-person-circle" />
                <div className="small">
                  La tua colonna: <strong id="staffOrderPinnedName">{pinnedStaff?.name ?? ""}</strong>
                </div>
              </div>
              <div className="list-group" id="staffOrderList">
                {staffOrderRows.map((s, index) => {
                  const name = s.name.trim();
                  if (!s.id || !name) return null;
                  return (
                    <div
                      key={s.id}
                      className="list-group-item d-flex align-items-center gap-2 staff-order-item"
                      data-sid={s.id}
                      draggable
                      onDragStart={(e) => {
                        staffOrderDragIndexRef.current = index;
                        e.currentTarget.classList.add("dragging");
                        try {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", String(s.id));
                        } catch {
                          /* ignore */
                        }
                      }}
                      onDragEnd={(e) => {
                        e.currentTarget.classList.remove("dragging");
                        staffOrderDragIndexRef.current = null;
                      }}
                      onDragOver={(e) => {
                        if (staffOrderDragIndexRef.current === null) return;
                        e.preventDefault();
                        try {
                          e.dataTransfer.dropEffect = "move";
                        } catch {
                          /* ignore */
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        dropStaffOrderRow(index);
                      }}
                    >
                      <span className="text-muted" style={{ cursor: "grab" }}>
                        <i className="bi bi-grip-vertical" />
                      </span>
                      <span className="op-color-dot" style={{ background: s.color }} title="Operatore" />
                      <div className="flex-grow-1">{name}</div>
                      <div className="btn-group btn-group-sm">
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          title="Sposta su"
                          disabled={index === 0}
                          onClick={() => moveStaffOrderRow(index, -1)}
                        >
                          <i className="bi bi-chevron-up" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          title="Sposta giù"
                          disabled={index === staffOrderRows.length - 1}
                          onClick={() => moveStaffOrderRow(index, 1)}
                        >
                          <i className="bi bi-chevron-down" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div id="staffOrderEmpty" className="text-muted small mt-2" hidden={staffOrderRows.length > 0}>
                Nessun altro operatore da ordinare.
              </div>
              <div id="staffOrderErr" className="text-danger small mt-2" hidden={!staffOrderError}>
                {staffOrderError}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button
                type="button"
                className="btn btn-primary"
                id="staffOrderSave"
                disabled={staffOrderSaving || staffOrderRows.length === 0}
                onClick={saveStaffOrder}
              >
                <i className="bi bi-check2-circle me-1" />
                {staffOrderSaving ? "Salvataggio…" : "Salva"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Note calendario */}
      <div className="modal fade" id="calendarNotesModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Calendario</div>
                <h5 className="modal-title fw-bold m-0">Note</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" />
            </div>
            <div className="modal-body">
              <div className="row g-4">
                <div className="col-lg-5">
                  <div id="calendarNotesAlert">
                    {notesAlert ? (
                      <div className={`alert alert-${notesAlert.kind} py-2 px-3 mb-3`} role="alert">
                        {notesAlert.text}
                      </div>
                    ) : null}
                  </div>
                  <form id="calendarNotesForm" className="vstack gap-3">
                    <input type="hidden" id="calendar_note_id" name="id" defaultValue="" />
                    <div>
                      <label className="form-label">Giorno</label>
                      <input type="date" className="form-control" id="calendar_note_date" name="note_date" required defaultValue={date} />
                    </div>
                    <div>
                      <label className="form-label">Titolo</label>
                      <input type="text" className="form-control" id="calendar_note_title" name="title" maxLength={190} placeholder="Titolo opzionale" />
                    </div>
                    <div>
                      <label className="form-label">Nota</label>
                      <textarea className="form-control" id="calendar_note_text" name="note_text" rows={8} placeholder="Scrivi qui la nota del giorno" required />
                    </div>
                    <div className="small text-muted">
                      Puoi inserire piu note nello stesso giorno e scegliere qualsiasi data. A destra vedi le note del periodo visibile
                      oppure, dalla vista settimana, solo quelle del giorno selezionato.
                    </div>
                  </form>
                </div>
                <div className="col-lg-7">
                  <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
                    <div>
                      <div className="small-muted" id="calendarNotesRangeCaption">
                        {notesFilterDate ? "Giorno selezionato" : "Periodo visibile"}
                      </div>
                      <div className="fw-semibold" id="calendarNotesRangeLabel">
                        {/* L24: "Giorno selezionato" -> il giorno; "Periodo visibile"
                            -> l'etichetta del periodo della vista (giorno/settimana/mese). */}
                        {notesFilterDate
                          ? longTitle(notesFilterDate)
                          : view === "timeGridWeek"
                            ? weekRangeTitle(date)
                            : view === "dayGridMonth"
                              ? monthViewTitle(date)
                              : longTitle(date)}
                      </div>
                      <div className="small text-muted" id="calendarNotesRangeHint">
                        {notesFilterDate
                          ? displayNotes.length === 1
                            ? "1 nota del giorno selezionato"
                            : `${displayNotes.length} note del giorno selezionato`
                          : notesCount === 1
                            ? "1 nota nel periodo visibile"
                            : `${notesCount} note nel periodo visibile`}
                      </div>
                    </div>
                    {/* Scrittura note: solo con appointments.manage (legacy
                        api_calendar_notes.php:19). Utente sola-lettura -> nascoste. */}
                    {canManage ? (
                      <button type="button" className="btn btn-sm btn-outline-secondary" id="calendarNotesNewBtn">
                        <i className="bi bi-plus-circle me-1" />
                        Nuova
                      </button>
                    ) : null}
                  </div>
                  <div id="calendarNotesList" className="calendar-notes-list">
                    {displayNotes.length === 0 ? (
                      <div className="calendar-note-empty">
                        <div className="fw-semibold mb-1">
                          {notesFilterDate ? "Nessuna nota per il giorno selezionato" : "Nessuna nota nel periodo visibile"}
                        </div>
                        {/* Variante sola-lettura del legacy (calendar.php 627). */}
                        <div className="small">{canManage ? "Crea una nota dal modulo a sinistra." : "Le note sono disponibili in sola lettura."}</div>
                      </div>
                    ) : (
                      groupNotesByDate(displayNotes).map((group) => (
                        <div className="calendar-note-day-group" data-note-group-date={group.date} key={group.date}>
                          <div className="calendar-note-day-head">
                            <div className="fw-semibold">{longTitle(group.date)}</div>
                            <span className="badge text-bg-light">{group.items.length}</span>
                          </div>
                          {group.items.map((n) => (
                            <button type="button" className="calendar-note-card" key={n.id} data-note-id={n.id}>
                              <div className="calendar-note-card-title">{n.title || "Nota senza titolo"}</div>
                              <div className="calendar-note-card-text" style={{ whiteSpace: "pre-wrap" }}>{n.noteText}</div>
                              <div className="calendar-note-card-meta">
                                {[n.updatedAtLabel, n.updatedByName].filter(Boolean).join(" - ")}
                              </div>
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer flex-wrap gap-2 justify-content-start">
              <div className="d-flex flex-wrap gap-2">
                <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                  Chiudi
                </button>
                {canManage ? (
                  <button type="submit" form="calendarNotesForm" className="btn btn-primary" id="calendarNotesSaveBtn">
                    <i className="bi bi-check2-circle me-1" />
                    Salva nota
                  </button>
                ) : null}
              </div>
              {canManage ? (
                <button type="button" className="btn btn-outline-danger d-none ms-auto" id="calendarNoteDeleteBtn">
                  <i className="bi bi-trash me-1" />
                  Elimina
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
