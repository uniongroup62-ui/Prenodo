import "server-only";
import { businessTodayIso } from "@/lib/business-datetime";

// PRIVACY / GDPR — port of app/lib/PrivacyConsent.php (le parti usate dal
// flusso firma pubblica): etichette consensi, template con variabili
// ({{nome}}, {{Dati anagrafici}}, {{dati_sede}}, ...), snapshot v2
// (gdpr_snapshot_json), stati draft/pending/signed e filename GDPR_<NOME>.pdf.
//
// Divergenza documentata: il legacy può sovrascrivere il blocco anagrafico
// con il profilo legale della SEDE del cliente (app_location_legal_profile);
// qui si usa il profilo quote_* del businesses row (tenant mono-sede — il
// profilo per-sede arriverà col porting multi-sede).

import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

export type PrivacyConsents = {
  data_processing: boolean;
  communications: boolean;
  marketing: boolean;
  data_sharing: boolean;
};

export type PrivacySnapshot = {
  version: number;
  created_at: string;
  client_id: number;
  client_display_name: string;
  filename: string;
  document_date_display: string;
  template_body: string;
  body_text: string;
  consent_labels: Record<string, string>;
  consents: PrivacyConsents;
  // Campi opzionali usati dai moduli consenso (footer del PDF).
  footer_mode?: string;
  footer_title?: string;
  consent_rows?: string[];
  module_id?: number;
  module_name?: string;
  module_type?: string;
};

const clean = (v: unknown) => String(v ?? "").trim();

export function privacyConsentLabels(): Record<string, string> {
  return {
    data_processing: "Consenso al trattamento dei dati",
    communications: "Consenso comunicazioni",
    marketing: "Consenso marketing",
    data_sharing: "Consenso diffusione dati",
  };
}

// Etichette dallo snapshot (con i fallback legacy per gli snapshot v1).
export function privacyConsentLabelsForSnapshot(snapshot: PrivacySnapshot | Record<string, unknown>): Record<string, string> {
  const raw = (snapshot as PrivacySnapshot).consent_labels;
  if (raw && typeof raw === "object") {
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(raw)) {
      if (clean(key) && clean(label)) labels[clean(key)] = clean(label);
    }
    if (Object.keys(labels).length) return labels;
  }
  const consents = ((snapshot as PrivacySnapshot).consents ?? {}) as Record<string, unknown>;
  if ("marketing" in consents && !("communications" in consents)) {
    return {
      data_processing: "Consenso al trattamento dei dati",
      marketing: "Consenso comunicazioni e promozioni",
      data_sharing: "Consenso diffusione dati",
    };
  }
  return privacyConsentLabels();
}

// Template predefinito (privacy_consent_default_template, testuale identico).
export function privacyDefaultTemplate(): string {
  return [
    "INFORMATIVA PRIVACY AI SENSI DEL GDPR (UE) 2016/679",
    "Cliente: {{nome}} {{cognome}}",
    "Email: {{email}} | Telefono: {{telefono}}",
    "",
    "Titolare del trattamento",
    "{{Dati anagrafici}}",
    "",
    "Finalita del trattamento",
    "- Gestione appuntamenti e servizi",
    "- Adempimenti amministrativi e fiscali",
    "- Invio comunicazioni informative e di servizio (previo consenso ove richiesto)",
    "- Invio comunicazioni promozionali e marketing (previo consenso)",
    "",
    "Base giuridica",
    "- Esecuzione di contratto",
    "- Obblighi legali",
    "- Consenso (comunicazioni e marketing)",
    "",
    "Modalita del trattamento",
    "I dati sono trattati con strumenti elettronici e cartacei, nel rispetto della sicurezza.",
    "",
    "Conferimento dei dati",
    "Obbligatorio per servizi, facoltativo per comunicazioni e marketing.",
    "",
    "Destinatari dei dati",
    "- Consulenti fiscali/legali",
    "- Fornitori software (es. gestionale)",
    "- Autorita competenti",
    "",
    "Periodo di conservazione",
    "10 anni per obblighi fiscali, fino a revoca per comunicazioni e marketing.",
    "",
    "Diritti dell'interessato",
    "Accesso, rettifica, cancellazione, limitazione, opposizione, portabilita.",
    "",
    "Reclamo",
    "E possibile rivolgersi al Garante Privacy.",
  ].join("\n");
}

