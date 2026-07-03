"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
};

type DashboardResponse = {
  ok?: boolean;
  error?: string;
  dashboard?: CommissionDashboard;
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
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// € 1.234,56 (it-IT, always 2 decimals) — matches fmt_money in the PHP.
function fmtMoney(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

export function CommissionsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const initialRange = useMemo(() => currentMonthRange(), []);

  const [dashboard, setDashboard] = useState<CommissionDashboard>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);

  // Filter state — changing any of these refetches.
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [staffId, setStaffId] = useState(0);
  const [source, setSource] = useState<CommissionSource>("all");

  // The operator whose detail entries are shown below (client-side filter of entries).
  const [selectedStaffId, setSelectedStaffId] = useState(0);
  const [toggleError, setToggleError] = useState("");

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`commissions${suffix}`.replace("&", "?")}`;
  }

  // GET the dashboard for the current filters.
  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams({
      slug,
      from,
      to,
      staff_id: String(staffId),
      source,
    });
    fetch(`/api/manage/commissions?${qs.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: DashboardResponse) => {
        if (j.dashboard) setDashboard(j.dashboard);
        else setDashboard(EMPTY_DASHBOARD);
      })
      .catch(() => setDashboard(EMPTY_DASHBOARD))
      .finally(() => setLoading(false));
  }, [slug, from, to, staffId, source]);

  useEffect(() => {
    load();
  }, [load]);

  function onReset() {
    setToggleError("");
    setSelectedStaffId(0);
    setStaffId(0);
    setSource("all");
    setFrom(initialRange.from);
    setTo(initialRange.to);
  }

  // POST toggle_commission_paid with the current filters; refresh from the returned dashboard.
  async function onToggle(entry: CommissionEntry) {
    setToggleError("");
    try {
      const res = await fetch(`/api/manage/commissions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "toggle_commission_paid",
          entry_key: entry.entryKey,
          mark_paid: entry.isPaid ? "0" : "1",
          from,
          to,
          staff_id: String(staffId),
          source,
        }),
      });
      const j: DashboardResponse = await res.json();
      if (!res.ok || j.ok === false || !j.dashboard) {
        setToggleError(String(j.error ?? "Impossibile aggiornare lo stato della commissione."));
        return;
      }
      setDashboard(j.dashboard);
    } catch {
      setToggleError("Errore di rete.");
    }
  }

  const { moduleEnabled, configuredRates, entries, operatorSummary, summary } = dashboard;
  const hasEntries = entries.length > 0;

  // The 3 empty states (only meaningful once loaded).
  const showDisabled = !moduleEnabled && !hasEntries;
  const showConfigure = moduleEnabled && configuredRates === 0 && !hasEntries;
  const showNoMovements = moduleEnabled && configuredRates > 0 && !hasEntries;
  const showEmpty = !loading && (showDisabled || showConfigure || showNoMovements);

  // Operator options for the filter select — prefer the summary, fall back to distinct entry operators.
  const operatorOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of operatorSummary) {
      if (row.staffId > 0) map.set(row.staffId, row.operatorName);
    }
    if (map.size === 0) {
      for (const e of entries) {
        if (e.staffId > 0 && !map.has(e.staffId)) map.set(e.staffId, e.operatorName);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [operatorSummary, entries]);

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
          <h1 className="bs-page-title">Commissioni</h1>
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
            <div className="row g-2 align-items-end">
              <div className="col-xl-2 col-md-6">
                <label className="form-label small text-muted">Dal</label>
                <input className="form-control" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="col-xl-2 col-md-6">
                <label className="form-label small text-muted">Al</label>
                <input className="form-control" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="col-xl-3 col-md-6">
                <label className="form-label small text-muted">Operatore</label>
                <select
                  className="form-select"
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
                  value={source}
                  onChange={(e) => setSource(e.target.value as CommissionSource)}
                >
                  <option value="all">Tutto</option>
                  <option value="appointments">Quick Booking / Booking</option>
                  <option value="pos">Pagamenti</option>
                </select>
              </div>
              <div className="col-12 d-flex gap-2 flex-wrap">
                <button className="btn btn-outline-primary" type="button" disabled={loading} onClick={load}>
                  Aggiorna
                </button>
                <button className="btn btn-outline-secondary" type="button" onClick={onReset}>
                  Reset
                </button>
              </div>
            </div>
            <div className="small text-muted mt-3">
              <strong>Come funziona:</strong> le commissioni su appuntamenti leggono automaticamente le prestazioni concluse da
              Quick Booking e Booking pubblico. Le commissioni POS leggono l&rsquo;operatore che ha registrato la vendita in
              Pagamenti. Pacchetti, prepagati, GiftBox, GiftCard e omaggi non generano una seconda commissione al riscatto. Se
              una vendita viene annullata il movimento resta nello storico Commissioni come <strong>Annullato</strong> e viene
              eliminato solo con l&rsquo;eliminazione definitiva della vendita annullata.
            </div>
          </div>

          {moduleEnabled && configuredRates <= 0 ? (
            <div className="alert alert-warning">
              Nessun operatore ha ancora percentuali commissione configurate. Vai su <strong>Impostazioni operatori</strong> per
              attivare il calcolo.
            </div>
          ) : null}

          {toggleError ? <div className="alert alert-danger">{toggleError}</div> : null}

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
                          <button
                            type="button"
                            className={`btn btn-sm ${selectedStaffId === row.staffId ? "btn-primary" : "btn-outline-primary"}`}
                            onClick={() => {
                              setToggleError("");
                              setSelectedStaffId(selectedStaffId === row.staffId ? 0 : row.staffId);
                            }}
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
                  onClick={() => {
                    setToggleError("");
                    setSelectedStaffId(0);
                  }}
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
                        <td colSpan={11} className="text-muted p-3">
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
