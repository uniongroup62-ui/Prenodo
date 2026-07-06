"use client";

/*
 * MarketplaceDetailFaithful
 * -------------------------
 * Pixel-faithful Next.js (React 19) port of the legacy PHP public marketplace
 * ACTIVITY DETAIL page served by the BeautySuite/Prenodo backend at
 *   http://localhost/attivita/<slug>      (e.g. /attivita/centroesteticoelite)
 *
 * Fidelity approach
 * - The legacy page ships TWO inline <style> blocks in <head> (the marketplace
 *   topbar styles and the marketplace footer styles) PLUS a linked stylesheet
 *   /assets/css/pages/public_marketplace.css (which carries the :root design
 *   tokens, body styles and ALL the .salon-* activity-profile styles).
 * - Both inline <style> blocks below are reproduced VERBATIM from the captured
 *   HTML (only wrapped in a TS template literal). The linked stylesheet is loaded
 *   via <link>. The :root tokens (--brand, --marketplace-page-pad, etc.) live in
 *   that linked file, so once it loads the topbar/footer CSS-var references and
 *   the .salon-* styling resolve exactly as on the PHP page.
 * - The topbar header, the activity profile (hero/branding + services modal +
 *   services list), the booking-side aside (book CTA, opening hours, address,
 *   phone) and the footer all use the ORIGINAL class names, markup and icons.
 *
 * Data
 * - Slug is read from window.location.pathname.split('/')[2] (route /attivita/[slug]).
 * - Live data comes from:
 *     GET /api/marketplace                                  -> { profiles, categories }
 *     GET /api/booking?action=context&slug=<slug>           -> { context: { business, locations, categories, services, staff } }
 *   The profile (name/area/rating/reviews/image) is matched by slug from the
 *   marketplace list; the booking context drives services (grouped by category),
 *   the opening-hours sidebar, address and phone, and the booking CTA target.
 *
 * Interactivity
 * - Heavy interactivity from the original public_marketplace.js (topbar treatment
 *   dropdown, city suggestions, account menu, services modal open/close, share and
 *   favorite toggles) is reproduced FAITHFUL-BUT-STATIC: the markup, classes and
 *   icons are present (so it looks identical) but the JS behaviours are not wired.
 *   The services modal is rendered inline (always visible in the profile flow,
 *   matching the static markup) and the "Servizi" quick-action / modal close are
 *   inert. The booking CTAs are real links to /<slug>/booking.
 */

import { useEffect, useMemo, useState } from "react";
import { MarketplaceAccountNav, useMarketplacePageEffects } from "@/components/public/marketplace-shared";

type BookingService = {
  id: number;
  name: string;
  description: string;
  categoryId: number | null;
  duration: number;
  price: number;
  noOperator?: boolean;
  locationIds: number[];
};

type BookingCategory = { id: number; name: string };

type BookingLocation = {
  id: number;
  name: string;
  address: string;
  email: string;
  phone: string;
  bookingEnabled: boolean;
  hoursToday: string;
};

type BookingContext = {
  business: { name: string; about: string; email: string; phone: string; website: string };
  locations: BookingLocation[];
  categories: BookingCategory[];
  services: BookingService[];
  staff: Array<{ id: number; name: string; serviceIds: number[]; active: boolean }>;
  today: string;
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
  locations: Array<{ id: number; name: string; city: string; area: string; address: string }>;
};

// Reproduced VERBATIM from the captured <head> inline <style> blocks of
// http://localhost/attivita/centroesteticoelite (topbar block + footer block).
export const TOPBAR_STYLE = `.marketplace-topbar{--marketplace-topbar-brand:#4e6da6;--marketplace-topbar-brand-dark:#365287;--marketplace-topbar-ink:#0f172a;--marketplace-topbar-muted:#64748b;--marketplace-topbar-line:#dbe3ef;--marketplace-topbar-soft:#eef4ff;--marketplace-topbar-pad:clamp(18px,5vw,72px);--marketplace-topbar-max:none;--marketplace-topbar-search-width:900px;--marketplace-topbar-search-reserve:560px;height:68px;background:#fff;border-bottom:1px solid var(--marketplace-topbar-line);padding:0 var(--marketplace-topbar-pad);position:sticky;top:0;z-index:30;color:var(--marketplace-topbar-ink)}
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
@media (max-width:560px){.marketplace-topbar-search{grid-template-columns:1fr 38px;height:auto;border-radius:18px}.marketplace-topbar-search__field + .marketplace-topbar-search__field{border-left:0;border-top:1px solid var(--marketplace-topbar-line)}.marketplace-topbar-search__field:nth-child(2){grid-column:1/2}.marketplace-topbar-search > button[type="submit"]{grid-column:2;grid-row:1/3;width:38px;height:38px;margin-right:5px}.marketplace-topbar-city-suggestions{left:0;right:46px}}`;

