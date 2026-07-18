import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { searchGiftRecipientClients } from "@/lib/gift-issue-details";
import {
  deleteManageQuoteLegacy,
  getManageQuoteFormData,
  getManageQuotePrintData,
  getManageQuoteViewData,
  getManageQuotesList,
  listDbQuotes,
  quoteNextNumber,
  saveManageQuote,
  sendManageQuoteEmailLegacy,
  type QuoteLocationCtx,
} from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import { columnExists, dbExecute, tenantTable } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Contesto sedi per le funzioni quotes (sedi attive visibili all'utente +
// sede corrente) — port di $quoteLocations/app_current_location_id.
async function quoteLocationCtx(slug: string): Promise<QuoteLocationCtx> {
  const context = await getManageLocationContext(slug);
  return {
    currentLocationId: context.currentLocationId,
    locationIds: context.locations.map((l) => l.id),
    locations: context.locations.map((l) => ({ id: l.id, name: l.name })),
    tenantHasLocations: context.allLocations.length > 0,
  };
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "quotes.manage")) return jsonError("Permesso preventivi mancante.", 403);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") ?? "";

    // Numero progressivo per anno (quotes.php action=next_number).
    if (action === "next_number") {
      const next = await quoteNextNumber(tenantSlug, url.searchParams.get("quote_date") ?? "");
      return Response.json({ ok: true, ...next });
    }

    // Lista legacy con filtri server-side (quotes.php action=list).
    if (action === "list") {
      const ctx = await quoteLocationCtx(tenantSlug);
      // Paginazione 25 (miglioria 2026-07-16): SOLO con ?p= — senza, il
      // comportamento resta storico (LIMIT 300).
      const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 0;
      const list = await getManageQuotesList(tenantSlug, {
        clientId: parseInteger(url.searchParams.get("client_id"), 0),
        status: (url.searchParams.get("status") ?? "").trim(),
        date: (url.searchParams.get("date") ?? "").trim(),
        number: (url.searchParams.get("number") ?? "").trim(),
        allLocations: ["1", "true", "on", "yes", "all"].includes((url.searchParams.get("all_locations") ?? "").trim().toLowerCase()),
        page,
      }, ctx);
      return Response.json({
        ok: true,
        sourceMode: "database",
        ...list,
        currentPage: page >= 1 ? page : 1,
        selectedClientId: String(parseInteger(url.searchParams.get("client_id"), 0)),
        canSettings: can(session.user.perms, "quotes.settings"),
      });
    }

    // Dettaglio legacy completo (quotes.php action=view).
    if (action === "view") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const result = await getManageQuoteViewData(tenantSlug, parseInteger(url.searchParams.get("id"), 0), ctx);
      return Response.json({ ok: true, sourceMode: "database", ...result });
    }

    // Stampa embed-friendly (quotes.php action=print).
    if (action === "print") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const result = await getManageQuotePrintData(tenantSlug, parseInteger(url.searchParams.get("id"), 0), ctx);
      return Response.json({ ok: true, sourceMode: "database", ...result });
    }

    // Ricerca clienti per il combobox filtro (server-side, 2026-07-16): il
    // gate resta quello del modulo (quotes), non serve clients.*.
    if (action === "client_search") {
      const clients = await searchGiftRecipientClients(tenantSlug, url.searchParams.get("q") ?? "");
      return Response.json({ ok: true, clients });
    }

    // Dati form new/edit (quotes.php action=new|edit GET).
    if (action === "form") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const mode = url.searchParams.get("mode") === "edit" ? "edit" : "new";
      const result = await getManageQuoteFormData(tenantSlug, {
        action: mode,
        id: parseInteger(url.searchParams.get("id"), 0),
        locationId: parseInteger(url.searchParams.get("location_id"), 0),
      }, ctx);
      return Response.json({ ok: true, sourceMode: "database", ...result });
    }

    // Feed generico (consumato da notifications_quotes).
    return Response.json({
      ok: true,
      sourceMode: "database",
      quotes: await listDbQuotes(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preventivi.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "quotes.manage")) return jsonError("Permesso preventivi mancante.", 403);

  const body = await parseRequestBody(request);
  const rawBody = body as Record<string, unknown>;
  const action = body.action ?? "create";

  try {
    // "Segna come letto" delle risposte preventivo (port di
    // notifications_quotes.php action=seen / seen_all): stampa
    // customer_decision_seen_at sulle decisioni accettate/rifiutate non ancora
    // lette, filtrate per sede corrente come il legacy.
    if (action === "seen" || action === "seen_all") {
      const table = await tenantTable(tenantSlug, "quotes");
      const clauses = [
        "status IN ('accepted','rejected')",
        "customer_decision_at IS NOT NULL",
        "customer_decision_seen_at IS NULL",
      ];
      const params: unknown[] = [];
      if (action === "seen") {
        const id = parseInteger(body.id);
        if (id <= 0) return jsonError("ID preventivo mancante.");
        clauses.push("id = ?");
        params.push(id);
      }
      const { currentLocationId } = await getManageLocationContext(tenantSlug);
      if (currentLocationId > 0 && await columnExists(table.name, "location_id")) {
        clauses.push("location_id = ?");
        params.push(currentLocationId);
      }
      if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
        clauses.push("tenant_id = ?");
        params.push(table.tenantId);
      }
      await dbExecute(`UPDATE \`${table.name}\` SET customer_decision_seen_at = NOW() WHERE ${clauses.join(" AND ")}`, params);
      return Response.json({
        ok: true,
        sourceMode: "database",
        message: action === "seen" ? "Preventivo segnato come letto" : "Preventivi segnati come letti",
        quotes: await listDbQuotes(tenantSlug),
      });
    }

    // Salvataggio legacy new/edit (quotes.php POST): validazioni e messaggi
    // verbatim, prezzi catalogo bloccati, numero automatico N/YYYY.
    if (action === "save") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const mode = String(rawBody.mode ?? "new") === "edit" ? "edit" : "new";
      const result = await saveManageQuote(tenantSlug, mode, rawBody, session.user.id, ctx);
      if (!result.ok) return Response.json({ ok: false, error: result.error });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "preventivi", action: mode === "edit" ? "modifica" : "crea", entityType: "quote", entityId: result.id, label: `${mode === "edit" ? "Modificato" : "Creato"} preventivo #${result.id}` });
      return Response.json({ ok: true, sourceMode: "database", id: result.id, message: "Preventivo salvato" });
    }

    const id = parseInteger(body.id);
    if (id <= 0) return jsonError("ID preventivo mancante.");

    // Invio email legacy (quotes.php action=send): guardie in ordine legacy,
    // token pubblico, mark-sent solo su invio riuscito.
    if (action === "send") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const result = await sendManageQuoteEmailLegacy(tenantSlug, id, { toEmail: body.to_email, message: body.message }, ctx);
      if (!result.err) {
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "preventivi", action: "invia", entityType: "quote", entityId: id, label: `Inviato preventivo #${id} via email` });
      }
      return Response.json({ ok: !result.err, sourceMode: "database", ...result });
    }

    // NB: la conversione preventivo->vendita NON ha un'azione qui (come il legacy
    // quotes.php, che non ha convert). Avviene dalla cassa via "Vai a Pagamenti"
    // (pos?quote_id=X -> getManagePosQuoteCart + checkout con source_quote_id), che
    // applica il gate accepted-only, l'idempotenza e l'emissione pacchetti.

    // DUPLICA (feature 2026-07-16, NON nel legacy): nuova BOZZA precompilata
    // dal preventivo sorgente — numero nuovo auto (N/YYYY), data odierna,
    // stato draft; le righe passano dal save normale, quindi i prezzi di
    // listino vengono ri-bloccati ai valori ATTUALI (i custom restano).
    if (action === "duplicate") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const src = await getManageQuoteFormData(tenantSlug, { action: "edit", id, locationId: 0 }, ctx);
      if (!src.form) return Response.json({ ok: false, error: src.redirect?.err || "Preventivo non trovato" });
      const f = src.form as typeof src.form & { terms?: string; publicNote?: string };
      const items = (f.itemsInitial ?? []).map((it) => ({
        item_type: it.item_type,
        item_id: it.item_id,
        description: it.description,
        qty: it.qty,
        unit_price: it.unit_price,
        tax_rate: it.tax_rate,
        discount_percent: it.discount_percent,
      }));
      const result = await saveManageQuote(tenantSlug, "new", {
        client_id: String(f.clientId || 0),
        client_name: `${f.clientFirstName ?? ""} ${f.clientLastName ?? ""}`.trim(),
        client_last_name: f.clientLastName ?? "",
        client_email: f.clientEmail ?? "",
        client_phone: f.clientPhone ?? "",
        client_address: f.clientAddress ?? "",
        client_cap: f.clientCap ?? "",
        client_city: f.clientCity ?? "",
        client_province: f.clientProvince ?? "",
        client_region: f.clientRegion ?? "",
        client_company_name: f.clientCompanyName ?? "",
        client_vat_number: f.clientVatNumber ?? "",
        client_tax_code: f.clientTaxCode ?? "",
        location_id: String(f.locationId || 0),
        status: "draft",
        notes: f.notes ?? "",
        terms: f.terms ?? "",
        public_note: f.publicNote ?? "",
        items_json: JSON.stringify(items),
      }, session.user.id, ctx);
      if (!result.ok) return Response.json({ ok: false, error: result.error });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "preventivi", action: "crea", entityType: "quote", entityId: result.id, label: `Creato preventivo #${result.id} (duplicato da #${id})` });
      return Response.json({ ok: true, sourceMode: "database", id: result.id, message: "Preventivo duplicato" });
    }

    // Delete legacy (quotes.php action=delete): solo bozze, messaggi verbatim.
    if (action === "delete") {
      const ctx = await quoteLocationCtx(tenantSlug);
      const result = await deleteManageQuoteLegacy(tenantSlug, id, ctx);
      if (!result.err) {
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "preventivi", action: "elimina", entityType: "quote", entityId: id, label: `Eliminato preventivo in bozza #${id}` });
      }
      return Response.json({ ok: !result.err, sourceMode: "database", ...result });
    }

    return jsonError("Azione preventivi non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preventivi.");
  }
}
