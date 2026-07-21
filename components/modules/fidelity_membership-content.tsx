"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTakenFlash } from "./flash";

// Port fedele della pagina Adesione (app/pages/fidelity_membership.php):
// - stato disabilitato legacy (Fidelity generale off) con header 'Fidelity'
//   gated e testo alternativo senza permesso;
// - filtro Cerca (?q) + paginazione (?p, 20/pagina) via querystring;
// - alert 'Tessere scadute rilevate' (conteggio della pagina corrente);
// - tabella Tessere legacy (stato EFFETTIVO 'Disattivata (scaduta)',
//   '(in fase di scadenza)' nella finestra di rinnovo, badge Sì/No,
//   Modifica btn-warning, Elimina col confirm LUNGO legacy);
// - modali Nuova/Modifica tessera con i testi legacy (scadenza calcolata,
//   help 'Tessera scaduta. Con la riattivazione...', confirm disattivazione,
//   Riattiva tessera disabilitato senza durata configurata);
// - ricerca cliente SERVER-SIDE (api_clients search, min 2 caratteri);
// - ogni POST fa redirect flash ?msg/?err con i messaggi composti legacy.

type FidelityMembershipQuery = { q?: string; p?: string; msg?: string; err?: string };

type SearchClient = { id: number; full_name: string; email: string; phone: string };
type CardValidity = { enabled: boolean; value: number; unit: string; defaultExpiresAt: string };
type FidelityCard = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  clientEmail: string;
  issuedAt: string;
  expiresAt: string;
  status: string;
  statusEffective: string;
  expired: boolean;
  inRenewalWindow: boolean;
  reactivateExpiresAt: string;
};
type Membership = { fidelityEnabled: boolean; cards: FidelityCard[]; total: number; page: number; totalPages: number; expiredCount: number; validity: CardValidity };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(ymd ?? "")) return "—";
  const [y, m, d] = ymd.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// Mirror del backend addCardDuration per l'anteprima scadenza live.
function addMonthsClamped(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map((p) => Number.parseInt(p, 10));
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, dim);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}
function computeExpiry(validity: CardValidity, issuedAt: string): string {
  if (!validity.enabled || validity.value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) return "";
  if (validity.unit === "months") return addMonthsClamped(issuedAt, validity.value);
  if (validity.unit === "years") return addMonthsClamped(issuedAt, validity.value * 12);
  const [y, m, d] = issuedAt.split("-").map((p) => Number.parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + validity.value);
  return dt.toISOString().slice(0, 10);
}

