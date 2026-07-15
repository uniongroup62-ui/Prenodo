"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP installments page (app/pages/installments_manage.php).
// Backed by the DB-backed /api/manage/installments route:
//   GET  ?status=&client_id=&sale_id=&due_from=&due_to=  -> { ok, plans, clients }
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
  // Legacy ?sale_id=N: participates in searchPlans AND is the last selection fallback
  // (loadPlanBySaleId). Set only from the URL — the filter form does not carry it, so
  // pressing Filtra drops it exactly like the legacy GET form.
  saleId: number;
  // Checkbox legacy "Tutte le sedi" (?all_locations=1, tenant multi-sede): allarga
  // lo scope alle sedi assegnate (tutte per l'admin) invece della sola corrente.
  allLocations: boolean;
};

// The values the legacy page accepts for ?status= (anything else falls back to "open").
const STATUS_WHITELIST = ["all", "open", "overdue", "paid", "active", "completed", "cancelled"];

// The legacy GET params (status/client_id/sale_id/due_from/due_to/plan_id), parsed from the
// server-provided query prop — the page router forwards searchParams exactly like the PHP
// page reads $_GET, so first render already has the right filters (no client URL sniffing).
export type InstallmentsQuery = {
  status?: string;
  client_id?: string;
  sale_id?: string;
  due_from?: string;
  due_to?: string;
  plan_id?: string;
  all_locations?: string;
};

