// Domain type definitions for the management ("gestionale") layer.
//
// This module used to also host an in-memory demo store (seeded from the
// prototype's fake data) plus a hardcoded `defaultTenantSlug =
// "centroesteticoelite"`. Both have been removed: the app is purely DB-backed
// and multi-tenant-clean. All persistence now goes through lib/db-repositories.ts
// (read/write) against Supabase Postgres. What remains here are the shared
// domain TYPES consumed by the repositories, manage routes and UI.
//
// The base Client/Service/Product shapes still live in lib/demo-data.ts (now a
// types-only module); the Managed* types below extend them.
import type { Client, Product, Service } from "@/lib/demo-data";

export type ManagedClient = Client & {
  id: number;
  email: string;
  phone: string;
  locationId: number;
  tags: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  // Full anagrafica fields (port of the legacy clients table). All optional so
  // that list/summary callers that only need name/email/phone stay unaffected.
  firstName?: string;
  lastName?: string;
  companyName?: string;
  vatNumber?: string;
  taxCode?: string;
  sdi?: string;
  pec?: string;
  phoneHome?: string;
  phone2?: string;
  gender?: string;
  birthDate?: string;
  birthPlace?: string;
  registrationDate?: string;
  region?: string;
  province?: string;
  city?: string;
  address?: string;
  cap?: string;
  jobTitle?: string;
};

