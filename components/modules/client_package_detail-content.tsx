"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP client-package DETAIL (packages.php action=client_view):
// card header (Pacchetto cliente / cliente linkato - Sede - Servizi/Contenuto -
// origine preventivo, badge stato + Dettaglio vendita + Modifica), alert
// riattivazione (contenuti eliminati/disattivati), riga Sedute totali/rimanenti
// (+ in sospeso)/Inizio/Scadenza con la matita → modale "Modifica scadenza
// pacchetto", tabella "Contenuto pacchetto" (multi o con prodotti), Note, il
// form "Registra seduta/ritiro" (Voce, Operazione Scala|Segna ritirato /
// Ripristina|Ripristina ritiro, qty+unità, Data/ora, Nota, Conferma) e la
// tabella Movimenti (Quando/Quantità/Tipo/Voce/Nota/Operatore) con le righe
// virtuali "In sospeso/Annullato su prenotazione #".

type ContentRow = { type: string; itemId: number; name: string; qtyTotal: number; qtyRemaining: number; reservedQty: number };
type UsageItem = { itemRef: string; type: string; itemId: number; label: string; qtyTotal: number; qtyRemaining: number; qtyRemainingBase: number; reservedQty: number; restoreAvailable: number; unitLabel: string; typeLabel: string };
type Movement = { id: number; usedAt: string; delta: number; unitLabel: string; movementType: string; itemLabel: string; note: string; createdByName: string };
type Issue = { type: string; label: string; message: string };

type Detail = {
  id: number;
  clientId: number;
  clientName: string;
  packageName: string;
  serviceName: string;
  locationLabel: string;
  contentSummary: string;
  contentHasProducts: boolean;
  isMulti: boolean;
  sessionsTotal: number;
  sessionsRemaining: number;
  reservedQty: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  purchaseDate: string;
  startDate: string;
  expiresAt: string;
  notes: string;
  saleId: number | null;
  sourceQuoteId: number | null;
  sourceQuoteNumber: string;
  contentRows: ContentRow[];
  usageItems: UsageItem[];
  movements: Movement[];
  availability: { errors: Issue[]; warnings: Issue[] };
  canEditExpiry: boolean;
  expiryEditLocked: boolean;
  expiryEditLockMessage: string;
  expiryMinDate: string;
};

type Perms = {
  openSaleDetail?: boolean;
  clientLinks?: boolean;
  quotesManage?: boolean;
};

