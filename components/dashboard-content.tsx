"use client";

import { useEffect, useRef, useState } from "react";

// Faithful port of the PHP dashboard main content (app/pages/dashboard.php +
// assets/js/pages/dashboard.js), fed by the existing /api/manage/dashboard.

type Metric = { label: string; value: string; detail: string };
type WeeklyMetric = { label: string; value: string; deltaPct: number | null };
type SeriesPoint = { date: string; label: string; revenue: number };
// Grouped dashboard "Avvisi" alert — faithful port of the legacy $alerts[] item.
type DashboardAlert = {
  key: string;
  kind: "warning" | "info" | "danger";
  icon: string;
  title: string;
  text: string;
  link: string;
  linkLabel: string;
  lines?: string[];
  linesMore?: number;
};
type DashboardData = {
  stats: Metric[];
  weekly: { range: string; metrics: WeeklyMetric[]; series: SeriesPoint[] };
  // Banner fail-closed sede (dashboard.php 473-477).
  locationFailClosed?: boolean;
  // null = permesso calendar.view mancante (card nascosta, come il legacy).
  upcoming: Appt[] | null;
  alerts: DashboardAlert[];
  // null = permessi costs.manage/costs.items mancanti (card nascosta).
  costs: {
    overdueAmount: number;
    monthAmount: number;
    overdueCount: number;
    monthCount: number;
    overdueFrom: string;
    overdueTo: string;
    monthFrom: string;
    monthTo: string;
  } | null;
};
type Appt = { date?: string; clientName?: string; serviceName?: string };

const OVERVIEW_ICONS = ["people", "calendar-check", "cash-coin"];
const WEEKLY_ICONS = ["calendar-check", "cash-coin", "clock", "person-plus"];

