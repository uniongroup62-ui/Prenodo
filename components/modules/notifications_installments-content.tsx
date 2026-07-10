"use client";

import { useCallback, useEffect, useState } from "react";

// Port fedele di app/pages/notifications_installments.php ("Rate in scadenza /
// scadute"): card per GRUPPO (titolo + badge conteggio + testo + date_label +
// Anteprima fino a 25 righe 'Rata N - d/m/Y - € X' + '...e altre N' + link
// 'Apri in Gestione Rate' coi filtri status/due) via
// /api/manage/notifications?action=installment_groups, finestra configurabile
// dal modale "Impostazioni avviso rate" (automation_settings.installment_alert
// _days) e flash legacy sopra l'header.

type PreviewRow = { clientName: string; installmentNo: number; dueLabel: string; amount: number };
type Group = {
  key: string;
  kind: "danger" | "warning" | "info";
  title: string;
  text: string;
  link: string;
  count: number;
  badgeClass: string;
  dateLabel: string;
  previewRows: PreviewRow[];
  linesMore: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function closeInstallmentSettingsModal(): void {
  if (typeof window === "undefined") return;
  const el = document.getElementById("installmentNotificationSettingsModal");
  const bs = (window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance: (e: Element) => { hide: () => void } } } }).bootstrap;
  if (el && bs?.Modal) bs.Modal.getOrCreateInstance(el).hide();
}

