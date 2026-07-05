"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP fidelity/gifts page (app/pages/gifts.php): the
// ASSIGNED INSTANCES list (default view, ~1465-1610), the CAMPAIGNS view
// (action=campaigns, ~1612-1746) with the per-campaign "Riepilogo" modal
// (~1822-2026: configurazione, statistiche, regola di sblocco, condizioni
// gift, clienti esclusi) and the manual assignment modal (~2030-2097).
// Fed by /api/manage/gifts:
//   - GET  action=page       -> GiftListPageRow[] (badge stato, riepilogo, esclusioni)
//   - GET  action=campaigns  -> lista leggera (filtri istanze + assegnazione)
//   - GET  action=instances  (inst_client_id/inst_gift_id/inst_state/inst_p, 25/pagina)
//   - POST action=toggle_active / delete / gift_terms_update /
//          gift_exclusion_add / gift_exclusion_remove / assign_manual
// I flash sono redirect legacy (?msg= / ?err= [+open_summary / inst_client_id]):
// msg che inizia con 'errore:' viene mostrato come alert danger (gifts.php 684).

type GiftsQuery = {
  action?: string;
  msg?: string;
  err?: string;
  open_summary?: string;
  inst_client_id?: string;
  inst_gift_id?: string;
  inst_state?: string;
  inst_p?: string;
};

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

type GiftPageRow = Campaign & {
  usoLabel: string;
  locationLabel: string;
  status: { code: string; label: string; badge: string; isCompleted: boolean };
  canDeactivate: boolean;
  canToggle: boolean;
  canEditStructure: boolean;
  activationBlockMsg: string;
  activationIssueItems: { type: string; name: string; label: string; context: string }[];
  levelsLabel: string;
  validityLabel: string;
  expiryLabel: string;
  createdLabel: string;
  updatedLabel: string;
  ruleSummary: string;
  termsEnabled: boolean;
  termsText: string;
  excludedCount: number;
  excludedClients: { id: number; name: string; meta: string }[];
  exclusionCandidates: { id: number; name: string }[];
  stats: { clientsTotal: number; instancesTotal: number; accumulo: number; disponibile: number; riscattato: number; scaduto: number; annullato: number; lastUnlock: string; lastRedeem: string; lastCancel: string; lastActivity: string };
};

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
};

type InstancesPage = { rows: InstanceRow[]; page: number; perPage: number; totalPages: number; total: number };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Badge stato istanza legacy (gifts.php ~1560-1564).
function instStateBadge(state: string): string {
  if (state === "disponibile") return "text-bg-success";
  if (state === "riscattato") return "text-bg-dark";
  if (state === "scaduto") return "text-bg-warning";
  if (state === "annullato") return "text-bg-danger";
  return "text-bg-secondary";
}

