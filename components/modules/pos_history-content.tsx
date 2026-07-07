"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

// Faithful port of the PHP movements page (app/pages/pos_history.php), fed by
// the existing DB-backed /api/manage/pos context (sales + catalog + locations).

// One "Movimenti" row (mirror of the backend PosMovement): a sale, a standalone recharge,
// or a standalone giftbox/giftcard voucher. The content flags let the sidebar Servizi/Prodotti/
// Pacchetti + Tipologia filters narrow the list client-side.
type PosMovement = {
  kind: "sale" | "recharge" | "giftbox" | "giftcard";
  kindLabel: string;
  id: number;
  saleNumber: number;
  numberLabel: string;
  locationId: number;
  clientId: number;
  clientName: string;
  amount: number | null;
  status: string;
  operator: string;
  date: string;
  hasService: boolean;
  hasProduct: boolean;
  hasPackage: boolean;
  serviceIds: number[];
  productIds: number[];
  hasGiftcardLine: boolean;
  hasGiftboxLine: boolean;
  hasRechargeLine: boolean;
};

type CatalogItem = { id: number; name: string };

type PosContext = {
  activeLocationId?: number;
  movements?: PosMovement[];
  catalog?: {
    clients?: CatalogItem[];
    services?: CatalogItem[];
    products?: CatalogItem[];
    packages?: CatalogItem[];
  };
  locations?: Array<{ id: number; name: string }>;
};

const MOVEMENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "giftcard", label: "GiftCard" },
  { value: "recharge", label: "Ricarica" },
  { value: "giftbox", label: "GiftBox" },
];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDateTime(value?: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  const d = value.slice(0, 10);
  const [y, mo, day] = d.split("-");
  return day && mo && y ? `${day}/${mo}/${y}` : value;
}

