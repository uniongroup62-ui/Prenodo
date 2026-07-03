"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP promotions page (app/pages/promotions.php), fed by
// the existing DB-backed /api/manage/promotions. When the tenant has no
// promotions the page renders the original empty state verbatim; otherwise a
// Bootstrap table lists the rules using the API field names.

type Promotion = {
  id: number;
  name: string;
  target: "all" | "new_clients" | "inactive" | "birthday" | "fidelity";
  discountType: "percent" | "fixed";
  discountValue: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  channel: "booking" | "pos" | "marketplace";
  createdAt: string;
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

const TARGET_LABELS: Record<Promotion["target"], string> = {
  all: "Tutti",
  new_clients: "Nuovi clienti",
  inactive: "Clienti inattivi",
  birthday: "Compleanno",
  fidelity: "Fidelity",
};

const CHANNEL_LABELS: Record<Promotion["channel"], string> = {
  booking: "Booking",
  pos: "Cassa",
  marketplace: "Marketplace",
};

function fmtDiscount(p: Promotion): string {
  if (p.discountType === "fixed") return `${p.discountValue.toFixed(2)} €`;
  return `${p.discountValue}%`;
}

export function PromotionsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Preferisci la prop dal server: il fallback window-only rende slug=""
  // in SSR e i link diventano "//promotions?..." (protocol-relative rotti).
  const slug = slugProp || tenantSlug();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => setPromotions(Array.isArray(j.promotions) ? j.promotions : []))
      .catch(() => setPromotions([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`promotions${suffix}`.replace("&", "?")}`;
  }

  async function post(fields: Record<string, string>): Promise<boolean> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(String(j.error || "Operazione non riuscita."));
      if (Array.isArray(j.promotions)) setPromotions(j.promotions as Promotion[]);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(promo: Promotion) {
    if (await post({ action: "toggle", id: String(promo.id), active: promo.active ? "0" : "1" })) {
      setMsg(promo.active ? "Promozione sospesa." : "Promozione attivata.");
    }
  }

  async function remove(promo: Promotion) {
    if (!window.confirm(`Eliminare la promozione "${promo.name}"? Le prenotazioni ancora aperte perderanno la promozione.`)) return;
    if (await post({ action: "delete", id: String(promo.id) })) setMsg("Promozione eliminata.");
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/promotions.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelizzazione</div>
          <h1 className="bs-page-title">Fidelity • Promozioni</h1>
          <div className="bs-page-subtitle">Gestisci promozioni, regole e visibilita per sedi e canali.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2" />
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      {promotions.length === 0 ? (
        <div className="card border-0 shadow-sm promotions-empty-card">
          <div className="promotions-empty-state">
            <div className="promotions-empty-icon" aria-hidden="true">
              <i className="bi bi-megaphone" />
            </div>
            <h2>{loading ? "Caricamento…" : "Nessuna promozione presente"}</h2>
            <p>
              Crea la prima promozione per applicare sconti automatici su servizi e prodotti, gestire target clienti,
              validita e sedi abilitate.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("&action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuova promozione
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
                  <th>Promozione</th>
                  <th>Target</th>
                  <th>Sconto</th>
                  <th>Canale</th>
                  <th className="promo-location-valid-col">Validita</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map((promo) => (
                  <tr key={promo.id} className={promo.active ? undefined : "text-muted"}>
                    <td>
                      <div className="fw-semibold">{promo.name}</div>
                    </td>
                    <td className="text-muted small">{TARGET_LABELS[promo.target] ?? promo.target}</td>
                    <td>{fmtDiscount(promo)}</td>
                    <td className="text-muted small">{CHANNEL_LABELS[promo.channel] ?? promo.channel}</td>
                    <td className="text-muted small promo-location-valid-col">
                      {fmtDate(promo.startsAt)} – {fmtDate(promo.endsAt)}
                    </td>
                    <td>
                      {promo.active ? (
                        <span className="badge bg-success">Attiva</span>
                      ) : (
                        <span className="badge bg-light text-dark">Sospesa</span>
                      )}
                    </td>
                    <td className="text-end">
                      <a className="btn btn-sm btn-outline-primary me-1" href={href(`&action=edit&id=${promo.id}`)}>
                        Modifica
                      </a>
                      <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => toggle(promo)} disabled={busy}>
                        {promo.active ? "Sospendi" : "Attiva"}
                      </button>
                      <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => remove(promo)} disabled={busy}>
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
