"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

// Faithful port of the PHP page app/pages/fidelity_membership_settings.php
// (?page=fidelity_membership_settings) + assets/js/pages/fidelity_membership_settings.js:
// form scadenza/rinnovo/promemoria tessera con show/hide dinamico delle sezioni,
// bottone Salva disabilitato finché non ci sono modifiche, modal di conferma
// "Aggiorna tessere Fidelity" con testi per modalità (generic / disable_expiry /
// restore_existing_from_snapshot / renewal_only), stato disabilitato con Fidelity
// globale off e flash via redirect ?msg/?err (#fidelity_card_settings).

const DEFAULT_INITIAL_SETTINGS = {
  globalEnabled: 1,
  expiryEnabled: 0,
  validityValue: 1,
  validityUnit: "days",
  renewalEnabled: 0,
  renewalValue: 0,
  renewalUnit: "days",
  renewalClamped: 0,
  reminderDays: 0,
  restoreValue: 0,
  restoreUnit: "days",
  restoreLabel: "0 giorni",
};

type InitialSettings = typeof DEFAULT_INITIAL_SETTINGS;

type FormState = {
  expiryEnabled: number;
  validityValue: string;
  validityUnit: string;
  renewalEnabled: number;
  renewalValue: string;
  renewalUnit: string;
  reminderDays: string;
};

type FidelityMembershipSettingsQuery = { msg?: string; err?: string };

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

// Normalizzazione stato del JS legacy (normalizeState): interi + unità.
function normalizedState(form: FormState): string {
  const toInt = (raw: string) => {
    const n = Number.parseInt(raw || "0", 10);
    return Number.isFinite(n) ? n : 0;
  };
  return JSON.stringify({
    expiryEnabled: form.expiryEnabled ? 1 : 0,
    validityValue: toInt(form.validityValue),
    validityUnit: String(form.validityUnit || "days"),
    renewalEnabled: form.renewalEnabled ? 1 : 0,
    renewalValue: toInt(form.renewalValue),
    renewalUnit: String(form.renewalUnit || "days"),
    reminderDays: toInt(form.reminderDays),
  });
}

function formFromSettings(s: InitialSettings): FormState {
  return {
    expiryEnabled: s.expiryEnabled ? 1 : 0,
    validityValue: String(s.validityValue),
    validityUnit: s.validityUnit,
    renewalEnabled: s.renewalEnabled ? 1 : 0,
    renewalValue: String(s.renewalValue),
    renewalUnit: s.renewalUnit,
    reminderDays: String(s.reminderDays),
  };
}

export function FidelityMembershipSettingsContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: FidelityMembershipSettingsQuery } = {}) {
  const slug = slugProp || tenantSlug();
  const [settings, setSettings] = useState<InitialSettings>(DEFAULT_INITIAL_SETTINGS);
  const [form, setForm] = useState<FormState>(formFromSettings(DEFAULT_INITIAL_SETTINGS));
  const [loaded, setLoaded] = useState(false);
  const [canFidelityManage, setCanFidelityManage] = useState(false);
  const [canLevels, setCanLevels] = useState(false);
  // Flash legacy via redirect ?msg/?err; gli errori del POST restano in pagina.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [pageError, setPageError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=fidelity_membership`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const s = (j?.module?.settings ?? {}) as Record<string, unknown>;
        const next: InitialSettings = {
          globalEnabled: num(s.globalEnabled, DEFAULT_INITIAL_SETTINGS.globalEnabled),
          expiryEnabled: num(s.expiryEnabled, DEFAULT_INITIAL_SETTINGS.expiryEnabled),
          validityValue: num(s.validityValue, DEFAULT_INITIAL_SETTINGS.validityValue),
          validityUnit: unit(s.validityUnit, DEFAULT_INITIAL_SETTINGS.validityUnit),
          renewalEnabled: num(s.renewalEnabled, DEFAULT_INITIAL_SETTINGS.renewalEnabled),
          renewalValue: num(s.renewalValue, DEFAULT_INITIAL_SETTINGS.renewalValue),
          renewalUnit: unit(s.renewalUnit, DEFAULT_INITIAL_SETTINGS.renewalUnit),
          renewalClamped: num(s.renewalClamped, 0),
          reminderDays: num(s.reminderDays, DEFAULT_INITIAL_SETTINGS.reminderDays),
          restoreValue: num(s.restoreValue, DEFAULT_INITIAL_SETTINGS.restoreValue),
          restoreUnit: unit(s.restoreUnit, DEFAULT_INITIAL_SETTINGS.restoreUnit),
          restoreLabel: String(s.restoreLabel ?? DEFAULT_INITIAL_SETTINGS.restoreLabel),
        };
        setSettings(next);
        setForm(formFromSettings(next));
        setCanFidelityManage(Boolean(j?.canFidelityManage));
        setCanLevels(Boolean(j?.canLevels));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = normalizedState(form) !== normalizedState(formFromSettings(settings));

  // determineConfirmMode del JS legacy.
  function confirmMode(): "disable_expiry" | "restore_existing_from_snapshot" | "duration_only" | "renewal_only" | "generic" {
    const init = formFromSettings(settings);
    const toInt = (raw: string) => Number.parseInt(raw || "0", 10) || 0;
    const durationChanged = toInt(init.validityValue) !== toInt(form.validityValue) || init.validityUnit !== form.validityUnit;
    const renewalChanged =
      init.renewalEnabled !== form.renewalEnabled ||
      toInt(init.renewalValue) !== toInt(form.renewalValue) ||
      init.renewalUnit !== form.renewalUnit ||
      toInt(init.reminderDays) !== toInt(form.reminderDays);
    if (init.expiryEnabled === 1 && form.expiryEnabled === 0) return "disable_expiry";
    if (init.expiryEnabled === 0 && form.expiryEnabled === 1) return "restore_existing_from_snapshot";
    if (form.expiryEnabled === 1 && durationChanged) return "duration_only";
    if (renewalChanged) return "renewal_only";
    return "generic";
  }

  // updateConfirmCopy del JS legacy: titolo/dettaglio/impatto per modalità.
  function confirmCopy(): { title: string; detail: string; showImpact: boolean } {
    const mode = confirmMode();
    const restoreLabel = settings.restoreLabel || "l'ultima durata memorizzata";
    let title = "Le modifiche avranno effetto sulle nuove tessere Fidelity e sulle tessere scadute che verranno riattivate.";
    let detail =
      "Le tessere attive già esistenti non subiranno variazioni di durata. Se riattivi la scadenza automatica, le tessere già presenti recupereranno prima l'ultima data di scadenza memorizzata e torneranno attive automaticamente se quella data è ancora valida; se manca una data specifica verrà usata la durata memorizzata. Rinnovo automatico e promemoria, se modificati, si aggiornano anche per le tessere già presenti.";
    let showImpact = false;
    if (mode === "disable_expiry") {
      title = "La scadenza verrà rimossa da tutte le tessere Fidelity già presenti.";
      detail =
        "Tutte le tessere esistenti saranno rese senza scadenza. Rinnovo automatico e promemoria di scadenza non saranno disponibili finché non riattivi la scadenza.";
    } else if (mode === "restore_existing_from_snapshot") {
      title = "La scadenza automatica verrà riattivata per le tessere Fidelity già presenti.";
      detail =
        "Le tessere già presenti recupereranno prima l'ultima data di scadenza memorizzata al momento della disattivazione; se per una tessera non esiste una data specifica verrà usata la durata memorizzata (" +
        restoreLabel +
        "). Le tessere con scadenza ripristinata ancora valida torneranno attive automaticamente; quelle con scadenza già trascorsa resteranno scadute / non attive finché non usi Riattiva tessera. La durata impostata ora verrà usata per le nuove tessere e per le tessere scadute che riattiverai.";
      showImpact = true;
    } else if (mode === "renewal_only") {
      title = "Rinnovo automatico e promemoria di scadenza verranno aggiornati anche per le tessere già presenti.";
      detail = "Le tessere attive esistenti non cambieranno durata o data di scadenza.";
    }
    return { title, detail, showImpact };
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!dirty) return;
    setConfirmOpen(true);
  }

  async function confirmAndSave(): Promise<void> {
    setConfirmOpen(false);
    setSaving(true);
    setPageError(null);
    try {
      const res = await fetch(`/api/manage/configuration?slug=${encodeURIComponent(slug)}&module=fidelity_membership`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          slug,
          module: "fidelity_membership",
          action: "save_fidelity_card_validity_default",
          fidelity_card_expiry_enabled: form.expiryEnabled ? "1" : "0",
          fidelity_card_default_validity_value: form.validityValue,
          fidelity_card_default_validity_unit: form.validityUnit,
          fidelity_card_renewal_enabled: form.renewalEnabled ? "1" : "0",
          fidelity_card_renewal_window_value: form.renewalValue,
          fidelity_card_renewal_window_unit: form.renewalUnit,
          fidelity_card_expiry_reminder_days: form.reminderDays,
          fidelity_card_apply_to_existing_confirmed: "1",
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        // Il legacy renderizza l'errore in pagina (niente redirect sul catch).
        setPageError(String(j?.error ?? j?.message ?? "Errore."));
        window.scrollTo(0, 0);
        return;
      }
      const msg = String(j?.message ?? "Impostazioni tessera Fidelity salvate.");
      window.location.href = `/${encodeURIComponent(slug)}/fidelity_membership_settings?msg=${encodeURIComponent(msg)}#fidelity_card_settings`;
    } catch {
      setPageError("Errore di rete.");
    } finally {
      setSaving(false);
    }
  }

  const headerAlerts = (
    <>
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
    </>
  );

  // Stato disabilitato legacy: early-return con alert quando la Fidelity globale è off.
  if (loaded && settings.globalEnabled !== 1) {
    return (
      <div className="container-fluid">
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
              {canFidelityManage ? (
                <a className="btn btn-light" href={`/${encodeURIComponent(slug)}/fidelity`}>
                  <i className="bi bi-award" /> Fidelity
                </a>
              ) : null}
            </div>
          </div>
        </div>

        {headerAlerts}

        <div className="alert alert-info">
          <div className="fw-semibold mb-1"><i className="bi bi-info-circle me-1" />Fidelity disattivata</div>
          <div className="small">
            Questa pagina è disabilitata perché l&apos;impostazione generale Fidelity è disattivata.{" "}
            {canFidelityManage ? (
              <>
                Attiva la funzione in <a href={`/${encodeURIComponent(slug)}/fidelity`}>Fidelity → Impostazione generale</a>.
              </>
            ) : (
              <>Chiedi a un Admin di attivare l&apos;impostazione generale Fidelity.</>
            )}
          </div>
        </div>
      </div>
    );
  }

  const expiryOn = form.expiryEnabled === 1;
  const renewalOn = form.renewalEnabled === 1;
  const copy = confirmCopy();

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
            {canLevels ? (
              <a className="btn btn-light" href={`/${encodeURIComponent(slug)}/fidelity_points#livelli-card`}>
                <i className="bi bi-stars" /> Livelli Card
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {headerAlerts}

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
              method="post"
              className="border rounded-3 p-3 bg-light"
              id="fidelityCardValidityForm"
              onSubmit={handleSubmit}
              data-initial-settings={JSON.stringify({
                expiryEnabled: settings.expiryEnabled,
                validityValue: settings.validityValue,
                validityUnit: settings.validityUnit,
                renewalEnabled: settings.renewalEnabled,
                renewalValue: settings.renewalValue,
                renewalUnit: settings.renewalUnit,
                reminderDays: settings.reminderDays,
                restoreValue: settings.restoreValue,
                restoreUnit: settings.restoreUnit,
                restoreLabel: settings.restoreLabel,
              })}
            >
              <input type="hidden" name="_mode" value="save_fidelity_card_validity_default" />
              <input
                type="hidden"
                name="fidelity_card_apply_to_existing_confirmed"
                id="fidelityCardApplyConfirm"
                value={confirmOpen ? "1" : "0"}
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
                  checked={expiryOn}
                  onChange={(e) => setForm((f) => ({ ...f, expiryEnabled: e.target.checked ? 1 : 0 }))}
                />
                <label className="form-check-label" htmlFor="fidelityCardExpiryEnabled">
                  Abilita scadenza automatica tessera
                </label>
              </div>
              <div className="form-text mb-2">
                Se disattivi la scadenza, la tessera Fidelity non avrà data di scadenza e non saranno disponibili{" "}
                <strong>Rinnovo automatico su acquisto / prenotazione</strong> e <strong>Promemoria di scadenza</strong>.
              </div>
              <div id="fidelityCardExpiryFields" style={{ display: expiryOn ? undefined : "none" }}>
                <div className="row g-2 align-items-end">
                  <div className="col-md-4">
                    <label className="form-label">Durata</label>
                    <input
                      className="form-control"
                      type="number"
                      min="1"
                      max="36500"
                      name="fidelity_card_default_validity_value"
                      value={form.validityValue}
                      onChange={(e) => setForm((f) => ({ ...f, validityValue: e.target.value }))}
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
                      value={form.validityUnit}
                      onChange={(e) => setForm((f) => ({ ...f, validityUnit: e.target.value }))}
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

              <div
                id="fidelityCardNoExpiryNotice"
                className="alert alert-secondary mt-3 mb-0 py-2 px-3"
                style={{ display: expiryOn ? "none" : undefined }}
              >
                <div className="small mb-0">
                  <strong>Scadenza tessera disattivata.</strong> Le tessere già presenti resteranno senza scadenza. Quando
                  riattiverai la scadenza automatica, recupereranno prima l&apos;ultima data di scadenza memorizzata al
                  momento della disattivazione; se per una tessera non esisteva una data specifica, useremo la durata
                  memorizzata in quell&apos;istante. Quelle con scadenza ripristinata ancora valida torneranno attive
                  automaticamente, mentre la durata impostata nel form continuerà a valere per nuove tessere e
                  riattivazioni future.
                </div>
              </div>

              <div id="fidelityCardExpiryDependentFields" style={{ display: expiryOn ? undefined : "none" }}>
                <div className="fw-semibold mt-4 mb-2">Rinnovo automatico su acquisto / prenotazione</div>
                <div className="form-check form-switch mb-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="fidelityCardRenewalEnabled"
                    name="fidelity_card_renewal_enabled"
                    value="1"
                    checked={renewalOn}
                    onChange={(e) => setForm((f) => ({ ...f, renewalEnabled: e.target.checked ? 1 : 0 }))}
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

                <div id="fidelityCardRenewalFields" style={{ display: renewalOn ? undefined : "none" }}>
                  <div className="row g-2 align-items-end">
                    <div className="col-md-4">
                      <label className="form-label">Entro</label>
                      <input
                        className="form-control"
                        type="number"
                        min="0"
                        max="36500"
                        name="fidelity_card_renewal_window_value"
                        value={form.renewalValue}
                        onChange={(e) => setForm((f) => ({ ...f, renewalValue: e.target.value }))}
                        placeholder="0"
                      />
                      <div className="form-text">La finestra di rinnovo deve essere inferiore alla durata della tessera.</div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label">Unità</label>
                      <select
                        className="form-select"
                        name="fidelity_card_renewal_window_unit"
                        value={form.renewalUnit}
                        onChange={(e) => setForm((f) => ({ ...f, renewalUnit: e.target.value }))}
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
                  {settings.renewalClamped === 1 ? (
                    <div className="form-text text-warning">
                      La finestra configurata è stata ridotta automaticamente per restare inferiore alla durata tessera.
                    </div>
                  ) : null}
                </div>

                <div id="fidelityCardReminderFields" style={{ display: renewalOn ? "none" : undefined }}>
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
                        value={form.reminderDays}
                        onChange={(e) => setForm((f) => ({ ...f, reminderDays: e.target.value }))}
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
                  disabled={!dirty || saving}
                  aria-disabled={!dirty || saving}
                  title={dirty ? "Salva le modifiche alla tessera Fidelity" : "Nessuna modifica da salvare"}
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

      {confirmOpen ? (
        <>
          <div className="modal fade show d-block" id="fidelityCardValidityConfirmModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Aggiorna tessere Fidelity</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setConfirmOpen(false)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning mb-3">
                    <div className="fw-semibold mb-1" id="fidelityCardValidityConfirmText">{copy.title}</div>
                    <div className="small mb-0" id="fidelityCardValidityConfirmDetail">{copy.detail}</div>
                  </div>
                  <div className={`small text-danger${copy.showImpact ? "" : " d-none"} mb-2`} id="fidelityCardValidityConfirmImpact">
                    Riattivando la scadenza automatica, alcune tessere già presenti potrebbero tornare scadute e le
                    prenotazioni in stato In sospeso / Prenotato del cliente perderebbero le agevolazioni Fidelity
                    collegate.
                  </div>
                  <div className="small text-muted">Prima di salvare, conferma se vuoi continuare oppure annullare.</div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmOpen(false)}>
                    Annulla
                  </button>
                  <button type="button" className="btn btn-primary" id="fidelityCardValidityConfirmSubmit" onClick={() => void confirmAndSave()}>
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
