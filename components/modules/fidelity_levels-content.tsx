"use client";

import { useCallback, useEffect, useState } from "react";
import { flashNavigate } from "./flash";

// Faithful port of the PHP "Livelli Card" editor (fidelity_points.php#livelli-card
// + fidelity_points.js, che posta a index.php?page=fidelity_levels _mode=save_levels).
// Flusso legacy completo: validazione client-side verbatim, preview firma per le
// MODIFICHE SOGLIA (modal 'Modifica livello card'), preview impatto per l'ELIMINAZIONE
// (modal 'Elimina livello card' con accordion clienti/campagne/promozioni/omaggi e
// token fidelity_delete_confirmed[]), righe con hint d'uso 'N clienti hanno questo
// livello', base identificato dal PRIMO livello a 0 punti (non eliminabile, punti
// bloccati), label punti configurabile; successo/errore server via redirect flash
// su fidelity_points (msg / 'Errore salvataggio livelli card: ...').

type ApiLevel = { key: string; name: string; minPoints: number };
type EditorPayload = {
  levels: ApiLevel[];
  baseKey: string;
  usage: Record<string, number>;
  label: string;
};

type Row = {
  key: string; // key persistita ('' per righe nuove)
  name: string;
  points: string;
  baseLevel: boolean;
  usage: number;
};

type DeleteImpact = {
  clients?: { count?: number; next_levels?: Record<string, { name?: string; count?: number }> };
  campaigns?: { updated?: number; disabled?: number };
  promotions?: { updated?: number; disabled?: number; appointments?: number };
  gifts?: { updated?: number; disabled?: number };
};

