import "server-only";

import { randomBytes } from "node:crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import type {
  ManagedClient,
  ManagedProduct,
  ManagedService,
  PosCheckoutInput,
  PosPayment,
  PosPaymentInput,
  PosPaymentMethod,
  PosSale,
  PosSaleItem,
  PosSaleItemInput,
  PosSaleItemStatus,
  PosSaleItemType,
  PosSummary,
  Quote,
} from "@/lib/tenant-store";
import {
  addDbWalletMovement,
  dbClientGiftcards,
  dbWalletBalance,
  evaluatePromotionsForCart,
  getDbAppointmentForEdit,
  listDbQuotes,
  fidelityIsClientAdhering,
  fidelityReservedPoints,
  listFidelityCampaigns,
  previewDbCoupon,
  redeemDbGiftCard,
  refundDbGiftCard,
  type PromoCartLine,
} from "@/lib/db-repositories";
import { expireClientLots, fidelityLotsSettings } from "@/lib/fidelity-lots";
import { prepaidExpiryForPurchaseDate, prepaidsExpiryEnabled, preorderExpiryForPurchaseDate } from "@/lib/manage-pos-settings";
import { giftInvalidateSource, giftRecordSale } from "@/lib/gifts-engine";
import { giftRedeemAppointmentSelectionIfAny } from "@/lib/gifts-instances";
import { getManageLocationContext } from "@/lib/manage-locations";
import {
  columnExists,
  dbExecute,
  dbQuery,
  quoteIdentifier,
  tenantDelete,
  tenantInsert,
  tenantSelect,
  tenantTable,
  tenantUpdate,
  withTenantTransaction,
} from "@/lib/tenant-db";

type TenantTarget = Awaited<ReturnType<typeof tenantTable>>;

// The BUSINESS header for the printable POS receipt (scontrino) — port of the legacy
// pos_success.php business identity (name + P.IVA/legal_vat_number + address + logo). The
// name/address/logo come from the single `businesses` row (reusing the same source the
// business-profile page reads); the P.IVA + a legal address fallback come from the ACTIVE
// location's legal_* fields (legal_vat_number / legal_address live on `locations`, not
// `businesses`). All fields are schema-guarded so older installs still render a name-only
// header. `logoPath` is the public asset path ("/uploads/logo/...") used directly as <img src>.
export type PosBusinessHeader = {
  name: string;
  legalVatNumber: string;
  address: string;
  logoPath: string;
};

export type ManagePosContext = {
  ok: true;
  sourceMode: "database";
  activeLocationId: number;
  // Business identity for the printable receipt header (name / P.IVA / address / logo).
  business: PosBusinessHeader;
  summary: PosSummary;
  sales: PosSale[];
  // Unified "Movimenti" list (port of pos_history.php's $events): sales PLUS standalone
  // recharges + giftbox instances + giftcards (deduped against the sale that issued them),
  // newest-first, 200 cap. Feeds the Movimenti page; the sidebar filters are applied over it.
  movements: PosMovement[];
  catalog: {
    clients: ManagedClient[];
    services: ManagedService[];
    products: ManagedProduct[];
    // Sellable PACKAGE templates (id, name, price, total sessions, validity days) for the
    // "Vendi pacchetto" modal; selling one issues a client_packages row at checkout.
    packages: SellablePackage[];
    // Sellable GIFTBOX templates (id, name, default price, validity days, contents) for the
    // "Emetti GiftBox" modal; selling one issues a giftbox_instances row (+ its items copied
    // from the template's giftbox_items) owned by the recipient at checkout.
    giftboxes: SellableGiftbox[];
    // Sellable RECHARGE templates (id, title, base/bonus/total, earn-points flag) for the
    // "Ricarica credito" modal; selling one inserts a recharges row + CREDITS the wallet by
    // base+bonus (+ earns fidelity points) at checkout.
    rechargeTemplates: SellableRecharge[];
  };
  locations: Array<{ id: number; name: string }>;
  // Riscatto punti abilitato (testo dinamico posRedeemInfo legacy:
  // "Seleziona un cliente per vedere [punti, ]credito disponibili.").
  fidelityRedeemEnabled: boolean;
  // Blocco info Fidelity sotto Concludi (pos.php 6399-6411): "Fidelity attivo:
  // accredito secondo la campagna punti valida al momento della vendita • / nessuna
  // campagna punti attiva oggi • 1 punto = € X".
  fidelityEarnInfo: { euroPerPoint: number; earnStep: number; campaignActiveToday: boolean };
};

// A single row of the "Movimenti" list (port of pos_history.php's $events entry). One of four
// kinds: a POS 'sale' (with a composite "Vendita (GiftCard, Ricarica)" label when it issued
// vouchers/recharges), a standalone 'recharge' (R#id, "Apri" -> credit movements), a standalone
// 'giftbox' or 'giftcard' voucher ("Voucher"). "Standalone" = NOT created through a POS sale
// (a sale-linked recharge/giftbox/giftcard is already represented by its sale row and is skipped
// here to avoid double-counting). `amount` is null when unknown (rendered as "—"). The
// hasService/hasProduct/hasPackage + serviceIds/productIds flags let the client-side Servizi/
// Prodotti/Pacchetti filters narrow the list without a round-trip.
export type PosMovementKind = "sale" | "recharge" | "giftbox" | "giftcard";
export type PosMovement = {
  kind: PosMovementKind;
  // Composite type label for a sale ("Vendita", "Vendita (GiftCard, Ricarica)", ...); the
  // fixed "Ricarica"/"GiftBox"/"GiftCard" label for a standalone movement.
  kindLabel: string;
  // Underlying row id (sales.id / recharges.id / giftbox_instances.id / giftcards.id).
  id: number;
  // The sale number for a 'sale' (0 for standalone); numberLabel is the "R#12"-style badge.
  saleNumber: number;
  numberLabel: string;
  locationId: number;
  clientId: number;
  clientName: string;
  amount: number | null;
  // Localized status label ("Attiva" / "Annullata" / "Stornata" / the giftbox/giftcard status).
  status: string;
  operator: string;
  date: string;
  // Sale content flags for the sidebar Servizi/Prodotti/Pacchetti filters (sale kind only).
  hasService: boolean;
  hasProduct: boolean;
  hasPackage: boolean;
  serviceIds: number[];
  productIds: number[];
  // Whether the sale issued a voucher/recharge line — powers the Tipologia filter for sales.
  hasGiftcardLine: boolean;
  hasGiftboxLine: boolean;
  hasRechargeLine: boolean;
};

// A voucher ISSUED by a sale at checkout — the generated GiftCard (GC-XXXX-XXXX-XXXX) or
// GiftBox (GBX-XXXXXX) CODE plus its recipient + amount. Surfaced on the checkout response
// (ManagePosContext.issuedVouchers) so the printable receipt can show staff the code to hand
// to the customer — port of pos_success.php's "GiftCard/GiftBox emessa (CODE)" presentation.
// (The code is otherwise written only to the giftcards / giftbox_instances tables.)
export type IssuedVoucher = {
  type: "giftcard" | "giftbox";
  code: string;
  recipientName?: string;
  amount?: number;
};

// A package template the POS can SELL (port of the pos.php $packages query:
// SELECT id, name, price, sessions_total, validity_days FROM packages WHERE is_active=1).
// `sessions` is the bundle's total sessions (sum of package_services / package_items, or
// the packages.sessions_total fallback) — it becomes client_packages.sessions_total when
// the package is issued. `validityDays` seeds the proposed expiry (today + N days).
export type SellablePackage = {
  id: number;
  name: string;
  price: number;
  sessions: number;
  validityDays: number;
};

// A single content item of a sellable GiftBox template (one giftbox_items row): the source
// template item id (giftbox_items.id — copied into giftbox_instance_items.giftbox_item_id at
// issue), the item kind, the service/product it covers, the qty (units of that item), and the
// label. Mirrors the giftbox_items columns used by the redeem reader.
export type SellableGiftboxItem = {
  giftboxItemId: number;
  itemType: "service" | "product" | "custom";
  serviceId: number;
  productId: number;
  qty: number;
  label: string;
};

// A GiftBox template the POS can SELL (port of the GiftBox catalog: SELECT id, name,
// active, valid_from/valid_to/expires_after_days FROM giftboxes WHERE active=1 AND deleted_at
// IS NULL). The legacy `giftboxes` table has NO price column (a GiftBox is a fidelity-redeem
// voucher), so the SALE price is staff-entered in the modal (seeded by `price` = 0 here).
// `validityDays` seeds the proposed expiry (today + N days, from expires_after_days). `items`
// are the template's giftbox_items, copied into giftbox_instance_items when the box is issued.
export type SellableGiftbox = {
  id: number;
  name: string;
  price: number;
  validityDays: number;
  items: SellableGiftboxItem[];
};

// A RECHARGE template the POS can SELL — port of the recharge_templates catalog the legacy
// recharge modal precompiles from (SELECT id, title, base_amount, bonus_kind, bonus_value,
// earn_points FROM recharge_templates WHERE is_active=1 ORDER BY sort_order). The client PAYS
// `baseAmount` (the sale line price) and RECEIVES `baseAmount + bonusAmount` (the wallet
// credit). `bonusAmount` is computed from bonus_kind/bonus_value exactly like recharges-content
// (percent: base*value/100, fixed: value, none: 0). `earnPoints` decides whether fidelity
// points are earned on the bonus too (base+bonus) or on the base only. Custom (amount-only)
// recharges use templateId 0 and are configured entirely in the modal.
export type SellableRecharge = {
  id: number;
  title: string;
  baseAmount: number;
  bonusKind: string;
  bonusValue: number;
  bonusAmount: number;
  earnPoints: boolean;
};

export async function getManagePosContext(
  slug: string,
  options: { locationId?: number; includeCancelled?: boolean; query?: string } = {},
): Promise<ManagePosContext> {
  const locationContext = await getManageLocationContext(slug);
  const activeLocationId = normalizeLocationId(options.locationId ?? locationContext.currentLocationId, locationContext.locations);
  const [sales, clients, services, products, packages, giftboxes, rechargeTemplates, business] = await Promise.all([
    listPosSales(slug, { locationId: activeLocationId, includeCancelled: options.includeCancelled ?? true, query: options.query ?? "" }),
    listPosClients(slug),
    listPosServices(slug, activeLocationId),
    listPosProducts(slug, activeLocationId),
    listPosPackages(slug, activeLocationId),
    listPosGiftboxes(slug, activeLocationId),
    listPosRechargeTemplates(slug),
    getPosBusinessHeader(slug, activeLocationId),
  ]);

  const movements = await buildPosMovements(slug, sales, { locationId: activeLocationId });

  // Flag riscatto punti per il testo dinamico posRedeemInfo legacy
  // ("Seleziona un cliente per vedere [punti, ]credito disponibili." —
  // pos.php 5922-5926; 'omaggi' è morto: $giftsV2Enabled resta false).
  const redeemSettings = await getFidelityRedeemSettings(slug).catch(() => ({ redeemEnabled: false, euroPerPoint: 0.1, minPoints: 0 }));

  // Blocco info Fidelity legacy sotto Concludi: earn step + campagna attiva OGGI
  // (stesso predicato di computeCampaignEarn). Best-effort.
  const earnInfoSettings = await getFidelityEarnSettings(slug).catch(() => ({ enabled: false, earnStep: 10, earnOnBonus: true }));
  const todayForCampaign = todayIso();
  const campaignActiveToday = await listFidelityCampaigns(slug)
    .then((campaigns) => campaigns.some((c) => c.active && (c.startsAt === "" || c.startsAt <= todayForCampaign) && (c.endsAt === "" || c.endsAt >= todayForCampaign)))
    .catch(() => false);

  return {
    ok: true,
    sourceMode: "database",
    activeLocationId,
    business,
    summary: summarizeSales(sales),
    sales,
    movements,
    catalog: { clients, services, products, packages, giftboxes, rechargeTemplates },
    locations: locationContext.locations.map((location) => ({ id: location.id, name: location.name })),
    fidelityRedeemEnabled: redeemSettings.redeemEnabled,
    fidelityEarnInfo: { euroPerPoint: redeemSettings.euroPerPoint, earnStep: earnInfoSettings.earnStep, campaignActiveToday },
  };
}

// Read the BUSINESS header for the printable POS receipt — the business identity the legacy
// pos_success.php prints (name, P.IVA, address, logo). The name/address/logo come from the
// single `businesses` row (the same source the business-profile page reads via
// getBusinessProfile); the P.IVA (legal_vat_number) + a legal address fallback come from the
// ACTIVE location's legal_* fields (those columns live on `locations`, not `businesses`).
// Every column read is schema-guarded (a missing column / table degrades to ""), so older
// installs still get a name-only header. Best-effort: any error returns a name-only header
// (the slug) so the receipt always has something to print.
async function getPosBusinessHeader(slug: string, activeLocationId: number): Promise<PosBusinessHeader> {
  const fallback: PosBusinessHeader = { name: slug, legalVatNumber: "", address: "", logoPath: "" };
  try {
    const businessRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "*",
      orderBy: "id ASC",
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const business = businessRows[0] ?? null;

    // Active location legal fields (P.IVA + legal address) — schema-guarded read.
    let legalVatNumber = "";
    let legalAddress = "";
    if (activeLocationId > 0) {
      const locationRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "locations",
        columns: "*",
        where: "id=?",
        params: [activeLocationId],
        limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      const location = locationRows[0] ?? null;
      if (location) {
        legalVatNumber = clean(location.legal_vat_number, 40);
        legalAddress = clean(location.address ?? location.legal_address, 255);
      }
    }

    const name = clean(business?.name, 190) || slug;
    const address = clean(business?.address, 255) || legalAddress;
    const logoPath = clean(business?.logo_path, 255);
    return { name, legalVatNumber, address, logoPath };
  } catch {
    return fallback;
  }
}

// The "Residui" the POS can spend on a sale for a selected client: their wallet CREDIT
// balance (clients.credit_balance, the same source Quick Booking + the wallet ledger
// use) and each available (active, non-expired, balance > 0) GiftCard the client owns.
// Port of pos_payment_residual_credit_data + the credit_wallet_balance/active_card
// helpers (app/pages/pos.php), reusing the existing repo readers so the numbers match
// what the rest of the app shows. Returns zeros / empty for "Cliente banco" (id <= 0).
export type ManagePosResiduals = {
  ok: true;
  clientId: number;
  credit: number;
  giftcards: Array<{ id: number; code: string; balance: number }>;
  // FIDELITY redemption: the client's spendable POINTS (available = saldo - prenotati,
  // come il legacy mode=client_fidelity: Fidelity::availablePoints) plus the business
  // redeem settings, so the UI can render the "punti da usare" box and compute the
  // resulting € discount (points x euroPerPoint). `enabled` mirrors the legacy gate:
  // fidelity_enabled AND fidelity_redeem_enabled AND the client actually has points.
  points: number;
  // Dettaglio legacy per l'help del box punti + i badge del POS: saldo GREZZO (può
  // essere negativo), punti prenotati da appuntamenti aperti, adesione (tessera attiva).
  pointsBalance: number;
  pointsReserved: number;
  fidelityAdhering: boolean;
  fidelity: {
    enabled: boolean;
    euroPerPoint: number;
    minPoints: number;
  };
};

export async function getManagePosResiduals(slug: string, clientId: number): Promise<ManagePosResiduals> {
  const id = Math.max(0, Number(clientId) || 0);
  const settings = await getFidelityRedeemSettings(slug);
  if (id <= 0) {
    return { ok: true, clientId: 0, credit: 0, giftcards: [], points: 0, pointsBalance: 0, pointsReserved: 0, fidelityAdhering: false, fidelity: { enabled: false, euroPerPoint: settings.euroPerPoint, minPoints: settings.minPoints } };
  }
  // Expire-on-read (port of Fidelity::availablePoints): con scadenza punti attiva
  // i lotti scaduti vengono processati prima di esporre il saldo spendibile.
  const lotsSettings = await fidelityLotsSettings(slug).catch(() => ({ expireEnabled: false, expireDays: 0, expireWarnDays: 0 }));
  if (lotsSettings.expireEnabled) await expireClientLots(slug, id).catch(() => 0);
  const [{ credit, points }, giftcards] = await Promise.all([
    dbWalletBalance(id, slug).catch(() => ({ credit: 0, points: 0 })),
    dbClientGiftcards(slug, id).catch(() => []),
  ]);
  // F2: come Fidelity::availablePoints, un cliente NON aderente (tessera assente/
  // scaduta/disattivata) non ha punti spendibili — il box redeem non si offre.
  const adhering = await fidelityIsClientAdhering(slug, id).catch(() => false);
  const pointsBalance = normalizePoints(points);
  // Punti PRENOTATI da appuntamenti aperti (Fidelity::reservedPoints): il disponibile
  // legacy è saldo - prenotati (clampato al saldo, mai negativo).
  const reservedRaw = adhering ? await fidelityReservedPoints(slug, id).catch(() => 0) : 0;
  const reserved = Math.min(reservedRaw, Math.max(0, pointsBalance));
  const normalizedPoints = adhering ? normalizePoints(Math.max(0, pointsBalance - reserved)) : 0;
  return {
    ok: true,
    clientId: id,
    credit: roundMoney(Math.max(0, credit)),
    giftcards: giftcards.map((card) => ({ id: card.id, code: card.code, balance: roundMoney(Math.max(0, card.balance)) })),
    points: normalizedPoints,
    pointsBalance: adhering ? pointsBalance : 0,
    pointsReserved: reserved,
    fidelityAdhering: adhering,
    // Redemption is offered only when globally enabled AND the client has points to spend
    // (faithful to pos.php: `$client_id && $fid['enabled'] && $fid['redeem_enabled']`).
    fidelity: {
      enabled: settings.redeemEnabled && normalizedPoints > 0,
      euroPerPoint: settings.euroPerPoint,
      minPoints: settings.minPoints,
    },
  };
}

// "Vendita da appuntamento" pre-load: the cart seed for cashing out a completed
// appointment in the POS. Port of the legacy pos.php quote-import flow applied to an
// appointment — the POS opens pre-filled with the appointment's CLIENT + its SERVICE
// lines so a normal checkout records the sale AND marks the appointment 'done'
// (checkoutManageSale sets appointments.status='done' when appointmentId>0). Reuses
// getDbAppointmentForEdit (clientId/clientName + services[{serviceId,name}]) and enriches
// each service with the CURRENT catalog price (the same price a manually-clicked POS
// service tile would charge), so the staff sees the live list price. Tenant-scoped via the
// repo readers; returns ok=false (empty) when the appointment is missing / not the tenant's.
export type ManagePosAppointmentCart = {
  ok: boolean;
  appointmentId: number;
  publicCode: string | null;
  clientId: number;
  clientName: string;
  services: Array<{ serviceId: number; name: string; unitPrice: number; quantity: number }>;
};

export async function getManagePosAppointmentCart(slug: string, appointmentId: number): Promise<ManagePosAppointmentCart> {
  const id = Math.max(0, Number(appointmentId) || 0);
  const empty: ManagePosAppointmentCart = { ok: false, appointmentId: 0, publicCode: null, clientId: 0, clientName: "", services: [] };
  if (id <= 0) return empty;

  const appointment = await getDbAppointmentForEdit(slug, id).catch(() => null);
  if (!appointment) return empty;

  // Service catalog (id -> current list price) from the SAME source the POS tiles use, so a
  // pre-loaded line carries exactly the price a manual tile click would add. The POS catalog
  // price is the formatted "<n> euro" string -> parsed to a number here.
  const services = await listPosServices(slug, appointment.locationId ?? 0).catch(() => []);
  const priceById = new Map<number, number>();
  for (const service of services) {
    priceById.set(Number(service.id ?? 0), parsePriceLabel(service.price));
  }

  const cartServices = appointment.services
    .filter((service) => Number(service.serviceId ?? 0) > 0)
    .map((service) => ({
      serviceId: Number(service.serviceId),
      name: String(service.name ?? "Servizio"),
      // Current catalog list price (0 when the service is no longer in the catalog — the staff
      // can still adjust qty/remove the line, mirroring a manual add of an unpriced service).
      unitPrice: roundMoney(Math.max(0, priceById.get(Number(service.serviceId)) ?? 0)),
      quantity: 1,
    }));

  return {
    ok: true,
    appointmentId: id,
    publicCode: appointment.publicCode,
    clientId: Math.max(0, Number(appointment.clientId ?? 0) || 0),
    clientName: String(appointment.clientName ?? "").trim(),
    services: cartServices,
  };
}

// IN-POS QUOTE IMPORT pre-load (faithful to pos.php ?quote_id=N → quote_sale_load_quote +
// quote_sale_load_quote_items). Returns the LOCKED cart seed for a quote: the client + one line
// per quote line (type/refId/name/qty carried, unitPrice TRUSTED from the quote snapshot — NOT
// re-derived from the catalog, mirroring the legacy). Gated: the quote must exist and not be
// already converted. The UI seeds a locked cart from this, then a normal checkout with
// sourceQuoteId records sales.source_quote_id + flips the quote to 'converted'.
export type ManagePosQuoteCart = {
  ok: boolean;
  quoteId: number;
  code: string | null;
  clientId: number;
  clientName: string;
  discount: number;
  locked: boolean;
  error?: string;
  items: Array<{ type: PosSaleItemType; refId: number; name: string; unitPrice: number; quantity: number }>;
};

export async function getManagePosQuoteCart(slug: string, quoteId: number): Promise<ManagePosQuoteCart> {
  const id = Math.max(0, Number(quoteId) || 0);
  const empty: ManagePosQuoteCart = { ok: false, quoteId: 0, code: null, clientId: 0, clientName: "", discount: 0, locked: true, items: [] };
  if (id <= 0) return empty;

  const quote = (await listDbQuotes(slug).catch(() => [] as Quote[])).find((q) => q.id === id);
  if (!quote) return { ...empty, error: "Preventivo non trovato." };
  if (quote.status === "converted") return { ...empty, quoteId: id, error: "Preventivo gia convertito." };

  return {
    ok: true,
    quoteId: id,
    code: quote.code || null,
    clientId: Math.max(0, Number(quote.clientId ?? 0) || 0),
    clientName: String(quote.clientName ?? "").trim(),
    discount: roundMoney(Math.max(0, Number(quote.discount ?? 0) || 0)),
    locked: true,
    items: quote.lines
      .filter((line) => Number(line.quantity ?? 0) > 0)
      .map((line) => ({
        type: line.type,
        refId: Math.max(0, Number(line.refId ?? 0) || 0),
        name: String(line.name ?? "").trim() || "Riga preventivo",
        unitPrice: roundMoney(Math.max(0, Number(line.unitPrice ?? 0) || 0)),
        quantity: Math.max(1, Number(line.quantity ?? 1) || 1),
      })),
  };
}

// Parse a POS catalog price label ("12,00 euro" / "12.00") into a number. Mirrors the
// pos-content parsePrice helper so the seeded unit price matches what a tile click adds.
function parsePriceLabel(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").replace(/euro/gi, "").replace(/€/g, "").replace(/\s+/g, "").trim();
  if (!raw) return 0;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

// Port of Fidelity::settings() redeem block (app/lib/Fidelity.php ~610-620): read the
// fidelity redeem config off the single `businesses` row, with the legacy defaults +
// clamps. euroPerPoint defaults to 0.10, must be > 0 and <= 100000; minPoints defaults to
// 0, clamped to [0, 100000000] and floored to an integer (points are always whole).
// Schema-guarded: if the install lacks the columns, falls back to the defaults so the
// flow still works (euroPerPoint=0.10, minPoints=0) while staying disabled by default.
type FidelityRedeemSettings = { redeemEnabled: boolean; euroPerPoint: number; minPoints: number };

async function getFidelityRedeemSettings(slug: string): Promise<FidelityRedeemSettings> {
  const defaults: FidelityRedeemSettings = { redeemEnabled: false, euroPerPoint: 0.1, minPoints: 0 };
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "fidelity_enabled,fidelity_redeem_enabled,fidelity_redeem_euro_per_point,fidelity_redeem_min_points",
      orderBy: "id ASC",
      limit: 1,
    });
    const row = rows[0];
    if (!row) return defaults;
    const enabled = Number(row.fidelity_enabled ?? 0) === 1 && Number(row.fidelity_redeem_enabled ?? 0) === 1;
    let euroPerPoint = Number(row.fidelity_redeem_euro_per_point ?? 0.1);
    if (!Number.isFinite(euroPerPoint) || euroPerPoint <= 0) euroPerPoint = 0.1;
    if (euroPerPoint > 100000) euroPerPoint = 100000;
    let minPoints = Number(row.fidelity_redeem_min_points ?? 0);
    if (!Number.isFinite(minPoints) || minPoints < 0) minPoints = 0;
    if (minPoints > 100000000) minPoints = 100000000;
    minPoints = normalizePoints(minPoints);
    return { redeemEnabled: enabled, euroPerPoint: roundMoney(euroPerPoint), minPoints };
  } catch {
    return defaults;
  }
}

// Promozione applicata alla vendita (via promotion_id o via codice). `code` presente
// solo quando applicata da un codice (nota "Promozione: NAME (CODE)").
type PosPromoApplied = { id: number; name: string; nonDiscountedSubtotal: number; stackableWithFidelity: boolean; code?: string };

export async function checkoutManageSale(
  slug: string,
  input: PosCheckoutInput,
  operator: { id: number | null; name: string },
): Promise<ManagePosContext & { sale: PosSale; issuedVouchers: IssuedVoucher[]; fidelityPointsEarned: number }> {
  const locationContext = await getManageLocationContext(slug);
  const locationId = normalizeLocationId(input.locationId ?? locationContext.currentLocationId, locationContext.locations);
  if (locationId <= 0) throw new Error("Seleziona una sede per la vendita.");
  if (!input.items.length) throw new Error("Carrello vuoto.");

  const client = await resolveSaleClient(slug, input.clientId ?? 0, input.clientName);
  const items = await buildSaleItems(slug, input.items, locationId, client.id > 0);
  if (!items.length) throw new Error("Aggiungi almeno un elemento prima di concludere la vendita.");

  // ESCLUSIVITÀ CARRELLO — port of pos.php ~3327-3415 + 3502/3755 + 3966-3999 + 4645:
  // GiftCard e Ricariche sono vendite ESCLUSIVE (max 1 per vendita, niente altri
  // elementi, niente GiftBox); su una vendita con ricarica sono vietati credito,
  // GiftCard come pagamento, coupon/promozioni, sconto manuale, punti Fidelity e
  // rateizzazione; servizi/prodotti/ricariche/pacchetti richiedono un cliente.
  assertCartExclusivityRules(items, client.id, input);

  const subtotal = roundMoney(items.reduce((total, item) => total + item.total, 0));
  const manualDiscount = roundMoney(Math.max(0, input.discount ?? 0));

  // PROMOTION (Block 3b): apply the operator-selected promotion (input.promotionId) to
  // the service/product cart via the promotions engine (evaluatePromotionsForCart). The
  // promotion discount joins the sale discount like a coupon; the applied promo + its
  // discount are stamped on the sale and a promotion_redemptions row is recorded below.
  let promoDiscount = 0;
  let promoApplied: PosPromoApplied | null = null;
  // Carrello promo (servizi/prodotti con prezzo) + data/ora, condivisi dal path
  // promotion_id e dal path PROMO-CON-CODICE.
  const promoNow = new Date();
  const promoCart: PromoCartLine[] = items
    .filter((it) => (it.type === "service" || it.type === "product") && it.refId > 0 && it.unitPrice > 0)
    .map((it) => ({ type: it.type === "product" ? "product" : "service", id: it.refId, qty: it.quantity, unitPrice: it.unitPrice }));
  const promoDate = promoNow.toISOString().slice(0, 10);
  const promoTime = `${String(promoNow.getHours()).padStart(2, "0")}:${String(promoNow.getMinutes()).padStart(2, "0")}`;
  const evalPromotionById = async (promotionId: number, code?: string): Promise<{ discount: number; applied: PosPromoApplied }> => {
    const evaluated = await evaluatePromotionsForCart(slug, promoCart, promoDate, promoTime, client.id, locationId);
    const chosen = evaluated.promotions.find((p) => p.promotionId === promotionId);
    if (!chosen || !chosen.eligible || chosen.discount <= 0) throw new Error("La promozione selezionata non è applicabile a questa vendita.");
    // nonDiscountedSubtotal ESATTO dal motore (righe con sconto unitario nullo, pos.php
    // 1620-1639) + cumulabilità con la Fidelity (bitmask stackable) per il cap punti.
    return {
      discount: Math.min(subtotal, chosen.discount),
      applied: { id: chosen.promotionId, name: chosen.title, nonDiscountedSubtotal: chosen.nonDiscountedSubtotal, stackableWithFidelity: chosen.stackableWithFidelity, code },
    };
  };
  if (input.promotionId && input.promotionId > 0) {
    const r = await evalPromotionById(input.promotionId);
    promoDiscount = r.discount;
    promoApplied = r.applied;
  }

  const couponCode = clean(input.couponCode, 40);
  let couponDiscount = 0;
  if (couponCode) {
    // PROMO-CON-CODICE (pos.php:4304-4336): un codice che coincide con una
    // promotions.coupon_code ATTIVA si applica come PROMOZIONE (non coupon), come nel
    // booking; solo se NON è una promo si fa fallback al coupon classico. Non sovrascrive
    // una promozione già scelta via promotion_id.
    const promoRows = !promoApplied
      ? await tenantSelect<RowDataPacket>({
          slug,
          table: "promotions",
          columns: "id",
          where: "UPPER(TRIM(COALESCE(coupon_code,''))) = ? AND COALESCE(is_active,0) = 1",
          params: [couponCode.toUpperCase()],
          orderBy: "priority DESC, id ASC",
          limit: 1,
        }).catch(() => [] as RowDataPacket[])
      : [];
    const promoIdFromCode = Number(promoRows[0]?.id ?? 0) || 0;
    if (promoIdFromCode > 0) {
      const r = await evalPromotionById(promoIdFromCode, couponCode.toUpperCase());
      promoDiscount = r.discount;
      promoApplied = r.applied;
    } else {
      // Fallback COUPON classico. Validazione legacy completa (pos.php ~4340-4400):
      // coupon_validate_row con cliente (limite per-cliente) e sede POS +
      // coupon_eval_discount sul carrello reale (apply_scope), messaggi Cassa verbatim.
      const couponItems = items
        .filter((it) => (it.type === "service" || it.type === "product") && it.refId > 0 && it.total > 0)
        .map((it) => ({ type: it.type === "product" ? ("product" as const) : ("service" as const), id: it.refId, line: it.total }));
      const coupon = await previewDbCoupon(couponCode, subtotal, slug, {
        items: couponItems.length ? couponItems : undefined,
        clientId: client.id > 0 ? client.id : 0,
        locationId,
      });
      if (!coupon.valid) {
        let reason = coupon.reason || "Coupon non valido o non applicabile.";
        if (reason.startsWith("Importo minimo richiesto:")) reason = `Coupon non applicabile: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
        else if (reason === "Nessun servizio/prodotto selezionato rientra nel coupon.") reason = "Coupon non applicabile agli articoli presenti nel carrello.";
        throw new Error(reason);
      }
      couponDiscount = coupon.discount;
    }
  }
  // FIDELITY points redemption: convert the requested points into an euro discount,
  // capped by the client balance + the amount still payable after manual + promo + coupon.
  // The points discount is ADDED to the sale discount (so the total drops) and the points
  // are consumed below, linked to the sale id. Mirrors pos.php: discount += fid_discount.
  let baseForPoints = roundMoney(Math.max(0, subtotal - manualDiscount - promoDiscount - couponDiscount));
  let pointsRequest = input.fidelityPointsUse ?? 0;
  // Promo NON cumulabile con la Fidelity (pos.php 4466-4512): i punti mordono solo
  // sulla parte del carrello NON scontata dalla promo (con ripartizione proporzionale
  // dello sconto manuale); se non esiste parte non-promo la richiesta punti si azzera
  // SILENZIOSAMENTE come nel legacy.
  if (promoApplied && !promoApplied.stackableWithFidelity) {
    const nonDisc = Math.max(0, promoApplied.nonDiscountedSubtotal);
    const manualPortion = subtotal > 0.00001 && manualDiscount > 0 ? manualDiscount * (nonDisc / subtotal) : 0;
    baseForPoints = roundMoney(Math.max(0, nonDisc - manualPortion));
    if (baseForPoints <= 0.00001) pointsRequest = 0;
  }
  const redemption = await resolveFidelityRedemption(slug, client.id, pointsRequest, baseForPoints);
  const discount = Math.min(subtotal, roundMoney(manualDiscount + promoDiscount + couponDiscount + redemption.discount));
  const total = roundMoney(Math.max(0, subtotal - discount));
  const payments = normalizePayments(input.payments, total);
  const paidAmount = roundMoney(payments.reduce((sum, payment) => sum + payment.amount, 0));
  // RATEIZZAZIONE (P5 semantica acconto): con un piano rate attivo in cassa entra
  // solo l'ACCONTO — il residuo è finanziato dalle rate (il legacy non valida
  // affatto gli importi: il floor sull'acconto è la traduzione fedele del flusso).
  // La scelta "unica soluzione" SCARTA esplicitamente il piano rate (pos.php:4633-4636:
  // installment_choice_mode === 'single' -> installment_plan_enabled=false, json=''), così
  // un payload con piano residuo non genera comunque rate su una vendita a saldo unico.
  const activePlan =
    input.installmentPlan && input.installmentChoice !== "single" && client.id > 0 && total > 0.00001 && Math.max(1, Math.round(input.installmentPlan.count)) >= 2
      ? input.installmentPlan
      : null;
  // Semantica legacy: il piano rate è calcolato sul totale NETTO dei residui applicati
  // (in legacy currentPosTotal è già al netto di credito/GiftCard; qui i residui sono
  // tender wallet/giftcard, quindi vanno sottratti prima di finanziare il resto).
  const residualTendersTotal = roundMoney(
    payments.reduce((sum, payment) => sum + (payment.method === "wallet" || payment.method === "giftcard" ? payment.amount : 0), 0),
  );
  const planNetTotal = roundMoney(Math.max(0, total - residualTendersTotal));
  // Stesso clamp di createManageInstallmentPlan (acconto < totale netto).
  const planDownPayment = activePlan ? roundMoney(Math.min(Math.max(0, activePlan.downPayment ?? 0), Math.max(0, planNetTotal - 0.01))) : 0;
  const paidFloor = activePlan ? roundMoney(residualTendersTotal + planDownPayment) : total;
  if (paidAmount + 0.00001 < paidFloor) throw new Error("Pagamento insufficiente.");

  // SCELTA OBBLIGATORIA unico/rateizzato lato server (pos.php 4623-4663): con totale
  // (netto residui) > 0 la vendita deve dichiarare la modalità di saldo; le ricariche
  // ammettono solo il pagamento unico; la scelta Rateizzato richiede piano e cliente.
  const installmentChoice = input.installmentChoice === "single" || input.installmentChoice === "installment" ? input.installmentChoice : "";
  const cartHasRecharge = items.some((item) => item.type === "recharge");
  if (planNetTotal > 0.00001) {
    if (!installmentChoice) {
      throw new Error("Seleziona se il cliente paga in unica soluzione o rateizzato prima di concludere la vendita.");
    }
    if (cartHasRecharge && installmentChoice !== "single") {
      throw new Error("Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.");
    }
    if (installmentChoice === "installment") {
      if (client.id <= 0) throw new Error("Seleziona un cliente per configurare la rateizzazione.");
      if (!activePlan) throw new Error("Configura il piano rate prima di concludere la vendita.");
    }
  }

  // Nota vendita legacy (pos.php 4666-4669): "Rateizzazione: acconto € X •
  // residuo € Y • N rate • prima scadenza YYYY-MM-DD".
  const installmentNoteLine = activePlan
    ? `Rateizzazione: acconto € ${formatMoney(planDownPayment)}` +
      ` • residuo € ${formatMoney(Math.max(0, planNetTotal - planDownPayment))}` +
      ` • ${Math.max(2, Math.min(120, Math.round(activePlan.count)))} rate` +
      ` • prima scadenza ${normalizeInstallmentDate(activePlan.firstDueDate ?? "") || addDaysIso(todayIso(), 30)}`
    : "";

  // FIDELITY points EARNED on this sale. The earn base is the "totale pagato, netto sconti e al
  // netto di credito/GiftCard usati" (pos.php ~4671-4695): the sale total AFTER discounts MINUS the
  // residui the client redeemed (their own wallet credit + GiftCard balance), so points accrue only
  // on NEW external spend and never on redeemed residui. Computed just below, once the residui are
  // resolved (line ~528). Gated on fidelity_enabled + fidelity_points_enabled + a real client
  // + l'ADESIONE tessera (F2 — Fidelity::isClientAdhering: senza tessera attiva non si
  // accumulano punti, come nel legacy con la tabella cards presente); persisted on the sale
  // row + AWARDED after the insert, reversed on void.
  const earnSettings = await getFidelityEarnSettings(slug);

  // Residui: validate the wallet CREDIT + GiftCard tenders against the client's real
  // balances BEFORE writing anything. The base method (cash/card/transfer) covers the
  // remainder. Faithful to pos.php: giftcard_used = min(giftcardBalance, total, req),
  // credit_used = min(walletBalance, total - giftcard_used, req). Residui require a
  // real client (id > 0); a bench sale ("Cliente banco") cannot spend residui.
  const residui = await resolveResiduiTenders(slug, payments, client.id, total);

  // Earn base = net after residui (see the fidelity-earn note above): the total minus the client's
  // own credit + GiftCard redeemed, so redeemed residui never generate fresh points.
  const earnBase = roundMoney(Math.max(0, total - residui.creditUsed - residui.giftcardUsed));
  // Campaign-aware earn: points accrue only under the ACTIVE campaign for the sale date
  // (no campaign => 0), using its step/tiers + min_spend + level eligibility; the
  // campaign id is stamped on the sale (sales.fidelity_campaign_id).
  const campaignEarn =
    earnSettings.enabled && client.id > 0 && (await fidelityIsClientAdhering(slug, client.id))
      ? await computeCampaignEarn(slug, earnBase, client.id, earnSettings.earnStep)
      : { points: 0, campaignId: 0 };
  const pointsEarned = campaignEarn.points;

  for (const item of items) {
    if (item.type === "product" && item.refId > 0 && item.status !== "ordered") {
      const available = await currentProductStock(slug, item.refId, locationId);
      // Verbatim legacy (pos.php 3928).
      if (available + 0.00001 < item.quantity) throw new Error(`Stock insufficiente per ${item.name}`);
    }
  }

  const baseMethod = resolveBaseMethod(payments);

  // Righe note vendita legacy (pos.php: promo 4273, coupon 4426-4430, sconto manuale
  // 4460, GiftCard utilizzata 4587-4589, credito 4607, tipo pagamento 4627): le note
  // della vendita raccontano lo scontrino come nel PHP (visibili nel dettaglio vendita).
  const legacyNoteLines: string[] = [];
  if (promoApplied && promoDiscount > 0.00001) {
    // Promo applicata via CODICE -> "NAME (CODE)" come il legacy (pos.php:4304-4336);
    // via promotion_id -> solo "NAME".
    const promoLabel = promoApplied.code ? `${promoApplied.name || "PROMO"} (${promoApplied.code})` : (promoApplied.name || "PROMO");
    legacyNoteLines.push(`Promozione: ${promoLabel} -${formatMoney(promoDiscount)}`);
  }
  if (couponCode && couponDiscount > 0.00001) {
    legacyNoteLines.push(`Coupon: ${couponCode.toUpperCase()}`);
    legacyNoteLines.push(`Sconto coupon: - € ${formatMoney(couponDiscount)}`);
  }
  if (manualDiscount > 0.00001) legacyNoteLines.push(`Sconto manuale: -€ ${formatMoney(manualDiscount)}`);
  if (residui.giftcardUsed > 0.00001) {
    legacyNoteLines.push(`GiftCard utilizzata${residui.giftcardCode ? ` (${residui.giftcardCode})` : ""}: -€ ${formatMoney(residui.giftcardUsed)}`);
  }
  if (residui.creditUsed > 0.00001) legacyNoteLines.push(`Credito utilizzato: -€ ${formatMoney(residui.creditUsed)}`);
  // "Tipo pagamento: {label}" solo con totale (netto) > 0, come il legacy (pos.php 4623-4627).
  if (planNetTotal > 0.00001) legacyNoteLines.push(`Tipo pagamento: ${LEGACY_PAYMENT_TYPE_LABELS[baseMethod] ?? ""}`.trimEnd());

  const salesTable = await tenantTable(slug, "sales");
  const saleId = await tenantInsert(salesTable, await filterColumns(salesTable.name, {
    client_id: client.id > 0 ? client.id : null,
    sale_date: new Date(),
    subtotal,
    discount,
    total,
    coupon_code: emptyToNull(couponCode),
    notes: saleNotes(input.notes, input.appointmentId, baseMethod, installmentNoteLine, legacyNoteLines),
    status: "done",
    // IN-POS quote import: link the sale back to the source quote (faithful to pos.php:4802
    // UPDATE sales SET source_quote_id). The quote itself is flipped to 'converted' below.
    source_quote_id: input.sourceQuoteId && input.sourceQuoteId > 0 ? input.sourceQuoteId : undefined,
    created_by: operator.id,
    operator_name: clean(operator.name, 120),
    location_id: locationId,
    promotion_applied_id: promoApplied ? promoApplied.id : null,
    promotion_applied_name: promoApplied ? clean(promoApplied.name, 190) : null,
    promotion_applied_discount: promoApplied ? promoDiscount : 0,
    promotion_applied_non_discounted_subtotal: promoApplied ? promoApplied.nonDiscountedSubtotal : 0,
    credit_used: residui.creditUsed,
    giftcard_id: residui.giftcardId > 0 ? residui.giftcardId : null,
    giftcard_used: residui.giftcardUsed,
    // Persist the FIDELITY points spent + their euro discount (sales.fidelity_points_used /
    // sales.fidelity_discount), so a later void can refund them. Schema-guarded.
    fidelity_points_used: redemption.pointsUsed,
    fidelity_discount: redemption.discount,
    // Persist the points EARNED so a later void can reverse them (schema-guarded).
    fidelity_points_earned: pointsEarned,
    // Stamp the campaign that produced the earn (schema-guarded).
    fidelity_campaign_id: campaignEarn.campaignId > 0 ? campaignEarn.campaignId : null,
    // Persist the faithful base payment method. Schema-guarded: a no-op on installs
    // without the column (the notes marker keeps derivePayments correct regardless).
    payment_methods: JSON.stringify({ base: baseMethod }),
  }));

  // RECORD the promotion redemption (port of Promotions::reserveSaleUse): one
  // promotion_redemptions row linked to the sale, reversed on void (deleted in
  // cancelLinkedSaleResidues). Schema-guarded via filterColumns.
  if (promoApplied && promoDiscount > 0) {
    const redTable = await tenantTable(slug, "promotion_redemptions").catch(() => null);
    if (redTable) {
      await tenantInsert(redTable, await filterColumns(redTable.name, {
        promotion_id: promoApplied.id,
        client_id: client.id > 0 ? client.id : null,
        sale_id: saleId,
        discount_amount: promoDiscount,
        location_id: locationId,
        redeemed_at: new Date(),
      })).catch(() => 0);
    }
  }

  // CONSUME the residui, linking each consumption to the sale id so a later void can
  // restore it (cancelLinkedSaleResidues reverses both). GiftCard first, then credit.
  if (residui.giftcardId > 0 && residui.giftcardUsed > 0) {
    await redeemDbGiftCard(residui.giftcardId, residui.giftcardUsed, slug);
  }
  if (residui.creditUsed > 0 && client.id > 0) {
    // Negative wallet movement (debit): inserts a credit_adjustments row + decrements
    // clients.credit_balance (the same path the legacy credit_wallet_adjust uses).
    await addDbWalletMovement(
      { clientId: client.id, type: "debit", amount: -residui.creditUsed, note: `Credito utilizzato vendita #${saleId}` },
      slug,
    );
  }
  // CONSUME the redeemed FIDELITY points: a negative points_redeem movement inserts a
  // transactions row (kind=redeem, source_type=sale) + decrements clients.points — the
  // points analog of the credit consume. Linked to the sale id for the void refund below.
  if (redemption.pointsUsed > 0 && client.id > 0) {
    await addDbWalletMovement(
      {
        clientId: client.id,
        type: "points_redeem",
        points: -redemption.pointsUsed,
        source: "sale",
        note: `Sconto Fidelity vendita #${saleId}`,
      },
      slug,
    );
  }
  // AWARD the EARNED fidelity points: a positive points_earn movement inserts a
  // transactions row (kind=earn, source_type=sale) + increments clients.points. Reversed
  // on void via sales.fidelity_points_earned.
  if (pointsEarned > 0 && client.id > 0) {
    await addDbWalletMovement(
      { clientId: client.id, type: "points_earn", points: pointsEarned, source: "sale", note: `Punti vendita #${saleId}` },
      slug,
    );
  }

  // ISSUED VOUCHERS: the generated GiftCard/GiftBox CODES (+ recipient/amount) created by this
  // sale, collected from the issuance helpers so the checkout response can surface them on the
  // printable receipt (the code is otherwise written only to the giftcards/giftbox_instances
  // tables). Faithful to pos_success.php showing "GiftCard/GiftBox emessa (CODE)".
  const issuedVouchers: IssuedVoucher[] = [];

  // OMAGGI (F12): righe servizio/prodotto per il tracking eventi (Gifts::recordSale) —
  // il source_line_id è l'id riga sale_items appena inserito.
  const giftLines: Array<{ type: string; refId: number; qty: number; lineTotal: number; saleItemId: number }> = [];

  // Tag note post-emissione legacy: "Pacchetti: CP#12, CP#13" e "Ricariche: R#5"
  // (pos.php 5457-5458 / 5638-5639), appesi alle note vendita dopo gli insert.
  const createdClientPackages: number[] = [];
  const createdRecharges: number[] = [];

  for (const item of items) {
    const saleItemId = await insertSaleItem(slug, saleId, item);
    if ((item.type === "service" || item.type === "product") && item.refId > 0) {
      giftLines.push({ type: item.type, refId: item.refId, qty: item.quantity, lineTotal: item.total, saleItemId });
    }
    if (item.type === "product" && item.refId > 0 && item.status !== "ordered") {
      await adjustProductStock(slug, item.refId, locationId, -item.quantity);
    }
    if (item.type === "prepaid" && client.id > 0) await issuePrepaidFromSale(slug, saleId, saleItemId, client.id, item);
    if (item.type === "package" && client.id > 0) {
      const clientPackageId = await issuePackageFromSale(slug, saleId, client.id, item);
      if (clientPackageId > 0) createdClientPackages.push(clientPackageId);
    }
    // SELL a GiftCard: issue a real giftcards row owned by the chosen recipient (so it
    // appears in their residui/voucher). The card amount is the line price (qty 1). A
    // bench sale (no buyer + no recipient picked) cannot own a card, so it is gated on a
    // resolvable recipient inside issueGiftcardFromSale.
    if (item.type === "giftcard") {
      const issued = await issueGiftcardFromSale(slug, saleId, client.id, item, locationId);
      if (issued.voucher) issuedVouchers.push(issued.voucher);
      // Nome riga legacy col codice emesso: "GiftCard • <code>" (pos.php 5509).
      if (issued.voucher?.code) {
        await tenantUpdate({ slug, table: "sale_items", id: saleItemId, values: { item_name: `GiftCard • ${issued.voucher.code}` } }).catch(() => 0);
      }
    }
    // SELL a GiftBox: issue a real giftbox_instances row (+ its items copied from the chosen
    // giftboxes template) OWNED by the recipient (defaults to the sale client), so it appears
    // in their residui and the drawer's giftbox redeem can consume it. A bench sale with no
    // resolvable recipient is skipped inside issueGiftboxFromSale.
    if (item.type === "giftbox") {
      const issued = await issueGiftboxFromSale(slug, saleId, client.id, item, locationId);
      if (issued.voucher) issuedVouchers.push(issued.voucher);
      // Nome riga legacy col codice emesso: "GiftBox • <code>" (pos.php 5143).
      if (issued.voucher?.code) {
        await tenantUpdate({ slug, table: "sale_items", id: saleItemId, values: { item_name: `GiftBox • ${issued.voucher.code}` } }).catch(() => 0);
      }
    }
    // SELL a RECHARGE: insert a recharges row (base/bonus/total/points), CREDIT the wallet by
    // base+bonus, and EARN fidelity points (when earn_points + eligible). A recharge tops up
    // a real client's wallet, so it requires client.id > 0 (a bench sale has no wallet).
    if (item.type === "recharge" && client.id > 0) {
      const rechargeId = await issueRechargeFromSale(slug, saleId, client.id, item, locationId, operator.id);
      if (rechargeId > 0) createdRecharges.push(rechargeId);
    }
  }

  // Append note legacy "Pacchetti: CP#..." / "Ricariche: R#..." (best-effort).
  if (createdClientPackages.length || createdRecharges.length) {
    const extraLines: string[] = [];
    if (createdClientPackages.length) extraLines.push(`Pacchetti: ${createdClientPackages.map((id) => `CP#${id}`).join(", ")}`);
    if (createdRecharges.length) extraLines.push(`Ricariche: ${createdRecharges.map((id) => `R#${id}`).join(", ")}`);
    const saleRows = await tenantSelect<RowDataPacket>({ slug, table: "sales", columns: "notes", where: "id = ?", params: [saleId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const currentNotes = String(saleRows[0]?.notes ?? "").trim();
    const merged = [currentNotes, ...extraLines].filter(Boolean).join("\n");
    await tenantUpdate({ slug, table: "sales", id: saleId, values: { notes: merged } }).catch(() => 0);
  }

  if (input.appointmentId && input.appointmentId > 0) {
    await tenantUpdate({ slug, table: "appointments", id: input.appointmentId, values: { status: "done" } }).catch(() => 0);
    // OMAGGI (F12): il done da cassa riscatta la selezione omaggi in sospeso
    // della prenotazione (come il cambio stato dal calendario).
    await giftRedeemAppointmentSelectionIfAny(slug, input.appointmentId, operator.id).catch(() => undefined);
  }

  // OMAGGI (F12): eventi service_sold/product_sold + ricalcolo maturazione del cliente
  // (Gifts::recordSale, chiamato dal legacy subito dopo l'insert vendita). Best-effort:
  // un problema omaggi non deve mai far fallire la cassa.
  if (client.id > 0 && giftLines.length) {
    await giftRecordSale(slug, saleId, client.id, giftLines, subtotal, discount, locationId).catch(() => undefined);
  }

  // RATEIZZAZIONE: when a rate plan was configured (count >= 2) AND the sale has a real
  // client + a positive total, write the sale_installment_plans row + N sale_installments
  // rows scheduling the financed remainder (total - downPayment). Faithful to pos.php's
  // `SaleInstallments::createPlan` call after the sale insert. The sale total + payments are
  // unchanged: the plan only schedules the financing (the down payment is collected at the
  // sale, the remainder over the installments). A bench sale (no client) or a single payment
  // skips this — mirroring the legacy `client_id <= 0` guard in createPlan.
  const plan = activePlan;
  if (plan && client.id > 0 && total > 0.00001 && Math.max(1, Math.round(plan.count)) >= 2) {
    await createManageInstallmentPlan(slug, {
      saleId,
      clientId: client.id,
      // Totale NETTO dei residui (semantica legacy: il finanziato è netTotal - acconto).
      total: planNetTotal,
      downPayment: plan.downPayment ?? 0,
      count: plan.count,
      intervalValue: plan.intervalValue ?? 1,
      intervalUnit: plan.intervalUnit ?? "month",
      firstDueDate: plan.firstDueDate ?? "",
      note: plan.note ?? "",
      paymentType: baseMethod,
      createdBy: operator.id,
    });
  }

  // IN-POS quote import: flip the source quote to 'converted' now the sale exists (faithful to
  // QuoteSale::mark_quote_paid — the Next quote lifecycle uses 'converted'/converted_sale_id, not
  // 'paid'). Best-effort + guarded: only when a quote was imported and it isn't already converted.
  if (input.sourceQuoteId && input.sourceQuoteId > 0) {
    await markQuoteConvertedFromSale(slug, input.sourceQuoteId, saleId).catch(() => undefined);
  }

  const sale = await getSale(slug, saleId);
  return {
    ...await getManagePosContext(slug, { locationId, includeCancelled: true }),
    sale,
    // The GiftCard/GiftBox codes this sale issued, for the printable receipt (empty when none).
    issuedVouchers,
    // Punti Fidelity maturati sulla vendita (pos_success.php blocco "Fidelity":
    // Punti usati / Punti guadagnati).
    fidelityPointsEarned: pointsEarned,
  };
}

// Flip an imported quote to 'converted' + stamp converted_sale_id/at, mirroring the quotes-module
// convertDbQuoteToSale flip (kept identical so both conversion paths leave the same quote state).
// Guarded: reads the current status and skips if the quote is missing or already converted, so a
// re-checkout never overwrites the original conversion.
async function markQuoteConvertedFromSale(slug: string, quoteId: number, saleId: number): Promise<void> {
  const quoteTable = await tenantTable(slug, "quotes").catch(() => null);
  if (!quoteTable) return;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: quoteTable.name, columns: "id, status", where: "id=?", params: [quoteId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const current = rows[0];
  if (!current) return;
  if (String(current.status ?? "").toLowerCase() === "converted") return;
  const values: Record<string, unknown> = { status: "converted" };
  if (await columnExists(quoteTable.name, "converted_sale_id")) values.converted_sale_id = saleId;
  if (await columnExists(quoteTable.name, "converted_at")) values.converted_at = new Date();
  if (await columnExists(quoteTable.name, "updated_at")) values.updated_at = new Date();
  await tenantUpdate({ slug, table: "quotes", id: quoteId, values }).catch(() => 0);
}

// Faithful port of SaleInstallments::createPlan (via preparePlanConfig + buildSchedule).
// Writes a sale_installment_plans row (down_payment_amount, financed_amount = total -
// downPayment, installments_count, interval_value/unit, first_due_date, last_due_date,
// sale_total, status 'active') + `count` sale_installments rows (installment_no 1..N,
// status 'pending'). The schedule splits the FINANCED amount (not the sale total): legacy
// buildSchedule works in cents — base = financedCents / count, remainder = financedCents -
// base*count, and the FIRST `remainder` installments each get +1 cent (front-loaded), so the
// row amounts sum exactly to the financed amount. Due dates step from first_due_date by
// interval_value * (i-1) of interval_unit (installment 1 = first_due_date itself, i.e. 0
// iterations). Best-effort: a no-op on installs without the tables (older installs).
async function createManageInstallmentPlan(
  slug: string,
  input: {
    saleId: number;
    clientId: number;
    total: number;
    downPayment: number;
    count: number;
    intervalValue: number;
    intervalUnit: "day" | "week" | "month";
    firstDueDate: string;
    note: string;
    paymentType: PosPaymentMethod;
    createdBy: number | null;
  },
): Promise<void> {
  try {
    const saleTotal = roundMoney(Math.max(0, input.total));
    if (saleTotal <= 0.00001) return;

    const count = Math.max(1, Math.min(120, Math.round(input.count)));
    if (count < 2) return;

    // Down payment (acconto) collected at the sale; must stay below the sale total so the
    // financed remainder is positive (legacy: downPayment >= saleTotal throws). Clamp it.
    const downPayment = roundMoney(Math.min(Math.max(0, input.downPayment), Math.max(0, saleTotal - 0.01)));
    const financed = roundMoney(saleTotal - downPayment);
    if (financed <= 0.00001) return;

    const intervalUnit: "day" | "week" | "month" =
      input.intervalUnit === "day" || input.intervalUnit === "week" ? input.intervalUnit : "month";
    const maxInterval = intervalUnit === "day" ? 365 : intervalUnit === "week" ? 52 : 24;
    const intervalValue = Math.max(1, Math.min(maxInterval, Math.round(input.intervalValue) || 1));

    const firstDue = normalizeInstallmentDate(input.firstDueDate) || addDaysIso(todayIso(), 30);
    const paymentType = installmentPaymentType(input.paymentType);

    // buildSchedule (cents, front-loaded remainder): the row amounts sum exactly to financed.
    const financedCents = Math.round(financed * 100);
    const base = Math.floor(financedCents / count);
    const remainder = financedCents - base * count;
    const schedule = Array.from({ length: count }, (_, idx) => {
      const no = idx + 1;
      const cents = base + (no <= remainder ? 1 : 0);
      return {
        installmentNo: no,
        dueDate: shiftInstallmentDate(firstDue, intervalUnit, intervalValue, idx),
        amount: roundMoney(cents / 100),
      };
    });
    const lastDue = schedule.length ? schedule[schedule.length - 1].dueDate : firstDue;

    const plansTable = await tenantTable(slug, "sale_installment_plans");
    const planId = await tenantInsert(plansTable, await filterColumns(plansTable.name, {
      sale_id: input.saleId,
      client_id: input.clientId,
      payment_type: paymentType,
      status: "active",
      sale_total: saleTotal,
      down_payment_amount: downPayment,
      financed_amount: financed,
      installments_count: count,
      interval_value: intervalValue,
      interval_unit: intervalUnit,
      first_due_date: firstDue,
      last_due_date: lastDue,
      notes: clean(input.note, 1000) || null,
      config_json: JSON.stringify({
        source: "next",
        client_id: input.clientId,
        sale_total: saleTotal,
        payment_type: paymentType,
        down_payment_amount: downPayment,
        financed_amount: financed,
        installments_count: count,
        interval_value: intervalValue,
        interval_unit: intervalUnit,
        first_due_date: firstDue,
        last_due_date: lastDue,
        schedule,
      }),
      created_by: input.createdBy,
      updated_by: input.createdBy,
    }));

    const installmentsTable = await tenantTable(slug, "sale_installments");
    for (const row of schedule) {
      await tenantInsert(installmentsTable, await filterColumns(installmentsTable.name, {
        plan_id: planId,
        sale_id: input.saleId,
        client_id: input.clientId,
        installment_no: row.installmentNo,
        due_date: row.dueDate,
        amount: row.amount,
        status: "pending",
        payment_type: paymentType,
        created_by: input.createdBy,
        updated_by: input.createdBy,
      }));
    }
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

// Map the POS base method (PosPaymentMethod: cash/card/transfer/giftcard/wallet) to the
// installment payment_type enum SaleInstallments::normalizePaymentType yields (cash/card/
// check/bank). transfer -> bank; wallet/giftcard residui tenders default to card.
function installmentPaymentType(method: PosPaymentMethod): string {
  if (method === "cash") return "cash";
  if (method === "check") return "check";
  if (method === "transfer") return "bank";
  return "card";
}

// Validate a YYYY-MM-DD installment date; "" when invalid (caller falls back to +30d).
function normalizeInstallmentDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return "";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dim = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > dim) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Port of SaleInstallments::shiftDate: step firstDue by interval_value * iterations of the
// unit (day/week/month). iterations === 0 returns the date unchanged (installment #1 lands on
// first_due_date). Month stepping clamps the day to the target month length (e.g. 31 -> 30/28).
function shiftInstallmentDate(date: string, unit: "day" | "week" | "month", value: number, iterations: number): string {
  const safeDate = normalizeInstallmentDate(date) || todayIso();
  const steps = Math.max(0, Math.round(iterations));
  if (steps === 0) return safeDate;
  const step = Math.max(1, Math.round(value));
  if (unit === "day") return addDaysIso(safeDate, step * steps);
  if (unit === "week") return addDaysIso(safeDate, step * steps * 7);
  return addMonthsIso(safeDate, step * steps);
}

// Fidelity-points STORNO mode when reversing earned points would drive the balance negative
// (port of pos_history.php's points_storno_mode). "normal" fails safe (throws on insufficient
// balance); "negative" reverses anyway (balance allowed to go below zero); "skip" completes the
// void WITHOUT reversing the earned points (writes an audit note instead).
export type PointsStornoMode = "normal" | "negative" | "skip";

export async function cancelManageSale(
  slug: string,
  input: {
    saleId: number;
    reason: string;
    stockCancelMode: "restore" | "no_restore" | "none";
    userId: number | null;
    userName: string;
    // SALE-level earned-points storno decision (default "normal"). Only meaningful when the
    // preview surfaced pointsStornoExtra; otherwise the balance is sufficient and "normal" is
    // a no-throw reverse.
    pointsStornoMode?: PointsStornoMode;
    // PER-recharge earned-points storno decisions, keyed by recharge id (default "normal" per id).
    rechargePointsModes?: Record<number, PointsStornoMode>;
  },
): Promise<ManagePosContext & { sale: PosSale }> {
  if (input.saleId <= 0) throw new Error("Vendita non valida.");
  const saleRow = await getSaleRow(slug, input.saleId);
  // Per-sale location access guard (port of _pos_hist_assert_sale_location_access).
  await assertSaleLocationAccess(slug, Number(saleRow.location_id ?? 0) || 0);
  if (isCancelledStatus(saleRow.status)) throw new Error("Vendita già annullata.");
  const reason = clean(input.reason, 255);
  if (!reason) throw new Error("La motivazione è obbligatoria per annullare una vendita.");
  // BLOCKER prenotazioni collegate (D1): se un pacchetto/giftbox/prepagato emesso dalla
  // vendita è ancora collegato a una prenotazione NON annullata, l'annullo è impedito
  // (altrimenti si annullerebbe il residuo lasciando la prenotazione a referenziarlo).
  // Enforcement server-side, non solo UI (port di appt_lifecycle_apply_sale_cancel_reservation_policy).
  const linkedActiveAppts = await saleCancelLinkedAppointments(slug, input.saleId);
  if (linkedActiveAppts.length > 0) throw new Error(linkedActiveAppts[0].blocker);
  const sale = await mapSale(slug, saleRow);
  const locationId = Number(saleRow.location_id ?? sale.locationId ?? 0) || 0;
  const productItems = sale.items.filter((item) => item.type === "product" && item.refId > 0 && item.status !== "ordered");
  let stockMode = input.stockCancelMode;
  if (!productItems.length) stockMode = "none";
  if (productItems.length && !["restore", "no_restore"].includes(stockMode)) {
    throw new Error("Scegli come gestire il magazzino dei prodotti prima di confermare l'annullamento.");
  }

  for (const item of productItems) {
    const before = await currentProductStock(slug, item.refId, locationId);
    let after = before;
    if (stockMode === "restore") {
      await adjustProductStock(slug, item.refId, locationId, item.quantity);
      after = await currentProductStock(slug, item.refId, locationId);
    }
    await recordStockCancelAction(slug, {
      saleId: input.saleId,
      saleItemId: item.id,
      productId: item.refId,
      qty: item.quantity,
      action: stockMode === "restore" ? "restored" : "not_restored",
      stockBefore: before,
      stockAfter: after,
      locationId,
      note: stockMode === "restore" ? `Ripristino magazzino su annullamento vendita #${input.saleId}` : `Magazzino non ripristinato su annullamento vendita #${input.saleId}`,
      createdBy: input.userId,
    });
  }

  // Refuse a normal-mode storno that would go negative BEFORE mutating anything (the cancel is
  // not one transaction), reproducing the legacy transaction-rollback for the only throw the
  // storno decision adds. negative/skip never gate here.
  const pointsModes = {
    pointsStornoMode: input.pointsStornoMode ?? ("normal" as PointsStornoMode),
    rechargePointsModes: input.rechargePointsModes ?? {},
  };
  await assertNormalStornoFeasible(slug, saleRow, pointsModes);

  await markSaleCancelled(slug, input.saleId, {
    userId: input.userId,
    reason,
    note: cancelNote(input.saleId, input.userName, reason, stockMode, productItems),
  });
  await cancelLinkedSaleResidues(slug, input.saleId, reason, saleRow, input.userId, pointsModes, input.userName);

  // OMAGGI (F12): lo storno invalida gli eventi di tracking della vendita e ricalcola
  // la maturazione (un "disponibile" non più coperto regredisce ad accumulo).
  await giftInvalidateSource(slug, "sale", input.saleId).catch(() => undefined);

  const updated = await getSale(slug, input.saleId);
  return {
    ...await getManagePosContext(slug, { locationId, includeCancelled: true }),
    sale: updated,
  };
}

// HARD-DELETE an ALREADY-CANCELLED sale (port of pos_sale_detail.php's
// delete_cancelled_sale action ~2753-3128). This is the SEPARATE permanent removal of a sale
// that was already voided — NOT the void/cancel (that is cancelManageSale). Gated by: the
// sale must exist, be status=cancelled, and be at a location the user can access; plus an
// appointment-cleanup blocker (a sale still tied to an appointment refuses, telling the
// operator to detach the booking first). Purga anche gli ARTEFATTI emessi dalla vendita con
// le guardie legacy per-artefatto (GiftCard/GiftBox annullate e non collegate altrove,
// pacchetti/prepagati senza prenotazioni, ricariche stornate) — messaggi legacy esatti —
// poi il piano rate, gli eventi 'sale', l'audit magazzino, le righe e la vendita. Runs as
// ONE atomic transaction so a failure never leaves a half-deleted sale.
//
// Divergenze documentate: (1) il blocker legacy "ricarica collegata a prenotazioni" usa
// l'allocazione FIFO di CreditRechargeCancel — qui la ricarica deve solo essere gia'
// stornata (il void Next ripristina il credito, quindi non esistono allocazioni residue);
// (2) i movimenti Commissioni non vengono eliminati: il motore Next e' compute-on-view e
// il reconcile marca 'cancelled' le entry di una vendita sparita al ricalcolo successivo.
export async function deleteCancelledSale(
  slug: string,
  input: { saleId: number; userId: number | null },
): Promise<ManagePosContext> {
  if (input.saleId <= 0) throw new Error("Vendita non valida.");
  const saleRow = await getSaleRow(slug, input.saleId);
  const locationId = Number(saleRow.location_id ?? 0) || 0;
  // Per-sale location access guard (port of _pos_hist_assert_sale_location_access).
  await assertSaleLocationAccess(slug, locationId);
  if (!isCancelledStatus(saleRow.status)) {
    throw new Error("È possibile eliminare solo vendite già annullate.");
  }

  // Appointment-cleanup blocker (faithful minimal port of the legacy
  // appt_lifecycle_preview_sale_delete_appointment_cleanup gate): a sale still tied to an
  // appointment cannot be purged automatically — the operator must detach/clean the booking
  // first. The Next POS links a sale to its appointment via the "Appuntamento #id" notes
  // marker (checkout also sets the appointment 'done'); an appointment_id column is honoured
  // too when present.
  const linkedAppointmentId = await saleLinkedAppointmentId(slug, saleRow);
  if (linkedAppointmentId > 0) {
    throw new Error(
      `La vendita ha ancora una prenotazione collegata (#${linkedAppointmentId}) non eliminabile automaticamente. Rimuovi prima i collegamenti/residui dalla prenotazione e poi ripeti l'eliminazione.`,
    );
  }

  // --- ARTEFATTI emessi dalla vendita: guardie legacy PRIMA di toccare qualsiasi riga ---
  // (pos_sale_detail.php ~2913-3060; ogni throw usa la stringa legacy esatta).
  const throwaway: string[] = [];
  const issuedGiftcards = await summarizeIssuedGiftcards(slug, input.saleId, throwaway, throwaway).catch(() => []);
  const issuedGiftboxes = await summarizeIssuedGiftboxes(slug, input.saleId, throwaway).catch(() => []);
  const linkedPackages = await summarizeLinkedRows(slug, "client_packages", input.saleId, (r) => ({ id: Number(r.id ?? 0) })).catch(() => []);
  const linkedPrepaids = await summarizeLinkedRows(slug, "client_prepaid_services", input.saleId, (r) => ({ id: Number(r.id ?? 0) })).catch(() => []);
  const linkedRecharges = await summarizeLinkedRows(slug, "recharges", input.saleId, (r) => ({ id: Number(r.id ?? 0), isVoid: Number(r.is_void ?? 0) === 1 })).catch(() => []);

  const countRows = async (table: string, where: string, params: unknown[]): Promise<number> =>
    (await tenantSelect<RowDataPacket>({ slug, table, columns: "id", where, params, limit: 1 }).catch(() => [] as RowDataPacket[])).length;

  for (const card of issuedGiftcards) {
    const label = card.code || `#${card.id}`;
    if (!["cancelled", "canceled"].includes(card.status)) {
      throw new Error(`GiftCard ${label}: elimina la vendita solo dopo l'annullamento della GiftCard.`);
    }
    if (await countRows("appointments", "giftcard_id = ? AND COALESCE(giftcard_used,0) > 0", [card.id])) {
      throw new Error(`GiftCard ${label}: è ancora collegata a prenotazioni.`);
    }
    if (await countRows("sales", "giftcard_id = ? AND id <> ? AND COALESCE(giftcard_used,0) > 0", [card.id, input.saleId])) {
      throw new Error(`GiftCard ${label}: è ancora collegata ad altre vendite.`);
    }
  }

  // giftbox_id del template per la pulizia post-delete (istanza -> template orfano).
  const giftboxTemplateIds = new Map<number, number>();
  for (const box of issuedGiftboxes) {
    const label = box.code || `#${box.id}`;
    if (!["cancelled", "canceled"].includes(box.status)) {
      throw new Error(`GiftBox ${label}: elimina la vendita solo dopo l'annullamento della GiftBox.`);
    }
    if (await countRows("appointment_giftbox_items", "instance_id = ?", [box.id])) {
      throw new Error(`GiftBox ${label}: è ancora collegata a prenotazioni.`);
    }
    if (await countRows("giftbox_redemptions", "instance_id = ?", [box.id])) {
      throw new Error(`GiftBox ${label}: contiene riscatti storici.`);
    }
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", columns: "giftbox_id", where: "id = ?", params: [box.id], limit: 1 }).catch(() => [] as RowDataPacket[]);
    giftboxTemplateIds.set(box.id, Math.max(0, Number(rows[0]?.giftbox_id ?? 0) || 0));
  }

  for (const pkg of linkedPackages) {
    if (await countRows("appointment_package_items", "client_package_id = ?", [pkg.id])) {
      throw new Error(`Pacchetto CP#${pkg.id}: è ancora collegato a prenotazioni.`);
    }
  }
  for (const prep of linkedPrepaids) {
    if (await countRows("appointment_prepaid_service_items", "client_prepaid_service_id = ?", [prep.id])) {
      throw new Error(`Servizio prepagato #${prep.id}: è ancora collegato a prenotazioni.`);
    }
  }
  for (const rech of linkedRecharges) {
    if (!rech.isVoid) {
      throw new Error(`Ricarica #${rech.id}: elimina la vendita solo dopo lo storno della ricarica.`);
    }
  }

  // Resolve the child-table names ONCE (schema-guarded) so the transaction only touches
  // tables that exist. Each delete is tenant-scoped via tenantScope.
  const salesTable = await tenantTable(slug, "sales");
  const saleItemsTable = await tenantTable(slug, "sale_items").catch(() => null);
  const plansTable = await tenantTable(slug, "sale_installment_plans").catch(() => null);
  const installmentsTable = await tenantTable(slug, "sale_installments").catch(() => null);
  const eventsTable = await tenantTable(slug, "events").catch(() => null);
  const stockAuditTable = await tenantTable(slug, "pos_sale_stock_cancel_actions").catch(() => null);
  const resolve = async (name: string) => tenantTable(slug, name).catch(() => null);
  const giftcardTxTable = await resolve("giftcard_transactions");
  const giftcardItemsTable = await resolve("giftcard_items");
  const giftcardsTable = await resolve("giftcards");
  const giftboxTxTable = await resolve("giftbox_transactions");
  const giftboxInstanceItemsTable = await resolve("giftbox_instance_items");
  const giftboxInstancesTable = await resolve("giftbox_instances");
  const giftboxItemsTable = await resolve("giftbox_items");
  const giftboxesTable = await resolve("giftboxes");
  const cpUsagesTable = await resolve("client_package_usages");
  const cpTxTable = await resolve("client_package_transactions");
  const cpServicesTable = await resolve("client_package_services");
  const cpItemsTable = await resolve("client_package_items");
  const clientPackagesTable = await resolve("client_packages");
  const prepaidUsagesTable = await resolve("client_prepaid_service_usages");
  const prepaidsTable = await resolve("client_prepaid_services");
  const rechargesTable = await resolve("recharges");
  const commissionSnapshotsTable = await resolve("staff_commission_payments");

  await withTenantTransaction(slug, async (q) => {
    const del = async (table: TenantTarget | null, clauses: string[], params: unknown[]) => {
      if (!table) return;
      const scope = await tenantScope(table, clauses, params);
      await q(`DELETE FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params);
    };
    const countIn = async (table: TenantTarget | null, clauses: string[], params: unknown[]): Promise<number> => {
      if (!table) return 0;
      const scope = await tenantScope(table, clauses, params);
      const rows = (await q(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params)) as RowDataPacket[];
      return Number(rows[0]?.n ?? 0) || 0;
    };

    // Artefatti (le guardie sono già passate): giftcard -> transazioni + righe + card.
    for (const card of issuedGiftcards) {
      await del(giftcardTxTable, ["giftcard_id=?"], [card.id]);
      await del(giftcardItemsTable, ["giftcard_id=?"], [card.id]);
      await del(giftcardsTable, ["id=?"], [card.id]);
    }
    // GiftBox: transazioni + item istanza + istanza; template orfano -> item + template.
    for (const box of issuedGiftboxes) {
      await del(giftboxTxTable, ["instance_id=?"], [box.id]);
      await del(giftboxInstanceItemsTable, ["instance_id=?"], [box.id]);
      await del(giftboxInstancesTable, ["id=?"], [box.id]);
      const templateId = giftboxTemplateIds.get(box.id) ?? 0;
      if (templateId > 0 && (await countIn(giftboxInstancesTable, ["giftbox_id=?"], [templateId])) === 0) {
        await del(giftboxItemsTable, ["giftbox_id=?"], [templateId]);
        await del(giftboxesTable, ["id=?"], [templateId]);
      }
    }
    // Pacchetti: usi/transazioni/servizi/item + riga.
    for (const pkg of linkedPackages) {
      await del(cpUsagesTable, ["client_package_id=?"], [pkg.id]);
      await del(cpTxTable, ["client_package_id=?"], [pkg.id]);
      await del(cpServicesTable, ["client_package_id=?"], [pkg.id]);
      await del(cpItemsTable, ["client_package_id=?"], [pkg.id]);
      await del(clientPackagesTable, ["id=?"], [pkg.id]);
    }
    // Prepagati: usi + riga.
    for (const prep of linkedPrepaids) {
      await del(prepaidUsagesTable, ["client_prepaid_service_id=?"], [prep.id]);
      await del(prepaidsTable, ["id=?"], [prep.id]);
    }
    // Ricariche (già stornate): riga.
    for (const rech of linkedRecharges) {
      await del(rechargesTable, ["id=?"], [rech.id]);
    }

    // Movimenti commissione della vendita: eliminati SOLO con l'eliminazione
    // definitiva (Commissions::deleteSaleCommissionMovements).
    await del(commissionSnapshotsTable, ["source_group='pos'", "source_id=?"], [input.saleId]);

    // Installments first (children of the plan), then the plan, then the rest.
    await del(installmentsTable, ["sale_id=?"], [input.saleId]);
    await del(plansTable, ["sale_id=?"], [input.saleId]);
    if (eventsTable && (await columnExists(eventsTable.name, "source_type")) && (await columnExists(eventsTable.name, "source_id"))) {
      await del(eventsTable, ["source_type='sale'", "source_id=?"], [input.saleId]);
    }
    await del(stockAuditTable, ["sale_id=?"], [input.saleId]);
    await del(saleItemsTable, ["sale_id=?"], [input.saleId]);
    await del(salesTable, ["id=?"], [input.saleId]);
  });

  return getManagePosContext(slug, { locationId, includeCancelled: true });
}

// Best-effort: the appointment id a sale is tied to — the sales.appointment_id column when it
// exists, else the "Appuntamento #id" notes marker (written by saleNotes at checkout). 0 when
// the sale is not tied to any appointment. Used by deleteCancelledSale's booking blocker.
async function saleLinkedAppointmentId(slug: string, saleRow: RowDataPacket): Promise<number> {
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  if (salesTable && (await columnExists(salesTable.name, "appointment_id"))) {
    const id = Math.max(0, Number(saleRow.appointment_id ?? 0) || 0);
    if (id > 0) return id;
  }
  const m = String(saleRow.notes ?? "").match(/Appuntamento\s*#\s*(\d+)/i);
  return m ? Math.max(0, Number(m[1]) || 0) : 0;
}

// ---------------------------------------------------------------------------
// POS "Dettaglio vendita" (pos_sale_detail.php) — single sale view + actions.
// ---------------------------------------------------------------------------

// The CANCEL summary for the detail page: what the void will cancel/restore, and any
// BLOCKERS that prevent it. Faithful (best-effort) to _pos_sale_cancel_preview: each
// entry is computed from the SAME linkage cancelManageSale reverses (recharges.sale_id,
// client_packages.sale_id, client_prepaid_services.sale_id, the giftcard issue marker,
// the giftbox 'Vendita #saleId' note, sale_installment_plans.sale_id, and the residui
// columns on the sales row). `blockers` mirror the legacy rules — a fully-redeemed issued
// GiftBox and a giftcard already spent in ANOTHER (still-active) sale block the void.
export type PosCancelSummary = {
  // Product lines whose stock would be restored on a "restore" void (status != ordered).
  products: Array<{ saleItemId: number; productId: number; name: string; qty: number }>;
  // Whether the sale has product lines that force the restore/no_restore stock decision.
  requiresStockDecision: boolean;
  giftcards: Array<{ id: number; code: string; status: string; balance: number; linkedSaleIds: number[] }>;
  giftboxes: Array<{ id: number; code: string; status: string; fullyRedeemed: boolean; redeemedItems: string[]; remainingItems: string[] }>;
  packages: Array<{ id: number; name: string; sessionsTotal: number; sessionsRemaining: number }>;
  prepaidServices: Array<{ id: number; name: string; purchasedQty: number; remainingQty: number }>;
  recharges: Array<{ id: number; totalAmount: number; earnedStorno: number; isVoid: boolean }>;
  installmentPlans: Array<{ id: number; status: string }>;
  // Prenotazioni NON annullate collegate a un pacchetto/giftbox/prepagato emesso dalla
  // vendita (port di appt_lifecycle_apply_sale_cancel_reservation_policy, AppointmentLifecycle
  // .php:1931): finché sono attive/eseguite, l'annullo è BLOCCATO (blocker) — vanno prima
  // gestite manualmente (annulla la prenotazione o rimuovi il collegamento).
  linkedAppointments: Array<{ id: number; code: string; status: string; source: string; blocker: string }>;
  // Residui RESTORED on void (re-credited credit / refunded giftcard / refunded points).
  creditRestored: number;
  giftcardResidualRefunded: number;
  giftcardResidualCode: string;
  pointsRestored: number;
  // SALE-level fidelity-points STORNO decision (port of _pos_sale_cancel_preview's
  // extra['points_storno'], pos_sale_detail.php ~1930-1966). Present ONLY when reversing the
  // sale's earned points would push the client's points balance below zero — i.e. when
  // preWouldBe = current - earnedStorno < 0 (the legacy condition). null otherwise (sufficient
  // balance → no decision UI, mode stays "normal", behaviour unchanged). When present, the UI
  // offers negative (default) / skip; a "normal" mode fails safe by throwing.
  pointsStornoExtra: { current: number; usedRestore: number; earnedStorno: number; wouldBe: number } | null;
  // PER-recharge fidelity-points STORNO decisions (port of recharge_cancel_enrich_sale_cancel_preview's
  // per-recharge extra['points_storno'], CreditRechargeCancel.php ~622-668). One entry per recharge
  // ISSUED by this sale whose earned-points storno would push the projected available balance
  // below zero. `wouldBe` is PROJECTED: each recharge subtracts from a running balance seeded at
  // the client's current points, so a later recharge reflects the earlier ones (is_projected).
  rechargePointStornoItems: Array<{
    id: number;
    label: string;
    current: number;
    earnedStorno: number;
    wouldBe: number;
    isProjected: boolean;
    totalAmount: number;
  }>;
  summary: string[];
  warnings: string[];
  blockers: string[];
};

// One "riduzione" line in the totals breakdown (port of pos_sale_detail.php
// $summaryReductionLines ~5066-5110): a label ("Sconto manuale", "Coupon: ABC", "Punti
// Fidelity (12 pt)", "GiftCard utilizzata (GC-...)", "Credito utilizzato", ...) and the €
// amount subtracted from the subtotale. `amount` is null when the source is known but the
// figure isn't (e.g. a bare coupon_code with no tracked amount) — rendered as "—".
export type PosReductionLine = { label: string; amount: number | null };

// The installment plan attached to a sale (port of SaleInstallments::loadPlanBySaleId +
// hydratePlan, surfaced in the "Gestione Rate" panel). Present only when the sale has a
// sale_installment_plans row. Amounts are money-rounded; the counts + next due are derived
// from the sale_installments rows exactly like hydratePlan.
export type PosInstallmentPlanView = {
  id: number;
  paymentTypeLabel: string;
  statusKey: string;
  statusLabel: string;
  statusBadge: string;
  downPayment: number;
  financed: number;
  remaining: number;
  saleTotal: number;
  installmentsCount: number;
  frequencyLabel: string;
  paidCount: number;
  pendingCount: number;
  overdueCount: number;
  nextDueDate: string;
  notes: string;
  rows: Array<{
    installmentNo: number;
    dueDate: string;
    amount: number;
    paidAmount: number | null;
    statusKey: string;
    statusLabel: string;
    statusBadge: string;
  }>;
};

// The quote a sale originated from (port of quote_sale_load_quote_reference_for_sale): the
// quote id (sales.source_quote_id, else the notes marker), plus its number/status/effective
// status when the quotes row resolves. Rendered as the "Preventivo #id" badge/reference.
export type PosQuoteRef = {
  id: number;
  number: string;
  status: string;
  effectiveStatus: string;
  exists: boolean;
};

export type PosSaleDetail = {
  ok: true;
  source?: string;
  sale: PosSale;
  operatorName: string;
  locationName: string;
  // Quick-link header legacy "Apri GiftBox/GiftCard/Pacchetto" (+ conteggio se >1):
  // id degli artefatti emessi dalla vendita. Meta "Pagamento: <label>" e operatore
  // dell'annullo per il box "Stato annullamento".
  quickGiftcardIds: number[];
  quickGiftboxIds: number[];
  quickPackageIds: number[];
  paymentLabel: string;
  cancelledByName: string;
  cancelSummary: PosCancelSummary;
  canCancel: boolean;
  canMarkCollected: boolean;
  // Itemized "riduzioni" lines for the totals panel (promo/coupon/manual/fidelity/giftcard/
  // credit/…), and the cleaned notes (technical discount lines stripped). Faithful to
  // pos_sale_detail.php's totals breakdown (~4964-5110) + $displayNotes.
  reductions: PosReductionLine[];
  notesClean: string;
  // The installment plan ("Gestione Rate" panel) — null when the sale has no plan.
  installmentPlan: PosInstallmentPlanView | null;
  // The quote reference ("Preventivo #id" badge) — null when the sale has no source quote.
  quoteRef: PosQuoteRef | null;
  // Whether the sale is already cancelled (drives the "Elimina vendita" hard-delete button).
  canDelete: boolean;
  // "Cronologia utilizzo": one entry per prepaid-service line linked to this sale, with the
  // residual/free qty, the manual-execution controls (Segna eseguito / Annulla esecuzione),
  // and the newest-first usage timeline (appointment redemptions + manual executions).
  // Faithful (best-effort) to pos_sale_detail.php's $trackingCards for prepaid lines.
  prepaidTracking: PosPrepaidTracking[];
  // Per ordered/collected product line: the collected qty (partial-pickup state) driving the
  // "Segna ritirato" qty selector + the "Rimuovi ritiro" undo on collected lines.
  preorderTracking: PosPreorderTracking[];
};

// One event in a prepaid-service usage timeline: either an appointment REDEMPTION
// (appointmentId>0, with the appointment link/status) or a MANUAL execution
// (appointmentId=0, isManual=true), newest-first. Faithful to the legacy per-prepaid
// timeline (appointment_prepaid_service_items + client_prepaid_service_usages).
export type PosPrepaidUsageEvent = {
  usageId: number;
  appointmentId: number;
  appointmentCode: string;
  appointmentStatus: string;
  qty: number;
  when: string;
  operator: string;
  isManual: boolean;
  // Present only for a manual usage that can be undone from this page (appointmentId=0 and a
  // 'esecuzione manuale' note). Drives the "Annulla esecuzione" button.
  canUndo: boolean;
  // The clean /appointments route the timeline links to (appointmentId>0), else "".
  appointmentLink: string;
};

// A prepaid-service line on the sale, with the residual/free qty + the manual-execution
// controls + the usage timeline. Port of one prepaid $trackingCards entry.
export type PosPrepaidTracking = {
  saleItemId: number;
  prepaidId: number;
  title: string;
  serviceName: string;
  purchasedQty: number;
  remainingQty: number;
  // Residual NOT already committed to open appointments (the "residuo libero"): the ceiling on
  // a manual execution. execute at most this many.
  freeQty: number;
  canExecute: boolean;
  note: string;
  usageHistory: PosPrepaidUsageEvent[];
};

// A product line's pickup state: the ordered qty still awaiting pickup and, when a partial
// pickup has been recorded, the sibling collected line(s) that can be undone.
export type PosPreorderTracking = {
  saleItemId: number;
  productId: number;
  name: string;
  status: "ordered" | "collected";
  qty: number;
  // For an 'ordered' line: the max qty pickable now (min of line qty and available stock).
  collectMax: number;
  canCollect: boolean;
  stockNow: number;
  note: string;
};

// Build the full POS "Dettaglio vendita" payload for one sale: the mapped PosSale (header,
// grouped-ready items, payments, totals) PLUS the operator/location labels and the cancel
// summary + blockers. Faithful (best-effort) to pos_sale_detail.php's header + cancel
// preview. Tenant-scoped via getSaleRow/mapSale; throws "Vendita non trovata." for a
// missing/foreign id.
export async function getManageSaleDetail(slug: string, id: number): Promise<PosSaleDetail> {
  if (id <= 0) throw new Error("Vendita non valida.");
  const row = await getSaleRow(slug, id);
  // Per-sale location access guard (port of _pos_hist_assert_sale_location_access ~51-77):
  // every sale-detail view + action re-checks the user can access the sale's location.
  await assertSaleLocationAccess(slug, Number(row.location_id ?? 0) || 0);
  const sale = await mapSale(slug, row);
  const operatorName = clean(row.operator_name, 120) || (await operatorNameFromUserId(slug, Number(row.created_by ?? 0))) || "—";
  const locationName = sale.locationId > 0 ? await saleLocationName(slug, sale.locationId) : "";
  const cancelSummary = await buildCancelSummary(slug, id, row, sale);
  // Itemized reductions + cleaned notes (totals breakdown), the installment plan, and the
  // quote reference — the three read-only panels ported here.
  const { reductions, notesClean } = await buildSaleReductions(slug, row, sale);
  const installmentPlan = await loadSaleInstallmentPlan(slug, id).catch(() => null);
  const quoteRef = await loadSaleQuoteRef(slug, row).catch(() => null);
  const notCancelled = sale.status !== "cancelled";
  // "Cronologia utilizzo / ritiro" data: prepaid usage timelines + per-product pickup state.
  const prepaidTracking = notCancelled ? await buildPrepaidTracking(slug, id, sale).catch(() => []) : [];
  const preorderTracking = notCancelled ? await buildPreorderTracking(slug, sale).catch(() => []) : [];
  // Quick-link header legacy (pos_sale_detail.php 4806-4835): "Apri GiftBox/GiftCard/
  // Pacchetto" con conteggio quando >1 — gli artefatti EMESSI dalla vendita.
  // GiftCard/GiftBox si risalgono dalle RIGHE vendita (refId della riga emessa:
  // giftcards non ha una colonna sale_id); i pacchetti da client_packages.sale_id.
  const quickGiftcardIds = [...new Set(sale.items.filter((it) => it.type === "giftcard" && Number(it.refId ?? 0) > 0).map((it) => Number(it.refId)))];
  const quickGiftboxIds = [...new Set(sale.items.filter((it) => it.type === "giftbox" && Number(it.refId ?? 0) > 0).map((it) => Number(it.refId)))];
  const quickPackageIds = (await tenantSelect<RowDataPacket>({ slug, table: "client_packages", columns: "id", where: "sale_id = ?", params: [id], orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]))
    .map((r) => Number(r.id ?? 0)).filter((v) => v > 0);
  // Meta header "Pagamento: <label>" (display del payment_type legacy). Lo schema
  // Next non ha sales.payment_type: il metodo BASE si deriva dai pagamenti
  // registrati (primo tra contanti/carta/assegno/bonifico, come il Tipo pagamento
  // scelto in cassa e riportato nelle note "Tipo pagamento: X").
  const baseMethod = sale.payments.map((p) => String(p.method ?? "").toLowerCase()).find((m) => m === "cash" || m === "card" || m === "check" || m === "transfer") ?? "";
  const paymentLabel = (LEGACY_PAYMENT_TYPE_LABELS as Record<string, string | undefined>)[baseMethod] ?? "";
  // "Stato annullamento" legacy mostra anche l'OPERATORE dell'annullo.
  let cancelledByName = "";
  const cancelledBy = Number(row.cancelled_by ?? 0) || 0;
  if (cancelledBy > 0) {
    const userRows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "name, email", where: "id = ?", params: [cancelledBy], limit: 1 }).catch(() => [] as RowDataPacket[]);
    cancelledByName = String(userRows[0]?.name ?? userRows[0]?.email ?? "").trim();
  }
  return {
    ok: true,
    sale,
    operatorName,
    locationName,
    quickGiftcardIds,
    quickGiftboxIds,
    quickPackageIds,
    paymentLabel,
    cancelledByName,
    cancelSummary,
    canCancel: sale.status !== "cancelled" && cancelSummary.blockers.length === 0,
    canMarkCollected: sale.status !== "cancelled",
    reductions,
    notesClean,
    installmentPlan,
    quoteRef,
    canDelete: sale.status === "cancelled",
    prepaidTracking,
    preorderTracking,
  };
}

// ---------------------------------------------------------------------------
// POS SUCCESS — port di pos_success.php: la pagina dedicata "Vendita completata"
// raggiunta dal redirect post-Concludi (legacy: redirect('index.php?page=pos_success&id=N')).
// Tutti i dati sono ricostruiti dal DB per sale_id (il legacy usa anche il flash di
// sessione, ma con fallback DB completi: codici GiftCard/GiftBox dai nomi riga,
// pacchetti da "CP#n" e ricariche da "R#n" nelle note).
export type PosSuccessData = {
  ok: true;
  saleId: number;
  saleDate: string; // ISO — formattata dd/mm/yyyy HH:mm lato client
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  items: PosSale["items"];
  notesClean: string;
  subtotal: number;
  total: number;
  totals: {
    hasDiscountRow: boolean;
    discountTotal: number;
    showBaseDiscountLine: boolean;
    baseDiscountLabel: string;
    baseDiscountResidual: number;
    discountDetails: Array<{ label: string; amount: number | null }>;
    fidUsed: number;
    fidEarn: number;
    fidDisc: number;
    giftcardUsed: number | null;
    giftcardCode: string;
    creditUsed: number | null;
  };
  giftcards: Array<{ id: number; code: string; recipientEmail: string; scheduledSendOn: string }>;
  giftbox: { id: number; code: string; recipientEmail: string; scheduledSendOn: string } | null;
  clientPackages: Array<{ id: number; name: string; status: string; sessionsTotal: number; sessionsRemaining: number }>;
  hasRecharge: boolean;
};

export async function getManagePosSuccess(slug: string, saleId: number): Promise<PosSuccessData> {
  const id = Math.max(0, Number(saleId) || 0);
  if (id <= 0) throw new Error("Vendita non valida.");
  const row = await getSaleRow(slug, id);
  // Guardia sede per-vendita (pos_success.php _pos_succ_sale_location_access_error).
  await assertSaleLocationAccess(slug, Number(row.location_id ?? 0) || 0);
  const sale = await mapSale(slug, row);

  // Cliente: nome + email/telefono (LEFT JOIN clients del legacy).
  const clientId = Math.max(0, Number(row.client_id ?? 0) || 0);
  let clientName = sale.clientName || "—";
  let clientEmail = "";
  let clientPhone = "";
  if (clientId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name, email, phone", where: "id=?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (rows[0]) {
      clientName = clean(rows[0].full_name, 190) || clientName;
      clientEmail = clean(rows[0].email, 190);
      clientPhone = clean(rows[0].phone, 60);
    }
  }

  const notesRaw = String(row.notes ?? "");
  const parsed = extractDiscountsFromNotes(notesRaw);

  // ---- decomposizione Totali (pos_success.php 557-663) ----
  const subtotal = roundMoney(Number(row.subtotal ?? 0) || 0);
  const total = roundMoney(Number(row.total ?? 0) || 0);
  const discountRaw = roundMoney(Number(row.discount ?? 0) || 0);
  const fidUsed = normalizePoints(Number(row.fidelity_points_used ?? 0) || 0);
  let fidEarn = normalizePoints(Number(row.fidelity_points_earned ?? 0) || 0);
  const fidDisc = roundMoney(Number(row.fidelity_discount ?? 0) || 0);

  let discountTotal = discountRaw;
  let baseDiscount: number;
  if (discountRaw + 0.00001 >= fidDisc) {
    baseDiscount = roundMoney(Math.max(0, discountRaw - fidDisc));
  } else {
    baseDiscount = roundMoney(Math.max(0, discountRaw));
    discountTotal = roundMoney(discountRaw + fidDisc);
  }
  if (discountTotal < 0) discountTotal = 0;

  // Dettagli sconto (note) + promo/coupon dalle colonne strutturate quando le note non li hanno.
  const discountDetails = [...parsed.discounts];
  const couponCode = clean(row.coupon_code, 40).toUpperCase();
  const promoName = clean(row.promotion_applied_name, 190);
  const promoAmount = roundMoney(Number(row.promotion_applied_discount ?? 0) || 0);
  if (promoName && !discountDetails.some((dd) => dd.kind === "promotion")) {
    discountDetails.push({ kind: "promotion", label: `Promozione: ${promoName}`, amount: promoAmount > 0.00001 ? promoAmount : null });
  }
  if (couponCode && !discountDetails.some((dd) => dd.kind === "coupon")) {
    discountDetails.push({ kind: "coupon", label: `Coupon: ${couponCode}`, amount: null });
  }
  const discountDetailsKnownTotal = roundMoney(
    discountDetails.reduce((sum, dd) => sum + (dd.amount === null ? 0 : Math.max(0, roundMoney(dd.amount))), 0),
  );
  let baseDiscountResidual = baseDiscount;
  if (baseDiscountResidual > 0.00001 && discountDetailsKnownTotal > 0.00001) {
    baseDiscountResidual = roundMoney(Math.max(0, baseDiscountResidual - Math.min(baseDiscountResidual, discountDetailsKnownTotal)));
  }
  let showBaseDiscountLine = false;
  let baseDiscountLabel = "Buoni / promozioni / sconti";
  if (baseDiscount > 0.00001) {
    if (discountDetails.length) {
      if (baseDiscountResidual > 0.00001) {
        showBaseDiscountLine = true;
        baseDiscountLabel = "Altri sconti / promozioni";
      }
    } else {
      showBaseDiscountLine = true;
    }
  }
  const hasDiscountRow = discountTotal > 0.00001 || fidDisc > 0.00001 || discountDetails.length > 0 || showBaseDiscountLine;

  // GiftCard/credito usati (colonne strutturate, fallback note).
  let giftcardUsed: number | null = null;
  const giftcardUsedCol = roundMoney(Number(row.giftcard_used ?? 0) || 0);
  if (giftcardUsedCol > 0.00001) giftcardUsed = giftcardUsedCol;
  else if (parsed.giftcardUsed !== null && parsed.giftcardUsed > 0.00001) giftcardUsed = roundMoney(parsed.giftcardUsed);
  let giftcardCode = parsed.giftcardCode;
  const giftcardPayId = Math.max(0, Number(row.giftcard_id ?? 0) || 0);
  if (giftcardPayId > 0) {
    const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "code", where: "id=?", params: [giftcardPayId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const codeDb = clean(cardRows[0]?.code, 40);
    if (codeDb) giftcardCode = codeDb;
  }
  let creditUsed: number | null = null;
  const creditUsedCol = roundMoney(Number(row.credit_used ?? 0) || 0);
  if (creditUsedCol > 0.00001) creditUsed = creditUsedCol;
  else if (parsed.creditUsed !== null && parsed.creditUsed > 0.00001) creditUsed = roundMoney(parsed.creditUsed);

  // ---- GiftCard EMESSE dai nomi riga ("GiftCard • GC-XXXX-XXXX-XXXX") ----
  const giftcards: PosSuccessData["giftcards"] = [];
  {
    const codes = new Set<string>();
    for (const it of sale.items) {
      const nm = String(it.name ?? "");
      if (!/giftcard/i.test(nm)) continue;
      for (const m of nm.matchAll(/\b(GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/g)) codes.add(m[1].toUpperCase());
    }
    for (const code of codes) {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "id, code, recipient_email, scheduled_send_on", where: "code=?", params: [code], limit: 1 }).catch(() => [] as RowDataPacket[]);
      const r = rows[0];
      if (r && Number(r.id ?? 0) > 0) {
        giftcards.push({ id: Number(r.id), code: clean(r.code, 40) || code, recipientEmail: clean(r.recipient_email, 190), scheduledSendOn: r.scheduled_send_on ? String(r.scheduled_send_on).slice(0, 10) : "" });
      }
    }
  }

  // ---- GiftBox EMESSA dal nome riga ("GiftBox • GBX-XXXXXX") ----
  let giftbox: PosSuccessData["giftbox"] = null;
  {
    let code = "";
    for (const it of sale.items) {
      const nm = String(it.name ?? "");
      if (!/giftbox/i.test(nm)) continue;
      const m = nm.match(/\b(GBX-[A-Z0-9]{4,16})\b/i) ?? nm.match(/\b([A-Z]{3}-[A-Z0-9]{4,})\b/);
      if (m) { code = m[1].toUpperCase(); break; }
    }
    if (code) {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", columns: "id, code, recipient_email, scheduled_send_on", where: "code=?", params: [code], limit: 1 }).catch(() => [] as RowDataPacket[]);
      const r = rows[0];
      if (r && Number(r.id ?? 0) > 0) {
        giftbox = { id: Number(r.id), code: clean(r.code, 40) || code, recipientEmail: clean(r.recipient_email, 190), scheduledSendOn: r.scheduled_send_on ? String(r.scheduled_send_on).slice(0, 10) : "" };
      }
    }
  }

  // ---- Pacchetti cliente dalle note ("Pacchetti: CP#12, CP#13") ----
  const clientPackages: PosSuccessData["clientPackages"] = [];
  {
    const ids = new Set<number>();
    for (const m of notesRaw.matchAll(/\bCP#(\d+)\b/g)) {
      const cpId = Number(m[1]);
      if (cpId > 0) ids.add(cpId);
    }
    const sorted = [...ids].sort((a, b) => a - b);
    if (sorted.length) {
      const inList = sorted.map(() => "?").join(",");
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", columns: "id, package_name, status, sessions_total, sessions_remaining", where: `id IN (${inList})`, params: sorted }).catch(() => [] as RowDataPacket[]);
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      for (const cpId of sorted) {
        const r = byId.get(cpId);
        if (!r) continue;
        clientPackages.push({ id: cpId, name: clean(r.package_name, 190), status: clean(r.status, 40), sessionsTotal: Math.max(0, Number(r.sessions_total ?? 0) || 0), sessionsRemaining: Math.max(0, Number(r.sessions_remaining ?? 0) || 0) });
      }
    }
  }

  // ---- Ricariche dalle note ("Ricariche: R#5") + punti ricarica in Fidelity ----
  const rechargeIds: number[] = [];
  for (const m of notesRaw.matchAll(/\bR#(\d+)\b/g)) {
    const rid = Number(m[1]);
    if (rid > 0 && !rechargeIds.includes(rid)) rechargeIds.push(rid);
  }
  let hasRecharge = rechargeIds.length > 0;
  if (!hasRecharge) hasRecharge = sale.items.some((it) => /ricarica/i.test(String(it.name ?? "")));
  if (rechargeIds.length) {
    // Le ricariche registrano i punti su transactions (source_type credit_recharge),
    // non su sales.fidelity_points_earned: sommiamo il contributo (pos_success.php 577-584).
    const inList = rechargeIds.map(() => "?").join(",");
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "transactions",
      columns: "ROUND(COALESCE(SUM(delta_points), 0), 2) AS s",
      where: `source_id IN (${inList}) AND source_type IN ('credit_recharge', 'credit_recharge_void')`,
      params: rechargeIds,
    }).catch(() => [] as RowDataPacket[]);
    const extra = Math.max(0, roundMoney(Number(rows[0]?.s ?? 0) || 0));
    if (extra > 0.00001) fidEarn = roundMoney(fidEarn + extra);
  }

  const saleDateRaw = row.sale_date ?? row.created_at ?? null;
  const saleDate = saleDateRaw ? new Date(saleDateRaw as string | Date).toISOString() : "";

  return {
    ok: true,
    saleId: id,
    saleDate,
    clientId,
    clientName,
    clientEmail,
    clientPhone,
    items: sale.items,
    notesClean: parsed.notesClean,
    subtotal,
    total,
    totals: {
      hasDiscountRow,
      discountTotal,
      showBaseDiscountLine,
      baseDiscountLabel,
      baseDiscountResidual,
      discountDetails: discountDetails.map((dd) => ({ label: dd.label, amount: dd.amount })),
      fidUsed,
      fidEarn,
      fidDisc,
      giftcardUsed,
      giftcardCode,
      creditUsed,
    },
    giftcards,
    giftbox,
    clientPackages,
    hasRecharge,
  };
}

// Per-sale location access guard — faithful to _pos_hist_sale_location_access_error /
// _pos_hist_assert_sale_location_access (pos_sale_detail.php ~51-77). A sale with no
// location (locationId <= 0) is always allowed (the legacy returns "" when location_id<=0);
// otherwise the sale's location must be in the user's allowed locations (the session-filtered
// tenant locations — the same source app_location_allowed_for_user consults). Throws the
// legacy Italian message when the sale belongs to a location the user cannot access.
async function assertSaleLocationAccess(slug: string, locationId: number): Promise<void> {
  if (locationId <= 0) return;
  const context = await getManageLocationContext(slug);
  if (!context.locations.some((location) => location.id === locationId)) {
    throw new Error("Non hai accesso alla sede di questa vendita.");
  }
}

async function operatorNameFromUserId(slug: string, userId: number): Promise<string> {
  if (userId <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "name,email", where: "id=?", params: [userId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const row = rows[0];
  if (!row) return "";
  return clean(row.name, 120) || clean(row.email, 120) || `#${userId}`;
}

async function saleLocationName(slug: string, locationId: number): Promise<string> {
  if (locationId <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "name", where: "id=?", params: [locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return clean(rows[0]?.name, 190) || `Sede #${locationId}`;
}

// Compute the cancel summary + blockers from the sale's persisted linkage. Mirrors the
// legacy _pos_sale_cancel_preview but keyed off the columns/markers cancelManageSale
// actually reverses (so the preview and the void agree). Every read is best-effort — a
// missing optional table/column simply omits that section.
async function buildCancelSummary(slug: string, saleId: number, row: RowDataPacket, sale: PosSale): Promise<PosCancelSummary> {
  const summary: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // Products to restock on a "restore" void (status != ordered), faithful to cancelManageSale.
  const products = sale.items
    .filter((item) => item.type === "product" && item.refId > 0 && item.status !== "ordered")
    .map((item) => ({ saleItemId: item.id, productId: item.refId, name: item.name, qty: Math.max(1, Math.round(item.quantity)) }));
  const requiresStockDecision = products.length > 0;
  if (products.length) {
    summary.push(`Prodotti gia scaricati: ${products.map((p) => `${p.name} x${p.qty}`).join(", ")}. Scelta magazzino richiesta.`);
  }

  // GiftCard ISSUED by this sale (via the issue ledger marker). A still-active card spent in
  // ANOTHER active sale blocks the void (the spend would be orphaned); a positive residual
  // is a warning.
  const giftcards = await summarizeIssuedGiftcards(slug, saleId, warnings, blockers);
  if (giftcards.length) summary.push(`GiftCard emesse: ${giftcards.map((g) => g.code).filter(Boolean).join(", ")}`);

  // GiftBox ISSUED by this sale (via the 'Vendita #saleId' note). A FULLY-redeemed box blocks.
  const giftboxes = await summarizeIssuedGiftboxes(slug, saleId, blockers);
  if (giftboxes.length) summary.push(`GiftBox emesse: ${giftboxes.map((g) => g.code).filter(Boolean).join(", ")}`);

  // Package issued (client_packages.sale_id).
  const packages = await summarizeLinkedRows(slug, "client_packages", saleId, (r) => ({
    id: Number(r.id ?? 0),
    name: clean(r.name ?? r.package_name, 190) || `Pacchetto #${Number(r.id ?? 0)}`,
    sessionsTotal: Math.max(0, Number(r.sessions_total ?? 0) || 0),
    sessionsRemaining: Math.max(0, Number(r.sessions_remaining ?? r.sessions_total ?? 0) || 0),
  }));
  if (packages.length) summary.push(`Pacchetti: ${packages.map((p) => `${p.name} (${p.sessionsRemaining}/${p.sessionsTotal})`).join(", ")}`);

  // Prepaid services issued (client_prepaid_services.sale_id).
  const prepaidServices = await summarizeLinkedRows(slug, "client_prepaid_services", saleId, (r) => ({
    id: Number(r.id ?? 0),
    name: clean(r.service_name ?? r.name, 190) || "Servizio prepagato",
    purchasedQty: Math.max(0, Number(r.purchased_qty ?? r.qty ?? 0) || 0),
    remainingQty: Math.max(0, Number(r.remaining_qty ?? r.purchased_qty ?? 0) || 0),
  }));
  if (prepaidServices.length) summary.push(`Servizi prepagati: ${prepaidServices.map((s) => `${s.name} (${s.remainingQty}/${s.purchasedQty})`).join(", ")}`);

  // Recharge issued (recharges.sale_id). Wallet credit + earned points are reversed on void.
  const recharges = await summarizeLinkedRows(slug, "recharges", saleId, (r) => ({
    id: Number(r.id ?? 0),
    totalAmount: roundMoney(Number(r.total_amount ?? 0) || 0),
    // Earned points issued by this recharge — reversed (storno) on void; drives the per-recharge
    // negative-balance decision below.
    earnedStorno: normalizePoints(Number(r.points_earned ?? 0) || 0),
    isVoid: Number(r.is_void ?? 0) === 1,
  }));
  if (recharges.some((r) => !r.isVoid)) {
    summary.push(`Ricariche da stornare: ${recharges.filter((r) => !r.isVoid).map((r) => `€ ${formatMoney(r.totalAmount)}`).join(", ")}`);
  }

  // Installment plan (sale_installment_plans.sale_id).
  const installmentPlans = await summarizeLinkedRows(slug, "sale_installment_plans", saleId, (r) => ({
    id: Number(r.id ?? 0),
    status: String(r.status ?? "").toLowerCase(),
  }));
  if (installmentPlans.length) summary.push("Piano rate collegato: verra annullato.");

  // Residui consumed at checkout → RESTORED on void (faithful to cancelManageSale's restore).
  const creditRestored = roundMoney(Number(row.credit_used ?? 0) || 0);
  const giftcardResidualRefunded = roundMoney(Number(row.giftcard_used ?? 0) || 0);
  const giftcardResidualId = Math.max(0, Number(row.giftcard_id ?? 0) || 0);
  const pointsRestored = normalizePoints(Number(row.fidelity_points_used ?? 0) || 0);
  let giftcardResidualCode = "";
  if (giftcardResidualId > 0 && giftcardResidualRefunded > 0.00001) {
    const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "code", where: "id=?", params: [giftcardResidualId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    giftcardResidualCode = clean(cardRows[0]?.code, 40);
  }
  if (creditRestored > 0.00001) summary.push(`Credito da ri-accreditare: € ${formatMoney(creditRestored)}`);
  if (giftcardResidualRefunded > 0.00001) summary.push(`GiftCard da rimborsare${giftcardResidualCode ? ` (${giftcardResidualCode})` : ""}: € ${formatMoney(giftcardResidualRefunded)}`);
  if (pointsRestored > 0) summary.push(`Punti Fidelity da ripristinare: ${pointsRestored} pt`);

  // --- SALE-level fidelity-points STORNO decision (port of _pos_sale_cancel_preview
  // ~1930-1966). If the client already spent (even partially) the points earned with this
  // sale, reversing them could drive the balance negative. Rather than blocking, surface a
  // decision. The legacy condition is preWouldBe = curPts - ptsEarn < -epsilon (RAW clients.points,
  // no lock concept) — computed BEFORE the +usedRestore compensation, exactly like the PHP.
  const clientId = Math.max(0, Number(row.client_id ?? 0) || 0);
  const ptsUsed = normalizePoints(Number(row.fidelity_points_used ?? 0) || 0);
  const ptsEarn = normalizePoints(Number(row.fidelity_points_earned ?? 0) || 0);
  let pointsStornoExtra: PosCancelSummary["pointsStornoExtra"] = null;
  // Running projection of clients.points across the movements this cancel applies IN ORDER
  // (sale-level restore(+used)/storno(-earned) → per-recharge storno), so each would_be
  // reflects the prior movements — faithful to the apply order in cancelLinkedSaleResidues.
  let projectedPoints = 0;
  if (clientId > 0) {
    const bal = await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }));
    const curPts = normalizePoints(Number(bal.points ?? 0) || 0);
    projectedPoints = curPts;
    if (ptsEarn > 0.00001) {
      const preWouldBe = curPts - ptsEarn;
      const wouldBe = curPts + ptsUsed - ptsEarn;
      if (preWouldBe < -0.00001) {
        pointsStornoExtra = { current: curPts, usedRestore: ptsUsed, earnedStorno: ptsEarn, wouldBe };
      }
      // Whatever the operator chooses, the running projection advances by the net sale-level
      // effect (+used restore then -earned storno), so the recharge projection below chains
      // from the post-sale-level balance.
      projectedPoints = curPts + ptsUsed - ptsEarn;
    }
  }

  // --- PER-recharge fidelity-points STORNO decisions (port of
  // recharge_cancel_enrich_sale_cancel_preview ~622-668). For each recharge ISSUED by this
  // sale (not yet void) with earned points, project the running points balance forward: if
  // subtracting its earned points would go below zero, surface a per-recharge decision. Each
  // recharge chains from the prior projection (is_projected when the start differs from the
  // client's real balance because a prior movement in this same cancel already reduced it).
  const rechargePointStornoItems: PosCancelSummary["rechargePointStornoItems"] = [];
  if (clientId > 0) {
    const realPoints = normalizePoints((await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }))).points || 0);
    for (const r of recharges) {
      if (r.isVoid) continue;
      const needPts = normalizePoints(r.earnedStorno);
      if (needPts <= 0.00001) continue;
      const startBal = projectedPoints;
      const wouldBe = normalizePoints(startBal - needPts);
      if (wouldBe < -0.00001) {
        rechargePointStornoItems.push({
          id: r.id,
          label: `R#${r.id}`,
          current: startBal,
          earnedStorno: needPts,
          wouldBe,
          isProjected: Math.abs(startBal - realPoints) > 0.00001,
          totalAmount: r.totalAmount,
        });
      }
      projectedPoints = wouldBe;
    }
  }

  // Prenotazioni collegate ancora attive/eseguite: BLOCCANO l'annullo finché non
  // vengono gestite manualmente (port di appt_lifecycle_apply_sale_cancel_reservation_policy).
  const linkedAppointments = await saleCancelLinkedAppointments(slug, saleId);
  for (const la of linkedAppointments) blockers.push(la.blocker);
  if (linkedAppointments.length) {
    summary.push(`Prenotazioni collegate: ${linkedAppointments.map((la) => la.code).join(", ")} — gestione manuale richiesta prima dell'annullo.`);
  }

  return {
    products,
    requiresStockDecision,
    giftcards,
    giftboxes,
    packages,
    prepaidServices,
    recharges,
    installmentPlans,
    linkedAppointments,
    creditRestored,
    giftcardResidualRefunded,
    giftcardResidualCode,
    pointsRestored,
    pointsStornoExtra,
    rechargePointStornoItems,
    summary,
    warnings,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Read-only detail PANELS: itemized reductions, installment plan, quote ref.
// ---------------------------------------------------------------------------

// Build the itemized "riduzioni" lines for the totals panel + the cleaned notes. Faithful
// (best-effort) to pos_sale_detail.php's totals breakdown (~4964-5110): the total reduction
// is subtotal - total, decomposed into the per-source lines that apply — the base
// promo/coupon/manual discount (sales.discount, less the fidelity part if bundled in), a
// per-source coupon/promo/manual line parsed from the notes, the Punti Fidelity discount
// (sales.fidelity_discount + fidelity_points_used), the GiftCard residui used
// (sales.giftcard_used + code), the wallet Credito used (sales.credit_used), and any
// leftover "Altre riduzioni" difference. `notesClean` is the notes with the technical
// discount/credit/system lines stripped (the legacy $displayNotes).
async function buildSaleReductions(
  slug: string,
  row: RowDataPacket,
  sale: PosSale,
): Promise<{ reductions: PosReductionLine[]; notesClean: string }> {
  const subtotal = roundMoney(Number(row.subtotal ?? sale.subtotal ?? 0) || 0);
  const total = roundMoney(Number(row.total ?? sale.total ?? 0) || 0);
  const discount = roundMoney(Number(row.discount ?? 0) || 0);

  // Parse the technical discount/credit lines out of the notes (best-effort — the Next POS
  // records structured columns, but migrated/legacy rows may carry the note markers).
  const parsed = extractDiscountsFromNotes(String(row.notes ?? ""));
  const notesClean = parsed.notesClean;

  // Riduzioni complessive = quanto è stato "scalato" dal subtotale per arrivare al totale.
  const reductionsTotal = roundMoney(Math.max(0, subtotal - total));

  // Punti Fidelity (structured columns).
  let fidDisc = 0;
  const fidRaw = roundMoney(Number(row.fidelity_discount ?? 0) || 0);
  if (fidRaw > 0.00001) fidDisc = fidRaw;
  const fidPtsRaw = normalizePoints(Number(row.fidelity_points_used ?? 0) || 0);
  const fidPts = fidPtsRaw > 0 ? fidPtsRaw : null;

  // GiftCard residui used (prefer the structured column, fall back to the note figure) + code.
  let giftcardUsedEff: number | null = null;
  const giftcardUsedCol = roundMoney(Number(row.giftcard_used ?? 0) || 0);
  if (giftcardUsedCol > 0.00001) giftcardUsedEff = giftcardUsedCol;
  let giftcardCodeEff = parsed.giftcardCode;
  const giftcardId = Math.max(0, Number(row.giftcard_id ?? 0) || 0);
  if (giftcardId > 0) {
    const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "code", where: "id=?", params: [giftcardId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const codeDb = clean(cardRows[0]?.code, 40);
    if (codeDb) giftcardCodeEff = codeDb;
  }
  if (giftcardUsedEff === null && parsed.giftcardUsed !== null && parsed.giftcardUsed > 0.00001) {
    giftcardUsedEff = roundMoney(parsed.giftcardUsed);
  }

  // Credito wallet used (structured column, fallback to the note figure).
  let creditUsedEff: number | null = null;
  const creditUsedCol = roundMoney(Number(row.credit_used ?? 0) || 0);
  if (creditUsedCol > 0.00001) creditUsedEff = creditUsedCol;
  if (creditUsedEff === null && parsed.creditUsed !== null && parsed.creditUsed > 0.00001) {
    creditUsedEff = roundMoney(parsed.creditUsed);
  }

  // "Sconti classici" = promo/coupon/manuali. In some installs sales.discount also bundles
  // the fidelity part: subtract it so it isn't double-counted in the UI.
  let baseDiscount = discount;
  if (fidDisc > 0.00001 && baseDiscount + 0.00001 >= fidDisc) {
    baseDiscount = roundMoney(Math.max(0, baseDiscount - fidDisc));
  }
  const knownReductions = roundMoney(baseDiscount + fidDisc + (giftcardUsedEff ?? 0) + (creditUsedEff ?? 0));
  const diffRed = roundMoney(Math.max(0, reductionsTotal - knownReductions));

  // Structured detail lines from the parsed notes (promo/coupon/manual).
  const discountDetails = [...parsed.discounts];
  const couponCode = clean(row.coupon_code, 40).toUpperCase();
  const hasCouponInDetails = discountDetails.some((dd) => dd.kind === "coupon");
  // A promotion_applied_name (structured column) surfaces the promo even without a note line.
  const promoName = clean(row.promotion_applied_name, 190);
  const promoAmount = roundMoney(Number(row.promotion_applied_discount ?? 0) || 0);
  const hasPromoInDetails = discountDetails.some((dd) => dd.kind === "promotion");
  if (promoName && !hasPromoInDetails) {
    discountDetails.push({ kind: "promotion", label: `Promozione: ${promoName}`, amount: promoAmount > 0.00001 ? promoAmount : null });
  }
  if (couponCode && !hasCouponInDetails) {
    discountDetails.push({ kind: "coupon", label: `Coupon: ${couponCode}`, amount: null });
  }

  const discountDetailsKnownTotal = roundMoney(
    discountDetails.reduce((sum, dd) => sum + (dd.amount === null ? 0 : Math.max(0, roundMoney(dd.amount))), 0),
  );

  // Residual base discount not attributed to a detail line.
  let baseDiscountResidual = baseDiscount;
  if (baseDiscountResidual > 0.00001 && discountDetailsKnownTotal > 0.00001) {
    baseDiscountResidual = roundMoney(Math.max(0, baseDiscountResidual - Math.min(baseDiscountResidual, discountDetailsKnownTotal)));
  }

  let showBaseDiscountLine = false;
  let baseDiscountLabel = "Buoni / promozioni / sconti";
  if (baseDiscount > 0.00001) {
    if (discountDetails.length) {
      if (baseDiscountResidual > 0.00001) {
        showBaseDiscountLine = true;
        baseDiscountLabel = "Altri sconti / promozioni";
      }
    } else {
      showBaseDiscountLine = true;
    }
  }

  const reductions: PosReductionLine[] = [];
  if (showBaseDiscountLine) reductions.push({ label: baseDiscountLabel, amount: baseDiscountResidual });
  for (const dd of discountDetails) {
    const label = dd.label.trim();
    if (!label) continue;
    reductions.push({ label, amount: dd.amount });
  }
  if (fidDisc > 0.00001) {
    let fidLabel = "Punti Fidelity";
    if (fidPts !== null && fidPts > 0.00001) fidLabel += ` (${fidPts} pt)`;
    reductions.push({ label: fidLabel, amount: fidDisc });
  }
  if (giftcardUsedEff !== null && giftcardUsedEff > 0.00001) {
    reductions.push({ label: `GiftCard utilizzata${giftcardCodeEff ? ` (${giftcardCodeEff})` : ""}`, amount: giftcardUsedEff });
  }
  if (creditUsedEff !== null && creditUsedEff > 0.00001) {
    reductions.push({ label: "Credito utilizzato", amount: creditUsedEff });
  }
  if (diffRed > 0.00001) reductions.push({ label: "Altre riduzioni", amount: diffRed });

  return { reductions, notesClean };
}

type ParsedDiscount = { kind: string; label: string; amount: number | null };
type ParsedNotes = {
  discounts: ParsedDiscount[];
  giftcardUsed: number | null;
  giftcardCode: string;
  creditUsed: number | null;
  paymentTypeLabel: string;
  notesClean: string;
};

// Port of _pos_sale_extract_discounts_from_notes (pos_sale_detail.php ~1386-1503): pull the
// technical discount/credit lines out of the sale notes (Promozione / Coupon / Sconto
// manuale / Sconto / GiftCard utilizzata / Credito utilizzato / Tipo pagamento) into a
// structured breakdown, and return the remaining lines as the cleaned notes (system lines
// stripped). Best-effort: the Next POS records these as columns, but migrated rows may carry
// the note markers so this keeps parity.
function extractDiscountsFromNotes(notes: string): ParsedNotes {
  const lines = String(notes ?? "").split(/\r\n|\r|\n/);
  const discounts: ParsedDiscount[] = [];
  const other: string[] = [];
  let couponCode = "";
  let couponAmount: number | null = null;
  let giftcardUsed: number | null = null;
  let giftcardCode = "";
  let creditUsed: number | null = null;
  let paymentTypeLabel = "";

  for (const rawLn of lines) {
    const ln = rawLn.trim();
    if (!ln) continue;

    let m: RegExpMatchArray | null;
    if ((m = ln.match(/^Promozione\s*:\s*(.+)$/iu))) {
      const rest = (m[1] ?? "").trim();
      let title = rest;
      let amount: number | null = null;
      const mm = rest.match(/^(.*)\s+-\s*([0-9][0-9.,]*)$/u);
      if (mm) {
        title = (mm[1] ?? "").trim();
        amount = parseItMoney(mm[2] ?? "");
      }
      discounts.push({ kind: "promotion", label: `Promozione: ${title || "PROMO"}`, amount });
      continue;
    }
    if ((m = ln.match(/^Coupon\s*:\s*([A-Za-z0-9-]+)\s*$/iu))) {
      couponCode = (m[1] ?? "").trim().toUpperCase();
      continue;
    }
    if ((m = ln.match(/^Sconto\s*coupon\s*:\s*-\s*€?\s*([0-9][0-9.,]*)/iu))) {
      couponAmount = parseItMoney(m[1] ?? "");
      continue;
    }
    if ((m = ln.match(/^Sconto\s*manuale\s*:\s*-\s*€?\s*([0-9][0-9.,]*)/iu))) {
      discounts.push({ kind: "manual", label: "Sconto manuale", amount: parseItMoney(m[1] ?? "") });
      continue;
    }
    if ((m = ln.match(/^Sconto\s*:\s*-\s*€?\s*([0-9][0-9.,]*)/iu))) {
      discounts.push({ kind: "discount", label: "Sconto", amount: parseItMoney(m[1] ?? "") });
      continue;
    }
    if ((m = ln.match(/^GiftCard\s+utilizzata(?:\s*\(([^)]+)\))?\s*:\s*-\s*€?\s*([0-9][0-9.,]*)/iu))) {
      const v = parseItMoney(m[2] ?? "");
      if (v > 0.00001) {
        giftcardUsed = v;
        giftcardCode = (m[1] ?? "").trim();
      }
      continue;
    }
    if ((m = ln.match(/^Credito\s+utilizzato\s*:\s*-\s*€?\s*([0-9][0-9.,]*)/iu))) {
      const v = parseItMoney(m[1] ?? "");
      if (v > 0.00001) creditUsed = v;
      continue;
    }
    if ((m = ln.match(/^(?:Tipo|Metodo(?:\s+di)?)\s+pagamento\s*:\s*(.+)$/iu))) {
      paymentTypeLabel = (m[1] ?? "").trim();
      continue;
    }
    if (isSystemNoteLine(ln)) continue;
    other.push(ln);
  }

  if (couponCode || couponAmount !== null) {
    discounts.push({ kind: "coupon", label: `Coupon${couponCode ? `: ${couponCode}` : ""}`, amount: couponAmount });
  }

  return { discounts, giftcardUsed, giftcardCode, creditUsed, paymentTypeLabel, notesClean: other.join("\n") };
}

// Port of _pos_parse_it_money: parse an it-IT money token ("1.234,50" / "12,00" / "12.00")
// into a positive number, ignoring currency symbols. 0 on any non-numeric input.
function parseItMoney(input: string): number {
  let s = String(input ?? "").trim();
  if (!s) return 0;
  s = s.replace(/EUR/gi, "").replace(/€/g, "").replace(/\s+/g, "").replace(/[^0-9,.\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === ",") return 0;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return roundMoney(Math.abs(n));
}

// Port of _pos_sale_is_system_note_line: recognise auto-generated note lines that must NOT
// appear in the visible "Note" block. Also strips the Next-specific markers (Appuntamento #id,
// the [posmethod:...] base-method marker) so the cleaned notes never leak internal tags.
function isSystemNoteLine(line: string): boolean {
  const ln = String(line ?? "").trim();
  if (!ln) return false;
  const patterns = [
    /^\[PREORDINE\s+RITIRATO\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]/iu,
    /^Pacchetti\s*:\s*(?:CP#\d+\s*(?:,\s*CP#\d+\s*)*)$/iu,
    /^Ricariche\s*:\s*(?:R#\d+\s*(?:,\s*R#\d+\s*)*)$/iu,
    /^gift\s+riscattato\s*:/iu,
    // Next-specific system markers (written by saleNotes / markSaleCancelled).
    /^Appuntamento\s+#\d+\s*$/iu,
    /\[posmethod:/i,
    /^\[ANNULLATA\s/iu,
    /^Motivo:\s/iu,
    /^Magazzino prodotti (?:non )?ripristinato/iu,
  ];
  return patterns.some((rx) => rx.test(ln));
}

// Load the installment plan attached to a sale (port of SaleInstallments::loadPlanBySaleId +
// hydratePlan). Reads the sale_installment_plans row for this sale + its sale_installments
// rows, then derives paid/pending/overdue counts, next due, remaining, and the status meta —
// exactly like hydratePlan. Returns null when the sale has no plan (or the tables are absent).
async function loadSaleInstallmentPlan(slug: string, saleId: number): Promise<PosInstallmentPlanView | null> {
  const plansTable = await tenantTable(slug, "sale_installment_plans").catch(() => null);
  if (!plansTable) return null;
  const planRows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installment_plans", where: "sale_id=?", params: [saleId], orderBy: "id DESC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const plan = planRows[0];
  if (!plan) return null;

  const planId = Number(plan.id ?? 0) || 0;
  const installmentRows = planId > 0
    ? await tenantSelect<RowDataPacket>({ slug, table: "sale_installments", where: "plan_id=?", params: [planId], orderBy: "installment_no ASC" }).catch(() => [] as RowDataPacket[])
    : [];

  const today = todayIso();
  let paidAmountTotal = 0;
  let pendingAmount = 0;
  let cancelledPaidAmount = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;
  let nextDueDate: string | null = null;

  const rows: PosInstallmentPlanView["rows"] = [];
  for (const r of installmentRows) {
    const status = String(r.status ?? "pending").trim().toLowerCase();
    const dueDate = clean(dateOnly(r.due_date), 10);
    const amount = roundMoney(Number(r.amount ?? 0) || 0);
    const paidAmountRow = roundMoney(Number(r.paid_amount ?? 0) || 0);
    let effective = status;
    if (status === "pending" && dueDate !== "" && dueDate < today) effective = "overdue";
    const meta = installmentStatusMeta(status, dueDate, today);
    rows.push({
      installmentNo: Math.max(0, Number(r.installment_no ?? 0) || 0),
      dueDate,
      amount,
      paidAmount: paidAmountRow > 0.00001 ? paidAmountRow : null,
      statusKey: meta.key,
      statusLabel: meta.label,
      statusBadge: meta.badge,
    });

    if (status === "paid") {
      paidCount += 1;
      paidAmountTotal += paidAmountRow > 0.00001 ? paidAmountRow : amount;
      continue;
    }
    if (status === "cancelled" || status === "canceled") {
      if (paidAmountRow > 0.00001 || clean(r.paid_at, 40) !== "") {
        cancelledPaidAmount += paidAmountRow > 0.00001 ? paidAmountRow : amount;
      }
      continue;
    }
    pendingCount += 1;
    pendingAmount += amount;
    if (effective === "overdue") overdueCount += 1;
    if (nextDueDate === null || (dueDate !== "" && dueDate < nextDueDate)) nextDueDate = dueDate;
  }

  const downPayment = roundMoney(Number(plan.down_payment_amount ?? 0) || 0);
  const financed = roundMoney(Number(plan.financed_amount ?? 0) || 0);
  const saleTotal = roundMoney(Number(plan.sale_total ?? 0) || 0);
  const intervalUnit = String(plan.interval_unit ?? "month").trim().toLowerCase();
  const intervalValue = Math.max(1, Number(plan.interval_value ?? 1) || 1);
  const remaining = roundMoney(pendingAmount);
  void paidAmountTotal;
  void cancelledPaidAmount;
  const planStatus = String(plan.status ?? "active").trim().toLowerCase();
  const statusMeta = planStatusMeta(planStatus, overdueCount, remaining);

  return {
    id: planId,
    paymentTypeLabel: installmentPaymentTypeLabel(String(plan.payment_type ?? "")),
    statusKey: statusMeta.key,
    statusLabel: statusMeta.label,
    statusBadge: statusMeta.badge,
    downPayment,
    financed,
    remaining,
    saleTotal,
    installmentsCount: Math.max(0, Number(plan.installments_count ?? installmentRows.length) || 0),
    frequencyLabel: intervalLabel(intervalUnit, intervalValue),
    paidCount,
    pendingCount,
    overdueCount,
    nextDueDate: nextDueDate ?? "",
    notes: clean(plan.notes, 1000),
    rows,
  };
}

// Port of SaleInstallments::paymentTypeLabel(normalizePaymentType(...)).
function installmentPaymentTypeLabel(raw: string): string {
  const v = String(raw ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    cash: "cash", contanti: "cash", contante: "cash",
    card: "card", carta: "card", credit_card: "card", carta_credito: "card", "carta di credito": "card", "carta-di-credito": "card",
    check: "check", assegno: "check",
    bank: "bank", bank_transfer: "bank", "bank transfer": "bank", bonifico: "bank", "bonifico bancario": "bank", wire: "bank", transfer: "bank",
  };
  const norm = map[v] ?? "";
  if (norm === "cash") return "Contanti";
  if (norm === "card") return "Carta di Credito";
  if (norm === "check") return "Assegno";
  if (norm === "bank") return "Bonifico";
  return "";
}

// Port of SaleInstallments::intervalLabel.
function intervalLabel(unit: string, value: number): string {
  const u = String(unit ?? "").trim().toLowerCase();
  const v = Math.max(1, Number(value) || 1);
  if (u === "day") return `${v} ${v === 1 ? "giorno" : "giorni"}`;
  if (u === "week") return `${v} ${v === 1 ? "settimana" : "settimane"}`;
  return `${v} ${v === 1 ? "mese" : "mesi"}`;
}

// Port of SaleInstallments::planStatusMeta.
function planStatusMeta(status: string, overdueCount: number, remainingAmount: number): { key: string; label: string; badge: string } {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "cancelled" || s === "canceled") return { key: "cancelled", label: "Annullato", badge: "text-bg-secondary" };
  if (remainingAmount <= 0.00001) return { key: "completed", label: "Completato", badge: "text-bg-success" };
  if (overdueCount > 0) return { key: "overdue", label: "Scaduto", badge: "text-bg-danger" };
  return { key: "active", label: "Attivo", badge: "text-bg-primary" };
}

// Port of SaleInstallments::installmentStatusMeta.
function installmentStatusMeta(status: string, dueDate: string, today: string): { key: string; label: string; badge: string } {
  const s = String(status ?? "pending").trim().toLowerCase();
  if (s === "paid") return { key: "paid", label: "Pagata", badge: "text-bg-success" };
  if (s === "cancelled" || s === "canceled") return { key: "cancelled", label: "Annullata", badge: "text-bg-secondary" };
  if (dueDate !== "" && dueDate < today) return { key: "overdue", label: "Scaduta", badge: "text-bg-danger" };
  return { key: "pending", label: "Da incassare", badge: "text-bg-warning" };
}

// The quote a sale originated from (port of quote_sale_load_quote_reference_for_sale): read
// sales.source_quote_id (else the "Preventivo #id" note marker), then resolve the quotes row
// for its number/status. Returns null when there is no source quote; returns a stub (exists
// false) when the id is known but the quotes row is missing. Best-effort / schema-guarded.
async function loadSaleQuoteRef(slug: string, row: RowDataPacket): Promise<PosQuoteRef | null> {
  let quoteId = Math.max(0, Number(row.source_quote_id ?? 0) || 0);
  if (quoteId <= 0) quoteId = extractQuoteIdFromNotes(String(row.notes ?? ""));
  if (quoteId <= 0) return null;

  const quotesTable = await tenantTable(slug, "quotes").catch(() => null);
  if (!quotesTable) return { id: quoteId, number: "", status: "", effectiveStatus: "", exists: false };
  const quoteRows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", columns: "id, number, status, valid_until", where: "id=?", params: [quoteId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const quote = quoteRows[0];
  if (!quote) return { id: quoteId, number: "", status: "", effectiveStatus: "", exists: false };
  const status = String(quote.status ?? "").trim().toLowerCase();
  return {
    id: quoteId,
    number: clean(quote.number, 60),
    status,
    effectiveStatus: quoteEffectiveStatus(status, quote.valid_until),
    exists: true,
  };
}

// Extract a quote id from the sale notes ("Preventivo #123" / "Preventivo: 123"). Mirrors
// quote_sale_extract_quote_id_from_notes (best-effort). 0 when none.
function extractQuoteIdFromNotes(notes: string): number {
  const m = String(notes ?? "").match(/Preventivo\s*[#:]\s*(\d+)/i);
  return m ? Math.max(0, Number(m[1]) || 0) : 0;
}

// Best-effort effective quote status: an accepted/sent quote past valid_until reads as
// 'expired' (mirrors quote_sale_effective_status's expiry rule). Otherwise the raw status.
function quoteEffectiveStatus(status: string, validUntil: unknown): string {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "paid" || s === "canceled" || s === "cancelled" || s === "rejected") return s;
  const vu = clean(dateOnly(validUntil), 10);
  if (vu && vu < todayIso() && (s === "sent" || s === "accepted" || s === "draft" || s === "")) return "expired";
  return s;
}

// Normalize a date/datetime value to a YYYY-MM-DD string ("" when unparseable).
function dateOnly(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// Generic helper: load the rows of `table` linked to this sale via a sale_id column and map
// each one. Returns [] when the table or the sale_id column is absent (older installs).
async function summarizeLinkedRows<T>(slug: string, tableName: string, saleId: number, map: (row: RowDataPacket) => T): Promise<T[]> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || !(await columnExists(table.name, "sale_id"))) return [];
  const rows = await tenantSelect<RowDataPacket>({ slug, table: tableName, where: "sale_id=?", params: [saleId] }).catch(() => [] as RowDataPacket[]);
  return rows.map(map);
}

// GiftCard(s) ISSUED by this sale: found via the 'issue' giftcard_transactions marker (the
// same linkage cancelIssuedSaleGiftcards reverses). For each: read status + balance, and
// check whether the card has been SPENT in another still-active sale (sales.giftcard_id =
// this card on a non-cancelled sale) — that orphan-spend BLOCKS the void (legacy rule). A
// positive residual on a live card is a warning.
async function summarizeIssuedGiftcards(slug: string, saleId: number, warnings: string[], blockers: string[]): Promise<PosCancelSummary["giftcards"]> {
  const txTable = await tenantTable(slug, "giftcard_transactions").catch(() => null);
  const giftcardTable = await tenantTable(slug, "giftcards").catch(() => null);
  if (!txTable || !giftcardTable) return [];

  const marker = `%${GIFTCARD_SALE_MARKER}${saleId}]%`;
  const metaMatch = `%"sale_id":${saleId}%`;
  const txRows = await tenantSelect<RowDataPacket>({
    slug,
    table: txTable.name,
    columns: "giftcard_id",
    where: "type = 'issue' AND (meta_json LIKE ? OR note LIKE ?)",
    params: [metaMatch, marker],
  }).catch(() => [] as RowDataPacket[]);

  const out: PosCancelSummary["giftcards"] = [];
  const seen = new Set<number>();
  for (const tx of txRows) {
    const giftcardId = Math.max(0, Number(tx.giftcard_id ?? 0) || 0);
    if (giftcardId <= 0 || seen.has(giftcardId)) continue;
    seen.add(giftcardId);
    const cardRows = await tenantSelect<RowDataPacket>({ slug, table: giftcardTable.name, columns: "id, code, status, balance", where: "id=?", params: [giftcardId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const card = cardRows[0];
    if (!card) continue;
    const code = clean(card.code, 40);
    const status = String(card.status ?? "").toLowerCase();
    const balance = roundMoney(Math.max(0, Number(card.balance ?? 0) || 0));

    // Linked OTHER active sales that SPENT this card (sales.giftcard_id) → blocker.
    const linkedSaleIds = await otherSalesSpendingGiftcard(slug, giftcardId, saleId);
    if (linkedSaleIds.length) {
      blockers.push(`GiftCard ${code || `#${giftcardId}`}: gia utilizzata ${linkedSaleIds.length === 1 ? "nella vendita" : "nelle vendite"} ${linkedSaleIds.map((s) => `#${s}`).join(", ")}. Annulla prima ${linkedSaleIds.length === 1 ? "quella vendita." : "quelle vendite."}`);
    } else if (status !== "cancelled" && status !== "canceled" && balance > 0.00001) {
      warnings.push(`GiftCard ${code || `#${giftcardId}`}: residuo € ${formatMoney(balance)}`);
    }
    out.push({ id: giftcardId, code, status, balance, linkedSaleIds });
  }
  return out;
}

// Other NON-cancelled sales (excluding this one) whose giftcard_id = the issued card — i.e.
// the card was already SPENT as residui elsewhere. Best-effort; [] when the columns are absent.
async function otherSalesSpendingGiftcard(slug: string, giftcardId: number, excludeSaleId: number): Promise<number[]> {
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  if (!salesTable || !(await columnExists(salesTable.name, "giftcard_id")) || !(await columnExists(salesTable.name, "giftcard_used"))) return [];
  const scope = await tenantScope(salesTable, ["giftcard_id=?", "id<>?", "COALESCE(giftcard_used,0)>0", "LOWER(COALESCE(status,'')) NOT IN ('cancelled','canceled','annullata','annullato')"], [giftcardId, excludeSaleId]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT id FROM ${quoteIdentifier(salesTable.name)}${scope.where} ORDER BY id ASC LIMIT 20`, scope.params).catch(() => [] as RowDataPacket[]);
  return rows.map((r) => Number(r.id ?? 0)).filter((id) => id > 0);
}

// GiftBox instance(s) ISSUED by this sale (via the 'Vendita #saleId' note — the same linkage
// cancelIssuedSaleGiftboxes reverses). A box whose status is 'redeemed', or whose every
// redeemable item is fully consumed, BLOCKS the void (legacy rule); a partially-redeemed box
// is allowed. Returns the redeemed/remaining item labels for the modal.
async function summarizeIssuedGiftboxes(slug: string, saleId: number, blockers: string[]): Promise<PosCancelSummary["giftboxes"]> {
  const instanceTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  if (!instanceTable || !(await columnExists(instanceTable.name, "note"))) return [];
  const marker = `${GIFTBOX_SALE_MARKER}${saleId}`;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: instanceTable.name, columns: "id, code, status, giftbox_id", where: "note = ?", params: [marker] }).catch(() => [] as RowDataPacket[]);

  const out: PosCancelSummary["giftboxes"] = [];
  for (const r of rows) {
    const instanceId = Math.max(0, Number(r.id ?? 0) || 0);
    if (instanceId <= 0) continue;
    const code = clean(r.code, 40) || `#${instanceId}`;
    const status = String(r.status ?? "").toLowerCase();
    const redemption = await giftboxRedemptionState(slug, instanceId, Number(r.giftbox_id ?? 0));
    const fullyRedeemed = status === "redeemed" || redemption.fullyRedeemed;
    if (fullyRedeemed) blockers.push(`GiftBox ${code}: gia riscattata`);
    out.push({ id: instanceId, code, status, fullyRedeemed, redeemedItems: redemption.redeemedItems, remainingItems: redemption.remainingItems });
  }
  return out;
}

// Prenotazioni collegate a un pacchetto/giftbox/prepagato EMESSO dalla vendita e ancora
// NON annullate (port di appt_lifecycle_apply_sale_cancel_reservation_policy,
// AppointmentLifecycle.php:1931-1980). Finché una prenotazione collegata è attiva o eseguita,
// l'annullo della vendita è bloccato: va prima gestita manualmente (altrimenti il pacchetto/
// giftbox verrebbe annullato lasciando la prenotazione a referenziare un residuo inesistente).
// Le prenotazioni GIÀ annullate NON bloccano (il rilascio è demandato al flusso di annullo
// prenotazione). Sorgenti coperte: pacchetti/prepagati (client_*_.sale_id) + giftbox (marker).
async function saleCancelLinkedAppointments(slug: string, saleId: number): Promise<PosCancelSummary["linkedAppointments"]> {
  if (saleId <= 0) return [];
  const packageIds = (await tenantSelect<RowDataPacket>({ slug, table: "client_packages", columns: "id", where: "sale_id = ?", params: [saleId] }).catch(() => [] as RowDataPacket[])).map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  const prepaidIds = (await tenantSelect<RowDataPacket>({ slug, table: "client_prepaid_services", columns: "id", where: "sale_id = ?", params: [saleId] }).catch(() => [] as RowDataPacket[])).map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  let giftboxInstanceIds: number[] = [];
  const gbTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  if (gbTable && (await columnExists(gbTable.name, "note"))) {
    giftboxInstanceIds = (await tenantSelect<RowDataPacket>({ slug, table: gbTable.name, columns: "id", where: "note = ?", params: [`${GIFTBOX_SALE_MARKER}${saleId}`] }).catch(() => [] as RowDataPacket[])).map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  }
  const sources = new Map<number, Set<string>>();
  const addLinks = async (table: string, col: string, ids: number[], label: string): Promise<void> => {
    if (!ids.length) return;
    const rows = await tenantSelect<RowDataPacket>({ slug, table, columns: "appointment_id", where: `${col} IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) {
      const aid = Number(r.appointment_id ?? 0) || 0;
      if (aid <= 0) continue;
      if (!sources.has(aid)) sources.set(aid, new Set());
      sources.get(aid)!.add(label);
    }
  };
  await addLinks("appointment_package_items", "client_package_id", packageIds, "Pacchetti");
  await addLinks("appointment_giftbox_items", "instance_id", giftboxInstanceIds, "GiftBox");
  await addLinks("appointment_prepaid_service_items", "client_prepaid_service_id", prepaidIds, "Servizi prepagati");
  // GIFTCARD emessa dalla vendita usata come pagamento in una prenotazione
  // (appointments.giftcard_id + giftcard_used>0; port di appt_lifecycle_load_giftcard_
  // linked_appointments, AppointmentLifecycle.php:1610). Le giftcard emesse si trovano via il
  // marker 'issue' in giftcard_transactions (stesso linkage di summarizeIssuedGiftcards).
  const apptTable = await tenantTable(slug, "appointments").catch(() => null);
  if (apptTable && (await columnExists(apptTable.name, "giftcard_id")) && (await columnExists(apptTable.name, "giftcard_used"))) {
    const txTable = await tenantTable(slug, "giftcard_transactions").catch(() => null);
    if (txTable) {
      const gcRows = await tenantSelect<RowDataPacket>({ slug, table: txTable.name, columns: "giftcard_id", where: "type = 'issue' AND (meta_json LIKE ? OR note LIKE ?)", params: [`%"sale_id":${saleId}%`, `%${GIFTCARD_SALE_MARKER}${saleId}]%`] }).catch(() => [] as RowDataPacket[]);
      const gcIds = [...new Set(gcRows.map((r) => Number(r.giftcard_id ?? 0)).filter((n) => n > 0))];
      if (gcIds.length) {
        const rows = await tenantSelect<RowDataPacket>({ slug, table: apptTable.name, columns: "id", where: `giftcard_id IN (${gcIds.map(() => "?").join(",")}) AND COALESCE(giftcard_used,0) > 0`, params: gcIds }).catch(() => [] as RowDataPacket[]);
        for (const r of rows) { const aid = Number(r.id ?? 0) || 0; if (aid > 0) { if (!sources.has(aid)) sources.set(aid, new Set()); sources.get(aid)!.add("GiftCard"); } }
      }
    }
  }
  const apptIds = [...sources.keys()];
  if (!apptIds.length) return [];
  const appts = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, public_code, status", where: `id IN (${apptIds.map(() => "?").join(",")})`, params: apptIds, orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]);
  const out: PosCancelSummary["linkedAppointments"] = [];
  for (const a of appts) {
    const status = String(a.status ?? "").trim().toLowerCase();
    const id = Number(a.id ?? 0) || 0;
    const code = clean(a.public_code, 40) || `#${id}`;
    const srcSet = sources.get(id) ?? new Set<string>();
    const source = [...srcSet].join(", ") || "questa vendita";
    const canceled = status === "canceled" || status === "cancelled";
    if (!canceled) {
      // Attiva/eseguita -> gestione manuale richiesta (port :1952-1980).
      out.push({
        id, code, status, source,
        blocker: status === "done"
          ? `Prenotazione ${code} in stato Eseguito collegata a ${source}: annulla/storna prima la prenotazione o rimuovi manualmente il collegamento.`
          : `Prenotazione ${code} collegata a ${source}: apri la prenotazione e rimuovi manualmente il servizio/credito oppure annulla la prenotazione prima di annullare la vendita.`,
      });
    } else if (srcSet.has("GiftCard")) {
      // Già annullata ma CONSERVA ANCORA la GiftCard della vendita come credito
      // (la giftcard è nel branch solo con giftcard_used>0) -> BLOCKER (port di
      // AppointmentLifecycle.php:1996-2005): va ripulita prima, altrimenti si
      // annullerebbe la vendita lasciando il credito applicato alla prenotazione.
      out.push({
        id, code, status, source,
        blocker: `Prenotazione ${code} già annullata ma con credito ancora applicato a ${source}: ripulisci manualmente la prenotazione prima di annullare la vendita.`,
      });
    }
    // else: annullata senza credito residuo -> nessun blocker (preserve history).
  }
  return out;
}

// Best-effort redemption state of a giftbox instance: compare the per-item used qty
// (giftbox_redemptions + giftbox_redemption_items) against the template item qtys
// (giftbox_items). fullyRedeemed = at least one redemption exists AND every redeemable item is
// fully consumed. Returns labelled redeemed/remaining lists for the modal. Degrades to
// {fullyRedeemed:false} when the optional redemption schema is absent.
async function giftboxRedemptionState(slug: string, instanceId: number, giftboxId: number): Promise<{ fullyRedeemed: boolean; redeemedItems: string[]; remainingItems: string[] }> {
  const empty = { fullyRedeemed: false, redeemedItems: [] as string[], remainingItems: [] as string[] };
  const redTable = await tenantTable(slug, "giftbox_redemptions").catch(() => null);
  const redItemsTable = await tenantTable(slug, "giftbox_redemption_items").catch(() => null);
  const itemsTable = await tenantTable(slug, "giftbox_items").catch(() => null);
  if (!redTable || !redItemsTable || !itemsTable || giftboxId <= 0) return empty;

  const usedRows = await dbQuery<RowDataPacket[]>(
    `SELECT ri.giftbox_item_id AS item_id, SUM(ri.qty) AS used_qty
       FROM ${quoteIdentifier(redTable.name)} r
       JOIN ${quoteIdentifier(redItemsTable.name)} ri ON ri.redemption_id=r.id
      WHERE r.instance_id=?
      GROUP BY ri.giftbox_item_id`,
    [instanceId],
  ).catch(() => [] as RowDataPacket[]);
  const usedByItem = new Map<number, number>();
  for (const u of usedRows) usedByItem.set(Number(u.item_id ?? 0), Math.max(0, Number(u.used_qty ?? 0) || 0));
  const hasRedemptions = usedByItem.size > 0;

  const templateItems = await tenantSelect<RowDataPacket>({ slug, table: itemsTable.name, columns: "id, item_type, service_id, product_id, qty, custom_label", where: "giftbox_id=?", params: [giftboxId] }).catch(() => [] as RowDataPacket[]);
  if (!templateItems.length) return { fullyRedeemed: false, redeemedItems: [], remainingItems: [] };

  const redeemedItems: string[] = [];
  const remainingItems: string[] = [];
  let allConsumed = true;
  let considered = 0;
  for (const it of templateItems) {
    const itemId = Number(it.id ?? 0);
    const qty = Math.max(1, Number(it.qty ?? 1) || 1);
    const used = Math.min(qty, usedByItem.get(itemId) ?? 0);
    const remaining = Math.max(0, qty - used);
    const label = clean(it.custom_label, 120) || (String(it.item_type ?? "").toLowerCase() === "product" ? "Prodotto" : String(it.item_type ?? "").toLowerCase() === "service" ? "Servizio" : "Elemento");
    considered += 1;
    if (used > 0) redeemedItems.push(used > 1 ? `${label} x${used}` : label);
    if (remaining > 0) {
      remainingItems.push(remaining > 1 ? `${label} x${remaining}` : label);
      allConsumed = false;
    }
  }
  const fullyRedeemed = hasRedemptions && considered > 0 && allConsumed;
  return { fullyRedeemed, redeemedItems, remainingItems };
}

// ---------------------------------------------------------------------------
// "Cronologia utilizzo / ritiro" tracking + interactive prepaid manual execution.
// ---------------------------------------------------------------------------

// The prepaid rows linked to a sale: primarily the client_prepaid_services whose sale_id
// matches (the way issuePrepaidFromSale writes them), tenant-scoped. Returns the raw rows.
async function prepaidRowsForSale(slug: string, saleId: number): Promise<RowDataPacket[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_prepaid_services",
    where: "sale_id=?",
    params: [saleId],
    orderBy: "id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows;
}

// qty already committed to OPEN appointments for a prepaid — port of
// ClientPrepaidServices::activeLinkedQty. Redeemed links (redeemed_at set) and links to
// terminal appointments (done/canceled/no_show/rejected) do NOT count. Tenant-scoped.
async function prepaidActiveLinkedQty(slug: string, prepaidId: number): Promise<number> {
  if (prepaidId <= 0) return 0;
  const table = await tenantTable(slug, "appointment_prepaid_service_items").catch(() => null);
  if (!table) return 0;
  // Both api and appointments carry tenant_id, so the tenant filter must be ALIAS-QUALIFIED
  // (unqualified would be ambiguous) — scope on api.tenant_id explicitly.
  const scope = await aliasTenantScope(table, "api", ["api.client_prepaid_service_id=?", "api.redeemed_at IS NULL"], [prepaidId]);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(SUM(api.qty),0) AS linked
       FROM ${quoteIdentifier(table.name)} api
       LEFT JOIN appointments a ON a.id=api.appointment_id
      ${scope.where}
        AND (a.id IS NULL OR LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('done','completed','eseguito','canceled','cancelled','no_show','no show','no-show','noshow','non presentato','annullato','annullata','rejected','rifiutato'))`,
    scope.params,
  ).catch(() => [] as RowDataPacket[]);
  return Math.max(0, Number(rows[0]?.linked ?? 0) || 0);
}

// Like tenantScope but prefixes the injected tenant_id filter with the given table ALIAS, so
// it is unambiguous in a JOIN where more than one table carries tenant_id.
async function aliasTenantScope(target: TenantTarget, alias: string, clauses: string[], params: unknown[]) {
  const scopedClauses = [...clauses];
  const scopedParams = [...params];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    scopedClauses.unshift(`${alias}.tenant_id=?`);
    scopedParams.unshift(target.tenantId ?? 0);
  }
  return { where: scopedClauses.length ? ` WHERE ${scopedClauses.join(" AND ")}` : "", params: scopedParams };
}

// The usage timeline for one prepaid: appointment redemptions (appointment_prepaid_service_items
// joined to appointments) + manual/appointment usages (client_prepaid_service_usages joined to
// appointments), grouped by appointment (an appointment link + its usage row collapse into one
// event), newest-first. Faithful to the prepaid $trackingCards event builder.
async function prepaidUsageHistory(slug: string, prepaidId: number): Promise<PosPrepaidUsageEvent[]> {
  if (prepaidId <= 0) return [];
  const events = new Map<string, PosPrepaidUsageEvent & { sort: number }>();

  // Appointment links (appointment_prepaid_service_items).
  const apiTable = await tenantTable(slug, "appointment_prepaid_service_items").catch(() => null);
  if (apiTable) {
    const scope = await aliasTenantScope(apiTable, "api", ["api.client_prepaid_service_id=?"], [prepaidId]);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT api.id, api.appointment_id, api.qty, api.redeemed_at, api.created_at,
              a.public_code AS appointment_code, a.status AS appointment_status,
              a.starts_at AS appointment_starts_at
         FROM ${quoteIdentifier(apiTable.name)} api
         LEFT JOIN appointments a ON a.id=api.appointment_id
        ${scope.where}
        ORDER BY api.id ASC`,
      scope.params,
    ).catch(() => [] as RowDataPacket[]);
    for (const r of rows) {
      const aid = Math.max(0, Number(r.appointment_id ?? 0) || 0);
      const key = aid > 0 ? `appt:${aid}` : `link:${Number(r.id ?? 0)}`;
      const when = dateTimeString(r.appointment_starts_at || r.redeemed_at || r.created_at);
      const prev = events.get(key);
      const qty = Math.max(1, Number(r.qty ?? 1) || 1);
      if (prev) {
        prev.qty += qty;
        if (!prev.when) prev.when = when;
      } else {
        events.set(key, {
          usageId: 0,
          appointmentId: aid,
          appointmentCode: clean(r.appointment_code, 40),
          appointmentStatus: clean(r.appointment_status, 40),
          qty,
          when,
          operator: "",
          isManual: false,
          canUndo: false,
          appointmentLink: aid > 0 ? `/${encodeURIComponent(slug)}/appointments?action=edit&id=${aid}` : "",
          sort: sortValue(when),
        });
      }
    }
  }

  // Usage rows (client_prepaid_service_usages) — appointment redemptions AND manual executions.
  const usageTable = await tenantTable(slug, "client_prepaid_service_usages").catch(() => null);
  if (usageTable) {
    const scope = await aliasTenantScope(usageTable, "u", ["u.client_prepaid_service_id=?"], [prepaidId]);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT u.id, u.appointment_id, u.qty, u.used_at, u.note, u.created_by, u.created_at,
              a.public_code AS appointment_code, a.status AS appointment_status,
              a.starts_at AS appointment_starts_at
         FROM ${quoteIdentifier(usageTable.name)} u
         LEFT JOIN appointments a ON a.id=u.appointment_id
        ${scope.where}
        ORDER BY u.id ASC`,
      scope.params,
    ).catch(() => [] as RowDataPacket[]);
    for (const r of rows) {
      const aid = Math.max(0, Number(r.appointment_id ?? 0) || 0);
      const usageId = Math.max(0, Number(r.id ?? 0) || 0);
      const key = aid > 0 ? `appt:${aid}` : `usage:${usageId}`;
      const manual = aid <= 0 && isManualUsageNote(r.note);
      const when = dateTimeString(r.appointment_starts_at || r.used_at || r.created_at);
      const operator = await operatorNameFromUserId(slug, Number(r.created_by ?? 0) || 0);
      const qty = Math.max(1, Number(r.qty ?? 1) || 1);
      const prev = events.get(key);
      if (prev) {
        prev.qty = Math.max(prev.qty, qty);
        if (usageId > 0 && prev.usageId <= 0) prev.usageId = usageId;
        if (manual) prev.isManual = true;
        if (!prev.when) prev.when = when;
        if (!prev.operator && operator) prev.operator = operator;
        if (manual && aid <= 0) prev.canUndo = true;
      } else {
        events.set(key, {
          usageId,
          appointmentId: aid,
          appointmentCode: clean(r.appointment_code, 40),
          appointmentStatus: clean(r.appointment_status, 40),
          qty,
          when,
          operator,
          isManual: manual,
          canUndo: manual && aid <= 0 && usageId > 0,
          appointmentLink: aid > 0 ? `/${encodeURIComponent(slug)}/appointments?action=edit&id=${aid}` : "",
          sort: sortValue(when),
        });
      }
    }
  }

  return [...events.values()]
    .sort((a, b) => b.sort - a.sort || b.appointmentId - a.appointmentId)
    .map((ev): PosPrepaidUsageEvent => ({
      usageId: ev.usageId,
      appointmentId: ev.appointmentId,
      appointmentCode: ev.appointmentCode,
      appointmentStatus: ev.appointmentStatus,
      qty: ev.qty,
      when: ev.when,
      operator: ev.operator,
      isManual: ev.isManual,
      canUndo: ev.canUndo,
      appointmentLink: ev.appointmentLink,
    }));
}

// A sortable number from a "YYYY-MM-DD HH:MM:SS" timestamp (higher = newer). 0 when empty.
function sortValue(value: string): number {
  const t = Date.parse(String(value ?? "").replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

// Build the prepaid "Cronologia utilizzo" cards for a sale: one per prepaid line, with the
// residual/free qty, the can-execute flag + note, and the newest-first usage timeline.
async function buildPrepaidTracking(slug: string, saleId: number, sale: PosSale): Promise<PosPrepaidTracking[]> {
  const rows = await prepaidRowsForSale(slug, saleId);
  if (!rows.length) return [];
  const out: PosPrepaidTracking[] = [];
  for (const pr of rows) {
    const prepaidId = Math.max(0, Number(pr.id ?? 0) || 0);
    if (prepaidId <= 0) continue;
    const purchasedQty = Math.max(0, Number(pr.purchased_qty ?? 0) || 0);
    const remainingQty = Math.max(0, Number(pr.remaining_qty ?? 0) || 0);
    const status = String(pr.status ?? "active").toLowerCase();
    const serviceName = clean(pr.service_name, 190) || `Servizio #${Number(pr.service_id ?? 0) || 0}`;
    // Match the sale line by sale_item_id (else fall back to the prepaid's own name).
    const saleItemId = Math.max(0, Number(pr.sale_item_id ?? 0) || 0);
    const linkedItem = sale.items.find((it) => it.id === saleItemId && it.type === "service");
    const title = linkedItem?.name || serviceName;

    const linkedQty = await prepaidActiveLinkedQty(slug, prepaidId);
    const freeQty = Math.max(0, remainingQty - linkedQty);
    const cancelled = ["canceled", "cancelled", "annullato", "annullata"].includes(status);
    const completed = status === "completed";
    const canExecute = !cancelled && !completed && remainingQty > 0 && freeQty > 0;

    let note = "";
    if (cancelled) note = "Residuo annullato.";
    else if (remainingQty <= 0 || completed) note = "Residuo esaurito.";
    else if (linkedQty > 0 && freeQty <= 0) note = "Residuo gia collegato a prenotazioni aperte.";
    else if (linkedQty > 0) note = `Disponibili libere ${freeQty} su ${remainingQty} residue; ${linkedQty} gia prenotate.`;

    const usageHistory = await prepaidUsageHistory(slug, prepaidId);

    out.push({
      saleItemId,
      prepaidId,
      title,
      serviceName,
      purchasedQty,
      remainingQty,
      freeQty,
      canExecute,
      note,
      usageHistory,
    });
  }
  return out;
}

// Per product line pickup state: for 'ordered' lines the pickable-now qty (min of the line
// qty and the available stock at the sale location); 'collected' lines are surfaced so the UI
// can offer "Rimuovi ritiro" (undo). Faithful to the preorder $trackingCards mark/undo state.
async function buildPreorderTracking(slug: string, sale: PosSale): Promise<PosPreorderTracking[]> {
  const productItems = sale.items.filter((it) => it.type === "product" && it.refId > 0 && (it.status === "ordered" || it.status === "collected"));
  if (!productItems.length) return [];
  const out: PosPreorderTracking[] = [];
  for (const it of productItems) {
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    if (it.status === "collected") {
      out.push({ saleItemId: it.id, productId: it.refId, name: it.name, status: "collected", qty, collectMax: 0, canCollect: false, stockNow: 0, note: "" });
      continue;
    }
    const stockNow = Math.max(0, await currentProductStock(slug, it.refId, sale.locationId).catch(() => 0));
    const collectMax = Math.max(0, Math.min(qty, Math.floor(stockNow)));
    let note = "";
    if (collectMax <= 0) note = "Stock insufficiente: registra prima un carico prodotto.";
    else if (collectMax < qty) note = `Disponibile ritiro parziale fino a ${collectMax} pezzi.`;
    else note = `Stock attuale: ${Math.floor(stockNow)} pezzi.`;
    out.push({ saleItemId: it.id, productId: it.refId, name: it.name, status: "ordered", qty, collectMax, canCollect: collectMax > 0, stockNow: Math.floor(stockNow), note });
  }
  return out;
}

// MARK a prepaid-service line as MANUALLY executed (out of appointment) — faithful port of
// pos_sale_detail.php?do=mark_prepaid_manual_execution + ClientPrepaidServices::redeemManual.
// Decrements client_prepaid_services.remaining_qty by qty (bounded to the FREE residual, i.e.
// not already committed to open appointments), recomputes the status, and inserts a
// client_prepaid_service_usages row tagged with the operator + now + a 'manual' note. Runs in a
// tenant-scoped transaction. Returns the refreshed sale detail.
export async function markPrepaidManualExecution(
  slug: string,
  input: { saleId: number; prepaidId: number; qty: number; userId: number | null },
): Promise<PosSaleDetail> {
  const saleId = Math.max(0, input.saleId);
  const prepaidId = Math.max(0, input.prepaidId);
  const qty = Math.max(1, Math.round(input.qty || 0));
  if (saleId <= 0) throw new Error("Vendita non valida.");
  if (prepaidId <= 0) throw new Error("Servizio prepagato non valido.");
  if (qty <= 0) throw new Error("Quantita da eseguire non valida.");

  const saleRow = await getSaleRow(slug, saleId);
  await assertSaleLocationAccess(slug, Number(saleRow.location_id ?? 0) || 0);
  if (isCancelledStatus(saleRow.status)) {
    throw new Error("La vendita e annullata: non e possibile segnare il servizio come eseguito.");
  }

  const table = await tenantTable(slug, "client_prepaid_services");
  const usageTable = await tenantTable(slug, "client_prepaid_service_usages");
  // Scadenza attiva? (gate del blocco "credito scaduto", come il legacy
  // ClientPrepaidServices.php:1115-1117 via PosSettings::prepaidExpiryEnabled).
  const expiryEnabled = await prepaidsExpiryEnabled(slug).catch(() => false);

  await withTenantTransaction(slug, async (q) => {
    const scope = await tenantScope(table, ["id=?"], [prepaidId]);
    const rows = await q<RowDataPacket>(
      `SELECT id, sale_id, service_id, service_name, purchased_qty, remaining_qty, status, expires_at FROM ${quoteIdentifier(table.name)}${scope.where} FOR UPDATE`,
      scope.params,
    );
    const pre = rows[0];
    if (!pre) throw new Error("Residuo prepagato non trovato.");
    if ((Number(pre.sale_id ?? 0) || 0) !== saleId) throw new Error("Residuo prepagato non collegato a questa vendita.");

    const serviceName = clean(pre.service_name, 190) || `Servizio #${Number(pre.service_id ?? 0) || 0}`;
    const remaining = Math.max(0, Number(pre.remaining_qty ?? 0) || 0);
    const purchased = Math.max(0, Number(pre.purchased_qty ?? 0) || 0);
    const status = String(pre.status ?? "active").toLowerCase();
    if (["canceled", "cancelled"].includes(status)) throw new Error(`Servizio prepagato "${serviceName}": residuo annullato.`);
    if (remaining <= 0 || status === "completed") throw new Error(`Servizio prepagato "${serviceName}": residuo esaurito.`);
    // Credito SCADUTO: con la scadenza attiva un prepagato oltre expires_at non è
    // eseguibile manualmente (port di ClientPrepaidServices::prepaidExpiredForDate).
    if (expiryEnabled) {
      const expRaw = String(pre.expires_at ?? "").trim();
      if (expRaw) {
        const exp = new Date(expRaw.includes("T") ? expRaw : expRaw.replace(" ", "T"));
        if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
          throw new Error(`Servizio prepagato "${serviceName}": credito scaduto.`);
        }
      }
    }

    const linkedQty = await prepaidActiveLinkedQty(slug, prepaidId);
    const freeQty = Math.max(0, remaining - linkedQty);
    if (freeQty < qty) {
      const detail = linkedQty > 0
        ? ` Disponibili libere ${freeQty}/${purchased} (prenotate ${linkedQty}).`
        : ` Disponibili ${remaining}/${purchased}.`;
      throw new Error(`Servizio prepagato "${serviceName}": disponibilita libera insufficiente.${detail}`);
    }

    const newRemaining = Math.max(0, remaining - qty);
    const newStatus = prepaidStatusCalc(status, newRemaining);
    const updScope = await tenantScope(table, ["id=?"], [prepaidId]);
    await q(
      `UPDATE ${quoteIdentifier(table.name)} SET remaining_qty=?, status=?, updated_at=NOW()${updScope.where}`,
      [newRemaining, newStatus, ...updScope.params],
    );

    // Insert the manual usage row. tenant_id is prepended when the table is tenant-shared so
    // the row is scoped to this tenant (BEFORE-write triggers also backstop it).
    const usageCols: string[] = ["client_prepaid_service_id", "appointment_id", "qty", "used_at", "note", "created_by"];
    const usageVals: unknown[] = [prepaidId, null, qty, nowDateTime(), "Esecuzione manuale servizio prepagato", input.userId && input.userId > 0 ? input.userId : null];
    if (usageTable.mode === "shared" && await columnExists(usageTable.name, "tenant_id")) {
      usageCols.unshift("tenant_id");
      usageVals.unshift(usageTable.tenantId ?? 0);
    }
    const ph = usageVals.map(() => "?").join(",");
    await q(`INSERT INTO ${quoteIdentifier(usageTable.name)} (${usageCols.map((c) => quoteIdentifier(c)).join(",")}) VALUES (${ph})`, usageVals);
  });

  return getManageSaleDetail(slug, saleId);
}

// UNDO a manual prepaid execution — faithful port of undo_prepaid_manual_execution +
// ClientPrepaidServices::undoManualUsage. Restores the residual (bounded to purchased_qty),
// recomputes the status, and DELETES the manual usage row. Only a manual (appointment_id=0,
// 'esecuzione manuale' note) usage bound to this sale's prepaid can be undone.
export async function undoPrepaidManualExecution(
  slug: string,
  input: { saleId: number; usageId: number; userId: number | null },
): Promise<PosSaleDetail> {
  const saleId = Math.max(0, input.saleId);
  const usageId = Math.max(0, input.usageId);
  if (saleId <= 0) throw new Error("Vendita non valida.");
  if (usageId <= 0) throw new Error("Utilizzo manuale non valido.");

  const saleRow = await getSaleRow(slug, saleId);
  await assertSaleLocationAccess(slug, Number(saleRow.location_id ?? 0) || 0);
  if (isCancelledStatus(saleRow.status)) {
    throw new Error("La vendita e annullata: non e possibile modificare gli utilizzi manuali.");
  }

  const table = await tenantTable(slug, "client_prepaid_services");
  const usageTable = await tenantTable(slug, "client_prepaid_service_usages");

  await withTenantTransaction(slug, async (q) => {
    const uScope = await tenantScope(usageTable, ["id=?"], [usageId]);
    const uRows = await q<RowDataPacket>(
      `SELECT id, client_prepaid_service_id, appointment_id, qty, note FROM ${quoteIdentifier(usageTable.name)}${uScope.where} FOR UPDATE`,
      uScope.params,
    );
    const usage = uRows[0];
    if (!usage) throw new Error("Utilizzo manuale non trovato.");
    if ((Number(usage.appointment_id ?? 0) || 0) > 0) throw new Error("Questo utilizzo e collegato a una prenotazione e non puo essere annullato da qui.");
    if (!isManualUsageNote(usage.note)) throw new Error("Questo utilizzo non risulta creato come esecuzione manuale.");

    const prepaidId = Math.max(0, Number(usage.client_prepaid_service_id ?? 0) || 0);
    const undoQty = Math.max(1, Number(usage.qty ?? 1) || 1);
    const pScope = await tenantScope(table, ["id=?"], [prepaidId]);
    const pRows = await q<RowDataPacket>(
      `SELECT id, sale_id, service_id, service_name, purchased_qty, remaining_qty, status FROM ${quoteIdentifier(table.name)}${pScope.where} FOR UPDATE`,
      pScope.params,
    );
    const pre = pRows[0];
    if (!pre) throw new Error("Residuo prepagato non trovato.");
    if ((Number(pre.sale_id ?? 0) || 0) !== saleId) throw new Error("Residuo prepagato non collegato a questa vendita.");

    const serviceName = clean(pre.service_name, 190) || `Servizio #${Number(pre.service_id ?? 0) || 0}`;
    const status = String(pre.status ?? "active").toLowerCase();
    if (["canceled", "cancelled"].includes(status)) throw new Error(`Servizio prepagato "${serviceName}": residuo annullato.`);

    const purchased = Math.max(0, Number(pre.purchased_qty ?? 0) || 0);
    const remaining = Math.max(0, Number(pre.remaining_qty ?? 0) || 0);
    let newRemaining = remaining + undoQty;
    if (purchased > 0) newRemaining = Math.min(purchased, newRemaining);
    const newStatus = prepaidStatusCalc(status, newRemaining);

    const updScope = await tenantScope(table, ["id=?"], [prepaidId]);
    await q(`UPDATE ${quoteIdentifier(table.name)} SET remaining_qty=?, status=?, updated_at=NOW()${updScope.where}`, [newRemaining, newStatus, ...updScope.params]);
    const delScope = await tenantScope(usageTable, ["id=?"], [usageId]);
    await q(`DELETE FROM ${quoteIdentifier(usageTable.name)}${delScope.where}`, delScope.params);
  });

  return getManageSaleDetail(slug, saleId);
}

// Recompute a prepaid status from the residual — port of ClientPrepaidServices::statusCalc:
// a 'canceled' status is never changed here; remaining<=0 -> 'completed'; else 'active'.
function prepaidStatusCalc(currentStatus: string, remainingQty: number): string {
  const status = String(currentStatus ?? "").toLowerCase();
  if (["canceled", "cancelled"].includes(status)) return status;
  return remainingQty <= 0 ? "completed" : "active";
}

// Mark a product sale line as collected ("Ritirato") — a faithful port of the
// pos_sale_detail.php mark_preorder_collection action, now with PARTIAL pickup. Decrements the
// location stock by the collected qty, writes a best-effort stock_docs 'scarico' movement, and
// either flips the whole line to item_status='collected' (full pickup) OR SPLITS the ordered
// line into a residual ordered part + a new collected part (partial pickup, proportional
// line_total split via splitLineTotal). Appends a [PREORDINE RITIRATO ...] notes marker so the
// undo can find/strip it (faithful to the legacy marker trail).
//
// TODO (deep stock-document schema): the legacy scarico row also carries operator_user_id /
// document_type / location_id / attachment_* columns — recordPickupStockDoc writes the subset
// present in this schema (filterColumns drops the rest). The audit-document richness beyond
// that subset is the only piece still deferred; the operational split + undo are implemented.
export async function markManageSaleItemCollected(
  slug: string,
  input: { saleId: number; saleItemId: number; qty?: number; userId: number | null; userName: string },
): Promise<PosSaleDetail> {
  if (input.saleId <= 0 || input.saleItemId <= 0) throw new Error("Riga prodotto non valida.");
  const saleRow = await getSaleRow(slug, input.saleId);
  // Per-sale location access guard (port of _pos_hist_assert_sale_location_access).
  await assertSaleLocationAccess(slug, Number(saleRow.location_id ?? 0) || 0);
  if (isCancelledStatus(saleRow.status)) throw new Error("La vendita è annullata: il ritiro non può essere registrato.");
  const locationId = Number(saleRow.location_id ?? 0) || 0;

  const itemRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_items",
    where: "id=? AND sale_id=?",
    params: [input.saleItemId, input.saleId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const item = itemRows[0];
  if (!item) throw new Error("Riga preordine non trovata.");
  if (String(item.item_type ?? "").toLowerCase() !== "product") throw new Error("Operazione consentita solo per righe prodotto.");
  const productId = Math.max(0, Number(item.item_id ?? 0) || 0);
  if (productId <= 0) throw new Error("Prodotto collegato non valido.");
  const currentStatus = normalizeItemStatus("product", item.item_status, Number(saleRow.client_id ?? 0) > 0);
  if (currentStatus !== "ordered") throw new Error("Questo prodotto non e piu in attesa di ritiro.");
  const qty = Math.max(1, Math.round(Number(item.qty ?? 1) || 1));
  // Requested pickup qty (0/absent -> full). Bounded to [1, line qty] (legacy validation).
  const requested = Math.max(0, Math.round(Number(input.qty ?? 0) || 0));
  const collectQty = requested > 0 ? requested : qty;
  if (collectQty < 1 || collectQty > qty) throw new Error("Quantita da ritirare non valida.");

  // Decrement the stock for the pickup (a product whose status was 'ordered' was NOT
  // decremented at checkout, so it is decremented now — faithful to the legacy scarico).
  const available = await currentProductStock(slug, productId, locationId);
  if (available + 0.00001 < collectQty) {
    throw new Error(`Stock insufficiente per registrare il ritiro${item.item_name ? `: ${String(item.item_name)}` : ""}.`);
  }

  const unitPrice = roundMoney(Number(item.unit_price ?? 0) || 0);
  const lineTotal = roundMoney(Number(item.line_total ?? unitPrice * qty) || 0);
  const [collectLineTotal, remainingLineTotal] = splitLineTotal(qty, lineTotal, collectQty);
  const itemName = String(item.item_name ?? "Prodotto");

  // Best-effort stock movement document (audit), then the stock decrement, then the split.
  await recordPickupStockDoc(slug, {
    saleId: input.saleId,
    productId,
    qty: collectQty,
    locationId,
    note: `Ritiro preordine da Dettaglio vendita • vendita #${input.saleId} • prodotto: ${itemName} x${collectQty}`,
    operatorName: input.userName,
    operatorUserId: input.userId,
    cause: "scarico",
  });
  await adjustProductStock(slug, productId, locationId, -collectQty);

  if (collectQty >= qty) {
    await tenantUpdate({ slug, table: "sale_items", id: input.saleItemId, values: { item_status: "collected" } });
  } else {
    // Split: shrink the ordered line to the residual, insert a new collected line.
    await tenantUpdate({ slug, table: "sale_items", id: input.saleItemId, values: { qty: qty - collectQty, line_total: remainingLineTotal } });
    const saleItemsTable = await tenantTable(slug, "sale_items");
    await tenantInsert(saleItemsTable, await filterColumns(saleItemsTable.name, {
      sale_id: input.saleId,
      item_type: "product",
      item_id: productId,
      item_name: itemName,
      qty: collectQty,
      unit_price: unitPrice,
      line_total: collectLineTotal,
      item_status: "collected",
    }));
  }

  // Append the [PREORDINE RITIRATO ...] marker to the sale notes (audit + undo anchor).
  await appendPreorderCollectionMarker(slug, input.saleId, saleRow.notes, itemName, collectQty, input.userName);

  return getManageSaleDetail(slug, input.saleId);
}

// UNDO a product pickup ("Rimuovi ritiro") — faithful port of undo_preorder_collection.
// Restores the location stock by the collected qty (best-effort compensating 'carico' doc),
// returns the line to item_status='ordered' — MERGING it into a sibling ordered line of the
// same product/name/unit-price when one exists (so partial pickups don't leave a duplicate),
// and strips the matching [PREORDINE RITIRATO ...] notes marker.
export async function undoManageSaleItemCollected(
  slug: string,
  input: { saleId: number; saleItemId: number; userId: number | null; userName: string },
): Promise<PosSaleDetail> {
  if (input.saleId <= 0 || input.saleItemId <= 0) throw new Error("Riga prodotto non valida.");
  const saleRow = await getSaleRow(slug, input.saleId);
  await assertSaleLocationAccess(slug, Number(saleRow.location_id ?? 0) || 0);
  if (isCancelledStatus(saleRow.status)) throw new Error("La vendita è annullata: non è possibile modificare il ritiro.");
  const locationId = Number(saleRow.location_id ?? 0) || 0;

  const itemRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_items",
    where: "id=? AND sale_id=?",
    params: [input.saleItemId, input.saleId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const item = itemRows[0];
  if (!item) throw new Error("Riga preordine non trovata.");
  if (String(item.item_type ?? "").toLowerCase() !== "product") throw new Error("Operazione consentita solo per righe prodotto.");
  const productId = Math.max(0, Number(item.item_id ?? 0) || 0);
  if (productId <= 0) throw new Error("Prodotto collegato non valido.");
  const currentStatus = normalizeItemStatus("product", item.item_status, Number(saleRow.client_id ?? 0) > 0);
  if (currentStatus !== "collected") throw new Error("Il ritiro risulta gia rimosso o non ancora registrato.");
  const qty = Math.max(1, Math.round(Number(item.qty ?? 1) || 1));
  const unitPrice = roundMoney(Number(item.unit_price ?? 0) || 0);
  const lineTotal = roundMoney(Number(item.line_total ?? unitPrice * qty) || 0);
  const itemName = String(item.item_name ?? "Prodotto");

  // Restore stock (compensating carico doc, best-effort), then re-open the line.
  await recordPickupStockDoc(slug, {
    saleId: input.saleId,
    productId,
    qty,
    locationId,
    note: `Storno ritiro preordine da Dettaglio vendita • vendita #${input.saleId} • prodotto: ${itemName} x${qty}`,
    operatorName: input.userName,
    operatorUserId: input.userId,
    cause: "carico",
  });
  await adjustProductStock(slug, productId, locationId, qty);

  // Merge into a sibling ordered line of the same product/name/unit-price (avoids duplicates
  // after a partial pickup); else just flip this line back to 'ordered'.
  const orderedRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_items",
    where: "sale_id=? AND item_type='product' AND item_id=? AND id<>? AND LOWER(TRIM(COALESCE(item_status,''))) IN ('ordered','ordinato')",
    params: [input.saleId, productId, input.saleItemId],
    orderBy: "id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const target = orderedRows.find((r) =>
    String(r.item_name ?? "").trim() === itemName.trim()
    && Math.abs((Number(r.unit_price ?? 0) || 0) - unitPrice) < 0.0001,
  );
  if (target) {
    const targetId = Math.max(0, Number(target.id ?? 0) || 0);
    const targetQty = Math.max(1, Math.round(Number(target.qty ?? 1) || 1));
    const targetLineTotal = roundMoney(Number(target.line_total ?? unitPrice * targetQty) || 0);
    await tenantUpdate({ slug, table: "sale_items", id: targetId, values: { qty: targetQty + qty, line_total: roundMoney(targetLineTotal + lineTotal) } });
    await tenantDelete({ slug, table: "sale_items", id: input.saleItemId });
  } else {
    await tenantUpdate({ slug, table: "sale_items", id: input.saleItemId, values: { item_status: "ordered" } });
  }

  // Strip the matching [PREORDINE RITIRATO ...] marker from the sale notes.
  await removePreorderCollectionMarker(slug, input.saleId, saleRow.notes, itemName, qty);

  return getManageSaleDetail(slug, input.saleId);
}

// Proportional line-total split for a partial pickup — port of _pos_hist_split_line_total:
// [collectedTotal, remainingTotal] where collectedTotal = round(lineTotal*collectQty/fullQty).
function splitLineTotal(fullQty: number, lineTotal: number, collectQty: number): [number, number] {
  const q = Math.max(1, Math.round(fullQty));
  const c = Math.max(0, Math.min(q, Math.round(collectQty)));
  const total = roundMoney(lineTotal);
  if (c <= 0) return [0, total];
  if (c >= q) return [total, 0];
  let collected = roundMoney((total * c) / q);
  if (collected < 0) collected = 0;
  if (collected > total) collected = total;
  const remaining = Math.max(0, roundMoney(total - collected));
  return [collected, remaining];
}

// Append "[PREORDINE RITIRATO <dt>] <name> x<qty> • <operator>" to the sale notes — port of
// _pos_hist_append_preorder_collection_marker (best-effort; skipped if sales has no notes col).
async function appendPreorderCollectionMarker(slug: string, saleId: number, currentNotes: unknown, itemName: string, qty: number, operatorName: string): Promise<void> {
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  if (!salesTable || !(await columnExists(salesTable.name, "notes"))) return;
  const name = clean(itemName, 190) || "Prodotto";
  const op = clean(operatorName, 120);
  let line = `[PREORDINE RITIRATO ${nowDateTime()}] ${name} x${Math.max(1, Math.round(qty))}`;
  if (op) line += ` • ${op}`;
  const base = String(currentNotes ?? "").trim();
  const next = (base ? `${base}\n` : "") + line;
  await tenantUpdate({ slug, table: "sales", id: saleId, values: { notes: next.trim() } });
}

// Remove the best-matching "[PREORDINE RITIRATO ...]" marker for a product/qty from the sale
// notes — port of _pos_hist_remove_preorder_collection_marker (name+qty match, best score).
async function removePreorderCollectionMarker(slug: string, saleId: number, currentNotes: unknown, itemName: string, qty: number): Promise<void> {
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  if (!salesTable || !(await columnExists(salesTable.name, "notes"))) return;
  const notes = String(currentNotes ?? "");
  if (!notes.trim()) return;
  const lines = notes.split(/\r\n|\r|\n/);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const wantName = norm(itemName);
  const wantQty = Math.max(1, Math.round(qty));
  let bestIdx = -1;
  let bestScore = -1;
  lines.forEach((ln, idx) => {
    const m = ln.trim().match(/^\[PREORDINE\s+RITIRATO\s+[\d-]+\s+[\d:]+\]\s*(.+)$/i);
    if (!m) return;
    let rest = m[1].trim();
    let markerQty = 1;
    const q = rest.match(/^(.*?)\s*x\s*(\d+)(?:\s*[•\-]\s*(.+))?$/i);
    if (q) {
      rest = q[1].trim();
      markerQty = Math.max(1, Number(q[2]) || 1);
    } else {
      const op = rest.match(/^(.*?)\s*[•\-]\s*(.+)$/);
      if (op) rest = op[1].trim();
    }
    const markerName = norm(rest);
    if (!markerName || !wantName) return;
    let score = 0;
    if (markerName === wantName) score += 100;
    else if (markerName.includes(wantName) || wantName.includes(markerName)) score += 45;
    else return;
    if (markerQty === wantQty) score += 30;
    else if (Math.abs(markerQty - wantQty) === 1) score += 5;
    if (score > bestScore) { bestScore = score; bestIdx = idx; }
  });
  if (bestIdx < 0 || bestScore < 60) return;
  lines.splice(bestIdx, 1);
  const next = lines.join("\n").trim();
  if (next !== notes.trim()) await tenantUpdate({ slug, table: "sales", id: saleId, values: { notes: next } });
}

// Best-effort stock document for a pickup or its undo. Inserts a stock_docs header
// (cause='scarico' for a pickup, 'carico' for the compensating undo) + one stock_doc_items
// line. A no-op (swallowed) when the optional stock-doc tables are absent.
async function recordPickupStockDoc(
  slug: string,
  input: { saleId: number; productId: number; qty: number; locationId: number; note: string; operatorName: string; operatorUserId: number | null; cause?: "scarico" | "carico" },
): Promise<void> {
  try {
    const docsTable = await tenantTable(slug, "stock_docs").catch(() => null);
    const docItemsTable = await tenantTable(slug, "stock_doc_items").catch(() => null);
    if (!docsTable || !docItemsTable) return;
    const today = todayIso();
    const docId = await tenantInsert(docsTable, await filterColumns(docsTable.name, {
      move_date: today,
      operator_user_id: input.operatorUserId,
      operator_name: clean(input.operatorName, 120) || "Operatore",
      cause: input.cause ?? "scarico",
      location_id: input.locationId > 0 ? input.locationId : null,
      notes: clean(input.note, 500),
      is_canceled: 0,
    }));
    if (docId > 0) {
      await tenantInsert(docItemsTable, await filterColumns(docItemsTable.name, {
        stock_doc_id: docId,
        product_id: input.productId,
        qty: input.qty,
        incoming_flag: 0,
        incoming_qty: 0,
        incoming_eta: null,
      }));
    }
  } catch {
    // Optional stock-doc tables can be absent in older installs — the status flip + stock
    // decrement still happen; only the audit document is skipped.
  }
}

async function listPosSales(slug: string, options: { locationId: number; includeCancelled: boolean; query: string }): Promise<PosSale[]> {
  const salesTable = await tenantTable(slug, "sales");
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (salesTable.mode === "shared" && await columnExists(salesTable.name, "tenant_id")) {
    clauses.push("s.tenant_id=?");
    params.push(salesTable.tenantId ?? 0);
  }
  if (options.locationId > 0 && await columnExists(salesTable.name, "location_id")) {
    clauses.push("(s.location_id IS NULL OR s.location_id=?)");
    params.push(options.locationId);
  }
  if (!options.includeCancelled) clauses.push("LOWER(COALESCE(s.status,'')) NOT IN ('cancelled','canceled','annullata','annullato')");
  const query = clean(options.query, 120).toLowerCase();
  if (query) {
    clauses.push("(LOWER(COALESCE(c.full_name,'')) LIKE ? OR LOWER(COALESCE(s.notes,'')) LIKE ? OR CAST(s.id AS TEXT) LIKE ?)");
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=s.client_id${clientsTable.mode === "shared" && await columnExists(clientsTable.name, "tenant_id") ? " AND c.tenant_id=s.tenant_id" : ""}`
    : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.*, c.full_name AS client_name
       FROM ${quoteIdentifier(salesTable.name)} s
       ${clientJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT 250`,
    params,
  );
  return Promise.all(rows.map((row) => mapSale(slug, row)));
}

// Build the unified "Movimenti" list (port of pos_history.php's $events): the sales already
// fetched for the context, PLUS standalone recharges + giftbox instances + giftcards that were
// NOT created through a POS sale (a sale-linked one is already represented by its sale row and
// is deduped out here). Newest-first, capped at 200. Each sale carries the composite type label
// + content flags the sidebar filters use; the standalone rows are location-scoped like sales.
async function buildPosMovements(
  slug: string,
  sales: PosSale[],
  ctx: { locationId: number },
): Promise<PosMovement[]> {
  const movements: PosMovement[] = sales.map((sale) => saleToMovement(sale));

  const standalone = await listPosStandaloneMovements(slug, ctx.locationId).catch(() => [] as PosMovement[]);
  movements.push(...standalone);

  // Newest-first by date (fallback to id), then cap at 200 (faithful to the legacy usort + slice).
  movements.sort((a, b) => {
    const cmp = movementTimestamp(b.date) - movementTimestamp(a.date);
    if (cmp !== 0) return cmp;
    return b.id - a.id;
  });
  return movements.slice(0, POS_MOVEMENTS_LIMIT);
}

const POS_MOVEMENTS_LIMIT = 200;

function movementTimestamp(date: string): number {
  if (!date) return 0;
  const parsed = Date.parse(date.includes("T") ? date : date.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Derive a sale MOVEMENT row from an already-mapped PosSale. The composite type label mirrors
// pos_history.php (~2374-2378): "Vendita (GiftCard, GiftBox, Ricarica)" listing whichever of
// those line kinds the sale contains, in that fixed order; otherwise plain "Vendita". The
// content flags power the sidebar Servizi/Prodotti/Pacchetti + Tipologia filters.
function saleToMovement(sale: PosSale): PosMovement {
  const hasGiftcardLine = sale.items.some((item) => item.type === "giftcard" || /giftcard/i.test(item.name));
  const hasGiftboxLine = sale.items.some((item) => item.type === "giftbox" || /giftbox/i.test(item.name));
  const hasRechargeLine = sale.items.some((item) => item.type === "recharge" || /ricarica/i.test(item.name));
  const giftLabels: string[] = [];
  if (hasGiftcardLine) giftLabels.push("GiftCard");
  if (hasGiftboxLine) giftLabels.push("GiftBox");
  if (hasRechargeLine) giftLabels.push("Ricarica");
  const kindLabel = giftLabels.length ? `Vendita (${giftLabels.join(", ")})` : "Vendita";

  const serviceIds = sale.items.filter((item) => item.type === "service" && item.refId > 0).map((item) => item.refId);
  const productIds = sale.items.filter((item) => item.type === "product" && item.refId > 0).map((item) => item.refId);

  return {
    kind: "sale",
    kindLabel,
    id: sale.id,
    saleNumber: sale.id,
    numberLabel: "",
    locationId: sale.locationId,
    clientId: sale.clientId,
    clientName: sale.clientName || "—",
    amount: sale.total,
    status: sale.status === "cancelled" ? "Annullata" : "Attiva",
    operator: sale.operatorName || "",
    date: sale.createdAt,
    hasService: sale.items.some((item) => item.type === "service"),
    hasProduct: sale.items.some((item) => item.type === "product"),
    hasPackage: sale.items.some((item) => item.type === "package"),
    serviceIds,
    productIds,
    hasGiftcardLine,
    hasGiftboxLine,
    hasRechargeLine,
  };
}

// The 3 STANDALONE movement sources (port of pos_history.php sections 2-4): recharges NOT tied
// to a sale, and giftbox/giftcard vouchers NOT issued by a sale (deduped via the same linkage
// the sale rows already represent). Location-scoped like the sales query. Every read is
// best-effort — a missing table/column simply yields no rows of that kind.
async function listPosStandaloneMovements(slug: string, locationId: number): Promise<PosMovement[]> {
  const [recharges, giftboxes, giftcards] = await Promise.all([
    listStandaloneRecharges(slug, locationId).catch(() => [] as PosMovement[]),
    listStandaloneGiftboxes(slug, locationId).catch(() => [] as PosMovement[]),
    listStandaloneGiftcards(slug, locationId).catch(() => [] as PosMovement[]),
  ]);
  return [...recharges, ...giftboxes, ...giftcards];
}

// Standalone RECHARGES (pos_history.php section 2, ~2455-2524): a recharge row with no sale_id
// (a sale-linked one is already shown as its sale). Row label "R#id", "Apri" -> credit movements.
async function listStandaloneRecharges(slug: string, locationId: number): Promise<PosMovement[]> {
  const table = await tenantTable(slug, "recharges").catch(() => null);
  if (!table) return [];
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("r.tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  if (locationId > 0 && await columnExists(table.name, "location_id")) {
    clauses.push("(r.location_id IS NULL OR r.location_id=?)");
    params.push(locationId);
  }
  if (await columnExists(table.name, "sale_id")) clauses.push("(r.sale_id IS NULL OR r.sale_id<=0)");
  const hasVoid = await columnExists(table.name, "is_void");
  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=r.client_id${clientsTable.mode === "shared" && await columnExists(clientsTable.name, "tenant_id") ? " AND c.tenant_id=r.tenant_id" : ""}`
    : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT r.id, r.client_id, r.total_amount AS amount, r.created_at AS dt, r.note,
            ${await columnExists(table.name, "location_id") ? "r.location_id" : "NULL"} AS location_id,
            ${hasVoid ? "r.is_void" : "0"} AS is_void,
            ${await columnExists(table.name, "created_by") ? "r.created_by" : "0"} AS created_by,
            c.full_name AS client_name
       FROM ${quoteIdentifier(table.name)} r
       ${clientJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY r.id DESC
      LIMIT ${POS_MOVEMENTS_LIMIT}`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return Promise.all(rows.map(async (row): Promise<PosMovement> => {
    const id = Number(row.id ?? 0) || 0;
    return {
      kind: "recharge",
      kindLabel: "Ricarica",
      id,
      saleNumber: 0,
      numberLabel: `R#${id}`,
      locationId: Number(row.location_id ?? 0) || 0,
      clientId: Number(row.client_id ?? 0) || 0,
      clientName: clean(row.client_name, 190) || "—",
      amount: roundMoney(Number(row.amount ?? 0) || 0),
      status: Number(row.is_void ?? 0) ? "Stornata" : "Attiva",
      operator: await movementOperator(slug, row),
      date: dateTimeString(row.dt),
      hasService: false,
      hasProduct: false,
      hasPackage: false,
      serviceIds: [],
      productIds: [],
      hasGiftcardLine: false,
      hasGiftboxLine: false,
      hasRechargeLine: true,
    };
  }));
}

// Standalone GIFTBOX instances (pos_history.php section 3, ~2526-2669): a giftbox_instances row
// NOT already shown by a sale (a sale-issued box has a sale_items line containing its code).
async function listStandaloneGiftboxes(slug: string, locationId: number): Promise<PosMovement[]> {
  const table = await tenantTable(slug, "giftbox_instances").catch(() => null);
  if (!table) return [];
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const saleItemsTable = await tenantTable(slug, "sale_items").catch(() => null);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("gi.tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  if (locationId > 0 && await columnExists(table.name, "location_id")) {
    clauses.push("(gi.location_id IS NULL OR gi.location_id=?)");
    params.push(locationId);
  }
  // Dedupe: hide a giftbox already shown by the sale that issued it (sale_items line w/ its code).
  if (saleItemsTable && await columnExists(saleItemsTable.name, "item_name")) {
    const tenantClause = saleItemsTable.mode === "shared" && await columnExists(saleItemsTable.name, "tenant_id") ? " AND si.tenant_id=gi.tenant_id" : "";
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(saleItemsTable.name)} si WHERE si.item_name LIKE '%' || gi.code || '%'${tenantClause})`);
  }
  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=gi.client_id${clientsTable.mode === "shared" && await columnExists(clientsTable.name, "tenant_id") ? " AND c.tenant_id=gi.tenant_id" : ""}`
    : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT gi.id, gi.client_id, gi.status, gi.issued_at AS dt,
            ${await columnExists(table.name, "location_id") ? "gi.location_id" : "NULL"} AS location_id,
            ${await columnExists(table.name, "created_by") ? "gi.created_by" : "0"} AS created_by,
            c.full_name AS client_name
       FROM ${quoteIdentifier(table.name)} gi
       ${clientJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY gi.id DESC
      LIMIT ${POS_MOVEMENTS_LIMIT}`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return Promise.all(rows.map(async (row) => voucherMovement(slug, row, "giftbox", "GiftBox")));
}

// Standalone GIFTCARDS (pos_history.php section 4, ~2671-2746): a giftcards row NOT already
// shown by the sale that issued it (sale_items line w/ its code). Amount = initial_amount.
async function listStandaloneGiftcards(slug: string, locationId: number): Promise<PosMovement[]> {
  const table = await tenantTable(slug, "giftcards").catch(() => null);
  if (!table) return [];
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const saleItemsTable = await tenantTable(slug, "sale_items").catch(() => null);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("gc.tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  if (locationId > 0 && await columnExists(table.name, "location_id")) {
    clauses.push("(gc.location_id IS NULL OR gc.location_id=?)");
    params.push(locationId);
  }
  if (saleItemsTable && await columnExists(saleItemsTable.name, "item_name")) {
    const tenantClause = saleItemsTable.mode === "shared" && await columnExists(saleItemsTable.name, "tenant_id") ? " AND si.tenant_id=gc.tenant_id" : "";
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(saleItemsTable.name)} si WHERE si.item_name LIKE '%' || gc.code || '%'${tenantClause})`);
  }
  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=gc.client_id${clientsTable.mode === "shared" && await columnExists(clientsTable.name, "tenant_id") ? " AND c.tenant_id=gc.tenant_id" : ""}`
    : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT gc.id, gc.client_id, gc.initial_amount AS amount, gc.status, gc.issued_at AS dt,
            ${await columnExists(table.name, "location_id") ? "gc.location_id" : "NULL"} AS location_id,
            ${await columnExists(table.name, "created_by") ? "gc.created_by" : "0"} AS created_by,
            c.full_name AS client_name
       FROM ${quoteIdentifier(table.name)} gc
       ${clientJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY gc.id DESC
      LIMIT ${POS_MOVEMENTS_LIMIT}`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return Promise.all(rows.map(async (row) => voucherMovement(slug, row, "giftcard", "GiftCard", roundMoney(Number(row.amount ?? 0) || 0))));
}

// Build a giftbox/giftcard MOVEMENT row (both are "Voucher"-kind rows with the raw table status).
async function voucherMovement(
  slug: string,
  row: RowDataPacket,
  kind: "giftbox" | "giftcard",
  kindLabel: string,
  amount: number | null = null,
): Promise<PosMovement> {
  return {
    kind,
    kindLabel,
    id: Number(row.id ?? 0) || 0,
    saleNumber: 0,
    numberLabel: "",
    locationId: Number(row.location_id ?? 0) || 0,
    clientId: Number(row.client_id ?? 0) || 0,
    clientName: clean(row.client_name, 190) || "—",
    amount,
    status: clean(row.status, 40),
    operator: await movementOperator(slug, row),
    date: dateTimeString(row.dt),
    hasService: false,
    hasProduct: false,
    hasPackage: false,
    serviceIds: [],
    productIds: [],
    hasGiftcardLine: kind === "giftcard",
    hasGiftboxLine: kind === "giftbox",
    hasRechargeLine: false,
  };
}

// Operator display for a standalone movement (faithful to _pos_hist_operator_display): the
// row has no operator_name, so resolve the users lookup for created_by. "" when unresolved.
async function movementOperator(slug: string, row: RowDataPacket): Promise<string> {
  return (await operatorNameFromUserId(slug, Number(row.created_by ?? 0))) || "";
}

async function listPosClients(slug: string): Promise<ManagedClient[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", orderBy: "full_name ASC, id ASC", limit: 500 }).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.full_name ?? row.name ?? "Cliente"),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    lastVisit: "",
    value: "0 euro",
    next: "",
    note: String(row.notes ?? ""),
    locationId: Number(row.location_id ?? 0),
    tags: [],
    archived: Number(row.is_blocked ?? 0) === 1,
    createdAt: dateTimeString(row.created_at ?? row.registration_date),
    updatedAt: dateTimeString(row.updated_at),
  }));
}

async function listPosServices(slug: string, locationId: number): Promise<ManagedService[]> {
  const servicesTable = await tenantTable(slug, "services");
  const clauses = ["COALESCE(s.is_active,1)=1"];
  const params: unknown[] = [];
  if (servicesTable.mode === "shared" && await columnExists(servicesTable.name, "tenant_id")) {
    clauses.unshift("s.tenant_id=?");
    params.unshift(servicesTable.tenantId ?? 0);
  }
  const locationFilter = await serviceLocationFilter(slug, locationId);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.*
       FROM ${quoteIdentifier(servicesTable.name)} s
      WHERE ${clauses.join(" AND ")}
        ${locationFilter.sql}
      ORDER BY COALESCE(s.sort_order,999999) ASC, s.name ASC, s.id ASC`,
    [...params, ...locationFilter.params],
  );
  const locationMap = await serviceLocationMap(slug, rows.map((row) => Number(row.id ?? 0)));
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Servizio"),
    duration: `${Number(row.duration_min ?? 60) || 60} min`,
    price: `${formatMoney(Number(row.price ?? 0) || 0)} euro`,
    category: "Servizi",
    demand: "",
    color: "#0f766e",
    description: "",
    locationIds: locationMap.get(Number(row.id ?? 0)) ?? [],
    active: Number(row.is_active ?? 1) === 1,
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
    createdAt: dateTimeString(row.created_at),
    updatedAt: dateTimeString(row.updated_at),
  }));
}

async function listPosProducts(slug: string, locationId: number): Promise<ManagedProduct[]> {
  const productsTable = await tenantTable(slug, "products");
  const stockTable = locationId > 0 ? await tenantTable(slug, "product_stocks").catch(() => null) : null;
  const clauses = ["COALESCE(p.is_active,1)=1"];
  const params: unknown[] = [];
  const joinParams: unknown[] = [];
  if (productsTable.mode === "shared" && await columnExists(productsTable.name, "tenant_id")) {
    clauses.unshift("p.tenant_id=?");
    params.unshift(productsTable.tenantId ?? 0);
  }
  let stockJoin = "";
  let stockColumn = "p.stock";
  if (stockTable && locationId > 0) {
    const tenantJoin = stockTable.mode === "shared" && await columnExists(stockTable.name, "tenant_id") ? " AND ps.tenant_id=p.tenant_id" : "";
    stockJoin = `LEFT JOIN ${quoteIdentifier(stockTable.name)} ps ON ps.product_id=p.id AND ps.location_id=?${tenantJoin}`;
    joinParams.push(locationId);
    stockColumn = "COALESCE(ps.stock,p.stock)";
    clauses.push(`(COALESCE(ps.is_enabled,0)=1 OR NOT EXISTS(SELECT 1 FROM ${quoteIdentifier(stockTable.name)} ps_any WHERE ps_any.product_id=p.id${tenantJoin.replaceAll("ps.", "ps_any.")}))`);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT p.*, ${stockColumn} AS scoped_stock
       FROM ${quoteIdentifier(productsTable.name)} p
       ${stockJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(p.category_id,999999) ASC, p.name ASC, p.id ASC`,
    [...joinParams, ...params],
  );
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: productDisplayName(String(row.name ?? "Prodotto"), String(row.sku ?? "")),
    category: "Prodotti",
    brand: String(row.brand ?? ""),
    price: `${formatMoney(Number(row.price ?? 0) || 0)} euro`,
    image: "",
    sku: String(row.sku ?? ""),
    stock: Number(row.scoped_stock ?? row.stock ?? 0) || 0,
    minStock: Number(row.min_stock ?? 0) || 0,
    locationId,
    publicVisible: Number(row.sell_online ?? 0) === 1,
    movements: [],
    createdAt: dateTimeString(row.created_at),
    updatedAt: dateTimeString(row.updated_at),
  }));
}

// Sellable PACKAGE templates for the POS, port of the pos.php $packages query
// (SELECT id, name, price, sessions_total, validity_days FROM packages WHERE is_active=1),
// location-filtered like services via package_locations. The total `sessions` is resolved
// the same way the legacy issue logic does (package_services -> package_items(service) ->
// packages.sessions_total), so the issued client_packages row gets the right session count.
async function listPosPackages(slug: string, locationId: number): Promise<SellablePackage[]> {
  const packagesTable = await tenantTable(slug, "packages").catch(() => null);
  if (!packagesTable) return [];
  const clauses = ["COALESCE(p.is_active,1)=1"];
  const params: unknown[] = [];
  if (packagesTable.mode === "shared" && await columnExists(packagesTable.name, "tenant_id")) {
    clauses.unshift("p.tenant_id=?");
    params.unshift(packagesTable.tenantId ?? 0);
  }
  const locationFilter = await packageLocationFilter(slug, locationId);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT p.*
       FROM ${quoteIdentifier(packagesTable.name)} p
      WHERE ${clauses.join(" AND ")}
        ${locationFilter.sql}
      ORDER BY p.name ASC, p.id ASC`,
    [...params, ...locationFilter.params],
  ).catch(() => [] as RowDataPacket[]);
  return Promise.all(
    rows.map(async (row) => {
      const id = Number(row.id ?? 0);
      return {
        id,
        name: String(row.name ?? "Pacchetto"),
        price: roundMoney(Number(row.price ?? 0) || 0),
        sessions: await packageSessionsTotal(slug, id, row),
        validityDays: Math.max(0, Number(row.validity_days ?? 0) || 0),
      };
    }),
  );
}

// The total sessions a package grants, resolved exactly like the legacy issue logic:
// sum of package_services.sessions_total, else sum of package_items(item_type='service')
// qty, else packages.sessions_total (min 1). This becomes client_packages.sessions_total.
async function packageSessionsTotal(slug: string, packageId: number, packageRow?: RowDataPacket): Promise<number> {
  if (packageId > 0) {
    const serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "package_services",
      columns: "sessions_total",
      where: "package_id=?",
      params: [packageId],
    }).catch(() => [] as RowDataPacket[]);
    if (serviceRows.length) {
      const sum = serviceRows.reduce((total, r) => total + Math.max(1, Number(r.sessions_total ?? 1) || 1), 0);
      if (sum > 0) return sum;
    }
    const itemRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "package_items",
      columns: "qty",
      where: "package_id=? AND LOWER(COALESCE(item_type,''))='service'",
      params: [packageId],
    }).catch(() => [] as RowDataPacket[]);
    if (itemRows.length) {
      const sum = itemRows.reduce((total, r) => total + Math.max(1, Number(r.qty ?? 1) || 1), 0);
      if (sum > 0) return sum;
    }
  }
  const fallback = Number(packageRow?.sessions_total ?? 1) || 1;
  return Math.max(1, fallback);
}

async function packageLocationFilter(slug: string, locationId: number): Promise<{ sql: string; params: unknown[] }> {
  if (locationId <= 0) return { sql: "", params: [] };
  const table = await tenantTable(slug, "package_locations").catch(() => null);
  if (!table) return { sql: "", params: [] };
  const tenantClause = table.mode === "shared" && await columnExists(table.name, "tenant_id") ? " AND pl.tenant_id=p.tenant_id" : "";
  return {
    sql: `AND (EXISTS(SELECT 1 FROM ${quoteIdentifier(table.name)} pl WHERE pl.package_id=p.id AND pl.location_id=?${tenantClause}) OR NOT EXISTS(SELECT 1 FROM ${quoteIdentifier(table.name)} pl_any WHERE pl_any.package_id=p.id${tenantClause.replaceAll("pl.", "pl_any.")}))`,
    params: [locationId],
  };
}

// Sellable GIFTBOX templates for the POS "Emetti GiftBox" modal — port of the GiftBox
// catalog (SELECT id, name, active, valid_from/valid_to/expires_after_days FROM giftboxes
// WHERE active=1 AND deleted_at IS NULL). Each template's contents are read from giftbox_items
// (item_type/service_id/product_id/qty/custom_label), so issueGiftboxFromSale can copy each
// into giftbox_instance_items. There is NO giftbox_locations table (only services/products are
// location-filtered, enforced per-item at issue time), so the catalog is not location-filtered
// here; `locationId` is accepted for signature parity with listPosPackages. Tolerates the
// giftbox tables being absent (-> empty list). The price is staff-entered in the modal (the
// giftboxes table has no price column), so `price` is 0 here.
async function listPosGiftboxes(slug: string, locationId: number): Promise<SellableGiftbox[]> {
  void locationId;
  const giftboxesTable = await tenantTable(slug, "giftboxes").catch(() => null);
  if (!giftboxesTable) return [];
  const clauses = ["COALESCE(g.active,1)=1"];
  const params: unknown[] = [];
  if (giftboxesTable.mode === "shared" && await columnExists(giftboxesTable.name, "tenant_id")) {
    clauses.unshift("g.tenant_id=?");
    params.unshift(giftboxesTable.tenantId ?? 0);
  }
  if (await columnExists(giftboxesTable.name, "deleted_at")) clauses.push("g.deleted_at IS NULL");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT g.*
       FROM ${quoteIdentifier(giftboxesTable.name)} g
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(g.sort_order,0) ASC, g.name ASC, g.id ASC`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return Promise.all(
    rows.map(async (row) => {
      const id = Number(row.id ?? 0);
      return {
        id,
        name: String(row.name ?? "GiftBox"),
        // No price column on giftboxes — the staff enters the SALE price in the modal.
        price: 0,
        // Validity days for the proposed expiry: the template's expires_after_days, else 0
        // (the issuer then falls back to the settings default or +180d).
        validityDays: Math.max(0, Number(row.expires_after_days ?? 0) || 0),
        items: await giftboxTemplateItems(slug, id),
      };
    }),
  );
}

// The content rows of a giftbox TEMPLATE (giftbox_items WHERE giftbox_id=?), normalized for
// the catalog + for issueGiftboxFromSale to copy into giftbox_instance_items. Preserves the
// template item id (giftbox_items.id), kind, service/product, qty + label. Tolerates the
// table being absent (-> empty list).
async function giftboxTemplateItems(slug: string, giftboxId: number): Promise<SellableGiftboxItem[]> {
  if (giftboxId <= 0) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_items",
    columns: "id, item_type, service_id, product_id, qty, custom_label",
    where: "giftbox_id=?",
    params: [giftboxId],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => {
    const rawType = String(row.item_type ?? "service").toLowerCase();
    const itemType: SellableGiftboxItem["itemType"] = rawType === "product" ? "product" : rawType === "custom" ? "custom" : "service";
    return {
      giftboxItemId: Number(row.id ?? 0) || 0,
      itemType,
      serviceId: Number(row.service_id ?? 0) || 0,
      productId: Number(row.product_id ?? 0) || 0,
      qty: Math.max(1, Number(row.qty ?? 1) || 1),
      label: String(row.custom_label ?? ""),
    };
  });
}

// Sellable RECHARGE templates for the POS "Ricarica credito" modal — port of the
// recharge_templates catalog the legacy modal precompiles from (SELECT id, title,
// base_amount, bonus_kind, bonus_value, earn_points FROM recharge_templates WHERE
// is_active=1 ORDER BY sort_order, title). The bonus is computed exactly like
// recharges-content.tsx (percent: base*value/100, fixed: value, none: 0). There is no
// recharge_locations table, so the catalog is not location-filtered. Tolerates the table
// being absent (-> empty list).
async function listPosRechargeTemplates(slug: string): Promise<SellableRecharge[]> {
  const table = await tenantTable(slug, "recharge_templates").catch(() => null);
  if (!table) return [];
  const clauses = ["COALESCE(t.is_active,1)=1"];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("t.tenant_id=?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT t.*
       FROM ${quoteIdentifier(table.name)} t
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(t.sort_order,0) ASC, t.title ASC, t.id ASC`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => {
    const baseAmount = roundMoney(Math.max(0, Number(row.base_amount ?? 0) || 0));
    const bonusKind = normalizeBonusKind(row.bonus_kind);
    const bonusValue = roundMoney(Math.max(0, Number(row.bonus_value ?? 0) || 0));
    return {
      id: Number(row.id ?? 0) || 0,
      title: String(row.title ?? "Ricarica"),
      baseAmount,
      bonusKind,
      bonusValue,
      bonusAmount: rechargeBonusAmount(baseAmount, bonusKind, bonusValue),
      earnPoints: Number(row.earn_points ?? 1) === 1,
    };
  });
}

// The € bonus credit for a recharge — faithful to recharges-content.tsx bonusAmount():
// percent -> base*value/100, fixed -> value, none/other -> 0. Always >= 0, money-rounded.
function rechargeBonusAmount(baseAmount: number, bonusKind: string, bonusValue: number): number {
  const base = Math.max(0, Number(baseAmount) || 0);
  const value = Math.max(0, Number(bonusValue) || 0);
  if (bonusKind === "percent") return roundMoney((base * value) / 100);
  if (bonusKind === "fixed") return roundMoney(value);
  return 0;
}

// Clamp a bonus kind to the schema's CHECK ('none','percent','fixed'), defaulting to 'none'.
function normalizeBonusKind(value: unknown): string {
  const kind = String(value ?? "none").toLowerCase();
  return kind === "percent" || kind === "fixed" ? kind : "none";
}

async function mapSale(slug: string, row: RowDataPacket): Promise<PosSale> {
  const id = Number(row.id ?? 0);
  const items = await saleItems(slug, id);
  const total = roundMoney(Number(row.total ?? 0) || 0);
  const payments = derivePayments(row, total);
  const paidAmount = roundMoney(payments.reduce((sum, payment) => sum + payment.amount, 0));
  // Operator display (faithful to _pos_hist_operator_display): sales.operator_name, else the
  // users lookup for sales.created_by. Left "" when neither resolves (rendered as "—").
  const operatorName = clean(row.operator_name, 120) || (await operatorNameFromUserId(slug, Number(row.created_by ?? 0))) || "";
  return {
    id,
    code: `S-${String(id).padStart(5, "0")}`,
    clientId: Number(row.client_id ?? 0) || 0,
    clientName: String(row.client_name ?? "") || await clientName(slug, Number(row.client_id ?? 0)),
    locationId: Number(row.location_id ?? 0) || 0,
    operatorName,
    items,
    payments,
    subtotal: roundMoney(Number(row.subtotal ?? total) || 0),
    discount: roundMoney(Number(row.discount ?? 0) || 0),
    total,
    paidAmount,
    changeDue: roundMoney(Math.max(0, paidAmount - total)),
    status: isCancelledStatus(row.status) ? "cancelled" : "active",
    createdAt: dateTimeString(row.sale_date ?? row.created_at),
    cancelledAt: row.cancelled_at ? dateTimeString(row.cancelled_at) : undefined,
    cancelReason: row.cancelled_reason ? String(row.cancelled_reason) : undefined,
  };
}

async function saleItems(slug: string, saleId: number): Promise<PosSaleItem[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_items",
    where: "sale_id=?",
    params: [saleId],
    orderBy: "id ASC",
  }).catch(() => []);
  return rows.map((row) => {
    const type = normalizeStoredItemType(row.item_type);
    return {
      id: Number(row.id ?? 0),
      type,
      refId: Number(row.item_id ?? 0) || 0,
      name: String(row.item_name ?? "Voce"),
      quantity: Number(row.qty ?? 1) || 1,
      unitPrice: roundMoney(Number(row.unit_price ?? 0) || 0),
      total: roundMoney(Number(row.line_total ?? 0) || 0),
      status: normalizeItemStatus(type, row.item_status, true),
    };
  });
}

// Regole di esclusività del carrello + divieti pagamento sulle ricariche — port
// of pos.php ~3327-3415 (esclusività), 3502/3755 (max 1 GiftCard/ricarica),
// 3966-3999 (divieti tender/sconti su ricariche) e 4645 (niente rate). Messaggi
// legacy esatti. La GiftBox nel Next è una RIGA (il legacy la modella come draft
// che avvolge il carrello), quindi: GiftBox+ricarica e GiftBox+GiftCard vietate
// con i messaggi dedicati; una GiftBox in carrello ESONERA dalla selezione
// cliente (come il giftbox_draft legacy — il destinatario viaggia sulla riga).
function assertCartExclusivityRules(items: PosSaleItem[], clientId: number, input: PosCheckoutInput): void {
  const giftcards = items.filter((it) => it.type === "giftcard").length;
  const recharges = items.filter((it) => it.type === "recharge").length;
  const giftboxes = items.filter((it) => it.type === "giftbox").length;
  const hasServiceProductRecharge = items.some((it) => it.type === "service" || it.type === "product" || it.type === "recharge" || it.type === "prepaid");
  const hasPackage = items.some((it) => it.type === "package");
  const hasNonRechargeItems = items.some((it) => it.type !== "recharge" && it.type !== "giftbox");
  const hasOtherThanGiftcard = items.some((it) => it.type !== "giftcard" && it.type !== "giftbox");

  if (giftcards > 1) throw new Error("Puoi inserire una sola GiftCard per vendita. Modifica la GiftCard già presente oppure rimuovila.");
  if (recharges > 1) throw new Error("Puoi inserire una sola ricarica per vendita. Modifica la ricarica già presente oppure rimuovila.");

  if (recharges > 0 && hasNonRechargeItems) {
    throw new Error("Una vendita con ricariche non può contenere altri elementi (servizi, prodotti, pacchetti, GiftCard). Effettua una vendita separata.");
  }

  if (giftcards > 0) {
    if (clientId <= 0) throw new Error("Seleziona un mittente per emettere una GiftCard.");
    if (hasOtherThanGiftcard) {
      throw new Error("Una vendita con GiftCard non può contenere altri elementi (servizi, prodotti, pacchetti, ricariche). Effettua due vendite separate.");
    }
    if (giftboxes > 0) {
      throw new Error("GiftCard e GiftBox non possono essere abbinate nella stessa vendita. Elimina la GiftBox oppure rimuovi la GiftCard.");
    }
  }

  if (giftboxes > 0 && recharges > 0) {
    throw new Error("GiftBox e Ricariche non possono essere abbinate nella stessa vendita. Elimina la GiftBox oppure rimuovi la ricarica.");
  }

  // Cliente obbligatorio per servizi/prodotti/ricariche/pacchetti (senza GiftBox).
  if (clientId <= 0 && (hasServiceProductRecharge || hasPackage) && giftboxes === 0) {
    throw new Error("Seleziona un cliente per concludere la vendita.");
  }

  // Divieti sulla vendita-ricarica: nessun tender residui, sconti o rate.
  if (recharges > 0) {
    const tender = (method: string) => (input.payments ?? []).reduce((sum, p) => sum + (String(p.method) === method ? Math.max(0, Number(p.amount) || 0) : 0), 0);
    if (tender("wallet") > 0.00001) {
      throw new Error("Non è possibile usare il credito per pagare una ricarica credito in carrello. Disattiva l'uso credito oppure rimuovi la ricarica.");
    }
    if (tender("giftcard") > 0.00001) {
      throw new Error("Non è possibile usare una GiftCard per pagare una ricarica credito in carrello. Disattiva l'uso GiftCard oppure rimuovi la ricarica.");
    }
    if (clean(input.couponCode, 40) || (input.promotionId ?? 0) > 0) {
      throw new Error("Coupon, buoni e promozioni non possono essere applicati a una ricarica credito. Rimuovi lo sconto oppure effettua una vendita separata.");
    }
    if ((input.discount ?? 0) > 0.00001) {
      throw new Error("Lo sconto manuale non può essere applicato a una ricarica credito.");
    }
    if ((input.fidelityPointsUse ?? 0) > 0.00001) {
      throw new Error("I punti Fidelity non possono essere usati per pagare una ricarica credito.");
    }
    if (input.installmentPlan) {
      throw new Error("Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.");
    }
  }
}

async function buildSaleItems(slug: string, inputItems: PosSaleItemInput[], locationId: number, hasClient: boolean): Promise<PosSaleItem[]> {
  const items: PosSaleItem[] = [];
  for (const [index, input] of inputItems.entries()) {
    const quantity = Math.max(1, Math.round(Number(input.quantity ?? 1) || 1));
    const refId = Number(input.refId ?? 0) || 0;
    if (input.type === "service") {
      const service = refId > 0 ? await serviceRow(slug, refId) : null;
      if (service && !await serviceAvailableAtLocation(slug, refId, locationId)) throw new Error("Servizio non disponibile nella sede selezionata.");
      const unitPrice = roundMoney(input.unitPrice ?? Number(service?.price ?? 0) ?? 0);
      items.push({
        id: index + 1,
        type: "service",
        refId: service ? Number(service.id) : refId,
        name: input.name?.trim() || String(service?.name ?? "Servizio"),
        quantity,
        unitPrice,
        total: roundMoney(unitPrice * quantity),
        status: normalizeItemStatus("service", input.status, hasClient),
      });
      continue;
    }
    if (input.type === "product") {
      const product = refId > 0 ? await productRow(slug, refId) : null;
      if (product && !await productAvailableAtLocation(slug, refId, locationId)) throw new Error("Prodotto non disponibile nella sede selezionata.");
      const unitPrice = roundMoney(input.unitPrice ?? Number(product?.price ?? 0) ?? 0);
      items.push({
        id: index + 1,
        type: "product",
        refId: product ? Number(product.id) : refId,
        name: input.name?.trim() || productDisplayName(String(product?.name ?? "Prodotto"), String(product?.sku ?? "")),
        quantity,
        unitPrice,
        total: roundMoney(unitPrice * quantity),
        status: normalizeItemStatus("product", input.status, hasClient),
      });
      continue;
    }

    // Special line types (package / prepaid / giftcard / giftbox). For a PACKAGE the cart
    // line is a single unit at the package price (faithful to pos.php pkAddRowToCart: qty
    // is fixed to 1, the line price is the bundle price); the validity/expiry/note ride on
    // the line meta and the issued sessions are read from the package template, NOT the
    // line qty. For a PREPAID line the qty IS the purchased session count (per-session
    // unitPrice), so it flows straight into client_prepaid_services.purchased_qty.
    // A GIFTCARD line is also a single unit at the card amount (faithful to the legacy
    // issue_giftcard sale_items row: qty 1, unit_price = line_total = amount), so the sale
    // TOTAL equals the giftcard amount. The recipient/code/expiry/dedica/hide-amount ride
    // on the line meta and are read by issueGiftcardFromSale at checkout.
    // A GIFTBOX line is also a single unit at the box price (like a giftcard); the recipient
    // OWNER + expiry/event/dedica ride on the line meta and are read by issueGiftboxFromSale.
    // A RECHARGE line is also a single unit, but its price is the BASE amount (what the client
    // pays); the base/bonus/total + earn-points flag ride on the line meta and are read by
    // issueRechargeFromSale (which credits the wallet by base+bonus and earns points). The
    // bonus is free credit, so it is NEVER added to the sale line price.
    const isPackage = input.type === "package";
    const isGiftcard = input.type === "giftcard";
    const isGiftbox = input.type === "giftbox";
    const isRecharge = input.type === "recharge";
    const isVoucher = isGiftcard || isGiftbox; // shares the recipient/expiry/event/dedica meta
    const lineQty = isPackage || isVoucher || isRecharge ? 1 : quantity;
    // Recharge line price = the base amount (the client pays the base; the bonus is free). For
    // every other special line the price is the supplied unitPrice.
    const rechargeBase = isRecharge
      ? roundMoney(Math.max(0, Number(input.baseAmount ?? input.unitPrice ?? 0) || 0))
      : 0;
    const unitPrice = isRecharge ? rechargeBase : roundMoney(input.unitPrice ?? 0);
    // Recharge bonus/total: trust the client's bonus_kind/bonus_value and RECOMPUTE the bonus
    // server-side (never trust a client-sent total), then total = base + bonus.
    const rechargeBonusKind = isRecharge ? normalizeBonusKind(input.bonusKind) : "none";
    const rechargeBonusValue = isRecharge ? roundMoney(Math.max(0, Number(input.bonusValue ?? 0) || 0)) : 0;
    const rechargeBonus = isRecharge ? rechargeBonusAmount(rechargeBase, rechargeBonusKind, rechargeBonusValue) : 0;
    const rechargeTotal = isRecharge ? roundMoney(rechargeBase + rechargeBonus) : 0;
    // Nome riga nel formato legacy (autoritativo lato server, mai dalla UI):
    // "Ricarica credito[ • titolo modello]" (pos.php 5622) e "Pacchetto: nome
    // • Inizio dd/mm/YYYY - Fine dd/mm/YYYY" troncato a 190 (pos.php 5441-5445).
    // GiftCard/GiftBox ricevono il codice DOPO l'emissione (update post-issue).
    let lineName = input.name?.trim() || fallbackItemName(input.type);
    if (isRecharge) {
      const tplTitle = refId > 0 ? await rechargeTemplateTitle(slug, refId) : "";
      lineName = tplTitle ? `Ricarica credito • ${tplTitle}` : "Ricarica credito";
    } else if (isPackage) {
      const pkgRows = refId > 0
        ? await tenantSelect<RowDataPacket>({ slug, table: "packages", columns: "name", where: "id=?", params: [refId], limit: 1 }).catch(() => [] as RowDataPacket[])
        : [];
      lineName = `Pacchetto: ${clean(String(pkgRows[0]?.name ?? ""), 120) || lineName}`;
      const startLabel = italianDateLabel(input.startDate);
      const endLabel = italianDateLabel(input.expiresAt);
      if (startLabel) lineName += ` • Inizio ${startLabel}`;
      if (endLabel) lineName += ` - Fine ${endLabel}`;
      lineName = lineName.slice(0, 190);
    } else if (isGiftcard) {
      lineName = "GiftCard";
    } else if (isGiftbox) {
      lineName = "GiftBox";
    }
    items.push({
      id: index + 1,
      type: input.type,
      refId,
      name: lineName,
      quantity: lineQty,
      unitPrice,
      total: roundMoney(unitPrice * lineQty),
      // item_status solo per i prepagati (riga service+prepaid); le altre righe
      // speciali restano senza stato come gli INSERT legacy (le righe service/
      // product normali passano da normalizeItemStatus più sopra).
      status: input.type === "prepaid" ? "prepaid" : undefined,
      startDate: clean(input.startDate, 10) || undefined,
      expiresAt: clean(input.expiresAt, 10) || undefined,
      note: clean(input.note, 255) || undefined,
      recipientClientId: isVoucher ? Math.max(0, Number(input.recipientClientId ?? 0) || 0) || undefined : undefined,
      recipientName: isVoucher ? clean(input.recipientName, 120) || undefined : undefined,
      recipientEmail: isVoucher ? clean(input.recipientEmail, 190) || undefined : undefined,
      code: isGiftcard ? clean(input.code, 24).toUpperCase() || undefined : undefined,
      eventType: isVoucher ? clean(input.eventType, 40) || undefined : undefined,
      message: isVoucher ? clean(input.message, 2000) || undefined : undefined,
      hideAmount: isVoucher ? input.hideAmount === true : undefined,
      // Voucher extra meta legacy (nota interna, invio email, mostra importo).
      internalNote: isVoucher ? clean(input.internalNote, 2000) || undefined : undefined,
      sendMode: isVoucher && (input.sendMode === "none" || input.sendMode === "now" || input.sendMode === "date") ? input.sendMode : undefined,
      sendOn: isVoucher ? clean(input.sendOn, 10) || undefined : undefined,
      showAmount: isVoucher && input.showAmount !== undefined ? input.showAmount === true : undefined,
      baseAmount: isRecharge ? rechargeBase : undefined,
      bonusKind: isRecharge ? rechargeBonusKind : undefined,
      bonusValue: isRecharge ? rechargeBonusValue : undefined,
      bonusAmount: isRecharge ? rechargeBonus : undefined,
      totalAmount: isRecharge ? rechargeTotal : undefined,
      earnPoints: isRecharge ? input.earnPoints === true : undefined,
      // Custom GiftBox contents ride only on a giftbox line with NO template (refId 0). Filtered
      // to valid entries; issueGiftboxFromSale materialises a transient template from them.
      customItems: isGiftbox && refId <= 0 && Array.isArray(input.customItems) && input.customItems.length > 0
        ? input.customItems
            .map((ci) => ({ type: ci.type === "product" ? "product" as const : "service" as const, id: Math.max(0, Number(ci.id ?? 0) || 0), qty: Math.max(1, Number(ci.qty ?? 1) || 1) }))
            .filter((ci) => ci.id > 0)
        : undefined,
    });
  }
  return items.filter((item) => item.quantity > 0);
}

// Il CHECK sale_items_item_type_check ammette 'package'? Lo schema aggiornato sì
// (db/schema.sql); sulle installazioni non ancora migrate il fallback resta
// 'service' (nessuna rottura). Cache di processo: il vincolo non cambia a runtime.
let packageItemTypeAllowedCache: boolean | null = null;
async function packageItemTypeAllowed(): Promise<boolean> {
  if (packageItemTypeAllowedCache !== null) return packageItemTypeAllowedCache;
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'sale_items_item_type_check'",
  ).catch(() => [] as RowDataPacket[]);
  const def = String(rows[0]?.def ?? "");
  packageItemTypeAllowedCache = def === "" || def.includes("'package'");
  return packageItemTypeAllowedCache;
}

async function insertSaleItem(slug: string, saleId: number, item: PosSaleItem): Promise<number> {
  const table = await tenantTable(slug, "sale_items");
  // item_type/item_id fedeli agli INSERT legacy (pos.php 5145/5451/5511/5632):
  // giftcard/giftbox -> 'product' item_id NULL; ricarica -> 'product' item_id 0;
  // pacchetto -> 'package' con l'id del template (l'INTENTO legacy: il MySQL
  // non-strict troncava l'enum a '' — qui il valore è reale, gated dal CHECK);
  // prepagato -> riga 'service' con item_status prepaid.
  const storedType =
    item.type === "product" || item.type === "giftcard" || item.type === "giftbox" || item.type === "recharge"
      ? "product"
      : item.type === "package"
        ? (await packageItemTypeAllowed()) ? "package" : "service"
        : "service";
  const itemId =
    item.type === "recharge"
      ? 0
      : item.refId > 0 && (item.type === "product" || item.type === "service" || item.type === "prepaid" || item.type === "package")
        ? item.refId
        : null;
  // Scadenza ritiro preordine (pos.php:686-701 pos_insert_sale_item): per una riga
  // PRODOTTO in stato 'ordered' con la scadenza preordini attiva, snapshot di
  // preorder_expires_at (deadline di ritiro / base per l'auto-scadenza). Prima assente
  // -> i preordini non avevano scadenza. filterColumns scarta la colonna se assente.
  let preorderExpiresAt: string | null = null;
  if (item.type === "product" && String(item.status ?? "").toLowerCase() === "ordered") {
    preorderExpiresAt = await preorderExpiryForPurchaseDate(slug, todayIso()).catch(() => null);
  }
  return tenantInsert(table, await filterColumns(table.name, {
    sale_id: saleId,
    item_type: storedType,
    item_id: itemId,
    item_name: item.name,
    qty: item.quantity,
    unit_price: item.unitPrice,
    line_total: item.total,
    item_status: item.status,
    preorder_expires_at: preorderExpiresAt,
  }));
}

async function resolveSaleClient(slug: string, clientId: number, clientName?: string): Promise<{ id: number; name: string }> {
  if (clientId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id,full_name,is_blocked", where: "id=?", params: [clientId], limit: 1 });
    if (rows[0]) {
      // Legacy pos_client_selection_error (pos.php:495-512): a blocked client cannot be used
      // in Pagamenti until reactivated.
      if (Number(rows[0].is_blocked ?? 0) === 1) {
        throw new Error("Questo cliente è disattivato e non può essere utilizzato in Pagamenti o Quick Booking finché non viene riattivato.");
      }
      return { id: Number(rows[0].id ?? 0), name: String(rows[0].full_name ?? "Cliente") };
    }
    throw new Error("Cliente non valido.");
  }
  const name = clean(clientName, 190) || "Cliente banco";
  if (name === "Cliente banco") return { id: 0, name };
  const table = await tenantTable(slug, "clients");
  const id = await tenantInsert(table, await filterColumns(table.name, {
    full_name: name,
    first_name: name.split(" ")[0] ?? name,
    last_name: name.split(" ").slice(1).join(" "),
    registration_date: todayIso(),
    points: 0,
    credit_balance: 0,
    is_blocked: 0,
  }));
  return { id, name };
}

async function serviceRow(slug: string, id: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", where: "id=? AND COALESCE(is_active,1)=1", params: [id], limit: 1 });
  return rows[0] ?? null;
}

async function productRow(slug: string, id: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "products", where: "id=? AND COALESCE(is_active,1)=1", params: [id], limit: 1 });
  return rows[0] ?? null;
}

async function getSale(slug: string, id: number): Promise<PosSale> {
  return mapSale(slug, await getSaleRow(slug, id));
}

async function getSaleRow(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sales", where: "id=?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Vendita non trovata.");
  return rows[0];
}

async function serviceAvailableAtLocation(slug: string, serviceId: number, locationId: number): Promise<boolean> {
  if (serviceId <= 0 || locationId <= 0) return true;
  const table = await tenantTable(slug, "service_locations").catch(() => null);
  if (!table) return true;
  const scope = await tenantScope(table, ["service_id=?"], [serviceId]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT location_id FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  if (!rows.length) return true;
  return rows.some((row) => Number(row.location_id ?? 0) === locationId);
}

async function productAvailableAtLocation(slug: string, productId: number, locationId: number): Promise<boolean> {
  if (productId <= 0 || locationId <= 0) return true;
  const table = await tenantTable(slug, "product_stocks").catch(() => null);
  if (!table) return true;
  const scope = await tenantScope(table, ["product_id=?"], [productId]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT location_id,is_enabled FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  if (!rows.length) return true;
  return rows.some((row) => Number(row.location_id ?? 0) === locationId && Number(row.is_enabled ?? 1) === 1);
}

async function currentProductStock(slug: string, productId: number, locationId: number): Promise<number> {
  if (locationId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", columns: "stock", where: "product_id=? AND location_id=?", params: [productId, locationId], limit: 1 }).catch(() => []);
    if (rows[0]) return Number(rows[0].stock ?? 0) || 0;
  }
  const row = await productRow(slug, productId);
  if (!row) throw new Error("Prodotto non trovato.");
  return Number(row.stock ?? 0) || 0;
}

async function adjustProductStock(slug: string, productId: number, locationId: number, delta: number): Promise<void> {
  const product = await productRow(slug, productId);
  if (!product) throw new Error("Prodotto non trovato.");
  const stocksTable = await tenantTable(slug, "product_stocks").catch(() => null);
  if (stocksTable && locationId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", where: "product_id=? AND location_id=?", params: [productId, locationId], limit: 1 }).catch(() => []);
    if (!rows[0]) {
      await tenantInsert(stocksTable, await filterColumns(stocksTable.name, {
        product_id: productId,
        location_id: locationId,
        stock: Number(product.stock ?? 0) || 0,
        min_stock: Number(product.min_stock ?? 0) || 0,
        reorder_qty: Number(product.reorder_qty ?? 0) || 0,
        incoming_qty: Number(product.incoming_qty ?? 0) || 0,
        incoming_eta: product.incoming_eta ?? null,
        is_enabled: 1,
      }));
    }
    const current = await currentProductStock(slug, productId, locationId);
    const next = roundQuantity(current + delta);
    if (next < -0.00001) throw new Error(`Giacenza insufficiente per ${productDisplayName(String(product.name ?? "Prodotto"), String(product.sku ?? ""))}.`);
    await updateProductStockRow(slug, productId, locationId, { stock: Math.max(0, next), is_enabled: 1 });
    await refreshProductAggregateStock(slug, productId);
    return;
  }
  const next = roundQuantity((Number(product.stock ?? 0) || 0) + delta);
  if (next < -0.00001) throw new Error(`Giacenza insufficiente per ${productDisplayName(String(product.name ?? "Prodotto"), String(product.sku ?? ""))}.`);
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: Math.max(0, next) } });
}

async function updateProductStockRow(slug: string, productId: number, locationId: number, values: Record<string, unknown>): Promise<void> {
  const table = await tenantTable(slug, "product_stocks");
  const filtered = await filterColumns(table.name, values);
  const entries = Object.entries(filtered);
  if (!entries.length) return;
  const scope = await tenantScope(table, ["product_id=?", "location_id=?"], [productId, locationId]);
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",")} ${scope.where}`,
    [...entries.map(([, value]) => value), ...scope.params],
  );
}

async function refreshProductAggregateStock(slug: string, productId: number): Promise<void> {
  const table = await tenantTable(slug, "product_stocks").catch(() => null);
  if (!table) return;
  const scope = await tenantScope(table, ["product_id=?", "COALESCE(is_enabled,1)=1"], [productId]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COALESCE(SUM(stock),0) AS stock FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: Number(rows[0]?.stock ?? 0) || 0 } });
}

async function recordStockCancelAction(slug: string, input: { saleId: number; saleItemId: number; productId: number; qty: number; action: string; stockBefore: number; stockAfter: number; locationId: number; note: string; createdBy: number | null }): Promise<void> {
  const table = await tenantTable(slug, "pos_sale_stock_cancel_actions").catch(() => null);
  if (!table) return;
  await tenantInsert(table, await filterColumns(table.name, {
    sale_id: input.saleId,
    sale_item_id: input.saleItemId,
    product_id: input.productId,
    qty: input.qty,
    action: input.action,
    stock_before: input.stockBefore,
    stock_after: input.stockAfter,
    location_id: input.locationId || null,
    note: clean(input.note, 255),
    created_by: input.createdBy,
  })).catch(() => undefined);
}

async function markSaleCancelled(slug: string, saleId: number, input: { userId: number | null; reason: string; note: string }): Promise<void> {
  const table = await tenantTable(slug, "sales");
  await tenantUpdate({ slug, table: "sales", id: saleId, values: {
    status: "cancelled",
    cancelled_at: new Date(),
    cancelled_by: input.userId,
    cancelled_reason: input.reason,
  } });
  if (await columnExists(table.name, "notes")) {
    const scope = await tenantScope(table, ["id=?"], [saleId]);
    await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET notes=CONCAT(COALESCE(notes,''), ?)${scope.where}`, [`\n${input.note}`, ...scope.params]).catch(() => undefined);
  }
}

// PRE-FLIGHT feasibility guard for the "normal" storno mode. The cancel is NOT wrapped in a
// single DB transaction, so a normal-mode points storno that would drive the balance negative
// must be refused BEFORE any mutation (markSaleCancelled + residue reversals) — otherwise the
// sale would already be voided when the storno later throws, leaving a half-cancelled sale.
// The legacy runs the whole cancel in one transaction (rollback on the RuntimeException); this
// reproduces that all-or-nothing guarantee for the only throw the storno decision introduces.
// Replays the exact apply order (sale-level restore(+used)/storno(-earned) → per-recharge storno)
// so each check reflects the prior movements; only "normal" mode gates, matching the in-apply
// checks (negative/skip never throw here).
async function assertNormalStornoFeasible(
  slug: string,
  saleRow: RowDataPacket,
  modes: { pointsStornoMode: PointsStornoMode; rechargePointsModes: Record<number, PointsStornoMode> },
): Promise<void> {
  const clientId = Math.max(0, Number(saleRow.client_id ?? 0) || 0);
  if (clientId <= 0) return;
  const saleId = Math.max(0, Number(saleRow.id ?? 0) || 0);
  const ptsUsed = normalizePoints(Number(saleRow.fidelity_points_used ?? 0) || 0);
  const ptsEarn = normalizePoints(Number(saleRow.fidelity_points_earned ?? 0) || 0);
  let projected = normalizePoints((await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }))).points || 0);
  // Sale-level: the redeemed points are always restored (+used) first, then the earned points
  // are stornoed (-earned) unless the operator skipped them.
  projected += ptsUsed;
  if (ptsEarn > 0.00001) {
    if (modes.pointsStornoMode === "normal" && projected - ptsEarn < -0.00001) {
      throw new Error("Impossibile annullare: punti guadagnati gia utilizzati (saldo insufficiente per lo storno).");
    }
    if (modes.pointsStornoMode !== "skip") projected -= ptsEarn;
  }
  // Per-recharge storno, chained from the post-sale-level balance (legacy step 6b order).
  const table = await tenantTable(slug, "recharges").catch(() => null);
  if (!table) return;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: table.name,
    columns: "id, points_earned, is_void",
    where: "sale_id=?",
    params: [saleId],
  }).catch(() => [] as RowDataPacket[]);
  for (const row of rows) {
    if (Number(row.is_void ?? 0) === 1) continue;
    const rechargeId = Math.max(0, Number(row.id ?? 0) || 0);
    const earned = normalizePoints(Number(row.points_earned ?? 0) || 0);
    if (earned <= 0.00001) continue;
    const mode = modes.rechargePointsModes[rechargeId] ?? "normal";
    if (mode === "normal" && projected - earned < -0.00001) {
      throw new Error(`R#${rechargeId}: i punti accreditati sulla ricarica (${earned} pt) non sono disponibili per lo storno.`);
    }
    if (mode !== "skip") projected -= earned;
  }
}

async function cancelLinkedSaleResidues(
  slug: string,
  saleId: number,
  reason: string,
  saleRow?: RowDataPacket,
  voidedBy: number | null = null,
  pointsModes: { pointsStornoMode: PointsStornoMode; rechargePointsModes: Record<number, PointsStornoMode> } = { pointsStornoMode: "normal", rechargePointsModes: {} },
  userName = "",
): Promise<void> {
  // Nota standard di annullo (_pos_hist_sale_cancel_standard_note): è QUESTA — non il motivo
  // nudo — che il legacy passa a ClientPrepaidServices::cancelBySale (cancel_note) e a
  // SaleInstallments::cancelPlanBySaleId (cancelled_reason, troncata a 255).
  const standardNote = `Vendita #${saleId} annullata dall'operatore ${userName || "Operatore"}.\nMotivo: ${reason}.`;
  await updateBySaleId(slug, "client_prepaid_services", saleId, { status: "cancelled", canceled_at: new Date(), cancel_note: standardNote.slice(0, 255) });
  await updateBySaleId(slug, "client_packages", saleId, { status: "canceled", updated_at: new Date() });
  await updateBySaleId(slug, "sale_installment_plans", saleId, { status: "cancelled", cancelled_at: new Date(), cancelled_reason: standardNote.slice(0, 255) });
  // Movimenti commissione POS: l'annullo vendita li marca SUBITO 'cancelled'
  // (Commissions::cancelSaleCommissionMovements — il movimento resta nello storico
  // come Annullato; l'eliminazione avviene solo col delete definitivo). Best-effort.
  try {
    const table = await tenantTable(slug, "staff_commission_payments");
    const clauses = ["source_group='pos'", "source_id=?"];
    const params: unknown[] = [saleId];
    if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
      clauses.unshift("tenant_id=?");
      params.unshift(table.tenantId ?? 0);
    }
    const reasonNote = standardNote.slice(0, 255);
    await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)}
          SET entry_status='cancelled',
              cancelled_at=COALESCE(cancelled_at, NOW()),
              cancelled_by=COALESCE(cancelled_by, ?),
              cancellation_reason=CASE WHEN COALESCE(cancellation_reason,'')='' THEN ? ELSE cancellation_reason END,
              note=?
        WHERE ${clauses.join(" AND ")}`,
      [voidedBy, reasonNote, reasonNote, ...params],
    );
  } catch {
    // schema commissioni assente: come il legacy paymentSchemaAvailable(false)
  }

  // Sulle rate il legacy APPENDE "[ANNULLATA <ts>] <nota standard>" alla nota esistente
  // (i dati di incasso di una rata già pagata restano nello storico).
  {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const installmentNote = `[ANNULLATA ${ts}] ${standardNote}`;
    const rateRows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installments", columns: "id, note", where: "sale_id=?", params: [saleId] }).catch(() => [] as RowDataPacket[]);
    for (const row of rateRows) {
      const existing = String(row.note ?? "").trim();
      await tenantUpdate({
        slug,
        table: "sale_installments",
        id: Number(row.id ?? 0),
        values: { status: "cancelled", note: existing ? `${existing}\n${installmentNote}` : installmentNote },
      }).catch(() => 0);
    }
  }

  // CANCEL the GiftCard this sale ISSUED (the SELL path): flip the card to 'cancelled' +
  // write a reversal ledger row. Found by the issue transaction's sale marker, NOT by
  // sales.giftcard_id (that column is the RESIDUI card the sale SPENT — a different card,
  // restored below). Keyed off the sale linkage so the two never collide.
  await cancelIssuedSaleGiftcards(slug, saleId, reason);

  // CANCEL the GiftBox this sale ISSUED (the SELL path): flip the issued instance to
  // 'cancelled'. Found by the instance's sale-linkage note ('Vendita #saleId') since
  // giftbox_instances has no sale_id column. Kept distinct from the drawer's giftbox-redeem
  // restore (which reverses a CONSUMED giftbox via giftbox_redemptions) — a different
  // operation keyed off the sale linkage, so the two never collide.
  await cancelIssuedSaleGiftboxes(slug, saleId, reason);

  // REMOVE the promotion redemption this sale recorded (Block 3b), so a voided sale
  // no longer counts against the promotion's per-customer/day limits.
  const redTable = await tenantTable(slug, "promotion_redemptions").catch(() => null);
  if (redTable) {
    await dbExecute(`DELETE FROM ${quoteIdentifier(redTable.name)} WHERE tenant_id = ? AND sale_id = ?`, [redTable.tenantId ?? 0, saleId]).catch(() => undefined);
  }

  if (!saleRow) return;
  const creditUsed = roundMoney(Number(saleRow.credit_used ?? 0) || 0);
  const giftcardUsed = roundMoney(Number(saleRow.giftcard_used ?? 0) || 0);
  const giftcardId = Math.max(0, Number(saleRow.giftcard_id ?? 0) || 0);
  const clientId = Math.max(0, Number(saleRow.client_id ?? 0) || 0);
  const pointsUsed = normalizePoints(Number(saleRow.fidelity_points_used ?? 0) || 0);
  const pointsEarned = normalizePoints(Number(saleRow.fidelity_points_earned ?? 0) || 0);

  if (giftcardId > 0 && giftcardUsed > 0) {
    await refundDbGiftCard(giftcardId, giftcardUsed, slug, `Storno vendita #${saleId}`).catch(() => undefined);
  }
  if (creditUsed > 0 && clientId > 0) {
    await addDbWalletMovement(
      { clientId, type: "recharge", amount: creditUsed, note: `Storno credito vendita #${saleId}` },
      slug,
    ).catch(() => undefined);
  }
  // SALE-level fidelity points, applied IN THE LEGACY ORDER (pos_history.php ~1604-1652):
  //   1) REFUND the redeemed points (+ptsUsed) — the inverse of the points spent as discount.
  //   2) STORNO the earned points (-ptsEarned) — subject to the operator's pointsStornoMode.
  // Both hit clients.points and MUST run BEFORE the per-recharge storno so the recharge
  // balance reflects them (replicating the PHP step 6 → step 6b ordering).
  //
  // REFUND the redeemed FIDELITY points: a positive points_earn movement re-credits
  // clients.points (the inverse of the points_redeem consumed at checkout), mirroring the
  // legacy `Fidelity::addTransaction(clientId, +ptsUsed, ...)` on sale cancel.
  if (pointsUsed > 0 && clientId > 0) {
    await addDbWalletMovement(
      { clientId, type: "points_earn", points: pointsUsed, source: "sale", note: `Storno punti Fidelity vendita #${saleId}` },
      slug,
    ).catch(() => undefined);
  }
  // REVERSE the EARNED fidelity points, honouring pointsStornoMode:
  //  - skip     → do NOT reverse (audit-note only, best-effort; balance untouched).
  //  - negative → reverse unconditionally (balance allowed to go negative).
  //  - normal   → pre-check the current clients.points balance; if the storno would push it
  //               below zero, THROW a clear error (fail safe) instead of silently proceeding.
  // Faithful to pos_history.php ~1626-1649: skip → info note; negative → allowNeg reverse;
  // normal → Fidelity::addTransaction returns false on insufficient balance → RuntimeException.
  if (pointsEarned > 0 && clientId > 0) {
    const mode = pointsModes.pointsStornoMode;
    if (mode !== "skip") {
      if (mode === "normal") {
        // Pre-check AFTER the +ptsUsed restore already applied above (the PHP order), so the
        // guard matches the legacy would_be = current + used - earned. Read the live balance.
        const bal = await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }));
        const curPts = normalizePoints(Number(bal.points ?? 0) || 0);
        if (curPts - pointsEarned < -0.00001) {
          throw new Error("Impossibile annullare: punti guadagnati gia utilizzati (saldo insufficiente per lo storno).");
        }
      }
      await addDbWalletMovement(
        { clientId, type: "points_redeem", points: -pointsEarned, source: "sale", note: `Storno punti guadagnati vendita #${saleId}` },
        slug,
      ).catch(() => undefined);
    }
    // mode === "skip": intentionally no movement — the earned points are left on the client's
    // balance (the operator chose to complete the void without scaling them).
  }

  // REVERSE the RECHARGE this sale ISSUED (the SELL path), AFTER the sale-level points block
  // above so the recharge storno sees the post-sale-level balance (legacy step 6b). Flip each
  // recharges row to is_void=1 (+ voided_at/by), DEBIT the wallet by total_amount (the inverse
  // of the top-up credit) and reverse the earned points (points_redeem) subject to each
  // recharge's storno mode. Found by recharges.sale_id (the table HAS sale_id + is_void).
  // Idempotent: only a not-yet-void row is reversed, so a re-void is a no-op. Kept distinct
  // from the residui-credit restore above (that re-credits SPENT credit, keyed off
  // sales.credit_used) — both touch clients.credit_balance but are linked to different
  // rows/notes and guarded by recharges.is_void, so they never collide.
  await reverseIssuedSaleRecharges(slug, saleId, voidedBy, pointsModes.rechargePointsModes);

  const salesTableName = (await tenantTable(slug, "sales")).name;
  if ((creditUsed > 0 || giftcardUsed > 0) && (await columnExists(salesTableName, "credit_used"))) {
    await tenantUpdate({ slug, table: "sales", id: saleId, values: { credit_used: 0, giftcard_used: 0 } }).catch(() => 0);
  }
  // Zero the stored points so a re-void cannot double-refund (idempotency guard, like the
  // credit_used/giftcard_used reset above).
  if (pointsUsed > 0 && (await columnExists(salesTableName, "fidelity_points_used"))) {
    await tenantUpdate({ slug, table: "sales", id: saleId, values: { fidelity_points_used: 0, fidelity_discount: 0 } }).catch(() => 0);
  }
  if (pointsEarned > 0 && (await columnExists(salesTableName, "fidelity_points_earned"))) {
    await tenantUpdate({ slug, table: "sales", id: saleId, values: { fidelity_points_earned: 0 } }).catch(() => 0);
  }
}

async function updateBySaleId(slug: string, tableName: string, saleId: number, values: Record<string, unknown>): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: tableName, columns: "id", where: "sale_id=?", params: [saleId] }).catch(() => []);
  for (const row of rows) {
    await tenantUpdate({ slug, table: tableName, id: Number(row.id ?? 0), values }).catch(() => 0);
  }
}

// Cancel any GiftCard(s) this sale ISSUED (the SELL path), found via the 'issue'
// giftcard_transactions row tagged with the sale marker (meta_json or note). Flips each
// still-active card to status='cancelled' (+ cancelled_at / cancelled_reason) and writes a
// 'cancel' reversal ledger row so the issued credit is voided. Best-effort + idempotent:
// only an 'active'/'redeemed' card is touched (a card already cancelled / used elsewhere is
// left as-is), so a re-void is a no-op. This is distinct from the residui restore which
// reverses a card the sale SPENT (keyed off sales.giftcard_id) — keyed off sale linkage so
// the two giftcards (sold vs spent) never collide.
async function cancelIssuedSaleGiftcards(slug: string, saleId: number, reason: string): Promise<void> {
  const txTable = await tenantTable(slug, "giftcard_transactions").catch(() => null);
  const giftcardTable = await tenantTable(slug, "giftcards").catch(() => null);
  if (!txTable || !giftcardTable) return;

  // Find the issue rows for this sale. Match the meta_json sale_id (preferred) or the note
  // marker — both written by issueGiftcardFromSale. Scoped to type='issue' so only the SELL
  // ledger row matches (a redeem/cancel row for the same card is ignored).
  const marker = `%${GIFTCARD_SALE_MARKER}${saleId}]%`;
  const metaMatch = `%"sale_id":${saleId}%`;
  const txRows = await tenantSelect<RowDataPacket>({
    slug,
    table: txTable.name,
    columns: "giftcard_id",
    where: "type = 'issue' AND (meta_json LIKE ? OR note LIKE ?)",
    params: [metaMatch, marker],
  }).catch(() => [] as RowDataPacket[]);

  const seen = new Set<number>();
  for (const tx of txRows) {
    const giftcardId = Math.max(0, Number(tx.giftcard_id ?? 0) || 0);
    if (giftcardId <= 0 || seen.has(giftcardId)) continue;
    seen.add(giftcardId);

    const cardRows = await tenantSelect<RowDataPacket>({
      slug,
      table: giftcardTable.name,
      columns: "id, balance, status",
      where: "id = ?",
      params: [giftcardId],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const card = cardRows[0];
    if (!card) continue;
    const status = String(card.status ?? "").toLowerCase();
    // Idempotent: skip a card already cancelled/expired (a re-void must not re-cancel).
    if (status === "cancelled" || status === "canceled" || status === "expired") continue;
    const balance = roundMoney(Math.max(0, Number(card.balance ?? 0) || 0));

    await tenantUpdate({
      slug,
      table: giftcardTable.name,
      id: giftcardId,
      values: { status: "cancelled", cancelled_at: new Date(), cancelled_reason: clean(reason, 255) || `Storno vendita #${saleId}` },
    }).catch(() => 0);

    await tenantInsert(txTable, await filterColumns(txTable.name, {
      giftcard_id: giftcardId,
      type: "cancel",
      // Reverse the still-available balance (negative), mirroring the legacy cancel ledger.
      amount: -balance,
      note: `Annullamento GiftCard (storno vendita #${saleId})`,
      meta_json: JSON.stringify({ source: "sale_cancel", sale_id: saleId }),
      created_at: new Date(),
    })).catch(() => undefined);
  }
}

// Cancel any GiftBox instance(s) this sale ISSUED (the SELL path), found via the sale-linkage
// note 'Vendita #saleId' written by issueGiftboxFromSale (giftbox_instances has no sale_id
// column). Flips each still-issued instance to status='cancelled' (+ cancelled_at) and writes a
// 'cancel' giftbox_transactions audit row, leaving its giftbox_instance_items intact. Best-effort
// + idempotent: only an 'issued'/'active' instance is touched (one already cancelled/redeemed/
// expired is left as-is), so a re-void is a no-op. This is distinct from the drawer's giftbox-
// redeem restore (restoreGiftboxRedemption), which reverses a CONSUMED giftbox via
// giftbox_redemptions — keyed off the sale linkage so the issued vs consumed boxes never collide.
async function cancelIssuedSaleGiftboxes(slug: string, saleId: number, reason: string): Promise<void> {
  const instanceTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  if (!instanceTable) return;
  if (!(await columnExists(instanceTable.name, "note"))) return;

  const marker = `${GIFTBOX_SALE_MARKER}${saleId}`;
  // Exact-note match (the issuer writes the note as exactly 'Vendita #saleId'). LIKE-escape the
  // marker so a numeric saleId can't introduce wildcards (it can't, but stay defensive).
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: instanceTable.name,
    columns: "id, status",
    where: "note = ?",
    params: [marker],
  }).catch(() => [] as RowDataPacket[]);

  const txTable = await tenantTable(slug, "giftbox_transactions").catch(() => null);
  for (const row of rows) {
    const instanceId = Math.max(0, Number(row.id ?? 0) || 0);
    if (instanceId <= 0) continue;
    const status = String(row.status ?? "").toLowerCase();
    // Idempotent: only an issued/active instance is cancelled (a re-void must not re-cancel a
    // box already cancelled/redeemed/expired).
    if (status !== "issued" && status !== "active") continue;

    await tenantUpdate({
      slug,
      table: instanceTable.name,
      id: instanceId,
      values: { status: "cancelled", cancelled_at: new Date() },
    }).catch(() => 0);

    if (txTable) {
      await tenantInsert(txTable, await filterColumns(txTable.name, {
        instance_id: instanceId,
        type: "cancel",
        amount: 0,
        note: clean(`Annullamento GiftBox (storno vendita #${saleId}): ${reason}`, 255),
        meta_json: JSON.stringify({ source: "sale_cancel", sale_id: saleId }),
        created_at: new Date(),
      })).catch(() => undefined);
    }
  }
}

// Reverse any RECHARGE(s) this sale ISSUED (the SELL path), found via recharges.sale_id (the
// table HAS sale_id + is_void). For each not-yet-void row: flip is_void=1 (+ voided_at/by),
// DEBIT the wallet by total_amount (a negative 'debit' movement — credit_adjustments row +
// clients.credit_balance decrement, the inverse of the top-up credit) and reverse the earned
// points (a negative 'points_redeem' movement — transactions row + clients.points decrement,
// the inverse of the earned points). Best-effort + idempotent: a row already void is skipped,
// so a re-void is a no-op. Kept distinct from the residui-credit restore (which RE-CREDITS
// credit the sale SPENT, keyed off sales.credit_used) — guarded by recharges.is_void so the
// two credit_balance operations never collide.
async function reverseIssuedSaleRecharges(
  slug: string,
  saleId: number,
  voidedBy: number | null,
  rechargePointsModes: Record<number, PointsStornoMode> = {},
): Promise<void> {
  const table = await tenantTable(slug, "recharges").catch(() => null);
  if (!table) return;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: table.name,
    columns: "id, client_id, total_amount, points_earned, is_void",
    where: "sale_id=?",
    params: [saleId],
  }).catch(() => [] as RowDataPacket[]);

  for (const row of rows) {
    const rechargeId = Math.max(0, Number(row.id ?? 0) || 0);
    if (rechargeId <= 0) continue;
    // Idempotent: skip a recharge already voided (a re-void must not double-debit).
    if (Number(row.is_void ?? 0) === 1) continue;
    const clientId = Math.max(0, Number(row.client_id ?? 0) || 0);
    const totalAmount = roundMoney(Math.max(0, Number(row.total_amount ?? 0) || 0));
    const pointsEarned = normalizePoints(Number(row.points_earned ?? 0) || 0);
    const mode = rechargePointsModes[rechargeId] ?? "normal";

    // Flip is_void FIRST so the row is guarded even if a wallet movement throws (a re-void
    // then skips it). Schema-guarded via filterColumns.
    await tenantUpdate({
      slug,
      table: table.name,
      id: rechargeId,
      values: { is_void: 1, voided_at: new Date(), voided_by: voidedBy },
    }).catch(() => 0);

    if (clientId > 0 && totalAmount > 0) {
      // DEBIT the wallet by the credited total (negative -> credit_adjustments debit row +
      // clients.credit_balance decrement), the inverse of the issue-time top-up credit.
      await addDbWalletMovement(
        { clientId, type: "debit", amount: -totalAmount, note: `Storno ricarica vendita #${saleId}` },
        slug,
      ).catch(() => undefined);
    }
    // REVERSE the earned points, honouring the per-recharge storno mode (port of
    // recharge_cancel_void_apply, CreditRechargeCancel.php ~876-922):
    //  - skip     → do NOT reverse (leave the recharge's earned points on the balance).
    //  - negative → reverse unconditionally (balance allowed to go negative).
    //  - normal   → pre-check the live clients.points balance; if the storno would go below
    //               zero, THROW (fail safe) — the legacy raises a RuntimeException here.
    if (clientId > 0 && pointsEarned > 0 && mode !== "skip") {
      if (mode === "normal") {
        const bal = await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }));
        const curPts = normalizePoints(Number(bal.points ?? 0) || 0);
        if (pointsEarned > curPts + 0.0000001) {
          throw new Error(`R#${rechargeId}: i punti accreditati sulla ricarica (${pointsEarned} pt) non sono disponibili per lo storno.`);
        }
      }
      // Negative points_redeem -> transactions row + clients.points decrement, the inverse of
      // the issue-time points_earn.
      await addDbWalletMovement(
        { clientId, type: "points_redeem", points: -pointsEarned, source: "recharge", note: `Storno punti ricarica vendita #${saleId}` },
        slug,
      ).catch(() => undefined);
    }
    // mode === "skip": intentionally no points movement.
  }
}

async function issuePrepaidFromSale(slug: string, saleId: number, saleItemId: number, clientId: number, item: PosSaleItem): Promise<void> {
  const table = await tenantTable(slug, "client_prepaid_services").catch(() => null);
  if (!table) return;
  // Scadenza + data d'acquisto come il legacy ClientPrepaidServices::syncSale
  // (:369-397): expires_at = PosSettings::prepaidExpiryForPurchaseDate(purchaseDate);
  // senza questi campi i prepagati venduti dal Next non scadono mai. filterColumns
  // scarta le colonne assenti, quindi è sicuro anche su schemi più vecchi.
  const purchaseDate = todayIso();
  const expiresAt = await prepaidExpiryForPurchaseDate(slug, purchaseDate).catch(() => null);
  await tenantInsert(table, await filterColumns(table.name, {
    client_id: clientId,
    sale_id: saleId,
    sale_item_id: saleItemId,
    service_id: item.refId > 0 ? item.refId : null,
    service_name: item.name,
    purchased_qty: item.quantity,
    remaining_qty: item.quantity,
    unit_price: item.unitPrice,
    total_paid: item.total,
    purchase_date: purchaseDate,
    expires_at: expiresAt,
    status: "active",
  })).catch(() => undefined);
}

async function issuePackageFromSale(slug: string, saleId: number, clientId: number, item: PosSaleItem): Promise<number> {
  const table = await tenantTable(slug, "client_packages").catch(() => null);
  if (!table) return 0;
  // Sessions come from the package TEMPLATE (sum of package_services / package_items, or
  // packages.sessions_total) — faithful to the legacy issue logic, NOT the cart qty (the
  // package line is always qty 1 at the bundle price). Fall back to the line qty only when
  // the template can't be read (e.g. ad-hoc package with no id).
  const packageRow = item.refId > 0 ? await packageRowById(slug, item.refId) : null;
  const sessions = item.refId > 0
    ? await packageSessionsTotal(slug, item.refId, packageRow ?? undefined)
    : Math.max(1, item.quantity);
  // Expiry: the custom "Valido al" the staff picked, else today + the template's
  // validity_days (pkCalculatePackageExpiry base case), else null.
  const startDate = item.startDate && /^\d{4}-\d{2}-\d{2}$/.test(item.startDate) ? item.startDate : todayIso();
  let expiresAt: string | null = item.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt) ? item.expiresAt : null;
  if (!expiresAt) {
    const validityDays = Math.max(0, Number(packageRow?.validity_days ?? 0) || 0);
    if (validityDays > 0) expiresAt = addDaysIso(startDate, validityDays);
  }
  const clientPackageId = await tenantInsert(table, await filterColumns(table.name, {
    client_id: clientId,
    sale_id: saleId,
    package_id: item.refId > 0 ? item.refId : null,
    package_name: item.name,
    service_id: Number(packageRow?.service_id ?? 0) || null,
    purchase_date: todayIso(),
    start_date: startDate,
    expires_at: expiresAt,
    sessions_total: sessions,
    sessions_remaining: sessions,
    status: "active",
    notes: item.note ?? null,
  })).catch(() => 0);

  // PER-SERVICE breakdown (client_package_services): faithful to the legacy issue_package
  // (pos.php ~2376-2387) — one row per service in the package template with its own
  // sessions_total/remaining, so the redeem path (db-repositories: prefer a per-service row,
  // keep package.remaining == SUM(cps.remaining)) and the residuals reader see the same
  // per-service pools the rest of the app issues. Without this, a POS-sold package had ONLY the
  // aggregate client_packages row and degraded to package-level redemption.
  if (clientPackageId > 0 && item.refId > 0) {
    const breakdown = await packageServicesBreakdown(slug, item.refId, packageRow ?? undefined, sessions);
    const cpsTable = await tenantTable(slug, "client_package_services").catch(() => null);
    if (cpsTable) {
      for (const svc of breakdown) {
        await tenantInsert(cpsTable, await filterColumns(cpsTable.name, {
          client_package_id: clientPackageId,
          service_id: svc.serviceId,
          sessions_total: svc.sessions,
          sessions_remaining: svc.sessions,
          sort_order: svc.sortOrder,
        })).catch(() => 0);
      }
    }
  }
  return clientPackageId;
}

// Per-service breakdown for a sold package, faithful to the legacy pkReadPackageServicesBreakdown
// (pos.php ~2282-2322): the package_services template rows (service_id + sessions_total, qty >= 1),
// or — when the template has none — a single fallback row for the package's own service_id carrying
// the full session total (matching the legacy fallback). Returns [] when neither is resolvable.
async function packageServicesBreakdown(
  slug: string,
  packageId: number,
  packageRow: RowDataPacket | undefined,
  totalSessions: number,
): Promise<Array<{ serviceId: number; sessions: number; sortOrder: number }>> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "package_services",
    columns: "service_id, sessions_total, sort_order",
    where: "package_id=?",
    params: [packageId],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const out: Array<{ serviceId: number; sessions: number; sortOrder: number }> = [];
  rows.forEach((r, index) => {
    const serviceId = Math.max(0, Number(r.service_id ?? 0) || 0);
    if (serviceId <= 0) return;
    out.push({
      serviceId,
      sessions: Math.max(1, Number(r.sessions_total ?? 1) || 1),
      sortOrder: Number(r.sort_order ?? index) || index,
    });
  });
  if (out.length) return out;
  const fallbackService = Math.max(0, Number(packageRow?.service_id ?? 0) || 0);
  if (fallbackService > 0) return [{ serviceId: fallbackService, sessions: Math.max(1, totalSessions), sortOrder: 0 }];
  return [];
}

async function packageRowById(slug: string, id: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "packages", where: "id=?", params: [id], limit: 1 }).catch(() => []);
  return rows[0] ?? null;
}

// SELL a RECHARGE at checkout — faithful port of the pos.php recharge action (~2195-2259) +
// recharge_templates. Inserts a `recharges` row (base/bonus/total/earn_points/points_earned,
// template_id, sale_id, location_id, created_by), CREDITS the wallet by total_amount
// (addDbWalletMovement type 'recharge', positive — inserts a credit_adjustments row +
// increments clients.credit_balance), and EARNS fidelity points (addDbWalletMovement
// 'points_earn', positive — inserts a transactions row + increments clients.points) when
// earn_points is set AND the client is eligible. The client PAID the base_amount (the sale
// line) and RECEIVES base+bonus as credit; the bonus is free credit. Skips silently when the
// total is not positive. Returns the new recharges id (0 when not issued).
async function issueRechargeFromSale(
  slug: string,
  saleId: number,
  clientId: number,
  item: PosSaleItem,
  locationId: number,
  createdBy: number | null,
): Promise<number> {
  const table = await tenantTable(slug, "recharges").catch(() => null);
  if (!table) return 0;
  if (clientId <= 0) return 0;

  // Base = the line price (qty forced to 1, so total === unitPrice). Bonus/total ride on the
  // line meta (recomputed server-side in buildSaleItems, never trusting a client total).
  const baseAmount = roundMoney(Math.max(0, Number(item.baseAmount ?? item.total ?? item.unitPrice ?? 0) || 0));
  if (baseAmount <= 0.00001) return 0;
  const bonusKind = normalizeBonusKind(item.bonusKind);
  const bonusValue = roundMoney(Math.max(0, Number(item.bonusValue ?? 0) || 0));
  const bonusAmount = roundMoney(Math.max(0, Number(item.bonusAmount ?? rechargeBonusAmount(baseAmount, bonusKind, bonusValue)) || 0));
  const totalAmount = roundMoney(baseAmount + bonusAmount);
  const earnPointsFlag = item.earnPoints === true;
  const templateId = Math.max(0, Number(item.refId ?? 0) || 0);

  // POINTS: faithful to pos_recharge_points_info — earn only when the template's earn_points
  // flag is set AND the client is recharge-points eligible. The earn BASE is base+bonus when
  // the flag is set (the legacy "Importo + bonus" rule the modal exposes), else base only.
  // CAMPAIGN-AWARE like the POS/appointment earn (legacy calcEarnPointsForAmountWithCampaign):
  // points accrue only under the ACTIVE fidelity campaign for today (no campaign => 0),
  // applying its step/tiers + min_spend + card-level eligibility.
  const earnSettings = await getFidelityEarnSettings(slug);
  // Idoneità punti ricariche = SOLO programma attivo + cliente ADERENTE (tessera attiva),
  // NON il flag earn_points del template (port di $pointsEligible, pos.php:5570-5575). Il
  // flag decide SOLO la BASE: attivo -> base+bonus; disattivo -> sola base. Prima il Next
  // includeva il flag in `eligible`, quindi col flag OFF un cliente idoneo riceveva ZERO punti.
  const pointsEligible = earnSettings.enabled && (await fidelityIsClientAdhering(slug, clientId));
  const earnBase = earnPointsFlag ? totalAmount : baseAmount;
  const pointsEarned = pointsEligible ? (await computeCampaignEarn(slug, earnBase, clientId, earnSettings.earnStep)).points : 0;

  const note = rechargeNote(baseAmount, bonusAmount, pointsEarned, item.note);

  const rechargeId = await tenantInsert(table, await filterColumns(table.name, {
    client_id: clientId,
    card_id: 0,
    template_id: templateId > 0 ? templateId : null,
    sale_id: saleId,
    location_id: locationId > 0 ? locationId : null,
    base_amount: baseAmount,
    bonus_kind: bonusKind,
    bonus_value: bonusValue,
    bonus_amount: bonusAmount,
    total_amount: totalAmount,
    earn_points: earnPointsFlag ? 1 : 0,
    points_earned: pointsEarned,
    note,
    is_void: 0,
    created_at: new Date(),
    created_by: createdBy,
  })).catch(() => 0);
  if (!rechargeId) return 0;

  // CREDIT the wallet by base+bonus (a positive 'recharge' movement: credit_adjustments row +
  // clients.credit_balance increment), tagged with the sale id so a later void can reverse it.
  await addDbWalletMovement(
    { clientId, type: "recharge", amount: totalAmount, note: `Ricarica vendita #${saleId}` },
    slug,
  ).catch(() => undefined);

  // EARN the fidelity points (a positive 'points_earn' movement: transactions row +
  // clients.points increment), tagged with the sale id so a later void can reverse them.
  if (pointsEarned > 0) {
    await addDbWalletMovement(
      { clientId, type: "points_earn", points: pointsEarned, source: "recharge", note: `Punti ricarica vendita #${saleId}` },
      slug,
    ).catch(() => undefined);
  }

  return rechargeId;
}

// The recharge fidelity EARN settings — port of Fidelity::settings() earn block (always
// 'amount' mode now): fidelity_enabled gate + the flat earn step (€ per point). `earnOnBonus`
// is ALWAYS true here (the per-template earn_points flag already decides whether points are
// earned at all; when earned, the base is base+bonus per the modal's "Importo + bonus" copy).
// Schema-guarded: a missing column / table falls back to disabled with a 10€ step.
type FidelityEarnSettings = { enabled: boolean; earnStep: number; earnOnBonus: boolean };

export async function getFidelityEarnSettings(slug: string): Promise<FidelityEarnSettings> {
  const defaults: FidelityEarnSettings = { enabled: false, earnStep: 10, earnOnBonus: true };
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "fidelity_enabled,fidelity_points_enabled,fidelity_earn_step_euro",
      orderBy: "id ASC",
      limit: 1,
    });
    const row = rows[0];
    if (!row) return defaults;
    const enabled = Number(row.fidelity_enabled ?? 0) === 1 && Number(row.fidelity_points_enabled ?? 1) === 1;
    let earnStep = Number(row.fidelity_earn_step_euro ?? 10);
    if (!Number.isFinite(earnStep) || earnStep <= 0) earnStep = 10;
    if (earnStep > 100000) earnStep = 100000;
    return { enabled, earnStep: roundMoney(earnStep), earnOnBonus: true };
  } catch {
    return defaults;
  }
}


// Points for a tiered campaign: the highest tier whose min_spend <= amount.
function tierPointsForSpend(amount: number, tiers: Array<{ minSpend: number; points: number }>): number {
  let best = 0;
  for (const t of tiers) if (amount + 0.0000001 >= Number(t.minSpend ?? 0)) best = Math.max(best, Number(t.points ?? 0));
  return best;
}

// Campaign-aware earn (port of Fidelity::calcEarnPointsForAmountWithCampaign): when
// the campaign module is present, points accrue ONLY under an ACTIVE campaign valid
// for the sale date — no active campaign => 0 points. Applies the campaign's earn
// step (amount mode) or tiers, its min_spend gate, and its card-level eligibility
// (clients.fidelity_level). Returns the campaign id so the caller stamps
// sales.fidelity_campaign_id. earnStepFallback is the businesses default step used
// when the campaign leaves earn_step_euro at 0.
export async function computeCampaignEarn(slug: string, amount: number, clientId: number, earnStepFallback: number): Promise<{ points: number; campaignId: number; campaignName: string }> {
  if (amount <= 0.0000001) return { points: 0, campaignId: 0, campaignName: "" };
  const today = todayIso();
  const campaign = (await listFidelityCampaigns(slug)).find(
    (c) => c.active && (c.startsAt === "" || c.startsAt <= today) && (c.endsAt === "" || c.endsAt >= today),
  );
  if (!campaign) return { points: 0, campaignId: 0, campaignName: "" };
  const campaignName = String(campaign.name ?? "");
  if (campaign.eligibleLevels.length > 0) {
    if (clientId <= 0) return { points: 0, campaignId: campaign.id, campaignName };
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "fidelity_level", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const level = (String(rows[0]?.fidelity_level ?? "").trim().toLowerCase()) || "base";
    if (!campaign.eligibleLevels.includes(level)) return { points: 0, campaignId: campaign.id, campaignName };
  }
  if (campaign.minSpend > 0.0000001 && amount + 0.0000001 < campaign.minSpend) return { points: 0, campaignId: campaign.id, campaignName };
  let points = 0;
  if (campaign.earnMode === "tiers") {
    points = tierPointsForSpend(amount, campaign.tiers);
  } else {
    const step = campaign.earnStepEuro > 0 ? campaign.earnStepEuro : earnStepFallback;
    points = step > 0 ? amount / step : 0;
  }
  return { points: normalizePoints(points), campaignId: campaign.id, campaignName };
}

// Preview punti su ricarica (port di pos.php mode=preview_recharge_points ->
// pos_recharge_points_info): campagna-aware, gated su earn attivo + adesione tessera.
// Best-effort: non lancia mai (il calcolo definitivo avviene comunque al Concludi).
export async function getManageRechargePointsPreview(
  slug: string,
  clientId: number,
  amount: number,
): Promise<{ ok: true; eligible: boolean; points: number; campaignId: number; campaignName: string; error: string }> {
  const cid = Math.max(0, Number(clientId) || 0);
  const amt = roundMoney(Math.max(0, Number(amount) || 0));
  const out = { ok: true as const, eligible: false, points: 0, campaignId: 0, campaignName: "", error: "" };
  if (cid <= 0 || amt <= 0.00001) return out;
  try {
    const earnSettings = await getFidelityEarnSettings(slug);
    if (!earnSettings.enabled) return { ...out, error: "Accumulo punti non attivo." };
    const adhering = await fidelityIsClientAdhering(slug, cid).catch(() => false);
    if (!adhering) return { ...out, error: "Cliente non aderente alla Fidelity." };
    const earn = await computeCampaignEarn(slug, amt, cid, earnSettings.earnStep);
    return { ...out, eligible: earn.points > 0, points: earn.points, campaignId: earn.campaignId, campaignName: earn.campaignName };
  } catch {
    return out;
  }
}

// SETTLE the fidelity for an appointment that just transitioned to 'done' — faithful port
// of Fidelity::handleAppointmentStatusChange (app/lib/Fidelity.php ~2321), the EARN side.
// The legacy reserves points on pending/scheduled and only settles them when the booking
// becomes 'Eseguito' ("punti NON scalati subito… solo quando passa a Eseguito"), so this is
// invoked ONCE on the done transition (the caller already gates oldStatus!=='done').
//
// What it does (tenant-scoped throughout):
//  • Earnable base = SUM(appointment_services.price) minus the manual sconto, clamped the
//    faithful way (percent => subtotal*val/100, fixed => val; 0..subtotal). Covered/redeemed
//    service lines are already 0, so they contribute nothing — the earn base is the net
//    service value, matching the legacy (coupon is not persisted on appointments yet;
//    credit/giftcard reduce the PAYMENT, not the earnable base).
//  • EARN: when earn is enabled, award the campaign-aware computeCampaignEarn points via a
//    positive points_earn wallet movement tagged source_type='appointment'/source_id=appointmentId
//    (so a later cancel-done storno can find + reverse it, exactly like the POS void reverses
//    via sales.fidelity_points_earned) and stamp appointments.fidelity_points_earned.
//  • REDEEM (reserved): when fidelity_points_used>0, settle it with a negative points_redeem
//    movement tagged the same way. (fidelity_points_used is always 0 today — the drawer
//    price-panel fidelity row is inert/Block 4 — so this branch is dormant but ported.)
//
// IDEMPOTENT: returns early when the appointment already has fidelity_points_earned>0 (never
// double-awards); the redeem branch is guarded by an existing-redeem-transaction lookup. This
// is BEST-EFFORT: any error is swallowed by the caller (.catch) and additionally contained
// here, so a fidelity failure NEVER fails the status change. Does NOT implement the reversal
// on LEAVING 'done' (the dedicated cancel-done flow handles the storno) — it only stamps +
// tags so that reversal becomes possible later.
// Legacy fidelity setting `earn_on_appointment_done`: whether completing an appointment
// awards points. Default ENABLED when the column is absent/null (preserves earn on installs
// without the flag), matching the legacy default. Best-effort.
async function fidelityEarnOnAppointmentDone(slug: string): Promise<boolean> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "fidelity_earn_on_appointment_done",
      orderBy: "id ASC",
      limit: 1,
    });
    const value = rows[0]?.fidelity_earn_on_appointment_done;
    return value === undefined || value === null || Number(value) === 1;
  } catch {
    return true;
  }
}

export async function awardAppointmentFidelityOnDone(slug: string, appointmentId: number, createdBy?: number): Promise<void> {
  try {
    const id = Math.max(0, Number(appointmentId) || 0);
    if (id <= 0) return;

    // Load the appointment fidelity fields (tenant-scoped). No row / no client => nothing to do.
    const appointmentRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "client_id, discount_type, discount_value, fidelity_points_earned, fidelity_points_used",
      where: "id = ?",
      params: [id],
      limit: 1,
    });
    const appointment = appointmentRows[0];
    if (!appointment) return;

    const clientId = Math.max(0, Number(appointment.client_id ?? 0) || 0);
    const alreadyEarned = normalizePoints(Number(appointment.fidelity_points_earned ?? 0));
    const pointsUsed = normalizePoints(Number(appointment.fidelity_points_used ?? 0));

    // IDEMPOTENT EARN GUARD: already settled (a non-zero stamp). The legacy stamps with a
    // GREATEST() so a re-settle is a no-op; here we simply skip when already > 0. We also
    // skip when there is no client (points belong to a client wallet).
    if (clientId <= 0 || alreadyEarned > 0) return;

    // Earnable subtotal = sum of the per-line service prices (covered/redeemed lines are 0).
    // qty is always 1 on appointment_services, so SUM(price) is the service-line total.
    const subtotalRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      columns: "COALESCE(SUM(price), 0) AS subtotal",
      where: "appointment_id = ?",
      params: [id],
    });
    const subtotal = roundMoney(Math.max(0, Number(subtotalRows[0]?.subtotal ?? 0) || 0));

    // Manual sconto clamp — faithful: percent => subtotal*val/100, fixed => val; the discount
    // can never exceed the subtotal nor go negative (mirrors db-repositories.discountValue and
    // the legacy renderPriceDetails math). Any other/empty type => no discount.
    const discountType = String(appointment.discount_type ?? "");
    const discountValue = Math.max(0, Number(appointment.discount_value ?? 0) || 0);
    let discount = 0;
    if (discountType === "percent") discount = (subtotal * discountValue) / 100;
    else if (discountType === "fixed") discount = discountValue;
    discount = roundMoney(Math.max(0, Math.min(subtotal, discount)));
    const earnable = roundMoney(Math.max(0, subtotal - discount));

    // EARN: gated on the tenant fidelity earn settings (fidelity_enabled + points_enabled +
    // earn step) AND the appointment-specific toggle (legacy earn_on_appointment_done — a
    // tenant can enable points generally but NOT for completed appointments). CAMPAIGN-AWARE
    // like the POS checkout (live PHP<->Next verification 2026-07-02 caught the divergence:
    // the flat floor(earnable/step) awarded 1 point where the legacy awards 0): points accrue
    // ONLY under the ACTIVE fidelity campaign for today (no campaign => 0 — the flat step is
    // just the campaign default, NOT a fallback), applying its step/tiers + min_spend + card-
    // level eligibility. The campaign id is stamped on the appointment like on the sale.
    const earnSettings = await getFidelityEarnSettings(slug);
    // F2: come il legacy handleAppointmentStatusChange (~2603), un cliente non
    // aderente non accumula punti al completamento (il redeem prenotato viene
    // comunque regolato prima di questo blocco).
    if (earnSettings.enabled && (await fidelityEarnOnAppointmentDone(slug)) && (await fidelityIsClientAdhering(slug, clientId))) {
      const campaignEarn = await computeCampaignEarn(slug, earnable, clientId, earnSettings.earnStep);
      const pointsEarned = campaignEarn.points;
      if (pointsEarned > 0) {
        await addDbWalletMovement(
          {
            clientId,
            type: "points_earn",
            points: pointsEarned,
            source_type: "appointment",
            source_id: id,
            createdBy: createdBy && createdBy > 0 ? createdBy : undefined,
            note: `Punti appuntamento #${id}`,
          },
          slug,
        );
        await tenantUpdate({ slug, table: "appointments", id, values: { fidelity_points_earned: pointsEarned, fidelity_campaign_id: campaignEarn.campaignId > 0 ? campaignEarn.campaignId : null } });
      }
    }

    // REDEEM (reserved): settle the points the appointment reserved at booking time (currently
    // always 0 — the drawer fidelity row is inert/Block 4 — so this is dormant but ported
    // faithfully). Idempotent: only when no points_redeem transaction already exists for this
    // appointment (so a re-settle never double-debits the wallet).
    if (pointsUsed > 0) {
      const existingRedeem = await tenantSelect<RowDataPacket>({
        slug,
        table: "transactions",
        columns: "id",
        where: "client_id = ? AND kind = 'redeem' AND source_type = 'appointment' AND source_id = ?",
        params: [clientId, id],
        limit: 1,
      });
      if (!existingRedeem[0]) {
        await addDbWalletMovement(
          {
            clientId,
            type: "points_redeem",
            points: -pointsUsed,
            source_type: "appointment",
            source_id: id,
            createdBy: createdBy && createdBy > 0 ? createdBy : undefined,
            note: `Riscatto punti appuntamento #${id}`,
          },
          slug,
        );
      }
    }
  } catch {
    // BEST-EFFORT: a fidelity error must NEVER fail the status change. Swallowed here in
    // addition to the caller's .catch so a partial failure (e.g. the stamp after the earn)
    // is contained.
  }
}

// The recharge ledger note — faithful to the legacy "Ricarica credito: € base • +N Punti • user".
function rechargeNote(baseAmount: number, bonusAmount: number, pointsEarned: number, userNote?: string): string {
  const parts = [`Ricarica credito: € ${formatMoney(baseAmount)}`];
  if (bonusAmount > 0.00001) parts.push(`bonus € ${formatMoney(bonusAmount)}`);
  if (pointsEarned > 0.00001) parts.push(`+${pointsEarned} Punti`);
  const note = clean(userNote, 180);
  if (note) parts.push(note);
  return clean(parts.join(" • "), 255);
}

// Marker stored on the issue giftcard_transactions row (note + meta_json) so a later sale
// VOID can find the giftcard this sale ISSUED — the giftcards table has no sale_id column,
// so the sale linkage rides on the issue ledger entry. cancelLinkedSaleResidues parses it
// back to flip the issued card to 'cancelled' (kept distinct from a RESIDUI giftcard that
// was merely spent on the sale — that is a different card, keyed off sales.giftcard_id).
const GIFTCARD_SALE_MARKER = "[possale:";

// Marker stored on the issued giftbox_instances.note so a later sale VOID can find the
// giftbox(es) this sale ISSUED — the giftbox_instances table has NO sale_id column, so the
// sale linkage rides on the note (faithful to the legacy 'Vendita #saleId' note convention).
// cancelLinkedSaleResidues parses it back to flip the issued instance to 'cancelled'. Kept
// distinct from the drawer's giftbox-redeem restore (that reverses a CONSUMED giftbox via
// giftbox_redemptions, a different operation), so the two never collide.
const GIFTBOX_SALE_MARKER = "Vendita #";

// SELL a GiftCard at checkout — faithful port of GiftCard::issueGiftCard (app/lib/GiftCard.php
// ~1465) + the pos.php issue_giftcard action (~2781). Inserts a `giftcards` row owned by the
// recipient (recipient_client_id, so it surfaces in their residui/voucher) with a unique
// uppercase CODE, initial_amount + balance = the line amount, status='active', issued_at,
// expires_at (from the giftcard validity setting, default +12 months / +365d), location_id,
// and the voucher fields (voucher_public_token + voucher_hide_amount / email_show_amount).
// Also writes the 'issue' giftcard_transactions ledger row tagged with the sale id (note +
// meta_json) for the void reversal. Returns the new giftcards id (0 when not issued).
// Optional issue email is OUT OF SCOPE (the giftcard-send cron delivers it) — see TODO below.
// Result of issuing a GiftCard/GiftBox at checkout: the new row id (0 when nothing was issued)
// + the IssuedVoucher (code/recipient/amount) when a card/box was actually created, so the
// checkout loop can collect it for the receipt. `voucher` is null on a skip (no recipient,
// missing table, zero amount).
type IssueResult = { id: number; voucher: IssuedVoucher | null };

async function issueGiftcardFromSale(slug: string, saleId: number, clientId: number, item: PosSaleItem, locationId: number): Promise<IssueResult> {
  const giftcardTable = await tenantTable(slug, "giftcards").catch(() => null);
  if (!giftcardTable) return { id: 0, voucher: null };

  // Amount = the line price (qty is forced to 1, so total === unitPrice). Faithful to the
  // legacy sale_items row: 1 @ amount. Skip silently when the amount is not positive.
  const amount = roundMoney(Math.max(0, item.total > 0 ? item.total : item.unitPrice));
  if (amount <= 0) return { id: 0, voucher: null };

  // Owner = the recipient client the staff picked (defaults to the sale buyer). A card with
  // no owner cannot show in any residui, so a bench sale with no recipient is skipped.
  const recipientClientId = Math.max(0, Number(item.recipientClientId ?? 0) || 0) || (clientId > 0 ? clientId : 0);
  const hasRecipientColumn = await columnExists(giftcardTable.name, "recipient_client_id");
  if (recipientClientId <= 0 && (!item.recipientName || !item.recipientName.trim())) return { id: 0, voucher: null };

  const recipientName = clean(item.recipientName, 120)
    || (recipientClientId > 0 ? await clientName(slug, recipientClientId) : "")
    || "Destinatario";
  const recipientEmail = clean(item.recipientEmail, 190) || null;

  // CODE: honour a custom uppercase code (must be unique), else generate a unique one in the
  // legacy GC-XXXX-XXXX-XXXX format (unambiguous alphabet, no O/0 or I/1).
  const code = await resolveUniqueGiftcardCode(slug, giftcardTable.name, item.code);

  // EXPIRY: the custom "Valida al" the staff set, else the giftcard validity default from
  // the businesses settings (value + unit), else +365d (task fallback ~12 months).
  const issuedAtYmd = todayIso();
  let expiresAt: string | null = item.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt) ? item.expiresAt : null;
  if (!expiresAt) expiresAt = await defaultGiftcardExpiry(slug, issuedAtYmd);

  const hideAmount = item.hideAmount === true ? 1 : 0;
  const hasTokenColumn = await columnExists(giftcardTable.name, "voucher_public_token");

  // Invio email legacy (items[gc_send_mode/gc_send_on]): 'date' pianifica via
  // scheduled_send_on (cron giftcard-send); 'now' invia subito al Concludi
  // (best-effort, vedi sotto); 'none' non invia. Default legacy: 'now'.
  const sendMode: "none" | "now" | "date" = item.sendMode === "none" || item.sendMode === "date" ? item.sendMode : "now";
  const sendOn = item.sendOn && /^\d{4}-\d{2}-\d{2}$/.test(item.sendOn) ? item.sendOn : null;
  // "Mostra importo e contenuto nella mail" (checkbox dedicato, default 1).
  const showAmount = item.showAmount === undefined ? true : item.showAmount === true;
  const customerNote = clean(item.note, 500);

  const giftcardId = await tenantInsert(giftcardTable, await filterColumns(giftcardTable.name, {
    voucher_public_token: hasTokenColumn ? randomHex(64) : undefined,
    code,
    client_id: clientId > 0 ? clientId : null,
    recipient_client_id: hasRecipientColumn ? (recipientClientId > 0 ? recipientClientId : null) : undefined,
    recipient_name: recipientName,
    recipient_email: recipientEmail,
    event_type: clean(item.eventType, 32) || "giftcard",
    voucher_hide_amount: hideAmount,
    email_show_amount: showAmount ? 1 : 0,
    initial_amount: amount,
    balance: amount,
    currency: "EUR",
    status: "active",
    issued_at: new Date(),
    expires_at: expiresAt,
    gift_message: clean(item.message, 2000) || null,
    // "Nota per il cliente" + marker vendita (il dettaglio ricava linkedSaleId
    // dal pattern "Vendita #N").
    note: customerNote ? `${customerNote}\nEmessa da vendita #${saleId}` : `Emessa da vendita #${saleId}`,
    internal_note: clean(item.internalNote, 2000) || null,
    scheduled_send_on: sendMode === "date" && sendOn ? sendOn : null,
    location_id: locationId > 0 ? locationId : null,
  })).catch(() => 0);
  if (!giftcardId) return { id: 0, voucher: null };

  // Invio immediato ("Invia subito alla conclusione della vendita"): best-effort
  // come il legacy — un errore SMTP non blocca la vendita.
  if (sendMode === "now" && recipientEmail) {
    try {
      const { sendGiftCardEmailManage } = await import("@/lib/gift-issue-details");
      await sendGiftCardEmailManage(slug, giftcardId, recipientEmail, showAmount, clean(item.message, 2000));
    } catch {
      // invio non disponibile/fallito: la GiftCard resta emessa
    }
  }

  // 'issue' ledger row, tagged with the sale id (note marker + meta_json) so the void
  // reversal can find this exact card. Best-effort: a missing transactions table is a no-op.
  const txTable = await tenantTable(slug, "giftcard_transactions").catch(() => null);
  if (txTable) {
    await tenantInsert(txTable, await filterColumns(txTable.name, {
      giftcard_id: giftcardId,
      type: "issue",
      amount,
      note: `Emissione GiftCard ${GIFTCARD_SALE_MARKER}${saleId}]`,
      meta_json: JSON.stringify({ source: "sale", sale_id: saleId }),
      created_at: new Date(),
      location_id: locationId > 0 ? locationId : null,
    })).catch(() => undefined);
  }

  // TODO: optional issue email (recipient_email / scheduled_send_on). Out of scope here —
  // the giftcard-send cron (GiftCard::sendDueScheduledGiftCards) handles delivery.
  return { id: giftcardId, voucher: { type: "giftcard", code, recipientName, amount } };
}

// Unique uppercase giftcard CODE — port of GiftCard::generateCode (GC-XXXX-XXXX-XXXX,
// unambiguous alphabet) + the issueGiftCard 20-try uniqueness loop, mirroring the
// generateUniqueAppointmentPublicCode pattern. A staff-supplied custom code is honoured
// when free (uppercased, <= 24 chars); otherwise codes are generated until one is unused.
async function resolveUniqueGiftcardCode(slug: string, tableName: string, customCode?: string): Promise<string> {
  const custom = clean(customCode, 24).toUpperCase();
  if (custom && !(await giftcardCodeExists(slug, tableName, custom))) return custom;
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateGiftcardCode();
    if (!(await giftcardCodeExists(slug, tableName, code))) return code;
  }
  // Extremely unlikely fallthrough: append a timestamp suffix to force uniqueness.
  return generateGiftcardCode().slice(0, 16) + Date.now().toString(36).toUpperCase().slice(-4);
}

async function giftcardCodeExists(slug: string, tableName: string, code: string): Promise<boolean> {
  if (!code) return false;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: tableName,
    columns: "id",
    where: "code = ?",
    params: [code],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

// GC-XXXX-XXXX-XXXX with the legacy unambiguous alphabet (no O/0, I/1) — GiftCard::generateCode.
function generateGiftcardCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n: number): string => {
    let out = "";
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  };
  return `GC-${pick(4)}-${pick(4)}-${pick(4)}`;
}

// Default giftcard expiry when the staff leaves "Valida al" blank — port of the legacy
// issueGiftCard auto-expiry: read businesses.giftcard_default_validity_value/_unit
// (days/months/years) and add it to the issue date. Falls back to +365d (~12 months, the
// task default) when the setting is unset/zero or the column is missing. Returns YYYY-MM-DD.
async function defaultGiftcardExpiry(slug: string, issuedAtYmd: string): Promise<string> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "giftcard_default_validity_value, giftcard_default_validity_unit",
      orderBy: "id ASC",
      limit: 1,
    });
    const row = rows[0];
    const value = Math.max(0, Math.floor(Number(row?.giftcard_default_validity_value ?? 0) || 0));
    const unit = String(row?.giftcard_default_validity_unit ?? "days").toLowerCase();
    if (value > 0) {
      if (unit === "months") return addMonthsIso(issuedAtYmd, value);
      if (unit === "years") return addMonthsIso(issuedAtYmd, value * 12);
      return addDaysIso(issuedAtYmd, value);
    }
  } catch {
    // missing column / table -> fall through to the +365d default
  }
  return addDaysIso(issuedAtYmd, 365);
}

// SELL a GiftBox at checkout — faithful port of GiftBox::issueInstance (app/lib/GiftBox.php
// ~2438) for the CORE TEMPLATE sale. Inserts a `giftbox_instances` row OWNED by the recipient
// (recipient_client_id = the chosen recipient, defaulting to the sale buyer — THIS is what
// makes it appear in their residui + lets the drawer's giftbox redeem consume it) with a unique
// GBX-XXXXXX code, status 'issued' (the value the redeem reader treats as available), issued_at,
// expires_at (the custom "Valida al", else the template expires_after_days, else the settings
// default, else +180d), a voucher_public_token, the event/dedica/hide-amount voucher fields, and
// the sale-linkage note ('Vendita #saleId'). Then copies EACH template giftbox_items row into
// giftbox_instance_items (giftbox_item_id = the template item id, item_type/service_id/product_id/
// qty/custom_label) so the redeem reader sees the box contents. Returns the new instance id (0
// when not issued). Optional issue email is OUT OF SCOPE (see TODO). The box PRICE is the line
// price (qty 1) — set as the sale_items line, so the sale TOTAL equals the giftbox price.
// Materialise a ONE-OFF ("custom build") giftbox TEMPLATE from the chosen cart items, faithful to
// the legacy pos.php issue_giftbox → GiftBox::saveGiftBox (~2598-2667): a transient giftboxes row
// (name "GiftBox per <recipient> • DD/MM/YYYY", eligibility all_clients, points_cost 0, active) +
// one giftbox_items row per selected service/product. Returns the new giftboxes id (0 on failure),
// which issueGiftboxFromSale then treats exactly like a pre-defined template (copying its items
// into giftbox_instance_items). NOT reused across sales — each custom box gets its own template.
async function saveGiftboxFromCart(slug: string, item: PosSaleItem, recipientLabel: string): Promise<number> {
  const items = item.customItems ?? [];
  if (!items.length) return 0;
  const table = await tenantTable(slug, "giftboxes").catch(() => null);
  if (!table) return 0;
  const [y, m, d] = todayIso().split("-");
  const name = clean(`GiftBox per ${recipientLabel || "Cliente"} • ${d}/${m}/${y}`, 190);
  const validTo = item.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt) ? item.expiresAt : null;
  const giftboxId = await tenantInsert(table, await filterColumns(table.name, {
    name,
    description: "GiftBox personalizzata composta dal carrello",
    eligibility: "all_clients",
    points_cost: 0,
    active: 1,
    sort_order: 0,
    valid_to: validTo,
    created_at: new Date(),
    updated_at: new Date(),
  })).catch(() => 0);
  if (!giftboxId) return 0;

  const itemsTable = await tenantTable(slug, "giftbox_items").catch(() => null);
  if (itemsTable) {
    for (const [index, ci] of items.entries()) {
      const isProduct = ci.type === "product";
      await tenantInsert(itemsTable, await filterColumns(itemsTable.name, {
        giftbox_id: giftboxId,
        item_type: isProduct ? "product" : "service",
        service_id: isProduct ? null : (ci.id > 0 ? ci.id : null),
        product_id: isProduct ? (ci.id > 0 ? ci.id : null) : null,
        qty: Math.max(1, Number(ci.qty ?? 1) || 1),
        sort_order: index,
        created_at: new Date(),
        updated_at: new Date(),
      })).catch(() => undefined);
    }
  }
  return giftboxId;
}

async function issueGiftboxFromSale(slug: string, saleId: number, clientId: number, item: PosSaleItem, locationId: number): Promise<IssueResult> {
  const instanceTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  if (!instanceTable) return { id: 0, voucher: null };

  // The chosen giftboxes TEMPLATE (the cart line refId), OR — for a CUSTOM build (refId 0 with
  // cart contents) — a transient template materialised on the fly from the chosen cart items
  // (port of pos.php issue_giftbox → GiftBox::saveGiftBox before issueInstance). Either way, from
  // here on giftboxId is a real giftboxes row whose giftbox_items get copied into the instance.
  let giftboxId = Math.max(0, Number(item.refId ?? 0) || 0);
  if (giftboxId <= 0 && item.customItems && item.customItems.length > 0) {
    const buildLabel = clean(item.recipientName, 120)
      || (Number(item.recipientClientId ?? 0) > 0 ? await clientName(slug, Number(item.recipientClientId)) : "")
      || (clientId > 0 ? await clientName(slug, clientId) : "")
      || "Cliente";
    giftboxId = await saveGiftboxFromCart(slug, item, buildLabel);
  }
  if (giftboxId <= 0) return { id: 0, voucher: null };
  const template = await giftboxTemplateRow(slug, giftboxId);
  if (!template) return { id: 0, voucher: null };

  // The box PRICE is the line price (qty 1) — surfaced on the receipt voucher (the box is sold
  // at this amount; the giftboxes table itself has no price column).
  const amount = roundMoney(Math.max(0, item.total > 0 ? item.total : item.unitPrice));

  // Owner = the recipient client the staff picked (defaults to the sale buyer). An instance
  // with no owner cannot show in any residui, so a bench sale with no recipient is skipped.
  const recipientClientId = Math.max(0, Number(item.recipientClientId ?? 0) || 0) || (clientId > 0 ? clientId : 0);
  const hasRecipientColumn = await columnExists(instanceTable.name, "recipient_client_id");
  if (recipientClientId <= 0 && (!item.recipientName || !item.recipientName.trim())) return { id: 0, voucher: null };

  const recipientName = clean(item.recipientName, 120)
    || (recipientClientId > 0 ? await clientName(slug, recipientClientId) : "")
    || "Destinatario";
  const recipientEmail = clean(item.recipientEmail, 190) || null;

  // Unique GBX-XXXXXX code (port of GiftBox::generateCode + the 25-try uniqueness loop).
  const code = await resolveUniqueGiftboxCode(slug, instanceTable.name);

  // EXPIRY: the custom "Valida al" the staff set, else today + the template expires_after_days,
  // else the giftbox settings default (value + unit), else +180d (task fallback). YYYY-MM-DD.
  const issuedAtYmd = todayIso();
  let expiresAt: string | null = item.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt) ? item.expiresAt : null;
  if (!expiresAt) {
    const templateDays = Math.max(0, Number(template.expires_after_days ?? 0) || 0);
    if (templateDays > 0) expiresAt = addDaysIso(issuedAtYmd, templateDays);
  }
  if (!expiresAt) expiresAt = await defaultGiftboxExpiry(slug, issuedAtYmd);

  const hideAmount = item.hideAmount === true ? 1 : 0;
  const hasTokenColumn = await columnExists(instanceTable.name, "voucher_public_token");

  // Invio email legacy (giftbox_send_mode/giftbox_send_on): come la giftcard.
  const sendMode: "none" | "now" | "date" = item.sendMode === "none" || item.sendMode === "date" ? item.sendMode : "now";
  const sendOn = item.sendOn && /^\d{4}-\d{2}-\d{2}$/.test(item.sendOn) ? item.sendOn : null;
  const showDetails = item.showAmount === undefined ? true : item.showAmount === true;
  const customerNote = clean(item.note, 500);

  const instanceId = await tenantInsert(instanceTable, await filterColumns(instanceTable.name, {
    voucher_public_token: hasTokenColumn ? randomHex(64) : undefined,
    giftbox_id: giftboxId,
    code,
    client_id: clientId > 0 ? clientId : null,
    recipient_client_id: hasRecipientColumn ? (recipientClientId > 0 ? recipientClientId : null) : undefined,
    recipient_name: recipientName,
    recipient_email: recipientEmail,
    event_type: clean(item.eventType, 40) || "giftbox",
    voucher_hide_amount: hideAmount,
    email_show_details: showDetails ? 1 : 0,
    // status 'issued' is what the residui/redeem readers treat as available (NOT 'active').
    status: "issued",
    issued_at: new Date(),
    expires_at: expiresAt,
    points_cost: 0,
    gift_message: clean(item.message, 2000) || null,
    // "Nota per il cliente" + marker vendita (no sale_id column on giftbox_instances).
    note: customerNote ? `${customerNote}\n${GIFTBOX_SALE_MARKER}${saleId}` : `${GIFTBOX_SALE_MARKER}${saleId}`,
    internal_note: clean(item.internalNote, 2000) || null,
    scheduled_send_on: sendMode === "date" && sendOn ? sendOn : null,
    location_id: locationId > 0 ? locationId : null,
  })).catch(() => 0);
  if (!instanceId) return { id: 0, voucher: null };

  // Copy EACH template giftbox_items row into giftbox_instance_items: the redeem reader keys
  // the per-item residual off giftbox_instance_items.giftbox_item_id (= the template item id),
  // so this is what makes the box redeemable. Best-effort per row (a missing items table is a
  // no-op); a template with no items still issues (an empty but valid voucher).
  const itemsTable = await tenantTable(slug, "giftbox_instance_items").catch(() => null);
  if (itemsTable) {
    const templateItems = await giftboxTemplateItems(slug, giftboxId);
    for (const [index, tplItem] of templateItems.entries()) {
      if (tplItem.giftboxItemId <= 0) continue;
      await tenantInsert(itemsTable, await filterColumns(itemsTable.name, {
        instance_id: instanceId,
        giftbox_item_id: tplItem.giftboxItemId,
        item_type: tplItem.itemType,
        service_id: tplItem.itemType === "service" && tplItem.serviceId > 0 ? tplItem.serviceId : null,
        product_id: tplItem.itemType === "product" && tplItem.productId > 0 ? tplItem.productId : null,
        qty: tplItem.qty,
        custom_label: tplItem.label || null,
        sort_order: index,
      })).catch(() => undefined);
    }
  }

  // Invio immediato ("Invia subito alla conclusione della vendita"): best-effort.
  if (sendMode === "now" && recipientEmail) {
    try {
      const { sendGiftBoxInstanceEmail } = await import("@/lib/gift-issue-details");
      await sendGiftBoxInstanceEmail(slug, instanceId, recipientEmail, showDetails, clean(item.message, 2000));
    } catch {
      // invio non disponibile/fallito: la GiftBox resta emessa
    }
  }

  return { id: instanceId, voucher: { type: "giftbox", code, recipientName, amount } };
}

async function giftboxTemplateRow(slug: string, giftboxId: number): Promise<RowDataPacket | null> {
  if (giftboxId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", where: "id=?", params: [giftboxId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? null;
}

// Unique GBX-XXXXXX giftbox instance CODE — port of GiftBox::generateCode (unambiguous
// alphabet, no O/0 or I/1) + the issueInstance 25-try uniqueness loop, mirroring the giftcard
// resolveUniqueGiftcardCode pattern. Codes are generated until one is unused in giftbox_instances.
async function resolveUniqueGiftboxCode(slug: string, tableName: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = generateGiftboxCode();
    if (!(await giftboxCodeExists(slug, tableName, code))) return code;
  }
  // Extremely unlikely fallthrough: append a timestamp suffix to force uniqueness (<= 20 chars).
  return (`GBX-${Date.now().toString(36).toUpperCase()}`).slice(0, 20);
}

async function giftboxCodeExists(slug: string, tableName: string, code: string): Promise<boolean> {
  if (!code) return false;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: tableName,
    columns: "id",
    where: "code = ?",
    params: [code],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

// GBX-XXXXXX with the legacy unambiguous alphabet (no O/0, I/1) — GiftBox::generateCode.
function generateGiftboxCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `GBX-${out}`;
}

// Default giftbox expiry when the staff leaves "Valida al" blank AND the template has no
// expires_after_days — port of the issueInstance settings fallback: read businesses
// giftbox_default_validity_value/_unit (days/months/years) and add it to the issue date. Falls
// back to +180d (the task default, matching issueDbGiftBox) when unset/zero or the column is
// missing. Returns YYYY-MM-DD.
async function defaultGiftboxExpiry(slug: string, issuedAtYmd: string): Promise<string> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "giftbox_default_validity_value, giftbox_default_validity_unit",
      orderBy: "id ASC",
      limit: 1,
    });
    const row = rows[0];
    const value = Math.max(0, Math.floor(Number(row?.giftbox_default_validity_value ?? 0) || 0));
    const unit = String(row?.giftbox_default_validity_unit ?? "days").toLowerCase();
    if (value > 0) {
      if (unit === "months") return addMonthsIso(issuedAtYmd, value);
      if (unit === "years") return addMonthsIso(issuedAtYmd, value * 12);
      return addDaysIso(issuedAtYmd, value);
    }
  } catch {
    // missing column / table -> fall through to the +180d default
  }
  return addDaysIso(issuedAtYmd, 180);
}

// start-date + N months as YYYY-MM-DD with day clamping (port of GiftCard::addMonthsClamped).
function addMonthsIso(startYmd: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startYmd);
  if (!m) return addDaysIso(startYmd, Math.max(0, months) * 30);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const total = year * 12 + (month - 1) + Math.max(0, Math.floor(months));
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  const dim = new Date(ny, nmo, 0).getDate();
  const nd = Math.min(day, dim);
  return `${ny}-${String(nmo).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

// today/start-date + N days as YYYY-MM-DD (pkAddDurationYmd 'days' base case).
function addDaysIso(startYmd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startYmd);
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  base.setDate(base.getDate() + Math.max(0, Math.floor(days)));
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
}

async function clientName(slug: string, clientId: number): Promise<string> {
  if (clientId <= 0) return "Cliente banco";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name", where: "id=?", params: [clientId], limit: 1 }).catch(() => []);
  return String(rows[0]?.full_name ?? "Cliente");
}

async function serviceLocationFilter(slug: string, locationId: number): Promise<{ sql: string; params: unknown[] }> {
  if (locationId <= 0) return { sql: "", params: [] };
  const table = await tenantTable(slug, "service_locations").catch(() => null);
  if (!table) return { sql: "", params: [] };
  const tenantClause = table.mode === "shared" && await columnExists(table.name, "tenant_id") ? " AND sl.tenant_id=s.tenant_id" : "";
  return {
    sql: `AND (EXISTS(SELECT 1 FROM ${quoteIdentifier(table.name)} sl WHERE sl.service_id=s.id AND sl.location_id=?${tenantClause}) OR NOT EXISTS(SELECT 1 FROM ${quoteIdentifier(table.name)} sl_any WHERE sl_any.service_id=s.id${tenantClause.replaceAll("sl.", "sl_any.")}))`,
    params: [locationId],
  };
}

async function serviceLocationMap(slug: string, serviceIds: number[]): Promise<Map<number, number[]>> {
  const ids = serviceIds.filter((id) => id > 0);
  const map = new Map<number, number[]>();
  if (!ids.length) return map;
  const table = await tenantTable(slug, "service_locations").catch(() => null);
  if (!table) return map;
  const scope = await tenantScope(table, [`service_id IN (${ids.map(() => "?").join(",")})`], ids);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT service_id, location_id FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  for (const row of rows) {
    const serviceId = Number(row.service_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (serviceId <= 0 || locationId <= 0) continue;
    const list = map.get(serviceId) ?? [];
    list.push(locationId);
    map.set(serviceId, list);
  }
  return map;
}

function summarizeSales(sales: PosSale[]): PosSummary {
  const activeSales = sales.filter((sale) => sale.status !== "cancelled");
  const cancelledSales = sales.filter((sale) => sale.status === "cancelled");
  const paymentTotals: Record<PosPaymentMethod, number> = { cash: 0, card: 0, check: 0, transfer: 0, giftcard: 0, wallet: 0 };
  let serviceTotal = 0;
  let productTotal = 0;
  for (const sale of activeSales) {
    for (const payment of sale.payments) paymentTotals[payment.method] = roundMoney(paymentTotals[payment.method] + payment.amount);
    for (const item of sale.items) {
      if (item.type === "service") serviceTotal = roundMoney(serviceTotal + item.total);
      if (item.type === "product") productTotal = roundMoney(productTotal + item.total);
    }
  }
  return {
    saleCount: activeSales.length,
    grossTotal: roundMoney(sales.reduce((sum, sale) => sum + sale.total, 0)),
    activeTotal: roundMoney(activeSales.reduce((sum, sale) => sum + sale.total, 0)),
    cancelledTotal: roundMoney(cancelledSales.reduce((sum, sale) => sum + sale.total, 0)),
    paymentTotals,
    serviceTotal,
    productTotal,
  };
}

// Reconstruct the tenders from the stored sale row: the residui from credit_used /
// giftcard_used (+ the linked giftcard_id), and the remainder as the persisted base
// method (cash/card/transfer) — read back faithfully instead of always "card".
function derivePayments(row: RowDataPacket, total: number): PosPayment[] {
  const wallet = roundMoney(Number(row.credit_used ?? 0) || 0);
  const giftcard = roundMoney(Number(row.giftcard_used ?? 0) || 0);
  const giftcardId = Math.max(0, Number(row.giftcard_id ?? 0) || 0);
  const base = roundMoney(Math.max(0, total - wallet - giftcard));
  const baseMethod = readStoredBaseMethod(row);
  const payments: PosPayment[] = [];
  let id = 1;
  if (wallet > 0) payments.push({ id: id++, method: "wallet", amount: wallet });
  if (giftcard > 0) payments.push({ id: id++, method: "giftcard", amount: giftcard, giftcardId: giftcardId > 0 ? giftcardId : undefined });
  if (base > 0 || !payments.length) payments.push({ id, method: baseMethod, amount: base || total });
  return payments;
}

function normalizePayments(payments: PosPaymentInput[], total: number): PosPayment[] {
  const out = payments
    .map((payment, index) => ({
      id: index + 1,
      method: normalizePaymentMethod(payment.method),
      amount: roundMoney(Math.max(0, Number(payment.amount ?? 0) || 0)),
      giftcardId: Math.max(0, Number(payment.giftcardId ?? 0) || 0) || undefined,
    }))
    .filter((payment) => payment.amount > 0);
  if (!out.length && total > 0) return [{ id: 1, method: "card", amount: total }];
  return out;
}

function paymentAmount(payments: PosPayment[], method: PosPaymentMethod): number {
  return roundMoney(payments.filter((payment) => payment.method === method).reduce((sum, payment) => sum + payment.amount, 0));
}

// The faithful single base payment method (Contanti/Carta/Assegno/Bonifico) that covers
// the remainder after residui. The wallet/giftcard tenders are residui, NOT the base
// method, so they are excluded here; the first non-residual tender wins, defaulting to
// "card" (mirrors the legacy single payment_type radio).
function resolveBaseMethod(payments: PosPayment[]): PosPaymentMethod {
  const base = payments.find((payment) => payment.method !== "wallet" && payment.method !== "giftcard");
  return base ? base.method : "card";
}

type ResiduiTenders = { creditUsed: number; giftcardId: number; giftcardUsed: number; giftcardCode: string };

// Validate + clamp the residui tenders (wallet CREDIT + one GiftCard) against the
// client's real balances and the sale total. Throws on an over-spend so the checkout
// fails cleanly BEFORE any row is written. Returns the amounts actually consumable.
async function resolveResiduiTenders(
  slug: string,
  payments: PosPayment[],
  clientId: number,
  total: number,
): Promise<ResiduiTenders> {
  const creditReq = paymentAmount(payments, "wallet");
  const giftcardReq = paymentAmount(payments, "giftcard");
  if (creditReq <= 0 && giftcardReq <= 0) return { creditUsed: 0, giftcardId: 0, giftcardUsed: 0, giftcardCode: "" };
  // Messaggi verbatim legacy (pos.php 3187/3194).
  if (clientId <= 0) {
    throw new Error(giftcardReq > 0 ? "Per usare una GiftCard devi selezionare un cliente." : "Per usare il credito devi selezionare un cliente.");
  }

  // GiftCard first (legacy order): the picked card's id rides on the giftcard tender.
  let giftcardId = 0;
  let giftcardUsed = 0;
  let giftcardCode = "";
  if (giftcardReq > 0) {
    const tender = payments.find((payment) => payment.method === "giftcard" && payment.amount > 0);
    giftcardId = Math.max(0, Number(tender?.giftcardId ?? 0) || 0);
    if (giftcardId <= 0) throw new Error("Seleziona la GiftCard da usare tra i residui del cliente.");
    const available = (await dbClientGiftcards(slug, clientId)).find((card) => card.id === giftcardId);
    if (!available) throw new Error("La GiftCard selezionata non è disponibile tra i residui del cliente.");
    giftcardCode = available.code;
    giftcardUsed = roundMoney(Math.min(giftcardReq, available.balance, total));
    if (giftcardUsed + 0.00001 < giftcardReq) throw new Error("Saldo GiftCard non disponibile.");
  }

  // Credit covers what is left of the total after the giftcard.
  let creditUsed = 0;
  if (creditReq > 0) {
    const { credit } = await dbWalletBalance(clientId, slug);
    const remaining = roundMoney(Math.max(0, total - giftcardUsed));
    creditUsed = roundMoney(Math.min(creditReq, Math.max(0, credit), remaining));
    if (creditUsed + 0.00001 < creditReq) throw new Error("Credito insufficiente (saldo modificato da un'altra operazione). Riprova.");
  }

  return { creditUsed, giftcardId, giftcardUsed, giftcardCode };
}

type FidelityRedemption = { pointsUsed: number; discount: number };

// Validate + convert a FIDELITY points redemption request into an euro discount, faithful
// to pos.php (~4517-4566) + Fidelity::normalizeRedeem. Points are whole; the discount is
// pointsUsed x euroPerPoint, capped by the client's balance AND by `baseAmount` (what is
// still payable after the manual + coupon discount). Throws cleanly on an over-spend /
// below-minimum BEFORE any row is written. Returns {0,0} when no redemption is requested
// or redemption is disabled.
async function resolveFidelityRedemption(
  slug: string,
  clientId: number,
  requestedPointsUse: number,
  baseAmount: number,
): Promise<FidelityRedemption> {
  const requested = normalizePoints(Math.max(0, Number(requestedPointsUse) || 0));
  if (requested <= 0) return { pointsUsed: 0, discount: 0 };

  const settings = await getFidelityRedeemSettings(slug);
  if (!settings.redeemEnabled) throw new Error("Sconto punti non abilitato.");
  if (clientId <= 0) throw new Error("Seleziona un cliente per usare i punti.");
  // F2: adesione tessera richiesta anche in cassa (pos.php ~4520: il redeem
  // legacy rifiuta i non aderenti; availablePoints=0 senza tessera).
  if (!(await fidelityIsClientAdhering(slug, clientId))) throw new Error("Cliente non aderisce alla Fidelity.");

  // Expire-on-read: i punti scaduti non sono spendibili (Fidelity::availablePoints).
  const lotsSettings = await fidelityLotsSettings(slug).catch(() => ({ expireEnabled: false, expireDays: 0, expireWarnDays: 0 }));
  if (lotsSettings.expireEnabled) await expireClientLots(slug, clientId).catch(() => 0);

  const { points } = await dbWalletBalance(clientId, slug);
  const available = normalizePoints(Math.max(0, points));
  if (available <= 0) throw new Error("Punti non disponibili.");
  if (requested > available) throw new Error("Punti insufficienti.");
  if (settings.minPoints > 0 && requested < settings.minPoints) {
    throw new Error(`Minimo punti utilizzabile: ${settings.minPoints}.`);
  }
  if (baseAmount <= 0.00001) throw new Error("Importo insufficiente per applicare lo sconto punti.");

  // Cap the points used by the payable amount (whole points only), then derive the euro
  // discount and hard-clamp it to baseAmount (legacy normalizeRedeem).
  const maxByAmount = normalizePoints(baseAmount / settings.euroPerPoint);
  let pointsUsed = Math.min(requested, available, maxByAmount);
  if (pointsUsed <= 0) return { pointsUsed: 0, discount: 0 };
  if (settings.minPoints > 0 && pointsUsed < settings.minPoints) {
    throw new Error("Con l'importo attuale non puoi usare il minimo punti richiesto.");
  }
  let discount = roundMoney(pointsUsed * settings.euroPerPoint);
  if (discount > baseAmount + 0.000001) {
    discount = roundMoney(baseAmount);
    pointsUsed = normalizePoints(discount / settings.euroPerPoint);
    discount = roundMoney(pointsUsed * settings.euroPerPoint);
  }
  if (pointsUsed <= 0 || discount <= 0) return { pointsUsed: 0, discount: 0 };
  return { pointsUsed, discount };
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(values).map(async ([key, value]) => [key, value, await columnExists(table, key)] as const),
  );
  return Object.fromEntries(entries.filter(([, value, exists]) => exists && value !== undefined).map(([key, value]) => [key, value]));
}

async function tenantScope(target: TenantTarget, clauses: string[], params: unknown[]) {
  const scopedClauses = [...clauses];
  const scopedParams = [...params];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    scopedClauses.unshift("tenant_id=?");
    scopedParams.unshift(target.tenantId ?? 0);
  }
  return { where: scopedClauses.length ? ` WHERE ${scopedClauses.join(" AND ")}` : "", params: scopedParams };
}

function normalizeLocationId(value: number, locations: Array<{ id: number }>): number {
  if (value > 0 && locations.some((location) => location.id === value)) return value;
  return locations.length === 1 ? locations[0]?.id ?? 0 : locations[0]?.id ?? 0;
}

function normalizePaymentMethod(value: unknown): PosPaymentMethod {
  const method = String(value ?? "").toLowerCase();
  if (method === "cash" || method === "card" || method === "check" || method === "transfer" || method === "giftcard" || method === "wallet") return method;
  return "card";
}

function normalizeStoredItemType(value: unknown): PosSaleItemType {
  const type = String(value ?? "").toLowerCase();
  if (type === "product") return "product";
  if (type === "giftcard") return "giftcard";
  if (type === "prepaid") return "prepaid";
  if (type === "package") return "package";
  if (type === "giftbox") return "giftbox";
  return "service";
}

function normalizeItemStatus(type: PosSaleItemType, value: unknown, hasClient: boolean): PosSaleItemStatus {
  const status = String(value ?? "").toLowerCase();
  if (type === "product") {
    if (status === "ordered" || status === "ordinato") return "ordered";
    return "collected";
  }
  if (type === "service") {
    if (status === "executed" || status === "done" || status === "eseguito") return "executed";
    if (status === "prepaid" || status === "prepagato") return "prepaid";
    // Default legacy (pos_normalize_sale_item_status): un servizio senza stato
    // esplicito è ESEGUITO — prepagato è sempre una scelta esplicita.
    return "executed";
  }
  return "prepaid";
}

function isCancelledStatus(value: unknown): boolean {
  return ["cancelled", "canceled", "annullata", "annullato"].includes(String(value ?? "").toLowerCase());
}

function cancelNote(saleId: number, userName: string, reason: string, stockMode: string, items: PosSaleItem[]): string {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const lines = [`[ANNULLATA ${now}] Vendita #${saleId} annullata dall'operatore ${userName || "Operatore"}.`, `Motivo: ${reason}.`];
  if (items.length) {
    const qty = items.reduce((sum, item) => sum + item.quantity, 0);
    lines.push(stockMode === "restore" ? `Magazzino prodotti ripristinato: ${qty} pezzi.` : `Magazzino prodotti non ripristinato: ${qty} pezzi.`);
  }
  return lines.join("\n");
}

// Titolo del modello ricarica per il nome riga legacy "Ricarica credito • <titolo>".
async function rechargeTemplateTitle(slug: string, templateId: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "recharge_templates", columns: "title", where: "id=?", params: [templateId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return clean(String(rows[0]?.title ?? ""), 120);
}

// "YYYY-MM-DD" -> "dd/mm/YYYY" (per i suffissi Inizio/Fine del nome riga pacchetto).
function italianDateLabel(value: string | undefined): string {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function fallbackItemName(type: PosSaleItemType): string {
  if (type === "giftcard") return "GiftCard";
  if (type === "package") return "Pacchetto";
  if (type === "giftbox") return "GiftBox";
  if (type === "prepaid") return "Prepagato";
  if (type === "recharge") return "Ricarica";
  return "Voce";
}

function productDisplayName(name: string, sku: string): string {
  return sku ? `${name} (${sku})` : name;
}

function emptyToNull(value: unknown): string | null {
  const text = clean(value, 255);
  return text || null;
}

// Marker appended to sales.notes so the base payment method survives even on installs
// whose sales table has no payment_methods column (derivePayments parses it back). The
// legacy POS likewise records the payment type as a notes line ("Tipo pagamento: ...").
const BASE_METHOD_MARKER = "[posmethod:";

// Etichette legacy per la riga note "Tipo pagamento: ..." (pos_payment_type_label).
const LEGACY_PAYMENT_TYPE_LABELS: Partial<Record<PosPaymentMethod, string>> = {
  cash: "Contanti",
  card: "Carta di Credito",
  check: "Assegno",
  transfer: "Bonifico",
};

function saleNotes(notes: unknown, appointmentId?: number, baseMethod?: PosPaymentMethod, installmentLine?: string, legacyLines?: string[]): string | null {
  const lines = [];
  const text = clean(notes, 2000);
  if (text) lines.push(text);
  // Righe scontrino legacy (Promozione/Coupon/Sconto manuale/GiftCard/Credito/Tipo pagamento).
  for (const line of legacyLines ?? []) if (line) lines.push(line);
  // Nota rateizzazione legacy (acconto/residuo/rate/prima scadenza).
  if (installmentLine) lines.push(installmentLine);
  if (appointmentId && appointmentId > 0) lines.push(`Appuntamento #${appointmentId}`);
  if (baseMethod) lines.push(`${BASE_METHOD_MARKER}${baseMethod}]`);
  return lines.length ? lines.join("\n") : null;
}

// Recover the persisted base payment method: prefer the structured payment_methods JSON
// (when the column exists), else the notes marker, defaulting to "card".
function readStoredBaseMethod(row: RowDataPacket): PosPaymentMethod {
  const raw = row.payment_methods;
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const base = normalizePaymentMethod((parsed as { base?: unknown })?.base);
      if (base === "cash" || base === "card" || base === "transfer") return base;
    } catch {
      // fall through to the notes marker
    }
  }
  const notes = String(row.notes ?? "");
  const at = notes.indexOf(BASE_METHOD_MARKER);
  if (at >= 0) {
    const end = notes.indexOf("]", at);
    if (end > at) return normalizePaymentMethod(notes.slice(at + BASE_METHOD_MARKER.length, end));
  }
  return "card";
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Fidelity points are always whole numbers (port of Fidelity::normalizePoints):
// floor toward zero with a tiny epsilon to absorb float leaks.
function normalizePoints(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 0) return Math.floor(n + 1e-9);
  if (n < 0) return Math.ceil(n - 1e-9);
  return 0;
}

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

// Lowercase hex token of `length` chars — used for the giftcard voucher_public_token (a
// 64-char public link/QR token kept separate from the operational code; port of
// GiftCard::generatePublicToken).
function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function formatMoney(value: number): string {
  return roundMoney(value).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// "YYYY-MM-DD HH:MM:SS" for the local now — matches the legacy date('Y-m-d H:i:s') used for
// client_prepaid_service_usages.used_at.
function nowDateTime(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

// A manual (out-of-appointment) prepaid usage note, faithful to
// ClientPrepaidServices::isManualUsageNote — the marker written by a manual execution.
function isManualUsageNote(note: unknown): boolean {
  return String(note ?? "").toLowerCase().includes("esecuzione manuale");
}

function dateTimeString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
