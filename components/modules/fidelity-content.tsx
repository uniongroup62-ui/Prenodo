"use client";

import { useEffect, useState } from "react";
import InfoBox from "./info-box";
import { flashNavigate, useTakenFlash } from "./flash";

// Port fedele della pagina Fidelity (app/pages/fidelity.php): card
// "Impostazione generale" con lo switch globale businesses.fidelity_enabled e
// il flusso di disattivazione legacy: submit intercettato (fidelity.js) quando
// si sta disattivando e c'è un impatto — modale 'campaigns' (info bloccante
// con le campagne Promozioni/Omaggi da disattivare prima) oppure modale
// 'appointments' (conferma con il pannello "Prenotazioni coinvolte" e la
// rimozione automatica delle agevolazioni). Ogni POST fa redirect flash
// ?msg/?err come il PHP.

type FidelityQuery = { msg?: string; err?: string };

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

type Impact = {
  blockingPromotions: Array<{ id: number; name: string }>;
  blockingGifts: Array<{ id: number; name: string }>;
  linkedAppointments: ImpactedAppointment[];
};

const FID_LABEL = "Punti"; // Fidelity::settings — nome punti fisso.

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

// Etichetta data legacy: d/m/Y H:i (- H:i stesso giorno, → d/m/Y H:i altrimenti).
function apptDateLabel(startsAt: string, endsAt: string): string {
  if (startsAt === "") return "Data non disponibile";
  const d = startsAt.slice(0, 10);
  const dmy = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  let label = `${dmy(startsAt)} ${startsAt.slice(11, 16)}`;
  if (endsAt !== "") {
    if (endsAt.slice(0, 10) === d) label += ` - ${endsAt.slice(11, 16)}`;
    else label += ` → ${dmy(endsAt)} ${endsAt.slice(11, 16)}`;
  }
  return label;
}

