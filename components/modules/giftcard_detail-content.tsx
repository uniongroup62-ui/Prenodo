"use client";

import { useEffect, useRef, useState } from "react";

// Port fedele del DETTAGLIO GiftCard (giftcard.php action=edit): header con
// [Torna alla lista][Dettaglio vendita][Voucher][Crea GiftCard] gated, alert
// readonly su annullata (js-gc-readonly-form: tutti i campi disabilitati),
// card riepilogo (Codice+badge, Importo iniziale, Saldo, Emessa il, Inizio
// validità, Scadenza con matita -> modale con min legacy, Evento, Sede
// emissione, Voucher importo nascosto/visibile, Contenuto regalo con residui,
// Messaggio di dedica), form "Dati GiftCard" (mittente obbligatorio,
// destinatario con lock e ricerca cliente server-side), "Invio email al
// destinatario" (Mostra importo e contenuto + invio programmato), "Operazioni"
// (Riscatta scala credito + riscatto per-item), "Nota interna" e colonna
// Movimenti (Data raw | Tipo | Importo € | Sede | Nota | Operatore). Ogni
// _mode fa redirect flash come il PHP.

type GiftCardDetailQuery = { id?: string; msg?: string; err?: string };

type DetailItem = { rowId: number; itemType: string; itemId: number; label: string; name: string; qty: number; redeemedQty: number; remainingQty: number };

type Movement = {
  at: string;
  type: string;
  amount: number;
  locationLabel: string;
  note: string;
  operatorName: string;
};

type Detail = {
  id: number;
  code: string;
  publicToken: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  readOnly: boolean;
  eventType: string;
  eventLabel: string;
  senderClientId: number;
  senderName: string;
  recipientClientId: number;
  recipientName: string;
  recipientEmail: string;
  recipientClient: { id: number; name: string; email: string; phone: string } | null;
  recipientLocked: boolean;
  recipientLockMessage: string;
  locationLabel: string;
  voucherHideAmount: boolean;
  initialAmount: number;
  balance: number;
  note: string;
  giftMessage: string;
  internalNote: string;
  issuedDate: string;
  validFromDate: string;
  expiresDate: string;
  scheduledSendLabel: string;
  lastEmailSentAtRaw: string;
  lastEmailSentTo: string;
  linkedSaleId: number;
  items: DetailItem[];
  hasMoney: boolean;
  hasItems: boolean;
  movements: Movement[];
  opsDisabled: boolean;
  expiryEditable: boolean;
  expiryMinDate: string;
  expiryModalValue: string;
  expiryMinBeyondToday: boolean;
};

type ClientOpt = { id: number; name: string };
type EventOpt = { key: string; label: string };
type SearchClient = { id: number; full_name: string; email: string; phone: string };

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

