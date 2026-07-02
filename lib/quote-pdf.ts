import "server-only";

// PDF PREVENTIVO — port of app/lib/QuotePdf.php quote_pdf_render (MiniPdf):
// A4 595.28x841.89, margine 40, Helvetica (F1) / Helvetica-Bold (F2), stesso
// layout e stesse coordinate del legacy: header azienda, titolo PREVENTIVO,
// riga meta (N./Data/Valido fino al), blocco Cliente, tabella con header
// grigio + bordi + colonne verticali (con re-header a ogni salto pagina),
// box totali grigio 240pt allineato a destra, paragrafi Nota / Metodi di
// pagamento / Condizioni / Footer. Renderizzato con pdfkit (font standard
// Helvetica: niente asset esterni).

import PDFDocument from "pdfkit";

export type QuotePdfData = {
  number: string;
  quoteDate: string | null; // Y-m-d
  validUntil: string | null; // Y-m-d
  business: {
    companyName: string;
    addressLine: string; // "indirizzo - CAP citta (PROV)" già composto
    infoLine: string; // "P.IVA: .. | C.F.: .. | ..." già composto
    footer: string;
  };
  clientName: string;
  clientLines: string[]; // Azienda / indirizzo / tax bits / contatti, già composte
  items: Array<{
    description: string;
    sku: string;
    discountPercent: number;
    qty: number;
    unitPrice: number;
    taxRate: number;
    lineTotal: number;
  }>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  publicNote: string;
  paymentMethodsText: string; // già join con \n
  terms: string; // già con il fallback business (legacy: q.terms || terms_default)
};

const F1 = "Helvetica";
const F2 = "Helvetica-Bold";

const fmtMoney = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string | null) => {
  const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};
// Il tax_rate/sconto del legacy: numero senza zeri finali ("22", "8.5").
const fmtRate = (n: number) => String(Math.round(n * 100) / 100);

// Port di MiniPdf::wrapText: wrap per parole a maxChars, spezzando le parole lunghe.
function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
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

