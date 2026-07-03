"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP fidelity wallet page (app/pages/fidelity_wallet.php,
// ?page=fidelity_wallet): "Portafoglio Punti". Wired to /api/manage/fidelity:
//   - GET  action=wallet[&client_id=N] -> { fidelityEnabled, pointsEnabled, clients[], detail }
//   - POST action=wallet_move (client_id, op add|remove, points, note)
// The client list is scoped to Fidelity CARD HOLDERS (like the legacy). Selecting a
// client opens the detail (saldo / prenotati / disponibili / movimenti / prenotazioni).
// Manual moves are adhesion-gated and, on removal, protect reserved (booked) points.
// F1: il motore point_lots è ATTIVO — il dettaglio espone punti in scadenza,
// calendario scadenze lotti, avvisi lock/negativo, e le tabelle sono paginate
// 20/pagina come il legacy.

type WalletClient = { id: number; name: string; email: string; points: number };
type WalletMovement = { id: number; kind: string; deltaPoints: number; note: string; sourceType: string; createdAt: string };
type WalletPending = { id: number; publicCode: string; startsAt: string; status: string; discountPoints: number; giftPoints: number };
type WalletLot = { lotId: number; sourceType: string; isLock: boolean; earnedAt: string; expiresAt: string | null; remaining: number; expired: boolean };
type WalletDetail = {
  clientId: number;
  clientName: string;
  clientEmail: string;
  adhering: boolean;
  pointsBalance: number;
  reserved: number;
  available: number;
  movements: WalletMovement[];
  pending: WalletPending[];
  expireEnabled: boolean;
  expireWarnDays: number;
  expiringSoon: number;
  lockedPoints: number;
  availableNegative: boolean;
  schedule: WalletLot[];
};
type Wallet = { fidelityEnabled: boolean; pointsEnabled: boolean; clients: WalletClient[]; detail: WalletDetail | null };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

const KIND_LABELS: Record<string, string> = { earn: "Accredito", redeem: "Riscatto", manual: "Manuale", adjust: "Rettifica", expire: "Scadenza" };

