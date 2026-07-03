"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP "Moduli consenso" settings page
// (app/pages/consent_modules.php), fed by the existing DB-backed
// /api/manage/configuration?module=consent_modules.

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

// Map the consent-module "type" key (first segment of `detail`) to the label
// shown in the PHP "Tipo" badge.
const TYPE_LABELS: Record<string, string> = {
  privacy_gdpr: "PDF privacy GDPR",
  informed_consent: "Consenso informato",
  signature: "Firma cliente",
  custom: "Modulo personalizzato",
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
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return fmtDate(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function ConsentModulesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [records, setRecords] = useState<ConsentRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/manage/configuration?module=consent_modules&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setRecords(Array.isArray(j.records) ? j.records : []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [slug]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`consent_modules${suffix}`.replace("&", "?")}`;
  }

  const count = records.length;

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
            <a className="btn btn-primary" href={href("&action=new")}>
              <i className="bi bi-plus-circle me-1" />
              Nuovo modulo
            </a>
          </div>
        </div>
      </div>

      <div className="card p-3 p-lg-4">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <div>
            <div className="fw-semibold">Elenco moduli</div>
            <div className="text-muted small">
              Il modulo <strong>PDF privacy GDPR</strong> e unico, modificabile ma non eliminabile. I moduli aggiuntivi
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
                  const typeLabel = TYPE_LABELS[typeKey] ?? rec.title ?? "—";
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
                            <a
                              className="btn btn-sm btn-outline-danger"
                              href={href(`&action=delete&id=${rec.id}`)}
                            >
                              <i className="bi bi-trash me-1" />
                              Elimina
                            </a>
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

      <div className="modal fade" id="consentModuleDeleteModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title fs-5">Conferma eliminazione modulo</h2>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="fw-semibold mb-2" id="consentModuleDeleteTitle">
                Eliminare questo modulo consenso?
              </div>
              <div className="text-muted small" id="consentModuleDeleteBody">
                Questa operazione e definitiva.
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <a href="#" className="btn btn-danger" id="consentModuleDeleteConfirm">
                <i className="bi bi-trash me-1" />
                Elimina definitivamente
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
