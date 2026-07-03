"use client";

/*
 * GiftVoucherFaithful — port of the legacy PUBLIC gift (omaggio) voucher page
 * (C:/xampp/htdocs/app/pages/gift_voucher.php, public mode: index.php?page=
 * gift_voucher&public=1&embed=1&token=<64hex>). The PHP page rendered a
 * printable voucher card: business header, code OM-000000 + status badge with
 * a WATERMARK for non-available states (RISCATTATO/SCADUTO/ANNULLATO/
 * ACCUMULO), client, unlocked/expiry dates, the "Contenuto Omaggi" table
 * (VOCE/TOT/USATA/RIMANENTE from instanceRewardItemsState), the client note,
 * the conditions (gift terms with a 3-line default fallback) and a JsBarcode
 * of the code. Data comes from /api/public/gift-voucher?slug=&token=.
 */

import { useEffect, useRef, useState } from "react";

const CSS_LINKS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "/assets/css/pages/giftcard_voucher.css",
];

// Default terms (gift_voucher.php ~170-174) when the gift has none.
const DEFAULT_TERMS = [
  "L'omaggio è utilizzabile fino all'utilizzo di tutti gli elementi inclusi, oppure fino alla data di scadenza (se presente).",
  "Non convertibile in denaro e non rimborsabile.",
  "Presentare il codice in cassa per l'utilizzo.",
];

type VoucherItem = { label: string; qtyTotal: number; qtyRedeemed: number; qtyRemaining: number };

type Voucher = {
  code: string;
  state: string;
  giftName: string;
  giftDescription: string;
  clientName: string;
  unlockedAt: string;
  expiresAt: string;
  redeemedAt: string;
  note: string;
  termsText: string;
  items: VoucherItem[];
};

type Business = { name: string; addrLine1: string; addrLine2: string; addrLine3: string; phone: string; email: string };

// Badge + watermark per stato (gift_voucher.php ~117-121).
function statusMeta(state: string): { badge: string; label: string; watermark: string } {
  switch (state) {
    case "disponibile": return { badge: "success", label: "Disponibile", watermark: "" };
    case "riscattato": return { badge: "dark", label: "Riscattato", watermark: "RISCATTATO" };
    case "scaduto": return { badge: "warning", label: "Scaduto", watermark: "SCADUTO" };
    case "annullato": return { badge: "danger", label: "Annullato", watermark: "ANNULLATO" };
    case "accumulo": return { badge: "secondary", label: "Accumulo", watermark: "ACCUMULO" };
    default: return { badge: "secondary", label: state || "—", watermark: "" };
  }
}

