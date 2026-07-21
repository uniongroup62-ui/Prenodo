"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTakenFlash } from "./flash";

// Faithful port of the PHP business profile page (app/pages/business_profile.php
// + assets/js/pages/business_profile.js): public profile name + "Chi siamo"
// text, logo/cover branding with the legacy pending-upload card (thumb, badge
// "Da salvare", clear), the drag-to-position preview (pointer events +
// object-position), the per-kind branding-feedback alerts for AJAX
// upload/delete and the global View::alert flash (type INFO for the legacy
// redirect ?msg=, danger for ?err= / inline errors). Fed by the DB-backed
// /api/manage/business-settings route.

type Branding = {
  logoUrl: string;
  coverUrl: string;
  logoPosition: { x: number; y: number };
  coverPosition: { x: number; y: number };
};

type Business = {
  id: number;
  name: string;
  bookingAboutText: string;
  logoUrl: string;
  coverUrl: string;
  logoPositionX: number;
  logoPositionY: number;
  coverPositionX: number;
  coverPositionY: number;
};

type BusinessSettings = {
  ok: boolean;
  business: Business | null;
  branding: Branding | null;
  message?: string;
};

type Kind = "logo" | "cover";

type Feedback = { type: "success" | "danger"; text: string } | null;

type PendingFile = { file: File; url: string } | null;

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// business_profile.js clamp().
function clampPos(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

// business_profile.js formatFileSize: MB con virgola italiana.
function formatFileSize(bytes: number): string {
  const size = Number(bytes || 0);
  if (size <= 0) return "0 MB";
  return (size / 1048576).toFixed(1).replace(".", ",") + " MB";
}

// business_profile.js validateBrandingFile (testi verbatim).
function validateBrandingFile(kind: Kind, file: File | null): string {
  if (!file) return "File non valido.";
  if (file.size > 5242880) return "File troppo grande: max 5 MB.";
  const logoOk = /^(image\/jpeg|image\/png)$/i.test(file.type || "") || /\.(jpe?g|png)$/i.test(file.name || "");
  const coverOk = /^(image\/jpeg|image\/png|image\/webp)$/i.test(file.type || "") || /\.(jpe?g|png|webp)$/i.test(file.name || "");
  if (kind === "logo" && !logoOk) return "Formato non valido: carica JPG o PNG.";
  if (kind === "cover" && !coverOk) return "Formato non valido: carica JPG, PNG o WEBP.";
  return "";
}

export function BusinessProfileContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string; err?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [business, setBusiness] = useState<Business | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  // Flash globale (View::alert sopra il page header): i redirect legacy usano
  // msg -> alert-info (default View::alert) ed err -> alert-danger.
  const [flash, setFlash] = useState<{ type: "info" | "danger"; text: string } | null>(() => {
    if (initialQuery?.err) return { type: "danger", text: String(initialQuery.err) };
    if (initialQuery?.msg) return { type: "info", text: String(initialQuery.msg) };
    return null;
  });
  useTakenFlash((f) => {
    if (f.err) setFlash({ type: "danger", text: f.err });
    else if (f.msg) setFlash({ type: "info", text: f.msg });
  });

  // Profile form (pre-filled from the API on mount).
  const [businessName, setBusinessName] = useState("");
  const [aboutText, setAboutText] = useState("");

  // Branding position fields (pre-filled from the API on mount).
  const [logoPositionX, setLogoPositionX] = useState("50");
  const [logoPositionY, setLogoPositionY] = useState("50");
  const [coverPositionX, setCoverPositionX] = useState("50");
  const [coverPositionY, setCoverPositionY] = useState("50");

  // Pending upload per kind (business_profile.js brandingPending): il file
  // scelto abilita il Salva e viene mostrato nella card "Da salvare" con
  // anteprima objectURL; i feedback AJAX vivono nell'alert per-kind.
  const logoFileInputRef = useRef<HTMLInputElement | null>(null);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const [logoPending, setLogoPending] = useState<PendingFile>(null);
  const [coverPending, setCoverPending] = useState<PendingFile>(null);
  const [logoFeedback, setLogoFeedback] = useState<Feedback>(null);
  const [coverFeedback, setCoverFeedback] = useState<Feedback>(null);
  const [uploadingKind, setUploadingKind] = useState<Kind | null>(null);
  const [deletingKind, setDeletingKind] = useState<Kind | null>(null);
  const [dragoverKind, setDragoverKind] = useState<Kind | null>(null);

  const showFlash = useCallback((next: { type: "info" | "danger"; text: string } | null) => {
    setFlash(next);
    if (next && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(() => {
    fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: BusinessSettings) => {
        applyContext(j);
      })
      .catch(() => {
        setBusiness(null);
        setBranding(null);
      });
  }, [slug]);

  function applyContext(j: BusinessSettings) {
    const b = j.business ?? null;
    const br = j.branding ?? null;
    setBusiness(b);
    setBranding(br);
    setBusinessName(b?.name ?? "");
    setAboutText(b?.bookingAboutText ?? "");
    setLogoPositionX(String(br?.logoPosition?.x ?? b?.logoPositionX ?? 50));
    setLogoPositionY(String(br?.logoPosition?.y ?? b?.logoPositionY ?? 50));
    setCoverPositionX(String(br?.coverPosition?.x ?? b?.coverPositionX ?? 50));
    setCoverPositionY(String(br?.coverPosition?.y ?? b?.coverPositionY ?? 50));
  }

  useEffect(() => {
    load();
  }, [load]);

  // POST JSON per profilo/posizioni: come i form non-AJAX legacy, l'esito va
  // nell'alert globale (msg -> info, err -> danger).
  async function postGlobal(payload: Record<string, unknown>, fallbackMsg: string): Promise<void> {
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        showFlash({ type: "danger", text: String(j?.error ?? "Operazione non riuscita.") });
        return;
      }
      applyContext(j as BusinessSettings);
      showFlash({ type: "info", text: String(j?.message ?? fallbackMsg) });
    } catch {
      showFlash({ type: "danger", text: "Errore di rete." });
    }
  }

  const setKindFeedback = (kind: Kind, next: Feedback) => (kind === "logo" ? setLogoFeedback(next) : setCoverFeedback(next));
  const pendingOf = (kind: Kind) => (kind === "logo" ? logoPending : coverPending);

  function clearPending(kind: Kind) {
    const pending = pendingOf(kind);
    if (pending?.url) URL.revokeObjectURL(pending.url);
    if (kind === "logo") setLogoPending(null);
    else setCoverPending(null);
  }

  // business_profile.js selectBrandingFile: ignora la selezione se c'è già
  // un'immagine, valida con i testi legacy, prepara l'anteprima objectURL.
  function selectBrandingFile(kind: Kind, files: FileList | File[] | null) {
    const hasImage = kind === "logo" ? hasLogo : hasCover;
    if (hasImage) return;
    const file = files ? Array.from(files)[0] : null;
    if (!file) return;
    const error = validateBrandingFile(kind, file);
    if (error) {
      setKindFeedback(kind, { type: "danger", text: error });
      return;
    }
    clearPending(kind);
    const pending = { file, url: URL.createObjectURL(file) };
    if (kind === "logo") setLogoPending(pending);
    else setCoverPending(pending);
    setKindFeedback(kind, null);
  }

  // business_profile.js submitBrandingUpload: multipart AJAX, feedback
  // per-kind ('Logo salvato' / 'Errore upload logo: ...').
  async function uploadBranding(kind: Kind): Promise<void> {
    const pending = pendingOf(kind);
    if (!pending?.file) {
      setKindFeedback(kind, { type: "danger", text: kind === "logo" ? "Seleziona un logo da salvare." : "Seleziona una copertina da salvare." });
      return;
    }
    const error = validateBrandingFile(kind, pending.file);
    if (error) {
      setKindFeedback(kind, { type: "danger", text: error });
      return;
    }
    setUploadingKind(kind);
    setKindFeedback(kind, null);
    try {
      const form = new FormData();
      form.append("ajax", "1");
      form.append("action", kind === "logo" ? "upload_logo" : "upload_cover");
      form.append("kind", kind);
      form.append(kind === "logo" ? "business_logo" : "business_cover", pending.file, pending.file.name);
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: form,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        const errors = Array.isArray(j?.errors) && j.errors.length ? j.errors : [String(j?.error ?? "Salvataggio non riuscito.")];
        setKindFeedback(kind, { type: "danger", text: errors.join(" ") });
        return;
      }
      clearPending(kind);
      applyContext(j as BusinessSettings);
      setKindFeedback(kind, { type: "success", text: String(j?.message ?? (kind === "logo" ? "Logo salvato" : "Immagine di copertina salvata")) });
    } catch {
      setKindFeedback(kind, { type: "danger", text: "Salvataggio non riuscito." });
    } finally {
      setUploadingKind(null);
    }
  }

  // business_profile.js bindBrandingDeleteForms: confirm + AJAX + feedback
  // per-kind ('Logo rimosso' / 'Errore rimozione logo: ...').
  async function deleteBranding(kind: Kind): Promise<void> {
    setDeletingKind(kind);
    setKindFeedback(kind, null);
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ajax: "1", action: kind === "logo" ? "delete_logo" : "delete_cover", kind }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        const errors = Array.isArray(j?.errors) && j.errors.length ? j.errors : [String(j?.error ?? "Rimozione non riuscita.")];
        setKindFeedback(kind, { type: "danger", text: errors.join(" ") });
        return;
      }
      clearPending(kind);
      applyContext(j as BusinessSettings);
      setKindFeedback(kind, { type: "success", text: String(j?.message ?? (kind === "logo" ? "Logo rimosso" : "Immagine di copertina rimossa")) });
    } catch {
      setKindFeedback(kind, { type: "danger", text: "Rimozione non riuscita." });
    } finally {
      setDeletingKind(null);
    }
  }

  // Drag della preview (business_profile.js bindPreview): pointer events con
  // capture, clamp 0-100 e object-position live sull'<img>.
  function bindDragHandlers(kind: Kind) {
    const setX = kind === "logo" ? setLogoPositionX : setCoverPositionX;
    const setY = kind === "logo" ? setLogoPositionY : setCoverPositionY;
    const update = (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setX(String(clampPos(((e.clientX - rect.left) / rect.width) * 100)));
      setY(String(clampPos(((e.clientY - rect.top) / rect.height) * 100)));
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.querySelector("img")) return;
        e.currentTarget.classList.add("is-dragging");
        e.currentTarget.setPointerCapture?.(e.pointerId);
        update(e);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.classList.contains("is-dragging")) return;
        update(e);
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.classList.remove("is-dragging");
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      },
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => e.currentTarget.classList.remove("is-dragging"),
      onPointerLeave: (e: React.PointerEvent<HTMLDivElement>) => e.currentTarget.classList.remove("is-dragging"),
    };
  }

  const logoUrl = branding?.logoUrl || business?.logoUrl || "";
  const coverUrl = branding?.coverUrl || business?.coverUrl || "";
  const hasLogo = Boolean(logoUrl);
  const hasCover = Boolean(coverUrl);

  // Classi visibilità legacy: hidden se manca l'immagine (on-image) o se c'è
  // (without-image) — business_profile.php $logoVisibleOnImageClass & co.
  const onImage = (has: boolean) => (has ? "" : " branding-image-hidden");
  const withoutImage = (has: boolean) => (has ? " branding-image-hidden" : "");

  function renderKindFeedback(kind: Kind) {
    const feedback = kind === "logo" ? logoFeedback : coverFeedback;
    return (
      <div
        className={`alert branding-feedback mb-3 ${feedback ? "" : "d-none "}alert-${feedback?.type ?? "success"}`}
        data-branding-feedback={kind}
        role="alert"
        aria-live="polite"
      >
        {feedback?.text ?? ""}
      </div>
    );
  }

  // Card "Da salvare" (business_profile.js renderBrandingPending).
  function renderPendingList(kind: Kind, has: boolean) {
    const pending = pendingOf(kind);
    return (
      <div className={`branding-upload-list${withoutImage(has)}`} data-branding-upload-list={kind} data-branding-visible-without-image={kind}>
        {pending ? (
          <div className="branding-upload-row branding-upload-row--pending">
            <div className={`branding-upload-row__thumb${kind === "logo" ? " branding-upload-row__thumb--logo" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pending.url} alt={`Anteprima ${kind === "logo" ? "logo" : "copertina"}`} />
            </div>
            <div className="branding-upload-row__body">
              <div className="d-flex align-items-center justify-content-between gap-2 mb-1">
                <span className="badge text-bg-warning">Da salvare</span>
                <button
                  className="btn btn-outline-danger btn-sm"
                  type="button"
                  data-branding-clear={kind}
                  title="Rimuovi anteprima"
                  onClick={() => {
                    clearPending(kind);
                    setKindFeedback(kind, null);
                  }}
                >
                  <i className="bi bi-x-lg" />
                </button>
              </div>
              <div className="small fw-semibold branding-upload-row__name">{pending.file.name || "file"}</div>
              <div className="text-muted small">{formatFileSize(pending.file.size || 0)}</div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="container-fluid">
      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Profilo attivita</h1>
          <div className="bs-page-subtitle">Gestisci profilo pubblico, logo, copertina e dati mostrati nel booking.</div>
        </div>
      </div>

      <link rel="stylesheet" href="/assets/css/pages/business_profile.css" />

      <div className="row g-3 mt-3">
        <div className="col-12">
          <div className="card p-4">
            <form
              method="post"
              className="branding-upload-form row g-3 align-items-end mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                postGlobal(
                  { action: "save_profile_activity", business_name: businessName, booking_about_text: aboutText },
                  "Profilo attività salvato",
                );
              }}
            >
              <input type="hidden" name="action" value="save_profile_activity" />
              <div className="col-lg-8">
                <label className="form-label" htmlFor="profileBusinessName">Nome</label>
                <input
                  className="form-control"
                  type="text"
                  id="profileBusinessName"
                  name="business_name"
                  maxLength={190}
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Es. Beauty Center"
                />
                <div className="form-text">Verrà visualizzato nel booking pubblico sotto al logo.</div>
              </div>
              <div className="col-lg-8">
                <label className="form-label" htmlFor="profileAboutText">Chi siamo</label>
                <textarea
                  className="form-control"
                  id="profileAboutText"
                  name="booking_about_text"
                  rows={4}
                  maxLength={3000}
                  value={aboutText}
                  onChange={(e) => setAboutText(e.target.value)}
                  placeholder="Racconta brevemente l'attivita, l'ambiente e il tuo modo di lavorare."
                />
                <div className="form-text">Verrà mostrato nel booking pubblico in una sezione dedicata sopra la gallery.</div>
              </div>
              <div className="col-12">
                <button className="btn btn-primary btn-pill" type="submit">
                  <i className="bi bi-check2-circle me-1" />
                  Salva profilo
                </button>
              </div>
            </form>

            <div className="row g-4">
              <div className="col-lg-7">
                <div className="h6 fw-bold mb-2">Logo attività</div>
                <div className="text-muted small mb-3">
                  Il logo verrà mostrato nel <strong>booking pubblico</strong> e nelle <strong>email automatiche</strong>.
                </div>

                {renderKindFeedback("logo")}
                <div
                  className={`d-flex align-items-center gap-3 flex-wrap mb-3${onImage(hasLogo)}`}
                  data-branding-visible-on-image="logo"
                >
                  <div
                    className="branding-position-preview branding-position-preview--logo"
                    data-branding-position-preview
                    data-x-input="logoPositionX"
                    data-y-input="logoPositionY"
                    {...bindDragHandlers("logo")}
                  >
                    {hasLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoUrl} alt="Logo attività" style={{ objectPosition: `${clampPos(logoPositionX)}% ${clampPos(logoPositionY)}%` }} />
                    ) : null}
                  </div>
                  <div className="small text-muted">
                    Formati: JPG/PNG &bull; Max 5 MB<br />
                    Trascina l&apos;anteprima per regolare la posizione del logo nel booking.
                  </div>
                </div>

                <form
                  method="post"
                  className={`branding-position-form d-flex gap-2 flex-wrap mb-3${onImage(hasLogo)}`}
                  data-branding-visible-on-image="logo"
                  onSubmit={(e) => {
                    e.preventDefault();
                    postGlobal(
                      { action: "save_logo_position", kind: "logo", logo_position_x: logoPositionX, logo_position_y: logoPositionY },
                      "Posizione logo salvata",
                    );
                  }}
                >
                  <input type="hidden" name="action" value="save_logo_position" />
                  <input type="hidden" id="logoPositionX" name="logo_position_x" value={logoPositionX} readOnly />
                  <input type="hidden" id="logoPositionY" name="logo_position_y" value={logoPositionY} readOnly />
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    type="button"
                    data-branding-position-reset
                    data-x-input="logoPositionX"
                    data-y-input="logoPositionY"
                    onClick={() => {
                      setLogoPositionX("50");
                      setLogoPositionY("50");
                    }}
                  >
                    Centra
                  </button>
                  <button className="btn btn-primary btn-sm" type="submit">
                    <i className="bi bi-check2-circle me-1" />
                    Salva posizione
                  </button>
                </form>

                <div className={`text-muted small mb-3${withoutImage(hasLogo)}`} data-branding-empty="logo">Nessun logo caricato.</div>

                <label className={`form-label${withoutImage(hasLogo)}`} data-branding-visible-without-image="logo">Carica logo (JPG/PNG)</label>
                <div
                  className={`branding-dropzone${withoutImage(hasLogo)}${dragoverKind === "logo" ? " is-dragover" : ""}${uploadingKind === "logo" ? " is-disabled" : ""}`}
                  data-branding-uploader="logo"
                  data-branding-visible-without-image="logo"
                  role="button"
                  tabIndex={0}
                  onClick={() => logoFileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      logoFileInputRef.current?.click();
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragoverKind("logo");
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragoverKind("logo");
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragoverKind(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragoverKind(null);
                    selectBrandingFile("logo", e.dataTransfer?.files ?? null);
                  }}
                >
                  <div>
                    <div className="fw-semibold">Trascina qui il logo</div>
                    <div className="text-muted small">oppure clicca per selezionarlo (max 5 MB)</div>
                  </div>
                </div>
                <input
                  ref={logoFileInputRef}
                  className={`d-none${withoutImage(hasLogo)}`}
                  type="file"
                  data-branding-file-input="logo"
                  data-branding-visible-without-image="logo"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                  onChange={(e) => {
                    selectBrandingFile("logo", e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className={`form-text${withoutImage(hasLogo)}`} data-branding-visible-without-image="logo">
                  Suggerito: logo orizzontale. Viene ridimensionato se necessario.
                </div>
                {renderPendingList("logo", hasLogo)}
                <div className={`d-flex flex-wrap align-items-center gap-2 mt-2${withoutImage(hasLogo)}`} data-branding-visible-without-image="logo">
                  <button
                    className="btn btn-primary btn-pill"
                    type="button"
                    data-branding-save="logo"
                    disabled={!logoPending || uploadingKind === "logo"}
                    onClick={() => uploadBranding("logo")}
                  >
                    {uploadingKind === "logo" ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                        Salvataggio...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-upload me-1" />
                        Salva logo
                      </>
                    )}
                  </button>
                  <div className="form-text m-0" data-branding-selected="logo">
                    {logoPending ? `Logo pronto - ${formatFileSize(logoPending.file.size || 0)}` : "Nessun nuovo logo selezionato."}
                  </div>
                </div>

                <form
                  method="post"
                  encType="multipart/form-data"
                  className="branding-upload-form row g-3 align-items-end d-none"
                  aria-hidden="true"
                >
                  <input type="hidden" name="action" value="upload_logo" />
                  <div className="col-md-8">
                    <label className="form-label">Carica logo (JPG/PNG)</label>
                    <input className="form-control" type="file" name="business_logo" accept=".jpg,.jpeg,.png,image/jpeg,image/png" required />
                    <div className="form-text">Suggerito: logo orizzontale. Verrà ridimensionato se necessario.</div>
                  </div>
                  <div className="col-md-4 d-flex align-items-end">
                    <button className="btn btn-primary btn-pill w-100" type="submit">
                      <i className="bi bi-upload me-1" />
                      {hasLogo ? "Aggiorna" : "Carica"}
                    </button>
                  </div>
                </form>

                <form
                  method="post"
                  className={`mt-2${onImage(hasLogo)}`}
                  data-branding-visible-on-image="logo"
                  data-branding-delete-form="logo"
                  data-confirm="Rimuovere il logo?"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (window.confirm("Rimuovere il logo?")) deleteBranding("logo");
                  }}
                >
                  <input type="hidden" name="action" value="delete_logo" />
                  <button className="btn btn-outline-danger btn-pill" type="submit" disabled={deletingKind === "logo"}>
                    {deletingKind === "logo" ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                        Rimozione...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-trash3 me-1" />
                        Rimuovi logo
                      </>
                    )}
                  </button>
                </form>
              </div>

              <div className="col-lg-5">
                <div className="border rounded-3 bg-light p-3 h-100">
                  <div className="h6 fw-bold mb-2">Nota</div>
                  <div className="text-muted small">
                    Per una resa migliore nel booking e nelle email:
                    <ul className="mb-0">
                      <li>usa un logo con sfondo chiaro o trasparente</li>
                      <li>evita immagini troppo grandi (verranno compresse)</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="col-12">
                <hr className="my-1" />
              </div>

              <div className="col-12">
                <div className="h6 fw-bold mb-1">Immagine di copertina</div>
                <div className="text-muted small mb-3">
                  Immagine orizzontale per booking pubblico e schermate brandizzate. Il file viene salvato su filesystem; nel DB resta solo il percorso pubblico.
                </div>
                {renderKindFeedback("cover")}

                <div
                  className={`branding-position-preview branding-position-preview--cover mb-2${onImage(hasCover)}`}
                  data-branding-position-preview
                  data-branding-visible-on-image="cover"
                  data-x-input="coverPositionX"
                  data-y-input="coverPositionY"
                  {...bindDragHandlers("cover")}
                >
                  {hasCover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={coverUrl} alt="Immagine di copertina" style={{ objectPosition: `${clampPos(coverPositionX)}% ${clampPos(coverPositionY)}%` }} />
                  ) : null}
                </div>
                <div className={`small text-muted mb-3${onImage(hasCover)}`} data-branding-visible-on-image="cover">
                  JPG/PNG/WEBP &bull; Max 5 MB &bull; Consigliato 1920x900. Trascina l&apos;immagine per regolarne la posizione nel booking.
                </div>
                <div className={`text-muted small mb-3${withoutImage(hasCover)}`} data-branding-empty="cover">Nessuna immagine di copertina caricata.</div>

                <form
                  method="post"
                  className={`branding-position-form d-flex gap-2 flex-wrap mb-3${onImage(hasCover)}`}
                  data-branding-visible-on-image="cover"
                  onSubmit={(e) => {
                    e.preventDefault();
                    postGlobal(
                      { action: "save_cover_position", kind: "cover", cover_position_x: coverPositionX, cover_position_y: coverPositionY },
                      "Posizione copertina salvata",
                    );
                  }}
                >
                  <input type="hidden" name="action" value="save_cover_position" />
                  <input type="hidden" id="coverPositionX" name="cover_position_x" value={coverPositionX} readOnly />
                  <input type="hidden" id="coverPositionY" name="cover_position_y" value={coverPositionY} readOnly />
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    type="button"
                    data-branding-position-reset
                    data-x-input="coverPositionX"
                    data-y-input="coverPositionY"
                    onClick={() => {
                      setCoverPositionX("50");
                      setCoverPositionY("50");
                    }}
                  >
                    Centra
                  </button>
                  <button className="btn btn-primary btn-sm" type="submit">
                    <i className="bi bi-check2-circle me-1" />
                    Salva posizione
                  </button>
                </form>

                <label className={`form-label${withoutImage(hasCover)}`} data-branding-visible-without-image="cover">Carica copertina (JPG/PNG/WEBP)</label>
                <div
                  className={`branding-dropzone${withoutImage(hasCover)}${dragoverKind === "cover" ? " is-dragover" : ""}${uploadingKind === "cover" ? " is-disabled" : ""}`}
                  data-branding-uploader="cover"
                  data-branding-visible-without-image="cover"
                  role="button"
                  tabIndex={0}
                  onClick={() => coverFileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      coverFileInputRef.current?.click();
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragoverKind("cover");
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragoverKind("cover");
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragoverKind(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragoverKind(null);
                    selectBrandingFile("cover", e.dataTransfer?.files ?? null);
                  }}
                >
                  <div>
                    <div className="fw-semibold">Trascina qui la copertina</div>
                    <div className="text-muted small">oppure clicca per selezionarla (max 5 MB)</div>
                  </div>
                </div>
                <input
                  ref={coverFileInputRef}
                  className={`d-none${withoutImage(hasCover)}`}
                  type="file"
                  data-branding-file-input="cover"
                  data-branding-visible-without-image="cover"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  onChange={(e) => {
                    selectBrandingFile("cover", e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className={`form-text${withoutImage(hasCover)}`} data-branding-visible-without-image="cover">Max 5 MB. Verrà ridimensionata se necessario.</div>
                {renderPendingList("cover", hasCover)}
                <div className={`d-flex flex-wrap align-items-center gap-2 mt-2${withoutImage(hasCover)}`} data-branding-visible-without-image="cover">
                  <button
                    className="btn btn-primary btn-pill"
                    type="button"
                    data-branding-save="cover"
                    disabled={!coverPending || uploadingKind === "cover"}
                    onClick={() => uploadBranding("cover")}
                  >
                    {uploadingKind === "cover" ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                        Salvataggio...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-upload me-1" />
                        Salva copertina
                      </>
                    )}
                  </button>
                  <div className="form-text m-0" data-branding-selected="cover">
                    {coverPending ? `Copertina pronta - ${formatFileSize(coverPending.file.size || 0)}` : "Nessuna nuova copertina selezionata."}
                  </div>
                </div>

                <form
                  method="post"
                  encType="multipart/form-data"
                  className="branding-upload-form row g-3 align-items-end d-none"
                  aria-hidden="true"
                >
                  <input type="hidden" name="action" value="upload_cover" />
                  <div className="col-md-8">
                    <label className="form-label">Carica copertina (JPG/PNG/WEBP)</label>
                    <input
                      className="form-control"
                      type="file"
                      name="business_cover"
                      accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                      required
                    />
                    <div className="form-text">Max 5 MB. Verrà ridimensionata se necessario.</div>
                  </div>
                  <div className="col-md-4 d-flex align-items-end">
                    <button className="btn btn-primary btn-pill w-100" type="submit">
                      <i className="bi bi-upload me-1" />
                      {hasCover ? "Aggiorna" : "Carica"}
                    </button>
                  </div>
                </form>

                <form
                  method="post"
                  className={`mt-2${onImage(hasCover)}`}
                  data-branding-visible-on-image="cover"
                  data-branding-delete-form="cover"
                  data-confirm="Rimuovere l'immagine di copertina?"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (window.confirm("Rimuovere l'immagine di copertina?")) deleteBranding("cover");
                  }}
                >
                  <input type="hidden" name="action" value="delete_cover" />
                  <button className="btn btn-outline-danger btn-pill" type="submit" disabled={deletingKind === "cover"}>
                    {deletingKind === "cover" ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                        Rimozione...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-trash3 me-1" />
                        Rimuovi copertina
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
