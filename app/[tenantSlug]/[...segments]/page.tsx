import { redirect } from "next/navigation";
import { ManagementApp } from "@/components/management-app";
import { ManageOnboardingApp } from "@/components/manage-onboarding-app";
import { ManageShell } from "@/components/manage-shell";
import { ClientsContent } from "@/components/modules/clients-content";
import { ClientFormContent } from "@/components/modules/client_form-content";
import { ClientDetailContent } from "@/components/modules/client_detail-content";
import { ClientHistoryContent } from "@/components/modules/client_history-content";
import { CommissionsContent } from "@/components/modules/commissions-content";
import { CommissionsSettingsContent } from "@/components/modules/commissions_settings-content";
import { CostsContent } from "@/components/modules/costs-content";
import { CostCategoriesContent } from "@/components/modules/cost_categories-content";
import { CostFormContent } from "@/components/modules/cost_form-content";
import { CouponsContent } from "@/components/modules/coupons-content";
import { CouponFormContent } from "@/components/modules/coupon_form-content";
import { LocationsContent } from "@/components/modules/locations-content";
import { LocationFormContent } from "@/components/modules/location_form-content";
import { PromotionsContent } from "@/components/modules/promotions-content";
import { PromotionFormContent } from "@/components/modules/promotion_form-content";
import { QuotesContent } from "@/components/modules/quotes-content";
import { QuoteFormContent } from "@/components/modules/quote_form-content";
import { QuoteDetailContent } from "@/components/modules/quote_detail-content";
import { RechargesContent } from "@/components/modules/recharges-content";
import { SuppliersContent } from "@/components/modules/suppliers-content";
import { SupplierFormContent } from "@/components/modules/supplier_form-content";
import { CabinsContent } from "@/components/modules/cabins-content";
import { GiftcardContent } from "@/components/modules/giftcard-content";
import { GiftCardDetailContent } from "@/components/modules/giftcard_detail-content";
import { GiftsContent } from "@/components/modules/gifts-content";
import { GiftInstanceContent } from "@/components/modules/gift_instance-content";
import { GiftFormContent } from "@/components/modules/gift_form-content";
import { GiftBoxFormContent } from "@/components/modules/giftbox_form-content";
import { GiftBoxInstanceDetailContent } from "@/components/modules/giftbox_instance_detail-content";
import { HoursContent } from "@/components/modules/hours-content";
import { ProductsContent } from "@/components/modules/products-content";
import { ProductFormContent } from "@/components/modules/product_form-content";
import { StaffContent } from "@/components/modules/staff-content";
import { StaffFormContent } from "@/components/modules/staff_form-content";
import { ResourcesContent } from "@/components/modules/resources-content";
import { GiftboxContent } from "@/components/modules/giftbox-content";
import { WalletContent } from "@/components/modules/wallet-content";
import { InstallmentsManageContent } from "@/components/modules/installments-manage-content";
import { AccessibilityContent } from "@/components/modules/accessibility-content";
import { AutomationContent } from "@/components/modules/automation-content";
import { BookingSettingsContent } from "@/components/modules/booking-content";
import { ConsentModulesContent } from "@/components/modules/consent_modules-content";
import { ConsentModuleFormContent } from "@/components/modules/consent_module_form-content";
import { FidelityContent } from "@/components/modules/fidelity-content";
import { PosHistoryContent } from "@/components/modules/pos_history-content";
import { PosSaleDetailContent } from "@/components/modules/pos_sale_detail-content";
import { ReportsContent } from "@/components/modules/reports-content";
import { StockMovesContent } from "@/components/modules/stock_moves-content";
import { StockMoveFormContent } from "@/components/modules/stock_move_form-content";
import { BusinessProfileContent } from "@/components/modules/business_profile-content";
import { FidelityPointsContent } from "@/components/modules/fidelity_points-content";
import { FidelityMembershipContent } from "@/components/modules/fidelity_membership-content";
import { PosSettingsContent } from "@/components/modules/pos_settings-content";
import { PosPrepaidsContent } from "@/components/modules/pos_prepaids-content";
import { PosPreordersContent } from "@/components/modules/pos_preorders-content";
import { StaffAvailabilityContent } from "@/components/modules/staff_availability-content";
import { AppointmentsPlanContent } from "@/components/modules/appointments_plan-content";
import { NotificationsContent } from "@/components/modules/notifications-content";
import { NotificationsBirthdaysContent } from "@/components/modules/notifications_birthdays-content";
import { NotificationsInstallmentsContent } from "@/components/modules/notifications_installments-content";
import { NotificationsQuotesContent } from "@/components/modules/notifications_quotes-content";
import { RolesContent } from "@/components/modules/roles-content";
import { GiftcardSettingsContent } from "@/components/modules/giftcard_settings-content";
import { GiftboxSettingsContent } from "@/components/modules/giftbox_settings-content";
import { QuoteSettingsContent } from "@/components/modules/quote_settings-content";
import { ServicesContent } from "@/components/modules/services-content";
import { ServiceFormContent } from "@/components/modules/service_form-content";
import { ServiceCategoriesContent } from "@/components/modules/service_categories-content";
import { ServiceRecommendationsContent } from "@/components/modules/service_recommendations-content";
import { PackagesContent } from "@/components/modules/packages-content";
import { PackagesCatalogContent } from "@/components/modules/packages_catalog-content";
import { PackagesCatalogFormContent } from "@/components/modules/packages_catalog_form-content";
import { ClientPackageDetailContent } from "@/components/modules/client_package_detail-content";
import { PackageSettingsContent } from "@/components/modules/package_settings-content";
import { MarketplaceSettingsContent } from "@/components/modules/marketplace-content";
import { FidelityWalletContent } from "@/components/modules/fidelity_wallet-content";
import { CreditMovementsContent } from "@/components/modules/credit_movements-content";
import { ClientSheetsContent } from "@/components/modules/client_sheets-content";
import { ClientConsentsContent } from "@/components/modules/client_consents-content";
import { ClientSheetTemplatesContent } from "@/components/modules/client_sheet_templates-content";
import { FidelityLevelsContent } from "@/components/modules/fidelity_levels-content";
import { FidelityMembershipSettingsContent } from "@/components/modules/fidelity_membership_settings-content";
import { PosContent } from "@/components/modules/pos-content";
import { CalendarContent } from "@/components/modules/calendar-content";
import { AppointmentsContent } from "@/components/modules/appointments-content";
import { BookingFaithful } from "@/components/public/booking-faithful";
import { GiftBoxVoucherFaithful } from "@/components/public/giftbox-voucher-faithful";
import { GiftVoucherFaithful } from "@/components/public/gift-voucher-faithful";
import { GiftCardVoucherFaithful } from "@/components/public/giftcard-voucher-faithful";
import { QuotePublicFaithful } from "@/components/public/quote-public-faithful";
import { GdprPublicFaithful } from "@/components/public/gdpr-public-faithful";
import { ConsentPublicFaithful } from "@/components/public/consent-public-faithful";
import { currentManageSession } from "@/lib/manage-auth";
import { shouldPromptOnboarding } from "@/lib/manage-onboarding";

