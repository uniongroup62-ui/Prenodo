import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { currentManageSession } from "@/lib/manage-auth";
import { resolveManageLocationId } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { cancelManageSale, checkoutManageSale, deleteCancelledSale, getManagePosAppointmentCart, getManagePosContext, getManagePosQuoteCart, getManagePosResiduals, getManagePosSuccess, getManageRechargePointsPreview, getManageSaleDetail, markManageSaleItemCollected, markPrepaidManualExecution, undoManageSaleItemCollected, undoPrepaidManualExecution } from "@/lib/manage-pos";
import type { PointsStornoMode } from "@/lib/manage-pos";
import { evaluateCatalogTilePromos } from "@/lib/db-repositories";
import { searchGiftRecipientClients } from "@/lib/gift-issue-details";
import { can, canAny } from "@/lib/role-permissions";
import type {
  PosCheckoutInput,
  PosInstallmentPlanInput,
  PosPaymentInput,
  PosPaymentMethod,
  PosSaleItemInput,
  PosSaleItemType,
} from "@/lib/tenant-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  // Ombrello GET = unione dei gate di PAGINA pos.* legacy: pos.php (pos.manage),
  // pos_history (pos.movements), pos_sale_detail (requireAnyPerm sui 4:
  // manage/movements/prepaids/preorders), pos_preorders/pos_prepaids. Le pagine
  // si gatano coi flag perms della risposta context.
  if (!canAny(session.user.perms, ["pos.manage", "pos.movements", "pos.prepaids", "pos.preorders"])) return jsonError("Permesso POS mancante.", 403);

  const url = new URL(request.url);

  // Residui lookup for the "Residui" panel: the selected client's wallet CREDIT
  // balance + available GiftCards. Faithful to pos.php?action=pos_residual_credit_data.
  if (url.searchParams.get("action") === "client_residuals") {
    const clientId = parseInteger(url.searchParams.get("client_id"), 0);
    try {
      return Response.json(await getManagePosResiduals(tenantSlug, clientId));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore residui POS.");
    }
  }

  // Ricerca clienti server-side (2026-07-16) per la colonna Clienti + i picker
  // destinatario GiftBox/GiftCard: il catalogo iniziale resta cappato (500) ma la
  // ricerca copre l'ANAGRAFICA COMPLETA come la lista senza LIMIT del legacy
  // (pos.php 1896). Gate = ombrello POS già verificato sopra.
  if (url.searchParams.get("action") === "client_search") {
    const clients = await searchGiftRecipientClients(tenantSlug, url.searchParams.get("q") ?? "");
    return Response.json({ ok: true, clients });
  }

  // "Vendita da appuntamento" pre-load: the cart seed (client + service lines with the
  // current catalog price) for cashing out a completed appointment in the POS. The UI seeds
  // the cart from this, then a normal checkout (with appointment_id) records the sale AND
  // marks the appointment 'done'. Same tenant + POS permission gate as the rest of the route.
  if (url.searchParams.get("action") === "appointment_cart") {
    const appointmentId = parseInteger(url.searchParams.get("appointment_id"), 0);
    try {
      return Response.json(await getManagePosAppointmentCart(tenantSlug, appointmentId));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore caricamento appuntamento POS.");
    }
  }

  // IN-POS QUOTE IMPORT pre-load (faithful to pos.php ?quote_id=N): the LOCKED cart seed for a
  // quote (client + quote lines at the quote's snapshot prices). The UI seeds a locked cart from
  // this, then a normal checkout (with source_quote_id) records the sale + flips the quote.
  if (url.searchParams.get("action") === "quote_cart") {
    const quoteId = parseInteger(url.searchParams.get("quote_id") ?? url.searchParams.get("id"), 0);
    try {
      return Response.json(await getManagePosQuoteCart(tenantSlug, quoteId));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore caricamento preventivo POS.");
    }
  }

  // POS "Dettaglio vendita" (pos_sale_detail.php): the full single sale (header + items +
  // payments + totals) plus the cancel summary + blockers. Read-gated by the POS permission
  // already checked above; the cancel/pickup ACTIONS below carry the stronger movements gate.
  // Pagina "Vendita completata" (port di pos_success.php): dati vendita + voucher
  // emessi + pacchetti/ricariche + Fidelity, ricostruiti dal DB per sale_id.
  if (url.searchParams.get("action") === "sale_success") {
    const saleId = parseInteger(url.searchParams.get("id") ?? url.searchParams.get("sale_id"), 0);
    if (saleId <= 0) return jsonError("Vendita non valida.");
    try {
      return Response.json(await getManagePosSuccess(tenantSlug, saleId));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore dettaglio vendita.");
    }
  }

  if (url.searchParams.get("action") === "sale_detail") {
    const saleId = parseInteger(url.searchParams.get("id") ?? url.searchParams.get("sale_id"), 0);
    if (saleId <= 0) return jsonError("ID vendita mancante.");
    try {
      return Response.json(await getManageSaleDetail(tenantSlug, saleId));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore dettaglio vendita.");
    }
  }

  const locationId = await resolveManageLocationId({
    slug: tenantSlug,
    raw: url.searchParams.get("location_id"),
    fallbackCurrent: true,
  });
  const includeCancelled = ["1", "true", "yes"].includes((url.searchParams.get("include_cancelled") ?? "1").toLowerCase());

  try {
    const context = await getManagePosContext(tenantSlug, {
      locationId,
      includeCancelled,
      query: url.searchParams.get("q") ?? "",
      // #11: intervallo data server-side per lo storico (evita che il LIMIT tagli i movimenti
      // piu' vecchi del range prima del filtro).
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
    });
    return Response.json({
      ...context,
      // Flag pagina/azioni legacy: pos.php requirePerm('pos.manage');
      // pos_history.php requirePerm('pos.movements') + gate per-azione dei link
      // (Voucher giftbox/giftcard, 'Apri' ricariche, Impostazioni header).
      perms: {
        posManage: can(session.user.perms, "pos.manage"),
        posMovements: can(session.user.perms, "pos.movements"),
        posPreorders: can(session.user.perms, "pos.preorders"),
        posPrepaids: can(session.user.perms, "pos.prepaids"),
        posSettings: can(session.user.perms, "pos.settings"),
        creditMovements: can(session.user.perms, "credit_movements.manage"),
        giftboxManage: can(session.user.perms, "giftbox.manage"),
        giftcardManage: can(session.user.perms, "giftcard.manage"),
        fidelityManage: can(session.user.perms, "fidelity.manage"),
        appointmentsManage: can(session.user.perms, "appointments.manage"),
        quotesManage: can(session.user.perms, "quotes.manage"),
        packagesClients: can(session.user.perms, "packages.clients"),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore POS.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const action = String(body.action ?? url.searchParams.get("action") ?? "checkout");

  try {
    // Prezzi promo per i tile del catalogo (port di pos.php mode=catalog_promos):
    // ogni servizio/prodotto visibile valutato da solo contro le promo automatiche.
    if (action === "catalog_promos") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.movements"])) return jsonError("Permesso POS mancante.", 403);
      let items: Array<{ type: "service" | "product"; id: number }> = [];
      try {
        const parsed = JSON.parse(String(body.items_json ?? body.items ?? "[]")) as Array<Record<string, unknown>>;
        if (Array.isArray(parsed)) {
          items = parsed
            .map((it) => ({ type: String(it?.type ?? "").toLowerCase() as "service" | "product", id: parseInteger(it?.id, 0) }))
            .filter((it) => (it.type === "service" || it.type === "product") && it.id > 0);
        }
      } catch {
        items = [];
      }
      const locationId = await resolveManageLocationId({ slug: tenantSlug, raw: body.location_id === undefined ? null : body.location_id, fallbackCurrent: true });
      const result = await evaluateCatalogTilePromos(tenantSlug, items, parseInteger(body.client_id, 0), locationId);
      return Response.json({ ok: true, ...result });
    }

    // Preview punti su ricarica (port di pos.php mode=preview_recharge_points).
    if (action === "recharge_points_preview") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.movements"])) return jsonError("Permesso POS mancante.", 403);
      return Response.json(await getManageRechargePointsPreview(tenantSlug, parseInteger(body.client_id, 0), parseNumber(body.amount, 0)));
    }

    if (action === "checkout") {
      if (!can(session.user.perms, "pos.manage")) return jsonError("Permesso cassa mancante.", 403);
      const input = await checkoutInputFromBody(body, tenantSlug);
      const payload = await checkoutManageSale(tenantSlug, input, {
        id: session.user.id,
        name: session.user.name,
      });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pagamenti", action: "incasso", entityType: "sale", entityId: Number(payload.sale?.id ?? 0), label: `Incasso vendita #${Number(payload.sale?.id ?? 0)} — € ${Number(payload.sale?.total ?? 0).toFixed(2)}` });
      return Response.json({
        ...payload,
      });
    }

    if (action === "cancel") {
      if (!can(session.user.perms, "pos.movements")) return jsonError("Permesso movimenti POS mancante.", 403);
      const saleId = parseInteger(body.id ?? body.sale_id);
      if (saleId <= 0) return jsonError("ID vendita mancante.");

      const payload = await cancelManageSale(tenantSlug, {
        saleId,
        reason: body.reason ?? body.cancel_reason ?? "",
        stockCancelMode: normalizeStockCancelMode(body.stock_cancel_mode),
        userId: session.user.id,
        userName: session.user.name,
        // Fidelity-points storno decisions from the cancel modal. Default "normal" (fails safe
        // by throwing on insufficient balance); the decision UI, when it appears, defaults to
        // "negative". Port of pos_history.php's points_storno_mode + recharge_points_storno_mode.
        pointsStornoMode: normalizePointsStornoMode(body.points_storno_mode),
        rechargePointsModes: normalizeRechargePointsModes(body.recharge_points_storno_mode),
      });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pagamenti", action: "annulla", entityType: "sale", entityId: saleId, label: `Annullata vendita #${saleId}${String(body.reason ?? body.cancel_reason ?? "").trim() !== "" ? ` — motivo: ${String(body.reason ?? body.cancel_reason).trim()}` : ""}` });
      return Response.json({
        ...payload,
      });
    }

    // DELETE ("Elimina vendita"): permanently remove an ALREADY-CANCELLED sale + its child
    // rows. Faithful to pos_sale_detail.php's delete_cancelled_sale — gated by the same
    // Auth::canAny(['pos.manage','pos.movements']) permission; the per-sale location access +
    // status=cancelled + appointment-cleanup checks live in deleteCancelledSale.
    if (action === "delete_sale") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.movements"])) return jsonError("Non hai i permessi per eliminare vendite annullate.", 403);
      const saleId = parseInteger(body.id ?? body.sale_id);
      if (saleId <= 0) return jsonError("ID vendita mancante.");
      const payload = await deleteCancelledSale(tenantSlug, {
        saleId,
        userId: session.user.id,
      });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "pagamenti", action: "elimina", entityType: "sale", entityId: saleId, label: `Eliminata vendita annullata #${saleId}` });
      return Response.json({
        ...payload,
        deleted: true,
      });
    }

    // PICKUP ("Segna ritirato"): mark a product sale line as collected, optionally PARTIAL
    // (collect_qty). Faithful port of pos_sale_detail.php?do=mark_preorder_collection — gated
    // by pos.preorders OR pos.manage (the legacy Auth::canAny(['pos.manage','pos.preorders'])).
    if (action === "mark_collected") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.preorders"])) return jsonError("Non hai i permessi per gestire i preordini.", 403);
      const saleId = parseInteger(body.sale_id ?? body.id);
      const saleItemId = parseInteger(body.sale_item_id);
      if (saleId <= 0 || saleItemId <= 0) return jsonError("Riga prodotto non valida.");
      const payload = await markManageSaleItemCollected(tenantSlug, {
        saleId,
        saleItemId,
        qty: parseInteger(body.collect_qty ?? body.qty, 0),
        userId: session.user.id,
        userName: session.user.name,
      });
      return Response.json({
        ...payload,
      });
    }

    // UNDO PICKUP ("Rimuovi ritiro"): reverse a collected product line back to ordered +
    // restore stock. Faithful port of pos_sale_detail.php?do=undo_preorder_collection.
    if (action === "undo_collected") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.preorders"])) return jsonError("Non hai i permessi per gestire i preordini.", 403);
      const saleId = parseInteger(body.sale_id ?? body.id);
      const saleItemId = parseInteger(body.sale_item_id);
      if (saleId <= 0 || saleItemId <= 0) return jsonError("Riga prodotto non valida.");
      const payload = await undoManageSaleItemCollected(tenantSlug, {
        saleId,
        saleItemId,
        userId: session.user.id,
        userName: session.user.name,
      });
      return Response.json({ ...payload });
    }

    // PREPAID MANUAL EXECUTION ("Segna eseguito"): mark N sessions of a prepaid line as
    // manually executed (out of appointment). Faithful port of mark_prepaid_manual_execution —
    // gated by pos.manage OR pos.prepaids (the legacy Auth::canAny(['pos.manage','pos.prepaids'])).
    if (action === "prepaid_manual_execute") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.prepaids"])) return jsonError("Non hai i permessi per gestire i prepagati.", 403);
      const saleId = parseInteger(body.sale_id ?? body.id);
      const prepaidId = parseInteger(body.prepaid_id);
      const qty = parseInteger(body.execute_qty ?? body.qty, 1);
      if (saleId <= 0) return jsonError("Vendita non valida.");
      if (prepaidId <= 0) return jsonError("Servizio prepagato non valido.");
      const payload = await markPrepaidManualExecution(tenantSlug, {
        saleId,
        prepaidId,
        qty,
        userId: session.user.id,
      });
      return Response.json({ ...payload });
    }

    // UNDO PREPAID MANUAL EXECUTION ("Annulla esecuzione"): restore the residual + remove the
    // manual usage row. Faithful port of undo_prepaid_manual_execution.
    if (action === "prepaid_manual_undo") {
      if (!canAny(session.user.perms, ["pos.manage", "pos.prepaids"])) return jsonError("Non hai i permessi per gestire i prepagati.", 403);
      const saleId = parseInteger(body.sale_id ?? body.id);
      const usageId = parseInteger(body.usage_id);
      if (saleId <= 0) return jsonError("Vendita non valida.");
      if (usageId <= 0) return jsonError("Utilizzo manuale non valido.");
      const payload = await undoPrepaidManualExecution(tenantSlug, {
        saleId,
        usageId,
        userId: session.user.id,
      });
      return Response.json({ ...payload });
    }

    return jsonError("Azione POS non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore POS.");
  }
}

