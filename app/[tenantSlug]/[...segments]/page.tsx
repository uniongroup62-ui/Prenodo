import { redirect } from "next/navigation";
import { ManageOnboardingApp } from "@/components/manage-onboarding-app";
import { ManageShell } from "@/components/manage-shell";
import { ClientsContent } from "@/components/modules/clients-content";
import { ClientFormContent } from "@/components/modules/client_form-content";
import { ClientDeleteConfirmContent } from "@/components/modules/client_delete_confirm-content";
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
import { QuotePrintContent } from "@/components/modules/quote_print-content";
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
import { ProductCategoriesContent } from "@/components/modules/product_categories-content";
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
import { PosSuccessContent } from "@/components/modules/pos_success-content";
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
import { ClientPackageFormContent } from "@/components/modules/client_package_form-content";
import { ClientPackageCancelRedirect } from "@/components/modules/client_package_cancel_redirect";
import { PackageSettingsContent } from "@/components/modules/package_settings-content";
import { MarketplaceSettingsContent } from "@/components/modules/marketplace-content";
import { FidelityWalletContent } from "@/components/modules/fidelity_wallet-content";
import { CreditMovementsContent } from "@/components/modules/credit_movements-content";
import { ClientSheetsContent } from "@/components/modules/client_sheets-content";
import { ClientConsentsContent } from "@/components/modules/client_consents-content";
import { ClientSheetTemplatesContent } from "@/components/modules/client_sheet_templates-content";
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
import { giftboxVoucherTokenById, giftcardVoucherTokenById } from "@/lib/gift-issue-details";
import { giftVoucherTokenById } from "@/lib/gifts-instances";
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
  pos_success: PosSuccessContent,
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
  searchParams: Promise<{ public?: string; location_id?: string; service?: string; tab?: string; action?: string; token?: string; embed?: string; format?: string; id?: string; status?: string; client_id?: string; sale_id?: string; due_from?: string; due_to?: string; plan_id?: string; staff_id?: string; source?: string; detail_staff_id?: string; from?: string; to?: string; q?: string; cat?: string; cat_q?: string; cat_status?: string; category_filter_id?: string; low_stock?: string; supplier?: string; category?: string; code?: string; brand?: string; internal_code?: string; product_id?: string; category_search?: string; edit_id?: string; sku?: string; document_number?: string; number?: string; date?: string; include_canceled?: string; p?: string; category_id?: string; scope?: string; msg?: string; err?: string; type?: string; all_locations?: string; package_name?: string; p_pending?: string; p_list?: string; warn_locked?: string; open_summary?: string; inst_client_id?: string; inst_gift_id?: string; inst_state?: string; inst_p?: string }>;
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
  // (instead of the Tailwind ManagementApp fallback). initialQuery = flash legacy.
  if (page === "clients" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientFormContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful client DELETE-CONFIRM page (clients.php action=delete_confirm):
  // riepilogo "Cosa verrà eliminato" + motivazione + conferma testuale ELIMINA.
  if (page === "clients" && query.action === "delete_confirm") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientDeleteConfirmContent slug={tenantSlug} />
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

  // Magazzino, vista CATEGORIE (products.php action=categories): filtro + form
  // edit + modal creazione, query GET legacy come prop.
  if (page === "products" && query.action === "categories") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ProductCategoriesContent
          slug={tenantSlug}
          initialQuery={{ category_search: query.category_search, edit_id: query.edit_id }}
        />
      </ManageShell>
    );
  }

  // Magazzino, LISTA prodotti: i filtri legacy viaggiano nella query GET.
  if (page === "products") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ProductsContent
          slug={tenantSlug}
          initialQuery={{
            low_stock: query.low_stock,
            supplier: query.supplier,
            category: query.category,
            code: query.code,
            brand: query.brand,
            internal_code: query.internal_code,
            product_id: query.product_id,
          }}
        />
      </ManageShell>
    );
  }

  // Fornitori: filtri + flash legacy via query GET.
  if (page === "suppliers" && query.action !== "new" && query.action !== "edit") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <SuppliersContent
          slug={tenantSlug}
          initialQuery={{ q: query.q, scope: query.scope, status: query.status, msg: query.msg, err: query.err }}
        />
      </ManageShell>
    );
  }

  // Carico / Scarico: lista + viste view/print via query GET legacy.
  if (page === "stock_moves" && query.action !== "new") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <StockMovesContent
          slug={tenantSlug}
          initialQuery={{
            action: query.action,
            id: query.id,
            product_id: query.product_id,
            sku: query.sku,
            internal_code: query.internal_code,
            category_id: query.category_id,
            document_number: query.document_number,
            supplier: query.supplier,
            date: query.date,
            include_canceled: query.include_canceled,
            p: query.p,
          }}
        />
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

  // Scadenziario e Costi: i filtri legacy viaggiano nella query GET — inoltrati
  // come prop server-side (parità con il parsing $_GET di costs.php).
  if (page === "costs" && tab === "categories") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CostCategoriesContent
          slug={tenantSlug}
          initialQuery={{
            action: query.action,
            id: query.id,
            cat_q: query.cat_q,
            category_filter_id: query.category_filter_id,
            cat_status: query.cat_status,
          }}
        />
      </ManageShell>
    );
  }
  if (page === "costs") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CostsContent
          slug={tenantSlug}
          initialQuery={{
            from: query.from,
            to: query.to,
            status: query.status,
            cat: query.cat,
            q: query.q,
          }}
        />
      </ManageShell>
    );
  }

  // Faithful quote NEW/EDIT form (quotes.php action=new|edit).
  if (page === "quotes" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuoteFormContent
          slug={tenantSlug}
          initialQuery={{ action: query.action, id: query.id, location_id: query.location_id, msg: query.msg, err: query.err }}
        />
      </ManageShell>
    );
  }

  // Faithful quote DETAIL (quotes.php action=view): header actions condizionali,
  // alert vendita collegata/disponibilità, righe + totali, modale Invia email.
  if (page === "quotes" && query.action === "view") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuoteDetailContent slug={tenantSlug} initialQuery={{ id: query.id, msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful quote PRINT (quotes.php action=print&embed=1, aperta in _blank
  // senza chrome). action=pdf è servita dalla stessa vista stampabile
  // (residuo documentato: nessun renderer PDF server-side in Next).
  if (page === "quotes" && (query.action === "print" || query.action === "pdf")) {
    return <QuotePrintContent slug={tenantSlug} initialQuery={{ id: query.id }} />;
  }

  // Faithful Preventivi / Impostazioni (quote_settings.php): flash ?msg/?err
  // dal redirect legacy.
  if (page === "quote_settings") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuoteSettingsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful quotes LIST (quotes.php action=list): filtri server-side dalla
  // querystring + flash ?msg/?err.
  if (page === "quotes") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <QuotesContent
          slug={tenantSlug}
          initialQuery={{
            client_id: query.client_id,
            status: query.status,
            date: query.date,
            number: query.number,
            all_locations: query.all_locations,
            msg: query.msg,
            err: query.err,
          }}
        />
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
  // (instead of the Tailwind ManagementApp fallback). initialQuery carries the
  // legacy redirect flash (?msg=&type=).
  if (page === "coupons" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CouponFormContent slug={tenantSlug} initialQuery={{ msg: query.msg, type: query.type }} />
      </ManageShell>
    );
  }

  // Faithful coupons LIST: the legacy page reads the redirect flash (?msg=&type=)
  // and the "Tutte le sedi" GET filter from the querystring.
  if (page === "coupons") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CouponsContent
          slug={tenantSlug}
          initialQuery={{ msg: query.msg, type: query.type, all_locations: query.all_locations }}
        />
      </ManageShell>
    );
  }

  // Faithful promotion NEW / EDIT / DUPLICATE form. The promotions list links to
  // index.php?page=promotions&action=new|edit|duplicate; route those to the
  // faithful editor.
  if (page === "promotions" && (query.action === "new" || query.action === "edit" || query.action === "duplicate")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PromotionFormContent slug={tenantSlug} />
      </ManageShell>
    );
  }

  // Faithful promotions LIST (promotions.php action=list): flash ?msg/?err +
  // auto-apertura del Riepilogo via ?open_summary.
  if (page === "promotions") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PromotionsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err, open_summary: query.open_summary }} />
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
  if (page === "gifts" && (query.action === "new" || query.action === "edit" || query.action === "clone")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftFormContent slug={tenantSlug} />
      </ManageShell>
    );
  }

  // Vista "Campagne gift" legacy (gifts.php action=campaigns): flash ?msg/?err
  // dai redirect + auto-apertura del Riepilogo via ?open_summary.
  if (page === "gifts" && query.action === "campaigns") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftsContent slug={tenantSlug} initialQuery={{ action: "campaigns", msg: query.msg, err: query.err, open_summary: query.open_summary }} />
      </ManageShell>
    );
  }

  // Vista default "Omaggi assegnati" (gifts.php): filtri istanze e paginazione
  // dal querystring (form GET legacy) + flash ?msg/?err dei redirect.
  if (page === "gifts") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftsContent
          slug={tenantSlug}
          initialQuery={{ msg: query.msg, err: query.err, inst_client_id: query.inst_client_id, inst_gift_id: query.inst_gift_id, inst_state: query.inst_state, inst_p: query.inst_p }}
        />
      </ManageShell>
    );
  }

  // Faithful package CATALOG editor (packages.php tab=catalog action=catalog_new|
  // catalog_edit): the template form (header + Sedi + contents rows + pricing),
  // instead of the Tailwind fallback.
  if (page === "packages" && tab === "catalog" && (query.action === "catalog_new" || query.action === "catalog_edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PackagesCatalogFormContent slug={tenantSlug} />
      </ManageShell>
    );
  }

  // Faithful client-package DETAIL (packages.php tab=clients action=view/
  // client_view): the client package header + contents + usage history + expiry
  // edit, instead of the Tailwind fallback. initialQuery = flash legacy.
  if (page === "packages" && (query.action === "view" || query.action === "client_view")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientPackageDetailContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful client-package EDIT form (packages.php tab=clients
  // action=client_edit; client_new è bloccato dal legacy e il componente lo
  // redirige con l'errore verbatim).
  if (page === "packages" && (query.action === "client_edit" || query.action === "client_new")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientPackageFormContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // client_cancel / client_delete (packages.php): annullamento/eliminazione
  // solo dal dettaglio vendita — redirect col messaggio verbatim.
  if (page === "packages" && (query.action === "client_cancel" || query.action === "client_delete")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientPackageCancelRedirect slug={tenantSlug} action={query.action} id={query.id} />
      </ManageShell>
    );
  }

  // Faithful packages CATALOG list (packages.php tab=catalog action=list):
  // filtro all_locations + flash ?msg/?err dai redirect.
  if (page === "packages" && query.tab === "catalog" && (query.action === undefined || query.action === "list")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PackagesCatalogContent
          slug={tenantSlug}
          initialQuery={{ all_locations: query.all_locations, msg: query.msg, err: query.err }}
        />
      </ManageShell>
    );
  }

  // Faithful packages CLIENTS list (packages.php tab=clients action=list):
  // filtri GET (client_id/package_name/status/all_locations) + flash ?msg/?err.
  if (page === "packages" && (query.tab === undefined || query.tab === "clients") && (query.action === undefined || query.action === "list")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <PackagesContent
          slug={tenantSlug}
          initialQuery={{
            client_id: query.client_id,
            package_name: query.package_name,
            status: query.status,
            all_locations: query.all_locations,
            msg: query.msg,
            err: query.err,
          }}
        />
      </ManageShell>
    );
  }

  // Faithful giftcard DETAIL (giftcard.php action=edit/view): header + balance +
  // transactions + redeem/update-recipient, instead of the Tailwind fallback.
  if (page === "giftcard" && (query.action === "edit" || query.action === "view")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftCardDetailContent slug={tenantSlug} initialQuery={{ id: query.id, msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful giftcard LIST (giftcard.php action=list): filtri server-side dalla
  // querystring + flash ?msg/?err (action=new -> lista con il messaggio legacy
  // "vai in Pagamenti").
  if (page === "giftcard") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftcardContent
          slug={tenantSlug}
          initialQuery={{
            action: query.action,
            q: query.q,
            status: query.status,
            client_id: query.client_id,
            all_locations: query.all_locations,
            msg: query.msg,
            err: query.err,
          }}
        />
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
        <GiftBoxInstanceDetailContent slug={tenantSlug} initialQuery={{ id: query.id, msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful giftbox TEMPLATE editor (giftbox.php tab=boxes action=new|edit). The
  // giftbox templates grid links to index.php?page=giftbox&action=new|edit; route
  // those to the faithful template editor (instead of the Tailwind fallback).
  if (page === "giftbox" && (query.action === "new" || query.action === "edit")) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftBoxFormContent slug={tenantSlug} initialQuery={{ action: query.action, id: query.id, msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful Ricariche (recharges.php): flash ?msg/?err via redirect.
  if (page === "recharges") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <RechargesContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // fidelity_levels.php: il GET legacy redirige SEMPRE a fidelity_points
  // portando con sé i flash ?msg/?err (l'editor Livelli Card vive lì).
  if (page === "fidelity_levels") {
    const qs = new URLSearchParams();
    if (query.msg) qs.set("msg", query.msg);
    if (query.err) qs.set("err", query.err);
    redirect(`/${encodeURIComponent(tenantSlug)}/fidelity_points${qs.size > 0 ? `?${qs.toString()}` : ""}`);
  }

  // Faithful Impostazioni tessera Fidelity (fidelity_membership_settings.php):
  // flash ?msg/?err via redirect (#fidelity_card_settings).
  if (page === "fidelity_membership_settings") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FidelityMembershipSettingsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful Adesione (fidelity_membership.php): filtro ?q + pagina ?p +
  // flash ?msg/?err.
  if (page === "fidelity_membership") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FidelityMembershipContent slug={tenantSlug} initialQuery={{ q: query.q, p: query.p, msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful Portafoglio punti (fidelity_wallet.php): querystring legacy
  // (?client_id/p/p_pending/p_list) + flash ?msg/?err + ?warn_locked.
  if (page === "fidelity_wallet") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FidelityWalletContent
          slug={tenantSlug}
          initialQuery={{
            client_id: query.client_id,
            p: query.p,
            p_pending: query.p_pending,
            p_list: query.p_list,
            msg: query.msg,
            err: query.err,
            warn_locked: query.warn_locked,
          }}
        />
      </ManageShell>
    );
  }

  // Faithful Punti Fidelity (fidelity_points.php): flash ?msg/?err.
  if (page === "fidelity_points") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FidelityPointsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful Fidelity (fidelity.php): toggle generale con flash ?msg/?err.
  if (page === "fidelity") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FidelityContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful GiftCard / Impostazioni (giftcard_settings.php): flash ?msg/?err.
  if (page === "giftcard_settings") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftcardSettingsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful GiftBox / Impostazioni (giftbox_settings.php): flash ?msg/?err.
  if (page === "giftbox_settings") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftboxSettingsContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful giftbox LIST (giftbox.php): filtri server-side dalla querystring
  // (tab=instances/boxes) + flash ?msg/?err.
  if (page === "giftbox") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <GiftboxContent
          slug={tenantSlug}
          initialQuery={{
            tab: query.tab,
            q: query.q,
            status: query.status,
            client_id: query.client_id,
            all_locations: query.all_locations,
            msg: query.msg,
            err: query.err,
          }}
        />
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
        <ClientDetailContent slug={tenantSlug} initialQuery={{ msg: query.msg, err: query.err }} />
      </ManageShell>
    );
  }

  // Faithful clients LIST: la pagina legacy legge ?q=&all_locations= (form GET)
  // e il flash ?msg=&err= dei redirect delle azioni.
  if (page === "clients") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <ClientsContent
          slug={tenantSlug}
          initialQuery={{ q: query.q, all_locations: query.all_locations, msg: query.msg, err: query.err }}
        />
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

  // Voucher GiftBox/GiftCard/Omaggio in variante MANAGE (?id=N[&embed=1] — i link
  // "Voucher" di Movimenti e dei dettagli istanza; legacy giftbox_voucher.php /
  // giftcard_voucher.php / gift_voucher.php in modalità loggata): risolve il
  // token pubblico dall'istanza (backfill lazy) e riusa lo stesso viewer fedele
  // della variante pubblica.
  if (page === "giftbox_voucher" && query.id) {
    const token = await giftboxVoucherTokenById(tenantSlug, Number.parseInt(String(query.id), 10) || 0);
    return <GiftBoxVoucherFaithful slug={tenantSlug} token={token} embed={query.embed === "1"} />;
  }
  if (page === "giftcard_voucher" && query.id) {
    const token = await giftcardVoucherTokenById(tenantSlug, Number.parseInt(String(query.id), 10) || 0);
    return <GiftCardVoucherFaithful slug={tenantSlug} token={token} embed={query.embed === "1"} />;
  }
  if (page === "gift_voucher" && query.id) {
    const token = await giftVoucherTokenById(tenantSlug, Number.parseInt(String(query.id), 10) || 0);
    return <GiftVoucherFaithful slug={tenantSlug} token={token} embed={query.embed === "1"} />;
  }

  // Commissioni (Riepilogo): i filtri legacy viaggiano nella query GET
  // (from/to/staff_id/source/detail_staff_id) — inoltrati come prop server-side.
  if (page === "commissions" && tab !== "settings") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <CommissionsContent
          slug={tenantSlug}
          initialQuery={{
            from: query.from,
            to: query.to,
            staff_id: query.staff_id,
            source: query.source,
            detail_staff_id: query.detail_staff_id,
          }}
        />
      </ManageShell>
    );
  }

  // Gestione Rate: i filtri legacy viaggiano nella query GET (status/client_id/
  // sale_id/due_from/due_to/plan_id) — inoltrati come prop server-side, come il
  // parsing $_GET della pagina PHP.
  if (page === "installments_manage") {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <InstallmentsManageContent
          slug={tenantSlug}
          initialQuery={{
            status: query.status,
            client_id: query.client_id,
            sale_id: query.sale_id,
            due_from: query.due_from,
            due_to: query.due_to,
            plan_id: query.plan_id,
          }}
        />
      </ManageShell>
    );
  }

  // Modulo fedele: anche CON ?action= residue (i moduli leggono l'action dall'URL
  // client-side — es. appointments?action=edit apre il drawer; un'action ignota
  // rende la lista, come il legacy). Le action con pagina dedicata sono già
  // state instradate dagli special-case sopra.
  const faithfulPageKey = page ? faithfulKey(page, tab) : "";
  const FaithfulContent = faithfulPageKey ? FAITHFUL_MODULES[faithfulPageKey] : undefined;
  if (FaithfulContent) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <FaithfulContent slug={tenantSlug} />
      </ManageShell>
    );
  }

  // Pagina sconosciuta: 404 come il legacy (index.php ~517-521: header "404" +
  // card "Pagina non trovata" dentro il layout). La vecchia app Tailwind
  // (ManagementApp) che faceva da fallback è stata ELIMINATA: mostrava un
  // gestionale completamente diverso e non è mai il comportamento del PHP.
  if (page) {
    return (
      <ManageShell slug={tenantSlug} userName={session.user.name} currentPage={page}>
        <div className="card p-4">
          <div className="h4 fw-semibold">Pagina non trovata</div>
        </div>
      </ManageShell>
    );
  }

  redirect(`/${tenantSlug}/dashboard`);
}

// Resolve the FAITHFUL_MODULES key for a page/tab combination.
function faithfulKey(page: string, tab?: string): string {
  // Retro-compat legacy (settings.php è uno shim di 3 righe): la vecchia
  // pagina "Impostazioni" è ora "Sedi" (require locations.php).
  if (page === "settings") return "locations";
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

