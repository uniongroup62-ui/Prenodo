"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP commissions page (app/pages/commissions.php), the OVERVIEW
// ("Riepilogo") tab — the commission report. Fed by the DB-backed
// /api/manage/commissions dashboard (GET returns { ok, dashboard }; POST
// toggle_commission_paid returns the refreshed { ok, dashboard }). Renders the 3 empty
// states, the filters card, the summary cards, the per-operator summary table and the
// per-operator detail entries table (with the paid/unpaid toggle). Bootstrap 5 only.

type CommissionEntry = {
  entryKey: string;
  staffId: number;
  operatorName: string;
  datetime: string;
  sourceGroup: string;
  sourceLabel: string;
  sourceReference: string;
  clientName: string;
  itemLabel: string;
  baseAmount: number;
  percent: number;
  commissionAmount: number;
  entryStatus: string;
  isPaid: boolean;
  paidAt: string | null;
  cancelledAt: string | null;
  locationId: number;
  locationName: string;
  note: string;
};

type CommissionOperatorSummary = {
  staffId: number;
  operatorName: string;
  appointmentsBase: number;
  appointmentsCommission: number;
  posBase: number;
  posCommission: number;
  paidCommission: number;
  unpaidCommission: number;
  cancelledCommission: number;
  totalBase: number;
  totalCommission: number;
  entriesCount: number;
  paidEntriesCount: number;
  unpaidEntriesCount: number;
  cancelledEntriesCount: number;
};

type CommissionDashboard = {
  moduleEnabled: boolean;
  configuredRates: number;
  entries: CommissionEntry[];
  operatorSummary: CommissionOperatorSummary[];
  summary: Omit<CommissionOperatorSummary, "staffId" | "operatorName">;
  staffOptions: Array<{ id: number; name: string; isActive: boolean }>;
  locations: Array<{ id: number; name: string }>;
  activeLocationId: number;
  hasStoredHistory: boolean;
  hasSourceInScope: boolean;
};

type DashboardResponse = {
  ok?: boolean;
  error?: string;
  dashboard?: CommissionDashboard;
  canQuickBook?: boolean;
};

export type CommissionsQuery = {
  from?: string;
  to?: string;
  staff_id?: string;
  source?: string;
  detail_staff_id?: string;
};

type CommissionSource = "all" | "appointments" | "pos";

const EMPTY_SUMMARY: CommissionDashboard["summary"] = {
  appointmentsBase: 0,
  appointmentsCommission: 0,
  posBase: 0,
  posCommission: 0,
  paidCommission: 0,
  unpaidCommission: 0,
  cancelledCommission: 0,
  totalBase: 0,
  totalCommission: 0,
  entriesCount: 0,
  paidEntriesCount: 0,
  unpaidEntriesCount: 0,
  cancelledEntriesCount: 0,
};

const EMPTY_DASHBOARD: CommissionDashboard = {
  moduleEnabled: false,
  configuredRates: 0,
  entries: [],
  operatorSummary: [],
  summary: EMPTY_SUMMARY,
  staffOptions: [],
  locations: [],
  activeLocationId: 0,
  hasStoredHistory: false,
  hasSourceInScope: false,
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// number_format($n, 2, ',', '.') manuale: toLocaleString('it-IT') NON raggruppa
// 1000-9999 (CLDR minimumGroupingDigits=2), il legacy sì ("1.234,56").
function fmtMoney(n: number): string {
  const value = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// dd/mm/yyyy HH:mm from an ISO-ish datetime string; &mdash; when empty/unparseable.
function fmtDateTime(value?: string | null): string {
  const raw = String(value ?? "").trim();
  if (raw === "") return "—";
  // Accept 'YYYY-MM-DD HH:MM:SS' or ISO — take the leading date + time parts.
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return "—";
  const [, y, mo, d, hh, mm] = m;
  const time = hh && mm ? ` ${hh}:${mm}` : "";
  return `${d}/${mo}/${y}${time}`;
}

// Current-month [first, last] day as 'YYYY-MM-DD' — the default filter range.
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: fmt(first), to: fmt(last) };
}

