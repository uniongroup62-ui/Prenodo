import {
  todayIso,
} from "@/lib/appointment-engine";
import { emptyToNull, jsonError, parseRequestBody } from "@/lib/api-utils";
import {
  appointmentCustomerVisibleChanged,
  appointmentPhpStatus,
  cancelDoneAppointment,
  cabinsForServicesContext,
  cancelDonePreview,
  createDbAppointment,
  deleteDbAppointment,
  evalBestPromotionForAppointment,
  fidelityGiftRedeemForAppointment,
  getDbAppointmentCustomerVisibleSnapshot,
  getDbAppointmentForEdit,
  getDbAppointmentMoveSnapshot,
  getDbAppointmentPhpStatus,
  getDbAppointmentSegmentCount,
  listDbAppointments,
  resizeDbAppointmentEnd,
  swapDbAppointmentSegment,
  updateDbAppointment,
  updateDbAppointmentStatus,
  type AppointmentPackageRedeem,
  type AppointmentPrepaidRedeem,
  type AppointmentGiftcardRedeem,
  type AppointmentGiftboxRedeem,
  type AppointmentGiftRedeem,
} from "@/lib/db-repositories";
import { lifecycleKindForStatusChange, sendAppointmentLifecycleEmail } from "@/lib/appointment-lifecycle-email";
import { automationClearPendingReminders, automationScheduleReminder } from "@/lib/automation-reminders";
import { awardAppointmentFidelityOnDone } from "@/lib/manage-pos";
import { giftInvalidateSource, giftRecordAppointmentDone } from "@/lib/gifts-engine";
import { giftRedeemAppointmentSelectionIfAny } from "@/lib/gifts-instances";
import { currentManageSession } from "@/lib/manage-auth";
import { resolveManageLocationId } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";
import {
  holdPublicBookingSlot,
  manageAvailabilityBrowser,
  publicBookingContext,
  publicBookingSlots,
  releasePublicBookingHold,
  renewPublicBookingHold,
  type PublicBookingContext,
} from "@/lib/public-booking-db";
import { listQuickBookingCabins } from "@/lib/db-repositories";
import { getManageLocationContext } from "@/lib/manage-locations";
import { planCreate, planPreview } from "@/lib/manage-planner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, ["calendar.view", "appointments.manage", "appointments.plan"])) return jsonError("Permesso appuntamenti mancante.", 403);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";

  // Quick-booking context: everything the global "Nuova prenotazione" offcanvas
  // needs to render (services grouped by category, staff, locations, cabins) in a
  // single tenant-scoped GET. Mirrors the legacy quick-booking page setup
  // (app/lib/View.php groups $services by $categories, reads $serviceLocationMap,
  // and lists staff/cabins). Reuses publicBookingContext (services with
  // categoryId/duration/price/noOperator/locationIds + categories + staff +
  // locations) and adds cabins, which that context omits.
  if (action === "context") {
    try {
      const [context, cabins, locationContext] = await Promise.all([
        publicBookingContext(tenantSlug),
        listQuickBookingCabins(tenantSlug),
        getManageLocationContext(tenantSlug),
      ]);
      return Response.json({
        ok: true,
        sourceMode: "database",
        currentLocationId: locationContext.currentLocationId,
        categories: context.categories,
        services: context.services,
        staff: context.staff,
        locations: context.locations,
        cabins,
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore contesto prenotazione.");
    }
  }

  // EDIT-mode load for the global quick-booking drawer (port of
  // api_appointments.php action='get', ~8594). Returns the appointment's full
  // EDITABLE payload (client, services, per-service operator/cabin maps, date/time,
  // status, notes, booking code) so the drawer can PREFILL itself. Tenant-scoped +
  // permission-gated (same view/manage/plan check as the rest of this GET). The
  // SAVE path is unchanged: the drawer re-submits action=save WITH the id, which
  // routes to updateDbAppointment.
  if (action === "get") {
    const id = Number.parseInt(String(url.searchParams.get("id") ?? "0"), 10);
    if (!Number.isFinite(id) || id <= 0) return jsonError("ID mancante", 400);
    try {
      const appointment = await getDbAppointmentForEdit(tenantSlug, id);
      if (!appointment) return jsonError("Appuntamento non trovato.", 404);
      return Response.json({
        ok: true,
        sourceMode: "database",
        appointment,
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore caricamento prenotazione.");
    }
  }

  // CANCEL-DONE PREVIEW (compute-only) — the rich preview the drawer's cancel-done
  // modal renders BEFORE applying (port of api_appointments.php action='cancel_done_preview'
  // -> qb_cancel_done_load_preview). Gated on appointments.manage (a storno is a
  // management action, stricter than the umbrella view/manage/plan check above). Returns
  // { ok:false, error } (200) when the transition is not applicable so the modal shows the
  // message inline and disables Confirm; otherwise { ok:true, preview }. Mirrors the POST
  // cancel_done gate; served over GET here (the modal fetches it read-only).
  if (action === "cancel_done_preview") {
    if (!can(session.user.perms, "appointments.manage")) {
      return jsonError("Permesso annullamento appuntamenti mancante.", 403);
    }
    const id = Number.parseInt(String(url.searchParams.get("id") ?? "0"), 10);
    if (!Number.isFinite(id) || id <= 0) return jsonError("ID mancante", 400);
    const rawTarget = String(url.searchParams.get("target_status") ?? "canceled").trim();
    const targetStatus = appointmentPhpStatus(rawTarget) === "no_show" ? "no_show" : "canceled";
    try {
      const preview = await cancelDonePreview(tenantSlug, id, targetStatus);
      // Legacy returns { ok:false, error } when the preview carries an error, so the UI
      // surfaces the message; keep the full preview alongside for the modal to render.
      return Response.json({ ok: preview.ok, error: preview.error, preview });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore anteprima annullamento.");
    }
  }

  // FREE-cabin check for the drawer cabin select (port of the legacy
  // action=cabins_for_services / refreshCabinsForServices): the cabins allowed
  // for the selected services with their occupied state in the chosen window.
  if (action === "cabins_for_services") {
    try {
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("service_id") ?? "");
      const locationId = await resolveManageLocationId({
        slug: tenantSlug,
        raw: url.searchParams.get("location_id"),
        fallbackCurrent: true,
      }) || null;
      const result = await cabinsForServicesContext({
        slug: tenantSlug,
        serviceIds,
        startsAt: String(url.searchParams.get("starts_at") ?? url.searchParams.get("starts_at_local") ?? ""),
        endsAt: url.searchParams.get("ends_at"),
        excludeAppointmentId: Number.parseInt(String(url.searchParams.get("exclude_id") ?? "0"), 10) || null,
        excludeHoldToken: url.searchParams.get("appointment_hold_token"),
        locationId,
      });
      return Response.json({
        ok: true,
        cabins: result.cabins,
        free_ids: result.freeIds,
        auto_select: result.autoSelect,
        starts_at: result.startsAt,
        ends_at: result.endsAt,
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Impossibile caricare cabine.");
    }
  }

  // Promo auto-detection for the quick-booking price panel (port of the legacy
  // action=promotion_preview -> appt_eval_best_promotion_for_context): best
  // ELIGIBLE automatic promotion for the selected services + client + slot,
  // returned as per-service {list_price, booked_price, discount_badge} lines +
  // the stackability flags. Read-only; the save re-evaluates server-side.
  if (action === "promotion_preview") {
    try {
      const clientId = Number.parseInt(String(url.searchParams.get("client_id") ?? "0"), 10) || 0;
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("service_id") ?? "");
      const locationId = await resolveManageLocationId({
        slug: tenantSlug,
        raw: url.searchParams.get("location_id"),
        fallbackCurrent: true,
      }) || null;
      let date = String(url.searchParams.get("appt_date") ?? url.searchParams.get("date") ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayIso();
      const timeRaw = String(url.searchParams.get("appt_time") ?? url.searchParams.get("time") ?? "").trim();
      const time = /^\d{2}:\d{2}/.test(timeRaw) ? timeRaw.slice(0, 5) : null;
      if (serviceIds.length === 0) {
        return Response.json({ ok: true, applied: 0, promotion: null, services: [], location_id: locationId, service_ids: [], reason: "Nessun servizio selezionato." });
      }
      const promoCtx = await evalBestPromotionForAppointment({ slug: tenantSlug, serviceIds, date, time, clientId: clientId > 0 ? clientId : null, locationId });
      return Response.json({
        ok: true,
        applied: promoCtx.applied ? 1 : 0,
        promotion: promoCtx.promotion
          ? {
              id: promoCtx.promotion.id,
              title: promoCtx.promotion.title,
              stackable: promoCtx.promotion.stackable,
              stackable_with_fidelity: promoCtx.promotion.stackable_with_fidelity ? 1 : 0,
              stackable_with_coupon: promoCtx.promotion.stackable_with_coupon ? 1 : 0,
            }
          : null,
        services: promoCtx.services,
        location_id: locationId,
        service_ids: serviceIds,
        ...(promoCtx.applied ? {} : { reason: promoCtx.reason }),
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Impossibile valutare le promozioni.");
    }
  }

  if (action === "availability") {
    try {
      const date = url.searchParams.get("date") ?? todayIso();
      // BROWSER mode (the "Disponibilità" modal — legacy range/summary params):
      // service_ids as IDS + optional staff_id, per-day months/days payload.
      const rangeParam = String(url.searchParams.get("range") ?? "").trim().toLowerCase();
      if (rangeParam) {
        const browserServiceIds = parseIdList(url.searchParams.get("service_ids") ?? "");
        if (!browserServiceIds.length) return jsonError("Parametri mancanti.", 400);
        const browserLocationId = await resolveManageLocationId({
          slug: tenantSlug,
          raw: url.searchParams.get("location_id"),
          fallbackCurrent: true,
        }) || null;
        const result = await manageAvailabilityBrowser({
          slug: tenantSlug,
          date,
          range: rangeParam,
          months: Number.parseInt(String(url.searchParams.get("months") ?? "1"), 10) || 1,
          summary: ["1", "true", "yes", "summary"].includes(String(url.searchParams.get("summary") ?? "").trim().toLowerCase()),
          serviceIds: browserServiceIds,
          staffId: Number.parseInt(String(url.searchParams.get("staff_id") ?? "0"), 10) || null,
          locationId: browserLocationId,
          excludeAppointmentId: Number.parseInt(String(url.searchParams.get("exclude_id") ?? "0"), 10) || null,
        });
        return Response.json({ ok: true, sourceMode: "database", months: result.months, range_start: result.rangeStart, range_end: result.rangeEnd });
      }
      const serviceNames = parseServiceNames(url.searchParams);
      const staffName = emptyToNull(url.searchParams.get("staff_name") ?? url.searchParams.get("operator"));
      const locationId = await resolveManageLocationId({
        slug: tenantSlug,
        raw: url.searchParams.get("location_id"),
        fallbackCurrent: true,
      }) || null;
      const context = await publicBookingContext(tenantSlug);
      const serviceIds = resolveServiceIds(context, serviceNames);
      const staffId = resolveStaffId(context, staffName);

      return Response.json({
        ok: true,
        sourceMode: "database",
        date,
        serviceNames,
        staffName,
        locationId,
        serviceIds,
        staffId,
        slots: await publicBookingSlots({ slug: tenantSlug, date, serviceIds, staffId, locationId }),
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore disponibilita appuntamenti.");
    }
  }

  try {
    const date = url.searchParams.get("date") ?? undefined;
    // RANGE list (calendar Week/Month views): when `from`/`to` (YYYY-MM-DD) are
    // sent INSTEAD of a single `date`, list every appointment whose start falls in
    // [from, to) — listDbAppointments already supports the start/end half-open
    // clause. `date` (single day) still takes priority when present (Day view).
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    return Response.json({
      ok: true,
      sourceMode: "database",
      appointments: await listDbAppointments(
        date ? { slug: tenantSlug, date } : { slug: tenantSlug, start: from, end: to },
      ),
      holds: [],
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore appuntamenti.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, ["appointments.manage", "appointments.plan", "appointments.quick_booking"])) return jsonError("Permesso appuntamenti mancante.", 403);

  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const action = String(body.action ?? url.searchParams.get("action") ?? "save");

  try {
    if (action === "hold_availability") {
      const date = String(body.date ?? todayIso());
      const time = String(body.time ?? "");
      const serviceNames = parseServiceNamesFromBody(body);
      const staffName = emptyToNull(String(body.staff_name ?? body.operator ?? ""));
      const locationId = await resolveManageLocationId({
        slug: tenantSlug,
        raw: body.location_id === undefined ? null : String(body.location_id),
        fallbackCurrent: true,
      }) || null;
      const context = await publicBookingContext(tenantSlug);
      const serviceIds = resolveServiceIds(context, serviceNames);
      const staffId = resolveStaffId(context, staffName);
      const hold = await holdPublicBookingSlot({
        slug: tenantSlug,
        date,
        time,
        serviceIds,
        staffId,
        locationId,
        ownerKey: "manage",
        // Legacy backend channel: 5-minute TTL (vs 150s public) — the drawer
        // countdown starts at 5:00.
        channel: "backend",
      });

      return Response.json({ ok: true, sourceMode: "database", ...hold });
    }

    // "Registra gift" (port of the legacy action=fidelity_gift_redeem): redeem a
    // whole gift INSTANCE of the client against an existing appointment. gift_idx
    // optional (auto-picks the first available instance). Legacy error messages.
    if (action === "fidelity_gift_redeem") {
      const clientId = Number.parseInt(String(body.client_id ?? "0"), 10) || 0;
      const appointmentId = Number.parseInt(String(body.appointment_id ?? "0"), 10) || 0;
      if (clientId <= 0 || appointmentId <= 0) return jsonError("Dati mancanti", 400);
      const giftIdx = body.gift_idx === undefined || body.gift_idx === null || String(body.gift_idx) === ""
        ? null
        : Number.parseInt(String(body.gift_idx), 10) || 0;
      try {
        const result = await fidelityGiftRedeemForAppointment({
          slug: tenantSlug,
          clientId,
          appointmentId,
          giftIdx,
          createdBy: session.user.id ?? null,
        });
        return Response.json({ ok: true, points_used: result.pointsUsed, available_points: result.availablePoints });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Operazione non riuscita");
      }
    }

    // Reorder two adjacent segments of a multi-servizio booking (port of the
    // legacy action=swap_segment): position + time windows swap, staff/cabin
    // re-validated on the new ranges. Errors carry the exact legacy messages.
    if (action === "swap_segment") {
      const id = Number.parseInt(String(body.id ?? "0"), 10) || 0;
      const segmentId = Number.parseInt(String(body.segment_id ?? "0"), 10) || 0;
      if (id <= 0 || segmentId <= 0) return jsonError("Dati mancanti", 400);
      const direction = String(body.direction ?? "").trim();
      if (direction !== "up" && direction !== "down") return jsonError("Direzione non valida", 400);
      try {
        await swapDbAppointmentSegment(tenantSlug, id, segmentId, direction);
        return Response.json({ ok: true });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Errore durante l'aggiornamento della prenotazione.");
      }
    }

    if (action === "release_hold") {
      const token = String(body.appointment_hold_token ?? body.token ?? "");
      const released = await releasePublicBookingHold({ slug: tenantSlug, token, ownerKey: "manage" });
      return Response.json({ ok: released, sourceMode: "database" });
    }

    if (action === "renew_hold") {
      const token = String(body.appointment_hold_token ?? body.token ?? "");
      const hold = await renewPublicBookingHold({ slug: tenantSlug, token, ownerKey: "manage" });
      return Response.json({ ok: true, sourceMode: "database", ...hold });
    }

    // PIANIFICA (calendar Block 3) — recurring/planned appointments. Port of
    // app/pages/appointments_plan.php (?page=appointments_plan). plan_preview builds
    // the recurrence date set + per-date slot search and returns the OK/Saltato
    // table; plan_create re-runs the same search (never trusting the client),
    // creates the new client if needed, and createDbAppointment for each OK date.
    // Both gated on appointments.plan / appointments.manage (the legacy page's
    // permission), stricter than the POST umbrella which also admits quick_booking.
    if (action === "plan_preview" || action === "plan_create") {
      if (!canAny(session.user.perms, ["appointments.plan", "appointments.manage"])) {
        return jsonError("Permesso pianificazione appuntamenti mancante.", 403);
      }
      const planLocationId = await resolveManageLocationId({
        slug: tenantSlug,
        raw: body.location_id === undefined ? null : String(body.location_id),
        fallbackCurrent: true,
      }) || null;
      try {
        if (action === "plan_preview") {
          const preview = await planPreview(tenantSlug, body, planLocationId);
          return Response.json({ sourceMode: "database", ...preview });
        }
        const result = await planCreate(tenantSlug, body, planLocationId);
        return Response.json({
          sourceMode: "database",
          ...result,
          appointments: await listDbAppointments({ slug: tenantSlug }),
        });
      } catch (error) {
        // Validation / no-slot throws -> 200 { ok:false, error } so the planner UI
        // surfaces the message inline (matching the status/cancel_done paths).
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore pianificazione." });
      }
    }

    // DELETE — per-row "Elimina" (app/pages/appointments.php ~79-130) + bulk_delete
    // (~292-520). Deleting RESTORES every redeem the appointment consumed and removes
    // its child rows (see deleteDbAppointment). Gated on appointments.manage (the
    // legacy delete/bulk_delete is a management action), stricter than the POST
    // umbrella check above which also admits plan/quick_booking.
    if (action === "delete" || action === "bulk_delete") {
      if (!can(session.user.perms, "appointments.manage")) {
        return jsonError("Permesso eliminazione appuntamenti mancante.", 403);
      }

      // Collect the target ids. `delete` takes a single id (body/query); `bulk_delete`
      // takes `ids` as an array or a CSV string (mirrors the legacy `ids` POST field).
      const ids: number[] = [];
      const pushId = (raw: unknown) => {
        const id = Number.parseInt(String(raw).trim(), 10);
        if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id);
      };
      if (action === "delete") {
        pushId(body.id ?? url.searchParams.get("id") ?? "0");
      } else {
        const rawIds = body.ids ?? url.searchParams.get("ids") ?? "";
        if (Array.isArray(rawIds)) rawIds.forEach(pushId);
        else String(rawIds).split(",").forEach(pushId);
      }
      if (ids.length === 0) {
        return Response.json({ ok: false, error: "Nessun appuntamento selezionato." }, { status: 400 });
      }

      // Best-effort per id: a row that is not the tenant's / already gone returns
      // false and is simply not counted. deleteDbAppointment THROWS the legacy guard
      // ("La prenotazione deve essere in stato Annullato...") for a non-cancelled
      // appointment: the single delete surfaces it as the API error (faithful to
      // api_appointments.php action=delete); the bulk skips those rows and reports.
      let deleted = 0;
      let guardError = "";
      for (const id of ids) {
        try {
          if (await deleteDbAppointment(tenantSlug, id)) {
            deleted += 1;
            // Pulizia righe promemoria pending orfane (il cron le ignorerebbe
            // ma resterebbero pending per sempre).
            await automationClearPendingReminders(tenantSlug, id);
          }
        } catch (error) {
          guardError = error instanceof Error ? error.message : "Eliminazione non consentita.";
          if (action === "delete") return jsonError(guardError);
        }
      }

      if (deleted === 0 && guardError) return jsonError(guardError);
      return Response.json({
        ok: true,
        sourceMode: "database",
        deleted,
        skipped: ids.length - deleted,
        appointments: await listDbAppointments({ slug: tenantSlug }),
      });
    }

    if (action === "status") {
      const id = Number.parseInt(String(body.id ?? "0"), 10);
      // The status select (drawer + calendar) sends the PHP CODE
      // (pending|scheduled|done|canceled|no_show). We must NOT route it through
      // normalizeAppointmentStatus: that maps to the 3-value UI type and DEFAULTS
      // every unknown key (scheduled/canceled/no_show) to "In attesa" -> pending,
      // so those three statuses would never be settable. Instead derive the target
      // PHP status directly via appointmentPhpStatus (the phpStatus path the DB
      // write uses), and validate the raw input first so empty/garbage is rejected
      // with a clear error rather than silently defaulting to scheduled.
      const rawStatus = String(body.status ?? "").trim();
      if (!isRecognizedStatusInput(rawStatus)) {
        return Response.json({ ok: false, error: "Stato prenotazione non valido." }, { status: 400 });
      }
      // Capture the prior PHP status BEFORE the write so we can map the
      // transition (pending->scheduled = 'approved', pending->canceled =
      // 'rejected') to the lifecycle email, matching the legacy PHP callers.
      const oldPhpStatus = await getDbAppointmentPhpStatus(tenantSlug, id);
      // The real target PHP status (all five codes settable now that we bypass the
      // 3-state normalizeAppointmentStatus). Used by the guards, the email mapping,
      // and the redeem restore below.
      const newPhpStatus = appointmentPhpStatus(rawStatus);
      // Transition guards — port of api_appointments.php:10225-10233. Once an
      // appointment is canceled/no_show it is no longer editable; a 'done'
      // appointment cannot be reverted to other states from this screen (a
      // done -> canceled/no_show has to go through the dedicated cancel-done flow).
      // These run BEFORE the DB write (and before any redeem restore).
      if (oldPhpStatus === "canceled" || oldPhpStatus === "no_show") {
        return Response.json({ ok: false, error: "La prenotazione annullata non è più modificabile." });
      }
      if (oldPhpStatus === "done" && newPhpStatus !== "done") {
        return Response.json({
          ok: false,
          error:
            newPhpStatus === "canceled" || newPhpStatus === "no_show"
              ? "Per annullare una prenotazione eseguita usa il popup dedicato di annullamento."
              : "Una prenotazione eseguita non può essere riportata ad altri stati da questa schermata.",
        });
      }
      // RESERVED-MODE CANCEL: in the legacy EVERY cancel goes through
      // appt_lifecycle_cancel_done_apply (there is no bare status->canceled write), which
      // restores the reserved holds AND stamps cancelled_at/cancelled_by (+ the default
      // backend reason). Delegate a pending/scheduled -> canceled/no_show transition to
      // the same apply (cancelDoneAppointment, 'reserved' mode) so the metadata is
      // stamped no matter which caller used action=status. done->cancel is already
      // blocked above (popup only), terminal statuses too — no double-restore possible.
      const transitioningToCancel = newPhpStatus === "canceled" || newPhpStatus === "no_show";
      const appointment =
        transitioningToCancel && (oldPhpStatus === "pending" || oldPhpStatus === "scheduled")
          ? await cancelDoneAppointment(tenantSlug, id, newPhpStatus, session.user.id)
          : // Pass the raw code through: updateDbAppointmentStatus applies phpStatus(), so
            // all five statuses persist correctly (the bug was upstream, not here). The
            // appointment ROW is kept on cancel (legacy keeps canceled appointments).
            await updateDbAppointmentStatus(tenantSlug, id, rawStatus);
      // FIDELITY EARN-on-done (port of Fidelity::handleAppointmentStatusChange, the EARN
      // side): only when the booking actually crosses INTO 'done' (newPhpStatus==='done' &&
      // oldPhpStatus!=='done'), settle the reserved fidelity — award the earned points
      // (tagged source_type='appointment'/source_id=id so a later cancel-done storno can
      // reverse them) + stamp appointments.fidelity_points_earned, and settle any reserved
      // redeem. Idempotent + best-effort: the helper swallows its own errors and the .catch
      // here guarantees a fidelity problem NEVER fails the status change. The done->other
      // storno is the dedicated cancel-done flow (a later step), not this call.
      if (newPhpStatus === "done" && oldPhpStatus !== "done") {
        await awardAppointmentFidelityOnDone(tenantSlug, id, session.user.id).catch(() => undefined);
        // OMAGGI (F12): al 'done' PRIMA si riscatta la selezione in sospeso
        // (Gifts::redeemAppointmentSelectionIfAny — transazioni 'redeem' +
        // redeemed_at sulle righe, chiusura istanza a residuo 0), POI si
        // registrano gli eventi di maturazione (le righe riscattate da omaggio
        // sono residuali e vengono escluse dal tracking).
        await giftRedeemAppointmentSelectionIfAny(tenantSlug, id, session.user.id).catch(() => undefined);
        await giftRecordAppointmentDone(tenantSlug, id).catch(() => undefined);
      }
      // Port of automation_send_email('approved'|'rejected', id): fire AFTER the
      // DB write, gated on emailConfigured() + the kind's toggle (all handled
      // inside the helper). Errors are swallowed there so a delivery problem
      // never fails the status API; the response shape is unchanged.
      if (oldPhpStatus) {
        const kind = lifecycleKindForStatusChange(oldPhpStatus, newPhpStatus);
        if (kind) await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: id, kind });
      }
      // Port di automation_handle_status_change: (ri)schedula i promemoria se
      // il nuovo stato e' prenotato, altrimenti cancella le righe pending.
      await automationScheduleReminder(tenantSlug, id);
      return Response.json({ ok: true, sourceMode: "database", appointment, appointments: await listDbAppointments({ slug: tenantSlug }) });
    }

    // CANCEL-DONE — the dedicated annullamento flow for an EXECUTED ('done')
    // appointment (port of api_appointments.php action='cancel_done_apply' ->
    // app/lib/AppointmentLifecycle.php appt_lifecycle_cancel_done_apply, ~867). The
    // plain action=status path BLOCKS done->canceled/no_show ("usa il popup dedicato
    // di annullamento") because settling a done booking consumed redeems AND awarded
    // fidelity points; this action runs cancelDoneAppointment, which RESTORES all of
    // that (package/prepaid/giftbox/gift/giftcard + fidelity earn/redeem + credit) and
    // then flips the status. Gated on appointments.manage (a storno is a management
    // action, like delete/bulk_delete — stricter than the POST umbrella check above).
    // On the validation throw (e.g. the row is not 'done') we mirror the status path:
    // return { ok:false, error } with a 200 so the UI shows the message inline.
    if (action === "cancel_done") {
      if (!can(session.user.perms, "appointments.manage")) {
        return jsonError("Permesso annullamento appuntamenti mancante.", 403);
      }
      const id = Number.parseInt(String(body.id ?? url.searchParams.get("id") ?? "0"), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return Response.json({ ok: false, error: "ID mancante" }, { status: 400 });
      }
      // Target status: default 'canceled'; 'no_show' is the only other accepted target
      // (cancelDoneAppointment re-validates this and rejects anything else).
      const rawTarget = String(body.status ?? body.target_status ?? "canceled").trim();
      const targetStatus = appointmentPhpStatus(rawTarget) === "no_show" ? "no_show" : "canceled";
      // Operator's cancellation motivation (optional, max 255 — persisted to
      // appointments.cancelled_reason by cancelDoneAppointment; mirrors the legacy apply).
      const reason = String(body.reason ?? "").trim().slice(0, 255);
      try {
        // Capture the REAL old status before the apply: this action now serves both
        // modes (done = 'executed', pending/scheduled = 'reserved'), and the lifecycle
        // email kind depends on the transition (e.g. pending->canceled = 'rejected').
        const oldPhpStatus = (await getDbAppointmentPhpStatus(tenantSlug, id)) ?? "done";
        const appointment = await cancelDoneAppointment(tenantSlug, id, targetStatus, session.user.id, reason);
        // OMAGGI (F12): l'annullo di un eseguito invalida gli eventi appointment_done
        // e fa regredire l'eventuale maturazione ottenuta con quell'appuntamento.
        if (oldPhpStatus === "done") await giftInvalidateSource(tenantSlug, "appointment", id).catch(() => undefined);
        // Lifecycle email: same transition mapping the status path fires; gated +
        // error-swallowed inside the helper.
        const kind = lifecycleKindForStatusChange(oldPhpStatus, targetStatus);
        if (kind) await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: id, kind });
        // Annullo: lo stato non e' piu' prenotato, la schedule fa da clear
        // (port di automation_clear_pending_reminders sul cancel).
        await automationScheduleReminder(tenantSlug, id);
        return Response.json({
          ok: true,
          sourceMode: "database",
          appointment,
          appointments: await listDbAppointments({ slug: tenantSlug }),
        });
      } catch (error) {
        // Validation errors (not done / not found / bad target) -> 200 { ok:false }
        // so the UI surfaces the message inline, matching the action=status path.
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore annullamento." });
      }
    }

    // Calendar drag/move (port of api_appointments.php action='move'). A move only
    // changes the slot — new date/time and, in the staff-columns view, optionally the
    // operator (and location). Client/service/notes are preserved by re-feeding the
    // existing snapshot to updateDbAppointment, which recomputes the end from the
    // service duration (so the visible duration is preserved on a move). The legacy
    // accepts full `starts_at`/`ends_at` datetimes; we accept the same plus the
    // lighter `date`+`time`, deriving date/time from `starts_at` when only that is sent.
    if (action === "move") {
      const id = Number.parseInt(String(body.id ?? "0"), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return Response.json({ ok: false, error: "Dati mancanti" }, { status: 400 });
      }

      // Resolve the new slot: prefer explicit date/time, else split a MySQL/ISO
      // `starts_at` ("YYYY-MM-DD HH:MM[:SS]" or with a 'T") into date + HH:MM.
      const startsAt = String(body.starts_at ?? "");
      const slot = parseStartsAt(startsAt);
      const date = String(body.date ?? slot.date ?? "");
      const time = String(body.time ?? slot.time ?? "");
      if (!date || !time) {
        return Response.json({ ok: false, error: "Data/ora non valida" }, { status: 400 });
      }

      // Tenant-scoped snapshot of the preserved fields (+ current status). A null
      // snapshot means the row is not the tenant's / does not exist.
      const snapshot = await getDbAppointmentMoveSnapshot(tenantSlug, id);
      if (!snapshot) {
        return Response.json({ ok: false, error: "Appuntamento non trovato." }, { status: 400 });
      }
      // Legacy guard: only pending/scheduled appointments are movable from the calendar.
      if (snapshot.phpStatus !== "pending" && snapshot.phpStatus !== "scheduled") {
        return Response.json({ ok: false, error: "La prenotazione non e modificabile da calendario." }, { status: 400 });
      }

      // Operator: an explicit staff_name/operator (staff-columns drag between columns)
      // overrides; an empty string clears the assignment; omitted keeps the current one.
      const hasStaffParam = body.staff_name !== undefined || body.operator !== undefined;
      const operator = hasStaffParam ? String(body.staff_name ?? body.operator ?? "") : snapshot.operator;

      // Legacy guard (calendar.js:4961): a multi-service (segmented) booking's operator
      // cannot be changed via drag & drop — it must be edited from the appointment form.
      if (hasStaffParam && operator !== snapshot.operator && (await getDbAppointmentSegmentCount(tenantSlug, id)) > 1) {
        return Response.json({ ok: false, error: "Per cambiare operatore su prenotazioni multi-servizio, modifica l'appuntamento (non tramite drag & drop)." });
      }

      // Location: an explicit location_id resolves to the tenant location; otherwise
      // keep the appointment's current location.
      const locationId = body.location_id === undefined
        ? snapshot.locationId
        : (await resolveManageLocationId({ slug: tenantSlug, raw: String(body.location_id), fallbackCurrent: true })) || null;

      const before = await getDbAppointmentCustomerVisibleSnapshot(tenantSlug, id);
      const appointment = await updateDbAppointment({
        slug: tenantSlug,
        id,
        clientName: snapshot.clientName,
        serviceName: snapshot.serviceName,
        operator,
        time,
        date,
        locationId,
        staffNotes: snapshot.staffNotes,
        customerNotes: snapshot.customerNotes,
      });

      // Fire the 'modified' email only when a customer-visible field actually changed
      // (date/time will change on a move), mirroring the save edit path. Gated +
      // error-swallowed inside the helper, so a delivery problem never fails the move.
      if (before) {
        const after = await getDbAppointmentCustomerVisibleSnapshot(tenantSlug, id);
        if (after && appointmentCustomerVisibleChanged(before, after)) {
          await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: id, kind: "modified" });
        }
      }

      // Il nuovo orario sposta anche la scheduled_at dei promemoria pending.
      await automationScheduleReminder(tenantSlug, id);

      return Response.json({
        ok: true,
        sourceMode: "database",
        appointment,
        appointments: await listDbAppointments({ slug: tenantSlug }),
      });
    }

    // RESIZE (duration change, port of the calendar bottom-edge resize). Unlike
    // `move`/`save` — which route through updateDbAppointment and recompute ends_at
    // from the SERVICE duration — resize persists a CUSTOM duration: it writes the
    // dragged end time DIRECTLY (appointments.ends_at + the trailing segment's
    // ends_at), keeping the start fixed. Tenant-scoped, pending/scheduled only, and
    // reuses the same operator-overlap conflict check (resizeDbAppointmentEnd).
    if (action === "resize") {
      const id = Number.parseInt(String(body.id ?? "0"), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return Response.json({ ok: false, error: "Dati mancanti" }, { status: 400 });
      }

      // The new end: prefer an explicit HH:MM `time`/`end_time`, else split a MySQL/
      // ISO `ends_at` ("YYYY-MM-DD HH:MM[:SS]" or with a 'T") into its HH:MM.
      const endsAt = String(body.ends_at ?? "");
      const endTime = String(body.end_time ?? body.time ?? parseStartsAt(endsAt).time ?? "");
      if (!endTime) {
        return Response.json({ ok: false, error: "Ora di fine non valida" }, { status: 400 });
      }

      // Legacy guard (calendar.js:5016): a multi-service (segmented) booking cannot be
      // resized from the calendar — its duration is governed by the per-service segments.
      if ((await getDbAppointmentSegmentCount(tenantSlug, id)) > 1) {
        return Response.json({ ok: false, error: "Ridimensionamento non supportato per prenotazioni multi-servizio (segmentate)." });
      }

      const appointment = await resizeDbAppointmentEnd(tenantSlug, id, endTime);
      if (!appointment) {
        return Response.json({ ok: false, error: "Appuntamento non trovato." }, { status: 400 });
      }

      // No lifecycle email on resize: the end time is NOT part of the compact
      // customer-visible snapshot (date/time/service names), so a pure duration
      // change is never a customer-visible change — matching the move path, which
      // only emails when date/time actually move.

      // La durata non sposta l'inizio, ma il legacy rischedula comunque a ogni
      // edit dell'appuntamento.
      await automationScheduleReminder(tenantSlug, id);

      return Response.json({
        ok: true,
        sourceMode: "database",
        appointment,
        appointments: await listDbAppointments({ slug: tenantSlug }),
      });
    }

    // save action. A positive integer `id` edits an EXISTING appointment
    // (updateDbAppointment); a missing/zero id creates a new one
    // (createDbAppointment, unchanged). On creation no lifecycle email fires
    // (legacy parity). On edit, the legacy 'modified' email
    // (automation_send_email('modified', id) via
    // automation_handle_customer_visible_change) fires AFTER a successful update
    // when a customer-visible field (date/time/service names) changed.
    const editId = Number.parseInt(String(body.id ?? "0"), 10);
    const isEdit = Number.isFinite(editId) && editId > 0;
    const operator = String(body.staff_name ?? body.operator ?? "");
    const locationId = await resolveManageLocationId({
      slug: tenantSlug,
      raw: body.location_id === undefined ? null : String(body.location_id),
      fallbackCurrent: true,
    }) || null;
    const date = String(body.date ?? todayIso());
    const holdToken = emptyToNull(String(body.appointment_hold_token ?? body.hold_token ?? ""));

    // MULTI-SERVICE: the drawer may send `service_ids` (ordered, robust) and/or
    // `service_names` (ordered array or comma-joined string), plus per-service
    // `staff_map` / `cabin_map` (serviceId -> staffId / cabinId) and an explicit
    // `cabin_id`. We prefer `service_ids` (resolving them to names against the
    // tenant context so createDbAppointment can resolve them by name as before),
    // falling back to `service_names`. When no multi-service data is present we
    // fall back to the single `service_name` (single-service path unchanged).
    const staffMap = parseIdMap(body.staff_map);
    const cabinMap = parseIdMap(body.cabin_map);
    const explicitCabinId = parseOptionalId(body.cabin_id);
    const serviceIds = parseIdList(body.service_ids);
    // Quick-booking PACKAGE redeem (#qb_package_redeem JSON array): per-service
    // requests to cover a service with the client's prepaid package. Parsed here,
    // re-validated + consumed server-side inside createDbAppointment (never trusted).
    const packageRedeems = parsePackageRedeem(body.package_redeem);
    const packageWarnings: string[] = [];
    // Quick-booking PREPAID-SERVICE redeem (#qb_prepaid_service_redeem JSON array):
    // per-service requests to cover a service with the client's prepaid-service
    // balance. Parsed here, re-validated + consumed server-side inside
    // createDbAppointment (never trusted). A service already covered by a package
    // redeem is skipped there (one service is covered once).
    const prepaidRedeems = parsePrepaidRedeem(body.prepaid_service_redeem);
    const prepaidWarnings: string[] = [];
    // Quick-booking GIFTCARD redeem (#qb_giftcard_redeem JSON array): an
    // APPOINTMENT-LEVEL request to apply the client's giftcard BALANCE (a monetary
    // amount) toward the appointment. Parsed here, re-validated + clamped + the
    // giftcard decremented server-side inside createDbAppointment (never trusted).
    const giftcardRedeems = parseGiftcardRedeem(body.giftcard_redeem);
    const giftcardWarnings: string[] = [];
    // Quick-booking GIFTBOX redeem (#qb_giftbox_redeem JSON array): per-service requests
    // to cover a service with ONE ITEM from the client's giftbox (a per-service item is
    // consumed, the service is zero-charged). Parsed here, re-validated + the redemption
    // recorded server-side inside createDbAppointment (never trusted). A service already
    // covered by a package OR prepaid redeem is skipped there (one service is covered once).
    const giftboxRedeems = parseGiftboxRedeem(body.giftbox_redeem);
    const giftboxWarnings: string[] = [];
    // Quick-booking GIFT (omaggio) redeem (#qb_gift_redeem JSON array): per-service requests
    // to cover a service with ONE REWARD from the client's gift (a service reward is a free
    // service; one reward unit is consumed, the service is zero-charged). Parsed here,
    // re-validated + the redemption recorded server-side inside createDbAppointment (never
    // trusted). A service already covered by a package, prepaid OR giftbox redeem is skipped
    // there (one service is covered once).
    const giftRedeems = parseGiftRedeem(body.gift_redeem);
    const giftWarnings: string[] = [];
    let serviceNames = parseServiceNamesFromBody(body);
    if (serviceIds.length > 0) {
      // `service_ids` is unambiguous (no comma-in-name issue) so it wins when sent.
      const context = await publicBookingContext(tenantSlug);
      serviceNames = serviceIds
        .map((id) => context.services.find((svc) => svc.id === id)?.name ?? "")
        .filter(Boolean);
      if (serviceNames.length !== serviceIds.length) throw new Error("Servizio non trovato o non prenotabile.");
    }
    // Primary service name kept for the single-service fallback (first selected).
    const serviceName = serviceNames[0] ?? String(body.service_name ?? body.service ?? "");

    const dbAppointmentInput = {
      slug: tenantSlug,
      // Prefer the drawer's selected client id (#qb_client_id) over the name so the save
      // binds to the exact client — name resolution alone mis-binds when clients share a name.
      clientId: parseOptionalId(body.client_id),
      clientName: String(body.client_name ?? body.client ?? ""),
      serviceName,
      serviceNames,
      staffMap,
      cabinMap,
      cabinId: explicitCabinId,
      operator,
      time: String(body.time ?? ""),
      date,
      locationId,
      holdToken,
      staffNotes: emptyToNull(String(body.staff_notes ?? "")),
      customerNotes: emptyToNull(String(body.customer_notes ?? body.notes ?? "")),
      // Respected on create (normalized; default pending). updateDbAppointment
      // ignores it — status edits go through action=status.
      status: body.status ? String(body.status) : undefined,
      // Manual SCONTO from the quick-booking price panel (#qb_discount_type /
      // #qb_discount_value). Threaded into create/updateDbAppointment (the appointments
      // table has discount_type/discount_value columns); each clamps it the same way the
      // drawer's recompute does. Empty type => no discount. Mirrors how `status` is threaded.
      discountType: body.discount_type ? String(body.discount_type) : undefined,
      discountValue: body.discount_value === undefined ? undefined : String(body.discount_value),
      // Block 4 price-panel deductions from the drawer. fidelity_points_use = the points the
      // staff chose to REDEEM (reserved on the row; settled -points_redeem on done by
      // awardAppointmentFidelityOnDone). credit_use = the customer CREDIT applied (debited from
      // the wallet at create; refunded on cancel via restoreAppointmentRedeems). coupon_code/
      // coupon_discount = the applied coupon (embedded into appointments.notes since the table
      // has no coupon columns). All re-validated/clamped server-side inside create/update.
      fidelityPointsUsed: body.fidelity_points_use === undefined ? undefined : Math.max(0, Math.round(Number(body.fidelity_points_use) || 0)),
      creditUsed: body.credit_use === undefined ? undefined : Math.max(0, Number(body.credit_use) || 0),
      couponCode: body.coupon_code === undefined ? undefined : String(body.coupon_code ?? ""),
      couponDiscount: body.coupon_discount === undefined ? undefined : Math.max(0, Number(body.coupon_discount) || 0),
      packageRedeems,
      packageWarnings,
      prepaidRedeems,
      prepaidWarnings,
      giftcardRedeems,
      giftcardWarnings,
      giftboxRedeems,
      giftboxWarnings,
      giftRedeems,
      giftWarnings,
    };

    let appointment;
    if (isEdit) {
      // Snapshot the customer-visible fields BEFORE the write so we can detect a
      // customer-visible change afterwards (a null snapshot means the row is not
      // ours / does not exist — updateDbAppointment then throws the same guard).
      const before = await getDbAppointmentCustomerVisibleSnapshot(tenantSlug, editId);
      appointment = await updateDbAppointment({ ...dbAppointmentInput, id: editId });
      // Fire the 'modified' email only when a customer-visible field changed,
      // mirroring automation_handle_customer_visible_change. The helper is gated
      // on emailConfigured() + the modified toggle and swallows every error, so a
      // delivery problem never fails the save API and the response is unchanged.
      if (before) {
        const after = await getDbAppointmentCustomerVisibleSnapshot(tenantSlug, editId);
        if (after && appointmentCustomerVisibleChanged(before, after)) {
          await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: editId, kind: "modified" });
        }
      }
    } else {
      appointment = await createDbAppointment(dbAppointmentInput);
    }

    // Port di automation_schedule_reminder sui trigger create/edit: schedula i
    // promemoria email/SMS (solo per stato prenotato; per pending non fa nulla
    // e su un edit che cambia orario aggiorna la scheduled_at).
    const savedApptId = isEdit ? editId : Number((appointment as { id?: number } | null)?.id ?? 0);
    if (savedApptId > 0) await automationScheduleReminder(tenantSlug, savedApptId);

    return Response.json({
      ok: true,
      sourceMode: "database",
      appointment,
      appointments: await listDbAppointments({ slug: tenantSlug }),
      // Per-redeem skip messages (e.g. package not covering a service / exhausted):
      // the booking still succeeds (legacy best-effort parity); the drawer may show them.
      ...(packageWarnings.length > 0 ? { packageWarnings } : {}),
      // Per-prepaid-redeem skip messages (prepaid not covering / exhausted / already
      // covered by a package): same best-effort parity; the drawer may show them.
      ...(prepaidWarnings.length > 0 ? { prepaidWarnings } : {}),
      // GiftCard-redeem skip messages (not the client's / expired / no balance /
      // nothing payable / clamped to 0): same best-effort parity; drawer may show them.
      ...(giftcardWarnings.length > 0 ? { giftcardWarnings } : {}),
      // GiftBox-redeem skip messages (not the client's / expired / item not covering /
      // exhausted / already covered by a package/prepaid): same best-effort parity.
      ...(giftboxWarnings.length > 0 ? { giftboxWarnings } : {}),
      // Gift (omaggio) redeem skip messages (not the client's / not available / expired /
      // reward not covering / exhausted / already covered by a package/prepaid/giftbox):
      // same best-effort parity; the drawer may show them.
      ...(giftWarnings.length > 0 ? { giftWarnings } : {}),
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Errore appuntamenti.",
      },
      { status: 400 },
    );
  }
}

