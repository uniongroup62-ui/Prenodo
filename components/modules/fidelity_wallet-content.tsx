"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import InfoBox from "./info-box";

// Port fedele del Portafoglio punti (app/pages/fidelity_wallet.php):
// - stati disabilitati legacy (Fidelity generale off / Punti off) con early
//   return e link alle sezioni;
// - filtro Cliente (combobox app-combobox 'Tutti i clienti') guidato dalla
//   querystring (?client_id=N) con Filtra/Reset;
// - vista cliente: KPI Saldo / Prenotati (lock) / Disponibili (RAW, anche
//   negativo) / In scadenza; alert legacy (Disponibile negativo, punti già
//   scaduti cron, scaduti ma vincolati); Calendario scadenze RAGGRUPPATO PER
//   GIORNO con quota 'vincolati' e 'Da rimuovere (cron)'; Movimenti punti
//   paginati 20 server-side (?p=N) con Sede e i tipi legacy ('scadenza',
//   'kind • source #id'); Punti in sospeso con badge riepilogo e paginazione
//   (?p_pending=N);
// - vista elenco: 'Clienti Fidelity' (titolari tessera anche disattiva)
//   paginata 20 (?p_list=N);
// - colonna destra 'Operazione manuale' con redirect flash legacy
//   (?msg/?err + &warn_locked=N) e l'alert 'Punti prenotati su appuntamenti'.

type FidelityWalletQuery = { client_id?: string; p?: string; p_pending?: string; p_list?: string; msg?: string; err?: string; warn_locked?: string };

