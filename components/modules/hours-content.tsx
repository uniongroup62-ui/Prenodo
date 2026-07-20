"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP "Orari & chiusure" settings page (app/pages/hours.php),
// reproducing the original Bootstrap markup verbatim: View::alert flash ABOVE the
// bs-page-header, nav-pills tabs (Orari / Chiusure / Straordinari), the weekly
// hours card form (with the hours.js live validation: setCustomValidity +
// is-invalid + min hints + submit block) and the Chiusure / Straordinari
// add+list cards.
//
// Data: the DB-backed /api/manage/resources route (section=hours) returns the
// location list, the per-weekday business_hours rows, the grouped `closures`
// ranges and the grouped `exceptions` ranges. The tabs persist add/delete via
// JSON POSTs to the same route (actions hours_save / closure_save /
// closure_delete_range / exception_save / exception_delete_range); the legacy
// redirect flash (?msg=Orari salvati / Chiusura salvata / ...) becomes a local
// success alert with the same texts.

type ApiLocation = {
  id: number;
  name: string;
  isActive?: boolean;
};

type ClosureRange = {
  start: string;
  end: string;
  reason: string;
  ids: number[];
};

type ExceptionRange = {
  start: string;
  end: string;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  note: string;
};

type BusinessHourRow = {
  dow: number;
  opens: string;
  closes: string;
  opens2: string;
  closes2: string;
  isClosed: boolean;
};

type ResourcesContext = {
  ok?: boolean;
  activeLocationId?: number;
  locations?: ApiLocation[];
  hours?: BusinessHourRow[];
  closures?: ClosureRange[];
  exceptions?: ExceptionRange[];
  canSettingsLocation?: boolean;
};

type HoursTabKey = "hours" | "closures" | "exceptions";

// PHP renders days starting at DOW 0 = Domenica through DOW 6 = Sabato.
const DAYS: Array<{ dow: number; label: string }> = [
  { dow: 0, label: "Domenica" },
  { dow: 1, label: "Lunedì" },
  { dow: 2, label: "Martedì" },
  { dow: 3, label: "Mercoledì" },
  { dow: 4, label: "Giovedì" },
  { dow: 5, label: "Venerdì" },
  { dow: 6, label: "Sabato" },
];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Format an ISO YYYY-MM-DD as the legacy d/m/Y display.
function formatItalianDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function trimTime(value: string): string {
  return String(value || "").slice(0, 5);
}

function normalizeTab(value: string | undefined): HoursTabKey {
  return value === "closures" || value === "exceptions" ? value : "hours";
}

type Flash = { text: string; type: "success" | "danger" };

