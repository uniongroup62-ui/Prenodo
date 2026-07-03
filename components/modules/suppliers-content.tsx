"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP suppliers list page (app/pages/suppliers.php), fed by
// the existing DB-backed /api/manage/products endpoint which returns
// `suppliers: SupplierRow[]` together with `locations`.

type Supplier = {
  id: number;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  mobile: string;
  city: string;
  province: string;
  vatNumber: string;
  isActive: boolean;
  isActiveCosts: boolean;
  warehouseLocationIds: number[];
  costLocationIds: number[];
  productCount: number;
  costCount: number;
};

type LocationRow = { id: number; name: string; isActive: boolean };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function SuppliersContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "warehouse" | "costs">("all");
  const [status, setStatus] = useState<
    "all" | "warehouse_active" | "warehouse_inactive" | "costs_active" | "costs_inactive"
  >("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setSuppliers(Array.isArray(j.suppliers) ? j.suppliers : []);
        setLocations(Array.isArray(j.locations) ? j.locations : []);
      })
      .catch(() => {
        setSuppliers([]);
        setLocations([]);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`suppliers${suffix}`.replace("&", "?")}`;
  }

  // Delete a supplier via POST (the server refuses one still used by products/costs); reloads on
  // success. Confirm-gated. Replaces the old GET ?action=delete link (which fell to the Tailwind app).
  async function deleteSupplier(s: Supplier) {
    if (busyId) return;
    if (s.productCount + s.costCount > 0) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare definitivamente questo fornitore?")) return;
    setBusyId(s.id);
    try {
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "supplier_delete", id: s.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare il fornitore.");
      } else {
        load();
      }
    } finally {
      setBusyId(0);
    }
  }

  const locationNames = useMemo(() => {
    const map: Record<number, string> = {};
    for (const loc of locations) map[Number(loc.id)] = String(loc.name ?? "");
    return map;
  }, [locations]);

  function locationLabel(ids: number[]): string {
    if (!ids || ids.length === 0) return "Nessuna";
    const names = ids.map((lid) => locationNames[lid] ?? `Sede #${lid}`);
    return names.length ? names.join(", ") : "Nessuna";
  }

  // Client-side filtering mirrors the PHP list filter (q / scope / status).
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (needle !== "") {
        const hay = [s.name, s.businessName, s.city, s.province, s.phone, s.email]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      const warehouseActive = s.isActive;
      const costsActive = s.isActiveCosts;
      if (status === "warehouse_active" && !warehouseActive) return false;
      if (status === "warehouse_inactive" && warehouseActive) return false;
      if (status === "costs_active" && !costsActive) return false;
      if (status === "costs_inactive" && costsActive) return false;
      if (scope === "warehouse" && s.warehouseLocationIds.length === 0) return false;
      if (scope === "costs" && s.costLocationIds.length === 0) return false;
      return true;
    });
  }, [suppliers, q, scope, status]);

  const hasAnySuppliers = suppliers.length > 0;
  const showEmptyState = !loading && !hasAnySuppliers;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/suppliers.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Magazzino</div>
          <h1 className="bs-page-title">Fornitori</h1>
          <div className="bs-page-subtitle">
            Gestisci fornitori collegati a prodotti, magazzino e scadenze.
          </div>
        </div>
        <div className="bs-page-actions">
          {!showEmptyState ? (
            <a className="btn btn-primary" href={href("&action=new")}>
              Nuovo fornitore
            </a>
          ) : null}
        </div>
      </div>

      {showEmptyState ? (
        <div className="card border-0 shadow-sm suppliers-empty-card">
          <div className="suppliers-empty-state">
            <div className="suppliers-empty-icon" aria-hidden="true">
              <i className="bi bi-truck" />
            </div>
            <h2>Nessun fornitore registrato</h2>
            <p>
              Aggiungi il primo fornitore per collegarlo a prodotti, magazzino, scadenze e
              costi della tua attivita.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo fornitore
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
              }}
            >
              <div className="col-lg-4 col-md-6">
                <label className="form-label">Cerca</label>
                <input
                  className="form-control"
                  name="q"
                  value={q}
                  placeholder="Nome, contatto, localita..."
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <div className="col-lg-2 col-md-6">
                <label className="form-label">Ambito</label>
                <select
                  className="form-select"
                  name="scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                >
                  <option value="all">Tutti</option>
                  <option value="warehouse">Magazzino</option>
                  <option value="costs">Costi</option>
                </select>
              </div>
              <div className="col-lg-2 col-md-6">
                <label className="form-label">Stato</label>
                <select
                  className="form-select"
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                >
                  <option value="all">Tutti</option>
                  <option value="warehouse_active">Magazzino attivi</option>
                  <option value="warehouse_inactive">Magazzino non attivi</option>
                  <option value="costs_active">Costi attivi</option>
                  <option value="costs_inactive">Costi non attivi</option>
                </select>
              </div>
              <div className="col-lg-2 col-md-6 d-grid">
                <button className="btn btn-primary" type="submit">
                  Filtra
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Fornitore</th>
                    <th>Contatti</th>
                    <th>Località</th>
                    <th>Stato</th>
                    <th>Sedi abilitate</th>
                    <th>Uso</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted p-3">
                        {loading
                          ? "Caricamento…"
                          : "Nessun fornitore trovato con i filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((s) => {
                      const phone = (s.phone ?? "").trim();
                      const email = (s.email ?? "").trim();
                      const city = (s.city ?? "").trim();
                      const province = (s.province ?? "").trim();
                      const locality = city ? (province ? `${city} (${province})` : city) : (province || "—");
                      const usageCount = (s.productCount ?? 0) + (s.costCount ?? 0);
                      return (
                        <tr key={s.id}>
                          <td className="fw-semibold">{s.name}</td>
                          <td className="text-muted">
                            {phone !== "" ? phone : "—"}
                            {email !== "" ? <div className="small">{email}</div> : null}
                          </td>
                          <td className="text-muted">{locality}</td>
                          <td>
                            <div className="d-flex flex-column gap-1">
                              <div>
                                {s.isActive ? (
                                  <span className="badge text-bg-success">
                                    Magazzino: Attivo
                                  </span>
                                ) : (
                                  <span className="badge text-bg-secondary">
                                    Magazzino: Non attivo
                                  </span>
                                )}
                              </div>
                              <div>
                                {s.isActiveCosts ? (
                                  <span className="badge text-bg-success">Costi: Attivo</span>
                                ) : (
                                  <span className="badge text-bg-secondary">
                                    Costi: Non attivo
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="text-muted small">
                            <div>
                              <span className="fw-semibold">Magazzino:</span>{" "}
                              {locationLabel(s.warehouseLocationIds)}
                            </div>
                            <div>
                              <span className="fw-semibold">Costi:</span>{" "}
                              {locationLabel(s.costLocationIds)}
                            </div>
                          </td>
                          <td className="text-muted small">
                            <div>Prodotti: {s.productCount ?? 0}</div>
                            <div>Costi: {s.costCount ?? 0}</div>
                          </td>
                          <td className="text-end">
                            <a
                              className="btn btn-sm btn-outline-secondary"
                              href={href(`&action=edit&id=${s.id}`)}
                            >
                              Modifica
                            </a>{" "}
                            {usageCount > 0 ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-danger"
                                disabled
                                title="Fornitore usato in prodotti o costi: non puo essere eliminato."
                              >
                                Elimina
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-danger"
                                disabled={busyId === s.id}
                                onClick={() => deleteSupplier(s)}
                              >
                                Elimina
                              </button>
                            )}
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
      )}
    </div>
  );
}
