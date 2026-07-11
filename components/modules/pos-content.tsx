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
// un servizio si vende come prepagato dal toggle di riga "Eseguito / Prepagato" nel carrello
// (come il legacy) -> {type:"prepaid"}. Both flow through checkout's items_json. At checkout the
// backend issues a client_packages row (sessions read from the package template,
// start/expiry/note from the line) and a client_prepaid_services row (purchased_qty =
// line qty) — issuance is gated on a real client (a bench sale cannot issue).
//
// WIRED (advanced line types): anche Ricariche, GiftBox (draft dal carrello), GiftCard
// (riga carrello con emissione al Concludi) e la rateizzazione (scelta obbligatoria +
// piano snapshot) sono completamente cablati — vedi le rispettive sezioni sotto.

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
  // Riscatto punti abilitato (testo dinamico posRedeemInfo legacy).
  fidelityRedeemEnabled?: boolean;
  // Blocco info Fidelity sotto Concludi (pos.php 6399-6411).
  fidelityEarnInfo?: { euroPerPoint: number; earnStep: number; campaignActiveToday: boolean };
};

// Info promo per un tile del catalogo (mode=catalog_promos legacy): prezzo promo
// unitario + percentuale per badge "-N%" e prezzo barrato. Display-only.
type TilePromoInfo = {
  promo_id: number;
  promo_name: string;
  unit_price: number;
  promo_unit_price: number;
  unit_discount: number;
  percent: number;
};

// The client's spendable residui (wallet CREDIT + GiftCards) + the FIDELITY points balance
// and redeem settings, fetched from GET /api/manage/pos?action=client_residuals&client_id=
// when a client is selected.
type ClientResiduals = {
  clientId: number;
  credit: number;
  giftcards: Array<{ id: number; code: string; balance: number; expiresAt: string }>;
  // Punti DISPONIBILI (saldo - prenotati, come Fidelity::availablePoints legacy) + il
  // dettaglio saldo/prenotati per l'help concatenato del box punti (pos.js sync()).
  points: number;
  pointsBalance: number;
  pointsReserved: number;
  // Adesione Fidelity (tessera attiva non scaduta) — badge "Fidelity: SI/NO".
  fidelityAdhering: boolean;
  fidelity: { enabled: boolean; euroPerPoint: number; minPoints: number };
};

