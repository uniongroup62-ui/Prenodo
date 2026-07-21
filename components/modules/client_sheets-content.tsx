"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Port funzionante di app/pages/client_sheets.php (schede tecniche cliente):
// 3 colonne (Schede disponibili / Compilazioni / editor), tiles KPI reali,
// form di compilazione dinamico dai campi del template (o dallo snapshot del
// record in modifica), allegati foto/documento su R2 con download presigned,
// salvataggio multipart su /api/manage/client-sheets. Il builder dei template
// vive nella pagina "Configura schede" (come il legacy, che vi redirige).

type SheetField = {
  id: string;
  label: string;
  type: string;
  required: 0 | 1;
  placeholder: string;
  help: string;
  unit: string;
  options: string[];
};

type SheetAttachment = {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  ext: string;
  kind: "photo" | "document";
};

type SheetTemplate = {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  fields: SheetField[];
  recordCount: number;
  lastRecordDate: string | null;
};

type SheetRecord = {
  id: number;
  templateId: number;
  title: string;
  sessionDate: string;
  nextSessionDate: string | null;
  operatorName: string;
  notes: string;
  values: Record<string, unknown>;
  fields: SheetField[];
};

type Client = { id: number; name?: string; phone?: string; email?: string };

const ATTACHMENT_TYPES = new Set(["photo_before", "photo_after", "photo", "document"]);

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function itDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// Formato valore riepilogo (client_sheet_value_format): foto/doc contati,
// checkbox Sì/No, data d/m/Y, numero con unità.
function formatValue(field: SheetField, value: unknown): string {
  if (ATTACHMENT_TYPES.has(field.type)) {
    const n = Array.isArray(value) ? value.length : 0;
    if (field.type === "document") return `${n} ${n === 1 ? "documento" : "documenti"}`;
    return `${n} foto`;
  }
  const raw = String(value ?? "").trim();
  if (field.type === "checkbox") return raw === "1" ? "Sì" : "No";
  if (!raw) return "";
  if (field.type === "date") return itDate(raw);
  if (field.type === "number") return field.unit ? `${raw} ${field.unit}` : raw;
  return raw;
}