function euro(value: string): string {
  const m = /^(.+?)\s*euro$/i.exec(value);
  return m ? `€ ${m[1]}` : value;
}
function fmtEuro(n: number): string {
  return `€ ${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// fmtEUR di dashboard.js: Intl currency it-IT (tooltip grafico, nel browser).
function fmtEurCurrency(v: number): string {
  try {
    return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(v || 0);
  } catch {
    return `€ ${v || 0}`;
  }
}
// axisEUR di dashboard.js: "€ " + Intl it-IT senza decimali (asse Y).
function axisEur(v: number): string {
  try {
    return `€ ${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(Number(v || 0))}`;
  } catch {
    return `€ ${v || 0}`;
  }
}
// Port di setDelta (dashboard.js:30-41): verde >0, rosso <0, muted per 0/null.
function deltaClass(deltaPct: number | null): string {
  if (deltaPct === null || deltaPct === 0) return "text-muted";
  return deltaPct > 0 ? "text-success" : "text-danger";
}
// setDelta: arrotonda a 1 decimale, virgola come separatore ("+12,5%").
function deltaText(deltaPct: number | null): string {
  if (deltaPct === null) return "—";
  const rounded = Math.round(deltaPct * 10) / 10;
  return `${deltaPct > 0 ? "+" : ""}${String(rounded).replace(".", ",")}%`;
}

export function DashboardContent({ slug, sedeName }: { slug: string; sedeName?: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  // Auth::requirePerm legacy (Auth.php 494-505): 403 → pagina 'Accesso negato'
  // (solo la card nel chrome, nessun contenuto dashboard).
  const [accessDenied, setAccessDenied] = useState(false);
  // Port di setPerfError (dashboard.js:42-52,83-85): messaggio d'errore dedicato
  // per il grafico quando Chart.js non è disponibile.
  const [chartError, setChartError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/manage/dashboard", { headers: { "x-tenant-slug": location.pathname.split("/")[1] || "" } })
      .then(async (r) => ({ status: r.status, json: await r.json() }))
      .then(({ status, json }) => {
        if (cancelled) return;
        if (status === 403) setAccessDenied(true);
        else if (json.ok === false) setError(json.error || "Errore dashboard.");
        else setData(json);
      })
      .catch(() => !cancelled && setError("Errore dashboard."));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    let stop = false;
    // Attesa di Chart.js con LIMITE (~3s): oltre il quale mostra il fallback
    // legacy invece di ritentare in silenzio all'infinito.
    let attempts = 0;
    const draw = () => {
      if (stop) return;
      if (!w.Chart) {
        if (attempts++ >= 20) {
          setChartError("Grafico non disponibile al momento.");
          return;
        }
        setTimeout(draw, 150);
        return;
      }
      setChartError("");
      if (chartRef.current) chartRef.current.destroy();
      chartRef.current = new w.Chart(canvasRef.current, {
        type: "line",
        data: {
          labels: data.weekly.series.map((p) => p.label),
          datasets: [
            {
              label: "Ricavi",
              data: data.weekly.series.map((p) => p.revenue),
              borderColor: "#2f63f4",
              backgroundColor: "rgba(47,99,244,.08)",
              pointBackgroundColor: "#2f63f4",
              pointBorderColor: "#2f63f4",
              pointRadius: 2.5,
              pointHoverRadius: 4,
              borderWidth: 2.25,
              tension: 0.4,
              fill: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tooltip: { callbacks: { label: (ctx: any) => fmtEurCurrency(ctx.parsed.y || 0) } },
          },
          scales: {
            x: { grid: { color: "rgba(18,44,88,.09)", drawBorder: false }, ticks: { color: "#405693" } },
            y: {
              beginAtZero: true,
              grid: { color: "rgba(18,44,88,.11)", borderDash: [3, 4], drawBorder: false },
              ticks: { color: "#405693", padding: 10, callback: (v: number) => axisEur(v) },
            },
          },
        },
      });
    };
    draw();
    return () => {
      stop = true;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [data]);

  const upcoming = data?.upcoming ?? null;
  const alerts = data?.alerts ?? [];

  // Port della pagina 403 di Auth::requirePerm: solo la card 'Accesso negato'
  // nel chrome, senza page header Dashboard.
  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Non hai i permessi per accedere a questa sezione.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Panoramica</div>
          <h1 className="bs-page-title">Dashboard</h1>
          <div className="bs-page-subtitle">
            Stato generale della sede, appuntamenti, vendite e attività recenti.{sedeName ? ` Sede: ${sedeName}` : ""}
          </div>
        </div>
      </div>

      <section className="dashboard-page">
        {error ? <div className="alert alert-warning">{error}</div> : null}
        {/* Banner fail-closed verbatim (dashboard.php 473-477): sede non valida
            o non selezionata -> dati azzerati + avviso in testa. */}
        {data?.locationFailClosed ? (
          <div className="alert alert-warning py-2 mb-3">
            Seleziona una sede valida per visualizzare i dati della dashboard.
          </div>
        ) : null}

        <div className="row g-3 dashboard-overview-grid">
          {(data?.stats ?? []).map((stat, i) => (
            <div className="col-md-4" key={stat.label}>
              <div className="card dashboard-card dashboard-overview-card">
                <div className="kpi">
                  <div className="icon">
                    <i className={`bi bi-${OVERVIEW_ICONS[i] ?? "bar-chart"} fs-5`} />
                  </div>
                  <div>
                    <div className="label">{stat.label}</div>
                    <div className="value">{euro(stat.value)}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="row g-3 dashboard-layout">
          <div className="col-xl-9 col-lg-8">
            <div className="card dashboard-card dashboard-weekly-card">
              <div className="card-header dashboard-card-header fw-semibold d-flex align-items-center gap-2">
                <span className="dashboard-card-title">
                  <i className="bi bi-activity" />
                  <span>Statistica settimanale</span>
                </span>
              </div>
              <div className="card-body dashboard-weekly-body">
                <div className="row g-0 dashboard-weekly-kpis">
                  {(data?.weekly.metrics ?? []).map((metric, i) => (
                    <div className="col-sm-6 col-xl-3 dashboard-weekly-kpi-col" key={metric.label}>
                      <div className="dashboard-weekly-kpi h-100">
                        <div className="d-flex justify-content-between align-items-start">
                          <div>
                            <div className="text-muted small">{metric.label}</div>
                            <div className="h4 fw-bold mb-0">{euro(metric.value)}</div>
                          </div>
                          <div className="text-muted">
                            <i className={`bi bi-${WEEKLY_ICONS[i] ?? "bar-chart"}`} />
                          </div>
                        </div>
                        <div className={`small mt-1 ${deltaClass(metric.deltaPct)}`}>{deltaText(metric.deltaPct)}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="dashboard-chart-area">
                  <div className="dashboard-chart-meta d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div className="small text-muted">Andamento ricavi (giornaliero)</div>
                    <div className="small text-muted">{data?.weekly.range}</div>
                  </div>
                  {/* Port di #perfError (dashboard.php:523): avviso inline se il grafico
                      non è disponibile. */}
                  {chartError ? (
                    <div className="alert alert-warning py-2" role="alert">
                      {chartError}
                    </div>
                  ) : null}
                  <div className="dashboard-chart-canvas">
                    <canvas ref={canvasRef} id="perfChart" height={120} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-xl-3 col-lg-4">
            <div className="dashboard-side-stack">
              {upcoming !== null ? (
                <div className="card dashboard-card dashboard-side-card dashboard-upcoming-card">
                  <div className="card-header dashboard-card-header fw-semibold d-flex justify-content-between align-items-center">
                    <span className="dashboard-card-title">
                      <i className="bi bi-clock" />
                      <span>Prossimi appuntamenti</span>
                    </span>
                    <a className="btn btn-sm btn-outline-secondary" href={`/${slug}/calendar`}>
                      <i className="bi bi-calendar3 me-1" />
                      Calendario
                    </a>
                  </div>
                  <div className="table-responsive">
                    <table className="table dashboard-table mb-0">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Cliente</th>
                          <th>Servizio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {upcoming.length === 0 ? (
                          <tr>
                            <td colSpan={3} className="dashboard-empty-cell">
                              <div className="dashboard-empty-state">
                                <i className="bi bi-calendar2-week" />
                                <span>Nessun appuntamento in arrivo</span>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          upcoming.map((appt, i) => (
                            <tr key={i}>
                              <td>{appt.date ?? "—"}</td>
                              {/* Classi celle legacy (dashboard.php 617-618). */}
                              <td className="fw-semibold">{appt.clientName ?? "—"}</td>
                              <td className="text-muted">{appt.serviceName ?? "—"}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <div className="card dashboard-card dashboard-side-card dashboard-alerts">
                <div className="card-header dashboard-card-header fw-semibold d-flex justify-content-between align-items-center">
                  <span className="dashboard-card-title">
                    <i className="bi bi-bell" />
                    <span>Avvisi</span>
                  </span>
                  {alerts.length > 0 ? <span className="badge text-bg-secondary">{alerts.length}</span> : null}
                </div>

                {alerts.length === 0 ? (
                  <div className="p-3 text-muted">Nessun avviso.</div>
                ) : (
                  <div className="list-group list-group-flush dashboard-alert-list">
                    {alerts.map((al, i) => (
                      <div className="list-group-item dashboard-alert-item" key={al.key ?? i}>
                        <div className="d-flex justify-content-between align-items-start gap-3">
                          <div className="d-flex align-items-start gap-2">
                            <i className={`bi ${al.icon} text-${al.kind}`} />
                            <div>
                              <div className="fw-semibold">{al.title}</div>
                              <div className="small text-muted">{al.text}</div>

                              {al.lines && al.lines.length > 0 ? (
                                <div className="small text-muted mt-1">
                                  {al.lines.map((line, li) => (
                                    <div key={li}>• {line}</div>
                                  ))}
                                  {/* staff_off usa il blocco dedicato legacy "…e altri"
                                      (maschile, dashboard.php:668); gli altri gruppi il
                                      generico "…e altre" (dashboard.php:654). */}
                                  {al.linesMore && al.linesMore > 0 ? (
                                    <div>{al.key === "staff_off" ? "…e altri" : "…e altre"} {al.linesMore}</div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div>
                            <a className="btn btn-sm btn-outline-secondary" href={al.link}>
                              {al.linkLabel || "Apri"}
                            </a>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {data?.costs ? (
                <div className="card dashboard-card dashboard-side-card dashboard-costs">
                  <div className="card-header dashboard-card-header fw-semibold d-flex justify-content-between align-items-center">
                    <span className="dashboard-card-title">
                      <i className="bi bi-calendar2-check" />
                      <span>Scadenziario e Costi</span>
                    </span>
                    <a className="btn btn-sm btn-outline-secondary" href={`/${slug}/costs`}>
                      <i className="bi bi-box-arrow-up-right me-1" />
                      Apri
                    </a>
                  </div>
                  <div className="card-body dashboard-costs-body">
                    <div className="row g-3">
                      <div className="col-6">
                        <div className="text-muted small">Scaduti</div>
                        <div className="h5 fw-bold mb-0">{fmtEuro(data.costs.overdueAmount)}</div>
                        <div className="small text-muted">{data.costs.overdueCount} voci</div>
                        <a
                          className="small dashboard-link-action"
                          href={`/${slug}/costs?tab=scadenziario&status=open&from=${data.costs.overdueFrom}&to=${data.costs.overdueTo}`}
                        >
                          Vedi scaduti
                        </a>
                      </div>
                      <div className="col-6">
                        <div className="text-muted small">Questo mese</div>
                        <div className="h5 fw-bold mb-0">{fmtEuro(data.costs.monthAmount)}</div>
                        <div className="small text-muted">{data.costs.monthCount} voci</div>
                        <a
                          className="small dashboard-link-action"
                          href={`/${slug}/costs?tab=scadenziario&status=open&from=${data.costs.monthFrom}&to=${data.costs.monthTo}`}
                        >
                          Vedi mese
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
