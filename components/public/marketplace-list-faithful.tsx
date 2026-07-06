"use client";

/**
 * MarketplaceListFaithful
 * -----------------------
 * Pixel-faithful React 19 port of the legacy PHP public marketplace LIST/search page
 * (served by PHP at http://localhost/attivita).
 *
 * Faithfulness approach:
 *  - The page's look comes from THREE sources, all reproduced here verbatim:
 *      1. <link rel="stylesheet" href="/assets/css/pages/public_marketplace.css" />
 *         (the real file lives at prenodo/public/assets/css/pages/public_marketplace.css and
 *          defines :root vars, .hero, .wrap, .grid, .tenant-card, .chip, .btn, .city-card,
 *          .app-cta, .partner-cta, the favorite-button, etc.)
 *      2. The first inline <head><style> block from the PHP page — the marketplace-topbar +
 *         treatment-selector dropdown + topbar search styles — injected verbatim below as
 *         TOPBAR_STYLE.
 *      3. The second inline <head><style> block — the marketplace-footer styles — injected
 *         verbatim below as FOOTER_STYLE.
 *    Both inline blocks are rendered via <style dangerouslySetInnerHTML> so the captured CSS
 *    text is byte-for-byte identical to the original.
 *
 *  - The topbar / hero search / "Servizi piu cercati" chips / activity-card grid / city-discovery
 *    grid / app+partner CTAs / footer markup all use the ORIGINAL class names and bi/svg icons.
 *
 * Data:
 *  - Fetches GET /api/marketplace which returns { ok, profiles:[...], categories:[...] }.
 *    Each profile has: slug, name, category, area, rating, reviews, nextSlot, priceFrom, image,
 *    services[], locations[{ id, name, city, area, address }].
 *  - The legacy page renders ONE CARD PER LOCATION (its "N risultato/i" counts locations, e.g.
 *    2 profiles -> 3 cards). We flatten profiles -> locations to stay pixel-faithful.
 *
 * Wired (React state) vs static:
 *  - WIRED: the hero search box ("Attivita o servizio" treatment query, "Dove" city) filters the
 *    rendered cards live; the category chips row filters live; the treatment dropdown panel is
 *    interactive (open/close, tab switch, option select sets category/query and filters).
 *  - STATIC (faithful markup, non-functional like a brochure): the city-discovery cards, the
 *    app-cta / partner-cta panels, the city autocomplete suggestion panel, the account menu chip,
 *    the footer. These are href/visual-only in the original page beyond plain navigation, so we
 *    keep the markup but do not re-implement their JS behaviours.
 *
 * Links are pointed at Next routes:
 *   activity card / scheda  -> /attivita/{slug}
 *   prenota                 -> /account/login?tenant={slug}&next=start&location_id={id}
 *   accedi / registrati     -> /account/login , /account/register
 */

import { useEffect, useMemo, useState } from "react";
import { MarketplaceAccountNav, useMarketplacePageEffects } from "@/components/public/marketplace-shared";

type MarketplaceLocation = {
  id: number;
  name: string;
  city: string;
  area: string;
  address: string;
  // Categorie attività marketplace della sede (category_text legacy): la
  // meta della card mostra QUESTE (es. 'Unghie'), non le categorie servizi.
  activityCategories?: string[];
  categoryText?: string;
};

type MarketplaceProfile = {
  slug: string;
  name: string;
  category: string;
  area: string;
  rating: string;
  reviews: number;
  nextSlot: string;
  priceFrom: string;
  image: string;
  services: string[];
  locations: MarketplaceLocation[];
};

type MarketplaceResponse = {
  ok?: boolean;
  profiles?: MarketplaceProfile[];
  categories?: string[];
};

// One rendered card === one location of a profile (matches the legacy per-location grid).
type CardItem = {
  profile: MarketplaceProfile;
  location: MarketplaceLocation;
  favoriteKey: string;
  locationSlug: string;
};

