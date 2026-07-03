"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP GiftCard settings page
// (app/pages/giftcard_settings.php, ?page=giftcard_settings).
// Configures the default GiftCard validity duration and the GiftCard terms
// text. Pre-filled from the existing DB-backed
// /api/manage/configuration?module=giftcard_settings route, whose "records"
// expose:
//   - record 1 "Validita predefinita" -> detail "<value> <unit>" (e.g. "0 days")
//   - record 2 "Termini GiftCard"      -> detail = raw terms text
// When the stored terms text is empty the PHP page shows a built-in default,
// reproduced here verbatim so the textarea matches the legacy markup.

type ConfigRecord = {
  id: number;
  module: string;
  title: string;
  detail: string;
  value: string;
  active: boolean;
  updatedAt?: string;
};

type ConfigResponse = {
  ok?: boolean;
  records?: ConfigRecord[];
  module?: { records?: ConfigRecord[] };
};

const VALIDITY_UNITS = ["days", "months", "years"] as const;

// Default GiftCard terms text rendered by the PHP page when none is stored.
const DEFAULT_GIFTCARD_TERMS = `La GiftCard è utilizzabile fino a esaurimento credito e/o fino all'utilizzo dei servizi/prodotti inclusi, oppure fino alla data di scadenza (se presente).
Non convertibile in denaro e non rimborsabile.
Presentare il codice (QR) o il codice alfanumerico in cassa per l'utilizzo.
In caso di smarrimento, contatta elite indicando il codice GiftCard.`;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Parse a "<number> <unit>" detail string (e.g. "0 days") into value + unit.
function parseValidityDetail(detail: string): { value: string; unit: string } {
  const trimmed = (detail || "").trim();
  const match = trimmed.match(/^(\d+)\s*([a-zA-Z]+)?/);
  const value = match?.[1] ?? "0";
  const unitRaw = (match?.[2] ?? "days").toLowerCase();
  const unit = (VALIDITY_UNITS as readonly string[]).includes(unitRaw) ? unitRaw : "days";
  return { value, unit };
}

