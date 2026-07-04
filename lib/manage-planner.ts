// Calendar Block 3 — the recurring/planned appointments "Pianifica" feature.
//
// Faithful port of app/pages/appointments_plan.php (the ?page=appointments_plan
// planner). It generates a set of recurrence dates (weekly / every-2-weeks /
// every-3-weeks / monthly across N cycles × the chosen weekdays), finds a free
// slot within a daily time WINDOW [time_from, time_to] for each date, and builds
// an OK/Saltato preview. On create it re-runs the same search (never trusting the
// client) and inserts each OK date.
//
// Reuse, NOT reimplementation: per the migration brief we REUSE the existing Next
// appointment infrastructure rather than porting the legacy DFS slot finder:
//  * publicBookingSlots (lib/public-booking-db.ts) gives the date's free slot grid
//    (business hours + closed-day detection + busy ranges) — we pick the FIRST
//    available slot whose start is inside the window.
//  * assertAppointmentSlotAvailable (the Block-1 guard: staff overlap / cabin /
//    time-off / shift) VALIDATES the candidate's per-service segments so the
//    preview matches exactly what create will accept.
//  * createDbAppointment (lib/db-repositories.ts) inserts each OK appointment
//    (appointments + public_code + appointment_services + appointment_staff +
//    appointment_segments) — we do not rebuild that.
//  * createDbClient / getDbClient handle the optional new-client creation.

import {
  allowedCabinIdsForServices,
  assertClientNotBlockedForSave,
  cabinsForServicesContext,
  createDbAppointment,
  createDbClient,
  getDbClient,
  tenantCabinsEnabled,
} from "@/lib/db-repositories";
import {
  assertAppointmentSlotAvailable,
  publicBookingContext,
  publicBookingSlots,
  type AppointmentSlotSegment,
  type PublicBookingContext,
} from "@/lib/public-booking-db";

// ---------------------------------------------------------------------------
// Form parsing (port of the $form block, appointments_plan.php:1545-1562).
// parseRequestBody flattens everything to strings, so arrays/maps arrive as a
// comma-joined or JSON string; the parse* helpers tolerate both.
// ---------------------------------------------------------------------------

export type PlannerForm = {
  clientId: number;
  newFullName: string;
  newPhone: string;
  newEmail: string;
  serviceIds: number[];
  repeat: number;
  staffId: number;
  staffMap: Record<number, number>;
  cabinMap: Record<number, number>;
  recurrence: "weekly" | "weekly2" | "weekly3" | "monthly";
  weekdays: number[];
  startDate: string;
  timeFrom: string;
  timeTo: string;
};

export type PlannerPreviewRow = {
  date: string; // YYYY-MM-DD
  time: string | null; // "HH:MM–HH:MM" range, null when skipped
  start: string | null; // HH:MM
  end: string | null; // HH:MM
  operator: string | null; // joined distinct operator names
  serviceOrder: number[]; // resolved service order for the slot
  cabinMap: Record<number, number>; // resolved per-service cabin (when applicable)
  ok: boolean;
  reason: string | null;
};

export type PlannerPreview = {
  ok: boolean;
  dates: PlannerPreviewRow[];
  totalDuration: number;
  totalPrice: number;
  serviceNames: string[];
  services: Array<{ id: number; name: string; durationMin: number; price: number }>;
  countOk: number;
  countSkip: number;
  // Cabine per la UI (legacy cabin_avail_by_service, appointments_plan.php
  // 1906-1950): calcolate sullo SLOT DI RIFERIMENTO (la PRIMA riga OK), per
  // servizio sul proprio sotto-intervallo consecutivo. La select "Cabina" della
  // UI è gated finché non esiste una preview.
  cabinsEnabled: boolean;
  cabinAvail: Record<number, Array<{ id: number; name: string }>>;
};

export type PlannerCreateResult = {
  ok: boolean;
  created: number;
  skipped: number;
  clientId: number;
  newClientId: number | null;
  details: Array<{ date: string; ok: boolean; appointmentId?: number; reason?: string }>;
};

