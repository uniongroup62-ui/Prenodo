import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import {
  calendarContext,
  deleteCalendarNote,
  getCalendarDayStaffOrder,
  listCalendarNotes,
  saveCalendarNote,
  setCalendarDayStaffOrder,
} from "@/lib/manage-calendar";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { staffUnavailabilityForDate } from "@/lib/public-booking-db";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  if (!can(activeUser.perms, "calendar.view")) return jsonError("Permesso negato.", 403);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "context";
  const date = url.searchParams.get("date") ?? undefined;
  const start = url.searchParams.get("start") ?? undefined;
  const end = url.searchParams.get("end") ?? undefined;

  try {
    if (action === "notes" || action === "list_notes" || action === "list") {
      const payload = await listCalendarNotes({
        slug: tenantSlug,
        start: start ?? date ?? todayIsoLocal(),
        end: end ?? addDays(start ?? date ?? todayIsoLocal(), 1),
      });
      return Response.json({
        ok: true,
        total: payload.notes.length,
        count_by_date: payload.countByDate,
        notes: payload.notes,
      });
    }

    if (action === "get_calendar_day_staff_order") {
      return Response.json({
        ok: true,
        order: await getCalendarDayStaffOrder(tenantSlug, activeUser.id),
      });
    }

    const context = await calendarContext({
      slug: tenantSlug,
      userId: activeUser.id,
      userEmail: activeUser.email,
      userName: activeUser.name,
      date,
      start,
      end,
    });
    // Per-staff grey unavailability bands for the Day (staff columns) view —
    // port of the legacy include_unavailability=1 (off-shift + time-off clipped
    // to the store's open intervals). Best-effort: never blocks the context.
    const locationParam = Number.parseInt(String(url.searchParams.get("location_id") ?? "0"), 10) || null;
    const staffUnavailability = date
      ? await staffUnavailabilityForDate(tenantSlug, date, locationParam).catch(() => [])
      : [];
    return Response.json({
      ok: true,
      sourceMode: "database",
      ...context,
      staffUnavailability,
      // Permessi come il legacy (calendar.php:7-8 -> config canManage/canCreate):
      // manage = drag/resize/click-edit/note-write; quick_booking = crea da slot.
      // Il client li usa per gatare le affordance (sola-lettura senza manage).
      canManageAppointments: can(activeUser.perms, "appointments.manage"),
      canCreateAppointments: can(activeUser.perms, "appointments.quick_booking"),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Calendario non disponibile.", 400);
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  if (!can(activeUser.perms, "calendar.view")) return jsonError("Permesso negato.", 403);

  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const action = String(body.action ?? url.searchParams.get("action") ?? "note_save");

  try {
    if (action === "note_save" || action === "save") {
      // Scrittura note: SOLO appointments.manage come il legacy
      // (api_calendar_notes.php:19 Auth::can('appointments.manage')).
      if (!can(activeUser.perms, "appointments.manage")) {
        return jsonError("Permesso Appuntamenti richiesto.", 403);
      }
      const note = await saveCalendarNote({
        slug: tenantSlug,
        id: parseInteger(body.id, 0),
        noteDate: body.note_date ?? body.noteDate ?? "",
        title: body.title ?? "",
        noteText: body.note_text ?? body.noteText ?? "",
        userId: activeUser.id,
      });
      return Response.json({ ok: true, note });
    }

    if (action === "note_delete" || action === "delete") {
      // Scrittura note: SOLO appointments.manage come il legacy
      // (api_calendar_notes.php:19 Auth::can('appointments.manage')).
      if (!can(activeUser.perms, "appointments.manage")) {
        return jsonError("Permesso Appuntamenti richiesto.", 403);
      }
      await deleteCalendarNote({ slug: tenantSlug, id: parseInteger(body.id, 0) });
      return Response.json({ ok: true });
    }

    if (action === "set_calendar_day_staff_order") {
      const order = await setCalendarDayStaffOrder(tenantSlug, activeUser.id, body.order ?? "[]");
      return Response.json({ ok: true, order });
    }

    return jsonError("Azione calendario non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore calendario.", 400);
  }
}

function todayIsoLocal(): string {
  return dateIsoLocal(new Date());
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return dateIsoLocal(next);
}

function dateIsoLocal(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
