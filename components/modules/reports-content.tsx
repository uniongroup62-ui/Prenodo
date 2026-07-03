"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Port fedele della pagina report PHP (app/pages/reports.php, ?page=reports).
// Tutti i KPI/grafici/modali sono cablati all'API DB-backed /api/manage/reports:
// - "Incasso" = eventi di incasso (vendite senza rate + acconti + rate pagate),
//   con "Venduto/Lordo" dal riepilogo vendite (come il legacy).
// - Genere/Eta'/Costi/Commissioni calcolati (prima erano hardcoded a zero).
// - I 10 grafici Chart.js vengono disegnati (window.Chart, palette legacy).
// - Raggruppamento auto/giorno/settimana/mese e modalita' di confronto attive.
// - I modali "Mostra altro" sono popolati con ricerca client-side.

type ReportRow = { name: string; type?: string; revenue: number; qty?: number; saleCount?: number };
type Analytics = {
  from: string;
  to: string;
  summary: {
    totalRevenue: number;
    collectionMovements: number;
    soldRevenue: number;
    grossRevenue: number;
    discountTotal: number;
    saleCount: number;
    servedClients: number;
    averageTicket: number;
    appointmentCount: number;
  };
  appointments: { total: number; active: number; pending: number; scheduled: number; done: number; canceled: number; noShow: number; activeClients: number; trend: { day: string; count: number }[] };
  paymentMethods: { label: string; amount: number; count: number; sharePct: number }[];
  clientsArchive: { total: number; male: number; female: number; unknownGender: number; prevalence: string; prevalenceSub: string; birthKnown: number; birthUnknown: number; avgAge: number | null; ageBuckets: { label: string; count: number }[] };
  costs: { total: number; paid: number; open: number } | null;
  commissions: { count: number; total: number; paid: number; open: number } | null;
  composition: { label: string; revenue: number }[];
  comparison: { from: string; to: string; totalRevenue: number; soldRevenue: number; saleCount: number; servedClients: number; averageTicket: number; appointmentCount: number; deltaPct: number } | null;
  daily: { day: string; revenue: number; saleCount: number }[];
  topClients: { clientId: number; name: string; revenue: number; saleCount: number }[];
  topServices: ReportRow[];
  topProducts: ReportRow[];
  topItems: ReportRow[];
  operators: { name: string; revenue: number; saleCount: number; avgTicket: number; hoursWorked: number; apptCount: number }[];
};

type ReportsResponse = {
  ok?: boolean;
  kpis?: { activeSales?: number; revenue?: number; cancelledRevenue?: number; averageTicket?: number; clients?: number; lowStock?: number };
  analytics?: Analytics;
};

// Palette legacy (reports.php:1330).
const CHART_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#64748b", "#ea580c", "#0f766e", "#be123c"];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return `€ ${v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return String(v);
}

function fmtHours(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return `${v.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} h`;
}

function itDate(iso: string): string {
  return iso.split("-").reverse().join("/");
}

// Port di formatDeltaInfo (reports.php 1505-1534): testo + classe del delta.
function deltaInfo(current: number, previous: number, opts: { money?: boolean; requiresBoth?: boolean; goodWhenUp?: boolean } = {}): { text: string; cls: string } {
  const eps = 0.0001;
  const goodWhenUp = opts.goodWhenUp !== false;
  const diff = current - previous;
  if (opts.requiresBoth && (current <= eps || previous <= eps)) {
    return { text: Math.abs(diff) < eps ? "Nessuna variazione" : "Non confrontabile", cls: "text-muted" };
  }
  if (previous < eps) {
    return current > eps
      ? { text: "Nuovo rispetto al confronto", cls: goodWhenUp ? "text-success" : "text-danger" }
      : { text: "Nessuna variazione", cls: "text-muted" };
  }
  if (Math.abs(diff) < eps) return { text: "Nessuna variazione", cls: "text-muted" };
  const pct = (diff / Math.abs(previous)) * 100;
  const sign = diff > 0 ? "+" : "-";
  const value = opts.money ? fmtMoney(Math.abs(diff)) : String(Math.round(Math.abs(diff) * 10) / 10);
  const good = diff > 0 ? goodWhenUp : !goodWhenUp;
  return {
    text: `${sign}${value} (${sign}${Math.abs(pct).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`,
    cls: good ? "text-success" : "text-danger",
  };
}

