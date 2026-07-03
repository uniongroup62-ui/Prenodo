"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP coupon NEW / EDIT form (app/pages/coupons.php,
// action=new|edit). Field groups and Bootstrap markup mirror the legacy editor:
//   - Codice (code; editable + required on new, readonly on edit), Descrizione
//   - Tipo (discount_type: percent/fixed) + Valore (discount_value)
//   - Importo minimo totale (min_subtotal), Limite di utilizzo per cliente
//     (usage_limit; 0 = illimitato)
//   - Attiva per (apply_scope), Valido dal / Valido al (valid_from / valid_to)
// Submits to /api/manage/coupons (action=save; create when no id, update with
// id — the code is immutable on edit, faithful to the readonly legacy input).
//
// TODO: the legacy editor also renders the scope-restricted catalogs
// (service_category_ids[]/service_ids[]/product_category_ids[]/product_ids[]
// multi-selects) and the per-location "Sedi abilitate" toggles. Those catalogs
// and the coupon_locations sync are not part of the current coupon data
// pipeline (listDbCoupons / coupons table), so they are not yet ported here.

type CouponForm = {
  id: number;
  code: string;
  description: string;
  discount_type: "percent" | "fixed";
  discount_value: string;
  min_subtotal: string;
  usage_limit: string;
  apply_scope: string;
  valid_from: string;
  valid_to: string;
};

type IdName = { id: number; name: string };
type ServiceOpt = { id: number; name: string; categoryName: string };
type ProductOpt = { id: number; name: string; sku: string };
type CouponFormContext = {
  locations: IdName[];
  serviceCategories: IdName[];
  services: ServiceOpt[];
  productCategories: IdName[];
  products: ProductOpt[];
  defaultLocationIds: number[];
};

// The scope-restricted catalogs + enabled sedi selected in the editor.
type CouponScopeSel = {
  serviceCategoryIds: number[];
  serviceIds: number[];
  productCategoryIds: number[];
  productIds: number[];
  locationIds: number[];
};

