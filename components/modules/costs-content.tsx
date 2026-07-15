"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP "Scadenziario e Costi" page (app/pages/costs.php,
// scadenziario tab), fed by the existing DB-backed /api/manage/costs.
// Le azioni riga (Segna pagato / Elimina) e il bulk POSTano all'API e mostrano i
// flash legacy ("Stato aggiornato", "Costo eliminato", "Voci eliminate"); i
// filtri sono un form con submit "Filtra" (i controlli modificano un draft che
// diventa attivo solo al submit, come il GET legacy) e la query iniziale arriva
// dal router come prop (?from/to/status/cat/q, parità con $_GET).

type CostRow = {
  id: number;
  title: string;
  categoryId: number | null;
  categoryName: string;
  categoryColor: string;
  supplierId: number | null;
  supplierName: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  vatPercent: number | null;
  dueDate: string;
  status: "open" | "overdue" | "paid";
  isPaid: boolean;
  isPartial: boolean;
  paidAt: string;
  paymentMethod: string;
  docNumber: string;
  docDate: string;
  notes: string;
  isRecurring: boolean;
  recurrenceInterval: number;
  recurrenceUnit: string;
  recurrenceEndDate: string;
  locationId: number | null;
  locationName: string;
  attachmentName: string;
};

type CostCategory = {
  id: number;
  name: string;
  color: string;
  isActive: boolean;
  costCount: number;
};

type CostLocation = { id: number; name: string; isActive: boolean };

type CostsSummary = {
  open: number;
  overdue: number;
  paid: number;
  dueAmount: number;
  overdueAmount: number;
  paidAmount: number;
  remainingAmount: number;
};

type CostsResponse = {
  ok?: boolean;
  error?: string;
  summary?: CostsSummary;
  costs?: CostRow[];
  categories?: CostCategory[];
  locations?: CostLocation[];
  hasAnyCosts?: boolean;
};

export type CostsQuery = {
  from?: string;
  to?: string;
  status?: string;
  cat?: string;
  q?: string;
};

