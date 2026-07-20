"use client";

import { useEffect, useState } from "react";
import InfoBox from "./info-box";
import { FidelityCampaignsSection } from "@/components/modules/fidelity_campaigns-section";
import { FidelityLevelsContent } from "@/components/modules/fidelity_levels-content";

// Port fedele della pagina Punti (app/pages/fidelity_points.php):
// - stato "Fidelity disattivata" (empty state con link Impostazione generale)
//   quando il toggle generale è spento;
// - form Impostazioni (Abilita Punti + scadenza + sconto tramite punti) con le
//   CONFERME legacy client-side: modale "Disattiva Punti Fidelity / Disattiva
//   sconto tramite punti" col pannello "Prenotazioni coinvolte" e la modale
//   scadenza "Attivare/Disattivare/Aggiornare scadenza punti?";
// - editor Livelli Card inline + sezione Campagne punti;
// - colonna destra: KPI legacy filtrati sulla sede corrente (tessere attive)
//   e Top clienti (10) con link al Portafoglio.
// Ogni POST fa redirect flash ?msg/?err come il PHP.

type FidelityPointsQuery = { msg?: string; err?: string };

type ImpactedAppointment = {
  id: number;
  publicCode: string;
  startsAt: string;
  endsAt: string;
  status: string;
  clientName: string;
  servicesLabel: string;
  pointsUsed: number;
  pointsDiscount: number;
  giftPointsUsed: number;
  giftIdx: number | null;
  conflictChoice: string;
};

type Stats = {
  emitted: number;
  used: number;
  expired: number;
  balance: number;
  clientsWithPoints: number;
  activeCampaigns: number;
  activeCampaignToday: string;
  topClients: Array<{ id: number; name: string; points: number }>;
  hasTxLocation: boolean;
};

const FID_LABEL = "Punti";

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// fmt_points legacy: intero troncato ('0' quando ~0).
function fmtPoints(v: number): string {
  const n = Number(v) || 0;
  if (!Number.isFinite(n) || Math.abs(n) < 0.0000001) return "0";
  return String(n > 0 ? Math.floor(n + 0.000000001) : Math.ceil(n - 0.000000001));
}

