import type { ReactNode } from "react";

// Box informativa unificata del gestionale (bonifica 2026-07-20): titolo
// UNICO "Come funziona" e aspetto unico (.bs-info-box in app.css) per tutte
// le ex box Suggerimento / Come funziona / *-info-box per-pagina.
export default function InfoBox({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bs-info-box${className ? ` ${className}` : ""}`}>
      <div className="bs-info-box__icon" aria-hidden="true">
        <i className="bi bi-info-circle" />
      </div>
      <div className="bs-info-box__body">
        <div className="bs-info-box__title">Come funziona</div>
        <div className="bs-info-box__content">{children}</div>
      </div>
    </div>
  );
}
