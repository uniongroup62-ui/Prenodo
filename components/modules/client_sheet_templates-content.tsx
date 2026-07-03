"use client";

import { useCallback, useEffect, useState } from "react";

// Port funzionante di app/pages/client_sheet_templates.php ("Configura
// schede"): lista template reali (client_sheet_templates via
// /api/manage/client-sheets), builder React con righe campo dinamiche
// (mostra/nasconde Unità/Placeholder/Opzioni per tipo come il TYPE_UI legacy),
// preset hardcoded (dimagrimento/viso/laser), sedi abilitate, salvataggio
// action=save_template coi messaggi legacy ("Tab salvato correttamente.",
// "Tab eliminato.") e regole di lock lato server quando esistono compilazioni.

type SheetField = {
  id?: string;
  label: string;
  type: string;
  required?: number;
  placeholder?: string;
  help?: string;
  unit?: string;
  options?: string[];
};

type SheetTemplate = {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  fields: Array<Required<SheetField> & { id: string }>;
  locationIds: number[];
  recordCount: number;
  lastRecordDate: string | null;
};

type BuilderRow = {
  key: number;
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string;
  help: string;
  unit: string;
  optionsRaw: string;
  locked: boolean;
};

type LocationRow = { id: number; name?: string };

const TYPE_OPTIONS: Array<[string, string]> = [
  ["text", "Testo breve"],
  ["textarea", "Testo lungo"],
  ["number", "Numero / misura"],
  ["date", "Data"],
  ["select", "Scelta da elenco"],
  ["checkbox", "Sì / No"],
  ["photo_before", "Foto prima"],
  ["photo_after", "Foto dopo"],
  ["photo", "Foto generica"],
  ["document", "Documento"],
];

