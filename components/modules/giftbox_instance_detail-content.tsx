"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { giftboxExpiryWarning } from "@/components/modules/giftbox-content";

// Port fedele del DETTAGLIO istanza GiftBox (giftbox.php tab=instances
// action=edit_instance): header con [Lista GiftBox][Dettagli vendita][Voucher]
// [Impostazioni][Crea GiftBox] gated, alert disponibilità contenuti (istanze
// scadute), card riepilogo (Codice+badge, Evento, Emessa il, Inizio validità,
// Scadenza con matita -> modale con min/lock legacy, Riscatto X/Y, Contenuto
// regalo), form "Dati GiftBox" (destinatario con lock e ricerca cliente
// server-side), "Invio email al destinatario", "Operazioni" col riscatto
// parziale per-item (checkbox quando resta 1, riserve prenotazioni), "Nota
// interna" e colonna Movimenti (reali + virtuali, Sede e Operatore).

type GiftBoxDetailQuery = { id?: string; msg?: string; err?: string };

type DetailItem = {
  rowId: number;
  giftboxItemId: number;
  itemType: string;
  name: string;
  qty: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  pendingAppointments: string[];
};

type Movement = {
  at: string;
  atLabel: string;
  type: string;
  amount: number;
  serviceProduct: string;
  locationLabel: string;
  note: string;
  operatorName: string;
};

type Issue = { type: string; label: string; message: string; context: string | null };

type Detail = {
  id: number;
  code: string;
  publicToken: string;
  giftboxName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  eventKey: string;
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
  note: string;
  giftMessage: string;
  internalNote: string;
  issuedAtLabel: string;
  validStartLabel: string;
  expiresLabel: string;
  expiresDate: string;
  redeemedAtRaw: string;
  lastEmailSentAtRaw: string;
  lastEmailSentTo: string;
  lastEmailShowDetails: boolean;
  emailSendDisabled: boolean;
  linkedSaleId: number;
  items: DetailItem[];
  totalUnits: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  partial: boolean;
  movements: Movement[];
  canRedeem: boolean;
  expiryEditable: boolean;
  expiryMinDate: string;
  expiryModalValue: string;
  expiryMinBeyondToday: boolean;
  expiryEditLocked: boolean;
  expiryEditLockMessage: string;
  availabilityErrors: Issue[];
  availabilityWarnings: Issue[];
};

