"use client";

// Grafici SVG del pannello SaaS Admin (vista Statistiche, 2026-07-19).
// Nessuna dipendenza esterna. Regole seguite (guida dataviz): marks sottili
// con estremita' superiore arrotondata ancorata alla baseline, gap fra barre
// adiacenti, griglia recessiva, etichette dirette SELETTIVE (ultimo + massimo,
// il resto in tooltip <title>), legenda solo con >=2 serie, testi nei toni
// testo (mai nel colore serie). Palette VALIDATA (validate_palette.js):
// #365a96 + #d97706, dE CVD >= 25 su superficie chiara.

export const CHART_PRIMARY = "#365a96";
export const CHART_SECONDARY = "#d97706";

type Bucket = { label: string; value: number };
type DualBucket = { label: string; a: number; b: number };

const W = 560;
const H = 190;
const PAD = { top: 18, right: 8, bottom: 26, left: 8 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const unit = value / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

// Colonna con SOLO gli angoli superiori arrotondati (data-end), base piatta
// sulla baseline.
function topRoundedBar(x: number, y: number, width: number, height: number, fill: string, title: string, key: string) {
  const r = Math.min(4, width / 2, height);
  const d = height <= 0
    ? ""
    : `M ${x} ${y + height} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + width - r} ${y} Q ${x + width} ${y} ${x + width} ${y + r} L ${x + width} ${y + height} Z`;
  return (
    <path d={d} fill={fill} key={key}>
      <title>{title}</title>
    </path>
  );
}

function gridAndFrame(max: number, formatValue: (v: number) => string) {
  // Con massimi piccoli l'etichetta di meta' scala coincide con quella del
  // massimo (arrotondamento): in quel caso la si omette.
  const halfLabel = formatValue(max * 0.5);
  const fullLabel = formatValue(max);
  const lines = [0.5, 1].map((f) => {
    const y = PAD.top + (1 - f) * (H - PAD.top - PAD.bottom);
    const label = f === 0.5 && halfLabel === fullLabel ? "" : formatValue(max * f);
    return (
      <g key={f}>
        <line stroke="#e2e8f0" strokeWidth={1} x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} />
        {label ? <text fill="#94a3b8" fontSize={10} x={PAD.left + 2} y={y - 3}>{label}</text> : null}
      </g>
    );
  });
  const baseY = H - PAD.bottom;
  return (
    <g>
      {lines}
      <line stroke="#cbd5e1" strokeWidth={1} x1={PAD.left} x2={W - PAD.right} y1={baseY} y2={baseY} />
    </g>
  );
}

function monthShort(label: string): string {
  const m = label.match(/^(\d{4})-(\d{2})/);
  if (!m) return label;
  const months = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  return months[Number(m[2]) - 1] ?? label;
}

