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

export function GiftsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
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
  // Vista legacy: default = lista istanze (Omaggi assegnati); ?action=campaigns = Campagne gift.
  const [view] = useState<"list" | "campaigns">(() => {
    if (typeof window === "undefined") return "list";
    return new URLSearchParams(window.location.search).get("action") === "campaigns" ? "campaigns" : "list";
  });
  const [instGiftId, setInstGiftId] = useState(0);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [openMenuId, setOpenMenuId] = useState(0);
  const [summaryFor, setSummaryFor] = useState<Campaign | null>(null);
  const [summaryStats, setSummaryStats] = useState<Record<string, unknown> | null>(null);

  const loadInstances = useCallback(() => {
    const params = new URLSearchParams({ slug, action: "instances", inst_p: String(instPage) });
    if (instState) params.set("inst_state", instState);
    if (instClientId > 0) params.set("inst_client_id", String(instClientId));
    if (instGiftId > 0) params.set("inst_gift_id", String(instGiftId));
    return fetch(`/api/manage/gifts?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setInstances((j.instances ?? null) as InstancesPage | null))
      .catch(() => setInstances(null));
  }, [slug, instPage, instState, instClientId, instGiftId]);

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
  }, [clients.length, slug]);

  useEffect(() => {
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setLocations(Array.isArray(j.locations) ? j.locations.map((l: { id: number; name?: string }) => ({ id: Number(l.id), name: String(l.name ?? `Sede #${l.id}`) })) : []))
      .catch(() => setLocations([]));
  }, [slug]);

  // Stats per il modale Riepilogo.
  useEffect(() => {
    if (!summaryFor) { setSummaryStats(null); return; }
    fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}&action=campaign_summary&id=${summaryFor.id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setSummaryStats(j.stats ?? null))
      .catch(() => setSummaryStats(null));
  }, [summaryFor, slug]);

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
    if (!window.confirm(`Eliminare questa campagna e tutti i movimenti associati?`)) return;
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


  // Badge stato campagna legacy (campaignStatusMeta): Sospesa (auto-off da
  // Fidelity), Disattivata, Completata (finestra chiusa), Programmata (futura),
  // Attiva.
  function campaignStatusMeta(c: Campaign): { label: string; badge: string } {
    const today = new Date().toISOString().slice(0, 10);
    if (c.autoDisabled) return { label: "Sospesa", badge: "warning text-dark" };
    if (!c.active) return { label: "Disattivata", badge: "secondary" };
    if (c.validTo && c.validTo.slice(0, 10) < today) return { label: "Completata", badge: "dark" };
    if (c.validFrom && c.validFrom.slice(0, 10) > today) return { label: "Programmata", badge: "info" };
    return { label: "Attiva", badge: "success" };
  }
  const locationNames = (ids: number[]): string => {
    if (!ids.length) return "Tutte le sedi";
    return ids.map((id) => locations.find((l) => l.id === id)?.name ?? `Sede #${id}`).join(", ");
  };

  const emptyState = !loading && campaigns.length === 0 && (instances?.total ?? 0) === 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/gifts.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">{view === "campaigns" ? "Fidelity / Campagne gift" : "Fidelity / Omaggi"}</h1>
          <div className="bs-page-subtitle">
            {view === "campaigns" ? "Gestisci campagne, premi, sedi e stati." : "Omaggi avanzati con regole e tracking automatico."}
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {view === "campaigns" ? (
              <>
                <a className="btn btn-outline-secondary" href={href("")}>
                  <i className="bi bi-arrow-left me-1" />
                  Omaggi assegnati
                </a>
                {!emptyState ? (
                  <a className="btn btn-primary" href={href("&action=new")}>
                    Nuova campagna
                  </a>
                ) : null}
              </>
            ) : (
              <>
                <button className="btn btn-outline-success" type="button" disabled={campaigns.length === 0} onClick={() => setAssignOpen(true)}>
                  <i className="bi bi-person-plus me-1" />
                  Assegna gift
                </button>
                <a className="btn btn-outline-primary" href={href("&action=campaigns")}>
                  Campagne gift
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      {emptyState ? (
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
      ) : view === "campaigns" ? (
        /* ===== VISTA CAMPAGNE (gifts.php action=campaigns) ===== */
        <div className="card">
          <div className="card-header d-flex justify-content-between align-items-center">
            <span className="fw-semibold">Campagne gift</span>
            <span className="text-muted small">{filtered.length} campagne</span>
          </div>
          <div className="table-responsive gifts-campaigns-table-wrap">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Uso</th>
                  <th>Sede</th>
                  <th>Premio</th>
                  <th className="text-center">Stato</th>
                  <th className="text-end gifts-campaign-actions-col">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="text-muted p-3">Caricamento…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={6} className="text-muted p-3">Nessun omaggio configurato.</td></tr>
                ) : (
                  filtered.map((c) => {
                    const meta = campaignStatusMeta(c);
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="fw-semibold">{c.name}</div>
                          {c.description ? <div className="text-muted small">{c.description}</div> : null}
                        </td>
                        <td className="text-muted small">{c.fidelityOnly ? "Solo clienti con Fidelity" : "Tutti i clienti"}</td>
                        <td className="text-muted small">{locationNames(c.locationIds)}</td>
                        <td className="text-muted small">{c.rewardSummary || "—"}</td>
                        <td className="text-center">
                          <span className={`badge text-bg-${meta.badge}`}>{meta.label}</span>
                        </td>
                        <td className="text-end gifts-campaign-actions">
                          <div className={`dropdown ${openMenuId === c.id ? "show" : ""}`}>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary gifts-campaign-actions__trigger"
                              aria-label={`Azioni campagna ${c.name}`}
                              onClick={() => setOpenMenuId(openMenuId === c.id ? 0 : c.id)}
                            >
                              <i className="bi bi-three-dots-vertical" />
                            </button>
                            <ul className={`dropdown-menu dropdown-menu-end ${openMenuId === c.id ? "show" : ""}`}>
                              <li>
                                <button className="dropdown-item" type="button" onClick={() => { setOpenMenuId(0); setSummaryFor(c); }}>
                                  <i className="bi bi-card-list me-2" />
                                  Riepilogo
                                </button>
                              </li>
                              <li>
                                <a className="dropdown-item" href={href(`&action=edit&id=${c.id}`)}>
                                  <i className="bi bi-pencil me-2" />
                                  Modifica
                                </a>
                              </li>
                              <li>
                                <a className="dropdown-item" href={href(`&action=clone&id=${c.id}`)}>
                                  <i className="bi bi-files me-2" />
                                  Clona campagna
                                </a>
                              </li>
                              <li><hr className="dropdown-divider" /></li>
                              <li>
                                <button className="dropdown-item" type="button" disabled={busy} onClick={() => { setOpenMenuId(0); void toggle(c); }}>
                                  <i className={`bi ${c.active ? "bi-pause-circle" : "bi-play-circle"} me-2`} />
                                  {c.active ? "Disattiva" : "Attiva"}
                                </button>
                              </li>
                              <li><hr className="dropdown-divider" /></li>
                              <li>
                                <button className="dropdown-item text-danger" type="button" disabled={busy} onClick={() => { setOpenMenuId(0); void remove(c); }}>
                                  <i className="bi bi-trash me-2" />
                                  Elimina
                                </button>
                              </li>
                            </ul>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ===== VISTA LISTA ISTANZE (gifts.php default: "Omaggi assegnati ai clienti") ===== */
        <div className="card">
          <div className="card-header d-flex justify-content-between align-items-center">
            <div>
              <span className="fw-semibold">Omaggi assegnati ai clienti</span>
              <div className="text-muted small">Lista di tutte le istanze generate (accumulo / disponibile / riscattato / scaduto / annullato).</div>
            </div>
            <span className="text-muted small">25 risultati per pagina</span>
          </div>
          <div className="card-body pb-0">
            <form className="row g-2 align-items-end" onSubmit={(e) => { e.preventDefault(); setInstPage(1); void loadInstances(); }}>
              <div className="col-lg-3">
                <label className="form-label small">Cliente</label>
                <select className="form-select form-select-sm" value={String(instClientId)} onChange={(e) => { setInstClientId(Number(e.target.value) || 0); setInstPage(1); }}>
                  <option value="0">Tutti</option>
                  {clients.map((c) => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-lg-3">
                <label className="form-label small">gift</label>
                <select className="form-select form-select-sm" value={String(instGiftId)} onChange={(e) => { setInstGiftId(Number(e.target.value) || 0); setInstPage(1); }}>
                  <option value="0">Tutti</option>
                  {campaigns.map((c) => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-lg-2">
                <label className="form-label small">Stato</label>
                <select className="form-select form-select-sm" value={instState} onChange={(e) => { setInstState(e.target.value); setInstPage(1); }}>
                  <option value="">Tutti</option>
                  <option value="accumulo">Accumulo</option>
                  <option value="disponibile">Disponibile</option>
                  <option value="riscattato">Riscattato</option>
                  <option value="scaduto">Scaduto</option>
                  <option value="annullato">Annullato</option>
                </select>
              </div>
              <div className="col-lg-4 d-flex gap-2">
                <button className="btn btn-sm btn-outline-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {instClientId > 0 || instGiftId > 0 || instState !== "" ? (
                  <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => { setInstClientId(0); setInstGiftId(0); setInstState(""); setInstPage(1); }}>
                    Reset
                  </button>
                ) : null}
              </div>
            </form>
          </div>
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Cliente</th>
                  <th>gift</th>
                  <th>Sede</th>
                  <th className="text-center">Stato</th>
                  <th className="text-muted">Scadenza</th>
                  <th className="text-end">Dettagli</th>
                </tr>
              </thead>
              <tbody>
                {!instances || instances.rows.length === 0 ? (
                  <tr><td colSpan={7} className="text-muted p-3">Nessun omaggio assegnato trovato.</td></tr>
                ) : (
                  instances.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="text-muted small">{fmtDtShort(r.createdAt)}</td>
                      <td>
                        {r.clientName}
                        {r.manual ? <span className="badge text-bg-info ms-2">Manuale</span> : null}
                      </td>
                      <td>{r.giftName}</td>
                      <td className="text-muted small">{r.locationName || "—"}</td>
                      <td className="text-center">
                        <span className={`badge ${instStateBadge(r.state)} text-uppercase`}>{r.state}</span>
                      </td>
                      <td className="text-muted small">{r.expiresAt ? fmtDtShort(r.expiresAt) : "—"}</td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" title="Apri dettagli" href={`/${encodeURIComponent(slug)}/gift_instance?id=${r.id}`}>
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
            <div className="card-footer d-flex justify-content-between align-items-center">
              <span className="text-muted small">Pagina {instances.page} di {instances.totalPages} • Totale: {instances.total}</span>
              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={instances.page <= 1} onClick={() => setInstPage(instances.page - 1)}>
                  « Prev
                </button>
                <button className="btn btn-sm btn-outline-secondary" type="button" disabled={instances.page >= instances.totalPages} onClick={() => setInstPage(instances.page + 1)}>
                  Next »
                </button>
              </div>
            </div>
          ) : instances ? (
            <div className="card-footer text-muted small">Totale: {instances.total}</div>
          ) : null}
        </div>
      )}

      {/* MODALE "Assegna gift manualmente" (#assignGiftModal). */}
      {assignOpen ? (
        <div className="modal fade show d-block" id="assignGiftModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-lg modal-dialog-centered">
            <form className="modal-content" onSubmit={submitAssign}>
              <div className="modal-header">
                <h5 className="modal-title fw-bold m-0">Assegna gift manualmente</h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setAssignOpen(false)} />
              </div>
              <div className="modal-body">
                <div className="text-muted small mb-3">
                  Crea un&apos;istanza in stato Disponibile per il cliente, anche se non ha ancora completato le regole. Se il cliente non è idoneo all&apos;omaggio, prima del salvataggio verrà chiesto se vuoi assegnarlo comunque.
                </div>
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Cliente</label>
                    <input className="form-control" list="giftAssignClients" placeholder="— seleziona —" value={assignClient} onChange={(e) => setAssignClient(e.target.value)} />
                    <datalist id="giftAssignClients">
                      {clients.map((c) => (
                        <option value={`${c.name} #${c.id}`} key={c.id} />
                      ))}
                    </datalist>
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">gift</label>
                    <select className="form-select" value={assignGiftId} onChange={(e) => setAssignGiftId(e.target.value)}>
                      <option value="">— seleziona —</option>
                      {campaigns.filter((c) => c.isCurrentlyActive || c.active).map((c) => (
                        <option value={c.id} key={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <div className="form-text">Sono visibili solo gli omaggi attivi, nel periodo di validità e validi per la sede corrente.</div>
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Scadenza (giorni) (opzionale)</label>
                    <input className="form-control" type="number" min="1" placeholder="—" value={assignDays} onChange={(e) => setAssignDays(e.target.value)} />
                    <div className="form-text">Se vuoto, usa la scadenza configurata sull&apos;omaggio.</div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setAssignOpen(false)}>
                  Annulla
                </button>
                <button className="btn btn-success" type="submit" disabled={busy}>
                  <i className="bi bi-check2 me-1" />
                  Assegna
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODALE "Riepilogo" campagna (#giftSummaryModal): Configurazione + Statistiche. */}
      {summaryFor ? (
        <div className="modal fade show d-block" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-xl modal-dialog-scrollable">
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title fw-bold m-0">{summaryFor.name}</h5>
                  <div className="text-muted small">Riepilogo campagna omaggio</div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setSummaryFor(null)} />
              </div>
              <div className="modal-body">
                <div className="row g-3">
                  <div className="col-lg-6">
                    <div className="card p-3 h-100">
                      <div className="text-muted small text-uppercase fw-semibold mb-2">Configurazione</div>
                      <table className="table table-sm mb-0">
                        <tbody>
                          <tr><th className="text-muted">Stato</th><td><span className={`badge text-bg-${campaignStatusMeta(summaryFor).badge}`}>{campaignStatusMeta(summaryFor).label}</span></td></tr>
                          <tr><th className="text-muted">Validità</th><td>{summaryFor.validFrom ? fmtDate(summaryFor.validFrom.slice(0, 10)) : "—"} – {summaryFor.validTo ? fmtDate(summaryFor.validTo.slice(0, 10)) : "—"}</td></tr>
                          <tr><th className="text-muted">Uso</th><td>{summaryFor.fidelityOnly ? "Solo clienti con Fidelity" : "Tutti i clienti"}</td></tr>
                          <tr><th className="text-muted">Sedi abilitate</th><td>{locationNames(summaryFor.locationIds)}</td></tr>
                          <tr><th className="text-muted">Premio</th><td>{summaryFor.rewardSummary || "—"}</td></tr>
                          {summaryFor.description ? <tr><th className="text-muted">Descrizione</th><td>{summaryFor.description}</td></tr> : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="col-lg-6">
                    <div className="card p-3 h-100">
                      <div className="text-muted small text-uppercase fw-semibold mb-2">Statistiche</div>
                      {!summaryStats ? (
                        <div className="text-muted small">Calcolo impatto in corso...</div>
                      ) : (
                        <table className="table table-sm mb-0">
                          <tbody>
                            <tr><th className="text-muted">Clienti coinvolti</th><td className="text-end">{String(summaryStats.clients ?? 0)}</td></tr>
                            <tr><th className="text-muted">Istanze totali</th><td className="text-end">{String(summaryStats.total ?? 0)}</td></tr>
                            <tr><th className="text-muted">Accumulo</th><td className="text-end">{String(summaryStats.accumulo ?? 0)}</td></tr>
                            <tr><th className="text-muted">Disponibile</th><td className="text-end">{String(summaryStats.disponibile ?? 0)}</td></tr>
                            <tr><th className="text-muted">Riscattato</th><td className="text-end">{String(summaryStats.riscattato ?? 0)}</td></tr>
                            <tr><th className="text-muted">Scaduto</th><td className="text-end">{String(summaryStats.scaduto ?? 0)}</td></tr>
                            <tr><th className="text-muted">Annullato</th><td className="text-end">{String(summaryStats.annullato ?? 0)}</td></tr>
                            <tr><th className="text-muted">Ultimo sblocco</th><td className="text-end">{String(summaryStats.lastUnlock || "—")}</td></tr>
                            <tr><th className="text-muted">Ultimo riscatto</th><td className="text-end">{String(summaryStats.lastRedeem || "—")}</td></tr>
                            <tr><th className="text-muted">Ultimo annullamento</th><td className="text-end">{String(summaryStats.lastCancel || "—")}</td></tr>
                            <tr><th className="text-muted">Ultima attività</th><td className="text-end">{String(summaryStats.lastActivity || "—")}</td></tr>
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setSummaryFor(null)}>
                  Chiudi
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