// Split a "starts_at" datetime ("YYYY-MM-DD HH:MM[:SS]" or "...THH:MM...") into a
// local date (YYYY-MM-DD) and HH:MM time. Used by the calendar move action so the
// legacy `starts_at` payload still works alongside the lighter date+time payload.
function parseStartsAt(value: string): { date: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(value.trim());
  if (!m) return { date: "", time: "" };
  return { date: m[1], time: m[2] };
}

// Whether `body.status` is a RECOGNIZED appointment status for action=status —
// one of the five PHP codes (pending|scheduled|done|canceled|no_show) or their
// Italian labels (the labels the status <select> shows + the legacy spellings
// phpStatus accepts). phpStatus() itself can't validate: it DEFAULTS every
// unknown key to 'scheduled', so we gate empty/garbage here before deriving the
// target, rather than silently coercing an invalid value to scheduled.
const RECOGNIZED_STATUS_INPUTS = new Set<string>([
  // pending
  "pending", "waiting", "in attesa",
  // scheduled
  "scheduled", "prenotato", "confermato", "confirmed",
  // done (note: the "Eseguito" select LABEL submits the code "done", so the
  // label spelling itself need not be accepted; only phpStatus-mapped values are).
  "done", "completed", "completato",
  // canceled
  "canceled", "cancelled", "annullato",
  // no_show
  "no_show", "no show",
]);

