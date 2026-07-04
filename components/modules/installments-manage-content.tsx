"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP installments page (app/pages/installments_manage.php).
// Backed by the DB-backed /api/manage/installments route:
//   GET  ?status=&client_id=&q=&due_from=&due_to=  -> { ok, plans: InstallmentPlan[] }
//        (status accepts the synthetic values open|overdue|paid|active|completed|cancelled|all)
//   POST action=mark_paid    { installment_id, paid_amount?, paid_at?, payment_type?, note? }
//   POST action=mark_pending { installment_id }
//   POST action=cancel       { plan_id, reason?, allow_paid? }  (allow_paid "1" forces past a paid rata)
//   each returns { ok, plan, plans } — state is refreshed from the returned `plans`.
//
// SCOPE: location scoping is out of scope (the legacy all_locations filter / per-sede columns are
// ignored — the API already scopes by tenant). The legacy schedule renders the plan down-payment as
// an informational first line (the Next model has no separate down-payment installment ROW).

type Installment = {
  id: number;
  installmentNo: number;
  dueDate: string;
  amount: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  paidAt?: string;
  paidAmount?: number;
  paymentType?: string;
  note?: string;
};

type InstallmentPlan = {
  id: number;
  saleId: number;
  clientId: number;
  clientName: string;
  saleDate?: string;
  total: number;
  paid: number;
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
  status: string;
  statusLabel: string;
  statusBadge: string;
  installments: Installment[];
  createdAt: string;
};

type Filters = {
  status: string;
  clientId: string;
  dueFrom: string;
  dueTo: string;
  q: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// "€ 1.234,56" style — mirrors the euro strings used across components/modules
// (fmtMoney in pos_sale_detail-content.tsx: it-IT with 2 fraction digits).
function fmtMoney(value: number): string {
  return Number(value || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// dd/mm/yyyy for a YYYY-MM-DD due date. "—" when empty.
function fmtDate(value?: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

// dd/mm/yyyy HH:mm for a timestamp (paid_at / cancelled_at). "—" when empty.
function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  return fmtDate(value);
}

// "now" as the value for a datetime-local input (YYYY-MM-DDTHH:mm), local time.
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "open", label: "Aperte" },
  { value: "overdue", label: "Scadute" },
  { value: "paid", label: "Completate" },
  { value: "all", label: "Tutte" },
  { value: "cancelled", label: "Annullate" },
];

const PAYMENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "cash", label: "Contanti" },
  { value: "card", label: "Carta" },
  { value: "check", label: "Assegno" },
  { value: "bank", label: "Bonifico" },
];

