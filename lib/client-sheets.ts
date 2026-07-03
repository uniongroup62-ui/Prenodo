import "server-only";

import { randomBytes } from "node:crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";
import {
  STORAGE_NOT_CONFIGURED_ERROR,
  deletePrivateObject,
  presignedPrivateGetUrl,
  putPrivateObject,
  storagePrivateConfigured,
} from "@/lib/storage";

// SCHEDE TECNICHE CLIENTE — port completo di app/lib/ClientSheets.php:
// - template (client_sheet_templates + client_sheet_template_locations):
//   normalizzazione campi, validazioni coi messaggi legacy, regole di LOCK
//   quando esistono compilazioni (nome/descrizione bloccati, campi solo in
//   append, sedi usate non rimovibili), soft-delete con deleted_at;
// - compilazioni (client_sheet_records): values_json = mappa {fieldId: value}
//   con stringhe per i campi scalari ('1'/'0' checkbox, numero con punto,
//   data Y-m-d) e ARRAY di allegati per i campi foto/documento;
//   fields_snapshot_json congela i campi al salvataggio cosi' i vecchi
//   record restano coerenti anche se il template cambia;
// - allegati su Cloudflare R2 PRIVATO (il legacy usa uploads/tenants/<slug>/
//   client_sheets/... bloccata da .htaccess + streaming autenticato):
//   max 5 file per campo, 5 MB l'uno, foto JPG/PNG, documenti
//   PDF/DOC/DOCX/ODT/XLS/XLSX, download via presigned URL.
// Divergenza documentata: il layout meta degli allegati (note/posizione da
// attachment_meta) e' portato come passthrough minimale (posizione = ordine).

export const SHEET_FIELD_TYPES: Record<string, string> = {
  text: "Testo breve",
  textarea: "Testo lungo",
  number: "Numero / misura",
  date: "Data",
  select: "Scelta da elenco",
  checkbox: "Sì / No",
  photo_before: "Foto prima",
  photo_after: "Foto dopo",
  photo: "Foto generica",
  document: "Documento",
};
const PHOTO_TYPES = new Set(["photo_before", "photo_after", "photo"]);
const DOCUMENT_TYPES = new Set(["document"]);
const ATTACHMENT_TYPES = new Set([...PHOTO_TYPES, ...DOCUMENT_TYPES]);

const MAX_FILES_PER_FIELD = 5;
const MAX_FILE_BYTES = 5242880;
const PHOTO_EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };
const DOC_EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export type SheetField = {
  id: string;
  label: string;
  type: string;
  required: 0 | 1;
  placeholder: string;
  help: string;
  unit: string;
  options: string[];
};

export type SheetAttachment = {
  id: string;
  path: string;
  name: string;
  mime: string;
  uploaded_at: string;
  size: number;
  ext: string;
  kind: "photo" | "document";
  note?: string;
  position?: number;
};

function slugifyFieldId(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "campo";
}

// Campo nascosto legacy: label "note seduta" viene silenziosamente scartata.
function isHiddenField(label: string): boolean {
  return label.trim().toLowerCase() === "note seduta";
}

// Port di client_sheet_fields_normalize (ClientSheets.php 216-256).
export function sheetFieldsNormalize(raw: unknown): SheetField[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SheetField[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const row = (item ?? {}) as Record<string, unknown>;
    const label = String(row.label ?? "").trim();
    if (!label || isHiddenField(label)) continue;
    let type = String(row.type ?? "text").trim().toLowerCase();
    if (!SHEET_FIELD_TYPES[type]) type = "text";
    let id = slugifyFieldId(String(row.id ?? "").trim() || label);
    if (seen.has(id)) {
      let counter = 2;
      while (seen.has(`${id}_${counter}`)) counter += 1;
      id = `${id}_${counter}`;
    }
    seen.add(id);
    const optionsRaw = row.options;
    const options = type === "select"
      ? (Array.isArray(optionsRaw)
          ? optionsRaw.map((o) => String(o).trim()).filter(Boolean)
          : String(optionsRaw ?? "").split(/[\r\n,]+/).map((o) => o.trim()).filter(Boolean)
        ).filter((v, i, arr) => arr.indexOf(v) === i)
      : [];
    out.push({
      id,
      label,
      type,
      required: row.required && String(row.required) !== "0" ? 1 : 0,
      placeholder: ["text", "textarea", "number"].includes(type) ? String(row.placeholder ?? "").trim() : "",
      help: String(row.help ?? "").trim(),
      unit: type === "number" ? String(row.unit ?? "").trim() : "",
      options,
    });
  }
  return out;
}

