"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP client NEW / EDIT form (app/pages/clients.php,
// action=new|edit). Field groups and Bootstrap markup mirror the legacy page:
//   - Informazioni principali: first_name, last_name, phone, email, gender,
//     birth_date, birth_place, registration_date, location_id, notes
//   - Indirizzo / Contatti: region, province, city, cap, address, job_title,
//     phone_home, phone2
//   - Info fiscali: tax_code, vat_number, sdi, company_name, pec
// Submits to /api/manage/clients (action=create on new, action=update on edit).
// Region/province/city are plain text inputs here (the legacy JS combobox is a
// later step) but carry the same field names so the data round-trips.

type LocationRow = { id: number; name: string };

type ClientForm = {
  id: number;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  gender: string;
  birth_date: string;
  birth_place: string;
  registration_date: string;
  location_id: string;
  notes: string;
  region: string;
  province: string;
  city: string;
  cap: string;
  address: string;
  job_title: string;
  phone_home: string;
  phone2: string;
  tax_code: string;
  vat_number: string;
  sdi: string;
  company_name: string;
  pec: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): ClientForm {
  return {
    id: 0,
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
    gender: "",
    birth_date: "",
    birth_place: "",
    registration_date: todayIso(),
    location_id: "",
    notes: "",
    region: "",
    province: "",
    city: "",
    cap: "",
    address: "",
    job_title: "",
    phone_home: "",
    phone2: "",
    tax_code: "",
    vat_number: "",
    sdi: "",
    company_name: "",
    pec: "",
  };
}