type Filters = { cat: string; from: string; to: string; status: string; q: string; allLocations: boolean };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number): string {
  // number_format($n, 2, ',', '.') manuale: toLocaleString('it-IT') NON raggruppa
  // 1000-9999 (CLDR minimumGroupingDigits=2), il legacy sì ("1.234,56").
  const value = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

function fmtDate(d?: string): string {
  const raw = (d ?? "").slice(0, 10);
  if (!raw || raw === "0000-00-00") return "";
  const [y, m, day] = raw.split("-");
  return day && m && y ? `${day}/${m}/${y}` : raw;
}

function firstOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function lastOfMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// I filtri legacy dalla query GET (status whitelist open|overdue|paid|all -> open).
function filtersFromQuery(q: CostsQuery): Filters {
  const status = String(q.status ?? "open").trim();
  const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
  return {
    cat: String(Number.parseInt(String(q.cat ?? "0"), 10) || 0),
    from: isDate(q.from) ? String(q.from) : firstOfMonth(),
    to: isDate(q.to) ? String(q.to) : lastOfMonth(),
    status: ["open", "overdue", "paid", "all"].includes(status) ? status : "open",
    q: String(q.q ?? "").trim(),
    allLocations: String((q as Record<string, unknown>).all_locations ?? "") === "1",
  };
}

// Accent-insensitive lowercase (norm() del combobox in assets/js/pages/costs.js).
function comboNorm(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function CostsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CostsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState<Filters>(() => filtersFromQuery(initialQuery ?? {}));

  const [costs, setCosts] = useState<CostRow[]>([]);
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [locations, setLocations] = useState<CostLocation[]>([]);
  const [hasAnyCosts, setHasAnyCosts] = useState(true);
  const [summary, setSummary] = useState<CostsSummary>({
    open: 0,
    overdue: 0,
    paid: 0,
    dueAmount: 0,
    overdueAmount: 0,
    paidAmount: 0,
    remainingAmount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Draft dei filtri (i controlli del form); i valori APPLICATI viaggiano in load().
  const [cat, setCat] = useState(initial.cat);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [status, setStatus] = useState(initial.status);
  const [q, setQ] = useState(initial.q);
  const [allLoc, setAllLoc] = useState(initial.allLocations);
  const appliedRef = useRef<Filters>(initial);
  // Copia REATTIVA dei filtri applicati (appliedRef non ri-renderizza): guida
  // il Reset condizionale e il '· filtri attivi' (restyle 2026-07-15). I
  // default (range mese corrente, stato 'open') NON contano come filtro attivo.
  const [appliedView, setAppliedView] = useState<Filters>(initial);
  const [filterDefaults] = useState<Filters>(() => ({ cat: "", from: firstOfMonth(), to: lastOfMonth(), status: "open", q: "", allLocations: false }));
  const filtersActive =
    appliedView.cat !== filterDefaults.cat ||
    appliedView.from !== filterDefaults.from ||
    appliedView.to !== filterDefaults.to ||
    appliedView.status !== filterDefaults.status ||
    appliedView.q !== filterDefaults.q ||
    appliedView.allLocations !== filterDefaults.allLocations;

  // Flash legacy (?msg / ?err dopo i redirect): success sopra, danger sotto.
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  // Legge il flash dai query param dopo un redirect (es. dal form costo: ?msg=Costo%20creato)
  // e ripulisce l'URL, come il legacy che mostra $_GET['msg']/['err'].
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const msg = sp.get("msg") ?? "";
    const err = sp.get("err") ?? "";
    if (msg) setFlash(msg);
    if (err) setError(err);
    if (msg || err) {
      sp.delete("msg");
      sp.delete("err");
      const qs = sp.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, []);

  // Bulk selection (scadenziario): the checked cost ids for "Elimina selezionati".
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Per-row detail ("Riepilogo") modal (faithful to the legacy cost summary modal).
  const [detailCost, setDetailCost] = useState<CostRow | null>(null);

  // Fetch puro (i setState avvengono nei callback della Promise): usato dal
  // mount (loading è già true di default) e da load() negli event handler.
  const fetchData = useCallback(
    (filters: Filters) => {
      appliedRef.current = filters;
      const params = new URLSearchParams({
        slug,
        cat: filters.cat,
        from: filters.from,
        to: filters.to,
        status: filters.status,
        q: filters.q,
      });
      if (filters.allLocations) params.set("all_locations", "1");
      fetch(`/api/manage/costs?${params.toString()}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j: CostsResponse) => {
          setCosts(Array.isArray(j.costs) ? j.costs : []);
          setCategories(Array.isArray(j.categories) ? j.categories : []);
          setLocations(Array.isArray(j.locations) ? j.locations : []);
          if (typeof j.hasAnyCosts === "boolean") setHasAnyCosts(j.hasAnyCosts);
          if (j.summary) setSummary(j.summary);
        })
        .catch(() => {
          setCosts([]);
        })
        .finally(() => {
          setLoading(false);
          setLoaded(true);
        });
    },
    [slug],
  );

  const load = useCallback(
    (filters: Filters) => {
      setLoading(true);
      fetchData(filters);
    },
    [fetchData],
  );

  useEffect(() => {
    fetchData(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`costs${suffix}`.replace("&", "?")}`;
  }

  // Applica il draft (submit "Filtra") e riscrive l'URL come il GET legacy.
  function applyFilters() {
    const filters: Filters = { cat, from, to, status, q, allLocations: allLoc };
    // Aggiornato QUI (event handler) e non in fetchData: un setState sincrono
    // nell'effect di mount violerebbe react-hooks/set-state-in-effect; al mount
    // appliedView è già inizializzato con gli stessi filtri iniziali.
    setAppliedView(filters);
    load(filters);
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ tab: "scadenziario", cat: filters.cat, from: filters.from, to: filters.to, status: filters.status, q: filters.q });
      if (filters.allLocations) sp.set("all_locations", "1");
      window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    }
  }

  async function postAction(payload: Record<string, unknown>): Promise<CostsResponse> {
    try {
      // In "Tutte le sedi" le mutazioni (toggle/delete/bulk) devono agire nello stesso scope
      // multi-sede della vista, altrimenti un costo di sede non-corrente darebbe "Costo non trovato".
      const body = appliedRef.current?.allLocations && payload.all_locations === undefined
        ? { ...payload, all_locations: "1" }
        : payload;
      const res = await fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      return { ...j, ok: res.ok && j.ok !== false };
    } catch {
      return { ok: false, error: "Errore di rete." };
    }
  }

  // Segna pagato / non pagato (legacy action=toggle&kind=paid, senza conferma):
  // flash "Stato aggiornato" e lista ricaricata con i filtri correnti.
  async function togglePaid(id: number) {
    setFlash("");
    setError("");
    const j = await postAction({ action: "toggle_paid", id: String(id) });
    if (!j.ok) {
      setError(String(j.error ?? "Errore: stato non aggiornato"));
      return;
    }
    setFlash("Stato aggiornato");
    load(appliedRef.current);
  }

  // Elimina voce (legacy action=delete&kind=cost): conferma + flash verbatim.
  async function deleteCost(id: number) {
    if (typeof window !== "undefined" && !window.confirm("Eliminare definitivamente questa voce? Questa operazione non puo essere annullata.")) return;
    setFlash("");
    setError("");
    const j = await postAction({ action: "delete", id: String(id) });
    if (!j.ok) {
      setError(String(j.error ?? "Errore: impossibile eliminare costo"));
      return;
    }
    setFlash("Costo eliminato");
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    load(appliedRef.current);
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Bulk-delete (legacy bulk_delete_costs, confirm del form data-confirm-submit).
  async function bulkDelete() {
    if (selected.size === 0 || bulkBusy) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare definitivamente le voci selezionate? Questa operazione non puo essere annullata.")) return;
    setBulkBusy(true);
    setFlash("");
    setError("");
    try {
      const j = await postAction({ action: "bulk_delete_costs", cost_ids: JSON.stringify([...selected]) });
      if (!j.ok) {
        setError(String(j.error ?? "Errore: impossibile eliminare le voci"));
        return;
      }
      setFlash("Voci eliminate");
      setSelected(new Set());
      load(appliedRef.current);
    } finally {
      setBulkBusy(false);
    }
  }

  const allSelected = costs.length > 0 && selected.size === costs.length;
  const masterRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = selected.size > 0 && selected.size < costs.length;
  }, [selected, costs.length]);

  const showLocationCol = locations.length > 1;
  const empty = loaded && !hasAnyCosts;

  const exportBase = `/api/manage/costs?slug=${encodeURIComponent(slug)}&action=export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=${encodeURIComponent(status)}&cat=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}`;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/costs.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Amministrazione</div>
          <h1 className="bs-page-title">Scadenziario e Costi</h1>
          <div className="bs-page-subtitle">Gestisci scadenze, costi e categorie operative.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {hasAnyCosts ? (
              <a className="btn btn-primary" href={href("&tab=scadenziario&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo costo
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <ul className="nav nav-tabs costs-tabs mb-3">
        <li className="nav-item">
          <a className="nav-link active" href={href("&tab=scadenziario")}>
            <i className="bi bi-calendar2-check me-1" />
            Scadenziario
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link " href={href("&tab=categories")}>
            <i className="bi bi-tags me-1" />
            Categorie
          </a>
        </li>
      </ul>

      {empty ? (
        <div className="card border-0 shadow-sm costs-empty-card">
          <div className="costs-empty-state">
            <div className="costs-empty-icon" aria-hidden="true">
              <i className="bi bi-calendar2-check" />
            </div>
            <h2>Nessun costo registrato</h2>
            <p>
              Lo scadenziario e ancora vuoto. Aggiungi il primo costo per monitorare scadenze, pagamenti e fornitori
              della sede selezionata.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&tab=scadenziario&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo costo
              </a>
              <a className="btn btn-outline-secondary" href={href("&tab=categories")}>
                <i className="bi bi-tags me-1" />
                Categorie
              </a>
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
              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">Categoria</label>
                <CategoryFilterCombobox
                  boxId="costCategoryFilterBox"
                  categories={categories}
                  value={cat}
                  onChange={setCat}
                />
              </div>

              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">Da</label>
                <input className="form-control" type="date" name="from" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">A</label>
                <input className="form-control" type="date" name="to" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">Stato</label>
                <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="open">Da pagare</option>
                  <option value="overdue">Scaduto</option>
                  <option value="paid">Pagati</option>
                  <option value="all">Tutti</option>
                </select>
              </div>
              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">Cerca</label>
                <input
                  className="form-control"
                  name="q"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Titolo / documento"
                />
              </div>
              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit come il GET legacy), Filtra pieno a larghezza
                  naturale (via il flex-grow effetto search-bar), Reset visibile solo
                  con filtri non-default. */}
              {locations.length > 1 ? (
                <div className="col-12 col-lg-auto d-flex align-items-center align-self-stretch">
                  <div className="form-check form-switch mb-0">
                    {/* "Tutte le sedi" (port del checkbox legacy all_locations): mostra i costi di
                        tutte le sedi permesse invece della sola corrente. Applicato su "Filtra". */}
                    <input className="form-check-input" type="checkbox" role="switch" id="costsAllLocations" name="all_locations" checked={allLoc} onChange={(e) => setAllLoc(e.target.checked)} />
                    <label className="form-check-label" htmlFor="costsAllLocations">Tutte le sedi</label>
                  </div>
                </div>
              ) : null}
              {/* col-auto: il bottone si accoda ai campi (leggero distacco ms-lg-2)
                  invece di galleggiare in una colonna fissa di griglia. */}
              <div className="col-12 col-lg-auto d-flex align-items-center align-self-stretch gap-2 ms-lg-2">
                <button className="btn btn-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {filtersActive ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={href("&tab=scadenziario")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-md-4">
              <div className="card p-3">
                <div className="small text-muted">Scaduti</div>
                <div className="h4 fw-bold m-0">€ {fmtMoney(summary.overdueAmount)}</div>
              </div>
            </div>
            <div className="col-md-4">
              <div className="card p-3">
                <div className="small text-muted">In scadenza</div>
                <div className="h4 fw-bold m-0">€ {fmtMoney(summary.dueAmount)}</div>
              </div>
            </div>
            <div className="col-md-4">
              <div className="card p-3">
                <div className="small text-muted">Pagati</div>
                <div className="h4 fw-bold m-0">€ {fmtMoney(summary.paidAmount)}</div>
              </div>
            </div>
          </div>

          <div className="card p-3">
            <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
              <div className="fw-semibold">
                Voci{" "}
                <span className="text-muted small fw-normal">
                  {loading ? "· caricamento…" : `· ${costs.length === 1 ? "1 voce" : `${costs.length} voci`}`}
                  {!loading && filtersActive ? " · filtri attivi" : ""}
                </span>
              </div>
              <div className="d-flex gap-2">
                <a className="btn btn-sm btn-outline-secondary" href={`${exportBase}&format=csv`}>
                  <i className="bi bi-download me-1" />
                  CSV
                </a>
                <a className="btn btn-sm btn-outline-secondary" href={`${exportBase}&format=pdf`}>
                  <i className="bi bi-file-earmark-pdf me-1" />
                  PDF
                </a>
                <a className="btn btn-sm btn-outline-primary" href={href("&tab=scadenziario&action=new")}>
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi costo
                </a>
              </div>
            </div>

            {costs.length === 0 ? (
              <div className="text-muted">
                {loading ? "Caricamento…" : "Nessuna voce trovata con i filtri selezionati."}
              </div>
            ) : (
              <div>
                <div className="d-flex justify-content-end mb-2">
                  <button
                    className="btn btn-sm btn-outline-danger"
                    type="button"
                    disabled={selected.size === 0 || bulkBusy}
                    onClick={bulkDelete}
                  >
                    <i className="bi bi-trash me-1" />
                    Elimina selezionati
                  </button>
                </div>
                <div className="table-responsive">
                  <table className="table align-middle mb-0">
                    <thead>
                      <tr>
                        <th className="costs-bulk-col">
                          <input
                            ref={masterRef}
                            className="form-check-input"
                            type="checkbox"
                            aria-label="Seleziona tutti"
                            checked={allSelected}
                            onChange={() => setSelected(allSelected ? new Set() : new Set(costs.map((c) => c.id)))}
                          />
                        </th>
                        <th>Scadenza</th>
                        <th>Titolo</th>
                        <th>Categoria</th>
                        <th>Fornitore</th>
                        {showLocationCol ? <th>Sede</th> : null}
                        <th className="text-end">Totale</th>
                        <th className="text-end">Pagato</th>
                        <th className="text-end">Residuo</th>
                        <th>Stato</th>
                        <th className="text-end">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {costs.map((r) => {
                        const overdue = r.status === "overdue";
                        return (
                          <tr key={r.id} className={overdue ? "table-danger" : ""}>
                            <td>
                              <input
                                className="form-check-input"
                                type="checkbox"
                                aria-label={`Seleziona ${r.title}`}
                                checked={selected.has(r.id)}
                                onChange={() => toggleSelected(r.id)}
                              />
                            </td>
                            <td className="costs-nowrap">
                              <div className="fw-semibold">{fmtDate(r.dueDate)}</div>
                              {r.isRecurring ? <div className="small text-muted">Ricorrente</div> : null}
                            </td>
                            <td>
                              <div className="fw-semibold">{r.title}</div>
                              {r.docNumber ? <div className="small text-muted">Doc: {r.docNumber}</div> : null}
                              {r.attachmentName ? (
                                <div className="small">
                                  {/* Download via presigned R2 (la route verifica sessione+
                                      tenant e redirige all'URL firmato a scadenza breve). */}
                                  <a
                                    className="text-muted"
                                    href={`/api/manage/cost-attachment?slug=${encodeURIComponent(slug)}&id=${r.id}`}
                                    target="_blank"
                                    rel="noopener"
                                  >
                                    <i className="bi bi-paperclip me-1" />
                                    {r.attachmentName}
                                  </a>
                                </div>
                              ) : null}
                            </td>
                            <td>
                              {r.categoryName ? (
                                <span
                                  className="badge costs-color-badge"
                                  data-cost-color={r.categoryColor || "#6c757d"}
                                  style={{ backgroundColor: r.categoryColor || "#6c757d" }}
                                >
                                  {r.categoryName}
                                </span>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td>{r.supplierName ? r.supplierName : <span className="text-muted">—</span>}</td>
                            {showLocationCol ? (
                              <td>{r.locationName ? r.locationName : <span className="text-muted">—</span>}</td>
                            ) : null}
                            <td className="text-end">€ {fmtMoney(r.amount)}</td>
                            <td className="text-end">€ {fmtMoney(r.paidAmount)}</td>
                            <td className="text-end">€ {fmtMoney(r.remainingAmount)}</td>
                            <td>
                              {r.isPaid ? (
                                <span className="badge text-bg-success">Pagato</span>
                              ) : overdue ? (
                                <span className="badge text-bg-danger">Scaduto</span>
                              ) : (
                                <span className="badge text-bg-warning">Da pagare</span>
                              )}
                            </td>
                            <td className="text-end costs-nowrap">
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary js-cost-summary"
                                title="Riepilogo"
                                onClick={() => setDetailCost(r)}
                              >
                                <i className="bi bi-eye" />
                              </button>{" "}
                              <a
                                className="btn btn-sm btn-outline-secondary"
                                href={href(`&tab=scadenziario&action=edit&id=${r.id}`)}
                                title="Modifica"
                              >
                                <i className="bi bi-pencil" />
                              </a>{" "}
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-success"
                                title="Segna pagato / non pagato"
                                onClick={() => togglePaid(r.id)}
                              >
                                <i className="bi bi-check2-circle" />
                              </button>{" "}
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-danger"
                                title="Elimina"
                                onClick={() => deleteCost(r.id)}
                              >
                                <i className="bi bi-trash" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Modal "Riepilogo costo" — port del costSummaryModal legacy: modal-lg
          scrollable, campi in row g-3 SEMPRE presenti con "-" per i vuoti,
          Note in box grigio, link Allegato in coda, nessun footer. */}
      {detailCost ? (
        <>
          <div className="modal fade show" id="costSummaryModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-lg modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Riepilogo costo</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDetailCost(null)} />
                </div>
                <div className="modal-body">
                  <div className="row g-3">
                    <div className="col-md-6">
                      <div className="small text-muted">Titolo</div>
                      <div className="fw-semibold">{detailCost.title || "-"}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="small text-muted">Scadenza</div>
                      <div className="fw-semibold">{fmtDate(detailCost.dueDate) || "-"}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="small text-muted">Stato</div>
                      <div className="fw-semibold">
                        {detailCost.isPaid ? "Pagato" : detailCost.status === "overdue" ? "Scaduto" : "Da pagare"}
                      </div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Sede</div>
                      <div>{detailCost.locationName || "-"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Categoria</div>
                      <div>{detailCost.categoryName || "-"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Fornitore</div>
                      <div>{detailCost.supplierName || "-"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Ricorrente</div>
                      <div>{detailCost.isRecurring ? "Si" : "No"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Totale</div>
                      <div className="fw-semibold">€ {fmtMoney(detailCost.amount)}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Pagato</div>
                      <div>€ {fmtMoney(detailCost.paidAmount)}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Residuo</div>
                      <div>€ {fmtMoney(detailCost.remainingAmount)}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Metodo pagamento</div>
                      <div>{detailCost.paymentMethod || "-"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Numero documento</div>
                      <div>{detailCost.docNumber || "-"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="small text-muted">Data documento</div>
                      <div>{fmtDate(detailCost.docDate) || "-"}</div>
                    </div>
                    <div className="col-12">
                      <div className="small text-muted">Note</div>
                      <div className="border rounded p-2 bg-light" style={{ whiteSpace: "pre-line" }}>{detailCost.notes || "-"}</div>
                    </div>
                    {detailCost.attachmentName ? (
                      <div className="col-12">
                        <a
                          href={`/api/manage/cost-attachment?slug=${encodeURIComponent(slug)}&id=${detailCost.id}`}
                          target="_blank"
                          rel="noopener"
                        >
                          <i className="bi bi-paperclip me-1" />
                          <span>{detailCost.attachmentName || "Allegato"}</span>
                        </a>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setDetailCost(null)} />
        </>
      ) : null}
    </div>
  );
}

// Combobox categoria — port dell'.app-combobox della pagina costi (initCombobox in
// assets/js/pages/costs.js): toggle form-control con placeholder "Tutte", ricerca
// "Cerca..." accent-insensitive (Enter = primo risultato), item "Tutte" che azzera,
// label con suffisso " (disattiva)" per le categorie non attive.
function CategoryFilterCombobox(props: {
  boxId: string;
  categories: CostCategory[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { boxId, categories, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const data = useMemo(
    () => [
      { id: "0", label: "Tutte", search: "Tutte" },
      ...categories.map((c) => ({ id: String(c.id), label: c.isActive ? c.name : `${c.name} (disattiva)`, search: c.name })),
    ],
    [categories],
  );
  const qn = comboNorm(search);
  const visible = qn ? data.filter((item) => comboNorm(item.search).includes(qn) || comboNorm(item.label).includes(qn)) : data;
  const selected = value && value !== "0" ? data.find((item) => item.id === value) : undefined;

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className={`app-combobox dropdown${open ? " show" : ""}`} id={boxId} ref={boxRef}>
      <button
        className="form-control text-start app-combobox-toggle dropdown-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSearch("");
          setOpen(!open);
        }}
      >
        <span className={`app-combobox-text${selected ? "" : " d-none"}`}>{selected?.label ?? ""}</span>
        <span className={`text-muted app-combobox-placeholder${selected ? " d-none" : ""}`}>Tutte</span>
      </button>
      <div className={`dropdown-menu p-2 w-100${open ? " show" : ""}`}>
        <input
          ref={searchRef}
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca..."
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (visible[0]) pick(visible[0].id);
            }
          }}
        />
        <div className="app-combobox-list mt-2">
          {visible.length === 0 ? (
            <div className="text-muted small px-2 py-1">Nessun risultato</div>
          ) : (
            visible.map((item) => (
              <button key={item.id} type="button" className="dropdown-item" onClick={() => pick(item.id)}>
                {item.label}
              </button>
            ))
          )}
        </div>
      </div>
      <input type="hidden" name="cat" value={value || "0"} readOnly />
    </div>
  );
}