// Port di client_sheet_fields_validate_input (258-288) — messaggi verbatim.
export function sheetFieldsValidateInput(rows: Array<Record<string, unknown>>): void {
  let index = 0;
  for (const row of rows) {
    const label = String(row.label ?? "").trim();
    if (isHiddenField(label)) continue;
    index += 1;
    if (!label) throw new Error(`Completa "Etichetta campo" per il campo #${index}.`);
    const type = String(row.type ?? "text").trim().toLowerCase();
    if (type === "number" && !String(row.unit ?? "").trim()) {
      throw new Error(`Compila "Unità" per il campo "${label}".`);
    }
    if (type === "select") {
      const raw = Array.isArray(row.options) ? row.options.join(",") : String(row.options ?? "");
      if (!raw.split(/[\r\n,]+/).some((o) => o.trim())) {
        throw new Error(`Inserisci almeno una voce in "Opzioni elenco" per il campo "${label}".`);
      }
    }
  }
}

function fieldsSignature(fields: SheetField[]): string {
  return JSON.stringify(fields.map((f) => [f.id, f.label, f.type, f.required, f.placeholder, f.help, f.unit, f.options]));
}

async function templatesTable(slug: string) {
  return tenantTable(slug, "client_sheet_templates");
}

async function recordCountForTemplate(slug: string, templateId: number): Promise<number> {
  const table = await tenantTable(slug, "client_sheet_records");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) c FROM ${quoteIdentifier(table.name)} WHERE tenant_id = ? AND template_id = ?`,
    [table.tenantId ?? 0, templateId],
  ).catch(() => [] as RowDataPacket[]);
  return Number(rows[0]?.c ?? 0);
}

export type SheetTemplate = {
  id: number;
  title: string;
  slug: string;
  description: string;
  isActive: boolean;
  fields: SheetField[];
  locationIds: number[];
  recordCount: number;
  lastRecordDate: string | null;
};

function parseFields(json: unknown): SheetField[] {
  try {
    return sheetFieldsNormalize(JSON.parse(String(json ?? "[]")));
  } catch {
    return [];
  }
}

export async function listSheetTemplates(slug: string): Promise<SheetTemplate[]> {
  const table = await templatesTable(slug);
  const hasDeleted = await columnExists(table.name, "deleted_at");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_sheet_templates",
    where: hasDeleted ? "deleted_at IS NULL" : "1=1",
    orderBy: "is_active DESC, updated_at DESC, id DESC",
  }).catch(() => [] as RowDataPacket[]);

  const locTable = await tenantTable(slug, "client_sheet_template_locations").catch(() => null);
  const locByTemplate = new Map<number, number[]>();
  if (locTable && rows.length) {
    const ids = rows.map((r) => Number(r.id));
    const locRows = await dbQuery<RowDataPacket[]>(
      `SELECT template_id, location_id FROM ${quoteIdentifier(locTable.name)} WHERE tenant_id = ? AND is_enabled = 1 AND template_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order ASC, location_id ASC`,
      [locTable.tenantId ?? 0, ...ids],
    ).catch(() => [] as RowDataPacket[]);
    for (const lr of locRows) {
      const tid = Number(lr.template_id);
      const list = locByTemplate.get(tid) ?? [];
      list.push(Number(lr.location_id));
      locByTemplate.set(tid, list);
    }
  }

  const recTable = await tenantTable(slug, "client_sheet_records").catch(() => null);
  const statsByTemplate = new Map<number, { count: number; last: string | null }>();
  if (recTable && rows.length) {
    const ids = rows.map((r) => Number(r.id));
    const statRows = await dbQuery<RowDataPacket[]>(
      `SELECT template_id, COUNT(*) c, MAX(session_date) last_date FROM ${quoteIdentifier(recTable.name)} WHERE tenant_id = ? AND template_id IN (${ids.map(() => "?").join(",")}) GROUP BY template_id`,
      [recTable.tenantId ?? 0, ...ids],
    ).catch(() => [] as RowDataPacket[]);
    for (const sr of statRows) {
      statsByTemplate.set(Number(sr.template_id), { count: Number(sr.c ?? 0), last: sr.last_date ? String(sr.last_date).slice(0, 10) : null });
    }
  }

  return rows.map((row) => ({
    id: Number(row.id),
    title: String(row.title ?? ""),
    slug: String(row.slug ?? ""),
    description: String(row.description ?? ""),
    isActive: Number(row.is_active ?? 1) === 1,
    fields: parseFields(row.fields_json),
    locationIds: locByTemplate.get(Number(row.id)) ?? [],
    recordCount: statsByTemplate.get(Number(row.id))?.count ?? 0,
    lastRecordDate: statsByTemplate.get(Number(row.id))?.last ?? null,
  }));
}

async function findTemplateRow(slug: string, id: number): Promise<RowDataPacket | null> {
  const table = await templatesTable(slug);
  const hasDeleted = await columnExists(table.name, "deleted_at");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_sheet_templates",
    where: hasDeleted ? "id = ? AND deleted_at IS NULL" : "id = ?",
    params: [id],
    limit: 1,
  });
  return rows[0] ?? null;
}

// Port di client_sheet_template_save (597-690) + save_locations (454-479).
export async function saveSheetTemplate(
  slug: string,
  input: { id?: number; title: string; description: string; isActive: boolean; fields: Array<Record<string, unknown>>; locationIds: number[] },
  userId: number | null,
): Promise<number> {
  const title = input.title.trim();
  if (!title) throw new Error("Inserisci il nome del tab.");
  const templateSlug = slugifyFieldId(title);
  if (!templateSlug) throw new Error("Nome tab non valido.");
  sheetFieldsValidateInput(input.fields);
  let fields = sheetFieldsNormalize(input.fields);
  if (!fields.length) throw new Error("Aggiungi almeno un campo personalizzato per la scheda.");
  const locationIds = [...new Set(input.locationIds.filter((id) => id > 0))];
  if (!locationIds.length) throw new Error("Seleziona almeno una sede abilitata per questo tab.");

  const table = await templatesTable(slug);
  const tid = table.tenantId ?? 0;
  const id = Number(input.id ?? 0) || 0;
  let finalTitle = title;
  let finalSlug = templateSlug;
  let finalDescription = input.description.trim();

  if (id > 0) {
    const existing = await findTemplateRow(slug, id);
    if (!existing) throw new Error("Tab non trovato.");
    const usedCount = await recordCountForTemplate(slug, id);
    if (usedCount > 0) {
      // Regole di LOCK legacy (635-672): sedi usate non rimovibili, nome/
      // descrizione bloccati, campi esistenti immutabili (solo append in fondo).
      const usedLocRows = await dbQuery<RowDataPacket[]>(
        `SELECT DISTINCT location_id FROM ${quoteIdentifier((await tenantTable(slug, "client_sheet_records")).name)} WHERE tenant_id = ? AND template_id = ? AND COALESCE(location_id, 0) > 0`,
        [tid, id],
      ).catch(() => [] as RowDataPacket[]);
      for (const lr of usedLocRows) {
        if (!locationIds.includes(Number(lr.location_id))) {
          throw new Error("Non puoi rimuovere una sede che contiene già compilazioni per questo tab.");
        }
      }
      const existingFields = parseFields(existing.fields_json);
      if (fields.length < existingFields.length) {
        throw new Error("Questo tab ha compilazioni associate: i campi esistenti non possono essere rimossi.");
      }
      if (fieldsSignature(fields.slice(0, existingFields.length)) !== fieldsSignature(existingFields)) {
        throw new Error("Questo tab ha compilazioni associate: i campi già usati non possono essere modificati, eliminati o riordinati. Puoi attivare/disattivare il tab, eliminarlo o aggiungere nuovi campi in fondo.");
      }
      const titleChanged = title !== String(existing.title ?? "") || finalDescription !== String(existing.description ?? "");
      if (titleChanged) {
        throw new Error("Questo tab ha compilazioni associate: nome e descrizione non possono essere modificati.");
      }
      finalTitle = String(existing.title ?? title);
      finalSlug = String(existing.slug ?? templateSlug) || templateSlug;
      finalDescription = String(existing.description ?? "");
      fields = [...existingFields, ...fields.slice(existingFields.length)];
    }
  }

  // Conflitto slug+sede tra template attivi (client_sheet_template_location_conflict).
  if (input.isActive) {
    const locTable = await tenantTable(slug, "client_sheet_template_locations");
    const hasDeleted = await columnExists(table.name, "deleted_at");
    const conflict = await dbQuery<RowDataPacket[]>(
      `SELECT t.id FROM ${quoteIdentifier(table.name)} t
         JOIN ${quoteIdentifier(locTable.name)} tl ON tl.template_id = t.id AND tl.tenant_id = t.tenant_id AND tl.is_enabled = 1
        WHERE t.tenant_id = ? AND t.slug = ? AND t.is_active = 1 AND t.id <> ?${hasDeleted ? " AND t.deleted_at IS NULL" : ""}
          AND tl.location_id IN (${locationIds.map(() => "?").join(",")}) LIMIT 1`,
      [tid, finalSlug, id, ...locationIds],
    ).catch(() => [] as RowDataPacket[]);
    if (conflict[0]) throw new Error("Esiste già un tab attivo con questo nome in una delle sedi selezionate.");
  }

  const fieldsJson = JSON.stringify(fields);
  let templateId = id;
  if (id > 0) {
    await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET client_id = 0, title = ?, slug = ?, description = ?, is_active = ?, fields_json = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?`,
      [finalTitle, finalSlug, finalDescription, input.isActive ? 1 : 0, fieldsJson, userId, tid, id],
    );
  } else {
    templateId = await tenantInsert(table, {
      client_id: 0,
      title: finalTitle,
      slug: finalSlug,
      description: finalDescription,
      is_active: input.isActive ? 1 : 0,
      fields_json: fieldsJson,
      created_by: userId,
      updated_by: userId,
    });
  }

  // Upsert sedi abilitate + disabilitazione di quelle tolte.
  const locTable = await tenantTable(slug, "client_sheet_template_locations");
  let sort = 0;
  for (const locationId of locationIds) {
    sort += 10;
    const existing = await dbQuery<RowDataPacket[]>(
      `SELECT id FROM ${quoteIdentifier(locTable.name)} WHERE tenant_id = ? AND template_id = ? AND location_id = ? LIMIT 1`,
      [locTable.tenantId ?? 0, templateId, locationId],
    ).catch(() => [] as RowDataPacket[]);
    if (existing[0]) {
      await dbExecute(
        `UPDATE ${quoteIdentifier(locTable.name)} SET is_enabled = 1, sort_order = ?, disabled_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?`,
        [sort, locTable.tenantId ?? 0, Number(existing[0].id)],
      );
    } else {
      await tenantInsert(locTable, { template_id: templateId, location_id: locationId, is_enabled: 1, sort_order: sort });
    }
  }
  await dbExecute(
    `UPDATE ${quoteIdentifier(locTable.name)} SET is_enabled = 0, disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND template_id = ? AND location_id NOT IN (${locationIds.map(() => "?").join(",")})`,
    [locTable.tenantId ?? 0, templateId, ...locationIds],
  );

  return templateId;
}

