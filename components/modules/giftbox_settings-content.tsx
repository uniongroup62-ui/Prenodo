"use client";

import { useCallback, useEffect, useState } from "react";
import InfoBox from "./info-box";
import { flashNavigate, useTakenFlash } from "./flash";

// Faithful port of the PHP giftbox_settings page (app/pages/giftbox_settings.php):
// GiftBox default validity + GiftBox terms text. Current values are pre-filled
// from the existing DB-backed /api/manage/configuration?module=giftbox_settings
// route, which exposes them via the module records (record 1 "Validita
// predefinita" detail = "<value> <unit>", record 2 "Termini GiftBox"
// detail = raw terms text).

type GiftboxSettingsQuery = { msg?: string; err?: string };

type ConfigResponse = {
  ok?: boolean;
  module?: { settings?: Record<string, unknown> };
  canGiftboxManage?: boolean;
  canCreate?: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Default terms text, used when giftbox_terms is empty (matches PHP default).
const DEFAULT_TERMS = `Voucher utilizzabile in più appuntamenti fino ad esaurimento del contenuto.
Ad ogni utilizzo verranno scalati i singoli servizi/prodotti (riscatto parziale).
Non convertibile in denaro e non rimborsabile.
Presentare il codice (QR) o il codice alfanumerico in cassa per il riscatto.`;

export function GiftboxSettingsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftboxSettingsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [validityValue, setValidityValue] = useState("0");
  const [validityUnit, setValidityUnit] = useState("days");
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [perms, setPerms] = useState({ canGiftboxManage: false, canCreate: false });
  // Flash legacy (View::alert): ?msg= success dal redirect + errore in pagina.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?module=giftbox_settings&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ConfigResponse) => {
        const s = (j.module?.settings ?? {}) as Record<string, unknown>;
        setPerms({ canGiftboxManage: j.canGiftboxManage === true, canCreate: j.canCreate === true });
        const rawValue = String(s.giftbox_default_validity_value ?? "0");
        if (/^\d+$/.test(rawValue)) setValidityValue(rawValue);
        const rawUnit = String(s.giftbox_default_validity_unit ?? "days");
        if (rawUnit === "days" || rawUnit === "months" || rawUnit === "years") setValidityUnit(rawUnit);
        const rawTerms = String(s.giftbox_terms ?? "");
        setTerms(rawTerms.trim() !== "" ? rawTerms : DEFAULT_TERMS);
      })
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const pageBase = `/${encodeURIComponent(slug)}/giftbox_settings`;

  // Salvataggio: successo -> redirect flash legacy (?msg=), errore -> alert
  // in pagina (il legacy non fa redirect e mantiene i valori inseriti).
  async function postAction(payload: Record<string, unknown>): Promise<void> {
    setError("");
    try {
      const res = await fetch(`/api/manage/configuration?module=giftbox_settings&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, module: "giftbox_settings", ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setError(String(j?.error ?? j?.message ?? "Errore."));
        window.scrollTo(0, 0);
        return;
      }
      flashNavigate(pageBase, { msg: String(j?.message ?? "") });
    } catch {
      setError("Errore di rete.");
      window.scrollTo(0, 0);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftbox_settings.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Impostazioni GiftBox</h1>
            <InfoBox>
              <h6>Scadenza predefinita</h6>
              <ul>
                <li><strong>Validità dal</strong> resta modificabile in fase di emissione.</li>
                <li>Se <strong>Valida al</strong> è vuoto, viene calcolata usando questa durata.</li>
                <li>Le GiftBox già emesse non vengono modificate.</li>
              </ul>
              <h6>Condizioni</h6>
              <ul>
                <li>
                  Il testo compare nel <strong>voucher GiftBox</strong> e nella <strong>mail</strong> inviata al
                  destinatario: scrivi una riga per ogni condizione.
                </li>
                <li>
                  Se lasci vuoto viene usato il testo predefinito; <strong>Ripristina testo predefinito</strong> torna
                  allo standard.
                </li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Configura scadenze e impostazioni predefinite GiftBox.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {perms.canGiftboxManage ? (
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox`}>
                <i className="bi bi-arrow-left me-1" />
                GiftBox
              </a>
            ) : null}
            {perms.canCreate ? (
              <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/pos`}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftBox
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
        <div className="col-12">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">Scadenza predefinita</div>
            <div className="text-muted small mb-3">
              Quando emetti una <strong>GiftBox</strong> e lasci vuoto il campo <em>“Valida al”</em>, la scadenza viene
              calcolata automaticamente partendo da <em>“Validità dal”</em>. Imposta qui la durata predefinita:{" "}
              <strong>0</strong> significa nessuna scadenza automatica.
            </div>

            <form
              method="post"
              className="border rounded-3 p-3 bg-light"
              onSubmit={(e) => {
                e.preventDefault();
                void postAction({
                  action: "save_giftbox_validity_default",
                  giftbox_default_validity_value: validityValue,
                  giftbox_default_validity_unit: validityUnit,
                });
              }}
            >
              <input type="hidden" name="action" value="save_giftbox_validity_default" />

              <div className="row g-2 align-items-end">
                <div className="col-md-5">
                  <label className="form-label">Durata</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    max={36500}
                    name="giftbox_default_validity_value"
                    placeholder="0"
                    value={validityValue}
                    onChange={(e) => setValidityValue(e.target.value)}
                  />
                </div>
                <div className="col-md-5">
                  <label className="form-label">Unità</label>
                  <select
                    className="form-select"
                    name="giftbox_default_validity_unit"
                    value={validityUnit}
                    onChange={(e) => setValidityUnit(e.target.value)}
                  >
                    <option value="days">Giorni</option>
                    <option value="months">Mesi</option>
                    <option value="years">Anni</option>
                  </select>
                </div>
              </div>
              {/* helper FUORI dalla row: dentro la colonna, con align-items-end,
                  spingeva l'input sopra la linea della select Unità */}
              <div className="form-text mt-2">0 = nessuna scadenza automatica</div>

              <div className="mt-3 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit">
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
              </div>
            </form>
          </div>
        </div>

      </div>

      <div className="row g-3 mt-3">
        <div className="col-12">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">Condizioni</div>
            <div className="text-muted small mb-3">
              Testo mostrato nel <strong>Voucher GiftBox</strong> e nella <strong>mail</strong> inviata al destinatario.
              Inserisci <strong>una riga per ogni condizione</strong>.
            </div>

            <form
              method="post"
              className="row g-3"
              onSubmit={(e) => {
                e.preventDefault();
                void postAction({ action: "save_giftbox_terms", giftbox_terms: terms });
              }}
            >
              <div className="col-12">
                <label className="form-label">Testo condizioni</label>
                <textarea
                  className="form-control giftbox-settings-terms"
                  name="giftbox_terms"
                  rows={6}
                  placeholder="Scrivi una condizione per riga..."
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
                <div className="form-text">Se lasci vuoto verrà usato il testo predefinito.</div>
              </div>

              <div className="col-12 d-flex flex-wrap gap-2">
                <button className="btn btn-primary btn-pill" type="submit" name="action" value="save_giftbox_terms">
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
                <button
                  className="btn btn-outline-danger btn-pill"
                  type="button"
                  name="action"
                  value="reset_giftbox_terms"
                  data-giftbox-settings-confirm="Ripristinare il testo predefinito delle condizioni GiftBox?"
                  onClick={() => {
                    if (!window.confirm("Ripristinare il testo predefinito delle condizioni GiftBox?")) return;
                    void postAction({ action: "reset_giftbox_terms" });
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

      </div>
    </div>
  );
}