// Corpo template: PRIMA il modulo di sistema privacy_gdpr (consent_modules),
// poi businesses.gdpr_template_body, poi il default (privacy_consent_template_body).
export async function privacyTemplateBody(slug: string, biz: RowDataPacket): Promise<string> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "consent_modules",
      columns: "body_template",
      where: "system_key = 'privacy_gdpr' AND type = 'privacy_gdpr'",
      limit: 1,
    });
    const moduleTemplate = clean(String(rows[0]?.body_template ?? "").replace(/\r\n?/g, "\n"));
    if (moduleTemplate) return moduleTemplate;
  } catch {
    // tabella assente sui tenant più vecchi
  }
  const tpl = clean(String(biz.gdpr_template_body ?? "").replace(/\r\n?/g, "\n"));
  return tpl || privacyDefaultTemplate();
}

export function privacyStatusNormalize(status: unknown, client: RowDataPacket): "draft" | "pending" | "signed" {
  const s = clean(status).toLowerCase();
  if (s === "draft" || s === "pending" || s === "signed") return s;
  if (Number(client.gdpr_document_id ?? 0) > 0) return "signed";
  if (clean(client.gdpr_public_token) && clean(client.gdpr_signature_requested_at)) return "pending";
  return "draft";
}

export function privacyStatusMeta(status: string): { label: string; badge: string; icon: string } {
  switch (status) {
    case "pending":
      return { label: "In attesa di firma", badge: "warning", icon: "bi-hourglass-split" };
    case "signed":
      return { label: "Firmato", badge: "success", icon: "bi-patch-check" };
    default:
      return { label: "Bozza", badge: "secondary", icon: "bi-file-earmark-text" };
  }
}

export function privacyConsentsFromClient(client: RowDataPacket): PrivacyConsents {
  const marketing = Number(client.gdpr_consent_marketing ?? 0) === 1;
  const communications =
    "gdpr_consent_communications" in client ? Number(client.gdpr_consent_communications ?? 0) === 1 : marketing;
  return {
    data_processing: Number(client.gdpr_consent_data_processing ?? 0) === 1,
    communications,
    marketing,
    data_sharing: Number(client.gdpr_consent_data_sharing ?? 0) === 1,
  };
}

export function privacyClientDisplayName(client: RowDataPacket): string {
  const first = clean(client.first_name);
  const last = clean(client.last_name);
  if (first || last) return `${first} ${last}`.trim();
  return clean(client.full_name) || "Cliente";
}

export function privacyClientNameParts(client: RowDataPacket): [string, string] {
  const first = clean(client.first_name);
  const last = clean(client.last_name);
  if (first || last) return [first, last];
  const parts = privacyClientDisplayName(client).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [parts[0] ?? "Cliente", ""];
  return [parts[0], parts.slice(1).join(" ")];
}

export function privacySlugPiece(value: string): string {
  return slugPiece(value);
}

function slugPiece(value: string): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function privacyClientFilename(client: RowDataPacket): string {
  const [first, last] = privacyClientNameParts(client);
  let parts = [slugPiece(first), slugPiece(last)].filter(Boolean);
  if (!parts.length) parts = [slugPiece(privacyClientDisplayName(client))].filter(Boolean);
  if (!parts.length) parts = ["CLIENTE"];
  return `GDPR_${parts.join("_")}.pdf`;
}

// Blocco {{Dati anagrafici}} (privacy_business_data_block: profilo quote_*).
function businessDataBlock(biz: RowDataPacket): string {
  const lines: string[] = [];
  const company = clean(biz.quote_company_name) || clean(biz.name);
  if (company) lines.push(company);
  const fiscal: string[] = [];
  if (clean(biz.quote_vat_number)) fiscal.push(`P. IVA: ${clean(biz.quote_vat_number)}`);
  if (clean(biz.quote_tax_code)) fiscal.push(`Codice Fiscale: ${clean(biz.quote_tax_code)}`);
  if (clean(biz.quote_sdi)) fiscal.push(`SDI: ${clean(biz.quote_sdi)}`);
  if (clean(biz.quote_pec)) fiscal.push(`PEC: ${clean(biz.quote_pec)}`);
  if (fiscal.length) lines.push(fiscal.join(" | "));
  const addressBits: string[] = [];
  if (clean(biz.quote_address)) addressBits.push(clean(biz.quote_address));
  let cityLine = [clean(biz.quote_cap), clean(biz.quote_city)].filter(Boolean).join(" ");
  const area = [clean(biz.quote_province), clean(biz.quote_region)].filter(Boolean);
  if (area.length) cityLine = `${cityLine}${cityLine ? " (" + area.join(" - ") + ")" : area.join(" - ")}`.trim();
  if (cityLine) addressBits.push(cityLine);
  if (addressBits.length) lines.push(addressBits.join(" - "));
  const contacts: string[] = [];
  if (clean(biz.quote_phone)) contacts.push(`Tel: ${clean(biz.quote_phone)}`);
  if (clean(biz.quote_email) || clean(biz.email)) contacts.push(`Email: ${clean(biz.quote_email) || clean(biz.email)}`);
  if (clean(biz.quote_website)) contacts.push(`Sito web: ${clean(biz.quote_website)}`);
  if (contacts.length) lines.push(contacts.join(" | "));
  return lines.join("\n");
}

