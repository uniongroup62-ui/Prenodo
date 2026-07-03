"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Faithful port of the PHP business profile page (app/pages/business_profile.php):
// public profile name + "Chi siamo" text, logo branding (position + upload/delete)
// and cover branding (position + upload/delete). Fed by the existing DB-backed
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
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function BusinessProfileContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [business, setBusiness] = useState<Business | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);

  // Profile form (pre-filled from the API on mount).
  const [businessName, setBusinessName] = useState("");
  const [aboutText, setAboutText] = useState("");

  // Branding position fields (pre-filled from the API on mount).
  const [logoPositionX, setLogoPositionX] = useState("50");
  const [logoPositionY, setLogoPositionY] = useState("50");
  const [coverPositionX, setCoverPositionX] = useState("50");
  const [coverPositionY, setCoverPositionY] = useState("50");

  // Branding upload state: the chosen File enables the (otherwise disabled) Save
  // button and surfaces its name in the "selezionato" form-text. The hidden file
  // inputs stay verbatim; the visible .branding-dropzone proxies the click.
  const logoFileInputRef = useRef<HTMLInputElement | null>(null);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [uploadingKind, setUploadingKind] = useState<"logo" | "cover" | null>(null);

  const load = useCallback(() => {
    fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: BusinessSettings) => {
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
      })
      .catch(() => {
        setBusiness(null);
        setBranding(null);
      });
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function postAction(payload: Record<string, unknown>): Promise<void> {
    setFeedback(null);
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? "Errore.") });
        return;
      }
      setFeedback({ type: "success", text: String(j?.message ?? "Operazione completata.") });
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    }
  }

  // Upload a chosen logo/cover via multipart/form-data — matches the route's
  // `upload_logo`/`upload_cover` branch (file under business_logo/business_cover,
  // plus action + kind). On success refresh the preview and clear the selection.
  async function uploadBranding(kind: "logo" | "cover"): Promise<void> {
    const file = kind === "logo" ? logoFile : coverFile;
    if (!file) return;
    setFeedback(null);
    setUploadingKind(kind);
    try {
      const form = new FormData();
      form.append("action", kind === "logo" ? "upload_logo" : "upload_cover");
      form.append("kind", kind);
      form.append(kind === "logo" ? "business_logo" : "business_cover", file);
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "x-tenant-slug": slug },
        body: form,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? "Errore.") });
        return;
      }
      setFeedback({ type: "success", text: String(j?.message ?? (kind === "logo" ? "Logo caricato." : "Copertina caricata.")) });
      if (kind === "logo") {
        setLogoFile(null);
        if (logoFileInputRef.current) logoFileInputRef.current.value = "";
      } else {
        setCoverFile(null);
        if (coverFileInputRef.current) coverFileInputRef.current.value = "";
      }
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    } finally {
      setUploadingKind(null);
    }
  }

  const logoUrl = branding?.logoUrl || business?.logoUrl || "";
  const coverUrl = branding?.coverUrl || business?.coverUrl || "";
  const hasLogo = Boolean(logoUrl);
  const hasCover = Boolean(coverUrl);

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Profilo attivita</h1>
          <div className="bs-page-subtitle">Gestisci profilo pubblico, logo, copertina e dati mostrati nel booking.</div>
        </div>
      </div>

      <link rel="stylesheet" href="/assets/css/pages/business_profile.css" />

      {feedback ? (
        <div className={`alert alert-${feedback.type} mt-3`} role="alert">
          {feedback.text}
        </div>
      ) : null}

      <div className="row g-3 mt-3">
        <div className="col-12">
          <div className="card p-4">
            <form
              method="post"
              className="branding-upload-form row g-3 align-items-end mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                postAction({ action: "save_profile_activity", business_name: businessName, booking_about_text: aboutText });
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
                <div className="form-text">Verra visualizzato nel booking pubblico sotto al logo.</div>
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
                <div className="form-text">Verra mostrato nel booking pubblico in una sezione dedicata sopra la gallery.</div>
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
                <div className="h6 fw-bold mb-2">Logo attivita</div>
                <div className="text-muted small mb-3">
                  Il logo verra mostrato nel <strong>booking pubblico</strong> e nelle <strong>email automatiche</strong>.
                </div>

                <div className="alert d-none branding-feedback mb-3" data-branding-feedback="logo" role="alert" aria-live="polite" />
                <div
                  className={`d-flex align-items-center gap-3 flex-wrap mb-3${hasLogo ? "" : " branding-image-hidden"}`}
                  data-branding-visible-on-image="logo"
                >
                  <div
                    className="branding-position-preview branding-position-preview--logo"
                    data-branding-position-preview
                    data-x-input="logoPositionX"
                    data-y-input="logoPositionY"
                    style={
                      hasLogo
                        ? {
                            backgroundImage: `url("${logoUrl}")`,
                            backgroundPosition: `${logoPositionX}% ${logoPositionY}%`,
                          }
                        : undefined
                    }
                  />
                  <div className="small text-muted">
                    Formati: JPG/PNG &bull; Max 5 MB<br />
                    Trascina l&apos;anteprima per regolare la posizione del logo nel booking.
                  </div>
                </div>

                <form
                  method="post"
                  className={`branding-position-form d-flex gap-2 flex-wrap mb-3${hasLogo ? "" : " branding-image-hidden"}`}
                  data-branding-visible-on-image="logo"
                  onSubmit={(e) => {
                    e.preventDefault();
                    postAction({ action: "save_logo_position", kind: "logo", logo_position_x: logoPositionX, logo_position_y: logoPositionY });
                  }}
                >
                  <input type="hidden" name="action" value="save_logo_position" />
                  <input
                    type="hidden"
                    id="logoPositionX"
                    name="logo_position_x"
                    value={logoPositionX}
                    onChange={(e) => setLogoPositionX(e.target.value)}
                  />
                  <input
                    type="hidden"
                    id="logoPositionY"
                    name="logo_position_y"
                    value={logoPositionY}
                    onChange={(e) => setLogoPositionY(e.target.value)}
                  />
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

                {!hasLogo ? (
                  <div className="text-muted small mb-3" data-branding-empty="logo">Nessun logo caricato.</div>
                ) : null}

                <label className="form-label" data-branding-visible-without-image="logo">Carica logo (JPG/PNG)</label>
                <div
                  className="branding-dropzone"
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
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0] ?? null;
                    if (file) setLogoFile(file);
                  }}
                >
                  <div>
                    <div className="fw-semibold">Trascina qui il logo</div>
                    <div className="text-muted small">oppure clicca per selezionarlo (max 5 MB)</div>
                  </div>
                </div>
                <input
                  ref={logoFileInputRef}
                  className="d-none"
                  type="file"
                  data-branding-file-input="logo"
                  data-branding-visible-without-image="logo"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                  onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                />
                <div className="form-text" data-branding-visible-without-image="logo">
                  Suggerito: logo orizzontale. Viene ridimensionato se necessario.
                </div>
                <div className="branding-upload-list" data-branding-upload-list="logo" data-branding-visible-without-image="logo" />
                <div className="d-flex flex-wrap align-items-center gap-2 mt-2" data-branding-visible-without-image="logo">
                  <button
                    className="btn btn-primary btn-pill"
                    type="button"
                    data-branding-save="logo"
                    disabled={!logoFile || uploadingKind === "logo"}
                    onClick={() => uploadBranding("logo")}
                  >
                    <i className="bi bi-upload me-1" />
                    Salva logo
                  </button>
                  <div className="form-text m-0" data-branding-selected="logo">
                    {logoFile ? logoFile.name : "Nessun nuovo logo selezionato."}
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
                    <div className="form-text">Suggerito: logo orizzontale. Verra ridimensionato se necessario.</div>
                  </div>
                  <div className="col-md-4 d-flex align-items-end">
                    <button className="btn btn-primary btn-pill w-100" type="submit">
                      <i className="bi bi-upload me-1" />
                      Carica
                    </button>
                  </div>
                </form>

                <form
                  method="post"
                  className={`mt-2${hasLogo ? "" : " branding-image-hidden"}`}
                  data-branding-visible-on-image="logo"
                  data-branding-delete-form="logo"
                  data-confirm="Rimuovere il logo?"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (window.confirm("Rimuovere il logo?")) postAction({ action: "delete_logo", kind: "logo" });
                  }}
                >
                  <input type="hidden" name="action" value="delete_logo" />
                  <button className="btn btn-outline-danger btn-pill" type="submit">
                    <i className="bi bi-trash3 me-1" />
                    Rimuovi logo
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
                <div className="alert d-none branding-feedback mb-3" data-branding-feedback="cover" role="alert" aria-live="polite" />

                <div
                  className={`branding-position-preview branding-position-preview--cover mb-2${hasCover ? "" : " branding-image-hidden"}`}
                  data-branding-position-preview
                  data-branding-visible-on-image="cover"
                  data-x-input="coverPositionX"
                  data-y-input="coverPositionY"
                  style={
                    hasCover
                      ? {
                          backgroundImage: `url("${coverUrl}")`,
                          backgroundPosition: `${coverPositionX}% ${coverPositionY}%`,
                        }
                      : undefined
                  }
                />
                <div className={`small text-muted mb-3${hasCover ? "" : " branding-image-hidden"}`} data-branding-visible-on-image="cover">
                  JPG/PNG/WEBP &bull; Max 5 MB &bull; Consigliato 1920x900. Trascina l&apos;immagine per regolarne la posizione nel booking.
                </div>
                {!hasCover ? (
                  <div className="text-muted small mb-3" data-branding-empty="cover">Nessuna immagine di copertina caricata.</div>
                ) : null}

                <form
                  method="post"
                  className={`branding-position-form d-flex gap-2 flex-wrap mb-3${hasCover ? "" : " branding-image-hidden"}`}
                  data-branding-visible-on-image="cover"
                  onSubmit={(e) => {
                    e.preventDefault();
                    postAction({ action: "save_cover_position", kind: "cover", cover_position_x: coverPositionX, cover_position_y: coverPositionY });
                  }}
                >
                  <input type="hidden" name="action" value="save_cover_position" />
                  <input
                    type="hidden"
                    id="coverPositionX"
                    name="cover_position_x"
                    value={coverPositionX}
                    onChange={(e) => setCoverPositionX(e.target.value)}
                  />
                  <input
                    type="hidden"
                    id="coverPositionY"
                    name="cover_position_y"
                    value={coverPositionY}
                    onChange={(e) => setCoverPositionY(e.target.value)}
                  />
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

                <label className="form-label" data-branding-visible-without-image="cover">Carica copertina (JPG/PNG/WEBP)</label>
                <div
                  className="branding-dropzone"
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
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0] ?? null;
                    if (file) setCoverFile(file);
                  }}
                >
                  <div>
                    <div className="fw-semibold">Trascina qui la copertina</div>
                    <div className="text-muted small">oppure clicca per selezionarla (max 5 MB)</div>
                  </div>
                </div>
                <input
                  ref={coverFileInputRef}
                  className="d-none"
                  type="file"
                  data-branding-file-input="cover"
                  data-branding-visible-without-image="cover"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
                />
                <div className="form-text" data-branding-visible-without-image="cover">Max 5 MB. Verra ridimensionata se necessario.</div>
                <div className="branding-upload-list" data-branding-upload-list="cover" data-branding-visible-without-image="cover" />
                <div className="d-flex flex-wrap align-items-center gap-2 mt-2" data-branding-visible-without-image="cover">
                  <button
                    className="btn btn-primary btn-pill"
                    type="button"
                    data-branding-save="cover"
                    disabled={!coverFile || uploadingKind === "cover"}
                    onClick={() => uploadBranding("cover")}
                  >
                    <i className="bi bi-upload me-1" />
                    Salva copertina
                  </button>
                  <div className="form-text m-0" data-branding-selected="cover">
                    {coverFile ? coverFile.name : "Nessuna nuova copertina selezionata."}
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
                    <div className="form-text">Max 5 MB. Verra ridimensionata se necessario.</div>
                  </div>
                  <div className="col-md-4 d-flex align-items-end">
                    <button className="btn btn-primary btn-pill w-100" type="submit">
                      <i className="bi bi-upload me-1" />
                      Carica
                    </button>
                  </div>
                </form>

                <form
                  method="post"
                  className={`mt-2${hasCover ? "" : " branding-image-hidden"}`}
                  data-branding-visible-on-image="cover"
                  data-branding-delete-form="cover"
                  data-confirm="Rimuovere l'immagine di copertina?"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (window.confirm("Rimuovere l'immagine di copertina?")) postAction({ action: "delete_cover", kind: "cover" });
                  }}
                >
                  <input type="hidden" name="action" value="delete_cover" />
                  <button className="btn btn-outline-danger btn-pill" type="submit">
                    <i className="bi bi-trash3 me-1" />
                    Rimuovi copertina
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
