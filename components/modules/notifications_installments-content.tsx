"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP installment-notifications page
// (?page=notifications_installments, "Rate in scadenza / scadute").
// The page lists installments already overdue plus those due within the next N
// days (default 7, configurable via the "Impostazioni avviso rate" modal), and
// links to "Gestione Rate". It is fed by the existing DB-backed
// /api/manage/installments route, whose installment plans we flatten and filter.

const DEFAULT_ALERT_DAYS = 7;

type ApiInstallment = {
  id: number;
  dueDate: string;
  amount: number;
  status: string;
  paidAt?: string;
};

type ApiInstallmentPlan = {
  id: number;
  saleId: number;
  clientId: number;
  clientName: string;
  total: number;
  paid: number;
  status: string;
  installments: ApiInstallment[];
  createdAt: string;
};

type DueRow = {
  key: string;
  planId: number;
  installmentId: number;
  clientName: string;
  amount: number;
  dueDate: string;
  overdue: boolean;
};

type DueGroup = {
  key: string;
  title: string;
  kind: "danger" | "warning" | "info";
  rows: DueRow[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Hide the Bootstrap settings modal after a successful save (bootstrap 5 global, loaded by the shell).
function closeInstallmentSettingsModal(): void {
  if (typeof window === "undefined") return;
  const el = document.getElementById("installmentNotificationSettingsModal");
  const bs = (window as unknown as { bootstrap?: { Modal?: { getOrCreateInstance: (e: Element) => { hide: () => void } } } }).bootstrap;
  if (el && bs?.Modal) bs.Modal.getOrCreateInstance(el).hide();
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10) || "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function fmtEur(value: number): string {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(
    Number.isFinite(value) ? value : 0,
  );
}