export function GiftcardSettingsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [validityValue, setValidityValue] = useState("0");
  const [validityUnit, setValidityUnit] = useState("days");
  const [terms, setTerms] = useState(DEFAULT_GIFTCARD_TERMS);
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?module=giftcard_settings&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ConfigResponse) => {
        const records = j.records ?? j.module?.records ?? [];
        const validityRec = records.find((rec) => rec.id === 1 || /validit/i.test(rec.title));
        const termsRec = records.find((rec) => rec.id === 2 || /termini/i.test(rec.title));
        if (validityRec) {
          const { value, unit } = parseValidityDetail(validityRec.detail);
          setValidityValue(value);
          setValidityUnit(unit);
        }
        // PHP pre-fills the stored terms; falls back to the default text when empty.
        const storedTerms = (termsRec?.detail ?? "").trim();
        setTerms(storedTerms ? (termsRec?.detail ?? "") : DEFAULT_GIFTCARD_TERMS);
      })
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function postAction(payload: Record<string, unknown>, successText: string): Promise<void> {
    setFeedback(null);
    try {
      const res = await fetch(`/api/manage/configuration?module=giftcard_settings&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, module: "giftcard_settings", ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? "Errore.") });
        return;
      }
      setFeedback({ type: "success", text: String(j?.message ?? successText) });
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    }
  }

  const page = (p: string) => `/${encodeURIComponent(slug)}/${`${p}`.replace("&", "?")}`;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftcard_settings.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <h1 className="bs-page-title">Fidelity / GiftCard / Impostazioni</h1>
          <div className="bs-page-subtitle">Configura scadenze e impostazioni predefinite GiftCard.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary btn-pill" href={page("giftcard")}>
              <i className="bi bi-arrow-left me-1" />
              GiftCard
            </a>
            <a className="btn btn-primary btn-pill" href={page("pos")}>
              <i className="bi bi-plus-lg me-1" />
              Crea GiftCard
            </a>
          </div>
        </div>
      </div>

      {feedback ? (
        <div className={`alert alert-${feedback.type}`} role="alert">
          {feedback.text}
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">GiftCard — Scadenza predefinita</div>
            <div className="text-muted small mb-3">
              Quando emetti una <strong>GiftCard</strong> e lasci vuoto il campo <em>“Valida al”</em>,
              la scadenza viene calcolata automaticamente partendo da <em>“Validità dal”</em>.
              Imposta qui la durata predefinita: <strong>0</strong> significa nessuna scadenza automatica.
            </div>

            <form
              method="post"
              className="border rounded-3 p-3 bg-light"
              onSubmit={(e) => {
                e.preventDefault();
                postAction(
                  {
                    action: "save_giftcard_validity_default",
                    giftcard_default_validity_value: validityValue,
                    giftcard_default_validity_unit: validityUnit,
                  },
                  "Impostazioni scadenza GiftCard salvate.",
                );
              }}
            >
              <input type="hidden" name="action" value="save_giftcard_validity_default" />

              <div className="row g-2 align-items-end">
                <div className="col-md-5">
                  <label className="form-label">Durata</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    max={36500}
                    name="giftcard_default_validity_value"
                    placeholder="0"
                    value={validityValue}
                    onChange={(e) => setValidityValue(e.target.value)}
                  />
                  <div className="form-text">0 = nessuna scadenza automatica</div>
                </div>
                <div className="col-md-5">
                  <label className="form-label">Unità</label>
                  <select
                    className="form-select"
                    name="giftcard_default_validity_unit"
                    value={validityUnit}
                    onChange={(e) => setValidityUnit(e.target.value)}
                  >
                    <option value="days">Giorni</option>
                    <option value="months">Mesi</option>
                    <option value="years">Anni</option>
                  </select>
                </div>
              </div>

              <div className="mt-3 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit">
                  <i className="bi bi-check2-circle me-1" />
                  Salva GiftCard
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card p-4">
            <div className="h6 fw-bold mb-2">Come funziona</div>
            <div className="text-muted small">
              <ul className="mb-0">
                <li><strong>Validità dal</strong> resta modificabile in fase di emissione.</li>
                <li>Se <strong>Valida al</strong> è vuoto, viene calcolata usando questa durata.</li>
                <li>Le GiftCard già emesse non vengono modificate.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="row g-3 mt-3">
        <div className="col-lg-8">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">GiftCard — Condizioni</div>
            <div className="text-muted small mb-3">
              Testo mostrato nel <strong>Voucher GiftCard</strong> e nella <strong>mail</strong> inviata al destinatario.
              Inserisci <strong>una riga per ogni condizione</strong>.
            </div>

            <form
              method="post"
              className="row g-3"
              onSubmit={(e) => {
                e.preventDefault();
                postAction({ action: "save_giftcard_terms", giftcard_terms: terms }, "Condizioni GiftCard salvate.");
              }}
            >
              <div className="col-12">
                <label className="form-label">Testo condizioni</label>
                <textarea
                  className="form-control giftcard-settings-terms"
                  name="giftcard_terms"
                  rows={6}
                  placeholder="Scrivi una condizione per riga..."
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
                <div className="form-text">Se lasci vuoto verrà usato il testo predefinito.</div>
              </div>

              <div className="col-12 d-flex flex-wrap gap-2">
                <button className="btn btn-primary btn-pill" type="submit" name="action" value="save_giftcard_terms">
                  <i className="bi bi-check2-circle me-1" />
                  Salva condizioni
                </button>
                <button
                  className="btn btn-outline-danger btn-pill"
                  type="button"
                  name="action"
                  value="reset_giftcard_terms"
                  data-giftcard-settings-confirm="Ripristinare il testo predefinito delle condizioni GiftCard?"
                  onClick={() => {
                    if (!window.confirm("Ripristinare il testo predefinito delle condizioni GiftCard?")) return;
                    postAction({ action: "reset_giftcard_terms" }, "Condizioni GiftCard ripristinate.");
                  }}
                >
                  <i className="bi bi-arrow-counterclockwise me-1" />
                  Ripristina testo predefinito
                </button>
                <a className="btn btn-outline-secondary btn-pill" href={page("giftcard_settings")}>
                  Annulla
                </a>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card p-4">
            <div className="h6 fw-bold mb-2">Suggerimento</div>
            <div className="text-muted small">
              Personalizza qui le condizioni mostrate nel voucher e nella mail GiftCard.
              Per tornare al testo standard usa <strong>Ripristina testo predefinito</strong>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
