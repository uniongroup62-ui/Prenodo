"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  staff: { label: "Staff", cls: "text-bg-secondary" },
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

export function StaffContent() {
  const slug = tenantSlug();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter form state (legacy: GET form with q / role / status).
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [applied, setApplied] = useState({ q: "", role: "", status: "" });

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=staff`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setStaff(Array.isArray(j.staff) ? j.staff : []))
      .catch(() => setStaff([]))
      .finally(() => setLoading(false));
  }, [slug]);

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

  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // Messaggio post-redirect dal form (staff.php redirect ?msg=Operatore salvato).
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("msg");
    if (m) setMsg(m);
  }, []);

  // Eliminazione operatore con i vincoli/messaggi legacy dal server
  // (prenotazioni storiche, servizi associati, storico commissioni, owner).
  async function removeStaff(s: StaffMember) {
    if (!window.confirm(`Eliminare l'operatore "${s.fullName}"?`)) return;
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "staff_delete", id: String(s.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Errore eliminazione operatore."));
      setMsg("Operatore eliminato");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Errore eliminazione operatore.");
    }
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Staff</h1>
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
          method="get"
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q, role, status });
          }}
        >
          <input type="hidden" name="page" value="staff" />
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
          <div className="col-xl-2 col-lg-3 col-md-6 d-flex gap-2">
            <button className="btn btn-outline-primary app-filter-submit" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            <a
              className="btn btn-outline-secondary app-filter-reset"
              href={href("")}
              onClick={(e) => {
                e.preventDefault();
                setQ("");
                setRole("");
                setStatus("");
                setApplied({ q: "", role: "", status: "" });
              }}
            >
              Reset
            </a>
          </div>
        </form>
      </div>

      <div className="card">
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
                        {s.email}
                      </td>
                      <td className="text-muted">
                        {s.locations.length === 0
                          ? "—"
                          : s.locations.map((loc) => (
                              <span className="badge text-bg-light border me-1" key={loc.id}>
                                {loc.name}
                              </span>
                            ))}
                      </td>
                      <td>
                        {s.isActive ? (
                          <span className="badge text-bg-success">Attivo</span>
                        ) : (
                          <span className="badge text-bg-secondary">Non attivo</span>
                        )}
                      </td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${s.id}`)}>
                          Modifica
                        </a>{" "}
                        <button
                          className="btn btn-sm btn-outline-danger"
                          type="button"
                          data-staff-name={s.fullName}
                          data-staff-delete="1"
                          onClick={() => removeStaff(s)}
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

      <div
        className="modal fade"
        id="staffDeleteBlockModal"
        tabIndex={-1}
        aria-hidden="true"
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="text-muted small">Operatori</div>
                <h5 className="modal-title fw-bold m-0" id="staffDeleteBlockModalTitle">
                  Impossibile eliminare l&apos;operatore
                </h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning small mb-3" id="staffDeleteBlockModalMessage" />
              <div id="staffDeleteBlockServiceList" />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Chiudi
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
