"use client";

import { FormEvent, useEffect, useState } from "react";
import { useMarketplacePageEffects } from "@/components/public/marketplace-shared";
import { accountAuthDestination } from "@/components/public/account-auth-destination";
import { MODERN_CUSTOMER_PHOTO_AUTH_STYLE } from "@/components/public/modern-auth-style";

// Pixel-faithful port of the legacy PHP public CUSTOMER ACCOUNT register page
// served at http://localhost/account/register (public_customer_accounts /
// booking_users registration — NOT the gestionale /manage signup).
//
// Markup is reproduced VERBATIM from the captured PHP output, keeping the
// original class names + Bootstrap-icon markup: the marketplace account
// topbar/brand, the auth card (eyebrow, heading, lead, register form with its
// exact field names, submit button) and the "Hai gia un account?" link, plus
// the right-hand visual card. Styling comes from /assets/css/app.css and
// /assets/css/pages/public_account.css, with the inline <head><style> topbar
// rules captured from the PHP page reproduced verbatim below.
//
// The register form is wired to the existing /api/account endpoint via fetch
// (JSON, action:"register") instead of the legacy form POST. The legacy hidden
// _csrf field is dropped. On success the PHP issues a verification code and
// routes to the verify step, so we redirect to /account/verify carrying the
// account context, matching the PHP next-step flow.