export function HoursContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { tab?: string; location_id?: string; msg?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [locationId, setLocationId] = useState<number>(() => {
    const parsed = Number(initialQuery?.location_id ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  });
  const [tab, setTab] = useState<HoursTabKey>(() => normalizeTab(initialQuery?.tab));
  const [hours, setHours] = useState<BusinessHourRow[]>([]);
  const [closures, setClosures] = useState<ClosureRange[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRange[]>([]);
  const [locationsCount, setLocationsCount] = useState(1);
  const [canSettingsLocation, setCanSettingsLocation] = useState(true);
  const [loading, setLoading] = useState(true);
  // Flash legacy (View::alert sopra il page header): i redirect ?msg= diventano
  // alert success locali con gli stessi testi; gli errori server sono danger.
  const [flash, setFlash] = useState<Flash | null>(() =>
    initialQuery?.msg ? { text: String(initialQuery.msg), type: "success" } : null,
  );

  const showFlash = useCallback((next: Flash | null) => {
    setFlash(next);
    if (next && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(() => {
    // Note: `loading` starts true and is only cleared in .finally(); we avoid a
    // synchronous setState here so the effect that calls load() stays side-effect
    // free on the synchronous path.
    const qs = new URLSearchParams({ slug, section: "hours" });
    if (locationId > 0) qs.set("location_id", String(locationId));
    fetch(`/api/manage/resources?${qs.toString()}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ResourcesContext) => {
        const locs: ApiLocation[] = Array.isArray(j.locations) ? j.locations : [];
        setHours(Array.isArray(j.hours) ? j.hours : []);
        setClosures(Array.isArray(j.closures) ? j.closures : []);
        setExceptions(Array.isArray(j.exceptions) ? j.exceptions : []);
        setLocationsCount(locs.length || 1);
        if (typeof j.canSettingsLocation === "boolean") setCanSettingsLocation(j.canSettingsLocation);
        setLocationId((prev) => (prev > 0 ? prev : Number(j.activeLocationId ?? locs[0]?.id ?? 0)));
      })
      .catch(() => {
        setHours([]);
        setClosures([]);
        setExceptions([]);
      })
      .finally(() => setLoading(false));
  }, [slug, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  // Shared JSON POST to /api/manage/resources; on success shows the legacy
  // redirect-flash text (Orari salvati / Chiusura salvata / ...), on failure
  // the server error as danger alert (hours.php renders errors inline).
  const postAction = useCallback(
    async (body: Record<string, unknown>, successMsg: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ slug, location_id: locationId, ...body }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          showFlash({ text: String(json?.error || "Operazione non riuscita."), type: "danger" });
          return false;
        }
        // The route returns the refreshed list; reflect it immediately.
        if (Array.isArray(json?.closures)) setClosures(json.closures as ClosureRange[]);
        if (Array.isArray(json?.exceptions)) setExceptions(json.exceptions as ExceptionRange[]);
        showFlash({ text: successMsg, type: "success" });
        return true;
      } catch {
        showFlash({ text: "Errore di rete.", type: "danger" });
        return false;
      }
    },
    [slug, locationId, showFlash],
  );

  function pageHref(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`hours${suffix}`.replace("&", "?")}`;
  }

  function tabHref(target: HoursTabKey): string {
    return pageHref(`&tab=${target}&location_id=${locationId}`);
  }

  // Come la navigazione legacy: cambio tab = nuova pagina (flash azzerato,
  // URL aggiornato) senza però ricaricare la SPA.
  function switchTab(target: HoursTabKey) {
    setTab(target);
    setFlash(null);
    if (typeof window !== "undefined") window.history.replaceState(null, "", tabHref(target));
  }

  const navLinkBase = "nav-link";
  const subtitle = locationsCount > 1
    ? "Gestisci orari, chiusure e straordinari. Segue la sede selezionata nella barra superiore."
    : "Gestisci orari, chiusure e straordinari.";

  return (
    <div className="container-fluid">
      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Orari &amp; chiusure</h1>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
        {canSettingsLocation ? (
          <div className="bs-page-actions">
            <a className="btn btn-outline-primary" href={`/${encodeURIComponent(slug)}/settings`}>
              <i className="bi bi-building me-1" />
              Attivita
            </a>
          </div>
        ) : null}
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item">
          <a
            className={`${navLinkBase} ${tab === "hours" ? "active" : ""}`}
            href={tabHref("hours")}
            onClick={(e) => {
              e.preventDefault();
              switchTab("hours");
            }}
          >
            <i className="bi bi-clock me-1" />
            Orari
          </a>
        </li>
        <li className="nav-item">
          <a
            className={`${navLinkBase} ${tab === "closures" ? "active" : ""}`}
            href={tabHref("closures")}
            onClick={(e) => {
              e.preventDefault();
              switchTab("closures");
            }}
          >
            <i className="bi bi-calendar-x me-1" />
            Chiusure
          </a>
        </li>
        <li className="nav-item">
          <a
            className={`${navLinkBase} ${tab === "exceptions" ? "active" : ""}`}
            href={tabHref("exceptions")}
            onClick={(e) => {
              e.preventDefault();
              switchTab("exceptions");
            }}
          >
            <i className="bi bi-calendar2-week me-1" />
            Straordinari
          </a>
        </li>
      </ul>

      {tab === "hours" ? (
        <HoursTab
          locationId={locationId}
          hours={hours}
          onSave={async (rows) => {
            const ok = await postAction({ action: "hours_save", hours_json: JSON.stringify(rows) }, "Orari salvati");
            if (ok) load();
            return ok;
          }}
        />
      ) : tab === "closures" ? (
        <ClosuresTab loading={loading} closures={closures} onAction={postAction} />
      ) : (
        <ExceptionsTab loading={loading} exceptions={exceptions} onAction={postAction} />
      )}
      <InfoBox className="mt-3">
        <ul>
          <li>Gli orari globali valgono per tutte le sedi; se una sede ha orari propri, per quella sede vincono i suoi.</li>
          <li>Le chiusure e le aperture straordinarie per data vincono su tutto.</li>
          <li>Questi orari guidano il calendario e la prenotazione online.</li>
        </ul>
      </InfoBox>
    </div>
  );
}

// Editable weekly-hours row state (times as HH:MM, dow 0=Domenica..6=Sabato).
type HourRowState = { dow: number; opens: string; closes: string; opens2: string; closes2: string; isClosed: boolean };

// hours.js toMin: parseInt sulle parti, null se NaN.
function jsTimeToMin(value: string): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const h = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Controlled weekly-hours grid (port of the hours.php save_hours form +
// assets/js/pages/hours.js live validation): prefilled from the resources
// context and saved via POST action=hours_save (hours_json).
function HoursTab({
  locationId,
  hours,
  onSave,
}: {
  locationId: number;
  hours: BusinessHourRow[];
  onSave: (rows: Array<{ dow: number; opens: string; closes: string; opens2: string; closes2: string; is_closed: number }>) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<HourRowState[]>([]);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Hydrate/refresh the editable grid whenever the loaded hours (or sede) change.
  const hoursSig = useMemo(
    () => `${locationId}|${hours.map((h) => `${h.dow}:${h.opens}:${h.closes}:${h.opens2}:${h.closes2}:${h.isClosed ? 1 : 0}`).join(",")}`,
    [locationId, hours],
  );
  const [prevSig, setPrevSig] = useState("");
  if (hoursSig !== prevSig) {
    setPrevSig(hoursSig);
    setRows(
      DAYS.map((day) => {
        const h = hours.find((row) => row.dow === day.dow);
        return {
          dow: day.dow,
          opens: trimTime(h?.opens ?? ""),
          closes: trimTime(h?.closes ?? ""),
          opens2: trimTime(h?.opens2 ?? ""),
          closes2: trimTime(h?.closes2 ?? ""),
          isClosed: Boolean(h?.isClosed),
        };
      }),
    );
  }

  function patch(dow: number, changes: Partial<HourRowState>) {
    setRows((prev) => prev.map((r) => (r.dow === dow ? { ...r, ...changes } : r)));
  }

  // Port of hours.js validateDow: reads the (controlled) inputs from the DOM,
  // sets setCustomValidity + is-invalid + the min hints with the legacy texts.
  const validateDow = useCallback((dow: number): boolean => {
    const form = formRef.current;
    if (!form) return true;
    const get = (field: string) => form.querySelector<HTMLInputElement>(`input[name="hours[${dow}][${field}]"]`);
    const opens = get("opens");
    const closes = get("closes");
    const opens2 = get("opens2");
    const closes2 = get("closes2");
    const closedInput = get("is_closed");
    const setValidity = (input: HTMLInputElement | null, msg: string) => {
      if (!input) return;
      input.setCustomValidity(msg || "");
      input.classList.toggle("is-invalid", Boolean(msg));
    };
    const clearAll = () => [opens, closes, opens2, closes2].forEach((input) => setValidity(input, ""));

    if (closedInput?.checked) {
      clearAll();
      return true;
    }

    // Aggiorna i min per aiutare l'utente (hours.js 63-72).
    if (closes) {
      if (opens?.value) closes.min = opens.value;
      else closes.removeAttribute("min");
    }
    if (opens2) {
      if (closes?.value) opens2.min = closes.value;
      else opens2.removeAttribute("min");
    }
    if (closes2) {
      if (opens2?.value) closes2.min = opens2.value;
      else closes2.removeAttribute("min");
    }

    clearAll();
    let ok = true;

    const o = jsTimeToMin(opens?.value ?? "");
    const c = jsTimeToMin(closes?.value ?? "");
    if (!opens?.value || !closes?.value) {
      ok = false;
      if (!opens?.value) setValidity(opens, "Compila anche l'apertura");
      if (!closes?.value) setValidity(closes, "Compila anche la chiusura");
    } else if (o !== null && c !== null && c <= o) {
      ok = false;
      setValidity(closes, "La chiusura deve essere successiva all'apertura");
    }

    const o2 = jsTimeToMin(opens2?.value ?? "");
    const c2 = jsTimeToMin(closes2?.value ?? "");
    if (opens2?.value || closes2?.value) {
      // Split richiede la prima fascia
      if (!opens?.value || !closes?.value) {
        ok = false;
        setValidity(opens2, "Compila prima apertura/chiusura");
        setValidity(closes2, "Compila prima apertura/chiusura");
      } else if (!opens2?.value || !closes2?.value) {
        ok = false;
        if (!opens2?.value) setValidity(opens2, "Compila anche la riapertura");
        if (!closes2?.value) setValidity(closes2, "Compila anche la chiusura 2");
      } else {
        if (o2 !== null && c !== null && o2 < c) {
          ok = false;
          setValidity(opens2, "La riapertura deve essere uguale o successiva alla chiusura");
        }
        if (o2 !== null && c2 !== null && c2 <= o2) {
          ok = false;
          setValidity(closes2, "La chiusura 2 deve essere successiva alla riapertura");
        }
      }
    }

    return ok;
  }, []);

  // Validazione live come il listener 'input' + initial sync di hours.js: gira
  // dopo ogni render con i valori aggiornati (gated finché la griglia è vuota
  // per non marcare is-invalid durante il primo load).
  useEffect(() => {
    if (rows.length !== DAYS.length) return;
    for (const day of DAYS) validateDow(day.dow);
  }, [rows, validateDow]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Blocco submit se invalido (hours.js 222-238): focus + reportValidity
    // sul primo campo marcato is-invalid.
    let allOk = true;
    for (const day of DAYS) {
      if (!validateDow(day.dow)) allOk = false;
    }
    if (!allOk) {
      const firstInvalid = formRef.current?.querySelector<HTMLInputElement>("input.is-invalid");
      if (firstInvalid) {
        try {
          firstInvalid.focus();
          firstInvalid.reportValidity();
        } catch {
          // ignore focus errors
        }
      }
      return;
    }
    setSaving(true);
    try {
      await onSave(rows.map((r) => ({ dow: r.dow, opens: r.opens, closes: r.closes, opens2: r.opens2, closes2: r.closes2, is_closed: r.isClosed ? 1 : 0 })));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-3">
      <form method="post" onSubmit={submit} ref={formRef} noValidate>
        <input type="hidden" name="location_id" value={locationId} />
        <div className="table-responsive">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th>Giorno</th>
                <th>Apertura</th>
                <th>Chiusura</th>
                <th className="text-nowrap">Orario spezzato</th>
                <th>Chiuso</th>
              </tr>
            </thead>
            <tbody id="hoursTable">
              {DAYS.map((day) => {
                const row = rows.find((r) => r.dow === day.dow) ?? { dow: day.dow, opens: "", closes: "", opens2: "", closes2: "", isClosed: false };
                return <HoursRow key={day.dow} label={day.label} row={row} onPatch={(changes) => patch(day.dow, changes)} />;
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 d-flex justify-content-end">
          <button className="btn btn-primary" type="submit" disabled={saving}>
            <i className="bi bi-check2-circle me-1" />
            {saving ? "Salvataggio…" : "Salva orari"}
          </button>
        </div>
      </form>
    </div>
  );
}

function HoursRow({
  label,
  row,
  onPatch,
}: {
  label: string;
  row: HourRowState;
  onPatch: (changes: Partial<HourRowState>) => void;
}) {
  // The split row stays visible once opened even with empty times (like the
  // PHP UI); closing the day hides row+buttons WITHOUT clearing the values and
  // drops the forced-open state (hours.js setSplit/syncRow).
  const [splitForced, setSplitForced] = useState(false);
  const hasSplitValues = row.opens2 !== "" || row.closes2 !== "";
  const splitOpen = (splitForced || hasSplitValues) && !row.isClosed;
  const dow = row.dow;

  function focusSplit() {
    // focus sul primo campo della seconda fascia (hours.js 155-157)
    setTimeout(() => {
      try {
        document.querySelector<HTMLInputElement>(`input[name="hours[${dow}][opens2]"]`)?.focus();
      } catch {
        // ignore
      }
    }, 0);
  }

  return (
    <>
      <tr className="hours-row" data-role="main" data-dow={dow}>
        <td className="fw-semibold">{label}</td>
        <td>
          <input className="form-control" type="time" name={`hours[${dow}][opens]`} value={row.opens} onChange={(e) => onPatch({ opens: e.target.value })} />
        </td>
        <td>
          <input className="form-control" type="time" name={`hours[${dow}][closes]`} value={row.closes} onChange={(e) => onPatch({ closes: e.target.value })} />
        </td>
        <td className="text-nowrap">
          <button
            type="button"
            className={`btn btn-sm btn-outline-secondary js-add-split ${splitOpen || row.isClosed ? "d-none" : ""}`}
            data-dow={dow}
            onClick={() => {
              setSplitForced(true);
              focusSplit();
            }}
          >
            <i className="bi bi-plus-lg me-1" />
            Aggiungi orario spezzato
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-outline-danger js-remove-split ${splitOpen && !row.isClosed ? "" : "d-none"}`}
            data-dow={dow}
            onClick={() => {
              if (!window.confirm("Rimuovere l'orario spezzato per questo giorno?")) return;
              setSplitForced(false);
              onPatch({ opens2: "", closes2: "" });
            }}
          >
            <i className="bi bi-x-lg me-1" />
            Rimuovi
          </button>
        </td>
        <td>
          <div className="form-check">
            <input
              className="form-check-input js-closed"
              type="checkbox"
              name={`hours[${dow}][is_closed]`}
              data-dow={dow}
              checked={row.isClosed}
              onChange={(e) => {
                if (e.target.checked) setSplitForced(false);
                onPatch({ isClosed: e.target.checked });
              }}
            />
          </div>
        </td>
      </tr>
      <tr className={`split-row ${splitOpen ? "" : "d-none"}`} data-role="split" data-dow={dow}>
        <td></td>
        <td>
          <label className="form-label small text-muted mb-1">Riapertura</label>
          <input className="form-control" type="time" name={`hours[${dow}][opens2]`} value={row.opens2} onChange={(e) => onPatch({ opens2: e.target.value })} />
        </td>
        <td>
          <label className="form-label small text-muted mb-1">Chiusura 2</label>
          <input className="form-control" type="time" name={`hours[${dow}][closes2]`} value={row.closes2} onChange={(e) => onPatch({ closes2: e.target.value })} />
        </td>
        <td className="small text-muted">Orario spezzato</td>
        <td></td>
      </tr>
    </>
  );
}

function ClosuresTab({
  loading,
  closures,
  onAction,
}: {
  loading: boolean;
  closures: ClosureRange[];
  onAction: (body: Record<string, unknown>, successMsg: string) => Promise<boolean>;
}) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [kind, setKind] = useState("Chiusura");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const ok = await onAction(
      {
        action: "closure_save",
        date_from: dateFrom,
        date_to: dateTo,
        kind,
        note,
      },
      "Chiusura salvata",
    );
    setSaving(false);
    if (ok) {
      setDateFrom("");
      setDateTo("");
      setKind("Chiusura");
      setNote("");
    }
  }

  async function remove(range: ClosureRange) {
    if (!window.confirm("Eliminare questo periodo?")) return;
    await onAction(
      {
        action: "closure_delete_range",
        // Stored desc: end is the older bound, start the newer bound. The legacy
        // delete link passes from=end & to=start; the lib re-orders internally.
        from: range.end,
        to: range.start,
        reason: range.reason ?? "",
      },
      "Chiusura eliminata",
    );
  }

  return (
    <div className="row g-3">
      <div className="col-lg-5">
        <div className="card p-3">
          <div className="fw-semibold mb-2">Aggiungi chiusura (ferie / chiusura negozio)</div>
          <form method="post" onSubmit={submit}>
            <div className="row g-2">
              <div className="col-md-6">
                <label className="form-label small text-muted">Dal</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_from"
                  required
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label small text-muted">Al (opz.)</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_to"
                  placeholder="Se vuoto = 1 giorno"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label small text-muted">Tipo</label>
                <select
                  className="form-select"
                  name="kind"
                  required
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="Chiusura">Chiusura negozio</option>
                  <option value="Ferie">Ferie</option>
                </select>
              </div>
              <div className="col-md-6">
                <label className="form-label small text-muted">Nota (opz.)</label>
                <input
                  className="form-control"
                  name="note"
                  placeholder="Es. Festività"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
            <button className="btn btn-primary mt-3" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              Salva
            </button>
          </form>
        </div>
      </div>
      <div className="col-lg-7">
        <div className="card">
          <div className="card-header fw-semibold">Chiusure</div>
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Periodo</th>
                  <th>Motivo</th>
                  <th className="text-end"> </th>
                </tr>
              </thead>
              <tbody>
                {closures.map((r, i) => (
                  <tr key={`${r.start}-${r.end}-${i}`}>
                    <td className="fw-semibold">
                      {r.start === r.end ? (
                        formatItalianDate(r.start)
                      ) : (
                        <>
                          {formatItalianDate(r.end)} → {formatItalianDate(r.start)}
                        </>
                      )}
                    </td>
                    <td className="text-muted">{r.reason || "—"}</td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => remove(r)}
                      >
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && closures.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-muted p-3">
                      Nessuna chiusura.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExceptionsTab({
  loading,
  exceptions,
  onAction,
}: {
  loading: boolean;
  exceptions: ExceptionRange[];
  onAction: (body: Record<string, unknown>, successMsg: string) => Promise<boolean>;
}) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [note, setNote] = useState("");
  const [opens, setOpens] = useState("");
  const [closes, setCloses] = useState("");
  const [opens2, setOpens2] = useState("");
  const [closes2, setCloses2] = useState("");
  const [splitOpen, setSplitOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const ok = await onAction(
      {
        action: "exception_save",
        date_from: dateFrom,
        date_to: dateTo,
        note,
        opens,
        closes,
        opens2: splitOpen ? opens2 : "",
        closes2: splitOpen ? closes2 : "",
      },
      "Straordinario salvato",
    );
    setSaving(false);
    if (ok) {
      setDateFrom("");
      setDateTo("");
      setNote("");
      setOpens("");
      setCloses("");
      setOpens2("");
      setCloses2("");
      setSplitOpen(false);
    }
  }

  async function remove(range: ExceptionRange) {
    if (!window.confirm("Eliminare questo periodo?")) return;
    await onAction(
      {
        action: "exception_delete_range",
        from: range.end,
        to: range.start,
      },
      "Straordinario eliminato",
    );
  }

  function removeSplit() {
    if (!window.confirm("Rimuovere l'orario spezzato?")) return;
    setSplitOpen(false);
    setOpens2("");
    setCloses2("");
  }

  function rangeHoursLabel(r: ExceptionRange): string {
    const o1 = trimTime(r.opens);
    const c1 = trimTime(r.closes);
    const o2 = trimTime(r.opens2);
    const c2 = trimTime(r.closes2);
    let label = o1 && c1 ? `${o1} - ${c1}` : "—";
    if (o2 && c2) label += ` / ${o2} - ${c2}`;
    return label;
  }

  return (
    <div className="row g-3">
      <div className="col-lg-5">
        <div className="card p-3">
          <div className="fw-semibold mb-2">Aggiungi apertura straordinaria</div>
          <form method="post" id="exceptionForm" onSubmit={submit}>
            <div className="row g-2">
              <div className="col-md-6">
                <label className="form-label small text-muted">Dal</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_from"
                  required
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label small text-muted">Al (opz.)</label>
                <input
                  className="form-control"
                  type="date"
                  name="date_to"
                  placeholder="Se vuoto = 1 giorno"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label small text-muted">Nota (opz.)</label>
                <input
                  className="form-control"
                  name="note"
                  placeholder="Es. Festività, evento"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              <div className="col-12" id="exceptionHoursBox">
                <div className="border rounded p-2">
                  <div className="row g-2">
                    <div className="col-md-6">
                      <label className="form-label small text-muted">Apertura</label>
                      <input
                        className="form-control"
                        type="time"
                        name="opens"
                        id="exceptionOpens"
                        required
                        value={opens}
                        onChange={(e) => setOpens(e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small text-muted">Chiusura</label>
                      <input
                        className="form-control"
                        type="time"
                        name="closes"
                        id="exceptionCloses"
                        required
                        value={closes}
                        onChange={(e) => setCloses(e.target.value)}
                      />
                    </div>
                    <div className="col-12 text-nowrap">
                      <button
                        type="button"
                        className={`btn btn-sm btn-outline-secondary ${splitOpen ? "d-none" : ""}`}
                        id="btnAddExceptionSplit"
                        onClick={() => setSplitOpen(true)}
                      >
                        <i className="bi bi-plus-lg me-1" />
                        Aggiungi orario spezzato
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm btn-outline-danger ${splitOpen ? "" : "d-none"}`}
                        id="btnRemoveExceptionSplit"
                        onClick={removeSplit}
                      >
                        <i className="bi bi-x-lg me-1" />
                        Rimuovi
                      </button>
                    </div>
                    <div className={`col-12 ${splitOpen ? "" : "d-none"}`} id="exceptionSplitRow">
                      <div className="row g-2">
                        <div className="col-md-6">
                          <label className="form-label small text-muted">Riapertura</label>
                          <input
                            className="form-control"
                            type="time"
                            name="opens2"
                            id="exceptionOpens2"
                            value={opens2}
                            onChange={(e) => setOpens2(e.target.value)}
                          />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label small text-muted">Chiusura 2</label>
                          <input
                            className="form-control"
                            type="time"
                            name="closes2"
                            id="exceptionCloses2"
                            value={closes2}
                            onChange={(e) => setCloses2(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="small text-muted mt-2">
                    Le aperture straordinarie hanno priorità sugli orari standard del tab <strong>Orari</strong>, ma non
                    possono sovrapporsi alle date presenti nel tab <strong>Chiusure</strong>.
                  </div>
                </div>
              </div>
            </div>
            <button className="btn btn-primary mt-3" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              Salva
            </button>
          </form>
        </div>
      </div>

      <div className="col-lg-7">
        <div className="card">
          <div className="card-header fw-semibold">Aperture straordinarie</div>
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Periodo</th>
                  <th>Orario</th>
                  <th>Nota</th>
                  <th className="text-end"> </th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((r, i) => (
                  <tr key={`${r.start}-${r.end}-${i}`}>
                    <td className="fw-semibold">
                      {r.start === r.end ? (
                        formatItalianDate(r.start)
                      ) : (
                        <>
                          {formatItalianDate(r.end)} → {formatItalianDate(r.start)}
                        </>
                      )}
                    </td>
                    <td className="text-muted">{rangeHoursLabel(r)}</td>
                    <td className="text-muted">{r.note || "—"}</td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => remove(r)}
                      >
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && exceptions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-muted p-3">
                      Nessuna apertura straordinaria.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
