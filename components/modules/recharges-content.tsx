"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP recharges page (app/pages/recharges.php +
// assets/js/pages/recharges.js). The "Modelli di ricarica" table + its
// create/edit modal + delete are now DB-backed by /api/manage/recharges
// (recharge_templates CRUD). The modal mirrors the legacy Bootstrap markup and
// behaviour: data-mode create/edit prefill, bonus-kind enables/disables the
// bonus value input, earn_points gated by the fidelity general flag.

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

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtEuro(n: number): string {
  return `€ ${(Number.isFinite(n) ? n : 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bonusLabel(t: RechargeTemplate): string {
  if (t.bonusKind === "percent") return `${t.bonusValue}%`;
  if (t.bonusKind === "fixed") return fmtEuro(t.bonusValue);
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

export function RechargesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [templates, setTemplates] = useState<RechargeTemplate[]>([]);
  const [fidelityEnabled, setFidelityEnabled] = useState(true);
  const [activeCampaignName, setActiveCampaignName] = useState("");
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState<ModalForm>(emptyModalForm(true));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/recharges?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: RechargesResponse) => {
        setTemplates(Array.isArray(j.templates) ? j.templates : []);
        setFidelityEnabled(j.fidelityEnabled !== false);
        setActiveCampaignName(String(j.activeCampaignName ?? ""));
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
    setError("");
    setModalMode("create");
    setForm(emptyModalForm(fidelityEnabled));
    setModalOpen(true);
  }

  function openEdit(t: RechargeTemplate) {
    setError("");
    setModalMode("edit");
    setForm({
      id: t.id,
      title: t.title,
      base_amount: String(t.baseAmount),
      bonus_kind: t.bonusKind,
      bonus_value: String(t.bonusValue),
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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (form.title.trim() === "") {
      setError("Inserisci un titolo per il modello.");
      return;
    }
    const base = Number.parseFloat(form.base_amount.replace(",", "."));
    if (!Number.isFinite(base) || base <= 0) {
      setError("Inserisci un importo ricarica valido.");
      return;
    }
    setSaving(true);
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
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del modello."));
        setSaving(false);
        return;
      }
      setTemplates(Array.isArray(j.templates) ? j.templates : []);
      closeModal();
    } catch {
      setError("Errore nel salvataggio del modello.");
      setSaving(false);
    }
  }

  async function onDelete(t: RechargeTemplate) {
    if (typeof window !== "undefined" && !window.confirm(`Eliminare il modello "${t.title}"?`)) return;
    try {
      const res = await fetch(`/api/manage/recharges?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete_template", template_id: String(t.id) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) return;
      setTemplates(Array.isArray(j.templates) ? j.templates : []);
    } catch {
      // best-effort; reload to resync
      load();
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/recharges.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma punti</div>
          <h1 className="bs-page-title">Ricariche</h1>
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

      <div className="row g-3">
        <div className="col-lg-7">
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
                        <td className="text-end">{fmtEuro(t.baseAmount)}</td>
                        <td className="text-end text-muted">{bonusLabel(t)}</td>
                        <td className="text-end fw-semibold">{fmtEuro(t.totalAmount)}</td>
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

        <div className="col-lg-5">
          <div className="recharges-info-box h-100">
            <div className="recharges-info-box__icon" aria-hidden="true">
              <i className="bi bi-info-circle" />
            </div>
            <div className="recharges-info-box__body">
              <div className="recharges-info-box__title">Come funziona il modello di ricarica</div>
              <div className="recharges-info-box__text">
                Il modello serve per velocizzare le ricariche credito dalla pagina <strong>Pagamenti</strong> mantenendo
                sempre la stessa struttura commerciale.
              </div>
              <ul className="recharges-info-box__list mb-0">
                <li>
                  <strong>Ricarica</strong>: è l&apos;importo pagato dal cliente alla cassa.
                </li>
                <li>
                  <strong>Bonus</strong>: è il credito extra aggiunto al wallet del cliente secondo la regola scelta nel
                  modello.
                </li>
                <li>
                  <strong>Totale</strong>: è il credito finale caricato sul cliente, dato da{" "}
                  <strong>ricarica + bonus</strong>.
                </li>
                <li>
                  Se il modello è attivo, sarà disponibile in <strong>Pagamenti</strong> per aggiungerlo rapidamente al
                  carrello.
                </li>
                <li>
                  Il calcolo dei <strong>Punti</strong> può avvenire su <strong>importo + bonus</strong> oppure sul{" "}
                  <strong>solo importo ricarica</strong>, in base all&apos;impostazione del modello.
                </li>
                <li>
                  Il cliente riceve il credito sul wallet al momento della vendita; eventuali storni vanno gestiti dai
                  movimenti credito.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Crea/Modifica modello */}
      <div
        className={`modal fade${modalOpen ? " show d-block" : ""}`}
        id="templateModal"
        tabIndex={-1}
        aria-hidden={modalOpen ? undefined : true}
        style={modalOpen ? { background: "rgba(0,0,0,.5)" } : undefined}
      >
        <div className="modal-dialog modal-lg">
          <div className="modal-content">
            <form method="post" id="templateForm" onSubmit={onSubmit}>
              <div className="modal-header">
                <h5 className="modal-title" id="templateModalTitle">
                  {modalMode === "edit" ? "Modifica modello" : "Nuovo modello"}
                </h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={closeModal} />
              </div>

              <div className="modal-body">
                {error ? <div className="alert alert-danger">{error}</div> : null}
                <div className="row g-3">
                  <div className="col-12">
                    <label className="form-label fw-semibold">Titolo</label>
                    <input
                      className="form-control"
                      name="title"
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
                        value={form.bonus_kind}
                        onChange={(e) => set("bonus_kind", e.target.value as ModalForm["bonus_kind"])}
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
                      Se attivo, i Punti saranno calcolati su <strong>importo + bonus</strong>. Se disattivo, verranno
                      calcolati <strong>solo sull&apos;importo ricarica</strong>.
                    </div>
                  </div>

                  <div className="col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
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
                  {saving ? "Salvataggio…" : "Salva"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
