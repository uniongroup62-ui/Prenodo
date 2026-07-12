// Shared chrome for the faithful PHP /manage auth pages (login, register,
// forgot/reset password). Reproduces app/pages/manage_account.php markup +
// loads the original auth CSS, and renders the right-hand visual card.
//
// The stylesheets are hoisted render-blocking via React's `precedence` support
// (they land in <head> in the SSR HTML, before first paint) and the page classes
// live on a wrapping <div> that is server-rendered — so there is NO flash of
// unstyled content. (Previously the CSS was injected + the body class set from a
// client useEffect, which only ran after the first paint → the FOUC.)

import { MODERN_MANAGE_AUTH_STYLE } from "@/components/public/modern-auth-style";

export function ManageAuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="account-page account-page--auth manage-page">
      <link rel="stylesheet" href="/assets/css/pages/public_account.css" precedence="default" />
      <link rel="stylesheet" href="/assets/css/pages/manage_account.css" precedence="default" />
      {/* Restyle moderno (scelta utente 2026-07-12): SOLO PELLE, pannello
          visual mantenuto — vedi modern-auth-style.ts */}
      <style dangerouslySetInnerHTML={{ __html: MODERN_MANAGE_AUTH_STYLE }} />

      <a className="auth-back" href="/login" aria-label="Torna alla scelta di accesso">
        &larr;
      </a>
      <main className="account-main account-main--auth-flow">
        <section className="auth-stack">
          <a className="auth-brand" href="/manage/login">
            <span className="brand-mark">P</span>
            <span>Prenodo</span>
          </a>
          {children}
        </section>
        <ManageAuthVisual />
      </main>
    </div>
  );
}

function ManageAuthVisual() {
  return (
    <aside className="visual-card manage-visual">
      <div className="visual-content">
        <div className="tenant-badge">P</div>
        <h2>Gestisci la tua attivita online</h2>
        <p>
          Crea il gestionale, configura sedi e operatori, abilita le prenotazioni e accedi al
          pannello da un unico punto.
        </p>
        <div className="visual-actions">
          <a className="is-light" href="/manage/register">
            Crea account
          </a>
          <a href="/attivita">Marketplace</a>
        </div>
      </div>
      <div className="product-device" aria-hidden="true">
        <div className="product-screen">
          <div className="product-sidebar">
            <span className="product-dot" />
            <span className="product-dot" />
            <span className="product-dot" />
            <span className="product-dot" />
            <span className="product-dot" />
          </div>
          <div className="product-area">
            <div className="product-top">
              <div className="product-title-lines">
                <span />
                <span />
              </div>
              <div className="product-kpi" />
            </div>
            <div className="product-grid">
              <div className="product-card is-tall">
                <span />
                <span />
                <span />
              </div>
              <div className="product-card">
                <span />
                <span />
                <span />
              </div>
              <div className="product-card">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