// gifts_page_fmt_datetime: d/m/Y H:i, '—' su vuoto.
function fmtDtHm(iso: string): string {
  if (!iso || iso.length < 10) return "—";
  const hm = iso.length >= 16 ? iso.slice(11, 16) : "00:00";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${hm}`;
}

export function GiftsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  // Vista legacy: default = lista istanze (Omaggi assegnati); ?action=campaigns.
  const view: "list" | "campaigns" = initialQuery?.action === "campaigns" ? "campaigns" : "list";

  // Flash legacy dal redirect: msg che inizia con 'errore:' -> danger.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const flashMsgIsError = (flash.msg ?? "").toLowerCase().startsWith("errore:");

  const [rows, setRows] = useState<GiftPageRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Modal Riepilogo (id campagna) — auto-open via ?open_summary.
  const [summaryId, setSummaryId] = useState(0);
  // Form condizioni + select esclusione nel Riepilogo (stato per campagna aperta).
  const [termsEnabled, setTermsEnabled] = useState(true);
  const [termsText, setTermsText] = useState("");
  const [excludeCandidate, setExcludeCandidate] = useState("");

  // Istanze assegnate: filtri e pagina arrivano dal querystring come nel legacy
  // (form GET + link di paginazione).
  const instClientId = Number.parseInt(initialQuery?.inst_client_id ?? "0", 10) || 0;
  const instGiftId = Number.parseInt(initialQuery?.inst_gift_id ?? "0", 10) || 0;
  const instState = initialQuery?.inst_state ?? "";
  const instPage = Math.max(1, Number.parseInt(initialQuery?.inst_p ?? "1", 10) || 1);
  const [filterClientId, setFilterClientId] = useState(String(instClientId || ""));
  const [filterGiftId, setFilterGiftId] = useState(String(instGiftId || ""));
  const [filterState, setFilterState] = useState(instState);
  const [instances, setInstances] = useState<InstancesPage | null>(null);
  const [clients, setClients] = useState<Array<{ id: number; name: string }>>([]);

  // Assegnazione manuale.
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignGiftId, setAssignGiftId] = useState("");
  const [assignClient, setAssignClient] = useState("");
  const [assignDays, setAssignDays] = useState("");

  function openSummary(row: GiftPageRow) {
    setSummaryId(row.id);
    setTermsEnabled(row.termsEnabled);
    setTermsText(row.termsText);
    setExcludeCandidate("");
  }

  // Payload completo campagne (solo vista campaigns).
  useEffect(() => {
    if (view !== "campaigns") return;
    fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}&action=page`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.rows) ? (j.rows as GiftPageRow[]) : [];
        setRows(list);
        const openId = Math.max(0, Number.parseInt(String(initialQuery?.open_summary ?? "0"), 10) || 0);
        const openRow = list.find((r) => r.id === openId);
        if (openRow) openSummary(openRow);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, view]);

  // Lista leggera campagne (filtro gift + select assegnazione + empty state).
  useEffect(() => {
    fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}&action=campaigns`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setCampaigns(Array.isArray(j.campaigns) ? (j.campaigns as Campaign[]) : []))
      .catch(() => setCampaigns([]))
      .finally(() => { if (view === "list") setLoading(false); });
  }, [slug, view]);

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

  // Clienti per filtro + combobox assegnazione (vista lista).
  useEffect(() => {
    if (view !== "list") return;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.clients) ? j.clients : [];
        setClients(list.map((c: { id: number; full_name?: string; name?: string }) => ({ id: Number(c.id), name: String(c.full_name ?? c.name ?? `#${c.id}`) })));
      })
      .catch(() => setClients([]));
  }, [slug, view]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`gifts${suffix}`.replace("&", "?")}`;
  }

  // Redirect flash legacy (?msg= / ?err= [+open_summary / inst_client_id]).
  function redirectFlash(params: Record<string, string | number>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (String(v) !== "") usp.set(k, String(v));
    window.location.assign(`/${encodeURIComponent(slug)}/gifts${usp.size > 0 ? `?${usp.toString()}` : ""}`);
  }

  async function post(fields: Record<string, string>): Promise<{ ok: boolean; msg: string; error: string; openSummary: number }> {
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const ok = res.ok && j.ok !== false;
      return {
        ok,
        msg: String(j.msg ?? ""),
        error: ok ? "" : String(j.error ?? "Operazione non riuscita."),
        openSummary: Math.max(0, Number.parseInt(String(j.open_summary ?? "0"), 10) || 0),
      };
    } catch {
      return { ok: false, msg: "", error: "Operazione non riuscita.", openSummary: 0 };
    } finally {
      setBusy(false);
    }
  }

  // Toggle campagna (gifts.php action=toggle_active): flash legacy via redirect;
  // gli errori con guardia riaprono il riepilogo (open_summary).
  async function doToggle(row: GiftPageRow, active: boolean) {
    const r = await post({ action: "toggle_active", id: String(row.id), active: active ? "1" : "0" });
    if (r.ok) redirectFlash({ action: "campaigns", msg: r.msg });
    else if (r.openSummary > 0) redirectFlash({ action: "campaigns", open_summary: r.openSummary, err: r.error });
    else redirectFlash({ action: "campaigns", err: r.error });
  }

  async function doDelete(row: GiftPageRow) {
    if (!window.confirm("Eliminare questa campagna e tutti i movimenti associati?")) return;
    const r = await post({ action: "delete", id: String(row.id) });
    if (r.ok) redirectFlash({ action: "campaigns", msg: "Campagna eliminata" });
    else redirectFlash({ action: "campaigns", err: "Errore eliminazione campagna" });
  }

  // Condizioni gift dal riepilogo (_mode=gift_terms_update).
  async function saveTerms(row: GiftPageRow) {
    const r = await post({ action: "gift_terms_update", gift_id: String(row.id), terms_enabled: termsEnabled ? "1" : "", terms_text: termsText });
    if (r.ok) redirectFlash({ action: "campaigns", open_summary: row.id, msg: r.msg });
    else redirectFlash({ action: "campaigns", open_summary: row.id, err: r.error });
  }

  async function addExclusion(row: GiftPageRow) {
    const cid = Number.parseInt(excludeCandidate, 10) || 0;
    const r = await post({ action: "gift_exclusion_add", gift_id: String(row.id), client_id: String(cid) });
    if (r.ok) redirectFlash({ action: "campaigns", open_summary: row.id, msg: r.msg });
    else redirectFlash({ action: "campaigns", open_summary: row.id, err: r.error });
  }

  async function removeExclusion(row: GiftPageRow, clientId: number) {
    const r = await post({ action: "gift_exclusion_remove", gift_id: String(row.id), client_id: String(clientId) });
    if (r.ok) redirectFlash({ action: "campaigns", open_summary: row.id, msg: r.msg });
    else redirectFlash({ action: "campaigns", open_summary: row.id, err: r.error });
  }

  // Assegnazione manuale (gifts.php _mode=assign_manual): il legacy redirige a
  // ?inst_client_id=X con msg (res.msg o 'gift assegnato') / err. Se il cliente
  // non è idoneo il server risponde ineligible+canForce e la UI chiede conferma.
  async function submitAssign(e: React.FormEvent) {
    e.preventDefault();
    const giftId = Number.parseInt(assignGiftId, 10) || 0;
    const m = /#(\d+)\s*$/.exec(assignClient);
    const clientId = m ? Number.parseInt(m[1], 10) : Number.parseInt(assignClient, 10) || 0;
    if (giftId <= 0 || clientId <= 0) return;
    const fields: Record<string, string> = { action: "assign_manual", gift_id: String(giftId), client_id: String(clientId) };
    if (assignDays.trim() !== "") fields.expires_days = assignDays.trim();
    setBusy(true);
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
      if (r.status >= 400 || r.json.ok === false) {
        redirectFlash({ inst_client_id: clientId, err: String(r.json.error ?? "Errore assegnazione gift") });
        return;
      }
      redirectFlash({ inst_client_id: clientId, msg: String(r.json.msg ?? r.json.message ?? "gift assegnato") });
    } finally {
      setBusy(false);
    }
  }

  const [openMenuId, setOpenMenuId] = useState(0);
  const summaryRow = rows.find((r) => r.id === summaryId) ?? null;

  // Empty state legacy: nessuna campagna E nessuna istanza mai generata.
  const hasAnyCampaign = view === "campaigns" ? rows.length > 0 : campaigns.length > 0;
  const emptyState = !loading && !hasAnyCampaign && (instances?.total ?? 0) === 0;

  const hasFilters = instClientId > 0 || instGiftId > 0 || instState !== "";

  function submitFilters(e: React.FormEvent) {
    e.preventDefault();
    const params: Record<string, string | number> = {};
    if (filterClientId !== "" && filterClientId !== "0") params.inst_client_id = filterClientId;
    if (filterGiftId !== "" && filterGiftId !== "0") params.inst_gift_id = filterGiftId;
    if (filterState !== "") params.inst_state = filterState;
    redirectFlash(params);
  }

  function instPageUrl(p: number): string {
    const usp = new URLSearchParams();
    if (instClientId > 0) usp.set("inst_client_id", String(instClientId));
    if (instGiftId > 0) usp.set("inst_gift_id", String(instGiftId));
    if (instState !== "") usp.set("inst_state", instState);
    usp.set("inst_p", String(p));
    return `/${encodeURIComponent(slug)}/gifts?${usp.toString()}`;
  }

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
            ) : !emptyState ? (
              <>
                <button className="btn btn-outline-success" type="button" disabled={campaigns.length === 0} onClick={() => setAssignOpen(true)}>
                  <i className="bi bi-person-plus me-1" />
                  Assegna gift
                </button>
                <a className="btn btn-outline-primary" href={href("&action=campaigns")}>
                  Campagne gift
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {flash.msg ? (
        <div className={`alert ${flashMsgIsError ? "alert-danger" : "alert-success"} d-flex align-items-start gap-2`} role="alert">
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
        <div className="card h-100">
          <div className="card-header d-flex justify-content-between align-items-center">
            <div className="fw-semibold">Campagne gift</div>
            <div className="text-muted small">{rows.length} campagne</div>
          </div>
          <div className="table-responsive gifts-campaigns-table-wrap">
            <table className="table mb-0 align-middle">
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
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="fw-semibold">{c.name}</td>
                    <td className="text-muted">{c.usoLabel}</td>
                    <td className="text-muted small">{c.locationLabel}</td>
                    <td className="text-muted">{c.rewardSummary || "—"}</td>
                    <td className="text-center">
                      <span className={`badge text-bg-${c.status.badge}`}>{c.status.label}</span>
                    </td>
                    <td className="text-end">
                      <div className={`dropdown dropstart gifts-campaign-actions ${openMenuId === c.id ? "show" : ""}`}>
                        <button
                          className="btn btn-sm btn-outline-secondary gifts-campaign-actions__trigger"
                          type="button"
                          aria-expanded={openMenuId === c.id}
                          aria-label={`Azioni campagna ${c.name}`}
                          onClick={() => setOpenMenuId(openMenuId === c.id ? 0 : c.id)}
                        >
                          <i className="bi bi-three-dots-vertical" aria-hidden="true" />
                        </button>
                        <ul className={`dropdown-menu dropdown-menu-end shadow-sm ${openMenuId === c.id ? "show" : ""}`}>
                          <li>
                            <button className="dropdown-item" type="button" onClick={() => { setOpenMenuId(0); openSummary(c); }}>
                              <i className="bi bi-card-list me-2" />
                              Riepilogo
                            </button>
                          </li>
                          {c.canEditStructure ? (
                            <li>
                              <a className="dropdown-item" href={href(`&action=edit&id=${c.id}`)}>
                                <i className="bi bi-pencil me-2" />
                                Modifica
                              </a>
                            </li>
                          ) : null}
                          <li>
                            <a className="dropdown-item" href={href(`&action=clone&id=${c.id}`)}>
                              <i className="bi bi-files me-2" />
                              Clona campagna
                            </a>
                          </li>
                          {c.canToggle ? (
                            <>
                              <li><hr className="dropdown-divider" /></li>
                              {c.canDeactivate ? (
                                <li>
                                  <button className="dropdown-item" type="button" disabled={busy} onClick={() => { setOpenMenuId(0); void doToggle(c, false); }}>
                                    <i className="bi bi-pause-circle me-2" />
                                    Disattiva
                                  </button>
                                </li>
                              ) : c.activationBlockMsg !== "" ? (
                                <li>
                                  <button className="dropdown-item" type="button" onClick={() => { setOpenMenuId(0); window.alert(c.activationBlockMsg); }}>
                                    <i className="bi bi-play-circle me-2" />
                                    Attiva
                                  </button>
                                </li>
                              ) : (
                                <li>
                                  <button className="dropdown-item" type="button" disabled={busy} onClick={() => { setOpenMenuId(0); void doToggle(c, true); }}>
                                    <i className="bi bi-play-circle me-2" />
                                    Attiva
                                  </button>
                                </li>
                              )}
                            </>
                          ) : null}
                          <li><hr className="dropdown-divider" /></li>
                          <li>
                            <button className="dropdown-item text-danger" type="button" disabled={busy} onClick={() => { setOpenMenuId(0); void doDelete(c); }}>
                              <i className="bi bi-trash me-2" />
                              Elimina
                            </button>
                          </li>
                        </ul>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 ? (
                  <tr><td colSpan={6} className="text-muted p-3">Nessun omaggio configurato.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ===== VISTA LISTA ISTANZE (gifts.php default: "Omaggi assegnati ai clienti") ===== */
        <div className="card h-100">
          <div className="card-header d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-2">
            <div>
              <div className="fw-semibold">Omaggi assegnati ai clienti</div>
              <div className="text-muted small">Lista di tutte le istanze generate (accumulo / disponibile / riscattato / scaduto / annullato).</div>
            </div>
            <div className="text-muted small">25 risultati per pagina</div>
          </div>

          <div className="p-3 border-bottom">
            <form className="row g-2 align-items-end" onSubmit={submitFilters}>
              <div className="col-lg-3">
                <label className="form-label">Cliente</label>
                <select className="form-select" value={filterClientId} onChange={(e) => setFilterClientId(e.target.value)}>
                  <option value="">Tutti</option>
                  {clients.map((c) => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-lg-3">
                <label className="form-label">gift</label>
                <select className="form-select" value={filterGiftId} onChange={(e) => setFilterGiftId(e.target.value)}>
                  <option value="">Tutti</option>
                  {campaigns.map((c) => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-lg-2">
                <label className="form-label">Stato</label>
                <select className="form-select" value={filterState} onChange={(e) => setFilterState(e.target.value)}>
                  <option value="">Tutti</option>
                  <option value="accumulo">Accumulo</option>
                  <option value="disponibile">Disponibile</option>
                  <option value="riscattato">Riscattato</option>
                  <option value="scaduto">Scaduto</option>
                  <option value="annullato">Annullato</option>
                </select>
              </div>
              <div className="col-lg-4 d-flex align-items-end gap-2 app-filter-actions">
                <button className="btn btn-outline-primary app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {hasFilters ? (
                  <a className="btn btn-outline-secondary app-filter-reset" href={href("")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="table-responsive">
            <table className="table mb-0 align-middle">
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
                {instances && instances.rows.length > 0 ? (
                  instances.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="text-muted small">{fmtDtHm(r.createdAt)}</td>
                      <td className="fw-semibold">{r.clientName}</td>
                      <td>{r.giftName}</td>
                      <td className="text-muted small">{r.locationName || "-"}</td>
                      <td className="text-center">
                        <span className={`badge ${instStateBadge(r.state)} text-uppercase`}>{r.state}</span>
                      </td>
                      <td className="text-muted small">{r.expiresAt ? fmtDtHm(r.expiresAt) : "—"}</td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" title="Apri dettagli" href={`/${encodeURIComponent(slug)}/gift_instance?id=${r.id}`}>
                          <i className="bi bi-eye" />
                        </a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} className="text-muted p-3">Nessun omaggio assegnato trovato.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {instances && instances.totalPages > 1 ? (
            <div className="d-flex justify-content-between align-items-center p-3">
              <div className="text-muted small">Pagina {instances.page} di {instances.totalPages} • Totale: {instances.total}</div>
              <div className="d-flex gap-2">
                <a className={`btn btn-sm btn-outline-secondary ${instances.page <= 1 ? "disabled" : ""}`} href={instPageUrl(Math.max(1, instances.page - 1))}>
                  « Prev
                </a>
                <a className={`btn btn-sm btn-outline-secondary ${instances.page >= instances.totalPages ? "disabled" : ""}`} href={instPageUrl(Math.min(instances.totalPages, instances.page + 1))}>
                  Next »
                </a>
              </div>
            </div>
          ) : instances ? (
            <div className="p-3 text-muted small">Totale: {instances.total}</div>
          ) : null}
        </div>
      )}

      {/* MODALE "Assegna gift manualmente" (#assignGiftModal). */}
      {assignOpen ? (
        <>
          <div className="modal fade show d-block" id="assignGiftModal" tabIndex={-1}>
            <div className="modal-dialog modal-lg modal-dialog-centered">
              <form className="modal-content" onSubmit={submitAssign}>
                <div className="modal-header">
                  <h5 className="modal-title">Assegna gift manualmente</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setAssignOpen(false)} />
                </div>
                <div className="modal-body">
                  <div className="text-muted small mb-3">
                    Crea un&apos;istanza in stato <strong>Disponibile</strong> per il cliente, anche se non ha ancora completato le regole. Se il cliente non è idoneo all&apos;omaggio, prima del salvataggio verrà chiesto se vuoi assegnarlo comunque.
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
                      <select className="form-select" value={assignGiftId} required onChange={(e) => setAssignGiftId(e.target.value)}>
                        <option value="">— seleziona —</option>
                        {campaigns.filter((c) => c.isCurrentlyActive).map((c) => (
                          <option value={c.id} key={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <div className="form-text">Sono visibili solo gli omaggi <strong>attivi</strong>, nel periodo di validità e validi per la sede corrente.</div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Scadenza (giorni) (opzionale)</label>
                      <input className="form-control" type="number" min={1} max={36500} step={1} placeholder="—" value={assignDays} onChange={(e) => setAssignDays(e.target.value)} />
                      <div className="form-text">Se vuoto, usa la scadenza configurata sull&apos;omaggio.</div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setAssignOpen(false)}>
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
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {/* MODALE "Riepilogo" campagna (#giftSummaryModal<id>). */}
      {summaryRow ? (
        <>
          <div className="modal fade show d-block" id={`giftSummaryModal${summaryRow.id}`} tabIndex={-1}>
            <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-0">{summaryRow.name}</h5>
                    <div className="text-muted small">Riepilogo campagna omaggio</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setSummaryId(0)} />
                </div>
                <div className="modal-body">
                  <div className="row g-3">
                    {["inactive", "completed"].includes(summaryRow.status.code) && summaryRow.activationBlockMsg !== "" ? (
                      <div className="col-12">
                        <div className="alert alert-danger mb-0">
                          <div className="fw-semibold mb-1">
                            <i className="bi bi-exclamation-triangle me-1" />
                            Campagna omaggio non riattivabile
                          </div>
                          <div className="small">{summaryRow.activationBlockMsg}</div>
                          {summaryRow.activationIssueItems.length > 0 ? (
                            <ul className="small mb-0 mt-2 ps-3">
                              {summaryRow.activationIssueItems.map((it, i) => (
                                <li key={i}>
                                  {it.type}: <strong>{it.name}</strong> — {it.label || "non disponibile"}
                                  {it.context.trim() !== "" ? <span className="text-muted"> ({it.context})</span> : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    <div className="col-12 col-lg-6">
                      <div className="border rounded-3 p-3 h-100">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Configurazione</div>
                        <dl className="row mb-0 small">
                          <dt className="col-sm-4 text-muted">Stato</dt>
                          <dd className="col-sm-8"><span className={`badge text-bg-${summaryRow.status.badge}`}>{summaryRow.status.label}</span></dd>
                          <dt className="col-sm-4 text-muted">Validità</dt>
                          <dd className="col-sm-8">{summaryRow.validityLabel}</dd>
                          <dt className="col-sm-4 text-muted">Uso</dt>
                          <dd className="col-sm-8">{summaryRow.usoLabel}</dd>
                          <dt className="col-sm-4 text-muted">Sedi abilitate</dt>
                          <dd className="col-sm-8">{summaryRow.locationLabel}</dd>
                          <dt className="col-sm-4 text-muted">Livelli Fidelity</dt>
                          <dd className="col-sm-8">{summaryRow.levelsLabel}</dd>
                          <dt className="col-sm-4 text-muted">Premio</dt>
                          <dd className="col-sm-8">{summaryRow.rewardSummary || "—"}</dd>
                          <dt className="col-sm-4 text-muted">Clienti esclusi</dt>
                          <dd className="col-sm-8">{summaryRow.excludedCount}{summaryRow.excludedCount === 1 ? " cliente" : " clienti"}</dd>
                          <dt className="col-sm-4 text-muted">Scadenza gift</dt>
                          <dd className="col-sm-8">{summaryRow.expiryLabel}</dd>
                          <dt className="col-sm-4 text-muted">Creata il</dt>
                          <dd className="col-sm-8">{summaryRow.createdLabel}</dd>
                          <dt className="col-sm-4 text-muted">Ultimo aggiornamento</dt>
                          <dd className="col-sm-8">{summaryRow.updatedLabel}</dd>
                          {summaryRow.description.trim() !== "" ? (
                            <>
                              <dt className="col-sm-4 text-muted">Descrizione</dt>
                              <dd className="col-sm-8">{summaryRow.description}</dd>
                            </>
                          ) : null}
                        </dl>
                      </div>
                    </div>

                    <div className="col-12 col-lg-6">
                      <div className="border rounded-3 p-3 h-100">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Statistiche</div>
                        <div className="table-responsive">
                          <table className="table table-sm align-middle mb-0">
                            <tbody>
                              <tr><th className="text-muted fw-normal">Clienti coinvolti</th><td className="text-end fw-semibold">{summaryRow.stats.clientsTotal}</td></tr>
                              <tr><th className="text-muted fw-normal">Istanze totali</th><td className="text-end fw-semibold">{summaryRow.stats.instancesTotal}</td></tr>
                              <tr><th className="text-muted fw-normal">Accumulo</th><td className="text-end">{summaryRow.stats.accumulo}</td></tr>
                              <tr><th className="text-muted fw-normal">Disponibile</th><td className="text-end">{summaryRow.stats.disponibile}</td></tr>
                              <tr><th className="text-muted fw-normal">Riscattato</th><td className="text-end">{summaryRow.stats.riscattato}</td></tr>
                              <tr><th className="text-muted fw-normal">Scaduto</th><td className="text-end">{summaryRow.stats.scaduto}</td></tr>
                              <tr><th className="text-muted fw-normal">Annullato</th><td className="text-end">{summaryRow.stats.annullato}</td></tr>
                              <tr><th className="text-muted fw-normal">Ultimo sblocco</th><td className="text-end">{summaryRow.stats.lastUnlock}</td></tr>
                              <tr><th className="text-muted fw-normal">Ultimo riscatto</th><td className="text-end">{summaryRow.stats.lastRedeem}</td></tr>
                              <tr><th className="text-muted fw-normal">Ultimo annullamento</th><td className="text-end">{summaryRow.stats.lastCancel}</td></tr>
                              <tr><th className="text-muted fw-normal">Ultima attività</th><td className="text-end">{summaryRow.stats.lastActivity}</td></tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Regola di sblocco</div>
                        <div className="fw-semibold">{summaryRow.ruleSummary}</div>
                        <div className="text-muted small mt-2">L&apos;omaggio diventa disponibile quando il cliente soddisfa questa regola nel periodo di validità della campagna.</div>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="d-flex flex-column flex-lg-row justify-content-between align-items-lg-start gap-2 mb-3">
                          <div>
                            <div className="text-muted text-uppercase small fw-semibold mb-1">Condizioni gift</div>
                            <div className="text-muted small">Puoi aggiornare il testo mostrato nel Voucher omaggio e nella mail inviata al cliente. Se disattivi il flag, le condizioni non vengono mostrate.</div>
                          </div>
                        </div>
                        <form className="row g-2" onSubmit={(e) => { e.preventDefault(); void saveTerms(summaryRow); }}>
                          <div className="col-12">
                            <div className="form-check form-switch">
                              <input className="form-check-input" type="checkbox" id={`gift_terms_enabled_summary_${summaryRow.id}`} checked={termsEnabled} onChange={(e) => setTermsEnabled(e.target.checked)} />
                              <label className="form-check-label" htmlFor={`gift_terms_enabled_summary_${summaryRow.id}`}>Condizioni attive</label>
                            </div>
                          </div>
                          <div className="col-12">
                            <textarea className="form-control" rows={3} placeholder="Inserisci le condizioni dell'omaggio" value={termsText} onChange={(e) => setTermsText(e.target.value)} />
                          </div>
                          <div className="col-12">
                            <button className="btn btn-outline-primary" type="submit" disabled={busy}>Salva condizioni</button>
                          </div>
                        </form>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="d-flex flex-column flex-lg-row justify-content-between align-items-lg-start gap-2 mb-3">
                          <div>
                            <div className="text-muted text-uppercase small fw-semibold mb-1">Clienti esclusi</div>
                            <div className="text-muted small">Puoi aggiungere o rimuovere clienti dall&apos;esclusione rispettando le impostazioni attuali della campagna. I clienti con accumulo, omaggio disponibile o riscattato non compaiono nella lista di aggiunta.</div>
                          </div>
                          <div className="text-muted small">{summaryRow.excludedCount} esclus{summaryRow.excludedCount === 1 ? "o" : "i"}</div>
                        </div>

                        <div className="row g-3">
                          <div className="col-12 col-lg-5">
                            <form className="row g-2 align-items-end" onSubmit={(e) => { e.preventDefault(); void addExclusion(summaryRow); }}>
                              <div className="col-12">
                                <label className="form-label">Aggiungi cliente all&apos;esclusione</label>
                                <select className="form-select" value={excludeCandidate} disabled={summaryRow.exclusionCandidates.length === 0} onChange={(e) => setExcludeCandidate(e.target.value)}>
                                  <option value="">— seleziona cliente —</option>
                                  {summaryRow.exclusionCandidates.map((cand) => (
                                    <option value={cand.id} key={cand.id}>{cand.name}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="col-12">
                                <button className="btn btn-outline-primary" type="submit" disabled={busy || summaryRow.exclusionCandidates.length === 0}>Aggiungi all&apos;esclusione</button>
                              </div>
                              <div className="col-12">
                                <div className="form-text">La lista rispetta uso e livelli della campagna. Se un cliente viene annullato o viene eliminato un accumulo, tornerà selezionabile qui.</div>
                              </div>
                            </form>
                          </div>

                          <div className="col-12 col-lg-7">
                            <div className="small text-muted fw-semibold mb-2">Clienti attualmente esclusi</div>
                            {summaryRow.excludedClients.length > 0 ? (
                              <div className="d-flex flex-column gap-2">
                                {summaryRow.excludedClients.map((ec) => (
                                  <div className="border rounded-3 px-3 py-2 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-2" key={ec.id}>
                                    <div>
                                      <div className="fw-semibold">{ec.name}</div>
                                      {ec.meta !== "" ? <div className="text-muted small">{ec.meta}</div> : null}
                                    </div>
                                    <button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => void removeExclusion(summaryRow, ec.id)}>Rimuovi</button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-muted small">Nessun cliente escluso per questa campagna.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setSummaryId(0)}>Chiudi</button>
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
