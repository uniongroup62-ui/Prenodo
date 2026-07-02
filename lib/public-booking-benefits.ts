import "server-only";

// STEP 6 del booking pubblico — port of the legacy benefit resolution used by
// booking.php mode=coupon (:5322), mode=promotion_preview (:5580) and the
// confirm benefit block (:7600-7960):
//  * a code matching promotions.coupon_code is a PROMOTION (per-service prices,
//    never saved as coupon);
//  * a classic coupon is validated per cart/context; a NON-stackable auto promo
//    shrinks its base to the non-discounted services (previewDbCoupon-style),
//    a stackable one applies alongside on the post-promo base;
//  * with no (valid) code the BEST automatic promotion applies (preferred id
//    wins when eligible) with the per-service breakdown;
//  * the confirm persists NO discount columns: the coupon lives in the notes
//    lines ("Coupon: X" + "Sconto coupon: - € y"), the promotion in the
//    per-service prices + promotion_id + "Promozione: T" note (legacy INSERT).

import {
  evalBestPromotionForAppointment,
  evalPromotionCodeForAppointment,
  previewDbCoupon,
  type AppointmentPromoContext,
} from "@/lib/db-repositories";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

export type PublicBookingBenefitResolution = {
  // Classic coupon actually applied (null when none / when the code was a promotion).
  couponCode: string | null;
  couponDiscount: number;
  // Promotion applied (by code, preferred or best-auto).
  promotionId: number | null;
  promotionTitle: string;
  promoDiscount: number;
  // Per-service promo prices for appointment_services (price/list_price/badge).
  serviceOverrides: Array<{ serviceId: number; price: number; listPrice: number; badge: string }>;
  // Legacy autoNote lines to append to appointments.notes.
  noteLines: string[];
  totalDiscount: number;
  // Set when a typed code exists but is not applicable (surfaced by mode=coupon).
  couponError: string | null;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const moneyIt = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Legacy booking_resolve_client_id_for_promos: best-effort client match by
// email first, then phone (for the promo target rules new/inactive/birthday).
export async function resolvePublicClientIdForPromos(
  slug: string,
  email: string | null,
  phone: string | null,
): Promise<number | null> {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (normalizedEmail) {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "clients",
      columns: "id",
      where: "LOWER(TRIM(COALESCE(email,''))) = ?",
      params: [normalizedEmail],
      orderBy: "id ASC",
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const id = Number(rows[0]?.id ?? 0);
    if (id > 0) return id;
  }
  const normalizedPhone = String(phone ?? "").replace(/\s+/g, "");
  if (normalizedPhone) {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "clients",
      columns: "id",
      where: "REPLACE(COALESCE(phone,''), ' ', '') = ?",
      params: [normalizedPhone],
      orderBy: "id ASC",
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const id = Number(rows[0]?.id ?? 0);
    if (id > 0) return id;
  }
  return null;
}

function promoNotes(ctx: AppointmentPromoContext): { overrides: PublicBookingBenefitResolution["serviceOverrides"]; note: string } {
  const overrides = ctx.services.map((line) => ({
    serviceId: line.service_id,
    price: line.booked_price,
    listPrice: line.list_price,
    badge: line.discount_badge,
  }));
  const title = ctx.promotion?.title?.trim() ?? "";
  const note = `Promozione: ${title !== "" ? title : `#${ctx.promotion?.id ?? 0}`}`;
  return { overrides, note };
}

export async function resolvePublicBookingBenefits({
  slug,
  serviceIds,
  subtotal,
  date,
  time,
  clientId,
  locationId,
  couponCode,
  preferredPromotionId,
}: {
  slug: string;
  serviceIds: number[];
  // Catalog subtotal of the selected services (the coupon base before promo).
  subtotal: number;
  date: string;
  time: string | null;
  clientId: number | null;
  locationId: number | null;
  couponCode?: string | null;
  preferredPromotionId?: number | null;
}): Promise<PublicBookingBenefitResolution> {
  const result: PublicBookingBenefitResolution = {
    couponCode: null,
    couponDiscount: 0,
    promotionId: null,
    promotionTitle: "",
    promoDiscount: 0,
    serviceOverrides: [],
    noteLines: [],
    totalDiscount: 0,
    couponError: null,
  };
  const code = String(couponCode ?? "").trim().toUpperCase();

  // 1) Codice = promozione con coupon_code -> promo pura, mai salvata come coupon.
  if (code) {
    const byCode = await evalPromotionCodeForAppointment({ slug, code, serviceIds, date, time, clientId, locationId });
    if (byCode.found) {
      if (!byCode.ok) {
        result.couponError = byCode.reason || "Promozione non applicabile.";
        return result;
      }
      const { overrides, note } = promoNotes(byCode.context);
      result.promotionId = byCode.context.promotion?.id ?? null;
      result.promotionTitle = byCode.context.promotion?.title ?? "";
      result.promoDiscount = round2(byCode.context.discount);
      result.serviceOverrides = overrides;
      result.noteLines = [note];
      result.totalDiscount = result.promoDiscount;
      return result;
    }
  }

  // Best automatic promotion (preferred id wins when eligible) — evaluated in
  // BOTH the coupon and the no-coupon paths (the legacy stacks/limits with it).
  const autoPromo = await evalBestPromotionForAppointment({
    slug,
    serviceIds,
    date,
    time,
    clientId,
    locationId,
    preferredPromotionId: preferredPromotionId ?? null,
  });

  // 2) Coupon classico.
  if (code) {
    let couponBase = round2(Math.max(0, subtotal));
    let couponServiceIds = serviceIds;
    if (autoPromo.applied && autoPromo.promotion) {
      if (autoPromo.promotion.stackable_with_coupon) {
        // Cumulabile: il coupon si applica sulla base POST-promo.
        couponBase = round2(Math.max(0, subtotal - autoPromo.discount));
      } else {
        // Non cumulabile: base ridotta ai soli servizi NON scontati dalla promo
        // (coupon_eval_after_promotion with allowCouponOnPromoItems=false).
        const discounted = new Set(autoPromo.services.map((line) => line.service_id));
        couponServiceIds = serviceIds.filter((id) => !discounted.has(id));
        const discountedBooked = autoPromo.services.reduce((sum, line) => sum + Math.max(0, line.booked_price), 0);
        couponBase = round2(Math.max(0, subtotal - autoPromo.discount - discountedBooked));
        if (!couponServiceIds.length || couponBase <= 0.000001) {
          result.couponError = "Il coupon non è applicabile agli elementi già in promozione per questa campagna.";
          // La promo automatica resta applicata anche quando il coupon è rifiutato.
          const { overrides, note } = promoNotes(autoPromo);
          result.promotionId = autoPromo.promotion.id;
          result.promotionTitle = autoPromo.promotion.title;
          result.promoDiscount = round2(autoPromo.discount);
          result.serviceOverrides = overrides;
          result.noteLines = [note];
          result.totalDiscount = result.promoDiscount;
          return result;
        }
      }
    }
    const preview = await previewDbCoupon(code, couponBase, slug, {
      serviceIds: couponServiceIds,
      locationId,
      clientId,
      appointmentId: null,
      apptDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      apptTime: time,
    });
    if (preview.valid && preview.discount > 0) {
      result.couponCode = code;
      result.couponDiscount = round2(Math.min(couponBase, preview.discount));
      result.noteLines.push(`Coupon: ${code}`);
      result.noteLines.push(`Sconto coupon: - € ${moneyIt(result.couponDiscount)}`);
    } else {
      result.couponError = preview.reason || "Coupon non valido o scaduto.";
    }
  }

  // 3) Promo automatica applicata (con o senza coupon cumulato).
  if (autoPromo.applied && autoPromo.promotion) {
    const { overrides, note } = promoNotes(autoPromo);
    result.promotionId = autoPromo.promotion.id;
    result.promotionTitle = autoPromo.promotion.title;
    result.promoDiscount = round2(autoPromo.discount);
    result.serviceOverrides = overrides;
    result.noteLines.push(note);
  }

  result.totalDiscount = round2(result.couponDiscount + result.promoDiscount);
  return result;
}