async function checkoutInputFromBody(body: Record<string, string>, tenantSlug: string): Promise<PosCheckoutInput> {
  const locationId = await resolveManageLocationId({
    slug: tenantSlug,
    raw: body.location_id === undefined ? null : body.location_id,
    fallbackCurrent: true,
  });

  return {
    clientId: parseInteger(body.client_id, 0),
    clientName: body.client_name,
    appointmentId: parseInteger(body.appointment_id, 0),
    locationId,
    discount: parseNumber(body.discount, 0),
    couponCode: body.coupon_code,
    notes: body.notes,
    promotionId: parseInteger(body.promotion_id, 0),
    installments: parseInteger(body.installments, 0),
    // FIDELITY points the staff applies as a discount (legacy POST field fidelity_points_use).
    fidelityPointsUse: parseNumber(body.fidelity_points_use, 0),
    // RATEIZZAZIONE: the optional installment plan params (faithful to the legacy
    // installment_plan_json POST field). Present only when the staff chose "Rateizzato".
    installmentPlan: installmentPlanFromBody(body),
    // Scelta unico/rateizzato legacy (installment_choice_mode): obbligatoria server-side
    // quando il totale netto residui è > 0 (pos.php 4631).
    installmentChoice: ((): "single" | "installment" | "" => {
      const v = String(body.installment_choice ?? body.installment_choice_mode ?? "").trim().toLowerCase();
      return v === "single" || v === "installment" ? v : "";
    })(),
    // IN-POS quote import: the source quote id when the cart was pre-loaded (locked) from a quote.
    sourceQuoteId: parseInteger(body.source_quote_id ?? body.quote_id, 0),
    items: saleItemsFromBody(body),
    payments: paymentsFromBody(body),
  };
}

