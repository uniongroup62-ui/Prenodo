"use client";

import { useEffect, useState } from "react";

// Pagina "Log" (registro attività, feature approvata 2026-07-16, SOLO ADMIN).
// Due viste: Attività (activity_logs, retention 30 giorni) ed Eliminazioni
// clienti (client_deletion_logs, PERMANENTE — è dove vive la motivazione
// obbligatoria del delete). Filtri col pattern unificato (Modulo/Azione/
// Operatore/Cerca, Filtra pieno, Reset condizionale) + paginazione 25.

type ActivityRow = {
  id: number;
  createdAt: string;
  userLabel: string;
  locationId: number;
  module: string;
  action: string;
  label: string;
  details: string;
};

type DeletionRow = {
  id: number;
  deletedAt: string;
  deletedByLabel: string;
  clientNames: string;
  reason: string;
  deletedCount: number;
  stockRestoreMode: string;
  summary: string;
};

export type LogQuery = {
  view?: string;
  module?: string;
  action?: string;
  user?: string;
  q?: string;
  p?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// dd/mm/yyyy HH:MM da "YYYY-MM-DD HH:MM:SS".
function fmtDateTime(v: string): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : v || "—";
}

// Badge colorato per azione: rosso distruttive, giallo modifiche, verde
// creazioni, azzurro login, grigio il resto.
function actionBadge(action: string): { label: string; className: string } {
  const a = action.toLowerCase();
  if (["delete", "elimina", "cancel", "annulla", "block", "disattiva"].some((k) => a.includes(k))) return { label: action, className: "text-bg-danger" };
  if (["update", "modifica", "move", "sposta", "save", "scala"].some((k) => a.includes(k))) return { label: action, className: "text-bg-warning" };
  if (["create", "crea", "checkout", "unblock", "riattiva", "ripristina", "paga", "incasso"].some((k) => a.includes(k))) return { label: action, className: "text-bg-success" };
  if (["login", "invia"].some((k) => a.includes(k))) return { label: action, className: "text-bg-info" };
  return { label: action, className: "text-bg-secondary" };
}

const MODULE_LABELS: Record<string, string> = {
  accessi: "Accessi",
  clienti: "Clienti",
  appuntamenti: "Appuntamenti",
  pagamenti: "Pagamenti",
  fornitori: "Fornitori",
  buoni: "Buoni",
  magazzino: "Magazzino",
  rate: "Gestione Rate",
  operatori: "Operatori",
  orari: "Orari",
  pacchetti: "Pacchetti",
  preventivi: "Preventivi",
};

function moduleLabel(m: string): string {
  return MODULE_LABELS[m] ?? (m.charAt(0).toUpperCase() + m.slice(1));
}

