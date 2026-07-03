"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP GiftCard list page (app/pages/giftcard.php), fed by
// the existing DB-backed /api/manage/giftcards. The live tenant has no
// GiftCards, so the captured PHP markup is the empty state (.giftcard-empty-card
// / .giftcard-empty-state). When the API returns rows, they are rendered in a
// table whose columns mirror the empty-state copy: mittente, destinatario,
// saldo, scadenza, stato, sede di emissione.

type GiftCard = {
  id: number;
  code: string;
  clientId: number;
  recipientName: string;
  initialAmount: number;
  balance: number;
  status: string;
  expiresAt: string;
  sourceSaleId?: number;
  createdAt: string;
};

// Status label + Bootstrap badge class for the GiftCardStatus union returned by
// the API (active | used | expired | cancelled).
const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  active: { label: "Attiva", cls: "text-bg-success" },
  used: { label: "Utilizzata", cls: "text-bg-secondary" },
  expired: { label: "Scaduta", cls: "text-bg-warning" },
  cancelled: { label: "Annullata", cls: "text-bg-dark" },
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusBadge(status: string): { label: string; cls: string } {
  return STATUS_BADGES[status] ?? { label: status || "—", cls: "text-bg-secondary" };
}

export function GiftcardContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [giftCards, setGiftCards] = useState<GiftCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setGiftCards(Array.isArray(j.giftCards) ? j.giftCards : []);
      })
      .catch(() => {
        if (!cancelled) setGiftCards([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${`${page}`.replace("&", "?")}`;
  }

  const isEmpty = !loading && giftCards.length === 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftcard.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <h1 className="bs-page-title">Fidelity / GiftCard</h1>
          <div className="bs-page-subtitle">Gestisci GiftCard, voucher e stato delle card emesse.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary btn-pill" href={href("giftcard")}>
              <i className="bi bi-arrow-left me-1" />
              Torna alla lista
            </a>
          </div>
        </div>
      </div>

      {isEmpty ? (
        <div className="card border-0 shadow-sm giftcard-empty-card">
          <div className="giftcard-empty-state">
            <div className="giftcard-empty-icon" aria-hidden="true">
              <i className="bi bi-credit-card-2-front" />
            </div>
            <h2>Nessuna GiftCard presente</h2>
            <p>
              Le GiftCard emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario, saldo, scadenze,
              riscatti e sede di emissione.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("pos")}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftCard
              </a>
              <a className="btn btn-outline-secondary" href={href("giftcard_settings")}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Codice</th>
                  <th>Destinatario</th>
                  <th>Emissione</th>
                  <th>Scadenza</th>
                  <th>Stato</th>
                  <th className="text-end">Saldo</th>
                  <th className="text-end">Importo</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {giftCards.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted small p-3">
                      {loading ? "Caricamento…" : "Nessuna GiftCard."}
                    </td>
                  </tr>
                ) : (
                  giftCards.map((card) => {
                    const badge = statusBadge(card.status);
                    return (
                      <tr key={card.id}>
                        <td className="fw-semibold">{card.code || "—"}</td>
                        <td>{card.recipientName || "—"}</td>
                        <td className="text-muted small">{fmtDate(card.createdAt)}</td>
                        <td className="text-muted small">{fmtDate(card.expiresAt)}</td>
                        <td>
                          <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        </td>
                        <td className="text-end fw-semibold">{fmtEuro(card.balance)}</td>
                        <td className="text-end text-muted">{fmtEuro(card.initialAmount)}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" href={href(`giftcard&action=edit&id=${card.id}`)}>
                            Apri
                          </a>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