// Raggruppamento serie per granularita' (auto: <=45gg giorno, <=180 settimana, altrimenti mese).
function groupSeries(rows: { day: string; value: number }[], granularity: string, rangeDays: number): { labels: string[]; values: number[] } {
  const effective = granularity === "auto" ? (rangeDays <= 45 ? "daily" : rangeDays <= 180 ? "weekly" : "monthly") : granularity;
  const keyOf = (day: string): string => {
    if (effective === "monthly") return day.slice(0, 7);
    if (effective === "weekly") {
      const d = new Date(`${day}T00:00:00Z`);
      const dow = (d.getUTCDay() + 6) % 7; // lunedi = 0
      d.setUTCDate(d.getUTCDate() - dow);
      return d.toISOString().slice(0, 10);
    }
    return day;
  };
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row.day);
    map.set(key, (map.get(key) ?? 0) + row.value);
  }
  const keys = Array.from(map.keys()).sort();
  const label = (key: string): string => {
    if (effective === "monthly") return key.split("-").reverse().join("/");
    return itDate(key).slice(0, effective === "daily" ? 5 : 10);
  };
  return { labels: keys.map(label), values: keys.map((key) => Math.round((map.get(key) ?? 0) * 100) / 100) };
}

function granularityLabel(granularity: string, rangeDays: number): string {
  const effective = granularity === "auto" ? (rangeDays <= 45 ? "daily" : rangeDays <= 180 ? "weekly" : "monthly") : granularity;
  return effective === "daily" ? "Per giorno" : effective === "weekly" ? "Per settimana" : "Per mese";
}

