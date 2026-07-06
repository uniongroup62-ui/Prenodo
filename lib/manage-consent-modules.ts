import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { parseInteger } from "@/lib/api-utils";
import { columnExists, dbQuery, quoteIdentifier, tenantDelete, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import {
  privacyConsentLabels,
  privacyDefaultTemplate,
  privacyPdfSafeFilename,
  privacyRenderTemplateText,
  privacyTemplateBody,
  privacyTemplateVariables,
} from "@/lib/privacy-consent";
import { renderPrivacyPdf } from "@/lib/privacy-pdf";
import { consentModuleSnapshotCreate } from "@/lib/consent-records";

// DB-backed port of the consent-module editor save/get/delete from
// app/pages/consent_modules.php + app/lib/ConsentModules.php. The list itself is
// served read-only by /api/manage/configuration?module=consent_modules; this
// adds the editable single-reader (action=get) + save (_mode=save_module) +
// delete used by the faithful consent_module_form-content.tsx editor.
//
// Faithful to ConsentModules.php: only two types exist — the unique system
// 'privacy_gdpr' (editable, not deletable, always active) and additional
// 'informed_consent' modules. Save validates name/body_template, derives a
// unique slug, and stamps footer_mode/footer_title from the type meta.

type ConsentType = "privacy_gdpr" | "informed_consent";

type TypeMeta = { label: string; footerMode: string; footerTitle: string; systemOnly: boolean; defaultName: string };

const TYPE_META: Record<ConsentType, TypeMeta> = {
  privacy_gdpr: {
    label: "PDF privacy GDPR",
    footerMode: "gdpr_consents",
    footerTitle: "Consenso dell'interessato",
    systemOnly: true,
    defaultName: "PDF privacy GDPR",
  },
  informed_consent: {
    label: "Consenso informato",
    footerMode: "signature_only",
    footerTitle: "Conferma e firma cliente",
    systemOnly: false,
    defaultName: "Nuovo modulo consenso",
  },
};

const SYSTEM_SLUG = "pdf-privacy-gdpr";

export type ConsentModuleRow = {
  id: number;
  name: string;
  slug: string;
  type: ConsentType;
  bodyTemplate: string;
  footerMode: string;
  footerTitle: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  associationCount: number;
};

function typeMeta(type: string): TypeMeta {
  return type === "privacy_gdpr" ? TYPE_META.privacy_gdpr : TYPE_META.informed_consent;
}

// Faithful default informed-consent template (consent_module_default_template).
const DEFAULT_INFORMED_TEMPLATE = [
  "MODULO DI CONSENSO INFORMATO",
  "Cliente: {{cliente}}",
  "Email: {{email}} | Telefono: {{telefono}}",
  "",
  "Struttura / Titolare",
  "{{dati_sede}}",
  "",
  "Trattamento",
  "[Inserisci il nome del trattamento o della procedura]",
  "",
  "Descrizione",
  "[Descrivi in modo chiaro il trattamento, la durata, le modalita operative e gli obiettivi.]",
  "",
  "Indicazioni e benefici attesi",
  "- [Inserisci indicazioni e benefici]",
  "",
  "Controindicazioni, limiti ed effetti indesiderati possibili",
  "- [Inserisci controindicazioni o possibili effetti]",
  "",
  "Dichiarazione del cliente",
  "Dichiaro di aver letto e compreso le informazioni sopra riportate, di aver potuto fare domande e di prestare il mio consenso al trattamento descritto.",
].join("\n");

export function consentModuleDefaultTemplate(type: string = "informed_consent"): string {
  // privacy_gdpr default body lives in the businesses.gdpr_template_body / a
  // PrivacyConsent default we cannot reproduce here; for the editor's "new"
  // path only informed_consent is creatable, so this default is sufficient.
  return type === "privacy_gdpr" ? "" : DEFAULT_INFORMED_TEMPLATE;
}

function slugify(value: string): string {
  let v = value.trim();
  if (v === "") return "modulo-consenso";
  // Strip combining diacritics (U+0300–U+036F) after NFKD, mirroring the legacy
  // iconv ASCII//TRANSLIT step, then collapse non-alphanumerics into hyphens.
  v = v.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  v = v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return v !== "" ? v : "modulo-consenso";
}

async function slugExists(slug: string, candidate: string, excludeId: number): Promise<boolean> {
  const clauses = ["slug=?"];
  const params: unknown[] = [candidate];
  if (excludeId > 0) {
    clauses.push("id<>?");
    params.push(excludeId);
  }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "consent_modules", where: clauses.join(" AND "), params, limit: 1 }).catch(() => []);
  return rows.length > 0;
}

