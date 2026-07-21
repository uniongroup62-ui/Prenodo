"use client";

import { useEffect, useMemo, useState } from "react";
import { flashNavigate } from "./flash";

// Faithful port of the PHP supplier NEW / EDIT form (app/pages/suppliers.php,
// the $isFormAction editor posted with action=supplier_save). Card/section
// structure and Bootstrap markup mirror the legacy editor:
//   - Fornitore: Nome (name, required) + Stato (is_active "Magazzino",
//     is_active_costs "Scadenziario e Costi")
//   - Sedi abilitate: per-location warehouse_location_ids[] / cost_location_ids[]
//     checkboxes
//   - Intestazione: business_name, address1, address2, cap, city, province,
//     country, country_iso
//   - Informazioni fiscali: vat_number, tax_code, sdi_code
//   - Contatti: phone, fax, mobile, email, pec, website
// Submits to /api/manage/products (action=supplier_save; create when no id,
// update with id) — the same endpoint/handler the legacy page posts to
// (saveSupplier). Locations come from the same /api/manage/products context the
// list uses.

type LocationRow = { id: number; name: string; isActive?: boolean };

type SupplierForm = {
  id: number;
  name: string;
  is_active: boolean;
  is_active_costs: boolean;
  business_name: string;
  address1: string;
  address2: string;
  cap: string;
  city: string;
  province: string;
  country: string;
  country_iso: string;
  vat_number: string;
  tax_code: string;
  sdi_code: string;
  phone: string;
  fax: string;
  mobile: string;
  email: string;
  pec: string;
  website: string;
  warehouse_location_ids: number[];
  cost_location_ids: number[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): SupplierForm {
  return {
    id: 0,
    name: "",
    is_active: true,
    is_active_costs: true,
    business_name: "",
    address1: "",
    address2: "",
    cap: "",
    city: "",
    province: "",
    country: "Italia",
    country_iso: "IT",
    vat_number: "",
    tax_code: "",
    sdi_code: "",
    phone: "",
    fax: "",
    mobile: "",
    email: "",
    pec: "",
    website: "",
    warehouse_location_ids: [],
    cost_location_ids: [],
  };
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function SupplierFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [form, setForm] = useState<SupplierForm>(emptyForm());
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdAt, setCreatedAt] = useState("");

  // Load the locations context, then prefill on edit (action=get&type=supplier).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const locs: LocationRow[] = Array.isArray(j.locations) ? j.locations : [];
        setLocations(locs);
        allActiveLocationIds = locs.filter((l) => l.isActive !== false).map((l) => Number(l.id)).filter((n) => n > 0);
        return locs;
      })
      .catch(() => setLocations([]));

    let allActiveLocationIds: number[] = [];

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}&action=get&type=supplier&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.supplier) {
            setError(String(j.error ?? "Fornitore non trovato."));
            return;
          }
          const s = j.supplier;
          setForm({
            id: Number(s.id ?? id),
            name: String(s.name ?? ""),
            is_active: Boolean(s.isActive ?? true),
            is_active_costs: Boolean(s.isActiveCosts ?? true),
            business_name: String(s.businessName ?? ""),
            address1: String(s.address1 ?? ""),
            address2: String(s.address2 ?? ""),
            cap: String(s.cap ?? ""),
            city: String(s.city ?? ""),
            province: String(s.province ?? ""),
            country: String(s.country ?? ""),
            country_iso: String(s.countryIso ?? ""),
            vat_number: String(s.vatNumber ?? ""),
            tax_code: String(s.taxCode ?? ""),
            sdi_code: String(s.sdiCode ?? ""),
            phone: String(s.phone ?? ""),
            fax: String(s.fax ?? ""),
            mobile: String(s.mobile ?? ""),
            email: String(s.email ?? ""),
            pec: String(s.pec ?? ""),
            website: String(s.website ?? ""),
            // Legacy: nessuna riga supplier_locations -> il form mostra TUTTE le
            // sedi attive selezionate in entrambi gli ambiti.
            warehouse_location_ids: s.hasLocationRows
              ? (s.warehouseLocationIds ?? []).map(Number).filter((n: number) => n > 0)
              : allActiveLocationIds,
            cost_location_ids: s.hasLocationRows
              ? (s.costLocationIds ?? []).map(Number).filter((n: number) => n > 0)
              : allActiveLocationIds,
          });
          setCreatedAt(String(s.createdAt ?? ""));
        })
        .catch(() => setError("Errore nel caricamento del fornitore."))
        .finally(() => setLoading(false));
    } else {
      // NEW legacy: tutte le sedi attive partono selezionate in entrambi gli ambiti.
      ctxPromise
        .then(() => {
          setForm((prev) => ({
            ...prev,
            warehouse_location_ids: allActiveLocationIds,
            cost_location_ids: allActiveLocationIds,
          }));
        })
        .finally(() => setLoading(false));
    }
  }, [slug]);

  function set<K extends keyof SupplierForm>(key: K, value: SupplierForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleLocation(key: "warehouse_location_ids" | "cost_location_ids", id: number, checked: boolean) {
    setForm((prev) => {
      const current = new Set(prev[key]);
      if (checked) current.add(id);
      else current.delete(id);
      return { ...prev, [key]: Array.from(current) };
    });
  }

  const activeLocations = useMemo(() => locations.filter((l) => l.isActive !== false), [locations]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to suppliers.php saveSupplier: name is required, and when
    // the tenant has active sedi, an active context needs at least one sede selected.
    if (form.name.trim() === "") {
      setError("Nome fornitore obbligatorio");
      return;
    }
    if (activeLocations.length > 0 && form.is_active && form.warehouse_location_ids.length === 0) {
      setError("Seleziona almeno una sede per il magazzino del fornitore.");
      return;
    }
    if (activeLocations.length > 0 && form.is_active_costs && form.cost_location_ids.length === 0) {
      setError("Seleziona almeno una sede per costi e scadenziario del fornitore.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "supplier_save",
        id: String(form.id),
        name: form.name,
        is_active: form.is_active ? "1" : "0",
        is_active_costs: form.is_active_costs ? "1" : "0",
        business_name: form.business_name,
        address1: form.address1,
        address2: form.address2,
        cap: form.cap,
        city: form.city,
        province: form.province,
        country: form.country,
        country_iso: form.country_iso,
        vat_number: form.vat_number,
        tax_code: form.tax_code,
        sdi_code: form.sdi_code,
        phone: form.phone,
        fax: form.fax,
        mobile: form.mobile,
        email: form.email,
        pec: form.pec,
        website: form.website,
        warehouse_location_ids: form.warehouse_location_ids.join(","),
        cost_location_ids: form.cost_location_ids.join(","),
      };
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del fornitore."));
        setSaving(false);
        return;
      }
      flashNavigate(`/${encodeURIComponent(slug)}/suppliers`, { msg: form.id > 0 ? "Fornitore aggiornato" : "Fornitore creato" });
    } catch {
      setError("Errore nel salvataggio del fornitore.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo fornitore" : "Modifica fornitore";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/suppliers.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Magazzino</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Gestisci dati, sedi abilitate e contatti del fornitore.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/suppliers`}>
            <i className="bi bi-arrow-left me-1" />
            Torna ai fornitori
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" className="suppliers-form" onSubmit={onSubmit}>
          <input type="hidden" name="id" value={form.id} />

          <div className="card mb-3">
            <div className="card-header">Fornitore</div>
            <div className="card-body">
              <div className="row g-3">
                <div className="col-lg-7">
                  <label className="form-label">Nome fornitore</label>
                  <input
                    className="form-control"
                    name="name"
                    required
                    placeholder="Es. Reviva"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                  />
                  <div className="form-text">
                    Questo nome verrà usato nel menu a tendina del campo “Fornitore” in <strong>Magazzino</strong> e in{" "}
                    <strong>Scadenziario e Costi</strong>.
                  </div>
                </div>

                <div className="col-lg-5">
                  <label className="form-label">Stato</label>
                  <div className="d-flex flex-column gap-2">
                    <div className="form-check form-switch">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="is_active"
                        name="is_active"
                        value="1"
                        checked={form.is_active}
                        onChange={(e) => set("is_active", e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="is_active">
                        Attivo (Magazzino)
                      </label>
                      <div className="form-text">
                        Se disattivo, non comparirà nel menu a tendina in <strong>Magazzino</strong>.
                      </div>
                    </div>

                    <div className="form-check form-switch">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="is_active_costs"
                        name="is_active_costs"
                        value="1"
                        checked={form.is_active_costs}
                        onChange={(e) => set("is_active_costs", e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="is_active_costs">
                        Attivo (Scadenziario e Costi)
                      </label>
                      <div className="form-text">
                        Se disattivo, non comparirà nel menu a tendina in <strong>Scadenziario e Costi</strong>.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {activeLocations.length > 0 ? (
            <div className="card mb-3">
              <div className="card-header">Sedi abilitate</div>
              <div className="card-body">
                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Sede</th>
                        <th className="text-center">Magazzino</th>
                        <th className="text-center">Scadenziario e Costi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeLocations.map((loc) => {
                        const lid = Number(loc.id);
                        return (
                          <tr key={lid}>
                            <td className="fw-semibold">{loc.name || `Sede #${lid}`}</td>
                            <td className="text-center">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                name="warehouse_location_ids[]"
                                value={lid}
                                checked={form.warehouse_location_ids.includes(lid)}
                                onChange={(e) => toggleLocation("warehouse_location_ids", lid, e.target.checked)}
                              />
                            </td>
                            <td className="text-center">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                name="cost_location_ids[]"
                                value={lid}
                                checked={form.cost_location_ids.includes(lid)}
                                onChange={(e) => toggleLocation("cost_location_ids", lid, e.target.checked)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          <div className="card mb-3">
            <div className="card-header">Intestazione</div>
            <div className="card-body">
              <div className="row g-3">
                <div className="col-lg-8">
                  <label className="form-label">Ragione Sociale</label>
                  <input
                    className="form-control"
                    name="business_name"
                    placeholder="Es. Reviva Srl"
                    value={form.business_name}
                    onChange={(e) => set("business_name", e.target.value)}
                  />
                </div>

                <div className="col-lg-8">
                  <label className="form-label">Indirizzo</label>
                  <input
                    className="form-control"
                    name="address1"
                    placeholder="Es. Viale della Pace 12"
                    value={form.address1}
                    onChange={(e) => set("address1", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Indirizzo 2</label>
                  <input
                    className="form-control"
                    name="address2"
                    placeholder="Scala / interno / note consegna"
                    value={form.address2}
                    onChange={(e) => set("address2", e.target.value)}
                  />
                </div>

                <div className="col-lg-2">
                  <label className="form-label">CAP</label>
                  <input
                    className="form-control"
                    name="cap"
                    placeholder="36100"
                    value={form.cap}
                    onChange={(e) => set("cap", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Località</label>
                  <input
                    className="form-control"
                    name="city"
                    placeholder="Es. Vicenza"
                    value={form.city}
                    onChange={(e) => set("city", e.target.value)}
                  />
                </div>
                <div className="col-lg-2">
                  <label className="form-label">Provincia</label>
                  <input
                    className="form-control"
                    name="province"
                    placeholder="VI"
                    value={form.province}
                    onChange={(e) => set("province", e.target.value)}
                  />
                </div>
                <div className="col-lg-2">
                  <label className="form-label">Nazione</label>
                  <input
                    className="form-control"
                    name="country"
                    placeholder="Italia"
                    value={form.country}
                    onChange={(e) => set("country", e.target.value)}
                  />
                </div>
                <div className="col-lg-2">
                  <label className="form-label">ISO</label>
                  <input
                    className="form-control"
                    name="country_iso"
                    placeholder="IT"
                    value={form.country_iso}
                    onChange={(e) => set("country_iso", e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-header">Informazioni fiscali</div>
            <div className="card-body">
              <div className="row g-3">
                <div className="col-lg-4">
                  <label className="form-label">Partita IVA</label>
                  <input
                    className="form-control"
                    name="vat_number"
                    placeholder="00000000000"
                    value={form.vat_number}
                    onChange={(e) => set("vat_number", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Codice Fiscale</label>
                  <input
                    className="form-control"
                    name="tax_code"
                    placeholder="(opzionale)"
                    value={form.tax_code}
                    onChange={(e) => set("tax_code", e.target.value)}
                  />
                </div>

                <div className="col-lg-4">
                  <label className="form-label">Codice SDI</label>
                  <input
                    className="form-control"
                    name="sdi_code"
                    placeholder="(opzionale)"
                    value={form.sdi_code}
                    onChange={(e) => set("sdi_code", e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-header">Contatti</div>
            <div className="card-body">
              <div className="row g-3">
                <div className="col-lg-4">
                  <label className="form-label">Telefono</label>
                  <input
                    className="form-control"
                    name="phone"
                    placeholder="0444 888888"
                    value={form.phone}
                    onChange={(e) => set("phone", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Fax</label>
                  <input
                    className="form-control"
                    name="fax"
                    placeholder="0444 888999"
                    value={form.fax}
                    onChange={(e) => set("fax", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Cellulare</label>
                  <input
                    className="form-control"
                    name="mobile"
                    placeholder="(opzionale)"
                    value={form.mobile}
                    onChange={(e) => set("mobile", e.target.value)}
                  />
                </div>

                <div className="col-lg-4">
                  <label className="form-label">E-mail</label>
                  <input
                    className="form-control"
                    type="email"
                    name="email"
                    placeholder="info@fornitore.it"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">PEC</label>
                  <input
                    className="form-control"
                    type="email"
                    name="pec"
                    placeholder="pec@fornitore.it"
                    value={form.pec}
                    onChange={(e) => set("pec", e.target.value)}
                  />
                </div>
                <div className="col-lg-4">
                  <label className="form-label">Internet</label>
                  <input
                    className="form-control"
                    name="website"
                    placeholder="www.fornitore.it"
                    value={form.website}
                    onChange={(e) => set("website", e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="d-flex flex-wrap gap-2 pt-1">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              Salva
            </button>
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/suppliers`}>
              Annulla
            </a>
          </div>

          {createdAt ? (
            <div className="text-end text-muted small mt-2">
              Aggiunto il: {(() => {
                const m = createdAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
                return m ? `${m[3]}/${m[2]}/${m[1]}` : createdAt;
              })()}
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}
