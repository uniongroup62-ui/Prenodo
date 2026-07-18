import { logActivity } from "@/lib/activity-log";
import { businessNowDateTime } from "@/lib/business-datetime";
import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { renderCostsPdf } from "@/lib/cost-pdf";
import { currentManageSession } from "@/lib/manage-auth";
import {
  deactivateCostCategoriesBulk,
  deleteCost,
  deleteCostCategoriesBulk,
  deleteCostCategory,
  deleteCostsBulk,
  getManageCost,
  getManageCostsContext,
  saveCost,
  saveCostCategory,
  toggleCostCategory,
  toggleCostPaid,
} from "@/lib/manage-costs";
import { getManageLocationContext, resolveManageLocationId } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const workPerms = ["costs.manage", "costs.items"];

// "Tutte le sedi" (all_locations): filtro/scope su TUTTE le sedi permesse dell'utente invece
// della sola sede corrente (port del checkbox legacy $costAllLocations).
function isAllLocations(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}
async function allowedLocationIds(slug: string): Promise<number[]> {
  return (await getManageLocationContext(slug)).locations.map((l) => l.id).filter((id) => id > 0);
}

// FAIL-CLOSED sedi revocate (classe 18/07, come rate/list/report): in un tenant
// CON sedi, nessuna sede risolta (modalità singola) o nessuna sede autorizzata
// (modalità Tutte-le-sedi con lista vuota) = sessione stantia/revocata — la
// route non deve mai degradare a scope-0 tenant-wide (getCostById senza
// clausola sede: lettura E mutazione di costi di qualunque sede).
async function costsScopeFailClosed(slug: string, locationId: number, allowedIds: number[] | null): Promise<boolean> {
  const noScope = allowedIds !== null ? allowedIds.length === 0 : locationId <= 0;
  if (!noScope) return false;
  return (await getManageLocationContext(slug)).allLocations.length > 0;
}

