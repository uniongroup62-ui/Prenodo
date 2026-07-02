"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP per-client "Moduli consenso" page
// (app/pages/client_consents.php, ?page=client_consents&client_id=<id>).
//
// Interamente DB-backed via /api/manage/client-gdpr: box GDPR (consensi,
// stato draft/pending/signed, Stampa/Invia firma/Invia privacy/Carica PDF/
// Reset), associazione moduli consenso attivi e azioni sui record associati
// (stampa, firma elettronica, upload manuale, invio PDF ufficiale, rimozione,
// reset) — messaggi, conferme e guard identici al legacy. Le stampe aprono le
// GET do=gdpr_print / do=consent_print in un nuovo tab (come formtarget=_blank).

type GdprState = {
  status: "draft" | "pending" | "signed";
  statusLabel: string;
  statusBadge: string;
  statusIcon: string;
  locked: boolean;
  labels: Record<string, string>;
  consents: Record<string, boolean>;
  officialDocId: number;
  requestedAtLabel: string;
  signedAtLabel: string;
  pendingPreviewUrl: string;
  publicUrl: string;
  officialDocUrl: string;
};

type ConsentRecord = {
  id: number;
  moduleId: number;
  name: string;
  typeLabel: string;
  moduleActive: boolean;
  status: "draft" | "pending" | "signed";
  statusLabel: string;
  statusBadge: string;
  statusIcon: string;
  documentId: number;
  createdLabel: string;
  updatedLabel: string;
  requestedLabel: string;
  signedLabel: string;
  pendingUrl: string;
  officialUrl: string;
};