// Inline <head><style> block captured verbatim from the PHP page. Scopes the
// marketplace topbar (search picker chrome) used at the top of the page.
const TOPBAR_STYLE = `
.marketplace-topbar{--marketplace-topbar-brand:#0f766e;--marketplace-topbar-brand-dark:#0a5b54;--marketplace-topbar-ink:#0f172a;--marketplace-topbar-muted:#64748b;--marketplace-topbar-line:#dbe3ef;--marketplace-topbar-soft:#e7f3f1;--marketplace-topbar-pad:clamp(18px,5vw,72px);--marketplace-topbar-max:none;--marketplace-topbar-search-width:900px;--marketplace-topbar-search-reserve:560px;height:68px;background:#fff;border-bottom:1px solid var(--marketplace-topbar-line);padding:0 var(--marketplace-topbar-pad);position:sticky;top:0;z-index:30;color:var(--marketplace-topbar-ink)}
.marketplace-topbar__inner{position:relative;width:100%;max-width:var(--marketplace-topbar-max);height:100%;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px}
.marketplace-topbar__brand{height:68px;display:flex;gap:12px;align-items:center;justify-self:start;padding:0;background:transparent;color:inherit;text-decoration:none;font-size:18px;line-height:1;font-weight:600;min-width:0}
.marketplace-topbar__brand:hover,.marketplace-topbar__brand:focus,.marketplace-topbar__brand:active,.marketplace-topbar__brand:visited{background:transparent;color:inherit;text-decoration:none;box-shadow:none}
.marketplace-topbar__brand:focus-visible{outline:2px solid rgba(15,118,110,.34);outline-offset:4px;border-radius:12px}
.marketplace-topbar__brand:hover .marketplace-topbar__brand-mark,.marketplace-topbar__brand:focus .marketplace-topbar__brand-mark,.marketplace-topbar__brand:active .marketplace-topbar__brand-mark{background:var(--marketplace-topbar-brand);color:#fff}
.marketplace-topbar__brand-mark{width:34px;height:34px;border-radius:10px;background:var(--marketplace-topbar-brand);color:#fff;display:grid;place-items:center;font-weight:600}
.marketplace-topbar-search{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);justify-self:center;align-self:center;width:min(var(--marketplace-topbar-search-width),calc(100% - var(--marketplace-topbar-search-reserve)));height:52px;border:1px solid var(--marketplace-topbar-line);border-radius:999px;background:#fff;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 56px;align-items:center;overflow:visible;box-shadow:none}
.marketplace-topbar-search__field{height:100%;display:grid;align-content:center;gap:2px;padding:0 18px;min-width:0}
.marketplace-topbar-search__field + .marketplace-topbar-search__field{border-left:1px solid var(--marketplace-topbar-line)}
.marketplace-topbar-search__field span{font-size:11px;line-height:1;text-transform:uppercase;color:var(--marketplace-topbar-muted);font-weight:600;letter-spacing:.08em}
.marketplace-topbar-search__field input{width:100%;min-width:0;height:auto;border:0;border-radius:0;background:transparent;padding:0;color:#94a3b8;font:inherit;font-size:14px;font-weight:600;line-height:1.2;outline:0;box-shadow:none;appearance:none}
.marketplace-topbar-search__field input::placeholder{color:#94a3b8;opacity:1;font-weight:600}
.marketplace-topbar-treatment-field{position:relative}
.marketplace-topbar-treatment-field input[type="hidden"]{display:none}
.marketplace-topbar-treatment-trigger{width:100%;min-width:0;border:0;border-radius:0;background:transparent;color:#94a3b8;padding:0;text-align:left;font:inherit;font-size:14px;font-weight:600;line-height:1.2;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer}
.marketplace-topbar-treatment-trigger:focus-visible{outline:2px solid rgba(15,118,110,.35);outline-offset:4px;border-radius:8px}
.marketplace-topbar-treatment-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none!important;letter-spacing:0!important;color:#94a3b8!important;font-size:14px!important;font-weight:600!important;line-height:1.2!important}
.marketplace-topbar-treatment-chevron{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.marketplace-topbar-treatment-panel{position:absolute;left:0;top:calc(100% + 8px);z-index:90;width:min(430px,calc(100vw - 32px));max-height:460px;overflow:hidden;border:1px solid var(--marketplace-topbar-line,#dbe3ef);border-radius:18px;background:#fff;padding:10px;box-shadow:0 22px 54px rgba(15,23,42,.16);display:flex;flex-direction:column;gap:8px}
.marketplace-topbar-treatment-panel[hidden]{display:none}
.marketplace-topbar-treatment-tabs{display:flex;align-items:center;gap:6px;padding:2px}
.marketplace-topbar-treatment-tab{min-height:34px;border:1px solid var(--marketplace-topbar-line,#dbe3ef);border-radius:999px;background:#fff;color:var(--marketplace-topbar-ink,#0f172a);padding:0 13px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.marketplace-topbar-treatment-tab.is-active{background:#0f172a;border-color:#0f172a;color:#fff;box-shadow:0 8px 18px rgba(15,23,42,.14)}
.marketplace-topbar-treatment-field .marketplace-topbar-treatment-search{display:block;width:100%;min-width:0;height:40px;border:0;border-radius:14px;background:#f6f8fb;color:var(--marketplace-topbar-ink,#0f172a);padding:0 14px;font:inherit;font-size:14px;font-weight:600;line-height:40px;outline:0;box-shadow:none;appearance:none}
.marketplace-topbar-treatment-field .marketplace-topbar-treatment-search[hidden]{display:none}
.marketplace-topbar-treatment-field .marketplace-topbar-treatment-search::placeholder{color:var(--marketplace-topbar-muted,#64748b);opacity:1;font-weight:600}
.marketplace-topbar-treatment-field .marketplace-topbar-treatment-search:focus{background:#f6f8fb;box-shadow:0 0 0 3px rgba(15,118,110,.12)}
.marketplace-topbar-treatment-lists{min-height:0;overflow:hidden}
.marketplace-topbar-treatment-list{display:grid;gap:4px;max-height:320px;overflow:auto;padding-right:2px}
.marketplace-topbar-treatment-list[hidden]{display:none}
.marketplace-topbar-treatment-option{width:100%;min-height:52px;border:0;border-radius:14px;background:#fff;color:var(--marketplace-topbar-ink,#0f172a);padding:8px 10px;text-align:left;font:inherit;font-size:14px;font-weight:600;display:flex;align-items:center;gap:12px;cursor:pointer}
.marketplace-topbar-treatment-option:hover,.marketplace-topbar-treatment-option.is-active,.marketplace-topbar-treatment-option.is-highlighted{background:var(--marketplace-topbar-soft,#e7f3f1);color:var(--marketplace-topbar-brand,#0f766e)}
.marketplace-topbar-treatment-icon,.marketplace-topbar-treatment-avatar{width:34px;height:34px;border-radius:50%;background:#f1efff;color:#6d5dfc;display:grid;place-items:center;flex:0 0 auto;font-size:14px;font-weight:800}
.marketplace-topbar-treatment-option.is-active .marketplace-topbar-treatment-icon,.marketplace-topbar-treatment-option.is-active .marketplace-topbar-treatment-avatar{background:#dcefeb;color:var(--marketplace-topbar-brand,#0f766e)}
.marketplace-topbar-treatment-icon svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.marketplace-topbar-treatment-icon .bi{display:block;font-size:18px;line-height:1}
.marketplace-topbar-treatment-copy{min-width:0;display:grid;gap:2px}
.marketplace-topbar-treatment-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none!important;letter-spacing:0!important;color:inherit!important;font-size:14px!important;font-weight:600!important;line-height:1.25!important}
.marketplace-topbar-treatment-meta{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none!important;letter-spacing:0!important;color:var(--marketplace-topbar-muted,#64748b)!important;font-size:12px!important;font-weight:600!important;line-height:1.2!important}
.marketplace-topbar-treatment-empty{display:none;padding:14px 10px;color:var(--marketplace-topbar-muted,#64748b);font-size:13px;font-weight:600}
.marketplace-topbar-treatment-empty.is-visible{display:block}
.marketplace-topbar-search > button[type="submit"]{justify-self:end;align-self:center;width:40px;height:40px;margin-right:6px;border:0;border-radius:50%;background:#0f766e;color:#fff;display:grid;place-items:center;cursor:pointer}
.marketplace-topbar-search > button[type="submit"] svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.marketplace-topbar-city-suggestions{position:absolute;left:calc((100% - 56px) / 2 + 8px);right:64px;top:calc(100% + 8px);z-index:80;display:grid;gap:2px;max-height:248px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--marketplace-topbar-line);border-radius:14px;background:#fff;padding:6px;box-shadow:0 18px 42px rgba(15,23,42,.16)}
.marketplace-topbar-city-suggestions[hidden]{display:none}
.marketplace-topbar-search .marketplace-topbar-city-suggestion{width:100%;min-height:38px;border:0;border-radius:10px;background:transparent;color:var(--marketplace-topbar-ink);padding:10px 12px;text-align:left;font:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer;display:block}
.marketplace-topbar-search .marketplace-topbar-city-suggestion:hover,.marketplace-topbar-search .marketplace-topbar-city-suggestion.is-active{background:var(--marketplace-topbar-soft);color:var(--marketplace-topbar-brand)}
.marketplace-topbar__actions,.marketplace-topbar .header-actions,.marketplace-topbar .booking-marketplace-actions{display:flex;gap:10px;align-items:center;justify-self:end;min-width:0}
@media (max-width:900px){.marketplace-topbar{position:static;height:auto;min-height:68px;padding-top:12px;padding-bottom:12px}.marketplace-topbar__inner{height:auto;display:flex;flex-wrap:wrap;gap:12px}.marketplace-topbar__brand{height:auto;padding:0;background:transparent}.marketplace-topbar-search{position:static;left:auto;top:auto;transform:none;order:3;flex:1 1 100%;width:auto;max-width:none}.marketplace-topbar__actions,.marketplace-topbar .header-actions,.marketplace-topbar .booking-marketplace-actions{flex-wrap:wrap;margin-left:auto}}
@media (max-width:560px){.marketplace-topbar-search{grid-template-columns:1fr 38px;height:auto;border-radius:18px}.marketplace-topbar-search__field + .marketplace-topbar-search__field{border-left:0;border-top:1px solid var(--marketplace-topbar-line)}.marketplace-topbar-search__field:nth-child(2){grid-column:1/2}.marketplace-topbar-search > button[type="submit"]{grid-column:2;grid-row:1/3;width:38px;height:38px;margin-right:5px}.marketplace-topbar-city-suggestions{left:0;right:46px}}
`;