async function uniqueSlug(slug: string, name: string, excludeId: number): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let i = 2;
  while (await slugExists(slug, candidate, excludeId)) {
    candidate = `${base}-${i}`;
    i += 1;
    if (i > 9999) {
      candidate = `${base}-${Math.random().toString(16).slice(2, 6)}`;
      break;
    }
  }
  return candidate;
}

function mapModule(row: RowDataPacket, associationCount = 0): ConsentModuleRow {
  const type: ConsentType = String(row.type ?? "") === "privacy_gdpr" || String(row.system_key ?? "") === "privacy_gdpr"
    ? "privacy_gdpr"
    : "informed_consent";
  const meta = typeMeta(type);
  const isSystem = Number(row.is_system ?? 0) === 1 || type === "privacy_gdpr";
  return {
    id: Number(row.id ?? 0) || 0,
    name: String(row.name ?? "").trim() || meta.defaultName,
    slug: String(row.slug ?? ""),
    type,
    bodyTemplate: String(row.body_template ?? ""),
    footerMode: String(row.footer_mode ?? "").trim() || meta.footerMode,
    footerTitle: String(row.footer_title ?? "").trim() || meta.footerTitle,
    isSystem,
    isActive: isSystem ? true : Number(row.is_active ?? 1) === 1,
    sortOrder: Number(row.sort_order ?? 0) || 0,
    associationCount,
  };
}

async function countAssociations(slug: string, moduleId: number): Promise<number> {
  if (moduleId <= 0) return 0;
  const table = await tenantTable(slug, "client_consent_records").catch(() => null);
  if (!table) return 0;
  const clauses = ["module_id=?"];
  const params: unknown[] = [moduleId];
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.unshift("tenant_id=?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`,
    params,
  ).catch(() => []);
  return Number(rows[0]?.c ?? 0) || 0;
}

export async function getManageConsentModule(slug: string, moduleId: number): Promise<ConsentModuleRow | null> {
  if (moduleId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "consent_modules", where: "id=?", params: [moduleId], limit: 1 }).catch(() => []);
  if (!rows[0]) return null;
  return mapModule(rows[0], await countAssociations(slug, moduleId));
}

// consent_module_ensure_system_gdpr: il modulo di sistema 'PDF privacy GDPR'
// esiste sempre (creato al primo accesso con il template del tenant) e i suoi
// campi chiave vengono riparati se vuoti/divergenti.
export async function ensureSystemGdprModule(slug: string): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "consent_modules", where: "system_key='privacy_gdpr'", limit: 1 }).catch(() => []);
  const row = rows[0];
  if (!row) {
    const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "*", orderBy: "id ASC", limit: 1 }).catch(() => []);
    const legacyTemplate = bizRows[0] ? await privacyTemplateBody(slug, bizRows[0]).catch(() => privacyDefaultTemplate()) : privacyDefaultTemplate();
    const table = await tenantTable(slug, "consent_modules");
    await tenantInsert(table, {
      system_key: "privacy_gdpr",
      slug: SYSTEM_SLUG,
      name: "PDF privacy GDPR",
      type: "privacy_gdpr",
      body_template: legacyTemplate,
      footer_mode: "gdpr_consents",
      footer_title: "Consenso dell'interessato",
      is_system: 1,
      is_active: 1,
      sort_order: 0,
    });
    return;
  }
  const values: Record<string, unknown> = {};
  if (String(row.slug ?? "").trim() === "") values.slug = SYSTEM_SLUG;
  if (String(row.name ?? "").trim() === "") values.name = "PDF privacy GDPR";
  if (String(row.type ?? "").trim() !== "privacy_gdpr") values.type = "privacy_gdpr";
  if (Number(row.is_system ?? 0) !== 1) values.is_system = 1;
  if (String(row.footer_mode ?? "").trim() === "") values.footer_mode = "gdpr_consents";
  if (String(row.footer_title ?? "").trim() === "") values.footer_title = "Consenso dell'interessato";
  if (Object.keys(values).length) {
    await tenantUpdate({ slug, table: "consent_modules", id: Number(row.id), values }).catch(() => undefined);
  }
}

// Conteggi 'Associato a N cliente/i' per la lista (consent_module_count_associations).
export async function listConsentModuleAssociationCounts(slug: string): Promise<Record<number, number>> {
  const table = await tenantTable(slug, "client_consent_records").catch(() => null);
  if (!table) return {};
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.push("tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT module_id, COUNT(*) AS c FROM ${quoteIdentifier(table.name)}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} GROUP BY module_id`,
    params,
  ).catch(() => []);
  const out: Record<number, number> = {};
  for (const row of rows) out[Number(row.module_id ?? 0)] = Number(row.c ?? 0) || 0;
  return out;
}

