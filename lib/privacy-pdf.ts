import "server-only";

// PDF PRIVACY/CONSENSI — port of app/lib/PrivacyPdf.php privacy_pdf_build:
// A4, margine 46, corpo dal body_text dello snapshot (prima riga = titolo F2 15,
// gli heading GDPR noti in bold, le righe "- " come bullet indentati, il resto
// paragrafi F1 10.5), poi il BOX firma bordato grigio: titolo, righe consenso
// [X]/[ ], "Data: ...", e la firma — immagine (max 210x50pt, con riga sotto e
// caption "Firmato elettronicamente il ...") oppure la riga
// "Firma cliente: ____...". Renderizzato con pdfkit; la firma arriva come
// data URL png/jpeg e viene incorporata direttamente (il legacy convertiva
// PNG->JPEG solo perché il suo MiniPdf embeddava solo DCTDecode).

import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import {
  privacyConsentLabelsForSnapshot,
  privacyPdfSafeFilename,
  type PrivacySnapshot,
} from "@/lib/privacy-consent";

const F1 = "Helvetica";
const F2 = "Helvetica-Bold";
const W = 595.28;
const H = 841.89;
const PAGE_X = 46;
const TOP = 56;
const BOTTOM = 58;

// Heading noti dell'informativa (privacy_pdf_heading_match).
const HEADING_RE =
  /^(Titolare del trattamento|Finalita del trattamento|Base giuridica|Modalita del trattamento|Conferimento dei dati|Destinatari dei dati|Periodo di conservazione|Diritti dell.interessato|Reclamo)$/i;

// privacy_pdf_max_chars.
function maxChars(width: number, fontSize: number): number {
  return Math.max(24, Math.floor(width / Math.max(4.2, fontSize * 0.52)));
}

// MiniPdf::wrapText (stesso port usato dal PDF preventivo).
function wrapText(text: string, chars: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > chars) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, chars));
        word = word.slice(chars);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= chars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

// Verifica di integrità del PNG: pdfkit decodifica i chunk IDAT con zlib in
// modo asincrono e un PNG corrotto produce un uncaughtException (Z_DATA_ERROR)
// che lascia la richiesta appesa — validiamo PRIMA con inflateSync.
function assertValidSignatureImage(bytes: Buffer, mime: string): void {
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Firma non valida");
    return;
  }
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIG)) throw new Error("Firma non valida");
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > bytes.length) throw new Error("Firma non valida");
    if (type === "IDAT") idat.push(bytes.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (!idat.length) throw new Error("Firma non valida");
  try {
    inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error("Firma non valida");
  }
}

// privacy_pdf_decode_signature_payload: data URL png/jpeg, max 3MB il payload,
// max 2MB i byte; stringhe errore legacy.
export function privacyDecodeSignature(dataUrl: string): { bytes: Buffer; mime: string } {
  const raw = String(dataUrl ?? "").trim();
  if (!raw) throw new Error("Firma mancante");
  if (raw.length > 3 * 1024 * 1024) throw new Error("Firma troppo grande");
  const m = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(raw);
  if (!m) throw new Error("Formato firma non valido");
  const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length) throw new Error("Firma non valida");
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Firma troppo pesante");
  const mime = m[1].toLowerCase() === "png" ? "image/png" : "image/jpeg";
  assertValidSignatureImage(bytes, mime);
  return { bytes, mime };
}

export type PrivacyPdfOptions = {
  dateDisplay?: string;
  signatureDataUrl?: string;
  signatureCaption?: string;
  signatureText?: string;
  footerMode?: string;
  footerTitle?: string;
  consentRows?: string[];
};