function fmtMoney(value: number): string {
  return `${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

// Per-kind action link (faithful to pos_history.php ~3808-3818): a sale opens "Dettaglio
// vendita"; a giftbox/giftcard opens its "Voucher"; a standalone recharge opens "Apri" ->
// the client's credit movements.
function renderMovementAction(mv: PosMovement, slug: string): ReactNode {
  const base = `/${encodeURIComponent(slug)}`;
  if (mv.kind === "sale") {
    return (
      <a className="btn btn-sm btn-outline-primary" href={`${base}/pos_sale_detail?id=${mv.id}`}>
        Dettaglio vendita
      </a>
    );
  }
  if (mv.kind === "giftbox") {
    return (
      <a className="btn btn-sm btn-outline-primary" href={`${base}/giftbox_voucher?id=${mv.id}&embed=1`} target="_blank" rel="noopener">
        Voucher
      </a>
    );
  }
  if (mv.kind === "giftcard") {
    return (
      <a className="btn btn-sm btn-outline-primary" href={`${base}/giftcard_voucher?id=${mv.id}&embed=1`} target="_blank" rel="noopener">
        Voucher
      </a>
    );
  }
  // recharge
  return (
    <a className="btn btn-sm btn-outline-primary" href={`${base}/credit_movements?client_id=${mv.clientId}`}>
      Apri
    </a>
  );
}

export function PosHistoryContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [loading, setLoading] = useState(true);

  // Filter state (kept working client-side over the loaded movements).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saleNumber, setSaleNumber] = useState("");
  const [clientIds, setClientIds] = useState<Set<string>>(new Set());
  const [serviceIds, setServiceIds] = useState<Set<string>>(new Set());
  const [productIds, setProductIds] = useState<Set<string>>(new Set());
  const [packageIds, setPackageIds] = useState<Set<string>>(new Set());
  const [movementTypes, setMovementTypes] = useState<Set<string>>(new Set());
  const [clientSearch, setClientSearch] = useState("");
  const [serviceSearch, setServiceSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    // #11: l'intervallo data viene passato al SERVER (from/to) cosi' il LIMIT si applica DOPO
    // il filtro — una ricerca per data profonda non viene piu' troncata dalle 250 vendite piu'
    // recenti. Gli altri filtri (tipo/cliente/servizio) restano un raffinamento client-side.
    const params = new URLSearchParams({ slug });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    fetch(`/api/manage/pos?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: PosContext) => setCtx(j ?? null))
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug, from, to]);

  const clients = ctx?.catalog?.clients ?? [];
  const services = ctx?.catalog?.services ?? [];
  const products = ctx?.catalog?.products ?? [];
  const packages = ctx?.catalog?.packages ?? [];
  const locations = ctx?.locations ?? [];
  const movements = useMemo(() => ctx?.movements ?? [], [ctx]);

  const activeLocationName = useMemo(() => {
    const id = ctx?.activeLocationId;
    return locations.find((l) => l.id === id)?.name ?? "";
  }, [ctx, locations]);

  const locationById = useMemo(() => {
    const map: Record<number, string> = {};
    for (const l of locations) map[l.id] = l.name;
    return map;
  }, [locations]);

  function toggle(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const filteredMovements = useMemo(() => {
    // Mutually-exclusive filter precedence (faithful to pos_history.php ~1904-1913): a Tipologia
    // filter disables Servizi/Prodotti/Pacchetti; Servizi disables Prodotti/Pacchetti; Prodotti
    // disables Pacchetti. So at most one content dimension is active at a time.
    const hasMovementType = movementTypes.size > 0;
    const useServices = !hasMovementType && serviceIds.size > 0;
    const useProducts = !hasMovementType && !useServices && productIds.size > 0;
    const usePackages = !hasMovementType && !useServices && !useProducts && packageIds.size > 0;
    const saleNumberTrim = saleNumber.trim();

    return movements.filter((mv) => {
      // A specific sale-number filter isolates that single sale (standalone rows are hidden,
      // matching the legacy $saleNumberFilter branch which skips sections 2-4).
      if (saleNumberTrim) {
        if (mv.kind !== "sale" || String(mv.saleNumber) !== saleNumberTrim) return false;
      }
      if (clientIds.size > 0 && !clientIds.has(String(mv.clientId))) return false;
      const day = mv.date?.slice(0, 10) ?? "";
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;

      // Tipologia gating: keep only the selected movement kinds. A sale matches if it CONTAINS a
      // line of that kind (composite label), a standalone voucher/recharge matches its own kind.
      if (hasMovementType) {
        const matches =
          (movementTypes.has("giftcard") && (mv.kind === "giftcard" || mv.hasGiftcardLine)) ||
          (movementTypes.has("giftbox") && (mv.kind === "giftbox" || mv.hasGiftboxLine)) ||
          (movementTypes.has("recharge") && (mv.kind === "recharge" || mv.hasRechargeLine));
        if (!matches) return false;
      }

      // Servizi/Prodotti/Pacchetti: the sale must CONTAIN a matching line (standalone rows have
      // no such lines, so they drop out — faithful to the sale-only EXISTS filters ~2223-2276).
      if (useServices) {
        if (mv.kind !== "sale") return false;
        if (![...serviceIds].some((id) => mv.serviceIds.includes(Number(id)))) return false;
      }
      if (useProducts) {
        if (mv.kind !== "sale") return false;
        if (![...productIds].some((id) => mv.productIds.includes(Number(id)))) return false;
      }
      if (usePackages) {
        // No per-package id on the movement (packages issue no id-bearing line here), so match
        // any sale that contains a package line when a package filter is active.
        if (mv.kind !== "sale" || !mv.hasPackage) return false;
      }
      return true;
    });
  }, [movements, saleNumber, clientIds, serviceIds, productIds, packageIds, movementTypes, from, to]);

  const visibleMovements = filteredMovements.slice(0, 200);

  const clientFilterText = clientSearch.trim().toLowerCase();
  const serviceFilterText = serviceSearch.trim().toLowerCase();

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/pos_history.css" />

      <div className="container-fluid">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Pagamenti</div>
            <h1 className="bs-page-title">Movimenti</h1>
            <div className="bs-page-subtitle">
              Elenco degli elementi creati dalla pagina Pagamenti: vendite, ricariche, GiftBox e buoni.
            </div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/pos`}>
                <i className="bi bi-arrow-left"></i> Torna a Pagamenti
              </a>
            </div>
          </div>
        </div>

        <div className="pos-movements-layout">
          <form
            className="card pos-movements-filter"
            method="get"
            onSubmit={(e) => e.preventDefault()}
          >
            <input type="hidden" name="page" value="pos_history" />

            <div className="pos-filter-head">
              <div>
                <div className="fw-semibold">Filtri</div>
                <div className="text-muted small">Movimenti vendita</div>
              </div>
              <a
                className="btn btn-sm btn-outline-secondary"
                href={`/${encodeURIComponent(slug)}/pos_history`}
                title="Azzera filtri"
              >
                <i className="bi bi-arrow-counterclockwise"></i>
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
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div className="col-6">
                  <label className="form-label small text-muted">A</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    name="to"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="pos-filter-block">
              <label className="pos-filter-title" htmlFor="posMovementSaleNumber">
                Numero vendita
              </label>
              <input
                id="posMovementSaleNumber"
                type="number"
                min={1}
                step={1}
                className="form-control form-control-sm"
                name="sale_number"
                value={saleNumber}
                onChange={(e) => setSaleNumber(e.target.value)}
                placeholder="Es. 237"
              />
            </div>

            <div className="pos-filter-block">
              <div className="pos-filter-title">Filtri attivi</div>
              <div className="pos-active-filters">
                {activeLocationName ? (
                  <span className="badge text-bg-light border">Sede: {activeLocationName}</span>
                ) : null}
              </div>
            </div>

            <details className="pos-filter-group" open>
              <summary>
                <span>Clienti</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="pos-filter-search-wrap">
                  <i className="bi bi-search"></i>
                  <input
                    type="text"
                    className="form-control form-control-sm pos-filter-search"
                    data-filter-target="#posMovClientList"
                    placeholder="Filtra clienti"
                    autoComplete="off"
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                  />
                </div>
                <div className="pos-filter-check-list" id="posMovClientList">
                  {clients.length === 0 ? (
                    <div className="text-muted small">Nessun cliente disponibile.</div>
                  ) : (
                    clients
                      .filter((c) => !clientFilterText || c.name.toLowerCase().includes(clientFilterText))
                      .map((c) => (
                        <label
                          className="pos-filter-check"
                          data-filter-option
                          data-filter-text={c.name.toLowerCase()}
                          key={c.id}
                        >
                          <input
                            className="form-check-input"
                            type="checkbox"
                            name="client_id[]"
                            value={c.id}
                            checked={clientIds.has(String(c.id))}
                            onChange={() => toggle(clientIds, String(c.id), setClientIds)}
                          />
                          <span>{c.name}</span>
                        </label>
                      ))
                  )}
                </div>
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Servizi</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="text-muted small mb-2">Vendite che includono i servizi selezionati.</div>
                <div className="pos-filter-search-wrap">
                  <i className="bi bi-search"></i>
                  <input
                    type="text"
                    className="form-control form-control-sm pos-filter-search"
                    data-filter-target="#posMovServiceList"
                    placeholder="Filtra servizi"
                    autoComplete="off"
                    value={serviceSearch}
                    onChange={(e) => setServiceSearch(e.target.value)}
                  />
                </div>
                <div className="pos-filter-check-list" id="posMovServiceList">
                  {services.length === 0 ? (
                    <div className="text-muted small">Nessun servizio disponibile.</div>
                  ) : (
                    services
                      .filter((s) => !serviceFilterText || s.name.toLowerCase().includes(serviceFilterText))
                      .map((s) => (
                        <label
                          className="pos-filter-check"
                          data-filter-option
                          data-filter-text={s.name.toLowerCase()}
                          key={s.id}
                        >
                          <input
                            className="form-check-input"
                            type="checkbox"
                            name="service_id[]"
                            value={s.id}
                            checked={serviceIds.has(String(s.id))}
                            onChange={() => toggle(serviceIds, String(s.id), setServiceIds)}
                          />
                          <span>{s.name}</span>
                        </label>
                      ))
                  )}
                </div>
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Prodotti</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="text-muted small mb-2">Vendite che includono i prodotti selezionati.</div>
                {products.length === 0 ? (
                  <div className="text-muted small">Nessun prodotto disponibile.</div>
                ) : (
                  <div className="pos-filter-check-list" id="posMovProductList">
                    {products.map((p) => (
                      <label
                        className="pos-filter-check"
                        data-filter-option
                        data-filter-text={p.name.toLowerCase()}
                        key={p.id}
                      >
                        <input
                          className="form-check-input"
                          type="checkbox"
                          name="product_id[]"
                          value={p.id}
                          checked={productIds.has(String(p.id))}
                          onChange={() => toggle(productIds, String(p.id), setProductIds)}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Pacchetti</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="text-muted small mb-2">Vendite che includono i pacchetti selezionati.</div>
                {packages.length === 0 ? (
                  <div className="text-muted small">Nessun pacchetto disponibile.</div>
                ) : (
                  <div className="pos-filter-check-list" id="posMovPackageList">
                    {packages.map((pk) => (
                      <label
                        className="pos-filter-check"
                        data-filter-option
                        data-filter-text={pk.name.toLowerCase()}
                        key={pk.id}
                      >
                        <input
                          className="form-check-input"
                          type="checkbox"
                          name="package_id[]"
                          value={pk.id}
                          checked={packageIds.has(String(pk.id))}
                          onChange={() => toggle(packageIds, String(pk.id), setPackageIds)}
                        />
                        <span>{pk.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </details>

            <details className="pos-filter-group">
              <summary>
                <span>Tipologia</span>
              </summary>
              <div className="pos-filter-group-body">
                <div className="pos-filter-check-list">
                  {MOVEMENT_TYPES.map((mt) => (
                    <label className="pos-filter-check" key={mt.value}>
                      <input
                        className="form-check-input"
                        type="checkbox"
                        name="movement_type[]"
                        value={mt.value}
                        checked={movementTypes.has(mt.value)}
                        onChange={() => toggle(movementTypes, mt.value, setMovementTypes)}
                      />
                      <span>{mt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </details>

            <div className="pos-filter-actions">
              <button className="btn btn-primary w-100" type="submit">
                <i className="bi bi-search"></i> Filtra
              </button>
            </div>
          </form>

          <section className="pos-movements-results">
            <div className="card p-3 mb-3 d-none">
              <form className="row g-2 align-items-end" method="get" onSubmit={(e) => e.preventDefault()}>
                <input type="hidden" name="page" value="pos_history" />

                <div className="col-12 col-lg-3">
                  <label className="form-label">Cliente</label>
                  <div className="app-combobox dropdown" id="posMovementClientFilterBox">
                    <button
                      className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
                      type="button"
                      data-bs-toggle="dropdown"
                      aria-expanded="false"
                    >
                      <span className="app-combobox-text d-none"></span>
                      <span className="text-muted app-combobox-placeholder">Tutti</span>
                    </button>
                    <div className="dropdown-menu p-2 w-100">
                      <input
                        type="text"
                        className="form-control form-control-sm app-combobox-search"
                        placeholder="Cerca…"
                        autoComplete="off"
                      />
                      <div className="app-combobox-list mt-2"></div>
                    </div>
                    <input type="hidden" name="client_id" value="" />
                  </div>
                </div>

                <div className="col-12 col-md-6 col-lg-2">
                  <label className="form-label">Numero vendita</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="form-control"
                    name="sale_number"
                    value=""
                    readOnly
                    placeholder="Es. 237"
                  />
                </div>

                <div className="col-12 col-md-6 col-lg-2">
                  <label className="form-label">Servizio</label>
                  <select name="service_id" className="form-select" defaultValue="">
                    <option value="">Tutti</option>
                    {services.map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-12 col-md-6 col-lg-3">
                  <label className="form-label">Prodotto</label>
                  <select name="product_id" className="form-select" disabled defaultValue="">
                    <option value="">Tutti</option>
                    {products.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-6 col-md-3 col-lg-2">
                  <label className="form-label">Da</label>
                  <input type="date" className="form-control" name="from" value="" readOnly />
                </div>
                <div className="col-6 col-md-3 col-lg-2">
                  <label className="form-label">A</label>
                  <input type="date" className="form-control" name="to" value="" readOnly />
                </div>

                <div className="col-12 col-md-3 col-lg-2 d-flex gap-2 align-items-end">
                  <button className="btn btn-primary w-100" type="submit">
                    <i className="bi bi-search"></i> Filtra
                  </button>
                  <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/pos_history`}>
                    <i className="bi bi-arrow-counterclockwise"></i>
                  </a>
                </div>
              </form>
            </div>

            <div className="card">
              <div className="table-responsive">
                <table className="table table-hover align-middle mb-0">
                  <thead>
                    <tr>
                      <th className="pos-cronologia-sale-number-col">Numero vendita</th>
                      <th>Cliente</th>
                      <th className="pos-cronologia-location-col">Sede</th>
                      <th className="pos-cronologia-date-col">Data</th>
                      <th>Operatore</th>
                      <th className="text-end pos-cronologia-amount-col">Importo</th>
                      <th className="pos-cronologia-status-col">Stato</th>
                      <th className="text-end pos-cronologia-actions-col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMovements.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="text-center text-muted py-4">
                          {loading ? "Caricamento…" : "Nessun risultato."}
                        </td>
                      </tr>
                    ) : (
                      visibleMovements.map((mv) => {
                        const numberStr = mv.numberLabel || (mv.saleNumber > 0 ? String(mv.saleNumber) : "—");
                        const statusKey = mv.status.toLowerCase();
                        let badgeClass = "text-bg-secondary";
                        if (statusKey === "attiva") badgeClass = "text-bg-success";
                        else if (statusKey === "annullata" || statusKey === "stornata") badgeClass = "text-bg-danger";
                        return (
                          <tr key={`${mv.kind}-${mv.id}`}>
                            <td className="pos-cronologia-sale-number-col text-muted small">{numberStr}</td>
                            <td>{mv.clientName || "—"}</td>
                            <td className="pos-cronologia-location-col text-muted small">
                              {locationById[mv.locationId] ?? "—"}
                            </td>
                            <td className="pos-cronologia-date-col text-muted small">{fmtDateTime(mv.date)}</td>
                            <td className="text-muted small">{mv.operator || "—"}</td>
                            <td className="text-end pos-cronologia-amount-col fw-semibold">
                              {mv.amount === null ? "—" : fmtMoney(mv.amount)}
                            </td>
                            <td className="pos-cronologia-status-col">
                              {mv.status ? (
                                <span className={`badge ${badgeClass}`}>{mv.status}</span>
                              ) : (
                                <span className="text-muted small">—</span>
                              )}
                            </td>
                            <td className="text-end pos-cronologia-actions-col">{renderMovementAction(mv, slug)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="text-muted small mt-2">Mostrati max 200 risultati (ordinati per data decrescente).</div>
          </section>
        </div>
      </div>
    </div>
  );
}