// fmt_money legacy (1.234,56).
function fmtMoney(value: number): string {
  const fixed = Math.abs(Number(value) || 0).toFixed(2);
  const [i, d] = fixed.split(".");
  return `${Number(value) < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

// Euristica alert legacy (notifications_installments.php 45-54).
function alertTypeFor(msg: string): "success" | "warning" {
  const low = msg.toLowerCase();
  return ["non autorizzata", "non valida", "errore", "impossibile", "non disponibile"].some((n) => low.includes(n)) ? "warning" : "success";
}

export function NotificationsInstallmentsContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();
  const [groups, setGroups] = useState<Group[]>([]);
  const [canSee, setCanSee] = useState(true);
  const [schemaOk, setSchemaOk] = useState(true);
  const [locationLabel, setLocationLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [alertDays, setAlertDays] = useState(7);
  const [alertDaysInput, setAlertDaysInput] = useState("7");
  const [savingSettings, setSavingSettings] = useState(false);
  const [flash, setFlash] = useState("");

  const load = useCallback(() => {
    // `loading` parte true e si azzera nel .finally (niente setState sincroni
    // nel percorso chiamato dall'effect).
    fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=installment_groups`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) return;
        setGroups(Array.isArray(j.groups) ? j.groups : []);
        setCanSee(Boolean(j.canSee));
        setSchemaOk(Boolean(j.schemaOk));
        setLocationLabel(String(j.locationLabel ?? ""));
        const n = Number(j.alertDays);
        if (Number.isFinite(n)) {
          setAlertDays(n);
          setAlertDaysInput(String(n));
        }
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // installment_notification_days_label: 'oggi' | 'nei prossimi N giorno/i'.
  const windowText = alertDays === 0 ? "oggi" : `nei prossimi ${alertDays} ${alertDays === 1 ? "giorno" : "giorni"}`;
  let subtitle = `Mostra le rate gia scadute e quelle in scadenza ${windowText}.`;
  if (locationLabel) subtitle += ` Sede: ${locationLabel}.`;

  function manageHref(): string {
    return `/${encodeURIComponent(slug)}/installments_manage`;
  }

  // Port del POST action=save_settings (installment_notification_set_days):
  // clamp 0..365, flash legacy 'Impostazioni salvate'/'Operazione non valida'.
  async function saveAlertDays() {
    const parsed = Number.parseInt(alertDaysInput, 10);
    const days = Number.isFinite(parsed) ? Math.min(365, Math.max(0, parsed)) : alertDays;
    setSavingSettings(true);
    try {
      const res = await fetch(`/api/manage/installments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "save_alert_days", alert_days: String(days) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setFlash(String(json?.error || "Operazione non valida"));
      } else {
        setFlash("Impostazioni salvate");
        const saved = typeof json?.alertDays === "number" ? json.alertDays : days;
        setAlertDays(saved);
        setAlertDaysInput(String(saved));
        load();
      }
      closeInstallmentSettingsModal();
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    } catch {
      setFlash("Operazione non valida");
      closeInstallmentSettingsModal();
    } finally {
      setSavingSettings(false);
    }
  }

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
          <h1 className="bs-page-title">Rate in scadenza / scadute</h1>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex flex-wrap justify-content-end gap-2">
            <button
              className="btn btn-outline-secondary btn-sm"
              type="button"
              data-bs-toggle="modal"
              data-bs-target="#installmentNotificationSettingsModal"
            >
              <i className="bi bi-gear me-1" />
              Impostazioni
            </button>
            <a className="btn btn-outline-primary btn-sm" href={manageHref()}>
              <i className="bi bi-cash-stack me-1" />
              Apri Gestione Rate
            </a>
          </div>
        </div>
      </div>

      {!canSee ? (
        <div className="card p-4">
          <div className="fw-semibold">Permesso non disponibile.</div>
          <div className="text-muted small mt-1">Non hai i permessi necessari per visualizzare le rate.</div>
        </div>
      ) : !schemaOk ? (
        <div className="card p-4">
          <div className="fw-semibold">Rate non disponibili.</div>
          <div className="text-muted small mt-1">La struttura dati della Gestione Rate non e disponibile.</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessuna rata in scadenza o scaduta."}</div>
          <div className="text-muted small mt-1">Qui vedrai le rate gia scadute e quelle in scadenza {windowText}.</div>
        </div>
      ) : (
        groups.map((group) => (
          <div className="card mb-3 notification-card" key={group.key}>
            <div className="d-flex flex-wrap">
              <div className={`p-3 flex-grow-1 notification-main notification-main--${group.kind}`}>
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <div className="fw-bold fs-5 mb-1">{group.title}</div>
                  <span className={`badge ${group.badgeClass}`}>{group.count}</span>
                </div>
                <div className="text-muted small">{group.text}</div>
                <div className="text-muted small mt-1">{group.dateLabel}</div>
              </div>

              <div className="p-3 flex-grow-1 notification-detail">
                <div className="text-muted small mb-1">Anteprima</div>
                {group.previewRows.map((row, i) => (
                  <div className="mb-2" key={i}>
                    <div className="fw-semibold">{row.clientName}</div>
                    <div className="text-muted small">Rata {row.installmentNo} - {row.dueLabel} - € {fmtMoney(row.amount)}</div>
                  </div>
                ))}
                {group.linesMore > 0 ? <div className="text-muted small">...e altre {group.linesMore}</div> : null}
              </div>

              <div className="p-3 notification-action">
                <div className="d-grid gap-2">
                  <a className="btn btn-outline-primary btn-sm" href={group.link || manageHref()}>
                    <i className="bi bi-box-arrow-up-right me-1" />
                    Apri in Gestione Rate
                  </a>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      <div className="modal fade" id="installmentNotificationSettingsModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-dialog-centered">
          <form
            method="post"
            className="modal-content"
            onSubmit={(e) => {
              e.preventDefault();
              void saveAlertDays();
            }}
          >
            <input type="hidden" name="action" value="save_settings" />
            <div className="modal-header">
              <h2 className="modal-title h5">Impostazioni avviso rate</h2>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <label className="form-label fw-semibold" htmlFor="installment_alert_days">
                Avvisa per le rate in scadenza nei prossimi
              </label>
              <div className="input-group">
                <input
                  className="form-control"
                  id="installment_alert_days"
                  name="installment_alert_days"
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  required
                  value={alertDaysInput}
                  onChange={(e) => setAlertDaysInput(e.target.value)}
                />
                <span className="input-group-text">giorni</span>
              </div>
              <div className="form-text">
                Le rate gia scadute vengono sempre mostrate. Imposta 0 per includere solo quelle scadute e quelle in scadenza oggi.
              </div>
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