export function ClientFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action, setAction] = useState<"new" | "edit">("new");
  const [form, setForm] = useState<ClientForm>(emptyForm());
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Resolve action + id from the legacy-style query string.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);
    setAction(act);

    // Locations for the "Sede di riferimento" select.
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const rows: LocationRow[] = (j.locations ?? []).map((loc: { id: number; name?: string }) => ({
          id: Number(loc.id),
          name: String(loc.name ?? ""),
        }));
        setLocations(rows);
        // Default the new-client location to the first available sede.
        if (act === "new") {
          setForm((prev) => ({ ...prev, location_id: rows[0] ? String(rows[0].id) : "" }));
        }
      })
      .catch(() => setLocations([]));

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j) => {
          if (!j.ok || !j.client) {
            setError(String(j.error ?? "Cliente non trovato."));
            return;
          }
          const c = j.client;
          setForm({
            id: Number(c.id ?? id),
            first_name: String(c.firstName ?? ""),
            last_name: String(c.lastName ?? ""),
            phone: String(c.phone ?? ""),
            email: String(c.email ?? ""),
            gender: String(c.gender ?? ""),
            birth_date: String(c.birthDate ?? ""),
            birth_place: String(c.birthPlace ?? ""),
            registration_date: String(c.registrationDate ?? "") || todayIso(),
            location_id: c.locationId ? String(c.locationId) : "",
            notes: String(c.note ?? ""),
            region: String(c.region ?? ""),
            province: String(c.province ?? ""),
            city: String(c.city ?? ""),
            cap: String(c.cap ?? ""),
            address: String(c.address ?? ""),
            job_title: String(c.jobTitle ?? ""),
            phone_home: String(c.phoneHome ?? ""),
            phone2: String(c.phone2 ?? ""),
            tax_code: String(c.taxCode ?? ""),
            vat_number: String(c.vatNumber ?? ""),
            sdi: String(c.sdi ?? ""),
            company_name: String(c.companyName ?? ""),
            pec: String(c.pec ?? ""),
          });
        })
        .catch(() => setError("Errore nel caricamento del cliente."))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [slug]);

  function set<K extends keyof ClientForm>(key: K, value: ClientForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/clients`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to clients.php: a name is required (first/last compose
    // full_name; empty => error).
    const full = `${form.first_name} ${form.last_name}`.trim();
    if (full === "") {
      setError("Nome e cognome obbligatori.");
      return;
    }
    if (locations.length > 0 && !form.location_id) {
      setError("Seleziona una sede valida.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, string> = {
        action: action === "edit" ? "update" : "create",
        id: String(form.id),
        first_name: form.first_name,
        last_name: form.last_name,
        full_name: full,
        phone: form.phone,
        email: form.email,
        gender: form.gender,
        birth_date: form.birth_date,
        birth_place: form.birth_place,
        registration_date: form.registration_date,
        location_id: form.location_id,
        notes: form.notes,
        region: form.region,
        province: form.province,
        city: form.city,
        cap: form.cap,
        address: form.address,
        job_title: form.job_title,
        phone_home: form.phone_home,
        phone2: form.phone2,
        tax_code: form.tax_code,
        vat_number: form.vat_number,
        sdi: form.sdi,
        company_name: form.company_name,
        pec: form.pec,
      };
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del cliente."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio del cliente.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo cliente" : "Modifica cliente";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Anagrafica</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Compila dati principali, contatti e preferenze cliente.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients`}>
            <i className="bi bi-arrow-left me-1" />
            Torna alla lista
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" onSubmit={onSubmit}>
          <input type="hidden" name="id" value={form.id} />

          <div className="row g-3">
            <div className="col-lg-8">
              <div className="card">
                <div className="card-header">Informazioni principali</div>
                <div className="card-body">
                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label">
                        Nome <span className="text-danger">*</span>
                      </label>
                      <input
                        className="form-control"
                        name="first_name"
                        required
                        value={form.first_name}
                        onChange={(e) => set("first_name", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">
                        Cognome <span className="text-danger">*</span>
                      </label>
                      <input
                        className="form-control"
                        name="last_name"
                        required
                        value={form.last_name}
                        onChange={(e) => set("last_name", e.target.value)}
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Cellulare</label>
                      <input
                        className="form-control"
                        name="phone"
                        value={form.phone}
                        onChange={(e) => set("phone", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Email</label>
                      <input
                        className="form-control"
                        type="email"
                        name="email"
                        value={form.email}
                        onChange={(e) => set("email", e.target.value)}
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label d-block">Sesso</label>
                      <div className="d-flex gap-4 pt-1">
                        <div className="form-check">
                          <input
                            className="form-check-input"
                            type="radio"
                            name="gender"
                            id="genderM2"
                            value="M"
                            checked={form.gender === "M"}
                            onChange={() => set("gender", "M")}
                          />
                          <label className="form-check-label" htmlFor="genderM2">
                            Maschio
                          </label>
                        </div>
                        <div className="form-check">
                          <input
                            className="form-check-input"
                            type="radio"
                            name="gender"
                            id="genderF2"
                            value="F"
                            checked={form.gender === "F"}
                            onChange={() => set("gender", "F")}
                          />
                          <label className="form-check-label" htmlFor="genderF2">
                            Femmina
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Data di nascita</label>
                      <input
                        className="form-control"
                        type="date"
                        name="birth_date"
                        value={form.birth_date}
                        onChange={(e) => set("birth_date", e.target.value)}
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Luogo di nascita</label>
                      <input
                        className="form-control"
                        name="birth_place"
                        value={form.birth_place}
                        onChange={(e) => set("birth_place", e.target.value)}
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Data iscrizione</label>
                      <input
                        className="form-control"
                        type="date"
                        name="registration_date"
                        value={form.registration_date}
                        onChange={(e) => set("registration_date", e.target.value)}
                      />
                      <div className="form-text">Viene impostata automaticamente alla creazione (modificabile).</div>
                    </div>

                    {locations.length > 0 ? (
                      <div className="col-md-6">
                        <label className="form-label">
                          Sede di riferimento <span className="text-danger">*</span>
                        </label>
                        <select
                          className="form-select"
                          name="location_id"
                          required
                          value={form.location_id}
                          onChange={(e) => set("location_id", e.target.value)}
                        >
                          {locations.map((loc) => (
                            <option key={loc.id} value={loc.id}>
                              {loc.name || `Sede #${loc.id}`}
                            </option>
                          ))}
                        </select>
                        <div className="form-text">Serve per filtrare l&apos;anagrafica. Lo storico resta globale.</div>
                      </div>
                    ) : null}

                    <div className="col-12">
                      <label className="form-label">Note</label>
                      <textarea
                        className="form-control"
                        name="notes"
                        rows={3}
                        value={form.notes}
                        onChange={(e) => set("notes", e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="card mt-3">
                <div className="card-header">Indirizzo / Contatti</div>
                <div className="card-body">
                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label">Regione</label>
                      <input
                        className="form-control"
                        name="region"
                        value={form.region}
                        onChange={(e) => set("region", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Provincia</label>
                      <input
                        className="form-control"
                        name="province"
                        value={form.province}
                        onChange={(e) => set("province", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Città</label>
                      <input
                        className="form-control"
                        name="city"
                        value={form.city}
                        onChange={(e) => set("city", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">CAP</label>
                      <input
                        className="form-control"
                        name="cap"
                        value={form.cap}
                        onChange={(e) => set("cap", e.target.value)}
                      />
                    </div>
                    <div className="col-12">
                      <label className="form-label">Indirizzo</label>
                      <input
                        className="form-control"
                        name="address"
                        value={form.address}
                        onChange={(e) => set("address", e.target.value)}
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Titolo / Lavoro</label>
                      <input
                        className="form-control"
                        name="job_title"
                        value={form.job_title}
                        onChange={(e) => set("job_title", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6" />

                    <div className="col-md-6">
                      <label className="form-label">Telefono fisso</label>
                      <input
                        className="form-control"
                        name="phone_home"
                        value={form.phone_home}
                        onChange={(e) => set("phone_home", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Cellulare 2</label>
                      <input
                        className="form-control"
                        name="phone2"
                        value={form.phone2}
                        onChange={(e) => set("phone2", e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="card mt-3">
                <div className="card-header">Info fiscali</div>
                <div className="card-body">
                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label">Codice Fiscale</label>
                      <input
                        className="form-control"
                        name="tax_code"
                        value={form.tax_code}
                        onChange={(e) => set("tax_code", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Partita IVA</label>
                      <input
                        className="form-control"
                        name="vat_number"
                        value={form.vat_number}
                        onChange={(e) => set("vat_number", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">SDI</label>
                      <input
                        className="form-control"
                        name="sdi"
                        value={form.sdi}
                        onChange={(e) => set("sdi", e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Azienda</label>
                      <input
                        className="form-control"
                        name="company_name"
                        value={form.company_name}
                        onChange={(e) => set("company_name", e.target.value)}
                      />
                    </div>
                    <div className="col-12">
                      <label className="form-label">PEC</label>
                      <div className="input-group">
                        <span className="input-group-text">
                          <i className="bi bi-envelope" />
                        </span>
                        <input
                          className="form-control"
                          type="email"
                          name="pec"
                          value={form.pec}
                          placeholder="pec@dominio.it"
                          onChange={(e) => set("pec", e.target.value)}
                        />
                      </div>
                    </div>
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
            </div>

            <div className="col-lg-4">
              <div className="card p-3">
                <div className="fw-semibold mb-2">Suggerimenti</div>
                <div className="text-muted small">
                  <ul className="mb-0">
                    <li>Nome e cognome sono obbligatori.</li>
                    <li>
                      La <strong>data iscrizione</strong> viene impostata automaticamente ma puoi cambiarla.
                    </li>
                    <li>I campi indirizzo/contatti sono facoltativi.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
