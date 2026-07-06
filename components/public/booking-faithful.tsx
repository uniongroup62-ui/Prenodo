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

type BookingCategory = { id: number; name: string; imageUrl?: string };

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
  // booking_choose_staff_enabled: se false lo step Professionista viene
  // SALTATO e l'operatore è assegnato automaticamente (legacy CHOOSE_STAFF_ENABLED).
  chooseStaffEnabled?: boolean;
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
  // Set from the confirm response: true when the booking is linked to the
  // logged customer account (gates the .ics download button).
  accountLinked?: boolean;
  staffId: number | null;
  locationId: number | null;
  // Righe costi per-servizio (listino/scontato/badge) dal server.
  services?: Array<{ serviceId: number; name: string; listPrice: number; price: number; badge: string }>;
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

// Titoli/descrizioni VERBATIM dal runtime del legacy (booking-wizard.js
// showStep, 3241-3285) — quirk preservati ('piu' senza accento, "l'orario").
const STEP_HEAD: Record<number, { title: string; desc: string }> = {
  1: { title: "Scegli la sede", desc: "Seleziona il centro in cui vuoi prenotare." },
  2: { title: "Scegli una categoria", desc: "Scegli da dove iniziare il percorso." },
  3: { title: "Servizi", desc: "Seleziona uno o piu trattamenti e continua quando sei pronto." },
  4: { title: "Professionista", desc: "Scegli il professionista per ogni servizio selezionato." },
  5: { title: "Data e ora", desc: "Scegli la data e poi l'orario che preferisci." },
  6: { title: "Vantaggi", desc: "Applica Punti Fidelity, credito o GiftCard disponibili prima della conferma." },
  7: { title: "Conferma", desc: "Controlla tutti i dettagli e invia la prenotazione." },
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
  initialLocationId = 0,
  initialSkipLocation = false,
}: { slug?: string; redeemPrefill?: BookingRedeemPrefill | null; initialLocationId?: number; initialSkipLocation?: boolean } = {}) {
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

  // Sede unica nota dal server: parte già da Categoria (2) — niente flash Sede.
  const [step, setStep] = useState(initialSkipLocation ? 2 : 1);
  const [locationId, setLocationId] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [serviceIds, setServiceIds] = useState<number[]>([]);
  const [operatorId, setOperatorId] = useState<number | "any">("any");
  const [date, setDate] = useState<string>(() => toYmd(new Date()));
  const [stripStart, setStripStart] = useState<Date>(() => startOfDay(new Date()));
  const [slot, setSlot] = useState("");
  const [availableSlots, setAvailableSlots] = useState<BookingSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Ore espanse (toggle "Mostra tutti") nella vista slot raggruppata.
  const [expandedHours, setExpandedHours] = useState<Set<string>>(new Set());
  const [hold, setHold] = useState<BookingHold | null>(null);
  // Countdown live dell'hold (booking-wizard.js bookingStartHoldCountdown): tick 1s.
  const [holdNow, setHoldNow] = useState(0);
  // Auto-refresh silenzioso della disponibilità ogni 15s sullo step Data/Ora.
  const [slotRefreshTick, setSlotRefreshTick] = useState(0);
  // Secondi rimanenti + scaduto (expiresAt è ora locale "YYYY-MM-DD HH:MM:SS").
  const holdExpiresMs = hold ? new Date(hold.expiresAt.replace(" ", "T")).getTime() : 0;
  const holdRemainingSec = hold && holdNow > 0 ? Math.max(0, Math.round((holdExpiresMs - holdNow) / 1000)) : 0;
  const holdExpired = Boolean(hold) && holdNow > 0 && holdRemainingSec <= 0;
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
  // Importi REALMENTE applicati dal server al confirm (clampati/ri-validati):
  // la schermata di conferma li usa al posto dello stato client ottimistico
  // (post-book-amounts, come il legacy che ricarica dal DB).
  const [appliedAmounts, setAppliedAmounts] = useState<
    { fidelityPoints: number; fidelityDiscount: number; creditUsed: number; giftcardUsed: number } | null
  >(null);

  // Cliente loggato (refreshCustomerUI + fillClientStepFromUser legacy,
  // booking-wizard.js 4631-4818): il flusso marketplace arriva sempre
  // autenticato (gate), quindi i dati vengono precompilati dall'account
  // (solo i campi vuoti), l'email diventa readonly e il bottone in alto
  // mostra 'I miei appuntamenti' invece di 'Accedi'.
  const [bookingUser, setBookingUser] = useState<{ email: string; fullName: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/account")
      .then((r) => r.json())
      .then((j: { ok?: boolean; user?: { email?: string; fullName?: string; firstName?: string; lastName?: string; phone?: string } | null }) => {
        if (!alive || !j?.ok || !j.user?.email) return;
        const u = j.user;
        setBookingUser({ email: String(u.email ?? ""), fullName: String(u.fullName ?? "").trim() });
        // fillClientStepFromUser: nome/cognome dai campi salvati o dallo split
        // del full_name; compila SOLO i campi ancora vuoti.
        const savedFirst = String(u.firstName ?? "").trim();
        const savedLast = String(u.lastName ?? "").trim();
        const full = String(u.fullName ?? "").trim();
        let first = savedFirst;
        let last = savedLast;
        if ((!first || !last) && full) {
          const parts = full.split(/\s+/).filter(Boolean);
          if (!first) first = parts.shift() ?? "";
          if (!last) last = parts.join(" ");
        }
        if (first) setFirstName((cur) => cur || first);
        if (last) setLastName((cur) => cur || last);
        const accEmail = String(u.email ?? "").trim();
        if (accEmail) setEmail((cur) => cur || accEmail);
        const accPhone = String(u.phone ?? "").trim();
        if (accPhone) setPhone((cur) => cur || accPhone);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

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
        // Sede d'ingresso: onora ?location_id= (o la sede di riferimento) se
        // valida, altrimenti la prima sede (booking-wizard.js $defaultBookingLocationId).
        const entryLoc = initialLocationId > 0 && ctx.locations.some((l) => l.id === initialLocationId)
          ? initialLocationId
          : ctx.locations[0]?.id ?? 0;
        setLocationId(entryLoc);
        // Il legacy NON preseleziona una categoria con più categorie (validateStep
        // step 2 richiede una scelta); con UNA sola categoria (nella sede
        // d'ingresso) la auto-seleziona.
        const catsAtEntryLoc = ctx.categories.filter((cat) =>
          ctx.services.some(
            (service) =>
              service.categoryId === cat.id &&
              (service.locationIds.length === 0 || service.locationIds.includes(entryLoc)),
          ),
        );
        setCategoryId(catsAtEntryLoc.length === 1 ? catsAtEntryLoc[0]?.id ?? null : null);
        // Deep-link prefill: preselect the covered service (and its category) so
        // the customer lands with the redeem's service already in the cart.
        if (redeemPrefill && redeemPrefill.serviceId > 0) {
          const svc = ctx.services.find((s) => s.id === redeemPrefill.serviceId);
          if (svc) {
            setServiceIds([svc.id]);
            if (svc.categoryId) setCategoryId(svc.categoryId);
          }
        }
        // shouldSkipLocationStep: con una sola sede il legacy parte dallo step
        // Categoria (salta "Scegli la sede"). Avanza solo se siamo ancora al primo.
        if (ctx.locations.length === 1) setStep((s) => (s === 1 ? 2 : s));
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
    setExpandedHours(new Set());
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

  // Auto-refresh silenzioso ogni 15s sullo step Data/Ora (in pausa se la tab è
  // nascosta), come il legacy — senza azzerare la selezione/hold.
  useEffect(() => {
    if (step !== 5) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) setSlotRefreshTick((tick) => tick + 1);
    }, 15000);
    return () => window.clearInterval(id);
  }, [step]);
  useEffect(() => {
    if (step !== 5 || !serviceIds.length || !locationId || slotRefreshTick === 0) return;
    let active = true;
    const params = new URLSearchParams({ slug, action: "slots", date, service_ids: serviceIds.join(","), location_id: String(locationId) });
    if (operatorId !== "any") params.set("staff_id", String(operatorId));
    void fetch(`/api/booking?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (active && data.ok && Array.isArray(data.slots)) setAvailableSlots(data.slots as BookingSlot[]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotRefreshTick]);

  const ctx = context;
  // shouldSkipLocationStep (booking-wizard.js: skipLocationStep = locationCards.length===1):
  // con una sola sede il legacy SALTA lo step "Scegli la sede" (parte da
  // Categoria, contatore -1). Con più sedi lo step resta.
  const skipLocationStep = ctx ? ctx.locations.length === 1 : initialSkipLocation;
  const firstStep = skipLocationStep ? 2 : 1;
  // Default true finché il context non è caricato (nessuno skip prematuro).
  const chooseStaffEnabled = ctx ? ctx.chooseStaffEnabled !== false : true;
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
  // Categorie con almeno un servizio prenotabile NELLA sede selezionata
  // (booking.php 3061-3070: $visibleCategoryIds dei servizi già filtrati per sede).
  const categoriesForLocation = useMemo(
    () =>
      ctx
        ? ctx.categories.filter((cat) =>
            ctx.services.some(
              (service) =>
                service.categoryId === cat.id &&
                (service.locationIds.length === 0 || service.locationIds.includes(locationId)),
            ),
          )
        : [],
    [ctx, locationId],
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
    // Legacy: fidelityPreview viene aggiornata al variare del carrello (non
    // solo allo step 6) perché decide ANCHE la visibilità dello step
    // "Vantaggi" nel progress (hasBenefitsAvailable, booking-wizard.js 761).
    // Con carrello vuoto niente fetch: hasBenefitsAvailable ha il guard su
    // serviceIds.length, quindi lo stato stantio non conta.
    if (!serviceIdsKey) return;
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

  // Port di hasBenefitsAvailable (booking-wizard.js 761-777): lo step
  // "Vantaggi" esiste solo se il cliente loggato ha davvero qualcosa da
  // spendere (punti con sconto > 0, giftcard, o credito con saldo > 0 su un
  // importo residuo > 0). Altrimenti l'item del progress è nascosto, il
  // contatore scala a "di 6" e la navigazione salta dallo step 5 al 7.
  const hasBenefitsAvailable = Boolean(
    serviceIds.length > 0 &&
      custBenefits &&
      ((custBenefits.redeemEnabled && custBenefits.suggestedPoints > 0 && custBenefits.suggestedDiscount > 0.00001) ||
        (finalTotal > 0.00001 && custBenefits.giftcards.length > 0) ||
        (finalTotal > 0.00001 && custBenefits.logged && custBenefits.creditAvailable > 0.00001)),
  );
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

  // ensureDateSelectionReady (booking-wizard.js 3677-3700): entrando nello step
  // Data/Ora, se la data selezionata è chiusa o nel passato, auto-seleziona la
  // PRIMA data disponibile (e allinea lo strip), come il legacy — invece di
  // restare su una data chiusa con "Nessuna disponibilità".
  useEffect(() => {
    if (step !== 5) return;
    const todayStart = startOfDay(new Date());
    const invalid = date < toYmd(todayStart) || isClosedDay(new Date(`${date}T00:00:00`));
    if (!invalid) return;
    for (let i = 0; i < 90; i += 1) {
      const day = addDays(todayStart, i);
      if (!isClosedDay(day)) {
        const ymd = toYmd(day);
        if (ymd !== date) {
          setDate(ymd);
          setStripStart(startOfDay(day));
        }
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, closures, date]);

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
    if (step === 2) return categoryId != null;
    if (step === 3) return serviceIds.length > 0;
    // Step 5-7: serve uno slot con hold ANCORA valido (validateStep legacy) —
    // niente Avanti/Invia con hold scaduto.
    if (step === 5) return Boolean(slot) && !slotsLoading && Boolean(hold) && !holdExpired;
    if (step === 6) return Boolean(hold) && !holdExpired;
    if (step === 7) return Boolean(firstName.trim()) && Boolean(email.trim()) && Boolean(slot) && Boolean(hold) && !holdExpired;
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
      // Con la scelta operatore disattivata (booking_choose_staff_enabled=0) lo
      // step 4 "Professionista" viene SALTATO come nel legacy (skippedStaffStep):
      // resta "Qualsiasi" e l'operatore arriva dallo slot (auto-assegnazione).
      setStep((current) => {
        let next = Math.min(7, current + 1);
        if (next === 4 && !chooseStaffEnabled) {
          setOperatorId("any");
          next = 5;
        }
        // showStep legacy (booking-wizard.js 3212): senza vantaggi lo step 6
        // viene saltato e le selezioni benefit azzerate.
        if (next === 6 && !hasBenefitsAvailable) {
          setUseFidelity(false);
          setUseCredit(false);
          setGiftcardChoiceId(0);
          next = 7;
        }
        return next;
      });
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
      // accountLinked gates the .ics button: the calendar endpoint serves only
      // the LOGGED customer's own bookings (the legacy page was login-gated).
      setAppliedAmounts({
        fidelityPoints: Number(data.fidelity_points_used ?? 0) || 0,
        fidelityDiscount: Number(data.fidelity_discount ?? 0) || 0,
        creditUsed: Number(data.credit_used ?? 0) || 0,
        giftcardUsed: Number(data.giftcard_used ?? 0) || 0,
      });
      setConfirmation({ ...(data.confirmation as BookingConfirmation), accountLinked: Boolean(data.accountLinked) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Prenotazione non completata.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    setError("");
    setStep((current) => {
      // Legacy (booking-wizard.js 4097): dal riepilogo senza vantaggi si
      // torna direttamente a Data/Ora.
      if (current === 7 && !hasBenefitsAvailable) return 5;
      let prev = Math.max(firstStep, current - 1);
      if (prev === 4 && !chooseStaffEnabled) prev = 3;
      // Non tornare mai allo step Sede quando è saltato (sede unica).
      if (prev === 1 && skipLocationStep) prev = 2;
      return prev;
    });
  }

  // Come il legacy: lo slot endpoint/render mostra SOLO gli orari liberi
  // (booking.php $slots contiene solo i disponibili; nessun pulsante disabilitato).
  const freeSlots = availableSlots.filter((item) => item.available);
  const slotGroups = useMemo(() => buildSlotGroups(freeSlots.map((s) => s.time)), [freeSlots]);
  const slotByTime = useMemo(() => new Map(freeSlots.map((s) => [s.time, s])), [freeSlots]);
  const toggleHour = (key: string) =>
    setExpandedHours((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Effetti del countdown hold: tick 1s + gestione scadenza (rilascia l'hold,
  // azzera lo slot, torna a Data/Ora). I valori derivati (holdRemainingSec/
  // holdExpired) sono calcolati più in alto (servono a computeCanContinue).
  useEffect(() => {
    if (!hold) return;
    setHoldNow(Date.now());
    const id = window.setInterval(() => setHoldNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hold]);
  useEffect(() => {
    if (!hold || !holdExpired) return;
    const token = hold.token;
    void fetch("/api/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release_hold", slug, token, owner_key: ownerKeyRef.current }),
    }).catch(() => {});
    setHold(null);
    setSlot("");
    setStep((current) => (current > 5 ? 5 : current));
    setError("Il tempo per riservare lo slot è scaduto. Scegli di nuovo un orario.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdExpired]);
  const businessInitial = (ctx?.business.name ?? "").trim().charAt(0).toUpperCase() || "B";
  const dateStripDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(stripStart, index)),
    [stripStart],
  );
  // Etichetta #btnNext come il legacy (booking-wizard.js showStep 3245-3288):
  // step 1-2 "Continua", step 3-6 "Avanti", step 7 "Invia".
  const nextLabel = isFinalStep ? "Invia" : step <= 2 ? "Continua" : "Avanti";
  const nextIcon = isFinalStep ? "bi-send" : "bi-arrow-right";

  // --- Schermata di conferma post-book (booking.php ?confirmed=1, 8889-9152):
  // il legacy REDIRIGE a una pagina dedicata (confirm-modal) al posto del
  // wizard; qui la rendiamo client-side con lo stato del wizard + il codice.
  if (confirmation) {
    // date('d') / date('M') PHP: mese abbreviato INGLESE (quirk legacy).
    const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [cy, cm, cd] = confirmation.date.split("-").map(Number);
    const confirmDay = String(cd ?? "").padStart(2, "0");
    const confirmMonth = MONTHS_EN[(cm ?? 1) - 1] ?? "";
    const dateLine = `${confirmDay}/${String(cm ?? "").padStart(2, "0")}/${cy}, ${confirmation.time}`;
    const svcTitle = selectedServices.length
      ? `${selectedServices[0].name}${selectedServices.length > 1 ? ` +${selectedServices.length - 1} servizi` : ""}`
      : "Appuntamento";
    const confirmLocation = ctx?.locations.find((loc) => loc.id === locationId) ?? null;
    // Etichetta della riga sconto: una PROMOZIONE mostra il titolo, un coupon
    // free-text mostra "Coupon <codice>" — non sempre "Coupon" (come il legacy).
    const confirmDiscountLabel = couponApplied
      ? couponApplied.isPromotion
        ? couponApplied.promotionTitle || "Promozione"
        : `Coupon ${couponApplied.code}`.trim()
      : autoPromo
        ? autoPromo.title
        : selectedBenefit?.type === "promotion"
          ? selectedBenefit.label || "Promozione"
          : `Coupon ${selectedBenefit?.type === "coupon" ? selectedBenefit.code ?? "" : ""}`.trim();
    // Importi dal server (clampati/ri-validati), non dallo stato client: il
    // Saldo dovuto = totale (dopo sconto coupon/promo) − fidelity − credito − giftcard.
    const appFidelityDiscount = appliedAmounts?.fidelityDiscount ?? 0;
    const appFidelityPoints = appliedAmounts?.fidelityPoints ?? 0;
    const appCreditUsed = appliedAmounts?.creditUsed ?? 0;
    const appGiftcardUsed = appliedAmounts?.giftcardUsed ?? 0;
    const appPayable = Math.max(
      0,
      Math.round((confirmation.total - appFidelityDiscount - appCreditUsed - appGiftcardUsed + Number.EPSILON) * 100) / 100,
    );
    return (
      <>
        {CSS_LINKS.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        <style dangerouslySetInnerHTML={{ __html: EMBED_INLINE_STYLE }} />

        <nav className="booking-bottom-nav" aria-label="Navigazione booking">
          <a className="booking-bottom-nav__item" href={`/attivita/${slug}`}>
            <i className="bi bi-house" />
            <span>Home</span>
          </a>
          <a className="booking-bottom-nav__item" href={`/${slug}/booking?hub=1`}>
            <i className="bi bi-person-square" />
            <span>Pannello</span>
          </a>
          <a className="booking-bottom-nav__item is-active" href={`/${slug}/booking?start=1`} aria-current="page">
            <i className="bi bi-calendar-plus-fill" />
            <span>Prenota</span>
          </a>
        </nav>

        <div className="booking-overlay">
          <div className="confirm-modal">
            <a className="confirm-close" href={`/${slug}/booking?public=1`} aria-label="Chiudi">
              <i className="bi bi-x-lg" />
            </a>

            <div className="confirm-top">
              <div className="confirm-check">
                <i className="bi bi-check-lg" />
              </div>
              <div className="h4 fw-bold mb-1">Richiesta inviata</div>
              <div className="text-muted small">In attesa di approvazione. Ti avviseremo via email.</div>
              <div className="mt-2">
                <span className="confirm-code">CODICE PRENOTAZIONE #{confirmation.publicCode}</span>
              </div>
            </div>

            <div className="confirm-body">
              <div className="appt-row">
                <div className="date-box">
                  <div className="day">{confirmDay}</div>
                  <div className="month">{confirmMonth}</div>
                </div>
                <div className="confirm-service-copy">
                  <div className="fw-bold confirm-service-title">{svcTitle}</div>
                  <div className="text-muted">{dateLine}</div>
                </div>
              </div>

              <div className="btn-row">
                {/* .ics solo con sessione cliente loggata (endpoint account-gated). */}
                {confirmation.accountLinked ? (
                  <a className="btn-soft" href={`/api/account/ics?code=${encodeURIComponent(confirmation.publicCode)}`}>
                    <i className="bi bi-calendar2-plus" /> Aggiungi al calendario
                  </a>
                ) : null}
                <button
                  className="btn-soft"
                  type="button"
                  id="printBtn"
                  onClick={() => {
                    if (typeof window !== "undefined") window.print();
                  }}
                >
                  <i className="bi bi-printer" /> Stampa
                </button>
              </div>

              <div className="sec-title">Operatore</div>
              <div className="fw-semibold">
                <div>{staffName || "—"}</div>
              </div>

              <div className="sec-title">Posizione</div>
              <div className="fw-semibold">{confirmLocation?.name ?? "—"}</div>
              {confirmLocation?.address ? <div className="text-muted small">{confirmLocation.address}</div> : null}

              <div className="sec-title">Cliente</div>
              <div className="fw-semibold">{clientFullName || "—"}</div>
              {email ? <div className="text-muted small">{email}</div> : null}

              <div className="sec-title">Dettaglio costi</div>
              {/* Per-servizio: prezzo di listino barrato + badge sconto/residuo +
                  prezzo scontato/0€ (renderPriceHtml legacy, booking.php 8957-8987). */}
              {(confirmation.services && confirmation.services.length
                ? confirmation.services
                : selectedServices.map((s) => ({ serviceId: s.id, name: s.name, listPrice: s.price, price: s.price, badge: "" }))
              ).map((line, index) => {
                const isRedeemed = Boolean(redeemPrefill && redeemPrefill.serviceId === line.serviceId && serviceIds.includes(line.serviceId));
                const nowPrice = isRedeemed ? 0 : line.price;
                const badge = isRedeemed
                  ? redeemPrefill?.kind === "package"
                    ? "Pacchetto"
                    : redeemPrefill?.kind === "prepaid"
                      ? "Prepagato"
                      : redeemPrefill?.kind === "giftbox"
                        ? "GiftBox"
                        : "gift"
                  : line.badge;
                const showOld = badge.trim() !== "" && line.listPrice > nowPrice + 0.00001;
                return (
                  <div className="line" key={`${line.serviceId}:${index}`}>
                    <div>{line.name}</div>
                    <div className="confirm-price">
                      {showOld ? (
                        <div className="price-row">
                          <span className="price-old">€ {fmtMoney(line.listPrice)}</span>
                          <span className="discount-badge">{badge}</span>
                        </div>
                      ) : null}
                      <div className="price-now">
                        <strong>€ {fmtMoney(nowPrice)}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
              {confirmation.discount > 0.00001 ? (
                <div className="line confirm-line-success">
                  <div>{confirmDiscountLabel}</div>
                  <div>
                    <strong>-€ {fmtMoney(confirmation.discount)}</strong>
                  </div>
                </div>
              ) : null}
              {appFidelityDiscount > 0.00001 ? (
                <div className="line confirm-line-success">
                  <div>Sconto Fidelity ({appFidelityPoints} Punti)</div>
                  <div>
                    <strong>-€ {fmtMoney(appFidelityDiscount)}</strong>
                  </div>
                </div>
              ) : null}
              {appCreditUsed > 0.00001 ? (
                <div className="line confirm-line-success">
                  <div>Credito</div>
                  <div>
                    <strong>-€ {fmtMoney(appCreditUsed)}</strong>
                  </div>
                </div>
              ) : null}
              {appGiftcardUsed > 0.00001 ? (
                <div className="line confirm-line-success">
                  <div>GiftCard{chosenGiftcard?.code ? ` ${chosenGiftcard.code}` : ""}</div>
                  <div>
                    <strong>-€ {fmtMoney(appGiftcardUsed)}</strong>
                  </div>
                </div>
              ) : null}

              <div className="line confirm-line-muted">
                <div>Pagamenti e crediti</div>
                <div>€ 0,00</div>
              </div>
              <div className="line confirm-total-line">
                <div>
                  <strong>Saldo dovuto</strong>
                </div>
                <div>
                  <strong>€ {fmtMoney(appPayable)}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

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
            className={`booking-floating-action booking-floating-back${step <= firstStep ? " is-hidden" : ""}`}
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
              {/* syncProgress legacy (booking-wizard.js 3140-3174): senza
                  vantaggi l'item "Vantaggi" è d-none e il contatore scala. */}
              {(() => {
                const visibleOrder = PROGRESS.map((p) => p.key).filter((key) =>
                  (key !== "benefits" || hasBenefitsAvailable) && (key !== "location" || !skipLocationStep));
                const currentStage = (() => {
                  const stage = PROGRESS[step - 1]?.key ?? "location";
                  return stage === "benefits" && !hasBenefitsAvailable ? "confirm" : stage;
                })();
                const activeIdx = Math.max(0, visibleOrder.indexOf(currentStage));
                return (
                  <>
                    <div
                      className="booking-progress"
                      id="bookingProgress"
                      aria-label="Avanzamento prenotazione"
                      style={{ "--booking-progress-count": String(Math.max(1, visibleOrder.length)) } as React.CSSProperties}
                    >
                      {PROGRESS.map((item) => {
                        const itemIdx = visibleOrder.indexOf(item.key);
                        const visible = itemIdx > -1;
                        const cls = [
                          "booking-progress__item",
                          !visible ? "d-none" : "",
                          visible && itemIdx === activeIdx ? "is-active" : "",
                          visible && itemIdx < activeIdx ? "is-done" : "",
                        ].filter(Boolean).join(" ");
                        return (
                          <span key={item.key} className={cls} data-progress={item.key} aria-hidden={visible ? "false" : "true"}>
                            {item.label}
                          </span>
                        );
                      })}
                    </div>
                    <div className="booking-progress__label" id="bookingStepCounter">
                      Step {activeIdx + 1} di {visibleOrder.length}
                    </div>
                  </>
                );
              })()}
              <div className="booking-head__row">
                <div>
                  <h4 id="stepTitle">{STEP_HEAD[step].title}</h4>
                  <div className="booking-head__desc" id="bookingStepDescription">
                    {STEP_HEAD[step].desc}
                  </div>
                </div>
                {/* refreshCustomerUI legacy: loggato -> 'I miei appuntamenti'
                    (apre l'area cliente), sloggato -> 'Accedi' (login centrale). */}
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm btn-pill booking-head__account"
                  id="customerAreaBtn"
                  onClick={() => {
                    window.location.href = bookingUser
                      ? `/${encodeURIComponent(slug)}/booking?my=1`
                      : `/account/login?tenant=${encodeURIComponent(slug)}&next=start`;
                  }}
                >
                  <i className="bi bi-person me-1" />
                  <span id="customerAreaBtnLabel">{bookingUser ? "I miei appuntamenti" : "Accedi"}</span>
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

              {/* Hold TTL: countdown LIVE "Slot riservato per M:SS." (warning <30s,
                  rosso <10s), come il legacy (bookingRenderHoldCountdown). */}
              <div
                id="bookingHoldCountdown"
                className={`alert py-2 px-3 mb-3 small${hold ? "" : " d-none"} ${
                  !hold ? "alert-info" : holdRemainingSec <= 10 ? "alert-danger" : holdRemainingSec <= 30 ? "alert-warning" : "alert-info"
                }`}
                role="status"
                aria-live="polite"
              >
                {hold
                  ? holdNow > 0
                    ? `Slot riservato per ${Math.floor(holdRemainingSec / 60)}:${String(holdRemainingSec % 60).padStart(2, "0")}.`
                    : "Slot riservato."
                  : ""}
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
                  {ctx && !categoriesForLocation.length ? (
                    <div className="text-muted">
                      Nessuna categoria configurata. Vai su <strong>Servizi → Categorie</strong> per crearle.
                    </div>
                  ) : null}
                  {categoriesForLocation.map((cat) => (
                    <div
                      key={cat.id}
                      className={`list-card cat-card${categoryId === cat.id ? " active" : ""}`}
                      data-id={cat.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        // applyCategorySelection (booking-wizard.js 3431): cambiare
                        // categoria svuota il carrello servizi e resetta data/ora.
                        if (cat.id !== categoryId) {
                          setServiceIds([]);
                          setSlot("");
                          setHold(null);
                        }
                        setCategoryId(cat.id);
                        setStep(3);
                      }}
                    >
                      <div className="cat-left">
                        {/* Immagine categoria (service_categories.image_url via R2) con
                            l'SVG di fallback legacy quando assente (booking.php 13097). */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={cat.imageUrl || "/assets/img/categories/body.svg"} alt="" />
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
                    Scegli uno slot per <span id="slotDateLabel" className="text-success">{formatSlotDateLabel(date)}</span>
                  </div>
                  <div
                    className={`slot-grid${!slotsLoading && freeSlots.length > SLOT_GROUP_THRESHOLD ? " has-groups" : ""}`}
                    id="slotGrid"
                  >
                    {slotsLoading ? <div className="text-muted small">Caricamento orari…</div> : null}
                    {/* <=12 slot: griglia piatta; >12: raggruppati per periodo/ora
                        (renderGroupedSlots legacy). */}
                    {!slotsLoading && freeSlots.length <= SLOT_GROUP_THRESHOLD
                      ? freeSlots.map((item) => (
                          <button
                            key={item.time}
                            type="button"
                            className={`slot-btn available${slot === item.time ? " selected" : ""}`}
                            onClick={() => chooseSlot(item)}
                          >
                            {item.time}
                          </button>
                        ))
                      : null}
                    {!slotsLoading && freeSlots.length > SLOT_GROUP_THRESHOLD
                      ? slotGroups.map((period) => (
                          <section className="slot-period" key={period.label}>
                            <div className="slot-period__head">
                              <div className="slot-period__title">{period.label}</div>
                              <div className="slot-period__count">
                                {period.slots.length === 1 ? "1 orario" : `${period.slots.length} orari`}
                              </div>
                            </div>
                            {period.hours.map(([hour, hourSlots]) => {
                              const key = `${period.label}:${hour}`;
                              const expanded = expandedHours.has(key);
                              const initial = getInitialHourSlots(hourSlots);
                              const hasHidden = initial.length < hourSlots.length;
                              let visible = expanded ? hourSlots : initial;
                              if (!expanded && slot && hourSlots.includes(slot) && !visible.includes(slot)) {
                                visible = [...visible, slot].sort((a, b) => slotMinutes(a) - slotMinutes(b));
                              }
                              return (
                                <div className="slot-hour-card" key={hour}>
                                  <div className="slot-hour-card__head">
                                    <div>
                                      <div className="slot-hour-card__title">{hour}:00</div>
                                      <div className="slot-hour-card__meta">
                                        {hourSlots.length === 1 ? "1 disponibilita" : `${hourSlots.length} disponibilita`}
                                      </div>
                                    </div>
                                    {hasHidden ? (
                                      <button type="button" className="slot-hour-toggle" onClick={() => toggleHour(key)}>
                                        {expanded ? "Nascondi" : "Mostra tutti"}
                                      </button>
                                    ) : null}
                                  </div>
                                  <div className="slot-hour-card__times">
                                    {visible.map((t) => {
                                      const item = slotByTime.get(t);
                                      return (
                                        <button
                                          key={t}
                                          type="button"
                                          className={`slot-btn available${slot === t ? " selected" : ""}`}
                                          onClick={() => item && chooseSlot(item)}
                                        >
                                          {t}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </section>
                        ))
                      : null}
                  </div>
                  <div
                    id="slotEmpty"
                    className={`text-muted small mt-2${slotsLoading || freeSlots.length ? " d-none" : ""}`}
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
                            I punti verranno scalati quando l&apos;appuntamento sara eseguito.
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

                {/* La conferma post-book NON è più inline: come il legacy
                    (?confirmed=1) rende la schermata dedicata (early return). */}
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
                        {/* fillClientStepFromUser legacy: da loggato l'email
                            dell'account è readonly. */}
                        <input
                          className="form-control"
                          type="email"
                          placeholder="Email"
                          value={email}
                          readOnly={Boolean(bookingUser)}
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
                {/* Rimosso il box coupon/promozioni STATICO dello step 7: era
                    markup morto (nessun handler) con id DOM DUPLICATI
                    (couponInput/couponBox/couponMsg già presenti — e funzionanti
                    — nello step 6 Vantaggi). Residuo dichiarato: nel legacy il
                    coupon è inseribile anche allo step 7; qui l'inserimento
                    coupon free-text vive nello step 6. */}
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
                style={step <= firstStep ? { visibility: "hidden" } : undefined}
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
                  <strong>
                    {selectedServices.length === 1
                      ? selectedServices[0].name
                      : `${selectedServices.length} servizi selezionati`}
                  </strong>
                  {` • ${selectedServices.reduce((sum, service) => sum + (service.duration || 0), 0)} min`}
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
                  {selectedServices.length ? selectedServices.map((service) => service.name).join(", ") : "—"}
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
          {/* Legacy (booking.php 13414-13418): Home = profilo marketplace del
              tenant, Pannello = area cliente (?hub=1, il gate la instrada). */}
          <a className="booking-bottom-nav__item" href={`/attivita/${slug}`}>
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

// --- Raggruppamento slot (booking-wizard.js 3800-3964): sopra 12 slot il legacy
//     raggruppa in periodi Mattina/Pomeriggio/Sera e card per-ora, con
//     "N disponibilita"/"N orari" e toggle Mostra tutti/Nascondi. ---
const SLOT_GROUP_THRESHOLD = 12;
const SLOT_RECOMMENDED_INTERVAL = 15;
function slotMinutes(time: string): number {
  const [h, m] = String(time || "").split(":");
  const hh = parseInt(h || "0", 10);
  const mm = parseInt(m || "0", 10);
  return (Number.isNaN(hh) ? 0 : hh) * 60 + (Number.isNaN(mm) ? 0 : mm);
}
function slotHour(time: string): number {
  const h = parseInt(String(time || "").split(":")[0] || "0", 10);
  return Number.isNaN(h) ? 0 : h;
}
function slotPeriodLabel(time: string): string {
  const h = slotHour(time);
  if (h < 12) return "Mattina";
  if (h < 18) return "Pomeriggio";
  return "Sera";
}
function isRecommendedSlot(time: string): boolean {
  return slotMinutes(time) % SLOT_RECOMMENDED_INTERVAL === 0;
}
function getInitialHourSlots(hourSlots: string[]): string[] {
  const recommended = hourSlots.filter(isRecommendedSlot);
  if (recommended.length) return recommended;
  return hourSlots.slice(0, Math.min(3, hourSlots.length));
}
type SlotPeriod = { label: string; slots: string[]; hours: Array<[string, string[]]> };
function buildSlotGroups(times: string[]): SlotPeriod[] {
  const sorted = [...times].sort((a, b) => slotMinutes(a) - slotMinutes(b));
  const periods: SlotPeriod[] = [];
  const pmap = new Map<string, SlotPeriod>();
  const hmap = new Map<string, Map<string, string[]>>();
  for (const time of sorted) {
    const pl = slotPeriodLabel(time);
    if (!pmap.has(pl)) {
      const period: SlotPeriod = { label: pl, slots: [], hours: [] };
      pmap.set(pl, period);
      hmap.set(pl, new Map());
      periods.push(period);
    }
    const period = pmap.get(pl)!;
    const hours = hmap.get(pl)!;
    const hour = String(time).slice(0, 2);
    period.slots.push(time);
    if (!hours.has(hour)) hours.set(hour, []);
    hours.get(hour)!.push(time);
  }
  for (const period of periods) period.hours = [...(hmap.get(period.label) ?? new Map())];
  return periods;
}

function fmtMoney(value: number): string {
  // number_format PHP: separatore migliaia '.' SEMPRE (anche 1000-9999, dove
  // toLocaleString/ICU non lo inserisce) e decimale ',' — es. 1234.5 -> "1.234,50".
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  const sign = rounded < 0 ? "-" : "";
  const [intPart, decPart] = Math.abs(rounded).toFixed(2).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped},${decPart}`;
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

// Etichetta "Scegli uno slot per <data>": giorno 2 cifre + mese lungo + anno
// (es. "07 luglio 2026"), come il legacy.
function formatSlotDateLabel(ymd: string): string {
  const date = parseYmd(ymd);
  if (!date) return ymd;
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS_IT[date.getMonth()]} ${date.getFullYear()}`;
}

export default BookingFaithful;
