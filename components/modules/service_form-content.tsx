"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP service NEW / EDIT form (app/pages/services.php,
// action=new|edit). Field groups and Bootstrap markup mirror the legacy editor:
//   - Dati servizio: name, category_id, duration_min, price, is_active (Attivo),
//     booking_enabled (Prenotabile online)
//   - Sedi abilitate: per-location checkboxes (location_ids[]). The legacy form
//     has NO "all locations" toggle; selecting every active sede == "Tutte".
//   - Cabine: per-cabin checkboxes (cabin_ids[])
//   - Operatori: no_operator switch (SSO) + per-staff checkboxes (staff_ids[])
//   - Risorse necessarie: per-resource checkbox + qty (resource_ids[]/resource_qty[id])
// Submits to /api/manage/services (action=save; create when no id, update with id).
// The service editor has NO image upload (image_file in services.php belongs to
// the CATEGORY modal, not this form). The impacted-appointments confirmation
// flows (confirm_service_price_update / _name_update / _deactivation_appointments
// / _impacted_appointments) are server-side popups not yet ported here — see TODO.

type Category = { id: number; name: string };
type LocationRow = { id: number; name: string; isActive?: boolean };
type CabinRow = { id: number; name: string; isActive?: boolean; locationId?: number | null };
type StaffRow = { id: number; fullName: string; isActive?: boolean; locationIds?: number[] };
type ResourceRow = { id: number; name: string; qtyTotal?: number };

type ServiceContext = {
  ok?: boolean;
  categories?: Category[];
  locations?: LocationRow[];
  cabins?: CabinRow[];
  staff?: StaffRow[];
  resources?: ResourceRow[];
};

