"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

// Faithful port of the PHP notifications page (app/pages/notifications.php):
// "Centro notifiche" header + browser-notification actions/modal, the
// "Appuntamenti in attesa" section with RICH cards (servizio/data, codice,
// pacchetto/prepagato, operatore, sede, cliente, totale + sconto coupon) and the
// Approva / Modifica / Annulla actions, plus "Tessere Fidelity in scadenza/scadute".
// Fed by /api/manage/notifications?action=pending; le azioni riusano
// /api/manage/appointments (action=status) con l'intera lifecycle (email inclusa).

type PendingAppointment = {
  id: number;
  publicCode: string;
  serviceName: string;
  dateLabel: string;
  timeLabel: string;
  endLabel: string;
  staffName: string;
  staffPhone: string;
  staffEmail: string;
  locationName: string;
  locationAddress: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  total: number;
  couponCode: string;
  packageSummary: string;
  prepaidSummary: string;
};

type FidelityGroup = {
  key: string;
  kind: "warning" | "info" | "danger";
  title: string;
  text: string;
  link: string;
  lines: string[];
  linesMore: number;
  count: number;
  badgeClass: string;
  dateLabel: string;
  previewRows: Array<{ clientName: string; cardCode: string; expiresLabel: string; statusLabel: string; clientEmail: string }>;
};

type FidelitySection = { enabled: boolean; sectionText: string; emptyText: string };

const BROWSER_NOTIFICATION_PREFS = [
  { id: "browserNotifQuotes", pref: "quotes", label: "Preventivi accettati o rifiutati" },
  { id: "browserNotifInstallments", pref: "installments", label: "Rate in scadenza o scadute" },
  { id: "browserNotifBirthdays", pref: "birthdays", label: "Compleanni clienti" },
  { id: "browserNotifFidelityCards", pref: "fidelity_cards", label: "Tessere Fidelity in scadenza o scadute" },
] as const;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// number_format it-IT: separatore migliaia '.' + decimale ',' (fmt_money legacy).
function fmtMoney(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  const [intPart, decPart] = Math.abs(rounded).toFixed(2).split(".");
  return `${rounded < 0 ? "-" : ""}${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decPart}`;
}

// readJsonResponse legacy (View.php 2033-2049): risposta HTML → messaggio
// dedicato, JSON invalido → fallback, ok!==true → data.error || fallback.
async function readJsonResponse(res: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    const compact = String(text || "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (compact.charAt(0) === "<") {
      throw new Error("Il server ha risposto con una pagina HTML invece che con JSON. Verifica routing, sessione e permessi API.");
    }
    throw new Error(fallbackMessage || "Risposta del server non valida.");
  }
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(data && data.error ? String(data.error) : fallbackMessage || "Operazione non riuscita.");
  }
  return data;
}

// Stato del bottone permesso: come updatePermissionButtons legacy, con lo
// stato 'Serve HTTPS' per i contesti non sicuri (View.php 2191-2196).
type BrowserPermState = "unsupported" | "insecure" | NotificationPermission;

function readBrowserPermState(): BrowserPermState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  const secure = Boolean(window.isSecureContext) || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (!secure) return "insecure";
  return Notification.permission;
}

