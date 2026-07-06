import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookingFaithful } from "@/components/public/booking-faithful";
import { BookingSettingsContent } from "@/components/modules/booking-content";
import { ManageShell } from "@/components/manage-shell";
import { PerTenantHub, type HubSection } from "@/components/public/per-tenant-hub";
import { currentManageSession } from "@/lib/manage-auth";
import { currentPublicCustomerSession } from "@/lib/public-customer-account";
import { publicBookingContext } from "@/lib/public-booking-db";

// Target legacy dell'area cliente per-tenant (booking.php 9314-9336): l'hub
// per-sede (booking.php?public=1&<sezione>=1) è reso IN LOCO da PerTenantHub
// (dashboard residui del cliente presso QUESTA attività). profile/settings
// vanno all'account CENTRALE (/account/profile). L'account cliente vero e
// proprio (attività/preferiti/profilo) resta /account/*.
const HUB_SECTIONS = new Set<HubSection>([
  "hub", "my", "credit", "giftcards", "packs", "prepaids", "giftboxes", "preorders", "quotes", "fidelity", "gifts",
]);

export const metadata: Metadata = {
  title: "Prenotazione online - BeautySuite",
};

export default async function TenantBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantSlug } = await params;
  const query = (await searchParams) ?? {};
  const qs = (key: string): string => {
    const raw = query[key];
    return String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "");
  };

  // Come il legacy booking.php: SENZA public=1 la pagina è l'ADMIN delle
  // impostazioni booking (requirePerm booking.manage). I link pubblici del
  // Next (area cliente, marketplace, hub) usano sempre parametri espliciti
  // (public=1 / start / hub / book_*), quindi il wizard resta raggiungibile;
  // il /slug/booking "nudo" della sidebar manage rende le impostazioni.
  const isPublicRequest = qs("public") === "1"
    || qs("start") !== "" || qs("hub") !== "" || qs("confirmed") !== "" || qs("mode") !== ""
    || qs("service_ids") !== "" || qs("location_id") !== "" || qs("service_id") !== ""
    || qs("book_package") !== "" || qs("book_prepaid") !== "" || qs("book_giftbox") !== "" || qs("book_omaggio") !== ""
    // Target dell'area cliente per-tenant legacy (booking.php 9314-9336).
    || qs("my") !== "" || qs("quotes") !== "" || qs("packs") !== "" || qs("prepaids") !== ""
    || qs("credit") !== "" || qs("giftcards") !== "" || qs("giftboxes") !== "" || qs("fidelity") !== ""
    || qs("gifts") !== "" || qs("preorders") !== "" || qs("profile") !== "" || qs("settings") !== ""
    || qs("products") !== "" || qs("showcase") !== "" || qs("auth") !== "";
  if (!isPublicRequest) {
    const session = await currentManageSession(tenantSlug);
    if (session) {
      return (
        <ManageShell slug={tenantSlug} userName={session.user.name} currentPage="booking">
          <BookingSettingsContent slug={tenantSlug} initialQuery={{ msg: qs("msg") || undefined }} />
        </ManageShell>
      );
    }
    // Nessuna sessione gestionale: il legacy manderebbe al login del manage.
    // I clienti arrivano sempre con parametri pubblici, quindi qui è un
    // operatore sloggato.
    redirect(`/manage/login?slug=${encodeURIComponent(tenantSlug)}`);
  }

  // --- GATE cliente legacy (booking.php 9307-9340) -----------------------
  // Il wizard/area cliente richiede il LOGIN cliente: senza sessione, i
  // target espliciti redirigono al login centrale (?tenant=&next=) e il
  // public=1 "nudo" al profilo marketplace /attivita/<slug>. showcase e
  // products (senza start) rimandano SEMPRE al profilo marketplace.
  const hasRedeemDeepLink = qs("book_package") !== "" || qs("book_prepaid") !== "" || qs("book_giftbox") !== "" || qs("book_omaggio") !== "";
  const requestedTarget = qs("start") !== "" || hasRedeemDeepLink || qs("service_ids") !== ""
    ? "start"
    : qs("my") !== "" ? "my"
    : qs("quotes") !== "" ? "quotes"
    : qs("packs") !== "" ? "packs"
    : qs("prepaids") !== "" ? "prepaids"
    : qs("credit") !== "" ? "credit"
    : qs("giftcards") !== "" ? "giftcards"
    : qs("giftboxes") !== "" ? "giftboxes"
    : qs("fidelity") !== "" ? "fidelity"
    : qs("gifts") !== "" ? "gifts"
    : qs("products") !== "" || qs("showcase") !== "" ? "showcase"
    : qs("preorders") !== "" ? "preorders"
    : qs("profile") !== "" ? "profile"
    : qs("settings") !== "" ? "settings"
    : qs("hub") !== "" ? "hub"
    : "";
  if (requestedTarget === "showcase") {
    redirect(`/attivita/${encodeURIComponent(tenantSlug)}`);
  }
  // Schermata di conferma post-book: raggiungibile senza gate (il codice fa da chiave).
  const isConfirmedScreen = qs("confirmed") === "1";
  if (!isConfirmedScreen) {
    const customer = await currentPublicCustomerSession();
    if (!customer) {
      if (requestedTarget !== "" || qs("auth") !== "") {
        const mode = qs("tab") === "register" ? "register" : "login";
        const loginParams = new URLSearchParams({ tenant: tenantSlug, next: requestedTarget || "hub" });
        const locId = qs("location_id");
        if (locId !== "") loginParams.set("location_id", locId);
        redirect(`/account/${mode}?${loginParams.toString()}`);
      }
      redirect(`/attivita/${encodeURIComponent(tenantSlug)}`);
    }
    // Loggato: start (e i deep-link redeem) al wizard; i target dell'hub
    // per-sede resi in loco da PerTenantHub; profile/settings all'account
    // centrale; il public=1 "nudo" (nessun target) è showcase → profilo
    // marketplace (booking.php 9188+9307).
    if (requestedTarget === "") {
      redirect(`/attivita/${encodeURIComponent(tenantSlug)}`);
    }
    if (requestedTarget === "profile" || requestedTarget === "settings") {
      redirect(`/account/profile`);
    }
    if (HUB_SECTIONS.has(requestedTarget as HubSection)) {
      // Nome attività + sedi prenotabili (booking.php: $businessName +
      // $bookingHasBookableLocations per la landing "Ciao 👋").
      const ctx = await publicBookingContext(tenantSlug).catch(() => null);
      const tenantName = ctx?.business.name?.trim() || tenantSlug;
      const hasBookableLocations = (ctx?.locations ?? []).some((location) => location.bookingEnabled);
      return (
        <PerTenantHub
          slug={tenantSlug}
          section={requestedTarget as HubSection}
          tenantName={tenantName}
          hasBookableLocations={hasBookableLocations}
        />
      );
    }
    if (requestedTarget !== "start") {
      redirect(`/attivita/${encodeURIComponent(tenantSlug)}`);
    }
  }

  const qp = (key: string): number => {
    const raw = query[key];
    const parsed = Number.parseInt(String(Array.isArray(raw) ? raw[0] : raw ?? "0"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  // DEEP-LINK "prenota da residuo" (legacy book_package / book_prepaid /
  // book_giftbox / book_omaggio + service_id, booking.php 2226-2331): prefill
  // the wizard with the covered service + the redeem to apply at confirm.
  // giftbox needs the item id (`giftbox_item_id`); omaggio the reward index
  // (`reward_item_index`, 0-based, so it is read without the >0 clamp).
  const rewardIdxRaw = Array.isArray(query.reward_item_index) ? query.reward_item_index[0] : query.reward_item_index;
  const rewardIdx = Number.parseInt(String(rewardIdxRaw ?? "0"), 10);
  const serviceId = qp("service_id");
  const prefill =
    serviceId > 0 && qp("book_package") > 0
      ? ({ kind: "package", refId: qp("book_package"), serviceId } as const)
      : serviceId > 0 && qp("book_prepaid") > 0
        ? ({ kind: "prepaid", refId: qp("book_prepaid"), serviceId } as const)
        : serviceId > 0 && qp("book_giftbox") > 0
          ? ({ kind: "giftbox", refId: qp("book_giftbox"), itemId: qp("giftbox_item_id"), serviceId } as const)
          : serviceId > 0 && qp("book_omaggio") > 0
            ? ({ kind: "gift", refId: qp("book_omaggio"), itemId: Number.isFinite(rewardIdx) && rewardIdx >= 0 ? rewardIdx : 0, serviceId } as const)
            : null;
  return <BookingFaithful slug={tenantSlug} redeemPrefill={prefill} />;
}
