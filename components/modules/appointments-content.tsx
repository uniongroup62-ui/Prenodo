"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

// Pixel-faithful port of the PHP appointments list page (?page=appointments),
// fed by the existing DB-backed /api/manage/appointments?action=list.
//
// Faithful to the legacy markup: original Bootstrap classes + `bi bi-*` icons,
// the `appointments-page` wrapper, `appointments-filter-bar` filter form, the
// `appointments-list-card` toolbar (bulk-delete) + `appointments-table`, the
// status badges and the per-row Modifica/Elimina actions. Styling comes from
// /assets/css/pages/appointments.css (linked below, present under
// prenodo/public/assets/css/pages/).
//
// WIRED (live): the appointments table + status badges + the Dal/Al/Cerca
// filters (applied client-side over the fetched list). Slug is read from the
// pathname. Action links point at the legacy /{slug}/index.php?page=... routes.
//
// WIRED (live): the per-row "Modifica" action drives the GLOBAL quick-booking
// drawer in EDIT MODE. The button carries data-qb-edit="<id>"; the global drawer
// (quick-booking-drawer.tsx, mounted in the manage shell on every page) has a
// delegated [data-qb-edit] handler that loads the appointment via GET action=get
// and PREFILLS the full drawer (client, services, per-service operator/cabin,
// date/time, status, notes). SAVE re-submits action=save WITH that id, which the
// route routes to updateDbAppointment (faithful to the legacy
// window.qbOpenEditAppointment). The previous minimal local edit drawer was removed.
//
// WIRED (live): DELETE — the per-row "Elimina" POSTs action=delete (JSON, confirm)
// and the header "select all" + per-row checkboxes drive the selection that the
// "Elimina selezionati" button POSTs as action=bulk_delete (confirm). The route
// restores the redeems the appointment consumed (deleteDbAppointment) and returns the
// refreshed list; the component re-fetches after each delete. Legacy `_csrf` hidden
// inputs are dropped; the per-row href stays as the legacy ?action=delete URL but is
// intercepted (preventDefault) so it never navigates.
//
// FAITHFUL-BUT-STATIC: the new-appointment quick-booking flow is reproduced as inert
// markup (no submit/JS handlers) — handled by the global "Nuova prenotazione" drawer.
//
// DATA NOTE: the Next API returns { id, date, locationId, time, client, service,
// operator, room, price, status, publicCode, services[] }. The "Codice prenotazione"
// column shows the real appointments.public_code when present (fallback `#{id}`), and
// a multi-service appointment renders as a parent row + collapsible per-service child
// rows (legacy ms-parent / ms-children). The date cell still shows the start time only
// (the API does not return an end time).

type AppointmentServiceLine = {
  serviceId: number;
  name: string;
  price: string;
  // Segment id (multi-service): drives the ↑/↓ reorder (action=swap_segment).
  segmentId?: number | null;
};

