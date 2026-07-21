import "server-only";
import { businessTodayIso } from "@/lib/business-datetime";

// MODULI CONSENSO (lato record cliente) — port of app/lib/ConsentModules.php:
// record client_consent_records (stati draft/pending/signed come il GDPR),
// snapshot del modulo (consent_module_snapshot_create), filename
// CONSENSO_<SLUG>_<NOME>_<COGNOME>.pdf e le email di richiesta firma / PDF
// ufficiale (consent_module_send_signature_email / _official_pdf_email).
// Qui vivono anche le email GDPR (privacy_send_signature_email /
// privacy_send_official_pdf_email): stesso mittente (privacy_mail_sender:
// quote_email/quote_company_name del businesses row) e stesso bottone #8a1d52.
// Con SES il From resta il dominio verificato: l'email del business va in
// Reply-To (il legacy la usava come From diretto — non possibile via SES).

import { buildModernEmailTemplate, emailButton, emailConfigured, sendEmail } from "@/lib/email";
import {
  privacyClientDisplayName,
  privacyClientFilename,
  privacyClientNameParts,
  privacyConsentLabels,
  privacyConsentsFromClient,
  privacyRenderTemplateText,
  privacySlugPiece,
  privacyTemplateVariables,
  type PrivacySnapshot,
} from "@/lib/privacy-consent";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

const clean = (v: unknown) => String(v ?? "").trim();

// ---------------------------------------------------------------------------
// Tipi modulo (consent_module_types) — riusa la stessa meta della lib editor.
// ---------------------------------------------------------------------------

const TYPE_META = {
  privacy_gdpr: { label: "PDF privacy GDPR", footerMode: "gdpr_consents", footerTitle: "Consenso dell'interessato" },
  informed_consent: { label: "Consenso informato", footerMode: "signature_only", footerTitle: "Conferma e firma cliente" },
} as const;

export function consentModuleTypeLabel(type: string): string {
  return type === "privacy_gdpr" ? TYPE_META.privacy_gdpr.label : TYPE_META.informed_consent.label;
}

export type ConsentModuleInfo = {
  id: number;
  name: string;
  slug: string;
  type: string;
  footerMode: string;
  footerTitle: string;
  isActive: boolean;
  bodyTemplate: string;
};

function moduleFromRow(row: RowDataPacket): ConsentModuleInfo {
  const type = clean(row.type) === "privacy_gdpr" || clean(row.system_key) === "privacy_gdpr" ? "privacy_gdpr" : "informed_consent";
  const meta = type === "privacy_gdpr" ? TYPE_META.privacy_gdpr : TYPE_META.informed_consent;
  return {
    id: Number(row.id ?? 0) || 0,
    name: clean(row.name) || (type === "privacy_gdpr" ? "PDF privacy GDPR" : "Modulo consenso"),
    slug: clean(row.slug),
    type,
    footerMode: clean(row.footer_mode) || meta.footerMode,
    footerTitle: clean(row.footer_title) || meta.footerTitle,
    isActive: Number(row.is_active ?? 1) === 1,
    bodyTemplate: String(row.body_template ?? "").replace(/\r\n?/g, "\n"),
  };
}

// ---------------------------------------------------------------------------
// Record (client_consent_records)
// ---------------------------------------------------------------------------

export type ConsentRecordRow = RowDataPacket & { module: ConsentModuleInfo; status: "draft" | "pending" | "signed" };

// consent_module_record_status_normalize.
export function consentRecordStatusNormalize(status: unknown, row: RowDataPacket): "draft" | "pending" | "signed" {
  const s = clean(status).toLowerCase();
  if (s === "draft" || s === "pending" || s === "signed") return s;
  if (Number(row.document_id ?? 0) > 0) return "signed";
  if (clean(row.public_token) && clean(row.signature_requested_at)) return "pending";
  return "draft";
}

// consent_module_record_status_meta (identica alla meta GDPR).
export function consentRecordStatusMeta(status: string): { label: string; badge: string; icon: string } {
  switch (status) {
    case "pending":
      return { label: "In attesa di firma", badge: "warning", icon: "bi-hourglass-split" };
    case "signed":
      return { label: "Firmato", badge: "success", icon: "bi-patch-check" };
    default:
      return { label: "Bozza", badge: "secondary", icon: "bi-file-earmark-text" };
  }
}

