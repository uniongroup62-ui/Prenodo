"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Accessibility,
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BadgeEuro,
  BarChart3,
  Bell,
  BookOpenCheck,
  Bot,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  CreditCard,
  FileSignature,
  Gift,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MapPin,
  Megaphone,
  Package,
  PackageCheck,
  Pencil,
  PiggyBank,
  Plus,
  Save,
  Search,
  Scissors,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Tags,
  Trash2,
  Truck,
  UserCog,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import {
  todayIso,
  type AppointmentWithMeta,
  type SlotAvailability,
} from "@/lib/appointment-engine";
import { can, landingPageForPermissions, permissionForFeature } from "@/lib/role-permissions";
import type {
  AutomationRule,
  ClientPackage,
  ClientPrepaid,
  CommissionEntry,
  ConfigModuleState,
  ConfigRecord,
  CostItem,
  CouponRule,
  GiftBoxInstance,
  GiftCard,
  GiftReward,
  InstallmentPlan,
  ManagedClient,
  ManagedProduct,
  ManagedService,
  NotificationItem,
  PackageCatalog,
  PosSale,
  PosSummary,
  Preorder,
  PromotionRule,
  Quote,
  WalletMovement,
} from "@/lib/tenant-store";
import { tenantSessionSuffix } from "@/lib/tenant-runtime";

type FeatureState = "Replica navigabile" | "Analizzato" | "Da collegare al DB";
type AppointmentStatus = "Confermato" | "In attesa" | "Completato" | "Annullato" | "No show";
type Location = {
  id: number;
  tenantSlug: string;
  slug: string;
  name: string;
  address: string;
  city: string;
  area: string;
  phone: string;
  hoursToday: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
};

type FeatureItem = {
  id: string;
  label: string;
  subtitle: string;
  source: string;
  state: FeatureState;
  icon: LucideIcon;
  features: string[];
  records: { label: string; value: string; detail: string }[];
};

type ManagementUser = {
  id: number;
  name: string;
  email: string;
  role: string;
  perms: string[];
  locationIds?: number[];
  currentLocationId?: number;
  needsLocationSelection?: boolean;
};

type FeatureGroup = {
  title: string;
  items: FeatureItem[];
};

type DashboardPayload = {
  sourceMode?: "database";
  stats: Array<{ label: string; value: string; detail: string }>;
  weekly: {
    range: string;
    metrics: Array<{ label: string; value: string; detail: string; tone?: "good" | "bad" | "neutral" }>;
    series: Array<{ date: string; label: string; revenue: number; appointments: number }>;
  };
  appointments: {
    today: AppointmentWithMeta[];
    upcoming: AppointmentWithMeta[];
  };
  notifications: NotificationItem[];
  costs: {
    summary: { open: number; overdue: number; paid: number; dueAmount: number };
    overdueAmount: number;
    monthAmount: number;
    overdueCount: number;
    monthCount: number;
  };
};

type ManageServicePayload = {
  ok?: boolean;
  error?: string;
  stats?: { services: number; activeServices: number; categories: number; recommendedLinks: number };
  services?: ManageServiceItem[];
  categories?: ServiceCategoryItem[];
  locations?: ServiceLocationItem[];
  cabins?: ServiceCabinItem[];
  staff?: ServiceStaffItem[];
  resources?: ServiceResourceItem[];
  marketplace?: {
    taxonomyCategories?: MarketplaceTaxonomyItem[];
    categoryMappings?: Array<{
      tenantCategoryId: number;
      marketplaceCategoryId: number | null;
      marketplaceCategoryName: string;
    }>;
  };
};

type ManageServiceItem = {
  id: number;
  name: string;
  durationMin: number;
  duration: string;
  priceValue: number;
  price: string;
  categoryId: number | null;
  categoryName: string;
  cabinId: number | null;
  sortOrder: number;
  isActive: boolean;
  active: boolean;
  bookingEnabled: boolean;
  noOperator: boolean;
  locationIds: number[];
  cabinIds: number[];
  staffIds: number[];
  recommendationIds: number[];
  recoCount: number;
};

type ServiceCategoryItem = {
  id: number;
  name: string;
  imageUrl: string;
  sortOrder: number;
  isDefault: boolean;
  serviceCount: number;
  marketplaceCategoryId: number | null;
  marketplaceCategoryName: string;
};

type ServiceLocationItem = { id: number; name: string; isActive: boolean };
type ServiceCabinItem = { id: number; name: string; isActive: boolean; locationId: number | null; position: number };
type ServiceStaffItem = { id: number; fullName: string; email: string; isActive: boolean; locationIds: number[] };
type ServiceResourceItem = { id: number; name: string; qtyTotal: number };
type MarketplaceTaxonomyItem = { id: number; slug: string; name: string; sortOrder: number };

type ServiceDraft = {
  id: number;
  name: string;
  durationMin: string;
  price: string;
  categoryId: string;
  isActive: boolean;
  bookingEnabled: boolean;
  noOperator: boolean;
  locationIds: number[];
  cabinIds: number[];
  staffIds: number[];
};

type CategoryDraft = {
  id: number;
  name: string;
  imageUrl: string;
};

type ManageProductPayload = {
  ok?: boolean;
  error?: string;
  activeLocationId?: number;
  stats?: {
    products: number;
    activeProducts: number;
    lowStock: number;
    categories: number;
    suppliers: number;
    stockDocuments: number;
  };
  products?: WarehouseProductItem[];
  categories?: WarehouseCategoryItem[];
  locations?: WarehouseLocationItem[];
  suppliers?: WarehouseSupplierItem[];
  stockDocuments?: WarehouseStockDocument[];
};

type WarehouseProductItem = {
  id: number;
  name: string;
  brand: string;
  internalCode: string;
  sku: string;
  categoryId: number | null;
  categoryName: string;
  priceValue: number;
  price: string;
  purchasePrice: number;
  supplierName: string;
  stock: number;
  minStock: number;
  reorderQty: number;
  incomingQty: number;
  incomingEta: string;
  isActive: boolean;
  publicVisible: boolean;
  sellOnline: boolean;
  locationIds: number[];
  lowStock: boolean;
  description: string;
  ingredients: string;
  warnings: string;
};

type WarehouseCategoryItem = { id: number; name: string; productCount: number };
type WarehouseLocationItem = { id: number; name: string; isActive: boolean };
type WarehouseSupplierItem = {
  id: number;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  mobile: string;
  city: string;
  vatNumber: string;
  isActive: boolean;
  isActiveCosts: boolean;
  warehouseLocationIds: number[];
  costLocationIds: number[];
};
type WarehouseStockDocument = {
  id: number;
  moveDate: string;
  cause: "carico" | "scarico";
  operatorName: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  notes: string;
  locationId: number | null;
  isCanceled: boolean;
  items: Array<{ id: number; productId: number; productName: string; productSku: string; qty: number; incomingFlag: boolean; incomingQty: number; incomingEta: string }>;
};

type ProductDraft = {
  id: number;
  name: string;
  sku: string;
  brand: string;
  categoryId: string;
  price: string;
  purchasePrice: string;
  minStock: string;
  reorderQty: string;
  supplierName: string;
  locationIds: number[];
  isActive: boolean;
  sellOnline: boolean;
};

type WarehouseCategoryDraft = { id: number; name: string };
type SupplierDraft = {
  id: number;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  city: string;
  vatNumber: string;
  warehouseLocationIds: number[];
  costLocationIds: number[];
  isActive: boolean;
  isActiveCosts: boolean;
};

type ManageCostsPayload = {
  ok?: boolean;
  error?: string;
  activeLocationId?: number;
  filters?: {
    from: string;
    to: string;
    status: "open" | "overdue" | "paid" | "all";
    query: string;
    categoryId: number;
  };
  summary?: {
    open: number;
    overdue: number;
    paid: number;
    dueAmount: number;
    overdueAmount: number;
    paidAmount: number;
    remainingAmount: number;
  };
  costs?: ManageCostItem[];
  categories?: ManageCostCategory[];
  suppliers?: ManageCostSupplier[];
  locations?: ManageCostLocation[];
};

type ManageCostItem = {
  id: number;
  title: string;
  categoryId: number | null;
  categoryName: string;
  categoryColor: string;
  supplierId: number | null;
  supplierName: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  vatPercent: number | null;
  dueDate: string;
  status: "open" | "overdue" | "paid";
  isPaid: boolean;
  isPartial: boolean;
  paidAt: string;
  paymentMethod: string;
  docNumber: string;
  docDate: string;
  notes: string;
  isRecurring: boolean;
  recurrenceInterval: number;
  recurrenceUnit: "day" | "week" | "month" | "year";
  recurrenceEndDate: string;
  locationId: number | null;
  locationName: string;
  attachmentName: string;
  attachmentSize: number;
  createdAt: string;
};

type ManageCostCategory = { id: number; name: string; color: string; isActive: boolean; costCount: number };
type ManageCostSupplier = { id: number; name: string; isActive: boolean; isActiveCosts: boolean; costLocationIds: number[] };
type ManageCostLocation = { id: number; name: string; isActive: boolean };

type CostDraft = {
  id: number;
  title: string;
  categoryId: string;
  supplierId: string;
  amount: string;
  paidAmount: string;
  vatPercent: string;
  dueDate: string;
  paymentMethod: string;
  docNumber: string;
  docDate: string;
  notes: string;
  isPaid: boolean;
  isRecurring: boolean;
  recurrenceInterval: string;
  recurrenceUnit: "day" | "week" | "month" | "year";
  recurrenceEndDate: string;
};

type CostCategoryDraft = { id: number; name: string; color: string; isActive: boolean };

type CalendarStaff = {
  id: number;
  name: string;
  email: string;
  color: string;
  photoPath: string;
};

type CalendarNote = {
  id: number;
  noteDate: string;
  title: string;
  noteText: string;
  createdByName: string;
  updatedByName: string;
  createdAtLabel: string;
  updatedAtLabel: string;
};

type CalendarPayload = {
  ok: boolean;
  error?: string;
  sourceMode?: "database";
  date: string;
  start: string;
  end: string;
  staff: CalendarStaff[];
  staffOrder: number[];
  locations: Location[];
  services: ManagedService[];
  appointments: AppointmentWithMeta[];
  notes: CalendarNote[];
  countByDate: Record<string, number>;
};

type ResourceLocationOption = {
  id: number;
  name: string;
  isActive: boolean;
};

type ResourceServiceOption = {
  id: number;
  name: string;
  isActive: boolean;
};

type ResourceLinkedService = {
  serviceId: number;
  serviceName: string;
  qtyRequired?: number;
  isActive: boolean;
};

type SharedResourceLocation = {
  locationId: number;
  locationName: string;
  qtyTotal: number;
  isEnabled: boolean;
};

type SharedResourceRow = {
  id: number;
  name: string;
  description: string;
  qtyTotal: number;
  locations: SharedResourceLocation[];
  serviceLinks: ResourceLinkedService[];
};

type ResourceCabinRow = {
  id: number;
  name: string;
  position: number;
  isActive: boolean;
  locationId: number | null;
  locationName: string;
  serviceLinks: ResourceLinkedService[];
};

type ResourceStaffRow = {
  id: number;
  fullName: string;
  phone: string;
  email: string;
  role: "admin" | "staff" | "altro";
  isActive: boolean;
  color: string;
  photoPath: string;
  locationIds: number[];
  locations: ResourceLocationOption[];
  serviceLinks: ResourceLinkedService[];
  isOwner: boolean;
};

type BusinessHourRow = {
  id: number;
  dow: number;
  dayLabel: string;
  locationId: number | null;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  isClosed: boolean;
};

type CalendarDateRange = {
  start: string;
  end: string;
  reason: string;
  ids: number[];
};

type CalendarExceptionRange = {
  start: string;
  end: string;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  note: string;
};

type StaffAvailabilityEvent = {
  id: number;
  table: "availability" | "timeoff";
  staffId: number;
  staffName: string;
  type: string;
  startsAt: string;
  endsAt: string;
  dateFrom: string;
  dateTo: string;
  timeFrom: string;
  timeTo: string;
  locationId: number | null;
  seriesUid: string;
};

type ResourcePayload = {
  ok?: boolean;
  error?: string;
  source?: string;
  sourceMode?: "database";
  activeLocationId: number;
  locations: ResourceLocationOption[];
  services: ResourceServiceOption[];
  resources: SharedResourceRow[];
  cabins: ResourceCabinRow[];
  staff: ResourceStaffRow[];
  hours: BusinessHourRow[];
  closures: CalendarDateRange[];
  exceptions: CalendarExceptionRange[];
  availability: StaffAvailabilityEvent[];
};

type BusinessSettingsTab = "business_profile" | "locations" | "marketplace";

type BusinessSettingsPayload = {
  ok?: boolean;
  error?: string;
  source?: string;
  tenant?: {
    id: number;
    slug: string;
    name: string;
    booking_public_allowed: number;
    marketplace_public_allowed: number;
  } | null;
  featureFlags?: {
    bookingPublicAllowed: boolean;
    marketplacePublicAllowed: boolean;
    unavailableMessage: string;
  };
  business?: {
    id: number;
    name: string;
    bookingAboutText: string;
    phone: string;
    email: string;
    website: string;
    logoUrl: string;
    coverUrl: string;
    logoPositionX: number;
    logoPositionY: number;
    coverPositionX: number;
    coverPositionY: number;
  };
  branding?: {
    logoUrl: string;
    coverUrl: string;
    logoPosition: { x: number; y: number };
    coverPosition: { x: number; y: number };
  };
  locations?: BusinessLocationRow[];
  marketplace?: {
    profile?: Record<string, unknown> | null;
    activityCategories: MarketplaceActivityCategory[];
    mappings: Record<string, LocationActivityCategory[]>;
    visibleLocations: BusinessLocationRow[];
    publicUrl: string;
  };
  deletePreview?: LocationDeletePreview | null;
};

type BusinessLocationRow = {
  id: number;
  name: string;
  address: string;
  isActive: boolean;
  phone: string;
  email: string;
  whatsapp: string;
  facebookUrl: string;
  instagramUrl: string;
  tiktokUrl: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
  sortOrder: number;
  legal: Record<string, string>;
  galleryImages: Array<{ id: number; path: string; url: string; sortOrder: number }>;
  activityCategories: LocationActivityCategory[];
  bookingUrl: string;
};

type MarketplaceActivityCategory = {
  id: number;
  slug: string;
  name: string;
  iconKey: string;
  sortOrder: number;
};

type LocationActivityCategory = {
  marketplaceCategoryId: number;
  marketplaceCategorySlug: string;
  marketplaceCategoryName: string;
  iconKey: string;
  isPrimary: boolean;
  sortOrder: number;
};

type LocationDeletePreview = {
  ok?: boolean;
  error?: string;
  location?: BusinessLocationRow;
  activeCount?: number;
  locationCount?: number;
  canDelete?: boolean;
  deleteBlockReason?: string;
  blockingCounts?: Record<string, number>;
  directCounts?: Record<string, number>;
  confirmText?: string;
};

type PermissionDefinitionRow = {
  perm: string;
  label: string;
  groupName: string;
  sortOrder: number;
  assignable?: boolean;
};

type PermissionGroupRow = {
  groupName: string;
  definitions: PermissionDefinitionRow[];
};

type PermissionsPayload = {
  ok?: boolean;
  error?: string;
  source?: string;
  rolePermissions?: {
    groups: PermissionGroupRow[];
    manageableRoles: Record<string, string>;
    selectedRole: string;
    assignments: Record<string, string[]>;
    selectedPerms: string[];
    validationError?: string | null;
    landingPage: string;
  };
};

const stateStyles: Record<FeatureState, string> = {
  "Replica navigabile": "bg-emerald-100 text-emerald-800",
  Analizzato: "bg-sky-100 text-sky-800",
  "Da collegare al DB": "bg-amber-100 text-amber-900",
};

const statusStyles: Record<AppointmentStatus, string> = {
  Confermato: "bg-emerald-100 text-emerald-800",
  "In attesa": "bg-amber-100 text-amber-900",
  Completato: "bg-zinc-200 text-zinc-700",
  Annullato: "bg-zinc-200 text-zinc-500",
  "No show": "bg-zinc-800 text-white",
};

const featureGroups: FeatureGroup[] = [
  {
    title: "Panoramica",
    items: [
      feature("dashboard", "Dashboard", "KPI, prossimi appuntamenti, scadenze e avvisi.", "app/pages/dashboard.php", "Replica navigabile", LayoutDashboard, [
        "Statistiche settimanali",
        "Prossimi appuntamenti",
        "Avvisi e scadenziario",
      ]),
      feature("calendar", "Calendario", "Vista giornaliera e settimanale di agenda, note e disponibilita.", "app/pages/calendar.php", "Replica navigabile", CalendarDays, [
        "Eventi per operatore",
        "Note calendario",
        "Filtri sede",
      ]),
      feature("notifications", "Notifiche", "Centro notifiche per richieste, compleanni, rate e preventivi.", "app/pages/notifications.php", "Replica navigabile", Bell, [
        "Richieste appuntamento",
        "Alert fidelity",
        "Decisioni preventivi",
      ]),
    ],
  },
  {
    title: "Appuntamenti",
    items: [
      feature("appointments", "Appuntamenti", "Lista, stati, schede appuntamento e azioni rapide.", "app/pages/appointments.php", "Replica navigabile", ClipboardList, [
        "Conferma e completamento",
        "No-show e annullamenti",
        "Collegamento vendita",
      ]),
      feature("appointments_plan", "Pianifica", "Pianificazione operativa con servizi, cabine e professionisti.", "app/pages/appointments_plan.php", "Replica navigabile", CalendarPlus, [
        "Disponibilita slot",
        "Assegnazione risorse",
        "Prevenzione conflitti",
      ]),
    ],
  },
  {
    title: "Pagamenti",
    items: [
      feature("pos", "Pagamenti", "Cassa, carrello, incassi e vendita da appuntamento.", "app/pages/pos.php", "Replica navigabile", CreditCard, [
        "Vendita servizi e prodotti",
        "Pagamenti misti",
        "Ricevute e dettaglio vendita",
      ]),
      feature("pos_history", "Movimenti", "Storico vendite, rimborsi, filtri e dettagli.", "app/pages/pos_history.php", "Replica navigabile", CircleDollarSign, [
        "Filtri per periodo",
        "Dettaglio vendita",
        "Movimenti credito",
      ]),
      feature("pos_prepaids", "Prepagati", "Credito e servizi prepagati collegati ai clienti.", "app/pages/pos_prepaids.php", "Replica navigabile", PiggyBank, [
        "Scadenza credito",
        "Utilizzi residui",
        "Collegamento cliente",
      ]),
      feature("pos_preorders", "Preordini", "Prenotazioni prodotto e ordini non ancora saldati.", "app/pages/pos_preorders.php", "Replica navigabile", ShoppingBag, [
        "Acconti",
        "Ritiro prodotto",
        "Scadenze preordine",
      ]),
      feature("installments_manage", "Gestione Rate", "Rate, scadenze, alert e incassi parziali.", "app/pages/installments_manage.php", "Replica navigabile", BadgeEuro, [
        "Piani rateali",
        "Alert scadenza",
        "Saldo da vendita",
      ]),
      feature("costs", "Scadenziario e Costi", "Costi ricorrenti, categorie, allegati e scadenze.", "app/pages/costs.php", "Replica navigabile", ClipboardCheck, [
        "Scadenze aperte",
        "Categorie costo",
        "Allegati documento",
      ]),
      feature("cost_categories", "Categorie costi", "Categorie economiche usate da scadenziario, report e allegati.", "app/pages/costs.php?tab=categories", "Replica navigabile", Tags, [
        "Colori categoria",
        "Attivazione",
        "Filtri scadenziario",
      ]),
      feature("pos_settings", "Impostazioni POS", "Configurazione cassa, pagamenti e numerazione vendite.", "app/pages/pos_settings.php", "Replica navigabile", Settings, [
        "Metodi pagamento",
        "Numerazione",
        "Ricevute",
      ]),
      feature("commissions", "Commissioni", "Provvigioni operatori su servizi, vendite e obiettivi.", "app/pages/commissions.php", "Replica navigabile", BriefcaseBusiness, [
        "Regole commissione",
        "Riepilogo operatore",
        "Collegamento pagamenti",
      ]),
    ],
  },
  {
    title: "Magazzino",
    items: [
      feature("products", "Magazzino", "Prodotti, giacenze, prezzi e visibilita booking.", "app/pages/products.php", "Replica navigabile", Boxes, [
        "Schede prodotto",
        "Soglie stock",
        "Prodotti pubblici",
      ]),
      feature("product_categories", "Categorie prodotti", "Organizzazione catalogo prodotti.", "app/pages/products.php?action=categories", "Replica navigabile", Tags, [
        "Categorie",
        "Ordinamento",
        "Filtri catalogo",
      ]),
      feature("stock_moves", "Carico / Scarico", "Movimenti stock, fornitori e documenti.", "app/pages/stock_moves.php", "Replica navigabile", Truck, [
        "Carico merce",
        "Scarico manuale",
        "Rettifiche giacenza",
      ]),
      feature("suppliers", "Fornitori", "Anagrafiche fornitori condivise con costi e magazzino.", "app/pages/suppliers.php", "Replica navigabile", Archive, [
        "Contatti",
        "Partita IVA",
        "Associazione prodotti",
      ]),
      feature("coupons", "Buoni", "Coupon e buoni sconto collegabili a clienti e vendite.", "app/pages/coupons.php", "Replica navigabile", Tags, [
        "Codici coupon",
        "Sconti",
        "Validita",
      ]),
    ],
  },
  {
    title: "Clienti",
    items: [
      feature("clients", "Clienti", "Anagrafica, storico, valore cliente e documenti.", "app/pages/clients.php", "Replica navigabile", Users, [
        "Storico appuntamenti",
        "Consensi e schede",
        "Wallet cliente",
      ]),
      feature("client_sheets", "Schede cliente", "Schede tecniche configurabili per trattamenti.", "app/pages/client_sheets.php", "Analizzato", ClipboardList, [
        "Template campi",
        "Valori per cliente",
        "Allegati",
      ]),
      feature("client_sheet_templates", "Template schede", "Preset e modelli riutilizzabili per schede cliente.", "app/pages/client_sheet_templates.php", "Analizzato", ListChecks, [
        "Preset sistema",
        "Campi dinamici",
        "Categorie scheda",
      ]),
      feature("client_consents", "Consensi cliente", "Privacy, firme digitali e moduli informati.", "app/pages/client_consents.php", "Analizzato", ShieldCheck, [
        "Firma cliente",
        "PDF privacy",
        "Stato consenso",
      ]),
      feature("packages", "Pacchetti", "Catalogo pacchetti, sedute residue e assegnazione cliente.", "app/pages/packages.php", "Replica navigabile", PackageCheck, [
        "Pacchetti cliente",
        "Catalogo",
        "Sedute residue",
      ]),
      feature("package_settings", "Impostazioni pacchetti", "Validita predefinita, catalogo e regole residui pacchetto.", "app/pages/packages.php?tab=settings", "Replica navigabile", Settings, [
        "Validita default",
        "Catalogo pacchetti",
        "Residui vendita",
      ]),
      feature("quotes", "Preventivi", "Preventivi PDF, invio cliente e accettazione online.", "app/pages/quotes.php", "Replica navigabile", FileSignature, [
        "Righe servizi/prodotti",
        "PDF e token pubblico",
        "Conversione in vendita",
      ]),
      feature("quote_settings", "Impostazioni preventivi", "Intestazione documenti e condizioni standard.", "app/pages/quote_settings.php", "Replica navigabile", Settings, [
        "Template condizioni",
        "Metodi pagamento",
        "Logo e firma",
      ]),
      feature("giftbox", "GiftBox", "Template, emissione, voucher e impostazioni GiftBox.", "app/pages/giftbox.php", "Replica navigabile", Gift, [
        "Template GiftBox",
        "Voucher pubblico",
        "Disponibilita",
      ]),
      feature("giftbox_settings", "Impostazioni GiftBox", "Validita, termini e regole di pubblicazione GiftBox.", "app/pages/giftbox_settings.php", "Replica navigabile", Settings, [
        "Validita default",
        "Termini GiftBox",
        "Regole riscatto",
      ]),
      feature("giftcard", "GiftCard", "GiftCard acquistabili, eventi e voucher pubblico.", "app/pages/giftcard.php", "Replica navigabile", CreditCard, [
        "Importi",
        "Voucher",
        "Eventi ricorrenza",
      ]),
      feature("giftcard_settings", "Impostazioni GiftCard", "Validita, termini e opzioni voucher/email GiftCard.", "app/pages/giftcard_settings.php", "Replica navigabile", Settings, [
        "Validita default",
        "Termini GiftCard",
        "Voucher pubblico",
      ]),
    ],
  },
  {
    title: "Fidelizzazione",
    items: [
      feature("fidelity", "Fidelity", "Programma punti, livelli, tessere e regole.", "app/pages/fidelity.php", "Replica navigabile", HeartHandshake, [
        "Punti",
        "Livelli card",
        "Regole accumulo",
      ]),
      feature("fidelity_membership", "Adesione", "Regole di iscrizione, tessere attive e stato programma fidelity.", "app/pages/fidelity_membership.php", "Replica navigabile", ShieldCheck, [
        "Adesione cliente",
        "Tessere attive",
        "Consensi fidelity",
      ]),
      feature("recharges", "Ricariche", "Credito prepagato, bonus e campagne.", "app/pages/recharges.php", "Replica navigabile", WalletCards, [
        "Credito cliente",
        "Bonus",
        "Scadenze",
      ]),
      feature("wallet", "Portafoglio", "Credito e punti cliente in un unico pannello.", "app/pages/wallet.php", "Replica navigabile", WalletCards, [
        "Saldo credito",
        "Saldo punti",
        "Movimenti",
      ]),
      feature("promotions", "Promozioni", "Regole promozionali per booking, clienti e canali.", "app/pages/promotions.php", "Replica navigabile", Megaphone, [
        "Target cliente",
        "Sconti servizi",
        "Validita dettagliata",
      ]),
      feature("fidelity_points", "Punti", "Movimenti punti, accumulo, riscatto e saldo fidelity.", "app/pages/fidelity_points.php", "Replica navigabile", CircleDollarSign, [
        "Accumulo punti",
        "Riscatto",
        "Lotti e scadenze",
      ]),
      feature("fidelity_levels", "Livelli Card", "Soglie silver/gold, periodo livello e JSON livelli card.", "app/pages/fidelity_points.php#livelli-card", "Replica navigabile", BadgeEuro, [
        "Soglie punti",
        "Periodo livello",
        "Livelli personalizzati",
      ]),
      feature("gifts", "Omaggi", "Omaggi, voucher e regole di riscatto.", "app/pages/gifts.php", "Replica navigabile", Gift, [
        "Catalogo omaggi",
        "Voucher",
        "Riscatto",
      ]),
    ],
  },
  {
    title: "Risorse",
    items: [
      feature("resources", "Risorse", "Hub operativo per servizi, cabine, staff e orari.", "app/pages/resources.php", "Replica navigabile", Store, [
        "Cataloghi operativi",
        "Setup risorse",
        "Collegamenti rapidi",
      ]),
      feature("services", "Servizi", "Catalogo servizi, durata, prezzo, sedi e disponibilita online.", "app/pages/services.php", "Replica navigabile", Scissors, [
        "Durata e prezzo",
        "Sedi abilitate",
        "Booking online",
      ]),
      feature("service_categories", "Categorie servizi", "Categorie e ordine del catalogo servizi.", "app/pages/services.php?tab=categories", "Replica navigabile", Tags, [
        "Albero categorie",
        "Ordinamento",
        "Icone marketplace",
      ]),
      feature("service_recommendations", "Servizi consigliati", "Suggerimenti collegati al percorso cliente.", "app/pages/services.php?tab=recommended", "Replica navigabile", Sparkles, [
        "Cross-sell",
        "Priorita",
        "Contesto booking",
      ]),
      feature("cabins", "Cabine", "Cabine e sale collegate alla pianificazione.", "app/pages/cabins.php", "Replica navigabile", Store, [
        "Capienza",
        "Sede",
        "Disponibilita",
      ]),
      feature("staff", "Operatori", "Operatori, ruoli, sedi abilitate e profilo.", "app/pages/staff.php", "Replica navigabile", UserCog, [
        "Anagrafica staff",
        "Ruolo",
        "Sedi abilitate",
      ]),
      feature("staff_availability", "Disponibilita", "Turni, assenze e disponibilita per operatore.", "app/pages/staff_availability.php", "Replica navigabile", Clock3, [
        "Turni settimanali",
        "Ferie",
        "Override disponibilita",
      ]),
      feature("hours", "Orari", "Orari sede, chiusure e aperture straordinarie.", "app/pages/hours.php", "Replica navigabile", Clock3, [
        "Orari settimanali",
        "Chiusure",
        "Eccezioni",
      ]),
    ],
  },
  {
    title: "Impostazioni",
    items: [
      feature("business_profile", "Profilo attivita", "Branding, descrizione, contatti e marketplace.", "app/pages/business_profile.php", "Replica navigabile", Store, [
        "Branding",
        "Descrizione pubblica",
        "Visibilita marketplace",
      ]),
      feature("locations", "Sedi", "Gestione sedi, visibilita e booking per location.", "app/pages/locations.php", "Replica navigabile", MapPin, [
        "Indirizzi",
        "Canali abilitati",
        "Eliminazione protetta",
      ]),
      feature("consent_modules", "Moduli consenso", "Moduli GDPR e consensi informati configurabili.", "app/pages/consent_modules.php", "Analizzato", ShieldCheck, [
        "PDF privacy",
        "Moduli aggiuntivi",
        "Firma cliente",
      ]),
      feature("accessibility", "Accessibilita", "Email accesso, verifica e cambio password.", "app/pages/accessibility.php", "Analizzato", Accessibility, [
        "Email account",
        "Verifica email",
        "Password",
      ]),
      feature("roles", "Ruoli", "Permessi staff e profili di accesso.", "app/pages/roles.php", "Replica navigabile", KeyRound, [
        "Permessi granulari",
        "Ruoli staff",
        "Ereditarieta legacy",
      ]),
      feature("automation", "Automazione", "Reminder, SMS, scadenze fidelity e notifiche automatiche.", "app/pages/automation.php", "Replica navigabile", Bot, [
        "Reminder appuntamenti",
        "SMS automatici",
        "Alert scadenze",
      ]),
      feature("reports", "Report", "Analisi vendite, appuntamenti, clienti, costi e commissioni.", "app/pages/reports.php", "Replica navigabile", BarChart3, [
        "Range temporali",
        "Performance servizi",
        "Margini e costi",
      ]),
      feature("booking", "Booking", "Configurazione booking pubblico e wizard cliente.", "app/pages/booking.php", "Replica navigabile", BookOpenCheck, [
        "Gate cliente",
        "Scelta sede e servizi",
        "Coupon, GiftCard e credito",
      ]),
      feature("marketplace", "Marketplace", "Pubblicazione tenant sul marketplace e scheda pubblica.", "app/pages/marketplace.php", "Replica navigabile", Store, [
        "Scheda pubblica",
        "Servizi evidenza",
        "Link booking",
      ]),
    ],
  },
];

