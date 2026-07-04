"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP magazzino / products LIST page (app/pages/products.php,
// action=list): filtri legacy (combobox Prodotto, Brand, Categoria, Fornitore,
// Codice prodotto, Codice interno, "Quasi esauriti", Filtra/Reset), tabella a 11
// colonne con evidenza "Quasi esaurito", modal "Dettagli prodotto", azioni
// Modifica/Elimina con il modal "Impossibile eliminare il prodotto" (blockers dal
// server) e flash msg/err verbatim. Query GET legacy inoltrata dal router.

type Product = {
  id: number;
  name: string;
  brand: string;
  internalCode: string;
  sku: string;
  categoryId: number | null;
  categoryName: string;
  priceValue: number;
  purchasePrice: number;
  supplierName: string;
  stock: number;
  minStock: number;
  reorderQty: number;
  incomingQty: number;
  incomingEta: string;
  description: string;
  ingredients: string;
  warnings: string;
};

type Category = { id: number; name: string };
type Supplier = { id: number; name: string; isActive?: boolean };
type DeleteBlocker = { group: string; title: string; detail: string };

export type ProductsQuery = {
  low_stock?: string;
  supplier?: string;
  category?: string;
  code?: string;
  brand?: string;
  internal_code?: string;
  product_id?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// number_format($n, 2, ',', '.') manuale (fmt_money legacy).
function fmtMoney(n: number): string {
  const value = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// product_display_name legacy: "Nome (SKU)".
function displayName(name: string, sku: string, fallback = "Prodotto"): string {
  const label = (name || "").trim() || fallback;
  const code = (sku || "").trim();
  if (!code) return label;
  if (label.endsWith(`(${code})`)) return label;
  return `${label} (${code})`;
}

function fmtDate(d?: string): string {
  const raw = String(d ?? "").slice(0, 10);
  if (!raw) return "";
  const [y, m, day] = raw.split("-");
  return day && m && y ? `${day}/${m}/${y}` : raw;
}

type Filters = {
  lowStock: boolean;
  supplier: string;
  category: number;
  code: string;
  brand: string;
  internalCode: string;
  productId: number;
};

function filtersFromQuery(q: ProductsQuery): Filters {
  return {
    lowStock: String(q.low_stock ?? "") === "1",
    supplier: String(q.supplier ?? "").trim(),
    category: Number.parseInt(String(q.category ?? "0"), 10) || 0,
    code: String(q.code ?? "").trim(),
    brand: String(q.brand ?? "").trim(),
    internalCode: String(q.internal_code ?? "").trim(),
    productId: Number.parseInt(String(q.product_id ?? "0"), 10) || 0,
  };
}

export function ProductsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ProductsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState<Filters>(() => filtersFromQuery(initialQuery ?? {}));

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [activeLocationId, setActiveLocationId] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  // Draft dei filtri (form GET legacy: applicati solo con Filtra).
  const [lowStock, setLowStock] = useState(initial.lowStock);
  const [supplier, setSupplier] = useState(initial.supplier);
  const [category, setCategory] = useState(initial.category);
  const [code, setCode] = useState(initial.code);
  const [brand, setBrand] = useState(initial.brand);
  const [internalCode, setInternalCode] = useState(initial.internalCode);
  const [productId, setProductId] = useState(initial.productId);
  const [applied, setApplied] = useState<Filters>(initial);

  // Flash legacy (?msg/?err dopo i redirect).
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Modal "Dettagli prodotto" + modal blocco eliminazione.
  const [detail, setDetail] = useState<Product | null>(null);
  const [deleteBlock, setDeleteBlock] = useState<{ productName: string; blockers: DeleteBlocker[] } | null>(null);

  const fetchData = useCallback(() => {
    fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setProducts(Array.isArray(j.products) ? j.products : []);
        setCategories(Array.isArray(j.categories) ? j.categories : []);
        setSuppliers(Array.isArray(j.suppliers) ? j.suppliers : []);
        setActiveLocationId(Number(j.activeLocationId ?? 0) || 0);
      })
      .catch(() => {
        setProducts([]);
        setCategories([]);
      })
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, [slug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`products${suffix}`.replace("&", "?")}`;
  }

  // Applica il draft (submit "Filtra") e riscrive l'URL come il GET legacy.
  function applyFilters() {
    const next: Filters = { lowStock, supplier, category, code, brand, internalCode, productId };
    setApplied(next);
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams();
      if (activeLocationId > 0) sp.set("location_id", String(activeLocationId));
      if (next.productId > 0) sp.set("product_id", String(next.productId));
      if (next.brand) sp.set("brand", next.brand);
      if (next.category > 0) sp.set("category", String(next.category));
      if (next.supplier) sp.set("supplier", next.supplier);
      if (next.code) sp.set("code", next.code);
      if (next.internalCode) sp.set("internal_code", next.internalCode);
      if (next.lowStock) sp.set("low_stock", "1");
      window.history.replaceState(null, "", `${window.location.pathname}${sp.size ? `?${sp.toString()}` : ""}`);
    }
  }

  // Elimina prodotto (legacy action=delete): se il server segnala i blockers,
  // mostra il modal "Impossibile eliminare il prodotto" con l'elenco.
  async function deleteProduct(p: Product) {
    if (busy) return;
    setFlash("");
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: String(p.id) }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) {
        setError(String(j.error ?? "Prodotto non eliminato: associazioni attive presenti."));
        if (Array.isArray(j.deleteBlockers) && j.deleteBlockers.length) {
          setDeleteBlock({ productName: displayName(p.name, p.sku, `Prodotto #${p.id}`), blockers: j.deleteBlockers });
        }
        return;
      }
      setFlash("Prodotto eliminato");
      fetchData();
    } catch {
      setError("Errore di rete.");
    } finally {
      setBusy(false);
    }
  }

  // Brands DISTINCT dai prodotti (legacy SELECT DISTINCT brand).
  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      const b = (p.brand ?? "").trim();
      if (b) set.add(b);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "it"));
  }, [products]);

  const activeSuppliers = useMemo(() => suppliers.filter((s) => s.isActive !== false), [suppliers]);

  // Filtro legacy (lato client: il context contiene tutti i prodotti in scope).
  const items = useMemo(() => {
    return products.filter((p) => {
      if (applied.lowStock && !(p.minStock > 0 && p.stock < p.minStock)) return false;
      if (applied.supplier && (p.supplierName ?? "") !== applied.supplier) return false;
      if (applied.category > 0 && Number(p.categoryId ?? 0) !== applied.category) return false;
      if (applied.productId > 0 && p.id !== applied.productId) return false;
      if (applied.code && !(p.sku ?? "").toLowerCase().includes(applied.code.toLowerCase())) return false;
      if (applied.brand && (p.brand ?? "") !== applied.brand) return false;
      if (applied.internalCode && !(p.internalCode ?? "").toLowerCase().includes(applied.internalCode.toLowerCase())) return false;
      return true;
    });
  }, [products, applied]);

  const hasAnyProducts = products.length > 0;
  const showEmptyState = loaded && !hasAnyProducts;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/products.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Magazzino</h1>
          <div className="bs-page-subtitle">
            Gestisci prodotti, categorie e disponibilita di magazzino.
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {!showEmptyState ? (
              <>
                <a className="btn btn-outline-secondary" href={href("&action=categories")}>
                  Categorie
                </a>
                <a className="btn btn-primary" href={href("&action=new")}>
                  Nuovo prodotto
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {showEmptyState ? (
        <div className="card border-0 shadow-sm products-empty-card">
          <div className="products-empty-state">
            <div className="products-empty-icon" aria-hidden="true">
              <i className="bi bi-box-seam" />
            </div>
            <h2>Nessun prodotto in magazzino</h2>
            <p>
              Aggiungi il primo prodotto per iniziare a gestire stock, fornitori, prezzi e
              disponibilita per la sede corrente.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo prodotto
              </a>
              <a className="btn btn-outline-secondary" href={href("&action=categories")}>
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
              <div className="col-md-4">
                <label className="form-label">Prodotto</label>
                <ProductFilterCombobox
                  products={products}
                  value={productId}
                  onChange={setProductId}
                />
              </div>

              <div className="col-md-2">
                <label className="form-label">Brand</label>
                <select className="form-select" name="brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
                  <option value="">Tutti</option>
                  {brands.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-md-3">
                <label className="form-label">Categoria</label>
                <select className="form-select" name="category" value={String(category || "")} onChange={(e) => setCategory(Number(e.target.value) || 0)}>
                  <option value="">Tutte</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-md-3">
                <label className="form-label">Fornitore</label>
                <select className="form-select" name="supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                  <option value="">Tutti</option>
                  {activeSuppliers.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-md-3">
                <label className="form-label">Codice prodotto</label>
                <input className="form-control" name="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Cerca per codice prodotto" />
              </div>

              <div className="col-md-3">
                <label className="form-label">Codice interno</label>
                <input className="form-control" name="internal_code" value={internalCode} onChange={(e) => setInternalCode(e.target.value)} placeholder="Cerca per codice interno" />
              </div>

              <div className="col-md-2 d-flex align-items-center justify-content-start">
                <div className="form-check mb-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="low_stock"
                    value="1"
                    id="low_stock"
                    checked={lowStock}
                    onChange={(e) => setLowStock(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="low_stock">
                    Quasi esauriti
                  </label>
                </div>
              </div>

              <div className="col-md-4 d-flex gap-2 app-filter-actions">
                <button className="btn btn-outline-primary flex-grow-1 app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                <a className="btn btn-outline-secondary app-filter-reset" href={href("")}>
                  Reset
                </a>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Prodotto</th>
                    <th>Categoria</th>
                    <th>Brand</th>
                    <th>Codice prodotto</th>
                    <th>Prezzo</th>
                    <th>Prezzo acquisto</th>
                    <th>Fornitore</th>
                    <th>Stock</th>
                    <th>In arrivo</th>
                    <th>ETA</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessun prodotto trovato con i filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    items.map((p) => {
                      const minStock = p.minStock ?? 10;
                      const isLowStock = minStock > 0 && p.stock < minStock;
                      return (
                        <tr key={p.id} className={isLowStock ? "table-warning border-start border-4 border-danger" : ""}>
                          <td className="fw-semibold">
                            {isLowStock ? <i className="bi bi-exclamation-triangle-fill text-danger me-1" title="Quasi esaurito" /> : null}
                            {displayName(p.name, p.sku)}
                          </td>
                          <td className="text-muted">{p.categoryName || "—"}</td>
                          <td className="text-muted">{(p.brand ?? "") !== "" ? p.brand : "—"}</td>
                          <td className="text-muted">{p.sku || "—"}</td>
                          <td>€ {fmtMoney(p.priceValue)}</td>
                          <td className="text-muted">€ {fmtMoney(p.purchasePrice)}</td>
                          <td className="text-muted">{p.supplierName || "—"}</td>
                          <td>
                            <span className={`badge badge-soft ${isLowStock ? "bg-danger-subtle border-danger-subtle text-danger-emphasis" : ""}`}>
                              {p.stock}
                            </span>
                            {isLowStock ? (
                              <>
                                <span className="badge text-bg-danger ms-1">Quasi esaurito</span>
                                <span className="text-muted ms-2 products-min-stock-note">(min: {minStock})</span>
                              </>
                            ) : null}
                          </td>
                          <td>
                            <span className="badge badge-soft">{p.incomingQty ?? 0}</span>
                          </td>
                          <td className="text-muted">{p.incomingEta ? fmtDate(p.incomingEta) : "—"}</td>
                          <td className="text-end">
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary me-1 btn-product-view"
                              title="Dettagli"
                              onClick={() => setDetail(p)}
                            >
                              <i className="bi bi-eye" />
                            </button>
                            <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${p.id}&location_id=${activeLocationId}`)}>
                              Modifica
                            </a>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-danger"
                              disabled={busy}
                              onClick={() => deleteProduct(p)}
                            >
                              Elimina
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
        </>
      )}

      {/* Modal "Dettagli prodotto" (productDetailsModal legacy). */}
      {detail ? (
        <>
          <div className="modal fade show" id="productDetailsModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Dettagli prodotto</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDetail(null)} />
                </div>
                <div className="modal-body">
                  <div className="row g-3">
                    <div className="col-12">
                      <div className="fw-semibold">Immagini prodotto</div>
                      <div className="text-muted small">Mostrate anche nel booking pubblico (scheda prodotto).</div>
                      <div className="mt-2 pd-main-img">
                        <div className="text-muted small"><i className="bi bi-image me-1" />Nessuna immagine</div>
                      </div>
                    </div>

                    <div className="col-12"><hr className="my-1" /></div>

                    <div className="col-md-6">
                      <div className="text-muted small">Nome</div>
                      <div className="fw-semibold">{displayName(detail.name, detail.sku) || "—"}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="text-muted small">Brand</div>
                      <div>{detail.brand || "—"}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="text-muted small">Codice prodotto</div>
                      <div>{detail.sku || "—"}</div>
                    </div>

                    <div className="col-md-4">
                      <div className="text-muted small">Codice interno</div>
                      <div>{detail.internalCode || "—"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="text-muted small">Categoria</div>
                      <div>{detail.categoryName || "—"}</div>
                    </div>
                    <div className="col-md-4">
                      <div className="text-muted small">Fornitore</div>
                      <div>{detail.supplierName || "—"}</div>
                    </div>

                    <div className="col-md-3">
                      <div className="text-muted small">Prezzo vendita</div>
                      <div>€ {fmtMoney(detail.priceValue)}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="text-muted small">Prezzo acquisto</div>
                      <div>€ {fmtMoney(detail.purchasePrice)}</div>
                    </div>
                    <div className="col-md-2">
                      <div className="text-muted small">Stock</div>
                      <div>{detail.stock}</div>
                    </div>
                    <div className="col-md-2">
                      <div className="text-muted small">Min.</div>
                      <div>{detail.minStock}</div>
                    </div>
                    <div className="col-md-2">
                      <div className="text-muted small">Riordino</div>
                      <div>{detail.reorderQty}</div>
                    </div>

                    <div className="col-md-3">
                      <div className="text-muted small">In arrivo</div>
                      <div>{detail.incomingQty ?? 0}</div>
                    </div>
                    <div className="col-md-3">
                      <div className="text-muted small">ETA</div>
                      <div>{detail.incomingEta ? fmtDate(detail.incomingEta) : "—"}</div>
                    </div>

                    <div className="col-12"><hr className="my-1" /></div>

                    <div className="col-12">
                      <div className="fw-semibold">Scheda prodotto</div>
                      <div className="text-muted small">Questi dati vengono mostrati nelle schede prodotto del booking pubblico.</div>
                    </div>

                    <div className="col-12">
                      <div className="text-muted small">Descrizione</div>
                      <div className="pd-longtext" style={{ whiteSpace: "pre-line" }}>{detail.description || "—"}</div>
                    </div>
                    <div className="col-md-6">
                      <div className="text-muted small">Ingredienti</div>
                      <div className="pd-longtext" style={{ whiteSpace: "pre-line" }}>{detail.ingredients || "—"}</div>
                    </div>
                    <div className="col-md-6">
                      <div className="text-muted small">Avvertenze</div>
                      <div className="pd-longtext" style={{ whiteSpace: "pre-line" }}>{detail.warnings || "—"}</div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <a className="btn btn-primary" href={href(`&action=edit&id=${detail.id}&location_id=${activeLocationId}`)}>
                    Modifica
                  </a>
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setDetail(null)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setDetail(null)} />
        </>
      ) : null}

      {/* Modal blocco eliminazione (productDeleteBlockModal legacy). */}
      {deleteBlock ? (
        <>
          <div className="modal fade show" id="productDeleteBlockModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-dialog-centered modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <div className="text-muted small">Magazzino</div>
                    <h5 className="modal-title fw-bold m-0">Impossibile eliminare il prodotto</h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteBlock(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning small mb-3">
                    <strong>{deleteBlock.productName}</strong>: Il prodotto non può essere eliminato perché è associato a elementi attivi o ancora da ritirare. Rimuovi o chiudi prima le associazioni elencate.
                  </div>
                  <div className="fw-semibold mb-2">Associazioni rilevate</div>
                  <div>
                    {deleteBlock.blockers.map((b, i) => (
                      <div key={i} className="border rounded-3 p-2 mb-2">
                        <div className="text-muted small">{b.group}</div>
                        <div className="fw-semibold">{b.title}</div>
                        {b.detail ? <div className="text-muted small">{b.detail}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setDeleteBlock(null)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setDeleteBlock(null)} />
        </>
      ) : null}
    </div>
  );
}

// Combobox filtro Prodotto (js-filter-product-box legacy): display_name "Nome (SKU)",
// placeholder "Tutti", ricerca per nome o codice.
function ProductFilterCombobox(props: {
  products: Product[];
  value: number;
  onChange: (id: number) => void;
}) {
  const { products, value, onChange } = props;
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

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? products.filter((p) => p.name.toLowerCase().includes(needle) || (p.sku ?? "").toLowerCase().includes(needle))
    : products;
  const selected = value > 0 ? products.find((p) => p.id === value) : undefined;

  const pick = (id: number) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className={`dropdown app-combobox js-filter-product-box${open ? " show" : ""}`} ref={boxRef}>
      <button
        className="form-control text-start app-combobox-toggle dropdown-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSearch("");
          setOpen(!open);
        }}
      >
        <span className="app-combobox-text">{selected ? displayName(selected.name, selected.sku) : ""}</span>
        {selected ? null : <span className="app-combobox-placeholder text-muted">Tutti</span>}
      </button>
      <input type="hidden" name="product_id" className="js-filter-product" value={String(value || 0)} readOnly />
      <div className={`dropdown-menu p-2 w-100 app-combobox-menu${open ? " show" : ""}`}>
        <input
          ref={searchRef}
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="list-group mt-2 app-combobox-list">
          <button type="button" className="list-group-item list-group-item-action" onClick={() => pick(0)}>
            Tutti
          </button>
          {visible.map((p) => (
            <button key={p.id} type="button" className={`list-group-item list-group-item-action${p.id === value ? " active" : ""}`} onClick={() => pick(p.id)}>
              {displayName(p.name, p.sku)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
