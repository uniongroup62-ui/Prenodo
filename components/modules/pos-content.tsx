"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Pixel-faithful port of the PHP POS "cassa" page (app/pages/pos.php, ?page=pos),
// fed by the existing DB-backed /api/manage/pos context.
//
// WIRED (core sale flow): load clients + service/product catalog from
// GET /api/manage/pos; select a client; click a catalog tile to add a cart line;
// qty +/- and remove per line; subtotal/discount/total in Italian "€ X,XX" format;
// manual discount (none/percent/fixed); the "Concludi" button POSTs action=checkout
// with items_json/payments_json and resets the cart on success (showing a success
// banner).
//
// WIRED (coupon preview): the coupon Apply/Remove buttons (couponApplyBtn /
// couponRemoveBtn) validate the typed code against POST /api/manage/coupons
// action=preview (the same endpoint the quick-booking drawer uses) with the current
// subtotal. On a valid coupon the discount is stored, the "Coupon (CODE) − € X,XX"
// row (posCodeDiscountRow) is revealed and SUBTRACTED from the total; the reason is
// shown on invalid. coupon_code is still sent on checkout (the backend re-validates,
// so the shown discount always equals the charged discount).
//
// WIRED (faithful payment + Residui): the legacy model is ONE base payment method
// (Contanti/Carta/Assegno/Bonifico) for the REMAINDER, plus "Residui" — the client's
// wallet CREDIT and a GiftCard balance can each cover part of the total. When a client
// is selected the panel fetches GET ?action=client_residuals&client_id= (credit +
// giftcards); the staff applies an amount from credit and/or a chosen giftcard, clamped
// to min(balance, remaining). base = total − credit_use − giftcard_use. The hidden
// inputs (#pos_credit_use / #pos_giftcard_id / #pos_giftcard_use) + the price rows
// (#posCreditRow / #posGiftcardRow) reflect the applied residui; checkout sends
// payments_json = [{wallet, credit_use}, {giftcard+giftcardId, giftcard_use},
// {baseMethod, remainder}] (non-zero only). Checkout is blocked when residui exceed
// the balances or the tendered sum < total (mirrors the backend validation + consume).
//
// WIRED (fidelity points redemption): when the selected client has points and the
// business has redemption enabled, the "Punti da usare" box (#posFidelityRedeemBox)
// reveals; the staff types points to spend (or "Max"), the € discount (punti x
// euroPerPoint, clamped to min(balance, floor(payable / euroPerPoint))) is shown on the
// "Sconto Punti" row (#posFidelityRow) and subtracted from the total, composed with the
// manual discount + coupon + residui. fidelity_points_use is sent on checkout; the
// backend re-validates against the live balance + redeem settings, applies the discount,
// and consumes the points (a points_redeem wallet movement). Checkout is blocked below
// the configured minimum or above the balance (mirrors the backend).
//
// WIRED (package + prepaid sale): the "Vendi pacchetto" modal sells a PACKAGE template
// (its price + a custom validity window/note) as a {type:"package"} cart line (qty 1);
// each SERVICE tile carries a "+ Prepagato" affordance that adds a {type:"prepaid"} line
// (qty = purchased sessions). Both flow through checkout's items_json. At checkout the
// backend issues a client_packages row (sessions read from the package template,
// start/expiry/note from the line) and a client_prepaid_services row (purchased_qty =
// line qty) — issuance is gated on a real client (a bench sale cannot issue).
//
// LEFT STATIC / NON-WIRED (rendered faithfully for visual fidelity only): the remaining
// advanced line types and their modals — Ricariche, GiftBox, GiftCard (ISSUE), and the
// installment (rate) plan. These dialogs are reproduced verbatim but their buttons do not
// mutate state yet.

type CatalogService = {
  id: number;
  name: string;
  price: string; // e.g. "12,00 euro"
  category?: string;
  locationIds?: number[];
};

type CatalogProduct = {
  id: number;
  name: string;
  price: string; // e.g. "12,00 euro"
  sku?: string;
  stock?: number;
  category?: string;
};

type CatalogClient = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
};

// A sellable PACKAGE template from /api/manage/pos (port of pos.php $packages):
// id, name, price, total sessions (-> client_packages.sessions_total when issued) and
// validity days (seeds the proposed "Valido al" expiry).
type CatalogPackage = {
  id: number;
  name: string;
  price: number;
  sessions: number;
  validityDays: number;
};

// A sellable GIFTBOX template from /api/manage/pos (port of the GiftBox catalog): id, name,
// default price (0 — the giftboxes table has no price, so the staff enters the SALE price),
// validity days (seeds the proposed "Valida al" expiry), and its content items (read-only,
// shown for context). Selling one issues a giftbox_instances row + its items at checkout.
type CatalogGiftboxItem = {
  giftboxItemId: number;
  itemType: string;
  serviceId: number;
  productId: number;
  qty: number;
  label: string;
};
type CatalogGiftbox = {
  id: number;
  name: string;
  price: number;
  validityDays: number;
  items: CatalogGiftboxItem[];
};

// A sellable RECHARGE template from /api/manage/pos (port of recharge_templates): id, title,
// base amount, bonus kind/value (+ the precomputed € bonus), and whether points are earned on
// the bonus too. Picking one precompiles the modal; "Aggiungi" pushes a {type:"recharge"} cart
// line that credits the wallet by base+bonus at checkout.
type CatalogRecharge = {
  id: number;
  title: string;
  baseAmount: number;
  bonusKind: string;
  bonusValue: number;
  bonusAmount: number;
  earnPoints: boolean;
};

// The BUSINESS header for the printable receipt (scontrino), from the POS context
// (getManagePosContext -> getPosBusinessHeader): name + P.IVA + address + logo path.
type PosBusinessHeader = {
  name?: string;
  legalVatNumber?: string;
  address?: string;
  logoPath?: string;
};

// One completed sale ITEM line as returned by the checkout response (PosSale.items). Carries
// the resolved name (incl. the GiftCard/GiftBox/Pacchetto/Ricarica labels), qty, unit + line
// total, type + status — everything the receipt row renders.
type SaleResponseItem = {
  id?: number;
  type?: string;
  refId?: number;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  status?: string;
};

// One completed sale PAYMENT (PosSale.payments): the method + amount (+ giftcardId for a
// giftcard residui tender). The receipt prints the method label + amount.
type SaleResponsePayment = {
  method?: string;
  amount?: number;
  giftcardId?: number;
};

// A voucher ISSUED by the sale (checkout response `issuedVouchers`): the generated GiftCard
// (GC-XXXX-XXXX-XXXX) or GiftBox (GBX-XXXXXX) CODE + recipient + amount. Rendered in the
// receipt's "Buoni emessi" section so staff can hand the code to the customer — port of
// pos_success.php's "GiftCard/GiftBox emessa (CODE)" presentation.
type IssuedVoucher = {
  type?: string;
  code?: string;
  recipientName?: string;
  amount?: number;
};

// The completed `sale` the checkout response returns (a subset of PosSale) — the authoritative
// sale the receipt is built from.
type SaleResponse = {
  id?: number;
  code?: string;
  clientId?: number;
  clientName?: string;
  items?: SaleResponseItem[];
  payments?: SaleResponsePayment[];
  subtotal?: number;
  discount?: number;
  total?: number;
  createdAt?: string;
};

// The captured RECEIPT (scontrino) shown after a successful checkout. Composes the server's
// authoritative `sale` (id/code/items/totals/payments/date/client) with the client-side
// breakdown snapshot the server does NOT decompose on PosSale (manual discount, coupon,
// fidelity points discount, residui credito/giftcard applied) + the business header +
// operator, so the receipt prints every reduction line faithfully (like pos_success.php).
type ReceiptData = {
  sale: SaleResponse;
  business: PosBusinessHeader;
  operatorName: string;
  // Reduction breakdown (snapshotted from the cart at checkout time — these equal what the
  // backend charged, since the UI mirrors the backend math). Each is € (>= 0).
  manualDiscount: number;
  couponCode: string;
  couponDiscount: number;
  pointsUsed: number;
  fidelityDiscount: number;
  creditUse: number;
  giftcardUse: number;
  giftcardCode: string;
  baseMethodLabel: string;
  baseAmount: number;
  // GiftCard/GiftBox codes this sale ISSUED (from the checkout response `issuedVouchers`),
  // shown in the "Buoni emessi" receipt section so staff can give the code to the customer.
  issuedVouchers: IssuedVoucher[];
  // Punti Fidelity maturati (pos_success.php blocco "Fidelity": Punti usati/guadagnati).
  pointsEarned: number;
};

type PosContext = {
  activeLocationId?: number;
  business?: PosBusinessHeader;
  catalog?: {
    clients?: CatalogClient[];
    services?: CatalogService[];
    products?: CatalogProduct[];
    packages?: CatalogPackage[];
    giftboxes?: CatalogGiftbox[];
    rechargeTemplates?: CatalogRecharge[];
  };
};

// The client's spendable residui (wallet CREDIT + GiftCards) + the FIDELITY points balance
// and redeem settings, fetched from GET /api/manage/pos?action=client_residuals&client_id=
// when a client is selected.
type ClientResiduals = {
  clientId: number;
  credit: number;
  giftcards: Array<{ id: number; code: string; balance: number }>;
  points: number;
  fidelity: { enabled: boolean; euroPerPoint: number; minPoints: number };
};

type CartLine = {
  key: string;
  type: "service" | "product" | "package" | "prepaid" | "giftcard" | "giftbox" | "recharge";
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  // Stato riga legacy (pos.js getRowStatusMeta): servizio Eseguito/Prepagato,
  // prodotto Ritirato/Ordinato — richiesto anche per l'eleggibilità GiftBox.
  status: "executed" | "collected" | "prepaid" | "ordered";
  // PACKAGE meta (qty is locked to 1; sessions are issued from the template). Carried to
  // checkout so the issued client_packages row gets the custom validity window + note.
  startDate?: string;
  expiresAt?: string;
  note?: string;
  sessions?: number;
  // GIFTCARD / GIFTBOX meta (qty locked to 1; the line price is the card/box amount). Carried
  // to checkout so issueGiftcardFromSale / issueGiftboxFromSale writes the giftcards /
  // giftbox_instances row with the chosen recipient/code/expiry/dedica/hide-amount. For a
  // giftbox, refId is the chosen giftboxes TEMPLATE id.
  recipientClientId?: number;
  recipientName?: string;
  recipientEmail?: string;
  code?: string;
  eventType?: string;
  message?: string;
  hideAmount?: boolean;
  // Voucher extra meta legacy (nota interna + invio email + mostra importo).
  internalNote?: string;
  sendMode?: "none" | "now" | "date";
  sendOn?: string;
  showAmount?: boolean;
  // RECHARGE meta (qty locked to 1; the line price is the BASE amount the client pays). Carried
  // to checkout so issueRechargeFromSale writes the recharges row + credits the wallet by
  // base+bonus. refId is the recharge_templates id (0 = custom amount).
  baseAmount?: number;
  bonusKind?: string;
  bonusValue?: number;
  bonusAmount?: number;
  totalAmount?: number;
  earnPoints?: boolean;
  // Custom GiftBox build: the chosen services/products that compose a one-off box (only set on a
  // giftbox line with refId 0). Sent to checkout so saveGiftboxFromCart materialises the template.
  customItems?: Array<{ type: "service" | "product"; id: number; qty: number }>;
};

// Etichette evento legacy (GiftCard::eventMap) per la riga carrello
// "GiftCard • {evento} • {destinatario}".
const GC_EVENT_LABELS: Record<string, string> = {
  giftcard: "GiftCard (generica)",
  giftbox: "GiftBox (generica)",
  compleanno: "Compleanno",
  anniversario: "Anniversario",
  capodanno: "Capodanno",
  natale: "Natale",
  epifania: "Epifania",
  san_valentino: "San Valentino",
  festa_donna: "Festa della Donna",
  pasqua: "Pasqua",
  pasquetta: "Pasquetta",
  festa_mamma: "Festa della Mamma",
  festa_papa: "Festa del Papà",
};

// Legacy POS base payment type (the single payment_type radio: cash/card/check/bank).
// The Next API maps check -> card and bank -> transfer (see app/api/manage/pos route).
type PaymentMethod = "cash" | "card" | "check" | "bank";

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Contanti",
  card: "Carta",
  check: "Assegno",
  bank: "Bonifico",
};

// PHP payment radios use cash/card/check/bank; the Next API maps check->card and
// bank->transfer (port of normalizePaymentMethod in app/api/manage/pos/route.ts).
function apiPaymentMethod(method: PaymentMethod): string {
  if (method === "cash") return "cash";
  if (method === "check") return "check"; // preserve Assegno (was folded to card)
  if (method === "bank") return "transfer";
  return "card";
}

// Label for a completed-sale payment method (PosPayment.method: cash/card/transfer/giftcard/
// wallet). Mirrors the legacy receipt's payment labels; "wallet" is the residui credito tender.
const SALE_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Contanti",
  card: "Carta",
  transfer: "Bonifico",
  giftcard: "GiftCard",
  wallet: "Credito",
};

function salePaymentMethodLabel(method: string | undefined): string {
  const key = String(method ?? "").toLowerCase();
  return SALE_PAYMENT_METHOD_LABELS[key] ?? (key ? key : "Pagamento");
}

// Label for an ISSUED voucher type on the receipt (port of pos_success.php's "GiftCard/GiftBox
// emessa"). Unknown types fall back to a generic "Buono".
function issuedVoucherTypeLabel(type: string | undefined): string {
  const key = String(type ?? "").toLowerCase();
  if (key === "giftcard") return "GiftCard";
  if (key === "giftbox") return "GiftBox";
  return "Buono";
}

