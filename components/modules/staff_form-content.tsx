"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP operator NEW / EDIT form (app/pages/staff.php,
// the #staffOperatorCreateModal / action=edit form posted with action=staff_save).
// Field groups and Bootstrap markup mirror the legacy editor:
//   - Operatore: full_name (required), ui_role (Staff / Admin / Personalizzato)
//   - Account e contatti: email (required on new), password (required on new,
//     leave blank on edit to keep the current one), phone, calendar_color
//     (color picker, default #93c5fd), is_active (Attivo)
//   - Sedi abilitate: per-location checkboxes (location_ids[])
// Submits to /api/manage/resources (action=staff_save; create when no id, update
// with id) — the same endpoint/handler the legacy form posts to (saveStaffMember,
// which also upserts the login user + sends the "Conferma email account" invite).
//
// FOTO OPERATORE: campo file (operator_photo, jpeg/png/webp/gif max 5MB) con
// anteprima circolare + "Rimuovi foto". L'upload viaggia DOPO staff_save su
// /api/manage/staff-photo (multipart -> Cloudflare R2, photo_path = URL
// pubblico). Il crop/zoom client-side del legacy (photo_crop_data) non è
// portato: l'immagine è salvata come caricata, il ritaglio circolare resta CSS.
// The "Admin" role option is shown for everyone here; the legacy hides it for
// non-admins as a cosmetic guard (role security is still enforced server-side
// by the staff.manage permission gate).

type LocationRow = { id: number; name: string; isActive?: boolean };

type StaffContext = {
  ok?: boolean;
  locations?: LocationRow[];
};

type StaffForm = {
  id: number;
  full_name: string;
  ui_role: "staff" | "admin" | "altro";
  email: string;
  password: string;
  phone: string;
  calendar_color: string;
  is_active: boolean;
  location_ids: number[];
};

const DEFAULT_COLOR = "#93c5fd";

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): StaffForm {
  return {
    id: 0,
    full_name: "",
    ui_role: "staff",
    email: "",
    password: "",
    phone: "",
    calendar_color: DEFAULT_COLOR,
    is_active: true,
    location_ids: [],
  };
}

