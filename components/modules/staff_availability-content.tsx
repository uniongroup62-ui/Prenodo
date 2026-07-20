"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP staff availability page (app/pages/staff_availability.php).
// Fed by the existing DB-backed /api/manage/resources route (section=staff_availability),
// which returns locations, staff, business hours and availability events.
//
// The original page renders a horizontal timeline (day view) where each operator
// row shows shift/presence/timeoff bars. The legacy markup carries the geometry as
// data-timeline-left / data-timeline-width attributes that the page JS converts to
// CSS custom properties (--timeline-left / --timeline-width). We compute the same
// geometry here from the business hours window and the availability events.

type ResourceLocation = { id: number; name: string; isActive?: boolean };

type ResourceStaff = {
  id: number;
  fullName: string;
  isActive?: boolean;
};

type BusinessHour = {
  id: number;
  dow: number;
  dayLabel: string;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  isClosed: boolean;
};

type AvailabilityEvent = {
  id: number;
  table: "availability" | "timeoff";
  staffId: number;
  staffName: string;
  type: string;
  startsAt: string;
  endsAt: string;
  dateFrom: string;
  dateTo: string;
  timeFrom: string;
  timeTo: string;
  locationId: number | null;
  seriesUid: string;
};

type ResourcesData = {
  ok: boolean;
  activeLocationId?: number;
  locations?: ResourceLocation[];
  staff?: ResourceStaff[];
  hours?: BusinessHour[];
  availability?: AvailabilityEvent[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const [y, m, day] = iso.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, day || 1));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function isoToDow(iso: string): number {
  const [y, m, day] = iso.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, day || 1));
  return dt.getUTCDay();
}

function mondayOf(iso: string): string {
  const dow = isoToDow(iso); // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  return shiftIsoDate(iso, -back);
}

function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function pct(n: number): string {
  return `${n.toFixed(4)}%`;
}