export type ManagedService = Service & {
  id: number;
  description: string;
  locationIds: number[];
  active: boolean;
  bookingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StockMovement = {
  id: number;
  productId: number;
  type: "carico" | "scarico" | "rettifica";
  quantity: number;
  reason: string;
  locationId: number;
  createdAt: string;
};

export type ManagedProduct = Product & {
  sku: string;
  stock: number;
  minStock: number;
  locationId: number;
  publicVisible: boolean;
  movements: StockMovement[];
  createdAt: string;
  updatedAt: string;
};

export type PosSaleItemType = "service" | "product" | "prepaid" | "giftcard" | "package" | "giftbox" | "recharge";
export type PosSaleItemStatus = "executed" | "prepaid" | "collected" | "ordered";
export type PosPaymentMethod = "cash" | "card" | "check" | "transfer" | "giftcard" | "wallet";
export type PosSaleStatus = "active" | "cancelled";

export type PosSaleItemInput = {
  type: PosSaleItemType;
  refId?: number;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  status?: PosSaleItemStatus;
  // Package sale meta (faithful to pos.php pkAddRowToCart): the optional custom validity
  // window + note the staff sets in the "Vendi pacchetto" modal. Only read for a
  // type:"package" line; flows through to the issued client_packages row (start_date /
  // expires_at / notes). Ignored for every other line type.
  startDate?: string;
  expiresAt?: string;
  note?: string;
  // GiftCard / GiftBox sale meta (faithful to pos.php issue_giftcard + GiftCard::issueGiftCard
  // and GiftBox::issueInstance): the voucher configured in the "Emetti GiftCard" / "Emetti
  // GiftBox" modal. Read only for a type:"giftcard" / type:"giftbox" line at checkout.
  // For a GIFTCARD it flows to the issued giftcards row (recipient_client_id / recipient_name /
  // code / expires_at / gift_message / voucher_hide_amount; the card amount is the line
  // unitPrice). For a GIFTBOX it flows to the issued giftbox_instances row (refId = the chosen
  // giftboxes TEMPLATE id, recipient_client_id = the OWNER so it shows in residui,
  // recipient_name / recipient_email / expires_at / event_type / gift_message /
  // voucher_hide_amount; the box price is the line unitPrice). Ignored for other types.
  recipientClientId?: number;
  recipientName?: string;
  recipientEmail?: string;
  code?: string;
  eventType?: string;
  message?: string;
  hideAmount?: boolean;
  // GiftCard/GiftBox voucher extra meta (pos.php items[gc_*] / giftbox_* draft):
  // "Nota interna" (giftcards/giftbox_instances.internal_note), "Invio email"
  // (sendMode none|now|date + sendOn → scheduled_send_on / invio immediato al
  // Concludi) e "Mostra importo e contenuto nella mail" (email_show_amount /
  // email_show_details). La "Nota per il cliente" riusa `note` (comune coi
  // pacchetti). Ignorati per gli altri tipi riga.
  internalNote?: string;
  sendMode?: "none" | "now" | "date";
  sendOn?: string;
  showAmount?: boolean;
  // RECHARGE sale meta (faithful to pos.php recharge action + recharge_templates): the
  // top-up the staff configured in the "Ricarica credito" modal. Read only for a
  // type:"recharge" line at checkout (refId = the recharge_templates id, or 0 for a custom
  // amount). The client PAYS baseAmount (the sale line price = unitPrice) and RECEIVES
  // base+bonus (totalAmount) as wallet credit, plus pointsEarned fidelity points when
  // earnPoints is set + the client is eligible. Ignored for other line types.
  baseAmount?: number;
  bonusKind?: string;
  bonusValue?: number;
  bonusAmount?: number;
  totalAmount?: number;
  earnPoints?: boolean;
  // Custom GiftBox build (faithful to pos.php issue_giftbox / GiftBox::saveGiftBox): the chosen
  // cart services/products that compose a ONE-OFF giftbox when the line carries no template
  // (refId 0). Read only for a type:"giftbox" line — saveGiftboxFromCart materialises a transient
  // giftboxes template + giftbox_items from these before the instance copies them. Ignored otherwise.
  customItems?: Array<{ type: "service" | "product"; id: number; qty: number }>;
};

export type PosPaymentInput = {
  method: PosPaymentMethod;
  amount: number;
  // For a "giftcard" tender (POS "Residui"): the giftcards.id to consume from, so the
  // checkout can decrement the exact card the staff picked. Ignored for other methods.
  giftcardId?: number;
};

export type PosSaleItem = {
  id: number;
  type: PosSaleItemType;
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  // Assente sulle righe speciali (giftcard/giftbox/ricarica/pacchetto): gli INSERT
  // legacy le scrivono senza item_status (NULL su DB).
  status?: PosSaleItemStatus;
  stockMovementId?: number;
  // Package sale meta carried from the cart to issuePackageFromSale (start/expiry/note).
  startDate?: string;
  expiresAt?: string;
  note?: string;
  // GiftCard / GiftBox sale meta carried from the cart to issueGiftcardFromSale /
  // issueGiftboxFromSale (recipient/code/expiry/dedica/hide-amount). Set on a
  // type:"giftcard" line and on a type:"giftbox" line (where refId is the chosen
  // giftboxes TEMPLATE id and recipientClientId is the OWNER of the issued instance).
  recipientClientId?: number;
  recipientName?: string;
  recipientEmail?: string;
  code?: string;
  eventType?: string;
  message?: string;
  hideAmount?: boolean;
  // Voucher extra meta legacy: nota interna, invio email (none|now|date + data)
  // e "Mostra importo e contenuto nella mail".
  internalNote?: string;
  sendMode?: "none" | "now" | "date";
  sendOn?: string;
  showAmount?: boolean;
  // RECHARGE sale meta carried from the cart to issueRechargeFromSale (base/bonus/total/
  // earn-points). Set on a type:"recharge" line; refId is the recharge_templates id (0 =
  // custom amount). unitPrice/total = baseAmount (the client pays the base); totalAmount =
  // base+bonus is credited to the wallet; pointsEarned is derived server-side.
  baseAmount?: number;
  bonusKind?: string;
  bonusValue?: number;
  bonusAmount?: number;
  totalAmount?: number;
  earnPoints?: boolean;
  // Custom GiftBox build: the chosen cart services/products composing a one-off giftbox, carried
  // from the cart to issueGiftboxFromSale (which materialises a transient template via
  // saveGiftboxFromCart when refId is 0). Set only on a type:"giftbox" custom-build line.
  customItems?: Array<{ type: "service" | "product"; id: number; qty: number }>;
};

export type PosPayment = {
  id: number;
  method: PosPaymentMethod;
  amount: number;
  // Set for a "giftcard" tender: the giftcards.id the amount is drawn from.
  giftcardId?: number;
};

export type PosSale = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  appointmentId?: number;
  locationId: number;
  // The staff member who rang the sale (sales.operator_name, else the users lookup for
  // sales.created_by). Surfaced in the Movimenti "Operatore" column. "" when unknown.
  operatorName: string;
  items: PosSaleItem[];
  payments: PosPayment[];
  subtotal: number;
  discount: number;
  total: number;
  paidAmount: number;
  changeDue: number;
  status: PosSaleStatus;
  createdAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  stockCancelMode?: "restore" | "no_restore" | "none";
};