async function attachModules(slug: string, rows: RowDataPacket[]): Promise<ConsentRecordRow[]> {
  if (!rows.length) return [];
  const moduleIds = [...new Set(rows.map((r) => Number(r.module_id ?? 0)).filter((id) => id > 0))];
  const moduleRows = moduleIds.length
    ? await tenantSelect<RowDataPacket>({
        slug,
        table: "consent_modules",
        where: `id IN (${moduleIds.map(() => "?").join(",")})`,
        params: moduleIds,
      }).catch(() => [] as RowDataPacket[])
    : [];
  const byId = new Map(moduleRows.map((m) => [Number(m.id ?? 0), moduleFromRow(m)]));
  return rows
    .filter((r) => byId.has(Number(r.module_id ?? 0)))
    .map((r) => {
      const record = r as ConsentRecordRow;
      record.module = byId.get(Number(r.module_id ?? 0))!;
      record.status = consentRecordStatusNormalize(r.status, r);
      return record;
    });
}

// consent_module_record_find (record + modulo, scoped per cliente).
export async function consentRecordFind(slug: string, recordId: number, clientId = 0): Promise<ConsentRecordRow | null> {
  if (recordId <= 0) return null;
  const where = clientId > 0 ? "id = ? AND client_id = ?" : "id = ?";
  const params = clientId > 0 ? [recordId, clientId] : [recordId];
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_consent_records", where, params, limit: 1 }).catch(() => []);
  if (!rows[0]) return null;
  const [record] = await attachModules(slug, rows);
  return record ?? null;
}

// consent_module_record_find via public_token (per la pagina pubblica). Gli
// errori DB si propagano (un guasto transitorio NON deve leggersi come "link
// non valido").
export async function consentRecordByToken(slug: string, token: string): Promise<ConsentRecordRow | null> {
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_consent_records", where: "public_token = ?", params: [token], limit: 1 });
  if (!rows[0]) return null;
  const [record] = await attachModules(slug, rows);
  return record ?? null;
}

// consent_module_records_for_client (esclude il modulo di sistema GDPR).
export async function consentRecordsForClient(slug: string, clientId: number): Promise<ConsentRecordRow[]> {
  if (clientId <= 0) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_consent_records",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const records = await attachModules(slug, rows);
  return records
    .filter((r) => r.module.type !== "privacy_gdpr")
    .sort((a, b) => a.module.name.localeCompare(b.module.name) || Number(a.id) - Number(b.id));
}

// consent_module_available_for_client: moduli attivi non-GDPR non ancora associati.
export async function consentModulesAvailableForClient(slug: string, clientId: number): Promise<ConsentModuleInfo[]> {
  const moduleRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "consent_modules",
    where: "is_active = 1",
    orderBy: "name ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const associated = new Set(
    (await tenantSelect<RowDataPacket>({ slug, table: "client_consent_records", columns: "module_id", where: "client_id = ?", params: [clientId] }).catch(() => [] as RowDataPacket[]))
      .map((r) => Number(r.module_id ?? 0)),
  );
  return moduleRows
    .map(moduleFromRow)
    .filter((m) => m.type !== "privacy_gdpr" && !associated.has(m.id));
}

// consent_module_record_create (idempotente, con gli errori legacy).
export async function consentRecordCreate(slug: string, clientId: number, moduleId: number): Promise<ConsentRecordRow> {
  if (moduleId <= 0) throw new Error("Modulo consenso non trovato.");
  const moduleRows = await tenantSelect<RowDataPacket>({ slug, table: "consent_modules", where: "id = ?", params: [moduleId], limit: 1 }).catch(() => []);
  if (!moduleRows[0]) throw new Error("Modulo consenso non trovato.");
  const consentModule = moduleFromRow(moduleRows[0]);
  if (consentModule.type === "privacy_gdpr") {
    throw new Error("Il modulo PDF privacy GDPR e gia disponibile nella scheda del cliente.");
  }
  if (!consentModule.isActive) throw new Error("Il modulo selezionato non e attivo.");

  const existing = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_consent_records",
    where: "client_id = ? AND module_id = ?",
    params: [clientId, moduleId],
    limit: 1,
  }).catch(() => []);
  if (existing[0]) {
    const [record] = await attachModules(slug, existing);
    return record;
  }

  const table = await tenantTable(slug, "client_consent_records");
  const now = new Date();
  const recordId = await tenantInsert(table, { client_id: clientId, module_id: moduleId, status: "draft", created_at: now, updated_at: now });
  const created = await consentRecordFind(slug, recordId, clientId);
  if (!created) throw new Error("Modulo consenso associato non trovato.");
  return created;
}

