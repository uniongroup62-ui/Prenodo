"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP giftcard LIST (app/pages/giftcard.php action=list):
// filtri Mittente / Cerca / Stato (+ "Tutte le sedi" per i tenant multi-sede),
// tabella Codice | Mittente | Destinatario | [Sede] | Iniziale | Saldo | Stato |
// Emessa | Scadenza | Azioni con badge legacy (Attiva/Riscattata/Scaduta/
// Annullata) e Codice linkato al voucher pubblico. La creazione avviene SOLO da
// Pagamenti (bottone "Crea GiftCard" → pos), come il legacy.

type Row = {
  id: number;
  code: string;
  publicToken: string;
  senderId: number;
  senderName: string;
  recipientName: string;
  recipientEmail: string;
  locationName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedAt: string;
  expiresAt: string;
  initialAmount: number;
  balance: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function GiftcardContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [rows, setRows] = useState<Row[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [locationsCount, setLocationsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  // Filtri legacy (form GET): applicati al submit "Filtra".
  const [clientFilter, setClientFilter] = useState(0);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [allLocations, setAllLocations] = useState(false);
  const [applied, setApplied] = useState({ clientFilter: 0, q: "", statusFilter: "" });

  const load = useCallback((all?: boolean) => {
    setLoading(true);
    fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=manage_list${all ? "&all_locations=1" : ""}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setRows(Array.isArray(j.rows) ? j.rows : []);
        setTotalCount(Number(j.totalCount ?? 0));
        setLocationsCount(Number(j.locationsCount ?? 0));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${suffix.replace("&", "?")}`;
  }
  function voucherHref(r: Row): string {
    return `/${encodeURIComponent(slug)}/giftcard_voucher?public=1&embed=1&token=${encodeURIComponent(r.publicToken)}`;
  }

  const senderOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of rows) if (r.senderId > 0 && !seen.has(r.senderId)) seen.set(r.senderId, r.senderName);
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = applied.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (applied.clientFilter > 0 && r.senderId !== applied.clientFilter) return false;
      if (applied.statusFilter !== "" && r.status !== applied.statusFilter) return false;
      if (needle !== "" && !`${r.code} ${r.recipientName} ${r.recipientEmail} ${r.senderName}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, applied]);

  const hasAny = totalCount > 0;
  const showEmptyState = !loading && !hasAny;
  const showLocationCol = rows.some((r) => r.locationName !== "") || locationsCount > 1;
  const colCount = showLocationCol ? 10 : 9;

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
            {hasAny ? (
              <a className="btn btn-primary btn-pill" href={href("pos")}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftCard
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {showEmptyState ? (
        <div className="card border-0 shadow-sm giftcard-empty-card">
          <div className="giftcard-empty-state">
            <div className="giftcard-empty-icon" aria-hidden="true">
              <i className="bi bi-credit-card-2-front" />
            </div>
            <h2>Nessuna GiftCard presente</h2>
            <p>Le GiftCard emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario, saldo, scadenze, riscatti e sede di emissione.</p>
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
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied({ clientFilter, q, statusFilter });
                load(allLocations);
              }}
            >
              <div className="col-lg-3">
                <label className="form-label small">Mittente</label>
                <select className="form-select" value={String(clientFilter)} onChange={(e) => setClientFilter(Number(e.target.value) || 0)}>
                  <option value="0">Tutti</option>
                  {senderOptions.map(([id, name]) => (
                    <option value={id} key={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-lg-3">
                <label className="form-label small">Cerca</label>
                <input className="form-control" name="q" placeholder="Codice, destinatario..." value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="col-lg-2">
                <label className="form-label small">Stato</label>
                <select className="form-select" name="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tutti</option>
                  <option value="active">Attiva</option>
                  <option value="redeemed">Riscattata</option>
                  <option value="expired">Scaduta</option>
                  <option value="cancelled">Annullata</option>
                </select>
              </div>
              {locationsCount > 1 ? (
                <div className="col-lg-2 d-flex align-items-center">
                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="giftcardAllLocations"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="giftcardAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                </div>
              ) : null}
              <div className="col-lg-2 d-flex align-items-end gap-2">
                <button className="btn btn-outline-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Codice</th>
                    <th>Mittente</th>
                    <th>Destinatario</th>
                    {showLocationCol ? <th>Sede</th> : null}
                    <th className="text-end">Iniziale</th>
                    <th className="text-end">Saldo</th>
                    <th>Stato</th>
                    <th>Emessa</th>
                    <th>Scadenza</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={colCount} className="text-muted small p-3">
                        Caricamento…
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={colCount} className="text-muted p-3">
                        Nessuna GiftCard trovata con i filtri selezionati.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((r) => (
                      <tr key={r.id}>
                        <td className="fw-semibold">
                          <a href={voucherHref(r)} target="_blank" rel="noopener">
                            {r.code}
                          </a>
                        </td>
                        <td className="text-muted">{r.senderName}</td>
                        <td className="text-muted">{r.recipientName}</td>
                        {showLocationCol ? <td className="text-muted">{r.locationName || "—"}</td> : null}
                        <td className="text-end">€ {fmtMoney(r.initialAmount)}</td>
                        <td className="text-end">€ {fmtMoney(r.balance)}</td>
                        <td>
                          <span className={`badge ${r.statusBadge}`}>{r.statusLabel}</span>
                        </td>
                        <td className="text-muted">{r.issuedAt || "—"}</td>
                        <td className="text-muted">{r.expiresAt || "—"}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" title="Voucher" target="_blank" rel="noopener" href={voucherHref(r)}>
                            <i className="bi bi-printer" />
                          </a>{" "}
                          <a className="btn btn-sm btn-outline-secondary" href={href(`giftcard&action=edit&id=${r.id}`)}>
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
      )}
    </div>
  );
}
