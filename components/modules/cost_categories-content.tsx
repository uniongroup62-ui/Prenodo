"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP "Scadenziario e Costi" page, "Categorie" tab
// (app/pages/costs.php, tab=categories): filtri (Cerca per nome / combobox
// Categoria / Stato) applicati con "Filtra", lista con selezione bulk
// ("N selezionati" + Disattiva/Elimina selezionate), badge stato custom
// (.costs-category-status-badge), azioni riga con le conferme/alert verbatim,
// bottone header "Nuova categoria" che apre il MODAL di creazione (come il
// legacy costCategoryCreateModal; ?action=cat_new lo apre al load) e pagina
// inline "Modifica categoria" per ?action=cat_edit&id=N.

type CostCategory = {
  id: number;
  name: string;
  color: string;
  isActive: boolean;
  costCount: number;
};

type CostsResponse = {
  ok?: boolean;
  error?: string;
  categories?: CostCategory[];
};

export type CostCategoriesQuery = {
  action?: string;
  id?: string;
  cat_q?: string;
  category_filter_id?: string;
  cat_status?: string;
};

const DEFAULT_COLOR = "#6c757d";

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Accent-insensitive lowercase (norm() del combobox in assets/js/pages/costs.js).
function comboNorm(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

type CatFilters = { q: string; id: number; status: "all" | "active" | "inactive" };

function filtersFromQuery(q: CostCategoriesQuery): CatFilters {
  const status = String(q.cat_status ?? "all");
  return {
    q: String(q.cat_q ?? "").trim(),
    id: Number.parseInt(String(q.category_filter_id ?? "0"), 10) || 0,
    status: status === "active" || status === "inactive" ? status : "all",
  };
}

export function CostCategoriesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CostCategoriesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState(() => ({
    filters: filtersFromQuery(initialQuery ?? {}),
    editId: initialQuery?.action === "cat_edit" ? Number.parseInt(String(initialQuery?.id ?? "0"), 10) || 0 : 0,
    openCreate: initialQuery?.action === "cat_new",
  }));

  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Filtri: draft (controlli) + applicati (submit "Filtra"), come il GET legacy.
  const [draftQ, setDraftQ] = useState(initial.filters.q);
  const [draftId, setDraftId] = useState(initial.filters.id);
  const [draftStatus, setDraftStatus] = useState<CatFilters["status"]>(initial.filters.status);
  const [filters, setFilters] = useState<CatFilters>(initial.filters);

  // Vista "Modifica categoria" (?action=cat_edit): sostituisce la lista.
  const [editId, setEditId] = useState(initial.editId);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);
  const [editActive, setEditActive] = useState(true);
  const [editReady, setEditReady] = useState(initial.editId === 0);

  // Modal "Nuova categoria" (legacy costCategoryCreateModal).
  const [createOpen, setCreateOpen] = useState(initial.openCreate);
  const [createName, setCreateName] = useState("");
  const [createColor, setCreateColor] = useState(DEFAULT_COLOR);
  const [createActive, setCreateActive] = useState(true);
  const createNameRef = useRef<HTMLInputElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  // Selezione bulk.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const masterRef = useRef<HTMLInputElement | null>(null);

  // Prefill del form ?action=cat_edit al primo load (dentro il .then della fetch,
  // quando le categorie sono note): id ignoto -> "Categoria non trovata" e lista.
  const pendingEditPrefillRef = useRef(initial.editId > 0);

  const load = useCallback(() => {
    fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}&status=all`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: CostsResponse) => {
        const list = Array.isArray(j.categories) ? j.categories : [];
        setCategories(list);
        if (pendingEditPrefillRef.current) {
          pendingEditPrefillRef.current = false;
          setEditId((currentId) => {
            const category = list.find((c) => c.id === currentId);
            if (!category) {
              setError("Categoria non trovata");
              setEditReady(true);
              return 0;
            }
            setEditName(category.name);
            setEditColor(/^#[0-9A-Fa-f]{6}$/.test(category.color || "") ? category.color : DEFAULT_COLOR);
            setEditActive(category.isActive);
            setEditReady(true);
            return currentId;
          });
        }
      })
      .catch(() => {
        setCategories([]);
      })
      .finally(() => setLoaded(true));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (createOpen) createNameRef.current?.select();
  }, [createOpen]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`costs${suffix}`.replace("&", "?")}`;
  }

  const postAction = useCallback(
    async (payload: Record<string, unknown>): Promise<CostsResponse> => {
      try {
        const res = await fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        return { ok: res.ok && j.ok !== false, error: j.error, categories: j.categories };
      } catch {
        return { ok: false, error: "Errore di rete." };
      }
    },
    [slug],
  );

  function applyResult(j: CostsResponse) {
    if (Array.isArray(j.categories)) setCategories(j.categories);
  }

  // Filtro legacy (array_filter client-side su id/stato/nome stripos).
  const categoryRows = useMemo(() => {
    return categories.filter((c) => {
      if (filters.id > 0 && c.id !== filters.id) return false;
      if (filters.status === "active" && !c.isActive) return false;
      if (filters.status === "inactive" && c.isActive) return false;
      if (filters.q !== "" && !c.name.toLowerCase().includes(filters.q.toLowerCase())) return false;
      return true;
    });
  }, [categories, filters]);

  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = selected.size > 0 && selected.size < categoryRows.length;
  }, [selected, categoryRows.length]);

  function applyFilters() {
    const next: CatFilters = { q: draftQ, id: draftId, status: draftStatus };
    setFilters(next);
    setSelected(new Set());
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ tab: "categories", cat_q: next.q, category_filter_id: String(next.id), cat_status: next.status });
      window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
    }
  }

  function startEdit(category: CostCategory) {
    setError("");
    setFlash("");
    setEditId(category.id);
    setEditName(category.name);
    setEditColor(/^#[0-9A-Fa-f]{6}$/.test(category.color || "") ? category.color : DEFAULT_COLOR);
    setEditActive(category.isActive);
    setEditReady(true);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `${window.location.pathname}?tab=categories&action=cat_edit&id=${category.id}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function closeEdit() {
    setEditId(0);
    setEditReady(true);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `${window.location.pathname}?tab=categories`);
    }
  }

  // save_category (dal form edit o dal modal): flash legacy Categoria aggiornata/creata.
  async function saveCategory(payload: { id: number; name: string; color: string; isActive: boolean }): Promise<boolean> {
    setError("");
    setFlash("");
    if (payload.name.trim() === "") {
      setError("Nome categoria obbligatorio");
      return false;
    }
    setSaving(true);
    const j = await postAction({
      action: "save_category",
      id: String(payload.id),
      name: payload.name.trim(),
      color: payload.color,
      is_active: payload.isActive ? "1" : "0",
    });
    setSaving(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore: salvataggio categoria non riuscito"));
      return false;
    }
    applyResult(j);
    setFlash(payload.id > 0 ? "Categoria aggiornata" : "Categoria creata");
    return true;
  }

  async function onToggle(category: CostCategory) {
    if (busy) return;
    const confirmMsg = category.isActive
      ? "Disattivare questa categoria? Non sara piu selezionabile nei nuovi costi."
      : "Riattivare questa categoria?";
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) return;
    setError("");
    setFlash("");
    setBusy(true);
    const j = await postAction({ action: "toggle_category", id: String(category.id) });
    setBusy(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore: stato categoria non aggiornato"));
      return;
    }
    applyResult(j);
    setFlash("Stato categoria aggiornato");
  }

  async function onDelete(category: CostCategory) {
    if (busy) return;
    // Legacy: con costi associati il bottone mostra solo l'ALERT informativo.
    if (category.costCount > 0) {
      if (typeof window !== "undefined") {
        window.alert(`Questa categoria e associata a ${category.costCount} costi e non puo essere eliminata. Puoi disattivarla per non usarla nei nuovi costi.`);
      }
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Questa categoria non e associata ad alcun costo. Eliminazione definitiva. Continuare?")) return;
    setError("");
    setFlash("");
    setBusy(true);
    const j = await postAction({ action: "category_delete", id: String(category.id) });
    setBusy(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore: impossibile eliminare categoria"));
      return;
    }
    applyResult(j);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(category.id);
      return next;
    });
    setFlash("Categoria eliminata");
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkAction(action: "bulk_deactivate_categories" | "bulk_delete_categories") {
    if (busy || selected.size === 0) return;
    const confirmMsg = action === "bulk_deactivate_categories"
      ? "Disattivare le categorie selezionate? Non saranno piu visibili nei nuovi costi."
      : "Eliminare definitivamente le categorie selezionate? Sara possibile solo se non sono associate a costi.";
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) return;
    setError("");
    setFlash("");
    setBusy(true);
    const j = await postAction({ action, category_ids: JSON.stringify([...selected]) });
    setBusy(false);
    if (!j.ok) {
      setError(String(j.error ?? (action === "bulk_deactivate_categories" ? "Errore: impossibile disattivare le categorie" : "Errore: impossibile eliminare le categorie")));
      return;
    }
    applyResult(j);
    setSelected(new Set());
    setFlash(action === "bulk_deactivate_categories" ? "Categorie disattivate" : "Categorie eliminate");
  }

  const editing = editId > 0;
  const allSelected = categoryRows.length > 0 && selected.size === categoryRows.length;
  const selectionLabel = `${selected.size} ${selected.size === 1 ? "selezionato" : "selezionati"}`;

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
            {!editing && categories.length > 0 ? (
              <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
                <i className="bi bi-plus-lg me-1" />
                Nuova categoria
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <ul className="nav nav-tabs costs-tabs mb-3">
        <li className="nav-item">
          <a className="nav-link " href={href("&tab=scadenziario")}>
            <i className="bi bi-calendar2-check me-1" />
            Scadenziario
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link active" href={href("&tab=categories")}>
            <i className="bi bi-tags me-1" />
            Categorie
          </a>
        </li>
      </ul>

      {editing ? (
        <div className="card p-4 mb-3">
          <div className="fw-semibold mb-2">Modifica categoria</div>
          <form
            method="post"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await saveCategory({ id: editId, name: editName, color: editColor, isActive: editActive })) closeEdit();
            }}
          >
            <div className="row g-3">
              <div className="col-md-7">
                <label className="form-label">Nome</label>
                <input className="form-control" name="name" value={editName} onChange={(e) => setEditName(e.target.value)} required />
              </div>
              <div className="col-md-4">
                <label className="form-label">Colore</label>
                <input
                  className="form-control form-control-color costs-category-color-picker"
                  type="color"
                  name="color"
                  value={editColor}
                  onChange={(e) => setEditColor(e.target.value)}
                  title="Scegli colore categoria"
                />
                <div className="form-text">Usato per badge in elenco.</div>
              </div>
              <div className="col-md-1">
                <label className="form-label">Attiva</label>
                <div className="form-check mt-2">
                  <input className="form-check-input" type="checkbox" name="is_active" id="cat_active" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                  <label className="form-check-label" htmlFor="cat_active">&nbsp;</label>
                </div>
              </div>
            </div>

            <hr className="my-3" />
            <div className="d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving || !editReady}>
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={closeEdit}>
                Annulla
              </button>
            </div>
          </form>
        </div>
      ) : loaded && categories.length === 0 ? (
        <div className="card border-0 shadow-sm costs-empty-card">
          <div className="costs-empty-state">
            <div className="costs-empty-icon" aria-hidden="true">
              <i className="bi bi-tags" />
            </div>
            <h2>Nessuna categoria creata</h2>
            <p>Le categorie ti aiutano a organizzare costi, fornitori e scadenze. Crea la prima categoria per renderla disponibile nei nuovi costi.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
                <i className="bi bi-plus-lg me-1" />
                Nuova categoria
              </button>
              <a className="btn btn-outline-secondary" href={href("&tab=scadenziario")}>
                <i className="bi bi-calendar2-check me-1" />
                Scadenziario
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="costs-categories-page">
          <div className="costs-categories-filter-card">
            <form
              className="costs-categories-filter-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
            >
              <div className="costs-categories-filter-field">
                <label className="form-label">Cerca per nome</label>
                <input className="form-control" name="cat_q" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder="Nome categoria" />
              </div>

              <div className="costs-categories-filter-field">
                <label className="form-label">Categoria</label>
                <CategoryExactFilterCombobox categories={categories} value={draftId} onChange={setDraftId} />
              </div>

              <div className="costs-categories-filter-field">
                <label className="form-label">Stato</label>
                <select className="form-select" name="cat_status" value={draftStatus} onChange={(e) => setDraftStatus(e.target.value as CatFilters["status"]) }>
                  <option value="all">Tutte</option>
                  <option value="active">Attive</option>
                  <option value="inactive">Disattive</option>
                </select>
              </div>

              <div className="costs-categories-filter-actions">
                <button className="btn btn-outline-primary costs-categories-filter-submit app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                <a className="btn btn-outline-secondary costs-categories-reset app-filter-reset" href={href("&tab=categories")}>
                  Reset
                </a>
              </div>
            </form>
          </div>

          <div className="costs-categories-list-card">
            {categoryRows.length === 0 ? (
              <>
                <div className="costs-categories-list-toolbar">
                  <div className="costs-categories-selection-info">0 selezionati</div>
                </div>
                <div className="costs-categories-empty-text">Nessuna categoria trovata con i filtri selezionati.</div>
              </>
            ) : (
              <form method="post" id="categoryBulkForm" onSubmit={(e) => e.preventDefault()}>
                <div className="costs-categories-list-toolbar">
                  <div className="costs-categories-selection-info" data-bulk-count>{selectionLabel}</div>
                  <div className="costs-categories-bulk-actions">
                    <button
                      className="btn btn-sm btn-outline-secondary costs-categories-bulk-btn"
                      type="button"
                      disabled={selected.size === 0 || busy}
                      onClick={() => bulkAction("bulk_deactivate_categories")}
                    >
                      <i className="bi bi-slash-circle me-1" />
                      Disattiva selezionate
                    </button>
                    <button
                      className="btn btn-sm btn-outline-danger costs-categories-bulk-btn"
                      type="button"
                      disabled={selected.size === 0 || busy}
                      onClick={() => bulkAction("bulk_delete_categories")}
                    >
                      <i className="bi bi-trash me-1" />
                      Elimina selezionate
                    </button>
                  </div>
                </div>
                <div className="table-responsive costs-categories-table-wrap">
                  <table className="table costs-categories-table mb-0">
                    <thead>
                      <tr>
                        <th className="costs-bulk-col">
                          <input
                            ref={masterRef}
                            className="form-check-input"
                            type="checkbox"
                            aria-label="Seleziona tutte"
                            checked={allSelected}
                            onChange={() => setSelected(allSelected ? new Set() : new Set(categoryRows.map((c) => c.id)))}
                          />
                        </th>
                        <th>Nome</th>
                        <th>Colore</th>
                        <th className="text-end">Costi associati</th>
                        <th>Stato</th>
                        <th className="text-end">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categoryRows.map((category) => {
                        const color = category.color || "";
                        return (
                          <tr key={category.id}>
                            <td>
                              <input
                                className="form-check-input"
                                type="checkbox"
                                aria-label={`Seleziona ${category.name}`}
                                checked={selected.has(category.id)}
                                onChange={() => toggleSelected(category.id)}
                              />
                            </td>
                            <td className="fw-semibold">{category.name}</td>
                            <td>
                              {color ? (
                                <span className="badge costs-color-badge" data-cost-color={color} style={{ backgroundColor: color }}>
                                  {color}
                                </span>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td className="text-end">{category.costCount}</td>
                            <td>
                              {category.isActive ? (
                                <span className="costs-category-status-badge is-active">Attiva</span>
                              ) : (
                                <span className="costs-category-status-badge is-inactive">Disattiva</span>
                              )}
                            </td>
                            <td className="text-end costs-nowrap">
                              <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => startEdit(category)}>
                                Modifica
                              </button>{" "}
                              <button
                                className={`btn btn-sm ${category.isActive ? "btn-outline-warning" : "btn-outline-success"}`}
                                type="button"
                                disabled={busy}
                                title={category.isActive ? "Disattiva" : "Attiva"}
                                onClick={() => onToggle(category)}
                              >
                                {category.isActive ? "Disattiva" : "Attiva"}
                              </button>{" "}
                              <button
                                className="btn btn-sm btn-outline-danger"
                                type="button"
                                disabled={busy}
                                title={category.costCount > 0 ? "Categoria associata a costi: puoi solo disattivarla" : "Elimina"}
                                onClick={() => onDelete(category)}
                              >
                                Elimina
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Modal "Nuova categoria" (costCategoryCreateModal). */}
      {createOpen && !editing ? (
        <>
          <div className="modal fade show" id="costCategoryCreateModal" style={{ display: "block" }} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="costCategoryCreateModalTitle">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <form
                  method="post"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await saveCategory({ id: 0, name: createName, color: createColor, isActive: createActive })) {
                      setCreateOpen(false);
                      setCreateName("");
                      setCreateColor(DEFAULT_COLOR);
                      setCreateActive(true);
                    }
                  }}
                >
                  <div className="modal-header">
                    <h5 className="modal-title" id="costCategoryCreateModalTitle">Nuova categoria</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setCreateOpen(false)} />
                  </div>
                  <div className="modal-body">
                    <div className="mb-3">
                      <label className="form-label" htmlFor="costCategoryCreateName">Nome</label>
                      <input ref={createNameRef} className="form-control" id="costCategoryCreateName" name="name" value={createName} onChange={(e) => setCreateName(e.target.value)} required />
                    </div>

                    <div className="row g-3 align-items-start">
                      <div className="col-sm-8">
                        <label className="form-label" htmlFor="costCategoryCreateColor">Colore</label>
                        <input
                          className="form-control form-control-color costs-category-color-picker"
                          type="color"
                          id="costCategoryCreateColor"
                          name="color"
                          value={createColor}
                          onChange={(e) => setCreateColor(e.target.value)}
                          title="Scegli colore categoria"
                        />
                        <div className="form-text">Usato per badge in elenco.</div>
                      </div>
                      <div className="col-sm-4">
                        <label className="form-label" htmlFor="costCategoryCreateActive">Attiva</label>
                        <div className="form-check mt-2">
                          <input className="form-check-input" type="checkbox" name="is_active" id="costCategoryCreateActive" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} />
                          <label className="form-check-label" htmlFor="costCategoryCreateActive">Si</label>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setCreateOpen(false)}>
                      Annulla
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={saving}>
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
    </div>
  );
}

// Combobox "Categoria" dei filtri (costCategoryExactFilterBox): stesso port
// dell'.app-combobox legacy con item "Tutte" e label " (disattiva)".
function CategoryExactFilterCombobox(props: {
  categories: CostCategory[];
  value: number;
  onChange: (id: number) => void;
}) {
  const { categories, value, onChange } = props;
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
  const selected = value > 0 ? data.find((item) => item.id === String(value)) : undefined;

  const pick = (id: string) => {
    onChange(Number.parseInt(id, 10) || 0);
    setOpen(false);
  };

  return (
    <div className={`app-combobox dropdown${open ? " show" : ""}`} id="costCategoryExactFilterBox" ref={boxRef}>
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
      <input type="hidden" name="category_filter_id" value={String(value || 0)} readOnly />
    </div>
  );
}
