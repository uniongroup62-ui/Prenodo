"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP coupons list page (app/pages/coupons.php), fed by
// the existing DB-backed /api/manage/coupons. The PHP page renders an empty
// state when no coupons exist, otherwise a filter card + a 10-column table.

type Coupon = {
  id: number;
  code: string;
  type: "fixed" | "percent";
  value: number;
  minSubtotal: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  usageLimit: number;
  usedCount: number;
  createdAt?: string;
  description?: string;
  applyScope?: string;
  scopeLabel?: string;
  locationLabel?: string;
  activeUsedCount?: number;
};

// Querystring params the legacy list reads: the redirect flash (?msg=&type=)
// and the "Tutte le sedi" GET filter.
export type CouponsQuery = {
  msg?: string;
  type?: string;
  all_locations?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Port of fmt_money(): number_format(n, 2, ',', '.').
// NON usare toLocaleString('it-IT'): CLDR minimumGroupingDigits=2 non
// raggruppa le migliaia per 1000-9999.
function fmtMoney(n: number): string {
  const v = Number(n || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

function fmtDate(value?: string): string {
  const v = (value ?? "").slice(0, 10);
  return v !== "" ? v : "—";
}

// Data odierna LOCALE (legacy date('Y-m-d') sul server Rome): toISOString è UTC
// e tra mezzanotte e le 2 ora italiana sbaglierebbe i confini di validità.
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Mirrors coupons_status_info(): disabled / scheduled / expired / active.
function statusInfo(coupon: Coupon): { label: string; badge: string } {
  const today = todayLocal();
  const validFrom = (coupon.startsAt ?? "").slice(0, 10);
  const validTo = (coupon.endsAt ?? "").slice(0, 10);
  if (!coupon.active) return { label: "Disattivato", badge: "bg-secondary" };
  if (validFrom !== "" && validFrom > today) return { label: "Programmato", badge: "bg-info text-dark" };
  if (validTo !== "" && validTo < today) return { label: "Scaduto", badge: "bg-warning text-dark" };
  return { label: "Attiva", badge: "bg-success" };
}

// Legacy all_locations truthy set (app_all_locations_filter_enabled).
function allLocationsFromQuery(value?: string): boolean {
  return ["1", "true", "on", "yes", "all"].includes(String(value ?? "").trim().toLowerCase());
}

export function CouponsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CouponsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [allLocations, setAllLocations] = useState(() => allLocationsFromQuery(initialQuery?.all_locations));
  // Conteggio NON filtrato (empty state + bottone header) e numero sedi attive
  // (il filtro "Tutte le sedi" esiste solo per i tenant multi-sede, come il
  // legacy $couponShowAllLocationsFilter).
  const [totalCount, setTotalCount] = useState(0);
  const [locationsCount, setLocationsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);
  // Flash legacy (View::alert sopra il page header): dal redirect ?msg=&type=
  // o dall'esito del delete in pagina.
  const [flash, setFlash] = useState<{ msg: string; type: string } | null>(() =>
    initialQuery?.msg ? { msg: initialQuery.msg, type: initialQuery.type || "success" } : null,
  );

  // Fetch puro (setState nei callback della Promise; loading gia' true di default).
  const fetchData = useCallback((all?: boolean) => {
    const flag = all === undefined ? allLocations : all;
    fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}${flag ? "&all_locations=1" : ""}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setCoupons(Array.isArray(j.coupons) ? j.coupons : []);
        setTotalCount(Number(j.totalCount ?? (Array.isArray(j.coupons) ? j.coupons.length : 0)));
        setLocationsCount(Number(j.locationsCount ?? 0));
      })
      .catch(() => setCoupons([]))
      .finally(() => setLoading(false));
    // Il filtro si applica SOLO al submit "Filtra" (come il form GET legacy):
    // allLocations è letto al momento della chiamata, non è una dipendenza.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const load = useCallback((all?: boolean) => {
    setLoading(true);
    fetchData(all);
  }, [fetchData]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`coupons${suffix}`.replace("&", "?")}`;
  }

  // Mantiene l'URL allineato al filtro applicato (il form legacy è un GET).
  function syncUrl(all: boolean) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("msg");
    url.searchParams.delete("type");
    if (all) url.searchParams.set("all_locations", "1");
    else url.searchParams.delete("all_locations");
    window.history.replaceState(null, "", url.toString());
  }

  // Delete a coupon via POST (port of coupons.php action=delete). The server
  // refuses while open appointments reference it, soft-deletes when the coupon
  // has usage (history preserved), and hard-deletes when unused. Confirm-gated
  // ("Eliminare questo coupon?" — data-coupons-confirm). Legacy outcomes land
  // as redirect flashes: success/danger/warning on the list, and the
  // open-appointments warning on the EDIT page.
  async function deleteCoupon(c: Coupon) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questo coupon?")) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: c.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (j?.redirectEdit) {
          window.location.href = href(`&action=edit&id=${c.id}`) + `&msg=${encodeURIComponent(String(j.error))}&type=${encodeURIComponent(String(j.errorType || "warning"))}`;
          return;
        }
        setFlash({ msg: String(j?.error || "Errore coupon."), type: String(j?.errorType || "danger") });
      } else {
        setFlash({ msg: String(j?.message || "Coupon eliminato"), type: "success" });
        load();
      }
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    } finally {
      setBusyId(0);
    }
  }

  // Empty state / bottone header sul conteggio NON filtrato (legacy
  // $hasAnyCoupons calcolato prima del filtro sede).
  const hasAnyCoupons = totalCount > 0;
  const showEmptyState = !loading && !hasAnyCoupons;
  // Legacy: la card filtro "Tutte le sedi" esiste solo con più sedi. NOTA:
  // il legacy nasconde per bug ANCHE la tabella nei tenant mono-sede
  // (coupons.php 1168/1250, endif mal posizionato — verificato live: con un
  // coupon esistente la pagina mostra solo header+alert e il coupon diventa
  // ingestibile). Qui la tabella resta visibile (fix deliberato).
  const showLocationsFilter = locationsCount > 1;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/coupons.css" />

      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.msg}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Buoni</div>
          <h1 className="bs-page-title">Coupon / Promo</h1>
          <div className="bs-page-subtitle">Crea e gestisci codici sconto e campagne coupon.</div>
        </div>
        {hasAnyCoupons ? (
          <div className="bs-page-actions">
            <a className="btn btn-primary" href={href("&action=new")}>
              Nuovo coupon
            </a>
          </div>
        ) : null}
      </div>

      {showEmptyState ? (
        <div className="card border-0 shadow-sm coupons-empty-card">
          <div className="coupons-empty-state">
            <div className="coupons-empty-icon" aria-hidden="true">
              <i className="bi bi-ticket-perforated" />
            </div>
            <h2>Nessun coupon creato</h2>
            <p>Crea il primo coupon per applicare sconti a vendite, prenotazioni, servizi o prodotti.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo coupon
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {hasAnyCoupons ? (
          <div className="card">
            {/* Filtro sede integrato nell'header della tabella (restyle approvato
                2026-07-15): via la card dedicata al solo checkbox — switch con
                auto-applicazione (micro-deviazione dal submit GET legacy; l'URL
                ?all_locations=1 resta identico) + conteggio a sinistra. */}
            <div className="card-header bg-transparent d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
              <span className="text-muted small">
                {coupons.length === 1 ? "1 buono" : `${coupons.length} buoni`}
                {!allLocations && showLocationsFilter ? " nella sede corrente" : ""}
              </span>
              {showLocationsFilter ? (
                <div className="form-check form-switch mb-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="couponsAllLocations"
                    name="all_locations"
                    value="1"
                    checked={allLocations}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setAllLocations(v);
                      syncUrl(v);
                      load(v);
                    }}
                  />
                  <label className="form-check-label" htmlFor="couponsAllLocations">
                    Tutte le sedi
                  </label>
                </div>
              ) : null}
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Codice</th>
                    <th>Descrizione</th>
                    <th>Sconto</th>
                    <th>Minimo</th>
                    <th>Utilizzi / cliente</th>
                    <th>Ambito</th>
                    <th>Sedi</th>
                    <th>Validità</th>
                    <th>Stato</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {coupons.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-muted p-3">
                        Nessun coupon trovato con i filtri selezionati.
                      </td>
                    </tr>
                  ) : (
                    coupons.map((x) => {
                      const status = statusInfo(x);
                      const active = status.label === "Attiva";
                      return (
                        <tr key={x.id} className={active ? "" : "table-light"}>
                          <td className="fw-semibold">{x.code}</td>
                          <td className="text-muted">{x.description && x.description !== "" ? x.description : "—"}</td>
                          <td>
                            {/* Legacy percent: raw DECIMAL(10,2) -> "10.00%" (punto). */}
                            {x.type === "percent" ? <>{Number(x.value ?? 0).toFixed(2)}%</> : <>€ {fmtMoney(x.value)}</>}
                          </td>
                          <td className="text-muted">€ {fmtMoney(x.minSubtotal)}</td>
                          <td className="text-muted">
                            {x.usageLimit > 0 ? (
                              <>
                                {x.usageLimit} / cliente
                                {(x.activeUsedCount ?? 0) > 0 ? (
                                  <div className="small text-muted">Totali attivi: {x.activeUsedCount}</div>
                                ) : null}
                              </>
                            ) : (
                              <>Illimitato</>
                            )}
                          </td>
                          <td className="text-muted">{x.scopeLabel ?? "—"}</td>
                          <td className="text-muted">{x.locationLabel ?? "—"}</td>
                          <td className="text-muted">
                            {fmtDate(x.startsAt)} → {fmtDate(x.endsAt)}
                          </td>
                          <td>
                            <span className={`badge ${status.badge}`}>{status.label}</span>
                          </td>
                          <td className="text-end">
                            <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${x.id}`)}>
                              Apri
                            </a>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-danger"
                              disabled={busyId === x.id}
                              onClick={() => deleteCoupon(x)}
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
      ) : null}
    </div>
  );
}
