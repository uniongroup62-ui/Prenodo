"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of app/pages/gift_instance.php — "Dettaglio gift cliente".
// Layout legacy: header (Torna a Omaggi / Elimina / Voucher-stampa) + due
// colonne: sinistra (riepilogo con badge stato + date + progressione regole,
// invio voucher email, operazioni di riscatto parziale, nota cliente, nota
// interna), destra (tabella Movimenti da gift_transactions). Le azioni POSTano
// /api/manage/gifts con gli action-name dei _mode legacy; l'annullo con
// prenotazioni collegate usa il round-trip confirm (il server risponde col
// messaggio legacy "Sono presenti prenotazioni collegate..." -> confirm ->
// retry con confirm_cancel_linked_appointments=1).

type RewardItem = {
  index: number;
  type: string;
  label: string;
  qtyTotal: number;
  qtyRedeemed: number;
  qtyRemaining: number;
  pendingQty: number;
};

type Tx = {
  id: number;
  createdAt: string;
  type: string;
  typeLabel: string;
  qty: number;
  serviceName: string;
  appointmentId: number;
  locationName: string;
  note: string;
  operatorName: string;
};

type LinkedAppt = { id: number; status: string; startsAt: string; publicCode: string; itemsCount: number };

type Detail = {
  id: number;
  code: string;
  state: string;
  manual: boolean;
  giftId: number;
  giftName: string;
  giftDescription: string;
  client: { id: number; name: string; phone: string; email: string };
  createdAt: string;
  unlockedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  cancelReason: string;
  locationName: string;
  note: string;
  internalNote: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  progressRules: Array<{ label: string; current: number; needed: number; ok: boolean }>;
  rewardItems: RewardItem[];
  pendingTotal: number;
  transactions: Tx[];
  linkedAppointments: LinkedAppt[];
  canCancel: boolean;
  canDelete: boolean;
  deletePerformsReset: boolean;
  voucherToken: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function instanceIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const id = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "0", 10);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

// Badge stato legacy (gifts.php ~1560-1564).
function stateBadge(state: string): string {
  if (state === "disponibile") return "text-bg-success";
  if (state === "riscattato") return "text-bg-dark";
  if (state === "scaduto") return "text-bg-warning text-dark";
  if (state === "annullato") return "text-bg-danger";
  return "text-bg-secondary";
}