export function FidelityContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: FidelityQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [enabled, setEnabled] = useState(true);
  const [wasEnabled, setWasEnabled] = useState(false);
  const [impact, setImpact] = useState<Impact>({ blockingPromotions: [], blockingGifts: [], linkedAppointments: [] });
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=state`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (typeof j?.enabled === "boolean") {
          setEnabled(j.enabled);
          setWasEnabled(j.enabled);
        }
        if (j?.impact) {
          setImpact({
            blockingPromotions: Array.isArray(j.impact.blockingPromotions) ? j.impact.blockingPromotions : [],
            blockingGifts: Array.isArray(j.impact.blockingGifts) ? j.impact.blockingGifts : [],
            linkedAppointments: Array.isArray(j.impact.linkedAppointments) ? j.impact.linkedAppointments : [],
          });
        }
      })
      .catch(() => {});
  }, [slug]);

  function pageUrl(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }

  // POST + redirect flash legacy (toggle_fidelity fa sempre redirect ?msg/?err).
  async function post(nextEnabled: boolean, confirmed: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "toggle", fidelity_enabled: nextEnabled ? "1" : "0", ...(confirmed ? { disable_appointments_confirmed: "1" } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        flashNavigate(pageUrl("fidelity"), { err: String(j?.error ?? "Errore salvataggio.") });
        return;
      }
      flashNavigate(pageUrl("fidelity"), { msg: String(j?.message ?? (nextEnabled ? "Fidelity attivata" : "Fidelity disattivata")) });
    } catch {
      setSaving(false);
      if (typeof window !== "undefined") window.alert("Errore di rete: operazione non eseguita. Riprova.");
    }
  }

  const hasBlockingCampaigns = impact.blockingPromotions.length > 0 || impact.blockingGifts.length > 0;
  const linkedCount = impact.linkedAppointments.length;
  // fidelity.js: la modale scatta solo disattivando (wasEnabled && !checked).
  const disableModalMode = hasBlockingCampaigns ? "campaigns" : linkedCount > 0 ? "appointments" : "";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (wasEnabled && !enabled && disableModalMode !== "") {
      setModalOpen(true);
      return;
    }
    void post(enabled, false);
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/fidelity.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelizzazione</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Fidelity</h1>
            <InfoBox>
              <p>
                L&apos;interruttore governa l&apos;<strong>intero programma Fidelity</strong>: adesione e tessere, punti,
                benefici in cassa e tutte le pagine collegate.
              </p>
              <ul>
                <li>
                  Alla disattivazione ti viene chiesta una conferma se esistono appuntamenti con benefici Fidelity
                  collegati.
                </li>
                <li>
                  Spegnendolo <strong>non perdi nulla</strong>: tessere, punti e campagne restano salvati e riattivandolo
                  ritrovi tutto com&apos;era.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Gestisci impostazioni generali e collegamenti del programma Fidelity.</div>
        </div>
      </div>

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

      <div className="card p-4 mb-3">
        <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
          <div>
            <div className="h5 fw-bold mb-1">Impostazione generale</div>
            <div className="text-muted small">
              Abilita o disabilita l&apos;intera funzione Fidelity. Quando &egrave; disattiva, le sezioni operative Fidelity
              vengono disabilitate; Ricariche e Portafoglio credito restano disponibili.
            </div>
          </div>
          <form className="d-flex align-items-center gap-3" id="fidToggleForm" onSubmit={onSubmit}>
            <div className="form-check form-switch m-0">
              <input
                className="form-check-input"
                type="checkbox"
                id="fidEnabledGlobal"
                name="fidelity_enabled"
                value="1"
                checked={enabled}
                disabled={saving}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <label className="form-check-label fw-semibold" htmlFor="fidEnabledGlobal">
                {enabled ? "Attivo" : "Disattivo"}
              </label>
            </div>
            <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              Salva
            </button>
          </form>
        </div>
      </div>

      {/* ===== Modale "Disattiva Fidelity" (due varianti legacy) ===== */}
      {modalOpen ? (
        <>
          <div className="modal fade show d-block" id="disableFidelityConfirmModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-xl modal-dialog-scrollable">
              {hasBlockingCampaigns ? (
                <div className="modal-content">
                  <div className="modal-header">
                    <h5 className="modal-title" id="disableFidelityConfirmModalLabel">Disattiva Fidelity</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setModalOpen(false)} />
                  </div>

                  <div className="modal-body flex-grow-1 overflow-auto fidelity-modal-scroll-body">
                    <div className="alert alert-warning">
                      <div className="fw-semibold mb-1">Disattiva prima le campagne collegate alla Fidelity</div>
                      <div className="small">
                        Per disattivare l&apos;impostazione generale <strong>Fidelity</strong> devi prima disattivare le campagne{" "}
                        <strong>Promozioni</strong> con target <strong>Clienti con Fidelity</strong> e le campagne <strong>Omaggi</strong>{" "}
                        con opzione <strong>Solo clienti con Fidelity</strong> attiva.
                      </div>
                    </div>

                    {impact.blockingPromotions.length > 0 ? (
                      <div className="card p-3 mb-3">
                        <div className="fw-semibold mb-2">Campagne Promozioni da disattivare</div>
                        <div className="d-flex flex-column gap-2">
                          {impact.blockingPromotions.map((promo) => (
                            <div className="small d-flex align-items-center gap-2" key={promo.id}>
                              <span className="badge text-bg-secondary">Promozione</span>
                              <span>{promo.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {impact.blockingGifts.length > 0 ? (
                      <div className="card p-3 mb-3">
                        <div className="fw-semibold mb-2">Campagne Omaggi da disattivare</div>
                        <div className="d-flex flex-column gap-2">
                          {impact.blockingGifts.map((giftCampaign) => (
                            <div className="small d-flex align-items-center gap-2" key={giftCampaign.id}>
                              <span className="badge text-bg-secondary">gift</span>
                              <span>{giftCampaign.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="small text-muted mb-0">
                      Disattiva prima le campagne elencate dalle relative sezioni <strong>Promozioni</strong> / <strong>Omaggi</strong>, poi torna
                      qui e salva la disattivazione generale.
                    </div>
                  </div>

                  <div className="modal-footer justify-content-between flex-wrap gap-2">
                    <div className="d-flex flex-wrap gap-2">
                      {impact.blockingPromotions.length > 0 ? (
                        <a className="btn btn-outline-primary" href={pageUrl("promotions")}>
                          Apri Promozioni
                        </a>
                      ) : null}
                      {impact.blockingGifts.length > 0 ? (
                        <a className="btn btn-outline-primary" href={pageUrl("gifts")}>
                          Apri Omaggi
                        </a>
                      ) : null}
                    </div>
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setModalOpen(false)}>
                      Chiudi
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  method="post"
                  className="modal-content"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post(false, true);
                  }}
                >
                  <div className="modal-header">
                    <h5 className="modal-title" id="disableFidelityConfirmModalLabel">Disattiva Fidelity</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setModalOpen(false)} />
                  </div>

                  <div className="modal-body flex-grow-1 overflow-auto fidelity-modal-scroll-body">
                    <div className="alert alert-warning">
                      <div className="fw-semibold mb-1">Prenotazioni in stato In sospeso / Prenotato rilevate</div>
                      <div className="small">
                        Sono presenti <strong>{linkedCount}</strong> {linkedCount === 1 ? "prenotazione" : "prenotazioni"} in stato{" "}
                        <strong>In sospeso</strong> / <strong>Prenotato</strong> con agevolazioni Fidelity gia collegate.
                      </div>
                    </div>

                    {impact.linkedAppointments.length > 0 ? (
                      <div className="card mb-3">
                        <div className="px-3 py-2 border-bottom bg-light">
                          <div className="fw-semibold">Prenotazioni coinvolte</div>
                          <div className="small text-muted">Visualizzate fino a 3 prenotazioni alla volta. Scorri per vedere le altre.</div>
                        </div>
                        <div className="overflow-auto fidelity-appointments-scroll">
                          <div className="list-group list-group-flush">
                            {impact.linkedAppointments.map((appt) => {
                              const statusLabel = appt.status === "scheduled" ? "Prenotato" : "In sospeso";
                              const statusClass = appt.status === "scheduled" ? "text-bg-primary" : "text-bg-warning";
                              const client = appt.clientName !== "" ? appt.clientName : "Cliente non disponibile";
                              const services = appt.servicesLabel !== "" ? appt.servicesLabel : "Servizi non disponibili";
                              return (
                                <div className="list-group-item py-3" key={appt.id}>
                                  <div className="d-flex justify-content-between align-items-start gap-3">
                                    <div className="flex-grow-1 fidelity-min-width-0">
                                      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                                        <div className="fw-semibold">Prenotazione #{appt.publicCode}</div>
                                        <span className={`badge ${statusClass}`}>{statusLabel}</span>
                                      </div>
                                      <div className="small text-muted mb-1">
                                        {apptDateLabel(appt.startsAt, appt.endsAt)}
                                        {client !== "" ? <> • {client}</> : null}
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
                                                    • sconto <strong>€ {fmtMoney(appt.pointsDiscount)}</strong>
                                                  </>
                                                ) : null}
                                              </>
                                            ) : (
                                              <>
                                                Sconto punti: <strong>€ {fmtMoney(appt.pointsDiscount)}</strong>
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
                                        href={pageUrl(`appointments?action=edit&id=${appt.id}`)}
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
                    ) : null}

                    <div className="card p-3 border-warning-subtle bg-warning-subtle">
                      <div className="fw-semibold mb-1">Continuando perderai le agevolazioni Fidelity gia prenotate</div>
                      <div className="form-text m-0">
                        Disattivando l&apos;impostazione generale <strong>Fidelity</strong>, il sistema rimuoverà automaticamente sconti punti,
                        omaggi o scelte Fidelity dalle prenotazioni coinvolte; i relativi punti torneranno disponibili. Vuoi continuare con la
                        disattivazione?
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setModalOpen(false)}>
                      Annulla
                    </button>
                    <button type="submit" className="btn btn-danger" disabled={saving}>
                      <i className="bi bi-check2-circle me-1" />
                      Conferma disattivazione
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