export function FidelityMembershipContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: FidelityMembershipQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const today = todayYmd();
  const [query] = useState(() => ({
    q: String(initialQuery?.q ?? ""),
    p: Math.max(1, Number.parseInt(String(initialQuery?.p ?? "1"), 10) || 1),
  }));
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  const [membership, setMembership] = useState<Membership | null>(null);
  const [canFidelityManage, setCanFidelityManage] = useState(false);
  const [canLevels, setCanLevels] = useState(false);
  const [q, setQ] = useState(query.q);
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState("");

  // Modale "Nuova tessera": ricerca cliente server-side (min 2 caratteri).
  const [showNew, setShowNew] = useState(false);
  const [cardClientSearch, setCardClientSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchClient[] | null>(null);
  const searchTimer = useRef<number | null>(null);
  const [selectedClient, setSelectedClient] = useState<SearchClient | null>(null);
  const [cardCode, setCardCode] = useState("");
  const [cardIssuedAt, setCardIssuedAt] = useState(today);
  const [cardStatus, setCardStatus] = useState("active");

  // Modale "Modifica tessera".
  const [editCard, setEditCard] = useState<FidelityCard | null>(null);
  const [editStatus, setEditStatus] = useState("active");

  useEffect(() => {
    const params = new URLSearchParams({ slug, action: "membership" });
    if (query.q !== "") params.set("q", query.q);
    if (query.p > 1) params.set("p", String(query.p));
    fetch(`/api/manage/fidelity?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.membership) setMembership(j.membership as Membership);
        setCanFidelityManage(j?.canFidelityManage === true);
        setCanLevels(j?.canLevels === true);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function pageHref(page: string): string {
    return `/${encodeURIComponent(slug)}/${page}`;
  }
  function listUrl(params: Record<string, string | number>): string {
    const usp = new URLSearchParams();
    if (query.q !== "") usp.set("q", query.q);
    for (const [k, v] of Object.entries(params)) if (String(v) !== "") usp.set(k, String(v));
    const qs = usp.toString();
    return pageHref(`fidelity_membership${qs !== "" ? `?${qs}` : ""}`);
  }

  const validity: CardValidity = useMemo(() => membership?.validity ?? { enabled: false, value: 0, unit: "days", defaultExpiresAt: "" }, [membership]);

  // Ricerca cliente server-side (fidelity_membership.js: api_clients search).
  function onClientSearchInput(term: string) {
    setCardClientSearch(term);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      const needle = term.trim();
      if (needle.length < 2) {
        setSearchResults(null);
        return;
      }
      try {
        const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=client_search&q=${encodeURIComponent(needle)}`, { headers: { "x-tenant-slug": slug } });
        const j = await res.json();
        setSearchResults(Array.isArray(j.clients) ? j.clients : []);
      } catch {
        setSearchResults(null);
      }
    }, 250);
  }

  // Anteprima scadenza + guardia "già scaduta" per la Nuova tessera.
  const newExpiry = useMemo(() => computeExpiry(validity, cardIssuedAt), [validity, cardIssuedAt]);
  const newAlreadyExpired = cardStatus === "active" && newExpiry !== "" && newExpiry < today;

  function openNew() {
    setSelectedClient(null);
    setCardClientSearch("");
    setSearchResults(null);
    setCardCode("");
    setCardIssuedAt(today);
    setCardStatus("active");
    setModalErr("");
    setShowNew(true);
  }

  function openEdit(card: FidelityCard) {
    setEditCard(card);
    setEditStatus(card.statusEffective === "inactive" ? "inactive" : "active");
    setModalErr("");
  }

  // POST + redirect flash legacy (ogni _mode fa redirect ?msg/?err).
  async function post(fields: Record<string, string>, composeMsg: (j: Record<string, unknown>) => string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setModalErr("");
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) {
        // Errori nella modale aperta (il legacy li mostra come ?err: qui la
        // modale resta aperta con l'errore, i flussi senza modale reindirizzano).
        const message = String(j.error || "Operazione non riuscita.");
        if (showNew || editCard) {
          setModalErr(message);
          setBusy(false);
          return;
        }
        window.location.href = listUrl({ err: message });
        return;
      }
      window.location.href = listUrl({ msg: composeMsg(j) });
    } catch {
      setBusy(false);
    }
  }

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedClient) {
      setModalErr("Seleziona un cliente.");
      return;
    }
    await post(
      { action: "card_create", client_id: String(selectedClient.id), code: cardCode, issued_at: cardIssuedAt, status: cardStatus },
      (j) => `Tessera creata: ${String(j.code ?? "")}`,
    );
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editCard) return;
    // Confirm legacy sulla disattivazione (fidelity_membership.js).
    if (
      editStatus === "inactive" &&
      !window.confirm(
        'Impostando "Disattiva" il cliente perderà le agevolazioni Fidelity prenotate sulle prenotazioni in stato In sospeso / Prenotato. Le prenotazioni in stato Eseguito resteranno invariate. Continuare?',
      )
    ) {
      return;
    }
    await post({ action: "card_update", card_id: String(editCard.id), status: editStatus }, (j) => {
      if (editStatus !== "inactive") return "Tessera aggiornata";
      // Messaggio composto legacy (update_card ~567-579).
      let m = "Tessera disattivata.";
      const released = Number(j.releasedAppointments ?? 0);
      if (released > 0) {
        m += ` Le prenotazioni in stato In sospeso / Prenotato hanno perso le agevolazioni prenotate (${released} ${released === 1 ? "prenotazione con agevolazioni Fidelity" : "prenotazioni con agevolazioni Fidelity"}).`;
      }
      m += " Le prenotazioni in stato Eseguito restano invariate.";
      return m;
    });
  }

  async function reactivate() {
    if (!editCard) return;
    await post({ action: "card_reactivate", card_id: String(editCard.id) }, () => "Tessera riattivata");
  }

  async function removeCard(card: FidelityCard) {
    // Confirm LUNGO legacy (data-confirm del form delete).
    if (
      !window.confirm(
        `Eliminare la tessera ${card.code}?\n\nATTENZIONE: questa operazione resetta completamente PUNTI e MOVIMENTI del cliente, rimuove gli OMAGGI in accumulo delle campagne Solo clienti con Fidelity e fa perdere le agevolazioni Fidelity prenotate alle prenotazioni in stato In sospeso / Prenotato. Le prenotazioni in stato Eseguito restano invariate. Il codice tessera eliminato resterà riservato e non potrà essere riutilizzato.`,
      )
    ) {
      return;
    }
    await post({ action: "card_delete", card_id: String(card.id) }, (j) => {
      // Messaggio composto legacy (delete_card ~719-738).
      let m = "Tessera eliminata. Credito cliente mantenuto. Il codice tessera resta riservato e non potra essere riutilizzato.";
      const removedGifts = Number(j.removedGifts ?? 0);
      if (removedGifts > 0) {
        m += ` Rimossi ${removedGifts} ${removedGifts === 1 ? "gift in accumulo" : "omaggi in accumulo"} legati a campagne Solo clienti con Fidelity.`;
      }
      const released = Number(j.releasedAppointments ?? 0);
      if (released > 0) {
        m += ` Le prenotazioni in stato In sospeso / Prenotato hanno perso le agevolazioni prenotate (${released} ${released === 1 ? "prenotazione con agevolazioni Fidelity" : "prenotazioni con agevolazioni Fidelity"}).`;
      }
      m += " Le prenotazioni in stato Eseguito restano invariate.";
      return m;
    });
  }

  const fidelityDisabled = membership !== null && !membership.fidelityEnabled;
  const cards = membership?.cards ?? [];

  const flashAlerts = (
    <>
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
    </>
  );

  // Stato disabilitato legacy (early return con header dedicato).
  if (fidelityDisabled) {
    return (
      <div className="container-fluid">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Programma punti</div>
            <h1 className="bs-page-title">Adesione</h1>
            <div className="bs-page-subtitle">Gestisci tessere, stati e adesioni Fidelity.</div>
          </div>
        </div>

        {flashAlerts}

        <div className="alert alert-info">
          <div className="fw-semibold mb-1">
            <i className="bi bi-info-circle me-1" />
            Fidelity disattivata
          </div>
          <div className="small">
            Questa sezione è disabilitata perché l&apos;impostazione generale Fidelity è disattivata.{" "}
            {canFidelityManage ? (
              <>
                Attiva la funzione in <a href={pageHref("fidelity")}>Fidelity → Impostazione generale</a>.
              </>
            ) : (
              <>Chiedi a un Admin di attivare l&apos;impostazione generale Fidelity.</>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma punti</div>
          <h1 className="bs-page-title">Adesione</h1>
          <div className="bs-page-subtitle">Gestisci tessere, stati e adesioni Fidelity.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {canLevels ? (
              <a className="btn btn-light" href={`${pageHref("fidelity_points")}#livelli-card`}>
                <i className="bi bi-stars" /> Livelli Card
              </a>
            ) : null}
            <a className="btn btn-light" href={pageHref("fidelity_membership_settings")}>
              <i className="bi bi-gear" /> Impostazioni
            </a>
          </div>
        </div>
      </div>

      {flashAlerts}

      {membership && membership.expiredCount > 0 ? (
        <div className="alert alert-info">
          <div className="fw-semibold mb-1">
            <i className="bi bi-info-circle me-1" />
            Tessere scadute rilevate
          </div>
          <div className="small">
            In questa lista ci {membership.expiredCount === 1 ? "è 1 tessera scaduta" : `sono ${membership.expiredCount} tessere scadute`}. Quando riattivi{" "}
            <strong>Abilita scadenza automatica tessera</strong> nelle <strong>Impostazioni tessera Fidelity</strong>, per ogni tessera già presente viene ripristinata prima
            l&apos;<strong>ultima data di scadenza memorizzata</strong> al momento della disattivazione; se per una tessera non esisteva una data specifica, viene usata la{" "}
            <strong>durata memorizzata</strong> in quel momento. Tornano automaticamente attive solo le tessere con scadenza ripristinata ancora valida. Restano invece{" "}
            <strong>scadute / non attive</strong> quelle la cui scadenza ripristinata è già trascorsa: se vuoi renderle di nuovo valide usa <strong>Riattiva tessera</strong>.
          </div>
        </div>
      ) : null}

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const usp = new URLSearchParams();
            if (q.trim() !== "") usp.set("q", q.trim());
            const qs = usp.toString();
            window.location.href = pageHref(`fidelity_membership${qs !== "" ? `?${qs}` : ""}`);
          }}
        >
          <div className="col-lg-8">
            <label className="form-label">Cerca</label>
            <input className="form-control" name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cliente o codice tessera" />
          </div>
          <div className="col-lg-4 d-flex align-items-end gap-2 app-filter-actions">
            <button className="btn btn-outline-primary app-filter-submit" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            {query.q !== "" ? (
              <a className="btn btn-outline-secondary app-filter-reset" href={pageHref("fidelity_membership")}>
                Reset
              </a>
            ) : null}
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <div className="fw-semibold">Tessere</div>
          <button className="btn btn-sm btn-primary" type="button" onClick={openNew}>
            <i className="bi bi-plus" /> Nuova tessera
          </button>
        </div>

        <div className="table-responsive">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th>Codice Tessera</th>
                <th>Data Emissione</th>
                <th>Data Scadenza</th>
                <th>Scaduta</th>
                <th>Cliente</th>
                <th>Stato</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {cards.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted p-3">
                    Nessuna tessera.
                  </td>
                </tr>
              ) : (
                cards.map((card) => (
                  <tr key={card.id}>
                    <td className="fw-semibold">{card.code}</td>
                    <td>{card.issuedAt !== "" ? fmtDate(card.issuedAt) : "—"}</td>
                    <td>
                      <div>{card.expiresAt !== "" ? fmtDate(card.expiresAt) : "—"}</div>
                      {card.inRenewalWindow ? <div className="text-muted small">(in fase di scadenza)</div> : null}
                    </td>
                    <td>{card.expired ? <span className="badge text-bg-danger">Sì</span> : <span className="badge text-bg-success">No</span>}</td>
                    <td>
                      <div className="fw-semibold">{card.clientName}</div>
                      {card.clientEmail !== "" ? <div className="text-muted small">{card.clientEmail}</div> : null}
                    </td>
                    <td>
                      {card.statusEffective === "active" ? (
                        <span className="badge text-bg-success">Attiva</span>
                      ) : card.expired ? (
                        <span className="badge text-bg-secondary">Disattivata (scaduta)</span>
                      ) : (
                        <span className="badge text-bg-secondary">Disattivata</span>
                      )}
                    </td>
                    <td className="text-end">
                      <div className="d-inline-flex gap-2">
                        <button type="button" className="btn btn-sm btn-warning" title="Modifica" disabled={busy} onClick={() => openEdit(card)}>
                          <i className="bi bi-pencil" />
                        </button>
                        <button type="button" className="btn btn-sm btn-outline-danger" title="Elimina" disabled={busy} onClick={() => removeCard(card)}>
                          <i className="bi bi-trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {membership && membership.totalPages > 1 ? (
          <div className="d-flex justify-content-between align-items-center p-3">
            <div className="text-muted small">
              Pagina {membership.page} di {membership.totalPages} • Totale: {membership.total}
            </div>
            <div className="d-flex gap-2">
              <a className={`btn btn-sm btn-outline-secondary ${membership.page <= 1 ? "disabled" : ""}`} href={listUrl({ p: Math.max(1, membership.page - 1) })}>
                « Prev
              </a>
              <a
                className={`btn btn-sm btn-outline-secondary ${membership.page >= membership.totalPages ? "disabled" : ""}`}
                href={listUrl({ p: Math.min(membership.totalPages, membership.page + 1) })}
              >
                Next »
              </a>
            </div>
          </div>
        ) : null}
      </div>

      {/* Modal: Nuova tessera */}
      {showNew ? (
        <>
          <div className="modal fade show d-block" id="newCardModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg">
              <div className="modal-content">
                <form id="newCardForm" onSubmit={submitNew}>
                  <div className="modal-header">
                    <h5 className="modal-title">Nuova tessera</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setShowNew(false)} />
                  </div>

                  <div className="modal-body">
                    {modalErr ? <div className="alert alert-danger">{modalErr}</div> : null}
                    <div className="row g-3">
                      <div className="col-12">
                        <label className="form-label fw-semibold">Cliente</label>
                        {selectedClient ? (
                          <div className="alert alert-light border d-flex justify-content-between align-items-center mb-0">
                            <div>
                              <div className="fw-semibold">{selectedClient.full_name}</div>
                              <div className="text-muted small">
                                #{selectedClient.id}
                                {selectedClient.email ? ` • ${selectedClient.email}` : ""}
                                {selectedClient.phone ? ` • ${selectedClient.phone}` : ""}
                              </div>
                            </div>
                            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setSelectedClient(null)}>
                              Cambia
                            </button>
                          </div>
                        ) : (
                          <>
                            <input
                              className="form-control"
                              id="cardClientSearch"
                              placeholder="Cerca cliente (nome, email, telefono...)"
                              autoComplete="off"
                              value={cardClientSearch}
                              onChange={(e) => onClientSearchInput(e.target.value)}
                            />
                            <div className="form-text">Digita almeno 2 caratteri e seleziona il cliente dai risultati.</div>
                            <div id="cardClientResults" className="list-group mt-2">
                              {(searchResults ?? []).map((c) => (
                                <button
                                  type="button"
                                  key={c.id}
                                  className="list-group-item list-group-item-action"
                                  onClick={() => {
                                    setSelectedClient(c);
                                    setCardClientSearch("");
                                    setSearchResults(null);
                                  }}
                                >
                                  <div className="fw-semibold">{c.full_name}</div>
                                  <div className="text-muted small">
                                    #{c.id}
                                    {c.email ? ` • ${c.email}` : ""}
                                    {c.phone ? ` • ${c.phone}` : ""}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Codice tessera</label>
                        <input className="form-control" name="code" placeholder="Automatico (es. 000001)" value={cardCode} onChange={(e) => setCardCode(e.target.value)} />
                        <div className="form-text">Se vuoto viene generato automaticamente. Un codice già usato, anche su tessera eliminata, non può essere riutilizzato.</div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Data emissione</label>
                        <input className="form-control" type="date" name="issued_at" id="cardIssuedAt" value={cardIssuedAt} onChange={(e) => setCardIssuedAt(e.target.value)} />
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Data scadenza</label>
                        <div className="form-control bg-light" id="cardExpiresAtView">
                          {newExpiry !== "" ? fmtDate(newExpiry) : "—"}
                        </div>
                        <div className="form-text">Calcolata automaticamente dalle Impostazioni tessera Fidelity in base alla Data emissione. Non modificabile qui.</div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Stato</label>
                        <select className="form-select" name="status" id="cardStatusSelect" value={cardStatus} onChange={(e) => setCardStatus(e.target.value)}>
                          <option value="active">Attiva</option>
                          <option value="inactive">Disattiva</option>
                        </select>
                        {newAlreadyExpired ? (
                          <div className="alert alert-warning py-2 px-3 mt-2 mb-0" id="cardAlreadyExpiredNotice">
                            Con la <strong>Data emissione</strong> selezionata, la tessera risulterebbe già <strong>scaduta</strong>. Per crearla come <strong>Attiva</strong>{" "}
                            scegli una data più recente; in alternativa impostala come <strong>Disattiva</strong>.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setShowNew(false)}>
                      Annulla
                    </button>
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                      <i className="bi bi-check2" /> Crea tessera
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}

      {/* Modal: Modifica tessera */}
      {editCard ? (
        <>
          <div className="modal fade show d-block" id="editCardModal" tabIndex={-1} role="dialog">
            <div className="modal-dialog">
              <div className="modal-content">
                <form id="editCardForm" onSubmit={submitEdit}>
                  <div className="modal-header">
                    <h5 className="modal-title">Modifica tessera</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setEditCard(null)} />
                  </div>

                  <div className="modal-body">
                    {modalErr ? <div className="alert alert-danger">{modalErr}</div> : null}
                    <div className="mb-2">
                      <div className="text-muted small">Codice tessera</div>
                      <div className="fw-semibold">{editCard.code || "—"}</div>
                    </div>
                    <div className="mb-3">
                      <div className="text-muted small">Cliente</div>
                      <div className="fw-semibold">{editCard.clientName || "—"}</div>
                    </div>

                    <div className="row g-3">
                      <div className="col-12">
                        <label className="form-label fw-semibold">Data scadenza</label>
                        <div className="form-control bg-light" id="editCardExpires">
                          {editCard.expiresAt !== "" ? fmtDate(editCard.expiresAt) : "—"}
                        </div>
                        <div className="form-text" id="editCardExpiresHelp">
                          {editCard.expired
                            ? editCard.reactivateExpiresAt !== ""
                              ? `Tessera scaduta. Con la riattivazione la nuova scadenza sarà ${fmtDate(editCard.reactivateExpiresAt)}.`
                              : "Tessera scaduta. Per riattivarla imposta prima una durata tessera in Fidelity → Adesione → Impostazioni tessera Fidelity."
                            : "La data di scadenza è visualizzata ma non può essere modificata qui."}
                        </div>
                      </div>

                      <div className="col-12">
                        <label className="form-label fw-semibold">Stato</label>
                        <select className="form-select" name="status" id="editCardStatus" value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                          <option value="active">Attiva</option>
                          <option value="inactive">Disattiva</option>
                        </select>
                      </div>
                    </div>

                    <div className="alert alert-light border mt-3 mb-0">
                      <div className="small text-muted">
                        Nota: se la regola adesione è <strong>Solo clienti con tessera</strong>, una tessera <strong>scaduta</strong> o <strong>disattivata</strong> rende il
                        cliente non aderente.
                        <br />
                        Se imposti <strong>Disattiva</strong>, il cliente perde le agevolazioni Fidelity prenotate sulle prenotazioni in stato <strong>In sospeso</strong> /{" "}
                        <strong>Prenotato</strong>; le prenotazioni in stato <strong>Eseguito</strong> restano invariate per mantenere lo storico.
                        <br />
                        Alla scadenza la tessera viene disattivata automaticamente, ma <strong>punti Fidelity</strong> e movimenti già maturati{" "}
                        <strong>non vengono azzerati</strong>.
                        <br />
                        Se la tessera è scaduta, usa <strong>Riattiva tessera</strong> per ricalcolare la nuova scadenza dalla data odierna in base alla durata impostata in{" "}
                        <strong>Fidelity → Adesione → Impostazioni tessera Fidelity</strong>.
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setEditCard(null)}>
                      Annulla
                    </button>
                    {editCard.expired ? (
                      <button type="button" className="btn btn-outline-primary" id="editCardReactivateBtn" disabled={busy || editCard.reactivateExpiresAt === ""} onClick={reactivate}>
                        <i className="bi bi-arrow-clockwise" /> Riattiva tessera
                      </button>
                    ) : null}
                    <button className="btn btn-primary" type="submit" id="editCardSaveBtn" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva
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