function filtersFromQuery(q: InstallmentsQuery): { filters: Filters; planId: number } {
  const status = String(q.status ?? "open").trim();
  const clientId = Number.parseInt(String(q.client_id ?? "0"), 10) || 0;
  return {
    filters: {
      status: STATUS_WHITELIST.includes(status) ? status : "open",
      clientId: clientId > 0 ? String(clientId) : "",
      dueFrom: String(q.due_from ?? "").trim(),
      dueTo: String(q.due_to ?? "").trim(),
      saleId: Number.parseInt(String(q.sale_id ?? "0"), 10) || 0,
      // Set truthy legacy (app_all_locations_filter_enabled).
      allLocations: ["1", "true", "on", "yes", "all"].includes(String(q.all_locations ?? "").trim().toLowerCase()),
    },
    planId: Number.parseInt(String(q.plan_id ?? "0"), 10) || 0,
  };
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// "1.234,56" — formatter it-IT MANUALE (fedele a number_format PHP): raggruppa SEMPRE le
// migliaia col punto, anche per 1000-9999 (toLocaleString('it-IT') NON le raggruppa in quella
// fascia — trappola it-number-format-trap). Virgola per i decimali.
function fmtMoney(value: number): string {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  const [intPart, decPart] = Math.abs(n).toFixed(2).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${grouped},${decPart}`;
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

// SaleInstallments::paymentTypeLabel — the DISPLAY label ("card" reads "Carta di
// Credito" here, while the select option above says "Carta", like the legacy page).
function payLabel(type?: string): string {
  const v = String(type ?? "").trim().toLowerCase();
  if (v === "cash") return "Contanti";
  if (v === "card") return "Carta di Credito";
  if (v === "check") return "Assegno";
  if (v === "bank") return "Bonifico";
  return "";
}

// Accent-insensitive lowercase compare used by the legacy combobox search (norm() in
// assets/js/pages/installments_manage.js).
function comboNorm(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function InstallmentsManageContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: InstallmentsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  // Parsed once from the server query prop (deterministic on server and client).
  const [initial] = useState(() => filtersFromQuery(initialQuery ?? {}));

  // Applied filters (drive the fetch) vs draft filters (the form controls). Like the legacy
  // GET form, changing a control does nothing until "Filtra" submits the draft.
  const [filters, setFilters] = useState<Filters>(initial.filters);
  // Filtri APPLICATI diversi dai default (stato 'open', nessun cliente/data/sede):
  // guida il Reset condizionale e il '· filtri attivi' (restyle 2026-07-15).
  const filtersActive =
    filters.status !== "open" || filters.clientId !== "" || filters.dueFrom !== "" || filters.dueTo !== "" || filters.saleId > 0 || filters.allLocations;
  const [draft, setDraft] = useState<{ status: string; clientId: string; dueFrom: string; dueTo: string; allLocations: boolean }>({
    status: initial.filters.status,
    clientId: initial.filters.clientId,
    dueFrom: initial.filters.dueFrom,
    dueTo: initial.filters.dueTo,
    allLocations: initial.filters.allLocations,
  });
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  // Whether the tenant has ANY installment plan at all (unfiltered). Drives the empty-state card.
  const [hasAnyPlans, setHasAnyPlans] = useState(true);
  // Distinct clients derived from every plan ever seen (for the client filter select).
  const [clientOptions, setClientOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number>(initial.planId);

  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Reload trigger: an action bumps this so the load effect re-fetches with the current filters.
  const [reloadKey, setReloadKey] = useState(0);

  // Per-pending-row inline form state (payment type + paid_at), keyed by installment id.
  const [payType, setPayType] = useState<Record<number, string>>({});
  const [payAt, setPayAt] = useState<Record<number, string>>({});

  // Contesto sedi per sottotitolo e checkbox: il suffisso " Sede: X" segue il
  // filtro applicato ('Tutte' con all_locations, come $installmentLocationId=0);
  // il checkbox "Tutte le sedi" esiste solo multi-sede (count > 1).
  const [locCtx, setLocCtx] = useState<{ locations: Array<{ id: number; name?: string }>; currentId: number } | null>(null);


  // Load the filtered plan list. Faithful to searchPlans($filters): the status synthetic values are
  // resolved server-side, so pass them straight through.
  useEffect(() => {
    const params = new URLSearchParams({ slug });
    if (filters.status) params.set("status", filters.status);
    if (filters.clientId) params.set("client_id", filters.clientId);
    if (filters.saleId > 0) params.set("sale_id", String(filters.saleId));
    if (filters.dueFrom) params.set("due_from", filters.dueFrom);
    if (filters.dueTo) params.set("due_to", filters.dueTo);
    if (filters.allLocations) params.set("all_locations", "1");

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

  // Location context for the subtitle (app_current_location_id + label; 0 -> "Tutte").
  useEffect(() => {
    let active = true;
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { locations?: Array<{ id: number; name?: string }>; currentLocationId?: number }) => {
        if (!active) return;
        const locations = Array.isArray(j?.locations) ? j.locations : [];
        const currentId = Number(j?.currentLocationId ?? 0);
        setLocCtx({ locations, currentId });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [slug]);

  // Probe the UNFILTERED list once (status=all) to decide the empty-state, and take the FULL
  // client list for the filter combobox — faithful to the legacy page, which SELECTs every
  // client (ORDER BY full_name) for $clientFilterItems, not just the ones with a plan.
  useEffect(() => {
    let active = true;
    fetch(`/api/manage/installments?slug=${encodeURIComponent(slug)}&status=all`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { plans?: InstallmentPlan[]; clients?: Array<{ id: number; label?: string }> }) => {
        if (!active) return;
        const list = Array.isArray(j?.plans) ? j.plans : [];
        setHasAnyPlans(list.length > 0);
        if (Array.isArray(j?.clients) && j.clients.length > 0) {
          setClientOptions(j.clients.map((c) => ({ id: Number(c.id), name: String(c.label ?? `Cliente #${c.id}`) })).filter((c) => c.id > 0));
        } else {
          const seen = new Map<number, string>();
          for (const p of list) {
            if (p.clientId > 0 && !seen.has(p.clientId)) seen.set(p.clientId, p.clientName || `Cliente #${p.clientId}`);
          }
          setClientOptions([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "it")));
        }
      })
      .catch(() => {
        if (active) setHasAnyPlans(true);
      });
    return () => {
      active = false;
    };
  }, [slug, reloadKey]);

  // The selected plan, with the legacy fallback chain: explicit ?plan_id / click, else the
  // single result, else the plan of ?sale_id (loadPlanBySaleId).
  const selectedPlan = useMemo<InstallmentPlan | null>(() => {
    if (selectedPlanId > 0) {
      const found = plans.find((p) => p.id === selectedPlanId);
      if (found) return found;
    }
    if (plans.length === 1) return plans[0];
    if (filters.saleId > 0) {
      const bySale = plans.find((p) => p.saleId === filters.saleId);
      if (bySale) return bySale;
    }
    return null;
  }, [plans, selectedPlanId, filters.saleId]);

  // Mirror the legacy plan-row hrefs: selecting a plan (or filtering) rewrites the URL with
  // plan_id + the public filters, so the page stays deep-linkable like the server-rendered one.
  function syncUrl(planId: number, f: Filters) {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams();
    if (planId > 0) sp.set("plan_id", String(planId));
    sp.set("status", f.status);
    sp.set("client_id", f.clientId || "0");
    sp.set("sale_id", String(f.saleId || 0));
    if (f.dueFrom) sp.set("due_from", f.dueFrom);
    if (f.dueTo) sp.set("due_to", f.dueTo);
    if (f.allLocations) sp.set("all_locations", "1");
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }

  function selectPlan(planId: number) {
    setSelectedPlanId(planId);
    syncUrl(planId, filters);
  }

  // "Filtra": apply the draft. Like the legacy GET form, plan_id and sale_id are not part of
  // the form, so both are dropped when submitting.
  function applyDraft() {
    const next: Filters = { ...draft, saleId: 0 };
    setFilters(next);
    setSelectedPlanId(0);
    syncUrl(0, next);
  }

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
      // Col filtro "Tutte le sedi" attivo anche le azioni viaggiano senza sede
      // singola (legacy: il form posta location_id=0 + all_locations=1), così una
      // rata di un'altra sede assegnata resta incassabile.
      body: JSON.stringify(filters.allLocations ? { ...payload, all_locations: "1" } : payload),
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

  async function incassa(inst: Installment, planId: number, planPaymentType: string) {
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const json = await postAction({
        action: "mark_paid",
        installment_id: String(inst.id),
        paid_amount: inst.amount.toFixed(2),
        paid_at: payAt[inst.id] || nowLocalInput(),
        // The legacy select preselects the rata type, else the plan type, else the first
        // option (cash). The page posts note="" (there is no note input).
        payment_type: payType[inst.id] || inst.paymentType || planPaymentType || "cash",
        note: "",
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

  // Sottotitolo legacy: ' Sede: X' (corrente) o ' Sede: Tutte' (filtro attivo /
  // nessuna sede corrente), appeso quando il tenant ha sedi.
  const showAllLocationsFilter = (locCtx?.locations.length ?? 0) > 1;
  const sedeLabel = (() => {
    if (!locCtx || (locCtx.currentId <= 0 && locCtx.locations.length === 0)) return "";
    if (filters.allLocations || locCtx.currentId <= 0) return "Tutte";
    const current = locCtx.locations.find((l) => Number(l.id) === locCtx.currentId);
    return String(current?.name ?? `#${locCtx.currentId}`);
  })();

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/installments_manage.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pagamenti</div>
          <h1 className="bs-page-title">Gestione Rate</h1>
          <div className="bs-page-subtitle">
            Monitoraggio piani rateali, scadenze e incassi cliente.
            {sedeLabel ? ` Sede: ${sedeLabel}` : ""}
          </div>
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
            {/* Verbatim legacy: "e" senza accento. */}
            <p>La gestione rate e ancora vuota. Crea una vendita con pagamento rateizzato per iniziare.</p>
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

          {/* Filter card. Like the legacy GET form, the controls edit a draft that is applied
              only by the "Filtra" submit; "Reset" navigates back to the bare page. */}
          <div className="card installments-filter-card p-3 mb-3">
            <form
              className="row g-2 align-items-end installments-filter-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyDraft();
              }}
            >
              <div className="col-12 col-lg-3">
                <label className="form-label small text-muted mb-1">Cliente</label>
                <ClientFilterCombobox
                  items={clientOptions}
                  value={draft.clientId}
                  onChange={(id) => setDraft((f) => ({ ...f, clientId: id }))}
                />
              </div>
              <div className="col-12 col-md-4 col-lg-2">
                <label className="form-label small text-muted mb-1">Stato</label>
                <select
                  className="form-select"
                  name="status"
                  value={draft.status}
                  onChange={(e) => setDraft((f) => ({ ...f, status: e.target.value }))}
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
                  name="due_from"
                  value={draft.dueFrom}
                  onChange={(e) => setDraft((f) => ({ ...f, dueFrom: e.target.value }))}
                />
              </div>
              <div className="col-6 col-md-4 col-lg-2">
                <label className="form-label small text-muted mb-1">A</label>
                <input
                  type="date"
                  className="form-control"
                  name="due_to"
                  value={draft.dueTo}
                  onChange={(e) => setDraft((f) => ({ ...f, dueTo: e.target.value }))}
                />
              </div>
              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Filtra pieno a larghezza naturale (via le
                  classi custom outline), Reset visibile solo con filtri non-default. */}
              {/* col-auto: la coda (switch+bottoni) si accoda ai campi con leggero
                  distacco invece di una colonna fissa spinta a destra dal CSS. */}
              <div className="col-12 col-lg-auto d-flex align-items-end gap-2 ms-lg-2 mt-2 mt-lg-0 flex-wrap installments-filter-actions">
                {showAllLocationsFilter ? (
                  <div className="form-check form-switch mb-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="installmentsAllLocations"
                      name="all_locations"
                      value="1"
                      checked={draft.allLocations}
                      onChange={(e) => setDraft((f) => ({ ...f, allLocations: e.target.checked }))}
                    />
                    <label className="form-check-label" htmlFor="installmentsAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                ) : null}
                <button type="submit" className="btn btn-primary">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {filtersActive ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={`/${encodeURIComponent(slug)}/installments_manage`}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          {/* Two-panel body: plan list (left) + selected plan detail (right). */}
          <div className="row g-3">
            <div className="col-12 col-xl-5">
              <div className="card installments-plan-card p-3 h-100">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="fw-semibold">Piani rateali</div>
                  <div className="text-muted small">
                    {plans.length} risultati
                    {filtersActive ? " · filtri attivi" : ""}
                  </div>
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
                          const clientLabel = plan.clientName || `Cliente #${plan.clientId}`;
                          return (
                            <tr
                              key={plan.id}
                              className={`installments-plan-row js-plan-row${active ? " table-primary" : ""}`}
                              data-href={`/${encodeURIComponent(slug)}/installments_manage?plan_id=${plan.id}&status=${encodeURIComponent(filters.status)}&client_id=${filters.clientId || "0"}&sale_id=${filters.saleId || 0}`}
                              role="link"
                              tabIndex={0}
                              aria-label={`Apri piano rateale ${clientLabel}`}
                              style={{ cursor: "pointer" }}
                              onClick={() => selectPlan(plan.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  selectPlan(plan.id);
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
                    setPayType={setPayType}
                    setPayAt={setPayAt}
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
  setPayType: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setPayAt: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  onIncassa: (inst: Installment, planId: number, planPaymentType: string) => void;
  onRiapri: (inst: Installment, planId: number) => void;}) {
  const { plan, busy, payType, payAt, setPayType, setPayAt, onIncassa, onRiapri } = props;
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
          <div className="fw-semibold">{payLabel(plan.paymentType)}</div>
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
            {/* Down-payment first line — always rendered, like the legacy schedule. */}
            <tr className="table-light">
              <td>
                <strong>Acconto iniziale</strong>
              </td>
              <td>{fmtDate(plan.saleDate || new Date().toISOString().slice(0, 10))}</td>
              <td className="text-end">
                <strong>&euro; {fmtMoney(plan.downPayment)}</strong>
              </td>
              <td>
                <span className="badge text-bg-success">Incassato in vendita</span>
              </td>
              <td>
                <span className="text-muted small">{payLabel(plan.paymentType)}</span>
              </td>
            </tr>

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
                      <>
                        <span className="text-muted small">Rata annullata</span>
                        {inst.paidAt ? (
                          <div className="small text-muted mt-1">
                            Incassata il {fmtDateTime(inst.paidAt)} &bull; &euro; {fmtMoney(inst.paidAmount ?? inst.amount)}
                          </div>
                        ) : null}
                      </>
                    ) : isPaid ? (
                      <div className="d-flex gap-2 flex-wrap align-items-center installments-inline-form">
                        <div className="small text-muted">
                          &euro; {fmtMoney(inst.paidAmount ?? inst.amount)}{` • ${payLabel(inst.paymentType || plan.paymentType)}`}
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
                            value={payType[inst.id] ?? (inst.paymentType || plan.paymentType || "cash")}
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
                          <input type="number" step="0.01" min="0" max={inst.amount.toFixed(2)} className="form-control form-control-sm" value={inst.amount.toFixed(2)} readOnly />
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
                          <button type="button" className="btn btn-success btn-sm" disabled={busy} onClick={() => onIncassa(inst, plan.id, plan.paymentType)}>
                            Incassa
                          </button>
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

// Client filter combobox — port of the legacy .app-combobox (initCombobox in
// assets/js/pages/installments_manage.js): outline-secondary toggle with the "Tutti"
// placeholder, search box ("Cerca…", accent-insensitive, Enter picks the first hit),
// "Nessun risultato" empty row, and a "Tutti" first item that clears the selection.
function ClientFilterCombobox(props: {
  items: Array<{ id: number; name: string }>;
  value: string;
  onChange: (clientId: string) => void;
}) {
  const { items, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const data = useMemo(
    () => [{ id: "0", label: "Tutti" }, ...items.map((c) => ({ id: String(c.id), label: c.name }))],
    [items],
  );
  const q = comboNorm(search);
  const visible = q ? data.filter((item) => comboNorm(item.label).includes(q)) : data;
  const selected = value ? data.find((item) => item.id === value) : undefined;

  const pick = (id: string) => {
    onChange(id === "0" ? "" : id);
    setOpen(false);
  };

  return (
    <div className={`app-combobox dropdown${open ? " show" : ""}`} id="installmentsClientFilterBox" ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSearch("");
          setOpen(!open);
        }}
      >
        <span className={`app-combobox-text${selected ? "" : " d-none"}`}>{selected?.label ?? ""}</span>
        <span className={`text-muted app-combobox-placeholder${selected ? " d-none" : ""}`}>Tutti</span>
      </button>
      <div className={`dropdown-menu p-2 w-100${open ? " show" : ""}`}>
        <input
          ref={searchRef}
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (visible[0]) pick(visible[0].id);
            }
          }}
        />
        <div className="app-combobox-list mt-2">
          {visible.length === 0 ? (
            <div className="text-muted small px-2 py-1">Nessun risultato</div>
          ) : (
            visible.map((item) => (
              <button key={item.id} type="button" className="dropdown-item" onClick={() => pick(item.id)}>
                {item.label}
              </button>
            ))
          )}
        </div>
      </div>
      <input type="hidden" name="client_id" value={value || "0"} readOnly />
    </div>
  );
}