// fmt_money legacy: 2 decimali, virgola, punto per le migliaia.
function fmtMoney(v: number): string {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// Etichetta data legacy di QUESTA pagina (varianti ASCII: ' - HH:MM' stesso
// giorno, ' -> d/m/Y H:i' altrimenti).
function apptDateLabel(startsAt: string, endsAt: string): string {
  if (startsAt === "") return "Data non disponibile";
  const d = startsAt.slice(0, 10);
  const dmy = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  let label = `${dmy(startsAt)} ${startsAt.slice(11, 16)}`;
  if (endsAt !== "") {
    if (endsAt.slice(0, 10) === d) label += ` - ${endsAt.slice(11, 16)}`;
    else label += ` -> ${dmy(endsAt)} ${endsAt.slice(11, 16)}`;
  }
  return label;
}

// Pannello legacy "Prenotazioni coinvolte" (fidelity_page_render_impacted_
// appointments_panel, variante ASCII della pagina Punti).
function ImpactedAppointmentsPanel({ appointments, slug }: { appointments: ImpactedAppointment[]; slug: string }) {
  if (appointments.length === 0) return null;
  return (
    <div className="card mb-3">
      <div className="px-3 py-2 border-bottom bg-light">
        <div className="fw-semibold">Prenotazioni coinvolte</div>
        <div className="small text-muted">Visualizzate fino a 3 prenotazioni alla volta. Scorri per vedere le altre.</div>
      </div>
      <div className="overflow-auto points-appointments-scroll">
        <div className="list-group list-group-flush">
          {appointments.map((appt) => {
            const statusLabel = appt.status === "scheduled" ? "Prenotato" : "In sospeso";
            const statusClass = appt.status === "scheduled" ? "text-bg-primary" : "text-bg-warning";
            const client = appt.clientName !== "" ? appt.clientName : "Cliente non disponibile";
            const services = appt.servicesLabel !== "" ? appt.servicesLabel : "Servizi non disponibili";
            return (
              <div className="list-group-item py-3" key={appt.id}>
                <div className="d-flex justify-content-between align-items-start gap-3">
                  <div className="flex-grow-1 points-min-width-0">
                    <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                      <div className="fw-semibold">Prenotazione #{appt.publicCode}</div>
                      <span className={`badge ${statusClass}`}>{statusLabel}</span>
                    </div>
                    <div className="small text-muted mb-1">
                      {apptDateLabel(appt.startsAt, appt.endsAt)}
                      {client !== "" ? <> - {client}</> : null}
                    </div>
                    <div className="small text-muted d-block text-truncate mb-1" title={services}>
                      {services}
                    </div>
                    <div className="small d-flex flex-wrap gap-3">
                      {appt.pointsUsed > 0.00001 || appt.pointsDiscount > 0.00001 ? (
                        <span>
                          {appt.pointsUsed > 0.00001 ? (
                            <>
                              Punti:{" "}
                              <strong>
                                {fmtPoints(appt.pointsUsed)} {FID_LABEL}
                              </strong>
                              {appt.pointsDiscount > 0.00001 ? (
                                <>
                                  {" "}
                                  - sconto <strong>EUR {fmtMoney(appt.pointsDiscount)}</strong>
                                </>
                              ) : null}
                            </>
                          ) : (
                            <>
                              Sconto punti: <strong>EUR {fmtMoney(appt.pointsDiscount)}</strong>
                            </>
                          )}
                        </span>
                      ) : null}
                      {appt.giftPointsUsed > 0.00001 || appt.giftIdx !== null || appt.conflictChoice !== "" ? (
                        <span>
                          gift/scelta Fidelity:{" "}
                          <strong>
                            {appt.giftPointsUsed > 0.00001
                              ? `${fmtPoints(appt.giftPointsUsed)} ${FID_LABEL}`
                              : appt.giftIdx !== null
                                ? "prenotato"
                                : appt.conflictChoice === "later"
                                  ? "scelta in negozio"
                                  : "collegata"}
                          </strong>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <a
                      className="btn btn-sm btn-outline-primary"
                      href={`/${encodeURIComponent(slug)}/appointments?action=edit&id=${appt.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <i className="bi bi-box-arrow-up-right me-1" />
                      Apri
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function FidelityPointsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: FidelityPointsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [loaded, setLoaded] = useState(false);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [canPoints, setCanPoints] = useState(true);
  const [canLevels, setCanLevels] = useState(true);
  const [canFidelityManage, setCanFidelityManage] = useState(false);
  const [savedPointsEnabled, setSavedPointsEnabled] = useState(true);
  const [savedRedeemEnabled, setSavedRedeemEnabled] = useState(false);
  const [savedExpireEnabled, setSavedExpireEnabled] = useState(false);
  const [savedExpireDays, setSavedExpireDays] = useState(365);
  const [savedEarnStep, setSavedEarnStep] = useState(10);
  const [redeemImpacted, setRedeemImpacted] = useState<ImpactedAppointment[]>([]);
  const [currentLocationId, setCurrentLocationId] = useState(0);

  const [pointsEnabled, setPointsEnabled] = useState(true);
  const [expireEnabled, setExpireEnabled] = useState(false);
  const [expireDays, setExpireDays] = useState("365");
  const [expireWarnDays, setExpireWarnDays] = useState("30");
  const [redeemEnabled, setRedeemEnabled] = useState(false);
  const [redeemEuroPerPoint, setRedeemEuroPerPoint] = useState("0.1");
  const [redeemMinPoints, setRedeemMinPoints] = useState("0");
  const [savingSettings, setSavingSettings] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [locationName, setLocationName] = useState("Tutte le sedi");

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Modali conferma legacy (client-side come fidelity_points.js): la variante
  // redeem/points e la variante scadenza enable/disable/days.
  const [redeemModalOpen, setRedeemModalOpen] = useState(false);
  const [expiryModalOpen, setExpiryModalOpen] = useState<null | "enable" | "disable" | "days">(null);
  const [pendingConfirms, setPendingConfirms] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=points_settings`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const s = j?.settings;
        if (!s) return;
        setGlobalEnabled(Boolean(s.globalEnabled));
        setPointsEnabled(Boolean(s.pointsEnabled));
        setSavedPointsEnabled(Boolean(s.pointsEnabled));
        setExpireEnabled(Boolean(s.expireEnabled));
        setSavedExpireEnabled(Boolean(s.expireEnabled));
        setExpireDays(String(s.expireDays ?? 365));
        setSavedExpireDays(Number(s.expireDays ?? 365));
        setExpireWarnDays(String(s.expireWarnDays ?? 30));
        setRedeemEnabled(Boolean(s.redeemEnabled));
        setSavedRedeemEnabled(Boolean(s.redeemEnabled));
        setRedeemEuroPerPoint(String(s.redeemEuroPerPoint ?? 0.1));
        setRedeemMinPoints(String(s.redeemMinPoints ?? 0));
        setSavedEarnStep(Number(s.earnStepEuro ?? 10) || 10);
        if (j?.stats) setStats(j.stats);
        setRedeemImpacted(Array.isArray(j?.redeemImpacted) ? j.redeemImpacted : []);
        setCurrentLocationId(Number(j?.currentLocationId ?? 0));
        if (typeof j?.canPoints === "boolean") setCanPoints(j.canPoints);
        if (typeof j?.canLevels === "boolean") setCanLevels(j.canLevels);
        setCanFidelityManage(j?.canFidelityManage === true);
        setLoaded(true);
      })
      .catch(() => {});
    // Nome sede corrente per la caption "Statistiche operative sede: ...".
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.locations) ? j.locations : [];
        const current = list.find((l: { id: number }) => Number(l.id) === Number(j.currentLocationId));
        setLocationName(String(current?.name ?? "") || "Tutte le sedi");
      })
      .catch(() => {});
  }, [slug]);

  function pageUrl(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }

  // POST + redirect flash legacy (save_settings fa sempre redirect ?msg/?err).
  async function runSaveSettings(extraFlags: Record<string, string>) {
    setSavingSettings(true);
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
        window.location.href = pageUrl(`fidelity_points?err=${encodeURIComponent(String(j?.error ?? "Errore salvataggio."))}`);
        return;
      }
      window.location.href = pageUrl(`fidelity_points?msg=${encodeURIComponent(String(j?.settings?.message ?? "") || "Impostazioni Fidelity salvate")}`);
    } catch {
      setSavingSettings(false);
    }
  }

  // Interception client-side come fidelity_points.js: prima la conferma
  // redeem/points (se ci sono prenotazioni coinvolte), poi quella scadenza.
  const disablingPoints = savedPointsEnabled && !pointsEnabled;
  const disablingRedeem = savedPointsEnabled && savedRedeemEnabled && !(pointsEnabled && redeemEnabled) && !disablingPoints;
  function expiryChangeType(): null | "enable" | "disable" | "days" {
    const nextDays = Math.max(0, Math.round(Number(expireDays) || 0));
    if (savedExpireEnabled !== expireEnabled) return expireEnabled ? "enable" : "disable";
    if (expireEnabled && savedExpireDays !== nextDays) return "days";
    return null;
  }

  function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (savingSettings) return;
    const flags: Record<string, string> = {};
    if ((disablingPoints || disablingRedeem) && redeemImpacted.length > 0 && !flags.disable_redeem_appointments_confirmed) {
      setPendingConfirms(flags);
      setRedeemModalOpen(true);
      return;
    }
    const expiryType = expiryChangeType();
    if (expiryType) {
      setPendingConfirms(flags);
      setExpiryModalOpen(expiryType);
      return;
    }
    void runSaveSettings(flags);
  }

  function confirmRedeemModal() {
    const flags = { ...pendingConfirms, disable_redeem_appointments_confirmed: "1" };
    setRedeemModalOpen(false);
    const expiryType = expiryChangeType();
    if (expiryType) {
      setPendingConfirms(flags);
      setExpiryModalOpen(expiryType);
      return;
    }
    void runSaveSettings(flags);
  }

  function confirmExpiryModal() {
    const flags = { ...pendingConfirms, expiry_settings_confirmed: "1" };
    setExpiryModalOpen(null);
    void runSaveSettings(flags);
  }

  const levelsOnlyView = !canPoints && canLevels;
  const showDisabledState = loaded && !globalEnabled;

  const expiryTexts = {
    enable: {
      title: "Attivare scadenza punti?",
      subtitle: "La regola verra applicata ai punti residui aperti.",
      impact: "I punti residui ancora disponibili riceveranno una scadenza calcolata da oggi. I nuovi punti avranno la stessa regola.",
    },
    disable: {
      title: "Disattivare scadenza punti?",
      subtitle: "La scadenza verra rimossa dai punti residui aperti.",
      impact: "I punti residui ancora disponibili non avranno piu una data di scadenza. I punti gia scaduti in passato non verranno ripristinati.",
    },
    days: {
      title: "Aggiornare scadenza punti?",
      subtitle: "La nuova durata verra applicata ai punti residui aperti.",
      impact: "La scadenza dei punti residui ancora disponibili verra ricalcolata da oggi usando il nuovo numero di giorni.",
    },
  } as const;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/fidelity_points.css" />

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.err}</div>
        </div>
      ) : null}

      {/* Banner legacy: punti operativi ma NESSUNA campagna attiva
          (fidelity_points.php:3018 — conteggio campagne attive, non "oggi"). */}
      {loaded && globalEnabled && pointsEnabled && stats && stats.activeCampaigns <= 0 ? (
        <div className="alert alert-warning d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>
            Punti Fidelity attivi, ma nessuna campagna punti attiva: i clienti non matureranno punti finche non riattivi o
            crei una campagna.
          </div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">{levelsOnlyView ? "Livelli Card" : "Punti"}</h1>
          <div className="bs-page-subtitle">Gestisci punti, livelli e campagne Fidelity.</div>
        </div>
      </div>

      {showDisabledState ? (
        /* Stato legacy "Fidelity disattivata" (points-disabled-card). */
        <div className="card border-0 shadow-sm points-disabled-card">
          <div className="points-disabled-state">
            <img src="/assets/img/empty-promotions.svg" alt="Fidelity disattivata" />
            <h2>Fidelity disattivata</h2>
            <p>
              {levelsOnlyView
                ? "Per configurare i livelli card, la Fidelity generale deve essere attiva."
                : "Per configurare punti, scadenze e campagne devi prima attivare la Fidelity generale."}
            </p>
            {canFidelityManage ? (
              <div className="d-flex justify-content-center gap-2 flex-wrap">
                <a className="btn btn-primary" href={pageUrl("fidelity")}>
                  <i className="bi bi-gear me-1" />
                  Impostazione generale
                </a>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="row g-3">
          <div className="col-lg-7">
            <div className={`card p-4${levelsOnlyView ? " d-none" : ""}`}>
              <form className="row g-3" id="fidSettingsForm" onSubmit={saveSettings}>
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
                      data-saved-enabled={savedPointsEnabled ? "1" : "0"}
                      checked={pointsEnabled}
                      onChange={(e) => setPointsEnabled(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="fidPointsEnabled">
                      Abilita Punti Fidelity
                    </label>
                  </div>
                </div>

                <div className={`col-12 fidOperationalSettings${pointsEnabled ? "" : " d-none"}`}>
                  <div className="h6 fw-semibold mb-1">Automazioni e scadenza</div>
                  <div className="text-muted small">Opzionale: scadenza punti.</div>
                </div>

                <div className={`col-md-6 fidOperationalSettings${pointsEnabled ? "" : " d-none"}`}>
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

                <div className={`col-md-6 fidOperationalSettings fidExpireSettings${pointsEnabled && expireEnabled ? "" : " d-none"}`}>
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

                <div className={`col-md-6 fidOperationalSettings fidExpireSettings${pointsEnabled && expireEnabled ? "" : " d-none"}`}>
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

                <div className={`col-12 fidOperationalSettings${pointsEnabled ? "" : " d-none"}`}>
                  <hr />
                </div>

                <div className={`col-12 fidOperationalSettings${pointsEnabled ? "" : " d-none"}`}>
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

                <div className={`col-md-6 fidOperationalSettings fidRedeemSettings${pointsEnabled && redeemEnabled ? "" : " d-none"}`}>
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

                <div className={`col-md-6 fidOperationalSettings fidRedeemSettings${pointsEnabled && redeemEnabled ? "" : " d-none"}`}>
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

                <div className={`col-12 fidOperationalSettings fidRedeemSettings${pointsEnabled && redeemEnabled ? "" : " d-none"}`}>
                  <hr />
                </div>

                <div className="col-12 d-flex gap-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={savingSettings}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva
                  </button>
                  <a className="btn btn-outline-secondary btn-pill" href={pageUrl("fidelity_points")}>
                    Annulla
                  </a>
                </div>
              </form>
            </div>

            {/* Editor Livelli Card INLINE come il legacy (fidelity_points.php
                #livelli-card): stesso componente della pagina dedicata, embedded. */}
            <FidelityLevelsContent slug={slug} embedded />

            {/* Ordine colonna sinistra legacy: Impostazioni -> Livelli Card ->
                Campagne punti (nascoste quando i punti sono disattivati). */}
            {!levelsOnlyView && pointsEnabled ? (
              <div className="mt-3">
                <FidelityCampaignsSection slug={slug} defaultEarnStep={savedEarnStep} />
              </div>
            ) : null}
          </div>

          <div className={`col-lg-5${levelsOnlyView ? " d-none" : ""}`}>
            <div className="text-muted small mb-2">
              Statistiche operative sede: <strong>{stats?.hasTxLocation ? locationName : "tutte le sedi"}</strong>
            </div>
            <div className="row g-3">
              <div className="col-6">
                <div className="card p-3">
                  <div className="text-muted small">Punti emessi</div>
                  <div className="h4 fw-bold m-0">{fmtPoints(stats?.emitted ?? 0)}</div>
                </div>
              </div>
              <div className="col-6">
                <div className="card p-3">
                  <div className="text-muted small">Punti usati</div>
                  <div className="h4 fw-bold m-0">{fmtPoints(stats?.used ?? 0)}</div>
                </div>
              </div>

              <div className="col-6">
                <div className="card p-3">
                  <div className="text-muted small">Punti scaduti</div>
                  <div className="h4 fw-bold m-0">{fmtPoints(stats?.expired ?? 0)}</div>
                </div>
              </div>
              <div className="col-6">
                <div className="card p-3">
                  <div className="text-muted small">Saldo totale globale</div>
                  <div className="h4 fw-bold m-0">{fmtPoints(stats?.balance ?? 0)}</div>
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
                  <div className="h4 fw-bold m-0">{stats?.clientsWithPoints ?? 0}</div>
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
                      <th className="text-end">{FID_LABEL}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(stats?.topClients ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-muted p-2">
                          Nessun cliente con punti.
                        </td>
                      </tr>
                    ) : (
                      (stats?.topClients ?? []).map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td className="text-end fw-bold">{fmtPoints(c.points)}</td>
                          <td className="text-end">
                            <a
                              className="btn btn-sm btn-outline-secondary"
                              href={pageUrl(`fidelity_wallet?client_id=${c.id}${currentLocationId > 0 ? `&location_id=${currentLocationId}` : ""}`)}
                            >
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
      )}

      {/* ===== Modale conferma redeem/points (disableRedeemConfirmModal) ===== */}
      {redeemModalOpen ? (
        <>
          <div className="modal fade show d-block" id="disableRedeemConfirmModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-xl modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="disableRedeemConfirmModalLabel">
                    {disablingPoints ? "Disattiva Punti Fidelity" : "Disattiva sconto tramite punti"}
                  </h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setRedeemModalOpen(false)} />
                </div>

                <div className="modal-body flex-grow-1 overflow-auto points-modal-scroll-body">
                  <div className="alert alert-warning">
                    <div className="fw-semibold mb-1" id="disableRedeemIntroTitle">
                      {disablingPoints ? "Prenotazioni aperte con sconto/scelta punti attiva" : "Prenotazioni aperte con sconto/scelta punti"}
                    </div>
                    <div className="small">
                      Sono presenti <strong>{redeemImpacted.length}</strong> {redeemImpacted.length === 1 ? "prenotazione" : "prenotazioni"} in stato{" "}
                      <strong>In sospeso</strong> / <strong>Prenotato</strong> con sconto/scelta punti Fidelity gia collegata.
                    </div>
                  </div>

                  <ImpactedAppointmentsPanel appointments={redeemImpacted} slug={slug} />

                  <div className="card p-3 border-warning-subtle bg-warning-subtle">
                    <div className="fw-semibold mb-1" id="disableRedeemImpactTitle">
                      {disablingPoints ? "Cosa succede disattivando Punti Fidelity" : "Cosa succede disattivando lo sconto tramite punti"}
                    </div>
                    <div className="form-text m-0" id="disableRedeemImpactText">
                      {disablingPoints
                        ? "Gli sconti/scelte punti verranno rimossi automaticamente dalle prenotazioni aperte coinvolte. Le campagne punti attive verranno disattivate. Saldo punti, movimenti e storico resteranno salvati."
                        : "Gli sconti/scelte punti verranno rimossi automaticamente dalle prenotazioni aperte coinvolte. I punti torneranno disponibili; saldo punti, movimenti e storico resteranno salvati."}
                    </div>
                  </div>
                </div>

                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setRedeemModalOpen(false)}>
                    Annulla
                  </button>
                  <button type="button" className="btn btn-danger" id="disableRedeemConfirmBtn" disabled={savingSettings} onClick={confirmRedeemModal}>
                    <i className="bi bi-check2-circle me-1" />
                    Conferma disattivazione
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {/* ===== Modale conferma scadenza (fidelityExpiryConfirmModal) ===== */}
      {expiryModalOpen ? (
        <>
          <div className="modal fade show d-block" id="fidelityExpiryConfirmModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <h5 className="modal-title mb-1" id="fidelityExpiryConfirmModalLabel">{expiryTexts[expiryModalOpen].title}</h5>
                    <div className="text-muted small" id="fidelityExpiryConfirmSubtitle">{expiryTexts[expiryModalOpen].subtitle}</div>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setExpiryModalOpen(null)} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning mb-3">
                    <div className="fw-semibold mb-1">Riepilogo impatto</div>
                    <div className="small" id="fidelityExpiryConfirmImpact">{expiryTexts[expiryModalOpen].impact}</div>
                  </div>
                  <div className="card p-3 bg-light border">
                    <div className="fw-semibold mb-1">Cosa non cambia</div>
                    <div className="small text-muted">
                      Punti, movimenti e storico clienti gia registrati non verranno cancellati. I punti gia scaduti in passato non verranno ripristinati.
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary btn-pill" onClick={() => setExpiryModalOpen(null)}>
                    Annulla
                  </button>
                  <button type="button" className="btn btn-primary btn-pill" id="fidelityExpiryConfirmBtn" disabled={savingSettings} onClick={confirmExpiryModal}>
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
      <InfoBox className="mt-3">
        <ul>
          <li>I punti si maturano in cassa secondo la campagna attiva: una sola campagna alla volta per periodo.</li>
          <li>Il livello Card è calcolato automaticamente dai punti maturati nel periodo: non si assegna a mano.</li>
          <li>Se la scadenza punti è attiva, i punti non usati scadono dopo i giorni impostati.</li>
        </ul>
      </InfoBox>
    </div>
  );
}