// Parse the planner form out of the (already string-flattened) request body.
export function parsePlannerForm(body: Record<string, unknown>): PlannerForm {
  const repeat = Math.max(1, Math.min(200, intOf(body.repeat, 1)));
  const recurrenceRaw = String(body.recurrence ?? "weekly");
  const recurrence: PlannerForm["recurrence"] =
    recurrenceRaw === "weekly2" || recurrenceRaw === "weekly3" || recurrenceRaw === "monthly"
      ? recurrenceRaw
      : "weekly";
  // weekdays 0..6, unique + sorted ascending (legacy sort()).
  const weekdays = Array.from(
    new Set(parseIntList(body.weekdays).filter((x) => x >= 0 && x <= 6)),
  ).sort((a, b) => a - b);

  return {
    clientId: intOf(body.client_id, 0),
    newFullName: String(body.new_full_name ?? "").trim(),
    newPhone: String(body.new_phone ?? "").trim(),
    newEmail: String(body.new_email ?? "").trim(),
    serviceIds: parseIntListPreserveOrder(body.service_ids),
    repeat,
    staffId: intOf(body.staff_id, 0),
    staffMap: parseIdMap(body.staff_map),
    cabinMap: parseIdMap(body.cabin_map),
    recurrence,
    weekdays,
    startDate: String(body.start_date ?? "").trim(),
    timeFrom: String(body.time_from ?? "09:00").trim(),
    timeTo: String(body.time_to ?? "09:00").trim(),
  };
}

// ---------------------------------------------------------------------------
// Recurrence DATE GENERATION (port of appointments_plan.php:1732-1833).
// Anchors the start to the next occurrence of the first selected weekday
// (Lun→Dom order), aligns the start to that weekday, then for weekly/weekly2/
// weekly3 emits every selected weekday across `repeat` cycles (interval 1/2/3
// weeks, week anchored to Monday); for monthly emits one date per month.
// ---------------------------------------------------------------------------

export function generatePlannerDates(form: PlannerForm, today = new Date()): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) {
    throw new Error("Data di partenza non valida.");
  }
  // Midnight-anchored start (the legacy '!Y-m-d' avoids the current-time bleed).
  let start = dateAtMidnight(form.startDate);
  const todayMid = midnight(today);

  // Non-retroactive: clamp a past "Dal giorno" up to today.
  if (start.getTime() < todayMid.getTime()) start = todayMid;

  let weekdays = form.weekdays.slice();

  // When the user selected weekdays, anchor the start to the FIRST selected weekday
  // (Lun→Dom order) and force the start to its next occurrence strictly after today.
  if (weekdays.length > 0) {
    const order: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };
    let anchor: number | null = null;
    let best = 999;
    for (const wd of weekdays) {
      if (order[wd] !== undefined && order[wd] < best) {
        best = order[wd];
        anchor = wd;
      }
    }
    if (anchor !== null) {
      const todayDow = todayMid.getDay();
      let delta = (anchor - todayDow + 7) % 7;
      if (delta === 0) delta = 7; // exclude today
      const minStart = addDays(todayMid, delta);
      if (start.getTime() < minStart.getTime()) start = minStart;
      // Align start to the anchor weekday.
      let guard = 0;
      while (guard < 370 && start.getDay() !== anchor) {
        start = addDays(start, 1);
        guard++;
      }
    }
  }

  // No weekday selected → use the start date's own weekday.
  if (weekdays.length === 0) weekdays = [start.getDay()];

  const dates: string[] = [];

  if (form.recurrence === "monthly") {
    // Monthly: one date per cycle — the first selected-weekday date at/after the
    // month's base date (and not before `start` in the first month).
    for (let i = 0; i < form.repeat; i++) {
      const base = addMonths(start, i);
      let d = base;
      for (let k = 0; k < 14; k++) {
        if (i === 0 && d.getTime() < start.getTime()) {
          d = addDays(d, 1);
          continue;
        }
        if (weekdays.includes(d.getDay())) {
          dates.push(fmtIso(d));
          break;
        }
        d = addDays(d, 1);
      }
    }
  } else {
    const intervalWeeks = form.recurrence === "weekly2" ? 2 : form.recurrence === "weekly3" ? 3 : 1;
    // Week start anchored to Monday for deterministic weekday offsets.
    const baseWeekStart = mondayThisWeek(start);
    for (let cycle = 0; cycle < form.repeat; cycle++) {
      const weekStart = addDays(baseWeekStart, cycle * intervalWeeks * 7);
      for (const wd of weekdays) {
        const offset = wd === 0 ? 6 : wd - 1; // Mon(1)->0 … Sat(6)->5, Sun(0)->6
        const d = addDays(weekStart, offset);
        if (cycle === 0 && d.getTime() < start.getTime()) continue; // skip pre-start
        dates.push(fmtIso(d));
      }
    }
  }

  // Unique + sorted (lexicographic == chronological for YYYY-MM-DD).
  return Array.from(new Set(dates)).sort();
}

