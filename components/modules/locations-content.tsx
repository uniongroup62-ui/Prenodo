"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP "Sedi" page (app/pages/locations.php — che è anche
// index.php?page=settings: la vecchia "Impostazioni" è uno shim di 3 righe che
// fa require locations.php). Header "Impostazioni / Sedi" con i bottoni Orari e
// Booking; tabella Sede | Contatti | Booking | Marketplace | Categorie attive |
// Ordine | Azioni; modale sede (nome/indirizzo/sede legale/contatti/social/
// booking), modale Marketplace sede (switch + categorie attività + gallery in
// sola lettura), modale eliminazione con anteprima cascata e conferma ELIMINA.
// Backend: /api/manage/business-settings (location_save / location_move /
// location_marketplace_save / location_delete_preview / location_delete) —
// stesse validazioni e messaggi di sede_location_validation_error.

type GalleryImage = { id?: number; url?: string; image_url?: string; path?: string };

type LocationRow = {
  id: number;
  name: string;
  address: string;
  isActive: boolean;
  phone: string;
  email: string;
  whatsapp: string;
  facebookUrl: string;
  instagramUrl: string;
  tiktokUrl: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
  sortOrder: number;
  legal: Record<string, string>;
  galleryImages: GalleryImage[];
  activityCategories: Array<{ id?: number; category_id?: number; name?: string; is_primary?: number }>;
  bookingUrl: string;
};

type ActivityCategory = { id: number; name: string };

type DeletePreview = {
  ok: boolean;
  error?: string;
  location?: { id?: number; name?: string };
  activeCount?: number;
  canDelete?: boolean;
  deleteBlockReason?: string;
  blockingCounts?: Record<string, number>;
  directCounts?: Record<string, number>;
  confirmText?: string;
};

type Ctx = {
  locations: LocationRow[];
  activityCategories: ActivityCategory[];
  featureFlags: { bookingPublicAllowed: boolean; marketplacePublicAllowed: boolean; unavailableMessage: string };
};

// Etichette leggibili per le tabelle dell'anteprima eliminazione (le sezioni
// legacy "Configurazioni della sede eliminate" / "Storico che blocca").
const TABLE_LABELS: Record<string, string> = {
  appointments: "Appuntamenti",
  sales: "Vendite",
  business_hours: "Orari di apertura",
  closures: "Chiusure",
  business_hours_exceptions: "Aperture straordinarie",
  staff_locations: "Assegnazioni operatori",
  product_stocks: "Giacenze prodotti",
  gift_locations: "Sedi campagne omaggio",
  coupon_locations: "Sedi coupon",
  promotion_locations: "Sedi promozioni",
  package_locations: "Sedi pacchetti",
  location_gallery_images: "Foto gallery sede",
  credit_adjustments: "Movimenti credito",
  recharges: "Ricariche",
  quotes: "Preventivi",
  costs: "Costi",
  stock_docs: "Documenti magazzino",
  clients: "Clienti",
};
const tableLabel = (t: string) => TABLE_LABELS[t] ?? t;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

type LocationForm = {
  id: number;
  name: string;
  address: string;
  legal_region: string;
  legal_province: string;
  legal_city: string;
  legal_cap: string;
  phone: string;
  email: string;
  whatsapp: string;
  facebook_url: string;
  instagram_url: string;
  tiktok_url: string;
  booking_enabled: boolean;
};

function emptyLocationForm(): LocationForm {
  return { id: 0, name: "", address: "", legal_region: "", legal_province: "", legal_city: "", legal_cap: "", phone: "", email: "", whatsapp: "", facebook_url: "", instagram_url: "", tiktok_url: "", booking_enabled: true };
}

