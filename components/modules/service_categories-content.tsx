"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

// Faithful port of the PHP services page, "Categorie" tab
// (?page=services&tab=categories). Fed by the existing DB-backed
// /api/manage/services route (getManageServicesContext): the `categories`
// array drives the table, the `services` array drives the per-category
// filter combobox and the delete-block payload.
//
// The Nuova/Modifica categoria editors are INLINE Bootstrap modals (faithful to
// the legacy page, which used modals rather than a separate action=new/edit
// page). They now persist via /api/manage/services (action=category_save), and
// the reorder up/down + delete buttons call category_move / category_delete.
//
// IMMAGINE CATEGORIA: il file input (image_file, max 5MB) è collegato a
// /api/manage/category-image (multipart -> Cloudflare R2, image_url = URL
// pubblico) e viaggia DOPO category_save (in creazione serve l'id, risolto
// dalla lista restituita). "Rimuovi immagine" replica delete_image del legacy.
// Divergenza documentata: niente compressione/resize server-side
// (process_uploaded_image 1600px) — l'immagine è salvata come caricata.

type Category = {
  id: number;
  name: string;
  imageUrl?: string;
  sortOrder?: number;
  isDefault?: boolean;
  serviceCount?: number;
};

type Service = {
  id: number;
  name: string;
  categoryId?: number;
  sortOrder?: number;
  isActive?: boolean;
  active?: boolean;
};

type ServicesContext = {
  categories?: Category[];
  services?: Service[];
};

