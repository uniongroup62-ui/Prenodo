"use client";

import { useEffect, useState } from "react";
import { useTakenFlash } from "./flash";

// Faithful port of the PHP booking settings page (app/pages/booking.php — admin
// view, ?page=booking). Two-column layout: a settings form (choose-staff toggle,
// customer-cancel toggle + minimum-cancel time, campi disabilitati come
// booking.js syncCustomerCancelFields) and a "Link prenotazione online" card.
// Prefill da /api/manage/business-settings?section=booking (businesses row);
// save via action=booking_settings_save con flash legacy sopra l'header.

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function BookingSettingsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: { msg?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  // Settings form state (pre-filled on mount from the API where available).
  // Default pre-load = riga businesses vuota nel legacy: tutto spento, 0 ore.
  const [chooseStaffEnabled, setChooseStaffEnabled] = useState(false);
  const [customerCancelEnabled, setCustomerCancelEnabled] = useState(false);
  const [cancelBeforeValue, setCancelBeforeValue] = useState("0");
  const [cancelBeforeUnit, setCancelBeforeUnit] = useState("hours");
  const [saving, setSaving] = useState(false);
  // Auth::requirePerm legacy: 403 → pagina 'Accesso negato'.
  const [accessDenied, setAccessDenied] = useState(false);
  // Flash legacy: View::alert PRIMA del pageHeader; danger se il messaggio
  // contiene 'non' o 'chiusi', altrimenti success (booking.php 8742-8744).
  const [flash, setFlash] = useState<string>(initialQuery?.msg ?? "");
  useTakenFlash((f) => {
    if (f.msg) setFlash(f.msg);
  });
  const flashType = flash && (flash.includes("non") || flash.includes("chiusi")) ? "danger" : "success";

  // Save (port of the legacy booking.php admin POST): the 4 settings land on
  // the businesses row via action=booking_settings_save; il legacy fa redirect
  // a ?msg=Impostazioni booking salvate con flash sopra l'header.
  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      // Con l'annullo spento i campi valore/unità sono DISABLED e il form
      // legacy NON li invia → il server salva 0/'hours' (reset). Replichiamo
      // omettendoli dal payload.
      const payload: Record<string, string> = {
        action: "booking_settings_save",
        booking_choose_staff_enabled: chooseStaffEnabled ? "1" : "",
        booking_customer_cancel_enabled: customerCancelEnabled ? "1" : "",
      };
      if (customerCancelEnabled) {
        payload.booking_customer_cancel_before_value = cancelBeforeValue;
        payload.booking_customer_cancel_before_unit = cancelBeforeUnit;
      }
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; settings?: { booking_customer_cancel_before_value?: number; booking_customer_cancel_before_unit?: string } } | null;
      if (!res.ok || !data?.ok) {
        setFlash(String(data?.error || "Errore salvataggio impostazioni booking: Operazione non riuscita (verifica schema o permessi ALTER TABLE)"));
        window.scrollTo({ top: 0 });
        return;
      }
      // Reflect the server clamps (e.g. hours > 8760) e il reset a 0/'hours'
      // quando l'annullo è spento (semantica campi disabled del legacy).
      if (data.settings) {
        setCancelBeforeValue(String(data.settings.booking_customer_cancel_before_value ?? cancelBeforeValue));
        if (data.settings.booking_customer_cancel_before_unit) setCancelBeforeUnit(data.settings.booking_customer_cancel_before_unit);
      }
      const msg = data.message || "Impostazioni booking salvate";
      setFlash(msg);
      // URL sempre pulito: il flash vive solo nello stato.
      window.history.replaceState(null, "", `/${encodeURIComponent(slug)}/booking`);
      window.scrollTo({ top: 0 });
    } catch {
      setFlash("Errore salvataggio impostazioni booking: errore di rete (verifica schema o permessi ALTER TABLE)");
      window.scrollTo({ top: 0 });
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
      .then((r) => {
        if (r.status === 403) setAccessDenied(true);
        return r.json();
      })
      .then((j) => {
        // Nome attività dal prefill (visibile con solo booking.manage).
        if (j?.businessName) setBusinessName(String(j.businessName));
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

  // origin SOLO post-mount (idratazione: il branch typeof window nel render
  // faceva divergere SSR (path relativo) e client (URL assoluto) → mismatch).
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  // Link PUBBLICO che il gestore copia per i suoi clienti: si preferisce sempre
  // il booking_url salvato lato server (già sul dominio pubblico), poi la base
  // pubblica configurata; l'origin del browser è l'ultimo fallback perché nel
  // gestionale sarà app.<dominio> una volta separati i domini.
  const publicBase = (process.env.NEXT_PUBLIC_APP_URL || origin || "").replace(/\/+$/, "");
  const publicHref = bookingUrl || `${publicBase}/${encodeURIComponent(slug)}/booking?public=1`;

  function cancelHref(): string {
    return `/${encodeURIComponent(slug)}/booking`;
  }

  // Port della pagina 403 di Auth::requirePerm (Auth.php 494-505).
  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Non hai i permessi per accedere a questa sezione.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/booking.css" />

      {flash ? (
        <div className={`alert alert-${flashType} d-flex align-items-start gap-2`}>
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash}</div>
        </div>
      ) : null}

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
                  {/* booking.js syncCustomerCancelFields: i campi del tempo
                      minimo sono disabilitati quando l'annullamento è spento. */}
                  <input
                    className="form-control"
                    type="number"
                    min="0"
                    step="1"
                    name="booking_customer_cancel_before_value"
                    id="bookingCancelBeforeValue"
                    value={cancelBeforeValue}
                    disabled={!customerCancelEnabled}
                    onChange={(e) => setCancelBeforeValue(e.target.value)}
                  />
                  <select
                    className="form-select booking-cancel-unit"
                    name="booking_customer_cancel_before_unit"
                    id="bookingCancelBeforeUnit"
                    value={cancelBeforeUnit}
                    disabled={!customerCancelEnabled}
                    onChange={(e) => setCancelBeforeUnit(e.target.value)}
                  >
                    <option value="hours">Ore</option>
                    <option value="days">Giorni</option>
                  </select>
                </div>
                <div className="form-text">
                  Esempio: <strong>24 ore</strong> o <strong>2 giorni</strong>{" "}prima dell&apos;appuntamento. Imposta{" "}
                  <strong>0</strong>{" "}per consentire l&apos;annullamento fino all&apos;inizio.
                </div>
              </div>

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
            {/* setting_get('name','La mia attività') legacy: fallback verbatim. */}
            <div className="small-muted">{businessName || "La mia attività"}</div>
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
