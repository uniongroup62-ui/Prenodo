"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP resources page (app/pages/resources.php +
// resources.js): lista (Nome | Quantità sede | Descrizione | Azioni, desc
// troncata a 80), form Nuova/Modifica su PAGINA dedicata (?action=new|edit&id=)
// con card sinistra + info-box destro, tabella "Sedi abilitate"
// (Attiva + Quantità sede, default sede corrente in creazione), popup di blocco
// #resourceBlockModal (accordion 'Servizi collegati') per delete con servizi e
// riduzioni qty bloccate, flash redirect ?msg/?err legacy. Backend:
// /api/manage/resources action=resource_save / resource_delete (guardie con
// payload popup) + GET action=get&section=resources per il prefill edit.

type ResourcesQuery = { action?: string; id?: string; msg?: string; err?: string };

type ResourceLocationRow = { locationId: number; locationName: string; qtyTotal: number; isEnabled: boolean };
type LinkedService = { serviceId: number; serviceName: string; qtyRequired?: number; isActive: boolean };
type SharedResource = {
  id: number;
  name: string;
  description: string;
  qtyTotal: number;
  locations: ResourceLocationRow[];
  serviceLinks: LinkedService[];
};

type BlockPopup = { title: string; message: string; services: Array<{ service_name: string; qty_required: number }> };

type ResourceForm = { id: number; name: string; description: string; qty_total: string; locations: ResourceLocationRow[] };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// resources.php 794-797: descrizione troncata a 80 (77 + '…').
function truncateDescription(desc: string): string {
  return desc.length > 80 ? `${desc.slice(0, 77)}…` : desc;
}