function isRecognizedStatusInput(raw: string): boolean {
  return RECOGNIZED_STATUS_INPUTS.has(raw.trim().toLowerCase());
}

function parseServiceNames(params: URLSearchParams): string[] {
  const serviceName = params.get("service_name") ?? params.get("service");
  const serviceNames = params.get("service_names");

  if (serviceNames) {
    return serviceNames
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [serviceName ?? ""].filter(Boolean);
}

function parseServiceNamesFromBody(body: Record<string, unknown>): string[] {
  const raw = body.service_names ?? body.service_name ?? body.service ?? "";
  // Tolerate a JSON/array of names or a comma-joined string.
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Parse an ordered list of positive integer ids from an array, a JSON string, or
// a comma-joined string ("3,7" / [3,7] / "[3,7]"). Preserves order, drops
// non-positive/duplicate ids (mirrors the legacy unique_int_list_preserve_order).
function parseIdList(raw: unknown): number[] {
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
  const parts = Array.isArray(source)
    ? source
    : String(source ?? "").split(",");
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const id = Number.parseInt(String(part).trim(), 10);
    if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// Parse a serviceId -> id map (staff_map / cabin_map). Tolerates a JSON object
// ({"3":7}), a plain object, or "sid:val" pairs joined by comma/semicolon
// ("3:7,8:2") — the shapes the legacy parse_staff_map / parse_cabin_map accept.
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
      // "sid:val" pairs separated by comma or semicolon.
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

// Parse an optional positive integer id (cabin_id); returns null when absent/0.
function parseOptionalId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const id = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// Parse the quick-booking `package_redeem` payload — a JSON array (or already an
// array) of { client_package_id, service_id, client_package_service_id? } items —
// into AppointmentPackageRedeem[]. Mirrors assets/js/app.js qbReadPackageRedeem:
// items missing a positive client_package_id or service_id are dropped, and a
// service is kept at most once (first wins) since one service is covered by one
// package. The real validation (ownership/active/coverage/sessions) happens
// server-side in applyAppointmentPackageRedeems — this only shapes the input.
function parsePackageRedeem(raw: unknown): AppointmentPackageRedeem[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const out: AppointmentPackageRedeem[] = [];
  const seenService = new Set<number>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const clientPackageId = Number.parseInt(String(entry.client_package_id ?? ""), 10);
    const serviceId = Number.parseInt(String(entry.service_id ?? ""), 10);
    if (!Number.isFinite(clientPackageId) || clientPackageId <= 0) continue;
    if (!Number.isFinite(serviceId) || serviceId <= 0) continue;
    if (seenService.has(serviceId)) continue;
    seenService.add(serviceId);
    const rawItemId = Number.parseInt(String(entry.client_package_service_id ?? ""), 10);
    out.push({
      clientPackageId,
      serviceId,
      clientPackageServiceId: Number.isFinite(rawItemId) && rawItemId > 0 ? rawItemId : null,
    });
  }
  return out;
}

// Parse the quick-booking `prepaid_service_redeem` payload — a JSON array (or
// already an array) of { client_prepaid_service_id, service_id } items — into
// AppointmentPrepaidRedeem[]. Mirrors assets/js/app.js qbReadPrepaidServiceRedeem
// (and parseRequestBody stringifies body values, so the drawer sends this as a JSON
// STRING, handled here): items missing a positive client_prepaid_service_id or
// service_id are dropped, and a service is kept at most once (first wins) since one
// service is covered by one prepaid. The real validation (ownership/active/coverage/
// remaining) happens server-side in applyAppointmentPrepaidRedeems — this only
// shapes the input. Also accepts the legacy `prepaid_service_id`/`id` aliases.
function parsePrepaidRedeem(raw: unknown): AppointmentPrepaidRedeem[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const out: AppointmentPrepaidRedeem[] = [];
  const seenService = new Set<number>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const clientPrepaidServiceId = Number.parseInt(
      String(entry.client_prepaid_service_id ?? entry.prepaid_service_id ?? entry.id ?? ""),
      10,
    );
    const serviceId = Number.parseInt(String(entry.service_id ?? ""), 10);
    if (!Number.isFinite(clientPrepaidServiceId) || clientPrepaidServiceId <= 0) continue;
    if (!Number.isFinite(serviceId) || serviceId <= 0) continue;
    if (seenService.has(serviceId)) continue;
    seenService.add(serviceId);
    out.push({ clientPrepaidServiceId, serviceId });
  }
  return out;
}

// Parse the quick-booking `giftcard_redeem` payload — a JSON array (or already an
// array) of { giftcard_id, amount } items — into AppointmentGiftcardRedeem[]. Mirrors
// assets/js/app.js #qb_giftcard_redeem (and parseRequestBody stringifies body values,
// so the drawer sends this as a JSON STRING, handled here). GiftCard is
// APPOINTMENT-LEVEL + MONETARY: one giftcard, one amount (NOT per-service). Items
// missing a positive giftcard_id are dropped; the amount is coerced to a non-negative
// number (the real clamp to min(balance, payableTotal) happens server-side in
// applyAppointmentGiftcardRedeem — this only shapes the input). Also accepts the
// legacy `id` alias for the giftcard id and `used_amount`/`used` aliases for the
// amount (qbOpenGiftcardInfo passes usedAmount).
function parseGiftcardRedeem(raw: unknown): AppointmentGiftcardRedeem[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const out: AppointmentGiftcardRedeem[] = [];
  const seen = new Set<number>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const giftcardId = Number.parseInt(String(entry.giftcard_id ?? entry.id ?? ""), 10);
    if (!Number.isFinite(giftcardId) || giftcardId <= 0) continue;
    if (seen.has(giftcardId)) continue; // dedupe a giftcard (one per appointment anyway)
    seen.add(giftcardId);
    const amount = Number.parseFloat(
      String(entry.amount ?? entry.used_amount ?? entry.used ?? "").replace(",", "."),
    );
    out.push({ giftcardId, amount: Number.isFinite(amount) && amount > 0 ? amount : 0 });
  }
  return out;
}

