import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { businessTodayIso } from "@/lib/business-datetime";
import { commissionDbSummary, listDbCommissions, markDbCommissionPaid } from "@/lib/db-repositories";
import {
  buildCommissionDashboard,
  getCommissionSettings,
  markCommissionEntryPaid,
  saveCommissionSettings,
  setCommissionModuleEnabled,
  type CommissionStaffSettingInput,
} from "@/lib/manage-commissions";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";

// Current-month [start, end] as 'YYYY-MM-DD' strings (default dashboard range).
// Mese di ROMA (classe TZ server-safe: new Date() locale del server sbaglierebbe
// mese nella finestra 00:00-02:00 di inizio mese su un server UTC).
function currentMonthRange(): { from: string; to: string } {
  const [y, m] = businessTodayIso().split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "commissions.manage")) return jsonError("Permesso commissioni mancante.", 403);

  const url = new URL(request.url);

  try {
    // Settings tab (Impostazioni operatori): the module toggle + per-operator rate config.
    if (url.searchParams.get("action") === "settings") {
      return Response.json({ ok: true, sourceMode: "database", settings: await getCommissionSettings(tenantSlug) });
    }

    // Default GET: the commission dashboard — accrue+persist POS entries in the
    // requested range, reconcile stale snapshots, then return entries + summaries.
    const range = currentMonthRange();
    const from = (url.searchParams.get("from") || "").trim() || range.from;
    const to = (url.searchParams.get("to") || "").trim() || range.to;
    const staffId = parseInteger(url.searchParams.get("staff_id"), 0);
    const source = url.searchParams.get("source") || "all";
    const locationId = parseInteger(url.searchParams.get("location_id"), 0);

    const dashboard = await buildCommissionDashboard(tenantSlug, { from, to, staffId, source, locationId });
    return Response.json({
      ok: true,
      sourceMode: "database",
      dashboard,
      // Il bottone "Nuova prenotazione" dell'empty-state legacy è gated dal permesso
      // Quick Booking (commissions.php $commissionCanQuickBook).
      canQuickBook: can(session.user.perms, "appointments.quick_booking"),
      // Keep the legacy keys so the pre-existing consumers don't break until the
      // report block adapts to `dashboard`.
      summary: await commissionDbSummary(tenantSlug),
      commissions: await listDbCommissions(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore commissioni.");
  }
}

// Parse the settings rows map (nested per-staff config) from a JSON string body field — nested so it
// survives parseRequestBody (which flattens a top-level object to "[object Object]").
function parseCommissionRows(raw: unknown): Record<string, CommissionStaffSettingInput> {
  let src: unknown = raw;
  if (typeof src === "string") {
    try { src = JSON.parse(src); } catch { return {}; }
  }
  if (!src || typeof src !== "object") return {};
  return src as Record<string, CommissionStaffSettingInput>;
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "commissions.manage")) return jsonError("Permesso commissioni mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "pay";

  try {
    if (action === "pay") {
      const id = parseInteger(body.id);
      const commission = await markDbCommissionPaid(id, tenantSlug);
      return Response.json({
        ok: true,
        source: "commissions?action=pay",
        sourceMode: "database",
        commission,
        summary: await commissionDbSummary(tenantSlug),
        commissions: await listDbCommissions(tenantSlug),
      });
    }

    // Settings tab writes: the global module toggle + per-operator rate config.
    if (action === "save_module_settings" || action === "save_module") {
      const enabled = ["1", "true", "yes", "on"].includes(String(body.module_enabled ?? body.enabled ?? "").toLowerCase());
      return Response.json({ ok: true, sourceMode: "database", settings: await setCommissionModuleEnabled(tenantSlug, enabled, session.user.id) });
    }

    if (action === "save_commission_settings" || action === "save_settings") {
      const settings = await saveCommissionSettings(tenantSlug, parseCommissionRows(body.rows ?? body.rows_json), session.user.id);
      return Response.json({ ok: true, sourceMode: "database", settings });
    }

    // Toggle an accrued entry's paid status by entry_key (throws if cancelled),
    // then return the refreshed dashboard for the requested range.
    if (action === "toggle_commission_paid") {
      const entryKey = String(body.entry_key ?? "").trim();
      const markPaid = ["1", "true", "yes", "on"].includes(String(body.mark_paid ?? "").toLowerCase());
      // Modello A: commissioni tenant-wide (nessun filtro-sede) -> [] = tutte le sedi.
      await markCommissionEntryPaid(tenantSlug, entryKey, markPaid, session.user.id, []);
      const range = currentMonthRange();
      const from = String(body.from ?? "").trim() || range.from;
      const to = String(body.to ?? "").trim() || range.to;
      const staffId = parseInteger(body.staff_id, 0);
      const source = String(body.source ?? "all") || "all";
      const locationId = parseInteger(body.location_id, 0);
      const dashboard = await buildCommissionDashboard(tenantSlug, { from, to, staffId, source, locationId });
      return Response.json({ ok: true, sourceMode: "database", dashboard });
    }

    return jsonError("Azione commissioni non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore commissioni.");
  }
}