export function ReportsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const todayIso = new Date().toISOString().slice(0, 10);
  const monthStartIso = `${todayIso.slice(0, 7)}-01`;

  // Stato filtri (default legacy: mese corrente).
  const [range, setRange] = useState("month_current");
  const [from, setFrom] = useState(monthStartIso);
  const [to, setTo] = useState(todayIso);
  const [granularity, setGranularity] = useState("auto");
  const [compare, setCompare] = useState(false);
  const [compareMode, setCompareMode] = useState("auto");
  const [compareMonth, setCompareMonth] = useState(() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  });
  const [compareFrom, setCompareFrom] = useState(monthStartIso);
  const [compareTo, setCompareTo] = useState(todayIso);

  const [data, setData] = useState<ReportsResponse | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [operatorSearch, setOperatorSearch] = useState("");

  // Preset periodo -> [from, to] (reports.php 47-90).
  const resolveRange = useCallback((): { from: string; to: string } => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const dayMs = 86400000;
    const back = (n: number) => iso(new Date(Date.UTC(y, m, d) - n * dayMs));
    switch (range) {
      case "today": return { from: iso(now), to: iso(now) };
      case "yesterday": return { from: back(1), to: back(1) };
      case "last_7": return { from: back(6), to: iso(now) };
      case "last_30": return { from: back(29), to: iso(now) };
      case "last_90": return { from: back(89), to: iso(now) };
      case "last_180": return { from: back(179), to: iso(now) };
      case "month_previous": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
      case "year_current": return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(now) };
      case "custom": return { from, to };
      case "month_current":
      default: return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
    }
  }, [range, from, to]);

  // Finestra di confronto per modalita' (reports.php 130-219).
  const resolveCompareWindow = useCallback((win: { from: string; to: string }): { from: string; to: string } => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const shiftMonths = (isoDate: string, months: number) => {
      const d = new Date(`${isoDate}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + months);
      return iso(d);
    };
    const shiftYears = (isoDate: string, years: number) => {
      const d = new Date(`${isoDate}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() + years);
      return iso(d);
    };
    const previousPeriod = () => {
      const lenDays = Math.max(1, Math.round((Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / 86400000) + 1);
      const prevTo = new Date(Date.parse(`${win.from}T00:00:00Z`) - 86400000);
      const prevFrom = new Date(prevTo.getTime() - (lenDays - 1) * 86400000);
      return { from: iso(prevFrom), to: iso(prevTo) };
    };
    switch (compareMode) {
      case "previous_year": return { from: shiftYears(win.from, -1), to: shiftYears(win.to, -1) };
      case "month": {
        const [yy, mm] = compareMonth.split("-").map(Number);
        if (yy && mm) {
          const last = new Date(Date.UTC(yy, mm, 0));
          return { from: `${compareMonth}-01`, to: iso(last) };
        }
        return previousPeriod();
      }
      case "custom": return compareFrom <= compareTo ? { from: compareFrom, to: compareTo } : { from: compareTo, to: compareFrom };
      case "auto":
        if (range === "month_current" || range === "month_previous") return { from: shiftMonths(win.from, -1), to: shiftMonths(win.to, -1) };
        if (range === "year_current") return { from: shiftYears(win.from, -1), to: shiftYears(win.to, -1) };
        return previousPeriod();
      case "previous_period":
      default:
        return previousPeriod();
    }
  }, [compareMode, compareMonth, compareFrom, compareTo, range]);

  const load = useCallback(() => {
    const rng = resolveRange();
    const params = new URLSearchParams({ slug, from: rng.from, to: rng.to });
    if (compare) {
      params.set("compare", "1");
      const cw = resolveCompareWindow(rng);
      params.set("compare_from", cw.from);
      params.set("compare_to", cw.to);
    }
    return fetch(`/api/manage/reports?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ReportsResponse) => setData(j))
      .catch(() => setData(null));
  }, [slug, resolveRange, resolveCompareWindow, compare]);

  useEffect(() => {
    load();
  }, [load]);

  const k = data?.kpis ?? {};
  const a = data?.analytics;
  const showCustom = range === "custom";
  const rangeDays = a ? Math.max(1, Math.round((Date.parse(`${a.to}T00:00:00Z`) - Date.parse(`${a.from}T00:00:00Z`)) / 86400000) + 1) : 1;
  const trendBadge = granularityLabel(granularity, rangeDays);

  // --- Grafici Chart.js (window.Chart, come dashboard-content) -----------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartsRef = useRef<Record<string, any>>({});
  useEffect(() => {
    if (!a) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    let stop = false;
    const draw = () => {
      if (stop) return;
      if (!w.Chart) {
        setTimeout(draw, 150);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const make = (id: string, config: any) => {
        const el = document.getElementById(id) as HTMLCanvasElement | null;
        if (!el) return;
        if (chartsRef.current[id]) chartsRef.current[id].destroy();
        chartsRef.current[id] = new w.Chart(el, config);
      };
      const noLegend = { plugins: { legend: { display: false } }, maintainAspectRatio: false, responsive: true };
      const withLegend = { plugins: { legend: { position: "bottom" } }, maintainAspectRatio: false, responsive: true };

      const revenueSeries = groupSeries(a.daily.map((r) => ({ day: r.day, value: r.revenue })), granularity, rangeDays);
      make("reportTrendChart", {
        type: "line",
        data: { labels: revenueSeries.labels, datasets: [{ label: "Incasso", data: revenueSeries.values, borderColor: CHART_COLORS[0], backgroundColor: "rgba(37,99,235,.08)", borderWidth: 2, tension: 0.25, fill: true }] },
        options: noLegend,
      });

      const apptSeries = groupSeries(a.appointments.trend.map((r) => ({ day: r.day, value: r.count })), granularity, rangeDays);
      make("reportAppointmentsTrendChart", {
        type: "line",
        data: { labels: apptSeries.labels, datasets: [{ label: "Prenotazioni", data: apptSeries.values, borderColor: CHART_COLORS[1], backgroundColor: "rgba(22,163,74,.08)", borderWidth: 2, tension: 0.25, fill: true }] },
        options: noLegend,
      });

      make("reportSalesTypesChart", {
        type: "doughnut",
        data: { labels: a.composition.map((c) => c.label), datasets: [{ data: a.composition.map((c) => c.revenue), backgroundColor: CHART_COLORS }] },
        options: withLegend,
      });

      make("reportPaymentMethodsChart", {
        type: "doughnut",
        data: { labels: a.paymentMethods.map((m) => m.label), datasets: [{ data: a.paymentMethods.map((m) => m.amount), backgroundColor: CHART_COLORS }] },
        options: withLegend,
      });

      make("reportGenderChart", {
        type: "doughnut",
        data: { labels: ["Donne", "Uomini", "Non indicato"], datasets: [{ data: [a.clientsArchive.female, a.clientsArchive.male, a.clientsArchive.unknownGender], backgroundColor: [CHART_COLORS[4], CHART_COLORS[0], CHART_COLORS[6]] }] },
        options: withLegend,
      });

      make("reportAgeChart", {
        type: "bar",
        data: { labels: a.clientsArchive.ageBuckets.map((b) => b.label), datasets: [{ label: "Clienti", data: a.clientsArchive.ageBuckets.map((b) => b.count), backgroundColor: CHART_COLORS[5] }] },
        options: noLegend,
      });

      const hbar = (labels: string[], values: number[], color: string) => ({
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: color }] },
        options: { ...noLegend, indexAxis: "y" },
      });
      make("reportClientsChart", hbar(a.topClients.slice(0, 10).map((c) => c.name), a.topClients.slice(0, 10).map((c) => c.revenue), CHART_COLORS[0]));
      make("reportItemsChart", hbar(a.topItems.slice(0, 10).map((i) => i.name), a.topItems.slice(0, 10).map((i) => i.revenue), CHART_COLORS[2]));
      make("reportOperatorsChart", hbar(a.operators.slice(0, 10).map((o) => o.name), a.operators.slice(0, 10).map((o) => o.revenue), CHART_COLORS[4]));

      make("reportFinanceChart", {
        type: "bar",
        data: {
          labels: ["Incasso", "Costi", "Commissioni"],
          datasets: [{ data: [a.summary.totalRevenue, a.costs?.total ?? 0, a.commissions?.total ?? 0], backgroundColor: [CHART_COLORS[1], CHART_COLORS[3], CHART_COLORS[2]] }],
        },
        options: noLegend,
      });
    };
    draw();
    return () => {
      stop = true;
    };
  }, [a, granularity, rangeDays]);

  const arch = a?.clientsArchive;
  const rng = resolveRange();
  const compareWindow = compare ? resolveCompareWindow(rng) : null;
  const filteredClients = (a?.topClients ?? []).filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase()));
  const filteredItems = (a?.topItems ?? []).filter((i) => `${i.name} ${i.type ?? ""}`.toLowerCase().includes(itemSearch.toLowerCase()));
  const filteredOperators = (a?.operators ?? []).filter((o) => o.name.toLowerCase().includes(operatorSearch.toLowerCase()));

  const incassoDelta = a?.comparison ? deltaInfo(a.summary.totalRevenue, a.comparison.totalRevenue, { money: true }) : null;
  const venditeDelta = a?.comparison ? deltaInfo(a.summary.saleCount, a.comparison.saleCount) : null;
  const ticketDelta = a?.comparison ? deltaInfo(a.summary.averageTicket, a.comparison.averageTicket, { money: true, requiresBoth: true }) : null;
  const clientiDelta = a?.comparison ? deltaInfo(a.summary.servedClients, a.comparison.servedClients) : null;
  const prenotazioniDelta = a?.comparison ? deltaInfo(a.summary.appointmentCount, a.comparison.appointmentCount) : null;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/reports.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Analisi</div>
          <h1 className="bs-page-title">Report</h1>
          <div className="bs-page-subtitle">{a ? `Periodo ${itDate(a.from)} – ${itDate(a.to)}` : "Statistiche vendite del periodo"}</div>
        </div>
      </div>

      <div className="report-filter-card p-3 mb-3">
        <form
          method="get"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <input type="hidden" name="page" value="reports" />
          <div className="report-filter-grid">
            <div className="report-filter-field">
              <label className="form-label small text-muted" htmlFor="reportRange">
                Periodo dati
              </label>
              <select
                className="form-select"
                name="range"
                id="reportRange"
                value={range}
                onChange={(e) => setRange(e.target.value)}
              >
                <option value="today">Oggi</option>
                <option value="yesterday">Ieri</option>
                <option value="last_7">Ultimi 7 giorni</option>
                <option value="last_30">Ultimi 30 giorni</option>
                <option value="last_90">Ultimi 90 giorni</option>
                <option value="last_180">Ultimi 180 giorni</option>
                <option value="month_current">Mese corrente</option>
                <option value="month_previous">Mese precedente</option>
                <option value="year_current">Anno corrente</option>
                <option value="custom">Personalizzato</option>
              </select>
            </div>
            <div className={`report-filter-field${showCustom ? "" : " d-none"}`} data-report-custom-group>
              <label className="form-label small text-muted">Dal</label>
              <input
                className="form-control"
                type="date"
                name="from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                data-report-custom-date
              />
            </div>
            <div className={`report-filter-field${showCustom ? "" : " d-none"}`} data-report-custom-group>
              <label className="form-label small text-muted">Al</label>
              <input
                className="form-control"
                type="date"
                name="to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                data-report-custom-date
              />
            </div>
            <div className="report-filter-field">
              <label className="form-label small text-muted" htmlFor="reportGranularity">
                Raggruppamento grafici
              </label>
              <select
                className="form-select"
                name="granularity"
                id="reportGranularity"
                value={granularity}
                onChange={(e) => setGranularity(e.target.value)}
              >
                <option value="auto">Automatico</option>
                <option value="daily">Per giorno</option>
                <option value="weekly">Per settimana</option>
                <option value="monthly">Per mese</option>
              </select>
            </div>
            <div className="report-filter-actions">
              <div className="form-check report-filter-switch">
                <input
                  className="form-check-input"
                  type="checkbox"
                  name="compare"
                  value="1"
                  id="reportCompare"
                  checked={compare}
                  onChange={(e) => setCompare(e.target.checked)}
                />
                <label className="form-check-label small fw-semibold" htmlFor="reportCompare">
                  Confronta
                </label>
              </div>
              <button className="btn btn-outline-primary w-100" type="submit">
                <i className="bi bi-arrow-clockwise me-1" />
                Aggiorna
              </button>
            </div>
          </div>

          <div
            className="report-filter-summary report-filter-summary-bar mt-2"
            data-report-period-summary
            data-from={rng.from}
            data-to={rng.to}
          >
            <span>
              Periodo selezionato: <strong data-report-period-label>{itDate(rng.from)} - {itDate(rng.to)}</strong>
            </span>
            <span>{granularity === "auto" ? "Raggruppamento automatico" : trendBadge}</span>
          </div>

          <div className={`report-filter-section${compare ? "" : " d-none"}`} data-report-compare-panel>
            <div className="report-filter-grid is-compare">
              <div className="report-filter-field">
                <label className="form-label small text-muted" htmlFor="reportCompareMode">
                  Confronta con
                </label>
                <select
                  className="form-select"
                  name="compare_mode"
                  id="reportCompareMode"
                  value={compareMode}
                  onChange={(e) => setCompareMode(e.target.value)}
                >
                  <option value="auto">Automatico</option>
                  <option value="previous_period">Stesso periodo precedente</option>
                  <option value="previous_year">Stesso periodo anno precedente</option>
                  <option value="month">Scegli mese</option>
                  <option value="custom">Periodo personalizzato</option>
                </select>
              </div>
              <div
                className={`report-filter-field${compareMode === "month" ? "" : " d-none"}`}
                data-report-compare-month
              >
                <label className="form-label small text-muted">Mese confronto</label>
                <input
                  className="form-control"
                  type="month"
                  name="compare_month"
                  value={compareMonth}
                  onChange={(e) => setCompareMonth(e.target.value)}
                  data-report-compare-month-input
                />
              </div>
              <div
                className={`report-filter-field${compareMode === "custom" ? "" : " d-none"}`}
                data-report-compare-custom
              >
                <label className="form-label small text-muted">Confronto dal</label>
                <input
                  className="form-control"
                  type="date"
                  name="compare_from"
                  value={compareFrom}
                  onChange={(e) => setCompareFrom(e.target.value)}
                  data-report-compare-custom-date
                />
              </div>
              <div
                className={`report-filter-field${compareMode === "custom" ? "" : " d-none"}`}
                data-report-compare-custom
              >
                <label className="form-label small text-muted">Confronto al</label>
                <input
                  className="form-control"
                  type="date"
                  name="compare_to"
                  value={compareTo}
                  onChange={(e) => setCompareTo(e.target.value)}
                  data-report-compare-custom-date
                />
              </div>
              <div className="report-filter-summary align-self-end pb-2">
                Confronto effettivo:{" "}
                <strong data-report-compare-effective>
                  {compareWindow ? `${itDate(compareWindow.from)} - ${itDate(compareWindow.to)}` : "—"}
                </strong>
              </div>
            </div>
          </div>
        </form>
      </div>

      <div className="report-kpi-grid mb-3">
        <div className="report-kpi">
          <div className="label">Incasso</div>
          <div className="value">{fmtMoney(a?.summary.totalRevenue)}</div>
          <div className="sub">
            Venduto {fmtMoney(a?.summary.soldRevenue)} / Lordo {fmtMoney(a?.summary.grossRevenue)}
          </div>
          <div className="sub">Movimenti incasso {fmtInt(a?.summary.collectionMovements)}</div>
          {incassoDelta ? <div className={`sub ${incassoDelta.cls}`}>{incassoDelta.text}</div> : null}
        </div>
        <div className="report-kpi">
          <div className="label">Vendite</div>
          <div className="value">{fmtInt(a?.summary.saleCount)}</div>
          <div className="sub">Periodo selezionato</div>
          {venditeDelta ? <div className={`sub ${venditeDelta.cls}`}>{venditeDelta.text}</div> : null}
        </div>
        <div className="report-kpi">
          <div className="label">Scontrino medio</div>
          <div className="value">{fmtMoney(a?.summary.averageTicket)}</div>
          <div className="sub">Periodo selezionato</div>
          {ticketDelta ? <div className={`sub ${ticketDelta.cls}`}>{ticketDelta.text}</div> : null}
        </div>
        <div className="report-kpi">
          <div className="label">Clienti serviti</div>
          <div className="value">{fmtInt(a?.summary.servedClients)}</div>
          <div className="sub">Clienti associati alle vendite</div>
          {clientiDelta ? <div className={`sub ${clientiDelta.cls}`}>{clientiDelta.text}</div> : null}
        </div>
      </div>

      <div className="report-kpi-grid mb-3">
        <div className="report-kpi">
          <div className="label">Prenotazioni</div>
          <div className="value">{fmtInt(a?.summary.appointmentCount)}</div>
          <div className="sub">Non annullate nel periodo</div>
          <div className="sub">
            In attesa {fmtInt(a?.appointments.pending)} / Prenotate {fmtInt(a?.appointments.scheduled)} / Eseguite {fmtInt(a?.appointments.done)} / Annullate {fmtInt(a?.appointments.canceled)} / No show {fmtInt(a?.appointments.noShow)}
          </div>
          {prenotazioniDelta ? <div className={`sub ${prenotazioniDelta.cls}`}>{prenotazioniDelta.text}</div> : null}
        </div>
        <div className="report-kpi">
          <div className="label">Clienti in archivio</div>
          <div className="value">{fmtInt(arch?.total ?? k.clients)}</div>
          <div className="sub">Profilo clienti</div>
        </div>
        <div className="report-kpi">
          <div className="label">Genere prevalente</div>
          <div className="value">{arch?.prevalence ?? "Non indicato"}</div>
          <div className="sub">
            Donne {fmtInt(arch?.female)} / Uomini {fmtInt(arch?.male)} / Non indicato {fmtInt(arch?.unknownGender ?? k.clients)}
          </div>
          <div className="sub">{arch?.prevalenceSub ?? "Nessun genere indicato"}</div>
        </div>
        <div className="report-kpi">
          <div className="label">Et&agrave; media</div>
          <div className="value">{arch && arch.avgAge !== null ? `${arch.avgAge} anni` : "N/D"}</div>
          <div className="sub">Con data {fmtInt(arch?.birthKnown)} / Senza data {fmtInt(arch?.birthUnknown ?? k.clients)}</div>
        </div>
      </div>

      {(a?.costs || a?.commissions) ? (
        <div className="report-kpi-grid mb-3">
          {a?.costs ? (
            <div className="report-kpi">
              <div className="label">Costi</div>
              <div className="value">{fmtMoney(a.costs.total)}</div>
              <div className="sub">Residuo {fmtMoney(a.costs.open)}</div>
            </div>
          ) : null}
          {a?.commissions ? (
            <div className="report-kpi">
              <div className="label">Commissioni</div>
              <div className="value">{fmtMoney(a.commissions.total)}</div>
              <div className="sub">Da pagare {fmtMoney(a.commissions.open)}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Date-filtered analytics (top clients / operators / services / products + daily trend). */}
      <div className="row g-3 mb-3">
        <div className="col-xl-6">
          <div className="report-panel p-3">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <div className="fw-semibold">Migliori clienti</div>
              <button className="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="modal" data-bs-target="#reportClientsModal">Mostra altro</button>
            </div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Cliente</th><th className="text-end">Vendite</th><th className="text-end">Incasso</th></tr></thead>
                <tbody>
                  {(a?.topClients ?? []).length === 0 ? (
                    <tr><td colSpan={3} className="text-muted p-2">Nessun dato nel periodo.</td></tr>
                  ) : (
                    (a?.topClients ?? []).slice(0, 10).map((c) => (
                      <tr key={`${c.clientId}-${c.name}`}><td>{c.name}</td><td className="text-end">{c.saleCount}</td><td className="text-end">{fmtMoney(c.revenue)}</td></tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="col-xl-6">
          <div className="report-panel p-3">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <div className="fw-semibold">Operatori</div>
              <button className="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="modal" data-bs-target="#reportOperatorsModal">Mostra altro</button>
            </div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Operatore</th><th className="text-end">Ore lavorate</th><th className="text-end">Vendite</th><th className="text-end">Incasso</th></tr></thead>
                <tbody>
                  {(a?.operators ?? []).length === 0 ? (
                    <tr><td colSpan={4} className="text-muted p-2">Nessun dato nel periodo.</td></tr>
                  ) : (
                    (a?.operators ?? []).slice(0, 10).map((o) => (
                      <tr key={o.name}><td>{o.name}</td><td className="text-end">{fmtHours(o.hoursWorked)}</td><td className="text-end">{o.saleCount}</td><td className="text-end">{fmtMoney(o.revenue)}</td></tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="col-xl-6">
          <div className="report-panel p-3">
            <div className="fw-semibold mb-2">Servizi più venduti</div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Servizio</th><th className="text-end">Qtà</th><th className="text-end">Incasso</th></tr></thead>
                <tbody>
                  {(a?.topServices ?? []).length === 0 ? (
                    <tr><td colSpan={3} className="text-muted p-2">Nessun dato nel periodo.</td></tr>
                  ) : (
                    (a?.topServices ?? []).map((s) => (
                      <tr key={s.name}><td>{s.name}</td><td className="text-end">{s.qty ?? 0}</td><td className="text-end">{fmtMoney(s.revenue)}</td></tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="col-xl-6">
          <div className="report-panel p-3">
            <div className="fw-semibold mb-2">Prodotti più venduti</div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Prodotto</th><th className="text-end">Qtà</th><th className="text-end">Incasso</th></tr></thead>
                <tbody>
                  {(a?.topProducts ?? []).length === 0 ? (
                    <tr><td colSpan={3} className="text-muted p-2">Nessun dato nel periodo.</td></tr>
                  ) : (
                    (a?.topProducts ?? []).map((s) => (
                      <tr key={s.name}><td>{s.name}</td><td className="text-end">{s.qty ?? 0}</td><td className="text-end">{fmtMoney(s.revenue)}</td></tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="col-12">
          <div className="report-panel p-3">
            <div className="fw-semibold mb-2">Andamento incasso per giorno</div>
            <div className="table-responsive" style={{ maxHeight: 240, overflowY: "auto" }}>
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Giorno</th><th className="text-end">Movimenti</th><th className="text-end">Incasso</th></tr></thead>
                <tbody>
                  {(a?.daily ?? []).length === 0 ? (
                    <tr><td colSpan={3} className="text-muted p-2">Nessuna vendita nel periodo.</td></tr>
                  ) : (
                    (a?.daily ?? []).map((row) => {
                      const [yy, mm, dd] = row.day.split("-");
                      return (<tr key={row.day}><td>{dd}/{mm}/{yy}</td><td className="text-end">{row.saleCount}</td><td className="text-end">{fmtMoney(row.revenue)}</td></tr>);
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-xl-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Andamento incasso</div>
              <span className="badge text-bg-light">{trendBadge}</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportTrendChart" aria-label="Andamento incasso" />
            </div>
          </div>
        </div>
        <div className="col-xl-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Andamento prenotazioni</div>
              <span className="badge text-bg-light">{trendBadge}</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportAppointmentsTrendChart" aria-label="Andamento prenotazioni" />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Tipologie di vendita</div>
              <span className="badge text-bg-light">Tipologia</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportSalesTypesChart" aria-label="Tipologie di vendita" />
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Metodi di pagamento</div>
              <span className="badge text-bg-light">Importi</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportPaymentMethodsChart" aria-label="Metodi di pagamento" />
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Clienti per genere</div>
              <span className="badge text-bg-light">Archivio</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportGenderChart" aria-label="Clienti per genere" />
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Clienti per et&agrave;</div>
              <span className="badge text-bg-light">Fasce</span>
            </div>
            <div className="report-chart-wrap">
              <canvas id="reportAgeChart" aria-label="Clienti per eta" />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Top clienti</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              <canvas id="reportClientsChart" aria-label="Top clienti" />
            </div>
          </div>
        </div>
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Top servizi e prodotti</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              <canvas id="reportItemsChart" aria-label="Top servizi e prodotti" />
            </div>
          </div>
        </div>
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Operatori</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              <canvas id="reportOperatorsChart" aria-label="Operatori" />
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-12">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold">Incasso e costi</div>
              <span className="badge text-bg-light">Periodo</span>
            </div>
            <div className="report-finance-layout">
              <div className="report-chart-wrap is-compact">
                <canvas id="reportFinanceChart" aria-label="Incasso e costi" />
              </div>
              <div className="report-finance-summary">
                <div className="report-finance-line">
                  <div>
                    <div className="report-finance-label">Incasso</div>
                    <div className="report-finance-sub">
                      Movimenti {fmtInt(a?.summary.collectionMovements)} / Venduto {fmtMoney(a?.summary.soldRevenue)} / Scontrino medio{" "}
                      {fmtMoney(a?.summary.averageTicket)}
                    </div>
                  </div>
                  <div className="report-finance-value">{fmtMoney(a?.summary.totalRevenue)}</div>
                </div>
                <div className="report-finance-line">
                  <div>
                    <div className="report-finance-label">Costi</div>
                    <div className="report-finance-sub">Pagato {fmtMoney(a?.costs?.paid)} / Residuo {fmtMoney(a?.costs?.open)}</div>
                  </div>
                  <div className="report-finance-value">{fmtMoney(a?.costs?.total)}</div>
                </div>
                <div className="report-finance-line">
                  <div>
                    <div className="report-finance-label">Commissioni</div>
                    <div className="report-finance-sub">Pagate {fmtMoney(a?.commissions?.paid)} / Da pagare {fmtMoney(a?.commissions?.open)}</div>
                  </div>
                  <div className="report-finance-value">{fmtMoney(a?.commissions?.total)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="modal fade report-more-modal"
        id="reportClientsModal"
        tabIndex={-1}
        aria-labelledby="reportClientsModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title" id="reportClientsModalLabel">
                  Top clienti
                </h5>
                <div className="small text-muted" data-report-modal-count>
                  {filteredClients.length} risultati
                </div>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="report-modal-search mb-3">
                <label className="form-label small text-muted" htmlFor="reportClientsSearch">
                  Cerca cliente
                </label>
                <input
                  className="form-control"
                  id="reportClientsSearch"
                  type="search"
                  placeholder="Nome cliente..."
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  data-report-modal-search
                />
              </div>
              <div className="report-modal-table-wrap">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th className="text-muted">#</th>
                      <th>Cliente</th>
                      <th className="text-end">Vendite</th>
                      <th className="text-end">Totale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClients.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-muted p-3">
                          {clientSearch ? "Nessun risultato trovato." : "Nessun dato."}
                        </td>
                      </tr>
                    ) : (
                      filteredClients.map((c, i) => (
                        <tr key={`${c.clientId}-${c.name}`}>
                          <td className="text-muted">{i + 1}</td>
                          <td>{c.name}</td>
                          <td className="text-end">{c.saleCount}</td>
                          <td className="text-end">{fmtMoney(c.revenue)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="modal fade report-more-modal"
        id="reportItemsModal"
        tabIndex={-1}
        aria-labelledby="reportItemsModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title" id="reportItemsModalLabel">
                  Top servizi e prodotti
                </h5>
                <div className="small text-muted" data-report-modal-count>
                  {filteredItems.length} risultati
                </div>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="report-modal-search mb-3">
                <label className="form-label small text-muted" htmlFor="reportItemsSearch">
                  Cerca servizio o prodotto
                </label>
                <input
                  className="form-control"
                  id="reportItemsSearch"
                  type="search"
                  placeholder="Nome, tipo..."
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  data-report-modal-search
                />
              </div>
              <div className="report-modal-table-wrap">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th className="text-muted">#</th>
                      <th>Voce</th>
                      <th>Tipo</th>
                      <th className="text-end">Quantità</th>
                      <th className="text-end">Vendite</th>
                      <th className="text-end">Totale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted p-3">
                          {itemSearch ? "Nessun risultato trovato." : "Nessun dato."}
                        </td>
                      </tr>
                    ) : (
                      filteredItems.map((it, i) => (
                        <tr key={`${it.type}-${it.name}`}>
                          <td className="text-muted">{i + 1}</td>
                          <td>{it.name}</td>
                          <td>{it.type ?? "Voce"}</td>
                          <td className="text-end">{it.qty ?? 0}</td>
                          <td className="text-end">{it.saleCount ?? 0}</td>
                          <td className="text-end">{fmtMoney(it.revenue)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="modal fade report-more-modal"
        id="reportOperatorsModal"
        tabIndex={-1}
        aria-labelledby="reportOperatorsModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title" id="reportOperatorsModalLabel">
                  Operatori
                </h5>
                <div className="small text-muted" data-report-modal-count>
                  {filteredOperators.length} risultati
                </div>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="report-modal-search mb-3">
                <label className="form-label small text-muted" htmlFor="reportOperatorsSearch">
                  Cerca operatore
                </label>
                <input
                  className="form-control"
                  id="reportOperatorsSearch"
                  type="search"
                  placeholder="Nome operatore..."
                  value={operatorSearch}
                  onChange={(e) => setOperatorSearch(e.target.value)}
                  data-report-modal-search
                />
              </div>
              <div className="report-modal-table-wrap">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th className="text-muted">#</th>
                      <th>Operatore</th>
                      <th className="text-end">Ore lavorate</th>
                      <th className="text-end">App.</th>
                      <th className="text-end">Vendite</th>
                      <th className="text-end">Scontrino medio</th>
                      <th className="text-end">Totale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOperators.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-muted p-3">
                          {operatorSearch ? "Nessun risultato trovato." : "Nessun dato."}
                        </td>
                      </tr>
                    ) : (
                      filteredOperators.map((o, i) => (
                        <tr key={o.name}>
                          <td className="text-muted">{i + 1}</td>
                          <td>{o.name}</td>
                          <td className="text-end">{fmtHours(o.hoursWorked)}</td>
                          <td className="text-end">{o.apptCount}</td>
                          <td className="text-end">{o.saleCount}</td>
                          <td className="text-end">{fmtMoney(o.avgTicket)}</td>
                          <td className="text-end">{fmtMoney(o.revenue)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
