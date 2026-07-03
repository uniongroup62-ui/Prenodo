"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP credit movements page (app/pages/credit_movements.php,
// ?page=credit_movements): "Movimenti Credito". Wired to /api/manage/fidelity:
//   - GET  action=credit[&client_id=N] -> { clients, movements, pending, total }
//   - POST action=credit_debit (client_id, amount, note) — manual credit scale
// The ledger merges recharges (+ storni), appointment + sale credit usage, and
// manual credit_adjustments (newest first). The manual debit is guarded
// (blocked client / note required / sufficient balance), like the legacy.

type CreditClient = { id: number; name: string; email: string; credit: number };
type MovementKind = "recharge" | "void" | "redeem" | "manual_debit" | "manual_credit";
type Movement = {
  createdAt: string;
  clientId: number;
  clientName: string;
  kind: MovementKind;
  sourceType: string;
  sourceId: number;
  locationName: string;
  rechargeAmount: number | null;
  bonusAmount: number | null;
  totalAmount: number;
  note: string;
};
type Pending = { id: number; publicCode: string; clientId: number; clientName: string; startsAt: string; status: string; creditUsed: number };
type CreditData = { clients: CreditClient[]; movements: Movement[]; pending: Pending[]; total: number; page?: number; perPage?: number; totalPages?: number };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Signed euro amount ("+€ 12,00" / "-€ 12,00"), matching the legacy formatCreditAmount(signed).
function signedEuro(n: number): string {
  if (Math.abs(n) < 0.00001) return "€ 0,00";
  const s = Math.abs(n).toFixed(2).replace(".", ",");
  return `${n > 0 ? "+€ " : "-€ "}${s}`;
}

const BADGES: Record<MovementKind, { cls: string; label: string }> = {
  recharge: { cls: "bg-success", label: "ricarica" },
  void: { cls: "bg-danger", label: "storno" },
  redeem: { cls: "bg-warning text-dark", label: "utilizzo" },
  manual_debit: { cls: "bg-danger", label: "scalo manuale" },
  manual_credit: { cls: "bg-info text-dark", label: "rettifica manuale" },
};

