"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP product NEW / EDIT form (app/pages/products.php,
// action=new|edit). Field groups and Bootstrap markup mirror the legacy editor:
//   - Dati prodotto: name, brand, product_code (=> sku), internal_code
//   - Categoria / Prezzi: category_id, price (vendita), purchase_price (acquisto)
//   - Sedi abbinate: per-location checkboxes (location_ids[]); shown only when
//     more than one location exists (the legacy form hides the picker and posts a
//     single hidden location_id otherwise).
//   - Visibilita: sell_online (Visibile pubblicamente)
//   - Magazzino: giacenza (read-only, managed by Carico/Scarico), min_stock,
//     reorder_qty, supplier_name
//   - Scheda prodotto: description, ingredients, warnings
// Submits to /api/manage/products (action=save; create when no id, update with id).
//
// TODO: product images (product_images upload / main / reorder, the AJAX
// endpoints in products.php) are NOT ported here; image management stays a
// follow-up. The name/code and price "impacted references" confirmation popups
// (products_update_confirm_popup / products_price_update_confirm_popup) are
// server-side flows applied automatically on save and are not surfaced as
// client confirmations yet.

type Category = { id: number; name: string };
type LocationRow = { id: number; name: string; isActive?: boolean };
type SupplierRow = { id: number; name: string; isActive?: boolean };

type ProductContext = {
  ok?: boolean;
  categories?: Category[];
  locations?: LocationRow[];
  suppliers?: SupplierRow[];
};

