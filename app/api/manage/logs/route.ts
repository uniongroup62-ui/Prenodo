// API della pagina "Log" (registro attività, feature approvata 2026-07-16).
// SOLO ADMIN (come la pagina Ruoli): il registro rivela le azioni di tutti gli
// operatori. Due viste: activity (30 giorni, activity_logs) e deletions
// (eliminazioni clienti PERMANENTI da client_deletion_logs — la motivazione
// obbligatoria del delete vive lì e serve anche mesi dopo).
import { jsonError } from "@/lib/api-utils";
import { listActivityLogs, ACTIVITY_LOG_PAGE_SIZE } from "@/lib/activity-log";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { tenantSelect, tenantTable, tableExists, type RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (String(session.user.role ?? "").toLowerCase() !== "admin") return jsonError("Accesso negato.", 403);

  const url = new URL(request.url);
  const view = String(url.searchParams.get("view") ?? "activity");
  const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  try {
    if (view === "deletions") {
      // Registro PERMANENTE delle eliminazioni clienti.
      const table = await tenantTable(tenantSlug, "client_deletion_logs");
      if (!(await tableExists(table.name))) {
        return Response.json({ ok: true, sourceMode: "database", rows: [], totalCount: 0, pageSize: ACTIVITY_LOG_PAGE_SIZE, currentPage: 1 });
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

    const list = await listActivityLogs(tenantSlug, {
      module: url.searchParams.get("module") ?? "",
      action: url.searchParams.get("action") ?? "",
      userLabel: url.searchParams.get("user") ?? "",
      q: url.searchParams.get("q") ?? "",
      page,
    });
    return Response.json({ ok: true, sourceMode: "database", ...list });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore log attività.");
  }
}
