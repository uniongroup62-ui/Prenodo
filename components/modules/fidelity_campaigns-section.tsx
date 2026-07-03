"use client";

import { useCallback, useEffect, useState } from "react";

// Functional Fidelity POINTS campaigns manager (port of the fidelity_points.php
// campaigns section: save/toggle/delete_fidelity_campaign). Fed by
// /api/manage/fidelity?action=campaigns. Embedded into FidelityPointsContent
// (whose own campaign markup was dead static PHP forms). Amount + tiers earn
// modes, active window, min spend, optional card-level eligibility; activating
// enforces the no-overlap + fidelity-enabled guards server-side.

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
  level: string;
  tiers: Tier[];
};

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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=campaigns`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setCampaigns(Array.isArray(j.campaigns) ? j.campaigns : []))
      .catch(() => setCampaigns([]));
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
        setFlash("Campagna salvata.");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Campaign) {
    if (busy) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const j = await post({ action: "campaign_toggle", id: String(c.id), active: c.active ? "0" : "1" });
      if (j) {
        setFlash(c.active ? "Campagna disattivata." : "Campagna attivata.");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Campaign) {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questa campagna punti? Lo storico operativo resta invariato.")) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const j = await post({ action: "campaign_delete", id: String(c.id) });
      if (j) {
        setFlash("Campagna eliminata.");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function updateTier(idx: number, patch: Partial<Tier>) {
    setDraft((d) => (d ? { ...d, tiers: d.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : d));
  }

  return (
    <div className="card p-4 mb-3">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <div>
          <div className="h5 fw-bold mb-1">Campagne punti</div>
          <div className="text-muted small">Crea campagne temporanee o sempre attive. Una sola campagna puo essere attiva nello stesso periodo.</div>
        </div>
        {!draft ? (
          <button className="btn btn-primary btn-pill" type="button" onClick={startNew}>
            <i className="bi bi-plus-lg me-1" />
            Nuova campagna
          </button>
        ) : null}
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      {draft ? (
        <form className="border rounded p-3 mb-3" onSubmit={save}>
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Nome</label>
              <input className="form-control" value={draft.name} placeholder="Campagna punti" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Modalità</label>
              <select className="form-select" value={draft.earnMode} onChange={(e) => setDraft({ ...draft, earnMode: e.target.value as "amount" | "tiers" })}>
                <option value="amount">A importo (1 punto ogni € N)</option>
                <option value="tiers">A scaglioni</option>
              </select>
            </div>
            <div className="col-md-3 d-flex align-items-end">
              <div className="form-check form-switch">
                <input className="form-check-input" type="checkbox" id="campActive" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                <label className="form-check-label" htmlFor="campActive">Attiva</label>
              </div>
            </div>

            {draft.earnMode === "amount" ? (
              <>
                <div className="col-md-3">
                  <label className="form-label">1 punto ogni</label>
                  <div className="input-group">
                    <span className="input-group-text">€</span>
                    <input className="form-control" type="number" min="0" step="0.01" value={draft.earnStepEuro} onChange={(e) => setDraft({ ...draft, earnStepEuro: e.target.value })} />
                  </div>
                </div>
                <div className="col-md-3">
                  <label className="form-label">Spesa minima</label>
                  <div className="input-group">
                    <span className="input-group-text">€</span>
                    <input className="form-control" type="number" min="0" step="0.01" value={draft.minSpend} onChange={(e) => setDraft({ ...draft, minSpend: e.target.value })} />
                  </div>
                </div>
              </>
            ) : (
              <div className="col-12">
                <label className="form-label">Scaglioni (spesa minima → punti)</label>
                {draft.tiers.map((t, i) => (
                  <div className="row g-2 mb-2 align-items-end" key={i}>
                    <div className="col-md-3">
                      <div className="input-group">
                        <span className="input-group-text">€ ≥</span>
                        <input className="form-control" type="number" min="0" step="0.01" value={t.minSpend} onChange={(e) => updateTier(i, { minSpend: Number(e.target.value) || 0 })} />
                      </div>
                    </div>
                    <div className="col-md-3">
                      <div className="input-group">
                        <input className="form-control" type="number" min="0" step="1" value={t.points} onChange={(e) => updateTier(i, { points: Number(e.target.value) || 0 })} />
                        <span className="input-group-text">punti</span>
                      </div>
                    </div>
                    <div className="col-md-2">
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setDraft({ ...draft, tiers: draft.tiers.length > 1 ? draft.tiers.filter((_, x) => x !== i) : draft.tiers })}>
                        <i className="bi bi-x-lg" />
                      </button>
                    </div>
                  </div>
                ))}
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDraft({ ...draft, tiers: [...draft.tiers, { minSpend: 0, points: 1 }] })}>
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi scaglione
                </button>
              </div>
            )}

            <div className="col-md-3">
              <label className="form-label">Attiva dal</label>
              <input className="form-control" type="date" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Fino al</label>
              <input className="form-control" type="date" value={draft.endsAt} disabled={draft.endsNever} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
            </div>
            <div className="col-md-3 d-flex align-items-end">
              <div className="form-check">
                <input className="form-check-input" type="checkbox" id="campEndsNever" checked={draft.endsNever} onChange={(e) => setDraft({ ...draft, endsNever: e.target.checked })} />
                <label className="form-check-label" htmlFor="campEndsNever">Senza scadenza</label>
              </div>
            </div>
            <div className="col-md-3">
              <label className="form-label">Livello card (opzionale)</label>
              <input className="form-control" placeholder="es. base" value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })} />
            </div>
          </div>

          <div className="mt-3 d-flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              <i className="bi bi-check2-circle me-1" />
              {busy ? "Salvataggio…" : "Salva campagna"}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={() => setDraft(null)}>
              Annulla
            </button>
          </div>
        </form>
      ) : null}

      {/* Riga legacy "Campagna attiva oggi:" + badge (fidelity_points.php). */}
      <div className="text-muted small mb-2">
        Campagna attiva oggi:{" "}
        {(() => {
          const today = new Date().toISOString().slice(0, 10);
          const activeToday = campaigns.find((c) => c.active && (!c.startsAt || c.startsAt.slice(0, 10) <= today) && (!c.endsAt || c.endsAt.slice(0, 10) >= today));
          return activeToday
            ? <span className="badge text-bg-success">{activeToday.name}</span>
            : <span className="badge text-bg-secondary">Nessuna</span>;
        })()}
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
                <td colSpan={5} className="text-muted p-3">
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
                    <button type="button" className={`btn btn-sm ${c.active ? "btn-outline-warning" : "btn-outline-success"}`} disabled={busy} onClick={() => toggle(c)}>
                      {c.active ? "Disattiva" : "Attiva"}
                    </button>{" "}
                    <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => remove(c)}>
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
  );
}
