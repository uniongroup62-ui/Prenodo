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

// Port of fmt_money(): number_format(n, 2, ',', '.').
function fmtMoney(n: number): string {
  const v = Number(n || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

export type PackagesCatalogQuery = { all_locations?: string; msg?: string; err?: string };

export function PackagesCatalogContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: PackagesCatalogQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [allLocations, setAllLocations] = useState(() =>
    ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
  );
  // Conteggio NON filtrato (empty state) + numero sedi (il filtro "Tutte le
  // sedi" esiste solo per i tenant multi-sede, come il legacy).
  const [totalCount, setTotalCount] = useState(0);
  const [locationsCount, setLocationsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);
  // Flash legacy (?msg/?err dai redirect) + esito delete in pagina.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Fetch puro (setState nei callback della Promise; loading gia' true di default).
  const fetchData = useCallback((all?: boolean) => {
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=catalog${all ? "&all_locations=1" : ""}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setRows(Array.isArray(j.catalog) ? j.catalog : []);
        setTotalCount(Number(j.totalCount ?? (Array.isArray(j.catalog) ? j.catalog.length : 0)));
        setLocationsCount(Number(j.locationsCount ?? 0));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [slug]);

  const load = useCallback((all?: boolean) => {
    setLoading(true);
    fetchData(all);
  }, [fetchData]);

  useEffect(() => {
    fetchData(["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()));
    // initialQuery è il GET del primo render: il refetch avviene solo con "Filtra".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

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
        // Flash err in pagina (redirect legacy con ?err=).
        setFlash({ err: String(j?.error || "Errore eliminazione pacchetto.") });
      } else {
        // Flash legacy "Pacchetto eliminato".
        setFlash({ msg: "Pacchetto eliminato" });
        load();
      }
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    } finally {
      setBusyId(0);
    }
  }

  // Empty state sul conteggio NON filtrato (come il legacy).
  const hasAny = totalCount > 0;
  const showLocationsFilter = locationsCount > 1;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.err}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti</h1>
          <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={page("package_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
            <a className="btn btn-outline-secondary" href={page("packages&tab=clients")}>
              <i className="bi bi-people me-1" />
              Pacchetti clienti
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
          {/* Filtro sede integrato nell'header della tabella (restyle 2026-07-15,
              stesso pattern approvato dei Buoni): via la card dedicata al solo
              checkbox — switch con auto-applicazione (micro-deviazione dal submit
              GET legacy; l'URL ?all_locations=1 resta allineato) + conteggio. */}
          <div className="card-header bg-transparent d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
            <span className="text-muted small">
              {rows.length === 1 ? "1 risultato" : `${rows.length} risultati`}
              {!allLocations && showLocationsFilter ? " nella sede corrente" : ""}
            </span>
            {showLocationsFilter ? (
              <div className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="pkgCatalogAllLocations"
                  name="all_locations"
                  value="1"
                  checked={allLocations}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setAllLocations(v);
                    if (typeof window !== "undefined") {
                      const url = new URL(window.location.href);
                      url.searchParams.delete("msg");
                      url.searchParams.delete("err");
                      if (v) url.searchParams.set("all_locations", "1");
                      else url.searchParams.delete("all_locations");
                      window.history.replaceState(null, "", url.toString());
                    }
                    load(v);
                  }}
                />
                <label className="form-check-label" htmlFor="pkgCatalogAllLocations">
                  Tutte le sedi
                </label>
              </div>
            ) : null}
          </div>
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
                {!loading && rows.length === 0 ? (
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
