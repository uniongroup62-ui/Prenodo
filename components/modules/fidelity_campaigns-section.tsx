"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Sezione "Campagne punti" (port di fidelity_points.php): tabella legacy
// Nome (+ 'ID: N') | Periodo ('Subito -> Mai') | Accredito ('Fisso: 1 punto
// ogni X,XX EUR' / 'Scaglioni (N)') | Stato (Attiva / 'Disattivata da Punti' /
// Disattiva) | Azioni; form campagna in MODALE (fidelityCampaignFormModal) con
// i default legacy (nome 'Nuova campagna punti', attiva, inizio oggi, step
// dalle impostazioni); PREVIEW di impatto legacy su disattivazione ed
// eliminazione (action=campaign_preview: prenotazioni aperte/storiche,
// vendite, ricariche, movimenti punti) con i testi di fidelity_points.js.
// Salva/attiva/disattiva/elimina fanno redirect flash ?msg come il PHP; gli
// errori del salvataggio restano nel form col prefisso legacy.

type Tier = { minSpend: number; points: number };
type Campaign = {
  id: number;
  name: string;
  active: boolean;
  autoDisabledByPoints: boolean;
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

type Preview = {
  campaign: { id: number; name: string; active: boolean; deleted: boolean };
  references: number;
  will_archive: boolean;
  can_archive: boolean;
  has_open_appointments: boolean;
  appointments: { total: number; open: number; done: number; canceled: number; other: number; points: number };
  sales: { total: number; active: number; canceled: number; points: number };
  recharges: { total: number; active: number; voided: number; points: number };
  movements: { total: number; points: number };
};

// fmt_money legacy: 2 decimali, virgola, punto per le migliaia.
function fmtMoney(v: number): string {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}
function fmtDmy(v: string): string {
  const s = (v ?? "").slice(0, 10);
  if (s === "") return "";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : "";
}
// Input numerico legacy ($fmtNumInput): senza zeri finali.
function fmtNumInput(v: number): string {
  const s = Number(v || 0).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function FidelityCampaignsSection({ slug, defaultEarnStep = 10 }: { slug: string; defaultEarnStep?: number }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  // Modali preview legacy (toggle-off / delete con motivo + riepilogo impatto).
  const [toggleTarget, setToggleTarget] = useState<Campaign | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewSeqRef = useRef(0);
  const [previewError, setPreviewError] = useState("");

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

  function redirectFlash(kind: "msg" | "err", text: string) {
    window.location.href = `/${encodeURIComponent(slug)}/fidelity_points?${kind}=${encodeURIComponent(text)}`;
  }

  // Default legacy del form nuova campagna (fidelity_points.php $campDefaults).
  function startNew() {
    setDraftError("");
    setDraft({
      id: 0,
      name: "Nuova campagna punti",
      active: true,
      startsAt: todayYmd(),
      endsNever: true,
      endsAt: "",
      earnMode: "amount",
      earnStepEuro: fmtNumInput(defaultEarnStep),
      minSpend: "0",
      level: "",
      tiers: [{ minSpend: 0, points: 1 }],
    });
  }
  function startEdit(c: Campaign) {
    setDraftError("");
    setDraft({
      id: c.id,
      name: c.name,
      active: c.active,
      startsAt: c.startsAt,
      endsNever: c.endsAt === "",
      endsAt: c.endsAt,
      earnMode: c.earnMode,
      earnStepEuro: fmtNumInput(c.earnStepEuro),
      minSpend: fmtNumInput(c.minSpend),
      level: c.eligibleLevels[0] ?? "",
      tiers: c.tiers.length > 0 ? c.tiers : [{ minSpend: 0, points: 1 }],
    });
  }

  async function post(body: Record<string, unknown>): Promise<{ j: Record<string, unknown> | null; error: string }> {
    const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) return { j: null, error: String(j?.error ?? "Operazione non riuscita.") };
    return { j, error: "" };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setDraftError("");
    try {
      const { j, error: err } = await post({
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
        redirectFlash("msg", "Campagna punti salvata");
        return;
      }
      // Errore legacy in-form col prefisso (il PHP riapre il form).
      setDraftError(`Errore salvataggio campagna punti: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function doToggle(c: Campaign) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { j, error: err } = await post({ action: "campaign_toggle", id: String(c.id), active: c.active ? "0" : "1" });
      if (j) {
        redirectFlash("msg", c.active ? "Campagna punti disattivata" : "Campagna punti attivata");
        return;
      }
      setToggleTarget(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (busy || !deleteTarget) return;
    setBusy(true);
    setError("");
    try {
      const { j, error: err } = await post({ action: "campaign_delete", id: String(deleteTarget.id), reason: deleteReason });
      if (j) {
        // Messaggi legacy per modalità (hard/soft/gia rimossa).
        const mode = String(j.mode ?? "hard");
        redirectFlash(
          "msg",
          mode === "hard"
            ? "Campagna punti eliminata definitivamente."
            : mode === "already"
              ? "Campagna punti gia rimossa."
              : "Campagna punti rimossa dall elenco operativo. Storico, saldi, prenotazioni e vendite non sono stati modificati.",
        );
        return;
      }
      setDeleteTarget(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Preview di impatto legacy (preview_fidelity_campaign_toggle/delete).
  function openPreview(target: Campaign, kind: "toggle" | "delete") {
    setPreview(null);
    setPreviewError("");
    if (kind === "toggle") setToggleTarget(target);
    else {
      setDeleteTarget(target);
      setDeleteReason("");
    }
    // Anti-stale (audit giro 3): aprendo B dopo A, la risposta lenta di A
    // poteva mostrare l'impatto della campagna SBAGLIATA nella modale.
    const seq = ++previewSeqRef.current;
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=campaign_preview&id=${target.id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (seq !== previewSeqRef.current) return;
        if (!j?.ok || !j?.preview) throw new Error(String(j?.error ?? "Preview non disponibile."));
        setPreview(j.preview as Preview);
      })
      .catch((e) => {
        if (seq === previewSeqRef.current) setPreviewError(e instanceof Error ? e.message : "Errore non previsto");
      });
  }

  function updateTier(idx: number, patch: Partial<Tier>) {
    setDraft((d) => (d ? { ...d, tiers: d.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : d));
  }

  const today = todayYmd();
  const activeToday = campaigns.find((c) => c.active && (!c.startsAt || c.startsAt.slice(0, 10) <= today) && (!c.endsAt || c.endsAt.slice(0, 10) >= today));

  // Contenuti preview (rendering fidelity_points.js).
  const previewStats = preview
    ? {
        open: preview.appointments.open,
        historic: preview.appointments.done + preview.appointments.canceled + preview.appointments.other,
        sales: preview.sales.total,
        recharges: preview.recharges.total,
        movements: preview.movements.total,
        refs: preview.references,
      }
    : null;

  return (
    <div className="card p-4">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <div>
          <div className="h5 fw-bold m-0">Campagne punti</div>
          <div className="text-muted small">Crea campagne temporanee o sempre attive. Una sola campagna puo essere attiva nello stesso periodo.</div>
        </div>
        <button className="btn btn-sm btn-outline-primary" type="button" onClick={startNew}>
          <i className="bi bi-plus-lg me-1" />
          Nuova campagna
        </button>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {/* Riga legacy "Campagna attiva oggi:" + badge. */}
      <div className="small text-muted mb-2">
        Campagna attiva oggi:{" "}
        {activeToday ? <span className="badge text-bg-success">{activeToday.name}</span> : <span className="badge text-bg-secondary">Nessuna</span>}
      </div>

      <div className="table-responsive mb-3">
        <table className="table table-sm align-middle mb-0">
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
                  <td>
                    <div className="fw-semibold">{c.name}</div>
                    <div className="text-muted small">ID: {c.id}</div>
                  </td>
                  <td>
                    {c.startsAt ? fmtDmy(c.startsAt) : "Subito"} -&gt; {c.endsAt ? fmtDmy(c.endsAt) : "Mai"}
                  </td>
                  <td>{c.earnMode === "tiers" ? `Scaglioni (${c.tiers.length})` : `Fisso: 1 punto ogni ${fmtMoney(c.earnStepEuro)} EUR`}</td>
                  <td>
                    <span className={`badge text-bg-${c.active ? "success" : c.autoDisabledByPoints ? "warning" : "secondary"}`}>
                      {c.active ? "Attiva" : c.autoDisabledByPoints ? "Disattivata da Punti" : "Disattiva"}
                    </span>
                  </td>
                  <td className="text-end">
                    <div className="d-inline-flex gap-1 flex-wrap justify-content-end">
                      <button type="button" className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => startEdit(c)}>
                        Modifica
                      </button>
                      {c.active ? (
                        <button type="button" className="btn btn-sm btn-outline-warning" disabled={busy} onClick={() => openPreview(c, "toggle")}>
                          Disattiva
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm btn-outline-success" disabled={busy} onClick={() => doToggle(c)}>
                          Attiva
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => openPreview(c, "delete")}>
                        Elimina
                      </button>
                    </div>
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
          <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
            <form className="modal-content" id="fidCampaignForm" onSubmit={save}>
              <div className="modal-header">
                <div>
                  <h5 className="modal-title mb-1">{draft.id > 0 ? "Modifica campagna" : "Nuova campagna"}</h5>
                  <div className="text-muted small">Per una campagna sempre attiva lascia vuote le date. Una sola campagna puo essere attiva nello stesso periodo.</div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDraft(null)} />
              </div>
              <div className="modal-body">
                <div className="row g-3">
                  {draftError ? (
                    <div className="col-12">
                      <div className="alert alert-danger mb-0">{draftError}</div>
                    </div>
                  ) : null}
                  <div className="col-md-5">
                    <label className="form-label">Nome campagna</label>
                    <input className="form-control" name="fid_campaign_name" maxLength={120} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Data attivazione</label>
                    <input className="form-control" type="date" name="fid_campaign_starts_at" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
                    <div className="small text-muted mt-1">Vuota = subito.</div>
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Data scadenza</label>
                    <input
                      className="form-control"
                      type="date"
                      name="fid_campaign_ends_at"
                      value={draft.endsAt}
                      disabled={draft.endsNever}
                      onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
                    />
                    <div className="form-check mt-1">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="fid_campaign_ends_never"
                        checked={draft.endsNever}
                        onChange={(e) => setDraft({ ...draft, endsNever: e.target.checked })}
                      />
                      <label className="form-check-label small" htmlFor="fid_campaign_ends_never">
                        Mai
                      </label>
                    </div>
                  </div>
                  <div className="col-md-1">
                    <label className="form-label d-block">Stato</label>
                    <div className="form-check form-switch mt-2">
                      <input className="form-check-input" type="checkbox" id="fid_campaign_active" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                    </div>
                  </div>

                  <div className="col-12">
                    <hr className="my-1" />
                  </div>
                  <div className="col-12">
                    <div className="fw-semibold">Accredito in campagna</div>
                    <div className="text-muted small">Puoi usare un accredito fisso oppure scaglioni in base alla spesa.</div>
                  </div>
                  <div className="col-md-4">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="fid_campaign_earn_mode"
                        id="fid_earn_amount"
                        checked={draft.earnMode === "amount"}
                        onChange={() => setDraft({ ...draft, earnMode: "amount" })}
                      />
                      <label className="form-check-label" htmlFor="fid_earn_amount">
                        Fisso
                      </label>
                    </div>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="radio"
                        name="fid_campaign_earn_mode"
                        id="fid_earn_tiers"
                        checked={draft.earnMode === "tiers"}
                        onChange={() => setDraft({ ...draft, earnMode: "tiers" })}
                      />
                      <label className="form-check-label" htmlFor="fid_earn_tiers">
                        Scaglioni
                      </label>
                    </div>
                  </div>
                  {draft.earnMode === "amount" ? (
                    <>
                      <div className="col-md-4" id="fid_earn_amount_wrap">
                        <label className="form-label">Accredito fisso</label>
                        <div className="input-group">
                          <span className="input-group-text">1 punto ogni</span>
                          <input
                            className="form-control"
                            type="number"
                            step="0.01"
                            min="0"
                            name="fid_campaign_earn_step_euro"
                            value={draft.earnStepEuro}
                            onChange={(e) => setDraft({ ...draft, earnStepEuro: e.target.value })}
                          />
                          <span className="input-group-text">EUR</span>
                        </div>
                      </div>
                      <div className="col-md-4" id="fid_min_spend_wrap">
                        <label className="form-label">Spesa minima</label>
                        <div className="input-group">
                          <span className="input-group-text">EUR</span>
                          <input
                            className="form-control"
                            type="number"
                            step="0.01"
                            min="0"
                            name="fid_campaign_min_spend"
                            value={draft.minSpend}
                            onChange={(e) => setDraft({ ...draft, minSpend: e.target.value })}
                          />
                        </div>
                        <div className="small text-muted mt-1">0 = nessun minimo.</div>
                      </div>
                    </>
                  ) : (
                    <div className="col-12" id="fid_earn_tiers_wrap">
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-2">
                          <thead>
                            <tr>
                              <th className="points-campaign-tier-col">Spesa minima</th>
                              <th className="points-campaign-tier-col">Punti</th>
                              <th className="text-end" />
                            </tr>
                          </thead>
                          <tbody id="fid_tiers_body">
                            {draft.tiers.map((t, i) => (
                              <tr key={i}>
                                <td>
                                  <div className="input-group input-group-sm">
                                    <span className="input-group-text">EUR</span>
                                    <input className="form-control" type="number" step="0.01" min="0" value={t.minSpend} onChange={(e) => updateTier(i, { minSpend: Number(e.target.value) || 0 })} />
                                  </div>
                                </td>
                                <td>
                                  <input className="form-control form-control-sm" type="number" step="1" min="0" value={t.points} onChange={(e) => updateTier(i, { points: Number(e.target.value) || 0 })} />
                                </td>
                                <td className="text-end">
                                  <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setDraft({ ...draft, tiers: draft.tiers.filter((_, x) => x !== i) })}>
                                    <i className="bi bi-x" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button type="button" className="btn btn-sm btn-outline-primary" id="fid_add_tier" onClick={() => setDraft({ ...draft, tiers: [...draft.tiers, { minSpend: 0, points: 1 }] })}>
                        <i className="bi bi-plus-lg me-1" />
                        Aggiungi scaglione
                      </button>
                      <div className="small text-muted mt-1">Regola: si applica lo scaglione piu alto raggiunto.</div>
                    </div>
                  )}

                  <div className="col-12">
                    <hr />
                  </div>
                  <div className="col-12">
                    <div className="fw-semibold">Destinatari campagna</div>
                    <div className="text-muted small">Scegli se applicarla a tutti i livelli card o solo a un livello specifico.</div>
                    <div className="form-check mt-2">
                      <input className="form-check-input" type="radio" id="fid_lvl_all" name="fid_campaign_level" checked={draft.level === ""} onChange={() => setDraft({ ...draft, level: "" })} />
                      <label className="form-check-label" htmlFor="fid_lvl_all">
                        Tutti i livelli
                      </label>
                    </div>
                    <div className="row g-3 mt-1">
                      <div className="col-md-12">
                        <div className="text-muted small fw-semibold">Livelli Punti</div>
                        {levels.length > 0 ? (
                          <div className="d-flex flex-wrap gap-2 mt-2">
                            {levels.map((l) => (
                              <div className="form-check" key={l.key}>
                                <input
                                  className="form-check-input"
                                  type="radio"
                                  name="fid_campaign_level"
                                  id={`fid_lvl_pts_${l.key}`}
                                  checked={draft.level === l.key}
                                  onChange={() => setDraft({ ...draft, level: l.key })}
                                />
                                <label className="form-check-label" htmlFor={`fid_lvl_pts_${l.key}`}>
                                  {l.name || l.key}
                                </label>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-muted small">Livelli Punti non disponibili.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="col-12 d-flex justify-content-end gap-2">
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva campagna
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODALE "Disattivare campagna punti?" con preview di impatto. */}
      {toggleTarget ? (
        <div className="modal fade show d-block" id="fidelityCampaignTogglePreviewModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title mb-1">Disattivare campagna punti?</h5>
                  <div className="text-muted small" id="fidelityCampaignTogglePreviewSubtitle">Campagna: {toggleTarget.name}</div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setToggleTarget(null)} />
              </div>
              <div className="modal-body">
                <div id="fidelityCampaignTogglePreviewBody">
                  {previewError !== "" ? (
                    <div className="alert alert-danger mb-0">
                      <div className="fw-semibold mb-1">Impossibile calcolare il riepilogo</div>
                      <div className="small">{previewError}</div>
                    </div>
                  ) : !previewStats ? (
                    <div className="text-muted">Calcolo impatto in corso...</div>
                  ) : (
                    <>
                      {previewStats.open > 0 ? (
                        <div className="alert alert-warning mb-3">
                          <div className="fw-semibold mb-1">Prenotazioni aperte collegate</div>
                          <div className="small">
                            Le prenotazioni in sospeso o prenotate collegate a questa campagna non genereranno punti se vengono completate mentre la campagna resta disattiva.
                          </div>
                        </div>
                      ) : previewStats.refs > 0 ? (
                        <div className="alert alert-info mb-3">
                          <div className="fw-semibold mb-1">Nessuna prenotazione aperta collegata</div>
                          <div className="small">La campagna non verra piu usata per nuovi accrediti. Lo storico gia registrato resta invariato.</div>
                        </div>
                      ) : (
                        <div className="alert alert-info mb-3">
                          <div className="fw-semibold mb-1">Nessun collegamento operativo rilevato</div>
                          <div className="small">La campagna verra semplicemente disattivata e potrai riattivarla in seguito.</div>
                        </div>
                      )}
                      <div className="row g-2 mb-3">
                        {[
                          { label: "Prenotazioni aperte", value: previewStats.open, tone: "warning" },
                          { label: "Prenotazioni storiche", value: previewStats.historic, tone: "body" },
                          { label: "Vendite collegate", value: previewStats.sales, tone: "body" },
                          { label: "Ricariche collegate", value: previewStats.recharges, tone: "body" },
                          { label: "Movimenti punti", value: previewStats.movements, tone: "body" },
                        ]
                          .filter((s) => s.value > 0)
                          .map((s) => (
                            <div className="col-6 col-md-3" key={s.label}>
                              <div className="border rounded-3 px-3 py-2 bg-white">
                                <div className="small text-muted">{s.label}</div>
                                <div className={`fw-semibold text-${s.tone}`}>{s.value}</div>
                              </div>
                            </div>
                          ))}
                      </div>
                      <div className="small text-muted">
                        Vendite, ricariche, movimenti, saldi, punti e storico clienti gia registrati non verranno modificati. La modifica riguarda solo gli utilizzi futuri
                        della campagna.
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setToggleTarget(null)}>
                  Annulla
                </button>
                <button type="button" className="btn btn-warning btn-pill" id="fidelityCampaignTogglePreviewConfirm" disabled={busy || (!previewStats && previewError === "")} onClick={() => doToggle(toggleTarget)}>
                  <i className="bi bi-pause-circle me-1" />
                  Disattiva campagna
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE "Eliminare campagna punti?" con preview + motivo. */}
      {deleteTarget ? (
        <div className="modal fade show d-block" id="fidelityCampaignDeletePreviewModal" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
            <form
              className="modal-content"
              id="fidCampaignDeleteForm"
              onSubmit={(e) => {
                e.preventDefault();
                void doDelete();
              }}
            >
              <div className="modal-header">
                <div>
                  <h5 className="modal-title mb-1">Eliminare campagna punti?</h5>
                  <div className="text-muted small" id="fidelityCampaignDeletePreviewSubtitle">Campagna: {deleteTarget.name}</div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteTarget(null)} />
              </div>
              <div className="modal-body">
                {preview === null || preview.will_archive ? (
                  <div className="alert alert-warning mb-3" id="fidelityCampaignDeletePreviewWarning">
                    <div className="fw-semibold mb-1">Riepilogo impatto</div>
                    <div className="small">
                      Se la campagna ha storico operativo, verra rimossa dall&apos;elenco e disattivata. Punti, movimenti, prenotazioni, vendite, ricariche e saldi clienti non
                      verranno cancellati.
                    </div>
                  </div>
                ) : null}
                <div id="fidelityCampaignDeletePreviewBody">
                  {previewError !== "" ? (
                    <div className="alert alert-danger mb-0">
                      <div className="fw-semibold mb-1">Impossibile calcolare il riepilogo</div>
                      <div className="small">{previewError}</div>
                    </div>
                  ) : preview === null ? (
                    <div className="text-muted">Calcolo impatto in corso...</div>
                  ) : !preview.will_archive ? (
                    <div className="alert alert-info mb-0">
                      <div className="fw-semibold mb-1">Nessun collegamento rilevato</div>
                      <div className="small">Sei sicuro di eliminare questa campagna? La rimozione sara definitiva solo per la configurazione della campagna.</div>
                    </div>
                  ) : (
                    <>
                      {[
                        {
                          title: "Prenotazioni aperte",
                          total: preview.appointments.open,
                          rows: ["Le prenotazioni resteranno registrate, ma la campagna rimossa non generera nuovi punti quando verranno completate."],
                        },
                        {
                          title: "Prenotazioni storiche",
                          total: preview.appointments.done + preview.appointments.canceled + preview.appointments.other,
                          rows: [
                            `Completate: ${preview.appointments.done}`,
                            `Annullate o rifiutate: ${preview.appointments.canceled}`,
                            `Altri stati: ${preview.appointments.other}`,
                          ],
                        },
                        { title: "Vendite collegate", total: preview.sales.total, rows: [`Attive: ${preview.sales.active}`, `Annullate: ${preview.sales.canceled}`] },
                        { title: "Ricariche collegate", total: preview.recharges.total, rows: [`Attive: ${preview.recharges.active}`, `Stornate: ${preview.recharges.voided}`] },
                        {
                          title: "Movimenti punti",
                          total: preview.movements.total,
                          rows: [`Movimenti collegati: ${preview.movements.total}`, `Punti gia registrati: ${preview.movements.points}`],
                        },
                      ]
                        .filter((s) => s.total > 0)
                        .map((s) => (
                          <div className="border rounded-3 overflow-hidden mb-2" key={s.title}>
                            <div className="d-flex align-items-center justify-content-between gap-2 px-3 py-2 bg-white">
                              <span className="fw-semibold">{s.title}</span>
                              <span className="badge rounded-pill text-bg-info">{s.total}</span>
                            </div>
                            <div className="px-3 py-2 border-top">
                              {s.rows.map((r, i) => (
                                <div className="small" key={i}>
                                  {r}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      <div className="text-muted small mt-2">
                        Riferimenti totali: <strong>{preview.references}</strong>. La cancellazione conservera storico e saldi.
                      </div>
                    </>
                  )}
                </div>
                <div className="mt-3">
                  <label className="form-label" htmlFor="fidCampaignDeleteReason">
                    Motivo eliminazione <span className="text-muted">(opzionale)</span>
                  </label>
                  <input
                    className="form-control"
                    type="text"
                    id="fidCampaignDeleteReason"
                    maxLength={255}
                    placeholder="Es. campagna sostituita"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setDeleteTarget(null)}>
                  Annulla
                </button>
                <button type="submit" className="btn btn-danger btn-pill" id="fidelityCampaignDeletePreviewConfirm" disabled={busy || (preview === null && previewError === "")}>
                  <i className="bi bi-x-lg me-1" />
                  Elimina campagna
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
