"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";
import { useTakenFlash } from "./flash";

// Pixel-faithful port of the PHP automation page (app/pages/automation.php,
// ?page=automation). Original Bootstrap markup preserved verbatim. The form is
// prefilled from /api/manage/automation (settings) e il resto della pagina —
// saldo crediti SMS, badge stato, esempi email/SMS costruiti con la cancel
// policy del booking, conteggio segmenti, pacchetti SMS del listino centrale,
// config del promemoria Fidelity — arriva dal `page` context della stessa GET
// (port di automation.php 10-130). Flash legacy 'Automazione salvata' come
// View::alert sopra il page header.

type AutomationSettings = {
  reminder_enabled: boolean;
  reminder_hours: number;
  sms_reminder_enabled: boolean;
  sms_reminder_hours: number;
  approved_enabled: boolean;
  modified_enabled: boolean;
  rejected_enabled: boolean;
  fidelity_expiry_reminder_enabled: boolean;
};

type SmsPlan = {
  id: number;
  name: string;
  credits: number;
  priceLabel: string;
  pricePerCreditLabel: string;
  description: string;
  isFeatured: boolean;
};

type PageContext = {
  businessName: string;
  smsCreditBalance: number;
  emailCancellationNotice: string;
  smsExampleText: string;
  smsExampleSegments: number;
  smsExampleCreditsLabel: string;
  fidelity: { configOk: boolean; validityLabel: string; windowLabel: string };
  smsPlans: SmsPlan[];
  smsDefaultPlanId: number;
  smsPlansError: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

type Flash = { text: string; type: "success" | "danger" };

export function AutomationContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [page, setPage] = useState<PageContext | null>(null);
  const [saving, setSaving] = useState(false);
  // Audit giro 3: se il load fallisce la pagina mostra i DEFAULT dei toggle —
  // un Salva in buona fede sovrascriverebbe la configurazione reale.
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(0);
  // Flash legacy (View::alert msg success sopra il page header).
  const [flash, setFlash] = useState<Flash | null>(() =>
    initialQuery?.msg ? { text: String(initialQuery.msg), type: "success" } : null,
  );
  useTakenFlash((f) => {
    if (f.msg) setFlash({ text: f.msg, type: "success" });
    else if (f.err) setFlash({ text: f.err, type: "danger" });
  });

  const showFlash = useCallback((next: Flash | null) => {
    setFlash(next);
    if (next && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    fetch(`/api/manage/automation?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setSettings(j.settings ?? null);
        const ctx = (j.page ?? null) as PageContext | null;
        setPage(ctx);
        if (ctx) setSelectedPlan(ctx.smsDefaultPlanId || ctx.smsPlans[0]?.id || 0);
      })
      .then(() => setLoadFailed(false))
      .catch(() => {
        setSettings(null);
        setLoadFailed(true);
      });
  }, [slug]);

  const fidelityConfigOk = page?.fidelity?.configOk ?? false;
  const reminderEnabled = settings?.reminder_enabled ?? true;
  // Default legacy del toggle SMS: SPENTO (!empty($s['sms_reminder_enabled'])).
  const smsReminderEnabled = settings?.sms_reminder_enabled ?? false;
  const approvedEnabled = settings?.approved_enabled ?? true;
  const fidelityExpiryEnabled = fidelityConfigOk && (settings?.fidelity_expiry_reminder_enabled ?? false);
  const modifiedEnabled = settings?.modified_enabled ?? true;
  const rejectedEnabled = settings?.rejected_enabled ?? true;

  const businessName = page?.businessName ?? "La mia attivita";
  const smsCreditBalance = page?.smsCreditBalance ?? 0;
  const smsCreditsLabel = page?.smsExampleCreditsLabel ?? "1 credito";
  const smsSegments = Math.max(1, page?.smsExampleSegments ?? 1);
  // Avviso legacy: solo con promemoria SMS attivo (valore SALVATO) e saldo
  // insufficiente per un invio d'esempio.
  const showSmsCreditsWarning = Boolean(settings?.sms_reminder_enabled) && smsCreditBalance < smsSegments;
  const summaryPlan = page?.smsPlans.find((p) => p.id === selectedPlan);

  // Salvataggio (port del POST di automation.php): invia toggle + ore all'API,
  // che persiste e rischedula i promemoria futuri; flash "Automazione salvata".
  const submitSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loadFailed) {
      showFlash({ text: "Impossibile salvare: impostazioni correnti non caricate. Ricarica la pagina.", type: "danger" });
      return;
    }
    const form = new FormData(event.currentTarget);
    const flag = (name: string) => (form.get(name) ? "1" : "0");
    setSaving(true);
    try {
      const response = await fetch(`/api/manage/automation?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "save",
          reminder_enabled: flag("reminder_enabled"),
          reminder_hours: String(form.get("reminder_hours") ?? "24"),
          sms_reminder_enabled: flag("sms_reminder_enabled"),
          sms_reminder_hours: String(form.get("sms_reminder_hours") ?? "24"),
          approved_enabled: flag("approved_enabled"),
          modified_enabled: flag("modified_enabled"),
          rejected_enabled: flag("rejected_enabled"),
          fidelity_expiry_reminder_enabled: flag("fidelity_expiry_reminder_enabled"),
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        setSettings(json.settings ?? null);
        showFlash({ text: String(json.message || "Automazione salvata"), type: "success" });
      } else {
        showFlash({ text: String(json.error || "Errore automazione."), type: "danger" });
      }
    } catch {
      showFlash({ text: "Errore automazione.", type: "danger" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container-fluid">

      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Automazione</h1>
            <InfoBox>
              <p>
                Ogni automazione (promemoria, follow-up, auguri…) <strong>programma i propri invii in anticipo</strong>
                {" "}e li spedisce all&apos;orario configurato, in ora italiana.
              </p>
              <ul>
                <li>
                  Se disattivi un&apos;automazione, gli invii già programmati e non ancora spediti vengono{" "}
                  <strong>cancellati</strong>; riattivandola verranno programmati solo gli invii futuri.
                </li>
                <li>I testi dei messaggi sono personalizzabili: se li lasci vuoti viene usato il testo predefinito.</li>
                <li>Gli invii via SMS consumano i crediti SMS del tuo piano; quelli via email sono inclusi.</li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Gestisci email e SMS automatici inviati ai clienti.</div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card p-4 mb-3">
            <div className="fw-bold mb-2"><i className="bi bi-envelope me-1" />Promemoria email appuntamento</div>
            <div className="text-muted small">Invia una email prima dell&apos;appuntamento al cliente con indirizzo email valido. Il promemoria parte solo per appuntamenti in stato <strong>Prenotato</strong>.</div>

            <form className="mt-3" onSubmit={submitSave}>
              <div className="row g-3">
                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="reminderEnabled" name="reminder_enabled" value="1" defaultChecked={reminderEnabled} key={`r-${reminderEnabled}`} />
                    <label className="form-check-label" htmlFor="reminderEnabled">Attiva promemoria email</label>
                  </div>
                </div>
                <div className="col-md-6">
                  <label className="form-label">Invio email</label>
                  <select className="form-select" name="reminder_hours" defaultValue={String(settings?.reminder_hours ?? 24)} key={`rh-${settings?.reminder_hours ?? 24}`}>
                    <option value="3">3 ore prima</option>
                    <option value="6">6 ore prima</option>
                    <option value="12">12 ore prima</option>
                    <option value="24">24 ore prima</option>
                    <option value="48">48 ore prima</option>
                  </select>
                </div>
                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      Ciao,<br /><br />
                      ti ricordiamo il tuo appuntamento presso Sede1 il 22/06 alle 09:00 per Taglio, Colore e Piega.<br />
                      {page?.emailCancellationNotice ? (
                        <>
                          {page.emailCancellationNotice}<br />
                        </>
                      ) : null}
                      Per assistenza contattaci al 3756266694.<br /><br />
                      Saluti,<br />
                      {businessName}
                    </div>
                  </div>
                </div>

                <div className="col-12"><hr /></div>

                <div className="col-12">
                  <div className="fw-bold mb-2"><i className="bi bi-chat-left-text me-1" />Promemoria SMS appuntamento</div>
                  <div className="text-muted small">Invia un SMS prima dell&apos;appuntamento al cliente con telefono valido. Il promemoria parte solo per appuntamenti in stato <strong>Prenotato</strong>.</div>
                </div>

                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="smsReminderEnabled" name="sms_reminder_enabled" value="1" defaultChecked={smsReminderEnabled} key={`s-${smsReminderEnabled}`} />
                    <label className="form-check-label" htmlFor="smsReminderEnabled">Attiva promemoria SMS</label>
                  </div>
                </div>
                <div className="col-md-6">
                  <label className="form-label">Invio SMS</label>
                  <select className="form-select" name="sms_reminder_hours" defaultValue={String(settings?.sms_reminder_hours ?? 24)} key={`sh-${settings?.sms_reminder_hours ?? 24}`}>
                    <option value="3">3 ore prima</option>
                    <option value="6">6 ore prima</option>
                    <option value="12">12 ore prima</option>
                    <option value="24">24 ore prima</option>
                    <option value="48">48 ore prima</option>
                  </select>
                </div>

                {showSmsCreditsWarning ? (
                  <div className="col-12">
                    <div className="alert alert-warning py-2 mb-0 small">
                      Crediti SMS insufficienti: il promemoria resterà attivo, ma gli invii verranno bloccati finché non saranno disponibili crediti.
                    </div>
                  </div>
                ) : null}

                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      {page?.smsExampleText ?? "Ciao, ti ricordiamo l'appuntamento da Sede1 il 22/06 alle 09:00. Non rispondere a questo SMS. Per assistenza: 3756266694."}
                    </div>
                    <div className="small text-muted mt-2">Costo stimato: <strong>{smsCreditsLabel}</strong> per invio. Se il testo supera un singolo SMS, il provider può inviarlo in più segmenti.</div>
                  </div>
                </div>

                <div className="col-12"><hr /></div>

                <div className="col-12">
                  <div className="fw-bold mb-1"><i className="bi bi-gem me-1" />Promemoria email scadenza Fidelity</div>
                  <div className="text-muted small">Avvisa il cliente prima della scadenza della tessera Fidelity, così può completare il rinnovo automatico in tempo. Esempio: con finestra di rinnovo a 30 giorni, l&apos;email viene inviata 30 giorni prima della scadenza.</div>
                </div>

                <div className="col-12">
                  {!fidelityConfigOk ? (
                    <div className="alert alert-warning py-2 mb-0 small">
                      Per attivare questo promemoria, configura prima la durata della tessera e la finestra di rinnovo in <strong>Fidelity → Adesione → Impostazioni tessera</strong>.
                    </div>
                  ) : (
                    <div className="alert alert-light border py-2 mb-0 small">
                      Configurazione attuale: durata tessera <strong>{page?.fidelity.validityLabel}</strong> • finestra rinnovo <strong>{page?.fidelity.windowLabel}</strong>. L&apos;email viene inviata all&apos;apertura della finestra.
                    </div>
                  )}
                </div>

                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="fidExpiryReminderEnabled" name="fidelity_expiry_reminder_enabled" value="1" defaultChecked={fidelityExpiryEnabled} key={`f-${fidelityExpiryEnabled}-${fidelityConfigOk}`} disabled={!fidelityConfigOk} />
                    <label className="form-check-label" htmlFor="fidExpiryReminderEnabled">Attiva promemoria Fidelity</label>
                  </div>
                </div>

                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      Ciao,<br /><br />
                      la tua tessera Fidelity FID-123 scade il 22/07.<br />
                      Per mantenerla attiva, effettua un acquisto o completa un appuntamento entro il 22/07.<br />
                      Il rinnovo verrà applicato automaticamente.<br /><br />
                      Saluti,<br />
                      {businessName}
                    </div>
                  </div>
                </div>

                <div className="col-12"><hr /></div>

                <div className="col-12">
                  <div className="fw-bold mb-1"><i className="bi bi-check2-circle me-1" />Email approvazione appuntamento</div>
                  <div className="text-muted small">Avvisa il cliente quando il suo appuntamento viene confermato (Stato: <strong>Prenotato</strong>).</div>
                </div>
                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="approvedEnabled" name="approved_enabled" value="1" defaultChecked={approvedEnabled} key={`a-${approvedEnabled}`} />
                    <label className="form-check-label" htmlFor="approvedEnabled">Attiva email approvazione</label>
                  </div>
                </div>
                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      Ciao,<br /><br />
                      il tuo appuntamento è stato approvato.<br />
                      Appuntamento: 22/06 09:00<br />
                      Servizi: Taglio, Colore e Piega<br />
                      Operatore: Luca<br />
                      Sede: Sede1<br />
                      Via Tremiti 6, 00100 Roma (RM)<br />
                      Per assistenza contattaci al 3756266694.<br /><br />
                      Saluti,<br />
                      {businessName}
                    </div>
                  </div>
                </div>

                <div className="col-12"><hr /></div>

                <div className="col-12">
                  <div className="fw-bold mb-1"><i className="bi bi-pencil-square me-1" />Email modifica appuntamento</div>
                  <div className="text-muted small">Avvisa il cliente quando vengono modificati i dettagli di un appuntamento già prenotato.</div>
                </div>
                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="modifiedEnabled" name="modified_enabled" value="1" defaultChecked={modifiedEnabled} key={`m-${modifiedEnabled}`} />
                    <label className="form-check-label" htmlFor="modifiedEnabled">Attiva email modifica</label>
                  </div>
                </div>
                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      Ciao,<br /><br />
                      il tuo appuntamento è stato modificato.<br />
                      Appuntamento: 22/06 09:00<br />
                      Servizi: Taglio, Colore e Piega<br />
                      Operatore: Luca<br />
                      Sede: Sede1<br />
                      Via Tremiti 6, 00100 Roma (RM)<br />
                      Per assistenza contattaci al 3756266694.<br /><br />
                      Saluti,<br />
                      {businessName}
                    </div>
                  </div>
                </div>

                <div className="col-12"><hr /></div>

                <div className="col-12">
                  <div className="fw-bold mb-1"><i className="bi bi-x-circle me-1" />Email rifiuto appuntamento</div>
                  <div className="text-muted small">Avvisa il cliente quando la sua richiesta di appuntamento non può essere confermata (Stato: <strong>Prenotato</strong>).</div>
                </div>
                <div className="col-12">
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" role="switch" id="rejectedEnabled" name="rejected_enabled" value="1" defaultChecked={rejectedEnabled} key={`j-${rejectedEnabled}`} />
                    <label className="form-check-label" htmlFor="rejectedEnabled">Attiva email rifiuto</label>
                  </div>
                </div>
                <div className="col-12">
                  <div className="alert alert-light border mb-0">
                    <div className="fw-semibold mb-2">Esempio</div>
                    <div className="small text-muted">
                      Ciao,<br /><br />
                      purtroppo non possiamo confermare l&apos;appuntamento richiesto.<br />
                      Per assistenza contattaci al 3756266694.<br /><br />
                      Saluti,<br />
                      {businessName}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4 d-flex gap-2">
                <button className="btn btn-primary" type="submit" disabled={saving || loadFailed}><i className="bi bi-check2-circle me-1" />Salva</button>
                <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/dashboard`}>Indietro</a>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card p-4">
            <div className="text-muted small">Crediti SMS</div>
            <div className="fw-semibold mb-2">Riepilogo credito</div>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <span className="small text-muted">Saldo disponibile</span>
              <span className="fw-bold">{smsCreditBalance} crediti</span>
            </div>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <span className="small text-muted">Stato promemoria SMS</span>
              <span className={`badge ${settings?.sms_reminder_enabled ? "bg-success" : "bg-secondary"}`}>
                {settings?.sms_reminder_enabled ? "Attivo" : "Disattivo"}
              </span>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <span className="small text-muted">Costo stimato per invio</span>
              <span className="fw-semibold">{smsCreditsLabel}</span>
            </div>

            <div className="small text-muted mt-3">
              Gli SMS vengono inviati solo se il saldo è sufficiente. In caso contrario il promemoria viene bloccato e registrato come non inviato.
            </div>

            <div className="d-flex gap-2 flex-wrap mt-3">
              <button className="btn btn-primary btn-sm" type="button" data-bs-toggle="modal" data-bs-target="#smsCreditsTopupModal">
                Ricarica crediti
              </button>
            </div>
            <div className="small text-muted mt-2">La ricarica crediti verrà collegata al sistema di pagamento.</div>

            <hr className="my-3" />

            <div className="text-muted small">Testi automatici</div>
            <div className="fw-semibold mb-2">Messaggi gestiti dal sistema</div>
            <div className="small text-muted">
              Email e SMS vengono generati con i dati reali di appuntamento, sede e tessera Fidelity. Il contenuto non è modificabile dall&apos;utente, così resta coerente e sotto controllo.
            </div>

            <hr className="my-3" />

            <div className="text-muted small">Invio automatico</div>
            <div className="small text-muted">
              Le email usano la funzione PHP <code>mail()</code> del server. Gli SMS usano OpenAPI SMS v2 quando configurato in <code>config.php</code>.
              I promemoria appuntamento e Fidelity richiedono il cron <code>/cron/reminders.php</code> ogni 10–15 minuti.
            </div>
          </div>
        </div>
      </div>

      <div className="modal fade" id="smsCreditsTopupModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="text-muted small">Crediti SMS</div>
                <h5 className="modal-title fw-bold m-0">Ricarica crediti</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="d-flex justify-content-between align-items-center border rounded-3 p-3 mb-3">
                <span className="small text-muted">Saldo attuale</span>
                <span className="fw-bold">{smsCreditBalance} crediti</span>
              </div>

              {page?.smsPlansError ? (
                <div className="alert alert-warning mb-0">{page.smsPlansError}</div>
              ) : !page || page.smsPlans.length === 0 ? (
                <div className="alert alert-light border mb-0">Nessun pacchetto SMS disponibile al momento.</div>
              ) : (
                <>
                  <div className="small text-muted mb-3">
                    Scegli un pacchetto. I crediti verranno scalati automaticamente quando il sistema invia un SMS.
                  </div>
                  <div className="row g-2">
                    {page.smsPlans.map((plan) => {
                      const selected = plan.id === selectedPlan;
                      return (
                        <div className="col-md-6" key={plan.id}>
                          <label
                            className={`d-block border rounded-3 p-3 h-100 ${selected ? "border-primary bg-primary-subtle" : "bg-white"}`}
                            htmlFor={`smsPlan${plan.id}`}
                          >
                            <div className="d-flex justify-content-between gap-2 align-items-start">
                              <div>
                                <input
                                  className="form-check-input me-2"
                                  type="radio"
                                  name="sms_credit_plan"
                                  id={`smsPlan${plan.id}`}
                                  value={plan.id}
                                  data-sms-plan-option
                                  data-name={plan.name}
                                  data-credits={plan.credits}
                                  data-price={plan.priceLabel}
                                  data-price-per-credit={plan.pricePerCreditLabel}
                                  checked={selected}
                                  onChange={() => setSelectedPlan(plan.id)}
                                />
                                <span className="fw-semibold">{plan.name}</span>
                              </div>
                              {plan.isFeatured ? <span className="badge bg-primary">Consigliato</span> : null}
                            </div>
                            <div className="mt-2">
                              <div className="fw-bold">{plan.credits} crediti</div>
                              <div>{plan.priceLabel}</div>
                              <div className="small text-muted">{plan.pricePerCreditLabel} per credito</div>
                              {plan.description ? <div className="small text-muted mt-2">{plan.description}</div> : null}
                            </div>
                          </label>
                        </div>
                      );
                    })}
                  </div>

                  <div className="alert alert-light border mt-3 mb-0">
                    <div className="fw-semibold mb-2">Riepilogo</div>
                    <div className="d-flex justify-content-between mb-1">
                      <span className="small text-muted">Pacchetto</span>
                      <span className="fw-semibold" data-sms-plan-summary="name">{summaryPlan ? summaryPlan.name : "-"}</span>
                    </div>
                    <div className="d-flex justify-content-between mb-1">
                      <span className="small text-muted">Crediti</span>
                      <span className="fw-semibold" data-sms-plan-summary="credits">{summaryPlan ? `${summaryPlan.credits} crediti` : "-"}</span>
                    </div>
                    <div className="d-flex justify-content-between mb-1">
                      <span className="small text-muted">Totale</span>
                      <span className="fw-semibold" data-sms-plan-summary="price">{summaryPlan ? summaryPlan.priceLabel : "-"}</span>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span className="small text-muted">Prezzo medio</span>
                      <span className="fw-semibold" data-sms-plan-summary="pricePerCredit">{summaryPlan ? summaryPlan.pricePerCreditLabel : "-"}</span>
                    </div>
                    <div className="small text-muted mt-2">Se un SMS supera un segmento, puo consumare piu crediti.</div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">Chiudi</button>
              <button type="button" className="btn btn-primary" disabled>Pagamento non ancora disponibile</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