// Port di client_sheet_template_delete (692-716): soft-delete se ha compilazioni.
export async function deleteSheetTemplate(slug: string, id: number, userId: number | null): Promise<void> {
  const table = await templatesTable(slug);
  const existing = await findTemplateRow(slug, id);
  if (!existing) throw new Error("Tab non trovato.");
  const usedCount = await recordCountForTemplate(slug, id);
  const locTable = await tenantTable(slug, "client_sheet_template_locations");
  if (usedCount > 0) {
    if (!(await columnExists(table.name, "deleted_at"))) {
      throw new Error("Aggiorna il database prima di eliminare un tab con compilazioni salvate.");
    }
    await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?`,
      [userId, userId, table.tenantId ?? 0, id],
    );
    await dbExecute(
      `UPDATE ${quoteIdentifier(locTable.name)} SET is_enabled = 0, disabled_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND template_id = ?`,
      [locTable.tenantId ?? 0, id],
    );
    return;
  }
  await dbExecute(`DELETE FROM ${quoteIdentifier(locTable.name)} WHERE tenant_id = ? AND template_id = ?`, [locTable.tenantId ?? 0, id]);
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE tenant_id = ? AND id = ?`, [table.tenantId ?? 0, id]);
}

// ---------------------------------------------------------------------------
// COMPILAZIONI
// ---------------------------------------------------------------------------