type ThresholdImpact = {
  changes?: Array<{ key?: string; name?: string; old?: number; new?: number }>;
  signature?: string;
  clients?: { changed?: number; same?: number; moved_up?: number; moved_down?: number };
  links?: { campaigns?: number; promotions?: number; gifts?: number; giftboxes?: number; open_appointments?: number };
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

const num = (v: unknown): number => {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
};

// fmtPts del JS legacy: toLocaleString it-IT max 2 decimali.
function fmtPts(v: unknown): string {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

export function FidelityLevelsContent({ slug: slugProp, embedded = false }: { slug?: string; embedded?: boolean } = {}) {
  const slug = slugProp || tenantSlug();

  const [rows, setRows] = useState<Row[]>([]);
  const [label, setLabel] = useState("Punti");
  const [inlineError, setInlineError] = useState("");
  const [saving, setSaving] = useState(false);
  // Token di conferma eliminazione accumulati (come gli hidden input legacy).
  const [deleteTokens, setDeleteTokens] = useState<string[]>([]);

  // Modal eliminazione (fidelityLevelDeletePreviewModal).
  const [deleteModal, setDeleteModal] = useState<{ rowIdx: number; name: string; token: string; loading: boolean; impact: DeleteImpact | null; error: string; showWarning: boolean } | null>(null);
  // Modal soglie (fidelityLevelThresholdPreviewModal).
  const [thresholdModal, setThresholdModal] = useState<{ impact: ThresholdImpact; subtitle: string } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=levels`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const payload = (j?.levels ?? {}) as EditorPayload;
        const bk = String(payload.baseKey ?? "base");
        const usage = payload.usage ?? {};
        const apiLevels = Array.isArray(payload.levels) ? payload.levels : [];
        setLabel(String(payload.label ?? "Punti"));
        setRows(
          (apiLevels.length > 0 ? apiLevels : [{ key: "base", name: "Base", minPoints: 0 }]).map((l) => ({
            key: l.key,
            name: l.name,
            points: l.key === bk ? "0" : fmtIntForInput(l.minPoints),
            baseLevel: l.key === bk,
            usage: num(usage[l.key]),
          })),
        );
        setDeleteTokens([]);
      })
      .catch(() => undefined);
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function fmtIntForInput(v: number): string {
    return String(Math.trunc(Number(v) || 0));
  }

  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setInlineError("");
  }

  function addRow() {
    setRows((prev) => [...prev, { key: "", name: "", points: "", baseLevel: false, usage: 0 }]);
    setInlineError("");
  }

  // validateLevelsBeforePreview (fidelity_points.js) — messaggi verbatim.
  function validateBeforePreview(): string {
    const pointsMap = new Set<string>();
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const row = next[i];
      let name = row.name.trim();
      if (row.baseLevel && name === "") {
        next[i] = { ...row, name: "Base" };
        name = "Base";
      }
      if (!name) continue;
      const raw = String(row.baseLevel ? "0" : row.points || "0").replace(",", ".");
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return "Inserisci un valore valido nei punti necessari.";
      const key = n.toFixed(2);
      if (!row.baseLevel && Math.abs(n) < 0.0000001) return "Solo il livello base predefinito puo avere 0 punti.";
      if (pointsMap.has(key)) return "Non puoi salvare due livelli card con gli stessi punti necessari.";
      pointsMap.add(key);
    }
    setRows(next);
    return "";
  }

  function levelsBody(): Record<string, unknown> {
    // Array come stringhe JSON: parseRequestBody appiattirebbe gli array reali
    // in CSV (rompendo i nomi con virgola).
    return {
      fidelity_levels_enabled: "1",
      fidelity_levels_points_enabled: "1",
      fidelity_points_level_keys: JSON.stringify(rows.map((r) => r.key)),
      fidelity_points_level_names: JSON.stringify(rows.map((r) => r.name)),
      fidelity_points_level_points: JSON.stringify(rows.map((r) => (r.baseLevel ? "0" : r.points))),
      fidelity_delete_confirmed: JSON.stringify(deleteTokens),
    };
  }

  async function postFidelity(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-slug": slug },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j?.ok === false) throw new Error(String(j?.error ?? "Preview non disponibile."));
    return j;
  }

  // showDeletePreview (fidelity_points.js): preview impatto poi conferma.
  async function openDeletePreview(idx: number) {
    const row = rows[idx];
    const token = row.key ? `points:${row.key.toLowerCase()}` : "";
    if (!token) {
      // Riga nuova mai salvata: rimozione diretta (come il JS).
      setRows((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    const name = row.name.trim() || "Livello";
    setDeleteModal({ rowIdx: idx, name, token, loading: true, impact: null, error: "", showWarning: true });
    try {
      const j = await postFidelity({
        action: "preview_level_delete",
        _mode: "preview_fidelity_level_delete",
        level_token: token,
        delete_tokens: [...new Set([...deleteTokens, token])],
      });
      const impact = (j.impact ?? {}) as DeleteImpact;
      const totalImpact =
        num(impact.clients?.count) +
        num(impact.campaigns?.updated) + num(impact.campaigns?.disabled) +
        num(impact.promotions?.updated) + num(impact.promotions?.disabled) + num(impact.promotions?.appointments) +
        num(impact.gifts?.updated) + num(impact.gifts?.disabled);
      setDeleteModal((m) => (m ? { ...m, loading: false, impact, showWarning: totalImpact > 0 } : m));
    } catch (e) {
      setDeleteModal((m) => (m ? { ...m, loading: false, error: e instanceof Error ? e.message : "Errore non previsto", showWarning: false } : m));
    }
  }

  function confirmDelete() {
    if (!deleteModal) return;
    setDeleteTokens((prev) => (prev.includes(deleteModal.token) ? prev : [...prev, deleteModal.token]));
    setRows((prev) => prev.filter((_, i) => i !== deleteModal.rowIdx));
    setDeleteModal(null);
  }

  // showThresholdPreview (fidelity_points.js): valida, chiede l'impatto e apre
  // la modal; senza modifiche soglia salva direttamente.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInlineError("");
    const validationError = validateBeforePreview();
    if (validationError) {
      setInlineError(validationError);
      return;
    }
    try {
      const j = await postFidelity({ action: "preview_level_thresholds", _mode: "preview_fidelity_level_thresholds", ...levelsBody() });
      const impact = (j.impact ?? {}) as ThresholdImpact;
      const changes = Array.isArray(impact.changes) ? impact.changes : [];
      if (changes.length === 0) {
        await saveLevels("");
        return;
      }
      const signature = String(impact.signature ?? "");
      if (!signature) throw new Error("Firma conferma non disponibile.");
      setThresholdModal({ impact, subtitle: changes.length === 1 ? "1 livello modificato" : `${changes.length} livelli modificati` });
    } catch (err) {
      setInlineError(err instanceof Error && err.message ? err.message : "Impossibile calcolare il riepilogo. Controlla i livelli card e riprova.");
    }
  }

  async function saveLevels(signature: string) {
    setSaving(true);
    try {
      const j = await postFidelity({
        action: "save_levels",
        _mode: "save_levels",
        ...levelsBody(),
        ...(signature ? { fidelity_threshold_change_confirmed: signature } : {}),
      });
      const msg = String((j.levels as { message?: string } | undefined)?.message ?? j.message ?? "Livelli Card salvati");
      // Redirect flash legacy su fidelity_points.
      flashNavigate(`/${encodeURIComponent(slug)}/fidelity_points`, { msg });
    } catch (err) {
      const msg = `Errore salvataggio livelli card: ${err instanceof Error ? err.message : "Errore non previsto"}`;
      flashNavigate(`/${encodeURIComponent(slug)}/fidelity_points`, { err: msg });
    } finally {
      setSaving(false);
    }
  }

  // renderSummary (fidelity_points.js): accordion impatto eliminazione.
  function renderDeleteImpact(impact: DeleteImpact) {
    const clients = impact.clients ?? {};
    const campaigns = impact.campaigns ?? {};
    const promotions = impact.promotions ?? {};
    const gifts = impact.gifts ?? {};
    const clientCount = num(clients.count);
    const campaignTotal = num(campaigns.updated) + num(campaigns.disabled);
    const promoTotal = num(promotions.updated) + num(promotions.disabled) + num(promotions.appointments);
    const giftTotal = num(gifts.updated) + num(gifts.disabled);
    const totalImpact = clientCount + campaignTotal + promoTotal + giftTotal;

    if (!totalImpact) {
      return (
        <div className="py-2">
          <div className="h6 fw-semibold mb-2">Sei sicuro di eliminare questo livello?</div>
          <div className="text-muted small">
            Il livello verra rimosso dalla lista e la modifica sara applicata solo dopo <strong>Salva livelli</strong>.
          </div>
        </div>
      );
    }

    const nextLevels = clients.next_levels ?? {};
    const section = (id: string, title: string, count: number, body: React.ReactNode) => (
      <div className="accordion-item border rounded-3 overflow-hidden mb-2" key={id}>
        <h3 className="accordion-header" id={`${id}Head`}>
          <button
            className="accordion-button collapsed bg-white shadow-none py-2"
            type="button"
            data-bs-toggle="collapse"
            data-bs-target={`#${id}`}
            aria-expanded="false"
            aria-controls={id}
          >
            <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
              <span className="fw-semibold">{title}</span>
              <span className="badge rounded-pill text-bg-info">{count}</span>
            </span>
          </button>
        </h3>
        <div id={id} className="accordion-collapse collapse" aria-labelledby={`${id}Head`} data-bs-parent="#fidelityLevelDeletePreviewAccordion">
          <div className="accordion-body py-2">{body}</div>
        </div>
      </div>
    );

    const sections: React.ReactNode[] = [];
    if (clientCount > 0) {
      sections.push(section(
        "fidLevelImpactClients",
        "Clienti ricalcolati",
        clientCount,
        Object.entries(nextLevels).map(([key, item]) => (
          <div className="small text-muted" key={key}>
            {num(item?.count)} clienti → {String(item?.name ?? "Livello base")}
          </div>
        )),
      ));
    }
    if (campaignTotal > 0) {
      sections.push(section("fidLevelImpactCampaigns", "Campagne punti", campaignTotal, (
        <>
          {num(campaigns.updated) > 0 ? <div className="small">Aggiornate: <strong>{num(campaigns.updated)}</strong></div> : null}
          {num(campaigns.disabled) > 0 ? <div className="small">Disattivate: <strong>{num(campaigns.disabled)}</strong></div> : null}
        </>
      )));
    }
    if (promoTotal > 0) {
      sections.push(section("fidLevelImpactPromotions", "Promozioni", promoTotal, (
        <>
          {num(promotions.updated) > 0 ? <div className="small">Aggiornate: <strong>{num(promotions.updated)}</strong></div> : null}
          {num(promotions.disabled) > 0 ? <div className="small">Disattivate: <strong>{num(promotions.disabled)}</strong></div> : null}
          {num(promotions.appointments) > 0 ? <div className="small">Prenotazioni aperte aggiornate: <strong>{num(promotions.appointments)}</strong></div> : null}
        </>
      )));
    }
    if (giftTotal > 0) {
      sections.push(section("fidLevelImpactGifts", "Omaggi", giftTotal, (
        <>
          {num(gifts.updated) > 0 ? <div className="small">Aggiornati: <strong>{num(gifts.updated)}</strong></div> : null}
          {num(gifts.disabled) > 0 ? <div className="small">Disattivati: <strong>{num(gifts.disabled)}</strong></div> : null}
        </>
      )));
    }

    return <div className="accordion" id="fidelityLevelDeletePreviewAccordion">{sections}</div>;
  }

  // renderThresholdPreview (fidelity_points.js).
  function renderThresholdImpact(impact: ThresholdImpact) {
    const changes = Array.isArray(impact.changes) ? impact.changes : [];
    const clients = impact.clients ?? {};
    const links = impact.links ?? {};
    const changed = num(clients.changed);
    const linked: React.ReactNode[] = [];
    if (num(links.campaigns) > 0) linked.push(<span key="c">Campagne punti: <strong>{num(links.campaigns)}</strong></span>);
    if (num(links.promotions) > 0) linked.push(<span key="p">Promozioni: <strong>{num(links.promotions)}</strong></span>);
    if (num(links.gifts) > 0) linked.push(<span key="g">Omaggi: <strong>{num(links.gifts)}</strong></span>);
    if (num(links.giftboxes) > 0) linked.push(<span key="gb">GiftBox: <strong>{num(links.giftboxes)}</strong></span>);
    if (num(links.open_appointments) > 0) linked.push(<span key="oa">Prenotazioni aperte collegate a promozioni: <strong>{num(links.open_appointments)}</strong></span>);

    return (
      <>
        <div className="mb-3">
          <div className="fw-semibold mb-2">Soglie modificate</div>
          <div className="d-flex flex-column gap-2">
            {changes.map((ch, i) => (
              <div className="d-flex justify-content-between align-items-center gap-3 border rounded-3 bg-white px-3 py-2" key={i}>
                <div className="fw-semibold">{String(ch.name || ch.key || "Livello")}</div>
                <div className="small text-muted text-nowrap">
                  {fmtPts(ch.old)} → <strong className="text-body">{fmtPts(ch.new)}</strong> punti
                </div>
              </div>
            ))}
          </div>
        </div>
        {changed > 0 ? (
          <div className="row g-2 mb-3">
            <div className="col-12 col-md-4"><div className="border rounded-3 bg-white px-3 py-2"><div className="small text-muted">Clienti ricalcolati</div><div className="fw-semibold">{changed}</div></div></div>
            <div className="col-6 col-md-4"><div className="border rounded-3 bg-white px-3 py-2"><div className="small text-muted">Salgono</div><div className="fw-semibold text-success">{num(clients.moved_up)}</div></div></div>
            <div className="col-6 col-md-4"><div className="border rounded-3 bg-white px-3 py-2"><div className="small text-muted">Scendono</div><div className="fw-semibold text-warning">{num(clients.moved_down)}</div></div></div>
          </div>
        ) : (
          <div className="alert alert-info mb-3">
            <div className="fw-semibold mb-1">Nessun cliente cambia livello</div>
            <div className="small">
              Le soglie cambiano, ma con i punti attuali nessun cliente aderente verrebbe spostato. Clienti invariati: {num(clients.same)}.
            </div>
          </div>
        )}
        {linked.length > 0 ? (
          <div className="border rounded-3 bg-white px-3 py-2">
            <div className="fw-semibold mb-1">Regole collegate</div>
            <div className="small text-muted mb-2">Queste regole restano collegate allo stesso livello, ma useranno la nuova soglia.</div>
            <div className="small">{linked.map((l, i) => <span key={i}>{l}{i < linked.length - 1 ? <br /> : null}</span>)}</div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={embedded ? "" : "container-fluid"}>
      <div className={`card p-4 mt-3 fidCampaignsCard`} id="livelli-card" data-levels-card="1">
        <form method="post" className="row g-3" id="fidLevelsInlineForm" onSubmit={handleSubmit}>
          <input type="hidden" name="_mode" value="save_levels" />
          <input type="hidden" name="return_page" value="fidelity_points" />
          <input type="hidden" name="fidelity_levels_enabled" value="1" />
          <input type="hidden" name="fidelity_levels_points_enabled" value="1" />
          {deleteTokens.map((t) => (
            <input type="hidden" name="fidelity_delete_confirmed[]" value={t} key={t} />
          ))}

          <div className="col-12 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
            <div>
              <div className="h5 fw-bold m-0">Livelli Card</div>
              <div className="text-muted small">Definisci i livelli usati dalle campagne punti e dai vantaggi Fidelity.</div>
            </div>
          </div>

          <div className="col-12">
            <div className={`alert alert-danger mb-0${inlineError ? "" : " d-none"}`} id="fidLevelsInlineError" role="alert">
              {inlineError}
            </div>
          </div>

          <div className="col-12">
            <div id="fidPointsLevelsList" className="d-flex flex-column gap-2">
              {rows.map((row, idx) => (
                <div
                  className="row g-2 align-items-end fidPointsLevelRow"
                  key={`${row.key}-${idx}`}
                  data-level-family="points"
                  data-level-key={row.key}
                  data-level-name={row.name}
                  data-base-level={row.baseLevel ? "1" : "0"}
                >
                  <input type="hidden" name="fidelity_points_level_keys[]" value={row.key} />

                  <div className="col-md-5">
                    <label className="form-label">Nome livello</label>
                    <input
                      className="form-control"
                      name="fidelity_points_level_names[]"
                      value={row.name}
                      placeholder={row.baseLevel ? "Es. Base" : "Es. Gold"}
                      onChange={(e) => updateRow(idx, { name: e.target.value })}
                    />
                  </div>

                  {row.baseLevel ? (
                    <>
                      <input type="hidden" name="fidelity_points_level_points[]" value="0" />
                      <div className="col-md-7">
                        <div className="form-text text-muted mb-2">
                          Livello base predefinito: non eliminabile, punti bloccati a 0. Puoi modificare solo il nome.
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="col-md-6">
                        <label className="form-label">Punti necessari</label>
                        <div className="input-group">
                          <input
                            className="form-control"
                            type="number"
                            min="0"
                            step="1"
                            name="fidelity_points_level_points[]"
                            value={row.points}
                            placeholder="Es. 200"
                            onChange={(e) => updateRow(idx, { points: e.target.value })}
                          />
                          <span className="input-group-text">{label}</span>
                        </div>
                      </div>

                      <div className="col-md-1 d-grid">
                        <button
                          type="button"
                          className="btn btn-outline-danger btn-sm fidPointsLevelRemove"
                          title="Rimuovi"
                          onClick={() => void openDeletePreview(idx)}
                        >
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>

                      {row.usage > 0 ? (
                        <div className="col-12 col-md-6 offset-md-5">
                          <div className="form-text text-muted mt-0">
                            {row.usage === 1 ? "1 cliente ha" : `${row.usage} clienti hanno`} questo livello. Se cambi i punti, ti verra richiesto un riepilogo prima del salvataggio.
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="col-12 d-flex flex-wrap gap-2">
            <button type="button" className="btn btn-outline-primary btn-sm" id="fidPointsLevelAdd" onClick={addRow}>
              <i className="bi bi-plus-lg me-1" />
              Aggiungi livello
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              Salva livelli
            </button>
          </div>
        </form>
      </div>

      {deleteModal ? (
        <>
          <div className="modal fade show d-block" id="fidelityLevelDeletePreviewModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1" id="fidelityLevelDeletePreviewModalLabel">Elimina livello card</h5>
                    <div className="text-muted small" id="fidelityLevelDeletePreviewSubtitle">Livello: {deleteModal.name}</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeleteModal(null)} />
                </div>
                <div className="modal-body">
                  {deleteModal.showWarning ? (
                    <div className="alert alert-warning mb-3" id="fidelityLevelDeletePreviewWarning">
                      <div className="fw-semibold mb-1">Riepilogo impatto</div>
                      <div className="small">
                        La rimozione sara applicata solo quando premi <strong>Salva livelli</strong>. Punti, movimenti e
                        storico clienti non verranno cancellati.
                      </div>
                    </div>
                  ) : null}
                  <div id="fidelityLevelDeletePreviewBody">
                    {deleteModal.loading ? (
                      <div className="text-muted">Calcolo impatto in corso...</div>
                    ) : deleteModal.error ? (
                      <div className="alert alert-danger mb-0">
                        <div className="fw-semibold mb-1">Impossibile calcolare il riepilogo completo</div>
                        <div className="small">{deleteModal.error}</div>
                      </div>
                    ) : deleteModal.impact ? (
                      renderDeleteImpact(deleteModal.impact)
                    ) : null}
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setDeleteModal(null)}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-pill"
                    id="fidelityLevelDeletePreviewConfirm"
                    disabled={deleteModal.loading || !!deleteModal.error}
                    onClick={confirmDelete}
                  >
                    <i className="bi bi-x-lg me-1" />
                    Rimuovi livello
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {thresholdModal ? (
        <>
          <div className="modal fade show d-block" id="fidelityLevelThresholdPreviewModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1" id="fidelityLevelThresholdPreviewModalLabel">Modifica livello card</h5>
                    <div className="text-muted small" id="fidelityLevelThresholdPreviewSubtitle">{thresholdModal.subtitle}</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setThresholdModal(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning mb-3">
                    <div className="fw-semibold mb-1">Riepilogo impatto</div>
                    <div className="small">
                      La modifica dei punti necessari sara applicata solo quando premi <strong>Conferma e salva</strong>.
                      Punti, movimenti e storico clienti non verranno cancellati.
                    </div>
                  </div>
                  <div id="fidelityLevelThresholdPreviewBody">{renderThresholdImpact(thresholdModal.impact)}</div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setThresholdModal(null)}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-pill"
                    id="fidelityLevelThresholdPreviewConfirm"
                    disabled={saving}
                    onClick={() => {
                      const signature = String(thresholdModal.impact.signature ?? "");
                      setThresholdModal(null);
                      void saveLevels(signature);
                    }}
                  >
                    <i className="bi bi-check2-circle me-1" />
                    Conferma e salva
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