export function InstallmentsManageContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [filters, setFilters] = useState<Filters>({ status: "open", clientId: "", dueFrom: "", dueTo: "", q: "" });
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  // Whether the tenant has ANY installment plan at all (unfiltered). Drives the empty-state card.
  const [hasAnyPlans, setHasAnyPlans] = useState(true);
  // Distinct clients derived from every plan ever seen (for the client filter select).
  const [clientOptions, setClientOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number>(0);

  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Reload trigger: an action bumps this so the load effect re-fetches with the current filters.
  const [reloadKey, setReloadKey] = useState(0);

  // Per-pending-row inline form state (payment type + paid_at), keyed by installment id.
  const [payType, setPayType] = useState<Record<number, string>>({});
  const [payAt, setPayAt] = useState<Record<number, string>>({});
  const [payNote, setPayNote] = useState<Record<number, string>>({});

  // Cancel-plan state: pending force-confirm when the server refuses a plan with paid installments.


  // Load the filtered plan list. Faithful to searchPlans($filters): the status synthetic values are
  // resolved server-side, so pass them straight through.
  useEffect(() => {
    const params = new URLSearchParams({ slug });
    if (filters.status) params.set("status", filters.status);
    if (filters.clientId) params.set("client_id", filters.clientId);
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.dueFrom) params.set("due_from", filters.dueFrom);
    if (filters.dueTo) params.set("due_to", filters.dueTo);

    let active = true;
    fetch(`/api/manage/installments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { ok?: boolean; plans?: InstallmentPlan[] }) => {
        if (!active) return;
        const list = Array.isArray(j?.plans) ? j.plans : [];
        setPlans(list);
      })
      .catch(() => {
        if (active) setPlans([]);
      });
    return () => {
      active = false;
    };
  }, [slug, filters, reloadKey]);

  // Probe the UNFILTERED list once (status=all) to decide the empty-state and to seed the client
  // filter options — faithful to the legacy $hasAnyInstallmentPlansInScope + $clientFilterItems.
  useEffect(() => {
    let active = true;
    fetch(`/api/manage/installments?slug=${encodeURIComponent(slug)}&status=all`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { plans?: InstallmentPlan[] }) => {
        if (!active) return;
        const list = Array.isArray(j?.plans) ? j.plans : [];
        setHasAnyPlans(list.length > 0);
        const seen = new Map<number, string>();
        for (const p of list) {
          if (p.clientId > 0 && !seen.has(p.clientId)) seen.set(p.clientId, p.clientName || `Cliente #${p.clientId}`);
        }
        setClientOptions([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "it")));
      })
      .catch(() => {
        if (active) setHasAnyPlans(true);
      });
    return () => {
      active = false;
    };
  }, [slug, reloadKey]);

  // The selected plan: the explicitly-clicked one, else auto-select when the list has exactly one.
  const selectedPlan = useMemo<InstallmentPlan | null>(() => {
    if (selectedPlanId > 0) {
      const found = plans.find((p) => p.id === selectedPlanId);
      if (found) return found;
    }
    if (plans.length === 1) return plans[0];
    return null;
  }, [plans, selectedPlanId]);

  // KPI stats, computed over the (filtered) list — faithful to the legacy $stats loop:
  //  Piani aperti  = plans whose effective status is active OR overdue
  //  Rate scadute  = Σ overdueCount
  //  Incassato     = Σ collected
  //  Residuo attivo= Σ remaining over non-cancelled plans
  const stats = useMemo(() => {
    let activePlans = 0;
    let overdueInstallments = 0;
    let collectedTotal = 0;
    let remainingTotal = 0;
    for (const p of plans) {
      if (p.status === "active" || p.status === "overdue") activePlans += 1;
      overdueInstallments += p.overdueCount;
      collectedTotal += p.collected;
      if (p.status !== "cancelled") remainingTotal += p.remaining;
    }
    return { activePlans, overdueInstallments, collectedTotal, remainingTotal };
  }, [plans]);

  async function postAction(payload: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; plans?: InstallmentPlan[] }> {
    const res = await fetch(`/api/manage/installments?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  // Apply the refreshed `plans` returned by an action, keeping the selection (re-found by id).
  function applyResult(json: { plans?: InstallmentPlan[] }, keepPlanId: number) {
    const list = Array.isArray(json.plans) ? json.plans : [];
    setPlans(list);
    if (keepPlanId > 0) setSelectedPlanId(keepPlanId);
    // Refresh the empty-state / client-filter probe too (a cancelled plan can drop out of a filter).
    setReloadKey((k) => k + 1);
  }

  async function incassa(inst: Installment, planId: number) {
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const json = await postAction({
        action: "mark_paid",
        installment_id: String(inst.id),
        paid_amount: inst.amount.toFixed(2),
        paid_at: payAt[inst.id] || nowLocalInput(),
        payment_type: payType[inst.id] || inst.paymentType || "cash",
        note: payNote[inst.id] || "",
      });
      if (json?.error) setError(json.error);
      else {
        setFlash("Rata registrata");
        applyResult(json, planId);
      }
    } catch {
      setError("Operazione non completata.");
    } finally {
      setBusy(false);
    }
  }

  async function riapri(inst: Installment, planId: number) {
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const json = await postAction({ action: "mark_pending", installment_id: String(inst.id) });
      if (json?.error) setError(json.error);
      else {
        setFlash("Rata riaperta");
        applyResult(json, planId);
      }
    } catch {
      setError("Operazione non completata.");
    } finally {
      setBusy(false);
    }
  }


  const posUrl = `/${encodeURIComponent(slug)}/pos`;
  const historyUrl = `/${encodeURIComponent(slug)}/pos_history`;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/installments_manage.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pagamenti</div>
          <h1 className="bs-page-title">Gestione Rate</h1>
          <div className="bs-page-subtitle">Monitoraggio piani rateali, scadenze e incassi cliente.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary" href={historyUrl}>
              <i className="bi bi-clock-history me-1" />
              Movimenti
            </a>
            {hasAnyPlans ? (
              <a className="btn btn-outline-primary" href={posUrl}>
                <i className="bi bi-credit-card me-1" />
                Nuova vendita
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {!hasAnyPlans ? (
        <div className="card border-0 shadow-sm installments-empty-card">
          <div className="installments-empty-state">
            <div className="installments-empty-icon" aria-hidden="true">
              <i className="bi bi-cash-stack" />
            </div>
            <h2>Nessun piano rateale presente</h2>
            <p>La gestione rate &egrave; ancora vuota. Crea una vendita con pagamento rateizzato per iniziare.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={posUrl}>
                <i className="bi bi-credit-card me-1" />
                Nuova vendita
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* KPI cards. */}
          <div className="row g-3 mb-3">
            <div className="col-12 col-md-6 col-xl-3">
              <div className="installments-summary-card">
                <div className="text-muted small">Piani aperti</div>
                <div className="installments-summary-value">{stats.activePlans}</div>
              </div>
            </div>
            <div className="col-12 col-md-6 col-xl-3">
              <div className="installments-summary-card">
                <div className="text-muted small">Rate scadute</div>
                <div className="installments-summary-value">{stats.overdueInstallments}</div>
              </div>
            </div>
            <div className="col-12 col-md-6 col-xl-3">
              <div className="installments-summary-card">
                <div className="text-muted small">Incassato</div>
                <div className="installments-summary-value">&euro; {fmtMoney(stats.collectedTotal)}</div>
              </div>
            </div>
            <div className="col-12 col-md-6 col-xl-3">
              <div className="installments-summary-card">
                <div className="text-muted small">Residuo attivo</div>
                <div className="installments-summary-value">&euro; {fmtMoney(stats.remainingTotal)}</div>
              </div>
            </div>
          </div>

          {/* Filter card. Changing any control re-queries via the load effect. */}
          <div className="card installments-filter-card p-3 mb-3">
            <div className="row g-2 align-items-end installments-filter-form">
              <div className="col-12 col-lg-3">
                <label className="form-label small text-muted mb-1">Cliente</label>
                <select
                  className="form-select"
                  value={filters.clientId}
                  onChange={(e) => setFilters((f) => ({ ...f, clientId: e.target.value }))}
                >
                  <option value="">Tutti</option>
                  {clientOptions.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-12 col-md-4 col-lg-2">
                <label className="form-label small text-muted mb-1">Stato</label>
                <select
                  className="form-select"
                  value={filters.status}
                  onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-6 col-md-4 col-lg-2">
                <label className="form-label small text-muted mb-1">Da</label>
                <input
                  type="date"
                  className="form-control"
                  value={filters.dueFrom}
                  onChange={(e) => setFilters((f) => ({ ...f, dueFrom: e.target.value }))}
                />
              </div>
              <div className="col-6 col-md-4 col-lg-2">
                <label className="form-label small text-muted mb-1">A</label>
                <input
                  type="date"
                  className="form-control"
                  value={filters.dueTo}
                  onChange={(e) => setFilters((f) => ({ ...f, dueTo: e.target.value }))}
                />
              </div>
              <div className="col-12 col-lg-3">
                <label className="form-label small text-muted mb-1">Cerca</label>
                <input
                  type="search"
                  className="form-control"
                  placeholder="Cliente, vendita&hellip;"
                  value={filters.q}
                  onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                />
              </div>
            </div>
          </div>

          {/* Two-panel body: plan list (left) + selected plan detail (right). */}
          <div className="row g-3">
            <div className="col-12 col-xl-5">
              <div className="card installments-plan-card p-3 h-100">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="fw-semibold">Piani rateali</div>
                  <div className="text-muted small">{plans.length} risultati</div>
                </div>
                {plans.length === 0 ? (
                  <div className="installments-empty">Nessun piano trovato con i filtri selezionati.</div>
                ) : (
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Vendita</th>
                          <th>Scadenza</th>
                          <th className="text-end">Residuo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plans.map((plan) => {
                          const active = selectedPlan?.id === plan.id;
                          return (
                            <tr
                              key={plan.id}
                              className={`installments-plan-row${active ? " table-primary" : ""}`}
                              role="button"
                              tabIndex={0}
                              style={{ cursor: "pointer" }}
                              onClick={() => setSelectedPlanId(plan.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelectedPlanId(plan.id);
                                }
                              }}
                            >
                              <td>
                                <div className="fw-semibold">{plan.clientName || `Cliente #${plan.clientId}`}</div>
                                <div className="small text-muted">
                                  <span className={`badge ${plan.statusBadge || "text-bg-primary"}`}>{plan.statusLabel || "Attivo"}</span>
                                </div>
                              </td>
                              <td>
                                <div>#{plan.saleId}</div>
                                <div className="small text-muted">{fmtDate(plan.saleDate)}</div>
                              </td>
                              <td>
                                {plan.nextDueDate ? (
                                  <>
                                    <div>{fmtDate(plan.nextDueDate)}</div>
                                    <div className="small text-muted">&euro; {fmtMoney(plan.nextDueAmount ?? 0)}</div>
                                  </>
                                ) : (
                                  <span className="text-muted">&mdash;</span>
                                )}
                              </td>
                              <td className="text-end">
                                <div className="fw-semibold">&euro; {fmtMoney(plan.remaining)}</div>
                                <div className="small text-muted">{plan.pendingCount} rate</div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="col-12 col-xl-7">
              <div className="card installments-plan-card p-3 h-100">
                <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
                  <div>
                    <div className="fw-semibold">Dettaglio piano</div>
                    <div className="text-muted small">Incasso rate e riepilogo scadenze.</div>
                  </div>
                  {selectedPlan && selectedPlan.saleId > 0 ? (
                    <a
                      className="btn btn-outline-primary btn-sm"
                      href={`/${encodeURIComponent(slug)}/pos_sale_detail?id=${selectedPlan.saleId}&back=movimenti`}
                    >
                      <i className="bi bi-receipt me-1" />
                      Apri vendita
                    </a>
                  ) : null}
                </div>

                {!selectedPlan ? (
                  <div className="installments-empty">Seleziona un piano dalla lista per visualizzare dettaglio e rate.</div>
                ) : (
                  <PlanDetail
                    plan={selectedPlan}
                    busy={busy}                    payType={payType}
                    payAt={payAt}
                    payNote={payNote}
                    setPayType={setPayType}
                    setPayAt={setPayAt}
                    setPayNote={setPayNote}
                    onIncassa={incassa}
                    onRiapri={riapri}                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Selected-plan detail: the 8-item KPI grid, notes/cancellation alerts,
// and the schedule table (down-payment info line + installment rows with inline incasso forms).
function PlanDetail(props: {
  plan: InstallmentPlan;
  busy: boolean;  payType: Record<number, string>;
  payAt: Record<number, string>;
  payNote: Record<number, string>;
  setPayType: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setPayAt: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setPayNote: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  onIncassa: (inst: Installment, planId: number) => void;
  onRiapri: (inst: Installment, planId: number) => void;}) {
  const { plan, busy, payType, payAt, payNote, setPayType, setPayAt, setPayNote, onIncassa, onRiapri } = props;
  return (
    <>
      <div className="installments-kpi mb-3">
        <div className="item">
          <div className="text-muted small">Stato</div>
          <div className="fw-semibold">
            <span className={`badge ${plan.statusBadge || "text-bg-primary"}`}>{plan.statusLabel || "Attivo"}</span>
          </div>
        </div>
        <div className="item">
          <div className="text-muted small">Cliente</div>
          <div className="fw-semibold">{plan.clientName || "—"}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Pagamento</div>
          <div className="fw-semibold">{plan.paymentType || "—"}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Vendita</div>
          <div className="fw-semibold">#{plan.saleId}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Acconto</div>
          <div className="fw-semibold">&euro; {fmtMoney(plan.downPayment)}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Residuo</div>
          <div className="fw-semibold">&euro; {fmtMoney(plan.remaining)}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Frequenza</div>
          <div className="fw-semibold">{plan.intervalLabel || "—"}</div>
        </div>
        <div className="item">
          <div className="text-muted small">Prossima scadenza</div>
          <div className="fw-semibold">{fmtDate(plan.nextDueDate)}</div>
        </div>
      </div>

      {plan.notes && plan.notes.trim() ? (
        <div className="alert alert-light border small mb-3">
          <strong>Note piano:</strong>{" "}
          <span style={{ whiteSpace: "pre-line" }}>{plan.notes}</span>
        </div>
      ) : null}

      {plan.cancelledReason || plan.cancelledAt ? (
        <div className="alert alert-warning small mb-3">
          <strong>Piano annullato{plan.cancelledAt ? ` il ${fmtDateTime(plan.cancelledAt)}` : ""}:</strong>{" "}
          <span style={{ whiteSpace: "pre-line" }}>{plan.cancelledReason || "Motivazione non indicata."}</span>
        </div>
      ) : null}

      {/* NB parità legacy: installments_manage.php NON ha un bottone "Annulla piano" —
          il piano viene annullato SOLO dall'annullo della vendita collegata
          (SaleInstallments::cancelPlanBySaleId dentro cancel_sale). Il bottone
          inventato in una passata precedente è stato rimosso; l'action API cancel
          resta per l'uso interno dell'annullo vendita. */}

      <div className="table-responsive">
        <table className="table table-sm align-middle schedule-table mb-0">
          <thead>
            <tr>
              <th>Rata</th>
              <th>Scadenza</th>
              <th className="text-end">Importo</th>
              <th>Stato</th>
              <th>Incasso</th>
            </tr>
          </thead>
          <tbody>
            {/* Down-payment informational line (the Next model has no separate down-payment ROW). */}
            {plan.downPayment > 0 ? (
              <tr className="table-light">
                <td>
                  <strong>Acconto iniziale</strong>
                  <div className="small text-muted">incassato in vendita</div>
                </td>
                <td>{fmtDate(plan.saleDate)}</td>
                <td className="text-end">
                  <strong>&euro; {fmtMoney(plan.downPayment)}</strong>
                </td>
                <td>
                  <span className="badge text-bg-success">Incassato in vendita</span>
                </td>
                <td>
                  <span className="text-muted small">{plan.paymentType}</span>
                </td>
              </tr>
            ) : null}

            {plan.installments.map((inst) => {
              const isPaid = inst.status === "paid";
              const isCancelledRow = inst.status === "cancelled";
              return (
                <tr key={inst.id}>
                  <td>
                    <strong>Rata {inst.installmentNo}</strong>
                  </td>
                  <td>{fmtDate(inst.dueDate)}</td>
                  <td className="text-end">&euro; {fmtMoney(inst.amount)}</td>
                  <td>
                    <span className={`badge ${inst.statusBadge || "text-bg-warning"}`}>{inst.statusLabel}</span>
                    {isPaid && inst.paidAt ? <div className="small text-muted mt-1">{fmtDateTime(inst.paidAt)}</div> : null}
                    {isCancelledRow && inst.note && inst.note.trim() ? (
                      <div className="small text-muted mt-1" style={{ whiteSpace: "pre-line" }}>
                        {inst.note}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {isCancelledRow ? (
                      <span className="text-muted small">Rata annullata</span>
                    ) : isPaid ? (
                      <div className="d-flex gap-2 flex-wrap align-items-center installments-inline-form">
                        <div className="small text-muted">
                          &euro; {fmtMoney(inst.paidAmount ?? inst.amount)}
                          {inst.paymentType ? ` • ${inst.paymentType}` : plan.paymentType ? ` • ${plan.paymentType}` : ""}
                        </div>
                        <button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={() => onRiapri(inst, plan.id)}>
                          Riapri
                        </button>
                      </div>
                    ) : (
                      <div className="row g-2 align-items-end installments-inline-form">
                        <div className="col-12 col-md-4">
                          <label className="form-label small text-muted mb-1">Tipo</label>
                          <select
                            className="form-select form-select-sm"
                            value={payType[inst.id] ?? inst.paymentType ?? "cash"}
                            disabled={busy}
                            onChange={(e) => setPayType((m) => ({ ...m, [inst.id]: e.target.value }))}
                          >
                            {PAYMENT_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-6 col-md-3">
                          <label className="form-label small text-muted mb-1">Importo</label>
                          <input type="number" step="0.01" min="0" className="form-control form-control-sm" value={inst.amount.toFixed(2)} readOnly />
                        </div>
                        <div className="col-6 col-md-3">
                          <label className="form-label small text-muted mb-1">Data</label>
                          <input
                            type="datetime-local"
                            className="form-control form-control-sm"
                            value={payAt[inst.id] ?? nowLocalInput()}
                            disabled={busy}
                            onChange={(e) => setPayAt((m) => ({ ...m, [inst.id]: e.target.value }))}
                          />
                        </div>
                        <div className="col-12 col-md-2 d-grid">
                          <button type="button" className="btn btn-success btn-sm" disabled={busy} onClick={() => onIncassa(inst, plan.id)}>
                            Incassa
                          </button>
                        </div>
                        <div className="col-12">
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            placeholder="Nota (facoltativa)"
                            value={payNote[inst.id] ?? ""}
                            disabled={busy}
                            onChange={(e) => setPayNote((m) => ({ ...m, [inst.id]: e.target.value }))}
                          />
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
