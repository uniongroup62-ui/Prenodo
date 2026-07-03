"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP cabins configuration page (app/pages/cabins.php +
// assets/js/pages/cabins.js), fed by the existing DB-backed
// /api/manage/resources?section=cabins. Reproduces the original Bootstrap
// markup (bs-page-header, "Cabine - <Sede>" card with the dynamic per-cabin
// name rows, the info box, and the delete-block modal) verbatim, and mirrors
// the client-side rendering logic from cabins.js (count -> N name fields).

type ServiceLink = {
  serviceId: number;
  serviceName: string;
  isActive: boolean;
};

type Cabin = {
  id: number;
  name: string;
  position: number;
  isActive: boolean;
  locationId: number | null;
  locationName: string;
  serviceLinks: ServiceLink[];
};

type Location = {
  id: number;
  name: string;
  isActive: boolean;
};

type ResourceContext = {
  activeLocationId: number;
  locations: Location[];
  cabins: Cabin[];
};

// One editable row in the cabins form (mirrors cabins.js getCurrentRows()).
type CabinRow = {
  id: number;
  name: string;
  services: ServiceLink[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clampCount(value: number): number {
  let n = Math.trunc(Number.isFinite(value) ? value : 0);
  if (isNaN(n) || n < 0) n = 0;
  if (n > 50) n = 50;
  return n;
}

export function CabinsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [locations, setLocations] = useState<Location[]>([]);
  const [activeLocationId, setActiveLocationId] = useState<number>(0);
  const [initialCabins, setInitialCabins] = useState<Cabin[]>([]);
  const [count, setCount] = useState<number>(0);
  const [rows, setRows] = useState<CabinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Block modal state (mirrors cabins.js showCabinBlockPopup()).
  const [blockModal, setBlockModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    services: ServiceLink[];
  }>({ open: false, title: "", message: "", services: [] });

  const load = useCallback(
    (locationId: number) => {
      setLoading(true);
      const qs = new URLSearchParams({ slug, section: "cabins" });
      if (locationId > 0) qs.set("location_id", String(locationId));
      fetch(`/api/manage/resources?${qs.toString()}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j: Partial<ResourceContext>) => {
          const locs = Array.isArray(j.locations) ? j.locations : [];
          const cabs = Array.isArray(j.cabins) ? j.cabins : [];
          setLocations(locs);
          setActiveLocationId(Number(j.activeLocationId ?? locationId ?? 0));
          setInitialCabins(cabs);
          // Initialize the editable rows from the saved cabins (cabins.js
          // seeds the count + name fields from initialCabins).
          const initialRows: CabinRow[] = cabs.map((c) => ({
            id: c.id,
            name: c.name ?? "",
            services: Array.isArray(c.serviceLinks) ? c.serviceLinks : [],
          }));
          setRows(initialRows);
          setCount(initialRows.length);
        })
        .catch(() => {
          setLocations([]);
          setInitialCabins([]);
          setRows([]);
          setCount(0);
        })
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === activeLocationId) ?? null,
    [locations, activeLocationId],
  );
  const selectedLocationName = selectedLocation?.name ?? "";

  // Keep `rows` in sync with `count` (mirrors cabins.js render(): grows by
  // reusing saved cabins as fallback, shrinks by truncation).
  function applyCount(next: number) {
    const c = clampCount(next);
    setCount(c);
    setRows((prev) => {
      const out: CabinRow[] = [];
      for (let i = 0; i < c; i++) {
        if (prev[i]) {
          out.push(prev[i]);
        } else {
          const fb = initialCabins[i];
          out.push(
            fb
              ? { id: fb.id, name: fb.name ?? "", services: fb.serviceLinks ?? [] }
              : { id: 0, name: "", services: [] },
          );
        }
      }
      return out;
    });
  }

  function setRowName(idx: number, value: string) {
    setRows((prev) => prev.map((row, i) => (i === idx ? { ...row, name: value } : row)));
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setCount((c) => Math.max(0, clampCount(c) - 1));
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`cabins${suffix}`.replace("&", "?")}`;
  }

  // Delete link target for an existing cabin (legacy fallback action).
  function deleteHref(id: number): string {
    let h = href(`&action=delete&id=${encodeURIComponent(String(id))}`);
    if (activeLocationId) h += `&location_id=${encodeURIComponent(String(activeLocationId))}`;
    return h;
  }

  // Mirrors cabins.js cabinConfirmDelete(): if the cabin is linked to
  // services, show the block modal and cancel navigation.
  function confirmDelete(row: CabinRow, e: React.MouseEvent<HTMLAnchorElement>) {
    const services = Array.isArray(row.services) ? row.services : [];
    if (services.length > 0) {
      e.preventDefault();
      setBlockModal({
        open: true,
        title: "Impossibile eliminare la cabina",
        message:
          "La cabina è associata ai servizi elencati. Rimuovi prima la cabina dai servizi collegati: finché è presente in un servizio non può essere eliminata.",
        services,
      });
      return;
    }
    const name = row.name || "questa cabina";
    if (
      !window.confirm(
        `Eliminare ${name}? La cabina verrà rimossa dalla configurazione, ma lo storico già creato resterà invariato.`,
      )
    ) {
      e.preventDefault();
    }
  }

  function serviceLabel(service: ServiceLink): string {
    const serviceName = service?.serviceName ? String(service.serviceName) : "Servizio";
    const cabinName = selectedLocationName ? "Cabina" : "Cabina";
    const active = service?.isActive ? "Attivo" : "Disattivo";
    return `${cabinName} → ${serviceName} (${active})`;
  }

  // Bulk save (port of cabins.php #cabinsForm POST): submit count + names + ids
  // for the active location to /api/manage/resources (action=cabins_save).
  // Mirrors the cabins.js submit guard: first block locally if removed cabins
  // still have linked services; otherwise POST. The server re-checks and, when a
  // removed cabin is still linked, returns ok:false + blockingServices, which we
  // surface in the same delete-block popup the legacy page shows.
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const keptIds = new Set(rows.map((r) => r.id).filter((id) => id > 0));
    let blocking: ServiceLink[] = [];
    for (const cabin of initialCabins) {
      if (cabin.id > 0 && !keptIds.has(cabin.id) && Array.isArray(cabin.serviceLinks) && cabin.serviceLinks.length > 0) {
        blocking = blocking.concat(cabin.serviceLinks);
      }
    }
    if (blocking.length > 0) {
      setBlockModal({
        open: true,
        title: "Impossibile eliminare la cabina",
        message:
          "Una o più cabine che stai rimuovendo sono associate ai servizi elencati. Rimuovi prima la cabina dai servizi collegati e poi riprova.",
        services: blocking,
      });
      return;
    }

    // Client-side required-name check (faithful to the legacy "Inserisci un nome
    // per tutte le cabine.").
    for (let i = 0; i < count; i++) {
      if (((rows[i]?.name ?? "").trim()) === "") {
        setError("Inserisci un nome per tutte le cabine.");
        return;
      }
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "cabins_save",
        location_id: String(activeLocationId || ""),
        cabins_count: String(count),
        cabin_names_json: JSON.stringify(rows.slice(0, count).map((r) => r.name)),
        cabin_ids_json: JSON.stringify(rows.slice(0, count).map((r) => r.id)),
      };
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        if (Array.isArray(j.blockingServices) && j.blockingServices.length > 0) {
          setBlockModal({
            open: true,
            title: "Impossibile eliminare la cabina",
            message:
              "Una o più cabine che stai rimuovendo sono associate ai servizi elencati. Rimuovi prima la cabina dai servizi collegati e poi riprova.",
            services: j.blockingServices as ServiceLink[],
          });
        } else {
          setError(String(j.error ?? "Errore nel salvataggio delle cabine."));
        }
        setSaving(false);
        return;
      }
      setSaving(false);
      load(activeLocationId);
    } catch {
      setError("Errore nel salvataggio delle cabine.");
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/cabins.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Cabine</h1>
          <div className="bs-page-subtitle">
            Configura le cabine disponibili per la pianificazione degli appuntamenti nella sede selezionata.
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">Cabine - {selectedLocationName}</div>

            {error ? <div className="alert alert-danger">{error}</div> : null}

            <form method="post" className="row g-3" id="cabinsForm" onSubmit={onSubmit}>
              <input type="hidden" name="location_id" value={activeLocationId || ""} />

              <div className="col-12">
                <label className="form-label">Numero di cabine</label>
                <input
                  className="form-control"
                  type="number"
                  min={0}
                  max={50}
                  name="cabins_count"
                  id="cabinsCount"
                  value={count}
                  onChange={(e) => applyCount(parseInt(e.target.value || "0", 10))}
                  required
                />
                <div className="form-text">
                  Dopo aver impostato il numero, assegna un nome a ciascuna cabina (es. “Cabina 1”, “Cabina A”). Puoi
                  eliminare una cabina solo se non e associata a servizi o prenotazioni future.
                </div>
              </div>

              <div className="col-12" id="cabinsNamesWrap">
                {loading ? (
                  <div className="text-muted small">Caricamento…</div>
                ) : count === 0 ? (
                  <div className="text-muted small">
                    {selectedLocationName
                      ? `Nessuna cabina configurata per ${selectedLocationName}. Imposta il numero di cabine e assegna un nome a ciascuna cabina.`
                      : "Nessuna cabina configurata. Imposta il numero di cabine e assegna un nome a ciascuna cabina."}
                  </div>
                ) : (
                  <div className="border rounded-3 p-3 bg-light">
                    {rows.map((row, idx) => (
                      <div className="mb-3" data-cabin-row="1" data-idx={idx} key={idx}>
                        <label className="form-label mb-1">Nome cabina {idx + 1}</label>
                        <div className="d-flex gap-2 align-items-start">
                          <input
                            className="form-control"
                            name="cabin_names[]"
                            data-idx={idx}
                            required
                            value={row.name}
                            onChange={(e) => setRowName(idx, e.target.value)}
                          />
                          <input type="hidden" name="cabin_ids[]" value={String(row.id)} />
                          {row.id > 0 ? (
                            <a
                              className="btn btn-outline-danger"
                              href={deleteHref(row.id)}
                              data-cabin-delete="1"
                              data-cabin-name={row.name || "Cabina"}
                              title="Elimina cabina"
                              onClick={(e) => confirmDelete(row, e)}
                            >
                              <i className="bi bi-trash" />
                            </a>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-outline-danger"
                              title="Rimuovi riga"
                              onClick={() => removeRow(idx)}
                            >
                              <i className="bi bi-trash" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="col-12 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                  <i className="bi bi-check2-circle me-1" />
                  {saving ? "Salvataggio…" : "Salva"}
                </button>
                <a
                  className="btn btn-outline-secondary btn-pill"
                  href={href(activeLocationId ? `&location_id=${activeLocationId}` : "")}
                >
                  Annulla
                </a>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="cabins-info-box">
            <div className="cabins-info-box__icon" aria-hidden="true">
              <i className="bi bi-info-circle" />
            </div>
            <div className="cabins-info-box__body">
              <div className="cabins-info-box__title">Suggerimento</div>
              <ul className="cabins-info-box__list mb-0">
                <li>Le cabine sono necessarie per rendere prenotabili i servizi.</li>
                <li>Ogni servizio puo essere associato a una o piu cabine.</li>
                <li>Usa nomi brevi e riconoscibili, ad esempio Cabina 1, Cabina 2 o Cabina VIP.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`modal fade${blockModal.open ? " show d-block" : ""}`}
        id="cabinDeleteBlockModal"
        tabIndex={-1}
        aria-hidden={blockModal.open ? undefined : true}
        style={blockModal.open ? { background: "rgba(0,0,0,.5)" } : undefined}
      >
        <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Cabine</div>
                <h5 className="modal-title fw-bold m-0" id="cabinDeleteBlockTitle">
                  {blockModal.title || "Impossibile eliminare la cabina"}
                </h5>
              </div>
              <button
                type="button"
                className="btn-close"
                data-bs-dismiss="modal"
                aria-label="Chiudi"
                onClick={() => setBlockModal((m) => ({ ...m, open: false }))}
              />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning small mb-3" id="cabinDeleteBlockMessage">
                {blockModal.message}
              </div>
              <div id="cabinDeleteBlockServiceList">
                {blockModal.services.length === 0 ? (
                  <div className="text-muted small">Sono presenti servizi associati.</div>
                ) : (
                  <div className="accordion" id="cabinDeleteBlockServiceAccordion">
                    <ul className="list-group list-group-flush">
                      {blockModal.services.map((service, i) => (
                        <li className="list-group-item" key={`${service.serviceId}-${i}`}>
                          {serviceLabel(service)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-outline-secondary btn-pill"
                data-bs-dismiss="modal"
                onClick={() => setBlockModal((m) => ({ ...m, open: false }))}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
