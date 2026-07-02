"use client";

/*
 * BookingFaithful — pixel-faithful Next.js port of the legacy PHP public ONLINE BOOKING wizard
 * (legacy source: C:/xampp/htdocs/app/pages/booking.php, lines ~12986-13465, rendered by
 *  /assets/js/pages/booking-wizard.js, styled by booking.css + booking-wizard.css).
 *
 * The legacy public page (index.php?page=booking&public=1) emits a full-screen `.booking-overlay`
 * shell whose 7 `.wizard-step` panes are hydrated client-side by booking-wizard.js. This component
 * reproduces that exact shell VERBATIM (original class names + Bootstrap Icons) and drives the core
 * flow with React state instead of the legacy DOM script. Bootstrap 5.3 + Bootstrap Icons are loaded
 * via <link> (the legacy app.css/head pulls them from the CDN); booking.css + booking-wizard.css are
 * loaded via <link> from /assets/css/pages/. The legacy inline embed <style> is injected too.
 *
 * WIRED (live, against /api/booking):
 *   - context fetch (?action=context&slug=)  -> locations / categories / services / staff / benefits
 *   - Step 1 location, Step 2 category, Step 3 services (multi-select), Step 4 professional (any/specific)
 *   - Step 5 date strip + availability (?action=slots) + slot pick + hold (POST action=hold)
 *   - Step 6 benefits selection (coupon/promotion) — applied to the confirm payload
 *   - Step 7 recap + confirm (POST action=confirm) with inline customer fields
 *
 * STATIC / FAITHFUL-BUT-NOT-WIRED (markup reproduced, no live logic):
 *   - Fidelity points / credit / giftcard panels (Step 6) — rendered, kept hidden like the legacy default
 *   - Hold TTL countdown banner (#bookingHoldCountdown) — shows static reserved-until text from the hold
 *   - Recap popup (#bookingRecapPopup) and customer-area modal (#customerModal tabs) — markup only
 *   - Coupon free-text box, promotions box, recommended box — markup only
 * The legacy `_csrf` hidden input is intentionally dropped.
 */

import { useEffect, useMemo, useRef, useState } from "react";

const CSS_LINKS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "/assets/css/pages/booking.css",
  "/assets/css/pages/booking-wizard.css",
];

// Legacy inline <head><style> from the captured embed shell.
const EMBED_INLINE_STYLE = `
  body.embed-body{ background:#fff; }
  body.embed-body .container-fluid{ max-width: 1100px; }
  body.embed-body footer{ display:none; }
`;

type BookingBusiness = {
  name: string;
  about: string;
  email: string;
  phone: string;
  website: string;
};

type BookingLocation = {
  id: number;
  name: string;
  address: string;
  email: string;
  phone: string;
  bookingEnabled: boolean;
  hoursToday: string;
};

type BookingCategory = { id: number; name: string };

type BookingService = {
  id: number;
  name: string;
  description: string;
  categoryId: number | null;
  duration: number;
  price: number;
  noOperator: boolean;
  locationIds: number[];
};

type BookingStaff = {
  id: number;
  name: string;
  serviceIds: number[];
  active: boolean;
};

type BookingBenefit = {
  id: string;
  type: "coupon" | "promotion" | "giftcard";
  label: string;
  detail: string;
  code?: string;
  promotionId?: number;
  discountType?: "percent" | "fixed";
  discountValue?: number;
};

type BookingContext = {
  business: BookingBusiness;
  locations: BookingLocation[];
  categories: BookingCategory[];
  services: BookingService[];
  staff: BookingStaff[];
  benefits: BookingBenefit[];
  today: string;
};

type BookingSlot = {
  time: string;
  available: boolean;
  staffId: number | null;
  staffName: string;
  reason: string;
};

type BookingHold = {
  token: string;
  expiresAt: string;
  date: string;
  time: string;
  staffId: number | null;
  staffName: string;
};

type BookingConfirmation = {
  id: number;
  publicCode: string;
  status: string;
  date: string;
  time: string;
  total: number;
  discount: number;
  staffId: number | null;
  locationId: number | null;
};

// Legacy progress order: Sede, Categoria, Servizi, Professionista, Ora, Vantaggi, Conferma (steps 1..7).
const PROGRESS = [
  { key: "location", label: "Sede" },
  { key: "category", label: "Categoria" },
  { key: "services", label: "Servizi" },
  { key: "staff", label: "Professionista" },
  { key: "time", label: "Ora" },
  { key: "benefits", label: "Vantaggi" },
  { key: "confirm", label: "Conferma" },
];

const STEP_HEAD: Record<number, { title: string; desc: string }> = {
  1: { title: "Scegli la sede", desc: "Seleziona il centro in cui vuoi prenotare." },
  2: { title: "Scegli una categoria", desc: "Apri i servizi disponibili in questa categoria." },
  3: { title: "Scegli i servizi", desc: "Seleziona uno o più servizi e premi Avanti." },
  4: { title: "Scegli l'operatore", desc: "Scegli l'operatore per il tuo servizio." },
  5: { title: "Scegli data e ora", desc: "Scegli un giorno dalla lista e seleziona uno slot disponibile." },
  6: { title: "Vantaggi cliente", desc: "Se disponibili, puoi applicare Punti Fidelity, credito o GiftCard prima della conferma." },
  7: { title: "Conferma", desc: "Controlla i dettagli del tuo appuntamento e premi su Invia per confermare." },
};

const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const MONTHS_IT = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

// DEEP-LINK "prenota da residuo" prefill (legacy book_package / book_prepaid /
// book_giftbox / book_omaggio + service_id): the covered service is preselected
// and the redeem travels with the confirm (re-validated server-side).
export type BookingRedeemPrefill = {
  kind: "package" | "prepaid" | "giftbox" | "gift";
  refId: number;
  itemId?: number;
  serviceId: number;
};

