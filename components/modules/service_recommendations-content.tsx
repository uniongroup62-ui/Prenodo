"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP services page, "Servizi consigliati" tab
// (?page=services&tab=recommended). Fed by the existing DB-backed
// /api/manage/services route (getManageServicesContext).

type Service = {
  id: number;
  name: string;
  categoryId?: number;
  categoryName?: string;
  recommendationIds?: number[];
  recoCount?: number;
  isActive?: boolean;
  active?: boolean;
};

type ServicesContext = {
  services?: Service[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function ServiceRecommendationsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterServiceId, setFilterServiceId] = useState<string>("");
  const [openModalId, setOpenModalId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}&tab=recommended`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServicesContext) => setServices(Array.isArray(j.services) ? j.services : []))
      .catch(() => setServices([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function tabHref(tab: string): string {
    return `/${encodeURIComponent(slug)}/services?tab=${tab}`;
  }

  // Top-of-page service combobox filter data (the PHP page emits these as JSON
  // for the client-side combobox).
  const filterItems = useMemo(
    () =>
      services.map((s) => ({
        id: String(s.id),
        label: s.name,
        meta: s.categoryName ?? "",
        search: `${s.name} ${s.categoryName ?? ""}`.trim().toLowerCase(),
      })),
    [services],
  );

  const rows = useMemo(() => {
    if (!filterServiceId) return services;
    return services.filter((s) => String(s.id) === filterServiceId);
  }, [services, filterServiceId]);

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Servizi consigliati</h1>
          <div className="bs-page-subtitle">Collega servizi da proporre come suggerimenti nel percorso cliente.</div>
        </div>
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item">
          <a className="nav-link" href={tabHref("services")}>
            Servizi
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link" href={tabHref("categories")}>
            Categorie
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link active" href={tabHref("recommended")}>
            Servizi consigliati
          </a>
        </li>
      </ul>

      <link rel="stylesheet" href="/assets/css/pages/services.css" />

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          method="get"
          onSubmit={(e) => e.preventDefault()}
        >
          <input type="hidden" name="page" value="services" />
          <input type="hidden" name="tab" value="recommended" />
          <div className="col-lg-3 col-md-5">
            <label className="form-label">Cerca servizio</label>
            <div className="app-combobox dropdown" data-rec-page-service-combobox>
              <button
                className="form-control text-start app-combobox-toggle dropdown-toggle"
                type="button"
                data-bs-toggle="dropdown"
                data-bs-auto-close="outside"
                aria-expanded="false"
              >
                <span className="app-combobox-text d-none" />
                <span className="app-combobox-placeholder text-muted ">Tutti i servizi</span>
              </button>
              <div className="dropdown-menu p-2 w-100">
                <input
                  type="text"
                  className="form-control form-control-sm app-combobox-search"
                  placeholder="Cerca servizio..."
                  autoComplete="off"
                />
                <div className="app-combobox-list mt-2">
                  {filterItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="dropdown-item"
                      onClick={() => setFilterServiceId(item.id)}
                    >
                      {item.label}
                      {item.meta ? <span className="text-muted small ms-2">{item.meta}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
              <input type="hidden" name="service_id" value={filterServiceId} />
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

      <div className="card card-soft">
        <div className="card-body">
          <div className="table-responsive">
            <table className="table align-middle">
              <thead>
                <tr>
                  <th>Servizio</th>
                  <th>Categoria</th>
                  <th>Consigliati</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-muted small p-3">
                      {loading ? "Caricamento…" : "Nessun servizio."}
                    </td>
                  </tr>
                ) : (
                  rows.map((service) => {
                    const recoCount = Number(service.recoCount ?? service.recommendationIds?.length ?? 0);
                    const isActive = service.isActive ?? service.active ?? false;
                    return (
                      <tr key={service.id}>
                        <td>
                          <div className="fw-semibold">{service.name}</div>
                        </td>
                        <td>{service.categoryName || "—"}</td>
                        <td>
                          <div className="d-flex align-items-center gap-2 flex-wrap">
                            <span className="badge text-bg-light">{recoCount}</span>
                            {recoCount === 0 ? (
                              <span className="text-muted small">Nessun consigliato</span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {isActive ? (
                            <span className="badge text-bg-success">Attivo</span>
                          ) : (
                            <span className="badge text-bg-secondary">Inattivo</span>
                          )}
                        </td>
                        <td className="text-end">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            type="button"
                            data-bs-toggle="modal"
                            data-bs-target={`#recommendedModal${service.id}`}
                            onClick={() => setOpenModalId(service.id)}
                          >
                            Gestisci
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {rows.map((service) => {
        const candidates = services.filter((s) => s.id !== service.id);
        return (
          <div
            key={service.id}
            className={`modal fade${openModalId === service.id ? " show d-block" : ""}`}
            id={`recommendedModal${service.id}`}
            tabIndex={-1}
            aria-hidden={openModalId === service.id ? undefined : true}
            style={openModalId === service.id ? { background: "rgba(0,0,0,.5)" } : undefined}
            data-rec-modal
            data-rec-initial-order=""
          >
            <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <form
                  method="post"
                  action={`/${encodeURIComponent(slug)}/services?tab=recommended&action=edit&id=${service.id}`}
                >
                  <div className="modal-header">
                    <div>
                      <div className="page-eyebrow mb-1">Servizi consigliati per</div>
                      <h5 className="modal-title mb-0">{service.name}</h5>
                    </div>
                    <button
                      type="button"
                      className="btn-close"
                      data-bs-dismiss="modal"
                      aria-label="Chiudi"
                      onClick={() => setOpenModalId(null)}
                    />
                  </div>
                  <div className="modal-body">
                    <input type="hidden" name="_csrf" value="" />
                    <input type="hidden" name="service_id" value={service.id} />
                    <input type="hidden" name="filter_service_id" value="" />
                    <input type="hidden" name="p" value="1" />
                    <div data-rec-hidden-inputs />

                    <div className="recommended-filter-grid mb-3">
                      <div>
                        <label className="form-label">Cerca servizio</label>
                        <div className="app-combobox dropdown" data-rec-service-combobox>
                          <button
                            className="form-control text-start app-combobox-toggle dropdown-toggle"
                            type="button"
                            data-bs-toggle="dropdown"
                            data-bs-auto-close="outside"
                            aria-expanded="false"
                          >
                            <span className="app-combobox-text d-none" />
                            <span className="app-combobox-placeholder text-muted">Tutti i servizi</span>
                          </button>
                          <div className="dropdown-menu p-2 w-100">
                            <input
                              type="text"
                              className="form-control form-control-sm app-combobox-search"
                              placeholder="Cerca servizio..."
                              autoComplete="off"
                            />
                            <div className="app-combobox-list mt-2" />
                          </div>
                          <input type="hidden" value="" data-rec-service-filter />
                        </div>
                      </div>
                    </div>

                    <div className="recommended-modal-grid">
                      <div className="recommended-picker-panel">
                        <div className="fw-semibold mb-2">Servizi disponibili</div>
                        {candidates.length === 0 ? (
                          <div className="text-muted">Nessun altro servizio disponibile da consigliare.</div>
                        ) : (
                          candidates.map((c) => (
                            <div className="form-check" key={c.id}>
                              <input
                                className="form-check-input"
                                type="checkbox"
                                name="recommended_ids[]"
                                value={c.id}
                                id={`rec-${service.id}-${c.id}`}
                                defaultChecked={(service.recommendationIds ?? []).includes(c.id)}
                                data-rec-picker
                              />
                              <label className="form-check-label" htmlFor={`rec-${service.id}-${c.id}`}>
                                {c.name}
                                {c.categoryName ? (
                                  <span className="text-muted small ms-2">{c.categoryName}</span>
                                ) : null}
                              </label>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="recommended-picker-panel recommended-order-panel">
                        <div className="recommended-order-head">
                          <div className="fw-semibold">Ordine consigliati</div>
                          <span className="badge text-bg-light" data-rec-count>
                            {Number(service.recoCount ?? service.recommendationIds?.length ?? 0)} selezionati
                          </span>
                        </div>
                        <div className="text-muted small mb-2">
                          I servizi selezionati verranno mostrati in questo ordine.
                        </div>
                        <div className="recommended-order-scroll">
                          <div className="recommended-order-list" data-rec-order-list />
                          <div className="recommended-order-empty text-muted" data-rec-order-empty>
                            Nessun servizio selezionato.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-pill"
                      data-bs-dismiss="modal"
                      onClick={() => setOpenModalId(null)}
                    >
                      Annulla
                    </button>
                    <button className="btn btn-primary btn-pill" type="submit">
                      <i className="bi bi-check2-circle me-1" />
                      Salva
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
