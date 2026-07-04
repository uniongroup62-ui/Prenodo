"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP products page, CATEGORIE view (app/pages/products.php,
// action=categories): filtro "Cerca per nome" + Filtra/Reset, form "Modifica
// categoria" inline (?edit_id=N), tabella Categoria/Azioni, modal "Nuova
// categoria" e modal "Impossibile eliminare la categoria" con l'elenco dei
// prodotti associati (derivato client-side dai products del context, come il
// productCategoryProductsMap legacy). Flash verbatim — INCLUSI i quirk legacy
// dove alcuni errori viaggiano come ?msg= (alert VERDE): "Nome categoria
// obbligatorio" e "Errore: categoria gia esistente o non valida".

type Category = { id: number; name: string };
type ProductLite = { id: number; name: string; sku: string; categoryId: number | null };

export type ProductCategoriesQuery = {
  category_search?: string;
  edit_id?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// product_display_name legacy: "Nome (SKU)".
function displayName(name: string, sku: string, fallback: string): string {
  const label = (name || "").trim() || fallback;
  const code = (sku || "").trim();
  return code ? `${label} (${code})` : label;
}

// I due "errori" che il legacy redirige come ?msg= (alert success verde).
const GREEN_QUIRK_MESSAGES = new Set(["Nome categoria obbligatorio", "Errore: categoria gia esistente o non valida"]);

export function ProductCategoriesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ProductCategoriesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState(() => ({
    search: String(initialQuery?.category_search ?? "").trim(),
    editId: Number.parseInt(String(initialQuery?.edit_id ?? "0"), 10) || 0,
  }));

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [draftSearch, setDraftSearch] = useState(initial.search);
  const [search, setSearch] = useState(initial.search);

  const [editId, setEditId] = useState(initial.editId);
  const [editName, setEditName] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");

  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Modal blocco eliminazione (productCategoryDeleteBlockModal legacy).
  const [deleteBlock, setDeleteBlock] = useState<{ categoryName: string; count: number; products: Array<{ id: number; label: string }> } | null>(null);

  const fetchData = useCallback(() => {
    fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const cats: Category[] = (Array.isArray(j.categories) ? j.categories : []).map((c: Record<string, unknown>) => ({ id: Number(c.id ?? 0), name: String(c.name ?? "") }));
        cats.sort((a, b) => a.name.localeCompare(b.name, "it"));
        setCategories(cats);
        setProducts(
          (Array.isArray(j.products) ? j.products : []).map((p: Record<string, unknown>) => ({
            id: Number(p.id ?? 0),
            name: String(p.name ?? ""),
            sku: String(p.sku ?? ""),
            categoryId: p.categoryId === null || p.categoryId === undefined ? null : Number(p.categoryId),
          })),
        );
        // Prefill ?edit_id al primo load (dentro il .then, quando le categorie sono note).
        const editCat = initial.editId > 0 ? cats.find((c) => c.id === initial.editId) : undefined;
        if (editCat) setEditName((prev) => (prev === "" ? editCat.name : prev));
      })
      .catch(() => {
        setCategories([]);
        setProducts([]);
      })
      .finally(() => setLoaded(true));
  }, [slug, initial.editId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`products${suffix}`.replace("&", "?")}`;
  }

  const searchSuffix = search ? `&category_search=${encodeURIComponent(search)}` : "";

  function applyFilter() {
    setSearch(draftSearch.trim());
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ action: "categories" });
      if (draftSearch.trim()) sp.set("category_search", draftSearch.trim());
      if (editId > 0) sp.set("edit_id", String(editId));
      window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    }
  }

  async function postAction(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      return { ok: res.ok && j.ok !== false, error: j.error };
    } catch {
      return { ok: false, error: "Errore di rete." };
    }
  }

  // Applica un esito col quirk legacy: alcuni errori arrivano come msg VERDE.
  function applyOutcome(result: { ok: boolean; error?: string }, successMsg: string): boolean {
    if (result.ok) {
      setFlash(successMsg);
      return true;
    }
    const message = String(result.error ?? "");
    if (GREEN_QUIRK_MESSAGES.has(message)) setFlash(message);
    else setError(message || "Errore.");
    return false;
  }

  async function saveCategory(id: number, name: string): Promise<boolean> {
    setFlash("");
    setError("");
    if (name.trim() === "") {
      // Quirk legacy: &msg=Nome categoria obbligatorio (alert verde).
      setFlash("Nome categoria obbligatorio");
      return false;
    }
    setBusy(true);
    const result = await postAction({ action: "category_save", cat_id: String(id), cat_name: name.trim(), id: String(id), name: name.trim() });
    setBusy(false);
    const ok = applyOutcome(result, id > 0 ? "Categoria aggiornata" : "Categoria creata");
    if (ok) fetchData();
    return ok;
  }

  // Elimina categoria (legacy action=delete&tab=categories): con prodotti
  // associati mostra il modal-blocco + err "Categoria non eliminabile...".
  async function deleteCategory(category: Category) {
    if (busy) return;
    setFlash("");
    setError("");
    const linked = products.filter((p) => Number(p.categoryId ?? 0) === category.id);
    if (linked.length > 0) {
      setDeleteBlock({
        categoryName: category.name || "Categoria",
        count: linked.length,
        products: linked.slice(0, 30).map((p) => ({ id: p.id, label: displayName(p.name, p.sku, `Prodotto #${p.id}`) })),
      });
      setError("Categoria non eliminabile: sono associati prodotti.");
      return;
    }
    setBusy(true);
    const result = await postAction({ action: "category_delete", id: String(category.id) });
    setBusy(false);
    if (applyOutcome(result, "Categoria eliminata")) fetchData();
  }

  function startEdit(category: Category) {
    setFlash("");
    setError("");
    setEditId(category.id);
    setEditName(category.name);
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ action: "categories", edit_id: String(category.id) });
      if (search) sp.set("category_search", search);
      window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function closeEdit() {
    setEditId(0);
    setEditName("");
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ action: "categories" });
      if (search) sp.set("category_search", search);
      window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    }
  }

  // Filtro legacy (stripos client-side).
  const listCats = useMemo(() => {
    if (!search) return categories;
    const needle = search.toLowerCase();
    return categories.filter((c) => c.name.toLowerCase().includes(needle));
  }, [categories, search]);

  const editCat = editId > 0 ? categories.find((c) => c.id === editId) ?? null : null;

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
            <a className="btn btn-outline-secondary" href={href("")}>Torna al magazzino</a>
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <i className="bi bi-plus-lg me-1" />
              Nuova categoria
            </button>
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="products-categories-filter-card mb-3">
        <form
          className="products-categories-filter-form"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilter();
          }}
        >
          <div className="products-categories-filter-field">
            <label className="form-label">Cerca per nome</label>
            <input className="form-control" name="category_search" value={draftSearch} onChange={(e) => setDraftSearch(e.target.value)} placeholder="Nome categoria" />
          </div>

          <div className="products-categories-filter-actions">
            <button className="btn btn-outline-primary products-categories-filter-submit app-filter-submit" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            <a className="btn btn-outline-secondary products-categories-reset app-filter-reset" href={href("&action=categories")}>
              Reset
            </a>
          </div>
        </form>
      </div>

      {editCat ? (
        <div className="card p-3 mb-3">
          <h2 className="h6 fw-semibold m-0">Modifica categoria</h2>

          <hr className="my-3" />

          <form
            method="post"
            className="row g-2 align-items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await saveCategory(editId, editName)) closeEdit();
            }}
          >
            <div className="col-md-8">
              <label className="form-label">Nome categoria</label>
              <input className="form-control" name="cat_name" required value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Es. Prodotti viso" />
            </div>

            <div className="col-md-4 d-flex gap-2">
              <button className="btn btn-success" type="submit" disabled={busy}>
                Aggiorna
              </button>
              <a className="btn btn-outline-secondary" href={href(`&action=categories${searchSuffix}`)} onClick={(e) => { e.preventDefault(); closeEdit(); }}>
                Annulla
              </a>
            </div>
          </form>
        </div>
      ) : null}

      <div className="card">
        <div className="table-responsive">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th>Categoria</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {listCats.length === 0 ? (
                <tr>
                  <td colSpan={2} className="text-muted p-3">
                    {!loaded ? "Caricamento…" : search !== "" ? "Nessuna categoria trovata con i filtri selezionati." : "Nessuna categoria."}
                  </td>
                </tr>
              ) : (
                listCats.map((c) => (
                  <tr key={c.id}>
                    <td className="fw-semibold">{c.name}</td>
                    <td className="text-end">
                      <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => startEdit(c)}>
                        Modifica
                      </button>{" "}
                      <button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => deleteCategory(c)}>
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal "Nuova categoria" (productCategoryCreateModal). */}
      {createOpen ? (
        <>
          <div className="modal fade show" id="productCategoryCreateModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <form
                  method="post"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await saveCategory(0, createName)) {
                      setCreateOpen(false);
                      setCreateName("");
                    }
                  }}
                >
                  <div className="modal-header">
                    <div>
                      <div className="text-muted small">Magazzino</div>
                      <h5 className="modal-title fw-bold m-0">Nuova categoria</h5>
                    </div>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setCreateOpen(false)} />
                  </div>

                  <div className="modal-body">
                    <label className="form-label" htmlFor="productCategoryCreateName">Nome categoria</label>
                    <input className="form-control" id="productCategoryCreateName" name="cat_name" required value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Es. Prodotti viso" />
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setCreateOpen(false)}>
                      Annulla
                    </button>
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setCreateOpen(false)} />
        </>
      ) : null}

      {/* Modal blocco eliminazione (productCategoryDeleteBlockModal). */}
      {deleteBlock ? (
        <>
          <div className="modal fade show" id="productCategoryDeleteBlockModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-dialog-centered modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <div className="text-muted small">Magazzino</div>
                    <h5 className="modal-title fw-bold m-0">Impossibile eliminare la categoria</h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteBlock(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning small mb-3">
                    La categoria <strong>{deleteBlock.categoryName}</strong> è associata a {deleteBlock.count} prodott{deleteBlock.count === 1 ? "o" : "i"} e non può essere eliminata. Sposta o elimina prima i prodotti elencati.
                  </div>
                  <div>
                    {deleteBlock.products.map((p) => (
                      <div key={p.id} className="border rounded-3 p-2 mb-2 fw-semibold">{p.label}</div>
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
