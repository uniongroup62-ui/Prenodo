"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP page ?page=notifications_birthdays
// (app/pages/notifications_birthdays.php): shows clients whose birthday falls
// in the next N days plus a settings modal to configure the alert window.
//
// There is no dedicated birthdays/settings API route, so we read the existing
// DB-backed /api/manage/clients list and compute upcoming birthdays client-side
// from the optional `birthday` field. When no client has an upcoming birthday
// (the current live data) the original empty state is rendered verbatim.

type Client = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  birthday?: string;
};

const DEFAULT_ALERT_DAYS = 7;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Days from today until the next occurrence of the given month/day birthday.
function daysUntilBirthday(birthday: string | undefined, today: Date): number | null {
  if (!birthday) return null;
  const d = birthday.slice(0, 10);
  const [, m, day] = d.split("-").map((x) => Number(x));
  if (!m || !day) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let next = new Date(today.getFullYear(), m - 1, day);
  if (next < base) next = new Date(today.getFullYear() + 1, m - 1, day);
  return Math.round((next.getTime() - base.getTime()) / 86400000);
}

export function NotificationsBirthdaysContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [clients, setClients] = useState<Client[]>([]);
  const [alertDays, setAlertDays] = useState<number>(DEFAULT_ALERT_DAYS);
  const [daysInput, setDaysInput] = useState<string>(String(DEFAULT_ALERT_DAYS));
  const [settingsMessage, setSettingsMessage] = useState<string>("");

  useEffect(() => {
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setClients(Array.isArray(j.clients) ? j.clients : []))
      .catch(() => setClients([]));
    // Valore persistito (automation_settings.client_birthday_alert_days).
    fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=settings`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const n = Number(j.client_birthday_alert_days);
        if (Number.isFinite(n) && n >= 0 && n <= 365) {
          setAlertDays(n);
          setDaysInput(String(n));
        }
      })
      .catch(() => undefined);
  }, [slug]);

  // Port di notifications_birthdays.php action=save_settings: persiste il
  // valore lato server e aggiorna la lista, messaggio legacy.
  const submitSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const n = Number(daysInput);
    if (!Number.isFinite(n) || n < 0 || n > 365) return;
    setSettingsMessage("");
    try {
      const response = await fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "save_birthday_days", client_birthday_alert_days: String(n) }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        setAlertDays(Number(json.days ?? n));
        setSettingsMessage(json.message || "Impostazioni salvate");
      } else {
        setSettingsMessage(json.error || "Operazione non valida");
      }
    } catch {
      setSettingsMessage("Operazione non valida");
    }
  };

  const today = new Date();
  const upcoming = clients
    .map((c) => ({ client: c, days: daysUntilBirthday(c.birthday, today) }))
    .filter((row): row is { client: Client; days: number } => row.days !== null && row.days <= alertDays)
    .sort((a, b) => a.days - b.days);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`notifications_birthdays${suffix}`.replace("&", "?")}`;
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Notifiche</div>
          <h1 className="bs-page-title">Compleanni clienti</h1>
          <div className="bs-page-subtitle">Mostra i clienti con compleanno nei prossimi 7 giorni.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex flex-wrap justify-content-end gap-2">
            <button
              className="btn btn-outline-secondary btn-sm"
              type="button"
              data-bs-toggle="modal"
              data-bs-target="#birthdayNotificationSettingsModal"
            >
              <i className="bi bi-gear me-1" />
              Impostazioni
            </button>
            <a className="btn btn-outline-primary btn-sm" href={`/${encodeURIComponent(slug)}/clients?location_id=all`}>
              <i className="bi bi-people me-1" />
              Apri Clienti
            </a>
          </div>
        </div>
      </div>

      {upcoming.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">Nessun compleanno cliente.</div>
          <div className="text-muted small mt-1">Qui vedrai i clienti con compleanno nei prossimi 7 giorni.</div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Contatti</th>
                  <th>Compleanno</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(({ client, days }) => (
                  <tr key={client.id}>
                    <td className="fw-semibold">{client.name}</td>
                    <td className="text-muted">
                      {client.phone ? (
                        <>
                          {client.phone}
                          <br />
                        </>
                      ) : null}
                      {client.email || "—"}
                    </td>
                    <td className="text-muted small">
                      {days === 0 ? "Oggi" : `Tra ${days} giorni`}
                    </td>
                    <td className="text-end">
                      <a className="btn btn-sm btn-primary" href={href(`&action=view&id=${client.id}`)}>
                        Apri
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="modal fade" id="birthdayNotificationSettingsModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-dialog-centered">
          <form method="post" className="modal-content" onSubmit={submitSettings}>
            <input type="hidden" name="action" value="save_settings" />
            <div className="modal-header">
              <h2 className="modal-title h5">Impostazioni avviso compleanni</h2>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              {settingsMessage ? (
                <div className={`alert ${settingsMessage === "Impostazioni salvate" ? "alert-success" : "alert-danger"} py-2`}>{settingsMessage}</div>
              ) : null}
              <label className="form-label fw-semibold" htmlFor="client_birthday_alert_days">
                Avvisa per i compleanni nei prossimi
              </label>
              <div className="input-group">
                <input
                  className="form-control"
                  id="client_birthday_alert_days"
                  name="client_birthday_alert_days"
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  required
                  value={daysInput}
                  onChange={(e) => setDaysInput(e.target.value)}
                />
                <span className="input-group-text">giorni</span>
              </div>
              <div className="form-text">Imposta 0 per includere solo i compleanni di oggi.</div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button className="btn btn-primary" type="submit">
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
