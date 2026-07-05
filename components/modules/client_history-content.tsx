"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP client STORICO page (app/pages/clients.php
// action=history): card "Appuntamenti fissati" con il riepilogo nel card-header
// (Appuntamenti: N • Ultimo • Prossimo [• Vendite]), poi Eseguiti / Cancellati,
// Pacchetti attivi, GiftBox/GiftCard attive (solo destinatario), Preventivi e
// Storico vendite — tabelle e testi verbatim, bottoni "Apri" gated dai permessi.

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
type Quote = { id: number; number: string; quoteDate: string; validUntil: string; total: number; statusLabel: string; statusBadge: string };
type Pkg = { id: number; purchaseDate: string; packageName: string; serviceName: string; preview: string; sessionsRemaining: number; sessionsTotal: number; expiresAt: string; statusLabel: string; statusBadge: string };
type Gbox = { id: number; issuedAt: string; name: string; code: string; expiresAt: string; statusLabel: string; statusBadge: string };
type Gcard = { id: number; issuedAt: string; code: string; initialAmount: number; balance: number; expiresAt: string; statusLabel: string; statusBadge: string };

type HistoryPayload = {
  ok?: boolean;
  error?: string;
  client?: { id: number; name: string; email?: string };
  summary?: { total: number; done: number; scheduled: number; pending: number; canceled: number; lastVisit: string | null; nextVisit: string | null };
  scheduledAppts?: Appt[];
  doneAppts?: Appt[];
  canceledAppts?: Appt[];
  packages?: Pkg[];
  giftboxes?: Gbox[];
  giftcards?: Gcard[];
  quotes?: Quote[];
  sales?: Sale[];
  salesTotal?: number;
  perms?: {
    clientSheetsManage?: boolean;
    createAppointments?: boolean;
    openAppointments?: boolean;
    openPackages?: boolean;
    openGiftbox?: boolean;
    openGiftcard?: boolean;
    openQuotes?: boolean;
    openSales?: boolean;
  };
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

// Port of fmt_money(): number_format(n, 2, ',', '.').
function fmtMoney(n: number): string {
  const v = Number(n || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}
// d/m/Y H:i from "YYYY-MM-DD HH:MM[:SS]".
function fmtDateTime(v: string | null): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "—";
}
// d/m/Y from an ISO date prefix.
function fmtDate(v: string | null): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function OpenBtn({ href }: { href: string }) {
  return (
    <a className="btn btn-sm btn-outline-primary" href={href}>
      <i className="bi bi-box-arrow-up-right" /> Apri
    </a>
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

  // Microtask: evita il setState sincrono nell'effect (primo paint invariato).
  useEffect(() => {
    void Promise.resolve().then(() => {
      const id = clientIdFromUrl();
      if (id > 0) setClientId(id);
      else {
        setError("Cliente non valido.");
        setLoading(false);
      }
    });
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
          // Legacy: client_load_accessible fa redirect alla lista con l'errore.
          const msg = String(j?.error || "Cliente non trovato o non disponibile per le tue sedi.");
          window.location.href = `/${encodeURIComponent(slug)}/clients?err=${encodeURIComponent(msg)}`;
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

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  const s = data?.summary;
  const perms = data?.perms ?? {};
  const lastV = s?.lastVisit ? fmtDateTime(s.lastVisit) : "—";
  const nextV = s?.nextVisit ? fmtDateTime(s.nextVisit) : "—";
  const salesTotal = Number(data?.salesTotal ?? 0);

  // Le tre tabelle appuntamenti legacy: fissati/cancellati con Totale, eseguiti senza.
  function apptRows(rows: Appt[], withTotal: boolean, emptyText: string, colSpan: number) {
    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={colSpan} className="text-muted p-3">
            {emptyText}
          </td>
        </tr>
      );
    }
    return rows.map((a) => (
      <tr key={a.id}>
        <td>{fmtDateTime(a.startsAt)}</td>
        <td>
          <div className="fw-semibold">{a.serviceNames || "—"}</div>
        </td>
        <td className="text-muted">{a.staffNames !== "" ? a.staffNames : "—"}</td>
        {withTotal ? <td className="text-end fw-semibold">€ {fmtMoney(a.totalNet)}</td> : null}
        <td>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <span className={`badge text-bg-${a.statusBadge}`}>{a.statusLabel}</span>
            {perms.openAppointments !== false ? <OpenBtn href={page(`appointments&action=edit&id=${a.id}`)} /> : null}
          </div>
        </td>
      </tr>
    ));
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Scheda cliente</div>
          <h1 className="bs-page-title">Storico</h1>
          <div className="bs-page-subtitle">
            {data?.client ? `${data.client.name} - ${data.client.email || "-"}` : "-"}
          </div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={page(`clients&action=view&id=${clientId}`)}>
            <i className="bi bi-arrow-left me-1" />
            Indietro
          </a>
          {perms.clientSheetsManage !== false ? (
            <a className="btn btn-outline-primary" href={page(`client_sheets&client_id=${clientId}`)}>
              <i className="bi bi-journals me-1" />
              Compilazioni
            </a>
          ) : null}
          {perms.createAppointments !== false ? (
            <a className="btn btn-primary" href={page("calendar")}>
              <i className="bi bi-calendar-plus me-1" />
              Nuovo appuntamento
            </a>
          ) : null}
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : data ? (
        <>
          <div className="card">
            <div className="card-header">
              <div className="fw-semibold">
                <i className="bi bi-calendar-check me-2" />
                Appuntamenti fissati
              </div>
              <div className="small text-muted mt-1">
                Appuntamenti: {s?.total ?? 0} • Ultimo: {lastV} • Prossimo: {nextV}
                {salesTotal > 0 ? (
                  <>
                    {" "}
                    • Vendite: <span className="fw-semibold">€ {fmtMoney(salesTotal)}</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Servizi</th>
                    <th>Operatore</th>
                    <th className="text-end">Totale</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>{apptRows(data.scheduledAppts ?? [], true, "Nessun appuntamento fissato.", 5)}</tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-calendar2-check me-2" />
              Appuntamenti eseguiti
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Servizi</th>
                    <th>Operatore</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>{apptRows(data.doneAppts ?? [], false, "Nessun appuntamento eseguito.", 4)}</tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-calendar-x me-2" />
              Appuntamenti cancellati
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Servizi</th>
                    <th>Operatore</th>
                    <th className="text-end">Totale</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>{apptRows(data.canceledAppts ?? [], true, "Nessun appuntamento cancellato.", 5)}</tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-box-seam me-2" />
              Pacchetti attivi
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Acquisto</th>
                    <th>Pacchetto</th>
                    <th className="text-center">Residue</th>
                    <th>Scadenza</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.packages ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-muted p-3">
                        Nessun pacchetto attivo.
                      </td>
                    </tr>
                  ) : (
                    (data.packages ?? []).map((cp) => (
                      <tr key={cp.id}>
                        <td>{fmtDate(cp.purchaseDate)}</td>
                        <td>
                          <div className="fw-semibold">{cp.packageName}</div>
                          {cp.preview !== "" ? (
                            <div className="small text-muted">{cp.preview}</div>
                          ) : cp.serviceName !== "" ? (
                            <div className="small text-muted">{cp.serviceName}</div>
                          ) : null}
                        </td>
                        <td className="text-center fw-semibold">
                          {cp.sessionsRemaining} / {cp.sessionsTotal}
                        </td>
                        <td>{fmtDate(cp.expiresAt)}</td>
                        <td>
                          <div className="d-flex align-items-center gap-2 flex-wrap">
                            <span className={`badge text-bg-${cp.statusBadge}`}>{cp.statusLabel}</span>
                            {perms.openPackages !== false ? (
                              <OpenBtn href={page(`packages&tab=clients&action=client_view&id=${cp.id}`)} />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-gift me-2" />
              GiftBox attive
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Emissione</th>
                    <th>GiftBox</th>
                    <th>Codice</th>
                    <th>Scadenza</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.giftboxes ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-muted p-3">
                        Nessuna GiftBox attiva come destinatario.
                      </td>
                    </tr>
                  ) : (
                    (data.giftboxes ?? []).map((gb) => (
                      <tr key={gb.id}>
                        <td>{fmtDateTime(gb.issuedAt)}</td>
                        <td className="fw-semibold">{gb.name}</td>
                        <td>{gb.code}</td>
                        <td>{fmtDate(gb.expiresAt)}</td>
                        <td>
                          <div className="d-flex align-items-center gap-2 flex-wrap">
                            <span className={`badge text-bg-${gb.statusBadge}`}>{gb.statusLabel}</span>
                            {perms.openGiftbox !== false ? (
                              <OpenBtn href={page(`giftbox&tab=instances&action=edit_instance&id=${gb.id}`)} />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-credit-card-2-front me-2" />
              GiftCard attive
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Emissione</th>
                    <th>Codice</th>
                    <th className="text-end">Importo</th>
                    <th className="text-end">Saldo</th>
                    <th>Scadenza</th>
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.giftcards ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        Nessuna GiftCard attiva come destinatario.
                      </td>
                    </tr>
                  ) : (
                    (data.giftcards ?? []).map((gc) => (
                      <tr key={gc.id}>
                        <td>{fmtDateTime(gc.issuedAt)}</td>
                        <td className="fw-semibold">{gc.code}</td>
                        <td className="text-end">€ {fmtMoney(gc.initialAmount)}</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(gc.balance)}</td>
                        <td>{fmtDate(gc.expiresAt)}</td>
                        <td>
                          <div className="d-flex align-items-center gap-2 flex-wrap">
                            <span className={`badge text-bg-${gc.statusBadge}`}>{gc.statusLabel}</span>
                            {perms.openGiftcard !== false ? <OpenBtn href={page(`giftcard&action=edit&id=${gc.id}`)} /> : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-file-earmark-text me-2" />
              Preventivi
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Preventivo</th>
                    <th>Validità</th>
                    <th className="text-end">Totale</th>
                    <th>Stato</th>
                    <th>Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.quotes ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        Nessun preventivo.
                      </td>
                    </tr>
                  ) : (
                    (data.quotes ?? []).map((qt) => (
                      <tr key={qt.id}>
                        <td>{fmtDate(qt.quoteDate)}</td>
                        <td className="fw-semibold">{qt.number !== "" ? qt.number : `#${qt.id}`}</td>
                        <td>{fmtDate(qt.validUntil)}</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(qt.total)}</td>
                        <td>
                          <span className={`badge text-bg-${qt.statusBadge}`}>{qt.statusLabel}</span>
                        </td>
                        <td>
                          {perms.openQuotes !== false ? (
                            <OpenBtn href={page(`quotes&action=view&id=${qt.id}`)} />
                          ) : (
                            <span className="text-muted small">-</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header fw-semibold">
              <i className="bi bi-receipt me-2" />
              Storico vendite
            </div>
            <div className="table-responsive">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th className="text-end">Totale</th>
                    <th>Elemento acquistato</th>
                    <th>Azioni</th>
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
                        <td>{fmtDateTime(sale.saleDate)}</td>
                        <td className="text-end fw-semibold">€ {fmtMoney(sale.total)}</td>
                        <td className="text-muted">{sale.purchasedItem !== "" ? sale.purchasedItem : "—"}</td>
                        <td>
                          {perms.openSales !== false ? (
                            <OpenBtn href={page(`pos_sale_detail&id=${sale.id}`)} />
                          ) : (
                            <span className="text-muted small">-</span>
                          )}
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