type ClientOpt = { id: number; name: string };
type EventOpt = { key: string; label: string };
type SearchClient = { id: number; full_name: string; email: string; phone: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function GiftBoxInstanceDetailContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftBoxDetailQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [id, setId] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [events, setEvents] = useState<EventOpt[]>([]);
  const [canSettings, setCanSettings] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Form "Dati GiftBox".
  const [senderClientId, setSenderClientId] = useState(0);
  const [eventType, setEventType] = useState("giftbox");
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

  // Modale scadenza + email + riscatto + nota interna.
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiryValue, setExpiryValue] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [showDetailsEmail, setShowDetailsEmail] = useState(true);
  const [sendGiftMessage, setSendGiftMessage] = useState("");
  const [redeemQty, setRedeemQty] = useState<Record<number, number>>({});
  const [redeemNote, setRedeemNote] = useState("");
  const [internalNote, setInternalNote] = useState("");

  useEffect(() => {
    const raw = initialQuery?.id ?? new URLSearchParams(window.location.search).get("id") ?? "";
    const instanceId = Number.parseInt(String(raw), 10) || 0;
    if (instanceId <= 0) {
      window.location.href = `/${encodeURIComponent(slug)}/giftbox?tab=instances&err=${encodeURIComponent("Istanza non trovata")}`;
      return;
    }
    void Promise.resolve().then(() => setId(instanceId));
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=edit_instance&id=${instanceId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || !j.detail) {
          // Legacy: redirect alla lista con "Istanza non trovata".
          window.location.href = `/${encodeURIComponent(slug)}/giftbox?tab=instances&err=${encodeURIComponent(String(j.error ?? "Istanza non trovata"))}`;
          return;
        }
        const d = j.detail as Detail;
        setDetail(d);
        setClients(Array.isArray(j.clients) ? j.clients : []);
        setEvents(Array.isArray(j.events) ? j.events : []);
        setCanSettings(j.canSettings === true);
        setCanCreate(j.canCreate === true);
        setSenderClientId(d.senderClientId);
        setEventType(d.eventKey || "giftbox");
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
        setShowDetailsEmail(d.lastEmailShowDetails);
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
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ instance_id: String(id), ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      const params = new URLSearchParams({ tab: "instances", action: "edit_instance", id: String(id) });
      if (j?.ok && j?.message) params.set("msg", String(j.message));
      else if (j?.error) params.set("err", String(j.error));
      window.location.href = pageUrl(`giftbox?${params.toString()}`);
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
        const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=client_search&q=${encodeURIComponent(q)}`, { headers: { "x-tenant-slug": slug } });
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
    if (detail?.recipientLocked) return;
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
    if (detail?.recipientLocked) return;
    setRecipientClientId(0);
    setSelectedClient(null);
    setEmailLockedBySelection(false);
  }

  const recipientLocked = detail?.recipientLocked ?? false;
  const nameReadOnly = recipientLocked || recipientClientId > 0;
  const emailReadOnly = recipientLocked || (recipientClientId > 0 && emailLockedBySelection);

  const pendingHints = useMemo(() => {
    const map = new Map<number, string>();
    for (const it of detail?.items ?? []) {
      if (it.pendingUnits <= 0) continue;
      let hint = `${it.pendingUnits} in sospeso`;
      if (it.pendingAppointments.length > 0) {
        hint += ` su prenotaz${it.pendingAppointments.length === 1 ? "ione #" : "ioni #"}${it.pendingAppointments.join(", #")}`;
      }
      map.set(it.giftboxItemId, hint);
    }
    return map;
  }, [detail]);

  function setAllRemaining(fill: boolean) {
    if (!detail) return;
    const next: Record<number, number> = {};
    if (fill) for (const it of detail.items) if (it.availableUnits > 0) next[it.giftboxItemId] = it.availableUnits;
    setRedeemQty(next);
  }

  async function submitPartialRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm("Registrare il riscatto selezionato?")) return;
    await post({ action: "redeem_instance_partial", redeem_qty_json: JSON.stringify(redeemQty), redeem_note: redeemNote });
  }

  const d = detail;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <h1 className="bs-page-title">Fidelity / GiftBox</h1>
          <div className="bs-page-subtitle">Gestisci template, voucher e GiftBox emesse.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary btn-pill" href={pageUrl("giftbox?tab=instances")}>
              <i className="bi bi-arrow-left me-1" />
              Lista GiftBox
            </a>
            {d && d.linkedSaleId > 0 ? (
              <a className="btn btn-outline-secondary btn-pill" href={pageUrl(`pos_sale_detail?id=${d.linkedSaleId}`)}>
                <i className="bi bi-receipt me-1" />
                Dettagli vendita
              </a>
            ) : (
              <a className="btn btn-outline-secondary btn-pill disabled" href="#" tabIndex={-1} aria-disabled="true" title="Vendita non trovata">
                <i className="bi bi-receipt me-1" />
                Dettagli vendita
              </a>
            )}
            {d ? (
              <a className="btn btn-outline-secondary btn-pill" target="_blank" rel="noopener" href={pageUrl(`giftbox_voucher?id=${d.id}&embed=1`)}>
                <i className="bi bi-printer me-1" />
                Voucher
              </a>
            ) : null}
            {canSettings ? (
              <a className="btn btn-outline-secondary btn-pill" href={pageUrl("giftbox_settings")}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            ) : null}
            {canCreate ? (
              <a className="btn btn-primary btn-pill" href={pageUrl("pos")}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftBox
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
        <>
          {d.status === "expired" && d.availabilityErrors.length > 0 ? (
            <div className="alert alert-danger mb-3">
              <div className="fw-semibold mb-1">
                <i className="bi bi-exclamation-octagon me-1" />
                Contenuti eliminati nella GiftBox
              </div>
              <div className="small mb-2">
                Non sarà possibile riattivare la GiftBox perché uno o più contenuti non sono più presenti nel catalogo. Elimina o sostituisci gli elementi indicati prima di
                riattivarla.
              </div>
              <ul className="mb-0 small">
                {d.availabilityErrors.map((issue, i) =>
                  issue.message.trim() !== "" ? (
                    <li key={i}>
                      {issue.message}
                      {issue.context ? <span className="text-muted"> ({issue.context})</span> : null}
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          ) : null}
          {d.status === "expired" && d.availabilityWarnings.length > 0 ? (
            <div className="alert alert-warning mb-3">
              <div className="fw-semibold mb-1">
                <i className="bi bi-exclamation-triangle me-1" />
                Contenuti disattivati nella GiftBox
              </div>
              <div className="small mb-2">Gli elementi sotto sono stati disattivati, ma sarà comunque possibile riattivare la GiftBox.</div>
              <ul className="mb-0 small">
                {d.availabilityWarnings.map((issue, i) =>
                  issue.message.trim() !== "" ? (
                    <li key={i}>
                      {issue.message}
                      {issue.context ? <span className="text-muted"> ({issue.context})</span> : null}
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          ) : null}

          <div className="row g-3">
            <div className="col-lg-5">
              <div className="card p-3 mb-3">
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <div className="text-muted small">Codice</div>
                    <div className="h5 fw-semibold mb-0">{d.code !== "" ? d.code : `Istanza #${d.id}`}</div>
                  </div>
                  <span className={`badge bg-${d.statusBadge}`}>{d.statusLabel}</span>
                </div>

                <div className="row g-2 mt-2">
                  <div className="col-6">
                    <div className="text-muted small">Evento</div>
                    <div>{d.eventLabel}</div>
                  </div>

                  <div className="col-6">
                    <div className="text-muted small">Emessa il</div>
                    <div>{d.issuedAtLabel}</div>
                  </div>
                  <div className="col-6">
                    <div className="text-muted small">Inizio validità</div>
                    <div>{d.validStartLabel}</div>
                  </div>

                  <div className="col-6">
                    <div className="text-muted small">Scadenza</div>
                    <div className="d-flex align-items-center gap-2 flex-wrap">
                      <span>{d.expiresLabel}</span>
                      {(() => {
                        const warn = giftboxExpiryWarning(d.expiresDate, d.status);
                        return warn ? <span className="badge text-bg-warning">{warn}</span> : null;
                      })()}
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

                  {d.totalUnits > 0 ? (
                    <div className="col-12">
                      <div className="text-muted small">Riscatto</div>
                      <div className="small">
                        {d.redeemedUnits} / {d.totalUnits} utilizzati
                        {d.availableUnits > 0 ? (
                          <>
                            {" "}
                            <span className="text-muted">·</span> {d.availableUnits} disponibili
                          </>
                        ) : null}
                        {d.pendingUnits > 0 ? (
                          <>
                            {" "}
                            <span className="text-muted">·</span> {d.pendingUnits} in sospeso su prenotazioni
                          </>
                        ) : null}
                        {d.partial ? <span className="badge text-bg-secondary ms-2">PARZIALE</span> : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                {d.items.length > 0 ? (
                  <div className="mt-3">
                    <div className="text-muted small mb-1">Contenuto regalo</div>
                    <ul className="small mb-0">
                      {d.items.map((it) => (
                        <li key={it.rowId}>
                          {it.name} — {it.qty}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              {d.expiryEditable && expiryOpen ? (
                <>
                  <div className="modal fade show d-block" id="modalGiftBoxExpiry" tabIndex={-1} role="dialog">
                    <div className="modal-dialog modal-dialog-centered">
                      <div className="modal-content">
                        <form
                          method="post"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void post({ action: "update_instance_expiry", expires_at: expiryValue });
                          }}
                        >
                          <div className="modal-header">
                            <h5 className="modal-title">Modifica scadenza GiftBox</h5>
                            <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setExpiryOpen(false)} />
                          </div>

                          <div className="modal-body">
                            <div className="mb-3">
                              <div className="text-muted small mb-1">Scadenza attuale</div>
                              <div className="fw-semibold">{d.expiresLabel}</div>
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
                                disabled={d.expiryEditLocked}
                                aria-disabled={d.expiryEditLocked || undefined}
                                onChange={(e) => setExpiryValue(e.target.value)}
                              />
                              {d.expiryEditLocked ? (
                                <div className="alert alert-danger py-2 px-3 small mt-2 mb-0">{d.expiryEditLockMessage}</div>
                              ) : (
                                <div className="form-text">
                                  Non puoi selezionare una data precedente a oggi.
                                  {d.expiryMinBeyondToday ? <> La data deve inoltre rispettare l&apos;inizio validità dell&apos;istanza.</> : null}{" "}
                                  Puoi estendere la scadenza anche oltre la validità massima del template GiftBox; se la GiftBox è scaduta verrà riattivata automaticamente.
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="modal-footer">
                            <button type="button" className="btn btn-outline-secondary" onClick={() => setExpiryOpen(false)}>
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

              <div className="card p-3 mb-3">
                <div className="h6 fw-semibold mb-2">Dati GiftBox</div>

                <form
                  method="post"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post({
                      action: "update_instance",
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
                    <select className="form-select" name="client_id" required value={String(senderClientId || "")} onChange={(e) => setSenderClientId(Number(e.target.value) || 0)}>
                      <option value="">— seleziona —</option>
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
                      <select className="form-select" name="event_type" value={eventType} onChange={(e) => setEventType(e.target.value)}>
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
                      <input className="form-control" value={d.locationLabel} readOnly />
                      <div className="form-text">La sede di emissione resta storica; i riscatti vengono tracciati nella sede di utilizzo.</div>
                    </div>
                    <div className="col-12">
                      <label className="form-label">Voucher (destinatario)</label>
                      <div className="form-check mt-2">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id="editGbVoucherHideAmount"
                          name="voucher_hide_amount"
                          value="1"
                          checked={hideAmount}
                          onChange={(e) => setHideAmount(e.target.checked)}
                        />
                        <label className="form-check-label" htmlFor="editGbVoucherHideAmount">
                          Nascondi importo nel voucher pubblico (QR)
                        </label>
                      </div>
                      <div className="form-text">
                        Se attivo, nel voucher pubblico aperto dal QR/link non verrà mostrato il prezzo di listino per ogni servizio/prodotto contenuto nella GiftBox.
                      </div>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Destinatario (opzionale)</label>
                      <input
                        className="form-control"
                        id="gbRecipientName"
                        name="recipient_name"
                        value={recipientName}
                        placeholder="Nome destinatario"
                        readOnly={nameReadOnly}
                        aria-readonly={nameReadOnly || undefined}
                        onChange={(e) => setRecipientName(e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Email destinatario (opzionale)</label>
                      <input
                        className="form-control"
                        id="gbRecipientEmail"
                        type="email"
                        name="recipient_email"
                        value={recipientEmail}
                        placeholder="email@dominio.it"
                        readOnly={emailReadOnly}
                        aria-readonly={emailReadOnly || undefined}
                        onChange={(e) => setRecipientEmail(e.target.value)}
                      />
                    </div>

                    <div className="col-12">
                      <div className="form-check mt-1">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id="gbRecipientExistingToggle"
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
                        <label className="form-check-label" htmlFor="gbRecipientExistingToggle">
                          Destinatario già cliente
                        </label>
                      </div>
                    </div>

                    <div className={`col-12 ${recipientToggle ? "" : "d-none"}`} id="gbRecipientExistingWrap">
                      <div className={`border rounded p-3 mb-2 ${recipientClientId > 0 ? "" : "d-none"}`} id="gbRecipientSelectedBox">
                        <div className="d-flex justify-content-between align-items-start">
                          <div>
                            <div className="fw-semibold" id="gbRecipientSelectedName">{selectedClient?.full_name ?? ""}</div>
                            <div className="text-muted small" id="gbRecipientSelectedMeta">
                              #{selectedClient?.id ?? 0}
                              {selectedClient?.email ? <> • {selectedClient.email}</> : null}
                              {selectedClient?.phone ? <> • {selectedClient.phone}</> : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            id="gbRecipientRemoveBtn"
                            title="Rimuovi destinatario"
                            disabled={recipientLocked}
                            aria-disabled={recipientLocked || undefined}
                            onClick={clearRecipientClient}
                          >
                            <i className="bi bi-x-lg" />
                          </button>
                        </div>

                        <div className="alert alert-info mt-2 mb-0 py-2 px-3 small" id="gbRecipientFidelityAlertStatic">
                          La GiftBox sarà associata al destinatario selezionato. Eventuali punti e omaggi della vendita resteranno accreditati solo al mittente (se aderisce
                          alla Fidelity).
                        </div>
                      </div>

                      {/* Cerca cliente: visibile solo se NON è già selezionato un destinatario */}
                      <div className={recipientLocked || recipientClientId > 0 ? "d-none" : ""} id="gbRecipientSearchWrap">
                        <label className="form-label mb-1" htmlFor="gbRecipientSearch">
                          Cerca cliente
                        </label>
                        <div className="input-group">
                          <span className="input-group-text">
                            <i className="bi bi-search" />
                          </span>
                          <input
                            className="form-control"
                            id="gbRecipientSearch"
                            placeholder="Cerca per nome, email o telefono…"
                            autoComplete="off"
                            value={recipientSearch}
                            onChange={(e) => onRecipientSearchInput(e.target.value)}
                          />
                        </div>
                        <div className="form-text">
                          Se selezioni un destinatario già cliente, la GiftBox verrà associata al <strong>destinatario selezionato</strong>. Eventuali punti e omaggi della
                          vendita resteranno accreditati solo al <strong>mittente</strong> (se aderisce alla Fidelity).
                        </div>
                        <div className="list-group mt-2 giftbox-recipient-results" id="gbRecipientResults">
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
                        <div className={`alert ${searchError !== "" ? "alert-danger" : "d-none"} mt-2 py-2 px-3 small`} id="gbRecipientFidelityAlert">
                          {searchError}
                        </div>
                      </div>
                    </div>

                    {recipientLocked ? (
                      <div className="col-12">
                        <div className="alert alert-warning py-2 px-3 small mb-0">{d.recipientLockMessage}</div>
                      </div>
                    ) : null}

                    <div className="col-12">
                      <label className="form-label">Nota per il cliente</label>
                      <input className="form-control" name="note" value={note} placeholder="(opzionale)" onChange={(e) => setNote(e.target.value)} />
                    </div>

                    <div className="col-12">
                      <label className="form-label">Messaggio di dedica (opzionale)</label>
                      <textarea
                        className="form-control"
                        name="gift_message"
                        rows={3}
                        placeholder={"Es. Buon compleanno!\nUn abbraccio..."}
                        value={giftMessage}
                        onChange={(e) => setGiftMessage(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="mt-3 d-flex gap-2">
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva
                    </button>
                    <a className="btn btn-outline-secondary" href={pageUrl("giftbox?tab=instances")}>
                      Torna alla lista
                    </a>
                  </div>
                </form>
              </div>

              <div className="card p-3 mb-3">
                <div className="h6 fw-semibold mb-2">Invio email al destinatario</div>

                <form
                  method="post"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post({ action: "send_email", send_to: sendTo, ...(showDetailsEmail ? { show_details: "1" } : {}), send_gift_message: sendGiftMessage });
                  }}
                >
                  <div className="row g-2">
                    <div className="col-12">
                      <label className="form-label">Email destinatario</label>
                      <input className="form-control" type="email" name="send_to" value={sendTo} required onChange={(e) => setSendTo(e.target.value)} />
                    </div>

                    <div className="col-12">
                      <div className="form-check">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          name="show_details"
                          value="1"
                          id="showDetailsEmailGb"
                          checked={showDetailsEmail}
                          onChange={(e) => setShowDetailsEmail(e.target.checked)}
                        />
                        <label className="form-check-label" htmlFor="showDetailsEmailGb">
                          Mostra contenuto nella mail
                        </label>
                      </div>
                      <div className="text-muted small">
                        Se disattivato, nella mail non verrà mostrato il contenuto della GiftBox: il destinatario dovrà recarsi in negozio per scoprirlo.
                      </div>
                    </div>

                    <div className="col-12">
                      <label className="form-label">Messaggio di dedica (opzionale)</label>
                      <textarea
                        className="form-control"
                        name="send_gift_message"
                        rows={3}
                        placeholder={"Es. Buon compleanno!\nUn abbraccio..."}
                        value={sendGiftMessage}
                        onChange={(e) => setSendGiftMessage(e.target.value)}
                      />
                      <div className="form-text">Verrà inserito nella mail e salvato nella GiftBox.</div>
                    </div>
                  </div>

                  <div className="mt-2 d-flex gap-2 align-items-center">
                    <button className="btn btn-primary" type="submit" disabled={d.emailSendDisabled || busy}>
                      Invia GiftBox via email
                    </button>
                    {d.lastEmailSentAtRaw !== "" ? (
                      <span className="text-muted small">
                        Ultimo invio: {d.lastEmailSentAtRaw} ({d.lastEmailSentTo})
                      </span>
                    ) : null}
                  </div>
                </form>
              </div>

              <div className="card p-3 mb-3">
                <div className="h6 fw-semibold mb-2">Operazioni</div>

                <div className="row g-3">
                  <div className="col-12">
                    <form id="redeem" method="post" className="border rounded p-2" onSubmit={submitPartialRedeem}>
                      <div className="fw-semibold mb-2">Riscatta GiftBox (anche parziale)</div>

                      {d.pendingUnits > 0 ? (
                        <div className="alert alert-warning py-2 small">
                          Le quantità disponibili escludono {d.pendingUnits} elemento/i già collegati a prenotazioni in attesa o prenotate.
                        </div>
                      ) : null}

                      {d.items.length === 0 ? (
                        <div className="text-muted small">Nessun contenuto configurato: impossibile riscattare.</div>
                      ) : (
                        <>
                          <div className="table-responsive">
                            <table className="table table-sm align-middle mb-0">
                              <thead>
                                <tr>
                                  <th>Elemento</th>
                                  <th className="text-end giftbox-redeem-total-col">Tot</th>
                                  <th className="text-end giftbox-redeem-used-col">Usati</th>
                                  <th className="text-end giftbox-redeem-action-col">Da riscattare</th>
                                </tr>
                              </thead>
                              <tbody>
                                {d.items.map((it) => {
                                  const rem = it.availableUnits;
                                  const remBase = Math.max(0, it.qty - it.redeemedUnits);
                                  return (
                                    <tr key={it.giftboxItemId} className={rem <= 0 ? "text-muted" : ""}>
                                      <td>
                                        {it.name}
                                        {rem <= 0 ? (
                                          <span className="badge text-bg-light ms-2">{it.pendingUnits > 0 && remBase > 0 ? "in sospeso" : "esaurito"}</span>
                                        ) : null}
                                        {it.pendingUnits > 0 ? <div className="small text-warning mt-1">{pendingHints.get(it.giftboxItemId)}</div> : null}
                                      </td>
                                      <td className="text-end">{it.qty}</td>
                                      <td className="text-end">{it.redeemedUnits}</td>
                                      <td className="text-end">
                                        {d.status !== "issued" || rem <= 0 ? (
                                          <input className="form-control form-control-sm text-end" type="number" value="0" disabled readOnly />
                                        ) : rem === 1 ? (
                                          <div className="form-check form-check-inline mb-0">
                                            <input
                                              className="form-check-input gb-redeem-input"
                                              type="checkbox"
                                              data-max="1"
                                              checked={(redeemQty[it.giftboxItemId] ?? 0) > 0}
                                              onChange={(e) => setRedeemQty((prev) => ({ ...prev, [it.giftboxItemId]: e.target.checked ? 1 : 0 }))}
                                            />
                                          </div>
                                        ) : (
                                          <input
                                            className="form-control form-control-sm text-end gb-redeem-input"
                                            type="number"
                                            min={0}
                                            max={rem}
                                            data-max={rem}
                                            value={String(redeemQty[it.giftboxItemId] ?? 0)}
                                            onChange={(e) =>
                                              setRedeemQty((prev) => ({ ...prev, [it.giftboxItemId]: Math.max(0, Math.min(rem, Number.parseInt(e.target.value, 10) || 0)) }))
                                            }
                                          />
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          <div className="mt-2">
                            <label className="form-label">Nota (opzionale)</label>
                            <input className="form-control" name="redeem_note" placeholder="Es. Appuntamento #123" value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} />
                          </div>

                          <div className="mt-2 d-flex flex-wrap gap-2">
                            <button className="btn btn-outline-primary" type="submit" disabled={d.status !== "issued" || d.availableUnits <= 0 || busy}>
                              Registra riscatto
                            </button>
                            <button
                              className="btn btn-outline-secondary"
                              type="button"
                              disabled={d.status !== "issued" || d.availableUnits <= 0}
                              onClick={() => setAllRemaining(true)}
                            >
                              Seleziona tutti i rimanenti
                            </button>
                            <button
                              className="btn btn-outline-light"
                              type="button"
                              disabled={d.status !== "issued" || d.availableUnits <= 0}
                              onClick={() => setAllRemaining(false)}
                            >
                              Svuota selezione
                            </button>
                          </div>

                          <div className="text-muted small mt-2">
                            La GiftBox verrà segnata come <strong>riscattata</strong> solo quando tutti gli elementi risultano utilizzati.
                          </div>

                          {d.status === "redeemed" ? <div className="text-muted small mt-2">Riscattata: {d.redeemedAtRaw !== "" ? d.redeemedAtRaw : "—"}</div> : null}
                        </>
                      )}
                    </form>
                  </div>
                </div>
              </div>

              <div className="card p-3 mb-3">
                <div className="h6 fw-semibold mb-2">Nota interna</div>
                <form
                  method="post"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void post({ action: "update_instance_internal_note", internal_note: internalNote });
                  }}
                >
                  <textarea className="form-control" name="internal_note" rows={4} placeholder="(opzionale)" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
                  <div className="form-text">Nota visibile solo nel backend. Può essere impostata in fase di emissione (POS) o modificata da qui.</div>

                  <div className="mt-2">
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva note
                    </button>
                  </div>
                </form>
              </div>
            </div>

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
                        <th className="text-end">Quantità</th>
                        <th>Servizio/Prodotto</th>
                        <th>Sede</th>
                        <th>Nota</th>
                        <th>Operatore</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.movements.map((m, idx) => (
                        <tr key={idx}>
                          <td className="text-muted">{m.atLabel}</td>
                          <td className="fw-semibold">{m.type}</td>
                          <td className="text-end">
                            <span className={`fw-semibold ${m.amount > 0 ? "text-success" : m.amount < 0 ? "text-danger" : ""}`}>{m.amount}</span>
                          </td>
                          <td className="text-muted">{m.serviceProduct}</td>
                          <td className="text-muted">{m.locationLabel}</td>
                          <td className="text-muted">{m.note}</td>
                          <td className="text-muted">{m.operatorName}</td>
                        </tr>
                      ))}
                      {d.movements.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-muted p-3">
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
        </>
      )}
    </div>
  );
}
