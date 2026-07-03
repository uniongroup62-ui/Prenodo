"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP packages page, clients tab
// (app/pages/packages.php?tab=clients): catalogo / assegnazioni clienti / sedute
// residue. Fed by the existing DB-backed /api/manage/packages route, which
// returns { catalog, clientPackages }. With no client packages the legacy page
// renders the "package-empty-state" card (captured verbatim below).

type CatalogPackage = {
  id?: number;
  name?: string;
};

type ClientPackage = {
  id?: number;
  clientName?: string;
  client_name?: string;
  packageName?: string;
  package_name?: string;
  remaining?: number;
  remainingSessions?: number;
  total?: number;
  totalSessions?: number;
  expiresAt?: string;
  expires_at?: string;
};

type PackageState = {
  ok?: boolean;
  catalog?: CatalogPackage[];
  clientPackages?: ClientPackage[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

export function PackagesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clientPackages, setClientPackages] = useState<ClientPackage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: PackageState) => {
        setClientPackages(Array.isArray(j.clientPackages) ? j.clientPackages : []);
      })
      .catch(() => setClientPackages([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  const isEmpty = clientPackages.length === 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti</h1>
          <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={href("package_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
          </div>
        </div>
      </div>

      {isEmpty ? (
        <div className="card border-0 shadow-sm package-empty-card">
          <div className="package-empty-state">
            <div className="package-empty-icon" aria-hidden="true">
              <i className="bi bi-boxes" />
            </div>
            <h2>Nessun pacchetto cliente presente</h2>
            <p>
              I pacchetti venduti o assegnati ai clienti compariranno qui. La vendita dei pacchetti viene gestita da
              Pagamenti.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("pos")}>
                <i className="bi bi-credit-card me-1" />
                Nuova vendita
              </a>
              <a className="btn btn-outline-secondary" href={href("packages&tab=catalog")}>
                <i className="bi bi-collection me-1" />
                Catalogo
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
                  <th>Cliente</th>
                  <th>Pacchetto</th>
                  <th>Sedute residue</th>
                  <th>Scadenza</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {clientPackages.map((cp, idx) => {
                  const remaining = cp.remaining ?? cp.remainingSessions;
                  const total = cp.total ?? cp.totalSessions;
                  const sessionsLabel =
                    remaining != null
                      ? total != null
                        ? `${remaining} / ${total}`
                        : String(remaining)
                      : "—";
                  return (
                    <tr key={cp.id ?? idx}>
                      <td className="fw-semibold">{cp.clientName ?? cp.client_name ?? "—"}</td>
                      <td>{cp.packageName ?? cp.package_name ?? "—"}</td>
                      <td>{sessionsLabel}</td>
                      <td className="text-muted small">{fmtDate(cp.expiresAt ?? cp.expires_at)}</td>
                      <td className="text-end">
                        {cp.id != null ? (
                          <a className="btn btn-sm btn-primary" href={href(`packages&tab=clients&action=view&id=${cp.id}`)}>
                            Apri
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {loading ? (
                  <tr>
                    <td colSpan={5} className="text-muted small p-3">
                      Caricamento…
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
