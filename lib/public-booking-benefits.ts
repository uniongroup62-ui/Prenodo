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
  addDbWalletMovement,
  applyAppointmentGiftcardRedeem,
  dbWalletBalance,
  evalBestPromotionForAppointment,
  evalPromotionCodeForAppointment,
  fidelityIsClientAdhering,
  fidelityReservedPoints,
  getFidelityPointsSettings,
  previewDbCoupon,
  type AppointmentPromoContext,
} from "@/lib/db-repositories";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect, tenantUpdate } from "@/lib/tenant-db";

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

// ===================== STEP 6 "Vantaggi" — customer benefits =====================
// Port of the LOGGED-customer benefit panels (booking.php mode=fidelity_preview,
// ~5700-6522, narrowed to the three panels the step 6 shows: Punti Fidelity /
// Credito / GiftCard) + their application at confirm (~8053-8103 fidelity,
// ~8174-8302 giftcard, ~8336-8395 credito). SECURITY: the caller resolves the
// clientId from the PUBLIC CUSTOMER SESSION only (the legacy gates the credit
// use on BookingAuth::user().client_id === client_id) — never from request params.

export type PublicCustomerBenefitsPreview = {
  ok: boolean;
  // Fidelity redeem panel (#recFidelityBox): shown when the program + redeem are
  // enabled AND the client adheres AND has points.
  fidelity: {
    enabled: boolean;
    redeemEnabled: boolean;
    pointsAvailable: number;
    euroPerPoint: number;
    minPoints: number;
    // Suggested full redeem for THIS cart: min(points, floor(due/euroPerPoint)),
    // zeroed under the minimum (the toggle applies exactly this).
    suggestedPoints: number;
    suggestedDiscount: number;
    // Etichetta unità punti (businesses.fidelity_points_label, default 'Punti'):
    // usata dove il legacy usa fidLabel ("Disponibili: N <label>").
    label: string;
  };
  // Credito panel (#recCreditUseBox): the client's spendable wallet credit.
  creditAvailable: number;
  // GiftCard panel (#recGiftcardUseBox): the client's active spendable cards.
  giftcards: Array<{ id: number; code: string; balance: number }>;
};

