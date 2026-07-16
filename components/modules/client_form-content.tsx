"use client";

import { useEffect, useRef, useState } from "react";

// Faithful port of the PHP client NEW / EDIT form (app/pages/clients.php,
// action=new|edit): Informazioni principali / Indirizzo Contatti (con le
// combobox Regione→Provincia→Città di italy-geo.js) / Info fiscali, la card
// Suggerimenti e — su edit — la card "Azioni cliente" (badge stato, Disattiva
// con modale + nota obbligatoria, Riattiva con confirm, Elimina →
// action=delete_confirm). Redirect legacy: new → view "Cliente creato",
// edit → view "Cliente aggiornato"; block/unblock restano sull'edit col flash.

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

export type ClientFormQuery = {
  msg?: string;
  err?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// d/m/Y H:i from "YYYY-MM-DD HH:MM[:SS]".
function fmtDateTime(v: string | null): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(v ?? "");
}

// Combobox legacy (app-combobox + italy-geo.js): markup identico; i valori
// vivono negli hidden input NON controllati (lo script li gestisce) e vengono
// letti dal DOM al submit.
function GeoCombobox({
  label,
  boxClass,
  inputClass,
  name,
  placeholder,
  defaultValue,
  startDisabled,
}: {
  label: string;
  boxClass: string;
  inputClass: string;
  name: string;
  placeholder: string;
  defaultValue: string;
  startDisabled: boolean;
}) {
  return (
    <div className="col-md-6">
      <label className="form-label">{label}</label>
      <div className={`dropdown app-combobox ${boxClass}`}>
        <button
          className="form-control text-start app-combobox-toggle dropdown-toggle"
          type="button"
          aria-expanded="false"
          disabled={startDisabled}
        >
          <span className="app-combobox-text" />
          <span className="app-combobox-placeholder text-muted">{placeholder}</span>
        </button>
        <input type="hidden" name={name} className={inputClass} defaultValue={defaultValue} />
        <div className="dropdown-menu p-2 w-100 app-combobox-menu">
          <input type="text" className="form-control form-control-sm app-combobox-search" placeholder="Cerca…" autoComplete="off" />
          <div className="list-group mt-2 app-combobox-list" />
        </div>
      </div>
    </div>
  );
}

