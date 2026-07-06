import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookingFaithful } from "@/components/public/booking-faithful";
import { BookingSettingsContent } from "@/components/modules/booking-content";
import { ManageShell } from "@/components/manage-shell";
import { currentManageSession } from "@/lib/manage-auth";

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
    || qs("book_package") !== "" || qs("book_prepaid") !== "" || qs("book_giftbox") !== "" || qs("book_omaggio") !== "";
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