export function NotificationsContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();

  const [pending, setPending] = useState<PendingAppointment[]>([]);
  // Primo caricamento in corso: gli empty-state mostrano 'Caricamento…' invece
  // di 'Nessun…' (pattern delle sottopagine Rate/Preventivi — l'utente vedeva
  // 'nessuna voce' per un attimo prima dell'arrivo dei dati). I refresh
  // successivi restano silenziosi (loading non torna mai true).
  const [loading, setLoading] = useState(true);
  const [fidelityGroups, setFidelityGroups] = useState<FidelityGroup[]>([]);
  const [fidelitySection, setFidelitySection] = useState<FidelitySection | null>(null);
  const [fidelityTableOk, setFidelityTableOk] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [prefsError, setPrefsError] = useState("");
  const [busyId, setBusyId] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [notifPerm, setNotifPerm] = useState<BrowserPermState>("default");
  const [savingPrefs, setSavingPrefs] = useState(false);

  const toast = useCallback((message: string, variant: string) => {
    if (typeof window === "undefined") return;
    (window as unknown as { notify?: (m: string, v?: string) => void }).notify?.(message, variant);
  }, []);

  // fetchBrowserNotificationPreferences legacy: usata al mount (form presente)
  // e a ogni click su "Personalizza" (settingsButtons listener).
  const fetchPreferences = useCallback(() => {
    // Reset errore in microtask: fetchPreferences parte anche dentro l'effect
    // di mount e un setState sincrono lì innescherebbe render a cascata.
    Promise.resolve().then(() => setPrefsError(""));
    fetch(`/api/manage/user-prefs?action=get_browser_notification_preferences&slug=${encodeURIComponent(slug)}&_=${Date.now()}`, {
      headers: { Accept: "application/json", "x-tenant-slug": slug },
      cache: "no-store",
    })
      .then((res) => readJsonResponse(res, "Impossibile leggere le preferenze."))
      .then((data) => {
        const preferences = data.preferences && typeof data.preferences === "object" ? (data.preferences as Record<string, boolean>) : {};
        setPrefs(preferences);
      })
      .catch((e: unknown) => {
        setPrefsError(e instanceof Error && e.message ? e.message : "Impossibile leggere le preferenze.");
      });
  }, [slug]);

  // Permesso browser (incl. stato HTTPS) + preferenze salvate; il permesso si
  // ri-legge anche al FOCUS della finestra (updatePermissionButtons on focus:
  // l'utente può cambiarlo dalle impostazioni del browser).
  useEffect(() => {
    // Lettura permesso in microtask: niente setState sincroni nell'effect.
    Promise.resolve().then(() => setNotifPerm(readBrowserPermState()));
    fetchPreferences();
    const onFocus = () => setNotifPerm(readBrowserPermState());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchPreferences]);

  // showBrowserNotificationTest legacy: notifica nativa di test con i testi
  // verbatim + toast di conferma/avviso.
  const showTestNotification = useCallback((): boolean => {
    if (readBrowserPermState() !== "granted") return false;
    try {
      const notification = new Notification("Notifiche browser attive", {
        body: "Riceverai avvisi quando la scheda CRM non e in primo piano.",
        tag: `browser-notification-test:${Date.now()}`,
        silent: false,
        ...({ renotify: false } as NotificationOptions),
      });
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          /* noop */
        }
        window.location.href = `/${encodeURIComponent(slug)}/notifications`;
        notification.close();
      };
      return true;
    } catch {
      return false;
    }
  }, [slug]);

  // requestBrowserNotifications legacy: da concesso (già o appena) →
  // re-baseline del feed globale (refreshNotificationFeed(true) via evento
  // alla shell) + notifica di test + toast.
  const onGranted = useCallback(() => {
    setNotifPerm("granted");
    window.dispatchEvent(new Event("bs:notifications-baseline"));
    const ok = showTestNotification();
    toast(ok ? "Notifica browser di test inviata" : "Notifica browser non mostrata dal browser", ok ? "success" : "warning");
  }, [showTestNotification, toast]);

  async function requestPermission() {
    const state = readBrowserPermState();
    if (state === "unsupported" || state === "insecure") {
      setNotifPerm(state);
      return;
    }
    try {
      if (Notification.permission === "granted") {
        onGranted();
        return;
      }
      const permission = await Notification.requestPermission();
      setNotifPerm(permission);
      if (permission === "granted") onGranted();
    } catch {
      setNotifPerm(readBrowserPermState());
    }
  }

  // saveBrowserNotificationPreferences legacy: POST col contratto
  // preferences=<JSON>, echo del server riapplicato al form, re-baseline del
  // feed, chiusura modal e toast 'Preferenze notifiche salvate'; errore
  // INLINE nel modal (non alert di pagina).
  async function savePrefs(event: FormEvent) {
    event.preventDefault();
    setPrefsError("");
    setSavingPrefs(true);
    try {
      const res = await fetch(`/api/manage/user-prefs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "set_browser_notification_preferences", preferences: JSON.stringify(prefs) }),
      });
      const data = await readJsonResponse(res, "Impossibile salvare le preferenze.");
      const preferences = data.preferences && typeof data.preferences === "object" ? (data.preferences as Record<string, boolean>) : {};
      setPrefs(preferences);
      window.dispatchEvent(new Event("bs:notifications-baseline"));
      try {
        const modalEl = document.querySelector("[data-browser-notifications-settings-modal]");
        const bootstrap = (window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance: (el: Element) => { hide: () => void } } } }).bootstrap;
        if (modalEl && bootstrap?.Modal) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      } catch {
        /* noop */
      }
      toast("Preferenze notifiche salvate", "success");
    } catch (e: unknown) {
      setPrefsError(e instanceof Error && e.message ? e.message : "Impossibile salvare le preferenze.");
    } finally {
      setSavingPrefs(false);
    }
  }

  const permLabel =
    notifPerm === "unsupported"
      ? "Notifiche non supportate"
      : notifPerm === "insecure"
        ? "Serve HTTPS"
        : notifPerm === "granted"
          ? "Notifiche browser attive"
          : notifPerm === "denied"
            ? "Notifiche bloccate"
            : "Attiva notifiche browser";
  const permClass =
    notifPerm === "unsupported" || notifPerm === "insecure"
      ? "btn-outline-secondary"
      : notifPerm === "denied"
        ? "btn-warning"
        : notifPerm === "granted"
          ? "btn-success"
          : "btn-outline-primary";
  const permDisabled = notifPerm === "unsupported" || notifPerm === "insecure" || notifPerm === "denied";

  const load = useCallback(() => {
    fetch(`/api/manage/notifications?action=pending&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) return;
        setPending(Array.isArray(j.pending) ? j.pending : []);
        setFidelityGroups(Array.isArray(j.fidelityGroups) ? j.fidelityGroups : []);
        setFidelitySection(j.fidelitySection ?? null);
        setFidelityTableOk(j.fidelityTableOk !== false);
        setCanManage(Boolean(j.canManage));
        setLocationLabel(String(j.locationLabel ?? ""));
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // Dopo un salvataggio/modifica dal drawer quick-booking (o altrove) la lista si
  // aggiorna: il drawer emette "qb:appointments-changed" (come per il calendario),
  // più fedele del reload di pagina del legacy (data-qb-reload-on-save).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChanged = () => load();
    window.addEventListener("qb:appointments-changed", onChanged);
    return () => window.removeEventListener("qb:appointments-changed", onChanged);
  }, [load]);

  // Approva: POST della PAGINA legacy (notifications.php 77-146) con le sue
  // guardie — pending-only ('Appuntamento non piu in attesa'), sede corrente,
  // permesso ('Operazione non autorizzata') — ed email/promemoria come
  // automation_handle_status_change.
  async function approve(id: number) {
    setBusyId(id);
    setMsg(null);
    try {
      const res = await fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "approve", id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setMsg({ ok: false, text: String(data?.error || "Operazione non valida") });
      } else {
        setMsg({ ok: true, text: String(data?.message || "Appuntamento approvato") });
      }
    } catch {
      setMsg({ ok: false, text: "Operazione non valida" });
    } finally {
      setBusyId(0);
      load();
    }
  }

  // Annulla: popup legacy qbAppointmentCancelDialog (notifications_quotes.js
  // 3-21) con pendingOnly — anteprima conseguenze + conferma → cancel_done
  // pending_only=1; senza popup, il messaggio warning legacy.
  function openCancelDialog(id: number) {
    const dialog = (window as unknown as {
      qbAppointmentCancelDialog?: { open: (id: number, opts: Record<string, unknown>) => void };
    }).qbAppointmentCancelDialog;
    if (!dialog || typeof dialog.open !== "function") {
      setMsg({ ok: false, text: "Popup annullamento non disponibile" });
      return;
    }
    dialog.open(id, {
      external: true,
      pendingOnly: true,
      originalStatus: "pending",
      onSuccess: () => {
        setMsg({ ok: true, text: "Appuntamento annullato" });
        load();
      },
    });
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      {msg ? (
        <div className={`alert ${msg.ok ? "alert-success" : "alert-warning"} alert-dismissible`} role="alert">
          {msg.text}
          <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setMsg(null)} />
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Centro notifiche</div>
          <h1 className="bs-page-title">Notifiche</h1>
          <div className="bs-page-subtitle">{locationLabel ? `Sede: ${locationLabel}` : "Centro notifiche operativo."}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex flex-wrap justify-content-end gap-2">
            <button
              className="btn btn-outline-secondary btn-sm"
              type="button"
              data-browser-notifications-settings=""
              data-bs-toggle="modal"
              data-bs-target="#browserNotificationSettingsModal"
              onClick={fetchPreferences}
            >
              <i className="bi bi-sliders me-1" />
              Personalizza
            </button>
            <button
              className={`btn ${permClass} btn-sm`}
              type="button"
              disabled={permDisabled}
              onClick={requestPermission}
              title={notifPerm === "granted" ? "Clicca per inviare una notifica di test." : notifPerm === "denied" ? "Riattivale dalle impostazioni del browser." : undefined}
            >
              <i className="bi bi-bell me-1" />
              <span>{permLabel}</span>
            </button>
          </div>
        </div>
      </div>

      <div
        className="modal fade"
        id="browserNotificationSettingsModal"
        tabIndex={-1}
        aria-hidden="true"
        data-browser-notifications-settings-modal=""
      >
        <div className="modal-dialog modal-dialog-centered">
          <form className="modal-content" data-browser-notifications-preferences-form="" onSubmit={savePrefs}>
            <div className="modal-header">
              <div>
                <div className="text-muted small">Notifiche browser</div>
                <h2 className="modal-title h5 fw-bold m-0">Personalizza notifiche</h2>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="d-grid gap-3">
                <div className="form-check form-switch m-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="browserNotifAppointments"
                    checked
                    disabled
                    readOnly
                    aria-describedby="browserNotifAppointmentsHelp"
                  />
                  <label className="form-check-label fw-semibold" htmlFor="browserNotifAppointments">
                    Prenotazioni in attesa
                  </label>
                  <div className="form-text" id="browserNotifAppointmentsHelp">
                    Sempre attiva.
                  </div>
                </div>
                {BROWSER_NOTIFICATION_PREFS.map((item) => (
                  <div className="form-check form-switch m-0" key={item.id}>
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id={item.id}
                      data-browser-notification-pref={item.pref}
                      checked={Boolean(prefs[item.pref])}
                      onChange={(e) => setPrefs((p) => ({ ...p, [item.pref]: e.target.checked }))}
                    />
                    <label className="form-check-label fw-semibold" htmlFor={item.id}>
                      {item.label}
                    </label>
                  </div>
                ))}
              </div>
              <div
                className={`alert alert-warning small mt-3 mb-0${prefsError ? "" : " d-none"}`}
                role="alert"
                data-browser-notifications-preferences-error=""
              >
                {prefsError}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button className="btn btn-primary" type="submit" disabled={savingPrefs} data-browser-notifications-preferences-save="">
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
            </div>
          </form>
        </div>
      </div>

      <h2 className="h5 fw-bold mt-0 mb-3">Appuntamenti in attesa</h2>

      {pending.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessun appuntamento in attesa."}</div>
          <div className="text-muted small mt-1">
            Quando un cliente prenota online, l&apos;appuntamento resta in sospeso finché non lo approvi.
          </div>
        </div>
      ) : (
        <>
          {pending.map((a) => (
            <div className="card mb-3 notification-card" key={a.id}>
              <div className="d-flex flex-wrap">
                <div className="p-3 flex-grow-1 notification-main notification-main--primary">
                  <div className="fw-bold fs-5 mb-1">{a.serviceName || "—"}</div>
                  {a.dateLabel ? (
                    <>
                      <div className="text-primary fw-semibold">{a.dateLabel}</div>
                      <div className="text-muted small">
                        {a.timeLabel}
                        {a.endLabel ? ` - ${a.endLabel}` : ""}
                      </div>
                    </>
                  ) : null}
                  {a.publicCode ? (
                    <div className="text-muted small mt-3">
                      Codice prenotazione: <code>#{a.publicCode}</code>
                    </div>
                  ) : null}
                  {a.packageSummary ? (
                    <div className="small text-primary fw-semibold mt-2">
                      <i className="bi bi-box-seam me-1" />
                      {a.packageSummary}
                    </div>
                  ) : null}
                  {a.prepaidSummary ? (
                    <div className="small text-primary fw-semibold mt-2">
                      <i className="bi bi-credit-card-2-front me-1" />
                      {a.prepaidSummary}
                    </div>
                  ) : null}
                </div>

                <div className="p-3 flex-grow-1 notification-detail notification-detail--compact">
                  <div className="text-muted small">Operatore</div>
                  <div className="fw-semibold">{a.staffName || "—"}</div>
                  {a.staffPhone ? <div className="text-muted small">Telefono: {a.staffPhone}</div> : null}
                  {a.staffEmail ? <div className="text-muted small">Email: {a.staffEmail}</div> : null}

                  <div className="mt-3 text-muted small">Posizione</div>
                  <div className="fw-semibold">{a.locationName || "—"}</div>
                  {a.locationAddress ? <div className="text-muted small">{a.locationAddress}</div> : null}
                </div>

                <div className="p-3 flex-grow-1 notification-detail notification-detail--compact">
                  <div className="text-muted small">Cliente</div>
                  <div className="fw-semibold">{a.clientName || "—"}</div>
                  {a.clientPhone ? <div className="text-muted small">Telefono: {a.clientPhone}</div> : null}
                  {a.clientEmail ? <div className="text-muted small">Email: {a.clientEmail}</div> : null}

                  <div className="mt-3">
                    <div className="text-muted small">Totale stimato</div>
                    <div className="fw-bold">€ {fmtMoney(a.total)}</div>
                  </div>
                </div>

                <div className="p-3 notification-action notification-action--compact">
                  {canManage ? (
                    <div className="d-grid gap-2">
                      <button
                        className="btn btn-link text-success fw-semibold text-decoration-none"
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => approve(a.id)}
                      >
                        <i className="bi bi-check2 me-1" />
                        Approva
                      </button>
                      {/* Modifica: apre il drawer quick-booking GLOBALE (montato in
                          ManageShell) in EDIT mode via il listener [data-qb-edit],
                          come il legacy (data-qb-edit + data-qb-reload-on-save). */}
                      <button
                        type="button"
                        className="btn btn-link text-primary fw-semibold text-decoration-none"
                        data-qb-edit={a.id}
                        data-qb-reload-on-save="1"
                      >
                        <i className="bi bi-pencil-square me-1" />
                        Modifica
                      </button>
                      {/* Annulla: popup legacy con anteprima (js-pending-cancel-btn),
                          NON window.confirm — pendingOnly + cancel_done. */}
                      <button
                        className="btn btn-link text-danger fw-semibold text-decoration-none js-pending-cancel-btn"
                        type="button"
                        data-appointment-id={a.id}
                        disabled={busyId === a.id}
                        onClick={() => openCancelDialog(a.id)}
                      >
                        <i className="bi bi-x-lg me-1" />
                        Annulla
                      </button>
                    </div>
                  ) : (
                    <div className="small text-muted">Permesso Appuntamenti richiesto per gestire la richiesta.</div>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="text-muted small mt-2">
            Mostrando appuntamenti da 1 a {pending.length} di {pending.length} totali
          </div>
        </>
      )}

      {/* HUB ASCIUGATO (deviazione approvata 20/07): la sezione Fidelity vive
          nella pagina dedicata "Tessere in scadenza" (notifications_fidelity,
          gruppo Fidelizzazione). Qui resta SOLO una riga compatta col
          contatore, visibile quando c'è qualcosa — a zero sparisce. */}
      {fidelitySection?.enabled && !fidelityTableOk ? (
        <>
          <hr className="my-4" />
          <div className="card p-4" id="fidelity_cards_notifications">
            <div className="fw-semibold">Tessere Fidelity non disponibili.</div>
            <div className="text-muted small mt-1">Importa il dump SQL completo aggiornato per vedere le notifiche di scadenza.</div>
          </div>
        </>
      ) : fidelitySection?.enabled && fidelityGroups.length > 0 ? (
        <>
          <hr className="my-4" />
          <div className="card notification-card" id="fidelity_cards_notifications">
            <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 p-3">
              <div className="d-flex align-items-center gap-3">
                <i className="bi bi-hourglass-split fs-4 text-warning" aria-hidden />
                <div>
                  <div className="fw-bold">Tessere Fidelity in scadenza / scadute</div>
                  <div className="text-muted small">{fidelitySection.sectionText}</div>
                </div>
                <span className="badge text-bg-warning">{fidelityGroups.reduce((sum, group) => sum + Number(group.count || 0), 0)}</span>
              </div>
              <a className="btn btn-outline-primary btn-sm" href={`/${encodeURIComponent(slug)}/notifications_fidelity`}>
                <i className="bi bi-box-arrow-up-right me-1" />
                Vedi
              </a>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