// Blocco {{dati_sede}} (privacy_business_site_data_block: dati operativi site_*).
function businessSiteDataBlock(biz: RowDataPacket): string {
  const lines: string[] = [];
  const company = clean(biz.name) || clean(biz.quote_company_name);
  if (company) lines.push(company);
  const addressBits: string[] = [];
  const address = clean(biz.site_address) || clean(biz.address);
  if (address) addressBits.push(address);
  let cityLine = [clean(biz.site_cap), clean(biz.site_city)].filter(Boolean).join(" ");
  const area = [clean(biz.site_province), clean(biz.site_region)].filter(Boolean);
  if (area.length) cityLine = `${cityLine}${cityLine ? " (" + area.join(" - ") + ")" : area.join(" - ")}`.trim();
  if (cityLine) addressBits.push(cityLine);
  if (addressBits.length) lines.push(addressBits.join(" - "));
  const contacts: string[] = [];
  if (clean(biz.phone)) contacts.push(`Tel: ${clean(biz.phone)}`);
  if (clean(biz.email)) contacts.push(`Email: ${clean(biz.email)}`);
  if (clean(biz.website)) contacts.push(`Sito web: ${clean(biz.website)}`);
  if (contacts.length) lines.push(contacts.join(" | "));
  return lines.join("\n");
}

function todayDisplay(): string {
  // Data di ROMA (audit giro 3): finiva nei DOCUMENTI privacy/consensi con il
  // giorno del server (UTC).
  const iso = businessTodayIso();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// Render template: sostituzione case-insensitive di ogni variabile (str_ireplace).
export function privacyRenderTemplateText(templateBody: string, vars: Record<string, string>): string {
  let text = templateBody.replace(/\r\n?/g, "\n");
  for (const [needle, value] of Object.entries(vars)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), value);
  }
  return text.trim();
}

export function privacyTemplateVariables(client: RowDataPacket, biz: RowDataPacket, dateDisplay?: string): Record<string, string> {
  const [first, last] = privacyClientNameParts(client);
  const date = clean(dateDisplay) || todayDisplay();
  const quoteBlock = businessDataBlock(biz);
  return {
    "{{nome}}": first,
    "{{cognome}}": last,
    "{{cliente}}": privacyClientDisplayName(client),
    "{{email}}": clean(client.email),
    "{{telefono}}": clean(client.phone),
    "{{data}}": date,
    "{{dati_sede}}": businessSiteDataBlock(biz),
    // Una sola chiave: il render è case-insensitive, copre {{Dati anagrafici}}
    // / {{dati_anagrafici}} solo per la variante con spazio vs underscore.
    "{{dati anagrafici}}": quoteBlock,
    "{{dati_anagrafici}}": quoteBlock,
  };
}

export async function privacySnapshotCreate(
  slug: string,
  client: RowDataPacket,
  biz: RowDataPacket,
  dateDisplay?: string,
): Promise<PrivacySnapshot> {
  const templateBody = await privacyTemplateBody(slug, biz);
  const date = clean(dateDisplay) || todayDisplay();
  const vars = privacyTemplateVariables(client, biz, date);
  return {
    version: 2,
    created_at: new Date().toISOString(),
    client_id: Number(client.id ?? 0),
    client_display_name: privacyClientDisplayName(client),
    filename: privacyClientFilename(client),
    document_date_display: date,
    template_body: templateBody,
    body_text: privacyRenderTemplateText(templateBody, vars),
    consent_labels: privacyConsentLabels(),
    consents: privacyConsentsFromClient(client),
  };
}

export function privacySnapshotDecode(json: unknown): PrivacySnapshot | null {
  const raw = clean(json);
  if (!raw) return null;
  try {
    const decoded = JSON.parse(raw);
    return decoded && typeof decoded === "object" ? (decoded as PrivacySnapshot) : null;
  } catch {
    return null;
  }
}

export function privacyPdfSafeFilename(filename: string): string {
  let out = clean(filename).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  if (!out) out = "GDPR_DOCUMENTO";
  if (!/\.pdf$/i.test(out)) out += ".pdf";
  return out;
}
