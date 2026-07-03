"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP "Scadenziario e Costi" page, "Categorie" tab
// (app/pages/costs.php, tab=categories), fed by the existing DB-backed
// /api/manage/costs route (getManageCostsContext): the `categories` array drives
// the list table, the create/edit form persists via action=save_category, the
// per-row Attiva/Disattiva toggle via action=toggle_category and Elimina via
// action=category_delete.
//
// The legacy page used a separate action=cat_edit page + a Bootstrap create
// modal; here the create/edit editor is an INLINE Bootstrap card (like the
// sibling service_categories faithful component). The delete-when-linked refusal
// is enforced server-side (category_delete THROWS when costCount>0); the returned
// message is surfaced inline.

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

const DEFAULT_COLOR = "#6c757d";

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function CostCategoriesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline create/edit editor state. editId 0 = create mode, >0 = editing that id.
  const [editId, setEditId] = useState(0);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [isActive, setIsActive] = useState(true);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}&status=all`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: CostsResponse) => {
        setCategories(Array.isArray(j.categories) ? j.categories : []);
      })
      .catch(() => {
        setCategories([]);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`costs${suffix}`.replace("&", "?")}`;
  }

  // POST a category action to the costs API; on success refresh the list with the
  // returned categories (faithful: the legacy page reloaded after each save).
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

  function resetForm() {
    setEditId(0);
    setName("");
    setColor(DEFAULT_COLOR);
    setIsActive(true);
  }

  function startEdit(category: CostCategory) {
    setError("");
    setSuccess("");
    setEditId(category.id);
    setName(category.name);
    setColor(/^#[0-9A-Fa-f]{6}$/.test(category.color || "") ? category.color : DEFAULT_COLOR);
    setIsActive(category.isActive);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (name.trim() === "") {
      setError("Nome categoria obbligatorio.");
      return;
    }
    setSaving(true);
    const j = await postAction({
      action: "save_category",
      id: String(editId),
      name: name.trim(),
      color,
      is_active: isActive ? "1" : "0",
    });
    setSaving(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore nel salvataggio della categoria."));
      return;
    }
    applyResult(j);
    setSuccess(editId > 0 ? "Categoria aggiornata." : "Categoria creata.");
    resetForm();
  }

  async function onToggle(category: CostCategory) {
    if (busy) return;
    const confirmMsg = category.isActive
      ? `Disattivare la categoria "${category.name}"? Non sarà più selezionabile nei nuovi costi.`
      : `Riattivare la categoria "${category.name}"?`;
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) return;
    setError("");
    setSuccess("");
    setBusy(true);
    const j = await postAction({ action: "toggle_category", id: String(category.id) });
    setBusy(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore nel cambio di stato della categoria."));
      return;
    }
    applyResult(j);
  }

  async function onDelete(category: CostCategory) {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm(`Eliminare definitivamente la categoria "${category.name}"?`)) return;
    setError("");
    setSuccess("");
    setBusy(true);
    // The server refuses deletion when the category is linked to costs (it THROWS
    // "Categoria associata a N costi: disattivala…"); surface that message inline
    // and keep the category rather than pre-blocking client-side.
    const j = await postAction({ action: "category_delete", id: String(category.id) });
    setBusy(false);
    if (!j.ok) {
      setError(String(j.error ?? "Errore nell'eliminazione della categoria."));
      return;
    }
    applyResult(j);
    setSuccess("Categoria eliminata.");
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/costs.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Amministrazione</div>
          <h1 className="bs-page-title">Scadenziario e Costi</h1>
          <div className="bs-page-subtitle">Gestisci scadenze, costi e categorie operative.</div>
        </div>
      </div>

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

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {success ? <div className="alert alert-success">{success}</div> : null}

      <div className="card p-4 mb-3">
        <div className="fw-semibold mb-2">{editId > 0 ? "Modifica categoria" : "Nuova categoria"}</div>
        <form onSubmit={onSave}>
          <div className="row g-3">
            <div className="col-md-7">
              <label className="form-label">Nome</label>
              <input
                className="form-control"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="col-md-4">
              <label className="form-label">Colore</label>
              <input
                className="form-control form-control-color costs-category-color-picker"
                type="color"
                name="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                title="Scegli colore categoria"
              />
              <div className="form-text">Usato per badge in elenco.</div>
            </div>
            <div className="col-md-1">
              <label className="form-label">Attiva</label>
              <div className="form-check mt-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="cat_active"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="cat_active">
                  &nbsp;
                </label>
              </div>
            </div>
          </div>

          <hr className="my-3" />
          <div className="d-flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              {saving ? "Salvataggio…" : "Salva"}
            </button>
            {editId > 0 ? (
              <button className="btn btn-outline-secondary" type="button" onClick={resetForm}>
                Annulla
              </button>
            ) : null}
          </div>
        </form>
      </div>

      <div className="card card-soft">
        <div className="card-body">
          <div className="table-responsive costs-categories-table-wrap">
            <table className="table costs-categories-table align-middle mb-0">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Colore</th>
                  <th className="text-end">Costi associati</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-muted small p-3">
                      {loading ? "Caricamento…" : "Nessuna categoria. Creane una per organizzare i costi."}
                    </td>
                  </tr>
                ) : (
                  categories.map((category) => {
                    const badgeColor = /^#[0-9A-Fa-f]{6}$/.test(category.color || "") ? category.color : "";
                    return (
                      <tr key={category.id}>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <span
                              className="d-inline-block rounded-circle"
                              style={{ width: 12, height: 12, backgroundColor: badgeColor || DEFAULT_COLOR }}
                              aria-hidden="true"
                            />
                            <span className="fw-semibold">{category.name}</span>
                          </div>
                        </td>
                        <td>
                          {badgeColor ? (
                            <span
                              className="badge costs-color-badge"
                              data-cost-color={badgeColor}
                              style={{ backgroundColor: badgeColor }}
                            >
                              {badgeColor}
                            </span>
                          ) : (
                            <span className="text-muted">&mdash;</span>
                          )}
                        </td>
                        <td className="text-end">{category.costCount} costi</td>
                        <td>
                          {category.isActive ? (
                            <span className="badge text-bg-success">Attiva</span>
                          ) : (
                            <span className="badge text-bg-secondary">Disattiva</span>
                          )}
                        </td>
                        <td className="text-end costs-nowrap">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            type="button"
                            onClick={() => startEdit(category)}
                          >
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
                            title="Elimina"
                            onClick={() => onDelete(category)}
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
      </div>
    </div>
  );
}