export type SheetRecord = {
  id: number;
  clientId: number;
  templateId: number;
  locationId: number | null;
  title: string;
  sessionDate: string;
  nextSessionDate: string | null;
  operatorName: string;
  notes: string;
  values: Record<string, unknown>;
  fields: SheetField[]; // snapshot preferito (client_sheet_record_effective_fields)
  createdAt: string;
};

function parseValues(json: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(json ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapRecord(row: RowDataPacket, templateFields: SheetField[] | null): SheetRecord {
  const snapshot = parseFields(row.fields_snapshot_json);
  return {
    id: Number(row.id),
    clientId: Number(row.client_id ?? 0),
    templateId: Number(row.template_id ?? 0),
    locationId: row.location_id === null || row.location_id === undefined ? null : Number(row.location_id),
    title: String(row.title ?? ""),
    sessionDate: String(row.session_date ?? "").slice(0, 10),
    nextSessionDate: row.next_session_date ? String(row.next_session_date).slice(0, 10) : null,
    operatorName: String(row.operator_name ?? ""),
    notes: String(row.notes ?? ""),
    values: parseValues(row.values_json),
    fields: snapshot.length ? snapshot : (templateFields ?? []),
    createdAt: String(row.created_at ?? ""),
  };
}

export async function listSheetRecordsForClient(slug: string, clientId: number): Promise<SheetRecord[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_sheet_records",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "session_date DESC, id DESC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => mapRecord(row, null));
}

async function findRecordRow(slug: string, id: number, clientId: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_sheet_records",
    where: "id = ? AND client_id = ?",
    params: [id, clientId],
    limit: 1,
  });
  return rows[0] ?? null;
}

function normalizeDateValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value) ?? (() => {
    const it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    return it ? [it[0], it[3], it[2], it[1]] as unknown as RegExpExecArray : null;
  })();
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

export type SheetUpload = { fieldId: string; name: string; mime: string; bytes: Uint8Array };

// Port del core di client_sheet_record_save (ClientSheets.php 1480-1689).
export async function saveSheetRecord(
  slug: string,
  args: {
    clientId: number;
    templateId: number;
    recordId: number | null;
    locationId: number;
    input: Record<string, unknown>;
    uploads: SheetUpload[];
    userId: number | null;
  },
): Promise<number> {
  const { clientId, templateId } = args;
  const recordId = Number(args.recordId ?? 0) || 0;

  // Template (o snapshot del record in modifica se il template e' sparito).
  const templateRow = await findTemplateRow(slug, templateId).catch(() => null);
  let templateFields: SheetField[] = templateRow ? parseFields(templateRow.fields_json) : [];
  let existing: RowDataPacket | null = null;
  if (recordId > 0) {
    existing = await findRecordRow(slug, recordId, clientId);
    if (!existing || Number(existing.template_id) !== templateId) throw new Error("Scheda tecnica non trovata.");
    const snapshot = parseFields(existing.fields_snapshot_json);
    if (snapshot.length) templateFields = snapshot;
  }
  if (!templateRow && !existing) throw new Error("Tab non trovato.");
  if (!templateFields.length) throw new Error("Tab non valido.");

  const input = args.input;
  const locationId = args.locationId > 0
    ? args.locationId
    : Number(input.location_id ?? 0) || (existing ? Number(existing.location_id ?? 0) : 0);

  const sessionDate = normalizeDateValue(String(input.session_date ?? "")) || new Date().toISOString().slice(0, 10);
  const nextSessionRaw = normalizeDateValue(String(input.next_session_date ?? ""));
  const nextSessionDate = nextSessionRaw || null;
  const operatorName = String(input.operator_name ?? "").trim();
  const title = String(input.title ?? "").trim() || String(templateRow?.title ?? "Scheda tecnica");
  const notes = String(input.notes ?? "").trim();

  const postedValues = (input.values && typeof input.values === "object" ? input.values : input) as Record<string, unknown>;
  let removeMap: Record<string, string[]> = {};
  try {
    const rawRemove = input.remove_attachments_json ?? input.remove_attachments;
    const parsed = typeof rawRemove === "string" ? JSON.parse(rawRemove) : rawRemove;
    if (parsed && typeof parsed === "object") {
      removeMap = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String)]));
    }
  } catch {
    removeMap = {};
  }

  const existingValues = existing ? parseValues(existing.values_json) : {};
  const values: Record<string, unknown> = {};
  const deferredDeletes: string[] = [];
  const pendingUploads: Array<{ field: SheetField; upload: SheetUpload; ext: string; kind: "photo" | "document" }> = [];

  for (const field of templateFields) {
    if (ATTACHMENT_TYPES.has(field.type)) {
      const kind: "photo" | "document" = DOCUMENT_TYPES.has(field.type) ? "document" : "photo";
      const kept: SheetAttachment[] = (Array.isArray(existingValues[field.id]) ? existingValues[field.id] as SheetAttachment[] : [])
        .filter((att) => att && typeof att === "object");
      const removeIds = new Set(removeMap[field.id] ?? []);
      const remaining = kept.filter((att) => {
        if (removeIds.has(String(att.id))) {
          if (att.path) deferredDeletes.push(String(att.path));
          return false;
        }
        return true;
      });
      const newUploads = args.uploads.filter((u) => u.fieldId === field.id);
      // Validazioni upload coi messaggi legacy.
      for (const up of newUploads) {
        if (up.bytes.length <= 0) throw new Error(kind === "document" ? "Upload documento non valido." : "Upload immagine non valido.");
        if (up.bytes.length > MAX_FILE_BYTES) {
          throw new Error(kind === "document" ? "Ogni documento deve pesare al massimo 5 MB." : "Ogni immagine deve pesare al massimo 5 MB.");
        }
        const ext = (kind === "document" ? DOC_EXT_BY_MIME : PHOTO_EXT_BY_MIME)[up.mime.toLowerCase()];
        if (!ext) {
          throw new Error(kind === "document"
            ? "Formato documento non supportato. Usa solo PDF, DOC, DOCX, ODT, XLS o XLSX."
            : "Formato immagine non supportato. Usa solo JPG o PNG.");
        }
        pendingUploads.push({ field, upload: up, ext, kind });
      }
      if (remaining.length + newUploads.length > MAX_FILES_PER_FIELD) {
        throw new Error(`Puoi caricare al massimo 5 ${kind === "document" ? "documenti" : "immagini"} per il campo "${field.label}".`);
      }
      if (field.required === 1 && remaining.length + newUploads.length === 0) {
        throw new Error(`Carica almeno ${kind === "document" ? "un documento" : "una foto"} per il campo "${field.label}".`);
      }
      values[field.id] = remaining;
      continue;
    }

    if (field.type === "checkbox") {
      const raw = postedValues[field.id];
      values[field.id] = raw && String(raw) !== "0" && String(raw) !== "" ? "1" : "0";
      continue;
    }

    let value = Array.isArray(postedValues[field.id])
      ? (postedValues[field.id] as unknown[]).map(String).join(", ").trim()
      : String(postedValues[field.id] ?? "").trim();

    if (field.type === "number") {
      value = value.replace(/,/g, ".");
      if (value !== "" && !Number.isFinite(Number(value))) {
        throw new Error(`Il campo "${field.label}" deve contenere un numero valido.`);
      }
    } else if (field.type === "date") {
      const normalized = normalizeDateValue(value);
      if (normalized === null) throw new Error(`Il campo "${field.label}" contiene una data non valida.`);
      value = normalized;
    } else if (field.type === "select") {
      if (value !== "" && !field.options.includes(value)) {
        throw new Error(`La selezione scelta per "${field.label}" non è valida.`);
      }
    }
    if (field.required === 1 && value === "") {
      throw new Error(`Compila il campo obbligatorio "${field.label}".`);
    }
    values[field.id] = value;
  }

  if (pendingUploads.length && !storagePrivateConfigured()) throw new Error(STORAGE_NOT_CONFIGURED_ERROR);

  const table = await tenantTable(slug, "client_sheet_records");
  const tid = table.tenantId ?? 0;
  const fieldsSnapshotJson = JSON.stringify(templateFields);

  let savedId = recordId;
  if (recordId > 0) {
    await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET location_id = ?, title = ?, session_date = ?, next_session_date = ?, operator_name = ?, values_json = ?, fields_snapshot_json = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ? AND client_id = ?`,
      [locationId > 0 ? locationId : null, title, sessionDate, nextSessionDate, operatorName, JSON.stringify(values), fieldsSnapshotJson, notes, args.userId, tid, recordId, clientId],
    );
  } else {
    savedId = await tenantInsert(table, {
      client_id: clientId,
      template_id: templateId,
      location_id: locationId > 0 ? locationId : null,
      title,
      session_date: sessionDate,
      next_session_date: nextSessionDate,
      operator_name: operatorName,
      values_json: JSON.stringify(values),
      fields_snapshot_json: fieldsSnapshotJson,
      notes,
      created_by: args.userId,
      updated_by: args.userId,
    });
  }

  // Upload NUOVI allegati con l'id definitivo (come il legacy: insert prima,
  // poi store + secondo UPDATE di values_json). Su errore, rollback best-effort.
  const uploadedKeys: string[] = [];
  try {
    for (const pending of pendingUploads) {
      const key = `t${tid}/client_sheets/${clientId}/record_${savedId}/${pending.kind === "document" ? "documents" : "photos"}/${pending.field.id}_${randomBytes(10).toString("hex")}.${pending.ext}`;
      await putPrivateObject(key, pending.upload.bytes, pending.upload.mime.toLowerCase());
      uploadedKeys.push(key);
      const list = values[pending.field.id] as SheetAttachment[];
      list.push({
        id: randomBytes(8).toString("hex"),
        path: key,
        name: pending.upload.name.trim().slice(0, 190) || `allegato.${pending.ext}`,
        mime: pending.upload.mime.toLowerCase(),
        uploaded_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        size: pending.upload.bytes.length,
        ext: pending.ext,
        kind: pending.kind,
        position: list.length,
      });
    }
    if (pendingUploads.length) {
      await dbExecute(
        `UPDATE ${quoteIdentifier(table.name)} SET values_json = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ? AND client_id = ?`,
        [JSON.stringify(values), tid, savedId, clientId],
      );
    }
  } catch (error) {
    for (const key of uploadedKeys) await deletePrivateObject(key).catch(() => undefined);
    if (recordId === 0 && savedId > 0) {
      await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE tenant_id = ? AND id = ?`, [tid, savedId]).catch(() => undefined);
    }
    throw error instanceof Error ? error : new Error("Impossibile salvare uno dei file caricati.");
  }

  // Cancellazione differita degli allegati rimossi (solo a salvataggio riuscito).
  for (const path of deferredDeletes) {
    if (/^t\d+\//.test(path)) await deletePrivateObject(path).catch(() => undefined);
  }

  return savedId;
}

