"use client";

import { useEffect, useState } from "react";
import { ClientSearchCombobox } from "@/components/client-search-combobox";

// Port fedele della LISTA GiftCard (app/pages/giftcard.php action=list):
// filtri SERVER-SIDE Mittente (combobox ricercabile con tutti i clienti) /
// Cerca (codice, destinatario, email) / Stato (+ Tutte le sedi multi-sede con
// filtro sede STRETTO), expire-due + invii programmati al load, tabella
// Codice | Mittente | Destinatario | Sede | Iniziale | Saldo | Stato | Emessa
// | Scadenza | Azioni con date raw (YYYY-MM-DD), € fmt_money e Codice ->
// voucher manage (?id=&embed=1). action=new -> lista con il flash legacy
// 'Per creare una GiftCard vai in "Pagamenti"...'. La creazione avviene SOLO
// da Pagamenti (header [Torna alla lista][Crea GiftCard pos.manage]).

type GiftcardQuery = {
  action?: string;
  q?: string;
  status?: string;
  client_id?: string;
  all_locations?: string;
  p?: string;
  msg?: string;
  err?: string;
};

// Badge 'Scade tra N giorni' (miglioria 2026-07-17, come GiftBox/Pacchetti):
// card ATTIVA con scadenza entro 14 giorni. expiresDate = YYYY-MM-DD ('—' se assente).
export function giftcardExpiryWarning(expiresDate: string, status: string): string | null {
  if (status !== "active") return null;
  const m = String(expiresDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((exp.getTime() - today.getTime()) / 86400000);
  if (days < 0 || days > 14) return null;
  if (days === 0) return "Scade oggi";
  if (days === 1) return "Scade domani";
  return `Scade tra ${days} giorni`;
}

type Row = {
  id: number;
  code: string;
  senderId: number;
  senderName: string;
  recipientName: string;
  locationLabel: string;
  initialAmount: number;
  balance: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedDate: string;
  expiresDate: string;
};

type ListPayload = {
  ok?: boolean;
  rows?: Row[];
  totalCount?: number;
  pageSize?: number;
  currentPage?: number;
  hasAnyGiftCards?: boolean;
  selectedClientLabel?: string;
  showAllLocationsFilter?: boolean;
  canCreate?: boolean;
  canSettings?: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// fmt_money legacy: 2 decimali, virgola, punto per le migliaia.
function fmtMoney(v: number): string {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}


export function GiftcardContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftcardQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  // Filtri applicati (form GET legacy: il submit naviga con i parametri).
  const [applied] = useState(() => ({
    clientId: String(initialQuery?.client_id ?? "0") || "0",
    q: String(initialQuery?.q ?? ""),
    status: String(initialQuery?.status ?? ""),
    allLocations: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").toLowerCase()),
    page: (() => { const n = Number.parseInt(String(initialQuery?.p ?? ""), 10); return Number.isFinite(n) && n >= 1 ? n : 1; })(),
  }));

  const [data, setData] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState(applied.clientId);
  const [q, setQ] = useState(applied.q);
  const [statusFilter, setStatusFilter] = useState(applied.status);
  const [allLocations, setAllLocations] = useState(applied.allLocations);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect;
  // action=new -> messaggio legacy "vai in Pagamenti".
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({
    msg: initialQuery?.msg ?? (initialQuery?.action === "new" ? 'Per creare una GiftCard vai in "Pagamenti" e usa il pulsante GiftCard.' : undefined),
    err: initialQuery?.err,
  }));

  useEffect(() => {
    const params = new URLSearchParams({ slug, action: "manage_list" });
    if (applied.clientId !== "0") params.set("client_id", applied.clientId);
    if (applied.q !== "") params.set("q", applied.q);
    if (applied.status !== "") params.set("status", applied.status);
    if (applied.allLocations) params.set("all_locations", "1");
    params.set("p", String(applied.page ?? 1));
    fetch(`/api/manage/giftcards?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ListPayload) => setData(j))
      .catch(() => setData({ rows: [], hasAnyGiftCards: false }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function href(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (clientFilter !== "" && clientFilter !== "0") params.set("client_id", clientFilter);
    if (q !== "") params.set("q", q);
    if (statusFilter !== "") params.set("status", statusFilter);
    if (allLocations) params.set("all_locations", "1");
    const qs = params.toString();
    window.location.href = href(`giftcard${qs !== "" ? `?${qs}` : ""}`);
  }

  // Cambio pagina: navigazione GET coi filtri applicati (?p=), come il submit.
  function goToPage(pageN: number) {
    const params = new URLSearchParams();
    if (applied.clientId !== "" && applied.clientId !== "0") params.set("client_id", applied.clientId);
    if (applied.q !== "") params.set("q", applied.q);
    if (applied.status !== "") params.set("status", applied.status);
    if (applied.allLocations) params.set("all_locations", "1");
    if (pageN > 1) params.set("p", String(Math.floor(pageN)));
    const qs = params.toString();
    window.location.assign(href(`giftcard${qs !== "" ? `?${qs}` : ""}`));
  }

  const rows = data?.rows ?? [];
  const hasAny = data?.hasAnyGiftCards ?? false;
  const showEmptyState = !loading && !hasAny;
  const canCreate = data?.canCreate ?? false;
  const canSettings = data?.canSettings ?? false;
  const showAllLocationsFilter = data?.showAllLocationsFilter ?? false;

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
            {canCreate && !showEmptyState ? (
              <a className="btn btn-primary btn-pill" href={href("pos")}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftCard
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

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : showEmptyState ? (
        <div className="card border-0 shadow-sm giftcard-empty-card">
          <div className="giftcard-empty-state">
            <div className="giftcard-empty-icon" aria-hidden="true">
              <i className="bi bi-credit-card-2-front" />
            </div>
            <h2>Nessuna GiftCard presente</h2>
            <p>Le GiftCard emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario, saldo, scadenze, riscatti e sede di emissione.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              {canCreate ? (
                <a className="btn btn-primary" href={href("pos")}>
                  <i className="bi bi-plus-lg me-1" />
                  Crea GiftCard
                </a>
              ) : null}
              {canSettings ? (
                <a className="btn btn-outline-secondary" href={href("giftcard_settings")}>
                  <i className="bi bi-gear me-1" />
                  Impostazioni
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form className="row g-2 align-items-end" method="get" onSubmit={applyFilters}>
              <div className="col-lg-3">
                <label className="form-label">Mittente</label>
                <ClientSearchCombobox
                  value={clientFilter}
                  initialLabel={data?.selectedClientLabel ?? ""}
                  searchUrl={(qq) => `/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=client_search&q=${encodeURIComponent(qq)}`}
                  onChange={(id) => setClientFilter(id)}
                />
              </div>

              <div className="col-lg-3">
                <label className="form-label">Cerca</label>
                <input className="form-control" name="q" placeholder="Codice, destinatario..." value={q} onChange={(e) => setQ(e.target.value)} />
              </div>

              <div className={showAllLocationsFilter ? "col-lg-2" : "col-lg-3"}>
                <label className="form-label">Stato</label>
                <select className="form-select" name="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tutti</option>
                  <option value="active">Attiva</option>
                  <option value="redeemed">Riscattata</option>
                  <option value="expired">Scaduta</option>
                  <option value="cancelled">Annullata</option>
                </select>
              </div>

              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Filtra pieno a larghezza naturale, Reset
                  (prima assente) visibile solo con filtri attivi. */}
              {showAllLocationsFilter ? (
                <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail">
                  <div className="form-check form-switch mb-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="giftcardAllLocations"
                      name="all_locations"
                      value="1"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="giftcardAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                </div>
              ) : null}

              {/* col-auto: il bottone si accoda ai campi (leggero distacco ms-lg-2)
                  invece di galleggiare in una colonna fissa di griglia. */}
              <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail gap-2 ms-lg-2">
                <button className="btn btn-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {applied.clientId !== "0" || applied.q !== "" || applied.status !== "" || applied.allLocations ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={href("giftcard")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header bg-transparent py-2 d-flex align-items-center justify-content-between">
              <span className="text-muted small">
                {loading ? "Caricamento…" : (() => {
                  const total = Number(data?.totalCount ?? rows.length);
                  const pageSize = Math.max(1, Number(data?.pageSize ?? 25));
                  const totalPages = Math.max(1, Math.ceil(total / pageSize));
                  return `${total === 1 ? "1 GiftCard" : `${total} GiftCard`}${total > pageSize ? ` · pagina ${applied.page} di ${totalPages}` : ""}`;
                })()}
                {!loading && (applied.clientId !== "0" || applied.q !== "" || applied.status !== "" || applied.allLocations) ? " · filtri attivi" : ""}
              </span>
              {!loading && Number(data?.totalCount ?? 0) > Math.max(1, Number(data?.pageSize ?? 25)) ? (
                <div className="d-flex gap-1">
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={applied.page <= 1} onClick={() => goToPage(applied.page - 1)}>
                    <i className="bi bi-chevron-left" />
                  </button>
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={applied.page >= Math.ceil(Number(data?.totalCount ?? 0) / Math.max(1, Number(data?.pageSize ?? 25)))} onClick={() => goToPage(applied.page + 1)}>
                    <i className="bi bi-chevron-right" />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Codice</th>
                    <th>Mittente</th>
                    <th>Destinatario</th>
                    <th>Sede</th>
                    <th className="text-end">Iniziale</th>
                    <th className="text-end">Saldo</th>
                    <th>Stato</th>
                    <th>Emessa</th>
                    <th>Scadenza</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-semibold">
                        <a className="text-decoration-none" target="_blank" rel="noopener" href={href(`giftcard_voucher?id=${r.id}&embed=1`)} title="Apri voucher / stampa">
                          {r.code}
                        </a>
                      </td>
                      <td>{r.senderName}</td>
                      <td className="text-muted">{r.recipientName}</td>
                      <td className="text-muted">{r.locationLabel}</td>
                      <td className="text-end">€ {fmtMoney(r.initialAmount)}</td>
                      <td className="text-end fw-semibold">€ {fmtMoney(r.balance)}</td>
                      <td>
                        <span className={`badge bg-${r.statusBadge}`}>{r.statusLabel}</span>
                        {(() => {
                          const warn = giftcardExpiryWarning(r.expiresDate, r.status);
                          return warn ? <span className="badge text-bg-warning ms-1">{warn}</span> : null;
                        })()}
                      </td>
                      <td className="text-muted">{r.issuedDate}</td>
                      <td className="text-muted">{r.expiresDate}</td>
                      <td className="text-end">
                        <a
                          className="btn btn-sm btn-outline-secondary me-1"
                          target="_blank"
                          rel="noopener"
                          href={href(`giftcard_voucher?id=${r.id}&embed=1`)}
                          title="Voucher / stampa"
                        >
                          <i className="bi bi-printer" />
                        </a>
                        <a className="btn btn-sm btn-outline-secondary" href={href(`giftcard?action=edit&id=${r.id}`)}>
                          Dettaglio
                        </a>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-muted p-3">
                        Nessuna GiftCard trovata con i filtri selezionati.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
