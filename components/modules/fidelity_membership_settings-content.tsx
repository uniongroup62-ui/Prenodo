"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

// Faithful port of the PHP page app/pages/fidelity_membership_settings.php
// (?page=fidelity_membership_settings): Fidelity card validity / auto-renewal /
// expiry-reminder settings form + "how it works" aside. Interamente DB-backed
// (F5b): il salvataggio applica gli applyMode legacy (preserve / disable_expiry
// con SNAPSHOT delle scadenze / restore_existing_from_snapshot), la conferma è
// il round-trip confirm()+flag (sostituisce la vecchia modal statica) e i
// messaggi per modalità arrivano dal server.

const DEFAULT_INITIAL_SETTINGS = {
  expiryEnabled: 0,
  validityValue: 1,
  validityUnit: "days",
  renewalEnabled: 0,
  renewalValue: 0,
  renewalUnit: "days",
  reminderDays: 0,
  restoreValue: 0,
  restoreUnit: "days",
  restoreLabel: "0 giorni",
};

type InitialSettings = typeof DEFAULT_INITIAL_SETTINGS;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function unit(value: unknown, fallback: string): "days" | "months" | "years" {
  const v = String(value ?? "");
  return v === "days" || v === "months" || v === "years" ? v : (fallback as "days" | "months" | "years");
}

