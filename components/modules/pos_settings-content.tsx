"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP POS settings page (app/pages/pos_settings.php):
// expiry settings for preorders / prepaids, plus "apply to existing" actions.
// Fed by the existing DB-backed /api/manage/configuration?module=pos_settings.

type ExpiryUnit = "days" | "months" | "years";

type PosSettingsState = {
  preorders_expiry_enabled: boolean;
  preorders_expiry_value: number;
  preorders_expiry_unit: ExpiryUnit;
  prepaids_expiry_enabled: boolean;
  prepaids_expiry_value: number;
  prepaids_expiry_unit: ExpiryUnit;
  preorders_without_expiry: number;
  prepaids_without_expiry: number;
};

const DEFAULT_SETTINGS: PosSettingsState = {
  preorders_expiry_enabled: false,
  preorders_expiry_value: 0,
  preorders_expiry_unit: "days",
  prepaids_expiry_enabled: false,
  prepaids_expiry_value: 0,
  prepaids_expiry_unit: "days",
  preorders_without_expiry: 0,
  prepaids_without_expiry: 0,
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function normalizeUnit(value: unknown): ExpiryUnit {
  const unit = String(value ?? "").toLowerCase();
  if (unit === "months" || unit === "years") return unit;
  return "days";
}

export function PosSettingsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [settings, setSettings] = useState<PosSettingsState>(DEFAULT_SETTINGS);
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);
  // Audit giro 3: guardia doppio-submit (save + applicazioni massive) e blocco
  // se il load fallisce (i DEFAULT sarebbero salvabili sopra la config reale).
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=pos_settings`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const s = j?.module?.settings ?? {};
        setSettings({
          preorders_expiry_enabled: Boolean(s.preorders_expiry_enabled),
          preorders_expiry_value: Number(s.preorders_expiry_value ?? 0) || 0,
          preorders_expiry_unit: normalizeUnit(s.preorders_expiry_unit),
          prepaids_expiry_enabled: Boolean(s.prepaids_expiry_enabled),
          prepaids_expiry_value: Number(s.prepaids_expiry_value ?? 0) || 0,
          prepaids_expiry_unit: normalizeUnit(s.prepaids_expiry_unit),
          preorders_without_expiry: Number(s.preorders_without_expiry ?? 0) || 0,
          prepaids_without_expiry: Number(s.prepaids_without_expiry ?? 0) || 0,
        });
      })
      .then(() => setLoadFailed(false))
      .catch(() => {
        setSettings(DEFAULT_SETTINGS);
        setLoadFailed(true);
      });
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function postAction(payload: Record<string, unknown>): Promise<void> {
    if (saving) return;
    if (loadFailed) {
      setFeedback({ type: "danger", text: "Impossibile salvare: impostazioni correnti non caricate. Ricarica la pagina." });
      return;
    }
    setSaving(true);
    setFeedback(null);
    const action = String(payload.action ?? "");
    try {
      const res = await fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=pos_settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, module: "pos_settings", ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        // Prefissi errore per azione come il legacy (pos_settings.php 34/42/50).
        const fallback = action === "apply_existing_preorders"
          ? "Errore aggiornamento preordini."
          : action === "apply_existing_prepaids"
            ? "Errore aggiornamento prepagati."
            : "Errore salvataggio impostazioni.";
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? fallback) });
        return;
      }
      // Esiti verbatim legacy (pos_settings.php 32/41/49): il salvataggio dice
      // "Impostazioni Pagamenti salvate."; le due applicazioni riportano il
      // conteggio con singolare/plurale.
      let text = "Impostazioni Pagamenti salvate.";
      if (action === "apply_existing_preorders") {
        const count = Number(j?.count ?? 0) || 0;
        text = count === 1 ? "1 preordine aggiornato." : `${count} preordini aggiornati.`;
      } else if (action === "apply_existing_prepaids") {
        const count = Number(j?.count ?? 0) || 0;
        text = count === 1 ? "1 prepagato aggiornato." : `${count} prepagati aggiornati.`;
      }
      setFeedback({ type: "success", text: String(j?.message ?? text) });
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    } finally {
      setSaving(false);
    }
  }

  function saveSettings() {
    postAction({
      action: "save_pos_expiry_settings",
      preorders_expiry_enabled: settings.preorders_expiry_enabled ? "1" : "0",
      preorders_expiry_value: String(settings.preorders_expiry_value),
      preorders_expiry_unit: settings.preorders_expiry_unit,
      prepaids_expiry_enabled: settings.prepaids_expiry_enabled ? "1" : "0",
      prepaids_expiry_value: String(settings.prepaids_expiry_value),
      prepaids_expiry_unit: settings.prepaids_expiry_unit,
    });
  }

  const posHref = `/${encodeURIComponent(slug)}/pos`;

  // canApply legacy (pos_settings.php 70-71): attivo + valore>0 + CONTEGGIO>0.
  const preordersApplyDisabled = !settings.preorders_expiry_enabled || settings.preorders_expiry_value <= 0 || settings.preorders_without_expiry <= 0;
  const prepaidsApplyDisabled = !settings.prepaids_expiry_enabled || settings.prepaids_expiry_value <= 0 || settings.prepaids_without_expiry <= 0;
  // Help dinamici verbatim (pos_settings.php 72-81, refuso 'verra' preservato).
  const preordersApplyText = !settings.preorders_expiry_enabled || settings.preorders_expiry_value <= 0
    ? "Attiva e salva la scadenza per aggiornare i preordini esistenti."
    : settings.preorders_without_expiry === 1
      ? "1 preordine aperto senza scadenza verra aggiornato con le impostazioni salvate."
      : `${settings.preorders_without_expiry} preordini aperti senza scadenza verranno aggiornati con le impostazioni salvate.`;
  const prepaidsApplyText = !settings.prepaids_expiry_enabled || settings.prepaids_expiry_value <= 0
    ? "Attiva e salva la scadenza per aggiornare i prepagati esistenti."
    : settings.prepaids_without_expiry === 1
      ? "1 prepagato attivo senza scadenza verra aggiornato con le impostazioni salvate."
      : `${settings.prepaids_without_expiry} prepagati attivi senza scadenza verranno aggiornati con le impostazioni salvate.`;

  return (
    <div className="container-fluid">

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pagamenti</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Impostazioni</h1>
            <InfoBox>
              <p>Qui imposti le scadenze predefinite di <strong>preordini</strong> e <strong>prepagati</strong>.</p>
              <ul>
                <li>La scadenza viene calcolata dalla data di vendita e salvata a fine giornata.</li>
                <li>
                  Se disattivi una funzione, le date già salvate non vengono mostrate e non bloccano utilizzi o ritiri;
                  riattivandola tornano a valere.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Configura scadenze, pagamenti anticipati e impostazioni operative.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={posHref}>
              <i className="bi bi-arrow-left me-1" />
              Torna a Pagamenti
            </a>
          </div>
        </div>
      </div>

      {feedback ? (
        <div className={`alert alert-${feedback.type}`} role="alert">
          {feedback.text}
        </div>
      ) : null}

      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          saveSettings();
        }}
      >
        <input type="hidden" name="action" value="save_pos_expiry_settings" />

        <div className="row g-3">
          <div className="col-lg-6">
            <div className="card p-4 h-100">
              <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
                <div>
                  <div className="h5 fw-semibold mb-1">Preordini</div>
                  <div className="text-muted small">Prodotti venduti da Pagamenti con stato Ordinato.</div>
                </div>
                <div className="form-check form-switch m-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="preorders_expiry_enabled"
                    name="preorders_expiry_enabled"
                    value="1"
                    checked={settings.preorders_expiry_enabled}
                    onChange={(e) => setSettings((s) => ({ ...s, preorders_expiry_enabled: e.target.checked }))}
                  />
                </div>
              </div>

              <div className="row g-2">
                <div className="col-sm-6">
                  <label className="form-label">Validita</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    max={36500}
                    name="preorders_expiry_value"
                    value={settings.preorders_expiry_value}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, preorders_expiry_value: Number(e.target.value) || 0 }))
                    }
                  />
                  <div className="form-text">0 = nessuna scadenza automatica.</div>
                </div>
                <div className="col-sm-6">
                  <label className="form-label">Unita</label>
                  <select
                    className="form-select"
                    name="preorders_expiry_unit"
                    value={settings.preorders_expiry_unit}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, preorders_expiry_unit: normalizeUnit(e.target.value) }))
                    }
                  >
                    <option value="days">Giorni</option>
                    <option value="months">Mesi</option>
                    <option value="years">Anni</option>
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <button
                  className="btn btn-outline-primary btn-sm"
                  type="button"
                  disabled={preordersApplyDisabled || saving || loadFailed}
                  onClick={() => postAction({ action: "apply_existing_preorders" })}
                >
                  <i className="bi bi-calendar-plus me-1" />
                  Applica ai preordini senza scadenza
                </button>
                <div className="form-text">{preordersApplyText}</div>
              </div>
            </div>
          </div>

          <div className="col-lg-6">
            <div className="card p-4 h-100">
              <div className="d-flex align-items-start justify-content-between gap-3 mb-3">
                <div>
                  <div className="h5 fw-semibold mb-1">Prepagati</div>
                  <div className="text-muted small">Servizi venduti da Pagamenti con stato Prepagato.</div>
                </div>
                <div className="form-check form-switch m-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="prepaids_expiry_enabled"
                    name="prepaids_expiry_enabled"
                    value="1"
                    checked={settings.prepaids_expiry_enabled}
                    onChange={(e) => setSettings((s) => ({ ...s, prepaids_expiry_enabled: e.target.checked }))}
                  />
                </div>
              </div>

              <div className="row g-2">
                <div className="col-sm-6">
                  <label className="form-label">Validita</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    max={36500}
                    name="prepaids_expiry_value"
                    value={settings.prepaids_expiry_value}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, prepaids_expiry_value: Number(e.target.value) || 0 }))
                    }
                  />
                  <div className="form-text">0 = nessuna scadenza automatica.</div>
                </div>
                <div className="col-sm-6">
                  <label className="form-label">Unita</label>
                  <select
                    className="form-select"
                    name="prepaids_expiry_unit"
                    value={settings.prepaids_expiry_unit}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, prepaids_expiry_unit: normalizeUnit(e.target.value) }))
                    }
                  >
                    <option value="days">Giorni</option>
                    <option value="months">Mesi</option>
                    <option value="years">Anni</option>
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <button
                  className="btn btn-outline-primary btn-sm"
                  type="button"
                  disabled={prepaidsApplyDisabled || saving || loadFailed}
                  onClick={() => postAction({ action: "apply_existing_prepaids" })}
                >
                  <i className="bi bi-calendar-plus me-1" />
                  Applica ai prepagati senza scadenza
                </button>
                <div className="form-text">{prepaidsApplyText}</div>
              </div>
            </div>
          </div>
        </div>


        <div className="d-flex gap-2 mt-3">
          <button className="btn btn-primary" type="submit" disabled={saving || loadFailed}>
            <i className="bi bi-check2-circle me-1" />
            Salva impostazioni
          </button>
          <a className="btn btn-outline-secondary" href={posHref}>
            Annulla
          </a>
        </div>
      </form>
    </div>
  );
}
