"use client";

import { useEffect, useState } from "react";

// Port fedele di pos_success.php: la pagina dedicata "Vendita completata" raggiunta
// dal redirect post-Concludi della cassa (legacy: redirect('index.php?page=pos_success
// &id=N')). Header con azioni contestuali (Nuova vendita / Apri in Movimenti / Apri
// Pacchetto / Apri GiftCard / Apri GiftBox / Ricariche cliente / Stampa), alert di
// conferma (solo arrivando dalla cassa, ?flash=1 — l'equivalente del flash di sessione
// legacy), Riepilogo articoli + Note, Totali con breakdown sconti, blocco Fidelity e
// card Cliente. Dati da GET /api/manage/pos?action=sale_success&id=N.

type PosSuccessItem = {
  id: number;
  type: string;
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  status: string;
};

type PosSuccessData = {
  ok?: boolean;
  error?: string;
  saleId: number;
  saleDate: string;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  items: PosSuccessItem[];
  notesClean: string;
  subtotal: number;
  total: number;
  totals: {
    hasDiscountRow: boolean;
    discountTotal: number;
    showBaseDiscountLine: boolean;
    baseDiscountLabel: string;
    baseDiscountResidual: number;
    discountDetails: Array<{ label: string; amount: number | null }>;
    fidUsed: number;
    fidEarn: number;
    fidDisc: number;
    giftcardUsed: number | null;
    giftcardCode: string;
    creditUsed: number | null;
  };
  giftcards: Array<{ id: number; code: string; recipientEmail: string; scheduledSendOn: string }>;
  giftbox: { id: number; code: string; recipientEmail: string; scheduledSendOn: string } | null;
  clientPackages: Array<{ id: number; name: string; status: string; sessionsTotal: number; sessionsRemaining: number }>;
  hasRecharge: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function saleIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const id = new URLSearchParams(window.location.search).get("id");
  const n = Number(id ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function flashFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("flash") === "1";
}

function fmtMoney(value: number): string {
  return Number(value || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// fmt_points legacy: intero quando possibile, altrimenti 2 decimali it-IT.
function fmtPoints(value: number): string {
  const v = Number(value || 0);
  if (Math.abs(v - Math.round(v)) < 0.005) return String(Math.round(v));
  return v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// dd/mm/YYYY HH:mm dal timestamp ISO (formato subtitle legacy).
function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateOnly(ymd: string): string {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

// Badge stato riga (pos_success.php _pos_succ_item_status_badge): solo servizi/prodotti
// con item_id reale — Eseguito/Prepagato (servizi), Ritirato/Ordinato (prodotti).
function itemStatusBadge(item: PosSuccessItem): { cls: string; label: string } | null {
  if (item.refId <= 0) return null;
  if (item.type === "service" || item.type === "prepaid") {
    if (item.status === "executed") return { cls: "text-bg-success", label: "Eseguito" };
    if (item.status === "prepaid") return { cls: "text-bg-info", label: "Prepagato" };
    return null;
  }
  if (item.type === "product") {
    if (item.status === "collected") return { cls: "text-bg-success", label: "Ritirato" };
    if (item.status === "ordered") return { cls: "text-bg-warning", label: "Ordinato" };
    return null;
  }
  return null;
}

// Sub-riga "{item_type} • ID n" legacy: i voucher/ricariche sono item_type 'product'
// nel DB (senza id), i prepagati 'service' — come li mostra il PHP.
function itemDbType(item: PosSuccessItem): string {
  if (item.type === "prepaid") return "service";
  if (item.type === "giftcard" || item.type === "giftbox" || item.type === "recharge") return "product";
  return item.type;
}

export function PosSuccessContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();
  const base = `/${encodeURIComponent(slug)}`;
  const [saleId] = useState<number>(() => saleIdFromUrl());
  const [flash] = useState<boolean>(() => flashFromUrl());
  const [data, setData] = useState<PosSuccessData | null>(null);
  const [loading, setLoading] = useState(() => saleIdFromUrl() > 0);
  const [error, setError] = useState(() => (saleIdFromUrl() > 0 ? "" : "Vendita non valida."));

  useEffect(() => {
    if (saleId <= 0) return;
    let active = true;
    fetch(`/api/manage/pos?slug=${encodeURIComponent(slug)}&action=sale_success&id=${saleId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: PosSuccessData) => {
        if (!active) return;
        if (j?.ok === false || j?.error) {
          setError(String(j?.error || "Non riesco a caricare i dettagli della vendita."));
        } else {
          setData(j);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Non riesco a caricare i dettagli della vendita.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [saleId, slug]);

  // ---- Stato "Vendita non trovata" (pos_success.php 524-547) ----
  if (!loading && (error || !data)) {
    return (
      <>
        <link rel="stylesheet" href="/assets/css/pages/pos_success.css" />
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Pagamenti</div>
            <h1 className="bs-page-title">Vendita non trovata</h1>
            <div className="bs-page-subtitle">ID: {saleId || "—"}</div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary" href={`${base}/pos`}>
                <i className="bi bi-credit-card me-1"></i>Torna a Pagamenti
              </a>
              <a className="btn btn-primary" href={`${base}/pos_history`}>
                <i className="bi bi-clock-history me-1"></i>Apri Movimenti
              </a>
            </div>
          </div>
        </div>
        <div className="alert alert-danger">
          Non riesco a caricare i dettagli della vendita.
          {error && error !== "Non riesco a caricare i dettagli della vendita." ? (
            <div className="small mt-1">
              <code>{error}</code>
            </div>
          ) : null}
        </div>
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        <link rel="stylesheet" href="/assets/css/pages/pos_success.css" />
        <div className="text-muted p-3">Caricamento…</div>
      </>
    );
  }

  const dtFmt = fmtDateTime(data.saleDate);
  const subtitle = `ID vendita #${data.saleId}${dtFmt ? ` - ${dtFmt}` : ""}`;
  const t = data.totals;
  const gcCodes = data.giftcards.map((gc) => gc.code).filter(Boolean);

  return (
    <>
      <link rel="stylesheet" href="/assets/css/pages/pos_success.css" />

      {/* pageHeader legacy: 'Vendita completata', 'Pagamenti', 'ID vendita #N - data',
          azioni contestuali (pos_success.php 715-746). */}
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pagamenti</div>
          <h1 className="bs-page-title">Vendita completata</h1>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={`${base}/pos`}>
              <i className="bi bi-plus-lg me-1"></i>Nuova vendita
            </a>
            <a className="btn btn-outline-primary" href={`${base}/pos_sale_detail?id=${data.saleId}`}>
              <i className="bi bi-clock-history me-1"></i>Apri in Movimenti
            </a>
            {data.clientPackages.length > 0 ? (
              <a className="btn btn-outline-success" href={`${base}/packages?tab=clients&action=client_view&id=${data.clientPackages[0].id}`}>
                <i className="bi bi-box-seam me-1"></i>Apri Pacchetto{data.clientPackages.length > 1 ? ` (${data.clientPackages.length})` : ""}
              </a>
            ) : null}
            {data.giftcards.length > 0 ? (
              <a className="btn btn-success" href={`${base}/giftcard?action=edit&id=${data.giftcards[0].id}`}>
                <i className="bi bi-gift me-1"></i>Apri GiftCard{data.giftcards.length > 1 ? ` (${data.giftcards.length})` : ""}
              </a>
            ) : null}
            {data.giftbox ? (
              <a className="btn btn-success" href={`${base}/giftbox?tab=instances&action=edit_instance&id=${data.giftbox.id}`}>
                <i className="bi bi-gift me-1"></i>Apri GiftBox
              </a>
            ) : null}
            {data.hasRecharge && data.clientId > 0 ? (
              <a className="btn btn-outline-info" href={`${base}/recharges?client_id=${data.clientId}`}>
                <i className="bi bi-wallet2 me-1"></i>Ricariche cliente
              </a>
            ) : null}
            <button className="btn btn-primary" type="button" onClick={() => { try { window.print(); } catch { /* no-op */ } }}>
              <i className="bi bi-printer me-1"></i>Stampa
            </button>
          </div>
        </div>
      </div>

      {/* Alert flash legacy ($_SESSION['pos_last_success']): mostrato solo arrivando
          dal Concludi della cassa (?flash=1). */}
      {flash ? (
        <div className="alert alert-success">
          <div className="fw-semibold">Operazione completata con successo.</div>
          <div className="small mt-1">
            Vendita registrata (ID {data.saleId})
            {data.giftbox ? <> • GiftBox emessa ({data.giftbox.code})</> : null}
            {gcCodes.length > 0 ? <> • GiftCard emessa ({gcCodes.join(", ")})</> : null}
            {data.giftbox?.recipientEmail ? (
              data.giftbox.scheduledSendOn ? (
                <> • Email programmata per {fmtDateOnly(data.giftbox.scheduledSendOn)} a {data.giftbox.recipientEmail}</>
              ) : (
                <> • Email destinatario: {data.giftbox.recipientEmail}</>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card p-3">
            <div className="d-flex justify-content-between align-items-center">
              <div className="h5 mb-0">Riepilogo articoli</div>
              <div className="text-muted small">{data.items.length} righe</div>
            </div>
            <div className="table-responsive mt-3">
              <table className="table align-middle">
                <thead>
                  <tr>
                    <th>Elemento</th>
                    <th className="text-end pos-success-qty-col">Q.tà</th>
                    <th className="text-end pos-success-money-col">Prezzo</th>
                    <th className="text-end pos-success-money-col">Totale</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-muted">
                        Nessun dettaglio righe disponibile.
                      </td>
                    </tr>
                  ) : (
                    data.items.map((it) => {
                      const badge = itemStatusBadge(it);
                      return (
                        <tr key={it.id}>
                          <td>
                            <div className="fw-semibold">
                              {it.name}{" "}
                              {badge ? <span className={`badge rounded-pill ${badge.cls}`}>{badge.label}</span> : null}
                            </div>
                            <div className="text-muted small">
                              {itemDbType(it)}
                              {it.refId > 0 ? <> • ID {it.refId}</> : null}
                            </div>
                          </td>
                          <td className="text-end">{it.quantity}</td>
                          <td className="text-end">€ {fmtMoney(it.unitPrice)}</td>
                          <td className="text-end fw-semibold">€ {fmtMoney(it.total)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {data.notesClean ? (
              <div className="mt-3">
                <div className="fw-semibold">Note</div>
                <div className="text-muted pos-success-notes">{data.notesClean}</div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card p-3">
            <div className="h5 mb-3">Totali</div>
            <div className="d-flex justify-content-between">
              <div className="text-muted">Subtotale</div>
              <div>€ {fmtMoney(data.subtotal)}</div>
            </div>
            {t.hasDiscountRow ? (
              <div className="d-flex justify-content-between mt-2">
                <div className="text-muted">Sconti</div>
                <div className="text-danger">- € {fmtMoney(t.discountTotal)}</div>
              </div>
            ) : null}

            {t.hasDiscountRow ? (
              <ul className="list-unstyled small text-muted mt-2 mb-0">
                {t.showBaseDiscountLine ? (
                  <li className="d-flex justify-content-between gap-3">
                    <span>{t.baseDiscountLabel}</span>
                    <span className="text-danger">- € {fmtMoney(t.baseDiscountResidual)}</span>
                  </li>
                ) : null}
                {t.discountDetails.length > 0 ? (
                  <li className={`${t.showBaseDiscountLine ? "mt-1 " : ""}pos-success-discount-item`}>
                    <ul className="list-unstyled mb-0 pos-success-discount-list">
                      {t.discountDetails.map((dd, index) => (
                        <li className="d-flex justify-content-between gap-3" key={`${dd.label}-${index}`}>
                          <span>{dd.label}</span>
                          <span className="text-danger">{dd.amount === null ? "—" : <>- € {fmtMoney(dd.amount)}</>}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null}
                {t.fidDisc > 0.00001 ? (
                  <li className="d-flex justify-content-between gap-3 mt-1">
                    <span>Punti Fidelity{t.fidUsed > 0.00001 ? ` (${fmtPoints(t.fidUsed)})` : ""}</span>
                    <span className="text-danger">- € {fmtMoney(t.fidDisc)}</span>
                  </li>
                ) : null}
              </ul>
            ) : null}

            {t.giftcardUsed !== null && t.giftcardUsed > 0.00001 ? (
              <div className="d-flex justify-content-between mt-2">
                <div className="text-muted">GiftCard utilizzata{t.giftcardCode ? ` (${t.giftcardCode})` : ""}</div>
                <div className="text-danger">- € {fmtMoney(t.giftcardUsed)}</div>
              </div>
            ) : null}

            {t.creditUsed !== null && t.creditUsed > 0.00001 ? (
              <div className="d-flex justify-content-between mt-2">
                <div className="text-muted">Credito utilizzato</div>
                <div className="text-danger">- € {fmtMoney(t.creditUsed)}</div>
              </div>
            ) : null}

            <hr />

            <div className="d-flex justify-content-between">
              <div className="fw-semibold">Totale</div>
              <div className="fw-semibold">€ {fmtMoney(data.total)}</div>
            </div>

            {t.fidUsed > 0.00001 || t.fidEarn > 0.00001 ? (
              <>
                <hr />
                <div className="h6 mb-2">Fidelity</div>
                {t.fidUsed > 0.00001 ? (
                  <div className="d-flex justify-content-between">
                    <div className="text-muted">Punti usati</div>
                    <div>- {fmtPoints(t.fidUsed)}</div>
                  </div>
                ) : null}
                {t.fidEarn > 0.00001 ? (
                  <div className="d-flex justify-content-between mt-2">
                    <div className="text-muted">Punti guadagnati</div>
                    <div>+ {fmtPoints(t.fidEarn)}</div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="card p-3 mt-3">
            <div className="h5 mb-3">Cliente</div>
            <div className="fw-semibold">{data.clientName || "—"}</div>
            {data.clientId > 0 ? <div className="text-muted small">ID: {data.clientId}</div> : null}

            {data.clientEmail ? (
              <div className="mt-2">
                <span className="text-muted">Email:</span> {data.clientEmail}
              </div>
            ) : null}
            {data.clientPhone ? (
              <div className="mt-1">
                <span className="text-muted">Telefono:</span> {data.clientPhone}
              </div>
            ) : null}

            {data.clientId > 0 ? (
              <div className="mt-3">
                <a className="btn btn-outline-secondary w-100" href={`${base}/clients?action=view&id=${data.clientId}`}>
                  <i className="bi bi-person me-1"></i>Apri scheda cliente
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
