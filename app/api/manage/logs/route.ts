// API della pagina "Log" (registro attività, feature approvata 2026-07-16).
// Accesso a PERMESSI (rivisto su richiesta 2026-07-16): logs.view sblocca la
// vista attività (per un NON-admin filtrata alle SUE sedi + voci senza sede,
// Modello A) e il sotto-permesso logs.deletions la vista Eliminazioni clienti
// PERMANENTE (client_deletion_logs — la motivazione obbligatoria del delete
// vive lì). L'admin ha entrambi impliciti (allAssignablePermissions).
import { jsonError } from "@/lib/api-utils";
import { listActivityLogs, ACTIVITY_LOG_PAGE_SIZE } from "@/lib/activity-log";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import { tenantSelect, tenantTable, tableExists, type RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const isAdmin = String(session.user.role ?? "").toLowerCase() === "admin";
  const views = {
    activity: isAdmin || can(session.user.perms, "logs.view"),
    deletions: isAdmin || can(session.user.perms, "logs.deletions"),
  };
  if (!views.activity && !views.deletions) return jsonError("Accesso negato.", 403);

  const url = new URL(request.url);
  const view = String(url.searchParams.get("view") ?? "activity");
  const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  try {
    if (view === "deletions") {
      if (!views.deletions) return Response.json({ ok: false, error: "Accesso negato.", views }, { status: 403 });
      // Registro PERMANENTE delle eliminazioni clienti.
      const table = await tenantTable(tenantSlug, "client_deletion_logs");
      if (!(await tableExists(table.name))) {
        return Response.json({ ok: true, sourceMode: "database", views, rows: [], totalCount: 0, pageSize: ACTIVITY_LOG_PAGE_SIZE, currentPage: 1 });
      }
      const [rows, countRows] = await Promise.all([
        tenantSelect<RowDataPacket>({
          slug: tenantSlug,
          table: "client_deletion_logs",
          orderBy: "deleted_at DESC, id DESC",
          limit: ACTIVITY_LOG_PAGE_SIZE,
          offset: (page - 1) * ACTIVITY_LOG_PAGE_SIZE,
        }),
        tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "client_deletion_logs", columns: "COUNT(*) AS n" }),
      ]);
      // Etichetta operatore (deleted_by -> users), snapshot-tollerante: se
      // l'utente non esiste più resta '#id'.
      const byIds = Array.from(new Set(rows.map((r) => Number(r.deleted_by ?? 0) || 0).filter((n) => n > 0)));
      const labels = new Map<number, string>();
      if (byIds.length > 0) {
        const userRows = await tenantSelect<RowDataPacket>({
          slug: tenantSlug,
          table: "users",
          columns: "id, name, email",
          where: `id IN (${byIds.map(() => "?").join(",")})`,
          params: byIds,
        }).catch(() => [] as RowDataPacket[]);
        for (const u of userRows) {
          const label = String(u.name ?? "").trim() || String(u.email ?? "").trim();
          if (label) labels.set(Number(u.id) || 0, label);
        }
      }
      const localOrEmpty = (v: unknown): string => {
        if (!v) return "";
        if (v instanceof Date) {
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
        }
        return String(v).slice(0, 19).replace("T", " ");
      };
      return Response.json({
        ok: true,
        sourceMode: "database",
        views,
        rows: rows.map((r) => ({
          id: Number(r.id) || 0,
          deletedAt: localOrEmpty(r.deleted_at),
          deletedByLabel: labels.get(Number(r.deleted_by ?? 0) || 0) ?? (Number(r.deleted_by ?? 0) > 0 ? `#${Number(r.deleted_by)}` : "—"),
          clientNames: String(r.client_names ?? ""),
          reason: String(r.reason ?? ""),
          deletedCount: Number(r.deleted_count ?? 0) || 0,
          stockRestoreMode: String(r.stock_restore_mode ?? ""),
          summary: String(r.summary_json ?? ""),
        })),
        totalCount: Number(countRows[0]?.n ?? 0) || 0,
        pageSize: ACTIVITY_LOG_PAGE_SIZE,
        currentPage: page,
      });
    }

    if (!views.activity) return Response.json({ ok: false, error: "Accesso negato.", views }, { status: 403 });
    // FAIL-CLOSED (audit giro 3): non-admin con lista sedi VUOTA (sessione
    // degradata) — la sentinella []=admin avrebbe aperto il log tenant-wide.
    if (String(session.user.role ?? "").toLowerCase() !== "admin" && (session.user.locationIds ?? []).length === 0) {
      const locationContext = await getManageLocationContext(tenantSlug);
      if (locationContext.allLocations.length > 0) {
        return Response.json({ ok: true, sourceMode: "database", views, rows: [], modules: [], actions: [], users: [], totalCount: 0, pageSize: 25, currentPage: 1 });
      }
    }
    const list = await listActivityLogs(tenantSlug, {
      module: url.searchParams.get("module") ?? "",
      action: url.searchParams.get("action") ?? "",
      userLabel: url.searchParams.get("user") ?? "",
      q: url.searchParams.get("q") ?? "",
      page,
      // Non-admin: solo le voci delle sue sedi (+ senza sede). [] = admin.
      locationIds: sessionAllowedLocationIds(session),
    });
    return Response.json({ ok: true, sourceMode: "database", views, ...list });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore log attività.");
  }
}
