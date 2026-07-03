"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP quote DETAIL (quotes.php action=view), fed by
// /api/manage/quotes?action=view&id=<id>:
//   - header (numero / data / valido fino / sede / stato) + actions (Lista /
//     Modifica / Incassa / Dettaglio vendita / Invia email)
//   - Cliente card (anagrafica + fiscale + contatti)
//   - Righe preventivo table + totals (subtotale / sconto / IVA / totale)
//   - Nota per il cliente + Condizioni
// PDF / Stampa are omitted (no server PDF renderer in Next yet).

type Item = { description: string; sku: string; itemType: string; qty: number; unitPrice: number; taxRate: number; discountPercent: number; lineTotal: number };
type Detail = {
  id: number;
  number: string;
  quoteDate: string;
  validUntil: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  locationName: string;
  client: { name: string; companyName: string; vatNumber: string; taxCode: string; sdi: string; pec: string; phone: string; email: string; address: string; cap: string; city: string; province: string };
  items: Item[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  notes: string;
  terms: string;
  publicNote: string;
  linkedSaleId: number | null;
  linkedSaleCancelled: boolean;
  canEdit: boolean;
  canSendEmail: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function quoteIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(v: string): string {
  const s = (v ?? "").slice(0, 10);
  if (s === "") return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : "—";
}

export function QuoteDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [id, setId] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [sendOpen, setSendOpen] = useState(false);
  const [toEmail, setToEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const qid = quoteIdFromUrl();
    if (qid > 0) setId(qid);
    else {
      setError("Preventivo non valido.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=view&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        if (j && j.ok && j.detail) {
          setData(j.detail);
          setToEmail(String(j.detail.client?.email ?? ""));
          setError("");
        } else {
          setError(j?.error || "Preventivo non trovato.");
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento del preventivo.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, slug, reloadKey]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "send", id: String(id), to_email: toEmail, message }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Errore nell'invio del preventivo."));
      } else {
        setSendOpen(false);
        setFlash("Preventivo inviato.");
        setReloadKey((k) => k + 1);
      }
    } finally {
      setSending(false);
    }
  }

  const c = data?.client;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Preventivi</div>
          <h1 className="bs-page-title">Preventivo #{data?.number || "-"}</h1>
          <div className="bs-page-subtitle">
            {data ? (
              <>
                Data: <strong>{fmtDate(data.quoteDate)}</strong>
                {data.validUntil ? (
                  <>
                    {" "}
                    • Valido fino al: <strong>{fmtDate(data.validUntil)}</strong>
                  </>
                ) : null}
                {data.locationName ? (
                  <>
                    {" "}
                    • Sede: <strong>{data.locationName}</strong>
                  </>
                ) : null}{" "}
                • Stato: <span className={`badge ${data.statusBadge}`}>{data.statusLabel}</span>
              </>
            ) : (
              "Dettaglio preventivo."
            )}
          </div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={page("quotes")}>
              <i className="bi bi-arrow-left me-1" />
              Lista
            </a>
            {data?.canEdit ? (
              <a className="btn btn-outline-secondary" href={page(`quotes&action=edit&id=${id}`)}>
                <i className="bi bi-pencil me-1" />
                Modifica
              </a>
            ) : null}
            {data?.linkedSaleId ? (
              <a className={`btn ${data.linkedSaleCancelled ? "btn-outline-secondary" : "btn-success"}`} href={page(`pos_sale_detail&id=${data.linkedSaleId}`)}>
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            ) : data && data.status !== "converted" ? (
              <a className="btn btn-success" href={`/${encodeURIComponent(slug)}/pos?quote=${id}`}>
                <i className="bi bi-cash-coin me-1" />
                Incassa
              </a>
            ) : null}
            {data?.canSendEmail ? (
              <button className="btn btn-primary" type="button" onClick={() => setSendOpen(true)}>
                <i className="bi bi-envelope me-1" />
                Invia email
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : data ? (
        <>
          {data.linkedSaleId && data.linkedSaleCancelled ? (
            <div className="alert alert-warning mb-3">
              La vendita collegata <strong>#{data.linkedSaleId}</strong> è stata annullata.
            </div>
          ) : data.linkedSaleId ? (
            <div className="alert alert-success mb-3">
              Questo preventivo è stato acquistato ed è collegato alla vendita <strong>#{data.linkedSaleId}</strong>.
            </div>
          ) : null}

          <div className="row g-3">
            <div className="col-lg-4">
              <div className="card p-4">
                <div className="fw-semibold mb-2">Cliente</div>
                <div>{c?.name || "—"}</div>
                <div className="text-muted small mt-2">
                  {c?.companyName ? (<div>Azienda: <strong>{c.companyName}</strong></div>) : null}
                  {c?.vatNumber ? (<div>P.IVA: <strong>{c.vatNumber}</strong></div>) : null}
                  {c?.taxCode ? (<div>C.F.: <strong>{c.taxCode}</strong></div>) : null}
                  {c?.sdi ? (<div>SDI: <strong>{c.sdi}</strong></div>) : null}
                  {c?.pec ? (<div>PEC: <strong>{c.pec}</strong></div>) : null}
                  {c?.phone ? (<div>Tel: <strong>{c.phone}</strong></div>) : null}
                  {c?.email ? (<div>Email: <strong>{c.email}</strong></div>) : null}
                  {c?.address ? (
                    <div>
                      Indirizzo: <strong>{[c.address, c.cap, c.city, c.province].filter(Boolean).join(" ")}</strong>
                    </div>
                  ) : null}
                </div>
              </div>

              {data.publicNote ? (
                <div className="card p-4 mt-3">
                  <div className="fw-semibold mb-2">Nota per il cliente</div>
                  <div className="text-muted small" style={{ whiteSpace: "pre-wrap" }}>{data.publicNote}</div>
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
                      {data.items.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-muted p-3">
                            Nessuna riga.
                          </td>
                        </tr>
                      ) : (
                        data.items.map((it, i) => (
                          <tr key={i}>
                            <td>
                              <div className="fw-semibold">{it.description}</div>
                              {it.sku ? <div className="small text-muted">SKU: {it.sku}</div> : null}
                              {it.discountPercent > 0 ? <div className="small text-muted">Sconto: {it.discountPercent}%</div> : null}
                            </td>
                            <td className="text-end">{it.qty}</td>
                            <td className="text-end">€ {fmtMoney(it.unitPrice)}</td>
                            <td className="text-end">{it.taxRate}%</td>
                            <td className="text-end fw-semibold">€ {fmtMoney(it.lineTotal)}</td>
                          </tr>
                        ))
                      )}
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
                      <div className="text-muted" style={{ whiteSpace: "pre-wrap" }}>{data.terms}</div>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {sendOpen ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <form onSubmit={sendEmail}>
                  <div className="modal-header">
                    <h5 className="modal-title">Invia preventivo via email</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setSendOpen(false)} />
                  </div>
                  <div className="modal-body">
                    <div className="mb-3">
                      <label className="form-label">Destinatario</label>
                      <input type="email" className="form-control" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="nome@dominio.it" />
                      <div className="form-text">Se lasci vuoto, verrà usata l&apos;email del cliente (se presente).</div>
                    </div>
                    <div className="mb-3">
                      <label className="form-label">Messaggio (opzionale)</label>
                      <textarea className="form-control" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Scrivi un messaggio da includere nell'email…" />
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setSendOpen(false)}>
                      Annulla
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={sending}>
                      {sending ? "Invio…" : "Invia"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </div>
  );
}
