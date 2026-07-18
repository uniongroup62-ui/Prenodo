"use client";

import { useEffect, useState } from "react";

// Port fedele di Preventivi / Impostazioni (app/pages/quote_settings.php +
// assets/js/pages/quote_settings.js): dati anagrafici e intestazione
// documenti (con Regione/Provincia/Città italy-geo), condizioni preventivo
// (condizioni standard + testo in calce) e metodi di pagamento strutturati
// pm_name[]/pm_details[]. Salvataggi con redirect flash legacy (?msg= senza
// punto finale) ed errori in pagina con i wrapper verbatim.

type QuoteSettingsQuery = { msg?: string; err?: string };

type ConfigResponse = {
  ok?: boolean;
  module?: { settings?: Record<string, unknown> };
  canQuotesManage?: boolean;
};

type PaymentMethodRow = {
  name: string;
  details: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function QuoteSettingsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: QuoteSettingsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [loading, setLoading] = useState(true);
  const [canQuotesManage, setCanQuotesManage] = useState(false);

  // Anagrafica / intestazione documenti.
  const [companyName, setCompanyName] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [taxCode, setTaxCode] = useState("");
  const [sdi, setSdi] = useState("");
  const [pec, setPec] = useState("");
  // Regione/Provincia/Città: hidden NON controllati (li gestisce italy-geo.js).
  const [geo, setGeo] = useState({ region: "", province: "", city: "" });
  const [cap, setCap] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");

  // Condizioni preventivo.
  const [terms, setTerms] = useState("");
  const [footer, setFooter] = useState("");

  // Metodi di pagamento (sempre almeno una riga, come nel PHP).
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodRow[]>([{ name: "", details: "" }]);

  // Flash legacy (View::alert): ?msg= success dal redirect + errore in pagina.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/manage/configuration?module=quote_settings&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ConfigResponse) => {
        const s = (j.module?.settings ?? {}) as Record<string, unknown>;
        const str = (key: string) => String(s[key] ?? "");
        setCanQuotesManage(j.canQuotesManage === true);
        setCompanyName(str("quote_company_name"));
        setVatNumber(str("quote_vat_number"));
        setTaxCode(str("quote_tax_code"));
        setSdi(str("quote_sdi"));
        setPec(str("quote_pec"));
        setGeo({ region: str("quote_region"), province: str("quote_province"), city: str("quote_city") });
        setCap(str("quote_cap"));
        setAddress(str("quote_address"));
        setPhone(str("quote_phone"));
        setEmail(str("quote_email"));
        setWebsite(str("quote_website"));
        setTerms(str("quote_terms"));
        setFooter(str("quote_footer"));
        try {
          const rows = JSON.parse(str("payment_methods_rows")) as PaymentMethodRow[];
          if (Array.isArray(rows) && rows.length > 0) {
            setPaymentMethods(rows.map((row) => ({ name: String(row.name ?? ""), details: String(row.details ?? "") })));
          }
        } catch {
          /* keep the single empty row */
        }
      })
      .catch(() => {
        /* leave defaults */
      })
      .finally(() => setLoading(false));
  }, [slug]);

  // italy-geo.js (IIFE legacy) DOPO il render del markup con gli hidden
  // prefillati; ?v= cache-buster per ri-eseguirlo a ogni mount.
  useEffect(() => {
    if (loading) return;
    const s = document.createElement("script");
    s.id = "italyGeoScript";
    s.dataset.base = window.location.origin;
    s.src = `/assets/js/italy-geo.js?v=${Date.now()}`;
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, [loading]);

  function settingsUrl(qs = ""): string {
    return `/${encodeURIComponent(slug)}/quote_settings${qs}`;
  }

  // Salvataggio: successo -> redirect flash legacy (?msg=), errore -> alert
  // in pagina (il legacy non fa redirect e mantiene i valori inseriti).
  async function postAction(payload: Record<string, unknown>): Promise<void> {
    setError("");
    try {
      const res = await fetch(`/api/manage/configuration?module=quote_settings&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, module: "quote_settings", ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setError(String(j?.error ?? j?.message ?? "Errore."));
        window.scrollTo(0, 0);
        return;
      }
      window.location.href = settingsUrl(`?msg=${encodeURIComponent(String(j?.message ?? ""))}`);
    } catch {
      setError("Errore di rete.");
      window.scrollTo(0, 0);
    }
  }

  function updatePm(idx: number, patch: Partial<PaymentMethodRow>): void {
    setPaymentMethods((rows) => rows.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function addPm(): void {
    setPaymentMethods((rows) => [...rows, { name: "", details: "" }]);
  }

  function removePm(idx: number): void {
    setPaymentMethods((rows) => {
      const next = rows.filter((_, i) => i !== idx);
      return next.length > 0 ? next : [{ name: "", details: "" }];
    });
  }

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    // Regione/Provincia/Città dagli hidden italy-geo (non controllati).
    const geoValue = (name: string) => (document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value ?? "";
    postAction({
      action: "save_quote_profile",
      quote_company_name: companyName,
      quote_vat_number: vatNumber,
      quote_tax_code: taxCode,
      quote_sdi: sdi,
      quote_pec: pec,
      quote_region: geoValue("quote_region"),
      quote_province: geoValue("quote_province"),
      quote_city: geoValue("quote_city"),
      quote_cap: cap,
      quote_address: address,
      quote_phone: phone,
      quote_email: email,
      quote_website: website,
    });
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quote_settings.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Vendite</div>
          <h1 className="bs-page-title">Preventivi / Impostazioni</h1>
          <div className="bs-page-subtitle">
            Configura intestazione documenti, condizioni standard e metodi di pagamento dei preventivi.
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {canQuotesManage ? (
              <>
                <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/quotes`}>
                  <i className="bi bi-arrow-left me-1" />
                  Preventivi
                </a>
                <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/quotes?action=new`}>
                  <i className="bi bi-plus-lg me-1" />
                  Nuovo preventivo
                </a>
              </>
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

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <>
          <div className="row g-3 mb-3">
            <div className="col-12">
              <div className="card p-4">
                <form method="post" className="row g-3 align-items-end" onSubmit={saveProfile}>
                  <input type="hidden" name="action" value="save_quote_profile" />

                  <div className="col-12">
                    <div className="h5 fw-bold mb-1">Dati anagrafici e intestazione documenti</div>
                    <div className="text-muted small">
                      Dati fiscali usati da preventivi, moduli consenso e intestazioni documento.
                    </div>
                  </div>
                  <div className="col-lg-8">
                    <label className="form-label" htmlFor="quoteCompanyName">
                      Ragione sociale / Intestazione
                    </label>
                    <input
                      className="form-control"
                      id="quoteCompanyName"
                      name="quote_company_name"
                      maxLength={255}
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Es. La Mia Attivita S.r.l."
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteVatNumber">
                      P. IVA
                    </label>
                    <input
                      className="form-control"
                      id="quoteVatNumber"
                      name="quote_vat_number"
                      maxLength={40}
                      value={vatNumber}
                      onChange={(e) => setVatNumber(e.target.value)}
                      placeholder="IT123..."
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteTaxCode">
                      Codice fiscale
                    </label>
                    <input
                      className="form-control"
                      id="quoteTaxCode"
                      name="quote_tax_code"
                      maxLength={40}
                      value={taxCode}
                      onChange={(e) => setTaxCode(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteSdi">
                      SDI
                    </label>
                    <input
                      className="form-control"
                      id="quoteSdi"
                      name="quote_sdi"
                      maxLength={40}
                      value={sdi}
                      onChange={(e) => setSdi(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quotePec">
                      PEC
                    </label>
                    <input
                      className="form-control"
                      id="quotePec"
                      name="quote_pec"
                      type="email"
                      maxLength={190}
                      value={pec}
                      onChange={(e) => setPec(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label">Regione</label>
                    <div className="dropdown app-combobox js-it-region-box">
                      <button
                        className="form-control text-start app-combobox-toggle dropdown-toggle"
                        type="button"
                        aria-expanded="false"
                      >
                        <span className="app-combobox-text" />
                        <span className="app-combobox-placeholder text-muted">Seleziona una regione...</span>
                      </button>
                      <input type="hidden" name="quote_region" className="js-it-region" defaultValue={geo.region} />
                      <div className="dropdown-menu p-2 w-100 app-combobox-menu">
                        <input
                          type="text"
                          className="form-control form-control-sm app-combobox-search"
                          placeholder="Cerca..."
                          autoComplete="off"
                        />
                        <div className="list-group mt-2 app-combobox-list" />
                      </div>
                    </div>
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label">Provincia</label>
                    <div className="dropdown app-combobox js-it-province-box">
                      <button
                        className="form-control text-start app-combobox-toggle dropdown-toggle"
                        type="button"
                        aria-expanded="false"
                        disabled
                      >
                        <span className="app-combobox-text" />
                        <span className="app-combobox-placeholder text-muted">Seleziona prima la regione...</span>
                      </button>
                      <input type="hidden" name="quote_province" className="js-it-province" defaultValue={geo.province} />
                      <div className="dropdown-menu p-2 w-100 app-combobox-menu">
                        <input
                          type="text"
                          className="form-control form-control-sm app-combobox-search"
                          placeholder="Cerca..."
                          autoComplete="off"
                        />
                        <div className="list-group mt-2 app-combobox-list" />
                      </div>
                    </div>
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label">Citt&agrave;</label>
                    <div className="dropdown app-combobox js-it-city-box">
                      <button
                        className="form-control text-start app-combobox-toggle dropdown-toggle"
                        type="button"
                        aria-expanded="false"
                        disabled
                      >
                        <span className="app-combobox-text" />
                        <span className="app-combobox-placeholder text-muted">Seleziona prima la provincia...</span>
                      </button>
                      <input type="hidden" name="quote_city" className="js-it-city" defaultValue={geo.city} />
                      <div className="dropdown-menu p-2 w-100 app-combobox-menu">
                        <input
                          type="text"
                          className="form-control form-control-sm app-combobox-search"
                          placeholder="Cerca..."
                          autoComplete="off"
                        />
                        <div className="list-group mt-2 app-combobox-list" />
                      </div>
                    </div>
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteCap">
                      CAP
                    </label>
                    <input
                      className="form-control"
                      id="quoteCap"
                      name="quote_cap"
                      maxLength={20}
                      value={cap}
                      onChange={(e) => setCap(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-8">
                    <label className="form-label" htmlFor="quoteAddress">
                      Indirizzo intestazione
                    </label>
                    <input
                      className="form-control"
                      id="quoteAddress"
                      name="quote_address"
                      maxLength={255}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="Via ..."
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quotePhone">
                      Telefono documenti
                    </label>
                    <input
                      className="form-control"
                      id="quotePhone"
                      name="quote_phone"
                      maxLength={40}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteEmail">
                      Email documenti
                    </label>
                    <input
                      className="form-control"
                      id="quoteEmail"
                      name="quote_email"
                      type="email"
                      maxLength={190}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="col-lg-4">
                    <label className="form-label" htmlFor="quoteWebsite">
                      Sito web
                    </label>
                    <input
                      className="form-control"
                      id="quoteWebsite"
                      name="quote_website"
                      inputMode="url"
                      maxLength={190}
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                    />
                  </div>
                  <div className="col-12 d-flex flex-wrap gap-2">
                    <button className="btn btn-primary btn-pill" type="submit">
                      <i className="bi bi-check2-circle me-1" />
                      Salva dati anagrafici
                    </button>
                    <a className="btn btn-outline-secondary btn-pill" href={settingsUrl()}>
                      Annulla
                    </a>
                  </div>
                </form>
              </div>
            </div>
          </div>

          <div className="row g-3">
            <div className="col-lg-8">
              <div className="card p-4">
                <div className="h5 fw-bold mb-3">Condizioni preventivo</div>
                <div className="text-muted small mb-3">
                  Questi testi vengono proposti automaticamente nei nuovi preventivi e restano modificabili nel singolo
                  documento.
                </div>

                <form
                  method="post"
                  className="row g-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    postAction({ action: "save_quote_conditions", quote_terms: terms, quote_footer: footer });
                  }}
                >
                  <input type="hidden" name="action" value="save_quote_conditions" />

                  <div className="col-12">
                    <label className="form-label">Condizioni standard (opzionale)</label>
                    <textarea
                      className="form-control"
                      name="quote_terms"
                      rows={4}
                      placeholder="Es. Validità 30 giorni..."
                      value={terms}
                      onChange={(e) => setTerms(e.target.value)}
                    />
                    <div className="form-text">
                      Verranno precompilate nei nuovi preventivi, ma resteranno modificabili nel singolo documento.
                    </div>
                  </div>

                  <div className="col-12">
                    <label className="form-label">Testo in calce (opzionale)</label>
                    <textarea
                      className="form-control"
                      name="quote_footer"
                      rows={3}
                      placeholder="Es. Grazie per la fiducia..."
                      value={footer}
                      onChange={(e) => setFooter(e.target.value)}
                    />
                  </div>

                  <div className="col-12 d-flex flex-wrap gap-2">
                    <button className="btn btn-primary btn-pill" type="submit">
                      <i className="bi bi-check2-circle me-1" />
                      Salva condizioni preventivo
                    </button>
                    <a className="btn btn-outline-secondary btn-pill" href={settingsUrl()}>
                      Annulla
                    </a>
                  </div>
                </form>
              </div>
            </div>

            <div className="col-lg-4">
              <div className="card p-4">
                <div className="h6 fw-bold mb-2">Nota</div>
                <div className="text-muted small">
                  Le condizioni standard e il testo in calce vengono inseriti come default nei nuovi preventivi. Restano
                  comunque modificabili prima dell&rsquo;invio al cliente.
                </div>
              </div>
            </div>
          </div>

          <div className="row g-3 mt-3">
            <div className="col-lg-8">
              <div className="card p-4">
                <div className="h5 fw-bold mb-3">Preventivi — Metodi di pagamento</div>
                <div className="text-muted small mb-3">
                  Aggiungi i metodi di pagamento selezionabili nei preventivi. Ogni metodo ha un <strong>nome</strong> e,
                  opzionalmente, dei <strong>dettagli</strong>.
                </div>

                <form
                  method="post"
                  className="row g-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    // pm_name[]/pm_details[] come il legacy: la normalizzazione
                    // (120/400 char, righe unite, max 50) resta al server.
                    postAction({
                      action: "save_payment_methods",
                      pm_name: JSON.stringify(paymentMethods.map((pm) => pm.name)),
                      pm_details: JSON.stringify(paymentMethods.map((pm) => pm.details)),
                    });
                  }}
                >
                  <input type="hidden" name="action" value="save_payment_methods" />

                  <div className="col-12">
                    <div className="border rounded-3 p-3 bg-light" id="pmRowsWrap">
                      {paymentMethods.map((pm, idx) => (
                        <div className="row g-2 align-items-start pm-row mb-2" data-idx={idx} key={idx}>
                          <div className="col-md-4">
                            <label className="form-label small mb-1">Nome</label>
                            <input
                              className="form-control"
                              name="pm_name[]"
                              value={pm.name}
                              onChange={(e) => updatePm(idx, { name: e.target.value })}
                              placeholder="Es. Bonifico"
                            />
                          </div>
                          <div className="col-md-7">
                            <label className="form-label small mb-1">Dettagli (opzionali)</label>
                            <textarea
                              className="form-control quote-settings-details"
                              name="pm_details[]"
                              rows={2}
                              value={pm.details}
                              onChange={(e) => updatePm(idx, { details: e.target.value })}
                              placeholder="Es. IBAN IT... / email / note..."
                            />
                          </div>
                          <div className="col-md-1 d-grid">
                            <button
                              className="btn btn-outline-danger btn-sm pm-remove"
                              type="button"
                              title="Rimuovi"
                              onClick={() => removePm(idx)}
                            >
                              <i className="bi bi-trash" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="d-flex gap-2 mt-2">
                      <button className="btn btn-outline-secondary btn-sm" type="button" id="pmAddBtn" onClick={addPm}>
                        <i className="bi bi-plus-lg me-1" />
                        Aggiungi metodo
                      </button>
                    </div>
                    <div className="form-text">Nel preventivo potrai selezionare quali metodi mostrare al cliente.</div>
                  </div>

                  <div className="col-12 d-flex flex-wrap gap-2">
                    <button className="btn btn-primary btn-pill" type="submit">
                      <i className="bi bi-check2-circle me-1" />
                      Salva metodi
                    </button>
                    <a className="btn btn-outline-secondary btn-pill" href={settingsUrl()}>
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
                  Compila <strong>Nome</strong> e, se serve, <strong>Dettagli</strong> come IBAN, email PayPal o note
                  operative.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