export const FOOTER_STYLE = `.marketplace-footer{border-top:1px solid var(--line,#dbe3ef);background:#f3f5f8;color:#475569;padding:56px var(--marketplace-page-pad,clamp(18px,2.8vw,40px)) 34px}
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
@media (max-width:640px){.marketplace-footer{padding-top:38px}.marketplace-footer__grid{grid-template-columns:1fr}.marketplace-footer__bottom{align-items:flex-start;flex-direction:column}.marketplace-footer__app{grid-template-columns:1fr}.marketplace-footer__app-icon{width:46px;height:46px}.marketplace-footer__stores{display:grid;grid-template-columns:1fr 1fr}.marketplace-footer__store{min-width:0}}`;

// :root tokens normally live in the linked public_marketplace.css. We re-declare
// the handful the topbar/footer markup depends on so the component renders
// faithfully even before/without that file (it is also loaded via <link>).
export const TOKEN_STYLE = `:root{--brand:#4e6da6;--brand-dark:#365287;--ink:#0f172a;--muted:#64748b;--line:#dbe3ef;--bg:#f4f7fb;--card:#fff;--soft:#eef4ff;--marketplace-page-max:1440px;--marketplace-page-pad:clamp(18px,2.8vw,40px);--marketplace-shell-max:calc(var(--marketplace-page-max) + var(--marketplace-page-pad) + var(--marketplace-page-pad))}`;

// The legacy topbar category dropdown (verbatim category list + Bootstrap-icon
// names, exactly as emitted by the PHP page).
export const TOPBAR_CATEGORIES: Array<{ category: string; icon: string; label: string; slug: string }> = [
  { category: "Parrucchiere", icon: "bi-scissors", label: "Parrucchiere", slug: "parrucchiere" },
  { category: "Salone di bellezza", icon: "bi-shop", label: "Salone di bellezza", slug: "salone-bellezza" },
  { category: "Estetista", icon: "bi-stars", label: "Estetista", slug: "estetista" },
  { category: "Barbiere", icon: "bi-person-badge", label: "Barbiere", slug: "barbiere" },
  { category: "Unghie", icon: "bi-hand-index-thumb", label: "Unghie", slug: "unghie" },
  { category: "Sopracciglia e ciglia", icon: "bi-eye", label: "Sopracciglia e ciglia", slug: "sopracciglia-ciglia" },
  { category: "Centro epilazione", icon: "bi-magic", label: "Centro epilazione", slug: "centro-epilazione" },
  { category: "Massaggi", icon: "bi-person-heart", label: "Massaggi", slug: "massaggi" },
  { category: "Spa e sauna", icon: "bi-water", label: "Spa e sauna", slug: "spa-sauna" },
  { category: "MedSpa", icon: "bi-gem", label: "MedSpa", slug: "medspa" },
  { category: "Centro abbronzatura", icon: "bi-brightness-high", label: "Centro abbronzatura", slug: "centro-abbronzatura" },
  { category: "Tatuaggi e piercing", icon: "bi-gem", label: "Tatuaggi e piercing", slug: "tatuaggi-piercing" },
  { category: "Fisioterapia", icon: "bi-heart-pulse", label: "Fisioterapia", slug: "fisioterapia" },
  { category: "Fitness e recupero", icon: "bi-bicycle", label: "Fitness e recupero", slug: "fitness-recupero" },
  { category: "Centro sanitario", icon: "bi-hospital", label: "Centro sanitario", slug: "centro-sanitario" },
  { category: "Toelettatura animali", icon: "bi-gem", label: "Toelettatura animali", slug: "toelettatura-animali" },
];

const WEEK_DAYS = ["lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica"];

function formatPrice(value: number): string {
  // Mirrors the PHP "€ 12,00" formatting.
  return `€ ${value.toFixed(2).replace(".", ",")}`;
}

