"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP quote-notifications page (index.php?page=notifications_quotes,
// title "Preventivi"). The legacy page lists quotes that were accepted or rejected from
// the booking client area for the current location. There is no dedicated quote-response
// API, so responses are derived from the DB-backed /api/manage/quotes feed (status
// accepted/rejected). When none are present the page shows the verbatim empty state, which
// matches the live PHP capture for this tenant.

type Quote = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  total: number;
  status: string;
  acceptedAt?: string;
  customerDecisionAt?: string;
  customerDecisionSeenAt?: string;
  createdAt?: string;
};

type LocationRow = {
  id: number;
  name?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtEuro(n: number): string {
  return `€ ${Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Accepted / rejected responses from the booking client area.
const ACCEPTED = new Set(["accepted", "paid", "converted"]);
const REJECTED = new Set(["rejected", "canceled"]);

export function NotificationsQuotesContent() {
  const slug = tenantSlug();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [locationName, setLocationName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
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
        const list: LocationRow[] = Array.isArray(j.locations) ? j.locations : [];
        const current = list.find((l) => Number(l.id) === Number(j.currentLocationId));
        setLocationName(String(current?.name ?? list[0]?.name ?? ""));
      })
      .catch(() => {});
  }, [slug]);

  // Responses = decisioni cliente NON ancora lette (come il legacy:
  // customer_decision_at valorizzato e customer_decision_seen_at NULL),
  // piu' recenti in alto.
  const responses = useMemo(() => {
    return quotes
      .filter((q) => (ACCEPTED.has(q.status) || REJECTED.has(q.status)) && q.customerDecisionAt && !q.customerDecisionSeenAt)
      .map((q) => ({
        ...q,
        accepted: ACCEPTED.has(q.status),
        when: q.customerDecisionAt ?? q.acceptedAt ?? q.createdAt,
      }))
      .sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));
  }, [quotes]);

  // "Segna come letto" / "Segna tutti come letti" (port di
  // notifications_quotes.php action=seen / seen_all).
  const markSeen = async (id: number | null) => {
    try {
      const response = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(id ? { action: "seen", id: String(id) } : { action: "seen_all" }),
      });
      const json = await response.json().catch(() => ({}));
      if (json.ok && Array.isArray(json.quotes)) setQuotes(json.quotes);
    } catch {
      // best-effort
    }
  };

  const subtitleLocation = locationName ? ` Sede: ${locationName}.` : "";

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`notifications_quotes${suffix}`.replace("&", "?")}`;
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Notifiche</div>
          <h1 className="bs-page-title">Preventivi</h1>
          <div className="bs-page-subtitle">
            Accettati o rifiutati dall&#039;area clienti del booking.{subtitleLocation}
          </div>
        </div>
        {responses.length > 0 ? (
          <div className="bs-page-actions">
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => markSeen(null)}>
              <i className="bi bi-check2-all me-1" />
              Segna tutti come letti
            </button>
          </div>
        ) : null}
      </div>

      {responses.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessuna risposta sui preventivi."}</div>
          <div className="text-muted small mt-1">
            Quando un cliente accetta o rifiuta un preventivo dall&apos;area clienti, lo vedrai qui.
          </div>
        </div>
      ) : (
        <div className="d-flex flex-column gap-3">
          {responses.map((r) => (
            <div className="card notification-card" key={r.id}>
              <div className="d-flex flex-wrap">
                <div
                  className={`notification-main p-3 flex-grow-1 ${
                    r.accepted ? "notification-main--success" : "notification-main--danger"
                  }`}
                >
                  <div className="d-flex align-items-center gap-2">
                    <i className={`bi ${r.accepted ? "bi-check-circle" : "bi-x-circle"}`} aria-hidden="true" />
                    <span className="fw-semibold">
                      {r.accepted ? "Preventivo accettato" : "Preventivo rifiutato"}
                    </span>
                    <span className={`badge ${r.accepted ? "text-bg-success" : "text-bg-danger"}`}>
                      {r.accepted ? "Accettato" : "Rifiutato"}
                    </span>
                  </div>
                  <div className="text-muted small mt-1">{fmtDateTime(r.when)}</div>
                </div>
                <div className="notification-detail p-3">
                  <div className="text-muted small">Cliente</div>
                  <div className="fw-semibold">{r.clientName || "—"}</div>
                  <div className="text-muted small mt-2">Preventivo</div>
                  <div className="fw-semibold">{r.code || "—"}</div>
                  <div className="text-muted small mt-2">Totale</div>
                  <div className="fw-semibold">{fmtEuro(r.total)}</div>
                </div>
                <div className="notification-action p-3 d-flex align-items-center gap-2">
                  <a
                    className="btn btn-sm btn-outline-secondary"
                    href={`/${encodeURIComponent(slug)}/quotes?action=view&id=${r.id}`}
                  >
                    Apri preventivo
                  </a>
                  <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => markSeen(r.id)}>
                    Segna come letto
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div className="d-none">
            <a href={href("")}>notifications_quotes</a>
          </div>
        </div>
      )}
    </div>
  );
}
