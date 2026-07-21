"use client";

import { useEffect, useMemo, useState } from "react";
import { TOPBAR_STYLE, TOPBAR_CATEGORIES } from "@/components/public/marketplace-detail-faithful";
import { useMarketplacePageEffects } from "@/components/public/marketplace-shared";

// Port fedele dell'AREA ACCOUNT CLIENTE centrale del marketplace legacy
// (public_account.php, modi activities/favorites/profile): topbar marketplace
// con ricerca + chip account (Attività/Preferiti/Profilo/Esci) + un unico
// account-panel con i 3 pannelli. NON è la dashboard residui per-tenant
// (pacchetti/prepagati/credito/...), che nel legacy vive nell'hub per-sede
// aperto da "Apri area cliente".

type AccountUser = { email: string; fullName: string; firstName: string; lastName: string; phone: string };
type ActivityLocation = { locationId: number; locationSlug: string; locationName: string; city: string; address: string };
type Activity = {
  tenantSlug: string;
  tenantName: string;
  title: string;
  city: string;
  address: string;
  lastSeenAt: string | null;
  locations: ActivityLocation[];
};
type Favorite = {
  tenantSlug: string;
  locationId: number;
  locationSlug: string;
  title: string;
  locationName: string;
  city: string;
  address: string;
  bookingEnabled: boolean;
};

type AccountState = {
  ok?: boolean;
  user?: AccountUser | null;
  activities?: Activity[];
  favorites?: Favorite[];
};

function initialOf(value: string): string {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "B";
}

export type AccountMode = "activities" | "favorites" | "profile";