function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FidelityWalletContent() {
  const slug = tenantSlug();

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [selectedId, setSelectedId] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [filterText, setFilterText] = useState("");
  // Paginazione 20/pagina di movimenti e prenotati (legacy fidelity_wallet 20/pag).
  const [movPage, setMovPage] = useState(1);
  const [pendPage, setPendPage] = useState(1);
  useEffect(() => {
    setMovPage(1);
    setPendPage(1);
  }, [selectedId]);

  // Manual operation form.
  const [moveClientId, setMoveClientId] = useState("");
  const [moveSearch, setMoveSearch] = useState("");
  const [op, setOp] = useState("add");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    return fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=wallet${selectedId ? `&client_id=${selectedId}` : ""}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.wallet) setWallet(j.wallet as Wallet);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [slug, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  const clients = useMemo(() => wallet?.clients ?? [], [wallet]);

  function clientName(id: string): string {
    const c = clients.find((x) => String(x.id) === id);
    return c ? c.name : "";
  }

  const moveMatches = useMemo(() => {
    const term = moveSearch.trim().toLowerCase();
    if (term === "") return clients;
    return clients.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(term));
  }, [clients, moveSearch]);

  const filteredClients = useMemo(() => {
    const term = filterText.trim().toLowerCase();
    if (term === "") return clients;
    return clients.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(term));
  }, [clients, filterText]);

  function openClient(id: number) {
    setSelectedId(id);
    setMoveClientId(String(id));
    setMsg("");
    setErr("");
  }

  async function submitMove(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setErr("");
    if (!moveClientId) {
      setErr("Seleziona un cliente.");
      return;
    }
    if (!points) {
      setErr("Inserisci un numero intero di punti valido.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "wallet_move", client_id: moveClientId, op, points, note }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(String(j.error || "Operazione non riuscita."));
      setMsg(String(j.message || "Operazione registrata."));
      setPoints("");
      setNote("");
      // If the moved client is the one open (or none open yet), reflect it in the detail.
      if (Number(moveClientId) === selectedId || selectedId === 0) {
        if (selectedId === 0) setSelectedId(Number(moveClientId));
      }
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  const detail = wallet?.detail ?? null;
  const disabled = wallet !== null && (!wallet.fidelityEnabled || !wallet.pointsEnabled);

  function pageHref(page: string): string {
    return `/${encodeURIComponent(slug)}/${page}`;
  }

  return (
    <main className="app-content">
      <div className="container-fluid">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Portafoglio</div>
            <h1 className="bs-page-title">Fidelity • Portafoglio</h1>
            <div className="bs-page-subtitle">Gestione punti per cliente, movimenti manuali e scadenze.</div>
          </div>
        </div>

        {msg ? <div className="alert alert-success">{msg}</div> : null}
        {err ? <div className="alert alert-danger">{err}</div> : null}

        {disabled ? (
          <div className="alert alert-info">
            <div className="fw-semibold mb-1">
              <i className="bi bi-info-circle me-1" />
              {!wallet?.fidelityEnabled ? "Fidelity disattivata" : "Punti Fidelity disattivati"}
            </div>
            <div className="small">
              {!wallet?.fidelityEnabled ? (
                <>
                  Questa sezione è disabilitata perché l&apos;impostazione generale Fidelity è disattivata. Attiva la funzione in <a href={pageHref("fidelity")}>Fidelity → Impostazione generale</a>.
                </>
              ) : (
                <>
                  Questa sezione è disabilitata perché <strong>Abilita Punti Fidelity</strong> è disattivo. Riattivalo da <a href={pageHref("fidelity_points")}>Fidelity → Punti</a>.
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="row g-3 align-items-start">
            <div className="col-12 col-xl-9 order-xl-1">
              <div className="card p-3 mb-3">
                <div className="row g-2 align-items-end">
                  <div className="col-lg-8">
                    <label className="form-label">Cerca cliente</label>
                    <input className="form-control" value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="Nome o email" />
                  </div>
                  {selectedId ? (
                    <div className="col-lg-4 d-flex align-items-end">
                      <button className="btn btn-outline-secondary" type="button" onClick={() => setSelectedId(0)}>
                        <i className="bi bi-x-lg me-1" />
                        Chiudi dettaglio
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {detail ? (
                <div className="card p-3 mb-3">
                  <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                    <div>
                      <div className="fw-semibold">{detail.clientName || `#${detail.clientId}`}</div>
                      <div className="text-muted small">{detail.clientEmail || "—"}</div>
                      {!detail.adhering ? <span className="badge bg-warning text-dark mt-1">Tessera non attiva</span> : null}
                    </div>
                    <div className="d-flex gap-3 text-center">
                      <div>
                        <div className="text-muted small">Saldo</div>
                        <div className="h5 m-0">{detail.pointsBalance}</div>
                      </div>
                      <div>
                        <div className="text-muted small">Prenotati</div>
                        <div className="h5 m-0">{detail.reserved}</div>
                      </div>
                      <div>
                        <div className="text-muted small">Disponibili</div>
                        <div className="h5 m-0 text-primary">{detail.available}</div>
                      </div>
                      {detail.expireEnabled ? (
                        <div>
                          <div className="text-muted small">In scadenza ({detail.expireWarnDays} gg)</div>
                          <div className={`h5 m-0 ${detail.expiringSoon > 0 ? "text-warning" : ""}`}>{detail.expiringSoon}</div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {detail.availableNegative ? (
                    <div className="alert alert-warning mt-3 mb-0 py-2">
                      I punti prenotati sugli appuntamenti aperti superano il saldo: il disponibile risulterebbe negativo. Verifica le prenotazioni in sospeso.
                    </div>
                  ) : null}
                  {detail.lockedPoints > 0 ? (
                    <div className="alert alert-info mt-3 mb-0 py-2">
                      {detail.lockedPoints} punti scaduti sono vincolati a prenotazioni aperte (lock): verranno liberati o scadranno alla chiusura degli appuntamenti collegati.
                    </div>
                  ) : null}
                  {detail.schedule.some((l) => l.expired) ? (
                    <div className="alert alert-warning mt-3 mb-0 py-2">
                      Sono presenti punti già scaduti non ancora processati: verranno azzerati al prossimo passaggio della scadenza automatica.
                    </div>
                  ) : null}

                  {detail.expireEnabled && detail.schedule.length > 0 ? (
                    <>
                      <hr />
                      <div className="fw-semibold mb-2">Calendario scadenze</div>
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Guadagnati il</th>
                              <th>Scadenza</th>
                              <th>Origine</th>
                              <th className="text-end">Punti residui</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.schedule.map((lot) => (
                              <tr key={lot.lotId} className={lot.expired ? "table-warning" : undefined}>
                                <td>{fmtDateTime(lot.earnedAt)}</td>
                                <td>
                                  {lot.isLock ? (
                                    <span className="badge bg-info text-dark">Vincolato (prenotazioni)</span>
                                  ) : lot.expiresAt ? (
                                    fmtDateTime(lot.expiresAt)
                                  ) : (
                                    "Mai"
                                  )}
                                </td>
                                <td className="text-muted small">{lot.isLock ? "lock" : lot.sourceType || "—"}</td>
                                <td className="text-end fw-semibold">{lot.remaining}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}

                  {detail.pending.length > 0 ? (
                    <>
                      <hr />
                      <div className="fw-semibold mb-2">Punti prenotati su appuntamenti</div>
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Appuntamento</th>
                              <th>Data</th>
                              <th>Stato</th>
                              <th className="text-end">Punti sconto</th>
                              <th className="text-end">Punti omaggio</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.pending.slice((pendPage - 1) * 20, pendPage * 20).map((p) => (
                              <tr key={p.id}>
                                <td>{p.publicCode || `#${p.id}`}</td>
                                <td>{fmtDateTime(p.startsAt)}</td>
                                <td>{p.status === "pending" ? "In sospeso" : "Prenotato"}</td>
                                <td className="text-end">{p.discountPoints}</td>
                                <td className="text-end">{p.giftPoints}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {detail.pending.length > 20 ? (
                        <div className="d-flex justify-content-between align-items-center mt-2">
                          <div className="text-muted small">Pagina {pendPage} di {Math.ceil(detail.pending.length / 20)}</div>
                          <div className="btn-group btn-group-sm">
                            <button className="btn btn-outline-secondary" type="button" disabled={pendPage <= 1} onClick={() => setPendPage((p) => p - 1)}>«</button>
                            <button className="btn btn-outline-secondary" type="button" disabled={pendPage >= Math.ceil(detail.pending.length / 20)} onClick={() => setPendPage((p) => p + 1)}>»</button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <hr />
                  <div className="fw-semibold mb-2">Movimenti punti</div>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Tipo</th>
                          <th>Nota</th>
                          <th className="text-end">Punti</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.movements.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="text-muted p-3">
                              Nessun movimento.
                            </td>
                          </tr>
                        ) : (
                          detail.movements.slice((movPage - 1) * 20, movPage * 20).map((mvt) => (
                            <tr key={mvt.id}>
                              <td>{fmtDateTime(mvt.createdAt)}</td>
                              <td>{KIND_LABELS[mvt.kind] ?? mvt.kind}</td>
                              <td className="text-muted">{mvt.note || "—"}</td>
                              <td className={`text-end fw-semibold ${mvt.deltaPoints < 0 ? "text-danger" : "text-success"}`}>
                                {mvt.deltaPoints > 0 ? "+" : ""}
                                {mvt.deltaPoints}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  {detail.movements.length > 20 ? (
                    <div className="d-flex justify-content-between align-items-center mt-2">
                      <div className="text-muted small">Pagina {movPage} di {Math.ceil(detail.movements.length / 20)}</div>
                      <div className="btn-group btn-group-sm">
                        <button className="btn btn-outline-secondary" type="button" disabled={movPage <= 1} onClick={() => setMovPage((p) => p - 1)}>«</button>
                        <button className="btn btn-outline-secondary" type="button" disabled={movPage >= Math.ceil(detail.movements.length / 20)} onClick={() => setMovPage((p) => p + 1)}>»</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="card p-3">
                <div>
                  <div className="fw-semibold">Portafoglio Punti</div>
                  <div className="text-muted small">Seleziona un cliente per vedere saldo, punti prenotati, movimenti e scadenze.</div>
                </div>

                <hr />

                <div className="fw-semibold mb-2">Clienti Fidelity</div>

                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Email</th>
                        <th className="text-end">Punti</th>
                        <th className="text-end"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredClients.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-muted p-3">
                            {loading ? "Caricamento…" : "Nessun cliente Fidelity trovato."}
                          </td>
                        </tr>
                      ) : (
                        filteredClients.map((c) => (
                          <tr key={c.id} className={selectedId === c.id ? "table-active" : undefined}>
                            <td className="fw-semibold">{c.name}</td>
                            <td className="text-muted">{c.email || "—"}</td>
                            <td className="text-end">{c.points}</td>
                            <td className="text-end">
                              <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openClient(c.id)}>
                                Apri
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="text-muted small mt-2">Mostriamo i clienti con tessera Fidelity (anche senza Punti). Usa il filtro Cliente per aprire un portafoglio specifico.</div>
              </div>
            </div>

            <div className="col-12 col-xl-3 order-xl-2">
              <div className="card mb-3">
                <div className="card-header">
                  <div className="fw-semibold">Operazione manuale</div>
                </div>
                <div className="card-body">
                  <form className="row g-3" onSubmit={submitMove}>
                    <div className="col-12">
                      <label className="form-label fw-semibold">Cliente</label>
                      <div className="dropdown">
                        <button className="btn btn-outline-secondary dropdown-toggle w-100" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                          {moveClientId ? clientName(moveClientId) || `#${moveClientId}` : <span className="text-muted">Seleziona...</span>}
                        </button>
                        <div className="dropdown-menu p-2 w-100">
                          <input type="text" className="form-control form-control-sm" placeholder="Cerca..." autoComplete="off" value={moveSearch} onChange={(e) => setMoveSearch(e.target.value)} />
                          <div className="mt-2" style={{ maxHeight: 220, overflowY: "auto" }}>
                            {moveMatches.map((c) => (
                              <button type="button" className="dropdown-item" key={c.id} onClick={() => setMoveClientId(String(c.id))}>
                                {c.name}
                                {c.email ? <span className="text-muted small ms-1">{c.email}</span> : null}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="col-12">
                      <label className="form-label fw-semibold">Operazione</label>
                      <select className="form-select" value={op} onChange={(e) => setOp(e.target.value)}>
                        <option value="add">Aggiungi</option>
                        <option value="remove">Rimuovi</option>
                      </select>
                    </div>
                    <div className="col-12">
                      <label className="form-label fw-semibold">Punti</label>
                      <input className="form-control" type="number" min="1" step="1" placeholder="10" value={points} onChange={(e) => setPoints(e.target.value)} />
                    </div>
                    <div className="col-12">
                      <label className="form-label fw-semibold">Nota (opzionale)</label>
                      <input className="form-control" value={note} onChange={(e) => setNote(e.target.value)} />
                    </div>
                    <div className="col-12">
                      <button className="btn btn-outline-primary w-100" type="submit" disabled={busy}>
                        <i className="bi bi-arrow-left-right me-1" />
                        {busy ? "Registrazione…" : "Registra"}
                      </button>
                    </div>
                  </form>

                  <div className="small text-muted mt-2">
                    <div>Nota: in caso di rimozione, il sistema non rimuove punti <strong>già prenotati</strong> su appuntamenti in sospeso/prenotati. I movimenti manuali sono consentiti solo per clienti con tessera Fidelity attiva.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
