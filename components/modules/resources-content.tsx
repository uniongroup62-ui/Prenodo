"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP resources page (app/pages/resources.php): lista
// (Nome | Quantità | Descrizione | Azioni) + form Nuova/Modifica risorsa nella
// stessa pagina (name, description, qty_total, per-sede resource_location_
// enabled/qty), eliminazione con vincolo servizi. Backend:
// /api/manage/resources action=resource_save / resource_delete (messaggi
// legacy: "Nome risorsa obbligatorio", "Seleziona almeno una sede in cui la
// risorsa e disponibile.", guard riduzione qty servizi/prenotazioni, "Risorsa
// non eliminata: è associata a uno o più servizi.", "Risorsa creata/
// aggiornata/eliminata").

type ResourceLocationRow = { locationId: number; locationName: string; qtyTotal: number; isEnabled: boolean };
type SharedResource = {
  id: number;
  name: string;
  description: string;
  qtyTotal: number;
  locations: ResourceLocationRow[];
  serviceLinks: Array<{ serviceId: number; serviceName: string; isActive: boolean }>;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

type ResourceForm = { id: number; name: string; description: string; qty_total: number; locations: ResourceLocationRow[] };

export function ResourcesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [items, setItems] = useState<SharedResource[]>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ResourceForm | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=resources`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setItems(Array.isArray(j.resources) ? j.resources : []);
        setLocations(Array.isArray(j.locations) ? j.locations.map((l: { id: number; name: string }) => ({ id: Number(l.id), name: String(l.name) })) : []);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setForm({
      id: 0,
      name: "",
      description: "",
      qty_total: 1,
      locations: locations.map((l) => ({ locationId: l.id, locationName: l.name, qtyTotal: 1, isEnabled: true })),
    });
  }

  function openEdit(r: SharedResource) {
    const byId = new Map(r.locations.map((l) => [l.locationId, l]));
    setForm({
      id: r.id,
      name: r.name,
      description: r.description,
      qty_total: r.qtyTotal,
      locations: locations.map((l) => {
        const cur = byId.get(l.id);
        return { locationId: l.id, locationName: l.name, qtyTotal: Number(cur?.qtyTotal ?? 0), isEnabled: Boolean(cur?.isEnabled ?? false) };
      }),
    });
  }

  async function post(fields: Record<string, string>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Errore salvataggio: verifica nome duplicato o schema DB (schema aggiornato)."));
      return j as Record<string, unknown>;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveResource(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const j = await post({
      action: "resource_save",
      id: String(form.id),
      name: form.name,
      description: form.description,
      qty_total: String(form.qty_total),
      locations_json: JSON.stringify(form.locations.map((l) => ({ locationId: l.locationId, qtyTotal: l.qtyTotal, isEnabled: l.isEnabled ? 1 : 0 }))),
    });
    if (j) {
      setMsg(form.id > 0 ? "Risorsa aggiornata" : "Risorsa creata");
      setForm(null);
      await load();
    }
  }

  async function removeResource(r: SharedResource) {
    // Guard legacy client-side (resources.js): con servizi collegati popup bloccante.
    if (r.serviceLinks.length) {
      window.alert(`La risorsa è associata ai servizi elencati. Elimina prima la risorsa dai servizi collegati: finché è presente in un servizio non può essere eliminata.\n\n• ${r.serviceLinks.map((s) => s.serviceName).join("\n• ")}`);
      return;
    }
    if (!window.confirm("Eliminare questa risorsa?")) return;
    const j = await post({ action: "resource_delete", id: String(r.id) });
    if (j) {
      setMsg("Risorsa eliminata");
      await load();
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/resources.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Risorse</div>
          <h1 className="bs-page-title">Risorse</h1>
          <div className="bs-page-subtitle">
            Gestisci le risorse condivise con una quantita massima disponibile contemporaneamente.
          </div>
        </div>
        <div className="bs-page-actions">
          <button className="btn btn-primary" type="button" onClick={openNew}>
            <i className="bi bi-plus-lg me-1" />
            Nuova risorsa
          </button>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      {form ? (
        <div className="card p-3 mb-3">
          <h2 className="h6">{form.id > 0 ? "Modifica risorsa" : "Nuova risorsa"}</h2>
          <form onSubmit={saveResource}>
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Nome *</label>
                <input className="form-control" name="name" required value={form.name} onChange={(e) => setForm((p) => (p ? { ...p, name: e.target.value } : p))} />
              </div>
              <div className="col-md-6">
                <label className="form-label">Quantità disponibile totale</label>
                <input className="form-control" type="number" min={0} name="qty_total" value={form.qty_total} onChange={(e) => setForm((p) => (p ? { ...p, qty_total: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0) } : p))} />
              </div>
              <div className="col-12">
                <label className="form-label">Descrizione (opzionale)</label>
                <textarea className="form-control" rows={2} name="description" value={form.description} onChange={(e) => setForm((p) => (p ? { ...p, description: e.target.value } : p))} />
              </div>
              {form.locations.length > 0 ? (
                <div className="col-12">
                  <label className="form-label">Disponibilità per sede</label>
                  <div className="table-responsive border rounded">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Sede</th>
                          <th className="text-center">Attiva</th>
                          <th style={{ width: 160 }}>Quantità sede</th>
                        </tr>
                      </thead>
                      <tbody>
                        {form.locations.map((l, i) => (
                          <tr key={l.locationId}>
                            <td>{l.locationName}</td>
                            <td className="text-center">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                checked={l.isEnabled}
                                onChange={(e) => setForm((p) => {
                                  if (!p) return p;
                                  const next = p.locations.slice();
                                  next[i] = { ...next[i], isEnabled: e.target.checked };
                                  return { ...p, locations: next };
                                })}
                              />
                            </td>
                            <td>
                              <input
                                className="form-control form-control-sm"
                                type="number"
                                min={0}
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
                  <div className="form-text">La quantità totale resta come compatibilità; il vincolo usa la quantità della sede.</div>
                </div>
              ) : null}
            </div>
            <div className="mt-3 d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={() => setForm(null)}>Annulla</button>
            </div>
          </form>
        </div>
      ) : null}

      {!loading && items.length === 0 && !form ? (
        <div className="card resources-empty-card">
          <div className="resources-empty-state">
            <div className="resources-empty-icon" aria-hidden="true">
              <i className="bi bi-tools" />
            </div>
            <h2>Nessuna risorsa configurata</h2>
            <p>
              Le risorse servono per macchinari, dispositivi o dotazioni condivise con disponibilità
              limitata. Creane una solo se un servizio deve bloccare una risorsa.
            </p>
            <button className="btn btn-primary btn-pill" type="button" onClick={openNew}>
              <i className="bi bi-plus-lg me-1" />
              Nuova risorsa
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Sedi / Quantità</th>
                  <th>Descrizione</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="text-muted p-3">Caricamento…</td></tr>
                ) : (
                  items.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-semibold">
                        {r.name}
                        {r.serviceLinks.length ? <span className="badge text-bg-info ms-2">{r.serviceLinks.length} servizi</span> : null}
                      </td>
                      <td className="small">
                        {r.locations.filter((l) => l.isEnabled).length
                          ? r.locations.filter((l) => l.isEnabled).map((l) => `${l.locationName}: ${l.qtyTotal}`).join(" • ")
                          : `Totale: ${r.qtyTotal}`}
                      </td>
                      <td className="text-muted small">{r.description || "—"}</td>
                      <td className="text-end">
                        <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openEdit(r)}>
                          Modifica
                        </button>
                        <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeResource(r)} disabled={busy}>
                          Elimina
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