export type PosCheckoutInput = {
  clientId?: number;
  clientName?: string;
  appointmentId?: number;
  locationId?: number;
  discount?: number;
  couponCode?: string;
  notes?: string;
  promotionId?: number;
  installments?: number;
  // FIDELITY redemption: the points the staff wants to spend as a discount at checkout.
  // The backend converts points -> euro discount (points x euro_per_point), validates
  // against the client balance + redeem settings, and consumes them. 0 / undefined = none.
  fidelityPointsUse?: number;
  // RATEIZZAZIONE: the optional installment plan (faithful to SaleInstallments::createPlan).
  // When present with count >= 2, the backend writes a sale_installment_plans row + N
  // sale_installments rows scheduling the financed remainder (total - downPayment). The sale
  // total + payments are unchanged: the plan only documents/schedules the financing.
  installmentPlan?: PosInstallmentPlanInput;
  // SCELTA unico/rateizzato (legacy installment_choice_mode): obbligatoria lato server
  // quando il totale netto residui è > 0 (pos.php 4631).
  installmentChoice?: "single" | "installment" | "";
  // IN-POS QUOTE IMPORT (faithful to pos.php ?quote_id=N): when set, the cart was pre-loaded
  // (locked) from this quote — the checkout links the sale to it (sales.source_quote_id) and
  // flips the quote to 'converted' (+ converted_sale_id). 0 / undefined = a normal sale.
  sourceQuoteId?: number;
  items: PosSaleItemInput[];
  payments: PosPaymentInput[];
};

// The installment plan params the staff configures in the "Rateizzazione" panel.
// Faithful to the legacy installment_plan_json (preparePlanConfig input): the down payment
// (acconto), the number of installments, the interval value + unit, the first due date and
// an optional note. The financed amount + schedule are derived server-side.
export type PosInstallmentPlanInput = {
  count: number;
  downPayment?: number;
  intervalValue?: number;
  intervalUnit?: "day" | "week" | "month";
  firstDueDate?: string;
  note?: string;
};

export type PosSummary = {
  saleCount: number;
  grossTotal: number;
  activeTotal: number;
  cancelledTotal: number;
  paymentTotals: Record<PosPaymentMethod, number>;
  serviceTotal: number;
  productTotal: number;
};

export type CostStatus = "open" | "paid" | "overdue";
export type CostRecurrence = "none" | "monthly" | "yearly";

export type CostItem = {
  id: number;
  title: string;
  category: string;
  supplier: string;
  amount: number;
  dueDate: string;
  recurrence: CostRecurrence;
  locationId: number;
  status: CostStatus;
  paidAt?: string;
  createdAt: string;
};

export type QuoteStatus = "draft" | "sent" | "accepted" | "converted" | "rejected";

export type QuoteLine = {
  id: number;
  type: PosSaleItemType;
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

export type Quote = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  total: number;
  status: QuoteStatus;
  publicToken: string;
  expiresAt: string;
  acceptedAt?: string;
  // Risposta cliente dall'area booking (quotes.customer_decision_*): quando la
  // decisione e' stata presa e quando il gestionale l'ha segnata come letta
  // (pagina Notifiche > Preventivi, azioni seen/seen_all).
  customerDecisionAt?: string;
  customerDecisionSeenAt?: string;
  convertedSaleId?: number;
  createdAt: string;
};

export type WalletMovementType = "recharge" | "debit" | "points_earn" | "points_redeem" | "adjustment";

export type WalletMovement = {
  id: number;
  clientId: number;
  type: WalletMovementType;
  amount: number;
  points: number;
  note: string;
  source: string;
  createdAt: string;
};

export type GiftCardStatus = "active" | "used" | "cancelled" | "expired";

export type GiftCard = {
  id: number;
  code: string;
  clientId: number;
  recipientName: string;
  initialAmount: number;
  balance: number;
  status: GiftCardStatus;
  expiresAt: string;
  sourceSaleId?: number;
  createdAt: string;
};

export type NotificationItem = {
  id: number;
  type: "appointment" | "cost" | "quote" | "fidelity" | "system";
  title: string;
  message: string;
  read: boolean;
  link: string;
  createdAt: string;
};

export type AutomationRule = {
  id: number;
  name: string;
  channel: "email" | "sms" | "browser";
  trigger: "appointment_reminder" | "birthday" | "cost_due" | "quote_followup" | "fidelity_expiry";
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
};

export type PackageCatalogItem = {
  serviceId: number;
  serviceName: string;
  sessions: number;
};

export type PackageCatalog = {
  id: number;
  name: string;
  price: number;
  items: PackageCatalogItem[];
  active: boolean;
  locationIds: number[];
  createdAt: string;
};

export type ClientPackageStatus = "active" | "completed" | "expired" | "cancelled";

export type ClientPackage = {
  id: number;
  packageId: number;
  clientId: number;
  clientName: string;
  name: string;
  totalSessions: number;
  remainingSessions: number;
  expiresAt?: string;
  status: ClientPackageStatus;
  sourceSaleId?: number;
  createdAt: string;
};

export type ClientPrepaidStatus = "active" | "completed" | "expired" | "cancelled";

// Source of a prepaid row, mirroring the legacy pos_prepaids.php `source_type`:
// a standalone prepaid, a service inside a package, or a service inside a GiftBox.
export type ClientPrepaidKind = "prepaid" | "package" | "giftbox";