// I filtri legacy dalla query GET (from/to valide con swap, source whitelist,
// detail agganciato allo staff filtrato come nel PHP).
function filtersFromQuery(q: CommissionsQuery): { from: string; to: string; staffId: number; source: CommissionSource; detailStaffId: number; locationId: number } {
  const range = currentMonthRange();
  const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
  let from = isDate(q.from) ? String(q.from) : range.from;
  let to = isDate(q.to) ? String(q.to) : range.to;
  if (from > to) [from, to] = [to, from];
  const source = (["all", "appointments", "pos"].includes(String(q.source ?? "")) ? String(q.source) : "all") as CommissionSource;
  const staffId = Number.parseInt(String(q.staff_id ?? "0"), 10) || 0;
  let detailStaffId = Number.parseInt(String(q.detail_staff_id ?? "0"), 10) || 0;
  if (staffId > 0 && detailStaffId > 0 && detailStaffId !== staffId) detailStaffId = staffId;
  const locationId = Math.max(0, Number.parseInt(String((q as Record<string, unknown>).location_id ?? "0"), 10) || 0);
  return { from, to, staffId: Math.max(0, staffId), source, detailStaffId: Math.max(0, detailStaffId), locationId };
}

type AppliedFilters = { from: string; to: string; staffId: number; source: CommissionSource; locationId: number };

