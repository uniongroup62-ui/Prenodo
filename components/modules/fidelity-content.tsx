"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP fidelity settings page (app/pages/fidelity.php): a
// single "Impostazione generale" card with a global on/off switch mirroring the
// businesses.fidelity_enabled flag. The toggle now POSTs to
// /api/manage/fidelity (action=toggle) — the legacy toggle_fidelity — with the
// disable guards: refuse while fidelity-targeted Promozioni/Omaggi are active,
// and a confirm modal when pending/scheduled appointments still carry Fidelity
// benefits (stripped + points restored on confirm).

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

type Impact = {
  blockingPromotions?: Array<{ id: number; name: string }>;
  blockingGifts?: Array<{ id: number; name: string }>;
  linkedAppointmentCount?: number;
};

export function FidelityContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [confirmImpact, setConfirmImpact] = useState<Impact | null>(null);

  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=state`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (typeof j?.enabled === "boolean") setEnabled(j.enabled);
      })
      .catch(() => {});
  }, [slug]);

  async function submit(nextEnabled: boolean, confirmed: boolean) {
    if (saving) return;
    setSaving(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "toggle", fidelity_enabled: nextEnabled ? "1" : "0", disable_appointments_confirmed: confirmed ? "1" : "0" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Impossibile salvare."));
        setEnabled((prev) => prev); // keep current
        return;
      }
      if (j.needsConfirm) {
        setConfirmImpact(j.impact ?? {});
        return;
      }
      setConfirmImpact(null);
      setEnabled(Boolean(j.enabled));
      const stripped = Number(j.strippedAppointments ?? 0);
      // Messaggio composto legacy dal server (riattivazioni promo/omaggi, campagne
      // punti disattivate, agevolazioni rimosse); fallback al testo base.
      setFlash(String(j.message ?? "") || (nextEnabled ? "Fidelity attivata" : `Fidelity disattivata${stripped > 0 ? `. Rimosse automaticamente le agevolazioni Fidelity da ${stripped} prenotazioni` : ""}`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/fidelity.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelizzazione</div>
          <h1 className="bs-page-title">Fidelity</h1>
          <div className="bs-page-subtitle">Gestisci impostazioni generali e collegamenti del programma Fidelity.</div>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      <div className="card p-4 mb-3">
        <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
          <div>
            <div className="h5 fw-bold mb-1">Impostazione generale</div>
            <div className="text-muted small">
              Abilita o disabilita l&apos;intera funzione Fidelity. Quando &egrave; disattiva, le sezioni operative Fidelity
              vengono disabilitate; Ricariche e Portafoglio credito restano disponibili.
            </div>
          </div>
          <form
            className="d-flex align-items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(enabled, false);
            }}
          >
            <div className="form-check form-switch m-0">
              <input
                className="form-check-input"
                type="checkbox"
                id="fidEnabledGlobal"
                checked={enabled}
                disabled={saving}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <label className="form-check-label fw-semibold" htmlFor="fidEnabledGlobal">
                {enabled ? "Attivo" : "Disattivo"}
              </label>
            </div>
            <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              {saving ? "Salvataggio…" : "Salva"}
            </button>
          </form>
        </div>
      </div>

      {confirmImpact ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Disattiva Fidelity</h5>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => { setConfirmImpact(null); setEnabled(true); }} />
                </div>
                <div className="modal-body">
                  <div className="alert alert-warning">
                    <div className="fw-semibold mb-1">
                      {confirmImpact.linkedAppointmentCount ?? 0} prenotazioni con agevolazioni Fidelity
                    </div>
                    <div className="small">
                      Disattivando Fidelity il sistema rimuoverà automaticamente sconti punti, omaggi o scelte Fidelity dalle
                      prenotazioni In sospeso / Prenotato coinvolte; i relativi punti torneranno disponibili. Continuare?
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => { setConfirmImpact(null); setEnabled(true); }}>
                    Annulla
                  </button>
                  <button type="button" className="btn btn-danger" disabled={saving} onClick={() => submit(false, true)}>
                    <i className="bi bi-check2-circle me-1" />
                    Conferma disattivazione
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
