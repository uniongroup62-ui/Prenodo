"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP giftcard DETAIL (giftcard.php action=edit), fed by
// /api/manage/giftcards?action=view&id=<id>:
//   - header (codice / destinatario / stato / saldo / date / messaggio / vendita)
//   - Movimenti (giftcard_transactions)
//   - Riscatta importo (redeem) + Modifica destinatario (recipient/note/expiry)
// Topup + cancel are intentionally absent (disabled in the legacy backend).

type Tx = { id: number; type: string; amount: number; note: string; createdAt: string };
type Detail = {
  id: number;
  code: string;
  recipientName: string;
  recipientEmail: string;
  clientId: number;
  initialAmount: number;
  balance: number;
  currency: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  note: string;
  giftMessage: string;
  internalNote: string;
  eventType: string;
  linkedSaleId: number | null;
  transactions: Tx[];
  canRedeem: boolean;
  canEdit: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function cardIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(v: string): string {
  const s = (v ?? "").slice(0, 10);
  if (s === "") return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : "—";
}
function txLabel(t: string): string {
  const s = t.toLowerCase();
  if (s === "redeem") return "Riscatto";
  if (s === "issue" || s === "topup") return "Emissione / Ricarica";
  if (s === "refund") return "Rimborso";
  if (s === "cancel") return "Annullamento";
  return t || "—";
}

export function GiftCardDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [id, setId] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // Redeem form.
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemNote, setRedeemNote] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  // Recipient edit.
  const [clients, setClients] = useState<Array<{ id: number; name: string }>>([]);
  const [recClientId, setRecClientId] = useState(0);
  const [recName, setRecName] = useState("");
  const [recEmail, setRecEmail] = useState("");
  const [recExpiry, setRecExpiry] = useState("");
  const [recMessage, setRecMessage] = useState("");
  const [recInternal, setRecInternal] = useState("");
  const [savingRec, setSavingRec] = useState(false);

  useEffect(() => {
    const cid = cardIdFromUrl();
    if (cid > 0) setId(cid);
    else {
      setError("GiftCard non valida.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=view&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        if (j && j.ok && j.detail) {
          setData(j.detail);
          setClients(Array.isArray(j.clients) ? j.clients : []);
          setRecClientId(Number(j.detail.clientId ?? 0) || 0);
          setRecName(String(j.detail.recipientName ?? ""));
          setRecEmail(String(j.detail.recipientEmail ?? ""));
          setRecExpiry(String(j.detail.expiresAt ?? "").slice(0, 10));
          setRecMessage(String(j.detail.giftMessage ?? ""));
          setRecInternal(String(j.detail.internalNote ?? ""));
          setError("");
        } else {
          setError(j?.error || "GiftCard non trovata.");
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento della GiftCard.");
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

  async function doRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (redeeming) return;
    const amt = Number.parseFloat(redeemAmount.replace(",", ".")) || 0;
    if (amt <= 0) {
      setError("Inserisci un importo da riscattare.");
      return;
    }
    setRedeeming(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "redeem", id: String(id), amount: String(amt), note: redeemNote }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Riscatto non riuscito."));
      } else {
        setFlash("Riscatto registrato.");
        setRedeemAmount("");
        setRedeemNote("");
        setReloadKey((k) => k + 1);
      }
    } finally {
      setRedeeming(false);
    }
  }

  async function saveRecipient(e: React.FormEvent) {
    e.preventDefault();
    if (savingRec) return;
    setSavingRec(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "update", id: String(id), recipient_client_id: String(recClientId), recipient_name: recName, recipient_email: recEmail, expires_at: recExpiry, gift_message: recMessage, internal_note: recInternal }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Aggiornamento non riuscito."));
      } else {
        setFlash("GiftCard aggiornata.");
        setReloadKey((k) => k + 1);
      }
    } finally {
      setSavingRec(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftcard.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">GiftCard</div>
          <h1 className="bs-page-title">{data ? `GiftCard ${data.code}` : "GiftCard"}</h1>
          <div className="bs-page-subtitle">{data ? `Destinatario: ${data.recipientName || "—"}` : "Dettaglio GiftCard."}</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={page("giftcard")}>
            <i className="bi bi-arrow-left me-1" />
            GiftCard emesse
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : data ? (
        <div className="row g-3">
          <div className="col-lg-4">
            <div className="card p-3">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <span className={`badge ${data.statusBadge}`}>{data.statusLabel}</span>
                {data.linkedSaleId ? (
                  <a className="btn btn-sm btn-outline-secondary" href={page(`pos_sale_detail&id=${data.linkedSaleId}`)}>
                    Vendita #{data.linkedSaleId}
                  </a>
                ) : null}
              </div>
              <div className="display-6 fw-bold">{fmtEuro(data.balance)}</div>
              <div className="text-muted small">Saldo di {fmtEuro(data.initialAmount)} iniziali</div>
              <div className="text-muted small mt-2">
                {data.recipientEmail ? <div>Email: {data.recipientEmail}</div> : null}
                {data.clientId ? (
                  <div>
                    Cliente: <a href={page(`clients&action=view&id=${data.clientId}`)}>#{data.clientId}</a>
                  </div>
                ) : null}
                <div>Emessa: {fmtDate(data.issuedAt)}</div>
                <div>Scadenza: {fmtDate(data.expiresAt)}</div>
                {data.redeemedAt ? <div>Utilizzata: {fmtDate(data.redeemedAt)}</div> : null}
                {data.giftMessage ? <div className="mt-1">Messaggio: {data.giftMessage}</div> : null}
              </div>
            </div>

            {data.canRedeem ? (
              <div className="card p-3 mt-3">
                <div className="fw-semibold mb-2">
                  <i className="bi bi-cash-coin me-1" />
                  Riscatta importo
                </div>
                <form className="d-flex flex-column gap-2" onSubmit={doRedeem}>
                  <div className="input-group">
                    <span className="input-group-text">€</span>
                    <input className="form-control" type="number" min={0} step="0.01" max={data.balance} placeholder="0,00" value={redeemAmount} onChange={(e) => setRedeemAmount(e.target.value)} />
                  </div>
                  <input className="form-control form-control-sm" placeholder="Nota (opzionale)" value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} />
                  <button className="btn btn-outline-success" type="submit" disabled={redeeming}>
                    {redeeming ? "Riscatto…" : "Riscatta"}
                  </button>
                </form>
              </div>
            ) : null}

            {data.canEdit ? (
              <div className="card p-3 mt-3">
                <div className="fw-semibold mb-2">
                  <i className="bi bi-person me-1" />
                  Destinatario
                </div>
                <form className="d-flex flex-column gap-2" onSubmit={saveRecipient}>
                  <div>
                    <label className="form-label small mb-1">Abbina a un cliente</label>
                    <select className="form-select form-select-sm" value={recClientId} onChange={(e) => setRecClientId(Number(e.target.value) || 0)}>
                      <option value={0}>— Nessun cliente —</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <div className="form-text">Se abbini un cliente, nome ed email vengono presi dalla sua anagrafica.</div>
                  </div>
                  <input className="form-control form-control-sm" placeholder="Nome destinatario" value={recName} disabled={recClientId > 0} onChange={(e) => setRecName(e.target.value)} />
                  <input className="form-control form-control-sm" placeholder="Email destinatario" value={recEmail} disabled={recClientId > 0} onChange={(e) => setRecEmail(e.target.value)} />
                  <input className="form-control form-control-sm" type="date" value={recExpiry} onChange={(e) => setRecExpiry(e.target.value)} />
                  <textarea className="form-control form-control-sm" rows={2} placeholder="Messaggio regalo" value={recMessage} onChange={(e) => setRecMessage(e.target.value)} />
                  <textarea className="form-control form-control-sm" rows={2} placeholder="Nota interna" value={recInternal} onChange={(e) => setRecInternal(e.target.value)} />
                  <button className="btn btn-sm btn-primary" type="submit" disabled={savingRec}>
                    {savingRec ? "Salvataggio…" : "Salva"}
                  </button>
                </form>
              </div>
            ) : null}
          </div>

          <div className="col-lg-8">
            <div className="card">
              <div className="card-header fw-semibold">
                <i className="bi bi-clock-history me-2" />
                Movimenti
              </div>
              <div className="table-responsive">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th className="text-end">Importo</th>
                      <th>Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transactions.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-muted p-3">
                          Nessun movimento.
                        </td>
                      </tr>
                    ) : (
                      data.transactions.map((t) => (
                        <tr key={t.id}>
                          <td className="text-muted">{fmtDate(t.createdAt)}</td>
                          <td>{txLabel(t.type)}</td>
                          <td className={`text-end fw-semibold ${t.type === "redeem" ? "text-danger" : "text-success"}`}>
                            {t.type === "redeem" ? "- " : ""}
                            {fmtEuro(t.amount)}
                          </td>
                          <td className="text-muted small">{t.note || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