// ---------------------------------------------------------------------------
// Per-date SLOT SEARCH — reuse publicBookingSlots + assertAppointmentSlotAvailable
// (replaces find_slot_plan_multi's DFS, per the brief). Finds the FIRST available
// slot whose start fits the window, then validates the real per-service segments.
// ---------------------------------------------------------------------------

type SlotResult =
  | {
      ok: true;
      start: string;
      end: string;
      operatorNames: string[];
      serviceOrder: number[];
      cabinMap: Record<number, number>;
    }
  | { ok: false; reason: string };

// Resolved server-side service data (id -> name/duration/price + per-service staff).
type ResolvedServices = {
  ordered: Array<{ id: number; name: string; durationMin: number; price: number }>;
  totalDuration: number;
  totalPrice: number;
  staffFinal: Record<number, number>; // serviceId -> staffId (resolved, required)
  staffNameById: Map<number, string>;
};

// Resolve services (in selection order) + the final per-service staff map. Mirrors
// the legacy staff-per-service resolution (appointments_plan.php:1640-1693): a
// service with exactly one eligible operator is auto-assigned; otherwise the posted
// staff_map entry must be a valid eligible operator. Throws faithful messages.
function resolveServices(form: PlannerForm, context: PublicBookingContext): ResolvedServices {
  if (form.serviceIds.length === 0) throw new Error("Seleziona almeno un servizio.");

  const ordered: ResolvedServices["ordered"] = [];
  const staffFinal: Record<number, number> = {};
  const staffNameById = new Map<number, string>();
  for (const st of context.staff) staffNameById.set(st.id, st.name);

  let totalDuration = 0;
  let totalPrice = 0;

  // PASSO 1 — risoluzione servizi (durate/prezzi). Ordine di precedenza legacy
  // (appointments_plan.php 1628-1651): prima gli errori servizio, POI il check
  // finestra-vs-durata, e solo dopo la scelta operatori.
  for (const sid of form.serviceIds) {
    const svc = context.services.find((s) => s.id === sid);
    if (!svc) throw new Error(`Servizio non valido: ${sid}`);
    if (svc.duration <= 0) throw new Error(`Durata servizio non valida: ${svc.name}`);
    ordered.push({ id: svc.id, name: svc.name, durationMin: svc.duration, price: svc.price });
    totalDuration += svc.duration;
    totalPrice += svc.price;
  }

  // La finestra oraria non può essere più corta della durata complessiva dei
  // servizi (legacy 1644-1651, messaggio verbatim).
  const fromMin = parseTimeToMin(form.timeFrom);
  const toMin = parseTimeToMin(form.timeTo);
  if (fromMin !== null && toMin !== null && toMin < fromMin + totalDuration) {
    throw new Error('"Alle ore" deve essere >= "Dalle ore" + durata servizi.');
  }

  // PASSO 2 — operatori per servizio.
  for (const svcEntry of ordered) {
    const sid = svcEntry.id;
    const svc = context.services.find((s) => s.id === sid)!;
    // no_operator services don't need an operator.
    if (svc.noOperator) {
      staffFinal[sid] = 0;
      continue;
    }
    // Eligible operators: those mapped to this service (staff_services), else all.
    const eligible = context.staff.filter(
      (s) => s.active && (s.serviceIds.length === 0 || s.serviceIds.includes(sid)),
    );
    // A staff with an explicit mapping list takes precedence; if NO staff maps this
    // service at all, every active staff is eligible (legacy "no mapping → all").
    const mapped = context.staff.filter((s) => s.active && s.serviceIds.includes(sid));
    const pool = mapped.length > 0 ? mapped : eligible;
    if (pool.length === 0) {
      throw new Error(`Nessun operatore disponibile per il servizio: ${svc.name}`);
    }
    if (pool.length === 1) {
      staffFinal[sid] = pool[0].id;
    } else {
      const chosen = Number(form.staffMap[sid] ?? 0);
      if (chosen <= 0 || !pool.some((s) => s.id === chosen)) {
        throw new Error(`Seleziona un operatore per il servizio: ${svc.name}`);
      }
      staffFinal[sid] = chosen;
    }
  }

  return { ordered, totalDuration, totalPrice, staffFinal, staffNameById };
}

