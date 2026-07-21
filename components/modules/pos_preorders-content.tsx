"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP POS preorders page (app/pages/pos_preorders.php):
// KPI tiles, a left filter rail (period / location / search / clients / products /
// view) and a results table of products with status "Ordinato" waiting for
// pickup. Fed by the existing DB-backed /api/manage/preorders, plus the
// locations and clients lists for the filter rail.

type PreorderKind = "sale" | "package" | "giftbox";
type PreorderStockStatus = "ready" | "partial" | "insufficient" | "expired";

type Preorder = {
  id: number;
  clientId: number;
  clientName: string;
  productId: number;
  productName: string;
  quantity: number;
  deposit: number;
  dueDate: string;
  status: "open" | "collected";
  createdAt?: string;
  collectedAt?: string;
  // Multi-source fields from listDbPreorders (pos_preorders.php merge of
  // sale_items ordered / client_packages products / giftbox products).
  kind?: PreorderKind;
  saleId?: number;
  stock?: number;
  stockStatus?: PreorderStockStatus;
  sourceRef?: string;
  sourceName?: string;
  sourceCode?: string;
  saleDate?: string;
  expiresAt?: string;
  expiryApplies?: boolean;
  isExpired?: boolean;
};

type LocationItem = { id: number; name?: string };
type ClientItem = { id: number; name?: string };

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

// Tipo badge (source kind), mirroring pos_preorders.php $sourceBadge*.
function kindBadge(kind?: PreorderKind): { cls: string; label: string } {
  if (kind === "package") return { cls: "text-bg-primary", label: "Pacchetto" };
  if (kind === "giftbox") return { cls: "text-bg-warning", label: "GiftBox" };
  return { cls: "text-bg-warning", label: "Ordinato" };
}

// Stato badge from the computed stock status (pos_preorders.php $statusBadge*).
function statusBadge(p: Preorder): { cls: string; label: string } {
  if (p.isExpired || p.stockStatus === "expired") return { cls: "text-bg-danger", label: "Scaduto" };
  const qty = Math.max(1, p.quantity || 1);
  const stock = Math.max(0, p.stock ?? 0);
  if (p.stockStatus === "ready" || stock >= qty) return { cls: "text-bg-success", label: "Pronto al ritiro" };
  const collectMax = Math.max(0, Math.min(qty, stock));
  if (collectMax > 0) return { cls: "text-bg-warning", label: `Ritiro parziale ${collectMax}/${qty}` };
  return { cls: "text-bg-danger", label: "Stock insufficiente" };
}

