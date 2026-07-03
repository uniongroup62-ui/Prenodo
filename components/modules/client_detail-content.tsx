"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP client DETAIL page (app/pages/clients.php action=view).
// Fed by the DB-backed /api/manage/clients route:
//   GET  ?action=detail&id=<id>          -> client anagrafica + fidelity points/credit +
//                                            tags + block status + history/residuals summary
//   GET  ?action=delete_summary&id=<id>  -> the "cosa verra eliminato" counts (confirm modal)
//   POST action=block   (blocked_internal_note) -> disattiva cliente
//   POST action=unblock                         -> riattiva cliente
//   POST action=delete  (delete_reason)         -> elimina definitivamente
//
// SCOPE: the operational CORE — the HEADER card (avatar + contacts), Fidelity (points
// + level badge) + Credito cards, Tag, the anagrafica sections (Informazioni / Indirizzo
// / Info fiscali), a "Disattivato" badge + Blocca/Sblocca, an Elimina confirm showing the
// delete summary + a required reason, and the HISTORY summary (appointments count, last/next
// visit, sales total, and the residual badges for packages/prepaids/giftcards/giftbox/gifts).
// The deep per-table history drilldowns (the legacy Storico page's per-status appointment
// tables, per-package snapshots, individual giftcard/giftbox/quote/sale rows) are out of
// scope and link to the existing dedicated pages — see the TODOs at the foot of this file.

type ManagedClientDetail = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  locationId?: number;
  note?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  vatNumber?: string;
  taxCode?: string;
  sdi?: string;
  pec?: string;
  phoneHome?: string;
  phone2?: string;
  gender?: string;
  birthDate?: string;
  birthPlace?: string;
  registrationDate?: string;
  region?: string;
  province?: string;
  city?: string;
  address?: string;
  cap?: string;
  jobTitle?: string;
};

type DetailPayload = {
  ok: boolean;
  client: ManagedClientDetail;
  fidelity: { points: number; creditBalance: number };
  tags: Array<{ id: number; name: string }>;
  block: { isBlocked: boolean; blockedAt: string | null; blockedInternalNote: string };
  history: { total: number; last_visit: string | null; next_visit: string | null; sales_total: number };
  residuals: {
    services_count: number;
    gifts_count: number;
    giftboxes_count: number;
    giftcards_count: number;
    packages_count: number;
    credit_count: number;
    credit_available: number;
    total: number;
  };
  error?: string;
};