export function AccountFaithful({ mode }: { mode: AccountMode }) {
  const [state, setState] = useState<AccountState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = () => fetch("/api/account").then((r) => r.json()).then((j: AccountState) => setState(j));

  useEffect(() => {
    let alive = true;
    fetch("/api/account")
      .then((r) => r.json())
      .then((j: AccountState) => {
        if (!alive) return;
        setState(j);
        // Se non loggato, il legacy manda al login con return sull'area.
        if (!j?.user?.email) {
          window.location.replace(`/account/login?return=${encodeURIComponent(`/account/${mode === "activities" ? "activities" : mode}`)}`);
        }
      })
      .catch(() => setState({ ok: false }))
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Effetti condivisi: treatment picker + suggerimenti città della topbar.
  useMarketplacePageEffects([state]);

  const user = state?.user ?? null;
  const activities = state?.activities ?? [];
  const favorites = state?.favorites ?? [];

  const customerName = (user?.fullName || `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim() || user?.email || "Account").trim();
  const customerInitial = customerName.charAt(0).toUpperCase() || "A";

  async function logout() {
    try {
      await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
    } catch { /* redirect comunque */ }
    window.location.href = "/attivita";
  }

  async function removeFavorite(tenantSlug: string, locationId: number) {
    setFlash(null);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove_favorite", tenant_slug: tenantSlug, location_id: String(locationId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setFlash({ ok: false, text: String(data.error || "Impossibile rimuovere il preferito.") });
        return;
      }
      setFlash({ ok: true, text: "Preferito rimosso." });
      await reload();
    } catch {
      setFlash({ ok: false, text: "Errore durante la rimozione del preferito." });
    }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFlash(null);
    const form = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update_profile",
          first_name: String(form.get("first_name") ?? ""),
          last_name: String(form.get("last_name") ?? ""),
          phone: String(form.get("phone") ?? ""),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setFlash({ ok: false, text: String(data.error || "Impossibile aggiornare il profilo.") });
        return;
      }
      setFlash({ ok: true, text: "Profilo aggiornato." });
      setState(data);
    } catch {
      setFlash({ ok: false, text: "Errore durante il salvataggio del profilo." });
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFlash(null);
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "change_password",
          current_password: String(form.get("current_password") ?? ""),
          new_password: String(form.get("new_password") ?? ""),
          confirm_password: String(form.get("new_password_confirm") ?? ""),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setFlash({ ok: false, text: String(data.error || "Impossibile aggiornare la password.") });
        return;
      }
      setFlash({ ok: true, text: "Password aggiornata." });
      formEl.reset();
    } catch {
      setFlash({ ok: false, text: "Errore durante l'aggiornamento della password." });
    }
  }

  const menuItems: Array<{ mode: AccountMode; label: string; href: string }> = useMemo(
    () => [
      { mode: "activities", label: "Attività", href: "/account/activities" },
      { mode: "favorites", label: "Preferiti", href: "/account/favorites" },
      { mode: "profile", label: "Profilo", href: "/account/profile" },
    ],
    [],
  );

  return (
    <>
      {/* Fedele a public_account.php: app.css (base: btn/form/alert/body) +
          public_account.css (layout account) + marketplace_topbar_style()
          inline. NON carica public_marketplace.css (che è per lista/dettaglio). */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/app.css" />
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/pages/public_account.css" />
      <style dangerouslySetInnerHTML={{ __html: TOPBAR_STYLE }} />

      <div className="account-page">
        {/* ===================== TOPBAR (con ricerca) ===================== */}
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
              <span className="marketplace-topbar__brand-mark">B</span>
              <span>Prenodo</span>
            </a>
            <form
              className="marketplace-topbar-search"
              method="get"
              action="/attivita/ricerca"
              role="search"
              aria-label="Cerca attivita"
              data-marketplace-topbar-search
            >
              <div className="marketplace-topbar-search__field marketplace-topbar-treatment-field" data-marketplace-treatment-picker>
                <span className="marketplace-topbar-treatment-kicker">Attivita o servizio</span>
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
                <div className="marketplace-topbar-treatment-panel" id="account-topbar-treatment-panel" hidden data-marketplace-treatment-panel>
                  <div className="marketplace-topbar-treatment-tabs" role="tablist" aria-label="Tipo ricerca">
                    <button className="marketplace-topbar-treatment-tab is-active" type="button" role="tab" aria-selected="true" data-marketplace-treatment-tab="categories">
                      Categorie
                    </button>
                    <button className="marketplace-topbar-treatment-tab" type="button" role="tab" aria-selected="false" data-marketplace-treatment-tab="salons">
                      Attivita
                    </button>
                    <button className="marketplace-topbar-treatment-tab" type="button" role="tab" aria-selected="false" data-marketplace-treatment-tab="services">
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
                    <div className="marketplace-topbar-treatment-list" role="listbox" aria-label="Categorie" data-marketplace-treatment-list="categories">
                      {TOPBAR_CATEGORIES.map((cat) => (
                        <button
                          key={cat.category}
                          className="marketplace-topbar-treatment-option"
                          type="button"
                          role="option"
                          aria-selected="false"
                          data-marketplace-treatment-option
                          data-treatment-category={cat.category}
                          data-treatment-query=""
                          data-treatment-service=""
                          data-treatment-label={cat.label}
                          data-treatment-search={`${cat.category} ${cat.slug}`}
                        >
                          <span className="marketplace-topbar-treatment-icon">
                            <i className={`bi ${cat.icon}`} aria-hidden="true"></i>
                          </span>
                          <span className="marketplace-topbar-treatment-copy">
                            <span className="marketplace-topbar-treatment-name">{cat.label}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="marketplace-topbar-treatment-list" role="listbox" aria-label="Attivita" data-marketplace-treatment-list="salons" hidden></div>
                    <div className="marketplace-topbar-treatment-list" role="listbox" aria-label="Servizi" data-marketplace-treatment-list="services" hidden></div>
                  </div>
                  <div className="marketplace-topbar-treatment-empty" data-marketplace-treatment-empty>
                    Nessun risultato.
                  </div>
                </div>
              </div>
              <label className="marketplace-topbar-search__field" htmlFor="account-topbar-city">
                <span>Dove</span>
                <input id="account-topbar-city" type="search" name="city" defaultValue="" placeholder="La tua citta" autoComplete="off" data-marketplace-topbar-city-input />
              </label>
              <button type="submit" aria-label="Cerca">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7"></circle>
                  <path d="m16 16 4 4"></path>
                </svg>
              </button>
              <div className="marketplace-topbar-city-suggestions" role="listbox" aria-label="Citta suggerite" hidden data-marketplace-topbar-city-suggestions></div>
            </form>
            <nav className="header-actions">
              {user ? (
                <div className="marketplace-account-wrap" data-marketplace-account-menu onClick={(e) => e.stopPropagation()}>
                  <button
                    className="marketplace-account-chip"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-marketplace-account-toggle
                    onClick={() => setMenuOpen((o) => !o)}
                  >
                    <span className="marketplace-account-chip__avatar">{customerInitial}</span>
                    <span className="marketplace-account-chip__text">
                      <span className="marketplace-account-chip__name">{customerName}</span>
                      {user.email ? <span className="marketplace-account-chip__email">{user.email}</span> : null}
                    </span>
                    <span className="marketplace-account-chip__chevron" aria-hidden="true"></span>
                  </button>
                  <div className="marketplace-account-menu" role="menu" hidden={!menuOpen} data-marketplace-account-panel>
                    {menuItems.map((item) => (
                      <a key={item.mode} className={item.mode === mode ? "is-active" : ""} role="menuitem" href={item.href}>
                        {item.label}
                      </a>
                    ))}
                    <a
                      className="is-danger"
                      role="menuitem"
                      href="/attivita"
                      onClick={(e) => {
                        e.preventDefault();
                        void logout();
                      }}
                    >
                      Esci
                    </a>
                  </div>
                </div>
              ) : (
                <a className="btn btn-primary" href="/account/login">
                  Accedi
                </a>
              )}
            </nav>
          </div>
        </header>

        <main className="account-main account-main--wide">
          <section className="account-panel">
            {/* ============== ATTIVITÀ ============== */}
            {mode === "activities" ? (
              <>
                <div className="account-panel__head">
                  <div>
                    <p className="eyebrow">Account cliente</p>
                    <h1>Attivit&agrave;</h1>
                    <p>Scegli l&apos;attivit&agrave; collegata al tuo account. Le sedi restano disponibili dentro la stessa area cliente.</p>
                  </div>
                </div>
                {flash ? <div className={flash.ok ? "alert alert-success" : "alert"}>{flash.text}</div> : null}
                {loaded && activities.length === 0 ? (
                  <div className="empty-state">
                    <strong>Nessuna attivit&agrave; collegata.</strong>
                    <br />
                    Prenota da un&apos;attività del marketplace per vederla comparire qui.
                  </div>
                ) : (
                  <div className="activity-grid">
                    {activities.map((activity) => {
                      const labels = activity.locations.map((loc) => {
                        let label = loc.locationName || loc.city || "Sede";
                        if (loc.city && !label.toLowerCase().includes(loc.city.toLowerCase())) label += ` - ${loc.city}`;
                        if (loc.address) label += ` · ${loc.address}`;
                        return label;
                      });
                      const openHref = `/${encodeURIComponent(activity.tenantSlug)}/booking?hub=1`;
                      const profileHref = `/attivita/${encodeURIComponent(activity.tenantSlug)}`;
                      return (
                        <article className="activity-card" key={activity.tenantSlug}>
                          <div className="activity-card__top">
                            <div className="activity-logo">{initialOf(activity.title)}</div>
                            <div className="activity-card__copy">
                              <h2 className="activity-title">{activity.title}</h2>
                              {labels.length ? (
                                <div className="activity-locations">
                                  <span>{labels.length === 1 ? "Sede" : "Sedi"}:</span>
                                  {labels.slice(0, 3).map((label, i) => (
                                    <span className="activity-location-chip" key={i}>
                                      {label}
                                    </span>
                                  ))}
                                  {labels.length > 3 ? <span className="activity-location-chip">+{labels.length - 3}</span> : null}
                                </div>
                              ) : activity.city || activity.address ? (
                                <div className="activity-meta">
                                  {[activity.address, activity.city].filter(Boolean).join(" - ")}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          {activity.lastSeenAt ? <div className="activity-meta">Ultima attivit&agrave;: {activity.lastSeenAt}</div> : null}
                          <div className="activity-actions">
                            <a className="btn btn-primary" href={openHref}>
                              Apri area cliente
                            </a>
                            <a className="btn" href={profileHref}>
                              Scheda
                            </a>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}

            {/* ============== PREFERITI ============== */}
            {mode === "favorites" ? (
              <>
                <div className="account-panel__head">
                  <div>
                    <p className="eyebrow">Account cliente</p>
                    <h1>Preferiti</h1>
                    <p>Ritrova velocemente le schede delle attività che hai salvato.</p>
                  </div>
                </div>
                {flash ? <div className={flash.ok ? "alert alert-success" : "alert"}>{flash.text}</div> : null}
                {loaded && favorites.length === 0 ? (
                  <div className="empty-state">
                    <strong>Nessun preferito salvato.</strong>
                    <br />
                    Usa il cuore nelle schede delle attività per ritrovarle qui.
                  </div>
                ) : (
                  <div className="favorite-grid">
                    {favorites.map((favorite) => {
                      const detailHref = `/attivita/${encodeURIComponent(favorite.tenantSlug)}${favorite.locationSlug ? `/sedi/${encodeURIComponent(favorite.locationSlug)}` : ""}`;
                      const bookHref = `/${encodeURIComponent(favorite.tenantSlug)}/booking?start=1${favorite.locationId > 0 ? `&location_id=${favorite.locationId}` : ""}`;
                      const place = [favorite.address, favorite.city].filter(Boolean).join(" - ") || "Scheda salvata";
                      return (
                        <article className="favorite-card" key={`${favorite.tenantSlug}:${favorite.locationId}`}>
                          <a className="favorite-card__media" href={detailHref}>
                            {initialOf(favorite.title)}
                          </a>
                          <div className="favorite-card__body">
                            <h2 className="favorite-card__title">{favorite.title}</h2>
                            <div className="favorite-card__meta">
                              {favorite.locationName ? (
                                <>
                                  <strong>{favorite.locationName}</strong>
                                  <br />
                                </>
                              ) : null}
                              {place}
                            </div>
                            <div className="favorite-card__actions">
                              <a className="btn btn-primary" href={detailHref}>
                                Scheda
                              </a>
                              {favorite.bookingEnabled ? (
                                <a className="btn" href={bookHref}>
                                  Prenota
                                </a>
                              ) : null}
                              <button className="favorite-card__remove" type="button" onClick={() => void removeFavorite(favorite.tenantSlug, favorite.locationId)}>
                                Rimuovi
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}

            {/* ============== PROFILO ============== */}
            {mode === "profile" ? (
              <>
                <div className="account-panel__head">
                  <div>
                    <p className="eyebrow">Account cliente</p>
                    <h1>Profilo</h1>
                    <p>Questi dati sono globali e vengono usati per accedere alle attività del marketplace.</p>
                  </div>
                </div>
                {flash ? <div className={flash.ok ? "alert alert-success" : "alert"}>{flash.text}</div> : null}
                <form className="form profile-form" onSubmit={saveProfile}>
                  <div className="grid-2">
                    <label>
                      Nome <input name="first_name" autoComplete="given-name" required defaultValue={user?.firstName ?? ""} key={`fn-${user?.email ?? ""}`} />
                    </label>
                    <label>
                      Cognome <input name="last_name" autoComplete="family-name" required defaultValue={user?.lastName ?? ""} key={`ln-${user?.email ?? ""}`} />
                    </label>
                  </div>
                  <div className="grid-2">
                    <label>
                      Email <input className="readonly-field" type="email" value={user?.email ?? ""} readOnly />
                    </label>
                    <label>
                      Telefono <input name="phone" autoComplete="tel" defaultValue={user?.phone ?? ""} key={`ph-${user?.email ?? ""}`} />
                    </label>
                  </div>
                  <div className="form-actions">
                    <button className="auth-submit auth-submit--compact" type="submit">
                      Salva profilo
                    </button>
                    <a
                      className="btn"
                      href="/attivita"
                      onClick={(e) => {
                        e.preventDefault();
                        void logout();
                      }}
                    >
                      Esci
                    </a>
                  </div>
                </form>

                <div className="account-section-divider"></div>

                <form className="form profile-form" onSubmit={changePassword}>
                  <div className="profile-security-head">
                    <h2>Sicurezza</h2>
                    <p>Cambia la password usata per accedere al tuo account cliente.</p>
                  </div>
                  <div className="grid-2">
                    <label>
                      Password attuale <input type="password" name="current_password" autoComplete="current-password" required />
                    </label>
                    <label>
                      Nuova password <input type="password" name="new_password" autoComplete="new-password" minLength={8} required />
                    </label>
                  </div>
                  <div className="grid-2">
                    <label>
                      Conferma nuova password <input type="password" name="new_password_confirm" autoComplete="new-password" minLength={8} required />
                    </label>
                  </div>
                  <div className="form-actions">
                    <button className="auth-submit auth-submit--compact" type="submit">
                      Aggiorna password
                    </button>
                  </div>
                </form>
              </>
            ) : null}
          </section>
        </main>
      </div>
    </>
  );
}