// Parse the bulk cost-id selection. parseRequestBody flattens body values to strings, so cost_ids
// arrives as a JSON array string ("[1,2,3]") or a comma-separated list ("1,2,3") — accept both.
function parseCostIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((v) => parseInteger(v, 0)).filter((n) => n > 0);
  const s = String(raw ?? "").trim();
  if (!s) return [];
  let parsed: unknown = s;
  if (s.startsWith("[")) {
    try { parsed = JSON.parse(s); } catch { parsed = s; }
  }
  if (Array.isArray(parsed)) return parsed.map((v) => parseInteger(v, 0)).filter((n) => n > 0);
  return s.split(",").map((v) => parseInteger(v, 0)).filter((n) => n > 0);
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);
  if (!canAny(session.user.perms, [...workPerms, "costs.categories"])) return jsonError("Permesso negato.", 403);

  try {
    const url = new URL(request.url);

    // Edit-form prefill: return ONE cost's editable fields for one id. Port of
    // costs.php action=edit. Gated by the same Scadenziario work permission as
    // the save action.
    if (url.searchParams.get("action") === "get") {
      if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      const costId = parseInteger(url.searchParams.get("id"), 0);
      if (costId <= 0) return jsonError("ID costo mancante.");
      // SCOPE SEDE anche sul prefill di modifica: un costo di altra sede -> "Costo non trovato".
      // In "Tutte le sedi" lo scope e' l'insieme delle sedi permesse.
      const getScopeLocationId = await resolveManageLocationId({ slug: tenantSlug, raw: url.searchParams.get("location_id"), fallbackCurrent: true });
      const getAllowed = isAllLocations(url.searchParams.get("all_locations")) ? await allowedLocationIds(tenantSlug) : null;
      if (await costsScopeFailClosed(tenantSlug, getScopeLocationId, getAllowed)) return jsonError("Costo non trovato.", 404);
      const cost = await getManageCost(tenantSlug, costId, getScopeLocationId, getAllowed);
      if (!cost) return jsonError("Costo non trovato.", 404);
      return Response.json({ ok: true, source: "costs?action=get", sourceMode: "database", cost });
    }

    const locationId = await resolveManageLocationId({
      slug: tenantSlug,
      raw: url.searchParams.get("location_id"),
      fallbackCurrent: true,
    });
    const listAllowed = isAllLocations(url.searchParams.get("all_locations")) ? await allowedLocationIds(tenantSlug) : null;
    if (await costsScopeFailClosed(tenantSlug, locationId, listAllowed)) {
      return Response.json({ ok: true, sourceMode: "database", costs: [], categories: [], suppliers: [], locations: [], summary: null, filters: {}, activeLocationId: 0, failClosed: true });
    }
    const context = await getManageCostsContext(tenantSlug, {
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      query: url.searchParams.get("q") ?? "",
      categoryId: parseInteger(url.searchParams.get("category_id") ?? url.searchParams.get("cat"), 0),
      locationId,
      allLocations: isAllLocations(url.searchParams.get("all_locations")),
    });

    // EXPORT CSV/PDF — port di costs.php action=export (tab scadenziario): stessi
    // filtri della lista, filename scadenziario_costi_<Ymd_His>.<ext>.
    if (url.searchParams.get("action") === "export") {
      if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      const format = String(url.searchParams.get("format") ?? "csv").toLowerCase() === "pdf" ? "pdf" : "csv";
      // Timestamp filename/PDF in ORA DI ROMA (classe TZ server-safe).
      const nowRome = businessNowDateTime(); // "YYYY-MM-DD HH:MM:SS"
      const now = new Date(nowRome.replace(" ", "T"));
      const stamp = nowRome.replace(/[-:]/g, "").replace(" ", "_");
      const fileBase = "scadenziario_costi";
      const showLocation = context.locations.length > 0;
      const locationLabel = context.activeLocationId > 0
        ? context.locations.find((l) => l.id === context.activeLocationId)?.name ?? `Sede #${context.activeLocationId}`
        : "Tutte le sedi";

      if (format === "csv") {
        const csv = buildCostsCsv(context, showLocation);
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fileBase}_${stamp}.csv"`,
            Pragma: "no-cache",
            Expires: "0",
          },
        });
      }

      const pdf = await renderCostsPdf({
        rows: context.costs,
        summary: context.summary,
        filters: context.filters,
        locationLabel: showLocation ? locationLabel : "",
        showLocationColumn: showLocation,
        generatedAt: now,
      });
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileBase}_${stamp}.pdf"`,
          "Content-Length": String(pdf.length),
        },
      });
    }

    return Response.json(context);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Scadenziario non caricato.");
  }
}