export function ClientSheetsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clientId, setClientId] = useState(0);
  const [client, setClient] = useState<Client | null>(null);
  const [templates, setTemplates] = useState<SheetTemplate[]>([]);
  const [records, setRecords] = useState<SheetRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(0);
  const [editingRecordId, setEditingRecordId] = useState(0);
  // Audit giro 3: guardia doppio-click sulla delete scheda.
  const [deletingRecordId, setDeletingRecordId] = useState(0);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // Stato form compilazione.
  const [values, setValues] = useState<Record<string, string>>({});
  const [header, setHeader] = useState({ title: "", session_date: "", next_session_date: "", operator_name: "", notes: "" });
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [removals, setRemovals] = useState<Record<string, string[]>>({});
  const [existingAttachments, setExistingAttachments] = useState<Record<string, SheetAttachment[]>>({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setClientId(Number(params.get("client_id") ?? "0") || 0);
  }, []);

  const load = useCallback(() => {
    if (!clientId) return;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const found = (j.clients ?? []).find((c: Client) => Number(c.id) === clientId);
        setClient(found ?? null);
      })
      .catch(() => setClient(null));
    fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}&client_id=${clientId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setTemplates(Array.isArray(j.templates) ? j.templates.filter((t: SheetTemplate) => t.isActive) : []);
        setRecords(Array.isArray(j.records) ? j.records : []);
      })
      .catch(() => undefined);
  }, [slug, clientId]);

  useEffect(() => {
    load();
  }, [load]);

  const activeTemplate = useMemo(() => templates.find((t) => t.id === selectedTemplateId) ?? null, [templates, selectedTemplateId]);
  const editingRecord = useMemo(() => records.find((r) => r.id === editingRecordId) ?? null, [records, editingRecordId]);
  // In modifica si usano i campi dello snapshot del record (legacy effective fields).
  const formFields: SheetField[] = editingRecord ? editingRecord.fields : (activeTemplate?.fields ?? []);
  const formTemplateId = editingRecord ? editingRecord.templateId : selectedTemplateId;

  const resetForm = useCallback((template: SheetTemplate | null, record: SheetRecord | null) => {
    const fields = record ? record.fields : (template?.fields ?? []);
    const nextValues: Record<string, string> = {};
    const nextAttachments: Record<string, SheetAttachment[]> = {};
    for (const field of fields) {
      if (ATTACHMENT_TYPES.has(field.type)) {
        nextAttachments[field.id] = record && Array.isArray(record.values[field.id]) ? (record.values[field.id] as SheetAttachment[]) : [];
      } else {
        nextValues[field.id] = record ? String(record.values[field.id] ?? "") : "";
      }
    }
    setValues(nextValues);
    setExistingAttachments(nextAttachments);
    setFiles({});
    setRemovals({});
    setHeader({
      title: record?.title ?? template?.title ?? "",
      // Data di ROMA (audit giro 3: toISOString e' UTC, vicino a mezzanotte
      // slittava di un giorno).
      session_date: record?.sessionDate ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }),
      next_session_date: record?.nextSessionDate ?? "",
      operator_name: record?.operatorName ?? "",
      notes: record?.notes ?? "",
    });
  }, []);

  const pickTemplate = (template: SheetTemplate) => {
    setSelectedTemplateId(template.id);
    setEditingRecordId(0);
    setMessage(null);
    resetForm(template, null);
  };

  const openRecord = (record: SheetRecord) => {
    setEditingRecordId(record.id);
    setSelectedTemplateId(record.templateId);
    setMessage(null);
    resetForm(templates.find((t) => t.id === record.templateId) ?? null, record);
  };

  const submitRecord = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!formTemplateId || !clientId) return;
    setSaving(true);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.set("_action", "save_record");
      fd.set("client_id", String(clientId));
      fd.set("template_id", String(formTemplateId));
      fd.set("record_id", String(editingRecordId || 0));
      fd.set("values_json", JSON.stringify(values));
      fd.set("remove_attachments_json", JSON.stringify(removals));
      fd.set("title", header.title);
      fd.set("session_date", header.session_date);
      fd.set("next_session_date", header.next_session_date);
      fd.set("operator_name", header.operator_name);
      fd.set("notes", header.notes);
      for (const [fieldId, list] of Object.entries(files)) {
        for (const file of list) fd.append(`field_upload_${fieldId}`, file);
      }
      const response = await fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: fd,
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        setMessage({ text: json.message || "Scheda tecnica salvata correttamente.", ok: true });
        setRecords(Array.isArray(json.records) ? json.records : []);
        setEditingRecordId(0);
        resetForm(activeTemplate, null);
        load();
      } else {
        setMessage({ text: String(json.error ?? "Operazione non riuscita."), ok: false });
      }
    } catch {
      setMessage({ text: "Operazione non riuscita.", ok: false });
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async (record: SheetRecord) => {
    if (deletingRecordId) return;
    if (!globalThis.confirm("Eliminare questa scheda tecnica? L'operazione sarà immediata.")) return;
    setDeletingRecordId(record.id);
    try {
    const response = await fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify({ _action: "delete_record", client_id: String(clientId), record_id: String(record.id) }),
    });
    const json = await response.json().catch(() => ({}));
    if (json.ok) {
      setMessage({ text: json.message || "Scheda tecnica eliminata.", ok: true });
      setRecords(Array.isArray(json.records) ? json.records : []);
      if (editingRecordId === record.id) {
        setEditingRecordId(0);
        resetForm(activeTemplate, null);
      }
    } else {
      setMessage({ text: String(json.error ?? "Operazione non riuscita."), ok: false });
    }
    } catch {
      setMessage({ text: "Errore di rete: operazione non eseguita. Riprova.", ok: false });
    } finally {
      setDeletingRecordId(0);
    }
  };

  function href(page: string, extra: string = ""): string {
    return `/${encodeURIComponent(slug)}/${`${page}${extra}`.replace("&", "?")}`;
  }

  const templateConfigUrl = href("client_sheet_templates", `&return_client_id=${clientId}`);
  const backUrl = href("clients", `&action=view&id=${clientId}`);
  const attachmentUrl = (recordId: number, attachmentId: string) =>
    `/api/manage/client-sheets?slug=${encodeURIComponent(slug)}&client_id=${clientId}&record_id=${recordId}&attachment_id=${encodeURIComponent(attachmentId)}`;

  const displayName = client?.name ? client.name : clientId ? `Cliente #${clientId}` : "—";
  const subtitle = `${client?.phone || "-"} - ${client?.email || "-"}`;
  const lastRecordDate = records[0]?.sessionDate ?? null;

  const renderField = (field: SheetField) => {
    if (ATTACHMENT_TYPES.has(field.type)) {
      const isDoc = field.type === "document";
      const existing = (existingAttachments[field.id] ?? []).filter((att) => !(removals[field.id] ?? []).includes(att.id));
      return (
        <div className="col-12" key={field.id}>
          <label className="form-label fw-semibold">
            {field.label} {field.required ? <span className="text-danger">*</span> : null}
          </label>
          {field.help ? <div className="form-text mb-1">{field.help}</div> : null}
          {existing.length > 0 ? (
            <ul className="list-group mb-2">
              {existing.map((att) => (
                <li className="list-group-item d-flex justify-content-between align-items-center py-1" key={att.id}>
                  {editingRecordId > 0 ? (
                    <a href={attachmentUrl(editingRecordId, att.id)} target="_blank" rel="noreferrer">{att.name}</a>
                  ) : (
                    <span>{att.name}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => setRemovals((prev) => ({ ...prev, [field.id]: [...(prev[field.id] ?? []), att.id] }))}
                  >
                    Rimuovi
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <input
            className="form-control"
            type="file"
            multiple
            accept={isDoc ? ".pdf,.doc,.docx,.odt,.xls,.xlsx" : "image/jpeg,image/png"}
            onChange={(e) => setFiles((prev) => ({ ...prev, [field.id]: Array.from(e.target.files ?? []) }))}
          />
          <div className="form-text">
            {isDoc ? "Massimo 5 documenti (PDF, DOC, DOCX, ODT, XLS, XLSX), 5 MB l'uno." : "Massimo 5 immagini (JPG o PNG), 5 MB l'una."}
          </div>
        </div>
      );
    }

    const common = {
      value: values[field.id] ?? "",
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
        setValues((prev) => ({ ...prev, [field.id]: e.target.value })),
    };

    return (
      <div className={field.type === "textarea" ? "col-12" : "col-md-6"} key={field.id}>
        <label className="form-label fw-semibold">
          {field.label} {field.required ? <span className="text-danger">*</span> : null}
        </label>
        {field.type === "textarea" ? (
          <textarea className="form-control" rows={3} placeholder={field.placeholder} {...common} />
        ) : field.type === "select" ? (
          <select className="form-select" {...common}>
            <option value="">Seleziona...</option>
            {field.options.map((opt) => (
              <option value={opt} key={opt}>{opt}</option>
            ))}
          </select>
        ) : field.type === "checkbox" ? (
          <div className="form-check form-switch">
            <input
              className="form-check-input"
              type="checkbox"
              checked={(values[field.id] ?? "") === "1"}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.checked ? "1" : "0" }))}
            />
            <label className="form-check-label small text-muted">Segna quando il controllo risulta positivo</label>
          </div>
        ) : field.type === "number" ? (
          <div className="input-group">
            <input className="form-control" type="text" inputMode="decimal" placeholder={field.placeholder} {...common} />
            {field.unit ? <span className="input-group-text">{field.unit}</span> : null}
          </div>
        ) : (
          <input className="form-control" type={field.type === "date" ? "date" : "text"} placeholder={field.placeholder} {...common} />
        )}
        {field.help ? <div className="form-text">{field.help}</div> : null}
      </div>
    );
  };

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/client_sheets.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Compilazioni cliente</div>
          <h1 className="bs-page-title">{displayName}</h1>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-primary" href={templateConfigUrl}>
              <i className="bi bi-sliders me-1" />
              Configura schede
            </a>
            <a className="btn btn-outline-secondary" href={backUrl}>
              <i className="bi bi-arrow-left me-1" />
              Scheda cliente
            </a>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-1">
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Tab tecnici</div>
            <div className="value">{templates.length}</div>
            <div className="text-muted small mt-2">ogni tab ha i propri campi personalizzati</div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Schede compilate</div>
            <div className="value">{records.length}</div>
            <div className="text-muted small mt-2">storico sempre disponibile per questo cliente</div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Ultima compilazione</div>
            <div className="value sheet-tile-value-compact">{itDate(lastRecordDate)}</div>
            <div className="text-muted small mt-2">ultimo aggiornamento registrato</div>
          </div>
        </div>
      </div>

      {message ? (
        <div className={`alert ${message.ok ? "alert-success" : "alert-danger"} mt-3 mb-0`}>{message.text}</div>
      ) : null}

      <div className="row g-3 mt-1">
        <div className="col-xl-3">
          <div className="sheet-surface p-3 h-100">
            <div className="d-flex justify-content-between align-items-center mb-3 gap-2">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-layout-sidebar-inset me-2" />
                  Schede disponibili
                </div>
                <div className="text-muted small">Seleziona il tab da compilare per questo cliente.</div>
              </div>
              <a className="btn btn-sm btn-outline-primary" href={templateConfigUrl} title="Configura schede">
                <i className="bi bi-sliders" />
              </a>
            </div>

            {templates.length === 0 ? (
              <div className="sheet-empty-state">
                <div className="mb-2 sheet-empty-icon">
                  <i className="bi bi-journal-text" />
                </div>
                <div className="fw-semibold">Nessuna scheda configurata</div>
                <div className="text-muted small mt-2">Configura almeno un tab tecnico prima di compilare lo storico cliente.</div>
                <a className="btn btn-primary btn-sm mt-3" href={`${templateConfigUrl}&new_template=1`}>
                  Configura schede
                </a>
              </div>
            ) : (
              <div className="list-group">
                {templates.map((template) => (
                  <button
                    type="button"
                    key={template.id}
                    className={`list-group-item list-group-item-action${!editingRecord && selectedTemplateId === template.id ? " active" : ""}`}
                    onClick={() => pickTemplate(template)}
                  >
                    <div className="fw-semibold">{template.title}</div>
                    <div className={`small ${!editingRecord && selectedTemplateId === template.id ? "" : "text-muted"}`}>
                      {template.fields.length} campi · {template.recordCount} compilazioni
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col-xl-3">
          <div className="sheet-surface p-3 h-100">
            <div className="d-flex justify-content-between align-items-center mb-3 gap-2">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-collection me-2" />
                  Compilazioni
                </div>
                <div className="text-muted small">Storico delle schede salvate del cliente.</div>
              </div>
            </div>

            {records.length === 0 ? (
              <div className="sheet-empty-state">
                <div className="mb-2 sheet-empty-icon">
                  <i className="bi bi-file-earmark-text" />
                </div>
                <div className="fw-semibold">Nessuna scheda compilata</div>
                <div className="text-muted small mt-2">Salva una scheda da un tab disponibile per iniziare a costruire lo storico del cliente.</div>
              </div>
            ) : (
              <div className="vstack gap-2">
                {records.map((record) => {
                  const summary = record.fields
                    .map((field) => ({ field, text: formatValue(field, record.values[field.id]) }))
                    .filter((item) => item.text !== "" && item.text !== "0 foto" && item.text !== "0 documenti")
                    .slice(0, 3);
                  return (
                    <div className={`border rounded p-2${editingRecordId === record.id ? " border-primary" : ""}`} key={record.id}>
                      <div className="d-flex justify-content-between align-items-start gap-2">
                        <div>
                          <div className="fw-semibold">{record.title}</div>
                          <div className="text-muted small">{itDate(record.sessionDate)}{record.operatorName ? ` · ${record.operatorName}` : ""}</div>
                        </div>
                        <div className="d-flex gap-1">
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => openRecord(record)}>
                            Apri
                          </button>
                          <button type="button" className="btn btn-sm btn-outline-danger" disabled={deletingRecordId !== 0} onClick={() => deleteRecord(record)}>
                            <i className="bi bi-trash" />
                          </button>
                        </div>
                      </div>
                      {summary.length > 0 ? (
                        <div className="text-muted small mt-1">
                          {summary.map((item) => `${item.field.label}: ${item.text}`).join(" · ")}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="col-xl-6">
          <div className="sheet-surface p-0 overflow-hidden">
            <div className="sheet-form-header">
              <i className="bi bi-clipboard2-pulse" />
              <span>{editingRecord ? `Modifica scheda · ${editingRecord.title}` : "Compila scheda"}</span>
            </div>

            <div className="p-3 p-lg-4">
              {formFields.length === 0 ? (
                <div className="sheet-empty-state">
                  <div className="fw-semibold">{templates.length === 0 ? "Nessuna scheda disponibile" : "Seleziona prima un tab."}</div>
                  <div className="text-muted small mt-2">
                    {templates.length === 0
                      ? "Configura i tab tecnici e poi torna qui per compilare lo storico del cliente."
                      : "Scegli una scheda dalla colonna a sinistra per iniziare la compilazione."}
                  </div>
                  {templates.length === 0 ? (
                    <a className="btn btn-primary btn-sm mt-3" href={`${templateConfigUrl}&new_template=1`}>
                      <i className="bi bi-sliders me-1" />
                      Configura schede
                    </a>
                  ) : null}
                </div>
              ) : (
                <form className="row g-3" onSubmit={submitRecord}>
                  <div className="col-md-6">
                    <label className="form-label fw-semibold">Titolo scheda</label>
                    <input className="form-control" value={header.title} onChange={(e) => setHeader((p) => ({ ...p, title: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label fw-semibold">Data seduta</label>
                    <input className="form-control" type="date" value={header.session_date} onChange={(e) => setHeader((p) => ({ ...p, session_date: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label fw-semibold">Prossima seduta</label>
                    <input className="form-control" type="date" value={header.next_session_date} onChange={(e) => setHeader((p) => ({ ...p, next_session_date: e.target.value }))} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label fw-semibold">Operatore</label>
                    <input className="form-control" value={header.operator_name} onChange={(e) => setHeader((p) => ({ ...p, operator_name: e.target.value }))} />
                  </div>

                  {formFields.map(renderField)}

                  <div className="col-12">
                    <label className="form-label fw-semibold">Note seduta</label>
                    <textarea className="form-control" rows={3} value={header.notes} onChange={(e) => setHeader((p) => ({ ...p, notes: e.target.value }))} />
                  </div>

                  <div className="col-12 d-flex gap-2">
                    <button className="btn btn-primary" type="submit" disabled={saving}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva scheda
                    </button>
                    {editingRecord ? (
                      <button
                        type="button"
                        className="btn btn-outline-secondary"
                        onClick={() => {
                          setEditingRecordId(0);
                          resetForm(activeTemplate, null);
                        }}
                      >
                        Annulla modifica
                      </button>
                    ) : null}
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