// Format the sale date/time for the receipt as "dd/mm/yyyy HH:MM" (it-IT), faithful to the
// legacy pos_success.php `date('d/m/Y H:i', ...)`. Falls back to the raw value when unparseable.
function formatReceiptDateTime(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// "12,00 euro" / "12.00" -> 12 (numeric). Mirrors how the PHP catalog feeds prices.
function parsePrice(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "")
    .replace(/euro/gi, "")
    .replace(/€/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!raw) return 0;
  // Italian formatting: thousands "." and decimal ",". Strip thousands, swap comma.
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

// Mirrors pos.js fmtEUR(): "€ 0,00"
function fmtEUR(value: number): string {
  try {
    return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
  } catch {
    return "€ " + (Number(value) || 0).toFixed(2).replace(".", ",");
  }
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Today as YYYY-MM-DD (local), mirrors pos.js pkTodayYMD().
function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// start-date + N days as YYYY-MM-DD, faithful to pkCalculatePackageExpiry's 'days' base
// case (the catalog validity is stored in days). Empty when start is invalid or days <= 0.
function addDaysYMD(startYmd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || "").trim());
  if (!m || days <= 0) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Math.floor(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Validate a YYYY-MM-DD date (returns "" when invalid). Used by the installment schedule.
function validYMD(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return "";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dim = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > dim) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// start + N months as YYYY-MM-DD, clamping the day to the target month length (31 -> 30/28).
// Port of SaleInstallments::shiftDate's month branch.
function addMonthsYMD(startYmd: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || "").trim());
  if (!m) return startYmd;
  const day = Number(m[3]);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.max(0, Math.floor(months));
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  const dim = new Date(ny, nmo, 0).getDate();
  const nd = Math.min(day, dim);
  return `${ny}-${String(nmo).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

// Step firstDue by interval_value * iterations of the unit (day/week/month). iterations === 0
// returns the date unchanged (installment #1 = first_due_date). Port of SaleInstallments::shiftDate.
function shiftScheduleDate(date: string, unit: "day" | "week" | "month", value: number, iterations: number): string {
  const safe = validYMD(date) || todayYMD();
  const steps = Math.max(0, Math.floor(iterations));
  if (steps === 0) return safe;
  const step = Math.max(1, Math.floor(value) || 1);
  if (unit === "day") return addDaysYMD(safe, step * steps);
  if (unit === "week") return addDaysYMD(safe, step * steps * 7);
  return addMonthsYMD(safe, step * steps);
}

// Build the installment schedule (cents, front-loaded remainder) — faithful to
// SaleInstallments::buildSchedule. Splits the FINANCED amount into `count` rows whose amounts
// sum exactly to financed; due dates step from firstDue by interval_value of interval_unit.
function buildInstallmentSchedule(
  financed: number,
  count: number,
  firstDue: string,
  unit: "day" | "week" | "month",
  intervalValue: number,
): Array<{ no: number; dueDate: string; amount: number }> {
  const safeCount = Math.max(1, Math.min(120, Math.floor(count) || 1));
  const cents = Math.round(Math.max(0, financed) * 100);
  const base = Math.floor(cents / safeCount);
  const remainder = cents - base * safeCount;
  return Array.from({ length: safeCount }, (_, idx) => {
    const no = idx + 1;
    const c = base + (no <= remainder ? 1 : 0);
    return { no, dueDate: shiftScheduleDate(firstDue, unit, intervalValue, idx), amount: roundMoney(c / 100) };
  });
}

export function PosContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const today = todayYMD();

  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [loading, setLoading] = useState(true);

  // Selected client (null = "Cliente banco").
  const [clientId, setClientId] = useState<number | null>(null);
  const [clientName, setClientName] = useState<string>("");

  // Catalog UI state.
  const [catalogMode, setCatalogMode] = useState<"service" | "product">("service");
  const [catalogSearch, setCatalogSearch] = useState("");
  // Filtro area/categoria del catalogo (select "Tutte le aree" legacy).
  const [catalogCategory, setCatalogCategory] = useState("");
  const [clientSearch, setClientSearch] = useState("");

  // Cart.
  const [cart, setCart] = useState<CartLine[]>([]);

  // Discount (manual).
  const [discountType, setDiscountType] = useState<"none" | "percent" | "fixed">("none");
  const [discountValue, setDiscountValue] = useState<string>("0");

  // Coupon (wired): the box toggle + the typed code, plus the APPLIED coupon
  // (couponCode/couponDiscount mirror what the preview validated) and the
  // couponHelp feedback ({text, ok}). couponApplying disables the buttons during
  // the preview fetch; a monotonic req-id discards stale responses (legacy pattern).
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponMsg, setCouponMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [couponApplying, setCouponApplying] = useState(false);
  const couponReqRef = useRef(0);

  // Promotion (Block 3b): the operator-detected automatic promotion. promotionId/name/
  // discount mirror the best eligible promotion the engine returned for the current cart;
  // promotion_id is sent on checkout (the backend re-evaluates and refuses if no longer
  // applicable, so the shown discount always equals the charged one).
  const [promotionId, setPromotionId] = useState(0);
  const [promotionName, setPromotionName] = useState("");
  const [promotionDiscountRaw, setPromotionDiscountRaw] = useState(0);
  const [promotionMsg, setPromotionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [promotionEvaluating, setPromotionEvaluating] = useState(false);

  // Payment: ONE base method for the remainder after residui (faithful single
  // payment_type radio). Defaults to Contanti.
  const [baseMethod, setBaseMethod] = useState<PaymentMethod>("cash");
  const [notes, setNotes] = useState("");

  // RATEIZZAZIONE (installment plan): the single/rate choice + the configured params. mode
  // "single" = pagamento unico (no plan), "installment" = a rate plan is active. The params
  // (acconto, numero rate, intervallo, prima scadenza, note) mirror the legacy
  // installment_plan_json; the schedule is derived (installmentSchedule below) and sent as
  // installment_plan JSON at checkout when mode === "installment". Defaults: monthly, +30d
  // first due, 0 down, 3 rate.
  const [installmentMode, setInstallmentMode] = useState<"single" | "installment">("single");
  const [installmentDownInput, setInstallmentDownInput] = useState("0");
  const [installmentCountInput, setInstallmentCountInput] = useState("3");
  const [installmentIntervalValueInput, setInstallmentIntervalValueInput] = useState("1");
  const [installmentIntervalUnit, setInstallmentIntervalUnit] = useState<"day" | "week" | "month">("month");
  const [installmentFirstDue, setInstallmentFirstDue] = useState("");
  const [installmentNote, setInstallmentNote] = useState("");

  // Residui: the selected client's spendable wallet CREDIT + GiftCards, and the amounts
  // the staff applies. creditUse / giftcardUse are the applied (clamped) amounts;
  // giftcardId is the chosen card. `residuals` is null until the fetch resolves for the
  // current client, so "loading" is derived (a client is selected but residui not yet in).
  const [residuals, setResiduals] = useState<ClientResiduals | null>(null);
  const [creditUseInput, setCreditUseInput] = useState("0");
  const [giftcardId, setGiftcardId] = useState(0);
  const [giftcardUseInput, setGiftcardUseInput] = useState("0");
  // Draft del modale Residui (legacy #posResidualsModal): seedato all'apertura
  // ("Apri scheda") dai valori applicati, copiato negli applicati su "Applica".
  const [rmCreditAmt, setRmCreditAmt] = useState("0");
  const [rmGiftcardId, setRmGiftcardId] = useState(0);
  const [rmGiftcardAmt, setRmGiftcardAmt] = useState("0");
  // FIDELITY points the staff applies as a discount (raw typed value; re-clamped below).
  const [pointsUseInput, setPointsUseInput] = useState("0");
  const residualsReqRef = useRef(0);

  // PACKAGE sale modal (wired): the chosen template, the optional custom validity window
  // and note. The expiry is seeded from the template's validityDays (today + N days) and
  // can be overridden; "touched" tracks a manual edit so re-selecting a package re-seeds it.
  const [packageId, setPackageId] = useState(0);
  const [packageStart, setPackageStart] = useState("");
  const [packageExpires, setPackageExpires] = useState("");
  const [packageExpiresTouched, setPackageExpiresTouched] = useState(false);
  const [packageNote, setPackageNote] = useState("");

  // GIFTCARD sale modal (wired): the configured card. Amount + recipient are required; the
  // recipient defaults to the selected sale client (so the card lands in their residui), or
  // a free-text name. Optional custom code (else auto), expiry (editable), dedica message,
  // and the hide-amount voucher toggle. "Aggiungi" pushes a {type:"giftcard"} cart line.
  const [gcAmount, setGcAmount] = useState("");
  const [gcEventType, setGcEventType] = useState("giftcard");
  const [gcValidFrom, setGcValidFrom] = useState("");
  const [gcExpiresAt, setGcExpiresAt] = useState("");
  const [gcRecipientName, setGcRecipientName] = useState("");
  const [gcRecipientEmail, setGcRecipientEmail] = useState("");
  const [gcRecipientClientId, setGcRecipientClientId] = useState(0);
  const [gcRecipientIsClient, setGcRecipientIsClient] = useState(false);
  const [gcRecipientSearch, setGcRecipientSearch] = useState("");
  const [gcMessage, setGcMessage] = useState("");
  const [gcHideAmount, setGcHideAmount] = useState(false);
  // Legacy items[gc_*]: nota per il cliente, nota interna, invio email
  // (Non inviare / subito / programmata + data) e "Mostra importo e contenuto".
  const [gcNote, setGcNote] = useState("");
  const [gcInternalNote, setGcInternalNote] = useState("");
  const [gcDoNotSend, setGcDoNotSend] = useState(false);
  const [gcSendMode, setGcSendMode] = useState<"now" | "date">("now");
  const [gcSendOn, setGcSendOn] = useState("");
  const [gcShowAmount, setGcShowAmount] = useState(true);

  // GIFTBOX come DRAFT legacy (pos.php giftbox_* hidden + gbSaveBtn): il modale
  // NON aggiunge una riga carrello — la GiftBox avvolge i servizi Prepagato e i
  // prodotti Ordinato già nel carrello e viene emessa al Concludi come UNA riga
  // "GiftBox • {code}" col totale del contenuto. "Salva" memorizza il draft.
  const [gbDraft, setGbDraft] = useState<null | {
    eventType: string;
    validFrom: string;
    validTo: string;
    recipientName: string;
    recipientEmail: string;
    recipientClientId: number;
    hideAmount: boolean;
    message: string;
    note: string;
    internalNote: string;
    sendMode: "none" | "now" | "date";
    sendOn: string;
    showDetails: boolean;
  }>(null);
  const [gbEventType, setGbEventType] = useState("giftbox");
  const [gbValidFrom, setGbValidFrom] = useState("");
  const [gbValidTo, setGbValidTo] = useState("");
  const [gbRecipientName, setGbRecipientName] = useState("");
  const [gbRecipientEmail, setGbRecipientEmail] = useState("");
  const [gbRecipientClientId, setGbRecipientClientId] = useState(0);
  const [gbRecipientIsClient, setGbRecipientIsClient] = useState(false);
  const [gbRecipientSearch, setGbRecipientSearch] = useState("");
  const [gbMessage, setGbMessage] = useState("");
  const [gbHideAmount, setGbHideAmount] = useState(false);
  const [gbNote, setGbNote] = useState("");
  const [gbInternalNote, setGbInternalNote] = useState("");
  const [gbDoNotSend, setGbDoNotSend] = useState(false);
  const [gbSendMode, setGbSendMode] = useState<"now" | "date">("now");
  const [gbSendOn, setGbSendOn] = useState("");
  const [gbShowDetails, setGbShowDetails] = useState(true);
  const [gbError, setGbError] = useState("");

  // RECHARGE sale modal (wired): the chosen recharge_templates id (0 = custom amount), the base
  // amount the client pays, the bonus rule (kind/value), the earn-points-on-bonus toggle, and an
  // optional note. Picking a template precompiles base/bonus/earn-points (all still editable).
  // "Aggiungi" pushes a {type:"recharge"} cart line whose price is the base; the wallet is
  // credited base+bonus at checkout. A recharge requires a real client to conclude (gated below).
  const [rechargeTemplateId, setRechargeTemplateId] = useState(0);
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeBonusKindInput, setRechargeBonusKindInput] = useState("none");
  const [rechargeBonusValueInput, setRechargeBonusValueInput] = useState("0");
  const [rechargeEarnPoints, setRechargeEarnPoints] = useState(true);
  const [rechargeNoteInput, setRechargeNoteInput] = useState("");

  // Checkout state.
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  // The printable RECEIPT (scontrino) captured on a successful checkout (port of the legacy
  // pos_success.php view). Holds the server's completed `sale` + the breakdown snapshot + the
  // business header; null hides the receipt. The cart is reset alongside (the existing post-
  // checkout reset), so the receipt is shown IN ADDITION to a fresh, ready-for-next-sale cart.
  const [lastSale, setLastSale] = useState<ReceiptData | null>(null);

  // "Vendita da appuntamento": when the POS is opened with ?appointment=<id> the cart is
  // pre-loaded from that appointment's CLIENT + SERVICES (action=appointment_cart). The id
  // is remembered so handleCheckout sends appointment_id (linking the sale + marking the
  // appointment 'done' server-side); the code drives the "Vendita da appuntamento #<code>"
  // banner. Reset to 0/"" on a successful checkout (the sale is no longer from an appointment).
  const [appointmentSaleId, setAppointmentSaleId] = useState(0);
  const [appointmentSaleCode, setAppointmentSaleCode] = useState("");
  const appointmentPreloadRef = useRef(false);

  // "Vendita da preventivo": when the POS is opened with ?quote=<id> the cart is pre-loaded from
  // that quote's CLIENT + LINES (action=quote_cart) at the quote's snapshot prices. The id is
  // remembered so handleCheckout sends source_quote_id (linking the sale + flipping the quote to
  // 'converted' server-side); the code drives the "Vendita da preventivo #<code>" banner. Reset on
  // a successful checkout. (Full cart-lock — disabling tiles/coupon/promo — is a later refinement.)
  const [quoteSaleId, setQuoteSaleId] = useState(0);
  const [quoteSaleCode, setQuoteSaleCode] = useState("");
  const quotePreloadRef = useRef(false);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: PosContext) => setCtx(j ?? null))
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, [load]);

  // "Vendita da appuntamento" pre-load (mount-once): when the POS URL carries
  // ?appointment=<id>, fetch the appointment's CLIENT + SERVICE lines
  // (GET action=appointment_cart) and seed the cart: select the client (the existing
  // client-select path) and ADD each service as a normal {type:"service"} line at its
  // current catalog price. The appointment id is remembered so handleCheckout sends
  // appointment_id (so the sale links + the appointment is marked 'done' server-side); the
  // code drives the banner. The guard ref makes this run only once. If the fetch fails (or
  // the appointment is missing/foreign), the POS degrades to an empty cart (no banner).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (appointmentPreloadRef.current) return;
    const rawId = new URLSearchParams(window.location.search).get("appointment");
    const appointmentId = Math.max(0, Number.parseInt(String(rawId ?? ""), 10) || 0);
    if (appointmentId <= 0) {
      appointmentPreloadRef.current = true;
      return;
    }
    appointmentPreloadRef.current = true;
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}&action=appointment_cart&appointment_id=${appointmentId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then(
        (j: {
          ok?: boolean;
          appointmentId?: number;
          publicCode?: string | null;
          clientId?: number;
          clientName?: string;
          services?: Array<{ serviceId?: number; name?: string; unitPrice?: number; quantity?: number }>;
        }) => {
          if (!active) return;
          if (j?.ok === false || !j) return; // degrade to an empty POS
          const apptId = Math.max(0, Number(j?.appointmentId ?? appointmentId) || 0);
          if (apptId <= 0) return;
          // Select the appointment's client (so residui/fidelity load for them).
          const cId = Math.max(0, Number(j?.clientId ?? 0) || 0);
          if (cId > 0) selectClient(cId, String(j?.clientName ?? "").trim());
          // Add each service line as a normal {type:"service"} cart line.
          const lines = Array.isArray(j?.services) ? j.services : [];
          if (lines.length > 0) {
            setCart((prev) => {
              // Immutable merge: clone existing service lines on qty bump (no in-place
              // mutation of the previous state), mirroring how addTile composes the cart.
              const next = prev.map((l) => ({ ...l }));
              for (const line of lines) {
                const refId = Math.max(0, Number(line?.serviceId ?? 0) || 0);
                if (refId <= 0) continue;
                const quantity = Math.max(1, Math.round(Number(line?.quantity ?? 1) || 1));
                const unitPrice = roundMoney(Math.max(0, Number(line?.unitPrice ?? 0) || 0));
                const existing = next.find((l) => l.type === "service" && l.refId === refId);
                if (existing) {
                  existing.quantity = Math.min(1000, existing.quantity + quantity);
                  continue;
                }
                next.push({
                  key: `${Date.now()}-${Math.floor(Math.random() * 1000)}-${refId}`,
                  type: "service",
                  refId,
                  name: String(line?.name ?? "Servizio"),
                  quantity: Math.min(1000, quantity),
                  unitPrice,
                  status: "executed",
                });
              }
              return next;
            });
          }
          // Remember the appointment id + code (drives the banner + the checkout link).
          setAppointmentSaleId(apptId);
          setAppointmentSaleCode(
            j?.publicCode && String(j.publicCode).trim() ? String(j.publicCode).trim() : `#${apptId}`,
          );
        },
      )
      .catch(() => {
        // degrade to an empty POS — the staff can still build the sale manually.
      });
    return () => {
      active = false;
    };
    // Runs once on mount; slug is stable for the page lifetime.
  }, [slug]);

  // "Vendita da preventivo" pre-load (mount-once): when the POS URL carries ?quote=<id>, fetch the
  // quote's CLIENT + LINES (GET action=quote_cart) and seed the cart — each quote line as a cart
  // line of its own type at the quote's snapshot price. The quote id is remembered so handleCheckout
  // sends source_quote_id (the sale links to the quote + the quote flips to 'converted'). Guard ref
  // makes it run once; a missing/converted quote degrades to an empty POS (no banner). Mirrors the
  // ?appointment= pre-load above.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (quotePreloadRef.current) return;
    const rawId = new URLSearchParams(window.location.search).get("quote");
    const quoteId = Math.max(0, Number.parseInt(String(rawId ?? ""), 10) || 0);
    if (quoteId <= 0) {
      quotePreloadRef.current = true;
      return;
    }
    quotePreloadRef.current = true;
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}&action=quote_cart&quote_id=${quoteId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then(
        (j: {
          ok?: boolean;
          quoteId?: number;
          code?: string | null;
          clientId?: number;
          clientName?: string;
          items?: Array<{ type?: string; refId?: number; name?: string; unitPrice?: number; quantity?: number }>;
        }) => {
          if (!active) return;
          if (j?.ok === false || !j) return; // degrade to an empty POS
          const qId = Math.max(0, Number(j?.quoteId ?? quoteId) || 0);
          if (qId <= 0) return;
          const cId = Math.max(0, Number(j?.clientId ?? 0) || 0);
          if (cId > 0) selectClient(cId, String(j?.clientName ?? "").trim());
          const lines = Array.isArray(j?.items) ? j.items : [];
          if (lines.length > 0) {
            setCart((prev) => {
              const next = prev.map((l) => ({ ...l }));
              for (const line of lines) {
                const type = String(line?.type ?? "service") as CartLine["type"];
                const refId = Math.max(0, Number(line?.refId ?? 0) || 0);
                const quantity = Math.max(1, Math.round(Number(line?.quantity ?? 1) || 1));
                const unitPrice = roundMoney(Math.max(0, Number(line?.unitPrice ?? 0) || 0));
                const status: CartLine["status"] = type === "product" ? "collected" : type === "service" ? "executed" : "prepaid";
                next.push({
                  key: `${Date.now()}-${Math.floor(Math.random() * 1000)}-${refId}`,
                  type,
                  refId,
                  name: String(line?.name ?? "Riga preventivo"),
                  quantity: Math.min(1000, quantity),
                  unitPrice,
                  status,
                });
              }
              return next;
            });
          }
          setQuoteSaleId(qId);
          setQuoteSaleCode(j?.code && String(j.code).trim() ? String(j.code).trim() : `#${qId}`);
        },
      )
      .catch(() => {
        // degrade to an empty POS
      });
    return () => {
      active = false;
    };
    // Runs once on mount; slug is stable for the page lifetime.
  }, [slug]);

  const business = useMemo<PosBusinessHeader>(() => ctx?.business ?? {}, [ctx]);
  const clients = useMemo(() => ctx?.catalog?.clients ?? [], [ctx]);
  const services = useMemo(() => ctx?.catalog?.services ?? [], [ctx]);
  const products = useMemo(() => ctx?.catalog?.products ?? [], [ctx]);
  const packages = useMemo(() => ctx?.catalog?.packages ?? [], [ctx]);
  const selectedPackage = useMemo(
    () => packages.find((p) => p.id === packageId) ?? null,
    [packages, packageId],
  );
  const rechargeTemplates = useMemo(() => ctx?.catalog?.rechargeTemplates ?? [], [ctx]);

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.phone ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q),
    );
  }, [clients, clientSearch]);

  // Aree/categorie del catalogo per il select "Tutte le aree" (legacy
  // posCatalogCategory): distinte dalla modalità corrente.
  const catalogCategories = useMemo(() => {
    const src = catalogMode === "service" ? services.map((s) => s.category) : products.map((p) => p.category);
    return Array.from(new Set(src.map((c) => (c ?? "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [catalogMode, services, products]);

  const tiles = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    const cat = catalogCategory.trim();
    if (catalogMode === "service") {
      return services
        .filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!cat || (s.category ?? "").trim() === cat))
        .map((s) => ({ id: s.id, name: s.name, price: parsePrice(s.price), stock: undefined as number | undefined }));
    }
    return products
      .filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q)) && (!cat || (p.category ?? "").trim() === cat))
      .map((p) => ({ id: p.id, name: p.name, price: parsePrice(p.price), stock: p.stock }));
  }, [catalogMode, catalogSearch, catalogCategory, services, products]);

  // ---- cart math (mirrors pos.js + lib/manage-pos.ts) ----
  const subtotal = useMemo(
    () => roundMoney(cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)),
    [cart],
  );

  const manualDiscount = useMemo(() => {
    const v = Math.max(0, Number.parseFloat(discountValue.replace(",", ".")) || 0);
    if (discountType === "percent") return roundMoney(Math.min(subtotal, (subtotal * v) / 100));
    if (discountType === "fixed") return roundMoney(Math.min(subtotal, v));
    return 0;
  }, [discountType, discountValue, subtotal]);

  // A detected promotion is applied to a cart SNAPSHOT; when the cart/client changes it can
  // go stale (the backend would recompute or refuse), so reset it on change. React-endorsed
  // "adjust state on prior-render change" pattern (setState during render, guarded) — avoids
  // an effect + touching every cart mutator.
  const promoCartSig = `${clientId ?? 0}|${cart.map((l) => `${l.type}:${l.refId}:${l.quantity}:${l.unitPrice}`).join(",")}`;
  const [prevPromoSig, setPrevPromoSig] = useState(promoCartSig);
  if (promoCartSig !== prevPromoSig) {
    setPrevPromoSig(promoCartSig);
    if (promotionId !== 0) {
      setPromotionId(0);
      setPromotionName("");
      setPromotionDiscountRaw(0);
      setPromotionMsg(null);
    }
  }

  // Promotion discount (Block 3b), composed like the backend: it applies after the
  // manual discount and before the coupon (discount = manual + promo + coupon + fidelity,
  // capped at subtotal), so the shown total equals the server's.
  const promotionDiscount = useMemo(
    () => roundMoney(Math.min(Math.max(0, promotionDiscountRaw), Math.max(0, subtotal - manualDiscount))),
    [promotionDiscountRaw, subtotal, manualDiscount],
  );

  // The coupon discount shown is the previewed value, but it is composed with the
  // manual discount exactly like the backend (discount = min(subtotal, manual +
  // coupon)), so it never drives the total negative and the shown total equals the
  // server's. Only the part of the coupon that fits after the manual + promo discount counts.
  const codeDiscount = useMemo(
    () => roundMoney(Math.min(Math.max(0, couponDiscount), Math.max(0, subtotal - manualDiscount - promotionDiscount))),
    [couponDiscount, subtotal, manualDiscount, promotionDiscount],
  );

  // ---- fidelity points redemption math ----
  // Redemption is offered only when the backend reports it enabled for this client (global
  // fidelity_enabled + fidelity_redeem_enabled + the client has points). The € discount is
  // pointsUsed x euroPerPoint, capped by the client's balance AND by the amount payable
  // after the manual + coupon discount (baseForPoints) — faithful to the backend, so the
  // shown discount always equals the charged one. Points are whole numbers.
  const fidelityEnabled = useMemo(
    () => !!residuals?.fidelity.enabled && (residuals?.points ?? 0) > 0,
    [residuals],
  );
  const euroPerPoint = useMemo(() => {
    const epp = roundMoney(Math.max(0, residuals?.fidelity.euroPerPoint ?? 0.1));
    return epp > 0 ? epp : 0.1;
  }, [residuals]);
  const pointsBalance = useMemo(() => Math.max(0, Math.floor(residuals?.points ?? 0)), [residuals]);
  const minPoints = useMemo(() => Math.max(0, Math.floor(residuals?.fidelity.minPoints ?? 0)), [residuals]);
  // The amount still payable after manual + promo + coupon — the cap the points discount fits into.
  const baseForPoints = useMemo(
    () => roundMoney(Math.max(0, subtotal - manualDiscount - promotionDiscount - codeDiscount)),
    [subtotal, manualDiscount, promotionDiscount, codeDiscount],
  );
  // The most whole points the payable amount allows: floor(baseForPoints / euroPerPoint).
  const maxPointsByAmount = useMemo(
    () => (euroPerPoint > 0 ? Math.floor((baseForPoints + 1e-9) / euroPerPoint) : 0),
    [baseForPoints, euroPerPoint],
  );
  // The points actually used = min(requested, balance, maxByAmount), whole.
  const pointsUsed = useMemo(() => {
    if (!fidelityEnabled) return 0;
    const typed = Math.max(0, Math.floor(Number.parseInt(pointsUseInput, 10) || 0));
    return Math.max(0, Math.min(typed, pointsBalance, maxPointsByAmount));
  }, [fidelityEnabled, pointsUseInput, pointsBalance, maxPointsByAmount]);
  const fidelityDiscount = useMemo(
    () => roundMoney(Math.min(baseForPoints, pointsUsed * euroPerPoint)),
    [baseForPoints, pointsUsed, euroPerPoint],
  );
  // Whether the typed points are below the configured minimum (blocks checkout + warns).
  const pointsBelowMin = useMemo(() => {
    const typed = Math.max(0, Math.floor(Number.parseInt(pointsUseInput, 10) || 0));
    return fidelityEnabled && minPoints > 0 && typed > 0 && typed < minPoints;
  }, [fidelityEnabled, pointsUseInput, minPoints]);
  // Whether the typed points exceed the client's balance (blocks checkout + warns).
  const pointsOverBalance = useMemo(() => {
    const typed = Math.max(0, Math.floor(Number.parseInt(pointsUseInput, 10) || 0));
    return fidelityEnabled && typed > pointsBalance;
  }, [fidelityEnabled, pointsUseInput, pointsBalance]);

  const total = useMemo(
    () => roundMoney(Math.max(0, subtotal - manualDiscount - promotionDiscount - codeDiscount - fidelityDiscount)),
    [subtotal, manualDiscount, promotionDiscount, codeDiscount, fidelityDiscount],
  );

  // ---- rateizzazione (installment plan) math ----
  // The chosen plan params, clamped + derived for the schedule preview and the checkout
  // payload. count >= 2; the acconto stays below the total (so financed > 0); financed =
  // total - acconto; the schedule splits financed across `count` rows summing to financed.
  const installmentCount = useMemo(
    () => Math.max(1, Math.min(120, Math.floor(Number.parseInt(installmentCountInput, 10) || 0))),
    [installmentCountInput],
  );
  const installmentIntervalValue = useMemo(() => {
    const max = installmentIntervalUnit === "day" ? 365 : installmentIntervalUnit === "week" ? 52 : 24;
    return Math.max(1, Math.min(max, Math.floor(Number.parseInt(installmentIntervalValueInput, 10) || 1)));
  }, [installmentIntervalValueInput, installmentIntervalUnit]);
  // The first due defaults to today + 30 days (faithful default) until the staff picks one.
  const installmentFirstDueValue = useMemo(
    () => validYMD(installmentFirstDue) || addDaysYMD(today, 30),
    [installmentFirstDue, today],
  );
  const installmentDownPayment = useMemo(
    () => roundMoney(Math.min(Math.max(0, Number.parseFloat(installmentDownInput.replace(",", ".")) || 0), Math.max(0, total - 0.01))),
    [installmentDownInput, total],
  );
  const installmentFinanced = useMemo(() => roundMoney(Math.max(0, total - installmentDownPayment)), [total, installmentDownPayment]);
  const installmentSchedule = useMemo(
    () => buildInstallmentSchedule(installmentFinanced, installmentCount, installmentFirstDueValue, installmentIntervalUnit, installmentIntervalValue),
    [installmentFinanced, installmentCount, installmentFirstDueValue, installmentIntervalUnit, installmentIntervalValue],
  );
  const installmentLastDue = useMemo(
    () => (installmentSchedule.length ? installmentSchedule[installmentSchedule.length - 1].dueDate : installmentFirstDueValue),
    [installmentSchedule, installmentFirstDueValue],
  );
  // A rate plan is "active" (sent at checkout) only when the staff chose it, the sale has a
  // real client + a positive total, and count >= 2 (mirrors the backend guard).
  const installmentActive = useMemo(
    () => installmentMode === "installment" && installmentCount >= 2 && total > 0.00001 && !!clientId && clientId > 0,
    [installmentMode, installmentCount, total, clientId],
  );
  // Modal validation (mirrors preparePlanConfig): a client + positive total are required, the
  // acconto must be below the total (financed > 0) and there must be >= 2 rate. The save
  // button is disabled + the reason shown when the plan is not valid to commit.
  const installmentModalError = useMemo(() => {
    if (!clientId || clientId <= 0) return "Seleziona un cliente per configurare la rateizzazione.";
    if (total <= 0.00001) return "La rateizzazione non è disponibile con totale a zero.";
    if (installmentCount < 2) return "Servono almeno 2 rate per un piano rateale.";
    if (installmentFinanced <= 0.00001) return "L’acconto iniziale deve essere inferiore al totale della vendita.";
    return "";
  }, [clientId, total, installmentCount, installmentFinanced]);
  const installmentCanSave = useMemo(() => installmentModalError === "", [installmentModalError]);

  // ---- residui math ----
  // The chosen giftcard's available balance (0 when none / not in the list anymore).
  const selectedGiftcard = useMemo(
    () => residuals?.giftcards.find((card) => card.id === giftcardId) ?? null,
    [residuals, giftcardId],
  );
  const creditAvailable = useMemo(() => roundMoney(Math.max(0, residuals?.credit ?? 0)), [residuals]);

  // GiftCard is applied first (legacy order), so it is clamped to min(balance, total);
  // credit then covers what is left of the total after the giftcard.
  const giftcardUse = useMemo(() => {
    if (!selectedGiftcard) return 0;
    const typed = Math.max(0, Number.parseFloat(giftcardUseInput.replace(",", ".")) || 0);
    return roundMoney(Math.min(typed, selectedGiftcard.balance, total));
  }, [selectedGiftcard, giftcardUseInput, total]);

  const creditUse = useMemo(() => {
    const typed = Math.max(0, Number.parseFloat(creditUseInput.replace(",", ".")) || 0);
    const remainingAfterGiftcard = roundMoney(Math.max(0, total - giftcardUse));
    return roundMoney(Math.min(typed, creditAvailable, remainingAfterGiftcard));
  }, [creditUseInput, creditAvailable, total, giftcardUse]);

  const residuiTotal = useMemo(() => roundMoney(creditUse + giftcardUse), [creditUse, giftcardUse]);

  // ---- base payment math ----
  // The base method covers the remainder after residui. Con RATEIZZAZIONE attiva
  // in cassa entra solo l'ACCONTO (il residuo è finanziato dalle rate — semantica
  // legacy): l'importo dovuto ORA è l'acconto, non il totale.
  const dueNow = useMemo(
    () => (installmentActive ? installmentDownPayment : total),
    [installmentActive, installmentDownPayment, total],
  );
  const baseAmount = useMemo(() => roundMoney(Math.max(0, dueNow - residuiTotal)), [dueNow, residuiTotal]);
  const paidTotal = useMemo(() => roundMoney(residuiTotal + baseAmount), [residuiTotal, baseAmount]);
  const remainingToPay = useMemo(() => roundMoney(Math.max(0, dueNow - paidTotal)), [dueNow, paidTotal]);
  // Residui can never exceed the balances (they are clamped above) nor the total, so the
  // base auto-covers the rest; "insufficiente" can only happen if the due-now amount is
  // somehow not covered (defensive — mirrors the backend "Pagamento insufficiente").
  const paymentInsufficient = useMemo(() => dueNow > 0 && paidTotal + 0.00001 < dueNow, [dueNow, paidTotal]);

  // Reset every applied residui (used on client change, clear, and checkout success).
  const resetResiduals = useCallback(() => {
    residualsReqRef.current += 1;
    setResiduals(null);
    setCreditUseInput("0");
    setGiftcardId(0);
    setGiftcardUseInput("0");
    setPointsUseInput("0");
  }, []);

  function selectClient(id: number, name: string) {
    setClientId(id);
    setClientName(name);
  }

  function clearClient() {
    // The residui fetch effect's cleanup resets the applied residui on the clientId change.
    setClientId(null);
    setClientName("");
  }

  // RATEIZZAZIONE handlers. "Pagamento unico" clears any rate plan; "Salva piano rate" (the
  // modal footer) commits the configured plan (mode -> installment). Bootstrap's data-attrs
  // open/close the modal; React drives the inputs + the schedule preview.
  function chooseInstallmentSingle() {
    setInstallmentMode("single");
  }
  function saveInstallmentPlan() {
    if (!installmentCanSave) return;
    setInstallmentMode("installment");
  }

  // Fetch the selected client's residui (wallet CREDIT + GiftCards) whenever the client
  // changes. "Cliente banco" (no id) has no residui. A monotonic req-id discards stale
  // responses (legacy pattern); the cleanup resets the applied residui before the next
  // client's fetch (so a client switch never carries the previous client's residui).
  useEffect(() => {
    if (!clientId || clientId <= 0) return () => resetResiduals();
    const myReq = ++residualsReqRef.current;
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}&action=client_residuals&client_id=${clientId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; clientId?: number; credit?: number; giftcards?: ClientResiduals["giftcards"]; points?: number; fidelity?: ClientResiduals["fidelity"] }) => {
        if (!active || myReq !== residualsReqRef.current) return; // stale
        const epp = roundMoney(Math.max(0, Number(j?.fidelity?.euroPerPoint ?? 0.1))) || 0.1;
        setResiduals({
          clientId: Number(j?.clientId ?? clientId),
          credit: j?.ok === false ? 0 : roundMoney(Math.max(0, Number(j?.credit ?? 0))),
          giftcards: j?.ok !== false && Array.isArray(j?.giftcards)
            ? j.giftcards
                .map((card) => ({ id: Number(card.id ?? 0), code: String(card.code ?? ""), balance: roundMoney(Math.max(0, Number(card.balance ?? 0))) }))
                .filter((card) => card.id > 0 && card.balance > 0)
            : [],
          points: j?.ok === false ? 0 : Math.max(0, Math.floor(Number(j?.points ?? 0))),
          fidelity: {
            enabled: j?.ok !== false && j?.fidelity?.enabled === true,
            euroPerPoint: epp,
            minPoints: Math.max(0, Math.floor(Number(j?.fidelity?.minPoints ?? 0))),
          },
        });
      })
      .catch(() => {
        if (active && myReq === residualsReqRef.current) {
          setResiduals({ clientId, credit: 0, giftcards: [], points: 0, fidelity: { enabled: false, euroPerPoint: 0.1, minPoints: 0 } });
        }
      });
    return () => {
      active = false;
      resetResiduals();
    };
  }, [clientId, slug, resetResiduals]);

  // "Loading" is derived: a client is selected but its residui have not resolved yet.
  const residualsLoading = useMemo(
    () => !!clientId && clientId > 0 && (!residuals || residuals.clientId !== clientId),
    [clientId, residuals],
  );

  function addTile(tile: { id: number; name: string; price: number }) {
    const type = catalogMode;
    setCart((prev) => {
      const existing = prev.find((l) => l.type === type && l.refId === tile.id);
      if (existing) {
        return prev.map((l) =>
          l === existing ? { ...l, quantity: Math.min(1000, l.quantity + 1) } : l,
        );
      }
      const line: CartLine = {
        key: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type,
        refId: tile.id,
        name: tile.name,
        quantity: 1,
        unitPrice: tile.price,
        status: type === "service" ? "executed" : "collected",
      };
      return [line, ...prev];
    });
  }

  // ---- PREPAID sale (wired) ----
  // Sell a SERVICE as prepaid: a {type:"prepaid"} cart line whose qty is the purchased
  // session count (per-session unitPrice). At checkout this issues a client_prepaid_services
  // row (purchased_qty/remaining_qty = qty). Faithful to the legacy "Prepagato" service
  // status — issuance requires a client (gated server-side), but the line can be added
  // without one. Adding from a service tile via the "P" affordance.
  function addPrepaidTile(tile: { id: number; name: string; price: number }) {
    setCart((prev) => {
      const existing = prev.find((l) => l.type === "prepaid" && l.refId === tile.id);
      if (existing) {
        return prev.map((l) => (l === existing ? { ...l, quantity: Math.min(1000, l.quantity + 1) } : l));
      }
      const line: CartLine = {
        key: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: "prepaid",
        refId: tile.id,
        name: tile.name,
        quantity: 1,
        unitPrice: tile.price,
        status: "prepaid",
      };
      return [line, ...prev];
    });
  }

  // ---- PACKAGE sale (wired) ----
  // The proposed expiry for the chosen package: the custom value once the staff edits the
  // field, else today/start + the template's validityDays (pkCalculatePackageExpiry).
  const packageStartValue = packageStart || today;
  const proposedPackageExpiry = useMemo(
    () => (selectedPackage ? addDaysYMD(packageStartValue, selectedPackage.validityDays) : ""),
    [selectedPackage, packageStartValue],
  );
  // The effective "Valido al": the staff's manual override once they've edited the field
  // (packageExpiresTouched), else the proposed expiry seeded from the template's validity
  // (today/start + N days). Derived during render — no effect — so re-selecting a package
  // or changing the start date re-seeds it automatically (mirrors pkSyncExpiryHint).
  const effectivePackageExpiry = packageExpiresTouched ? packageExpires : proposedPackageExpiry;

  function choosePackage(id: number) {
    setPackageId(id);
    setPackageExpires("");
    setPackageExpiresTouched(false);
  }

  function resetPackageModal() {
    setPackageId(0);
    setPackageStart("");
    setPackageExpires("");
    setPackageExpiresTouched(false);
    setPackageNote("");
  }

  // "Aggiungi alla lista": validate the dates and push a {type:"package"} cart line — qty 1
  // at the bundle price, carrying start/expiry/note. The package can be added with no
  // client; checkout (the backend) gates the client_packages issuance on a real client.
  function addPackageToCart() {
    setErrorMsg("");
    const pkg = packages.find((p) => p.id === packageId);
    if (!pkg) {
      setErrorMsg("Seleziona un pacchetto.");
      return;
    }
    const startDate = packageStart || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      setErrorMsg('Data "Valido dal" non valida.');
      return;
    }
    const expiresAt = (effectivePackageExpiry || "").trim();
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
      setErrorMsg('Data "Valido al" non valida.');
      return;
    }
    if (expiresAt && startDate >= expiresAt) {
      setErrorMsg('La data "Valido al" deve essere successiva a "Valido dal".');
      return;
    }
    setCart((prev) => [
      {
        key: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: "package",
        refId: pkg.id,
        name: pkg.name,
        quantity: 1,
        unitPrice: pkg.price,
        status: "prepaid",
        startDate,
        expiresAt: expiresAt || undefined,
        note: packageNote.trim() || undefined,
        sessions: pkg.sessions,
      },
      ...prev,
    ]);
    resetPackageModal();
    // Close the Bootstrap modal (its data-bs handlers may not run for this dynamic markup).
    if (typeof document !== "undefined") {
      const modalEl = document.getElementById("posModalPackages");
      const w = window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance?: (el: Element) => { hide?: () => void } } } };
      try {
        w.bootstrap?.Modal?.getOrCreateInstance?.(modalEl as Element)?.hide?.();
      } catch {
        if (modalEl) {
          modalEl.classList.remove("show");
          (modalEl as HTMLElement).style.display = "none";
        }
      }
    }
  }

  function setQty(key: string, qty: number) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, Math.min(1000, qty || 1)) } : l)));
  }

  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  // Hide a Bootstrap modal by id (its data-bs handlers may not run for this dynamic markup).
  function closePosModal(id: string) {
    if (typeof document === "undefined") return;
    const modalEl = document.getElementById(id);
    const w = window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance?: (el: Element) => { hide?: () => void } } } };
    try {
      w.bootstrap?.Modal?.getOrCreateInstance?.(modalEl as Element)?.hide?.();
    } catch {
      if (modalEl) {
        modalEl.classList.remove("show");
        (modalEl as HTMLElement).style.display = "none";
      }
    }
  }

  // ---- GIFTCARD sale (wired) ----
  function resetGiftcardModal() {
    setGcAmount("");
    setGcEventType("giftcard");
    setGcValidFrom("");
    setGcExpiresAt("");
    setGcRecipientName("");
    setGcRecipientEmail("");
    setGcRecipientClientId(0);
    setGcRecipientIsClient(false);
    setGcRecipientSearch("");
    setGcMessage("");
    setGcHideAmount(false);
    setGcNote("");
    setGcInternalNote("");
    setGcDoNotSend(false);
    setGcSendMode("now");
    setGcSendOn("");
    setGcShowAmount(true);
  }

  // "Aggiungi alla lista" (pos.js gcCreateBtn): validazioni verbatim legacy
  // (esclusività, mittente, importo, evento, destinatario, email, date, data
  // invio) e push della riga {type:"giftcard"} con TUTTI i meta (note + invio
  // email). La card viene emessa server-side al Concludi.
  function addGiftcardToCart() {
    setErrorMsg("");
    if (cart.some((l) => l.type === "recharge")) {
      setErrorMsg("GiftCard e Ricariche non possono essere abbinate nella stessa vendita. Rimuovi la ricarica dal carrello per continuare.");
      return;
    }
    if (gbDraft) {
      setErrorMsg("GiftCard e GiftBox non possono essere abbinate nella stessa vendita. Elimina la GiftBox prima di creare la GiftCard.");
      return;
    }
    if ((clientId ?? 0) <= 0) {
      setErrorMsg("Seleziona un mittente prima di emettere una GiftCard.");
      return;
    }
    const amount = roundMoney(Math.max(0, Number.parseFloat(gcAmount.replace(",", ".")) || 0));
    if (amount <= 0) {
      setErrorMsg("Inserisci un importo valido.");
      return;
    }
    if (!gcEventType) {
      setErrorMsg("Seleziona un evento.");
      return;
    }
    const recipientClientId = gcRecipientIsClient ? gcRecipientClientId : 0;
    if (gcRecipientIsClient && recipientClientId <= 0) {
      setErrorMsg("Seleziona il cliente destinatario.");
      return;
    }
    const recipientName = gcRecipientName.trim() || (recipientClientId > 0 ? clients.find((c) => c.id === recipientClientId)?.name?.trim() ?? "" : "");
    if (!recipientName) {
      setErrorMsg("Inserisci il destinatario.");
      return;
    }
    const recipientEmail = gcRecipientEmail.trim();
    const sendMode: "none" | "now" | "date" = gcDoNotSend ? "none" : gcSendMode;
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setErrorMsg("Inserisci una email destinatario valida.");
      return;
    }
    if (sendMode !== "none" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setErrorMsg("Inserisci una email destinatario valida.");
      return;
    }
    const validFrom = gcValidFrom || today;
    if (validFrom < today) {
      setErrorMsg('GiftCard: la data "Valida dal" non puo essere nel passato.');
      return;
    }
    const expiresAt = gcExpiresAt.trim();
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
      setErrorMsg('GiftCard: data "Valida al" non valida.');
      return;
    }
    if (expiresAt && validFrom >= expiresAt) {
      setErrorMsg('GiftCard: la data "Valida al" deve essere almeno il giorno successivo a "Valida dal".');
      return;
    }
    if (sendMode === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(gcSendOn)) {
      setErrorMsg("Seleziona la data di invio.");
      return;
    }
    const eventLabel = GC_EVENT_LABELS[gcEventType] ?? "GiftCard";
    setCart((prev) => [
      {
        key: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: "giftcard",
        refId: 0,
        // Etichetta riga legacy: "GiftCard • {evento} • {destinatario}".
        name: `GiftCard • ${eventLabel} • ${recipientName}`,
        quantity: 1,
        unitPrice: amount,
        status: "prepaid",
        expiresAt: expiresAt || undefined,
        recipientClientId: recipientClientId > 0 ? recipientClientId : undefined,
        recipientName: recipientName || undefined,
        recipientEmail: recipientEmail || undefined,
        eventType: gcEventType || "giftcard",
        message: gcMessage.trim() || undefined,
        hideAmount: gcHideAmount,
        note: gcNote.trim() || undefined,
        internalNote: gcInternalNote.trim() || undefined,
        sendMode,
        sendOn: sendMode === "date" ? gcSendOn : undefined,
        showAmount: gcShowAmount,
      },
      ...prev.filter((l) => l.type !== "giftcard"),
    ]);
    resetGiftcardModal();
    closePosModal("posModalGiftcard");
  }

  // ---- GIFTBOX come DRAFT dal carrello (pos.js gbSaveBtn / gbReadCartSnapshot) ----
  // Contenuto eleggibile: servizi in stato Prepagato (righe service prepaid +
  // righe "+ Prepagato") e prodotti in stato Ordinato. Le righe non conformi
  // bloccano il salvataggio col messaggio legacy.
  const giftboxEligibleLines = useMemo(
    () => cart.filter((l) => (l.type === "service" && l.status === "prepaid") || l.type === "prepaid" || (l.type === "product" && l.status === "ordered")),
    [cart],
  );
  const giftboxBlockingMessage = useMemo(() => {
    const badServices = cart.filter((l) => l.type === "service" && l.status !== "prepaid").map((l) => l.name);
    const badProducts = cart.filter((l) => l.type === "product" && l.status !== "ordered").map((l) => l.name);
    if (badServices.length === 0 && badProducts.length === 0) return "";
    return `Per creare una GiftBox, i servizi devono essere impostati come Prepagato (${badServices.join(", ") || "—"}) e i prodotti devono essere impostati come Ordinato (${badProducts.join(", ") || "—"}).`;
  }, [cart]);
  const giftboxContentTotal = useMemo(
    () => roundMoney(giftboxEligibleLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)),
    [giftboxEligibleLines],
  );

  function resetGiftboxModal(keepDraft = false) {
    if (!keepDraft) {
      setGbEventType("giftbox");
      setGbValidFrom("");
      setGbValidTo("");
      setGbRecipientName("");
      setGbRecipientEmail("");
      setGbRecipientClientId(0);
      setGbRecipientIsClient(false);
      setGbMessage("");
      setGbHideAmount(false);
      setGbNote("");
      setGbInternalNote("");
      setGbDoNotSend(false);
      setGbSendMode("now");
      setGbSendOn("");
      setGbShowDetails(true);
    }
    setGbRecipientSearch("");
    setGbError("");
  }

  // "Salva" (pos.js gbSaveBtn): NON aggiunge una riga — valida e memorizza il
  // DRAFT; la GiftBox avvolge le righe eleggibili al Concludi.
  function saveGiftboxDraft() {
    setGbError("");
    if ((clientId ?? 0) <= 0) {
      setGbError("Seleziona un mittente prima di emettere una GiftBox.");
      return;
    }
    if (cart.some((l) => l.type === "giftcard")) {
      setGbError("GiftCard e GiftBox non possono essere abbinate nella stessa vendita. Elimina la GiftBox prima di creare la GiftCard.");
      return;
    }
    if (cart.some((l) => l.type === "recharge")) {
      setGbError("GiftBox e Ricariche non possono essere abbinate nella stessa vendita.");
      return;
    }
    if (giftboxBlockingMessage) {
      setGbError(giftboxBlockingMessage);
      return;
    }
    if (giftboxEligibleLines.length === 0) {
      setGbError("Aggiungi al carrello i servizi/prodotti da inserire nella GiftBox.");
      return;
    }
    if (!gbEventType) {
      setGbError("GiftBox: seleziona un evento.");
      return;
    }
    const validFrom = gbValidFrom || today;
    if (!validFrom) {
      setGbError('GiftBox: inserisci la data "Valida dal".');
      return;
    }
    if (validFrom < today) {
      setGbError('GiftBox: la data "Valida dal" non puo essere nel passato.');
      return;
    }
    const validTo = gbValidTo.trim();
    if (validTo && validFrom >= validTo) {
      setGbError('GiftBox: la data "Valida al" deve essere almeno il giorno successivo a "Valida dal".');
      return;
    }
    const recipientClientId = gbRecipientIsClient ? gbRecipientClientId : 0;
    if (gbRecipientIsClient && recipientClientId <= 0) {
      setGbError("GiftBox: seleziona il cliente destinatario.");
      return;
    }
    const recipientName = gbRecipientName.trim() || (recipientClientId > 0 ? clients.find((c) => c.id === recipientClientId)?.name?.trim() ?? "" : "");
    if (!recipientName) {
      setGbError("GiftBox: inserisci il destinatario.");
      return;
    }
    const recipientEmail = gbRecipientEmail.trim();
    const sendMode: "none" | "now" | "date" = gbDoNotSend ? "none" : gbSendMode;
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setGbError("GiftBox: email destinatario non valida.");
      return;
    }
    if (sendMode !== "none" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setGbError("GiftBox: inserisci una email destinatario valida per inviare la GiftBox.");
      return;
    }
    if (sendMode === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(gbSendOn)) {
        setGbError("GiftBox: data invio non valida.");
        return;
      }
      if (gbSendOn < today) {
        setGbError("GiftBox: la data invio programmato non puo essere nel passato.");
        return;
      }
    }
    setGbDraft({
      eventType: gbEventType,
      validFrom,
      validTo,
      recipientName,
      recipientEmail,
      recipientClientId,
      hideAmount: gbHideAmount,
      message: gbMessage.trim(),
      note: gbNote.trim(),
      internalNote: gbInternalNote.trim(),
      sendMode,
      sendOn: sendMode === "date" ? gbSendOn : "",
      showDetails: gbShowDetails,
    });
    closePosModal("posModalGiftbox");
  }

  // "Elimina" (link nel footer, pos.js): conferma legacy e reset del draft.
  function deleteGiftboxDraft() {
    if (typeof window !== "undefined" && !window.confirm("Eliminare la GiftBox?")) return;
    setGbDraft(null);
    resetGiftboxModal();
    closePosModal("posModalGiftbox");
  }

  // ---- RECHARGE sale (wired) ----
  // The € bonus credit for the current modal inputs — faithful to the backend rechargeBonusAmount
  // (percent: base*value/100, fixed: value, none: 0). Derived during render so the preview always
  // matches what the server will recompute.
  const rechargeBase = useMemo(
    () => roundMoney(Math.max(0, Number.parseFloat(rechargeAmount.replace(",", ".")) || 0)),
    [rechargeAmount],
  );
  const rechargeBonus = useMemo(() => {
    const value = Math.max(0, Number.parseFloat(rechargeBonusValueInput.replace(",", ".")) || 0);
    if (rechargeBonusKindInput === "percent") return roundMoney((rechargeBase * value) / 100);
    if (rechargeBonusKindInput === "fixed") return roundMoney(value);
    return 0;
  }, [rechargeBase, rechargeBonusKindInput, rechargeBonusValueInput]);
  const rechargeTotal = useMemo(() => roundMoney(rechargeBase + rechargeBonus), [rechargeBase, rechargeBonus]);
  // Points preview (informational): floor((earnPoints ? total : base) / euroPerPoint-ish) is not
  // known client-side (the earn step is a business setting, not the redeem rate). We show the
  // earn BASE (importo+bonus vs solo importo) the backend will use; the exact points are computed
  // server-side. Kept simple to avoid drifting from the backend earn rule.
  const rechargeEarnBase = useMemo(
    () => (rechargeEarnPoints ? rechargeTotal : rechargeBase),
    [rechargeEarnPoints, rechargeTotal, rechargeBase],
  );

  // Picking a template precompiles the base/bonus/earn-points (all still editable). The empty
  // option (id 0) is a custom amount — leaves the fields as typed.
  function chooseRechargeTemplate(id: number) {
    setRechargeTemplateId(id);
    const tpl = rechargeTemplates.find((t) => t.id === id);
    if (!tpl) return;
    setRechargeAmount(tpl.baseAmount > 0 ? tpl.baseAmount.toFixed(2) : "");
    setRechargeBonusKindInput(tpl.bonusKind || "none");
    setRechargeBonusValueInput(tpl.bonusValue > 0 ? String(tpl.bonusValue) : "0");
    setRechargeEarnPoints(tpl.earnPoints);
  }

  function resetRechargeModal() {
    setRechargeTemplateId(0);
    setRechargeAmount("");
    setRechargeBonusKindInput("none");
    setRechargeBonusValueInput("0");
    setRechargeEarnPoints(true);
    setRechargeNoteInput("");
  }

  // "Aggiungi alla lista": validate the amount and push a {type:"recharge"} cart line — qty 1 at
  // the BASE amount (what the client pays); the bonus/total/earn-points ride on the line meta so
  // the backend credits the wallet by base+bonus + earns points. The recharge can be added with
  // no client, but checkout requires a real client to conclude (gated server-side). refId = the
  // chosen template id (0 = custom).
  function addRechargeToCart() {
    setErrorMsg("");
    if (rechargeBase <= 0) {
      setErrorMsg("Inserisci un importo ricarica valido.");
      return;
    }
    const label = `Ricarica € ${rechargeBase.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    setCart((prev) => [
      {
        key: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: "recharge",
        refId: rechargeTemplateId > 0 ? rechargeTemplateId : 0,
        name: label,
        quantity: 1,
        unitPrice: rechargeBase,
        status: "prepaid",
        note: rechargeNoteInput.trim() || undefined,
        baseAmount: rechargeBase,
        bonusKind: rechargeBonusKindInput,
        bonusValue: Math.max(0, Number.parseFloat(rechargeBonusValueInput.replace(",", ".")) || 0),
        bonusAmount: rechargeBonus,
        totalAmount: rechargeTotal,
        earnPoints: rechargeEarnPoints,
      },
      ...prev,
    ]);
    resetRechargeModal();
    closePosModal("posModalRecharge");
  }

  // ---- Coupon preview (wired) ----
  // Reset the applied coupon (invalidates any in-flight preview via the req-id).
  const clearCouponState = useCallback(() => {
    couponReqRef.current += 1;
    setCouponCode("");
    setCouponDiscount(0);
  }, []);

  // Apply: validate the typed code against the DB coupons preview endpoint
  // (POST /api/manage/coupons action=preview -> {ok, preview:{valid, discount, reason}},
  // the same endpoint the quick-booking drawer uses). On valid, store the code +
  // discount (revealing the coupon row and subtracting it from the total); on invalid
  // show the reason. The subtotal sent is the cart subtotal (coupon minimums are
  // subtotal-aware; the backend re-validates on checkout so the charged discount agrees).
  const applyCoupon = useCallback(async () => {
    const code = couponInput.trim().toUpperCase();
    setCouponOpen(true);
    if (!code) {
      clearCouponState();
      setCouponInput("");
      setCouponMsg({ text: "Inserisci un codice coupon.", ok: false });
      return;
    }
    if (subtotal <= 0) {
      setCouponMsg({ text: "Aggiungi almeno un elemento al carrello.", ok: false });
      return;
    }
    const myReq = ++couponReqRef.current;
    setCouponApplying(true);
    try {
      // Carrello reale al preview (legacy mode=preview_discount): l'apply_scope
      // del coupon morde su servizi/prodotti effettivi; client_id abilita il
      // limite di utilizzo per cliente.
      const itemsJson = JSON.stringify(
        cart
          .filter((l) => (l.type === "service" || l.type === "product") && l.refId > 0 && l.unitPrice * l.quantity > 0)
          .map((l) => ({ type: l.type, id: l.refId, line: roundMoney(l.unitPrice * l.quantity) })),
      );
      const res = await fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "preview", code, subtotal, items_json: itemsJson, client_id: clientId ?? 0 }),
      });
      const data: { ok?: boolean; error?: string; preview?: { valid?: boolean; discount?: number; reason?: string } } =
        await res.json().catch(() => ({}));
      if (myReq !== couponReqRef.current) return; // stale
      const preview = data?.preview;
      if (res.ok && data?.ok !== false && preview?.valid) {
        const disc = roundMoney(Math.max(0, Number(preview.discount ?? 0)));
        setCouponCode(code);
        setCouponDiscount(disc);
        setCouponInput(code);
        setCouponMsg({ text: "Coupon applicato.", ok: true });
      } else {
        clearCouponState();
        setCouponInput(code);
        setCouponMsg({ text: String(preview?.reason || data?.error || "Coupon non applicabile."), ok: false });
      }
    } catch {
      if (myReq !== couponReqRef.current) return;
      clearCouponState();
      setCouponInput(code);
      setCouponMsg({ text: "Errore durante la verifica del coupon.", ok: false });
    } finally {
      if (myReq === couponReqRef.current) setCouponApplying(false);
    }
  }, [couponInput, subtotal, slug, clearCouponState, cart, clientId]);

  // Remove: clear the applied coupon + the typed code + the feedback.
  const removeCoupon = useCallback(() => {
    clearCouponState();
    setCouponInput("");
    setCouponMsg(null);
  }, [clearCouponState]);

  // ---- Promotion (Block 3b) ----
  const clearPromotion = useCallback(() => {
    setPromotionId(0);
    setPromotionName("");
    setPromotionDiscountRaw(0);
  }, []);

  // "Rileva promozione": evaluate the service/product cart against the active promotions
  // (POST action=evaluate) and apply the best eligible one. promotion_id is then sent on
  // checkout, where the backend re-evaluates + records the redemption.
  const detectPromotion = useCallback(async () => {
    if (subtotal <= 0) {
      setPromotionMsg({ text: "Aggiungi almeno un elemento al carrello.", ok: false });
      return;
    }
    setPromotionEvaluating(true);
    try {
      const promoCart = cart
        .filter((l) => (l.type === "service" || l.type === "product") && l.refId > 0 && l.unitPrice > 0)
        .map((l) => ({ type: l.type, id: l.refId, qty: l.quantity, unitPrice: l.unitPrice }));
      const now = new Date();
      const res = await fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "evaluate",
          cart_json: JSON.stringify(promoCart),
          date: now.toISOString().slice(0, 10),
          time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
          client_id: clientId ?? 0,
        }),
      });
      const data: { ok?: boolean; error?: string; best?: { promotionId: number; title: string; discount: number } | null } = await res.json().catch(() => ({}));
      const best = data?.best;
      if (res.ok && data?.ok && best && best.discount > 0) {
        setPromotionId(best.promotionId);
        setPromotionName(best.title);
        setPromotionDiscountRaw(roundMoney(best.discount));
        setPromotionMsg({ text: `Promozione "${best.title}" applicata.`, ok: true });
      } else {
        clearPromotion();
        setPromotionMsg({ text: "Nessuna promozione applicabile a questo carrello.", ok: false });
      }
    } catch {
      clearPromotion();
      setPromotionMsg({ text: "Errore durante la verifica delle promozioni.", ok: false });
    } finally {
      setPromotionEvaluating(false);
    }
  }, [subtotal, cart, clientId, slug, clearPromotion]);

  // ---- Residui mutators ----
  // Picking a different giftcard resets the applied amount (the balances differ).
  function chooseGiftcard(id: number) {
    setGiftcardId(id);
    setGiftcardUseInput("0");
  }
  // "Max" for fidelity points: apply the most the client can spend on this sale —
  // min(balance, floor(payable / euroPerPoint)). The pointsUsed memo re-clamps.
  function useMaxPoints() {
    setPointsUseInput(String(Math.max(0, Math.min(pointsBalance, maxPointsByAmount))));
  }

  async function handleCheckout(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");
    if (cart.length === 0) {
      setErrorMsg("Aggiungi almeno un elemento prima di concludere la vendita.");
      return;
    }
    // Mirror the backend's "Pagamento insufficiente" client-side.
    if (paymentInsufficient) {
      setErrorMsg("Pagamento insufficiente.");
      return;
    }
    // Residui require a real client (the backend rejects residui on a bench sale).
    if (residuiTotal > 0 && (!clientId || clientId <= 0)) {
      setErrorMsg("Seleziona un cliente per usare credito o GiftCard.");
      return;
    }
    // FIDELITY: block below the configured minimum or above the balance (the backend
    // re-validates + throws, this mirrors it for a clean client-side error).
    if (pointsBelowMin) {
      setErrorMsg(`Minimo punti utilizzabile: ${minPoints}.`);
      return;
    }
    if (pointsOverBalance) {
      setErrorMsg("Punti insufficienti.");
      return;
    }
    if (pointsUsed > 0 && (!clientId || clientId <= 0)) {
      setErrorMsg("Seleziona un cliente per usare i punti.");
      return;
    }
    // RECHARGE: a top-up credits a real client's wallet, so it requires a selected client (the
    // backend skips issuance on a bench sale; this mirrors it for a clean client-side error).
    if (cart.some((line) => line.type === "recharge") && (!clientId || clientId <= 0)) {
      setErrorMsg("Seleziona un cliente per registrare la ricarica.");
      return;
    }

    // GIFTBOX draft attivo (legacy giftbox_draft): le righe eleggibili del
    // carrello (servizi Prepagato + prodotti Ordinato) diventano il CONTENUTO
    // della GiftBox e vengono sostituite da UNA riga giftbox col loro totale —
    // il backend emette l'istanza (saveGiftboxFromCart) e la vendita registra
    // "GiftBox • {code}" come il legacy.
    let checkoutLines: CartLine[] = cart;
    if (gbDraft) {
      if (giftboxBlockingMessage) {
        setErrorMsg(giftboxBlockingMessage);
        return;
      }
      if (giftboxEligibleLines.length === 0) {
        setErrorMsg("Aggiungi al carrello i servizi/prodotti da inserire nella GiftBox.");
        return;
      }
      const eligibleKeys = new Set(giftboxEligibleLines.map((l) => l.key));
      const giftboxLine: CartLine = {
        key: "giftbox-draft",
        type: "giftbox",
        refId: 0,
        name: `GiftBox • ${gbDraft.recipientName}`,
        quantity: 1,
        unitPrice: giftboxContentTotal,
        status: "prepaid",
        expiresAt: gbDraft.validTo || undefined,
        recipientClientId: gbDraft.recipientClientId > 0 ? gbDraft.recipientClientId : undefined,
        recipientName: gbDraft.recipientName || undefined,
        recipientEmail: gbDraft.recipientEmail || undefined,
        eventType: gbDraft.eventType || "giftbox",
        message: gbDraft.message || undefined,
        hideAmount: gbDraft.hideAmount,
        note: gbDraft.note || undefined,
        internalNote: gbDraft.internalNote || undefined,
        sendMode: gbDraft.sendMode,
        sendOn: gbDraft.sendOn || undefined,
        showAmount: gbDraft.showDetails,
        customItems: giftboxEligibleLines.map((l) => ({
          type: l.type === "product" ? ("product" as const) : ("service" as const),
          id: l.refId,
          qty: l.quantity,
        })),
      };
      checkoutLines = [giftboxLine, ...cart.filter((l) => !eligibleKeys.has(l.key))];
    }

    // items_json / payments_json MUST be JSON strings: parseRequestBody() collapses
    // top-level arrays with join(","), so we stringify ourselves.
    const itemsJson = JSON.stringify(
      checkoutLines.map((line) => ({
        type: line.type,
        refId: line.refId,
        name: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        status: line.status,
        // Package meta (only set on package lines): the backend reads these to issue the
        // client_packages row with the right validity window + note.
        ...(line.type === "package"
          ? { startDate: line.startDate ?? "", expiresAt: line.expiresAt ?? "", note: line.note ?? "" }
          : {}),
        // GiftCard meta (only set on giftcard lines): the backend reads these to issue the
        // giftcards row with the chosen recipient/expiry/dedica/hide-amount + le note e
        // l'invio email legacy (items[gc_*]).
        ...(line.type === "giftcard"
          ? {
              recipientClientId: line.recipientClientId ?? 0,
              recipientName: line.recipientName ?? "",
              recipientEmail: line.recipientEmail ?? "",
              code: line.code ?? "",
              eventType: line.eventType ?? "",
              expiresAt: line.expiresAt ?? "",
              message: line.message ?? "",
              hideAmount: line.hideAmount ? 1 : 0,
              note: line.note ?? "",
              internalNote: line.internalNote ?? "",
              sendMode: line.sendMode ?? "now",
              sendOn: line.sendOn ?? "",
              showAmount: line.showAmount === false ? 0 : 1,
            }
          : {}),
        // GiftBox meta (only set on giftbox lines): the backend reads these to issue the
        // giftbox_instances row (owned by the recipient) + its items (dal carrello via
        // customItems / dal template refId). Note + invio email come la giftcard.
        ...(line.type === "giftbox"
          ? {
              recipientClientId: line.recipientClientId ?? 0,
              recipientName: line.recipientName ?? "",
              recipientEmail: line.recipientEmail ?? "",
              eventType: line.eventType ?? "",
              expiresAt: line.expiresAt ?? "",
              message: line.message ?? "",
              hideAmount: line.hideAmount ? 1 : 0,
              note: line.note ?? "",
              internalNote: line.internalNote ?? "",
              sendMode: line.sendMode ?? "now",
              sendOn: line.sendOn ?? "",
              showAmount: line.showAmount === false ? 0 : 1,
              // Custom-build contents (nested array — survives the items_json JSON parse intact,
              // unlike a top-level body field). Present only for a refId-0 custom box.
              ...(line.customItems && line.customItems.length > 0 ? { customItems: line.customItems } : {}),
            }
          : {}),
        // Recharge meta (only set on recharge lines): the backend reads these to insert the
        // recharges row + credit the wallet by base+bonus (the bonus is recomputed server-side).
        ...(line.type === "recharge"
          ? {
              baseAmount: line.baseAmount ?? line.unitPrice,
              bonusKind: line.bonusKind ?? "none",
              bonusValue: line.bonusValue ?? 0,
              bonusAmount: line.bonusAmount ?? 0,
              totalAmount: line.totalAmount ?? line.unitPrice,
              earnPoints: line.earnPoints ? 1 : 0,
              note: line.note ?? "",
            }
          : {}),
      })),
    );
    // Faithful tenders: the residui (wallet credit + chosen giftcard) then the base
    // method for the remainder. Only non-zero tenders are sent; the backend re-validates
    // each residui against the real balances + consumes them, and persists the base
    // method. The giftcard tender carries its giftcardId so the backend knows which card.
    const tenders: Array<{ method: string; amount: number; giftcardId?: number }> = [];
    if (creditUse > 0) tenders.push({ method: "wallet", amount: creditUse });
    if (giftcardUse > 0 && giftcardId > 0) tenders.push({ method: "giftcard", amount: giftcardUse, giftcardId });
    if (baseAmount > 0 || tenders.length === 0) tenders.push({ method: apiPaymentMethod(baseMethod), amount: baseAmount });
    const paymentsJson = JSON.stringify(tenders.filter((tender) => tender.amount > 0));

    const body = {
      action: "checkout",
      slug,
      client_id: clientId ?? 0,
      client_name: clientId ? clientName : "",
      items_json: itemsJson,
      payments_json: paymentsJson,
      discount: manualDiscount,
      coupon_code: couponCode.trim(),
      // PROMOTION applied (Block 3b): the backend re-evaluates the promotion against the
      // cart and refuses the checkout if it is no longer applicable.
      promotion_id: promotionId > 0 ? promotionId : 0,
      // FIDELITY points to spend as a discount (the backend re-validates + consumes them).
      fidelity_points_use: pointsUsed,
      // "Vendita da appuntamento": link the sale to the appointment so the backend marks it
      // 'done' (checkoutManageSale sets appointments.status='done' when appointment_id>0) and
      // stamps "Appuntamento #<id>" on the sale notes. 0 for a normal POS sale.
      appointment_id: appointmentSaleId > 0 ? appointmentSaleId : 0,
      // "Vendita da preventivo": link the sale to the source quote so the backend sets
      // sales.source_quote_id + flips the quote to 'converted'. 0 for a normal POS sale.
      source_quote_id: quoteSaleId > 0 ? quoteSaleId : 0,
      notes: notes.trim(),
      // RATEIZZAZIONE: when a rate plan is active (mode installment + client + count >= 2),
      // send the plan params as JSON. The backend writes the sale_installment_plans row + N
      // sale_installments rows scheduling the financed remainder (total - acconto). Omitted
      // (empty) for a single payment — the common path.
      installment_plan: installmentActive
        ? JSON.stringify({
            count: installmentCount,
            down_payment: installmentDownPayment,
            interval_value: installmentIntervalValue,
            interval_unit: installmentIntervalUnit,
            first_due_date: installmentFirstDueValue,
            note: installmentNote.trim(),
          })
        : "",
    };

    setSubmitting(true);
    try {
      const res = await fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false || json?.error) {
        setErrorMsg(String(json?.error || "Errore durante la conclusione della vendita."));
        return;
      }
      // Success: capture the printable RECEIPT (scontrino) from the server's completed `sale`
      // + the breakdown snapshot taken NOW (before the reset clears the cart state). The shown
      // reductions equal what the backend charged, since the UI mirrors the backend math. The
      // business header rides on the same response (json.business, from getPosBusinessHeader).
      const saleResponse: SaleResponse = (json?.sale ?? {}) as SaleResponse;
      const receiptBusiness: PosBusinessHeader = (json?.business ?? business ?? {}) as PosBusinessHeader;
      // GiftCard/GiftBox codes the backend issued for this sale (only present when a giftcard/
      // giftbox line was actually issued). Captured for the receipt's "Buoni emessi" section.
      const issuedVouchers: IssuedVoucher[] = Array.isArray(json?.issuedVouchers)
        ? (json.issuedVouchers as IssuedVoucher[]).filter((v) => v && String(v.code ?? "").trim() !== "")
        : [];
      setLastSale({
        sale: saleResponse,
        business: receiptBusiness,
        operatorName: "",
        manualDiscount,
        couponCode: couponCode.trim(),
        couponDiscount: codeDiscount,
        pointsUsed,
        fidelityDiscount,
        creditUse,
        giftcardUse,
        giftcardCode: selectedGiftcard?.code ?? "",
        baseMethodLabel: PAYMENT_METHOD_LABELS[baseMethod],
        baseAmount,
        issuedVouchers,
        pointsEarned: Math.max(0, Number(json?.fidelityPointsEarned ?? 0) || 0),
      });
      // Reset the sale state.
      const saleCode = json?.sale?.code ? ` (${json.sale.code})` : "";
      setCart([]);
      setGbDraft(null);
      resetGiftboxModal();
      setDiscountType("none");
      setDiscountValue("0");
      clearCouponState();
      setCouponInput("");
      setCouponMsg(null);
      setCouponOpen(false);
      setBaseMethod("cash");
      setNotes("");
      // Reset the rate plan back to "pagamento unico" (+ default params) for the next sale.
      setInstallmentMode("single");
      setInstallmentDownInput("0");
      setInstallmentCountInput("3");
      setInstallmentIntervalValueInput("1");
      setInstallmentIntervalUnit("month");
      setInstallmentFirstDue("");
      setInstallmentNote("");
      clearClient();
      // The sale is no longer "da appuntamento": clear the link + banner (the appointment is
      // now marked 'done' server-side). A fresh ?appointment= visit re-seeds on a new mount.
      setAppointmentSaleId(0);
      setAppointmentSaleCode("");
      // The sale is no longer "da preventivo": clear the link + banner (the quote is now
      // 'converted' server-side). A fresh ?quote= visit re-seeds on a new mount.
      setQuoteSaleId(0);
      setQuoteSaleCode("");
      setSuccessMsg(`Vendita conclusa${saleCode}.`);
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSuccessMsg(""), 6000);
    } catch {
      setErrorMsg("Errore di rete durante la conclusione della vendita.");
    } finally {
      setSubmitting(false);
    }
  }

  // "Stampa scontrino": port of pos_success.js (window.print()). The scoped @media print rule
  // on the receipt isolates it (hides the app chrome), so only the scontrino prints.
  function printReceipt() {
    try {
      window.print();
    } catch {
      // window.print can be unavailable in some embedded contexts — no-op (matches the legacy
      // try/catch in pos_success.js).
    }
  }

  // "Chiudi" / "Nuova vendita": dismiss the receipt. The cart was already reset on success, so
  // closing the receipt simply hides it and leaves the POS ready for the next sale.
  function closeReceipt() {
    setLastSale(null);
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/pos.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Cassa vendita</div>
          <h1 className="bs-page-title">Pagamenti</h1>
          <div className="bs-page-subtitle">Registra vendite, acconti, GiftCard, GiftBox e ricariche.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/pos_settings`}>
              <i className="bi bi-gear me-1"></i>Impostazioni
            </a>
          </div>
        </div>
      </div>

      {/* "Vendita da appuntamento" banner: shown when the POS was opened with
          ?appointment=<id> and the cart was pre-loaded from that appointment. The
          checkout sends appointment_id, so concluding the sale marks the appointment 'done'. */}
      {appointmentSaleId > 0 ? (
        <div className="alert alert-info d-flex align-items-center gap-2" id="posAppointmentBanner">
          <i className="bi bi-calendar-check"></i>
          <span>
            Vendita da appuntamento <strong>{appointmentSaleCode}</strong> — concludendo la vendita l&apos;appuntamento verrà segnato come eseguito.
          </span>
        </div>
      ) : null}

      {/* "Vendita da preventivo" banner: shown when the POS was opened with ?quote=<id> and the cart
          was pre-loaded from that quote. The checkout sends source_quote_id, so concluding the sale
          links it (sales.source_quote_id) + flips the quote to 'converted'. */}
      {quoteSaleId > 0 ? (
        <div className="alert alert-info d-flex align-items-center gap-2" id="posQuoteBanner">
          <i className="bi bi-file-earmark-text"></i>
          <span>
            Vendita da preventivo <strong>{quoteSaleCode}</strong> — concludendo la vendita il preventivo verrà segnato come convertito.
          </span>
        </div>
      ) : null}

      {/* Stato vuoto legacy (pos.php 5943-5959): senza clienti attivi la cassa
          non è operabile — GiftBox/GiftCard/ricariche/pacchetti richiedono
          sempre un mittente o titolare. */}
      {ctx && clients.length === 0 ? (
        <div className="card p-4 text-center">
          <h5 className="fw-bold">Nessun cliente disponibile</h5>
          <p className="text-muted mb-3">
            Per registrare una vendita in Pagamenti devi prima creare almeno un cliente attivo. GiftBox, GiftCard, ricariche e pacchetti richiedono sempre un mittente o
            titolare selezionato dalla rubrica.
          </p>
          <div className="d-flex justify-content-center gap-2 flex-wrap">
            <a className="btn btn-primary" href={`/${encodeURIComponent(slug)}/clients?action=new`}>
              <i className="bi bi-person-plus me-1" />
              Nuovo cliente
            </a>
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients`}>
              <i className="bi bi-people me-1" />
              Apri Clienti
            </a>
          </div>
        </div>
      ) : null}

      <form method="post" id="posForm" onSubmit={handleCheckout} className={ctx && clients.length === 0 ? "d-none" : undefined}>
        <input type="hidden" name="location_id" value={ctx?.activeLocationId ?? ""} />

        <div className="pos-grid">
          {/* COLONNA SINISTRA: CLIENTI */}
          <div className="pos-panel">
            <div className="pos-panel-head">
              <div className="d-flex align-items-center justify-content-between">
                <div className="fw-semibold">Clienti</div>
                <a
                  className="btn btn-sm btn-outline-primary"
                  href={`/${encodeURIComponent(slug)}/clients`}
                  title="Apri rubrica clienti"
                >
                  <i className="bi bi-people"></i>
                </a>
              </div>
            </div>

            <div className="p-2">
              <div className="input-group input-group-sm">
                <span className="input-group-text">
                  <i className="bi bi-search"></i>
                </span>
                <input
                  className="form-control"
                  id="posClientSearch"
                  placeholder="Cerca Cliente..."
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="pos-client-list" id="posClientList">
              {filteredClients.map((c) => (
                <button
                  type="button"
                  className={`pos-client-row${clientId === c.id ? " active" : ""}`}
                  data-client-id={c.id}
                  data-client-name={c.name}
                  key={c.id}
                  onClick={() => selectClient(c.id, c.name)}
                >
                  <div className="fw-semibold">{c.name}</div>
                  <div className="small text-muted">{c.phone ? c.phone : `ID: ${c.id}`}</div>
                </button>
              ))}
            </div>
          </div>

          {/* COLONNA CENTRALE: CARRELLO + CATALOGO */}
          <div className="pos-panel">
            <div className="pos-panel-head">
              <div className="d-flex justify-content-between align-items-end">
                <div>
                  <div className="small text-muted">Cliente selezionato</div>
                  <div className="d-flex align-items-center gap-2">
                    <div className="fw-semibold" id="posClientLabel">
                      {clientName || "—"}
                    </div>
                    <button
                      type="button"
                      className={`btn btn-sm btn-link text-muted p-0${clientId ? "" : " d-none"}`}
                      id="posClientClearBtn"
                      title="Rimuovi cliente selezionato"
                      onClick={clearClient}
                    >
                      <i className="bi bi-x-circle"></i>
                    </button>
                  </div>
                </div>
                <div className="text-end">
                  <div className="small text-muted">Codice tessera</div>
                  <div className="fw-semibold" id="posCardCode">
                    —
                  </div>
                </div>
              </div>
            </div>

            <div className="pos-cart-table">
              <table className="table table-sm align-middle mb-0" id="itemsTable">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Elemento</th>
                    <th className="pos-col-qty">Q.tà</th>
                    <th className="pos-col-price">Prezzo</th>
                    <th className="pos-col-total">Totale</th>
                    <th className="pos-col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted">
                        Aggiungi almeno un elemento.
                      </td>
                    </tr>
                  ) : (
                    cart.map((line) => {
                      // A package line is a fixed single unit (qty locked, like the legacy
                      // disabled qty input); the validity window/note + session count show
                      // under the name. A prepaid line is a per-session service (qty = sessions).
                      // A giftcard line is also a fixed single unit (the card amount); the
                      // recipient/expiry show under the name.
                      const isPackage = line.type === "package";
                      const isGiftcard = line.type === "giftcard";
                      const isGiftbox = line.type === "giftbox";
                      const isRecharge = line.type === "recharge";
                      const label = isPackage
                        ? `Pacchetto • ${line.name}`
                        : line.type === "prepaid"
                          ? `Prepagato • ${line.name}`
                          : isRecharge
                            ? `Ricarica • ${line.name}`
                            : line.name;
                      const subLine = isPackage
                        ? [
                            line.startDate ? `Valido dal: ${line.startDate}` : "",
                            line.expiresAt ? `Valido al: ${line.expiresAt}` : "",
                            line.sessions ? `${line.sessions} sedute` : "",
                            line.note ? line.note : "",
                          ]
                            .filter(Boolean)
                            .join(" • ")
                        : line.type === "prepaid"
                          ? `${line.quantity} sedute prepagate`
                          : isGiftcard
                            ? [
                                line.recipientName ? `Destinatario: ${line.recipientName}` : "",
                                line.code ? `Codice: ${line.code}` : "Codice: auto",
                                line.expiresAt ? `Valida al: ${line.expiresAt}` : "",
                              ]
                                .filter(Boolean)
                                .join(" • ")
                            : isGiftbox
                              ? [
                                  line.recipientName ? `Destinatario: ${line.recipientName}` : "",
                                  "Codice: auto",
                                  line.expiresAt ? `Valida al: ${line.expiresAt}` : "",
                                ]
                                  .filter(Boolean)
                                  .join(" • ")
                              : isRecharge
                                ? [
                                    (line.bonusAmount ?? 0) > 0 ? `Bonus: ${fmtEUR(line.bonusAmount ?? 0)}` : "",
                                    `Credito caricato: ${fmtEUR(line.totalAmount ?? line.unitPrice)}`,
                                    line.earnPoints ? "Punti su importo + bonus" : "Punti su solo importo",
                                    line.note ? line.note : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" • ")
                                : "";
                      return (
                      <tr data-item-row="1" data-type={line.type} data-id={line.refId} key={line.key}>
                        <td className="text-uppercase small">{line.type}</td>
                        <td>
                          <div className="fw-semibold pos-item-name">{label}</div>
                          {subLine ? <div className="text-muted small">{subLine}</div> : null}
                          {line.type === "service" || line.type === "product" ? (
                            /* Stato riga legacy (buildItemStatusControl): badge +
                               switch "Eseguito / Prepagato" (servizi) e
                               "Ritirato / Ordinato" (prodotti). */
                            <div className="d-flex align-items-center gap-2 mt-1">
                              <span
                                className={`badge js-item-status-label ${
                                  line.type === "service"
                                    ? line.status === "prepaid"
                                      ? "text-bg-secondary"
                                      : "text-bg-success"
                                    : line.status === "ordered"
                                      ? "text-bg-secondary"
                                      : "text-bg-success"
                                }`}
                              >
                                {line.type === "service" ? (line.status === "prepaid" ? "Prepagato" : "Eseguito") : line.status === "ordered" ? "Ordinato" : "Ritirato"}
                              </span>
                              <div className="form-check form-switch mb-0">
                                <input
                                  className="form-check-input js-item-status-toggle"
                                  type="checkbox"
                                  checked={line.type === "service" ? line.status !== "prepaid" : line.status !== "ordered"}
                                  onChange={(e) => {
                                    const on = e.target.checked;
                                    setCart((prev) =>
                                      prev.map((l) =>
                                        l.key === line.key
                                          ? { ...l, status: l.type === "service" ? (on ? "executed" : "prepaid") : on ? "collected" : "ordered" }
                                          : l,
                                      ),
                                    );
                                  }}
                                />
                                <label className="form-check-label small text-muted">
                                  {line.type === "service" ? "Eseguito / Prepagato" : "Ritirato / Ordinato"}
                                </label>
                              </div>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <input
                            className="form-control form-control-sm pos-qty-input"
                            type="number"
                            min={1}
                            step={1}
                            value={line.quantity}
                            disabled={isPackage || isGiftcard || isGiftbox || isRecharge}
                            onChange={(e) => setQty(line.key, Number.parseInt(e.target.value, 10))}
                          />
                        </td>
                        <td className="text-end small">{fmtEUR(line.unitPrice)}</td>
                        <td className="text-end small line-total">{fmtEUR(line.unitPrice * line.quantity)}</td>
                        <td className="text-end">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => removeLine(line.key)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-3 border-top">
              <div className="d-flex gap-2 align-items-center flex-wrap">
                <div className="input-group input-group-sm pos-catalog-search">
                  <span className="input-group-text">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    className="form-control"
                    id="posCatalogSearch"
                    placeholder="Cerca..."
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                </div>

                <select
                  className="form-select form-select-sm pos-catalog-category"
                  id="posCatalogCategory"
                  value={catalogCategory}
                  onChange={(e) => setCatalogCategory(e.target.value)}
                >
                  <option value="">Tutte le aree</option>
                  {catalogCategories.map((cat) => (
                    <option value={cat} key={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <div
                  className="ms-auto btn-group btn-group-sm pos-catalog-type-tabs"
                  role="group"
                  aria-label="Catalogo"
                >
                  <button
                    type="button"
                    className={`btn btn-outline-primary${catalogMode === "service" ? " active" : ""}`}
                    id="posCatalogBtnServices"
                    onClick={() => { setCatalogMode("service"); setCatalogCategory(""); }}
                  >
                    <i className="bi bi-scissors me-1"></i>Servizi
                  </button>
                  <button
                    type="button"
                    className={`btn btn-outline-primary${catalogMode === "product" ? " active" : ""}`}
                    id="posCatalogBtnProducts"
                    onClick={() => { setCatalogMode("product"); setCatalogCategory(""); }}
                  >
                    <i className="bi bi-bag me-1"></i>Prodotti
                  </button>
                </div>
              </div>

              <div className="pos-catalog-grid mt-3" id="posCatalogGrid">
                {tiles.length === 0 ? (
                  <div className="text-muted small">{loading ? "Caricamento…" : "Nessun risultato."}</div>
                ) : (
                  tiles.map((tile) => (
                    <div
                      className="pos-tile"
                      data-id={tile.id}
                      data-type={catalogMode}
                      data-base-price={tile.price.toFixed(2)}
                      key={`${catalogMode}-${tile.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => addTile(tile)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          addTile(tile);
                        }
                      }}
                    >
                      <div className="pos-tile-name">{tile.name}</div>
                      <div className="pos-tile-meta">
                        <div className="small text-muted">
                          {catalogMode === "product" && tile.stock !== undefined ? `Stock: ${tile.stock}` : ""}
                          {/* Prepaid affordance: sell this SERVICE as prepaid (a session
                              pack) instead of executing it now. Stops the tile's add. */}
                          {catalogMode === "service" ? (
                            <span
                              role="button"
                              tabIndex={0}
                              className="badge bg-light text-primary border pos-tile-prepaid-btn"
                              title="Vendi come prepagato (sedute)"
                              onClick={(e) => {
                                e.stopPropagation();
                                addPrepaidTile(tile);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  addPrepaidTile(tile);
                                }
                              }}
                            >
                              + Prepagato
                            </span>
                          ) : null}
                        </div>
                        <div className="text-end">
                          <div className="pos-tile-price-row">
                            <span className="pos-tile-price-old d-none">{fmtEUR(tile.price)}</span>
                            <span className="pos-tile-price">{fmtEUR(tile.price)}</span>
                            <span className="badge bg-success pos-tile-promo-badge d-none">Promo</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="pos-bottom-bar mt-3">
                {/* Advanced line types — rendered faithfully, modals open but non-wired. */}
                <button
                  type="button"
                  className="btn btn-light pos-bottom-btn"
                  id="posBtnPackages"
                  data-bs-toggle="modal"
                  data-bs-target="#posModalPackages"
                >
                  <i className="bi bi-box-seam me-1"></i>Pacchetti
                </button>
                <button
                  type="button"
                  className="btn btn-light pos-bottom-btn"
                  id="posBtnRecharge"
                  data-bs-toggle="modal"
                  data-bs-target="#posModalRecharge"
                >
                  <i className="bi bi-arrow-repeat me-1"></i>Ricariche
                </button>
                <button
                  type="button"
                  className="btn btn-light pos-bottom-btn"
                  id="posBtnGiftbox"
                  data-bs-toggle="modal"
                  data-bs-target="#posModalGiftbox"
                >
                  <i className="bi bi-gift me-1"></i>GiftBox
                </button>
                <button
                  type="button"
                  className="btn btn-light pos-bottom-btn"
                  id="posBtnGiftcard"
                  data-bs-toggle="modal"
                  data-bs-target="#posModalGiftcard"
                >
                  <i className="bi bi-credit-card-2-front me-1"></i>GiftCard
                </button>
              </div>

              {/* Select nascosti: nell'originale li usa lo script addItem() */}
              <div className="d-none">
                <select className="form-select" id="serviceSelect" defaultValue="">
                  <option value="">Seleziona...</option>
                  {services.map((s) => (
                    <option value={s.id} data-price={parsePrice(s.price).toFixed(2)} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <select className="form-select" id="productSelect" defaultValue="">
                  <option value="">Seleziona...</option>
                  {products.map((p) => (
                    <option value={p.id} data-price={parsePrice(p.price).toFixed(2)} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* COLONNA DESTRA: DETTAGLIO PREZZI / SCONTI / FIDELITY */}
          <div className="pos-panel">
            <div className="pos-panel-head">
              <div className="fw-semibold">Dettaglio prezzi</div>
            </div>

            <div className="p-3">
              {/* Select cliente reale (nascosto) */}
              <div className="d-none">
                <select className="form-select" name="client_id" id="posClient" value={clientId ?? ""} onChange={() => undefined}>
                  <option value="">Nessuno</option>
                  {clients.map((c) => (
                    <option value={c.id} data-email={c.email ?? ""} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                <span className="badge bg-light text-dark">
                  Fidelity: <span id="posClientAdhering">—</span>
                </span>
                <span className="badge bg-light text-dark">
                  Punti: <span id="posClientPoints">{clientId ? pointsBalance : 0}</span>
                </span>
              </div>
              <div className="small text-muted mb-3" id="posRedeemInfo">
                {!clientId
                  ? "Seleziona un cliente per vedere punti, credito, omaggi disponibili."
                  : residualsLoading
                    ? "Caricamento residui…"
                    : creditAvailable > 0 || (residuals?.giftcards.length ?? 0) > 0
                      ? `Residui disponibili: Credito ${fmtEUR(creditAvailable)}${(residuals?.giftcards.length ?? 0) > 0 ? `, ${residuals?.giftcards.length} GiftCard` : ""}.`
                      : "Nessun credito o GiftCard disponibile per il cliente."}
              </div>

              <label className="form-label small text-muted mb-1">Coupon</label>
              <div className="border rounded p-2 bg-light-subtle">
                <div className="small fw-semibold mb-1">
                  <i className="bi bi-megaphone me-1"></i>Promozioni / Coupon
                </div>
                <a
                  href="#"
                  className="text-success small text-decoration-underline"
                  id="couponToggle"
                  onClick={(e) => {
                    e.preventDefault();
                    setCouponOpen((v) => !v);
                  }}
                >
                  Hai un codice coupon?
                </a>
                <div className={`mt-2${couponOpen ? "" : " d-none"}`} id="couponBox">
                  <div className="input-group input-group-sm">
                    <input
                      type="text"
                      className="form-control"
                      name="coupon_code"
                      id="coupon_code"
                      placeholder="ES. WELCOME10"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void applyCoupon();
                        }
                      }}
                    />
                    <button
                      className="btn btn-outline-success"
                      type="button"
                      id="couponApplyBtn"
                      disabled={couponApplying}
                      onClick={() => void applyCoupon()}
                    >
                      Applica
                    </button>
                    <button
                      className="btn btn-outline-secondary"
                      type="button"
                      id="couponRemoveBtn"
                      disabled={couponApplying}
                      onClick={removeCoupon}
                    >
                      Rimuovi
                    </button>
                  </div>
                  <div
                    className={`form-text${couponMsg ? (couponMsg.ok ? " text-success" : " text-danger") : ""}`}
                    id="couponHelp"
                  >
                    {couponMsg?.text ?? ""}
                  </div>
                </div>

                <div className="mt-2" id="posPromotionBox">
                  <div className="input-group input-group-sm">
                    <button
                      className="btn btn-outline-primary"
                      type="button"
                      id="posPromotionDetectBtn"
                      disabled={promotionEvaluating || subtotal <= 0}
                      onClick={() => void detectPromotion()}
                    >
                      <i className="bi bi-magic me-1" />
                      {promotionEvaluating ? "Verifica…" : "Rileva promozione"}
                    </button>
                    {promotionId > 0 ? (
                      <button
                        className="btn btn-outline-secondary"
                        type="button"
                        onClick={() => {
                          clearPromotion();
                          setPromotionMsg(null);
                        }}
                      >
                        Rimuovi
                      </button>
                    ) : null}
                  </div>
                  <div className={`form-text${promotionMsg ? (promotionMsg.ok ? " text-success" : " text-danger") : ""}`}>
                    {promotionMsg?.text ?? "Applica automaticamente la migliore promozione attiva sul carrello."}
                  </div>
                </div>
              </div>

              <div className="row g-2 mb-2">
                <div className="col-5">
                  <label className="form-label small text-muted mb-1">Sconto</label>
                  <select
                    className="form-select form-select-sm"
                    name="discount_type"
                    id="discount_type"
                    value={discountType}
                    onChange={(e) => setDiscountType(e.target.value as "none" | "percent" | "fixed")}
                  >
                    <option value="none">Nessuno</option>
                    <option value="percent">%</option>
                    <option value="fixed">€</option>
                  </select>
                </div>
                <div className="col-7">
                  <label className="form-label small text-muted mb-1">&nbsp;</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="form-control form-control-sm"
                    name="discount_value"
                    id="discount_value"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                  />
                </div>
              </div>

              {/* Fidelity / punti — WIRED: shown when the selected client has points and the
                  business has redemption enabled. The staff types points to use; the € discount
                  (punti x euroPerPoint) is clamped to min(balance, floor(payable / euroPerPoint))
                  and subtracted from the total. "Max" applies the most spendable. fidelity_points_use
                  is sent on checkout (the backend re-validates + consumes the points). */}
              <div id="posFidelityRedeemBox" className={fidelityEnabled ? "" : "d-none"}>
                <label className="form-label small text-muted mb-1">
                  Punti da usare (disp. <strong>{pointsBalance}</strong>)
                </label>
                <div className="input-group input-group-sm mb-1">
                  <input
                    type="number"
                    step="1"
                    min="0"
                    className="form-control"
                    name="fidelity_points_use"
                    id="fidelity_points_use"
                    value={pointsUseInput}
                    onChange={(e) => setPointsUseInput(e.target.value)}
                  />
                  <button type="button" className="btn btn-outline-secondary" id="pointsMaxBtn" onClick={useMaxPoints}>
                    Max
                  </button>
                </div>
                <div
                  className={`small mb-2${pointsBelowMin || pointsOverBalance ? " text-danger" : " text-muted"}`}
                  id="fidelityHelp"
                >
                  {pointsOverBalance
                    ? "Punti insufficienti."
                    : pointsBelowMin
                      ? `Per usare i punti devi usarne almeno ${minPoints}.`
                      : pointsUsed > 0
                        ? `${pointsUsed} punti = sconto ${fmtEUR(fidelityDiscount)} (${fmtEUR(euroPerPoint)}/punto).`
                        : `1 punto = ${fmtEUR(euroPerPoint)}${minPoints > 0 ? `, minimo ${minPoints} punti.` : "."}`}
                </div>
              </div>

              {/* Residui (credito/giftcard) — box legacy: SOLO riepilogo + link
                  "Apri scheda" che apre il modale #posResidualsModal (i controlli
                  vivono nel modale, come pos.php 6286-6296 + renderResidualsModal). */}
              <div
                className={`card p-2 mb-2${clientId && (creditAvailable > 0 || (residuals?.giftcards.length ?? 0) > 0) ? "" : " d-none"}`}
                id="posResidualsBox"
              >
                <div className="d-flex justify-content-between align-items-center">
                  <div className="fw-semibold">Residui</div>
                  <a
                    href="#"
                    className="small text-decoration-none"
                    id="posResidualsOpen"
                    data-bs-toggle="modal"
                    data-bs-target="#posResidualsModal"
                    onClick={() => {
                      // Seed del draft modale dai valori applicati.
                      setRmCreditAmt(creditUseInput);
                      setRmGiftcardId(giftcardId);
                      setRmGiftcardAmt(giftcardUseInput);
                    }}
                  >
                    Apri scheda
                  </a>
                </div>
                <div className="small mt-2" id="posResidualsSummary">
                  {(() => {
                    const parts: string[] = [];
                    if (creditAvailable > 0.00001) parts.push(`Credito disponibile ${fmtEUR(creditAvailable)}`);
                    const gcCount = residuals?.giftcards.length ?? 0;
                    if (gcCount > 0) parts.push(gcCount === 1 ? "1 GiftCard disponibile" : `${gcCount} GiftCard disponibili`);
                    if (cart.some((l) => l.type === "recharge")) parts.push("Non utilizzabili con una ricarica in carrello");
                    const applied: string[] = [];
                    if (giftcardId > 0 && giftcardUse > 0.00001) {
                      applied.push(`GiftCard ${selectedGiftcard?.code || `#${giftcardId}`} ${fmtEUR(giftcardUse)}`);
                    }
                    if (creditUse > 0.00001) applied.push(`Credito ${fmtEUR(creditUse)}`);
                    if (applied.length) parts.push(`In uso: ${applied.join(" • ")}`);
                    return parts.join(" • ");
                  })()}
                </div>

                <input type="hidden" name="credit_use" id="pos_credit_use" value={creditUse} readOnly />
                <input type="hidden" name="giftcard_id" id="pos_giftcard_id" value={giftcardId} readOnly />
                <input type="hidden" name="giftcard_use" id="pos_giftcard_use" value={giftcardUse} readOnly />
              </div>

              <div className="card p-3" id="posPriceDetails">
                {/* BASE PAYMENT — the faithful single payment_type selector
                    (Contanti/Carta/Assegno/Bonifico) for the REMAINDER after residui.
                    base = total − credito − giftcard; the residui are applied in the
                    Residui panel above. The bar shows the residui applied + the base. */}
                <div className="mb-3 pos-payment-type-card" id="posPaymentTypeBox">
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <div className="small text-muted">Tipo pagamento</div>
                  </div>

                  {/* Radio btn-check legacy (Contanti/Carta/Assegno/Bonifico) al
                      posto della select — pos.php 6298-6319. */}
                  <div className="row g-2 mb-2" role="group" aria-label="Metodo di pagamento">
                    {(["cash", "card", "check", "bank"] as PaymentMethod[]).map((method) => (
                      <div className="col-6" key={method}>
                        <input
                          type="radio"
                          className="btn-check"
                          name="payment_type"
                          id={`posPaymentType_${method}`}
                          checked={baseMethod === method}
                          onChange={() => setBaseMethod(method)}
                        />
                        <label
                          className="btn btn-sm btn-outline-secondary w-100"
                          htmlFor={`posPaymentType_${method}`}
                          title={method === "card" ? "Carta di Credito" : method === "bank" ? "Bonifico" : undefined}
                        >
                          {PAYMENT_METHOD_LABELS[method]}
                        </label>
                      </div>
                    ))}
                  </div>

                  <div className="input-group input-group-sm mb-2" id="posPaymentBaseRow">
                    <span className="input-group-text">€</span>
                    <input
                      className="form-control text-end"
                      id="posPaymentBaseAmount"
                      type="text"
                      readOnly
                      value={baseAmount.toFixed(2)}
                      aria-label="Importo a carico del metodo base"
                    />
                  </div>

                  {residuiTotal > 0 ? (
                    <div className="d-flex justify-content-between small text-muted" id="posPaymentResiduiRow">
                      <span>Residui applicati</span>
                      <span id="posPaymentResiduiVal">- {fmtEUR(residuiTotal)}</span>
                    </div>
                  ) : null}
                  <div className="d-flex justify-content-between small" id="posPaymentPaidRow">
                    <span className="text-muted">Pagato</span>
                    <span id="posPaymentPaidVal">{fmtEUR(paidTotal)}</span>
                  </div>
                  <div
                    className={`d-flex justify-content-between small${remainingToPay > 0 ? " text-danger fw-semibold" : " text-muted"}`}
                    id="posPaymentRemainingRow"
                  >
                    <span>Rimanente</span>
                    <span id="posPaymentRemainingVal">{fmtEUR(remainingToPay)}</span>
                  </div>

                  <div className="form-text mt-2" id="posPaymentTypeHelp">
                    {paymentInsufficient
                      ? "Pagamento insufficiente: i pagamenti devono coprire il totale."
                      : "Seleziona come paga il cliente il residuo dopo eventuali credito/GiftCard."}
                  </div>
                </div>

                {/* Rateizzazione (installment plan) — WIRED: the staff chooses "Pagamento
                    unico" (no plan) or "Rateizzato" (the modal configures acconto + rate +
                    intervallo + prima scadenza). When a rate plan is active, the summary shows
                    the financed remainder + the per-rata schedule, and checkout sends
                    installment_plan JSON (the backend writes the sale_installment_plans row +
                    the sale_installments rows). A rate plan needs a real client + positive
                    total; the badge prompts when those are missing. */}
                <div className="mb-3 pos-installment-card" id="posInstallmentCard">
                  <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
                    <div className="small text-muted mb-0" id="posInstallmentHeadline">
                      Seleziona modalità di saldo
                    </div>
                    <span
                      className={`badge rounded-pill pos-installment-required-badge${installmentMode === "installment" && (!clientId || clientId <= 0 || total <= 0.00001) ? "" : " d-none"}`}
                      id="posInstallmentRequiredBadge"
                    >
                      {!clientId || clientId <= 0 ? "Seleziona un cliente" : "Totale a zero"}
                    </span>
                  </div>
                  <div className="pos-installment-choice-grid">
                    <button
                      type="button"
                      className={`btn pos-installment-choice-btn${installmentMode === "single" ? " active" : ""}`}
                      id="posInstallmentSingleBtn"
                      aria-pressed={installmentMode === "single"}
                      onClick={chooseInstallmentSingle}
                    >
                      Pagamento unico
                    </button>
                    <button
                      type="button"
                      className={`btn pos-installment-choice-btn${installmentMode === "installment" ? " active" : ""}`}
                      id="posInstallmentConfigureBtn"
                      aria-pressed={installmentMode === "installment"}
                      data-bs-toggle="modal"
                      data-bs-target="#posInstallmentModal"
                    >
                      Rateizzato
                    </button>
                  </div>
                  <div className="form-text mt-2" id="posInstallmentHelp">
                    Seleziona esplicitamente se il cliente paga in unica soluzione oppure con un piano rate.
                  </div>

                  <div className={`pos-installment-summary${installmentActive ? "" : " d-none"}`} id="posInstallmentSummary">
                    <div className="small fw-semibold mb-1" id="posInstallmentSummaryText">
                      Piano rate: acconto {fmtEUR(installmentDownPayment)} • residuo {fmtEUR(installmentFinanced)} •{" "}
                      {installmentCount} rate • prima scadenza {installmentFirstDueValue}
                    </div>
                    <div
                      className={`small text-muted mb-2${installmentNote.trim() ? "" : " d-none"}`}
                      id="posInstallmentSummaryNote"
                    >
                      {installmentNote.trim()}
                    </div>
                    <div className="table-responsive mb-2" id="posInstallmentScheduleWrap">
                      <table className="table table-sm mb-2 pos-installment-schedule-table">
                        <thead>
                          <tr>
                            <th>Rata</th>
                            <th>Scadenza</th>
                            <th className="text-end">Importo</th>
                          </tr>
                        </thead>
                        <tbody id="posInstallmentScheduleBody">
                          {installmentSchedule.map((row) => (
                            <tr key={row.no}>
                              <td>{row.no}</td>
                              <td>{row.dueDate}</td>
                              <td className="text-end">{fmtEUR(row.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-outline-primary btn-sm"
                        id="posInstallmentEditBtn"
                        data-bs-toggle="modal"
                        data-bs-target="#posInstallmentModal"
                      >
                        Modifica
                      </button>
                    </div>
                  </div>
                </div>

                <div className="d-flex justify-content-between">
                  <span>Subtotale</span>
                  <strong id="posSubtotalVal">{fmtEUR(subtotal)}</strong>
                </div>

                <div
                  className={`d-flex justify-content-between text-muted small${promotionDiscount > 0 ? "" : " d-none"}`}
                  id="posPromotionRow"
                >
                  <span>{promotionName ? `Promozione (${promotionName})` : "Promozione"}</span>
                  <span>- {fmtEUR(promotionDiscount)}</span>
                </div>

                <div
                  className={`d-flex justify-content-between text-muted small${codeDiscount > 0 ? "" : " d-none"}`}
                  id="posCodeDiscountRow"
                >
                  <span id="posCodeDiscountLabel">{couponCode ? `Coupon (${couponCode})` : "Coupon"}</span>
                  <span id="posCodeDiscountVal">- {fmtEUR(codeDiscount)}</span>
                </div>

                <div
                  className={`d-flex justify-content-between text-muted small${manualDiscount > 0 ? "" : " d-none"}`}
                  id="posManualDiscountRow"
                >
                  <span>Sconto</span>
                  <span id="posManualDiscountVal">- {fmtEUR(manualDiscount)}</span>
                </div>

                <div
                  className={`d-flex justify-content-between text-muted small${fidelityDiscount > 0 ? "" : " d-none"}`}
                  id="posFidelityRow"
                >
                  <span id="posFidelityLabel">Sconto Punti{pointsUsed > 0 ? ` (${pointsUsed} pt)` : ""}</span>
                  <span id="posFidelityVal">- {fmtEUR(fidelityDiscount)}</span>
                </div>

                <div className={`d-flex justify-content-between text-muted small${giftcardUse > 0 ? "" : " d-none"}`} id="posGiftcardRow">
                  <span>GiftCard{selectedGiftcard?.code ? ` (${selectedGiftcard.code})` : ""}</span>
                  <span id="posGiftcardVal">- {fmtEUR(giftcardUse)}</span>
                </div>

                <div className={`d-flex justify-content-between text-muted small${creditUse > 0 ? "" : " d-none"}`} id="posCreditRow">
                  <span>Credito</span>
                  <span id="posCreditVal">- {fmtEUR(creditUse)}</span>
                </div>

                <hr />

                <div className="d-flex justify-content-between">
                  <span>Totale</span>
                  <strong id="posTotalVal">{fmtEUR(total)}</strong>
                </div>
              </div>

              <label className="form-label small text-muted mb-1 mt-3">Note</label>
              <textarea
                className="form-control form-control-sm"
                name="notes"
                id="notes"
                rows={3}
                placeholder="Note interne..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              ></textarea>

              <button
                className="btn btn-success w-100 mt-3"
                type="submit"
                id="posConcludeBtn"
                disabled={submitting || paymentInsufficient || pointsBelowMin || pointsOverBalance || cart.length === 0}
              >
                <i className="bi bi-check2-circle me-1"></i>
                {submitting ? "Conclusione…" : "Concludi"}
              </button>
              <div className={`small text-danger mt-2${errorMsg ? "" : " d-none"}`} id="posConcludeHelp">
                {errorMsg}
              </div>
              {successMsg ? <div className="small text-success mt-2">{successMsg}</div> : null}
            </div>
          </div>
        </div>
      </form>

      {/* ===================== MODALI (resi fedelmente; avanzati non collegati) ===================== */}

      {/* MODAL: RESIDUI */}
      <div className="modal fade" id="posResidualsModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content pos-modal-full-height">
            <div className="modal-header align-items-start">
              <div className="d-flex align-items-start w-100">
                <div>
                  <div className="small-muted">Cliente</div>
                  <h5 className="modal-title fw-bold m-0">Residui</h5>
                </div>
                <div className="ms-auto d-flex flex-column align-items-end text-end">
                  <div className="small text-muted mt-1">Usa Credito e/o GiftCard disponibili per questa vendita.</div>
                </div>
              </div>
              <button type="button" className="btn-close ms-2" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>
            <div className="modal-body">
              <div className="small text-muted mb-3">
                Cliente: <strong id="posResidualsClientLabel">{clientId ? clientName : "—"}</strong>
              </div>

              {creditAvailable <= 0 && (residuals?.giftcards.length ?? 0) === 0 ? (
                <div className="alert alert-light border small" id="posResidualsEmptyState">
                  Nessun residuo disponibile per il cliente selezionato.
                </div>
              ) : null}

              {creditAvailable > 0 ? (
                <div className="card p-3 mb-3" id="posResidualCreditCard">
                  <div className="fw-semibold mb-1">Credito</div>
                  <div className="small text-muted mb-3">Utilizza il credito disponibile del cliente per questa vendita.</div>

                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="posResidualCreditToggle"
                      checked={Number(rmCreditAmt.replace(",", ".")) > 0}
                      onChange={(e) => setRmCreditAmt(e.target.checked ? String(roundMoney(Math.min(creditAvailable, total))) : "0")}
                    />
                    <label className="form-check-label" htmlFor="posResidualCreditToggle">
                      Disponibile: <strong id="posResidualCreditAvail">{fmtEUR(creditAvailable)}</strong>
                    </label>
                  </div>

                  <label className="form-label small text-muted mb-1">Importo da usare</label>
                  <div className="input-group input-group-sm">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="form-control"
                      id="posResidualCreditAmount"
                      value={rmCreditAmt}
                      onChange={(e) => setRmCreditAmt(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-outline-secondary"
                      id="posResidualCreditMaxBtn"
                      onClick={() => setRmCreditAmt(String(roundMoney(Math.min(creditAvailable, total))))}
                    >
                      Usa max
                    </button>
                  </div>
                </div>
              ) : null}

              {(residuals?.giftcards.length ?? 0) > 0 ? (
                <div className="card p-3" id="posResidualGiftcardCard">
                  <div className="fw-semibold mb-1">GiftCard</div>
                  <div className="small text-muted mb-3">Seleziona una GiftCard disponibile e scegli l&apos;importo da usare.</div>

                  <div id="posResidualGiftcardList" className="mb-3">
                    {residuals?.giftcards.map((card) => (
                      <div className="form-check" key={card.id}>
                        <input
                          className="form-check-input"
                          type="radio"
                          name="posResidualGiftcardPick"
                          id={`posResidualGiftcard_${card.id}`}
                          checked={rmGiftcardId === card.id}
                          onChange={() => {
                            setRmGiftcardId(card.id);
                            setRmGiftcardAmt(String(roundMoney(Math.min(card.balance, total))));
                          }}
                        />
                        <label className="form-check-label" htmlFor={`posResidualGiftcard_${card.id}`}>
                          {card.code || `GiftCard #${card.id}`} — <strong>{fmtEUR(card.balance)}</strong>
                        </label>
                      </div>
                    ))}
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="posResidualGiftcardPick"
                        id="posResidualGiftcard_none"
                        checked={rmGiftcardId === 0}
                        onChange={() => {
                          setRmGiftcardId(0);
                          setRmGiftcardAmt("0");
                        }}
                      />
                      <label className="form-check-label" htmlFor="posResidualGiftcard_none">
                        Nessuna
                      </label>
                    </div>
                  </div>

                  {rmGiftcardId > 0 ? (
                    <div id="posResidualGiftcardControls">
                      <label className="form-label small text-muted mb-1">Importo da usare</label>
                      <div className="input-group input-group-sm">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="form-control"
                          id="posResidualGiftcardAmount"
                          value={rmGiftcardAmt}
                          onChange={(e) => setRmGiftcardAmt(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          id="posResidualGiftcardMaxBtn"
                          onClick={() => {
                            const card = residuals?.giftcards.find((c) => c.id === rmGiftcardId);
                            setRmGiftcardAmt(String(roundMoney(Math.min(card?.balance ?? 0, total))));
                          }}
                        >
                          Usa max
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Chiudi
              </button>
              <button
                type="button"
                className="btn btn-primary"
                id="posResidualsApplyBtn"
                onClick={() => {
                  setCreditUseInput(rmCreditAmt);
                  chooseGiftcard(rmGiftcardId);
                  setGiftcardUseInput(rmGiftcardId > 0 ? rmGiftcardAmt : "0");
                  closePosModal("posResidualsModal");
                }}
              >
                Applica
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: RATEIZZAZIONE */}
      <div className="modal fade" id="posInstallmentModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-0">Configura rateizzazione</h5>
                <div className="small text-muted">Definisci acconto, numero rate e scadenze del piano cliente.</div>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>
            <div className="modal-body">
              <div className="row g-3">
                <div className="col-12 col-lg-7">
                  <div className="row g-2">
                    <div className="col-12 col-md-6">
                      <label className="form-label small text-muted mb-1">Cliente</label>
                      <input type="text" className="form-control" id="posInstallmentClientLabel" value={clientName || "—"} readOnly />
                    </div>
                    <div className="col-12 col-md-6">
                      <label className="form-label small text-muted mb-1">Totale vendita</label>
                      <input type="text" className="form-control" id="posInstallmentSaleTotal" value={fmtEUR(total)} readOnly />
                    </div>
                    <div className="col-12 col-md-6">
                      <label className="form-label small text-muted mb-1">Tipo pagamento</label>
                      <input type="text" className="form-control" id="posInstallmentPaymentType" value={PAYMENT_METHOD_LABELS[baseMethod]} readOnly />
                    </div>
                    <div className="col-12 col-md-6">
                      <label className="form-label small text-muted mb-1">Acconto iniziale</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="form-control"
                        id="posInstallmentDownPayment"
                        value={installmentDownInput}
                        onChange={(e) => setInstallmentDownInput(e.target.value)}
                      />
                    </div>
                    <div className="col-12 col-md-4">
                      <label className="form-label small text-muted mb-1">Numero rate</label>
                      <input
                        type="number"
                        min="1"
                        max="120"
                        className="form-control"
                        id="posInstallmentCount"
                        value={installmentCountInput}
                        onChange={(e) => setInstallmentCountInput(e.target.value)}
                      />
                    </div>
                    <div className="col-12 col-md-4">
                      <label className="form-label small text-muted mb-1">Prima scadenza</label>
                      <input
                        type="date"
                        className="form-control"
                        id="posInstallmentFirstDue"
                        value={installmentFirstDueValue}
                        onChange={(e) => setInstallmentFirstDue(e.target.value)}
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label small text-muted mb-1">Ogni</label>
                      <input
                        type="number"
                        min="1"
                        max="24"
                        className="form-control"
                        id="posInstallmentIntervalValue"
                        value={installmentIntervalValueInput}
                        onChange={(e) => setInstallmentIntervalValueInput(e.target.value)}
                      />
                    </div>
                    <div className="col-6 col-md-2">
                      <label className="form-label small text-muted mb-1">Unità</label>
                      <select
                        className="form-select"
                        id="posInstallmentIntervalUnit"
                        value={installmentIntervalUnit}
                        onChange={(e) => setInstallmentIntervalUnit(e.target.value as "day" | "week" | "month")}
                      >
                        <option value="month">Mesi</option>
                        <option value="week">Settimane</option>
                        <option value="day">Giorni</option>
                      </select>
                    </div>
                    <div className="col-12">
                      <label className="form-label small text-muted mb-1">Note piano</label>
                      <textarea
                        className="form-control"
                        id="posInstallmentNotes"
                        rows={3}
                        placeholder="Es. acconto in cassa, accordi col cliente, note operative..."
                        value={installmentNote}
                        onChange={(e) => setInstallmentNote(e.target.value)}
                      ></textarea>
                    </div>
                  </div>
                  <div
                    className={`alert alert-danger small mt-3${installmentModalError ? "" : " d-none"}`}
                    id="posInstallmentModalError"
                  >
                    {installmentModalError}
                  </div>
                </div>
                <div className="col-12 col-lg-5">
                  <div className="pos-installment-preview-card">
                    <div className="fw-semibold mb-2">Anteprima piano</div>
                    <div className="d-flex justify-content-between small mb-1">
                      <span>Acconto oggi</span>
                      <strong id="posInstallmentPreviewDownPayment">{fmtEUR(installmentDownPayment)}</strong>
                    </div>
                    <div className="d-flex justify-content-between small mb-1">
                      <span>Residuo rateizzato</span>
                      <strong id="posInstallmentPreviewFinanced">{fmtEUR(installmentFinanced)}</strong>
                    </div>
                    <div className="d-flex justify-content-between small mb-3">
                      <span>Ultima scadenza</span>
                      <strong id="posInstallmentPreviewLastDue">{installmentLastDue || "—"}</strong>
                    </div>
                    <div className="table-responsive">
                      <table className="table table-sm mb-0 pos-installment-schedule-table">
                        <thead>
                          <tr>
                            <th>Rata</th>
                            <th>Scadenza</th>
                            <th className="text-end">Importo</th>
                          </tr>
                        </thead>
                        <tbody id="posInstallmentPreviewBody">
                          {installmentSchedule.map((row) => (
                            <tr key={row.no}>
                              <td>{row.no}</td>
                              <td>{row.dueDate}</td>
                              <td className="text-end">{fmtEUR(row.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                id="posInstallmentSaveBtn"
                disabled={!installmentCanSave}
                data-bs-dismiss={installmentCanSave ? "modal" : undefined}
                onClick={saveInstallmentPlan}
              >
                <i className="bi bi-check2-circle me-1"></i>Salva piano rate
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: RICARICA */}
      <div className="modal fade" id="posModalRecharge" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog">
          <div className="modal-content">
            <input type="hidden" id="posRechargeClientId" value={clientId ?? ""} readOnly />
            <div className="modal-header">
              <h5 className="modal-title">Ricarica credito</h5>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>

            <div className="modal-body">
              <div className="small text-muted mb-2">
                Cliente: <strong id="posRechargeClientLabel">{clientName || "—"}</strong>
              </div>

              <div className={`alert alert-warning py-2 px-3${clientId ? " d-none" : ""}`} id="posRechargeNoClientWarn">
                Nessun cliente selezionato. Puoi aggiungere la ricarica alla lista, ma per <strong>concludere</strong> la
                vendita dovrai selezionare un cliente.
              </div>

              <label className="form-label">Modello</label>
              <select
                className="form-select"
                id="posRechargeTemplateSelect"
                value={rechargeTemplateId || ""}
                onChange={(e) => chooseRechargeTemplate(Number.parseInt(e.target.value, 10) || 0)}
              >
                <option value="">Importo personalizzato…</option>
                {rechargeTemplates.map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.title} — {fmtEUR(t.baseAmount)}
                    {t.bonusAmount > 0 ? ` (+${fmtEUR(t.bonusAmount)} bonus)` : ""}
                  </option>
                ))}
              </select>
              <div className="form-text">
                Seleziona un modello <strong>(opzionale)</strong>: precompila importo e bonus (puoi modificare i valori).
              </div>

              <div className="row g-2 mt-2">
                <div className="col-6">
                  <label className="form-label">Importo ricarica (€)</label>
                  <input
                    className="form-control"
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="99999999.99"
                    id="posRechargeAmount"
                    value={rechargeAmount}
                    onChange={(e) => setRechargeAmount(e.target.value)}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label">Bonus</label>
                  <div className="input-group">
                    <select
                      className="form-select pos-recharge-bonus-kind"
                      id="posRechargeBonusKind"
                      value={rechargeBonusKindInput}
                      onChange={(e) => setRechargeBonusKindInput(e.target.value)}
                    >
                      <option value="none">Nessuno</option>
                      <option value="percent">% su importo</option>
                      <option value="fixed">€ fisso</option>
                    </select>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      min="0"
                      max="99999999.99"
                      id="posRechargeBonusValue"
                      value={rechargeBonusValueInput}
                      disabled={rechargeBonusKindInput === "none"}
                      onChange={(e) => setRechargeBonusValueInput(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="form-check mt-3" id="posRechargeEarnPointsWrap">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="posRechargeEarnPoints"
                  value="1"
                  checked={rechargeEarnPoints}
                  onChange={(e) => setRechargeEarnPoints(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="posRechargeEarnPoints">
                  Calcola i punti anche sul bonus (importo + bonus)
                </label>
                <div className="form-text">
                  Se attivo, i Punti saranno calcolati su <strong>importo + bonus</strong>. Se disattivo, verranno
                  calcolati <strong>solo sull&apos;importo ricarica</strong>.
                </div>
              </div>

              <label className="form-label mt-3">Note</label>
              <input
                className="form-control"
                type="text"
                id="posRechargeNote"
                placeholder="(opzionale)"
                value={rechargeNoteInput}
                onChange={(e) => setRechargeNoteInput(e.target.value)}
              />

              <div className="border rounded p-2 mt-3 bg-light">
                <div className="d-flex justify-content-between small">
                  <span>Ricarica</span>
                  <span id="posRechargePrevBase">{fmtEUR(rechargeBase)}</span>
                </div>
                <div className="d-flex justify-content-between small">
                  <span>Bonus</span>
                  <span id="posRechargePrevBonus">{fmtEUR(rechargeBonus)}</span>
                </div>
                <div className="d-flex justify-content-between fw-semibold">
                  <span>Totale credito caricato</span>
                  <span id="posRechargePrevTotal">{fmtEUR(rechargeTotal)}</span>
                </div>
                <div className="d-flex justify-content-between small text-muted">
                  <span>Calcolo punti su</span>
                  <span id="posRechargePrevPoints">
                    {rechargeEarnPoints ? `Importo + bonus (${fmtEUR(rechargeEarnBase)})` : `Solo importo (${fmtEUR(rechargeEarnBase)})`}
                  </span>
                </div>
              </div>

              <div className="small text-muted mt-2">
                Il cliente paga <strong>{fmtEUR(rechargeBase)}</strong> e riceve <strong>{fmtEUR(rechargeTotal)}</strong> di
                credito sul wallet. La ricarica verrà <strong>aggiunta al carrello</strong> e registrata quando premi{" "}
                <strong>Concludi</strong>.
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-primary" id="posRechargeAddBtn" onClick={addRechargeToCart}>
                Aggiungi alla lista
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: PACCHETTI */}
      <div className="modal fade" id="posModalPackages" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog">
          <div className="modal-content">
            <input type="hidden" id="posPackageClientId" value="" readOnly />

            <div className="modal-header">
              <h5 className="modal-title">Vendi pacchetto</h5>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>

            <div className="modal-body">
              <div className="small text-muted mb-2">
                Cliente: <strong id="posPackageClientLabel">{clientName || "—"}</strong>
              </div>

              <div className={`alert alert-warning py-2 px-3${clientId ? " d-none" : ""}`} id="posPackageNoClientWarn">
                Nessun cliente selezionato. Puoi aggiungere il pacchetto alla lista, ma per <strong>concludere</strong> la
                vendita dovrai selezionare un cliente.
              </div>

              <label className="form-label">Pacchetto</label>
              <select
                className="form-select"
                id="posPackageSelect"
                required
                value={packageId || ""}
                onChange={(e) => choosePackage(Number.parseInt(e.target.value, 10) || 0)}
              >
                <option value="">Seleziona...</option>
                {packages.map((p) => (
                  <option
                    value={p.id}
                    data-name={p.name}
                    data-price={p.price.toFixed(2)}
                    data-validity-days={p.validityDays}
                    key={p.id}
                  >
                    {p.name} — {fmtEUR(p.price)}
                    {p.sessions > 0 ? ` (${p.sessions} sedute)` : ""}
                  </option>
                ))}
              </select>

              <div className="row g-2 mt-3">
                <div className="col-md-6">
                  <label className="form-label">Valido dal</label>
                  <input
                    className="form-control"
                    type="date"
                    id="posPackageStartDate"
                    value={packageStart || today}
                    onChange={(e) => setPackageStart(e.target.value)}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Valido al</label>
                  <input
                    className="form-control"
                    type="date"
                    id="posPackageExpiresAt"
                    min={addDaysYMD(packageStart || today, 1)}
                    value={effectivePackageExpiry}
                    onChange={(e) => {
                      setPackageExpiresTouched(true);
                      setPackageExpires(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="small text-muted mt-2" id="posPackageExpiryHint">
                {selectedPackage
                  ? proposedPackageExpiry
                    ? `Scadenza proposta dal catalogo: ${proposedPackageExpiry}.`
                    : "Questo pacchetto non ha una scadenza automatica."
                  : ""}
              </div>

              <div className="alert alert-info py-2 px-3 d-none" id="posPackageGiftboxModeInfo">
                <strong>GiftBox attiva:</strong> questo pacchetto verrà inserito come contenuto della GiftBox (non sarà
                assegnato al cliente).
              </div>

              <label className="form-label mt-3">Note</label>
              <input
                className="form-control"
                type="text"
                id="posPackageNote"
                placeholder="(opzionale)"
                value={packageNote}
                onChange={(e) => setPackageNote(e.target.value)}
              />

              <div className="small text-muted mt-2">
                Nota: il pacchetto verrà aggiunto al carrello. Alla chiusura vendita (tasto <strong>Concludi</strong>)
                verrà:
                <ul className="mb-0">
                  <li>
                    <strong>in GiftBox</strong> se la GiftBox è attiva
                  </li>
                  <li>
                    <strong>assegnato al cliente</strong> se hai selezionato un cliente e la GiftBox non è attiva
                  </li>
                  <li className="text-muted">Per concludere la vendita il cliente deve essere selezionato.</li>
                </ul>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-primary" id="posPackageAddBtn" onClick={addPackageToCart}>
                Aggiungi alla lista
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: GIFTBOX (pos.php #posModalGiftbox) — la GiftBox avvolge i
          servizi Prepagato + prodotti Ordinato già nel carrello ("Contenuto
          GiftBox"); "Salva" memorizza il DRAFT (nessuna riga carrello) e al
          Concludi il backend emette l'istanza con UNA riga vendita
          "GiftBox • {code}" pari al totale del contenuto. */}
      <div className="modal fade" id="posModalGiftbox" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog">
          <div className="modal-content">
            <input type="hidden" id="posGiftboxClientId" value="" readOnly />
            <input type="hidden" id="posGiftboxItems" value="" readOnly />

            <div className="modal-header">
              <h5 className="modal-title">Emetti GiftBox</h5>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>

            <div className="modal-body">
              <div className="small text-muted mb-2">
                Mittente: <strong id="posGiftboxClientLabel">{clientId ? clientName : "—"}</strong>
              </div>

              <div className="border rounded p-2">
                <div className="fw-semibold mb-1">Contenuto GiftBox</div>
                <div className="small text-muted mb-2">
                  Verranno inseriti i servizi/prodotti selezionati nel carrello e gli eventuali pacchetti aggiunti in abbinamento alla GiftBox.
                </div>
                <div className="small text-muted">
                  Per inserire un servizio nella GiftBox impostalo come <strong>Prepagato</strong>; per un prodotto impostalo come <strong>Ordinato</strong>.
                </div>
                <div className="mt-2 pos-scroll-180" id="posGiftboxCartSummary">
                  {giftboxEligibleLines.length === 0 ? (
                    <div className="text-muted small">Nessun elemento eleggibile nel carrello.</div>
                  ) : (
                    <table className="table table-sm mb-0">
                      <thead>
                        <tr>
                          <th>Tipo</th>
                          <th>Elemento</th>
                          <th className="text-end">Q.tà</th>
                        </tr>
                      </thead>
                      <tbody>
                        {giftboxEligibleLines.map((l) => (
                          <tr key={l.key}>
                            <td className="text-uppercase small">{l.type === "product" ? "PRODOTTO" : "SERVIZIO"}</td>
                            <td className="small">{l.name}</td>
                            <td className="text-end small">{l.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {giftboxBlockingMessage ? <div className="alert alert-warning py-2 px-3 mt-2 small">{giftboxBlockingMessage}</div> : null}
              {gbError ? <div className="alert alert-danger py-2 px-3 mt-2 small">{gbError}</div> : null}

              <div className="row g-2 mt-3">
                <div className="col-12">
                  <label className="form-label">Evento</label>
                  <select className="form-select" id="posGiftboxEventType" required value={gbEventType} onChange={(e) => setGbEventType(e.target.value)}>
                    <option value="giftbox">GiftBox (generica)</option>
                    <option value="compleanno">Compleanno</option>
                    <option value="anniversario">Anniversario</option>
                    <option value="san_valentino">San Valentino</option>
                    <option value="natale">Natale</option>
                    <option value="capodanno">Capodanno</option>
                    <option value="epifania">Epifania</option>
                    <option value="festa_donna">Festa della Donna</option>
                    <option value="pasqua">Pasqua</option>
                    <option value="pasquetta">Pasquetta</option>
                    <option value="festa_mamma">Festa della Mamma</option>
                    <option value="festa_papa">Festa del Papà</option>
                  </select>
                </div>
              </div>

              <div className="row g-2 mt-3">
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Valida dal</label>
                  <input className="form-control" type="date" id="posGiftboxValidFrom" min={today} required value={gbValidFrom || today} onChange={(e) => setGbValidFrom(e.target.value)} />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Valida al</label>
                  <input className="form-control" type="date" id="posGiftboxValidTo" value={gbValidTo} onChange={(e) => setGbValidTo(e.target.value)} />
                </div>
              </div>

              <div className="row g-2 mt-3">
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Destinatario</label>
                  <input
                    className="form-control"
                    type="text"
                    id="posGiftboxRecipientName"
                    placeholder="Nome"
                    required
                    value={gbRecipientName}
                    readOnly={gbRecipientIsClient && gbRecipientClientId > 0}
                    onChange={(e) => setGbRecipientName(e.target.value)}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Email destinatario</label>
                  <input
                    className="form-control"
                    type="email"
                    id="posGiftboxRecipientEmail"
                    placeholder="Email (opzionale)"
                    value={gbRecipientEmail}
                    readOnly={gbRecipientIsClient && gbRecipientClientId > 0}
                    onChange={(e) => setGbRecipientEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="row g-2 mt-2">
                <div className="col-12">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="posGbRecipientExistingToggle"
                      checked={gbRecipientIsClient}
                      onChange={(e) => {
                        setGbRecipientIsClient(e.target.checked);
                        if (!e.target.checked) setGbRecipientClientId(0);
                      }}
                    />
                    <label className="form-check-label" htmlFor="posGbRecipientExistingToggle">Destinatario già cliente</label>
                  </div>
                </div>
              </div>

              {gbRecipientIsClient ? (
                <div className="mt-2" id="posGbRecipientExistingBox">
                  {gbRecipientClientId > 0 ? (
                    <div className="border rounded p-3 mb-2" id="posGbRecipientSelectedBox">
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <div className="fw-semibold" id="posGbRecipientSelectedName">{clients.find((c) => c.id === gbRecipientClientId)?.name ?? `Cliente #${gbRecipientClientId}`}</div>
                          <div className="text-muted small" id="posGbRecipientSelectedMeta">ID {gbRecipientClientId}</div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          id="posGbRecipientRemoveBtn"
                          title="Rimuovi destinatario"
                          onClick={() => setGbRecipientClientId(0)}
                        >
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div id="posGbRecipientSearchWrap">
                      <div className="input-group input-group-sm mb-2">
                        <span className="input-group-text"><i className="bi bi-search" /></span>
                        <input
                          className="form-control"
                          type="text"
                          id="posGbRecipientClientSearch"
                          placeholder="Cerca destinatario..."
                          value={gbRecipientSearch}
                          onChange={(e) => setGbRecipientSearch(e.target.value)}
                        />
                      </div>
                      <div className="border rounded pos-scroll-160" id="posGbRecipientClientList">
                        {clients
                          .filter((c) => gbRecipientSearch.trim() === "" || c.name.toLowerCase().includes(gbRecipientSearch.trim().toLowerCase()))
                          .slice(0, 20)
                          .map((c) => (
                            <button
                              type="button"
                              className="pos-client-row pos-client-row-compact"
                              key={c.id}
                              onClick={() => {
                                setGbRecipientClientId(c.id);
                                setGbRecipientName(c.name);
                                setGbRecipientSearch("");
                              }}
                            >
                              <div className="d-flex justify-content-between align-items-start">
                                <div>
                                  <div className="fw-semibold">{c.name}</div>
                                </div>
                                <div className="small text-muted">ID {c.id}</div>
                              </div>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="row g-2 mt-2">
                <div className="col-12">
                  <label className="form-label">Voucher (destinatario)</label>
                  <div className="form-check mt-1">
                    <input className="form-check-input" type="checkbox" id="posGiftboxVoucherHideAmount" checked={gbHideAmount} onChange={(e) => setGbHideAmount(e.target.checked)} />
                    <label className="form-check-label" htmlFor="posGiftboxVoucherHideAmount">Nascondi importo nel voucher pubblico (QR)</label>
                  </div>
                  <div className="form-text">Se attivo, nel voucher pubblico aperto dal QR/link non verrà mostrato l&apos;importo (prezzi listino).</div>
                </div>
              </div>

              <label className="form-label mt-3">Messaggio di dedica</label>
              <textarea className="form-control" id="posGiftboxMessage" rows={3} placeholder="(opzionale)" value={gbMessage} onChange={(e) => setGbMessage(e.target.value)} />

              <label className="form-label mt-3">Nota per il cliente</label>
              <textarea className="form-control" id="posGiftboxNote" rows={2} placeholder="(opzionale)" value={gbNote} onChange={(e) => setGbNote(e.target.value)} />

              <label className="form-label mt-3">Nota interna</label>
              <textarea className="form-control" id="posGiftboxInternalNote" rows={2} placeholder="(opzionale)" value={gbInternalNote} onChange={(e) => setGbInternalNote(e.target.value)} />

              <div className="mt-3">
                <div className="fw-semibold mb-1">Invio email</div>

                <div className="form-check mb-2">
                  <input className="form-check-input" type="checkbox" id="posGbDoNotSend" checked={gbDoNotSend} onChange={(e) => setGbDoNotSend(e.target.checked)} />
                  <label className="form-check-label" htmlFor="posGbDoNotSend">Non inviare</label>
                </div>

                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="giftbox_send_mode_ui"
                    id="posGbSendNow"
                    checked={gbSendMode === "now"}
                    disabled={gbDoNotSend}
                    onChange={() => setGbSendMode("now")}
                  />
                  <label className="form-check-label" htmlFor="posGbSendNow">Invia subito alla conclusione della vendita</label>
                </div>

                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="giftbox_send_mode_ui"
                    id="posGbSendDate"
                    checked={gbSendMode === "date"}
                    disabled={gbDoNotSend}
                    onChange={() => setGbSendMode("date")}
                  />
                  <label className="form-check-label" htmlFor="posGbSendDate">Invia in data programmata</label>
                </div>

                {!gbDoNotSend && gbSendMode === "date" ? (
                  <div className="mt-2" id="posGbSendOnBox">
                    <label className="form-label">Data invio</label>
                    <input className="form-control" type="date" id="posGbSendOn" min={today} value={gbSendOn} onChange={(e) => setGbSendOn(e.target.value)} />
                  </div>
                ) : null}

                <div className="form-check mt-3">
                  <input className="form-check-input" type="checkbox" id="posGbShowDetails" checked={gbShowDetails} onChange={(e) => setGbShowDetails(e.target.checked)} />
                  <label className="form-check-label" htmlFor="posGbShowDetails">Mostra importo e contenuto nella mail</label>
                </div>
                <div className="text-muted small">Se disattivato, nella mail non verrà mostrato il contenuto: il destinatario dovrà recarsi in negozio per scoprirlo.</div>
              </div>

              {gbDraft ? (
                <div className="alert alert-info py-2 px-3 mt-3" id="posGiftboxTotalsHint">
                  GiftBox attiva per <strong>{gbDraft.recipientName}</strong> • Totale contenuto {fmtEUR(giftboxContentTotal)} — verrà emessa al Concludi.
                </div>
              ) : null}
            </div>

            <div className="modal-footer">
              {gbDraft ? (
                <a
                  href="#"
                  className="link-danger me-auto"
                  id="posGiftboxDeleteLink"
                  onClick={(e) => {
                    e.preventDefault();
                    deleteGiftboxDraft();
                  }}
                >
                  Elimina
                </a>
              ) : null}
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal" id="posGiftboxCancelBtn">Annulla</button>
              <button type="button" className="btn btn-primary" id="posGiftboxSaveBtn" onClick={saveGiftboxDraft}>
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL: GIFTCARD (pos.php #posModalGiftcard) — la GiftCard viene
          aggiunta al carrello e verrà emessa alla chiusura vendita. Campi
          legacy: Importo, Evento, Valida dal/al, Destinatario (+ già cliente
          con ricerca), Nascondi importo, Dedica, Nota per il cliente, Nota
          interna, Invio email (Non inviare / subito / programmata + Mostra
          importo e contenuto). */}
      <div className="modal fade" id="posModalGiftcard" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog">
          <div className="modal-content">
            <input type="hidden" id="posGiftcardClientId" value="" readOnly />

            <div className="modal-header">
              <h5 className="modal-title">Emetti GiftCard</h5>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi"></button>
            </div>

            <div className="modal-body">
              <div className="small text-muted mb-2">
                Mittente: <strong id="posGiftcardClientLabel">{clientId ? clientName : "—"}</strong>
              </div>

              <div className="row g-2">
                <div className="col-12">
                  <label className="form-label">Importo (€)</label>
                  <input
                    className="form-control"
                    type="number"
                    step="0.01"
                    min="0"
                    id="posGcAmount"
                    placeholder="Es. 20"
                    required
                    value={gcAmount}
                    onChange={(e) => setGcAmount(e.target.value)}
                  />
                </div>
              </div>

              <div className="row g-2 mt-3">
                <div className="col-12">
                  <label className="form-label">Evento</label>
                  <select className="form-select" id="posGcEventType" required value={gcEventType} onChange={(e) => setGcEventType(e.target.value)}>
                    <option value="giftcard">GiftCard (generica)</option>
                    <option value="compleanno">Compleanno</option>
                    <option value="anniversario">Anniversario</option>
                    <option value="capodanno">Capodanno</option>
                    <option value="natale">Natale</option>
                    <option value="epifania">Epifania</option>
                    <option value="san_valentino">San Valentino</option>
                    <option value="festa_donna">Festa della Donna</option>
                    <option value="pasqua">Pasqua</option>
                    <option value="pasquetta">Pasquetta</option>
                    <option value="festa_mamma">Festa della Mamma</option>
                    <option value="festa_papa">Festa del Papà</option>
                  </select>
                </div>
              </div>

              <div className="row g-2 mt-3">
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Valida dal</label>
                  <input className="form-control" type="date" id="posGcValidFrom" min={today} required value={gcValidFrom || today} onChange={(e) => setGcValidFrom(e.target.value)} />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Valida al</label>
                  <input className="form-control" type="date" id="posGcExpiresAt" value={gcExpiresAt} onChange={(e) => setGcExpiresAt(e.target.value)} />
                </div>
              </div>

              <div className="row g-2 mt-3">
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Destinatario</label>
                  <input
                    className="form-control"
                    type="text"
                    id="posGcRecipientName"
                    placeholder="Nome"
                    required
                    value={gcRecipientName}
                    readOnly={gcRecipientIsClient && gcRecipientClientId > 0}
                    onChange={(e) => setGcRecipientName(e.target.value)}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted mb-1">Email destinatario</label>
                  <input
                    className="form-control"
                    type="email"
                    id="posGcRecipientEmail"
                    placeholder="Email (opzionale)"
                    value={gcRecipientEmail}
                    readOnly={gcRecipientIsClient && gcRecipientClientId > 0}
                    onChange={(e) => setGcRecipientEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="row g-2 mt-2">
                <div className="col-12">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="posGcRecipientExistingToggle"
                      checked={gcRecipientIsClient}
                      onChange={(e) => {
                        setGcRecipientIsClient(e.target.checked);
                        if (!e.target.checked) setGcRecipientClientId(0);
                      }}
                    />
                    <label className="form-check-label" htmlFor="posGcRecipientExistingToggle">Destinatario già cliente</label>
                  </div>
                </div>
              </div>

              {gcRecipientIsClient ? (
                <div className="mt-2" id="posGcRecipientExistingBox">
                  {gcRecipientClientId > 0 ? (
                    <div className="border rounded p-3 mb-2" id="posGcRecipientSelectedBox">
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <div className="fw-semibold" id="posGcRecipientSelectedName">{clients.find((c) => c.id === gcRecipientClientId)?.name ?? `Cliente #${gcRecipientClientId}`}</div>
                          <div className="text-muted small" id="posGcRecipientSelectedMeta">ID {gcRecipientClientId}</div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          id="posGcRecipientRemoveBtn"
                          title="Rimuovi destinatario"
                          onClick={() => setGcRecipientClientId(0)}
                        >
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div id="posGcRecipientSearchWrap">
                      <div className="input-group input-group-sm mb-2">
                        <span className="input-group-text"><i className="bi bi-search" /></span>
                        <input
                          className="form-control"
                          type="text"
                          id="posGcRecipientClientSearch"
                          placeholder="Cerca destinatario..."
                          value={gcRecipientSearch}
                          onChange={(e) => setGcRecipientSearch(e.target.value)}
                        />
                      </div>
                      <div className="border rounded pos-scroll-160" id="posGcRecipientClientList">
                        {clients
                          .filter((c) => gcRecipientSearch.trim() === "" || c.name.toLowerCase().includes(gcRecipientSearch.trim().toLowerCase()))
                          .slice(0, 20)
                          .map((c) => (
                            <button
                              type="button"
                              className="pos-client-row pos-client-row-compact"
                              key={c.id}
                              onClick={() => {
                                setGcRecipientClientId(c.id);
                                setGcRecipientName(c.name);
                                setGcRecipientSearch("");
                              }}
                            >
                              <div className="d-flex justify-content-between align-items-start">
                                <div>
                                  <div className="fw-semibold">{c.name}</div>
                                </div>
                                <div className="small text-muted">ID {c.id}</div>
                              </div>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="row g-2 mt-2">
                <div className="col-12">
                  <label className="form-label">Voucher (destinatario)</label>
                  <div className="form-check mt-1">
                    <input className="form-check-input" type="checkbox" id="posGcVoucherHideAmount" checked={gcHideAmount} onChange={(e) => setGcHideAmount(e.target.checked)} />
                    <label className="form-check-label" htmlFor="posGcVoucherHideAmount">Nascondi importo nel voucher pubblico (QR)</label>
                  </div>
                  <div className="form-text">Se attivo, nel voucher pubblico aperto dal QR/link non verrà mostrato importo e saldo.</div>
                </div>
              </div>

              <label className="form-label mt-3">Messaggio di dedica</label>
              <textarea className="form-control" id="posGcMessage" rows={3} placeholder="(opzionale)" value={gcMessage} onChange={(e) => setGcMessage(e.target.value)} />

              <label className="form-label mt-3">Nota per il cliente</label>
              <textarea className="form-control" id="posGcNote" rows={2} placeholder="(opzionale)" value={gcNote} onChange={(e) => setGcNote(e.target.value)} />

              <label className="form-label mt-3">Nota interna</label>
              <textarea className="form-control" id="posGcInternalNote" rows={2} placeholder="(opzionale)" value={gcInternalNote} onChange={(e) => setGcInternalNote(e.target.value)} />

              <div className="mt-3">
                <div className="fw-semibold mb-1">Invio email</div>

                <div className="form-check mb-2">
                  <input className="form-check-input" type="checkbox" id="posGcDoNotSend" checked={gcDoNotSend} onChange={(e) => setGcDoNotSend(e.target.checked)} />
                  <label className="form-check-label" htmlFor="posGcDoNotSend">Non inviare</label>
                </div>

                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="giftcard_send_mode"
                    id="posGcSendNow"
                    checked={gcSendMode === "now"}
                    disabled={gcDoNotSend}
                    onChange={() => setGcSendMode("now")}
                  />
                  <label className="form-check-label" htmlFor="posGcSendNow">
                    Invia subito alla conclusione della vendita
                  </label>
                </div>

                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="giftcard_send_mode"
                    id="posGcSendDate"
                    checked={gcSendMode === "date"}
                    disabled={gcDoNotSend}
                    onChange={() => setGcSendMode("date")}
                  />
                  <label className="form-check-label" htmlFor="posGcSendDate">
                    Invia in data programmata
                  </label>
                </div>

                {!gcDoNotSend && gcSendMode === "date" ? (
                  <div className="mt-2" id="posGcSendOnBox">
                    <label className="form-label">Data invio</label>
                    <input className="form-control" type="date" id="posGcSendOn" value={gcSendOn} onChange={(e) => setGcSendOn(e.target.value)} />
                  </div>
                ) : null}

                <div className="form-check mt-3">
                  <input className="form-check-input" type="checkbox" id="posGcShowAmount" checked={gcShowAmount} onChange={(e) => setGcShowAmount(e.target.checked)} />
                  <label className="form-check-label" htmlFor="posGcShowAmount">Mostra importo e contenuto nella mail</label>
                </div>
                <div className="text-muted small">Se disattivato, nella mail non verrà mostrato l&apos;importo (né i dettagli): il destinatario dovrà recarsi in negozio per scoprirli.</div>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">Annulla</button>
              <button type="button" className="btn btn-primary" id="posGiftcardCreateBtn" onClick={addGiftcardToCart}>Aggiungi alla lista</button>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== RICEVUTA / SCONTRINO (pos_success) ===================== */}
      {/* Printable RECEIPT shown after a successful checkout — faithful port of the legacy
          pos_success.php view (business header, sale code + date, client, item lines incl. the
          GiftCard/GiftBox/Pacchetto/Ricarica labels, subtotal, discount/coupon/punti reductions,
          residui credito/giftcard applied, TOTAL, payment method(s)). A "Stampa scontrino"
          button calls window.print() (pos_success.js); "Nuova vendita" dismisses it. The scoped
          @media print rule below isolates the receipt (hides the app chrome) so ONLY the
          scontrino prints — faithful to how the legacy print view isolates the receipt. */}
      {lastSale ? (
        <div className="pos-receipt-overlay" id="posReceiptModal" role="dialog" aria-modal="true" aria-label="Ricevuta vendita">
          <style>{`
            .pos-success-qty-col { width: 90px; }
            .pos-success-money-col { width: 140px; }
            .pos-receipt-overlay {
              position: fixed; inset: 0; z-index: 1080; display: flex;
              align-items: flex-start; justify-content: center; overflow: auto;
              padding: 1.5rem; background: rgba(15, 23, 42, .55);
            }
            .pos-receipt { width: 100%; max-width: 460px; margin: auto; background: #fff; border-radius: .5rem; }
            .pos-receipt-logo { display: inline-block; }
            @media print {
              body * { visibility: hidden !important; }
              .pos-receipt-overlay, .pos-receipt-overlay * { visibility: visible !important; }
              .pos-receipt-overlay {
                position: absolute !important; inset: 0 !important;
                background: #fff !important; padding: 0 !important; overflow: visible !important;
              }
              .pos-receipt { box-shadow: none !important; border: 0 !important; max-width: none !important; margin: 0 !important; }
              .pos-receipt-actions { display: none !important; }
            }
          `}</style>
          <div className="pos-receipt card p-4" id="posReceipt">
            {/* BUSINESS header: name + P.IVA + address + logo (from getPosBusinessHeader). */}
            <div className="pos-receipt-business text-center mb-3">
              {lastSale.business.logoPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={lastSale.business.logoPath} alt="" className="pos-receipt-logo mb-2" style={{ maxHeight: 64, maxWidth: 180, objectFit: "contain" }} />
              ) : null}
              <div className="h5 mb-0 fw-bold">{lastSale.business.name || "—"}</div>
              {lastSale.business.legalVatNumber ? (
                <div className="small text-muted">P.IVA {lastSale.business.legalVatNumber}</div>
              ) : null}
              {lastSale.business.address ? (
                <div className="small text-muted">{lastSale.business.address}</div>
              ) : null}
            </div>

            <hr />

            {/* Sale code + date + client. */}
            <div className="d-flex justify-content-between align-items-start mb-2">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-check-circle-fill text-success me-1"></i>Vendita completata
                </div>
                <div className="text-muted small">
                  {lastSale.sale.code ? lastSale.sale.code : `#${lastSale.sale.id ?? ""}`}
                  {formatReceiptDateTime(lastSale.sale.createdAt) ? ` • ${formatReceiptDateTime(lastSale.sale.createdAt)}` : ""}
                </div>
              </div>
              <div className="text-end small">
                <div className="text-muted">Cliente</div>
                <div className="fw-semibold">
                  {lastSale.sale.clientName && lastSale.sale.clientName.trim() && lastSale.sale.clientName.trim() !== "Cliente banco"
                    ? lastSale.sale.clientName
                    : "Cliente occasionale"}
                </div>
              </div>
            </div>

            {/* Item lines: name (+ status), qty, unit price, line total. */}
            <div className="table-responsive mt-2">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>Elemento</th>
                    <th className="text-end pos-success-qty-col">Q.tà</th>
                    <th className="text-end pos-success-money-col">Prezzo</th>
                    <th className="text-end pos-success-money-col">Totale</th>
                  </tr>
                </thead>
                <tbody>
                  {(lastSale.sale.items ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-muted">Nessun dettaglio righe disponibile.</td>
                    </tr>
                  ) : (
                    (lastSale.sale.items ?? []).map((item, idx) => (
                      <tr key={item.id ?? idx}>
                        <td>
                          <div className="fw-semibold">{item.name || "Elemento"}</div>
                          <div className="text-muted small">{item.type ?? ""}</div>
                        </td>
                        <td className="text-end">{item.quantity ?? 1}</td>
                        <td className="text-end">{fmtEUR(Number(item.unitPrice ?? 0))}</td>
                        <td className="text-end fw-semibold">{fmtEUR(Number(item.total ?? 0))}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <hr />

            {/* Totals: subtotal, manual discount, coupon, fidelity-points discount, residui
                (giftcard/credito) applied, then the TOTAL. */}
            <div className="d-flex justify-content-between">
              <span className="text-muted">Subtotale</span>
              <span>{fmtEUR(Number(lastSale.sale.subtotal ?? 0))}</span>
            </div>
            {lastSale.manualDiscount > 0.00001 ? (
              <div className="d-flex justify-content-between text-muted small mt-1">
                <span>Sconto manuale</span>
                <span className="text-danger">- {fmtEUR(lastSale.manualDiscount)}</span>
              </div>
            ) : null}
            {lastSale.couponDiscount > 0.00001 ? (
              <div className="d-flex justify-content-between text-muted small mt-1">
                <span>Coupon{lastSale.couponCode ? ` (${lastSale.couponCode})` : ""}</span>
                <span className="text-danger">- {fmtEUR(lastSale.couponDiscount)}</span>
              </div>
            ) : null}
            {lastSale.fidelityDiscount > 0.00001 ? (
              <div className="d-flex justify-content-between text-muted small mt-1">
                <span>Punti Fidelity{lastSale.pointsUsed > 0 ? ` (${lastSale.pointsUsed} pt)` : ""}</span>
                <span className="text-danger">- {fmtEUR(lastSale.fidelityDiscount)}</span>
              </div>
            ) : null}
            {lastSale.giftcardUse > 0.00001 ? (
              <div className="d-flex justify-content-between text-muted small mt-1">
                <span>GiftCard utilizzata{lastSale.giftcardCode ? ` (${lastSale.giftcardCode})` : ""}</span>
                <span className="text-danger">- {fmtEUR(lastSale.giftcardUse)}</span>
              </div>
            ) : null}
            {lastSale.creditUse > 0.00001 ? (
              <div className="d-flex justify-content-between text-muted small mt-1">
                <span>Credito utilizzato</span>
                <span className="text-danger">- {fmtEUR(lastSale.creditUse)}</span>
              </div>
            ) : null}

            <hr />

            <div className="d-flex justify-content-between">
              <span className="fw-semibold">Totale</span>
              <span className="fw-semibold">{fmtEUR(Number(lastSale.sale.total ?? 0))}</span>
            </div>

            {/* Fidelity (pos_success.php card "Totali" blocco "Fidelity"):
                Punti usati / Punti guadagnati sulla vendita. */}
            {lastSale.pointsUsed > 0 || lastSale.pointsEarned > 0 ? (
              <>
                <hr />
                <div className="mt-1">
                  <div className="fw-semibold mb-1">Fidelity</div>
                  {lastSale.pointsUsed > 0 ? (
                    <div className="d-flex justify-content-between small">
                      <span className="text-muted">Punti usati</span>
                      <span>{lastSale.pointsUsed}</span>
                    </div>
                  ) : null}
                  {lastSale.pointsEarned > 0 ? (
                    <div className="d-flex justify-content-between small">
                      <span className="text-muted">Punti guadagnati</span>
                      <span>{lastSale.pointsEarned}</span>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {/* Buoni emessi: the GiftCard/GiftBox codes this sale ISSUED (from the checkout
                response), so staff can hand the code to the customer. Port of pos_success.php's
                "GiftCard/GiftBox emessa (CODE)" — each row shows the type label, the generated
                code (the load-bearing value), the recipient, and the amount. */}
            {lastSale.issuedVouchers.length > 0 ? (
              <>
                <hr />
                <div className="mt-1">
                  <div className="fw-semibold mb-1">Buoni emessi</div>
                  <ul className="list-unstyled mb-0 small">
                    {lastSale.issuedVouchers.map((voucher, idx) => (
                      <li className="d-flex justify-content-between gap-3 mt-1" key={`${voucher.code ?? ""}-${idx}`}>
                        <span>
                          {issuedVoucherTypeLabel(voucher.type)}{" "}
                          <span className="fw-semibold font-monospace">{voucher.code}</span>
                          {voucher.recipientName && voucher.recipientName.trim() ? (
                            <span className="text-muted"> — {voucher.recipientName}</span>
                          ) : null}
                        </span>
                        {Number(voucher.amount ?? 0) > 0.00001 ? (
                          <span className="text-nowrap">{fmtEUR(Number(voucher.amount ?? 0))}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {/* Payment method(s) + amounts. Falls back to the captured base method when the
                server response carries no payments array. */}
            <div className="mt-3">
              <div className="fw-semibold mb-1">Pagamento</div>
              {((lastSale.sale.payments ?? []).filter((p) => Number(p.amount ?? 0) > 0)).length > 0 ? (
                (lastSale.sale.payments ?? [])
                  .filter((p) => Number(p.amount ?? 0) > 0)
                  .map((p, idx) => (
                    <div className="d-flex justify-content-between small" key={idx}>
                      <span className="text-muted">{salePaymentMethodLabel(p.method)}</span>
                      <span>{fmtEUR(Number(p.amount ?? 0))}</span>
                    </div>
                  ))
              ) : (
                <div className="d-flex justify-content-between small">
                  <span className="text-muted">{lastSale.baseMethodLabel}</span>
                  <span>{fmtEUR(Number(lastSale.sale.total ?? 0))}</span>
                </div>
              )}
            </div>

            {/* Actions (not printed). */}
            <div className="pos-receipt-actions d-flex gap-2 justify-content-end mt-4">
              <button type="button" className="btn btn-outline-secondary" onClick={closeReceipt}>
                <i className="bi bi-plus-lg me-1"></i>Nuova vendita
              </button>
              <button type="button" className="btn btn-primary" data-pos-success-print onClick={printReceipt}>
                <i className="bi bi-printer me-1"></i>Stampa scontrino
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
