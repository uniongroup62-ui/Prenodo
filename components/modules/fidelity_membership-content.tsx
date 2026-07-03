"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP fidelity membership page (app/pages/fidelity_membership.php,
// ?page=fidelity_membership): "Adesione" — issue and manage Fidelity cards (tessere).
// Wired to the real endpoints on /api/manage/fidelity:
//   - GET  action=membership -> { fidelityEnabled, cards[], validity, expiredCount }
//   - POST action=card_create   (client_id, code, issued_at, status)
//   - POST action=card_update   (card_id, status)
//   - POST action=card_reactivate (card_id)
//   - POST action=card_delete   (card_id)
// The card expiry is computed from the card-validity settings (fidelity_membership_settings)
// stored in businesses.fidelity_adhesion_json — the same value the backend applies on save.

type FidelityClient = { id: number; name: string; email?: string; phone?: string };

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
  expired: boolean;
};
type Membership = { fidelityEnabled: boolean; cards: FidelityCard[]; total: number; expiredCount: number; validity: CardValidity };

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "—";
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

// Mirror of the backend addMonthsClampedYmd / addCardDuration for the live expiry preview.
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

export function FidelityMembershipContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const today = todayYmd();

  const [membership, setMembership] = useState<Membership | null>(null);
  const [clients, setClients] = useState<FidelityClient[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // "Nuova tessera" modal state.
  const [showNew, setShowNew] = useState(false);
  const [cardClientSearch, setCardClientSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<FidelityClient | null>(null);
  const [cardCode, setCardCode] = useState("");
  const [cardIssuedAt, setCardIssuedAt] = useState(today);
  const [cardStatus, setCardStatus] = useState("active");

  // "Modifica tessera" modal state.
  const [editCard, setEditCard] = useState<FidelityCard | null>(null);
  const [editStatus, setEditStatus] = useState("active");

  const loadMembership = useCallback(() => {
    return fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=membership`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.membership) setMembership(j.membership as Membership);
      })
      .catch(() => undefined);
  }, [slug]);

  useEffect(() => {
    loadMembership();
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.clients) ? j.clients : [];
        setClients(list.map((c: FidelityClient) => ({ id: Number(c.id), name: String(c.name ?? ""), email: c.email ? String(c.email) : "", phone: c.phone ? String(c.phone) : "" })));
      })
      .catch(() => setClients([]));
  }, [slug, loadMembership]);

  function pageHref(page: string): string {
    return `/${encodeURIComponent(slug)}/${page}`;
  }

  const validity: CardValidity = useMemo(() => membership?.validity ?? { enabled: false, value: 0, unit: "days", defaultExpiresAt: "" }, [membership]);

  const cardClientResults = useMemo(() => {
    const term = cardClientSearch.trim().toLowerCase();
    if (term.length < 2) return [];
    return clients.filter((c) => c.name.toLowerCase().includes(term) || (c.email ?? "").toLowerCase().includes(term) || (c.phone ?? "").toLowerCase().includes(term)).slice(0, 8);
  }, [cardClientSearch, clients]);

  const filteredCards = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cards = membership?.cards ?? [];
    if (term === "") return cards;
    return cards.filter((c) => c.code.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term) || c.clientEmail.toLowerCase().includes(term));
  }, [q, membership]);

  // Live expiry preview + already-expired guard for the "Nuova tessera" modal.
  const newExpiry = useMemo(() => computeExpiry(validity, cardIssuedAt), [validity, cardIssuedAt]);
  const newAlreadyExpired = cardStatus === "active" && newExpiry !== "" && newExpiry < today;

  function openNew() {
    setSelectedClient(null);
    setCardClientSearch("");
    setCardCode("");
    setCardIssuedAt(today);
    setCardStatus("active");
    setErr("");
    setShowNew(true);
  }

  function openEdit(card: FidelityCard) {
    setEditCard(card);
    setEditStatus(card.status === "inactive" ? "inactive" : "active");
    setErr("");
  }

  async function post(fields: Record<string, string>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(String(j.error || "Operazione non riuscita."));
      if (j.membership) setMembership(j.membership as Membership);
      return j;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedClient) {
      setErr("Seleziona un cliente.");
      return;
    }
    const j = await post({ action: "card_create", client_id: String(selectedClient.id), code: cardCode, issued_at: cardIssuedAt, status: cardStatus });
    if (j) {
      setMsg(`Tessera creata: ${String(j.code ?? "")}`);
      setShowNew(false);
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editCard) return;
    const j = await post({ action: "card_update", card_id: String(editCard.id), status: editStatus });
    if (j) {
      setMsg(editStatus === "inactive" ? "Tessera disattivata." : "Tessera aggiornata");
      setEditCard(null);
    }
  }

  async function reactivate() {
    if (!editCard) return;
    const j = await post({ action: "card_reactivate", card_id: String(editCard.id) });
    if (j) {
      setMsg("Tessera riattivata");
      setEditCard(null);
    }
  }

  async function removeCard(card: FidelityCard) {
    if (!window.confirm(`Eliminare la tessera ${card.code}? Il credito del cliente resta, ma punti e movimenti Fidelity vengono azzerati e il codice non potrà essere riutilizzato.`)) return;
    const j = await post({ action: "card_delete", card_id: String(card.id) });
    if (j) setMsg("Tessera eliminata. Credito cliente mantenuto. Il codice tessera resta riservato.");
  }

  const fidelityDisabled = membership !== null && !membership.fidelityEnabled;

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
            <a className="btn btn-light" href={pageHref("fidelity")}>
              <i className="bi bi-arrow-left" /> Fidelity
            </a>
            <a className="btn btn-light" href={`${pageHref("fidelity_points")}#livelli-card`}>
              <i className="bi bi-stars" /> Livelli Card
            </a>
            <a className="btn btn-light" href={pageHref("fidelity_membership_settings")}>
              <i className="bi bi-gear" /> Impostazioni
            </a>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err && !showNew && !editCard ? <div className="alert alert-danger">{err}</div> : null}

      {fidelityDisabled ? (
        <div className="alert alert-info">
          <div className="fw-semibold mb-1">
            <i className="bi bi-info-circle me-1" />
            Fidelity disattivata
          </div>
          <div className="small">
            Questa sezione è disabilitata perché l&apos;impostazione generale Fidelity è disattivata. Attiva la funzione in{" "}
            <a href={pageHref("fidelity")}>Fidelity → Impostazione generale</a>.
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
              }}
            >
              <div className="col-lg-8">
                <label className="form-label">Cerca</label>
                <input className="form-control" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cliente o codice tessera" />
              </div>
              <div className="col-lg-4 d-flex align-items-end gap-2 app-filter-actions">
                <button className="btn btn-outline-primary app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center gap-2 flex-wrap">
              <div className="fw-semibold">
                Tessere
                {membership ? <span className="text-muted small ms-2">{membership.total} totali · {membership.expiredCount} scadute</span> : null}
              </div>
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
                  {filteredCards.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted p-3">
                        Nessuna tessera.
                      </td>
                    </tr>
                  ) : (
                    filteredCards.map((card) => (
                      <tr key={card.id}>
                        <td className="fw-semibold">{card.code}</td>
                        <td>{fmtDate(card.issuedAt)}</td>
                        <td>{card.expiresAt ? fmtDate(card.expiresAt) : <span className="text-muted">Nessuna</span>}</td>
                        <td>{card.expired ? <span className="badge bg-danger">Sì</span> : <span className="badge bg-light text-muted">No</span>}</td>
                        <td>
                          <div className="fw-semibold">{card.clientName || `#${card.clientId}`}</div>
                          {card.clientEmail ? <div className="text-muted small">{card.clientEmail}</div> : null}
                        </td>
                        <td>
                          {card.status === "inactive" ? <span className="badge bg-secondary">Disattiva</span> : <span className="badge bg-success">Attiva</span>}
                        </td>
                        <td className="text-end">
                          <button className="btn btn-sm btn-outline-primary me-1" type="button" onClick={() => openEdit(card)} disabled={busy}>
                            <i className="bi bi-pencil" /> Modifica
                          </button>
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeCard(card)} disabled={busy}>
                            <i className="bi bi-trash" /> Elimina
                          </button>
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

      {/* Modal: Nuova tessera */}
      {showNew ? (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg">
              <div className="modal-content">
                <form id="newCardForm" onSubmit={submitNew}>
                  <div className="modal-header">
                    <h5 className="modal-title">Nuova tessera</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setShowNew(false)} />
                  </div>

                  <div className="modal-body">
                    {err ? <div className="alert alert-danger">{err}</div> : null}
                    <div className="row g-3">
                      <div className="col-12">
                        <label className="form-label fw-semibold">Cliente</label>
                        {selectedClient ? (
                          <div className="alert alert-light border d-flex justify-content-between align-items-center mb-0">
                            <div>
                              <div className="fw-semibold">{selectedClient.name}</div>
                              <div className="text-muted small">{[selectedClient.email, selectedClient.phone].filter(Boolean).join(" · ") || "—"}</div>
                            </div>
                            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setSelectedClient(null)}>
                              Cambia
                            </button>
                          </div>
                        ) : (
                          <>
                            <input
                              className="form-control"
                              placeholder="Cerca cliente (nome, email, telefono...)"
                              autoComplete="off"
                              value={cardClientSearch}
                              onChange={(e) => setCardClientSearch(e.target.value)}
                            />
                            <div className="form-text">Digita almeno 2 caratteri e seleziona il cliente dai risultati.</div>
                            <div className="list-group mt-2">
                              {cardClientResults.map((c) => (
                                <button type="button" key={c.id} className="list-group-item list-group-item-action" onClick={() => { setSelectedClient(c); setCardClientSearch(""); }}>
                                  <div className="fw-semibold">{c.name}</div>
                                  <div className="text-muted small">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</div>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Codice tessera</label>
                        <input className="form-control" placeholder="Automatico (es. 000001)" value={cardCode} onChange={(e) => setCardCode(e.target.value)} />
                        <div className="form-text">Se vuoto viene generato automaticamente. Un codice già usato, anche su tessera eliminata, non può essere riutilizzato.</div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Data emissione</label>
                        <input className="form-control" type="date" value={cardIssuedAt} onChange={(e) => setCardIssuedAt(e.target.value)} />
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Data scadenza</label>
                        <div className="form-control bg-light">{newExpiry ? fmtDate(newExpiry) : "Nessuna"}</div>
                        <div className="form-text">Calcolata automaticamente dalle Impostazioni tessera Fidelity in base alla Data emissione.</div>
                      </div>

                      <div className="col-md-4">
                        <label className="form-label fw-semibold">Stato</label>
                        <select className="form-select" value={cardStatus} onChange={(e) => setCardStatus(e.target.value)}>
                          <option value="active">Attiva</option>
                          <option value="inactive">Disattiva</option>
                        </select>
                        {newAlreadyExpired ? (
                          <div className="alert alert-warning py-2 px-3 mt-2 mb-0">
                            Con la <strong>Data emissione</strong> selezionata, la tessera risulterebbe già <strong>scaduta</strong>. Scegli una data più recente oppure impostala come <strong>Disattiva</strong>.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setShowNew(false)}>
                      Annulla
                    </button>
                    <button className="btn btn-primary" type="submit" disabled={busy || !selectedClient}>
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
          <div className="modal fade show d-block" tabIndex={-1} role="dialog">
            <div className="modal-dialog">
              <div className="modal-content">
                <form id="editCardForm" onSubmit={submitEdit}>
                  <div className="modal-header">
                    <h5 className="modal-title">Modifica tessera</h5>
                    <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setEditCard(null)} />
                  </div>

                  <div className="modal-body">
                    {err ? <div className="alert alert-danger">{err}</div> : null}
                    <div className="mb-2">
                      <div className="text-muted small">Codice tessera</div>
                      <div className="fw-semibold">{editCard.code}</div>
                    </div>
                    <div className="mb-3">
                      <div className="text-muted small">Cliente</div>
                      <div className="fw-semibold">{editCard.clientName || `#${editCard.clientId}`}</div>
                    </div>

                    <div className="row g-3">
                      <div className="col-12">
                        <label className="form-label fw-semibold">Data scadenza</label>
                        <div className="form-control bg-light">
                          {editCard.expiresAt ? fmtDate(editCard.expiresAt) : "Nessuna"}
                          {editCard.expired ? <span className="badge bg-danger ms-2">Scaduta</span> : null}
                        </div>
                        <div className="form-text">La data di scadenza è visualizzata ma non può essere modificata qui.</div>
                      </div>

                      <div className="col-12">
                        <label className="form-label fw-semibold">Stato</label>
                        <select className="form-select" value={editStatus} onChange={(e) => setEditStatus(e.target.value)} disabled={editCard.expired}>
                          <option value="active">Attiva</option>
                          <option value="inactive">Disattiva</option>
                        </select>
                      </div>
                    </div>

                    <div className="alert alert-light border mt-3 mb-0">
                      <div className="small text-muted">
                        Se imposti <strong>Disattiva</strong>, il cliente perde le agevolazioni Fidelity prenotate sulle prenotazioni in stato <strong>In sospeso</strong> / <strong>Prenotato</strong>; le prenotazioni in stato <strong>Eseguito</strong> restano invariate.
                        <br />
                        Se la tessera è scaduta, usa <strong>Riattiva tessera</strong> per ricalcolare la nuova scadenza dalla data odierna.
                      </div>
                    </div>
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setEditCard(null)}>
                      Annulla
                    </button>
                    {editCard.expired ? (
                      <button type="button" className="btn btn-outline-primary" onClick={reactivate} disabled={busy}>
                        <i className="bi bi-arrow-clockwise" /> Riattiva tessera
                      </button>
                    ) : (
                      <button className="btn btn-primary" type="submit" disabled={busy}>
                        <i className="bi bi-check2-circle me-1" />
                        Salva
                      </button>
                    )}
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
