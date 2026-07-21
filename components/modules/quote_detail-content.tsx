"use client";

import { useEffect, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";
import { quoteExpiryWarning } from "@/components/modules/quotes-content";

// Port fedele del DETTAGLIO preventivo (app/pages/quotes.php action=view):
// header con azioni condizionali (Modifica solo se non bloccato, Dettaglio
// vendita / Vai a Pagamenti, PDF, Invia email con stati disabilitati e title
// legacy, Stampa), alert vendita collegata + disponibilità contenuti, card
// Cliente/Note interne/Nota per il cliente/Metodi di pagamento, righe con
// SKU/sconto, totali, Condizioni e modale invio email con link pubblico.

type QuoteDetailQuery = { id?: string; msg?: string; err?: string };

type ViewItem = {
  description: string;
  displayDescription: string;
  sku: string;
  itemType: string;
  qty: string;
  unitPrice: number;
  taxRate: string;
  discountPercent: string;
  lineTotal: number;
};

type Issue = { type: string; label: string; message: string; context: string | null };

type ViewData = {
  id: number;
  number: string;
  quoteDate: string;
  validUntil: string;
  statusKey: string;
  statusLabel: string;
  badge: string;
  locationLabel: string;
  lockedForEdit: boolean;
  canSendEmail: boolean;
  hasPublicToken: boolean;
  publicUrl: string;
  linkedSaleId: number;
  linkedSaleDate: string;
  linkedSaleCancelled: boolean;
  availabilityErrors: Issue[];
  availabilityWarnings: Issue[];
  showAvailabilityAlerts: boolean;
  clientLabel: string;
  client: { companyName: string; vatNumber: string; taxCode: string; sdi: string; pec: string; phone: string; email: string; address: string; cap: string; city: string; province: string };
  notes: string;
  publicNote: string;
  paymentMethods: string[];
  terms: string;
  items: ViewItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// $fmtMoney: number_format(2, ',', '.') — port manuale.
function fmtMoney(v: number): string {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// $fmtDate: d/m/Y, '—' se vuota.
function fmtDate(d: string): string {
  const s = String(d ?? "").trim();
  if (s === "") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

export function QuoteDetailContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: QuoteDetailQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [data, setData] = useState<ViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sendOpen, setSendOpen] = useState(false);
  // Duplica (feature 2026-07-16): nuova bozza dalle righe di questo preventivo.
  const [duplicating, setDuplicating] = useState(false);

  async function duplicateQuote() {
    if (!data || duplicating) return;
    if (typeof window !== "undefined" && !window.confirm("Creare una nuova bozza copiando le righe di questo preventivo? I prezzi di listino verranno aggiornati ai valori attuali.")) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "duplicate", id: String(data.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok || !j.id) {
        flashNavigate(pageUrl(`quotes?action=view&id=${data.id}`), { err: String(j.error ?? "Errore duplicazione preventivo.") });
        return;
      }
      flashNavigate(pageUrl(`quotes?action=edit&id=${j.id}`), { msg: "Preventivo duplicato" });
    } catch {
      setDuplicating(false);
    }
  }
  const [toEmail, setToEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  useEffect(() => {
    const raw = initialQuery?.id ?? new URLSearchParams(window.location.search).get("id") ?? "";
    const id = Number.parseInt(String(raw), 10) || 0;
    if (id <= 0) {
      flashNavigate(`/${encodeURIComponent(slug)}/quotes`, { err: "Preventivo non trovato" });
      return;
    }
    fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=view&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.redirect?.to === "list") {
          flashNavigate(`/${encodeURIComponent(slug)}/quotes`, { err: String(j.redirect.err ?? "Preventivo non trovato") });
          return;
        }
        if (!j?.view) {
          flashNavigate(`/${encodeURIComponent(slug)}/quotes`, { err: "Preventivo non trovato" });
          return;
        }
        const v = j.view as ViewData;
        setData(v);
        setToEmail(String(v.client?.email ?? ""));
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function pageUrl(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }

  // Invio email (quotes.php action=send): il server applica le guardie legacy
  // e risponde con il redirect + flash msg/err.
  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    if (sending || !data) return;
    setSending(true);
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "send", id: String(data.id), to_email: toEmail, message }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.redirect === "list") {
        flashNavigate(pageUrl("quotes"), j?.err ? { err: String(j.err) } : {});
        return;
      }
      const params = new URLSearchParams({ action: "view", id: String(j?.id ?? data.id) });
      const flash = j?.msg ? { msg: String(j.msg) } : j?.err ? { err: String(j.err) } : {};
      flashNavigate(pageUrl(`quotes?${params.toString()}`), flash);
    } finally {
      setSending(false);
    }
  }

  const c = data?.client;
  const capCityProv = data
    ? `${(data.client.cap ?? "").trim()} ${(data.client.city ?? "").trim()}${(data.client.province ?? "").trim() !== "" ? ` (${data.client.province.trim()})` : ""}`.trim()
    : "";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Preventivi</div>
          <h1 className="bs-page-title">Preventivo #{data ? data.number || "-" : "-"}</h1>
          <div className="bs-page-subtitle">
            {data ? (
              <>
                Data: <strong>{fmtDate(data.quoteDate)}</strong>
                {data.validUntil !== "" ? (
                  <>
                    {" "}
                    • Valido fino al: <strong>{fmtDate(data.validUntil)}</strong>
                  </>
                ) : null}
                {data.locationLabel !== "" ? (
                  <>
                    {" "}
                    • Sede: <strong>{data.locationLabel}</strong>
                  </>
                ) : null}{" "}
                • Stato: <span className={`badge text-bg-${data.badge}`}>{data.statusLabel}</span>
                {(() => {
                  const warn = quoteExpiryWarning(data.validUntil, data.statusKey);
                  return warn ? (
                    <>
                      {" "}
                      <span className="badge text-bg-warning">{warn}</span>
                    </>
                  ) : null;
                })()}
              </>
            ) : (
              "Dettaglio preventivo."
            )}
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={pageUrl("quotes")}>
              <i className="bi bi-arrow-left" /> Lista
            </a>
            {data && !data.lockedForEdit ? (
              <a className="btn btn-outline-secondary" href={pageUrl(`quotes?action=edit&id=${data.id}`)}>
                <i className="bi bi-pencil" /> Modifica
              </a>
            ) : null}
            {data && data.linkedSaleId > 0 ? (
              <a
                className={`btn ${data.linkedSaleCancelled ? "btn-outline-secondary" : "btn-success"}`}
                href={pageUrl(`pos_sale_detail?id=${data.linkedSaleId}`)}
              >
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            ) : data && data.statusKey === "accepted" && data.availabilityErrors.length === 0 ? (
              <a className="btn btn-success" href={pageUrl(`pos?quote_id=${data.id}`)}>
                <i className="bi bi-cash-coin me-1" />
                Vai a Pagamenti
              </a>
            ) : data && data.statusKey === "accepted" && data.availabilityErrors.length > 0 ? (
              <button className="btn btn-success" type="button" disabled title="Preventivo bloccato: correggi i contenuti non disponibili">
                <i className="bi bi-lock me-1" />
                Vai a Pagamenti
              </button>
            ) : null}
            {data ? (
              <a className="btn btn-outline-secondary" href={pageUrl(`quotes?action=pdf&id=${data.id}`)}>
                <i className="bi bi-filetype-pdf me-1" />
                PDF
              </a>
            ) : null}
            {data ? (
              <button className="btn btn-outline-secondary" type="button" disabled={duplicating} onClick={() => void duplicateQuote()} title="Crea una nuova bozza copiando le righe di questo preventivo">
                <i className="bi bi-copy me-1" />
                Duplica
              </button>
            ) : null}
            {data && data.hasPublicToken && data.availabilityErrors.length === 0 && data.canSendEmail ? (
              <button className="btn btn-primary" type="button" onClick={() => setSendOpen(true)}>
                <i className="bi bi-envelope me-1" />
                Invia email
              </button>
            ) : data && data.hasPublicToken && !data.canSendEmail ? (
              <button className="btn btn-primary" type="button" disabled title="Invio disponibile solo per preventivi in bozza o inviati non scaduti">
                <i className="bi bi-lock me-1" />
                Invia email
              </button>
            ) : data && data.hasPublicToken && data.availabilityErrors.length > 0 ? (
              <button className="btn btn-primary" type="button" disabled title="Preventivo bloccato: correggi i contenuti non disponibili prima dell'invio">
                <i className="bi bi-lock me-1" />
                Invia email
              </button>
            ) : data ? (
              <button className="btn btn-primary" type="button" disabled title="DB non aggiornato (manca public_token)">
                <i className="bi bi-envelope me-1" />
                Invia email
              </button>
            ) : null}
            {data ? (
              <a className="btn btn-outline-secondary" target="_blank" href={pageUrl(`quotes?action=print&id=${data.id}&embed=1`)}>
                <i className="bi bi-printer me-1" />
                Stampa
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

      {loading || !data ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <>
          {data.linkedSaleId > 0 && data.linkedSaleCancelled ? (
            <div className="alert alert-warning d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
              <div>
                La vendita collegata <strong>#{data.linkedSaleId}</strong>
                {data.linkedSaleDate !== "" ? (
                  <>
                    {" "}del <strong>{data.linkedSaleDate}</strong>
                  </>
                ) : null}{" "}
                è stata <strong>annullata</strong>. Anche questo preventivo è stato annullato automaticamente.
              </div>
              <a className="btn btn-sm btn-outline-secondary" href={pageUrl(`pos_sale_detail?id=${data.linkedSaleId}`)}>
                Apri dettaglio vendita
              </a>
            </div>
          ) : data.linkedSaleId > 0 ? (
            <div className="alert alert-success d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
              <div>
                Questo preventivo è stato acquistato ed è collegato alla vendita <strong>#{data.linkedSaleId}</strong>
                {data.linkedSaleDate !== "" ? (
                  <>
                    {" "}del <strong>{data.linkedSaleDate}</strong>
                  </>
                ) : null}
                .
              </div>
              <a className="btn btn-sm btn-outline-success" href={pageUrl(`pos_sale_detail?id=${data.linkedSaleId}`)}>
                Apri dettaglio vendita
              </a>
            </div>
          ) : data.statusKey === "accepted" && data.availabilityErrors.length === 0 ? (
            <div className="alert alert-info mb-3">
              Questo preventivo è <strong>Accettato</strong>. Usa il pulsante <strong>Vai a Pagamenti</strong> per riportare
              automaticamente cliente e righe in cassa.
            </div>
          ) : data.statusKey === "accepted" && data.availabilityErrors.length > 0 ? (
            <div className="alert alert-warning mb-3">
              Questo preventivo e <strong>Accettato</strong>, ma prima di riportarlo in Pagamenti devi correggere le righe non
              disponibili per la sede.
            </div>
          ) : null}

          {data.showAvailabilityAlerts && data.availabilityErrors.length > 0 ? (
            <div className="alert alert-danger mb-3">
              <div className="fw-semibold mb-1">
                <i className="bi bi-exclamation-triangle me-1" />
                Contenuti non disponibili nel preventivo
              </div>
              <div className="small mb-2">
                Non sarà possibile impostare lo stato in <strong>Accettato</strong> e non sarà possibile inviare via email
                questo preventivo finché le righe indicate non vengono corrette.
              </div>
              <ul className="mb-2 small">
                {data.availabilityErrors.map((issue, i) => (
                  <li key={i}>
                    {issue.message || "Elemento eliminato."}
                    {issue.context ? <span className="text-muted"> — {issue.context}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="small">Rimuovi o sostituisci dal preventivo le righe indicate per non avere blocchi.</div>
            </div>
          ) : null}

          {data.showAvailabilityAlerts && data.availabilityWarnings.length > 0 ? (
            <div className="alert alert-warning mb-3">
              <div className="fw-semibold mb-1">
                <i className="bi bi-exclamation-circle me-1" />
                Contenuti disattivati
              </div>
              <div className="small mb-2">Gli elementi sotto sono stati disattivati. Il preventivo resta gestibile e non ci sono blocchi.</div>
              <ul className="mb-0 small">
                {data.availabilityWarnings.map((issue, i) => (
                  <li key={i}>
                    {issue.message || "Elemento disattivato."}
                    {issue.context ? <span className="text-muted"> — {issue.context}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="row g-3">
            <div className="col-lg-4">
              <div className="card p-4">
                <div className="fw-semibold mb-2">Cliente</div>
                <div>{data.clientLabel}</div>
                <div className="text-muted small mt-2">
                  {c?.companyName ? (<>Azienda: <strong>{c.companyName}</strong><br /></>) : null}
                  {c?.vatNumber ? (<>P.IVA: <strong>{c.vatNumber}</strong><br /></>) : null}
                  {c?.taxCode ? (<>C.F.: <strong>{c.taxCode}</strong><br /></>) : null}
                  {c?.sdi ? (<>SDI: <strong>{c.sdi}</strong><br /></>) : null}
                  {c?.pec ? (<>PEC: <strong>{c.pec}</strong><br /></>) : null}
                  {c?.phone ? (<>Tel: <strong>{c.phone}</strong><br /></>) : null}
                  {c?.email ? (<>Email: <strong>{c.email}</strong><br /></>) : null}
                  {c?.address ? (<>Indirizzo: <strong>{c.address}</strong><br /></>) : null}
                  {c && (c.city || c.cap || c.province) ? <>{capCityProv}</> : null}
                </div>
              </div>

              {data.notes ? (
                <div className="card p-4 mt-3">
                  <div className="fw-semibold mb-2">Note interne</div>
                  <div className="text-muted small quote-prewrap">{data.notes}</div>
                </div>
              ) : null}

              {data.publicNote.trim() !== "" ? (
                <div className="card p-4 mt-3">
                  <div className="fw-semibold mb-2">Nota per il cliente</div>
                  <div className="text-muted small quote-prewrap">{data.publicNote.trim()}</div>
                </div>
              ) : null}

              {data.paymentMethods.length > 0 ? (
                <div className="card p-4 mt-3">
                  <div className="fw-semibold mb-2">Metodi di pagamento</div>
                  <div className="text-muted small quote-prewrap">{data.paymentMethods.join("\n")}</div>
                </div>
              ) : null}
            </div>

            <div className="col-lg-8">
              <div className="card p-4">
                <div className="fw-semibold mb-2">Righe preventivo</div>
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
                      {data.items.map((it, i) => (
                        <tr key={i}>
                          <td>
                            <div className="fw-semibold">{it.displayDescription}</div>
                            {it.sku ? <div className="small text-muted">SKU: {it.sku}</div> : null}
                            {Number(it.discountPercent) > 0 ? (
                              <div className="small text-muted">Sconto: {it.discountPercent}%</div>
                            ) : null}
                          </td>
                          <td className="text-end">{it.qty}</td>
                          <td className="text-end">€ {fmtMoney(it.unitPrice)}</td>
                          <td className="text-end">{it.taxRate}%</td>
                          <td className="text-end fw-semibold">€ {fmtMoney(it.lineTotal)}</td>
                        </tr>
                      ))}
                      {data.items.length === 0 ? (
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
                        <strong>€ {fmtMoney(data.subtotal)}</strong>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>Sconto</span>
                        <strong>€ {fmtMoney(data.discountTotal)}</strong>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>IVA</span>
                        <strong>€ {fmtMoney(data.taxTotal)}</strong>
                      </div>
                      <hr className="my-2" />
                      <div className="d-flex justify-content-between fs-5">
                        <span>Totale</span>
                        <strong>€ {fmtMoney(data.total)}</strong>
                      </div>
                    </div>
                  </div>
                </div>

                {data.terms ? (
                  <>
                    <hr className="my-3" />
                    <div className="small">
                      <div className="fw-semibold mb-1">Condizioni</div>
                      <div className="text-muted quote-prewrap">{data.terms}</div>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          {sendOpen ? (
            <>
              <div className="modal fade show d-block" id="sendQuoteModal" tabIndex={-1} role="dialog">
                <div className="modal-dialog modal-dialog-centered">
                  <div className="modal-content">
                    <form method="post" onSubmit={sendEmail}>
                      <div className="modal-header">
                        <h5 className="modal-title">Invia preventivo via email</h5>
                        <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setSendOpen(false)} />
                      </div>
                      <div className="modal-body">
                        <div className="mb-3">
                          <label className="form-label">Destinatario</label>
                          <input
                            type="email"
                            className="form-control"
                            name="to_email"
                            value={toEmail}
                            placeholder="nome@dominio.it"
                            onChange={(e) => setToEmail(e.target.value)}
                          />
                          <div className="form-text">Se lasci vuoto, verrà usata l’email del cliente (se presente).</div>
                        </div>

                        <div className="mb-3">
                          <label className="form-label">Messaggio (opzionale)</label>
                          <textarea
                            className="form-control"
                            name="message"
                            rows={4}
                            value={message}
                            placeholder="Scrivi un messaggio da includere nell’email…"
                            onChange={(e) => setMessage(e.target.value)}
                          />
                        </div>

                        <div className="small text-muted">
                          L’email conterrà un link pubblico per visualizzare il preventivo e scaricare il PDF.
                        </div>

                        {data.publicUrl !== "" ? (
                          <>
                            <hr className="my-3" />
                            <label className="form-label">Link pubblico (già generato)</label>
                            <input
                              className="form-control"
                              value={data.publicUrl}
                              readOnly
                              data-select-on-click="1"
                              onClick={(e) => (e.target as HTMLInputElement).select()}
                            />
                            <div className="form-text">Puoi copiare il link e inviarlo anche manualmente.</div>
                          </>
                        ) : null}
                      </div>
                      <div className="modal-footer">
                        <button type="button" className="btn btn-outline-secondary" onClick={() => setSendOpen(false)}>
                          Annulla
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={sending}>
                          <i className="bi bi-send me-1" />
                          Invia
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
              <div className="modal-backdrop fade show" />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
