"use client";

import { useEffect, useMemo, useState } from "react";
import { FidelityCampaignsSection } from "@/components/modules/fidelity_campaigns-section";
import { FidelityLevelsContent } from "@/components/modules/fidelity_levels-content";

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

export function FidelityPointsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

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
  // Statistiche reali (emessi/usati/scaduti/campagne + campagna attiva oggi).
  const [stats, setStats] = useState<{ emitted: number; used: number; expired: number; activeCampaigns: number; activeCampaignToday: string } | null>(null);
  const [locationName, setLocationName] = useState("tutte le sedi");
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
        // KPI legacy della colonna destra (emessi/usati/scaduti/campagne attive).
        if (j?.stats) setStats(j.stats);
      })
      .catch(() => {});
    // Nome sede corrente per la caption "Statistiche operative sede: ...".
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.locations) ? j.locations : [];
        const current = list.find((l: { id: number }) => Number(l.id) === Number(j.currentLocationId));
        setLocationName(String(current?.name ?? "") || "tutte le sedi");
      })
      .catch(() => {});
  }, [slug]);

  // Le conferme legacy sono un round-trip: il server rifiuta con il testo del
  // popup ("Prima di disattivare ..." / "Prima di modificare la scadenza ...");
  // il MODALE legacy (disableRedeemConfirmModal / fidelityExpiryConfirmModal)
  // fa ripartire il salvataggio coi flag di conferma.
  const [confirmDialog, setConfirmDialog] = useState<{ kind: "redeem" | "expiry"; text: string } | null>(null);

  async function runSaveSettings(extraFlags: Record<string, string>) {
    setSavingSettings(true);
    setSettingsError("");
    setSettingsFlash("");
    try {
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
          setConfirmDialog({ kind: "redeem", text: err });
          return;
        }
        if (err.startsWith("Prima di modificare la scadenza") && !extraFlags.fidelity_expiry_confirmed) {
          setConfirmDialog({ kind: "expiry", text: err });
          return;
        }
        setSettingsError(err);
      } else {
        setSettingsFlash(String(j?.settings?.message ?? "") || "Impostazioni Fidelity salvate");
      }
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (savingSettings) return;
    await runSaveSettings({});
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

      {/* Banner legacy: SOLO quando i punti sono attivi ma nessuna campagna è
          attiva oggi (fidelity_points.php:3019). */}
      {pointsEnabled && stats && !stats.activeCampaignToday ? (
        <div className="alert alert-warning d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>
            Punti Fidelity attivi, ma nessuna campagna punti attiva: i clienti non matureranno punti finche non riattivi o
            crei una campagna.
          </div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">Punti</h1>
          <div className="bs-page-subtitle">Gestisci punti, livelli e campagne Fidelity.</div>
        </div>
      </div>

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

          {/* Editor Livelli Card INLINE come il legacy (fidelity_points.php
              #livelli-card): stesso componente della pagina dedicata, embedded. */}
          <FidelityLevelsContent slug={slug} embedded />

          {/* Ordine colonna sinistra legacy: Impostazioni -> Livelli Card ->
              Campagne punti (Card C, dentro col-lg-7 — non a tutta larghezza). */}
          <div className="mt-3">
            <FidelityCampaignsSection slug={slug} />
          </div>
        </div>

        <div className="col-lg-5 ">
          <div className="text-muted small mb-2">
            Statistiche operative sede: <strong>{locationName}</strong>
          </div>
          <div className="row g-3">
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti emessi</div>
                <div className="h4 fw-bold m-0">{stats?.emitted ?? 0}</div>
              </div>
            </div>
            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti usati</div>
                <div className="h4 fw-bold m-0">{stats?.used ?? 0}</div>
              </div>
            </div>

            <div className="col-6">
              <div className="card p-3">
                <div className="text-muted small">Punti scaduti</div>
                <div className="h4 fw-bold m-0">{stats?.expired ?? 0}</div>
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
                <div className="h4 fw-bold m-0">{stats?.activeCampaigns ?? 0}</div>
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
                          <a className="btn btn-sm btn-outline-secondary" href={pageHref("fidelity_wallet", `&client_id=${c.id}`)}>
                            Dettagli
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

      {/* MODALI di conferma legacy: disableRedeemConfirmModal ("Disattiva
          sconto tramite punti") e fidelityExpiryConfirmModal ("Confermare
          scadenza punti?") — il testo di impatto arriva dal server. */}
      {confirmDialog ? (
        <div
          className="modal fade show d-block"
          id={confirmDialog.kind === "redeem" ? "disableRedeemConfirmModal" : "fidelityExpiryConfirmModal"}
          tabIndex={-1}
          style={{ background: "rgba(0,0,0,.5)" }}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title fw-bold m-0">
                  {confirmDialog.kind === "redeem" ? "Disattiva sconto tramite punti" : "Confermare scadenza punti?"}
                </h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setConfirmDialog(null)} />
              </div>
              <div className="modal-body">
                <div className="fw-semibold">{confirmDialog.kind === "redeem" ? "Cosa succede continuando" : "Riepilogo impatto"}</div>
                <div className="text-muted small mt-1">{confirmDialog.text}</div>
                {confirmDialog.kind === "expiry" ? (
                  <>
                    <div className="fw-semibold mt-3">Cosa non cambia</div>
                    <div className="text-muted small mt-1">Storico movimenti, prenotazioni e vendite restano invariati.</div>
                  </>
                ) : null}
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setConfirmDialog(null)}>
                  Annulla
                </button>
                <button
                  className={`btn ${confirmDialog.kind === "redeem" ? "btn-warning" : "btn-primary"}`}
                  type="button"
                  disabled={savingSettings}
                  onClick={() => {
                    const flag: Record<string, string> = confirmDialog.kind === "redeem" ? { fidelity_disable_confirmed: "1" } : { fidelity_expiry_confirmed: "1" };
                    setConfirmDialog(null);
                    void runSaveSettings(flag);
                  }}
                >
                  {confirmDialog.kind === "redeem" ? "Conferma disattivazione" : "Conferma e salva"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
