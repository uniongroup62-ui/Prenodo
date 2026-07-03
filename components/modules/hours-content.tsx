"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP "Orari & chiusure" settings page (app/pages/hours.php),
// reproducing the original Bootstrap markup verbatim: bs-page-header, nav-pills
// tabs (Orari / Chiusure / Straordinari), the weekly hours card form, and the
// Chiusure / Straordinari add+list cards.
//
// Data: the DB-backed /api/manage/resources route (section=hours) returns the
// location list, the per-weekday business_hours rows, the grouped `closures`
// ranges and the grouped `exceptions` ranges. The Chiusure & Straordinari tabs
// fetch that context and persist add/delete via JSON POSTs to the same route
// (actions closure_save / closure_delete_range / exception_save /
// exception_delete_range) instead of redirecting to the legacy PHP page.

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
};

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

export function HoursContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [locationId, setLocationId] = useState<number>(0);
  const [tab, setTab] = useState<"hours" | "closures" | "exceptions">("hours");
  const [hours, setHours] = useState<BusinessHourRow[]>([]);
  const [closures, setClosures] = useState<ClosureRange[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [savedMsg, setSavedMsg] = useState<string>("");

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

  // Shared JSON POST to /api/manage/resources (mirrors the roles-content style).
  const postAction = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setError("");
      try {
        const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ slug, location_id: locationId, ...body }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          setError(String(json?.error || "Operazione non riuscita."));
          return false;
        }
        // The route returns the refreshed list; reflect it immediately.
        if (Array.isArray(json?.closures)) setClosures(json.closures as ClosureRange[]);
        if (Array.isArray(json?.exceptions)) setExceptions(json.exceptions as ExceptionRange[]);
        return true;
      } catch {
        setError("Errore di rete.");
        return false;
      }
    },
    [slug, locationId],
  );

  function pageHref(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`hours${suffix}`.replace("&", "?")}`;
  }

  function tabHref(target: "hours" | "closures" | "exceptions"): string {
    return pageHref(`&tab=${target}&location_id=${locationId}`);
  }

  const navLinkBase = "nav-link";

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Orari &amp; chiusure</h1>
          <div className="bs-page-subtitle">Gestisci orari, chiusure e straordinari.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-primary" href={`/${encodeURIComponent(slug)}/settings`}>
            <i className="bi bi-building me-1" />
            Attivita
          </a>
        </div>
      </div>

      <ul className="nav nav-pills mb-3">
        <li className="nav-item">
          <a
            className={`${navLinkBase} ${tab === "hours" ? "active" : ""}`}
            href={tabHref("hours")}
            onClick={(e) => {
              e.preventDefault();
              setTab("hours");
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
              setTab("closures");
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
              setTab("exceptions");
            }}
          >
            <i className="bi bi-calendar2-week me-1" />
            Straordinari
          </a>
        </li>
      </ul>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      {savedMsg ? (
        <div className="alert alert-success" role="alert">
          {savedMsg}
        </div>
      ) : null}

      {tab === "hours" ? (
        <HoursTab
          locationId={locationId}
          hours={hours}
          onSave={async (rows) => {
            setSavedMsg("");
            const ok = await postAction({ action: "hours_save", hours_json: JSON.stringify(rows) });
            if (ok) {
              setSavedMsg("Orari salvati.");
              load();
            }
            return ok;
          }}
        />
      ) : tab === "closures" ? (
        <ClosuresTab loading={loading} closures={closures} onSave={postAction} />
      ) : (
        <ExceptionsTab loading={loading} exceptions={exceptions} onSave={postAction} />
      )}
    </div>
  );
}

// Editable weekly-hours row state (times as HH:MM, dow 0=Domenica..6=Sabato).
type HourRowState = { dow: number; opens: string; closes: string; opens2: string; closes2: string; isClosed: boolean };

// Controlled weekly-hours grid (port of the hours.php save_hours form): prefilled
// from the resources context and saved via POST action=hours_save (hours_json).
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(rows.map((r) => ({ dow: r.dow, opens: r.opens, closes: r.closes, opens2: r.opens2, closes2: r.closes2, is_closed: r.isClosed ? 1 : 0 })));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-3">
      <form method="post" onSubmit={submit}>
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
                const splitOpen = row.opens2 !== "" || row.closes2 !== "";
                return (
                  <HoursRow key={day.dow} label={day.label} row={row} splitOpen={splitOpen} onPatch={(changes) => patch(day.dow, changes)} />
                );
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
  splitOpen: splitFromData,
  onPatch,
}: {
  label: string;
  row: HourRowState;
  splitOpen: boolean;
  onPatch: (changes: Partial<HourRowState>) => void;
}) {
  // The split row stays visible once opened even with empty times (like the PHP UI).
  const [splitForced, setSplitForced] = useState(false);
  const splitOpen = splitForced || splitFromData;
  const dow = row.dow;

  return (
    <>
      <tr className="hours-row" data-role="main" data-dow={dow}>
        <td className="fw-semibold">{label}</td>
        <td>
          <input className="form-control" type="time" name={`hours[${dow}][opens]`} value={row.opens} disabled={row.isClosed} onChange={(e) => onPatch({ opens: e.target.value })} />
        </td>
        <td>
          <input className="form-control" type="time" name={`hours[${dow}][closes]`} value={row.closes} disabled={row.isClosed} onChange={(e) => onPatch({ closes: e.target.value })} />
        </td>
        <td className="text-nowrap">
          <button
            type="button"
            className={`btn btn-sm btn-outline-secondary js-add-split ${splitOpen ? "d-none" : ""}`}
            data-dow={dow}
            onClick={() => setSplitForced(true)}
          >
            <i className="bi bi-plus-lg me-1" />
            Aggiungi orario spezzato
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-outline-danger js-remove-split ${splitOpen ? "" : "d-none"}`}
            data-dow={dow}
            onClick={() => {
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
              onChange={(e) => onPatch({ isClosed: e.target.checked })}
            />
          </div>
        </td>
      </tr>
      <tr className={`split-row ${splitOpen ? "" : "d-none"}`} data-role="split" data-dow={dow}>
        <td></td>
        <td>
          <label className="form-label small text-muted mb-1">Riapertura</label>
          <input className="form-control" type="time" name={`hours[${dow}][opens2]`} value={row.opens2} disabled={row.isClosed} onChange={(e) => onPatch({ opens2: e.target.value })} />
        </td>
        <td>
          <label className="form-label small text-muted mb-1">Chiusura 2</label>
          <input className="form-control" type="time" name={`hours[${dow}][closes2]`} value={row.closes2} disabled={row.isClosed} onChange={(e) => onPatch({ closes2: e.target.value })} />
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
  onSave,
}: {
  loading: boolean;
  closures: ClosureRange[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
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
    const ok = await onSave({
      action: "closure_save",
      date_from: dateFrom,
      date_to: dateTo,
      kind,
      note,
    });
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
    await onSave({
      action: "closure_delete_range",
      // Stored desc: end is the older bound, start the newer bound. The legacy
      // delete link passes from=end & to=start; the lib re-orders internally.
      from: range.end,
      to: range.start,
      reason: range.reason ?? "",
    });
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
  onSave,
}: {
  loading: boolean;
  exceptions: ExceptionRange[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
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
    const ok = await onSave({
      action: "exception_save",
      date_from: dateFrom,
      date_to: dateTo,
      note,
      opens,
      closes,
      opens2: splitOpen ? opens2 : "",
      closes2: splitOpen ? closes2 : "",
    });
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
    await onSave({
      action: "exception_delete_range",
      from: range.end,
      to: range.start,
    });
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
