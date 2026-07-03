import { jsonError, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, tenantSelect, tenantUpdate } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PREFERENZE UTENTE — port di api_user_prefs.php: le preferenze vivono come
// colonne JSON su `users` (NESSUNA tabella user_prefs):
// - calendar_day_staff_order: ordine colonne operatore nella vista giorno del
//   calendario (array di id interi positivi unici, max 200) — perm calendar.view;
// - browser_notification_preferences: toggle notifiche browser per
//   quotes/installments/birthdays/fidelity_cards (appointments SEMPRE attivo,
//   "locked") — perm notifications.view. Risposte JSON identiche al legacy.

const CONFIGURABLE_NOTIF_KEYS = ["quotes", "installments", "birthdays", "fidelity_cards"] as const;

function normalizeOrder(raw: unknown): number[] {
  let source: unknown = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = raw.split(",");
    }
  }
  const list = Array.isArray(source) ? source : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const id = Number.parseInt(String(item), 10);
    if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      if (out.length >= 200) break;
    }
  }
  return out;
}

function normalizePreferences(raw: unknown): Record<string, boolean> {
  let source: unknown = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = {};
    }
  }
  const obj = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const out: Record<string, boolean> = {};
  for (const key of CONFIGURABLE_NOTIF_KEYS) {
    const value = obj[key];
    out[key] = value === true || value === 1 || value === "1" || value === "true" || value === "on";
  }
  return out;
}

async function loadUserRow(slug: string, userId: number, column: string): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "users",
    columns: `id, ${column}`,
    where: "id = ?",
    params: [userId],
    limit: 1,
  });
  return rows[0] ?? null;
}

function preferencesResponse(prefs: Record<string, boolean>): Record<string, unknown> {
  return {
    ok: true,
    preferences: { appointments: true, ...prefs },
    locked: ["appointments"],
    configurable: [...CONFIGURABLE_NOTIF_KEYS],
  };
}

async function handle(request: Request, method: "GET" | "POST") {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Non autenticato.", 401);
  const userId = Number(session.user.id ?? 0);
  if (userId <= 0) return jsonError("Non autenticato.", 401);

  const url = new URL(request.url);
  const body = method === "POST" ? await parseRequestBody(request) : {};
  const action = String((body as Record<string, unknown>).action ?? url.searchParams.get("action") ?? "");

  try {
    if (action === "get_calendar_day_staff_order" || action === "set_calendar_day_staff_order") {
      if (!can(session.user.perms, "calendar.view")) return jsonError("Permesso negato.", 403);
      if (!(await columnExists("users", "calendar_day_staff_order"))) {
        return jsonError(action.startsWith("get")
          ? "Impossibile leggere la preferenza. Aggiornare lo schema DB."
          : "Impossibile salvare la preferenza. Aggiornare lo schema DB.");
      }
      if (action === "get_calendar_day_staff_order") {
        const row = await loadUserRow(tenantSlug, userId, "calendar_day_staff_order");
        return Response.json({ ok: true, order: normalizeOrder(row?.calendar_day_staff_order) });
      }
      if (method !== "POST") return Response.json({ ok: false, error: "Metodo non consentito." }, { status: 405, headers: { Allow: "POST" } });
      const order = normalizeOrder((body as Record<string, unknown>).order);
      await tenantUpdate({ slug: tenantSlug, table: "users", id: userId, values: { calendar_day_staff_order: JSON.stringify(order) } });
      return Response.json({ ok: true });
    }

    if (action === "get_browser_notification_preferences" || action === "set_browser_notification_preferences") {
      if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso negato.", 403);
      if (!(await columnExists("users", "browser_notification_preferences"))) {
        return jsonError(action.startsWith("get")
          ? "Impossibile leggere le preferenze notifiche. Aggiornare lo schema DB."
          : "Impossibile salvare le preferenze notifiche. Aggiornare lo schema DB.");
      }
      if (action === "get_browser_notification_preferences") {
        const row = await loadUserRow(tenantSlug, userId, "browser_notification_preferences");
        return Response.json(preferencesResponse(normalizePreferences(row?.browser_notification_preferences)));
      }
      if (method !== "POST") return Response.json({ ok: false, error: "Metodo non consentito." }, { status: 405, headers: { Allow: "POST" } });
      const bodyObj = body as Record<string, unknown>;
      // `preferences` (oggetto/JSON) oppure chiavi singole nel POST (legacy).
      const prefs = bodyObj.preferences !== undefined ? normalizePreferences(bodyObj.preferences) : normalizePreferences(bodyObj);
      await tenantUpdate({ slug: tenantSlug, table: "users", id: userId, values: { browser_notification_preferences: JSON.stringify(prefs) } });
      return Response.json(preferencesResponse(prefs));
    }

    return jsonError("Azione non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Azione non valida.", 400);
  }
}

export async function GET(request: Request) {
  return handle(request, "GET");
}

export async function POST(request: Request) {
  return handle(request, "POST");
}