type ServiceForm = {
  id: number;
  name: string;
  category_id: string;
  duration_min: string;
  price: string;
  is_active: boolean;
  booking_enabled: boolean;
  no_operator: boolean;
  location_ids: number[];
  cabin_ids: number[];
  staff_ids: number[];
  resource_qty: Record<number, number>;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): ServiceForm {
  return {
    id: 0,
    name: "",
    category_id: "",
    duration_min: "60",
    price: "0",
    is_active: true,
    booking_enabled: true,
    no_operator: false,
    location_ids: [],
    cabin_ids: [],
    staff_ids: [],
    resource_qty: {},
  };
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function ServiceFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [form, setForm] = useState<ServiceForm>(emptyForm());
  const [ctx, setCtx] = useState<ServiceContext>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load the context (categories/locations/cabins/staff/resources), then prefill
  // on edit (action=get) or apply faithful new-service defaults.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServiceContext) => {
        setCtx(j ?? {});
        return j ?? {};
      })
      .catch(() => {
        setCtx({});
        return {} as ServiceContext;
      });

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.service) {
            setError(String(j.error ?? "Servizio non trovato."));
            return;
          }
          const s = j.service;
          const qty: Record<number, number> = {};
          for (const r of (s.resources ?? []) as Array<{ resourceId: number; qtyRequired: number }>) {
            if (r.resourceId > 0) qty[r.resourceId] = Math.max(1, Number(r.qtyRequired ?? 1) || 1);
          }
          setForm({
            id: Number(s.id ?? id),
            name: String(s.name ?? ""),
            category_id: s.categoryId ? String(s.categoryId) : "",
            duration_min: String(s.durationMin ?? 60),
            price: String(s.priceValue ?? 0),
            is_active: Boolean(s.isActive ?? s.active ?? true),
            booking_enabled: Boolean(s.bookingEnabled ?? true),
            no_operator: Boolean(s.noOperator ?? false),
            location_ids: (s.locationIds ?? []).map(Number).filter((n: number) => n > 0),
            cabin_ids: (s.cabinIds ?? []).map(Number).filter((n: number) => n > 0),
            staff_ids: (s.staffIds ?? []).map(Number).filter((n: number) => n > 0),
            resource_qty: qty,
          });
        })
        .catch(() => setError("Errore nel caricamento del servizio."))
        .finally(() => setLoading(false));
    } else {
      // New service: faithful defaults (all active locations/cabins/staff
      // pre-selected, like services.php action=new).
      ctxPromise
        .then((j) => {
          const locs = (j.locations ?? []).filter((l) => l.isActive !== false).map((l) => Number(l.id));
          const cabs = (j.cabins ?? []).filter((c) => c.isActive !== false).map((c) => Number(c.id));
          const stf = (j.staff ?? []).filter((s) => s.isActive !== false).map((s) => Number(s.id));
          setForm((prev) => ({
            ...prev,
            location_ids: locs,
            cabin_ids: cabs,
            staff_ids: stf,
          }));
        })
        .finally(() => setLoading(false));
    }
  }, [slug]);

  function set<K extends keyof ServiceForm>(key: K, value: ServiceForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleId(key: "location_ids" | "cabin_ids" | "staff_ids", id: number, checked: boolean) {
    setForm((prev) => {
      const current = new Set(prev[key]);
      if (checked) current.add(id);
      else current.delete(id);
      return { ...prev, [key]: Array.from(current) };
    });
  }

  function toggleResource(id: number, checked: boolean) {
    setForm((prev) => {
      const next = { ...prev.resource_qty };
      if (checked) next[id] = next[id] ?? 1;
      else delete next[id];
      return { ...prev, resource_qty: next };
    });
  }

  function setResourceQty(id: number, qty: number) {
    setForm((prev) => ({ ...prev, resource_qty: { ...prev.resource_qty, [id]: Math.max(1, qty || 1) } }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/services`;
  }

  const categories = useMemo(() => ctx.categories ?? [], [ctx.categories]);
  const locations = useMemo(() => ctx.locations ?? [], [ctx.locations]);
  const cabins = useMemo(() => ctx.cabins ?? [], [ctx.cabins]);
  const staff = useMemo(() => ctx.staff ?? [], [ctx.staff]);
  const resources = useMemo(() => ctx.resources ?? [], [ctx.resources]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to services.php: name + duration + price required.
    const name = form.name.trim();
    const dur = Number.parseInt(form.duration_min, 10);
    const price = Number.parseFloat(form.price.replace(",", "."));
    if (name === "") {
      setError("Nome servizio obbligatorio");
      return;
    }
    if (!Number.isFinite(dur) || dur <= 0) {
      setError("La durata del servizio deve essere maggiore di zero");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("Il prezzo del servizio non puo essere negativo");
      return;
    }

    setSaving(true);
    try {
      const resourcesJson = Object.entries(form.resource_qty).map(([resourceId, qtyRequired]) => ({
        resourceId: Number(resourceId),
        qtyRequired: Math.max(1, Number(qtyRequired) || 1),
      }));
      const payload: Record<string, unknown> = {
        action: "save",
        id: String(form.id),
        name,
        category_id: form.category_id,
        duration_min: String(dur),
        price: String(price),
        is_active: form.is_active ? "1" : "0",
        booking_enabled: form.booking_enabled ? "1" : "0",
        no_operator: form.no_operator ? "1" : "0",
        location_ids: form.location_ids.join(","),
        cabin_ids: form.cabin_ids.join(","),
        staff_ids: form.no_operator ? "" : form.staff_ids.join(","),
        resources_json: JSON.stringify(resourcesJson),
      };
      const res = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del servizio."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio del servizio.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo servizio" : "Modifica servizio";
  const hasLocations = locations.length > 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/services.css" />

      <div className="services-editor-page">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Risorse</div>
            <h1 className="bs-page-title">{title}</h1>
            <div className="bs-page-subtitle">Configura disponibilita, sedi e risorse operative del servizio.</div>
          </div>
          <div className="bs-page-actions">
            <a className="btn btn-outline-secondary services-back-btn" href={`/${encodeURIComponent(slug)}/services`}>
              <i className="bi bi-arrow-left me-1" />
              Torna ai servizi
            </a>
          </div>
        </div>

        {error ? <div className="alert alert-danger">{error}</div> : null}

        {loading ? (
          <div className="card p-3 text-muted small">Caricamento…</div>
        ) : (
          <div className="card card-soft services-editor-card">
            <div className="card-body">
              <form method="post" className="services-editor-form" onSubmit={onSubmit}>
                <input type="hidden" name="id" value={form.id} />

                <div className="row g-4">
                  <div className="col-12">
                    <div className="border rounded-4 p-3 services-editor-section">
                      <div className="services-section-title">
                        <i className="bi bi-stars" />
                        Dati servizio
                      </div>

                      <div className="row g-3">
                        <div className="col-lg-8">
                          <label className="form-label">Nome</label>
                          <input
                            className="form-control"
                            name="name"
                            required
                            value={form.name}
                            onChange={(e) => set("name", e.target.value)}
                          />
                        </div>

                        <div className="col-lg-4">
                          <label className="form-label">Categoria</label>
                          <select
                            className="form-select"
                            name="category_id"
                            value={form.category_id}
                            onChange={(e) => set("category_id", e.target.value)}
                          >
                            <option value="">—</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <div className="form-text">
                            Gestisci le categorie da{" "}
                            <a href={`/${encodeURIComponent(slug)}/services?tab=categories`}>Categorie</a>.
                          </div>
                        </div>

                        <div className="col-lg-3">
                          <label className="form-label">Durata (min)</label>
                          <input
                            className="form-control"
                            type="number"
                            min="1"
                            step="1"
                            name="duration_min"
                            value={form.duration_min}
                            onChange={(e) => set("duration_min", e.target.value)}
                          />
                        </div>

                        <div className="col-lg-3">
                          <label className="form-label">Prezzo (€)</label>
                          <input
                            className="form-control"
                            type="number"
                            min="0"
                            step="0.01"
                            name="price"
                            value={form.price}
                            onChange={(e) => set("price", e.target.value)}
                          />
                        </div>

                        <div className="col-lg-3">
                          <label className="form-label">Stato</label>
                          <div className="form-check form-switch services-switch-tile">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              name="is_active"
                              id="svcActive"
                              checked={form.is_active}
                              onChange={(e) => set("is_active", e.target.checked)}
                            />
                            <label className="form-check-label" htmlFor="svcActive">
                              Attivo
                            </label>
                          </div>
                        </div>

                        <div className="col-lg-3">
                          <label className="form-label">Prenotazione</label>
                          <div className="form-check form-switch services-switch-tile">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              name="booking_enabled"
                              id="svcBookingEnabled"
                              value="1"
                              checked={form.booking_enabled}
                              onChange={(e) => set("booking_enabled", e.target.checked)}
                            />
                            <label className="form-check-label" htmlFor="svcBookingEnabled">
                              Abilita in prenotazioni online
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-12">
                    <div className="border rounded-4 p-3 services-editor-section">
                      <div className="services-section-title">
                        <i className="bi bi-geo-alt" />
                        Sedi abilitate
                      </div>

                      {hasLocations ? (
                        <>
                          <div className="row g-2">
                            {locations.map((loc) => {
                              const lid = Number(loc.id);
                              return (
                                <div className="col-md-6 col-xl-4" key={lid}>
                                  <div className="form-check services-option-card services-select-card services-location-card">
                                    <input
                                      className="form-check-input"
                                      type="checkbox"
                                      name="location_ids[]"
                                      id={`svc_loc_${lid}`}
                                      value={lid}
                                      checked={form.location_ids.includes(lid)}
                                      onChange={(e) => toggleId("location_ids", lid, e.target.checked)}
                                    />
                                    <label className="form-check-label" htmlFor={`svc_loc_${lid}`}>
                                      {loc.name || `Sede #${lid}`}
                                    </label>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="form-text">Il servizio sarà selezionabile solo nelle sedi abilitate.</div>
                        </>
                      ) : (
                        <div className="form-control-plaintext text-muted">Tutte le sedi</div>
                      )}
                    </div>
                  </div>

                  <div className="col-12">
                    <div className="border rounded-4 p-3 services-editor-section">
                      <div className="services-section-title">
                        <i className="bi bi-door-open" />
                        Cabine
                      </div>

                      <div className="row g-2">
                        {cabins.map((cb) => {
                          const cid = Number(cb.id);
                          return (
                            <div className="col-md-6 col-xl-4 svc-cabin-option" key={cid}>
                              <div className="form-check services-option-card services-select-card">
                                <input
                                  className="form-check-input"
                                  type="checkbox"
                                  name="cabin_ids[]"
                                  value={cid}
                                  id={`cab${cid}`}
                                  checked={form.cabin_ids.includes(cid)}
                                  onChange={(e) => toggleId("cabin_ids", cid, e.target.checked)}
                                />
                                <label className="form-check-label" htmlFor={`cab${cid}`}>
                                  {cb.name || `Cabina #${cid}`}
                                </label>
                              </div>
                            </div>
                          );
                        })}
                        {cabins.length === 0 ? (
                          <div className="text-muted">
                            Nessuna cabina configurata. Vai su{" "}
                            <a href={`/${encodeURIComponent(slug)}/cabins`}>Risorse &rarr; Cabine</a>.
                          </div>
                        ) : null}
                      </div>

                      <div className="form-text">Seleziona le cabine in cui è possibile svolgere questo servizio.</div>
                    </div>
                  </div>

                  <div className="col-12">
                    <div className="border rounded-4 p-3 services-editor-section">
                      <div className="services-section-head">
                        <div>
                          <div className="services-section-title mb-0">
                            <i className="bi bi-person-badge" />
                            Operatori
                          </div>
                          <div className="services-section-subtitle">
                            Scegli chi puo eseguire il servizio o abilita SSO.
                          </div>
                        </div>

                        <div className="text-end">
                          <div className="form-check form-switch services-switch-tile m-0">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              name="no_operator"
                              id="svcNoOperator"
                              value="1"
                              checked={form.no_operator}
                              onChange={(e) => set("no_operator", e.target.checked)}
                            />
                            <label className="form-check-label" htmlFor="svcNoOperator">
                              Servizio senza operatore
                            </label>
                          </div>
                        </div>
                      </div>

                      <div className="form-text mb-2">
                        Se attivo, la prenotazione verrà assegnata automaticamente a <strong>SSO</strong> (Senza
                        Operatore).
                      </div>

                      {form.no_operator ? (
                        <div className="alert alert-info py-2 small mb-2">
                          Questo servizio è impostato come <strong>senza operatore</strong>. In prenotazione verrà
                          assegnato automaticamente all&apos;operatore <strong>SSO</strong>.
                        </div>
                      ) : null}

                      <div className="row g-2" hidden={form.no_operator}>
                        {staff.map((stf) => {
                          const sid = Number(stf.id);
                          const locNames = (stf.locationIds ?? [])
                            .map((id) => locations.find((l) => Number(l.id) === Number(id))?.name)
                            .filter(Boolean)
                            .join(", ");
                          return (
                            <div className="col-md-4 col-xl-3 svc-staff-option" key={sid}>
                              <div className="form-check services-option-card services-select-card svc-staff-card">
                                <input
                                  className="form-check-input"
                                  type="checkbox"
                                  name="staff_ids[]"
                                  value={sid}
                                  id={`st${sid}`}
                                  checked={form.staff_ids.includes(sid)}
                                  onChange={(e) => toggleId("staff_ids", sid, e.target.checked)}
                                />
                                <label className="form-check-label" htmlFor={`st${sid}`}>
                                  {stf.fullName}
                                  {stf.isActive === false ? (
                                    <span className="badge text-bg-secondary ms-2">Non attivo</span>
                                  ) : null}
                                </label>
                                <div className="small text-muted mt-1">Sedi: {locNames || "Nessuna sede"}</div>
                              </div>
                            </div>
                          );
                        })}
                        {staff.length === 0 ? (
                          <div className="text-muted">
                            Nessun operatore. Creali in{" "}
                            <a href={`/${encodeURIComponent(slug)}/staff`}>Staff</a>.
                          </div>
                        ) : null}
                      </div>

                      <div className="form-text">Seleziona quali operatori possono eseguire questo servizio.</div>
                    </div>
                  </div>

                  <div className="col-12">
                    <div className="border rounded-4 p-3 services-editor-section">
                      <div className="services-section-title">
                        <i className="bi bi-boxes" />
                        Risorse necessarie
                      </div>

                      {resources.length === 0 ? (
                        <div className="text-muted">
                          Nessuna risorsa configurata. Vai su{" "}
                          <a href={`/${encodeURIComponent(slug)}/resources`}>Risorse</a> per crearle.
                        </div>
                      ) : (
                        <>
                          <div className="table-responsive">
                            <table className="table table-sm align-middle mb-2">
                              <thead>
                                <tr>
                                  <th className="services-resource-check-col" />
                                  <th>Risorsa</th>
                                  <th className="text-end services-resource-qty-col">Unità necessarie</th>
                                  <th className="text-end text-muted services-resource-available-col">Disponibili</th>
                                </tr>
                              </thead>
                              <tbody>
                                {resources.map((res) => {
                                  const rid = Number(res.id);
                                  const checked = Object.prototype.hasOwnProperty.call(form.resource_qty, rid);
                                  const qtyReq = form.resource_qty[rid] ?? 1;
                                  const qtyTotal = Math.max(0, Number(res.qtyTotal ?? 0) || 0);
                                  const maxAttr = qtyTotal > 0 ? qtyTotal : 1000000;
                                  return (
                                    <tr className="svc-resource-row" key={rid}>
                                      <td>
                                        <input
                                          className="form-check-input js-resource-check"
                                          type="checkbox"
                                          name="resource_ids[]"
                                          value={rid}
                                          id={`res${rid}`}
                                          checked={checked}
                                          onChange={(e) => toggleResource(rid, e.target.checked)}
                                        />
                                      </td>
                                      <td>
                                        <label className="form-check-label" htmlFor={`res${rid}`}>
                                          {res.name || `Risorsa #${rid}`}
                                        </label>
                                      </td>
                                      <td className="text-end">
                                        <input
                                          className="form-control form-control-sm js-resource-qty"
                                          type="number"
                                          min="1"
                                          max={maxAttr}
                                          name={`resource_qty[${rid}]`}
                                          value={qtyReq}
                                          disabled={!checked}
                                          onChange={(e) => setResourceQty(rid, Number.parseInt(e.target.value, 10))}
                                        />
                                      </td>
                                      <td className="text-end text-muted">
                                        {qtyTotal <= 0 ? (
                                          <span className="badge text-bg-secondary">Non disponibile</span>
                                        ) : (
                                          qtyTotal
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <div className="form-text">
                            Seleziona le risorse condivise necessarie per eseguire questo servizio e quante unità
                            servono.
                          </div>
                        </>
                      )}
                    </div>
                  </div>
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
          </div>
        )}
      </div>
    </div>
  );
}
