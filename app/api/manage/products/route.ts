import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { businessNowDateTime } from "@/lib/business-datetime";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessById, locationAllowedForSedi, resolveManageLocationId, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import {
  cancelStockDocument,
  deleteProduct,
  deleteProductCategory,
  deleteSupplier,
  getManageProduct,
  getManageProductsContext,
  getManageSupplier,
  listProductDeleteBlockers,
  saveProduct,
  saveProductCategory,
  saveStockMovement,
  saveSupplier,
} from "@/lib/manage-products";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);
  if (!canAny(session.user.perms, ["products.manage", "product_categories.manage", "stock_moves.manage", "suppliers.manage"])) {
    return jsonError("Permesso negato.", 403);
  }

  try {
    const url = new URL(request.url);

    // Edit-form prefill: return ONE supplier's editable fields for one id. Port
    // of suppliers.php action=edit. Gated by suppliers.manage like supplier_save.
    if (url.searchParams.get("action") === "get" && url.searchParams.get("type") === "supplier") {
      if (!can(session.user.perms, "suppliers.manage")) return jsonError("Permesso Fornitori richiesto.", 403);
      const supplierId = parseInteger(url.searchParams.get("id"), 0);
      if (supplierId <= 0) return jsonError("ID fornitore mancante.");
      const supplier = await getManageSupplier(tenantSlug, supplierId);
      if (!supplier) return jsonError("Fornitore non trovato.", 404);
      return Response.json({ ok: true, source: "products?action=get&type=supplier", sourceMode: "database", supplier });
    }

    // Edit-form prefill: return ONE product's editable fields for one id. Port of
    // products.php action=edit. Gated by products.manage like the save action.
    if (url.searchParams.get("action") === "get") {
      if (!can(session.user.perms, "products.manage")) return jsonError("Permesso Magazzino richiesto.", 403);
      const productId = parseInteger(url.searchParams.get("id"), 0);
      if (productId <= 0) return jsonError("ID prodotto mancante.");
      const product = await getManageProduct(tenantSlug, productId);
      if (!product) return jsonError("Prodotto non trovato.", 404);
      return Response.json({ ok: true, source: "products?action=get", sourceMode: "database", product });
    }

    const locationId = await resolveManageLocationId({
      slug: tenantSlug,
      raw: url.searchParams.get("location_id"),
      fallbackCurrent: true,
    });
    // FAIL-CLOSED sedi revocate (classe 18/07): un utente RISTRETTO senza sede
    // risolta (sessione stantia/sede revocata) non deve leggere l'UNIONE dei
    // documenti magazzino (la lista a scope-0 non filtra). L'admin/unrestricted
    // a sede 0 = unione FEDELE al legacy (app_current_location_id()==0).
    if (locationId <= 0 && sessionAllowedLocationIds(session).length > 0) {
      return jsonError("Sede non disponibile per le tue sedi.", 403);
    }
    const context = await getManageProductsContext(tenantSlug, {
      query: url.searchParams.get("q") ?? "",
      locationId,
      includeInactive: ["1", "true", "yes", "all"].includes((url.searchParams.get("include_inactive") ?? "1").toLowerCase()),
    });

    // EXPORT CSV movimenti — port di stock_moves.php action=export: una riga per
    // OGNI riga prodotto dei documenti, delimitatore ';', valori raw (date
    // YYYY-MM-DD, SI/NO, ANNULLATO/ATTIVO), filename movimenti_magazzino_<Y-m-d_H-i>.csv.
    if (url.searchParams.get("action") === "export") {
      const filters = {
        productId: parseInteger(url.searchParams.get("product_id"), 0),
        sku: String(url.searchParams.get("sku") ?? "").trim().toLowerCase(),
        internalCode: String(url.searchParams.get("internal_code") ?? "").trim().toLowerCase(),
        categoryId: parseInteger(url.searchParams.get("category_id"), 0),
        documentNumber: String(url.searchParams.get("document_number") ?? "").trim().toLowerCase(),
        supplier: String(url.searchParams.get("supplier") ?? "").trim(),
        date: String(url.searchParams.get("date") ?? "").trim(),
        includeCanceled: String(url.searchParams.get("include_canceled") ?? "") === "1",
      };
      if (filters.supplier === "0") filters.supplier = "";

      const productById = new Map(context.products.map((p) => [p.id, p]));
      const displayName = (name: string, sku: string) => (sku ? `${name} (${sku})` : name);
      const escCsv = (v: unknown) => {
        const s = String(v ?? "");
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines: string[] = [
        ["Documento ID", "Data movimento", "Operatore", "Causale", "Tipo documento", "Numero documento", "Data documento", "Note", "Prodotto", "Codice prodotto", "Fornitore", "Quantità", "Prodotto in arrivo", "Quantità in arrivo", "Data stimata arrivo", "Stato", "Creato il"].map(escCsv).join(";"),
      ];
      for (const d of context.stockDocuments ?? []) {
        if (!filters.includeCanceled && d.isCanceled) continue;
        if (filters.date && String(d.moveDate ?? "").slice(0, 10) !== filters.date) continue;
        if (filters.documentNumber && !String(d.documentNumber ?? "").toLowerCase().includes(filters.documentNumber)) continue;
        for (const it of d.items) {
          const product = productById.get(it.productId);
          if (filters.productId && it.productId !== filters.productId) continue;
          if (filters.sku && !String(it.productSku ?? "").toLowerCase().includes(filters.sku)) continue;
          if (filters.internalCode && !String(product?.internalCode ?? "").toLowerCase().includes(filters.internalCode)) continue;
          if (filters.categoryId && Number(product?.categoryId ?? 0) !== filters.categoryId) continue;
          if (filters.supplier && String(product?.supplierName ?? "") !== filters.supplier) continue;
          lines.push([
            d.id,
            String(d.moveDate ?? "").slice(0, 10),
            d.operatorName ?? "",
            d.cause ?? "",
            d.documentType ?? "",
            d.documentNumber ?? "",
            String(d.documentDate ?? "").slice(0, 10),
            d.notes ?? "",
            displayName(String(it.productName ?? ""), String(it.productSku ?? "")),
            it.productSku ?? "",
            product?.supplierName ?? "",
            it.qty ?? 0,
            it.incomingFlag ? "SI" : "NO",
            it.incomingQty ?? 0,
            it.incomingEta ? String(it.incomingEta).slice(0, 10) : "",
            d.isCanceled ? "ANNULLATO" : "ATTIVO",
            d.createdAt ? String(d.createdAt).replace("T", " ").slice(0, 19) : "",
          ].map(escCsv).join(";"));
        }
      }
      // Timestamp filename in ORA DI ROMA (classe TZ server-safe).
      const nowRome = businessNowDateTime();
      const stamp = `${nowRome.slice(0, 10)}_${nowRome.slice(11, 13)}-${nowRome.slice(14, 16)}`;
      return new Response(lines.join("\n") + "\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="movimenti_magazzino_${stamp}.csv"`,
        },
      });
    }

    // operatorName: il form Carico/Scarico mostra l'operatore corrente (legacy $operatorName).
    return Response.json({ ...context, operatorName: session.user.name });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Magazzino non caricato.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione gestionale scaduta.", 401);

  try {
    const body = await parseRequestBody(request);
    const url = new URL(request.url);
    const action = String(body.action ?? url.searchParams.get("action") ?? "create");

    switch (action) {
      case "create":
      case "new":
      case "save":
      case "update":
      case "edit":
      case "product_save": {
        if (!can(session.user.perms, "products.manage")) return jsonError("Permesso Magazzino richiesto.", 403);
        const out = await saveProduct(tenantSlug, body);
        const isEdit = parseInteger(body.id ?? body.product_id, 0) > 0;
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "magazzino", action: isEdit ? "modifica" : "crea", entityType: "product", entityId: parseInteger(body.id ?? body.product_id, 0), label: `${isEdit ? "Modificato" : "Creato"} prodotto "${String(body.name ?? "").trim() || "senza nome"}"` });
        return Response.json(out);
      }

      case "delete":
      case "product_delete": {
        if (!can(session.user.perms, "products.manage")) return jsonError("Permesso Magazzino richiesto.", 403);
        // Blockers PRIMA del delete (legacy products_delete_blockers): la lista li usa
        // per il modal "Impossibile eliminare il prodotto" con le associazioni rilevate.
        const productId = parseInteger(body.id ?? body.product_id, 0);
        const blockers = productId > 0 ? await listProductDeleteBlockers(tenantSlug, productId) : [];
        if (blockers.length) {
          return Response.json({
            ok: false,
            error: "Prodotto non eliminato: associazioni attive presenti.",
            deleteBlockers: blockers,
          });
        }
        const out = await deleteProduct(tenantSlug, productId);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "magazzino", action: "elimina", entityType: "product", entityId: productId, label: `Eliminato prodotto #${productId}` });
        return Response.json(out);
      }

      case "category_save":
      case "product_category_save":
      case "categories":
        if (!can(session.user.perms, "product_categories.manage")) return jsonError("Permesso Categorie prodotti richiesto.", 403);
        return Response.json(await saveProductCategory(tenantSlug, body));

      case "category_delete":
      case "product_category_delete":
        if (!can(session.user.perms, "product_categories.manage")) return jsonError("Permesso Categorie prodotti richiesto.", 403);
        return Response.json(await deleteProductCategory(tenantSlug, parseInteger(body.id ?? body.cat_id ?? body.category_id, 0)));

      case "move_stock":
      case "stock_move_save":
      case "stock_doc_save": {
        if (!can(session.user.perms, "stock_moves.manage")) return jsonError("Permesso Carico / Scarico richiesto.", 403);
        // Guardia per-sede: un operatore ristretto non puo' registrare un movimento in una sede non sua.
        // FAIL-CLOSED (18/07): per il RISTRETTO anche sede 0/assente è bloccata
        // (un movimento "globale" muterebbe lo stock fallback fuori dalle sue sedi).
        const wantLoc = parseInteger(body.location_id, 0);
        const allowedSedi = sessionAllowedLocationIds(session);
        if (allowedSedi.length > 0 && (wantLoc <= 0 || !locationAllowedForSedi(wantLoc, allowedSedi))) {
          return jsonError("Sede non disponibile per le tue sedi.", 403);
        }
        if (wantLoc > 0 && !locationAllowedForSedi(wantLoc, allowedSedi)) {
          return jsonError("Sede non disponibile per le tue sedi.", 403);
        }
        const out = await saveStockMovement(tenantSlug, body, session.user.name, session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: wantLoc || session.user.currentLocationId, module: "magazzino", action: "crea", entityType: "stock_doc", label: `Registrato documento magazzino (${String(body.cause ?? "movimento").trim() || "movimento"})` });
        return Response.json(out);
      }

      case "stock_doc_cancel":
      case "stock_move_cancel": {
        if (!can(session.user.perms, "stock_moves.manage")) return jsonError("Permesso Carico / Scarico richiesto.", 403);
        // Guardia per-sede: niente annullo di un documento di magazzino di un'altra sede.
        await assertLocationAccessById(tenantSlug, "stock_docs", parseInteger(body.id ?? body.stock_doc_id, 0), sessionAllowedLocationIds(session), "Documento non disponibile per le tue sedi.");
        const docId = parseInteger(body.id ?? body.stock_doc_id, 0);
        const out = await cancelStockDocument(tenantSlug, docId, session.user.name, session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "magazzino", action: "annulla", entityType: "stock_doc", entityId: docId, label: `Annullato documento magazzino #${docId}` });
        return Response.json(out);
      }

      case "supplier_save": {
        if (!can(session.user.perms, "suppliers.manage")) return jsonError("Permesso Fornitori richiesto.", 403);
        const out = await saveSupplier(tenantSlug, body);
        const isEdit = parseInteger(body.id ?? body.supplier_id, 0) > 0;
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "fornitori", action: isEdit ? "modifica" : "crea", entityType: "supplier", entityId: parseInteger(body.id ?? body.supplier_id, 0), label: `${isEdit ? "Modificato" : "Creato"} fornitore "${String(body.name ?? "").trim() || "senza nome"}"` });
        return Response.json(out);
      }

      case "supplier_delete": {
        if (!can(session.user.perms, "suppliers.manage")) return jsonError("Permesso Fornitori richiesto.", 403);
        const supplierId = parseInteger(body.id ?? body.supplier_id, 0);
        const out = await deleteSupplier(tenantSlug, supplierId);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "fornitori", action: "elimina", entityType: "supplier", entityId: supplierId, label: `Eliminato fornitore #${supplierId}` });
        return Response.json(out);
      }

      default:
        return jsonError("Azione magazzino non supportata.", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione magazzino non riuscita.");
  }
}
