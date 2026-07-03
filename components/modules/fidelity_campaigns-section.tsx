"use client";

import { useCallback, useEffect, useState } from "react";

// Sezione "Campagne punti" (port di fidelity_points.php): tabella legacy
// Nome|Periodo|Accredito|Stato|Azioni con riga "Campagna attiva oggi:",
// form campagna in MODALE (fidelityCampaignFormModal: Nome campagna, Data
// attivazione "Vuota = subito.", Data scadenza + "Mai", Stato, Accredito in
// campagna Fisso/Scaglioni, Destinatari campagna Tutti i livelli / Livelli
// Punti) e modali di conferma legacy "Disattivare campagna punti?" /
// "Eliminare campagna punti?" con Riepilogo impatto e Motivo eliminazione.
// API: /api/manage/fidelity action=campaigns / campaign_save|toggle|delete.

type Tier = { minSpend: number; points: number };
type Campaign = {
  id: number;
  name: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
  earnMode: "amount" | "tiers";
  earnStepEuro: number;
  tiers: Tier[];
  eligibleLevels: string[];
  minSpend: number;
};

type Draft = {
  id: number;
  name: string;
  active: boolean;
  startsAt: string;
  endsNever: boolean;
  endsAt: string;
  earnMode: "amount" | "tiers";
  earnStepEuro: string;
  minSpend: string;
  level: string; // "" = tutti i livelli
  tiers: Tier[];
};

type Level = { key: string; name: string };

function emptyDraft(): Draft {
  return { id: 0, name: "", active: false, startsAt: "", endsNever: true, endsAt: "", earnMode: "amount", earnStepEuro: "10", minSpend: "0", level: "", tiers: [{ minSpend: 0, points: 1 }] };
}

function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(v: string): string {
  const s = (v ?? "").slice(0, 10);
  if (s === "") return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : "—";
}

