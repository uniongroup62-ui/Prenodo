"use client";

/*
 * QuotePublicFaithful — port of the legacy PUBLIC quote page
 * (app/pages/quote_public.php: accesso via token, nessuna autenticazione).
 * Legacy URL: index.php?page=quote_public&token=<32/64hex> (the quote emails
 * link it; the Next quote email already points at /<slug>/quote_public?token=).
 *
 * Renders the legacy structure verbatim: header (number, date, valid-until,
 * status badge, Stampa), the two quote-party blocks (business / client), the
 * items table (Descrizione/Q.tà/Prezzo/IVA/Totale with SKU + sconto lines),
 * the totals box, the public note, the payment methods and the terms/footer.
 * Styled by the ported /assets/css/pages/quote_public.css.
 *
 * NOT ported (deferred infra): the "Scarica PDF" button — quote_pdf_download
 * needs the PDF generation stack (QuotePdf), deferred with S3/SES.
 */

import { useEffect, useState } from "react";

const CSS_LINKS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "/assets/css/pages/quote_public.css",
];

type QuoteRow = { label: string; value: string };
type QuoteItem = {
  description: string;
  sku: string;
  discountPercent: number;
  qty: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
};
type PublicQuote = {
  number: string;
  quoteDate: string | null;
  validUntil: string | null;
  statusKey: string;
  statusLabel: string;
  badge: string;
  clientName: string;
  clientRows: QuoteRow[];
  business: { companyName: string; rows: QuoteRow[]; footer: string };
  items: QuoteItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  publicNote: string;
  paymentMethods: string[];
  terms: string;
};

const fmtMoney = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string | null) => {
  const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};

export function QuotePublicFaithful({ slug, token }: { slug: string; token: string }) {
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Chrome-less white body like the legacy embed default (quote_public.php:18).
    const previous = document.body.className;
    document.body.className = "quote-public-body bg-light";
    return () => {
      document.body.className = previous;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/public/quote?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (!data?.ok || !data.quote) {
          setError(String(data?.error || "Il link potrebbe essere scaduto o non valido."));
          return;
        }
        setQuote(data.quote as PublicQuote);
      })
      .catch(() => {
        if (active) setError("Errore di rete durante il caricamento.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug, token]);

  return (
    <>
      {CSS_LINKS.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <div className="container py-4" style={{ maxWidth: 960 }}>
        {loading ? (
          <div className="card p-4">
            <div className="d-flex align-items-center gap-2 text-muted">
              <span className="spinner-border spinner-border-sm" aria-hidden="true" />
              <span>Caricamento preventivo...</span>
            </div>
          </div>
        ) : null}

        {!loading && (error || !quote) ? (
          // Legacy 404 card ("Preventivo non trovato" / "non disponibile").
          <div className="card p-4">
            <div className="h5 fw-semibold mb-1">Preventivo non trovato</div>
            <div className="text-muted">{error || "Link non valido."}</div>
          </div>
        ) : null}

        {!loading && quote ? (
          <>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div>
                <div className="text-muted small">Preventivo</div>
                <h1 className="h4 fw-semibold m-0">#{quote.number}</h1>
                <div className="text-muted small mt-1">
                  Data: <strong>{fmtDate(quote.quoteDate)}</strong>
                  {quote.validUntil ? (
                    <>
                      {" "}• Valido fino al: <strong>{fmtDate(quote.validUntil)}</strong>
                    </>
                  ) : null}{" "}
                  • Stato: <span className={`badge text-bg-${quote.badge}`}>{quote.statusLabel}</span>
                </div>
              </div>
              <div className="d-flex gap-2 flex-wrap justify-content-end">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    if (typeof window !== "undefined") window.print();
                  }}
                >
                  <i className="bi bi-printer me-1" />
                  Stampa
                </button>
              </div>
            </div>

            <div className="card p-4">
              <div className="quote-parties">
                <section className="quote-party">
                  <div className="quote-party__eyebrow">Dati anagrafici</div>
                  <div className="quote-party__name">{quote.business.companyName}</div>
                  {quote.business.rows.length ? (
                    <div className="quote-party__rows">
                      {quote.business.rows.map((row) => (
                        <div className="quote-party__row" key={row.label}>
                          <div className="quote-party__label">{row.label}</div>
                          <div className="quote-party__value">{row.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="quote-party__empty">Dati non disponibili.</div>
                  )}
                </section>

                <section className="quote-party">
                  <div className="quote-party__eyebrow">Dati cliente</div>
                  <div className="quote-party__name">{quote.clientName}</div>
                  {quote.clientRows.length ? (
                    <div className="quote-party__rows">
                      {quote.clientRows.map((row) => (
                        <div className="quote-party__row" key={row.label}>
                          <div className="quote-party__label">{row.label}</div>
                          <div className="quote-party__value">{row.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="quote-party__empty">Dati cliente non disponibili.</div>
                  )}
                </section>
              </div>

              <hr className="my-4" />

              <div className="table-responsive">
                <table className="table align-middle">
                  <thead>
                    <tr>
                      <th>Descrizione</th>
                      <th className="text-end">Q.tà</th>
                      <th className="text-end">Prezzo</th>
                      <th className="text-end">IVA</th>
                      <th className="text-end">Totale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.items.map((item, index) => (
                      <tr key={index}>
                        <td>
                          <div className="fw-semibold">{item.description}</div>
                          {item.sku ? <div className="small text-muted">SKU: {item.sku}</div> : null}
                          {item.discountPercent > 0 ? <div className="small text-muted">Sconto: {item.discountPercent}%</div> : null}
                        </td>
                        <td className="text-end">{item.qty}</td>
                        <td className="text-end">€ {fmtMoney(item.unitPrice)}</td>
                        <td className="text-end">{item.taxRate}%</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(item.lineTotal)}</td>
                      </tr>
                    ))}
                    {!quote.items.length ? (
                      <tr>
                        <td colSpan={5} className="text-muted p-3">
                          Nessuna riga.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="row justify-content-end">
                <div className="col-md-6">
                  <div className="border rounded-3 p-3 bg-light">
                    <div className="d-flex justify-content-between">
                      <span>Subtotale</span>
                      <strong>€ {fmtMoney(quote.subtotal)}</strong>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span>Sconto</span>
                      <strong>€ {fmtMoney(quote.discountTotal)}</strong>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span>IVA</span>
                      <strong>€ {fmtMoney(quote.taxTotal)}</strong>
                    </div>
                    <hr className="my-2" />
                    <div className="d-flex justify-content-between fs-5">
                      <span>Totale</span>
                      <strong>€ {fmtMoney(quote.total)}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {quote.publicNote ? (
                <>
                  <hr className="my-3" />
                  <div className="small">
                    <div className="fw-semibold mb-1">Nota</div>
                    <div className="text-muted quote-prewrap">{quote.publicNote}</div>
                  </div>
                </>
              ) : null}

              {quote.paymentMethods.length ? (
                <>
                  <hr className="my-3" />
                  <div className="small">
                    <div className="fw-semibold mb-1">Metodi di pagamento</div>
                    <div className="text-muted quote-prewrap">{quote.paymentMethods.join("\n")}</div>
                  </div>
                </>
              ) : null}

              {quote.terms ? (
                <>
                  <hr className="my-3" />
                  <div className="small">
                    <div className="fw-semibold mb-1">Termini e condizioni</div>
                    <div className="text-muted quote-prewrap">{quote.terms}</div>
                  </div>
                </>
              ) : null}

              {quote.business.footer ? (
                <>
                  <hr className="my-3" />
                  <div className="small text-muted quote-prewrap">{quote.business.footer}</div>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