type PageState = {
  client: { id: number; name: string; phone: string; email: string };
  gdpr: GdprState;
  records: ConsentRecord[];
  availableModules: { id: number; name: string }[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clientIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("client_id") ?? params.get("id");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Gruppi record per stato (ordine + testi del legacy).
const RECORD_GROUP_META: Record<string, { title: string; desc: string }> = {
  draft: {
    title: "Da completare",
    desc: "Moduli pronti per stampa, invio firma elettronica o caricamento manuale del PDF firmato.",
  },
  pending: {
    title: "In attesa di firma",
    desc: "Richieste di firma gia inviate al cliente. I contenuti restano bloccati fino a conferma o reset.",
  },
  signed: {
    title: "Firmati",
    desc: "Documenti conclusi e disponibili come PDF ufficiali del cliente.",
  },
};

export function ClientConsentsContent() {
  const slug = tenantSlug();
  const [clientId, setClientId] = useState(0);
  const [state, setState] = useState<PageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Consensi GDPR spuntati nella UI (editabili solo in bozza).
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [gdprFile, setGdprFile] = useState<File | null>(null);
  const [recordFiles, setRecordFiles] = useState<Record<number, File | null>>({});
  const [associateModuleId, setAssociateModuleId] = useState("");
  const [gdprFileKey, setGdprFileKey] = useState(0); // resetta l'input file dopo l'upload

  useEffect(() => {
    setClientId(clientIdFromUrl());
  }, []);

  const load = useCallback(() => {
    if (!slug || clientId <= 0) return;
    setLoading(true);
    fetch(`/api/manage/client-gdpr?slug=${encodeURIComponent(slug)}&client_id=${clientId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) {
          setErr(String(j?.error || "Cliente non trovato."));
          setState(null);
          return;
        }
        setState(j as PageState);
        setConsents({ ...(j as PageState).gdpr.consents });
      })
      .catch(() => setErr("Errore di rete durante il caricamento."))
      .finally(() => setLoading(false));
  }, [slug, clientId]);

  useEffect(() => {
    load();
  }, [load]);

  // Legacy-style relative action links (the PHP page uses index.php?page=...).
  function pageHref(path: string): string {
    return `/${encodeURIComponent(slug)}/${`${path}`.replace("&", "?")}`;
  }

  // POST verso /api/manage/client-gdpr; ritorna true se ok (per i post-step).
  async function postAction(fields: Record<string, string>, file?: { name: string; file: File }): Promise<boolean> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const fd = new FormData();
      fd.set("client_id", String(clientId));
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      if (file) fd.set(file.name, file.file);
      const res = await fetch(`/api/manage/client-gdpr?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: fd,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setErr(String(j.error ?? "Operazione non riuscita."));
        return false;
      }
      setMsg(String(j.message ?? "Operazione completata."));
      load();
      return true;
    } catch {
      setErr("Errore di rete durante il salvataggio.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // I consensi correnti come campi gdpr_consents[...] (il form legacy li invia
  // con ogni azione GDPR in bozza).
  function gdprConsentFields(): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, on] of Object.entries(consents)) {
      if (on) fields[`gdpr_consents[${key}]`] = "1";
    }
    return fields;
  }

  function gdprAction(action: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    void postAction({ _mode: "gdpr_action", gdpr_action: action, ...gdprConsentFields() });
  }

  // Stampa Privacy: come il submit legacy salva prima i consensi, poi apre il
  // PDF (do=gdpr_print) in un nuovo tab.
  async function gdprPrint() {
    const ok = await postAction({ _mode: "gdpr_action", gdpr_action: "save_consents", ...gdprConsentFields() });
    if (ok) {
      window.open(`/api/manage/client-gdpr?slug=${encodeURIComponent(slug)}&client_id=${clientId}&do=gdpr_print`, "_blank");
    }
  }

  function gdprManualUpload() {
    if (!gdprFile) {
      setErr("Seleziona il PDF firmato da caricare.");
      return;
    }
    void postAction({ _mode: "gdpr_action", gdpr_action: "manual_upload", ...gdprConsentFields() }, { name: "gdpr_signed_pdf", file: gdprFile }).then((ok) => {
      if (ok) {
        setGdprFile(null);
        setGdprFileKey((k) => k + 1);
      }
    });
  }

  function recordAction(recordId: number, action: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    void postAction({ _mode: "consent_record_action", record_id: String(recordId), record_action: action });
  }

  function recordManualUpload(recordId: number) {
    const file = recordFiles[recordId];
    if (!file) {
      setErr("Seleziona il PDF firmato da caricare.");
      return;
    }
    void postAction({ _mode: "consent_record_action", record_id: String(recordId), record_action: "manual_upload" }, { name: "signed_pdf", file }).then((ok) => {
      if (ok) setRecordFiles((m) => ({ ...m, [recordId]: null }));
    });
  }

  function recordPrint(recordId: number) {
    window.open(
      `/api/manage/client-gdpr?slug=${encodeURIComponent(slug)}&client_id=${clientId}&do=consent_print&record_id=${recordId}`,
      "_blank",
    );
  }

  function associateModule() {
    const moduleId = Number(associateModuleId);
    if (!moduleId) return;
    void postAction({ _mode: "associate_module", module_id: String(moduleId) }).then((ok) => {
      if (ok) setAssociateModuleId("");
    });
  }

  const clientName = state?.client.name ?? "";
  const phone = state?.client.phone ?? "";
  const email = state?.client.email ?? "";
  const titleSuffix = clientName ? ` - ${clientName}` : "";
  const gdpr = state?.gdpr ?? null;
  const records = state?.records ?? [];
  const availableModules = state?.availableModules ?? [];

  const recordGroups: Record<string, ConsentRecord[]> = { draft: [], pending: [], signed: [] };
  for (const record of records) recordGroups[record.status]?.push(record);

  const gdprStatusLine =
    gdpr?.status === "draft"
      ? "Stato bozza: i consensi sono modificabili e puoi stampare il documento o avviare la firma elettronica."
      : gdpr?.status === "pending"
        ? `Richiesta firma inviata${gdpr.requestedAtLabel ? ` il ${gdpr.requestedAtLabel}` : ""}. I consensi restano bloccati fino a conferma o reset.`
        : `PDF privacy ufficiale associato${gdpr?.signedAtLabel ? ` il ${gdpr.signedAtLabel}` : ""}. Per modificare i consensi usa Reset GDPR.`;

  const gdprOfficialOpenUrl = gdpr?.status === "signed" ? gdpr.publicUrl || gdpr.officialDocUrl : "";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/client_consents.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Scheda cliente</div>
          <h1 className="bs-page-title">Moduli consenso{titleSuffix}</h1>
          <div className="bs-page-subtitle">
            {loading && !state ? "—" : `${phone || "-"} - ${email || "-"}`}
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a
              className="btn btn-outline-secondary"
              href={pageHref(`clients&action=view&id=${clientId}`)}
            >
              <i className="bi bi-arrow-left me-1" />
              Scheda cliente
            </a>
            <a
              className="btn btn-outline-primary"
              href={pageHref(`clients&action=history&id=${clientId}`)}
            >
              <i className="bi bi-clock-history me-1" />
              Storico
            </a>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="consent-page-grid">
        <div className="consent-main-stack">
          <div className="card p-3 p-lg-4 consent-records-shell">
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-journal-plus me-1" />
                  Associa modulo consenso
                </div>
                <div className="text-muted small">
                  Aggiungi al cliente un modulo attivo creato in Impostazioni &gt; Moduli consenso.
                </div>
              </div>
              <a className="btn btn-sm btn-outline-primary" href={pageHref("consent_modules")}>
                <i className="bi bi-gear me-1" />
                Gestisci moduli
              </a>
            </div>

            {availableModules.length ? (
              <div className="row g-2 align-items-end">
                <div className="col-12 col-lg">
                  <label className="form-label small fw-semibold" htmlFor="consentModuleSelect">
                    Modulo
                  </label>
                  <select
                    className="form-select"
                    id="consentModuleSelect"
                    value={associateModuleId}
                    onChange={(e) => setAssociateModuleId(e.target.value)}
                  >
                    <option value="">-- seleziona modulo --</option>
                    {availableModules.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-12 col-lg-auto">
                  <button className="btn btn-primary w-100" type="button" disabled={busy || !associateModuleId} onClick={associateModule}>
                    <i className="bi bi-plus-circle me-1" />
                    Associa modulo
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-muted small">
                Nessun modulo attivo disponibile da associare: sono gia associati al cliente oppure
                non sono stati creati moduli aggiuntivi attivi.
              </div>
            )}
          </div>

          <div className="card p-3 p-lg-4 consent-records-shell">
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-files me-1" />
                  Moduli consenso associati
                </div>
                <div className="text-muted small">
                  I moduli aggiuntivi sono ordinati per stato, cosi hai subito visibili quelli da
                  completare, quelli in attesa e quelli gia firmati.
                </div>
              </div>
              <span className="badge text-bg-light border consent-count-badge">
                {records.length} modulo/i associato/i
              </span>
            </div>

            {records.length ? (
              (["draft", "pending", "signed"] as const).map((groupKey) => {
                const group = recordGroups[groupKey];
                if (!group.length) return null;
                const meta = RECORD_GROUP_META[groupKey];
                return (
                  <div className="consent-record-group" key={groupKey}>
                    <div className="consent-group-header">
                      <div>
                        <div className="consent-group-title">{meta.title}</div>
                        <div className="text-muted small">{meta.desc}</div>
                      </div>
                      <span className="badge text-bg-light border">{group.length}</span>
                    </div>

                    <div className="consent-record-list">
                      {group.map((record) => (
                        <div className={`consent-record-card is-${record.status}`} key={record.id}>
                          <div className="d-flex flex-wrap justify-content-between align-items-start gap-3">
                            <div>
                              <div className="d-flex flex-wrap align-items-center gap-2">
                                <div className="fw-semibold">{record.name}</div>
                                <span className="badge text-bg-light border">{record.typeLabel}</span>
                                {!record.moduleActive ? (
                                  <span className="badge text-bg-secondary">Modulo disattivato nel backend</span>
                                ) : null}
                              </div>
                              <div className="consent-record-note mt-1">
                                {record.status === "draft"
                                  ? "Bozza pronta: puoi stampare il PDF, inviare la richiesta di firma elettronica oppure caricare il documento firmato manualmente."
                                  : record.status === "pending"
                                    ? `Richiesta firma inviata${record.requestedLabel ? ` il ${record.requestedLabel}` : ""}. Il modulo resta bloccato fino a conferma o reset.`
                                    : `Documento firmato${record.signedLabel ? ` il ${record.signedLabel}` : ""}. Il PDF ufficiale e conservato tra i documenti protetti del cliente.`}
                              </div>
                            </div>
                            <span className={`badge text-bg-${record.statusBadge}`}>
                              <i className={`bi ${record.statusIcon} me-1`} />
                              {record.statusLabel}
                            </span>
                          </div>

                          <div className="consent-divider" />

                          <div className="row g-3 align-items-start">
                            <div className="col-12 col-xl-5">
                              <div className="consent-record-meta">
                                <span className="consent-meta-pill">
                                  <i className="bi bi-calendar2-plus" />
                                  Creato {record.createdLabel || "—"}
                                </span>
                                <span className="consent-meta-pill">
                                  <i className="bi bi-clock-history" />
                                  Ultima operazione {record.updatedLabel || "—"}
                                </span>
                                {record.status === "pending" && record.requestedLabel ? (
                                  <span className="consent-meta-pill">
                                    <i className="bi bi-envelope" />
                                    Inviato {record.requestedLabel}
                                  </span>
                                ) : null}
                                {record.status === "signed" && record.signedLabel ? (
                                  <span className="consent-meta-pill">
                                    <i className="bi bi-check2-circle" />
                                    Firmato {record.signedLabel}
                                  </span>
                                ) : null}
                              </div>

                              {record.status === "pending" && record.pendingUrl ? (
                                <a className="btn btn-outline-secondary w-100 mt-3" href={record.pendingUrl} target="_blank" rel="noopener">
                                  <i className="bi bi-box-arrow-up-right me-1" />
                                  Apri richiesta di firma
                                </a>
                              ) : null}

                              {record.status === "signed" && record.officialUrl ? (
                                <a className="btn btn-outline-secondary w-100 mt-3" href={record.officialUrl} target="_blank" rel="noopener">
                                  <i className="bi bi-box-arrow-up-right me-1" />
                                  Apri PDF ufficiale
                                </a>
                              ) : null}
                            </div>

                            <div className="col-12 col-xl-7">
                              <div className="consent-action-grid">
                                {record.status === "draft" ? (
                                  <>
                                    <button className="btn btn-outline-primary" type="button" disabled={busy} onClick={() => recordPrint(record.id)}>
                                      <i className="bi bi-printer me-1" />
                                      Stampa PDF
                                    </button>
                                    <button
                                      className="btn btn-outline-primary"
                                      type="button"
                                      disabled={busy}
                                      onClick={() =>
                                        recordAction(record.id, "send_signature", "Inviare la richiesta di firma elettronica al cliente?")
                                      }
                                    >
                                      <i className="bi bi-pen me-1" />
                                      Invia Firma Elettronica
                                    </button>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-send me-1" />
                                      Invia PDF firmato
                                    </button>
                                    <button
                                      className="btn btn-outline-danger"
                                      type="button"
                                      disabled={busy}
                                      onClick={() => recordAction(record.id, "remove", "Rimuovere questo modulo dalla scheda cliente?")}
                                    >
                                      <i className="bi bi-x-circle me-1" />
                                      Rimuovi
                                    </button>
                                  </>
                                ) : record.status === "pending" ? (
                                  <>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-printer me-1" />
                                      Stampa PDF
                                    </button>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-pen me-1" />
                                      Invia Firma Elettronica
                                    </button>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-send me-1" />
                                      Invia PDF firmato
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-printer me-1" />
                                      Stampa PDF
                                    </button>
                                    <button className="btn btn-outline-secondary" type="button" disabled>
                                      <i className="bi bi-pen me-1" />
                                      Invia Firma Elettronica
                                    </button>
                                    <button className="btn btn-outline-primary" type="button" disabled={busy} onClick={() => recordAction(record.id, "send_pdf")}>
                                      <i className="bi bi-send me-1" />
                                      Invia PDF firmato
                                    </button>
                                  </>
                                )}
                              </div>

                              {record.status === "draft" ? (
                                <div className="consent-upload-box mt-3">
                                  <div className="fw-semibold small mb-2">Carica il PDF firmato manualmente</div>
                                  <input
                                    className="form-control mb-2"
                                    type="file"
                                    accept="application/pdf"
                                    onChange={(e) =>
                                      setRecordFiles((m) => ({ ...m, [record.id]: e.target.files?.[0] ?? null }))
                                    }
                                  />
                                  <button className="btn btn-outline-secondary w-100" type="button" disabled={busy} onClick={() => recordManualUpload(record.id)}>
                                    <i className="bi bi-upload me-1" />
                                    Carica PDF firmato
                                  </button>
                                </div>
                              ) : null}

                              {record.status === "pending" || record.status === "signed" ? (
                                <button
                                  className="btn btn-outline-danger w-100 mt-3"
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    recordAction(
                                      record.id,
                                      "reset",
                                      "Eseguire il reset del modulo? Il PDF firmato precedente restera conservato nei documenti cliente e la procedura tornera in bozza.",
                                    )
                                  }
                                >
                                  <i className="bi bi-arrow-counterclockwise me-1" />
                                  Reset modulo
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="consent-empty-state">
                <div className="fs-5 mb-2">
                  <i className="bi bi-journal-plus" />
                </div>
                <div className="fw-semibold mb-1">Nessun modulo consenso aggiuntivo associato</div>
                <div>Usa il riquadro in alto per associare un modulo attivo creato nel backend.</div>
              </div>
            )}
          </div>
        </div>

        <div className="consent-side-stack">
          <div className="card p-3 p-lg-4 gdpr-card consent-overview-card">
            <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
              <div>
                <div className="fw-semibold">
                  <i className="bi bi-shield-check me-1" />
                  GDPR
                </div>
                <div className="text-muted small">
                  Le spunte selezionate compilano automaticamente la sezione consenso del PDF privacy.
                </div>
              </div>
              <span className={`badge text-bg-${gdpr?.statusBadge ?? "secondary"}`}>
                <i className={`bi ${gdpr?.statusIcon ?? "bi-file-earmark-text"} me-1`} />
                {gdpr?.statusLabel ?? "Bozza"}
              </span>
            </div>

            <div className="gdpr-box">
              <div className="gdpr-checklist">
                {Object.entries(gdpr?.labels ?? {}).map(([key, label]) => (
                  <label className={`gdpr-check-item${gdpr?.locked ? " is-locked" : ""}`} key={key}>
                    <input
                      className="form-check-input"
                      type="checkbox"
                      checked={Boolean(consents[key])}
                      disabled={Boolean(gdpr?.locked) || busy}
                      onChange={(e) => setConsents((c) => ({ ...c, [key]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              {gdpr && !gdpr.locked ? (
                <div className="mt-2">
                  <button className="btn btn-sm btn-outline-secondary" type="button" disabled={busy} onClick={() => gdprAction("save_consents")}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva consensi
                  </button>
                </div>
              ) : null}

              <div className="small text-muted mt-3 consent-status-line">{gdpr ? gdprStatusLine : "—"}</div>

              <div className="d-grid gap-2 mt-3">
                {gdpr?.status === "draft" ? (
                  <>
                    <button className="btn btn-gdpr-outline" type="button" disabled={busy} onClick={() => void gdprPrint()}>
                      <i className="bi bi-printer me-1" />
                      Stampa Privacy
                    </button>
                    <button
                      className="btn btn-gdpr-outline"
                      type="button"
                      disabled={busy}
                      onClick={() => gdprAction("send_signature", "Inviare la richiesta di firma elettronica al cliente?")}
                    >
                      <i className="bi bi-pen me-1" />
                      Invia Firma Elettronica
                    </button>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-send me-1" />
                      Invia Privacy
                    </button>
                  </>
                ) : gdpr?.status === "pending" ? (
                  <>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-printer me-1" />
                      Stampa Privacy
                    </button>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-pen me-1" />
                      Invia Firma Elettronica
                    </button>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-send me-1" />
                      Invia Privacy
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-printer me-1" />
                      Stampa Privacy
                    </button>
                    <button className="btn btn-gdpr-outline" type="button" disabled>
                      <i className="bi bi-pen me-1" />
                      Invia Firma Elettronica
                    </button>
                    {gdpr && gdpr.officialDocId > 0 ? (
                      <button className="btn btn-gdpr-outline" type="button" disabled={busy} onClick={() => gdprAction("send_privacy")}>
                        <i className="bi bi-send me-1" />
                        Invia Privacy
                      </button>
                    ) : (
                      <button className="btn btn-gdpr-outline" type="button" disabled>
                        <i className="bi bi-send me-1" />
                        Invia Privacy
                      </button>
                    )}
                  </>
                )}
              </div>

              {gdpr?.status === "draft" ? (
                <div className="gdpr-upload-box mt-3">
                  <div className="fw-semibold small mb-2">Carica il PDF firmato manualmente</div>
                  <input
                    key={gdprFileKey}
                    className="form-control mb-2"
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setGdprFile(e.target.files?.[0] ?? null)}
                  />
                  <button className="btn btn-outline-secondary w-100" type="button" disabled={busy} onClick={gdprManualUpload}>
                    <i className="bi bi-upload me-1" />
                    Carica PDF firmato
                  </button>
                </div>
              ) : null}

              {gdpr?.status === "pending" && gdpr.pendingPreviewUrl ? (
                <a className="btn btn-outline-secondary w-100 mt-3" href={gdpr.pendingPreviewUrl} target="_blank" rel="noopener">
                  <i className="bi bi-box-arrow-up-right me-1" />
                  Apri richiesta di firma
                </a>
              ) : null}

              {gdpr?.status === "signed" && gdprOfficialOpenUrl ? (
                <a className="btn btn-outline-secondary w-100 mt-3" href={gdprOfficialOpenUrl} target="_blank" rel="noopener">
                  <i className="bi bi-box-arrow-up-right me-1" />
                  Apri PDF ufficiale
                </a>
              ) : null}

              {gdpr && (gdpr.status === "pending" || gdpr.status === "signed") ? (
                <button
                  className="btn btn-outline-danger w-100 mt-3"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    gdprAction(
                      "reset",
                      "Eseguire il reset GDPR? Il PDF firmato precedente restera conservato nei documenti cliente e i consensi torneranno modificabili.",
                    )
                  }
                >
                  <i className="bi bi-arrow-counterclockwise me-1" />
                  Reset GDPR
                </button>
              ) : null}
            </div>
          </div>

          <div className="card p-3 p-lg-4 consent-quick-card">
            <div className="fw-semibold mb-2">
              <i className="bi bi-lightbulb me-1" />
              Flusso suggerito
            </div>
            <ol className="consent-summary-list">
              <li>Verifica il modulo associato al cliente e controlla che il contenuto sia corretto.</li>
              <li>
                Scegli se stampare il PDF e caricarlo firmato manualmente oppure inviare la firma
                elettronica.
              </li>
              <li>
                Quando il documento e firmato, apri o invia il PDF ufficiale e, se serve, usa Reset
                per ricominciare la procedura.
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