// Guardie comuni preview/create (legacy appointments_plan.php 1609-1723, stesso
// ordine): cliente bloccato, servizi non in sede, validazione/normalizzazione
// della mappa cabine (auto-assegnazione con UNA sola cabina consentita).
async function assertPlannerGuards(
  slug: string,
  form: PlannerForm,
  context: PublicBookingContext,
  resolved: ResolvedServices,
  locationId: number | null,
): Promise<{ cabinsEnabled: boolean }> {
  // Cliente esistente bloccato (legacy 1609-1611): stessa guardia del quick booking.
  if (form.clientId > 0) await assertClientNotBlockedForSave(slug, form.clientId);

  // Servizi non disponibili nella sede corrente (legacy 1613-1621): un servizio
  // con righe service_locations deve includere la sede; senza righe vale ovunque.
  if (locationId && locationId > 0) {
    for (const sid of form.serviceIds) {
      const svc = context.services.find((s) => s.id === sid);
      const locationIds = (svc as { locationIds?: number[] } | undefined)?.locationIds ?? [];
      if (svc && locationIds.length > 0 && !locationIds.includes(locationId)) {
        throw new Error("Servizio non disponibile nella sede corrente.");
      }
    }
  }

  // Cabine (legacy 1698-1723): con cabine attive, ogni servizio deve avere almeno
  // una cabina consentita; una scelta esplicita deve essere consentita; con UNA
  // sola cabina possibile viene assegnata automaticamente (0 = Auto).
  const cabinsEnabled = await tenantCabinsEnabled(slug, locationId).catch(() => false);
  if (cabinsEnabled) {
    for (const svcEntry of resolved.ordered) {
      const allowed = await allowedCabinIdsForServices(slug, [svcEntry.id], locationId).catch(() => [] as number[]);
      if (allowed.length === 0) {
        throw new Error(`Nessuna cabina disponibile per il servizio: ${svcEntry.name}`);
      }
      const chosen = Number(form.cabinMap[svcEntry.id] ?? 0);
      if (chosen > 0 && !allowed.includes(chosen)) {
        throw new Error(`Seleziona una cabina valida per il servizio: ${svcEntry.name}`);
      }
      if (allowed.length === 1) form.cabinMap[svcEntry.id] = allowed[0];
    }
  }
  return { cabinsEnabled };
}

