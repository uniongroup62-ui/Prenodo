"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP fidelity/gifts page (app/pages/gifts.php): the Omaggi
// CAMPAIGN manager + the ASSIGNED INSTANCES list (gifts.php ~1155-1591) + the
// manual assignment modal (~2030-2097). Fed by /api/manage/gifts:
//   - GET  action=campaigns -> ManageGiftListRow[] (name, reward, validity, status, instances)
//   - GET  action=instances (inst_client_id/inst_gift_id/inst_state/inst_p, 25/pagina)
//   - POST action=toggle_active (id, active)   — activate/deactivate (content-gated)
//   - POST action=delete (id)                  — cascade delete
//   - POST action=assign_manual (gift_id, client_id, expires_days, force_ineligible)
// The create/edit editor lives in gift_form-content (router: gifts action=new|edit);
// the per-instance detail is gift_instance-content (route /slug/gift_instance?id=N).

type Campaign = {
  id: number;
  name: string;
  description: string;
  active: boolean;
  isCurrentlyActive: boolean;
  autoDisabled: boolean;
  fidelityOnly: boolean;
  validFrom: string;
  validTo: string;
  instancesCount: number;
  rewardSummary: string;
  locationIds: number[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

type InstanceRow = {
  id: number;
  createdAt: string;
  clientId: number;
  clientName: string;
  giftId: number;
  giftName: string;
  locationName: string;
  state: string;
  expiresAt: string;
  manual: boolean;
};

type InstancesPage = { rows: InstanceRow[]; page: number; perPage: number; totalPages: number; total: number };

// Badge stato istanza legacy (gifts.php ~1560-1564).
function instStateBadge(state: string): string {
  if (state === "disponibile") return "text-bg-success";
  if (state === "riscattato") return "text-bg-dark";
  if (state === "scaduto") return "text-bg-warning text-dark";
  if (state === "annullato") return "text-bg-danger";
  return "text-bg-secondary";
}

function fmtDtShort(iso: string): string {
  if (!iso || iso.length < 10) return "—";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export function GiftsContent() {
  const slug = tenantSlug();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Istanze assegnate (gifts.php vista istanze): filtri + paginazione 25/pagina.
  const [instances, setInstances] = useState<InstancesPage | null>(null);
  const [instState, setInstState] = useState("");
  const [instClientId, setInstClientId] = useState(() => {
    if (typeof window === "undefined") return 0;
    return Number.parseInt(new URLSearchParams(window.location.search).get("inst_client_id") ?? "0", 10) || 0;
  });
  const [instPage, setInstPage] = useState(1);
  // Assegnazione manuale.
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignGiftId, setAssignGiftId] = useState("");
  const [assignClient, setAssignClient] = useState("");
  const [assignDays, setAssignDays] = useState("");
  const [clients, setClients] = useState<Array<{ id: number; name: string }>>([]);

  const loadInstances = useCallback(() => {
    const params = new URLSearchParams({ slug, action: "instances", inst_p: String(instPage) });
    if (instState) params.set("inst_state", instState);
    if (instClientId > 0) params.set("inst_client_id", String(instClientId));
    return fetch(`/api/manage/gifts?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setInstances((j.instances ?? null) as InstancesPage | null))
      .catch(() => setInstances(null));
  }, [slug, instPage, instState, instClientId]);

  useEffect(() => { loadInstances(); }, [loadInstances]);

  useEffect(() => {
    if (!assignOpen || clients.length) return;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.clients) ? j.clients : [];
        setClients(list.map((c: { id: number; full_name?: string; name?: string }) => ({ id: Number(c.id), name: String(c.full_name ?? c.name ?? `#${c.id}`) })));
      })
      .catch(() => setClients([]));
  }, [assignOpen, clients.length, slug]);

  const load = useCallback(() => {
    return fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}&action=campaigns`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setCampaigns(Array.isArray(j.campaigns) ? j.campaigns : []))
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`gifts${suffix}`.replace("&", "?")}`;
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (term !== "" && !`${c.name} ${c.description} ${c.rewardSummary}`.toLowerCase().includes(term)) return false;
      if (statusFilter === "active" && !c.active) return false;
      if (statusFilter === "inactive" && c.active) return false;
      return true;
    });
  }, [campaigns, q, statusFilter]);

  async function post(fields: Record<string, string>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(String(j.error || "Operazione non riuscita."));
      if (Array.isArray(j.campaigns)) setCampaigns(j.campaigns as Campaign[]);
      return j;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Campaign) {
    const j = await post({ action: "toggle_active", id: String(c.id), active: c.active ? "0" : "1" });
    if (j) setMsg(c.active ? "Campagna disattivata." : "Campagna attivata.");
  }

  async function remove(c: Campaign) {
    if (!window.confirm(`Eliminare la campagna omaggio "${c.name}"? Le istanze accumulate e i premi collegati verranno rimossi.`)) return;
    const j = await post({ action: "delete", id: String(c.id) });
    if (j) setMsg("Campagna eliminata.");
  }

  // Assegnazione manuale (gifts.php _mode=assign_manual): crea un'istanza in
  // stato Disponibile; se il cliente non è idoneo (fidelity_only) il server
  // risponde ineligible+canForce e la UI chiede conferma per forzare.
  async function submitAssign(e: React.FormEvent) {
    e.preventDefault();
    const giftId = Number.parseInt(assignGiftId, 10) || 0;
    const m = /#(\d+)\s*$/.exec(assignClient);
    const clientId = m ? Number.parseInt(m[1], 10) : Number.parseInt(assignClient, 10) || 0;
    if (giftId <= 0 || clientId <= 0) {
      setErr("Seleziona campagna e cliente.");
      return;
    }
    const fields: Record<string, string> = { action: "assign_manual", gift_id: String(giftId), client_id: String(clientId) };
    if (assignDays.trim() !== "") fields.expires_days = assignDays.trim();
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const call = async (extra: Record<string, string> = {}) => {
        const res = await fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ ...fields, ...extra }),
        });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      };
      let r = await call();
      if (r.json.ineligible && r.json.canForce) {
        if (!window.confirm(`${String(r.json.error ?? "Cliente non idoneo.")}\n\nAssegnare comunque l'omaggio?`)) return;
        r = await call({ force_ineligible: "1" });
      }
      if (r.status >= 400 || r.json.ok === false) throw new Error(String(r.json.error || "Operazione non riuscita."));
      setMsg(String(r.json.message ?? "Gift assegnato"));
      setAssignOpen(false);
      setAssignGiftId("");
      setAssignClient("");
      setAssignDays("");
      await loadInstances();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/gifts.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">Fidelity / Omaggi</h1>
          <div className="bs-page-subtitle">Omaggi avanzati con regole e tracking automatico.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-primary" href={href("&action=new")}>
              <i className="bi bi-plus-lg me-1" />
              Nuova campagna
            </a>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      {!loading && campaigns.length === 0 ? (
        <div className="card border-0 shadow-sm gifts-empty-card">
          <div className="gifts-empty-state">
            <div className="gifts-empty-icon" aria-hidden="true">
              <i className="bi bi-gift" />
            </div>
            <h2>Nessun omaggio configurato</h2>
            <p>Crea una campagna omaggio per iniziare ad assegnare premi ai clienti e seguirne accumulo, disponibilità e riscatto.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova campagna
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form className="row g-2 align-items-end" onSubmit={(e) => e.preventDefault()}>
              <div className="col-lg-6">
                <label className="form-label">Cerca</label>
                <input className="form-control" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, premio o descrizione" />
              </div>
              <div className="col-lg-3">
                <label className="form-label">Stato</label>
                <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tutte</option>
                  <option value="active">Attive</option>
                  <option value="inactive">Disattivate</option>
                </select>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Campagna</th>
                    <th>Premio</th>
                    <th>Validità</th>
                    <th>Stato</th>
                    <th className="text-end">Istanze</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessuna campagna trovata."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div className="fw-semibold">{c.name}</div>
                          {c.description ? <div className="text-muted small">{c.description}</div> : null}
                          {c.fidelityOnly ? <span className="badge bg-info text-dark mt-1">Solo Fidelity</span> : null}
                        </td>
                        <td>{c.rewardSummary}</td>
                        <td>{c.validFrom || c.validTo ? `${fmtDate(c.validFrom) || "…"} – ${fmtDate(c.validTo) || "…"}` : <span className="text-muted">Sempre</span>}</td>
                        <td>
                          {c.active ? <span className="badge bg-success">Attiva</span> : <span className="badge bg-secondary">Disattivata</span>}
                          {c.active && c.isCurrentlyActive ? <span className="badge bg-primary ms-1">In corso</span> : null}
                          {c.autoDisabled ? <span className="badge bg-warning text-dark ms-1">Auto-off</span> : null}
                        </td>
                        <td className="text-end">{c.instancesCount}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-primary me-1" href={href(`&action=edit&id=${c.id}`)}>
                            <i className="bi bi-pencil" /> Modifica
                          </a>
                          <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => toggle(c)} disabled={busy}>
                            {c.active ? "Disattiva" : "Attiva"}
                          </button>
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => remove(c)} disabled={busy}>
                            <i className="bi bi-trash" /> Elimina
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* OMAGGI ASSEGNATI (gifts.php vista istanze ~1155-1591) */}
          <div className="card mt-3">
            <div className="card-body pb-0">
              <div className="d-flex justify-content-between align-items-end flex-wrap gap-2 mb-2">
                <div>
                  <h2 className="h6 mb-1">Omaggi assegnati</h2>
                  <div className="text-muted small">Istanze accumulate, disponibili e riscattate dei clienti.</div>
                </div>
                <div className="d-flex gap-2 align-items-end flex-wrap">
                  <div>
                    <label className="form-label small mb-1">Stato</label>
                    <select className="form-select form-select-sm" value={instState} onChange={(e) => { setInstState(e.target.value); setInstPage(1); }}>
                      <option value="">Tutti</option>
                      <option value="accumulo">Accumulo</option>
                      <option value="disponibile">Disponibile</option>
                      <option value="riscattato">Riscattato</option>
                      <option value="scaduto">Scaduto</option>
                      <option value="annullato">Annullato</option>
                    </select>
                  </div>
                  {instClientId > 0 ? (
                    <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => { setInstClientId(0); setInstPage(1); }}>
                      Cliente #{instClientId} ✕
                    </button>
                  ) : null}
                  <button className="btn btn-sm btn-success" type="button" onClick={() => setAssignOpen((v) => !v)}>
                    <i className="bi bi-check2 me-1" />
                    Assegna gift manualmente
                  </button>
                </div>
              </div>

              {assignOpen ? (
                <form className="border rounded p-3 mb-3" onSubmit={submitAssign}>
                  <div className="row g-2 align-items-end">
                    <div className="col-lg-4">
                      <label className="form-label small">Campagna</label>
                      <select className="form-select form-select-sm" value={assignGiftId} onChange={(e) => setAssignGiftId(e.target.value)} required>
                        <option value="">Seleziona campagna…</option>
                        {campaigns.filter((c) => c.active).map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-lg-4">
                      <label className="form-label small">Cliente</label>
                      <input className="form-control form-control-sm" list="giftAssignClients" value={assignClient} onChange={(e) => setAssignClient(e.target.value)} placeholder="Cerca cliente…" required />
                      <datalist id="giftAssignClients">
                        {clients.map((c) => (
                          <option key={c.id} value={`${c.name} #${c.id}`} />
                        ))}
                      </datalist>
                    </div>
                    <div className="col-lg-2">
                      <label className="form-label small">Scadenza (giorni)</label>
                      <input className="form-control form-control-sm" type="number" min={1} value={assignDays} onChange={(e) => setAssignDays(e.target.value)} placeholder="Predefinita" />
                    </div>
                    <div className="col-lg-2">
                      <button className="btn btn-sm btn-success w-100" type="submit" disabled={busy}>Assegna</button>
                    </div>
                  </div>
                  <div className="form-text mt-1">
                    Crea un&apos;istanza in stato <strong>Disponibile</strong> per il cliente, anche se non ha ancora completato le regole. Se vuoto, usa la scadenza configurata sull&apos;omaggio.
                  </div>
                </form>
              ) : null}
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Cliente</th>
                    <th>Gift</th>
                    <th>Sede</th>
                    <th>Stato</th>
                    <th>Scadenza</th>
                    <th className="text-end">Dettagli</th>
                  </tr>
                </thead>
                <tbody>
                  {!instances || instances.rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted p-3">Nessun omaggio assegnato trovato.</td>
                    </tr>
                  ) : (
                    instances.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDtShort(r.createdAt)}</td>
                        <td>
                          {r.clientName}
                          {r.manual ? <span className="badge text-bg-info ms-1">Manuale</span> : null}
                        </td>
                        <td>{r.giftName}</td>
                        <td>{r.locationName || "—"}</td>
                        <td><span className={`badge ${instStateBadge(r.state)} text-uppercase`}>{r.state}</span></td>
                        <td>{r.expiresAt ? fmtDtShort(r.expiresAt) : "—"}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-primary" href={`/${encodeURIComponent(slug)}/gift_instance?id=${r.id}`} title="Apri dettagli">
                            <i className="bi bi-eye" />
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {instances && instances.totalPages > 1 ? (
              <div className="d-flex justify-content-between align-items-center p-2 border-top">
                <span className="text-muted small">Pagina {instances.page} di {instances.totalPages} • {instances.total} istanze</span>
                <div className="btn-group">
                  <button className="btn btn-sm btn-outline-secondary" type="button" disabled={instances.page <= 1} onClick={() => setInstPage((p) => Math.max(1, p - 1))}>‹</button>
                  <button className="btn btn-sm btn-outline-secondary" type="button" disabled={instances.page >= instances.totalPages} onClick={() => setInstPage((p) => p + 1)}>›</button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
