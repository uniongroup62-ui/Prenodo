"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP giftbox instance DETAIL (giftbox.php tab=instances
// action=edit_instance): card riepilogo (Codice+badge, Evento, Emessa il,
// Inizio validità, Scadenza con matita → modale, Riscatto X/Y, Contenuto
// regalo), form "Dati GiftBox" (Mittente, Evento, Sede emissione, Nascondi
// importo, Destinatario+cliente con alert legacy, Nota, Messaggio di dedica),
// "Invio email al destinatario", "Operazioni" col riscatto PARZIALE per-item
// (Elemento|Tot|Usati|Da riscattare + Seleziona tutti/Svuota), "Nota interna"
// e colonna destra "Movimenti" (Data|Tipo|Quantità|Servizio/Prodotto|Sede|
// Nota|Operatore). Header legacy con [Lista GiftBox][Dettagli vendita]
// [Voucher][Impostazioni][Crea GiftBox]. NOTA PARITÀ: il legacy NON ha un
// bottone "Annulla GiftBox" in questa vista (nessun _mode di cancel).

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
  type: string;
  qty: number | null;
  amount: number | null;
  itemLabel: string;
  locationName: string;
  note: string;
  operatorName: string;
};

type Detail = {
  id: number;
  code: string;
  publicToken: string;
  giftboxName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  eventType: string;
  eventLabel: string;
  senderClientId: number;
  senderName: string;
  recipientClientId: number;
  recipientName: string;
  recipientEmail: string;
  recipientClient: { id: number; name: string; email: string; phone: string } | null;
  locationName: string;
  voucherHideAmount: boolean;
  note: string;
  giftMessage: string;
  internalNote: string;
  issuedAt: string;
  validFrom: string;
  expiresAt: string;
  redeemedAt: string;
  scheduledSendOn: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  lastEmailShowDetails: boolean;
  linkedSaleId: number | null;
  items: DetailItem[];
  totalUnits: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  partial: boolean;
  movements: Movement[];
  canEdit: boolean;
  canRedeem: boolean;
  expiryEditable: boolean;
  expiryLockedReason: string;
};

type ClientOpt = { id: number; name: string };
type EventOpt = { key: string; label: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function currentId(): number {
  if (typeof window === "undefined") return 0;
  return Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10) || 0;
}
function fmtDmy(iso: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}
function fmtDmyHm(iso: string): string {
  if (!iso) return "—";
  const d = fmtDmy(iso);
  const t = iso.slice(11, 16);
  return t ? `${d} ${t}` : d;
}

