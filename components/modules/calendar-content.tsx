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
  room?: string;
  price?: string;
  status: string;
  // Real php status code (pending|scheduled|done|canceled|no_show); the list API's
  // `status` is the collapsed 3-state UI label, so prefer statusCode for the pill.
  statusCode?: string;
  // Per-operator segments (only when the appointment spans >1 operator): the Day
  // view renders one block per segment in the matching staff column (legacy
  // per-segment events), so the second operator's column shows their busy window.
  segments?: { serviceId: number; serviceName: string; staffId: number; staffName: string; time: string; endTime: string }[];
};

type CalendarView = "staffTimeGridDay" | "timeGridWeek" | "dayGridMonth";

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

const IT_WEEKDAYS = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];
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

// Week range header label (port of itWeekRangeLongLabel): "30 - 6 luglio 2026"
// when same month, "30 giugno - 6 luglio 2026" across months, with the year(s).
function weekRangeTitle(iso: string): string {
  const dates = weekDates(iso);
  const a = new Date(`${dates[0]}T12:00:00`);
  const b = new Date(`${dates[6]}T12:00:00`);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const sameYear = a.getFullYear() === b.getFullYear();
  const ma = IT_MONTHS[a.getMonth()] ?? "";
  const mb = IT_MONTHS[b.getMonth()] ?? "";
  if (sameMonth) return capFirst(`${a.getDate()} - ${b.getDate()} ${mb} ${b.getFullYear()}`);
  if (sameYear) return capFirst(`${a.getDate()} ${ma} - ${b.getDate()} ${mb} ${b.getFullYear()}`);
  return capFirst(`${a.getDate()} ${ma} ${a.getFullYear()} - ${b.getDate()} ${mb} ${b.getFullYear()}`);
}

