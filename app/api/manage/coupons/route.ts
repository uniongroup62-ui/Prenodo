import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { todayIso } from "@/lib/appointment-engine";
import { cancelManageCoupon, createDbCoupon, deleteManageCoupon, evalBestPromotionForAppointment, getCouponFormContext, getManageCoupon, listDbCoupons, listManageCoupons, previewDbCoupon, redeemDbCoupon, saveManageCoupon } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
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
      const coupon = await getManageCoupon(tenantSlug, couponId);
      if (!coupon) return jsonError("Coupon non trovato.", 404);
      return Response.json({ ok: true, source: "coupons?action=get", sourceMode: "database", coupon });
    }

    // Coupon NEW/EDIT form context: catalog options (service/product categories
    // + services + products) + active sedi, for the scope multi-selects and the
    // Sedi abilitate table. Gated by coupons.manage like the editor.
    if (url.searchParams.get("action") === "form_context") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      return Response.json({ ok: true, source: "coupons?action=form_context", sourceMode: "database", context: await getCouponFormContext(tenantSlug) });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      coupons: await listManageCoupons(tenantSlug),
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
      const coupon = await saveManageCoupon(tenantSlug, body, parseInteger(body.id, 0));
      return Response.json({ ok: true, source: "coupons?action=save", sourceMode: "database", coupon, coupons: await listManageCoupons(tenantSlug) });
    }

    // Delete a coupon (port of coupons.php action=delete). Refuses while open
    // appointments reference it; soft-deletes when used (history preserved),
    // hard-deletes when unused.
    if (action === "delete") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      const result = await deleteManageCoupon(tenantSlug, parseInteger(body.id, 0), session.user.id);
      return Response.json({ ok: true, source: "coupons?action=delete", sourceMode: "database", mode: result.mode, message: result.message, coupons: await listManageCoupons(tenantSlug) });
    }

    // Disable a coupon (port of coupons.php action=cancel): is_active=0 + audit.
    if (action === "cancel" || action === "disable") {
      if (!can(session.user.perms, "coupons.manage")) return jsonError("Permesso buoni mancante.", 403);
      await cancelManageCoupon(tenantSlug, parseInteger(body.id, 0), String(body.cancel_reason ?? body.reason ?? ""), session.user.id);
      return Response.json({ ok: true, source: "coupons?action=cancel", sourceMode: "database", coupons: await listManageCoupons(tenantSlug) });
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
    // and the editing appointment id. All optional + backward-compatible — the POS preview
    // (which posts only { code, subtotal }) is unchanged. Currently only appt_date changes the
    // outcome (active-window validated as of the booked day); see previewDbCoupon.
    const serviceIds = String(body.service_ids ?? "")
      .split(",")
      .map((v) => parseInteger(v, 0))
      .filter((n) => n > 0);
    const locationId = parseInteger(body.location_id, 0) || null;
    const clientId = parseInteger(body.client_id, 0) || null;
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