// SNAPSHOT del piano rate salvato dal modale (legacy installment_plan_json + il contesto
// cliente/totale/tipo pagamento usato dai controlli di coerenza di syncInstallmentPlanForContext
// e getInstallmentConcludeBlockReason). total è il totale NETTO (dopo residui) come il legacy.
type InstallmentPlanSnap = {
  clientId: number;
  total: number;
  paymentType: PaymentMethod;
  downPayment: number;
  financed: number;
  count: number;
  intervalUnit: "day" | "week" | "month";
  intervalValue: number;
  firstDue: string;
  note: string;
  schedule: Array<{ no: number; dueDate: string; amount: number }>;
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
  // Mittente al momento dell'aggiunta (legacy items[gc_client_id]): se il cliente
  // selezionato cambia, Concludi si blocca ("La GiftCard è collegata a un mittente
  // diverso. Rimuovila e ricreala per il mittente selezionato.").
  senderClientId?: number;
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

// YYYY-MM-DD -> dd/mm/yyyy ("—" when invalid), port of pos.js fmtIsoDate (piano rate).
function fmtDMY(value: string): string {
  const v = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "—";
  return `${v.substring(8, 10)}/${v.substring(5, 7)}/${v.substring(0, 4)}`;
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

  // Promotion (Block 3b): la promozione automatica migliore per il carrello corrente,
  // rilevata SILENZIOSAMENTE (legacy preview_auto_promo dentro fetchPreview — nessun
  // bottone "Rileva"): l'effetto debounced sotto la ricalcola a ogni cambio carrello/
  // cliente quando nessun coupon è applicato. promotion_id is sent on checkout (the
  // backend re-evaluates and refuses if no longer applicable).
  const [promotionId, setPromotionId] = useState(0);
  const [promotionName, setPromotionName] = useState("");
  const [promotionDiscountRaw, setPromotionDiscountRaw] = useState(0);
  // Cumulabilità della promo con la Fidelity + subtotale non scontato (pos.js
  // window.posPricing.promo_allows_fidelity / promo_non_discounted_subtotal): quando
  // la promo NON è cumulabile, i punti mordono solo sulla parte non-promo del carrello.
  const [promotionAllowsFidelity, setPromotionAllowsFidelity] = useState(true);
  const [promotionNonDiscounted, setPromotionNonDiscounted] = useState(0);
  const promotionReqRef = useRef(0);

  // Mappa promo dei tile catalogo (mode=catalog_promos legacy): badge "Promo"/"-N%" +
  // prezzo barrato sui tile; il click aggiunge comunque a prezzo pieno (lo sconto arriva
  // dall'auto-promo sul carrello).
  const [tilePromos, setTilePromos] = useState<{ service: Record<string, TilePromoInfo>; product: Record<string, TilePromoInfo> }>({ service: {}, product: {} });
  const tilePromoKeyRef = useRef("");
  const tilePromoReqRef = useRef(0);

  // Payment: ONE base method for the remainder after residui (faithful single
  // payment_type radio). Defaults to Contanti.
  const [baseMethod, setBaseMethod] = useState<PaymentMethod>("cash");
  const [notes, setNotes] = useState("");

  // RATEIZZAZIONE (installment plan) — modello legacy pos.js:
  // • installmentChoice parte VUOTA ('') e la scelta esplicita (Pagamento unico /
  //   Rateizzato) è OBBLIGATORIA quando il totale è > 0 (badge "Scelta obbligatoria",
  //   Concludi bloccato finché non si sceglie — readInstallmentChoice/renderInstallmentCard).
  // • installmentPlan è lo SNAPSHOT del piano salvato dal modale ("Salva piano rate"),
  //   con il contesto (cliente/totale/tipo pagamento) per il controllo di coerenza:
  //   se cliente, totale (>0.02) o tipo pagamento cambiano il piano viene rimosso
  //   (syncInstallmentPlanForContext legacy) con il notice verbatim.
  // • installmentNotice = installmentContextNotice legacy: quando settato sovrascrive
  //   l'help della card. Gli input sono la BOZZA del modale (seedata all'apertura).
  const [installmentChoice, setInstallmentChoice] = useState<"" | "single" | "installment">("");
  const [installmentPlan, setInstallmentPlan] = useState<InstallmentPlanSnap | null>(null);
  const [installmentNotice, setInstallmentNotice] = useState("");
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
    // Mittente al momento del salvataggio (legacy pos_giftbox_client_id): se il cliente
    // selezionato cambia, Concludi si blocca con "La GiftBox è collegata a un mittente
    // diverso..." (getConcludeBlockReason legacy).
    senderClientId: number;
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
  // Preview "Punti accreditati" della ricarica (mode=preview_recharge_points legacy).
  const [rechargePointsPreview, setRechargePointsPreview] = useState<{ points: number; campaignName: string; error: string } | null>(null);
  const [rechargePointsLoading, setRechargePointsLoading] = useState(false);
  const rechargePointsReqRef = useRef(0);

  // Checkout state. Al successo la cassa REINDIRIZZA alla pagina dedicata
  // pos_success (come il redirect legacy) — nessuna ricevuta inline.
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

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
  // QUOTE LOCK legacy (pos.js posQuoteLockActive): con un preventivo collegato righe,
  // catalogo, coupon/promozioni e sconti sono BLOCCATI (si può solo concludere la
  // vendita coerente col preventivo).
  const quoteLockActive = quoteSaleId > 0;
  const quotePreloadRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: PosContext) => setCtx(j ?? null))
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    // Microtask: load() fa setLoading(true) sincrono (pattern consolidato).
    let alive = true;
    Promise.resolve().then(() => {
      if (alive) load();
    });
    return () => {
      alive = false;
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
    // ?quote= (Next) o ?quote_id= (URL legacy "Vai a Pagamenti" del dettaglio preventivo).
    const posParams = new URLSearchParams(window.location.search);
    const rawId = posParams.get("quote") ?? posParams.get("quote_id");
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

  // Promo dei tile catalogo (pos.js loadTilePromos, debounce 220ms, max 60 item): per i
  // tile visibili chiede al server la mappa {service/product -> prezzo promo}; una chiave
  // cid|mode|ids evita richieste duplicate; un req-id scarta le risposte stantie.
  useEffect(() => {
    // Quote lock legacy (loadTilePromos): promo tile azzerate e nessuna richiesta.
    // (Reset in microtask: niente setState sincroni nell'effect.)
    if (quoteLockActive) {
      tilePromoKeyRef.current = "";
      const myReq = ++tilePromoReqRef.current;
      Promise.resolve().then(() => {
        if (myReq === tilePromoReqRef.current) setTilePromos({ service: {}, product: {} });
      });
      return;
    }
    const items = tiles.slice(0, 60).map((tile) => ({ type: catalogMode, id: tile.id }));
    const key = `${clientId ?? 0}|${catalogMode}|${items.map((it) => it.id).join(",")}`;
    if (key === tilePromoKeyRef.current) return;
    const myReq = ++tilePromoReqRef.current;
    if (!items.length) {
      tilePromoKeyRef.current = key;
      Promise.resolve().then(() => {
        if (myReq === tilePromoReqRef.current) setTilePromos({ service: {}, product: {} });
      });
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ action: "catalog_promos", client_id: clientId ?? 0, items_json: JSON.stringify(items) }),
        });
        const data: { ok?: boolean; enabled?: number; map?: { service?: Record<string, TilePromoInfo>; product?: Record<string, TilePromoInfo> } } = await res.json().catch(() => ({}));
        if (myReq !== tilePromoReqRef.current) return; // stale
        tilePromoKeyRef.current = key;
        if (res.ok && data?.ok && data.enabled && data.map) {
          setTilePromos({ service: data.map.service ?? {}, product: data.map.product ?? {} });
        } else {
          setTilePromos({ service: {}, product: {} });
        }
      } catch {
        if (myReq === tilePromoReqRef.current) setTilePromos({ service: {}, product: {} });
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [tiles, catalogMode, clientId, slug, quoteLockActive]);

  // ---- cart math (mirrors pos.js + lib/manage-pos.ts) ----
  const subtotal = useMemo(
    () => roundMoney(cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)),
    [cart],
  );

  // Ricarica in carrello (pos.js hasRechargeInCart): esclusiva — azzera punti spendibili,
  // blocca coupon/sconti/promozioni e forza il pagamento in unica soluzione.
  const hasRechargeInCart = useMemo(() => cart.some((l) => l.type === "recharge"), [cart]);

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
      setPromotionAllowsFidelity(true);
      setPromotionNonDiscounted(0);
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
  // The amount still payable after manual + promo + coupon — the cap the points discount
  // fits into. Con una promo NON cumulabile con la Fidelity (pos.js calcMaxPointsUse
  // 1942-1947), i punti mordono SOLO sulla parte non-promo del carrello, al netto della
  // quota proporzionale di sconto manuale.
  const baseForPoints = useMemo(() => {
    if (promotionId > 0 && promotionDiscount > 0 && !promotionAllowsFidelity) {
      const nonDisc = Math.max(0, promotionNonDiscounted);
      const manualPortion = subtotal > 0.00001 && manualDiscount > 0 ? manualDiscount * (nonDisc / subtotal) : 0;
      return roundMoney(Math.max(0, nonDisc - manualPortion));
    }
    return roundMoney(Math.max(0, subtotal - manualDiscount - promotionDiscount - codeDiscount));
  }, [subtotal, manualDiscount, promotionDiscount, codeDiscount, promotionId, promotionAllowsFidelity, promotionNonDiscounted]);
  // The most whole points the payable amount allows: floor(baseForPoints / euroPerPoint).
  const maxPointsByAmount = useMemo(
    () => (euroPerPoint > 0 ? Math.floor((baseForPoints + 1e-9) / euroPerPoint) : 0),
    [baseForPoints, euroPerPoint],
  );
  // Max spendibile legacy (pos.js calcMaxPointsUse): 0 con una ricarica in carrello;
  // min(disponibili, max per importo); azzerato se sotto il minimo configurato.
  const maxPointsUse = useMemo(() => {
    if (hasRechargeInCart) return 0;
    let maxUse = Math.max(0, Math.min(pointsBalance, maxPointsByAmount));
    if (minPoints > 0 && maxUse < minPoints) maxUse = 0;
    return maxUse;
  }, [hasRechargeInCart, pointsBalance, maxPointsByAmount, minPoints]);
  // Saldo GREZZO (può essere negativo) e prenotati, per l'help concatenato legacy.
  const pointsBalanceRaw = useMemo(() => Math.floor(residuals?.pointsBalance ?? 0), [residuals]);
  const pointsReservedVal = useMemo(() => Math.max(0, Math.floor(residuals?.pointsReserved ?? 0)), [residuals]);
  // The points actually used = min(requested, max spendibile legacy), whole.
  const pointsUsed = useMemo(() => {
    if (!fidelityEnabled) return 0;
    const typed = Math.max(0, Math.floor(Number.parseInt(pointsUseInput, 10) || 0));
    return Math.max(0, Math.min(typed, maxPointsUse));
  }, [fidelityEnabled, pointsUseInput, maxPointsUse]);
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

  // TOTALE legacy (pos.js recalcTotals currentPosTotal): il "Totale" mostrato e usato da
  // tutte le logiche di pagamento è NETTO dei residui applicati (GiftCard prima, poi
  // Credito). I residui restano tender distinti al checkout — qui è solo la semantica UI.
  const netTotal = useMemo(() => roundMoney(Math.max(0, total - residuiTotal)), [total, residuiTotal]);

  // ---- tipo pagamento (syncPaymentTypeControls legacy) ----
  // Radio abilitati solo con totale (netto) > 0; con totale a 0 selectedPaymentType() legacy
  // torna '' (i radio sono disabled) — da qui il gating della card rateizzazione.
  const paymentTypeEnabled = netTotal > 0.00001;
  const selectedPaymentTypeValue: PaymentMethod | "" = paymentTypeEnabled ? baseMethod : "";

  // ---- rateizzazione: gating legacy (installmentSingleChoiceEnabled/CanBeConfigured) ----
  const canChooseSingle = paymentTypeEnabled && selectedPaymentTypeValue !== "";
  const canConfigureInstallment = canChooseSingle && !!clientId && clientId > 0 && !hasRechargeInCart;
  const installmentChoiceRequired = canChooseSingle && installmentChoice === "";
  // Il piano è "attivo" (acconto in cassa + rate al checkout) solo con scelta Rateizzato
  // E piano salvato dal modale — il contesto è già validato dall'effetto di sync sotto.
  const installmentActive = installmentChoice === "installment" && !!installmentPlan;

  // ---- rateizzazione: bozza del modale ----
  // The draft params, clamped + derived for the schedule preview. count >= 2; the acconto
  // stays below the NET total (so financed > 0); the schedule splits financed across
  // `count` rows summing to financed. "Salva piano rate" snapshots the draft into
  // installmentPlan (writeInstallmentPlan legacy).
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
    () => roundMoney(Math.min(Math.max(0, Number.parseFloat(installmentDownInput.replace(",", ".")) || 0), Math.max(0, netTotal - 0.01))),
    [installmentDownInput, netTotal],
  );
  const installmentFinanced = useMemo(() => roundMoney(Math.max(0, netTotal - installmentDownPayment)), [netTotal, installmentDownPayment]);
  const installmentSchedule = useMemo(
    () => buildInstallmentSchedule(installmentFinanced, installmentCount, installmentFirstDueValue, installmentIntervalUnit, installmentIntervalValue),
    [installmentFinanced, installmentCount, installmentFirstDueValue, installmentIntervalUnit, installmentIntervalValue],
  );
  const installmentLastDue = useMemo(
    () => (installmentSchedule.length ? installmentSchedule[installmentSchedule.length - 1].dueDate : installmentFirstDueValue),
    [installmentSchedule, installmentFirstDueValue],
  );
  // Modal validation (mirrors preparePlanConfig): a client + positive total are required, the
  // acconto must be below the total (financed > 0) and there must be >= 2 rate. The save
  // button is disabled + the reason shown when the plan is not valid to commit.
  const installmentModalError = useMemo(() => {
    if (!clientId || clientId <= 0) return "Seleziona un cliente per configurare la rateizzazione.";
    if (netTotal <= 0.00001) return "La rateizzazione non è disponibile con totale a zero.";
    if (installmentCount < 2) return "Servono almeno 2 rate per un piano rateale.";
    if (installmentFinanced <= 0.00001) return "L'acconto iniziale deve essere inferiore al totale della vendita.";
    return "";
  }, [clientId, netTotal, installmentCount, installmentFinanced]);
  const installmentCanSave = useMemo(() => installmentModalError === "", [installmentModalError]);

  // Sync del piano col contesto (syncInstallmentPlanForContext legacy): totale a 0 o tipo
  // pagamento assente azzerano scelta e piano; una ricarica forza Pagamento unico; se
  // cliente, totale (>0.02) o tipo pagamento divergono dallo snapshot il piano cade con
  // il notice verbatim (la scelta resta Rateizzato -> "da configurare").
  useEffect(() => {
    // Sync in MICROTASK (niente setState sincroni nell'effect, pattern consolidato).
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      if (netTotal <= 0.00001 || !paymentTypeEnabled) {
        if (installmentChoice !== "" || installmentPlan) {
          setInstallmentChoice("");
          setInstallmentPlan(null);
          setInstallmentNotice("");
        }
        return;
      }
      if (hasRechargeInCart && (installmentChoice === "installment" || installmentPlan)) {
        setInstallmentPlan(null);
        setInstallmentChoice("single");
        setInstallmentNotice("Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.");
        return;
      }
      if (!installmentPlan) return;
      if (
        !clientId ||
        clientId <= 0 ||
        installmentPlan.clientId !== clientId ||
        Math.abs(installmentPlan.total - netTotal) > 0.02 ||
        installmentPlan.paymentType !== baseMethod
      ) {
        setInstallmentPlan(null);
        setInstallmentChoice("installment");
        setInstallmentNotice("Il piano rate è stato rimosso perché cliente, totale o tipo pagamento sono cambiati.");
      }
    });
    return () => {
      alive = false;
    };
  }, [netTotal, paymentTypeEnabled, hasRechargeInCart, installmentChoice, installmentPlan, clientId, baseMethod]);

  // Help della card rateizzazione (renderInstallmentCard legacy, cascata + override
  // ricariche + notice contestuale che vince su tutto).
  const installmentHelpText = useMemo(() => {
    let help = "Seleziona esplicitamente se il cliente paga in unica soluzione oppure con un piano rate.";
    if (netTotal <= 0.00001) help = "Totale a 0: nessuna scelta richiesta tra pagamento unico e rateizzato.";
    else if (!selectedPaymentTypeValue) help = "Seleziona il tipo di pagamento per scegliere come incassare la vendita.";
    else if (!installmentChoice) help = "Scelta obbligatoria: seleziona Pagamento unico o Rateizzato per continuare.";
    else if (installmentChoice === "single") help = "Pagamento in unica soluzione confermato.";
    else if (!clientId || clientId <= 0) help = "Per rateizzare la vendita devi prima selezionare un cliente.";
    else if (!installmentPlan) help = "Completa la configurazione del piano rate per continuare.";
    else help = "Piano rate confermato. Puoi modificarlo oppure selezionare Pagamento unico.";
    if (hasRechargeInCart && !installmentChoice) help = "Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.";
    if (hasRechargeInCart && installmentChoice === "installment") help = "Rateizzazione non disponibile per le ricariche credito. Seleziona Pagamento unico.";
    if (installmentNotice) help = installmentNotice;
    return help;
  }, [netTotal, selectedPaymentTypeValue, installmentChoice, clientId, installmentPlan, hasRechargeInCart, installmentNotice]);

  // ---- base payment math ----
  // The base method covers the remainder after residui. Con RATEIZZAZIONE attiva in cassa
  // entra solo l'ACCONTO del piano (il residuo è finanziato dalle rate — semantica legacy:
  // il piano è calcolato sul totale NETTO, i residui restano tender a parte).
  const baseAmount = useMemo(
    () => (installmentActive && installmentPlan ? roundMoney(Math.max(0, installmentPlan.downPayment)) : netTotal),
    [installmentActive, installmentPlan, netTotal],
  );
  const paidTotal = useMemo(() => roundMoney(residuiTotal + baseAmount), [residuiTotal, baseAmount]);
  // Residui can never exceed the balances (they are clamped above) nor the total, so the
  // base auto-covers the rest; "insufficiente" can only happen if the amount due now is
  // somehow not covered (defensive — mirrors the backend "Pagamento insufficiente").
  const paymentInsufficient = useMemo(
    () => !installmentActive && total > 0 && paidTotal + 0.00001 < total,
    [installmentActive, total, paidTotal],
  );

  // Motivo di blocco Concludi lato rateizzazione (getInstallmentConcludeBlockReason legacy).
  const installmentBlockReason = useMemo(() => {
    if (netTotal <= 0.00001) return "";
    if (!selectedPaymentTypeValue) return "Seleziona il tipo di pagamento della vendita.";
    if (!installmentChoice) {
      return hasRechargeInCart
        ? "Seleziona Pagamento unico per concludere la ricarica credito."
        : "Seleziona Pagamento unico o Rateizzato prima di concludere la vendita.";
    }
    if (hasRechargeInCart && installmentChoice !== "single") return "Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.";
    if (installmentChoice === "single") return "";
    if (!installmentPlan) return "Configura il piano rate prima di concludere la vendita.";
    if (!clientId || clientId <= 0) return "Seleziona un cliente per concludere una vendita rateizzata.";
    if (
      installmentPlan.clientId !== clientId ||
      Math.abs(installmentPlan.total - netTotal) > 0.02 ||
      installmentPlan.paymentType !== baseMethod
    ) {
      return "Il totale o il cliente della vendita è cambiato. Aggiorna la rateizzazione prima di concludere.";
    }
    return "";
  }, [netTotal, selectedPaymentTypeValue, installmentChoice, hasRechargeInCart, installmentPlan, clientId, baseMethod]);

  // Catena completa dei motivi di blocco Concludi (getConcludeBlockReason legacy): il
  // bottone è disabilitato e il motivo è mostrato SEMPRE in posConcludeHelp (non solo
  // dopo il submit). Ordine legacy: carrello vuoto -> mittente GiftBox -> cliente
  // richiesto -> mittente GiftCard -> rateizzazione.
  const concludeBlockReason = useMemo(() => {
    const currentClientId = clientId ?? 0;
    if (cart.length === 0) return "Aggiungi almeno un elemento prima di concludere la vendita.";
    if (gbDraft && gbDraft.senderClientId > 0 && currentClientId !== gbDraft.senderClientId) {
      return "La GiftBox è collegata a un mittente diverso. Seleziona il mittente corretto oppure elimina la GiftBox.";
    }
    if (gbDraft && (gbDraft.senderClientId <= 0 || currentClientId <= 0)) {
      return "Seleziona un mittente per emettere una GiftBox.";
    }
    // cartRowsRequireClient legacy: servizi/prodotti/ricariche/giftcard (e prepagati)
    // richiedono un cliente; i pacchetti solo fuori dalla GiftBox.
    const requiresClient = cart.some((l) => {
      if (l.type === "service" || l.type === "product" || l.type === "recharge" || l.type === "giftcard" || l.type === "prepaid") return true;
      if (l.type === "package") return !gbDraft;
      return false;
    });
    if (currentClientId <= 0 && requiresClient) return "Seleziona un cliente per concludere la vendita.";
    const giftcardLine = cart.find((l) => l.type === "giftcard");
    if (giftcardLine) {
      const senderId = giftcardLine.senderClientId ?? 0;
      if (senderId <= 0 && currentClientId <= 0) return "Seleziona un mittente per emettere una GiftCard.";
      if (currentClientId > 0 && senderId > 0 && senderId !== currentClientId) {
        return "La GiftCard è collegata a un mittente diverso. Rimuovila e ricreala per il mittente selezionato.";
      }
    }
    return installmentBlockReason;
  }, [cart, gbDraft, clientId, installmentBlockReason]);

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
    // Quote lock legacy (lockedQuoteClientId): il cliente del preventivo non si cambia —
    // la selezione manuale è ignorata (il seed del preventivo passa da qui prima del lock).
    if (quoteLockActive && clientId && clientId > 0 && id !== clientId) return;
    setClientId(id);
    setClientName(name);
  }

  function clearClient() {
    // The residui fetch effect's cleanup resets the applied residui on the clientId change.
    setClientId(null);
    setClientName("");
  }

  // RATEIZZAZIONE handlers (pos.js applyInstallmentChoice/openInstallmentModal/
  // saveInstallmentPlan). "Pagamento unico" azzera il piano e conferma la scelta;
  // "Rateizzato"/"Configura piano"/"Modifica piano" marca la scelta e apre il modale
  // (solo se configurabile); "Salva piano rate" fotografa la bozza nello snapshot.
  function chooseInstallmentSingle() {
    setInstallmentPlan(null);
    setInstallmentChoice("single");
    // Notice legacy (pos.js 3635: applyInstallmentChoice('single', ...)).
    setInstallmentNotice("Pagamento in unica soluzione selezionato.");
  }
  function openInstallmentModal() {
    if (hasRechargeInCart) {
      setInstallmentPlan(null);
      setInstallmentChoice("single");
      setInstallmentNotice("Le ricariche credito possono essere concluse solo con pagamento in unica soluzione.");
      return;
    }
    setInstallmentChoice("installment");
    setInstallmentNotice("Completa la configurazione del piano rate per continuare.");
    if (!canConfigureInstallment) return;
    // populateInstallmentModal legacy: la bozza riparte dal piano salvato (o dai default).
    if (installmentPlan) {
      setInstallmentDownInput(installmentPlan.downPayment.toFixed(2));
      setInstallmentCountInput(String(installmentPlan.count));
      setInstallmentIntervalUnit(installmentPlan.intervalUnit);
      setInstallmentIntervalValueInput(String(installmentPlan.intervalValue));
      setInstallmentFirstDue(installmentPlan.firstDue);
      setInstallmentNote(installmentPlan.note);
    }
    showPosModal("posInstallmentModal");
  }
  function saveInstallmentPlan() {
    if (!installmentCanSave) return;
    setInstallmentPlan({
      clientId: clientId ?? 0,
      total: netTotal,
      paymentType: baseMethod,
      downPayment: installmentDownPayment,
      financed: installmentFinanced,
      count: installmentCount,
      intervalUnit: installmentIntervalUnit,
      intervalValue: installmentIntervalValue,
      firstDue: installmentFirstDueValue,
      note: installmentNote.trim(),
      schedule: installmentSchedule.map((row) => ({ no: row.no, dueDate: row.dueDate, amount: row.amount })),
    });
    setInstallmentChoice("installment");
    setInstallmentNotice("");
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
      .then((j: { ok?: boolean; clientId?: number; credit?: number; giftcards?: ClientResiduals["giftcards"]; points?: number; pointsBalance?: number; pointsReserved?: number; fidelityAdhering?: boolean; fidelity?: ClientResiduals["fidelity"] }) => {
        if (!active || myReq !== residualsReqRef.current) return; // stale
        const epp = roundMoney(Math.max(0, Number(j?.fidelity?.euroPerPoint ?? 0.1))) || 0.1;
        setResiduals({
          clientId: Number(j?.clientId ?? clientId),
          credit: j?.ok === false ? 0 : roundMoney(Math.max(0, Number(j?.credit ?? 0))),
          giftcards: j?.ok !== false && Array.isArray(j?.giftcards)
            ? j.giftcards
                .map((card) => ({ id: Number(card.id ?? 0), code: String(card.code ?? ""), balance: roundMoney(Math.max(0, Number(card.balance ?? 0))), expiresAt: String(card.expiresAt ?? "") }))
                .filter((card) => card.id > 0 && card.balance > 0)
            : [],
          points: j?.ok === false ? 0 : Math.max(0, Math.floor(Number(j?.points ?? 0))),
          // Saldo/prenotati per l'help concatenato del box punti (il saldo può essere
          // negativo — pos.js lo mostra col messaggio dedicato).
          pointsBalance: j?.ok === false ? 0 : Math.floor(Number(j?.pointsBalance ?? j?.points ?? 0)),
          pointsReserved: j?.ok === false ? 0 : Math.max(0, Math.floor(Number(j?.pointsReserved ?? 0))),
          fidelityAdhering: j?.ok !== false && j?.fidelityAdhering === true,
          fidelity: {
            enabled: j?.ok !== false && j?.fidelity?.enabled === true,
            euroPerPoint: epp,
            minPoints: Math.max(0, Math.floor(Number(j?.fidelity?.minPoints ?? 0))),
          },
        });
      })
      .catch(() => {
        if (active && myReq === residualsReqRef.current) {
          setResiduals({ clientId, credit: 0, giftcards: [], points: 0, pointsBalance: 0, pointsReserved: 0, fidelityAdhering: false, fidelity: { enabled: false, euroPerPoint: 0.1, minPoints: 0 } });
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

  // Guardie legacy addItem (pos.js 185-198): quote lock + GiftCard/ricariche esclusive.
  function cartBlocksCatalogAdd(): boolean {
    if (quoteLockActive) {
      window.alert("Con un preventivo collegato non puoi aggiungere elementi al carrello.");
      return true;
    }
    if (cart.some((l) => l.type === "giftcard")) {
      window.alert("Non puoi aggiungere altri elementi: è presente una GiftCard in carrello. Rimuovila per continuare.");
      return true;
    }
    if (cart.some((l) => l.type === "recharge")) {
      window.alert("Non puoi aggiungere servizi o prodotti: è presente una ricarica in carrello. Le ricariche vanno vendute da sole.");
      return true;
    }
    return false;
  }

  function addTile(tile: { id: number; name: string; price: number }) {
    if (cartBlocksCatalogAdd()) return;
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
  // NB: un servizio si vende come PREPAGATO aggiungendolo al carrello e usando il toggle di riga
  // "Eseguito / Prepagato" (come il legacy) — NON esiste più un badge "+ Prepagato" sulle tile
  // (il legacy non ce l'ha). Al checkout una riga in stato "prepaid" emette il client_prepaid_services.

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

  // Show a Bootstrap modal by id — usato dai pre-check legacy (bottom bar / rateizzazione)
  // che aprono il modale SOLO dopo i controlli, al posto dei data-bs-target statici.
  function showPosModal(id: string) {
    if (typeof document === "undefined") return;
    const modalEl = document.getElementById(id);
    if (!modalEl) return;
    const w = window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance?: (el: Element) => { show?: () => void } } } };
    try {
      w.bootstrap?.Modal?.getOrCreateInstance?.(modalEl as Element)?.show?.();
    } catch {
      // no-op: bootstrap not ready (SSR/first paint) — the button can be clicked again.
    }
  }

  // ---- pre-check di apertura dei modali bottom-bar (alert verbatim pos.js) ----
  // Pacchetti (btnPackages): niente GiftCard/ricariche in carrello; serve un catalogo
  // pacchetti; il cliente NON è richiesto per aprire (solo per concludere).
  function openPackagesModal() {
    if (cart.some((l) => l.type === "giftcard")) {
      window.alert("Non puoi aggiungere pacchetti: è presente una GiftCard in carrello. Rimuovila per continuare.");
      return;
    }
    if (cart.some((l) => l.type === "recharge")) {
      window.alert("Non puoi aggiungere pacchetti: è presente una ricarica in carrello. Le ricariche vanno vendute da sole.");
      return;
    }
    if (packages.length === 0) {
      window.alert("Nessun pacchetto configurato.");
      return;
    }
    showPosModal("posModalPackages");
  }

  // Ricariche (btnRecharge): vendita ESCLUSIVA (nessun altro elemento) + cliente richiesto.
  function openRechargeModal() {
    if (cart.some((l) => l.type === "giftcard")) {
      window.alert("Non puoi aggiungere ricariche: è presente una GiftCard in carrello. Rimuovila per continuare.");
      return;
    }
    if (cart.some((l) => l.type === "package")) {
      window.alert("Non puoi aggiungere ricariche: è presente un pacchetto in carrello. Concludi una vendita separata oppure rimuovi il pacchetto.");
      return;
    }
    if (gbDraft) {
      window.alert("Non puoi aggiungere ricariche: è presente una GiftBox in questa vendita. Elimina la GiftBox per continuare.");
      return;
    }
    if (cart.some((l) => l.type !== "recharge")) {
      window.alert("Non puoi aggiungere ricariche: sono già presenti altri elementi in carrello. Le ricariche vanno vendute da sole.");
      return;
    }
    if (!clientId || clientId <= 0) {
      window.alert("Seleziona prima un cliente.");
      return;
    }
    showPosModal("posModalRecharge");
  }

  // GiftBox (btnGiftbox): non abbinabile a GiftCard/ricariche; serve il mittente e
  // almeno un contenuto (servizi/prodotti) in lista; le righe non conformi bloccano
  // col messaggio di eleggibilità.
  function openGiftboxModal() {
    if (cart.some((l) => l.type === "giftcard")) {
      window.alert("GiftBox e GiftCard non possono essere abbinate nella stessa vendita. Rimuovi la GiftCard dal carrello.");
      return;
    }
    if (cart.some((l) => l.type === "recharge")) {
      window.alert("GiftBox e Ricariche non possono essere abbinate nella stessa vendita. Rimuovi la ricarica dal carrello per continuare.");
      return;
    }
    if (!clientId || clientId <= 0) {
      window.alert("Seleziona un mittente prima di emettere una GiftBox.");
      return;
    }
    if (!cart.some((l) => l.type === "service" || l.type === "prepaid" || l.type === "product")) {
      window.alert("Aggiungi prima almeno un contenuto nella lista, poi potrai emettere una GiftBox.");
      return;
    }
    if (giftboxBlockingMessage) {
      window.alert(giftboxBlockingMessage);
      return;
    }
    showPosModal("posModalGiftbox");
  }

  // GiftCard (btnGiftcard): vendita mono-riga (solo la GiftCard), mai insieme a una
  // GiftBox; serve il mittente selezionato.
  function openGiftcardModal() {
    if (gbDraft) {
      window.alert("GiftCard e GiftBox non possono essere abbinate nella stessa vendita. Elimina la GiftBox per continuare.");
      return;
    }
    if (cart.some((l) => l.type !== "giftcard")) {
      window.alert("Per vendere una GiftCard la vendita deve contenere solo la GiftCard. Rimuovi gli altri elementi dal carrello.");
      return;
    }
    if (!clientId || clientId <= 0) {
      window.alert("Seleziona un mittente prima di emettere una GiftCard.");
      return;
    }
    showPosModal("posModalGiftcard");
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
        // Mittente legacy (items[gc_client_id]) per il blocco "mittente diverso".
        senderClientId: clientId ?? 0,
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
      senderClientId: clientId ?? 0,
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
  // Preview punti "Punti accreditati" (rcFetchPointsPreview legacy): campagna-aware,
  // debounced; un req-id scarta le risposte stantie. 0 senza cliente/importo.
  useEffect(() => {
    const myReq = ++rechargePointsReqRef.current;
    if (!clientId || clientId <= 0 || rechargeEarnBase <= 0.00001) {
      Promise.resolve().then(() => {
        if (myReq !== rechargePointsReqRef.current) return;
        setRechargePointsPreview(null);
        setRechargePointsLoading(false);
      });
      return;
    }
    Promise.resolve().then(() => {
      if (myReq === rechargePointsReqRef.current) setRechargePointsLoading(true);
    });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ action: "recharge_points_preview", client_id: clientId, amount: rechargeEarnBase }),
        });
        const j: { ok?: boolean; points?: number; campaignName?: string; error?: string } = await res.json().catch(() => ({}));
        if (myReq !== rechargePointsReqRef.current) return; // stale
        setRechargePointsPreview({
          points: Math.max(0, Number(j?.points ?? 0) || 0),
          campaignName: String(j?.campaignName ?? ""),
          error: String(j?.error ?? ""),
        });
        setRechargePointsLoading(false);
      } catch {
        if (myReq !== rechargePointsReqRef.current) return;
        setRechargePointsPreview({ points: 0, campaignName: "", error: "Preview punti non disponibile: il calcolo verra eseguito alla chiusura vendita." });
        setRechargePointsLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [clientId, rechargeEarnBase, slug]);

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
    // Un solo coupon per vendita (pos.js couponApplyBtn): se un codice è già applicato
    // e se ne digita un altro, l'input torna al codice applicato col messaggio verbatim.
    if (couponCode && code && code !== couponCode) {
      setCouponInput(couponCode);
      setCouponMsg({ text: "Puoi applicare un solo coupon per vendita. Rimuovi quello attuale prima di inserirne un altro.", ok: false });
      return;
    }
    if (!code) {
      clearCouponState();
      setCouponInput("");
      setCouponMsg(null);
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
        // Esito legacy (pos.js fetchPreview): a coupon valido couponHelp resta VUOTO —
        // lo sconto compare nella riga "Coupon / Promo" del dettaglio prezzi.
        setCouponMsg(null);
      } else {
        clearCouponState();
        setCouponInput(code);
        // Esiti verbatim legacy: reason del preview, altrimenti "Codice non trovato."
        // (il preview Next include già "Codice non applicabile." tra le reason).
        setCouponMsg({ text: String(preview?.reason || data?.error || "Codice non trovato."), ok: false });
      }
    } catch {
      if (myReq !== couponReqRef.current) return;
      clearCouponState();
      setCouponInput(code);
      setCouponMsg({ text: "Errore durante la verifica del coupon.", ok: false });
    } finally {
      if (myReq === couponReqRef.current) setCouponApplying(false);
    }
  }, [couponInput, couponCode, subtotal, slug, clearCouponState, cart, clientId]);

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
    setPromotionAllowsFidelity(true);
    setPromotionNonDiscounted(0);
  }, []);

  // Auto-promozioni legacy (pos.js fetchPreview -> preview_auto_promo, debounce 250ms,
  // best-effort e SILENZIOSO): con carrello servizi/prodotti, nessun coupon applicato e
  // nessuna ricarica, applica la migliore promozione attiva; la riga "Promozione: {nome}"
  // appare nel dettaglio prezzi. promotion_id is sent on checkout, where the backend
  // re-evaluates + records the redemption. Un req-id scarta le risposte stantie.
  useEffect(() => {
    if (quoteLockActive || hasRechargeInCart || subtotal <= 0 || couponCode) {
      const myReq = ++promotionReqRef.current;
      Promise.resolve().then(() => {
        if (myReq === promotionReqRef.current) clearPromotion();
      });
      return;
    }
    const promoCart = cart
      .filter((l) => (l.type === "service" || l.type === "product") && l.refId > 0 && l.unitPrice > 0)
      .map((l) => ({ type: l.type, id: l.refId, qty: l.quantity, unitPrice: l.unitPrice }));
    if (promoCart.length === 0) {
      const myReq = ++promotionReqRef.current;
      Promise.resolve().then(() => {
        if (myReq === promotionReqRef.current) clearPromotion();
      });
      return;
    }
    const myReq = ++promotionReqRef.current;
    const timer = setTimeout(async () => {
      try {
        const now = new Date();
        const res = await fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "evaluate",
            // Solo promo AUTO-applicabili (mai quelle "su codice"; senza cliente
            // saltano quelle con limite per-cliente) — pos.php preview_auto_promo.
            auto_only: 1,
            cart_json: JSON.stringify(promoCart),
            date: now.toISOString().slice(0, 10),
            time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
            client_id: clientId ?? 0,
          }),
        });
        const data: { ok?: boolean; best?: { promotionId: number; title: string; discount: number; stackableWithFidelity?: boolean; nonDiscountedSubtotal?: number } | null } = await res.json().catch(() => ({}));
        if (myReq !== promotionReqRef.current) return; // stale
        const best = data?.best;
        if (res.ok && data?.ok && best && best.discount > 0) {
          setPromotionId(best.promotionId);
          setPromotionName(best.title);
          setPromotionDiscountRaw(roundMoney(best.discount));
          setPromotionAllowsFidelity(best.stackableWithFidelity !== false);
          setPromotionNonDiscounted(roundMoney(Math.max(0, Number(best.nonDiscountedSubtotal ?? 0))));
        } else {
          clearPromotion();
        }
      } catch {
        if (myReq === promotionReqRef.current) clearPromotion();
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [cart, subtotal, clientId, couponCode, hasRechargeInCart, quoteLockActive, slug, clearPromotion]);

  // Lock ricarica (pos.js syncRechargeExclusivePricingState): con una ricarica in
  // carrello coupon, buoni, promozioni, sconti e punti vengono AZZERATI e i controlli
  // disabilitati; il couponHelp mostra il messaggio verbatim (reso nel JSX).
  useEffect(() => {
    if (!hasRechargeInCart) return;
    // Reset in microtask (pattern consolidato).
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      clearCouponState();
      setCouponInput("");
      setCouponMsg(null);
      setDiscountType("none");
      setDiscountValue("0");
      setPointsUseInput("0");
      clearPromotion();
    });
    return () => {
      alive = false;
    };
  }, [hasRechargeInCart, clearCouponState, clearPromotion]);

  // ---- Residui mutators ----
  // Picking a different giftcard resets the applied amount (the balances differ).
  function chooseGiftcard(id: number) {
    setGiftcardId(id);
    setGiftcardUseInput("0");
  }
  // "Max" for fidelity points: apply the most the client can spend on this sale —
  // min(balance, floor(payable / euroPerPoint)). The pointsUsed memo re-clamps.
  function useMaxPoints() {
    setPointsUseInput(String(maxPointsUse));
  }

  async function handleCheckout(event: React.FormEvent) {
    event.preventDefault();
    setErrorMsg("");

    // syncConcludeState legacy: qualunque motivo di blocco (carrello vuoto, mittente
    // GiftBox/GiftCard, cliente richiesto, scelta/piano rate) ferma il submit.
    if (concludeBlockReason) {
      setErrorMsg(concludeBlockReason);
      return;
    }
    // GiftBox ATTIVA ma senza contenuto (pos.js 5698, validazione al submit):
    // niente righe eleggibili (servizi Prepagato/prodotti Ordinato) né pacchetti
    // in GiftBox -> blocco col testo verbatim.
    if (gbDraft && giftboxEligibleLines.length === 0 && !cart.some((l) => l.type === "package")) {
      setErrorMsg("GiftBox attiva ma senza contenuto. Aggiungi almeno un servizio/prodotto oppure un pacchetto in GiftBox, oppure elimina la GiftBox.");
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
      // Scelta unico/rateizzato legacy (installment_choice_mode): il server la
      // pretende quando il totale netto è > 0 (pos.php 4631).
      installment_choice: installmentChoice,
      // "Vendita da preventivo": link the sale to the source quote so the backend sets
      // sales.source_quote_id + flips the quote to 'converted'. 0 for a normal POS sale.
      source_quote_id: quoteSaleId > 0 ? quoteSaleId : 0,
      notes: notes.trim(),
      // RATEIZZAZIONE: when a rate plan is active (scelta Rateizzato + piano salvato), send
      // the SNAPSHOT params as JSON. The backend writes the sale_installment_plans row + N
      // sale_installments rows scheduling the financed remainder (net total - acconto).
      // Omitted (empty) for a single payment — the common path.
      installment_plan: installmentActive && installmentPlan
        ? JSON.stringify({
            count: installmentPlan.count,
            down_payment: installmentPlan.downPayment,
            interval_value: installmentPlan.intervalValue,
            interval_unit: installmentPlan.intervalUnit,
            first_due_date: installmentPlan.firstDue,
            note: installmentPlan.note,
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
      // Success LEGACY (pos.php 5904): la cassa NON mostra nulla inline — reindirizza
      // alla pagina dedicata "Vendita completata" (pos_success), con flash=1 per
      // l'alert "Operazione completata con successo." (l'equivalente del flash di
      // sessione legacy). Lo stato della cassa si azzera con la navigazione.
      const saleId = Math.max(0, Number(json?.sale?.id ?? 0) || 0);
      window.location.href = `/${encodeURIComponent(slug)}/pos_success?id=${saleId}&flash=1`;
      return;
    } catch {
      setErrorMsg("Errore di rete durante la conclusione della vendita.");
    } finally {
      setSubmitting(false);
    }
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
        // Banner legacy (pos.php 5996-6002): preventivo + cliente bloccati in Pagamenti,
        // con link "Torna al preventivo".
        <div className="alert alert-info d-flex align-items-center gap-2" id="posQuoteBanner">
          <i className="bi bi-file-earmark-text"></i>
          <div className="flex-grow-1">
            <div>
              Preventivo <strong>#{quoteSaleCode || quoteSaleId}</strong> • Cliente: <strong>{clientName || "—"}</strong> caricato in Pagamenti.
            </div>
            <div className="small">
              Il cliente resta associato al preventivo durante il pagamento. Per mantenere coerenza con il preventivo,
              righe, catalogo e sconti sono bloccati in Pagamenti.
            </div>
          </div>
          <a className="btn btn-sm btn-outline-primary" href={`/${slug}/quote_detail?id=${quoteSaleId}`}>
            Torna al preventivo
          </a>
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
                    {/* Quote lock legacy: cliente bloccato (clear nascosto, pos.js 3880). */}
                    <button
                      type="button"
                      className={`btn btn-sm btn-link text-muted p-0${clientId && !quoteLockActive ? "" : " d-none"}`}
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
                            readOnly={quoteLockActive}
                            onChange={(e) => {
                              if (quoteLockActive) return;
                              setQty(line.key, Number.parseInt(e.target.value, 10));
                            }}
                          />
                        </td>
                        <td className="text-end small">{fmtEUR(line.unitPrice)}</td>
                        <td className="text-end small line-total">{fmtEUR(line.unitPrice * line.quantity)}</td>
                        <td className="text-end">
                          {/* Quote lock legacy: riga non rimovibile (title verbatim). */}
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            disabled={quoteLockActive}
                            title={quoteLockActive ? "Riga bloccata dal preventivo collegato" : undefined}
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
                          {/* Il legacy NON ha un badge "+ Prepagato" sulle tile: un servizio si
                              imposta come Prepagato dal toggle "Eseguito / Prepagato" sulla riga
                              del carrello (pos.js: onLabel 'Eseguito' / offLabel 'Prepagato'). */}
                        </div>
                        <div className="text-end">
                          {/* Promo tile legacy (pos.js tileSetPromo): prezzo pieno barrato +
                              prezzo promo + badge "-N%" (o "Promo") col nome promo nel title.
                              Il click aggiunge comunque a prezzo pieno. */}
                          {(() => {
                            const info = tilePromos[catalogMode][String(tile.id)];
                            const hasPromo = !!info && info.promo_unit_price + 1e-9 < tile.price;
                            return (
                              <div className="pos-tile-price-row">
                                <span className={`pos-tile-price-old${hasPromo ? "" : " d-none"}`}>{fmtEUR(tile.price)}</span>
                                <span className="pos-tile-price">{fmtEUR(hasPromo ? info.promo_unit_price : tile.price)}</span>
                                <span
                                  className={`badge bg-success pos-tile-promo-badge${hasPromo ? "" : " d-none"}`}
                                  title={hasPromo && info.promo_name ? info.promo_name : undefined}
                                >
                                  {hasPromo && info.percent >= 1 ? `-${Math.round(info.percent)}%` : "Promo"}
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Alert legacy quote lock (pos.php 6168-6170). */}
              {quoteLockActive ? (
                <div className="alert alert-secondary small mt-3 mb-0" id="posCatalogLockedAlert">
                  Catalogo bloccato: con un preventivo collegato non puoi aggiungere servizi, prodotti, pacchetti,
                  ricariche, GiftBox o GiftCard.
                </div>
              ) : null}

              <div className="pos-bottom-bar mt-3">
                {/* Pre-check legacy al click (pos.js btnPackages/btnRecharge/btnGiftbox/
                    btnGiftcard): gli alert verbatim bloccano l'apertura del modale;
                    disabilitati col quote lock (pos.php 6175-6188). */}
                <button type="button" className="btn btn-light pos-bottom-btn" id="posBtnPackages" disabled={quoteLockActive} onClick={openPackagesModal}>
                  <i className="bi bi-box-seam me-1"></i>Pacchetti
                </button>
                <button type="button" className="btn btn-light pos-bottom-btn" id="posBtnRecharge" disabled={quoteLockActive} onClick={openRechargeModal}>
                  <i className="bi bi-arrow-repeat me-1"></i>Ricariche
                </button>
                <button type="button" className="btn btn-light pos-bottom-btn" id="posBtnGiftbox" disabled={quoteLockActive} onClick={openGiftboxModal}>
                  <i className="bi bi-gift me-1"></i>GiftBox
                </button>
                <button type="button" className="btn btn-light pos-bottom-btn" id="posBtnGiftcard" disabled={quoteLockActive} onClick={openGiftcardModal}>
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

              {/* Badge cliente legacy (pos.js syncClientMetaUI): Fidelity SI/NO in base
                  all'adesione (tessera attiva), '—' senza cliente; Punti '…' finché il
                  fetch residui non risolve, '0' senza cliente. */}
              <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                <span className="badge bg-light text-dark">
                  Fidelity: <span id="posClientAdhering">{clientId ? (residualsLoading ? "—" : residuals?.fidelityAdhering ? "SI" : "NO") : "—"}</span>
                </span>
                <span className="badge bg-light text-dark">
                  Punti: <span id="posClientPoints">{clientId ? (residualsLoading ? "…" : pointsBalance) : 0}</span>
                </span>
              </div>
              {/* posRedeemInfo legacy a 3 stati: testo default senza cliente, "Caricamento
                  punti disponibili…" col riscatto attivo finché i punti non sono caricati,
                  vuoto una volta caricati. */}
              <div className="small text-muted mb-3" id="posRedeemInfo">
                {!clientId
                  ? `Seleziona un cliente per vedere ${ctx?.fidelityRedeemEnabled ? "punti, credito" : "credito"} disponibili.`
                  : ctx?.fidelityRedeemEnabled && residualsLoading
                    ? "Caricamento punti disponibili…"
                    : ""}
              </div>

              <label className="form-label small text-muted mb-1">Coupon</label>
              <div className="border rounded p-2 bg-light-subtle">
                <div className="small fw-semibold mb-1">
                  <i className="bi bi-megaphone me-1"></i>Promozioni / Coupon
                </div>
                <a
                  href="#"
                  className={`text-success small text-decoration-underline${hasRechargeInCart || quoteLockActive ? " text-muted" : ""}`}
                  id="couponToggle"
                  aria-disabled={hasRechargeInCart || quoteLockActive ? "true" : "false"}
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
                      disabled={hasRechargeInCart || quoteLockActive}
                      readOnly={!!couponCode}
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
                      disabled={couponApplying || hasRechargeInCart || quoteLockActive}
                      onClick={() => void applyCoupon()}
                    >
                      Applica
                    </button>
                    <button
                      className="btn btn-outline-secondary"
                      type="button"
                      id="couponRemoveBtn"
                      disabled={couponApplying || hasRechargeInCart || quoteLockActive}
                      onClick={removeCoupon}
                    >
                      Rimuovi
                    </button>
                  </div>
                  {/* couponHelp legacy: col lock ricarica mostra il messaggio verbatim
                      (neutro); altrimenti gli esiti del preview. Le promozioni AUTO sono
                      silenziose (nessun box "Rileva promozione" nel legacy). */}
                  <div
                    className={`form-text${!hasRechargeInCart && !quoteLockActive && couponMsg ? (couponMsg.ok ? " text-success" : " text-danger") : ""}`}
                    id="couponHelp"
                  >
                    {quoteLockActive
                      ? "Con un preventivo collegato coupon e promozioni non sono applicabili."
                      : hasRechargeInCart
                        ? "Con una ricarica in carrello coupon, buoni, promozioni, sconti e punti non sono applicabili."
                        : couponMsg?.text ?? ""}
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
                    disabled={hasRechargeInCart || quoteLockActive}
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
                    disabled={hasRechargeInCart || quoteLockActive}
                    onChange={(e) => setDiscountValue(e.target.value)}
                  />
                </div>
              </div>

              {/* Fidelity / punti — WIRED: shown when the selected client has points and the
                  business has redemption enabled. The staff types points to use; the € discount
                  (punti x euroPerPoint) is clamped to min(balance, floor(payable / euroPerPoint))
                  and subtracted from the total. "Max" applies the most spendable. fidelity_points_use
                  is sent on checkout (the backend re-validates + consumes the points). */}
              {/* Box punti legacy (pos.php 6277-6284 + pos.js sync): visibile solo con max
                  spendibile > 0; help CONCATENATO "Disponibili • Max • Saldo • Prenotati •
                  Min • Stai usando ~€" (con il messaggio saldo negativo quando serve). */}
              <div id="posFidelityRedeemBox" className={fidelityEnabled && maxPointsUse > 0 ? "" : "d-none"}>
                <label className="form-label small text-muted mb-1">Punti da usare</label>
                <div className="input-group input-group-sm mb-1">
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max={maxPointsUse}
                    className="form-control"
                    name="fidelity_points_use"
                    id="fidelity_points_use"
                    value={pointsUseInput}
                    disabled={hasRechargeInCart}
                    onChange={(e) => setPointsUseInput(e.target.value)}
                  />
                  <button type="button" className="btn btn-outline-secondary" id="pointsMaxBtn" disabled={hasRechargeInCart} onClick={useMaxPoints}>
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
                      : (() => {
                          let msg = `Disponibili: ${pointsBalance} Punti • Max: ${maxPointsUse} Punti`;
                          if (Math.abs(pointsBalanceRaw) > 0) msg += ` • Saldo: ${pointsBalanceRaw}`;
                          if (pointsReservedVal > 0) msg += ` • Prenotati: ${pointsReservedVal}`;
                          if (pointsBalanceRaw < 0) msg += " • Saldo negativo: i punti disponibili restano 0 finché non vengono compensati da nuovi accrediti.";
                          if (minPoints > 0) msg += ` • Min: ${minPoints}`;
                          if (pointsUsed > 0) msg += ` • Stai usando ~€ ${(pointsUsed * euroPerPoint).toFixed(2).replace(".", ",")}`;
                          return msg;
                        })()}
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
                {/* Radio btn-check legacy (pos.php 6298-6319) con la logica di
                    syncPaymentTypeControls: radio disabilitati (+ card is-disabled) con
                    totale a 0 e help a due stati verbatim. */}
                <div
                  className={`mb-3 pos-payment-type-card${paymentTypeEnabled ? "" : " is-disabled"}`}
                  id="posPaymentTypeBox"
                  aria-disabled={paymentTypeEnabled ? "false" : "true"}
                >
                  <div className="small text-muted mb-2">Tipo pagamento</div>
                  <div className="pos-payment-type-grid">
                    {(["cash", "card", "check", "bank"] as PaymentMethod[]).map((method) => (
                      <div className="pos-payment-type-option" key={method}>
                        <input
                          className="btn-check"
                          type="radio"
                          name="payment_type"
                          id={`posPaymentType${method.charAt(0).toUpperCase()}${method.slice(1)}`}
                          value={method}
                          checked={baseMethod === method}
                          disabled={!paymentTypeEnabled}
                          onChange={() => setBaseMethod(method)}
                        />
                        <label
                          className="pos-payment-type-label"
                          htmlFor={`posPaymentType${method.charAt(0).toUpperCase()}${method.slice(1)}`}
                          title={method === "card" ? "Carta di Credito" : method === "bank" ? "Bonifico" : undefined}
                        >
                          {PAYMENT_METHOD_LABELS[method]}
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="form-text mt-2" id="posPaymentTypeHelp">
                    {paymentTypeEnabled ? "Seleziona come paga il cliente." : "Totale a 0: nessun tipo di pagamento selezionabile."}
                  </div>
                </div>

                {/* Rateizzazione — card legacy (pos.php 6321-6351 + pos.js
                    renderInstallmentCard): scelta OBBLIGATORIA quando il totale è > 0
                    (badge fisso "Scelta obbligatoria"), headline a 5 stati, bottoni con
                    is-selected/is-pending e testo dinamico, help in cascata (+ notice
                    contestuale), riepilogo dal piano SALVATO. */}
                <div
                  className={`mb-3 pos-installment-card${!canChooseSingle && installmentChoice !== "installment" && !installmentPlan ? " is-disabled" : ""}${installmentChoiceRequired ? " is-required" : ""}`}
                  id="posInstallmentCard"
                >
                  <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
                    <div className="small text-muted mb-0" id="posInstallmentHeadline">
                      {!canChooseSingle
                        ? "Pagamento unico / rateizzato"
                        : !installmentChoice
                          ? "Seleziona modalità di saldo"
                          : installmentChoice === "single"
                            ? "Pagamento in unica soluzione selezionato"
                            : installmentPlan
                              ? "Pagamento rateizzato configurato"
                              : "Pagamento rateizzato da configurare"}
                    </div>
                    <span
                      className={`badge rounded-pill pos-installment-required-badge${installmentChoiceRequired ? "" : " d-none"}`}
                      id="posInstallmentRequiredBadge"
                    >
                      Scelta obbligatoria
                    </span>
                  </div>
                  <div className="pos-installment-choice-grid">
                    <button
                      type="button"
                      className={`btn pos-installment-choice-btn${installmentChoice === "single" ? " is-selected" : ""}`}
                      id="posInstallmentSingleBtn"
                      disabled={!canChooseSingle}
                      aria-pressed={installmentChoice === "single"}
                      onClick={chooseInstallmentSingle}
                    >
                      Pagamento unico
                    </button>
                    <button
                      type="button"
                      className={`btn pos-installment-choice-btn${installmentChoice === "installment" && installmentPlan ? " is-selected" : ""}${installmentChoice === "installment" && !installmentPlan ? " is-pending" : ""}`}
                      id="posInstallmentConfigureBtn"
                      disabled={!canConfigureInstallment}
                      aria-pressed={installmentChoice === "installment"}
                      onClick={openInstallmentModal}
                    >
                      {installmentPlan ? "Modifica piano" : installmentChoice === "installment" ? "Configura piano" : "Rateizzato"}
                    </button>
                  </div>
                  <div className="form-text mt-2" id="posInstallmentHelp">
                    {installmentHelpText}
                  </div>

                  <div className={`pos-installment-summary${installmentPlan ? "" : " d-none"}`} id="posInstallmentSummary">
                    {installmentPlan ? (
                      <>
                        <div className="small fw-semibold mb-1" id="posInstallmentSummaryText">
                          {[
                            `Acconto oggi ${fmtEUR(installmentPlan.downPayment)}`,
                            `Residuo ${fmtEUR(installmentPlan.financed)}`,
                            `${installmentPlan.count} rate`,
                            `Cadenza ${installmentPlan.intervalValue} ${
                              installmentPlan.intervalUnit === "day"
                                ? installmentPlan.intervalValue === 1 ? "giorno" : "giorni"
                                : installmentPlan.intervalUnit === "week"
                                  ? installmentPlan.intervalValue === 1 ? "settimana" : "settimane"
                                  : installmentPlan.intervalValue === 1 ? "mese" : "mesi"
                            }`,
                            `Prima scadenza ${fmtDMY(installmentPlan.firstDue)}`,
                          ].join(" • ")}
                        </div>
                        <div
                          className={`small text-muted mb-2${installmentPlan.note ? "" : " d-none"}`}
                          id="posInstallmentSummaryNote"
                        >
                          {installmentPlan.note ? `Note: ${installmentPlan.note}` : ""}
                        </div>
                        <div
                          className={`table-responsive${installmentPlan.schedule.length ? "" : " d-none"}`}
                          id="posInstallmentScheduleWrap"
                        >
                          <table className="table table-sm mb-2 pos-installment-schedule-table">
                            <thead>
                              <tr>
                                <th>Rata</th>
                                <th>Scadenza</th>
                                <th className="text-end">Importo</th>
                              </tr>
                            </thead>
                            <tbody id="posInstallmentScheduleBody">
                              {installmentPlan.schedule.map((row) => (
                                <tr key={row.no}>
                                  <td>Rata {row.no}</td>
                                  <td>{fmtDMY(row.dueDate)}</td>
                                  <td className="text-end">{fmtEUR(row.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : null}
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-outline-primary btn-sm"
                        id="posInstallmentEditBtn"
                        onClick={openInstallmentModal}
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
                  <span>{promotionName ? `Promozione: ${promotionName}` : "Coupon / Promo"}</span>
                  <span>- {fmtEUR(promotionDiscount)}</span>
                </div>

                <div
                  className={`d-flex justify-content-between text-muted small${codeDiscount > 0 ? "" : " d-none"}`}
                  id="posCodeDiscountRow"
                >
                  {/* Etichetta legacy (pos.js recalcTotals codeLabel): generica "Coupon / Promo". */}
                  <span id="posCodeDiscountLabel">Coupon / Promo</span>
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
                  {/* Etichetta legacy (pos.js 3497): "Sconto Fidelity (N Punti)". */}
                  <span id="posFidelityLabel">{fidelityDiscount > 0 ? `Sconto Fidelity (${pointsUsed} Punti)` : "Sconto Punti"}</span>
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
                  {/* Totale legacy: NETTO dei residui applicati (recalcTotals currentPosTotal). */}
                  <strong id="posTotalVal">{fmtEUR(netTotal)}</strong>
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

              {/* syncConcludeState legacy: bottone disabilitato + motivo SEMPRE visibile in
                  posConcludeHelp (title incluso) finché c'è un blocco; gli errori del
                  submit (server) usano lo stesso help. */}
              <button
                className="btn btn-success w-100 mt-3"
                type="submit"
                id="posConcludeBtn"
                disabled={submitting || !!concludeBlockReason || paymentInsufficient || pointsBelowMin || pointsOverBalance}
                aria-disabled={submitting || !!concludeBlockReason ? "true" : "false"}
                title={concludeBlockReason || undefined}
              >
                <i className="bi bi-check2-circle me-1"></i>
                {submitting ? "Conclusione…" : "Concludi"}
              </button>
              <div className={`small text-danger mt-2${errorMsg || concludeBlockReason ? "" : " d-none"}`} id="posConcludeHelp">
                {errorMsg || concludeBlockReason}
              </div>

              {/* Blocco info Fidelity legacy (pos.php 6399-6411), visibile col riscatto
                  punti attivo: stato campagna punti + valore punto. */}
              {ctx?.fidelityRedeemEnabled ? (
                <div className="small text-muted mt-3">
                  Fidelity attivo:{" "}
                  {ctx.fidelityEarnInfo?.campaignActiveToday
                    ? "accredito secondo la campagna punti valida al momento della vendita •"
                    : "nessuna campagna punti attiva oggi •"}{" "}
                  1 punto = € {(ctx.fidelityEarnInfo?.euroPerPoint ?? 0.1).toFixed(2).replace(".", ",")}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </form>

      {/* ===================== MODALI (tutti wired: Residui, Rate, Ricariche, Pacchetti, GiftBox, GiftCard) ===================== */}

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
                  {/* Variante ricarica-in-carrello (pos.js 3112) vs vuoto (3113). */}
                  {hasRechargeInCart
                    ? "I residui del cliente non sono utilizzabili quando nel carrello è presente una ricarica credito."
                    : "Nessun residuo disponibile per il cliente selezionato."}
                </div>
              ) : null}

              {creditAvailable > 0 ? (
                <div className="card p-3 mb-3" id="posResidualCreditCard">
                  <div className="fw-semibold mb-1">Credito</div>
                  {/* Help legacy (pos.js 3062-3063): con ricarica in carrello il credito
                      è disattivato col testo dedicato; altrimenti saldo + max. */}
                  <div className="small text-muted mb-3">
                    {hasRechargeInCart
                      ? "Il credito non può essere usato se nel carrello è presente una ricarica."
                      : `Saldo tessera: ${fmtEUR(creditAvailable)} • Max utilizzabile: ${fmtEUR(roundMoney(Math.min(creditAvailable, total)))}`}
                  </div>

                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="posResidualCreditToggle"
                      disabled={hasRechargeInCart}
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
                      disabled={hasRechargeInCart}
                      onChange={(e) => setRmCreditAmt(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-outline-secondary"
                      id="posResidualCreditMaxBtn"
                      disabled={hasRechargeInCart}
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
                  {/* Help legacy (pos.js 3103): con ricarica in carrello le GiftCard
                      sono disattivate col testo dedicato. */}
                  <div className="small text-muted mb-3">
                    {hasRechargeInCart
                      ? "Le GiftCard non possono essere usate se nel carrello è presente una ricarica."
                      : "Seleziona una GiftCard disponibile e scegli l'importo da usare."}
                  </div>

                  <div id="posResidualGiftcardList" className="mb-3">
                    {residuals?.giftcards.map((card) => (
                      <div className="form-check" key={card.id}>
                        <input
                          className="form-check-input"
                          type="radio"
                          name="posResidualGiftcardPick"
                          id={`posResidualGiftcard_${card.id}`}
                          disabled={hasRechargeInCart}
                          checked={rmGiftcardId === card.id}
                          onChange={() => {
                            setRmGiftcardId(card.id);
                            setRmGiftcardAmt(String(roundMoney(Math.min(card.balance, total))));
                          }}
                        />
                        <label className="form-check-label" htmlFor={`posResidualGiftcard_${card.id}`}>
                          {/* Riga legacy (pos.js 3104): 'Disponibile: X • Scade: Y' / 'Scadenza: —'. */}
                          {card.code || `GiftCard #${card.id}`} — <strong>{fmtEUR(card.balance)}</strong>
                          <span className="text-muted small"> • {card.expiresAt ? `Scade: ${card.expiresAt}` : "Scadenza: —"}</span>
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
                      <input type="text" className="form-control" id="posInstallmentSaleTotal" value={fmtEUR(netTotal)} readOnly />
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
                      <strong id="posInstallmentPreviewLastDue">{installmentLastDue ? fmtDMY(installmentLastDue) : "—"}</strong>
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
                              <td>Rata {row.no}</td>
                              <td>{fmtDMY(row.dueDate)}</td>
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
              {rechargeTemplates.length === 0 ? (
                <div className="alert alert-light border small mt-2 mb-0">
                  Nessun modello di ricarica disponibile. Puoi comunque inserire importo e bonus manualmente, oppure crearne
                  uno nella pagina Ricariche.
                </div>
              ) : null}

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
                {/* Riga legacy "Punti accreditati" (pos.php 6654 + rcFetchPointsPreview):
                    preview campagna-aware via action=recharge_points_preview; '...' in
                    caricamento; il nome campagna (o l'errore) nel title. */}
                <div className="d-flex justify-content-between small text-muted">
                  <span>Punti accreditati</span>
                  <span
                    id="posRechargePrevPoints"
                    title={rechargePointsPreview?.campaignName ? `Campagna: ${rechargePointsPreview.campaignName}` : rechargePointsPreview?.error || undefined}
                  >
                    {rechargePointsLoading ? "..." : `${(rechargePointsPreview?.points ?? 0).toFixed(2).replace(".", ",")}`}
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

    </div>
  );
}
