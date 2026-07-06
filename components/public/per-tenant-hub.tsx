"use client";

import { useEffect, useMemo, useState } from "react";
import { TOPBAR_STYLE, TOPBAR_CATEGORIES, FOOTER_STYLE, TOKEN_STYLE } from "@/components/public/marketplace-detail-faithful";
import { useMarketplacePageEffects } from "@/components/public/marketplace-shared";
import {
  AppointmentsView,
  PackagesView,
  PrepaidsView,
  CreditView,
  GiftcardsView,
  GiftsView,
  FidelityView,
  PreordersView,
  QuotesView,
  type CustomerAppointment,
  type CustomerPackage,
  type CustomerQuote,
  type CustomerCreditSection,
  type CustomerGiftcard,
  type CustomerPrepaid,
  type CustomerGift,
  type CustomerFidelitySection,
  type CustomerPreorder,
} from "@/components/public/hub-sections";

// Port fedele dell'HUB PER-SEDE dell'area cliente legacy
// (booking.php?public=1&hub=1 + sezioni my/credit/giftcards/packs/prepaids/
// giftboxes/preorders/quotes/fidelity/gifts, shell in BookingPublicUi.php
// booking_public_ui_render_dashboard_shell_start). È la dashboard "residui"
// del cliente presso UNA attività: topbar marketplace + sidebar 220px con le
// 11 voci + landing "Ciao 👋". I dati arrivano da /api/account (aggregato su
// tutte le attività collegate) filtrati sul tenant corrente. NON è l'account
// cliente CENTRALE (Attività/Preferiti/Profilo = AccountFaithful, /account/*).

export type HubSection =
  | "hub"
  | "my"
  | "credit"
  | "giftcards"
  | "packs"
  | "prepaids"
  | "preorders"
  | "quotes"
  | "fidelity"
  | "gifts";

type PublicCustomer = {
  id: number;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
};

type AccountResponse = {
  ok: boolean;
  error?: string;
  message?: string;
  user?: PublicCustomer | null;
  appointments?: CustomerAppointment[];
  packages?: CustomerPackage[];
  quotes?: CustomerQuote[];
  credit?: CustomerCreditSection[];
  giftcards?: CustomerGiftcard[];
  prepaids?: CustomerPrepaid[];
  gifts?: CustomerGift[];
  fidelity?: CustomerFidelitySection[];
  preorders?: CustomerPreorder[];
};

// Voci della sidebar (booking_public_ui_dashboard_menu): etichette/icone/ordine
// identici al legacy. Nel Next l'URL è /<slug>/booking?<key>=1 (gate cliente).
const HUB_MENU: Array<{ key: HubSection; label: string; icon: string }> = [
  { key: "hub", label: "Dashboard", icon: "bi-person-square" },
  { key: "my", label: "Prenotazioni", icon: "bi-calendar-check" },
  { key: "credit", label: "Credito", icon: "bi-wallet2" },
  { key: "giftcards", label: "GiftCard", icon: "bi-credit-card-2-front" },
  { key: "packs", label: "Pacchetti", icon: "bi-box-seam" },
  { key: "prepaids", label: "Prepagati", icon: "bi-ticket-perforated" },
  { key: "preorders", label: "Preordini", icon: "bi-bag-check" },
  { key: "quotes", label: "Preventivi", icon: "bi-file-earmark-text" },
  { key: "fidelity", label: "Fidelity", icon: "bi-stars" },
  { key: "gifts", label: "Omaggi", icon: "bi-gift" },
];