export function ResourcesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ResourcesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const action = initialQuery?.action === "new" || initialQuery?.action === "edit" ? initialQuery.action : "list";
  const editId = Math.max(0, Number.parseInt(initialQuery?.id ?? "0", 10) || 0);

  // Flash legacy dal redirect (?msg / ?err) + errori delle azioni in pagina.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [err, setErr] = useState("");

  const [items, setItems] = useState<SharedResource[]>([]);
  const [resourcesTotal, setResourcesTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ResourceForm | null>(null);
  // Record originale in edit (per guardia client su riduzione qty + Elimina):
  // letto per id, indipendente dal filtro sede della lista.
  const [editResource, setEditResource] = useState<SharedResource | null>(null);
  const [popup, setPopup] = useState<BlockPopup | null>(null);
  const [popupOpenList, setPopupOpenList] = useState(false);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`resources${suffix}`.replace("&", "?")}`;
  }

  function redirectFlash(params: Record<string, string | number>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (String(v) !== "") usp.set(k, String(v));
    window.location.assign(`/${encodeURIComponent(slug)}/resources${usp.size > 0 ? `?${usp.toString()}` : ""}`);
  }

  const load = useCallback(() => {
    return fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=resources`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list: SharedResource[] = Array.isArray(j.resources) ? j.resources : [];
        setItems(list);
        setResourcesTotal(Number(j.resourcesTotal ?? list.length) || 0);
        const locations: Array<{ id: number; name: string }> = Array.isArray(j.locations) ? j.locations.map((l: { id: number; name: string }) => ({ id: Number(l.id), name: String(l.name) })) : [];
        const activeLocationId = Number(j.activeLocationId ?? 0) || 0;

        if (action === "new") {
          // Default legacy (resources.php 507-541): qty 1, SOLO la sede
          // corrente abilitata (qty = qty_total), le altre spente a 0.
          const defaultLocId = activeLocationId > 0 ? activeLocationId : (locations[0]?.id ?? 0);
          setForm({
            id: 0,
            name: "",
            description: "",
            qty_total: "1",
            locations: locations.map((l) => ({
              locationId: l.id,
              locationName: l.name,
              qtyTotal: l.id === defaultLocId ? 1 : 0,
              isEnabled: l.id === defaultLocId,
            })),
          });
        } else if (action === "edit" && editId > 0) {
          // Prefill per id (anche fuori sede corrente); mancante -> redirect err.
          return fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=resources&action=get&id=${editId}`, { headers: { "x-tenant-slug": slug } })
            .then((r) => r.json())
            .then((jr) => {
              if (!jr.ok || !jr.resource) {
                redirectFlash({ err: "Risorsa non trovata" });
                return;
              }
              const r = jr.resource as SharedResource;
              setEditResource(r);
              const byId = new Map(r.locations.map((l) => [l.locationId, l]));
              setForm({
                id: r.id,
                name: r.name,
                description: r.description,
                qty_total: String(r.qtyTotal),
                locations: locations.map((l) => {
                  const cur = byId.get(l.id);
                  return { locationId: l.id, locationName: l.name, qtyTotal: Math.max(0, Number(cur?.qtyTotal ?? 0)), isEnabled: Boolean(cur?.isEnabled ?? false) };
                }),
              });
            });
        }
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, action, editId]);

  useEffect(() => { load(); }, [load]);

  async function post(fields: Record<string, string>): Promise<{ ok: boolean; error: string; popup: BlockPopup | null }> {
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const ok = res.ok && j.ok !== false;
      return { ok, error: ok ? "" : String(j.error ?? "Errore risorse."), popup: (j.popup as BlockPopup | undefined) ?? null };
    } catch {
      return { ok: false, error: "Errore risorse.", popup: null };
    } finally {
      setBusy(false);
    }
  }

  async function saveResource(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;

    // Guardia client legacy (resources.js 147-174): in edit, riduzione della
    // qty globale sotto la qty richiesta dai servizi -> popup senza POST.
    const currentLinks = editResource?.serviceLinks ?? [];
    if (action === "edit") {
      const currentQty = Math.max(0, editResource?.qtyTotal ?? 0);
      const newQty = Math.max(0, Number.parseInt(form.qty_total || "0", 10) || 0);
      if (newQty < currentQty) {
        const blocking = currentLinks.filter((s) => Math.max(1, Number(s.qtyRequired ?? 1) || 1) > newQty);
        if (blocking.length > 0) {
          setPopup({
            title: "Quantità non modificabile",
            message: "La nuova quantità è inferiore alla quantità già impostata nei servizi elencati. Scala la risorsa dal servizio e rendila disponibile prima di modificare la quantità.",
            services: blocking.map((s) => ({ service_name: s.serviceName, qty_required: Math.max(1, Number(s.qtyRequired ?? 1) || 1) })),
          });
          return;
        }
      }
    }

    setErr("");
    const r = await post({
      action: "resource_save",
      id: String(form.id),
      name: form.name,
      description: form.description,
      qty_total: form.qty_total,
      locations_json: JSON.stringify(form.locations.map((l) => ({ locationId: l.locationId, locationName: l.locationName, qtyTotal: l.qtyTotal, isEnabled: l.isEnabled ? 1 : 0 }))),
    });
    if (r.ok) {
      redirectFlash({ msg: form.id > 0 ? "Risorsa aggiornata" : "Risorsa creata" });
      return;
    }
    // Come il legacy: torna sul form con l'err in alto (+ popup se presente).
    setErr(r.error);
    if (r.popup) setPopup(r.popup);
    window.scrollTo(0, 0);
  }

  // Delete (lista e form edit): guardia client con popup se servizi collegati,
  // poi confirm legacy; il server ripete le guardie (popup dal payload).
  async function removeResource(id: number, serviceLinks: LinkedService[]) {
    if (serviceLinks.length > 0) {
      setPopup({
        title: "Impossibile eliminare la risorsa",
        message: "La risorsa è associata ai servizi elencati. Elimina prima la risorsa dai servizi collegati: finché è presente in un servizio non può essere eliminata.",
        services: serviceLinks.map((s) => ({ service_name: s.serviceName, qty_required: Math.max(1, Number(s.qtyRequired ?? 1) || 1) })),
      });
      return;
    }
    if (!window.confirm("Eliminare questa risorsa?")) return;
    const r = await post({ action: "resource_delete", id: String(id) });
    if (r.ok) {
      redirectFlash({ msg: "Risorsa eliminata" });
      return;
    }
    setErr(r.error);
    if (r.popup) setPopup(r.popup);
    window.scrollTo(0, 0);
  }

  const isFormView = action === "new" || action === "edit";
  const emptyState = !loading && action === "list" && resourcesTotal <= 0;
  const formLinks = action === "edit" ? (editResource?.serviceLinks ?? []) : [];

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/resources.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">{action === "edit" ? "Modifica risorsa" : action === "new" ? "Nuova risorsa" : "Risorse"}</h1>
            <InfoBox>
              <p>
                Le risorse sono macchinari, dispositivi o dotazioni condivise con disponibilità limitata (es.
                &quot;Lettino abbronzante&quot;, &quot;Macchinario laser&quot;).
              </p>
              <ul>
                <li>
                  La <strong>quantità</strong> è la disponibilità massima <strong>contemporanea</strong> per sede: il
                  sistema conta il picco di utilizzo negli stessi minuti, non il totale della giornata.
                </li>
                <li>
                  Non puoi ridurre la quantità sotto il picco già prenotato: il salvataggio viene bloccato con il
                  dettaglio delle prenotazioni esistenti.
                </li>
                <li>Una risorsa collegata a servizi non può essere eliminata finché non la scolleghi.</li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">
            Gestisci le risorse condivise con una quantita massima disponibile contemporaneamente.
          </div>
        </div>
        <div className="bs-page-actions">
          {action === "list" ? (
            !emptyState ? (
              <a className="btn btn-primary btn-pill" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova risorsa
              </a>
            ) : null
          ) : (
            <a className="btn btn-outline-secondary btn-pill" href={href("")}>
              <i className="bi bi-arrow-left me-1" />
              Indietro
            </a>
          )}
        </div>
      </div>

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.err}</div>
        </div>
      ) : null}
      {err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{err}</div>
        </div>
      ) : null}

      {isFormView && form ? (
        <div className="row g-3">
          <div className="col-12">
            <div className="card p-4">
              <form className="row g-3" id="resourceForm" onSubmit={saveResource}>
                <input type="hidden" name="id" value={form.id} />

                <div className="col-12">
                  <label className="form-label">Nome</label>
                  <input className="form-control" name="name" required value={form.name} onChange={(e) => setForm((p) => (p ? { ...p, name: e.target.value } : p))} />
                  <div className="form-text">Esempio: “Lettino abbronzante”, “Macchinario Laser”, “Sala riunioni”.</div>
                </div>

                <div className="col-12">
                  <label className="form-label">Descrizione <span className="text-muted">(facoltativa)</span></label>
                  <textarea className="form-control" name="description" rows={3} value={form.description} onChange={(e) => setForm((p) => (p ? { ...p, description: e.target.value } : p))} />
                </div>

                <div className="col-12">
                  <label className="form-label">Quantità disponibile totale</label>
                  <input
                    className="form-control"
                    id="resourceQtyTotal"
                    type="number"
                    min={0}
                    step={1}
                    name="qty_total"
                    required
                    value={form.qty_total}
                    onChange={(e) => setForm((p) => (p ? { ...p, qty_total: e.target.value } : p))}
                  />
                  <div className="form-text">La quantità rappresenta il numero massimo di unità disponibili contemporaneamente per questa risorsa.</div>
                </div>

                {form.locations.length > 0 ? (
                  <div className="col-12">
                    <label className="form-label">Sedi abilitate</label>
                    <div className="table-responsive border rounded-3">
                      <table className="table table-sm align-middle mb-0">
                        <thead>
                          <tr>
                            <th>Sede</th>
                            <th className="text-center resources-location-enabled-cell">Attiva</th>
                            <th className="text-end resources-location-qty-cell">Quantità sede</th>
                          </tr>
                        </thead>
                        <tbody>
                          {form.locations.map((l, i) => (
                            <tr key={l.locationId}>
                              <td className="fw-semibold">{l.locationName}</td>
                              <td className="text-center">
                                <input
                                  className="form-check-input js-resource-location-enabled"
                                  type="checkbox"
                                  checked={l.isEnabled}
                                  onChange={(e) => setForm((p) => {
                                    if (!p) return p;
                                    const next = p.locations.slice();
                                    next[i] = { ...next[i], isEnabled: e.target.checked, qtyTotal: e.target.checked && next[i].qtyTotal < 0 ? 0 : next[i].qtyTotal };
                                    return { ...p, locations: next };
                                  })}
                                />
                              </td>
                              <td className="text-end">
                                <input
                                  className="form-control form-control-sm text-end js-resource-location-qty"
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={l.qtyTotal}
                                  readOnly={!l.isEnabled}
                                  onChange={(e) => setForm((p) => {
                                    if (!p) return p;
                                    const next = p.locations.slice();
                                    next[i] = { ...next[i], qtyTotal: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0) };
                                    return { ...p, locations: next };
                                  })}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="form-text">La disponibilità per sede viene usata in prenotazioni, agenda e servizi. La quantità totale resta come valore di compatibilità.</div>
                  </div>
                ) : null}

                <div className="col-12 d-flex gap-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva
                  </button>
                  <a className="btn btn-outline-secondary btn-pill" href={href("")}>Annulla</a>

                  {action === "edit" ? (
                    <button
                      className="btn btn-outline-danger btn-pill ms-auto"
                      type="button"
                      disabled={busy}
                      onClick={() => void removeResource(form.id, formLinks)}
                    >
                      <i className="bi bi-trash me-1" />
                      Elimina
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          </div>

        </div>
      ) : emptyState ? (
        <div className="card resources-empty-card">
          <div className="resources-empty-state">
            <div className="resources-empty-icon" aria-hidden="true"><i className="bi bi-tools" /></div>
            <h2>Nessuna risorsa configurata</h2>
            <p>Le risorse servono per macchinari, dispositivi o dotazioni condivise con disponibilità limitata. Creane una solo se un servizio deve bloccare una risorsa.</p>
            <a className="btn btn-primary btn-pill" href={href("&action=new")}>
              <i className="bi bi-plus-lg me-1" />
              Nuova risorsa
            </a>
          </div>
        </div>
      ) : !isFormView ? (
        <div className="card p-0">
          <div className="card-body">
            <div className="table-responsive">
              <table className="table align-middle">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th className="text-center">Quantità sede</th>
                    <th>Descrizione</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {!loading && items.length === 0 ? (
                    <tr><td colSpan={4} className="text-muted p-3">Nessuna risorsa abilitata per la sede selezionata.</td></tr>
                  ) : (
                    items.map((r) => {
                      // resources_location_summary con sede filtrata: qty della
                      // sede corrente (le righe non abilitate sono già filtrate).
                      const enabled = r.locations.filter((l) => l.isEnabled);
                      const qtyLabel = enabled.length > 0 ? String(Math.max(0, enabled[0].qtyTotal)) : String(r.qtyTotal);
                      return (
                        <tr key={r.id}>
                          <td className="fw-semibold">{r.name}</td>
                          <td className="text-center">
                            <span className="badge text-bg-primary">{qtyLabel}</span>
                          </td>
                          <td className="text-muted small">{truncateDescription(r.description)}</td>
                          <td className="text-end">
                            <a className="btn btn-sm btn-outline-primary" href={href(`&action=edit&id=${r.id}`)}><i className="bi bi-pencil" /></a>{" "}
                            <button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => void removeResource(r.id, r.serviceLinks)}>
                              <i className="bi bi-trash" />
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
        </div>
      ) : null}

      {/* MODALE di blocco (#resourceBlockModal): messaggio + accordion 'Servizi collegati'. */}
      {popup ? (
        <>
          <div className="modal fade show d-block" id="resourceBlockModal" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <div className="small-muted">Risorse</div>
                    <h5 className="modal-title fw-bold m-0" id="resourceBlockModalTitle">{popup.title || "Operazione non consentita"}</h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => { setPopup(null); setPopupOpenList(false); }} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning small mb-3" id="resourceBlockModalMessage">{popup.message}</div>
                  <div id="resourceBlockServiceList">
                    {popup.services.length === 0 ? (
                      <div className="text-muted small">Nessun servizio rilevato.</div>
                    ) : (
                      <div className="accordion" id="resourceBlockServiceAccordion">
                        <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                          <h3 className="accordion-header">
                            <button
                              className={`accordion-button ${popupOpenList ? "" : "collapsed"} bg-white shadow-none py-2`}
                              type="button"
                              aria-expanded={popupOpenList}
                              onClick={() => setPopupOpenList((v) => !v)}
                            >
                              <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                                <span className="fw-semibold">Servizi collegati</span>
                                <span className="badge rounded-pill text-bg-info">{popup.services.length}</span>
                              </span>
                            </button>
                          </h3>
                          <div className={`accordion-collapse collapse ${popupOpenList ? "show" : ""}`}>
                            <div className="accordion-body py-2">
                              <div className="list-group list-group-flush">
                                {popup.services.map((s, i) => (
                                  <div className="list-group-item px-0" key={i}>
                                    {s.service_name} — quantità risorsa nel servizio: {Math.max(1, Number(s.qty_required ?? 1) || 1)}
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
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => { setPopup(null); setPopupOpenList(false); }}>Chiudi</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
