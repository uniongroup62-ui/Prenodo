"use client";

import { useEffect, useMemo, useState } from "react";
import { FidelityCampaignsSection } from "@/components/modules/fidelity_campaigns-section";

// Faithful port of the PHP Fidelity Points page (app/pages/fidelity_points.php).
// Fed by the existing DB-backed /api/manage/fidelity route, which exposes the
// tenant clients (with wallet.points) and wallet movements. The settings,
// levels and campaigns config sections are not yet exposed by the API, so they
// render the PHP defaults (see risks); the right-hand stats and "Top clienti"
// are computed from the live clients/wallet data.

type Wallet = { credit: number; points: number };

type FidelityClient = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  wallet?: Wallet;
};

type FidelityData = {
  ok: boolean;
  clients: FidelityClient[];
  movements: unknown[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function FidelityPointsContent() {
  const slug = tenantSlug();

  const [clients, setClients] = useState<FidelityClient[]>([]);
  const [loading, setLoading] = useState(true);

  // Settings form state (pre-filled from PHP defaults; API does not yet expose
  // saved fidelity settings — see risks).
  const [pointsEnabled, setPointsEnabled] = useState(true);
  const [expireEnabled, setExpireEnabled] = useState(false);
  const [expireDays, setExpireDays] = useState("365");
  const [expireWarnDays, setExpireWarnDays] = useState("30");
  const [redeemEnabled, setRedeemEnabled] = useState(false);
  const [redeemEuroPerPoint, setRedeemEuroPerPoint] = useState("0.1");
  const [redeemMinPoints, setRedeemMinPoints] = useState("0");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsFlash, setSettingsFlash] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: FidelityData) => {
        setClients(Array.isArray(j.clients) ? j.clients : []);
      })
      .catch(() => setClients([]))
      .finally(() => setLoading(false));
  }, [slug]);

  // Load the REAL saved fidelity points settings (was pre-filled with PHP defaults).
  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=points_settings`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const s = j?.settings;
        if (!s) return;
        setPointsEnabled(Boolean(s.pointsEnabled));
        setExpireEnabled(Boolean(s.expireEnabled));
        setExpireDays(String(s.expireDays ?? 365));
        setExpireWarnDays(String(s.expireWarnDays ?? 30));
        setRedeemEnabled(Boolean(s.redeemEnabled));
        setRedeemEuroPerPoint(String(s.redeemEuroPerPoint ?? 0.1));
        setRedeemMinPoints(String(s.redeemMinPoints ?? 0));
      })
      .catch(() => {});
  }, [slug]);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (savingSettings) return;
    setSavingSettings(true);
    setSettingsError("");
    setSettingsFlash("");
    try {
      // Le conferme legacy sono un round-trip: il server rifiuta con il testo del
      // popup ("Prima di disattivare ..." / "Prima di modificare la scadenza ...");
      // il confirm() dell'operatore fa ripartire il salvataggio coi flag.
      const extraFlags: Record<string, string> = {};
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "save_points_settings",
            fidelity_points_enabled: pointsEnabled ? "1" : "0",
            fidelity_expire_enabled: expireEnabled ? "1" : "0",
            fidelity_expire_days: expireDays,
            fidelity_expire_warn_days: expireWarnDays,
            fidelity_redeem_enabled: redeemEnabled ? "1" : "0",
            fidelity_redeem_euro_per_point: redeemEuroPerPoint,
            fidelity_redeem_min_points: redeemMinPoints,
            ...extraFlags,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j?.error) {
          const err = String(j?.error ?? "Impossibile salvare le impostazioni.");
          if (err.startsWith("Prima di disattivare") && !extraFlags.fidelity_disable_confirmed) {
            if (window.confirm(err)) { extraFlags.fidelity_disable_confirmed = "1"; continue; }
          } else if (err.startsWith("Prima di modificare la scadenza") && !extraFlags.fidelity_expiry_confirmed) {
            if (window.confirm(err)) { extraFlags.fidelity_expiry_confirmed = "1"; continue; }
          }
          setSettingsError(err);
        } else {
          setSettingsFlash(String(j?.settings?.message ?? "") || "Impostazioni Fidelity salvate");
        }
        break;
      }
    } finally {
      setSavingSettings(false);
    }
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`fidelity_points${suffix}`.replace("&", "?")}`;
  }

  function pageHref(page: string, suffix = ""): string {
    return `/${encodeURIComponent(slug)}/${`${page}${suffix}`.replace("&", "?")}`;
  }

  // Derived live stats from clients/wallet.points.
  const topClients = useMemo(
    () =>
      clients
        .map((c) => ({ id: c.id, name: c.name, points: Number(c.wallet?.points ?? 0) }))
        .filter((c) => c.points > 0)
        .sort((a, b) => b.points - a.points),
    [clients],
  );
  const totalPoints = useMemo(
    () => clients.reduce((sum, c) => sum + Number(c.wallet?.points ?? 0), 0),
    [clients],
  );
  const clientsWithPoints = topClients.length;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/fidelity_points.css" />

      <div className="alert alert-warning d-flex align-items-start gap-2">
        <div>
          <i className="bi bi-info-circle" />
        </div>
        <div>
          Punti Fidelity attivi, ma nessuna campagna punti attiva: i clienti non matureranno punti finche non riattivi o
          crei una campagna.
        </div>
      </div>

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">Punti</h1>
          <div className="bs-page-subtitle">Gestisci punti, livelli e campagne Fidelity.</div>
        </div>
      </div>

      {/* Confirm expiry change modal */}
      <div
        className="modal fade"
        id="fidelityExpiryConfirmModal"
        tabIndex={-1}
        aria-labelledby="fidelityExpiryConfirmModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1" id="fidelityExpiryConfirmModalLabel">
                  Confermare scadenza punti?
                </h5>
                <div className="text-muted small" id="fidelityExpiryConfirmSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning mb-3">
                <div className="fw-semibold mb-1">Riepilogo impatto</div>
                <div className="small" id="fidelityExpiryConfirmImpact">
                  I punti residui aperti verranno riallineati alla nuova impostazione di scadenza.
                </div>
              </div>
              <div className="card p-3 bg-light border">
                <div className="fw-semibold mb-1">Cosa non cambia</div>
                <div className="small text-muted">
                  Punti, movimenti e storico clienti gia registrati non verranno cancellati. I punti gia scaduti in
                  passato non verranno ripristinati.
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-primary btn-pill" id="fidelityExpiryConfirmBtn">
                <i className="bi bi-check2-circle me-1" />
                Conferma e salva
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Level delete preview modal */}
      <div
        className="modal fade"
        id="fidelityLevelDeletePreviewModal"
        tabIndex={-1}
        aria-labelledby="fidelityLevelDeletePreviewModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1" id="fidelityLevelDeletePreviewModalLabel">
                  Elimina livello card
                </h5>
                <div className="text-muted small" id="fidelityLevelDeletePreviewSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning mb-3" id="fidelityLevelDeletePreviewWarning">
                <div className="fw-semibold mb-1">Riepilogo impatto</div>
                <div className="small">
                  La rimozione sara applicata solo quando premi <strong>Salva livelli</strong>. Punti, movimenti e
                  storico clienti non verranno cancellati.
                </div>
              </div>
              <div id="fidelityLevelDeletePreviewBody">
                <div className="text-muted">Calcolo impatto in corso...</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-danger btn-pill" id="fidelityLevelDeletePreviewConfirm">
                <i className="bi bi-x-lg me-1" />
                Rimuovi livello
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Level threshold preview modal */}
      <div
        className="modal fade"
        id="fidelityLevelThresholdPreviewModal"
        tabIndex={-1}
        aria-labelledby="fidelityLevelThresholdPreviewModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1" id="fidelityLevelThresholdPreviewModalLabel">
                  Modifica livello card
                </h5>
                <div className="text-muted small" id="fidelityLevelThresholdPreviewSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning mb-3">
                <div className="fw-semibold mb-1">Riepilogo impatto</div>
                <div className="small">
                  La modifica dei punti necessari sara applicata solo quando premi <strong>Conferma e salva</strong>.
                  Punti, movimenti e storico clienti non verranno cancellati.
                </div>
              </div>
              <div id="fidelityLevelThresholdPreviewBody">
                <div className="text-muted">Calcolo impatto in corso...</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-primary btn-pill" id="fidelityLevelThresholdPreviewConfirm">
                <i className="bi bi-check2-circle me-1" />
                Conferma e salva
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Campaign toggle preview modal */}
      <div
        className="modal fade"
        id="fidelityCampaignTogglePreviewModal"
        tabIndex={-1}
        aria-labelledby="fidelityCampaignTogglePreviewModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1" id="fidelityCampaignTogglePreviewModalLabel">
                  Disattivare campagna punti?
                </h5>
                <div className="text-muted small" id="fidelityCampaignTogglePreviewSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div id="fidelityCampaignTogglePreviewBody">
                <div className="text-muted">Calcolo impatto in corso...</div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="button" className="btn btn-warning btn-pill" id="fidelityCampaignTogglePreviewConfirm">
                <i className="bi bi-pause-circle me-1" />
                Disattiva campagna
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Campaign delete preview modal */}
      <div
        className="modal fade"
        id="fidelityCampaignDeletePreviewModal"
        tabIndex={-1}
        aria-labelledby="fidelityCampaignDeletePreviewModalLabel"
        aria-hidden="true"
      >
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <form method="post" className="modal-content" id="fidCampaignDeleteForm">
            <input type="hidden" name="_mode" value="delete_fidelity_campaign" />
            <input type="hidden" name="campaign_id" id="fidCampaignDeleteId" value="" />
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1" id="fidelityCampaignDeletePreviewModalLabel">
                  Eliminare campagna punti?
                </h5>
                <div className="text-muted small" id="fidelityCampaignDeletePreviewSubtitle" />
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="alert alert-warning mb-3" id="fidelityCampaignDeletePreviewWarning">
                <div className="fw-semibold mb-1">Riepilogo impatto</div>
                <div className="small">
                  Se la campagna ha storico operativo, verra rimossa dall&apos;elenco e disattivata. Punti, movimenti,
                  prenotazioni, vendite, ricariche e saldi clienti non verranno cancellati.
                </div>
              </div>
              <div id="fidelityCampaignDeletePreviewBody">
                <div className="text-muted">Calcolo impatto in corso...</div>
              </div>
              <div className="mt-3">
                <label className="form-label" htmlFor="fidCampaignDeleteReason">
                  Motivo eliminazione <span className="text-muted">(opzionale)</span>
                </label>
                <input
                  className="form-control"
                  type="text"
                  id="fidCampaignDeleteReason"
                  name="delete_reason"
                  maxLength={255}
                  placeholder="Es. campagna sostituita"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-pill" data-bs-dismiss="modal">
                Annulla
              </button>
              <button type="submit" className="btn btn-danger btn-pill" id="fidelityCampaignDeletePreviewConfirm">
                <i className="bi bi-x-lg me-1" />
                Elimina campagna
              </button>
            </div>
          </form>
        </div>
      </div>

      <FidelityCampaignsSection slug={slug} />

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card p-4 ">
            <form className="row g-3" id="fidSettingsForm" onSubmit={saveSettings}>
              {settingsError ? <div className="col-12"><div className="alert alert-danger mb-0">{settingsError}</div></div> : null}
              {settingsFlash ? <div className="col-12"><div className="alert alert-success mb-0">{settingsFlash}</div></div> : null}

              <div className="col-12 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                <div>
                  <div className="h5 fw-bold mb-1">Impostazioni</div>
                  <div className="text-muted small">Abilitazione e regole di utilizzo dei punti.</div>
                </div>
                <div className="form-check form-switch m-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="fidPointsEnabled"
                    name="fidelity_points_enabled"
                    value="1"
                    data-saved-enabled="1"
                    checked={pointsEnabled}
                    onChange={(e) => setPointsEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="fidPointsEnabled">
                    Abilita Punti Fidelity
                  </label>
                </div>
              </div>

              <div className="col-12 fidOperationalSettings ">
                <div className="h6 fw-semibold mb-1">Automazioni e scadenza</div>
                <div className="text-muted small">Opzionale: scadenza punti.</div>
              </div>

              <div className="col-md-6 fidOperationalSettings ">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="fidExpire"
                    name="fidelity_expire_enabled"
                    value="1"
                    checked={expireEnabled}
                    onChange={(e) => setExpireEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="fidExpire">
                    Abilita scadenza punti
                  </label>
                  <div className="form-text">
                    Se attivo, i punti non utilizzati scadono automaticamente. (Suggerito: cron giornaliero{" "}
                    <code>cron/fidelity_expire.php</code>).
                  </div>
                </div>
              </div>

              <div className={`col-md-6 fidOperationalSettings fidExpireSettings${expireEnabled ? "" : " d-none"}`}>
                <label className="form-label">Scadenza dopo</label>
                <div className="input-group">
                  <input
                    className="form-control"
                    type="number"
                    min="0"
                    step="1"
                    name="fidelity_expire_days"
                    value={expireDays}
                    onChange={(e) => setExpireDays(e.target.value)}
                  />
                  <span className="input-group-text">giorni</span>
                </div>
                <div className="form-text">
                  I punti restano validi fino alle <strong>23:59</strong> del giorno calcolato.
                </div>
              </div>

              <div className={`col-md-6 fidOperationalSettings fidExpireSettings${expireEnabled ? "" : " d-none"}`}>
                <label className="form-label">Avviso scadenza entro</label>
                <div className="input-group">
                  <input
                    className="form-control"
                    type="number"
                    min="0"
                    step="1"
                    name="fidelity_expire_warn_days"
                    value={expireWarnDays}
                    onChange={(e) => setExpireWarnDays(e.target.value)}
                  />
                  <span className="input-group-text">giorni</span>
                </div>
                <div className="form-text">
                  Mostrato in scheda cliente e area clienti (punti in scadenza entro X giorni). 0 = solo scadenze di
                  oggi. L&apos;avviso scatta dall&apos;inizio della giornata calcolata.
                </div>
              </div>

              <div className="col-12 fidOperationalSettings ">
                <hr />
              </div>

              <div className="col-12 fidOperationalSettings ">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="fidRedeem"
                    name="fidelity_redeem_enabled"
                    value="1"
                    checked={redeemEnabled}
                    onChange={(e) => setRedeemEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="fidRedeem">
                    Abilita sconto tramite punti
                  </label>
                  <div className="form-text">
                    Se attivo, i punti possono essere usati come sconto (in cassa e in prenotazione).
                  </div>
                </div>
              </div>

              <div className={`col-md-6 fidOperationalSettings fidRedeemSettings${redeemEnabled ? "" : " d-none"}`}>
                <label className="form-label">Valore sconto punti</label>
                <div className="input-group">
                  <span className="input-group-text">1 punto =</span>
                  <input
                    className="form-control"
                    type="number"
                    step="0.01"
                    min="0"
                    name="fidelity_redeem_euro_per_point"
                    value={redeemEuroPerPoint}
                    onChange={(e) => setRedeemEuroPerPoint(e.target.value)}
                  />
                  <span className="input-group-text">EUR di sconto</span>
                </div>
                <div className="form-text">
                  Questo campo determina solo quanto vale 1 punto quando viene usato come sconto. Non determina i punti
                  guadagnati. Esempio: 0,50EUR -&gt; 10 punti = 5EUR di sconto.
                </div>
              </div>

              <div className={`col-md-6 fidOperationalSettings fidRedeemSettings${redeemEnabled ? "" : " d-none"}`}>
                <label className="form-label">Minimo punti</label>
                <input
                  className="form-control"
                  type="number"
                  min="0"
                  step="1"
                  name="fidelity_redeem_min_points"
                  value={redeemMinPoints}
                  onChange={(e) => setRedeemMinPoints(e.target.value)}
                />
              </div>

              <div className={`col-12 fidOperationalSettings fidRedeemSettings${redeemEnabled ? "" : " d-none"}`}>
                <hr />
              </div>

              <div className="col-12 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit" disabled={savingSettings}>
                  <i className="bi bi-check2-circle me-1" />
                  {savingSettings ? "Salvataggio…" : "Salva"}
                </button>
                <a className="btn btn-outline-secondary btn-pill" href={href("")}>
                  Annulla
                </a>
              </div>
            </form>
          </div>

          <div className="card p-4 mt-3 fidCampaignsCard " id="livelli-card" data-levels-card="1">
            <form
              method="post"
              action={pageHref("fidelity_levels")}
              className="row g-3"
              id="fidLevelsInlineForm"
            >
              <input type="hidden" name="_mode" value="save_levels" />
              <input type="hidden" name="return_page" value="fidelity_points" />
              <input type="hidden" name="fidelity_levels_enabled" value="1" />
              <input type="hidden" name="fidelity_levels_points_enabled" value="1" />

              <div className="col-12 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                <div>
                  <div className="h5 fw-bold m-0">Livelli Card</div>
                  <div className="text-muted small">
                    Definisci i livelli usati dalle campagne punti e dai vantaggi Fidelity.
                  </div>
                </div>
              </div>

              <div className="col-12">
                <div className="alert alert-danger d-none mb-0" id="fidLevelsInlineError" role="alert" />
              </div>

              <div className="col-12">
                <div id="fidPointsLevelsList" className="d-flex flex-column gap-2">
                  <div
                    className="row g-2 align-items-end fidPointsLevelRow"
                    data-level-family="points"
                    data-level-key="bronze"
                    data-level-name="Bronze"
                    data-base-level="1"
                  >
                    <input type="hidden" name="fidelity_points_level_keys[]" value="bronze" />

                    <div className="col-md-5">
                      <label className="form-label">Nome livello</label>
                      <input
                        className="form-control"
                        name="fidelity_points_level_names[]"
                        defaultValue="Bronze"
                        placeholder="Es. Base"
                      />
                    </div>

                    <input type="hidden" name="fidelity_points_level_points[]" value="0" />
                    <div className="col-md-7">
                      <div className="form-text text-muted mb-2">
                        Livello base predefinito: non eliminabile, punti bloccati a 0. Puoi modificare solo il nome.
                      </div>
                    </div>
                  </div>

                  <div
                    className="row g-2 align-items-end fidPointsLevelRow"
                    data-level-family="points"
                    data-level-key="silver"
                    data-level-name="Silver"
                    data-base-level="0"
                  >
                    <input type="hidden" name="fidelity_points_level_keys[]" value="silver" />

                    <div className="col-md-5">
                      <label className="form-label">Nome livello</label>
                      <input
                        className="form-control"
                        name="fidelity_points_level_names[]"
                        defaultValue="Silver"
                        placeholder="Es. Base"
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Punti necessari</label>
                      <div className="input-group">
                        <input
                          className="form-control"
                          type="number"
                          min="0"
                          step="1"
                          name="fidelity_points_level_points[]"
                          defaultValue="200"
                        />
                        <span className="input-group-text">Punti</span>
                      </div>
                    </div>

                    <div className="col-md-1 d-grid">
                      <button type="button" className="btn btn-outline-danger btn-sm fidPointsLevelRemove" title="Rimuovi">
                        <i className="bi bi-x-lg" />
                      </button>
                    </div>
                  </div>

                  <div
                    className="row g-2 align-items-end fidPointsLevelRow"
                    data-level-family="points"
                    data-level-key="gold"
                    data-level-name="Gold"
                    data-base-level="0"
                  >
                    <input type="hidden" name="fidelity_points_level_keys[]" value="gold" />

                    <div className="col-md-5">
                      <label className="form-label">Nome livello</label>
                      <input
                        className="form-control"
                        name="fidelity_points_level_names[]"
                        defaultValue="Gold"
                        placeholder="Es. Base"
                      />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">Punti necessari</label>
                      <div className="input-group">
                        <input
                          className="form-control"
                          type="number"
                          min="0"
                          step="1"
                          name="fidelity_points_level_points[]"
                          defaultValue="500"
                        />
                        <span className="input-group-text">Punti</span>
                      </div>
                    </div>

                    <div className="col-md-1 d-grid">
                      <button type="button" className="btn btn-outline-danger btn-sm fidPointsLevelRemove" title="Rimuovi">
                        <i className="bi bi-x-lg" />
                      </button>
                    </div>
                  </div>
                </div>

                <template id="fidPointsLevelTpl">
                  <div
                    className="row g-2 align-items-end fidPointsLevelRow mt-2"
                    data-level-family="points"
                    data-level-key=""
                    data-level-name=""
                  >
                    <input type="hidden" name="fidelity_points_level_keys[]" value="" />
                    <div className="col-md-5">
                      <label className="form-label">Nome livello</label>
                      <input className="form-control" name="fidelity_points_level_names[]" defaultValue="" placeholder="Es. Gold" />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Punti necessari</label>
                      <div className="input-group">
                        <input
                          className="form-control"
                          type="number"
                          min="0"
                          step="1"
                          name="fidelity_points_level_points[]"
                          defaultValue=""
                          placeholder="Es. 200"
                        />
                        <span className="input-group-text">Punti</span>
                      </div>
                    </div>
                    <div className="col-md-1 d-grid">
                      <button type="button" className="btn btn-outline-danger btn-sm fidPointsLevelRemove" title="Rimuovi">
                        <i className="bi bi-x-lg" />
                      </button>
                    </div>
                  </div>
                </template>
              </div>

              <div className="col-12 d-flex flex-wrap gap-2">
                <button type="button" className="btn btn-outline-primary btn-sm" id="fidPointsLevelAdd">
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi livello
                </button>
                <button className="btn btn-primary btn-sm" type="submit">
                  <i className="bi bi-check2-circle me-1" />
                  Salva livelli
                </button>
              </div>
            </form>
          </div>

          <div className="card p-4 mt-3 fidCampaignsCard ">
            <div className="d-flex justify-content-between align-items-center mb-2">
              <div>
                <div className="h5 fw-bold m-0">Campagne punti</div>
                <div className="text-muted small">
                  Crea campagne temporanee o sempre attive. Una sola campagna puo essere attiva nello stesso periodo.
                </div>
              </div>
              <a className="btn btn-sm btn-outline-primary" href={href("&new_campaign=1")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova campagna
              </a>
            </div>

            <div className="small text-muted mb-2">
              Campagna attiva oggi: <span className="badge text-bg-secondary">Nessuna</span>
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
                  <tr>
                    <td colSpan={5} className="text-muted p-2">
                      Nessuna campagna punti configurata.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col-lg-5 ">
          <div className="text-muted small mb-2">
            Statistiche operative sede: <strong>Sede1</strong>
          </div>
          <div className="row g-3">
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti emessi</div>
                <div className="h4 fw-bold m-0">0</div>
              </div>
            </div>
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti usati</div>
                <div className="h4 fw-bold m-0">0</div>
              </div>
            </div>

            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti scaduti</div>
                <div className="h4 fw-bold m-0">0</div>
              </div>
            </div>
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Saldo totale globale</div>
                <div className="h4 fw-bold m-0">{loading ? 0 : totalPoints}</div>
              </div>
            </div>

            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Campagne attive</div>
                <div className="h4 fw-bold m-0">0</div>
              </div>
            </div>
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Clienti con punti globali</div>
                <div className="h4 fw-bold m-0">{loading ? 0 : clientsWithPoints}</div>
              </div>
            </div>
          </div>

          <div className="card p-3 mt-3">
            <div className="fw-semibold mb-2">Top clienti</div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th className="text-end">Punti</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {topClients.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted p-2">
                        Nessun cliente con punti.
                      </td>
                    </tr>
                  ) : (
                    topClients.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="text-end">{c.points}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" href={pageHref("clients", `&action=view&id=${c.id}`)}>
                            Apri
                          </a>
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

      {/* Movimenti spostati in pagina dedicata: Fidelity > Movimenti */}
    </div>
  );
}