// Parse the quick-booking `giftbox_redeem` payload — a JSON array (or already an array)
// of { instance_id, giftbox_item_id, service_id } items — into AppointmentGiftboxRedeem[].
// Mirrors assets/js/app.js #qb_giftbox_redeem (and parseRequestBody stringifies body
// values, so the drawer sends this as a JSON STRING, handled here). GiftBox is per-service
// + ITEM-based: one giftbox item covers one service. Items missing a positive instance_id,
// giftbox_item_id or service_id are dropped, and a service is kept at most once (first
// wins) since one service is covered by one item. The real validation (ownership/issued/
// not expired/coverage/residual) happens server-side in applyAppointmentGiftboxRedeems —
// this only shapes the input.
function parseGiftboxRedeem(raw: unknown): AppointmentGiftboxRedeem[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const out: AppointmentGiftboxRedeem[] = [];
  const seenService = new Set<number>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const instanceId = Number.parseInt(String(entry.instance_id ?? ""), 10);
    const giftboxItemId = Number.parseInt(String(entry.giftbox_item_id ?? ""), 10);
    const serviceId = Number.parseInt(String(entry.service_id ?? ""), 10);
    if (!Number.isFinite(instanceId) || instanceId <= 0) continue;
    if (!Number.isFinite(giftboxItemId) || giftboxItemId <= 0) continue;
    if (!Number.isFinite(serviceId) || serviceId <= 0) continue;
    if (seenService.has(serviceId)) continue;
    seenService.add(serviceId);
    out.push({ instanceId, giftboxItemId, serviceId });
  }
  return out;
}