// Parse the optional installment plan params from the checkout body. The UI sends an
// installment_plan JSON blob ({count, down_payment, interval_value, interval_unit,
// first_due_date, note}) when "Rateizzato" is active. Returns undefined for a single payment
// (the common path) or any malformed / count < 2 plan, so the backend skips plan creation.
function installmentPlanFromBody(body: Record<string, string>): PosInstallmentPlanInput | undefined {
  const raw = body.installment_plan ?? body.installment_plan_json;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const count = parseInteger(parsed.count ?? parsed.installments_count, 0);
    if (count < 2) return undefined;
    const unit = String(parsed.intervalUnit ?? parsed.interval_unit ?? "month").toLowerCase();
    return {
      count,
      downPayment: parseNumber(parsed.downPayment ?? parsed.down_payment ?? parsed.down_payment_amount, 0),
      intervalValue: parseInteger(parsed.intervalValue ?? parsed.interval_value, 1),
      intervalUnit: unit === "day" || unit === "week" ? unit : "month",
      firstDueDate: String(parsed.firstDueDate ?? parsed.first_due_date ?? "").trim() || undefined,
      note: String(parsed.note ?? parsed.notes ?? "").trim() || undefined,
    };
  } catch {
    return undefined;
  }
}

function saleItemsFromBody(body: Record<string, string>): PosSaleItemInput[] {
  const rawJson = body.items_json ?? body.items;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
      const items = parsed.map((item) => normalizeSaleItemInput(item)).filter(Boolean) as PosSaleItemInput[];
      if (items.length > 0) return items;
    } catch {
      // Fallback ai campi semplici, come faceva la pagina PHP con POST tradizionale.
    }
  }

  const items: PosSaleItemInput[] = [];
  const serviceId = parseInteger(body.service_id, 0);
  const productId = parseInteger(body.product_id, 0);

  if (serviceId > 0 || body.service_name) {
    items.push({
      type: "service",
      refId: serviceId,
      name: body.service_name,
      quantity: parseNumber(body.service_qty, 1),
      unitPrice: body.service_price ? parseNumber(body.service_price, 0) : undefined,
      status: "executed",
    });
  }

  if (productId > 0 || body.product_name) {
    items.push({
      type: "product",
      refId: productId,
      name: body.product_name,
      quantity: parseNumber(body.product_qty, 1),
      unitPrice: body.product_price ? parseNumber(body.product_price, 0) : undefined,
      status: "collected",
    });
  }

  return items;
}