// Port di client_sheet_record_delete_attachment (1692-1800) — immediata.
export async function deleteSheetAttachment(slug: string, recordId: number, clientId: number, attachmentId: string): Promise<void> {
  const row = await findRecordRow(slug, recordId, clientId);
  if (!row) throw new Error("Scheda tecnica non trovata.");
  if (!attachmentId) throw new Error("Allegato non valido.");
  const values = parseValues(row.values_json);
  let found = false;
  let pathToDelete = "";
  for (const [fieldId, value] of Object.entries(values)) {
    if (!Array.isArray(value)) continue;
    const list = value as SheetAttachment[];
    const idx = list.findIndex((att) => String(att?.id ?? "") === attachmentId);
    if (idx >= 0) {
      found = true;
      pathToDelete = String(list[idx].path ?? "");
      list.splice(idx, 1);
      values[fieldId] = list;
      break;
    }
  }
  if (!found) throw new Error("File non trovato.");
  const table = await tenantTable(slug, "client_sheet_records");
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET values_json = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ? AND client_id = ?`,
    [JSON.stringify(values), table.tenantId ?? 0, recordId, clientId],
  );
  if (/^t\d+\//.test(pathToDelete)) await deletePrivateObject(pathToDelete).catch(() => undefined);
}

// Port di client_sheet_record_delete (1802-1815).
export async function deleteSheetRecord(slug: string, recordId: number, clientId: number): Promise<void> {
  const row = await findRecordRow(slug, recordId, clientId);
  if (!row) throw new Error("Scheda tecnica non trovata.");
  const values = parseValues(row.values_json);
  for (const value of Object.values(values)) {
    if (!Array.isArray(value)) continue;
    for (const att of value as SheetAttachment[]) {
      const path = String(att?.path ?? "");
      if (/^t\d+\//.test(path)) await deletePrivateObject(path).catch(() => undefined);
    }
  }
  const table = await tenantTable(slug, "client_sheet_records");
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE tenant_id = ? AND id = ? AND client_id = ?`, [table.tenantId ?? 0, recordId, clientId]);
}

// Serving allegato: presigned URL R2 dopo il match per id (client_sheet_attachment.php).
export async function sheetAttachmentPresignedUrl(slug: string, recordId: number, clientId: number, attachmentId: string): Promise<string> {
  const row = await findRecordRow(slug, recordId, clientId);
  if (!row) throw new Error("File non trovato");
  const values = parseValues(row.values_json);
  for (const value of Object.values(values)) {
    if (!Array.isArray(value)) continue;
    for (const att of value as SheetAttachment[]) {
      if (String(att?.id ?? "") === attachmentId) {
        const path = String(att.path ?? "");
        if (!/^t\d+\//.test(path)) throw new Error("Allegato legacy non migrato: ricaricalo dalla scheda.");
        return presignedPrivateGetUrl(path, 300);
      }
    }
  }
  throw new Error("File non trovato");
}
