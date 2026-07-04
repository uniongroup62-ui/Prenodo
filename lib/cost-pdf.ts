import "server-only";

// PDF EXPORT "Scadenziario e Costi" — port del blocco MiniPdf di costs.php
// (~1650-1845): titolo "Scadenziario e Costi - Scadenziario", riga "Generato il",
// riga filtri "Periodo ... | Sede ... | Stato ... | Categoria #N | Ricerca "..."",
// tabella a colonne fisse (header grigio ripetuto a ogni pagina, wrap con
// l'approssimazione Helvetica del legacy, sfondo rosa per gli scaduti) e blocco
// "Totali" finale. Stesse coordinate/misure del MiniPdf (A4, margine 40,
// fs 9 / lineH 11, approxTextWidth = len * size * 0.5).

import PDFDocument from "pdfkit";
import type { CostRow } from "@/lib/manage-costs";

const F1 = "Helvetica";
const F2 = "Helvetica-Bold";

// number_format($n, 2, ',', '.') manuale (l'ICU server-side può omettere il
// raggruppamento migliaia con toLocaleString).
const fmtMoney = (n: number) => {
  const value = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
};
const fmtDate = (d: string) => {
  const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

// MiniPdf::approxTextWidth — ~0.5 * fontSize per carattere.
function approxTextWidth(s: string, size: number): number {
  return s.length * size * 0.5;
}

// MiniPdf::wrapText — wrap per parole a maxChars, spezzando le parole lunghe.
function wrapText(text: string, maxChars: number): string[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [""];
  const out: string[] = [];
  for (const para of trimmed.split(/\r?\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > maxChars) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

export type CostsPdfOptions = {
  rows: CostRow[];
  summary: { overdueAmount: number; dueAmount: number; paidAmount: number };
  filters: { from: string; to: string; status: string; categoryId: number; query: string };
  // "" = niente colonna/riga Sede (parità con $hasCostLocationCol=false è N/A qui:
  // la colonna c'è sempre nel Next; il label sede compare nella riga filtri).
  locationLabel: string;
  showLocationColumn: boolean;
  generatedAt?: Date;
};

export function renderCostsPdf(options: CostsPdfOptions): Promise<Buffer> {
  const W = 595.28;
  const H = 841.89;
  const M = 40;

  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: true, info: { Title: "Scadenziario e Costi - Scadenziario" } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // text() MiniPdf: la y è la BASELINE — pdfkit posiziona il top del glifo.
  const text = (x: number, yBaseline: number, font: string, size: number, value: string) => {
    doc.font(font).fontSize(size).fillColor("black");
    doc.text(value, x, yBaseline - size, { lineBreak: false });
  };
  const rect = (x: number, yTop: number, w: number, h: number, fill?: string, stroke?: string) => {
    if (fill) doc.rect(x, yTop, w, h).fill(fill);
    if (stroke) doc.rect(x, yTop, w, h).stroke(stroke);
  };

  const x0 = M;
  let y = M;

  text(x0, y, F2, 16, "Scadenziario e Costi - Scadenziario");
  y += 20;
  const generated = options.generatedAt ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  text(x0, y, F1, 10, `Generato il ${pad(generated.getDate())}/${pad(generated.getMonth() + 1)}/${generated.getFullYear()} ${pad(generated.getHours())}:${pad(generated.getMinutes())}`);
  y += 14;

  const statusLabel =
    options.filters.status === "open" ? "Da pagare"
    : options.filters.status === "overdue" ? "Scaduti"
    : options.filters.status === "paid" ? "Pagati"
    : "Tutti";
  const filterParts = [`Periodo ${fmtDate(options.filters.from)} - ${fmtDate(options.filters.to)}`];
  if (options.locationLabel) filterParts.push(`Sede ${options.locationLabel}`);
  filterParts.push(`Stato ${statusLabel}`);
  if (options.filters.categoryId > 0) filterParts.push(`Categoria #${options.filters.categoryId}`);
  if (options.filters.query) filterParts.push(`Ricerca "${options.filters.query}"`);
  const filterLine = filterParts.join(" | ");
  if (filterLine) {
    text(x0, y, F1, 10, filterLine);
    y += 16;
  }
  y += 6;

  type Col = { label: string; w: number; align: "left" | "right" };
  const cols: Col[] = [
    { label: "Scadenza", w: 50, align: "left" },
    { label: "Titolo", w: options.showLocationColumn ? 130 : 180, align: "left" },
  ];
  if (options.showLocationColumn) cols.push({ label: "Sede", w: 60, align: "left" });
  cols.push(
    { label: "Categoria", w: 60, align: "left" },
    { label: "Fornitore", w: 60, align: "left" },
    { label: "Stato", w: 45, align: "left" },
    { label: "Totale", w: 50, align: "right" },
    { label: "Residuo", w: 50, align: "right" },
  );
  const contentW = cols.reduce((sum, c) => sum + c.w, 0);

  const fs = 9.0;
  const lineH = 11.0;

  const drawHeader = () => {
    rect(x0, y, contentW, 16, "#f2f2f2");
    rect(x0, y, contentW, 16, undefined, "#d9d9d9");
    let cx = x0;
    for (const c of cols) {
      text(cx + 2, y + 12, F2, fs, c.label);
      cx += c.w;
    }
    y += 18;
  };

  drawHeader();

  const bottom = H - M - 10;

  for (const r of options.rows) {
    const statusTxt = r.isPaid ? "Pagato" : r.status === "overdue" ? "Scaduto" : "Da pagare";
    const cells: string[] = [fmtDate(r.dueDate), r.title];
    if (options.showLocationColumn) cells.push(r.locationName || "");
    cells.push(r.categoryName || "", r.supplierName || "", statusTxt, `€ ${fmtMoney(r.amount)}`, `€ ${fmtMoney(r.remainingAmount)}`);

    const wraps: string[][] = [];
    let maxLines = 1;
    for (let i = 0; i < cols.length; i++) {
      let maxChars = Math.max(1, Math.floor(cols[i].w / (fs * 0.5)) - 1);
      if (cols[i].align === "right") maxChars = 32;
      const lines = wrapText(cells[i] ?? "", maxChars);
      wraps[i] = lines;
      maxLines = Math.max(maxLines, lines.length);
    }

    const rowH = maxLines * lineH + 6;
    if (y + rowH > bottom) {
      doc.addPage();
      y = M;
      drawHeader();
    }

    if (r.status === "overdue") rect(x0, y - 2, contentW, rowH, "#ffefef");
    rect(x0, y - 2, contentW, rowH, undefined, "#e0e0e0");

    let cx = x0;
    for (let i = 0; i < cols.length; i++) {
      const lines = wraps[i] ?? [""];
      for (let li = 0; li < lines.length; li++) {
        const ty = y + 10 + li * lineH;
        if (cols[i].align === "right") {
          const tw = approxTextWidth(lines[li], fs);
          text(cx + cols[i].w - 2 - tw, ty, F1, fs, lines[li]);
        } else {
          text(cx + 2, ty, F1, fs, lines[li]);
        }
      }
      cx += cols[i].w;
    }

    y += rowH;
  }

  y += 12;
  if (y + 40 > bottom) {
    doc.addPage();
    y = M;
  }
  text(x0, y, F2, 12, "Totali");
  y += 14;
  text(
    x0,
    y,
    F1,
    10,
    `Scaduti: € ${fmtMoney(options.summary.overdueAmount)}   |   In scadenza: € ${fmtMoney(options.summary.dueAmount)}   |   Pagati: € ${fmtMoney(options.summary.paidAmount)}`,
  );

  doc.end();
  return done;
}