function paymentsFromBody(body: Record<string, string>): PosPaymentInput[] {
  const rawJson = body.payments_json ?? body.payments;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
      const payments = parsed
        .map((payment) => ({
          method: normalizePaymentMethod(String(payment.method ?? "")),
          amount: parseNumber(payment.amount, 0),
          giftcardId: parseInteger(payment.giftcardId ?? payment.giftcard_id, 0),
        }))
        .filter((payment) => payment.amount > 0);
      if (payments.length > 0) return payments;
    } catch {
      // Fallback ai campi semplici sotto.
    }
  }

  return [
    {
      method: normalizePaymentMethod(body.payment_method ?? "card"),
      amount: parseNumber(body.payment_amount, 0),
    },
  ];
}

function normalizeSaleItemInput(item: Record<string, unknown>): PosSaleItemInput | null {
  const type = normalizeItemType(String(item.type ?? ""));
  if (!type) return null;

  return {
    type,
    refId: parseInteger(item.refId ?? item.ref_id, 0),
    name: item.name ? String(item.name) : undefined,
    quantity: parseNumber(item.quantity ?? item.qty, 1),
    unitPrice: item.unitPrice === undefined ? parseNumber(item.unit_price, 0) : parseNumber(item.unitPrice, 0),
    status: item.status ? String(item.status) as PosSaleItemInput["status"] : undefined,
    // Package sale meta (faithful to the legacy items[idx][package_*] fields): the custom
    // validity window + note, read only for a type:"package" line at issue time.
    startDate: packageMetaString(item.startDate ?? item.start_date ?? item.package_start_date),
    expiresAt: packageMetaString(item.expiresAt ?? item.expires_at ?? item.package_expires_at),
    note: packageMetaString(item.note ?? item.package_note),
    // GiftCard / GiftBox sale meta (faithful to the legacy issue_giftcard / issue_giftbox
    // POST fields): the chosen recipient (client/free-text), optional custom code, expiry,
    // dedica + hide-amount toggle + event type. Read for a type:"giftcard" line (issuing the
    // giftcards row) and a type:"giftbox" line (issuing the giftbox_instances row, where
    // refId is the chosen giftboxes TEMPLATE id and recipientClientId is the instance OWNER).
    recipientClientId: parseInteger(item.recipientClientId ?? item.recipient_client_id, 0) || undefined,
    recipientName: packageMetaString(item.recipientName ?? item.recipient_name),
    recipientEmail: packageMetaString(item.recipientEmail ?? item.recipient_email),
    code: packageMetaString(item.code ?? item.giftcard_code),
    eventType: packageMetaString(item.eventType ?? item.event_type),
    message: packageMetaString(item.message ?? item.gift_message),
    hideAmount: parseBoolean(item.hideAmount ?? item.hide_amount),
    // Voucher extra meta (items[gc_*] / giftbox_* draft legacy): nota interna,
    // invio email (none|now|date + data) e "Mostra importo e contenuto".
    internalNote: packageMetaString(item.internalNote ?? item.internal_note),
    sendMode: ((): PosSaleItemInput["sendMode"] => {
      const v = String(item.sendMode ?? item.send_mode ?? "").trim().toLowerCase();
      return v === "none" || v === "now" || v === "date" ? v : undefined;
    })(),
    sendOn: packageMetaString(item.sendOn ?? item.send_on),
    showAmount: item.showAmount === undefined && item.show_amount === undefined ? undefined : parseBoolean(item.showAmount ?? item.show_amount),
    // RECHARGE sale meta (faithful to the legacy recharge POST fields): the base/bonus/total
    // top-up + the earn-points-on-bonus toggle, read only for a type:"recharge" line. The
    // wallet credit + recharges row are written from these at checkout (issueRechargeFromSale).
    baseAmount: item.baseAmount === undefined && item.base_amount === undefined ? undefined : parseNumber(item.baseAmount ?? item.base_amount, 0),
    bonusKind: packageMetaString(item.bonusKind ?? item.bonus_kind),
    bonusValue: item.bonusValue === undefined && item.bonus_value === undefined ? undefined : parseNumber(item.bonusValue ?? item.bonus_value, 0),
    bonusAmount: item.bonusAmount === undefined && item.bonus_amount === undefined ? undefined : parseNumber(item.bonusAmount ?? item.bonus_amount, 0),
    totalAmount: item.totalAmount === undefined && item.total_amount === undefined ? undefined : parseNumber(item.totalAmount ?? item.total_amount, 0),
    earnPoints: parseBoolean(item.earnPoints ?? item.earn_points),
    // Custom GiftBox contents (faithful to the legacy giftbox_items POST payload): a nested array
    // of {type:'service'|'product', id, qty} carried inside items_json (so it survives the JSON
    // parse intact, unlike a top-level body field). Read only for a type:"giftbox" custom-build line.
    customItems: normalizeCustomGiftboxItems(item.customItems ?? item.giftbox_items),
  };
}

