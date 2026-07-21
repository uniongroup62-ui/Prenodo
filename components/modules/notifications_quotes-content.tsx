"use client";

import { useEffect, useMemo, useState } from "react";

// Port fedele di app/pages/notifications_quotes.php ("Preventivi"): risposte
// cliente NON lette (status accettato/rifiutato + customer_decision_at
// valorizzato + seen NULL, ordinate per decisione desc, LIMIT 100) con la card
// legacy (Preventivo #numero + badge, Cliente - email, 'Risposta inviata il:',
// Totale preventivo, azioni Apri preventivo / Segna come letto), 'Segna tutti
// come letti' col confirm di notifications_quotes.js e i flash legacy.

type Quote = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  clientEmail?: string;
  total: number;
  status: string;
  acceptedAt?: string;
  customerDecisionAt?: string;
  customerDecisionSeenAt?: string;
  createdAt?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// fmt_money legacy (1.234,56).
function fmtMoney(value: number): string {
  const fixed = Math.abs(Number(value) || 0).toFixed(2);
  const [i, d] = fixed.split(".");
  return `${Number(value) < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

// Euristica alert legacy (notifications_quotes.php 100-109).
function alertTypeFor(msg: string): "success" | "warning" {
  const low = msg.toLowerCase();
  return ["non autorizzata", "non valida", "errore", "impossibile", "non disponibile", "non trovato"].some((n) => low.includes(n)) ? "warning" : "success";
}

export function NotificationsQuotesContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [locationName, setLocationName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    // `loading` parte true e si azzera nel .finally.
    fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setQuotes(Array.isArray(j.quotes) ? j.quotes : []))
      .catch(() => setQuotes([]))
      .finally(() => setLoading(false));

    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const list: Array<{ id: number; name?: string }> = Array.isArray(j.locations) ? j.locations : [];
        const current = list.find((l) => Number(l.id) === Number(j.currentLocationId));
        setLocationName(String(current?.name ?? list[0]?.name ?? ""));
      })
      .catch(() => {});
  }, [slug]);

  // SOLO status accepted/rejected (il legacy filtra sui valori esatti: un
  // preventivo convertito/pagato non è più una risposta) + decisione non letta.
  const responses = useMemo(() => {
    return quotes
      .filter((q) => (q.status === "accepted" || q.status === "rejected") && q.customerDecisionAt && !q.customerDecisionSeenAt)
      .sort((a, b) => String(b.customerDecisionAt ?? "").localeCompare(String(a.customerDecisionAt ?? "")) || b.id - a.id);
  }, [quotes]);
  // LIMIT 100 legacy con totale separato.
  const visible = responses.slice(0, 100);

  // Port di action=seen / seen_all coi flash legacy; seen_all chiede conferma
  // come notifications_quotes.js (data-notifications-quotes-confirm).
  // Audit giro 3: guardia doppio-click (POST multipli su seen/seen_all).
  const [seenBusy, setSeenBusy] = useState(false);
  const markSeen = async (id: number | null) => {
    if (seenBusy) return;
    if (id === null && typeof window !== "undefined" && !window.confirm("Segnare tutti i preventivi come letti?")) return;
    setSeenBusy(true);
    try {
      const response = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(id ? { action: "seen", id: String(id) } : { action: "seen_all" }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok) {
        if (Array.isArray(json.quotes)) setQuotes(json.quotes);
        setFlash(String(json.message || (id ? "Preventivo segnato come letto" : "Preventivi segnati come letti")));
      } else {
        setFlash(String(json.error || "Operazione non valida"));
      }
    } catch {
      setFlash("Operazione non valida");
    } finally {
      setSeenBusy(false);
    }
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };

  const subtitleLocation = locationName ? ` Sede: ${locationName}.` : "";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      {flash ? (
        <div className={`alert alert-${alertTypeFor(flash)} alert-dismissible`} role="alert">
          {flash}
          <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setFlash("")} />
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Notifiche</div>
          <h1 className="bs-page-title">Preventivi</h1>
          <div className="bs-page-subtitle">
            Accettati o rifiutati dall&#039;area clienti del booking.{subtitleLocation}
          </div>
        </div>
        {visible.length > 0 ? (
          <div className="bs-page-actions">
            <button className="btn btn-outline-secondary btn-sm" type="button" disabled={seenBusy} onClick={() => markSeen(null)}>
              <i className="bi bi-check2-all me-1" />
              Segna tutti come letti
            </button>
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessuna risposta sui preventivi."}</div>
          <div className="text-muted small mt-1">
            Quando un cliente accetta o rifiuta un preventivo dall&apos;area clienti, lo vedrai qui.
          </div>
        </div>
      ) : (
        <>
          {visible.map((q) => {
            const isAcc = q.status === "accepted";
            const decLabel = fmtDateTime(q.customerDecisionAt);
            return (
              <div className="card mb-3 notification-card" key={q.id}>
                <div className="d-flex flex-wrap">
                  <div className={`p-3 flex-grow-1 notification-main ${isAcc ? "notification-main--success" : "notification-main--danger"}`}>
                    <div className="d-flex align-items-center justify-content-between gap-2">
                      <div className="fw-bold fs-5 mb-1">Preventivo #{q.code}</div>
                      <span className={`badge ${isAcc ? "bg-success" : "bg-danger"}`}>{isAcc ? "Accettato" : "Rifiutato"}</span>
                    </div>

                    <div className="text-muted small">
                      Cliente: <strong>{q.clientName || "-"}</strong>
                      {q.clientEmail ? <> - {q.clientEmail}</> : null}
                    </div>

                    {decLabel ? (
                      <div className="text-muted small mt-1">Risposta inviata il: <strong>{decLabel}</strong></div>
                    ) : null}

                    <div className="mt-3">
                      <div className="text-muted small">Totale preventivo</div>
                      <div className="fw-bold">€ {fmtMoney(q.total)}</div>
                    </div>
                  </div>

                  <div className="p-3 notification-action">
                    <div className="d-grid gap-2">
                      <a className="btn btn-outline-primary btn-sm" href={`/${encodeURIComponent(slug)}/quotes?action=view&id=${q.id}`}>
                        <i className="bi bi-box-arrow-up-right me-1" />
                        Apri preventivo
                      </a>
                      <button className="btn btn-outline-secondary btn-sm w-100" type="button" disabled={seenBusy} onClick={() => markSeen(q.id)}>
                        <i className="bi bi-check2 me-1" />
                        Segna come letto
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="text-muted small mt-2">
            Mostrando preventivi da 1 a {visible.length} di {responses.length} totali
          </div>
        </>
      )}
    </div>
  );
}
