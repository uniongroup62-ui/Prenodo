"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP quotes list page (app/pages/quotes.php), fed by the
// existing DB-backed /api/manage/quotes. Reproduces the original Bootstrap
// markup (bs-page-header, filter card, list table, empty state) verbatim.

type QuoteLine = {
  id: number;
  type: string;
  refId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

type Quote = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  total: number;
  status: string;
  publicToken?: string;
  expiresAt?: string;
  acceptedAt?: string;
  convertedSaleId?: number;
  createdAt?: string;
};

// PHP filter dropdown options (label + value), reproduced verbatim.
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "draft", label: "Bozza" },
  { value: "sent", label: "Inviato" },
  { value: "expired", label: "Scaduto" },
  { value: "accepted", label: "Accettato" },
  { value: "paid", label: "Pagato" },
  { value: "rejected", label: "Rifiutato" },
  { value: "canceled", label: "Annullato" },
];

// Map of API/PHP status -> { label, Bootstrap badge class } used in the table.
const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  draft: { label: "Bozza", cls: "text-bg-secondary" },
  sent: { label: "Inviato", cls: "text-bg-info" },
  expired: { label: "Scaduto", cls: "text-bg-warning" },
  accepted: { label: "Accettato", cls: "text-bg-success" },
  converted: { label: "Pagato", cls: "text-bg-success" },
  paid: { label: "Pagato", cls: "text-bg-success" },
  rejected: { label: "Rifiutato", cls: "text-bg-danger" },
  canceled: { label: "Annullato", cls: "text-bg-dark" },
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusBadge(status: string): { label: string; cls: string } {
  return STATUS_BADGES[status] ?? { label: status || "—", cls: "text-bg-secondary" };
}

export function QuotesContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  // Filter form state (legacy: GET form with client_id / status / date / number).
  const [clientId, setClientId] = useState("0");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [number, setNumber] = useState("");
  const [applied, setApplied] = useState({ clientId: "0", status: "", date: "", number: "" });

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setQuotes(Array.isArray(j.quotes) ? j.quotes : []))
      .catch(() => setQuotes([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // Distinct client list for the filter combobox, derived from loaded quotes.
  const clientItems = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of quotes) {
      if (q.clientId > 0) map.set(String(q.clientId), q.clientName || "Cliente");
    }
    return Array.from(map, ([id, label]) => ({ id, label }));
  }, [quotes]);

  // Client-side filtering (the API exposes no filter params).
  const filtered = useMemo(() => {
    return quotes.filter((q) => {
      if (applied.clientId && applied.clientId !== "0" && String(q.clientId) !== applied.clientId) return false;
      if (applied.status && q.status !== applied.status) return false;
      if (applied.date && (q.createdAt ?? "").slice(0, 10) !== applied.date) return false;
      if (applied.number && !String(q.code ?? "").toLowerCase().includes(applied.number.toLowerCase())) return false;
      return true;
    });
  }, [quotes, applied]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`quotes${suffix}`.replace("&", "?")}`;
  }

  // Delete a DRAFT quote via POST (the server refuses sent/converted ones).
  // Confirm-gated. Replaces the old GET ?action=delete link (Tailwind fallback).
  async function deleteQuote(q: Quote) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questo preventivo?")) return;
    setBusyId(q.id);
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: q.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare il preventivo.");
      } else {
        load();
      }
    } finally {
      setBusyId(0);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Vendite</div>
          <h1 className="bs-page-title">Preventivi</h1>
          <div className="bs-page-subtitle">Crea e gestisci preventivi per i tuoi clienti.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/quote_settings`}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
            <a className="btn btn-primary btn-pill" href={href("&action=new")}>
              <i className="bi bi-plus-lg me-1" />
              Nuovo preventivo
            </a>
          </div>
        </div>
      </div>

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ clientId, status, date, number });
          }}
        >
          <div className="col-lg-3">
            <label className="form-label">Cliente</label>
            <select className="form-select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="0">Tutti</option>
              {clientItems.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="col-lg-2">
            <label className="form-label">Stato</label>
            <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tutti</option>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="col-lg-2">
            <label className="form-label">Data</label>
            <input type="date" className="form-control" name="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="col-lg-2">
            <label className="form-label">Numero</label>
            <input
              className="form-control"
              name="number"
              placeholder="Es. 12/2026"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </div>

          <div className="col-lg-3 d-flex align-items-center gap-3 flex-wrap app-filter-actions">
            <button className="btn btn-outline-primary app-filter-submit" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            <a
              className="btn btn-outline-secondary app-filter-reset"
              href={href("")}
              onClick={(e) => {
                e.preventDefault();
                setClientId("0");
                setStatus("");
                setDate("");
                setNumber("");
                setApplied({ clientId: "0", status: "", date: "", number: "" });
              }}
            >
              Reset
            </a>
          </div>
        </form>
      </div>

      {!loading && quotes.length === 0 ? (
        <div className="card border-0 shadow-sm quotes-empty-card">
          <div className="quotes-empty-state">
            <div className="quotes-empty-icon" aria-hidden="true">
              <i className="bi bi-file-earmark-text" />
            </div>
            <h2>Nessun preventivo presente</h2>
            <p>
              Crea il primo preventivo per preparare proposte, inviarle ai clienti e trasformarle in vendite quando vengono
              accettate.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo preventivo
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Numero</th>
                  <th>Cliente</th>
                  <th>Sede</th>
                  <th>Stato</th>
                  <th className="text-end">Totale</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted small p-3">
                      {loading ? "Caricamento…" : "Nessun preventivo."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((q) => {
                    const badge = statusBadge(q.status);
                    return (
                      <tr key={q.id}>
                        <td>{fmtDate(q.createdAt)}</td>
                        <td className="fw-semibold">{q.code}</td>
                        <td>{q.clientName}</td>
                        <td>—</td>
                        <td>
                          <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        </td>
                        <td className="text-end fw-semibold">{fmtEuro(q.total)}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" href={href(`&action=view&id=${q.id}`)}>
                            Apri
                          </a>{" "}
                          {q.status !== "converted" ? (
                            <>
                              <a
                                className="btn btn-sm btn-success"
                                href={`/${encodeURIComponent(slug)}/pos?quote=${q.id}`}
                                title="Carica il preventivo in cassa e incassa"
                              >
                                Incassa
                              </a>{" "}
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            disabled={busyId === q.id}
                            onClick={() => deleteQuote(q)}
                          >
                            Elimina
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