type CategoryResult = { ok: boolean; error?: string; msg?: string; popup?: CategoryBlockPopup; categories?: Category[]; services?: Service[] };
type CategoriesQuery = { msg?: string; err?: string; action?: string; id?: string; category_id?: string; p?: string };
type CategoryBlockPopup = { category_name: string; services: Array<{ id: number; name: string; active: boolean }> };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function ServiceCategoriesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CategoriesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [categories, setCategories] = useState<Category[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  // Flash legacy dal redirect (?msg / ?err) + vista/pagina/filtro dal querystring.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);
  const orderCategoryId = initialQuery?.action === "order" ? Math.max(0, Number.parseInt(initialQuery?.id ?? "0", 10) || 0) : 0;
  const page = Math.max(1, Number.parseInt(initialQuery?.p ?? "1", 10) || 1);
  const [filterCategoryId, setFilterCategoryId] = useState<string>(() => {
    const raw = Number.parseInt(initialQuery?.category_id ?? "0", 10) || 0;
    return raw > 0 ? String(raw) : "";
  });
  const [blockPopup, setBlockPopup] = useState<CategoryBlockPopup | null>(null);
  const [blockOpenList, setBlockOpenList] = useState(false);
  // Ordine servizi nella categoria (action=order): base dal server, override
  // locale quando l'utente sposta le righe.
  const [orderOverride, setOrderOverride] = useState<number[] | null>(null);
  const [editModalId, setEditModalId] = useState<number | null>(() => (initialQuery?.action === "edit" ? Math.max(0, Number.parseInt(initialQuery?.id ?? "0", 10) || 0) || null : null));
  const [createOpen, setCreateOpen] = useState(initialQuery?.action === "new");
  const [createName, setCreateName] = useState("");
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [busyMove, setBusyMove] = useState(false);
  // Immagine categoria: file scelto nei due modal + flag "rimuovi" (edit).
  const [createImageFile, setCreateImageFile] = useState<File | null>(null);
  const [editImageFile, setEditImageFile] = useState<File | null>(null);
  const [editRemoveImage, setEditRemoveImage] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}&tab=categories`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServicesContext) => {
        setCategories(Array.isArray(j.categories) ? j.categories : []);
        setServices(Array.isArray(j.services) ? j.services : []);
      })
      .catch(() => {
        setCategories([]);
        setServices([]);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // Ordine base per la vista "Ordina servizi" (services.php 3789-3795:
  // sort_order ASC, name ASC), sostituito dall'override quando l'utente sposta.
  const orderIds = useMemo(() => {
    if (orderOverride) return orderOverride;
    if (!orderCategoryId) return [];
    return services
      .filter((s) => Number(s.categoryId) === orderCategoryId)
      .sort((a, b) => (Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)) || a.name.localeCompare(b.name))
      .map((s) => s.id);
  }, [orderOverride, services, orderCategoryId]);

  function tabHref(tab: string): string {
    return `/${encodeURIComponent(slug)}/services?tab=${tab}`;
  }

  // Redirect flash legacy (?tab=categories&msg=/err= conservando filtro/pagina).
  function redirectFlash(params: Record<string, string | number>, keepReturn = false) {
    const usp = new URLSearchParams({ tab: "categories" });
    if (keepReturn) {
      if (filterCategoryId) usp.set("category_id", filterCategoryId);
      if (page > 1) usp.set("p", String(page));
    }
    const flash: { msg?: string; err?: string } = {};
    for (const [k, v] of Object.entries(params)) {
      if (String(v) === "") continue;
      if (k === "msg") flash.msg = String(v);
      else if (k === "err") flash.err = String(v);
      else usp.set(k, String(v));
    }
    flashNavigate(`/${encodeURIComponent(slug)}/services?${usp.toString()}`, flash);
  }

  // POST a category action to the services API; on success refresh the list with
  // the returned categories (faithful: the legacy page reloaded after each save).
  const postCategory = useCallback(
    async (payload: Record<string, unknown>): Promise<CategoryResult> => {
      try {
        const res = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        return { ok: res.ok && j.ok !== false, error: j.error, categories: j.categories, services: j.services };
      } catch {
        return { ok: false, error: "Errore di rete." };
      }
    },
    [slug],
  );

  function applyResult(j: CategoryResult) {
    if (Array.isArray(j.categories)) setCategories(j.categories);
    if (Array.isArray(j.services)) setServices(j.services);
  }

  // Upload/rimozione immagine su /api/manage/category-image (dopo il save).
  // Ritorna null in successo, altrimenti il messaggio d'errore.
  const uploadCategoryImage = useCallback(
    async (categoryId: number, file: File | null, remove: boolean): Promise<string | null> => {
      if (!file && !remove) return null;
      const fd = new FormData();
      fd.set("category_id", String(categoryId));
      if (file) fd.set("image_file", file);
      else fd.set("remove_image", "1");
      try {
        const res = await fetch(`/api/manage/category-image?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "x-tenant-slug": slug },
          body: fd,
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) return String(j.error ?? "errore caricamento immagine.");
        return null;
      } catch {
        return "errore di rete durante il caricamento immagine.";
      }
    },
    [slug],
  );

  async function onCreateSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    // Messaggio legacy senza punto (services.php 3641, mostrato NEL modal).
    if (createName.trim() === "") {
      setError("Nome categoria obbligatorio");
      return;
    }
    setSaving(true);
    const j = await postCategory({ action: "category_save", id: "0", name: createName });
    if (!j.ok) {
      setSaving(false);
      setError(String(j.error ?? "Nome categoria obbligatorio"));
      return;
    }
    // Immagine: la categoria è APPENA creata — risolvo l'id dalla lista
    // restituita (match per nome, id più alto: l'ultima inserita).
    if (createImageFile) {
      const createdId = (j.categories ?? [])
        .filter((c) => c.name.trim().toLowerCase() === createName.trim().toLowerCase())
        .reduce((max, c) => Math.max(max, c.id), 0);
      const imageError = createdId > 0 ? await uploadCategoryImage(createdId, createImageFile, false) : "categoria creata ma non identificata.";
      if (imageError) {
        redirectFlash({ err: `Categoria salvata, ma l'immagine non è stata caricata: ${imageError}` });
        return;
      }
    }
    // Redirect flash legacy (services.php 3659).
    redirectFlash({ msg: "Categoria creata" });
  }

  async function onEditSubmit(event: React.FormEvent, categoryId: number) {
    event.preventDefault();
    setError("");
    if (editName.trim() === "") {
      setError("Nome categoria obbligatorio");
      return;
    }
    setSaving(true);
    const j = await postCategory({ action: "category_save", id: String(categoryId), name: editName });
    if (!j.ok) {
      setSaving(false);
      setError(String(j.error ?? "Nome categoria obbligatorio"));
      return;
    }
    const imageError = await uploadCategoryImage(categoryId, editImageFile, !editImageFile && editRemoveImage);
    if (imageError) {
      redirectFlash({ err: `Categoria salvata, ma l'immagine non è stata aggiornata: ${imageError}` });
      return;
    }
    // Redirect flash legacy (services.php 3665).
    redirectFlash({ msg: "Categoria aggiornata" });
  }

  // Spostamento con flash legacy che conserva filtro e pagina (3509-3524).
  async function onMove(categoryId: number, direction: "up" | "down") {
    if (busyMove) return;
    setBusyMove(true);
    const j = await postCategory({ action: "category_move", id: String(categoryId), direction });
    setBusyMove(false);
    if (j.ok) redirectFlash({ msg: "Ordine categorie aggiornato" }, true);
    else redirectFlash({ err: String(j.error ?? "Impossibile spostare la categoria") }, true);
  }

  // Delete legacy (services.js serviceCategoryConfirmDelete + services.php
  // 3544-3589): con servizi collegati -> popup 'Categoria non eliminabile';
  // senza -> confirm verbatim e flash dal server.
  async function onDelete(category: Category) {
    const linked = servicesForCategory(category.id);
    if (linked.length > 0) {
      setBlockPopup({
        category_name: category.name,
        services: linked.map((s) => ({ id: s.id, name: s.name, active: Boolean(s.isActive ?? s.active ?? true) })),
      });
      setBlockOpenList(false);
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Eliminare definitivamente questa categoria? Verra eliminata solo se non ha servizi associati.")) return;
    setError("");
    const j = await postCategory({ action: "category_delete", id: String(category.id) });
    if (!j.ok) {
      if (j.popup) {
        setBlockPopup(j.popup);
        setBlockOpenList(false);
      }
      setError(String(j.error ?? "Categoria non eliminabile"));
      window.scrollTo(0, 0);
      return;
    }
    redirectFlash({ msg: "Categoria eliminata" });
  }

  // Salva ordine servizi della categoria (action=order, services.php 3527-3541).
  async function onSaveServiceOrder() {
    if (!orderCategoryId) return;
    const j = await postCategory({ action: "save_service_order", category_id: String(orderCategoryId), service_order: orderIds.join(",") });
    const usp = new URLSearchParams({ tab: "categories", action: "order", id: String(orderCategoryId) });
    flashNavigate(`/${encodeURIComponent(slug)}/services?${usp.toString()}`, {
      msg: String((j as CategoryResult & { msg?: string }).msg ?? (j.ok ? "Ordine servizi aggiornato" : "Nessun servizio da ordinare")),
    });
  }

  function moveOrderId(id: number, direction: -1 | 1) {
    const prev = orderIds;
    const index = prev.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= prev.length) return;
    const next = prev.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setOrderOverride(next);
  }

  // Filter combobox data (the PHP page emits these as JSON for the client-side combobox).
  const filterItems = useMemo(
    () =>
      categories.map((c) => ({
        id: String(c.id),
        label: c.name,
        meta: "",
        search: String(c.name ?? "").toLowerCase(),
      })),
    [categories],
  );

  const selectedFilterLabel = useMemo(() => {
    if (!filterCategoryId) return "";
    const found = categories.find((c) => String(c.id) === filterCategoryId);
    return found ? found.name : "";
  }, [categories, filterCategoryId]);

  // Filtro + paginazione legacy 20/pagina (services.php 3711-3732).
  const filteredCats = useMemo(() => {
    if (!filterCategoryId) return categories;
    return categories.filter((c) => String(c.id) === filterCategoryId);
  }, [categories, filterCategoryId]);
  const perPage = 20;
  const filteredTotal = filteredCats.length;
  const pages = Math.max(1, Math.ceil(filteredTotal / perPage));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * perPage;
  const rows = useMemo(() => filteredCats.slice(offset, offset + perPage), [filteredCats, offset]);
  const pageFrom = filteredTotal > 0 ? offset + 1 : 0;
  const pageTo = filteredTotal > 0 ? Math.min(filteredTotal, offset + rows.length) : 0;
  function pageUrl(target: number): string {
    const usp = new URLSearchParams({ tab: "categories" });
    if (filterCategoryId) usp.set("category_id", filterCategoryId);
    if (target > 1) usp.set("p", String(target));
    return `/${encodeURIComponent(slug)}/services?${usp.toString()}`;
  }

  // Services per category drive the delete-block payload (data-category-services).
  function servicesForCategory(categoryId: number): Service[] {
    return services.filter((s) => Number(s.categoryId) === Number(categoryId));
  }

  // VISTA "Ordina servizi" (services.php action=order, 3775-3856): pagina
  // dedicata con frecce su/giù e 'Salva ordine'.
  if (orderCategoryId > 0) {
    const category = categories.find((c) => c.id === orderCategoryId);
    const byId = new Map(services.map((s) => [s.id, s]));
    const orderRows = orderIds.map((id) => byId.get(id)).filter((s): s is Service => Boolean(s));
    if (!loading && !category) {
      redirectFlash({ err: "Categoria non trovata" });
      return null;
    }
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/services.css" />
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Risorse</div>
            <h1 className="bs-page-title">Ordina servizi</h1>
            <div className="bs-page-subtitle">Gestisci l&apos;ordine dei servizi in questa categoria.</div>
          </div>
          <div className="bs-page-actions">
            <a className="btn btn-outline-secondary" href={tabHref("categories")}>
              <i className="bi bi-arrow-left" /> Indietro
            </a>
          </div>
        </div>

        {flash.msg ? (
          <div className={`alert alert-${flash.msg === "Ordine servizi aggiornato" ? "success" : "danger"}`}>{flash.msg}</div>
        ) : null}
        {flash.err ? <div className="alert alert-danger">{flash.err}</div> : null}

        <div className="card card-soft mt-3">
          <div className="card-body">
            <div className="d-flex align-items-center justify-content-between">
              <div>
                <h3 className="h6 mb-1">Ordine servizi in questa categoria</h3>
                <div className="text-muted small">Sposta i servizi su/giù: l&apos;ordine verrà usato ovunque (gestionale e booking).</div>
              </div>
            </div>

            {orderRows.length === 0 ? (
              <div className="text-muted mt-3">{loading ? "Caricamento…" : "Nessun servizio associato a questa categoria."}</div>
            ) : (
              <div className="mt-3">
                <div className="table-responsive">
                  <table className="table align-middle mb-0" id="svcOrderTable">
                    <thead>
                      <tr>
                        <th className="services-order-col">Ordine</th>
                        <th>Servizio</th>
                        <th className="services-status-col">Stato</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderRows.map((s) => (
                        <tr key={s.id} data-id={s.id}>
                          <td>
                            <div className="btn-group btn-group-sm" role="group">
                              <button type="button" className="btn btn-outline-secondary svc-up" title="Sposta su" onClick={() => moveOrderId(s.id, -1)}>
                                <i className="bi bi-chevron-up" />
                              </button>
                              <button type="button" className="btn btn-outline-secondary svc-down" title="Sposta giù" onClick={() => moveOrderId(s.id, 1)}>
                                <i className="bi bi-chevron-down" />
                              </button>
                            </div>
                          </td>
                          <td>{s.name}</td>
                          <td>
                            {(s.isActive ?? s.active ?? true) ? (
                              <span className="badge text-bg-success">Attivo</span>
                            ) : (
                              <span className="badge text-bg-secondary">Disattivo</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 d-flex justify-content-end">
                  <button className="btn btn-primary btn-pill" type="button" onClick={() => void onSaveServiceOrder()}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva ordine
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Categorie</h1>
          <div className="bs-page-subtitle">Gestisci categorie e ordine del catalogo servizi.</div>
        </div>
        <div className="bs-page-actions">
          <button
            className="btn btn-primary btn-pill"
            type="button"
            onClick={() => {
              setError("");
              setCreateName("");
              setCreateOpen(true);
            }}
          >
            <i className="bi bi-plus-lg me-1" />
            Nuova categoria
          </button>
        </div>
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item">
          <a className="nav-link" href={tabHref("services")}>
            Servizi
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link active" href={tabHref("categories")}>
            Categorie
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link" href={tabHref("recommended")}>
            Servizi consigliati
          </a>
        </li>
      </ul>

      <link rel="stylesheet" href="/assets/css/pages/services.css" />

      {flash.msg ? <div className="alert alert-success">{flash.msg}</div> : null}
      {flash.err ? <div className="alert alert-danger">{flash.err}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const usp = new URLSearchParams({ tab: "categories" });
            if (filterCategoryId) usp.set("category_id", filterCategoryId);
            window.location.assign(`/${encodeURIComponent(slug)}/services?${usp.toString()}`);
          }}
        >
          <input type="hidden" name="page" value="services" />
          <input type="hidden" name="tab" value="categories" />
          <div className="col-lg-3 col-md-5">
            <label className="form-label">Categoria</label>
            <div className="app-combobox dropdown" data-service-category-filter-combobox>
              <button
                className="form-control text-start app-combobox-toggle dropdown-toggle"
                type="button"
                data-bs-toggle="dropdown"
                data-bs-auto-close="outside"
                aria-expanded="false"
              >
                <span className={`app-combobox-text${selectedFilterLabel ? "" : " d-none"}`}>
                  {selectedFilterLabel}
                </span>
                <span className={`app-combobox-placeholder text-muted ${selectedFilterLabel ? "d-none" : ""}`}>
                  Tutte
                </span>
              </button>
              <div className="dropdown-menu p-2 w-100">
                <input
                  type="text"
                  className="form-control form-control-sm app-combobox-search"
                  placeholder="Cerca categoria..."
                  autoComplete="off"
                />
                <div className="app-combobox-list mt-2">
                  <button type="button" className="dropdown-item" onClick={() => setFilterCategoryId("")}>
                    Tutte
                  </button>
                  {filterItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="dropdown-item"
                      onClick={() => setFilterCategoryId(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <input type="hidden" name="category_id" value={filterCategoryId} />
            </div>
          </div>
          <div className="col-lg-2 col-md-3 d-grid">
            <button className="btn btn-outline-primary" type="submit">
              <i className="bi bi-funnel me-1" />
              Filtra
            </button>
          </div>
        </form>
      </div>

      <div className="card card-soft">
        <div className="card-body">
          <div className="table-responsive">
            <table className="table align-middle">
              <thead>
                <tr>
                  <th className="services-order-col">Ordine</th>
                  <th>Categoria</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-muted p-3">
                      {loading ? "Caricamento…" : filterCategoryId ? "Nessuna categoria trovata." : (
                        <>Nessuna categoria configurata. Usa <strong>Nuova categoria</strong> per organizzare i servizi.</>
                      )}
                    </td>
                  </tr>
                ) : (
                  rows.map((category, index) => {
                    const isFirst = index === 0;
                    const isLast = index === rows.length - 1;
                    return (
                      <tr key={category.id}>
                        <td>
                          <div className="btn-group btn-group-sm" role="group" aria-label="Ordina categoria">
                            <button
                              className="btn btn-outline-secondary"
                              type="button"
                              title="Sposta su"
                              disabled={isFirst || busyMove || Boolean(filterCategoryId)}
                              onClick={() => onMove(category.id, "up")}
                            >
                              <i className="bi bi-chevron-up" />
                            </button>
                            <button
                              className="btn btn-outline-secondary"
                              type="button"
                              title="Sposta giu"
                              disabled={isLast || busyMove || Boolean(filterCategoryId)}
                              onClick={() => onMove(category.id, "down")}
                            >
                              <i className="bi bi-chevron-down" />
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <div className="services-category-icon">
                              <i className="bi bi-tag" />
                            </div>
                            <div className="fw-semibold">{category.name}</div>
                          </div>
                        </td>
                        <td className="text-end">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            type="button"
                            onClick={() => {
                              setError("");
                              setEditName(category.name);
                              setEditImageFile(null);
                              setEditRemoveImage(false);
                              setEditModalId(category.id);
                            }}
                          >
                            Modifica
                          </button>{" "}
                          <a
                            className="btn btn-sm btn-outline-secondary"
                            href={`/${encodeURIComponent(slug)}/services?tab=categories&action=order&id=${category.id}`}
                          >
                            Ordina servizi
                          </a>{" "}
                          <button
                            className="btn btn-sm btn-outline-danger"
                            type="button"
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

      {pages > 1 ? (
        <div className="card card-soft mt-3 mb-3">
          <div className="card-body py-2 d-flex flex-wrap align-items-center justify-content-between gap-2">
            <div className="text-muted small">
              Mostro {pageFrom}-{pageTo} di {filteredTotal} categorie
              <span className="ms-2">Pagina {currentPage} di {pages}</span>
            </div>
            <div className="d-flex gap-2">
              <a className={`btn btn-sm btn-outline-secondary ${currentPage <= 1 ? "disabled" : ""}`} href={pageUrl(Math.max(1, currentPage - 1))}>Precedente</a>
              <a className={`btn btn-sm btn-outline-secondary ${currentPage >= pages ? "disabled" : ""}`} href={pageUrl(Math.min(pages, currentPage + 1))}>Successiva</a>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE 'Categoria non eliminabile' (#categoryDeleteBlockModal). */}
      {blockPopup ? (
        <>
          <div className="modal fade show d-block" id="categoryDeleteBlockModal" tabIndex={-1}>
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1">Categoria non eliminabile</h5>
                    <div className="text-muted small" id="categoryDeleteBlockSubtitle">Categoria: {blockPopup.category_name}</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setBlockPopup(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning">
                    Non è possibile eliminare la categoria perché sono associati dei servizi.
                    Sposta o modifica prima i servizi collegati, poi riprova.
                  </div>
                  <div id="categoryDeleteBlockList">
                    <div className="accordion">
                      <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                        <h3 className="accordion-header">
                          <button
                            className={`accordion-button ${blockOpenList ? "" : "collapsed"} bg-white shadow-none py-2`}
                            type="button"
                            onClick={() => setBlockOpenList((v) => !v)}
                          >
                            <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                              <span className="fw-semibold">Servizi collegati</span>
                              <span className="badge rounded-pill text-bg-info">{blockPopup.services.length}</span>
                            </span>
                          </button>
                        </h3>
                        <div className={`accordion-collapse collapse ${blockOpenList ? "show" : ""}`}>
                          <div className="accordion-body py-2">
                            <div className="list-group list-group-flush">
                              {blockPopup.services.map((svc) => (
                                <div className="list-group-item px-0 d-flex align-items-center justify-content-between gap-2" key={svc.id}>
                                  <div className="fw-semibold">{svc.name}</div>
                                  <span className={`badge ${svc.active ? "text-bg-success" : "text-bg-secondary"}`}>{svc.active ? "Attivo" : "Disattivo"}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setBlockPopup(null)}>Chiudi</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {/* Edit modals (one per category, pre-filled with current name). */}
      {categories.map((category) => {
        const open = editModalId === category.id;
        if (!open) return null;
        return (
          <div
            key={category.id}
            className="modal fade show d-block"
            id={`serviceCategoryEditModal${category.id}`}
            tabIndex={-1}
            style={{ background: "rgba(0,0,0,.5)" }}
          >
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <form method="post" encType="multipart/form-data" onSubmit={(e) => onEditSubmit(e, category.id)}>
                  <div className="modal-header">
                    <div>
                      <div className="page-eyebrow mb-1">Risorse</div>
                      <h5 className="modal-title mb-0">Modifica categoria</h5>
                    </div>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setEditModalId(null)} />
                  </div>
                  <div className="modal-body">
                    <input type="hidden" name="id" value={category.id} />

                    <div className="row g-3">
                      <div className="col-md-6">
                        <label className="form-label">Nome</label>
                        <input className="form-control" name="name" required value={editName} onChange={(e) => setEditName(e.target.value)} />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label">Immagine categoria</label>
                        {category.imageUrl && !editRemoveImage && !editImageFile ? (
                          <div className="mb-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={category.imageUrl} alt="" className="rounded border" style={{ width: 120, height: 68, objectFit: "cover" }} />
                          </div>
                        ) : null}
                        <input
                          className="form-control"
                          type="file"
                          name="image_file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          onChange={(e) => {
                            const file = e.target.files?.[0] ?? null;
                            if (file && file.size > 5242880) {
                              setError("Immagine troppo grande (max 5 MB).");
                              e.target.value = "";
                              setEditImageFile(null);
                              return;
                            }
                            setError("");
                            setEditImageFile(file);
                            if (file) setEditRemoveImage(false);
                          }}
                        />
                        <div className="form-text">
                          Consigliato: <strong>1200&times;675</strong> (rapporto 16:9) oppure <strong>800&times;450</strong>.
                          Max <strong>5 MB</strong>.
                        </div>
                        {category.imageUrl && !editImageFile ? (
                          <div className="form-check mt-1">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id={`categoryRemoveImage${category.id}`}
                              checked={editRemoveImage}
                              onChange={(e) => setEditRemoveImage(e.target.checked)}
                            />
                            <label className="form-check-label" htmlFor={`categoryRemoveImage${category.id}`}>
                              Rimuovi immagine
                            </label>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setEditModalId(null)}>
                      Annulla
                    </button>
                    <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                      <i className="bi bi-check2-circle me-1" />
                      {saving ? "Salvataggio…" : "Salva"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        );
      })}

      {/* Create modal. */}
      {createOpen ? (
        <div className="modal fade show d-block" id="serviceCategoryCreateModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <div className="modal-content">
              <form method="post" encType="multipart/form-data" onSubmit={onCreateSubmit}>
                <div className="modal-header">
                  <div>
                    <div className="page-eyebrow mb-1">Risorse</div>
                    <h5 className="modal-title mb-0">Nuova categoria</h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setCreateOpen(false)} />
                </div>
                <div className="modal-body">
                  <input type="hidden" name="id" value="0" />

                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label">Nome</label>
                      <input className="form-control" name="name" required value={createName} onChange={(e) => setCreateName(e.target.value)} />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Immagine categoria</label>
                      <input
                        className="form-control"
                        type="file"
                        name="image_file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          if (file && file.size > 5242880) {
                            setError("Immagine troppo grande (max 5 MB).");
                            e.target.value = "";
                            setCreateImageFile(null);
                            return;
                          }
                          setError("");
                          setCreateImageFile(file);
                        }}
                      />
                      <div className="form-text">
                        Consigliato: <strong>1200&times;675</strong> (rapporto 16:9) oppure <strong>800&times;450</strong>. Max{" "}
                        <strong>5 MB</strong>.
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setCreateOpen(false)}>
                    Annulla
                  </button>
                  <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                    <i className="bi bi-check2-circle me-1" />
                    {saving ? "Salvataggio…" : "Salva"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
