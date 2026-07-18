"use client";

import { useEffect, useMemo, useState } from "react";
import { TOPBAR_CATEGORIES } from "@/components/public/marketplace-detail-faithful";
import { MarketplaceAccountNav, MarketplaceFooter, useMarketplacePageEffects } from "@/components/public/marketplace-shared";

// Port fedele della pagina RISULTATI RICERCA del marketplace legacy
// (public_marketplace.php $isSearchResults, righe 1720-1892: route
// /attivita/ricerca|cerca|risultati con filtri q/city/category/service).
// Shell identico alle altre pagine marketplace (topbar con search + footer);
// corpo: breadcrumb Home > Ricerca, titolo dinamico, toolbar con conteggio e
// bottone Filtri (modale con form GET), results-grid di result-card per SEDE
// con preferiti, Dove/Categorie, Prenota (login centrale) e Scheda (pagina
// sede /attivita/<slug>/sedi/<location-slug>).

type MarketplaceLocation = {
  id: number;
  name: string;
  city: string;
  area: string;
  address: string;
  activityCategories?: string[];
  categoryText?: string;
};

type MarketplaceProfile = {
  slug: string;
  name: string;
  category: string;
  area: string;
  image?: string;
  services: string[];
  locations: MarketplaceLocation[];
};

type MarketplaceResponse = {
  ok?: boolean;
  profiles?: MarketplaceProfile[];
  categories?: string[];
};

type CardItem = {
  profile: MarketplaceProfile;
  location: MarketplaceLocation;
  favoriteKey: string;
  locationSlug: string;
};