type WalletClient = { id: number; name: string; email: string; points: number };
type WalletMovement = { id: number; kind: string; deltaPoints: number; note: string; sourceType: string; sourceId: number; createdAt: string; locationId: number; locationName: string };
type WalletPending = { id: number; publicCode: string; startsAt: string; status: string; discountPoints: number; giftPoints: number; locationId: number; locationName: string };
type WalletScheduleRow = { expiresAt: string; points: number; lockedPoints: number };
type WalletDetail = {
  clientId: number;
  clientName: string;
  clientEmail: string;
  adhering: boolean;
  pointsBalance: number;
  reserved: number;
  available: number;
  movements: WalletMovement[];
  txTotal: number;
  txPage: number;
  txPages: number;
  pending: WalletPending[];
  pendingCount: number;
  pendingDiscountTotal: number;
  pendingGiftTotal: number;
  pendingTotal: number;
  pendingLockRefsInline: string;
  pendingLockRefsTitle: string;
  expireEnabled: boolean;
  expireDays: number;
  expireWarnDays: number;
  expiringSoon: number;
  expiredPending: number;
  lockedExpired: number;
  schedule: WalletScheduleRow[];
  nextExpiryAt: string;
  nextExpiryPoints: number;
};
type Wallet = { fidelityEnabled: boolean; pointsEnabled: boolean; hasTxLocation: boolean; expireEnabled?: boolean; expireDays?: number; label?: string; clients: WalletClient[]; detail: WalletDetail | null };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// fmt_points legacy: intero troncato ('0' quando ~0).
function fmtPoints(v: number): string {
  const n = Number(v) || 0;
  if (!Number.isFinite(n) || Math.abs(n) < 0.0000001) return "0";
  return String(n > 0 ? Math.floor(n + 0.000000001) : Math.ceil(n - 0.000000001));
}
function dmy(s: string): string {
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}
function fmtDmyHm(v: string): string {
  const s = String(v ?? "").replace("T", " ");
  if (s.length < 16) return "—";
  return `${dmy(s)} ${s.slice(11, 16)}`;
}
// norm ricerca combobox legacy.
function normSearch(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Combobox clienti (app-combobox legacy).
function ClientCombobox({
  items,
  value,
  placeholder,
  onChange,
}: {
  items: Array<{ id: string; label: string; search: string }>;
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const q = normSearch(search);
  const shown = items.filter((it) => !q || it.search.includes(q));
  const selected = items.find((it) => it.id === value);
  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} ref={boxRef}>
      <button className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`app-combobox-text ${selected ? "" : "d-none"}`}>{selected?.label ?? ""}</span>
        <span className={`text-muted app-combobox-placeholder ${selected ? "d-none" : ""}`}>{placeholder}</span>
      </button>
      <div className={`dropdown-menu p-2 w-100 ${open ? "show" : ""}`}>
        <input type="text" className="form-control form-control-sm app-combobox-search" placeholder="Cerca..." autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="app-combobox-list mt-2" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          {shown.length === 0 ? (
            <div className="text-muted small px-2 py-1">Nessun risultato</div>
          ) : (
            shown.map((it) => (
              <button
                key={it.id}
                type="button"
                className="dropdown-item"
                onClick={() => {
                  onChange(it.id);
                  setSearch("");
                  setOpen(false);
                }}
              >
                {it.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function FidelityWalletContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: FidelityWalletQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [query] = useState(() => ({
    clientId: Math.max(0, Number.parseInt(String(initialQuery?.client_id ?? "0"), 10) || 0),
    p: Math.max(1, Number.parseInt(String(initialQuery?.p ?? "1"), 10) || 1),
    pPending: Math.max(1, Number.parseInt(String(initialQuery?.p_pending ?? "1"), 10) || 1),
    pList: Math.max(1, Number.parseInt(String(initialQuery?.p_list ?? "1"), 10) || 1),
    warnLocked: Math.max(0, Math.round(Number(String(initialQuery?.warn_locked ?? "0").replace(",", ".")) || 0)),
  }));
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filterClientId, setFilterClientId] = useState(query.clientId > 0 ? String(query.clientId) : "");

  // Operazione manuale.
  const [moveClientId, setMoveClientId] = useState(query.clientId > 0 ? String(query.clientId) : "");
  const [op, setOp] = useState("add");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ slug, action: "wallet" });
    if (query.clientId > 0) params.set("client_id", String(query.clientId));
    if (query.p > 1) params.set("p", String(query.p));
    fetch(`/api/manage/fidelity?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.wallet) setWallet(j.wallet as Wallet);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function pageUrl(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }
  function walletUrl(params: Record<string, string | number>): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (String(v) !== "" && String(v) !== "0") usp.set(k, String(v));
    const qs = usp.toString();
    return pageUrl(`fidelity_wallet${qs !== "" ? `?${qs}` : ""}`);
  }

  const clients = useMemo(() => wallet?.clients ?? [], [wallet]);
  const clientItems = useMemo(
    () => clients.map((c) => ({ id: String(c.id), label: c.name !== "" ? c.name : `Cliente #${c.id}`, search: normSearch(`${c.name} ${c.email}`) })),
    [clients],
  );

  const detail = wallet?.detail ?? null;
  const disabled = wallet !== null && (!wallet.fidelityEnabled || !wallet.pointsEnabled);
  const hasTxLocation = wallet?.hasTxLocation ?? false;
  // Etichetta punti configurabile ($s['label'] legacy, default 'Punti').
  const FID_LABEL = wallet?.label?.trim() || "Punti";

  // Punti in sospeso: paginazione legacy 20/pagina via ?p_pending.
  const pendingPages = detail ? Math.max(1, Math.ceil(detail.pendingCount / 20)) : 1;
  const pendPage = Math.min(query.pPending, pendingPages);
  const pendingRows = detail ? detail.pending.slice((pendPage - 1) * 20, pendPage * 20) : [];

  // Lista clienti: paginazione legacy 20/pagina via ?p_list.
  const listPages = Math.max(1, Math.ceil(clients.length / 20));
  const listPage = Math.min(query.pList, listPages);
  const listRows = clients.slice((listPage - 1) * 20, listPage * 20);

  // Alert warn_locked: elenco prenotazioni che stanno prenotando punti.
  const lockedAppts = query.warnLocked > 0 && detail ? detail.pending.slice(0, 50) : [];

  async function submitMove(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "wallet_move", client_id: moveClientId, op, points, note }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      const cid = Math.max(0, Number.parseInt(moveClientId, 10) || 0);
      if (!res.ok || !j.ok) {
        // Redirect flash legacy: ?err (+ warn_locked quando i punti sono tutti prenotati).
        const params: Record<string, string | number> = { client_id: cid, err: String(j.error || "Operazione non riuscita.") };
        if (Number(j.warnLocked ?? 0) > 0) params.warn_locked = String(j.warnLocked);
        window.location.href = walletUrl(params);
        return;
      }
      const params: Record<string, string | number> = { client_id: cid, msg: String(j.message || "") };
      if (op === "remove" && Number(j.lockedReserved ?? 0) > 0) params.warn_locked = String(j.lockedReserved);
      window.location.href = walletUrl(params);
    } catch {
      setBusy(false);
    }
  }

  // Stato disabilitato legacy (early return con header dedicato).
  if (!loading && disabled) {
    return (
      <div className="container-fluid">
        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Portafoglio</div>
            <h1 className="bs-page-title">Fidelity • Portafoglio</h1>
            <div className="bs-page-subtitle">Gestione punti per cliente, movimenti manuali e scadenze.</div>
          </div>
          <div className="bs-page-actions">
            <a className="btn btn-outline-secondary btn-pill" href={pageUrl("wallet")}>
              <i className="bi bi-arrow-left me-1" />
              Portafoglio
            </a>
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

        <div className="alert alert-info">
          {!wallet?.fidelityEnabled ? (
            <>
              <div className="fw-semibold mb-1">
                <i className="bi bi-info-circle me-1" />
                Fidelity disattivata
              </div>
              <div className="small">
                Questa sezione è disabilitata perché l&apos;impostazione generale Fidelity è disattivata. Attiva la funzione in{" "}
                <a href={pageUrl("fidelity")}>Fidelity → Impostazione generale</a>.
              </div>
            </>
          ) : (
            <>
              <div className="fw-semibold mb-1">
                <i className="bi bi-info-circle me-1" />
                Punti Fidelity disattivati
              </div>
              <div className="small">
                Questa sezione è disabilitata perché <strong>Abilita Punti Fidelity</strong> è disattivo. Riattivalo da{" "}
                <a href={pageUrl("fidelity_points")}>Fidelity → Punti</a>.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Portafoglio</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Fidelity • Portafoglio</h1>
            <InfoBox>
              <ul>
                <li><strong>Saldo</strong>: il totale dei punti del cliente.</li>
                <li>
                  <strong>Riservato</strong>: punti impegnati da operazioni in attesa o programmate (prenotazioni con
                  benefici punti non ancora concluse).
                </li>
                <li>
                  <strong>Disponibile</strong>: saldo meno riservato — è il valore effettivamente utilizzabile in cassa e
                  può risultare anche negativo dopo correzioni manuali.
                </li>
                <li>
                  <strong>In scadenza</strong>: con la scadenza punti attiva, i punti che scadranno entro la finestra di
                  preavviso; i punti vincolati a prenotazioni future restano protetti fino alla loro conclusione.
                </li>
              </ul>
              <p>
                Con <strong>Operazione manuale</strong> puoi aggiungere o rimuovere punti e correggere il credito del
                cliente: ogni operazione resta tracciata nei movimenti.
              </p>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Gestione punti per cliente, movimenti manuali e scadenze.</div>
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

      {/* Alert legacy 'Punti prenotati su appuntamenti' (?warn_locked=N). */}
      {query.warnLocked > 0 && query.clientId > 0 ? (
        <div className="alert alert-warning">
          <div className="fw-semibold mb-1">
            <i className="bi bi-exclamation-triangle me-1" />
            Punti prenotati su appuntamenti
          </div>
          <div className="small mb-2">
            {fmtPoints(query.warnLocked)} {FID_LABEL} non possono essere rimossi perché già prenotati su appuntamenti in sospeso/prenotati. Per liberare i punti,
            annulla/cancella l&apos;appuntamento oppure rimuovi l&apos;uso dei punti dall&apos;appuntamento.
          </div>
          {lockedAppts.length > 0 ? (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Stato</th>
                    <th className="text-end">Sconto</th>
                    <th className="text-end">gift</th>
                    <th className="text-end">Totale</th>
                    <th>Codice</th>
                    <th className="text-end">Apri</th>
                  </tr>
                </thead>
                <tbody>
                  {lockedAppts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.startsAt !== "" ? fmtDmyHm(a.startsAt) : "—"}</td>
                      <td>
                        <span className="badge text-bg-secondary">{a.status === "scheduled" ? "Prenotato" : "In sospeso"}</span>
                      </td>
                      <td className="text-end">{fmtPoints(a.discountPoints)}</td>
                      <td className="text-end">{fmtPoints(a.giftPoints)}</td>
                      <td className="text-end fw-semibold">{fmtPoints(a.discountPoints + a.giftPoints)}</td>
                      <td className="text-muted small">{a.publicCode !== "" ? a.publicCode : "—"}</td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-primary" href={pageUrl(`appointments?action=edit&id=${a.id}`)}>
                          <i className="bi bi-box-arrow-up-right" /> Apri
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="small text-muted">Nessun appuntamento trovato.</div>
          )}
        </div>
      ) : null}

      <div className="row g-3 align-items-start">
        <div className="col-12 col-xl-9 order-xl-1">
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                window.location.href = walletUrl({ client_id: filterClientId });
              }}
            >
              <div className="col-lg-4">
                <label className="form-label">Cliente</label>
                <ClientCombobox items={clientItems} value={filterClientId} placeholder="Tutti i clienti" onChange={setFilterClientId} />
              </div>
              <div className="col-lg-4 d-flex align-items-end gap-2 app-filter-actions">
                <button className="btn btn-outline-primary app-filter-submit" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {query.clientId > 0 ? (
                  <a className="btn btn-outline-secondary app-filter-reset" href={pageUrl("fidelity_wallet")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card p-3">
            <div>
              <div>
                <div className="fw-semibold">Portafoglio Punti</div>
                <div className="text-muted small">Seleziona un cliente per vedere saldo, punti prenotati, movimenti e scadenze.</div>
              </div>
            </div>

            <hr />

            {loading ? (
              <div className="text-muted small">Caricamento…</div>
            ) : query.clientId > 0 && detail ? (
              <>
                <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                  <div>
                    <div className="fw-semibold">Cliente</div>
                    <div className="h5 m-0">{detail.clientName}</div>
                    {detail.clientEmail !== "" ? <div className="text-muted small">{detail.clientEmail}</div> : null}
                  </div>
                  <div className="text-end">
                    {detail.expireEnabled && detail.expireDays > 0 ? (
                      <>
                        <div className="text-muted small">Scadenza punti: {detail.expireDays} giorni</div>
                        <div className="text-muted small">Avviso: entro {detail.expireWarnDays} giorni</div>
                      </>
                    ) : (
                      <div className="text-muted small">Scadenza punti: disattivata</div>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  <div className="d-flex flex-wrap gap-3">
                    <div className="p-3 border rounded-3">
                      <div className="text-muted small">Saldo</div>
                      <div className="h4 m-0">{fmtPoints(detail.pointsBalance)}</div>
                    </div>
                    <div className="p-3 border rounded-3">
                      <div className="text-muted small">Prenotati (lock)</div>
                      <div className="h4 m-0">{fmtPoints(detail.reserved)}</div>
                    </div>
                    <div className="p-3 border rounded-3">
                      <div className="text-muted small">Disponibili</div>
                      <div className="h4 m-0">{fmtPoints(detail.available)}</div>
                    </div>
                    <div className="p-3 border rounded-3">
                      <div className="text-muted small">In scadenza entro {detail.expireWarnDays} giorni</div>
                      <div className="h4 m-0">{fmtPoints(detail.expiringSoon)}</div>
                    </div>
                  </div>

                  {detail.available < 0 ? (
                    <div className="alert alert-warning mt-3 mb-0">
                      <div className="fw-semibold">
                        <i className="bi bi-exclamation-triangle me-1" />
                        Disponibile negativo
                      </div>
                      <div className="small">
                        Una parte dei punti risulta vincolata su prenotazioni future: il valore <strong>Disponibili</strong> può scendere sotto zero dopo uno storno anche
                        se i punti <strong>Prenotati (lock)</strong> restano invariati.
                      </div>
                    </div>
                  ) : null}

                  {detail.expireEnabled && detail.expiredPending > 0 ? (
                    <div className="alert alert-warning mt-3 mb-0">
                      <div className="fw-semibold">
                        <i className="bi bi-exclamation-triangle me-1" />
                        Punti già scaduti (cron non eseguito)
                      </div>
                      <div className="small">
                        Risultano circa <strong>{fmtPoints(detail.expiredPending)}</strong> {FID_LABEL} con data scadenza passata. I punti vengono rimossi automaticamente
                        eseguendo il cron <code>cron/fidelity_expire.php</code>.
                      </div>
                    </div>
                  ) : null}

                  {detail.expireEnabled && detail.lockedExpired > 0 ? (
                    <div className="alert alert-info mt-3 mb-0">
                      <div className="fw-semibold">
                        <i className="bi bi-lock me-1" />
                        {FID_LABEL} scaduti ma vincolati
                      </div>
                      <div className="small">
                        Risultano circa <strong>{fmtPoints(detail.lockedExpired)}</strong> {FID_LABEL} con scadenza già passata, ma ancora <strong>vincolati</strong> perché
                        utilizzati come sconto su prenotazioni in sospeso.{" "}
                        {detail.pendingCount > 0 ? (
                          <>
                            <a href="#points-pending" className="link-primary">
                              Vedi punti in sospeso
                            </a>
                            .
                          </>
                        ) : null}
                      </div>
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
                              <th>Scade il</th>
                              <th className="text-end">{FID_LABEL} residui</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.schedule.map((row) => {
                              const lockedAmt = Math.min(row.lockedPoints, row.points);
                              const removableAmt = Math.max(0, row.points - lockedAmt);
                              const isPast = row.expiresAt.slice(0, 10) < new Date().toISOString().slice(0, 10);
                              const rowClass = isPast ? (lockedAmt > 0 && removableAmt <= 0 ? "table-info" : "table-warning") : "";
                              return (
                                <tr className={rowClass} key={row.expiresAt}>
                                  <td>
                                    <div className="fw-semibold">
                                      {dmy(row.expiresAt)}
                                      {lockedAmt > 0 ? <span className="badge bg-info text-dark ms-2">vincolati</span> : null}
                                    </div>
                                    <div className="text-muted small">ore {row.expiresAt.slice(11, 16)}</div>
                                  </td>
                                  <td className="text-end">
                                    <div>{fmtPoints(row.points)}</div>
                                    {lockedAmt > 0 ? (
                                      detail.pendingLockRefsInline !== "" ? (
                                        <div className="text-muted small" title={detail.pendingLockRefsTitle}>
                                          Vincolati su: {detail.pendingLockRefsInline}
                                        </div>
                                      ) : (
                                        <div className="text-muted small">Vincolati: {fmtPoints(lockedAmt)}</div>
                                      )
                                    ) : null}
                                    {isPast && removableAmt > 0 ? <div className="text-muted small">Da rimuovere (cron): {fmtPoints(removableAmt)}</div> : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {detail.nextExpiryAt !== "" ? (
                        <div className="text-muted small mt-2">
                          Prossima scadenza: <strong>{fmtDmyHm(detail.nextExpiryAt)}</strong> ({fmtPoints(detail.nextExpiryPoints)} {FID_LABEL}).
                        </div>
                      ) : null}
                    </>
                  ) : detail.expireEnabled ? (
                    <>
                      <hr />
                      <div className="text-muted small">Nessun punto con scadenza rilevata (saldo consumato o storico vuoto).</div>
                    </>
                  ) : null}

                  <hr />
                  <div className="fw-semibold mb-2">Movimenti punti</div>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Data</th>
                          {hasTxLocation ? <th>Sede</th> : null}
                          <th>Tipo</th>
                          <th className="text-end">Δ</th>
                          <th className="text-muted">Nota</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.movements.length === 0 ? (
                          <tr>
                            <td colSpan={hasTxLocation ? 5 : 4} className="text-muted p-3">
                              Nessun movimento.
                            </td>
                          </tr>
                        ) : (
                          detail.movements.map((mvt) => {
                            let badge = "secondary";
                            if (mvt.kind === "earn") badge = "success";
                            if (mvt.kind === "redeem") badge = "warning";
                            if (mvt.kind === "expire") badge = "danger";
                            if (mvt.kind === "manual" || mvt.kind === "adjust") badge = "info";
                            let typeLbl = mvt.kind === "expire" ? "scadenza" : mvt.kind;
                            if (mvt.sourceType !== "") typeLbl += ` • ${mvt.sourceType}${mvt.sourceId > 0 ? ` #${mvt.sourceId}` : ""}`;
                            const deltaLbl = mvt.deltaPoints >= 0 ? `+${fmtPoints(mvt.deltaPoints)}` : fmtPoints(mvt.deltaPoints);
                            return (
                              <tr key={mvt.id}>
                                <td className="text-muted small">{fmtDmyHm(mvt.createdAt)}</td>
                                {hasTxLocation ? <td className="text-muted small">{mvt.locationName}</td> : null}
                                <td>
                                  <span className={`badge text-bg-${badge}`}>{typeLbl}</span>
                                </td>
                                <td className={`text-end fw-bold ${mvt.deltaPoints >= 0 ? "text-success" : "text-danger"}`}>{deltaLbl}</td>
                                <td className="text-muted small">{mvt.note}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {detail.txPages > 1 ? (
                    <div className="d-flex justify-content-between align-items-center mt-2">
                      <div className="text-muted small">
                        Pagina {detail.txPage} di {detail.txPages} • Totale: {detail.txTotal}
                      </div>
                      <div className="d-flex gap-2">
                        <a
                          className={`btn btn-sm btn-outline-secondary ${detail.txPage <= 1 ? "disabled" : ""}`}
                          href={walletUrl({ client_id: query.clientId, p_pending: pendPage, p: Math.max(1, detail.txPage - 1) })}
                        >
                          « Prev
                        </a>
                        <a
                          className={`btn btn-sm btn-outline-secondary ${detail.txPage >= detail.txPages ? "disabled" : ""}`}
                          href={walletUrl({ client_id: query.clientId, p_pending: pendPage, p: Math.min(detail.txPages, detail.txPage + 1) })}
                        >
                          Next »
                        </a>
                      </div>
                    </div>
                  ) : null}

                  <hr />
                  <div id="points-pending" className="fw-semibold mb-2">
                    Punti in sospeso
                  </div>

                  {detail.pendingCount === 0 ? (
                    <div className="text-muted small">Nessun punto in sospeso.</div>
                  ) : (
                    <>
                      <div className="d-flex flex-wrap gap-2 mb-2">
                        <span className="badge text-bg-warning">
                          Totale sospesi: {fmtPoints(detail.pendingTotal)} {FID_LABEL}
                        </span>
                        <span className="badge text-bg-secondary">Voci: {detail.pendingCount}</span>
                        {detail.pendingDiscountTotal > 0 ? <span className="badge text-bg-secondary">Sconto: {fmtPoints(detail.pendingDiscountTotal)}</span> : null}
                        {detail.pendingGiftTotal > 0 ? <span className="badge text-bg-secondary">omaggio: {fmtPoints(detail.pendingGiftTotal)}</span> : null}
                      </div>
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-0">
                          <thead>
                            <tr>
                              <th>Quando</th>
                              <th>Sede</th>
                              <th>Prenotazione</th>
                              <th>Stato</th>
                              <th className="text-end">{FID_LABEL}</th>
                              <th className="text-muted">Dettaglio</th>
                              <th className="text-end">Apri</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pendingRows.map((p) => (
                              <tr key={p.id}>
                                <td>{p.startsAt !== "" ? fmtDmyHm(p.startsAt) : "—"}</td>
                                <td className="text-muted small">{p.locationName}</td>
                                <td className="fw-semibold">#{p.publicCode !== "" ? p.publicCode : p.id}</td>
                                <td>
                                  <span className={`badge ${p.status === "scheduled" ? "bg-primary" : "bg-warning text-dark"}`}>
                                    {p.status === "scheduled" ? "Prenotato" : "In sospeso"}
                                  </span>
                                </td>
                                <td className="text-end fw-semibold">{fmtPoints(p.discountPoints + p.giftPoints)}</td>
                                <td className="text-muted">
                                  {p.discountPoints > 0 ? (
                                    <>
                                      Sconto: <b>{fmtPoints(p.discountPoints)}</b>
                                    </>
                                  ) : null}
                                  {p.discountPoints > 0 && p.giftPoints > 0 ? " • " : ""}
                                  {p.giftPoints > 0 ? (
                                    <>
                                      omaggio: <b>{fmtPoints(p.giftPoints)}</b>
                                    </>
                                  ) : null}
                                </td>
                                <td className="text-end">
                                  <a className="btn btn-sm btn-outline-primary" href={pageUrl(`appointments?action=edit&id=${p.id}`)}>
                                    <i className="bi bi-box-arrow-up-right" /> Apri
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {pendingPages > 1 ? (
                        <div className="d-flex justify-content-between align-items-center mt-2">
                          <div className="text-muted small">
                            Pagina {pendPage} di {pendingPages} • Totale voci: {detail.pendingCount}
                          </div>
                          <div className="d-flex gap-2">
                            <a
                              className={`btn btn-sm btn-outline-secondary ${pendPage <= 1 ? "disabled" : ""}`}
                              href={walletUrl({ client_id: query.clientId, p: detail.txPage, p_pending: Math.max(1, pendPage - 1) })}
                            >
                              « Prev
                            </a>
                            <a
                              className={`btn btn-sm btn-outline-secondary ${pendPage >= pendingPages ? "disabled" : ""}`}
                              href={walletUrl({ client_id: query.clientId, p: detail.txPage, p_pending: Math.min(pendingPages, pendPage + 1) })}
                            >
                              Next »
                            </a>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="fw-semibold mb-2">Clienti Fidelity</div>

                <div className="table-responsive">
                  <table className="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Email</th>
                        <th className="text-end">{FID_LABEL}</th>
                        <th className="text-end"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {listRows.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-muted p-3">
                            Nessun cliente Fidelity trovato.
                          </td>
                        </tr>
                      ) : (
                        listRows.map((c) => (
                          <tr key={c.id}>
                            <td>{c.name}</td>
                            <td className="text-muted small">{c.email}</td>
                            <td className="text-end">{fmtPoints(c.points)}</td>
                            <td className="text-end">
                              <a className="btn btn-sm btn-outline-secondary" href={walletUrl({ client_id: c.id })}>
                                Dettagli
                              </a>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {listPages > 1 ? (
                  <div className="d-flex justify-content-between align-items-center mt-2">
                    <div className="text-muted small">
                      Pagina {listPage} di {listPages} • Totale clienti: {clients.length}
                    </div>
                    <div className="d-flex gap-2">
                      <a className={`btn btn-sm btn-outline-secondary ${listPage <= 1 ? "disabled" : ""}`} href={walletUrl({ p_list: Math.max(1, listPage - 1) })}>
                        « Prev
                      </a>
                      <a className={`btn btn-sm btn-outline-secondary ${listPage >= listPages ? "disabled" : ""}`} href={walletUrl({ p_list: Math.min(listPages, listPage + 1) })}>
                        Next »
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted small mt-2">
                    Mostriamo i clienti con tessera Fidelity (anche senza {FID_LABEL}). Usa il filtro Cliente per aprire un portafoglio specifico.
                  </div>
                )}
              </>
            )}
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
                  <ClientCombobox items={clientItems} value={moveClientId} placeholder="Seleziona..." onChange={setMoveClientId} />
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Operazione</label>
                  <select className="form-select" name="op" value={op} onChange={(e) => setOp(e.target.value)}>
                    <option value="add">Aggiungi</option>
                    <option value="remove">Rimuovi</option>
                  </select>
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">{FID_LABEL}</label>
                  <input className="form-control" type="number" min="1" step="1" name="points" placeholder="10" value={points} onChange={(e) => setPoints(e.target.value)} />
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Nota (opzionale)</label>
                  <input className="form-control" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <div className="col-12">
                  <button className="btn btn-outline-primary w-100" type="submit" disabled={busy}>
                    <i className="bi bi-arrow-left-right me-1" />
                    Registra
                  </button>
                </div>
              </form>

              <div className="small text-muted mt-2">
                <div>
                  Nota: in caso di rimozione, il sistema non rimuove punti <strong>già prenotati</strong> su appuntamenti in sospeso/prenotati.
                </div>
                {/* Nota legacy dalle impostazioni GLOBALI: visibile anche senza cliente selezionato. */}
                {(wallet?.expireEnabled ?? detail?.expireEnabled) && (wallet?.expireDays ?? detail?.expireDays ?? 0) > 0 ? (
                  <div className="mt-2">
                    La scadenza dei punti viene calcolata dalla data del movimento/accredito: <strong>{wallet?.expireDays ?? detail?.expireDays} giorni</strong>, con
                    validità fino alle <strong>23:59</strong> del giorno di scadenza.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