// Captured verbatim from the FIRST inline <head><style> block of http://localhost/attivita.
const TOPBAR_STYLE = `
.marketplace-topbar{--marketplace-topbar-brand:#4e6da6;--marketplace-topbar-brand-dark:#365287;--marketplace-topbar-ink:#0f172a;--marketplace-topbar-muted:#64748b;--marketplace-topbar-line:#dbe3ef;--marketplace-topbar-soft:#eef4ff;--marketplace-topbar-pad:clamp(18px,5vw,72px);--marketplace-topbar-max:none;--marketplace-topbar-search-width:900px;--marketplace-topbar-search-reserve:560px;height:68px;background:#fff;border-bottom:1px solid var(--marketplace-topbar-line);padding:0 var(--marketplace-topbar-pad);position:sticky;top:0;z-index:30;color:var(--marketplace-topbar-ink)}
.marketplace-topbar__inner{position:relative;width:100%;max-width:var(--marketplace-topbar-max);height:100%;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px}
.marketplace-topbar__brand{height:68px;display:flex;gap:12px;align-items:center;justify-self:start;padding:0;background:transparent;color:inherit;text-decoration:none;font-size:18px;line-height:1;font-weight:600;min-width:0}
.marketplace-topbar__brand:hover,.marketplace-topbar__brand:focus,.marketplace-topbar__brand:active,.marketplace-topbar__brand:visited{background:transparent;color:inherit;text-decoration:none;box-shadow:none}
.marketplace-topbar__brand:focus-visible{outline:2px solid rgba(78,109,166,.34);outline-offset:4px;border-radius:12px}
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
.marketplace-topbar-treatment-trigger:focus-visible{outline:2px solid rgba(78,109,166,.35);outline-offset:4px;border-radius:8px}
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
.marketplace-topbar-treatment-field .marketplace-topbar-treatment-search:focus{background:#f6f8fb;box-shadow:0 0 0 3px rgba(78,109,166,.12)}
.marketplace-topbar-treatment-lists{min-height:0;overflow:hidden}
.marketplace-topbar-treatment-list{display:grid;gap:4px;max-height:320px;overflow:auto;padding-right:2px}
.marketplace-topbar-treatment-list[hidden]{display:none}
.marketplace-topbar-treatment-option{width:100%;min-height:52px;border:0;border-radius:14px;background:#fff;color:var(--marketplace-topbar-ink,#0f172a);padding:8px 10px;text-align:left;font:inherit;font-size:14px;font-weight:600;display:flex;align-items:center;gap:12px;cursor:pointer}
.marketplace-topbar-treatment-option:hover,.marketplace-topbar-treatment-option.is-active,.marketplace-topbar-treatment-option.is-highlighted{background:var(--marketplace-topbar-soft,#eef4ff);color:var(--marketplace-topbar-brand,#4e6da6)}
.marketplace-topbar-treatment-icon,.marketplace-topbar-treatment-avatar{width:34px;height:34px;border-radius:50%;background:#f1efff;color:#6d5dfc;display:grid;place-items:center;flex:0 0 auto;font-size:14px;font-weight:800}
.marketplace-topbar-treatment-option.is-active .marketplace-topbar-treatment-icon,.marketplace-topbar-treatment-option.is-active .marketplace-topbar-treatment-avatar{background:#e6efff;color:var(--marketplace-topbar-brand,#4e6da6)}
.marketplace-topbar-treatment-icon svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.marketplace-topbar-treatment-icon .bi{display:block;font-size:18px;line-height:1}
.marketplace-topbar-treatment-copy{min-width:0;display:grid;gap:2px}
.marketplace-topbar-treatment-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none!important;letter-spacing:0!important;color:inherit!important;font-size:14px!important;font-weight:600!important;line-height:1.25!important}
.marketplace-topbar-treatment-meta{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none!important;letter-spacing:0!important;color:var(--marketplace-topbar-muted,#64748b)!important;font-size:12px!important;font-weight:600!important;line-height:1.2!important}
.marketplace-topbar-treatment-empty{display:none;padding:14px 10px;color:var(--marketplace-topbar-muted,#64748b);font-size:13px;font-weight:600}
.marketplace-topbar-treatment-empty.is-visible{display:block}
.marketplace-topbar-search > button[type="submit"]{justify-self:end;align-self:center;width:40px;height:40px;margin-right:6px;border:0;border-radius:50%;background:#4e6da6;color:#fff;display:grid;place-items:center;cursor:pointer}
.marketplace-topbar-search > button[type="submit"] svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.marketplace-topbar-city-suggestions{position:absolute;left:calc((100% - 56px) / 2 + 8px);right:64px;top:calc(100% + 8px);z-index:80;display:grid;gap:2px;max-height:248px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--marketplace-topbar-line);border-radius:14px;background:#fff;padding:6px;box-shadow:0 18px 42px rgba(15,23,42,.16)}
.marketplace-topbar-city-suggestions[hidden]{display:none}
.marketplace-topbar-search .marketplace-topbar-city-suggestion{width:100%;min-height:38px;border:0;border-radius:10px;background:transparent;color:var(--marketplace-topbar-ink);padding:10px 12px;text-align:left;font:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer;display:block}
.marketplace-topbar-search .marketplace-topbar-city-suggestion:hover,.marketplace-topbar-search .marketplace-topbar-city-suggestion.is-active{background:var(--marketplace-topbar-soft);color:var(--marketplace-topbar-brand)}
.marketplace-topbar__actions,.marketplace-topbar .header-actions,.marketplace-topbar .booking-marketplace-actions{display:flex;gap:10px;align-items:center;justify-self:end;min-width:0}
@media (max-width:900px){.marketplace-topbar{position:static;height:auto;min-height:68px;padding-top:12px;padding-bottom:12px}.marketplace-topbar__inner{height:auto;display:flex;flex-wrap:wrap;gap:12px}.marketplace-topbar__brand{height:auto;padding:0;background:transparent}.marketplace-topbar-search{position:static;left:auto;top:auto;transform:none;order:3;flex:1 1 100%;width:auto;max-width:none}.marketplace-topbar__actions,.marketplace-topbar .header-actions,.marketplace-topbar .booking-marketplace-actions{flex-wrap:wrap;margin-left:auto}}
@media (max-width:560px){.marketplace-topbar-search{grid-template-columns:1fr 38px;height:auto;border-radius:18px}.marketplace-topbar-search__field + .marketplace-topbar-search__field{border-left:0;border-top:1px solid var(--marketplace-topbar-line)}.marketplace-topbar-search__field:nth-child(2){grid-column:1/2}.marketplace-topbar-search > button[type="submit"]{grid-column:2;grid-row:1/3;width:38px;height:38px;margin-right:5px}.marketplace-topbar-city-suggestions{left:0;right:46px}}
`;