export function BookingFaithful({
  slug: slugProp,
  redeemPrefill = null,
}: { slug?: string; redeemPrefill?: BookingRedeemPrefill | null } = {}) {
  const slug = useMemo(() => {
    if (slugProp) return slugProp;
    if (typeof window === "undefined") return "";
    // This component renders under /{slug}/booking. Resolve the tenant from the
    // URL path only — never default to a specific center. An empty slug makes the
    // context fetch surface a clear "attivita non specificata" error.
    return window.location.pathname.split("/").filter(Boolean)[0] || "";
  }, [slugProp]);

  const [context, setContext] = useState<BookingContext | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [error, setError] = useState("");

  const [step, setStep] = useState(1);
  const [locationId, setLocationId] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [serviceIds, setServiceIds] = useState<number[]>([]);
  const [operatorId, setOperatorId] = useState<number | "any">("any");
  const [date, setDate] = useState<string>(() => toYmd(new Date()));
  const [stripStart, setStripStart] = useState<Date>(() => startOfDay(new Date()));
  const [slot, setSlot] = useState("");
  const [availableSlots, setAvailableSlots] = useState<BookingSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [hold, setHold] = useState<BookingHold | null>(null);
  const [benefitId, setBenefitId] = useState("none");
  // COUPON free-text (port of the legacy Step 6 coupon box -> mode=coupon):
  // the typed code is validated SERVER-SIDE per cart/date; a code matching a
  // promotion's coupon_code comes back as a promotion. The validated result
  // feeds coupon_code to the confirm (which re-resolves, never trusting this).
  const [couponInput, setCouponInput] = useState("");
  const [couponApplied, setCouponApplied] = useState<null | { code: string; discount: number; isPromotion: boolean; promotionTitle: string }>(null);
  const [couponMsg, setCouponMsg] = useState<null | { ok: boolean; text: string }>(null);
  const [couponChecking, setCouponChecking] = useState(false);
  // AUTO-PROMO (port of mode=promotion_preview): the best automatic promotion
  // the confirm will apply, shown as an informational banner in Step 6.
  const [autoPromo, setAutoPromo] = useState<null | { title: string; discount: number }>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);

  const ownerKeyRef = useRef<string>("");
  if (!ownerKeyRef.current && typeof window !== "undefined") {
    ownerKeyRef.current = `public-${Math.random().toString(36).slice(2)}`;
  }

  // Swap document.body.className like the legacy embed shell (body class="embed-body"); restore on unmount.
  useEffect(() => {
    const previous = document.body.className;
    document.body.className = "embed-body";
    return () => {
      document.body.className = previous;
    };
  }, []);

  // STEP 1 + 2: fetch context (?action=context&slug=)
  useEffect(() => {
    let active = true;
    setLoadingContext(true);
    fetch(`/api/booking?action=context&slug=${encodeURIComponent(slug)}`)
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        if (!data.ok || !data.context) throw new Error(data.error || "Contesto non disponibile.");
        const ctx = data.context as BookingContext;
        setContext(ctx);
        setLocationId(ctx.locations[0]?.id ?? 0);
        setCategoryId(ctx.categories[0]?.id ?? null);
        // Deep-link prefill: preselect the covered service (and its category) so
        // the customer lands with the redeem's service already in the cart.
        if (redeemPrefill && redeemPrefill.serviceId > 0) {
          const svc = ctx.services.find((s) => s.id === redeemPrefill.serviceId);
          if (svc) {
            setServiceIds([svc.id]);
            if (svc.categoryId) setCategoryId(svc.categoryId);
          }
        }
        setError("");
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Contesto non disponibile.");
      })
      .finally(() => {
        if (active) setLoadingContext(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  // STEP 5: load availability (?action=slots) whenever the selection that affects slots changes.
  useEffect(() => {
    if (step !== 5 || !serviceIds.length || !locationId) return;
    let active = true;
    const params = new URLSearchParams({
      slug,
      action: "slots",
      date,
      service_ids: serviceIds.join(","),
      location_id: String(locationId),
    });
    if (operatorId !== "any") params.set("staff_id", String(operatorId));

    setSlotsLoading(true);
    setSlot("");
    setHold(null);
    fetch(`/api/booking?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        if (!data.ok) throw new Error(data.error || "Disponibilità non disponibile.");
        setAvailableSlots((data.slots ?? []) as BookingSlot[]);
        setError("");
      })
      .catch((caught) => {
        if (active) {
          setAvailableSlots([]);
          setError(caught instanceof Error ? caught.message : "Disponibilità non disponibile.");
        }
      })
      .finally(() => {
        if (active) setSlotsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [step, slug, date, serviceIds, locationId, operatorId]);

  const ctx = context;
  const selectedLocation = ctx?.locations.find((item) => item.id === locationId) ?? null;
  const selectedServices = useMemo(
    () => (ctx ? ctx.services.filter((service) => serviceIds.includes(service.id)) : []),
    [ctx, serviceIds],
  );
  const visibleServices = useMemo(
    () =>
      ctx
        ? ctx.services.filter(
            (service) =>
              (service.locationIds.length === 0 || service.locationIds.includes(locationId)) &&
              (!categoryId || service.categoryId === categoryId),
          )
        : [],
    [ctx, locationId, categoryId],
  );
  const selectedBenefit = ctx?.benefits.find((item) => item.id === benefitId) ?? null;
  const selectedSlot = availableSlots.find((item) => item.time === slot) ?? null;
  const subtotal = selectedServices.reduce((sum, service) => sum + service.price, 0);
  const totalDuration = selectedServices.reduce((sum, service) => sum + service.duration, 0);
  // Discount shown in Step 6/7: the VALIDATED coupon result wins (its discount
  // already includes a stacked auto-promo, like the legacy mode=coupon), then
  // the auto-detected promotion, then the selected-benefit estimate.
  const discount = couponApplied
    ? couponApplied.discount
    : autoPromo
      ? autoPromo.discount
      : estimateDiscount(selectedBenefit, subtotal);
  const finalTotal = Math.max(0, subtotal - discount);

  // ---- STEP 6 "Vantaggi" — logged-customer panels (port of mode=fidelity_preview:
  // Punti Fidelity / Credito / GiftCard). Fetched entering the step (and on cart/
  // discount changes); the panels stay hidden for anonymous visitors or when the
  // customer has nothing to spend. The choices only PREVIEW here — the confirm
  // re-validates and clamps everything server-side. ----
  type CustomerBenefits = {
    logged: boolean;
    redeemEnabled: boolean;
    pointsAvailable: number;
    suggestedPoints: number;
    suggestedDiscount: number;
    creditAvailable: number;
    giftcards: Array<{ id: number; code: string; balance: number }>;
  };
  const [custBenefits, setCustBenefits] = useState<CustomerBenefits | null>(null);
  const [useFidelity, setUseFidelity] = useState(false);
  const [useCredit, setUseCredit] = useState(false);
  const [giftcardChoiceId, setGiftcardChoiceId] = useState(0);
  const serviceIdsKey = serviceIds.join(",");
  useEffect(() => {
    if (step < 6 || !serviceIdsKey) return;
    let alive = true;
    const params = new URLSearchParams({ slug, action: "fidelity_preview", service_ids: serviceIdsKey, discount: String(discount) });
    fetch(`/api/booking?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j?.ok) return;
        setCustBenefits({
          logged: Number(j.logged ?? 0) === 1,
          redeemEnabled: Number(j.redeem_enabled ?? 0) === 1,
          pointsAvailable: Number(j.available_points ?? 0) || 0,
          suggestedPoints: Number(j.points_used ?? 0) || 0,
          suggestedDiscount: Number(j.discount ?? 0) || 0,
          creditAvailable: Number(j.credit_available ?? 0) || 0,
          giftcards: Array.isArray(j.giftcards) ? j.giftcards : [],
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [step, slug, serviceIdsKey, discount]);
  const round2c = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const fidelityDiscountApplied = useFidelity && custBenefits ? Math.min(custBenefits.suggestedDiscount, finalTotal) : 0;
  const dueAfterFidelity = Math.max(0, round2c(finalTotal - fidelityDiscountApplied));
  const chosenGiftcard = custBenefits?.giftcards.find((g) => g.id === giftcardChoiceId) ?? null;
  const giftcardAppliedAmount = chosenGiftcard ? round2c(Math.min(chosenGiftcard.balance, dueAfterFidelity)) : 0;
  const creditAppliedAmount =
    useCredit && custBenefits ? round2c(Math.min(custBenefits.creditAvailable, Math.max(0, dueAfterFidelity - giftcardAppliedAmount))) : 0;
  // The customer-facing payable total after every selected benefit.
  const payableTotal = Math.max(0, round2c(finalTotal - fidelityDiscountApplied - giftcardAppliedAmount - creditAppliedAmount));
  const staffName =
    operatorId === "any"
      ? hold?.staffName || selectedSlot?.staffName || "Qualsiasi professionista"
      : ctx?.staff.find((member) => member.id === operatorId)?.name ?? "Professionista";
  const clientFullName = `${firstName} ${lastName}`.trim();

  const isFinalStep = step === 7;
  const canContinue = computeCanContinue();

  // CLOSED days for the date strip (port of mode=closures): weekly closed dows
  // + specific closures, special opens re-enable the day.
  const [closures, setClosures] = useState<{ dows: Set<number>; dates: Set<string>; open: Set<string> }>({ dows: new Set(), dates: new Set(), open: new Set() });
  useEffect(() => {
    if (!slug) return;
    let active = true;
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("action", "closures");
    if (locationId > 0) params.set("location_id", String(locationId));
    void fetch(`/api/booking?${params.toString()}`)
      .then((res) => res.json().catch(() => null))
      .then((data: { ok?: boolean; closed_dows?: number[]; closed_dates?: string[]; open_dates?: string[] } | null) => {
        if (!active || !data?.ok) return;
        setClosures({
          dows: new Set((data.closed_dows ?? []).map(Number)),
          dates: new Set((data.closed_dates ?? []).map(String)),
          open: new Set((data.open_dates ?? []).map(String)),
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [slug, locationId]);

  // A strip day is closed when its date is a closure OR its weekday is closed,
  // unless a special-open re-enables it (legacy strip rule).
  function isClosedDay(day: Date): boolean {
    const ymd = toYmd(day);
    if (closures.open.has(ymd)) return false;
    if (closures.dates.has(ymd)) return true;
    return closures.dows.has(day.getDay());
  }

  // AUTO-PROMO detection (mode=promotion_preview) on entering Step 6+: the best
  // automatic promotion the confirm will apply, per selected services/date/slot.
  useEffect(() => {
    if (step < 6 || !serviceIds.length) {
      setAutoPromo(null);
      return;
    }
    let active = true;
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("action", "promotion_preview");
    params.set("service_ids", serviceIds.join(","));
    if (locationId > 0) params.set("location_id", String(locationId));
    if (date) params.set("date", date);
    if (slot) params.set("time", slot);
    if (email.trim()) params.set("email", email.trim());
    if (phone.trim()) params.set("phone", phone.trim());
    void fetch(`/api/booking?${params.toString()}`)
      .then((res) => res.json().catch(() => null))
      .then((data: { ok?: boolean; eligible?: boolean; title?: string; discount?: number } | null) => {
        if (!active) return;
        if (data?.ok && data.eligible && Number(data.discount ?? 0) > 0) {
          setAutoPromo({ title: String(data.title ?? ""), discount: Number(data.discount ?? 0) });
        } else {
          setAutoPromo(null);
        }
      })
      .catch(() => {
        if (active) setAutoPromo(null);
      });
    return () => {
      active = false;
    };
  }, [step, serviceIds, locationId, date, slot, email, phone, slug]);

  // COUPON free-text apply (mode=coupon): validate the typed code per cart/
  // date; a promotion-with-code answers as a promotion (is_promotion=1).
  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (!code) {
      setCouponMsg({ ok: false, text: "Inserisci un codice coupon." });
      return;
    }
    setCouponChecking(true);
    setCouponMsg(null);
    try {
      const params = new URLSearchParams();
      params.set("slug", slug);
      params.set("action", "coupon");
      params.set("code", code);
      params.set("service_ids", serviceIds.join(","));
      if (locationId > 0) params.set("location_id", String(locationId));
      if (date) params.set("appt_date", date);
      if (slot) params.set("time", slot);
      if (email.trim()) params.set("email", email.trim());
      if (phone.trim()) params.set("phone", phone.trim());
      const res = await fetch(`/api/booking?${params.toString()}`);
      const data: { ok?: boolean; error?: string; discount?: number; is_promotion?: number; promotion_title?: string } =
        await res.json().catch(() => ({}));
      if (!data.ok) {
        setCouponApplied(null);
        setCouponMsg({ ok: false, text: String(data.error || "Coupon non valido o scaduto.") });
        return;
      }
      const isPromotion = Number(data.is_promotion ?? 0) === 1;
      setCouponApplied({
        code,
        discount: Number(data.discount ?? 0),
        isPromotion,
        promotionTitle: String(data.promotion_title ?? ""),
      });
      setCouponMsg({
        ok: true,
        text: isPromotion
          ? `Promozione "${String(data.promotion_title ?? code)}" applicata.`
          : "Coupon applicato.",
      });
    } catch {
      setCouponApplied(null);
      setCouponMsg({ ok: false, text: "Errore durante la verifica del coupon." });
    } finally {
      setCouponChecking(false);
    }
  }

  function removeCoupon() {
    setCouponApplied(null);
    setCouponInput("");
    setCouponMsg(null);
  }

  function computeCanContinue(): boolean {
    if (submitting) return false;
    if (step === 1) return locationId > 0;
    if (step === 3) return serviceIds.length > 0;
    if (step === 5) return Boolean(slot) && !slotsLoading;
    if (step === 7) return Boolean(firstName.trim()) && Boolean(email.trim()) && Boolean(slot);
    return true;
  }

  function chooseLocation(id: number) {
    setLocationId(id);
    setServiceIds([]);
    setSlot("");
    setHold(null);
  }

  function toggleService(id: number) {
    setServiceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    setSlot("");
    setHold(null);
  }

  function chooseDate(ymd: string) {
    setDate(ymd);
    setSlot("");
    setHold(null);
  }

  async function chooseSlot(item: BookingSlot) {
    if (!item.available) return;
    setSlot(item.time);
    setHold(null);
    setError("");
    try {
      const staffForHold = operatorId === "any" ? item.staffId : operatorId;
      const response = await fetch("/api/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "hold",
          slug,
          date,
          time: item.time,
          service_ids: serviceIds.join(","),
          staff_id: staffForHold ?? "",
          location_id: locationId,
          owner_key: ownerKeyRef.current,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "Orario non più disponibile.");
      setHold(data.hold as BookingHold);
    } catch (caught) {
      setSlot("");
      setError(caught instanceof Error ? caught.message : "Orario non più disponibile.");
    }
  }

  async function handleNext() {
    setError("");
    if (!isFinalStep) {
      if (!canContinue) return;
      setStep((current) => Math.min(7, current + 1));
      return;
    }
    if (!canContinue) return;
    setSubmitting(true);
    try {
      const staffForConfirm = operatorId === "any" ? hold?.staffId ?? selectedSlot?.staffId ?? "" : operatorId;
      const response = await fetch("/api/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          slug,
          location_id: locationId,
          service_ids: serviceIds.join(","),
          staff_id: staffForConfirm,
          date,
          time: slot,
          hold_token: hold?.token ?? "",
          client_name: clientFullName,
          client_email: email,
          client_phone: phone,
          benefit_id: benefitId,
          // The VALIDATED free-text code wins (the confirm re-resolves it
          // server-side: promo-by-code or classic coupon with stacking rules).
          coupon_code: couponApplied?.code ?? (selectedBenefit?.type === "coupon" ? selectedBenefit.code ?? selectedBenefit.label : ""),
          promotion_id: selectedBenefit?.type === "promotion" ? selectedBenefit.promotionId ?? "" : "",
          // STEP 6 customer benefits (re-validated + clamped server-side; applied
          // only when the customer session owns the booked client).
          fidelity_points_use: useFidelity ? custBenefits?.suggestedPoints ?? 0 : 0,
          credit_use: creditAppliedAmount > 0 ? String(creditAppliedAmount) : "0",
          giftcard_redeem:
            chosenGiftcard && giftcardAppliedAmount > 0
              ? JSON.stringify([{ giftcard_id: chosenGiftcard.id, amount: giftcardAppliedAmount }])
              : "",
          // Deep-link redeem (book_package / book_prepaid / book_giftbox /
          // book_omaggio): only when its covered service is still in the cart.
          ...(redeemPrefill && serviceIds.includes(redeemPrefill.serviceId)
            ? redeemPrefill.kind === "package"
              ? { package_redeem: JSON.stringify([{ client_package_id: redeemPrefill.refId, service_id: redeemPrefill.serviceId }]) }
              : redeemPrefill.kind === "prepaid"
                ? { prepaid_service_redeem: JSON.stringify([{ client_prepaid_service_id: redeemPrefill.refId, service_id: redeemPrefill.serviceId }]) }
                : redeemPrefill.kind === "giftbox"
                  ? { giftbox_redeem: JSON.stringify([{ instance_id: redeemPrefill.refId, giftbox_item_id: redeemPrefill.itemId ?? 0, service_id: redeemPrefill.serviceId }]) }
                  : { gift_redeem: JSON.stringify([{ instance_id: redeemPrefill.refId, reward_item_index: redeemPrefill.itemId ?? 0, service_id: redeemPrefill.serviceId }]) }
            : {}),
          owner_key: ownerKeyRef.current,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "Prenotazione non completata.");
      setConfirmation(data.confirmation as BookingConfirmation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Prenotazione non completata.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    setError("");
    setStep((current) => Math.max(1, current - 1));
  }

  const businessInitial = (ctx?.business.name ?? "").trim().charAt(0).toUpperCase() || "B";
  const dateStripDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(stripStart, index)),
    [stripStart],
  );
  const nextLabel = isFinalStep ? "Invia" : step === 5 ? "Continua" : "Avanti";
  const nextIcon = isFinalStep ? "bi-send" : "bi-arrow-right";

  return (
    <>
      {CSS_LINKS.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <style dangerouslySetInnerHTML={{ __html: EMBED_INLINE_STYLE }} />

      <div className="booking-overlay" id="bookingOverlay">
        <div className="booking-modal" role="dialog" aria-modal="true" aria-label="Prenotazione online">
          <button
            type="button"
            className={`booking-floating-action booking-floating-back${step <= 1 ? " is-hidden" : ""}`}
            id="btnBackTop"
            aria-label="Indietro"
            onClick={handleBack}
          >
            <i className="bi bi-arrow-left" />
          </button>
          <button type="button" className="booking-floating-action booking-floating-close" id="btnClose" aria-label="Chiudi">
            <i className="bi bi-x-lg" />
          </button>

          <div className="booking-copy d-none">
            <h3 id="leftTitle">Cosa vuoi fare?</h3>
            <p id="leftText">Seleziona il servizio adatto a te.</p>
          </div>

          <div className="booking-main">
            <div className="booking-head">
              <div className="booking-progress" id="bookingProgress" aria-label="Avanzamento prenotazione">
                {PROGRESS.map((item, index) => {
                  const order = index + 1;
                  const cls =
                    order === step
                      ? "booking-progress__item is-active"
                      : order < step
                        ? "booking-progress__item is-done"
                        : "booking-progress__item";
                  return (
                    <span key={item.key} className={cls} data-progress={item.key}>
                      {item.label}
                    </span>
                  );
                })}
              </div>
              <div className="booking-progress__label" id="bookingStepCounter">
                Step {step} di 7
              </div>
              <div className="booking-head__row">
                <div>
                  <h4 id="stepTitle">{STEP_HEAD[step].title}</h4>
                  <div className="booking-head__desc" id="bookingStepDescription">
                    {STEP_HEAD[step].desc}
                  </div>
                </div>
                <button type="button" className="btn btn-outline-secondary btn-sm btn-pill booking-head__account" id="customerAreaBtn">
                  <i className="bi bi-person me-1" />
                  <span id="customerAreaBtnLabel">Accedi</span>
                </button>
              </div>
            </div>

            <form method="post" id="wizardForm" className="booking-body" onSubmit={(event) => event.preventDefault()}>
              {/* Legacy hidden inputs (kept for parity; _csrf intentionally dropped). */}
              <input type="hidden" name="service_ids" id="service_ids" value={serviceIds.join(",")} readOnly />
              <input type="hidden" name="staff_id" id="staff_id" value={operatorId === "any" ? "" : String(operatorId)} readOnly />
              <input type="hidden" name="staff_map" id="staff_map" value="" readOnly />
              <input type="hidden" name="location_id" id="location_id" value={String(locationId)} readOnly />
              <input type="hidden" name="date" id="date" value={date} readOnly />
              <input type="hidden" name="time" id="time" value={slot} readOnly />
              <input type="hidden" name="appointment_hold_token" id="appointment_hold_token" value={hold?.token ?? ""} readOnly />
              <input type="hidden" name="giftbox_redeem" id="giftbox_redeem" value="" readOnly />
              <input type="hidden" name="gift_redeem" id="gift_redeem" value="" readOnly />
              <input type="hidden" name="package_redeem" id="package_redeem" value="" readOnly />
              <input type="hidden" name="prepaid_service_redeem" id="prepaid_service_redeem" value="" readOnly />
              <input type="hidden" name="coupon_code" id="coupon_code" value={selectedBenefit?.type === "coupon" ? selectedBenefit.code ?? "" : ""} readOnly />
              <input type="hidden" name="promotion_id" id="promotion_id" value={selectedBenefit?.type === "promotion" ? String(selectedBenefit.promotionId ?? "") : ""} readOnly />
              <input type="hidden" name="fidelity_points_use" id="fidelity_points_use" value="0" readOnly />
              <input type="hidden" name="credit_use" id="credit_use" value="0" readOnly />
              <input type="hidden" name="giftcard_redeem" id="giftcard_redeem" value="" readOnly />
              <input type="hidden" name="discount_mode" id="discount_mode" value="none" readOnly />
              <input type="hidden" name="fidelity_choice" id="fidelity_choice" value="" readOnly />
              <input type="hidden" name="fidelity_gift_idx" id="fidelity_gift_idx" value="" readOnly />
              <input type="hidden" name="first_name" id="first_name" value={firstName} readOnly />
              <input type="hidden" name="last_name" id="last_name" value={lastName} readOnly />
              <input type="hidden" name="phone" id="phone" value={phone} readOnly />
              <input type="hidden" name="email" id="email" value={email} readOnly />
              <input type="hidden" name="notes" id="notes" value="" readOnly />

              {/* Hold TTL countdown banner (faithful-but-static: shows the reserved-until time of the hold). */}
              <div
                id="bookingHoldCountdown"
                className={`alert alert-info py-2 px-3 mb-3 small${hold ? "" : " d-none"}`}
                role="status"
                aria-live="polite"
              >
                {hold ? `Orario riservato fino alle ${hold.expiresAt.slice(11, 16)}.` : ""}
              </div>

              {error ? (
                <div className="alert alert-warning py-2 px-3 mb-3 small booking-alert-rounded-sm">{error}</div>
              ) : null}

              {/* STEP 1: Location */}
              <div className={`wizard-step${step === 1 ? "" : " d-none"}`} data-step="1">
                <div className="d-grid gap-3" id="locationCardList">
                  {loadingContext ? <div className="text-muted small">Caricamento…</div> : null}
                  {ctx?.locations.map((loc) => (
                    <button
                      key={loc.id}
                      type="button"
                      className={`list-card booking-location-card${locationId === loc.id ? " active" : ""}`}
                      data-id={loc.id}
                      onClick={() => chooseLocation(loc.id)}
                    >
                      <div className="d-flex align-items-center justify-content-between gap-3">
                        <div>
                          <div className="booking-location-name">{loc.name}</div>
                          {loc.address ? <div className="booking-location-address">{loc.address}</div> : null}
                        </div>
                        <div className="service-card__action" aria-hidden="true">
                          +
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* STEP 2: Categories */}
              <div className={`wizard-step${step === 2 ? "" : " d-none"}`} data-step="2">
                <div className="booking-list-section-title">Scegli una categoria</div>
                <div className="d-grid gap-3">
                  {ctx && !ctx.categories.length ? (
                    <div className="text-muted">
                      Nessuna categoria configurata. Vai su <strong>Servizi → Categorie</strong> per crearle.
                    </div>
                  ) : null}
                  {ctx?.categories.map((cat) => (
                    <div
                      key={cat.id}
                      className={`list-card cat-card${categoryId === cat.id ? " active" : ""}`}
                      data-id={cat.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setCategoryId(cat.id);
                        setStep(3);
                      }}
                    >
                      <div className="cat-left">
                        <img src="/assets/img/categories/body.svg" alt="" />
                        <div>
                          <div className="cat-name">{cat.name}</div>
                          <div className="small text-muted mt-1">Apri i servizi disponibili in questa categoria.</div>
                        </div>
                      </div>
                      <div className="service-card__action" aria-hidden="true">
                        +
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* STEP 3: Services */}
              <div className={`wizard-step${step === 3 ? "" : " d-none"}`} data-step="3">
                <div className="booking-list-section-title" id="bookingServiceSectionTitle">
                  Servizi disponibili
                </div>
                <div className="d-grid gap-3" id="serviceList">
                  {visibleServices.map((service) => {
                    const active = serviceIds.includes(service.id);
                    return (
                      <div
                        key={service.id}
                        className={`list-card service-card${active ? " active" : ""}`}
                        data-id={service.id}
                        data-cat={service.categoryId ?? 0}
                        data-dur={service.duration}
                        data-price={service.price}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleService(service.id)}
                      >
                        <div className="service-line">
                          <div className="service-meta">
                            <span className="checkbox" aria-hidden="true" />
                            <div className="service-copy">
                              <div className="fw-semibold">{service.name}</div>
                              <div className="small text-muted">{service.duration} min</div>
                            </div>
                          </div>
                          <div className="d-flex align-items-center gap-3">
                            <div className="service-price">€ {fmtMoney(service.price)}</div>
                            <div className="service-card__action" aria-hidden="true">
                              +
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Recommended services (static markup, kept hidden like legacy default). */}
                <div id="recommendedBox" className="mt-4 d-none">
                  <div className="fw-semibold">Consigliati per te</div>
                  <div className="text-muted small">Puoi aggiungerli alla prenotazione oppure ignorarli.</div>
                  <div className="d-grid gap-2 mt-2" id="recommendedList" />
                </div>

                <div className="text-muted small mt-3">
                  Seleziona uno o più servizi e premi <strong>Avanti</strong>.
                </div>
              </div>

              {/* STEP 4: Professional */}
              <div className={`wizard-step${step === 4 ? "" : " d-none"}`} data-step="4">
                <div className="mb-2 small-muted">Scegli l&apos;operatore per il tuo servizio.</div>
                <div className="d-grid gap-2" id="staffList">
                  <div
                    className={`list-card${operatorId === "any" ? " active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setOperatorId("any")}
                  >
                    <div className="d-flex align-items-center gap-2">
                      <div className="recap-avatar">
                        <i className="bi bi-people" />
                      </div>
                      <div className="fw-semibold">Qualsiasi professionista</div>
                    </div>
                    <div className="service-card__action" aria-hidden="true">
                      +
                    </div>
                  </div>
                  {ctx?.staff.map((member) => (
                    <div
                      key={member.id}
                      className={`list-card${operatorId === member.id ? " active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOperatorId(member.id)}
                    >
                      <div className="d-flex align-items-center gap-2">
                        <div className="recap-avatar">
                          <i className="bi bi-person" />
                        </div>
                        <div className="fw-semibold">{member.name}</div>
                      </div>
                      <div className="service-card__action" aria-hidden="true">
                        +
                      </div>
                    </div>
                  ))}
                </div>
                <div id="staffEmpty" className={`text-muted small mt-2${ctx?.staff.length ? " d-none" : ""}`}>
                  Nessun operatore disponibile.
                </div>
              </div>

              {/* STEP 5: Date & time */}
              <div className={`wizard-step${step === 5 ? "" : " d-none"}`} data-step="5">
                <div className="mb-2 small-muted">
                  Scegli un giorno dalla lista. Usa il calendario per raggiungere più velocemente una data lontana.
                </div>
                <div id="closureNotice" className="alert alert-warning d-none booking-alert-rounded">
                  <div className="d-flex gap-2">
                    <i className="bi bi-info-circle-fill" />
                    <div>
                      <div className="fw-semibold">Chiusura negozio</div>
                      <div id="closureNoticeText" className="small" />
                    </div>
                  </div>
                </div>
                <div className="booking-date-strip-card">
                  <div className="booking-date-toolbar">
                    <div className="booking-date-month" id="dateStripMonthLabel">
                      {formatMonthYearIt(stripStart)}
                    </div>
                    <div className="booking-date-toolbar__actions">
                      <button
                        type="button"
                        className="booking-date-nav-btn"
                        id="dateStripPrev"
                        aria-label="Mostra i giorni precedenti"
                        disabled={startOfDay(stripStart).getTime() <= startOfDay(new Date()).getTime()}
                        onClick={() => setStripStart((current) => addDays(current, -7))}
                      >
                        <i className="bi bi-chevron-left" />
                      </button>
                      <button
                        type="button"
                        className="booking-date-nav-btn"
                        id="dateStripNext"
                        aria-label="Mostra i giorni successivi"
                        onClick={() => setStripStart((current) => addDays(current, 7))}
                      >
                        <i className="bi bi-chevron-right" />
                      </button>
                      <div className="booking-date-popover-wrap">
                        <button type="button" className="booking-date-nav-btn" id="dateStripCalendarBtn" aria-label="Apri il calendario">
                          <i className="bi bi-calendar4-week" />
                        </button>
                        <div className="booking-calendar-popover d-none" id="calendarPopover">
                          <div id="inlineCalendar" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="booking-day-strip" id="dateStripDays">
                    {dateStripDays.map((day) => {
                      const ymd = toYmd(day);
                      // Past days AND closed days (mode=closures) are disabled,
                      // like the legacy strip.
                      const disabled = startOfDay(day).getTime() < startOfDay(new Date()).getTime() || isClosedDay(day);
                      return (
                        <button
                          key={ymd}
                          type="button"
                          className={`booking-day-pill${date === ymd ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
                          data-date={ymd}
                          disabled={disabled}
                          onClick={() => chooseDate(ymd)}
                        >
                          <span className="booking-day-pill__num">{day.getDate()}</span>
                          <span className="booking-day-pill__weekday">{WEEKDAYS_SHORT[day.getDay()]}</span>
                        </button>
                      );
                    })}
                  </div>
                  <input type="text" id="calendarInput" className="d-none" readOnly />
                </div>
                <div className="mt-3">
                  <div className="fw-semibold">
                    Scegli uno slot per <span id="slotDateLabel" className="text-success">{formatDateIt(date)}</span>
                  </div>
                  <div className="slot-grid" id="slotGrid">
                    {slotsLoading ? <div className="text-muted small">Caricamento orari…</div> : null}
                    {!slotsLoading &&
                      availableSlots.map((item) => (
                        <button
                          key={item.time}
                          type="button"
                          className={`slot-btn${item.available ? " available" : " disabled"}${slot === item.time ? " selected" : ""}`}
                          disabled={!item.available}
                          title={item.reason}
                          onClick={() => chooseSlot(item)}
                        >
                          {item.time}
                        </button>
                      ))}
                  </div>
                  <div
                    id="slotEmpty"
                    className={`text-muted small mt-2${slotsLoading || availableSlots.length ? " d-none" : ""}`}
                  >
                    Nessuna disponibilità per questa data.
                  </div>
                </div>
              </div>

              {/* STEP 6: Vantaggi cliente (benefits WIRED; fidelity/credit/giftcard panels static & hidden) */}
              <div className={`wizard-step${step === 6 ? "" : " d-none"}`} data-step="6">
                <div className="mb-3 small-muted">
                  Se disponibili, puoi applicare Punti Fidelity, credito o GiftCard prima della conferma.
                </div>

                <div
                  id="benefitsEmptyBox"
                  className={`alert alert-light border small booking-alert-rounded-sm${ctx?.benefits.length ? " d-none" : ""}`}
                >
                  Nessun vantaggio disponibile per questa prenotazione.
                </div>

                {/* AUTO-PROMO detected (mode=promotion_preview): the confirm applies it
                    automatically, exactly like the legacy — this banner just shows it. */}
                {autoPromo && !couponApplied ? (
                  <div className="alert alert-success small booking-alert-rounded-sm" id="autoPromoBanner">
                    <i className="bi bi-megaphone me-1" />
                    Promozione attiva: <strong>{autoPromo.title}</strong> — sconto € {fmtMoney(autoPromo.discount)} applicato automaticamente alla conferma.
                  </div>
                ) : null}

                {/* COUPON free-text (port of the legacy Step 6 coupon box -> mode=coupon). */}
                <div className="booking-benefit-panel" id="couponBox">
                  <div className="d-flex justify-content-between align-items-start gap-3">
                    <div>
                      <div className="fw-semibold">
                        <i className="bi bi-ticket-perforated me-1" />
                        Hai un codice coupon?
                      </div>
                      <div className="small text-muted">Inseriscilo qui per applicarlo alla prenotazione.</div>
                    </div>
                  </div>
                  <div className="input-group input-group-sm mt-3" style={{ maxWidth: 420 }}>
                    <input
                      className="form-control"
                      type="text"
                      id="couponInput"
                      placeholder="Codice coupon"
                      value={couponInput}
                      onChange={(event) => setCouponInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void applyCoupon();
                        }
                      }}
                    />
                    <button type="button" className="btn btn-outline-success" disabled={couponChecking} onClick={() => void applyCoupon()}>
                      Applica
                    </button>
                    <button type="button" className="btn btn-outline-secondary" disabled={couponChecking} onClick={removeCoupon}>
                      Rimuovi
                    </button>
                  </div>
                  {couponMsg ? (
                    <div className={`form-text ${couponMsg.ok ? "text-success" : "text-danger"}`} id="couponMsg">
                      {couponMsg.text}
                    </div>
                  ) : null}
                  {couponApplied ? (
                    <div className="small mt-1" id="couponAppliedLine">
                      {couponApplied.isPromotion
                        ? <>Promozione <strong>{couponApplied.promotionTitle || couponApplied.code}</strong>: - € {fmtMoney(couponApplied.discount)}</>
                        : <>Coupon <strong>{couponApplied.code}</strong>: - € {fmtMoney(couponApplied.discount)}</>}
                    </div>
                  ) : null}
                </div>

                {/* Wired benefit choices (coupon / promotion) rendered with the legacy benefit-panel markup. */}
                {ctx?.benefits.length ? (
                  <div className="booking-benefit-panel">
                    <div className="d-flex justify-content-between align-items-start gap-3">
                      <div>
                        <div className="fw-semibold">
                          <i className="bi bi-tag me-1" />
                          Vantaggi disponibili
                        </div>
                        <div className="small text-muted">Applica un beneficio prima della conferma.</div>
                      </div>
                    </div>
                    <div className="d-grid gap-2 mt-3">
                      <label className="giftcard-choice booking-benefit-choice" htmlFor="benefit-none">
                        <span className="booking-benefit-choice__main">
                          <input
                            className="form-check-input"
                            type="radio"
                            name="benefit_choice"
                            id="benefit-none"
                            checked={benefitId === "none"}
                            onChange={() => setBenefitId("none")}
                          />
                          <span className="booking-benefit-choice__copy">
                            <span className="giftcard-choice__name">Nessun vantaggio</span>
                            <span className="giftcard-choice__meta">Mantieni il totale standard.</span>
                          </span>
                        </span>
                        <span className="giftcard-choice__amount">€ {fmtMoney(subtotal)}</span>
                      </label>
                      {ctx.benefits.map((benefit) => (
                        <label key={benefit.id} className="giftcard-choice booking-benefit-choice" htmlFor={`benefit-${benefit.id}`}>
                          <span className="booking-benefit-choice__main">
                            <input
                              className="form-check-input"
                              type="radio"
                              name="benefit_choice"
                              id={`benefit-${benefit.id}`}
                              checked={benefitId === benefit.id}
                              onChange={() => setBenefitId(benefit.id)}
                            />
                            <span className="booking-benefit-choice__copy">
                              <span className="giftcard-choice__name">{benefit.label}</span>
                              <span className="giftcard-choice__meta">{benefit.detail}</span>
                            </span>
                          </span>
                          <span className="giftcard-choice__amount">- € {fmtMoney(estimateDiscount(benefit, subtotal))}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Fidelity / Credit / Giftcard panels — WIRED to action=fidelity_preview
                    (logged customer only). Each stays hidden when there is nothing to
                    spend; the selected amounts preview in the recap and travel with the
                    confirm (re-validated + clamped server-side). */}
                <div id="recFidelityBox" className={`booking-benefit-panel${custBenefits && custBenefits.redeemEnabled && custBenefits.suggestedDiscount > 0 ? "" : " d-none"}`}>
                  <div className="d-flex justify-content-between align-items-start gap-3">
                    <div>
                      <div className="fw-semibold">
                        <i className="bi bi-percent me-1" />
                        Punti Fidelity
                      </div>
                      <div className="small text-muted" id="recFidelityHint" />
                    </div>
                    <div className="small text-muted" id="recFidelityAvail">
                      Disponibili: {custBenefits?.pointsAvailable ?? 0} Punti
                    </div>
                  </div>
                  <div className="d-grid gap-2 mt-3">
                    <label className="giftcard-choice booking-benefit-choice" id="recFidelityToggleRow" htmlFor="recFidelityUseToggle">
                      <span className="booking-benefit-choice__main">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id="recFidelityUseToggle"
                          checked={useFidelity}
                          onChange={(e) => setUseFidelity(e.target.checked)}
                        />
                        <span className="booking-benefit-choice__copy">
                          <span className="giftcard-choice__name">Usa sconto Punti Fidelity</span>
                          <span className="giftcard-choice__meta">
                            I punti verranno scalati quando l&apos;appuntamento sarà eseguito.
                          </span>
                        </span>
                      </span>
                      <span className="giftcard-choice__amount" id="recFidelityDiscountAmount">
                        - € {fmtMoney(custBenefits?.suggestedDiscount ?? 0)}
                      </span>
                    </label>
                  </div>
                </div>

                <div id="recCreditUseBox" className={`booking-benefit-panel${custBenefits && custBenefits.creditAvailable > 0 ? "" : " d-none"}`}>
                  <div className="d-flex justify-content-between align-items-start gap-3">
                    <div>
                      <div className="fw-semibold">
                        <i className="bi bi-wallet2 me-1" />
                        Credito
                      </div>
                      <div className="small text-muted">Usa il credito disponibile sul tuo profilo.</div>
                    </div>
                  </div>
                  <div className="d-grid gap-2 mt-3">
                    <label className="giftcard-choice booking-benefit-choice" htmlFor="recCreditUseToggle">
                      <span className="booking-benefit-choice__main">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id="recCreditUseToggle"
                          checked={useCredit}
                          onChange={(e) => setUseCredit(e.target.checked)}
                        />
                        <span className="booking-benefit-choice__copy">
                          <span className="giftcard-choice__name">Usa credito disponibile</span>
                          <span className="giftcard-choice__meta">Per questa prenotazione</span>
                        </span>
                      </span>
                      <strong className="giftcard-choice__amount" id="recCreditAvail">
                        € {fmtMoney(custBenefits?.creditAvailable ?? 0)}
                      </strong>
                    </label>
                  </div>
                </div>

                <div id="recGiftcardUseBox" className={`booking-benefit-panel${custBenefits && custBenefits.giftcards.length > 0 ? "" : " d-none"}`}>
                  <div className="d-flex justify-content-between align-items-start gap-3">
                    <div>
                      <div className="fw-semibold">
                        <i className="bi bi-gift me-1" />
                        GiftCard
                      </div>
                      <div className="small text-muted" id="recGiftcardHint">
                        Scegli una GiftCard da applicare al residuo.
                      </div>
                    </div>
                  </div>
                  <div id="recGiftcardList" className="d-grid gap-2 mt-3">
                    {(custBenefits?.giftcards ?? []).map((card) => (
                      <label key={card.id} className="giftcard-choice booking-benefit-choice" htmlFor={`recGiftcard-${card.id}`}>
                        <span className="booking-benefit-choice__main">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`recGiftcard-${card.id}`}
                            checked={giftcardChoiceId === card.id}
                            onChange={(e) => setGiftcardChoiceId(e.target.checked ? card.id : 0)}
                          />
                          <span className="booking-benefit-choice__copy">
                            <span className="giftcard-choice__name">GiftCard {card.code}</span>
                            <span className="giftcard-choice__meta">Saldo disponibile</span>
                          </span>
                        </span>
                        <strong className="giftcard-choice__amount">€ {fmtMoney(card.balance)}</strong>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* STEP 7: Riepilogo prima dell'invio */}
              <div className={`wizard-step${step === 7 ? "" : " d-none"}`} data-step="7">
                <div className="mb-2 small-muted">
                  Controlla i dettagli del tuo appuntamento e premi su <strong>Invia</strong> per confermare.
                </div>

                {confirmation ? (
                  <div className="alert alert-success booking-alert-rounded mt-3">
                    <div className="fw-bold">
                      <i className="bi bi-check2-circle me-1" />
                      Richiesta inviata
                    </div>
                    <div className="small mt-1">
                      Prenotazione <strong>{confirmation.publicCode}</strong> in attesa di conferma per {formatDateIt(confirmation.date)} alle {confirmation.time}.
                    </div>
                  </div>
                ) : null}

                <div className="mt-3">
                  <div className="fw-bold booking-recap-service-title" id="recServiceTitle">
                    {selectedServices.map((service) => service.name).join(", ") || "—"}
                  </div>
                  <div className="text-muted" id="recDateTime">
                    {slot ? `${formatDateIt(date)} · ${slot}` : "—"}
                  </div>
                </div>

                <div className="row g-3 mt-2">
                  <div className="col-md-6">
                    <div className="small-muted">Operatore</div>
                    <div className="d-flex align-items-center gap-2 mt-2">
                      <div className="recap-avatar">
                        <i className="bi bi-person" />
                      </div>
                      <div>
                        <div className="fw-semibold" id="recStaffName">
                          {staffName}
                        </div>
                        <div className="small text-muted" id="recStaffDetails" />
                      </div>
                    </div>
                  </div>
                  <div className="col-md-6">
                    <div className="small-muted">Posizione</div>
                    <div className="mt-2 fw-semibold" id="recLocationName">
                      {selectedLocation?.name ?? "—"}
                    </div>
                    <div className="text-muted small" id="recLocationAddress">
                      {selectedLocation?.address ?? ""}
                    </div>
                  </div>
                </div>

                <hr className="my-4" />

                <div className="small-muted">Cliente</div>
                <div className="d-flex align-items-center gap-2 mt-2">
                  <div className="recap-avatar" id="recClientInitials">
                    {initialsOf(clientFullName) || "..."}
                  </div>
                  <div className="w-100">
                    <div className="row g-2">
                      <div className="col-md-6">
                        <input
                          className="form-control"
                          placeholder="Nome"
                          value={firstName}
                          onChange={(event) => setFirstName(event.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <input
                          className="form-control"
                          placeholder="Cognome"
                          value={lastName}
                          onChange={(event) => setLastName(event.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <input
                          className="form-control"
                          type="email"
                          placeholder="Email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </div>
                      <div className="col-md-6">
                        <input
                          className="form-control"
                          placeholder="Telefono"
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <hr className="my-4" />

                <div className="small-muted mb-2">Dettaglio Costi</div>
                <div id="recCostLines">
                  {selectedServices.map((service) => (
                    <div key={service.id} className="summary-row summary-row--no-border">
                      <div className="label">{service.name}</div>
                      <div className="fw-semibold">€ {fmtMoney(service.price)}</div>
                    </div>
                  ))}
                  {discount > 0 ? (
                    <div className="summary-row summary-row--no-border">
                      <div className="label">{couponApplied ? (couponApplied.isPromotion ? `Promozione ${couponApplied.promotionTitle || couponApplied.code}` : `Coupon ${couponApplied.code}`) : autoPromo ? `Promozione ${autoPromo.title}` : selectedBenefit?.label ?? "Sconto"}</div>
                      <div className="fw-semibold text-success">- € {fmtMoney(discount)}</div>
                    </div>
                  ) : null}
                  {fidelityDiscountApplied > 0 ? (
                    <div className="summary-row summary-row--no-border">
                      <div className="label">Sconto Punti Fidelity</div>
                      <div className="fw-semibold text-success">- € {fmtMoney(fidelityDiscountApplied)}</div>
                    </div>
                  ) : null}
                  {giftcardAppliedAmount > 0 ? (
                    <div className="summary-row summary-row--no-border">
                      <div className="label">GiftCard {chosenGiftcard?.code ?? ""}</div>
                      <div className="fw-semibold text-success">- € {fmtMoney(giftcardAppliedAmount)}</div>
                    </div>
                  ) : null}
                  {creditAppliedAmount > 0 ? (
                    <div className="summary-row summary-row--no-border">
                      <div className="label">Credito</div>
                      <div className="fw-semibold text-success">- € {fmtMoney(creditAppliedAmount)}</div>
                    </div>
                  ) : null}
                </div>

                <div className="summary-total summary-total--compact">
                  <div>Prezzo Totale</div>
                  <div id="recTotal">€ {fmtMoney(payableTotal)}</div>
                </div>

                {/* Nota punti Fidelity (legacy #recFidelityNote, booking.php 13313):
                    reminds the customer the points are only RESERVED until executed. */}
                <div id="recFidelityNote" className={`alert alert-info p-2 mt-2${fidelityDiscountApplied > 0 ? "" : " d-none"}`}>
                  <div className="small">
                    <i className="bi bi-info-circle me-1" />
                    Verranno prenotati {custBenefits?.suggestedPoints ?? 0} Punti Fidelity: saranno scalati quando l&apos;appuntamento sarà eseguito.
                  </div>
                </div>

                <div id="recPromoConditions" className="alert alert-info p-2 mt-2 d-none booking-alert-rounded">
                  <div className="d-flex gap-2">
                    <i className="bi bi-info-circle" />
                    <div className="small">
                      <div className="fw-semibold">Condizioni promozionali</div>
                      <div id="recPromoConditionsText" />
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-end">
                  {/* Promotions + coupon box (static markup). */}
                  <div id="promotionsBox" className="mt-2 d-none text-start">
                    <div className="small fw-semibold mb-1">
                      <i className="bi bi-megaphone me-1" />
                      Promozioni disponibili
                    </div>
                    <div id="promotionsList" className="d-grid gap-2" />
                  </div>

                  <a href="#" className="text-success small text-decoration-underline" id="couponToggle" onClick={(event) => event.preventDefault()}>
                    Hai un codice coupon?
                  </a>

                  <div className="mt-2 d-none" id="couponBox">
                    <div className="input-group input-group-sm">
                      <input className="form-control" id="couponInput" type="text" placeholder="Inserisci codice (es. WELCOME10)" autoComplete="off" />
                      <button className="btn btn-outline-success" type="button" id="couponApplyBtn">
                        Applica
                      </button>
                      <button className="btn btn-outline-secondary" type="button" id="couponRemoveBtn">
                        Rimuovi
                      </button>
                    </div>
                    <div className="small mt-1" id="couponMsg" />
                  </div>
                </div>
              </div>
            </form>

            <div className="booking-foot" style={{ display: "flex" }}>
              <a
                href="#"
                id="btnBack"
                className="text-decoration-none"
                onClick={(event) => {
                  event.preventDefault();
                  handleBack();
                }}
                style={step <= 1 ? { visibility: "hidden" } : undefined}
              >
                <i className="bi bi-arrow-left me-1" />
                Indietro
              </a>
              <button type="button" className="btn btn-outline-secondary booking-recap-btn d-none" id="btnRecap">
                <i className="bi bi-receipt me-1" />
                Riepilogo
              </button>
              <button
                type="button"
                className="btn btn-success btn-pill px-4"
                id="btnNext"
                disabled={!canContinue || Boolean(confirmation)}
                onClick={handleNext}
              >
                {nextLabel} <i className={`bi ${nextIcon} ms-1`} />
              </button>
            </div>
          </div>

          {/* RIGHT SUMMARY ASIDE (live recap) */}
          <aside className="booking-summary">
            <div className="booking-summary__business">
              <div className="booking-summary__logo">{businessInitial}</div>
              <div className="booking-summary__identity">
                <div className="booking-summary__name">{ctx?.business.name ?? "—"}</div>
                {selectedLocation?.address ? <div className="booking-summary__address">{selectedLocation.address}</div> : null}
                {ctx?.business.phone ? (
                  <div className="booking-summary__contact">
                    Chiama: <a href={`tel:${ctx.business.phone.replace(/\s+/g, "")}`}>{ctx.business.phone}</a>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="booking-summary__selection" id="summarySelectionText">
              {selectedServices.length ? (
                <>
                  <strong>{selectedServices.map((service) => service.name).join(", ")}</strong>
                </>
              ) : (
                "Nessun servizio selezionato"
              )}
            </div>

            <div className="summary-title">Riepilogo</div>

            <div className="summary-block">
              <div className="summary-row">
                <div className="label">Operatore</div>
                <div className="fw-semibold" id="sumStaff">
                  {staffName}
                </div>
              </div>
              <div className="summary-row summary-row--staff-detail">
                <div className="label" />
                <div className="small text-muted text-end" id="sumStaffDetails" />
              </div>
              <div className="summary-row">
                <div className="label">Posizione</div>
                <div className="fw-semibold" id="sumLocation">
                  {selectedLocation?.name ?? "—"}
                </div>
              </div>
              <div className="summary-row">
                <div className="label">Servizi</div>
                <div className="fw-semibold text-end" id="sumServices">
                  {selectedServices.length || "—"}
                </div>
              </div>
              <div className="summary-row">
                <div className="label">Data/Ora</div>
                <div className="fw-semibold text-end" id="sumDateTime">
                  {slot ? `${formatDateIt(date)} · ${slot}` : "—"}
                </div>
              </div>
              <div className="summary-row">
                <div className="label">Durata</div>
                <div className="fw-semibold text-end" id="sumDuration">
                  {totalDuration ? `${totalDuration} min` : "—"}
                </div>
              </div>
            </div>

            <div className="summary-block mt-4">
              <div className="small-muted mb-1">DETTAGLIO COSTI</div>
              <div id="sumCostLines">
                {selectedServices.map((service) => (
                  <div key={service.id} className="summary-row summary-row--no-border">
                    <div className="label">{service.name}</div>
                    <div className="fw-semibold">€ {fmtMoney(service.price)}</div>
                  </div>
                ))}
                {discount > 0 ? (
                  <div className="summary-row summary-row--no-border">
                    <div className="label">{couponApplied ? (couponApplied.isPromotion ? `Promozione ${couponApplied.promotionTitle || couponApplied.code}` : `Coupon ${couponApplied.code}`) : autoPromo ? `Promozione ${autoPromo.title}` : selectedBenefit?.label ?? "Sconto"}</div>
                    <div className="fw-semibold text-success">- € {fmtMoney(discount)}</div>
                  </div>
                ) : null}
              </div>
              <div id="sumFidelityNote" className="alert alert-info p-2 mt-2 d-none" />
              <div className="summary-total">
                <div>Prezzo Totale</div>
                <div id="sumTotal">€ {fmtMoney(payableTotal)}</div>
              </div>
            </div>

            <button
              type="button"
              className="booking-summary__cta"
              id="btnNextSummary"
              disabled={!canContinue || Boolean(confirmation)}
              onClick={handleNext}
            >
              {isFinalStep ? "Invia" : "Continua"}
            </button>
          </aside>
        </div>

        <nav className="booking-bottom-nav" aria-label="Navigazione booking">
          <a className="booking-bottom-nav__item" href={`/${slug}/booking`}>
            <i className="bi bi-house" />
            <span>Home</span>
          </a>
          <a className="booking-bottom-nav__item" href={`/${slug}/booking?hub=1`}>
            <i className="bi bi-person-square" />
            <span>Pannello</span>
          </a>
          <button type="button" className="booking-bottom-nav__item is-active" aria-current="page">
            <i className="bi bi-calendar-plus-fill" />
            <span>Prenota</span>
          </button>
        </nav>
      </div>

      {/* Recap popup (static markup, faithful). */}
      <div className="booking-recap-popup d-none" id="bookingRecapPopup" role="dialog" aria-modal="true" aria-labelledby="bookingRecapPopupTitle">
        <div className="booking-recap-popup__backdrop" data-recap-close="1" />
        <div className="booking-recap-popup__dialog">
          <button type="button" className="booking-recap-popup__close" id="bookingRecapClose" aria-label="Chiudi riepilogo">
            <i className="bi bi-x-lg" />
          </button>
          <div className="small-muted">Riepilogo</div>
          <h5 className="booking-recap-popup__title fw-bold mt-1 mb-1" id="bookingRecapPopupTitle">
            Prenotazione
          </h5>
          <div className="text-muted small" id="bookingRecapPopupDateTime">
            —
          </div>

          <div className="summary-block mt-3">
            <div className="summary-row">
              <div className="label">Operatore</div>
              <div className="fw-semibold text-end" id="bookingRecapPopupStaff">
                —
              </div>
            </div>
            <div className="summary-row">
              <div className="label">Sede</div>
              <div className="fw-semibold text-end" id="bookingRecapPopupLocation">
                —
              </div>
            </div>
            <div className="summary-row">
              <div className="label">Durata</div>
              <div className="fw-semibold text-end" id="bookingRecapPopupDuration">
                —
              </div>
            </div>
          </div>

          <div className="summary-block mt-3">
            <div className="small-muted mb-2">Dettaglio Costi</div>
            <div id="bookingRecapPopupCostLines" />
            <div id="bookingRecapPopupFidelityNote" className="alert alert-info p-2 mt-2 d-none" />
            <div id="bookingRecapPopupPromoConditions" className="alert alert-info p-2 mt-2 d-none" />
            <div className="summary-total booking-recap-popup__total">
              <div>Prezzo Totale</div>
              <div id="bookingRecapPopupTotal">€ 0</div>
            </div>
          </div>
        </div>
      </div>

      {/* Customer-area modal (static markup, faithful — Bootstrap modal classes; tabs not wired). */}
      <div className="modal fade" id="customerModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Area clienti</div>
                <h5 className="modal-title fw-bold m-0" id="customerModalTitle">
                  Il mio account
                </h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>

            <div className="modal-body">
              <div id="custLoggedOut">
                <ul className="nav nav-pills gap-2 mb-3" id="custTabs" role="tablist">
                  <li className="nav-item" role="presentation">
                    <button className="nav-link active" id="tab-login" type="button" role="tab">
                      Accedi
                    </button>
                  </li>
                  <li className="nav-item" role="presentation">
                    <button className="nav-link" id="tab-register" type="button" role="tab">
                      Registrati
                    </button>
                  </li>
                </ul>

                <div id="custAuthAlert" className="alert alert-danger d-none" />

                <div className="tab-content">
                  <div className="tab-pane fade show active" id="pane-login" role="tabpanel" aria-labelledby="tab-login">
                    <form id="custLoginForm" className="row g-3">
                      <div className="col-12 col-md-6">
                        <label className="form-label">Email</label>
                        <input className="form-control" type="email" name="email" />
                      </div>
                      <div className="col-12 col-md-6">
                        <label className="form-label">Password</label>
                        <input className="form-control" type="password" name="password" />
                      </div>
                      <div className="col-12">
                        <button className="btn btn-primary btn-pill" type="button">
                          <i className="bi bi-box-arrow-in-right me-1" />
                          Accedi
                        </button>
                      </div>
                    </form>
                  </div>

                  <div className="tab-pane fade" id="pane-register" role="tabpanel" aria-labelledby="tab-register">
                    <form id="custRegisterForm" className="row g-3">
                      <div className="col-12 col-md-6">
                        <label className="form-label">Nome</label>
                        <input className="form-control" type="text" name="first_name" />
                      </div>
                      <div className="col-12 col-md-6">
                        <label className="form-label">Cognome</label>
                        <input className="form-control" type="text" name="last_name" />
                      </div>
                      <div className="col-12 col-md-6">
                        <label className="form-label">Telefono</label>
                        <input className="form-control" type="text" name="phone" placeholder="+39 ..." />
                      </div>
                      <div className="col-12 col-md-6">
                        <label className="form-label">Email</label>
                        <input className="form-control" type="email" name="email" />
                      </div>
                      <div className="col-12">
                        <button className="btn btn-success btn-pill" type="button">
                          <i className="bi bi-person-plus me-1" />
                          Crea account
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>

              <div id="custLoggedIn" className="d-none">
                <div className="d-flex justify-content-between align-items-start gap-3 mb-3">
                  <div>
                    <div className="fw-semibold" id="custHello">
                      Ciao!
                    </div>
                    <div className="text-muted small" id="custEmail" />
                  </div>
                  <button className="btn btn-outline-danger btn-sm btn-pill" id="custLogoutBtn" type="button">
                    <i className="bi bi-box-arrow-right me-1" />
                    Esci
                  </button>
                </div>
                <div className="fw-semibold mb-2">I miei appuntamenti</div>
                <div id="custApptList" className="d-grid gap-2" />
                <div id="custApptEmpty" className="text-muted small d-none">
                  Nessun appuntamento trovato per questa email.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- helpers ----------

function estimateDiscount(benefit: BookingBenefit | null, total: number): number {
  if (!benefit) return 0;
  const value = benefit.discountValue ?? 0;
  const amount = benefit.discountType === "fixed" ? value : total * (value / 100);
  return Math.max(0, Math.min(total, Math.round(amount * 100) / 100));
}

function fmtMoney(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function toYmd(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseYmd(ymd: string): Date | null {
  const match = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatMonthYearIt(date: Date): string {
  return `${MONTHS_IT[date.getMonth()]} ${date.getFullYear()}`;
}

function formatDateIt(ymd: string): string {
  const date = parseYmd(ymd);
  if (!date) return ymd;
  return `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()} ${MONTHS_IT[date.getMonth()]}`;
}

export default BookingFaithful;