// Sottotitolo hero legacy per sezione (booking.php dashboardShellBase page_subtitle).
const SECTION_META: Record<HubSection, { title: string; subtitle: string }> = {
  hub: { title: "Dashboard", subtitle: "Gestisci prenotazioni, credito, GiftCard, pacchetti, prepagati, GiftBox e vantaggi del tuo account." },
  my: { title: "Prenotazioni", subtitle: "Le prenotazioni effettuate presso il centro." },
  credit: { title: "Credito", subtitle: "Il credito disponibile presso il centro." },
  giftcards: { title: "GiftCard", subtitle: "Le GiftCard a te intestate presso il centro." },
  packs: { title: "Pacchetti", subtitle: "I pacchetti acquistati presso il centro." },
  prepaids: { title: "Prepagati", subtitle: "I servizi prepagati acquistati presso il centro." },
  preorders: { title: "Preordini", subtitle: "I prodotti ordinati presso il centro." },
  quotes: { title: "Preventivi", subtitle: "I preventivi ricevuti dal centro." },
  fidelity: { title: "Fidelity", subtitle: "I punti Fidelity maturati presso il centro." },
  gifts: { title: "Omaggi", subtitle: "Gli omaggi maturati presso il centro." },
};

// CSS della shell booking-public-account (BookingPublicUi.php 161-289), adattato:
// le classi topbar marketplace (booking-marketplace-*) sono sostituite dal chip
// marketplace-account-* di TOPBAR_STYLE, quindi qui restano frame/sidebar/nav/
// hero/content/bottom-nav/dashboard-home.
const HUB_SHELL_STYLE = `
:root{--marketplace-page-max:1440px;--marketplace-page-pad:clamp(18px,2.8vw,40px);--marketplace-shell-max:calc(var(--marketplace-page-max) + var(--marketplace-page-pad) + var(--marketplace-page-pad));}
.booking-public-bleed{width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);}
.booking-public-account{--booking-chrome-pad:var(--marketplace-page-pad);min-height:0;padding:28px var(--marketplace-page-pad) 36px;color:#111827;background:#fff;}
.booking-public-account.has-marketplace-header{min-height:0;}
.booking-public-account__frame{width:100%;max-width:var(--marketplace-page-max);min-height:0;margin:0 auto;background:#fff;border:0;border-radius:0;overflow:visible;box-shadow:none;display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:auto 1fr;align-items:start;}
.booking-public-account.has-marketplace-header .booking-public-account__frame{min-height:0;}
.booking-public-account__sidebar{grid-column:1;grid-row:1 / 3;position:sticky;top:0;z-index:6;height:auto;max-height:100vh;overflow-y:auto;overscroll-behavior:contain;border-right:0;background:#fff;align-self:start;}
.booking-public-account.has-marketplace-header .booking-public-account__sidebar{top:96px;height:auto;max-height:calc(100vh - 96px);}
.booking-public-account__header{padding:26px 12px 18px 24px;border-right:0;border-bottom:0;display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-content:start;align-items:start;background:#fff;}
.booking-public-account__brand{display:block;min-width:0;}
.booking-public-account__brandmark,.booking-public-account__brandmeta{display:none;}
.booking-public-account__brandname{font-size:19px;line-height:1.04;font-weight:600;letter-spacing:0;margin:0;color:#475569;}
.booking-public-account__nav{padding:0 12px 24px 24px;border-bottom:0;display:flex;flex-direction:column;gap:6px;align-items:stretch;background:transparent;}
.booking-public-account__nav a{display:flex;align-items:center;gap:9px;min-height:40px;padding:0 12px;border-radius:10px;border:1px solid transparent;background:transparent;text-decoration:none;color:#0f172a;font-size:13px;font-weight:600;}
.booking-public-account__nav a:hover{background:#f1f5f9;border-color:#e2e8f0;}
.booking-public-account__nav a.is-active{background:#4e6da6;border-color:#4e6da6;color:#fff;}
.booking-public-account__content{grid-column:2;grid-row:1 / 3;min-height:0;padding:20px 28px 28px;display:grid;gap:18px;align-content:start;min-width:0;background:#fff;}
.booking-bottom-nav{position:fixed;left:0;right:0;bottom:0;z-index:1000;height:70px;display:none;align-items:center;justify-content:center;gap:min(16vw,120px);border-top:1px solid #e5e7eb;background:#fff;}
.booking-bottom-nav__item{min-width:82px;border:0;background:transparent;color:#94a3b8;text-decoration:none;font-size:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-weight:600;}
.booking-bottom-nav__item i{font-size:22px;line-height:1;}
.booking-bottom-nav__item.is-active{color:#4e6da6;}
.booking-dashboard-home{display:grid;gap:18px;min-width:0;}
.booking-dashboard-home__hero{border:1px solid #e2e8f0;border-radius:10px;padding:22px;background:#fff;}
.booking-dashboard-home__kicker{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;}
.booking-dashboard-home__title{font-size:clamp(30px,5vw,48px);line-height:1;font-weight:600;letter-spacing:0;margin-top:8px;word-break:break-word;}
.booking-dashboard-home__muted{color:#4b5563;font-size:16px;line-height:1.6;max-width:60ch;margin-top:12px;}
.booking-dashboard-home__actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px;}
.booking-dashboard-home__cta{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;padding:12px 18px;text-decoration:none;font-weight:600;border:1px solid #4e6da6;background:#4e6da6;color:#fff;margin-top:18px;}
.booking-dashboard-home__actions .booking-dashboard-home__cta{margin-top:0;}
.booking-dashboard-home__cta--secondary{background:#fff;color:#4e6da6;}
.booking-public-account__section-head{display:grid;gap:4px;}
.booking-public-account__eyebrow{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#64748b;}
.booking-public-account__title{font-size:clamp(24px,3.4vw,34px);line-height:1.04;font-weight:600;letter-spacing:0;margin:2px 0 0;}
.booking-public-account__subtitle{color:#475569;font-size:13px;line-height:1.5;max-width:70ch;margin-top:6px;}
@media (max-width: 900px){
  .booking-bottom-nav{display:flex;}
  .booking-public-account{padding:14px 14px 94px;background:#fff;}
  .booking-public-account.has-marketplace-header{min-height:0;padding-top:14px;}
  .booking-public-account__frame{display:flex;flex-direction:column;width:min(980px,100%);min-height:0;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(15,23,42,.08);}
  .booking-public-account__sidebar{display:contents;}
  .booking-public-account__header{order:1;padding:16px 20px 12px;border-right:0;border-bottom:1px solid #e5e7eb;background:#fff;}
  .booking-public-account__nav{order:3;position:static;margin-top:0;padding:12px 20px;border-bottom:1px solid #e5e7eb;display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;align-items:center;background:#fff;}
  .booking-public-account__nav a{display:inline-flex;min-height:0;padding:8px 12px;border-radius:999px;border:1px solid #e5e7eb;background:#f3f4f6;font-size:12px;gap:7px;}
  .booking-public-account__content{order:4;min-height:0;padding:20px;background:#fff;}
}
@media (max-width: 640px){
  .booking-public-bleed{margin-left:0;margin-right:0;width:100%;max-width:100%;}
  .booking-public-account{padding:10px 6px 86px;}
  .booking-public-account.has-marketplace-header{padding-top:10px;}
  .booking-bottom-nav{height:66px;gap:min(10vw,54px);}
  .booking-public-account__frame{border-radius:12px;}
  .booking-public-account__header,.booking-public-account__nav,.booking-public-account__content{padding-left:16px;padding-right:16px;}
  .booking-public-account__brandname{font-size:19px;}
  .booking-public-account__nav a{width:100%;justify-content:center;}
}
`;