export async function publicCustomerBenefitsPreview({
  slug,
  clientId,
  subtotal,
  priorDiscount = 0,
}: {
  slug: string;
  clientId: number;
  subtotal: number;
  priorDiscount?: number;
}): Promise<PublicCustomerBenefitsPreview> {
  const out: PublicCustomerBenefitsPreview = {
    ok: true,
    fidelity: { enabled: false, redeemEnabled: false, pointsAvailable: 0, euroPerPoint: 0.1, minPoints: 0, suggestedPoints: 0, suggestedDiscount: 0, label: "Punti" },
    creditAvailable: 0,
    giftcards: [],
  };
  if (clientId <= 0) return out;

  const due = Math.max(0, round2(subtotal - Math.max(0, priorDiscount)));

  // --- Fidelity (settings gate + adhesion + wallet points) ---
  try {
    const settings = await getFidelityPointsSettings(slug);
    // Etichetta unità punti: SEMPRE esposta (non dipende da adesione/punti), come
    // FIDELITY_LABEL lato page nel legacy.
    out.fidelity.label = settings.pointsLabel;
    const programOn = settings.globalEnabled && settings.pointsEnabled;
    out.fidelity.enabled = programOn;
    out.fidelity.redeemEnabled = programOn && settings.redeemEnabled;
    out.fidelity.euroPerPoint = settings.redeemEuroPerPoint;
    out.fidelity.minPoints = settings.redeemMinPoints;
    if (out.fidelity.redeemEnabled && (await fidelityIsClientAdhering(slug, clientId).catch(() => false))) {
      const wallet = await dbWalletBalance(clientId, slug);
      // availablePoints = saldo − punti già riservati su altri appuntamenti
      // pending/scheduled (Fidelity::availablePoints, booking.php 6136); usare il
      // saldo LORDO gonfia i punti/sconto e sovra-riserva al confirm.
      const reserved = await fidelityReservedPoints(slug, clientId).catch(() => 0);
      const available = Math.max(0, Math.floor((Number(wallet.points ?? 0) || 0) - reserved));
      out.fidelity.pointsAvailable = available;
      const epp = settings.redeemEuroPerPoint > 0 ? settings.redeemEuroPerPoint : 0.1;
      let suggested = Math.min(available, Math.floor(due / epp));
      if (suggested < settings.redeemMinPoints) suggested = 0;
      out.fidelity.suggestedPoints = suggested;
      out.fidelity.suggestedDiscount = round2(Math.min(due, suggested * epp));
    }
  } catch {
    // fidelity panel simply stays hidden
  }

  // --- Credito (client wallet credit) ---
  try {
    const wallet = await dbWalletBalance(clientId, slug);
    out.creditAvailable = round2(Math.max(0, Number(wallet.credit ?? 0) || 0));
  } catch {
    out.creditAvailable = 0;
  }

  // --- GiftCard (active, spendable, owned by the client) — same availability rule
  //     as the manage residuals (recipient, active, balance>0, not expired). ---
  try {
    // Ownership come booking_public_list_available_giftcards (booking.php 261-263):
    // carte con recipient_client_id = cliente OPPURE, se l'intestatario è vuoto
    // (NULL/0), quelle acquistate dal cliente stesso (client_id).
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "id, code, balance, expires_at",
      where:
        "((recipient_client_id IS NOT NULL AND recipient_client_id > 0 AND recipient_client_id = ?) OR ((recipient_client_id IS NULL OR recipient_client_id = 0) AND client_id = ?)) AND status = 'active' AND balance > 0 AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)",
      params: [clientId, clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 20,
    }).catch(() =>
      tenantSelect<RowDataPacket>({
        slug,
        table: "giftcards",
        columns: "id, code, balance, expires_at",
        where: "client_id = ? AND status = 'active' AND balance > 0 AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)",
        params: [clientId],
        orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
        limit: 20,
      }),
    );
    out.giftcards = rows
      .map((r) => ({ id: Number(r.id ?? 0), code: String(r.code ?? ""), balance: round2(Math.max(0, Number(r.balance ?? 0) || 0)) }))
      .filter((g) => g.id > 0 && g.balance > 0);
  } catch {
    out.giftcards = [];
  }

  return out;
}

