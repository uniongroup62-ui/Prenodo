"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP notifications page (app/pages/notifications.php):
// "Centro notifiche" header with browser-notification actions + settings modal,
// and the "Appuntamenti in attesa" section (pending appointments / empty state).
// Fed by the existing DB-backed /api/manage/notifications route.

type NotificationItem = {
  id: number;
  type: "appointment" | "cost" | "quote" | "fidelity" | "system";
  title: string;
  message: string;
  read: boolean;
  link: string;
  createdAt: string;
};

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

export function NotificationsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [pending, setPending] = useState<NotificationItem[]>([]);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const list: NotificationItem[] = Array.isArray(j.notifications) ? j.notifications : [];
        setPending(list.filter((n) => n.type === "appointment"));
      })
      .catch(() => setPending([]));
  }, [slug]);

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${`${page}`.replace("&", "?")}`;
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Centro notifiche</div>
          <h1 className="bs-page-title">Notifiche</h1>
          <div className="bs-page-subtitle">Sede: Sede1</div>
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
            <button className="btn btn-outline-primary btn-sm" type="button" data-browser-notifications-enable="">
              <i className="bi bi-bell me-1" />
              <span data-browser-notifications-label="">Attiva notifiche browser</span>
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
          <form className="modal-content" data-browser-notifications-preferences-form="">
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
              <button className="btn btn-primary" type="submit" data-browser-notifications-preferences-save="">
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
        <div className="d-grid gap-3">
          {pending.map((item) => (
            <div className="card notification-card p-4" key={item.id}>
              <div className="notification-main notification-main--primary">
                <div className="fw-semibold">{item.title}</div>
                <div className="text-muted small mt-1">{item.message}</div>
              </div>
              <div className="mt-3">
                <a className="btn btn-sm btn-primary" href={href(item.link)}>
                  Apri
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
