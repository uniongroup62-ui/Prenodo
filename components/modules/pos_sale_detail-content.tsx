"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP POS "Dettaglio vendita" page (app/pages/pos_sale_detail.php),
// fed by the DB-backed /api/manage/pos route:
//   GET  ?action=sale_detail&id=<id>  -> the sale (header + grouped items + payments +
//                                         totals) + the cancel summary/blockers
//   POST action=cancel                -> annulla vendita (sale_id, reason, stock_cancel_mode)
//   POST action=mark_collected        -> "Segna ritirato" for an ordered product line (qty)
//   POST action=undo_collected        -> "Rimuovi ritiro" reverse a collected product line
//   POST action=prepaid_manual_execute-> "Segna eseguito" manual execution of a prepaid line
//   POST action=prepaid_manual_undo   -> "Annulla esecuzione" reverse a manual execution
//
// SCOPE: the operational CORE (view + cancel + pickup + receipt) PLUS the "Cronologia utilizzo /
// ritiro" tracking cards — prepaid manual execution/undo + usage timeline, and partial pickup +
// undo. Only the deepest stock-document audit columns remain deferred (see manage-pos.ts).

type PosSaleItemType = "service" | "product" | "prepaid" | "giftcard" | "package" | "giftbox" | "recharge";
type PosSaleItemStatus = "executed" | "prepaid" | "collected" | "ordered";

type PosSaleItem = {
  id: number;
  type: PosSaleItemType;
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  status: PosSaleItemStatus;
};

type PosPayment = { id: number; method: string; amount: number; giftcardId?: number };

type PosSale = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  locationId: number;
  items: PosSaleItem[];
  payments: PosPayment[];
  subtotal: number;
  discount: number;
  total: number;
  paidAmount: number;
  changeDue: number;
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt?: string;
  cancelReason?: string;
};

