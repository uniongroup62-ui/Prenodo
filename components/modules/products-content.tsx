"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP magazzino / products list page (app/pages/products.php),
// fed by the existing DB-backed /api/manage/products endpoint which returns
// `products: ProductRow[]` together with `categories`, `locations` and `stats`.
// Reproduces the original Bootstrap markup verbatim: bs-page-header (kicker
// "Risorse" / title "Magazzino"), the empty-state card (bi bi-box-seam) and,
// when populated, a filter card + list table.

type Product = {
  id: number;
  name: string;
  brand: string;
  internalCode: string;
  sku: string;
  categoryId: number | null;
  categoryName: string;
  priceValue: number;
  price: string;
  purchasePrice: number;
  supplierName: string;
  stock: number;
  minStock: number;
  reorderQty: number;
  incomingQty: number;
  incomingEta: string;
  isActive: boolean;
  publicVisible: boolean;
  sellOnline: boolean;
  locationIds: number[];
  lowStock: boolean;
  description: string;
  ingredients: string;
  warnings: string;
};

type Category = { id: number; name: string; productCount: number };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ProductsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter form state (legacy products list: search by name/SKU + category).
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("0");
  const [applied, setApplied] = useState({ q: "", categoryId: "0" });

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setProducts(Array.isArray(j.products) ? j.products : []);
        setCategories(Array.isArray(j.categories) ? j.categories : []);
      })
      .catch(() => {
        setProducts([]);
        setCategories([]);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`products${suffix}`.replace("&", "?")}`;
  }

  // Client-side filtering mirrors the PHP list filter (the API exposes no
  // server-side filter params here).
  const filtered = useMemo(() => {
    const needle = applied.q.trim().toLowerCase();
    return products.filter((p) => {
      if (needle !== "") {
        const hay = [p.name, p.sku, p.brand, p.internalCode, p.supplierName]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (applied.categoryId !== "0" && String(p.categoryId ?? "") !== applied.categoryId) {
        return false;
      }
      return true;
    });
  }, [products, applied]);

  const hasAnyProducts = products.length > 0;
  const showEmptyState = !loading && !hasAnyProducts;

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
                  <i className="bi bi-tags me-1" />
                  Categorie
                </a>
                <a className="btn btn-primary" href={href("&action=new")}>
                  <i className="bi bi-plus-lg me-1" />
                  Nuovo prodotto
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>

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
                setApplied({ q, categoryId });
              }}
            >
              <div className="col-lg-7 col-md-6">
                <label className="form-label">Cerca</label>
                <input
                  className="form-control"
                  name="q"
                  value={q}
                  placeholder="Nome, SKU, marca o fornitore..."
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <div className="col-lg-3 col-md-4">
                <label className="form-label">Categoria</label>
                <select
                  className="form-select"
                  name="category_id"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="0">Tutte</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-lg-2 col-md-2 d-grid">
                <button className="btn btn-outline-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
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
                    <th>Fornitore</th>
                    <th className="text-end">Prezzo</th>
                    <th className="text-end">Disponibilità</th>
                    <th>Stato</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted small p-3">
                        {loading ? "Caricamento…" : "Nessun prodotto."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((p) => {
                      const sku = (p.sku ?? "").trim();
                      const brand = (p.brand ?? "").trim();
                      const supplier = (p.supplierName ?? "").trim();
                      return (
                        <tr key={p.id}>
                          <td>
                            <div className="fw-semibold">{p.name}</div>
                            <div className="text-muted small">
                              {sku !== "" ? `SKU: ${sku}` : "—"}
                              {brand !== "" ? ` · ${brand}` : ""}
                            </div>
                          </td>
                          <td className="text-muted">
                            {p.categoryName && p.categoryName.trim() !== "" ? p.categoryName : "—"}
                          </td>
                          <td className="text-muted">{supplier !== "" ? supplier : "—"}</td>
                          <td className="text-end fw-semibold">{fmtEuro(p.priceValue)}</td>
                          <td className="text-end">
                            {p.lowStock ? (
                              <span className="badge text-bg-warning">{p.stock}</span>
                            ) : (
                              <span>{p.stock}</span>
                            )}
                            {p.minStock > 0 ? (
                              <div className="text-muted small products-min-stock-note">
                                Min: {p.minStock}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {p.isActive ? (
                              <span className="badge text-bg-success">Attivo</span>
                            ) : (
                              <span className="badge text-bg-secondary">Non attivo</span>
                            )}
                          </td>
                          <td className="text-end">
                            <a
                              className="btn btn-sm btn-outline-secondary"
                              href={href(`&action=edit&id=${p.id}`)}
                            >
                              Modifica
                            </a>{" "}
                            <a
                              className="btn btn-sm btn-outline-danger"
                              href={href(`&action=delete&id=${p.id}`)}
                              data-confirm="Eliminare definitivamente questo prodotto?"
                            >
                              Elimina
                            </a>
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
    </div>
  );
}