// consent_module_record_update_pending / _signed / _reset.
export async function consentRecordUpdatePending(slug: string, recordId: number, snapshotJson: string, token: string, requestedAt: string): Promise<void> {
  await tenantUpdate({
    slug,
    table: "client_consent_records",
    id: recordId,
    values: { status: "pending", snapshot_json: snapshotJson, public_token: token, signature_requested_at: requestedAt, locked_at: requestedAt, updated_at: new Date() },
  });
}

export async function consentRecordUpdateSigned(slug: string, recordId: number, docId: number, snapshotJson: string, token: string, signedAt: string): Promise<void> {
  await tenantUpdate({
    slug,
    table: "client_consent_records",
    id: recordId,
    values: { document_id: docId, status: "signed", snapshot_json: snapshotJson, public_token: token, signed_at: signedAt, locked_at: signedAt, updated_at: new Date() },
  });
}

export async function consentRecordReset(slug: string, recordId: number): Promise<void> {
  await tenantUpdate({
    slug,
    table: "client_consent_records",
    id: recordId,
    values: { status: "draft", document_id: null, snapshot_json: null, public_token: null, signature_requested_at: null, signed_at: null, locked_at: null, updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Snapshot e filename (consent_module_snapshot_create / _build_filename)
// ---------------------------------------------------------------------------

export function consentModuleBuildFilename(consentModule: ConsentModuleInfo, client: RowDataPacket): string {
  if (consentModule.type === "privacy_gdpr") return privacyClientFilename(client);
  const [first, last] = privacyClientNameParts(client);
  const parts = ["CONSENSO", privacySlugPiece(consentModule.slug || consentModule.name || "MODULO"), privacySlugPiece(first), privacySlugPiece(last)].filter(
    (v) => clean(v) !== "",
  );
  return `${(parts.length ? parts : ["CONSENSO", "DOCUMENTO"]).join("_")}.pdf`;
}

function todayDisplay(): string {
  // Data di ROMA (audit giro 3): finiva nei DOCUMENTI privacy/consensi con il
  // giorno del server (UTC).
  const iso = businessTodayIso();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export function consentModuleSnapshotCreate(
  consentModule: ConsentModuleInfo,
  client: RowDataPacket,
  biz: RowDataPacket,
  dateDisplay?: string,
): PrivacySnapshot {
  const templateBody = clean(consentModule.bodyTemplate) !== "" ? consentModule.bodyTemplate.trim() : "";
  const date = clean(dateDisplay) || todayDisplay();
  const vars = privacyTemplateVariables(client, biz, date);
  const gdprFooter = consentModule.footerMode === "gdpr_consents";
  return {
    version: gdprFooter ? 2 : 1,
    created_at: new Date().toISOString(),
    module_id: consentModule.id,
    module_name: consentModule.name,
    module_type: consentModule.type,
    footer_mode: consentModule.footerMode,
    footer_title: consentModule.footerTitle,
    client_id: Number(client.id ?? 0),
    client_display_name: privacyClientDisplayName(client),
    filename: consentModuleBuildFilename(consentModule, client),
    document_date_display: date,
    template_body: templateBody,
    body_text: privacyRenderTemplateText(templateBody, vars),
    consent_labels: gdprFooter ? privacyConsentLabels() : {},
    consents: gdprFooter ? privacyConsentsFromClient(client) : ({} as never),
  };
}

// ---------------------------------------------------------------------------
// Email (privacy_send_* + consent_module_send_*) — bottone brand #8a1d52,
// wrapping nel template moderno come mail_send_html del legacy.
// ---------------------------------------------------------------------------

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function privacyBusinessDisplayName(biz: RowDataPacket): string {
  return clean(biz.quote_company_name) || clean(biz.name) || "La struttura";
}

// privacy_email_required_message / privacy_require_email_error.
export const PRIVACY_EMAIL_REQUIRED_MESSAGE =
  "Per inviare il documento privacy e necessario inserire un indirizzo email nelle Informazioni principali del cliente.";

async function safeSendHtmlMail(to: string, subject: string, bodyHtml: string, biz: RowDataPacket): Promise<boolean> {
  if (!emailConfigured()) return false;
  const fromName = clean(biz.quote_company_name) || clean(biz.name) || undefined;
  let replyTo = clean(biz.quote_email) || clean(biz.email) || undefined;
  if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) replyTo = undefined;
  try {
    const { html, text } = buildModernEmailTemplate(subject, bodyHtml, {
      business_name: fromName ?? "",
      business_email: replyTo ?? "",
    });
    const res = await sendEmail({ to, subject, html, text, fromName, replyTo });
    return res.ok;
  } catch {
    return false;
  }
}

function buttonHtml(url: string, label: string): string {
  return `<p style="margin:20px 0">${emailButton(url, label)}</p>`;
}

function linkFallbackHtml(url: string): string {
  return `<p>Se il pulsante non funziona, copia e incolla questo link nel browser:</p><p style="word-break:break-all">${escapeHtml(url)}</p>`;
}

// privacy_send_signature_email.
export async function privacySendSignatureEmail(client: RowDataPacket, biz: RowDataPacket, url: string): Promise<boolean> {
  const to = clean(client.email);
  if (!to) return false;
  const name = privacyClientDisplayName(client);
  const businessName = privacyBusinessDisplayName(biz);
  const body =
    `<p>Ciao ${escapeHtml(name)},</p>` +
    `<p>${escapeHtml(businessName)} ti ha inviato il modulo privacy da visionare e confermare digitalmente.</p>` +
    buttonHtml(url, "Apri e conferma il modulo privacy") +
    linkFallbackHtml(url);
  return safeSendHtmlMail(to, "Firma il modulo privacy", body, biz);
}

// privacy_send_official_pdf_email.
export async function privacySendOfficialPdfEmail(client: RowDataPacket, biz: RowDataPacket, url: string): Promise<boolean> {
  const to = clean(client.email);
  if (!to) return false;
  const name = privacyClientDisplayName(client);
  const businessName = privacyBusinessDisplayName(biz);
  const body =
    `<p>Ciao ${escapeHtml(name)},</p>` +
    "<p>Puoi visualizzare o scaricare il tuo documento privacy firmato dal link qui sotto.</p>" +
    buttonHtml(url, "Apri il PDF privacy firmato") +
    linkFallbackHtml(url);
  return safeSendHtmlMail(to, "Il tuo documento privacy firmato", body, biz);
}

// consent_module_send_signature_email.
export async function consentSendSignatureEmail(client: RowDataPacket, biz: RowDataPacket, consentModule: ConsentModuleInfo, url: string): Promise<boolean> {
  const to = clean(client.email);
  if (!to) return false;
  const name = privacyClientDisplayName(client);
  const businessName = privacyBusinessDisplayName(biz);
  const moduleName = clean(consentModule.name) || "Modulo consenso";
  const body =
    `<p>Ciao ${escapeHtml(name)},</p>` +
    `<p>${escapeHtml(businessName)} ti ha inviato il modulo <strong>${escapeHtml(moduleName)}</strong> da visionare e firmare digitalmente.</p>` +
    buttonHtml(url, "Apri e conferma il modulo") +
    linkFallbackHtml(url);
  return safeSendHtmlMail(to, `Firma il modulo: ${moduleName}`, body, biz);
}

// consent_module_send_official_pdf_email.
export async function consentSendOfficialPdfEmail(client: RowDataPacket, biz: RowDataPacket, consentModule: ConsentModuleInfo, url: string): Promise<boolean> {
  const to = clean(client.email);
  if (!to) return false;
  const name = privacyClientDisplayName(client);
  const businessName = privacyBusinessDisplayName(biz);
  const moduleName = clean(consentModule.name) || "Modulo consenso";
  const body =
    `<p>Ciao ${escapeHtml(name)},</p>` +
    `<p>Puoi visualizzare o scaricare il modulo firmato <strong>${escapeHtml(moduleName)}</strong> dal link qui sotto.</p>` +
    buttonHtml(url, "Apri il PDF firmato") +
    linkFallbackHtml(url);
  return safeSendHtmlMail(to, `Il tuo modulo firmato: ${moduleName}`, body, biz);
}