// Captured verbatim from the SECOND inline <head><style> block of http://localhost/attivita.
const FOOTER_STYLE = `
.marketplace-footer{border-top:1px solid var(--line,#dbe3ef);background:#f3f5f8;color:#475569;padding:56px var(--marketplace-page-pad,clamp(18px,2.8vw,40px)) 34px}
body.embed-body footer.marketplace-footer,footer.marketplace-footer{display:block!important}
.marketplace-footer__inner{max-width:var(--marketplace-page-max,1440px);margin:0 auto}
.marketplace-footer__grid{display:grid;grid-template-columns:1.1fr 1.2fr 1fr 1fr;gap:54px;align-items:start}
.marketplace-footer h2{font-size:18px;line-height:1.2;margin:0 0 20px;color:var(--ink,#0f172a);font-weight:600;letter-spacing:0}
.marketplace-footer__links{display:grid;gap:12px}
.marketplace-footer__links a{color:#64748b;font-size:15px;line-height:1.25;text-decoration:none}
.marketplace-footer__links a:hover{color:var(--brand,#4e6da6)}
.marketplace-footer__app{display:grid;grid-template-columns:52px minmax(0,1fr);gap:16px;align-items:start;margin-bottom:16px}
.marketplace-footer__app-icon{width:52px;height:52px;border-radius:8px;background:#fb7185;color:#fff;display:grid;place-items:center;font-size:28px;font-weight:600}
.marketplace-footer__app p{margin:0;color:#0f172a;font-size:16px;line-height:1.45}
.marketplace-footer__stores{display:flex;gap:10px;flex-wrap:wrap}
.marketplace-footer__store{min-height:42px;border-radius:6px;background:#050505;color:#fff;padding:7px 13px;display:grid;align-content:center;line-height:1.05;min-width:134px;text-decoration:none}
.marketplace-footer__store small{font-size:9px;text-transform:uppercase;letter-spacing:.03em;color:#d1d5db}
.marketplace-footer__store strong{font-size:16px;font-weight:600}
.marketplace-footer__social{display:flex;gap:10px;flex-wrap:wrap}
.marketplace-footer__social-link{width:40px;height:40px;border-radius:50%;border:1px solid #d4dce8;background:#fff;color:#64748b;display:grid;place-items:center;font-size:15px;font-weight:600;text-decoration:none}
.marketplace-footer__social-link:hover{border-color:var(--brand,#4e6da6);color:var(--brand,#4e6da6)}
.marketplace-footer__country{height:54px;border:1px solid #d4dce8;border-radius:8px;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 16px;min-width:260px;color:#0f172a;font-weight:600}
.marketplace-footer__country span{display:flex;align-items:center;gap:10px}
.marketplace-footer__flag{width:21px;height:15px;border-radius:2px;box-shadow:0 0 0 1px rgba(15,23,42,.08);background:linear-gradient(90deg,#22c55e 0 33.33%,#fff 33.33% 66.66%,#ef4444 66.66%)}
.marketplace-footer__chevron{width:8px;height:8px;border-right:1.5px solid #64748b;border-bottom:1.5px solid #64748b;transform:rotate(45deg);margin-top:-4px}
.marketplace-footer__bottom{border-top:1px solid #d4dce8;margin-top:52px;padding-top:24px;display:flex;align-items:center;justify-content:space-between;gap:18px;color:#64748b;flex-wrap:wrap}
.marketplace-footer__brand{display:flex;align-items:center;gap:18px;font-weight:600;color:#94a3b8}
.marketplace-footer__brand-mark{font-size:28px;letter-spacing:-.08em}
@media (max-width:900px){.marketplace-footer__grid{grid-template-columns:1fr 1fr;gap:34px}.marketplace-footer__country{min-width:0;width:100%}}
@media (max-width:640px){.marketplace-footer{padding-top:38px}.marketplace-footer__grid{grid-template-columns:1fr}.marketplace-footer__bottom{align-items:flex-start;flex-direction:column}.marketplace-footer__app{grid-template-columns:1fr}.marketplace-footer__app-icon{width:46px;height:46px}.marketplace-footer__stores{display:grid;grid-template-columns:1fr 1fr}.marketplace-footer__store{min-width:0}}
`;

