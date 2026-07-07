"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

// Port fedele della pagina "Lista appuntamenti" legacy (appointments.php), alimentata
// dal /api/manage/appointments?action=list DB-backed.
//
// Comportamenti legacy portati 1:1:
// • Azioni per riga: SOLO "Modifica" (drawer quick-booking globale via data-qb-edit) ed
//   "Elimina" — quest'ultimo VISIBILE SOLO per prenotazioni in stato Annullato
//   (deleteLocked legacy). NON esiste alcun bottone "Incassa" (verificato su
//   appointments.php: nessun collegamento alla cassa da questa lista).
// • Checkbox di riga selezionabile SOLO per prenotazioni Annullate; sulle altre è
//   disabled col title verbatim "La prenotazione deve essere in stato Annullato...".
//   Il "seleziona tutti" opera solo sulle righe selezionabili visibili.
// • Data "dd/mm/yyyy HH:MM → HH:MM" (inizio con data completa, fine solo ora); righe
//   figlie multi-servizio "↳ HH:MM → HH:MM".
// • Codice prenotazione: <code>#CODICE</code> non cliccabile, "—" quando assente.
// • Stati verbatim: In attesa / Prenotato / Eseguito / Annullato / No show (+ --other).
// • Multi-servizio: riga padre "Multi-servizio (N)" + badge "Multi-servizio" + elenco
//   servizi small + pallini colore operatori (max 6) + nomi; figli con orari segmento,
//   operatore (pallino+nome), badge stato e riordino ↑/↓ (Sposta prima/Sposta dopo).
// • Riepiloghi "Pacchetto: X"/"Pacchetti: X, Y" e "Prepagato" sotto il servizio
//   (small text-primary con icone box/carta).
// • Esiti eliminazione come alert in testa (View::alert legacy): "Appuntamento
//   eliminato", "N appuntamenti eliminati.", "N prenotazioni non annullate non
//   eliminate: annullale prima.", "Nessuna prenotazione eliminata.", ecc.
// • Stato vuoto GLOBALE (nessuna prenotazione in sede): card "Nessuna prenotazione
//   presente" con bottoni "Nuova prenotazione" (drawer) e "Apri calendario"; il
//   bottone header "Calendario" appare solo quando la lista non è globalmente vuota.
//   Stato vuoto del filtro: "Nessun appuntamento nel periodo."
// • Deep-link legacy: ?created=<id,id> include gli appuntamenti appena creati anche
//   fuori dal range date; ?action=edit&id=<id> / ?action=new aprono il drawer.
// • Conferme verbatim: "Eliminare questo appuntamento?", "Eliminare gli appuntamenti
//   selezionati?". Toast successo riordino: "Ordine multi-servizio aggiornato."
//
// I filtri Dal/Al/Cerca sono applicati client-side sulla lista fetchata (il form GET è
// intercettato) — stesso risultato del GET legacy (LIKE su cliente/codice, range date).

type AppointmentServiceLine = {
  serviceId: number;
  name: string;
  price: string;
  // Segment id (multi-service): drives the ↑/↓ reorder (action=swap_segment).
  segmentId?: number | null;
  // Orari/operatore del segmento (righe figlie legacy "↳ HH:MM → HH:MM" + pallino).
  time?: string;
  endTime?: string;
  staffName?: string;
  staffColor?: string;
};