export function CreditMovementsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [data, setData] = useState<CreditData | null>(null);
  const [selectedClientId, setSelectedClientId] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Manual operation form.
  const [manualClientId, setManualClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    return fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=credit${selectedClientId ? `&client_id=${selectedClientId}` : ""}&page=${page}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.credit) setData(j.credit as CreditData);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [slug, selectedClientId, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Cambiando filtro cliente si torna alla prima pagina (come il legacy).
  useEffect(() => {
    setPage(1);
  }, [selectedClientId]);

  const clients = useMemo(() => data?.clients ?? [], [data]);
  const movements = data?.movements ?? [];
  const pending = data?.pending ?? [];

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setErr("");
    if (!manualClientId) {
      setErr("Seleziona un cliente.");
      return;
    }
    if (!window.confirm("Confermi lo scalo manuale del credito?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "credit_debit", client_id: manualClientId, amount, note }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(String(j.error || "Operazione non riuscita."));
      setMsg(String(j.message || "Scalo registrato."));
      setAmount("");
      setNote("");
      if (j.movements) setData(j.movements as CreditData);
      else await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  const pendingTotal = pending.reduce((s, p) => s + p.creditUsed, 0);

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/recharges.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Portafoglio</div>
          <h1 className="bs-page-title">Movimenti Credito</h1>
          <div className="bs-page-subtitle">Consulta movimenti, filtri e saldi credito.</div>
        </div>
        <div className="bs-page-actions">
          <div className="text-muted small">{data ? `${data.total} movimenti` : ""}</div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="row g-3 align-items-start">
        <div className="col-12 col-xl-9 order-xl-1">
          <div className="card p-3 mb-3">
            <div className="row g-2 align-items-end">
              <div className="col-lg-8">
                <label className="form-label">Cliente</label>
                <select className="form-select" value={selectedClientId} onChange={(e) => setSelectedClientId(Number(e.target.value))}>
                  <option value={0}>Tutti i clienti</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.credit ? `— € ${c.credit.toFixed(2).replace(".", ",")}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {pending.length > 0 ? (
            <div className="card p-3 mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <div className="fw-semibold">Credito in sospeso</div>
                <div className="text-muted small">Totale € {pendingTotal.toFixed(2).replace(".", ",")}</div>
              </div>
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead>
                    <tr>
                      <th>Prenotazione</th>
                      <th>Cliente</th>
                      <th>Data</th>
                      <th>Stato</th>
                      <th className="text-end">Credito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((p) => (
                      <tr key={p.id}>
                        <td>{p.publicCode}</td>
                        <td>{p.clientName || `#${p.clientId}`}</td>
                        <td>{fmtDateTime(p.startsAt)}</td>
                        <td>{p.status === "pending" ? "In sospeso" : "Prenotato"}</td>
                        <td className="text-end">€ {p.creditUsed.toFixed(2).replace(".", ",")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="card p-3">
            <div className="fw-semibold mb-2">Movimenti Credito</div>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Cliente</th>
                    <th>Tipo</th>
                    <th>Sede</th>
                    <th>Nota</th>
                    <th className="text-end">Importo</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessun movimento."}
                      </td>
                    </tr>
                  ) : (
                    movements.map((m) => {
                      const badge = BADGES[m.kind];
                      return (
                        <tr key={`${m.sourceType}-${m.sourceId}-${m.kind}`}>
                          <td>{fmtDateTime(m.createdAt)}</td>
                          <td>{m.clientName || `#${m.clientId}`}</td>
                          <td>
                            <span className={`badge ${badge.cls}`}>{badge.label}</span>
                          </td>
                          <td className="text-muted">{m.locationName || "—"}</td>
                          <td className="text-muted">{m.note}</td>
                          <td className={`text-end fw-semibold ${m.totalAmount < 0 ? "text-danger" : m.totalAmount > 0 ? "text-success" : "text-muted"}`}>
                            {signedEuro(m.totalAmount)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {data && (data.totalPages ?? 1) > 1 ? (
              <div className="card-footer d-flex flex-wrap justify-content-between align-items-center gap-2">
                <div className="text-muted small">
                  Pagina {data.page ?? 1} di {data.totalPages} • {data.total} movimenti
                </div>
                <div className="btn-group btn-group-sm">
                  <button
                    className="btn btn-outline-secondary"
                    type="button"
                    disabled={loading || (data.page ?? 1) <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    « Precedente
                  </button>
                  <button
                    className="btn btn-outline-secondary"
                    type="button"
                    disabled={loading || (data.page ?? 1) >= (data.totalPages ?? 1)}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Successiva »
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="col-12 col-xl-3 order-xl-2">
          <div className="card mb-3">
            <div className="card-header">
              <div className="fw-semibold">Operazione manuale</div>
            </div>
            <div className="card-body">
              <form className="row g-3" onSubmit={submitManual}>
                <div className="col-12">
                  <label className="form-label fw-semibold">Cliente</label>
                  <select className="form-select" value={manualClientId} onChange={(e) => setManualClientId(e.target.value)}>
                    <option value="">Seleziona…</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.credit ? `— € ${c.credit.toFixed(2).replace(".", ",")}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Importo da scalare</label>
                  <div className="input-group">
                    <span className="input-group-text">€</span>
                    <input className="form-control" type="number" step="0.01" min="0.01" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </div>
                </div>
                <div className="col-12">
                  <label className="form-label fw-semibold">Nota</label>
                  <input className="form-control" placeholder="Motivo dello scalo (obbligatorio)" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <div className="col-12">
                  <button className="btn btn-outline-danger w-100" type="submit" disabled={busy}>
                    <i className="bi bi-dash-circle me-1" />
                    {busy ? "Registrazione…" : "Scala credito"}
                  </button>
                </div>
              </form>
              <div className="small text-muted mt-2">Lo scalo manuale riduce il credito del cliente e resta tracciato nei movimenti. La nota è obbligatoria.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