// Clean per-page routing for the manage app: /<slug>/<page>[/<tab>].
// The legacy /<slug>/index.php?page=X[&tab=Y] URLs are 307-redirected here by
// middleware.ts, so old links/bookmarks keep working. Public pages (voucher
// viewers) are handled before the session check.
// The faithful modules accept an optional `slug` prop (passed from this server page so
// their SSR-rendered links use the real tenant slug — components that read the slug from
// window.location alone would render "//page" on the server, causing a hydration mismatch +
// a broken link, e.g. the calendar toolbar "Lista" button). Components that don't need it
// simply ignore the prop.
const FAITHFUL_MODULES: Record<string, React.ComponentType<{ slug?: string }>> = {
  clients: ClientsContent,
  suppliers: SuppliersContent,
  coupons: CouponsContent,
  costs: CostsContent,
  commissions: CommissionsContent,
  commissions_settings: CommissionsSettingsContent,
  quotes: QuotesContent,
  promotions: PromotionsContent,
  locations: LocationsContent,
  recharges: RechargesContent,
  products: ProductsContent,
  cabins: CabinsContent,
  staff: StaffContent,
  hours: HoursContent,
  gifts: GiftsContent,
  gift_instance: GiftInstanceContent,
  giftcard: GiftcardContent,
  resources: ResourcesContent,
  giftbox: GiftboxContent,
  wallet: WalletContent,
  installments_manage: InstallmentsManageContent,
  consent_modules: ConsentModulesContent,
  accessibility: AccessibilityContent,
  automation: AutomationContent,
  reports: ReportsContent,
  stock_moves: StockMovesContent,
  pos_history: PosHistoryContent,
  pos_sale_detail: PosSaleDetailContent,
  fidelity: FidelityContent,
  booking: BookingSettingsContent,
  business_profile: BusinessProfileContent,
  fidelity_points: FidelityPointsContent,
  fidelity_membership: FidelityMembershipContent,
  pos_settings: PosSettingsContent,
  pos_prepaids: PosPrepaidsContent,
  pos_preorders: PosPreordersContent,
  staff_availability: StaffAvailabilityContent,
  appointments_plan: AppointmentsPlanContent,
  notifications: NotificationsContent,
  notifications_birthdays: NotificationsBirthdaysContent,
  notifications_installments: NotificationsInstallmentsContent,
  notifications_quotes: NotificationsQuotesContent,
  roles: RolesContent,
  giftcard_settings: GiftcardSettingsContent,
  giftbox_settings: GiftboxSettingsContent,
  quote_settings: QuoteSettingsContent,
  services: ServicesContent,
  service_categories: ServiceCategoriesContent,
  cost_categories: CostCategoriesContent,
  service_recommendations: ServiceRecommendationsContent,
  packages: PackagesContent,
  packages_catalog: PackagesCatalogContent,
  package_settings: PackageSettingsContent,
  marketplace: MarketplaceSettingsContent,
  fidelity_wallet: FidelityWalletContent,
  credit_movements: CreditMovementsContent,
  client_sheets: ClientSheetsContent,
  client_consents: ClientConsentsContent,
  client_sheet_templates: ClientSheetTemplatesContent,
  fidelity_levels: FidelityLevelsContent,
  fidelity_membership_settings: FidelityMembershipSettingsContent,
  pos: PosContent,
  calendar: CalendarContent,
  appointments: AppointmentsContent,
};

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string; segments?: string[] }>;
  searchParams: Promise<{ public?: string; location_id?: string; service?: string; tab?: string; action?: string; token?: string; embed?: string; format?: string }>;
}) {
  const { tenantSlug, segments } = await params;
  const query = await searchParams;
  // Clean URLs are /<slug>/<page> with tab/action as query params (matching the
  // legacy ?tab=/?action= semantics); segments[0] is the page.
  const page = segments?.[0] ?? "";
  const tab = query.tab;

  if (page === "booking" && query.public === "1") {
    return <BookingFaithful slug={tenantSlug} />;
  }

  // Public GiftBox/GiftCard voucher viewers (gift email links):
  //   /<slug>/giftbox_voucher?public=1&embed=1&token=<64hex>
  //   /<slug>/giftcard_voucher?public=1&embed=1&token=<64hex>
  if (page === "giftbox_voucher" && query.public === "1") {
    return <GiftBoxVoucherFaithful slug={tenantSlug} token={query.token ?? ""} embed={query.embed === "1"} />;
  }
  if (page === "giftcard_voucher" && query.public === "1") {
    return <GiftCardVoucherFaithful slug={tenantSlug} token={query.token ?? ""} embed={query.embed === "1"} />;
  }
  // Public GIFT (omaggio) voucher viewer (gift_voucher.php public mode; the
  // voucher email "Vedi Voucher" links here):
  //   /<slug>/gift_voucher?public=1&embed=1&token=<64hex>
  if (page === "gift_voucher" && query.public === "1") {
    return <GiftVoucherFaithful slug={tenantSlug} token={query.token ?? ""} embed={query.embed === "1"} />;
  }

  // Public GDPR signature page (gdpr_public.php: token 64 hex, no login):
  //   /<slug>/gdpr_public?token=<64hex> — le email di richiesta firma linkano qui.
  if (page === "gdpr_public") {
    return <GdprPublicFaithful slug={tenantSlug} token={query.token ?? ""} />;
  }

  // Public consent-module signature page (consent_public.php: token 64 hex):
  //   /<slug>/consent_public?token=<64hex> — le email dei moduli linkano qui.
  if (page === "consent_public") {
    return <ConsentPublicFaithful slug={tenantSlug} token={query.token ?? ""} />;
  }

  // Public quote viewer (quote_public.php: accesso via token, no login):
  //   /<slug>/quote_public?token=<32/64hex> — the quote emails link here.
  //   ?format=pdf (l'URL PDF delle email) -> redirect alla route che genera
  //   il PDF (una page React non può streammare il binario).
  if (page === "quote_public") {
    if (query.format === "pdf") {
      redirect(`/api/public/quote/pdf?slug=${encodeURIComponent(tenantSlug)}&token=${encodeURIComponent(query.token ?? "")}`);
    }
    return <QuotePublicFaithful slug={tenantSlug} token={query.token ?? ""} />;
  }

  const session = await currentManageSession(tenantSlug);
  if (!session) redirect(`/manage/login?slug=${encodeURIComponent(tenantSlug)}`);

  if (page === "onboarding") {
    if (session.user.role.toLowerCase() !== "admin") redirect(`/${tenantSlug}/dashboard`);
    return <ManageOnboardingApp tenantSlug={tenantSlug} />;
  }

  if (await shouldPromptOnboarding(tenantSlug, session.user.role.toLowerCase() === "admin")) {
    redirect(`/${encodeURIComponent(tenantSlug)}/onboarding`);
  }

  // Faithful client NEW / EDIT form. The clients list links to
  // index.php?page=clients&action=new|edit; route those to the faithful form
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "clients" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientFormContent />
      </ManageShell>
    );
  }

  // Faithful service NEW / EDIT form. The services list links to
  // index.php?page=services&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "services" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ServiceFormContent />
      </ManageShell>
    );
  }

  // Faithful product NEW / EDIT form. The products list links to
  // index.php?page=products&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "products" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ProductFormContent />
      </ManageShell>
    );
  }

  // Faithful location NEW / EDIT form. The locations list links to
  // index.php?page=locations&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "locations" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <LocationFormContent />
      </ManageShell>
    );
  }

  // Faithful operator (staff) NEW / EDIT form. The staff list links to
  // index.php?page=staff&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "staff" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <StaffFormContent />
      </ManageShell>
    );
  }

  // Faithful cost NEW / EDIT form. The Scadenziario list links to
  // index.php?page=costs&tab=scadenziario&action=new|edit; route those to the
  // faithful editor (instead of the Tailwind ManagementApp fallback). The
  // categories tab (tab=categories) keeps its own inline modal flow.
  if (page === "costs" && tab !== "categories" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CostFormContent />
      </ManageShell>
    );
  }

  // Faithful quote NEW form (quotes.php action=new — "Nuovo preventivo"). The
  // quotes list links to index.php?page=quotes&action=new; route it to the
  // faithful CORE editor (client + line items + discount + totals + save). The
  // action=view/edit detail stays on the existing fallback for now (TODO in the
  // form component).
  if (page === "quotes" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuoteFormContent />
      </ManageShell>
    );
  }

  // Faithful quote DETAIL (quotes.php action=view): header + client + items +
  // totals + linked sale + Invia email, instead of the Tailwind fallback.
  if (page === "quotes" && query.action === "view") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuoteDetailContent />
      </ManageShell>
    );
  }

  // Faithful stock-movement NEW operation form (stock_moves.php action=new —
  // "Nuovo carico / scarico"). The stock_moves list links to
  // index.php?page=stock_moves&action=new; route it to the faithful Carico/
  // Scarico transaction form (instead of the Tailwind ManagementApp fallback).
  // The action=view detail stays on the existing fallback for now.
  if (page === "stock_moves" && query.action === "new") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <StockMoveFormContent />
      </ManageShell>
    );
  }

  // Faithful consent-module NEW / EDIT editor. The consent_modules list links
  // to index.php?page=consent_modules&action=new|edit; route those to the
  // faithful editor (instead of the Tailwind ManagementApp fallback).
  if (page === "consent_modules" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ConsentModuleFormContent />
      </ManageShell>
    );
  }

  // Faithful coupon NEW / EDIT form. The coupons list links to
  // index.php?page=coupons&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "coupons" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CouponFormContent />
      </ManageShell>
    );
  }

  // Faithful promotion NEW / EDIT form. The promotions list links to
  // index.php?page=promotions&action=new|edit; route those to the faithful
  // editor (instead of the Tailwind ManagementApp fallback).
  if (page === "promotions" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PromotionFormContent />
      </ManageShell>
    );
  }

  // Faithful supplier (fornitore) NEW / EDIT form. The suppliers list links to
  // index.php?page=suppliers&action=new|edit; route those to the faithful editor
  // (instead of the Tailwind ManagementApp fallback).
  if (page === "suppliers" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <SupplierFormContent />
      </ManageShell>
    );
  }

  // Faithful gift CAMPAIGN editor (gifts.php action=new|edit). The gifts
  // campaigns list links to index.php?page=gifts&action=new|edit; route those to
  // the faithful campaign editor (instead of the Tailwind ManagementApp fallback).
  if (page === "gifts" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftFormContent />
      </ManageShell>
    );
  }

  // Faithful package CATALOG editor (packages.php tab=catalog action=catalog_new|
  // catalog_edit): the template form (header + Sedi + contents rows + pricing),
  // instead of the Tailwind fallback.
  if (page === "packages" && tab === "catalog" && (query.action === "catalog_new" || query.action === "catalog_edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PackagesCatalogFormContent />
      </ManageShell>
    );
  }

  // Faithful client-package DETAIL (packages.php tab=clients action=view/
  // client_view): the client package header + contents + usage history + expiry
  // edit, instead of the Tailwind fallback.
  if (page === "packages" && (query.action === "view" || query.action === "client_view")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientPackageDetailContent />
      </ManageShell>
    );
  }

  // Faithful giftcard DETAIL (giftcard.php action=edit/view): header + balance +
  // transactions + redeem/update-recipient, instead of the Tailwind fallback.
  if (page === "giftcard" && (query.action === "edit" || query.action === "view")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftCardDetailContent />
      </ManageShell>
    );
  }

  // Faithful giftbox INSTANCE detail (giftbox.php tab=instances action=view/
  // edit_instance): header + contents + redeem/cancel, instead of the Tailwind
  // fallback. (Guarded before the tab=boxes template editor branch below, which
  // handles new/edit.)
  if (page === "giftbox" && (query.action === "view" || query.action === "edit_instance")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftBoxInstanceDetailContent />
      </ManageShell>
    );
  }

  // Faithful giftbox TEMPLATE editor (giftbox.php tab=boxes action=new|edit). The
  // giftbox templates grid links to index.php?page=giftbox&action=new|edit; route
  // those to the faithful template editor (instead of the Tailwind fallback).
  if (page === "giftbox" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftBoxFormContent />
      </ManageShell>
    );
  }

  // Faithful client DETAIL ("Apri"). The clients list links to
  // index.php?page=clients&action=view&id=<id>; route it to the faithful detail
  // page (header card + fidelity/credit + tags + block status + history summary +
  // delete confirm), instead of the Tailwind ManagementApp fallback.
  if (page === "clients" && query.action === "view") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientDetailContent />
      </ManageShell>
    );
  }

  // Faithful client STORICO ("Vedi tutto" / action=history): the deep per-status
  // appointment lists + active packages/giftboxes/giftcards + quotes/sales,
  // instead of the Tailwind ManagementApp fallback.
  if (page === "clients" && query.action === "history") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientHistoryContent />
      </ManageShell>
    );
  }

  const faithfulPageKey = page ? faithfulKey(page, tab) : "";
  const FaithfulContent = faithfulPageKey ? FAITHFUL_MODULES[faithfulPageKey] : undefined;
  if (FaithfulContent && !query.action) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FaithfulContent slug={tenantSlug} />
      </ManageShell>
    );
  }

  if (page) {
    return <ManagementApp initialSection={legacyPageToSection(page, tab, query.action)} currentUser={session.user} tenantSlug={tenantSlug} />;
  }

  redirect(`/${tenantSlug}/dashboard`);
}

