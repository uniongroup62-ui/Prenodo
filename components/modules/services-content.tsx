"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP services list page (app/pages/services.php, tab=services),
// fed by the existing DB-backed /api/manage/services route.

type Service = {
  id: number;
  name: string;
  durationMin?: number;
  duration?: string;
  priceValue?: number;
  price?: string;
  categoryId?: number | null;
  categoryName?: string;
  categoryImageUrl?: string;
  cabinId?: number | null;
  cabinIds?: number[];
  locationIds?: number[];
  isActive?: boolean;
  active?: boolean;
};

type Category = {
  id: number;
  name: string;
  imageUrl?: string;
  sortOrder?: number;
};

type Location = { id: number; name: string; isActive?: boolean };
type Cabin = { id: number; name: string; isActive?: boolean; locationId?: number };

type FilterItem = { id: string; label: string; meta?: string; search?: string };

type ServicesData = {
  ok?: boolean;
  services?: Service[];
  categories?: Category[];
  locations?: Location[];
  cabins?: Cabin[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(value?: number): string {
  const n = Number.isFinite(value) ? Number(value) : 0;
  // PHP: number_format($n, 2, ',', '.')
  return n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Group = {
  id: number | null;
  label: string;
  image: string;
  items: Service[];
};

export function ServicesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [data, setData] = useState<ServicesData>({});
  const [loading, setLoading] = useState(true);
  const [filterId, setFilterId] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServicesData) => setData(j ?? {}))
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function listHref(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`services${suffix}`.replace("&", "?")}`;
  }

  const services = useMemo(() => data.services ?? [], [data.services]);
  const categories = useMemo(() => data.categories ?? [], [data.categories]);
  const locations = useMemo(() => data.locations ?? [], [data.locations]);
  const cabins = useMemo(() => data.cabins ?? [], [data.cabins]);

  const locationName = useCallback(
    (id: number) => locations.find((l) => Number(l.id) === Number(id))?.name ?? "",
    [locations],
  );
  const cabinName = useCallback(
    (id: number) => cabins.find((c) => Number(c.id) === Number(id))?.name ?? "",
    [cabins],
  );

  // "Sedi" column: PHP shows "Tutte" when a service is linked to all locations (or none),
  // otherwise the comma-joined location names.
  const sedi = useCallback(
    (svc: Service): string => {
      const ids = (svc.locationIds ?? []).map(Number).filter((n) => n > 0);
      if (ids.length === 0) return "Tutte";
      const allIds = locations.map((l) => Number(l.id)).sort((a, b) => a - b);
      const sorted = [...ids].sort((a, b) => a - b);
      if (allIds.length > 0 && sorted.length === allIds.length && sorted.every((v, i) => v === allIds[i])) {
        return "Tutte";
      }
      const names = ids.map(locationName).filter(Boolean);
      return names.length ? names.join(", ") : "Nessuna sede";
    },
    [locations, locationName],
  );

  // "Cabine" column: comma-joined cabin names.
  const cabine = useCallback(
    (svc: Service): string => {
      const ids = (svc.cabinIds ?? (svc.cabinId ? [svc.cabinId] : [])).map(Number).filter((n) => n > 0);
      const names = ids.map(cabinName).filter(Boolean);
      return names.join(", ");
    },
    [cabinName],
  );

  // Apply the single-service filter (combobox) on the client.
  const filtered = useMemo(() => {
    if (!filterId) return services;
    return services.filter((s) => String(s.id) === filterId);
  }, [services, filterId]);

  // Group services by category, preserving category order.
  const grouped = useMemo<Group[]>(() => {
    const byCat = new Map<string, Group>();
    const catOrder = [...categories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const cat of catOrder) {
      byCat.set(String(cat.id), { id: cat.id, label: cat.name, image: cat.imageUrl ?? "", items: [] });
    }
    for (const svc of filtered) {
      const key = svc.categoryId != null ? String(svc.categoryId) : "__none";
      let g = byCat.get(key);
      if (!g) {
        g = {
          id: svc.categoryId ?? null,
          label: svc.categoryName ?? "Senza categoria",
          image: svc.categoryImageUrl ?? "",
          items: [],
        };
        byCat.set(key, g);
      }
      g.items.push(svc);
    }
    return Array.from(byCat.values()).filter((g) => g.items.length > 0);
  }, [filtered, categories]);

  const filterItems: FilterItem[] = useMemo(
    () =>
      services.map((s) => ({
        id: String(s.id),
        label: s.name,
        meta: s.categoryName ?? "",
        search: `${s.name} ${s.categoryName ?? ""}`.trim(),
      })),
    [services],
  );

  const initialEmpty = !loading && services.length === 0;
  const noResults = !loading && services.length > 0 && filtered.length === 0;
  const selectedLabel = filterId ? filterItems.find((i) => i.id === filterId)?.label ?? "" : "";

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Servizi</h1>
          <div className="bs-page-subtitle">Gestisci catalogo, durata, prezzo e disponibilita online.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-primary btn-pill" href={listHref("&action=new")}>
            <i className="bi bi-plus-lg me-1" />
            Nuovo servizio
          </a>
        </div>
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item">
          <a className="nav-link active" href={listHref("&tab=services")}>
            Servizi
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link" href={listHref("&tab=categories")}>
            Categorie
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link" href={listHref("&tab=recommended")}>
            Servizi consigliati
          </a>
        </li>
      </ul>

      <link rel="stylesheet" href="/assets/css/pages/services.css" />

      {initialEmpty ? (
        <div className="card card-soft services-empty-card">
          <div className="services-empty-state">
            <div className="services-empty-icon" aria-hidden="true">
              <i className="bi bi-stars" />
            </div>
            <h2>Nessun servizio configurato</h2>
            <p>
              I servizi sono il catalogo principale usato da prenotazioni, pagamenti, pacchetti, GiftBox, promozioni e
              commissioni.
            </p>
            <div className="d-flex flex-wrap gap-2 justify-content-center">
              <a className="btn btn-primary btn-pill" href={listHref("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo servizio
              </a>
              <a className="btn btn-outline-secondary btn-pill" href={listHref("&tab=categories")}>
                <i className="bi bi-tags me-1" />
                Categorie
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form className="row g-2 align-items-end" method="get">
              <input type="hidden" name="page" value="services" />
              <input type="hidden" name="tab" value="services" />
              <div className="col-lg-3 col-md-5">
                <label className="form-label">Cerca servizio</label>
                <div className="app-combobox dropdown" data-service-list-service-filter-combobox>
                  <button
                    className="form-control text-start app-combobox-toggle dropdown-toggle"
                    type="button"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="outside"
                    aria-expanded="false"
                  >
                    <span className={`app-combobox-text ${filterId ? "" : "d-none"}`}>{selectedLabel}</span>
                    <span className={`app-combobox-placeholder text-muted ${filterId ? "d-none" : ""}`}>
                      Tutti i servizi
                    </span>
                  </button>
                  <div className="dropdown-menu p-2 w-100">
                    <input
                      type="text"
                      className="form-control form-control-sm app-combobox-search"
                      placeholder="Cerca servizio..."
                      autoComplete="off"
                    />
                    <div className="app-combobox-list mt-2">
                      {filterItems.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          className="dropdown-item"
                          onClick={() => setFilterId(it.id)}
                        >
                          {it.label}
                          {it.meta ? <span className="text-muted small ms-2">{it.meta}</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input type="hidden" name="service_id" value={filterId} />
                </div>
              </div>
              <div className="col-lg-2 d-grid">
                <button className="btn btn-outline-primary" type="submit">
                  <i className="bi bi-funnel me-1" />
                  Filtra
                </button>
              </div>
            </form>
          </div>

          {noResults ? (
            <div className="card card-soft">
              <div className="card-body text-muted">Nessun servizio trovato con i filtri selezionati.</div>
            </div>
          ) : grouped.length === 0 ? (
            <div className="card card-soft">
              <div className="card-body text-muted">{loading ? "Caricamento…" : "Nessun servizio."}</div>
            </div>
          ) : (
            grouped.map((g) => (
              <div className="card card-soft mb-3" key={g.id ?? g.label}>
                <div className="card-body">
                  <div className="d-flex align-items-center gap-2 mb-3">
                    {g.image ? (
                      <img className="services-category-thumb" src={g.image} alt="" />
                    ) : (
                      <div className="services-category-icon">
                        <i className="bi bi-stars" />
                      </div>
                    )}
                    <div className="fw-semibold">{g.label}</div>
                  </div>

                  <div className="table-responsive">
                    <table className="table align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Servizio</th>
                          <th>Sedi</th>
                          <th>Cabine</th>
                          <th>Durata</th>
                          <th>Prezzo</th>
                          <th>Attivo</th>
                          <th className="text-end">Azioni</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((x) => {
                          const isActive = x.isActive ?? x.active ?? false;
                          return (
                            <tr key={x.id}>
                              <td className="fw-semibold">{x.name}</td>
                              <td className="small text-muted">{sedi(x)}</td>
                              <td>{cabine(x)}</td>
                              <td>{x.durationMin != null ? `${x.durationMin} min` : x.duration ?? "—"}</td>
                              <td>{`€ ${fmtMoney(x.priceValue)}`}</td>
                              <td>
                                {isActive ? (
                                  <span className="badge text-bg-success">Sì</span>
                                ) : (
                                  <span className="badge text-bg-secondary">No</span>
                                )}
                              </td>
                              <td className="text-end">
                                <a
                                  className="btn btn-sm btn-outline-secondary"
                                  href={listHref(`&action=edit&id=${x.id}`)}
                                >
                                  Modifica
                                </a>{" "}
                                <a
                                  className="btn btn-sm btn-outline-danger"
                                  href={listHref(`&action=delete&id=${x.id}`)}
                                  data-service-name={x.name ?? "Servizio"}
                                  data-service-delete-blockers="[]"
                                  data-service-delete="1"
                                >
                                  Elimina
                                </a>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))
          )}
        </>
      )}

      <div className="modal fade" id="serviceDeleteBlockModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1">Servizio non eliminabile</h5>
                <div className="text-muted small" id="serviceDeleteBlockSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning">
                Non è possibile eliminare il servizio perché è ancora collegato agli elementi sotto indicati. Rimuovi o
                completa le associazioni operative prima di riprovare.
              </div>
              <div id="serviceDeleteBlockList" />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Chiudi
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