export function GiftBoxInstanceDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [id] = useState<number>(currentId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [events, setEvents] = useState<EventOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  // Form "Dati GiftBox".
  const [senderClientId, setSenderClientId] = useState(0);
  const [eventType, setEventType] = useState("giftcard");
  const [hideAmount, setHideAmount] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientIsClient, setRecipientIsClient] = useState(false);
  const [recipientClientId, setRecipientClientId] = useState(0);
  const [recipientSearch, setRecipientSearch] = useState("");
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

  const applyDetail = useCallback((d: Detail) => {
    setDetail(d);
    setSenderClientId(d.senderClientId);
    setEventType(d.eventType || "giftcard");
    setHideAmount(d.voucherHideAmount);
    setRecipientName(d.recipientName);
    setRecipientEmail(d.recipientEmail);
    setRecipientIsClient(d.recipientClientId > 0);
    setRecipientClientId(d.recipientClientId);
    setSendTo(d.recipientEmail);
    setShowDetailsEmail(d.lastEmailShowDetails);
    setNote(d.note);
    setGiftMessage(d.giftMessage);
    setInternalNote(d.internalNote);
    setExpiryValue(d.expiresAt || "");
    setRedeemQty({});
  }, []);

  useEffect(() => {
    if (!slug || id <= 0) return;
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=edit_instance&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || !j.detail) {
          setError(String(j.error ?? "GiftBox non trovata."));
          return;
        }
        applyDetail(j.detail as Detail);
        setClients(Array.isArray(j.clients) ? j.clients : []);
        setEvents(Array.isArray(j.events) ? j.events : []);
      })
      .catch(() => setError("Errore nel caricamento della GiftBox."))
      .finally(() => setLoading(false));
  }, [slug, id, applyDetail]);

  async function post(payload: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ instance_id: String(id), ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Operazione non riuscita."));
        return false;
      }
      if (j.detail) applyDetail(j.detail as Detail);
      if (j.message) setFlash(String(j.message));
      return true;
    } catch {
      setError("Errore di rete.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${suffix.replace("&", "?")}`;
  }
  const voucherHref = detail ? `/${encodeURIComponent(slug)}/giftbox_voucher?public=1&embed=1&token=${encodeURIComponent(detail.publicToken)}` : "#";
  const readOnly = detail ? !detail.canEdit : true;

  const recipientResults = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase();
    if (q === "") return [];
    return clients.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [clients, recipientSearch]);
  const selectedRecipient =
    detail?.recipientClient && recipientClientId === detail.recipientClient.id ? detail.recipientClient : clients.find((c) => c.id === recipientClientId) ?? null;

  function setAllRemaining(fill: boolean) {
    if (!detail) return;
    const next: Record<number, number> = {};
    if (fill) for (const it of detail.items) if (it.availableUnits > 0) next[it.rowId] = it.availableUnits;
    setRedeemQty(next);
  }

  async function submitPartialRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (typeof window !== "undefined" && !window.confirm("Registrare il riscatto selezionato?")) return;
    await post({ action: "redeem_instance_partial", redeem_qty_json: JSON.stringify(redeemQty), redeem_note: redeemNote });
    setRedeemNote("");
  }

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
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary btn-pill" href={href("giftbox&tab=instances")}>
              <i className="bi bi-arrow-left me-1" />
              Lista GiftBox
            </a>
            {detail?.linkedSaleId ? (
              <a className="btn btn-outline-secondary btn-pill" href={href(`pos_sale_detail&id=${detail.linkedSaleId}`)}>
                <i className="bi bi-receipt me-1" />
                Dettagli vendita
              </a>
            ) : (
              <a className="btn btn-outline-secondary btn-pill disabled" href="#" tabIndex={-1} aria-disabled="true" title="Vendita non trovata">
                <i className="bi bi-receipt me-1" />
                Dettagli vendita
              </a>
            )}
            {detail ? (
              <a className="btn btn-outline-secondary btn-pill" target="_blank" rel="noopener" href={voucherHref}>
                <i className="bi bi-printer me-1" />
                Voucher
              </a>
            ) : null}
            <a className="btn btn-outline-secondary btn-pill" href={href("giftbox_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
            <a className="btn btn-primary btn-pill" href={href("pos")}>
              <i className="bi bi-plus-lg me-1" />
              Crea GiftBox
            </a>
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : !detail ? null : (
        <div className="row g-3">
          <div className="col-lg-5">
            {/* ===== Card riepilogo ===== */}
            <div className="card p-3 mb-3">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="text-muted small">Codice</div>
                  <h5 className="fw-bold mb-0">{detail.code || `Istanza #${detail.id}`}</h5>
                </div>
                <span className={`badge ${detail.statusBadge}`}>{detail.statusLabel}</span>
              </div>

              <div className="row g-3 mt-1">
                <div className="col-md-6">
                  <div className="text-muted small">Evento</div>
                  <div>{detail.eventLabel}</div>
                </div>
                <div className="col-md-6">
                  <div className="text-muted small">Emessa il</div>
                  <div>{fmtDmy(detail.issuedAt)}</div>
                </div>
                <div className="col-md-6">
                  <div className="text-muted small">Inizio validità</div>
                  <div>{fmtDmy(detail.validFrom)}</div>
                </div>
                <div className="col-md-6">
                  <div className="text-muted small">Scadenza</div>
                  <div className="d-flex align-items-center gap-2">
                    <span>{detail.expiresAt ? fmtDmy(detail.expiresAt) : "—"}</span>
                    {detail.expiryEditable ? (
                      <button type="button" className="btn btn-sm btn-outline-secondary" title="Modifica scadenza" onClick={() => setExpiryOpen(true)}>
                        <i className="bi bi-pencil" />
                      </button>
                    ) : null}
                  </div>
                </div>
                {detail.totalUnits > 0 ? (
                  <div className="col-12">
                    <div className="text-muted small">Riscatto</div>
                    <div>
                      {detail.redeemedUnits} / {detail.totalUnits} utilizzati · {detail.availableUnits} disponibili
                      {detail.pendingUnits > 0 ? ` · ${detail.pendingUnits} in sospeso su prenotazioni` : ""}
                      {detail.partial ? <span className="badge text-bg-secondary ms-2">PARZIALE</span> : null}
                    </div>
                  </div>
                ) : null}
                <div className="col-12">
                  <div className="text-muted small">Contenuto regalo</div>
                  <ul className="mb-0">
                    {detail.items.map((it) => (
                      <li key={it.rowId}>
                        {it.name} — {it.qty}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* ===== Card "Dati GiftBox" ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Dati GiftBox</h6>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({
                    action: "update_instance",
                    client_id: String(senderClientId),
                    event_type: eventType,
                    voucher_hide_amount: hideAmount ? "1" : "0",
                    recipient_client_id: recipientIsClient ? String(recipientClientId) : "0",
                    recipient_name: recipientName,
                    recipient_email: recipientEmail,
                    note,
                    gift_message: giftMessage,
                  });
                }}
              >
                <div className="row g-3">
                  <div className="col-12">
                    <label className="form-label">Mittente</label>
                    <select className="form-select" value={String(senderClientId)} disabled={readOnly} onChange={(e) => setSenderClientId(Number(e.target.value) || 0)}>
                      <option value="0" disabled>
                        — seleziona —
                      </option>
                      {clients.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-md-6">
                    <label className="form-label">Evento</label>
                    <select className="form-select" value={eventType} disabled={readOnly} onChange={(e) => setEventType(e.target.value)}>
                      {events.map((ev) => (
                        <option value={ev.key} key={ev.key}>
                          {ev.key === "giftcard" ? "GiftBox (generica)" : ev.label}
                        </option>
                      ))}
                    </select>
                    <div className="form-text">Template grafico per email (e voucher).</div>
                  </div>
                  {detail.locationName !== "" ? (
                    <div className="col-md-6">
                      <label className="form-label">Sede emissione</label>
                      <input className="form-control" value={detail.locationName} readOnly />
                      <div className="form-text">La sede di emissione resta storica; i riscatti vengono tracciati nella sede di utilizzo.</div>
                    </div>
                  ) : null}

                  <div className="col-12">
                    <label className="form-label">Voucher (destinatario)</label>
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="editGbVoucherHideAmount"
                        checked={hideAmount}
                        disabled={readOnly}
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
                      placeholder="Nome destinatario"
                      value={recipientName}
                      readOnly={readOnly || recipientIsClient}
                      onChange={(e) => setRecipientName(e.target.value)}
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Email destinatario (opzionale)</label>
                    <input
                      className="form-control"
                      type="email"
                      value={recipientEmail}
                      readOnly={readOnly || recipientIsClient}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                    />
                  </div>

                  <div className="col-12">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="gbRecipientExistingToggle"
                        checked={recipientIsClient}
                        disabled={readOnly}
                        onChange={(e) => {
                          setRecipientIsClient(e.target.checked);
                          if (!e.target.checked) setRecipientClientId(0);
                        }}
                      />
                      <label className="form-check-label" htmlFor="gbRecipientExistingToggle">
                        Destinatario già cliente
                      </label>
                    </div>
                  </div>

                  {recipientIsClient ? (
                    <div className="col-12">
                      {selectedRecipient ? (
                        <div className="border rounded p-2">
                          <div className="d-flex justify-content-between align-items-start">
                            <div>
                              <div className="fw-semibold">{selectedRecipient.name}</div>
                              <div className="text-muted small">
                                #{recipientClientId}
                                {(selectedRecipient as { email?: string }).email ? ` • ${(selectedRecipient as { email?: string }).email}` : ""}
                                {(selectedRecipient as { phone?: string }).phone ? ` • ${(selectedRecipient as { phone?: string }).phone}` : ""}
                              </div>
                            </div>
                            {!readOnly ? (
                              <button type="button" className="btn btn-sm btn-outline-danger" title="Rimuovi" onClick={() => setRecipientClientId(0)}>
                                <i className="bi bi-x" />
                              </button>
                            ) : null}
                          </div>
                          <div className="alert alert-info py-2 px-3 mt-2 mb-0 small">
                            La GiftBox sarà associata al destinatario selezionato. Eventuali punti e omaggi della vendita resteranno accreditati solo al mittente (se aderisce
                            alla Fidelity).
                          </div>
                        </div>
                      ) : (
                        <>
                          <input
                            className="form-control"
                            placeholder="Cerca per nome, email o telefono…"
                            value={recipientSearch}
                            disabled={readOnly}
                            onChange={(e) => setRecipientSearch(e.target.value)}
                          />
                          {recipientResults.length > 0 ? (
                            <div className="list-group mt-1 giftbox-recipient-results">
                              {recipientResults.map((c) => (
                                <button
                                  type="button"
                                  className="list-group-item list-group-item-action"
                                  key={c.id}
                                  onClick={() => {
                                    setRecipientClientId(c.id);
                                    setRecipientSearch("");
                                  }}
                                >
                                  {c.name} <span className="text-muted small">#{c.id}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}

                  <div className="col-12">
                    <label className="form-label">Nota per il cliente</label>
                    <input className="form-control" placeholder="(opzionale)" value={note} readOnly={readOnly} onChange={(e) => setNote(e.target.value)} />
                  </div>
                  <div className="col-12">
                    <label className="form-label">Messaggio di dedica (opzionale)</label>
                    <textarea
                      className="form-control"
                      rows={3}
                      placeholder={"Es. Buon compleanno!\nUn abbraccio…"}
                      value={giftMessage}
                      readOnly={readOnly}
                      onChange={(e) => setGiftMessage(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-3 d-flex gap-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy || readOnly}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva
                  </button>
                  <a className="btn btn-outline-secondary btn-pill" href={href("giftbox&tab=instances")}>
                    Torna alla lista
                  </a>
                </div>
              </form>
            </div>

            {/* ===== Invio email al destinatario ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Invio email al destinatario</h6>
              {detail.scheduledSendOn && !detail.lastEmailSentAt ? <div className="alert alert-info py-2">Invio programmato: {fmtDmy(detail.scheduledSendOn)}</div> : null}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({ action: "send_email", send_to: sendTo, show_details: showDetailsEmail ? "1" : "0", send_gift_message: sendGiftMessage });
                }}
              >
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Email destinatario</label>
                    <input className="form-control" type="email" required value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
                  </div>
                  <div className="col-md-6">
                    <div className="form-check mt-4">
                      <input className="form-check-input" type="checkbox" id="showDetailsEmailGb" checked={showDetailsEmail} onChange={(e) => setShowDetailsEmail(e.target.checked)} />
                      <label className="form-check-label" htmlFor="showDetailsEmailGb">
                        Mostra contenuto nella mail
                      </label>
                    </div>
                    <div className="form-text">
                      Se disattivato, nella mail non verrà mostrato il contenuto della GiftBox: il destinatario dovrà recarsi in negozio per scoprirlo.
                    </div>
                  </div>
                  <div className="col-12">
                    <textarea
                      className="form-control"
                      rows={2}
                      placeholder="Messaggio di dedica nella mail (opzionale)"
                      value={sendGiftMessage}
                      onChange={(e) => setSendGiftMessage(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy || detail.status === "cancelled" || detail.status === "expired"}>
                    <i className="bi bi-envelope me-1" />
                    Invia GiftBox via email
                  </button>
                  {detail.lastEmailSentAt ? (
                    <div className="text-muted small mt-2">
                      Ultimo invio: {fmtDmyHm(detail.lastEmailSentAt)} ({detail.lastEmailSentTo})
                    </div>
                  ) : null}
                </div>
              </form>
            </div>

            {/* ===== Operazioni: riscatto parziale ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Riscatta GiftBox (anche parziale)</h6>
              {detail.pendingUnits > 0 ? (
                <div className="alert alert-warning py-2">
                  Le quantità disponibili escludono {detail.pendingUnits} elemento/i già collegati a prenotazioni in attesa o prenotate.
                </div>
              ) : null}
              {detail.items.length === 0 ? (
                <div className="text-muted small">Nessun contenuto configurato: impossibile riscattare.</div>
              ) : detail.status === "redeemed" ? (
                <div className="text-muted small">Riscattata: {fmtDmyHm(detail.redeemedAt)}</div>
              ) : (
                <form onSubmit={submitPartialRedeem}>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle">
                      <thead>
                        <tr>
                          <th>Elemento</th>
                          <th className="text-end giftbox-redeem-total-col">Tot</th>
                          <th className="text-end giftbox-redeem-used-col">Usati</th>
                          <th className="text-end giftbox-redeem-action-col">Da riscattare</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.items.map((it) => (
                          <tr key={it.rowId}>
                            <td>
                              {it.name}
                              {it.availableUnits <= 0 ? (
                                <span className={`badge ms-2 ${it.pendingUnits > 0 ? "text-bg-warning" : "text-bg-secondary"}`}>
                                  {it.pendingUnits > 0 ? "in sospeso" : "esaurito"}
                                </span>
                              ) : null}
                              {it.pendingUnits > 0 && it.pendingAppointments.length > 0 ? (
                                <div className="text-muted small">
                                  {it.pendingUnits} in sospeso su prenotaz. {it.pendingAppointments.join(", ")}
                                </div>
                              ) : null}
                            </td>
                            <td className="text-end">{it.qty}</td>
                            <td className="text-end">{it.redeemedUnits}</td>
                            <td className="text-end">
                              <input
                                className="form-control form-control-sm text-end gb-redeem-input d-inline-block"
                                style={{ maxWidth: "6rem" }}
                                type="number"
                                min={0}
                                max={it.availableUnits}
                                disabled={busy || it.availableUnits <= 0 || !detail.canRedeem}
                                value={String(redeemQty[it.rowId] ?? 0)}
                                onChange={(e) => setRedeemQty((prev) => ({ ...prev, [it.rowId]: Math.max(0, Math.min(it.availableUnits, Number(e.target.value) || 0)) }))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="row g-2 align-items-end">
                    <div className="col-md-6">
                      <label className="form-label small">Nota</label>
                      <input className="form-control form-control-sm" placeholder="Es. Appuntamento #123" value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} />
                    </div>
                    <div className="col-md-6 d-flex gap-2 justify-content-end flex-wrap">
                      <button className="btn btn-sm btn-outline-secondary" type="button" disabled={busy} onClick={() => setAllRemaining(true)}>
                        Seleziona tutti i rimanenti
                      </button>
                      <button className="btn btn-sm btn-outline-secondary" type="button" disabled={busy} onClick={() => setAllRemaining(false)}>
                        Svuota selezione
                      </button>
                      <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !detail.canRedeem}>
                        Registra riscatto
                      </button>
                    </div>
                  </div>
                  <div className="text-muted small mt-2">
                    La GiftBox verrà segnata come <strong>riscattata</strong> solo quando tutti gli elementi risultano utilizzati.
                  </div>
                </form>
              )}
            </div>

            {/* ===== Nota interna ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Nota interna</h6>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({ action: "update_instance_internal_note", internal_note: internalNote });
                }}
              >
                <textarea className="form-control" rows={4} placeholder="(opzionale)" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
                <div className="form-text">Nota visibile solo nel backend. Può essere impostata in fase di emissione (POS) o modificata da qui.</div>
                <div className="mt-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy}>
                    Salva note
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* ===== Colonna destra: Movimenti ===== */}
          <div className="col-lg-7">
            <div className="card">
              <div className="card-header fw-semibold">Movimenti</div>
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
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
                    {detail.movements.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-muted p-3">
                          Nessun movimento.
                        </td>
                      </tr>
                    ) : (
                      detail.movements.map((m, idx) => (
                        <tr key={idx}>
                          <td className="text-muted small">{fmtDmyHm(m.at)}</td>
                          <td className="small">{m.type}</td>
                          <td className={`text-end small ${m.type === "issue" ? "text-success" : m.type === "redeem" ? "text-danger" : ""}`}>{m.qty ?? "—"}</td>
                          <td className="text-muted small">{m.itemLabel}</td>
                          <td className="text-muted small">{m.locationName || "—"}</td>
                          <td className="text-muted small">{m.note || "—"}</td>
                          <td className="text-muted small">{m.operatorName || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Modale "Modifica scadenza GiftBox" ===== */}
      {expiryOpen && detail ? (
        <div className="modal fade show d-block" id="modalGiftBoxExpiry" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <form
              className="modal-content"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await post({ action: "update_instance_expiry", expires_at: expiryValue });
                if (ok) setExpiryOpen(false);
              }}
            >
              <div className="modal-header">
                <h5 className="modal-title">Modifica scadenza GiftBox</h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setExpiryOpen(false)} />
              </div>
              <div className="modal-body">
                <div className="mb-2">
                  <span className="text-muted">Scadenza attuale:</span> <strong>{detail.expiresAt ? fmtDmy(detail.expiresAt) : "—"}</strong>
                </div>
                <label className="form-label">Nuova scadenza</label>
                <input className="form-control" type="date" required min={new Date().toISOString().slice(0, 10)} value={expiryValue} onChange={(e) => setExpiryValue(e.target.value)} />
                <div className="form-text">
                  Non puoi selezionare una data precedente a oggi. La data deve inoltre rispettare l&apos;inizio validità dell&apos;istanza. Puoi estendere la scadenza anche
                  oltre la validità massima del template GiftBox; se la GiftBox è scaduta verrà riattivata automaticamente.
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setExpiryOpen(false)}>
                  Annulla
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva scadenza
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
