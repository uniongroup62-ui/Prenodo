"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP consent-module NEW / EDIT editor
// (app/pages/consent_modules.php, action=new|edit). The core form mirrors the
// legacy markup:
//   - Nome modulo (name; readonly on the system PDF privacy GDPR module)
//   - Stato (is_active switch; the system module is "Sempre attivo")
//   - Contenuto modulo (body_template textarea)
//   - hidden type (privacy_gdpr for the system module, else informed_consent)
// Submits to /api/manage/configuration?module=consent_modules (action=save_module;
// create when id=0, update with id). System module stays type=privacy_gdpr,
// active, and is not deletable.
//
// TODO: the legacy editor also offers a server-rendered PDF PREVIEW (preview=pdf
// into an <iframe>), the "Chiusura automatica del PDF" footer preview, and the
// "Variabili disponibili" reference panel. Those depend on the PHP PDF generator
// (consent_module_system_preview_text / privacy PDF) which is not part of this
// migration slice, so the right-column preview/variables widgets are not ported.

const TYPE_LABELS: Record<string, string> = {
  privacy_gdpr: "PDF privacy GDPR",
  informed_consent: "Consenso informato",
};

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

type ConsentForm = {
  id: number;
  name: string;
  type: string;
  body_template: string;
  is_active: boolean;
  is_system: boolean;
  association_count: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): ConsentForm {
  return {
    id: 0,
    name: "",
    type: "informed_consent",
    body_template: DEFAULT_INFORMED_TEMPLATE,
    is_active: true,
    is_system: false,
    association_count: 0,
  };
}

export function ConsentModuleFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [form, setForm] = useState<ConsentForm>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
          });
        })
        .catch(() => setError("Errore nel caricamento del modulo."))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [slug]);

  function set<K extends keyof ConsentForm>(key: K, value: ConsentForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/consent_modules`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!form.is_system && form.name.trim() === "") {
      setError("Inserisci il nome del modulo.");
      return;
    }
    if (form.body_template.trim() === "") {
      setError("Il template del modulo non puo essere vuoto.");
      return;
    }

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
        setError(String(j.error ?? "Errore nel salvataggio del modulo."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio del modulo.");
      setSaving(false);
    }
  }

  async function onDelete() {
    if (form.is_system || form.id <= 0) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questo modulo consenso? Questa operazione e definitiva.")) return;
    setError("");
    try {
      const res = await fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ module: "consent_modules", action: "delete_module", id: String(form.id) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nell'eliminazione del modulo."));
        return;
      }
      backToList();
    } catch {
      setError("Errore nell'eliminazione del modulo.");
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
          <h1 className="bs-page-title">{moduleTitle}</h1>
          <div className="bs-page-subtitle">{moduleSubtitle}</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/consent_modules`}>
            <i className="bi bi-arrow-left me-1" />
            Lista moduli
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

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
                  <button className="btn btn-primary" type="submit" disabled={saving}>
                    <i className="bi bi-check2-circle me-1" />
                    {saving ? "Salvataggio…" : "Salva modulo"}
                  </button>
                  {!form.is_system && form.id > 0 ? (
                    <button className="btn btn-outline-danger" type="button" onClick={onDelete}>
                      <i className="bi bi-trash me-1" />
                      Elimina
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          </div>

          <div className="col-12 col-xl-4">
            <div className="card p-3">
              <div className="fw-semibold mb-2">Workflow cliente</div>
              <div className="small text-muted">
                Dalla pagina cliente &gt; <strong>Moduli consenso</strong> potrai associare questo modulo e gestire
                l&apos;intero flusso: stampa PDF, invio richiesta firma elettronica, upload manuale PDF firmato, invio del
                PDF ufficiale e reset della procedura.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