export function LogContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: LogQuery } = {}) {
  const slug = slugProp || tenantSlug();
  const [view, setView] = useState<"activity" | "deletions">(() => (initialQuery?.view === "deletions" ? "deletions" : "activity"));
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [deletions, setDeletions] = useState<DeletionRow[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(() => {
    const n = Number.parseInt(String(initialQuery?.p ?? ""), 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  });
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  // Viste consentite (permessi logs.view / logs.deletions; admin entrambe):
  // arrivano dalla risposta API e gatano i tab. Default entrambe finché non
  // si sa (i tab compaiono al primo fetch).
  const [views, setViews] = useState<{ activity: boolean; deletions: boolean }>({ activity: true, deletions: true });
  const [detailRow, setDetailRow] = useState<ActivityRow | DeletionRow | null>(null);

  // Bozza filtri (si applicano al submit) + filtri applicati.
  const [fModule, setFModule] = useState(() => String(initialQuery?.module ?? ""));
  const [fAction, setFAction] = useState(() => String(initialQuery?.action ?? ""));
  const [fUser, setFUser] = useState(() => String(initialQuery?.user ?? ""));
  const [fQ, setFQ] = useState(() => String(initialQuery?.q ?? ""));
  const [applied, setApplied] = useState(() => ({
    module: String(initialQuery?.module ?? ""),
    action: String(initialQuery?.action ?? ""),
    user: String(initialQuery?.user ?? ""),
    q: String(initialQuery?.q ?? ""),
  }));
  const filtersActive = applied.module !== "" || applied.action !== "" || applied.user !== "" || applied.q !== "";

  // Funzione dichiarata (hoisted), NON useCallback: il ramo 403-switch la
  // richiama ricorsivamente (profondità max 1: l'altra vista è permessa).
  function fetchData(v: "activity" | "deletions", f: { module: string; action: string; user: string; q: string }, pageN: number) {
      const params = new URLSearchParams({ slug, view: v, p: String(Math.max(1, pageN)) });
      if (v === "activity") {
        if (f.module) params.set("module", f.module);
        if (f.action) params.set("action", f.action);
        if (f.user) params.set("user", f.user);
        if (f.q) params.set("q", f.q);
      }
      fetch(`/api/manage/logs?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then(async (r) => ({ status: r.status, j: await r.json() }))
        .then(({ status, j }) => {
          if (j?.views) setViews({ activity: Boolean(j.views.activity), deletions: Boolean(j.views.deletions) });
          if (status === 403) {
            // Vista richiesta non permessa ma l'altra sì -> switch automatico
            // (es. operatore con SOLO logs.deletions che apre /log).
            const other = v === "activity" ? "deletions" : "activity";
            if (j?.views && j.views[other]) {
              setView(other);
              fetchData(other, f, 1);
              return;
            }
            setAccessDenied(true);
            return;
          }
          if (v === "deletions") {
            setDeletions(Array.isArray(j.rows) ? j.rows : []);
          } else {
            setRows(Array.isArray(j.rows) ? j.rows : []);
            setModules(Array.isArray(j.modules) ? j.modules : []);
            setActions(Array.isArray(j.actions) ? j.actions : []);
            setUsers(Array.isArray(j.users) ? j.users : []);
          }
          setTotalCount(Number(j.totalCount ?? 0));
          setPageSize(Math.max(1, Number(j.pageSize ?? 25)));
        })
        .catch(() => {
          setRows([]);
          setDeletions([]);
        })
        .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchData(view, applied, page);
    // Mount only: i refetch passano da submit/tab/pager.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function syncUrl(v: string, f: { module: string; action: string; user: string; q: string }, pageN: number) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    for (const k of ["view", "module", "action", "user", "q", "p"]) url.searchParams.delete(k);
    if (v !== "activity") url.searchParams.set("view", v);
    if (f.module) url.searchParams.set("module", f.module);
    if (f.action) url.searchParams.set("action", f.action);
    if (f.user) url.searchParams.set("user", f.user);
    if (f.q) url.searchParams.set("q", f.q);
    if (pageN > 1) url.searchParams.set("p", String(pageN));
    window.history.replaceState(null, "", url.toString());
  }

  function switchView(v: "activity" | "deletions") {
    setView(v);
    setPage(1);
    setLoading(true);
    syncUrl(v, applied, 1);
    fetchData(v, applied, 1);
  }

  function goToPage(pageN: number) {
    const p = Math.max(1, Math.floor(pageN));
    setPage(p);
    setLoading(true);
    syncUrl(view, applied, p);
    if (typeof window !== "undefined") window.scrollTo(0, 0);
    fetchData(view, applied, p);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Questa sezione è riservata agli amministratori.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Sistema</div>
          <h1 className="bs-page-title">Log</h1>
          <div className="bs-page-subtitle">Registro delle attività degli operatori. Le voci più vecchie di 30 giorni vengono eliminate automaticamente.</div>
        </div>
      </div>

      <ul className="nav nav-tabs mb-3">
        {views.activity ? (
          <li className="nav-item">
            <button type="button" className={`nav-link ${view === "activity" ? "active" : ""}`} onClick={() => view !== "activity" && switchView("activity")}>
              Attività (30 giorni)
            </button>
          </li>
        ) : null}
        {views.deletions ? (
          <li className="nav-item">
            <button type="button" className={`nav-link ${view === "deletions" ? "active" : ""}`} onClick={() => view !== "deletions" && switchView("deletions")}>
              Eliminazioni clienti (permanente)
            </button>
          </li>
        ) : null}
      </ul>

      {view === "activity" ? (
        <div className="card p-3 mb-3">
          <form
            className="row g-2 align-items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = { module: fModule, action: fAction, user: fUser, q: fQ.trim() };
              setApplied(f);
              setPage(1);
              setLoading(true);
              syncUrl(view, f, 1);
              fetchData(view, f, 1);
            }}
          >
            <div className="col-6 col-lg-2">
              <label className="form-label">Modulo</label>
              <select className="form-select" value={fModule} onChange={(e) => setFModule(e.target.value)}>
                <option value="">Tutti</option>
                {modules.map((m) => (
                  <option key={m} value={m}>{moduleLabel(m)}</option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label">Azione</label>
              <select className="form-select" value={fAction} onChange={(e) => setFAction(e.target.value)}>
                <option value="">Tutte</option>
                {actions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-2">
              <label className="form-label">Operatore</label>
              <select className="form-select" value={fUser} onChange={(e) => setFUser(e.target.value)}>
                <option value="">Tutti</option>
                {users.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="col-6 col-lg-3">
              <label className="form-label">Cerca</label>
              <input className="form-control" placeholder="Testo della voce…" value={fQ} onChange={(e) => setFQ(e.target.value)} />
            </div>
            <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail gap-2 ms-lg-2">
              <button className="btn btn-primary" type="submit">
                <i className="bi bi-search me-1" />
                Filtra
              </button>
              {filtersActive ? (
                <a className="btn btn-link text-secondary text-decoration-none px-2" href={`/${encodeURIComponent(slug)}/log`}>
                  Reset
                </a>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header bg-transparent d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
          <span className="text-muted small">
            {loading ? "Caricamento…" : totalCount === 1 ? "1 voce" : `${totalCount} voci`}
            {!loading && totalCount > pageSize ? ` · pagina ${page} di ${totalPages}` : ""}
            {!loading && view === "activity" && filtersActive ? " · filtri attivi" : ""}
          </span>
          {!loading && totalCount > pageSize ? (
            <div className="d-flex align-items-center gap-1">
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                <i className="bi bi-chevron-left" />
              </button>
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                <i className="bi bi-chevron-right" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="table-responsive">
          {view === "activity" ? (
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Data/ora</th>
                  <th>Operatore</th>
                  <th>Modulo</th>
                  <th>Azione</th>
                  <th>Descrizione</th>
                  <th className="text-end">Dettagli</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted p-3">
                      {loading ? "Caricamento…" : "Nessuna voce di log."}
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const badge = actionBadge(r.action);
                    return (
                      <tr key={r.id}>
                        <td className="text-nowrap">{fmtDateTime(r.createdAt)}</td>
                        <td className="fw-semibold">{r.userLabel}</td>
                        <td>{moduleLabel(r.module)}</td>
                        <td>
                          <span className={`badge ${badge.className}`}>{badge.label}</span>
                        </td>
                        <td>{r.label}</td>
                        <td className="text-end">
                          {r.details !== "" ? (
                            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDetailRow(r)}>
                              Apri
                            </button>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          ) : (
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Data/ora</th>
                  <th>Eliminato da</th>
                  <th>Cliente</th>
                  <th>Motivazione</th>
                  <th className="text-end">Record rimossi</th>
                  <th className="text-end">Dettagli</th>
                </tr>
              </thead>
              <tbody>
                {deletions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-muted p-3">
                      {loading ? "Caricamento…" : "Nessuna eliminazione registrata."}
                    </td>
                  </tr>
                ) : (
                  deletions.map((r) => (
                    <tr key={r.id}>
                      <td className="text-nowrap">{fmtDateTime(r.deletedAt)}</td>
                      <td className="fw-semibold">{r.deletedByLabel}</td>
                      <td>{r.clientNames || "—"}</td>
                      <td className="log-reason">{r.reason || "—"}</td>
                      <td className="text-end">{r.deletedCount}</td>
                      <td className="text-end">
                        {r.summary !== "" ? (
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDetailRow(r)}>
                            Apri
                          </button>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detailRow ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Dettagli voce di log</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDetailRow(null)} />
                </div>
                <div className="modal-body">
                  <pre className="small mb-0" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {(() => {
                      const raw = "details" in detailRow ? detailRow.details : detailRow.summary;
                      try {
                        return JSON.stringify(JSON.parse(raw), null, 2);
                      } catch {
                        return raw;
                      }
                    })()}
                  </pre>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setDetailRow(null)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setDetailRow(null)} />
        </>
      ) : null}
    </div>
  );
}