function initialOf(value: string): string {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "B";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function locationSlugFor(location: MarketplaceLocation): string {
  const base = [location.city, location.name].filter(Boolean).join(" ");
  return `${slugify(base || location.name || "sede")}-${location.id}`;
}

export function MarketplaceSearchFaithful({
  initialQuery,
}: {
  initialQuery?: { q?: string; city?: string; category?: string; service?: string };
} = {}) {
  const q = (initialQuery?.q ?? "").trim();
  const city = (initialQuery?.city ?? "").trim();
  const category = (initialQuery?.category ?? "").trim();
  const service = (initialQuery?.service ?? "").trim();

  const [profiles, setProfiles] = useState<MarketplaceProfile[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/marketplace")
      .then((r) => r.json())
      .then((data: MarketplaceResponse) => {
        if (!active) return;
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        setCategories(Array.isArray(data.categories) ? data.categories : []);
      })
      .catch(() => {
        if (active) {
          setProfiles([]);
          setCategories([]);
        }
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Card per SEDE (come marketplace_search_profiles legacy) filtrate con la
  // stessa semantica: q su nome/città/categorie/servizi, city, category
  // (categorie attività), service (nomi servizi).
  const cards = useMemo<CardItem[]>(() => {
    const items: CardItem[] = [];
    for (const profile of profiles) {
      for (const location of profile.locations ?? []) {
        items.push({
          profile,
          location,
          favoriteKey: `${profile.slug}:${location.id}`,
          locationSlug: locationSlugFor(location),
        });
      }
    }
    const qNeedle = q.toLowerCase();
    const cityNeedle = city.toLowerCase();
    const catNeedle = category.toLowerCase();
    const svcNeedle = service.toLowerCase();
    return items.filter(({ profile, location }) => {
      const activityCats = location.activityCategories ?? [];
      const haystack = [
        profile.name,
        location.name,
        location.city,
        location.area,
        location.address,
        profile.area,
        ...activityCats,
        ...profile.services,
      ]
        .join(" ")
        .toLowerCase();
      const cityText = [location.city, location.area, profile.area].join(" ").toLowerCase();
      const catText = activityCats.join(" ").toLowerCase();
      const svcText = profile.services.join(" ").toLowerCase();
      if (qNeedle && !haystack.includes(qNeedle)) return false;
      if (cityNeedle && !cityText.includes(cityNeedle)) return false;
      if (catNeedle && !catText.includes(catNeedle)) return false;
      if (svcNeedle && !(svcText.includes(svcNeedle) || haystack.includes(svcNeedle))) return false;
      return true;
    });
  }, [profiles, q, city, category, service]);

  const citySuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const profile of profiles) {
      for (const location of profile.locations ?? []) {
        const value = (location.city || "").trim();
        if (value) set.add(value);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "it"));
  }, [profiles]);

  // Titoli legacy (public_marketplace.php 1722-1737).
  const activeFilters = q !== "" || city !== "" || category !== "" || service !== "";
  const resultsTitle = city !== ""
    ? `Attività disponibili a ${city}`
    : service !== ""
      ? `Attività per "${service}"`
      : q !== ""
        ? `Risultati per "${q}"`
        : category !== ""
          ? `Attività per ${category}`
          : "Tutte le attività disponibili";
  const resultsSubtitle = activeFilters
    ? "Affina la ricerca usando attività, città, categoria o servizio."
    : "Sfoglia tutti i centri pubblicati nel marketplace.";

  // Effetti legacy: treatment picker della topbar, suggerimenti/validazione
  // città, preferiti sulle result-card.
  useMarketplacePageEffects([profiles]);

  // Form filtri unico, renderizzato DUE volte: sidebar sticky su desktop,
  // modal su mobile (redesign 2026-07 — prima era solo-modal anche desktop).
  // Il datalist città è condiviso e vive una volta sola nel layout.
  const filterForm = (
    <form className="filter-card" method="get" action="/attivita/ricerca">
      <h2>Filtri</h2>
      <input type="hidden" name="service" value={service} readOnly />
      <label className="filter-field">
        <span>Attivit&agrave; o servizio</span>
        <input type="search" name="q" defaultValue={q} placeholder="Es. massaggio, manicure, Reviva" />
      </label>
      <label className="filter-field">
        <span>Citt&agrave;</span>
        <input
          type="search"
          name="city"
          defaultValue={city}
          placeholder="La tua citt&agrave;"
          list="marketplace-city-suggestions"
          autoComplete="off"
        />
      </label>
      <label className="filter-field">
        <span>Categoria attivita</span>
        <select name="category" defaultValue={category}>
          <option value="">Tutte le categorie</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </label>
      <div className="filter-actions">
        <button className="btn btn-primary" type="submit">
          Cerca
        </button>
        <a className="btn" href="/attivita/ricerca">
          Reset
        </a>
      </div>
    </form>
  );

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/pages/public_marketplace.css" />

      {/* ===================== TOPBAR (con search, come il legacy) ========== */}
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
          <a className="marketplace-topbar__brand" href="/">
            <span className="marketplace-topbar__brand-mark">P</span>
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
              <input type="hidden" name="q" defaultValue={q} data-marketplace-treatment-query />
              <input type="hidden" name="category" defaultValue={category} data-marketplace-treatment-category />
              <input type="hidden" name="service" defaultValue={service} data-marketplace-treatment-service />
              <button
                className="marketplace-topbar-treatment-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded="false"
                aria-controls="marketplace-topbar-treatment-panel"
                data-marketplace-treatment-trigger
              >
                <span className="marketplace-topbar-treatment-label" data-marketplace-treatment-label>
                  {category || service || q || "Tutte le attivita"}
                </span>
                <svg className="marketplace-topbar-treatment-chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </button>
              <div className="marketplace-topbar-treatment-panel" id="marketplace-topbar-treatment-panel" hidden data-marketplace-treatment-panel>
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
            <label className="marketplace-topbar-search__field" htmlFor="marketplace-topbar-city">
              <span>Dove</span>
              <input
                id="marketplace-topbar-city"
                type="search"
                name="city"
                defaultValue={city}
                placeholder="La tua citta"
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
            <div className="marketplace-topbar-city-suggestions" role="listbox" aria-label="Citta suggerite" hidden data-marketplace-topbar-city-suggestions></div>
          </form>
          <MarketplaceAccountNav />
        </div>
      </header>

      {/* ===================== RISULTATI ===================== */}
      <main className="results-wrap">
        <section className="results-heading">
          <div>
            <div className="breadcrumb">
              <a href="/attivita">Home</a> &gt; Ricerca
            </div>
            <h1>{resultsTitle}</h1>
            <p>{resultsSubtitle}</p>
          </div>
        </section>

        <div className="results-layout">
          {citySuggestions.length ? (
            <datalist id="marketplace-city-suggestions">
              {citySuggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion}></option>
              ))}
            </datalist>
          ) : null}
          <aside className="results-side" aria-label="Filtri di ricerca">
            {filterForm}
          </aside>
          <section className="results-main">
            <div className="results-toolbar">
              <div className="results-count">
                {cards.length} risultato/i {activeFilters ? "trovato/i" : "disponibili"}.
              </div>
              <button
                className="btn btn-primary results-filter-button"
                type="button"
                data-marketplace-filters-open
                onClick={() => setFiltersOpen(true)}
              >
                Filtri
              </button>
            </div>

            <div
              className={`filter-modal${filtersOpen ? " is-open" : ""}`}
              id="marketplaceFiltersModal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="marketplaceFiltersTitle"
              aria-hidden={filtersOpen ? "false" : "true"}
            >
              <button
                className="filter-modal__backdrop"
                type="button"
                tabIndex={-1}
                aria-label="Chiudi filtri"
                data-marketplace-filters-close
                onClick={() => setFiltersOpen(false)}
              ></button>
              <div className="filter-modal__panel">
                <div className="filter-modal__head">
                  <h2 className="filter-modal__title" id="marketplaceFiltersTitle">
                    Filtri
                  </h2>
                  <button
                    className="filter-modal__close"
                    type="button"
                    aria-label="Chiudi filtri"
                    data-marketplace-filters-close
                    onClick={() => setFiltersOpen(false)}
                  >
                    &times;
                  </button>
                </div>
                {filterForm}
              </div>
            </div>

            {!loaded ? (
              <div className="results-grid" aria-hidden="true">
                {Array.from({ length: 4 }, (_, i) => (
                  <div className="mk-skeleton" key={i}>
                    <div className="mk-skeleton__media"></div>
                    <div className="mk-skeleton__body">
                      <div className="mk-skeleton__line"></div>
                      <div className="mk-skeleton__line is-short"></div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {loaded && cards.length === 0 ? (
              <div className="empty">
                <h3>Nessuna attivit&agrave; trovata</h3>
                <p>Prova a modificare citt&agrave;, servizio o nome dell&apos;attivit&agrave;.</p>
                <p>
                  <a className="btn btn-primary" href="/attivita/ricerca">
                    Vedi tutte le attivit&agrave;
                  </a>
                </p>
              </div>
            ) : (
              <div className="results-grid">
                {cards.map(({ profile, location, favoriteKey, locationSlug }) => {
                  const cardUrl = `/attivita/${encodeURIComponent(profile.slug)}/sedi/${encodeURIComponent(locationSlug)}`;
                  // Gate-driven come il PHP: non loggato -> /account/login
                  // CLIENTE, loggato -> wizard (senza hop dal login).
                  const bookingActionUrl = `/${encodeURIComponent(profile.slug)}/booking?start=1&location_id=${location.id}`;
                  const place = [location.address, location.city].filter(Boolean).join(" ");
                  const title = location.name || profile.name;
                  const showSubtitle = profile.name && title.toLowerCase() !== profile.name.toLowerCase();
                  return (
                    <article className="result-card" key={favoriteKey}>
                      <button
                        className="favorite-button card-favorite-button"
                        type="button"
                        data-favorite-button
                        data-favorite-key={favoriteKey}
                        data-tenant-slug={profile.slug}
                        data-location-id={location.id}
                        data-location-slug={locationSlug}
                        aria-label="Aggiungi ai preferiti"
                        aria-pressed="false"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M20.8 4.6c-1.7-1.8-4.5-1.8-6.2 0L12 7.2 9.4 4.6c-1.7-1.8-4.5-1.8-6.2 0-1.8 1.9-1.7 4.9.1 6.7L12 20l8.7-8.7c1.8-1.8 1.9-4.8.1-6.7z"></path>
                        </svg>
                      </button>
                      <a className="result-media" href={cardUrl} aria-label={title}>
                        {profile.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={profile.image} alt="" />
                        ) : (
                          <span className="result-media__mark" aria-hidden="true">
                            {initialOf(title)}
                          </span>
                        )}
                      </a>
                      <div className="result-body">
                        <div className="result-title">
                          <span className="result-logo">{initialOf(profile.name || title)}</span>
                          <div>
                            <h2>{title}</h2>
                            {showSubtitle ? <div className="result-subtitle">{profile.name}</div> : null}
                          </div>
                        </div>
                        <div className="result-meta">
                          {place ? (
                            <span>
                              <strong>Dove:</strong> {place}
                            </span>
                          ) : null}
                          {location.categoryText ? (
                            <span>
                              <strong>Categorie:</strong> {location.categoryText}
                            </span>
                          ) : null}
                        </div>
                        <div className="result-actions">
                          <a className="btn btn-primary" href={bookingActionUrl}>
                            Prenota
                          </a>
                          <a className="btn" href={cardUrl}>
                            Scheda
                          </a>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </main>

      {/* ===================== FOOTER ===================== */}
      <MarketplaceFooter />
    </>
  );
}