export function StaffAvailabilityContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [date, setDate] = useState<string>(todayIso());
  const [locationId, setLocationId] = useState<number>(0);
  const [data, setData] = useState<ResourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // Edit di un evento esistente (event_id/event_table del form legacy).
  const [evEditId, setEvEditId] = useState(0);
  const [evEditTable, setEvEditTable] = useState("");

  // Controlled value for the date "Vai" form input.
  const [dateInput, setDateInput] = useState<string>(todayIso());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({
      slug,
      section: "staff_availability",
      date,
    });
    if (locationId > 0) qs.set("location_id", String(locationId));
    fetch(`/api/manage/resources?${qs.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ResourcesData) => {
        if (cancelled) return;
        setData(j && j.ok ? j : null);
        if (j?.activeLocationId && locationId <= 0) setLocationId(Number(j.activeLocationId));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, date, locationId, reloadTick]);

  const activeLocationId = data?.activeLocationId ?? (locationId > 0 ? locationId : 0);
  const locations = data?.locations ?? [];
  const staff = useMemo(() => (data?.staff ?? []).filter(() => true), [data]);
  const hours = data?.hours ?? [];
  const availability = data?.availability ?? [];

  // Business hours for the current day-of-week.
  const dow = isoToDow(date);
  const dayHours = hours.find((h) => Number(h.dow) === dow) ?? null;

  // Timeline window: business hours of the day, rounded to whole hours.
  // Falls back to 09:00-19:00 (the same default the legacy view shows).
  const window = useMemo(() => {
    const opens = dayHours && !dayHours.isClosed ? hhmmToMinutes(dayHours.opens) : null;
    const closes = dayHours && !dayHours.isClosed ? hhmmToMinutes(dayHours.closes) : null;
    let startMin = opens ?? 9 * 60;
    let endMin = closes ?? 19 * 60;
    // include the second window if present
    const opens2 = dayHours ? hhmmToMinutes(dayHours.opens2) : null;
    const closes2 = dayHours ? hhmmToMinutes(dayHours.closes2) : null;
    if (opens2 != null) startMin = Math.min(startMin, opens2);
    if (closes2 != null) endMin = Math.max(endMin, closes2);
    // round out to whole hours
    startMin = Math.floor(startMin / 60) * 60;
    endMin = Math.ceil(endMin / 60) * 60;
    if (endMin <= startMin) endMin = startMin + 60;
    return { startMin, endMin };
  }, [dayHours]);

  const totalMin = Math.max(1, window.endMin - window.startMin);

  function leftPct(min: number): number {
    return ((min - window.startMin) / totalMin) * 100;
  }
  function widthPct(fromMin: number, toMin: number): number {
    return ((toMin - fromMin) / totalMin) * 100;
  }

  // Hour scale ticks/labels (one per hour, inclusive of both ends).
  const ticks = useMemo(() => {
    const out: { left: number; label: string }[] = [];
    for (let m = window.startMin; m <= window.endMin; m += 60) {
      const hh = Math.floor(m / 60);
      out.push({ left: leftPct(m), label: `${String(hh).padStart(2, "0")}:00` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window.startMin, window.endMin, totalMin]);

  // Business hours bar text (e.g. "09:00 - 19:00").
  const bizBar = useMemo(() => {
    if (!dayHours || dayHours.isClosed || !dayHours.opens || !dayHours.closes) return null;
    const from = hhmmToMinutes(dayHours.opens);
    const to = hhmmToMinutes(dayHours.closes);
    if (from == null || to == null) return null;
    return {
      left: leftPct(from),
      width: widthPct(from, to),
      label: `${dayHours.opens} - ${dayHours.closes}`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayHours, window.startMin, window.endMin, totalMin]);

  // Availability events for this exact day, grouped by staff id.
  const eventsByStaff = useMemo(() => {
    const map = new Map<number, AvailabilityEvent[]>();
    for (const ev of availability) {
      if (ev.dateFrom && ev.dateFrom > date) continue;
      if (ev.dateTo && ev.dateTo < date) continue;
      // single-day events store the day in dateFrom; ranges span dateFrom..dateTo
      if (ev.dateFrom && ev.dateTo) {
        if (date < ev.dateFrom || date > ev.dateTo) continue;
      } else if (ev.dateFrom && ev.dateFrom !== date) {
        continue;
      }
      const list = map.get(ev.staffId) ?? [];
      list.push(ev);
      map.set(ev.staffId, list);
    }
    return map;
  }, [availability, date]);

  function eventBarClass(type: string): string {
    const t = (type || "").toLowerCase();
    if (t === "turno") return "shift";
    if (t === "presenza") return "presence";
    return "timeoff";
  }

  function buildHref(params: Record<string, string>): string {
    const base = new URLSearchParams(params);
    const qs = base.toString();
    return `/${encodeURIComponent(slug)}/staff_availability${qs ? `?${qs}` : ""}`;
  }

  const staffIdParam = "0";
  const locParam = String(activeLocationId || 0);
  const prevDate = shiftIsoDate(date, -1);
  const nextDate = shiftIsoDate(date, 1);

  // Copy-week modal default dates.
  const copySourceWeek = mondayOf(date);
  const copyTargetWeek = shiftIsoDate(copySourceWeek, 7);

  // Event offcanvas form state.
  const [evStaffId, setEvStaffId] = useState("");
  const [evType, setEvType] = useState("Turno");
  const [evDateFrom, setEvDateFrom] = useState(date);
  const [evDateTo, setEvDateTo] = useState(date);
  const [evTimeFrom, setEvTimeFrom] = useState("");
  const [evTimeTo, setEvTimeTo] = useState("");
  const [evRepeat, setEvRepeat] = useState("none");
  const [evRepeatUntil, setEvRepeatUntil] = useState("");
  const [evDows, setEvDows] = useState<Record<string, boolean>>({});
  const [evApplySeries, setEvApplySeries] = useState(false);

  // Keep event default dates in sync with the viewed day until the user edits.
  useEffect(() => {
    setEvDateFrom(date);
    setEvDateTo(date);
  }, [date]);

  // Copy-week modal form state.
  const [copySourceInput, setCopySourceInput] = useState(copySourceWeek);
  const [copyTargetInput, setCopyTargetInput] = useState(copyTargetWeek);
  const [copyStaffId, setCopyStaffId] = useState("0");
  const [copyOverwrite, setCopyOverwrite] = useState(false);

  useEffect(() => {
    setCopySourceInput(mondayOf(date));
    setCopyTargetInput(shiftIsoDate(mondayOf(date), 7));
  }, [date]);

  const dowsList: { value: string; label: string }[] = [
    { value: "1", label: "Lunedì" },
    { value: "2", label: "Martedì" },
    { value: "3", label: "Mercoledì" },
    { value: "4", label: "Giovedì" },
    { value: "5", label: "Venerdì" },
    { value: "6", label: "Sabato" },
    { value: "0", label: "Domenica" },
  ];

  async function postResources(fields: Record<string, string>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Operazione non riuscita."));
      return j as Record<string, unknown>;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function closeOffcanvas() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const el = document.getElementById("offcanvasEvent");
    if (el && w.bootstrap?.Offcanvas) w.bootstrap.Offcanvas.getOrCreateInstance(el).hide();
    const modal = document.getElementById("modalCopyWeek");
    if (modal && w.bootstrap?.Modal) w.bootstrap.Modal.getOrCreateInstance(modal).hide();
  }

  function resetEventForm() {
    setEvEditId(0);
    setEvEditTable("");
    setEvStaffId("");
    setEvType("Turno");
    setEvDateFrom(date);
    setEvDateTo(date);
    setEvTimeFrom("");
    setEvTimeTo("");
    setEvRepeat("none");
    setEvRepeatUntil("");
    setEvDows({});
    setEvApplySeries(false);
  }

  // Salvataggio evento (do=save_event): prima l'avviso NON bloccante sui
  // conflitti con appuntamenti esistenti (check_appt_conflicts), poi il save.
  async function submitEvent(e: React.FormEvent) {
    e.preventDefault();
    const fields: Record<string, string> = {
      action: "availability_save",
      location_id: String(activeLocationId || locationId || 0),
      event_id: String(evEditId),
      event_table: evEditTable,
      staff_id: evStaffId,
      event_type: evType.toLowerCase(),
      date_from: evDateFrom,
      date_to: evDateTo,
      time_from: evTimeFrom,
      time_to: evTimeTo,
      repeat: evRepeat,
      repeat_until: evRepeatUntil,
      dows: Object.entries(evDows).filter(([, v]) => v).map(([k]) => k).join(","),
      apply_series: evApplySeries ? "1" : "0",
    };
    // Avviso conflitti (modale legacy "Attenzione: appuntamenti già presenti").
    const chk = await postResources({ ...fields, action: "availability_check_conflicts" });
    if (chk === null) return;
    const conflicts = Array.isArray(chk.conflicts) ? (chk.conflicts as Array<{ date: string; timeFrom: string; timeTo: string; client: string }>) : [];
    if (conflicts.length) {
      const list = conflicts.slice(0, 8).map((c) => `${c.date} ${c.timeFrom}-${c.timeTo} • ${c.client}`).join("\n");
      const go = globalThis.confirm(`Attenzione: appuntamenti già presenti\n\n${list}${conflicts.length > 8 ? `\n…e altri ${conflicts.length - 8}` : ""}\n\nGli appuntamenti esistenti NON vengono modificati. Salvare comunque l'evento?`);
      if (!go) return;
    }
    const j = await postResources(fields);
    if (j) {
      setMsg(["turno", "presenza"].includes(evType.toLowerCase()) ? "Disponibilità salvata" : "Periodo salvato");
      resetEventForm();
      closeOffcanvas();
      setReloadTick((t) => t + 1);
    }
  }

  // Duplica settimana (do=copy_week) con i messaggi legacy dal server.
  async function submitCopyWeek(e: React.FormEvent) {
    e.preventDefault();
    const j = await postResources({
      action: "availability_copy_week",
      location_id: String(activeLocationId || locationId || 0),
      source_week: copySourceInput,
      target_week: copyTargetInput,
      copy_staff_id: copyStaffId,
      overwrite: copyOverwrite ? "1" : "0",
    });
    if (j) {
      setMsg(String(j.message ?? "Settimana duplicata"));
      closeOffcanvas();
      setReloadTick((t) => t + 1);
    }
  }

  // Modifica: precompila il form legacy e apre l'offcanvas.
  function editEvent(ev: AvailabilityEvent) {
    setEvEditId(ev.id);
    setEvEditTable(ev.table === "timeoff" ? "timeoff" : "availability");
    setEvStaffId(String(ev.staffId));
    const t = String(ev.type ?? "turno").toLowerCase();
    setEvType(t.charAt(0).toUpperCase() + t.slice(1));
    setEvDateFrom(ev.dateFrom || date);
    setEvDateTo(ev.dateTo || ev.dateFrom || date);
    setEvTimeFrom(ev.timeFrom || "");
    setEvTimeTo(ev.timeTo || "");
    setEvRepeat("none");
    setEvRepeatUntil("");
    setEvDows({});
    setEvApplySeries(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const el = document.getElementById("offcanvasEvent");
    if (el && w.bootstrap?.Offcanvas) w.bootstrap.Offcanvas.getOrCreateInstance(el).show();
  }

  // Eliminazione evento/serie con le conferme legacy.
  async function removeEvent(ev: AvailabilityEvent) {
    const isTimeoff = ev.table === "timeoff";
    let scopeSeries = false;
    if (!isTimeoff && ev.seriesUid) {
      scopeSeries = globalThis.confirm("Rimuovere l'intera serie? (Annulla = solo questo evento)");
    }
    const confirmText = isTimeoff ? "Rimuovere questo periodo?" : scopeSeries ? "Rimuovere l'intera serie?" : "Rimuovere questo evento?";
    if (!scopeSeries && !globalThis.confirm(confirmText)) return;
    const j = await postResources({
      action: "availability_delete",
      id: String(ev.id),
      table: isTimeoff ? "timeoff" : "availability",
      apply_series: scopeSeries ? "1" : "0",
      location_id: String(activeLocationId || locationId || 0),
      date,
    });
    if (j) {
      setMsg(isTimeoff ? "Periodo rimosso" : "Evento rimosso");
      setReloadTick((t) => t + 1);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/staff_availability.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Operatori</div>
          <h1 className="bs-page-title">Disponibilita</h1>
          <div className="bs-page-subtitle">{date}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 align-items-center flex-wrap">
            <div className="btn-group" role="group" aria-label="Vista">
              <a
                className="btn btn-outline-primary active"
                href={buildHref({ view: "day", date, staff_id: staffIdParam, location_id: locParam })}
              >
                Giorno
              </a>
              <a
                className="btn btn-outline-primary "
                href={buildHref({ view: "week", date, staff_id: staffIdParam, location_id: locParam })}
              >
                Settimana
              </a>
            </div>

            <a
              className="btn btn-outline-secondary"
              href={buildHref({ view: "day", date: prevDate, staff_id: staffIdParam, location_id: locParam })}
            >
              <i className="bi bi-chevron-left" />
            </a>
            <form
              method="get"
              className="d-flex gap-2 align-items-center"
              onSubmit={(e) => {
                e.preventDefault();
                if (dateInput) setDate(dateInput);
              }}
            >
              <input type="hidden" name="page" value="staff_availability" />
              <input type="hidden" name="view" value="day" />
              <input type="hidden" name="staff_id" value={staffIdParam} />
              <input type="hidden" name="location_id" value={locParam} />
              <input
                className="form-control staff-availability-date-input"
                type="date"
                name="date"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
              />
              <button className="btn btn-outline-primary" type="submit">
                Vai
              </button>
            </form>
            <a
              className="btn btn-outline-secondary"
              href={buildHref({ view: "day", date: nextDate, staff_id: staffIdParam, location_id: locParam })}
            >
              <i className="bi bi-chevron-right" />
            </a>

            <button
              className="btn btn-primary"
              type="button"
              data-bs-toggle="offcanvas"
              data-bs-target="#offcanvasEvent"
              aria-controls="offcanvasEvent"
            >
              <i className="bi bi-plus" /> Nuovo evento
            </button>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="avail-legend mb-2">
        <span>
          <i className="i-biz" /> Orari di lavoro
        </span>
        <span>
          <i className="i-shift" /> Turno / Presenza
        </span>
        <span>
          <i className="i-timeoff" /> Assenza / Ferie / Malattia
        </span>
      </div>

      <div className="card p-3">
        <div className="avail-wrap">
          <div className="avail-grid">
            <div className="avail-header">
              <div className="avail-staffcol text-muted small">&nbsp;</div>
              <div className="avail-timecol">
                <div className="avail-scale">
                  {ticks.map((t, i) => (
                    <span key={`scale-${i}`}>
                      <div className="tick" style={{ ["--timeline-left" as string]: pct(t.left), left: pct(t.left) }} />
                      <div className="label" style={{ ["--timeline-left" as string]: pct(t.left), left: pct(t.left) }}>
                        {t.label}
                      </div>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Business hours row */}
            <div className="avail-row ">
              <div className="avail-staffcol">
                <div className="avail-staffname">
                  <div className="name">Orari di lavoro</div>
                  <div className="meta">{date}</div>
                </div>
              </div>
              <div className="avail-timecol">
                <div className="avail-track">
                  {ticks.map((t, i) => (
                    <div
                      key={`bizt-${i}`}
                      className="tick"
                      style={{ ["--timeline-left" as string]: pct(t.left), left: pct(t.left) }}
                    />
                  ))}
                  {bizBar ? (
                    <div
                      className="avail-bar biz"
                      style={{
                        ["--timeline-left" as string]: pct(bizBar.left),
                        ["--timeline-width" as string]: pct(bizBar.width),
                        left: pct(bizBar.left),
                        width: pct(bizBar.width),
                      }}
                    >
                      {bizBar.label}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {staff.map((member) => {
              const evs = eventsByStaff.get(member.id) ?? [];
              return (
                <div className="avail-row " key={member.id}>
                  <div className="avail-staffcol">
                    <div className="avail-staffname">
                      <div className="name">{member.fullName}</div>
                      <div className="meta">
                        {member.isActive ? (
                          <span className="badge text-bg-success">Attivo</span>
                        ) : (
                          <span className="badge text-bg-secondary">Inattivo</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="avail-timecol">
                    <div className="avail-track">
                      {ticks.map((t, i) => (
                        <div
                          key={`st-${member.id}-${i}`}
                          className="tick"
                          style={{ ["--timeline-left" as string]: pct(t.left), left: pct(t.left) }}
                        />
                      ))}
                      {evs.map((ev) => {
                        const from = hhmmToMinutes(ev.timeFrom);
                        const to = hhmmToMinutes(ev.timeTo);
                        if (from == null || to == null) return null;
                        const l = leftPct(from);
                        const w = widthPct(from, to);
                        const label = ev.timeFrom && ev.timeTo ? `${ev.timeFrom} - ${ev.timeTo}` : ev.type;
                        return (
                          <div
                            key={`${ev.table}-${ev.id}`}
                            className={`avail-bar ${eventBarClass(ev.type)}`}
                            style={{
                              ["--timeline-left" as string]: pct(l),
                              ["--timeline-width" as string]: pct(w),
                              left: pct(l),
                              width: pct(w),
                            }}
                            title={`${ev.type} • ${label}`}
                          >
                            <span className="me-1">{label}</span>
                            <button
                              type="button"
                              className="btn btn-link btn-sm p-0 text-white"
                              title="Modifica"
                              onClick={() => editEvent(ev)}
                              disabled={busy}
                            >
                              <i className="bi bi-pencil" />
                            </button>
                            <button
                              type="button"
                              className="btn btn-link btn-sm p-0 text-white ms-1"
                              title="Elimina"
                              onClick={() => removeEvent(ev)}
                              disabled={busy}
                            >
                              <i className="bi bi-x-lg" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}

            {!loading && staff.length === 0 ? (
              <div className="avail-row ">
                <div className="avail-staffcol">
                  <div className="avail-staffname">
                    <div className="name text-muted">Nessun operatore</div>
                  </div>
                </div>
                <div className="avail-timecol">
                  <div className="avail-track" />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="form-text mt-3">
          Suggerimento: inserisci i <b>turni</b>{" "}per limitare la prenotazione agli orari in cui l&apos;operatore è
          presente. Le <b>presenze</b> sovrascrivono i turni della giornata (override). Ferie/assenze bloccano sempre.
        </div>
      </div>

      {/* Modal: copy week (duplicate shifts) */}
      <div className="modal fade" id="modalCopyWeek" tabIndex={-1} aria-labelledby="modalCopyWeekLabel" aria-hidden="true">
        <div className="modal-dialog">
          <div className="modal-content">
            <form method="post" onSubmit={submitCopyWeek}>
              <input type="hidden" name="do" value="copy_week" />
              <input type="hidden" name="location_id" value={locParam} />
              <div className="modal-header">
                <h5 className="modal-title" id="modalCopyWeekLabel">
                  Duplica settimana
                </h5>
                <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Close" />
              </div>
              <div className="modal-body">
                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label">Settimana origine</label>
                    <input
                      className="form-control"
                      type="date"
                      name="source_week"
                      value={copySourceInput}
                      onChange={(e) => setCopySourceInput(e.target.value)}
                      required
                    />
                    <div className="form-text">Verrà usato il lunedì della settimana selezionata.</div>
                  </div>
                  <div className="col-6">
                    <label className="form-label">Settimana destinazione</label>
                    <input
                      className="form-control"
                      type="date"
                      name="target_week"
                      value={copyTargetInput}
                      onChange={(e) => setCopyTargetInput(e.target.value)}
                      required
                    />
                    <div className="form-text">Verrà usato il lunedì della settimana selezionata.</div>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="form-label">Operatore</label>
                  <select
                    className="form-select"
                    name="copy_staff_id"
                    value={copyStaffId}
                    onChange={(e) => setCopyStaffId(e.target.value)}
                  >
                    <option value="0">Tutti gli operatori</option>
                    {staff.map((member) => (
                      <option value={String(member.id)} key={member.id}>
                        {member.fullName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-check mt-3">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    value="1"
                    id="copyOverwrite"
                    name="overwrite"
                    checked={copyOverwrite}
                    onChange={(e) => setCopyOverwrite(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="copyOverwrite">
                    Sovrascrivi i turni/presenze nella settimana di destinazione
                  </label>
                </div>

                <div className="small text-muted mt-2">
                  Nota: vengono copiati solo <b>Turno</b> e <b>Presenza</b> (non ferie/assenze/malattia).
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                  Annulla
                </button>
                <button type="submit" className="btn btn-primary">
                  <i className="bi bi-files me-1" />
                  Duplica
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Offcanvas: add/edit event */}
      <div className="offcanvas offcanvas-end" tabIndex={-1} id="offcanvasEvent" aria-labelledby="offcanvasEventLabel">
        <div className="offcanvas-header">
          <h5 className="offcanvas-title" id="offcanvasEventLabel">
            Nuovo evento
          </h5>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
        </div>
        <div className="offcanvas-body">
          <form method="post" id="eventForm" onSubmit={submitEvent}>
            <input type="hidden" name="do" value="save_event" />
            <input type="hidden" name="location_id" value={locParam} />
            <input type="hidden" name="confirm_appt_conflicts" id="f_confirm_appt_conflicts" value="0" />
            <input type="hidden" name="event_id" id="f_event_id" value="0" />
            <input type="hidden" name="event_table" id="f_event_table" value="" />
            <input type="hidden" name="event_old_start" id="f_event_old_start" value="" />
            <input type="hidden" name="event_old_end" id="f_event_old_end" value="" />

            <div className="mb-3">
              <label className="form-label">Operatore</label>
              <select
                className="form-select"
                name="staff_id"
                id="f_staff"
                required
                value={evStaffId}
                onChange={(e) => setEvStaffId(e.target.value)}
              >
                <option value="">Seleziona...</option>
                {staff.map((member) => (
                  <option value={String(member.id)} key={member.id}>
                    {member.fullName}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-3">
              <label className="form-label">Tipo</label>
              <select
                className="form-select"
                name="event_type"
                id="f_type"
                required
                value={evType}
                onChange={(e) => setEvType(e.target.value)}
              >
                <option value="Turno">Turno</option>
                <option value="Presenza">Presenza</option>
                <option value="Assenza">Assenza</option>
                <option value="Ferie">Ferie</option>
                <option value="Malattia">Malattia</option>
              </select>
              <div className="form-text">
                <b>Turno</b>: disponibilità standard. <b>Presenza</b>: override in una giornata specifica.{" "}
                <b>Assenza/Ferie/Malattia</b>: non disponibile.
              </div>
            </div>

            <div className="row g-2">
              <div className="col-6">
                <label className="form-label">Dal</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_from"
                  id="f_date_from"
                  value={evDateFrom}
                  onChange={(e) => setEvDateFrom(e.target.value)}
                  required
                />
              </div>
              <div className="col-6">
                <label className="form-label">Al</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_to"
                  id="f_date_to"
                  value={evDateTo}
                  onChange={(e) => setEvDateTo(e.target.value)}
                  required
                />
                <div className="form-text">
                  Range solo per Assenza/Ferie/Malattia (non ripetuti). Turni/Presenze: singolo giorno (usa ripetizione o
                  duplica settimana).
                </div>
              </div>
            </div>

            <div className="row g-2 mt-1">
              <div className="col-6">
                <label className="form-label">Dalle</label>
                <input
                  className="form-control"
                  type="time"
                  name="time_from"
                  id="f_time_from"
                  step={60}
                  value={evTimeFrom}
                  onChange={(e) => setEvTimeFrom(e.target.value)}
                  required
                />
              </div>
              <div className="col-6">
                <label className="form-label">Alle</label>
                <input
                  className="form-control"
                  type="time"
                  name="time_to"
                  id="f_time_to"
                  step={60}
                  value={evTimeTo}
                  onChange={(e) => setEvTimeTo(e.target.value)}
                  required
                />
              </div>
            </div>

            <hr />

            <div className="mb-2">
              <label className="form-label">Ripetizione</label>
              <div className="d-flex flex-column gap-1">
                {[
                  { value: "none", label: "Nessuna" },
                  { value: "w1", label: "Ogni settimana" },
                  { value: "w2", label: "Ogni 2 settimane" },
                  { value: "w3", label: "Ogni 3 settimane" },
                  { value: "m1", label: "Ogni mese" },
                ].map((opt) => (
                  <label className="form-check" key={opt.value}>
                    <input
                      className="form-check-input"
                      type="radio"
                      name="repeat"
                      value={opt.value}
                      checked={evRepeat === opt.value}
                      onChange={() => setEvRepeat(opt.value)}
                    />
                    <span className="form-check-label">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mb-3">
              <label className="form-label">Data fine (obbligatoria se ripetuto)</label>
              <input
                className="form-control"
                type="date"
                name="repeat_until"
                id="f_repeat_until"
                value={evRepeatUntil}
                onChange={(e) => setEvRepeatUntil(e.target.value)}
              />
            </div>

            <div className="mb-3">
              <label className="form-label">Giorni</label>
              <div className="row g-1">
                {dowsList.map((d) => (
                  <div className="col-6" key={d.value}>
                    <label className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        name="dows[]"
                        value={d.value}
                        checked={!!evDows[d.value]}
                        onChange={(e) => setEvDows((prev) => ({ ...prev, [d.value]: e.target.checked }))}
                      />
                      <span className="form-check-label">{d.label}</span>
                    </label>
                  </div>
                ))}
              </div>
              <div className="form-text">Se non selezioni nulla, viene usato il giorno della data di partenza.</div>
            </div>

            <div className="mb-3 staff-availability-series-box" id="seriesBox">
              <label className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  name="apply_series"
                  value="1"
                  id="f_apply_series"
                  checked={evApplySeries}
                  onChange={(e) => setEvApplySeries(e.target.checked)}
                />
                <span className="form-check-label">Applica alla serie (se presente)</span>
              </label>
            </div>

            <div className="d-flex gap-2">
              <button className="btn btn-primary" type="submit">
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
              <button className="btn btn-outline-secondary" type="button" data-bs-dismiss="offcanvas">
                Annulla
              </button>
            </div>

            <hr />
            <div className="small text-muted">
              Nota: i campi <b>Al</b>, <b>Dalle</b> e <b>Alle</b> sono obbligatori. Gli orari devono rientrare negli orari
              di apertura (<b>Orari</b>) o, se presenti, negli <b>Straordinari</b> (prioritari su orari/chiusure). Per
              eventi ripetuti è richiesta una data fine.
            </div>
          </form>
        </div>
      </div>

      {/* Modal: warning appointments overlapping the availability change */}
      <div
        className="modal fade"
        id="modalApptConflicts"
        tabIndex={-1}
        aria-labelledby="modalApptConflictsLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title" id="modalApptConflictsLabel">
                Attenzione: appuntamenti già presenti
              </h5>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Close" />
            </div>
            <div className="modal-body">
              <div className="mb-2" id="apptConflictsMsg">
                Nella data e negli orari che stai modificando risultano già presenti uno o più appuntamenti{" "}
                <b>In attesa</b> o <b>Prenotati</b> per questo operatore.
                <div className="small text-muted">
                  Se confermi, la disponibilità verrà salvata <b>senza alterare</b> gli appuntamenti già esistenti.
                </div>
              </div>

              <div className="table-responsive">
                <table className="table table-sm table-bordered align-middle mb-0">
                  <thead className="table-light">
                    <tr>
                      <th className="staff-availability-conflict-date-col">Data</th>
                      <th className="staff-availability-conflict-date-col">Ora</th>
                      <th>Cliente</th>
                      <th className="staff-availability-conflict-code-col">Codice</th>
                      <th>Servizio</th>
                    </tr>
                  </thead>
                  <tbody id="apptConflictsTbody">
                    <tr>
                      <td colSpan={5} className="text-muted">
                        -
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-primary" id="btnApptConflictsConfirm">
                Conferma
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