// Parse the custom-giftbox contents array: keep only valid {service|product, id>0, qty>=1} entries.
function normalizeCustomGiftboxItems(value: unknown): Array<{ type: "service" | "product"; id: number; qty: number }> | undefined {
  let src: unknown = value;
  if (typeof src === "string") {
    try { src = JSON.parse(src); } catch { return undefined; }
  }
  if (!Array.isArray(src)) return undefined;
  const out: Array<{ type: "service" | "product"; id: number; qty: number }> = [];
  for (const raw of src) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = String(r.type ?? "").toLowerCase() === "product" ? "product" : "service";
    const id = parseInteger(r.id ?? r.service_id ?? r.product_id, 0);
    const qty = Math.max(1, parseInteger(r.qty ?? r.quantity, 1));
    if (id > 0) out.push({ type, id, qty });
  }
  return out.length ? out : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "si"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return undefined;
}

function packageMetaString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function normalizeItemType(value: string): PosSaleItemType | null {
  if (value === "service" || value === "product" || value === "prepaid" || value === "giftcard" || value === "package" || value === "giftbox" || value === "recharge") return value;
  return null;
}

function normalizePaymentMethod(value: string): PosPaymentMethod {
  if (value === "cash" || value === "card" || value === "check" || value === "transfer" || value === "giftcard" || value === "wallet") return value;
  if (value === "assegno") return "check"; // preserve Assegno (was folded to transfer)
  if (value === "bank" || value === "bonifico") return "transfer";
  return "card";
}