type AccountResponse = {
  ok: boolean;
  error?: string;
  requiresVerification?: boolean;
  accountId?: number;
  email?: string;
};

export function AccountRegisterFaithful() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The PHP page carries the post-auth destination through `next`/`return`
  // query params. Read them on the client and fall back to the PHP defaults.
  const [nextTarget, setNextTarget] = useState("start");
  const [returnTarget, setReturnTarget] = useState("/attivita");
  const [tenant, setTenant] = useState("");
  const [locationId, setLocationId] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setNextTarget(params.get("next") ?? "start");
    setReturnTarget(params.get("return") ?? "/attivita");
    setTenant(params.get("tenant") ?? "");
    setLocationId(params.get("location_id") ?? "");
    // Legacy (public_account.php 213): GET register da GIÀ loggato ->
    // redirect immediato alla destinazione post-auth (niente form).
    fetch("/api/account")
      .then((r) => r.json())
      .then((j: { ok?: boolean; user?: { email?: string } | null }) => {
        if (j?.ok && j.user?.email) {
          window.location.replace(
            accountAuthDestination(params.get("tenant") ?? "", params.get("next") ?? "start", params.get("return") ?? "/attivita", params.get("location_id") ?? ""),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const firstName = String(data.get("first_name") ?? "").trim();
    const lastName = String(data.get("last_name") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const password2 = String(data.get("password2") ?? "");

    if (password !== password2) {
      setError("Le password non coincidono.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "register",
          first_name: firstName,
          last_name: lastName,
          phone,
          email,
          password,
          password_confirm: password2,
        }),
      });
      const result = (await response.json()) as AccountResponse;
      if (!result.ok) {
        setError(result.error || "Registrazione non riuscita.");
        return;
      }
      // PHP issues a verification code and routes to the verify step. Carry the
      // account context the same way the login next-step flow does.
      const verifyParams = new URLSearchParams();
      if (result.accountId) verifyParams.set("account_id", String(result.accountId));
      if (result.email) verifyParams.set("email", result.email);
      if (tenant) verifyParams.set("tenant", tenant);
      if (nextTarget) verifyParams.set("next", nextTarget);
      if (returnTarget) verifyParams.set("return", returnTarget);
      if (locationId) verifyParams.set("location_id", locationId);
      const query = verifyParams.toString();
      window.location.href = `/account/verify${query ? `?${query}` : ""}`;
    } catch {
      setError("Operazione non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  // Preserve the PHP query string (next/return) on the "Accedi" link.
  const linkQuery = (() => {
    const params = new URLSearchParams();
    if (nextTarget) params.set("next", nextTarget);
    if (returnTarget) params.set("return", returnTarget);
    const query = params.toString();
    return query ? `?${query}` : "";
  })();

  // Cabla il picker della topbar (categorie/attività/città) come le altre
  // pagine marketplace.
  useMarketplacePageEffects([]);

  return (
    <>
      <link rel="stylesheet" href="/assets/css/app.css" />
      <link rel="stylesheet" href="/assets/css/pages/public_account.css" />
      <style dangerouslySetInnerHTML={{ __html: TOPBAR_STYLE }} />
      {/* Restyle "photo split" (scelta utente 2026-07-12, riferimento Nucleus):
          SOLO PELLE, vedi modern-auth-style.ts */}
      <style dangerouslySetInnerHTML={{ __html: MODERN_CUSTOMER_PHOTO_AUTH_STYLE }} />

      <div className="account-page account-page--auth">
        <div className="auth-photo-panel" aria-hidden="true">
          <div className="auth-photo-quote">
            <p>&ldquo;Prenotare i miei trattamenti non &egrave; mai stato cos&igrave; semplice.&rdquo;</p>
            <small>Cliente Prenodo</small>
            <small>Prenotazioni online, punti e vantaggi in un unico posto</small>
          </div>
        </div>
        <a className="auth-back" href="/login" aria-label="Torna alla scelta di accesso" title="Torna alla scelta di accesso">
          &larr;
        </a>
        <header
          className="marketplace-topbar marketplace-topbar--with-search"
          style={
            {
              "--marketplace-topbar-pad": "var(--marketplace-page-pad)",
              "--marketplace-topbar-max": "var(--marketplace-page-max)",
              "--marketplace-topbar-search-width": "720px",
              "--marketplace-topbar-search-reserve": "760px",
            } as React.CSSProperties
          }
        >
          <div className="marketplace-topbar__inner">
            <a className="marketplace-topbar__brand" href="/attivita">
              <span className="marketplace-topbar__brand-mark">P</span>
              <span>Prenodo</span>
            </a>
            <form
              className="marketplace-topbar-search"
              method="get"
              action="/attivita/ricerca"
              role="search"
              aria-label="Cerca attività"
              data-marketplace-topbar-search
            >
              <div
                className="marketplace-topbar-search__field marketplace-topbar-treatment-field"
                data-marketplace-treatment-picker
              >
                <span className="marketplace-topbar-treatment-kicker">Attività o servizio</span>
                <input type="hidden" name="q" defaultValue="" data-marketplace-treatment-query />
                <input type="hidden" name="category" defaultValue="" data-marketplace-treatment-category />
                <input type="hidden" name="service" defaultValue="" data-marketplace-treatment-service />
                <button
                  className="marketplace-topbar-treatment-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-controls="account-topbar-treatment-panel"
                  data-marketplace-treatment-trigger
                >
                  <span className="marketplace-topbar-treatment-label" data-marketplace-treatment-label>
                    Tutte le attivita
                  </span>
                  <svg className="marketplace-topbar-treatment-chevron" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 9 6 6 6-6"></path>
                  </svg>
                </button>
                <div
                  className="marketplace-topbar-treatment-panel"
                  id="account-topbar-treatment-panel"
                  hidden
                  data-marketplace-treatment-panel
                >
                  <div className="marketplace-topbar-treatment-tabs" role="tablist" aria-label="Tipo ricerca">
                    <button
                      className="marketplace-topbar-treatment-tab is-active"
                      type="button"
                      role="tab"
                      aria-selected="true"
                      data-marketplace-treatment-tab="categories"
                    >
                      Categorie
                    </button>
                    <button
                      className="marketplace-topbar-treatment-tab"
                      type="button"
                      role="tab"
                      aria-selected="false"
                      data-marketplace-treatment-tab="salons"
                    >
                      Attività
                    </button>
                    <button
                      className="marketplace-topbar-treatment-tab"
                      type="button"
                      role="tab"
                      aria-selected="false"
                      data-marketplace-treatment-tab="services"
                    >
                      Servizi
                    </button>
                  </div>
                  <input
                    className="marketplace-topbar-treatment-search"
                    type="search"
                    placeholder="Cerca..."
                    autoComplete="off"
                    aria-label="Cerca nel menu"
                    data-marketplace-treatment-filter
                    hidden
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <div className="marketplace-topbar-treatment-lists">
                    <div
                      className="marketplace-topbar-treatment-list"
                      role="listbox"
                      aria-label="Categorie"
                      data-marketplace-treatment-list="categories"
                    >
                      <button
                        className="marketplace-topbar-treatment-option is-active"
                        type="button"
                        role="option"
                        aria-selected="true"
                        data-marketplace-treatment-option
                        data-treatment-category=""
                        data-treatment-query=""
                        data-treatment-service=""
                        data-treatment-label="Tutte le attivita"
                        data-treatment-search="tutte attivita tutti servizi"
                      >
                        <span className="marketplace-topbar-treatment-icon">
                          <i className="bi bi-stars" aria-hidden="true"></i>
                        </span>
                        <span className="marketplace-topbar-treatment-copy">
                          <span className="marketplace-topbar-treatment-name">Tutte le attivita</span>
                        </span>
                      </button>
                    </div>
                    <div
                      className="marketplace-topbar-treatment-list"
                      role="listbox"
                      aria-label="Attività"
                      data-marketplace-treatment-list="salons"
                      hidden
                    ></div>
                    <div
                      className="marketplace-topbar-treatment-list"
                      role="listbox"
                      aria-label="Servizi"
                      data-marketplace-treatment-list="services"
                      hidden
                    ></div>
                  </div>
                  <div className="marketplace-topbar-treatment-empty" data-marketplace-treatment-empty>
                    Nessun risultato.
                  </div>
                </div>
              </div>
              <label className="marketplace-topbar-search__field" htmlFor="account-topbar-city">
                <span>Dove</span>
                <input
                  id="account-topbar-city"
                  type="search"
                  name="city"
                  defaultValue=""
                  placeholder="La tua città"
                  autoComplete="off"
                  data-marketplace-topbar-city-input
                />
              </label>
              <button type="submit" aria-label="Cerca">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7"></circle>
                  <path d="m16 16 4 4"></path>
                </svg>
              </button>
              <div
                className="marketplace-topbar-city-suggestions"
                role="listbox"
                aria-label="Città suggerite"
                hidden
                data-marketplace-topbar-city-suggestions
              ></div>
            </form>
            <nav className="header-actions"></nav>
          </div>
        </header>

        <main className="account-main account-main--auth-flow">
          <div className="auth-stack">
            <a className="auth-brand" href="/attivita">
              <span className="brand-mark">P</span>
              <span>Prenodo</span>
            </a>
            <section className="auth-card">
              <p className="eyebrow">Account cliente</p>
              <h1>Registrati</h1>
              <p className="lead">Crea un account unico per prenotare nelle attività pubblicate nel marketplace.</p>

              {error ? <div className="alert">{error}</div> : null}

              <form className="form" method="post" action="/api/account" onSubmit={handleSubmit}>
                <input type="hidden" name="action" value="register" />
                <input type="hidden" name="tenant" value={tenant} />
                <input type="hidden" name="next" value={nextTarget} />
                <input type="hidden" name="return" value={returnTarget} />
                <input type="hidden" name="location_id" value={locationId} />
                <div className="grid-2">
                  <label>
                    Nome <input name="first_name" autoComplete="given-name" required defaultValue="" />
                  </label>
                  <label>
                    Cognome <input name="last_name" autoComplete="family-name" required defaultValue="" />
                  </label>
                </div>
                <div className="grid-2">
                  <label>
                    Telefono <input name="phone" autoComplete="tel" defaultValue="" />
                  </label>
                  <label>
                    Email <input type="email" name="email" autoComplete="email" required defaultValue="" />
                  </label>
                </div>
                <div className="grid-2">
                  <label>
                    Password <input type="password" name="password" autoComplete="new-password" required minLength={6} />
                  </label>
                  <label>
                    Conferma password{" "}
                    <input type="password" name="password2" autoComplete="new-password" required minLength={6} />
                  </label>
                </div>
                <button className="auth-submit" type="submit" disabled={busy}>
                  {busy ? "Creazione in corso…" : "Crea account"}
                </button>
              </form>
              <div className="links">
                Hai gi&agrave; un account?&nbsp;<a href={`/account/login${linkQuery}`}>Accedi</a>
              </div>
            </section>
          </div>

          <aside className="visual-card ">
            <div className="product-device" aria-hidden="true">
              <div className="product-screen">
                <div className="product-sidebar">
                  <span className="product-dot"></span>
                  <span className="product-dot"></span>
                  <span className="product-dot"></span>
                  <span className="product-dot"></span>
                  <span className="product-dot"></span>
                </div>
                <div className="product-area">
                  <div className="product-top">
                    <div className="product-title-lines">
                      <span></span>
                      <span></span>
                    </div>
                    <div className="product-kpi"></div>
                  </div>
                  <div className="product-grid">
                    <div className="product-card is-tall">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                    <div className="product-card">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                    <div className="product-card">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                    <div className="product-card">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="visual-content">
              <div className="tenant-badge">B</div>
              <h2>Prenota nelle attività disponibili</h2>
              <p>
                Cerca l&apos;attività, entra con il tuo account cliente e gestisci prenotazioni, credito, pacchetti e
                vantaggi collegati.
              </p>
              <div className="visual-actions">
                <a className="is-light" href="/attivita">
                  Vai al marketplace
                </a>
              </div>
            </div>
          </aside>
        </main>
      </div>
    </>
  );
}