// Build the sequential per-service segments for a candidate start (mirrors how
// createDbAppointment / planAppointmentServices lay them out), so the validation
// guard sees exactly what create will insert.
function buildSegments(
  date: string,
  startMin: number,
  resolved: ResolvedServices,
  cabinMap: Record<number, number>,
  locationId: number | null,
): AppointmentSlotSegment[] {
  const segments: AppointmentSlotSegment[] = [];
  let cursor = startMin;
  for (const svc of resolved.ordered) {
    const staffId = Number(resolved.staffFinal[svc.id] ?? 0) || null;
    const cabinId = Number(cabinMap[svc.id] ?? 0) || null;
    const segStart = cursor;
    const segEnd = cursor + svc.durationMin;
    segments.push({
      staffId,
      startsAt: `${date} ${minToHHMM(segStart)}:00`,
      endsAt: `${date} ${minToHHMM(segEnd)}:00`,
      locationId,
      cabinId,
    });
    cursor = segEnd;
  }
  return segments;
}

async function findSlotForDate(
  slug: string,
  date: string,
  form: PlannerForm,
  resolved: ResolvedServices,
  locationId: number | null,
): Promise<SlotResult> {
  const fromMin = parseTimeToMin(form.timeFrom);
  const toMin = parseTimeToMin(form.timeTo);
  if (fromMin === null || toMin === null) return { ok: false, reason: "Orario non valido." };
  const fixed = fromMin === toMin;
  const totalDur = resolved.totalDuration;
  const serviceOrder = resolved.ordered.map((s) => s.id);

  // The distinct operators across all services. When exactly one operator covers
  // every service, pass it to publicBookingSlots so the `available` flag is
  // operator-accurate; otherwise pass null (grid only) and rely on the per-segment
  // guard for the real conflict check.
  const distinctStaff = Array.from(
    new Set(serviceOrder.map((sid) => Number(resolved.staffFinal[sid] ?? 0)).filter((x) => x > 0)),
  );
  const slotStaffId = distinctStaff.length === 1 ? distinctStaff[0] : null;

  let slots;
  try {
    slots = await publicBookingSlots({ slug, date, serviceIds: serviceOrder, staffId: slotStaffId, locationId });
  } catch {
    return { ok: false, reason: "Servizio non valido." };
  }

  // Empty grid == no business interval that day == closed (the legacy checks
  // is_closed_day_plan first and labels these "Chiuso").
  if (slots.length === 0) return { ok: false, reason: "Chiuso" };

  // Candidate starts inside the window whose END also fits the window (unless the
  // window is a fixed single instant). Prefer publicBookingSlots' own `available`
  // flag, then confirm with the per-segment guard.
  let lastReason = "Nessuno slot disponibile nella finestra scelta";
  let sawWindowCandidate = false;
  for (const slot of slots) {
    const startMin = parseTimeToMin(slot.time);
    if (startMin === null) continue;
    if (startMin < fromMin) continue;
    if (fixed) {
      if (startMin !== fromMin) continue;
    } else if (startMin + totalDur > toMin) {
      continue; // end would spill past the window
    }
    sawWindowCandidate = true;
    if (!slot.available) {
      lastReason = "Operatore occupato";
      continue;
    }

    // Validate the real per-service segments (staff overlap / cabin / time-off /
    // shift). This is the SAME guard create runs, so the preview never lies.
    const segments = buildSegments(date, startMin, resolved, form.cabinMap, locationId);
    try {
      await assertAppointmentSlotAvailable({ slug, date, segments });
    } catch (error) {
      lastReason = reasonFromGuardError(error);
      continue;
    }

    // Operator names for the row (distinct, in service order).
    const operatorNames: string[] = [];
    const seen = new Set<number>();
    for (const sid of serviceOrder) {
      const stId = Number(resolved.staffFinal[sid] ?? 0);
      if (stId > 0 && !seen.has(stId)) {
        seen.add(stId);
        const nm = resolved.staffNameById.get(stId);
        if (nm) operatorNames.push(nm);
      }
    }

    return {
      ok: true,
      start: minToHHMM(startMin),
      end: minToHHMM(startMin + totalDur),
      operatorNames,
      serviceOrder,
      cabinMap: { ...form.cabinMap },
    };
  }

  return {
    ok: false,
    reason: sawWindowCandidate ? lastReason : "Nessuno slot disponibile nella finestra scelta",
  };
}

