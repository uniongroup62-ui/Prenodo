"use client";

import { useEffect, useState, type ReactNode } from "react";

// Aiuto contestuale unificato del gestionale (evoluzione 2026-07-20): icona
// "i" accanto al titolo pagina che apre il popup "Come funziona" con il testo
// approfondito. Titolo e aspetto UNICI per tutte le pagine; stili
// .bs-info-trigger / .bs-info-modal-body in app.css. Nel body del popup usare
// <h6> per i titoletti di sezione, <p> e <ul> per il resto.
export default function InfoBox({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`bs-info-trigger${className ? ` ${className}` : ""}`}
        aria-label="Come funziona"
        title="Come funziona"
        onClick={() => setOpen(true)}
      >
        <i className="bi bi-info-lg" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="modal fade show d-block"
          role="dialog"
          aria-modal="true"
          aria-label="Come funziona"
          style={{ background: "rgba(15, 23, 42, 0.45)" }}
          onClick={() => setOpen(false)}
        >
          <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title d-flex align-items-center gap-2">
                  <span className="bs-info-trigger bs-info-trigger--static" aria-hidden="true">
                    <i className="bi bi-info-lg" />
                  </span>
                  Come funziona
                </h5>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setOpen(false)} />
              </div>
              <div className="modal-body bs-info-modal-body">{children}</div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