type ProductForm = {
  id: number;
  name: string;
  brand: string;
  product_code: string;
  internal_code: string;
  category_id: string;
  price: string;
  purchase_price: string;
  sell_online: boolean;
  min_stock: string;
  reorder_qty: string;
  supplier_name: string;
  description: string;
  ingredients: string;
  warnings: string;
  location_ids: number[];
  stock: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): ProductForm {
  return {
    id: 0,
    name: "",
    brand: "",
    product_code: "",
    internal_code: "",
    category_id: "",
    price: "0.00",
    purchase_price: "0.00",
    sell_online: true,
    min_stock: "10",
    reorder_qty: "0",
    supplier_name: "",
    description: "",
    ingredients: "",
    warnings: "",
    location_ids: [],
    stock: 0,
  };
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function ProductFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [form, setForm] = useState<ProductForm>(emptyForm());
  const [ctx, setCtx] = useState<ProductContext>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // GALLERIA immagini (port delle azioni AJAX di products.php: max 5, la prima
  // è la principale). In EDIT è interattiva (upload/set-main/delete immediati);
  // in CREAZIONE i file selezionati vengono caricati DOPO il save (id risolto
  // dalla lista restituita).
  type ProductImage = { id: number; url: string; isMain: boolean };
  const [images, setImages] = useState<ProductImage[]>([]);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [imagesKey, setImagesKey] = useState(0); // resetta l'input file

  // Load the context (categories/locations/suppliers), then prefill on edit
  // (action=get) or apply faithful new-product defaults (all active locations
  // pre-selected, like products.php action=new).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ProductContext) => {
        setCtx(j ?? {});
        return j ?? {};
      })
      .catch(() => {
        setCtx({});
        return {} as ProductContext;
      });

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.product) {
            setError(String(j.error ?? "Prodotto non trovato."));
            return;
          }
          const p = j.product;
          setForm({
            id: Number(p.id ?? id),
            name: String(p.name ?? ""),
            brand: String(p.brand ?? ""),
            product_code: String(p.sku ?? ""),
            internal_code: String(p.internalCode ?? ""),
            category_id: p.categoryId ? String(p.categoryId) : "",
            price: String(p.priceValue ?? 0),
            purchase_price: String(p.purchasePrice ?? 0),
            sell_online: Boolean(p.sellOnline ?? p.publicVisible ?? false),
            min_stock: String(p.minStock ?? 10),
            reorder_qty: String(p.reorderQty ?? 0),
            supplier_name: String(p.supplierName ?? ""),
            description: String(p.description ?? ""),
            ingredients: String(p.ingredients ?? ""),
            warnings: String(p.warnings ?? ""),
            location_ids: (p.locationIds ?? []).map(Number).filter((n: number) => n > 0),
            stock: Number(p.stock ?? 0) || 0,
          });
        })
        .catch(() => setError("Errore nel caricamento del prodotto."))
        .finally(() => setLoading(false));
    } else {
      // New product: pre-select all active locations (faithful to the legacy
      // form, where every managed location checkbox starts checked).
      ctxPromise
        .then((j) => {
          const locs = (j.locations ?? []).filter((l) => l.isActive !== false).map((l) => Number(l.id));
          setForm((prev) => ({ ...prev, location_ids: locs }));
        })
        .finally(() => setLoading(false));
    }
  }, [slug]);

  function set<K extends keyof ProductForm>(key: K, value: ProductForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleLocation(id: number, checked: boolean) {
    setForm((prev) => {
      const current = new Set(prev.location_ids);
      if (checked) current.add(id);
      else current.delete(id);
      return { ...prev, location_ids: Array.from(current) };
    });
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/products`;
  }

  const categories = useMemo(() => ctx.categories ?? [], [ctx.categories]);
  const locations = useMemo(() => ctx.locations ?? [], [ctx.locations]);
  // Active suppliers for the select, keeping the currently-saved supplier as a
  // fallback option even if inactive / not in the list (like products.php).
  const suppliers = useMemo(
    () => (ctx.suppliers ?? []).filter((s) => s.isActive !== false),
    [ctx.suppliers],
  );

  // Carica la galleria in EDIT (GET product-image?product_id=).
  useEffect(() => {
    if (action !== "edit" || form.id <= 0) return;
    let active = true;
    fetch(`/api/manage/product-image?slug=${encodeURIComponent(slug)}&product_id=${form.id}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (active && Array.isArray(j.images)) setImages(j.images);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [action, form.id, slug]);

  // POST verso /api/manage/product-image (upload / delete / set_main); ogni
  // risposta porta la lista aggiornata come gli endpoint AJAX legacy.
  async function postImages(productId: number, fd: FormData): Promise<string | null> {
    setImagesBusy(true);
    try {
      fd.set("product_id", String(productId));
      const res = await fetch(`/api/manage/product-image?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: fd,
      });
      const j = await res.json().catch(() => ({}));
      if (Array.isArray(j.images)) setImages(j.images);
      const errs: string[] = Array.isArray(j.errors) ? j.errors : [];
      if (!res.ok || (j.ok === false && !errs.length)) return String(j.error ?? "Errore immagini prodotto.");
      return errs.length ? errs.join(" ") : null;
    } catch {
      return "Errore di rete durante il caricamento immagini.";
    } finally {
      setImagesBusy(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to products.php: name required, sale + purchase price
    // not negative.
    const name = form.name.trim();
    const price = Number.parseFloat(form.price.replace(",", "."));
    const purchasePrice = Number.parseFloat(form.purchase_price.replace(",", "."));
    if (name === "") {
      setError("Nome prodotto obbligatorio.");
      return;
    }
    if (Number.isFinite(price) && price < 0) {
      setError("Il prezzo di vendita non puo essere negativo.");
      return;
    }
    if (Number.isFinite(purchasePrice) && purchasePrice < 0) {
      setError("Il prezzo di acquisto non puo essere negativo.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "save",
        id: String(form.id),
        name,
        brand: form.brand,
        product_code: form.product_code,
        internal_code: form.internal_code,
        category_id: form.category_id,
        price: String(Number.isFinite(price) ? price : 0),
        purchase_price: String(Number.isFinite(purchasePrice) ? purchasePrice : 0),
        sell_online: form.sell_online ? "1" : "0",
        min_stock: form.min_stock,
        reorder_qty: form.reorder_qty,
        supplier_name: form.supplier_name,
        description: form.description,
        ingredients: form.ingredients,
        warnings: form.warnings,
        location_ids: form.location_ids.join(","),
      };
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del prodotto."));
        setSaving(false);
        return;
      }

      // IMMAGINI in CREAZIONE: upload dopo il save (id risolto dalla lista
      // restituita: match nome, id più alto). Il prodotto è GIÀ salvato.
      if (action === "new" && pendingImages.length > 0) {
        type SavedProduct = { id: number; name: string };
        const list: SavedProduct[] = Array.isArray(j.products) ? j.products : [];
        const createdId = list
          .filter((p) => String(p.name).trim().toLowerCase() === name.toLowerCase())
          .reduce((max, p) => Math.max(max, Number(p.id) || 0), 0);
        if (createdId > 0) {
          const fd = new FormData();
          for (const file of pendingImages) fd.append("images", file);
          const imgError = await postImages(createdId, fd);
          if (imgError) {
            setError(`Prodotto salvato, ma immagini non caricate: ${imgError}`);
            setSaving(false);
            return;
          }
        } else {
          setError("Prodotto salvato, ma immagini non caricate (prodotto non identificato). Riapri il prodotto e ricaricale.");
          setSaving(false);
          return;
        }
      }

      backToList();
    } catch {
      setError("Errore nel salvataggio del prodotto.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo prodotto" : "Modifica prodotto";
  const showLocationPicker = locations.length > 1;
  const supplierName = form.supplier_name.trim();
  const supplierInList = suppliers.some((s) => (s.name ?? "") === supplierName);

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
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/products`}>
              Torna al magazzino
            </a>
          </div>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="card p-3 mb-3">
          <h2 className="h6 fw-semibold m-0">{title}</h2>
          <hr className="my-3" />

          <form method="post" id="productForm" onSubmit={onSubmit}>
            <input type="hidden" name="id" value={form.id} />

            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label">Nome</label>
                <input
                  className="form-control"
                  name="name"
                  required
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </div>

              <div className="col-md-4">
                <label className="form-label">Brand</label>
                <input
                  className="form-control"
                  name="brand"
                  placeholder="Es. Vivamed"
                  value={form.brand}
                  onChange={(e) => set("brand", e.target.value)}
                />
              </div>

              <div className="col-md-2">
                <label className="form-label">Codice prodotto</label>
                <input
                  className="form-control"
                  name="product_code"
                  placeholder="Es. 12345"
                  value={form.product_code}
                  onChange={(e) => set("product_code", e.target.value)}
                />
              </div>

              <div className="col-md-2">
                <label className="form-label">Codice interno</label>
                <input
                  className="form-control"
                  name="internal_code"
                  placeholder="Es. INT-001"
                  value={form.internal_code}
                  onChange={(e) => set("internal_code", e.target.value)}
                />
              </div>

              <div className="col-12">
                <hr className="my-2" />
              </div>

              <div className="col-md-3">
                <label className="form-label">Categoria</label>
                <select
                  className="form-select"
                  name="category_id"
                  value={form.category_id}
                  onChange={(e) => set("category_id", e.target.value)}
                >
                  <option value="">— Nessuna —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {categories.length === 0 ? (
                  <div className="form-text">Nessuna categoria: crea prima da “Categorie”.</div>
                ) : null}
              </div>

              <div className="col-md-3">
                <label className="form-label">Prezzo vendita</label>
                <input
                  className="form-control"
                  type="number"
                  step="0.01"
                  name="price"
                  value={form.price}
                  onChange={(e) => set("price", e.target.value)}
                />
              </div>

              <div className="col-md-3">
                <label className="form-label">Prezzo acquisto</label>
                <input
                  className="form-control"
                  type="number"
                  step="0.01"
                  name="purchase_price"
                  value={form.purchase_price}
                  onChange={(e) => set("purchase_price", e.target.value)}
                />
              </div>

              {showLocationPicker ? (
                <div className="col-md-6">
                  <label className="form-label">Sedi abbinate</label>
                  <div className="border rounded-3 p-2 d-flex flex-wrap gap-3">
                    {locations.map((loc) => {
                      const lid = Number(loc.id);
                      if (lid <= 0) return null;
                      return (
                        <label className="form-check m-0" key={lid}>
                          <input
                            className="form-check-input"
                            type="checkbox"
                            name="location_ids[]"
                            value={lid}
                            checked={form.location_ids.includes(lid)}
                            onChange={(e) => toggleLocation(lid, e.target.checked)}
                          />
                          <span className="form-check-label">{loc.name || `Sede #${lid}`}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="form-text">
                    Il prodotto comparira in magazzino, POS e booking solo nelle sedi selezionate.
                  </div>
                </div>
              ) : null}

              <div className="col-md-3">
                <label className="form-label">Visibilità</label>
                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="sell_online"
                    id="sell_online"
                    value="1"
                    checked={form.sell_online}
                    onChange={(e) => set("sell_online", e.target.checked)}
                  />
                  <label className="form-check-label fw-semibold" htmlFor="sell_online">
                    Visibile pubblicamente
                  </label>
                  <div className="form-text">Comparirà nel catalogo pubblico e nella scheda attività.</div>
                </div>
              </div>

              <div className="col-12">
                <hr className="my-2" />
              </div>

              <div className="col-md-3">
                <label className="form-label">Giacenza</label>
                <input className="form-control" type="number" value={form.stock} disabled />
                <div className="form-text">
                  Aggiornata da{" "}
                  <a href={`/${encodeURIComponent(slug)}/stock_moves`}>Carico / Scarico</a>.
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Quantità minima</label>
                <input
                  className="form-control"
                  type="number"
                  name="min_stock"
                  min="0"
                  value={form.min_stock}
                  onChange={(e) => set("min_stock", e.target.value)}
                />
                <div className="form-text">
                  Alert e filtro “Quasi esauriti” quando la giacenza scende sotto questa soglia.
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Quantità di riordino</label>
                <input
                  className="form-control"
                  type="number"
                  name="reorder_qty"
                  min="0"
                  value={form.reorder_qty}
                  onChange={(e) => set("reorder_qty", e.target.value)}
                />
                <div className="form-text">
                  Promemoria interno: quantità consigliata da ordinare per questo prodotto.
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Fornitore</label>
                <select
                  className="form-select"
                  name="supplier_name"
                  value={form.supplier_name}
                  onChange={(e) => set("supplier_name", e.target.value)}
                >
                  <option value="">— Nessuno —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                  {supplierName !== "" && !supplierInList ? (
                    <option value={supplierName}>{supplierName} (inattivo o non in elenco)</option>
                  ) : null}
                </select>
                <div className="form-text">
                  <a href={`/${encodeURIComponent(slug)}/suppliers`}>Gestisci fornitori</a>
                  {suppliers.length === 0 ? " • Nessun fornitore: aggiungilo da “Fornitori”." : null}
                </div>
              </div>

              <div className="col-12">
                <hr className="my-2" />
              </div>

              <div className="col-12">
                <div className="fw-semibold">Scheda prodotto</div>
                <div className="form-text">
                  Questi campi vengono mostrati nelle “schede prodotto” del booking pubblico (tab “Prodotti”).
                </div>
              </div>

              <div className="col-12">
                <label className="form-label">Descrizione</label>
                <textarea
                  className="form-control"
                  name="description"
                  rows={3}
                  placeholder="Descrizione del prodotto…"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label className="form-label">Ingredienti</label>
                <textarea
                  className="form-control"
                  name="ingredients"
                  rows={3}
                  placeholder="Ingredienti…"
                  value={form.ingredients}
                  onChange={(e) => set("ingredients", e.target.value)}
                />
              </div>

              <div className="col-md-6">
                <label className="form-label">Avvertenze</label>
                <textarea
                  className="form-control"
                  name="warnings"
                  rows={3}
                  placeholder="Avvertenze / precauzioni…"
                  value={form.warnings}
                  onChange={(e) => set("warnings", e.target.value)}
                />
              </div>
            </div>

            {/* Galleria immagini (port del box products.php: max 5, la PRIMA è la
                principale — set_main la porta in testa; delete con conferma).
                In EDIT le azioni sono immediate (AJAX legacy); in CREAZIONE i file
                partono dopo il salvataggio. */}
            <hr className="my-3" />
            <div className="mb-3">
              <div className="fw-semibold mb-2">
                <i className="bi bi-images me-1" />
                Immagini prodotto <span className="text-muted small">(max 5, la prima è la principale)</span>
              </div>
              {action === "edit" && images.length > 0 ? (
                <div className="d-flex flex-wrap gap-2 mb-2">
                  {images.map((img) => (
                    <div className="border rounded p-1 text-center" style={{ width: 120 }} key={img.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="rounded" style={{ width: "100%", height: 80, objectFit: "cover" }} />
                      <div className="d-flex justify-content-between align-items-center mt-1">
                        {img.isMain ? (
                          <span className="badge text-bg-primary">Principale</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-link p-0 small"
                            disabled={imagesBusy}
                            onClick={() => {
                              const fd = new FormData();
                              fd.set("set_main_img_id", String(img.id));
                              void postImages(form.id, fd).then((err) => err && setError(err));
                            }}
                          >
                            Principale
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-link text-danger p-0"
                          title="Elimina immagine"
                          disabled={imagesBusy}
                          onClick={() => {
                            if (typeof window !== "undefined" && !window.confirm("Eliminare questa immagine?")) return;
                            const fd = new FormData();
                            fd.set("delete_img_id", String(img.id));
                            void postImages(form.id, fd).then((err) => err && setError(err));
                          }}
                        >
                          <i className="bi bi-trash" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {action === "new" && pendingImages.length > 0 ? (
                <div className="small text-muted mb-1">
                  {pendingImages.length} immagini selezionate — verranno caricate al salvataggio.
                </div>
              ) : null}
              <input
                key={imagesKey}
                className="form-control"
                type="file"
                name="images"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif"
                disabled={imagesBusy || (action === "edit" && images.length >= 5)}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []).filter((f) => f.size > 0);
                  const tooBig = files.find((f) => f.size > 5 * 1024 * 1024);
                  if (tooBig) {
                    setError("Immagine troppo grande (max 5 MB).");
                    e.target.value = "";
                    return;
                  }
                  setError("");
                  if (action === "new") {
                    setPendingImages(files.slice(0, 5));
                    return;
                  }
                  if (files.length && form.id > 0) {
                    const fd = new FormData();
                    for (const file of files) fd.append("images", file);
                    void postImages(form.id, fd).then((err) => {
                      if (err) setError(err);
                      setImagesKey((k) => k + 1);
                    });
                  }
                }}
              />
              <div className="form-text">JPG, PNG, WEBP o GIF — massimo 5 MB per immagine, 5 immagini per prodotto.</div>
            </div>

            <hr className="my-3" />
            <div className="d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                {saving ? "Salvataggio…" : "Salva"}
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={backToList}>
                Annulla
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