export function FidelityCampaignsSection({ slug }: { slug: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  // Modali di conferma legacy (toggle-off / delete con motivo).
  const [toggleTarget, setToggleTarget] = useState<Campaign | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [deleteReason, setDeleteReason] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=campaigns`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setCampaigns(Array.isArray(j.campaigns) ? j.campaigns : []))
      .catch(() => setCampaigns([]));
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=levels`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.levels) ? j.levels : [];
        setLevels(list.map((l: Level) => ({ key: String(l.key ?? ""), name: String(l.name ?? "") })).filter((l: Level) => l.key));
      })
      .catch(() => setLevels([]));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function startNew() {
    setError("");
    setFlash("");
    setDraft(emptyDraft());
  }
  function startEdit(c: Campaign) {
    setError("");
    setFlash("");
    setDraft({
      id: c.id,
      name: c.name,
      active: c.active,
      startsAt: c.startsAt,
      endsNever: c.endsAt === "",
      endsAt: c.endsAt,
      earnMode: c.earnMode,
      earnStepEuro: String(c.earnStepEuro),
      minSpend: String(c.minSpend),
      level: c.eligibleLevels[0] ?? "",
      tiers: c.tiers.length > 0 ? c.tiers : [{ minSpend: 0, points: 1 }],
    });
  }

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) {
      setError(String(j?.error ?? "Operazione non riuscita."));
      return null;
    }
    return j;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const j = await post({
        action: "campaign_save",
        id: String(draft.id),
        name: draft.name,
        active: draft.active ? "1" : "0",
        starts_at: draft.startsAt,
        ends_never: draft.endsNever ? "1" : "0",
        ends_at: draft.endsAt,
        earn_mode: draft.earnMode,
        earn_step_euro: draft.earnStepEuro,
        min_spend: draft.minSpend,
        eligible_levels: draft.level.trim(),
        tiers_json: JSON.stringify(draft.tiers),
      });
      if (j) {
        setDraft(null);
        setFlash("Campagna punti salvata");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  // Toggle: l'attivazione è diretta; la DISATTIVAZIONE passa dal modale legacy.
  async function doToggle(c: Campaign) {
    if (busy) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const j = await post({ action: "campaign_toggle", id: String(c.id), active: c.active ? "0" : "1" });
      if (j) {
        setFlash(c.active ? "Campagna punti disattivata" : "Campagna punti attivata");
        setToggleTarget(null);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (busy || !deleteTarget) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const j = await post({ action: "campaign_delete", id: String(deleteTarget.id), reason: deleteReason });
      if (j) {
        setFlash("Campagna punti eliminata definitivamente.");
        setDeleteTarget(null);
        setDeleteReason("");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function updateTier(idx: number, patch: Partial<Tier>) {
    setDraft((d) => (d ? { ...d, tiers: d.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : d));
  }

  const today = new Date().toISOString().slice(0, 10);
  const activeToday = campaigns.find((c) => c.active && (!c.startsAt || c.startsAt.slice(0, 10) <= today) && (!c.endsAt || c.endsAt.slice(0, 10) >= today));

  return (
    <div className="card p-4 mb-3">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <div>
          <div className="h5 fw-bold mb-1">Campagne punti</div>
          <div className="text-muted small">Crea campagne temporanee o sempre attive. Una sola campagna puo essere attiva nello stesso periodo.</div>
        </div>
        <button className="btn btn-primary btn-pill" type="button" onClick={startNew}>
          <i className="bi bi-plus-lg me-1" />
          Nuova campagna
        </button>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      {/* Riga legacy "Campagna attiva oggi:" + badge. */}
      <div className="text-muted small mb-2">
        Campagna attiva oggi:{" "}
        {activeToday ? <span className="badge text-bg-success">{activeToday.name}</span> : <span className="badge text-bg-secondary">Nessuna</span>}
      </div>

      <div className="table-responsive">
        <table className="table mb-0 align-middle">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Periodo</th>
              <th>Accredito</th>
              <th>Stato</th>
              <th className="text-end">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted p-2">
                  Nessuna campagna punti configurata.
                </td>
              </tr>
            ) : (
              campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="fw-semibold">{c.name}</td>
                  <td className="text-muted small">
                    {c.startsAt ? fmtDate(c.startsAt) : "Subito"} → {c.endsAt ? fmtDate(c.endsAt) : "Mai"}
                  </td>
                  <td className="text-muted small">
                    {c.earnMode === "tiers" ? `Scaglioni (${c.tiers.length})` : `Fisso: 1 punto ogni ${fmtEuro(c.earnStepEuro)}`}
                    {c.minSpend > 0 ? ` · min ${fmtEuro(c.minSpend)}` : ""}
                  </td>
                  <td>
                    <span className={`badge ${c.active ? "text-bg-success" : "text-bg-secondary"}`}>{c.active ? "Attiva" : "Disattiva"}</span>
                  </td>
                  <td className="text-end">
                    <button type="button" className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => startEdit(c)}>
                      Modifica
                    </button>{" "}
                    {c.active ? (
                      <button type="button" className="btn btn-sm btn-outline-warning" disabled={busy} onClick={() => setToggleTarget(c)}>
                        Disattiva
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-outline-success" disabled={busy} onClick={() => doToggle(c)}>
                        Attiva
                      </button>
                    )}{" "}
                    <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => { setDeleteTarget(c); setDeleteReason(""); }}>
                      Elimina
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* MODALE form campagna (fidelityCampaignFormModal). */}
      {draft ? (
        <div className="modal fade show d-block" id="fidelityCampaignFormModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-lg modal-dialog-scrollable">
            <form className="modal-content" onSubmit={save}>
              <div className="modal-header">
                <div>
                  <h5 className="modal-title fw-bold m-0">{draft.id > 0 ? "Modifica campagna" : "Nuova campagna"}</h5>
                  <div className="text-muted small">Per una campagna sempre attiva lascia vuote le date. Una sola campagna puo essere attiva nello stesso periodo.</div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDraft(null)} />
              </div>
              <div className="modal-body">
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Nome campagna</label>
                    <input className="form-control" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Data attivazione</label>
                    <input className="form-control" type="date" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
                    <div className="form-text">Vuota = subito.</div>
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Data scadenza</label>
                    <input className="form-control" type="date" value={draft.endsAt} disabled={draft.endsNever} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
                    <div className="form-check mt-1">
                      <input className="form-check-input" type="checkbox" id="campEndsNever" checked={draft.endsNever} onChange={(e) => setDraft({ ...draft, endsNever: e.target.checked })} />
                      <label className="form-check-label" htmlFor="campEndsNever">Mai</label>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <label className="form-label d-block">Stato</label>
                    <div className="form-check form-switch">
                      <input className="form-check-input" type="checkbox" id="campActive" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                      <label className="form-check-label" htmlFor="campActive">{draft.active ? "Attiva" : "Disattiva"}</label>
                    </div>
                  </div>

                  <div className="col-12">
                    <hr className="my-1" />
                    <div className="fw-semibold">Accredito in campagna</div>
                    <div className="text-muted small mb-2">Puoi usare un accredito fisso oppure scaglioni in base alla spesa.</div>
                    <div className="d-flex gap-4 mb-2">
                      <div className="form-check">
                        <input className="form-check-input" type="radio" name="fid_campaign_earn_mode" id="earnModeAmount" checked={draft.earnMode === "amount"} onChange={() => setDraft({ ...draft, earnMode: "amount" })} />
                        <label className="form-check-label" htmlFor="earnModeAmount">Fisso</label>
                      </div>
                      <div className="form-check">
                        <input className="form-check-input" type="radio" name="fid_campaign_earn_mode" id="earnModeTiers" checked={draft.earnMode === "tiers"} onChange={() => setDraft({ ...draft, earnMode: "tiers" })} />
                        <label className="form-check-label" htmlFor="earnModeTiers">Scaglioni</label>
                      </div>
                    </div>

                    {draft.earnMode === "amount" ? (
                      <div className="row g-3">
                        <div className="col-md-6">
                          <label className="form-label">Accredito fisso</label>
                          <div className="input-group">
                            <span className="input-group-text">1 punto ogni</span>
                            <input className="form-control" type="number" min="0" step="0.01" value={draft.earnStepEuro} onChange={(e) => setDraft({ ...draft, earnStepEuro: e.target.value })} />
                            <span className="input-group-text">EUR</span>
                          </div>
                        </div>
                        <div className="col-md-6">
                          <label className="form-label">Spesa minima</label>
                          <div className="input-group">
                            <input className="form-control" type="number" min="0" step="0.01" value={draft.minSpend} onChange={(e) => setDraft({ ...draft, minSpend: e.target.value })} />
                            <span className="input-group-text">EUR</span>
                          </div>
                          <div className="form-text">0 = nessun minimo.</div>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="table-responsive">
                          <table className="table table-sm align-middle mb-2">
                            <thead>
                              <tr>
                                <th>Spesa minima</th>
                                <th>Punti</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {draft.tiers.map((t, i) => (
                                <tr key={i}>
                                  <td>
                                    <div className="input-group input-group-sm">
                                      <input className="form-control" type="number" min="0" step="0.01" value={t.minSpend} onChange={(e) => updateTier(i, { minSpend: Number(e.target.value) || 0 })} />
                                      <span className="input-group-text">EUR</span>
                                    </div>
                                  </td>
                                  <td>
                                    <input className="form-control form-control-sm" type="number" min="0" step="1" value={t.points} onChange={(e) => updateTier(i, { points: Number(e.target.value) || 0 })} />
                                  </td>
                                  <td className="text-end">
                                    <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setDraft({ ...draft, tiers: draft.tiers.length > 1 ? draft.tiers.filter((_, x) => x !== i) : draft.tiers })}>
                                      <i className="bi bi-x-lg" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDraft({ ...draft, tiers: [...draft.tiers, { minSpend: 0, points: 1 }] })}>
                          <i className="bi bi-plus-lg me-1" />
                          Aggiungi scaglione
                        </button>
                        <div className="form-text">Regola: si applica lo scaglione piu alto raggiunto.</div>
                      </div>
                    )}
                  </div>

                  <div className="col-12">
                    <hr className="my-1" />
                    <div className="fw-semibold">Destinatari campagna</div>
                    <div className="text-muted small mb-2">Scegli se applicarla a tutti i livelli card o solo a un livello specifico.</div>
                    <div className="form-check">
                      <input className="form-check-input" type="radio" name="fid_campaign_level" id="lvlAll" checked={draft.level === ""} onChange={() => setDraft({ ...draft, level: "" })} />
                      <label className="form-check-label" htmlFor="lvlAll">Tutti i livelli</label>
                    </div>
                    {levels.length > 0 ? (
                      <div className="mt-1">
                        <div className="text-muted small">Livelli Punti</div>
                        {levels.map((l) => (
                          <div className="form-check" key={l.key}>
                            <input className="form-check-input" type="radio" name="fid_campaign_level" id={`lvl_${l.key}`} checked={draft.level === l.key} onChange={() => setDraft({ ...draft, level: l.key })} />
                            <label className="form-check-label" htmlFor={`lvl_${l.key}`}>{l.name}</label>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setDraft(null)}>
                  Annulla
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva campagna
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODALE "Disattivare campagna punti?" (fidelityCampaignTogglePreviewModal). */}
      {toggleTarget ? (
        <div className="modal fade show d-block" id="fidelityCampaignTogglePreviewModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title fw-bold m-0">Disattivare campagna punti?</h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setToggleTarget(null)} />
              </div>
              <div className="modal-body">
                <div className="text-muted small">
                  La campagna <strong>{toggleTarget.name}</strong> smetterà di accreditare punti; storico e saldi clienti non verranno modificati.
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setToggleTarget(null)}>
                  Annulla
                </button>
                <button className="btn btn-warning" type="button" disabled={busy} onClick={() => doToggle(toggleTarget)}>
                  Disattiva campagna
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE "Eliminare campagna punti?" (fidelityCampaignDeletePreviewModal). */}
      {deleteTarget ? (
        <div className="modal fade show d-block" id="fidelityCampaignDeletePreviewModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title fw-bold m-0">Eliminare campagna punti?</h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteTarget(null)} />
              </div>
              <div className="modal-body">
                <div className="fw-semibold">Riepilogo impatto</div>
                <div className="text-muted small mb-3">
                  Se la campagna ha storico operativo, verra rimossa dall&apos;elenco e disattivata. Punti, movimenti, prenotazioni, vendite, ricariche e saldi clienti non verranno cancellati.
                </div>
                <label className="form-label">
                  Motivo eliminazione <span className="text-muted">(opzionale)</span>
                </label>
                <textarea className="form-control" rows={2} value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setDeleteTarget(null)}>
                  Annulla
                </button>
                <button className="btn btn-danger" type="button" disabled={busy} onClick={doDelete}>
                  Elimina campagna
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