function fmtDate(dt: string): string {
  const s = String(dt ?? "").trim();
  if (s === "") return "—";
  const ts = Date.parse(s.replace(" ", "T"));
  if (Number.isNaN(ts)) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function buildTerms(termsRaw: string, bizName: string): string[] {
  const norm = String(termsRaw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = norm === "" ? DEFAULT_TERMS : norm.split(/\n+/);
  return lines
    .map((raw) => String(raw).trim().replace(/^[-•\t\s]+/u, "").split("{BUSINESS_NAME}").join(bizName))
    .filter((ln) => ln !== "");
}

export function GiftVoucherFaithful({ slug, token, embed }: { slug: string; token: string; embed: boolean }) {
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const barcodeRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!embed) return;
    const previous = document.body.className;
    document.body.className = "embed-body";
    document.body.style.background = "#fff";
    return () => {
      document.body.className = previous;
      document.body.style.background = "";
    };
  }, [embed]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/public/gift-voucher?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setError(String(data.error ?? "Voucher omaggio non trovato."));
          return;
        }
        setVoucher(data.voucher as Voucher);
        setBusiness(data.business as Business);
        setError("");
      })
      .catch(() => {
        if (active) setError("Voucher omaggio non trovato.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug, token]);

  useEffect(() => {
    const code = voucher?.code ?? "";
    if (!code || !barcodeRef.current) return;
    let cancelled = false;
    function draw() {
      const win = window as typeof window & { JsBarcode?: (el: Element, value: string, opts: object) => void };
      if (cancelled || !win.JsBarcode || !barcodeRef.current) return;
      try {
        win.JsBarcode(barcodeRef.current, code, { format: "CODE128", displayValue: false, height: 70, margin: 0 });
      } catch { /* codice in chiaro sotto */ }
    }
    const win = window as typeof window & { JsBarcode?: unknown };
    if (win.JsBarcode) { draw(); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js";
    script.async = true;
    script.onload = draw;
    document.body.appendChild(script);
    return () => { cancelled = true; };
  }, [voucher?.code]);

  if (loading || error || !voucher || !business) {
    return (
      <>
        {CSS_LINKS.map((href) => (<link key={href} rel="stylesheet" href={href} />))}
        <div className="voucher-wrap">
          <div className="card p-4 voucher-card">
            {loading ? <div className="text-muted">Caricamento…</div> : <div className="alert alert-danger mb-0">{error || "Voucher omaggio non trovato."}</div>}
          </div>
        </div>
      </>
    );
  }

  const meta = statusMeta(voucher.state);
  const terms = buildTerms(voucher.termsText, business.name);

  return (
    <>
      {CSS_LINKS.map((href) => (<link key={href} rel="stylesheet" href={href} />))}
      <div className="voucher-wrap">
        {!embed ? (
          <div className="d-flex justify-content-end mb-2 voucher-toolbar">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => window.print()}>
              <i className="bi bi-printer me-1" />
              Stampa / Salva PDF
            </button>
          </div>
        ) : null}
        <div className="card p-4 voucher-card position-relative">
          {meta.watermark ? (
            <div
              className="position-absolute top-50 start-50 translate-middle fw-bold text-uppercase"
              style={{ fontSize: "3.5rem", color: "rgba(220,53,69,.14)", transform: "translate(-50%,-50%) rotate(-18deg)", pointerEvents: "none", whiteSpace: "nowrap" }}
            >
              {meta.watermark}
            </div>
          ) : null}

          <div className="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
            <div>
              <div className="fw-bold fs-5">{business.name}</div>
              {business.addrLine1 ? <div className="text-muted small">{business.addrLine1}</div> : null}
              {business.addrLine2 ? <div className="text-muted small">{business.addrLine2}</div> : null}
              {business.addrLine3 ? <div className="text-muted small">{business.addrLine3}</div> : null}
              {business.phone ? <div className="text-muted small">Tel. {business.phone}</div> : null}
            </div>
            <div className="text-end">
              <div className="fw-bold fs-4" style={{ letterSpacing: 2 }}>{voucher.code}</div>
              <span className={`badge bg-${meta.badge}${meta.badge === "warning" ? " text-dark" : ""}`}>{meta.label}</span>
            </div>
          </div>

          <h1 className="h4 mb-1">Voucher omaggio — {voucher.giftName}</h1>
          {voucher.giftDescription ? <div className="text-muted mb-2">{voucher.giftDescription}</div> : null}

          <div className="row g-2 mb-3">
            <div className="col-sm-4"><div className="text-muted small">Cliente</div><div className="fw-semibold">{voucher.clientName}</div></div>
            <div className="col-sm-4"><div className="text-muted small">Sbloccato</div><div className="fw-semibold">{fmtDate(voucher.unlockedAt)}</div></div>
            <div className="col-sm-4"><div className="text-muted small">Scadenza</div><div className="fw-semibold">{voucher.expiresAt ? fmtDate(voucher.expiresAt) : "Nessuna scadenza"}</div></div>
          </div>

          <h2 className="h6">Contenuto Omaggi</h2>
          <div className="table-responsive mb-3">
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th>VOCE</th>
                  <th className="text-end">TOT</th>
                  <th className="text-end">USATA</th>
                  <th className="text-end">RIMANENTE</th>
                </tr>
              </thead>
              <tbody>
                {voucher.items.length === 0 ? (
                  <tr><td colSpan={4} className="text-muted">Nessun elemento.</td></tr>
                ) : (
                  voucher.items.map((it, i) => (
                    <tr key={i} className={it.qtyRemaining <= 0 ? "text-muted" : ""}>
                      <td>{it.label}</td>
                      <td className="text-end">{it.qtyTotal}</td>
                      <td className="text-end">{it.qtyRedeemed}</td>
                      <td className="text-end fw-semibold">{it.qtyRemaining}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {voucher.note ? (
            <div className="mb-3">
              <h2 className="h6">Nota per il cliente</h2>
              <div>{voucher.note}</div>
            </div>
          ) : null}

          <div className="mb-3">
            <h2 className="h6">Condizioni</h2>
            <ul className="small text-muted mb-0">
              {terms.map((t, i) => (<li key={i}>{t}</li>))}
            </ul>
          </div>

          <div className="text-center border-top pt-3">
            <svg ref={barcodeRef} aria-hidden="true" />
            <div className="fw-bold" style={{ letterSpacing: 3 }}>{voucher.code}</div>
            <div className="text-muted small">Mostra questo codice in cassa</div>
          </div>
        </div>
      </div>
    </>
  );
}
