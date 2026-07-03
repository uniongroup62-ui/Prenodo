"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP packages page CATALOG tab
// (app/pages/packages.php?tab=catalog): the package templates table
// (Pacchetto / Servizi-Prodotti / Sedi / Sedute / Prezzo / Validità / Venduti /
// Azioni). Fed by /api/manage/packages?action=catalog. Delete is a POST to
// action=catalog_delete (detaches client packages, keeps their history), the
// legacy GET ?action=catalog_delete link fell to the Tailwind fallback.

type CatalogRow = {
  id: number;
  name: string;
  isActive: boolean;
  contentsSummary: string;
  locationLabel: string;
  sessionsTotal: number;
  price: number;
  validityDays: number | null;
  soldCount: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PackagesCatalogContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=catalog`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setRows(Array.isArray(j.catalog) ? j.catalog : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  // Delete a catalog template via POST (server detaches client packages + drops
  // the template's child rows). Confirm-gated.
  async function deleteRow(r: CatalogRow) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questo pacchetto dal catalogo? I pacchetti già assegnati ai clienti rimarranno visibili (storico).")) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "catalog_delete", id: r.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare il pacchetto.");
      } else {
        load();
      }
    } finally {
      setBusyId(0);
    }
  }

  const hasAny = rows.length > 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Catalogo pacchetti</h1>
          <div className="bs-page-subtitle">Crea e gestisci i pacchetti vendibili da Pagamenti.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={page("packages&tab=clients")}>
              <i className="bi bi-people me-1" />
              Pacchetti clienti
            </a>
            <a className="btn btn-outline-secondary" href={page("package_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
            <a className="btn btn-primary" href={page("packages&tab=catalog&action=catalog_new")}>
              <i className="bi bi-plus-lg me-1" />
              Nuovo pacchetto
            </a>
          </div>
        </div>
      </div>

      {!loading && !hasAny ? (
        <div className="card border-0 shadow-sm package-empty-card">
          <div className="package-empty-state">
            <div className="package-empty-icon" aria-hidden="true">
              <i className="bi bi-boxes" />
            </div>
            <h2>Nessun pacchetto in catalogo</h2>
            <p>Crea il primo pacchetto per venderlo da Pagamenti e assegnarlo ai clienti con sedute, servizi o prodotti inclusi.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={page("packages&tab=catalog&action=catalog_new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo pacchetto
              </a>
              <a className="btn btn-outline-secondary" href={page("packages&tab=clients")}>
                <i className="bi bi-people me-1" />
                Pacchetti clienti
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Pacchetto</th>
                  <th>Servizi / Prodotti</th>
                  <th>Sedi</th>
                  <th>Sedute (tot.)</th>
                  <th>Prezzo</th>
                  <th>Validità</th>
                  <th>Venduti</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="fw-semibold">
                      {r.name}
                      {!r.isActive ? <span className="badge text-bg-secondary ms-2">Disattivo</span> : null}
                    </td>
                    <td className="text-muted">
                      <span title={r.contentsSummary}>{r.contentsSummary}</span>
                    </td>
                    <td className="text-muted">{r.locationLabel}</td>
                    <td>{r.sessionsTotal}</td>
                    <td className="text-muted">€ {fmtMoney(r.price)}</td>
                    <td className="text-muted">{r.validityDays != null ? r.validityDays : "—"}</td>
                    <td>{r.soldCount}</td>
                    <td className="text-end">
                      <a className="btn btn-sm btn-outline-secondary" href={page(`packages&tab=catalog&action=catalog_edit&id=${r.id}`)}>
                        Modifica
                      </a>{" "}
                      <button type="button" className="btn btn-sm btn-outline-danger" disabled={busyId === r.id} onClick={() => deleteRow(r)}>
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
                {loading ? (
                  <tr>
                    <td colSpan={8} className="text-muted small p-3">
                      Caricamento…
                    </td>
                  </tr>
                ) : null}
                {!loading && !hasAny ? (
                  <tr>
                    <td colSpan={8} className="text-muted p-3">
                      Nessun pacchetto in catalogo per i filtri selezionati.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
