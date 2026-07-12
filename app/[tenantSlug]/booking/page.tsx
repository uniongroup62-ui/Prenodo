import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookingFaithful } from "@/components/public/booking-faithful";
import { BookingSettingsContent } from "@/components/modules/booking-content";
import { ManageShell } from "@/components/manage-shell";
import { PerTenantHub, type HubSection } from "@/components/public/per-tenant-hub";
import { currentManageSession } from "@/lib/manage-auth";
import { currentPublicCustomerSession } from "@/lib/public-customer-account";
import { publicBookingContext, bookableLocationCount } from "@/lib/public-booking-db";
import { dbQuery, type RowDataPacket } from "@/lib/tenant-db";

// booking_public_allowed (saas_tenants) — port di TenantFeatureGate::
// allowsPublicBooking: se il tenant ha disattivato la prenotazione online, la
// landing dell'hub non mostra "Prenota ora" e il wizard/redeem è bloccato.
async function tenantBookingPublicAllowed(slug: string): Promise<boolean> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT booking_public_allowed FROM saas_tenants WHERE slug = ? LIMIT 1",
    [slug],
  ).catch(() => [] as RowDataPacket[]);
  return rows.length ? Number(rows[0].booking_public_allowed ?? 1) === 1 : true;
}

// Target legacy dell'area cliente per-tenant (booking.php 9314-9336): l'hub
// per-sede (booking.php?public=1&<sezione>=1) è reso IN LOCO da PerTenantHub
// (dashboard residui del cliente presso QUESTA attività). profile/settings
// vanno all'account CENTRALE (/account/profile). L'account cliente vero e
// proprio (attività/preferiti/profilo) resta /account/*.
// NB: "giftboxes" NON è nell'hub del port (sezione non ancora portata: la
// lista GiftBox del cliente dipende da GiftBox::getInstanceFull + redemption +
// riserve, un sottosistema a sé). ?giftboxes=1 resta una richiesta pubblica
// (isPublicRequest) ma, non essendo in HUB_SECTIONS, ricade nel fallback
// showcase (/attivita/<slug>). Il riscatto GiftBox resta possibile dal wizard
// (deep-link book_giftbox).
const HUB_SECTIONS = new Set<HubSection>([
  "hub", "my", "credit", "giftcards", "packs", "prepaids", "preorders", "quotes", "fidelity", "gifts",
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
      // Gate verifica email (index.php 580-590): vale anche per l'admin
      // booking (le richieste PUBBLICHE del wizard restano esenti, come
      // $isPublicBooking nel legacy).
      if (session.user.needsEmailVerification) {
        redirect(`/${encodeURIComponent(tenantSlug)}/accessibility?err=${encodeURIComponent("Verifica email necessaria prima di continuare")}`);
      }
      return (
        <ManageShell slug={tenantSlug} userName={session.user.name} needsLocationSelectionHint={session.user.needsLocationSelection} currentPage="booking">
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
    const publicBookingAllowed = await tenantBookingPublicAllowed(tenantSlug);
    if (HUB_SECTIONS.has(requestedTarget as HubSection)) {
      // Nome attività + sedi prenotabili (booking.php: $businessName +
      // $bookingHasBookableLocations per la landing "Ciao 👋"). Se la
      // prenotazione online è disattivata → nessuna sede prenotabile +
      // messaggio dedicato (booking.php 2981-2985).
      const ctx = await publicBookingContext(tenantSlug).catch(() => null);
      const tenantName = ctx?.business.name?.trim() || tenantSlug;
      const hasBookableLocations = publicBookingAllowed && (ctx?.locations ?? []).some((location) => location.bookingEnabled);
      const noLocationsMessage = publicBookingAllowed
        ? "Nessuna sede disponibile per la prenotazione online."
        : "Prenotazione online non disponibile.";
      return (
        <PerTenantHub
          slug={tenantSlug.toLowerCase()}
          section={requestedTarget as HubSection}
          tenantName={tenantName}
          hasBookableLocations={hasBookableLocations}
          noLocationsMessage={noLocationsMessage}
          initialUser={{
            id: customer.id,
            email: customer.email,
            fullName: customer.fullName,
            firstName: customer.firstName,
            lastName: customer.lastName,
            phone: customer.phone,
          }}
        />
      );
    }
    // start / deep-link redeem: bloccati se la prenotazione online è disattivata
    // (TenantFeatureGate::allowsPublicBooking) → showcase.
    if (!publicBookingAllowed) {
      redirect(`/attivita/${encodeURIComponent(tenantSlug)}`);
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
  // Sede unica -> il wizard parte già da "Categoria" (skip Sede) senza flash.
  const initialSkipLocation = (await bookableLocationCount(tenantSlug).catch(() => 0)) === 1;
  return <BookingFaithful slug={tenantSlug} redeemPrefill={prefill} initialLocationId={qp("location_id")} initialSkipLocation={initialSkipLocation} />;
}
