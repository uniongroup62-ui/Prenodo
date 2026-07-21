import "server-only";

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

// Email sending for the Next app. The legacy PHP sent mail via the server MTA
// (mail() + a multipart text/HTML "modern template"). On AWS we send through
// Amazon SES (SESv2). Credentials come from the default AWS chain — on Amplify
// that is the app's IAM role; locally, AWS_ACCESS_KEY_ID/SECRET env vars.
//
// Config (env): SES_FROM_EMAIL (a SES-verified identity, REQUIRED to send),
// SES_FROM_NAME (display name, default "Prenodo"), SES_REGION / AWS_REGION.
//
// buildModernEmailTemplate() and htmlToText() are faithful ports of
// email_build_modern_template() / email_html_to_text() in app/lib/Helpers.php
// so the emails render identically to the PHP app.

// --- HTML helpers (ports of the legacy PHP helpers) -------------------------

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(s: string): string {
  return s.replace(/(\r\n|\n\r|\n|\r)/g, "<br>$1");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Port of email_html_to_text().
export function htmlToText(html: string): string {
  let s = html.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/p\s*>/gi, "\n\n");
  s = s.replace(/<\s*\/div\s*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export type EmailTemplateOpts = {
  business_name?: string;
  business_email?: string;
  business_logo_url?: string;
  // Forza il ramo TESTO SEMPLICE anche se il contenuto somiglia a HTML.
  // Serve ai builder plain-text (reminder/fidelity/lifecycle-rejected) che dal
  // 21/07 NON pre-escapano più le variabili (divergenza DELIBERATA dal legacy,
  // che double-escapava e mandava "L&#039;Estetica" al cliente): senza questo
  // flag un nome tenant contenente "<qualcosa>" farebbe scattare looksHtml e
  // il body passerebbe SENZA escaping (iniezione HTML nell'email).
  force_plain_body?: boolean;
};

// --- Primitive condivise per i CORPI email (coerenza cross-modulo) ----------
// Unificazione 2026-07-18 (divergenza deliberata dal legacy, che aveva 6 stili
// di CTA diversi ereditati dai vari moduli PHP): un solo accent — il teal già
// usato dal template per i link del footer — e un solo stile di bottone e di
// riquadro-codice per tutte le email dell'app.

export const EMAIL_ACCENT = "#365a96";

// Maschera un'email per i LOG (audit GDPR 2026-07-21): gli error-log finiscono
// su CloudWatch — l'indirizzo completo è un dato personale che lì non serve.
// "luca.rossi@example.com" -> "l***@example.com".
export function maskEmail(value: unknown): string {
  const email = String(value ?? "").trim();
  const at = email.indexOf("@");
  if (at <= 0) return email ? "***" : "";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

export function emailButton(href: string, label: string): string {
  return `<a href="${h(href)}" style="display:inline-block;background:${EMAIL_ACCENT};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;letter-spacing:.2px">${h(label)}</a>`;
}

export function emailCodeBox(code: string): string {
  return `<div style="display:inline-block;background:#f2f6fd;border:2px dashed ${EMAIL_ACCENT};border-radius:12px;padding:14px 26px;font-size:26px;font-weight:800;letter-spacing:4px;color:#0f172a">${h(code)}</div>`;
}

// NB oggetti: NIENTE brand nell'oggetto (scelta 2026-07-18). Il brand arriva
// già da 3 canali — fromName nell'inbox, header con logo e footer del template
// (e l'oggetto è anche il TITOLO H1 dentro la card: un prefisso lo
// triplicherebbe). Gli oggetti restano asciutti: "Conferma email",
// "Preventivo 3/2026", "Buon Compleanno!".

// Port of email_build_modern_template() — returns the branded { html, text }.
export function buildModernEmailTemplate(
  subject: string,
  content: string,
  opts: EmailTemplateOpts = {},
): { html: string; text: string } {
  const bizName = String(opts.business_name ?? "");
  const bizEmail = String(opts.business_email ?? "");
  const logoUrl = String(opts.business_logo_url ?? "").trim();

  const looksHtml = opts.force_plain_body === true ? false : /<\s*\w+[^>]*>/.test(content);

  let textAlt = looksHtml ? htmlToText(content).trim() : content.trim();
  if (textAlt === "") textAlt = htmlToText(nl2br(h(content))).trim();

  let inner: string;
  if (!looksHtml) {
    inner = "";
    for (const raw of content.trim().split(/\r?\n\r?\n/)) {
      const p = raw.trim();
      if (p === "") continue;
      inner += `<p style="margin:0 0 12px 0">${nl2br(h(p))}</p>`;
    }
  } else {
    inner = nl2br(content);
  }

  const preheader = h([...textAlt].slice(0, 120).join(""));
  const title = h(subject);
  const brand = h(bizName || "La mia attività");

  let footer = "";
  if (bizName !== "" || bizEmail !== "") {
    footer += '<div style="font-size:12px;line-height:1.4;color:#6b7280">';
    footer += `<div style="font-weight:600;color:#374151">${brand}</div>`;
    if (bizEmail !== "") {
      const em = h(bizEmail);
      footer += `<div>Contatto: <a href="mailto:${em}" style="color:#365a96;text-decoration:none">${em}</a></div>`;
    }
    footer += "</div>";
  }

  let html = "<!doctype html>\n";
  html +=
    '<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>';
  html +=
    '<body style="margin:0;padding:0;background:#f6f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">';
  html += `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>`;
  html +=
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 12px">';
  html += '<tr><td align="center">';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">';
  html += '<tr><td style="padding:0 0 12px 0">';
  if (logoUrl !== "") {
    const lu = h(logoUrl);
    // Tabella al posto di display:flex: Outlook desktop non supporta flex e
    // impilava logo e nome in verticale.
    html += '<table role="presentation" cellpadding="0" cellspacing="0"><tr>';
    html += `<td style="padding-right:10px"><img src="${lu}" alt="${brand}" style="max-height:40px;max-width:180px;border-radius:10px;display:block"></td>`;
    html += `<td style="font-weight:800;font-size:16px;color:#0f172a;vertical-align:middle">${brand}</td>`;
    html += "</tr></table>";
  } else {
    html += `<div style="font-weight:800;font-size:16px;color:#0f172a">${brand}</div>`;
  }
  html += "</td></tr>";
  html +=
    '<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;box-shadow:0 10px 28px rgba(17,24,39,.08);padding:22px">';
  html += `<h1 style="margin:0 0 10px 0;font-size:22px;line-height:1.2;color:#0f172a">${title}</h1>`;
  html += `<div style="font-size:14px;line-height:1.6;color:#111827">${inner}</div>`;
  html += "</td></tr>";
  html += `<tr><td style="padding:14px 6px 0 6px">${footer}</td></tr>`;
  html += "</table></td></tr></table></body></html>";

  if (bizName !== "" && !textAlt.toLowerCase().includes(bizName.toLowerCase())) {
    textAlt = textAlt.replace(/\s+$/, "") + "\n\n" + bizName;
  }

  return { html, text: textAlt };
}

// --- SES sender ------------------------------------------------------------

let sesClient: SESv2Client | null = null;
function client(): SESv2Client {
  if (!sesClient) {
    sesClient = new SESv2Client({ region: process.env.SES_REGION || process.env.AWS_REGION || "eu-west-1" });
  }
  return sesClient;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.SES_FROM_EMAIL);
}

// RFC 2047 encode a display name containing non-ASCII chars (like mb_encode_mimeheader).
function encodeMimeWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) {
    // RFC 5322: una display-phrase ASCII con caratteri speciali (<>()[]:;@,."\)
    // va QUOTATA, altrimenti `Nome <3 <from@x>` è un From malformato e SES
    // rifiuta TUTTE le email del tenant.
    if (/[()<>[\]:;@\\,."]/.test(value)) {
      return `"${value.replace(/(["\\])/g, "\\$1")}"`;
    }
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
};

export async function sendEmail(
  input: SendEmailInput,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!emailConfigured()) return { ok: false, error: "email_not_configured" };
  const fromEmail = (input.fromEmail || process.env.SES_FROM_EMAIL || "").trim();
  const fromName = (input.fromName ?? process.env.SES_FROM_NAME ?? "Prenodo").trim();
  const to = (Array.isArray(input.to) ? input.to : [input.to]).map((s) => s.trim()).filter(Boolean);
  if (!fromEmail || to.length === 0) return { ok: false, error: "missing_from_or_to" };

  const text = input.text ?? htmlToText(input.html);
  const from = fromName ? `${encodeMimeWord(fromName)} <${fromEmail}>` : fromEmail;

  try {
    const res = await client().send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: to },
        ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: input.html, Charset: "UTF-8" },
              Text: { Data: text, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
    return { ok: true, messageId: res.MessageId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "ses_error" };
  }
}