export function GiftCardDetailContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftCardDetailQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [id, setId] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [events, setEvents] = useState<EventOpt[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Form "Dati GiftCard".
  const [senderClientId, setSenderClientId] = useState(0);
  const [eventType, setEventType] = useState("giftcard");
  const [hideAmount, setHideAmount] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientToggle, setRecipientToggle] = useState(false);
  const [recipientClientId, setRecipientClientId] = useState(0);
  const [selectedClient, setSelectedClient] = useState<SearchClient | null>(null);
  const [emailLockedBySelection, setEmailLockedBySelection] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchClient[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const searchTimer = useRef<number | null>(null);
  const [note, setNote] = useState("");
  const [giftMessage, setGiftMessage] = useState("");

  // Modale scadenza + email + operazioni + nota interna.
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiryValue, setExpiryValue] = useState("");
  const [sendTo, setSendTo] = useState("");
  // Legacy: "Mostra importo e contenuto nella mail" parte SEMPRE spuntato.
  const [showAmountEmail, setShowAmountEmail] = useState(true);
  const [sendGiftMessage, setSendGiftMessage] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemNote, setRedeemNote] = useState("");
  const [itemQty, setItemQty] = useState<Record<number, string>>({});
  const [itemNote, setItemNote] = useState<Record<number, string>>({});
  const [internalNote, setInternalNote] = useState("");

  useEffect(() => {
    const raw = initialQuery?.id ?? new URLSearchParams(window.location.search).get("id") ?? "";
    const cardId = Number.parseInt(String(raw), 10) || 0;
    if (cardId <= 0) {
      window.location.href = `/${encodeURIComponent(slug)}/giftcard?err=${encodeURIComponent("GiftCard non trovata")}`;
      return;
    }
    void Promise.resolve().then(() => setId(cardId));
    fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=edit&id=${cardId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || !j.detail) {
          // Legacy: redirect alla lista con "GiftCard non trovata".
          window.location.href = `/${encodeURIComponent(slug)}/giftcard?err=${encodeURIComponent(String(j.error ?? "GiftCard non trovata"))}`;
          return;
        }
        const d = j.detail as Detail;
        setDetail(d);
        setClients(Array.isArray(j.clients) ? j.clients : []);
        setEvents(Array.isArray(j.events) ? j.events : []);
        setCanCreate(j.canCreate === true);
        setSenderClientId(d.senderClientId);
        setEventType(d.eventType || "giftcard");
        setHideAmount(d.voucherHideAmount);
        setRecipientName(d.recipientName);
        setRecipientEmail(d.recipientEmail);
        setRecipientToggle(d.recipientClientId > 0);
        setRecipientClientId(d.recipientClientId);
        if (d.recipientClient) {
          setSelectedClient({ id: d.recipientClient.id, full_name: d.recipientClient.name, email: d.recipientClient.email, phone: d.recipientClient.phone });
          setEmailLockedBySelection(d.recipientClient.email.trim() !== "");
          if (d.recipientClient.email.trim() !== "") setRecipientEmail(d.recipientClient.email.trim());
        }
        setNote(d.note);
        setGiftMessage(d.giftMessage);
        setInternalNote(d.internalNote);
        setSendTo(d.recipientEmail);
        setSendGiftMessage(d.giftMessage);
        setExpiryValue(d.expiryModalValue);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function pageUrl(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }

  // POST + redirect flash legacy (i _mode legacy fanno sempre redirect).
  async function post(payload: Record<string, unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ id: String(id), ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      const params = new URLSearchParams({ action: "edit", id: String(id) });
      if (j?.ok && j?.message) params.set("msg", String(j.message));
      else if (j?.error) params.set("err", String(j.error));
      window.location.href = pageUrl(`giftcard?${params.toString()}`);
    } catch {
      setBusy(false);
    }
  }

  // Ricerca cliente destinatario (api_clients action=search, debounce 250ms).
  function onRecipientSearchInput(term: string) {
    setRecipientSearch(term);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      const q = term.trim();
      if (q.length < 2) {
        setSearchResults(null);
        setSearchError("");
        return;
      }
      try {
        const res = await fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=client_search&q=${encodeURIComponent(q)}`, { headers: { "x-tenant-slug": slug } });
        const j = await res.json();
        if (!j?.ok) throw new Error(String(j?.error ?? "Errore ricerca"));
        setSearchResults(Array.isArray(j.clients) ? j.clients : []);
        setSearchError("");
      } catch (e) {
        setSearchResults(null);
        setSearchError(e instanceof Error ? e.message : "Errore ricerca");
      }
    }, 250);
  }

  function selectRecipientClient(c: SearchClient) {
    if (detail?.recipientLocked || detail?.readOnly) return;
    setRecipientClientId(c.id);
    setSelectedClient(c);
    setRecipientName(c.full_name || "");
    const em = (c.email || "").trim();
    if (em !== "") {
      setRecipientEmail(em);
      setEmailLockedBySelection(true);
    } else {
      setEmailLockedBySelection(false);
    }
    setRecipientSearch("");
    setSearchResults(null);
    setSearchError("");
  }

  function clearRecipientClient() {
    if (detail?.recipientLocked || detail?.readOnly) return;
    setRecipientClientId(0);
    setSelectedClient(null);
    setEmailLockedBySelection(false);
  }

  const d = detail;
  // js-gc-readonly-form: su annullata TUTTI i campi/bottoni disabilitati.
  const readOnly = d?.readOnly ?? false;
  const recipientLocked = (d?.recipientLocked ?? false) || readOnly;
  const nameReadOnly = recipientLocked || recipientClientId > 0;
  const emailReadOnly = recipientLocked || (recipientClientId > 0 && emailLockedBySelection);
  const opsDisabled = d?.opsDisabled ?? true;

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
            <a className="btn btn-outline-secondary btn-pill" href={pageUrl("giftcard")}>
              <i className="bi bi-arrow-left me-1" />
              Torna alla lista
            </a>
            {d && d.linkedSaleId > 0 ? (
              <a className="btn btn-outline-secondary btn-pill" href={pageUrl(`pos_sale_detail?id=${d.linkedSaleId}`)}>
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            ) : (
              <a className="btn btn-outline-secondary btn-pill disabled" href="#" tabIndex={-1} aria-disabled="true" title="Vendita non trovata">
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            )}
            {d ? (
              <a className="btn btn-outline-secondary btn-pill" target="_blank" rel="noopener" href={pageUrl(`giftcard_voucher?id=${d.id}&embed=1`)}>
                <i className="bi bi-printer me-1" />
                Voucher
              </a>
            ) : null}
            {canCreate ? (
              <a className="btn btn-primary btn-pill" href={pageUrl("pos")}>
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

      {loading || !d ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="row g-3">
          <div className="col-lg-5">
            {readOnly ? (
              <div className="alert alert-warning mb-3">GiftCard annullata: dati, note, invii email e operazioni non sono modificabili.</div>
            ) : null}

            {/* ===== Card riepilogo ===== */}
            <div className="card p-3 mb-3">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="text-muted small">Codice</div>
                  <div className="h5 fw-semibold mb-0">{d.code}</div>
                </div>
                <span className={`badge bg-${d.statusBadge}`}>{d.statusLabel}</span>
              </div>

              <div className="row g-2 mt-2">
                <div className="col-6">
                  <div className="text-muted small">Importo iniziale</div>
                  <div className="fw-semibold">€ {fmtMoney(d.initialAmount)}</div>
                </div>
                <div className="col-6">
                  <div className="text-muted small">Saldo</div>
                  <div className="fw-semibold">€ {fmtMoney(d.balance)}</div>
                </div>
                <div className="col-6">
                  <div className="text-muted small">Emessa il</div>
                  <div>{d.issuedDate}</div>
                </div>
                <div className="col-6">
                  <div className="text-muted small">Inizio validità</div>
                  <div>{d.validFromDate}</div>
                </div>
                <div className="col-6">
                  <div className="text-muted small">Scadenza</div>
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <span>{d.expiresDate !== "" ? d.expiresDate : "—"}</span>
                    {d.expiryEditable ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary py-0 px-2"
                        title="Modifica scadenza"
                        aria-label="Modifica scadenza"
                        onClick={() => setExpiryOpen(true)}
                      >
                        <i className="bi bi-pencil" />
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="col-6">
                  <div className="text-muted small">Evento</div>
                  <div>{d.eventLabel}</div>
                </div>

                <div className="col-6">
                  <div className="text-muted small">Sede emissione</div>
                  <div>{d.locationLabel}</div>
                </div>

                <div className="col-6">
                  <div className="text-muted small">Voucher (destinatario)</div>
                  <div>{d.voucherHideAmount ? "Importo nascosto" : "Importo visibile"}</div>
                </div>
              </div>

              {d.hasItems ? (
                <div className="mt-3">
                  <div className="text-muted small mb-1">Contenuto regalo</div>
                  <ul className="small mb-0">
                    {d.items.map((it) => (
                      <li key={it.rowId}>
                        {it.label}: {it.name} — {it.qty} <span className="text-muted">(residuo {it.remainingQty})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {d.giftMessage !== "" ? (
                <div className="mt-3">
                  <div className="text-muted small mb-1">Messaggio di dedica</div>
                  <div className="small giftcard-prewrap">{d.giftMessage}</div>
                </div>
              ) : null}
            </div>

            {/* ===== Modale "Modifica scadenza GiftCard" ===== */}
            {d.expiryEditable && expiryOpen ? (
              <>
                <div className="modal fade show d-block" id="modalGiftCardExpiry" tabIndex={-1} role="dialog">
                  <div className="modal-dialog modal-dialog-centered">
                    <div className="modal-content">
                      <form
                        method="post"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void post({ action: "update_expiry", expires_at: expiryValue });
                        }}
                      >
                        <div className="modal-header">
                          <h5 className="modal-title">Modifica scadenza GiftCard</h5>
                          <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setExpiryOpen(false)} />
                        </div>

                        <div className="modal-body">
                          <div className="mb-3">
                            <div className="text-muted small mb-1">Scadenza attuale</div>
                            <div className="fw-semibold">{d.expiresDate !== "" ? d.expiresDate : "—"}</div>
                          </div>

                          <div>
                            <label className="form-label">Nuova data di scadenza</label>
                            <input
                              className="form-control"
                              type="date"
                              name="expires_at"
                              min={d.expiryMinDate}
                              value={expiryValue}
                              required
                              onChange={(e) => setExpiryValue(e.target.value)}
                            />
                            <div className="form-text">
                              Non puoi selezionare una data precedente a oggi.
                              {d.expiryMinBeyondToday ? <> La GiftCard richiede inoltre almeno il giorno successivo alla data di emissione.</> : null}{" "}
                              Se la GiftCard è scaduta, impostando una nuova data futura verrà riattivata automaticamente.
                            </div>
                          </div>
                        </div>

                        <div className="modal-footer">
                          <button type="button" className="btn btn-outline-secondary" onClick={() => setExpiryOpen(false)}>
                            Annulla
                          </button>
                          <button type="submit" className="btn btn-primary" disabled={busy}>
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

            {/* ===== Card "Dati GiftCard" ===== */}
            <div className="card p-3 mb-3">
              <div className="h6 fw-semibold mb-2">Dati GiftCard</div>
              <form
                method="post"
                className={readOnly ? "js-gc-readonly-form" : ""}
                onSubmit={(e) => {
                  e.preventDefault();
                  void post({
                    action: "update",
                    client_id: String(senderClientId),
                    event_type: eventType,
                    voucher_hide_amount: hideAmount ? "1" : "0",
                    recipient_client_id: recipientToggle ? String(recipientClientId) : "0",
                    recipient_name: recipientName,
                    recipient_email: recipientEmail,
                    note,
                    gift_message: giftMessage,
                  });
                }}
              >
                <div className="mb-2">
                  <label className="form-label">Mittente</label>
                  <select
                    className="form-select"
                    name="client_id"
                    required
                    disabled={readOnly}
                    value={String(senderClientId || "")}
                    onChange={(e) => setSenderClientId(Number(e.target.value) || 0)}
                  >
                    <option value="" disabled>
                      — seleziona —
                    </option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="row g-2">
                  <div className="col-md-6">
                    <label className="form-label">Evento</label>
                    <select className="form-select" name="event_type" disabled={readOnly} value={eventType} onChange={(e) => setEventType(e.target.value)}>
                      {events.map((ev) => (
                        <option key={ev.key} value={ev.key}>
                          {ev.label}
                        </option>
                      ))}
                    </select>
                    <div className="form-text">Template grafico per email (e voucher).</div>
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Sede emissione</label>
                    <input className="form-control" value={d.locationLabel} readOnly disabled={readOnly} />
                    <div className="form-text">La sede di emissione resta storica; gli utilizzi vengono tracciati nella sede corrente.</div>
                  </div>
                  <div className="col-12">
                    <label className="form-label">Voucher (destinatario)</label>
                    <div className="form-check mt-2">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="editVoucherHideAmount"
                        name="voucher_hide_amount"
                        value="1"
                        checked={hideAmount}
                        disabled={readOnly}
                        onChange={(e) => setHideAmount(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="editVoucherHideAmount">
                        Nascondi importo nel voucher pubblico (QR)
                      </label>
                    </div>
                    <div className="form-text">Se attivo, nel voucher pubblico aperto dal QR/link non verrà mostrato importo e saldo.</div>
                  </div>

                  <div className="col-md-6">
                    <label className="form-label">Destinatario</label>
                    <input
                      className="form-control"
                      id="gcRecipientName"
                      name="recipient_name"
                      value={recipientName}
                      readOnly={nameReadOnly}
                      aria-readonly={nameReadOnly || undefined}
                      disabled={readOnly}
                      onChange={(e) => setRecipientName(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Email destinatario</label>
                    <input
                      className="form-control"
                      id="gcRecipientEmail"
                      type="email"
                      name="recipient_email"
                      value={recipientEmail}
                      readOnly={emailReadOnly}
                      aria-readonly={emailReadOnly || undefined}
                      disabled={readOnly}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                    />
                  </div>

                  <div className="col-12">
                    <div className="form-check mt-1">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="gcRecipientExistingToggle"
                        checked={recipientToggle}
                        disabled={recipientLocked}
                        aria-disabled={recipientLocked || undefined}
                        onChange={(e) => {
                          setRecipientToggle(e.target.checked);
                          if (!e.target.checked) {
                            clearRecipientClient();
                            setRecipientSearch("");
                            setSearchResults(null);
                          }
                        }}
                      />
                      <label className="form-check-label" htmlFor="gcRecipientExistingToggle">
                        Destinatario già cliente
                      </label>
                    </div>
                  </div>

                  <div className={`col-12 ${recipientToggle ? "" : "d-none"}`} id="gcRecipientExistingWrap">
                    <div className={`border rounded p-3 mb-2 ${recipientClientId > 0 ? "" : "d-none"}`} id="gcRecipientSelectedBox">
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <div className="fw-semibold" id="gcRecipientSelectedName">{selectedClient?.full_name ?? ""}</div>
                          <div className="text-muted small" id="gcRecipientSelectedMeta">
                            #{selectedClient?.id ?? 0}
                            {selectedClient?.email ? <> • {selectedClient.email}</> : null}
                            {selectedClient?.phone ? <> • {selectedClient.phone}</> : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          id="gcRecipientRemoveBtn"
                          title="Rimuovi destinatario"
                          disabled={recipientLocked}
                          aria-disabled={recipientLocked || undefined}
                          onClick={clearRecipientClient}
                        >
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>

                      <div className="alert alert-info mt-2 mb-0 py-2 px-3 small" id="gcRecipientFidelityAlertStatic">
                        La GiftCard sarà associata al destinatario selezionato. Eventuali punti e omaggi della vendita resteranno accreditati solo al mittente (se aderisce alla
                        Fidelity).
                      </div>
                    </div>

                    {/* Cerca cliente: visibile solo se NON è già selezionato un destinatario */}
                    <div className={recipientLocked || recipientClientId > 0 ? "d-none" : ""} id="gcRecipientSearchWrap">
                      <label className="form-label mb-1" htmlFor="gcRecipientSearch">
                        Cerca cliente
                      </label>
                      <div className="input-group">
                        <span className="input-group-text">
                          <i className="bi bi-search" />
                        </span>
                        <input
                          className="form-control"
                          id="gcRecipientSearch"
                          placeholder="Cerca per nome, email o telefono…"
                          autoComplete="off"
                          value={recipientSearch}
                          onChange={(e) => onRecipientSearchInput(e.target.value)}
                        />
                      </div>
                      <div className="form-text">
                        Se selezioni un destinatario già cliente, la GiftCard verrà associata al <strong>destinatario selezionato</strong>. Eventuali punti e omaggi della
                        vendita resteranno accreditati solo al <strong>mittente</strong> (se aderisce alla Fidelity).
                      </div>
                      <div className="list-group giftcard-recipient-results mt-2" id="gcRecipientResults">
                        {searchResults !== null && searchResults.length === 0 ? (
                          <div className="text-muted small py-2 px-2">Nessun cliente trovato.</div>
                        ) : (
                          (searchResults ?? []).map((c) => (
                            <button type="button" className="list-group-item list-group-item-action" key={c.id} onClick={() => selectRecipientClient(c)}>
                              <div className="fw-semibold">{c.full_name}</div>
                              <div className="text-muted small">
                                #{c.id}
                                {c.email ? ` • ${c.email}` : ""}
                                {c.phone ? ` • ${c.phone}` : ""}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                      <div className={`alert ${searchError !== "" ? "alert-danger" : "d-none"} mt-2 py-2 px-3 small`} id="gcRecipientFidelityAlert">
                        {searchError}
                      </div>
                    </div>
                  </div>

                  {d.recipientLocked ? (
                    <div className="col-12">
                      <div className="alert alert-warning py-2 px-3 small mb-0">{d.recipientLockMessage}</div>
                    </div>
                  ) : null}

                  <div className="col-12">
                    <label className="form-label">Nota per il cliente</label>
                    <input className="form-control" name="note" value={note} placeholder="(opzionale)" disabled={readOnly} onChange={(e) => setNote(e.target.value)} />
                  </div>

                  <div className="col-12">
                    <label className="form-label">Messaggio di dedica (opzionale)</label>
                    {/* Legacy: il placeholder del form Dati contiene un "\n" LETTERALE. */}
                    <textarea
                      className="form-control"
                      name="gift_message"
                      rows={3}
                      placeholder={"Es. Buon compleanno!\\nUn abbraccio…"}
                      value={giftMessage}
                      disabled={readOnly}
                      onChange={(e) => setGiftMessage(e.target.value)}
                    />
                  </div>
                </div>

                <div className="mt-3 d-flex gap-2">
                  <button className="btn btn-primary" type="submit" disabled={busy || readOnly}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva
                  </button>
                  <a className="btn btn-outline-secondary" href={pageUrl("giftcard")}>
                    Torna alla lista
                  </a>
                </div>
              </form>
            </div>

            {/* ===== Invio email al destinatario ===== */}
            <div className="card p-3 mb-3">
              <div className="h6 fw-semibold mb-2">Invio email al destinatario</div>
              {d.scheduledSendLabel !== "" ? (
                <div className="alert alert-info py-2 px-3 small mb-2">
                  Invio programmato: <strong>{d.scheduledSendLabel}</strong>
                </div>
              ) : null}
              <form
                method="post"
                className={readOnly ? "js-gc-readonly-form" : ""}
                onSubmit={(e) => {
                  e.preventDefault();
                  void post({ action: "send_email", send_to: sendTo, ...(showAmountEmail ? { show_amount: "1" } : {}), send_gift_message: sendGiftMessage });
                }}
              >
                <div className="row g-2">
                  <div className="col-12">
                    <label className="form-label">Email destinatario</label>
                    <input className="form-control" type="email" name="send_to" value={sendTo} required disabled={readOnly} onChange={(e) => setSendTo(e.target.value)} />
                  </div>
                  <div className="col-12">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        name="show_amount"
                        value="1"
                        id="showAmountEmail"
                        checked={showAmountEmail}
                        disabled={readOnly}
                        onChange={(e) => setShowAmountEmail(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="showAmountEmail">
                        Mostra importo e contenuto nella mail
                      </label>
                    </div>
                    <div className="text-muted small">
                      Se disattivato, nella mail non verrà mostrato l&apos;importo (né i dettagli): il destinatario dovrà recarsi in negozio per scoprirli.
                    </div>
                  </div>
                  <div className="col-12">
                    <label className="form-label">Messaggio di dedica (opzionale)</label>
                    <textarea
                      className="form-control"
                      name="send_gift_message"
                      rows={3}
                      placeholder={"Es. Buon compleanno!\nUn abbraccio…"}
                      value={sendGiftMessage}
                      disabled={readOnly}
                      onChange={(e) => setSendGiftMessage(e.target.value)}
                    />
                    <div className="form-text">Verrà inserito nella mail e salvato nella GiftCard.</div>
                  </div>
                </div>

                <div className="mt-2 d-flex gap-2 align-items-center">
                  <button className="btn btn-primary" type="submit" disabled={opsDisabled || busy}>
                    Invia GiftCard via email
                  </button>
                  {d.lastEmailSentAtRaw !== "" ? (
                    <span className="text-muted small">
                      Ultimo invio: {d.lastEmailSentAtRaw} ({d.lastEmailSentTo})
                    </span>
                  ) : null}
                </div>
              </form>
            </div>

            {/* ===== Operazioni ===== */}
            <div className="card p-3 mb-3">
              <div className="h6 fw-semibold mb-2">Operazioni</div>

              <div className="row g-3">
                {d.hasMoney ? (
                  <div className="col-12">
                    <form
                      method="post"
                      className={`border rounded p-2 ${readOnly ? "js-gc-readonly-form" : ""}`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void post({ action: "redeem", redeem_amount: redeemAmount.replace(",", "."), redeem_note: redeemNote });
                      }}
                    >
                      <div className="fw-semibold mb-2">Riscatta (scala credito)</div>
                      <div className="row g-2 align-items-end">
                        <div className="col-5">
                          <label className="form-label">Importo</label>
                          <div className="input-group">
                            <span className="input-group-text">€</span>
                            <input
                              className="form-control"
                              type="number"
                              step="0.01"
                              min="0"
                              name="redeem_amount"
                              required
                              disabled={readOnly}
                              value={redeemAmount}
                              onChange={(e) => setRedeemAmount(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="col-7">
                          <label className="form-label">Nota</label>
                          <input className="form-control" name="redeem_note" placeholder="(opzionale)" disabled={readOnly} value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} />
                        </div>
                      </div>
                      <div className="mt-2">
                        <button className="btn btn-outline-primary" type="submit" disabled={opsDisabled || busy}>
                          Registra riscatto
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="col-12">
                    <div className="border rounded p-2">
                      <div className="fw-semibold mb-1">Riscatta credito</div>
                      <div className="text-muted small">Questa GiftCard non ha credito monetario associato (solo servizi/prodotti).</div>
                    </div>
                  </div>
                )}

                {d.hasItems ? (
                  <div className="col-12">
                    <div className="border rounded p-2">
                      <div className="fw-semibold mb-2">Riscatta servizi/prodotti</div>
                      <div className="text-muted small mb-2">Usa questa sezione quando la GiftCard è stata emessa come voucher per servizi/prodotti (importo anche 0).</div>

                      {d.items.map((it) => (
                        <form
                          key={it.rowId}
                          method="post"
                          className={`row g-2 align-items-end mb-2 ${readOnly ? "js-gc-readonly-form" : ""}`}
                          onSubmit={(e) => {
                            e.preventDefault();
                            void post({ action: "redeem_item", item_row_id: String(it.rowId), item_qty: itemQty[it.rowId] ?? "1", item_note: itemNote[it.rowId] ?? "" });
                          }}
                        >
                          <div className="col-12">
                            <div className="small">
                              <span className="badge bg-light text-dark border me-1">{it.label}</span>
                              {it.name}{" "}
                              <span className="text-muted">
                                (residuo {it.remainingQty} / {it.qty})
                              </span>
                            </div>
                          </div>

                          <div className="col-4">
                            <label className="form-label">Quantità</label>
                            <input
                              className="form-control"
                              type="number"
                              step="1"
                              min="1"
                              name="item_qty"
                              value={itemQty[it.rowId] ?? "1"}
                              disabled={it.remainingQty <= 0 || readOnly}
                              onChange={(e) => setItemQty((prev) => ({ ...prev, [it.rowId]: e.target.value }))}
                            />
                          </div>
                          <div className="col-8">
                            <label className="form-label">Nota</label>
                            <input
                              className="form-control"
                              name="item_note"
                              placeholder="(opzionale)"
                              value={itemNote[it.rowId] ?? ""}
                              disabled={it.remainingQty <= 0 || readOnly}
                              onChange={(e) => setItemNote((prev) => ({ ...prev, [it.rowId]: e.target.value }))}
                            />
                          </div>

                          <div className="col-12">
                            <button className="btn btn-outline-primary" type="submit" disabled={it.remainingQty <= 0 || opsDisabled || busy}>
                              Segna come utilizzato
                            </button>
                          </div>
                        </form>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {/* ===== Nota interna ===== */}
            <div className="card p-3 mb-3">
              <div className="h6 fw-semibold mb-2">Nota interna</div>
              <form
                method="post"
                className={readOnly ? "js-gc-readonly-form" : ""}
                onSubmit={(e) => {
                  e.preventDefault();
                  void post({ action: "update_internal_note", internal_note: internalNote });
                }}
              >
                <textarea className="form-control" name="internal_note" rows={4} placeholder="(opzionale)" value={internalNote} disabled={readOnly} onChange={(e) => setInternalNote(e.target.value)} />
                <div className="form-text">Nota visibile solo nel backend. Può essere impostata in fase di emissione (POS) o modificata da qui.</div>

                <div className="mt-2">
                  <button className="btn btn-primary" type="submit" disabled={busy || readOnly}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva nota
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* ===== Colonna destra: Movimenti ===== */}
          <div className="col-lg-7">
            <div className="card">
              <div className="p-3 border-bottom">
                <div className="h6 fw-semibold mb-0">Movimenti</div>
              </div>
              <div className="table-responsive">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th className="text-end">Importo</th>
                      <th>Sede</th>
                      <th>Nota</th>
                      <th>Operatore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.movements.map((m, idx) => (
                      <tr key={idx}>
                        <td className="text-muted">{m.at}</td>
                        <td className="fw-semibold">{m.type}</td>
                        <td className="text-end fw-semibold">
                          {m.amount > 0 ? (
                            <span className="text-success">€ {fmtMoney(m.amount)}</span>
                          ) : m.amount < 0 ? (
                            <span className="text-danger">€ {fmtMoney(m.amount)}</span>
                          ) : (
                            <>€ {fmtMoney(m.amount)}</>
                          )}
                        </td>
                        <td className="text-muted">{m.locationLabel}</td>
                        <td className="text-muted">{m.note}</td>
                        <td className="text-muted">{m.operatorName}</td>
                      </tr>
                    ))}
                    {d.movements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted p-3">
                          Nessun movimento.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