// consent_module_system_preview_text: la "Chiusura automatica del PDF" della
// colonna destra dell'editor.
export function consentModuleSystemPreviewText(consentModule: { footerMode: string }): string {
  if (consentModule.footerMode === "gdpr_consents") {
    const rows = Object.values(privacyConsentLabels()).map((label) => `[ ] ${label}`);
    rows.push("Data: {{data}}", "Firma cliente: ____________________________");
    return rows.join("\n");
  }
  return ["Data: {{data}}", "Firma cliente: ____________________________"].join("\n");
}

// consent_module_available_variables (privacy_consent_available_variables).
export function consentModuleAvailableVariables(): Array<{ variable: string; description: string }> {
  return [
    { variable: "{{nome}}", description: "Nome del cliente" },
    { variable: "{{cognome}}", description: "Cognome del cliente" },
    { variable: "{{cliente}}", description: "Nome completo del cliente" },
    { variable: "{{email}}", description: "Email del cliente" },
    { variable: "{{telefono}}", description: "Telefono del cliente" },
    { variable: "{{data}}", description: "Data documento" },
    { variable: "{{dati_sede}}", description: "Dati operativi della sede collegata" },
    { variable: "{{Dati anagrafici}}", description: "Dati anagrafici dell'attivita (ragione sociale, P. IVA, CF, SDI, PEC, indirizzo e contatti)" },
  ];
}

// Port dell'anteprima PDF (consent_modules.php preview=pdf): dati demo Mario
// Rossi, fallback del blocco sede/anagrafica quando le variabili sono vuote,
// snapshot + render con footer del tipo. Accetta i valori NON salvati del form.
export async function buildConsentModulePreviewPdf(
  slug: string,
  body: Record<string, string>,
): Promise<{ bytes: Buffer; filename: string }> {
  const id = parseInteger(body.id, 0);
  const existing = id > 0 ? await getManageConsentModule(slug, id) : null;

  let type = String(body.type ?? existing?.type ?? "informed_consent").trim();
  if (type !== "privacy_gdpr") type = "informed_consent";
  const isSystem = (existing?.isSystem ?? false) || type === "privacy_gdpr";
  if (isSystem) type = "privacy_gdpr";
  const meta = typeMeta(type);

  let name = String(body.name ?? existing?.name ?? "").trim() || "Nuovo modulo consenso";
  let bodyTemplate = String(body.body_template ?? "").replace(/\r\n|\r/g, "\n").trim();
  if (bodyTemplate === "") {
    bodyTemplate = String(existing?.bodyTemplate ?? "").trim()
      || (type === "privacy_gdpr" ? privacyDefaultTemplate() : DEFAULT_INFORMED_TEMPLATE);
  }
  if (isSystem) name = "PDF privacy GDPR";

  const previewClient = {
    first_name: "Mario",
    last_name: "Rossi",
    email: "mario.rossi@example.com",
    phone: "+39 333 1234567",
  } as RowDataPacket;
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "*", orderBy: "id ASC", limit: 1 }).catch(() => []);
  const biz = (bizRows[0] ?? {}) as RowDataPacket;

  const moduleInfo = {
    id: existing?.id ?? 0,
    name,
    slug: existing?.slug ?? "",
    type,
    footerMode: meta.footerMode,
    footerTitle: meta.footerTitle,
    isActive: true,
    bodyTemplate,
  };
  const snapshot = consentModuleSnapshotCreate(moduleInfo, previewClient, biz);

  const previewFallbackBusinessBlock = [
    "Beauty Suite S.r.l.",
    "P. IVA: IT12345678901 | Codice Fiscale: RSSMRA80A01F205X | SDI: ABCD123 | PEC: info@pec.example.com",
    "Via Roma 1 - 20100 Milano (MI - Lombardia)",
    "Tel: 02 000000 | Email: info@example.com | Sito web: www.example.com",
  ].join("\n");
  const vars = privacyTemplateVariables(previewClient, biz, snapshot.document_date_display);
  for (const key of ["{{dati_sede}}", "{{dati anagrafici}}", "{{dati_anagrafici}}", "{{Dati anagrafici}}"]) {
    if (String(vars[key] ?? "").trim() === "") vars[key] = previewFallbackBusinessBlock;
  }
  snapshot.body_text = privacyRenderTemplateText(bodyTemplate, vars);
  snapshot.filename = privacyPdfSafeFilename(String(snapshot.filename ?? "ANTEPRIMA_MODULO.pdf"));

  const bytes = await renderPrivacyPdf(snapshot, { footerMode: meta.footerMode, footerTitle: meta.footerTitle });
  return { bytes, filename: snapshot.filename };
}

