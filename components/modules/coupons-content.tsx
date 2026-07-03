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

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value?: string): string {
  const v = (value ?? "").slice(0, 10);
  return v !== "" ? v : "—";
}

// Mirrors coupons_status_info(): disabled / scheduled / expired / active.
function statusInfo(coupon: Coupon): { label: string; badge: string } {
  const today = new Date().toISOString().slice(0, 10);
  const validFrom = (coupon.startsAt ?? "").slice(0, 10);
  const validTo = (coupon.endsAt ?? "").slice(0, 10);
  if (!coupon.active) return { label: "Disattivato", badge: "bg-secondary" };
  if (validFrom !== "" && validFrom > today) return { label: "Programmato", badge: "bg-info text-dark" };
  if (validTo !== "" && validTo < today) return { label: "Scaduto", badge: "bg-warning text-dark" };
  return { label: "Attiva", badge: "bg-success" };
}

export function CouponsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [allLocations, setAllLocations] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setCoupons(Array.isArray(j.coupons) ? j.coupons : []))
      .catch(() => setCoupons([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`coupons${suffix}`.replace("&", "?")}`;
  }

  // Delete a coupon via POST (port of coupons.php action=delete). The server
  // refuses while open appointments reference it, soft-deletes when the coupon
  // has usage (history preserved), and hard-deletes when unused. Confirm-gated.
  // Replaces the old GET ?action=delete link (which fell to the Tailwind app).
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
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare il coupon.");
      } else {
        if (typeof window !== "undefined" && j?.message) window.alert(j.message);
        load();
      }
    } finally {
      setBusyId(0);
    }
  }

  const hasAnyCoupons = coupons.length > 0;
  const showEmptyState = !loading && !hasAnyCoupons;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/coupons.css" />

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
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                load();
              }}
            >
              <div className="col-lg-8 d-flex align-items-center justify-content-start">
                <div className="form-check mb-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="couponsAllLocations"
                    name="all_locations"
                    value="1"
                    checked={allLocations}
                    onChange={(e) => setAllLocations(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="couponsAllLocations">
                    Tutte le sedi
                  </label>
                </div>
              </div>
              <div className="col-lg-4 d-flex align-items-end gap-2 app-filter-actions">
                <button className="btn btn-outline-primary app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                <a className="btn btn-outline-secondary app-filter-reset" href={href("")}>
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
                            {x.type === "percent" ? <>{x.value}%</> : <>€ {fmtMoney(x.value)}</>}
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
        </>
      ) : null}
    </div>
  );
}