export type ClientPrepaid = {
  id: number;
  kind: ClientPrepaidKind;
  clientId: number;
  clientName: string;
  serviceId: number;
  serviceName: string;
  totalQuantity: number;
  remainingQuantity: number;
  // Residual split (legacy free_qty / linked_qty): bookedQty = sessions already
  // tied to an OPEN appointment (pending/scheduled, not yet redeemed);
  // bookableQty = remainingQuantity - bookedQty.
  bookedQty: number;
  bookableQty: number;
  lastUsedAt?: string;
  expiresAt?: string;
  status: ClientPrepaidStatus;
  sourceSaleId?: number;
  createdAt: string;
};

export type PreorderStatus = "open" | "collected" | "cancelled";

// Row-level fulfilment kind and stock status, mirroring the legacy pos_preorders.php
// which merges three sources (sale_items ordered / client_packages products /
// giftbox_instance_items products) and computes a per-row stock badge.
export type PreorderKind = "sale" | "package" | "giftbox";
export type PreorderStockStatus = "ready" | "partial" | "insufficient" | "expired";

export type Preorder = {
  id: number;
  clientId: number;
  clientName: string;
  productId: number;
  productName: string;
  quantity: number;
  deposit: number;
  dueDate: string;
  status: PreorderStatus;
  createdAt: string;
  collectedAt?: string;
  // Optional multi-source fields (populated by listDbPreorders; the legacy
  // create/collect paths leave them undefined and keep the classic shape).
  kind?: PreorderKind;
  saleId?: number;
  stock?: number;
  stockStatus?: PreorderStockStatus;
  sourceRef?: string;
  sourceName?: string;
  sourceCode?: string;
  saleDate?: string;
  expiresAt?: string;
  expiryApplies?: boolean;
  isExpired?: boolean;
};

export type CouponType = "fixed" | "percent";

export type CouponRule = {
  id: number;
  code: string;
  type: CouponType;
  value: number;
  minSubtotal: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  usageLimit: number;
  usedCount: number;
  createdAt: string;
};

export type PromotionRule = {
  id: number;
  name: string;
  target: "all" | "new_clients" | "inactive" | "birthday" | "fidelity";
  discountType: CouponType;
  discountValue: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  channel: "booking" | "pos" | "marketplace";
  createdAt: string;
};

export type GiftBoxStatus = "active" | "redeemed" | "expired" | "cancelled";

export type GiftBoxInstance = {
  id: number;
  code: string;
  clientId: number;
  recipientName: string;
  items: PackageCatalogItem[];
  remainingItems: number;
  status: GiftBoxStatus;
  expiresAt: string;
  sourceSaleId?: number;
  createdAt: string;
};

export type GiftRewardStatus = "available" | "redeemed" | "expired" | "cancelled";

export type GiftReward = {
  id: number;
  clientId: number;
  clientName: string;
  title: string;
  rewardType: "service" | "product" | "discount";
  value: number;
  status: GiftRewardStatus;
  expiresAt: string;
  createdAt: string;
  redeemedAt?: string;
};

export type InstallmentStatus = "due" | "paid" | "overdue";
export type InstallmentPlanStatus = "active" | "completed" | "cancelled";

export type Installment = {
  id: number;
  installmentNo: number;
  dueDate: string;
  amount: number;
  paidAmount?: number;
  paymentType?: string;
  note?: string;
  status: InstallmentStatus;
  statusLabel: string;
  statusBadge: string;
  paidAt?: string;
};

export type InstallmentPlan = {
  id: number;
  saleId: number;
  saleDate?: string;
  clientId: number;
  clientName: string;
  total: number;
  paid: number;
  status: InstallmentPlanStatus;
  statusLabel: string;
  statusBadge: string;
  installments: Installment[];
  paidCount: number;
  pendingCount: number;
  overdueCount: number;
  remaining: number;
  collected: number;
  nextDueDate?: string;
  nextDueAmount?: number;
  downPayment: number;
  paymentType: string;
  intervalLabel: string;
  notes?: string;
  cancelledReason?: string;
  cancelledAt?: string;
  createdAt: string;
};

export type CommissionStatus = "open" | "paid" | "reversed";

export type CommissionEntry = {
  id: number;
  staffName: string;
  saleId?: number;
  appointmentId?: number;
  baseAmount: number;
  rate: number;
  amount: number;
  status: CommissionStatus;
  createdAt: string;
  paidAt?: string;
};

export type ConfigRecord = {
  id: number;
  module: string;
  title: string;
  detail: string;
  value: string;
  active: boolean;
  updatedAt: string;
};

export type ConfigModuleState = {
  id: string;
  title: string;
  source?: string;
  records: ConfigRecord[];
  settings: Record<string, string | number | boolean>;
  updatedAt: string;
};