export function CommissionsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CommissionsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState(() => filtersFromQuery(initialQuery ?? {}));

  const [dashboard, setDashboard] = useState<CommissionDashboard>(EMPTY_DASHBOARD);
  const [canQuickBook, setCanQuickBook] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Draft dei filtri (i controlli del form GET); applicati solo con "Aggiorna".
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [staffId, setStaffId] = useState(initial.staffId);
  const [source, setSource] = useState<CommissionSource>(initial.source);
  const [locationId, setLocationId] = useState(initial.locationId);
  const appliedRef = useRef<AppliedFilters>({ from: initial.from, to: initial.to, staffId: initial.staffId, source: initial.source, locationId: initial.locationId });

  // The operator whose detail entries are shown below (client-side filter of entries).
  const [selectedStaffId, setSelectedStaffId] = useState(initial.detailStaffId);

  // Flash legacy (?msg / ?err dopo i redirect del toggle), sopra i tab.
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`commissions${suffix}`.replace("&", "?")}`;
  }

  // URL legacy (overviewUrlFor): from/to/staff_id/source + detail_staff_id se aperto.
  const syncUrl = useCallback((filters: AppliedFilters, detailStaffId: number) => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams({ tab: "overview", from: filters.from, to: filters.to, staff_id: String(filters.staffId), source: filters.source });
    if (filters.locationId > 0) sp.set("location_id", String(filters.locationId));
    if (detailStaffId > 0) sp.set("detail_staff_id", String(detailStaffId));
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }, []);

  // Fetch puro (setState nei callback della Promise): mount + load() dagli handler.
  const fetchData = useCallback(
    (filters: AppliedFilters) => {
      appliedRef.current = filters;
      const qs = new URLSearchParams({
        slug,
        from: filters.from,
        to: filters.to,
        staff_id: String(filters.staffId),
        source: filters.source,
      });
      if (filters.locationId > 0) qs.set("location_id", String(filters.locationId));
      fetch(`/api/manage/commissions?${qs.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j: DashboardResponse) => {
          if (j.dashboard) setDashboard(j.dashboard);
          else setDashboard(EMPTY_DASHBOARD);
          if (typeof j.canQuickBook === "boolean") setCanQuickBook(j.canQuickBook);
        })
        .catch(() => setDashboard(EMPTY_DASHBOARD))
        .finally(() => {
          setLoading(false);
          setLoaded(true);
        });
    },
    [slug],
  );

  const load = useCallback(
    (filters: AppliedFilters) => {
      setLoading(true);
      fetchData(filters);
    },
    [fetchData],
  );

  useEffect(() => {
    fetchData({ from: initial.from, to: initial.to, staffId: initial.staffId, source: initial.source, locationId: initial.locationId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

  // Submit "Aggiorna" — applica il draft (con lo swap date del legacy) e riscrive l'URL.
  function applyFilters() {
    let f = from;
    let t = to;
    if (f && t && f > t) [f, t] = [t, f];
    setFrom(f);
    setTo(t);
    // Regola legacy: il dettaglio aperto resta solo se compatibile col filtro operatore.
    const nextDetail = staffId > 0 && selectedStaffId > 0 && selectedStaffId !== staffId ? staffId : selectedStaffId;
    setSelectedStaffId(nextDetail);
    const filters: AppliedFilters = { from: f, to: t, staffId, source, locationId };
    load(filters);
    syncUrl(filters, nextDetail);
  }

  function openDetail(detailStaffId: number) {
    setError("");
    setFlash("");
    setSelectedStaffId(detailStaffId);
    syncUrl(appliedRef.current, detailStaffId);
  }

  // POST toggle_commission_paid with the current filters; refresh from the returned dashboard.
  async function onToggle(entry: CommissionEntry) {
    setError("");
    setFlash("");
    const applied = appliedRef.current;
    const markPaid = !entry.isPaid;
    try {
      const res = await fetch(`/api/manage/commissions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "toggle_commission_paid",
          entry_key: entry.entryKey,
          mark_paid: markPaid ? "1" : "0",
          from: applied.from,
          to: applied.to,
          staff_id: String(applied.staffId),
          source: applied.source,
        }),
      });
      const j: DashboardResponse = await res.json();
      if (!res.ok || j.ok === false || !j.dashboard) {
        setError(String(j.error ?? "Impossibile aggiornare lo stato della commissione."));
        return;
      }
      setDashboard(j.dashboard);
      // Flash verbatim legacy (redirect ?msg=...).
      setFlash(markPaid ? "Commissione segnata come pagata" : "Commissione riportata da pagare");
    } catch {
      setError("Errore di rete.");
    }
  }

  const { moduleEnabled, configuredRates, entries, operatorSummary, summary, staffOptions, hasStoredHistory, hasSourceInScope } = dashboard;

  // Gate legacy dei 3 empty-state (commissions.php ~250-253): storico nel periodo
  // (righe correnti O snapshot salvati) e presenza di dati sorgente.
  const hasHistory = entries.length > 0 || hasStoredHistory;
  const showDisabled = !moduleEnabled && !hasHistory;
  const showConfigure = moduleEnabled && configuredRates <= 0 && !hasHistory;
  const showNoMovements = moduleEnabled && configuredRates > 0 && !hasHistory && !hasSourceInScope;
  const showEmpty = loaded && (showDisabled || showConfigure || showNoMovements);

  // Select Operatore: la lista COMPLETA degli staff (legacy $staffRows), non solo
  // quelli con movimenti.
  const operatorOptions = useMemo(
    () => staffOptions.filter((s) => s.id > 0).map((s) => ({ id: s.id, name: s.name })),
    [staffOptions],
  );

  // The selected operator's detail rows + its summary card row.
  const detailEntries = useMemo(
    () => (selectedStaffId > 0 ? entries.filter((e) => e.staffId === selectedStaffId) : []),
    [entries, selectedStaffId],
  );
  const detailRow = useMemo(
    () => (selectedStaffId > 0 ? operatorSummary.find((r) => r.staffId === selectedStaffId) ?? null : null),
    [operatorSummary, selectedStaffId],
  );
  const detailName =
    detailRow?.operatorName || detailEntries[0]?.operatorName || `Operatore #${selectedStaffId}`;
  const detailCount = detailRow?.entriesCount ?? detailEntries.length;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/commissions.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Operatori</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Commissioni</h1>
            <InfoBox>
              <ul>
                <li>
                  Le commissioni su <strong>appuntamenti</strong> leggono automaticamente le prestazioni concluse da
                  Quick Booking e Booking pubblico; quelle <strong>POS</strong>{" "}l&apos;operatore che ha registrato
                  la vendita in Pagamenti.
                </li>
                <li>
                  Pacchetti, prepagati, GiftBox, GiftCard e omaggi <strong>non generano una seconda commissione</strong>{" "}
                  al riscatto.
                </li>
                <li>
                  Se una vendita viene annullata, il movimento resta nello storico come <strong>Annullato</strong>{" "}e
                  viene eliminato solo con l&apos;eliminazione definitiva della vendita.
                </li>
                <li>
                  Le percentuali si impostano per operatore in <strong>Impostazioni operatori</strong>; il mese di
                  competenza segue la data dell&apos;incasso.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">
            Collegato a Pagamenti, Quick Booking e Booking. Gli appuntamenti entrano in commissione quando risultano Eseguiti.
          </div>
        </div>
        <div className="bs-page-actions">
          {moduleEnabled ? (
            <span className="badge text-bg-success">Commissioni attive</span>
          ) : (
            <span className="badge text-bg-secondary">Commissioni disattivate</span>
          )}
        </div>
      </div>

      {/* Flash legacy (?msg/?err): subito dopo l'header, PRIMA dei tab. */}
      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <ul className="nav nav-tabs commissions-tabs mb-3">
        <li className="nav-item">
          <a className="nav-link active" href={href("&tab=overview")}>
            <i className="bi bi-graph-up me-1" />
            Riepilogo
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link " href={href("&tab=settings")}>
            <i className="bi bi-sliders me-1" />
            Impostazioni operatori
          </a>
        </li>
      </ul>

      {showEmpty ? (
        <div className="card border-0 shadow-sm commissions-empty-card">
          <div className="commissions-empty-state">
            <div className="commissions-empty-icon" aria-hidden="true">
              <i className="bi bi-percent" />
            </div>
            {showDisabled ? (
              <>
                <h2>Funzione Commissioni disattivata</h2>
                <p>
                  Le nuove vendite e i nuovi appuntamenti non generano movimenti commissione. Attiva la funzione e configura le
                  percentuali quando vuoi iniziare a calcolarle.
                </p>
                <div className="d-flex justify-content-center gap-2 flex-wrap">
                  <a className="btn btn-primary" href={href("&tab=settings")}>
                    <i className="bi bi-sliders me-1" />
                    Attiva Commissioni
                  </a>
                </div>
              </>
            ) : showConfigure ? (
              <>
                <h2>Configura le percentuali commissione</h2>
                <p>
                  La funzione &egrave; attiva, ma nessun operatore ha ancora percentuali impostate. Configura almeno una
                  percentuale per iniziare a calcolare i movimenti.
                </p>
                <div className="d-flex justify-content-center gap-2 flex-wrap">
                  <a className="btn btn-primary" href={href("&tab=settings")}>
                    <i className="bi bi-sliders me-1" />
                    Impostazioni operatori
                  </a>
                </div>
              </>
            ) : (
              <>
                <h2>Nessun movimento commissionabile presente</h2>
                <p>
                  Non risultano ancora vendite o appuntamenti eseguiti da cui generare commissioni nella sede selezionata. I
                  movimenti appariranno qui quando ci saranno dati commissionabili.
                </p>
                <div className="d-flex justify-content-center gap-2 flex-wrap">
                  <a className="btn btn-primary" href={`/${encodeURIComponent(slug)}/pos`}>
                    <i className="bi bi-credit-card me-1" />
                    Apri Pagamenti
                  </a>
                  {canQuickBook ? (
                    // La shell delega i click su [data-qb-new] al Quick Booking drawer,
                    // come il bottone legacy data-qb-new="1".
                    <a className="btn btn-outline-primary" href="#" data-qb-new="1">
                      <i className="bi bi-plus-lg me-1" />
                      Nuova prenotazione
                    </a>
                  ) : null}
                  <a className="btn btn-outline-secondary" href={href("&tab=settings")}>
                    <i className="bi bi-sliders me-1" />
                    Impostazioni
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          {!moduleEnabled ? (
            <div className="alert alert-secondary">
              <strong>Funzione Commissioni disattivata.</strong> Le nuove vendite e i nuovi appuntamenti non generano movimenti
              commissione. Lo storico gi&agrave; registrato resta consultabile e gestibile.
            </div>
          ) : null}

          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
            >
              <div className="col-xl-2 col-md-6">
                <label className="form-label small text-muted">Dal</label>
                <input className="form-control" type="date" name="from" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="col-xl-2 col-md-6">
                <label className="form-label small text-muted">Al</label>
                <input className="form-control" type="date" name="to" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="col-xl-3 col-md-6">
                <label className="form-label small text-muted">Operatore</label>
                <select
                  className="form-select"
                  name="staff_id"
                  value={String(staffId)}
                  onChange={(e) => setStaffId(Number(e.target.value) || 0)}
                >
                  <option value="0">Tutti gli operatori</option>
                  {operatorOptions.map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-xl-3 col-md-6">
                <label className="form-label small text-muted">Origine</label>
                <select
                  className="form-select"
                  name="source"
                  value={source}
                  onChange={(e) => setSource(e.target.value as CommissionSource)}
                >
                  <option value="all">Tutto</option>
                  <option value="appointments">Quick Booking / Booking</option>
                  <option value="pos">Pagamenti</option>
                </select>
              </div>
              {dashboard.locations.length > 1 ? (
                <div className="col-xl-3 col-md-6">
                  {/* Filtro Sede (port di $commissionLocationMap): solo con >1 sede. */}
                  <label className="form-label small text-muted">Sede</label>
                  <select className="form-select" name="location_id" value={locationId} onChange={(e) => setLocationId(Number(e.target.value) || 0)}>
                    <option value={0}>Tutte le sedi</option>
                    {dashboard.locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="col-12 d-flex gap-2 flex-wrap">
                <button className="btn btn-outline-primary" type="submit" disabled={loading}>
                  Aggiorna
                </button>
                {/* Reset legacy: anchor alla pagina base (ricarica con i default). */}
                <a className="btn btn-outline-secondary" href={href("&tab=overview")}>
                  Reset
                </a>
              </div>
            </form>
          </div>

          {moduleEnabled && configuredRates <= 0 ? (
            <div className="alert alert-warning">
              Nessun operatore ha ancora percentuali commissione configurate. Vai su <strong>Impostazioni operatori</strong> per
              attivare il calcolo.
            </div>
          ) : null}


          <div className="row g-3 mb-3">
            <div className="col-md-3">
              <div className="card p-3 h-100">
                <div className="small text-muted">Base commissionabile</div>
                <div className="h3 m-0">&euro; {fmtMoney(summary.totalBase)}</div>
              </div>
            </div>
            <div className="col-md-3">
              <div className="card p-3 h-100">
                <div className="small text-muted">Commissioni calcolate</div>
                <div className="h3 m-0">&euro; {fmtMoney(summary.totalCommission)}</div>
                <div className="text-muted small mt-2">Pagate &euro; {fmtMoney(summary.paidCommission)}</div>
                <div className="text-muted small">Da pagare &euro; {fmtMoney(summary.unpaidCommission)}</div>
                {summary.cancelledEntriesCount > 0 ? (
                  <div className="text-danger small">
                    Annullate &euro; {fmtMoney(summary.cancelledCommission)} &bull; {summary.cancelledEntriesCount} movimenti
                  </div>
                ) : null}
              </div>
            </div>
            <div className="col-md-3">
              <div className="card p-3 h-100">
                <div className="small text-muted">Appuntamenti</div>
                <div className="fw-semibold">Base &euro; {fmtMoney(summary.appointmentsBase)}</div>
                <div className="text-muted small">Commissioni &euro; {fmtMoney(summary.appointmentsCommission)}</div>
              </div>
            </div>
            <div className="col-md-3">
              <div className="card p-3 h-100">
                <div className="small text-muted">Pagamenti</div>
                <div className="fw-semibold">Base &euro; {fmtMoney(summary.posBase)}</div>
                <div className="text-muted small">Commissioni &euro; {fmtMoney(summary.posCommission)}</div>
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-header fw-semibold">Riepilogo per operatore</div>
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <thead>
                  <tr>
                    <th>Operatore</th>
                    <th className="text-end">Base app.</th>
                    <th className="text-end">Comm. app.</th>
                    <th className="text-end">Base POS</th>
                    <th className="text-end">Comm. POS</th>
                    <th className="text-end">Pagate</th>
                    <th className="text-end">Da pagare</th>
                    <th className="text-end">Totale commissioni</th>
                    <th className="text-end">Movimenti</th>
                  </tr>
                </thead>
                <tbody>
                  {operatorSummary.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessun movimento commissionabile nel periodo selezionato."}
                      </td>
                    </tr>
                  ) : (
                    operatorSummary.map((row) => (
                      <tr key={row.staffId}>
                        <td>
                          <div className="fw-semibold">{row.operatorName}</div>
                          <div className="text-muted small">{row.entriesCount} movimenti</div>
                          {row.cancelledEntriesCount > 0 ? (
                            <div className="text-danger small">
                              Annullate {row.cancelledEntriesCount} &bull; &euro; {fmtMoney(row.cancelledCommission)}
                            </div>
                          ) : null}
                        </td>
                        <td className="text-end">&euro; {fmtMoney(row.appointmentsBase)}</td>
                        <td className="text-end">&euro; {fmtMoney(row.appointmentsCommission)}</td>
                        <td className="text-end">&euro; {fmtMoney(row.posBase)}</td>
                        <td className="text-end">&euro; {fmtMoney(row.posCommission)}</td>
                        <td className="text-end">&euro; {fmtMoney(row.paidCommission)}</td>
                        <td className="text-end">&euro; {fmtMoney(row.unpaidCommission)}</td>
                        <td className="text-end fw-bold">&euro; {fmtMoney(row.totalCommission)}</td>
                        <td className="text-end">
                          {/* Legacy: il link apre (o mantiene aperto) il dettaglio; si chiude solo con "Chiudi". */}
                          <button
                            type="button"
                            className={`btn btn-sm ${selectedStaffId === row.staffId ? "btn-primary" : "btn-outline-primary"}`}
                            onClick={() => openDetail(row.staffId)}
                          >
                            Movimenti
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selectedStaffId > 0 ? (
            <div className="card mb-3">
              <div className="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
                <div>
                  <div className="fw-semibold">Movimenti operatore</div>
                  <div className="small text-muted">
                    {detailName} &bull; {detailCount} movimenti
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => openDetail(0)}
                >
                  Chiudi
                </button>
              </div>
              <div className="card-body border-bottom">
                <div className="row g-3">
                  <div className="col-md-3">
                    <div className="small text-muted">Base commissionabile</div>
                    <div className="fw-semibold">&euro; {fmtMoney(detailRow?.totalBase ?? 0)}</div>
                  </div>
                  <div className="col-md-3">
                    <div className="small text-muted">Commissioni calcolate</div>
                    <div className="fw-semibold">&euro; {fmtMoney(detailRow?.totalCommission ?? 0)}</div>
                  </div>
                  <div className="col-md-3">
                    <div className="small text-muted">Pagate</div>
                    <div className="fw-semibold">&euro; {fmtMoney(detailRow?.paidCommission ?? 0)}</div>
                    <div className="text-muted small">{detailRow?.paidEntriesCount ?? 0} movimenti</div>
                  </div>
                  <div className="col-md-3">
                    <div className="small text-muted">Da pagare</div>
                    <div className="fw-semibold">&euro; {fmtMoney(detailRow?.unpaidCommission ?? 0)}</div>
                    <div className="text-muted small">{detailRow?.unpaidEntriesCount ?? 0} movimenti</div>
                    {(detailRow?.cancelledEntriesCount ?? 0) > 0 ? (
                      <div className="text-danger small mt-2">
                        Annullate &euro; {fmtMoney(detailRow?.cancelledCommission ?? 0)} &bull;{" "}
                        {detailRow?.cancelledEntriesCount ?? 0} movimenti
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="table-responsive">
                <table className="table align-middle mb-0">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Origine</th>
                      <th>Cliente</th>
                      <th>Voce</th>
                      <th>Riferimento</th>
                      {dashboard.locations.length > 1 ? <th>Sede</th> : null}
                      <th className="text-end">Base</th>
                      <th className="text-end">%</th>
                      <th className="text-end">Commissione</th>
                      <th>Stato</th>
                      <th className="text-end">Azione</th>
                      <th>Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailEntries.length === 0 ? (
                      <tr>
                        <td colSpan={dashboard.locations.length > 1 ? 12 : 11} className="text-muted p-3">
                          Nessun movimento commissionabile per l&rsquo;operatore selezionato nel periodo indicato.
                        </td>
                      </tr>
                    ) : (
                      detailEntries.map((row) => {
                        const isCancelled = row.entryStatus === "cancelled";
                        return (
                          <tr key={row.entryKey}>
                            <td>{fmtDateTime(row.datetime)}</td>
                            <td>{row.sourceLabel}</td>
                            <td>{row.clientName || "—"}</td>
                            <td>{row.itemLabel}</td>
                            <td className="text-muted small">{row.sourceReference}</td>
                            {dashboard.locations.length > 1 ? <td className="small">{row.locationName || "—"}</td> : null}
                            <td className="text-end">&euro; {fmtMoney(row.baseAmount)}</td>
                            <td className="text-end">{fmtMoney(row.percent)}%</td>
                            <td className="text-end fw-semibold">&euro; {fmtMoney(row.commissionAmount)}</td>
                            <td>
                              {isCancelled ? (
                                <>
                                  <span className="badge text-bg-danger">Annullata</span>
                                  {row.cancelledAt ? (
                                    <div className="small text-muted mt-1">{fmtDateTime(row.cancelledAt)}</div>
                                  ) : null}
                                </>
                              ) : row.isPaid ? (
                                <>
                                  <span className="badge text-bg-success">Pagata</span>
                                  <div className="small text-muted mt-1">{fmtDateTime(row.paidAt)}</div>
                                </>
                              ) : (
                                <span className="badge text-bg-warning">Da pagare</span>
                              )}
                            </td>
                            <td className="text-end text-nowrap">
                              {isCancelled ? (
                                <span className="text-muted small">&mdash;</span>
                              ) : (
                                <button
                                  type="button"
                                  className={`btn btn-sm ${row.isPaid ? "btn-outline-secondary" : "btn-success"}`}
                                  onClick={() => onToggle(row)}
                                >
                                  {row.isPaid ? "Da pagare" : "Pagato"}
                                </button>
                              )}
                            </td>
                            <td className="text-muted small">{row.note}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