export type ClientPackageDetailQuery = { msg?: string; err?: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function clientPackageIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// d/m/Y da prefisso ISO.
function fmtDate(v: string): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "-";
}
// d/m/Y H:i da "YYYY-MM-DD HH:MM[:SS]".
function fmtDateTime(v: string): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "—";
}
// Valore datetime-local "adesso" (dt_input_now legacy).
function dtInputNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ClientPackageDetailContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ClientPackageDetailQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [cpId, setCpId] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [perms, setPerms] = useState<Perms>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Form "Registra seduta/ritiro".
  const [usageItemRef, setUsageItemRef] = useState("");
  const [usageOp, setUsageOp] = useState<"consume" | "restore">("consume");
  const [usageQty, setUsageQty] = useState(1);
  const [usageUsedAt, setUsageUsedAt] = useState(() => dtInputNow());
  const [usageNote, setUsageNote] = useState("");

  // Modale "Modifica scadenza pacchetto".
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [expiryValue, setExpiryValue] = useState("");

  // Microtask: evita il setState sincrono nell'effect (primo paint invariato).
  useEffect(() => {
    void Promise.resolve().then(() => {
      const id = clientPackageIdFromUrl();
      if (id > 0) setCpId(id);
      else if (typeof window !== "undefined") {
        window.location.href = `/${encodeURIComponent(slug)}/packages?tab=clients&err=${encodeURIComponent("Pacchetto cliente non trovato")}`;
      }
    });
  }, [slug]);

  useEffect(() => {
    if (!cpId) return;
    let active = true;
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=client_view&id=${cpId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        if (j && j.ok && j.detail) {
          const d = j.detail as Detail;
          setData(d);
          if (j.perms) setPerms(j.perms as Perms);
          const first = d.usageItems[0];
          setUsageItemRef((prev) => (prev !== "" && d.usageItems.some((it) => it.itemRef === prev) ? prev : first?.itemRef ?? ""));
          const min = d.expiryMinDate;
          const value = d.expiresAt !== "" && d.expiresAt >= min ? d.expiresAt : min;
          setExpiryValue(value);
        } else {
          // Legacy: redirect alla lista col messaggio querystring.
          window.location.href = `/${encodeURIComponent(slug)}/packages?tab=clients&msg=${encodeURIComponent(String(j?.error ?? "Pacchetto cliente non trovato"))}`;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cpId, slug, reloadKey]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }
  function selfUrl(extra: string): string {
    return page(`packages&tab=clients&action=client_view&id=${cpId}`) + extra;
  }

  const selectedItem = data?.usageItems.find((it) => it.itemRef === usageItemRef) ?? data?.usageItems[0];
  const selType = selectedItem?.type === "product" ? "product" : "service";
  const consumeLabel = selType === "product" ? "Segna ritirato" : "Scala";
  const restoreLabel = selType === "product" ? "Ripristina ritiro" : "Ripristina";
  const unitLabel = selectedItem?.unitLabel ?? (selType === "product" ? "pz" : "sedute");
  const opHelp =
    selType === "product"
      ? "Segna ritirato = scarica dal pacchetto e dal magazzino. Ripristina ritiro = riaccredita la quantità e ricarica lo stock."
      : "Scala = diminuisce le rimanenti. Ripristina = aumenta le rimanenti.";
  const notePlaceholder = selType === "product" ? "Es. prodotto ritirato / correzione" : "Es. seduta effettuata / correzione";
  const usageFormDisabled = (data?.usageItems.length ?? 0) === 0;

  // Registra seduta/ritiro (usage_add): esito → redirect legacy con ?msg/?err.
  async function submitUsage(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !data) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "usage_add",
          client_package_id: String(cpId),
          item_ref: usageItemRef,
          op: usageOp,
          qty: String(usageQty),
          used_at: usageUsedAt,
          note: usageNote,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        window.location.href = selfUrl(`&err=${encodeURIComponent(String(j?.error ?? "Errore salvataggio movimento"))}`);
        return;
      }
      window.location.href = selfUrl(`&msg=${encodeURIComponent(String(j?.message ?? "Movimento registrato"))}`);
    } catch {
      setBusy(false);
    }
  }

  // Salva scadenza (update_client_package_expiry): esito → redirect legacy.
  async function submitExpiry(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !data) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "update_client_package_expiry", client_package_id: String(cpId), expires_at: expiryValue }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        window.location.href = selfUrl(`&err=${encodeURIComponent(String(j?.error ?? "Errore: Errore aggiornamento scadenza"))}`);
        return;
      }
      window.location.href = selfUrl(`&msg=${encodeURIComponent("Scadenza pacchetto aggiornata")}`);
    } catch {
      setBusy(false);
    }
  }

  if (loading || !data) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/packages.css" />
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
            <h1 className="bs-page-title">Pacchetti</h1>
            <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
          </div>
        </div>
        <div className="card p-3 text-muted small">Caricamento…</div>
      </div>
    );
  }

  const d = data;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.err}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti</h1>
          <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="d-flex justify-content-between align-items-start gap-3">
          <div>
            <div className="text-muted small">Pacchetto cliente</div>
            <div className="h5 fw-bold mb-1">{d.packageName}</div>
            <div className="text-muted small">
              Cliente:{" "}
              {perms.clientLinks !== false ? (
                <a href={page(`clients&action=view&id=${d.clientId}`)}>{d.clientName}</a>
              ) : (
                d.clientName
              )}
              {d.locationLabel !== "" ? <> - Sede: {d.locationLabel}</> : null}
              {(() => {
                const label = d.contentHasProducts ? "Contenuto" : d.isMulti ? "Servizi" : "Servizio";
                const value = d.contentHasProducts ? d.contentSummary : d.serviceName !== "" ? d.serviceName : d.contentSummary;
                return value !== "" && value !== "—" ? (
                  <>
                    {" "}
                    - {label}: {value}
                  </>
                ) : null;
              })()}
              {d.sourceQuoteId ? (
                perms.quotesManage !== false ? (
                  <>
                    {" "}
                    - Creato da preventivo{" "}
                    <a className="text-decoration-none" href={page(`quotes&action=view&id=${d.sourceQuoteId}`)}>
                      #{d.sourceQuoteNumber !== "" ? d.sourceQuoteNumber : d.sourceQuoteId}
                    </a>
                  </>
                ) : (
                  <> - Creato da preventivo #{d.sourceQuoteNumber !== "" ? d.sourceQuoteNumber : d.sourceQuoteId}</>
                )
              ) : null}
            </div>
          </div>
          <div className="text-end">
            <div>
              <span className={`badge text-bg-${d.statusBadge}`}>{d.statusLabel}</span>
            </div>
            <div className="mt-2 d-flex gap-2 justify-content-end flex-wrap">
              {d.saleId && perms.openSaleDetail !== false ? (
                <a className="btn btn-sm btn-outline-secondary" href={page(`pos_sale_detail&id=${d.saleId}`)}>
                  <i className="bi bi-receipt me-1" />
                  Dettaglio vendita
                </a>
              ) : !d.saleId ? (
                <a className="btn btn-sm btn-outline-secondary disabled" href="#" tabIndex={-1} aria-disabled="true" title="Vendita non trovata">
                  <i className="bi bi-receipt me-1" />
                  Dettaglio vendita
                </a>
              ) : null}
              <a className="btn btn-sm btn-outline-secondary" href={page(`packages&tab=clients&action=client_edit&id=${d.id}`)}>
                <i className="bi bi-pencil me-1" />
                Modifica
              </a>
            </div>
          </div>
        </div>

        {d.status === "expired" && d.availability.errors.length > 0 ? (
          <div className="alert alert-danger mt-3 mb-0">
            <div className="fw-semibold mb-1">Questo pacchetto non può essere riattivato.</div>
            <div className="small mb-2">Non sarà possibile riattivare il pacchetto perché uno o più contenuti sono stati eliminati.</div>
            <ul className="mb-0 small">
              {d.availability.errors.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {d.status === "expired" && d.availability.warnings.length > 0 ? (
          <div className="alert alert-warning mt-3 mb-0">
            <div className="fw-semibold mb-1">Contenuti disattivati presenti.</div>
            <div className="small mb-2">Il pacchetto potrà comunque essere riattivato, ma i seguenti contenuti risultano disattivati.</div>
            <ul className="mb-0 small">
              {d.availability.warnings.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <hr className="my-3" />

        <div className="row g-3">
          <div className="col-md-3">
            <div className="text-muted small">Sedute totali</div>
            <div className="h4 fw-bold mb-0">{d.sessionsTotal}</div>
          </div>
          <div className="col-md-3">
            <div className="text-muted small">Sedute rimanenti</div>
            <div className="h4 fw-bold mb-0">{d.sessionsRemaining}</div>
            {d.reservedQty > 0 ? <div className="small text-warning">{d.reservedQty} in sospeso su prenotazioni</div> : null}
          </div>
          <div className="col-md-3">
            <div className="text-muted small">Inizio</div>
            <div className="fw-semibold">{d.startDate !== "" ? d.startDate : "—"}</div>
          </div>
          <div className="col-md-3">
            <div className="text-muted small">Scadenza</div>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <span className="fw-semibold">{d.expiresAt !== "" ? fmtDate(d.expiresAt) : "-"}</span>
              {d.canEditExpiry ? (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary py-0 px-2"
                  title="Modifica scadenza"
                  aria-label="Modifica scadenza"
                  onClick={() => setShowExpiryModal(true)}
                >
                  <i className="bi bi-pencil" />
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {d.contentRows.length > 0 && (d.contentRows.length > 1 || d.contentHasProducts) ? (
          <>
            <hr className="my-3" />
            <div>
              <div className="text-muted small mb-1">Contenuto pacchetto</div>
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Voce</th>
                      <th className="text-end">Totali</th>
                      <th className="text-end">Rimanenti</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.contentRows.map((row, i) => (
                      <tr key={i}>
                        <td className="text-muted">{row.type === "product" ? "Prodotto" : "Servizio"}</td>
                        <td>
                          {row.name}
                          {row.reservedQty > 0 ? <div className="small text-warning">{row.reservedQty} in sospeso su prenotazioni</div> : null}
                        </td>
                        <td className="text-end">{row.qtyTotal}</td>
                        <td className="text-end fw-semibold">{row.qtyRemaining}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.contentHasProducts ? (
                <div className="form-text">
                  I prodotti inclusi possono essere registrati anche come ritiri dal box seguente; i servizi continuano a usare la logica sedute/ripristino.
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {d.notes !== "" ? (
          <div className="mt-3">
            <div className="text-muted small">Note</div>
            <div style={{ whiteSpace: "pre-line" }}>{d.notes}</div>
          </div>
        ) : null}
      </div>

      <div className="row g-3">
        <div className="col-lg-5">
          <div className="card p-3">
            <div className="fw-semibold mb-2">
              <i className="bi bi-arrow-left-right me-1" />
              Registra seduta/ritiro
            </div>
            {d.reservedQty > 0 ? (
              <div className="alert alert-warning py-2 small">
                Le quantità disponibili escludono {d.reservedQty} seduta/e già collegate a prenotazioni in attesa o prenotate.
              </div>
            ) : null}
            <form onSubmit={submitUsage}>
              {!usageFormDisabled ? (
                <div className="mb-2">
                  <label className="form-label">Voce</label>
                  <select className="form-select" required value={usageItemRef} onChange={(e) => setUsageItemRef(e.target.value)}>
                    {d.usageItems.map((it) => (
                      <option key={it.itemRef} value={it.itemRef}>
                        {it.typeLabel} • {it.label} — {it.qtyRemaining}/{it.qtyTotal} {it.unitLabel} disponibili
                        {it.reservedQty > 0 ? ` (${it.reservedQty} in sospeso)` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">Seleziona il servizio o il prodotto da registrare.</div>
                </div>
              ) : (
                <div className="alert alert-warning py-2 mb-3">Questo pacchetto non ha voci registrabili da dettaglio.</div>
              )}

              <div className="mb-2">
                <label className="form-label">Operazione</label>
                <div className="row g-2">
                  <div className="col-7">
                    <select
                      className="form-select"
                      disabled={usageFormDisabled}
                      required={!usageFormDisabled}
                      value={usageOp}
                      onChange={(e) => setUsageOp(e.target.value as "consume" | "restore")}
                    >
                      <option value="consume">{consumeLabel}</option>
                      <option value="restore">{restoreLabel}</option>
                    </select>
                  </div>
                  <div className="col-5">
                    <div className="input-group">
                      <input
                        className="form-control"
                        type="number"
                        min={1}
                        max={10000}
                        step={1}
                        disabled={usageFormDisabled}
                        required={!usageFormDisabled}
                        value={usageQty}
                        onChange={(e) => setUsageQty(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                      />
                      <span className="input-group-text">{unitLabel}</span>
                    </div>
                  </div>
                </div>
                <div className="form-text">{opHelp}</div>
              </div>
              <div className="mb-2">
                <label className="form-label">Data/ora</label>
                <input
                  className="form-control"
                  type="datetime-local"
                  disabled={usageFormDisabled}
                  value={usageUsedAt}
                  onChange={(e) => setUsageUsedAt(e.target.value)}
                />
              </div>
              <div className="mb-2">
                <label className="form-label">Nota (opz.)</label>
                <input
                  className="form-control"
                  placeholder={notePlaceholder}
                  disabled={usageFormDisabled}
                  value={usageNote}
                  onChange={(e) => setUsageNote(e.target.value)}
                />
              </div>
              <button className="btn btn-primary w-100" type="submit" disabled={usageFormDisabled || busy}>
                <i className="bi bi-check2-circle me-1" />
                Conferma
              </button>
            </form>
          </div>
          <div className="mt-3">
            <a className="btn btn-outline-secondary w-100" href={page("packages&tab=clients")}>
              <i className="bi bi-arrow-left me-1" />
              Torna alla lista
            </a>
          </div>
        </div>

        <div className="col-lg-7">
          <div className="card">
            <div className="card-header">Movimenti</div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Quantità</th>
                    <th>Tipo</th>
                    <th>Voce</th>
                    <th>Nota</th>
                    <th>Operatore</th>
                  </tr>
                </thead>
                <tbody>
                  {d.movements.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        Nessun movimento registrato.
                      </td>
                    </tr>
                  ) : (
                    d.movements.map((u) => (
                      <tr key={u.id}>
                        <td className="text-muted">{fmtDateTime(u.usedAt)}</td>
                        <td className="fw-semibold">
                          {u.delta > 0 ? <span className="text-success">+{u.delta}</span> : <span className="text-danger">{u.delta}</span>}
                          <span className="text-muted small ms-1">{u.unitLabel}</span>
                        </td>
                        <td className="text-muted">{u.movementType}</td>
                        <td>{u.itemLabel}</td>
                        <td>{u.note !== "" ? u.note : "—"}</td>
                        <td className="text-muted">{u.createdByName}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* MODALE Modifica scadenza pacchetto (verbatim) */}
      {showExpiryModal && d.canEditExpiry ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <form onSubmit={submitExpiry}>
                  <div className="modal-header">
                    <h5 className="modal-title">Modifica scadenza pacchetto</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setShowExpiryModal(false)} />
                  </div>
                  <div className="modal-body">
                    <div className="mb-3">
                      <div className="text-muted small mb-1">Scadenza attuale</div>
                      <div className="fw-semibold">{d.expiresAt !== "" ? fmtDate(d.expiresAt) : "-"}</div>
                    </div>
                    <div>
                      <label className="form-label">Nuova data di scadenza</label>
                      <input
                        className="form-control"
                        type="date"
                        min={d.expiryMinDate}
                        required
                        disabled={d.expiryEditLocked}
                        value={expiryValue}
                        onChange={(e) => setExpiryValue(e.target.value)}
                      />
                      {d.expiryEditLocked ? (
                        <div className="alert alert-danger py-2 px-3 small mt-2 mb-0">{d.expiryEditLockMessage}</div>
                      ) : (
                        <div className="form-text">
                          Non puoi selezionare una data precedente a oggi.
                          {d.expiryMinDate > new Date().toISOString().slice(0, 10) ? <> La data deve inoltre rispettare l&apos;inizio del pacchetto.</> : null}{" "}
                          Se il pacchetto e scaduto verra riattivato automaticamente quando i contenuti risultano ancora disponibili.
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setShowExpiryModal(false)}>
                      Annulla
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={d.expiryEditLocked || busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva scadenza
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