// Port of consent_module_save + consent_module_validate_payload. id<=0 creates
// an informed_consent module; id>0 updates (system modules stay privacy_gdpr,
// active, slug fixed). Throws faithful validation errors.
export async function saveManageConsentModule(slug: string, body: Record<string, string>): Promise<ConsentModuleRow> {
  const id = parseInteger(body.id, 0);
  const existing = id > 0 ? await getManageConsentModule(slug, id) : null;
  if (id > 0 && !existing) throw new Error("Modulo consenso non trovato.");
  const isSystem = existing ? existing.isSystem : false;

  let name = String(body.name ?? existing?.name ?? "").trim();
  if (name === "") name = isSystem ? "PDF privacy GDPR" : "Modulo consenso";

  let type = String(body.type ?? existing?.type ?? "informed_consent").trim();
  if (isSystem) type = "privacy_gdpr";
  if (type !== "privacy_gdpr") type = "informed_consent";
  if (!isSystem && type === "privacy_gdpr") {
    throw new Error("Il modulo PDF privacy GDPR e unico e non puo essere duplicato.");
  }

  const bodyTemplate = String(body.body_template ?? existing?.bodyTemplate ?? "").replace(/\r\n|\r/g, "\n").trim();
  if (bodyTemplate === "") throw new Error("Il template del modulo non puo essere vuoto.");

  let moduleSlug = String(body.slug ?? existing?.slug ?? "").trim();
  if (isSystem) {
    moduleSlug = SYSTEM_SLUG;
  } else {
    moduleSlug = await uniqueSlug(slug, moduleSlug !== "" ? moduleSlug : name, existing?.id ?? 0);
  }

  let isActive = body.is_active !== undefined ? (Number(body.is_active) === 1 || body.is_active === "1" ? 1 : 0) : existing?.isActive ? 1 : 0;
  if (isSystem) isActive = 1;

  const meta = typeMeta(type);
  const sortOrder = parseInteger(body.sort_order, existing?.sortOrder ?? 0);

  const values: Record<string, unknown> = {
    name,
    slug: moduleSlug,
    type,
    body_template: bodyTemplate,
    footer_mode: meta.footerMode,
    footer_title: meta.footerTitle,
    is_system: isSystem ? 1 : 0,
    is_active: isActive,
    sort_order: sortOrder,
    system_key: isSystem ? "privacy_gdpr" : null,
  };

  let moduleId: number;
  if (existing) {
    await tenantUpdate({ slug, table: "consent_modules", id: existing.id, values });
    moduleId = existing.id;
  } else {
    const table = await tenantTable(slug, "consent_modules");
    moduleId = await tenantInsert(table, values);
  }

  // Faithful side effect: the GDPR system module mirrors its body onto the
  // businesses.gdpr_template_body column used by the privacy PDF generator.
  if (type === "privacy_gdpr") {
    try {
      const bizTable = await tenantTable(slug, "businesses");
      if (await columnExists(bizTable.name, "gdpr_template_body")) {
        const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "id", limit: 1 });
        const bizId = Number(rows[0]?.id ?? 0);
        if (bizId > 0) await tenantUpdate({ slug, table: "businesses", id: bizId, values: { gdpr_template_body: bodyTemplate } });
      }
    } catch {
      // best-effort: the module itself is saved regardless of the mirror.
    }
  }

  const saved = await getManageConsentModule(slug, moduleId);
  if (!saved) throw new Error("Modulo salvato ma non rileggibile.");
  return saved;
}

// Port of consent_module_delete. System module cannot be deleted; modules with
// signed documents cannot be deleted (disable instead). Detaches association
// records then removes the module.
export async function deleteManageConsentModule(slug: string, moduleId: number): Promise<{ associationCount: number }> {
  const consentModule = await getManageConsentModule(slug, moduleId);
  if (!consentModule) throw new Error("Modulo consenso non trovato.");
  if (consentModule.isSystem) {
    throw new Error("Il modulo PDF privacy GDPR e di sistema e non puo essere eliminato.");
  }

  const records = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_consent_records",
    columns: "id, status, document_id",
    where: "module_id=?",
    params: [moduleId],
  }).catch(() => []);

  const associationCount = records.length;
  const signedCount = records.filter((r) => Number(r.document_id ?? 0) > 0 || String(r.status ?? "") === "signed").length;
  if (signedCount > 0) {
    throw new Error("Il modulo ha documenti firmati collegati e non puo essere eliminato. Disattivalo per non usarlo nei nuovi consensi e conserva lo storico cliente.");
  }

  const recordsTable = await tenantTable(slug, "client_consent_records").catch(() => null);
  if (recordsTable) {
    const clauses = ["module_id=?"];
    const params: unknown[] = [moduleId];
    if (recordsTable.mode === "shared" && (await columnExists(recordsTable.name, "tenant_id"))) {
      clauses.unshift("tenant_id=?");
      params.unshift(recordsTable.tenantId ?? 0);
    }
    await dbQuery(`DELETE FROM ${quoteIdentifier(recordsTable.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
  }

  await tenantDelete({ slug, table: "consent_modules", id: moduleId });
  return { associationCount };
}
