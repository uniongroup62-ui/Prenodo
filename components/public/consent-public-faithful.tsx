"use client";

/*
 * ConsentPublicFaithful — port of app/pages/consent_public.php +
 * consent_public.js: pagina PUBBLICA (token 64 hex, no login) del modulo
 * consenso. Header con nome modulo + cliente + badge stato, card con
 * Apri/Scarica PDF, iframe di anteprima e — in stato pending — il riquadro
 * firma su canvas con "Pulisci firma" e "Conferma firma". Identica alla
 * gemella GDPR (gdpr-public-faithful) ma sul record del modulo consenso.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const CSS_LINKS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "/assets/css/pages/consent_public.css",
];

type ConsentView = {
  status: "pending" | "signed";
  statusLabel: string;
  statusBadge: string;
  statusIcon: string;
  moduleName: string;
  clientName: string;
  filename: string;
  requestedAt: string;
  signedAt: string;
};

export function ConsentPublicFaithful({ slug, token }: { slug: string; token: string }) {
  const [view, setView] = useState<ConsentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [pdfVersion, setPdfVersion] = useState(0); // ricarica l'iframe dopo la firma
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/public/consent?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) {
          setNotFound(String(j?.error || "Link non valido o documento non disponibile."));
          return;
        }
        setView(j as ConsentView);
      })
      .catch(() => setNotFound("Errore di rete durante il caricamento."))
      .finally(() => setLoading(false));
  }, [slug, token]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Firma su canvas (port di consent_public.js): pointer events. ---
  const canvasPos = (canvas: HTMLCanvasElement, e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || view?.status !== "pending") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const down = (e: PointerEvent) => {
      e.preventDefault();
      drawingRef.current = true;
      const { x, y } = canvasPos(canvas, e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      const { x, y } = canvasPos(canvas, e);
      ctx.lineTo(x, y);
      ctx.stroke();
      setHasSignature(true);
    };
    const up = () => {
      drawingRef.current = false;
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", up);
    };
  }, [view?.status]);

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }

  async function confirmSignature() {
    const canvas = canvasRef.current;
    if (!canvas || !hasSignature) {
      setErr("Inserisci la firma nel riquadro prima di confermare.");
      return;
    }
    setSubmitting(true);
    setErr("");
    setMsg("");
    try {
      const res = await fetch("/api/public/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, token, signature_data: canvas.toDataURL("image/png") }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setErr(String(j.error ?? "Si e verificato un problema tecnico durante il salvataggio del documento. Riprova tra poco."));
        return;
      }
      setMsg(String(j.message ?? "Documento firmato e confermato con successo."));
      setPdfVersion((v) => v + 1);
      load();
    } catch {
      setErr("Errore di rete durante il salvataggio.");
    } finally {
      setSubmitting(false);
    }
  }

  const pdfBase = `/api/public/consent?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}&format=pdf&v=${pdfVersion}`;

  return (
    <>
      {CSS_LINKS.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <div className="container py-4 consent-public-container" style={{ maxWidth: 980 }}>
        {loading ? (
          <div className="card p-4">
            <div className="d-flex align-items-center gap-2 text-muted">
              <span className="spinner-border spinner-border-sm" aria-hidden="true" />
              <span>Caricamento documento...</span>
            </div>
          </div>
        ) : null}

        {!loading && notFound ? (
          <div className="consent-public-not-found">
            <div className="alert alert-danger">{notFound}</div>
          </div>
        ) : null}

        {!loading && view ? (
          <>
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <div>
                <h1 className="h3 mb-1">{view.moduleName}</h1>
                <div className="text-muted">Cliente: {view.clientName}</div>
              </div>
              <span className={`badge text-bg-${view.statusBadge}`}>
                <i className={`bi ${view.statusIcon} me-1`} />
                {view.statusLabel}
              </span>
            </div>

            {msg ? <div className="alert alert-success">{msg}</div> : null}
            {err ? <div className="alert alert-danger">{err}</div> : null}

            <div className="card p-3 p-lg-4 mb-3">
              <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
                <div>
                  {view.status === "pending" ? (
                    <>
                      <div className="fw-semibold">Richiesta firma elettronica</div>
                      <div className="text-muted small">Controlla il documento qui sotto, firma direttamente nella pagina e poi premi Conferma.</div>
                      {view.requestedAt ? <div className="small text-muted mt-1">Richiesta inviata il {view.requestedAt}</div> : null}
                    </>
                  ) : (
                    <>
                      <div className="fw-semibold">Documento firmato</div>
                      <div className="text-muted small">Il documento ufficiale e disponibile per consultazione e download.</div>
                      {view.signedAt ? <div className="small text-muted mt-1">Firmato il {view.signedAt}</div> : null}
                    </>
                  )}
                </div>
                <div className="d-flex flex-wrap gap-2">
                  <a className="btn btn-outline-secondary" href={pdfBase} target="_blank" rel="noopener">
                    <i className="bi bi-eye me-1" />
                    Apri PDF
                  </a>
                  <a className="btn btn-outline-primary" href={`${pdfBase}&download=1`}>
                    <i className="bi bi-download me-1" />
                    Scarica PDF
                  </a>
                </div>
              </div>

              <iframe
                id="consentPdfPreview"
                className="consent-public-pdf-frame"
                title={view.filename}
                src={`${pdfBase}#view=FitH`}
                style={{ width: "100%", minHeight: 480, border: "1px solid #e2e8f0", borderRadius: 8 }}
              />

              {view.status === "pending" ? (
                <div className="mt-3" id="consentSignatureForm">
                  <div className="consent-signature-wrap mt-3">
                    <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
                      <div>
                        <div className="fw-semibold">Firma nel riquadro</div>
                        <div className="consent-signature-help small text-muted">
                          Disegna la firma con mouse, trackpad o dito. La firma verra aggiunta al PDF quando premi Conferma.
                        </div>
                      </div>
                      <button className="btn btn-outline-secondary btn-sm" type="button" id="consentSignatureClear" onClick={clearSignature}>
                        <i className="bi bi-eraser me-1" />
                        Pulisci firma
                      </button>
                    </div>
                    <canvas
                      ref={canvasRef}
                      id="consentSignatureCanvas"
                      className="consent-signature-canvas"
                      aria-label="Firma cliente"
                      width={900}
                      height={220}
                      style={{ width: "100%", maxWidth: "100%", height: "auto", border: "1px dashed #94a3b8", borderRadius: 8, touchAction: "none", background: "#fff", cursor: "crosshair" }}
                    />
                  </div>

                  <div className="d-grid gap-2 mt-3">
                    <button className="btn btn-primary" type="button" disabled={!hasSignature || submitting} onClick={confirmSignature}>
                      <i className="bi bi-check2-circle me-1" />
                      {submitting ? "Salvataggio..." : "Conferma firma"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
