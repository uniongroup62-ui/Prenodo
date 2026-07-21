"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP location NEW / EDIT form (app/pages/locations.php,
// the #locationModalForm posted with action=location_save). Field groups and
// Bootstrap markup mirror the legacy editor:
//   - Nome sede (name, required), Indirizzo (address)
//   - Regione / Provincia / Citta / CAP (legal_region / legal_province /
//     legal_city / legal_cap). In the legacy page these are Italian-geo
//     comboboxes driven by assets/js (region->province->city cascade); the geo
//     dataset is not exposed by our API, so they are rendered here as faithful
//     plain text inputs posting the same hidden field names.
//   - Telefono, Email, WhatsApp, Facebook, Instagram, TikTok (phone/email/
//     whatsapp/facebook_url/instagram_url/tiktok_url)
//   - Abilita in prenotazioni online (booking_enabled)
// Submits to /api/manage/business-settings (action=location_save; create when no
// id, update with id) — the same endpoint/handler the legacy locationModal posts
// to (saveBusinessLocation). The Marketplace modal (location_marketplace_save,
// activity categories + gallery) and the delete-preview flow stay on their own
// list controls and are NOT part of this create/edit form, faithful to the PHP
// where they are separate modals.

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

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): LocationForm {
  return {
    id: 0,
    name: "",
    address: "",
    legal_region: "",
    legal_province: "",
    legal_city: "",
    legal_cap: "",
    phone: "",
    email: "",
    whatsapp: "",
    facebook_url: "",
    instagram_url: "",
    tiktok_url: "",
    booking_enabled: true,
  };
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function LocationFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action, setAction] = useState<"new" | "edit">("new");
  // Audit giro 3: azione letta POST-MOUNT (pattern SSR-safe) — l'initializer
  // leggeva window e il titolo divergeva tra server ("Nuovo") e client (edit).
  useEffect(() => {
    setAction(resolveAction());
  }, []);
  const [form, setForm] = useState<LocationForm>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // On edit (action=edit&id=) prefill from locations?action=get. On new, keep the
  // faithful defaults (booking enabled, like the legacy default form).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const editPromise =
      act === "edit" && Number.isFinite(id) && id > 0
        ? fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
            headers: { "x-tenant-slug": slug },
          })
            .then((r) => r.json())
            .then((j) => {
              if (!j.ok || !j.location) {
                setError(String(j.error ?? "Sede non trovata."));
                return;
              }
              const l = j.location;
              setForm({
                id: Number(l.id ?? id),
                name: String(l.name ?? ""),
                address: String(l.address ?? ""),
                legal_region: String(l.legalRegion ?? ""),
                legal_province: String(l.legalProvince ?? ""),
                legal_city: String(l.legalCity ?? ""),
                legal_cap: String(l.legalCap ?? ""),
                phone: String(l.phone ?? ""),
                email: String(l.email ?? ""),
                whatsapp: String(l.whatsapp ?? ""),
                facebook_url: String(l.facebookUrl ?? ""),
                instagram_url: String(l.instagramUrl ?? ""),
                tiktok_url: String(l.tiktokUrl ?? ""),
                booking_enabled: Boolean(l.bookingEnabled ?? true),
              });
            })
            .catch(() => setError("Errore nel caricamento della sede."))
        : Promise.resolve();

    editPromise.finally(() => setLoading(false));
  }, [slug]);

  function set<K extends keyof LocationForm>(key: K, value: LocationForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/locations`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to locations.php saveBusinessLocation: name required,
    // email (if present) must be a valid address.
    const name = form.name.trim();
    if (name === "") {
      setError("Inserisci il nome della sede.");
      return;
    }
    const email = form.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Email non valida.");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "location_save",
        id: String(form.id),
        name,
        address: form.address,
        legal_region: form.legal_region,
        legal_province: form.legal_province,
        legal_city: form.legal_city,
        legal_cap: form.legal_cap,
        phone: form.phone,
        email: form.email,
        whatsapp: form.whatsapp,
        facebook_url: form.facebook_url,
        instagram_url: form.instagram_url,
        tiktok_url: form.tiktok_url,
        booking_enabled: form.booking_enabled ? "1" : "0",
      };
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio della sede."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio della sede.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuova sede" : "Modifica sede";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/locations.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Aggiungi i dati della tua sede e imposta la visibilita.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/locations`}>
            <i className="bi bi-arrow-left me-1" />
            Torna alle sedi
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="card p-3 mb-3">
          <form method="post" className="row g-3" id="locationModalForm" onSubmit={onSubmit}>
            <input type="hidden" name="action" value="location_save" />
            <input type="hidden" name="id" value={form.id} />

            <div className="col-12">
              <label className="form-label">Nome sede</label>
              <input
                className="form-control"
                name="name"
                required
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>

            <div className="col-12">
              <label className="form-label">Indirizzo</label>
              <input
                className="form-control"
                name="address"
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Regione</label>
              <input
                className="form-control"
                name="legal_region"
                value={form.legal_region}
                onChange={(e) => set("legal_region", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Provincia</label>
              <input
                className="form-control"
                name="legal_province"
                value={form.legal_province}
                onChange={(e) => set("legal_province", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Città</label>
              <input
                className="form-control"
                name="legal_city"
                value={form.legal_city}
                onChange={(e) => set("legal_city", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">CAP</label>
              <input
                className="form-control"
                name="legal_cap"
                maxLength={20}
                value={form.legal_cap}
                onChange={(e) => set("legal_cap", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Telefono</label>
              <input
                className="form-control"
                name="phone"
                inputMode="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Email</label>
              <input
                className="form-control"
                type="email"
                name="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </div>

            <div className="col-md-3">
              <label className="form-label">WhatsApp</label>
              <input
                className="form-control"
                name="whatsapp"
                inputMode="tel"
                value={form.whatsapp}
                onChange={(e) => set("whatsapp", e.target.value)}
              />
            </div>

            <div className="col-md-3">
              <label className="form-label">Facebook</label>
              <input
                className="form-control"
                name="facebook_url"
                inputMode="url"
                placeholder="facebook.com/pagina"
                value={form.facebook_url}
                onChange={(e) => set("facebook_url", e.target.value)}
              />
            </div>

            <div className="col-md-3">
              <label className="form-label">Instagram</label>
              <input
                className="form-control"
                name="instagram_url"
                inputMode="url"
                placeholder="@profilo"
                value={form.instagram_url}
                onChange={(e) => set("instagram_url", e.target.value)}
              />
            </div>

            <div className="col-md-3">
              <label className="form-label">TikTok</label>
              <input
                className="form-control"
                name="tiktok_url"
                inputMode="url"
                placeholder="@profilo"
                value={form.tiktok_url}
                onChange={(e) => set("tiktok_url", e.target.value)}
              />
            </div>

            <div className="col-12">
              <label className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  name="booking_enabled"
                  value="1"
                  checked={form.booking_enabled}
                  onChange={(e) => set("booking_enabled", e.target.checked)}
                />
                <span className="form-check-label">Abilita in prenotazioni online</span>
              </label>
              <div className="alert alert-warning py-2 px-3 mt-2 mb-0" role="alert">
                Disattivando le prenotazioni online, la scheda può restare accessibile ma i pulsanti Prenota non verranno
                mostrati.
              </div>
            </div>

            <div className="col-12 d-flex gap-2">
              <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                {saving ? "Salvataggio…" : "Salva sede"}
              </button>
              <button className="btn btn-outline-secondary btn-pill" type="button" onClick={backToList}>
                Annulla
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
