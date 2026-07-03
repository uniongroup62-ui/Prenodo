"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Pixel-faithful port of the PHP "Pianifica appuntamenti" page
// (app/pages/appointments_plan.php, ?page=appointments_plan).
//
// The original markup is a planner form (left column) plus a preview panel
// (right column) and a "Trova cliente" modal. A page script normally fills the
// services multiselect, the staff-per-service controls and the client search.
// Here we reproduce the markup VERBATIM (original Bootstrap classes) and drive
// the dynamic bits from React state, populating lists from /api/manage/services
// (services + staff + cabins) and /api/manage/clients (client search).

type Service = {
  id: number;
  name: string;
  durationMin?: number;
  priceValue?: number;
  categoryId?: number;
  categoryName?: string;
  staffIds?: number[];
};

type Staff = {
  id: number;
  fullName?: string;
  name?: string;
};

type ServicesData = {
  services?: Service[];
  staff?: Staff[];
};

type Client = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
};

type SelectedClient = {
  id: number;
  name: string;
  email: string;
  phone: string;
};

// Preview / create response shapes (mirrors lib/manage-planner.ts).
type PreviewRow = {
  date: string;
  time: string | null;
  start: string | null;
  end: string | null;
  operator: string | null;
  ok: boolean;
  reason: string | null;
};

type PreviewData = {
  dates: PreviewRow[];
  totalDuration: number;
  totalPrice: number;
  services: Array<{ id: number; name: string; durationMin: number; price: number }>;
  countOk: number;
  countSkip: number;
};

type CreateData = {
  created: number;
  skipped: number;
  details: Array<{ date: string; ok: boolean; appointmentId?: number; reason?: string }>;
};

function fmtDateIt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function fmtMoney(value: number): string {
  return (Number(value) || 0).toFixed(2).replace(".", ",");
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Lun." },
  { value: 2, label: "Mar." },
  { value: 3, label: "Mer." },
  { value: 4, label: "Gio." },
  { value: 5, label: "Ven." },
  { value: 6, label: "Sab." },
  { value: 0, label: "Dom." },
];

const RECURRENCES: Array<{ id: string; value: string; label: string }> = [
  { id: "recweekly", value: "weekly", label: "Ogni settimana" },
  { id: "recweekly2", value: "weekly2", label: "Ogni 2 settimane" },
  { id: "recweekly3", value: "weekly3", label: "Ogni 3 settimane" },
  { id: "recmonthly", value: "monthly", label: "Ogni mese" },
];

function staffName(s: Staff): string {
  return String(s.fullName ?? s.name ?? "");
}