// Map an assertAppointmentSlotAvailable throw to a compact legacy-style reason.
function reasonFromGuardError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/cabina/i.test(msg)) return "Cabina non disponibile";
  if (/non disponibile|time.?off/i.test(msg)) return "Operatore non disponibile";
  if (/occupat/i.test(msg)) return "Operatore occupato";
  return msg || "Slot non disponibile";
}

// ---------------------------------------------------------------------------
// PREVIEW (action=plan_preview) — generate dates + find a slot for each.
// ---------------------------------------------------------------------------

export async function planPreview(
  slug: string,
  body: Record<string, unknown>,
  locationId: number | null,
): Promise<PlannerPreview> {
  const form = parsePlannerForm(body);
  validatePlannerForm(form);

  const context = await publicBookingContext(slug);
  const resolved = resolveServices(form, context);
  const { cabinsEnabled } = await assertPlannerGuards(slug, form, context, resolved, locationId);

  const dates = generatePlannerDates(form);
  if (dates.length === 0) throw new Error("Nessuna data generata.");

  const rows: PlannerPreviewRow[] = [];
  for (const date of dates) {
    const slot = await findSlotForDate(slug, date, form, resolved, locationId);
    if (slot.ok) {
      rows.push({
        date,
        time: `${slot.start}–${slot.end}`,
        start: slot.start,
        end: slot.end,
        operator: slot.operatorNames.length > 0 ? slot.operatorNames.join(", ") : null,
        serviceOrder: slot.serviceOrder,
        cabinMap: slot.cabinMap,
        ok: true,
        reason: null,
      });
    } else {
      rows.push({
        date,
        time: null,
        start: null,
        end: null,
        operator: null,
        serviceOrder: [],
        cabinMap: {},
        ok: false,
        reason: slot.reason,
      });
    }
  }

  const countOk = rows.filter((r) => r.ok).length;

  // Cabine disponibili per la UI (legacy cabin_avail_by_service, 1906-1950):
  // calcolate SOLO sulla PRIMA riga OK (slot di riferimento), per ogni servizio
  // sul proprio sotto-intervallo consecutivo dentro lo slot.
  const cabinAvail: PlannerPreview["cabinAvail"] = {};
  if (cabinsEnabled) {
    const firstOk = rows.find((r) => r.ok && r.start);
    if (firstOk && firstOk.start) {
      const baseMin = parseTimeToMin(firstOk.start);
      if (baseMin !== null) {
        let offset = 0;
        const order = firstOk.serviceOrder.length ? firstOk.serviceOrder : form.serviceIds;
        for (const sid of order) {
          const svc = resolved.ordered.find((s) => s.id === sid);
          if (!svc || svc.durationMin <= 0) continue;
          const segStart = baseMin + offset;
          const startsAt = `${firstOk.date} ${minToHHMM(segStart)}:00`;
          const endsAt = `${firstOk.date} ${minToHHMM(segStart + svc.durationMin)}:00`;
          try {
            const cabinCtx = await cabinsForServicesContext({ slug, serviceIds: [sid], startsAt, endsAt, locationId });
            cabinAvail[sid] = cabinCtx.cabins.filter((cabin) => !cabin.occupied).map((cabin) => ({ id: cabin.id, name: cabin.name }));
          } catch {
            cabinAvail[sid] = [];
          }
          offset += svc.durationMin;
        }
      }
    }
  }

  return {
    ok: true,
    dates: rows,
    totalDuration: resolved.totalDuration,
    totalPrice: roundMoney(resolved.totalPrice),
    serviceNames: resolved.ordered.map((s) => s.name),
    services: resolved.ordered.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: roundMoney(s.price) })),
    countOk,
    countSkip: rows.length - countOk,
    cabinsEnabled,
    cabinAvail,
  };
}

