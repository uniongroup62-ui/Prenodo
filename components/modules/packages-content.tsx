"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Faithful port of the PHP packages page, CLIENTS tab (packages.php tab=clients
// action=list): filtri Cliente/Pacchetto (combobox ricercabili "Tutti") + Stato
// + [Tutte le sedi] + Filtra, tabella 9 colonne (Cliente linkato, Pacchetto,
// Sede, Contenuto, Rimanenti, Totali, Scadenza, Stato badge, Dettagli/Modifica),
// header actions gated dai permessi, empty state e flash ?msg/?err verbatim.

type Row = {
  id: number;
  clientId: number;
  clientName: string;
  packageName: string;
  locationLabel: string;
  contentSummary: string;
  sessionsRemaining: number;
  sessionsTotal: number;
  expiresAt: string;
  statusLabel: string;
  statusBadge: string;
};

type Perms = {
  packagesClients?: boolean;
  packagesCatalog?: boolean;
  packagesSettings?: boolean;
  posManage?: boolean;
  clientLinks?: boolean;
};

export type PackagesQuery = {
  client_id?: string;
  package_name?: string;
  status?: string;
  all_locations?: string;
  msg?: string;
  err?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Combobox legacy (app-combobox): bottone + ricerca + lista, valore su hidden state.
function PkgCombobox({
  options,
  value,
  placeholder,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const selected = options.find((o) => o.id === value);
  const needle = search.trim().toLowerCase();
  const list = needle === "" ? options : options.filter((o) => o.label.toLowerCase().includes(needle));
  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <span className="app-combobox-text">{selected.label}</span>
        ) : (
          <span className="text-muted app-combobox-placeholder">{placeholder}</span>
        )}
      </button>
      <div className={`dropdown-menu p-2 w-100 ${open ? "show" : ""}`}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="app-combobox-list mt-2" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          <button
            type="button"
            className="list-group-item list-group-item-action"
            onClick={() => {
              onChange("");
              setOpen(false);
              setSearch("");
            }}
          >
            {placeholder}
          </button>
          {list.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`list-group-item list-group-item-action ${o.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
                setSearch("");
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PackagesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: PackagesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [rows, setRows] = useState<Row[]>([]);
  const [clients, setClients] = useState<Array<{ id: string; label: string }>>([]);
  const [packageNames, setPackageNames] = useState<Array<{ id: string; label: string }>>([]);
  const [hasAny, setHasAny] = useState(true);
  const [locationsCount, setLocationsCount] = useState(0);
  const [perms, setPerms] = useState<Perms>({});
  const [loading, setLoading] = useState(true);
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Filtri (draft applicati con "Filtra", come il form GET legacy).
  const [clientId, setClientId] = useState(() => initialQuery?.client_id ?? "");
  const [packageName, setPackageName] = useState(() => initialQuery?.package_name ?? "");
  const [status, setStatus] = useState(() => {
    const s = String(initialQuery?.status ?? "active").toLowerCase();
    return ["active", "completed", "expired", "canceled", "all"].includes(s) ? s : "active";
  });
  const [allLocations, setAllLocations] = useState(() =>
    ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
  );
  // Filtri APPLICATI (≠ bozza nei campi): guidano il Reset condizionale e il
  // '· filtri attivi' (restyle 2026-07-15); default = stato 'active' e nessun
  // cliente/pacchetto/sede.
  const [appliedView, setAppliedView] = useState<{ clientId: string; packageName: string; status: string; allLocations: boolean }>(() => ({
    clientId: initialQuery?.client_id ?? "",
    packageName: initialQuery?.package_name ?? "",
    status: ["active", "completed", "expired", "canceled", "all"].includes(String(initialQuery?.status ?? "active").toLowerCase())
      ? String(initialQuery?.status ?? "active").toLowerCase()
      : "active",
    allLocations: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
  }));
  const filtersActive =
    appliedView.clientId !== "" || appliedView.packageName !== "" || appliedView.status !== "active" || appliedView.allLocations;

  // Fetch puro (setState nei callback della Promise; loading gia' true di default).
  const fetchData = useCallback(
    (f: { clientId: string; packageName: string; status: string; allLocations: boolean }) => {
      const qs = new URLSearchParams({ slug, action: "client_list", status: f.status });
      if (f.clientId !== "") qs.set("client_id", f.clientId);
      if (f.packageName !== "") qs.set("package_name", f.packageName);
      if (f.allLocations) qs.set("all_locations", "1");
      fetch(`/api/manage/packages?${qs.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j) => {
          setRows(Array.isArray(j.clientPackages) ? j.clientPackages : []);
          setClients((j.clients ?? []).map((c: { id: number; label: string }) => ({ id: String(c.id), label: c.label })));
          setPackageNames((j.packageNames ?? []).map((n: string) => ({ id: n, label: n })));
          setHasAny(Boolean(j.hasAnyClientPackages));
          setLocationsCount(Number(j.locationsCount ?? 0));
          if (j.perms) setPerms(j.perms as Perms);
        })
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    fetchData({
      clientId: initialQuery?.client_id ?? "",
      packageName: initialQuery?.package_name ?? "",
      status: ["active", "completed", "expired", "canceled", "all"].includes(String(initialQuery?.status ?? "active").toLowerCase())
        ? String(initialQuery?.status ?? "active").toLowerCase()
        : "active",
      allLocations: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
    });
    // initialQuery è il GET del primo render: il refetch avviene solo con "Filtra".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  function applyFilters() {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("msg");
      url.searchParams.delete("err");
      url.searchParams.set("tab", "clients");
      if (clientId !== "") url.searchParams.set("client_id", clientId);
      else url.searchParams.delete("client_id");
      if (packageName !== "") url.searchParams.set("package_name", packageName);
      else url.searchParams.delete("package_name");
      url.searchParams.set("status", status);
      if (allLocations) url.searchParams.set("all_locations", "1");
      else url.searchParams.delete("all_locations");
      window.history.replaceState(null, "", url.toString());
    }
    setLoading(true);
    // Aggiornato QUI (event handler) e non in fetchData: un setState sincrono
    // nell'effect di mount violerebbe react-hooks/set-state-in-effect.
    setAppliedView({ clientId, packageName, status, allLocations });
    fetchData({ clientId, packageName, status, allLocations });
  }

  const showEmptyState = !loading && !hasAny;
  const showAllLocationsFilter = locationsCount > 1;

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
            {perms.packagesSettings !== false ? (
              <a className="btn btn-outline-secondary" href={href("package_settings")}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            ) : null}
            {perms.packagesCatalog !== false && !showEmptyState ? (
              <a className="btn btn-outline-secondary" href={href("packages&tab=catalog")}>
                <i className="bi bi-collection me-1" />
                Catalogo
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {showEmptyState ? (
        <div className="card border-0 shadow-sm package-empty-card">
          <div className="package-empty-state">
            <div className="package-empty-icon" aria-hidden="true">
              <i className="bi bi-boxes" />
            </div>
            <h2>Nessun pacchetto cliente presente</h2>
            <p>I pacchetti venduti o assegnati ai clienti compariranno qui. La vendita dei pacchetti viene gestita da Pagamenti.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              {perms.posManage !== false ? (
                <a className="btn btn-primary" href={href("pos")}>
                  <i className="bi bi-credit-card me-1" />
                  Nuova vendita
                </a>
              ) : null}
              {perms.packagesCatalog !== false ? (
                <a className="btn btn-outline-secondary" href={href("packages&tab=catalog")}>
                  <i className="bi bi-collection me-1" />
                  Catalogo
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
            >
              <div className="col-lg-3">
                <label className="form-label">Cliente</label>
                <PkgCombobox options={clients} value={clientId} placeholder="Tutti" onChange={setClientId} />
              </div>

              <div className="col-lg-3">
                <label className="form-label">Pacchetto</label>
                <PkgCombobox options={packageNames} value={packageName} placeholder="Tutti" onChange={setPackageName} />
              </div>

              <div className="col-lg-2">
                <label className="form-label">Stato</label>
                <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Attivi</option>
                  <option value="completed">Completati</option>
                  <option value="expired">Scaduti</option>
                  <option value="canceled">Annullati</option>
                  <option value="all">Tutti</option>
                </select>
              </div>

              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Filtra pieno a larghezza naturale, Reset
                  (prima assente) visibile solo con filtri non-default. */}
              {showAllLocationsFilter ? (
                <div className="col-12 col-lg-auto d-flex align-items-end">
                  <div className="form-check form-switch pb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="clientPackagesAllLocations"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="clientPackagesAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                </div>
              ) : null}

              {/* col-auto: il bottone si accoda ai campi (leggero distacco ms-lg-2)
                  invece di galleggiare in una colonna fissa di griglia. */}
              <div className="col-12 col-lg-auto d-flex align-items-end gap-2 ms-lg-2">
                <button className="btn btn-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {filtersActive ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={href("packages&tab=clients")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header bg-transparent py-2">
              <span className="text-muted small">
                {loading ? "Caricamento…" : rows.length === 1 ? "1 pacchetto" : `${rows.length} pacchetti`}
                {!loading && filtersActive ? " · filtri attivi" : ""}
              </span>
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Pacchetto</th>
                    <th>Sede</th>
                    <th>Contenuto</th>
                    <th>Rimanenti</th>
                    <th>Totali</th>
                    <th>Scadenza</th>
                    <th>Stato</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessun pacchetto trovato con i filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {perms.clientLinks !== false ? (
                            <a href={href(`clients&action=view&id=${row.clientId}`)} className="fw-semibold text-decoration-none">
                              {row.clientName}
                            </a>
                          ) : (
                            <span className="fw-semibold">{row.clientName}</span>
                          )}
                        </td>
                        <td className="fw-semibold">{row.packageName}</td>
                        <td className="text-muted">{row.locationLabel}</td>
                        <td className="text-muted">
                          <span title={row.contentSummary}>{row.contentSummary}</span>
                        </td>
                        <td className="fw-semibold">{row.sessionsRemaining}</td>
                        <td className="text-muted">{row.sessionsTotal}</td>
                        <td className="text-muted">{row.expiresAt !== "" ? row.expiresAt : "—"}</td>
                        <td>
                          <span className={`badge text-bg-${row.statusBadge}`}>{row.statusLabel}</span>
                        </td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-primary" href={href(`packages&tab=clients&action=client_view&id=${row.id}`)}>
                            <i className="bi bi-eye me-1" />
                            Dettagli
                          </a>{" "}
                          <a className="btn btn-sm btn-outline-secondary" href={href(`packages&tab=clients&action=client_edit&id=${row.id}`)}>
                            <i className="bi bi-pencil me-1" />
                            Modifica
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