// CSV legacy: BOM UTF-8 per Excel, delimitatore ';', header fisso, importi
// "1.234,56", date d/m/Y, "Pagato il" d/m/Y H:i, Ricorrente Si/No, poi riga
// vuota + righe Totali/Scaduti/In scadenza/Pagati sulle colonne Residuo/Pagato.
function buildCostsCsv(context: Awaited<ReturnType<typeof getManageCostsContext>>, showLocation: boolean): string {
  // number_format($n, 2, ',', '.') — manuale: il toLocaleString server-side può
  // omettere il raggruppamento migliaia a seconda dell'ICU disponibile.
  const money = (n: number) => {
    const value = Number.isFinite(n) ? n : 0;
    const [int, dec] = Math.abs(value).toFixed(2).split(".");
    return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
  };
  const dmy = (d: string) => {
    const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };
  const dmyhi = (d: string) => {
    const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
  };
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (cells: string[]) => cells.map(esc).join(";");

  const header = ["Scadenza", "Titolo"];
  if (showLocation) header.push("Sede");
  header.push("Categoria", "Fornitore", "Totale", "Pagato", "Residuo", "IVA %", "Stato", "Pagato il", "Metodo", "Doc n.", "Data doc", "Ricorrente", "Note");

  const lines = [line(header)];
  for (const r of context.costs) {
    const statusTxt = r.isPaid ? "Pagato" : r.status === "overdue" ? "Scaduto" : "Da pagare";
    const row = [dmy(r.dueDate), r.title];
    if (showLocation) row.push(r.locationName || "");
    row.push(
      r.categoryName || "",
      r.supplierName || "",
      money(r.amount),
      money(r.paidAmount),
      money(r.remainingAmount),
      r.vatPercent === null ? "" : String(r.vatPercent).replace(".", ","),
      statusTxt,
      r.isPaid ? dmyhi(r.paidAt) : "",
      r.paymentMethod || "",
      r.docNumber || "",
      dmy(r.docDate),
      r.isRecurring ? "Si" : "No",
      r.notes || "",
    );
    lines.push(line(row));
  }

  const blank = header.map(() => "");
  const residueIdx = header.indexOf("Residuo");
  const paidIdx = header.indexOf("Pagato");
  const totalRow = [...blank]; totalRow[0] = "Totali";
  const overdueRow = [...blank]; overdueRow[0] = "Scaduti"; if (residueIdx >= 0) overdueRow[residueIdx] = money(context.summary.overdueAmount);
  const dueRow = [...blank]; dueRow[0] = "In scadenza"; if (residueIdx >= 0) dueRow[residueIdx] = money(context.summary.dueAmount);
  const paidRow = [...blank]; paidRow[0] = "Pagati"; if (paidIdx >= 0) paidRow[paidIdx] = money(context.summary.paidAmount);
  lines.push(line([]), line(totalRow), line(overdueRow), line(dueRow), line(paidRow));

  return "\uFEFF" + lines.join("\n") + "\n";
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  try {
    const body = await parseRequestBody(request);
    const url = new URL(request.url);
    const action = String(body.action ?? url.searchParams.get("action") ?? "save_cost");
    const locationId = await resolveManageLocationId({
      slug: tenantSlug,
      raw: body.location_id === undefined ? url.searchParams.get("location_id") : body.location_id,
      fallbackCurrent: true,
    });
    // "Tutte le sedi": in questa modalita' le mutazioni sono scopate all'insieme delle sedi
    // permesse (non alla sola sede corrente), cosi' un costo visibile nella vista "tutte" e'
    // anche gestibile. null = modalita' singola sede.
    const allowedIds = isAllLocations(body.all_locations ?? url.searchParams.get("all_locations")) ? await allowedLocationIds(tenantSlug) : null;
    // FAIL-CLOSED sedi revocate sulle azioni SUI COSTI (le categorie sono
    // tenant-wide senza sede e restano fuori dalla guardia).
    const costActions = new Set(["create", "save", "save_cost", "cost_save", "delete", "cost_delete", "bulk_delete", "bulk_delete_costs", "pay", "toggle_paid", "cost_toggle_paid"]);
    if (costActions.has(String(action)) && await costsScopeFailClosed(tenantSlug, locationId, allowedIds)) {
      return jsonError("Sede non valida o non autorizzata");
    }

    switch (action) {
      case "create":
      case "save":
      case "save_cost":
      case "cost_save":
        if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      {
        // Log DOPO il successo (le lib THROWANO su errore → il catch sotto
        // risponde senza voce). Titolo nella label; id 0 sulle create (il save
        // non espone l'id creato).
        const saveEditId = parseInteger(body.id ?? body.cost_id, 0);
        const result = await saveCost(tenantSlug, { ...body, location_id: body.location_id || String(locationId) }, locationId, allowedIds);
        const costTitle = String(body.title ?? "").trim().slice(0, 120);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: saveEditId > 0 ? "modifica" : "crea", entityType: "cost", entityId: saveEditId, label: `${saveEditId > 0 ? "Modificato" : "Creato"} costo "${costTitle}"` });
        return Response.json(result);
      }

      case "delete":
      case "cost_delete":
        if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      {
        const delId = parseInteger(body.id ?? body.cost_id, 0);
        const result = await deleteCost(tenantSlug, delId, locationId, allowedIds);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: "elimina", entityType: "cost", entityId: delId, label: `Eliminato costo #${delId}` });
        return Response.json(result);
      }

      case "bulk_delete":
      case "bulk_delete_costs":
        if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      {
        const bulkIds = parseCostIds(body.cost_ids ?? body.ids);
        const result = await deleteCostsBulk(tenantSlug, bulkIds, locationId, allowedIds);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: "elimina", entityType: "cost", entityId: bulkIds[0] ?? 0, label: bulkIds.length === 1 ? `Eliminato costo #${bulkIds[0]}` : `Eliminati ${bulkIds.length} costi`, details: { ids: bulkIds } });
        return Response.json(result);
      }

      case "pay":
      case "toggle_paid":
      case "cost_toggle_paid":
        if (!canAny(session.user.perms, workPerms)) return jsonError("Permesso Scadenziario richiesto.", 403);
      {
        const toggleId = parseInteger(body.id ?? body.cost_id, 0);
        const result = await toggleCostPaid(tenantSlug, toggleId, locationId, allowedIds);
        // Stato POST-toggle per la label (query minima dopo il successo).
        const paidRow = await tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "costs", columns: "is_paid", where: "id = ?", params: [toggleId], limit: 1 }).catch(() => [] as RowDataPacket[]);
        const nowPaid = Number(paidRow[0]?.is_paid ?? 0) === 1;
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: nowPaid ? "paga" : "modifica", entityType: "cost", entityId: toggleId, label: `Costo #${toggleId} segnato ${nowPaid ? "pagato" : "da pagare"}` });
        return Response.json(result);
      }

      case "save_category":
      case "category_save":
      case "cost_category_save":
        if (!can(session.user.perms, "costs.categories")) return jsonError("Permesso Categorie costi richiesto.", 403);
      {
        const catEditId = parseInteger(body.id ?? body.category_id, 0);
        const result = await saveCostCategory(tenantSlug, body);
        const catName = String(body.name ?? "").trim().slice(0, 120);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: catEditId > 0 ? "modifica" : "crea", entityType: "cost_category", entityId: catEditId, label: `${catEditId > 0 ? "Modificata" : "Creata"} categoria costi "${catName}"` });
        return Response.json(result);
      }

      case "delete_category":
      case "category_delete":
      case "cost_category_delete":
        if (!can(session.user.perms, "costs.categories")) return jsonError("Permesso Categorie costi richiesto.", 403);
      {
        const catDelId = parseInteger(body.id ?? body.category_id, 0);
        const result = await deleteCostCategory(tenantSlug, catDelId);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: "elimina", entityType: "cost_category", entityId: catDelId, label: `Eliminata categoria costi #${catDelId}` });
        return Response.json(result);
      }

      case "toggle_category":
      case "category_toggle":
        if (!can(session.user.perms, "costs.categories")) return jsonError("Permesso Categorie costi richiesto.", 403);
      {
        const catToggleId = parseInteger(body.id ?? body.category_id, 0);
        const result = await toggleCostCategory(tenantSlug, catToggleId);
        const catRow = await tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "cost_categories", columns: "is_active", where: "id = ?", params: [catToggleId], limit: 1 }).catch(() => [] as RowDataPacket[]);
        const nowActive = Number(catRow[0]?.is_active ?? 0) === 1;
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: nowActive ? "riattiva" : "disattiva", entityType: "cost_category", entityId: catToggleId, label: `Categoria costi #${catToggleId} ${nowActive ? "attivata" : "disattivata"}` });
        return Response.json(result);
      }

      case "bulk_deactivate_categories":
        if (!can(session.user.perms, "costs.categories")) return jsonError("Permesso Categorie costi richiesto.", 403);
      {
        const catIds = parseCostIds(body.category_ids ?? body.ids);
        const result = await deactivateCostCategoriesBulk(tenantSlug, catIds);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: "disattiva", entityType: "cost_category", entityId: catIds[0] ?? 0, label: `Disattivate ${catIds.length} categorie costi`, details: { ids: catIds } });
        return Response.json(result);
      }

      case "bulk_delete_categories":
        if (!can(session.user.perms, "costs.categories")) return jsonError("Permesso Categorie costi richiesto.", 403);
      {
        const catDelIds = parseCostIds(body.category_ids ?? body.ids);
        const result = await deleteCostCategoriesBulk(tenantSlug, catDelIds);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "costi", action: "elimina", entityType: "cost_category", entityId: catDelIds[0] ?? 0, label: `Eliminate ${catDelIds.length} categorie costi`, details: { ids: catDelIds } });
        return Response.json(result);
      }

      default:
        return jsonError("Azione costi non supportata.", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione costi non riuscita.");
  }
}