export function PosPreordersContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [preorders, setPreorders] = useState<Preorder[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [clients, setClients] = useState<ClientItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter state (the PHP page submits a GET form; here filters apply client-side).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [locationId, setLocationId] = useState("0");
  const [q, setQ] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [selectedClients, setSelectedClients] = useState<Record<number, boolean>>({});
  const [view, setView] = useState("active");
  const [page, setPage] = useState(1);
  const perPage = 50;

  // Sequenza anti-stale (audit giro 3): due cambi sede ravvicinati lanciavano
  // fetch concorrenti e vinceva la risposta più lenta (stock/stati della sede
  // sbagliata a schermo).
  const loadSeqRef = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    // Forward the selected location so the product stock is location-aware
    // (mirrors pos_preorders.php app_product_stock_row). "0" = Tutte = base stock.
    fetch(`/api/manage/preorders?slug=${encodeURIComponent(slug)}&location_id=${encodeURIComponent(locationId)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (seq === loadSeqRef.current) setPreorders(Array.isArray(j.preorders) ? j.preorders : []);
      })
      .catch(() => {
        if (seq === loadSeqRef.current) setPreorders([]);
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false);
      });
  }, [slug, locationId]);

  useEffect(() => {
    // load() fa setLoading(true) sincrono -> microtask (pattern consolidato).
    let alive = true;
    Promise.resolve().then(() => {
      if (alive) load();
    });
    return () => {
      alive = false;
    };
  }, [load]);

  // Contesto sedi/clienti: SOLO al mount (audit giro 3: prima ripartivano a
  // ogni cambio sede insieme al load).
  useEffect(() => {
    let alive = true;
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (alive) setLocations(Array.isArray(j.locations) ? j.locations : []);
      })
      .catch(() => {});
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (alive) setClients(Array.isArray(j.clients) ? j.clients : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug]);

  // Apply the filter rail to the loaded preorders. Mirrors _pos_pre_row_match:
  // the period filter tests the SALE date, and the 8 views have the semantics of
  // ready / not_ready / expired / sale|package|giftbox (source kind) / all|active.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const clientIds = Object.entries(selectedClients)
      .filter(([, v]) => v)
      .map(([k]) => Number(k));
    return preorders.filter((p) => {
      // Client filter.
      if (clientIds.length > 0 && !clientIds.includes(p.clientId)) return false;

      // Period filter on the SALE date (falls back to createdAt).
      const saleDay = (p.saleDate || p.createdAt || "").slice(0, 10);
      if (from && (!saleDay || saleDay < from)) return false;
      if (to && (!saleDay || saleDay > to)) return false;

      // View semantics.
      const kind = p.kind ?? "sale";
      const isExpired = !!p.isExpired;
      const isReady = p.stockStatus === "ready";
      const v = view;
      if (v === "expired") {
        if (!isExpired) return false;
      } else if (v !== "all" && isExpired) {
        // Non-"all"/"expired" views hide expired rows (like the PHP page).
        return false;
      }
      if (v === "ready" && !isReady) return false;
      if (v === "not_ready" && isReady) return false;
      if ((v === "sale" || v === "package" || v === "giftbox") && kind !== v) return false;

      // Free-text search across client, product, source and ids.
      if (term) {
        const hay = `${p.clientName} ${p.productName} ${p.sourceRef ?? ""} ${p.sourceName ?? ""} ${p.sourceCode ?? ""} ${p.saleId ?? ""} ${p.productId} ${p.clientId}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [preorders, view, from, to, selectedClients, q]);

  // KPIs derived from the FILTERED set (mirrors the PHP summary tiles, which are
  // computed over $filteredRows): open rows, pieces, ready and insufficient.
  const openCount = filtered.length;
  const pieces = useMemo(
    () => filtered.reduce((sum, p) => sum + (p.quantity || 0), 0),
    [filtered],
  );
  const readyCount = useMemo(
    () => filtered.filter((p) => p.stockStatus === "ready").length,
    [filtered],
  );
  const notReadyCount = useMemo(
    () => filtered.filter((p) => p.stockStatus !== "ready").length,
    [filtered],
  );

  // 50/page pagination over the filtered set (pos_preorders.php $perPage = 50).
  const totalRows = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * perPage, currentPage * perPage),
    [filtered, currentPage],
  );

  const selectedLocationName =
    locationId !== "0" ? locations.find((l) => String(l.id) === locationId)?.name ?? "" : "";

  const visibleClients = useMemo(() => {
    const term = clientFilter.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter((c) => String(c.name ?? "").toLowerCase().includes(term));
  }, [clients, clientFilter]);

  function resetFilters() {
    setFrom("");
    setTo("");
    setLocationId("0");
    setQ("");
    setClientFilter("");
    setSelectedClients({});
    setView("active");
    setPage(1);
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/pos_preorders.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pagamenti</div>
          <h1 className="bs-page-title">Preordini</h1>
          <div className="bs-page-subtitle">
            Prodotti venduti da Pagamenti con stato Ordinato. Il ritiro si registra dal Dettaglio vendita.
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/pos_settings`}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
          </div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-12 col-sm-6 col-xl-3">
          <div className="card p-3 h-100">
            <div className="small text-muted">Preordini aperti</div>
            <div className="h3 fw-semibold mb-0">{openCount}</div>
          </div>
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <div className="card p-3 h-100">
            <div className="small text-muted">Pezzi da consegnare</div>
            <div className="h3 fw-semibold mb-0">{pieces}</div>
          </div>
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <div className="card p-3 h-100">
            <div className="small text-muted">Pronti al ritiro</div>
            <div className="h3 fw-semibold mb-0 text-success">{readyCount}</div>
          </div>
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <div className="card p-3 h-100">
            <div className="small text-muted">Con stock insufficiente</div>
            <div className={`h3 fw-semibold mb-0 ${notReadyCount > 0 ? "text-danger" : ""}`}>{notReadyCount}</div>
          </div>
        </div>
      </div>

      <div className="pos-movements-layout">
        <div className="card pos-movements-filter preorders-filter-card">
          <form
            method="get"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <input type="hidden" name="page" value="pos_preorders" />

            <div className="pos-filter-head">
              <div>
                <div className="fw-semibold">Filtri</div>
                <div className="text-muted small">Preordini</div>
              </div>
              <a
                className="btn btn-sm btn-outline-secondary"
                href={`/${encodeURIComponent(slug)}/pos_preorders`}
                title="Azzera filtri"
                onClick={(e) => {
                  e.preventDefault();
                  resetFilters();
                }}
              >
                <i className="bi bi-arrow-counterclockwise" />
              </a>
            </div>

            <div className="pos-filter-block">
              <div className="pos-filter-title">Periodo</div>
              <div className="row g-2">
                <div className="col-6">
                  <label className="form-label small text-muted">Da</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    name="from"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted">A</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    name="to"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="pos-filter-block">
              <label className="pos-filter-title" htmlFor="preordersLocation">
                Sede
              </label>
              <select
                id="preordersLocation"
                name="location_id"
                className="form-select form-select-sm"
                data-autosubmit="1"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="0">Tutte</option>
                {locations.map((loc) => (
                  <option value={String(loc.id)} key={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="pos-filter-block">
              <label className="pos-filter-title">Ricerca</label>
              <input
                type="text"
                className="form-control form-control-sm"
                name="q"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Cliente, prodotto, SKU, vendita..."
              />
            </div>

            <div className="pos-filter-block">
              <div className="pos-filter-title">Filtri attivi</div>
              <div className="pos-active-filters">
                {selectedLocationName ? (
                  <span className="badge text-bg-light border">Sede: {selectedLocationName}</span>
                ) : null}
              </div>
            </div>

            <details className="pos-filter-group" open>
              <summary>
                <span>Clienti</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="pos-filter-search-wrap">
                  <i className="bi bi-search" />
                  <input
                    type="text"
                    className="form-control form-control-sm pos-filter-search"
                    data-filter-target="#preordersClientList"
                    placeholder="Filtra clienti"
                    autoComplete="off"
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                  />
                </div>
                <div className="pos-filter-check-list" id="preordersClientList">
                  {visibleClients.map((c) => (
                    <label
                      className="pos-filter-check"
                      data-filter-option
                      data-filter-text={String(c.name ?? "").toLowerCase()}
                      key={c.id}
                    >
                      <input
                        className="form-check-input"
                        type="checkbox"
                        name="client_id[]"
                        value={String(c.id)}
                        checked={!!selectedClients[c.id]}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedClients((prev) => ({ ...prev, [c.id]: checked }));
                          setPage(1);
                        }}
                      />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Prodotti</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="text-muted small">Nessun prodotto disponibile.</div>
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Vista</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="pos-filter-check-list">
                  {[
                    { value: "active", label: "Aperti" },
                    { value: "ready", label: "Pronti al ritiro" },
                    { value: "not_ready", label: "Stock insufficiente / parziale" },
                    { value: "expired", label: "Scaduti" },
                    { value: "sale", label: "Solo ordinati" },
                    { value: "package", label: "Solo pacchetti" },
                    { value: "giftbox", label: "Solo GiftBox" },
                    { value: "all", label: "Tutti" },
                  ].map((opt) => (
                    <label className="pos-filter-check" key={opt.value}>
                      <input
                        className="form-check-input"
                        type="radio"
                        name="view"
                        value={opt.value}
                        checked={view === opt.value}
                        onChange={() => {
                          setView(opt.value);
                          setPage(1);
                        }}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </details>

            <div className="pos-filter-actions">
              <button className="btn btn-primary w-100" type="submit">
                <i className="bi bi-search" /> Filtra
              </button>
            </div>
          </form>
        </div>

        <section className="pos-movements-results">
          <div className="card">
            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0">
                <thead>
                  <tr>
                    <th className="pos-preorders-col-purchase">Acquisto</th>
                    <th className="pos-preorders-col-sale">Vendita</th>
                    <th className="pos-preorders-col-type">Tipo</th>
                    <th className="pos-preorders-col-client">Cliente</th>
                    <th>Prodotto</th>
                    <th className="text-end pos-preorders-col-qty">Q.tà</th>
                    <th className="text-end pos-preorders-col-stock">Stock</th>
                    <th className="pos-preorders-col-status">Stato</th>
                    <th className="text-end pos-preorders-col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center text-muted py-4">
                        {loading
                          ? "Caricamento…"
                          : "Nessun prodotto da consegnare trovato con i filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    paged.map((p) => {
                      const kb = kindBadge(p.kind);
                      const sb = statusBadge(p);
                      const qty = Math.max(1, p.quantity || 1);
                      const stock = Math.max(0, p.stock ?? 0);
                      const stockShort = stock < qty;
                      const sourceDetail =
                        p.sourceRef ||
                        (p.kind === "package"
                          ? "Pacchetto"
                          : p.kind === "giftbox"
                            ? "GiftBox"
                            : `Vendita #${p.saleId ?? 0}`);
                      const clientLabel =
                        p.clientName ||
                        (p.clientId > 0 ? `Cliente #${p.clientId}` : "Cliente non associato");
                      const saleHref =
                        p.saleId && p.saleId > 0
                          ? `/${encodeURIComponent(slug)}/pos_sale_detail?id=${p.saleId}&back=preorders`
                          : null;
                      return (
                        <tr key={p.id}>
                          <td className="pos-preorders-col-purchase">
                            <div className="fw-semibold">{fmtDate(p.saleDate || p.createdAt)}</div>
                            {p.expiresAt && p.expiryApplies ? (
                              <div className={`small ${p.isExpired ? "text-danger fw-semibold" : "text-muted"}`}>
                                Scadenza: {fmtDate(p.expiresAt)}
                              </div>
                            ) : null}
                          </td>
                          <td className="pos-preorders-col-sale">
                            <div className="fw-semibold">{p.saleId && p.saleId > 0 ? `#${p.saleId}` : "—"}</div>
                          </td>
                          <td className="pos-preorders-col-type">
                            <div className="small mt-1">
                              <span className={`badge ${kb.cls}`}>{kb.label}</span>
                            </div>
                            <div className="small text-muted">{sourceDetail}</div>
                            {p.sourceName ? <div className="small text-muted">{p.sourceName}</div> : null}
                          </td>
                          <td className="pos-preorders-col-client">{clientLabel}</td>
                          <td>
                            <div className="fw-semibold">{p.productName}</div>
                          </td>
                          <td className="text-end pos-preorders-col-qty fw-semibold">{qty}</td>
                          <td className={`text-end pos-preorders-col-stock ${stockShort ? "text-danger fw-semibold" : ""}`}>
                            {stock}
                          </td>
                          <td className="pos-preorders-col-status">
                            <div className="d-flex flex-column gap-1">
                              <span className={`badge ${sb.cls}`}>{sb.label}</span>
                            </div>
                          </td>
                          <td className="text-end pos-preorders-col-actions">
                            <div className="d-flex justify-content-end gap-2 flex-wrap">
                              {saleHref ? (
                                <a className="btn btn-sm btn-outline-primary" href={saleHref}>
                                  Dettaglio vendita
                                </a>
                              ) : (
                                <span className="text-muted small">Nessuna vendita collegata</span>
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

          {totalRows > perPage ? (
            <>
              <nav className="mt-3" aria-label="Paginazione preordini">
                <ul className="pagination mb-0 flex-wrap">
                  <li className={`page-item ${currentPage <= 1 ? "disabled" : ""}`}>
                    <a
                      className="page-link"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(Math.max(1, currentPage - 1));
                      }}
                    >
                      &laquo;
                    </a>
                  </li>
                  {Array.from(
                    { length: Math.min(totalPages, currentPage + 2) - Math.max(1, currentPage - 2) + 1 },
                    (_, i) => Math.max(1, currentPage - 2) + i,
                  ).map((i) => (
                    <li className={`page-item ${i === currentPage ? "active" : ""}`} key={i}>
                      <a
                        className="page-link"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(i);
                        }}
                      >
                        {i}
                      </a>
                    </li>
                  ))}
                  <li className={`page-item ${currentPage >= totalPages ? "disabled" : ""}`}>
                    <a
                      className="page-link"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(Math.min(totalPages, currentPage + 1));
                      }}
                    >
                      &raquo;
                    </a>
                  </li>
                </ul>
              </nav>
              <div className="text-muted small mt-2">
                Pagina {currentPage} di {totalPages} • {totalRows} preordini totali
              </div>
            </>
          ) : totalRows > 0 ? (
            <div className="text-muted small mt-2">{totalRows} preordini trovati.</div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
