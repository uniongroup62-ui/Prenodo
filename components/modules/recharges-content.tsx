"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP recharges page (app/pages/recharges.php +
// assets/js/pages/recharges.js). "Modelli di ricarica" (tabella + modal
// crea/modifica + elimina con confirm legacy) su /api/manage/recharges.
// Flussi legacy: successo via redirect flash ?msg (Modello creato./aggiornato./
// eliminato.), errori del POST come alert danger a inizio pagina (il POST
// full-page legacy chiude la modal e renderizza $err in alto); earn_points
// gated dalla Fidelity generale con l'avviso verbatim; bonus_value disabilitato
// e azzerato con bonus 'none'; formati fmt_money/fmt_points.

type RechargeTemplate = {
  id: number;
  title: string;
  baseAmount: number;
  bonusKind: "none" | "percent" | "fixed";
  bonusValue: number;
  bonusAmount: number;
  totalAmount: number;
  earnPoints: boolean;
  isActive: boolean;
  sortOrder: number;
};

type RechargesResponse = {
  ok?: boolean;
  fidelityEnabled?: boolean;
  activeCampaignName?: string;
  earnStep?: number;
  label?: string;
  templates?: RechargeTemplate[];
};

type ModalForm = {
  id: number;
  title: string;
  base_amount: string;
  bonus_kind: "none" | "percent" | "fixed";
  bonus_value: string;
  sort_order: string;
  earn_points: boolean;
  is_active: boolean;
};