// Parse the quick-booking `gift_redeem` payload — a JSON array (or already an array) of
// { instance_id, reward_item_index, service_id } items — into AppointmentGiftRedeem[].
// Mirrors assets/js/app.js #qb_gift_redeem (and parseRequestBody stringifies body values,
// so the drawer sends this as a JSON STRING, handled here). A GIFT is per-service +
// REWARD-based: one reward (a free service) covers one service. Items missing a positive
// instance_id or service_id are dropped (reward_item_index defaults to 0 when not finite,
// parity with qbReadGiftRedeem), and a service is kept at most once (first wins) since one
// service is covered by one reward. The real validation (ownership/availability/coverage/
// residual) happens server-side in applyAppointmentGiftRedeems — this only shapes the input.
function parseGiftRedeem(raw: unknown): AppointmentGiftRedeem[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const out: AppointmentGiftRedeem[] = [];
  const seenService = new Set<number>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const instanceId = Number.parseInt(String(entry.instance_id ?? ""), 10);
    const serviceId = Number.parseInt(String(entry.service_id ?? ""), 10);
    const rawIndex = Number.parseInt(String(entry.reward_item_index ?? ""), 10);
    if (!Number.isFinite(instanceId) || instanceId <= 0) continue;
    if (!Number.isFinite(serviceId) || serviceId <= 0) continue;
    const rewardItemIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : 0;
    if (seenService.has(serviceId)) continue;
    seenService.add(serviceId);
    out.push({ instanceId, rewardItemIndex, serviceId });
  }
  return out;
}

function resolveServiceIds(context: PublicBookingContext, serviceNames: string[]): number[] {
  const normalizedNames = serviceNames.map((name) => normalizeLookup(name)).filter(Boolean);
  const matched = context.services.filter((service) => normalizedNames.includes(normalizeLookup(service.name)));
  if (matched.length !== normalizedNames.length) throw new Error("Servizio non trovato o non prenotabile.");
  return matched.map((service) => service.id);
}

function resolveStaffId(context: PublicBookingContext, staffName: string | null): number | null {
  const normalizedName = normalizeLookup(staffName ?? "");
  if (!normalizedName) return null;
  const staff = context.staff.find((item) => normalizeLookup(item.name) === normalizedName);
  if (!staff) throw new Error("Operatore non trovato.");
  return staff.id;
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}
