import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { convertDbQuoteToSale, createDbQuote, deleteDbQuote, getManageQuoteDetail, getManageQuoteForEdit, listDbClients, listDbProducts, listDbQuotes, listDbServices, sendQuoteEmail, updateDbQuote, updateDbQuoteStatus, type QuoteLineInput, type QuoteSaveInput } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";
import { columnExists, dbExecute, tenantTable } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "quotes.manage")) return jsonError("Permesso preventivi mancante.", 403);

  try {
    const url = new URL(request.url);

    // Editor context: the catalog the faithful Nuovo preventivo form needs —
    // clients (for the cliente picker) + services + products (for the line
    // items). Numeric prices are parsed from the managed catalog so the form can
    // seed an editable unit price per line.
    // Quote DETAIL (action=view): header + client + items + totals + linked sale.
    if (url.searchParams.get("action") === "view") {
      const detail = await getManageQuoteDetail(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("Preventivo non trovato.", 404);
      return Response.json({ ok: true, sourceMode: "database", detail });
    }

    // Edit-form prefill (action=edit): the quote in the CORE editor's shape.
    if (url.searchParams.get("action") === "edit_get") {
      const quote = await getManageQuoteForEdit(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!quote) return jsonError("Preventivo non trovato.", 404);
      return Response.json({ ok: true, sourceMode: "database", quote });
    }

    if (url.searchParams.get("action") === "context") {
      const [clients, services, products] = await Promise.all([
        listDbClients({ slug: tenantSlug }),
        listDbServices({ slug: tenantSlug }),
        listDbProducts({ slug: tenantSlug }),
      ]);
      return Response.json({
        ok: true,
        sourceMode: "database",
        clients: clients.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })),
        services: services.map((s) => ({ id: s.id, name: s.name, price: priceFromManaged(s.price) })),
        products: products.map((p) => ({ id: p.id, name: p.name, price: priceFromManaged(p.price) })),
      });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      quotes: await listDbQuotes(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preventivi.");
  }
}

// The managed catalog formats price as a string (e.g. "30 euro" / "12.5 euro").
// Parse the leading number for the editor's editable unit-price seed.
function priceFromManaged(value: unknown): number {
  const match = String(value ?? "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  const n = match ? Number.parseFloat(match[0]) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "quotes.manage")) return jsonError("Permesso preventivi mancante.", 403);

  const body = await parseRequestBody(request);
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

    if (action === "create") {
      const quote = await createDbQuote(quoteSaveInputFromBody(body), tenantSlug);
      return Response.json({ ok: true, source: "quotes?action=create", sourceMode: "database", quote, quotes: await listDbQuotes(tenantSlug) });
    }

    const id = parseInteger(body.id);
    if (id <= 0) return jsonError("ID preventivo mancante.");

    // Update an existing quote (port of quotes.php action=edit save).
    if (action === "update") {
      const quote = await updateDbQuote(id, quoteSaveInputFromBody(body), tenantSlug);
      return Response.json({ ok: true, source: "quotes?action=update", sourceMode: "database", quote, quotes: await listDbQuotes(tenantSlug) });
    }

    if (action === "send") {
      // Port of quotes.php action=email: email the quote to the client (public +
      // PDF links), then mark it sent. sendQuoteEmail is best-effort / SES-gated and
      // also performs the legacy "mark sent" stamp on a successful send; we still
      // flip the status first via updateDbQuoteStatus so the documented status
      // transition is preserved even when SES is unconfigured (unchanged behaviour).
      const quote = await updateDbQuoteStatus(id, "sent", tenantSlug);
      await sendQuoteEmail(id, tenantSlug, { toEmail: body.to_email, message: body.message });
      return Response.json({ ok: true, sourceMode: "database", quote, quotes: await listDbQuotes(tenantSlug) });
    }
    if (action === "accept") {
      const quote = await updateDbQuoteStatus(id, "accepted", tenantSlug);
      return Response.json({ ok: true, sourceMode: "database", quote, quotes: await listDbQuotes(tenantSlug) });
    }
    if (action === "convert") {
      const result = await convertDbQuoteToSale(id, tenantSlug, parseInteger(body.location_id, 0));
      return Response.json({ ok: true, source: "quotes?action=convert", sourceMode: "database", ...result, quotes: await listDbQuotes(tenantSlug) });
    }

    // Delete a draft quote (port of quotes.php action=delete).
    if (action === "delete") {
      await deleteDbQuote(tenantSlug, id);
      return Response.json({ ok: true, source: "quotes?action=delete", sourceMode: "database", quotes: await listDbQuotes(tenantSlug) });
    }

    return jsonError("Azione preventivi non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore preventivi.");
  }
}

// Build the rich QuoteSaveInput (port of the quotes.php new/edit fields) from the
// posted body: client + anagrafica snapshot + dates + notes/terms/public note +
// the content lines (each with per-line IVA + discount%).
function quoteSaveInputFromBody(body: Record<string, string>): QuoteSaveInput {
  let lines: QuoteLineInput[] = [];
  if (body.lines_json) {
    try {
      const parsed = JSON.parse(body.lines_json);
      if (Array.isArray(parsed)) {
        lines = parsed.map((l: Record<string, unknown>) => ({
          type: (["service", "product", "package", "custom"].includes(String(l.type)) ? String(l.type) : "service") as QuoteLineInput["type"],
          refId: Number(l.refId ?? 0) || 0,
          name: String(l.name ?? ""),
          sku: String(l.sku ?? ""),
          quantity: Number(l.quantity ?? 1) || 1,
          unitPrice: Number(l.unitPrice ?? 0) || 0,
          taxRate: Number(l.taxRate ?? 0) || 0,
          discountPercent: Number(l.discountPercent ?? 0) || 0,
        }));
      }
    } catch {
      // fallback below
    }
  }
  if (lines.length === 0) {
    lines = [{ type: "service", refId: parseInteger(body.service_id, 0), name: body.service_name ?? "", quantity: parseNumber(body.quantity, 1), unitPrice: body.price ? parseNumber(body.price, 0) : 0 }];
  }
  return {
    clientId: parseInteger(body.client_id, 0),
    clientName: body.client_name,
    client: {
      companyName: body.client_company_name,
      vatNumber: body.client_vat_number,
      taxCode: body.client_tax_code,
      sdi: body.client_sdi,
      pec: body.client_pec,
      email: body.client_email,
      phone: body.client_phone,
      address: body.client_address,
      cap: body.client_cap,
      city: body.client_city,
      province: body.client_province,
    },
    quoteDate: body.quote_date,
    validUntil: body.valid_until,
    notes: body.notes,
    terms: body.terms,
    publicNote: body.public_note,
    lines,
  };
}
