"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InfoBox from "./info-box";

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
  comparison: { from: string; to: string; totalRevenue: number; soldRevenue: number; saleCount: number; servedClients: number; averageTicket: number; appointmentCount: number; deltaPct: number; costsTotal: number | null; commissionsTotal: number | null; windowClients: number; newClients: number; clientsArchiveTotal: number; daily: { day: string; revenue: number; saleCount: number }[]; appointmentTrend: { day: string; count: number }[] } | null;
  clientsArchivePeriodEnd: number;
  daily: { day: string; revenue: number; saleCount: number }[];
  topClients: { clientId: number; name: string; revenue: number; saleCount: number }[];
  topServices: ReportRow[];
  topProducts: ReportRow[];
  topItems: ReportRow[];
  operators: { name: string; revenue: number; saleCount: number; avgTicket: number; hoursWorked: number; apptCount: number }[];
  newVsReturning: { windowClients: number; newClients: number; returningClients: number };
  locationsBreakdown: { id: number | null; name?: string; soldRevenue: number; saleCount: number; appointmentCount: number }[];
  fidelityPeriod: {
    pointsIssued: number;
    pointsUsed: number;
    rechargesCount: number;
    rechargesAmount: number;
    giftcardsIssued: number;
    giftcardsIssuedAmount: number;
    giftcardUsedAmount: number;
    creditUsedAmount: number;
  };
};

type ReportsResponse = {
  ok?: boolean;
  kpis?: { activeSales?: number; revenue?: number; cancelledRevenue?: number; averageTicket?: number; clients?: number; lowStock?: number };
  locationLabel?: string;
  locationFailClosed?: boolean;
  locationsCount?: number;
  analytics?: Analytics;
};

