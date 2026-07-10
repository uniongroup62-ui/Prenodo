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

export function NotificationsContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();

  const [pending, setPending] = useState<PendingAppointment[]>([]);
  const [fidelityGroups, setFidelityGroups] = useState<FidelityGroup[]>([]);
  const [fidelitySection, setFidelitySection] = useState<FidelitySection | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | "unsupported">("default");
  const [savingPrefs, setSavingPrefs] = useState(false);

  // Permesso browser + preferenze salvate (port di api_user_prefs get_browser_
  // notification_preferences; il tipo "appointments" resta sempre attivo).
  useEffect(() => {
    // Lettura permesso in microtask: niente setState sincroni nell'effect.
    Promise.resolve().then(() => {
      if (typeof window !== "undefined" && "Notification" in window) setNotifPerm(Notification.permission);
      else setNotifPerm("unsupported");
    });
    fetch(`/api/manage/user-prefs?action=get_browser_notification_preferences&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && j.preferences && typeof j.preferences === "object") setPrefs(j.preferences as Record<string, boolean>);
      })
      .catch(() => undefined);
  }, [slug]);

  // Richiesta permesso "Attiva notifiche browser" (updatePermissionButtons /
  // requestBrowserNotifications legacy); da concesso, invia una notifica di test.
  async function requestPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "granted") {
      try {
        new Notification("Notifiche browser attive", { body: "Riceverai qui le nuove prenotazioni in attesa." });
      } catch {
        /* noop */
      }
      return;
    }
    try {
      setNotifPerm(await Notification.requestPermission());
    } catch {
      /* noop */
    }
  }

  async function savePrefs(event: FormEvent) {
    event.preventDefault();
    setSavingPrefs(true);
    try {
      // Chiavi FLAT nel body: parseRequestBody stringifica ogni valore (un oggetto
      // annidato diventerebbe "[object Object]"), quindi la route legge le chiavi
      // singole di primo livello (normalizePreferences(bodyObj)).
      await fetch(`/api/manage/user-prefs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "set_browser_notification_preferences", ...prefs }),
      });
      setMsg({ ok: true, text: "Preferenze salvate" });
    } catch {
      setMsg({ ok: false, text: "Impossibile salvare le preferenze" });
    } finally {
      setSavingPrefs(false);
    }
  }

  // Feed notifiche browser (BrowserNotifications::feed): polling ogni 15s degli
  // appuntamenti in attesa; alla PRIMA lettura marca tutto come "visto" senza
  // notificare (feedHydrated), poi mostra una notifica desktop per ogni nuovo.
  useEffect(() => {
    if (notifPerm !== "granted" || typeof window === "undefined") return;
    const seenKey = `bs_notif_seen:${slug}`;
    const hydratedKey = `${seenKey}:hydrated`;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/manage/notifications?action=feed&slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } });
        const j = await res.json();
        if (stopped || !j?.ok || !Array.isArray(j.events)) return;
        let seen: string[] = [];
        try {
          seen = JSON.parse(window.localStorage.getItem(seenKey) || "[]");
        } catch {
          seen = [];
        }
        const seenSet = new Set(seen.map(String));
        const hydrated = window.localStorage.getItem(hydratedKey) === "1";
        // Il tipo appointment_pending è sempre attivo; gli altri seguono le preferenze.
        const typeEnabled = (type: string): boolean => {
          if (type === "appointment_pending") return true;
          if (type === "quote_response") return Boolean(prefs.quotes);
          if (type === "installment_due") return Boolean(prefs.installments);
          if (type === "client_birthday") return Boolean(prefs.birthdays);
          if (type === "fidelity_cards") return Boolean(prefs.fidelity_cards);
          return false;
        };
        for (const ev of j.events as Array<{ key: string; type: string; title: string; body: string; url: string }>) {
          if (seenSet.has(ev.key)) continue;
          seenSet.add(ev.key);
          if (hydrated && typeEnabled(ev.type)) {
            try {
              const n = new Notification(ev.title, { body: ev.body, tag: ev.key });
              n.onclick = () => {
                try {
                  window.focus();
                } catch {
                  /* noop */
                }
                window.location.href = ev.url;
                n.close();
              };
            } catch {
              /* noop */
            }
          }
        }
        window.localStorage.setItem(seenKey, JSON.stringify(Array.from(seenSet).slice(-180)));
        window.localStorage.setItem(hydratedKey, "1");
      } catch {
        /* noop */
      }
    };
    poll();
    const id = window.setInterval(poll, 15000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [notifPerm, slug, prefs]);

  const permLabel =
    notifPerm === "unsupported"
      ? "Notifiche non supportate"
      : notifPerm === "granted"
        ? "Notifiche browser attive"
        : notifPerm === "denied"
          ? "Notifiche bloccate"
          : "Attiva notifiche browser";
  const permClass =
    notifPerm === "unsupported"
      ? "btn-outline-secondary"
      : notifPerm === "denied"
        ? "btn-warning"
        : notifPerm === "granted"
          ? "btn-success"
          : "btn-outline-primary";
  const permDisabled = notifPerm === "unsupported" || notifPerm === "denied";

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
        setCanManage(Boolean(j.canManage));
        setLocationLabel(String(j.locationLabel ?? ""));
      })
      .catch(() => undefined);
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

  // Approva (scheduled) / Annulla (canceled): riusa la route appuntamenti che
  // applica l'intera lifecycle (restore hold su cancel + email approved/rejected).
  async function act(id: number, status: "scheduled" | "canceled") {
    setBusyId(id);
    setMsg(null);
    try {
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "status", id, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setMsg({ ok: false, text: String(data?.error || "Operazione non valida") });
      } else {
        setMsg({ ok: true, text: status === "scheduled" ? "Appuntamento approvato" : "Appuntamento annullato" });
      }
    } catch {
      setMsg({ ok: false, text: "Operazione non valida" });
    } finally {
      setBusyId(0);
      load();
    }
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
                className="alert alert-warning small mt-3 mb-0 d-none"
                role="alert"
                data-browser-notifications-preferences-error=""
              />
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
          <div className="fw-semibold">Nessun appuntamento in attesa.</div>
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
                        onClick={() => act(a.id, "scheduled")}
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
                      <button
                        className="btn btn-link text-danger fw-semibold text-decoration-none"
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => {
                          if (typeof window !== "undefined" && window.confirm("Annullare la prenotazione?")) act(a.id, "canceled");
                        }}
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

      {/* Sezione Fidelity legacy (notifications.php 579-651): visibile quando
          il permesso c'è e la config tessera non è 'disabled', con testi
          dipendenti dalla config e empty state dedicato. */}
      {fidelitySection?.enabled ? (
        <>
          <hr className="my-4" />
          <div className="d-flex justify-content-between align-items-center mb-3" id="fidelity_cards_notifications">
            <div>
              <div className="text-muted small">Fidelity / Adesione</div>
              <h2 className="h5 fw-bold m-0">Tessere Fidelity in scadenza / scadute</h2>
              <div className="text-muted small mt-1">{fidelitySection.sectionText}</div>
            </div>
            <a className="btn btn-outline-primary btn-sm" href={`/${encodeURIComponent(slug)}/fidelity_membership`}>
              <i className="bi bi-box-arrow-up-right me-1" />
              Apri Fidelity / Adesione
            </a>
          </div>
          {fidelityGroups.length === 0 ? (
            <div className="card p-4">
              <div className="fw-semibold">Nessuna tessera in scadenza o scaduta.</div>
              <div className="text-muted small mt-1">{fidelitySection.emptyText}</div>
            </div>
          ) : (
            fidelityGroups.map((group) => (
              <div className="card mb-3 notification-card" key={group.key}>
                <div className="d-flex flex-wrap">
                  <div className={`p-3 flex-grow-1 notification-main notification-main--${group.kind}`}>
                    <div className="d-flex align-items-center justify-content-between gap-2">
                      <div className="fw-bold fs-5 mb-1">{group.title}</div>
                      <span className={`badge ${group.badgeClass || "text-bg-info"}`}>{group.count}</span>
                    </div>
                    <div className="text-muted small">{group.text}</div>
                    <div className="text-muted small mt-1">{group.dateLabel}</div>
                  </div>
                  <div className="p-3 flex-grow-1 notification-detail">
                    <div className="text-muted small mb-1">Anteprima</div>
                    {(group.previewRows ?? []).map((row, i) => (
                      <div className="mb-2" key={i}>
                        <div className="fw-semibold">{row.clientName || "Cliente"}</div>
                        <div className="text-muted small">
                          Tessera #{row.cardCode} • {row.expiresLabel || "—"}
                          {row.statusLabel ? <> • {row.statusLabel}</> : null}
                        </div>
                        {row.clientEmail ? <div className="text-muted small">{row.clientEmail}</div> : null}
                      </div>
                    ))}
                    {group.linesMore > 0 ? <div className="text-muted small">…e altre {group.linesMore}</div> : null}
                  </div>
                  <div className="p-3 notification-action">
                    <div className="d-grid gap-2">
                      <a className="btn btn-outline-primary btn-sm" href={group.link || `/${encodeURIComponent(slug)}/fidelity_membership`}>
                        <i className="bi bi-box-arrow-up-right me-1" />
                        Apri in Fidelity / Adesione
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}
