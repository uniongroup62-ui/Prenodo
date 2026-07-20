"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP promotions LIST (app/pages/promotions.php action=list
// + assets/js/pages/promotions.js): tabella legacy (Nome/Sconto/Validità/Target/
// Scope/Sedi/Stato/Azioni) con badge di stato (Attiva/Programmata/Disattivata/
// Sospesa/Completata), btn-group Riepilogo · Modifica|Clona campagna ·
// Disattiva/Attiva · Elimina, modal 'Conferma operazione' con l'accordion
// 'Prenotazioni interessate', modal Riepilogo per campagna (configurazione,
// statistiche, servizi/prodotti, validità dettagliata, limiti, condizioni
// booking, esclusioni clienti) con auto-open via ?open_summary, flash legacy
// via redirect ?msg/?err.

type PendingInfo = { count: number; items: { label: string; detail: string }[] };
type PromoRow = {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  targetType: string;
  discountLabel: string;
  validityLabel: string;
  targetLabel: string;
  scopeLabel: string;
  locationLabel: string;
  status: { code: string; label: string; badge: string; canToggle: boolean };
  canEdit: boolean;
  pending: PendingInfo;
  activationBlockMsg: string;
  activationIssueItems: { type: string; name: string; label: string }[];
  stats: { clientsTotal: number; redemptionsTotal: number; discountTotal: string; firstRedeemedAt: string; lastRedeemedAt: string };
  levelsLabel: string;
  discountSummary: string;
  svcModeLabel: string;
  prdModeLabel: string;
  svcMode: string;
  prdMode: string;
  svcLines: string[];
  prdLines: string[];
  svcAllLine: string;
  prdAllLine: string;
  timeWindowsLabel: string;
  blackoutsLabel: string;
  stackLabel: string;
  excludedCount: number;
  excludedClients: { id: number; name: string; meta: string }[];
  exclusionCandidates: { id: number; name: string }[];
  perCustomerLimitLabel: string;
  conditionsEnabled: boolean;
  conditionsText: string;
  createdLabel: string;
  updatedLabel: string;
};