export function ClientFormContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ClientFormQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action, setAction] = useState<"new" | "edit">("new");
  const [form, setForm] = useState<ClientForm>(emptyForm());
  // Regione/Provincia/Città prefill per gli hidden non controllati.
  const [geo, setGeo] = useState<{ region: string; province: string; city: string }>({ region: "", province: "", city: "" });
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  // Stato blocco (edit): badge + pannello Azioni cliente.
  const [blocked, setBlocked] = useState<{ isBlocked: boolean; blockedAt: string | null; note: string }>({ isBlocked: false, blockedAt: null, note: "" });
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [blockNote, setBlockNote] = useState("");
  const formRef = useRef<HTMLFormElement | null>(null);

  // Resolve action + id from the legacy-style query string. Il setAction va in
  // microtask (niente setState sincrono nell'effect; primo paint invariato).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);
    void Promise.resolve().then(() => setAction(act));

    // Locations for the "Sede di riferimento" select (default legacy: sede
    // corrente di sessione, non la prima della lista).
    const ctxPromise = fetch(`/api/manage/shell-context?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .catch(() => ({}));
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then(async (j) => {
        const rows: LocationRow[] = (j.locations ?? []).map((loc: { id: number; name?: string }) => ({
          id: Number(loc.id),
          name: String(loc.name ?? ""),
        }));
        setLocations(rows);
        if (act === "new") {
          const ctx = await ctxPromise;
          const current = Number(ctx?.currentLocationId ?? 0);
          const fallback = rows[0] ? String(rows[0].id) : "";
          setForm((prev) => ({ ...prev, location_id: current > 0 ? String(current) : fallback }));
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
            // Legacy: client_load_accessible fa redirect alla lista con l'errore.
            const msg = String(j.error ?? "Cliente non trovato o non disponibile per le tue sedi.");
            window.location.href = `/${encodeURIComponent(slug)}/clients?err=${encodeURIComponent(msg)}`;
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
          setGeo({ region: String(c.region ?? ""), province: String(c.province ?? ""), city: String(c.city ?? "") });
          setBlocked({
            isBlocked: Boolean(c.archived),
            blockedAt: c.blockedAt ? String(c.blockedAt) : null,
            note: String(c.blockedInternalNote ?? ""),
          });
        })
        .catch(() => setError("Errore nel caricamento del cliente."))
        .finally(() => setLoading(false));
    } else {
      // Microtask: niente setState sincrono nell'effect.
      void Promise.resolve().then(() => setLoading(false));
    }
  }, [slug]);

  // Combobox Regione/Provincia/Città: inietta italy-geo.js (IIFE legacy) DOPO
  // il render del markup con gli hidden prefillati; ?v= cache-buster per
  // ri-eseguirlo a ogni mount (il legacy usa ?v=time()).
  useEffect(() => {
    if (loading) return;
    const s = document.createElement("script");
    s.id = "italyGeoScript";
    s.dataset.base = window.location.origin;
    s.src = `/assets/js/italy-geo.js?v=${Date.now()}`;
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, [loading]);

  function set<K extends keyof ClientForm>(key: K, value: ClientForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function listUrl(extra = ""): string {
    return `/${encodeURIComponent(slug)}/clients${extra}`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to clients.php: full name required.
    const full = `${form.first_name} ${form.last_name}`.trim();
    if (full === "") {
      setError("Nome e cognome obbligatori");
      return;
    }
    if (locations.length > 0 && !form.location_id) {
      setError("Seleziona una sede valida.");
      return;
    }

    // Regione/Provincia/Città: gli hidden sono gestiti da italy-geo.js — leggili dal DOM.
    const root = formRef.current;
    const region = (root?.querySelector(".js-it-region") as HTMLInputElement | null)?.value ?? "";
    const province = (root?.querySelector(".js-it-province") as HTMLInputElement | null)?.value ?? "";
    const city = (root?.querySelector(".js-it-city") as HTMLInputElement | null)?.value ?? "";

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
        region,
        province,
        city,
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
      const submit = (extra: Record<string, string> = {}) =>
        fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ ...payload, ...extra }),
        });
      let res = await submit();
      let j = await res.json();
      // Blocco duplicati PRE-creazione (2026-07-16): il server risponde 409
      // needsDuplicateConfirm; si chiede conferma esplicita e si reinvia con
      // duplicate_confirmed=1 (niente più warning post-create tardivo).
      if (j?.needsDuplicateConfirm) {
        const proceed = typeof window !== "undefined" && window.confirm(`${String(j.error ?? "Cliente già esistente.")}\n\nVuoi creare comunque il cliente?`);
        if (!proceed) {
          setSaving(false);
          return;
        }
        res = await submit({ duplicate_confirmed: "1" });
        j = await res.json();
      }
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del cliente."));
        setSaving(false);
        return;
      }
      // Redirect legacy: alla SCHEDA con il flash.
      const newId = Number(j.client?.id ?? form.id);
      const msg = action === "edit" ? "Cliente aggiornato" : "Cliente creato";
      window.location.href = listUrl(`?action=view&id=${newId}&msg=${encodeURIComponent(msg)}`);
    } catch {
      setError("Errore nel salvataggio del cliente.");
      setSaving(false);
    }
  }

  // Disattiva cliente (port _mode=block_client): nota obbligatoria, poi redirect
  // sull'edit col flash legacy.
  async function doBlock() {
    if (busy) return;
    const note = blockNote.trim();
    const editUrl = listUrl(`?action=edit&id=${form.id}`);
    if (note === "") {
      window.location.href = `${editUrl}&err=${encodeURIComponent("Inserisci una nota interna con il motivo della disattivazione.")}`;
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "block", id: String(form.id), blocked_internal_note: note }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        window.location.href = `${editUrl}&err=${encodeURIComponent(String(j.error ?? "Errore nella disattivazione."))}`;
        return;
      }
      window.location.href = `${editUrl}&msg=${encodeURIComponent("Cliente disattivato. Nessun dato associato e stato eliminato e potrai riattivarlo in qualsiasi momento.")}`;
    } catch {
      setBusy(false);
      setError("Errore nella disattivazione.");
    }
  }

  // Riattiva cliente (port _mode=unblock_client) con confirm legacy.
  async function doUnblock() {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm("Riattivare questo cliente?")) return;
    setBusy(true);
    const editUrl = listUrl(`?action=edit&id=${form.id}`);
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "unblock", id: String(form.id) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        window.location.href = `${editUrl}&err=${encodeURIComponent(String(j.error ?? "Errore nella riattivazione."))}`;
        return;
      }
      window.location.href = `${editUrl}&msg=${encodeURIComponent("Cliente riattivato. Tutti i dati associati sono rimasti disponibili.")}`;
    } catch {
      setBusy(false);
      setError("Errore nella riattivazione.");
    }
  }

  const title = action === "new" ? "Nuovo cliente" : "Modifica cliente";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.err}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Anagrafica</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Compila dati principali, contatti e preferenze cliente.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={listUrl()}>
            <i className="bi bi-arrow-left me-1" />
            Torna alla lista
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" onSubmit={onSubmit} ref={formRef}>
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
                      <input className="form-control" name="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
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
                    <GeoCombobox
                      label="Regione"
                      boxClass="js-it-region-box"
                      inputClass="js-it-region"
                      name="region"
                      placeholder="Seleziona una regione…"
                      defaultValue={geo.region}
                      startDisabled={false}
                    />
                    <GeoCombobox
                      label="Provincia"
                      boxClass="js-it-province-box"
                      inputClass="js-it-province"
                      name="province"
                      placeholder="Seleziona prima la regione…"
                      defaultValue={geo.province}
                      startDisabled
                    />
                    <GeoCombobox
                      label="Città"
                      boxClass="js-it-city-box"
                      inputClass="js-it-city"
                      name="city"
                      placeholder="Seleziona prima la provincia…"
                      defaultValue={geo.city}
                      startDisabled
                    />
                    <div className="col-md-6">
                      <label className="form-label">CAP</label>
                      <input className="form-control" name="cap" value={form.cap} onChange={(e) => set("cap", e.target.value)} />
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
                      <input className="form-control" name="sdi" value={form.sdi} onChange={(e) => set("sdi", e.target.value)} />
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
                  Salva
                </button>
                <a className="btn btn-outline-secondary" href={listUrl()}>
                  Annulla
                </a>
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

              {action === "edit" ? (
                <div className="card p-3 mt-3">
                  <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
                    <div className="fw-semibold">Azioni cliente</div>
                    <span className={`badge ${blocked.isBlocked ? "text-bg-warning" : "text-bg-success"}`}>
                      {blocked.isBlocked ? "Disattivato" : "Attivo"}
                    </span>
                  </div>
                  {blocked.isBlocked ? (
                    <>
                      {blocked.blockedAt ? (
                        <div className="small text-muted mb-2">Disattivato il {fmtDateTime(blocked.blockedAt)}</div>
                      ) : null}
                      {blocked.note !== "" ? <div className="small text-muted mb-3 clients-prewrap">{blocked.note}</div> : null}
                      <button className="btn btn-outline-success w-100 mb-2" type="button" disabled={busy} onClick={doUnblock}>
                        <i className="bi bi-person-check me-1" />
                        Riattiva cliente
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-outline-danger w-100 mb-2" type="button" onClick={() => setShowBlockModal(true)}>
                      <i className="bi bi-slash-circle me-1" />
                      Disattiva cliente
                    </button>
                  )}
                  <a className="btn btn-danger w-100" href={listUrl(`?action=delete_confirm&id=${form.id}`)}>
                    <i className="bi bi-trash me-1" />
                    Elimina
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </form>
      )}

      {/* MODALE Disattiva cliente (verbatim clients.php #blockClientEditModal) */}
      {showBlockModal ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Disattiva cliente</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setShowBlockModal(false)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning small">
                    La disattivazione blocca l&apos;accesso del cliente al booking pubblico e lo nasconde in Pagamenti e Quick
                    Booking. Nessun dato associato verra eliminato.
                  </div>
                  <label className="form-label fw-semibold" htmlFor="blockedInternalNoteEditModal">
                    Motivo / nota interna
                  </label>
                  <textarea
                    className="form-control"
                    id="blockedInternalNoteEditModal"
                    rows={5}
                    required
                    placeholder="Es.: Account disattivato su richiesta del centro / insoluti / uso improprio del booking"
                    value={blockNote}
                    onChange={(e) => setBlockNote(e.target.value)}
                  />
                  <div className="form-text">La nota e solo interna e non verra mostrata al cliente.</div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setShowBlockModal(false)}>
                    Annulla
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={doBlock}>
                    <i className="bi bi-slash-circle me-1" />
                    Conferma disattivazione
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