// Edit-view audit fields shown in the legacy status card above the form.
type CouponMeta = {
  active: boolean;
  startsAt: string;
  endsAt: string;
  usageLimit: number;
  activeUsedCount: number;
  createdAt: string;
  createdByLabel: string;
  cancelledAt: string;
  cancelledByLabel: string;
  cancelledReason: string;
  canCancel: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Mirrors coupons_status_info(): disabled / scheduled / expired / active.
function statusInfo(meta: CouponMeta): { label: string; badge: string } {
  const today = new Date().toISOString().slice(0, 10);
  const validFrom = (meta.startsAt ?? "").slice(0, 10);
  const validTo = (meta.endsAt ?? "").slice(0, 10);
  if (!meta.active) return { label: "Disattivato", badge: "bg-secondary" };
  if (validFrom !== "" && validFrom > today) return { label: "Programmato", badge: "bg-info text-dark" };
  if (validTo !== "" && validTo < today) return { label: "Scaduto", badge: "bg-warning text-dark" };
  return { label: "Attiva", badge: "bg-success" };
}

function fmtDateTime(value: string): string {
  const v = (value ?? "").trim();
  return v !== "" ? v.slice(0, 19).replace("T", " ") : "—";
}

function emptyForm(): CouponForm {
  return {
    id: 0,
    code: "",
    description: "",
    discount_type: "percent",
    discount_value: "10",
    min_subtotal: "0",
    usage_limit: "0",
    apply_scope: "all_services_products",
    valid_from: "",
    valid_to: "",
  };
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function CouponFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [form, setForm] = useState<CouponForm>(emptyForm());
  const [meta, setMeta] = useState<CouponMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [context, setContext] = useState<CouponFormContext | null>(null);
  const [sel, setSel] = useState<CouponScopeSel>({ serviceCategoryIds: [], serviceIds: [], productCategoryIds: [], productIds: [], locationIds: [] });

  // On edit (action=edit&id=) prefill from coupons?action=get. On new, keep the
  // faithful defaults (percent / 10 / scope all_services_products). Always load
  // the form context (catalog options + active sedi) for the scope selects.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}&action=form_context`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const ctx: CouponFormContext = j.context ?? { locations: [], serviceCategories: [], services: [], productCategories: [], products: [], defaultLocationIds: [] };
        setContext(ctx);
        // NEW default: all active sedi pre-checked (mirrors the legacy current-or-all default).
        if (act !== "edit") setSel((prev) => ({ ...prev, locationIds: ctx.defaultLocationIds }));
        return ctx;
      })
      .catch(() => setContext({ locations: [], serviceCategories: [], services: [], productCategories: [], products: [], defaultLocationIds: [] }));

    const editPromise =
      act === "edit" && Number.isFinite(id) && id > 0
        ? fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
            headers: { "x-tenant-slug": slug },
          })
            .then((r) => r.json())
            .then((j) => {
              if (!j.ok || !j.coupon) {
                setError(String(j.error ?? "Coupon non trovato."));
                return;
              }
              const c = j.coupon;
              setForm({
                id: Number(c.id ?? id),
                code: String(c.code ?? ""),
                description: String(c.description ?? ""),
                discount_type: c.type === "fixed" ? "fixed" : "percent",
                discount_value: String(c.value ?? 0),
                min_subtotal: String(c.minSubtotal ?? 0),
                usage_limit: String(c.usageLimit ?? 0),
                apply_scope: String(c.applyScope ?? "all"),
                valid_from: String(c.startsAt ?? "").slice(0, 10),
                valid_to: String(c.endsAt ?? "").slice(0, 10),
              });
              setMeta({
                active: Boolean(c.active),
                startsAt: String(c.startsAt ?? ""),
                endsAt: String(c.endsAt ?? ""),
                usageLimit: Number(c.usageLimit ?? 0),
                activeUsedCount: Number(c.activeUsedCount ?? 0),
                createdAt: String(c.createdAt ?? ""),
                createdByLabel: String(c.createdByLabel ?? "—"),
                cancelledAt: String(c.cancelledAt ?? ""),
                cancelledByLabel: String(c.cancelledByLabel ?? "—"),
                cancelledReason: String(c.cancelledReason ?? ""),
                canCancel: Boolean(c.canCancel),
              });
              setSel({
                serviceCategoryIds: (c.serviceCategoryIds ?? []).map(Number),
                serviceIds: (c.serviceIds ?? []).map(Number),
                productCategoryIds: (c.productCategoryIds ?? []).map(Number),
                productIds: (c.productIds ?? []).map(Number),
                locationIds: (c.locationIds ?? []).map(Number),
              });
            })
            .catch(() => setError("Errore nel caricamento del coupon."))
        : Promise.resolve();

    Promise.all([ctxPromise, editPromise]).finally(() => setLoading(false));
  }, [slug]);

  function toggleId(key: keyof CouponScopeSel, id: number, checked: boolean) {
    setSel((prev) => {
      const cur = new Set(prev[key]);
      if (checked) cur.add(id);
      else cur.delete(id);
      return { ...prev, [key]: Array.from(cur) };
    });
  }

  function setMultiSelect(key: keyof CouponScopeSel, options: HTMLCollectionOf<HTMLOptionElement>) {
    const ids: number[] = [];
    for (const opt of Array.from(options)) if (opt.selected) ids.push(Number(opt.value));
    setSel((prev) => ({ ...prev, [key]: ids }));
  }

  // Generate a random coupon code (mirrors coupons.js fallback charset); the
  // server rejects a duplicate/promotion-clashing code on save.
  function generateCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 10; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
    set("code", out);
  }

  function set<K extends keyof CouponForm>(key: K, value: CouponForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/coupons`;
  }

  // Disable the coupon (port of coupons.php action=cancel): POST action=cancel
  // with the optional reason, then reload so the status card reflects it.
  async function cancelCoupon() {
    if (cancelling || !meta) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "cancel", id: form.id, cancel_reason: cancelReason }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Impossibile disattivare il coupon."));
        setShowCancel(false);
        return;
      }
      window.location.reload();
    } finally {
      setCancelling(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to coupons.php POST: on new the code is required and
    // must match [A-Z0-9][A-Z0-9_-]{0,39}; value must be > 0; date order checked.
    if (action === "new") {
      const code = form.code.trim().toUpperCase();
      if (code === "") {
        setError("Inserisci un codice.");
        return;
      }
      if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
        setError("Codice non valido. Usa solo lettere, numeri, - e _. (Max 40)");
        return;
      }
    }
    const value = Number.parseFloat(form.discount_value.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Inserisci un valore valido.");
      return;
    }
    if (form.valid_from && form.valid_to && form.valid_from > form.valid_to) {
      setError('La data "Valido al" deve essere successiva o uguale a "Valido dal".');
      return;
    }
    // Scope + sede validation (port of coupons.php $scopeError / "almeno una sede").
    if (form.apply_scope === "service_categories" && sel.serviceCategoryIds.length === 0) {
      setError("Seleziona almeno una categoria di servizi.");
      return;
    }
    if (form.apply_scope === "services" && sel.serviceIds.length === 0) {
      setError("Seleziona almeno un servizio.");
      return;
    }
    if (form.apply_scope === "product_categories" && sel.productCategoryIds.length === 0) {
      setError("Seleziona almeno una categoria di prodotti.");
      return;
    }
    if (form.apply_scope === "products" && sel.productIds.length === 0) {
      setError("Seleziona almeno un prodotto.");
      return;
    }
    if ((context?.locations.length ?? 0) > 0 && sel.locationIds.length === 0) {
      setError("Seleziona almeno una sede abilitata.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "save",
        id: String(form.id),
        code: form.code,
        description: form.description,
        discount_type: form.discount_type,
        discount_value: form.discount_value,
        min_subtotal: form.min_subtotal,
        usage_limit: form.usage_limit,
        apply_scope: form.apply_scope,
        valid_from: form.valid_from,
        valid_to: form.valid_to,
        // Nested arrays sent as JSON strings so they survive parseRequestBody's flatten.
        service_category_ids: JSON.stringify(sel.serviceCategoryIds),
        service_ids: JSON.stringify(sel.serviceIds),
        product_category_ids: JSON.stringify(sel.productCategoryIds),
        product_ids: JSON.stringify(sel.productIds),
        coupon_location_ids: JSON.stringify(sel.locationIds),
      };
      const res = await fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del coupon."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio del coupon.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo coupon" : "Modifica coupon";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/coupons.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Buoni</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Crea e gestisci codici sconto e campagne coupon.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/coupons`}>
            <i className="bi bi-arrow-left me-1" />
            Torna ai coupon
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {action === "edit" && meta ? (
        <div className="card p-3 mb-3">
          <div className="row g-3 align-items-start">
            <div className="col-md-3">
              <div className="text-muted small mb-1">Stato</div>
              <span className={`badge ${statusInfo(meta).badge}`}>{statusInfo(meta).label}</span>
            </div>
            <div className="col-md-3">
              <div className="text-muted small mb-1">Data creazione</div>
              <div className="fw-semibold">{fmtDateTime(meta.createdAt)}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small mb-1">Creato da</div>
              <div className="fw-semibold">{meta.createdByLabel}</div>
            </div>
            <div className="col-md-3 text-md-end">
              {meta.canCancel ? (
                <button type="button" className="btn btn-outline-danger" onClick={() => setShowCancel(true)}>
                  Disattiva coupon
                </button>
              ) : null}
            </div>
          </div>

          <hr className="my-3" />

          <div className="row g-3">
            <div className="col-md-2">
              <div className="text-muted small mb-1">Limite per cliente</div>
              <div>
                <strong>{meta.usageLimit > 0 ? meta.usageLimit : "Illimitato"}</strong>
              </div>
            </div>
            <div className="col-md-2">
              <div className="text-muted small mb-1">Utilizzi attivi totali</div>
              <div>{meta.activeUsedCount}</div>
            </div>
            <div className="col-md-2">
              <div className="text-muted small mb-1">Data disattivazione</div>
              <div>{fmtDateTime(meta.cancelledAt)}</div>
            </div>
            <div className="col-md-2">
              <div className="text-muted small mb-1">Disattivato da</div>
              <div>{meta.cancelledByLabel}</div>
            </div>
            <div className="col-md-4">
              <div className="text-muted small mb-1">Motivo</div>
              <div>{meta.cancelledReason !== "" ? meta.cancelledReason : "—"}</div>
            </div>
          </div>
        </div>
      ) : null}

      {showCancel && meta ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Disattiva coupon #{form.id}</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setShowCancel(false)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning mb-3">
                    <div className="fw-semibold mb-1">Conferma disattivazione</div>
                    <div>
                      Da questo momento il coupon non sarà più utilizzabile per nuove vendite o prenotazioni. Le
                      vendite/prenotazioni già associate manterranno il coupon storico.
                    </div>
                  </div>
                  <label className="form-label">Motivazione (opzionale)</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    maxLength={255}
                    placeholder="Es. fine validità commerciale / stop utilizzo interno..."
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                  <div className="form-text">Massimo 255 caratteri.</div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setShowCancel(false)}>
                    Indietro
                  </button>
                  <button type="button" className="btn btn-danger" disabled={cancelling} onClick={cancelCoupon}>
                    {cancelling ? "Disattivazione…" : "Conferma disattivazione"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="card p-3 mb-3">
          <form method="post" onSubmit={onSubmit}>
            <input type="hidden" name="id" value={form.id} />
            <div className="row g-3">
              <div className="col-md-3">
                <label className="form-label">Codice</label>
                {action === "new" ? (
                  <>
                    <div className="input-group">
                      <input
                        className="form-control"
                        name="code"
                        required
                        value={form.code}
                        onChange={(e) => set("code", e.target.value)}
                      />
                      <button type="button" className="btn btn-outline-secondary" onClick={generateCode}>
                        Genera
                      </button>
                    </div>
                    <div className="form-text">Max 40 caratteri. Solo lettere, numeri, - e _.</div>
                  </>
                ) : (
                  <>
                    <input className="form-control" name="code" readOnly value={form.code} />
                    <div className="form-text">Il codice non è modificabile dopo la creazione.</div>
                  </>
                )}
              </div>

              <div className="col-md-5">
                <label className="form-label">Descrizione</label>
                <input
                  className="form-control"
                  name="description"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </div>

              <div className="col-md-2">
                <label className="form-label">Tipo</label>
                <select
                  className="form-select"
                  name="discount_type"
                  value={form.discount_type}
                  onChange={(e) => set("discount_type", e.target.value as CouponForm["discount_type"])}
                >
                  <option value="percent">%</option>
                  <option value="fixed">€</option>
                </select>
              </div>

              <div className="col-md-2">
                <label className="form-label">Valore</label>
                <input
                  className="form-control"
                  type="number"
                  step="0.01"
                  min="0"
                  name="discount_value"
                  value={form.discount_value}
                  onChange={(e) => set("discount_value", e.target.value)}
                />
              </div>

              <div className="col-md-3">
                <label className="form-label">Importo minimo totale</label>
                <input
                  className="form-control"
                  type="number"
                  step="0.01"
                  min="0"
                  name="min_subtotal"
                  value={form.min_subtotal}
                  onChange={(e) => set("min_subtotal", e.target.value)}
                />
                <div className="form-text">
                  Il coupon si attiva solo se il totale servizi/prodotti raggiunge questo importo.
                </div>
              </div>

              <div className="col-md-2">
                <label className="form-label">Limite di utilizzo per cliente</label>
                <input
                  className="form-control"
                  type="number"
                  step="1"
                  min="0"
                  name="usage_limit"
                  value={form.usage_limit}
                  onChange={(e) => set("usage_limit", e.target.value)}
                />
                <div className="form-text">0 = illimitato per cliente.</div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Attiva per</label>
                <select
                  className="form-select"
                  name="apply_scope"
                  value={form.apply_scope}
                  onChange={(e) => set("apply_scope", e.target.value)}
                >
                  {form.apply_scope === "all" ? <option value="all">Tutto il carrello (legacy)</option> : null}
                  <option value="service_categories">Categorie di servizi</option>
                  <option value="services">Servizi</option>
                  <option value="product_categories">Categorie di prodotti</option>
                  <option value="products">Prodotti</option>
                  <option value="all_services_products">Tutti i servizi e tutti i prodotti</option>
                </select>
                <div className="form-text">Gli altri elementi del carrello saranno esclusi dallo sconto coupon.</div>
              </div>

              <div className="col-md-2">
                <label className="form-label">Valido dal</label>
                <input
                  className="form-control"
                  type="date"
                  name="valid_from"
                  value={form.valid_from}
                  onChange={(e) => set("valid_from", e.target.value)}
                />
              </div>
              <div className="col-md-2">
                <label className="form-label">Valido al</label>
                <input
                  className="form-control"
                  type="date"
                  name="valid_to"
                  value={form.valid_to}
                  onChange={(e) => set("valid_to", e.target.value)}
                />
              </div>

              {(context?.locations.length ?? 0) > 0 ? (
                <div className="col-12">
                  <label className="form-label">Sedi abilitate</label>
                  <div className="table-responsive border rounded">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Sede</th>
                          <th className="text-center">Valido</th>
                        </tr>
                      </thead>
                      <tbody>
                        {context!.locations.map((loc) => (
                          <tr key={loc.id}>
                            <td className="fw-semibold">{loc.name || `Sede #${loc.id}`}</td>
                            <td className="text-center">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                checked={sel.locationIds.includes(loc.id)}
                                onChange={(e) => toggleId("locationIds", loc.id, e.target.checked)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {form.apply_scope === "service_categories" ? (
                <div className="col-md-4">
                  <label className="form-label">Categorie di servizi</label>
                  <select
                    className="form-select"
                    multiple
                    size={6}
                    value={sel.serviceCategoryIds.map(String)}
                    onChange={(e) => setMultiSelect("serviceCategoryIds", e.target.options)}
                  >
                    {(context?.serviceCategories ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name || `Categoria #${o.id}`}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">Selezione multipla consentita.</div>
                </div>
              ) : null}

              {form.apply_scope === "services" ? (
                <div className="col-md-4">
                  <label className="form-label">Servizi</label>
                  <select
                    className="form-select"
                    multiple
                    size={6}
                    value={sel.serviceIds.map(String)}
                    onChange={(e) => setMultiSelect("serviceIds", e.target.options)}
                  >
                    {(context?.services ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.categoryName !== "" ? `${o.categoryName} · ${o.name}` : o.name || `Servizio #${o.id}`}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">Selezione multipla consentita.</div>
                </div>
              ) : null}

              {form.apply_scope === "product_categories" ? (
                <div className="col-md-4">
                  <label className="form-label">Categorie di prodotti</label>
                  <select
                    className="form-select"
                    multiple
                    size={6}
                    value={sel.productCategoryIds.map(String)}
                    onChange={(e) => setMultiSelect("productCategoryIds", e.target.options)}
                  >
                    {(context?.productCategories ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name || `Categoria #${o.id}`}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">Selezione multipla consentita.</div>
                </div>
              ) : null}

              {form.apply_scope === "products" ? (
                <div className="col-md-4">
                  <label className="form-label">Prodotti</label>
                  <select
                    className="form-select"
                    multiple
                    size={6}
                    value={sel.productIds.map(String)}
                    onChange={(e) => setMultiSelect("productIds", e.target.options)}
                  >
                    {(context?.products ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.sku !== "" ? `${o.name} (${o.sku})` : o.name || `Prodotto #${o.id}`}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">Selezione multipla consentita.</div>
                </div>
              ) : null}
            </div>

            <div className="mt-3 d-flex gap-2">
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