type RechargesQuery = { msg?: string; err?: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Port of fmt_money (number_format 2, ',', '.').
function fmtMoney(value: number): string {
  const v = Number(value || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// Port of fmt_points(): intero troncato verso zero, '0' fallback.
function fmtPoints(value: number): string {
  const v = Number(value || 0);
  if (!Number.isFinite(v) || Math.abs(v) < 0.0000001) return "0";
  return String(v > 0 ? Math.floor(v + 0.000000001) : Math.ceil(v - 0.000000001));
}

// Port di $bonusLabel: percent -> fmt_points+'%', fixed -> '€ '+fmt_money, none '—'.
function bonusLabel(t: RechargeTemplate): string {
  if (t.bonusKind === "percent") return `${fmtPoints(t.bonusValue)}%`;
  if (t.bonusKind === "fixed") return `€ ${fmtMoney(t.bonusValue)}`;
  return "—";
}

function emptyModalForm(fidelityEnabled: boolean): ModalForm {
  return {
    id: 0,
    title: "",
    base_amount: "",
    bonus_kind: "none",
    bonus_value: "0",
    sort_order: "0",
    earn_points: fidelityEnabled,
    is_active: true,
  };
}

export function RechargesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: RechargesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [templates, setTemplates] = useState<RechargeTemplate[]>([]);
  const [fidelityEnabled, setFidelityEnabled] = useState(true);
  const [activeCampaignName, setActiveCampaignName] = useState("");
  const [label, setLabel] = useState("Punti");
  const [loading, setLoading] = useState(true);

  // Flash legacy via redirect ?msg; gli errori del POST restano in pagina.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [pageError, setPageError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState<ModalForm>(emptyModalForm(true));
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/recharges?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: RechargesResponse) => {
        setTemplates(Array.isArray(j.templates) ? j.templates : []);
        setFidelityEnabled(j.fidelityEnabled !== false);
        setActiveCampaignName(String(j.activeCampaignName ?? ""));
        setLabel(String(j.label ?? "Punti"));
      })
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof ModalForm>(key: K, value: ModalForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openCreate() {
    setModalMode("create");
    setForm(emptyModalForm(fidelityEnabled));
    setModalOpen(true);
  }

  function openEdit(t: RechargeTemplate) {
    setModalMode("edit");
    // Prefill legacy data-*: importi con 2 decimali (number_format '.', '').
    setForm({
      id: t.id,
      title: t.title,
      base_amount: t.baseAmount.toFixed(2),
      bonus_kind: t.bonusKind,
      bonus_value: t.bonusValue.toFixed(2),
      sort_order: String(t.sortOrder),
      earn_points: t.earnPoints,
      is_active: t.isActive,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setSaving(false);
  }

  function redirectFlash(msg: string) {
    window.location.href = `/${encodeURIComponent(slug)}/recharges?msg=${encodeURIComponent(msg)}`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setPageError(null);
    try {
      const payload: Record<string, unknown> = {
        action: modalMode === "edit" ? "update_template" : "create_template",
        template_id: String(form.id),
        title: form.title,
        base_amount: form.base_amount,
        bonus_kind: form.bonus_kind,
        bonus_value: form.bonus_kind === "none" ? "0" : form.bonus_value,
        sort_order: form.sort_order,
        earn_points: form.earn_points ? "1" : "0",
        is_active: form.is_active ? "1" : "0",
      };
      const res = await fetch(`/api/manage/recharges?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        // Come il POST full-page legacy: modal chiusa, errore in alto.
        closeModal();
        setPageError(String(j?.error ?? "Errore nel salvataggio del modello."));
        window.scrollTo(0, 0);
        return;
      }
      redirectFlash(String(j?.message ?? (modalMode === "edit" ? "Modello aggiornato." : "Modello creato.")));
    } catch {
      closeModal();
      setPageError("Errore di rete.");
    }
  }

  async function onDelete(t: RechargeTemplate) {
    // Confirm verbatim di recharges.js.
    if (typeof window !== "undefined" && !window.confirm(`Eliminare il modello: ${t.title}?`)) return;
    setPageError(null);
    try {
      const res = await fetch(`/api/manage/recharges?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete_template", template_id: String(t.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setPageError(String(j?.error ?? "Errore nell'eliminazione del modello."));
        window.scrollTo(0, 0);
        return;
      }
      redirectFlash(String(j?.message ?? "Modello eliminato."));
    } catch {
      setPageError("Errore di rete.");
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/recharges.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma punti</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Ricariche</h1>
            <InfoBox>
              <p>
                Il modello di ricarica velocizza le ricariche credito in <strong>Pagamenti</strong> mantenendo sempre la
                stessa struttura commerciale: <strong>Ricarica</strong> (importo pagato dal cliente) +{" "}
                <strong>Bonus</strong> (credito extra secondo la regola del modello) = <strong>Totale</strong>{" "}
                accreditato sul portafoglio.
              </p>
              <ul>
                <li>Solo i modelli <strong>attivi</strong> compaiono in Pagamenti.</li>
                <li>
                  I punti Fidelity possono maturare su importo + bonus oppure sul solo importo, in base
                  all&apos;impostazione del modello.
                </li>
                <li>
                  Questa pagina gestisce solo i <strong>modelli</strong>: le ricariche si emettono esclusivamente dalla
                  pagina Pagamenti; gli storni si gestiscono dai movimenti credito.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Gestisci credito prepagato, bonus e campagne punti.</div>
        </div>
        <div className="bs-page-actions">
          <div className="text-muted small">
            {!fidelityEnabled ? (
              "Punti disattivati"
            ) : activeCampaignName ? (
              <>
                Campagna attiva: <strong>{activeCampaignName}</strong>
              </>
            ) : (
              "Nessuna campagna punti attiva oggi"
            )}
          </div>
        </div>
      </div>

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err || pageError ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{pageError ?? flash.err}</div>
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-12">
          <div className="card p-3 h-100">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <div className="fw-semibold">Modelli di ricarica</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={openCreate}>
                <i className="bi bi-plus" /> Nuovo modello
              </button>
            </div>
            <div className="text-muted small mb-2">
              I modelli ti aiutano a creare ricariche standard (es. 100€ + 20€ bonus) e vengono usati dalla pagina{" "}
              <strong>Pagamenti</strong> per aggiungere rapidamente una ricarica al carrello.
            </div>

            <div className="table-responsive">
              <table className="table table-sm mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Titolo</th>
                    <th className="text-end">Ricarica</th>
                    <th className="text-end">Bonus</th>
                    <th className="text-end">Totale</th>
                    <th className="text-end">Calcolo punti</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-2">
                        {loading ? "Caricamento…" : "Nessun modello."}
                      </td>
                    </tr>
                  ) : (
                    templates.map((t) => (
                      <tr key={t.id} className={t.isActive ? "" : "table-light"}>
                        <td>
                          <div className="fw-semibold">{t.title}</div>
                          {t.isActive ? null : <div className="small text-muted">Disattivo</div>}
                        </td>
                        <td className="text-end">€ {fmtMoney(t.baseAmount)}</td>
                        <td className="text-end text-muted">{bonusLabel(t)}</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(t.totalAmount)}</td>
                        <td className="text-end text-muted">{t.earnPoints ? "Importo + bonus" : "Solo importo"}</td>
                        <td className="text-end">
                          <div className="d-inline-flex gap-2">
                            <button className="btn btn-sm btn-outline-warning" type="button" title="Modifica" onClick={() => openEdit(t)}>
                              <i className="bi bi-pencil" />
                            </button>
                            <button className="btn btn-sm btn-outline-danger" type="button" title="Elimina" onClick={() => onDelete(t)}>
                              <i className="bi bi-trash" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>

      {/* Modal: Crea/Modifica modello */}
      {modalOpen ? (
        <>
          <div className="modal fade show d-block" id="templateModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg">
              <div className="modal-content">
                <form method="post" id="templateForm" onSubmit={onSubmit}>
                  <input type="hidden" name="_mode" id="template_mode" value={modalMode === "edit" ? "update_template" : "create_template"} />
                  <input type="hidden" name="template_id" id="template_id_field" value={form.id > 0 ? String(form.id) : ""} />

                  <div className="modal-header">
                    <h5 className="modal-title" id="templateModalTitle">
                      {modalMode === "edit" ? "Modifica modello" : "Nuovo modello"}
                    </h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={closeModal} />
                  </div>

                  <div className="modal-body">
                    <div className="row g-3">
                      <div className="col-12">
                        <label className="form-label fw-semibold">Titolo</label>
                        <input
                          className="form-control"
                          name="title"
                          id="t_title"
                          placeholder="Es. Ricarica 100 + 20"
                          required
                          value={form.title}
                          onChange={(e) => set("title", e.target.value)}
                        />
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Importo ricarica</label>
                        <div className="input-group">
                          <span className="input-group-text">€</span>
                          <input
                            className="form-control"
                            type="number"
                            step="0.01"
                            min="0.01"
                            max="99999999.99"
                            name="base_amount"
                            id="t_base_amount"
                            required
                            value={form.base_amount}
                            onChange={(e) => set("base_amount", e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Bonus</label>
                        <div className="input-group">
                          <select
                            className="form-select recharge-bonus-kind-select"
                            name="bonus_kind"
                            id="t_bonus_kind"
                            value={form.bonus_kind}
                            onChange={(e) => {
                              const kind = e.target.value as ModalForm["bonus_kind"];
                              // recharges.js: kind 'none' disabilita e azzera il valore.
                              setForm((prev) => ({ ...prev, bonus_kind: kind, bonus_value: kind === "none" ? "0" : prev.bonus_value }));
                            }}
                          >
                            <option value="none">Nessuno</option>
                            <option value="percent">% su importo</option>
                            <option value="fixed">€ fisso</option>
                          </select>
                          <input
                            className="form-control"
                            type="number"
                            step="0.01"
                            min="0"
                            max="99999999.99"
                            name="bonus_value"
                            id="t_bonus_value"
                            value={form.bonus_value}
                            disabled={form.bonus_kind === "none"}
                            onChange={(e) => set("bonus_value", e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Ordinamento</label>
                        <input
                          className="form-control"
                          type="number"
                          step="1"
                          name="sort_order"
                          id="t_sort_order"
                          value={form.sort_order}
                          onChange={(e) => set("sort_order", e.target.value)}
                        />
                        <div className="form-text">Più basso = più in alto.</div>
                      </div>

                      <div className="col-md-6">
                        <div className="form-check">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            value="1"
                            name="earn_points"
                            id="t_earn_points"
                            checked={form.earn_points}
                            disabled={!fidelityEnabled}
                            aria-describedby="t_earn_points_help"
                            onChange={(e) => set("earn_points", e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor="t_earn_points">
                            Calcola i punti anche sul bonus (importo + bonus)
                          </label>
                        </div>
                        <div className="form-text" id="t_earn_points_help">
                          Se attivo, i {label} saranno calcolati su <strong>importo + bonus</strong>. Se disattivo, verranno
                          calcolati <strong>solo sull&apos;importo ricarica</strong>.
                          {!fidelityEnabled ? (
                            <span className="text-warning d-block mt-1">
                              Disponibile solo con la Fidelity generale attiva. Con Fidelity disattivata i nuovi modelli non
                              possono attivare questa opzione.
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="col-md-6">
                        <div className="form-check">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            value="1"
                            name="is_active"
                            id="t_is_active"
                            checked={form.is_active}
                            onChange={(e) => set("is_active", e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor="t_is_active">
                            Modello attivo
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={closeModal}>
                      Annulla
                    </button>
                    <button className="btn btn-primary" type="submit" disabled={saving}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