// ---------------------------------------------------------------------------
// CREATE (action=plan_create) — re-run the search (never trust the client),
// create the new client when needed, then createDbAppointment per OK date.
// Best-effort per date: one failure does not abort the rest (it is reported).
// ---------------------------------------------------------------------------

export async function planCreate(
  slug: string,
  body: Record<string, unknown>,
  locationId: number | null,
): Promise<PlannerCreateResult> {
  const form = parsePlannerForm(body);
  validatePlannerForm(form);

  const context = await publicBookingContext(slug);
  const resolved = resolveServices(form, context);
  await assertPlannerGuards(slug, form, context, resolved, locationId);

  // Resolve the client. An existing client_id wins; otherwise create the new client
  // now (port of appointments_plan.php:1581-1605). createDbAppointment resolves the
  // client by full_name, so we pass the resolved client's name through.
  let clientId = form.clientId;
  let newClientId: number | null = null;
  let clientName = "";
  if (clientId > 0) {
    const existing = await getDbClient(clientId, slug);
    if (!existing) throw new Error("Cliente non valido.");
    clientName = existing.name;
  } else {
    if (form.newFullName === "") throw new Error("Seleziona un cliente o inserisci un nuovo cliente.");
    if (form.newEmail !== "" && !isValidEmail(form.newEmail)) throw new Error("Email nuovo cliente non valida.");
    let created;
    try {
      created = await createDbClient(
        {
          name: form.newFullName,
          phone: form.newPhone || undefined,
          email: form.newEmail || undefined,
          locationId: locationId ?? 0,
        },
        slug,
      );
    } catch {
      // Verbatim legacy (appointments_plan.php 1603).
      throw new Error("Impossibile creare il nuovo cliente.");
    }
    if (!created || created.id <= 0) throw new Error("Impossibile creare il nuovo cliente.");
    clientId = created.id;
    newClientId = created.id;
    clientName = created.name;
  }

  const dates = generatePlannerDates(form);
  if (dates.length === 0) throw new Error("Nessuna data generata.");

  const details: PlannerCreateResult["details"] = [];
  let created = 0;
  let skipped = 0;

  for (const date of dates) {
    const slot = await findSlotForDate(slug, date, form, resolved, locationId);
    if (!slot.ok) {
      skipped++;
      details.push({ date, ok: false, reason: slot.reason });
      continue;
    }
    try {
      // Reuse createDbAppointment: it builds appointments + public_code +
      // appointment_services + appointment_staff + appointment_segments and runs the
      // same slot guard. We pass the ordered service NAMES + per-service staff/cabin
      // maps so the multi-service layout matches the previewed slot. status=scheduled
      // (the legacy planner_create_appointment_like_backend uses 'scheduled').
      const serviceNames = slot.serviceOrder.map((sid) => {
        const svc = resolved.ordered.find((s) => s.id === sid);
        return svc ? svc.name : "";
      });
      const appointment = await createDbAppointment({
        slug,
        clientName,
        serviceName: serviceNames[0] ?? "",
        serviceNames,
        operator: "", // per-service staff comes from staffMap
        staffMap: resolved.staffFinal,
        cabinMap: slot.cabinMap,
        time: slot.start,
        date,
        locationId,
        status: "scheduled",
      });
      created++;
      details.push({ date, ok: true, appointmentId: appointment.id });
    } catch (error) {
      // Best-effort: a single date's failure is reported but does not abort the rest.
      skipped++;
      details.push({ date, ok: false, reason: error instanceof Error ? error.message : "Errore creazione." });
    }
  }

  if (created === 0) {
    throw new Error("Nessuna prenotazione creabile (tutte non disponibili).");
  }

  return { ok: true, created, skipped, clientId, newClientId, details };
}