// Barre mensili a UNA serie: etichette dirette solo su massimo e ultimo.
export function MonthBarChart({ data, formatValue = (v) => String(Math.round(v)), emptyText = "Nessun dato nel periodo." }: { data: Bucket[]; formatValue?: (v: number) => string; emptyText?: string }) {
  if (!data.length || data.every((d) => d.value === 0)) {
    return <p className="p-3 text-sm text-slate-500">{emptyText}</p>;
  }
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const barW = Math.min(28, Math.max(6, slot - 10));
  const maxIndex = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  return (
    <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
      {gridAndFrame(max, formatValue)}
      {data.map((d, i) => {
        const h = (d.value / max) * innerH;
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const y = H - PAD.bottom - h;
        const labeled = i === maxIndex || i === data.length - 1;
        return (
          <g key={d.label}>
            {topRoundedBar(x, y, barW, h, CHART_PRIMARY, `${d.label}: ${formatValue(d.value)}`, `b-${d.label}`)}
            {labeled && d.value > 0 ? <text fill="#334155" fontSize={10} fontWeight={600} textAnchor="middle" x={x + barW / 2} y={y - 4}>{formatValue(d.value)}</text> : null}
            <text fill="#64748b" fontSize={10} textAnchor="middle" x={PAD.left + i * slot + slot / 2} y={H - 8}>{monthShort(d.label)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Barre mensili a DUE serie affiancate (gap 2px) con legenda.
export function DualMonthBarChart({ data, nameA, nameB, formatValue = (v) => String(Math.round(v)), emptyText = "Nessun dato nel periodo." }: { data: DualBucket[]; nameA: string; nameB: string; formatValue?: (v: number) => string; emptyText?: string }) {
  if (!data.length || data.every((d) => d.a === 0 && d.b === 0)) {
    return <p className="p-3 text-sm text-slate-500">{emptyText}</p>;
  }
  const max = niceMax(Math.max(...data.flatMap((d) => [d.a, d.b])));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const barW = Math.min(14, Math.max(4, (slot - 8) / 2 - 1));
  return (
    <div>
      <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
        {gridAndFrame(max, formatValue)}
        {data.map((d, i) => {
          const x0 = PAD.left + i * slot + (slot - barW * 2 - 2) / 2;
          const hA = (d.a / max) * innerH;
          const hB = (d.b / max) * innerH;
          return (
            <g key={d.label}>
              {topRoundedBar(x0, H - PAD.bottom - hA, barW, hA, CHART_PRIMARY, `${d.label} — ${nameA}: ${formatValue(d.a)}`, `a-${d.label}`)}
              {topRoundedBar(x0 + barW + 2, H - PAD.bottom - hB, barW, hB, CHART_SECONDARY, `${d.label} — ${nameB}: ${formatValue(d.b)}`, `bb-${d.label}`)}
              <text fill="#64748b" fontSize={10} textAnchor="middle" x={PAD.left + i * slot + slot / 2} y={H - 8}>{monthShort(d.label)}</text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex gap-4 px-2 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: CHART_PRIMARY }} />{nameA}</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: CHART_SECONDARY }} />{nameB}</span>
      </div>
    </div>
  );
}

function dayShort(label: string): string {
  const m = label.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : label;
}

// Linea (trend giornaliero): 2px, marker sugli estremi, tooltip per punto.
// A valori TUTTI zero niente scala inventata (niceMax(0)=1 disegnerebbe
// griglie per soldi che non esistono): messaggio onesto e basta.
export function TrendLineChart({ points, formatValue = (v) => String(v), emptyText = "Lo storico si costruisce dagli snapshot giornalieri del cron.", zeroText = "Tutti i valori del periodo sono a zero." }: { points: Array<{ label: string; value: number }>; formatValue?: (v: number) => string; emptyText?: string; zeroText?: string }) {
  if (points.length < 2) {
    return <p className="p-3 text-sm text-slate-500">{emptyText}</p>;
  }
  if (points.every((p) => p.value === 0)) {
    return <p className="p-3 text-sm text-slate-500">{zeroText}</p>;
  }
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yAt = (v: number) => H - PAD.bottom - (v / max) * innerH;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg className="w-full" role="img" viewBox={`0 0 ${W} ${H}`}>
      {gridAndFrame(max, formatValue)}
      <path d={path} fill="none" stroke={CHART_PRIMARY} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
      {points.map((p, i) => (
        <circle cx={xAt(i)} cy={yAt(p.value)} fill={i === points.length - 1 ? CHART_PRIMARY : "transparent"} key={p.label} r={i === points.length - 1 ? 4 : 8} stroke="none">
          <title>{`${p.label}: ${formatValue(p.value)}`}</title>
        </circle>
      ))}
      <text fill="#334155" fontSize={10} fontWeight={600} textAnchor="end" x={W - PAD.right} y={yAt(last.value) - 8}>{formatValue(last.value)}</text>
      <text fill="#64748b" fontSize={10} textAnchor="start" x={PAD.left} y={H - 8}>{dayShort(points[0].label)}</text>
      <text fill="#64748b" fontSize={10} textAnchor="end" x={W - PAD.right} y={H - 8}>{dayShort(last.label)}</text>
    </svg>
  );
}