type CancelSummary = {
  products: Array<{ saleItemId: number; productId: number; name: string; qty: number }>;
  requiresStockDecision: boolean;
  giftcards: Array<{ id: number; code: string; status: string; balance: number; linkedSaleIds: number[] }>;
  giftboxes: Array<{ id: number; code: string; status: string; fullyRedeemed: boolean; redeemedItems: string[]; remainingItems: string[] }>;
  packages: Array<{ id: number; name: string; sessionsTotal: number; sessionsRemaining: number }>;
  prepaidServices: Array<{ id: number; name: string; purchasedQty: number; remainingQty: number }>;
  recharges: Array<{ id: number; totalAmount: number; earnedStorno: number; isVoid: boolean }>;
  installmentPlans: Array<{ id: number; status: string }>;
  creditRestored: number;
  giftcardResidualRefunded: number;
  giftcardResidualCode: string;
  pointsRestored: number;
  // SALE-level earned-points storno decision (present only when reversing would go negative).
  pointsStornoExtra: { current: number; usedRestore: number; earnedStorno: number; wouldBe: number } | null;
  // PER-recharge earned-points storno decisions.
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

type ReductionLine = { label: string; amount: number | null };

type InstallmentPlanView = {
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

type QuoteRef = { id: number; number: string; status: string; effectiveStatus: string; exists: boolean };

type PrepaidUsageEvent = {
  usageId: number;
  appointmentId: number;
  appointmentCode: string;
  appointmentStatus: string;
  qty: number;
  when: string;
  operator: string;
  isManual: boolean;
  canUndo: boolean;
  appointmentLink: string;
};

type PrepaidTracking = {
  saleItemId: number;
  prepaidId: number;
  title: string;
  serviceName: string;
  purchasedQty: number;
  remainingQty: number;
  freeQty: number;
  canExecute: boolean;
  note: string;
  usageHistory: PrepaidUsageEvent[];
};

type PreorderTracking = {
  saleItemId: number;
  productId: number;
  name: string;
  status: "ordered" | "collected";
  qty: number;
  collectMax: number;
  canCollect: boolean;
  stockNow: number;
  note: string;
};

type SaleDetail = {
  ok: boolean;
  sale: PosSale;
  operatorName: string;
  locationName: string;
  cancelSummary: CancelSummary;
  canCancel: boolean;
  canMarkCollected: boolean;
  reductions: ReductionLine[];
  notesClean: string;
  installmentPlan: InstallmentPlanView | null;
  quoteRef: QuoteRef | null;
  canDelete: boolean;
  prepaidTracking: PrepaidTracking[];
  preorderTracking: PreorderTracking[];
};

type BusinessHeader = { name: string; legalVatNumber: string; address: string; logoPath: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function saleIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const id = new URLSearchParams(window.location.search).get("id");
  const n = Number(id ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function fmtMoney(value: number): string {
  return Number(value || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  const d = value.slice(0, 10);
  const [y, mo, day] = d.split("-");
  return day && mo && y ? `${day}/${mo}/${y}` : value;
}

// Format a YYYY-MM-DD date as dd/mm/yyyy (installment schedule + next-due). "—" when empty.
function fmtDateOnly(value?: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Contanti",
  card: "Carta",
  check: "Assegno",
  transfer: "Bonifico",
  giftcard: "GiftCard",
  wallet: "Credito",
};

function paymentLabel(method: string | undefined): string {
  const key = String(method ?? "").toLowerCase();
  return PAYMENT_LABELS[key] ?? (key || "Pagamento");
}

// Per-item status badge — faithful to _pos_hist_item_status_badge (Eseguito / Prepagato /
// Ritirato / Ordinato). Only product/service lines with a stored status get a badge.
function itemStatusBadge(item: PosSaleItem): { cls: string; label: string } | null {
  if (item.type === "service") {
    if (item.status === "executed") return { cls: "text-bg-success", label: "Eseguito" };
    if (item.status === "prepaid") return { cls: "text-bg-info", label: "Prepagato" };
    return null;
  }
  if (item.type === "product") {
    if (item.status === "collected") return { cls: "text-bg-success", label: "Ritirato" };
    if (item.status === "ordered") return { cls: "text-bg-warning", label: "Ordinato" };
    return null;
  }
  return null;
}

// Badge + title for one prepaid usage timeline event — faithful to the legacy per-event
// badge (Eseguito for a manual execution, Utilizzato for an appointment redemption, and the
// terminal-appointment states No show / Annullata / Rifiutata).
function usageEventMeta(ev: PrepaidUsageEvent): { title: string; cls: string; label: string } {
  const status = ev.appointmentStatus.toLowerCase();
  if (ev.appointmentId > 0) {
    if (["no_show", "no show", "no-show", "noshow", "non presentato"].includes(status)) return { title: "Prenotazione No show", cls: "text-bg-warning", label: "No show" };
    if (["canceled", "cancelled", "annullato", "annullata"].includes(status)) return { title: "Prenotazione annullata", cls: "text-bg-secondary", label: "Annullata" };
    if (["rejected", "rifiutato"].includes(status)) return { title: "Prenotazione rifiutata", cls: "text-bg-secondary", label: "Rifiutata" };
    return { title: "Utilizzo collegato a prenotazione", cls: "text-bg-info", label: "Utilizzato" };
  }
  if (ev.isManual) return { title: "Esecuzione manuale", cls: "text-bg-success", label: "Eseguito" };
  return { title: "Utilizzo registrato", cls: "text-bg-secondary", label: "Utilizzato" };
}

// Group homogeneous sale lines for the view (same type + ref + name + unit price), faithful
// to _pos_hist_group_sale_items_for_view — collapses duplicate lines, sums qty/total, and
// keeps the (single) status when all grouped lines share it.
type GroupedItem = PosSaleItem & { statuses: Set<PosSaleItemStatus> };
function groupSaleItems(items: PosSaleItem[]): GroupedItem[] {
  const groups = new Map<string, GroupedItem>();
  const order: string[] = [];
  for (const it of items) {
    const key = [it.type, String(it.refId), it.name.trim().toLowerCase(), it.unitPrice.toFixed(4)].join("|");
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...it, quantity: it.quantity, total: it.total, statuses: new Set([it.status]) });
      order.push(key);
    } else {
      existing.quantity += it.quantity;
      existing.total = Math.round((existing.total + it.total) * 100) / 100;
      existing.statuses.add(it.status);
    }
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    // Collapse to a single status only when every grouped line agreed (else clear it so no
    // misleading badge shows on a mixed group).
    if (g.statuses.size > 1) g.status = "" as PosSaleItemStatus;
    return g;
  });
}

export function PosSaleDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [saleId] = useState<number>(() => saleIdFromUrl());
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [business, setBusiness] = useState<BusinessHeader | null>(null);
  // Start loading only when there is a valid id to fetch; an invalid id renders the error
  // branch immediately (no effect setState needed, keeping the load effect side-effect-free).
  const [loading, setLoading] = useState(() => saleIdFromUrl() > 0);
  const [error, setError] = useState(() => (saleIdFromUrl() > 0 ? "" : "Vendita non valida."));
  const [flash, setFlash] = useState("");

  // Cancel modal state.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [stockMode, setStockMode] = useState<"restore" | "no_restore">("restore");
  const [busy, setBusy] = useState(false);
  // Fidelity-points storno decisions. When a decision section appears the radio DEFAULTS to
  // "negative" (matching the legacy checked radio); an absent selection is treated as "negative".
  const [saleStornoMode, setSaleStornoMode] = useState<"negative" | "skip">("negative");
  const [rechargeStornoModes, setRechargeStornoModes] = useState<Record<number, "negative" | "skip">>({});

  // Delete modal state (hard-delete of an already-cancelled sale).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);

  // Receipt overlay.
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Per-line qty selections for the "Cronologia" cards: collect qty (product pickup) and
  // execute qty (prepaid manual execution), keyed by sale_item_id / prepaid_id.
  const [collectQty, setCollectQty] = useState<Record<number, number>>({});
  const [executeQty, setExecuteQty] = useState<Record<number, number>>({});

  // Reload trigger: cancel/pickup bump this to refetch the detail (instead of calling
  // setState synchronously inside the effect, the fetch + all setState live in the effect).
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!saleId) return;
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}&action=sale_detail&id=${saleId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: SaleDetail & { error?: string }) => {
        if (!active) return;
        if (j && j.ok && j.sale) {
          setDetail(j);
          setError("");
        } else {
          setError(j?.error || "Vendita non trovata.");
          setDetail(null);
        }
      })
      .catch(() => {
        if (active) setError("Errore di caricamento.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug, saleId, reloadKey]);

  // Business header for the printable receipt (reused from the main POS context).
  useEffect(() => {
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { business?: BusinessHeader }) => {
        if (active) setBusiness(j?.business ?? null);
      })
      .catch(() => {
        if (active) setBusiness(null);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const sale = detail?.sale ?? null;
  const summary = detail?.cancelSummary ?? null;
  const reductionLines = detail?.reductions ?? [];
  const isCancelled = sale?.status === "cancelled";
  const groupedItems = useMemo(() => (sale ? groupSaleItems(sale.items) : []), [sale]);
  const clientLabel = sale && sale.clientName && sale.clientName.trim() && sale.clientName.trim() !== "Cliente banco" ? sale.clientName : "Cliente occasionale";
  const backUrl = `/${encodeURIComponent(slug)}/pos_history`;

  // Ordered product lines that can still be picked up (only on a non-cancelled sale).
  const collectableItems = useMemo(
    () => (sale && !isCancelled ? sale.items.filter((it) => it.type === "product" && it.status === "ordered") : []),
    [sale, isCancelled],
  );

  // "Cronologia utilizzo / ritiro" data: prepaid usage timelines + per-product pickup state.
  const prepaidTracking = useMemo(() => (isCancelled ? [] : detail?.prepaidTracking ?? []), [detail, isCancelled]);
  const preorderTracking = useMemo(() => (isCancelled ? [] : detail?.preorderTracking ?? []), [detail, isCancelled]);
  const collectedProducts = useMemo(() => preorderTracking.filter((p) => p.status === "collected"), [preorderTracking]);
  const hasTracking = prepaidTracking.length > 0 || preorderTracking.length > 0;

  async function postAction(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; sale?: PosSale; cancelSummary?: CancelSummary }> {
    const res = await fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  async function confirmCancel() {
    if (!sale) return;
    const reason = cancelReason.trim();
    if (!reason) {
      setError("La motivazione e obbligatoria per annullare una vendita.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Fidelity-points storno modes. Sent ONLY as decided by the operator when the decision
      // section is shown; when no section appears the mode is omitted (server defaults "normal",
      // behaviour unchanged). Faithful to the legacy modal: shown → default "negative"; the
      // per-recharge object keys each recharge id whose section appears.
      const rechargeModes: Record<string, string> = {};
      for (const item of summary?.rechargePointStornoItems ?? []) {
        rechargeModes[String(item.id)] = rechargeStornoModes[item.id] ?? "negative";
      }
      const json = await postAction({
        action: "cancel",
        sale_id: String(sale.id),
        reason,
        stock_cancel_mode: summary?.requiresStockDecision ? stockMode : "none",
        ...(summary?.pointsStornoExtra ? { points_storno_mode: saleStornoMode } : {}),
        // JSON-encode the per-recharge map: postAction serialises the body as JSON and the
        // server's parseRequestBody flattens each top-level value to a string (an object would
        // become "[object Object]"), so send a JSON string that normalizeRechargePointsModes
        // parses back into the { rechargeId: mode } map.
        ...(summary && summary.rechargePointStornoItems.length > 0 ? { recharge_points_storno_mode: JSON.stringify(rechargeModes) } : {}),
      });
      if (json?.error) {
        setError(json.error);
      } else {
        setCancelOpen(false);
        setCancelReason("");
        setFlash("Vendita annullata.");
        load();
      }
    } catch {
      setError("Errore durante l'annullamento.");
    } finally {
      setBusy(false);
    }
  }

  async function markCollected(saleItemId: number, qty?: number) {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, string> = { action: "mark_collected", sale_id: String(sale.id), sale_item_id: String(saleItemId) };
      if (qty && qty > 0) payload.collect_qty = String(qty);
      const json = await postAction(payload);
      if (json?.error) {
        setError(json.error);
      } else {
        setFlash("Ritiro registrato.");
        load();
      }
    } catch {
      setError("Errore durante la registrazione del ritiro.");
    } finally {
      setBusy(false);
    }
  }

  async function undoCollected(saleItemId: number) {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      const json = await postAction({ action: "undo_collected", sale_id: String(sale.id), sale_item_id: String(saleItemId) });
      if (json?.error) setError(json.error);
      else {
        setFlash("Ritiro rimosso. Il prodotto e tornato in Preordini.");
        load();
      }
    } catch {
      setError("Errore durante la rimozione del ritiro.");
    } finally {
      setBusy(false);
    }
  }

  async function prepaidExecute(prepaidId: number, qty: number) {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      const json = await postAction({ action: "prepaid_manual_execute", sale_id: String(sale.id), prepaid_id: String(prepaidId), execute_qty: String(Math.max(1, qty)) });
      if (json?.error) setError(json.error);
      else {
        setFlash("Servizio segnato come eseguito. Residuo aggiornato.");
        load();
      }
    } catch {
      setError("Errore durante l'esecuzione manuale.");
    } finally {
      setBusy(false);
    }
  }

  async function prepaidUndo(usageId: number) {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      const json = await postAction({ action: "prepaid_manual_undo", sale_id: String(sale.id), usage_id: String(usageId) });
      if (json?.error) setError(json.error);
      else {
        setFlash("Esecuzione manuale annullata. Residuo ripristinato.");
        load();
      }
    } catch {
      setError("Errore durante l'annullamento dell'esecuzione.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!sale) return;
    setBusy(true);
    setError("");
    try {
      const json = await postAction({ action: "delete_sale", sale_id: String(sale.id) });
      if (json?.error) {
        setError(json.error);
      } else {
        setDeleteOpen(false);
        setDeleted(true);
        setFlash("Vendita annullata eliminata definitivamente.");
      }
    } catch {
      setError("Errore durante l'eliminazione della vendita.");
    } finally {
      setBusy(false);
    }
  }

  function printReceipt() {
    try {
      window.print();
    } catch {
      // window.print can be unavailable in embedded contexts — no-op.
    }
  }

  return (
    <div className="container-fluid py-3">
      <link rel="stylesheet" href="/assets/css/pages/pos_history.css" />
      <link rel="stylesheet" href="/assets/css/pages/pos_sale_detail.css" />

      {loading ? (
        <div className="text-muted py-4">Caricamento…</div>
      ) : deleted ? (
        <div className="card p-3">
          <div className="alert alert-success mb-0">Vendita annullata eliminata definitivamente.</div>
          <div className="mt-3">
            <a className="btn btn-sm btn-outline-primary" href={backUrl}>
              <i className="bi bi-x-lg me-1"></i>Torna ai movimenti
            </a>
          </div>
        </div>
      ) : !sale ? (
        <div className="card p-3">
          <div className="alert alert-danger mb-0">{error || "Vendita non trovata."}</div>
          <div className="mt-3">
            <a className="btn btn-sm btn-outline-primary" href={backUrl}>
              <i className="bi bi-x-lg me-1"></i>Chiudi
            </a>
          </div>
        </div>
      ) : (
        <>
          {flash ? <div className="alert alert-success py-2">{flash}</div> : null}
          {error ? <div className="alert alert-danger py-2">{error}</div> : null}

          {/* Header card: code, date/time, client (or "Cliente occasionale"), operator,
              location, status badge + actions (Annulla vendita / Stampa scontrino). */}
          <div className="card p-3 mb-3">
            <div className="d-flex align-items-start justify-content-between gap-3 flex-wrap">
              <div>
                <div className="h5 fw-semibold mb-1">Dettaglio vendita #{sale.id}</div>
                <div className="text-muted small">
                  Data: <strong>{fmtDateTime(sale.createdAt)}</strong>
                  {" • "}Cliente: <strong>{clientLabel}</strong>
                  {detail?.locationName ? (
                    <>
                      {" • "}Sede: <strong>{detail.locationName}</strong>
                    </>
                  ) : null}
                  {detail?.operatorName && detail.operatorName !== "—" ? (
                    <>
                      {" • "}Operatore: <strong>{detail.operatorName}</strong>
                    </>
                  ) : null}
                  {detail?.quoteRef && detail.quoteRef.id > 0 ? (
                    <>
                      {" • "}Preventivo: <strong>#{detail.quoteRef.number || String(detail.quoteRef.id)}</strong>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="d-flex align-items-center gap-2 flex-wrap">
                {isCancelled ? <span className="badge text-bg-danger">Annullata</span> : <span className="badge text-bg-success">Attiva</span>}
                {detail?.quoteRef && detail.quoteRef.id > 0 && detail.quoteRef.exists ? (
                  <a
                    className="btn btn-sm btn-outline-success"
                    href={`/${encodeURIComponent(slug)}/quotes?action=view&id=${detail.quoteRef.id}`}
                  >
                    <i className="bi bi-file-earmark-text me-1"></i>Preventivo
                  </a>
                ) : null}
                <a className="btn btn-sm btn-outline-primary" href={backUrl}>
                  <i className="bi bi-x-lg me-1"></i>Chiudi
                </a>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setReceiptOpen(true)}>
                  <i className="bi bi-printer me-1"></i>Stampa scontrino
                </button>
                {!isCancelled ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      setCancelOpen(true);
                      setError("");
                    }}
                  >
                    <i className="bi bi-x-circle me-1"></i>Annulla vendita
                  </button>
                ) : null}
                {/* "Elimina vendita": permanent hard-delete, shown ONLY when the sale is
                    already cancelled (faithful to the legacy delete_cancelled_sale button). */}
                {isCancelled && detail?.canDelete ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => {
                      setDeleteOpen(true);
                      setError("");
                    }}
                  >
                    <i className="bi bi-trash me-1"></i>Elimina vendita
                  </button>
                ) : null}
              </div>
            </div>

            {/* Cancellation metadata when cancelled. */}
            {isCancelled ? (
              <div className="mt-3">
                <div className="fw-semibold mb-2">Stato annullamento</div>
                <div className="row g-3">
                  <div className="col-12 col-md-4">
                    <div className="small text-muted">Data annullamento</div>
                    <div className="fw-semibold">{sale.cancelledAt ? fmtDateTime(sale.cancelledAt) : "—"}</div>
                  </div>
                  <div className="col-12 col-md-8">
                    <div className="small text-muted">Motivo</div>
                    <div className="fw-semibold">{sale.cancelReason || "—"}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* "Gestione Rate": the installment plan attached to this sale — payment type,
              acconto (down payment), financed residuo, paid/open/overdue counts, next due,
              and the schedule rows. Faithful to pos_sale_detail.php ~4882-4941. */}
          {detail?.installmentPlan ? (
            <div className="card p-3 mb-3">
              <div className="border rounded p-3 pos-sale-installment-card">
                <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
                  <div>
                    <div className="fw-semibold">Gestione Rate</div>
                    <div className="small text-muted">Piano rate collegato a questa vendita.</div>
                  </div>
                  <span className={`badge ${detail.installmentPlan.statusBadge || "text-bg-primary"}`}>
                    {detail.installmentPlan.statusLabel || "Attivo"}
                  </span>
                </div>
                <div className="row g-3">
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Pagamento</div>
                    <div className="fw-semibold">{detail.installmentPlan.paymentTypeLabel || "—"}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Acconto incassato</div>
                    <div className="fw-semibold">€ {fmtMoney(detail.installmentPlan.downPayment)}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Residuo</div>
                    <div className="fw-semibold">€ {fmtMoney(detail.installmentPlan.remaining)}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Frequenza</div>
                    <div className="fw-semibold">{detail.installmentPlan.frequencyLabel || "—"}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Rate pagate</div>
                    <div className="fw-semibold">{detail.installmentPlan.paidCount}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Rate aperte</div>
                    <div className="fw-semibold">{detail.installmentPlan.pendingCount}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Rate scadute</div>
                    <div className="fw-semibold">{detail.installmentPlan.overdueCount}</div>
                  </div>
                  <div className="col-12 col-md-3">
                    <div className="small text-muted">Prossima scadenza</div>
                    <div className="fw-semibold">{fmtDateOnly(detail.installmentPlan.nextDueDate)}</div>
                  </div>
                  {detail.installmentPlan.notes.trim() ? (
                    <div className="col-12">
                      <div className="small text-muted">Note piano</div>
                      <div className="fw-semibold" style={{ whiteSpace: "pre-line" }}>
                        {detail.installmentPlan.notes}
                      </div>
                    </div>
                  ) : null}
                </div>
                {detail.installmentPlan.rows.length > 0 ? (
                  <div className="table-responsive mt-3">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Scadenza</th>
                          <th className="text-end">Importo</th>
                          <th className="text-end">Incassato</th>
                          <th>Stato</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.installmentPlan.rows.map((r) => (
                          <tr key={r.installmentNo}>
                            <td>{r.installmentNo}</td>
                            <td>{fmtDateOnly(r.dueDate)}</td>
                            <td className="text-end">€ {fmtMoney(r.amount)}</td>
                            <td className="text-end">{r.paidAmount !== null ? `€ ${fmtMoney(r.paidAmount)}` : "—"}</td>
                            <td>
                              <span className={`badge ${r.statusBadge || "text-bg-warning"}`}>{r.statusLabel}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* "Segna ritirato": ordered product lines awaiting pickup (with partial-qty selector). */}
          {collectableItems.length > 0 ? (
            <div className="card p-3 mb-3">
              <div className="fw-semibold mb-1">Ritiro prodotti ordinati</div>
              <div className="small text-muted mb-2">Prodotti in attesa di ritiro collegati a questa vendita.</div>
              <div className="d-flex flex-column gap-2">
                {collectableItems.map((it) => {
                  const track = preorderTracking.find((p) => p.saleItemId === it.id && p.status === "ordered");
                  const lineQty = Math.max(1, Math.round(it.quantity));
                  const collectMax = track ? Math.max(0, track.collectMax) : lineQty;
                  const canCollect = track ? track.canCollect : true;
                  const chosen = Math.max(1, Math.min(collectMax > 0 ? collectMax : 1, collectQty[it.id] ?? (collectMax > 0 ? collectMax : 1)));
                  return (
                    <div key={it.id} className="border rounded p-2 d-flex flex-wrap align-items-center justify-content-between gap-2">
                      <div>
                        <span className="fw-semibold">{it.name}</span>
                        <span className="text-muted small ms-2">x{lineQty}</span>
                        <span className="badge text-bg-warning ms-2">Ordinato</span>
                        {track?.note ? <div className={`small mt-1 ${!canCollect ? "text-danger" : collectMax < lineQty ? "text-warning" : "text-muted"}`}>{track.note}</div> : null}
                      </div>
                      <div className="d-flex align-items-center gap-2">
                        {lineQty > 1 ? (
                          <input
                            type="number"
                            className="form-control form-control-sm text-end"
                            style={{ width: "5rem" }}
                            min={1}
                            max={Math.max(1, collectMax)}
                            step={1}
                            value={chosen}
                            disabled={busy || !canCollect}
                            onChange={(e) => setCollectQty((m) => ({ ...m, [it.id]: Math.max(1, Math.min(Math.max(1, collectMax), Math.round(Number(e.target.value) || 1))) }))}
                          />
                        ) : null}
                        <button type="button" className="btn btn-sm btn-success" disabled={busy || !canCollect} onClick={() => markCollected(it.id, lineQty > 1 ? chosen : undefined)}>
                          <i className="bi bi-check2-circle me-1"></i>Segna ritirato
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* "Cronologia utilizzo / ritiro": prepaid usage timelines + collected-pickup undo. */}
          {hasTracking ? (
            <div className="card p-3 mb-3">
              <div className="fw-semibold mb-1">Cronologia utilizzo / ritiro</div>
              <div className="small text-muted mb-2">Servizi prepagati e prodotti collegati a questa vendita.</div>
              <div className="row g-3">
                {prepaidTracking.map((card) => {
                  const chosen = Math.max(1, Math.min(card.freeQty > 0 ? card.freeQty : 1, executeQty[card.prepaidId] ?? 1));
                  return (
                    <div className="col-12 col-xl-6" key={`pp-${card.prepaidId}`}>
                      <div className="border rounded p-3 h-100">
                        <div className="d-flex align-items-start justify-content-between gap-3">
                          <div>
                            <div className="fw-semibold">{card.title}</div>
                            <div className="small text-muted">Servizio prepagato</div>
                          </div>
                          <span className="badge rounded-pill text-bg-info">Prepagato</span>
                        </div>
                        <div className="small text-muted mt-2">Prepagato #{card.prepaidId} • Residuo {card.remainingQty}/{card.purchasedQty}</div>

                        {/* Residuo libero: manual-execution qty spinner + "Segna eseguito". */}
                        <div className="border rounded p-2 bg-light mt-2">
                          <div className="small text-muted mb-2">Residuo libero {card.freeQty} su {card.remainingQty}</div>
                          <div className="d-flex flex-wrap align-items-center gap-2">
                            {card.freeQty > 1 ? (
                              <input
                                type="number"
                                className="form-control form-control-sm text-end"
                                style={{ width: "5rem" }}
                                min={1}
                                max={card.freeQty}
                                step={1}
                                value={chosen}
                                disabled={busy || !card.canExecute}
                                onChange={(e) => setExecuteQty((m) => ({ ...m, [card.prepaidId]: Math.max(1, Math.min(card.freeQty, Math.round(Number(e.target.value) || 1))) }))}
                              />
                            ) : null}
                            <button type="button" className="btn btn-sm btn-success" disabled={busy || !card.canExecute} onClick={() => prepaidExecute(card.prepaidId, card.freeQty > 1 ? chosen : 1)}>
                              <i className="bi bi-check2-circle me-1"></i>Segna eseguito
                            </button>
                          </div>
                          {card.note ? <div className={`small mt-2 ${!card.canExecute ? "text-danger" : "text-muted"}`}>{card.note}</div> : null}
                        </div>

                        {/* Usage timeline (newest-first) with per-manual "Annulla esecuzione". */}
                        {card.usageHistory.length > 0 ? (
                          <div className="mt-3">
                            {card.usageHistory.map((ev, idx) => {
                              const meta = usageEventMeta(ev);
                              const isLast = idx === card.usageHistory.length - 1;
                              return (
                                <div key={`ev-${card.prepaidId}-${ev.usageId || ev.appointmentId || idx}`} className={`border-start ps-3 ms-1${isLast ? "" : " pb-3"}`}>
                                  <div className="small text-muted mb-1">{fmtDateTime(ev.when)}</div>
                                  <div className="d-flex flex-wrap align-items-center gap-2">
                                    <div className="fw-semibold">{meta.title}</div>
                                    <span className={`badge rounded-pill ${meta.cls}`}>{meta.label}</span>
                                  </div>
                                  <div className="small mt-1">
                                    Qta {ev.qty}
                                    {ev.appointmentId > 0 ? ` • ${ev.appointmentCode ? `Codice prenotazione ${ev.appointmentCode}` : `Prenotazione ID ${ev.appointmentId}`}` : ""}
                                  </div>
                                  {ev.operator ? <div className="small text-muted mt-1">Operatore: {ev.operator}</div> : null}
                                  {ev.appointmentId > 0 && ev.appointmentLink ? (
                                    <div className="mt-2">
                                      <a className="btn btn-sm btn-outline-primary" href={ev.appointmentLink}><i className="bi bi-box-arrow-up-right me-1"></i>Apri prenotazione</a>
                                    </div>
                                  ) : null}
                                  {ev.canUndo ? (
                                    <div className="mt-2">
                                      <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => prepaidUndo(ev.usageId)}>
                                        <i className="bi bi-arrow-counterclockwise me-1"></i>Annulla esecuzione
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="small text-muted mt-3">Nessun utilizzo registrato.</div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {collectedProducts.map((p) => (
                  <div className="col-12 col-xl-6" key={`cp-${p.saleItemId}`}>
                    <div className="border rounded p-3 h-100">
                      <div className="d-flex align-items-start justify-content-between gap-3">
                        <div>
                          <div className="fw-semibold">{p.name}</div>
                          <div className="small text-muted">Prodotto ritirato • Qtà {p.qty}</div>
                        </div>
                        <span className="badge rounded-pill text-bg-success">Ritirato</span>
                      </div>
                      <div className="border rounded p-2 bg-light mt-2 d-flex flex-wrap align-items-center justify-content-between gap-2">
                        <div className="small text-muted">Ritiro registrato • Qtà {p.qty}</div>
                        <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => undoCollected(p.saleItemId)}>
                          <i className="bi bi-arrow-counterclockwise me-1"></i>Rimuovi ritiro
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Riepilogo vendita: grouped items + status badges, and the totals panel. */}
          <div className="card p-3 mb-3">
            <div className="border rounded p-3 sale-summary-box">
              <div className="sale-summary-heading mb-2">
                <div className="fw-semibold">Riepilogo vendita</div>
              </div>
              <div className="row g-3">
                <div className="col-12 col-lg-7">
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Elemento</th>
                          <th className="text-end">Qtà</th>
                          <th className="text-end">Prezzo</th>
                          <th className="text-end">Totale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupedItems.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="text-muted">
                              Nessun dettaglio righe disponibile.
                            </td>
                          </tr>
                        ) : (
                          groupedItems.map((it, idx) => {
                            const badge = itemStatusBadge(it);
                            return (
                              <tr key={`${it.type}-${it.refId}-${idx}`}>
                                <td>
                                  <div className="fw-semibold">
                                    {it.name || "—"}
                                    {badge ? <span className={`badge rounded-pill ms-2 ${badge.cls}`}>{badge.label}</span> : null}
                                  </div>
                                </td>
                                <td className="text-end">{it.quantity}</td>
                                <td className="text-end">€ {fmtMoney(it.unitPrice)}</td>
                                <td className="text-end fw-semibold">€ {fmtMoney(it.total)}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="col-12 col-lg-5">
                  <div className="sale-total-panel">
                    <div className="d-flex justify-content-between gap-3">
                      <span>Subtotale</span>
                      <strong>€ {fmtMoney(sale.subtotal)}</strong>
                    </div>
                    {/* Itemized reductions (promo/coupon/manual/fidelity/giftcard/credit/…),
                        each with its € amount. Faithful to the legacy totals breakdown; falls
                        back to a single "Riduzioni" line when no itemized data is available. */}
                    {reductionLines.length > 0 ? (
                      reductionLines.map((red, i) => (
                        <div className="d-flex justify-content-between gap-3 text-muted" key={i}>
                          <span>{red.label || "Riduzione"}</span>
                          <span>{red.amount !== null ? `- € ${fmtMoney(red.amount)}` : "—"}</span>
                        </div>
                      ))
                    ) : sale.discount > 0.00001 ? (
                      <div className="d-flex justify-content-between gap-3 text-muted">
                        <span>Riduzioni</span>
                        <span>- € {fmtMoney(sale.discount)}</span>
                      </div>
                    ) : null}
                    <hr className="my-2" />
                    <div className="d-flex justify-content-between gap-3 fs-5">
                      <span>Totale</span>
                      <strong>€ {fmtMoney(sale.total)}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Payments breakdown. */}
            <div className="border rounded p-3 mt-3">
              <div className="fw-semibold mb-2">Pagamento</div>
              {sale.payments.filter((p) => Number(p.amount ?? 0) > 0).length === 0 ? (
                <div className="text-muted small">Nessun pagamento registrato.</div>
              ) : (
                sale.payments
                  .filter((p) => Number(p.amount ?? 0) > 0)
                  .map((p, idx) => (
                    <div className="d-flex justify-content-between small" key={p.id ?? idx}>
                      <span className="text-muted">{paymentLabel(p.method)}</span>
                      <span>€ {fmtMoney(p.amount)}</span>
                    </div>
                  ))
              )}
            </div>
          </div>

          {/* Cancel modal: summary of what is cancelled/restored, blockers, stock decision,
              required reason. Faithful to the legacy cancelSaleModal. */}
          {cancelOpen ? (
            <div className="pos-sale-cancel-overlay" role="dialog" aria-modal="true" aria-label="Annulla vendita">
              <style>{`
                .pos-sale-cancel-overlay { position: fixed; inset: 0; z-index: 1080; display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 1.5rem; background: rgba(15,23,42,.55); }
                .pos-sale-cancel-dialog { width: 100%; max-width: 560px; margin: auto; }
              `}</style>
              <div className="pos-sale-cancel-dialog card p-3">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="h6 fw-semibold mb-0">Annulla vendita #{sale.id}</div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setCancelOpen(false)}></button>
                </div>

                {summary && summary.blockers.length > 0 ? (
                  <div className="alert alert-danger">
                    <div className="fw-semibold mb-1">Annullamento non consentito</div>
                    <ul className="mb-0 ps-3">
                      {summary.blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {summary && summary.summary.length > 0 ? (
                  <div className="mb-2">
                    <div className="small text-muted mb-1">Verranno annullati / ripristinati:</div>
                    <ul className="small mb-0 ps-3">
                      {summary.summary.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {summary && summary.warnings.length > 0 ? (
                  <div className="alert alert-warning py-2">
                    <ul className="small mb-0 ps-3">
                      {summary.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {summary && summary.requiresStockDecision ? (
                  <div className="mb-2">
                    <div className="small fw-semibold mb-1">Magazzino prodotti</div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="stockMode"
                        id="stockRestore"
                        checked={stockMode === "restore"}
                        onChange={() => setStockMode("restore")}
                      />
                      <label className="form-check-label" htmlFor="stockRestore">
                        Ripristina la giacenza dei prodotti
                      </label>
                    </div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="stockMode"
                        id="stockNoRestore"
                        checked={stockMode === "no_restore"}
                        onChange={() => setStockMode("no_restore")}
                      />
                      <label className="form-check-label" htmlFor="stockNoRestore">
                        Non ripristinare la giacenza
                      </label>
                    </div>
                  </div>
                ) : null}

                {/* PER-recharge fidelity-points storno decisions (port of pos_sale_detail.php
                    ~5953-6019). One block per recharge whose earned-points storno would push the
                    projected balance negative; radios default to "negative" (storna comunque). */}
                {summary && summary.rechargePointStornoItems.length > 0 ? (
                  <div className="mb-2">
                    <div className="alert alert-warning py-2 mb-2">
                      <div className="fw-semibold mb-1">Disponibile insufficiente per lo storno dei punti ricarica</div>
                      <div className="small">
                        Almeno una ricarica di questa vendita ha punti Fidelity accreditati che non sono piu completamente disponibili per lo storno.
                        Puoi stornare comunque i punti portando il saldo disponibile in negativo oppure completare l&apos;annullamento senza stornare i punti guadagnati da quella ricarica.
                      </div>
                    </div>
                    {summary.rechargePointStornoItems.map((item) => {
                      const mode = rechargeStornoModes[item.id] ?? "negative";
                      return (
                        <div className="border rounded p-2 mb-2 bg-light-subtle" key={item.id}>
                          <div className="fw-semibold small">{item.label} — punti Fidelity ricarica</div>
                          <div className="small text-muted mb-2">
                            Credito ricarica: <strong>€ {fmtMoney(item.totalAmount)}</strong>
                            {" • "}
                            {item.isProjected ? "Saldo stimato prima di questo storno" : "Saldo totale"}: <strong>{item.current} pt</strong>
                            {" • "}Storno: <strong>-{item.earnedStorno} pt</strong>
                            {" • "}Saldo finale: <strong>{item.wouldBe} pt</strong>
                          </div>
                          <div className="form-check">
                            <input
                              className="form-check-input"
                              type="radio"
                              name={`rechargePtsMode_${item.id}`}
                              id={`rechargePtsNeg_${item.id}`}
                              checked={mode === "negative"}
                              onChange={() => setRechargeStornoModes((prev) => ({ ...prev, [item.id]: "negative" }))}
                            />
                            <label className="form-check-label small" htmlFor={`rechargePtsNeg_${item.id}`}>
                              Porta il disponibile punti in negativo (storna comunque)
                            </label>
                          </div>
                          <div className="form-check">
                            <input
                              className="form-check-input"
                              type="radio"
                              name={`rechargePtsMode_${item.id}`}
                              id={`rechargePtsSkip_${item.id}`}
                              checked={mode === "skip"}
                              onChange={() => setRechargeStornoModes((prev) => ({ ...prev, [item.id]: "skip" }))}
                            />
                            <label className="form-check-label small" htmlFor={`rechargePtsSkip_${item.id}`}>
                              Procedi con l&apos;annullamento senza scalare i punti guadagnati da {item.label}
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {/* SALE-level fidelity-points storno decision (port of pos_sale_detail.php
                    ~6025-6077). Shown only when reversing the sale's earned points would push the
                    balance negative; radio defaults to "negative". */}
                {summary && summary.pointsStornoExtra ? (
                  <div className="mb-2">
                    <div className="alert alert-warning py-2 mb-2">
                      <div className="fw-semibold mb-1">Disponibile insufficiente per lo storno dei punti Fidelity</div>
                      <div className="small">
                        Il cliente non ha piu disponibilita libera sufficiente per stornare punti Fidelity guadagnati con questa vendita.
                        Puoi compensare lo storno con eventuali importi usati come sconto e, se non basta, portare il disponibile in negativo. In alternativa puoi annullare senza scalare i punti guadagnati.
                      </div>
                    </div>
                    <div className="small fw-semibold mb-1">Punti Fidelity vendita</div>
                    <div className="small text-muted mb-2">
                      Saldo totale: <strong>{summary.pointsStornoExtra.current} pt</strong>
                      {summary.pointsStornoExtra.usedRestore > 0 ? (
                        <> {" • "}Ripristino: <strong>+{summary.pointsStornoExtra.usedRestore} pt</strong></>
                      ) : null}
                      {" • "}Storno: <strong>-{summary.pointsStornoExtra.earnedStorno} pt</strong>
                      {" • "}Saldo finale: <strong>{summary.pointsStornoExtra.wouldBe} pt</strong>
                    </div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="saleStornoMode"
                        id="saleStornoNeg"
                        checked={saleStornoMode === "negative"}
                        onChange={() => setSaleStornoMode("negative")}
                      />
                      <label className="form-check-label small" htmlFor="saleStornoNeg">
                        {summary.pointsStornoExtra.usedRestore > 0
                          ? "Porta il disponibile punti in negativo (compensa anche con i punti ripristinati)"
                          : "Porta il disponibile punti in negativo (storna comunque)"}
                      </label>
                    </div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="saleStornoMode"
                        id="saleStornoSkip"
                        checked={saleStornoMode === "skip"}
                        onChange={() => setSaleStornoMode("skip")}
                      />
                      <label className="form-check-label small" htmlFor="saleStornoSkip">
                        Procedi con l&apos;annullamento senza scalare i punti guadagnati
                      </label>
                    </div>
                  </div>
                ) : null}

                <div className="mb-2">
                  <label className="form-label small fw-semibold" htmlFor="cancelReason">
                    Motivo (obbligatorio)
                  </label>
                  <textarea
                    id="cancelReason"
                    className="form-control form-control-sm"
                    rows={2}
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    disabled={Boolean(summary && summary.blockers.length > 0)}
                  />
                </div>

                <div className="d-flex justify-content-end gap-2">
                  <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setCancelOpen(false)}>
                    Indietro
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy || Boolean(summary && summary.blockers.length > 0) || !cancelReason.trim()}
                    onClick={confirmCancel}
                  >
                    <i className="bi bi-x-circle me-1"></i>Conferma annullamento
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Delete confirm modal: permanent hard-delete of an already-cancelled sale.
              Faithful to the legacy deleteCancelledSaleModal — a clear irreversible warning
              + what gets removed (sale + installment plan/rows + audit). */}
          {deleteOpen ? (
            <div className="pos-sale-cancel-overlay" role="dialog" aria-modal="true" aria-label="Elimina vendita">
              <style>{`
                .pos-sale-cancel-overlay { position: fixed; inset: 0; z-index: 1080; display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 1.5rem; background: rgba(15,23,42,.55); }
                .pos-sale-cancel-dialog { width: 100%; max-width: 560px; margin: auto; }
              `}</style>
              <div className="pos-sale-cancel-dialog card p-3">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="h6 fw-semibold mb-0">Elimina vendita #{sale.id}</div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteOpen(false)}></button>
                </div>
                <div className="alert alert-danger">
                  <div className="fw-semibold mb-1">Operazione irreversibile</div>
                  <div className="small">
                    La vendita annullata verrà eliminata definitivamente insieme alle sue righe.
                  </div>
                </div>
                <div className="mb-2">
                  <div className="small text-muted mb-1">Verranno rimossi:</div>
                  <ul className="small mb-0 ps-3">
                    <li>La vendita #{sale.id} e le sue righe.</li>
                    {detail?.installmentPlan ? (
                      <li>
                        Il piano rate collegato ({detail.installmentPlan.paymentTypeLabel || "Pagamento"} • residuo € {fmtMoney(detail.installmentPlan.remaining)}
                        {detail.installmentPlan.paidCount > 0 ? ` • rate incassate: ${detail.installmentPlan.paidCount}` : ""}).
                      </li>
                    ) : null}
                    <li>Le scelte magazzino e gli eventi collegati.</li>
                  </ul>
                </div>
                <div className="d-flex justify-content-end gap-2">
                  <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDeleteOpen(false)}>
                    Indietro
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={confirmDelete}>
                    <i className="bi bi-trash me-1"></i>Elimina definitivamente
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Printable receipt (scontrino): reuses the pos-content approach — a scoped @media
              print rule isolates the receipt so only it prints. */}
          {receiptOpen ? (
            <div className="pos-receipt-overlay" role="dialog" aria-modal="true" aria-label="Ricevuta vendita">
              <style>{`
                .pos-receipt-overlay { position: fixed; inset: 0; z-index: 1080; display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 1.5rem; background: rgba(15,23,42,.55); }
                .pos-receipt { width: 100%; max-width: 460px; margin: auto; background: #fff; border-radius: .5rem; }
                @media print {
                  body * { visibility: hidden !important; }
                  .pos-receipt-overlay, .pos-receipt-overlay * { visibility: visible !important; }
                  .pos-receipt-overlay { position: absolute !important; inset: 0 !important; background: #fff !important; padding: 0 !important; overflow: visible !important; }
                  .pos-receipt { box-shadow: none !important; border: 0 !important; max-width: none !important; margin: 0 !important; }
                  .pos-receipt-actions { display: none !important; }
                }
              `}</style>
              <div className="pos-receipt card p-4">
                <div className="text-center mb-3">
                  {business?.logoPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={business.logoPath} alt="" className="mb-2" style={{ maxHeight: 64, maxWidth: 180, objectFit: "contain" }} />
                  ) : null}
                  <div className="h5 mb-0 fw-bold">{business?.name || "—"}</div>
                  {business?.legalVatNumber ? <div className="small text-muted">P.IVA {business.legalVatNumber}</div> : null}
                  {business?.address ? <div className="small text-muted">{business.address}</div> : null}
                </div>
                <hr />
                <div className="d-flex justify-content-between align-items-start mb-2">
                  <div>
                    <div className="fw-semibold">{sale.code || `#${sale.id}`}</div>
                    <div className="text-muted small">{fmtDateTime(sale.createdAt)}</div>
                  </div>
                  <div className="text-end small">
                    <div className="text-muted">Cliente</div>
                    <div className="fw-semibold">{clientLabel}</div>
                  </div>
                </div>
                <div className="table-responsive mt-2">
                  <table className="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Elemento</th>
                        <th className="text-end">Q.tà</th>
                        <th className="text-end">Prezzo</th>
                        <th className="text-end">Totale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedItems.map((it, idx) => (
                        <tr key={`r-${idx}`}>
                          <td>{it.name || "Elemento"}</td>
                          <td className="text-end">{it.quantity}</td>
                          <td className="text-end">€ {fmtMoney(it.unitPrice)}</td>
                          <td className="text-end fw-semibold">€ {fmtMoney(it.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <hr />
                <div className="d-flex justify-content-between">
                  <span className="text-muted">Subtotale</span>
                  <span>€ {fmtMoney(sale.subtotal)}</span>
                </div>
                {reductionLines.length > 0 ? (
                  reductionLines.map((red, i) => (
                    <div className="d-flex justify-content-between text-muted small mt-1" key={`rr-${i}`}>
                      <span>{red.label || "Riduzione"}</span>
                      <span className="text-danger">{red.amount !== null ? `- € ${fmtMoney(red.amount)}` : "—"}</span>
                    </div>
                  ))
                ) : sale.discount > 0.00001 ? (
                  <div className="d-flex justify-content-between text-muted small mt-1">
                    <span>Riduzioni</span>
                    <span className="text-danger">- € {fmtMoney(sale.discount)}</span>
                  </div>
                ) : null}
                <hr />
                <div className="d-flex justify-content-between">
                  <span className="fw-semibold">Totale</span>
                  <span className="fw-semibold">€ {fmtMoney(sale.total)}</span>
                </div>
                <div className="mt-3">
                  <div className="fw-semibold mb-1">Pagamento</div>
                  {sale.payments
                    .filter((p) => Number(p.amount ?? 0) > 0)
                    .map((p, idx) => (
                      <div className="d-flex justify-content-between small" key={`rp-${idx}`}>
                        <span className="text-muted">{paymentLabel(p.method)}</span>
                        <span>€ {fmtMoney(p.amount)}</span>
                      </div>
                    ))}
                </div>
                <div className="pos-receipt-actions d-flex gap-2 justify-content-end mt-4">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setReceiptOpen(false)}>
                    Chiudi
                  </button>
                  <button type="button" className="btn btn-primary" onClick={printReceipt}>
                    <i className="bi bi-printer me-1"></i>Stampa scontrino
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