type Appointment = {
  id: number;
  date?: string;
  locationId?: number | null;
  time: string;
  client: string;
  service: string;
  operator: string;
  room: string;
  price: string;
  status: string;
  // Real booking code (appointments.public_code); null -> fall back to #id.
  publicCode?: string | null;
  // Ordered service list for the multi-service parent/child rendering. A single-service
  // appointment carries one entry; absent/empty -> render the single `service` string.
  services?: AppointmentServiceLine[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function monthRange(now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = `${y}-${pad(m + 1)}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const last = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  return { from: first, to: last };
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// Map the UI status label returned by the API to the legacy badge variant.
function statusBadge(status: string): { className: string; label: string } {
  const key = status.trim().toLowerCase();
  if (key === "completato" || key === "done" || key === "completed") {
    return { className: "appointments-status-badge--done", label: status };
  }
  if (key === "in attesa" || key === "pending" || key === "waiting") {
    return { className: "appointments-status-badge--pending", label: status };
  }
  if (key === "annullato" || key === "canceled" || key === "cancelled") {
    return { className: "appointments-status-badge--canceled", label: status };
  }
  if (key === "no_show" || key === "no show") {
    return { className: "appointments-status-badge--no-show", label: status };
  }
  // Confermato / scheduled / anything else.
  return { className: "appointments-status-badge--scheduled", label: status };
}

export function AppointmentsContent() {
  const slug = tenantSlug();
  const defaults = useMemo(() => monthRange(), []);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter state (kept working client-side over the loaded appointments).
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [q, setQ] = useState("");

  // Bulk-delete state: the set of selected appointment ids (drives the per-row +
  // "select all" checkboxes and the "Elimina selezionati" button), and a deleting
  // flag that disables the delete controls while a request is in flight.
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);

  // Multi-service grouping: the set of appointment ids whose child service rows are
  // expanded (legacy ms-children Bootstrap collapse, driven inline since the Bootstrap
  // JS bundle is not loaded here).
  const [expandedRows, setExpandedRows] = useState<number[]>([]);
  const toggleExpanded = useCallback((id: number) => {
    setExpandedRows((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}&action=list`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setAppointments(Array.isArray(j.appointments) ? j.appointments : []))
      .catch(() => setAppointments([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // ↑/↓ segment reorder (legacy handleSegmentMove -> action=swap_segment): swap
  // the adjacent segments' position + time windows, then reload from the server
  // (the legacy reloads the page; we re-fetch). Errors surface via alert.
  const [swapBusy, setSwapBusy] = useState(false);
  const swapSegment = useCallback(async (appointmentId: number, segmentId: number, direction: "up" | "down") => {
    if (swapBusy) return;
    setSwapBusy(true);
    try {
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "swap_segment", id: appointmentId, segment_id: segmentId, direction }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        if (typeof window !== "undefined") window.alert(String(data?.error || "Operazione non riuscita"));
        return;
      }
      load();
    } catch {
      if (typeof window !== "undefined") window.alert("Errore di rete durante l'aggiornamento.");
    } finally {
      setSwapBusy(false);
    }
  }, [slug, swapBusy, load]);

  // POST a delete (single id) / bulk_delete (CSV ids) to the manage route, then
  // refresh the list. The route restores the consumed redeems server-side
  // (deleteDbAppointment) and returns the refreshed list; we re-fetch via load() so
  // the table + selection reflect the server truth.
  const runDelete = useCallback(
    async (ids: number[]) => {
      if (!ids.length || deleting) return;
      setDeleting(true);
      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(
            ids.length === 1
              ? { action: "delete", id: ids[0] }
              : { action: "bulk_delete", ids: ids.join(",") },
          ),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false || json?.error) {
          window.alert(String(json?.error || "Errore durante l'eliminazione dell'appuntamento."));
          return;
        }
        // Drop the deleted ids from the selection, then reload from the server.
        setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
        load();
      } catch {
        window.alert("Errore di rete durante l'eliminazione.");
      } finally {
        setDeleting(false);
      }
    },
    [deleting, load, slug],
  );

  // Per-row "Elimina": confirm then delete the single appointment.
  const deleteOne = useCallback(
    (id: number) => {
      if (!window.confirm("Eliminare questo appuntamento?")) return;
      void runDelete([id]);
    },
    [runDelete],
  );

  // "Elimina selezionati": confirm then bulk-delete the selected appointments.
  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    if (!window.confirm(`Eliminare ${selectedIds.length} appuntamenti selezionati?`)) return;
    void runDelete(selectedIds);
  }, [runDelete, selectedIds]);

  // Toggle one row's checkbox in the selection set.
  const toggleSelected = useCallback((id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return appointments.filter((appt) => {
      const day = appt.date ?? "";
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;
      if (term) {
        const code = appt.publicCode ? String(appt.publicCode) : `#${appt.id}`;
        const haystack = `${appt.client} ${code} #${appt.id}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [appointments, from, to, q]);

  // Selection helpers over the CURRENTLY VISIBLE (filtered) rows: the "select all"
  // header checkbox checks/clears these ids, and reflects "all visible selected".
  const visibleIds = useMemo(() => filtered.map((appt) => appt.id), [filtered]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) =>
        checked ? Array.from(new Set([...prev, ...visibleIds])) : prev.filter((id) => !visibleIds.includes(id)),
      );
    },
    [visibleIds],
  );

  function pageHref(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`appointments${suffix}`.replace("&", "?")}`;
  }

  const resetHref = pageHref("");

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/appointments.css" />

      <div className="bs-page-header appointments-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Agenda</div>
          <h1 className="bs-page-title">Lista appuntamenti</h1>
          <div className="bs-page-subtitle">Gestisci prenotazioni, stati e passaggio rapido al calendario.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/calendar`}>
            <i className="bi bi-calendar3 me-1"></i>Calendario
          </a>
        </div>
      </div>

      <div className="appointments-page">
        <div className="appointments-filter-bar">
          <form
            className="appointments-filter-form"
            method="get"
            onSubmit={(e) => {
              e.preventDefault();
              load();
            }}
          >
            <input type="hidden" name="page" value="appointments" />
            <div className="appointments-filter-field">
              <label className="form-label">Dal</label>
              <input
                className="form-control"
                type="date"
                name="from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="appointments-filter-field">
              <label className="form-label">Al</label>
              <input
                className="form-control"
                type="date"
                name="to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="appointments-filter-field appointments-filter-field--search">
              <label className="form-label">Cerca</label>
              <input
                className="form-control"
                type="text"
                name="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Cliente o codice prenotazione"
              />
            </div>
            <div className="appointments-filter-actions">
              <button className="btn btn-outline-primary appointments-filter-submit app-filter-submit" type="submit">
                <i className="bi bi-search me-1"></i>Filtra
              </button>
              <a
                className="btn btn-outline-secondary appointments-filter-reset app-filter-reset"
                href={resetHref}
                onClick={(e) => {
                  e.preventDefault();
                  setFrom(defaults.from);
                  setTo(defaults.to);
                  setQ("");
                }}
              >
                Reset
              </a>
            </div>
          </form>
        </div>

        <div className="appointments-list-card">
          <div className="appointments-list-toolbar">
            <div className="appointments-selection-info" id="bulkSelInfo">
              {selectedIds.length} selezionati
            </div>
            {/* Bulk-delete: the selected ids drive #bulkDeleteIds (kept for markup
                parity); the button POSTs action=bulk_delete (confirm) via deleteSelected. */}
            <form
              method="post"
              action={pageHref("&action=bulk_delete")}
              className="appointments-bulk-actions"
              onSubmit={(e) => {
                e.preventDefault();
                deleteSelected();
              }}
            >
              <input type="hidden" name="ids" id="bulkDeleteIds" value={selectedIds.join(",")} />
              <button
                className="btn btn-outline-danger appointments-bulk-delete"
                type="submit"
                id="bulkDeleteBtn"
                disabled={selectedIds.length === 0 || deleting}
              >
                <i className="bi bi-trash me-1"></i>Elimina selezionati
              </button>
            </form>
          </div>
          <div className="table-responsive appointments-table-wrap">
            <table className="table appointments-table mb-0" id="appointmentsTable">
              <thead>
                <tr>
                  <th className="appointments-select-col">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="apptSelectAll"
                      aria-label="Seleziona tutti"
                      checked={allVisibleSelected}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                  </th>
                  <th>Data</th>
                  <th>Cliente</th>
                  <th>Codice prenotazione</th>
                  <th>Servizio</th>
                  <th>Operatore</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted small p-3">
                      {loading ? "Caricamento…" : "Nessun appuntamento."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((appt) => {
                    const badge = statusBadge(appt.status);
                    // Real booking code when present, else the synthesized #id.
                    const code = appt.publicCode ? String(appt.publicCode) : `#${appt.id}`;
                    // MULTI-SERVICE: a parent row + one collapsible child row per service
                    // (legacy ms-parent / ms-children). Only group when there is >1 service.
                    const lines = appt.services && appt.services.length > 0 ? appt.services : [{ serviceId: 0, name: appt.service, price: appt.price }];
                    const isMulti = lines.length > 1;
                    const collapseId = `apptMs${appt.id}`;
                    const expanded = expandedRows.includes(appt.id);
                    return (
                      <Fragment key={appt.id}>
                        <tr className={isMulti ? "ms-parent" : undefined}>
                          <td>
                            <input
                              className="form-check-input appt-select"
                              type="checkbox"
                              value={appt.id}
                              aria-label="Seleziona appuntamento"
                              title=""
                              checked={selectedIds.includes(appt.id)}
                              onChange={(e) => toggleSelected(appt.id, e.target.checked)}
                            />
                          </td>
                          <td>
                            {fmtDate(appt.date)} {appt.time}
                          </td>
                          <td className="fw-semibold">{appt.client}</td>
                          <td className="text-muted">
                            <code>{code}</code>
                          </td>
                          <td className="text-muted">
                            {isMulti ? (
                              // Parent service cell: a collapse toggle showing the count.
                              // data-bs-* kept for legacy fidelity; the inline expandedRows
                              // state actually drives the child rows (no Bootstrap JS here).
                              <a
                                className="appointments-ms-toggle"
                                href={`#${collapseId}`}
                                role="button"
                                data-bs-toggle="collapse"
                                data-bs-target={`#${collapseId}`}
                                aria-expanded={expanded}
                                aria-controls={collapseId}
                                onClick={(e) => {
                                  e.preventDefault();
                                  toggleExpanded(appt.id);
                                }}
                              >
                                <i className={`bi ${expanded ? "bi-chevron-down" : "bi-chevron-right"} me-1`}></i>
                                {lines.length} servizi
                              </a>
                            ) : (
                              lines[0]?.name ?? appt.service
                            )}
                          </td>
                          <td className="text-muted">{appt.operator}</td>
                          <td>
                            <span className={`appointments-status-badge ${badge.className}`}>{badge.label}</span>
                          </td>
                          <td className="text-end">
                            {/* "Vendita da appuntamento" (Incassa): open the POS pre-loaded
                                with this appointment's client + services. The POS reads the
                                ?appointment=<id> query param, fetches action=appointment_cart
                                and seeds the cart; concluding the sale marks the appointment
                                'done' (appointment_id threaded to checkoutManageSale). */}
                            <a
                              className="btn btn-sm btn-outline-primary"
                              href={`/${encodeURIComponent(slug)}/pos?appointment=${appt.id}`}
                              title="Incassa l'appuntamento in cassa"
                            >
                              <i className="bi bi-cash-coin me-1"></i>Incassa
                            </a>{" "}
                            {/* Edit: drives the GLOBAL quick-booking drawer in EDIT MODE.
                                The drawer (mounted in the manage shell on every page)
                                has a delegated [data-qb-edit] handler that loads the
                                appointment via GET action=get and prefills the FULL
                                drawer (client, services, per-service operator/cabin,
                                date/time, status, notes); SAVE re-submits action=save
                                WITH this id -> updateDbAppointment. No local handler. */}
                            <a
                              className="btn btn-sm btn-outline-secondary"
                              href="#"
                              data-qb-edit={appt.id}
                            >
                              Modifica
                            </a>{" "}
                            {/* Per-row delete: confirm + POST action=delete, then refresh. */}
                            <a
                              className="btn btn-sm btn-outline-danger"
                              href={pageHref(`&action=delete&id=${appt.id}`)}
                              data-confirm="Eliminare questo appuntamento?"
                              onClick={(e) => {
                                e.preventDefault();
                                deleteOne(appt.id);
                              }}
                            >
                              Elimina
                            </a>
                          </td>
                        </tr>
                        {isMulti &&
                          lines.map((line, index) => (
                            <tr
                              key={`${appt.id}-svc-${line.serviceId || index}`}
                              id={collapseId}
                              className={`ms-children collapse${expanded ? " show" : ""}`}
                              style={expanded ? undefined : { display: "none" }}
                            >
                              <td></td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td className="text-muted ps-4">{line.name}</td>
                              <td className="text-muted">{line.price}</td>
                              <td>
                                {/* ↑/↓ segment reorder (legacy .ms-seg-move -> action=swap_segment):
                                    swaps position + time windows, staff/cabin re-validated. */}
                                {line.segmentId ? (
                                  <div className="btn-group btn-group-sm" role="group" aria-label="Riordina servizio">
                                    <button
                                      type="button"
                                      className="btn btn-outline-secondary ms-seg-move"
                                      title="Sposta prima"
                                      disabled={swapBusy || index === 0}
                                      onClick={() => void swapSegment(appt.id, line.segmentId as number, "up")}
                                    >
                                      <i className="bi bi-arrow-up" />
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-outline-secondary ms-seg-move"
                                      title="Sposta dopo"
                                      disabled={swapBusy || index === lines.length - 1}
                                      onClick={() => void swapSegment(appt.id, line.segmentId as number, "down")}
                                    >
                                      <i className="bi bi-arrow-down" />
                                    </button>
                                  </div>
                                ) : null}
                              </td>
                              <td></td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
