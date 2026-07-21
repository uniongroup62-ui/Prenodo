"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";
import { useTakenFlash } from "./flash";

// Faithful port of the PHP "Moduli consenso" settings page
// (app/pages/consent_modules.php + assets/js/pages/consent_modules.js), fed by
// the DB-backed /api/manage/configuration?module=consent_modules: flash legacy
// (?msg/?err sotto il page header), 'Associato a N cliente/i', e il MODALE di
// conferma eliminazione legacy (titolo col nome modulo, body diverso con/senza
// associazioni, 'Elimina definitivamente').

type ConsentRecord = {
  id: number;
  module?: string;
  title?: string;
  detail?: string;
  value?: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// consent_module_type_label (ConsentModules.php): due tipi legacy.
const TYPE_LABELS: Record<string, string> = {
  privacy_gdpr: "PDF privacy GDPR",
  informed_consent: "Consenso informato",
};

// The system module ("PDF privacy GDPR") is unique, editable but not deletable.
const SYSTEM_TYPE = "privacy_gdpr";

function parseDetail(detail?: string): { typeKey: string; slug: string } {
  if (!detail) return { typeKey: "", slug: "" };
  const parts = detail.split("/").map((p) => p.trim());
  return { typeKey: parts[0] ?? "", slug: parts[1] ?? "" };
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = String(iso).slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  return fmtDate(iso);
}

type Flash = { text: string; type: "success" | "danger" };

export function ConsentModulesContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string; err?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [records, setRecords] = useState<ConsentRecord[]>([]);
  const [associationCounts, setAssociationCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<Flash | null>(() => {
    if (initialQuery?.err) return { text: String(initialQuery.err), type: "danger" };
    if (initialQuery?.msg) return { text: String(initialQuery.msg), type: "success" };
    return null;
  });
  useTakenFlash((f) => {
    if (f.err) setFlash({ text: f.err, type: "danger" });
    else if (f.msg) setFlash({ text: f.msg, type: "success" });
  });
  // Modale conferma eliminazione (consent_modules.js): record in eliminazione.
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; associationCount: number } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    return fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setRecords(Array.isArray(j.records) ? j.records : []);
        setAssociationCounts(j.associationCounts && typeof j.associationCounts === "object" ? j.associationCounts : {});
      })
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`consent_modules${suffix}`.replace("&", "?")}`;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ module: "consent_modules", action: "delete_module", id: String(deleteTarget.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setFlash({ text: String(j.error ?? "Errore configurazione."), type: "danger" });
      } else {
        // Flash del redirect legacy (consent_modules.php 127-131).
        const removed = Number(j.associationCount ?? 0);
        setFlash({
          text: removed > 0
            ? `Modulo consenso eliminato. Rimosse anche ${removed} associazione/i non firmate dai clienti.`
            : "Modulo consenso eliminato.",
          type: "success",
        });
        await load();
      }
    } catch {
      setFlash({ text: "Errore configurazione.", type: "danger" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    }
  }

  const count = records.length;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/consent_modules.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Moduli consenso</h1>
            <InfoBox>
              <p>I moduli consenso sono i documenti che i clienti firmano (in negozio o dal portale cliente).</p>
              <ul>
                <li>
                  Il modulo <strong>Privacy (GDPR)</strong> è di sistema: sempre attivo, non modificabile né eliminabile.
                </li>
                <li>
                  Un modulo con consensi <strong>già firmati</strong> non può essere eliminato: lo storico delle firme va
                  conservato.
                </li>
                <li>I consensi raccolti per ciascun cliente si consultano dalla sua scheda, sezione Consensi.</li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">
            Gestisci il modulo PDF privacy GDPR e i moduli aggiuntivi per consensi informati e firme cliente.
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-primary" href={href("&action=new")}>
              <i className="bi bi-plus-circle me-1" />
              Nuovo modulo
            </a>
          </div>
        </div>
      </div>

      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="card p-3 p-lg-4">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <div>
            <div className="fw-semibold">Elenco moduli</div>
            <div className="text-muted small">
              Il modulo <strong>PDF privacy GDPR</strong>{" "}e unico, modificabile ma non eliminabile. I moduli aggiuntivi
              possono essere associati ai clienti dalla pagina cliente &gt; Moduli consenso.
            </div>
          </div>
          <span className="badge text-bg-light border">{count} modulo/i</span>
        </div>

        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Stato</th>
                <th>Data creazione</th>
                <th>Ultima modifica</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted small p-3">
                    {loading ? "Caricamento…" : "Nessun modulo."}
                  </td>
                </tr>
              ) : (
                records.map((rec) => {
                  const { typeKey, slug: moduleSlug } = parseDetail(rec.detail);
                  const isSystem = typeKey === SYSTEM_TYPE;
                  const typeLabel = TYPE_LABELS[typeKey] ?? "Modulo consenso";
                  const associationCount = isSystem ? 0 : Number(associationCounts[String(rec.id)] ?? 0);
                  return (
                    <tr key={rec.id}>
                      <td>
                        <div className="fw-semibold d-flex flex-wrap gap-2 align-items-center">
                          <span>{rec.title ?? "—"}</span>
                          {isSystem ? (
                            <span className="badge text-bg-warning text-dark consent-module-type-badge">
                              modulo di sistema
                            </span>
                          ) : null}
                        </div>
                        <div className="text-muted small">Slug: {moduleSlug || "—"}</div>
                        {!isSystem && associationCount > 0 ? (
                          <div className="text-muted small">Associato a {associationCount} cliente/i</div>
                        ) : null}
                      </td>
                      <td>
                        <span className="badge text-bg-light border consent-module-type-badge">{typeLabel}</span>
                      </td>
                      <td>
                        {rec.active ? (
                          <span className="badge text-bg-success">Attivo</span>
                        ) : (
                          <span className="badge text-bg-secondary">Disattivo</span>
                        )}
                      </td>
                      <td>{fmtDate(rec.createdAt)}</td>
                      <td>{fmtDateTime(rec.updatedAt)}</td>
                      <td className="text-end">
                        <div className="d-flex gap-2 justify-content-end flex-wrap">
                          <a className="btn btn-sm btn-outline-primary" href={href(`&action=edit&id=${rec.id}`)}>
                            <i className="bi bi-pencil-square me-1" />
                            Modifica
                          </a>
                          {isSystem ? (
                            <button className="btn btn-sm btn-outline-secondary" type="button" disabled>
                              Protetto
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm btn-outline-danger js-consent-module-delete"
                              type="button"
                              onClick={() => setDeleteTarget({ id: rec.id, name: String(rec.title ?? "questo modulo").trim(), associationCount })}
                            >
                              <i className="bi bi-trash me-1" />
                              Elimina
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modale conferma eliminazione (consentModuleDeleteModal + consent_modules.js) */}
      {deleteTarget ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setDeleteTarget(null)}>
          <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h2 className="modal-title fs-5">Conferma eliminazione modulo</h2>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteTarget(null)} />
              </div>
              <div className="modal-body">
                <div className="fw-semibold mb-2" id="consentModuleDeleteTitle">
                  Eliminare il modulo &quot;{deleteTarget.name}&quot;?
                </div>
                <div className="text-muted small" id="consentModuleDeleteBody">
                  {deleteTarget.associationCount > 0 ? (
                    <>
                      Questo modulo e associato a <strong>{deleteTarget.associationCount} cliente/i</strong>.<br />
                      Se prosegui, saranno rimosse le associazioni non firmate. Se esistono PDF firmati, l&apos;eliminazione verra bloccata per conservare lo storico.
                    </>
                  ) : (
                    "Questa operazione eliminera definitivamente il modulo consenso selezionato."
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={() => setDeleteTarget(null)}>
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