function fmtDt(iso: string): string {
  if (!iso || iso.length < 10) return "—";
  const d = `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  return iso.length >= 16 ? `${d} ${iso.slice(11, 16)}` : d;
}

export function GiftInstanceContent() {
  const slug = tenantSlug();
  const instanceId = instanceIdFromUrl();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [redeemQty, setRedeemQty] = useState<Record<number, number>>({});
  const [redeemNote, setRedeemNote] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [note, setNote] = useState("");
  const [internalNote, setInternalNote] = useState("");

  const load = useCallback(() => {
    if (!instanceId) { setLoading(false); return Promise.resolve(); }
    return fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}&action=instance&id=${instanceId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const d = (j.instance ?? null) as Detail | null;
        setDetail(d);
        if (d) {
          setSendTo((prev) => prev || d.client.email);
          setNote(d.note);
          setInternalNote(d.internalNote);
        }
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [slug, instanceId]);

  useEffect(() => { load(); }, [load]);

  const backHref = useMemo(
    () => `/${encodeURIComponent(slug)}/gifts${detail ? `?inst_client_id=${detail.client.id}` : ""}`,
    [slug, detail],
  );
  const voucherHref = `/${encodeURIComponent(slug)}/gift_voucher?public=1&embed=1&token=${encodeURIComponent(detail?.voucherToken ?? "")}`;

  async function post(fields: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/gifts?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ instance_id: String(instanceId), ...fields }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Operazione non riuscita."));
      if (j.instance) setDetail(j.instance as Detail);
      return j as Record<string, unknown>;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm("Registrare il riscatto selezionato?")) return;
    const qty: Record<string, number> = {};
    for (const [idx, q] of Object.entries(redeemQty)) if (q > 0) qty[idx] = q;
    const j = await post({ action: "redeem_instance_partial", redeem_qty_json: JSON.stringify(qty), redeem_note: redeemNote });
    if (j) {
      setMsg(String(j.message ?? "Riscatto registrato"));
      setRedeemQty({});
      setRedeemNote("");
      await load();
    }
  }

  async function cancelInstance() {
    if (!detail) return;
    if (!window.confirm("Annullare questo omaggio?")) return;
    let j = await post({ action: "cancel_instance", cancel_reason: "Annullato da operatore" });
    if (!j && err === "") return;
    if (!j) {
      // Round-trip conferma prenotazioni collegate (messaggio legacy dal server).
      return;
    }
    setMsg(String(j.message ?? "Omaggio annullato"));
    await load();
  }

  // Il round-trip di conferma deve leggere l'errore appena impostato: gestito qui
  // osservando err (solo per il messaggio prenotazioni collegate).
  useEffect(() => {
    if (!err.startsWith("Sono presenti prenotazioni collegate")) return;
    const linked = detail?.linkedAppointments ?? [];
    const list = linked.map((a) => `#${a.publicCode || a.id} • ${fmtDt(a.startsAt)} (${a.status === "pending" ? "In attesa" : "Prenotata"})`).join("\n");
    const go = window.confirm(`Conferma annullamento\n\nPrenotazioni collegate all'omaggio:\n${list}\n\nLe prenotazioni verranno annullate automaticamente. Procedere?`);
    setErr("");
    if (!go) return;
    void (async () => {
      const j = await post({ action: "cancel_instance", cancel_reason: "Annullato da operatore", confirm_cancel_linked_appointments: "1" });
      if (j) {
        setMsg(String(j.message ?? "Omaggio annullato"));
        await load();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [err]);

  async function deleteInstance() {
    if (!detail) return;
    const resetText = detail.deletePerformsReset
      ? "\n\nL'istanza è in accumulo: i progressi già conteggiati verranno azzerati e il cliente ripartirà solo da eventuali eventi successivi."
      : "";
    const linked = detail.linkedAppointments.length ? `\n\nPrenotazioni collegate che verranno eliminate: ${detail.linkedAppointments.length}.` : "";
    if (!window.confirm(`Conferma eliminazione definitiva\n\nOmaggio #${detail.id} • ${detail.giftName}\nCliente: ${detail.client.name}\nStato: ${detail.state}${resetText}${linked}\n\nEliminare definitivamente?`)) return;
    const j = await post({ action: "delete_instance" });
    if (j) {
      window.location.href = backHref;
    }
  }

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    const j = await post({ action: "send_email", send_to: sendTo });
    if (j) setMsg(String(j.message ?? "Voucher inviato"));
  }

  async function saveNote(e: React.FormEvent) {
    e.preventDefault();
    const j = await post({ action: "update_instance_note", note });
    if (j) setMsg(String(j.message ?? "Nota cliente salvata"));
  }

  async function saveInternalNote(e: React.FormEvent) {
    e.preventDefault();
    const j = await post({ action: "update_instance_internal_note", internal_note: internalNote });
    if (j) setMsg(String(j.message ?? "Nota interna salvata"));
  }

  function selectAllRemaining() {
    if (!detail) return;
    const next: Record<number, number> = {};
    for (const it of detail.rewardItems) {
      const usable = Math.max(0, it.qtyRemaining - it.pendingQty);
      if (usable > 0) next[it.index] = usable;
    }
    setRedeemQty(next);
  }

  if (!loading && (!instanceId || !detail)) {
    return (
      <div className="container-fluid">
        <div className="alert alert-danger">Omaggio non trovato.</div>
        <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/gifts`}>
          <i className="bi bi-arrow-left me-1" />
          Torna a Omaggi
        </a>
      </div>
    );
  }

  const canRedeem = detail?.state === "disponibile";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/gift_instance.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">Dettaglio gift cliente</h1>
          <div className="bs-page-subtitle">Consulta stato, cliente, movimenti e voucher del gift.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap">
            <a className="btn btn-outline-secondary" href={backHref}>
              <i className="bi bi-arrow-left me-1" />
              Torna a Omaggi
            </a>
            {detail?.canDelete ? (
              <button className="btn btn-outline-danger" type="button" onClick={deleteInstance} disabled={busy}>
                <i className="bi bi-trash me-1" />
                {detail.deletePerformsReset ? "Elimina accumulo" : "Elimina gift"}
              </button>
            ) : null}
            <a className="btn btn-outline-primary" href={voucherHref} target="_blank" rel="noreferrer">
              <i className="bi bi-printer me-1" />
              Voucher / stampa
            </a>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err && !err.startsWith("Sono presenti prenotazioni collegate") ? <div className="alert alert-danger">{err}</div> : null}

      {loading || !detail ? (
        <div className="text-muted p-3">Caricamento…</div>
      ) : (
        <div className="row g-3">
          <div className="col-lg-5">
            {/* Card riepilogo */}
            <div className="card mb-3">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                  <div>
                    <h2 className="h5 mb-1">{detail.giftName}</h2>
                    <div className="text-muted">Cliente: {detail.client.name}</div>
                  </div>
                  <div className="text-end">
                    <span className={`badge ${stateBadge(detail.state)} text-uppercase`}>{detail.state}</span>
                    {detail.manual ? <span className="badge text-bg-info ms-1">ASSEGNAZIONE MANUALE</span> : null}
                    <div className="text-muted small mt-1">ID istanza: {detail.id}</div>
                  </div>
                </div>

                <table className="table table-sm mt-3 mb-2">
                  <tbody>
                    <tr><td className="text-muted">Creato</td><td className="text-end">{fmtDt(detail.createdAt)}</td></tr>
                    {detail.locationName ? <tr><td className="text-muted">Sede</td><td className="text-end">{detail.locationName}</td></tr> : null}
                    <tr><td className="text-muted">Sbloccato</td><td className="text-end">{fmtDt(detail.unlockedAt)}</td></tr>
                    <tr><td className="text-muted">Scadenza</td><td className="text-end">{detail.expiresAt ? fmtDt(detail.expiresAt) : "Nessuna scadenza"}</td></tr>
                    {detail.cancelReason ? <tr><td className="text-muted">Motivo annullamento</td><td className="text-end">{detail.cancelReason}</td></tr> : null}
                  </tbody>
                </table>

                {detail.progressRules.length ? (
                  <div className="border rounded p-2">
                    <div className="fw-semibold small mb-1">Progressione regole</div>
                    {detail.progressRules.map((r, i) => (
                      <div key={i} className="small">
                        {r.ok ? "✅" : "⏳"} {r.label}: {r.current}/{r.needed}
                      </div>
                    ))}
                  </div>
                ) : null}

                {detail.state === "riscattato" ? (
                  <div className="text-muted small mt-2">Omaggio riscattato{detail.redeemedAt ? ` il ${fmtDt(detail.redeemedAt)}` : ""}.</div>
                ) : null}
                {detail.state === "annullato" ? (
                  <div className="text-muted small mt-2">Omaggio annullato{detail.cancelledAt ? ` il ${fmtDt(detail.cancelledAt)}` : ""}.</div>
                ) : null}
                {detail.state === "scaduto" ? <div className="text-muted small mt-2">Omaggio scaduto: non è più riscattabile.</div> : null}
              </div>
            </div>

            {/* Invio voucher email */}
            <div className="card mb-3">
              <div className="card-body">
                <h3 className="h6">Invio voucher al cliente</h3>
                <form onSubmit={sendEmail}>
                  <input
                    className="form-control mb-2"
                    type="email"
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value)}
                    placeholder="email@cliente.it"
                    required
                  />
                  <div className="form-text mb-2">La mail contiene il voucher omaggio e il codice da mostrare in cassa.</div>
                  <button className="btn btn-primary" type="submit" disabled={busy || detail.state !== "disponibile"}>
                    <i className="bi bi-envelope me-1" />
                    Invia voucher via email
                  </button>
                  {detail.lastEmailSentAt ? (
                    <div className="text-muted small mt-2">Ultimo invio: {fmtDt(detail.lastEmailSentAt)} ({detail.lastEmailSentTo})</div>
                  ) : null}
                </form>
              </div>
            </div>

            {/* Operazioni: riscatto parziale */}
            <div className="card mb-3">
              <div className="card-body">
                <h3 className="h6">Riscatta gift (anche parziale)</h3>
                {detail.pendingTotal > 0 ? (
                  <div className="alert alert-warning py-2">
                    Le quantità disponibili escludono {detail.pendingTotal} elemento/i già collegati a prenotazioni in attesa o prenotate.
                  </div>
                ) : null}
                <form onSubmit={submitRedeem}>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle">
                      <thead>
                        <tr>
                          <th>Elemento</th>
                          <th className="text-end">Tot</th>
                          <th className="text-end">Usati</th>
                          <th className="text-end">Da riscattare</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.rewardItems.length === 0 ? (
                          <tr><td colSpan={4} className="text-muted">Nessun elemento premio.</td></tr>
                        ) : (
                          detail.rewardItems.map((it) => {
                            const usable = Math.max(0, it.qtyRemaining - it.pendingQty);
                            const exhausted = it.qtyRemaining <= 0;
                            return (
                              <tr key={it.index} className={exhausted ? "text-muted" : ""}>
                                <td>
                                  {it.label}
                                  {exhausted ? <span className="badge text-bg-secondary ms-1">esaurito</span> : null}
                                  {it.pendingQty > 0 ? <span className="badge text-bg-warning text-dark ms-1">in sospeso</span> : null}
                                </td>
                                <td className="text-end">{it.qtyTotal}</td>
                                <td className="text-end">{it.qtyRedeemed}</td>
                                <td className="text-end" style={{ width: 110 }}>
                                  {usable === 1 ? (
                                    <input
                                      type="checkbox"
                                      className="form-check-input"
                                      checked={(redeemQty[it.index] ?? 0) > 0}
                                      disabled={!canRedeem || busy}
                                      onChange={(e) => setRedeemQty((p) => ({ ...p, [it.index]: e.target.checked ? 1 : 0 }))}
                                    />
                                  ) : (
                                    <input
                                      type="number"
                                      className="form-control form-control-sm text-end"
                                      min={0}
                                      max={usable}
                                      value={redeemQty[it.index] ?? 0}
                                      disabled={!canRedeem || busy || usable <= 0}
                                      onChange={(e) => setRedeemQty((p) => ({ ...p, [it.index]: Math.max(0, Math.min(usable, Number.parseInt(e.target.value || "0", 10) || 0)) }))}
                                    />
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  <label className="form-label small">Nota (opzionale)</label>
                  <input className="form-control mb-2" value={redeemNote} onChange={(e) => setRedeemNote(e.target.value)} placeholder="Es. Appuntamento #123" />
                  <div className="d-flex gap-2 flex-wrap">
                    <button className="btn btn-outline-primary" type="submit" disabled={!canRedeem || busy}>
                      Registra riscatto
                    </button>
                    <button className="btn btn-outline-secondary" type="button" onClick={selectAllRemaining} disabled={!canRedeem || busy}>
                      Seleziona tutti i rimanenti
                    </button>
                    <button className="btn btn-outline-light text-dark border" type="button" onClick={() => setRedeemQty({})} disabled={busy}>
                      Svuota selezione
                    </button>
                    {detail.canCancel ? (
                      <button className="btn btn-outline-danger" type="button" onClick={cancelInstance} disabled={busy}>
                        Annulla gift
                      </button>
                    ) : null}
                  </div>
                  <div className="form-text mt-2">
                    L&apos;omaggio verrà segnato come <strong>riscattato</strong> solo quando tutti gli elementi risulteranno utilizzati.
                  </div>
                </form>
              </div>
            </div>

            {/* Nota cliente */}
            <div className="card mb-3">
              <div className="card-body">
                <h3 className="h6">Nota cliente</h3>
                <form onSubmit={saveNote}>
                  <textarea className="form-control mb-1" rows={4} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
                  <div className="form-text mb-2">Nota visibile nel voucher omaggio e nella mail inviata al cliente.</div>
                  <button className="btn btn-primary" type="submit" disabled={busy}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva nota
                  </button>
                </form>
              </div>
            </div>

            {/* Nota interna */}
            <div className="card mb-3">
              <div className="card-body">
                <h3 className="h6">Nota interna</h3>
                <form onSubmit={saveInternalNote}>
                  <textarea className="form-control mb-1" rows={4} value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={2000} />
                  <div className="form-text mb-2">Nota visibile solo nel backend. Può essere aggiornata da questa scheda.</div>
                  <button className="btn btn-primary" type="submit" disabled={busy}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva note
                  </button>
                </form>
              </div>
            </div>
          </div>

          {/* Colonna destra: movimenti */}
          <div className="col-lg-7">
            <div className="card">
              <div className="card-body">
                <h3 className="h6">Movimenti</h3>
                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
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
                      {detail.transactions.length === 0 ? (
                        <tr><td colSpan={7} className="text-muted">Nessun movimento.</td></tr>
                      ) : (
                        detail.transactions.map((t, i) => (
                          <tr key={`${t.id}-${i}`}>
                            <td>{fmtDt(t.createdAt)}</td>
                            <td>{t.typeLabel}</td>
                            <td className={`text-end fw-semibold ${t.type === "redeem" || t.type === "issue" ? "text-success" : t.qty < 0 || t.type.includes("cancel") ? "text-danger" : ""}`}>
                              {t.qty}
                            </td>
                            <td>{t.serviceName || "—"}</td>
                            <td>{t.locationName || "—"}</td>
                            <td>{t.note || "—"}{t.appointmentId ? ` (prenotazione #${t.appointmentId})` : ""}</td>
                            <td>{t.operatorName || "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
