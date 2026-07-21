"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import InfoBox from "./info-box";
import { useTakenFlash } from "./flash";

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

// Voce di blocco legacy (cabin_delete_blockers_for_cabin): servizi collegati
// (anche via services.cabin_id) + prenotazioni future con dettaglio.
type BlockerItem = {
  block_kind?: "appointment";
  service_id: number;
  service_name: string;
  service_active: number;
  cabin_id: number;
  cabin_name: string;
  detail?: string;
};

type Cabin = {
  id: number;
  name: string;
  position: number;
  isActive: boolean;
  locationId: number | null;
  locationName: string;
  serviceLinks: ServiceLink[];
  blockers?: BlockerItem[];
};

type CabinsQuery = { msg?: string; err?: string };

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
  services: BlockerItem[];
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

export function CabinsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: CabinsQuery } = {}) {
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
  // Flash legacy dai redirect (?msg / ?err).
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  // Block modal state (mirrors cabins.js showCabinBlockPopup()).
  const [blockModal, setBlockModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    services: BlockerItem[];
  }>({ open: false, title: "", message: "", services: [] });
  const [blockListOpen, setBlockListOpen] = useState(false);

  // showCabinBlockPopup: con prenotazioni il messaggio cambia (senza accenti).
  function openBlockPopup(title: string, message: string, services: BlockerItem[]) {
    const msg = services.some((item) => item?.block_kind === "appointment")
      ? "La cabina e associata a servizi o prenotazioni future. Rimuovi prima i collegamenti o sposta le prenotazioni e poi riprova."
      : message;
    // Il legacy ricrea il DOM dell'accordion a ogni apertura: riparte collapsed.
    setBlockListOpen(false);
    setBlockModal({ open: true, title, message: msg, services });
  }

  function redirectFlash(params: Record<string, string>) {
    const usp = new URLSearchParams();
    if (activeLocationId > 0) usp.set("location_id", String(activeLocationId));
    for (const [k, v] of Object.entries(params)) if (v !== "") usp.set(k, v);
    window.location.assign(`/${encodeURIComponent(slug)}/cabins${usp.size > 0 ? `?${usp.toString()}` : ""}`);
  }

  const load = useCallback(
    (locationId: number) => {
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
            services: Array.isArray(c.blockers) ? c.blockers : [],
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
    // Come il legacy: il ?location_id in URL vince; senza, il server usa la
    // sede corrente di sessione (app_current_location_id).
    const usp = new URLSearchParams(window.location.search);
    load(Number.parseInt(usp.get("location_id") ?? "0", 10) || 0);
  }, [load]);

  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === activeLocationId) ?? null,
    [locations, activeLocationId],
  );
  // cabin_location_name: nome sede, altrimenti 'Sede #id', altrimenti 'Tutte'
  // (sede 0 = admin in "Tutte le sedi").
  const selectedLocationName = selectedLocation?.name ?? (activeLocationId > 0 ? `Sede #${activeLocationId}` : "Tutte");

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
              ? { id: fb.id, name: fb.name ?? "", services: fb.blockers ?? [] }
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

  // "Rimuovi riga" legacy (cabins.js 260-263): decrementa il conteggio e
  // ri-renderizza per indice — viene TRONCATA L'ULTIMA riga, non quella
  // cliccata (le righe si preservano per posizione).
  function removeRow() {
    applyCount(clampCount(count) - 1);
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`cabins${suffix}`.replace("&", "?")}`;
  }

  // cabins.js cabinConfirmDelete + cabins.php action=delete: con blocchi popup,
  // altrimenti confirm verbatim e POST con flash 'Cabina eliminata'.
  async function confirmDelete(row: CabinRow) {
    const services = Array.isArray(row.services) ? row.services : [];
    if (services.length > 0) {
      openBlockPopup(
        "Impossibile eliminare la cabina",
        "La cabina è associata ai servizi elencati. Rimuovi prima la cabina dai servizi collegati: finché è presente in un servizio non può essere eliminata.",
        services,
      );
      return;
    }
    const name = row.name || "questa cabina";
    if (!window.confirm(`Eliminare ${name}? La cabina verrà rimossa dalla configurazione, ma lo storico già creato resterà invariato.`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "cabin_delete", id: String(row.id), location_id: String(activeLocationId || "") }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && j.ok !== false) {
        redirectFlash({ msg: String(j.msg ?? "Cabina eliminata") });
        return;
      }
      setError(String(j.error ?? "Cabina non trovata"));
      if (j.popup) {
        const popup = j.popup as { title?: string; message?: string; services?: BlockerItem[] };
        openBlockPopup(String(popup.title ?? "Impossibile eliminare la cabina"), String(popup.message ?? ""), popup.services ?? []);
      }
      window.scrollTo(0, 0);
    } finally {
      setSaving(false);
    }
  }

  // serviceLabel di cabins.js: 'Cabina → Servizio (Attivo)' per i servizi,
  // 'Cabina -> Prenotazione X - dettaglio' per le prenotazioni.
  function serviceLabel(item: BlockerItem): string {
    const serviceName = item?.service_name ? String(item.service_name) : "Servizio";
    const cabinName = item?.cabin_name ? String(item.cabin_name) : "Cabina";
    if (item?.block_kind === "appointment") {
      const detail = item.detail ? String(item.detail) : "";
      return `${cabinName} -> ${serviceName}${detail ? ` - ${detail}` : ""}`;
    }
    const active = Number(item?.service_active ?? 1) === 1 ? "Attivo" : "Disattivo";
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
    let blocking: BlockerItem[] = [];
    for (const cabin of initialCabins) {
      if (cabin.id > 0 && !keptIds.has(cabin.id) && Array.isArray(cabin.blockers) && cabin.blockers.length > 0) {
        blocking = blocking.concat(cabin.blockers);
      }
    }
    if (blocking.length > 0) {
      openBlockPopup(
        "Impossibile eliminare la cabina",
        "Una o più cabine che stai rimuovendo sono associate ai servizi elencati. Rimuovi prima la cabina dai servizi collegati e poi riprova.",
        blocking,
      );
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
        if (j.popup) {
          const popup = j.popup as { title?: string; message?: string; services?: BlockerItem[] };
          openBlockPopup(String(popup.title ?? "Impossibile eliminare la cabina"), String(popup.message ?? ""), popup.services ?? []);
          // Err flash legacy (cabins.php 467).
          setError("Impostazioni non salvate: una o piu cabine sono associate a servizi o prenotazioni future.");
        } else {
          setError(String(j.error ?? "Errore nel salvataggio delle cabine."));
        }
        // Dopo un POST fallito il legacy ricarica SEMPRE lo stato reale dal DB
        // (cabins.php 517-520): gli edit in corso vengono scartati.
        load(activeLocationId);
        setSaving(false);
        window.scrollTo(0, 0);
        return;
      }
      // Redirect flash legacy (cabins.php 510).
      redirectFlash({ msg: "Impostazioni salvate" });
    } catch {
      setError("Errore nel salvataggio delle cabine.");
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">

      {flash.msg ? <div className="alert alert-success">{flash.msg}</div> : null}
      {flash.err ? <div className="alert alert-danger">{flash.err}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Cabine</h1>
            <InfoBox>
              <p>
                Le cabine servono a rendere <strong>prenotabili i servizi</strong>: ogni servizio può essere associato a
                una o più cabine e al momento della prenotazione ne viene occupata una.
              </p>
              <ul>
                <li>
                  Si configurano <strong>per sede</strong>: imposta il numero, assegna un nome a ciascuna (breve e
                  riconoscibile: &quot;Cabina 1&quot;, &quot;Cabina VIP&quot;) e salva.
                </li>
                <li>
                  Una cabina si può eliminare solo se non è associata a servizi e non ha prenotazioni future: in caso
                  contrario il sistema la blocca e mostra i collegamenti da rimuovere.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">
            Configura le cabine disponibili per la pianificazione degli appuntamenti nella sede selezionata.
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">Sede: {selectedLocationName}</div>

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
                            <button
                              type="button"
                              className="btn btn-outline-danger"
                              title="Elimina cabina"
                              disabled={saving}
                              onClick={() => void confirmDelete(row)}
                            >
                              <i className="bi bi-trash" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-outline-danger"
                              title="Rimuovi riga"
                              onClick={() => removeRow()}
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
                    <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                      <h3 className="accordion-header">
                        <button
                          className={`accordion-button ${blockListOpen ? "" : "collapsed"} bg-white shadow-none py-2`}
                          type="button"
                          onClick={() => setBlockListOpen((v) => !v)}
                        >
                          <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                            <span className="fw-semibold">Servizi collegati</span>
                            <span className="badge rounded-pill text-bg-info">{blockModal.services.length}</span>
                          </span>
                        </button>
                      </h3>
                      <div className={`accordion-collapse collapse ${blockListOpen ? "show" : ""}`}>
                        <div className="accordion-body py-2">
                          <div className="list-group list-group-flush">
                            {blockModal.services.map((service, i) => (
                              <div className="list-group-item px-0" key={`${service.service_id}-${i}`}>
                                {serviceLabel(service)}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
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
