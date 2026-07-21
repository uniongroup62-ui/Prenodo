"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flashNavigate, takeFlash } from "./flash";

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
  // Cabine libere sullo slot di riferimento (legacy cabin_avail_by_service).
  cabinsEnabled: boolean;
  cabinAvail: Record<number, Array<{ id: number; name: string }>>;
};

function fmtDateIt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Port di fmt_money legacy = number_format($n, 2, ',', '.') — virgola decimale E
// punto di raggruppamento migliaia (toLocaleString non raggruppa 1000-9999).
function fmtMoney(value: number): string {
  const n = Number(value) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${grouped},${dec}`;
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

// ISO YYYY-MM-DD ± giorni (range redirect legacy: min-1 / max+1).
function shiftIsoDay(iso: string, days: number): string {
  const [y, mo, d] = iso.split("-").map(Number);
  const date = new Date(y, (mo || 1) - 1, (d || 1) + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "HH:MM" + minuti, clamp a 23:59 (recomputeEndTime legacy).
function addMinutesToTime(hhmm: string, minutes: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return hhmm;
  const total = Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + Math.max(0, minutes));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// Prossima occorrenza del giorno-settimana `dow` (0=Dom..6=Sab) STRETTAMENTE dopo
// oggi, partendo dalla data base (mai retroattiva) — normalizeStartDate legacy
// (guard 370 iterazioni).
function nextWeekdayOccurrence(baseIso: string, dow: number): string {
  const today = todayIso();
  let iso = baseIso && baseIso > today ? baseIso : today;
  const parse = (s: string) => {
    const [y, mo, d] = s.split("-").map(Number);
    return new Date(y, (mo || 1) - 1, d || 1);
  };
  const d = parse(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 370; i++) {
    iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (d.getDay() === dow && iso > today) return iso;
    d.setDate(d.getDate() + 1);
  }
  return iso;
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

  // Cabine (legacy appointments_plan.js 441-548): select per servizio GATED fino
  // all'Anteprima ("(Premi Anteprima)"); dopo, le opzioni sono le cabine LIBERE
  // sullo slot di riferimento. cabinsEnabled è noto dal probe cabins_for_services.
  const [cabinsEnabled, setCabinsEnabled] = useState(false);
  const [cabinPerService, setCabinPerService] = useState<Record<number, number>>({});

  // Form state. Default legacy: time_to = time_from = 09:00 (orario FISSO finché
  // l'auto-calcolo non lo sposta a from + durata servizi — recomputeEndTime legacy).
  const [startDate, setStartDate] = useState(todayIso());
  const [repeat, setRepeat] = useState("1");
  const [recurrence, setRecurrence] = useState("weekly");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [timeFrom, setTimeFrom] = useState("09:00");
  const [timeTo, setTimeTo] = useState("09:00");

  // Preview / create state.
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // Alert successo da redirect (?msg — legacy appointments_plan.php 1567/2052:
  // post-create senza appointments.manage si resta sul planner col messaggio).
  const [planMsg, setPlanMsg] = useState<string | null>(null);

  // Gate legacy (appointments_plan.php 4-12): requirePerm('appointments.plan') →
  // card 'Accesso negato'; link Lista solo con appointments.manage, Calendario
  // solo con calendar.view. Flag letti da action=plan_context al mount.
  const [accessDenied, setAccessDenied] = useState(false);
  const [canManageAppointments, setCanManageAppointments] = useState(true);
  const [canSeeCalendar, setCanSeeCalendar] = useState(true);

  // Snapshot del body usato per l'Anteprima: il form "Crea appuntamenti" legacy
  // ri-posta i valori PREVISUALIZZATI (hidden nel secondo form), non lo stato
  // corrente del form — solo le cabine scelte dopo l'anteprima vengono sincate
  // (plannerSyncCabinsToCreateForm).
  const previewBodyRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}&action=plan_context`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j || j.ok !== true || j.canPlan === false) {
          setAccessDenied(true);
          return;
        }
        setCanManageAppointments(j.canManageAppointments !== false);
        setCanSeeCalendar(j.canSeeCalendar !== false);
      })
      .catch(() => undefined);
    // Flash: sessionStorage (moderno) + ?msg come fallback per vecchi link
    // (in microtask: nessun setState sincrono nell'effect).
    Promise.resolve().then(() => {
      if (!alive || typeof window === "undefined") return;
      const taken = takeFlash();
      const urlMsg = String(taken.msg ?? new URLSearchParams(window.location.search).get("msg") ?? "").trim();
      if (urlMsg) setPlanMsg(urlMsg);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

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
        // Categoria senza nome = 'Senza categoria' (legacy appointments_plan.php 2134).
        groups.push({ groupId: gid, title: String(svc.categoryName ?? "").trim() || "Senza categoria", items: [] });
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
  // (Microtask: niente setState sincrono nell'effect; l'update funzionale legge
  // comunque lo stato più recente.)
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
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
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServiceIds, staff]);

  // Probe cabine (legacy CABINS_ENABLED, server-rendered nel config PHP): al primo
  // servizio selezionato una chiamata a cabins_for_services rivela se il tenant ha
  // cabine attive — da lì in poi la select "Cabina" gated compare sotto l'operatore.
  const cabinProbeRef = useRef(false);
  useEffect(() => {
    if (cabinProbeRef.current || selectedServiceIds.length === 0) return;
    cabinProbeRef.current = true;
    const startsAt = `${todayIso()} 09:00:00`;
    fetch(
      `/api/manage/appointments?slug=${encodeURIComponent(slug)}&action=cabins_for_services&service_ids=${selectedServiceIds.join(",")}&starts_at=${encodeURIComponent(startsAt)}`,
      { headers: { "x-tenant-slug": slug } },
    )
      .then((r) => r.json())
      .then((j) => setCabinsEnabled(Array.isArray(j?.cabins) && j.cabins.length > 0))
      .catch(() => setCabinsEnabled(false));
  }, [selectedServiceIds, slug]);

  // Riconciliazione scelte cabina all'arrivo dell'anteprima (legacy 523-544):
  // scelta precedente mantenuta se ancora libera, altrimenti la PRIMA cabina;
  // con una sola libera auto-selezionata; con zero la scelta cade.
  useEffect(() => {
    if (!preview?.cabinsEnabled) return;
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setCabinPerService((prev) => {
        const next: Record<number, number> = {};
        for (const sid of selectedServiceIds) {
          const free = preview.cabinAvail[sid] ?? [];
          if (free.length === 0) continue;
          const keep = prev[sid] && free.some((c) => c.id === prev[sid]) ? prev[sid] : free[0].id;
          next[sid] = keep;
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // ---- Dinamiche legacy (appointments_plan.js) ----
  // recomputeEndTime (618-697): "Alle ore" = "Dalle ore" + durata totale servizi
  // (clamp 23:59); il valore non può scendere sotto quel minimo.
  const totalDurationMin = useMemo(
    () => selectedServices.reduce((sum, svc) => sum + Math.max(0, Number(svc.durationMin ?? 0) || 0), 0),
    [selectedServices],
  );
  const minTimeTo = useMemo(() => addMinutesToTime(timeFrom, totalDurationMin), [timeFrom, totalDurationMin]);
  useEffect(() => {
    // Legacy: SOLO clamp verso l'alto (if (toEl.value < min) toEl.value = min) —
    // una finestra più ampia scelta dall'utente NON viene ristretta al minimo.
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setTimeTo((prev) => (prev < minTimeTo ? minTimeTo : prev));
    });
    return () => {
      alive = false;
    };
  }, [minTimeTo]);

  // normalizeStartDate (699-788): con giorni selezionati, "Dal giorno" è ancorato al
  // PRIMO giorno selezionato (ordine Lun→Dom) alla prossima occorrenza DOPO oggi;
  // mai retroattivo. Idempotente: se la data rispetta già il vincolo non cambia.
  useEffect(() => {
    if (!weekdays.length) return;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const first = order.find((d) => weekdays.includes(d));
    if (first === undefined) return;
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setStartDate((prev) => nextWeekdayOccurrence(prev, first));
    });
    return () => {
      alive = false;
    };
  }, [weekdays, startDate]);

  // Client search inside the modal.
  useEffect(() => {
    if (!findOpen) return;
    const q = findQuery.trim();
    const handle = window.setTimeout(() => {
      // Search legacy (api_clients search, planner JS 120: exclude_blocked=1):
      // tenant-wide senza filtro sede + clienti bloccati esclusi.
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(q)}&all_locations=1&exclude_blocked=1`, {
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
    // planSetSelected legacy (appointments_plan.js 75-78): azzera i campi del
    // nuovo cliente per evitare una creazione involontaria.
    setNewFullName("");
    setNewPhone("");
    setNewEmail("");
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
    const cabinMap: Record<number, number> = {};
    for (const [sid, cid] of Object.entries(cabinPerService)) {
      if (Number(cid) > 0) cabinMap[Number(sid)] = Number(cid);
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
      cabin_map: JSON.stringify(cabinMap),
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
    cabinPerService,
    recurrence,
    weekdays,
    startDate,
    timeFrom,
    timeTo,
  ]);

  async function submitPreview(e: React.FormEvent) {
    e.preventDefault();
    setPlanError(null);
    setPlanMsg(null);
    setPreviewing(true);
    try {
      // Il form "Crea" legacy ri-posta ESATTAMENTE questi valori (hidden):
      // congelo lo snapshot; solo le cabine post-anteprima verranno sincate.
      const body = buildBody();
      previewBodyRef.current = body;
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "plan_preview", ...body }),
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
        cabinsEnabled: j.cabinsEnabled === true,
        cabinAvail: (j.cabinAvail && typeof j.cabinAvail === "object" ? j.cabinAvail : {}) as PreviewData["cabinAvail"],
      });
      if (j.cabinsEnabled === true) setCabinsEnabled(true);
    } catch {
      setPreview(null);
      setPlanError("Errore di rete durante l'anteprima.");
    } finally {
      setPreviewing(false);
    }
  }

  async function submitCreate() {
    setPlanError(null);
    setPlanMsg(null);
    setCreating(true);
    try {
      // Valori PREVISUALIZZATI (snapshot) + cabine correnti: come il form create
      // legacy (hidden dal POST di anteprima + plannerSyncCabinsToCreateForm).
      const base = previewBodyRef.current ?? buildBody();
      const cabinMap: Record<number, number> = {};
      for (const [sid, cid] of Object.entries(cabinPerService)) {
        if (Number(cid) > 0) cabinMap[Number(sid)] = Number(cid);
      }
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "plan_create", ...base, cabin_map: JSON.stringify(cabinMap) }),
      });
      const j = await res.json();
      if (!j.ok) {
        setPlanError(String(j.error ?? "Errore creazione."));
        return;
      }
      // Redirect LEGACY (appointments_plan.php 2013-2023): torna alla Lista
      // appuntamenti con range date allargato ±1 giorno, ?created=<id,id> (gli
      // appuntamenti appena creati restano visibili anche fuori range) e il
      // messaggio verbatim "Pianificazione completata: creati N appuntamenti".
      const created = Number(j.created ?? 0);
      const successMessage = `Pianificazione completata: creati ${created} appuntamenti`;
      // Senza appointments.manage il legacy resta sul planner col solo ?msg
      // (appointments_plan.php 2025).
      if (!canManageAppointments) {
        flashNavigate(`/${encodeURIComponent(slug)}/appointments_plan`, { msg: successMessage });
        return;
      }
      const details = (Array.isArray(j.details) ? j.details : []) as Array<{ date?: string; ok?: boolean; appointmentId?: number }>;
      const okRows = details.filter((d) => d.ok);
      const createdIds = okRows.map((d) => Number(d.appointmentId ?? 0)).filter((n) => n > 0);
      const okDates = okRows.map((d) => String(d.date ?? "")).filter(Boolean).sort();
      const params = new URLSearchParams();
      if (okDates.length) {
        params.set("from", shiftIsoDay(okDates[0], -1));
        params.set("to", shiftIsoDay(okDates[okDates.length - 1], 1));
      }
      if (createdIds.length) params.set("created", createdIds.join(","));
      flashNavigate(`/${encodeURIComponent(slug)}/appointments?${params.toString()}`, { msg: successMessage });
      return;
    } catch {
      setPlanError("Errore di rete durante la creazione.");
    } finally {
      setCreating(false);
    }
  }

  // Auth::requirePerm('appointments.plan') legacy (Auth.php 494-505): 403 con
  // card 'Accesso negato' al posto della pagina.
  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Non hai i permessi per accedere a questa sezione.</div>
        </div>
      </div>
    );
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
            {/* Link gated come nel legacy (appointments_plan.php 2039-2046). */}
            {canManageAppointments ? (
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/appointments`}>
                <i className="bi bi-list-task me-1" />
                Lista
              </a>
            ) : null}
            {canSeeCalendar ? (
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/calendar`}>
                <i className="bi bi-calendar-week me-1" />
                Calendario
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {/* Alert a livello pagina come il legacy (2052-2057): successo da ?msg,
          errore dal POST — la colonna Anteprima mostra comunque l'empty-state. */}
      {planMsg ? <div className="alert alert-success">{planMsg}</div> : null}
      {planError ? <div className="alert alert-danger">{planError}</div> : null}

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
                      // Stati legacy (appointments_plan.js 385-425): 0 eligibili ->
                      // select disabled "Nessun operatore"; 1 -> auto-assegnato e
                      // select disabled col nome; >1 -> placeholder "(seleziona)".
                      // Cabine legacy (appointments_plan.js 441-548): gated finché non
                      // c'è l'anteprima; poi 0 libere -> "Nessuna cabina" disabled,
                      // 1 -> auto-selezionata disabled, >1 -> select (niente "(Auto)").
                      const freeCabins = preview?.cabinsEnabled ? preview.cabinAvail[svc.id] ?? [] : [];
                      return (
                        <div className="mb-2" key={svc.id}>
                          <label className="form-label small mb-1">{svc.name}</label>
                          {eligible.length === 0 ? (
                            <select className="form-select form-select-sm" disabled>
                              <option>Nessun operatore</option>
                            </select>
                          ) : eligible.length === 1 ? (
                            <select className="form-select form-select-sm" value={eligible[0].id} disabled onChange={() => undefined}>
                              <option value={eligible[0].id}>{staffName(eligible[0])}</option>
                            </select>
                          ) : (
                            <select
                              className="form-select form-select-sm"
                              name={`staff_map[${svc.id}]`}
                              value={staffPerService[svc.id] ?? ""}
                              onChange={(e) =>
                                setStaffPerService((prev) => ({ ...prev, [svc.id]: Number(e.target.value) }))
                              }
                            >
                              <option value="">(seleziona)</option>
                              {eligible.map((s) => (
                                <option value={s.id} key={s.id}>{staffName(s)}</option>
                              ))}
                            </select>
                          )}
                          {cabinsEnabled ? (
                            <div className="d-flex align-items-center gap-2 mt-1">
                              <div className="small text-muted">Cabina</div>
                              {!preview ? (
                                <select className="form-select form-select-sm" style={{ maxWidth: 220 }} disabled>
                                  <option value="0">(Premi Anteprima)</option>
                                </select>
                              ) : freeCabins.length === 0 ? (
                                <select className="form-select form-select-sm" style={{ maxWidth: 220 }} disabled>
                                  <option value="">Nessuna cabina</option>
                                </select>
                              ) : freeCabins.length === 1 ? (
                                <select className="form-select form-select-sm" style={{ maxWidth: 220 }} value={freeCabins[0].id} disabled onChange={() => undefined}>
                                  <option value={freeCabins[0].id}>{freeCabins[0].name || `ID ${freeCabins[0].id}`}</option>
                                </select>
                              ) : (
                                <select
                                  className="form-select form-select-sm"
                                  style={{ maxWidth: 220 }}
                                  name={`cabin_map[${svc.id}]`}
                                  value={cabinPerService[svc.id] ?? freeCabins[0].id}
                                  onChange={(e) =>
                                    setCabinPerService((prev) => ({ ...prev, [svc.id]: Number(e.target.value) }))
                                  }
                                >
                                  {freeCabins.map((cb) => (
                                    <option value={cb.id} key={cb.id}>{cb.name || `ID ${cb.id}`}</option>
                                  ))}
                                </select>
                              )}
                            </div>
                          ) : null}
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
                {/* normalizeStartDate legacy: mai retroattivo (min oggi); con giorni
                    selezionati l'effect ancora la data al primo giorno (Lun→Dom). */}
                <input
                  type="date"
                  className="form-control"
                  id="plannerStartDate"
                  name="start_date"
                  value={startDate}
                  min={todayIso()}
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
                {/* recomputeEndTime legacy: min = "Dalle ore" + durata servizi; i valori
                    inferiori vengono bloccati (clamp al minimo). */}
                <input
                  type="time"
                  className="form-control"
                  id="plannerTimeTo"
                  name="time_to"
                  value={timeTo}
                  min={minTimeTo}
                  onChange={(e) => setTimeTo(e.target.value < minTimeTo ? minTimeTo : e.target.value)}
                  required
                />
              </div>

              <div className="col-12">
                <button className="btn btn-primary w-100" type="submit" disabled={previewing}>
                  <i className="bi bi-magic me-1" />
                  Anteprima
                </button>
                {/* Virgolette DRITTE come nel legacy (riga 2251), non tipografiche. */}
                <div className="form-text">Se &quot;Dalle ore&quot; e &quot;Alle ore&quot; coincidono, l&apos;orario è fisso. Altrimenti viene scelto il primo slot libero nella finestra.</div>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-7">
          <div className="card p-4">
            <div className="h5 mb-1">Anteprima</div>
            <div className="text-muted mb-3">Controllo disponibilità e riepilogo prima della creazione.</div>

            {/* Legacy 2263: l'empty-state compare ogni volta che non c'è una
                preview, anche accanto all'alert d'errore (a livello pagina). */}
            {!preview ? (
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
                  {/* Legacy: il bottone è SEMPRE attivo, anche con 0 righe OK — il
                      server risponde 'Nessuna prenotazione creabile (tutte non
                      disponibili).' (riga 1963). */}
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={submitCreate}
                    disabled={creating}
                  >
                    <i className="bi bi-check2-circle me-1" />
                    Crea appuntamenti
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
              {/* Render legacy (appointments_plan.js planRenderClients): nome in
                  text-primary + righe "Email:"/"Telefono:" ("—" se vuoti); stato
                  vuoto "Nessun risultato.". */}
              <div className="list-group" id="planClientFindResults">
                {findResults.length === 0 ? (
                  <div className="text-muted small p-2">Nessun risultato.</div>
                ) : (
                  findResults.map((c) => (
                    <button
                      type="button"
                      className="list-group-item list-group-item-action"
                      key={c.id}
                      onClick={() => pickClient(c)}
                    >
                      <div className="fw-semibold text-primary">{c.name}</div>
                      <div className="small text-muted">Email: {c.email || "—"}</div>
                      <div className="small text-muted">Telefono: {c.phone || "—"}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