// Palette legacy (reports.php:1330).
const CHART_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#64748b", "#ea580c", "#0f766e", "#be123c"];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// number_format($v, N, ',', '.') manuale: toLocaleString it-IT NON raggruppa
// 1000-9999, il PHP sì.
function numberFormatIt(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}${grouped}${decimals > 0 ? `,${decPart}` : ""}`;
}

function fmtMoney(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return `€ ${numberFormatIt(v, 2)}`;
}

function fmtInt(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? Math.trunc(n as number) : 0;
  return numberFormatIt(v, 0);
}

// $qtyFmt legacy: 2 decimali con strip di zeri e virgola finali.
function fmtQty(n: number | undefined): string {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return numberFormatIt(v, 2).replace(/0+$/, "").replace(/,$/, "") || "0";
}

// $hoursFmt legacy: ore con 1 decimale, strip di ',0' ('2 h', '1,5 h').
function fmtHours(n: number | undefined): string {
  const v = Math.max(0, Number.isFinite(n as number) ? (n as number) : 0);
  const formatted = numberFormatIt(v, 1).replace(/0+$/, "").replace(/,$/, "");
  return `${formatted === "" ? "0" : formatted} h`;
}

function itDate(iso: string): string {
  return iso.split("-").reverse().join("/");
}

// Esporta CSV (rivoluzione 2026-07-20): BOM per Excel, separatore ';' come si
// aspetta l'Excel italiano; i numeri vanno passati già formattati con la
// virgola (numberFormatIt).
function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Confronto periodo-su-periodo (ridisegno 2026-07-21 su best-practice dashboard:
// freccia direzionale + % + il VALORE del periodo di confronto con etichetta
// "vs", così è chiaro rispetto a cosa). `dir` guida la freccia (su/giù/pari),
// `cls` il colore (goodWhenUp invertito per Costi/Commissioni), `prevText` è il
// valore del periodo di confronto già formattato (€/intero).
type DeltaInfo = { text: string; cls: string; dir: "up" | "down" | "flat"; prevText: string };
function deltaInfo(current: number, previous: number, opts: { money?: boolean; requiresBoth?: boolean; goodWhenUp?: boolean } = {}): DeltaInfo {
  const eps = 0.0001;
  const goodWhenUp = opts.goodWhenUp !== false;
  const diff = current - previous;
  const fmt = (v: number) => (opts.money ? `€ ${numberFormatIt(v, 2)}` : numberFormatIt(Math.round(v), 0));
  const prevText = fmt(Math.max(0, previous));
  let cls = "is-flat";
  if (Math.abs(diff) >= eps) cls = (diff > 0) === goodWhenUp ? "is-good" : "is-bad";
  const dir: DeltaInfo["dir"] = diff > eps ? "up" : diff < -eps ? "down" : "flat";

  // requiresBoth (es. scontrino medio): senza entrambi i valori il % è privo di
  // senso → trattino, ma si mostra comunque il "vs" per contesto.
  if (opts.requiresBoth && (current <= eps || previous <= eps)) {
    return { text: "n/d", cls: "is-flat", dir: "flat", prevText };
  }
  // Periodo di confronto a zero: "Nuovo" (o pari se anche il corrente è 0).
  if (Math.abs(previous) < eps) {
    return current > eps ? { text: "Nuovo", cls, dir: "up", prevText } : { text: "0%", cls: "is-flat", dir: "flat", prevText };
  }
  const pct = (diff / Math.abs(previous)) * 100;
  const pctSign = pct > eps ? "+" : pct < -eps ? "−" : "";
  return { text: `${pctSign}${numberFormatIt(Math.abs(pct), 1)}%`, cls, dir, prevText };
}

// Port di $buildTrendSeries (reports.php 1365-1410): ZERO-FILL dell'intero
// periodo; daily = ogni giorno 'd/m'; weekly = bucket di 7 giorni DALL'INIZIO
// del range con label 'd/m - d/m' (clippato alla fine); monthly = mesi di
// calendario clippati al range con label 'm/Y'.
function buildTrendSeries(
  rows: { day: string; value: number; count?: number }[],
  fromYmd: string,
  toYmd: string,
  granularity: string,
  rangeDays: number,
): { labels: string[]; values: number[]; counts: number[]; ranges: { from: string; to: string }[] } {
  const effective = granularity === "auto" ? (rangeDays <= 45 ? "daily" : rangeDays <= 180 ? "weekly" : "monthly") : granularity;
  const daily = new Map<string, { value: number; count: number }>();
  for (const row of rows) {
    const key = row.day.slice(0, 10);
    const prev = daily.get(key) ?? { value: 0, count: 0 };
    daily.set(key, { value: prev.value + row.value, count: prev.count + (row.count ?? 0) });
  }
  const parse = (iso: string): Date => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const dm = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const start = parse(fromYmd);
  const end = parse(toYmd);
  const labels: string[] = [];
  const values: number[] = [];
  const counts: number[] = [];
  // Range ISO del bucket (drill-down 2026-07-20): il click sul punto del
  // grafico apre Movimenti sul from/to del bucket.
  const ranges: { from: string; to: string }[] = [];
  const appendBucket = (bucketStart: Date, bucketEnd: Date, label: string) => {
    let value = 0;
    let count = 0;
    for (let cur = new Date(bucketStart); cur.getTime() <= bucketEnd.getTime(); cur.setDate(cur.getDate() + 1)) {
      const key = localYmd(cur);
      value += daily.get(key)?.value ?? 0;
      count += daily.get(key)?.count ?? 0;
    }
    labels.push(label);
    values.push(Math.round(value * 100) / 100);
    counts.push(count);
    ranges.push({ from: localYmd(bucketStart), to: localYmd(bucketEnd) });
  };
  if (effective === "daily") {
    for (let cur = new Date(start); cur.getTime() <= end.getTime(); cur.setDate(cur.getDate() + 1)) {
      appendBucket(cur, cur, dm(cur));
    }
  } else if (effective === "weekly") {
    for (let cur = new Date(start); cur.getTime() <= end.getTime(); cur.setDate(cur.getDate() + 7)) {
      const bucketEnd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6);
      const clipped = bucketEnd.getTime() > end.getTime() ? end : bucketEnd;
      appendBucket(cur, clipped, `${dm(cur)} - ${dm(clipped)}`);
    }
  } else {
    for (let cur = new Date(start.getFullYear(), start.getMonth(), 1); cur.getTime() <= end.getTime(); cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)) {
      const bucketStart = cur.getTime() < start.getTime() ? start : cur;
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const bucketEnd = monthEnd.getTime() > end.getTime() ? end : monthEnd;
      appendBucket(bucketStart, bucketEnd, `${pad(bucketStart.getMonth() + 1)}/${bucketStart.getFullYear()}`);
    }
  }
  return { labels, values, counts, ranges };
}

// $alignCompareSeries legacy (reports.php 1463-1471): la serie di confronto
// viene troncata/paddata alla lunghezza della serie principale.
function alignSeries(values: number[], length: number): number[] {
  const out = values.slice(0, length);
  while (out.length < length) out.push(0);
  return out;
}

function granularityLabel(granularity: string, rangeDays: number): string {
  const effective = granularity === "auto" ? (rangeDays <= 45 ? "daily" : rangeDays <= 180 ? "weekly" : "monthly") : granularity;
  return effective === "daily" ? "Per giorno" : effective === "weekly" ? "Per settimana" : "Per mese";
}

// Data LOCALE Y-m-d (il legacy usa la data del server; toISOString è UTC e di
// sera sposta i preset al giorno sbagliato).
function localYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// makeYmd legacy: clamp del giorno all'ultimo del mese (31/03 -1 mese = 28/02).
function shiftMonthsYmd(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12; // 0-based
  const lastDay = new Date(ny, nm + 1, 0).getDate();
  return localYmd(new Date(ny, nm, Math.min(d, lastDay)));
}

function shiftYearsYmd(isoDate: string, years: number): string {
  return shiftMonthsYmd(isoDate, years * 12);
}

const RANGE_LABELS: Record<string, string> = {
  today: "Oggi",
  yesterday: "Ieri",
  last_7: "Ultimi 7 giorni",
  last_30: "Ultimi 30 giorni",
  last_90: "Ultimi 90 giorni",
  last_180: "Ultimi 180 giorni",
  month_current: "Mese corrente",
  month_previous: "Mese precedente",
  year_current: "Anno corrente",
  custom: "Personalizzato",
};

const COMPARE_MODE_LABELS: Record<string, string> = {
  auto: "Automatico",
  previous_period: "Stesso periodo precedente",
  previous_year: "Stesso periodo anno precedente",
  month: "Scegli mese",
  custom: "Periodo personalizzato",
};

// Lookup SICURO su questi dizionari: l'accesso a bracket con una chiave grezza
// dell'URL (?range=toString) risalirebbe il prototipo e restituirebbe una
// funzione truthy (Object.prototype.toString/valueOf/…), superando i guard e
// facendo poi crashare `.toLowerCase()`. hasOwnProperty limita alle chiavi vere.
function ownLabel(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

type ReportsQuery = {
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
  compare?: string;
  compare_mode?: string;
  compare_month?: string;
  compare_from?: string;
  compare_to?: string;
  all_locations?: string;
};

export function ReportsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ReportsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const todayIso = localYmd(new Date());
  const monthStartIso = `${todayIso.slice(0, 7)}-01`;
  // reportYmdValid legacy (regex + checkdate: '2026-02-31' NON è valida).
  const isYmd = (v: unknown) => {
    const s = String(v ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  };

  // Stato filtri dai querystring legacy (?range=&from=&to=&granularity=&
  // compare=...); default legacy: range invalido + from/to PRESENTI (anche
  // invalidi, isset() nel PHP) → 'custom', altrimenti mese corrente.
  const q = initialQuery ?? {};
  const initialRange = ownLabel(RANGE_LABELS, String(q.range ?? ""))
    ? String(q.range)
    : (q.from !== undefined || q.to !== undefined ? "custom" : "month_current");
  const [range, setRange] = useState(initialRange);
  const [from, setFrom] = useState(isYmd(q.from) ? String(q.from) : monthStartIso);
  const [to, setTo] = useState(isYmd(q.to) ? String(q.to) : todayIso);
  const [granularity, setGranularity] = useState(["auto", "daily", "weekly", "monthly"].includes(String(q.granularity ?? "")) ? String(q.granularity) : "auto");
  const [compare, setCompare] = useState(["1", "true", "on", "yes"].includes(String(q.compare ?? "").toLowerCase()));
  const [compareMode, setCompareMode] = useState(ownLabel(COMPARE_MODE_LABELS, String(q.compare_mode ?? "")) ? String(q.compare_mode) : "auto");
  const [compareMonth, setCompareMonth] = useState(() =>
    /^\d{4}-\d{2}$/.test(String(q.compare_month ?? "")) ? String(q.compare_month) : shiftMonthsYmd(todayIso, -1).slice(0, 7));
  const [compareFrom, setCompareFrom] = useState(isYmd(q.compare_from) ? String(q.compare_from) : monthStartIso);
  const [compareTo, setCompareTo] = useState(isYmd(q.compare_to) ? String(q.compare_to) : todayIso);
  // "Tutte le sedi" (rivoluzione 2026-07-20): visibile solo con >1 sede
  // autorizzata; attiva il breakdown per sede lato API (all_locations=1).
  const [allLoc, setAllLoc] = useState(["1", "true", "on", "yes"].includes(String(q.all_locations ?? "").toLowerCase()));

  const [data, setData] = useState<ReportsResponse | null>(null);
  // Primo caricamento: distingue "sto caricando" da "periodo davvero vuoto"
  // (prima i KPI mostravano 0 sin dal primo paint, indistinguibili dal vuoto).
  const [loading, setLoading] = useState(true);
  // Auth::requirePerm legacy: 403 → pagina 'Accesso negato' (card nel chrome).
  const [accessDenied, setAccessDenied] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [operatorSearch, setOperatorSearch] = useState("");

  // Preset periodo -> [from, to] (reports.php 47-90), in data LOCALE.
  const resolveRange = useCallback((): { from: string; to: string } => {
    const now = new Date();
    const back = (n: number) => localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    switch (range) {
      case "today": return { from: back(0), to: back(0) };
      case "yesterday": return { from: back(1), to: back(1) };
      case "last_7": return { from: back(6), to: back(0) };
      case "last_30": return { from: back(29), to: back(0) };
      case "last_90": return { from: back(89), to: back(0) };
      case "last_180": return { from: back(179), to: back(0) };
      case "month_previous": {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return { from: localYmd(start), to: localYmd(new Date(now.getFullYear(), now.getMonth(), 0)) };
      }
      case "year_current": return { from: localYmd(new Date(now.getFullYear(), 0, 1)), to: back(0) };
      case "custom": {
        // Date custom validate al punto d'uso: un campo svuotato/invalido (il
        // <input type=date> restituisce "") NON deve arrivare all'API né alle
        // didascalie come stringa vuota. Fallback: 1° del mese / oggi.
        const f = isYmd(from) ? from : localYmd(new Date(now.getFullYear(), now.getMonth(), 1));
        const t = isYmd(to) ? to : back(0);
        return f <= t ? { from: f, to: t } : { from: t, to: f };
      }
      case "month_current":
      default: return { from: localYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: back(0) };
    }
  }, [range, from, to]);

  // Finestra di confronto per modalita' (reports.php 130-219) col clamp del
  // giorno legacy (makeYmd) su mesi/anni.
  const resolveCompareWindow = useCallback((win: { from: string; to: string }): { from: string; to: string } => {
    const previousPeriod = () => {
      const lenDays = Math.max(1, Math.round((Date.parse(`${win.to}T12:00:00`) - Date.parse(`${win.from}T12:00:00`)) / 86400000) + 1);
      const [y, m, d] = win.from.split("-").map(Number);
      const prevTo = localYmd(new Date(y, m - 1, d - 1));
      const prevFrom = localYmd(new Date(y, m - 1, d - lenDays));
      return { from: prevFrom, to: prevTo };
    };
    switch (compareMode) {
      case "previous_year": return { from: shiftYearsYmd(win.from, -1), to: shiftYearsYmd(win.to, -1) };
      case "month": {
        // sameLengthFromMonth legacy (reports.php 161-172): dal 1° del mese per
        // la STESSA LUNGHEZZA del periodo principale, clampata a fine mese.
        const [yy, mm] = compareMonth.split("-").map(Number);
        if (yy && mm) {
          const lenDays = Math.max(1, Math.round((Date.parse(`${win.to}T12:00:00`) - Date.parse(`${win.from}T12:00:00`)) / 86400000) + 1);
          const lastOfMonth = new Date(yy, mm, 0);
          const target = new Date(yy, mm - 1, lenDays);
          const to = target.getTime() > lastOfMonth.getTime() ? lastOfMonth : target;
          return { from: `${compareMonth}-01`, to: localYmd(to) };
        }
        return previousPeriod();
      }
      case "custom": {
        // Date confronto custom validate come sopra: se invalide, ripiega sul
        // periodo precedente di pari durata invece di inviare stringhe vuote.
        if (!isYmd(compareFrom) || !isYmd(compareTo)) return previousPeriod();
        return compareFrom <= compareTo ? { from: compareFrom, to: compareTo } : { from: compareTo, to: compareFrom };
      }
      case "auto":
        if (range === "month_current" || range === "month_previous") return { from: shiftMonthsYmd(win.from, -1), to: shiftMonthsYmd(win.to, -1) };
        if (range === "year_current") return { from: shiftYearsYmd(win.from, -1), to: shiftYearsYmd(win.to, -1) };
        return previousPeriod();
      case "previous_period":
      default:
        return previousPeriod();
    }
  }, [compareMode, compareMonth, compareFrom, compareTo, range]);

  // Sequenza monotona anti-stale: cambi rapidi di periodo/confronto lanciano
  // fetch concorrenti e vincerebbe la risposta più LENTA — applichiamo solo
  // l'ultima richiesta (pattern seqRef di pos-content).
  const loadSeqRef = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeqRef.current;
    const rng = resolveRange();
    const params = new URLSearchParams({ slug, from: rng.from, to: rng.to });
    if (allLoc) params.set("all_locations", "1");
    if (compare) {
      params.set("compare", "1");
      const cw = resolveCompareWindow(rng);
      params.set("compare_from", cw.from);
      params.set("compare_to", cw.to);
    }
    setLoading(true);
    return fetch(`/api/manage/reports?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => {
        if (seq !== loadSeqRef.current) return null;
        // accessDenied non più write-once: un 200 successivo sblocca la pagina.
        setAccessDenied(r.status === 403);
        return r.json();
      })
      .then((j: ReportsResponse | null) => {
        if (seq === loadSeqRef.current && j) setData(j);
      })
      .catch(() => {
        if (seq === loadSeqRef.current) setData(null);
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false);
      });
  }, [slug, resolveRange, resolveCompareWindow, compare, allLoc]);

  useEffect(() => {
    load();
  }, [load]);

  // URL sempre allineato ai filtri (deep-link condivisibili) SENZA dipendere da
  // un pulsante: i filtri si applicano subito, quindi la barra indirizzi segue
  // lo stato live. Era legato al submit di "Aggiorna" — origine della confusione
  // "ho cambiato il filtro ma sembra non applicarsi".
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams({ range, granularity });
    if (range === "custom") {
      qs.set("from", from);
      qs.set("to", to);
    }
    if (allLoc) qs.set("all_locations", "1");
    if (compare) {
      qs.set("compare", "1");
      qs.set("compare_mode", compareMode);
      if (compareMode === "month") qs.set("compare_month", compareMonth);
      if (compareMode === "custom") {
        qs.set("compare_from", compareFrom);
        qs.set("compare_to", compareTo);
      }
    }
    window.history.replaceState(null, "", `/${encodeURIComponent(slug)}/reports?${qs.toString()}`);
  }, [slug, range, from, to, granularity, allLoc, compare, compareMode, compareMonth, compareFrom, compareTo]);

  // "Tutte le sedi" non può restare attivo (e nascosto) se l'utente ha ≤1 sede:
  // la checkbox sparisce sotto la soglia, quindi resettiamo il flag per non
  // continuare a inviare all_locations=1 senza modo di disattivarlo dalla UI.
  useEffect(() => {
    if (allLoc && data && (data.locationsCount ?? 0) <= 1) setAllLoc(false);
  }, [allLoc, data]);

  const k = data?.kpis ?? {};
  const a = data?.analytics;
  const showCustom = range === "custom";
  const rangeDays = a ? Math.max(1, Math.round((Date.parse(`${a.to}T00:00:00Z`) - Date.parse(`${a.from}T00:00:00Z`)) / 86400000) + 1) : 1;
  const trendBadge = granularityLabel(granularity, rangeDays);

  // --- Serie e dataset dei grafici: port fedele di reports.js -------------
  // $chartTop legacy (limit 10 gia' applicato dall'API, value>0, label non vuota).
  const chartTop = (rows: { label: string; value: number }[]): { labels: string[]; values: number[] } => {
    const items = rows.slice(0, 10).filter((r) => r.label.trim() !== "" && r.value > 0);
    return { labels: items.map((r) => r.label.trim()), values: items.map((r) => Math.round(r.value * 100) / 100) };
  };
  const trendSeries = a ? buildTrendSeries(a.daily.map((r) => ({ day: r.day, value: r.revenue, count: r.saleCount })), a.from, a.to, granularity, rangeDays) : null;
  const prevTrendSeries = a?.comparison
    ? buildTrendSeries(a.comparison.daily.map((r) => ({ day: r.day, value: r.revenue, count: r.saleCount })), a.comparison.from, a.comparison.to, granularity, rangeDays)
    : null;
  const apptSeries = a ? buildTrendSeries(a.appointments.trend.map((r) => ({ day: r.day, value: r.count })), a.from, a.to, granularity, rangeDays) : null;
  const prevApptSeries = a?.comparison
    ? buildTrendSeries(a.comparison.appointmentTrend.map((r) => ({ day: r.day, value: r.count })), a.comparison.from, a.comparison.to, granularity, rangeDays)
    : null;
  const genderChart = a
    ? [
        { label: "Donne", value: a.clientsArchive.female },
        { label: "Uomini", value: a.clientsArchive.male },
        { label: "Non indicato", value: a.clientsArchive.unknownGender },
      ].filter((g) => g.value > 0)
    : [];
  const financeChart = a
    ? [
        { label: "Incasso", value: a.summary.totalRevenue },
        ...(a.costs ? [{ label: "Costi", value: a.costs.total }] : []),
        ...(a.commissions ? [{ label: "Commissioni", value: a.commissions.total }] : []),
      ]
    : [];
  const clientsChart = chartTop((a?.topClients ?? []).map((c) => ({ label: c.name, value: c.revenue })));
  const itemsChart = chartTop((a?.topItems ?? []).map((i) => ({ label: i.name, value: i.revenue })));
  const operatorsChart = chartTop((a?.operators ?? []).map((o) => ({ label: o.name, value: o.revenue })));
  // hasValues legacy: il grafico si disegna solo se c'e' almeno un valore > 0
  // (per i trend contano anche i previousValues), altrimenti report-chart-empty.
  const hasChart = {
    trend: [...(trendSeries?.values ?? []), ...(prevTrendSeries?.values ?? [])].some((v) => v > 0),
    appt: [...(apptSeries?.values ?? []), ...(prevApptSeries?.values ?? [])].some((v) => v > 0),
    salesTypes: (a?.composition ?? []).some((c) => c.revenue > 0),
    paymentMethods: (a?.paymentMethods ?? []).some((m) => m.amount > 0),
    gender: genderChart.some((g) => g.value > 0),
    age: (a?.clientsArchive.ageBuckets ?? []).some((b) => b.count > 0),
    finance: financeChart.some((f) => f.value > 0),
    clients: clientsChart.values.some((v) => v > 0),
    items: itemsChart.values.some((v) => v > 0),
    operators: operatorsChart.values.some((v) => v > 0),
  };
  const chartEmpty = <div className="report-chart-empty">Nessun dato disponibile nel periodo selezionato.</div>;

  // --- Grafici Chart.js (window.Chart): stessi tipi/opzioni di reports.js --
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartsRef = useRef<Record<string, any>>({});
  useEffect(() => {
    if (!a || !trendSeries || !apptSeries) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    let stop = false;
    const draw = () => {
      if (stop) return;
      if (!w.Chart) {
        setTimeout(draw, 150);
        return;
      }
      w.Chart.defaults.font.family = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      w.Chart.defaults.color = "#344054";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const make = (id: string, config: any) => {
        const el = document.getElementById(id) as HTMLCanvasElement | null;
        if (!el) return;
        if (chartsRef.current[id]) chartsRef.current[id].destroy();
        chartsRef.current[id] = new w.Chart(el, config);
      };
      // Valuta col simbolo PRIMA ("€ 1.234,56"), identica a fmtMoney del DOM:
      // prima i grafici usavano "1.234,56 €" (simbolo dopo) creando due
      // convenzioni diverse nello stesso schermo.
      const decFmt = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const moneyFmt = { format: (v: number) => `€ ${decFmt.format(Number(v) || 0)}` };
      const numberFmt = new Intl.NumberFormat("it-IT");
      const moneyShort = (value: unknown) => {
        const v = Number(value || 0);
        if (Math.abs(v) >= 1000) return `€ ${(v / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })}k`;
        return `€ ${v.toLocaleString("it-IT", { maximumFractionDigits: 0 })}`;
      };
      const integerShort = (value: unknown) => {
        const v = Number(value || 0);
        if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })}k`;
        return numberFmt.format(Math.round(v));
      };
      const backgroundColors = (count: number) => Array.from({ length: count }, (_, i) => CHART_COLORS[i % CHART_COLORS.length]);

      // renderLine legacy: 'Periodo attuale' + dataset tratteggiato di confronto.
      const lineDatasets = (values: number[], prev: number[] | null, color: string, bg: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const datasets: any[] = [{ label: "Periodo attuale", data: values, borderColor: color, backgroundColor: bg, borderWidth: 2, fill: true, pointRadius: 2, pointHoverRadius: 4, tension: 0.25 }];
        if (prev && prev.some((v) => v > 0)) {
          datasets.push({ label: "Periodo precedente", data: prev, borderColor: CHART_COLORS[6], backgroundColor: "rgba(100, 116, 139, .08)", borderDash: [6, 4], borderWidth: 2, fill: false, pointRadius: 2, pointHoverRadius: 4, tension: 0.25 });
        }
        return datasets;
      };
      const lineOptions = (yTicks: (v: unknown) => string, tooltipLabel: (ctx: { dataset: { label?: string }; parsed: { y?: number } }) => string, afterLabel?: (ctx: { datasetIndex: number; dataIndex: number }) => string) => ({
        maintainAspectRatio: false,
        responsive: true,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: { display: false, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { callbacks: { label: tooltipLabel, ...(afterLabel ? { afterLabel } : {}) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, ticks: { callback: yTicks } },
        },
      });

      if (hasChart.trend) {
        const prevValues = prevTrendSeries ? alignSeries(prevTrendSeries.values, trendSeries.values.length) : null;
        const prevCounts = prevTrendSeries ? alignSeries(prevTrendSeries.counts, trendSeries.values.length) : null;
        const datasets = lineDatasets(trendSeries.values, prevValues, CHART_COLORS[0], "rgba(37, 99, 235, .12)");
        const options = lineOptions(
          moneyShort,
          (ctx) => `${ctx.dataset.label}: ${moneyFmt.format(ctx.parsed.y || 0)}`,
          (ctx) => {
            const counts = ctx.datasetIndex === 1 ? prevCounts : trendSeries.counts;
            return `Movimenti: ${numberFmt.format(Number(counts?.[ctx.dataIndex] ?? 0))}`;
          },
        );
        options.plugins.legend.display = datasets.length > 1;
        // Drill-down (2026-07-20): il click su un punto apre Movimenti sul
        // range del bucket (giorno/settimana/mese) del periodo ATTUALE.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (options as any).onClick = (_evt: unknown, elements: Array<{ index: number }>) => {
          const idx = elements?.[0]?.index;
          if (idx === undefined || idx < 0) return;
          const rangeBucket = trendSeries.ranges[idx];
          if (!rangeBucket) return;
          window.location.href = `/${encodeURIComponent(slug)}/pos_history?from=${rangeBucket.from}&to=${rangeBucket.to}`;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (options as any).onHover = (evt: any, elements: Array<unknown>) => {
          if (evt?.native?.target) evt.native.target.style.cursor = elements?.length ? "pointer" : "default";
        };
        make("reportTrendChart", { type: "line", data: { labels: trendSeries.labels, datasets }, options });
      }

      if (hasChart.appt) {
        const prevValues = prevApptSeries ? alignSeries(prevApptSeries.values, apptSeries.values.length) : null;
        const datasets = lineDatasets(apptSeries.values, prevValues, CHART_COLORS[1], "rgba(22, 163, 74, .12)");
        const options = lineOptions(integerShort, (ctx) => `${ctx.dataset.label}: ${numberFmt.format(ctx.parsed.y || 0)}`);
        options.plugins.legend.display = datasets.length > 1;
        options.scales.y.ticks = { precision: 0, callback: integerShort } as never;
        make("reportAppointmentsTrendChart", { type: "line", data: { labels: apptSeries.labels, datasets }, options });
      }

      // renderDoughnut legacy: cutout 62%, bordo bianco, tooltip in euro.
      const doughnut = (labels: string[], values: number[], tooltipLabel: (ctx: { label?: string; parsed?: number }) => string) => ({
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: backgroundColors(values.length), borderColor: "#fff", borderWidth: 2 }] },
        options: {
          cutout: "62%",
          maintainAspectRatio: false,
          responsive: true,
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
            tooltip: { callbacks: { label: tooltipLabel } },
          },
        },
      });
      const moneyDoughnutLabel = (ctx: { label?: string; parsed?: number }) => `${ctx.label}: ${moneyFmt.format(ctx.parsed || 0)}`;
      if (hasChart.salesTypes) {
        make("reportSalesTypesChart", doughnut(a.composition.map((c) => c.label), a.composition.map((c) => c.revenue), moneyDoughnutLabel));
      }
      if (hasChart.finance) {
        make("reportFinanceChart", doughnut(financeChart.map((f) => f.label), financeChart.map((f) => Math.round(f.value * 100) / 100), moneyDoughnutLabel));
      }
      if (hasChart.gender) {
        const total = genderChart.reduce((sum, g) => sum + g.value, 0);
        make("reportGenderChart", doughnut(genderChart.map((g) => g.label), genderChart.map((g) => g.value), (ctx) => {
          const value = Number(ctx.parsed || 0);
          const pct = total > 0 ? ` (${((value / total) * 100).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%)` : "";
          return `${ctx.label}: ${numberFmt.format(value)}${pct}`;
        }));
      }

      // renderBar legacy: barre orizzontali in euro con palette ciclica.
      const moneyBar = (labels: string[], values: number[], counts?: number[]) => ({
        type: "bar",
        data: { labels, datasets: [{ label: "Incasso", data: values, backgroundColor: backgroundColors(values.length), borderRadius: 5, maxBarThickness: 18 }] },
        options: {
          indexAxis: "y",
          maintainAspectRatio: false,
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx: { parsed: { x?: number } }) => moneyFmt.format(ctx.parsed.x || 0),
                afterLabel: (ctx: { dataIndex: number }) => {
                  const count = Number(counts?.[ctx.dataIndex] ?? 0);
                  return count > 0 ? `Utilizzi: ${numberFmt.format(count)}` : undefined;
                },
              },
            },
          },
          scales: {
            x: { beginAtZero: true, ticks: { callback: moneyShort } },
            y: { grid: { display: false }, ticks: { font: { size: 11 } } },
          },
        },
      });
      if (hasChart.paymentMethods) {
        make("reportPaymentMethodsChart", moneyBar(a.paymentMethods.map((m) => m.label), a.paymentMethods.map((m) => m.amount), a.paymentMethods.map((m) => m.count)));
      }
      if (hasChart.clients) make("reportClientsChart", moneyBar(clientsChart.labels, clientsChart.values));
      if (hasChart.items) make("reportItemsChart", moneyBar(itemsChart.labels, itemsChart.values));
      if (hasChart.operators) make("reportOperatorsChart", moneyBar(operatorsChart.labels, operatorsChart.values));

      // renderCountBar legacy (eta'): barre orizzontali a conteggio.
      if (hasChart.age) {
        make("reportAgeChart", {
          type: "bar",
          data: { labels: a.clientsArchive.ageBuckets.map((b) => b.label), datasets: [{ label: "Clienti", data: a.clientsArchive.ageBuckets.map((b) => b.count), backgroundColor: backgroundColors(a.clientsArchive.ageBuckets.length), borderRadius: 5, maxBarThickness: 22 }] },
          options: {
            indexAxis: "y",
            maintainAspectRatio: false,
            responsive: true,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (ctx: { parsed: { x?: number } }) => numberFmt.format(ctx.parsed.x || 0) } },
            },
            scales: {
              x: { beginAtZero: true, ticks: { precision: 0, callback: integerShort } },
              y: { grid: { display: false }, ticks: { font: { size: 11 } } },
            },
          },
        });
      }
    };
    draw();
    return () => {
      stop = true;
    };
    // trendSeries & co. derivano tutti da `a`+granularity: bastano loro come deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, granularity, rangeDays]);

  const arch = a?.clientsArchive;
  const rng = resolveRange();
  const compareWindow = compare ? resolveCompareWindow(rng) : null;

  // Raggruppamenti grafici SENSATI per il periodo scelto (2026-07-21): un
  // livello compare solo se produce ≥2 punti. Con "Oggi" (1 giorno)
  // settimana/mese darebbero un unico punto con etichetta fuorviante
  // ("22/07 - 22/07", "07/2026") — offrirli non ha senso. Regole allineate ai
  // bucket di buildTrendSeries: giorno ≥2 giorni; settimana ≥2 bucket da 7
  // (≥8 giorni); mese ≥2 mesi di calendario nel range.
  const rngDays = Math.max(1, Math.round((Date.parse(`${rng.to}T00:00:00`) - Date.parse(`${rng.from}T00:00:00`)) / 86400000) + 1);
  const rngMonths = (() => {
    const [fy, fm] = rng.from.split("-").map(Number);
    const [ty, tm] = rng.to.split("-").map(Number);
    return (ty * 12 + tm) - (fy * 12 + fm) + 1;
  })();
  const granularityChoices = [
    { value: "auto", label: "Automatico" },
    ...(rngDays >= 2 ? [{ value: "daily", label: "Un punto per giorno" }] : []),
    ...(Math.ceil(rngDays / 7) >= 2 ? [{ value: "weekly", label: "Un punto per settimana" }] : []),
    ...(rngMonths >= 2 ? [{ value: "monthly", label: "Un punto per mese" }] : []),
  ];
  const canGroup = granularityChoices.length > 1;
  // Se accorci il periodo e il raggruppamento scelto non è più producibile
  // (es. "Ultimi 30 giorni / Per settimana" → "Oggi"), torna ad Automatico:
  // altrimenti resterebbe uno stato "weekly" che disegna il punto singolo.
  useEffect(() => {
    if (granularity !== "auto" && !granularityChoices.some((c) => c.value === granularity)) {
      setGranularity("auto");
    }
    // granularityChoices deriva solo da rng (range/from/to).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity, rng.from, rng.to]);
  const filteredClients = (a?.topClients ?? []).filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase()));
  const filteredItems = (a?.topItems ?? []).filter((i) => `${i.name} ${i.type ?? ""}`.toLowerCase().includes(itemSearch.toLowerCase()));
  const filteredOperators = (a?.operators ?? []).filter((o) => o.name.toLowerCase().includes(operatorSearch.toLowerCase()));

  const incassoDelta = a?.comparison ? deltaInfo(a.summary.totalRevenue, a.comparison.totalRevenue, { money: true }) : null;
  const venditeDelta = a?.comparison ? deltaInfo(a.summary.saleCount, a.comparison.saleCount) : null;
  const ticketDelta = a?.comparison ? deltaInfo(a.summary.averageTicket, a.comparison.averageTicket, { money: true, requiresBoth: true }) : null;
  const clientiDelta = a?.comparison ? deltaInfo(a.summary.servedClients, a.comparison.servedClients) : null;
  const prenotazioniDelta = a?.comparison ? deltaInfo(a.summary.appointmentCount, a.comparison.appointmentCount) : null;
  // Costi/Commissioni: goodWhenUp=false (un aumento è "bad", reports.php 1543-1544).
  const costiDelta = a?.comparison && a.comparison.costsTotal !== null && a.costs
    ? deltaInfo(a.costs.total, a.comparison.costsTotal, { money: true, goodWhenUp: false })
    : null;
  const commissioniDelta = a?.comparison && a.comparison.commissionsTotal !== null && a.commissions
    ? deltaInfo(a.commissions.total, a.comparison.commissionsTotal, { money: true, goodWhenUp: false })
    : null;
  // Clienti attivi nel periodo e dimensione archivio a fine periodo, ora
  // confrontabili (l'API calcola le stesse metriche sul periodo di confronto).
  const clientiPeriodoDelta = a?.comparison ? deltaInfo(a.newVsReturning.windowClients, a.comparison.windowClients) : null;
  const archivioDelta = a?.comparison ? deltaInfo(a.clientsArchivePeriodEnd, a.comparison.clientsArchiveTotal) : null;

  const renderDelta = (delta: DeltaInfo | null, extraClass = "") =>
    delta ? (
      <div className={`report-delta ${delta.cls}${extraClass}`}>
        <i className={`bi ${delta.dir === "up" ? "bi-arrow-up-short" : delta.dir === "down" ? "bi-arrow-down-short" : "bi-dash"}`} aria-hidden="true" />
        <span className="report-delta__pct">{delta.text}</span>
        <span className="report-delta__prev">vs {delta.prevText}</span>
      </div>
    ) : null;

  // Variazione COMPATTA (freccia + %) per le celle del pannello confronto: lì il
  // valore del periodo di confronto è già una colonna, quindi niente "vs".
  const renderDeltaCell = (delta: DeltaInfo | null) =>
    delta ? (
      <span className={`report-delta ${delta.cls}`}>
        <i className={`bi ${delta.dir === "up" ? "bi-arrow-up-short" : delta.dir === "down" ? "bi-arrow-down-short" : "bi-dash"}`} aria-hidden="true" />
        {delta.text}
      </span>
    ) : null;

  // Righe del pannello "Confronto periodi" (vista affiancata in cima quando il
  // confronto è attivo): metrica, valore periodo, valore confronto, variazione.
  const compareRows = a?.comparison
    ? [
        { label: "Incasso", cur: fmtMoney(a.summary.totalRevenue), prev: fmtMoney(a.comparison.totalRevenue), delta: incassoDelta },
        { label: "Vendite", cur: fmtInt(a.summary.saleCount), prev: fmtInt(a.comparison.saleCount), delta: venditeDelta },
        { label: "Scontrino medio", cur: fmtMoney(a.summary.averageTicket), prev: fmtMoney(a.comparison.averageTicket), delta: ticketDelta },
        { label: "Prenotazioni", cur: fmtInt(a.summary.appointmentCount), prev: fmtInt(a.comparison.appointmentCount), delta: prenotazioniDelta },
        { label: "Clienti serviti", cur: fmtInt(a.summary.servedClients), prev: fmtInt(a.comparison.servedClients), delta: clientiDelta },
        { label: "Clienti nel periodo", cur: fmtInt(a.newVsReturning.windowClients), prev: fmtInt(a.comparison.windowClients), delta: clientiPeriodoDelta },
        { label: "Clienti in archivio", cur: fmtInt(a.clientsArchivePeriodEnd), prev: fmtInt(a.comparison.clientsArchiveTotal), delta: archivioDelta },
        ...(a.costs && a.comparison.costsTotal !== null ? [{ label: "Costi", cur: fmtMoney(a.costs.total), prev: fmtMoney(a.comparison.costsTotal), delta: costiDelta }] : []),
        ...(a.commissions && a.comparison.commissionsTotal !== null ? [{ label: "Commissioni", cur: fmtMoney(a.commissions.total), prev: fmtMoney(a.comparison.commissionsTotal), delta: commissioniDelta }] : []),
      ]
    : [];

  const locationLabelText = data?.locationLabel ?? "Tutte le sedi";
  // Percentuali prenotazioni (den = TUTTI gli appuntamenti del periodo).
  const apptPct = (n: number | undefined): string => {
    const tot = a?.appointments.total ?? 0;
    return tot > 0 ? `${numberFormatIt(((n ?? 0) / tot) * 100, 1)}%` : "—";
  };
  // Fidelity nel periodo: la sezione compare solo se c'è almeno un numero.
  const fp = a?.fidelityPeriod;
  const fidelityHasData = !!fp && (fp.pointsIssued > 0 || fp.pointsUsed > 0 || fp.rechargesCount > 0 || fp.giftcardsIssued > 0 || fp.giftcardUsedAmount > 0 || fp.creditUsedAmount > 0);
  // Sottotitolo STATICO (2026-07-21): descrive la pagina, non ripete i filtri.
  // Prima ridiceva periodo/sede/raggruppamento/confronto già mostrati dalle
  // didascalie dei filtri ("Stai vedendo", "Confrontato con"): puro doppione.
  const subtitle = "Andamento di incassi, vendite, clienti e prenotazioni.";

  // Port della pagina 403 di Auth::requirePerm (Auth.php 494-505).
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
      {/* ?v= bumpato quando la CSS cambia: senza, il browser tiene la
          versione in cache e il layout dei filtri si sfalda. */}
      <link rel="stylesheet" href="/assets/css/pages/reports.css?v=20260721comparepanel" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Analisi</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Report</h1>
            <InfoBox>
              <ul>
                <li>
                  <strong>Incasso</strong>: le somme effettivamente entrate in cassa nel periodo. Le vendite senza rate
                  contano alla data di vendita; acconti e rate alla data del loro pagamento.
                </li>
                <li>
                  <strong>Venduto</strong>: il valore netto di servizi e prodotti venduti nel periodo (sconti detratti,
                  vendite annullate escluse).
                </li>
                <li>
                  I due totali possono differire per costruzione: una vendita a rate entra nel Venduto subito e
                  nell&apos;Incasso man mano che le rate vengono pagate.
                </li>
              </ul>
              <p>
                Con <strong>Automatico</strong> il confronto è il periodo immediatamente precedente (per mese e anno
                sposta di un mese/anno, quindi a fine mese la durata può differire di qualche giorno); scegli{" "}
                <strong>Periodo precedente di pari durata</strong> per un intervallo esattamente lungo uguale. Il filtro
                sede mostra solo le sedi a cui hai accesso; con <strong>Tutte le sedi</strong>{" "}attivo compare anche il
                confronto tra sedi.
              </p>
              <h6>Navigare dai numeri</h6>
              <ul>
                <li>I KPI Incasso, Vendite, Prenotazioni, Costi e Commissioni aprono il modulo di origine nel periodo.</li>
                <li>Un click su un punto del grafico incasso apre i Movimenti di quel giorno.</li>
                <li>Nei dettagli, i clienti aprono la loro scheda e gli operatori le Commissioni.</li>
              </ul>
              <h6>Esportare</h6>
              <p>
                Ogni sezione con l&apos;icona di download esporta un CSV apribile in Excel; il pulsante{" "}
                <strong>Stampa</strong>{" "}produce la versione stampabile del report.
              </p>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
      </div>

      {data?.locationFailClosed ? (
        <div className="alert alert-warning">Seleziona una sede valida per visualizzare i dati.</div>
      ) : null}

      {/* Filtri ristrutturati (2026-07-21): tre blocchi etichettati — Periodo,
          Confronto (a scomparsa), Opzioni — invece di un'unica riga affollata.
          I filtri si applicano SUBITO (l'effetto load + l'URL sync seguono lo
          stato): niente più pulsante "Aggiorna" che dava l'idea di dover
          confermare. Il range risolto è mostrato come didascalia sotto ogni
          selettore, così "che periodo sto vedendo" è sempre esplicito. */}
      <div className="report-filter-card report-filters p-3 mb-3">
        <div className="report-filters__block">
          <div className="report-filters__row">
            <div className="report-filter-field report-filter-field--period">
              <label className="report-filter-field__label" htmlFor="reportRange">
                Periodo da analizzare
              </label>
              <select
                className="form-select"
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
                <option value="custom">Intervallo personalizzato…</option>
              </select>
            </div>
            {showCustom ? (
              <>
                <div className="report-filter-field report-filter-field--date">
                  <label className="report-filter-field__label" htmlFor="reportFrom">Dal giorno</label>
                  <input className="form-control" type="date" id="reportFrom" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="report-filter-field report-filter-field--date">
                  <label className="report-filter-field__label" htmlFor="reportTo">Al giorno</label>
                  <input className="form-control" type="date" id="reportTo" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </>
            ) : null}
            <p className="report-filter-caption" role="status">
              <i className="bi bi-calendar-range" aria-hidden="true" />{" "}
              Stai vedendo <strong>{itDate(rng.from)} – {itDate(rng.to)}</strong>
            </p>
          </div>
        </div>

        <div className="report-filters__block">
          <label className="report-filter-toggle" htmlFor="reportCompare">
            <input
              className="form-check-input"
              type="checkbox"
              id="reportCompare"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
            />
            <span>
              Confronta con un altro periodo
              <span className="report-filter-toggle__hint">Aggiunge le variazioni % sotto ai numeri</span>
            </span>
          </label>
          {compare ? (
            <div className="report-compare-body">
              <div className="report-filters__row">
                <div className="report-filter-field report-filter-field--period">
                  <label className="report-filter-field__label" htmlFor="reportCompareMode">Confronta con</label>
                  <select
                    className="form-select"
                    id="reportCompareMode"
                    value={compareMode}
                    onChange={(e) => setCompareMode(e.target.value)}
                  >
                    <option value="auto">Automatico (periodo precedente)</option>
                    <option value="previous_period">Periodo precedente di pari durata</option>
                    <option value="previous_year">Stesso periodo dell&apos;anno scorso</option>
                    <option value="month">Un mese specifico</option>
                    <option value="custom">Intervallo personalizzato</option>
                  </select>
                </div>
                {compareMode === "month" ? (
                  <div className="report-filter-field report-filter-field--date">
                    <label className="report-filter-field__label" htmlFor="reportCompareMonth">Mese</label>
                    <input className="form-control" type="month" id="reportCompareMonth" value={compareMonth} onChange={(e) => setCompareMonth(e.target.value)} />
                  </div>
                ) : null}
                {compareMode === "custom" ? (
                  <>
                    <div className="report-filter-field report-filter-field--date">
                      <label className="report-filter-field__label" htmlFor="reportCompareFrom">Dal giorno</label>
                      <input className="form-control" type="date" id="reportCompareFrom" value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} />
                    </div>
                    <div className="report-filter-field report-filter-field--date">
                      <label className="report-filter-field__label" htmlFor="reportCompareTo">Al giorno</label>
                      <input className="form-control" type="date" id="reportCompareTo" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} />
                    </div>
                  </>
                ) : null}
                <p className="report-filter-caption" role="status">
                  <i className="bi bi-arrow-left-right" aria-hidden="true" />{" "}
                  Confrontato con <strong>{compareWindow ? `${itDate(compareWindow.from)} – ${itDate(compareWindow.to)}` : "—"}</strong>
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="report-filters__block report-filters__foot">
          <div className="report-filters__row report-filters__row--options">
            {canGroup ? (
              <div className="report-filter-field report-filter-field--period">
                <label className="report-filter-field__label" htmlFor="reportGranularity">
                  Dettaglio dei grafici
                </label>
                <select
                  className="form-select"
                  id="reportGranularity"
                  value={granularity}
                  onChange={(e) => setGranularity(e.target.value)}
                  title="Cambia solo il raggruppamento dei grafici, non i totali dei riquadri"
                >
                  {granularityChoices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="report-filter-caption mb-0">
                <i className="bi bi-bar-chart-line" aria-hidden="true" />{" "}
                Periodo troppo breve per raggruppare i grafici
              </p>
            )}
            {(data?.locationsCount ?? 0) > 1 ? (
              <label className="report-filter-toggle report-filter-toggle--inline" htmlFor="reportAllLocations">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="reportAllLocations"
                  checked={allLoc}
                  onChange={(e) => setAllLoc(e.target.checked)}
                />
                <span>
                  Includi tutte le sedi
                  <span className="report-filter-toggle__hint">Somma i dati e aggiunge il confronto tra sedi</span>
                </span>
              </label>
            ) : null}
          </div>
          <div className="report-filters__actions">
            <span className="report-filter-live">
              <i className="bi bi-lightning-charge-fill" aria-hidden="true" /> I filtri si applicano da soli
            </span>
            <button className="btn btn-outline-secondary" type="button" id="reportPrintBtn" onClick={() => window.print()}>
              <i className="bi bi-printer me-1" />
              Stampa
            </button>
          </div>
        </div>
      </div>

      {/* Primo caricamento: placeholder al posto di KPI/grafici a zero, così
          "sto caricando" non si confonde con "periodo senza dati". Le richieste
          successive tengono il contenuto precedente (nessun flicker). */}
      {!data ? (
        <div className="report-loading" role="status" aria-live="polite">
          {loading ? (
            <>
              <span className="spinner-border spinner-border-sm" aria-hidden="true" />
              Caricamento del report…
            </>
          ) : (
            <>
              <i className="bi bi-exclamation-triangle" aria-hidden="true" />
              Impossibile caricare il report. Controlla la connessione o riprova.
            </>
          )}
        </div>
      ) : (
      <>
      {/* Pannello "Confronto periodi" (2026-07-21, scelta utente): vista
          AFFIANCATA in cima quando il confronto è attivo — periodo analizzato
          e periodo di confronto uno accanto all'altro con la variazione. Prima
          il confronto era sparso (piccole variazioni sulle card + tratteggi nei
          grafici in basso): cambiare il periodo di confronto non dava una vista
          d'insieme senza scorrere. Le card sotto restano sul periodo. */}
      {compare && a?.comparison ? (
        <section className="report-panel report-compare-panel mb-3">
          <div className="report-section-title border-bottom">
            <div className="fw-semibold" role="heading" aria-level={2}>Confronto periodi</div>
          </div>
          <div className="report-compare-table-wrap">
            <table className="report-compare-table">
              <thead>
                <tr>
                  <th scope="col">Metrica</th>
                  <th scope="col">
                    Periodo<span className="report-compare-th-range">{itDate(a.from)} – {itDate(a.to)}</span>
                  </th>
                  <th scope="col">
                    Confronto<span className="report-compare-th-range">{itDate(a.comparison.from)} – {itDate(a.comparison.to)}</span>
                  </th>
                  <th scope="col">Variazione</th>
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td className="report-compare-cur">{row.cur}</td>
                    <td className="report-compare-prev">{row.prev}</td>
                    <td>{renderDeltaCell(row.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Con il confronto attivo le card KPI ripetono i numeri del pannello
          "Confronto periodi" qui sopra: si mostrano SOLO senza confronto. */}
      {!(compare && a?.comparison) ? (
      <>
      <div className="report-kpi-grid mb-3">
        {/* Drill-down (2026-07-20): i KPI operativi sono LINK verso il modulo
            di origine col periodo trasferito dove la pagina lo supporta. */}
        <a className="report-kpi report-kpi-link" href={`/${encodeURIComponent(slug)}/pos_history?from=${rng.from}&to=${rng.to}`} title="Apri Movimenti nel periodo">
          <div className="label">Incasso</div>
          <div className="value">{fmtMoney(a?.summary.totalRevenue)}</div>
          <div className="sub">
            Venduto {fmtMoney(a?.summary.soldRevenue)} / Lordo {fmtMoney(a?.summary.grossRevenue)}
          </div>
          {(a?.summary.collectionMovements ?? 0) > 0 ? (
            <div className="sub">Movimenti incasso {fmtInt(a?.summary.collectionMovements)}</div>
          ) : null}        </a>
        <a className="report-kpi report-kpi-link" href={`/${encodeURIComponent(slug)}/pos_history?from=${rng.from}&to=${rng.to}`} title="Apri Movimenti nel periodo">
          <div className="label">Vendite</div>
          <div className="value">{fmtInt(a?.summary.saleCount)}</div>
          <div className="sub">Periodo selezionato</div>        </a>
        <div className="report-kpi">
          <div className="label">Scontrino medio</div>
          <div className="value">{fmtMoney(a?.summary.averageTicket)}</div>
          <div className="sub">Periodo selezionato</div>        </div>
        <div className="report-kpi">
          <div className="label">Clienti serviti</div>
          <div className="value">{fmtInt(a?.summary.servedClients)}</div>
          <div className="sub">Clienti associati alle vendite</div>        </div>
      </div>

      <div className="report-kpi-grid mb-3">
        <a className="report-kpi report-kpi-link" href={`/${encodeURIComponent(slug)}/appointments`} title="Apri la lista appuntamenti">
          <div className="label">Prenotazioni</div>
          <div className="value">{fmtInt(a?.summary.appointmentCount)}</div>
          <div className="sub">Non annullate nel periodo</div>
          <div className="sub">
            In attesa {fmtInt(a?.appointments.pending)} / Prenotate {fmtInt(a?.appointments.scheduled)} / Eseguite {fmtInt(a?.appointments.done)} / Annullate {fmtInt(a?.appointments.canceled)} / No show {fmtInt(a?.appointments.noShow)}
          </div>
          {(a?.appointments.total ?? 0) > 0 ? (
            <div className="sub">
              Eseguite {apptPct(a?.appointments.done)} · Annullate {apptPct(a?.appointments.canceled)} · No show {apptPct(a?.appointments.noShow)}
            </div>
          ) : null}        </a>
        <div className="report-kpi">
          <div className="label">Clienti nel periodo</div>
          <div className="value">{fmtInt(a?.newVsReturning.windowClients)}</div>
          <div className="sub">
            Nuovi {fmtInt(a?.newVsReturning.newClients)} / Di ritorno {fmtInt(a?.newVsReturning.returningClients)}
          </div>
          <div className="sub">Nuovo = prima vendita in assoluto nel periodo</div>
        </div>
        <div className="report-kpi">
          <div className="label">Clienti in archivio</div>
          <div className="value">{fmtInt(arch?.total ?? k.clients)}</div>
          <div className="sub">Profilo clienti {locationLabelText.toLowerCase()}</div>
        </div>
        {/* KPI "Genere prevalente" ed "Età media" rimossi (2026-07-21): erano il
            doppione dei grafici "Clienti per genere" e "Clienti per età" della
            sezione Composizione, e lasciavano una 5ª card orfana nella griglia
            a 4 colonne. Il dettaglio demografico vive ora solo nei grafici. */}
      </div>

      {(a?.costs || a?.commissions) ? (
        <div className="report-kpi-grid mb-3">
          {a?.costs ? (
            <a className="report-kpi report-kpi-link" href={`/${encodeURIComponent(slug)}/costs?from=${rng.from}&to=${rng.to}`} title="Apri Scadenziario e Costi nel periodo">
              <div className="label">Costi</div>
              <div className="value">{fmtMoney(a.costs.total)}</div>
              <div className="sub">Residuo {fmtMoney(a.costs.open)}</div>            </a>
          ) : null}
          {a?.commissions ? (
            <a className="report-kpi report-kpi-link" href={`/${encodeURIComponent(slug)}/commissions?from=${rng.from}&to=${rng.to}`} title="Apri Commissioni nel periodo">
              <div className="label">Commissioni</div>
              <div className="value">{fmtMoney(a.commissions.total)}</div>
              <div className="sub">Da pagare {fmtMoney(a.commissions.open)}</div>            </a>
          ) : null}
        </div>
      ) : null}
      </>
      ) : null}

      <div className="row g-3 mb-3" id="rep-andamento">
        <div className="col-xl-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Andamento incasso</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">{trendBadge}</span>
                {(a?.daily.length ?? 0) > 0 ? (
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="Esporta CSV"
                    aria-label="Esporta andamento incasso in CSV"
                    onClick={() =>
                      downloadCsv(`incasso_${a?.from}_${a?.to}.csv`, [
                        ["Giorno", "Incasso", "Movimenti"],
                        ...(a?.daily ?? []).map((r) => [itDate(r.day.slice(0, 10)), numberFormatIt(r.revenue, 2), r.saleCount]),
                      ])
                    }
                  >
                    <i className="bi bi-download" />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="report-chart-wrap">
              {hasChart.trend ? <canvas role="img" id="reportTrendChart" aria-label="Andamento incasso" /> : chartEmpty}
            </div>
            {hasChart.trend ? (
              <div className="report-chart-hint text-muted small px-3 pb-2 d-print-none">Clicca un punto per aprire i Movimenti del giorno.</div>
            ) : null}
          </div>
        </div>
        <div className="col-xl-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Andamento prenotazioni</div>
              <span className="badge text-bg-light">{trendBadge}</span>
            </div>
            <div className="report-chart-wrap">
              {hasChart.appt ? <canvas role="img" id="reportAppointmentsTrendChart" aria-label="Andamento prenotazioni" /> : chartEmpty}
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3" id="rep-mix">
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Tipologie di vendita</div>
              <span className="badge text-bg-light">Tipologia</span>
            </div>
            <div className="report-chart-wrap">
              {hasChart.salesTypes ? <canvas role="img" id="reportSalesTypesChart" aria-label="Tipologie di vendita" /> : chartEmpty}
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Metodi di pagamento</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Importi</span>
                {(a?.paymentMethods.length ?? 0) > 0 ? (
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="Esporta CSV"
                    aria-label="Esporta metodi di pagamento in CSV"
                    onClick={() =>
                      downloadCsv(`metodi_pagamento_${a?.from}_${a?.to}.csv`, [
                        ["Metodo", "Importo", "Movimenti", "Quota %"],
                        ...(a?.paymentMethods ?? []).map((m) => [m.label, numberFormatIt(m.amount, 2), m.count, numberFormatIt(m.sharePct, 1)]),
                      ])
                    }
                  >
                    <i className="bi bi-download" />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="report-chart-wrap">
              {hasChart.paymentMethods ? <canvas role="img" id="reportPaymentMethodsChart" aria-label="Metodi di pagamento" /> : chartEmpty}
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Clienti per genere</div>
              <span className="badge text-bg-light">Archivio</span>
            </div>
            <div className="report-chart-wrap">
              {hasChart.gender ? <canvas role="img" id="reportGenderChart" aria-label="Clienti per genere" /> : chartEmpty}
            </div>
          </div>
        </div>
        <div className="col-xl-3 col-md-6">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Clienti per et&agrave;</div>
              <span className="badge text-bg-light">Fasce</span>
            </div>
            <div className="report-chart-wrap">
              {hasChart.age ? <canvas role="img" id="reportAgeChart" aria-label="Clienti per età" /> : chartEmpty}
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3" id="rep-top">
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Top clienti</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
                {(a?.topClients.length ?? 0) > 0 ? (
                  <>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      type="button"
                      title="Esporta CSV"
                      aria-label="Esporta top clienti in CSV"
                      onClick={() =>
                        downloadCsv(`top_clienti_${a?.from}_${a?.to}.csv`, [
                          ["Cliente", "Vendite", "Totale"],
                          ...(a?.topClients ?? []).map((c) => [c.name, c.saleCount, numberFormatIt(c.revenue, 2)]),
                        ])
                      }
                    >
                      <i className="bi bi-download" />
                    </button>
                    <button className="btn btn-sm btn-outline-primary" type="button" data-bs-toggle="modal" data-bs-target="#reportClientsModal">
                      <i className="bi bi-search me-1"></i>Mostra altro
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              {hasChart.clients ? <canvas role="img" id="reportClientsChart" aria-label="Top clienti" /> : chartEmpty}
            </div>
          </div>
        </div>
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Top servizi e prodotti</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
                {(a?.topItems.length ?? 0) > 0 ? (
                  <>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      type="button"
                      title="Esporta CSV"
                      aria-label="Esporta top servizi e prodotti in CSV"
                      onClick={() =>
                        downloadCsv(`top_voci_${a?.from}_${a?.to}.csv`, [
                          ["Voce", "Tipo", "Quantità", "Vendite", "Totale"],
                          ...(a?.topItems ?? []).map((it) => [it.name, it.type ?? "", fmtQty(it.qty), it.saleCount ?? 0, numberFormatIt(it.revenue, 2)]),
                        ])
                      }
                    >
                      <i className="bi bi-download" />
                    </button>
                    <button className="btn btn-sm btn-outline-primary" type="button" data-bs-toggle="modal" data-bs-target="#reportItemsModal">
                      <i className="bi bi-search me-1"></i>Mostra altro
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              {hasChart.items ? <canvas role="img" id="reportItemsChart" aria-label="Top servizi e prodotti" /> : chartEmpty}
            </div>
          </div>
        </div>
        <div className="col-xl-4">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Operatori</div>
              <div className="report-section-actions">
                <span className="badge text-bg-light">Top 10</span>
                {(a?.operators.length ?? 0) > 0 ? (
                  <>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      type="button"
                      title="Esporta CSV"
                      aria-label="Esporta operatori in CSV"
                      onClick={() =>
                        downloadCsv(`operatori_${a?.from}_${a?.to}.csv`, [
                          ["Operatore", "Vendite", "Totale", "Scontrino medio", "Ore lavorate", "Appuntamenti"],
                          ...(a?.operators ?? []).map((o) => [o.name, o.saleCount, numberFormatIt(o.revenue, 2), numberFormatIt(o.avgTicket, 2), numberFormatIt(o.hoursWorked, 1), o.apptCount]),
                        ])
                      }
                    >
                      <i className="bi bi-download" />
                    </button>
                    <button className="btn btn-sm btn-outline-primary" type="button" data-bs-toggle="modal" data-bs-target="#reportOperatorsModal">
                      <i className="bi bi-search me-1"></i>Mostra altro
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="report-chart-wrap is-compact is-top10">
              {hasChart.operators ? <canvas role="img" id="reportOperatorsChart" aria-label="Operatori" /> : chartEmpty}
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3" id="rep-finanza">
        <div className="col-12">
          <div className="report-panel">
            <div className="report-section-title border-bottom">
              <div className="fw-semibold" role="heading" aria-level={2}>Incasso e costi</div>
              <span className="badge text-bg-light">Periodo</span>
            </div>
            <div className="report-finance-layout">
              <div className="report-chart-wrap is-compact">
                {hasChart.finance ? <canvas role="img" id="reportFinanceChart" aria-label="Incasso e costi" /> : chartEmpty}
              </div>
              <div className="report-finance-summary">
                <div className="report-finance-line">
                  <div>
                    <div className="report-finance-label">Incasso</div>
                    <div className="report-finance-sub">
                      Movimenti {fmtInt(a?.summary.collectionMovements)} / Venduto {fmtMoney(a?.summary.soldRevenue)} / Scontrino medio{" "}
                      {fmtMoney(a?.summary.averageTicket)}
                    </div>
                    {renderDelta(incassoDelta, " mt-1")}
                  </div>
                  <div className="report-finance-value">{fmtMoney(a?.summary.totalRevenue)}</div>
                </div>
                {a?.costs ? (
                  <div className="report-finance-line">
                    <div>
                      <div className="report-finance-label">Costi</div>
                      <div className="report-finance-sub">Pagato {fmtMoney(a.costs.paid)} / Residuo {fmtMoney(a.costs.open)}</div>
                      {renderDelta(costiDelta, " mt-1")}
                    </div>
                    <div className="report-finance-value">{fmtMoney(a.costs.total)}</div>
                  </div>
                ) : null}
                {a?.commissions ? (
                  <div className="report-finance-line">
                    <div>
                      <div className="report-finance-label">Commissioni</div>
                      <div className="report-finance-sub">Pagate {fmtMoney(a.commissions.paid)} / Da pagare {fmtMoney(a.commissions.open)}</div>
                      {renderDelta(commissioniDelta, " mt-1")}
                    </div>
                    <div className="report-finance-value">{fmtMoney(a.commissions.total)}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sedi a confronto (rivoluzione 2026-07-20): solo con "Tutte le sedi"
          attivo. Venduto NETTO + vendite per sale_date, prenotazioni attive
          per starts_at — NON è l'Incasso a eventi di cassa. */}
      {(a?.locationsBreakdown.length ?? 0) > 0 ? (
        <div className="row g-3 mb-3" id="rep-sedi">
          <div className="col-12">
            <div className="report-panel">
              <div className="report-section-title border-bottom">
                <div className="fw-semibold" role="heading" aria-level={2}>Sedi a confronto</div>
                <div className="report-section-actions">
                  <span className="badge text-bg-light">Venduto netto</span>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    type="button"
                    title="Esporta CSV"
                    aria-label="Esporta confronto sedi in CSV"
                    onClick={() =>
                      downloadCsv(`sedi_${a?.from}_${a?.to}.csv`, [
                        ["Sede", "Venduto", "Vendite", "Prenotazioni"],
                        ...(a?.locationsBreakdown ?? []).map((l) => [l.name ?? "—", numberFormatIt(l.soldRevenue, 2), l.saleCount, l.appointmentCount]),
                      ])
                    }
                  >
                    <i className="bi bi-download" />
                  </button>
                </div>
              </div>
              <div className="report-modal-table-wrap p-3 pt-2">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th>Sede</th>
                      <th className="text-end">Venduto</th>
                      <th className="text-end">Vendite</th>
                      <th className="text-end">Prenotazioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(a?.locationsBreakdown ?? []).map((l) => (
                      <tr key={l.id === null ? "null" : l.id}>
                        <td>{l.name ?? "—"}</td>
                        <td className="text-end fw-semibold">{fmtMoney(l.soldRevenue)}</td>
                        <td className="text-end">{fmtInt(l.saleCount)}</td>
                        <td className="text-end">{fmtInt(l.appointmentCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-muted small mt-2">
                  Venduto netto per data vendita e prenotazioni attive per data appuntamento — il totale può differire
                  dall&apos;Incasso, che segue gli eventi di cassa.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Fidelity del periodo (rivoluzione 2026-07-20): visibile solo se nel
          periodo c'è almeno un numero — zero rumore per chi non usa il modulo. */}
      {fidelityHasData ? (
        <div className="row g-3 mb-3" id="rep-fidelity">
          <div className="col-12">
            <div className="report-panel">
              <div className="report-section-title border-bottom">
                <div className="fw-semibold" role="heading" aria-level={2}>Fidelity nel periodo</div>
                <span className="badge text-bg-light">Punti · Ricariche · GiftCard</span>
              </div>
              <div className="report-kpi-grid p-3 pt-2">
                <div className="report-kpi">
                  <div className="label">Punti emessi</div>
                  <div className="value">{fmtQty(fp?.pointsIssued)}</div>
                  <div className="sub">Punti utilizzati {fmtQty(fp?.pointsUsed)}</div>
                </div>
                <div className="report-kpi">
                  <div className="label">Ricariche vendute</div>
                  <div className="value">{fmtInt(fp?.rechargesCount)}</div>
                  <div className="sub">Incassato alla cassa {fmtMoney(fp?.rechargesAmount)}</div>
                </div>
                <div className="report-kpi">
                  <div className="label">GiftCard emesse</div>
                  <div className="value">{fmtInt(fp?.giftcardsIssued)}</div>
                  <div className="sub">Valore iniziale {fmtMoney(fp?.giftcardsIssuedAmount)}</div>
                </div>
                <div className="report-kpi">
                  <div className="label">Utilizzi in vendita</div>
                  <div className="value">{fmtMoney((fp?.giftcardUsedAmount ?? 0) + (fp?.creditUsedAmount ?? 0))}</div>
                  <div className="sub">GiftCard {fmtMoney(fp?.giftcardUsedAmount)} / Credito {fmtMoney(fp?.creditUsedAmount)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </>
      )}

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
                  {fmtInt(filteredClients.length)} {filteredClients.length === 1 ? "risultato" : "risultati"}
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
                          <td className="text-muted">{fmtInt(i + 1)}</td>
                          <td>
                            {c.clientId > 0 ? (
                              <a href={`/${encodeURIComponent(slug)}/clients?action=view&id=${c.clientId}`}>{c.name}</a>
                            ) : (
                              c.name
                            )}
                          </td>
                          <td className="text-end">{fmtInt(c.saleCount)}</td>
                          <td className="text-end fw-semibold">{fmtMoney(c.revenue)}</td>
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
                  {fmtInt(filteredItems.length)} {filteredItems.length === 1 ? "risultato" : "risultati"}
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
                          <td className="text-muted">{fmtInt(i + 1)}</td>
                          <td>{it.name}</td>
                          <td><span className="badge text-bg-light">{it.type ?? "Voce"}</span></td>
                          <td className="text-end">{fmtQty(it.qty)}</td>
                          <td className="text-end">{fmtInt(it.saleCount)}</td>
                          <td className="text-end fw-semibold">{fmtMoney(it.revenue)}</td>
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
                  {fmtInt(filteredOperators.length)} {filteredOperators.length === 1 ? "risultato" : "risultati"}
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
                          <td className="text-muted">{fmtInt(i + 1)}</td>
                          <td>
                            <a href={`/${encodeURIComponent(slug)}/commissions?from=${rng.from}&to=${rng.to}`} title="Apri Commissioni nel periodo">
                              {o.name}
                            </a>
                          </td>
                          <td className="text-end">{fmtHours(o.hoursWorked)}</td>
                          <td className="text-end">{fmtInt(o.apptCount)}</td>
                          <td className="text-end">{fmtInt(o.saleCount)}</td>
                          <td className="text-end">{fmtMoney(o.avgTicket)}</td>
                          <td className="text-end fw-semibold">{fmtMoney(o.revenue)}</td>
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