export function NotificationsInstallmentsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [plans, setPlans] = useState<ApiInstallmentPlan[]>([]);
  const [loading, setLoading] = useState(true);
  // The alert window is PERSISTED (automation_settings.installment_alert_days) — seeded from the API
  // response on load, saved back via POST action=save_alert_days from the settings modal.
  const [alertDays, setAlertDays] = useState(DEFAULT_ALERT_DAYS);
  const [alertDaysInput, setAlertDaysInput] = useState(String(DEFAULT_ALERT_DAYS));
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/installments?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setPlans(Array.isArray(j.plans) ? j.plans : []);
        if (typeof j.alertDays === "number" && Number.isFinite(j.alertDays)) {
          setAlertDays(j.alertDays);
          setAlertDaysInput(String(j.alertDays));
        }
      })
      .catch(() => setPlans([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo<DueRow[]>(() => {
    const today = startOfDay(new Date());
    const horizon = today + Math.max(0, alertDays) * 24 * 60 * 60 * 1000;
    const out: DueRow[] = [];
    for (const plan of plans) {
      for (const inst of plan.installments ?? []) {
        const status = String(inst.status ?? "");
        if (status === "paid" || status === "cancelled" || status === "canceled") continue;
        const dueMs = Date.parse(inst.dueDate);
        if (!Number.isFinite(dueMs)) continue;
        const dueDay = startOfDay(new Date(dueMs));
        const overdue = dueDay < today || status === "overdue";
        // Always show overdue; show upcoming only within the alert horizon.
        if (!overdue && dueDay > horizon) continue;
        out.push({
          key: `${plan.id}-${inst.id}`,
          planId: plan.id,
          installmentId: inst.id,
          clientName: plan.clientName || "—",
          amount: Number(inst.amount ?? 0),
          dueDate: inst.dueDate,
          overdue,
        });
      }
    }
    return out.sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
  }, [plans, alertDays]);

  // Group the due rows by days-to-due (overdue → danger, today/tomorrow → warning, later → info),
  // faithful to SaleInstallments::getDueAlertGroups' overdue + due_N buckets.
  const groups = useMemo<DueGroup[]>(() => {
    const today = startOfDay(new Date());
    const dayMs = 24 * 60 * 60 * 1000;
    const byKey = new Map<string, { daysDiff: number; rows: DueRow[] }>();
    for (const row of rows) {
      const dueDay = startOfDay(new Date(Date.parse(row.dueDate)));
      const daysDiff = Math.round((dueDay - today) / dayMs);
      const key = daysDiff < 0 ? "overdue" : `due_${daysDiff}`;
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { daysDiff, rows: [] };
        byKey.set(key, bucket);
      }
      bucket.rows.push(row);
    }
    const titleFor = (daysDiff: number): string => {
      if (daysDiff < 0) return "Rate scadute";
      if (daysDiff === 0) return "Rate in scadenza oggi";
      if (daysDiff === 1) return "Rate in scadenza domani";
      return `Rate in scadenza tra ${daysDiff} giorni`;
    };
    const kindFor = (daysDiff: number): DueGroup["kind"] => (daysDiff < 0 ? "danger" : daysDiff <= 1 ? "warning" : "info");
    return [...byKey.entries()]
      .sort((a, b) => (a[1].daysDiff < 0 ? -1 : b[1].daysDiff < 0 ? 1 : a[1].daysDiff - b[1].daysDiff))
      .map(([key, bucket]) => ({ key, title: titleFor(bucket.daysDiff), kind: kindFor(bucket.daysDiff), rows: bucket.rows }));
  }, [rows]);

  function manageHref(): string {
    return `/${encodeURIComponent(slug)}/installments_manage`;
  }

  // Persist the alert window (POST action=save_alert_days) then close the settings modal.
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
      const saved = typeof json?.alertDays === "number" ? json.alertDays : days;
      setAlertDays(saved);
      setAlertDaysInput(String(saved));
      closeInstallmentSettingsModal();
    } catch {
      // Keep the modal open on failure; the local value still reflects the attempt.
      setAlertDays(days);
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Notifiche</div>
          <h1 className="bs-page-title">Rate in scadenza / scadute</h1>
          <div className="bs-page-subtitle">
            Mostra le rate gia scadute e quelle in scadenza nei prossimi {alertDays} giorni.
          </div>
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

      {groups.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">
            {loading ? "Caricamento…" : "Nessuna rata in scadenza o scaduta."}
          </div>
          <div className="text-muted small mt-1">
            Qui vedrai le rate gia scadute e quelle in scadenza nei prossimi {alertDays} giorni.
          </div>
        </div>
      ) : (
        <div className="d-flex flex-column gap-4">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="d-flex align-items-center gap-2 mb-2">
                <span className={`badge text-bg-${group.kind}`}>{group.rows.length}</span>
                <h2 className="h6 mb-0">{group.title}</h2>
              </div>
              <div className="d-flex flex-column gap-2">
                {group.rows.map((row) => (
                  <div
                    key={row.key}
                    className={`card notification-card notification-main notification-main--${group.kind} p-3`}
                  >
                    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
                      <div>
                        <div className="fw-semibold">{row.clientName}</div>
                        <div className="text-muted small">
                          {row.overdue ? "Rata scaduta" : "Rata in scadenza"} - Scadenza: {fmtDate(row.dueDate)}
                        </div>
                      </div>
                      <div className="d-flex align-items-center gap-3">
                        <div className="fw-semibold">{fmtEur(row.amount)}</div>
                        <a className="btn btn-sm btn-outline-primary" href={manageHref()}>
                          <i className="bi bi-cash-stack me-1" />
                          Apri Gestione Rate
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className="modal fade"
        id="installmentNotificationSettingsModal"
        tabIndex={-1}
        aria-hidden="true"
      >
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
                Le rate gia scadute vengono sempre mostrate. Imposta 0 per includere solo quelle scadute
                e quelle in scadenza oggi.
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">
                Annulla
              </button>
              <button className="btn btn-primary" type="submit" disabled={savingSettings}>
                <i className="bi bi-check2-circle me-1" />
                {savingSettings ? "Salvataggio…" : "Salva"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