// Treatment-dropdown category list captured verbatim from the legacy markup
// (label + Bootstrap-icon class). NOTE: the legacy page does not load the bootstrap-icons
// webfont, so these `bi` glyphs render empty there too; we keep the exact markup for fidelity.
const TREATMENT_CATEGORIES: Array<{ label: string; icon: string; search: string }> = [
  { label: "Parrucchiere", icon: "bi-scissors", search: "Parrucchiere parrucchiere" },
  { label: "Salone di bellezza", icon: "bi-shop", search: "Salone di bellezza salone-bellezza" },
  { label: "Estetista", icon: "bi-stars", search: "Estetista estetista" },
  { label: "Barbiere", icon: "bi-person-badge", search: "Barbiere barbiere" },
  { label: "Unghie", icon: "bi-hand-index-thumb", search: "Unghie unghie" },
  { label: "Sopracciglia e ciglia", icon: "bi-eye", search: "Sopracciglia e ciglia sopracciglia-ciglia" },
  { label: "Centro epilazione", icon: "bi-magic", search: "Centro epilazione centro-epilazione" },
  { label: "Massaggi", icon: "bi-person-heart", search: "Massaggi massaggi" },
  { label: "Spa e sauna", icon: "bi-water", search: "Spa e sauna spa-sauna" },
  { label: "MedSpa", icon: "bi-gem", search: "MedSpa medspa" },
  { label: "Centro abbronzatura", icon: "bi-brightness-high", search: "Centro abbronzatura centro-abbronzatura" },
  { label: "Tatuaggi e piercing", icon: "bi-gem", search: "Tatuaggi e piercing tatuaggi-piercing" },
  { label: "Fisioterapia", icon: "bi-heart-pulse", search: "Fisioterapia fisioterapia" },
  { label: "Fitness e recupero", icon: "bi-bicycle", search: "Fitness e recupero fitness-recupero" },
  { label: "Centro sanitario", icon: "bi-hospital", search: "Centro sanitario centro-sanitario" },
  { label: "Toelettatura animali", icon: "bi-gem", search: "Toelettatura animali toelettatura-animali" },
];

// City-discovery cards captured verbatim from the legacy markup.
const DISCOVERY_CITIES: Array<{ name: string; image: string }> = [
  { name: "Roma", image: "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=900&q=80" },
  { name: "Milano", image: "https://images.unsplash.com/photo-1516483638261-f4dbaf036963?auto=format&fit=crop&w=900&q=80" },
  { name: "Napoli", image: "https://images.unsplash.com/photo-1533105079780-92b9be482077?auto=format&fit=crop&w=900&q=80" },
  { name: "Torino", image: "https://images.unsplash.com/photo-1608749676846-4d2d8c7c622d?auto=format&fit=crop&w=900&q=80" },
  { name: "Palermo", image: "https://images.unsplash.com/photo-1601397922721-4326ae07bbc5?auto=format&fit=crop&w=900&q=80" },
  { name: "Genova", image: "https://images.unsplash.com/photo-1599689019338-50deb475f380?auto=format&fit=crop&w=900&q=80" },
  { name: "Bologna", image: "https://images.unsplash.com/photo-1555949963-aa79dcee981c?auto=format&fit=crop&w=900&q=80" },
  { name: "Firenze", image: "https://images.unsplash.com/photo-1543429257-3eb0b65d9c58?auto=format&fit=crop&w=900&q=80" },
  { name: "Bari", image: "https://images.unsplash.com/photo-1566221322140-dfcaa0c9fe52?auto=format&fit=crop&w=900&q=80" },
  { name: "Catania", image: "https://images.unsplash.com/photo-1605130284535-11dd9eedc58a?auto=format&fit=crop&w=900&q=80" },
];

function initial(value: string): string {
  const trimmed = value.trim();
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
  // Matches the legacy "sede-principale-23" / "altino-sede1-21" pattern as closely as possible.
  const base = [location.city, location.name].filter(Boolean).join(" ");
  const slugBase = slugify(base || location.name || "sede");
  return `${slugBase}-${location.id}`;
}