// Preset hardcoded legacy (client_sheet_templates.php $presetData).
const PRESETS: Record<string, SheetField[]> = {
  blank: [],
  dimagrimento: [
    { label: "Peso", type: "number", unit: "kg", required: 1, placeholder: "Es. 72.4", help: "Rilevazione peso della seduta" },
    { label: "Circonferenza vita", type: "number", unit: "cm", placeholder: "Es. 84" },
    { label: "Foto prima", type: "photo_before" },
    { label: "Foto dopo", type: "photo_after" },
  ],
  viso: [
    { label: "Tipo pelle", type: "select", options: ["Secca", "Mista", "Grassa", "Sensibile", "Acneica"], required: 1 },
    { label: "Obiettivo trattamento", type: "text", required: 1, placeholder: "Es. illuminante, anti-age, purificante" },
    { label: "Zone critiche", type: "textarea", help: "Macchie, rossori, impurità, rughe" },
    { label: "Foto prima", type: "photo_before" },
    { label: "Foto dopo", type: "photo_after" },
  ],
  laser: [
    { label: "Zona trattata", type: "text", required: 1 },
    { label: "Fototipo", type: "select", options: ["I", "II", "III", "IV", "V", "VI"], required: 1 },
    { label: "Energia impostata", type: "number", unit: "J" },
    { label: "Note operatore", type: "textarea" },
    { label: "Foto prima", type: "photo_before" },
    { label: "Foto dopo", type: "photo_after" },
  ],
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function itDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

let rowCounter = 1;
function rowFromField(field: SheetField, locked: boolean): BuilderRow {
  return {
    key: rowCounter++,
    id: String(field.id ?? ""),
    label: field.label ?? "",
    type: field.type ?? "text",
    required: Number(field.required ?? 0) === 1,
    placeholder: field.placeholder ?? "",
    help: field.help ?? "",
    unit: field.unit ?? "",
    optionsRaw: (field.options ?? []).join(", "),
    locked,
  };
}

export function ClientSheetTemplatesContent() {
  const slug = tenantSlug();
  const [templates, setTemplates] = useState<SheetTemplate[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [returnClientId, setReturnClientId] = useState(0);

  // Stato builder.
  const [editingId, setEditingId] = useState(0);
  const [editingLocked, setEditingLocked] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [rows, setRows] = useState<BuilderRow[]>([]);
  const [locationIds, setLocationIds] = useState<number[]>([]);

  const load = useCallback(() => {
    fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setTemplates(Array.isArray(j.templates) ? j.templates : []))
      .catch(() => setTemplates([]));
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list: LocationRow[] = Array.isArray(j.locations) ? j.locations : [];
        setLocations(list);
        setLocationIds((prev) => (prev.length ? prev : list.map((l) => Number(l.id))));
      })
      .catch(() => setLocations([]));
  }, [slug]);

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    setReturnClientId(Number(params.get("return_client_id") ?? "0") || 0);
  }, [load]);

  // Prefill ?edit_template= una volta caricata la lista.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const editId = Number(params.get("edit_template") ?? "0") || 0;
    if (editId > 0 && templates.length && editingId !== editId) {
      const template = templates.find((t) => t.id === editId);
      if (template) startEdit(template);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  const startNew = (preset = "blank") => {
    setEditingId(0);
    setEditingLocked(false);
    setTitle("");
    setDescription("");
    setIsActive(true);
    setRows((PRESETS[preset] ?? []).map((f) => rowFromField(f, false)));
    setLocationIds(locations.map((l) => Number(l.id)));
    setMessage(null);
  };

  const startEdit = (template: SheetTemplate) => {
    const locked = template.recordCount > 0;
    setEditingId(template.id);
    setEditingLocked(locked);
    setTitle(template.title);
    setDescription(template.description);
    setIsActive(template.isActive);
    setRows(template.fields.map((f) => rowFromField(f, locked)));
    setLocationIds(template.locationIds.length ? template.locationIds : locations.map((l) => Number(l.id)));
    setMessage(null);
  };

  const addRow = () => setRows((prev) => [...prev, rowFromField({ label: "", type: "text" }, false)]);
  const removeRow = (key: number) => setRows((prev) => prev.filter((r) => r.key !== key || r.locked));
  const updateRow = (key: number, patch: Partial<BuilderRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submitTemplate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const fields = rows.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        required: r.required ? 1 : 0,
        placeholder: r.placeholder,
        help: r.help,
        unit: r.unit,
        options: r.optionsRaw,
      }));
      const response = await fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          _action: "save_template",
          template_id: String(editingId),
          title,
          description,
          is_active: isActive ? "1" : "0",
          fields_json: JSON.stringify(fields),
          location_ids_json: JSON.stringify(locationIds),
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        setMessage({ text: json.message || "Tab salvato correttamente.", ok: true });
        setTemplates(Array.isArray(json.templates) ? json.templates : []);
        if (!editingId) startNew();
      } else {
        setMessage({ text: String(json.error ?? "Operazione non riuscita."), ok: false });
      }
    } catch {
      setMessage({ text: "Operazione non riuscita.", ok: false });
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (template: SheetTemplate) => {
    const confirmText = template.recordCount > 0
      ? "Eliminare questo tab? Le compilazioni gia salvate resteranno conservate nello storico cliente, ma il tab non sara piu disponibile per nuove compilazioni."
      : "Eliminare questo tab?";
    if (!globalThis.confirm(confirmText)) return;
    const response = await fetch(`/api/manage/client-sheets?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify({ _action: "delete_template", template_id: String(template.id) }),
    });
    const json = await response.json().catch(() => ({}));
    if (json.ok) {
      setMessage({ text: json.message || "Tab eliminato.", ok: true });
      setTemplates(Array.isArray(json.templates) ? json.templates : []);
      if (editingId === template.id) startNew();
    } else {
      setMessage({ text: String(json.error ?? "Operazione non riuscita."), ok: false });
    }
  };

  const totalTabs = templates.length;
  const activeTabs = templates.filter((t) => t.isActive).length;
  const totalRecords = templates.reduce((sum, t) => sum + t.recordCount, 0);
  const lastRecordDate = templates.map((t) => t.lastRecordDate).filter(Boolean).sort().pop() ?? null;

  const typeUi = (type: string) => ({
    unit: type === "number",
    placeholder: ["text", "textarea", "number"].includes(type),
    options: type === "select",
  });

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/client_sheet_templates.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Clienti</div>
          <h1 className="bs-page-title">Configura schede</h1>
          <div className="bs-page-subtitle">Gestisci i tab tecnici riutilizzabili per sede e cliente.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end align-items-center">
            {returnClientId > 0 ? (
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/client_sheets?client_id=${returnClientId}`}>
                <i className="bi bi-arrow-left me-1" />
                Torna alle compilazioni
              </a>
            ) : (
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients`}>
                <i className="bi bi-arrow-left me-1" />
                Clienti
              </a>
            )}
            <button className="btn btn-primary" type="button" onClick={() => startNew()}>
              <i className="bi bi-plus-lg me-1" />
              Nuovo tab
            </button>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Tab configurati</div>
            <div className="value">{totalTabs}</div>
            <div className="text-muted small mt-2">visibili nella sede corrente</div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Tab attivi</div>
            <div className="value">{activeTabs}</div>
            <div className="text-muted small mt-2">disponibili per le compilazioni</div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="sheet-tile">
            <div className="text-muted small">Compilazioni collegate</div>
            <div className="value">{totalRecords}</div>
            <div className="text-muted small mt-2">ultima: {itDate(lastRecordDate)}</div>
          </div>
        </div>
      </div>

      {message ? (
        <div className={`alert ${message.ok ? "alert-success" : "alert-danger"}`}>{message.text}</div>
      ) : null}

      <div className="row g-3">
        <div className="col-xl-4">
          <div className="sheet-surface p-3 h-100">
            <div className="d-flex justify-content-between align-items-center mb-3 gap-2">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-layout-sidebar-inset me-2" />
                  Tab schede
                </div>
                <div className="text-muted small">Template riutilizzabili per i clienti della sede.</div>
              </div>
              <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => startNew()}>
                <i className="bi bi-plus-lg" />
              </button>
            </div>

            {templates.length === 0 ? (
              <div className="sheet-empty-state">
                <div className="fw-semibold">Nessun tab configurato</div>
                <div className="text-muted small mt-2">Crea il primo tab tecnico per iniziare a compilare le schede cliente.</div>
              </div>
            ) : (
              <div className="list-group">
                {templates.map((template) => (
                  <div className={`list-group-item${editingId === template.id ? " active" : ""}`} key={template.id}>
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <div>
                        <div className="fw-semibold">
                          {template.title}
                          {!template.isActive ? <span className="badge bg-light text-dark ms-2">Disattivo</span> : null}
                        </div>
                        <div className={`small ${editingId === template.id ? "" : "text-muted"}`}>
                          {template.fields.length} campi · {template.recordCount} compilazioni
                          {template.lastRecordDate ? ` · ultima ${itDate(template.lastRecordDate)}` : ""}
                        </div>
                      </div>
                      <div className="d-flex gap-1">
                        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => startEdit(template)}>
                          <i className="bi bi-pencil" />
                        </button>
                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => deleteTemplate(template)}>
                          <i className="bi bi-trash" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col-xl-8">
          <div className="sheet-surface p-3 p-lg-4">
            <div className="fw-semibold mb-1">
              <i className="bi bi-tools me-2" />
              {editingId ? `Modifica tab · ${title || "senza nome"}` : "Nuovo tab"}
            </div>
            <div className="text-muted small mb-3">
              {editingLocked
                ? "Questo tab ha compilazioni associate: nome, descrizione e campi esistenti sono bloccati. Puoi aggiungere nuovi campi in fondo."
                : "Definisci nome, sedi e campi personalizzati del tab."}
            </div>

            <form className="vstack gap-3" onSubmit={submitTemplate}>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label fw-semibold">Nome tab</label>
                  <input className="form-control" value={title} onChange={(e) => setTitle(e.target.value)} disabled={editingLocked} required />
                </div>
                <div className="col-md-6">
                  <label className="form-label fw-semibold">Parti da un preset</label>
                  <select
                    className="form-select"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        setRows((PRESETS[e.target.value] ?? []).map((f) => rowFromField(f, false)));
                        e.target.value = "";
                      }
                    }}
                    disabled={editingLocked}
                  >
                    <option value="">Scegli un preset...</option>
                    <option value="blank">Vuoto</option>
                    <option value="dimagrimento">Dimagrimento</option>
                    <option value="viso">Trattamento viso</option>
                    <option value="laser">Epilazione laser</option>
                  </select>
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Descrizione</label>
                  <textarea className="form-control" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={editingLocked} />
                </div>
                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" id="sheetTemplateActive" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                    <label className="form-check-label" htmlFor="sheetTemplateActive">Tab attivo</label>
                  </div>
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Sedi abilitate</label>
                  <div className="d-flex flex-wrap gap-3">
                    {locations.map((location) => (
                      <div className="form-check" key={location.id}>
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`sheetLoc${location.id}`}
                          checked={locationIds.includes(Number(location.id))}
                          onChange={(e) =>
                            setLocationIds((prev) =>
                              e.target.checked
                                ? [...prev, Number(location.id)]
                                : prev.filter((id) => id !== Number(location.id)),
                            )
                          }
                        />
                        <label className="form-check-label" htmlFor={`sheetLoc${location.id}`}>{location.name ?? `Sede #${location.id}`}</label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <hr className="my-1" />

              <div className="d-flex justify-content-between align-items-center">
                <div className="fw-semibold">Campi personalizzati</div>
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={addRow}>
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi campo
                </button>
              </div>

              {rows.length === 0 ? (
                <div className="text-muted small">Aggiungi almeno un campo personalizzato per la scheda.</div>
              ) : (
                <div className="vstack gap-3">
                  {rows.map((row, index) => {
                    const ui = typeUi(row.type);
                    return (
                      <div className={`border rounded p-3${row.locked ? " bg-light" : ""}`} key={row.key}>
                        <div className="d-flex justify-content-between align-items-center mb-2">
                          <div className="fw-semibold small">
                            Campo #{index + 1}
                            {row.locked ? <span className="badge bg-secondary ms-2">Campo bloccato</span> : null}
                          </div>
                          {!row.locked ? (
                            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeRow(row.key)}>
                              <i className="bi bi-trash" />
                            </button>
                          ) : null}
                        </div>
                        <div className="row g-2">
                          <div className="col-md-5">
                            <label className="form-label small text-muted">Etichetta campo</label>
                            <input className="form-control form-control-sm" value={row.label} onChange={(e) => updateRow(row.key, { label: e.target.value })} disabled={row.locked} />
                          </div>
                          <div className="col-md-4">
                            <label className="form-label small text-muted">Tipo</label>
                            <select className="form-select form-select-sm" value={row.type} onChange={(e) => updateRow(row.key, { type: e.target.value })} disabled={row.locked}>
                              {TYPE_OPTIONS.map(([value, label]) => (
                                <option value={value} key={value}>{label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="col-md-3 d-flex align-items-end">
                            <div className="form-check">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                id={`fieldReq${row.key}`}
                                checked={row.required}
                                onChange={(e) => updateRow(row.key, { required: e.target.checked })}
                                disabled={row.locked}
                              />
                              <label className="form-check-label small" htmlFor={`fieldReq${row.key}`}>Obbligatorio</label>
                            </div>
                          </div>
                          {ui.unit ? (
                            <div className="col-md-3">
                              <label className="form-label small text-muted">Unità</label>
                              <input className="form-control form-control-sm" value={row.unit} onChange={(e) => updateRow(row.key, { unit: e.target.value })} disabled={row.locked} placeholder="Es. kg, cm" />
                            </div>
                          ) : null}
                          {ui.placeholder ? (
                            <div className="col-md-4">
                              <label className="form-label small text-muted">Placeholder</label>
                              <input className="form-control form-control-sm" value={row.placeholder} onChange={(e) => updateRow(row.key, { placeholder: e.target.value })} disabled={row.locked} />
                            </div>
                          ) : null}
                          {ui.options ? (
                            <div className="col-md-5">
                              <label className="form-label small text-muted">Opzioni elenco</label>
                              <input className="form-control form-control-sm" value={row.optionsRaw} onChange={(e) => updateRow(row.key, { optionsRaw: e.target.value })} disabled={row.locked} placeholder="Voce 1, Voce 2, Voce 3" />
                            </div>
                          ) : null}
                          <div className="col-12">
                            <label className="form-label small text-muted">Testo di aiuto</label>
                            <input className="form-control form-control-sm" value={row.help} onChange={(e) => updateRow(row.key, { help: e.target.value })} disabled={row.locked} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="d-flex gap-2">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva tab
                </button>
                {editingId ? (
                  <button type="button" className="btn btn-outline-secondary" onClick={() => startNew()}>
                    Annulla modifica
                  </button>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