type DeleteSummary = {
  vendite: number;
  appuntamenti: number;
  pacchetti: number;
  prepagati: number;
  giftcard: number;
  giftbox: number;
  documenti: number;
  consensi: number;
  schede_cliente: number;
  movimenti_fidelity: number;
  rettifiche_credito: number;
  ricariche: number;
  credito_cliente: number;
  punti: number;
  saldo_giftcard: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clientIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const id = new URLSearchParams(window.location.search).get("id");
  const n = Number(id ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function fmtMoney(value: number): string {
  return Number(value || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPoints(value: number): string {
  // fmt_points: integer points (no decimals unless fractional).
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = String(value).slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  return fmtDate(value);
}

function genderLabel(g?: string): string {
  if (g === "M") return "Maschio";
  if (g === "F") return "Femmina";
  return "";
}

type FieldRow = { label: string; value: string; wide?: boolean };

// Mirror clientViewAddField: only push non-empty values.
function pushField(out: FieldRow[], label: string, value: string | undefined, wide = false) {
  const v = String(value ?? "").trim();
  if (v === "") return;
  out.push({ label, value: v, wide });
}

function FieldGrid({ fields }: { fields: FieldRow[] }) {
  if (fields.length === 0) return <div className="text-muted small">Nessun dato.</div>;
  return (
    <div className="row g-3">
      {fields.map((f) => (
        <div className={f.wide ? "col-12" : "col-md-6"} key={f.label}>
          <div className="text-muted small">{f.label}</div>
          <div className="fw-semibold">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

export function ClientDetailContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  // clientId is read from the URL POST-MOUNT (see the effect below), not during
  // render, so the server and the first client paint render the same loading
  // shell — otherwise the server (no window) and client (real id) diverge and
  // React throws a hydration mismatch.
  const [clientId, setClientId] = useState<number>(0);
  const [data, setData] = useState<DetailPayload | null>(null);
  const [locations, setLocations] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  // Tag add input.
  const [tagInput, setTagInput] = useState("");

  // Blocca modal.
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockNote, setBlockNote] = useState("");

  // Elimina modal + delete summary.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteSummary, setDeleteSummary] = useState<DeleteSummary | null>(null);
  const [deleteSummaryLoading, setDeleteSummaryLoading] = useState(false);
  // Stock-restore decision (only relevant when the client has sales). Default
  // 'no_restore' to match the cascade default (clients.php stockMode default).
  const [stockRestoreMode, setStockRestoreMode] = useState<"restore_stock" | "no_restore">("no_restore");

  // Read the id from the URL after mount (window is only available client-side).
  useEffect(() => {
    const id = clientIdFromUrl();
    if (id > 0) {
      setClientId(id);
    } else {
      setError("Cliente non valido.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=detail&id=${clientId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: DetailPayload) => {
        if (!active) return;
        if (j && j.ok && j.client) {
          setData(j);
          setError("");
        } else {
          setError(j?.error || "Cliente non trovato.");
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento del cliente.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId, slug, reloadKey]);

  useEffect(() => {
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const map: Record<number, string> = {};
        for (const loc of j.locations ?? []) map[Number(loc.id)] = String(loc.name ?? "");
        setLocations(map);
      })
      .catch(() => {});
  }, [slug]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  async function doBlock() {
    if (blockNote.trim() === "") {
      setError("Inserisci una nota interna con il motivo della disattivazione.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "block", id: String(clientId), blocked_internal_note: blockNote.trim() }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nella disattivazione."));
      } else {
        setBlockOpen(false);
        setBlockNote("");
        setFlash("Cliente disattivato. Nessun dato associato è stato eliminato e potrai riattivarlo in qualsiasi momento.");
        reload();
      }
    } catch {
      setError("Errore nella disattivazione.");
    } finally {
      setBusy(false);
    }
  }

  async function doUnblock() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "unblock", id: String(clientId) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nella riattivazione."));
      } else {
        setFlash("Cliente riattivato. Tutti i dati associati sono rimasti disponibili.");
        reload();
      }
    } catch {
      setError("Errore nella riattivazione.");
    } finally {
      setBusy(false);
    }
  }

  // Add a tag (port of clients.php _mode=add_tag). Updates the tag list in place
  // from the response so the badges refresh without a full detail reload.
  async function addTag() {
    const name = tagInput.trim();
    if (busy || name === "") return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "add_tag", id: String(clientId), tag: name }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nell'aggiunta del tag."));
      } else {
        setData((prev) => (prev ? { ...prev, tags: Array.isArray(j.tags) ? j.tags : prev.tags } : prev));
        setTagInput("");
      }
    } catch {
      setError("Errore nell'aggiunta del tag.");
    } finally {
      setBusy(false);
    }
  }

  // Remove a tag (port of clients.php do=remove_tag).
  async function removeTag(tagId: number) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "remove_tag", id: String(clientId), tag_id: String(tagId) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nella rimozione del tag."));
      } else {
        setData((prev) => (prev ? { ...prev, tags: Array.isArray(j.tags) ? j.tags : prev.tags } : prev));
      }
    } catch {
      setError("Errore nella rimozione del tag.");
    } finally {
      setBusy(false);
    }
  }

  function openDelete() {
    setDeleteOpen(true);
    setDeleteSummary(null);
    setDeleteSummaryLoading(true);
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=delete_summary&id=${clientId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.summary) setDeleteSummary(j.summary as DeleteSummary);
      })
      .catch(() => {})
      .finally(() => setDeleteSummaryLoading(false));
  }

  async function doDelete() {
    if (deleteReason.trim() === "") {
      setError("Inserisci il motivo dell'eliminazione.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: String(clientId), delete_reason: deleteReason.trim(), stock_restore_mode: stockRestoreMode }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok || !j.deleted) {
        setError(String(j.error ?? j.reason ?? "Errore nell'eliminazione."));
        setBusy(false);
        return;
      }
      window.location.href = page("clients");
    } catch {
      setError("Errore nell'eliminazione.");
      setBusy(false);
    }
  }

  const Header = (
    <div className="bs-page-header">
      <div className="bs-page-heading">
        <div className="bs-page-kicker">Scheda cliente</div>
        <h1 className="bs-page-title d-flex align-items-center gap-2 flex-wrap">
          <span>{data?.client.name ?? "Cliente"}</span>
          {data?.block.isBlocked ? (
            <span className="badge text-bg-warning">
              <i className="bi bi-slash-circle me-1" />
              Disattivato
            </span>
          ) : data ? (
            <span className="badge text-bg-success">
              <i className="bi bi-check2-circle me-1" />
              Attivo
            </span>
          ) : null}
        </h1>
        <div className="bs-page-subtitle">
          {(data?.client.phone || "-") + " - " + (data?.client.email || "-")}
        </div>
      </div>
      <div className="bs-page-actions">
        <a className="btn btn-outline-secondary" href={page("clients")}>
          <i className="bi bi-arrow-left me-1" />
          Lista
        </a>
        <a className="btn btn-outline-primary" href={page(`clients&action=edit&id=${clientId}`)}>
          <i className="bi bi-pencil-square me-1" />
          Modifica
        </a>
        <a className="btn btn-outline-primary" href={page(`client_consents&client_id=${clientId}`)}>
          <i className="bi bi-shield-check me-1" />
          Consensi / GDPR
        </a>
        <a className="btn btn-outline-primary" href={page(`client_sheets&client_id=${clientId}`)}>
          <i className="bi bi-journals me-1" />
          Schede tecniche
        </a>
      </div>
    </div>
  );

  if (!clientId) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        <div className="alert alert-danger">Cliente non valido.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        {Header}
        <div className="card p-3 text-muted small">Caricamento…</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        {Header}
        <div className="alert alert-danger">{error}</div>
      </div>
    );
  }

  const c = data!.client;
  const displayName = c.name || "Cliente";

  const mainFields: FieldRow[] = [];
  pushField(mainFields, "Nome", c.firstName);
  pushField(mainFields, "Cognome", c.lastName);
  pushField(mainFields, "Cellulare", c.phone);
  pushField(mainFields, "Email", c.email);
  pushField(mainFields, "Sesso", genderLabel(c.gender));
  pushField(mainFields, "Data di nascita", fmtDate(c.birthDate) === "—" ? "" : fmtDate(c.birthDate));
  pushField(mainFields, "Luogo di nascita", c.birthPlace);
  pushField(mainFields, "Data iscrizione", fmtDate(c.registrationDate) === "—" ? "" : fmtDate(c.registrationDate));
  if (c.locationId) pushField(mainFields, "Sede di riferimento", locations[c.locationId] ?? "");
  pushField(mainFields, "Note", c.note, true);

  const contactFields: FieldRow[] = [];
  pushField(contactFields, "Regione", c.region);
  pushField(contactFields, "Provincia", c.province);
  pushField(contactFields, "Città", c.city);
  pushField(contactFields, "CAP", c.cap);
  pushField(contactFields, "Indirizzo", c.address, true);
  pushField(contactFields, "Titolo / Lavoro", c.jobTitle);
  pushField(contactFields, "Telefono fisso", c.phoneHome);
  pushField(contactFields, "Cellulare 2", c.phone2);

  const fiscalFields: FieldRow[] = [];
  pushField(fiscalFields, "Codice Fiscale", c.taxCode);
  pushField(fiscalFields, "Partita IVA", c.vatNumber);
  pushField(fiscalFields, "SDI", c.sdi);
  pushField(fiscalFields, "Azienda", c.companyName);
  pushField(fiscalFields, "PEC", c.pec);

  const h = data!.history;
  const r = data!.residuals;
  const blk = data!.block;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      {Header}

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {blk.isBlocked ? (
        <div className="alert alert-warning d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <i className="bi bi-slash-circle me-1" />
            <strong>Cliente disattivato</strong>
            {blk.blockedAt ? <span className="ms-2 small">dal {fmtDateTime(blk.blockedAt)}</span> : null}
            {blk.blockedInternalNote ? <div className="small text-muted mt-1">Nota interna: {blk.blockedInternalNote}</div> : null}
          </div>
          <button className="btn btn-sm btn-success" type="button" disabled={busy} onClick={doUnblock}>
            <i className="bi bi-check2-circle me-1" />
            Riattiva
          </button>
        </div>
      ) : null}

      <div className="row g-3">
        {/* LEFT column: avatar + fidelity + credito + tag + actions */}
        <div className="col-lg-4">
          <div className="card">
            <div className="p-4 text-center">
              <div className="mx-auto mb-2 clients-profile-avatar">
                <i className="bi bi-person-fill clients-profile-avatar-icon" />
              </div>
              <div className="fw-bold">{displayName}</div>
              <div className="text-muted small">{c.email || "—"}</div>
            </div>
          </div>

          {/* Fidelity — points + a simple "registrati" label (the legacy per-level
              progress is out of scope; points come from the clients row). */}
          <div className="card p-3 mt-3">
            <div className="d-flex justify-content-between align-items-start gap-2">
              <div className="fw-semibold mb-2">
                <i className="bi bi-award me-1" />
                Fidelity
              </div>
            </div>
            <div className="display-6 fw-bold">{fmtPoints(data!.fidelity.points)}</div>
            <div className="text-muted small">Punti registrati</div>
          </div>

          {/* Credito — clients.credit_balance */}
          <div className="card p-3 mt-3">
            <div className="d-flex justify-content-between align-items-start gap-2">
              <div className="fw-semibold mb-2">
                <i className="bi bi-wallet2 me-1" />
                Credito
              </div>
              <div className="text-muted small fw-semibold">Saldo disponibile</div>
            </div>
            <div className="display-6 fw-bold">€ {fmtMoney(data!.fidelity.creditBalance)}</div>
            <div className="text-muted small">Credito disponibile del cliente</div>
            <div className="mt-2">
              <a className="btn btn-sm btn-outline-secondary w-100" href={page(`credit_movements&client_id=${clientId}`)}>
                <i className="bi bi-arrow-right-circle me-1" />
                Gestisci movimenti
              </a>
            </div>
          </div>

          {/* Tag */}
          <div className="card p-3 mt-3">
            <div className="fw-semibold mb-2">
              <i className="bi bi-tags me-1" />
              Tag
            </div>
            <div className="d-flex flex-wrap gap-2 mb-2">
              {data!.tags.length === 0 ? (
                <span className="text-muted small">Nessun tag.</span>
              ) : (
                data!.tags.map((t) => (
                  <span className="badge badge-soft d-inline-flex align-items-center gap-1" key={t.id}>
                    {t.name}
                    <button
                      type="button"
                      className="btn-close btn-close-sm"
                      style={{ fontSize: "0.6rem" }}
                      aria-label={`Rimuovi ${t.name}`}
                      title="Rimuovi tag"
                      disabled={busy}
                      onClick={() => removeTag(t.id)}
                    />
                  </span>
                ))
              )}
            </div>
            <form
              className="input-group input-group-sm"
              onSubmit={(e) => {
                e.preventDefault();
                addTag();
              }}
            >
              <input
                className="form-control"
                placeholder="Nuovo tag…"
                value={tagInput}
                maxLength={60}
                onChange={(e) => setTagInput(e.target.value)}
              />
              <button className="btn btn-outline-primary" type="submit" disabled={busy || tagInput.trim() === ""}>
                <i className="bi bi-plus-lg" />
              </button>
            </form>
          </div>

          {/* Documenti (port del blocco customer_documents di clients.php ~2118-2179):
              upload titolo+file su R2 privato, download presigned, delete con i
              guard legacy (GDPR ufficiale / consenso ufficiale non eliminabili). */}
          <ClientDocumentsCard slug={slug} clientId={clientId} />

          {/* Azioni cliente */}
          <div className="card p-3 mt-3">
            <div className="fw-semibold mb-2">Azioni</div>
            <div className="d-grid gap-2">
              <a className="btn btn-outline-primary" href={page(`clients&action=edit&id=${clientId}`)}>
                <i className="bi bi-pencil-square me-1" />
                Modifica
              </a>
              {blk.isBlocked ? (
                <button className="btn btn-outline-success" type="button" disabled={busy} onClick={doUnblock}>
                  <i className="bi bi-check2-circle me-1" />
                  Sblocca cliente
                </button>
              ) : (
                <button className="btn btn-outline-warning" type="button" onClick={() => setBlockOpen(true)}>
                  <i className="bi bi-slash-circle me-1" />
                  Blocca cliente
                </button>
              )}
              <button className="btn btn-danger" type="button" onClick={openDelete}>
                <i className="bi bi-trash me-1" />
                Elimina
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT column: anagrafica + storico */}
        <div className="col-lg-8">
          <div className="card">
            <div className="card-header">Informazioni principali</div>
            <div className="card-body">
              <FieldGrid fields={mainFields} />
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Indirizzo / Contatti</div>
            <div className="card-body">
              <FieldGrid fields={contactFields} />
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Info fiscali</div>
            <div className="card-body">
              <FieldGrid fields={fiscalFields} />
            </div>
          </div>

          {/* STORICO — summary cards (counts) with links to the dedicated pages. */}
          <div className="card mt-3">
            <div className="card-header d-flex align-items-center justify-content-between">
              <div className="fw-semibold">
                <i className="bi bi-clock-history me-2" />
                Storico
              </div>
              <a className="btn btn-sm btn-outline-primary" href={page(`clients&action=history&id=${clientId}`)}>
                <i className="bi bi-box-arrow-up-right me-1" />
                Vedi tutto
              </a>
            </div>
            <div className="card-body">
              <div className="row g-3">
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">
                      <i className="bi bi-calendar-check me-1" />
                      Appuntamenti
                    </div>
                    <div className="h4 mb-0 fw-bold">{h.total}</div>
                    <div className="text-muted small mt-1">Ultima visita: {fmtDateTime(h.last_visit)}</div>
                    <div className="text-muted small">Prossima: {fmtDateTime(h.next_visit)}</div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">
                      <i className="bi bi-receipt me-1" />
                      Vendite
                    </div>
                    <div className="h4 mb-0 fw-bold">€ {fmtMoney(h.sales_total)}</div>
                    <div className="mt-2">
                      <a className="btn btn-sm btn-outline-secondary" href={page(`pos_history&client_id=${clientId}`)}>
                        Storico vendite
                      </a>
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="border rounded p-3 h-100">
                    <div className="text-muted small">
                      <i className="bi bi-wallet2 me-1" />
                      Residui attivi
                    </div>
                    <div className="h4 mb-0 fw-bold">{r.total}</div>
                    <div className="text-muted small mt-1">Credito: € {fmtMoney(r.credit_available)}</div>
                  </div>
                </div>
              </div>

              {/* Residual breakdown badges (active packages/prepaids/giftcards/giftbox/gifts). */}
              <div className="d-flex flex-wrap gap-2 mt-3">
                <span className="badge text-bg-light border">
                  <i className="bi bi-box-seam me-1" />
                  Pacchetti: {r.packages_count}
                </span>
                <span className="badge text-bg-light border">
                  <i className="bi bi-bag-check me-1" />
                  Prepagati: {r.services_count}
                </span>
                <span className="badge text-bg-light border">
                  <i className="bi bi-credit-card-2-front me-1" />
                  GiftCard: {r.giftcards_count}
                </span>
                <span className="badge text-bg-light border">
                  <i className="bi bi-gift me-1" />
                  GiftBox: {r.giftboxes_count}
                </span>
                <span className="badge text-bg-light border">
                  <i className="bi bi-stars me-1" />
                  Omaggi: {r.gifts_count}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* BLOCCA modal */}
      {blockOpen ? (
        <div className="clients-modal-overlay" role="dialog" aria-modal="true" aria-label="Disattiva cliente">
          <style>{`
            .clients-modal-overlay { position: fixed; inset: 0; z-index: 1080; display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 1.5rem; background: rgba(15,23,42,.55); }
            .clients-modal-dialog { width: 100%; max-width: 560px; margin: auto; }
          `}</style>
          <div className="clients-modal-dialog card p-3">
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="h6 fw-semibold mb-0">Disattiva cliente</div>
              <button className="btn-close" type="button" aria-label="Chiudi" onClick={() => setBlockOpen(false)} />
            </div>
            <p className="text-muted small">
              Il cliente verrà disattivato e nascosto dalla lista. Nessun dato associato verrà eliminato e potrai
              riattivarlo in qualsiasi momento.
            </p>
            <label className="form-label">
              Nota interna (motivo) <span className="text-danger">*</span>
            </label>
            <textarea
              className="form-control"
              rows={3}
              value={blockNote}
              onChange={(e) => setBlockNote(e.target.value)}
              placeholder="Es. cliente moroso, richiesta cancellazione, ecc."
            />
            <div className="d-flex justify-content-end gap-2 mt-3">
              <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={() => setBlockOpen(false)}>
                Annulla
              </button>
              <button className="btn btn-warning" type="button" disabled={busy} onClick={doBlock}>
                <i className="bi bi-slash-circle me-1" />
                {busy ? "Disattivazione…" : "Disattiva"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ELIMINA modal */}
      {deleteOpen ? (
        <div className="clients-modal-overlay" role="dialog" aria-modal="true" aria-label="Elimina cliente">
          <style>{`
            .clients-modal-overlay { position: fixed; inset: 0; z-index: 1080; display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 1.5rem; background: rgba(15,23,42,.55); }
            .clients-modal-dialog { width: 100%; max-width: 560px; margin: auto; }
          `}</style>
          <div className="clients-modal-dialog card p-3">
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="h6 fw-semibold mb-0">Elimina cliente</div>
              <button className="btn-close" type="button" aria-label="Chiudi" onClick={() => setDeleteOpen(false)} />
            </div>
            <div>
              <div className="alert alert-danger small">
                Operazione irreversibile. Verranno eliminati i dati associati elencati di seguito.
              </div>
              <div className="fw-semibold mb-2">Cosa verrà eliminato</div>
              {deleteSummaryLoading ? (
                <div className="text-muted small">Calcolo riepilogo…</div>
              ) : deleteSummary ? (
                <div className="table-responsive">
                  <table className="table table-sm mb-3">
                    <tbody>
                      {(
                        [
                          ["Vendite", deleteSummary.vendite],
                          ["Appuntamenti", deleteSummary.appuntamenti],
                          ["Pacchetti", deleteSummary.pacchetti],
                          ["Prepagati", deleteSummary.prepagati],
                          ["GiftCard", deleteSummary.giftcard],
                          ["GiftBox", deleteSummary.giftbox],
                          ["Documenti", deleteSummary.documenti],
                          ["Consensi", deleteSummary.consensi],
                          ["Schede cliente", deleteSummary.schede_cliente],
                          ["Movimenti fidelity", deleteSummary.movimenti_fidelity],
                          ["Rettifiche credito", deleteSummary.rettifiche_credito],
                          ["Ricariche", deleteSummary.ricariche],
                          ["Credito cliente", `€ ${fmtMoney(deleteSummary.credito_cliente)}`],
                          ["Punti", fmtPoints(deleteSummary.punti)],
                          ["Saldo GiftCard", `€ ${fmtMoney(deleteSummary.saldo_giftcard)}`],
                        ] as Array<[string, number | string]>
                      ).map(([label, val]) => (
                        <tr key={label}>
                          <td className="text-muted">{label}</td>
                          <td className="text-end fw-semibold">{val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-muted small mb-3">Riepilogo non disponibile.</div>
              )}
              {deleteSummary && deleteSummary.vendite > 0 ? (
                <div className="mb-3">
                  <label className="form-label">Magazzino prodotti venduti</label>
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="stock_restore_mode"
                      id="stock_no_restore"
                      checked={stockRestoreMode === "no_restore"}
                      onChange={() => setStockRestoreMode("no_restore")}
                    />
                    <label className="form-check-label" htmlFor="stock_no_restore">
                      Non ripristinare lo stock (lascia le giacenze invariate)
                    </label>
                  </div>
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="stock_restore_mode"
                      id="stock_restore"
                      checked={stockRestoreMode === "restore_stock"}
                      onChange={() => setStockRestoreMode("restore_stock")}
                    />
                    <label className="form-check-label" htmlFor="stock_restore">
                      Ripristina lo stock dei prodotti scalati dalle vendite eliminate
                    </label>
                  </div>
                </div>
              ) : null}
              <label className="form-label">
                Motivo eliminazione <span className="text-danger">*</span>
              </label>
              <input
                className="form-control"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Es. richiesta cancellazione dati (GDPR)"
              />
              <div className="form-text text-danger">
                Elimina definitivamente il cliente e tutti i dati collegati (vendite, prenotazioni, pacchetti,
                prepagati, giftcard/giftbox, omaggi, preventivi, tessere, fidelity, documenti, consensi e schede).
                Operazione irreversibile.
              </div>
            </div>
            <div className="d-flex justify-content-end gap-2 mt-3">
              <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={() => setDeleteOpen(false)}>
                Annulla
              </button>
              <button className="btn btn-danger" type="button" disabled={busy} onClick={doDelete}>
                <i className="bi bi-trash me-1" />
                {busy ? "Eliminazione…" : "Elimina definitivamente"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Documenti cliente (customer_documents su R2 privato): elenco + upload
// (titolo + file, 10MB PDF/PNG/JPG/WEBP come il legacy) + download presigned +
// delete con i guard ufficiali, tutto via /api/manage/client-document.
function ClientDocumentsCard({ slug, clientId }: { slug: string; clientId: number }) {
  type ClientDoc = { id: number; title: string; mime: string; createdAt: string; downloadable: boolean };
  const [docs, setDocs] = useState<ClientDoc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [docError, setDocError] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0); // resetta l'input file dopo l'upload

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    fetch(`/api/manage/client-document?slug=${encodeURIComponent(slug)}&client_id=${clientId}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        setDocs(Array.isArray(j.docs) ? j.docs : []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [slug, clientId]);

  async function post(fd: FormData): Promise<void> {
    setDocBusy(true);
    setDocError("");
    try {
      fd.set("client_id", String(clientId));
      const res = await fetch(`/api/manage/client-document?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: fd,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setDocError(String(j.error ?? "Errore documento."));
        return;
      }
      if (Array.isArray(j.docs)) setDocs(j.docs);
      setDocTitle("");
      setDocFile(null);
      setFileKey((k) => k + 1);
    } catch {
      setDocError("Errore di rete.");
    } finally {
      setDocBusy(false);
    }
  }

  const fmtDocDate = (v: string) => {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
  };

  return (
    <div className="card p-3 mt-3">
      <div className="fw-semibold mb-2">
        <i className="bi bi-file-earmark-text me-1" />
        Documenti
      </div>
      {docError ? <div className="alert alert-danger py-2 small">{docError}</div> : null}
      <div className="d-grid gap-1 mb-2">
        {!loaded ? <span className="text-muted small">Caricamento…</span> : null}
        {loaded && docs.length === 0 ? <span className="text-muted small">Nessun documento.</span> : null}
        {docs.map((doc) => (
          <div className="d-flex align-items-center justify-content-between gap-2 small" key={doc.id}>
            <div className="text-truncate">
              {doc.downloadable ? (
                <a href={`/api/manage/client-document?slug=${encodeURIComponent(slug)}&id=${doc.id}`} target="_blank" rel="noopener">
                  <i className="bi bi-paperclip me-1" />
                  {doc.title}
                </a>
              ) : (
                <span className="text-muted" title="Documento legacy non migrato">
                  <i className="bi bi-paperclip me-1" />
                  {doc.title}
                </span>
              )}
              {doc.createdAt ? <span className="text-muted ms-1">({fmtDocDate(doc.createdAt)})</span> : null}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-link text-danger p-0"
              title="Elimina documento"
              disabled={docBusy}
              onClick={() => {
                if (typeof window !== "undefined" && !window.confirm(`Eliminare il documento "${doc.title}"?`)) return;
                const fd = new FormData();
                fd.set("delete_doc_id", String(doc.id));
                void post(fd);
              }}
            >
              <i className="bi bi-trash" />
            </button>
          </div>
        ))}
      </div>
      <form
        className="d-grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!docFile) {
            setDocError("Seleziona un file.");
            return;
          }
          const fd = new FormData();
          fd.set("title", docTitle);
          fd.set("doc", docFile);
          void post(fd);
        }}
      >
        <input
          className="form-control form-control-sm"
          placeholder="Titolo documento"
          maxLength={190}
          value={docTitle}
          onChange={(e) => setDocTitle(e.target.value)}
        />
        <input
          key={fileKey}
          className="form-control form-control-sm"
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            if (file && file.size > 10 * 1024 * 1024) {
              setDocError("File troppo grande");
              e.target.value = "";
              setDocFile(null);
              return;
            }
            setDocError("");
            setDocFile(file);
          }}
        />
        <div className="form-text mt-0">PDF, PNG, JPG o WEBP — massimo 10 MB.</div>
        <button className="btn btn-sm btn-outline-primary" type="submit" disabled={docBusy || !docFile}>
          <i className="bi bi-upload me-1" />
          {docBusy ? "Caricamento…" : "Carica documento"}
        </button>
      </form>
    </div>
  );
}

// TODOs (precise, faithful-parity follow-ups):
//  - Deep per-table HISTORY drilldown: the legacy Storico page (clients.php action=history,
//    ~lines 3100-3400) renders per-status appointment tables (fissati/eseguiti/cancellati
//    with per-service discount maths), active package snapshots (ClientPackageSnapshot
//    preview), individual recipient GiftBox / GiftCard rows, Preventivi, and the last-10
//    sales with purchased-item GROUP_CONCAT. This component shows only the counts/summary
//    and links out. Port a dedicated history reader + page for full parity.
//  - DOCUMENTS: DONE — ClientDocumentsCard above (upload/list/download/delete su R2
//    privato via /api/manage/client-document, guard GDPR/consensi ufficiali).
//  - Fidelity LEVELS / progress: the legacy header shows the points-level badge + progress
//    toward the next level + expiring-soon points (Fidelity::calcClientLevelPoints etc.).
//    Only the raw points balance is shown here.
//  - Tag ADD/REMOVE: the legacy view lets you add/remove tags inline (customer_tag_map).
//    This view is read-only for tags (TODO: add the add/remove controls + POST actions).
//  - Full DELETE cascade: POST action=delete removes only the clients row. Port the legacy
//    ~40-table cascade (see deleteDbClient + getManageClientDeleteSummary notes).
