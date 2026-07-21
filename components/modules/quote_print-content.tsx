"use client";

import { useEffect, useState } from "react";
import { flashNavigate } from "./flash";

// Port fedele della STAMPA preventivo (app/pages/quotes.php action=print,
// embed-friendly): toolbar no-print Torna/Stampa, intestazione attività
// (profilo preventivo + snapshot sede), meta preventivo, cliente, righe,
// totali, Nota, Metodi di pagamento, Condizioni (fallback condizioni
// predefinite) e footer.

type PrintItem = {
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

type PrintData = {
  id: number;
  number: string;
  quoteDate: string;
  validUntil: string;
  statusLabel: string;
  clientLabel: string;
  client: { companyName: string; vatNumber: string; taxCode: string; sdi: string; pec: string; phone: string; email: string; address: string; cap: string; city: string; province: string };
  biz: { companyName: string; vat: string; taxCode: string; sdi: string; pec: string; address: string; cap: string; city: string; province: string; phone: string; email: string; website: string; footer: string; termsDefault: string };
  items: PrintItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  publicNote: string;
  paymentMethods: string[];
  terms: string;
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

export function QuotePrintContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: { id?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [data, setData] = useState<PrintData | null>(null);
  const [loading, setLoading] = useState(true);
  // Audit giro 3: errore di rete = "Caricamento…" perpetuo, senza messaggio.
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const raw = initialQuery?.id ?? new URLSearchParams(window.location.search).get("id") ?? "";
    const id = Number.parseInt(String(raw), 10) || 0;
    if (id <= 0) {
      flashNavigate(`/${encodeURIComponent(slug)}/quotes`, { err: "Preventivo non trovato" });
      return;
    }
    fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=print&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.redirect?.to === "list" || !j?.print) {
          flashNavigate(`/${encodeURIComponent(slug)}/quotes`, { err: String(j?.redirect?.err ?? "Preventivo non trovato") });
          return;
        }
        setData(j.print as PrintData);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        setLoadError(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading || !data) {
    return (
      <div className="container-fluid">
        {loadError ? (
          <div className="alert alert-danger">Errore di caricamento. Ricarica la pagina.</div>
        ) : (
          <div className="card p-3 text-muted small">Caricamento…</div>
        )}
      </div>
    );
  }

  const clientAddrParts = [
    data.client.address.trim(),
    `${data.client.cap.trim()} ${data.client.city.trim()}${data.client.province.trim() !== "" ? ` (${data.client.province.trim()})` : ""}`,
  ].map((x) => x.trim()).filter((x) => x !== "");

  const bizAddrParts = [
    data.biz.address.trim(),
    `${data.biz.cap.trim()} ${data.biz.city.trim()}${data.biz.province.trim() !== "" ? ` (${data.biz.province.trim()})` : ""}`,
  ].map((x) => x.trim()).filter((x) => x !== "");

  const publicNoteOut = data.publicNote.trim();
  const pmOutText = data.paymentMethods.join("\n");
  const footer = data.biz.footer.trim();
  const termsOut = data.terms.trim();

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="d-flex justify-content-between align-items-center mb-3 no-print">
        <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/quotes?action=view&id=${data.id}`}>
          <i className="bi bi-arrow-left" /> Torna
        </a>
        <button className="btn btn-primary" type="button" data-quote-print="1" onClick={() => window.print()}>
          <i className="bi bi-printer me-1" />
          Stampa
        </button>
      </div>

      <div className="card p-4">
        <div className="d-flex justify-content-between align-items-start gap-3 flex-wrap">
          <div className="quote-print-business">
            <div className="h5 fw-bold mb-1">{data.biz.companyName || "—"}</div>
            {bizAddrParts.length > 0 ? <div className="text-muted">{bizAddrParts.join(" • ")}</div> : null}
            <div className="text-muted small mt-2">
              {data.biz.vat !== "" ? (<>P.IVA: <strong>{data.biz.vat}</strong><br /></>) : null}
              {data.biz.taxCode !== "" ? (<>C.F.: <strong>{data.biz.taxCode}</strong><br /></>) : null}
              {data.biz.sdi !== "" ? (<>SDI: <strong>{data.biz.sdi}</strong><br /></>) : null}
              {data.biz.pec !== "" ? (<>PEC: <strong>{data.biz.pec}</strong><br /></>) : null}
              {data.biz.phone !== "" ? (<>Tel: <strong>{data.biz.phone}</strong><br /></>) : null}
              {data.biz.email !== "" ? (<>Email: <strong>{data.biz.email}</strong><br /></>) : null}
              {data.biz.website !== "" ? (<>Web: <strong>{data.biz.website}</strong></>) : null}
            </div>
          </div>

          <div className="text-end quote-print-meta">
            <div className="h4 fw-bold mb-0">Preventivo</div>
            <div className="text-muted">
              N. <strong>{data.number || "—"}</strong>
            </div>
            <div className="small text-muted mt-2">
              Data: <strong>{fmtDate(data.quoteDate)}</strong>
              <br />
              {data.validUntil !== "" ? (
                <>
                  Valido fino al: <strong>{fmtDate(data.validUntil)}</strong>
                  <br />
                </>
              ) : null}
              Stato: <strong>{data.statusLabel}</strong>
            </div>
          </div>
        </div>

        <hr className="my-3" />

        <div className="row g-3">
          <div className="col-md-6">
            <div className="fw-semibold mb-1">Cliente</div>
            <div>{data.clientLabel}</div>
            {clientAddrParts.length > 0 ? <div className="text-muted small">{clientAddrParts.join(" • ")}</div> : null}
            <div className="text-muted small mt-1">
              {data.client.companyName ? (<>Azienda: <strong>{data.client.companyName}</strong><br /></>) : null}
              {data.client.vatNumber ? (<>P.IVA: <strong>{data.client.vatNumber}</strong><br /></>) : null}
              {data.client.taxCode ? (<>C.F.: <strong>{data.client.taxCode}</strong><br /></>) : null}
              {data.client.sdi ? (<>SDI: <strong>{data.client.sdi}</strong><br /></>) : null}
              {data.client.pec ? (<>PEC: <strong>{data.client.pec}</strong><br /></>) : null}
              {data.client.phone ? (<>Tel: <strong>{data.client.phone}</strong><br /></>) : null}
              {data.client.email ? (<>Email: <strong>{data.client.email}</strong></>) : null}
            </div>
          </div>
        </div>

        <hr className="my-3" />

        <div className="table-responsive">
          <table className="table align-middle">
            <thead>
              <tr>
                <th>Descrizione</th>
                <th className="text-end">Q.tà</th>
                <th className="text-end">Prezzo</th>
                <th className="text-end">IVA</th>
                <th className="text-end">Totale riga</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it, i) => (
                <tr key={i}>
                  <td>
                    <div className="fw-semibold">{it.displayDescription}</div>
                    {it.sku ? <div className="small text-muted">SKU: {it.sku}</div> : null}
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

        <div className="row g-3 justify-content-end">
          <div className="col-md-5">
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

        {publicNoteOut !== "" ? (
          <>
            <hr className="my-3" />
            <div className="small">
              <div className="fw-semibold mb-1">Nota</div>
              <div className="text-muted quote-prewrap">{publicNoteOut}</div>
            </div>
          </>
        ) : null}

        {pmOutText !== "" ? (
          <>
            <hr className="my-3" />
            <div className="small">
              <div className="fw-semibold mb-1">Metodi di pagamento</div>
              <div className="text-muted quote-prewrap">{pmOutText}</div>
            </div>
          </>
        ) : null}

        {termsOut !== "" ? (
          <>
            <hr className="my-3" />
            <div className="small">
              <div className="fw-semibold mb-1">Condizioni</div>
              <div className="text-muted quote-prewrap">{termsOut}</div>
            </div>
          </>
        ) : null}

        {footer !== "" ? (
          <>
            <hr className="my-3" />
            <div className="small text-muted quote-prewrap">{footer}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