function initialOf(value: string): string {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

function readSlugFromPath(): string {
  if (typeof window === "undefined") return "";
  const parts = window.location.pathname.split("/");
  // route is /attivita/[slug] -> parts[2]. Resolve the tenant from the URL only —
  // never default to a specific center.
  return (parts[2] || "").trim();
}

export function MarketplaceDetailFaithful({ slug: slugProp, locationId: locationIdProp }: { slug?: string; locationId?: number } = {}) {
  const [slug, setSlug] = useState<string>(slugProp ?? "");
  const [context, setContext] = useState<BookingContext | null>(null);
  const [profile, setProfile] = useState<MarketplaceProfile | null>(null);

  useEffect(() => {
    if (slugProp) return;
    setSlug(readSlugFromPath());
  }, [slugProp]);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [ctxRes, mkRes] = await Promise.all([
          fetch(`/api/booking?action=context&slug=${encodeURIComponent(slug)}`, { cache: "no-store" }),
          fetch(`/api/marketplace`, { cache: "no-store" }),
        ]);
        const ctxData = await ctxRes.json().catch(() => null);
        const mkData = await mkRes.json().catch(() => null);
        if (!active) return;
        if (ctxData?.ok && ctxData.context) setContext(ctxData.context as BookingContext);
        if (mkData?.ok && Array.isArray(mkData.profiles)) {
          const match = (mkData.profiles as MarketplaceProfile[]).find((p) => p.slug === slug) ?? null;
          setProfile(match);
        }
      } catch {
        // Faithful-but-static fallback: render placeholders below.
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [slug]);

  const business = context?.business;
  const locations = context?.locations ?? [];
  const services = context?.services ?? [];
  const categories = context?.categories ?? [];
  // Scheda SEDE (/attivita/<slug>/sedi/<loc-slug>): la sede richiesta guida
  // booking link/indirizzo/preferiti; fallback alla prima come il legacy.
  const primaryLocation = (locationIdProp ? locations.find((loc) => loc.id === locationIdProp) : undefined) ?? locations[0];

  const businessName = business?.name || profile?.name || "Attivita";
  // Legacy: il <title> della scheda è il NOME attività (es. "elite"), non lo
  // slug. Il nome arriva client-side dal context, quindi aggiorno il titolo.
  useEffect(() => {
    if (typeof document !== "undefined" && businessName && businessName !== "Attivita") {
      document.title = businessName;
    }
  }, [businessName]);
  const locationId = primaryLocation?.id
    ?? (locationIdProp && profile?.locations?.some((loc) => loc.id === locationIdProp) ? locationIdProp : undefined)
    ?? profile?.locations?.[0]?.id
    ?? 0;

  // Group services by category (mirrors the PHP salon-service-group layout).
  const serviceGroups = useMemo(() => {
    const byCategory = new Map<number, { category: BookingCategory; items: BookingService[] }>();
    for (const service of services) {
      const catId = service.categoryId ?? 0;
      const cat = categories.find((c) => c.id === catId) ?? { id: catId, name: service.name };
      if (!byCategory.has(catId)) byCategory.set(catId, { category: cat, items: [] });
      byCategory.get(catId)!.items.push(service);
    }
    return Array.from(byCategory.values());
  }, [services, categories]);

  const serviceCount = services.length;
  const serviceCountLabel = `${serviceCount} ${serviceCount === 1 ? "servizio disponibile" : "servizi disponibili"}`;

  // Booking CTA target in the Next app (route /<slug>/booking).
  const bookHref = `/${slug}/booking`;
  function bookServiceHref(serviceId: number): string {
    return `/${slug}/booking?start=1&location_id=${locationId}&service_ids=${serviceId}`;
  }

  // Address line (PHP joins "address, city, area").
  const addressLine = primaryLocation?.address
    || [profile?.locations?.[0]?.address, profile?.area].filter(Boolean).join(", ")
    || "";
  const phone = primaryLocation?.phone || business?.phone || "";

  // Today's index (0 = Monday) for the weekly hours "is-today" highlight.
  const todayIndex = (() => {
    const jsDay = new Date().getDay(); // 0 Sun..6 Sat
    return (jsDay + 6) % 7; // 0 Mon..6 Sun
  })();
  const todayRange = (() => {
    const raw = primaryLocation?.hoursToday || "";
    // hoursToday looks like "Oggi 09:00 - 19:00"; strip the leading "Oggi".
    return raw.replace(/^Oggi\s*/i, "").trim() || "09:00 - 19:00";
  })();

  // Effetti legacy: treatment picker della topbar, suggerimenti/validazione
  // città, condivisione scheda (copy), preferiti.
  useMarketplacePageEffects([context, profile]);

  return (
    <>
      {/* Inline styles reproduced verbatim from the PHP <head> + design tokens. */}
      <style dangerouslySetInnerHTML={{ __html: TOKEN_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: TOPBAR_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: FOOTER_STYLE }} />
      {/* The activity-profile (.salon-*) styles + body/:root come from this file. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/pages/public_marketplace.css" />

      {/* ===================== TOPBAR ===================== */}
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
            <span className="marketplace-topbar__brand-mark">B</span>
            <span>BeautySuite</span>
          </a>
          {/* Static-but-faithful: the topbar treatment dropdown / city suggestions
              behaviours from public_marketplace.js are not wired. */}
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
                aria-controls="marketplace-topbar-treatment-panel"
                data-marketplace-treatment-trigger
              >
                <span className="marketplace-topbar-treatment-label" data-marketplace-treatment-label>
                  Tutte le attivita
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
                  <div className="marketplace-topbar-treatment-list" role="listbox" aria-label="Attivita" data-marketplace-treatment-list="salons" hidden>
                    <button
                      className="marketplace-topbar-treatment-option"
                      type="button"
                      role="option"
                      aria-selected="false"
                      data-marketplace-treatment-option
                      data-treatment-category=""
                      data-treatment-query={businessName}
                      data-treatment-service=""
                      data-treatment-label={businessName}
                      data-treatment-search={`${businessName} ${addressLine}`}
                    >
                      <span className="marketplace-topbar-treatment-avatar">{initialOf(businessName)}</span>
                      <span className="marketplace-topbar-treatment-copy">
                        <span className="marketplace-topbar-treatment-name">{businessName}</span>
                        <span className="marketplace-topbar-treatment-meta">{addressLine}</span>
                      </span>
                    </button>
                  </div>
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
                defaultValue=""
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
          {/* Menu account cablato (toggle + variante loggata, initAccountMenus legacy). */}
          <MarketplaceAccountNav />
        </div>
      </header>

      {/* ===================== PROFILE ===================== */}
      <main className="wrap">
        <div className="salon-detail-layout">
          <div className="salon-profile">
            <section className="salon-hero">
              <div className="salon-hero-actions">
                {/* Static-but-faithful: share/favorite toggles are not wired. */}
                <button
                  className="favorite-button share-button salon-share-button"
                  type="button"
                  data-share-button
                  data-share-title={businessName}
                  data-share-text={`Scopri la scheda di ${businessName} su BeautySuite.`}
                  aria-label="Condividi scheda"
                  title="Condividi scheda"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 3v12"></path>
                    <path d="m7 8 5-5 5 5"></path>
                    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path>
                  </svg>
                </button>
                <button
                  className="favorite-button salon-favorite-button"
                  type="button"
                  data-favorite-button
                  data-favorite-key={`${slug}:${locationId}`}
                  data-tenant-slug={slug}
                  data-location-id={locationId}
                  aria-label="Aggiungi ai preferiti"
                  aria-pressed="false"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M20.8 4.6c-1.7-1.8-4.5-1.8-6.2 0L12 7.2 9.4 4.6c-1.7-1.8-4.5-1.8-6.2 0-1.8 1.9-1.7 4.9.1 6.7L12 20l8.7-8.7c1.8-1.8 1.9-4.8.1-6.7z"></path>
                  </svg>
                </button>
              </div>
              <div className="salon-cover">Copertina attività</div>
              <div className="salon-logo">{initialOf(businessName)}</div>
              <h1 className="salon-name">{businessName}</h1>
            </section>

            <section className="salon-quick-actions is-single" aria-label="Consulta attività">
              {/* Static-but-faithful: opens the services modal in the original JS. */}
              <button className="salon-action-button" type="button" data-salon-services-open>
                <span className="salon-action-copy">
                  <strong>Servizi</strong>
                  <span>{serviceCountLabel}</span>
                </span>
                <span className="salon-action-arrow" aria-hidden="true">
                  &rsaquo;
                </span>
              </button>
            </section>

            {/* Services modal markup (rendered inline; modal open/close is static). */}
            <div
              className="salon-modal"
              id="salonServicesModal"
              role="dialog"
              aria-modal="true"
              aria-hidden="true"
              aria-labelledby="salonServicesModalTitle"
            >
              <button className="salon-modal__backdrop" type="button" data-salon-services-close aria-label="Chiudi servizi"></button>
              <div className="salon-modal__panel">
                <div className="salon-modal__head">
                  <div className="salon-modal__title">
                    <h2 id="salonServicesModalTitle">Servizi</h2>
                    <p>Scegli una categoria e prenota il trattamento desiderato.</p>
                  </div>
                  <button className="salon-modal__close" type="button" data-salon-services-close aria-label="Chiudi">
                    &times;
                  </button>
                </div>
                <div className="salon-modal__layout">
                  <nav className="salon-modal-category-list" aria-label="Categorie servizi">
                    {serviceGroups.map((group) => (
                      <a
                        key={group.category.id}
                        className="salon-modal-category-link"
                        href={`#salon-service-cat-cat-${group.category.id}`}
                      >
                        {group.category.name}
                        <span>{group.items.length}</span>
                      </a>
                    ))}
                  </nav>
                  <div className="salon-service-groups">
                    {serviceGroups.length === 0 ? (
                      <p className="salon-service-empty">Nessun servizio disponibile.</p>
                    ) : (
                      serviceGroups.map((group) => (
                        <section
                          key={group.category.id}
                          className="salon-service-group"
                          id={`salon-service-cat-cat-${group.category.id}`}
                        >
                          <h3 className="salon-service-group-title">{group.category.name}</h3>
                          <div className="salon-service-group-list">
                            {group.items.map((service) => (
                              <article className="salon-service-card" key={service.id}>
                                <div className="salon-service-copy">
                                  <h4 className="salon-service-name">{service.name}</h4>
                                  {service.duration ? (
                                    <div className="salon-service-meta">{service.duration} min</div>
                                  ) : null}
                                  <div className="salon-service-pricing">
                                    {service.price ? (
                                      <span className="salon-service-price">{formatPrice(service.price)}</span>
                                    ) : null}
                                  </div>
                                </div>
                                <a className="btn salon-service-book" href={bookServiceHref(service.id)}>
                                  Prenota
                                </a>
                              </article>
                            ))}
                          </div>
                        </section>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="salon-booking-side" aria-label="Prenotazione e informazioni sede">
            <a className="btn btn-primary salon-side-book" href={bookHref}>
              Prenota ora
            </a>

            <div className="salon-side-divider"></div>

            <section className="salon-side-block">
              <div className="salon-side-heading">Orari</div>
              <div className="salon-week-list">
                {WEEK_DAYS.map((day, index) => {
                  const isToday = index === todayIndex;
                  const isClosed = index === 6; // domenica closed in the captured page
                  return (
                    <div key={day} className={`salon-week-row${isToday ? " is-today" : ""}`}>
                      <span className={`salon-week-dot${isClosed ? " is-closed" : ""}`} aria-hidden="true"></span>
                      <span className="salon-week-day">{day}</span>
                      <span className="salon-week-time">{isClosed ? "Chiuso" : todayRange}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            {addressLine ? (
              <section className="salon-side-info">
                <div className="salon-side-info-title">Indirizzo</div>
                <div>{addressLine}</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine)}`}
                  target="_blank"
                  rel="noopener"
                >
                  Ottieni indicazioni
                </a>
              </section>
            ) : null}

            {phone ? (
              <section className="salon-contact-actions" aria-label="Contatti sede">
                <a className="salon-contact-phone" href={`tel:${phone}`} aria-label={`Chiama ${phone}`} title="Telefono">
                  <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.654 1.328a.678.678 0 0 0-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.568 17.568 0 0 0 4.168 6.608 17.569 17.569 0 0 0 6.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 0 0-.063-1.015l-2.307-1.794a.678.678 0 0 0-.58-.122l-2.19.547a1.745 1.745 0 0 1-1.657-.459L5.482 8.062a1.745 1.745 0 0 1-.46-1.657l.548-2.19a.678.678 0 0 0-.122-.58L3.654 1.328Z" />
                  </svg>
                  <span>{phone}</span>
                </a>
              </section>
            ) : null}
          </aside>
        </div>
      </main>

      {/* ===================== FOOTER ===================== */}
      <footer className="marketplace-footer">
        <div className="marketplace-footer__inner">
          <div className="marketplace-footer__grid">
            <section aria-labelledby="marketplaceFooterInfoTitle">
              <h2 id="marketplaceFooterInfoTitle">Informazioni</h2>
              <nav className="marketplace-footer__links" aria-label="Informazioni">
                <a href="/attivita">Cerca attivita</a>
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
            <span>Cerca attivita, scegli il centro e prenota online.</span>
          </div>
        </div>
      </footer>
    </>
  );
}

export default MarketplaceDetailFaithful;
