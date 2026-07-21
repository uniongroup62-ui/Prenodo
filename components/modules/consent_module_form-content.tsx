"use client";

import { useEffect, useRef, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

// Faithful port of the PHP consent-module NEW / EDIT editor
// (app/pages/consent_modules.php, action=new|edit + consent_modules.js):
// page header SEMPRE 'Moduli consenso' con [Lista moduli][Nuovo modulo],
// flash ?msg dei redirect legacy, form (Nome/Stato/Contenuto) e la colonna
// destra legacy: 'Chiusura automatica del PDF', 'Anteprima contenuto' (modale
// iframe con il PDF demo renderizzato server-side via action=preview_pdf),
// 'Variabili disponibili' e 'Workflow cliente'. Delete con il modale legacy.
// Save: redirect a action=edit&id=N&msg='Modulo consenso salvato con successo.'

const TYPE_LABELS: Record<string, string> = {
  privacy_gdpr: "PDF privacy GDPR",
  informed_consent: "Consenso informato",
};

// consent_module_default_template('informed_consent') verbatim.
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

// consent_module_system_preview_text per i moduli non GDPR (statico).
const SIGNATURE_ONLY_PREVIEW = ["Data: {{data}}", "Firma cliente: ____________________________"].join("\n");

// privacy_consent_available_variables verbatim.
const AVAILABLE_VARIABLES: Array<{ variable: string; description: string }> = [
  { variable: "{{nome}}", description: "Nome del cliente" },
  { variable: "{{cognome}}", description: "Cognome del cliente" },
  { variable: "{{cliente}}", description: "Nome completo del cliente" },
  { variable: "{{email}}", description: "Email del cliente" },
  { variable: "{{telefono}}", description: "Telefono del cliente" },
  { variable: "{{data}}", description: "Data documento" },
  { variable: "{{dati_sede}}", description: "Dati operativi della sede collegata" },
  { variable: "{{Dati anagrafici}}", description: "Dati anagrafici dell'attivita (ragione sociale, P. IVA, CF, SDI, PEC, indirizzo e contatti)" },
];

type ConsentForm = {
  id: number;
  name: string;
  type: string;
  body_template: string;
  is_active: boolean;
  is_system: boolean;
  association_count: number;
  system_preview_text: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): ConsentForm {
  return {
    id: 0,
    name: "Nuovo modulo consenso",
    type: "informed_consent",
    body_template: DEFAULT_INFORMED_TEMPLATE,
    is_active: true,
    is_system: false,
    association_count: 0,
    system_preview_text: SIGNATURE_ONLY_PREVIEW,
  };
}

export function ConsentModuleFormContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string; err?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [form, setForm] = useState<ConsentForm>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [flashMsg, setFlashMsg] = useState(() => String(initialQuery?.msg ?? ""));
  useTakenFlash((f) => {
    if (f.msg) setFlashMsg(f.msg);
  });
  // Modale anteprima PDF (consentTemplatePreviewModal): blob URL nell'iframe.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const previewUrlRef = useRef("");
  // Modale conferma eliminazione (consent_modules.js).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      fetch(`/api/manage/configuration?module=consent_modules&action=get&id=${id}&slug=${encodeURIComponent(slug)}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j) => {
          if (!j.ok || !j.consentModule) {
            setError(String(j.error ?? "Modulo consenso non trovato."));
            return;
          }
          const m = j.consentModule;
          setForm({
            id: Number(m.id ?? id),
            name: String(m.name ?? ""),
            type: String(m.type ?? "informed_consent"),
            body_template: String(m.bodyTemplate ?? ""),
            is_active: Boolean(m.isActive),
            is_system: Boolean(m.isSystem),
            association_count: Number(m.associationCount ?? 0) || 0,
            system_preview_text: String(m.systemPreviewText ?? SIGNATURE_ONLY_PREVIEW),
          });
        })
        .catch(() => setError("Errore nel caricamento del modulo."))
        .finally(() => setLoading(false));
    } else {
      // Microtask: niente setState sincrono nell'effect.
      void Promise.resolve().then(() => setLoading(false));
    }
  }, [slug]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function set<K extends keyof ConsentForm>(key: K, value: ConsentForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function listHref(suffix = ""): string {
    return `/${encodeURIComponent(slug)}/consent_modules${suffix}`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        module: "consent_modules",
        action: "save_module",
        id: String(form.id),
        type: form.type,
        name: form.name,
        body_template: form.body_template,
        is_active: form.is_active ? "1" : "0",
      };
      const res = await fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        // Come il legacy: errore inline, si resta sul form coi valori postati.
        setError(String(j.error ?? "Errore configurazione."));
        setSaving(false);
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
        return;
      }
      // Redirect legacy: si resta sull'EDIT del modulo col flash verde.
      const newId = Number(j.consentModule?.id ?? form.id);
      flashNavigate(listHref(`?action=edit&id=${newId}`), { msg: "Modulo consenso salvato con successo." });
    } catch {
      setError("Errore configurazione.");
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (form.is_system || form.id <= 0 || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ module: "consent_modules", action: "delete_module", id: String(form.id) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setDeleteOpen(false);
        setDeleting(false);
        setError(String(j.error ?? "Errore configurazione."));
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
        return;
      }
      const removed = Number(j.associationCount ?? 0);
      const message = removed > 0
        ? `Modulo consenso eliminato. Rimosse anche ${removed} associazione/i non firmate dai clienti.`
        : "Modulo consenso eliminato.";
      flashNavigate(listHref(""), { msg: message });
    } catch {
      setDeleteOpen(false);
      setDeleting(false);
      setError("Errore configurazione.");
    }
  }

  // Bottone 'Apri anteprima PDF' (consent_modules.js): manda i valori CORRENTI
  // del form al renderer server e mostra il PDF nell'iframe del modale.
  async function openPreview() {
    setPreviewOpen(true);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = "";
    }
    setPreviewUrl("");
    try {
      const res = await fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          module: "consent_modules",
          action: "preview_pdf",
          id: String(form.id),
          type: form.type,
          name: form.name,
          body_template: form.body_template,
          is_active: form.is_active ? "1" : "0",
        }),
      });
      if (!res.ok) throw new Error("preview");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch {
      setPreviewOpen(false);
      setError("Errore configurazione.");
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    }
  }

  const moduleTitle = form.is_system
    ? "PDF privacy GDPR"
    : form.id > 0
      ? "Modifica modulo consenso"
      : "Nuovo modulo consenso";
  const moduleSubtitle = form.is_system
    ? "Template di sistema utilizzato per il PDF privacy generato dalla scheda cliente."
    : "Configura un modulo PDF aggiuntivo per i consensi informati dei trattamenti.";
  const typeLabel = TYPE_LABELS[form.type] ?? "Modulo consenso";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/consent_modules.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Moduli consenso</h1>
          <div className="bs-page-subtitle">
            Gestisci il modulo PDF privacy GDPR e i moduli aggiuntivi per consensi informati e firme cliente.
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={listHref()}>
              <i className="bi bi-arrow-left me-1" />
              Lista moduli
            </a>
            <a className="btn btn-primary" href={listHref("?action=new")}>
              <i className="bi bi-plus-circle me-1" />
              Nuovo modulo
            </a>
          </div>
        </div>
      </div>

      {flashMsg ? (
        <div className="alert alert-success d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flashMsg}</div>
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{error}</div>
        </div>
      ) : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="row g-3">
          <div className="col-12 col-xl-8">
            <div className="card p-3 p-lg-4">
              <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
                <div>
                  <div className="fw-semibold">{moduleTitle}</div>
                  <div className="text-muted small">{moduleSubtitle}</div>
                </div>
                <div className="d-flex gap-2 flex-wrap align-items-center">
                  <span className="badge text-bg-light border consent-module-type-badge">{typeLabel}</span>
                  {form.is_system ? (
                    <span className="badge text-bg-warning text-dark consent-module-type-badge">
                      <i className="bi bi-shield-lock me-1" />
                      Funzione di sistema
                    </span>
                  ) : null}
                </div>
              </div>

              <form method="post" id="consentModuleForm" onSubmit={onSubmit}>
                <input type="hidden" name="id" value={form.id} />
                <input type="hidden" name="type" value={form.type} />

                <div className="row g-3 mb-3">
                  <div className="col-12 col-lg-8">
                    <label className="form-label fw-semibold" htmlFor="consentModuleName">
                      Nome modulo
                    </label>
                    <input
                      className="form-control"
                      id="consentModuleName"
                      name="name"
                      required
                      readOnly={form.is_system}
                      value={form.name}
                      onChange={(e) => set("name", e.target.value)}
                    />
                  </div>
                  <div className="col-12 col-lg-4">
                    <label className="form-label fw-semibold" htmlFor="consentModuleStatus">
                      Stato
                    </label>
                    <div className="form-control d-flex align-items-center" id="consentModuleStatus">
                      {form.is_system ? (
                        <span className="text-muted">Sempre attivo</span>
                      ) : (
                        <div className="form-check form-switch m-0">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id="consentModuleActive"
                            name="is_active"
                            value="1"
                            checked={form.is_active}
                            onChange={(e) => set("is_active", e.target.checked)}
                          />
                          <label className="form-check-label ms-2" htmlFor="consentModuleActive">
                            Modulo attivo
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <label className="form-label fw-semibold" htmlFor="body_template">
                  Contenuto modulo
                </label>
                <textarea
                  className="form-control consent-template-editor"
                  id="body_template"
                  name="body_template"
                  rows={22}
                  value={form.body_template}
                  onChange={(e) => set("body_template", e.target.value)}
                />
                <div className="form-text mt-2">
                  {form.is_system ? (
                    <>Il PDF finale usera sempre il nome file <strong>GDPR_NOME_COGNOME.pdf</strong>.</>
                  ) : (
                    <>
                      Il PDF finale usera automaticamente un nome file con modulo e cliente. La sezione finale con data e
                      firma viene aggiunta dal sistema.
                    </>
                  )}
                </div>

                {!form.is_system && form.association_count > 0 ? (
                  <div className="small text-muted mt-2">
                    Questo modulo e attualmente associato a {form.association_count} cliente/i.
                  </div>
                ) : null}

                <div className="d-flex flex-wrap gap-2 mt-3">
                  <button className="btn btn-primary" disabled={saving}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva modulo
                  </button>
                  {!form.is_system && form.id > 0 ? (
                    <button className="btn btn-outline-danger js-consent-module-delete" type="button" onClick={() => setDeleteOpen(true)}>
                      <i className="bi bi-trash me-1" />
                      Elimina
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          </div>

          <div className="col-12 col-xl-4">
            <div className="card p-3 mb-3">
              <div className="fw-semibold mb-2">Chiusura automatica del PDF</div>
              <div className="small text-muted mb-2">Questa parte viene aggiunta dal sistema e non va inserita nel template:</div>
              <div className="consent-system-preview">{form.system_preview_text}</div>
            </div>

            <div className="card p-3 mb-3">
              <div className="fw-semibold mb-2">Anteprima contenuto</div>
              <div className="small text-muted mb-3">
                Apri una preview PDF del template con dati demo. La preview include anche la sezione finale automatica.
              </div>
              <button className="btn btn-outline-primary" type="button" id="openConsentTemplatePreview" onClick={openPreview}>
                <i className="bi bi-file-earmark-pdf me-1" />
                Apri anteprima PDF
              </button>
            </div>

            <div className="card p-3 mb-3">
              <div className="fw-semibold mb-2">Variabili disponibili</div>
              <div className="d-flex flex-column gap-2 small">
                {AVAILABLE_VARIABLES.map((item) => (
                  <div className="d-flex justify-content-between gap-3 border rounded p-2" key={item.variable}>
                    <code>{item.variable}</code>
                    <span className="text-muted text-end">{item.description}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-3">
              <div className="fw-semibold mb-2">Workflow cliente</div>
              <div className="small text-muted">
                Dalla pagina cliente &gt; <strong>Moduli consenso</strong>{" "}potrai associare questo modulo e gestire
                l&apos;intero flusso: stampa PDF, invio richiesta firma elettronica, upload manuale PDF firmato, invio del
                PDF ufficiale e reset della procedura.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modale anteprima PDF (consentTemplatePreviewModal) */}
      {previewOpen ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setPreviewOpen(false)}>
          <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h2 className="modal-title fs-5">Anteprima template PDF</h2>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setPreviewOpen(false)} />
              </div>
              <div className="modal-body p-0 bg-body-tertiary">
                <iframe
                  id="consentTemplatePreviewFrame"
                  name="consentTemplatePreviewFrame"
                  title="Anteprima template PDF"
                  className="consent-template-preview-frame"
                  src={previewUrl || "about:blank"}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Modale conferma eliminazione (consentModuleDeleteModal + consent_modules.js) */}
      {deleteOpen ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setDeleteOpen(false)}>
          <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h2 className="modal-title fs-5">Conferma eliminazione modulo</h2>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteOpen(false)} />
              </div>
              <div className="modal-body">
                <div className="fw-semibold mb-2" id="consentModuleDeleteTitle">
                  Eliminare il modulo &quot;{form.name.trim() || "questo modulo"}&quot;?
                </div>
                <div className="text-muted small" id="consentModuleDeleteBody">
                  {form.association_count > 0 ? (
                    <>
                      Questo modulo e associato a <strong>{form.association_count} cliente/i</strong>.<br />
                      Se prosegui, saranno rimosse le associazioni non firmate. Se esistono PDF firmati, l&apos;eliminazione verra bloccata per conservare lo storico.
                    </>
                  ) : (
                    "Questa operazione eliminera definitivamente il modulo consenso selezionato."
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={() => setDeleteOpen(false)}>
                  Annulla
                </button>
                <button type="button" className="btn btn-danger" id="consentModuleDeleteConfirm" disabled={deleting} onClick={confirmDelete}>
                  <i className="bi bi-trash me-1" />
                  Elimina definitivamente
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
