"use client";

import { useCallback, useEffect, useState } from "react";

// Port fedele della pagina impostazioni GiftCard
// (app/pages/giftcard_settings.php): scadenza predefinita (durata + unità) e
// condizioni GiftCard su businesses. Prefill dal payload settings della route
// /api/manage/configuration?module=giftcard_settings; il testo condizioni
// predefinito interpola il NOME ATTIVITÀ nell'ultima riga come il PHP.
// Salvataggi con redirect flash legacy (?msg=), errori in pagina; header
// gated (GiftCard su giftcard.manage, Crea GiftCard su pos.manage); confirm
// legacy sul ripristino.

type GiftcardSettingsQuery = { msg?: string; err?: string };

type ConfigResponse = {
  ok?: boolean;
  module?: { settings?: Record<string, unknown> };
  canGiftcardManage?: boolean;
  canCreate?: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Testo condizioni predefinito legacy: l'ultima riga interpola il nome
// dell'attività (biz.name, fallback 'La mia attività').
function defaultTerms(bizName: string): string {
  return [
    "La GiftCard è utilizzabile fino a esaurimento credito e/o fino all'utilizzo dei servizi/prodotti inclusi, oppure fino alla data di scadenza (se presente).",
    "Non convertibile in denaro e non rimborsabile.",
    "Presentare il codice (QR) o il codice alfanumerico in cassa per l'utilizzo.",
    `In caso di smarrimento, contatta ${bizName} indicando il codice GiftCard.`,
  ].join("\n");
}

export function GiftcardSettingsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftcardSettingsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [validityValue, setValidityValue] = useState("0");
  const [validityUnit, setValidityUnit] = useState("days");
  const [terms, setTerms] = useState("");
  const [perms, setPerms] = useState({ canGiftcardManage: false, canCreate: false });
  // Flash legacy (View::alert): ?msg= success dal redirect + errore in pagina.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?module=giftcard_settings&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ConfigResponse) => {
        const s = (j.module?.settings ?? {}) as Record<string, unknown>;
        setPerms({ canGiftcardManage: j.canGiftcardManage === true, canCreate: j.canCreate === true });
        const rawValue = String(s.giftcard_default_validity_value ?? "0");
        if (/^\d+$/.test(rawValue)) setValidityValue(rawValue);
        const rawUnit = String(s.giftcard_default_validity_unit ?? "days");
        if (rawUnit === "days" || rawUnit === "months" || rawUnit === "years") setValidityUnit(rawUnit);
        const bizName = String(s.business_name ?? "").trim() || "La mia attività";
        const rawTerms = String(s.giftcard_terms ?? "");
        setTerms(rawTerms.trim() !== "" ? rawTerms : defaultTerms(bizName));
      })
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const pageBase = `/${encodeURIComponent(slug)}/giftcard_settings`;

  // Salvataggio: successo -> redirect flash legacy (?msg=), errore -> alert
  // in pagina (il legacy non fa redirect e mantiene i valori inseriti).
  async function postAction(payload: Record<string, unknown>): Promise<void> {
    setError("");
    try {
      const res = await fetch(`/api/manage/configuration?module=giftcard_settings&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, module: "giftcard_settings", ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setError(String(j?.error ?? j?.message ?? "Errore."));
        window.scrollTo(0, 0);
        return;
      }
      window.location.href = `${pageBase}?msg=${encodeURIComponent(String(j?.message ?? ""))}`;
    } catch {
      setError("Errore di rete.");
      window.scrollTo(0, 0);
    }
  }

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
            {perms.canGiftcardManage ? (
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/giftcard`}>
                <i className="bi bi-arrow-left me-1" />
                GiftCard
              </a>
            ) : null}
            {perms.canCreate ? (
              <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/pos`}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftCard
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.err}</div>
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{error}</div>
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">GiftCard — Scadenza predefinita</div>
            <div className="text-muted small mb-3">
              Quando emetti una <strong>GiftCard</strong> e lasci vuoto il campo <em>“Valida al”</em>, la scadenza viene
              calcolata automaticamente partendo da <em>“Validità dal”</em>. Imposta qui la durata predefinita:{" "}
              <strong>0</strong> significa nessuna scadenza automatica.
            </div>

            <form
              method="post"
              className="border rounded-3 p-3 bg-light"
              onSubmit={(e) => {
                e.preventDefault();
                void postAction({
                  action: "save_giftcard_validity_default",
                  giftcard_default_validity_value: validityValue,
                  giftcard_default_validity_unit: validityUnit,
                });
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
                <li>
                  <strong>Validità dal</strong> resta modificabile in fase di emissione.
                </li>
                <li>
                  Se <strong>Valida al</strong> è vuoto, viene calcolata usando questa durata.
                </li>
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
                void postAction({ action: "save_giftcard_terms", giftcard_terms: terms });
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
                    void postAction({ action: "reset_giftcard_terms" });
                  }}
                >
                  <i className="bi bi-arrow-counterclockwise me-1" />
                  Ripristina testo predefinito
                </button>
                <a className="btn btn-outline-secondary btn-pill" href={pageBase}>
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
              Personalizza qui le condizioni mostrate nel voucher e nella mail GiftCard. Per tornare al testo standard usa{" "}
              <strong>Ripristina testo predefinito</strong>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
