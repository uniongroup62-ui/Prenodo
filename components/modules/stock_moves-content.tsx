"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Pixel-faithful port of the PHP stock_moves page (app/pages/stock_moves.php),
// fed by the existing DB-backed /api/manage/products context (which bundles
// categories, suppliers, products and stockDocuments for a location).

type Category = { id: number; name: string };
type Supplier = { id: number; name: string };
type ProductLite = { id: number; name: string; sku?: string };
type LocationLite = { id: number; name: string; isActive?: boolean };

type StockItem = {
  id: number;
  productId: number;
  productName: string;
  productSku: string;
  qty: number;
  incomingFlag?: boolean;
  incomingQty?: number;
  incomingEta?: string;
};

type StockDocument = {
  id: number;
  moveDate: string;
  cause: "carico" | "scarico";
  operatorName: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  notes: string;
  locationId: number | null;
  isCanceled: boolean;
  attachmentName?: string;
  items: StockItem[];
};

type ProductsContext = {
  activeLocationId?: number;
  categories?: Array<{ id: number; name: string }>;
  suppliers?: Array<{ id: number; name: string }>;
  products?: Array<{ id: number; name: string; sku?: string; supplierName?: string; categoryId?: number | null }>;
  locations?: LocationLite[];
  stockDocuments?: StockDocument[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = String(iso).slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

// Searchable combobox matching the PHP .app-combobox markup. The original
// page CSS + bootstrap dropdown styling apply unchanged.
function Combobox({
  boxClass,
  hiddenName,
  hiddenClass,
  options,
  value,
  onChange,
  placeholder,
}: {
  boxClass: string;
  hiddenName: string;
  hiddenClass: string;
  options: Array<{ id: number; label: string }>;
  value: number;
  onChange: (id: number) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const selected = options.find((o) => o.id === value && o.id !== 0);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase().trim()));

  return (
    <div className={`dropdown app-combobox ${boxClass}${open ? " show" : ""}`} ref={ref}>
      <button
        className={`form-control text-start app-combobox-toggle dropdown-toggle${open ? " show" : ""}`}
        type="button"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="app-combobox-text">{selected ? selected.label : ""}</span>
        {selected ? null : <span className="app-combobox-placeholder text-muted">{placeholder}</span>}
      </button>
      <input type="hidden" name={hiddenName} className={hiddenClass} value={value} readOnly />
      <div className={`dropdown-menu p-2 w-100 app-combobox-menu${open ? " show" : ""}`}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="list-group mt-2 app-combobox-list">
          {filtered.map((o) => (
            <button
              type="button"
              key={o.id}
              className={`list-group-item list-group-item-action${o.id === value ? " active" : ""}`}
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

export function StockMovesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [ctx, setCtx] = useState<ProductsContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);
  const [detailDoc, setDetailDoc] = useState<StockDocument | null>(null);

  // Filter form state
  const [productId, setProductId] = useState(0);
  const [categoryId, setCategoryId] = useState(0);
  const [supplier, setSupplier] = useState(0);
  const [sku, setSku] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [date, setDate] = useState("");
  const [includeCanceled, setIncludeCanceled] = useState(false);

  // Applied filters (set on submit) — keeps the filter form working via state.
  const [applied, setApplied] = useState({
    productId: 0,
    categoryId: 0,
    supplier: 0,
    sku: "",
    internalCode: "",
    documentNumber: "",
    date: "",
    includeCanceled: false,
  });

  const load = useCallback(
    (locationId?: number) => {
      setLoading(true);
      const params = new URLSearchParams({ slug });
      if (locationId) params.set("location_id", String(locationId));
      fetch(`/api/manage/products?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j: ProductsContext) => setCtx(j))
        .catch(() => setCtx(null))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    load();
  }, [load]);

  const activeLocationId = ctx?.activeLocationId ?? 0;

  // Cancel ("Annulla movimento"): reverses the stock delta + recomputes incoming server-side
  // (cancelStockDocument), then reloads the list. Confirm-gated.
  async function cancelDoc(id: number) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Annullare questo movimento? La giacenza verra stornata.")) return;
    setBusyId(id);
    try {
      await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "stock_doc_cancel", id }),
      });
      load(activeLocationId || undefined);
    } catch {
      // leave the list as-is on failure
    } finally {
      setBusyId(0);
    }
  }
  const categories: Category[] = useMemo(
    () => (ctx?.categories ?? []).map((c) => ({ id: Number(c.id), name: String(c.name ?? "") })),
    [ctx],
  );
  const suppliers: Supplier[] = useMemo(
    () => (ctx?.suppliers ?? []).map((s) => ({ id: Number(s.id), name: String(s.name ?? "") })),
    [ctx],
  );
  const products: ProductLite[] = useMemo(
    () => (ctx?.products ?? []).map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), sku: p.sku ? String(p.sku) : "" })),
    [ctx],
  );

  const productOptions = useMemo(
    () => products.map((p) => ({ id: p.id, label: p.sku ? `${p.name} (${p.sku})` : p.name })),
    [products],
  );
  const supplierOptions = useMemo(() => suppliers.map((s) => ({ id: s.id, label: s.name })), [suppliers]);

  // productId -> { categoryId, supplierName } from the global product list, so the doc rows can be
  // filtered by category/supplier and can aggregate the categories/suppliers columns from their items.
  const productMeta = useMemo(() => {
    const m = new Map<number, { categoryId: number; supplierName: string }>();
    for (const p of ctx?.products ?? []) m.set(Number(p.id), { categoryId: Number(p.categoryId ?? 0) || 0, supplierName: String(p.supplierName ?? "").trim() });
    return m;
  }, [ctx]);
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const supplierNameById = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);

  // Distinct category / supplier names for a doc, derived from its items' products (the "Categorie"
  // and "Fornitori" columns — faithful to the legacy GROUP_CONCAT DISTINCT aggregation).
  const docCategories = useCallback((d: StockDocument): string[] => {
    const set = new Set<string>();
    for (const it of d.items) { const name = categoryNameById.get(productMeta.get(it.productId)?.categoryId ?? 0); if (name) set.add(name); }
    return [...set];
  }, [productMeta, categoryNameById]);
  const docSuppliers = useCallback((d: StockDocument): string[] => {
    const set = new Set<string>();
    for (const it of d.items) { const s = productMeta.get(it.productId)?.supplierName ?? ""; if (s) set.add(s); }
    return [...set];
  }, [productMeta]);

  const docs: StockDocument[] = useMemo(() => ctx?.stockDocuments ?? [], [ctx]);

  // Client-side filtering driven by the applied filter state.
  const filteredDocs = useMemo(() => {
    return docs.filter((d) => {
      if (!applied.includeCanceled && d.isCanceled) return false;
      if (applied.productId && !d.items.some((it) => it.productId === applied.productId)) return false;
      if (applied.sku.trim()) {
        const needle = applied.sku.trim().toLowerCase();
        if (!d.items.some((it) => (it.productSku ?? "").toLowerCase().includes(needle))) return false;
      }
      // Category filter: keep the doc when any of its lines' products belong to the chosen category.
      if (applied.categoryId) {
        if (!d.items.some((it) => (productMeta.get(it.productId)?.categoryId ?? 0) === applied.categoryId)) return false;
      }
      // Supplier filter (the combobox value is a supplier id → match the product's supplier NAME).
      if (applied.supplier) {
        const supName = supplierNameById.get(applied.supplier) ?? "";
        if (supName && !d.items.some((it) => (productMeta.get(it.productId)?.supplierName ?? "") === supName)) return false;
      }
      if (applied.documentNumber.trim()) {
        if (!(d.documentNumber ?? "").toLowerCase().includes(applied.documentNumber.trim().toLowerCase())) return false;
      }
      if (applied.date) {
        if (String(d.moveDate ?? "").slice(0, 10) !== applied.date) return false;
      }
      return true;
    });
  }, [docs, applied, productMeta, supplierNameById]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApplied({ productId, categoryId, supplier, sku, internalCode, documentNumber, date, includeCanceled });
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`stock_moves${suffix}`.replace("&", "?")}`;
  }

  // Client-side CSV export of the (filtered) movements — one row per document line, semicolon-delimited
  // + UTF-8 BOM (Excel it-IT), faithful to the legacy export columns. No server round-trip. Defined
  // after filteredDocs/docCategories/docSuppliers so it closes over already-declared values.
  function exportCsv() {
    const sep = ";";
    const esc = (v: unknown) => { const s = String(v ?? ""); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ["Data movimento", "Causale", "Tipo documento", "Numero documento", "Data documento", "Operatore", "Categorie", "Fornitori", "Prodotto", "SKU", "Quantita", "In arrivo", "Qta in arrivo", "ETA arrivo", "Stato", "Note"];
    const csvRows: string[] = [header.join(sep)];
    for (const d of filteredDocs) {
      const cats = docCategories(d).join(", ");
      const sups = docSuppliers(d).join(", ");
      const causale = d.cause === "carico" ? "Carico" : "Scarico";
      const stato = d.isCanceled ? "Annullato" : "Attivo";
      const base = [fmtDate(d.moveDate), causale, d.documentType, d.documentNumber, fmtDate(d.documentDate), d.operatorName, cats, sups];
      if (d.items.length === 0) {
        csvRows.push([...base, "", "", "", "", "", "", stato, d.notes].map(esc).join(sep));
      } else {
        for (const it of d.items) {
          csvRows.push([...base, it.productName, it.productSku, it.qty, it.incomingFlag ? "SI" : "NO", it.incomingQty ?? "", it.incomingEta ? fmtDate(it.incomingEta) : "", stato, d.notes].map(esc).join(sep));
        }
      }
    }
    const blob = new Blob(["﻿" + csvRows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `movimenti_magazzino_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const locParam = activeLocationId ? `&location_id=${activeLocationId}` : "";

  return (
    <main className="app-content">
      <div className="container-fluid">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Magazzino</div>
            <h1 className="bs-page-title">Carico / Scarico</h1>
            <div className="bs-page-subtitle">Registra movimenti di magazzino e rettifiche prodotto.</div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/products`}>
                Torna al magazzino
              </a>
              <a className="btn btn-primary" href={href(`&action=new${locParam}`)}>
                Nuovo carico / scarico
              </a>
            </div>
          </div>
        </div>

        <div className="card p-3 mb-3">
          <form method="get" className="row g-2 align-items-end" onSubmit={onSubmit}>
            <input type="hidden" name="page" value="stock_moves" />
            {activeLocationId ? <input type="hidden" name="location_id" value={activeLocationId} readOnly /> : null}

            <div className="col-md-4">
              <label className="form-label">Prodotto</label>
              <Combobox
                boxClass="js-filter-product-box"
                hiddenName="product_id"
                hiddenClass="js-filter-product"
                options={productOptions}
                value={productId}
                onChange={setProductId}
                placeholder="Tutti"
              />
            </div>

            <div className="col-md-3">
              <label className="form-label">Categoria</label>
              <select
                className="form-select"
                name="category_id"
                value={categoryId}
                onChange={(e) => setCategoryId(Number(e.target.value))}
              >
                <option value="0">Tutte</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Fornitore</label>
              <Combobox
                boxClass="js-filter-supplier-box"
                hiddenName="supplier"
                hiddenClass="js-filter-supplier"
                options={supplierOptions}
                value={supplier}
                onChange={setSupplier}
                placeholder="Tutti"
              />
            </div>

            <div className="col-md-2">
              <label className="form-label">Codice prodotto</label>
              <input
                className="form-control"
                name="sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Cerca codice prodotto"
              />
            </div>

            <div className="col-md-2">
              <label className="form-label">Codice interno</label>
              <input
                className="form-control"
                name="internal_code"
                value={internalCode}
                onChange={(e) => setInternalCode(e.target.value)}
                placeholder="Cerca codice interno"
              />
            </div>

            <div className="col-md-2">
              <label className="form-label">N. documento</label>
              <input
                className="form-control"
                name="document_number"
                value={documentNumber}
                onChange={(e) => setDocumentNumber(e.target.value)}
                placeholder="Es. 123/2025"
              />
            </div>

            <div className="col-md-2">
              <label className="form-label">Data</label>
              <input
                className="form-control"
                type="date"
                name="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            <div className="col-md-2 d-flex align-items-center justify-content-start">
              <div className="form-check mb-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  name="include_canceled"
                  value="1"
                  id="includeCanceled"
                  checked={includeCanceled}
                  onChange={(e) => setIncludeCanceled(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="includeCanceled">
                  Mostra annullati
                </label>
              </div>
            </div>

            <div className="col-md-3 d-flex gap-2 app-filter-actions">
              <button className="btn btn-outline-primary flex-grow-1 app-filter-submit" type="submit">
                <i className="bi bi-search me-1" />
                Filtra
              </button>
              <a className="btn btn-outline-secondary app-filter-reset" href={href("")}>
                Reset
              </a>
            </div>

            <div className="col-12 d-flex justify-content-end">
              <button type="button" className="btn btn-outline-secondary" onClick={exportCsv}>
                <i className="bi bi-download" /> Esporta CSV
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Causale</th>
                  <th>Documento</th>
                  <th>Operatore</th>
                  <th>Categorie</th>
                  <th>Fornitori</th>
                  <th>Prodotti</th>
                  <th>Totale q.tà</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-muted p-3">
                      {loading ? "Caricamento…" : "Nessun movimento."}
                    </td>
                  </tr>
                ) : (
                  filteredDocs.map((d) => {
                    const totalQty = d.items.reduce((acc, it) => acc + Number(it.qty || 0), 0);
                    const prodNames = d.items.map((it) => it.productName).filter(Boolean);
                    const cats = docCategories(d);
                    const sups = docSuppliers(d);
                    return (
                      <tr key={d.id} className={d.isCanceled ? "text-muted" : undefined}>
                        <td>{fmtDate(d.moveDate)}</td>
                        <td>{d.cause === "carico" ? "Carico" : "Scarico"}</td>
                        <td>{d.documentNumber || "—"}</td>
                        <td>{d.operatorName || "—"}</td>
                        <td className="text-muted small">{cats.length ? cats.join(", ") : "—"}</td>
                        <td className="text-muted small">{sups.length ? sups.join(", ") : "—"}</td>
                        <td className="text-muted small">{prodNames.length ? prodNames.join(", ") : "—"}</td>
                        <td>{totalQty}</td>
                        <td>
                          {d.isCanceled ? (
                            <span className="badge bg-light text-dark">Annullato</span>
                          ) : (
                            <span className="badge bg-success-subtle text-success">Attivo</span>
                          )}
                        </td>
                        <td className="text-end costs-nowrap">
                          {d.attachmentName ? (
                            <>
                              <a
                                className="btn btn-sm btn-outline-primary"
                                href={`/api/manage/stock-doc-attachment?slug=${encodeURIComponent(slug)}&id=${d.id}`}
                                target="_blank"
                                rel="noreferrer"
                                title={d.attachmentName}
                              >
                                <i className="bi bi-paperclip" />
                              </a>{" "}
                            </>
                          ) : null}
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDetailDoc(d)}>
                            Apri
                          </button>
                          {!d.isCanceled ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-danger"
                                disabled={busyId === d.id}
                                onClick={() => cancelDoc(d.id)}
                              >
                                Annulla
                              </button>
                            </>
                          ) : null}
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

      {/* Document DETAIL modal (faithful to the legacy ?action=view): the full stock document header +
          items (with the "In arrivo" column for carico) + notes + status + the Annulla action. */}
      {detailDoc ? (
        <>
          <div className="modal fade show" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">
                    Movimento {detailDoc.cause === "carico" ? "Carico" : "Scarico"}
                    {detailDoc.documentNumber ? ` — ${detailDoc.documentNumber}` : ""}
                  </h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDetailDoc(null)} />
                </div>
                <div className="modal-body">
                  <dl className="row mb-3 small">
                    <dt className="col-sm-3">Data movimento</dt>
                    <dd className="col-sm-3">{fmtDate(detailDoc.moveDate)}</dd>
                    <dt className="col-sm-3">Operatore</dt>
                    <dd className="col-sm-3">{detailDoc.operatorName || "—"}</dd>
                    <dt className="col-sm-3">Tipo documento</dt>
                    <dd className="col-sm-3">{detailDoc.documentType || "—"}</dd>
                    <dt className="col-sm-3">Numero</dt>
                    <dd className="col-sm-3">{detailDoc.documentNumber || "—"}</dd>
                    <dt className="col-sm-3">Data documento</dt>
                    <dd className="col-sm-3">{fmtDate(detailDoc.documentDate)}</dd>
                    <dt className="col-sm-3">Stato</dt>
                    <dd className="col-sm-3">
                      {detailDoc.isCanceled ? (
                        <span className="badge bg-light text-dark">Annullato</span>
                      ) : (
                        <span className="badge bg-success-subtle text-success">Attivo</span>
                      )}
                    </dd>
                    <dt className="col-sm-3">Documento allegato</dt>
                    <dd className="col-sm-3">
                      {detailDoc.attachmentName ? (
                        <a href={`/api/manage/stock-doc-attachment?slug=${encodeURIComponent(slug)}&id=${detailDoc.id}`} target="_blank" rel="noreferrer">
                          {detailDoc.attachmentName}
                        </a>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </dl>

                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Prodotto</th>
                          <th>SKU</th>
                          <th className="text-end">Quantita</th>
                          {detailDoc.cause === "carico" ? <th>In arrivo</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {detailDoc.items.length === 0 ? (
                          <tr>
                            <td colSpan={detailDoc.cause === "carico" ? 4 : 3} className="text-muted">Nessuna riga.</td>
                          </tr>
                        ) : (
                          detailDoc.items.map((it) => (
                            <tr key={it.id}>
                              <td>{it.productName || "—"}</td>
                              <td className="text-muted small">{it.productSku || "—"}</td>
                              <td className="text-end">{it.qty}</td>
                              {detailDoc.cause === "carico" ? (
                                <td className="small">
                                  {it.incomingFlag ? (
                                    <span>
                                      <span className="badge text-bg-info">{it.incomingQty ?? 0}</span>
                                      {it.incomingEta ? ` entro ${fmtDate(it.incomingEta)}` : ""}
                                    </span>
                                  ) : (
                                    <span className="text-muted">—</span>
                                  )}
                                </td>
                              ) : null}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {detailDoc.notes && detailDoc.notes.trim() ? (
                    <div className="alert alert-light border small mt-3 mb-0">
                      <strong>Note:</strong> <span style={{ whiteSpace: "pre-line" }}>{detailDoc.notes}</span>
                    </div>
                  ) : null}
                </div>
                <div className="modal-footer">
                  {!detailDoc.isCanceled ? (
                    <button
                      type="button"
                      className="btn btn-outline-danger"
                      disabled={busyId === detailDoc.id}
                      onClick={() => {
                        const id = detailDoc.id;
                        setDetailDoc(null);
                        cancelDoc(id);
                      }}
                    >
                      <i className="bi bi-x-circle me-1" />
                      Annulla movimento
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-secondary" onClick={() => setDetailDoc(null)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setDetailDoc(null)} />
        </>
      ) : null}
    </main>
  );
}
