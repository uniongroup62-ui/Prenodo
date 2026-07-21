"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

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

type RecommendationsQuery = { msg?: string; err?: string; action?: string; id?: string; service_id?: string; p?: string };

export function ServiceRecommendationsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: RecommendationsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  // Flash legacy + filtro/pagina dal querystring; ?action=edit&id apre la modale.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);
  const page = Math.max(1, Number.parseInt(initialQuery?.p ?? "1", 10) || 1);
  const [filterServiceId, setFilterServiceId] = useState<string>(() => {
    const raw = Number.parseInt(initialQuery?.service_id ?? "0", 10) || 0;
    return raw > 0 ? String(raw) : "";
  });
  const autoOpenId = initialQuery?.action === "edit" ? Math.max(0, Number.parseInt(initialQuery?.id ?? "0", 10) || 0) : 0;
  const [openModalId, setOpenModalId] = useState<number | null>(null);
  // Selezione ordinata nella modale aperta (data-rec-order-list del legacy).
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}&tab=recommended`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServicesContext) => {
        const list = Array.isArray(j.services) ? j.services : [];
        setServices(list);
        if (autoOpenId > 0) {
          const found = list.find((s) => s.id === autoOpenId);
          if (found) openManage(found);
          else setFlash((prev) => ({ ...prev, err: prev.err || "Servizio non trovato" }));
        }
      })
      .catch(() => setServices([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function tabHref(tab: string): string {
    return `/${encodeURIComponent(slug)}/services?tab=${tab}`;
  }

  function openManage(service: Service) {
    setSelectedIds((service.recommendationIds ?? []).map(Number).filter((n) => n > 0));
    setOpenModalId(service.id);
  }

  function toggleSelected(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  }

  function moveSelected(id: number, direction: -1 | 1) {
    setSelectedIds((prev) => {
      const index = prev.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Salvataggio legacy (services.php 3095-3130): DELETE+reinsert con sort_order
  // progressivo, poi redirect '&msg=Servizi consigliati aggiornati' conservando
  // filtro e pagina.
  async function saveRecommendations(serviceId: number) {
    setSaving(true);
    try {
      const res = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "recommendations_save", service_id: String(serviceId), recommended_ids: selectedIds.join(",") }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const usp = new URLSearchParams({ tab: "recommended" });
      if (filterServiceId) usp.set("service_id", filterServiceId);
      if (page > 1) usp.set("p", String(page));
      const flash = res.ok && j.ok !== false
        ? { msg: String(j.msg ?? "Servizi consigliati aggiornati") }
        : { err: String(j.error ?? "Seleziona un servizio valido") };
      flashNavigate(`/${encodeURIComponent(slug)}/services?${usp.toString()}`, flash);
    } finally {
      setSaving(false);
    }
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

  // Filtro + paginazione legacy 20/pagina (services.php 3212-3243).
  const filtered = useMemo(() => {
    if (!filterServiceId) return services;
    return services.filter((s) => String(s.id) === filterServiceId);
  }, [services, filterServiceId]);
  const perPage = 20;
  const filteredTotal = filtered.length;
  const pages = Math.max(1, Math.ceil(filteredTotal / perPage));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * perPage;
  const rows = useMemo(() => filtered.slice(offset, offset + perPage), [filtered, offset]);
  const pageFrom = filteredTotal > 0 ? offset + 1 : 0;
  const pageTo = filteredTotal > 0 ? Math.min(filteredTotal, offset + rows.length) : 0;
  function pageUrl(target: number): string {
    const usp = new URLSearchParams({ tab: "recommended" });
    if (filterServiceId) usp.set("service_id", filterServiceId);
    if (target > 1) usp.set("p", String(target));
    return `/${encodeURIComponent(slug)}/services?${usp.toString()}`;
  }
  const servicesById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);

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

      {flash.msg ? <div className="alert alert-success">{flash.msg}</div> : null}
      {flash.err ? <div className="alert alert-danger">{flash.err}</div> : null}

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const usp = new URLSearchParams({ tab: "recommended" });
            if (filterServiceId) usp.set("service_id", filterServiceId);
            window.location.assign(`/${encodeURIComponent(slug)}/services?${usp.toString()}`);
          }}
        >
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
                            ) : (
                              <>
                                {(service.recommendationIds ?? []).slice(0, 3).map((rid) => (
                                  <span className="badge text-bg-secondary" key={rid}>{servicesById.get(rid)?.name ?? `#${rid}`}</span>
                                ))}
                                {recoCount > 3 ? <span className="badge text-bg-secondary">+{recoCount - 3}</span> : null}
                              </>
                            )}
                          </div>
                        </td>
                        <td>
                          {isActive ? (
                            <span className="badge text-bg-success">Attivo</span>
                          ) : (
                            <span className="badge text-bg-secondary">Non attivo</span>
                          )}
                        </td>
                        <td className="text-end">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            type="button"
                            onClick={() => openManage(service)}
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

      {pages > 1 ? (
        <div className="card card-soft mt-3 mb-3">
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

      {services.filter((service) => openModalId === service.id).map((service) => {
        const candidates = services.filter((s) => s.id !== service.id);
        return (
          <div
            key={service.id}
            className="modal fade show d-block"
            id={`recommendedModal${service.id}`}
            tabIndex={-1}
            style={{ background: "rgba(0,0,0,.5)" }}
          >
            <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveRecommendations(service.id);
                  }}
                >
                  <div className="modal-header">
                    <div>
                      <div className="page-eyebrow mb-1">Servizi consigliati per</div>
                      <h5 className="modal-title mb-0">{service.name}</h5>
                    </div>
                    <button
                      type="button"
                      className="btn-close"
                      aria-label="Chiudi"
                      onClick={() => setOpenModalId(null)}
                    />
                  </div>
                  <div className="modal-body">

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
                                id={`rec-${service.id}-${c.id}`}
                                checked={selectedIds.includes(c.id)}
                                onChange={(e) => toggleSelected(c.id, e.target.checked)}
                              />
                              <label className="form-check-label" htmlFor={`rec-${service.id}-${c.id}`}>
                                {c.name}
                                {c.categoryName ? (
                                  <span className="text-muted small ms-2">{c.categoryName}</span>
                                ) : null}
                                {(c.isActive ?? c.active ?? true) ? null : <span className="badge text-bg-secondary ms-2">Non attivo</span>}
                              </label>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="recommended-picker-panel recommended-order-panel">
                        <div className="recommended-order-head">
                          <div className="fw-semibold">Ordine consigliati</div>
                          <span className="badge text-bg-light">
                            {selectedIds.length} {selectedIds.length === 1 ? "selezionato" : "selezionati"}
                          </span>
                        </div>
                        <div className="text-muted small mb-2">
                          I servizi selezionati verranno mostrati in questo ordine.
                        </div>
                        <div className="recommended-order-scroll">
                          {selectedIds.length === 0 ? (
                            <div className="recommended-order-empty text-muted">Nessun servizio selezionato.</div>
                          ) : (
                            <div className="recommended-order-list">
                              {selectedIds.map((rid) => (
                                <div className="d-flex align-items-center justify-content-between gap-2 border rounded-3 px-2 py-1 mb-1" key={rid}>
                                  <div className="small">{servicesById.get(rid)?.name ?? `#${rid}`}</div>
                                  <div className="btn-group btn-group-sm" role="group">
                                    <button type="button" className="btn btn-outline-secondary" title="Sposta su" onClick={() => moveSelected(rid, -1)}>
                                      <i className="bi bi-chevron-up" />
                                    </button>
                                    <button type="button" className="btn btn-outline-secondary" title="Sposta giù" onClick={() => moveSelected(rid, 1)}>
                                      <i className="bi bi-chevron-down" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-pill"
                      onClick={() => setOpenModalId(null)}
                    >
                      Annulla
                    </button>
                    <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
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
