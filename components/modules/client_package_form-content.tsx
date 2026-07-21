"use client";

import { useEffect, useRef, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

// Faithful port of the PHP client-package EDIT form (packages.php tab=clients
// action=client_edit): Cliente*/Sede/Da catalogo (opzionale)/Servizio
// (opzionale) come combobox ricercabili, Nome pacchetto*, Sedute totali/
// rimanenti, Data acquisto/inizio/Scadenza (bloccata se già utilizzato), Stato
// (annullato readonly "Annullato (solo da dettaglio vendita)"; riattivazione
// bloccata se contenuti eliminati), Note, Salva/Annulla. client_new è bloccato
// dal legacy: redirect con "La vendita/assegnazione dei pacchetti avviene solo
// da Pagamenti."

type Issue = { type: string; label: string; message: string };
type EditData = {
  id: number;
  clientId: number;
  packageId: number;
  packageName: string;
  serviceId: number;
  locationId: number;
  purchaseDate: string;
  startDate: string;
  expiresAt: string;
  sessionsTotal: number;
  sessionsRemaining: number;
  status: string;
  computedStatus: string;
  notes: string;
  expiryEditable: boolean;
  availability: { errors: Issue[]; warnings: Issue[] };
};

export type ClientPackageFormQuery = { msg?: string; err?: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Combobox legacy (app-combobox): bottone + ricerca + lista.
function FormCombobox({
  options,
  value,
  placeholder,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const selected = options.find((o) => o.id === value && value !== "");
  const needle = search.trim().toLowerCase();
  const list = needle === "" ? options : options.filter((o) => o.label.toLowerCase().includes(needle));
  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} ref={boxRef}>
      <button
        className="form-control text-start app-combobox-toggle dropdown-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <span className="app-combobox-text">{selected.label}</span>
        ) : (
          <span className="app-combobox-placeholder text-muted">{placeholder}</span>
        )}
      </button>
      <div className={`dropdown-menu p-2 w-100 ${open ? "show" : ""}`}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="app-combobox-list mt-2" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          <button
            type="button"
            className="list-group-item list-group-item-action"
            onClick={() => {
              onChange("");
              setOpen(false);
              setSearch("");
            }}
          >
            {placeholder}
          </button>
          {list.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`list-group-item list-group-item-action ${o.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
                setSearch("");
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ClientPackageFormContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ClientPackageFormQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [cpId, setCpId] = useState(0);
  const [edit, setEdit] = useState<EditData | null>(null);
  const [clients, setClients] = useState<Array<{ id: string; label: string }>>([]);
  const [catalog, setCatalog] = useState<Array<{ id: string; label: string; sessionsTotal: number; serviceId: number; validityDays: number }>>([]);
  const [services, setServices] = useState<Array<{ id: string; label: string }>>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  // Audit giro 3: su errore di rete la pagina restava su "Caricamento…" per sempre.
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  const [form, setForm] = useState({
    client_id: "",
    location_id: "",
    package_id: "",
    service_id: "",
    package_name: "",
    sessions_total: "10",
    sessions_remaining: "",
    purchase_date: todayIso(),
    start_date: todayIso(),
    expires_at: "",
    status: "active",
    notes: "",
  });

  // Microtask: evita il setState sincrono nell'effect (primo paint invariato).
  useEffect(() => {
    void Promise.resolve().then(() => {
      const params = new URLSearchParams(window.location.search);
      const action = params.get("action") ?? "";
      if (action === "client_new") {
        // Legacy: la creazione avviene solo da Pagamenti.
        flashNavigate(`/${encodeURIComponent(slug)}/packages?tab=clients`, { err: "La vendita/assegnazione dei pacchetti avviene solo da Pagamenti." });
        return;
      }
      const id = Number.parseInt(params.get("id") ?? "", 10);
      if (Number.isFinite(id) && id > 0) setCpId(id);
      else flashNavigate(`/${encodeURIComponent(slug)}/packages?tab=clients`, { msg: "Pacchetto non trovato" });
    });
  }, [slug]);

  useEffect(() => {
    if (!cpId) return;
    let active = true;
    Promise.all([
      fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=client_get&id=${cpId}`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()),
      fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=filters`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()),
      fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()).catch(() => ({})),
      fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([ej, fj, sj, lj]) => {
        if (!active) return;
        if (!ej?.ok || !ej.edit) {
          flashNavigate(`/${encodeURIComponent(slug)}/packages?tab=clients`, { msg: "Pacchetto non trovato" });
          return;
        }
        const e = ej.edit as EditData;
        setEdit(e);
        setForm({
          client_id: e.clientId > 0 ? String(e.clientId) : "",
          location_id: e.locationId > 0 ? String(e.locationId) : "",
          package_id: e.packageId > 0 ? String(e.packageId) : "",
          service_id: e.serviceId > 0 ? String(e.serviceId) : "",
          package_name: e.packageName,
          sessions_total: String(e.sessionsTotal || 10),
          sessions_remaining: String(e.sessionsRemaining),
          purchase_date: e.purchaseDate || todayIso(),
          start_date: e.startDate || todayIso(),
          expires_at: e.expiresAt,
          status: e.computedStatus,
          notes: e.notes,
        });
        setClients((fj?.clients ?? []).map((c: { id: number; label: string }) => ({ id: String(c.id), label: c.label })));
        setCatalog((fj?.catalog ?? []).map((p: { id: number; name: string; sessionsTotal: number; serviceId: number; validityDays: number }) => ({ id: String(p.id), label: p.name, sessionsTotal: p.sessionsTotal, serviceId: p.serviceId, validityDays: p.validityDays })));
        const svcRows = Array.isArray(sj?.services) ? sj.services : [];
        setServices(svcRows.map((s: { id: number; name: string }) => ({ id: String(s.id), label: String(s.name ?? "") })));
        const locRows = Array.isArray(lj?.locations) ? lj.locations : [];
        setLocations(locRows.map((l: { id: number; name?: string }) => ({ id: Number(l.id), name: String(l.name ?? "") })));
      })
      .catch(() => setLoadError(true))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cpId, slug]);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function listUrl(extra = ""): string {
    return `/${encodeURIComponent(slug)}/packages?tab=clients${extra}`;
  }

  // Selezione dal catalogo: precompila i campi (come packages.js).
  function onCatalogChange(id: string) {
    set("package_id", id);
    const p = catalog.find((c) => c.id === id);
    if (!p) return;
    setForm((prev) => ({
      ...prev,
      package_id: id,
      package_name: prev.package_name !== "" ? prev.package_name : p.label,
      service_id: prev.service_id !== "" ? prev.service_id : p.serviceId > 0 ? String(p.serviceId) : "",
      sessions_total: p.sessionsTotal > 0 ? String(p.sessionsTotal) : prev.sessions_total,
    }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !edit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "client_save", id: String(cpId), ...form }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        // Esiti legacy: errori come flash ?err sull'edit (o sulla lista).
        flashNavigate(listUrl(`&action=client_edit&id=${cpId}`), { err: String(j?.error ?? "Errore salvataggio") });
        return;
      }
      flashNavigate(listUrl(`&action=client_view&id=${cpId}`), { msg: "Pacchetto aggiornato" });
    } catch {
      setBusy(false);
      if (typeof window !== "undefined") window.alert("Errore di rete: operazione non eseguita. Riprova.");
    }
  }

  const reactivationBlocked = edit ? edit.computedStatus === "expired" && edit.availability.errors.length > 0 : false;
  const isCanceled = edit?.computedStatus === "canceled" || edit?.status === "canceled";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

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
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti</h1>
          <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
        </div>
      </div>

      {loadError ? (
        <div className="alert alert-danger">Errore di caricamento. Ricarica la pagina.</div>
      ) : loading || !edit ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <>
          {edit.computedStatus === "expired" && edit.availability.errors.length > 0 ? (
            <div className="alert alert-danger">
              <div className="fw-semibold mb-1">Questo pacchetto non può essere riattivato.</div>
              <div className="small mb-2">
                Non sarà possibile impostare lo stato in <strong>Attivo</strong> perché uno o più contenuti sono stati eliminati.
              </div>
              <ul className="mb-0 small">
                {edit.availability.errors.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {edit.computedStatus === "expired" && edit.availability.warnings.length > 0 ? (
            <div className="alert alert-warning">
              <div className="fw-semibold mb-1">Contenuti disattivati presenti.</div>
              <div className="small mb-2">Il pacchetto potrà comunque essere riattivato, ma i seguenti contenuti risultano disattivati.</div>
              <ul className="mb-0 small">
                {edit.availability.warnings.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="card p-3 mb-3">
            <form onSubmit={onSubmit}>
              <div className="row g-3">
                <div className="col-md-4">
                  <label className="form-label">
                    Cliente <span className="text-danger">*</span>
                  </label>
                  <FormCombobox options={clients} value={form.client_id} placeholder="Seleziona…" onChange={(v) => set("client_id", v)} />
                </div>

                <div className="col-md-4">
                  <label className="form-label">Sede</label>
                  <select className="form-select" value={form.location_id} onChange={(e) => set("location_id", e.target.value)}>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name || `Sede #${loc.id}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-md-4">
                  <label className="form-label">Da catalogo (opzionale)</label>
                  <FormCombobox options={catalog.map((c) => ({ id: c.id, label: c.label }))} value={form.package_id} placeholder="— personalizzato —" onChange={onCatalogChange} />
                  <div className="form-text">Selezionando un pacchetto, alcuni campi vengono precompilati (puoi modificarli).</div>
                </div>

                <div className="col-md-4">
                  <label className="form-label">Servizio (opzionale)</label>
                  <FormCombobox options={services} value={form.service_id} placeholder="—" onChange={(v) => set("service_id", v)} />
                </div>

                <div className="col-md-6">
                  <label className="form-label">
                    Nome pacchetto <span className="text-danger">*</span>
                  </label>
                  <input
                    className="form-control"
                    required
                    placeholder="Es. 10 sedute Laser"
                    value={form.package_name}
                    onChange={(e) => set("package_name", e.target.value)}
                  />
                </div>

                <div className="col-md-3">
                  <label className="form-label">Sedute totali</label>
                  <input
                    className="form-control"
                    type="number"
                    min={1}
                    step={1}
                    value={form.sessions_total}
                    onChange={(e) => set("sessions_total", e.target.value)}
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Sedute rimanenti</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="(se vuoto = totali)"
                    value={form.sessions_remaining}
                    onChange={(e) => set("sessions_remaining", e.target.value)}
                  />
                </div>

                <div className="col-md-3">
                  <label className="form-label">Data acquisto</label>
                  <input className="form-control" type="date" value={form.purchase_date} onChange={(e) => set("purchase_date", e.target.value)} />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Data inizio</label>
                  <input className="form-control" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Scadenza</label>
                  <input
                    className="form-control"
                    type="date"
                    value={form.expires_at}
                    disabled={!edit.expiryEditable}
                    aria-disabled={!edit.expiryEditable}
                    onChange={(e) => set("expires_at", e.target.value)}
                  />
                  {!edit.expiryEditable ? (
                    <div className="form-text text-muted">Scadenza non modificabile perche il pacchetto risulta gia utilizzato.</div>
                  ) : null}
                </div>
                <div className="col-md-2">
                  <label className="form-label">Stato</label>
                  {isCanceled ? (
                    <input className="form-control" type="text" value="Annullato (solo da dettaglio vendita)" readOnly />
                  ) : (
                    <>
                      <select className="form-select" value={form.status} onChange={(e) => set("status", e.target.value)}>
                        <option value="active" disabled={reactivationBlocked}>
                          Attivo
                        </option>
                        <option value="completed">Completato</option>
                        <option value="expired">Scaduto</option>
                      </select>
                      <div className="form-text">L&apos;annullamento è disponibile solo dal dettaglio vendita.</div>
                    </>
                  )}
                </div>
                <div className="col-12">
                  <label className="form-label">Note</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    placeholder="Note interne / accordi"
                    value={form.notes}
                    onChange={(e) => set("notes", e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-3 d-flex gap-2">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
                <a className="btn btn-outline-secondary" href={listUrl()}>
                  Annulla
                </a>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