type PromotionsQuery = { msg?: string; err?: string; open_summary?: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function PromotionsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: PromotionsQuery } = {}) {
  const slug = slugProp || tenantSlug();
  const [rows, setRows] = useState<PromoRow[]>([]);
  const [hasAny, setHasAny] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Modal Riepilogo aperto (id promo) — auto-open via ?open_summary.
  const [summaryId, setSummaryId] = useState(0);
  // Form condizioni/esclusioni nel Riepilogo (stato locale per promo aperta).
  const [condEnabled, setCondEnabled] = useState(false);
  const [condText, setCondText] = useState("");
  const [excludeCandidate, setExcludeCandidate] = useState("");

  // Modal 'Conferma operazione' (Disattiva / Elimina).
  const [confirm, setConfirm] = useState<{ kind: "deactivate" | "delete"; row: PromoRow } | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);

  const load = useCallback(() => {
    return fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}&action=page`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.rows) ? (j.rows as PromoRow[]) : [];
        setRows(list);
        setHasAny(Boolean(j.hasAny));
        const openId = Math.max(0, Number.parseInt(String(initialQuery?.open_summary ?? "0"), 10) || 0);
        if (openId > 0 && list.some((r) => r.id === openId)) openSummary(list.find((r) => r.id === openId)!);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`promotions${suffix}`.replace("&", "?")}`;
  }

  function redirectFlash(params: Record<string, string | number>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (String(v) !== "") usp.set(k, String(v));
    window.location.href = `/${encodeURIComponent(slug)}/promotions${usp.size > 0 ? `?${usp.toString()}` : ""}`;
  }

  function openSummary(row: PromoRow) {
    setSummaryId(row.id);
    setCondEnabled(row.conditionsEnabled);
    setCondText(row.conditionsText);
    setExcludeCandidate("");
  }

  async function post(fields: Record<string, string>): Promise<{ ok: boolean; message: string; error: string }> {
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || j.ok === false) return { ok: false, message: "", error: String(j.error || "Operazione non riuscita.") };
      return { ok: true, message: String(j.message ?? ""), error: "" };
    } catch {
      return { ok: false, message: "", error: "Errore di rete." };
    } finally {
      setBusy(false);
    }
  }

  // Toggle (link Attiva / conferma Disattiva): flash legacy via redirect.
  async function doToggle(row: PromoRow, active: boolean) {
    const r = await post({ action: "toggle", id: String(row.id), active: active ? "1" : "0" });
    if (r.ok) {
      redirectFlash({ msg: r.message });
      return;
    }
    // Il toggle legacy con blocco contenuti riapre il riepilogo (open_summary).
    if (active && r.error.startsWith("Non è possibile riattivare la promozione")) redirectFlash({ open_summary: row.id, err: r.error });
    else redirectFlash({ err: r.error });
  }

  async function doDelete(row: PromoRow) {
    const r = await post({ action: "delete", id: String(row.id) });
    if (r.ok) redirectFlash({ msg: r.message });
    else redirectFlash({ err: r.error });
  }

  async function saveConditions(row: PromoRow) {
    const r = await post({ action: "conditions_update", promotion_id: String(row.id), promo_conditions_enabled: condEnabled ? "1" : "0", promo_conditions: condText });
    if (r.ok) redirectFlash({ open_summary: row.id, msg: r.message });
    else redirectFlash({ open_summary: row.id, err: r.error });
  }

  async function addExclusion(row: PromoRow) {
    const cid = Number.parseInt(excludeCandidate, 10) || 0;
    const r = await post({ action: "exclusion_add", promotion_id: String(row.id), client_id: String(cid) });
    if (r.ok) redirectFlash({ open_summary: row.id, msg: r.message });
    else redirectFlash({ open_summary: row.id, err: r.error });
  }

  async function removeExclusion(row: PromoRow, clientId: number) {
    const r = await post({ action: "exclusion_remove", promotion_id: String(row.id), client_id: String(clientId) });
    if (r.ok) redirectFlash({ open_summary: row.id, msg: r.message });
    else redirectFlash({ open_summary: row.id, err: r.error });
  }

  const showEmptyState = !loading && !hasAny;
  const summaryRow = rows.find((r) => r.id === summaryId) ?? null;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/promotions.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelizzazione</div>
          <h1 className="bs-page-title">Promozioni</h1>
          <div className="bs-page-subtitle">Gestisci promozioni, regole e visibilita per sedi e canali.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {!showEmptyState ? (
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova promozione
              </a>
            ) : null}
          </div>
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

      {showEmptyState ? (
        <div className="card border-0 shadow-sm promotions-empty-card">
          <div className="promotions-empty-state">
            <div className="promotions-empty-icon" aria-hidden="true">
              <i className="bi bi-megaphone" />
            </div>
            <h2>Nessuna promozione presente</h2>
            <p>
              Crea la prima promozione per applicare sconti automatici su servizi e prodotti, gestire target clienti,
              validita e sedi abilitate.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova promozione
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body">
            {loading ? (
              <div className="text-muted">Caricamento…</div>
            ) : rows.length === 0 ? (
              <div className="text-muted">Nessuna promozione trovata per la sede selezionata.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Sconto</th>
                      <th>Validità</th>
                      <th>Target</th>
                      <th>Scope</th>
                      <th>Sedi</th>
                      <th className="text-center">Stato</th>
                      <th className="text-end">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="fw-semibold">{row.title}</div>
                        </td>
                        <td>{row.discountLabel}</td>
                        <td className="text-muted small">{row.validityLabel}</td>
                        <td className="text-muted small">{row.targetLabel}</td>
                        <td className="text-muted small">{row.scopeLabel}</td>
                        <td className="text-muted small">{row.locationLabel}</td>
                        <td className="text-center">
                          <span className={`badge text-bg-${row.status.badge}`}>{row.status.label}</span>
                        </td>
                        <td className="text-end">
                          <div className="btn-group btn-group-sm" role="group">
                            <button className="btn btn-outline-primary" type="button" onClick={() => openSummary(row)}>
                              Riepilogo
                            </button>
                            {row.canEdit ? (
                              <a className="btn btn-outline-primary" href={href(`&action=edit&id=${row.id}`)}>
                                Modifica
                              </a>
                            ) : (
                              <a className="btn btn-outline-primary" href={href(`&action=duplicate&id=${row.id}`)}>
                                Clona campagna
                              </a>
                            )}
                            {row.status.canToggle ? (
                              row.isActive ? (
                                <button
                                  className="btn btn-outline-warning js-promo-action-confirm"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setPendingOpen(false);
                                    setConfirm({ kind: "deactivate", row });
                                  }}
                                >
                                  Disattiva
                                </button>
                              ) : row.activationBlockMsg !== "" ? (
                                <button className="btn btn-outline-secondary" type="button" onClick={() => window.alert(row.activationBlockMsg)}>
                                  Attiva
                                </button>
                              ) : (
                                <button className="btn btn-outline-success" type="button" disabled={busy} onClick={() => void doToggle(row, true)}>
                                  Attiva
                                </button>
                              )
                            ) : row.status.code === "suspended" ? (
                              <button type="button" className="btn btn-outline-secondary" disabled>
                                Riattiva con Fidelity
                              </button>
                            ) : (
                              <button type="button" className="btn btn-outline-dark" disabled>
                                {row.status.label}
                              </button>
                            )}
                            <button
                              className="btn btn-outline-danger js-promo-action-confirm"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setPendingOpen(false);
                                setConfirm({ kind: "delete", row });
                              }}
                            >
                              Elimina
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Riepilogo campagna (promoSummaryModal{id}) */}
      {summaryRow ? (
        <>
          <div className="modal fade show d-block" id={`promoSummaryModal${summaryRow.id}`} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-0">{summaryRow.title || "Promozione"}</h5>
                    <div className="text-muted small">Riepilogo campagna promozione</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setSummaryId(0)} />
                </div>
                <div className="modal-body">
                  <div className="row g-3">
                    {summaryRow.activationBlockMsg !== "" && !summaryRow.isActive ? (
                      <div className="col-12">
                        <div className="alert alert-danger mb-0">
                          <div className="fw-semibold mb-1">
                            <i className="bi bi-exclamation-triangle me-1" />
                            Promozione non riattivabile
                          </div>
                          <div className="small">{summaryRow.activationBlockMsg}</div>
                          {summaryRow.activationIssueItems.length > 0 ? (
                            <ul className="small mb-0 mt-2 ps-3">
                              {summaryRow.activationIssueItems.map((it, i) => (
                                <li key={i}>
                                  {it.type}: <strong>{it.name}</strong> — {it.label}
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
                          <dd className="col-sm-8">
                            <span className={`badge text-bg-${summaryRow.status.badge}`}>{summaryRow.status.label}</span>
                          </dd>
                          <dt className="col-sm-4 text-muted">Validità</dt>
                          <dd className="col-sm-8">{summaryRow.validityLabel}</dd>
                          <dt className="col-sm-4 text-muted">Target</dt>
                          <dd className="col-sm-8">{summaryRow.targetLabel}</dd>
                          {summaryRow.targetType === "fidelity" ? (
                            <>
                              <dt className="col-sm-4 text-muted">Livelli Fidelity</dt>
                              <dd className="col-sm-8">{summaryRow.levelsLabel}</dd>
                            </>
                          ) : null}
                          <dt className="col-sm-4 text-muted">Sconto</dt>
                          <dd className="col-sm-8">{summaryRow.discountSummary}</dd>
                          <dt className="col-sm-4 text-muted">Scope</dt>
                          <dd className="col-sm-8">{summaryRow.scopeLabel}</dd>
                          <dt className="col-sm-4 text-muted">Sedi</dt>
                          <dd className="col-sm-8">{summaryRow.locationLabel}</dd>
                          <dt className="col-sm-4 text-muted">Cumulabile con</dt>
                          <dd className="col-sm-8">{summaryRow.stackLabel}</dd>
                          <dt className="col-sm-4 text-muted">Clienti esclusi</dt>
                          <dd className="col-sm-8">
                            {summaryRow.excludedCount}
                            {summaryRow.excludedCount === 1 ? " cliente" : " clienti"}
                          </dd>
                          <dt className="col-sm-4 text-muted">Creata il</dt>
                          <dd className="col-sm-8">{summaryRow.createdLabel}</dd>
                          <dt className="col-sm-4 text-muted">Ultimo aggiornamento</dt>
                          <dd className="col-sm-8">{summaryRow.updatedLabel}</dd>
                          {summaryRow.description !== "" ? (
                            <>
                              <dt className="col-sm-4 text-muted">Descrizione</dt>
                              <dd className="col-sm-8" style={{ whiteSpace: "pre-line" }}>{summaryRow.description}</dd>
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
                              <tr>
                                <th className="text-muted fw-normal">Clienti coinvolti</th>
                                <td className="text-end fw-semibold">{summaryRow.stats.clientsTotal}</td>
                              </tr>
                              <tr>
                                <th className="text-muted fw-normal">Utilizzi totali</th>
                                <td className="text-end fw-semibold">{summaryRow.stats.redemptionsTotal}</td>
                              </tr>
                              <tr>
                                <th className="text-muted fw-normal">Sconto totale</th>
                                <td className="text-end">€ {summaryRow.stats.discountTotal}</td>
                              </tr>
                              <tr>
                                <th className="text-muted fw-normal">Primo utilizzo</th>
                                <td className="text-end">{summaryRow.stats.firstRedeemedAt}</td>
                              </tr>
                              <tr>
                                <th className="text-muted fw-normal">Ultimo utilizzo</th>
                                <td className="text-end">{summaryRow.stats.lastRedeemedAt}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Servizi / Prodotti e sconto</div>
                        <div className="row g-3 small">
                          <div className="col-12 col-lg-6">
                            <div className="fw-semibold mb-1">Servizi</div>
                            <div className="text-muted mb-2">{summaryRow.svcModeLabel}</div>
                            {summaryRow.svcMode === "selected" ? (
                              summaryRow.svcLines.length > 0 ? (
                                <ul className="mb-0 ps-3">
                                  {summaryRow.svcLines.map((line, i) => (
                                    <li key={i}>{line}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="text-muted">Nessun servizio selezionato.</div>
                              )
                            ) : summaryRow.svcMode === "all" && summaryRow.svcAllLine !== "" ? (
                              <div>
                                Sconto: <strong>{summaryRow.svcAllLine.split("|")[0]}</strong> • q.tà min. {summaryRow.svcAllLine.split("|")[1]}
                              </div>
                            ) : null}
                          </div>
                          <div className="col-12 col-lg-6">
                            <div className="fw-semibold mb-1">Prodotti</div>
                            <div className="text-muted mb-2">{summaryRow.prdModeLabel}</div>
                            {summaryRow.prdMode === "selected" ? (
                              summaryRow.prdLines.length > 0 ? (
                                <ul className="mb-0 ps-3">
                                  {summaryRow.prdLines.map((line, i) => (
                                    <li key={i}>{line}</li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="text-muted">Nessun prodotto selezionato.</div>
                              )
                            ) : summaryRow.prdMode === "all" && summaryRow.prdAllLine !== "" ? (
                              <div>
                                Sconto: <strong>{summaryRow.prdAllLine.split("|")[0]}</strong> • q.tà min. {summaryRow.prdAllLine.split("|")[1]}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="col-12 col-lg-6">
                      <div className="border rounded-3 p-3 h-100">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Validità dettagliata</div>
                        <dl className="row mb-0 small">
                          <dt className="col-sm-4 text-muted">Giorni / orari</dt>
                          <dd className="col-sm-8">{summaryRow.timeWindowsLabel}</dd>
                          <dt className="col-sm-4 text-muted">Date escluse</dt>
                          <dd className="col-sm-8">{summaryRow.blackoutsLabel}</dd>
                        </dl>
                      </div>
                    </div>

                    <div className="col-12 col-lg-6">
                      <div className="border rounded-3 p-3 h-100">
                        <div className="text-muted text-uppercase small fw-semibold mb-2">Limiti utilizzo</div>
                        <dl className="row mb-0 small">
                          <dt className="col-sm-5 text-muted">Utilizzi per cliente</dt>
                          <dd className="col-sm-7">{summaryRow.perCustomerLimitLabel}</dd>
                        </dl>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="mb-3">
                          <div className="text-muted text-uppercase small fw-semibold mb-1">Testo condizioni booking</div>
                          <div className="text-muted small">
                            Puoi aggiornare il testo mostrato nel booking sotto al totale. Questo testo non aggiunge regole
                            automatiche alla promozione.
                          </div>
                        </div>
                        <form
                          className="row g-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void saveConditions(summaryRow);
                          }}
                        >
                          <div className="col-12">
                            <div className="form-check form-switch">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                id={`promo_conditions_enabled_summary_${summaryRow.id}`}
                                checked={condEnabled}
                                onChange={(e) => setCondEnabled(e.target.checked)}
                              />
                              <label className="form-check-label" htmlFor={`promo_conditions_enabled_summary_${summaryRow.id}`}>
                                Mostra testo nel booking
                              </label>
                            </div>
                          </div>
                          <div className="col-12">
                            <textarea
                              className="form-control"
                              rows={3}
                              placeholder="Inserisci le condizioni della promozione"
                              value={condText}
                              onChange={(e) => setCondText(e.target.value)}
                            />
                          </div>
                          <div className="col-12">
                            <button className="btn btn-outline-primary" type="submit" disabled={busy}>
                              Salva condizioni
                            </button>
                          </div>
                        </form>
                      </div>
                    </div>

                    <div className="col-12">
                      <div className="border rounded-3 p-3">
                        <div className="d-flex flex-column flex-lg-row justify-content-between align-items-lg-start gap-2 mb-3">
                          <div>
                            <div className="text-muted text-uppercase small fw-semibold mb-1">Clienti esclusi</div>
                            <div className="text-muted small">
                              Puoi aggiungere o rimuovere clienti dall&apos;esclusione rispettando il target attuale della
                              promozione. I clienti con prenotazione o vendita associata alla promozione non compaiono nella
                              lista di aggiunta.
                            </div>
                          </div>
                          <div className="text-muted small">
                            {summaryRow.excludedCount} esclus{summaryRow.excludedCount === 1 ? "o" : "i"}
                          </div>
                        </div>

                        <div className="row g-3">
                          <div className="col-12 col-lg-5">
                            <form
                              className="row g-2 align-items-end"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void addExclusion(summaryRow);
                              }}
                            >
                              <div className="col-12">
                                <label className="form-label">Aggiungi cliente all&apos;esclusione</label>
                                <select
                                  className="form-select"
                                  value={excludeCandidate}
                                  disabled={summaryRow.exclusionCandidates.length === 0}
                                  onChange={(e) => setExcludeCandidate(e.target.value)}
                                >
                                  <option value="">— seleziona cliente —</option>
                                  {summaryRow.exclusionCandidates.map((c) => (
                                    <option key={c.id} value={String(c.id)}>
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="col-12">
                                <button className="btn btn-outline-primary" type="submit" disabled={busy || summaryRow.exclusionCandidates.length === 0}>
                                  Aggiungi all&apos;esclusione
                                </button>
                              </div>
                              <div className="col-12">
                                <div className="form-text">
                                  La lista rispetta il target Fidelity e nasconde chi ha già utilizzi, prenotazioni o vendite
                                  collegati a questa promozione.
                                </div>
                              </div>
                            </form>
                          </div>

                          <div className="col-12 col-lg-7">
                            <div className="small text-muted fw-semibold mb-2">Clienti attualmente esclusi</div>
                            {summaryRow.excludedClients.length > 0 ? (
                              <div className="d-flex flex-column gap-2">
                                {summaryRow.excludedClients.map((c) => (
                                  <div
                                    className="border rounded-3 px-3 py-2 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-2"
                                    key={c.id}
                                  >
                                    <div>
                                      <div className="fw-semibold">{c.name}</div>
                                      {c.meta !== "" ? <div className="text-muted small">{c.meta}</div> : null}
                                    </div>
                                    <button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => void removeExclusion(summaryRow, c.id)}>
                                      Rimuovi
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-muted small">Nessun cliente escluso per questa promozione.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setSummaryId(0)}>
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {/* Modal 'Conferma operazione' (Disattiva / Elimina) */}
      {confirm ? (
        <>
          <div className="modal fade show d-block" id="promotionActionConfirmModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="promotionActionConfirmTitle">
                    {(confirm.kind === "delete" ? "Elimina promozione" : "Disattiva promozione") + " - " + (confirm.row.title || "Promozione")}
                  </h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setConfirm(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning mb-3" id="promotionActionConfirmWarning">
                    {confirm.kind === "delete" ? (
                      <>
                        <div className="fw-semibold mb-1">Eliminazione definitiva</div>
                        <div>
                          Le prenotazioni in stato In sospeso o Prenotato perderanno la promozione. Le prenotazioni eseguite e
                          le vendite gia registrate non subiranno variazioni. La campagna verra eliminata definitivamente.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="fw-semibold mb-1">Conferma disattivazione</div>
                        <div>
                          Le prenotazioni in stato In sospeso o Prenotato perderanno la promozione. Le prenotazioni eseguite e
                          le vendite gia registrate non subiranno variazioni.
                        </div>
                      </>
                    )}
                  </div>
                  <div className="accordion" id="promotionActionPendingAccordion">
                    <div className="accordion-item border rounded-3 overflow-hidden">
                      <h3 className="accordion-header" id="promotionActionPendingHeading">
                        <button
                          className={`accordion-button bg-white shadow-none py-2${pendingOpen ? "" : " collapsed"}`}
                          type="button"
                          aria-expanded={pendingOpen}
                          onClick={() => setPendingOpen((v) => !v)}
                        >
                          <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                            <span className="fw-semibold">Prenotazioni interessate</span>
                            <span className="badge rounded-pill text-bg-info" id="promotionActionPendingCount">
                              {confirm.row.pending.count}
                            </span>
                          </span>
                        </button>
                      </h3>
                      <div className={`accordion-collapse collapse${pendingOpen ? " show" : ""}`} id="promotionActionPendingCollapse">
                        <div className="accordion-body py-2">
                          <div className="text-muted small mb-2" id="promotionActionPendingText">
                            {confirm.row.pending.count > 0
                              ? `${confirm.row.pending.count} prenotazion${confirm.row.pending.count === 1 ? "e aperta perdera" : "i aperte perderanno"} la promozione.`
                              : "Non risultano prenotazioni aperte collegate alla promozione."}
                          </div>
                          <div className="list-group list-group-flush" id="promotionActionPendingList">
                            {confirm.row.pending.items.slice(0, 20).map((it, i) => (
                              <div className="list-group-item px-0" key={i}>
                                {(it.label || "Prenotazione") + (it.detail ? ` - ${it.detail}` : "")}
                              </div>
                            ))}
                            {confirm.row.pending.count > confirm.row.pending.items.length ? (
                              <div className="list-group-item px-0 text-muted">
                                Altre {confirm.row.pending.count - confirm.row.pending.items.length} prenotazioni non mostrate.
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirm(null)}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    id="promotionActionConfirmGo"
                    disabled={busy}
                    onClick={() => {
                      const c = confirm;
                      setConfirm(null);
                      if (!c) return;
                      if (c.kind === "delete") void doDelete(c.row);
                      else void doToggle(c.row, false);
                    }}
                  >
                    Continua
                  </button>
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
