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

// Pannelli di conferma legacy (pendingService*Review di services.php 4393-4439).
type PendingImpact = { group: string; title: string; detail: string };
type PendingAppointment = {
  id: number;
  publicCode: string;
  startsAt: string;
  status: string;
  clientName: string;
  serviceName: string;
  statusMeta: { class: string; label: string };
};
type PendingReview = {
  kind: "deactivation_block" | "deactivation_appointments" | "name_update" | "price_update" | "impacted_appointments";
  serviceId: number;
  serviceName: string;
  serviceNameBefore: string;
  count: number;
  blockers?: PendingImpact[];
  impacts?: PendingImpact[];
  appointments?: PendingAppointment[];
  changedFields?: string[];
  oldPrice?: number;
  newPrice?: number;
};

// number_format(x, 2, ',', '.') come il legacy.
function fmtPriceIt(value: number): string {
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

function pendingDmy(startsAt: string): { date: string; time: string; full: string } {
  const s = String(startsAt ?? "").replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { date: "—", time: "—", full: "Data non disponibile" };
  const date = `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  const time = s.length >= 16 ? s.slice(11, 16) : "00:00";
  return { date, time, full: `${date} ${time}` };
}

function groupPendingImpacts(items: PendingImpact[], fallbackGroup = "Associazioni"): Array<[string, PendingImpact[]]> {
  const groups = new Map<string, PendingImpact[]>();
  for (const item of items) {
    const key = String(item.group ?? "").trim() || fallbackGroup;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()];
}
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
  // Pannello di conferma legacy restituito dal save (pendingService*Review):
  // il ri-POST accumula i confirm_* come gli hidden del form PHP (4855-4859).
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [confirms, setConfirms] = useState<Record<string, string>>({});
  const [pendingListOpen, setPendingListOpen] = useState<Record<string, boolean>>({});

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
      // Conferme accumulate (hidden confirm_* del form legacy 4855-4859).
      for (const [key, value] of Object.entries(confirms)) payload[key] = value;
      const res = await fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del servizio."));
        setSaving(false);
        window.scrollTo(0, 0);
        return;
      }
      if (j.pending) {
        setPending(j.pending as PendingReview);
        setPendingListOpen({});
        setSaving(false);
        return;
      }
      // Redirect flash legacy (services.php 4498/4579).
      window.location.assign(`/${encodeURIComponent(slug)}/services?msg=${encodeURIComponent(String(j.msg ?? "Servizio aggiornato"))}`);
    } catch {
      setError("Errore nel salvataggio del servizio.");
      setSaving(false);
    }
  }

  // Conferma dal pannello pending: ripete il submit col flag accumulato.
  function confirmPending(field: string) {
    setConfirms((prev) => ({ ...prev, [field]: "1" }));
    setPending(null);
  }
  useEffect(() => {
    if (!Object.keys(confirms).length || saving || pending) return;
    const formEl = document.querySelector<HTMLFormElement>(".services-editor-form");
    formEl?.requestSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirms]);

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

      {/* PANNELLI DI CONFERMA legacy (modali autoshow, services.php 5129-5434). */}
      {pending ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className={`modal-dialog ${pending.kind === "deactivation_block" ? "modal-lg" : "modal-xl"} modal-dialog-centered modal-dialog-scrollable`}>
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1">
                      {pending.kind === "deactivation_block" ? "Impossibile disattivare il servizio"
                        : pending.kind === "deactivation_appointments" ? "Conferma disattivazione servizio"
                        : pending.kind === "name_update" ? "Conferma aggiornamento nome servizio"
                        : pending.kind === "price_update" ? "Conferma aggiornamento prezzo servizio"
                        : "Conferma modifica non retroattiva del servizio"}
                    </h5>
                    <div className="text-muted small">
                      {pending.kind === "name_update" ? (
                        <>Stai modificando il nome da <strong>{pending.serviceNameBefore}</strong> a <strong>{pending.serviceName}</strong>.</>
                      ) : pending.kind === "price_update" ? (
                        <>Stai modificando il prezzo di <strong>{pending.serviceNameBefore || pending.serviceName}</strong> da <strong>€ {fmtPriceIt(pending.oldPrice ?? 0)}</strong> a <strong>€ {fmtPriceIt(pending.newPrice ?? 0)}</strong>.</>
                      ) : pending.kind === "impacted_appointments" ? (
                        <>Stai modificando impostazioni operative del servizio <strong>{pending.serviceNameBefore || pending.serviceName}</strong>.</>
                      ) : (
                        <>Servizio: <strong>{pending.serviceNameBefore || pending.serviceName}</strong></>
                      )}
                    </div>
                  </div>
                </div>
                <div className="modal-body">
                  {pending.kind === "deactivation_block" ? (
                    <>
                      <div className="alert alert-warning mb-3">
                        Il servizio non può essere disattivato perché è presente in una o più <strong>Campagne Promozione attive</strong> o <strong>Campagne gift attive</strong>.
                        Disattiva o modifica prima le campagne indicate, poi riprova.
                      </div>
                      <div className="small text-muted mb-3">Associazioni attive rilevate: <strong>{pending.count}</strong>.</div>
                      {renderPendingGroups(groupPendingImpacts(pending.blockers ?? [], "Campagne attive"))}
                    </>
                  ) : pending.kind === "deactivation_appointments" ? (
                    <>
                      <div className="alert alert-warning mb-3">
                        <div className="fw-semibold mb-1">Il servizio verrà disattivato solo per nuovi utilizzi.</div>
                        <div className="small mb-0">
                          Sono presenti prenotazioni in stato <strong>In sospeso</strong> o <strong>Prenotato</strong> collegate a questo servizio.
                          Confermando, il servizio non sarà più selezionabile per nuove prenotazioni/vendite, ma le prenotazioni già collegate resteranno invariate.
                        </div>
                      </div>
                      <div className="small text-muted mb-3">Prenotazioni aperte collegate rilevate: <strong>{pending.count}</strong>.</div>
                      {renderPendingGroups([["Prenotazioni collegate", (pending.appointments ?? []).map((appt) => ({
                        group: "Prenotazioni collegate",
                        title: `Prenotazione ${appt.publicCode || `#${appt.id}`}`,
                        detail: `Stato: ${appt.statusMeta?.label ?? "Prenotato"} • ${pendingDmy(appt.startsAt).full} • Cliente: ${appt.clientName.trim() || "Cliente non indicato"} • Servizio: ${appt.serviceName.trim() || pending.serviceNameBefore || pending.serviceName}`,
                      }))]])}
                    </>
                  ) : pending.kind === "name_update" ? (
                    <>
                      <div className="alert alert-warning mb-3">
                        <div className="fw-semibold mb-1">Il nome sarà aggiornato nei riferimenti operativi collegati sotto indicati.</div>
                        <div className="small mb-0">
                          Prenotazioni aperte, GiftBox, preventivi, pacchetti, catalogo pacchetti, servizi prepagati, omaggi e campagne collegate mostreranno il nuovo nome.
                          Tutto il resto già creato, come storico vendite e movimenti non inclusi nell&apos;elenco, resterà invariato.
                        </div>
                      </div>
                      <div className="small text-muted mb-3">Elementi rilevati: <strong>{pending.count}</strong>.</div>
                      {renderPendingGroups(groupPendingImpacts(pending.impacts ?? []))}
                    </>
                  ) : pending.kind === "price_update" ? (
                    <>
                      <div className="alert alert-warning mb-3">
                        <div className="fw-semibold mb-1">Il nuovo prezzo sarà aggiornato nei riferimenti operativi collegati sotto indicati.</div>
                        <div className="small mb-0">
                          Se collegati, verranno aggiornati il <strong>Catalogo pacchetti</strong> interessato, senza modificare i pacchetti cliente già esistenti, e le <strong>Campagne Promozioni</strong>.
                          Tutto il resto già creato, come vendite concluse, prenotazioni e storico, resterà invariato.
                        </div>
                      </div>
                      <div className="small text-muted mb-3">Elementi rilevati: <strong>{pending.count}</strong>.</div>
                      {(pending.impacts ?? []).length > 0 ? renderPendingGroups(groupPendingImpacts(pending.impacts ?? [])) : (
                        <div className="alert alert-info mb-0">
                          Nessun Catalogo pacchetti o Campagna Promozioni collegata a questo servizio è stata rilevata.
                          Confermando verrà aggiornato solo il prezzo anagrafico del servizio.
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="alert alert-warning mb-3">
                        <div className="fw-semibold mb-1">La modifica sarà valida solo per le nuove prenotazioni.</div>
                        <div className="small mb-0">
                          Le modifiche a <strong>Durata</strong>, <strong>Cabine</strong>, <strong>Operatori</strong> o <strong>Risorse necessarie</strong>
                          {" "}non saranno retroattive: non avranno effetto sulle prenotazioni già presenti in stato
                          {" "}<strong>In sospeso</strong>, <strong>Prenotato</strong>, <strong>Eseguito</strong> o <strong>Annullato</strong>.
                        </div>
                      </div>
                      {(pending.changedFields ?? []).length > 0 ? (
                        <div className="mb-3">
                          <div className="small text-muted mb-1">Campi modificati</div>
                          <div className="d-flex flex-wrap gap-2">
                            {(pending.changedFields ?? []).map((field) => (
                              <span className="badge text-bg-secondary" key={field}>{field}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {(pending.appointments ?? []).length > 0 ? (
                        <>
                          <div className="small text-muted mb-2">Prenotazioni aperte collegate rilevate: <strong>{pending.count}</strong>.</div>
                          <div className="accordion">
                            <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                              <h3 className="accordion-header">
                                <button className={`accordion-button ${pendingListOpen.appts ? "" : "collapsed"} bg-white shadow-none py-2`} type="button" onClick={() => setPendingListOpen((prev) => ({ ...prev, appts: !prev.appts }))}>
                                  <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                                    <span className="fw-semibold">Prenotazioni collegate</span>
                                    <span className="badge rounded-pill text-bg-info">{(pending.appointments ?? []).length}</span>
                                  </span>
                                </button>
                              </h3>
                              <div className={`accordion-collapse collapse ${pendingListOpen.appts ? "show" : ""}`}>
                                <div className="accordion-body py-2">
                                  <div className="table-responsive">
                                    <table className="table table-sm align-middle mb-0">
                                      <thead>
                                        <tr>
                                          <th>Data</th>
                                          <th>Ora</th>
                                          <th>Cliente</th>
                                          <th>Codice prenotazione</th>
                                          <th>Servizio</th>
                                          <th>Stato</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(pending.appointments ?? []).map((appt) => {
                                          const when = pendingDmy(appt.startsAt);
                                          return (
                                            <tr key={appt.id}>
                                              <td>{when.date}</td>
                                              <td>{when.time}</td>
                                              <td>{appt.clientName || "—"}</td>
                                              <td><code>{appt.publicCode || `#${appt.id}`}</code></td>
                                              <td>{appt.serviceName || pending.serviceNameBefore || pending.serviceName || "—"}</td>
                                              <td><span className={`badge text-bg-${appt.statusMeta?.class ?? "secondary"}`}>{appt.statusMeta?.label ?? "—"}</span></td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="alert alert-info mb-0">
                          Nessuna prenotazione in stato <strong>In sospeso</strong> o <strong>Prenotato</strong> collegata a questo servizio è stata rilevata.
                          La modifica rimarrà comunque non retroattiva e sarà usata dalle nuove prenotazioni.
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  {pending.kind === "deactivation_block" ? (
                    <button className="btn btn-outline-secondary btn-pill" type="button" onClick={() => { setPending(null); set("is_active", true); }}>Chiudi</button>
                  ) : (
                    <>
                      <button className="btn btn-outline-secondary btn-pill" type="button" onClick={() => setPending(null)}>Annulla</button>
                      <button
                        className="btn btn-primary btn-pill"
                        type="button"
                        onClick={() => confirmPending(
                          pending.kind === "deactivation_appointments" ? "confirm_service_deactivation_appointments"
                            : pending.kind === "name_update" ? "confirm_service_name_update"
                            : pending.kind === "price_update" ? "confirm_service_price_update"
                            : "confirm_impacted_appointments",
                        )}
                      >
                        <i className="bi bi-check2 me-1" />
                        {pending.kind === "deactivation_appointments" ? "Continua e disattiva" : pending.kind === "impacted_appointments" ? "Conferma" : "Continua e aggiorna"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );

  // svc_render_popup_accordion_groups: accordion per gruppo con badge count.
  function renderPendingGroups(groups: Array<[string, PendingImpact[]]>) {
    if (!groups.length) return <div className="text-muted">Nessuna associazione rilevata.</div>;
    return (
      <div className="accordion">
        {groups.map(([group, rows]) => (
          <div className="accordion-item border rounded-3 overflow-hidden mb-2" key={group}>
            <h3 className="accordion-header">
              <button className={`accordion-button ${pendingListOpen[group] ? "" : "collapsed"} bg-white shadow-none py-2`} type="button" onClick={() => setPendingListOpen((prev) => ({ ...prev, [group]: !prev[group] }))}>
                <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                  <span className="fw-semibold">{group}</span>
                  <span className="badge rounded-pill text-bg-info">{rows.length}</span>
                </span>
              </button>
            </h3>
            <div className={`accordion-collapse collapse ${pendingListOpen[group] ? "show" : ""}`}>
              <div className="accordion-body py-2">
                {rows.length === 0 ? (
                  <div className="text-muted small">Nessun dettaglio disponibile.</div>
                ) : (
                  <div className="list-group list-group-flush">
                    {rows.map((row, index) => (
                      <div className="list-group-item px-0" key={index}>
                        <div className="fw-semibold">{row.title || "Elemento collegato"}</div>
                        {row.detail ? <div className="small text-muted">{row.detail}</div> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
}