export function renderPrivacyPdf(snapshot: PrivacySnapshot, options: PrivacyPdfOptions = {}): Promise<Buffer> {
  const contentW = W - PAGE_X * 2;
  const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: privacyPdfSafeFilename(snapshot.filename) } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = TOP;
  const text = (x: number, yBaseline: number, font: string, size: number, value: string) => {
    doc.font(font).fontSize(size).fillColor("black");
    doc.text(value, x, yBaseline - size, { lineBreak: false });
  };
  const ensureSpace = (needed: number) => {
    if (y + needed <= H - BOTTOM) return;
    doc.addPage({ size: [W, H], margin: 0 });
    y = TOP;
  };
  const writeWrapped = (line: string, font: string, size: number, leading: number, spacingAfter: number) => {
    for (const ln of wrapText(line, maxChars(contentW, size))) {
      ensureSpace(leading + 2);
      text(PAGE_X, y + size, font, size, ln);
      y += leading;
    }
    y += spacingAfter;
  };
  const writeBullet = (body: string) => {
    const size = 10.5;
    const leading = 13.5;
    const indent = 12;
    wrapText(body, maxChars(contentW - indent, size)).forEach((ln, i) => {
      ensureSpace(leading + 2);
      text(PAGE_X + (i === 0 ? 0 : indent), y + size, F1, size, (i === 0 ? "- " : "") + ln);
      y += leading;
    });
    y += 2;
  };

  // --- Corpo (body_text) ---
  const bodyLines = String(snapshot.body_text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let firstPrinted = false;
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) {
      y += 7;
      continue;
    }
    if (!firstPrinted) {
      writeWrapped(line, F2, 15, 18, 2);
      firstPrinted = true;
      continue;
    }
    if (HEADING_RE.test(line)) {
      y += 3;
      writeWrapped(line, F2, 11.5, 14, 2);
      continue;
    }
    const bullet = /^-\s*(.+)$/.exec(line);
    if (bullet) {
      writeBullet(bullet[1].trim());
      continue;
    }
    writeWrapped(line, F1, 10.5, 13.5, 1);
  }
  y += 8;

  // --- Box firma ---
  const footerMode = (options.footerMode ?? snapshot.footer_mode ?? "gdpr_consents").trim() || "gdpr_consents";
  let footerTitle = (options.footerTitle ?? snapshot.footer_title ?? "").trim();
  if (!footerTitle) footerTitle = footerMode === "gdpr_consents" ? "Consenso dell'interessato" : "Conferma e firma cliente";

  let consentRows = (options.consentRows ?? snapshot.consent_rows ?? []).map((r) => String(r).trim()).filter(Boolean);
  if (!consentRows.length && footerMode === "gdpr_consents") {
    const labels = privacyConsentLabelsForSnapshot(snapshot);
    const consents = (snapshot.consents ?? {}) as Record<string, boolean>;
    consentRows = Object.entries(labels).map(([key, label]) => `${consents[key] ? "[X] " : "[ ] "}${label}`);
  }

  const dateLabel = `Data: ${(snapshot.document_date_display || options.dateDisplay || "").trim() || options.dateDisplay || ""}`.trim();
  let signatureText = (options.signatureText ?? "").trim() || "Firma cliente: ______________________________";
  const signatureCaption = (options.signatureCaption ?? "").trim();
  const signature = options.signatureDataUrl ? privacyDecodeSignature(options.signatureDataUrl) : null;

  const dateLines = wrapText(dateLabel, maxChars(contentW - 24, 10.5));
  let needed = (footerTitle ? 42 : 24) + 20 + consentRows.length * 16 + dateLines.length * 13.5 + 8;
  const captionLines = signatureCaption ? wrapText(signatureCaption, maxChars(contentW - 24, 9.5)) : [];
  if (signature) needed += 18 + 58 + captionLines.length * 12 + 14;
  else needed += wrapText(signatureText, maxChars(contentW - 24, 10.5)).length * 13.5 + 16;

  ensureSpace(needed + 8);
  const boxTop = y;
  doc.rect(PAGE_X, boxTop, contentW, needed).strokeColor("#d1d1d1").lineWidth(0.8).stroke();

  y = boxTop + 20;
  if (footerTitle) {
    text(PAGE_X + 12, y, F2, 12, footerTitle);
    y += 20;
  }
  for (const row of consentRows) {
    for (const ln of wrapText(row, maxChars(contentW - 24, 10.5))) {
      text(PAGE_X + 12, y, F1, 10.5, ln);
      y += 14;
    }
    y += 2;
  }
  if (consentRows.length) y += 2;
  for (const ln of dateLines) {
    text(PAGE_X + 12, y, F1, 10.5, ln);
    y += 14;
  }

  y += 6;
  if (signature) {
    text(PAGE_X + 12, y, F1, 10.5, "Firma cliente:");
    y += 8;
    const maxW = Math.min(210, contentW - 24);
    const maxH = 50;
    const imgX = PAGE_X + 12;
    const imgY = y;
    // pdfkit scala mantenendo il ratio con fit; la riga sotto la firma è a maxH.
    doc.image(signature.bytes, imgX, imgY, { fit: [maxW, maxH] });
    doc.moveTo(imgX, imgY + maxH + 3).lineTo(PAGE_X + contentW - 12, imgY + maxH + 3).strokeColor("black").lineWidth(0.7).stroke();
    y += maxH + 16;
    for (const ln of captionLines) {
      text(PAGE_X + 12, y, F1, 9.5, ln);
      y += 12;
    }
  } else {
    for (const ln of wrapText(signatureText, maxChars(contentW - 24, 10.5))) {
      text(PAGE_X + 12, y, F1, 10.5, ln);
      y += 14;
    }
  }

  doc.end();
  return done;
}