// Resolve the FAITHFUL_MODULES key for a page/tab combination.
function faithfulKey(page: string, tab?: string): string {
  if (page === "services" && tab === "categories") return "service_categories";
  if (page === "services" && tab === "recommended") return "service_recommendations";
  if (page === "services") return "services";
  if (page === "packages" && tab === "settings") return "package_settings";
  if (page === "packages" && tab === "catalog") return "packages_catalog";
  if (page === "packages") return "packages";
  if (page === "costs" && tab === "categories") return "cost_categories";
  if (page === "commissions" && tab === "settings") return "commissions_settings";
  return page;
}

function legacyPageToSection(page: string, tab?: string, action?: string): string {
  if (page === "services" && tab === "categories") return "service_categories";
  if (page === "services" && tab === "recommended") return "service_recommendations";
  if (page === "products" && action === "categories") return "product_categories";
  if (page === "costs" && tab === "categories") return "cost_categories";
  if (page === "packages" && tab === "settings") return "package_settings";

  const map: Record<string, string> = {
    pos_history: "pos_history",
    pos_prepaids: "pos_prepaids",
    pos_preorders: "pos_preorders",
    pos_settings: "pos_settings",
    rate_management: "installments_manage",
    business_profile: "business_profile",
    consent_modules: "consent_modules",
    staff_availability: "staff_availability",
    appointments_plan: "appointments_plan",
    quote_settings: "quote_settings",
    client_sheets: "client_sheets",
    client_consents: "client_consents",
    client_sheet_templates: "client_sheet_templates",
    stock_moves: "stock_moves",
    credit_movements: "wallet",
    giftbox_settings: "giftbox_settings",
    giftcard_settings: "giftcard_settings",
    fidelity_points: "fidelity_points",
    fidelity_wallet: "wallet",
    fidelity_membership: "fidelity_membership",
    fidelity_membership_settings: "fidelity_membership",
    fidelity_levels: "fidelity_levels",
  };

  return map[page] ?? page;
}