export function renderQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const W = 595.28;
  const H = 841.89;
  const M = 40;
  const contentW = W - 2 * M;

  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: true, info: { Title: `Preventivo ${data.number}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // text() del MiniPdf: la y legacy è la BASELINE — pdfkit posiziona il top del
  // glifo, quindi si compensa con l'altezza del font (~size).
  const text = (x: number, yBaseline: number, font: string, size: number, value: string) => {
    doc.font(font).fontSize(size).fillColor("black");
    doc.text(value, x, yBaseline - size, { lineBreak: false });
  };
  const textRight = (rightEdge: number, yBaseline: number, font: string, size: number, value: string) => {
    doc.font(font).fontSize(size);
    const w = doc.widthOfString(value);
    text(rightEdge - w, yBaseline, font, size, value);
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor("black").lineWidth(0.7).stroke();
  };
  const rect = (x: number, y: number, w: number, h: number, fill?: string) => {
    if (fill) doc.rect(x, y, w, h).fillColor(fill).fill();
    else doc.rect(x, y, w, h).strokeColor("black").lineWidth(0.7).stroke();
  };

  let y = M;
  const pageBottom = H - M;

  // --- Header azienda ---
  const bizName = data.business.companyName.trim() || "—";
  text(M, y + 4 + 15, F2, 15, bizName); // legacy: baseline a y+4 con font 15 disegnato sopra
  y += 22;
  const bizLines: string[] = [];
  if (data.business.addressLine) bizLines.push(data.business.addressLine);
  if (data.business.infoLine) bizLines.push(data.business.infoLine);
  for (const ln of bizLines) {
    text(M, y + 10.5, F1, 10.5, ln);
    y += 14;
  }

  // --- Titolo ---
  y += 6;
  text(M, y + 18, F2, 18, "PREVENTIVO");
  y += 22;

  const meta: string[] = [];
  if (data.number) meta.push(`N. ${data.number}`);
  const qDate = fmtDate(data.quoteDate);
  if (qDate) meta.push(`Data: ${qDate}`);
  const valid = fmtDate(data.validUntil);
  if (valid) meta.push(`Valido fino al: ${valid}`);
  if (meta.length) {
    text(M, y + 11, F1, 11, meta.join("   |   "));
    y += 18;
  }

  // --- Cliente ---
  text(M, y + 12.5, F2, 12.5, "Cliente");
  y += 18;
  text(M, y + 11, F1, 11, data.clientName.trim() || "—");
  y += 16;
  for (const ln of data.clientLines) {
    text(M, y + 10.5, F1, 10.5, ln);
    y += 14;
  }
  y += 10;

  // --- Tabella (stesse colonne del legacy) ---
  const colDesc = 275;
  const colQty = 45;
  const colUnit = 70;
  const colTax = 45;
  const colTot = Math.max(60, contentW - (colDesc + colQty + colUnit + colTax));
  const tableW = colDesc + colQty + colUnit + colTax + colTot;
  const x0 = M;
  const x1 = x0 + colDesc;
  const x2 = x1 + colQty;
  const x3 = x2 + colUnit;
  const x4 = x3 + colTax;
  const headerH = 20;
  const rowLH = 12.5;

  const drawTableHeader = () => {
    rect(x0, y, tableW, headerH, "#f2f2f2");
    rect(x0, y, tableW, headerH);
    line(x1, y, x1, y + headerH);
    line(x2, y, x2, y + headerH);
    line(x3, y, x3, y + headerH);
    line(x4, y, x4, y + headerH);
    text(x0 + 4, y + 14.2, F2, 10.5, "Descrizione");
    textRight(x2 - 8, y + 14.2, F2, 10.5, "Q.tà");
    textRight(x3 - 8, y + 14.2, F2, 10.5, "Prezzo");
    textRight(x4 - 8, y + 14.2, F2, 10.5, "IVA");
    textRight(x4 + colTot - 8, y + 14.2, F2, 10.5, "Totale");
  };

  drawTableHeader();
  y += headerH;

  // Salto pagina come il legacy: nuova pagina + mini-header + re-header tabella.
  const ensureSpace = (neededH: number) => {
    if (y + neededH <= pageBottom) return;
    doc.addPage({ size: [W, H], margin: 0 });
    y = M;
    text(M, y + 8 + 12, F2, 12, bizName);
    text(M, y + 22 + 10.5, F1, 10.5, `Preventivo #${data.number}`);
    y += 34;
    drawTableHeader();
    y += headerH;
  };

  // --- Righe ---
  for (const it of data.items) {
    let desc = it.description;
    if (it.sku) desc += `\nSKU: ${it.sku}`;
    if (it.discountPercent > 0) desc += `\nSconto: ${fmtRate(it.discountPercent)}%`;

    const maxChars = Math.max(20, Math.floor(colDesc / (10 * 0.5)) - 1);
    const lines = wrapText(desc, maxChars);
    const rowH = Math.max(rowLH + 6, lines.length * rowLH + 6);

    ensureSpace(rowH);

    rect(x0, y, tableW, rowH);
    line(x1, y, x1, y + rowH);
    line(x2, y, x2, y + rowH);
    line(x3, y, x3, y + rowH);
    line(x4, y, x4, y + rowH);

    let ly = y + 14.2;
    for (const ln of lines) {
      text(x0 + 4, ly, F1, 10, ln);
      ly += rowLH;
      if (ly > y + rowH - 4) break;
    }

    const ty = y + 14.2;
    textRight(x2 - 8, ty, F1, 10, String(it.qty));
    textRight(x3 - 8, ty, F1, 10, `€ ${fmtMoney(it.unitPrice)}`);
    textRight(x4 - 8, ty, F1, 10, `${fmtRate(it.taxRate)}%`);
    textRight(x4 + colTot - 8, ty, F1, 10, `€ ${fmtMoney(it.lineTotal)}`);

    y += rowH;
  }
  if (!data.items.length) {
    const rowH = 22;
    ensureSpace(rowH);
    rect(x0, y, tableW, rowH);
    text(x0 + 8, y + 14.2, F1, 10.5, "Nessuna riga.");
    y += rowH;
  }

  // --- Box totali ---
  y += 14;
  const totBoxW = 240;
  const totX = M + (contentW - totBoxW);
  const lineH = 16;
  ensureSpace(lineH * 5 + 10);
  rect(totX, y, totBoxW, lineH * 4 + 8, "#f5f5f5");
  rect(totX, y, totBoxW, lineH * 4 + 8);
  const totals: Array<[string, string]> = [
    ["Subtotale", `€ ${fmtMoney(data.subtotal)}`],
    ["Sconto", `€ ${fmtMoney(data.discountTotal)}`],
    ["IVA", `€ ${fmtMoney(data.taxTotal)}`],
    ["Totale", `€ ${fmtMoney(data.total)}`],
  ];
  let yy = y + 14;
  totals.forEach(([label, value], index) => {
    const font = index === 3 ? F2 : F1;
    const size = index === 3 ? 12 : 10.5;
    text(totX + 8, yy, font, size, label);
    textRight(totX + totBoxW - 8, yy, font, size, value);
    yy += lineH;
  });
  y += lineH * 4 + 16;

  // --- Paragrafi (Nota / Metodi di pagamento / Condizioni / Footer) ---
  const writeParagraph = (title: string, body: string) => {
    const clean = body.trim();
    if (!clean) return;
    ensureSpace(28);
    text(M, y + 8 + 11.5, F2, 11.5, title);
    y += 20;
    const maxChars = Math.max(30, Math.floor(contentW / (10 * 0.5)) - 2);
    for (const ln of wrapText(clean, maxChars)) {
      ensureSpace(14);
      text(M, y + 10, F1, 10, ln);
      y += 13.5;
    }
    y += 10;
  };
  writeParagraph("Nota", data.publicNote);
  writeParagraph("Metodi di pagamento", data.paymentMethodsText);
  writeParagraph("Condizioni", data.terms);
  writeParagraph("Footer", data.business.footer);

  doc.end();
  return done;
}
