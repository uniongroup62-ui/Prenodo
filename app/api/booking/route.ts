import { todayIso } from "@/lib/appointment-engine";
import { parseRequestBody } from "@/lib/api-utils";
import {
  applyAppointmentGiftRedeems,
  applyAppointmentGiftboxRedeems,
  applyAppointmentPackageRedeems,
  applyAppointmentPrepaidRedeems,
  evalBestPromotionForAppointment,
  fidelityIsClientAdhering,
  publicBookingServiceCatalogPromos,
  type AppointmentGiftRedeem,
  type AppointmentGiftboxRedeem,
  type AppointmentPackageRedeem,
  type AppointmentPrepaidRedeem,
} from "@/lib/db-repositories";
import {
  confirmPublicBooking,
  holdPublicBookingSlot,
  publicBookingClosures,
  publicBookingContext,
  publicBookingSlots,
  publicBookingStaffPerService,
  releasePublicBookingHold,
} from "@/lib/public-booking-db";
import {
  applyPublicCustomerBenefits,
  publicCustomerBenefitsPreview,
  resolvePublicBookingBenefits,
  resolvePublicClientIdForPromos,
} from "@/lib/public-booking-benefits";
import {
  currentPublicCustomerSession,
  publicCustomerActivities,
  upsertPublicCustomerFromBooking,
} from "@/lib/public-customer-account";
import { computeCampaignEarn, getFidelityEarnSettings } from "@/lib/manage-pos";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

