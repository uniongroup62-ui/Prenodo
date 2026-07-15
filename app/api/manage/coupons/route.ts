import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { todayIso } from "@/lib/appointment-engine";
import { cancelManageCoupon, couponGenerateCode, createDbCoupon, deleteManageCoupon, evalBestPromotionForAppointment, getCouponFormContext, getManageCoupon, listDbCoupons, listManageCoupons, posPreviewDiscount, previewDbCoupon, redeemDbCoupon, saveManageCoupon, type CouponPreviewItem, type PosPreviewCartInput } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CouponType = "fixed" | "percent";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, ["coupons.manage", "pos.manage"])) return jsonError("Permesso buoni mancante.", 403);

  try {
    const url = new URL(request.url);

    // Edit-form prefill: return ONE coupon's editable fields for one id. Port of
    // coupons.php action=edit. Gated by coupons.manage like the save action.
    if (url.searchParams.get("action") === "get") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      const couponId = parseInteger(url.searchParams.get("id"), 0);
      if (couponId <= 0) return jsonError("ID coupon mancante.");
      // getManageCoupon throws "Coupon gia eliminato dalla gestione" for a
      // soft-deleted coupon (legacy: warning redirect to the list); a missing
      // one is the querystring "Coupon non trovato" (danger redirect).
      try {
        const coupon = await getManageCoupon(tenantSlug, couponId);
        if (!coupon) return Response.json({ ok: false, error: "Coupon non trovato", errorType: "danger" }, { status: 404 });
        return Response.json({ ok: true, source: "coupons?action=get", sourceMode: "database", coupon });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Coupon non trovato";
        const errorType = message === "Coupon gia eliminato dalla gestione" ? "warning" : "danger";
        return Response.json({ ok: false, error: message, errorType }, { status: 404 });
      }
    }

    // Coupon NEW/EDIT form context: catalog options (service/product categories
    // + services + products) + active sedi, for the scope multi-selects and the
    // Sedi abilitate table. Gated by coupons.manage like the editor.
    if (url.searchParams.get("action") === "form_context") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      // currentLocationId: on NEW the legacy pre-checks ONLY the session's
      // current sede (falling back to all when none is resolved).
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      return Response.json({
        ok: true,
        source: "coupons?action=form_context",
        sourceMode: "database",
        context: await getCouponFormContext(tenantSlug),
        currentLocationId: locationContext?.currentLocationId ?? 0,
      });
    }

    // Server-side code generation (port of coupons.php ?do=gen_code): unique vs
    // existing coupons AND vs Promotion coupon codes.
    if (url.searchParams.get("action") === "gen_code") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      return Response.json({ ok: true, source: "coupons?do=gen_code", sourceMode: "database", code: await couponGenerateCode(tenantSlug) });
    }

    // LIST (default). Legacy filters by the session's current sede unless
    // all_locations=1 ([] enabled sedi = valid everywhere); the empty state and
    // the "Nuovo coupon" header button key off the UNFILTERED count, and the
    // "Tutte le sedi" filter card only renders for multi-sede tenants.
    const allCoupons = await listManageCoupons(tenantSlug);
    const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
    const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
    const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
    const coupons = filterLocationId > 0
      ? allCoupons.filter((c) => c.locationIds.length === 0 || c.locationIds.includes(filterLocationId))
      : allCoupons;
    return Response.json({
      ok: true,
      sourceMode: "database",
      coupons,
      totalCount: allCoupons.length,
      locationsCount: locationContext?.locations.length ?? 0,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore coupon.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const body = await parseRequestBody(request);
  const action = body.action ?? "preview";

  try {
    if (action === "create") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      const input = {
        code: body.code,
        type: normalizeCouponType(body.type),
        value: parseNumber(body.value, 0),
        minSubtotal: parseNumber(body.min_subtotal, 0),
        startsAt: body.starts_at,
        endsAt: body.ends_at,
        usageLimit: parseInteger(body.usage_limit, 100),
      };
      const coupon = await createDbCoupon(input, tenantSlug);
      return Response.json({ ok: true, source: "coupons?action=create", sourceMode: "database", coupon, coupons: await listManageCoupons(tenantSlug) });
    }

    // Faithful coupon editor save (port of coupons.php POST action=new|edit). id=0
    // creates, id>0 updates; the code is immutable on edit.
    if (action === "save" || action === "new" || action === "edit" || action === "update") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      const coupon = await saveManageCoupon(tenantSlug, body, parseInteger(body.id, 0), session.user.id);
      // Avviso non-bloccante (modifica di un buono con prenotazioni aperte): la
      // UI lo mostra come flash 'warning' oltre al successo del salvataggio.
      const warning = coupon.editWarning ?? "";
      return Response.json({ ok: true, source: "coupons?action=save", sourceMode: "database", coupon, warning, coupons: await listManageCoupons(tenantSlug) });
    }

    // Delete a coupon (port of coupons.php action=delete). Refuses while open
    // appointments reference it; soft-deletes when used (history preserved),
    // hard-deletes when unused.
    if (action === "delete") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      // Legacy outcome mapping: not-found -> danger flash on the list; already
      // deleted -> warning on the list; open appointments -> warning flash on
      // the EDIT page (redirectEdit). Successes flash success on the list.
      try {
        const result = await deleteManageCoupon(tenantSlug, parseInteger(body.id, 0), session.user.id);
        return Response.json({ ok: true, source: "coupons?action=delete", sourceMode: "database", mode: result.mode, message: result.message, msgType: "success", coupons: await listManageCoupons(tenantSlug) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Errore coupon.";
        const errorType = message === "Coupon non trovato" ? "danger" : "warning";
        const redirectEdit = message.startsWith("Coupon associato a prenotazioni");
        return Response.json({ ok: false, error: message, errorType, redirectEdit }, { status: 400 });
      }
    }

    // Disable a coupon (port of coupons.php action=cancel): is_active=0 + audit.
    if (action === "cancel" || action === "disable") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      // Legacy outcomes: not-found -> danger (list); "Coupon già disattivato."
      // -> warning flash on the edit page.
      try {
        await cancelManageCoupon(tenantSlug, parseInteger(body.id, 0), String(body.cancel_reason ?? body.reason ?? ""), session.user.id);
        return Response.json({ ok: true, source: "coupons?action=cancel", sourceMode: "database", coupons: await listManageCoupons(tenantSlug) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Errore coupon.";
        const errorType = message === "Coupon non trovato" ? "danger" : "warning";
        return Response.json({ ok: false, error: message, errorType }, { status: 400 });
      }
    }

    // Preview sconto della CASSA (port di pos.php mode=preview_discount): carrello
    // {type,id,qty} ricostruito dal listino server-side, promo-su-codice riconosciute,
    // coupon classico COMBINATO con la migliore auto-promo (stacked_with_coupon).
    // Stessa shape JSON del legacy; gate cassa come la pagina POS.
    if (action === "preview_discount") {
      if (!can(session.user.perms, "pos.manage")) return jsonError("Permesso cassa mancante.", 403);
      let rawItems: PosPreviewCartInput[] = [];
      try {
        const parsed = JSON.parse(String(body.items_json ?? body.items ?? "[]"));
        if (Array.isArray(parsed)) {
          rawItems = parsed.map((it: Record<string, unknown>) => ({
            type: String(it.type ?? ""),
            id: parseInteger(it.id, 0),
            qty: parseInteger(it.qty, 0),
            amount: parseNumber(it.amount, 0),
          }));
        }
      } catch {
        rawItems = [];
      }
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const preview = await posPreviewDiscount(tenantSlug, {
        code: String(body.code ?? ""),
        clientId: parseInteger(body.client_id, 0),
        locationId: parseInteger(body.location_id, 0) || locationContext?.currentLocationId || 0,
        quoteImportId: parseInteger(body.quote_import_id, 0),
        items: rawItems,
      });
      return Response.json({ ...preview, source: "pos?mode=preview_discount", sourceMode: "database" });
    }

    // preview/redeem are also reachable from the quick-booking drawer's coupon Apply
    // (port of api_appointments action=coupon_preview), so a booking-capable user must be
    // able to validate a coupon even without the coupons/pos management permission.
    if (!canAny(session.user.perms, ["coupons.manage", "pos.manage", "appointments.manage", "appointments.plan", "appointments.quick_booking"])) {
      return jsonError("Permesso buoni mancante.", 403);
    }

    if (action === "redeem") {
      const code = body.code ?? "";
      const subtotal = parseNumber(body.subtotal, 0);
      const result = await redeemDbCoupon(code, subtotal, tenantSlug);
      return Response.json({ ok: true, source: "coupons?action=redeem", sourceMode: "database", ...result, coupons: await listDbCoupons(tenantSlug) });
    }

    const code = body.code ?? "";
    const subtotal = parseNumber(body.subtotal, 0);
    // Booking context forwarded by the quick-booking drawer (port of the legacy
    // action=coupon_preview inputs): service ids, location, appointment date/time, client id
    // and the editing appointment id. The POS preview posts items_json (cart lines
    // {type, id, line}) like the legacy mode=preview_discount, so apply_scope
    // restrictions bite on the real cart; without items/service_ids the eligible
    // base falls back to the subtotal for the all/all_services_products scopes.
    const serviceIds = String(body.service_ids ?? "")
      .split(",")
      .map((v) => parseInteger(v, 0))
      .filter((n) => n > 0);
    let items: CouponPreviewItem[] | undefined;
    try {
      const parsed = JSON.parse(String(body.items_json ?? "[]"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        items = parsed
          .map((it: Record<string, unknown>) => ({
            type: String(it.type ?? "") === "product" ? ("product" as const) : ("service" as const),
            id: parseInteger(it.id, 0),
            line: Math.max(0, parseNumber(it.line, 0)),
            categoryId: parseInteger(it.category_id ?? it.categoryId, 0) || null,
          }))
          .filter((it) => it.id > 0 && ["service", "product"].includes(String((it as { type: string }).type)) && it.line > 0);
        if (!items.length) items = undefined;
      }
    } catch {
      items = undefined;
    }
    // Sede: quella esplicita, altrimenti la sede corrente di sessione (il POS
    // legacy valida sempre contro $posLocationId).
    const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
    const locationId = (parseInteger(body.location_id, 0) || locationContext?.currentLocationId || 0) || null;
    // Legacy semantics: client_id INVIATO ma 0 = "nessun cliente selezionato"
    // (un limite per-cliente allora esige la selezione); ASSENTE = flusso senza
    // cliente (limite non verificabile).
    const clientId = body.client_id === undefined ? null : parseInteger(body.client_id, 0);
    const apptDate = typeof body.appt_date === "string" ? body.appt_date : null;
    const apptTime = typeof body.appt_time === "string" ? body.appt_time : null;
    // Legacy coupon-vs-promo stacking (coupon_eval_after_promotion, called by the
    // legacy action=coupon_preview): when the AUTO promotion applied to these
    // services is NOT stackable-with-coupon, the coupon base shrinks to the
    // services the promo does NOT discount; nothing left => the coupon is refused
    // with the legacy reason. POS previews (no service_ids) are untouched.
    let effectiveSubtotal = subtotal;
    let effectiveServiceIds = serviceIds;
    if (serviceIds.length > 0) {
      const promoCtx = await evalBestPromotionForAppointment({
        slug: tenantSlug,
        serviceIds,
        date: apptDate && /^\d{4}-\d{2}-\d{2}$/.test(apptDate) ? apptDate : todayIso(),
        time: apptTime && /^\d{2}:\d{2}/.test(apptTime) ? apptTime.slice(0, 5) : null,
        clientId,
        locationId,
      });
      if (promoCtx.applied && promoCtx.promotion && !promoCtx.promotion.stackable_with_coupon) {
        const discounted = new Set(promoCtx.services.map((line) => line.service_id));
        effectiveServiceIds = serviceIds.filter((id) => !discounted.has(id));
        // The drawer's subtotal already carries the promo booked prices, so the
        // non-promo base = subtotal minus the discounted lines' booked prices.
        const discountedBooked = promoCtx.services.reduce((sum, line) => sum + Math.max(0, line.booked_price), 0);
        effectiveSubtotal = Math.max(0, Math.round((subtotal - discountedBooked + Number.EPSILON) * 100) / 100);
        if (effectiveServiceIds.length === 0 || effectiveSubtotal <= 0.000001) {
          return Response.json({
            ok: true,
            source: "coupons?action=preview",
            sourceMode: "database",
            preview: { valid: false, discount: 0, reason: "Il coupon non è applicabile agli elementi già in promozione per questa campagna." },
            coupons: await listDbCoupons(tenantSlug),
          });
        }
      }
    }
    const preview = await previewDbCoupon(code, effectiveSubtotal, tenantSlug, {
      serviceIds: effectiveServiceIds,
      items,
      locationId,
      clientId,
      appointmentId: parseInteger(body.appointment_id, 0) || null,
      apptDate,
      apptTime,
    });
    return Response.json({ ok: true, source: "coupons?action=preview", sourceMode: "database", preview, coupons: await listDbCoupons(tenantSlug) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore coupon.");
  }
}

function normalizeCouponType(value: string | undefined): CouponType {
  return value === "percent" ? "percent" : "fixed";
}
