"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP giftcard DETAIL (giftcard.php action=edit): card
// riepilogo (Codice+badge, Importo iniziale, Saldo, Emessa il, Scadenza con
// matita → modale, Evento, Sede emissione, Voucher importo nascosto/visibile,
// Contenuto regalo, Messaggio di dedica), form "Dati GiftCard" (Mittente,
// Evento, Nascondi importo, Destinatario+cliente con alert legacy, Nota,
// Dedica), "Invio email al destinatario" (Mostra importo e contenuto),
// "Operazioni" (Riscatta scala credito + riscatto per-item quando la card ha
// voci servizi/prodotti), "Nota interna" e "Movimenti" (Data|Tipo|Importo|
// Sede|Nota|Operatore). Topup + cancel restano assenti (disabilitati anche
// nel legacy). Header legacy: [Torna alla lista][Dettaglio vendita][Voucher]
// [Crea GiftCard].

type DetailItem = { rowId: number; itemType: string; name: string; qty: number; redeemedQty: number; remainingQty: number };

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
  initialAmount: number;
  balance: number;
  note: string;
  giftMessage: string;
  internalNote: string;
  issuedAt: string;
  expiresAt: string;
  scheduledSendOn: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  lastEmailShowAmount: boolean;
  linkedSaleId: number | null;
  items: DetailItem[];
  hasMoney: boolean;
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
function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export function GiftCardDetailContent({ slug: slugProp }: { slug?: string } = {}) {
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

  // Form "Dati GiftCard".
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
  // Modale scadenza + email + operazioni + nota interna.
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiryValue, setExpiryValue] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [showAmountEmail, setShowAmountEmail] = useState(true);
  const [sendGiftMessage, setSendGiftMessage] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemNote, setRedeemNote] = useState("");
  const [itemQty, setItemQty] = useState<Record<number, number>>({});
  const [itemNote, setItemNote] = useState<Record<number, string>>({});
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
    setShowAmountEmail(d.lastEmailShowAmount);
    setNote(d.note);
    setGiftMessage(d.giftMessage);
    setInternalNote(d.internalNote);
    setExpiryValue(d.expiresAt || "");
  }, []);

  useEffect(() => {
    if (!slug || id <= 0) return;
    fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}&action=view&id=${id}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok || !j.detail) {
          setError(String(j.error ?? "GiftCard non trovata."));
          return;
        }
        applyDetail(j.detail as Detail);
        setClients(Array.isArray(j.clients) ? j.clients : []);
        setEvents(Array.isArray(j.events) ? j.events : []);
      })
      .catch(() => setError("Errore nel caricamento della GiftCard."))
      .finally(() => setLoading(false));
  }, [slug, id, applyDetail]);

  async function post(payload: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/giftcards?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ id: String(id), ...payload }),
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
  const voucherHref = detail ? `/${encodeURIComponent(slug)}/giftcard_voucher?public=1&embed=1&token=${encodeURIComponent(detail.publicToken)}` : "#";
  const readOnly = detail ? !detail.canEdit : true;
  const opsDisabled = detail ? detail.status === "cancelled" || detail.status === "expired" : true;

  const recipientResults = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase();
    if (q === "") return [];
    return clients.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [clients, recipientSearch]);
  const selectedRecipient =
    detail?.recipientClient && recipientClientId === detail.recipientClient.id ? detail.recipientClient : clients.find((c) => c.id === recipientClientId) ?? null;

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
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary btn-pill" href={href("giftcard")}>
              <i className="bi bi-arrow-left me-1" />
              Torna alla lista
            </a>
            {detail?.linkedSaleId ? (
              <a className="btn btn-outline-secondary btn-pill" href={href(`pos_sale_detail&id=${detail.linkedSaleId}`)}>
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            ) : (
              <a className="btn btn-outline-secondary btn-pill disabled" href="#" tabIndex={-1} aria-disabled="true" title="Vendita non trovata">
                <i className="bi bi-receipt me-1" />
                Dettaglio vendita
              </a>
            )}
            {detail ? (
              <a className="btn btn-outline-secondary btn-pill" target="_blank" rel="noopener" href={voucherHref}>
                <i className="bi bi-printer me-1" />
                Voucher
              </a>
            ) : null}
            <a className="btn btn-primary btn-pill" href={href("pos")}>
              <i className="bi bi-plus-lg me-1" />
              Crea GiftCard
            </a>
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}
      {detail && detail.status === "cancelled" ? (
        <div className="alert alert-warning">GiftCard annullata: dati, note, invii email e operazioni non sono modificabili.</div>
      ) : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : !detail ? null : (
        <div className="row g-3">
          <div className="col-lg-7">
            {/* ===== Card riepilogo ===== */}
            <div className="card p-3 mb-3">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="text-muted small">Codice</div>
                  <h5 className="fw-bold mb-0">{detail.code}</h5>
                </div>
                <span className={`badge ${detail.statusBadge}`}>{detail.statusLabel}</span>
              </div>

              <div className="row g-3 mt-1">
                <div className="col-md-6">
                  <div className="text-muted small">Importo iniziale</div>
                  <div>€ {fmtMoney(detail.initialAmount)}</div>
                </div>
                <div className="col-md-6">
                  <div className="text-muted small">Saldo</div>
                  <div className="fw-semibold">€ {fmtMoney(detail.balance)}</div>
                </div>
                <div className="col-md-6">
                  <div className="text-muted small">Emessa il</div>
                  <div>{fmtDmy(detail.issuedAt)}</div>
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
                <div className="col-md-6">
                  <div className="text-muted small">Evento</div>
                  <div>{detail.eventLabel}</div>
                </div>
                {detail.locationName !== "" ? (
                  <div className="col-md-6">
                    <div className="text-muted small">Sede emissione</div>
                    <div>{detail.locationName}</div>
                  </div>
                ) : null}
                <div className="col-md-6">
                  <div className="text-muted small">Voucher (destinatario)</div>
                  <div>{detail.voucherHideAmount ? "Importo nascosto" : "Importo visibile"}</div>
                </div>
                {detail.items.length > 0 ? (
                  <div className="col-12">
                    <div className="text-muted small">Contenuto regalo</div>
                    <ul className="mb-0">
                      {detail.items.map((it) => (
                        <li key={it.rowId}>
                          {it.itemType === "product" ? "Prodotto" : it.itemType === "service" ? "Servizio" : "Item"}: {it.name} — {it.qty} (residuo {it.remainingQty})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {detail.giftMessage !== "" ? (
                  <div className="col-12">
                    <div className="text-muted small">Messaggio di dedica</div>
                    <div className="giftcard-prewrap">{detail.giftMessage}</div>
                  </div>
                ) : null}
              </div>
            </div>

            {/* ===== Card "Dati GiftCard" ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Dati GiftCard</h6>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({
                    action: "update",
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
                          {ev.label}
                        </option>
                      ))}
                    </select>
                    <div className="form-text">Template grafico per email (e voucher).</div>
                  </div>
                  {detail.locationName !== "" ? (
                    <div className="col-md-6">
                      <label className="form-label">Sede emissione</label>
                      <input className="form-control" value={detail.locationName} readOnly />
                      <div className="form-text">La sede di emissione resta storica; gli utilizzi vengono tracciati nella sede corrente.</div>
                    </div>
                  ) : null}

                  <div className="col-12">
                    <label className="form-label">Voucher (destinatario)</label>
                    <div className="form-check">
                      <input className="form-check-input" type="checkbox" id="editVoucherHideAmount" checked={hideAmount} disabled={readOnly} onChange={(e) => setHideAmount(e.target.checked)} />
                      <label className="form-check-label" htmlFor="editVoucherHideAmount">
                        Nascondi importo nel voucher pubblico (QR)
                      </label>
                    </div>
                    <div className="form-text">Se attivo, nel voucher pubblico aperto dal QR/link non verrà mostrato importo e saldo.</div>
                  </div>

                  <div className="col-md-6">
                    <label className="form-label">Destinatario</label>
                    <input className="form-control" value={recipientName} readOnly={readOnly || recipientIsClient} onChange={(e) => setRecipientName(e.target.value)} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Email destinatario</label>
                    <input className="form-control" type="email" value={recipientEmail} readOnly={readOnly || recipientIsClient} onChange={(e) => setRecipientEmail(e.target.value)} />
                  </div>

                  <div className="col-12">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="gcRecipientExistingToggle"
                        checked={recipientIsClient}
                        disabled={readOnly}
                        onChange={(e) => {
                          setRecipientIsClient(e.target.checked);
                          if (!e.target.checked) setRecipientClientId(0);
                        }}
                      />
                      <label className="form-check-label" htmlFor="gcRecipientExistingToggle">
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
                            La GiftCard sarà associata al destinatario selezionato. Eventuali punti e omaggi della vendita resteranno accreditati solo al mittente (se aderisce
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
                            <div className="list-group mt-1 giftcard-recipient-results">
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
                  <a className="btn btn-outline-secondary btn-pill" href={href("giftcard")}>
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
                  await post({ action: "send_email", send_to: sendTo, show_amount: showAmountEmail ? "1" : "0", send_gift_message: sendGiftMessage });
                }}
              >
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Email destinatario</label>
                    <input className="form-control" type="email" required value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
                  </div>
                  <div className="col-md-6">
                    <div className="form-check mt-4">
                      <input className="form-check-input" type="checkbox" id="showAmountEmail" checked={showAmountEmail} onChange={(e) => setShowAmountEmail(e.target.checked)} />
                      <label className="form-check-label" htmlFor="showAmountEmail">
                        Mostra importo e contenuto nella mail
                      </label>
                    </div>
                    <div className="form-text">
                      Se disattivato, nella mail non verrà mostrato l&apos;importo (né i dettagli): il destinatario dovrà recarsi in negozio per scoprirli.
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
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy || opsDisabled}>
                    <i className="bi bi-envelope me-1" />
                    Invia GiftCard via email
                  </button>
                  {detail.lastEmailSentAt ? (
                    <div className="text-muted small mt-2">
                      Ultimo invio: {fmtDmyHm(detail.lastEmailSentAt)} ({detail.lastEmailSentTo})
                    </div>
                  ) : null}
                </div>
              </form>
            </div>

            {/* ===== Operazioni ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Operazioni</h6>
              {detail.hasMoney ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const ok = await post({ action: "redeem", redeem_amount: redeemAmount.replace(",", "."), redeem_note: redeemNote });
                    if (ok) {
                      setRedeemAmount("");
                      setRedeemNote("");
                    }
                  }}
                >
                  <div className="fw-semibold small mb-2">Riscatta (scala credito)</div>
                  <div className="row g-2 align-items-end">
                    <div className="col-md-4">
                      <label className="form-label small">Importo</label>
                      <div className="input-group">
                        <span className="input-group-text">€</span>
                        <input className="form-control" type="number" step="0.01" min="0" required value={redeemAmount} onChange={(e) => setRedeemAmount(e.target.value)} />
                      </div>
                    </div>
                    <div className="col-md-5">
                      <label className="form-label small">Nota</label>
                      <input className="form-control" value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} />
                    </div>
                    <div className="col-md-3">
                      <button className="btn btn-primary w-100" type="submit" disabled={busy || opsDisabled || !detail.canRedeem}>
                        Registra riscatto
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <div>
                  <div className="fw-semibold small mb-1">Riscatta credito</div>
                  <div className="text-muted small">Questa GiftCard non ha credito monetario associato (solo servizi/prodotti).</div>
                </div>
              )}

              {detail.items.length > 0 ? (
                <div className="mt-3">
                  <div className="fw-semibold small mb-1">Riscatta servizi/prodotti</div>
                  <div className="text-muted small mb-2">
                    Usa questa sezione quando la GiftCard è stata emessa come voucher per servizi/prodotti (importo anche 0).
                  </div>
                  {detail.items.map((it) => (
                    <form
                      key={it.rowId}
                      className="row g-2 align-items-end border rounded p-2 mb-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await post({ action: "redeem_item", item_row_id: String(it.rowId), item_qty: String(itemQty[it.rowId] ?? 1), item_note: itemNote[it.rowId] ?? "" });
                      }}
                    >
                      <div className="col-md-5">
                        <span className="badge text-bg-light me-1">{it.itemType === "product" ? "Prodotto" : it.itemType === "service" ? "Servizio" : "Item"}</span>
                        {it.name} <span className="text-muted small">(residuo {it.remainingQty} / {it.qty})</span>
                      </div>
                      <div className="col-md-2">
                        <input
                          className="form-control form-control-sm"
                          type="number"
                          min={1}
                          max={it.remainingQty}
                          disabled={it.remainingQty <= 0}
                          value={String(itemQty[it.rowId] ?? 1)}
                          onChange={(e) => setItemQty((prev) => ({ ...prev, [it.rowId]: Math.max(1, Number(e.target.value) || 1) }))}
                        />
                      </div>
                      <div className="col-md-3">
                        <input
                          className="form-control form-control-sm"
                          placeholder="Nota"
                          value={itemNote[it.rowId] ?? ""}
                          onChange={(e) => setItemNote((prev) => ({ ...prev, [it.rowId]: e.target.value }))}
                        />
                      </div>
                      <div className="col-md-2">
                        <button className="btn btn-sm btn-outline-primary w-100" type="submit" disabled={busy || it.remainingQty <= 0 || opsDisabled}>
                          Segna come utilizzato
                        </button>
                      </div>
                    </form>
                  ))}
                </div>
              ) : null}
            </div>

            {/* ===== Nota interna ===== */}
            <div className="card p-3 mb-3">
              <h6 className="fw-bold">Nota interna</h6>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({ action: "update_internal_note", internal_note: internalNote });
                }}
              >
                <textarea className="form-control" rows={4} placeholder="(opzionale)" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
                <div className="form-text">Nota visibile solo nel backend. Può essere impostata in fase di emissione (POS) o modificata da qui.</div>
                <div className="mt-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={busy}>
                    Salva nota
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* ===== Colonna destra: Movimenti ===== */}
          <div className="col-lg-5">
            <div className="card">
              <div className="card-header fw-semibold">Movimenti</div>
              <div className="table-responsive">
                <table className="table table-sm mb-0 align-middle">
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
                    {detail.movements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted p-3">
                          Nessun movimento.
                        </td>
                      </tr>
                    ) : (
                      detail.movements.map((m, idx) => (
                        <tr key={idx}>
                          <td className="text-muted small">{fmtDmyHm(m.at)}</td>
                          <td className="small">{m.type}</td>
                          <td className={`text-end small ${Number(m.amount ?? 0) > 0 ? "text-success" : Number(m.amount ?? 0) < 0 ? "text-danger" : ""}`}>
                            {m.amount != null ? `€ ${fmtMoney(m.amount)}` : "—"}
                          </td>
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

      {/* ===== Modale "Modifica scadenza GiftCard" ===== */}
      {expiryOpen && detail ? (
        <div className="modal fade show d-block" id="modalGiftCardExpiry" tabIndex={-1} style={{ background: "rgba(0,0,0,.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <form
              className="modal-content"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await post({ action: "update_expiry", expires_at: expiryValue });
                if (ok) setExpiryOpen(false);
              }}
            >
              <div className="modal-header">
                <h5 className="modal-title">Modifica scadenza GiftCard</h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setExpiryOpen(false)} />
              </div>
              <div className="modal-body">
                <div className="mb-2">
                  <span className="text-muted">Scadenza attuale:</span> <strong>{detail.expiresAt ? fmtDmy(detail.expiresAt) : "—"}</strong>
                </div>
                <label className="form-label">Nuova scadenza</label>
                <input className="form-control" type="date" required min={new Date().toISOString().slice(0, 10)} value={expiryValue} onChange={(e) => setExpiryValue(e.target.value)} />
                <div className="form-text">
                  Non puoi selezionare una data precedente a oggi. La GiftCard richiede inoltre almeno il giorno successivo alla data di emissione. Se la GiftCard è scaduta,
                  impostando una nuova data futura verrà riattivata automaticamente.
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