// The LOGGED public customer's clientId for THIS tenant (session cookie ->
// public_customer_tenant_links). The legacy gates the fidelity/credit/giftcard
// benefits on BookingAuth::user().client_id — never on request params.
async function publicSessionClientId(slug: string): Promise<number> {
  const session = await currentPublicCustomerSession().catch(() => null);
  if (!session) return 0;
  const activities = await publicCustomerActivities(session.id).catch(() => []);
  const match = activities.find((a) => a.tenantSlug === slug);
  return Math.max(0, Number(match?.clientId ?? 0) || 0);
}

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
      const staffMap = parseStaffMap(url.searchParams.get("staff_map"));
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const slots = await publicBookingSlots({ slug, date, serviceIds, staffId, staffMap, locationId });

      return Response.json({
        ok: true,
        sourceMode: "database",
        date,
        slots,
      });
    }

    // Operatori idonei PER SERVIZIO (port di booking.php mode=staff): il wizard
    // rende un gruppo per servizio quando la scelta operatore è attiva.
    if (action === "staff") {
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("services"));
      const locationId = parseOptionalId(url.searchParams.get("location_id"));
      const services = await publicBookingStaffPerService(slug, serviceIds, locationId);
      return Response.json({ ok: true, sourceMode: "database", per_service: true, services });
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
        closure_ranges: closures.closureRanges,
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
        promo_conditions: benefits.promotionConditions,
        // Breakdown per-servizio (listino barrato + prezzo scontato + badge) per
        // il recap, dagli serviceOverrides (renderPriceHtml legacy).
        breakdown: Object.fromEntries(
          benefits.serviceOverrides.map((o) => [o.serviceId, { old: o.listPrice, now: o.price, badge: o.badge }]),
        ),
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
        promo_conditions: promo.promotion.promoConditions,
        stackable: promo.promotion.stackable,
        // breakdown prezzi per servizio: {serviceId: {old, now, badge}} (legacy shape).
        breakdown: Object.fromEntries(promo.services.map((line) => [line.service_id, { old: line.list_price, now: line.booked_price, badge: line.discount_badge }])),
        subtotal,
        discount,
        total: Math.max(0, Math.round((subtotal - discount + Number.EPSILON) * 100) / 100),
      });
    }

    // STEP 6 "Vantaggi" (port of booking.php mode=fidelity_preview, narrowed to the
    // three public panels): the LOGGED customer's fidelity points (+ suggested full
    // redeem for this cart), spendable credit and active giftcards. The clientId
    // comes from the customer SESSION only — an anonymous request gets empty panels.
    if (action === "fidelity_preview") {
      const serviceIds = parseIdList(url.searchParams.get("service_ids") ?? url.searchParams.get("services"));
      const clientId = await publicSessionClientId(slug);
      const subtotal = await publicCartSubtotal(slug, serviceIds);
      const priorDiscount = Math.max(0, Number.parseFloat(String(url.searchParams.get("discount") ?? "0").replace(",", ".")) || 0);
      const preview = await publicCustomerBenefitsPreview({ slug, clientId, subtotal, priorDiscount });
      // Punti MATURATI (nota "guadagnerai N Punti"): come il POS, accreditati solo
      // sotto una campagna earn ATTIVA (computeCampaignEarn => 0 senza campagna),
      // con fidelity attiva + tessera del cliente.
      let earnPoints = 0;
      if (preview.fidelity.enabled && clientId > 0) {
        const earnSettings = await getFidelityEarnSettings(slug).catch(() => null);
        if (earnSettings?.enabled && (await fidelityIsClientAdhering(slug, clientId).catch(() => false))) {
          earnPoints = (await computeCampaignEarn(slug, subtotal, clientId, earnSettings.earnStep).catch(() => ({ points: 0 }))).points;
        }
      }
      return Response.json({
        ok: true,
        logged: clientId > 0 ? 1 : 0,
        enabled: preview.fidelity.enabled ? 1 : 0,
        earn_points: earnPoints,
        redeem_enabled: preview.fidelity.redeemEnabled ? 1 : 0,
        available_points: preview.fidelity.pointsAvailable,
        euro_per_point: preview.fidelity.euroPerPoint,
        min_points: preview.fidelity.minPoints,
        points_used: preview.fidelity.suggestedPoints,
        discount: preview.fidelity.suggestedDiscount,
        points_label: preview.fidelity.label,
        credit_available: preview.creditAvailable,
        giftcards: preview.giftcards,
      });
    }

    const context = await publicBookingContext(slug);

    // serviceCatalogPromotions (booking.php 3081-3126): badge promo di catalogo
    // per-servizio, calcolati una volta col cliente loggato + la sede di default
    // (o quella richiesta). Resi sulle card prima della scelta di una data.
    const catalogClientId = await publicSessionClientId(slug).catch(() => 0);
    const catalogLocationId = parseOptionalId(url.searchParams.get("location_id")) || Number(context.locations[0]?.id ?? 0) || 0;
    context.serviceCatalogPromotions = await publicBookingServiceCatalogPromos(
      slug,
      context.services.map((s) => s.id),
      catalogClientId,
      catalogLocationId,
    ).catch(() => ({}));

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
      const staffMap = parseStaffMap(body.staff_map);
      const locationId = parseOptionalId(body.location_id);
      const ownerKey = ownerKeyForRequest(request, body.owner_key);
      // Write action: a real booking must hit the DB. On failure, surface the
      // error so the client can retry instead of confirming a reservation that
      // was never persisted.
      const hold = await holdPublicBookingSlot({ slug, date, time, serviceIds, staffId, staffMap, locationId, ownerKey });

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
      staffMap: parseStaffMap(body.staff_map),
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

    // STEP 6 "Vantaggi" application (legacy confirm ~8053-8395): fidelity points
    // reserve -> giftcard -> credito, each re-validated + clamped server-side and
    // ONLY when the logged customer session owns the booked client (the legacy
    // credit gate: BookingAuth::user().client_id === client_id). Best-effort: a
    // benefit failure never fails the confirmed booking.
    let appliedBenefits: Awaited<ReturnType<typeof applyPublicCustomerBenefits>> | null = null;
    const wantsBenefits =
      Number(body.fidelity_points_use ?? 0) > 0 ||
      Number(String(body.credit_use ?? "0").replace(",", ".")) > 0 ||
      Boolean(body.giftcard_redeem);
    const wantsResidualRedeems =
      Boolean(body.package_redeem) || Boolean(body.prepaid_service_redeem) || Boolean(body.giftbox_redeem) || Boolean(body.gift_redeem);
    if (wantsBenefits || wantsResidualRedeems) {
      const sessionClientId = await publicSessionClientId(slug);
      if (sessionClientId > 0 && sessionClientId === confirmation.clientId) {
        if (wantsBenefits) {
          appliedBenefits = await applyPublicCustomerBenefits({
            slug,
            appointmentId: confirmation.id,
            clientId: sessionClientId,
            subtotal: await publicCartSubtotal(slug, confirmServiceIds),
            priorDiscount: benefits.totalDiscount,
            requestedPoints: Math.max(0, Math.floor(Number(body.fidelity_points_use ?? 0) || 0)),
            requestedCredit: Math.max(0, Number.parseFloat(String(body.credit_use ?? "0").replace(",", ".")) || 0),
            giftcardRedeems: parseGiftcardRedeem(body.giftcard_redeem),
          }).catch(() => null);
        }
        // DEEP-LINK "prenota da residuo" (legacy book_package / book_prepaid /
        // book_giftbox / book_omaggio, booking.php 2226-2331 + confirm redeem):
        // apply the requested residual to the covered service, with the same
        // server-side re-validation + zero-charge the manage save uses. Each is
        // best-effort — an inapplicable redeem never fails the booking.
        if (wantsResidualRedeems) {
          const packageRedeems = parseJsonRedeems<AppointmentPackageRedeem>(body.package_redeem, (row) => ({
            clientPackageId: toId(row.client_package_id),
            serviceId: toId(row.service_id),
            clientPackageServiceId: toId(row.client_package_service_id) || null,
          })).filter((r) => r.clientPackageId > 0 && r.serviceId > 0);
          const prepaidRedeems = parseJsonRedeems<AppointmentPrepaidRedeem>(body.prepaid_service_redeem, (row) => ({
            clientPrepaidServiceId: toId(row.client_prepaid_service_id ?? row.prepaid_service_id),
            serviceId: toId(row.service_id),
          })).filter((r) => r.clientPrepaidServiceId > 0 && r.serviceId > 0);
          const giftboxRedeems = parseJsonRedeems<AppointmentGiftboxRedeem>(body.giftbox_redeem, (row) => ({
            instanceId: toId(row.instance_id),
            giftboxItemId: toId(row.giftbox_item_id),
            serviceId: toId(row.service_id),
          })).filter((r) => r.instanceId > 0 && r.giftboxItemId > 0 && r.serviceId > 0);
          const giftRedeems = parseJsonRedeems<AppointmentGiftRedeem>(body.gift_redeem, (row) => ({
            instanceId: toId(row.instance_id),
            rewardItemIndex: Math.max(0, toId(row.reward_item_index)),
            serviceId: toId(row.service_id),
          })).filter((r) => r.instanceId > 0 && r.serviceId > 0);
          const common = { slug, appointmentId: confirmation.id, clientId: sessionClientId, serviceIds: confirmServiceIds };
          if (packageRedeems.length) await applyAppointmentPackageRedeems({ ...common, redeems: packageRedeems }).catch(() => undefined);
          if (prepaidRedeems.length) await applyAppointmentPrepaidRedeems({ ...common, redeems: prepaidRedeems }).catch(() => undefined);
          if (giftboxRedeems.length) await applyAppointmentGiftboxRedeems({ ...common, redeems: giftboxRedeems }).catch(() => undefined);
          if (giftRedeems.length) await applyAppointmentGiftRedeems({ ...common, redeems: giftRedeems }).catch(() => undefined);
        }
      }
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      confirmation,
      accountLinked: Boolean(linkedAccount),
      ...(appliedBenefits
        ? {
            fidelity_points_used: appliedBenefits.fidelityPoints,
            fidelity_discount: appliedBenefits.fidelityDiscount,
            credit_used: appliedBenefits.creditUsed,
            giftcard_used: appliedBenefits.giftcardUsed,
          }
        : {}),
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

// staff_map (booking.php parse_staff_map): JSON { "<serviceId>": <staffId> } ->
// Record<number, number>, scartando chiavi/valori non positivi. null se assente
// o non valido (il backend ricade su operatore singolo/qualsiasi).
function parseStaffMap(value: unknown): Record<number, number> | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<number, number> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      const sid = Number.parseInt(key, 10);
      const staffId = Number.parseInt(String(val), 10);
      if (sid > 0 && staffId > 0) out[sid] = staffId;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function parseOptionalId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Generic JSON redeem list parser: a JSON STRING array (or single object) whose
// rows are mapped by `map`; malformed input yields [].
function toId(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function parseJsonRedeems<T>(value: unknown, map: (row: Record<string, unknown>) => T): T[] {
  if (!value) return [];
  try {
    const decoded = typeof value === "string" ? JSON.parse(value) : value;
    const list = Array.isArray(decoded) ? decoded : [decoded];
    return list.filter((row) => row && typeof row === "object").map((row) => map(row as Record<string, unknown>));
  } catch {
    return [];
  }
}

// giftcard_redeem arrives as a JSON STRING [{giftcard_id, amount}] (like the
// manage drawer) or a single {giftcard_id, amount} object.
function parseGiftcardRedeem(value: unknown): Array<{ giftcard_id: number; amount: number }> {
  if (!value) return [];
  try {
    const decoded = typeof value === "string" ? JSON.parse(value) : value;
    const list = Array.isArray(decoded) ? decoded : [decoded];
    return list
      .map((row) => ({
        giftcard_id: Number.parseInt(String((row as Record<string, unknown>)?.giftcard_id ?? (row as Record<string, unknown>)?.id ?? "0"), 10) || 0,
        amount: Math.max(0, Number.parseFloat(String((row as Record<string, unknown>)?.amount ?? "0").replace(",", ".")) || 0),
      }))
      .filter((r) => r.giftcard_id > 0 && r.amount > 0);
  } catch {
    return [];
  }
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