// ---------------------------------------------------------------------------
// Validation (port of the early-throw guards, appointments_plan.php:1577-1651).
// ---------------------------------------------------------------------------

function validatePlannerForm(form: PlannerForm): void {
  if (form.clientId <= 0 && form.newFullName === "") {
    throw new Error("Seleziona un cliente o inserisci un nuovo cliente.");
  }
  if (form.newEmail !== "" && !isValidEmail(form.newEmail)) {
    throw new Error("Email nuovo cliente non valida.");
  }
  if (form.serviceIds.length === 0) throw new Error("Seleziona almeno un servizio.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) throw new Error("Data di partenza non valida.");
  const fromMin = parseTimeToMin(form.timeFrom);
  const toMin = parseTimeToMin(form.timeTo);
  if (fromMin === null || toMin === null) throw new Error("Orario non valido.");
  if (toMin < fromMin) throw new Error('"Alle ore" deve essere >= "Dalle ore".');
}

// ---------------------------------------------------------------------------
// Small pure helpers (kept local so the planner is self-contained).
// ---------------------------------------------------------------------------

function intOf(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Parse a list of ints (array, JSON-array string, or comma/space joined string).
// Does NOT preserve order or dedupe (used for weekdays which are sorted anyway).
function parseIntList(raw: unknown): number[] {
  return splitIntTokens(raw);
}

// Parse a list of POSITIVE ints preserving order + dropping duplicates
// (unique_int_list_preserve_order_plan). Used for service_ids.
function parseIntListPreserveOrder(raw: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of splitIntTokens(raw)) {
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function splitIntTokens(raw: unknown): number[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
  }
  const parts = Array.isArray(source) ? source : String(source ?? "").split(/[,\s]+/);
  const out: number[] = [];
  for (const part of parts) {
    const n = Number.parseInt(String(part).trim(), 10);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Parse a serviceId -> id map (staff_map / cabin_map): JSON object string,
// plain object, or "sid:val" pairs joined by comma/semicolon.
function parseIdMap(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (raw === null || raw === undefined || raw === "") return out;
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return out;
    if (trimmed.startsWith("{")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
    if (typeof source === "string") {
      for (const pair of source.split(/[,;]/)) {
        const [k, v] = pair.split(":");
        const key = Number.parseInt(String(k ?? "").trim(), 10);
        const val = Number.parseInt(String(v ?? "").trim(), 10);
        if (Number.isFinite(key) && key > 0 && Number.isFinite(val) && val > 0) out[key] = val;
      }
      return out;
    }
  }
  if (source && typeof source === "object") {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      const key = Number.parseInt(k, 10);
      const val = Number.parseInt(String(v), 10);
      if (Number.isFinite(key) && key > 0 && Number.isFinite(val) && val > 0) out[key] = val;
    }
  }
  return out;
}

function parseTimeToMin(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minToHHMM(m: number): string {
  const safe = Math.max(0, m);
  const h = Math.floor(safe / 60);
  const mm = safe - h * 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// --- Date math (local time, midnight-anchored — mirrors the PHP DateTimeImmutable
// operations, which run in the app's local timezone). ---

function dateAtMidnight(iso: string): Date {
  const [y, m, d] = iso.split("-").map((x) => Number.parseInt(x, 10));
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function midnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

function addMonths(date: Date, months: number): Date {
  // Mirror PHP's '+N months' (clamps to the last day when the target month is shorter).
  const y = date.getFullYear();
  const m = date.getMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDay);
  return new Date(targetYear, targetMonth, day, 0, 0, 0, 0);
}

// "monday this week" — PHP's strtotime semantics: the Monday of the ISO week the
// date falls in (Sunday belongs to the week that STARTED on the prior Monday).
function mondayThisWeek(date: Date): Date {
  const dow = date.getDay(); // 0=Sun … 6=Sat
  const deltaToMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(date, deltaToMonday);
}

function fmtIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