type Appointment = {
  id: number;
  date?: string;
  locationId?: number | null;
  time: string;
  endTime?: string;
  client: string;
  service: string;
  operator: string;
  room: string;
  price: string;
  status: string;
  // Codice stato PHP reale (pending|scheduled|done|canceled|no_show).
  statusCode?: string;
  // Real booking code (appointments.public_code); null -> "—" come il legacy.
  publicCode?: string | null;
  services?: AppointmentServiceLine[];
  // Decorazioni legacy (route action=list): riepiloghi + colore operatore.
  packageSummary?: string;
  prepaidSummary?: string;
  staffColor?: string;
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

// Codice stato normalizzato (appointment_status_normalize_code legacy).
function normStatusCode(appt: Appointment): string {
  const raw = String(appt.statusCode ?? appt.status ?? "").trim().toLowerCase();
  if (raw === "cancelled" || raw === "annullato") return "canceled";
  if (raw === "no show" || raw === "no-show") return "no_show";
  if (raw === "in attesa") return "pending";
  if (raw === "prenotato" || raw === "confermato") return "scheduled";
  if (raw === "eseguito" || raw === "completato" || raw === "completed") return "done";
  return raw;
}

// Badge stato legacy (appointments.php 1041-1050): etichette + classi verbatim.
const STATUS_LABELS: Record<string, string> = {
  pending: "In attesa",
  scheduled: "Prenotato",
  done: "Eseguito",
  canceled: "Annullato",
  no_show: "No show",
};
function statusBadge(appt: Appointment): { className: string; label: string } {
  const st = normStatusCode(appt);
  const label = STATUS_LABELS[st] ?? (appt.statusCode || appt.status);
  if (st === "pending") return { className: "appointments-status-badge--pending", label };
  if (st === "scheduled") return { className: "appointments-status-badge--scheduled", label };
  if (st === "done") return { className: "appointments-status-badge--done", label };
  if (st === "canceled") return { className: "appointments-status-badge--canceled", label };
  if (st === "no_show") return { className: "appointments-status-badge--no-show", label };
  return { className: "appointments-status-badge--other", label };
}

// Title verbatim del lock eliminazione (appointments.php $deleteLockTitle).
const DELETE_LOCK_TITLE = "La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.";

// Pallino colore operatore legacy (.op-color-dot data-appointment-color).
function OpColorDot({ color }: { color?: string }) {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return <span className="op-color-dot" data-appointment-color={color} title="Colore operatore" style={{ backgroundColor: color }}></span>;
}

export function AppointmentsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const defaults = useMemo(() => monthRange(), []);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter state (kept working client-side over the loaded appointments).
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [q, setQ] = useState("");

  // Esiti operazioni (View::alert legacy: msg success / err danger in testa pagina).
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // Deep-link legacy ?created=<id,id,...>: gli appuntamenti appena creati dal planner
  // restano in lista anche fuori dal range date.
  const [createdIds, setCreatedIds] = useState<number[]>([]);

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);

  // Toast riordino segmenti (legacy appointments.js toast()).
  const [toastText, setToastText] = useState("");

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

  // Deep-link legacy (mount-only): ?created= inclusione forzata; ?action=edit&id= /
  // ?action=new aprono il drawer quick-booking globale (openEditId/openNew di
  // appointmentsPageConfig) — simulato con un click delegato data-qb-edit/new.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    // Alert da redirect legacy (?msg/?err — es. l'arrivo dal planner con
    // "Pianificazione completata: creati N appuntamenti").
    const urlMsg = String(sp.get("msg") ?? "").trim();
    const urlErr = String(sp.get("err") ?? "").trim();
    if (urlMsg) setMsg(urlMsg);
    if (urlErr) setErr(urlErr);
    // Filtri dal redirect legacy (?from/?to/?q, es. range ±1 giorno del planner).
    const urlFrom = String(sp.get("from") ?? "");
    const urlTo = String(sp.get("to") ?? "");
    const urlQ = String(sp.get("q") ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(urlFrom)) setFrom(urlFrom);
    if (/^\d{4}-\d{2}-\d{2}$/.test(urlTo)) setTo(urlTo);
    if (urlQ) setQ(urlQ);
    const created = String(sp.get("created") ?? "")
      .split(/[^0-9]+/)
      .map((v) => Number.parseInt(v, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 300);
    if (created.length) setCreatedIds(created);
    const action = String(sp.get("action") ?? "");
    const editId = Number.parseInt(String(sp.get("id") ?? "0"), 10) || 0;
    if ((action === "edit" && editId > 0) || action === "new") {
      // Il drawer globale ascolta i click deleghi su [data-qb-edit]/[data-qb-new]:
      // un click sintetico dopo il mount riproduce qbOpenEditAppointment/qbOpenNew.
      const timer = setTimeout(() => {
        const a = document.createElement("a");
        a.href = "#";
        if (action === "edit") a.setAttribute("data-qb-edit", String(editId));
        else a.setAttribute("data-qb-new", "1");
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, 450);
      return () => clearTimeout(timer);
    }
  }, []);

  // ↑/↓ segment reorder (legacy handleSegmentMove -> action=swap_segment): swap +
  // toast successo verbatim + reload (il legacy ricarica la pagina; noi rifetchiamo).
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
        setToastText(String(data?.error || "Operazione non riuscita"));
        return;
      }
      setToastText("Ordine multi-servizio aggiornato.");
      load();
    } catch {
      setToastText("Errore di rete durante l'aggiornamento.");
    } finally {
      setSwapBusy(false);
    }
  }, [slug, swapBusy, load]);

  // Auto-dismiss del toast (il legacy usa un toast Bootstrap con autohide).
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(""), 3500);
    return () => clearTimeout(timer);
  }, [toastText]);

  // POST delete (singolo) / bulk_delete (CSV) e composizione degli esiti verbatim
  // legacy (appointments.php 499-520) mostrati come alert in testa.
  const runDelete = useCallback(
    async (ids: number[], bulk: boolean) => {
      if (!ids.length || deleting) return;
      setDeleting(true);
      setMsg("");
      setErr("");
      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(
            bulk ? { action: "bulk_delete", ids: ids.join(",") } : { action: "delete", id: ids[0] },
          ),
        });
        const json = await res.json().catch(() => ({})) as {
          ok?: boolean;
          error?: string;
          deleted?: number;
          blockedNotCanceled?: number;
          blockedUnavailable?: number;
        };
        if (!res.ok || json?.ok === false || json?.error) {
          setErr(String(json?.error || "Errore eliminazione"));
          return;
        }
        const deleted = Math.max(0, Number(json?.deleted ?? 0));
        const blockedNotCanceled = Math.max(0, Number(json?.blockedNotCanceled ?? 0));
        const blockedUnavailable = Math.max(0, Number(json?.blockedUnavailable ?? 0));
        if (!bulk) {
          setMsg("Appuntamento eliminato");
        } else {
          if (deleted > 0) setMsg(deleted === 1 ? "1 appuntamento eliminato." : `${deleted} appuntamenti eliminati.`);
          const errParts: string[] = [];
          if (blockedUnavailable > 0) {
            errParts.push(
              blockedUnavailable === 1
                ? "1 prenotazione non eliminata perche non disponibile nella sede corrente."
                : `${blockedUnavailable} prenotazioni non eliminate perche non disponibili nella sede corrente.`,
            );
          }
          if (blockedNotCanceled > 0) {
            errParts.push(
              blockedNotCanceled === 1
                ? "1 prenotazione non annullata non eliminata: annullala prima."
                : `${blockedNotCanceled} prenotazioni non annullate non eliminate: annullale prima.`,
            );
          }
          if (errParts.length) setErr(errParts.join(" "));
          if (deleted === 0 && !errParts.length) setErr("Nessuna prenotazione eliminata.");
        }
        setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
        load();
      } catch {
        setErr("Errore eliminazione");
      } finally {
        setDeleting(false);
      }
    },
    [deleting, load, slug],
  );

  // Per-row "Elimina" (solo Annullati): conferma verbatim poi delete singolo.
  const deleteOne = useCallback(
    (id: number) => {
      if (!window.confirm("Eliminare questo appuntamento?")) return;
      void runDelete([id], false);
    },
    [runDelete],
  );

  // "Elimina selezionati": conferma verbatim legacy (testo FISSO, data-confirm-submit).
  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    if (!window.confirm("Eliminare gli appuntamenti selezionati?")) return;
    void runDelete(selectedIds, true);
  }, [runDelete, selectedIds]);

  const toggleSelected = useCallback((id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return appointments.filter((appt) => {
      // ?created=: gli appuntamenti appena creati restano visibili anche fuori range.
      const forced = createdIds.includes(appt.id);
      const day = appt.date ?? "";
      if (!forced) {
        if (from && day && day < from) return false;
        if (to && day && day > to) return false;
      }
      if (term) {
        const code = appt.publicCode ? String(appt.publicCode) : "";
        const haystack = `${appt.client} ${code} #${code}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [appointments, from, to, q, createdIds]);

  // Selezione: SOLO le righe eliminabili (stato Annullato) sono selezionabili — le
  // altre checkbox sono disabled (deleteLocked legacy). Il select-all opera sulle
  // selezionabili visibili.
  const selectableIds = useMemo(
    () => filtered.filter((appt) => normStatusCode(appt) === "canceled").map((appt) => appt.id),
    [filtered],
  );
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));
  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) =>
        checked ? Array.from(new Set([...prev, ...selectableIds])) : prev.filter((id) => !selectableIds.includes(id)),
      );
    },
    [selectableIds],
  );

  function pageHref(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`appointments${suffix}`.replace("&", "?")}`;
  }

  const resetHref = pageHref("");
  // Stato vuoto GLOBALE legacy ($hasAnyAppointmentsInScope): nessuna prenotazione in
  // sede a prescindere dal filtro (la lista è fetchata senza date).
  const hasAny = appointments.length > 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/appointments.css" />

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="bs-page-header appointments-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Agenda</div>
          <h1 className="bs-page-title">Lista appuntamenti</h1>
          <div className="bs-page-subtitle">Gestisci prenotazioni, stati e passaggio rapido al calendario.</div>
        </div>
        <div className="bs-page-actions">
          {/* Legacy: il bottone Calendario appare solo quando esistono prenotazioni. */}
          {hasAny || loading ? (
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/calendar`}>
              <i className="bi bi-calendar3 me-1"></i>Calendario
            </a>
          ) : null}
        </div>
      </div>

      <div className="appointments-page">
        {!loading && !hasAny ? (
          // Stato vuoto globale legacy (appointments.php 957-976).
          <div className="card border-0 shadow-sm appointments-empty-card">
            <div className="appointments-empty-state">
              <div className="appointments-empty-icon" aria-hidden="true">
                <i className="bi bi-calendar-plus"></i>
              </div>
              <h2>Nessuna prenotazione presente</h2>
              <p>
                La lista appuntamenti e ancora vuota. Crea la prima prenotazione oppure passa al calendario per
                controllare disponibilita, operatori e cabine nella sede selezionata.
              </p>
              <div className="d-flex justify-content-center gap-2 flex-wrap">
                <a className="btn btn-primary" href="#" data-qb-new="1">
                  <i className="bi bi-plus-lg me-1"></i>Nuova prenotazione
                </a>
                <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/calendar`}>
                  <i className="bi bi-grid-3x3-gap me-1"></i>Apri calendario
                </a>
              </div>
            </div>
          </div>
        ) : (
          <>
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
                <form
                  method="post"
                  action={pageHref("&action=bulk_delete")}
                  className="appointments-bulk-actions"
                  data-confirm-submit="Eliminare gli appuntamenti selezionati?"
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
                          checked={allSelectableSelected}
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
                        <td colSpan={8} className="text-muted p-3">
                          {loading ? "Caricamento…" : "Nessun appuntamento nel periodo."}
                        </td>
                      </tr>
                    ) : (
                      filtered.map((appt) => {
                        const badge = statusBadge(appt);
                        const deleteLocked = normStatusCode(appt) !== "canceled";
                        const lines = appt.services && appt.services.length > 0 ? appt.services : [{ serviceId: 0, name: appt.service, price: appt.price } as AppointmentServiceLine];
                        const isMulti = lines.length > 1;
                        const expanded = expandedRows.includes(appt.id);
                        // Data legacy: "dd/mm/yyyy HH:MM → HH:MM".
                        const dateCell = `${fmtDate(appt.date)} ${appt.time}${appt.endTime ? ` → ${appt.endTime}` : ""}`;
                        // Pallini colore operatori (multi: distinti, max 6 come il legacy).
                        const dotColors = isMulti
                          ? [...new Set(lines.map((l) => l.staffColor).filter(Boolean))].slice(0, 6) as string[]
                          : appt.staffColor
                            ? [appt.staffColor]
                            : [];
                        // Operatore riga padre ($opSummary legacy): multi-servizio con
                        // operatori DIVERSI -> nomi uniti "A, B"; altrimenti l'unico nome.
                        const parentStaffNames = isMulti
                          ? ([...new Set(lines.map((l) => l.staffName).filter(Boolean))] as string[])
                          : [];
                        const operatorText = isMulti
                          ? parentStaffNames.length > 1
                            ? parentStaffNames.join(", ")
                            : parentStaffNames[0] || "—"
                          : appt.operator || "—";
                        const summaries = (
                          <>
                            {appt.packageSummary ? (
                              <div className="small text-primary fw-semibold mt-1">
                                <i className="bi bi-box-seam me-1"></i>
                                {appt.packageSummary}
                              </div>
                            ) : null}
                            {appt.prepaidSummary ? (
                              <div className="small text-primary fw-semibold mt-1">
                                <i className="bi bi-credit-card-2-front me-1"></i>
                                {appt.prepaidSummary}
                              </div>
                            ) : null}
                          </>
                        );
                        return (
                          <Fragment key={appt.id}>
                            <tr className={isMulti ? "ms-parent" : undefined} data-ms-group={isMulti ? appt.id : undefined}>
                              <td>
                                <div className={isMulti ? "d-flex align-items-center gap-2" : undefined}>
                                  {/* deleteLocked legacy: selezionabile solo se Annullato. */}
                                  <input
                                    className="form-check-input appt-select"
                                    type="checkbox"
                                    value={appt.id}
                                    aria-label="Seleziona appuntamento"
                                    disabled={deleteLocked}
                                    title={deleteLocked ? DELETE_LOCK_TITLE : ""}
                                    checked={selectedIds.includes(appt.id)}
                                    onChange={(e) => toggleSelected(appt.id, e.target.checked)}
                                  />
                                  {isMulti ? (
                                    <button
                                      // NB: niente data-bs-toggle/data-bs-target — l'apertura
                                      // è gestita da React (toggleExpanded). Con gli attributi
                                      // Bootstrap, il plugin Collapse intercettava lo stesso
                                      // click e annullava il toggle React ("non accade nulla").
                                      className="btn btn-sm btn-link p-0 ms-toggle"
                                      type="button"
                                      aria-expanded={expanded}
                                      aria-label="Mostra/Nascondi dettagli multi-servizio"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        toggleExpanded(appt.id);
                                      }}
                                    >
                                      <i className={`bi ${expanded ? "bi-chevron-down" : "bi-chevron-right"}`}></i>
                                    </button>
                                  ) : null}
                                </div>
                              </td>
                              <td>{dateCell}</td>
                              <td className="fw-semibold">{appt.client}</td>
                              <td className="text-muted">{appt.publicCode ? <code>#{appt.publicCode}</code> : "—"}</td>
                              <td className="text-muted">
                                {isMulti ? (
                                  <>
                                    <span className="fw-semibold">Multi-servizio ({lines.length})</span>
                                    <span className="appointments-ms-badge ms-2">Multi-servizio</span>
                                    <div className="small text-muted mt-1">
                                      {[...new Set(lines.map((l) => l.name).filter(Boolean))].join(", ")}
                                    </div>
                                    {summaries}
                                  </>
                                ) : (
                                  <>
                                    {lines[0]?.name ?? appt.service}
                                    {summaries}
                                  </>
                                )}
                              </td>
                              <td className="text-muted">
                                {dotColors.map((color, index) => (
                                  <OpColorDot color={color} key={`${appt.id}-dot-${index}`} />
                                ))}
                                {operatorText}
                              </td>
                              <td>
                                <span className={`appointments-status-badge ${badge.className}`}>{badge.label}</span>
                              </td>
                              <td className="text-end">
                                {/* Azioni legacy: SOLO Modifica (drawer quick-booking via
                                    data-qb-edit) + Elimina per le prenotazioni Annullate.
                                    "Incassa" NON esiste nel legacy. */}
                                <a className="btn btn-sm btn-outline-secondary" href="#" data-qb-edit={appt.id}>
                                  Modifica
                                </a>
                                {!deleteLocked ? (
                                  <>
                                    {" "}
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
                                  </>
                                ) : null}
                              </td>
                            </tr>
                            {/* Conditional rendering: le righe figlie esistono nel DOM
                                SOLO quando espanso. Niente più classi Bootstrap
                                collapse/show né display inline (che dipendevano dal CSS
                                globale .collapse:not(.show) e dal plugin Collapse); così
                                il toggle è puro stato React, deterministico in ogni
                                browser. */}
                            {isMulti && expanded &&
                              lines.map((line, index) => (
                                <tr
                                  // Key univoca per SEGMENTO: due segmenti dello stesso
                                  // servizio (serviceId identico) collidevano; index la
                                  // rende comunque univoca anche senza segmentId.
                                  key={`${appt.id}-seg-${line.segmentId ?? line.serviceId}-${index}`}
                                  className={`ms-child ms-children-${appt.id}`}
                                  data-ms-child={appt.id}
                                >
                                  <td></td>
                                  <td className="text-muted">
                                    <span className="ms-indent">↳</span> {line.time ?? ""}
                                    {line.endTime ? ` → ${line.endTime}` : ""}
                                  </td>
                                  <td></td>
                                  <td></td>
                                  <td className="text-muted">{line.name || "—"}</td>
                                  <td className="text-muted">
                                    <OpColorDot color={line.staffColor} />
                                    {line.staffName || "—"}
                                  </td>
                                  <td>
                                    <span className={`appointments-status-badge ${badge.className}`}>{badge.label}</span>
                                  </td>
                                  <td className="text-end">
                                    {line.segmentId ? (
                                      <div className="btn-group" role="group" aria-label="Riordina multi-servizio">
                                        <button
                                          type="button"
                                          className="btn btn-sm btn-outline-secondary ms-seg-move"
                                          title="Sposta prima"
                                          data-ms-move="up"
                                          disabled={swapBusy || index === 0}
                                          onClick={() => void swapSegment(appt.id, line.segmentId as number, "up")}
                                        >
                                          <i className="bi bi-arrow-up"></i>
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-sm btn-outline-secondary ms-seg-move"
                                          title="Sposta dopo"
                                          data-ms-move="down"
                                          disabled={swapBusy || index === lines.length - 1}
                                          onClick={() => void swapSegment(appt.id, line.segmentId as number, "down")}
                                        >
                                          <i className="bi bi-arrow-down"></i>
                                        </button>
                                      </div>
                                    ) : (
                                      <span className="text-muted small">—</span>
                                    )}
                                  </td>
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
          </>
        )}
      </div>

      {/* Toast riordino legacy (appointments.js toast, autohide). */}
      {toastText ? (
        <div
          className="toast show position-fixed bottom-0 end-0 m-3"
          role="status"
          aria-live="polite"
          style={{ zIndex: 1090 }}
        >
          <div className="d-flex">
            <div className="toast-body">{toastText}</div>
            <button type="button" className="btn-close me-2 m-auto" aria-label="Chiudi" onClick={() => setToastText("")}></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