// Apply the confirmed customer's requested benefits AFTER the public insert
// (legacy order: fidelity -> giftcard -> credito; each best-effort/clamped, the
// booking itself never fails). Returns what was actually applied so the caller
// can echo it in the confirmation payload.
export async function applyPublicCustomerBenefits({
  slug,
  appointmentId,
  clientId,
  subtotal,
  priorDiscount,
  requestedPoints,
  requestedCredit,
  giftcardRedeems,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  subtotal: number;
  priorDiscount: number;
  requestedPoints: number;
  requestedCredit: number;
  giftcardRedeems: Array<{ giftcard_id: number; amount: number }>;
}): Promise<{ fidelityPoints: number; fidelityDiscount: number; creditUsed: number; giftcardUsed: number }> {
  const applied = { fidelityPoints: 0, fidelityDiscount: 0, creditUsed: 0, giftcardUsed: 0 };
  if (clientId <= 0 || appointmentId <= 0) return applied;
  const dueBase = Math.max(0, round2(subtotal - Math.max(0, priorDiscount)));

  // --- 1) FIDELITY points reserve (legacy ~8053-8103 + column update ~8250-8258):
  //     normalize + clamp the request to the available points and the covered due;
  //     persist appointments.fidelity_points_used/fidelity_discount + the legacy
  //     notes line. Points are RESERVED (debited only when the booking is done). ---
  const reqPts = Math.max(0, Math.floor(Number(requestedPoints) || 0));
  if (reqPts > 0) {
    try {
      const settings = await getFidelityPointsSettings(slug);
      if (
        settings.globalEnabled &&
        settings.pointsEnabled &&
        settings.redeemEnabled &&
        (await fidelityIsClientAdhering(slug, clientId).catch(() => false))
      ) {
        const wallet = await dbWalletBalance(clientId, slug);
        const reserved = await fidelityReservedPoints(slug, clientId).catch(() => 0);
        const available = Math.max(0, Math.floor((Number(wallet.points ?? 0) || 0) - reserved));
        const epp = settings.redeemEuroPerPoint > 0 ? settings.redeemEuroPerPoint : 0.1;
        let pts = Math.min(reqPts, available, Math.floor(dueBase / epp));
        if (pts < settings.redeemMinPoints) pts = 0;
        const discount = round2(Math.min(dueBase, pts * epp));
        if (pts > 0 && discount > 0) {
          await tenantUpdate({
            slug,
            table: "appointments",
            id: appointmentId,
            values: { fidelity_points_used: pts, fidelity_discount: discount },
          });
          // Legacy notes line: "Fidelity: -€ x (N Punti prenotati, scalati quando eseguito)".
          try {
            const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "notes", where: "id = ?", params: [appointmentId], limit: 1 });
            const prev = String(rows[0]?.notes ?? "").trim();
            const line = `Fidelity: -€ ${moneyIt(discount)} (${pts} Punti prenotati, scalati quando eseguito)`;
            await tenantUpdate({ slug, table: "appointments", id: appointmentId, values: { notes: prev ? `${prev}\n${line}` : line } });
          } catch {
            // the columns are the source of truth; a notes failure is cosmetic
          }
          applied.fidelityPoints = pts;
          applied.fidelityDiscount = discount;
        }
      }
    } catch {
      // best-effort: the booking stands without the fidelity reserve
    }
  }

  // --- 2) GIFTCARD (legacy booking_public_apply_giftcard): reuse the manage-side
  //     redeem (ownership + balance validation, cap at the payable total, balance
  //     decrement + appointments.giftcard_id/giftcard_used). ---
  const validRedeems = (giftcardRedeems ?? []).filter((r) => Number(r.giftcard_id) > 0 && Number(r.amount) > 0);
  if (validRedeems.length > 0) {
    try {
      const { applied: gcApplied } = await applyAppointmentGiftcardRedeem({
        slug,
        appointmentId,
        clientId,
        redeems: validRedeems.map((r) => ({ giftcardId: Number(r.giftcard_id), amount: round2(Number(r.amount)) })),
      });
      if (gcApplied) applied.giftcardUsed = round2(Number(gcApplied.amount) || 0);
    } catch {
      // best-effort
    }
  }

  // --- 3) CREDITO (legacy ~8336-8388): clamp to min(balance, due-after-fidelity,
  //     requested), debit the wallet NOW (refunded on cancel by
  //     restoreAppointmentRedeems) + appointments.credit_used(+_by_customer). ---
  const reqCredit = round2(Math.max(0, Number(requestedCredit) || 0));
  if (reqCredit > 0) {
    try {
      const wallet = await dbWalletBalance(clientId, slug);
      const balance = round2(Math.max(0, Number(wallet.credit ?? 0) || 0));
      // Legacy dueBeforeCredit = subtotal - discount - fidelity_discount (the
      // giftcard is intentionally NOT subtracted — faithful quirk, booking.php 8355).
      const dueBeforeCredit = Math.max(0, round2(dueBase - applied.fidelityDiscount));
      const use = round2(Math.min(balance, dueBeforeCredit, reqCredit));
      if (use > 0) {
        await addDbWalletMovement(
          {
            clientId,
            type: "debit",
            amount: -use,
            source_type: "appointment",
            source_id: appointmentId,
            note: `Utilizzo credito prenotazione #${appointmentId}`,
          },
          slug,
        );
        try {
          await tenantUpdate({ slug, table: "appointments", id: appointmentId, values: { credit_used: use, credit_used_by_customer: 1 } });
        } catch {
          await tenantUpdate({ slug, table: "appointments", id: appointmentId, values: { credit_used: use } });
        }
        applied.creditUsed = use;
      }
    } catch {
      // best-effort: the booking stands without the credit deduction
    }
  }

  return applied;
}