const allFeatures = featureGroups.flatMap((group) => group.items);
const defaultFeatureId = "dashboard";
const emptyManageUser: ManagementUser = {
  id: 0,
  name: "",
  email: "",
  role: "staff",
  perms: [],
  currentLocationId: 0,
  needsLocationSelection: false,
  locationIds: [],
};

export function ManagementApp({
  initialSection = defaultFeatureId,
  currentUser = emptyManageUser,
  tenantSlug = "",
}: {
  initialSection?: string;
  currentUser?: ManagementUser;
  tenantSlug?: string;
}) {
  const activeUser = useMemo(() => ({
    ...emptyManageUser,
    ...currentUser,
    role: normalizeManagementRole(currentUser.role),
    perms: currentUser.perms ?? [],
  }), [currentUser]);
  const userIsAdmin = activeUser.role === "admin";
  const visibleFeatureGroups = useMemo(() => {
    if (userIsAdmin) return featureGroups;
    return featureGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => can(activeUser.perms, permissionForFeature(item.id))),
      }))
      .filter((group) => group.items.length > 0);
  }, [activeUser.perms, userIsAdmin]);
  const visibleFeatures = useMemo(() => visibleFeatureGroups.flatMap((group) => group.items), [visibleFeatureGroups]);
  const normalizedInitial = visibleFeatures.some((featureItem) => featureItem.id === initialSection)
    ? initialSection
    : visibleFeatures[0]?.id ?? defaultFeatureId;
  const initialLocationId = currentUser.currentLocationId && currentUser.currentLocationId > 0
    ? currentUser.currentLocationId
    : 0;
  const todayDate = todayIso();
  const [activeSection, setActiveSection] = useState(normalizedInitial);
  const [navQuery, setNavQuery] = useState("");
  const [locationOptions, setLocationOptions] = useState<Location[]>([]);
  const [locationGateRequired, setLocationGateRequired] = useState(Boolean(currentUser.needsLocationSelection && initialLocationId <= 0));
  const [locationFeedback, setLocationFeedback] = useState("");
  const [appointments, setAppointments] = useState<AppointmentWithMeta[]>([]);
  const [dashboardData, setDashboardData] = useState<DashboardPayload>(() => emptyDashboardData());
  const [quickServiceOptions, setQuickServiceOptions] = useState<string[]>([]);
  const [quickOperatorOptions, setQuickOperatorOptions] = useState<string[]>([]);
  const [quickService, setQuickService] = useState("");
  const [quickOperator, setQuickOperator] = useState("");
  const [quickSlot, setQuickSlot] = useState("15:30");
  const [quickClient, setQuickClient] = useState("");
  const [quickLocationId, setQuickLocationId] = useState(initialLocationId);
  const [quickError, setQuickError] = useState("");
  const [availableSlots, setAvailableSlots] = useState<SlotAvailability[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadShellData() {
      try {
        const [dashboardResponse, appointmentsResponse, locationsResponse, servicesResponse] = await Promise.all([
          fetch("/api/manage/dashboard"),
          fetch("/api/manage/appointments"),
          fetch("/api/manage/locations"),
          fetch("/api/manage/services"),
        ]);
        const dashboard = await dashboardResponse.json();
        const appointmentData = await appointmentsResponse.json();
        const locationData = await locationsResponse.json();
        const serviceData = await servicesResponse.json() as ManageServicePayload;
        if (cancelled) return;
        if (dashboard.ok) setDashboardData(dashboard);
        if (appointmentData.ok) setAppointments(appointmentData.appointments ?? []);
        if (locationData.ok && locationData.locations?.length) {
          const nextLocations = locationData.locations as Location[];
          setLocationOptions(nextLocations);
          setLocationGateRequired(Boolean(locationData.needsLocationSelection));
          setQuickLocationId((current) => {
            if (current > 0 && nextLocations.some((location) => location.id === current)) return current;
            const currentFromSession = Number(locationData.currentLocationId ?? 0);
            if (currentFromSession > 0 && nextLocations.some((location) => location.id === currentFromSession)) return currentFromSession;
            return nextLocations.length === 1 ? nextLocations[0]?.id ?? 0 : 0;
          });
        }
        if (serviceData.ok) {
          const serviceNames = (serviceData.services ?? []).filter((service) => service.isActive).map((service) => service.name).filter(Boolean);
          const staffNames = (serviceData.staff ?? []).filter((staff) => staff.isActive).map((staff) => staff.fullName).filter(Boolean);
          setQuickServiceOptions(serviceNames);
          setQuickOperatorOptions(staffNames);
          setQuickService((current) => current || (serviceNames[0] ?? ""));
          setQuickOperator((current) => current || (staffNames[0] ?? ""));
        }
      } catch {
        setQuickError("Dati gestionale non disponibili.");
      }
    }

    void loadShellData();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeFeature =
    visibleFeatures.find((featureItem) => featureItem.id === activeSection) ?? visibleFeatures[0] ?? allFeatures[0];

  const filteredGroups = useMemo(() => {
    const query = navQuery.trim().toLowerCase();
    if (!query) return visibleFeatureGroups;

    return visibleFeatureGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          [item.label, item.subtitle, item.source, group.title]
            .join(" ")
            .toLowerCase()
            .includes(query),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [navQuery, visibleFeatureGroups]);

  useEffect(() => {
    const serviceName = quickService.trim();
    if (!serviceName) return;

    let cancelled = false;
    const params = new URLSearchParams({
      action: "availability",
      date: todayDate,
      service_name: serviceName,
    });
    if (quickOperator.trim()) params.set("staff_name", quickOperator.trim());
    if (quickLocationId > 0) params.set("location_id", String(quickLocationId));

    fetch(`/api/manage/appointments?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ ok?: boolean; error?: string; slots?: SlotAvailability[] }>)
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) {
          setQuickError(data.error ?? "Disponibilita non caricata.");
          setAvailableSlots([]);
          return;
        }
        setAvailableSlots(data.slots ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setQuickError("Disponibilita non caricata.");
          setAvailableSlots([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [todayDate, quickLocationId, quickOperator, quickService]);

  const effectiveQuickSlot = useMemo(() => {
    const currentIsAvailable = availableSlots.some((slot) => slot.time === quickSlot && slot.available);
    const firstAvailable = availableSlots.find((slot) => slot.available);

    return currentIsAvailable ? quickSlot : (firstAvailable?.time ?? quickSlot);
  }, [availableSlots, quickSlot]);

  const runtimeStatus = useMemo(
    () => ({
      landingPage: landingPageForPermissions(activeUser.perms),
      locationGate: locationGateRequired || (locationOptions.length > 1 && quickLocationId <= 0)
        ? "Selezione richiesta"
        : "Sede valida",
      sessionSuffix: tenantSessionSuffix(tenantSlug),
      availableSlotCount: availableSlots.filter((slot) => slot.available).length,
    }),
    [activeUser.perms, availableSlots, locationGateRequired, locationOptions.length, quickLocationId, tenantSlug],
  );

  async function addQuickBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuickError("");

    try {
      if (locationGateRequired && quickLocationId <= 0) {
        setQuickError("Seleziona una sede operativa.");
        return;
      }
      const data = await postManageApi<{ appointment?: AppointmentWithMeta; appointments?: AppointmentWithMeta[] }>("/api/manage/appointments", {
        client_name: quickClient,
        service_name: quickService,
        staff_name: quickOperator,
        time: effectiveQuickSlot,
        date: todayDate,
        location_id: quickLocationId > 0 ? String(quickLocationId) : "",
      });
      if (data.error) {
        setQuickError(data.error);
        return;
      }

      if (data.appointments) setAppointments(data.appointments);
      else if (data.appointment) setAppointments((current) => [...current, data.appointment as AppointmentWithMeta]);
      setQuickClient("");
      setActiveSection("appointments");
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : "Prenotazione non disponibile.");
    }
  }

  function selectOperationalLocation(locationId: number) {
    setQuickLocationId(locationId);
    setLocationGateRequired(locationId <= 0);
    setLocationFeedback("");
    if (locationId <= 0) return;

    void fetch("/api/manage/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: locationId }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) {
          setLocationFeedback(data.error ?? "Sede non aggiornata.");
          setLocationGateRequired(true);
          return;
        }
        setLocationFeedback(`Sede attiva: ${data.location?.name ?? "selezionata"}`);
        setLocationGateRequired(false);
      })
      .catch(() => {
        setLocationFeedback("Sede non aggiornata.");
        setLocationGateRequired(true);
      });
  }

  async function updateStatus(id: number, status: AppointmentStatus) {
    const data = await postManageApi<{ appointment?: AppointmentWithMeta; appointments?: AppointmentWithMeta[] }>("/api/manage/appointments", {
      action: "status",
      id: String(id),
      status,
    });
    if (data.error) {
      setQuickError(data.error);
      return;
    }
    if (data.appointments) setAppointments(data.appointments);
    else if (data.appointment) setAppointments((current) => current.map((appointment) => (appointment.id === id ? data.appointment as AppointmentWithMeta : appointment)));
  }

  return (
    <main className="min-h-screen bg-[#eef4fb] text-[#17211d]">
      <div className="grid min-h-screen lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-b border-[#242742] bg-[#191b32] text-white lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-4">
            <Link className="flex min-w-0 items-center gap-3" href={tenantSlug ? `/${encodeURIComponent(tenantSlug)}/dashboard` : "/manage/login"}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#5b62d6] text-sm font-bold text-white">
                B
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">BeautySuite</span>
                <span className="block truncate text-xs text-slate-200">{tenantSlug || "Gestionale"}</span>
              </span>
            </Link>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/10 text-slate-50 transition hover:bg-white/20"
              title="Comprimi menu"
              type="button"
            >
              <ChevronDown size={16} aria-hidden />
            </button>
          </div>

          <div className="px-3 py-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-200/70" size={16} aria-hidden />
              <input
                className="h-10 w-full rounded-md border border-white/10 bg-white/10 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-200/60 focus:border-white/40"
                placeholder="Cerca funzione"
                value={navQuery}
                onChange={(event) => setNavQuery(event.target.value)}
              />
            </label>
          </div>

          <nav className="max-h-[calc(100vh-137px)] overflow-y-auto px-2 pb-5">
            {filteredGroups.map((group) => (
              <div className="mb-4" key={group.title}>
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-200/70">
                  {group.title}
                </p>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeFeature.id === item.id;

                    return (
                      <button
                        className={`flex min-h-10 w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition ${
                          isActive
                            ? "bg-[#314563] text-white shadow-sm"
                            : "text-slate-50 hover:bg-white/10"
                        }`}
                        key={item.id}
                        type="button"
                        onClick={() => setActiveSection(item.id)}
                      >
                        <Icon className="shrink-0" size={17} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <section className="min-w-0">
          <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  Gestionale tenant
                </p>
                <h1 className="mt-1 truncate text-2xl font-semibold text-[#17211d]">{activeFeature.label}</h1>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-[#00a86b] px-3 text-sm font-semibold text-white transition hover:bg-[#008f5c]"
                  type="button"
                  onClick={() => setActiveSection("appointments")}
                >
                  <Plus size={17} aria-hidden />
                  Prenotazione
                </button>
                <button
                  aria-label="Calendario"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 bg-white text-[#173262] transition hover:border-[#173262]"
                  title="Calendario"
                  type="button"
                  onClick={() => setActiveSection("calendar")}
                >
                  <CalendarDays size={17} aria-hidden />
                </button>
                <button
                  aria-label="Pagamenti"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 bg-white text-[#173262] transition hover:border-[#173262]"
                  title="Pagamenti"
                  type="button"
                  onClick={() => setActiveSection("pos")}
                >
                  <CreditCard size={17} aria-hidden />
                </button>
                <button
                  aria-label="Preventivi"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 bg-white text-[#173262] transition hover:border-[#173262]"
                  title="Preventivi"
                  type="button"
                  onClick={() => setActiveSection("quotes")}
                >
                  <FileSignature size={17} aria-hidden />
                </button>
                <button
                  aria-label="Notifiche"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 bg-white text-[#173262] transition hover:border-[#173262]"
                  title="Notifiche"
                  type="button"
                  onClick={() => setActiveSection("notifications")}
                >
                  <Bell size={17} aria-hidden />
                </button>
                <button
                  aria-label="Accessibilita"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 bg-white text-[#173262] transition hover:border-[#173262]"
                  title="Accessibilita"
                  type="button"
                  onClick={() => setActiveSection("accessibility")}
                >
                  <UserCog size={17} aria-hidden />
                </button>
                <Link
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold transition hover:border-zinc-800"
                  href={tenantSlug ? `/attivita/${encodeURIComponent(tenantSlug)}` : "/attivita"}
                >
                  Scheda pubblica
                  <Store size={17} aria-hidden />
                </Link>
              </div>
            </div>
          </header>

          <div className="px-4 py-5 sm:px-6 lg:px-8">
            {locationGateRequired ? (
              <LocationGatePanel
                feedback={locationFeedback}
                locations={locationOptions}
                onSelect={selectOperationalLocation}
              />
            ) : null}

            {activeFeature.id === "dashboard" ? (
              <DashboardView
                appointments={appointments}
                dashboardData={dashboardData}
                onOpenSection={setActiveSection}
                runtimeStatus={runtimeStatus}
              />
            ) : null}

            {activeFeature.id === "calendar" ? <CalendarView appointments={appointments} locations={locationOptions} tenantSlug={tenantSlug} /> : null}

            {activeFeature.id === "appointments" || activeFeature.id === "appointments_plan" ? (
              <AgendaView
                addQuickBooking={addQuickBooking}
                appointments={appointments}
                quickClient={quickClient}
                quickOperator={quickOperator}
                quickOperatorOptions={quickOperatorOptions}
                quickService={quickService}
                quickServiceOptions={quickServiceOptions}
                quickSlot={effectiveQuickSlot}
                quickError={quickError}
                quickLocationId={quickLocationId}
                slots={availableSlots}
                locations={locationOptions}
                setQuickClient={setQuickClient}
                setQuickLocationId={selectOperationalLocation}
                setQuickOperator={setQuickOperator}
                setQuickService={setQuickService}
                setQuickSlot={setQuickSlot}
                updateStatus={updateStatus}
              />
            ) : null}

            {activeFeature.id === "clients" ? <ClientsView /> : null}

            {isServiceSection(activeFeature.id) ? (
              <ServicesView key={activeFeature.id} section={activeFeature.id} tenantSlug={tenantSlug} />
            ) : null}

            {isProductSection(activeFeature.id) ? (
              <ProductsView key={activeFeature.id} section={activeFeature.id} tenantSlug={tenantSlug} />
            ) : null}

            {isCostSection(activeFeature.id) ? (
              <CostsView key={activeFeature.id} section={activeFeature.id} tenantSlug={tenantSlug} />
            ) : null}

            {activeFeature.id === "pos" ? <PosView tenantSlug={tenantSlug} onOpenSection={setActiveSection} /> : null}

            {activeFeature.id === "pos_history" ? <PosView historyOnly tenantSlug={tenantSlug} onOpenSection={setActiveSection} /> : null}

            {activeFeature.id === "reports" ? <ReportsView /> : null}

            {isBusinessSettingsSection(activeFeature.id) ? (
              <BusinessSettingsView key={activeFeature.id} section={activeFeature.id} tenantSlug={tenantSlug} />
            ) : null}

            {isResourceSection(activeFeature.id) ? (
              <ResourceSettingsView key={activeFeature.id} section={activeFeature.id} tenantSlug={tenantSlug} />
            ) : null}

            {!isCostSection(activeFeature.id) && !isProductSection(activeFeature.id) && !isServiceSection(activeFeature.id) && !isBusinessSettingsSection(activeFeature.id) && !isResourceSection(activeFeature.id) && isOperationsSection(activeFeature.id) ? (
              <OperationsView section={activeFeature.id} />
            ) : null}

            {!["dashboard", "calendar", "appointments", "appointments_plan", "clients", "services", "products", "pos", "pos_history", "reports"].includes(activeFeature.id) && !isCostSection(activeFeature.id) && !isProductSection(activeFeature.id) && !isServiceSection(activeFeature.id) && !isOperationsSection(activeFeature.id) && !isResourceSection(activeFeature.id) && !isBusinessSettingsSection(activeFeature.id) ? (
              <FeatureDetail featureItem={activeFeature} onOpenSection={setActiveSection} />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function LocationGatePanel({
  feedback,
  locations,
  onSelect,
}: {
  feedback: string;
  locations: Location[];
  onSelect: (locationId: number) => void;
}) {
  return (
    <section className="mb-5 rounded-md border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MapPin className="text-amber-700" size={18} aria-hidden />
            <h2 className="text-lg font-semibold">Seleziona sede operativa</h2>
          </div>
          <p className="mt-1 text-sm text-zinc-600">La sessione gestionale usera questa sede per agenda, disponibilita e azioni rapide.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {locations.map((location) => (
            <button
              className="inline-flex h-10 items-center rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold transition hover:border-amber-700 hover:text-amber-800"
              key={location.id}
              type="button"
              onClick={() => onSelect(location.id)}
            >
              {location.name}
            </button>
          ))}
        </div>
      </div>
      {feedback ? <p className="mt-3 text-sm font-medium text-amber-800">{feedback}</p> : null}
    </section>
  );
}

function DashboardView({
  appointments,
  dashboardData,
  onOpenSection,
  runtimeStatus,
}: {
  appointments: AppointmentWithMeta[];
  dashboardData: DashboardPayload;
  onOpenSection: (id: string) => void;
  runtimeStatus: {
    landingPage: string;
    locationGate: string;
    sessionSuffix: string;
    availableSlotCount: number;
  };
}) {
  return (
    <div className="space-y-5">
      <section className="grid gap-4 md:grid-cols-3">
        {dashboardData.stats.map((stat) => (
          <article className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" key={stat.label}>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
                {stat.label.includes("Client") ? <Users size={19} aria-hidden /> : stat.label.includes("Appunt") ? <CalendarDays size={19} aria-hidden /> : <BadgeEuro size={19} aria-hidden />}
              </span>
              <div>
                <p className="text-sm text-zinc-500">{stat.label}</p>
                <p className="text-2xl font-semibold">{stat.value}</p>
              </div>
            </div>
            <p className="mt-2 text-sm text-zinc-600">{stat.detail}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-md border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <BarChart3 size={18} aria-hidden className="text-blue-700" />
              <h2 className="font-semibold">Statistica settimanale</h2>
            </div>
          </div>
          <div className="p-4">
            <div className="grid gap-3 md:grid-cols-4">
              {dashboardData.weekly.metrics.map((metric) => (
                <div className="border-r border-zinc-200 last:border-r-0 md:pr-4" key={metric.label}>
                  <p className="text-sm text-zinc-500">{metric.label}</p>
                  <p className="text-2xl font-semibold">{metric.value}</p>
                  <p className={`text-sm ${metric.tone === "bad" ? "text-red-600" : metric.tone === "good" ? "text-emerald-700" : "text-zinc-500"}`}>{metric.detail}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 flex items-center justify-between text-sm text-zinc-600">
              <p>Andamento ricavi giornaliero</p>
              <p>{dashboardData.weekly.range}</p>
            </div>
            <WeeklyRevenueChart series={dashboardData.weekly.series} />
          </div>
        </div>

        <aside className="space-y-5">
          <DashboardAppointmentsPanel
            appointments={dashboardData.appointments.upcoming}
            onOpenCalendar={() => onOpenSection("calendar")}
          />
          <DashboardNotificationsPanel notifications={dashboardData.notifications} />
          <DashboardCostsPanel costs={dashboardData.costs} onOpenCosts={() => onOpenSection("costs")} />
        </aside>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <TodayPanel appointments={dashboardData.appointments.today.length ? dashboardData.appointments.today : appointments} />
        <StatusPanel
          title="Runtime tenant"
          items={[
            { label: "Landing", value: runtimeStatus.landingPage, detail: "ordine Auth::landingPage" },
            { label: "Sedi", value: runtimeStatus.locationGate, detail: `sessione ${runtimeStatus.sessionSuffix}` },
            { label: "Slot rapidi", value: `${runtimeStatus.availableSlotCount} liberi`, detail: "motore disponibilita e hold" },
          ]}
        />
      </section>
    </div>
  );
}

function WeeklyRevenueChart({ series }: { series: DashboardPayload["weekly"]["series"] }) {
  const maxRevenue = Math.max(1, ...series.map((point) => point.revenue));
  const width = 700;
  const height = 170;
  const padding = 24;
  const points = series.map((point, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(1, series.length - 1);
    const y = height - padding - (point.revenue / maxRevenue) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="mt-4 overflow-x-auto">
      <svg className="min-w-[700px]" height={height + 40} role="img" viewBox={`0 0 ${width} ${height + 40}`} width={width}>
        <title>Andamento ricavi settimanale</title>
        {Array.from({ length: 6 }).map((_, index) => {
          const y = padding + index * ((height - padding * 2) / 5);
          return <line key={index} stroke="#dbe3ee" strokeWidth="1" x1={padding} x2={width - padding} y1={y} y2={y} />;
        })}
        {series.map((point, index) => {
          const x = padding + (index * (width - padding * 2)) / Math.max(1, series.length - 1);
          return (
            <g key={point.date}>
              <line stroke="#edf1f7" strokeWidth="1" x1={x} x2={x} y1={padding} y2={height - padding} />
              <text fill="#28438a" fontSize="12" textAnchor="middle" x={x} y={height + 16}>{point.label}</text>
            </g>
          );
        })}
        <polyline fill="none" points={points} stroke="#315ff4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
        {series.map((point, index) => {
          const x = padding + (index * (width - padding * 2)) / Math.max(1, series.length - 1);
          const y = height - padding - (point.revenue / maxRevenue) * (height - padding * 2);
          return <circle cx={x} cy={y} fill="#315ff4" key={point.date} r="4" />;
        })}
      </svg>
    </div>
  );
}

function DashboardAppointmentsPanel({
  appointments,
  onOpenCalendar,
}: {
  appointments: AppointmentWithMeta[];
  onOpenCalendar: () => void;
}) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock3 size={18} aria-hidden className="text-blue-700" />
          <h2 className="font-semibold">Prossimi appuntamenti</h2>
        </div>
        <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold" type="button" onClick={onOpenCalendar}>
          <CalendarDays size={15} aria-hidden />
          Calendario
        </button>
      </div>
      <div className="divide-y divide-zinc-100">
        {appointments.length ? appointments.slice(0, 4).map((appointment) => (
          <AppointmentRow appointment={appointment} key={appointment.id} />
        )) : (
          <p className="px-4 py-8 text-center text-sm text-blue-800">Nessun appuntamento in arrivo</p>
        )}
      </div>
    </section>
  );
}

function DashboardNotificationsPanel({ notifications }: { notifications: NotificationItem[] }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <Bell size={18} aria-hidden className="text-blue-700" />
        <h2 className="font-semibold">Avvisi</h2>
      </div>
      <div className="space-y-3 p-4 text-sm">
        {notifications.length ? notifications.map((notification) => (
          <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3" key={notification.id}>
            <p className="font-semibold">{notification.title}</p>
            <p className="mt-1 text-zinc-600">{notification.message}</p>
          </div>
        )) : <p className="text-blue-800">Nessun avviso.</p>}
      </div>
    </section>
  );
}

function DashboardCostsPanel({
  costs,
  onOpenCosts,
}: {
  costs: DashboardPayload["costs"];
  onOpenCosts: () => void;
}) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={18} aria-hidden className="text-blue-700" />
          <h2 className="font-semibold">Scadenziario e Costi</h2>
        </div>
        <button className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-semibold" type="button" onClick={onOpenCosts}>
          Apri
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4 p-4 text-sm">
        <div>
          <p className="text-blue-800">Scaduti</p>
          <p className="mt-1 text-2xl font-semibold text-red-600">{formatCurrency(costs.overdueAmount)}</p>
          <p className="text-blue-800">{costs.overdueCount} voci</p>
        </div>
        <div>
          <p className="text-blue-800">Questo mese</p>
          <p className="mt-1 text-2xl font-semibold">{formatCurrency(costs.monthAmount)}</p>
          <p className="text-blue-800">{costs.monthCount} voci</p>
        </div>
      </div>
    </section>
  );
}

function CalendarView({ appointments, locations, tenantSlug }: { appointments: AppointmentWithMeta[]; locations: Location[]; tenantSlug: string }) {
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [calendarData, setCalendarData] = useState<CalendarPayload | null>(null);
  const [calendarError, setCalendarError] = useState("");
  const [noteId, setNoteId] = useState(0);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const visibleAppointments = calendarData?.appointments ?? appointments.filter((appointment) => appointment.date === selectedDate);
  const staff = calendarData?.staff.length
    ? calendarData.staff
    : Array.from(new Set(visibleAppointments.map((appointment) => appointment.operator).filter(Boolean))).map((name, index) => ({
      id: index + 1,
      name,
      email: "",
      color: ["#0f766e", "#2563eb", "#7c3aed", "#be123c"][index % 4] ?? "#0f766e",
      photoPath: "",
    }));
  const activeStaff = staff;
  const hours = calendarHours(visibleAppointments);
  const dayNotes = (calendarData?.notes ?? []).filter((note) => note.noteDate === selectedDate);

  useEffect(() => {
    let cancelled = false;

    async function loadCalendar() {
      try {
        const params = new URLSearchParams({
          date: selectedDate,
          start: selectedDate,
          end: addDaysLocal(selectedDate, 1),
        });
        const response = await fetch(`/api/manage/calendar?${params.toString()}`, { cache: "no-store" });
        const data = await response.json() as CalendarPayload;
        if (cancelled) return;
        if (!data.ok) throw new Error(data.error ?? "Calendario non disponibile.");
        setCalendarData(data);
        setCalendarError("");
      } catch (error) {
        if (!cancelled) setCalendarError(error instanceof Error ? error.message : "Calendario non disponibile.");
      }
    }

    void loadCalendar();
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  function selectNote(note: CalendarNote) {
    setNoteId(note.id);
    setNoteTitle(note.title);
    setNoteText(note.noteText);
  }

  function resetNoteForm() {
    setNoteId(0);
    setNoteTitle("");
    setNoteText("");
  }

  async function reloadCalendar() {
    const params = new URLSearchParams({ date: selectedDate, start: selectedDate, end: addDaysLocal(selectedDate, 1) });
    const response = await fetch(`/api/manage/calendar?${params.toString()}`, { cache: "no-store" });
    const data = await response.json() as CalendarPayload;
    if (data.ok) setCalendarData(data);
  }

  async function saveNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCalendarError("");
    try {
      const response = await fetch("/api/manage/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "note_save",
          id: noteId ? String(noteId) : "",
          note_date: selectedDate,
          title: noteTitle,
          note_text: noteText,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? "Nota non salvata.");
      resetNoteForm();
      await reloadCalendar();
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : "Nota non salvata.");
    }
  }

  async function deleteNote() {
    if (!noteId) return;
    setCalendarError("");
    try {
      const response = await fetch("/api/manage/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note_delete", id: String(noteId) }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? "Nota non eliminata.");
      resetNoteForm();
      await reloadCalendar();
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : "Nota non eliminata.");
    }
  }

  async function moveStaff(staffId: number, direction: -1 | 1) {
    const order = activeStaff.map((person) => person.id);
    const index = order.indexOf(staffId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    const nextOrder = [...order];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    setCalendarData((current) => current ? { ...current, staff: orderCalendarStaff(current.staff, nextOrder), staffOrder: nextOrder } : current);
    await fetch("/api/manage/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_calendar_day_staff_order", order: JSON.stringify(nextOrder) }),
    }).catch(() => undefined);
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Calendario operativo</h2>
            <p className="mt-1 text-sm text-zinc-600">Agenda, operatori, note e preferenze sincronizzate dal DB.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
            {(calendarData?.locations.length ? calendarData.locations : locations.filter((location) => location.tenantSlug === tenantSlug || !location.tenantSlug)).map((location) => (
              <span className="rounded-md border border-zinc-200 px-2 py-2 text-xs font-semibold text-zinc-600" key={location.id}>
                {location.name}
              </span>
            ))}
          </div>
        </div>

        {calendarError ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{calendarError}</div>
        ) : null}

        <div className="mt-5 overflow-x-auto">
          <div className="min-w-[760px]">
            <div
              className="grid border-b border-zinc-200 text-sm font-semibold text-zinc-600"
              style={{ gridTemplateColumns: `72px repeat(${activeStaff.length}, minmax(140px, 1fr))` }}
            >
              <div className="p-2">Ora</div>
              {activeStaff.map((person, index) => (
                <div className="border-l border-zinc-200 p-2" key={person.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: person.color }} />
                      {person.name}
                    </span>
                    <span className="flex gap-1">
                      <button className="rounded border border-zinc-200 px-1 text-xs" disabled={index === 0} type="button" onClick={() => void moveStaff(person.id, -1)}>
                        &lt;
                      </button>
                      <button className="rounded border border-zinc-200 px-1 text-xs" disabled={index === activeStaff.length - 1} type="button" onClick={() => void moveStaff(person.id, 1)}>
                        &gt;
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {hours.map((hour) => (
              <div
                className="grid min-h-16 border-b border-zinc-100"
                key={hour}
                style={{ gridTemplateColumns: `72px repeat(${activeStaff.length}, minmax(140px, 1fr))` }}
              >
                <div className="p-2 text-sm font-semibold text-zinc-500">{hour}</div>
                {activeStaff.map((person) => {
                  const slotAppointments = visibleAppointments.filter((item) => item.time === hour && staffMatchesAppointment(person.name, item.operator));
                  return (
                    <div className="border-l border-zinc-100 p-2" key={`${hour}-${person.id}`}>
                      {slotAppointments.map((appointment) => (
                        <div className="mb-2 rounded-md p-2 text-xs text-white" key={appointment.id} style={{ backgroundColor: person.color }}>
                          <p className="font-semibold">{appointment.client}</p>
                          <p className="mt-1">{appointment.service}</p>
                          <p className="mt-1 opacity-90">{appointment.status}</p>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Note calendario</h2>
              <p className="mt-1 text-sm text-zinc-600">{formatItalianDate(selectedDate)}</p>
            </div>
            <span className="rounded-md bg-emerald-100 px-2 py-1 text-sm font-semibold text-emerald-800">{dayNotes.length}</span>
          </div>

          <form className="mt-4 space-y-3" onSubmit={saveNote}>
            <input
              className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              maxLength={190}
              placeholder="Titolo opzionale"
              value={noteTitle}
              onChange={(event) => setNoteTitle(event.target.value)}
            />
            <textarea
              className="min-h-28 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-emerald-700"
              placeholder="Scrivi qui la nota del giorno"
              required
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
            />
            <div className="flex gap-2">
              <button className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-[#191b32] px-3 text-sm font-semibold text-white">
                <Check size={16} aria-hidden />
                {noteId ? "Aggiorna" : "Salva nota"}
              </button>
              <button className="h-10 rounded-md border border-zinc-200 px-3 text-sm font-semibold" type="button" onClick={resetNoteForm}>
                Nuova
              </button>
              {noteId ? (
                <button className="h-10 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700" type="button" onClick={() => void deleteNote()}>
                  Elimina
                </button>
              ) : null}
            </div>
          </form>

          <div className="mt-4 divide-y divide-zinc-100">
            {dayNotes.map((note) => (
              <button className="block w-full py-3 text-left" key={note.id} type="button" onClick={() => selectNote(note)}>
                <p className="font-semibold">{note.title || "Nota"}</p>
                <p className="mt-1 line-clamp-2 text-sm text-zinc-600">{note.noteText}</p>
                <p className="mt-1 text-xs text-zinc-400">{note.updatedAtLabel || note.createdAtLabel}</p>
              </button>
            ))}
            {!dayNotes.length ? <p className="py-4 text-sm text-zinc-600">Nessuna nota per questo giorno.</p> : null}
          </div>
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Copertura giorno</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-zinc-500">Appuntamenti</p>
              <p className="text-2xl font-semibold">{visibleAppointments.length}</p>
            </div>
            <div>
              <p className="text-zinc-500">Operatori</p>
              <p className="text-2xl font-semibold">{activeStaff.length}</p>
            </div>
            <div>
              <p className="text-zinc-500">Servizi</p>
              <p className="text-2xl font-semibold">{calendarData?.services.length ?? 0}</p>
            </div>
            <div>
              <p className="text-zinc-500">Origine</p>
              <p className="font-semibold">{calendarData?.sourceMode ?? "database"}</p>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

function AgendaView({
  addQuickBooking,
  appointments,
  locations,
  quickClient,
  quickError,
  quickLocationId,
  quickOperator,
  quickOperatorOptions,
  quickService,
  quickServiceOptions,
  quickSlot,
  slots,
  setQuickClient,
  setQuickLocationId,
  setQuickOperator,
  setQuickService,
  setQuickSlot,
  updateStatus,
}: {
  addQuickBooking: (event: React.FormEvent<HTMLFormElement>) => void;
  appointments: AppointmentWithMeta[];
  locations: Location[];
  quickClient: string;
  quickError: string;
  quickLocationId: number;
  quickOperator: string;
  quickOperatorOptions: string[];
  quickService: string;
  quickServiceOptions: string[];
  quickSlot: string;
  slots: SlotAvailability[];
  setQuickClient: (value: string) => void;
  setQuickLocationId: (value: number) => void;
  setQuickOperator: (value: string) => void;
  setQuickService: (value: string) => void;
  setQuickSlot: (value: string) => void;
  updateStatus: (id: number, status: AppointmentStatus) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Agenda di oggi</h2>
            <p className="mt-1 text-sm text-zinc-600">Stati e azioni principali replicate dal gestionale.</p>
          </div>
          <ListChecks size={20} aria-hidden className="text-emerald-700" />
        </div>
        <div className="divide-y divide-zinc-100">
          {appointments.map((appointment) => (
            <AppointmentRow appointment={appointment} key={appointment.id} updateStatus={updateStatus} />
          ))}
        </div>
      </section>

      <QuickBookingForm
        addQuickBooking={addQuickBooking}
        locations={locations}
        quickClient={quickClient}
        quickError={quickError}
        quickLocationId={quickLocationId}
        quickOperator={quickOperator}
        quickOperatorOptions={quickOperatorOptions}
        quickService={quickService}
        quickServiceOptions={quickServiceOptions}
        quickSlot={quickSlot}
        slots={slots}
        setQuickClient={setQuickClient}
        setQuickLocationId={setQuickLocationId}
        setQuickOperator={setQuickOperator}
        setQuickService={setQuickService}
        setQuickSlot={setQuickSlot}
      />
    </div>
  );
}

function FeatureDetail({
  featureItem,
  onOpenSection,
}: {
  featureItem: FeatureItem;
  onOpenSection: (id: string) => void;
}) {
  const Icon = featureItem.icon;
  const related = relatedFeatures(featureItem.id);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-5">
        <article className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-100 text-emerald-800">
                  <Icon size={22} aria-hidden />
                </span>
                <div>
                  <h2 className="text-xl font-semibold">{featureItem.label}</h2>
                  <p className="mt-1 text-sm text-zinc-600">{featureItem.subtitle}</p>
                </div>
              </div>
            </div>
            <span className={`inline-flex w-fit rounded-md px-2 py-1 text-xs font-semibold ${stateStyles[featureItem.state]}`}>
              {featureItem.state}
            </span>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {featureItem.records.map((record) => (
              <div className="rounded-md border border-zinc-200 p-3" key={record.label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{record.label}</p>
                <p className="mt-2 text-lg font-semibold">{record.value}</p>
                <p className="mt-1 text-sm text-zinc-600">{record.detail}</p>
              </div>
            ))}
          </div>
        </article>

        <section className="grid gap-4 md:grid-cols-3">
          {featureItem.features.map((item) => (
            <article className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" key={item}>
              <Check className="text-emerald-700" size={18} aria-hidden />
              <h3 className="mt-3 font-semibold">{item}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                Funzione rilevata nel sorgente PHP e pronta per essere collegata a dati persistenti nella replica Next.
              </p>
            </article>
          ))}
        </section>
      </section>

      <aside className="space-y-4">
        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Origine</p>
          <p className="mt-2 break-words font-mono text-sm text-zinc-700">{featureItem.source}</p>
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            Nel PHP questa voce passa dal router tenant `index.php?page=...` e dai permessi di `RolePermissions`.
          </p>
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Collegamenti</p>
          <div className="mt-3 space-y-2">
            {related.map((item) => (
              <button
                className="flex w-full items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-left text-sm transition hover:border-emerald-700 hover:bg-emerald-50"
                key={item.id}
                type="button"
                onClick={() => onOpenSection(item.id)}
              >
                <span>{item.label}</span>
                <ArrowRight size={15} aria-hidden />
              </button>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function TodayPanel({ appointments, compact = false }: { appointments: AppointmentWithMeta[]; compact?: boolean }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Oggi</h2>
        <span className="rounded-md bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
          {appointments.length} slot
        </span>
      </div>
      <div className="divide-y divide-zinc-100">
        {appointments.slice(0, compact ? 3 : appointments.length).map((appointment) => (
          <AppointmentRow appointment={appointment} key={appointment.id} />
        ))}
      </div>
    </section>
  );
}

function AppointmentRow({
  appointment,
  updateStatus,
}: {
  appointment: AppointmentWithMeta;
  updateStatus?: (id: number, status: AppointmentStatus) => void;
}) {
  return (
    <div className="grid gap-3 py-4 md:grid-cols-[78px_minmax(0,1fr)_160px_112px] md:items-center">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Clock3 size={16} aria-hidden className="text-zinc-500" />
        {appointment.time}
      </div>
      <div className="min-w-0">
        <p className="font-semibold">{appointment.client}</p>
        <p className="truncate text-sm text-zinc-600">
          {appointment.service} con {appointment.operator} - {appointment.room}
        </p>
      </div>
      <div>
        <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[appointment.status]}`}>
          {appointment.status}
        </span>
      </div>
      {updateStatus ? (
        <div className="flex gap-2 md:justify-end">
          <button
            aria-label="Segna completato"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 transition hover:border-emerald-600 hover:text-emerald-700"
            title="Completato"
            type="button"
            onClick={() => updateStatus(appointment.id, "Completato")}
          >
            <Check size={16} aria-hidden />
          </button>
          <button
            aria-label="Rimetti in attesa"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 transition hover:border-amber-600 hover:text-amber-700"
            title="In attesa"
            type="button"
            onClick={() => updateStatus(appointment.id, "In attesa")}
          >
            <Clock3 size={16} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QuickBookingForm({
  addQuickBooking,
  locations,
  quickClient,
  quickError,
  quickLocationId,
  quickOperator,
  quickOperatorOptions,
  quickService,
  quickServiceOptions,
  quickSlot,
  slots,
  setQuickClient,
  setQuickLocationId,
  setQuickOperator,
  setQuickService,
  setQuickSlot,
}: {
  addQuickBooking: (event: React.FormEvent<HTMLFormElement>) => void;
  locations: Location[];
  quickClient: string;
  quickError: string;
  quickLocationId: number;
  quickOperator: string;
  quickOperatorOptions: string[];
  quickService: string;
  quickServiceOptions: string[];
  quickSlot: string;
  slots: SlotAvailability[];
  setQuickClient: (value: string) => void;
  setQuickLocationId: (value: number) => void;
  setQuickOperator: (value: string) => void;
  setQuickService: (value: string) => void;
  setQuickSlot: (value: string) => void;
}) {
  const hasAvailableSlots = slots.some((slot) => slot.available);

  return (
    <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={addQuickBooking}>
      <h2 className="text-lg font-semibold">Prenotazione rapida</h2>
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-zinc-600">Cliente</span>
          <input
            className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700"
            placeholder="Nome cliente"
            value={quickClient}
            onChange={(event) => setQuickClient(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-zinc-600">Servizio</span>
          <select
            className="h-11 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-700"
            value={quickService}
            onChange={(event) => setQuickService(event.target.value)}
          >
            {quickServiceOptions.length ? quickServiceOptions.map((service) => (
              <option key={service}>{service}</option>
            )) : <option value="">Nessun servizio disponibile</option>}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-zinc-600">Sede</span>
          <select
            className="h-11 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-700"
            value={quickLocationId}
            onChange={(event) => setQuickLocationId(Number.parseInt(event.target.value, 10))}
          >
            {locations.length > 1 ? <option value={0}>Seleziona sede</option> : null}
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Orario</span>
            <select
              className="h-11 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-700"
              value={quickSlot}
              onChange={(event) => setQuickSlot(event.target.value)}
            >
              {slots.map((slot) => (
                <option disabled={!slot.available} key={slot.time} value={slot.time}>
                  {slot.available ? slot.time : `${slot.time} - occupato`}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Operatore</span>
            <select
              className="h-11 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-700"
              value={quickOperator}
              onChange={(event) => setQuickOperator(event.target.value)}
            >
              <option value="">Nessun operatore</option>
              {quickOperatorOptions.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
          </label>
        </div>
        {quickError ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{quickError}</p>
        ) : null}
        <button
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62] disabled:cursor-not-allowed disabled:bg-zinc-300"
          disabled={!quickService || !hasAvailableSlots}
        >
          <Plus size={17} aria-hidden />
          Inserisci in agenda
        </button>
      </div>
    </form>
  );
}

function ClientsView() {
  const [managedClients, setManagedClients] = useState<ManagedClient[]>([]);
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/manage/clients")
      .then((response) => response.json() as Promise<{ clients?: ManagedClient[] }>)
      .then((data) => {
        if (!cancelled) setManagedClients(data.clients ?? []);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Clienti non caricati.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function createManagedClient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newClientName.trim()) return;

    const data = await postManageApi<{ clients?: ManagedClient[]; error?: string }>("/api/manage/clients", {
      action: "create",
      name: newClientName,
      phone: newClientPhone,
      location_id: "1",
    });

    if (data.clients) setManagedClients(data.clients);
    setFeedback(data.error ?? "Cliente salvato.");
    setNewClientName("");
    setNewClientPhone("");
  }

  async function archiveManagedClient(id: number) {
    const data = await postManageApi<{ clients?: ManagedClient[]; reason?: string; error?: string }>("/api/manage/clients", {
      action: "delete",
      id: String(id),
    });

    if (data.clients) setManagedClients(data.clients);
    setFeedback(data.error ?? data.reason ?? "Cliente aggiornato.");
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Clienti</h2>
          <p className="mt-1 text-sm text-zinc-600">Anagrafiche, note, valore e prossimo appuntamento.</p>
        </div>
        <Users size={20} aria-hidden className="text-emerald-700" />
      </div>
      <form className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_118px]" onSubmit={createManagedClient}>
        <input
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700"
          placeholder="Nuovo cliente"
          value={newClientName}
          onChange={(event) => setNewClientName(event.target.value)}
        />
        <input
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700"
          placeholder="Telefono"
          value={newClientPhone}
          onChange={(event) => setNewClientPhone(event.target.value)}
        />
        <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#007c72] px-3 text-sm font-semibold text-white transition hover:bg-[#006a62]">
          <Plus size={16} aria-hidden />
          Salva
        </button>
      </form>
      {feedback ? <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      <div className="divide-y divide-zinc-100">
        {managedClients.map((client) => (
          <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_140px_140px_180px_92px]" key={client.id}>
            <div className="min-w-0">
              <p className="font-semibold">{client.name}</p>
              <p className="truncate text-sm text-zinc-600">{client.note || client.phone || client.email}</p>
            </div>
            <div>
              <p className="text-sm text-zinc-500">Ultima visita</p>
              <p className="font-medium">{client.lastVisit}</p>
            </div>
            <div>
              <p className="text-sm text-zinc-500">Valore</p>
              <p className="font-medium">{client.value}</p>
            </div>
            <div>
              <p className="text-sm text-zinc-500">Prossimo slot</p>
              <p className="font-medium">{client.next}</p>
            </div>
            <div className="flex items-center md:justify-end">
              <button
                className="h-9 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700"
                type="button"
                onClick={() => archiveManagedClient(client.id)}
              >
                Archivia
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ServicesView({ section, tenantSlug }: { section: string; tenantSlug: string }) {
  const initialTab = serviceTabFromSection(section);
  const [activeTab, setActiveTab] = useState<"services" | "categories" | "recommended">(initialTab);
  const [payload, setPayload] = useState<ManageServicePayload | null>(null);
  const [serviceDraft, setServiceDraft] = useState<ServiceDraft>(() => emptyServiceDraft());
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft>({ id: 0, name: "", imageUrl: "" });
  const [selectedRecommendationServiceId, setSelectedRecommendationServiceId] = useState("");
  const [recommendationIds, setRecommendationIds] = useState<number[]>([]);
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(true);
  const endpoint = `/api/manage/services?slug=${encodeURIComponent(tenantSlug)}&include_inactive=1`;

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((response) => response.json() as Promise<ManageServicePayload>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setPayload(data);
        setServiceDraft((current) => current.id > 0 || current.name ? current : emptyServiceDraft(data));
        const firstService = data.services?.[0];
        if (firstService) {
          setSelectedRecommendationServiceId(String(firstService.id));
          setRecommendationIds(firstService.recommendationIds ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setFeedback("Servizi non caricati.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function postServices(body: Record<string, string>, successMessage: string) {
    const data = await postManageApi<ManageServicePayload>(endpoint, body);
    if (data.error) {
      setFeedback(data.error);
      return data;
    }
    setPayload(data);
    setFeedback(successMessage);
    return data;
  }

  async function saveService(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postServices({
      action: "service_save",
      id: serviceDraft.id ? String(serviceDraft.id) : "0",
      name: serviceDraft.name,
      duration_min: serviceDraft.durationMin,
      price: serviceDraft.price,
      category_id: serviceDraft.categoryId,
      is_active: serviceDraft.isActive ? "1" : "0",
      booking_enabled: serviceDraft.bookingEnabled ? "1" : "0",
      no_operator: serviceDraft.noOperator ? "1" : "0",
      location_ids: serviceDraft.locationIds.join(","),
      cabin_ids: serviceDraft.cabinIds.join(","),
      staff_ids: serviceDraft.staffIds.join(","),
      resources_json: "[]",
    }, serviceDraft.id > 0 ? "Servizio aggiornato." : "Servizio creato.");
    if (!data.error) setServiceDraft(emptyServiceDraft(data));
  }

  async function deleteService(id: number) {
    await postServices({ action: "service_delete", id: String(id) }, "Servizio eliminato.");
  }

  async function saveCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postServices({
      action: "category_save",
      id: categoryDraft.id ? String(categoryDraft.id) : "0",
      name: categoryDraft.name,
      image_url: categoryDraft.imageUrl,
    }, categoryDraft.id > 0 ? "Categoria aggiornata." : "Categoria creata.");
    if (!data.error) setCategoryDraft({ id: 0, name: "", imageUrl: "" });
  }

  async function moveCategory(id: number, direction: "up" | "down") {
    await postServices({ action: "category_move", id: String(id), direction }, "Ordine categorie aggiornato.");
  }

  async function deleteCategory(id: number) {
    await postServices({ action: "category_delete", id: String(id) }, "Categoria eliminata.");
  }

  async function saveCategoryMarketplace(categoryId: number, marketplaceCategoryId: string) {
    await postServices({
      action: "category_marketplace_save",
      category_id: String(categoryId),
      marketplace_category_id: marketplaceCategoryId,
    }, "Mapping marketplace aggiornato.");
  }

  async function saveRecommendations(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRecommendationServiceId) return;
    await postServices({
      action: "recommendations_save",
      service_id: selectedRecommendationServiceId,
      recommended_ids: recommendationIds.join(","),
    }, "Servizi consigliati aggiornati.");
  }

  const servicesList = payload?.services ?? [];
  const categoriesList = payload?.categories ?? [];
  const activeLocations = payload?.locations?.filter((location) => location.isActive) ?? [];
  const activeCabins = payload?.cabins?.filter((cabin) => cabin.isActive) ?? [];
  const activeStaff = payload?.staff?.filter((staff) => staff.isActive) ?? [];
  const taxonomy = payload?.marketplace?.taxonomyCategories ?? [];

  return (
    <section className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <MetricTile label="Servizi" value={String(payload?.stats?.services ?? servicesList.length)} detail="catalogo completo" />
        <MetricTile label="Attivi" value={String(payload?.stats?.activeServices ?? servicesList.filter((service) => service.isActive).length)} detail="prenotabili internamente" />
        <MetricTile label="Categorie" value={String(payload?.stats?.categories ?? categoriesList.length)} detail="ordine booking" />
        <MetricTile label="Consigliati" value={String(payload?.stats?.recommendedLinks ?? 0)} detail="relazioni cross-sell" />
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { id: "services", label: "Catalogo", icon: Scissors },
          { id: "categories", label: "Categorie", icon: Tags },
          { id: "recommended", label: "Consigliati", icon: Sparkles },
        ].map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition ${selected ? "border-emerald-700 bg-emerald-700 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-700 hover:text-emerald-700"}`}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as "services" | "categories" | "recommended")}
            >
              <Icon size={16} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>

      {feedback ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      {loading ? <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 shadow-sm">Caricamento servizi...</p> : null}

      {activeTab === "services" ? (
        <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveService}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{serviceDraft.id > 0 ? "Modifica servizio" : "Nuovo servizio"}</h2>
                <p className="mt-1 text-sm text-zinc-600">Durata, prezzo, sedi, cabine, operatori e booking.</p>
              </div>
              <Scissors size={20} aria-hidden className="text-emerald-700" />
            </div>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Nome
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={serviceDraft.name} onChange={(event) => setServiceDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Durata minuti
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="numeric" value={serviceDraft.durationMin} onChange={(event) => setServiceDraft((draft) => ({ ...draft, durationMin: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Prezzo
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={serviceDraft.price} onChange={(event) => setServiceDraft((draft) => ({ ...draft, price: event.target.value }))} />
                </label>
              </div>
              <label className="grid gap-1 text-sm font-medium">
                Categoria
                <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={serviceDraft.categoryId} onChange={(event) => setServiceDraft((draft) => ({ ...draft, categoryId: event.target.value }))}>
                  <option value="">Non categorizzato</option>
                  {categoriesList.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>
              <CheckList
                items={activeLocations.map((location) => ({ id: location.id, label: location.name }))}
                label="Sedi"
                selectedIds={serviceDraft.locationIds}
                onToggle={(id) => setServiceDraft((draft) => ({ ...draft, locationIds: toggleId(draft.locationIds, id) }))}
              />
              <CheckList
                items={activeCabins.map((cabin) => ({ id: cabin.id, label: cabin.locationId ? `${cabin.name} · sede #${cabin.locationId}` : cabin.name }))}
                label="Cabine"
                selectedIds={serviceDraft.cabinIds}
                onToggle={(id) => setServiceDraft((draft) => ({ ...draft, cabinIds: toggleId(draft.cabinIds, id) }))}
              />
              <label className="inline-flex items-center gap-2 text-sm font-medium">
                <input checked={serviceDraft.noOperator} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setServiceDraft((draft) => ({ ...draft, noOperator: event.target.checked, staffIds: event.target.checked ? [] : draft.staffIds }))} />
                Servizio senza operatore
              </label>
              {!serviceDraft.noOperator ? (
                <CheckList
                  items={activeStaff.map((staff) => ({ id: staff.id, label: staff.fullName }))}
                  label="Operatori"
                  selectedIds={serviceDraft.staffIds}
                  onToggle={(id) => setServiceDraft((draft) => ({ ...draft, staffIds: toggleId(draft.staffIds, id) }))}
                />
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={serviceDraft.isActive} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setServiceDraft((draft) => ({ ...draft, isActive: event.target.checked }))} />
                  Attivo
                </label>
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={serviceDraft.bookingEnabled} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setServiceDraft((draft) => ({ ...draft, bookingEnabled: event.target.checked }))} />
                  Booking online
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setServiceDraft(emptyServiceDraft(payload ?? undefined))}>
                <Plus size={16} aria-hidden />
                Nuovo
              </button>
            </div>
          </form>

          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Catalogo servizi</h2>
              <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-600">{servicesList.length}</span>
            </div>
            <div className="divide-y divide-zinc-100">
              {servicesList.map((service) => (
                <div className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_130px_120px_150px]" key={service.id}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{service.name}</h3>
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${service.isActive ? "bg-emerald-50 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>{service.isActive ? "Attivo" : "Disattivo"}</span>
                      {service.bookingEnabled ? <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">Booking</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-zinc-600">{service.categoryName} · {locationSummary(service.locationIds, payload?.locations ?? [])}</p>
                  </div>
                  <p className="text-sm font-medium">{service.duration}</p>
                  <p className="text-sm font-semibold">{service.price}</p>
                  <div className="flex gap-2 lg:justify-end">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setServiceDraft(serviceToDraft(service, payload ?? undefined))}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50" type="button" onClick={() => deleteService(service.id)}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!servicesList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessun servizio configurato.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "categories" ? (
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveCategory}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{categoryDraft.id > 0 ? "Modifica categoria" : "Nuova categoria"}</h2>
                <p className="mt-1 text-sm text-zinc-600">Nome, immagine e ordine catalogo.</p>
              </div>
              <Tags size={20} aria-hidden className="text-emerald-700" />
            </div>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Nome
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={categoryDraft.name} onChange={(event) => setCategoryDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Immagine URL
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={categoryDraft.imageUrl} onChange={(event) => setCategoryDraft((draft) => ({ ...draft, imageUrl: event.target.value }))} />
              </label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCategoryDraft({ id: 0, name: "", imageUrl: "" })}>
                <Plus size={16} aria-hidden />
                Nuova
              </button>
            </div>
          </form>

          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Categorie servizi</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {categoriesList.map((category) => (
                <div className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_240px_180px]" key={category.id}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{category.name}</h3>
                      {category.isDefault ? <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-600">Default</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-zinc-600">{category.serviceCount} servizi · ordine {category.sortOrder}</p>
                  </div>
                  <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={category.marketplaceCategoryId ?? ""} onChange={(event) => saveCategoryMarketplace(category.id, event.target.value)}>
                    <option value="">Nessuna categoria marketplace</option>
                    {taxonomy.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 transition hover:border-emerald-700 hover:text-emerald-700" title="Sposta su" type="button" onClick={() => moveCategory(category.id, "up")}>
                      <ArrowUp size={16} aria-hidden />
                    </button>
                    <button className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 transition hover:border-emerald-700 hover:text-emerald-700" title="Sposta giu" type="button" onClick={() => moveCategory(category.id, "down")}>
                      <ArrowDown size={16} aria-hidden />
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCategoryDraft({ id: category.id, name: category.name, imageUrl: category.imageUrl })}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={category.isDefault || category.serviceCount > 0} type="button" onClick={() => deleteCategory(category.id)}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!categoriesList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessuna categoria configurata.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "recommended" ? (
        <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveRecommendations}>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Servizi consigliati</h2>
              <p className="mt-1 text-sm text-zinc-600">Collega servizi da proporre durante booking e percorso cliente.</p>
            </div>
            <select
              className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm"
              value={selectedRecommendationServiceId}
              onChange={(event) => {
                const nextServiceId = event.target.value;
                setSelectedRecommendationServiceId(nextServiceId);
                setRecommendationIds(servicesList.find((service) => String(service.id) === nextServiceId)?.recommendationIds ?? []);
              }}
            >
              {servicesList.map((service) => (
                <option key={service.id} value={service.id}>{service.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {servicesList.filter((service) => String(service.id) !== selectedRecommendationServiceId).map((service) => (
              <label className="flex min-h-16 items-start gap-3 rounded-md border border-zinc-200 p-3 text-sm transition hover:border-emerald-700" key={service.id}>
                <input checked={recommendationIds.includes(service.id)} className="mt-1 h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={() => setRecommendationIds((ids) => toggleId(ids, service.id))} />
                <span>
                  <span className="block font-semibold">{service.name}</span>
                  <span className="mt-1 block text-zinc-600">{service.categoryName} · {service.price}</span>
                </span>
              </label>
            ))}
          </div>
          <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
            <Save size={16} aria-hidden />
            Salva consigliati
          </button>
        </form>
      ) : null}
    </section>
  );
}

function CheckList({
  items,
  label,
  selectedIds,
  onToggle,
}: {
  items: Array<{ id: number; label: string }>;
  label: string;
  selectedIds: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <label className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm transition hover:border-emerald-700" key={item.id}>
            <input checked={selectedIds.includes(item.id)} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={() => onToggle(item.id)} />
            <span className="min-w-0 truncate">{item.label}</span>
          </label>
        ))}
        {!items.length ? <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-500">Nessuna voce disponibile.</p> : null}
      </div>
    </div>
  );
}

function serviceTabFromSection(section: string): "services" | "categories" | "recommended" {
  if (section === "service_categories") return "categories";
  if (section === "service_recommendations") return "recommended";
  return "services";
}

function emptyServiceDraft(payload?: ManageServicePayload): ServiceDraft {
  return {
    id: 0,
    name: "",
    durationMin: "60",
    price: "0",
    categoryId: String(payload?.categories?.[0]?.id ?? ""),
    isActive: true,
    bookingEnabled: true,
    noOperator: false,
    locationIds: payload?.locations?.filter((location) => location.isActive).map((location) => location.id) ?? [],
    cabinIds: payload?.cabins?.filter((cabin) => cabin.isActive).slice(0, 1).map((cabin) => cabin.id) ?? [],
    staffIds: payload?.staff?.filter((staff) => staff.isActive).slice(0, 1).map((staff) => staff.id) ?? [],
  };
}

function serviceToDraft(service: ManageServiceItem, payload?: ManageServicePayload): ServiceDraft {
  return {
    id: service.id,
    name: service.name,
    durationMin: String(service.durationMin || 60),
    price: String(service.priceValue ?? 0),
    categoryId: String(service.categoryId ?? ""),
    isActive: service.isActive,
    bookingEnabled: service.bookingEnabled,
    noOperator: service.noOperator,
    locationIds: service.locationIds.length ? service.locationIds : payload?.locations?.filter((location) => location.isActive).map((location) => location.id) ?? [],
    cabinIds: service.cabinIds.length ? service.cabinIds : service.cabinId ? [service.cabinId] : [],
    staffIds: service.staffIds,
  };
}

function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function locationSummary(ids: number[], locations: ServiceLocationItem[]): string {
  if (!ids.length) return "Tutte le sedi";
  const activeIds = locations.filter((location) => location.isActive).map((location) => location.id).sort((a, b) => a - b);
  const sortedIds = [...ids].sort((a, b) => a - b);
  if (activeIds.length && activeIds.length === sortedIds.length && activeIds.every((id, index) => id === sortedIds[index])) return "Tutte le sedi";
  return sortedIds.map((id) => locations.find((location) => location.id === id)?.name ?? `Sede #${id}`).join(", ");
}

function ProductsView({ section, tenantSlug }: { section: string; tenantSlug: string }) {
  const [activeTab, setActiveTab] = useState<"products" | "categories" | "stock" | "suppliers">(() => productTabFromSection(section));
  const [payload, setPayload] = useState<ManageProductPayload | null>(null);
  const [productDraft, setProductDraft] = useState<ProductDraft>(() => emptyProductDraft());
  const [categoryDraft, setCategoryDraft] = useState<WarehouseCategoryDraft>({ id: 0, name: "" });
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>(() => emptySupplierDraft());
  const [stockProductId, setStockProductId] = useState("");
  const [stockCause, setStockCause] = useState<"carico" | "scarico">("carico");
  const [stockQty, setStockQty] = useState("1");
  const [stockLocationId, setStockLocationId] = useState("");
  const [stockNotes, setStockNotes] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(true);
  const endpoint = `/api/manage/products?slug=${encodeURIComponent(tenantSlug)}&include_inactive=1`;

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((response) => response.json() as Promise<ManageProductPayload>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setPayload(data);
        setProductDraft((current) => current.id > 0 || current.name ? current : emptyProductDraft(data));
        setSupplierDraft((current) => current.id > 0 || current.name ? current : emptySupplierDraft(data));
        setStockProductId(String(data.products?.[0]?.id ?? ""));
        setStockLocationId(String(data.activeLocationId ?? data.locations?.[0]?.id ?? ""));
      })
      .catch(() => {
        if (!cancelled) setFeedback("Magazzino non caricato.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function postProducts(body: Record<string, string>, successMessage: string) {
    const data = await postManageApi<ManageProductPayload>(endpoint, body);
    if (data.error) {
      setFeedback(data.error);
      return data;
    }
    setPayload(data);
    setFeedback(successMessage);
    return data;
  }

  async function saveProductForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postProducts({
      action: "product_save",
      id: productDraft.id ? String(productDraft.id) : "0",
      name: productDraft.name,
      sku: productDraft.sku,
      brand: productDraft.brand,
      category_id: productDraft.categoryId,
      price: productDraft.price,
      purchase_price: productDraft.purchasePrice,
      min_stock: productDraft.minStock,
      reorder_qty: productDraft.reorderQty,
      supplier_name: productDraft.supplierName,
      location_ids: productDraft.locationIds.join(","),
      is_active: productDraft.isActive ? "1" : "0",
      sell_online: productDraft.sellOnline ? "1" : "0",
      location_id: stockLocationId,
    }, productDraft.id > 0 ? "Prodotto aggiornato." : "Prodotto creato.");
    if (!data.error) setProductDraft(emptyProductDraft(data));
  }

  async function saveCategoryForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postProducts({
      action: "category_save",
      id: categoryDraft.id ? String(categoryDraft.id) : "0",
      name: categoryDraft.name,
    }, categoryDraft.id > 0 ? "Categoria aggiornata." : "Categoria creata.");
    if (!data.error) setCategoryDraft({ id: 0, name: "" });
  }

  async function saveSupplierForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postProducts({
      action: "supplier_save",
      id: supplierDraft.id ? String(supplierDraft.id) : "0",
      name: supplierDraft.name,
      business_name: supplierDraft.businessName,
      email: supplierDraft.email,
      phone: supplierDraft.phone,
      city: supplierDraft.city,
      vat_number: supplierDraft.vatNumber,
      warehouse_location_ids: supplierDraft.warehouseLocationIds.join(","),
      cost_location_ids: supplierDraft.costLocationIds.join(","),
      is_active: supplierDraft.isActive ? "1" : "0",
      is_active_costs: supplierDraft.isActiveCosts ? "1" : "0",
    }, supplierDraft.id > 0 ? "Fornitore aggiornato." : "Fornitore creato.");
    if (!data.error) setSupplierDraft(emptySupplierDraft(data));
  }

  async function saveStockForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stockProductId) return;
    await postProducts({
      action: "stock_move_save",
      cause: stockCause,
      product_id: stockProductId,
      qty: stockQty,
      location_id: stockLocationId,
      notes: stockNotes,
    }, "Movimento magazzino salvato.");
    setStockQty("1");
    setStockNotes("");
  }

  const productsList = payload?.products ?? [];
  const categoriesList = payload?.categories ?? [];
  const suppliersList = payload?.suppliers ?? [];
  const locationsList = payload?.locations ?? [];
  const stockDocuments = payload?.stockDocuments ?? [];

  return (
    <section className="space-y-5">
      <div className="grid gap-3 md:grid-cols-5">
        <MetricTile label="Prodotti" value={String(payload?.stats?.products ?? productsList.length)} detail="catalogo magazzino" />
        <MetricTile label="Attivi" value={String(payload?.stats?.activeProducts ?? productsList.filter((item) => item.isActive).length)} detail="vendibili" />
        <MetricTile label="Sotto soglia" value={String(payload?.stats?.lowStock ?? productsList.filter((item) => item.lowStock).length)} detail="da riordinare" />
        <MetricTile label="Categorie" value={String(payload?.stats?.categories ?? categoriesList.length)} detail="catalogo prodotti" />
        <MetricTile label="Fornitori" value={String(payload?.stats?.suppliers ?? suppliersList.length)} detail="anagrafiche" />
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { id: "products", label: "Prodotti", icon: Boxes },
          { id: "categories", label: "Categorie", icon: Tags },
          { id: "stock", label: "Carico / Scarico", icon: Truck },
          { id: "suppliers", label: "Fornitori", icon: Archive },
        ].map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition ${selected ? "border-emerald-700 bg-emerald-700 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-700 hover:text-emerald-700"}`}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as "products" | "categories" | "stock" | "suppliers")}
            >
              <Icon size={16} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>

      {feedback ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      {loading ? <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 shadow-sm">Caricamento magazzino...</p> : null}

      {activeTab === "products" ? (
        <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveProductForm}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{productDraft.id > 0 ? "Modifica prodotto" : "Nuovo prodotto"}</h2>
                <p className="mt-1 text-sm text-zinc-600">Anagrafica, prezzi, soglie, sedi e fornitore.</p>
              </div>
              <Package size={20} aria-hidden className="text-emerald-700" />
            </div>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Nome
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={productDraft.name} onChange={(event) => setProductDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Codice prodotto
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={productDraft.sku} onChange={(event) => setProductDraft((draft) => ({ ...draft, sku: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Brand
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={productDraft.brand} onChange={(event) => setProductDraft((draft) => ({ ...draft, brand: event.target.value }))} />
                </label>
              </div>
              <label className="grid gap-1 text-sm font-medium">
                Categoria
                <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={productDraft.categoryId} onChange={(event) => setProductDraft((draft) => ({ ...draft, categoryId: event.target.value }))}>
                  <option value="">Senza categoria</option>
                  {categoriesList.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Prezzo vendita
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={productDraft.price} onChange={(event) => setProductDraft((draft) => ({ ...draft, price: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Prezzo acquisto
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={productDraft.purchasePrice} onChange={(event) => setProductDraft((draft) => ({ ...draft, purchasePrice: event.target.value }))} />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Soglia minima
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="numeric" value={productDraft.minStock} onChange={(event) => setProductDraft((draft) => ({ ...draft, minStock: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Quantita riordino
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="numeric" value={productDraft.reorderQty} onChange={(event) => setProductDraft((draft) => ({ ...draft, reorderQty: event.target.value }))} />
                </label>
              </div>
              <label className="grid gap-1 text-sm font-medium">
                Fornitore
                <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={productDraft.supplierName} onChange={(event) => setProductDraft((draft) => ({ ...draft, supplierName: event.target.value }))}>
                  <option value="">Nessun fornitore</option>
                  {suppliersList.map((supplier) => (
                    <option key={supplier.id} value={supplier.name}>{supplier.name}</option>
                  ))}
                </select>
              </label>
              <CheckList
                items={locationsList.filter((location) => location.isActive).map((location) => ({ id: location.id, label: location.name }))}
                label="Sedi"
                selectedIds={productDraft.locationIds}
                onToggle={(id) => setProductDraft((draft) => ({ ...draft, locationIds: toggleId(draft.locationIds, id) }))}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={productDraft.isActive} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setProductDraft((draft) => ({ ...draft, isActive: event.target.checked }))} />
                  Attivo
                </label>
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={productDraft.sellOnline} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setProductDraft((draft) => ({ ...draft, sellOnline: event.target.checked }))} />
                  Visibile booking
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setProductDraft(emptyProductDraft(payload ?? undefined))}>
                <Plus size={16} aria-hidden />
                Nuovo
              </button>
            </div>
          </form>

          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Prodotti</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {productsList.map((product) => (
                <div className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_110px_110px_150px]" key={product.id}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{product.name}</h3>
                      {product.lowStock ? <span className="rounded-md bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">Sotto soglia</span> : null}
                      {!product.isActive ? <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-600">Disattivo</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-zinc-600">{product.categoryName} · {product.sku || "senza codice"} · {product.supplierName || "nessun fornitore"}</p>
                  </div>
                  <p className="text-sm font-semibold">{product.price}</p>
                  <p className="text-sm font-semibold">{product.stock} pz</p>
                  <div className="flex gap-2 lg:justify-end">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setProductDraft(productToDraft(product, payload ?? undefined))}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50" type="button" onClick={() => postProducts({ action: "product_delete", id: String(product.id) }, "Prodotto eliminato.")}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!productsList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessun prodotto configurato.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "categories" ? (
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveCategoryForm}>
            <h2 className="text-lg font-semibold">{categoryDraft.id > 0 ? "Modifica categoria" : "Nuova categoria"}</h2>
            <label className="mt-4 grid gap-1 text-sm font-medium">
              Nome
              <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={categoryDraft.name} onChange={(event) => setCategoryDraft((draft) => ({ ...draft, name: event.target.value }))} />
            </label>
            <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
              <Save size={16} aria-hidden />
              Salva
            </button>
          </form>
          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Categorie prodotti</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {categoriesList.map((category) => (
                <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between" key={category.id}>
                  <div>
                    <p className="font-semibold">{category.name}</p>
                    <p className="text-sm text-zinc-600">{category.productCount} prodotti</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCategoryDraft({ id: category.id, name: category.name })}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={category.productCount > 0} type="button" onClick={() => postProducts({ action: "category_delete", id: String(category.id) }, "Categoria eliminata.")}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!categoriesList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessuna categoria configurata.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "stock" ? (
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveStockForm}>
            <h2 className="text-lg font-semibold">Nuovo movimento</h2>
            <div className="mt-4 grid gap-3">
              <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={stockCause} onChange={(event) => setStockCause(event.target.value === "scarico" ? "scarico" : "carico")}>
                <option value="carico">Carico</option>
                <option value="scarico">Scarico</option>
              </select>
              <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={stockProductId} onChange={(event) => setStockProductId(event.target.value)}>
                {productsList.map((product) => (
                  <option key={product.id} value={product.id}>{product.name} ({product.stock} pz)</option>
                ))}
              </select>
              <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={stockLocationId} onChange={(event) => setStockLocationId(event.target.value)}>
                {locationsList.map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
              <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="numeric" value={stockQty} onChange={(event) => setStockQty(event.target.value)} />
              <textarea className="min-h-24 rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-emerald-700" placeholder="Note" value={stockNotes} onChange={(event) => setStockNotes(event.target.value)} />
            </div>
            <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
              <Save size={16} aria-hidden />
              Salva movimento
            </button>
          </form>
          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Movimenti</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {stockDocuments.map((doc) => (
                <div className="grid gap-3 py-4 lg:grid-cols-[120px_minmax(0,1fr)_110px_120px]" key={doc.id}>
                  <div>
                    <p className="font-semibold">#{doc.id}</p>
                    <p className="text-sm text-zinc-600">{doc.moveDate}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold capitalize">{doc.cause}{doc.isCanceled ? " · annullato" : ""}</p>
                    <p className="truncate text-sm text-zinc-600">{doc.items.map((item) => `${item.productName} x${item.qty}`).join(", ") || doc.notes}</p>
                  </div>
                  <p className="text-sm font-semibold">{doc.items.reduce((sum, item) => sum + item.qty, 0)} pz</p>
                  {!doc.isCanceled ? (
                    <button className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => postProducts({ action: "stock_doc_cancel", id: String(doc.id) }, "Movimento annullato.")}>
                      Annulla
                    </button>
                  ) : null}
                </div>
              ))}
              {!stockDocuments.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessun movimento registrato.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "suppliers" ? (
        <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveSupplierForm}>
            <h2 className="text-lg font-semibold">{supplierDraft.id > 0 ? "Modifica fornitore" : "Nuovo fornitore"}</h2>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Nome
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={supplierDraft.name} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Ragione sociale" value={supplierDraft.businessName} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, businessName: event.target.value }))} />
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Email" value={supplierDraft.email} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, email: event.target.value }))} />
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Telefono" value={supplierDraft.phone} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, phone: event.target.value }))} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Citta" value={supplierDraft.city} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, city: event.target.value }))} />
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Partita IVA" value={supplierDraft.vatNumber} onChange={(event) => setSupplierDraft((draft) => ({ ...draft, vatNumber: event.target.value }))} />
              </div>
              <CheckList
                items={locationsList.map((location) => ({ id: location.id, label: location.name }))}
                label="Sedi magazzino"
                selectedIds={supplierDraft.warehouseLocationIds}
                onToggle={(id) => setSupplierDraft((draft) => ({ ...draft, warehouseLocationIds: toggleId(draft.warehouseLocationIds, id) }))}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={supplierDraft.isActive} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setSupplierDraft((draft) => ({ ...draft, isActive: event.target.checked }))} />
                  Attivo magazzino
                </label>
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={supplierDraft.isActiveCosts} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setSupplierDraft((draft) => ({ ...draft, isActiveCosts: event.target.checked }))} />
                  Attivo costi
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setSupplierDraft(emptySupplierDraft(payload ?? undefined))}>
                <Plus size={16} aria-hidden />
                Nuovo
              </button>
            </div>
          </form>
          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Fornitori</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {suppliersList.map((supplier) => (
                <div className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_190px_150px]" key={supplier.id}>
                  <div className="min-w-0">
                    <p className="font-semibold">{supplier.name}</p>
                    <p className="truncate text-sm text-zinc-600">{supplier.email || supplier.phone || supplier.city || "Anagrafica fornitore"}</p>
                  </div>
                  <p className="text-sm text-zinc-600">{supplier.isActive ? "Magazzino attivo" : "Magazzino disattivo"}</p>
                  <div className="flex gap-2 lg:justify-end">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setSupplierDraft(supplierToDraft(supplier, payload ?? undefined))}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50" type="button" onClick={() => postProducts({ action: "supplier_delete", id: String(supplier.id) }, "Fornitore eliminato.")}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!suppliersList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessun fornitore configurato.</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function productTabFromSection(section: string): "products" | "categories" | "stock" | "suppliers" {
  if (section === "product_categories") return "categories";
  if (section === "stock_moves") return "stock";
  if (section === "suppliers") return "suppliers";
  return "products";
}

function activeProductLocationIds(payload?: ManageProductPayload): number[] {
  return payload?.locations?.filter((location) => location.isActive).map((location) => location.id) ?? [];
}

function emptyProductDraft(payload?: ManageProductPayload): ProductDraft {
  return {
    id: 0,
    name: "",
    sku: "",
    brand: "",
    categoryId: String(payload?.categories?.[0]?.id ?? ""),
    price: "0",
    purchasePrice: "0",
    minStock: "10",
    reorderQty: "0",
    supplierName: "",
    locationIds: activeProductLocationIds(payload),
    isActive: true,
    sellOnline: true,
  };
}

function productToDraft(product: WarehouseProductItem, payload?: ManageProductPayload): ProductDraft {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    brand: product.brand,
    categoryId: String(product.categoryId ?? ""),
    price: String(product.priceValue ?? 0),
    purchasePrice: String(product.purchasePrice ?? 0),
    minStock: String(product.minStock ?? 0),
    reorderQty: String(product.reorderQty ?? 0),
    supplierName: product.supplierName,
    locationIds: product.locationIds.length ? product.locationIds : activeProductLocationIds(payload),
    isActive: product.isActive,
    sellOnline: product.sellOnline,
  };
}

function emptySupplierDraft(payload?: ManageProductPayload): SupplierDraft {
  const locationIds = activeProductLocationIds(payload);
  return {
    id: 0,
    name: "",
    businessName: "",
    email: "",
    phone: "",
    city: "",
    vatNumber: "",
    warehouseLocationIds: locationIds,
    costLocationIds: locationIds,
    isActive: true,
    isActiveCosts: true,
  };
}

function supplierToDraft(supplier: WarehouseSupplierItem, payload?: ManageProductPayload): SupplierDraft {
  const locationIds = activeProductLocationIds(payload);
  return {
    id: supplier.id,
    name: supplier.name,
    businessName: supplier.businessName,
    email: supplier.email,
    phone: supplier.phone || supplier.mobile,
    city: supplier.city,
    vatNumber: supplier.vatNumber,
    warehouseLocationIds: supplier.warehouseLocationIds.length ? supplier.warehouseLocationIds : locationIds,
    costLocationIds: supplier.costLocationIds.length ? supplier.costLocationIds : locationIds,
    isActive: supplier.isActive,
    isActiveCosts: supplier.isActiveCosts,
  };
}

function CostsView({ section, tenantSlug }: { section: string; tenantSlug: string }) {
  const [activeTab, setActiveTab] = useState<"costs" | "categories">(() => costTabFromSection(section));
  const [payload, setPayload] = useState<ManageCostsPayload | null>(null);
  const [costDraft, setCostDraft] = useState<CostDraft>(() => emptyCostDraft());
  const [categoryDraft, setCategoryDraft] = useState<CostCategoryDraft>(() => emptyCostCategoryDraft());
  const [filters, setFilters] = useState(() => defaultCostFilters());
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      slug: tenantSlug,
      from: filters.from,
      to: filters.to,
      status: filters.status,
      q: filters.query,
      category_id: filters.categoryId,
    });
    if (filters.locationId) params.set("location_id", filters.locationId);

    fetch(`/api/manage/costs?${params.toString()}`)
      .then((response) => response.json() as Promise<ManageCostsPayload>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setPayload(data);
        setCostDraft((current) => current.id > 0 || current.title ? current : emptyCostDraft(data));
        if (!filters.locationId && data.activeLocationId) setFilters((current) => ({ ...current, locationId: String(data.activeLocationId) }));
      })
      .catch(() => {
        if (!cancelled) setFeedback("Scadenziario non caricato.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters.categoryId, filters.from, filters.locationId, filters.query, filters.status, filters.to, tenantSlug]);

  async function postCosts(body: Record<string, string>, successMessage: string) {
    const data = await postManageApi<ManageCostsPayload>(`/api/manage/costs?slug=${encodeURIComponent(tenantSlug)}`, body);
    if (data.error) {
      setFeedback(data.error);
      return data;
    }
    setPayload(data);
    setFeedback(successMessage);
    return data;
  }

  async function saveCostForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postCosts({
      action: "save_cost",
      id: costDraft.id ? String(costDraft.id) : "0",
      title: costDraft.title,
      category_id: costDraft.categoryId,
      supplier_id: costDraft.supplierId,
      amount: costDraft.amount,
      track_payments: "1",
      paid_amount: costDraft.paidAmount,
      vat_percent: costDraft.vatPercent,
      due_date: costDraft.dueDate,
      payment_method: costDraft.paymentMethod,
      doc_number: costDraft.docNumber,
      doc_date: costDraft.docDate,
      notes: costDraft.notes,
      is_paid: costDraft.isPaid ? "1" : "0",
      is_recurring: costDraft.isRecurring ? "1" : "0",
      recurrence_interval: costDraft.recurrenceInterval,
      recurrence_unit: costDraft.recurrenceUnit,
      recurrence_end_date: costDraft.recurrenceEndDate,
      location_id: filters.locationId,
    }, costDraft.id > 0 ? "Costo aggiornato." : "Costo creato.");
    if (!data.error) setCostDraft(emptyCostDraft(data));
  }

  async function saveCategoryForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postCosts({
      action: "save_category",
      id: categoryDraft.id ? String(categoryDraft.id) : "0",
      name: categoryDraft.name,
      color: categoryDraft.color,
      is_active: categoryDraft.isActive ? "1" : "0",
    }, categoryDraft.id > 0 ? "Categoria aggiornata." : "Categoria creata.");
    if (!data.error) setCategoryDraft(emptyCostCategoryDraft());
  }

  const costsList = payload?.costs ?? [];
  const categoriesList = payload?.categories ?? [];
  const suppliersList = payload?.suppliers ?? [];
  const locationsList = payload?.locations ?? [];
  const selectedLocationId = Number(filters.locationId || payload?.activeLocationId || 0);
  const supplierOptions = suppliersList.filter((supplier) => supplier.isActiveCosts && (!supplier.costLocationIds.length || supplier.costLocationIds.includes(selectedLocationId)));

  return (
    <section className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <MetricTile label="Da pagare" value={formatCurrency(payload?.summary?.dueAmount ?? 0)} detail={`${payload?.summary?.open ?? 0} aperti`} />
        <MetricTile label="Scaduti" value={formatCurrency(payload?.summary?.overdueAmount ?? 0)} detail={`${payload?.summary?.overdue ?? 0} voci`} />
        <MetricTile label="Pagati" value={formatCurrency(payload?.summary?.paidAmount ?? 0)} detail={`${payload?.summary?.paid ?? 0} saldati`} />
        <MetricTile label="Categorie" value={String(categoriesList.length)} detail="scadenziario" />
      </div>

      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-1">
            {[
              { id: "costs", label: "Scadenziario", icon: ClipboardCheck },
              { id: "categories", label: "Categorie", icon: Tags },
            ].map((tab) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              return (
                <button
                  className={`inline-flex h-9 items-center gap-2 rounded px-3 text-sm font-semibold transition ${selected ? "bg-white text-[#173262] shadow-sm" : "text-zinc-600 hover:text-zinc-950"}`}
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id as "costs" | "categories")}
                >
                  <Icon size={16} aria-hidden />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="grid gap-2 md:grid-cols-[150px_150px_150px_160px_minmax(180px,1fr)]">
            <input className="h-10 rounded-md border border-zinc-300 px-3 text-sm" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3 text-sm" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
            <select className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
              <option value="open">Da pagare</option>
              <option value="overdue">Scaduti</option>
              <option value="paid">Pagati</option>
              <option value="all">Tutti</option>
            </select>
            <select className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm" value={filters.locationId} onChange={(event) => setFilters((current) => ({ ...current, locationId: event.target.value }))}>
              {locationsList.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
            <input className="h-10 rounded-md border border-zinc-300 px-3 text-sm" placeholder="Cerca titolo, documento o fornitore" value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} />
          </div>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
        {loading ? <p className="mt-3 text-sm text-zinc-600">Caricamento costi...</p> : null}
      </div>

      {activeTab === "costs" ? (
        <div className="grid gap-4 xl:grid-cols-[430px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveCostForm}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{costDraft.id > 0 ? "Modifica costo" : "Nuovo costo"}</h2>
                <p className="mt-1 text-sm text-zinc-600">Scadenza, fornitore, saldo parziale e ricorrenza.</p>
              </div>
              <BadgeEuro size={20} aria-hidden className="text-emerald-700" />
            </div>
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Titolo
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={costDraft.title} onChange={(event) => setCostDraft((draft) => ({ ...draft, title: event.target.value }))} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Totale
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={costDraft.amount} onChange={(event) => setCostDraft((draft) => ({ ...draft, amount: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  Gia pagato
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={costDraft.paidAmount} onChange={(event) => setCostDraft((draft) => ({ ...draft, paidAmount: event.target.value }))} />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Scadenza
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" type="date" value={costDraft.dueDate} onChange={(event) => setCostDraft((draft) => ({ ...draft, dueDate: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  IVA %
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" inputMode="decimal" value={costDraft.vatPercent} onChange={(event) => setCostDraft((draft) => ({ ...draft, vatPercent: event.target.value }))} />
                </label>
              </div>
              <label className="grid gap-1 text-sm font-medium">
                Categoria
                <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={costDraft.categoryId} onChange={(event) => setCostDraft((draft) => ({ ...draft, categoryId: event.target.value }))}>
                  <option value="">Senza categoria</option>
                  {categoriesList.map((category) => (
                    <option disabled={!category.isActive && String(category.id) !== costDraft.categoryId} key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Fornitore
                <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={costDraft.supplierId} onChange={(event) => setCostDraft((draft) => ({ ...draft, supplierId: event.target.value }))}>
                  <option value="">Nessun fornitore</option>
                  {supplierOptions.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Metodo pagamento" value={costDraft.paymentMethod} onChange={(event) => setCostDraft((draft) => ({ ...draft, paymentMethod: event.target.value }))} />
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" placeholder="Numero documento" value={costDraft.docNumber} onChange={(event) => setCostDraft((draft) => ({ ...draft, docNumber: event.target.value }))} />
              </div>
              <label className="grid gap-1 text-sm font-medium">
                Data documento
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" type="date" value={costDraft.docDate} onChange={(event) => setCostDraft((draft) => ({ ...draft, docDate: event.target.value }))} />
              </label>
              <textarea className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-emerald-700" placeholder="Note" value={costDraft.notes} onChange={(event) => setCostDraft((draft) => ({ ...draft, notes: event.target.value }))} />
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={costDraft.isPaid} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setCostDraft((draft) => ({ ...draft, isPaid: event.target.checked, paidAmount: event.target.checked ? draft.amount : draft.paidAmount }))} />
                  Saldato
                </label>
                <label className="inline-flex items-center gap-2 text-sm font-medium">
                  <input checked={costDraft.isRecurring} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setCostDraft((draft) => ({ ...draft, isRecurring: event.target.checked }))} />
                  Ricorrente
                </label>
              </div>
              {costDraft.isRecurring ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1.2fr]">
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm" min={1} type="number" value={costDraft.recurrenceInterval} onChange={(event) => setCostDraft((draft) => ({ ...draft, recurrenceInterval: event.target.value }))} />
                  <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={costDraft.recurrenceUnit} onChange={(event) => setCostDraft((draft) => ({ ...draft, recurrenceUnit: event.target.value as CostDraft["recurrenceUnit"] }))}>
                    <option value="day">Giorni</option>
                    <option value="week">Settimane</option>
                    <option value="month">Mesi</option>
                    <option value="year">Anni</option>
                  </select>
                  <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm" type="date" value={costDraft.recurrenceEndDate} onChange={(event) => setCostDraft((draft) => ({ ...draft, recurrenceEndDate: event.target.value }))} />
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCostDraft(emptyCostDraft(payload ?? undefined))}>
                <Plus size={16} aria-hidden />
                Nuovo
              </button>
            </div>
          </form>

          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Scadenze</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {costsList.map((cost) => (
                <div className="grid gap-3 py-4 xl:grid-cols-[110px_minmax(0,1fr)_130px_120px_190px]" key={cost.id}>
                  <div>
                    <p className="text-sm text-zinc-600">{cost.dueDate}</p>
                    <span className={`mt-1 inline-flex rounded-md px-2 py-1 text-xs font-semibold ${costStatusClass(cost.status)}`}>{costStatusLabel(cost.status, cost.isPartial)}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: cost.categoryColor || "#0f766e" }} />
                      <h3 className="truncate font-semibold">{cost.title}</h3>
                    </div>
                    <p className="mt-1 truncate text-sm text-zinc-600">{cost.categoryName} · {cost.supplierName || "nessun fornitore"} · {cost.locationName}</p>
                    {cost.isRecurring ? <p className="mt-1 text-xs text-zinc-500">{recurrenceLabel(cost)}</p> : null}
                  </div>
                  <div>
                    <p className="font-semibold">{formatCurrency(cost.amount)}</p>
                    {cost.paidAmount > 0 && !cost.isPaid ? <p className="text-xs text-zinc-500">pagati {formatCurrency(cost.paidAmount)}</p> : null}
                  </div>
                  <p className="font-semibold">{formatCurrency(cost.remainingAmount)}</p>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCostDraft(costToDraft(cost))}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => postCosts({ action: "toggle_paid", id: String(cost.id), location_id: filters.locationId }, cost.isPaid ? "Costo riaperto." : "Costo saldato.")}>
                      <Check size={15} aria-hidden />
                      {cost.isPaid ? "Riapri" : "Paga"}
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50" type="button" onClick={() => postCosts({ action: "cost_delete", id: String(cost.id), location_id: filters.locationId }, "Costo eliminato.")}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!costsList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessuna scadenza nel filtro selezionato.</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "categories" ? (
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveCategoryForm}>
            <h2 className="text-lg font-semibold">{categoryDraft.id > 0 ? "Modifica categoria" : "Nuova categoria"}</h2>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-medium">
                Nome
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" value={categoryDraft.name} onChange={(event) => setCategoryDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Colore
                <input className="h-10 rounded-md border border-zinc-200 px-3 text-sm outline-none transition focus:border-emerald-700" type="color" value={categoryDraft.color} onChange={(event) => setCategoryDraft((draft) => ({ ...draft, color: event.target.value }))} />
              </label>
              <label className="inline-flex items-center gap-2 text-sm font-medium">
                <input checked={categoryDraft.isActive} className="h-4 w-4 rounded border-zinc-300 text-emerald-700" type="checkbox" onChange={(event) => setCategoryDraft((draft) => ({ ...draft, isActive: event.target.checked }))} />
                Attiva
              </label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Save size={16} aria-hidden />
                Salva
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCategoryDraft(emptyCostCategoryDraft())}>
                <Plus size={16} aria-hidden />
                Nuova
              </button>
            </div>
          </form>

          <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Categorie costi</h2>
            <div className="mt-3 divide-y divide-zinc-100">
              {categoriesList.map((category) => (
                <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_110px_230px]" key={category.id}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: category.color || "#0f766e" }} />
                      <p className="font-semibold">{category.name}</p>
                      {!category.isActive ? <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-600">Disattiva</span> : null}
                    </div>
                  </div>
                  <p className="text-sm text-zinc-600">{category.costCount} costi</p>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => setCategoryDraft({ id: category.id, name: category.name, color: category.color || "#0f766e", isActive: category.isActive })}>
                      <Pencil size={15} aria-hidden />
                      Modifica
                    </button>
                    <button className="h-9 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700" type="button" onClick={() => postCosts({ action: "toggle_category", id: String(category.id) }, "Stato categoria aggiornato.")}>
                      {category.isActive ? "Disattiva" : "Attiva"}
                    </button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-50" type="button" onClick={() => postCosts({ action: "category_delete", id: String(category.id) }, "Categoria eliminata.")}>
                      <Trash2 size={15} aria-hidden />
                      Elimina
                    </button>
                  </div>
                </div>
              ))}
              {!categoriesList.length ? <p className="py-8 text-center text-sm text-zinc-600">Nessuna categoria costo configurata.</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function costTabFromSection(section: string): "costs" | "categories" {
  return section === "cost_categories" ? "categories" : "costs";
}

function defaultCostFilters() {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const to = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, "0")}-${String(toDate.getDate()).padStart(2, "0")}`;
  return { from, to, status: "open", query: "", categoryId: "", locationId: "" };
}

function emptyCostDraft(payload?: ManageCostsPayload): CostDraft {
  return {
    id: 0,
    title: "",
    categoryId: String(payload?.categories?.find((category) => category.isActive)?.id ?? ""),
    supplierId: "",
    amount: "0",
    paidAmount: "0",
    vatPercent: "",
    dueDate: todayDateInput(),
    paymentMethod: "",
    docNumber: "",
    docDate: "",
    notes: "",
    isPaid: false,
    isRecurring: false,
    recurrenceInterval: "1",
    recurrenceUnit: "month",
    recurrenceEndDate: "",
  };
}

function costToDraft(cost: ManageCostItem): CostDraft {
  return {
    id: cost.id,
    title: cost.title,
    categoryId: String(cost.categoryId ?? ""),
    supplierId: String(cost.supplierId ?? ""),
    amount: String(cost.amount ?? 0),
    paidAmount: String(cost.paidAmount ?? 0),
    vatPercent: cost.vatPercent === null ? "" : String(cost.vatPercent),
    dueDate: cost.dueDate,
    paymentMethod: cost.paymentMethod,
    docNumber: cost.docNumber,
    docDate: cost.docDate,
    notes: cost.notes,
    isPaid: cost.isPaid,
    isRecurring: cost.isRecurring,
    recurrenceInterval: String(cost.recurrenceInterval || 1),
    recurrenceUnit: cost.recurrenceUnit,
    recurrenceEndDate: cost.recurrenceEndDate,
  };
}

function emptyCostCategoryDraft(): CostCategoryDraft {
  return { id: 0, name: "", color: "#0f766e", isActive: true };
}

function todayDateInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function costStatusLabel(status: ManageCostItem["status"], partial: boolean): string {
  if (status === "paid") return "Pagato";
  if (status === "overdue") return partial ? "Scaduto parziale" : "Scaduto";
  return partial ? "Parziale" : "Da pagare";
}

function costStatusClass(status: ManageCostItem["status"]): string {
  if (status === "paid") return "bg-emerald-50 text-emerald-700";
  if (status === "overdue") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-800";
}

function recurrenceLabel(cost: ManageCostItem): string {
  const unit = { day: "giorni", week: "settimane", month: "mesi", year: "anni" }[cost.recurrenceUnit];
  return `Ogni ${cost.recurrenceInterval} ${unit}${cost.recurrenceEndDate ? ` fino al ${cost.recurrenceEndDate}` : ""}`;
}

type ManagePosPayload = {
  summary?: PosSummary;
  sales?: PosSale[];
  activeLocationId?: number;
  locations?: Array<{ id: number; name: string }>;
  catalog?: { clients?: ManagedClient[]; services?: ManagedService[]; products?: ManagedProduct[] };
};

type PosCartLine = {
  uid: string;
  type: "service" | "product";
  refId: number;
  name: string;
  unitPrice: number;
  quantity: number;
  status: "executed" | "prepaid" | "collected" | "ordered";
  stock?: number;
};

type PosCatalogTab = "services" | "products";
type PosDiscountType = "none" | "percent" | "fixed";
type PosPaymentChoice = "cash" | "card" | "check" | "bank";
type PosCouponPreview = { valid?: boolean; discount?: number; reason?: string };
type PosWalletSummary = { credit: number; points: number };

function PosView({ historyOnly = false, tenantSlug, onOpenSection }: { historyOnly?: boolean; tenantSlug: string; onOpenSection: (section: string) => void }) {
  const [sales, setSales] = useState<PosSale[]>([]);
  const [summary, setSummary] = useState<PosSummary | null>(null);
  const [posClients, setPosClients] = useState<ManagedClient[]>([]);
  const [posServices, setPosServices] = useState<ManagedService[]>([]);
  const [posProducts, setPosProducts] = useState<ManagedProduct[]>([]);
  const [posLocations, setPosLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [locationId, setLocationId] = useState("");
  const [clientId, setClientId] = useState("0");
  const [clientQuery, setClientQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogTab, setCatalogTab] = useState<PosCatalogTab>("services");
  const [cartLines, setCartLines] = useState<PosCartLine[]>([]);
  const [discountType, setDiscountType] = useState<PosDiscountType>("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [couponVisible, setCouponVisible] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [couponPreview, setCouponPreview] = useState<PosCouponPreview | null>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [clientWallet, setClientWallet] = useState<PosWalletSummary | null>(null);
  const [clientGiftCards, setClientGiftCards] = useState<GiftCard[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PosPaymentChoice>("cash");
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams({ slug: tenantSlug, include_cancelled: "1" });
    if (locationId) params.set("location_id", locationId);

    fetch(`/api/manage/pos?${params.toString()}`)
      .then((response) => response.json() as Promise<ManagePosPayload & { error?: string }>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setSummary(data.summary ?? null);
        setSales(data.sales ?? []);
        setPosLocations(data.locations ?? []);
        setPosClients(data.catalog?.clients ?? []);
        setPosServices(data.catalog?.services ?? []);
        setPosProducts(data.catalog?.products ?? []);
        setLocationId((current) => current || String(data.activeLocationId ?? data.locations?.[0]?.id ?? ""));
      })
      .catch(() => {
        if (!cancelled) setFeedback("Cassa non caricata.");
      });

    return () => {
      cancelled = true;
    };
  }, [locationId, tenantSlug]);

  async function checkout(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cartLines.length) {
      setFeedback("Aggiungi almeno un elemento.");
      return;
    }

    const data = await postManageApi<ManagePosPayload>(`/api/manage/pos?slug=${encodeURIComponent(tenantSlug)}`, {
      action: "checkout",
      client_id: clientId,
      location_id: locationId,
      discount: String(manualDiscount),
      coupon_code: couponCode.trim(),
      notes,
      items_json: JSON.stringify(cartLines.map((line) => ({
        type: line.type,
        refId: line.refId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        status: line.status,
      }))),
      payments_json: JSON.stringify(payableTotal > 0 ? [{ method: paymentMethod, amount: payableTotal }] : []),
    });

    if (data.error) {
      setFeedback(data.error);
      return;
    }
    applyPosPayload(data);
    setCartLines([]);
    setCouponCode("");
    setCouponPreview(null);
    setCouponLoading(false);
    setDiscountType("none");
    setDiscountValue("0");
    setNotes("");
    setFeedback("Vendita registrata.");
  }

  async function cancelPosSale(id: number) {
    const data = await postManageApi<ManagePosPayload>(`/api/manage/pos?slug=${encodeURIComponent(tenantSlug)}`, {
      action: "cancel",
      id: String(id),
      reason: "Annullamento gestionale Next",
      stock_cancel_mode: "restore",
    });

    applyPosPayload(data);
    setFeedback(data.error ?? "Vendita annullata.");
  }

  function applyPosPayload(data: ManagePosPayload) {
    if (data.sales) setSales(data.sales);
    if (data.summary) setSummary(data.summary);
    if (data.locations) setPosLocations(data.locations);
    if (data.activeLocationId) setLocationId(String(data.activeLocationId));
    if (data.catalog?.clients) setPosClients(data.catalog.clients);
    if (data.catalog?.services) setPosServices(data.catalog.services);
    if (data.catalog?.products) setPosProducts(data.catalog.products);
  }

  function addService(service: ManagedService) {
    setCartLines((current) => [
      ...current,
      {
        uid: `service-${service.id}-${Date.now()}-${current.length}`,
        type: "service",
        refId: service.id,
        name: service.name,
        unitPrice: moneyFromLabel(service.price),
        quantity: 1,
        status: "executed",
      },
    ]);
  }

  function addProduct(product: ManagedProduct) {
    setCartLines((current) => [
      ...current,
      {
        uid: `product-${product.id}-${Date.now()}-${current.length}`,
        type: "product",
        refId: product.id,
        name: product.name,
        unitPrice: moneyFromLabel(product.price),
        quantity: 1,
        status: "collected",
        stock: product.stock,
      },
    ]);
  }

  function updateLine(uid: string, values: Partial<PosCartLine>) {
    setCartLines((current) => current.map((line) => (line.uid === uid ? { ...line, ...values } : line)));
  }

  function removeLine(uid: string) {
    setCartLines((current) => current.filter((line) => line.uid !== uid));
  }

  const selectedClient = posClients.find((client) => String(client.id) === clientId);
  const filteredClients = posClients.filter((client) => {
    const query = clientQuery.trim().toLowerCase();
    if (!query) return true;
    return [client.name, client.phone, client.email].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
  const filteredServices = posServices.filter((service) => service.name.toLowerCase().includes(catalogQuery.trim().toLowerCase()));
  const filteredProducts = posProducts.filter((product) => [product.name, product.sku, product.brand].some((value) => String(value ?? "").toLowerCase().includes(catalogQuery.trim().toLowerCase())));
  const subtotal = roundPosMoney(cartLines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  const manualDiscount = discountAmount(discountType, discountValue, subtotal);
  const couponDiscount = couponPreview?.valid ? roundPosMoney(Math.min(subtotal, Math.max(0, couponPreview.discount ?? 0))) : 0;
  const payableTotal = roundPosMoney(Math.max(0, subtotal - manualDiscount - couponDiscount));

  useEffect(() => {
    const code = couponCode.trim();
    if (!code || subtotal <= 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCouponLoading(true);
      postManageApi<{ preview?: PosCouponPreview; error?: string }>(`/api/manage/coupons?slug=${encodeURIComponent(tenantSlug)}`, {
        action: "preview",
        code,
        subtotal: String(subtotal),
      })
        .then((data) => {
          if (cancelled) return;
          setCouponPreview(data.preview ?? { valid: false, discount: 0, reason: data.error ?? "Coupon non valido." });
        })
        .catch(() => {
          if (!cancelled) setCouponPreview({ valid: false, discount: 0, reason: "Coupon non verificabile." });
        })
        .finally(() => {
          if (!cancelled) setCouponLoading(false);
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [couponCode, subtotal, tenantSlug]);

  useEffect(() => {
    const selectedId = Number.parseInt(clientId, 10) || 0;
    if (selectedId <= 0) return;

    let cancelled = false;
    Promise.all([
      fetch(`/api/manage/fidelity?slug=${encodeURIComponent(tenantSlug)}`).then((response) => response.json() as Promise<{ clients?: Array<ManagedClient & { wallet?: PosWalletSummary }> }>),
      fetch(`/api/manage/giftcards?slug=${encodeURIComponent(tenantSlug)}`).then((response) => response.json() as Promise<{ giftCards?: GiftCard[] }>),
    ])
      .then(([fidelityData, giftCardData]) => {
        if (cancelled) return;
        const wallet = fidelityData.clients?.find((client) => client.id === selectedId)?.wallet ?? null;
        const cards = (giftCardData.giftCards ?? []).filter((card) => card.clientId === selectedId && card.status === "active" && card.balance > 0);
        setClientWallet(wallet);
        setClientGiftCards(cards);
      })
      .catch(() => {
        if (!cancelled) {
          setClientWallet(null);
          setClientGiftCards([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, tenantSlug]);

  if (historyOnly) {
    return (
      <section className="space-y-5">
        <div className="grid gap-3 md:grid-cols-3">
          <MetricTile label="Incasso attivo" value={formatEuro(summary?.activeTotal ?? 0)} detail="vendite non annullate" />
          <MetricTile label="Scontrini" value={`${summary?.saleCount ?? 0}`} detail="storico POS" />
          <MetricTile label="Prodotti" value={formatEuro(summary?.productTotal ?? 0)} detail="scarico magazzino collegato" />
        </div>
        <PosSalesHistory sales={sales} onCancel={cancelPosSale} />
      </section>
    );
  }

  return (
    <form className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_360px]" onSubmit={checkout}>
      <aside className="overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
        <div className="flex h-14 items-center justify-between border-b border-zinc-100 px-4">
          <h2 className="font-semibold">Clienti</h2>
          <Users size={18} aria-hidden className="text-[#1b3a6b]" />
        </div>
        <div className="border-b border-zinc-100 p-3">
          <div className="flex h-10 items-center rounded-md border border-zinc-200 bg-white px-3">
            <Search size={16} aria-hidden className="mr-2 text-[#1b3a6b]" />
            <input className="min-w-0 flex-1 text-sm outline-none" placeholder="Cerca Cliente..." value={clientQuery} onChange={(event) => setClientQuery(event.target.value)} />
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto p-2">
          {filteredClients.map((client) => (
            <button
              className={`block w-full rounded-md px-3 py-3 text-left transition ${String(client.id) === clientId ? "bg-[#e8f0fb] text-[#0b2f63]" : "hover:bg-zinc-50"}`}
              key={client.id}
              type="button"
              onClick={() => {
                setClientId(String(client.id));
                setClientWallet(null);
                setClientGiftCards([]);
              }}
            >
              <span className="block font-semibold">{client.name}</span>
              <span className="mt-1 block text-sm text-zinc-500">{client.phone || client.email || `ID: ${client.id}`}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
        <div className="grid min-h-14 grid-cols-2 items-end gap-4 border-b border-zinc-100 px-4 py-3">
          <div>
            <p className="text-sm text-zinc-500">Cliente selezionato</p>
            <div className="flex items-center gap-2">
              <p className="font-semibold">{selectedClient?.name ?? "-"}</p>
              {selectedClient ? (
                <button
                  className="text-sm text-zinc-500 underline"
                  type="button"
                  onClick={() => {
                    setClientId("0");
                    setClientWallet(null);
                    setClientGiftCards([]);
                  }}
                >
                  rimuovi
                </button>
              ) : null}
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-zinc-500">Codice tessera</p>
            <p className="font-semibold">-</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase text-[#20304a]">
              <tr>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Elemento</th>
                <th className="w-28 px-4 py-3 text-center">Q.tà</th>
                <th className="w-28 px-4 py-3 text-right">Prezzo</th>
                <th className="w-28 px-4 py-3 text-right">Totale</th>
                <th className="w-14 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {cartLines.length ? cartLines.map((line) => (
                <tr className="border-t border-zinc-100" key={line.uid}>
                  <td className="px-4 py-3 text-xs font-semibold uppercase text-zinc-500">{line.type === "service" ? "Servizio" : "Prodotto"}</td>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{line.name}</p>
                    <label className="mt-2 inline-flex items-center gap-2 text-xs text-zinc-500">
                      <input
                        checked={line.type === "service" ? line.status === "executed" : line.status === "collected"}
                        className="h-4 w-4 accent-[#007c72]"
                        type="checkbox"
                        onChange={(event) => updateLine(line.uid, {
                          status: line.type === "service"
                            ? event.target.checked ? "executed" : "prepaid"
                            : event.target.checked ? "collected" : "ordered",
                        })}
                      />
                      {line.type === "service" ? "Eseguito / Prepagato" : "Ritirato / Ordinato"}
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      className="h-9 w-20 rounded-md border border-zinc-200 px-2 text-center text-sm"
                      min={1}
                      step={1}
                      type="number"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.uid, { quantity: Math.max(1, Number.parseInt(event.target.value || "1", 10)) })}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">{formatEuro(line.unitPrice)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatEuro(line.unitPrice * line.quantity)}</td>
                  <td className="px-4 py-3 text-right">
                    <button className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 hover:border-red-300 hover:text-red-600" type="button" onClick={() => removeLine(line.uid)} aria-label="Rimuovi">
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="px-4 py-5 text-zinc-500" colSpan={6}>Aggiungi almeno un elemento.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-zinc-100 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {posLocations.length > 1 ? (
              <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                {posLocations.map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            ) : null}
            <div className="flex h-10 min-w-[260px] flex-1 items-center rounded-md border border-zinc-200 bg-white px-3">
              <Search size={16} aria-hidden className="mr-2 text-[#1b3a6b]" />
              <input className="min-w-0 flex-1 text-sm outline-none" placeholder="Cerca..." value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
            </div>
            <select className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm">
              <option>Tutte le aree</option>
            </select>
            <div className="ml-auto inline-flex rounded-md border border-zinc-200">
              <button className={`inline-flex h-10 items-center gap-2 px-4 text-sm ${catalogTab === "services" ? "bg-zinc-50 font-semibold" : ""}`} type="button" onClick={() => setCatalogTab("services")}>
                <Scissors size={15} aria-hidden />
                Servizi
              </button>
              <button className={`inline-flex h-10 items-center gap-2 border-l border-zinc-200 px-4 text-sm ${catalogTab === "products" ? "bg-zinc-50 font-semibold" : ""}`} type="button" onClick={() => setCatalogTab("products")}>
                <ShoppingBag size={15} aria-hidden />
                Prodotti
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {catalogTab === "services" ? filteredServices.map((service) => (
              <button className="min-h-16 rounded-md border border-zinc-200 px-4 py-3 text-left transition hover:border-[#007c72]" key={service.id} type="button" onClick={() => addService(service)}>
                <span className="block font-semibold">{service.name}</span>
                <span className="mt-2 block text-right font-semibold">{service.price}</span>
              </button>
            )) : filteredProducts.map((product) => (
              <button className="min-h-16 rounded-md border border-zinc-200 px-4 py-3 text-left transition hover:border-[#007c72]" key={product.id} type="button" onClick={() => addProduct(product)}>
                <span className="block font-semibold">{product.name}</span>
                <span className="mt-1 block text-xs text-zinc-500">{product.stock} pz</span>
                <span className="mt-2 block text-right font-semibold">{product.price}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-4">
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold" type="button" onClick={() => onOpenSection("packages")}>
              <Package size={15} aria-hidden />
              Pacchetti
            </button>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold" type="button" onClick={() => onOpenSection("recharges")}>
              <WalletCards size={15} aria-hidden />
              Ricariche
            </button>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold" type="button" onClick={() => onOpenSection("giftbox")}>
              <Gift size={15} aria-hidden />
              GiftBox
            </button>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold" type="button" onClick={() => onOpenSection("giftcard")}>
              <CreditCard size={15} aria-hidden />
              GiftCard
            </button>
          </div>
        </div>
      </section>

      <aside className="overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
        <div className="flex h-14 items-center border-b border-zinc-100 px-4">
          <h2 className="font-semibold">Dettaglio prezzi</h2>
        </div>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-semibold">Fidelity: {selectedClient ? formatEuro(clientWallet?.credit ?? 0) : "-"}</span>
            <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-semibold">Punti: {clientWallet?.points ?? 0}</span>
          </div>
          <p className="text-sm text-zinc-500">
            {selectedClient
              ? clientGiftCards.length
                ? `${clientGiftCards.length} GiftCard attive per ${formatEuro(clientGiftCards.reduce((sum, card) => sum + card.balance, 0))}.`
                : "Nessuna GiftCard attiva per il cliente selezionato."
              : "Seleziona un cliente per vedere credito disponibile."}
          </p>

          <div>
            <p className="mb-1 text-sm font-medium text-zinc-600">Coupon</p>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-sm font-semibold">Promozioni / Coupon</p>
              <button className="mt-1 text-sm text-[#007c72] underline" type="button" onClick={() => setCouponVisible((value) => !value)}>Hai un codice coupon?</button>
              {couponVisible ? (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 px-3 text-sm"
                      placeholder="ES. WELCOME10"
                      value={couponCode}
                      onChange={(event) => {
                        const nextCode = event.target.value;
                        setCouponCode(nextCode);
                        if (!nextCode.trim()) {
                          setCouponPreview(null);
                          setCouponLoading(false);
                        }
                      }}
                    />
                    <button
                      className="h-9 rounded-md border border-zinc-200 px-3 text-sm font-semibold"
                      type="button"
                      onClick={() => {
                        setCouponCode("");
                        setCouponPreview(null);
                        setCouponLoading(false);
                      }}
                    >
                      Rimuovi
                    </button>
                  </div>
                  {couponCode.trim() ? (
                    <p className={`text-xs ${couponPreview?.valid ? "text-emerald-700" : "text-red-600"}`}>
                      {couponLoading
                        ? "Verifica coupon..."
                        : couponPreview?.valid
                          ? `Coupon applicabile: - ${formatEuro(couponDiscount)}`
                          : couponPreview?.reason ?? "Coupon non valido."}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2">
            <label>
              <span className="mb-1 block text-sm font-medium text-zinc-600">Sconto</span>
              <select className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm" value={discountType} onChange={(event) => setDiscountType(event.target.value as PosDiscountType)}>
                <option value="none">Nessuno</option>
                <option value="percent">%</option>
                <option value="fixed">Euro</option>
              </select>
            </label>
            <label>
              <span className="mb-1 block text-sm font-medium text-zinc-600">&nbsp;</span>
              <input className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm" min={0} step="0.01" type="number" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} />
            </label>
          </div>

          <div className="rounded-md border border-zinc-200 p-3">
            <p className="mb-2 text-sm text-zinc-500">Tipo pagamento</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["cash", "Contanti"],
                ["card", "Carta"],
                ["check", "Assegno"],
                ["bank", "Bonifico"],
              ].map(([value, label]) => (
                <button
                  className={`h-10 rounded-md border text-sm font-semibold transition ${paymentMethod === value ? "border-[#007c72] bg-emerald-50 text-[#007c72]" : "border-zinc-200 bg-zinc-50 text-zinc-500"} disabled:opacity-50`}
                  disabled={payableTotal <= 0}
                  key={value}
                  type="button"
                  onClick={() => setPaymentMethod(value as PosPaymentChoice)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-500">{payableTotal <= 0 ? "Totale a 0: nessun tipo di pagamento selezionabile." : "Seleziona come paga il cliente."}</p>
          </div>

          <div className="rounded-md border border-zinc-200 p-3">
            <p className="mb-2 text-sm text-zinc-500">Pagamento unico / rateizzato</p>
            <div className="grid grid-cols-2 gap-2">
              <button className="h-10 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-500" type="button">Pagamento unico</button>
              <button className="h-10 rounded-md border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-500" type="button">Rateizzato</button>
            </div>
          </div>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span>Subtotale</span><strong>{formatEuro(subtotal)}</strong></div>
            {manualDiscount > 0 ? <div className="flex justify-between text-zinc-500"><span>Sconto</span><span>- {formatEuro(manualDiscount)}</span></div> : null}
            {couponCode.trim() ? (
              <div className="flex justify-between text-zinc-500">
                <span>Coupon</span>
                <span>{couponLoading ? "verifica..." : couponPreview?.valid ? `- ${formatEuro(couponDiscount)}` : couponPreview?.reason ?? "non valido"}</span>
              </div>
            ) : null}
            <hr />
            <div className="flex justify-between"><span>Totale</span><strong>{formatEuro(payableTotal)}</strong></div>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Note</span>
            <textarea className="min-h-20 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" placeholder="Note interne..." value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <button
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#2ca66f] px-4 text-sm font-semibold text-white transition hover:bg-[#248c5f] disabled:cursor-not-allowed disabled:bg-zinc-300"
            disabled={!cartLines.length || !locationId || couponLoading || Boolean(couponCode.trim() && couponPreview?.valid === false)}
          >
            <Check size={16} aria-hidden />
            Concludi
          </button>
          {feedback ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
        </div>
      </aside>
    </form>
  );
}

function PosSalesHistory({ sales, onCancel }: { sales: PosSale[]; onCancel: (id: number) => void }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">Storico vendite</h2>
      <div className="mt-3 divide-y divide-zinc-100">
        {sales.map((sale) => (
          <div className="grid gap-3 py-4 md:grid-cols-[120px_minmax(0,1fr)_120px_130px]" key={sale.id}>
            <div>
              <p className="font-semibold">{sale.code}</p>
              <p className="text-sm text-zinc-500">{sale.status === "cancelled" ? "Annullata" : "Attiva"}</p>
            </div>
            <div className="min-w-0">
              <p className="font-medium">{sale.clientName}</p>
              <p className="truncate text-sm text-zinc-600">{sale.items.map((item) => item.name).join(", ")}</p>
            </div>
            <p className="font-semibold">{formatEuro(sale.total)}</p>
            <div className="flex md:justify-end">
              {sale.status !== "cancelled" ? (
                <button
                  className="h-9 rounded-md border border-zinc-200 px-3 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700"
                  type="button"
                  onClick={() => onCancel(sale.id)}
                >
                  Annulla
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function discountAmount(type: PosDiscountType, raw: string, subtotal: number): number {
  const value = Math.max(0, Number.parseFloat(String(raw || "0").replace(",", ".")) || 0);
  if (type === "percent") return roundPosMoney(Math.min(subtotal, subtotal * value / 100));
  if (type === "fixed") return roundPosMoney(Math.min(subtotal, value));
  return 0;
}

function roundPosMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatEuro(value: number): string {
  return `${roundPosMoney(value).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} euro`;
}

function moneyFromLabel(value: string | undefined): number {
  const normalized = String(value ?? "0")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ReportsView() {
  const [report, setReport] = useState<{
    kpis?: { activeSales: number; revenue: number; cancelledRevenue: number; averageTicket: number; clients: number; lowStock: number };
    paymentTotals?: Record<string, number>;
    mix?: { services: number; products: number };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/manage/reports")
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <MetricTile label="Ricavi" value={`${report?.kpis?.revenue ?? 0} euro`} detail="vendite attive" />
        <MetricTile label="Ticket medio" value={`${report?.kpis?.averageTicket ?? 0} euro`} detail="storico POS" />
        <MetricTile label="Sotto scorta" value={`${report?.kpis?.lowStock ?? 0}`} detail="prodotti da riordinare" />
      </div>
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Mix incassi</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <MetricTile label="Servizi" value={`${report?.mix?.services ?? 0} euro`} detail="prestazioni vendute" />
          <MetricTile label="Prodotti" value={`${report?.mix?.products ?? 0} euro`} detail="retail venduto" />
        </div>
      </section>
    </section>
  );
}

function MetricTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-zinc-600">{detail}</p>
    </article>
  );
}

type OperationsPayload = {
  summary?: { open?: number; overdue?: number; paid?: number; dueAmount?: number; reversed?: number };
  costs?: CostItem[];
  quotes?: Quote[];
  clients?: Array<ManagedClient & { wallet?: { credit: number; points: number } }>;
  movements?: WalletMovement[];
  giftCards?: GiftCard[];
  notifications?: NotificationItem[];
  rules?: AutomationRule[];
  module?: ConfigModuleState;
  records?: ConfigRecord[];
  catalog?: PackageCatalog[];
  clientPackages?: ClientPackage[];
  prepaids?: ClientPrepaid[];
  preorders?: Preorder[];
  coupons?: CouponRule[];
  promotions?: PromotionRule[];
  giftBoxes?: GiftBoxInstance[];
  gifts?: GiftReward[];
  plans?: InstallmentPlan[];
  commissions?: CommissionEntry[];
};

type OperationConfig = { title: string; endpoint: string; source: string; actionLabel: string };

const operationsConfig: Record<string, OperationConfig> = {
  costs: { title: "Scadenziario e Costi", endpoint: "/api/manage/costs", source: "costs.php", actionLabel: "Salda scadenza" },
  quotes: { title: "Preventivi", endpoint: "/api/manage/quotes", source: "quotes.php", actionLabel: "Converti preventivo" },
  fidelity: { title: "Fidelity", endpoint: "/api/manage/fidelity", source: "fidelity.php", actionLabel: "Ricarica credito" },
  fidelity_points: { title: "Punti", endpoint: "/api/manage/fidelity", source: "fidelity_points.php", actionLabel: "Rettifica punti" },
  wallet: { title: "Portafoglio", endpoint: "/api/manage/fidelity", source: "wallet.php", actionLabel: "Ricarica credito" },
  recharges: { title: "Ricariche", endpoint: "/api/manage/fidelity", source: "recharges.php", actionLabel: "Ricarica credito" },
  giftcard: { title: "GiftCard", endpoint: "/api/manage/giftcards", source: "giftcard.php", actionLabel: "Emetti GiftCard" },
  notifications: { title: "Notifiche", endpoint: "/api/manage/notifications", source: "notifications.php", actionLabel: "Segna letta" },
  automation: { title: "Automazione", endpoint: "/api/manage/automation", source: "automation.php", actionLabel: "Esegui regola" },
  pos_prepaids: { title: "Prepagati", endpoint: "/api/manage/prepaids", source: "pos_prepaids.php", actionLabel: "Usa residuo" },
  pos_preorders: { title: "Preordini", endpoint: "/api/manage/preorders", source: "pos_preorders.php", actionLabel: "Ritira prodotto" },
  installments_manage: { title: "Gestione Rate", endpoint: "/api/manage/installments", source: "installments_manage.php", actionLabel: "Incassa rata" },
  commissions: { title: "Commissioni", endpoint: "/api/manage/commissions", source: "commissions.php", actionLabel: "Liquida commissione" },
  coupons: { title: "Buoni", endpoint: "/api/manage/coupons", source: "coupons.php", actionLabel: "Prova coupon" },
  packages: { title: "Pacchetti", endpoint: "/api/manage/packages", source: "packages.php", actionLabel: "Usa seduta" },
  promotions: { title: "Promozioni", endpoint: "/api/manage/promotions", source: "promotions.php", actionLabel: "Prova promozione" },
  gifts: { title: "Omaggi", endpoint: "/api/manage/gifts", source: "gifts.php", actionLabel: "Riscatta omaggio" },
  giftbox: { title: "GiftBox", endpoint: "/api/manage/giftboxes", source: "giftbox.php", actionLabel: "Riscatta GiftBox" },
};

const configurationSectionIds = new Set([
  "quote_settings",
  "pos_settings",
  "cost_categories",
  "product_categories",
  "stock_moves",
  "suppliers",
  "client_sheets",
  "client_sheet_templates",
  "client_consents",
  "package_settings",
  "resources",
  "service_categories",
  "service_recommendations",
  "cabins",
  "staff",
  "staff_availability",
  "hours",
  "business_profile",
  "locations",
  "consent_modules",
  "accessibility",
  "roles",
  "marketplace",
  "fidelity_membership",
  "fidelity_levels",
  "giftbox_settings",
  "giftcard_settings",
]);

const serviceSectionIds = new Set(["services", "service_categories", "service_recommendations"]);
const productSectionIds = new Set(["products", "product_categories", "stock_moves", "suppliers"]);
const costSectionIds = new Set(["costs", "cost_categories"]);
const resourceSectionIds = new Set(["resources", "cabins", "staff", "staff_availability", "hours"]);
const businessSettingsSectionIds = new Set(["business_profile", "locations", "marketplace"]);

function isServiceSection(section: string): boolean {
  return serviceSectionIds.has(section);
}

function isProductSection(section: string): boolean {
  return productSectionIds.has(section);
}

function isCostSection(section: string): boolean {
  return costSectionIds.has(section);
}

function isResourceSection(section: string): boolean {
  return resourceSectionIds.has(section);
}

function isBusinessSettingsSection(section: string): boolean {
  return businessSettingsSectionIds.has(section);
}

function isOperationsSection(section: string): boolean {
  return Boolean(operationsConfig[section]) || configurationSectionIds.has(section);
}

function operationConfigFor(section: string): OperationConfig {
  const directConfig = operationsConfig[section];
  if (directConfig) return directConfig;
  const feature = allFeatures.find((item) => item.id === section);
  return {
    title: feature?.label ?? section.replace(/_/g, " "),
    endpoint: `/api/manage/configuration?module=${encodeURIComponent(section)}`,
    source: feature?.source ?? `${section}.php`,
    actionLabel: "Aggiorna",
  };
}

function OperationsView({ section }: { section: string }) {
  const config = operationConfigFor(section);
  const [payload, setPayload] = useState<OperationsPayload>({});
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch(config.endpoint)
      .then((response) => response.json() as Promise<OperationsPayload>)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Modulo non caricato.");
      });

    return () => {
      cancelled = true;
    };
  }, [config.endpoint]);

  if (section === "accessibility") return <AccessibilityView />;
  if (section === "roles") return <RolesView />;

  async function runPrimaryAction() {
    const body = operationActionBody(section, payload);
    if (!body) {
      setFeedback("Nessuna azione disponibile.");
      return;
    }

    const data = await postManageApi<OperationsPayload>(config.endpoint, body);
    setPayload((current) => ({ ...current, ...data }));
    setFeedback(data.error ?? "Azione completata.");
  }

  const rows = operationRows(section, payload);

  return (
    <section className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{config.source}</p>
            <h2 className="mt-1 text-lg font-semibold">{config.title}</h2>
          </div>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]"
            type="button"
            onClick={runPrimaryAction}
          >
            <Check size={16} aria-hidden />
            {config.actionLabel}
          </button>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {operationMetrics(section, payload).map((metric) => (
          <MetricTile detail={metric.detail} key={metric.label} label={metric.label} value={metric.value} />
        ))}
      </div>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Registro</h2>
        <div className="mt-3 divide-y divide-zinc-100">
          {rows.map((row) => (
            <div className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_130px]" key={row.id}>
              <div className="min-w-0">
                <p className="font-medium">{row.title}</p>
                <p className="truncate text-sm text-zinc-600">{row.detail}</p>
              </div>
              <p className="font-semibold md:text-right">{row.value}</p>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

type ResourceTab = "resources" | "cabins" | "staff" | "staff_availability" | "hours";

const resourceTabs: Array<{ id: ResourceTab; label: string }> = [
  { id: "resources", label: "Risorse" },
  { id: "cabins", label: "Cabine" },
  { id: "staff", label: "Operatori" },
  { id: "staff_availability", label: "Disponibilita" },
  { id: "hours", label: "Orari" },
];

function ResourceSettingsView({ section, tenantSlug }: { section: string; tenantSlug: string }) {
  const [activeTab, setActiveTab] = useState<ResourceTab>(normalizeResourceTab(section));
  const [payload, setPayload] = useState<ResourcePayload>(() => emptyResourcePayload());
  const [locationId, setLocationId] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ section: activeTab, slug: tenantSlug });
    if (locationId > 0) params.set("location_id", String(locationId));

    fetch(`/api/manage/resources?${params.toString()}`)
      .then((response) => response.json() as Promise<ResourcePayload>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setPayload(data);
        if (!locationId && data.activeLocationId) setLocationId(data.activeLocationId);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Modulo risorse non caricato.");
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, locationId, reloadKey, tenantSlug]);

  async function runResourceAction(body: Record<string, string>) {
    const data = await postManageApi<ResourcePayload>(`/api/manage/resources?slug=${encodeURIComponent(tenantSlug)}`, body);
    setFeedback(data.error ?? "Operazione completata.");
    if (!data.error) setReloadKey((value) => value + 1);
    return data;
  }

  return (
    <section className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{payload.source ?? "app/pages/resources.php"}</p>
            <h2 className="mt-1 text-lg font-semibold">Risorse operative</h2>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-1">
              {resourceTabs.map((tab) => (
                <button
                  className={`h-9 rounded px-3 text-sm font-semibold transition ${activeTab === tab.id ? "bg-white text-[#173262] shadow-sm" : "text-zinc-600 hover:text-zinc-950"}`}
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <select
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm"
              value={locationId}
              onChange={(event) => setLocationId(Number(event.target.value))}
            >
              {payload.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </div>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricTile detail="con quantita e sedi" label="Risorse" value={String(payload.resources.length)} />
        <MetricTile detail="sale attive" label="Cabine" value={String(payload.cabins.length)} />
        <MetricTile detail="abilitati" label="Operatori" value={String(payload.staff.filter((item) => item.isActive).length)} />
        <MetricTile detail="turni e assenze" label="Disponibilita" value={String(payload.availability.length)} />
      </div>

      {activeTab === "resources" ? <SharedResourcesPanel locationId={locationId} payload={payload} runAction={runResourceAction} /> : null}
      {activeTab === "cabins" ? <CabinsPanel locationId={locationId} payload={payload} runAction={runResourceAction} /> : null}
      {activeTab === "staff" ? <StaffPanel payload={payload} runAction={runResourceAction} /> : null}
      {activeTab === "staff_availability" ? <StaffAvailabilityPanel locationId={locationId} payload={payload} runAction={runResourceAction} /> : null}
      {activeTab === "hours" ? (
        <HoursPanel
          key={`hours-${locationId}-${payload.hours.map((row) => `${row.dow}:${row.opens}:${row.closes}:${row.opens2}:${row.closes2}:${row.isClosed}`).join("|")}`}
          locationId={locationId}
          payload={payload}
          runAction={runResourceAction}
        />
      ) : null}
    </section>
  );
}

function SharedResourcesPanel({
  locationId,
  payload,
  runAction,
}: {
  locationId: number;
  payload: ResourcePayload;
  runAction: (body: Record<string, string>) => Promise<object>;
}) {
  const [draft, setDraft] = useState({ id: 0, name: "", description: "", qtyTotal: "1", isEnabled: true });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({
      action: "resource_save",
      id: draft.id ? String(draft.id) : "",
      name: draft.name,
      description: draft.description,
      qty_total: draft.qtyTotal,
      locations_json: JSON.stringify([{ locationId, qtyTotal: Number(draft.qtyTotal || 0), isEnabled: draft.isEnabled }]),
    });
    setDraft({ id: 0, name: "", description: "", qtyTotal: "1", isEnabled: true });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={submit}>
        <h3 className="text-base font-semibold">{draft.id ? "Modifica risorsa" : "Nuova risorsa"}</h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">
            Nome
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Descrizione
            <textarea className="mt-1 min-h-24 w-full rounded-md border border-zinc-300 px-3 py-2" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Quantita contemporanea
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" min={0} type="number" value={draft.qtyTotal} onChange={(event) => setDraft((current) => ({ ...current, qtyTotal: event.target.value }))} />
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input checked={draft.isEnabled} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, isEnabled: event.target.checked }))} />
            Attiva nella sede selezionata
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button className="inline-flex h-10 items-center rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva</button>
          {draft.id ? (
            <button className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-semibold" type="button" onClick={() => setDraft({ id: 0, name: "", description: "", qtyTotal: "1", isEnabled: true })}>Annulla</button>
          ) : null}
        </div>
      </form>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Risorse condivise</h3>
        <div className="mt-3 divide-y divide-zinc-100">
          {payload.resources.map((resource) => (
            <div className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_180px_160px]" key={resource.id}>
              <div className="min-w-0">
                <p className="font-semibold">{resource.name}</p>
                <p className="text-sm text-zinc-600">{resource.description || "Nessuna descrizione"}</p>
                <p className="mt-1 text-xs text-zinc-500">{resource.locations.map((location) => `${location.locationName}: ${location.isEnabled ? location.qtyTotal : "off"}`).join(" - ") || "Tutte le sedi"}</p>
              </div>
              <p className="text-sm text-zinc-600">{linkedServicesLabel(resource.serviceLinks)}</p>
              <div className="flex justify-end gap-2">
                <button className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold" type="button" onClick={() => setDraft({ id: resource.id, name: resource.name, description: resource.description, qtyTotal: String(resource.qtyTotal), isEnabled: true })}>Modifica</button>
                <button className="h-9 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700" type="button" onClick={() => runAction({ action: "resource_delete", id: String(resource.id) })}>Elimina</button>
              </div>
            </div>
          ))}
          {payload.resources.length === 0 ? <p className="py-8 text-sm text-zinc-600">Nessuna risorsa configurata.</p> : null}
        </div>
      </section>
    </div>
  );
}

function CabinsPanel({
  locationId,
  payload,
  runAction,
}: {
  locationId: number;
  payload: ResourcePayload;
  runAction: (body: Record<string, string>) => Promise<object>;
}) {
  const [draft, setDraft] = useState({ id: 0, name: "", position: "1", isActive: true });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({
      action: "cabin_save",
      id: draft.id ? String(draft.id) : "",
      name: draft.name,
      position: draft.position,
      is_active: draft.isActive ? "1" : "0",
      location_id: String(locationId),
    });
    setDraft({ id: 0, name: "", position: "1", isActive: true });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={submit}>
        <h3 className="text-base font-semibold">{draft.id ? "Modifica cabina" : "Nuova cabina"}</h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">
            Nome cabina
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Posizione
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" min={1} type="number" value={draft.position} onChange={(event) => setDraft((current) => ({ ...current, position: event.target.value }))} />
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input checked={draft.isActive} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} />
            Attiva
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva</button>
          {draft.id ? <button className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-semibold" type="button" onClick={() => setDraft({ id: 0, name: "", position: "1", isActive: true })}>Annulla</button> : null}
        </div>
      </form>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Cabine attive</h3>
        <div className="mt-3 divide-y divide-zinc-100">
          {payload.cabins.map((cabin) => (
            <div className="grid gap-3 py-3 md:grid-cols-[80px_minmax(0,1fr)_180px_150px]" key={cabin.id}>
              <p className="font-semibold">#{cabin.position}</p>
              <div>
                <p className="font-semibold">{cabin.name}</p>
                <p className="text-sm text-zinc-600">{cabin.locationName}</p>
              </div>
              <p className="text-sm text-zinc-600">{linkedServicesLabel(cabin.serviceLinks)}</p>
              <div className="flex justify-end gap-2">
                <button className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold" type="button" onClick={() => setDraft({ id: cabin.id, name: cabin.name, position: String(cabin.position || 1), isActive: cabin.isActive })}>Modifica</button>
                <button className="h-9 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700" type="button" onClick={() => runAction({ action: "cabin_delete", id: String(cabin.id) })}>Elimina</button>
              </div>
            </div>
          ))}
          {payload.cabins.length === 0 ? <p className="py-8 text-sm text-zinc-600">Nessuna cabina configurata.</p> : null}
        </div>
      </section>
    </div>
  );
}

function StaffPanel({
  payload,
  runAction,
}: {
  payload: ResourcePayload;
  runAction: (body: Record<string, string>) => Promise<object>;
}) {
  const [draft, setDraft] = useState({
    id: 0,
    fullName: "",
    email: "",
    phone: "",
    password: "",
    role: "staff",
    color: "#0f766e",
    isActive: true,
    locationIds: [] as number[],
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({
      action: "staff_save",
      id: draft.id ? String(draft.id) : "",
      full_name: draft.fullName,
      email: draft.email,
      phone: draft.phone,
      password: draft.password,
      role: draft.role,
      calendar_color: draft.color,
      is_active: draft.isActive ? "1" : "0",
      location_ids: draft.locationIds.join(","),
    });
    setDraft({ id: 0, fullName: "", email: "", phone: "", password: "", role: "staff", color: "#0f766e", isActive: true, locationIds: [] });
  }

  function toggleLocation(locationId: number, checked: boolean) {
    setDraft((current) => ({
      ...current,
      locationIds: checked
        ? Array.from(new Set([...current.locationIds, locationId]))
        : current.locationIds.filter((id) => id !== locationId),
    }));
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[430px_minmax(0,1fr)]">
      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={submit}>
        <h3 className="text-base font-semibold">{draft.id ? "Modifica operatore" : "Nuovo operatore"}</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium sm:col-span-2">
            Nome operatore
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required value={draft.fullName} onChange={(event) => setDraft((current) => ({ ...current, fullName: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Ruolo
            <select className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
              <option value="altro">Personalizzato</option>
            </select>
          </label>
          <label className="block text-sm font-medium">
            Colore
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-2" type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Email
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required={!draft.id} type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required={!draft.id} type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium sm:col-span-2">
            Telefono
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
          </label>
          <div className="sm:col-span-2">
            <p className="text-sm font-medium">Sedi abilitate</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {payload.locations.map((location) => (
                <label className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm" key={location.id}>
                  <input checked={draft.locationIds.includes(location.id)} type="checkbox" onChange={(event) => toggleLocation(location.id, event.target.checked)} />
                  {location.name}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input checked={draft.isActive} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))} />
            Attivo
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva</button>
          {draft.id ? <button className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-semibold" type="button" onClick={() => setDraft({ id: 0, fullName: "", email: "", phone: "", password: "", role: "staff", color: "#0f766e", isActive: true, locationIds: [] })}>Annulla</button> : null}
        </div>
      </form>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Operatori</h3>
        <div className="mt-3 divide-y divide-zinc-100">
          {payload.staff.map((staff) => (
            <div className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_120px_180px_170px]" key={staff.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: staff.color }} />
                  <p className="font-semibold">{staff.fullName}</p>
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${staff.isActive ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-700"}`}>{staff.isActive ? "Attivo" : "Non attivo"}</span>
                </div>
                <p className="mt-1 text-sm text-zinc-600">{staff.email || "email non configurata"} · {staff.phone || "telefono non configurato"}</p>
              </div>
              <p className="text-sm font-semibold capitalize">{staff.role}</p>
              <p className="text-sm text-zinc-600">{staff.locations.slice(0, 3).map((location) => location.name).join(", ") || "Tutte"}</p>
              <div className="flex justify-end gap-2">
                <button
                  className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold"
                  type="button"
                  onClick={() => setDraft({ id: staff.id, fullName: staff.fullName, email: staff.email, phone: staff.phone, password: "", role: staff.role, color: staff.color, isActive: staff.isActive, locationIds: staff.locationIds })}
                >
                  Modifica
                </button>
                <button className="h-9 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700" disabled={staff.isOwner} type="button" onClick={() => runAction({ action: "staff_delete", id: String(staff.id) })}>Elimina</button>
              </div>
            </div>
          ))}
          {payload.staff.length === 0 ? <p className="py-8 text-sm text-zinc-600">Nessun operatore configurato.</p> : null}
        </div>
      </section>
    </div>
  );
}

function HoursPanel({
  locationId,
  payload,
  runAction,
}: {
  locationId: number;
  payload: ResourcePayload;
  runAction: (body: Record<string, string>) => Promise<object>;
}) {
  const [hoursDraft, setHoursDraft] = useState<BusinessHourRow[]>(payload.hours);
  const [closureDraft, setClosureDraft] = useState({ from: "", to: "", kind: "Chiusura", note: "" });
  const [exceptionDraft, setExceptionDraft] = useState({ from: "", to: "", opens: "09:00", closes: "19:00", opens2: "", closes2: "", note: "" });

  async function saveHours() {
    await runAction({
      action: "hours_save",
      location_id: String(locationId),
      hours_json: JSON.stringify(hoursDraft.map((row) => ({
        dow: row.dow,
        opens: row.opens,
        closes: row.closes,
        opens2: row.opens2,
        closes2: row.closes2,
        is_closed: row.isClosed,
      }))),
    });
  }

  function updateHour(dow: number, values: Partial<BusinessHourRow>) {
    setHoursDraft((current) => current.map((row) => row.dow === dow ? { ...row, ...values } : row));
  }

  return (
    <div className="space-y-5">
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Orari settimanali</h3>
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="button" onClick={saveHours}>Salva orari</button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
              <tr><th className="py-2">Giorno</th><th>Apertura</th><th>Chiusura</th><th>Riapertura</th><th>Chiusura 2</th><th>Chiuso</th></tr>
            </thead>
            <tbody>
              {hoursDraft.map((row) => (
                <tr className="border-b border-zinc-100" key={row.dow}>
                  <td className="py-2 font-semibold">{row.dayLabel}</td>
                  <td><input className="h-9 rounded-md border border-zinc-300 px-2" disabled={row.isClosed} type="time" value={row.opens} onChange={(event) => updateHour(row.dow, { opens: event.target.value })} /></td>
                  <td><input className="h-9 rounded-md border border-zinc-300 px-2" disabled={row.isClosed} type="time" value={row.closes} onChange={(event) => updateHour(row.dow, { closes: event.target.value })} /></td>
                  <td><input className="h-9 rounded-md border border-zinc-300 px-2" disabled={row.isClosed} type="time" value={row.opens2} onChange={(event) => updateHour(row.dow, { opens2: event.target.value })} /></td>
                  <td><input className="h-9 rounded-md border border-zinc-300 px-2" disabled={row.isClosed} type="time" value={row.closes2} onChange={(event) => updateHour(row.dow, { closes2: event.target.value })} /></td>
                  <td><input checked={row.isClosed} type="checkbox" onChange={(event) => updateHour(row.dow, { isClosed: event.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <h3 className="text-base font-semibold">Chiusure</h3>
          <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => {
            event.preventDefault();
            runAction({ action: "closure_save", location_id: String(locationId), date_from: closureDraft.from, date_to: closureDraft.to, kind: closureDraft.kind, note: closureDraft.note });
            setClosureDraft({ from: "", to: "", kind: "Chiusura", note: "" });
          }}>
            <input className="h-10 rounded-md border border-zinc-300 px-3" required type="date" value={closureDraft.from} onChange={(event) => setClosureDraft((current) => ({ ...current, from: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="date" value={closureDraft.to} onChange={(event) => setClosureDraft((current) => ({ ...current, to: event.target.value }))} />
            <select className="h-10 rounded-md border border-zinc-300 px-3" value={closureDraft.kind} onChange={(event) => setClosureDraft((current) => ({ ...current, kind: event.target.value }))}>
              <option>Chiusura</option>
              <option>Ferie</option>
            </select>
            <input className="h-10 rounded-md border border-zinc-300 px-3" placeholder="Nota" value={closureDraft.note} onChange={(event) => setClosureDraft((current) => ({ ...current, note: event.target.value }))} />
            <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white sm:col-span-2" type="submit">Salva chiusura</button>
          </form>
          <RangeList ranges={payload.closures} onDelete={(range) => runAction({ action: "closure_delete_range", location_id: String(locationId), from: range.end, to: range.start, reason: range.reason })} />
        </section>

        <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <h3 className="text-base font-semibold">Straordinari</h3>
          <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => {
            event.preventDefault();
            runAction({ action: "exception_save", location_id: String(locationId), date_from: exceptionDraft.from, date_to: exceptionDraft.to, opens: exceptionDraft.opens, closes: exceptionDraft.closes, opens2: exceptionDraft.opens2, closes2: exceptionDraft.closes2, note: exceptionDraft.note });
            setExceptionDraft({ from: "", to: "", opens: "09:00", closes: "19:00", opens2: "", closes2: "", note: "" });
          }}>
            <input className="h-10 rounded-md border border-zinc-300 px-3" required type="date" value={exceptionDraft.from} onChange={(event) => setExceptionDraft((current) => ({ ...current, from: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="date" value={exceptionDraft.to} onChange={(event) => setExceptionDraft((current) => ({ ...current, to: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" required type="time" value={exceptionDraft.opens} onChange={(event) => setExceptionDraft((current) => ({ ...current, opens: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" required type="time" value={exceptionDraft.closes} onChange={(event) => setExceptionDraft((current) => ({ ...current, closes: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="time" value={exceptionDraft.opens2} onChange={(event) => setExceptionDraft((current) => ({ ...current, opens2: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="time" value={exceptionDraft.closes2} onChange={(event) => setExceptionDraft((current) => ({ ...current, closes2: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3 sm:col-span-2" placeholder="Nota" value={exceptionDraft.note} onChange={(event) => setExceptionDraft((current) => ({ ...current, note: event.target.value }))} />
            <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white sm:col-span-2" type="submit">Salva straordinario</button>
          </form>
          <div className="mt-4 divide-y divide-zinc-100">
            {payload.exceptions.map((range) => (
              <div className="flex items-center justify-between gap-3 py-2" key={`${range.start}-${range.end}-${range.opens}`}>
                <p className="text-sm"><span className="font-semibold">{formatRange(range)}</span> · {range.opens}-{range.closes}{range.opens2 ? ` / ${range.opens2}-${range.closes2}` : ""}</p>
                <button className="h-8 rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700" type="button" onClick={() => runAction({ action: "exception_delete_range", location_id: String(locationId), from: range.end, to: range.start })}>Elimina</button>
              </div>
            ))}
            {payload.exceptions.length === 0 ? <p className="py-4 text-sm text-zinc-600">Nessuno straordinario.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function StaffAvailabilityPanel({
  locationId,
  payload,
  runAction,
}: {
  locationId: number;
  payload: ResourcePayload;
  runAction: (body: Record<string, string>) => Promise<object>;
}) {
  const [draft, setDraft] = useState({
    staffId: "",
    type: "turno",
    dateFrom: todayIso(),
    dateTo: todayIso(),
    timeFrom: "09:00",
    timeTo: "13:00",
    repeat: "none",
    repeatUntil: "",
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({
      action: "availability_save",
      location_id: String(locationId),
      staff_id: draft.staffId,
      event_type: draft.type,
      date_from: draft.dateFrom,
      date_to: draft.dateTo,
      time_from: draft.timeFrom,
      time_to: draft.timeTo,
      repeat: draft.repeat,
      repeat_until: draft.repeatUntil,
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[370px_minmax(0,1fr)]">
      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={submit}>
        <h3 className="text-base font-semibold">Nuovo evento</h3>
        <div className="mt-4 space-y-3">
          <select className="h-10 w-full rounded-md border border-zinc-300 px-3" required value={draft.staffId} onChange={(event) => setDraft((current) => ({ ...current, staffId: event.target.value }))}>
            <option value="">Operatore</option>
            {payload.staff.filter((staff) => staff.isActive).map((staff) => <option key={staff.id} value={staff.id}>{staff.fullName}</option>)}
          </select>
          <select className="h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))}>
            <option value="turno">Turno</option>
            <option value="presenza">Presenza</option>
            <option value="ferie">Ferie</option>
            <option value="malattia">Malattia</option>
            <option value="assenza">Assenza</option>
          </select>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="date" value={draft.dateFrom} onChange={(event) => setDraft((current) => ({ ...current, dateFrom: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="date" value={draft.dateTo} onChange={(event) => setDraft((current) => ({ ...current, dateTo: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="time" value={draft.timeFrom} onChange={(event) => setDraft((current) => ({ ...current, timeFrom: event.target.value }))} />
            <input className="h-10 rounded-md border border-zinc-300 px-3" type="time" value={draft.timeTo} onChange={(event) => setDraft((current) => ({ ...current, timeTo: event.target.value }))} />
          </div>
          <select className="h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.repeat} onChange={(event) => setDraft((current) => ({ ...current, repeat: event.target.value }))}>
            <option value="none">Non ripetere</option>
            <option value="w1">Ogni settimana</option>
            <option value="w2">Ogni 2 settimane</option>
            <option value="w3">Ogni 3 settimane</option>
            <option value="m1">Ogni mese</option>
          </select>
          {draft.repeat !== "none" ? <input className="h-10 w-full rounded-md border border-zinc-300 px-3" type="date" value={draft.repeatUntil} onChange={(event) => setDraft((current) => ({ ...current, repeatUntil: event.target.value }))} /> : null}
        </div>
        <button className="mt-4 h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva evento</button>
      </form>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Settimana corrente</h3>
        <div className="mt-3 divide-y divide-zinc-100">
          {payload.availability.map((event) => (
            <div className="grid gap-3 py-3 md:grid-cols-[150px_minmax(0,1fr)_140px]" key={`${event.table}-${event.id}-${event.startsAt}`}>
              <p className="font-semibold">{event.staffName}</p>
              <div>
                <p className="text-sm font-medium capitalize">{event.type}</p>
                <p className="text-sm text-zinc-600">{event.dateFrom}{event.dateTo !== event.dateFrom ? ` - ${event.dateTo}` : ""} · {event.timeFrom}-{event.timeTo}</p>
              </div>
              <div className="text-right">
                <button className="h-8 rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700" type="button" onClick={() => runAction({ action: "availability_delete", id: String(event.id), table: event.table, location_id: String(locationId), date: event.dateFrom })}>Elimina</button>
              </div>
            </div>
          ))}
          {payload.availability.length === 0 ? <p className="py-8 text-sm text-zinc-600">Nessun turno o assenza nella settimana.</p> : null}
        </div>
      </section>
    </div>
  );
}

function RangeList({ ranges, onDelete }: { ranges: CalendarDateRange[]; onDelete: (range: CalendarDateRange) => void }) {
  return (
    <div className="mt-4 divide-y divide-zinc-100">
      {ranges.map((range) => (
        <div className="flex items-center justify-between gap-3 py-2" key={`${range.start}-${range.end}-${range.reason}`}>
          <p className="text-sm"><span className="font-semibold">{formatRange(range)}</span> · {range.reason || "Chiusura"}</p>
          <button className="h-8 rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700" type="button" onClick={() => onDelete(range)}>Elimina</button>
        </div>
      ))}
      {ranges.length === 0 ? <p className="py-4 text-sm text-zinc-600">Nessuna chiusura.</p> : null}
    </div>
  );
}

function normalizeResourceTab(section: string): ResourceTab {
  return resourceTabs.some((tab) => tab.id === section) ? section as ResourceTab : "resources";
}

function emptyResourcePayload(): ResourcePayload {
  return {
    activeLocationId: 0,
    locations: [],
    services: [],
    resources: [],
    cabins: [],
    staff: [],
    hours: [],
    closures: [],
    exceptions: [],
    availability: [],
  };
}

function linkedServicesLabel(links: ResourceLinkedService[]): string {
  if (!links.length) return "Nessun servizio";
  const sample = links.slice(0, 2).map((link) => link.qtyRequired ? `${link.serviceName} x${link.qtyRequired}` : link.serviceName).join(", ");
  return links.length > 2 ? `${sample} +${links.length - 2}` : sample;
}

function formatRange(range: { start: string; end: string }): string {
  if (range.start === range.end) return range.start;
  return `${range.end} - ${range.start}`;
}

const businessSettingsTabs: Array<{ id: BusinessSettingsTab; label: string }> = [
  { id: "business_profile", label: "Profilo" },
  { id: "locations", label: "Sedi" },
  { id: "marketplace", label: "Marketplace" },
];

const legalLocationFieldLabels: Array<[string, string]> = [
  ["legal_company_name", "Ragione sociale"],
  ["legal_vat_number", "P.IVA"],
  ["legal_tax_code", "Codice fiscale"],
  ["legal_sdi", "SDI"],
  ["legal_pec", "PEC"],
  ["legal_address", "Indirizzo legale"],
  ["legal_cap", "CAP"],
  ["legal_city", "Citta"],
  ["legal_province", "Provincia"],
  ["legal_region", "Regione"],
  ["legal_phone", "Telefono legale"],
  ["legal_email", "Email legale"],
  ["legal_website", "Sito web"],
];

function BusinessSettingsView({ section, tenantSlug }: { section: string; tenantSlug: string }) {
  const [activeTab, setActiveTab] = useState<BusinessSettingsTab>(normalizeBusinessSettingsTab(section));
  const [payload, setPayload] = useState<BusinessSettingsPayload>(() => emptyBusinessSettingsPayload());
  const [feedback, setFeedback] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/manage/business-settings?slug=${encodeURIComponent(tenantSlug)}&section=${encodeURIComponent(activeTab)}`)
      .then((response) => response.json() as Promise<BusinessSettingsPayload>)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setFeedback(data.error);
          return;
        }
        setPayload(data);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Impostazioni attivita non caricate.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, reloadKey, tenantSlug]);

  async function runAction(body: Record<string, string>) {
    const data = await postManageApi<BusinessSettingsPayload>(`/api/manage/business-settings?slug=${encodeURIComponent(tenantSlug)}`, body);
    setFeedback(data.error ?? "Operazione completata.");
    if (!data.error) {
      setPayload(data);
      setReloadKey((value) => value + 1);
    }
    return data;
  }

  async function uploadBranding(kind: "logo" | "cover", file: File | null) {
    if (!file) {
      setFeedback("Seleziona un file.");
      return;
    }
    const form = new FormData();
    form.set("action", "branding_upload");
    form.set("kind", kind);
    form.set(kind === "logo" ? "business_logo" : "business_cover", file);
    const response = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(tenantSlug)}`, {
      method: "POST",
      body: form,
    });
    const data = (await response.json()) as BusinessSettingsPayload;
    setFeedback(data.error ?? "Immagine salvata.");
    if (response.ok && !data.error) {
      setPayload(data);
      setReloadKey((value) => value + 1);
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{payload.source ?? "app/pages/business_profile.php"}</p>
            <h2 className="mt-1 text-lg font-semibold">Profilo attivita e sedi</h2>
          </div>
          <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-1">
            {businessSettingsTabs.map((tab) => (
              <button
                className={`h-9 rounded px-3 text-sm font-semibold transition ${activeTab === tab.id ? "bg-white text-[#173262] shadow-sm" : "text-zinc-600 hover:text-zinc-950"}`}
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricTile detail="nome e descrizione" label="Profilo" value={payload.business?.name ?? "-"} />
        <MetricTile detail="configurate" label="Sedi" value={String(payload.locations?.length ?? 0)} />
        <MetricTile detail="pubbliche" label="Marketplace" value={String(payload.marketplace?.visibleLocations.length ?? 0)} />
        <MetricTile detail={payload.featureFlags?.bookingPublicAllowed ? "abilitato" : "non disponibile"} label="Booking" value={payload.featureFlags?.bookingPublicAllowed ? "On" : "Off"} />
      </div>

      {activeTab === "business_profile" ? (
        <BusinessProfilePanel key={businessProfileKey(payload)} payload={payload} runAction={runAction} uploadBranding={uploadBranding} />
      ) : null}
      {activeTab === "locations" ? <BusinessLocationsPanel key={businessLocationsKey(payload)} payload={payload} runAction={runAction} /> : null}
      {activeTab === "marketplace" ? <MarketplaceSettingsPanel key={businessLocationsKey(payload)} payload={payload} runAction={runAction} /> : null}
    </section>
  );
}

function BusinessProfilePanel({
  payload,
  runAction,
  uploadBranding,
}: {
  payload: BusinessSettingsPayload;
  runAction: (body: Record<string, string>) => Promise<BusinessSettingsPayload>;
  uploadBranding: (kind: "logo" | "cover", file: File | null) => Promise<void>;
}) {
  const business = payload.business;
  const [draft, setDraft] = useState({ name: business?.name ?? "", about: business?.bookingAboutText ?? "" });
  const [logoPosition, setLogoPosition] = useState(payload.branding?.logoPosition ?? { x: 50, y: 50 });
  const [coverPosition, setCoverPosition] = useState(payload.branding?.coverPosition ?? { x: 50, y: 50 });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({ action: "save_profile_activity", business_name: draft.name, booking_about_text: draft.about });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_430px]">
      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveProfile}>
        <h3 className="text-base font-semibold">Dati pubblici</h3>
        <div className="mt-4 space-y-4">
          <label className="block text-sm font-medium">
            Nome attivita
            <input className="mt-1 h-11 w-full rounded-md border border-zinc-300 px-3" maxLength={190} required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Chi siamo
            <textarea className="mt-1 min-h-40 w-full rounded-md border border-zinc-300 px-3 py-2" maxLength={3000} value={draft.about} onChange={(event) => setDraft((current) => ({ ...current, about: event.target.value }))} />
          </label>
        </div>
        <button className="mt-4 h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva profilo</button>
      </form>

      <div className="space-y-5">
        <BrandingPanel
          kind="logo"
          position={logoPosition}
          setPosition={setLogoPosition}
          url={payload.branding?.logoUrl ?? ""}
          file={logoFile}
          setFile={setLogoFile}
          uploadBranding={uploadBranding}
          runAction={runAction}
        />
        <BrandingPanel
          kind="cover"
          position={coverPosition}
          setPosition={setCoverPosition}
          url={payload.branding?.coverUrl ?? ""}
          file={coverFile}
          setFile={setCoverFile}
          uploadBranding={uploadBranding}
          runAction={runAction}
        />
      </div>
    </div>
  );
}

function BrandingPanel({
  kind,
  url,
  position,
  setPosition,
  file,
  setFile,
  uploadBranding,
  runAction,
}: {
  kind: "logo" | "cover";
  url: string;
  position: { x: number; y: number };
  setPosition: (value: { x: number; y: number }) => void;
  file: File | null;
  setFile: (value: File | null) => void;
  uploadBranding: (kind: "logo" | "cover", file: File | null) => Promise<void>;
  runAction: (body: Record<string, string>) => Promise<BusinessSettingsPayload>;
}) {
  const label = kind === "logo" ? "Logo" : "Copertina";
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{label}</h3>
        {url ? (
          <button className="h-9 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700" type="button" onClick={() => runAction({ action: "branding_delete", kind })}>Rimuovi</button>
        ) : null}
      </div>
      {url ? (
        <div className={`mt-3 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 ${kind === "logo" ? "h-28" : "h-44"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={label} className="h-full w-full object-cover" src={url} style={{ objectPosition: `${position.x}% ${position.y}%` }} />
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-600">Nessuna immagine caricata.</div>
      )}
      {url ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            X
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" max={100} min={0} type="number" value={position.x} onChange={(event) => setPosition({ ...position, x: Number(event.target.value) })} />
          </label>
          <label className="block text-sm font-medium">
            Y
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" max={100} min={0} type="number" value={position.y} onChange={(event) => setPosition({ ...position, y: Number(event.target.value) })} />
          </label>
          <button className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-semibold" type="button" onClick={() => setPosition({ x: 50, y: 50 })}>Centra</button>
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="button" onClick={() => runAction({ action: "branding_position", kind, x: String(position.x), y: String(position.y) })}>Salva posizione</button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input className="h-10 flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm" accept={kind === "logo" ? "image/jpeg,image/png" : "image/jpeg,image/png,image/webp"} type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="button" onClick={() => uploadBranding(kind, file)}>Carica</button>
        </div>
      )}
    </section>
  );
}

function BusinessLocationsPanel({
  payload,
  runAction,
}: {
  payload: BusinessSettingsPayload;
  runAction: (body: Record<string, string>) => Promise<BusinessSettingsPayload>;
}) {
  const locations = payload.locations ?? [];
  const [selectedId, setSelectedId] = useState(locations[0]?.id ?? 0);
  const selected = locations.find((location) => location.id === selectedId) ?? locations[0] ?? null;
  const [draft, setDraft] = useState(() => businessLocationDraft(selected));
  const [deletePreview, setDeletePreview] = useState<LocationDeletePreview | null>(payload.deletePreview ?? null);
  const [confirmText, setConfirmText] = useState("");

  async function saveLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(businessLocationBody(draft));
  }

  async function previewDelete(locationId: number) {
    const data = await runAction({ action: "location_delete_preview", id: String(locationId) });
    setDeletePreview(data.deletePreview ?? null);
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Sedi</h3>
          <button className="inline-flex h-9 items-center gap-2 rounded-md bg-[#007c72] px-3 text-sm font-semibold text-white" type="button" onClick={() => {
            setSelectedId(0);
            setDraft(businessLocationDraft(null));
            setDeletePreview(null);
          }}>
            <Plus size={15} aria-hidden />
            Nuova
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {locations.map((location) => (
            <button
              className={`w-full rounded-md border p-3 text-left transition ${selectedId === location.id ? "border-[#173262] bg-[#173262]/5" : "border-zinc-200 hover:border-zinc-400"}`}
              key={location.id}
              type="button"
              onClick={() => {
                setSelectedId(location.id);
                setDraft(businessLocationDraft(location));
                setDeletePreview(null);
                setConfirmText("");
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{location.name}</p>
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${location.bookingEnabled ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-700"}`}>{location.bookingEnabled ? "Booking" : "Offline"}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-zinc-600">{location.address || "Indirizzo non impostato"}</p>
            </button>
          ))}
          {locations.length === 0 ? <p className="py-4 text-sm text-zinc-600">Nessuna sede configurata.</p> : null}
        </div>
      </section>

      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={saveLocation}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold">{draft.id ? "Modifica sede" : "Nuova sede"}</h3>
          {draft.id ? (
            <div className="flex gap-2">
              <button className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold" type="button" onClick={() => runAction({ action: "location_move", id: String(draft.id), direction: "up" })}>Su</button>
              <button className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold" type="button" onClick={() => runAction({ action: "location_move", id: String(draft.id), direction: "down" })}>Giu</button>
            </div>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block text-sm font-medium">
            Nome
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Email
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium md:col-span-2">
            Indirizzo
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Telefono
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            WhatsApp
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.whatsapp} onChange={(event) => setDraft((current) => ({ ...current, whatsapp: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Facebook
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.facebookUrl} onChange={(event) => setDraft((current) => ({ ...current, facebookUrl: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            Instagram
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.instagramUrl} onChange={(event) => setDraft((current) => ({ ...current, instagramUrl: event.target.value }))} />
          </label>
          <label className="block text-sm font-medium">
            TikTok
            <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.tiktokUrl} onChange={(event) => setDraft((current) => ({ ...current, tiktokUrl: event.target.value }))} />
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input checked={draft.bookingEnabled} disabled={!payload.featureFlags?.bookingPublicAllowed} type="checkbox" onChange={(event) => setDraft((current) => ({ ...current, bookingEnabled: event.target.checked }))} />
            Abilita prenotazioni online
          </label>
        </div>

        <section className="mt-5 rounded-md border border-zinc-200 p-3">
          <h4 className="font-semibold">Dati fiscali sede</h4>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {legalLocationFieldLabels.map(([field, label]) => (
              <label className="block text-sm font-medium" key={field}>
                {label}
                <input className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3" value={draft.legal[field] ?? ""} onChange={(event) => setDraft((current) => ({ ...current, legal: { ...current.legal, [field]: event.target.value } }))} />
              </label>
            ))}
          </div>
        </section>

        <div className="mt-4 flex flex-wrap gap-2">
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="submit">Salva sede</button>
          {draft.id ? <button className="h-10 rounded-md border border-red-200 px-4 text-sm font-semibold text-red-700" type="button" onClick={() => previewDelete(draft.id)}>Anteprima elimina</button> : null}
        </div>

        {draft.id && deletePreview ? (
          <section className="mt-4 rounded-md border border-red-100 bg-red-50 p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="font-semibold text-red-900">{deletePreview.canDelete ? "Eliminazione disponibile" : "Eliminazione bloccata"}</p>
                <p className="mt-1 text-sm text-red-800">{deletePreview.deleteBlockReason || "La sede non contiene storico bloccante."}</p>
                <p className="mt-2 text-xs text-red-700">Blocchi: {Object.entries(deletePreview.blockingCounts ?? {}).map(([key, value]) => `${key} ${value}`).join(", ") || "nessuno"}</p>
              </div>
              <div className="flex min-w-[260px] flex-col gap-2">
                <input className="h-10 rounded-md border border-red-200 px-3 text-sm" placeholder={deletePreview.confirmText ?? "ELIMINA"} value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
                <button className="h-10 rounded-md bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!deletePreview.canDelete} type="button" onClick={() => runAction({ action: "location_delete", id: String(draft.id), confirm_text: confirmText })}>Elimina definitivamente</button>
              </div>
            </div>
          </section>
        ) : null}
      </form>
    </div>
  );
}

function MarketplaceSettingsPanel({
  payload,
  runAction,
}: {
  payload: BusinessSettingsPayload;
  runAction: (body: Record<string, string>) => Promise<BusinessSettingsPayload>;
}) {
  const locations = payload.locations ?? [];
  const categories = payload.marketplace?.activityCategories ?? [];
  const [locationId, setLocationId] = useState(locations[0]?.id ?? 0);
  const location = locations.find((item) => item.id === locationId) ?? locations[0] ?? null;
  const [enabled, setEnabled] = useState(location?.marketplaceEnabled ?? false);
  const [selectedIds, setSelectedIds] = useState<number[]>(() => (location?.activityCategories ?? []).map((item) => item.marketplaceCategoryId));
  const [primaryId, setPrimaryId] = useState<number>(() => location?.activityCategories.find((item) => item.isPrimary)?.marketplaceCategoryId ?? selectedIds[0] ?? 0);

  function toggleCategory(id: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = checked ? Array.from(new Set([...current, id])).slice(0, 5) : current.filter((item) => item !== id);
      if (!next.includes(primaryId)) setPrimaryId(next[0] ?? 0);
      return next;
    });
  }

  async function saveMarketplace() {
    await runAction({
      action: "location_marketplace_save",
      location_id: String(location?.id ?? 0),
      marketplace_enabled: enabled ? "1" : "0",
      activity_category_ids: selectedIds.join(","),
      activity_category_order: selectedIds.join(","),
      primary_activity_category_id: String(primaryId || selectedIds[0] || 0),
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Scheda pubblica</h3>
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-600">Tenant</span>
            <span className="font-semibold">{payload.tenant?.name ?? "-"}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-600">Marketplace piano</span>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${payload.featureFlags?.marketplacePublicAllowed ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
              {payload.featureFlags?.marketplacePublicAllowed ? "Abilitato" : "Disabilitato"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-600">Profilo</span>
            <span className="font-semibold">{String(payload.marketplace?.profile?.status ?? "draft")}</span>
          </div>
          {payload.marketplace?.publicUrl ? (
            <Link className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 px-4 text-sm font-semibold" href={payload.marketplace.publicUrl}>
              Scheda pubblica
              <ArrowRight size={15} aria-hidden />
            </Link>
          ) : null}
        </div>
      </section>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold">Marketplace sede</h3>
          <select
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm"
            value={location?.id ?? 0}
            onChange={(event) => {
              const nextId = Number(event.target.value);
              const next = locations.find((item) => item.id === nextId) ?? locations[0] ?? null;
              const ids = (next?.activityCategories ?? []).map((item) => item.marketplaceCategoryId);
              setLocationId(nextId);
              setEnabled(next?.marketplaceEnabled ?? false);
              setSelectedIds(ids);
              setPrimaryId(next?.activityCategories.find((item) => item.isPrimary)?.marketplaceCategoryId ?? ids[0] ?? 0);
            }}
          >
            {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>

        {location ? (
          <>
            <div className="mt-4 rounded-md border border-zinc-200 p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold">{location.name}</p>
                  <p className="text-sm text-zinc-600">{location.address || "Indirizzo non impostato"}</p>
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input checked={enabled} disabled={!payload.featureFlags?.marketplacePublicAllowed} type="checkbox" onChange={(event) => setEnabled(event.target.checked)} />
                  Visibile
                </label>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {categories.map((category) => (
                <label className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm" key={category.id}>
                  <span className="font-medium">{category.name}</span>
                  <input checked={selectedIds.includes(category.id)} type="checkbox" onChange={(event) => toggleCategory(category.id, event.target.checked)} />
                </label>
              ))}
              {categories.length === 0 ? <p className="text-sm text-zinc-600">Categorie marketplace non disponibili.</p> : null}
            </div>

            <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
              <label className="block flex-1 text-sm font-medium">
                Categoria principale
                <select className="mt-1 h-10 w-full rounded-md border border-zinc-300 bg-white px-3" value={primaryId} onChange={(event) => setPrimaryId(Number(event.target.value))}>
                  <option value={0}>Seleziona</option>
                  {selectedIds.map((id) => {
                    const category = categories.find((item) => item.id === id);
                    return category ? <option key={id} value={id}>{category.name}</option> : null;
                  })}
                </select>
              </label>
              <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="button" onClick={saveMarketplace}>Salva marketplace sede</button>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-zinc-600">Nessuna sede disponibile.</p>
        )}
      </section>
    </div>
  );
}

function normalizeBusinessSettingsTab(section: string): BusinessSettingsTab {
  return businessSettingsTabs.some((tab) => tab.id === section) ? section as BusinessSettingsTab : "business_profile";
}

function emptyBusinessSettingsPayload(): BusinessSettingsPayload {
  return {
    locations: [],
    marketplace: {
      activityCategories: [],
      mappings: {},
      visibleLocations: [],
      publicUrl: "",
    },
  };
}

function businessProfileKey(payload: BusinessSettingsPayload): string {
  const business = payload.business;
  const branding = payload.branding;
  return [
    business?.id ?? 0,
    business?.name ?? "",
    business?.bookingAboutText ?? "",
    branding?.logoUrl ?? "",
    branding?.coverUrl ?? "",
    branding?.logoPosition.x ?? 50,
    branding?.logoPosition.y ?? 50,
    branding?.coverPosition.x ?? 50,
    branding?.coverPosition.y ?? 50,
  ].join("|");
}

function businessLocationsKey(payload: BusinessSettingsPayload): string {
  return (payload.locations ?? [])
    .map((location) => [
      location.id,
      location.name,
      location.address,
      location.bookingEnabled ? 1 : 0,
      location.marketplaceEnabled ? 1 : 0,
      location.activityCategories.map((category) => `${category.marketplaceCategoryId}:${category.isPrimary ? 1 : 0}`).join("."),
    ].join(":"))
    .join("|");
}

function businessLocationDraft(location: BusinessLocationRow | null) {
  return {
    id: location?.id ?? 0,
    name: location?.name ?? "",
    address: location?.address ?? "",
    phone: location?.phone ?? "",
    email: location?.email ?? "",
    whatsapp: location?.whatsapp ?? "",
    facebookUrl: location?.facebookUrl ?? "",
    instagramUrl: location?.instagramUrl ?? "",
    tiktokUrl: location?.tiktokUrl ?? "",
    bookingEnabled: location?.bookingEnabled ?? true,
    legal: { ...(location?.legal ?? Object.fromEntries(legalLocationFieldLabels.map(([field]) => [field, ""]))) },
  };
}

function businessLocationBody(draft: ReturnType<typeof businessLocationDraft>): Record<string, string> {
  const body: Record<string, string> = {
    action: "location_save",
    id: draft.id ? String(draft.id) : "",
    name: draft.name,
    address: draft.address,
    phone: draft.phone,
    email: draft.email,
    whatsapp: draft.whatsapp,
    facebook_url: draft.facebookUrl,
    instagram_url: draft.instagramUrl,
    tiktok_url: draft.tiktokUrl,
    booking_enabled: draft.bookingEnabled ? "1" : "0",
  };
  for (const [field] of legalLocationFieldLabels) body[field] = draft.legal[field] ?? "";
  return body;
}

function RolesView() {
  const [payload, setPayload] = useState<PermissionsPayload>({});
  const [selectedRole, setSelectedRole] = useState("staff");
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/manage/permissions?role=${encodeURIComponent(selectedRole)}`)
      .then((response) => response.json() as Promise<PermissionsPayload>)
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        const role = data.rolePermissions?.selectedRole ?? selectedRole;
        setSelectedRole(role);
        setSelectedPerms(data.rolePermissions?.assignments?.[role] ?? []);
        if (data.error) setFeedback(data.error);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Permessi non caricati.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRole]);

  const permissions = payload.rolePermissions;
  const roles = permissions?.manageableRoles ?? { staff: "Staff", altro: "Altro" };
  const selectedSet = new Set(selectedPerms);

  function togglePerm(perm: string, checked: boolean) {
    setSelectedPerms((current) => {
      const next = new Set(current);
      if (checked) next.add(perm);
      else next.delete(perm);
      return Array.from(next);
    });
  }

  function setGroup(group: PermissionGroupRow, checked: boolean) {
    const perms = group.definitions.filter((definition) => definition.assignable !== false).map((definition) => definition.perm);
    setSelectedPerms((current) => {
      const next = new Set(current);
      for (const perm of perms) {
        if (checked) next.add(perm);
        else next.delete(perm);
      }
      return Array.from(next);
    });
  }

  async function saveRole() {
    const data = await postManageApi<{
      role?: string;
      perms?: string[];
      assignments?: Record<string, string[]>;
      landingPage?: string;
    }>("/api/manage/permissions", {
      action: "save_role_perms",
      role: selectedRole,
      perms: JSON.stringify(selectedPerms),
    });
    setFeedback(data.error ?? `Permessi ${roles[selectedRole] ?? selectedRole} aggiornati.`);
    if (!data.error) {
      setSelectedPerms(data.perms ?? selectedPerms);
      setPayload((current) => current.rolePermissions ? {
        ...current,
        rolePermissions: {
          ...current.rolePermissions,
          assignments: data.assignments ?? current.rolePermissions.assignments,
          selectedPerms: data.perms ?? current.rolePermissions.selectedPerms,
          landingPage: data.landingPage ?? current.rolePermissions.landingPage,
        },
      } : current);
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{payload.source ?? "app/pages/roles.php"}</p>
            <h2 className="mt-1 text-lg font-semibold">Ruoli e permessi</h2>
            <p className="mt-1 text-sm text-zinc-600">Admin ha accesso completo. Qui si configurano Staff e Altro.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(roles).map(([role, label]) => (
              <button
                className={`h-10 rounded-md px-4 text-sm font-semibold transition ${selectedRole === role ? "bg-[#173262] text-white" : "border border-zinc-300 bg-white text-zinc-700 hover:border-[#173262]"}`}
                key={role}
                type="button"
                onClick={() => setSelectedRole(role)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <MetricTile detail="assegnati direttamente" label="Permessi" value={String(selectedPerms.length)} />
        <MetricTile detail="profilo operativo" label="Ruolo" value={roles[selectedRole] ?? selectedRole} />
        <MetricTile detail="prima pagina disponibile" label="Landing" value={permissions?.landingPage ?? "accessibility"} />
      </div>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold">Permessi {roles[selectedRole] ?? selectedRole}</h3>
          <button className="h-10 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white" type="button" onClick={saveRole}>Salva permessi</button>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {(permissions?.groups ?? []).map((group) => {
            const assignable = group.definitions.filter((definition) => definition.assignable !== false);
            if (!assignable.length) return null;
            const allChecked = assignable.every((definition) => selectedSet.has(definition.perm));
            return (
              <section className="rounded-md border border-zinc-200 p-3" key={group.groupName}>
                <div className="flex items-center justify-between gap-3 border-b border-zinc-100 pb-2">
                  <h4 className="font-semibold">{group.groupName}</h4>
                  <label className="flex items-center gap-2 text-xs font-semibold text-zinc-600">
                    <input checked={allChecked} type="checkbox" onChange={(event) => setGroup(group, event.target.checked)} />
                    Tutti
                  </label>
                </div>
                <div className="mt-3 grid gap-2">
                  {assignable.map((definition) => (
                    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-zinc-100 px-3 py-2 text-sm hover:border-zinc-300" key={definition.perm}>
                      <span>
                        <span className="font-medium">{definition.label}</span>
                        <span className="mt-0.5 block text-xs text-zinc-500">{definition.perm}</span>
                      </span>
                      <input checked={selectedSet.has(definition.perm)} type="checkbox" onChange={(event) => togglePerm(definition.perm, event.target.checked)} />
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function AccessibilityView() {
  const [email, setEmail] = useState("");
  const [needsEmailVerification, setNeedsEmailVerification] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<{
    email: string;
    expiresAt: string;
    attemptCount: number;
    resendWaitSeconds: number;
  } | null>(null);
  const [newAccessEmail, setNewAccessEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [localCode, setLocalCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/manage/accessibility")
      .then((response) => response.json() as Promise<{
        user?: { email?: string; needsEmailVerification?: boolean };
        pendingEmailVerification?: typeof pendingEmail;
        error?: string;
      }>)
      .then((data) => {
        if (cancelled) return;
        setEmail(data.user?.email ?? "");
        setNeedsEmailVerification(!!data.user?.needsEmailVerification);
        setPendingEmail(data.pendingEmailVerification ?? null);
        if (data.error) setFeedback(data.error);
      })
      .catch(() => {
        if (!cancelled) setFeedback("Accessibilita non caricata.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function requestEmailCode(action: "request_email_verify" | "request_email_change" | "resend_email_code") {
    const data = await postManageApi<{
      message?: string;
      pending?: typeof pendingEmail;
      verificationCode?: string;
    }>("/api/manage/accessibility", {
      action,
      new_email: newAccessEmail,
      current_password_email: emailPassword,
    });
    setFeedback(data.error ?? data.message ?? "Codice inviato.");
    if (!data.error) {
      setPendingEmail(data.pending ?? null);
      setLocalCode(data.verificationCode ?? "");
      setEmailPassword("");
    }
  }

  async function confirmEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postManageApi<{ message?: string; email?: string }>("/api/manage/accessibility", {
      action: "confirm_email_change",
      code: emailCode,
    });
    setFeedback(data.error ?? data.message ?? "Email verificata.");
    if (!data.error) {
      setEmail(data.email ?? email);
      setNeedsEmailVerification(false);
      setPendingEmail(null);
      setEmailCode("");
      setLocalCode("");
      setNewAccessEmail("");
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = await postManageApi<{ message?: string }>("/api/manage/accessibility", {
      action: "change_password",
      current_password: currentPassword,
      new_password: newPassword,
      new_password_confirm: newPasswordConfirm,
    });
    setFeedback(data.error ?? data.message ?? "Password aggiornata.");
    if (!data.error) {
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">accessibility.php</p>
        <h2 className="mt-1 text-lg font-semibold">Accessibilita</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <span>{email || "Account gestionale"}</span>
          <span className={`rounded-md px-2 py-1 text-xs font-semibold ${needsEmailVerification ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
            {needsEmailVerification ? "Da verificare" : "Verificata"}
          </span>
        </div>
        {feedback ? <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{feedback}</p> : null}
      </div>

      <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
        <h3 className="text-base font-semibold">Email accesso</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Nuova email</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              type="email"
              value={newAccessEmail}
              onChange={(event) => setNewAccessEmail(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Password attuale</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              type="password"
              value={emailPassword}
              onChange={(event) => setEmailPassword(event.target.value)}
            />
          </label>
          <button
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-zinc-200 px-4 text-sm font-semibold transition hover:border-emerald-700 hover:text-emerald-700"
            type="button"
            onClick={() => requestEmailCode("request_email_change")}
          >
            <Bell size={16} aria-hidden />
            Invia codice
          </button>
        </div>

        {needsEmailVerification && !pendingEmail ? (
          <button
            className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 text-sm font-semibold text-amber-900 transition hover:border-amber-400"
            type="button"
            onClick={() => requestEmailCode("request_email_verify")}
          >
            <ShieldCheck size={16} aria-hidden />
            Invia codice verifica
          </button>
        ) : null}

        {pendingEmail ? (
          <form className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3" onSubmit={confirmEmail}>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto_auto] md:items-end">
              <div className="min-w-0 text-sm">
                <p className="font-semibold">Verifica in corso</p>
                <p className="truncate text-amber-900">{pendingEmail.email}</p>
                <p className="text-xs text-amber-800">Tentativi {pendingEmail.attemptCount}/5 - scadenza {pendingEmail.expiresAt}</p>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-amber-900">Codice</span>
                <input
                  className="h-10 w-full rounded-md border border-amber-200 px-3 text-sm outline-none focus:border-amber-600"
                  inputMode="numeric"
                  value={emailCode}
                  onChange={(event) => setEmailCode(event.target.value)}
                />
              </label>
              <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
                <Check size={16} aria-hidden />
                Conferma
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-amber-200 bg-white px-4 text-sm font-semibold text-amber-900 disabled:opacity-50"
                disabled={pendingEmail.resendWaitSeconds > 0}
                type="button"
                onClick={() => requestEmailCode("resend_email_code")}
              >
                {pendingEmail.resendWaitSeconds > 0 ? `${pendingEmail.resendWaitSeconds}s` : "Reinvia"}
              </button>
            </div>
            {localCode ? <p className="mt-2 text-xs font-semibold text-amber-900">Codice locale: {localCode}</p> : null}
          </form>
        ) : null}
      </section>

      <form className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm" onSubmit={changePassword}>
        <h3 className="text-base font-semibold">Cambio password</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Email accesso</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-600 outline-none"
              disabled
              value={email}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Password attuale</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Nuova password</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              minLength={8}
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">Conferma nuova password</span>
            <input
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-emerald-700"
              minLength={8}
              type="password"
              value={newPasswordConfirm}
              onChange={(event) => setNewPasswordConfirm(event.target.value)}
            />
          </label>
        </div>
        <button className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#007c72] px-4 text-sm font-semibold text-white transition hover:bg-[#006a62]">
          <KeyRound size={16} aria-hidden />
          Aggiorna password
        </button>
      </form>
    </section>
  );
}

function operationMetrics(section: string, payload: OperationsPayload): Array<{ label: string; value: string; detail: string }> {
  if (section === "costs") {
    return [
      { label: "Aperti", value: `${payload.summary?.open ?? 0}`, detail: "scadenze aperte" },
      { label: "Scaduti", value: `${payload.summary?.overdue ?? 0}`, detail: "da saldare" },
      { label: "Importo", value: `${payload.summary?.dueAmount ?? 0} euro`, detail: "non pagato" },
    ];
  }
  if (section === "quotes") {
    return [
      { label: "Preventivi", value: `${payload.quotes?.length ?? 0}`, detail: "totale documenti" },
      { label: "Accettati", value: `${payload.quotes?.filter((quote) => quote.status === "accepted").length ?? 0}`, detail: "da convertire" },
      { label: "Valore", value: `${payload.quotes?.reduce((total, quote) => total + quote.total, 0) ?? 0} euro`, detail: "pipeline" },
    ];
  }
  if (section === "giftcard") {
    return [
      { label: "GiftCard", value: `${payload.giftCards?.length ?? 0}`, detail: "emesse" },
      { label: "Attive", value: `${payload.giftCards?.filter((giftCard) => giftCard.status === "active").length ?? 0}`, detail: "utilizzabili" },
      { label: "Saldo", value: `${payload.giftCards?.reduce((total, giftCard) => total + giftCard.balance, 0) ?? 0} euro`, detail: "residuo" },
    ];
  }
  if (section === "notifications") {
    return [
      { label: "Notifiche", value: `${payload.notifications?.length ?? 0}`, detail: "totali" },
      { label: "Da leggere", value: `${payload.notifications?.filter((item) => !item.read).length ?? 0}`, detail: "aperte" },
      { label: "Letti", value: `${payload.notifications?.filter((item) => item.read).length ?? 0}`, detail: "archivio" },
    ];
  }
  if (section === "automation") {
    return [
      { label: "Regole", value: `${payload.rules?.length ?? 0}`, detail: "configurate" },
      { label: "Attive", value: `${payload.rules?.filter((rule) => rule.enabled).length ?? 0}`, detail: "in esecuzione" },
      { label: "Eseguite", value: `${payload.rules?.filter((rule) => rule.lastRunAt).length ?? 0}`, detail: "run manuali" },
    ];
  }
  if (section === "packages") {
    return [
      { label: "Catalogo", value: `${payload.catalog?.length ?? 0}`, detail: "pacchetti" },
      { label: "Clienti", value: `${payload.clientPackages?.filter((item) => item.status === "active").length ?? 0}`, detail: "attivi" },
      { label: "Residue", value: `${payload.clientPackages?.reduce((total, item) => total + item.remainingSessions, 0) ?? 0}`, detail: "sedute" },
    ];
  }
  if (section === "pos_prepaids") {
    return [
      { label: "Prepagati", value: `${payload.prepaids?.length ?? 0}`, detail: "emessi" },
      { label: "Attivi", value: `${payload.prepaids?.filter((item) => item.status === "active").length ?? 0}`, detail: "utilizzabili" },
      { label: "Residui", value: `${payload.prepaids?.reduce((total, item) => total + item.remainingQuantity, 0) ?? 0}`, detail: "servizi" },
    ];
  }
  if (section === "pos_preorders") {
    return [
      { label: "Preordini", value: `${payload.preorders?.length ?? 0}`, detail: "totali" },
      { label: "Aperti", value: `${payload.preorders?.filter((item) => item.status === "open").length ?? 0}`, detail: "da ritirare" },
      { label: "Acconti", value: `${payload.preorders?.reduce((total, item) => total + item.deposit, 0) ?? 0} euro`, detail: "incassati" },
    ];
  }
  if (section === "coupons") {
    return [
      { label: "Coupon", value: `${payload.coupons?.length ?? 0}`, detail: "codici" },
      { label: "Attivi", value: `${payload.coupons?.filter((item) => item.active).length ?? 0}`, detail: "validi" },
      { label: "Utilizzi", value: `${payload.coupons?.reduce((total, item) => total + item.usedCount, 0) ?? 0}`, detail: "storico" },
    ];
  }
  if (section === "promotions") {
    return [
      { label: "Promo", value: `${payload.promotions?.length ?? 0}`, detail: "regole" },
      { label: "Attive", value: `${payload.promotions?.filter((item) => item.active).length ?? 0}`, detail: "in corso" },
      { label: "Booking", value: `${payload.promotions?.filter((item) => item.channel === "booking").length ?? 0}`, detail: "pubbliche" },
    ];
  }
  if (section === "giftbox") {
    return [
      { label: "GiftBox", value: `${payload.giftBoxes?.length ?? 0}`, detail: "emesse" },
      { label: "Attive", value: `${payload.giftBoxes?.filter((item) => item.status === "active").length ?? 0}`, detail: "utilizzabili" },
      { label: "Residui", value: `${payload.giftBoxes?.reduce((total, item) => total + item.remainingItems, 0) ?? 0}`, detail: "item" },
    ];
  }
  if (section === "gifts") {
    return [
      { label: "Omaggi", value: `${payload.gifts?.length ?? 0}`, detail: "emessi" },
      { label: "Disponibili", value: `${payload.gifts?.filter((item) => item.status === "available").length ?? 0}`, detail: "riscattabili" },
      { label: "Riscattati", value: `${payload.gifts?.filter((item) => item.status === "redeemed").length ?? 0}`, detail: "storico" },
    ];
  }
  if (section === "installments_manage") {
    const installments = payload.plans?.flatMap((plan) => plan.installments) ?? [];
    return [
      { label: "Piani", value: `${payload.plans?.length ?? 0}`, detail: "rateali" },
      { label: "Scadute", value: `${installments.filter((item) => item.status === "overdue").length}`, detail: "da incassare" },
      { label: "Residuo", value: `${payload.plans?.reduce((total, plan) => total + Math.max(0, plan.total - plan.paid), 0) ?? 0} euro`, detail: "aperto" },
    ];
  }
  if (section === "commissions") {
    return [
      { label: "Aperte", value: `${payload.summary?.open ?? 0}`, detail: "da liquidare" },
      { label: "Importo", value: `${payload.summary?.dueAmount ?? 0} euro`, detail: "maturato" },
      { label: "Pagate", value: `${payload.summary?.paid ?? 0}`, detail: "storico" },
    ];
  }
  if (configurationSectionIds.has(section)) {
    const moduleMode = payload.module?.settings?.sourceMode === "database"
      ? "DB"
      : payload.module?.settings?.cloned
        ? "Clonato"
        : "Demo";
    return [
      { label: "Record", value: `${payload.records?.length ?? 0}`, detail: "configurati" },
      { label: "Attivi", value: `${payload.records?.filter((item) => item.active).length ?? 0}`, detail: "abilitati" },
      { label: "Modulo", value: moduleMode, detail: payload.module?.source ?? section },
    ];
  }
  if (section === "fidelity_points") {
    const totalPoints = payload.clients?.reduce((total, client) => total + (client.wallet?.points ?? 0), 0) ?? 0;
    return [
      { label: "Punti", value: `${totalPoints}`, detail: "saldo clienti" },
      { label: "Movimenti", value: `${payload.movements?.length ?? 0}`, detail: "transazioni" },
      { label: "Clienti", value: `${payload.clients?.length ?? 0}`, detail: "iscritti" },
    ];
  }
  return [
    { label: "Clienti", value: `${payload.clients?.length ?? 0}`, detail: "wallet" },
    { label: "Movimenti", value: `${payload.movements?.length ?? 0}`, detail: "credito e punti" },
    { label: "Credito", value: `${payload.clients?.reduce((total, client) => total + (client.wallet?.credit ?? 0), 0) ?? 0} euro`, detail: "saldo" },
  ];
}

function operationRows(section: string, payload: OperationsPayload): Array<{ id: string; title: string; detail: string; value: string }> {
  if (section === "costs") {
    return (payload.costs ?? []).map((cost) => ({
      id: `cost-${cost.id}`,
      title: cost.title,
      detail: `${cost.category} - ${cost.supplier} - ${cost.dueDate}`,
      value: `${cost.amount} euro`,
    }));
  }
  if (section === "quotes") {
    return (payload.quotes ?? []).map((quote) => ({
      id: `quote-${quote.id}`,
      title: quote.code,
      detail: `${quote.clientName} - ${quote.status}`,
      value: `${quote.total} euro`,
    }));
  }
  if (section === "giftcard") {
    return (payload.giftCards ?? []).map((giftCard) => ({
      id: `giftcard-${giftCard.id}`,
      title: giftCard.code,
      detail: `${giftCard.recipientName} - ${giftCard.status}`,
      value: `${giftCard.balance} euro`,
    }));
  }
  if (section === "notifications") {
    return (payload.notifications ?? []).map((notification) => ({
      id: `notification-${notification.id}`,
      title: notification.title,
      detail: notification.message,
      value: notification.read ? "Letta" : "Nuova",
    }));
  }
  if (section === "automation") {
    return (payload.rules ?? []).map((rule) => ({
      id: `rule-${rule.id}`,
      title: rule.name,
      detail: `${rule.channel} - ${rule.trigger}`,
      value: rule.enabled ? "Attiva" : "Pausa",
    }));
  }
  if (section === "packages") {
    return (payload.clientPackages ?? []).map((clientPackage) => ({
      id: `client-package-${clientPackage.id}`,
      title: clientPackage.name,
      detail: `${clientPackage.clientName} - ${clientPackage.status}`,
      value: `${clientPackage.remainingSessions}/${clientPackage.totalSessions}`,
    }));
  }
  if (section === "pos_prepaids") {
    return (payload.prepaids ?? []).map((prepaid) => ({
      id: `prepaid-${prepaid.id}`,
      title: prepaid.serviceName,
      detail: `${prepaid.clientName} - ${prepaid.status}`,
      value: `${prepaid.remainingQuantity}/${prepaid.totalQuantity}`,
    }));
  }
  if (section === "pos_preorders") {
    return (payload.preorders ?? []).map((preorder) => ({
      id: `preorder-${preorder.id}`,
      title: preorder.productName,
      detail: `${preorder.clientName} - ${preorder.dueDate}`,
      value: preorder.status,
    }));
  }
  if (section === "coupons") {
    return (payload.coupons ?? []).map((coupon) => ({
      id: `coupon-${coupon.id}`,
      title: coupon.code,
      detail: `${coupon.type} - valido fino al ${coupon.endsAt}`,
      value: coupon.active ? `${coupon.usedCount}/${coupon.usageLimit}` : "Pausa",
    }));
  }
  if (section === "promotions") {
    return (payload.promotions ?? []).map((promotion) => ({
      id: `promotion-${promotion.id}`,
      title: promotion.name,
      detail: `${promotion.target} - ${promotion.channel}`,
      value: promotion.active ? `${promotion.discountValue}` : "Pausa",
    }));
  }
  if (section === "giftbox") {
    return (payload.giftBoxes ?? []).map((giftBox) => ({
      id: `giftbox-${giftBox.id}`,
      title: giftBox.code,
      detail: `${giftBox.recipientName} - ${giftBox.status}`,
      value: `${giftBox.remainingItems}`,
    }));
  }
  if (section === "gifts") {
    return (payload.gifts ?? []).map((gift) => ({
      id: `gift-${gift.id}`,
      title: gift.title,
      detail: `${gift.clientName} - ${gift.rewardType}`,
      value: gift.status,
    }));
  }
  if (section === "installments_manage") {
    return (payload.plans ?? []).map((plan) => ({
      id: `plan-${plan.id}`,
      title: `${plan.clientName} - vendita #${plan.saleId}`,
      detail: `${plan.installments.filter((item) => item.status !== "paid").length} rate aperte`,
      value: `${Math.max(0, plan.total - plan.paid)} euro`,
    }));
  }
  if (section === "commissions") {
    return (payload.commissions ?? []).map((commission) => ({
      id: `commission-${commission.id}`,
      title: commission.staffName,
      detail: `vendita #${commission.saleId ?? "-"} - ${commission.status}`,
      value: `${commission.amount} euro`,
    }));
  }
  if (configurationSectionIds.has(section)) {
    return (payload.records ?? []).map((record) => ({
      id: `config-${record.module}-${record.id}`,
      title: record.title,
      detail: record.detail,
      value: record.active ? record.value : "Pausa",
    }));
  }
  return (payload.movements ?? []).map((movement) => ({
    id: `wallet-${movement.id}`,
    title: movement.note,
    detail: `${movement.type} - cliente #${movement.clientId}`,
    value: movement.amount !== 0 ? `${movement.amount} euro` : `${movement.points} pt`,
  }));
}

function operationActionBody(section: string, payload: OperationsPayload): Record<string, string> | null {
  if (section === "costs") {
    const cost = payload.costs?.find((item) => item.status !== "paid");
    return cost ? { action: "pay", id: String(cost.id) } : null;
  }
  if (section === "quotes") {
    const quote = payload.quotes?.find((item) => item.status === "accepted") ?? payload.quotes?.[0];
    return quote ? { action: quote.status === "accepted" ? "convert" : "accept", id: String(quote.id) } : null;
  }
  if (section === "giftcard") {
    return { action: "issue", client_id: "1", recipient_name: "Cliente banco", amount: "50" };
  }
  if (section === "notifications") {
    const notification = payload.notifications?.find((item) => !item.read);
    return notification ? { id: String(notification.id) } : null;
  }
  if (section === "automation") {
    const rule = payload.rules?.find((item) => item.enabled);
    return rule ? { action: "run", id: String(rule.id) } : null;
  }
  if (section === "packages") {
    const clientPackage = payload.clientPackages?.find((item) => item.status === "active" && item.remainingSessions > 0);
    return clientPackage ? { action: "use", id: String(clientPackage.id), sessions: "1" } : { action: "issue", package_id: "1", client_id: "1" };
  }
  if (section === "pos_prepaids") {
    const prepaid = payload.prepaids?.find((item) => item.status === "active" && item.remainingQuantity > 0);
    return prepaid ? { action: "use", id: String(prepaid.id), quantity: "1" } : { action: "issue", client_id: "1", service_id: "1", quantity: "2" };
  }
  if (section === "pos_preorders") {
    const preorder = payload.preorders?.find((item) => item.status === "open");
    return preorder ? { action: "collect", id: String(preorder.id) } : { action: "create", client_id: "1", product_id: "1", quantity: "1", deposit: "20" };
  }
  if (section === "coupons") {
    return { action: "preview", code: payload.coupons?.[0]?.code ?? "WELCOME10", subtotal: "100" };
  }
  if (section === "promotions") {
    const promotion = payload.promotions?.[0];
    return promotion ? { action: "preview", id: String(promotion.id), subtotal: "100" } : null;
  }
  if (section === "giftbox") {
    const giftBox = payload.giftBoxes?.find((item) => item.status === "active" && item.remainingItems > 0);
    return giftBox ? { action: "redeem", id: String(giftBox.id), quantity: "1" } : { action: "issue", client_id: "1", recipient_name: "Cliente banco", service_id: "1", sessions: "2" };
  }
  if (section === "gifts") {
    const gift = payload.gifts?.find((item) => item.status === "available");
    return gift ? { action: "redeem", id: String(gift.id) } : { action: "issue", client_id: "1", title: "Omaggio manuale", reward_type: "discount", value: "10" };
  }
  if (section === "installments_manage") {
    const plan = payload.plans?.find((item) => item.status === "active");
    const installment = plan?.installments.find((item) => item.status !== "paid");
    return plan && installment ? { action: "pay", plan_id: String(plan.id), installment_id: String(installment.id) } : { action: "create", client_id: "1", total: "300", count: "3" };
  }
  if (section === "commissions") {
    const commission = payload.commissions?.find((item) => item.status === "open");
    return commission ? { action: "pay", id: String(commission.id) } : null;
  }
  if (configurationSectionIds.has(section)) {
    const inactiveRecord = payload.records?.find((item) => !item.active);
    return inactiveRecord ? { action: "toggle", module: section, record_id: String(inactiveRecord.id), active: "true" } : { action: "touch", module: section };
  }
  if (section === "fidelity_points") {
    return { type: "points_earn", client_id: "1", points: "10", note: "Rettifica punti", source: "manual" };
  }
  return { type: "recharge", client_id: "1", amount: "25", note: "Ricarica credito", source: "manual" };
}

async function postManageApi<T extends object>(url: string, payload: Record<string, string>): Promise<T & { ok?: boolean; error?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as T & { ok?: boolean; error?: string };

  if (!response.ok && !data.error) {
    return { ...data, error: "Operazione non riuscita." };
  }

  return data;
}

function emptyDashboardData(): DashboardPayload {
  const week = emptyWeekSeries();

  return {
    sourceMode: "database",
    stats: [
      { label: "Clienti", value: "0", detail: "anagrafiche attive" },
      { label: "Appuntamenti oggi", value: "0", detail: "agenda operativa" },
      { label: "Vendite ultimi 30gg", value: formatCurrency(0), detail: "vendite attive" },
    ],
    weekly: {
      range: `${week[0]?.label ?? ""} - ${week[week.length - 1]?.label ?? ""}`,
      metrics: [
        { label: "Appuntamenti", value: "0", detail: "0%" },
        { label: "Ricavi", value: formatCurrency(0), detail: "0%" },
        { label: "Ore lavorate", value: "0", detail: "0%" },
        { label: "Nuovi clienti", value: "0", detail: "0%", tone: "neutral" },
      ],
      series: week,
    },
    appointments: {
      today: [],
      upcoming: [],
    },
    notifications: [],
    costs: {
      summary: { open: 0, overdue: 0, paid: 0, dueAmount: 0 },
      overdueAmount: 0,
      monthAmount: 0,
      overdueCount: 0,
      monthCount: 0,
    },
  };
}

function emptyWeekSeries(): DashboardPayload["weekly"]["series"] {
  const today = new Date();
  const day = today.getDay() || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const iso = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    return {
      date: iso,
      label: `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`,
      revenue: 0,
      appointments: 0,
    };
  });
}

function calendarHours(appointments: AppointmentWithMeta[]): string[] {
  const base = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];
  const fromAppointments = appointments.map((appointment) => appointment.time).filter(Boolean);
  return Array.from(new Set([...base, ...fromAppointments])).sort((left, right) => left.localeCompare(right));
}

function addDaysLocal(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0"),
  ].join("-");
}

function orderCalendarStaff(staff: CalendarStaff[], order: number[]): CalendarStaff[] {
  const index = new Map(order.map((id, position) => [id, position]));
  return [...staff].sort((left, right) => {
    const leftIndex = index.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = index.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.name.localeCompare(right.name);
  });
}

function staffMatchesAppointment(staffName: string, appointmentOperator: string): boolean {
  if (!appointmentOperator) return false;
  return staffName.trim().toLowerCase() === appointmentOperator.trim().toLowerCase();
}

function formatItalianDate(date: string): string {
  if (!date) return "";
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

function formatCurrency(value: number): string {
  return `${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} euro`;
}

function normalizeManagementRole(role: string): "admin" | "staff" | "altro" {
  const normalized = role.toLowerCase();
  if (normalized === "admin" || normalized === "staff") return normalized;
  return "altro";
}

function StatusPanel({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: string; detail: string }[];
}) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 divide-y divide-zinc-100">
        {items.map((item) => (
          <div className="py-3" key={`${title}-${item.label}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{item.label}</p>
            <p className="mt-1 font-semibold">{item.value}</p>
            <p className="mt-1 text-sm text-zinc-600">{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function feature(
  id: string,
  label: string,
  subtitle: string,
  source: string,
  state: FeatureState,
  icon: LucideIcon,
  features: string[],
): FeatureItem {
  return {
    id,
    label,
    subtitle,
    source,
    state,
    icon,
    features,
    records: [
      { label: "Permesso", value: permissionFor(id), detail: "controllo accesso originale" },
      { label: "Copertura", value: coverageValueFor(id), detail: "logica migrata su DB" },
      { label: "Priorita", value: priorityFor(id), detail: "ordine consigliato di sviluppo" },
    ],
  };
}

function permissionFor(id: string): string {
  return permissionForFeature(id);
}

function coverageValueFor(id: string): string {
  if (id.includes("pos") || id === "commissions") return "DB operativo";
  if (id.includes("cost")) return "DB costi";
  if (id.includes("gift") || id === "fidelity") return "DB fidelity";
  if (id === "clients") return "DB clienti";
  if (id === "products") return "DB magazzino";
  if (id === "services") return "DB servizi";
  if (id === "booking") return "7 step";
  return "mappato";
}

function priorityFor(id: string): string {
  if (["dashboard", "calendar", "appointments", "booking", "clients", "services"].includes(id)) return "Alta";
  if (["pos", "costs", "products", "reports", "quotes"].includes(id)) return "Media";
  return "Backlog";
}

function relatedFeatures(id: string): FeatureItem[] {
  const group = featureGroups.find((candidate) => candidate.items.some((item) => item.id === id));
  return (group?.items ?? allFeatures).filter((item) => item.id !== id).slice(0, 4);
}
