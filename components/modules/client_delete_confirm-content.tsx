"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP client delete-confirm page (clients.php
// action=delete_confirm -> client_delete_render_confirmation): header
// "Rimozione cliente" con subtitle "<nome> (email) ID: N", alert danger di
// conferma, card "Cosa verrà eliminato" con le voci legacy (incluso il quirk
// "gifts" minuscolo e Punti formattati fmt_money), Motivazione obbligatoria +
// conferma testuale ELIMINA, submit "Elimina definitivamente". La scelta stock
// NON è esposta (hidden legacy stock_restore_mode=no_restore). Il successo
// redirige alla lista con "Clienti eliminati definitivamente: N".

type DeleteSummary = Record<string, number>;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clientIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Port of fmt_money(): number_format(n, 2, ',', '.').
function fmtMoney(n: number): string {
  const v = Number(n || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

export function ClientDeleteConfirmContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clientId, setClientId] = useState(0);
  const [clientLabel, setClientLabel] = useState<{ name: string; email: string } | null>(null);
  const [summary, setSummary] = useState<DeleteSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  // Microtask: evita il setState sincrono nell'effect (primo paint invariato).
  useEffect(() => {
    void Promise.resolve().then(() => {
      const id = clientIdFromUrl();
      if (id > 0) setClientId(id);
      else if (typeof window !== "undefined") {
        // Legacy: nessun id -> lista con "Nessun cliente selezionato."
        window.location.href = `/${encodeURIComponent(slug)}/clients?err=${encodeURIComponent("Nessun cliente selezionato.")}`;
      }
    });
  }, [slug]);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    Promise.all([
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=get&id=${clientId}`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()),
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=delete_summary&id=${clientId}`, { headers: { "x-tenant-slug": slug } }).then((r) => r.json()),
    ])
      .then(([cj, sj]) => {
        if (!active) return;
        if (!cj?.ok || !cj.client) {
          window.location.href = `/${encodeURIComponent(slug)}/clients?err=${encodeURIComponent("Cliente non trovato o non disponibile per le tue sedi.")}`;
          return;
        }
        setClientLabel({ name: String(cj.client.name ?? `Cliente #${clientId}`), email: String(cj.client.email ?? "") });
        if (sj?.ok && sj.summary) setSummary(sj.summary as DeleteSummary);
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento del riepilogo.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId, slug]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "delete",
          id: String(clientId),
          delete_reason: reason,
          delete_confirm_text: confirmText,
          stock_restore_mode: "no_restore",
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nell'eliminazione."));
        setBusy(false);
        if (typeof window !== "undefined") window.scrollTo(0, 0);
        return;
      }
      // Messaggio legacy: conteggio clienti eliminati (+ stock ripristinato).
      const deletedClients = Number(j.counts?.clienti ?? 1);
      let message = `Clienti eliminati definitivamente: ${deletedClients}`;
      if (Number(j.restoredStockQty ?? 0) > 0) message += ` - Stock ripristinato: ${Number(j.restoredStockQty)} pezzi`;
      window.location.href = `/${encodeURIComponent(slug)}/clients?msg=${encodeURIComponent(message)}`;
    } catch {
      setError("Errore nell'eliminazione.");
      setBusy(false);
    }
  }

  const s = summary ?? {};
  // Voci e ordine verbatim della pagina legacy (incluso "gifts" minuscolo).
  const visibleSummary: Array<[string, string]> = [
    ["Vendite", String(s.vendite ?? 0)],
    ["Righe vendita", String(s.righe_vendita ?? 0)],
    ["Prenotazioni", String(s.prenotazioni ?? 0)],
    ["Rate", String(s.rate ?? 0)],
    ["Commissioni", String(s.commissioni ?? 0)],
    ["Prepagati", String(s.prepagati ?? 0)],
    ["Pacchetti", String(s.pacchetti ?? 0)],
    ["GiftCard", String(s.giftcard ?? 0)],
    ["GiftBox", String(s.giftbox ?? 0)],
    ["gifts", String(s.gifts ?? 0)],
    ["Preventivi", String(s.preventivi ?? 0)],
    ["Tessere Fidelity", String(s.tessere ?? 0)],
    ["Documenti", String(s.documenti ?? 0)],
    ["Consensi", String(s.consensi ?? 0)],
    ["Schede cliente", String(s.schede_cliente ?? 0)],
    ["File allegati", String(s.file_allegati ?? 0)],
    ["Account booking", String(s.account_booking ?? 0)],
    ["Attivita account cliente", String(s.account_cliente_attivita ?? 0)],
    ["Movimenti Fidelity", String(s.movimenti_fidelity ?? 0)],
    ["Ricariche", String(s.ricariche ?? 0)],
    ["Rettifiche credito", String(s.rettifiche_credito ?? 0)],
    ["Riferimenti campagne", String(s.riferimenti_campagne ?? 0)],
    ["Credito cliente", `€ ${fmtMoney(Number(s.credito_cliente ?? 0))}`],
    ["Punti", fmtMoney(Number(s.punti ?? 0))],
    ["Saldo GiftCard", `€ ${fmtMoney(Number(s.saldo_giftcard ?? 0))}`],
    ["Documenti magazzino", String(s.documenti_magazzino ?? 0)],
  ];

  const subtitle = clientLabel
    ? `${clientLabel.name}${clientLabel.email !== "" ? ` (${clientLabel.email})` : ""} ID: ${clientId}`
    : "";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      {error ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{error}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Clienti</div>
          <h1 className="bs-page-title">Rimozione cliente</h1>
          <div className="bs-page-subtitle">{subtitle}</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients`}>
            <i className="bi bi-arrow-left me-1" />
            Torna ai clienti
          </a>
        </div>
      </div>

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form onSubmit={onSubmit}>
          <div className="alert alert-danger">
            <div className="fw-semibold">Conferma rimozione cliente</div>
            <div>Questa operazione eliminerà definitivamente il cliente e tutti i dati collegati. Non sarà possibile recuperarli.</div>
          </div>

          <div className="card mb-3">
            <div className="card-header fw-semibold">Cosa verrà eliminato</div>
            <div className="card-body">
              <div className="row g-2">
                {visibleSummary.map(([label, value]) => (
                  <div className="col-12 col-md-6 col-xl-4" key={label}>
                    <div className="border rounded p-2 h-100 d-flex justify-content-between gap-2">
                      <span className="text-muted">{label}</span>
                      <strong>{value}</strong>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-body">
              <div className="mb-3">
                <label className="form-label fw-semibold">Motivazione</label>
                <textarea
                  className="form-control"
                  name="delete_reason"
                  rows={3}
                  required
                  maxLength={500}
                  placeholder="Es. cliente duplicato / richiesta cancellazione / dati di test..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="mb-0">
                <label className="form-label fw-semibold">Conferma testuale</label>
                <input
                  className="form-control"
                  name="delete_confirm_text"
                  required
                  placeholder="Scrivi ELIMINA"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <div className="form-text">Per procedere devi scrivere esattamente ELIMINA.</div>
              </div>
            </div>
          </div>

          <div className="d-flex justify-content-end gap-2">
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/clients`}>
              Annulla
            </a>
            <button className="btn btn-danger" type="submit" disabled={busy}>
              <i className="bi bi-trash me-1" />
              Elimina definitivamente
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
