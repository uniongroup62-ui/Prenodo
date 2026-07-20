"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP staff list page (app/pages/staff.php), fed by the
// existing DB-backed /api/manage/resources?section=staff. Reproduces the
// original Bootstrap markup (bs-page-header, filter card, operator table,
// create/delete modals) verbatim, using the legacy Bootstrap classes.

type StaffLocation = {
  id: number;
  name: string;
  isActive: boolean;
};

type StaffMember = {
  id: number;
  fullName: string;
  phone: string;
  email: string;
  role: "admin" | "staff" | "altro";
  isActive: boolean;
  color: string;
  photoPath: string;
  locationIds: number[];
  locations: StaffLocation[];
  serviceLinks: Array<{ serviceId: number; serviceName: string; isActive: boolean }>;
  isOwner: boolean;
};

// Role -> { label, Bootstrap badge class } shown in the "Ruolo" column.
const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  admin: { label: "Admin", cls: "text-bg-primary" },
  staff: { label: "Staff", cls: "text-bg-info" },
  altro: { label: "Personalizzato", cls: "text-bg-secondary" },
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function roleBadge(role: string): { label: string; cls: string } {
  return ROLE_BADGES[role] ?? { label: role || "Staff", cls: "text-bg-secondary" };
}

function avatarLetter(name: string): string {
  const trimmed = (name || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "O";
}

type StaffQuery = { msg?: string; err?: string; q?: string; role?: string; status?: string; all_locations?: string };
type StaffBlockPopup = { title?: string; operator_name?: string; message?: string; services?: Array<{ service_id: number; service_name: string; service_active: number }> };

export function StaffContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: StaffQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Filtri dal querystring come il form GET legacy (q / role / status).
  const appliedQ = String(initialQuery?.q ?? "");
  const appliedRole = ["admin", "staff", "altro"].includes(String(initialQuery?.role ?? "")) ? String(initialQuery?.role) : "";
  const appliedStatus = ["active", "inactive"].includes(String(initialQuery?.status ?? "")) ? String(initialQuery?.status) : "";
  // "Tutte le sedi" (staff.php all_locations): default = filtro sede corrente lato server.
  const appliedAllLoc = ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").toLowerCase());
  const [q, setQ] = useState(appliedQ);
  const [role, setRole] = useState(appliedRole);
  const [status, setStatus] = useState(appliedStatus);
  const [allLoc, setAllLoc] = useState(appliedAllLoc);
  const applied = { q: appliedQ, role: appliedRole, status: appliedStatus };

  // Popup blocco eliminazione (staff.js showStaffDeleteBlockPopup).
  const [blockPopup, setBlockPopup] = useState<StaffBlockPopup | null>(null);
  const [blockOpenList, setBlockOpenList] = useState(false);

  function filtersQuery(): URLSearchParams {
    const usp = new URLSearchParams();
    if (appliedQ) usp.set("q", appliedQ);
    if (appliedRole) usp.set("role", appliedRole);
    if (appliedStatus) usp.set("status", appliedStatus);
    if (appliedAllLoc) usp.set("all_locations", "1");
    return usp;
  }

  // 'Tutte le sedi' visibile SOLO con piu di una sede (staff.php 498:
  // $staffShowAllLocationsFilter = count($staffLocations) > 1).
  const [locationsCount, setLocationsCount] = useState(0);

  const load = useCallback(() => {
    fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=staff${appliedAllLoc ? "&all_locations=1" : ""}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setStaff(Array.isArray(j.staff) ? j.staff : []);
        setLocationsCount(Array.isArray(j.locations) ? j.locations.length : 0);
      })
      .catch(() => setStaff([]))
      .finally(() => setLoading(false));
  }, [slug, appliedAllLoc]);

  useEffect(() => {
    load();
  }, [load]);

  // Client-side filtering (the API exposes no filter params for this list).
  const filtered = useMemo(() => {
    return staff.filter((s) => {
      if (applied.q) {
        const needle = applied.q.toLowerCase();
        const haystack = `${s.fullName} ${s.email} ${s.phone}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (applied.role && s.role !== applied.role) return false;
      if (applied.status === "active" && !s.isActive) return false;
      if (applied.status === "inactive" && s.isActive) return false;
      return true;
    });
  }, [staff, applied]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`staff${suffix}`.replace("&", "?")}`;
  }

  // Flash legacy dai redirect: msg VERDE (staff.php 1129-1137, salvo i
  // duplicati timeoff che diventano danger), err rosso.
  const [msg, setMsg] = useState(() => String(initialQuery?.msg ?? ""));
  const [err, setErr] = useState(() => String(initialQuery?.err ?? ""));
  const msgIsDanger = msg.startsWith("Periodo già presente") || msg.startsWith("Esiste già un periodo per l'intera giornata");

  function redirectFlash(params: Record<string, string>) {
    const usp = filtersQuery();
    for (const [k, v] of Object.entries(params)) if (v !== "") usp.set(k, v);
    window.location.assign(`/${encodeURIComponent(slug)}/staff${usp.size > 0 ? `?${usp.toString()}` : ""}`);
  }

  // Eliminazione operatore (staff.js confirmStaffDelete + staff.php 626-703):
  // servizi collegati -> popup client; poi confirm verbatim e guardie server.
  async function removeStaff(s: StaffMember) {
    if ((s.serviceLinks ?? []).length > 0) {
      setBlockPopup({
        operator_name: s.fullName,
        services: (s.serviceLinks ?? []).map((link) => ({ service_id: link.serviceId, service_name: link.serviceName, service_active: link.isActive ? 1 : 0 })),
        message: "L'operatore non può essere eliminato perché è associato ai servizi elencati. Rimuovi prima l'operatore dai servizi collegati.",
      });
      setBlockOpenList(false);
      return;
    }
    if (!window.confirm("Eliminare questo operatore?")) return;
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "staff_delete", id: String(s.id) }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && j.ok !== false) {
        redirectFlash({ msg: String(j.msg ?? "Operatore eliminato") });
        return;
      }
      if (j.popup) {
        setBlockPopup(j.popup as StaffBlockPopup);
        setBlockOpenList(false);
      }
      // flashKind 'msg' = alert verde come i redirect &msg= del legacy.
      if (String(j.flashKind ?? "") === "msg") setMsg(String(j.error ?? ""));
      else setErr(String(j.error ?? "Errore eliminazione operatore."));
      window.scrollTo(0, 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Errore eliminazione operatore.");
    }
  }

  return (
    <div className="container-fluid">
      {msg ? <div className={`alert alert-${msgIsDanger ? "danger" : "success"}`}>{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Staff</h1>
            <InfoBox>
              <p>
                L&apos;operatore e il suo account di accesso sono collegati <strong>tramite l&apos;email</strong>: usa la
                stessa email per agganciare l&apos;account. Cambiandola l&apos;account viene aggiornato; svuotandola
                l&apos;accesso viene rimosso.
              </p>
              <ul>
                <li>Il <strong>titolare</strong> è protetto: sempre attivo, ruolo Admin, non eliminabile.</li>
                <li>
                  L&apos;eliminazione è consentita solo senza collegamenti attivi: prenotazioni, servizi assegnati o
                  storico commissioni la bloccano (il popup mostra il dettaglio).
                </li>
                <li>
                  Le <strong>sedi assegnate</strong> stabiliscono dove l&apos;operatore lavora e cosa vede con i filtri
                  sede.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Gestisci operatori, ruoli e sedi abilitate.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-primary" href={href("&action=new")}>
            <i className="bi bi-plus-lg me-1" />
            Nuovo operatore
          </a>
        </div>
      </div>

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            // Come il form GET legacy: filtri nel querystring.
            const usp = new URLSearchParams();
            if (q.trim()) usp.set("q", q.trim());
            if (role) usp.set("role", role);
            if (status) usp.set("status", status);
            if (allLoc) usp.set("all_locations", "1");
            window.location.assign(`/${encodeURIComponent(slug)}/staff${usp.size > 0 ? `?${usp.toString()}` : ""}`);
          }}
        >
          <div className="col-xl-4 col-lg-4 col-md-6">
            <label className="form-label">Cerca operatore</label>
            <input
              className="form-control"
              type="text"
              name="q"
              value={q}
              placeholder="Nome, email o telefono"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="col-xl-2 col-lg-3 col-md-6">
            <label className="form-label">Ruolo</label>
            <select className="form-select" name="role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Tutti</option>
              <option value="admin">Admin</option>
              <option value="staff">Staff</option>
              <option value="altro">Personalizzato</option>
            </select>
          </div>
          <div className="col-xl-2 col-lg-3 col-md-6">
            <label className="form-label">Stato</label>
            <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tutti</option>
              <option value="active">Attivi</option>
              <option value="inactive">Non attivi</option>
            </select>
          </div>
          {/* Restyle filtri 2026-07-15 (pattern unificato): switch al posto del
              checkbox (SOLO stile: si applica comunque al submit come il form GET
              legacy), Filtra pieno a larghezza naturale, Reset visibile solo con
              filtri attivi. */}
          {locationsCount > 1 ? (
            <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail">
              <div className="form-check form-switch mb-0">
                <input className="form-check-input" type="checkbox" role="switch" id="staffAllLocations" checked={allLoc} onChange={(e) => setAllLoc(e.target.checked)} />
                <label className="form-check-label" htmlFor="staffAllLocations">Tutte le sedi</label>
              </div>
            </div>
          ) : null}
          {/* col-auto: il bottone si accoda ai campi (leggero distacco ms-lg-2)
              invece di galleggiare in una colonna fissa di griglia. */}
          <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail gap-2 ms-lg-2">
            <button className="btn btn-primary" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            {appliedQ || appliedRole || appliedStatus || appliedAllLoc ? (
              <a className="btn btn-link text-secondary text-decoration-none px-2" href={href("")}>
                Reset
              </a>
            ) : null}
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header bg-transparent py-2">
          <span className="text-muted small">
            {loading ? "Caricamento…" : filtered.length === 1 ? "1 operatore" : `${filtered.length} operatori`}
            {!loading && (appliedQ || appliedRole || appliedStatus || appliedAllLoc) ? " · filtri attivi" : ""}
          </span>
        </div>
        <div className="table-responsive">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th>Operatore</th>
                <th>Ruolo</th>
                <th>Contatti</th>
                <th>Sedi</th>
                <th>Stato</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted small p-3">
                    {loading ? "Caricamento…" : "Nessun operatore."}
                  </td>
                </tr>
              ) : (
                filtered.map((s) => {
                  const badge = roleBadge(s.role);
                  return (
                    <tr key={s.id}>
                      <td className="fw-semibold">
                        <div className="d-flex align-items-center gap-2">
                          <span className="staff-list-avatar">
                            {s.photoPath ? (
                              <img src={s.photoPath} alt="" />
                            ) : (
                              <span>{avatarLetter(s.fullName)}</span>
                            )}
                          </span>
                          <span>{s.fullName}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="text-muted">
                        {s.phone ? s.phone : "—"} <br />
                        {s.email ? s.email : "—"}
                      </td>
                      <td className="text-muted">
                        {/* Badge 'Tutte' sui locationIds REALI: per lo staff senza
                            sedi assegnate s.locations è il fallback tutte-le-sedi. */}
                        {s.locationIds.length === 0 ? (
                          <span className="badge text-bg-light border">Tutte</span>
                        ) : (
                          <>
                            {s.locations.slice(0, 3).map((loc) => (
                              <span className="badge text-bg-light border me-1" key={loc.id}>
                                {loc.name}
                              </span>
                            ))}
                            {s.locations.length > 3 ? <span className="badge text-bg-light border">+{s.locations.length - 3}</span> : null}
                          </>
                        )}
                      </td>
                      <td>
                        {s.isActive ? (
                          <span className="badge text-bg-success">Attivo</span>
                        ) : (
                          <span className="badge text-bg-secondary">Non attivo</span>
                        )}
                      </td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${s.id}${filtersQuery().size ? `&${filtersQuery().toString()}` : ""}`)}>
                          Modifica
                        </a>{" "}
                        {s.isOwner ? (
                          <span className="badge text-bg-light border ms-2">Protetto</span>
                        ) : (
                          <button
                            className="btn btn-sm btn-outline-danger"
                            type="button"
                            onClick={() => removeStaff(s)}
                          >
                            Elimina
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODALE blocco eliminazione (#staffDeleteBlockModal, staff.js 250-330). */}
      {blockPopup ? (
        <>
          <div className="modal fade show d-block" id="staffDeleteBlockModal" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <div className="text-muted small">Operatori</div>
                    <h5 className="modal-title fw-bold m-0" id="staffDeleteBlockModalTitle">
                      {blockPopup.title || "Impossibile eliminare l'operatore"}
                    </h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setBlockPopup(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning small mb-3" id="staffDeleteBlockModalMessage" style={{ whiteSpace: "pre-line" }}>
                    {(blockPopup.message || "L'operatore non può essere eliminato perché è associato ai servizi elencati. Rimuovi prima l'operatore dai servizi collegati.")
                      + (blockPopup.operator_name ? `\nOperatore: ${blockPopup.operator_name}` : "")}
                  </div>
                  <div id="staffDeleteBlockServiceList">
                    {(blockPopup.services ?? []).length === 0 ? (
                      <div className="text-muted small">Nessun servizio rilevato.</div>
                    ) : (
                      <div className="accordion" id="staffDeleteBlockServiceAccordion">
                        <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                          <h3 className="accordion-header">
                            <button
                              className={`accordion-button ${blockOpenList ? "" : "collapsed"} bg-white shadow-none py-2`}
                              type="button"
                              onClick={() => setBlockOpenList((v) => !v)}
                            >
                              <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                                <span className="fw-semibold">Servizi associati</span>
                                <span className="badge rounded-pill text-bg-info">{(blockPopup.services ?? []).length}</span>
                              </span>
                            </button>
                          </h3>
                          <div className={`accordion-collapse collapse ${blockOpenList ? "show" : ""}`}>
                            <div className="accordion-body py-2">
                              <div className="list-group list-group-flush">
                                {(blockPopup.services ?? []).map((svc, i) => (
                                  <div className="list-group-item px-0" key={`${svc.service_id}-${i}`}>
                                    {Number(svc.service_active ?? 1) === 1 ? svc.service_name : `${svc.service_name} — non attivo`}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setBlockPopup(null)}>
                    Chiudi
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
