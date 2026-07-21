"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTakenFlash } from "./flash";

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

type ServicesQuery = { msg?: string; err?: string; p?: string; service_id?: string };
type DeleteBlocker = { group: string; title: string; detail: string };
type DeletePopup = { title: string; service_name: string; message: string; blockers: DeleteBlocker[] };

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

export function ServicesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ServicesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [data, setData] = useState<ServicesData>({});
  const [loading, setLoading] = useState(true);
  // Filtro e pagina dal querystring come nel form GET legacy.
  const [filterId, setFilterId] = useState(() => {
    const raw = Number.parseInt(initialQuery?.service_id ?? "0", 10) || 0;
    return raw > 0 ? String(raw) : "";
  });
  const page = Math.max(1, Number.parseInt(initialQuery?.p ?? "1", 10) || 1);
  // Flash legacy dal redirect (?msg / ?err) + errori delle azioni in pagina.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletePopup, setDeletePopup] = useState<DeletePopup | null>(null);
  const [popupOpenGroups, setPopupOpenGroups] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
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

  // Filtro singolo servizio + PAGINAZIONE legacy (20/pagina sull'elenco piatto
  // ordinato per categoria, services.php 4628-4662).
  const filtered = useMemo(() => {
    if (!filterId) return services;
    return services.filter((s) => String(s.id) === filterId);
  }, [services, filterId]);

  const perPage = 20;
  const filteredTotal = filtered.length;
  const pages = Math.max(1, Math.ceil(filteredTotal / perPage));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * perPage;
  const visible = useMemo(() => filtered.slice(offset, offset + perPage), [filtered, offset]);
  const pageFrom = filteredTotal > 0 ? offset + 1 : 0;
  const pageTo = filteredTotal > 0 ? Math.min(filteredTotal, offset + visible.length) : 0;

  function pageUrl(target: number): string {
    const usp = new URLSearchParams({ tab: "services", p: String(Math.max(1, target)) });
    if (filterId) usp.set("service_id", filterId);
    return `/${encodeURIComponent(slug)}/services?${usp.toString()}`;
  }

  // Group services by category, preserving category order.
  const grouped = useMemo<Group[]>(() => {
    const byCat = new Map<string, Group>();
    const catOrder = [...categories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const cat of catOrder) {
      byCat.set(String(cat.id), { id: cat.id, label: cat.name, image: cat.imageUrl ?? "", items: [] });
    }
    for (const svc of visible) {
      const key = svc.categoryId != null ? String(svc.categoryId) : "__none";
      let g = byCat.get(key);
      if (!g) {
        g = {
          id: svc.categoryId ?? null,
          label: svc.categoryName ?? "Non categorizzato",
          image: svc.categoryImageUrl ?? "",
          items: [],
        };
        byCat.set(key, g);
      }
      g.items.push(svc);
    }
    return Array.from(byCat.values()).filter((g) => g.items.length > 0);
  }, [visible, categories]);

  function redirectFlash(params: Record<string, string>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== "") usp.set(k, v);
    window.location.assign(`/${encodeURIComponent(slug)}/services${usp.size > 0 ? `?${usp.toString()}` : ""}`);
  }

  // Delete legacy (services.js servicesConfirmDelete + services.php 4173-4200):
  // con blocchi -> popup #serviceDeleteBlockModal; senza -> confirm verbatim.
  async function removeService(svc: Service) {
    setBusy(true);
    try {
      const check = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}&action=delete_blockers&id=${svc.id}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .catch(() => ({ blockers: [] }));
      const blockers: DeleteBlocker[] = Array.isArray(check.blockers) ? check.blockers : [];
      if (blockers.length > 0) {
        setDeletePopup({
          title: "Impossibile eliminare il servizio",
          service_name: svc.name ?? "Servizio",
          message: "Il servizio non può essere eliminato perché è associato a elementi attivi o ancora da eseguire. Rimuovi o chiudi prima le associazioni elencate.",
          blockers,
        });
        setPopupOpenGroups({});
        return;
      }
      if (!window.confirm("Eliminare definitivamente questo servizio? Lo storico gia creato rimarra invariato.")) return;
      const res = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: String(svc.id) }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && j.ok !== false) {
        redirectFlash({ msg: String(j.msg ?? "Servizio eliminato") });
        return;
      }
      setErr(String(j.error ?? "Servizio non eliminabile"));
      if (j.popup) {
        setDeletePopup(j.popup as DeletePopup);
        setPopupOpenGroups({});
      }
      window.scrollTo(0, 0);
    } finally {
      setBusy(false);
    }
  }

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

      {flash.msg ? <div className="alert alert-success">{flash.msg}</div> : null}
      {flash.err ? <div className="alert alert-danger">{flash.err}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      {initialEmpty ? (
        <div className="card card-soft services-empty-card">
          <div className="services-empty-state">
            <div className="services-empty-icon" aria-hidden="true">
              <i className="bi bi-stars" />
            </div>
            {cabins.filter((c) => c.isActive !== false).length === 0 ? (
              <>
                <h2>Prima configura una cabina</h2>
                <p>Per creare un servizio serve almeno una cabina attiva. Configura le cabine della sede e poi torna qui per costruire il catalogo servizi.</p>
                <div className="d-flex flex-wrap gap-2 justify-content-center">
                  <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/cabins`}>
                    <i className="bi bi-door-open me-1" />
                    Configura cabine
                  </a>
                  <a className="btn btn-outline-secondary btn-pill" href={listHref("&tab=categories")}>
                    <i className="bi bi-tags me-1" />
                    Categorie
                  </a>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const usp = new URLSearchParams({ tab: "services" });
                if (filterId) usp.set("service_id", filterId);
                window.location.assign(`/${encodeURIComponent(slug)}/services?${usp.toString()}`);
              }}
            >
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
              <div className="card-body text-muted">
                {filterId ? "Nessun servizio trovato con i filtri selezionati." : "Nessun servizio abilitato per la sede selezionata."}
              </div>
            </div>
          ) : grouped.length === 0 ? (
            <div className="card card-soft">
              <div className="card-body text-muted">{loading ? "Caricamento…" : "Nessun servizio abilitato per la sede selezionata."}</div>
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
                                <button
                                  className="btn btn-sm btn-outline-danger"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void removeService(x)}
                                >
                                  Elimina
                                </button>
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

          {pages > 1 ? (
            <div className="card card-soft mb-3">
              <div className="card-body py-2 d-flex flex-wrap align-items-center justify-content-between gap-2">
                <div className="text-muted small">
                  Mostro {pageFrom}-{pageTo} di {filteredTotal} servizi
                  <span className="ms-2">Pagina {currentPage} di {pages}</span>
                </div>
                <div className="d-flex gap-2">
                  <a className={`btn btn-sm btn-outline-secondary ${currentPage <= 1 ? "disabled" : ""}`} href={pageUrl(Math.max(1, currentPage - 1))}>Precedente</a>
                  <a className={`btn btn-sm btn-outline-secondary ${currentPage >= pages ? "disabled" : ""}`} href={pageUrl(Math.min(pages, currentPage + 1))}>Successiva</a>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {/* MODALE "Servizio non eliminabile" (#serviceDeleteBlockModal). */}
      {deletePopup ? (
        <>
          <div className="modal fade show d-block" id="serviceDeleteBlockModal" tabIndex={-1}>
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1">Servizio non eliminabile</h5>
                    <div className="text-muted small" id="serviceDeleteBlockSubtitle">Servizio: {deletePopup.service_name}</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeletePopup(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning">
                    Non è possibile eliminare il servizio perché è ancora collegato agli elementi sotto indicati.
                    Rimuovi o completa le associazioni operative prima di riprovare.
                  </div>
                  <div id="serviceDeleteBlockList">
                    {deletePopup.blockers.length === 0 ? (
                      <div className="text-muted">Nessuna associazione rilevata.</div>
                    ) : (
                      <div className="accordion" id="serviceDeleteBlockAccordion">
                        {groupBlockers(deletePopup.blockers).map(([group, rows]) => (
                          <div className="accordion-item border rounded-3 overflow-hidden mb-2" key={group}>
                            <h3 className="accordion-header">
                              <button
                                className={`accordion-button ${popupOpenGroups[group] ? "" : "collapsed"} bg-white shadow-none py-2`}
                                type="button"
                                onClick={() => setPopupOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }))}
                              >
                                <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                                  <span className="fw-semibold">{group}</span>
                                  <span className="badge rounded-pill text-bg-info">{rows.length}</span>
                                </span>
                              </button>
                            </h3>
                            <div className={`accordion-collapse collapse ${popupOpenGroups[group] ? "show" : ""}`}>
                              <div className="accordion-body py-2">
                                <div className="list-group list-group-flush">
                                  {rows.map((row, index) => (
                                    <div className="list-group-item px-0" key={index}>
                                      <div className="fw-semibold">{row.title || "Elemento collegato"}</div>
                                      {row.detail ? <div className="small text-muted">{row.detail}</div> : null}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setDeletePopup(null)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}

// groupItems di services.js: raggruppa i blocchi per 'group' (default 'Associazioni').
function groupBlockers(items: DeleteBlocker[]): Array<[string, DeleteBlocker[]]> {
  const groups = new Map<string, DeleteBlocker[]>();
  for (const item of items) {
    const key = String(item.group ?? "").trim() || "Associazioni";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()];
}
