"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP booking settings page (app/pages/booking.php — admin
// view, ?page=booking). Two-column layout: a settings form (choose-staff toggle,
// customer-cancel toggle + minimum-cancel time) and a "Link prenotazione online"
// card. Values are pre-filled from the existing DB-backed APIs:
//   - /api/manage/configuration?module=business_profile -> "Booking staff" record
//     drives booking_choose_staff_enabled.
//   - /api/manage/business-settings -> business name + public booking URL.

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

type ConfigRecord = {
  id: number;
  module: string;
  title: string;
  detail: string;
  value: string;
  active: boolean;
};

export function BookingSettingsContent() {
  const slug = tenantSlug();

  // Settings form state (pre-filled on mount from the API where available).
  const [chooseStaffEnabled, setChooseStaffEnabled] = useState(false);
  const [customerCancelEnabled, setCustomerCancelEnabled] = useState(true);
  const [cancelBeforeValue, setCancelBeforeValue] = useState("24");
  const [cancelBeforeUnit, setCancelBeforeUnit] = useState("hours");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Save (port of the legacy booking.php admin POST): the 4 settings land on
  // the businesses row via action=booking_settings_save.
  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "booking_settings_save",
          booking_choose_staff_enabled: chooseStaffEnabled ? "1" : "",
          booking_customer_cancel_enabled: customerCancelEnabled ? "1" : "",
          booking_customer_cancel_before_value: cancelBeforeValue,
          booking_customer_cancel_before_unit: cancelBeforeUnit,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; settings?: { booking_customer_cancel_before_value?: number; booking_customer_cancel_before_unit?: string } } | null;
      if (!res.ok || !data?.ok) {
        setSaveMsg({ ok: false, text: String(data?.error || "Errore salvataggio impostazioni booking") });
        return;
      }
      // Reflect the server clamps (e.g. hours > 8760).
      if (data.settings) {
        setCancelBeforeValue(String(data.settings.booking_customer_cancel_before_value ?? cancelBeforeValue));
        if (data.settings.booking_customer_cancel_before_unit) setCancelBeforeUnit(data.settings.booking_customer_cancel_before_unit);
      }
      setSaveMsg({ ok: true, text: data.message || "Impostazioni booking salvate" });
    } catch {
      setSaveMsg({ ok: false, text: "Errore di rete durante il salvataggio." });
    } finally {
      setSaving(false);
    }
  }

  // Link card data.
  const [businessName, setBusinessName] = useState("");
  const [bookingUrl, setBookingUrl] = useState("");

  useEffect(() => {
    if (!slug) return;

    // Prefill from the businesses row (the same columns the save writes and
    // the customer-area cancel policy reads).
    fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}&section=booking`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const s = j?.bookingSettings;
        if (!s) return;
        setChooseStaffEnabled(Boolean(s.booking_choose_staff_enabled));
        setCustomerCancelEnabled(Boolean(s.booking_customer_cancel_enabled));
        setCancelBeforeValue(String(s.booking_customer_cancel_before_value ?? "0"));
        if (s.booking_customer_cancel_before_unit) setCancelBeforeUnit(String(s.booking_customer_cancel_before_unit));
      })
      .catch(() => {});

    // Business name (link card subtitle) + public booking URL.
    fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const name = String(j?.business?.name ?? j?.tenant?.name ?? "");
        if (name) setBusinessName(name);
        const url = String(j?.marketplace?.profile?.booking_url ?? "");
        if (url) setBookingUrl(url);
      })
      .catch(() => {});
  }, [slug]);

  const publicHref =
    bookingUrl ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/${encodeURIComponent(slug)}/booking?public=1`
      : `/${encodeURIComponent(slug)}/booking?public=1`);

  function cancelHref(): string {
    return `/${encodeURIComponent(slug)}/booking`;
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/booking.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Booking</h1>
          <div className="bs-page-subtitle">Opzioni della prenotazione online.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-primary" href={publicHref} target="_blank" rel="noopener">
            <i className="bi bi-box-arrow-up-right me-1" />
            Apri pagina pubblica
          </a>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="card p-4">
            <form method="post" className="row g-3" onSubmit={saveSettings}>
              <div className="col-12">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="booking_choose_staff_enabled"
                    id="bookingChooseStaff"
                    value="1"
                    checked={chooseStaffEnabled}
                    onChange={(e) => setChooseStaffEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="bookingChooseStaff">
                    Permetti al cliente di scegliere l&apos;operatore
                  </label>
                  <div className="form-text">Se disattivato, l&apos;operatore verrà assegnato automaticamente.</div>
                </div>
              </div>

              <div className="col-12">
                <hr />
              </div>

              <div className="col-12">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="booking_customer_cancel_enabled"
                    id="bookingCustomerCancelEnabled"
                    value="1"
                    checked={customerCancelEnabled}
                    onChange={(e) => setCustomerCancelEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="bookingCustomerCancelEnabled">
                    Permetti al cliente di annullare il proprio appuntamento
                  </label>
                  <div className="form-text">
                    Se attivo, il cliente potrà annullare l&apos;appuntamento dalla propria area cliente.
                  </div>
                </div>
              </div>

              <div className="col-md-6">
                <label className="form-label" htmlFor="bookingCancelBeforeValue">
                  Tempo minimo per annullare
                </label>
                <div className="input-group">
                  <input
                    className="form-control"
                    type="number"
                    min="0"
                    step="1"
                    name="booking_customer_cancel_before_value"
                    id="bookingCancelBeforeValue"
                    value={cancelBeforeValue}
                    onChange={(e) => setCancelBeforeValue(e.target.value)}
                  />
                  <select
                    className="form-select booking-cancel-unit"
                    name="booking_customer_cancel_before_unit"
                    id="bookingCancelBeforeUnit"
                    value={cancelBeforeUnit}
                    onChange={(e) => setCancelBeforeUnit(e.target.value)}
                  >
                    <option value="hours">Ore</option>
                    <option value="days">Giorni</option>
                  </select>
                </div>
                <div className="form-text">
                  Esempio: <strong>24 ore</strong> o <strong>2 giorni</strong> prima dell&apos;appuntamento. Imposta{" "}
                  <strong>0</strong> per consentire l&apos;annullamento fino all&apos;inizio.
                </div>
              </div>

              {saveMsg ? (
                <div className="col-12">
                  <div className={`alert py-2 small mb-0 ${saveMsg.ok ? "alert-success" : "alert-danger"}`}>{saveMsg.text}</div>
                </div>
              ) : null}
              <div className="col-12 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
                <a className="btn btn-outline-secondary btn-pill" href={cancelHref()}>
                  Annulla
                </a>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card card-soft p-4">
            <div className="h6 fw-bold mb-2">Link prenotazione online</div>
            <div className="small-muted">{businessName || "—"}</div>
            <div className="text-muted small">Condividi questo link con i clienti per prenotare online.</div>
            <div className="mt-3 p-2 bg-light border rounded-3 booking-break-word">
              <code>{publicHref}</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