function normalizeStockCancelMode(value: string | undefined): "restore" | "no_restore" | "none" {
  if (value === "no_restore") return "no_restore";
  if (value === "none") return "none";
  return "restore";
}

// Normalize a fidelity-points storno mode to "normal" | "negative" | "skip". Default "normal"
// (fails safe — the void throws on insufficient balance). Port of pos_history.php ~1120-1121:
// strtolower(trim(... ?? 'normal')); anything not in the whitelist collapses to "normal".
function normalizePointsStornoMode(value: unknown): PointsStornoMode {
  const v = String(value ?? "normal").trim().toLowerCase();
  if (v === "negative" || v === "skip") return v;
  return "normal";
}

// Parse recharge_points_storno_mode: an object/array keyed by recharge id → mode string. Port
// of pos_history.php ~1122-1124 + the per-recharge read at ~1762-1763 (default "normal" per id).
// Accepts both a plain object ({ "12": "skip" }) and JSON-encoded string; ignores non-numeric
// keys and normalizes each value.
function normalizeRechargePointsModes(value: unknown): Record<number, PointsStornoMode> {
  const out: Record<number, PointsStornoMode> = {};
  let src: unknown = value;
  if (typeof src === "string") {
    try {
      src = JSON.parse(src);
    } catch {
      return out;
    }
  }
  if (!src || typeof src !== "object") return out;
  for (const [key, val] of Object.entries(src as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0) continue;
    out[id] = normalizePointsStornoMode(val);
  }
  return out;
}