export function FidelityMembershipSettingsContent() {
  const slug = tenantSlug();
  const [settings, setSettings] = useState<InitialSettings>(DEFAULT_INITIAL_SETTINGS);
  // Remount key for the uncontrolled form so a successful save re-seeds the
  // defaultChecked/defaultValue inputs from the freshly loaded settings.
  const [formKey, setFormKey] = useState(0);
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=fidelity_membership`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const s = (j?.module?.settings ?? {}) as Record<string, unknown>;
        setSettings({
          expiryEnabled: num(s.expiryEnabled ?? s.fidelity_card_expiry_enabled, DEFAULT_INITIAL_SETTINGS.expiryEnabled),
          validityValue: num(s.validityValue ?? s.fidelity_card_default_validity_value, DEFAULT_INITIAL_SETTINGS.validityValue),
          validityUnit: unit(s.validityUnit ?? s.fidelity_card_default_validity_unit, DEFAULT_INITIAL_SETTINGS.validityUnit),
          renewalEnabled: num(s.renewalEnabled ?? s.fidelity_card_renewal_enabled, DEFAULT_INITIAL_SETTINGS.renewalEnabled),
          renewalValue: num(s.renewalValue ?? s.fidelity_card_renewal_window_value, DEFAULT_INITIAL_SETTINGS.renewalValue),
          renewalUnit: unit(s.renewalUnit ?? s.fidelity_card_renewal_window_unit, DEFAULT_INITIAL_SETTINGS.renewalUnit),
          reminderDays: num(s.reminderDays ?? s.fidelity_card_expiry_reminder_days, DEFAULT_INITIAL_SETTINGS.reminderDays),
          restoreValue: num(s.restoreValue, DEFAULT_INITIAL_SETTINGS.restoreValue),
          restoreUnit: unit(s.restoreUnit, DEFAULT_INITIAL_SETTINGS.restoreUnit),
          restoreLabel: String(s.restoreLabel ?? DEFAULT_INITIAL_SETTINGS.restoreLabel),
        });
        setFormKey((k) => k + 1);
      })
      .catch(() => {
        /* keep captured defaults */
      });
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setSaving(true);
    setFeedback(null);
    try {
      // Conferma legacy come round-trip: il server rifiuta con "Conferma il
      // salvataggio..." e il confirm() dell'operatore fa ripartire la richiesta
      // col flag (sostituisce la vecchia modal statica).
      const extraFlags: Record<string, string> = {};
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=fidelity_membership`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            slug,
            module: "fidelity_membership",
            action: "save_fidelity_card_validity_default",
            fidelity_card_expiry_enabled: fd.get("fidelity_card_expiry_enabled") ? "1" : "0",
            fidelity_card_default_validity_value: String(fd.get("fidelity_card_default_validity_value") ?? ""),
            fidelity_card_default_validity_unit: String(fd.get("fidelity_card_default_validity_unit") ?? "days"),
            fidelity_card_renewal_enabled: fd.get("fidelity_card_renewal_enabled") ? "1" : "0",
            fidelity_card_renewal_window_value: String(fd.get("fidelity_card_renewal_window_value") ?? ""),
            fidelity_card_renewal_window_unit: String(fd.get("fidelity_card_renewal_window_unit") ?? "days"),
            fidelity_card_expiry_reminder_days: String(fd.get("fidelity_card_expiry_reminder_days") ?? ""),
            ...extraFlags,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j?.ok === false) {
          const err = String(j?.error ?? j?.message ?? "Errore.");
          if (err.startsWith("Conferma il salvataggio") && !extraFlags.fidelity_card_apply_to_existing_confirmed) {
            if (window.confirm("Confermi il salvataggio delle impostazioni tessera Fidelity? Le modifiche alla scadenza verranno applicate anche alle tessere esistenti (snapshot/ripristino automatico).")) {
              extraFlags.fidelity_card_apply_to_existing_confirmed = "1";
              continue;
            }
          }
          setFeedback({ type: "danger", text: err });
          return;
        }
        setFeedback({ type: "success", text: String(j?.message ?? "Impostazioni tessera Fidelity salvate.") });
        load();
        return;
      }
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/fidelity_membership_settings.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma punti</div>
          <h1 className="bs-page-title">Impostazioni tessera Fidelity</h1>
          <div className="bs-page-subtitle">Configura scadenza, rinnovo e promemoria tessere.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-light" href={`/${encodeURIComponent(slug)}/fidelity_membership`}>
              <i className="bi bi-arrow-left" /> Adesione
            </a>
            <a className="btn btn-light" href={`/${encodeURIComponent(slug)}/fidelity_points#livelli-card`}>
              <i className="bi bi-stars" /> Livelli Card
            </a>
          </div>
        </div>
      </div>

      {feedback ? (
        <div className={`alert alert-${feedback.type}`} role="alert">
          {feedback.text}
        </div>
      ) : null}

      <div className="row g-3 fidelity-card-settings-anchor" id="fidelity_card_settings">
        <div className="col-lg-8">
          <div className="card p-4">
            <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-2 mb-3">
              <div>
                <div className="h5 fw-bold mb-1">Impostazioni tessera Fidelity</div>
                <div className="text-muted small">
                  Configura scadenza, rinnovo automatico e promemoria di scadenza dalla pagina dedicata di Adesione.
                </div>
              </div>
            </div>
            <div className="text-muted small mb-3">
              Quando crei una <strong>nuova tessera Fidelity</strong> da <strong>Fidelity → Adesione</strong>, la{" "}
              <em>Data scadenza</em> del popup <em>Nuova tessera</em> viene calcolata automaticamente partendo dalla{" "}
              <em>Data emissione</em>.
              <br />
              La data viene <strong>solo visualizzata</strong> nel popup e <strong>non è modificabile</strong> manualmente.
            </div>

            <form
              key={formKey}
              method="post"
              className="border rounded-3 p-3 bg-light"
              id="fidelityCardValidityForm"
              onSubmit={handleSubmit}
              data-initial-settings={JSON.stringify(settings)}
            >
              <input type="hidden" name="_mode" value="save_fidelity_card_validity_default" />
              <input
                type="hidden"
                name="fidelity_card_apply_to_existing_confirmed"
                id="fidelityCardApplyConfirm"
                value="1"
              />

              <div className="fw-semibold mb-2">Scadenza predefinita tessera</div>
              <div className="form-check form-switch mb-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="fidelityCardExpiryEnabled"
                  name="fidelity_card_expiry_enabled"
                  value="1"
                  defaultChecked={settings.expiryEnabled === 1}
                />
                <label className="form-check-label" htmlFor="fidelityCardExpiryEnabled">
                  Abilita scadenza automatica tessera
                </label>
              </div>
              <div className="form-text mb-2">
                Se disattivi la scadenza, la tessera Fidelity non avrà data di scadenza e non saranno disponibili{" "}
                <strong>Rinnovo automatico su acquisto / prenotazione</strong> e <strong>Promemoria di scadenza</strong>.
              </div>
              <div id="fidelityCardExpiryFields">
                <div className="row g-2 align-items-end">
                  <div className="col-md-4">
                    <label className="form-label">Durata</label>
                    <input
                      className="form-control"
                      type="number"
                      min="1"
                      max="36500"
                      name="fidelity_card_default_validity_value"
                      defaultValue={settings.validityValue}
                      placeholder="1"
                    />
                    <div className="form-text">
                      Usa l&apos;interruttore sopra per attivare o disattivare la scadenza automatica della tessera.
                    </div>
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Unità</label>
                    <select
                      className="form-select"
                      name="fidelity_card_default_validity_unit"
                      defaultValue={settings.validityUnit}
                    >
                      <option value="days">Giorni</option>
                      <option value="months">Mesi</option>
                      <option value="years">Anni</option>
                    </select>
                  </div>
                </div>
                <div className="form-text mt-2">
                  La durata impostata qui si applica <strong>solo alle nuove tessere</strong> e alle{" "}
                  <strong>tessere scadute che verranno riattivate</strong>. Le tessere attive già esistenti{" "}
                  <strong>non vengono modificate</strong> quando cambi questo valore.
                </div>
              </div>

              <div id="fidelityCardNoExpiryNotice" className="alert alert-secondary mt-3 mb-0 py-2 px-3">
                <div className="small mb-0">
                  <strong>Scadenza tessera disattivata.</strong> Le tessere già presenti resteranno senza scadenza. Quando
                  riattiverai la scadenza automatica, recupereranno prima l&apos;ultima data di scadenza memorizzata al
                  momento della disattivazione; se per una tessera non esisteva una data specifica, useremo la durata
                  memorizzata in quell&apos;istante. Quelle con scadenza ripristinata ancora valida torneranno attive
                  automaticamente, mentre la durata impostata nel form continuerà a valere per nuove tessere e
                  riattivazioni future.
                </div>
              </div>

              <div id="fidelityCardExpiryDependentFields">
                <div className="fw-semibold mt-4 mb-2">Rinnovo automatico su acquisto / prenotazione</div>
                <div className="form-check form-switch mb-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="fidelityCardRenewalEnabled"
                    name="fidelity_card_renewal_enabled"
                    value="1"
                    defaultChecked={settings.renewalEnabled === 1}
                  />
                  <label className="form-check-label" htmlFor="fidelityCardRenewalEnabled">
                    Abilita rinnovo automatico
                  </label>
                </div>
                <div className="form-text mb-2">
                  Se attivo, un acquisto da <strong>Pagamenti</strong> oppure una <strong>Prenotazione</strong> portata in
                  stato <strong>Eseguito</strong> entro la finestra scelta prima della scadenza rinnoveranno
                  automaticamente la tessera dalla scadenza corrente.
                </div>

                <div id="fidelityCardRenewalFields">
                  <div className="row g-2 align-items-end">
                    <div className="col-md-4">
                      <label className="form-label">Entro</label>
                      <input
                        className="form-control"
                        type="number"
                        min="0"
                        max="36500"
                        name="fidelity_card_renewal_window_value"
                        defaultValue={settings.renewalValue}
                        placeholder="0"
                      />
                      <div className="form-text">La finestra di rinnovo deve essere inferiore alla durata della tessera.</div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Unità</label>
                      <select
                        className="form-select"
                        name="fidelity_card_renewal_window_unit"
                        defaultValue={settings.renewalUnit}
                      >
                        <option value="days">Giorni</option>
                        <option value="months">Mesi</option>
                        <option value="years">Anni</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-text mt-2">
                    Quando una tessera entra in questa finestra, comparirà anche nel backend <strong>Notifiche</strong>{" "}
                    nella sezione <strong>Tessere Fidelity in scadenza / scadute</strong>. Questa impostazione vale sia per
                    le <strong>nuove tessere</strong> sia per le <strong>tessere già presenti</strong>.
                  </div>
                </div>

                <div id="fidelityCardReminderFields">
                  <div className="fw-semibold mt-3 mb-2">Promemoria di scadenza</div>
                  <div className="row g-2 align-items-end">
                    <div className="col-md-4">
                      <label className="form-label">Entro quanti giorni</label>
                      <input
                        className="form-control"
                        type="number"
                        min="0"
                        max="36500"
                        name="fidelity_card_expiry_reminder_days"
                        defaultValue={settings.reminderDays}
                        placeholder="0"
                      />
                      <div className="form-text">0 = nessun promemoria nel backend Notifiche</div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Unità</label>
                      <input className="form-control" type="text" value="Giorni" readOnly />
                    </div>
                  </div>
                  <div className="form-text mt-2">
                    Se il rinnovo automatico è disattivato, il backend <strong>Notifiche</strong> mostrerà le tessere in
                    scadenza nei prossimi X giorni e quelle già scadute. Anche questa impostazione si aggiorna per le{" "}
                    <strong>tessere già presenti</strong>.
                  </div>
                </div>
              </div>

              <div className="mt-3 d-flex gap-2">
                <button
                  className="btn btn-primary btn-pill"
                  type="submit"
                  id="fidelityCardValiditySubmit"
                  disabled={saving}
                  aria-disabled={saving}
                >
                  <i className="bi bi-check2-circle me-1" />
                  Salva tessera Fidelity
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card p-4">
            <div className="h6 fw-bold mb-2">Come funziona</div>
            <div className="text-muted small">
              <ul className="mb-0">
                <li>
                  <strong>Nuova tessera:</strong> la <strong>Data emissione</strong> è modificabile; la{" "}
                  <strong>Data scadenza</strong> viene calcolata automaticamente e non è modificabile manualmente.
                </li>
                <li>
                  <strong>Durata:</strong> vale per le nuove tessere e per le tessere scadute che riattivi. Le tessere
                  attive già esistenti non cambiano quando modifichi la durata.
                </li>
                <li>
                  <strong>Scadenza tessera:</strong> se la disattivi, le tessere restano senza scadenza e non sono
                  disponibili rinnovo automatico e promemoria. Se la riattivi, viene recuperata l&apos;ultima scadenza
                  memorizzata quando disponibile.
                </li>
                <li>
                  <strong>Rinnovo automatico:</strong> se attivo, un pagamento o una prenotazione portata in stato{" "}
                  <strong>Eseguito</strong> rinnova la tessera entro la finestra impostata prima della scadenza. La
                  finestra deve essere inferiore alla durata tessera.
                </li>
                <li>
                  <strong>Promemoria:</strong> se il rinnovo automatico è disattivo, puoi mostrare nel backend{" "}
                  <strong>Notifiche</strong> le tessere in scadenza nei prossimi giorni e quelle già scadute.
                </li>
                <li>
                  <strong>Tessera scaduta:</strong> punti Fidelity maturati non vengono azzerati, ma il cliente non può
                  usare benefici Fidelity finché la tessera non torna valida. Da <strong>Modifica tessera</strong> puoi
                  usare <strong>Riattiva tessera</strong>.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