export function AppointmentsPlanContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);

  // Services multiselect state.
  const [msOpen, setMsOpen] = useState(false);
  const [serviceSearch, setServiceSearch] = useState("");
  const [selectedServiceIds, setSelectedServiceIds] = useState<number[]>([]);

  // Staff-per-service selection.
  const [staffPerService, setStaffPerService] = useState<Record<number, number>>({});

  // Form state.
  const [startDate, setStartDate] = useState(todayIso());
  const [repeat, setRepeat] = useState("1");
  const [recurrence, setRecurrence] = useState("weekly");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeFrom, setTimeFrom] = useState("09:00");
  const [timeTo, setTimeTo] = useState("18:00");

  // Preview / create state.
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<CreateData | null>(null);

  // Client section state.
  const [clientId, setClientId] = useState("");
  const [selectedClient, setSelectedClient] = useState<SelectedClient | null>(null);
  const [newFullName, setNewFullName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");

  // Find-client modal state.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResults, setFindResults] = useState<Client[]>([]);

  const msRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(`/api/manage/services?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ServicesData) => {
        setServices(Array.isArray(j.services) ? j.services : []);
        setStaff(Array.isArray(j.staff) ? j.staff : []);
      })
      .catch(() => {
        setServices([]);
        setStaff([]);
      });
  }, [slug]);

  // Close multiselect dropdown on outside click.
  useEffect(() => {
    if (!msOpen) return;
    function onDown(e: MouseEvent) {
      if (msRef.current && !msRef.current.contains(e.target as Node)) setMsOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [msOpen]);

  // Group services by category, preserving order, for the dropdown list.
  const serviceGroups = useMemo(() => {
    const groups: Array<{ groupId: number; title: string; items: Service[] }> = [];
    const index = new Map<number, number>();
    const needle = serviceSearch.trim().toLowerCase();
    for (const svc of services) {
      if (needle && !svc.name.toLowerCase().includes(needle)) continue;
      const gid = Number(svc.categoryId ?? 0);
      if (!index.has(gid)) {
        index.set(gid, groups.length);
        groups.push({ groupId: gid, title: String(svc.categoryName ?? ""), items: [] });
      }
      groups[index.get(gid) as number].items.push(svc);
    }
    return groups;
  }, [services, serviceSearch]);

  const selectedServices = useMemo(
    () => services.filter((s) => selectedServiceIds.includes(s.id)),
    [services, selectedServiceIds],
  );

  const toggleService = useCallback((id: number) => {
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  // For each selected service, build the eligible operator list.
  function staffForService(svc: Service): Staff[] {
    const ids = Array.isArray(svc.staffIds) ? svc.staffIds : [];
    if (ids.length === 0) return staff;
    return staff.filter((s) => ids.includes(s.id));
  }

  // Auto-select the only operator when a service has exactly one.
  useEffect(() => {
    setStaffPerService((prev) => {
      const next: Record<number, number> = {};
      for (const svc of selectedServices) {
        const eligible = staffForService(svc);
        if (prev[svc.id] && eligible.some((s) => s.id === prev[svc.id])) {
          next[svc.id] = prev[svc.id];
        } else if (eligible.length === 1) {
          next[svc.id] = eligible[0].id;
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServiceIds, staff]);

  // Client search inside the modal.
  useEffect(() => {
    if (!findOpen) return;
    const q = findQuery.trim();
    const handle = window.setTimeout(() => {
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(q)}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j) => setFindResults(Array.isArray(j.clients) ? j.clients : []))
        .catch(() => setFindResults([]));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [findOpen, findQuery, slug]);

  function pickClient(c: Client) {
    setClientId(String(c.id));
    setSelectedClient({
      id: c.id,
      name: c.name,
      email: c.email ?? "",
      phone: c.phone ?? "",
    });
    setFindOpen(false);
  }

  function clearSelectedClient(e: React.MouseEvent) {
    e.preventDefault();
    setClientId("");
    setSelectedClient(null);
  }

  function toggleWeekday(value: number) {
    setWeekdays((prev) => (prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value]));
  }

  // Build the shared planner request body. parseRequestBody flattens every value to
  // a string, so service_ids / weekdays go as comma-joined strings and the per-service
  // staff_map / cabin_map go as PRE-STRINGIFIED JSON (a plain object would become
  // "[object Object]"). The server's parsePlannerForm tolerates all of these shapes.
  const buildBody = useCallback(() => {
    const staffMap: Record<number, number> = {};
    for (const [sid, stid] of Object.entries(staffPerService)) {
      if (Number(stid) > 0) staffMap[Number(sid)] = Number(stid);
    }
    return {
      client_id: clientId || "0",
      new_full_name: newFullName,
      new_phone: newPhone,
      new_email: newEmail,
      service_ids: selectedServiceIds.join(","),
      repeat,
      staff_id: "0",
      staff_map: JSON.stringify(staffMap),
      recurrence,
      weekdays: weekdays.join(","),
      start_date: startDate,
      time_from: timeFrom,
      time_to: timeTo,
    };
  }, [
    clientId,
    newFullName,
    newPhone,
    newEmail,
    selectedServiceIds,
    repeat,
    staffPerService,
    recurrence,
    weekdays,
    startDate,
    timeFrom,
    timeTo,
  ]);

  async function submitPreview(e: React.FormEvent) {
    e.preventDefault();
    setPlanError(null);
    setCreateResult(null);
    setPreviewing(true);
    try {
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "plan_preview", ...buildBody() }),
      });
      const j = await res.json();
      if (!j.ok) {
        setPreview(null);
        setPlanError(String(j.error ?? "Errore anteprima."));
        return;
      }
      setPreview({
        dates: Array.isArray(j.dates) ? j.dates : [],
        totalDuration: Number(j.totalDuration ?? 0),
        totalPrice: Number(j.totalPrice ?? 0),
        services: Array.isArray(j.services) ? j.services : [],
        countOk: Number(j.countOk ?? 0),
        countSkip: Number(j.countSkip ?? 0),
      });
    } catch {
      setPreview(null);
      setPlanError("Errore di rete durante l'anteprima.");
    } finally {
      setPreviewing(false);
    }
  }

  async function submitCreate() {
    setPlanError(null);
    setCreating(true);
    try {
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "plan_create", ...buildBody() }),
      });
      const j = await res.json();
      if (!j.ok) {
        setPlanError(String(j.error ?? "Errore creazione."));
        return;
      }
      setCreateResult({
        created: Number(j.created ?? 0),
        skipped: Number(j.skipped ?? 0),
        details: Array.isArray(j.details) ? j.details : [],
      });
      // Clear the preview so the OK rows can't be created twice from the same panel.
      setPreview(null);
    } catch {
      setPlanError("Errore di rete durante la creazione.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Agenda</div>
          <h1 className="bs-page-title">Pianifica appuntamenti</h1>
          <div className="bs-page-subtitle">Crea appuntamenti ricorrenti per un cliente con controllo disponibilita.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/appointments`}>
              <i className="bi bi-list-task me-1" />
              Lista
            </a>
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/calendar`}>
              <i className="bi bi-calendar-week me-1" />
              Calendario
            </a>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-5">
          <div className="card p-4">
            <div className="h5 mb-3">Impostazioni</div>
            <form method="post" className="row g-3" onSubmit={submitPreview}>
              <input type="hidden" name="_step" value="preview" />

              <div className="col-12">
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <label className="form-label mb-0">Cliente</label>
                  <div className="d-flex gap-3 small">
                    <a
                      href="#"
                      id="planLinkNewClient"
                      className="text-decoration-none"
                      onClick={(e) => {
                        e.preventDefault();
                        clearSelectedClient(e);
                      }}
                    >
                      <i className="bi bi-plus-lg" /> Nuovo
                    </a>
                    <a
                      href="#"
                      id="planLinkFindClient"
                      className="text-decoration-none"
                      onClick={(e) => {
                        e.preventDefault();
                        setFindOpen(true);
                      }}
                    >
                      <i className="bi bi-search" /> Trova
                    </a>
                  </div>
                </div>

                <input type="hidden" name="client_id" id="plan_client_id" value={clientId} />

                <div
                  id="planSelectedClientBox"
                  className={`card p-2 mb-2${selectedClient ? "" : " d-none"}`}
                >
                  <div className="d-flex justify-content-between align-items-start">
                    <div>
                      <div className="fw-semibold" id="planSelName">{selectedClient?.name ?? ""}</div>
                      <div className="small text-muted">Email: <span id="planSelEmail">{selectedClient?.email ?? ""}</span></div>
                      <div className="small text-muted">Telefono: <span id="planSelPhone">{selectedClient?.phone ?? ""}</span></div>
                    </div>
                    <a
                      href="#"
                      id="planClearSelectedClient"
                      className="small text-decoration-none text-danger"
                      onClick={clearSelectedClient}
                    >
                      annulla
                    </a>
                  </div>
                </div>

                <div id="planNewClientBox" className={selectedClient ? "d-none" : ""}>
                  <div className="mb-2">
                    <label className="form-label">Nome e cognome</label>
                    <input
                      className="form-control"
                      name="new_full_name"
                      id="plan_new_full_name"
                      value={newFullName}
                      onChange={(e) => setNewFullName(e.target.value)}
                    />
                  </div>
                  <div className="row g-2">
                    <div className="col-6">
                      <label className="form-label">Telefono</label>
                      <input
                        className="form-control"
                        name="new_phone"
                        id="plan_new_phone"
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                      />
                    </div>
                    <div className="col-6">
                      <label className="form-label">Email</label>
                      <input
                        className="form-control"
                        type="email"
                        name="new_email"
                        id="plan_new_email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="form-text">Puoi cercare un cliente esistente oppure inserirne uno nuovo (nome obbligatorio).</div>
              </div>

              <div className="col-12">
                <label className="form-label">Servizi</label>

                <div className="qb-multiselect" id="planner_services_ms" ref={msRef}>
                  <div
                    className="qb-ms-control form-control"
                    id="planner_ms_control"
                    role="button"
                    tabIndex={0}
                    aria-haspopup="listbox"
                    aria-expanded={msOpen}
                    onClick={() => setMsOpen((o) => !o)}
                  >
                    <div className="qb-ms-pills" id="planner_ms_pills">
                      {selectedServices.map((svc) => (
                        <span className="qb-ms-pill badge text-bg-primary" key={svc.id}>
                          {svc.name}
                          <button
                            type="button"
                            className="btn-close btn-close-white ms-1"
                            aria-label="Rimuovi"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleService(svc.id);
                            }}
                          />
                        </span>
                      ))}
                    </div>
                    {selectedServices.length === 0 ? (
                      <div className="qb-ms-placeholder text-muted" id="planner_ms_placeholder">
                        Seleziona uno o più servizi…
                      </div>
                    ) : null}
                    <div className="qb-ms-caret"><i className="bi bi-chevron-down" /></div>
                  </div>

                  <div className="qb-ms-dropdown shadow-sm" id="planner_ms_dropdown" hidden={!msOpen}>
                    <div className="p-2 border-bottom">
                      <input
                        className="form-control"
                        id="planner_service_search"
                        type="text"
                        placeholder="Inizia a digitare per filtrare..."
                        value={serviceSearch}
                        onChange={(e) => setServiceSearch(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                    <div className="qb-ms-list" id="planner_ms_list" role="listbox">
                      {serviceGroups.map((group) => (
                        <div className="qb-ms-group" data-group={group.groupId} key={group.groupId}>
                          <div className="qb-ms-group-title">{group.title}</div>
                          {group.items.map((svc) => (
                            <label className="qb-ms-item" data-name={svc.name} key={svc.id}>
                              <input
                                className="form-check-input qb-ms-check me-2"
                                type="checkbox"
                                name="service_ids[]"
                                value={svc.id}
                                data-id={svc.id}
                                data-dur={svc.durationMin ?? ""}
                                data-price={svc.priceValue ?? ""}
                                data-name={svc.name}
                                checked={selectedServiceIds.includes(svc.id)}
                                onChange={() => toggleService(svc.id)}
                              />
                              <span className="qb-ms-item-name">{svc.name}</span>
                              <span className="qb-ms-item-meta text-muted small ms-1">
                                • {svc.durationMin ?? "—"} min
                              </span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="form-text">Seleziona i servizi dal menu: puoi cercare e scegliere più servizi.</div>
              </div>

              <div className="col-6">
                <label className="form-label">Ripeti per</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  className="form-control"
                  name="repeat"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
                <div className="form-text">Numero di cicli da pianificare (settimane/mesi). Se selezioni più giorni, in ogni ciclo verranno creati tutti i giorni selezionati.</div>
              </div>

              <div className="col-6">
                <label className="form-label">Operatori per servizio</label>
                <div id="plannerStaffPerService" className="border rounded p-2 bg-light">
                  {selectedServices.length === 0 ? (
                    <div className="text-muted small">Seleziona uno o più servizi per scegliere l&apos;operatore.</div>
                  ) : (
                    selectedServices.map((svc) => {
                      const eligible = staffForService(svc);
                      return (
                        <div className="mb-2" key={svc.id}>
                          <label className="form-label small mb-1">{svc.name}</label>
                          <select
                            className="form-select form-select-sm"
                            name={`staff_by_service[${svc.id}]`}
                            value={staffPerService[svc.id] ?? ""}
                            onChange={(e) =>
                              setStaffPerService((prev) => ({ ...prev, [svc.id]: Number(e.target.value) }))
                            }
                          >
                            <option value="">Seleziona operatore…</option>
                            {eligible.map((s) => (
                              <option value={s.id} key={s.id}>{staffName(s)}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="form-text">Per ogni servizio selezionato devi scegliere l&apos;operatore che lo gestisce. Se per un servizio esiste un solo operatore, verrà selezionato automaticamente.</div>
                <input type="hidden" name="staff_id" value="0" />
              </div>

              <div className="col-12">
                <label className="form-label">Giorni della settimana</label>
                <div className="d-flex flex-wrap gap-3">
                  {WEEKDAYS.map((d) => (
                    <div className="form-check" key={d.value}>
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id={`dow${d.value}`}
                        name="weekdays[]"
                        value={d.value}
                        checked={weekdays.includes(d.value)}
                        onChange={() => toggleWeekday(d.value)}
                      />
                      <label className="form-check-label" htmlFor={`dow${d.value}`}>{d.label}</label>
                    </div>
                  ))}
                </div>
                <div className="form-text">Se non selezioni nulla, verrà usato automaticamente il giorno della data iniziale.</div>
                <div className="form-text">Nota: &quot;Dal giorno&quot; è limitato al primo giorno selezionato (ordine Lun→Dom).</div>
              </div>

              <div className="col-12">
                <label className="form-label">Ricorrenza</label>
                <div className="d-flex flex-wrap gap-3">
                  {RECURRENCES.map((r) => (
                    <div className="form-check" key={r.id}>
                      <input
                        className="form-check-input"
                        type="radio"
                        name="recurrence"
                        id={r.id}
                        value={r.value}
                        checked={recurrence === r.value}
                        onChange={() => setRecurrence(r.value)}
                      />
                      <label className="form-check-label" htmlFor={r.id}>{r.label}</label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="col-6">
                <label className="form-label">Dal giorno</label>
                <input
                  type="date"
                  className="form-control"
                  id="plannerStartDate"
                  name="start_date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </div>

              <div className="col-3">
                <label className="form-label">Dalle ore</label>
                <input
                  type="time"
                  className="form-control"
                  id="plannerTimeFrom"
                  name="time_from"
                  value={timeFrom}
                  onChange={(e) => setTimeFrom(e.target.value)}
                  required
                />
              </div>

              <div className="col-3">
                <label className="form-label">Alle ore</label>
                <input
                  type="time"
                  className="form-control"
                  id="plannerTimeTo"
                  name="time_to"
                  value={timeTo}
                  onChange={(e) => setTimeTo(e.target.value)}
                  required
                />
              </div>

              <div className="col-12">
                <button className="btn btn-primary w-100" type="submit" disabled={previewing}>
                  <i className="bi bi-magic me-1" />
                  {previewing ? "Calcolo…" : "Anteprima"}
                </button>
                <div className="form-text">Se “Dalle ore” e “Alle ore” coincidono, l’orario è fisso. Altrimenti viene scelto il primo slot libero nella finestra.</div>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-7">
          <div className="card p-4">
            <div className="h5 mb-1">Anteprima</div>
            <div className="text-muted mb-3">Controllo disponibilità e riepilogo prima della creazione.</div>

            {planError ? <div className="alert alert-danger">{planError}</div> : null}

            {createResult ? (
              <div className="alert alert-success">
                Pianificazione completata: creati <strong>{createResult.created}</strong> appuntamenti
                {createResult.skipped > 0 ? <> (saltati {createResult.skipped})</> : null}.
              </div>
            ) : null}

            {!preview && !createResult && !planError ? (
              <div className="alert alert-light border">Compila il form e clicca <strong>Anteprima</strong>.</div>
            ) : null}

            {preview ? (
              <>
                <div className="d-flex flex-wrap gap-2 mb-3">
                  <span className="badge text-bg-primary">Durata totale: {preview.totalDuration} min</span>
                  <span className="badge text-bg-secondary">Prezzo totale: € {fmtMoney(preview.totalPrice)}</span>
                </div>

                <div className="small text-muted mb-2">Servizi selezionati:</div>
                <ul className="small">
                  {preview.services.map((s) => (
                    <li key={s.id}>
                      {s.name} ({s.durationMin} min, € {fmtMoney(s.price)})
                    </li>
                  ))}
                </ul>

                <div className="table-responsive">
                  <table className="table align-middle">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Ora</th>
                        <th>Operatore</th>
                        <th>Esito</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.dates.map((r) => (
                        <tr key={r.date}>
                          <td>{fmtDateIt(r.date)}</td>
                          <td>
                            {r.ok ? (
                              <span className="badge text-bg-light border">{r.start}–{r.end}</span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td>{r.operator ?? "—"}</td>
                          <td>
                            {r.ok ? (
                              <span className="badge text-bg-success">OK</span>
                            ) : (
                              <>
                                <span className="badge text-bg-warning">Saltato</span>
                                <div className="small text-muted">{r.reason}</div>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3">
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={submitCreate}
                    disabled={creating || preview.countOk < 1}
                  >
                    <i className="bi bi-check2-circle me-1" />
                    {creating ? "Creazione…" : "Crea appuntamenti"}
                  </button>
                  <div className="form-text">Verranno creati solo quelli con esito <strong>OK</strong>.</div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Modal: Trova cliente (Planner) */}
      <div
        className={`modal fade${findOpen ? " show d-block" : ""}`}
        id="planClientFindModal"
        tabIndex={-1}
        aria-hidden={!findOpen}
        style={findOpen ? { background: "rgba(0,0,0,.5)" } : undefined}
      >
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header align-items-start">
              <div>
                <div className="small-muted">Cliente</div>
                <h5 className="modal-title fw-bold m-0">Trova</h5>
              </div>
              <button
                type="button"
                className="btn-close"
                data-bs-dismiss="modal"
                aria-label="Chiudi"
                onClick={() => setFindOpen(false)}
              />
            </div>
            <div className="modal-body">
              <div className="input-group mb-3">
                <span className="input-group-text"><i className="bi bi-search" /></span>
                <input
                  type="text"
                  className="form-control"
                  id="planClientFindQuery"
                  placeholder="Inizia a digitare per cercare..."
                  value={findQuery}
                  onChange={(e) => setFindQuery(e.target.value)}
                />
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  id="planClientFindClear"
                  onClick={() => setFindQuery("")}
                >
                  Annulla
                </button>
              </div>
              <div className="text-muted small mb-2">Cerca per nome, cognome, email o telefono.</div>
              <div className="list-group" id="planClientFindResults">
                {findResults.map((c) => (
                  <button
                    type="button"
                    className="list-group-item list-group-item-action"
                    key={c.id}
                    onClick={() => pickClient(c)}
                  >
                    <div className="fw-semibold">{c.name}</div>
                    <div className="small text-muted">
                      {c.phone ? <>{c.phone} · </> : null}
                      {c.email}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