export function PerTenantHub({
  slug,
  section,
  tenantName,
  hasBookableLocations,
  noLocationsMessage = "Nessuna sede disponibile per la prenotazione online.",
  initialUser = null,
}: {
  slug: string;
  section: HubSection;
  tenantName: string;
  hasBookableLocations: boolean;
  // Messaggio della landing quando non ci sono sedi prenotabili: varia se la
  // prenotazione online è disattivata per il tenant (booking.php 2981-2985).
  noLocationsMessage?: string;
  // Cliente noto lato server (dal gate): idrata il chip account in SSR come il
  // PHP, che server-renderizza il widget account (BookingPublicUi.php 296-313).
  initialUser?: PublicCustomer | null;
}) {
  const [user, setUser] = useState<PublicCustomer | null>(initialUser);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  // Dati per-sezione (undefined = non caricato). Le liste da /api/account sono
  // aggregate su tutte le attività: filtriamo sul tenant corrente.
  const [appointments, setAppointments] = useState<CustomerAppointment[] | undefined>(undefined);
  const [packages, setPackages] = useState<CustomerPackage[] | undefined>(undefined);
  const [quotes, setQuotes] = useState<CustomerQuote[] | undefined>(undefined);
  const [credit, setCredit] = useState<CustomerCreditSection[] | undefined>(undefined);
  const [giftcards, setGiftcards] = useState<CustomerGiftcard[] | undefined>(undefined);
  const [prepaids, setPrepaids] = useState<CustomerPrepaid[] | undefined>(undefined);
  const [gifts, setGifts] = useState<CustomerGift[] | undefined>(undefined);
  const [fidelity, setFidelity] = useState<CustomerFidelitySection[] | undefined>(undefined);
  const [preorders, setPreorders] = useState<CustomerPreorder[] | undefined>(undefined);

  const newUrl = `/${encodeURIComponent(slug)}/booking?start=1`;
  const profileUrl = `/attivita/${encodeURIComponent(slug)}`;
  const dashboardUrl = `/${encodeURIComponent(slug)}/booking?hub=1`;
  const homeUrl = "/attivita";
  // Il brand della topbar punta alla ROOT del marketplace (BookingPublicUi.php
  // 110-111 strippa /attivita -> "/"), NON alla lista /attivita.
  const marketplaceRootUrl = "/";

  // Utente loggato (GET /api/account). Il gate lato server garantisce già la
  // sessione; qui è difensivo (redirect al login se scaduta).
  useEffect(() => {
    let alive = true;
    fetch("/api/account", { cache: "no-store" })
      .then((r) => r.json() as Promise<AccountResponse>)
      .then((j) => {
        if (!alive) return;
        if (j?.user?.email) {
          setUser(j.user);
        } else {
          const next = new URLSearchParams({ tenant: slug, next: section });
          window.location.replace(`/account/login?${next.toString()}`);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug, section]);

  // Lazy-load della sezione attiva, filtrata sul tenant.
  useEffect(() => {
    if (!user) return;
    const onlyTenant = <T extends { tenantSlug: string }>(list: T[]): T[] => list.filter((it) => it.tenantSlug === slug);
    const load = (action: string, apply: (data: AccountResponse) => void) => {
      let alive = true;
      void fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // tenant/tenantName: l'API rende visibili appuntamenti/preventivi del
        // tenant corrente anche per email (senza link), come il legacy.
        body: JSON.stringify({ action, tenant: slug, tenantName }),
      })
        .then((r) => r.json() as Promise<AccountResponse>)
        .then((data) => {
          if (alive) apply(data);
        })
        .catch(() => {
          if (alive) apply({ ok: false });
        });
      return () => {
        alive = false;
      };
    };
    switch (section) {
      case "my":
        if (appointments === undefined) return load("appointments", (d) => setAppointments(onlyTenant(d.appointments ?? [])));
        break;
      case "packs":
        if (packages === undefined) return load("packages", (d) => setPackages(onlyTenant(d.packages ?? [])));
        break;
      case "quotes":
        if (quotes === undefined) return load("quotes", (d) => setQuotes(onlyTenant(d.quotes ?? [])));
        break;
      case "credit":
        if (credit === undefined) return load("credit", (d) => setCredit(onlyTenant(d.credit ?? [])));
        break;
      case "giftcards":
        if (giftcards === undefined) return load("giftcards", (d) => setGiftcards(onlyTenant(d.giftcards ?? [])));
        break;
      case "prepaids":
        if (prepaids === undefined) return load("prepaids", (d) => setPrepaids(onlyTenant(d.prepaids ?? [])));
        break;
      case "gifts":
        if (gifts === undefined) return load("gifts", (d) => setGifts(onlyTenant(d.gifts ?? [])));
        break;
      case "fidelity":
        if (fidelity === undefined) return load("fidelity", (d) => setFidelity(onlyTenant(d.fidelity ?? [])));
        break;
      case "preorders":
        if (preorders === undefined) return load("preorders", (d) => setPreorders(onlyTenant(d.preorders ?? [])));
        break;
      default:
        break;
    }
  }, [user, section, slug, tenantName, appointments, packages, quotes, credit, giftcards, prepaids, gifts, fidelity, preorders]);

  // Chiusura del menu account (click fuori / Escape).
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

  // Effetti condivisi della topbar (treatment picker + suggerimenti città).
  useMarketplacePageEffects([user, section]);

  const customerName = (user?.fullName || `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim() || user?.email || "Cliente").trim();
  const customerInitial = customerName.charAt(0).toUpperCase() || "C";
  const brandMark = (tenantName || "BeautySuite").trim().charAt(0).toUpperCase() || "B";

  async function logout() {
    try {
      await fetch("/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
    } catch {
      /* redirect comunque */
    }
    window.location.href = homeUrl;
  }

  async function cancelAppointment(appt: CustomerAppointment) {
    if (!appt.canCancel) return;
    if (typeof window !== "undefined" && !window.confirm("Annullare questa prenotazione?")) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_appointment", tenant_slug: appt.tenantSlug, appointment_id: appt.id, tenant: slug, tenantName }),
      });
      const data = (await res.json()) as AccountResponse;
      if (!data.ok) {
        setFlash({ ok: false, text: data.error || "Errore annullamento" });
        return;
      }
      if (Array.isArray(data.appointments)) setAppointments(data.appointments.filter((it) => it.tenantSlug === slug));
      setFlash({ ok: true, text: "Prenotazione annullata." });
    } catch {
      setFlash({ ok: false, text: "Errore di rete durante l'annullamento." });
    } finally {
      setBusy(false);
    }
  }

  async function decideQuote(quote: CustomerQuote, decision: "accept" | "reject") {
    if (!quote.canRespond) return;
    const label = decision === "accept" ? "Accettare questo preventivo?" : "Rifiutare questo preventivo?";
    if (typeof window !== "undefined" && !window.confirm(label)) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quote_decision", tenant_slug: quote.tenantSlug, quote_id: quote.id, decision, tenant: slug, tenantName }),
      });
      const data = (await res.json()) as AccountResponse;
      if (!data.ok) {
        setFlash({ ok: false, text: data.error || "Errore preventivo" });
        return;
      }
      if (Array.isArray(data.quotes)) setQuotes(data.quotes.filter((it) => it.tenantSlug === slug));
      setFlash({ ok: true, text: decision === "accept" ? "Preventivo accettato." : "Preventivo rifiutato." });
    } catch {
      setFlash({ ok: false, text: "Errore di rete." });
    } finally {
      setBusy(false);
    }
  }

  const meta = SECTION_META[section];
  const topbarMenu = useMemo(
    () => [
      { label: "Attività", href: "/account/activities" },
      { label: "Preferiti", href: "/account/favorites" },
      { label: "Profilo", href: "/account/profile" },
    ],
    [],
  );

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/app.css" />
      {/* public_account.css: stili del chip/menu account marketplace della
          topbar (marketplace-account-chip/wrap/menu) — come l'area account
          centrale. app.css/TOPBAR_STYLE non li definiscono. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/assets/css/pages/public_account.css" />
      <style dangerouslySetInnerHTML={{ __html: TOKEN_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: TOPBAR_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: FOOTER_STYLE }} />
      <style dangerouslySetInnerHTML={{ __html: HUB_SHELL_STYLE }} />

      {/* ===================== TOPBAR marketplace (con ricerca) ===================== */}
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
          <a className="marketplace-topbar__brand" href={marketplaceRootUrl}>
            <span className="marketplace-topbar__brand-mark">B</span>
            <span>BeautySuite</span>
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
                aria-controls="hub-topbar-treatment-panel"
                data-marketplace-treatment-trigger
              >
                <span className="marketplace-topbar-treatment-label" data-marketplace-treatment-label>
                  Tutte le attivita
                </span>
                <svg className="marketplace-topbar-treatment-chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </button>
              <div className="marketplace-topbar-treatment-panel" id="hub-topbar-treatment-panel" hidden data-marketplace-treatment-panel>
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
            <label className="marketplace-topbar-search__field" htmlFor="hub-topbar-city">
              <span>Dove</span>
              <input id="hub-topbar-city" type="search" name="city" defaultValue="" placeholder="La tua citta" autoComplete="off" data-marketplace-topbar-city-input />
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
                  {topbarMenu.map((item) => (
                    <a key={item.href} role="menuitem" href={item.href}>
                      {item.label}
                    </a>
                  ))}
                  <a
                    className="is-danger"
                    role="menuitem"
                    href={homeUrl}
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

      {/* ===================== SHELL booking-public-account ===================== */}
      <div className="booking-public-bleed booking-public-account has-marketplace-header">
        <nav className="booking-bottom-nav" aria-label="Navigazione booking">
          <a className="booking-bottom-nav__item" href={profileUrl}>
            <i className="bi bi-house"></i>
            <span>Home</span>
          </a>
          <a className="booking-bottom-nav__item is-active" href={dashboardUrl} aria-current="page">
            <i className="bi bi-person-square"></i>
            <span>Pannello</span>
          </a>
          <a className="booking-bottom-nav__item" href={newUrl}>
            <i className="bi bi-calendar-plus-fill"></i>
            <span>Prenota</span>
          </a>
        </nav>
        <div className="booking-public-account__frame">
          <aside className="booking-public-account__sidebar">
            <header className="booking-public-account__header">
              <a className="booking-public-account__brand" href={dashboardUrl} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="booking-public-account__brandmark">{brandMark}</div>
                <div>
                  <div className="booking-public-account__brandname">{tenantName || "BeautySuite"}</div>
                  <div className="booking-public-account__brandmeta">Area cliente</div>
                </div>
              </a>
            </header>
            <nav className="booking-public-account__nav" aria-label="Pannello cliente">
              {HUB_MENU.map((item) => (
                <a key={item.key} className={item.key === section ? "is-active" : ""} href={`/${encodeURIComponent(slug)}/booking?${item.key}=1`}>
                  <i className={`bi ${item.icon}`}></i>
                  <span>{item.label}</span>
                </a>
              ))}
            </nav>
          </aside>
          <div className="booking-public-account__content">
            {flash ? <div className={flash.ok ? "alert alert-success" : "alert"}>{flash.text}</div> : null}

            {section === "hub" ? (
              <div className="booking-dashboard-home">
                <section className="booking-dashboard-home__hero">
                  <div className="booking-dashboard-home__kicker">Area cliente</div>
                  <div className="booking-dashboard-home__title">Ciao &#128075;</div>
                  <div className="booking-dashboard-home__muted">
                    Qui trovi tutto ci&ograve; che riguarda il tuo profilo e le attivit&agrave; effettuate presso il centro.
                  </div>
                  {hasBookableLocations ? (
                    <div className="booking-dashboard-home__actions">
                      <a className="booking-dashboard-home__cta" href={newUrl}>
                        <i className="bi bi-plus-circle"></i>
                        <span>Prenota ora</span>
                      </a>
                      <a className="booking-dashboard-home__cta booking-dashboard-home__cta--secondary" href={profileUrl}>
                        <i className="bi bi-shop"></i>
                        <span>Scheda attività</span>
                      </a>
                    </div>
                  ) : (
                    <>
                      <div className="alert alert-warning mt-3 mb-0">{noLocationsMessage}</div>
                      <div className="booking-dashboard-home__actions">
                        <a className="booking-dashboard-home__cta booking-dashboard-home__cta--secondary" href={profileUrl}>
                          <i className="bi bi-shop"></i>
                          <span>Scheda attività</span>
                        </a>
                      </div>
                    </>
                  )}
                </section>
              </div>
            ) : (
              <>
                <div className="booking-public-account__section-head">
                  <span className="booking-public-account__eyebrow">Area cliente</span>
                  <h1 className="booking-public-account__title">{meta.title}</h1>
                  <p className="booking-public-account__subtitle">{meta.subtitle}</p>
                </div>
                {section === "my" ? (
                  <AppointmentsView appointments={appointments ?? []} loaded={appointments !== undefined} busy={busy} onCancel={cancelAppointment} />
                ) : null}
                {section === "packs" ? <PackagesView packages={packages ?? []} loaded={packages !== undefined} /> : null}
                {section === "quotes" ? (
                  <QuotesView quotes={quotes ?? []} loaded={quotes !== undefined} busy={busy} onDecision={decideQuote} />
                ) : null}
                {section === "credit" ? <CreditView items={credit} /> : null}
                {section === "giftcards" ? <GiftcardsView items={giftcards} /> : null}
                {section === "prepaids" ? <PrepaidsView items={prepaids} /> : null}
                {section === "gifts" ? <GiftsView items={gifts} /> : null}
                {section === "fidelity" ? <FidelityView items={fidelity} /> : null}
                {section === "preorders" ? <PreordersView items={preorders} /> : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===================== FOOTER marketplace ===================== */}
      <footer className="marketplace-footer">
        <div className="marketplace-footer__inner">
          <div className="marketplace-footer__grid">
            <section aria-labelledby="hubFooterInfoTitle">
              <h2 id="hubFooterInfoTitle">Informazioni</h2>
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
            <section aria-labelledby="hubFooterAppTitle">
              <h2 id="hubFooterAppTitle">Scarica l&apos;app</h2>
              <div className="marketplace-footer__app">
                <span className="marketplace-footer__app-icon" aria-hidden="true">
                  B
                </span>
                <p>Prenota il tuo prossimo trattamento di bellezza quando e dove vuoi.</p>
              </div>
              <div className="marketplace-footer__stores" aria-label="Link app">
                <a className="marketplace-footer__store" href="/account/login">
                  <small>Scarica su</small>
                  <strong>App Store</strong>
                </a>
                <a className="marketplace-footer__store" href="/account/login">
                  <small>Disponibile su</small>
                  <strong>Google Play</strong>
                </a>
              </div>
            </section>
            <section aria-labelledby="hubFooterSocialTitle">
              <h2 id="hubFooterSocialTitle">Seguici su</h2>
              <div className="marketplace-footer__social">
                <a className="marketplace-footer__social-link" href="#" aria-label="Facebook">f</a>
                <a className="marketplace-footer__social-link" href="#" aria-label="X">X</a>
                <a className="marketplace-footer__social-link" href="#" aria-label="Pinterest">P</a>
                <a className="marketplace-footer__social-link" href="#" aria-label="Instagram">IG</a>
                <a className="marketplace-footer__social-link" href="#" aria-label="YouTube">YT</a>
                <a className="marketplace-footer__social-link" href="#" aria-label="TikTok">TK</a>
              </div>
            </section>
            <section aria-labelledby="hubFooterCountryTitle">
              <h2 id="hubFooterCountryTitle">Seleziona un paese</h2>
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