function normalizeColor(value: string): string {
  let cc = (value || "").trim();
  if (cc !== "" && cc[0] !== "#") cc = `#${cc}`;
  return /^#[0-9a-fA-F]{6}$/.test(cc) ? cc : DEFAULT_COLOR;
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

export function StaffFormContent({ slug: slugProp, action: actionProp, staffId: staffIdProp }: { slug?: string; action?: "new" | "edit"; staffId?: number } = {}) {
  // Prop dal server preferite: il fallback window-only rende slug/action divergenti in
  // SSR (slug="" -> link //pagina; action="new" -> titolo "Nuovo operatore" mentre il
  // client legge "edit") -> hydration mismatch. Con le prop, server e client coincidono.
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(() => actionProp ?? resolveAction());
  const staffId = staffIdProp ?? 0;
  const [form, setForm] = useState<StaffForm>(emptyForm());
  const [ctx, setCtx] = useState<StaffContext>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Foto operatore: il file scelto (con anteprima object-URL), l'URL corrente
  // dal DB (edit) e il flag "rimuovi" (staff_action=delete_photo del legacy).
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState("");
  const [removePhoto, setRemovePhoto] = useState(false);

  // Load the staff context (locations), then prefill on edit (action=get) or
  // keep the faithful new-operator defaults.
  useEffect(() => {
    const act = action;
    const id = staffId > 0 ? staffId : Number.parseInt(new URLSearchParams(window.location.search).get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=staff`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: StaffContext) => {
        setCtx(j ?? {});
        return j ?? {};
      })
      .catch(() => {
        setCtx({});
        return {} as StaffContext;
      });

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}&section=staff&action=get&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.staff) {
            setError(String(j.error ?? "Operatore non trovato."));
            return;
          }
          const s = j.staff;
          setForm({
            id: Number(s.id ?? id),
            full_name: String(s.fullName ?? ""),
            ui_role: (["staff", "admin", "altro"].includes(s.role) ? s.role : "staff") as StaffForm["ui_role"],
            email: String(s.email ?? ""),
            password: "",
            phone: String(s.phone ?? ""),
            calendar_color: normalizeColor(String(s.color ?? "")),
            is_active: Boolean(s.isActive ?? true),
            location_ids: (s.locationIds ?? []).map(Number).filter((n: number) => n > 0),
          });
          setCurrentPhotoUrl(String(s.photoPath ?? "").trim());
        })
        .catch(() => setError("Errore nel caricamento dell'operatore."))
        .finally(() => setLoading(false));
    } else {
      ctxPromise.finally(() => setLoading(false));
    }
  }, [slug, action, staffId]);

  function set<K extends keyof StaffForm>(key: K, value: StaffForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleLocation(id: number, checked: boolean) {
    setForm((prev) => {
      const current = new Set(prev.location_ids);
      if (checked) current.add(id);
      else current.delete(id);
      return { ...prev, location_ids: Array.from(current) };
    });
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/staff`;
  }

  const locations = useMemo(() => ctx.locations ?? [], [ctx.locations]);
  const hasLocations = locations.length > 0;

  // flashKind 'msg' del server = alert VERDE (i redirect &msg= del legacy).
  const [flashMsg, setFlashMsg] = useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setFlashMsg("");
    setSaving(true);
    try {
      const fullName = form.full_name.trim();
      const payload: Record<string, unknown> = {
        action: "staff_save",
        id: String(form.id),
        full_name: fullName,
        ui_role: form.ui_role,
        email: form.email,
        password: form.password,
        phone: form.phone,
        calendar_color: form.calendar_color,
        is_active: form.is_active ? "1" : "0",
        location_ids: form.location_ids.join(","),
      };
      const res = await fetch(`/api/manage/resources?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        // Errori 'msg' del legacy (Email obbligatoria, Email già utilizzata,
        // Colore non valido, ...) restano alert VERDI; gli altri rossi.
        if (String(j.flashKind ?? "") === "msg") setFlashMsg(String(j.error ?? ""));
        else setError(String(j.error ?? "Errore nel salvataggio dell'operatore."));
        setSaving(false);
        window.scrollTo(0, 0);
        return;
      }

      // FOTO: dopo il salvataggio dell'operatore (serve l'id anche in creazione),
      // carica la nuova immagine o applica la rimozione su /api/manage/staff-photo.
      // L'operatore è GIÀ salvato: un errore foto resta sul form con il messaggio.
      const savedId = Number(j.staff?.id ?? form.id) || form.id;
      if (savedId > 0 && (photoFile || removePhoto)) {
        const fd = new FormData();
        fd.set("staff_id", String(savedId));
        if (photoFile) fd.set("operator_photo", photoFile);
        else fd.set("remove_photo", "1");
        const photoRes = await fetch(`/api/manage/staff-photo?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "x-tenant-slug": slug },
          body: fd,
        });
        const photoJson = await photoRes.json().catch(() => ({}));
        if (!photoRes.ok || photoJson.ok === false) {
          setError(`Operatore salvato, ma la foto non è stata aggiornata: ${String(photoJson.error ?? "errore caricamento foto.")}`);
          setSaving(false);
          return;
        }
      }

      // Redirect flash legacy (staff.php 1069).
      window.location.assign(`/${encodeURIComponent(slug)}/staff?msg=${encodeURIComponent(String(j.msg ?? "Operatore salvato"))}`);
    } catch {
      setError("Errore nel salvataggio dell'operatore.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo operatore" : "Modifica operatore";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/staff.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Gestisci operatori, ruoli e sedi abilitate.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/staff`}>
            <i className="bi bi-arrow-left me-1" />
            Torna allo staff
          </a>
        </div>
      </div>

      {flashMsg ? <div className="alert alert-success">{flashMsg}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="card p-3 mb-3">
          <form method="post" onSubmit={onSubmit}>
            <input type="hidden" name="action" value="staff_save" />
            <input type="hidden" name="id" value={form.id} />

            <div className="row g-3">
              <div className="col-12">
                <div className="fw-semibold mb-1">Operatore</div>
              </div>

              <div className="col-lg-6">
                <label className="form-label">Nome operatore</label>
                <input
                  className="form-control"
                  name="full_name"
                  required
                  value={form.full_name}
                  onChange={(e) => set("full_name", e.target.value)}
                />
              </div>

              <div className="col-lg-3">
                <label className="form-label">Ruolo</label>
                <select
                  className="form-select"
                  name="ui_role"
                  required={action === "new"}
                  value={form.ui_role}
                  onChange={(e) => set("ui_role", e.target.value as StaffForm["ui_role"])}
                >
                  <option value="staff">Staff</option>
                  <option value="admin">Admin</option>
                  <option value="altro">Personalizzato</option>
                </select>
              </div>

              {/* Foto operatore (port del box .staff-photo-field di staff.php):
                  anteprima circolare (immagine o iniziale), input file
                  jpeg/png/webp/gif max 5MB, Rimuovi foto. Upload su R2 dopo il
                  salvataggio (vedi onSubmit); niente crop/zoom client (divergenza
                  documentata). */}
              <div className="col-12">
                <div className="border rounded-4 p-3">
                  <div className="fw-semibold mb-2">Immagine operatore</div>
                  <div className="d-flex align-items-center gap-3 flex-wrap">
                    <div
                      className="rounded-circle border d-flex align-items-center justify-content-center overflow-hidden flex-shrink-0"
                      style={{ width: 96, height: 96, background: "#f1f5f9" }}
                      aria-label="Anteprima immagine operatore"
                    >
                      {photoPreview || (currentPhotoUrl && !removePhoto) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photoPreview || currentPhotoUrl}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <span className="fs-3 fw-semibold text-secondary">
                          {(form.full_name.trim().charAt(0) || "O").toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="flex-grow-1" style={{ minWidth: 240 }}>
                      <input
                        className="form-control"
                        type="file"
                        name="operator_photo"
                        id="staffPhotoInput"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          if (photoPreview) URL.revokeObjectURL(photoPreview);
                          if (file && file.size > 5242880) {
                            setError("Immagine troppo grande (max 5 MB).");
                            setPhotoFile(null);
                            setPhotoPreview("");
                            e.target.value = "";
                            return;
                          }
                          setError("");
                          setPhotoFile(file);
                          setPhotoPreview(file ? URL.createObjectURL(file) : "");
                          if (file) setRemovePhoto(false);
                        }}
                      />
                      <div className="form-text">JPG, PNG, WEBP o GIF — massimo 5 MB.</div>
                      {currentPhotoUrl && !photoFile ? (
                        <div className="form-check mt-1">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id="staffRemovePhoto"
                            checked={removePhoto}
                            onChange={(e) => setRemovePhoto(e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor="staffRemovePhoto">
                            Rimuovi foto
                          </label>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="col-12">
                <div className="fw-semibold mb-1 mt-2">Account e contatti</div>
              </div>

              <div className="col-lg-4">
                <label className="form-label">Email</label>
                <input
                  className="form-control"
                  type="email"
                  name="email"
                  required={action === "new"}
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                />
              </div>

              <div className="col-lg-4">
                <label className="form-label">Password (login)</label>
                <input
                  className="form-control"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  required={action === "new"}
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                />
                {action === "edit" ? <div className="form-text">Lascia vuoto per non modificarla.</div> : null}
              </div>

              <div className="col-lg-4">
                <label className="form-label">Telefono</label>
                <input
                  className="form-control"
                  name="phone"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                />
              </div>

              <div className="col-lg-3">
                <label className="form-label">Colore calendario</label>
                <input
                  className="form-control form-control-color"
                  type="color"
                  name="calendar_color"
                  title="Scegli colore"
                  value={normalizeColor(form.calendar_color)}
                  onChange={(e) => set("calendar_color", e.target.value)}
                />
                <div className="form-text">Usato per la colonna nel calendario.</div>
              </div>

              <div className="col-lg-2">
                <label className="form-label">Stato</label>
                <div className="form-check form-switch pt-2">
                  <input
                    className="form-check-input"
                    id="staffIsActive"
                    type="checkbox"
                    name="is_active"
                    checked={form.is_active}
                    onChange={(e) => set("is_active", e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="staffIsActive">
                    Attivo
                  </label>
                </div>
              </div>

              <div className="col-12">
                <div className="fw-semibold mb-1 mt-2">Sedi abilitate</div>
                {hasLocations ? (
                  <>
                    <div className="staff-location-grid">
                      {locations.map((loc) => {
                        const lid = Number(loc.id);
                        if (lid <= 0) return null;
                        return (
                          <div className="form-check staff-location-card" key={lid}>
                            <input
                              className="form-check-input"
                              type="checkbox"
                              name="location_ids[]"
                              id={`staff_loc_${lid}`}
                              value={lid}
                              checked={form.location_ids.includes(lid)}
                              onChange={(e) => toggleLocation(lid, e.target.checked)}
                            />
                            <label className="form-check-label" htmlFor={`staff_loc_${lid}`}>
                              <span className="staff-location-card-title">{loc.name || `Sede #${lid}`}</span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    <div className="form-text">Seleziona almeno una sede in cui l&apos;operatore sara disponibile.</div>
                  </>
                ) : (
                  <div className="form-control-plaintext text-muted">Tutte le sedi</div>
                )}
              </div>
            </div>

            <hr className="my-3" />
            <div className="d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                {saving ? "Salvataggio…" : "Salva"}
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={backToList}>
                Annulla
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