export function LocationsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Modale sede.
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<LocationForm>(emptyLocationForm());
  // Modale marketplace.
  const [mktLocation, setMktLocation] = useState<LocationRow | null>(null);
  const [mktEnabled, setMktEnabled] = useState(false);
  const [mktCategoryIds, setMktCategoryIds] = useState<number[]>([]);
  const [mktPrimaryId, setMktPrimaryId] = useState(0);
  // Modale eliminazione.
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    return fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setCtx({
          locations: Array.isArray(j.locations) ? j.locations : [],
          activityCategories: Array.isArray(j.marketplace?.activityCategories) ? j.marketplace.activityCategories : [],
          featureFlags: j.featureFlags ?? { bookingPublicAllowed: true, marketplacePublicAllowed: true, unavailableMessage: "Funzione non disponibile nel piano attuale." },
        });
      })
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  async function post(fields: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(fields),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Operazione non riuscita."));
      return j as Record<string, unknown>;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operazione non riuscita.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openNew() {
    setForm(emptyLocationForm());
    setEditOpen(true);
  }
  function openEdit(l: LocationRow) {
    setForm({
      id: l.id,
      name: l.name,
      address: l.address,
      legal_region: l.legal?.legal_region ?? "",
      legal_province: l.legal?.legal_province ?? "",
      legal_city: l.legal?.legal_city ?? "",
      legal_cap: l.legal?.legal_cap ?? "",
      phone: l.phone,
      email: l.email,
      whatsapp: l.whatsapp,
      facebook_url: l.facebookUrl,
      instagram_url: l.instagramUrl,
      tiktok_url: l.tiktokUrl,
      booking_enabled: l.bookingEnabled,
    });
    setEditOpen(true);
  }

  async function saveLocation(e: React.FormEvent) {
    e.preventDefault();
    const j = await post({ action: "location_save", ...form, id: String(form.id), booking_enabled: form.booking_enabled ? "1" : "0" });
    if (j) {
      setMsg("Sede salvata");
      setEditOpen(false);
      await load();
    }
  }

  async function move(l: LocationRow, direction: "up" | "down") {
    const j = await post({ action: "location_move", id: String(l.id), direction });
    if (j) {
      setMsg("Ordine sedi aggiornato");
      await load();
    }
  }

  function openMarketplace(l: LocationRow) {
    setMktLocation(l);
    setMktEnabled(l.marketplaceEnabled);
    const ids = (l.activityCategories ?? []).map((c) => Number(c.category_id ?? c.id ?? 0)).filter((n) => n > 0);
    setMktCategoryIds(ids);
    const primary = (l.activityCategories ?? []).find((c) => Number(c.is_primary ?? 0) === 1);
    setMktPrimaryId(Number(primary?.category_id ?? primary?.id ?? ids[0] ?? 0));
  }

  async function saveMarketplace(e: React.FormEvent) {
    e.preventDefault();
    if (!mktLocation) return;
    const j = await post({
      action: "location_marketplace_save",
      location_id: String(mktLocation.id),
      marketplace_enabled: mktEnabled ? "1" : "0",
      activity_category_ids: mktCategoryIds.join(","),
      primary_activity_category_id: String(mktPrimaryId || mktCategoryIds[0] || 0),
    });
    if (j) {
      setMsg("Marketplace sede aggiornato");
      setMktLocation(null);
      await load();
    }
  }

  // Refresh della sede aperta nella modale marketplace dopo un'azione gallery.
  function refreshMktLocation(j: Record<string, unknown>) {
    const list = Array.isArray(j.locations) ? (j.locations as LocationRow[]) : [];
    setCtx((prev) => (prev ? { ...prev, locations: list.length ? list : prev.locations } : prev));
    setMktLocation((prev) => (prev ? list.find((l) => l.id === prev.id) ?? prev : prev));
  }

  async function galleryAction(action: "location_gallery_delete" | "location_gallery_move", imageId: number, direction?: "up" | "down") {
    if (!mktLocation || imageId <= 0) return;
    const j = await post({ action, location_id: String(mktLocation.id), gallery_image_id: String(imageId), ...(direction ? { direction } : {}) });
    if (j) {
      setMsg(action === "location_gallery_delete" ? "Foto gallery sede rimossa" : "Ordine gallery sede aggiornato");
      refreshMktLocation(j);
    }
  }

  async function uploadGallery(files: FileList | null) {
    if (!mktLocation || !files || files.length === 0) return;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const fd = new FormData();
      fd.set("action", "location_gallery_upload");
      fd.set("location_id", String(mktLocation.id));
      for (const f of Array.from(files)) fd.append("location_gallery_images", f);
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, { method: "POST", headers: { "x-tenant-slug": slug }, body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Errore upload gallery sede."));
      setMsg("Foto gallery sede caricate");
      refreshMktLocation(j as Record<string, unknown>);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Errore upload gallery sede.");
    } finally {
      setBusy(false);
    }
  }

  async function openDeletePreview(l: LocationRow) {
    setDeleteReason("");
    setDeleteConfirm("");
    const j = await post({ action: "location_delete_preview", id: String(l.id) });
    if (j) setDeletePreview((j.deletePreview ?? j) as DeletePreview);
  }

  async function confirmDelete(e: React.FormEvent) {
    e.preventDefault();
    const id = Number(deletePreview?.location?.id ?? 0);
    if (id <= 0) return;
    const j = await post({ action: "location_delete", id: String(id), confirm_text: deleteConfirm, reason: deleteReason });
    if (j) {
      setMsg("Sede eliminata definitivamente");
      setDeletePreview(null);
      await load();
    }
  }

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${page}`;
  }

  const locations = ctx?.locations ?? [];
  const flags = ctx?.featureFlags;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/locations.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Sedi</h1>
          <div className="bs-page-subtitle">Crea e gestisci le tue sedi e la visibilita.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary" href={href("hours")}>
              <i className="bi bi-clock me-1" />
              Orari
            </a>
            <a className="btn btn-outline-secondary" href={href("booking")}>
              <i className="bi bi-globe me-1" />
              Booking
            </a>
          </div>
        </div>
      </div>

      {msg ? <div className="alert alert-success">{msg}</div> : null}
      {err ? <div className="alert alert-danger">{err}</div> : null}

      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center">
          <span className="fw-semibold">Elenco sedi</span>
          <button className="btn btn-primary btn-sm" type="button" onClick={openNew}>
            <i className="bi bi-plus-lg me-1" />
            Nuova
          </button>
        </div>
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead>
              <tr>
                <th>Sede</th>
                <th>Contatti</th>
                <th>Booking</th>
                <th>Marketplace</th>
                <th>Categorie attive</th>
                <th>Ordine</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-muted p-3">Caricamento…</td></tr>
              ) : locations.length === 0 ? (
                <tr><td colSpan={7} className="text-muted p-3">Nessuna sede.</td></tr>
              ) : (
                locations.map((l, idx) => (
                  <tr key={l.id}>
                    <td>
                      <div className="fw-semibold">{l.name}</div>
                      {l.address ? <div className="text-muted small">{l.address}</div> : null}
                    </td>
                    <td className="small">
                      {l.phone ? <div><i className="bi bi-telephone me-1" />{l.phone}</div> : null}
                      {l.email ? <div><i className="bi bi-envelope me-1" />{l.email}</div> : null}
                      {l.whatsapp ? <div><i className="bi bi-whatsapp me-1" />{l.whatsapp}</div> : null}
                      {!l.phone && !l.email && !l.whatsapp ? <span className="text-muted">—</span> : null}
                    </td>
                    <td>
                      {l.bookingEnabled ? <span className="badge text-bg-success">Attivo</span> : <span className="badge text-bg-secondary">Disattivo</span>}
                    </td>
                    <td>
                      {l.marketplaceEnabled ? <span className="badge text-bg-success">Visibile</span> : <span className="badge text-bg-secondary">Nascosta</span>}
                    </td>
                    <td className="small">
                      {(l.activityCategories ?? []).length
                        ? (l.activityCategories ?? []).map((c) => String(c.name ?? "")).filter(Boolean).join(", ")
                        : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <div className="btn-group">
                        <button className="btn btn-sm btn-outline-secondary" type="button" disabled={busy || idx === 0} onClick={() => move(l, "up")} title="Sposta su">
                          <i className="bi bi-arrow-up" />
                        </button>
                        <button className="btn btn-sm btn-outline-secondary" type="button" disabled={busy || idx === locations.length - 1} onClick={() => move(l, "down")} title="Sposta giù">
                          <i className="bi bi-arrow-down" />
                        </button>
                      </div>
                    </td>
                    <td className="text-end">
                      <button className="btn btn-sm btn-outline-primary me-1" type="button" onClick={() => openEdit(l)}>
                        <i className="bi bi-pencil" /> Modifica
                      </button>
                      <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openMarketplace(l)}>
                        <i className="bi bi-shop" /> Marketplace
                      </button>
                      <button className="btn btn-sm btn-danger" type="button" onClick={() => openDeletePreview(l)} disabled={busy}>
                        <i className="bi bi-trash" /> Elimina
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODALE SEDE (locationModal, locations.php ~685-797) */}
      {editOpen ? (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setEditOpen(false)}>
          <div className="modal-dialog modal-lg modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <form className="modal-content" onSubmit={saveLocation}>
              <div className="modal-header">
                <h5 className="modal-title">{form.id > 0 ? "Modifica sede" : "Nuova sede"}</h5>
                <button className="btn-close" type="button" onClick={() => setEditOpen(false)} />
              </div>
              <div className="modal-body">
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label">Nome *</label>
                    <input className="form-control" name="name" required value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Indirizzo</label>
                    <input className="form-control" name="address" value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Regione</label>
                    <input className="form-control" name="legal_region" value={form.legal_region} onChange={(e) => setForm((p) => ({ ...p, legal_region: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Provincia</label>
                    <input className="form-control" name="legal_province" value={form.legal_province} onChange={(e) => setForm((p) => ({ ...p, legal_province: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Città</label>
                    <input className="form-control" name="legal_city" value={form.legal_city} onChange={(e) => setForm((p) => ({ ...p, legal_city: e.target.value }))} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">CAP</label>
                    <input className="form-control" name="legal_cap" value={form.legal_cap} onChange={(e) => setForm((p) => ({ ...p, legal_cap: e.target.value }))} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Telefono</label>
                    <input className="form-control" name="phone" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Email</label>
                    <input className="form-control" name="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">WhatsApp</label>
                    <input className="form-control" name="whatsapp" value={form.whatsapp} onChange={(e) => setForm((p) => ({ ...p, whatsapp: e.target.value }))} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Facebook</label>
                    <input className="form-control" name="facebook_url" value={form.facebook_url} onChange={(e) => setForm((p) => ({ ...p, facebook_url: e.target.value }))} placeholder="URL o @handle" />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Instagram</label>
                    <input className="form-control" name="instagram_url" value={form.instagram_url} onChange={(e) => setForm((p) => ({ ...p, instagram_url: e.target.value }))} placeholder="URL o @handle" />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">TikTok</label>
                    <input className="form-control" name="tiktok_url" value={form.tiktok_url} onChange={(e) => setForm((p) => ({ ...p, tiktok_url: e.target.value }))} placeholder="URL o @handle" />
                  </div>
                  <div className="col-12">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="loc_booking_enabled"
                        checked={form.booking_enabled}
                        disabled={!flags?.bookingPublicAllowed}
                        onChange={(e) => setForm((p) => ({ ...p, booking_enabled: e.target.checked }))}
                      />
                      <label className="form-check-label" htmlFor="loc_booking_enabled">Abilita in prenotazioni online</label>
                    </div>
                    {!flags?.bookingPublicAllowed ? <div className="form-text">{flags?.unavailableMessage}</div> : null}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setEditOpen(false)}>Annulla</button>
                <button className="btn btn-primary" type="submit" disabled={busy}>Salva</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODALE MARKETPLACE SEDE (locationMarketplaceModal ~799-917) */}
      {mktLocation ? (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setMktLocation(null)}>
          <div className="modal-dialog modal-lg modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <form className="modal-content" onSubmit={saveMarketplace}>
              <div className="modal-header">
                <h5 className="modal-title">Marketplace sede — {mktLocation.name}</h5>
                <button className="btn-close" type="button" onClick={() => setMktLocation(null)} />
              </div>
              <div className="modal-body">
                <div className="form-check form-switch mb-3">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="mkt_enabled"
                    checked={mktEnabled}
                    disabled={!flags?.marketplacePublicAllowed}
                    onChange={(e) => setMktEnabled(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="mkt_enabled">Visibile nel marketplace</label>
                  {!flags?.marketplacePublicAllowed ? <div className="form-text">{flags?.unavailableMessage}</div> : null}
                </div>

                <label className="form-label">Categorie attività</label>
                <div className="row g-2 mb-2">
                  {(ctx?.activityCategories ?? []).map((c) => (
                    <div className="col-md-4" key={c.id}>
                      <div className={`border rounded p-2 d-flex align-items-center gap-2 ${mktCategoryIds.includes(c.id) ? "border-primary" : ""}`}>
                        <input
                          className="form-check-input m-0"
                          type="checkbox"
                          id={`mkt_cat_${c.id}`}
                          checked={mktCategoryIds.includes(c.id)}
                          onChange={(e) => {
                            setMktCategoryIds((prev) => e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id));
                            if (!e.target.checked && mktPrimaryId === c.id) setMktPrimaryId(0);
                          }}
                        />
                        <label className="form-check-label flex-grow-1" htmlFor={`mkt_cat_${c.id}`}>{c.name}</label>
                        {mktCategoryIds.includes(c.id) ? (
                          <input
                            type="radio"
                            name="mkt_primary"
                            title="Categoria principale"
                            checked={mktPrimaryId === c.id}
                            onChange={() => setMktPrimaryId(c.id)}
                          />
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="form-text mb-3">Seleziona le categorie e la principale (pallino). Almeno una categoria per rendere visibile la sede.</div>

                <label className="form-label">Gallery sede</label>
                <div className="d-flex gap-2 flex-wrap mb-2">
                  {(mktLocation.galleryImages ?? []).length === 0 ? (
                    <span className="text-muted small">Nessuna foto caricata.</span>
                  ) : (
                    (mktLocation.galleryImages ?? []).map((g, i) => (
                      <div key={g.id ?? i} className="position-relative border rounded p-1">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={String(g.url ?? g.image_url ?? "")} alt="" style={{ width: 96, height: 72, objectFit: "cover" }} className="rounded" />
                        <div className="d-flex justify-content-between mt-1">
                          <button className="btn btn-sm btn-outline-secondary py-0 px-1" type="button" title="Sposta a sinistra" disabled={busy || i === 0} onClick={() => galleryAction("location_gallery_move", Number(g.id ?? 0), "up")}>
                            <i className="bi bi-arrow-left" />
                          </button>
                          <button className="btn btn-sm btn-outline-danger py-0 px-1" type="button" title="Rimuovi" disabled={busy} onClick={() => galleryAction("location_gallery_delete", Number(g.id ?? 0))}>
                            <i className="bi bi-trash" />
                          </button>
                          <button className="btn btn-sm btn-outline-secondary py-0 px-1" type="button" title="Sposta a destra" disabled={busy || i === (mktLocation.galleryImages ?? []).length - 1} onClick={() => galleryAction("location_gallery_move", Number(g.id ?? 0), "down")}>
                            <i className="bi bi-arrow-right" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <input
                  className="form-control form-control-sm"
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  multiple
                  disabled={busy}
                  onChange={(e) => uploadGallery(e.target.files)}
                />
                <div className="form-text">JPG, PNG o WEBP — max 5 MB per foto.</div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setMktLocation(null)}>Annulla</button>
                <button className="btn btn-primary" type="submit" disabled={busy}>Salva</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* MODALE ELIMINAZIONE (locationDeletePreviewModal ~1041-1239) */}
      {deletePreview ? (
        <div className="modal d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setDeletePreview(null)}>
          <div className="modal-dialog modal-lg modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <form className="modal-content" onSubmit={confirmDelete}>
              <div className="modal-header">
                <h5 className="modal-title">
                  {deletePreview.canDelete ? `Elimina sede — ${deletePreview.location?.name ?? ""}` : "Impossibile eliminare la sede"}
                </h5>
                <button className="btn-close" type="button" onClick={() => setDeletePreview(null)} />
              </div>
              <div className="modal-body">
                {!deletePreview.canDelete ? (
                  <>
                    <div className="alert alert-danger">{deletePreview.deleteBlockReason || "Sede non eliminabile in sicurezza."}</div>
                    {Object.keys(deletePreview.blockingCounts ?? {}).length ? (
                      <>
                        <div className="fw-semibold mb-1">Storico che blocca l&apos;eliminazione</div>
                        <ul className="small mb-0">
                          {Object.entries(deletePreview.blockingCounts ?? {}).map(([t, c]) => (
                            <li key={t}>{tableLabel(t)}: {c}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="alert alert-warning">
                      L&apos;eliminazione è definitiva. Le configurazioni della sede verranno rimosse; i dati globali condivisi restano.
                    </div>
                    {Object.keys(deletePreview.directCounts ?? {}).length ? (
                      <>
                        <div className="fw-semibold mb-1">Configurazioni della sede eliminate</div>
                        <ul className="small">
                          {Object.entries(deletePreview.directCounts ?? {}).map(([t, c]) => (
                            <li key={t}>{tableLabel(t)}: {c}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <div className="text-muted small mb-2">Nessuna configurazione specifica della sede da eliminare.</div>
                    )}
                    <div className="mb-2">
                      <label className="form-label">Motivo (facoltativo)</label>
                      <input className="form-control" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />
                    </div>
                    <div>
                      <label className="form-label">
                        Per confermare digita <strong>{deletePreview.confirmText ?? "ELIMINA"}</strong>
                      </label>
                      <input className="form-control" value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} />
                    </div>
                  </>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" type="button" onClick={() => setDeletePreview(null)}>
                  {deletePreview.canDelete ? "Indietro" : "Chiudi"}
                </button>
                {deletePreview.canDelete ? (
                  <button className="btn btn-danger" type="submit" disabled={busy || deleteConfirm.trim() !== (deletePreview.confirmText ?? "ELIMINA")}>
                    <i className="bi bi-trash me-1" />
                    Elimina definitivamente
                  </button>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