// Month header label (port of itLongMonthYear), capitalized: "Giugno 2026".
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
  const [loading, setLoading] = useState(true);

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

  // Drag-move state. dragRef holds the in-flight payload (the dragged appointment id
  // and the grab offset within the block); a non-null moveError surfaces a revert.
  const dragRef = useRef<CalendarDrag | null>(null);
  // In-flight resize (bottom-edge drag). Held in a ref (no re-render per mouse move);
  // a non-null `resizePreview` mirrors the live snapped end so the block stretches.
  const resizeRef = useRef<CalendarResize | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: number; endTime: string } | null>(null);
  const [moveError, setMoveError] = useState("");
  // Surfaced inside #calendarNotesAlert when a note save/delete fails.
  const [notesError, setNotesError] = useState("");

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
      setLoading(true);
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
          setCurrentStaffId(Number(j.currentStaffId ?? 0) || 0);
          setSavedStaffOrder(normalizeStaffOrder(j.staffOrder));
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
          setSavedStaffOrder([]);
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
        .catch(() => setAppointments([]))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    loadContext(date, visibleRange);
  }, [loadContext, date, visibleRange]);

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${`${page}`.replace("&", "?")}`;
  }

  // Open/close window (minutes) for a single day-of-week from business hours
  // (fallback 09:00–19:00 when no rows). Shared by the Day window and the Week
  // window (which unions this across the 7 day-of-weeks shown).
  const windowForDow = useCallback(
    (dow: number): { open: number; close: number } => {
      const todays = businessHours.filter((b) => b.dow === dow && !b.isClosed && b.openTime && b.closeTime);
      let open = 9 * 60;
      let close = 19 * 60;
      if (todays.length) {
        const opens = todays.map((b) => timeToMin(b.openTime) ?? open);
        const closes = todays.map((b) => timeToMin(b.closeTime) ?? close);
        open = Math.min(...opens);
        close = Math.max(...closes);
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
    const filtered = filterStaff ? staff.filter((s) => String(s.id) === filterStaff) : staff;
    return applyStaffDayColumnsOrdering(filtered, currentStaffId, savedStaffOrder);
  }, [staff, filterStaff, currentStaffId, savedStaffOrder]);

  // Shared filter predicate (operator/service/status) WITHOUT any date constraint —
  // applied by Week/Month so the toolbar filters affect those views too.
  const passesFilters = useCallback(
    (a: Appointment): boolean => {
      if (filterStaff) {
        const s = staff.find((st) => String(st.id) === filterStaff);
        if (s && (a.operator || "").trim().toLowerCase() !== s.name.trim().toLowerCase()) return false;
      }
      if (filterStatus) {
        if (statusKeyFromLabel(a.statusCode ?? a.status).key !== filterStatus) return false;
      }
      if (filterService) {
        const svc = services.find((s) => String(s.id) === filterService);
        if (svc && a.service && a.service.trim().toLowerCase() !== svc.name.trim().toLowerCase()) return false;
      }
      return true;
    },
    [filterStaff, filterStatus, filterService, staff, services],
  );

  // Appointments visible for the current real day, after filters (Day view). The
  // operator filter is applied per-column via staffCols in the Day grid, so it is
  // intentionally NOT applied here (keeps the Day total/columns unchanged).
  const visibleAppts = useMemo(() => {
    return appointments.filter((a) => {
      if (a.date && a.date !== date) return false;
      if (filterStatus) {
        const k = statusKeyFromLabel(a.statusCode ?? a.status).key;
        if (k !== filterStatus) return false;
      }
      if (filterService) {
        const svc = services.find((s) => String(s.id) === filterService);
        if (svc && a.service && a.service.trim().toLowerCase() !== svc.name.trim().toLowerCase()) return false;
      }
      return true;
    });
  }, [appointments, date, filterStatus, filterService, services]);

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

  function apptsForStaff(staffName: string): Appointment[] {
    const target = staffName.trim().toLowerCase();
    const out: Appointment[] = [];
    for (const a of visibleAppts) {
      // Multi-operator appointment: one VIRTUAL block per segment in the matching
      // column (legacy per-segment events) — otherwise the second operator's column
      // would look free while they are busy on their own segment. The virtual block
      // keeps the appointment id (click still opens the same edit drawer) but takes
      // the segment's time window, service and operator.
      if (a.segments && a.segments.length > 1) {
        for (const seg of a.segments) {
          if ((seg.staffName || "").trim().toLowerCase() !== target) continue;
          out.push({
            ...a,
            time: seg.time,
            endTime: seg.endTime,
            service: seg.serviceName,
            services: [{ serviceId: seg.serviceId, name: seg.serviceName }],
            operator: seg.staffName,
          });
        }
        continue;
      }
      if ((a.operator || "").trim().toLowerCase() === target) out.push(a);
    }
    return out;
  }

  // Toolbar total reflects the visible range: the focused day (Day) or the whole
  // visible week/month grid (Week/Month).
  const totalAppts = useMemo(() => {
    if (view === "staffTimeGridDay") return visibleAppts.length;
    const dates = view === "timeGridWeek" ? weekDates(date) : monthGridDates(date);
    return dates.reduce((sum, d) => sum + (rangeApptsByDate[d]?.length ?? 0), 0);
  }, [view, visibleAppts, rangeApptsByDate, date]);
  const totalLabel = totalAppts === 1 ? "appuntamento totale" : "appuntamenti totali";
  const notesCount = notes.length;
  // GAP 5: the notes actually shown in the modal — all visible-period notes, or just the
  // single selected day when a marker was clicked.
  const displayNotes = notesFilterDate ? notes.filter((n) => n.noteDate === notesFilterDate) : notes;
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
      const minutes = snappedMinFromY(ev.clientY - rect.top, winStart, winEnd);
      const slotStart = Math.floor(minutes / SLOT_MIN_PER_ROW) * SLOT_MIN_PER_ROW;
      hoverPendingRef.current = {
        col,
        lineTop: (minutes - winStart) * PX_PER_MIN,
        slotTop: (Math.max(slotStart, winStart) - winStart) * PX_PER_MIN,
        label: minToTime(minutes),
      };
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

  // Render the hover indicator + live drag-select band for one column body (`col` is
  // the column key, `winStart` the body's window start min). All three pieces are
  // absolutely-positioned, pointer-events:none overlays so they never block the
  // underlying empty-cell click / drag. Reuses the legacy CSS classes so they are
  // styled identically by app.css / calendar.css:
  //   - .calendar-hover-time-line  (guide line at the snapped time)
  //   - .calendar-hover-slot-highlight (subtle band for the snapped 5-min slot)
  //   - .calendar-hover-time-display.calendar-hover-time-display--floating (HH:MM label)
  // The drag-select band reuses .calendar-hover-slot-highlight too (a stronger,
  // explicitly-styled variant), matching the legacy selection look.
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
            <>
              {/* Subtle highlight band for the snapped 5-min slot. */}
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
              {/* Thin guide line at the snapped (5-min) time. */}
              <div
                className="calendar-hover-time-line is-visible"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: hover.lineTop,
                  zIndex: 5,
                  pointerEvents: "none",
                  borderTop: "1px dashed rgba(59,130,246,.7)",
                }}
              />
              {/* HH:MM label following the pointer's snapped time. */}
              <div
                className="calendar-hover-time-display calendar-hover-time-display--floating is-visible"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 4,
                  top: hover.lineTop,
                  transform: "translateY(-50%)",
                  zIndex: 8,
                  pointerEvents: "none",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#0f172a",
                  background: "rgba(255,255,255,.85)",
                  borderRadius: 4,
                  padding: "0 4px",
                  lineHeight: 1.3,
                }}
              >
                {hover.label}
              </div>
            </>
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

  // POST action=move with optimistic update + reconcile. The list is optimistically
  // patched (new time/operator) so the block jumps immediately; on success the server
  // list replaces local state, on error we revert by reloading the day. Tenant-scoped
  // via the slug query + x-tenant-slug header, like the other calendar fetches.
  const moveAppointment = useCallback(
    async (id: number, newTime: string, newOperator: string) => {
      setMoveError("");
      const prev = appointments;
      const target = prev.find((a) => a.id === id);
      if (!target) return;
      if (target.time === newTime && (target.operator || "").trim().toLowerCase() === newOperator.trim().toLowerCase()) {
        return; // no-op drop on the same slot/column
      }

      // Optimistic patch.
      setAppointments((list) => list.map((a) => (a.id === id ? { ...a, time: newTime, operator: newOperator } : a)));

      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "move",
            id,
            date,
            time: newTime,
            staff_name: newOperator,
          }),
        });
        const json: { ok?: boolean; error?: string; appointments?: Appointment[] } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          setAppointments(prev); // revert
          setMoveError(String(json.error || "Impossibile spostare l'appuntamento."));
          return;
        }
        // Reconcile with the authoritative server list when provided.
        if (Array.isArray(json.appointments)) setAppointments(json.appointments);
        else loadContext(date, visibleRange);
      } catch {
        setAppointments(prev); // revert on network error
        setMoveError("Errore di rete durante lo spostamento.");
      }
    },
    [appointments, date, loadContext, slug, visibleRange],
  );

  // WEEK move (port of the FullCalendar eventDrop in timeGridWeek): dragging a Week
  // block to another position changes the DATE (the target day column) AND the time,
  // keeping the SAME operator (the Week grid isn't per-operator). Unlike the Day move
  // — which keeps the date and changes the operator — this posts a new `date`+`time`
  // with the appointment's current operator unchanged. The existing action=move route
  // already accepts a target `date` (it builds starts_at from date+time and reuses the
  // operator-overlap conflict check via assertAppointmentSlotAvailable), so no route/
  // repo change is needed. Optimistic patch (new date+time) + revert on error, mirroring
  // moveAppointment. The operator is sent as staff_name ONLY when non-empty, so an
  // unassigned appointment keeps its (empty) assignment instead of the route clearing it.
  const moveAppointmentToDate = useCallback(
    async (id: number, newDate: string, newTime: string) => {
      setMoveError("");
      const prev = appointments;
      const target = prev.find((a) => a.id === id);
      if (!target) return;
      if (target.date === newDate && target.time === newTime) {
        return; // no-op drop on the same day/slot
      }
      const operator = (target.operator || "").trim();

      // Optimistic patch: move the block to the new day + time (operator unchanged).
      setAppointments((list) => list.map((a) => (a.id === id ? { ...a, date: newDate, time: newTime } : a)));

      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "move",
            id,
            date: newDate,
            time: newTime,
            // Keep the current operator. Send staff_name only when set; omitting it
            // lets the route preserve the appointment's existing operator (an empty
            // string would otherwise CLEAR the assignment).
            ...(operator ? { staff_name: operator } : {}),
          }),
        });
        const json: { ok?: boolean; error?: string; appointments?: Appointment[] } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          setAppointments(prev); // revert
          setMoveError(String(json.error || "Impossibile spostare l'appuntamento."));
          return;
        }
        // Reconcile with the authoritative server list, else reload the visible range.
        if (Array.isArray(json.appointments)) setAppointments(json.appointments);
        else loadContext(date, visibleRange);
      } catch {
        setAppointments(prev); // revert on network error
        setMoveError("Errore di rete durante lo spostamento.");
      }
    },
    [appointments, date, loadContext, slug, visibleRange],
  );

  // POST action=resize with optimistic update + reconcile. A resize keeps the start
  // fixed and only changes the END time (a custom duration), so the block stretches in
  // place. The list is optimistically patched (new endTime) so the height updates
  // immediately; on success the server list replaces local state, on error we revert.
  // Tenant-scoped like the other calendar fetches.
  const resizeAppointment = useCallback(
    async (id: number, newEndTime: string) => {
      setMoveError("");
      const prev = appointments;
      const target = prev.find((a) => a.id === id);
      if (!target) return;
      // No-op when the end did not actually change, or would be at/under the start.
      const startMin = timeToMin(target.time);
      const endMinVal = timeToMin(newEndTime);
      if (startMin === null || endMinVal === null || endMinVal <= startMin) return;
      if ((target.endTime || "") === newEndTime) return;

      // Optimistic patch.
      setAppointments((list) => list.map((a) => (a.id === id ? { ...a, endTime: newEndTime } : a)));

      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "resize",
            id,
            end_time: newEndTime,
          }),
        });
        const json: { ok?: boolean; error?: string; appointments?: Appointment[] } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          setAppointments(prev); // revert
          setMoveError(String(json.error || "Impossibile ridimensionare l'appuntamento."));
          return;
        }
        // Reconcile with the authoritative server list when provided.
        if (Array.isArray(json.appointments)) setAppointments(json.appointments);
        else loadContext(date, visibleRange);
      } catch {
        setAppointments(prev); // revert on network error
        setMoveError("Errore di rete durante il ridimensionamento.");
      }
    },
    [appointments, date, loadContext, slug, visibleRange],
  );

  // RESIZE drag wiring (bottom-edge handle). Mousedown on the handle records the
  // resize payload (in resizeRef) + seeds a render preview; document mousemove tracks
  // the live snapped end (updating both the ref and the preview so the block
  // stretches), mouseup commits via resizeAppointment. The window listeners are
  // attached only while a resize is in flight — the effect keys off whether
  // resizePreview is set, NOT its value, so it doesn't re-bind on every mouse move.
  const beginResize = useCallback(
    (e: ReactMouseEvent, appt: Appointment) => {
      e.preventDefault();
      e.stopPropagation();
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
    [minMin, maxMin],
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
  const onWeekColumnDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
  }, []);
  const onWeekColumnDrop = useCallback(
    (iso: string, e: ReactDragEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Map the block TOP (cursor minus the grab offset), snapped within the week window.
      const topPx = e.clientY - rect.top - drag.grabOffsetPx;
      const minutes = snappedMinFromY(topPx, weekMinMin, weekMaxMin);
      void moveAppointmentToDate(drag.id, iso, minToTime(minutes));
      dragRef.current = null;
    },
    [snappedMinFromY, weekMinMin, weekMaxMin, moveAppointmentToDate],
  );
  // WEEK block drag START / END — extracted callbacks (lint parity with the drop
  // handlers above). onDragStart records the grabbed appointment id + the pointer offset
  // from the block top, so the drop maps the block's start time. onDragEnd clears the ref
  // shortly after so the synthetic click trailing a drag doesn't open edit on the column.
  const onWeekBlockDragStart = useCallback((id: number, e: ReactDragEvent<HTMLElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragRef.current = { id, grabOffsetPx: e.clientY - rect.top };
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(id));
    } catch { /* ignore */ }
  }, []);
  const onWeekBlockDragEnd = useCallback(() => {
    setTimeout(() => { dragRef.current = null; }, 0);
  }, []);

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
    const anchor = document.getElementById("calQbEditAnchor");
    if (!anchor) return;
    anchor.setAttribute("data-qb-edit", String(id));
    anchor.click();
  }, []);

  // Open the GLOBAL quick-booking drawer in CREATE mode, prefilled with the clicked
  // empty cell's date/time/operator. The drawer's [data-qb-new] listener reads the
  // data-qb-date/data-qb-time/data-qb-staff attributes we set on a hidden anchor, then
  // shows the offcanvas. Replaces the legacy #apptModal quick-book entirely.
  const openGlobalQuickBook = useCallback(
    (cellTime: string, staffId: number, endTime?: string, cellDate?: string) => {
      if (typeof document === "undefined") return;
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
    [date],
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
      openGlobalQuickBook(minToTime(rawMin), 0, undefined, iso);
    },
    [snappedMinFromY, weekMinMin, weekMaxMin, openGlobalQuickBook],
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
  const resetNotesForm = useCallback(() => {
    if (typeof document === "undefined") return;
    const root = notesModalRef.current ?? document.getElementById("calendarNotesModal");
    if (!root) return;
    const idEl = root.querySelector<HTMLInputElement>("#calendar_note_id");
    const dateEl = root.querySelector<HTMLInputElement>("#calendar_note_date");
    const titleEl = root.querySelector<HTMLInputElement>("#calendar_note_title");
    const textEl = root.querySelector<HTMLTextAreaElement>("#calendar_note_text");
    const deleteBtn = root.querySelector<HTMLButtonElement>("#calendarNoteDeleteBtn");
    if (idEl) idEl.value = "";
    if (dateEl) dateEl.value = date;
    if (titleEl) titleEl.value = "";
    if (textEl) textEl.value = "";
    deleteBtn?.classList.add("d-none");
  }, [date]);

  const postNote = useCallback(
    async (payload: Record<string, unknown>): Promise<boolean> => {
      try {
        const res = await fetch(`/api/manage/calendar?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ slug, ...payload }),
        });
        const json: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false || json.error) {
          setNotesError(String(json.error || "Operazione non riuscita."));
          return false;
        }
        setNotesError("");
        loadContext(date, visibleRange);
        return true;
      } catch {
        setNotesError("Errore di rete.");
        return false;
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
      if (!noteDate || !noteText) {
        setNotesError("Inserisci giorno e testo della nota.");
        return;
      }
      const ok = await postNote({
        action: "note_save",
        id: Number(idEl?.value ?? 0) || 0,
        note_date: noteDate,
        title: String(titleEl?.value ?? "").trim(),
        note_text: noteText,
      });
      if (ok) resetNotesForm();
    };

    const onDelete = async () => {
      const id = Number(idEl?.value ?? 0) || 0;
      if (id <= 0) return;
      if (!window.confirm("Eliminare questa nota?")) return;
      const ok = await postNote({ action: "note_delete", id });
      if (ok) resetNotesForm();
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
  }, [notes, postNote, resetNotesForm]);

  // Open the notes modal from the header button, starting in "new note" mode.
  const openNotesModal = useCallback(() => {
    setNotesFilterDate(null);
    resetNotesForm();
    setNotesError("");
    showNotesModal();
  }, [resetNotesForm]);

  // GAP 5: open the notes modal filtered to a single day (clicking a day's note marker in
  // the week view), switching the caption to "Giorno selezionato".
  const openNotesModalForDate = useCallback((iso: string) => {
    setNotesFilterDate(iso);
    resetNotesForm();
    setNotesError("");
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
          <div style={{ height: 44 }} />
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
              <span
                className="fc-timegrid-now-indicator-label"
                style={{
                  position: "absolute",
                  right: 8,
                  top: 44 + weekNowIndicator.top,
                  transform: "translateY(-50%)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#ef4444",
                  background: "#fff",
                  padding: "0 2px",
                  pointerEvents: "none",
                  zIndex: 7,
                }}
              >
                {weekNowIndicator.label}
              </span>
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
                  style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--calendar-line, #e2e8f0)" }}
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
                  // installer effect). data-staffid 0 = no operator in Week; data-celldate
                  // is this column's day so the quick-book books that date.
                  data-cal-body="1"
                  data-col={`week-${iso}`}
                  data-winstart={weekMinMin}
                  data-winend={weekMaxMin}
                  data-staffid={0}
                  data-celldate={iso}
                  style={{ position: "relative", height: weekGridHeight }}
                  // Block drag-move DROP target: a Week block dropped here moves to THIS
                  // column's day + the snapped drop time (operator unchanged). onDragOver
                  // must allow the drop for the browser to fire onDrop. Component-scope
                  // handlers (read dragRef outside the nested render helper).
                  onDragOver={onWeekColumnDragOver}
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

                  {dayAppts.map((a) => {
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
                    const op = staff.find((s) => (s.name || "").trim().toLowerCase() === (a.operator || "").trim().toLowerCase());
                    const accent = op?.color || "#2f63d8";
                    return (
                      <a
                        key={a.id}
                        href={href(`appointments&action=view&id=${a.id}`)}
                        className="fc-event fc-timegrid-event appt-soft-event"
                        title={`${a.time} ${a.client} • ${serviceTitleOf(a)}${a.operator ? ` (${a.operator})` : ""}`}
                        // DRAG-MOVE: a Week block is HTML5-draggable to another day column /
                        // time (changes the DATE, operator unchanged). Component-scope drag
                        // handlers keep the dragRef writes out of this render helper.
                        draggable
                        // A press on a block must not start the column drag-select.
                        onMouseDown={(e) => e.stopPropagation()}
                        onDragStart={(e) => onWeekBlockDragStart(a.id, e)}
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
                          borderLeft: `3px solid ${accent}`,
                          background: "#f4f8ff",
                          color: "#14326f",
                          boxSizing: "border-box",
                          // Above the store-background bands (z 0) so blocks stay
                          // visible/clickable over the shading.
                          zIndex: 3,
                        }}
                      >
                        <div className="fc-event-main">
                          <span className={`appt-status-badge status-${st.key}`} title={`Stato: ${st.label}`}>
                            {st.label}
                          </span>
                          <span className="appt-staff-dot" style={{ background: accent }} />
                          <div className="fw-semibold appt-client" style={{ lineHeight: 1.15 }}>
                            {a.time} {a.client}
                          </div>
                          {/* OPERATOR bullet then ALL booked services, one bulleted line
                              each — faithful to the legacy Week block (showStaff=true in
                              timeGridWeek: it shows the operator + each service). */}
                          {a.operator ? (
                            <div className="small text-truncate appt-staff">{`· ${a.operator}`}</div>
                          ) : null}
                          {serviceNamesOf(a).map((name, i) => (
                            <div key={i} className="small text-truncate appt-service">
                              {`· ${name}`}
                            </div>
                          ))}
                        </div>
                        {/* RESIZE handle (bottom edge): drag to change the end time (custom
                            duration), identical to the Day view, positioned in this day
                            column. beginResize reads the body's window from its data-* attrs. */}
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
  // A 6x7 Monday-first grid; each cell shows the date number + that day's
  // appointments as compact chips (client + time + first service, status/operator
  // color), with a "+N altri" overflow link. Day numbers/cells use the FullCalendar
  // .fc-daygrid-* classes so /assets/css/pages/calendar.css applies; days with notes
  // get the has-calendar-notes marker. Clicking a chip opens the GLOBAL edit drawer;
  // clicking an empty day (or the overflow link) switches to that Day view.
  // TODO(month-chip-drag): drag a chip onto another day cell to change the DATE only
  // (the appointment keeps its existing time; reuse moveAppointmentToDate(id, targetIso,
  // a.time)). Deferred: the Month grid is a date-only overview (no time axis to map a
  // drop Y to), and the day cell's onClick already jumps to that Day view for precise
  // re-scheduling, so a chip date-move is lower value than the Day/Week drag. When
  // added: make chips draggable writing dragRef, add onDragOver/onDrop to each
  // .fc-daygrid-day cell (component-scope handlers so the dragRef reads stay out of
  // this render helper), and suppress the cell's jump-to-day onClick after a drop.
  function renderMonthView() {
    const focusMonth = monthOf(date);
    const todayIso = isoLocal(new Date());
    const gridDates = monthGridDates(date);
    const MAX_CHIPS = 4;
    return (
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
            {gridDates.slice(week * 7, week * 7 + 7).map((iso) => {
              const dnum = new Date(`${iso}T12:00:00`).getDate();
              const inMonth = monthOf(iso) === focusMonth;
              const isToday = iso === todayIso;
              const dayAppts = rangeApptsByDate[iso] ?? [];
              const noteCount = countByDate[iso] ?? 0;
              const shown = dayAppts.slice(0, MAX_CHIPS);
              const overflow = dayAppts.length - shown.length;
              return (
                <div
                  key={iso}
                  data-date={iso}
                  className={`fc-daygrid-day${inMonth ? "" : " fc-day-other"}${isToday ? " fc-day-today" : ""}${noteCount > 0 ? " has-calendar-notes" : ""}`}
                  style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    borderRight: "1px solid var(--calendar-line, #e2e8f0)",
                    borderBottom: "1px solid var(--calendar-line, #e2e8f0)",
                    padding: 4,
                    opacity: inMonth ? 1 : 0.45,
                    cursor: "pointer",
                  }}
                  onClick={(e) => {
                    // Empty-day click -> jump to that day's Day view (chips stop propagation).
                    if ((e.target as HTMLElement).closest(".fc-daygrid-event")) return;
                    setDate(iso);
                    setView("staffTimeGridDay");
                  }}
                >
                  <div className="fc-daygrid-day-top" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                    <a className="fc-daygrid-day-number" style={{ textDecoration: "none", color: "inherit", fontSize: 12, fontWeight: 600 }}>
                      {dnum}
                    </a>
                    {noteCount > 0 ? (
                      <span className="calendar-note-marker-wrap">
                        <span className="calendar-note-marker" role="img" aria-label={`${noteCount} note`}>
                          <i className="bi bi-stickies" aria-hidden="true" />
                          <span>{noteCount}</span>
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <div className="fc-daygrid-day-events" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                    {shown.map((a) => {
                      const st = statusKeyFromLabel(a.statusCode ?? a.status);
                      const op = staff.find((s) => (s.name || "").trim().toLowerCase() === (a.operator || "").trim().toLowerCase());
                      const accent = op?.color || "#2f63d8";
                      // Compact multi-service hint (Month is an overview, the chip stays a
                      // single ellipsised line): the FIRST service name plus "+N" when the
                      // appointment has more than one. The native title lists EVERY service
                      // (+ operator). Faithful to the legacy density (one line per chip).
                      const svcNames = serviceNamesOf(a);
                      const svcHint = svcNames.length === 0 ? "" : svcNames.length === 1 ? svcNames[0] : `${svcNames[0]} +${svcNames.length - 1}`;
                      return (
                        <a
                          key={a.id}
                          href={href(`appointments&action=view&id=${a.id}`)}
                          className="fc-event fc-daygrid-event appt-soft-event"
                          title={`${a.time} ${a.client} • ${serviceTitleOf(a)}${a.operator ? ` (${a.operator})` : ""} (${st.label})`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openGlobalEdit(a.id);
                          }}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            borderRadius: 5,
                            padding: "1px 5px",
                            fontSize: 11,
                            textDecoration: "none",
                            borderLeft: `3px solid ${accent}`,
                            background: "#f4f8ff",
                            color: "#14326f",
                          }}
                        >
                          <span className={`appt-status-badge status-${st.key}`} style={{ marginRight: 4 }} title={`Stato: ${st.label}`} />
                          <span style={{ fontWeight: 600 }}>{a.time}</span> {a.client}
                          {svcHint ? <span className="appt-service" style={{ marginLeft: 4 }}>{`· ${svcHint}`}</span> : null}
                        </a>
                      );
                    })}
                    {overflow > 0 ? (
                      <a
                        className="fc-daygrid-more-link"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDate(iso);
                          setView("staffTimeGridDay");
                        }}
                        style={{ fontSize: 11, color: "#2f63d8", cursor: "pointer", fontWeight: 600 }}
                      >
                        +{overflow} altri
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

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
          <a className="btn btn-outline-secondary btn-sm" href={href("appointments")}>
            <i className="bi bi-list-task me-1" />
            Lista
          </a>
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

        {/* Move/quick-book error surface — only rendered on failure (additive; the
            static layout is unchanged when there is no error). */}
        {moveError ? (
          <div className="alert alert-danger alert-dismissible d-flex align-items-center gap-2 py-2 px-3" role="alert">
            <i className="bi bi-exclamation-triangle" />
            <span className="small">{moveError}</span>
            <button type="button" className="btn-close ms-auto" aria-label="Chiudi" onClick={() => setMoveError("")} />
          </div>
        ) : null}

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
                    <button type="button" className="fc-prev-button fc-button fc-button-primary" aria-label="prev" onClick={() => go(view === "timeGridWeek" ? -7 : view === "dayGridMonth" ? -30 : -1)}>
                      <span className="fc-icon fc-icon-chevron-left" />
                    </button>
                    <button type="button" className="fc-next-button fc-button fc-button-primary" aria-label="next" onClick={() => go(view === "timeGridWeek" ? 7 : view === "dayGridMonth" ? 30 : 1)}>
                      <span className="fc-icon fc-icon-chevron-right" />
                    </button>
                  </div>
                  <h2 className="fc-toolbar-title">
                    {view === "timeGridWeek" ? weekRangeTitle(date) : view === "dayGridMonth" ? monthTitle(date) : longTitle(date)}
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
                style={{ height: view === "dayGridMonth" ? "auto" : (view === "timeGridWeek" ? weekGridHeight : gridHeight) + 44 }}
              >
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
                    renderMonthView()
                  ) : view === "timeGridWeek" ? (
                    weekView
                  ) : (
                    <div className="cal-static-grid" style={{ display: "flex", minHeight: gridHeight }}>
                      {/* Time axis */}
                      <div className="cal-static-axis" style={{ flex: "0 0 56px", borderRight: "1px solid var(--calendar-line, #e2e8f0)", position: "relative" }}>
                        <div style={{ height: 44 }} />
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
                            <span
                              className="fc-timegrid-now-indicator-label"
                              style={{
                                position: "absolute",
                                right: 8,
                                top: 44 + dayNowIndicator.top,
                                transform: "translateY(-50%)",
                                fontSize: 11,
                                fontWeight: 600,
                                color: "#ef4444",
                                background: "#fff",
                                padding: "0 2px",
                                pointerEvents: "none",
                                zIndex: 7,
                              }}
                            >
                              {dayNowIndicator.label}
                            </span>
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

                      {/* Staff columns. overflowX:auto mirrors FullCalendar's dayMinWidth:
                          when the per-column min-width (--calendar-staff-col-min) makes the
                          columns wider than the container (many operators), this wrapper
                          scrolls horizontally instead of squishing the columns to nil; with
                          one / a few columns flex-grow still fills the width. */}
                      <div style={{ display: "flex", flex: "1 1 auto", minWidth: 0, position: "relative", overflowX: "auto" }}>
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
                        {staffCols.length === 0 ? (
                          <div className="text-muted small p-4">{loading ? "Caricamento prenotazioni..." : "Nessun operatore attivo."}</div>
                        ) : (
                          staffCols.map((s, colIndex) => {
                            const first = (Array.from(s.name.trim())[0] || "O").toUpperCase();
                            const colAppts = apptsForStaff(s.name);
                            const colCount = colAppts.length;
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
                                  style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderBottom: "1px solid var(--calendar-line, #e2e8f0)" }}
                                >
                                  <div className="staff-col-head" data-staff-id={s.id}>
                                    {s.photoPath ? (
                                      <span className="staff-col-avatar">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={s.photoPath} alt="" />
                                      </span>
                                    ) : (
                                      <span className="staff-col-avatar staff-col-avatar-fallback" data-staff-id={s.id} style={{ background: s.color }}>
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
                                    if (dragRef.current) {
                                      e.preventDefault();
                                      e.dataTransfer.dropEffect = "move";
                                    }
                                  }}
                                  onDrop={(e) => {
                                    const drag = dragRef.current;
                                    if (!drag) return;
                                    e.preventDefault();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    // Map the block TOP (cursor - grab offset), not the cursor.
                                    const topPx = e.clientY - rect.top - drag.grabOffsetPx;
                                    void moveAppointment(drag.id, timeFromY(topPx), s.name);
                                    dragRef.current = null;
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
                                  {/* HOVER guide-line / slot-highlight / time label + live
                                      drag-select band overlays (non-interactive). */}
                                  {renderHoverOverlay(`day-${s.id}`, minMin)}
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
                                    return (
                                      <a
                                        key={a.id}
                                        href={href(`appointments&action=view&id=${a.id}`)}
                                        // EDIT in the GLOBAL drawer: a plain click (not a drag)
                                        // routes to the drawer's document-level [data-qb-edit]
                                        // listener via the hidden edit anchor (openGlobalEdit).
                                        // The block itself does NOT carry data-qb-edit so its own
                                        // click can stopPropagation (to suppress the column
                                        // quick-book) without losing the edit-open path.
                                        className="fc-event fc-timegrid-event appt-soft-event"
                                        title={`${a.time} ${a.client} • ${serviceTitleOf(a)}`}
                                        draggable
                                        // Keep a press on the block from starting a column
                                        // drag-select; the HTML5 move-drag (onDragStart) and the
                                        // hover-suppress-on-block are unaffected.
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onDragStart={(e) => {
                                          // Record the grabbed appointment + the pointer offset
                                          // from the block top, so the drop maps the block start.
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          dragRef.current = { id: a.id, grabOffsetPx: e.clientY - rect.top };
                                          e.dataTransfer.effectAllowed = "move";
                                          // Some browsers require data to start a drag.
                                          try { e.dataTransfer.setData("text/plain", String(a.id)); } catch { /* ignore */ }
                                        }}
                                        onDragEnd={() => {
                                          // Clear shortly after so the synthetic click that follows
                                          // a drag does not trigger quick-book / edit on the column.
                                          setTimeout(() => { dragRef.current = null; }, 0);
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
                                          borderLeft: `3px solid ${s.color}`,
                                          background: "#f4f8ff",
                                          color: "#14326f",
                                          boxSizing: "border-box",
                                          // Above the store-background bands (z 0, and the
                                          // -master break band at z 2) so blocks stay
                                          // visible/clickable over the shading.
                                          zIndex: 3,
                                        }}
                                      >
                                        <div className="fc-event-main">
                                          <span className={`appt-status-badge status-${st.key}`} title={`Stato: ${st.label}`}>
                                            {st.label}
                                          </span>
                                          <span className="appt-staff-dot" style={{ background: s.color }} />
                                          <div className="fw-semibold appt-client" style={{ lineHeight: 1.15 }}>
                                            {a.time} {a.client}
                                          </div>
                                          {/* ALL booked services, one bulleted line each (faithful to
                                              the legacy multi-service block), not just the primary. The
                                              operator is NOT bulleted here: the Day view already has a
                                              per-operator column header (legacy showStaff=false in
                                              staffTimeGridDay). Falls back to the single service. */}
                                          {serviceNamesOf(a).map((name, i) => (
                                            <div key={i} className="small text-truncate appt-service">
                                              {`· ${name}`}
                                            </div>
                                          ))}
                                        </div>
                                        {/* RESIZE handle (bottom edge): drag to change the end
                                            time (a custom duration). Not draggable itself; it uses
                                            mousedown so the block's HTML5 drag doesn't fire, and
                                            stops the click so neither edit nor quick-book triggers. */}
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
                    {notesError ? (
                      <div className="alert alert-danger py-2 px-3 mb-3" role="alert">
                        {notesError}
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
                        {longTitle(notesFilterDate ?? date)}
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
                    <button type="button" className="btn btn-sm btn-outline-secondary" id="calendarNotesNewBtn">
                      <i className="bi bi-plus-circle me-1" />
                      Nuova
                    </button>
                  </div>
                  <div id="calendarNotesList" className="calendar-notes-list">
                    {displayNotes.length === 0 ? (
                      <div className="calendar-note-empty">
                        <div className="fw-semibold mb-1">
                          {notesFilterDate ? "Nessuna nota nel giorno selezionato" : "Nessuna nota nel periodo visibile"}
                        </div>
                        <div className="small">Crea una nota dal modulo a sinistra.</div>
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
                <button type="submit" form="calendarNotesForm" className="btn btn-primary" id="calendarNotesSaveBtn">
                  <i className="bi bi-check2-circle me-1" />
                  Salva nota
                </button>
              </div>
              <button type="button" className="btn btn-outline-danger d-none ms-auto" id="calendarNoteDeleteBtn">
                <i className="bi bi-trash me-1" />
                Elimina
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
