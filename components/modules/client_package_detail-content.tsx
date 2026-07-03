"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP client-package DETAIL (packages.php action=client_view),
// fed by /api/manage/packages?action=view&id=<id>:
//   - header (cliente / pacchetto / stato / date / sedute totali+residue / vendita)
//   - Contenuti (client_package_services: nome + sedute totali/residue)
//   - Storico utilizzi (client_package_usages: data / voce / delta / nota)
//   - "Aggiorna scadenza" (only when the package is untouched — port of
//     update_client_package_expiry's guards)

type Content = { id: number; serviceId: number; serviceName: string; sessionsTotal: number; sessionsRemaining: number };
type Usage = { id: number; usedAt: string; delta: number; note: string; itemType: string; itemName: string; appointmentCode: string };
type Detail = {
  id: number;
  clientId: number;
  clientName: string;
  packageName: string;
  serviceName: string;
  sessionsTotal: number;
  sessionsRemaining: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  purchaseDate: string;
  startDate: string;
  expiresAt: string;
  saleId: number | null;
  contents: Content[];
  usages: Usage[];
  canEditExpiry: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function clientPackageIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function fmtDate(v: string): string {
  const s = (v ?? "").slice(0, 10);
  if (s === "") return "—";
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : "—";
}
function fmtDateTime(v: string): string {
  const s = (v ?? "").trim();
  return s !== "" ? s.slice(0, 16).replace("T", " ") : "—";
}

export function ClientPackageDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [cpId, setCpId] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [expiry, setExpiry] = useState("");
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Usage (scala/ripristina) form.
  const [usageOp, setUsageOp] = useState<"consume" | "restore">("consume");
  const [usageQty, setUsageQty] = useState(1);
  const [usageServiceId, setUsageServiceId] = useState(0);
  const [usageNote, setUsageNote] = useState("");
  const [savingUsage, setSavingUsage] = useState(false);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const id = clientPackageIdFromUrl();
    if (id > 0) setCpId(id);
    else {
      setError("Pacchetto non valido.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cpId) return;
    let active = true;
    setLoading(true);
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=view&id=${cpId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        if (j && j.ok && j.detail) {
          setData(j.detail);
          setExpiry(String(j.detail.expiresAt ?? ""));
          setError("");
        } else {
          setError(j?.error || "Pacchetto cliente non trovato.");
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento del pacchetto.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cpId, slug, reloadKey]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  // Register a manual usage movement (scala/ripristina) — port of usage_add.
  async function saveUsage(e: React.FormEvent) {
    e.preventDefault();
    if (savingUsage) return;
    setSavingUsage(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "usage_add", client_package_id: String(cpId), op: usageOp, qty: String(usageQty), service_id: String(usageServiceId), note: usageNote }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Errore nella registrazione dell'utilizzo."));
      } else {
        setFlash("Movimento registrato.");
        setUsageNote("");
        setUsageQty(1);
        reload();
      }
    } finally {
      setSavingUsage(false);
    }
  }

  async function saveExpiry(e: React.FormEvent) {
    e.preventDefault();
    if (savingExpiry) return;
    setSavingExpiry(true);
    setError("");
    setFlash("");
    try {
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "update_expiry", client_package_id: String(cpId), expires_at: expiry }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        setError(String(j?.error ?? "Errore aggiornamento scadenza."));
      } else {
        setFlash("Scadenza pacchetto aggiornata.");
        reload();
      }
    } finally {
      setSavingExpiry(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Pacchetto cliente</div>
          <h1 className="bs-page-title">{data?.packageName || "Pacchetto"}</h1>
          <div className="bs-page-subtitle">{data?.clientName || "Dettaglio pacchetto, sedute e utilizzi."}</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={page("packages&tab=clients")}>
            <i className="bi bi-arrow-left me-1" />
            Pacchetti clienti
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {flash ? <div className="alert alert-success">{flash}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : data ? (
        <div className="row g-3">
          {/* Left: header + expiry */}
          <div className="col-lg-4">
            <div className="card p-3">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <span className={`badge ${data.statusBadge}`}>{data.statusLabel}</span>
                {data.saleId ? (
                  <a className="btn btn-sm btn-outline-secondary" href={page(`pos_sale_detail&id=${data.saleId}`)}>
                    Vendita #{data.saleId}
                  </a>
                ) : null}
              </div>
              <div className="display-6 fw-bold">
                {data.sessionsRemaining} <span className="fs-6 text-muted">/ {data.sessionsTotal} sedute</span>
              </div>
              <div className="text-muted small mt-2">
                {data.clientId ? (
                  <div>
                    Cliente:{" "}
                    <a href={page(`clients&action=view&id=${data.clientId}`)}>{data.clientName || `#${data.clientId}`}</a>
                  </div>
                ) : null}
                <div>Acquisto: {fmtDate(data.purchaseDate)}</div>
                <div>Inizio: {fmtDate(data.startDate)}</div>
                <div>Scadenza: {fmtDate(data.expiresAt)}</div>
              </div>
            </div>

            <div className="card p-3 mt-3">
              <div className="fw-semibold mb-2">
                <i className="bi bi-calendar-event me-1" />
                Aggiorna scadenza
              </div>
              {data.canEditExpiry ? (
                <form className="d-flex gap-2" onSubmit={saveExpiry}>
                  <input className="form-control" type="date" value={expiry.slice(0, 10)} onChange={(e) => setExpiry(e.target.value)} />
                  <button className="btn btn-primary" type="submit" disabled={savingExpiry}>
                    {savingExpiry ? "…" : "Salva"}
                  </button>
                </form>
              ) : (
                <div className="text-muted small">
                  La scadenza non è modificabile: il pacchetto è già stato utilizzato o annullato.
                </div>
              )}
            </div>

            {data.status !== "cancelled" ? (
              <div className="card p-3 mt-3">
                <div className="fw-semibold mb-2">
                  <i className="bi bi-sliders me-1" />
                  Registra utilizzo
                </div>
                <form className="d-flex flex-column gap-2" onSubmit={saveUsage}>
                  <div className="d-flex gap-2">
                    <select className="form-select" value={usageOp} onChange={(e) => setUsageOp(e.target.value as "consume" | "restore")}>
                      <option value="consume">Scala</option>
                      <option value="restore">Ripristina</option>
                    </select>
                    <input className="form-control" type="number" min={1} step={1} style={{ maxWidth: "6rem" }} value={usageQty} onChange={(e) => setUsageQty(Math.max(1, Number(e.target.value) || 1))} />
                  </div>
                  {data.contents.length > 0 ? (
                    <select className="form-select" value={usageServiceId} onChange={(e) => setUsageServiceId(Number(e.target.value))}>
                      {data.contents.length > 1 ? <option value={0}>Seleziona servizio…</option> : null}
                      {data.contents.map((c) => (
                        <option key={c.id} value={c.serviceId}>
                          {c.serviceName} ({c.sessionsRemaining}/{c.sessionsTotal})
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input className="form-control" placeholder="Nota (opzionale)" value={usageNote} maxLength={255} onChange={(e) => setUsageNote(e.target.value)} />
                  <button className="btn btn-outline-primary" type="submit" disabled={savingUsage}>
                    {savingUsage ? "Registrazione…" : "Registra"}
                  </button>
                </form>
                <div className="form-text mt-1">Scala = diminuisce le residue. Ripristina = aumenta le residue.</div>
              </div>
            ) : null}
          </div>

          {/* Right: contents + usages */}
          <div className="col-lg-8">
            <div className="card">
              <div className="card-header fw-semibold">
                <i className="bi bi-collection me-2" />
                Contenuti
              </div>
              <div className="table-responsive">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Servizio</th>
                      <th className="text-end">Residue</th>
                      <th className="text-end">Totali</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.contents.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-muted p-3">
                          {data.serviceName !== "" ? `${data.serviceName} — ${data.sessionsRemaining}/${data.sessionsTotal}` : "Nessun contenuto dettagliato."}
                        </td>
                      </tr>
                    ) : (
                      data.contents.map((c) => (
                        <tr key={c.id}>
                          <td className="fw-semibold">{c.serviceName}</td>
                          <td className="text-end">{c.sessionsRemaining}</td>
                          <td className="text-end text-muted">{c.sessionsTotal}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card mt-3">
              <div className="card-header fw-semibold">
                <i className="bi bi-clock-history me-2" />
                Storico utilizzi
              </div>
              <div className="table-responsive">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Voce</th>
                      <th className="text-end">Variazione</th>
                      <th>Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usages.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-muted p-3">
                          Nessun utilizzo registrato.
                        </td>
                      </tr>
                    ) : (
                      data.usages.map((u) => (
                        <tr key={u.id}>
                          <td className="text-muted">{fmtDateTime(u.usedAt)}</td>
                          <td>{u.itemName || (u.itemType === "product" ? "Prodotto" : "Servizio")}</td>
                          <td className={`text-end fw-semibold ${u.delta < 0 ? "text-danger" : "text-success"}`}>
                            {u.delta > 0 ? `+${u.delta}` : u.delta}
                          </td>
                          <td className="text-muted small">
                            {u.note || "—"}
                            {u.appointmentCode ? <span className="ms-1">({u.appointmentCode})</span> : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