export function MarketplaceListFaithful() {
  const [profiles, setProfiles] = useState<MarketplaceProfile[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Stato del treatment picker: SOLO per popolare gli hidden input q/category
  // del form (come il picker legacy) — NON filtra la home. La ricerca avviene
  // sulla pagina /attivita/ricerca dopo il submit (public_marketplace.php: la
  // home mostra SEMPRE tutte le attività, count($profiles)).
  const [query, setQuery] = useState(""); // treatment query (q)
  const [category, setCategory] = useState(""); // selected category
  const [treatmentLabel, setTreatmentLabel] = useState("Tutte le attivita");

  // Treatment dropdown UI state.
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"categories" | "salons" | "services">("categories");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/marketplace");
        const data: MarketplaceResponse = await response.json();
        if (!active) return;
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        setCategories(Array.isArray(data.categories) ? data.categories : []);
      } catch {
        if (active) {
          setProfiles([]);
          setCategories([]);
        }
      } finally {
        if (active) setLoaded(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  // Flatten profiles -> one card per location (legacy behaviour).
  const allCards = useMemo<CardItem[]>(() => {
    const items: CardItem[] = [];
    for (const profile of profiles) {
      const locs = profile.locations?.length ? profile.locations : [];
      for (const location of locs) {
        items.push({
          profile,
          location,
          favoriteKey: `${profile.slug}:${location.id}`,
          locationSlug: locationSlugFor(location),
        });
      }
    }
    return items;
  }, [profiles]);

  function selectCategory(label: string) {
    if (label === "") {
      setCategory("");
      setQuery("");
      setTreatmentLabel("Tutte le attivita");
    } else {
      setCategory(label);
      setQuery("");
      setTreatmentLabel(label);
    }
    setPanelOpen(false);
  }

  function selectSalon(salonQuery: string, label: string) {
    setQuery(salonQuery);
    setCategory("");
    setTreatmentLabel(label);
    setPanelOpen(false);
  }

  const salonOptions = profiles;

  // Effetti legacy: sfondi city-card, preferiti (toggle + stato account),
  // suggerimenti/validazione città sulla hero search. Il picker della hero è
  // già cablato in React (data-marketplace-treatment-ready lo fa saltare).
  useMarketplacePageEffects([profiles]);

  return (
    <>
      {/* Page CSS (verbatim from the original <link>). Inline <style> blocks captured verbatim. */}
      <link rel="stylesheet" href="/assets/css/pages/public_marketplace.css" />
      <style dangerouslySetInnerHTML={{ __html: TOPBAR_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: FOOTER_STYLE }} />

      {/* ===================== TOPBAR ===================== */}
      <header
        className="marketplace-topbar"
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
            <span className="marketplace-topbar__brand-mark">B</span>
            <span>BeautySuite</span>
          </a>
          {/* Menu account cablato (toggle + variante loggata, initAccountMenus legacy). */}
          <MarketplaceAccountNav />
        </div>
      </header>

      {/* ===================== HERO + SEARCH ===================== */}
      <section className="hero">
        <div className="hero-inner">
          <h1>Prenota nelle attivit&agrave; disponibili</h1>
          <p>Cerca un centro per citt&agrave; o trattamento e apri subito la pagina di prenotazione online.</p>
          <form
            className="search-box"
            method="get"
            action="/attivita/ricerca"
            data-marketplace-topbar-search
            onSubmit={() => {
              // Legacy: il form GET naviga alla pagina risultati /attivita/ricerca
              // (la validazione città è cablata da useMarketplacePageEffects).
              setPanelOpen(false);
            }}
          >
            <div
              className="field search-box-treatment-field marketplace-topbar-treatment-field"
              data-marketplace-treatment-picker
              data-marketplace-treatment-ready="1"
            >
              <span className="marketplace-topbar-treatment-kicker">Attivit&agrave; o servizio</span>
              <input type="hidden" name="q" value={query} readOnly data-marketplace-treatment-query />
              <input type="hidden" name="category" value={category} readOnly data-marketplace-treatment-category />
              <input type="hidden" name="service" value="" readOnly data-marketplace-treatment-service />
              <button
                className="marketplace-topbar-treatment-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={panelOpen}
                aria-controls="marketplace-home-treatment-panel"
                data-marketplace-treatment-trigger
                onClick={() => setPanelOpen((open) => !open)}
              >
                <span className="marketplace-topbar-treatment-label" data-marketplace-treatment-label>
                  {treatmentLabel}
                </span>
                <svg className="marketplace-topbar-treatment-chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </button>
              {/* Treatment dropdown: WIRED (open/close, tab switch, option select sets category/query). */}
              <div
                className="marketplace-topbar-treatment-panel"
                id="marketplace-home-treatment-panel"
                hidden={!panelOpen}
                data-marketplace-treatment-panel
              >
                <div className="marketplace-topbar-treatment-tabs" role="tablist" aria-label="Tipo ricerca">
                  <button
                    className={`marketplace-topbar-treatment-tab${activeTab === "categories" ? " is-active" : ""}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "categories"}
                    data-marketplace-treatment-tab="categories"
                    onClick={() => setActiveTab("categories")}
                  >
                    Categorie
                  </button>
                  <button
                    className={`marketplace-topbar-treatment-tab${activeTab === "salons" ? " is-active" : ""}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "salons"}
                    data-marketplace-treatment-tab="salons"
                    onClick={() => setActiveTab("salons")}
                  >
                    Attivit&agrave;
                  </button>
                  <button
                    className={`marketplace-topbar-treatment-tab${activeTab === "services" ? " is-active" : ""}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "services"}
                    data-marketplace-treatment-tab="services"
                    onClick={() => setActiveTab("services")}
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
                  readOnly
                />
                <div className="marketplace-topbar-treatment-lists">
                  <div
                    className="marketplace-topbar-treatment-list"
                    role="listbox"
                    aria-label="Categorie"
                    data-marketplace-treatment-list="categories"
                    hidden={activeTab !== "categories"}
                  >
                    <button
                      className={`marketplace-topbar-treatment-option${category === "" && query === "" ? " is-active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={category === "" && query === ""}
                      data-marketplace-treatment-option
                      data-treatment-category=""
                      data-treatment-query=""
                      data-treatment-service=""
                      data-treatment-label="Tutte le attivita"
                      data-treatment-search="tutte attivita tutti servizi"
                      onClick={() => selectCategory("")}
                    >
                      <span className="marketplace-topbar-treatment-icon">
                        <i className="bi bi-stars" aria-hidden="true"></i>
                      </span>
                      <span className="marketplace-topbar-treatment-copy">
                        <span className="marketplace-topbar-treatment-name">Tutte le attivita</span>
                      </span>
                    </button>
                    {TREATMENT_CATEGORIES.map((item) => (
                      <button
                        key={item.label}
                        className={`marketplace-topbar-treatment-option${category === item.label ? " is-active" : ""}`}
                        type="button"
                        role="option"
                        aria-selected={category === item.label}
                        data-marketplace-treatment-option
                        data-treatment-category={item.label}
                        data-treatment-query=""
                        data-treatment-service=""
                        data-treatment-label={item.label}
                        data-treatment-search={item.search}
                        onClick={() => selectCategory(item.label)}
                      >
                        <span className="marketplace-topbar-treatment-icon">
                          <i className={`bi ${item.icon}`} aria-hidden="true"></i>
                        </span>
                        <span className="marketplace-topbar-treatment-copy">
                          <span className="marketplace-topbar-treatment-name">{item.label}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div
                    className="marketplace-topbar-treatment-list"
                    role="listbox"
                    aria-label="Attivit&agrave;"
                    data-marketplace-treatment-list="salons"
                    hidden={activeTab !== "salons"}
                  >
                    {salonOptions.map((profile) => {
                      const meta = [profile.category, profile.area].filter(Boolean).join(" - ");
                      return (
                        <button
                          key={profile.slug}
                          className={`marketplace-topbar-treatment-option${query === profile.name ? " is-active" : ""}`}
                          type="button"
                          role="option"
                          aria-selected={query === profile.name}
                          data-marketplace-treatment-option
                          data-treatment-category=""
                          data-treatment-query={profile.name}
                          data-treatment-service=""
                          data-treatment-label={profile.name}
                          data-treatment-search={`${profile.name} ${meta}`}
                          onClick={() => selectSalon(profile.name, profile.name)}
                        >
                          <span className="marketplace-topbar-treatment-avatar">{initial(profile.name)}</span>
                          <span className="marketplace-topbar-treatment-copy">
                            <span className="marketplace-topbar-treatment-name">{profile.name}</span>
                            {meta ? <span className="marketplace-topbar-treatment-meta">{meta}</span> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div
                    className="marketplace-topbar-treatment-list"
                    role="listbox"
                    aria-label="Servizi"
                    data-marketplace-treatment-list="services"
                    hidden={activeTab !== "services"}
                  ></div>
                </div>
                <div className="marketplace-topbar-treatment-empty" data-marketplace-treatment-empty>
                  Nessun risultato.
                </div>
              </div>
            </div>
            <div className="field search-box-city-field">
              <label htmlFor="marketplace-home-city">Dove</label>
              {/* Input NON controllato: i suggerimenti città e la validazione
                  'Seleziona una città dalla lista.' sono cablati dal DOM
                  (useMarketplacePageEffects), come il legacy. */}
              <input
                id="marketplace-home-city"
                type="search"
                name="city"
                defaultValue=""
                placeholder="La tua citt&agrave;"
                autoComplete="off"
                data-marketplace-topbar-city-input
              />
              {/* Suggerimenti città popolati dal DOM effect (initCitySuggestions). */}
              <div
                className="search-box-city-suggestions"
                role="listbox"
                aria-label="Citt&agrave; suggerite"
                hidden
                data-marketplace-topbar-city-suggestions
              ></div>
            </div>
            <button type="submit">Cerca</button>
          </form>
        </div>
      </section>

      {/* ===================== RESULTS ===================== */}
      <main className="wrap">
        <div className="section-head">
          <h2>Servizi pi&ugrave; cercati</h2>
          <p>Filtra le attivit&agrave; pubblicate in base alle categorie configurate.</p>
        </div>
        {/* Legacy: le chips NAVIGANO alla pagina risultati; sulla home 'Tutti'
            è sempre active (nessun filtro applicato). */}
        <div className="chips">
          <a className="chip active" href="/attivita/ricerca">
            Tutti
          </a>
          {(categories.length ? categories : TREATMENT_CATEGORIES.map((c) => c.label)).map((label) => (
            <a key={label} className="chip" href={`/attivita/ricerca?category=${encodeURIComponent(label)}`}>
              {label}
            </a>
          ))}
        </div>

        <div className="section-head">
          <h2>Le nostre attivit&agrave;</h2>
          {/* Legacy: la home mostra SEMPRE tutte le attività (count($profiles)). */}
          <p>{allCards.length} risultato/i disponibili.</p>
        </div>

        <div className="grid">
          {allCards.map((card) => {
            const { profile, location, favoriteKey, locationSlug } = card;
            // Legacy: la card sede linka la SCHEDA SEDE /attivita/<slug>/sedi/<loc-slug>.
            const schedaHref = `/attivita/${profile.slug}/sedi/${encodeURIComponent(locationSlug)}`;
            // Gate-driven come il PHP: non loggato -> /account/login CLIENTE,
            // loggato -> wizard (senza hop dal login).
            const prenotaHref = `/${encodeURIComponent(profile.slug)}/booking?start=1&location_id=${location.id}`;
            const addressBits = [location.address, location.city].filter(Boolean).join(" ");
            return (
              <article className="tenant-card" key={favoriteKey}>
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
                <a className="tenant-media" href={schedaHref}>
                  {location.name}
                </a>
                <div className="tenant-body">
                  <div className="tenant-title">
                    <span className="tenant-logo">{initial(profile.name)}</span>
                    <div>
                      <h3>{location.name}</h3>
                      <div className="meta tenant-card-subtitle">{profile.name}</div>
                    </div>
                  </div>
                  <div className="meta">
                    {addressBits ? <span>{addressBits}</span> : null}
                    {/* Legacy: categoria ATTIVITÀ della sede (es. 'Unghie'),
                        non la categoria servizi. */}
                    {location.categoryText ? <span>{location.categoryText}</span> : null}
                  </div>
                  <div className="card-actions">
                    <a className="btn btn-primary" href={prenotaHref}>
                      Prenota
                    </a>
                    <a className="btn" href={schedaHref}>
                      Scheda
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {loaded && allCards.length === 0 ? (
          <div className="empty">
            <h3>Nessuna attivit&agrave; pubblicata</h3>
            <p>Configura la visibilit&agrave; marketplace da Profilo attività per far comparire i centri in questa pagina.</p>
          </div>
        ) : null}

        {/* City-discovery grid: faithful-but-static (navigation links only). */}
        <section className="city-discovery" aria-labelledby="featuredCitiesTitle">
          <div className="section-head">
            <h2 id="featuredCitiesTitle">
              Vai alla scoperta delle nostre attivit&agrave; nella tua citt&agrave;
            </h2>
            <p>Parti dalle principali citt&agrave; italiane e trova subito i centri pubblicati.</p>
          </div>
          <div className="city-grid">
            {DISCOVERY_CITIES.map((cityItem) => (
              <a
                key={cityItem.name}
                className="city-card"
                href={`/attivita/ricerca?city=${encodeURIComponent(cityItem.name)}`}
                data-city-image={cityItem.image}
              >
                <span>{cityItem.name}</span>
              </a>
            ))}
          </div>
        </section>

        {/* App + Partner CTAs: faithful-but-static (decorative). */}
        <div className="marketplace-cta-stack">
          <section className="app-cta" aria-labelledby="marketplaceAppTitle">
            <div className="app-cta__copy">
              <h2 id="marketplaceAppTitle">Scarica la nostra app</h2>
              <p>Prenota il tuo prossimo trattamento di bellezza in pochi clic.</p>
              <a className="btn app-cta__button" href="/account/login?return=%2Fattivita">
                Scarica subito
              </a>
            </div>
            <div className="app-cta__visual" aria-hidden="true">
              <span className="app-wave"></span>
              <span className="map-pin pin-1"></span>
              <span className="map-pin pin-2 is-green"></span>
              <span className="map-pin pin-3"></span>
              <span className="map-pin pin-4 is-green"></span>
              <span className="map-pin pin-5"></span>
              <span className="map-pin pin-6 is-green"></span>
              <span className="map-pin pin-7"></span>
              <span className="map-pin pin-8"></span>
              <span className="app-phone"></span>
              <span className="app-hand"></span>
            </div>
          </section>

          <section className="partner-cta" id="promuovi-attivita" aria-labelledby="partnerCtaTitle">
            <span className="partner-curve" aria-hidden="true"></span>
            <div className="partner-cta__copy">
              <h2 id="partnerCtaTitle">
                Hai un&apos;attivit&agrave; di bellezza?
                <br />
                Portala online.
              </h2>
              <p>
                Ti aiutiamo a gestire agenda, clienti e prenotazioni online con strumenti semplici per far
                crescere il tuo centro.
              </p>
              <a className="btn partner-cta__button" href="/account/login?return=%2Fattivita">
                Diventa nostro Partner
              </a>
            </div>
            <div className="partner-cta__visual" aria-hidden="true">
              <div className="calendar-board">
                <div className="calendar-board__top">
                  <span>Sarah&apos;s Day Spa</span>
                  <span className="calendar-dots">
                    <span>Febbraio 2026</span>
                    <span>30%</span>
                  </span>
                </div>
                <div className="calendar-grid">
                  <span className="calendar-cell">
                    <span className="calendar-avatar"></span>
                    <span className="calendar-event"></span>
                  </span>
                  <span className="calendar-cell">
                    <span className="calendar-avatar"></span>
                    <span className="calendar-event is-muted"></span>
                  </span>
                  <span className="calendar-cell">
                    <span className="calendar-avatar"></span>
                    <span className="calendar-event"></span>
                  </span>
                  <span className="calendar-cell">
                    <span className="calendar-avatar"></span>
                    <span className="calendar-event is-muted"></span>
                  </span>
                  <span className="calendar-cell">
                    <span className="calendar-avatar"></span>
                    <span className="calendar-event"></span>
                  </span>
                </div>
              </div>
              <div className="phone-board">
                <div className="phone-board__top"></div>
                <div className="phone-event"></div>
                <div className="phone-event"></div>
              </div>
              <div className="notify-card">
                <strong>Nuova prenotazione</strong>
                Hai ricevuto una richiesta per domani alle 17:00.
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ===================== FOOTER ===================== */}
      <footer className="marketplace-footer">
        <div className="marketplace-footer__inner">
          <div className="marketplace-footer__grid">
            <section aria-labelledby="marketplaceFooterInfoTitle">
              <h2 id="marketplaceFooterInfoTitle">Informazioni</h2>
              <nav className="marketplace-footer__links" aria-label="Informazioni">
                <a href="/attivita">Cerca attivit&agrave;</a>
                <a href="/account/login">Accedi</a>
                <a href="/#promuovi-attivita">Iscrizione aziende</a>
                <a href="#">Chi siamo</a>
                <a href="#">Contatta</a>
                <a href="#">Note legali</a>
                <a href="#">Informativa sulla privacy</a>
                <a href="#">Informativa sui cookie</a>
                <a href="#">Gestisci preferenze</a>
              </nav>
            </section>

            <section aria-labelledby="marketplaceFooterAppTitle">
              <h2 id="marketplaceFooterAppTitle">Scarica l&apos;app</h2>
              <div className="marketplace-footer__app">
                <span className="marketplace-footer__app-icon" aria-hidden="true">
                  B
                </span>
                <p>Prenota il tuo prossimo trattamento di bellezza quando e dove vuoi.</p>
              </div>
              <div className="marketplace-footer__stores" aria-label="Link app">
                <a className="marketplace-footer__store" href="/account/login?return=%2Fattivita">
                  <small>Scarica su</small>
                  <strong>App Store</strong>
                </a>
                <a className="marketplace-footer__store" href="/account/login?return=%2Fattivita">
                  <small>Disponibile su</small>
                  <strong>Google Play</strong>
                </a>
              </div>
            </section>

            <section aria-labelledby="marketplaceFooterSocialTitle">
              <h2 id="marketplaceFooterSocialTitle">Seguici su</h2>
              <div className="marketplace-footer__social">
                <a className="marketplace-footer__social-link" href="#" aria-label="Facebook">
                  f
                </a>
                <a className="marketplace-footer__social-link" href="#" aria-label="X">
                  X
                </a>
                <a className="marketplace-footer__social-link" href="#" aria-label="Pinterest">
                  P
                </a>
                <a className="marketplace-footer__social-link" href="#" aria-label="Instagram">
                  IG
                </a>
                <a className="marketplace-footer__social-link" href="#" aria-label="YouTube">
                  YT
                </a>
                <a className="marketplace-footer__social-link" href="#" aria-label="TikTok">
                  TK
                </a>
              </div>
            </section>

            <section aria-labelledby="marketplaceFooterCountryTitle">
              <h2 id="marketplaceFooterCountryTitle">Seleziona un paese</h2>
              <button className="marketplace-footer__country" type="button">
                <span>
                  <i className="marketplace-footer__flag" aria-hidden="true"></i>Italia
                </span>
                <i className="marketplace-footer__chevron" aria-hidden="true"></i>
              </button>
            </section>
          </div>

          <div className="marketplace-footer__bottom">
            <div className="marketplace-footer__brand">
              <span className="marketplace-footer__brand-mark">BeautySuite</span>
              <span>&copy; 2026 BeautySuite</span>
            </div>
            <span>Cerca attivit&agrave;, scegli il centro e prenota online.</span>
          </div>
        </div>
      </footer>
    </>
  );
}

export default MarketplaceListFaithful;
