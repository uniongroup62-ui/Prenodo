"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP "Scadenziario e Costi" page (app/pages/costs.php,
// scadenziario tab), fed by the existing DB-backed /api/manage/costs.

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
  summary?: CostsSummary;
  costs?: CostRow[];
  categories?: CostCategory[];
  locations?: CostLocation[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number): string {
  // Italian number_format($n, 2, ',', '.')
  return (Number.isFinite(n) ? n : 0).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

export function CostsContent() {
  const slug = tenantSlug();
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [locations, setLocations] = useState<CostLocation[]>([]);
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

  // Filters
  const [cat, setCat] = useState("0");
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(lastOfMonth);
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");

  // Bulk selection (scadenziario): the checked cost ids for "Elimina selezionati".
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Per-row detail ("Riepilogo") modal (faithful to the legacy cost summary modal).
  const [detailCost, setDetailCost] = useState<CostRow | null>(null);

  const load = useCallback(
    (filters: { cat: string; from: string; to: string; status: string; q: string }) => {
      setLoading(true);
      const params = new URLSearchParams({
        slug,
        cat: filters.cat,
        from: filters.from,
        to: filters.to,
        status: filters.status,
        q: filters.q,
      });
      fetch(`/api/manage/costs?${params.toString()}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j: CostsResponse) => {
          setCosts(Array.isArray(j.costs) ? j.costs : []);
          setCategories(Array.isArray(j.categories) ? j.categories : []);
          setLocations(Array.isArray(j.locations) ? j.locations : []);
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

  useEffect(() => {
    load({ cat: "0", from: firstOfMonth(), to: lastOfMonth(), status: "open", q: "" });
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`costs${suffix}`.replace("&", "?")}`;
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Bulk-delete the checked costs (POST action=bulk_delete → reload the filtered list). Clears the
  // selection after. Guarded by a confirm; the server tolerates missing/foreign ids.
  async function bulkDelete() {
    if (selected.size === 0 || bulkBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`Eliminare ${selected.size} voci selezionate?`)) return;
    setBulkBusy(true);
    try {
      await fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "bulk_delete", cost_ids: JSON.stringify([...selected]) }),
      });
      setSelected(new Set());
      load({ cat, from, to, status, q });
    } catch {
      // leave the selection on failure so the operator can retry
    } finally {
      setBulkBusy(false);
    }
  }

  const allSelected = costs.length > 0 && selected.size === costs.length;

  const showLocationCol = locations.length > 1;
  const hasAnyCosts = costs.length > 0;
  const empty = loaded && !hasAnyCosts && summary.open === 0 && summary.overdue === 0 && summary.paid === 0;

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
                load({ cat, from, to, status, q });
              }}
            >
              <div className="col-xl-2 col-lg-3 col-md-6">
                <label className="form-label">Categoria</label>
                <select className="form-select" name="cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                  <option value="0">Tutte</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
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
              <div className="col-xl-3 col-lg-4 col-md-6 d-flex gap-2 app-filter-actions">
                <button className="btn btn-outline-primary flex-grow-1 app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                <a className="btn btn-outline-secondary app-filter-reset" href={href("&tab=scadenziario")}>
                  Reset
                </a>
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
              <div className="fw-semibold">Voci</div>
              <div className="d-flex gap-2">
                <a
                  className="btn btn-sm btn-outline-secondary"
                  href={href(
                    `&tab=scadenziario&action=export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=${encodeURIComponent(status)}&cat=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}&format=csv`,
                  )}
                >
                  <i className="bi bi-download me-1" />
                  CSV
                </a>
                <a
                  className="btn btn-sm btn-outline-secondary"
                  href={href(
                    `&tab=scadenziario&action=export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=${encodeURIComponent(status)}&cat=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}&format=pdf`,
                  )}
                >
                  <i className="bi bi-file-earmark-pdf me-1" />
                  PDF
                </a>
                {selected.size > 0 ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    disabled={bulkBusy}
                    onClick={bulkDelete}
                  >
                    <i className="bi bi-trash me-1" />
                    Elimina selezionati ({selected.size})
                  </button>
                ) : null}
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
              <div className="table-responsive">
                <table className="table align-middle mb-0">
                  <thead>
                    <tr>
                      <th className="costs-bulk-col">
                        <input
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
                              className="btn btn-sm btn-outline-secondary"
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
                            <a
                              className="btn btn-sm btn-outline-success"
                              href={href(`&tab=scadenziario&action=toggle&kind=paid&id=${r.id}`)}
                              title="Segna pagato / non pagato"
                            >
                              <i className="bi bi-check2-circle" />
                            </a>{" "}
                            <a
                              className="btn btn-sm btn-outline-danger"
                              href={href(`&tab=scadenziario&action=delete&kind=cost&id=${r.id}`)}
                              title="Elimina"
                            >
                              <i className="bi bi-trash" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Per-row "Riepilogo" modal (faithful to the legacy cost summary modal): a read-only detail
          of the selected cost. Controlled by React (content is the selected row). */}
      {detailCost ? (
        <>
          <div className="modal fade show costs-detail-modal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Riepilogo costo</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDetailCost(null)} />
                </div>
                <div className="modal-body">
                  <dl className="row mb-0 small costs-detail-list">
                    <dt className="col-sm-5">Titolo</dt>
                    <dd className="col-sm-7 fw-semibold">{detailCost.title}</dd>
                    <dt className="col-sm-5">Scadenza</dt>
                    <dd className="col-sm-7">{fmtDate(detailCost.dueDate)}</dd>
                    <dt className="col-sm-5">Categoria</dt>
                    <dd className="col-sm-7">
                      {detailCost.categoryName ? (
                        <span className="badge" style={{ backgroundColor: detailCost.categoryColor || "#6c757d" }}>{detailCost.categoryName}</span>
                      ) : "—"}
                    </dd>
                    <dt className="col-sm-5">Fornitore</dt>
                    <dd className="col-sm-7">{detailCost.supplierName || "—"}</dd>
                    {showLocationCol ? (
                      <>
                        <dt className="col-sm-5">Sede</dt>
                        <dd className="col-sm-7">{detailCost.locationName || "Tutte le sedi"}</dd>
                      </>
                    ) : null}
                    <dt className="col-sm-5">Totale</dt>
                    <dd className="col-sm-7">€ {fmtMoney(detailCost.amount)}</dd>
                    <dt className="col-sm-5">Pagato</dt>
                    <dd className="col-sm-7">€ {fmtMoney(detailCost.paidAmount)}</dd>
                    <dt className="col-sm-5">Residuo</dt>
                    <dd className="col-sm-7">€ {fmtMoney(detailCost.remainingAmount)}</dd>
                    {detailCost.vatPercent != null ? (
                      <>
                        <dt className="col-sm-5">IVA</dt>
                        <dd className="col-sm-7">{detailCost.vatPercent}%</dd>
                      </>
                    ) : null}
                    <dt className="col-sm-5">Stato</dt>
                    <dd className="col-sm-7">
                      {detailCost.isPaid ? (
                        <span className="badge text-bg-success">Pagato</span>
                      ) : detailCost.status === "overdue" ? (
                        <span className="badge text-bg-danger">Scaduto</span>
                      ) : (
                        <span className="badge text-bg-warning">Da pagare</span>
                      )}
                    </dd>
                    {detailCost.paymentMethod ? (
                      <>
                        <dt className="col-sm-5">Metodo pagamento</dt>
                        <dd className="col-sm-7">{detailCost.paymentMethod}</dd>
                      </>
                    ) : null}
                    {detailCost.docNumber ? (
                      <>
                        <dt className="col-sm-5">Documento</dt>
                        <dd className="col-sm-7">{detailCost.docNumber}{detailCost.docDate ? ` — ${fmtDate(detailCost.docDate)}` : ""}</dd>
                      </>
                    ) : null}
                    {detailCost.isPaid && detailCost.paidAt ? (
                      <>
                        <dt className="col-sm-5">Pagato il</dt>
                        <dd className="col-sm-7">{fmtDate(detailCost.paidAt)}</dd>
                      </>
                    ) : null}
                    {detailCost.isRecurring ? (
                      <>
                        <dt className="col-sm-5">Ricorrenza</dt>
                        <dd className="col-sm-7">
                          Ogni {detailCost.recurrenceInterval || 1} {recurrenceUnitLabel(detailCost.recurrenceUnit, detailCost.recurrenceInterval || 1)}
                          {detailCost.recurrenceEndDate ? ` — fino al ${fmtDate(detailCost.recurrenceEndDate)}` : " — senza fine"}
                        </dd>
                      </>
                    ) : null}
                    {detailCost.notes ? (
                      <>
                        <dt className="col-sm-5">Note</dt>
                        <dd className="col-sm-7" style={{ whiteSpace: "pre-line" }}>{detailCost.notes}</dd>
                      </>
                    ) : null}
                    {detailCost.attachmentName ? (
                      <>
                        <dt className="col-sm-5">Allegato</dt>
                        <dd className="col-sm-7">{detailCost.attachmentName}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
                <div className="modal-footer">
                  <a className="btn btn-outline-primary" href={href(`&tab=scadenziario&action=edit&id=${detailCost.id}`)}>
                    <i className="bi bi-pencil me-1" />
                    Modifica
                  </a>
                  <button type="button" className="btn btn-secondary" onClick={() => setDetailCost(null)}>
                    Chiudi
                  </button>
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

// "giorno/i", "settimana/e", "mese/i", "anno/i" for a recurrence unit + count (faithful labels).
function recurrenceUnitLabel(unit: string, count: number): string {
  const plural = count !== 1;
  switch (unit) {
    case "day":
      return plural ? "giorni" : "giorno";
    case "week":
      return plural ? "settimane" : "settimana";
    case "year":
      return plural ? "anni" : "anno";
    default:
      return plural ? "mesi" : "mese";
  }
}
