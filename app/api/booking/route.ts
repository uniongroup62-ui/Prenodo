import { todayIso } from "@/lib/appointment-engine";
import { parseRequestBody } from "@/lib/api-utils";
import { evalBestPromotionForAppointment } from "@/lib/db-repositories";
import {
  confirmPublicBooking,
  holdPublicBookingSlot,
  publicBookingClosures,
  publicBookingContext,
  publicBookingSlots,
  releasePublicBookingHold,
} from "@/lib/public-booking-db";
import { resolvePublicBookingBenefits, resolvePublicClientIdForPromos } from "@/lib/public-booking-benefits";
import { upsertPublicCustomerFromBooking } from "@/lib/public-customer-account";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

// Catalog subtotal for a public cart (service prices, qty 1 — legacy
// booking_build_cart_from_service_ids subtotal).
async function publicCartSubtotal(slug: string, serviceIds: number[]): Promise<number> {
  if (!serviceIds.length) return 0;
  const ph = serviceIds.map(() => "?").join(", ");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, price", where: `id IN (${ph})`, params: serviceIds }).catch(() => [] as RowDataPacket[]);
  const priceById = new Map(rows.map((r) => [Number(r.id ?? 0), Math.max(0, Number(r.price ?? 0) || 0)]));
  const subtotal = serviceIds.reduce((sum, id) => sum + (priceById.get(id) ?? 0), 0);
  return Math.round((subtotal + Number.EPSILON) * 100) / 100;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = normalizeSlug(url.searchParams.get("slug"));
  const action = url.searchParams.get("action") ?? "context";

  try {
    if (!slug) throw new Error("Attivita non specificata.");

    if (action === "slots") {
      const date = url.searchParams.get("date") ?? todayIso();
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("services"));
      const staffId = parseOptionalId(url.searchParams.get("staff_id"));
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const slots = await publicBookingSlots({ slug, date, serviceIds, staffId, locationId });

      return Response.json({
        ok: true,
        sourceMode: "database",
        date,
        slots,
      });
    }

    // Closed days for the date strip (port of booking.php mode=closures).
    if (action === "closures") {
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const closures = await publicBookingClosures(slug, locationId);
      return Response.json({
        ok: true,
        closed_dows: closures.closedDows,
        closed_dates: closures.closedDates,
        open_dates: closures.openDates,
      });
    }

    // Coupon free-text (port of booking.php mode=coupon): a code matching
    // promotions.coupon_code answers as a PROMOTION; a classic coupon is
    // validated per cart/context (with the promo-stacking base rules).
    if (action === "coupon") {
      const code = String(url.searchParams.get("code") ?? "").trim().toUpperCase();
      if (!code) return Response.json({ ok: false, error: "Codice coupon mancante." });
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("service_id"));
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const date = String(url.searchParams.get("appt_date") ?? url.searchParams.get("date") ?? "").trim() || todayIso();
      const time = String(url.searchParams.get("time") ?? "").trim() || null;
      const clientId = await resolvePublicClientIdForPromos(
        slug,
        url.searchParams.get("email"),
        url.searchParams.get("phone"),
      );
      const subtotal = await publicCartSubtotal(slug, serviceIds);
      const benefits = await resolvePublicBookingBenefits({
        slug,
        serviceIds,
        subtotal,
        date,
        time,
        clientId,
        locationId,
        couponCode: code,
        preferredPromotionId: parseOptionalId(url.searchParams.get("promotion_id")),
      });
      if (benefits.couponError) return Response.json({ ok: false, error: benefits.couponError });
      const total = Math.max(0, Math.round((subtotal - benefits.totalDiscount + Number.EPSILON) * 100) / 100);
      return Response.json({
        ok: true,
        code,
        subtotal,
        discount: benefits.totalDiscount,
        coupon_discount: benefits.couponDiscount,
        promotion_discount: benefits.promoDiscount,
        total,
        is_promotion: benefits.couponCode ? 0 : 1,
        promotion_id: benefits.promotionId ?? 0,
        promotion_title: benefits.promotionTitle,
        stacked_with_coupon: benefits.couponCode && benefits.promotionId ? 1 : 0,
      });
    }

    // Best-auto-promo per cart (port of booking.php mode=promotion_preview).
    if (action === "promotion_preview") {
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("service_id"));
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const date = String(url.searchParams.get("appt_date") ?? url.searchParams.get("date") ?? "").trim() || todayIso();
      const time = String(url.searchParams.get("time") ?? "").trim() || null;
      const clientId = await resolvePublicClientIdForPromos(
        slug,
        url.searchParams.get("email"),
        url.searchParams.get("phone"),
      );
      const subtotal = await publicCartSubtotal(slug, serviceIds);
      const promo = await evalBestPromotionForAppointment({
        slug,
        serviceIds,
        date,
        time,
        clientId,
        locationId,
        preferredPromotionId: parseOptionalId(url.searchParams.get("promotion_id")),
      });
      if (!promo.applied || !promo.promotion) {
        return Response.json({ ok: true, eligible: false, subtotal, reason: promo.reason || "Nessuna promozione automatica applicabile." });
      }
      const discount = promo.discount;
      return Response.json({
        ok: true,
        eligible: true,
        promotion_id: promo.promotion.id,
        title: promo.promotion.title,
        stackable: promo.promotion.stackable,
        // breakdown prezzi per servizio: {serviceId: {old, now, badge}} (legacy shape).
        breakdown: Object.fromEntries(promo.services.map((line) => [line.service_id, { old: line.list_price, now: line.booked_price, badge: line.discount_badge }])),
        subtotal,
        discount,
        total: Math.max(0, Math.round((subtotal - discount + Number.EPSILON) * 100) / 100),
      });
    }

    const context = await publicBookingContext(slug);

    return Response.json({
      ok: true,
      sourceMode: "database",
      context,
    });
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const slug = normalizeSlug(body.slug ?? url.searchParams.get("slug"));
  const action = String(body.action ?? url.searchParams.get("action") ?? "confirm");

  try {
    if (!slug) throw new Error("Attivita non specificata.");

    if (action === "hold" || action === "hold_slot") {
      const date = String(body.date ?? todayIso());
      const time = String(body.time ?? "");
      const serviceIds = parseIdList(body.service_ids ?? body.services);
      const staffId = parseOptionalId(body.staff_id);
      const locationId = parseOptionalId(body.location_id);
      const ownerKey = ownerKeyForRequest(request, body.owner_key);
      // Write action: a real booking must hit the DB. On failure, surface the
      // error so the client can retry instead of confirming a reservation that
      // was never persisted.
      const hold = await holdPublicBookingSlot({ slug, date, time, serviceIds, staffId, locationId, ownerKey });

      return Response.json({
        ok: true,
        sourceMode: "database",
        hold,
      });
    }

    if (action === "release_hold") {
      const token = String(body.hold_token ?? body.appointment_hold_token ?? body.token ?? "");
      const ownerKey = ownerKeyForRequest(request, body.owner_key);
      const released = await releasePublicBookingHold({ slug, token, ownerKey });
      return Response.json({ ok: true, sourceMode: "database", released });
    }

    const benefit = parseBenefit(body.benefit_id);
    const ownerKey = ownerKeyForRequest(request, body.owner_key);
    // Benefit resolution SERVER-SIDE (never trusting the wizard's preview):
    // promo-by-code > classic coupon (with stacking rules) > best auto promo
    // (preferred benefit id wins when eligible). Per-service promo prices +
    // legacy notes lines land on the insert via `benefits`.
    const confirmServiceIds = parseIdList(body.service_ids ?? body.services);
    const confirmDate = String(body.date ?? todayIso());
    const confirmTime = String(body.time ?? "");
    const confirmLocationId = parseOptionalId(body.location_id);
    const promoClientId = await resolvePublicClientIdForPromos(
      slug,
      String(body.client_email ?? body.email ?? "") || null,
      String(body.client_phone ?? body.phone ?? "") || null,
    );
    const benefits = await resolvePublicBookingBenefits({
      slug,
      serviceIds: confirmServiceIds,
      subtotal: await publicCartSubtotal(slug, confirmServiceIds),
      date: confirmDate,
      time: confirmTime || null,
      clientId: promoClientId,
      locationId: confirmLocationId,
      couponCode: String(body.coupon_code ?? benefit.couponCode ?? ""),
      preferredPromotionId: parseOptionalId(body.promotion_id) ?? benefit.promotionId ?? null,
    });
    // Write action: a real booking must hit the DB. On failure, surface the
    // error (the outer catch returns {ok:false,error}) instead of confirming a
    // fake appointment the customer would believe was booked.
    const confirmation = await confirmPublicBooking({
      slug,
      date: confirmDate,
      time: confirmTime,
      serviceIds: confirmServiceIds,
      staffId: parseOptionalId(body.staff_id),
      locationId: confirmLocationId,
      ownerKey,
      holdToken: String(body.hold_token ?? body.appointment_hold_token ?? "") || null,
      clientName: String(body.client_name ?? body.customer_name ?? ""),
      clientEmail: String(body.client_email ?? body.email ?? ""),
      clientPhone: String(body.client_phone ?? body.phone ?? ""),
      notes: String(body.notes ?? ""),
      benefits,
    });
    const linkedAccount = await upsertPublicCustomerFromBooking({
      tenantSlug: slug,
      clientId: confirmation.clientId,
      email: String(body.client_email ?? body.email ?? ""),
      fullName: String(body.client_name ?? body.customer_name ?? ""),
      phone: String(body.client_phone ?? body.phone ?? ""),
    }).catch(() => null);

    return Response.json({
      ok: true,
      sourceMode: "database",
      confirmation,
      accountLinked: Boolean(linkedAccount),
    });
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}

function normalizeSlug(value: string | null | undefined): string {
  // Multi-tenant-clean: resolve the slug from the request only. No default to a
  // specific tenant — an empty slug surfaces a clear "attivita non specificata"
  // error rather than silently serving another center's data.
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function parseIdList(value: unknown): number[] {
  return String(value ?? "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => item > 0);
}

function parseOptionalId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBenefit(value: unknown): { couponCode?: string; promotionId?: number } {
  const raw = String(value ?? "");
  if (raw.startsWith("coupon:") && raw !== "coupon:demo") return {};
  if (raw.startsWith("promotion:")) return { promotionId: parseOptionalId(raw.split(":")[1]) ?? undefined };
  return {};
}

function ownerKeyForRequest(request: Request, value: unknown): string {
  const explicit = String(value ?? "").trim();
  if (explicit) return explicit.slice(0, 120);
  const ip = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "public";
  const agent = request.headers.get("user-agent") ?? "browser";
  return `${ip}:${agent}`.slice(0, 120);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Errore prenotazione.";
}
