"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP client STORICO page (app/pages/clients.php
// action=history), fed by /api/manage/clients?action=history&id=<id>:
//   - summary counts (totale / completati / prenotati / in attesa / annullati)
//     + ultima/prossima visita
//   - appointment lists per status (Prenotati / Completati / Annullati), ≤10
//     each, with servizi + staff + subtotale/sconto/netto + status badge + an
//     "Apri" link to the appointment editor
//   - active Pacchetti / GiftBox / GiftCard (from the residuals detail)
//   - last 10 Preventivi + Storico vendite

type Appt = {
  id: number;
  startsAt: string;
  statusKey: string;
  statusLabel: string;
  statusBadge: string;
  serviceNames: string;
  staffNames: string;
  subtotal: number;
  discountAmount: number;
  totalNet: number;
};
type Sale = { id: number; saleDate: string; total: number; purchasedItem: string };
type Quote = { id: number; number: string; quoteDate: string; validUntil: string; total: number; status: string };
type Package = { package_name: string; sessions_remaining: number; sessions_total: number; expires_at: string | null; breakdown: string };
type Giftbox = { giftbox_name: string; code: string; remaining_qty: number; total_qty: number; expires_at: string | null };
type Giftcard = { code: string; balance: number; expires_at: string | null };

type HistoryPayload = {
  ok?: boolean;
  error?: string;
  client?: { id: number; name: string; email?: string };
  summary?: { total: number; done: number; scheduled: number; pending: number; canceled: number; lastVisit: string | null; nextVisit: string | null };
  scheduledAppts?: Appt[];
  doneAppts?: Appt[];
  canceledAppts?: Appt[];
  packages?: Package[];
  giftboxes?: Giftbox[];
  giftcards?: Giftcard[];
  quotes?: Quote[];
  sales?: Sale[];
  salesTotal?: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clientIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateTime(v: string | null): string {
  const s = (v ?? "").trim();
  if (s === "") return "—";
  return s.slice(0, 16).replace("T", " ");
}
function fmtDate(v: string | null): string {
  const s = (v ?? "").trim();
  return s !== "" ? s.slice(0, 10) : "—";
}

function ApptTable({ title, rows }: { title: string; rows: Appt[] }) {
  const slug = tenantSlug();
  return (
    <div className="card mt-3">
      <div className="card-header fw-semibold">{title}</div>
      <div className="table-responsive">
        <table className="table mb-0 align-middle">
          <thead>
            <tr>
              <th>Data</th>
              <th>Servizi</th>
              <th>Operatore</th>
              <th className="text-end">Subtotale</th>
              <th className="text-end">Sconto</th>
              <th className="text-end">Netto</th>
              <th>Stato</th>
              <th className="text-end">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-muted p-3">
                  Nessun appuntamento.
                </td>
              </tr>
            ) : (
              rows.map((a) => (
                <tr key={a.id}>
                  <td className="text-muted">{fmtDateTime(a.startsAt)}</td>
                  <td>{a.serviceNames}</td>
                  <td className="text-muted">{a.staffNames !== "" ? a.staffNames : "—"}</td>
                  <td className="text-end text-muted">€ {fmtMoney(a.subtotal)}</td>
                  <td className="text-end text-muted">{a.discountAmount > 0 ? <>- € {fmtMoney(a.discountAmount)}</> : "—"}</td>
                  <td className="text-end fw-semibold">€ {fmtMoney(a.totalNet)}</td>
                  <td>
                    <span className={`badge ${a.statusBadge}`}>{a.statusLabel}</span>
                  </td>
                  <td className="text-end">
                    <a className="btn btn-sm btn-outline-secondary" href={`/${encodeURIComponent(slug)}/appointments?action=edit&id=${a.id}`}>
                      Apri
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ClientHistoryContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clientId, setClientId] = useState(0);
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = clientIdFromUrl();
    if (id > 0) setClientId(id);
    else {
      setError("Cliente non valido.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=history&id=${clientId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: HistoryPayload) => {
        if (!active) return;
        if (j && j.ok && j.client) {
          setData(j);
          setError("");
        } else {
          setError(j?.error || "Cliente non trovato.");
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento dello storico.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId, slug]);

  const s = data?.summary;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Scheda cliente</div>
          <h1 className="bs-page-title">Storico</h1>
          <div className="bs-page-subtitle">
            {data?.client ? `${data.client.name}${data.client.email ? ` · ${data.client.email}` : ""}` : "Storico appuntamenti, vendite e residui del cliente."}
          </div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients?action=view&id=${clientId}`}>
            <i className="bi bi-arrow-left me-1" />
            Indietro
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : data ? (
        <>
          {/* Summary */}
          <div className="row g-3">
            <div className="col-6 col-lg">
              <div className="card p-3 h-100">
                <div className="text-muted small">Totale appuntamenti</div>
                <div className="h4 mb-0 fw-bold">{s?.total ?? 0}</div>
              </div>
            </div>
            <div className="col-6 col-lg">
              <div className="card p-3 h-100">
                <div className="text-muted small">Completati</div>
                <div className="h4 mb-0 fw-bold text-success">{s?.done ?? 0}</div>
              </div>
            </div>
            <div className="col-6 col-lg">
              <div className="card p-3 h-100">
                <div className="text-muted small">Prenotati</div>
                <div className="h4 mb-0 fw-bold text-primary">{(s?.scheduled ?? 0) + (s?.pending ?? 0)}</div>
              </div>
            </div>
            <div className="col-6 col-lg">
              <div className="card p-3 h-100">
                <div className="text-muted small">Annullati</div>
                <div className="h4 mb-0 fw-bold text-danger">{s?.canceled ?? 0}</div>
              </div>
            </div>
            <div className="col-12 col-lg">
              <div className="card p-3 h-100">
                <div className="text-muted small">Ultima / Prossima visita</div>
                <div className="small">
                  <div>Ultima: {fmtDateTime(s?.lastVisit ?? null)}</div>
                  <div>Prossima: {fmtDateTime(s?.nextVisit ?? null)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Appointments per status */}
          <ApptTable title="Prenotati" rows={data.scheduledAppts ?? []} />
          <ApptTable title="Completati" rows={data.doneAppts ?? []} />
          <ApptTable title="Annullati" rows={data.canceledAppts ?? []} />

          {/* Residui attivi */}
          <div className="row g-3 mt-1">
            <div className="col-lg-4">
              <div className="card h-100">
                <div className="card-header fw-semibold">
                  <i className="bi bi-box-seam me-2" />
                  Pacchetti attivi
                </div>
                <div className="card-body">
                  {(data.packages ?? []).length === 0 ? (
                    <div className="text-muted small">Nessun pacchetto attivo.</div>
                  ) : (
                    (data.packages ?? []).map((p, i) => (
                      <div key={i} className="border rounded p-2 mb-2">
                        <div className="fw-semibold">{p.package_name}</div>
                        <div className="small text-muted">
                          Sessioni: {p.sessions_remaining}/{p.sessions_total}
                          {p.expires_at ? ` · scade ${fmtDate(p.expires_at)}` : ""}
                        </div>
                        {p.breakdown ? <div className="small text-muted">{p.breakdown}</div> : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="card h-100">
                <div className="card-header fw-semibold">
                  <i className="bi bi-gift me-2" />
                  GiftBox attive
                </div>
                <div className="card-body">
                  {(data.giftboxes ?? []).length === 0 ? (
                    <div className="text-muted small">Nessuna GiftBox attiva.</div>
                  ) : (
                    (data.giftboxes ?? []).map((g, i) => (
                      <div key={i} className="border rounded p-2 mb-2">
                        <div className="fw-semibold">{g.giftbox_name}</div>
                        <div className="small text-muted">
                          {g.code} · {g.remaining_qty}/{g.total_qty}
                          {g.expires_at ? ` · scade ${fmtDate(g.expires_at)}` : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="card h-100">
                <div className="card-header fw-semibold">
                  <i className="bi bi-credit-card me-2" />
                  GiftCard attive
                </div>
                <div className="card-body">
                  {(data.giftcards ?? []).length === 0 ? (
                    <div className="text-muted small">Nessuna GiftCard attiva.</div>
                  ) : (
                    (data.giftcards ?? []).map((g, i) => (
                      <div key={i} className="border rounded p-2 mb-2">
                        <div className="fw-semibold">{g.code}</div>
                        <div className="small text-muted">
                          Saldo € {fmtMoney(g.balance)}
                          {g.expires_at ? ` · scade ${fmtDate(g.expires_at)}` : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Preventivi */}
          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-file-earmark-text me-2" />
              Preventivi
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Numero</th>
                    <th>Data</th>
                    <th>Valido fino</th>
                    <th className="text-end">Totale</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.quotes ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-muted p-3">
                        Nessun preventivo.
                      </td>
                    </tr>
                  ) : (
                    (data.quotes ?? []).map((q) => (
                      <tr key={q.id}>
                        <td className="fw-semibold">{q.number || `#${q.id}`}</td>
                        <td className="text-muted">{fmtDate(q.quoteDate)}</td>
                        <td className="text-muted">{fmtDate(q.validUntil)}</td>
                        <td className="text-end">€ {fmtMoney(q.total)}</td>
                        <td className="text-muted">{q.status || "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Storico vendite */}
          <div className="card mt-3 mb-4">
            <div className="card-header d-flex align-items-center justify-content-between">
              <div className="fw-semibold">
                <i className="bi bi-receipt me-2" />
                Storico vendite
              </div>
              <div className="text-muted small">Totale: € {fmtMoney(data.salesTotal ?? 0)}</div>
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Acquistato</th>
                    <th className="text-end">Totale</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.sales ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-muted p-3">
                        Nessuna vendita.
                      </td>
                    </tr>
                  ) : (
                    (data.sales ?? []).map((sale) => (
                      <tr key={sale.id}>
                        <td className="text-muted">{fmtDateTime(sale.saleDate)}</td>
                        <td>{sale.purchasedItem}</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(sale.total)}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" href={`/${encodeURIComponent(slug)}/pos_sale_detail?id=${sale.id}`}>
                            Dettaglio
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
