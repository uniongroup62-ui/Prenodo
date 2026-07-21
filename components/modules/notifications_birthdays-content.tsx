"use client";

import { useCallback, useEffect, useState } from "react";

// Port fedele di app/pages/notifications_birthdays.php ("Compleanni clienti"):
// card legacy per cliente (badge Oggi/'Tra N giorno/i', Compleanno d/m/Y, Eta,
// Sede riferimento, Contatti, 'Apri cliente') alimentate da
// /api/manage/notifications?action=birthdays (righe server-side con le
// esclusioni legacy: clienti bloccati + clienti-sconosciuto auto-creati,
// fallback 29/02→28/02), finestra configurabile dal modale (clamp 0..365 su
// automation_settings.client_birthday_alert_days) e flash legacy in testa.

type BirthdayRow = {
  id: number;
  fullName: string;
  phone: string;
  email: string;
  birthdayNextDate: string;
  birthdayDays: number;
  birthdayAge: number;
  locationName: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function closeBirthdaySettingsModal(): void {
  if (typeof window === "undefined") return;
  const el = document.getElementById("birthdayNotificationSettingsModal");
  const bs = (window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance: (e: Element) => { hide: () => void } } } }).bootstrap;
  if (el && bs?.Modal) bs.Modal.getOrCreateInstance(el).hide();
}

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "-";
}

// Euristica alert legacy (notifications_birthdays.php 42-50).
function alertTypeFor(msg: string): "success" | "warning" {
  const low = msg.toLowerCase();
  return ["non autorizzata", "non valida", "errore", "impossibile", "non disponibile"].some((n) => low.includes(n)) ? "warning" : "success";
}

export function NotificationsBirthdaysContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();

  const [rows, setRows] = useState<BirthdayRow[]>([]);
  // Primo caricamento: l'empty-state mostra 'Caricamento…' invece di
  // 'Nessun compleanno' (pattern Rate/Preventivi).
  const [loading, setLoading] = useState(true);
  const [canSee, setCanSee] = useState(true);
  const [schemaOk, setSchemaOk] = useState(true);
  const [alertDays, setAlertDays] = useState(7);
  const [daysInput, setDaysInput] = useState("7");
  const [flash, setFlash] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=birthdays`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) return;
        setRows(Array.isArray(j.rows) ? j.rows : []);
        setCanSee(Boolean(j.canSee));
        setSchemaOk(Boolean(j.schemaOk));
        const n = Number(j.alertDays);
        if (Number.isFinite(n) && n >= 0 && n <= 365) {
          setAlertDays(n);
          setDaysInput(String(n));
        }
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // client_birthday_notification_days_label: 'oggi' | 'nei prossimi N giorno/i'.
  const windowText = alertDays === 0 ? "oggi" : `nei prossimi ${alertDays} ${alertDays === 1 ? "giorno" : "giorni"}`;

  // Port di action=save_settings: clamp 0..365, flash 'Impostazioni salvate'.
  // Audit giro 3: guardia doppio-submit (il gemello installments ce l'ha già).
  const [savingSettings, setSavingSettings] = useState(false);
  const submitSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingSettings) return;
    setSavingSettings(true);
    const parsed = Number.parseInt(daysInput, 10);
    const n = Number.isFinite(parsed) ? Math.min(365, Math.max(0, parsed)) : alertDays;
    try {
      const response = await fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "save_birthday_days", client_birthday_alert_days: String(n) }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        setFlash(String(json.message || "Impostazioni salvate"));
        setAlertDays(Number(json.days ?? n));
        setDaysInput(String(json.days ?? n));
        load();
      } else {
        setFlash(String(json.error || "Operazione non valida"));
      }
    } catch {
      setFlash("Operazione non valida");
    } finally {
      setSavingSettings(false);
    }
    closeBirthdaySettingsModal();
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      {flash ? (
        <div className={`alert alert-${alertTypeFor(flash)} alert-dismissible`} role="alert">
          {flash}
          <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setFlash("")} />
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Notifiche</div>
          <h1 className="bs-page-title">Compleanni clienti</h1>
          <div className="bs-page-subtitle">Mostra i clienti con compleanno {windowText}.</div>
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

      {!canSee ? (
        <div className="card p-4">
          <div className="fw-semibold">Permesso non disponibile.</div>
          <div className="text-muted small mt-1">Non hai i permessi necessari per visualizzare i compleanni dei clienti.</div>
        </div>
      ) : !schemaOk ? (
        <div className="card p-4">
          <div className="fw-semibold">Compleanni non disponibili.</div>
          <div className="text-muted small mt-1">La struttura dati dei clienti non contiene la data di nascita.</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessun compleanno cliente."}</div>
          <div className="text-muted small mt-1">Qui vedrai i clienti con compleanno {windowText}.</div>
        </div>
      ) : (
        rows.map((row) => {
          const days = row.birthdayDays;
          const accentClass = days === 0 ? "notification-main--danger" : "notification-main--primary";
          const badgeClass = days === 0 ? "text-bg-danger" : "text-bg-primary";
          const badgeText = days === 0 ? "Oggi" : `Tra ${days} ${days === 1 ? "giorno" : "giorni"}`;
          return (
            <div className="card mb-3 notification-card" key={row.id}>
              <div className="d-flex flex-wrap">
                <div className={`p-3 flex-grow-1 notification-main ${accentClass}`}>
                  <div className="d-flex align-items-center justify-content-between gap-2">
                    <div className="fw-bold fs-5 mb-1">{row.fullName || "Cliente"}</div>
                    <span className={`badge ${badgeClass}`}>{badgeText}</span>
                  </div>
                  <div className="text-muted small">Compleanno: <strong>{fmtDate(row.birthdayNextDate)}</strong></div>
                  {row.birthdayAge > 0 ? (
                    <div className="text-muted small mt-1">Eta: {row.birthdayAge} anni</div>
                  ) : null}
                  {row.locationName ? (
                    <div className="text-muted small mt-1">Sede riferimento: {row.locationName}</div>
                  ) : null}
                </div>

                <div className="p-3 flex-grow-1 notification-detail">
                  <div className="text-muted small mb-1">Contatti</div>
                  <div className="fw-semibold">{row.phone || "-"}</div>
                  <div className="text-muted small">{row.email || "-"}</div>
                </div>

                <div className="p-3 notification-action">
                  <div className="d-grid gap-2">
                    <a className="btn btn-outline-primary btn-sm" href={`/${encodeURIComponent(slug)}/clients?action=view&id=${row.id}`}>
                      <i className="bi bi-box-arrow-up-right me-1" />
                      Apri cliente
                    </a>
                  </div>
                </div>
              </div>
            </div>
          );
        })
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
              <button className="btn btn-primary" type="submit" disabled={savingSettings}>
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
