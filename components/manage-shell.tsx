"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QuickBookingDrawer } from "@/components/quick-booking-drawer";
import {
  browserNotificationStoragePrefix,
  createBrowserNotificationFeed,
  type FeedEventLike,
} from "@/lib/browser-notification-feed";

// Faithful port of the PHP gestionale chrome (app/lib/View.php): app-shell ->
// (app-sidebar + app-main -> (topbar + app-content)). Loads the SAME Bootstrap
// 5.3.3 + Bootstrap Icons + Chart.js + app.css the PHP dashboard uses.
// Ported app.js behaviors: sidebar collapse, sidebar submenu expand/collapse,
// notification bell counts, the topbar location switcher, the support/closure
// sticky alerts, the #appToastContainer + global window.notify(), the global
// notification poller (View.php footer script: badge live + notifiche browser),
// and the quick-booking drawer (in components/quick-booking-drawer.tsx).

type Item = { page: string; icon: string; label: string; sub?: boolean };
type Group = { label?: string; items: Item[] };

const MENU: Group[] = [
  {
    items: [
      { page: "dashboard", icon: "speedometer2", label: "Dashboard" },
      { page: "calendar", icon: "calendar-week", label: "Calendario" },
      { page: "appointments", icon: "list-task", label: "Appuntamenti" },
      { page: "appointments_plan", icon: "calendar2-plus", label: "Pianifica", sub: true },
      { page: "pos", icon: "credit-card", label: "Pagamenti" },
      { page: "pos_history", icon: "clock-history", label: "Movimenti", sub: true },
      { page: "pos_prepaids", icon: "wallet2", label: "Prepagati", sub: true },
      { page: "pos_preorders", icon: "bag-check", label: "Preordini", sub: true },
      { page: "pos_settings", icon: "gear", label: "Impostazioni", sub: true },
      { page: "installments_manage", icon: "cash-stack", label: "Gestione Rate" },
      { page: "costs", icon: "calendar2-check", label: "Scadenziario e Costi" },
      { page: "costs&tab=categories", icon: "tags", label: "Categorie", sub: true },
      { page: "commissions", icon: "percent", label: "Commissioni" },
      { page: "products", icon: "box-seam", label: "Magazzino" },
      { page: "products&action=categories", icon: "tags", label: "Categorie prodotti", sub: true },
      { page: "stock_moves", icon: "arrow-left-right", label: "Carico / Scarico", sub: true },
      { page: "suppliers", icon: "truck", label: "Fornitori" },
      { page: "coupons", icon: "ticket-perforated", label: "Buoni" },
      { page: "clients", icon: "people", label: "Clienti" },
      { page: "packages&tab=clients", icon: "layers", label: "Pacchetti" },
      { page: "quotes", icon: "file-earmark-text", label: "Preventivi" },
      { page: "giftbox", icon: "box", label: "GiftBox" },
      { page: "giftbox_settings", icon: "gear", label: "Impostazioni", sub: true },
      { page: "giftcard", icon: "credit-card-2-front", label: "GiftCard" },
      { page: "giftcard_settings", icon: "gear", label: "Impostazioni", sub: true },
    ],
  },
  {
    label: "Fidelizzazione",
    items: [
      { page: "fidelity", icon: "award", label: "Fidelity" },
      { page: "fidelity_membership", icon: "person-check", label: "Adesione", sub: true },
      { page: "recharges", icon: "arrow-repeat", label: "Ricariche" },
      { page: "wallet", icon: "wallet2", label: "Portafoglio" },
      { page: "promotions", icon: "megaphone", label: "Promozioni" },
      { page: "fidelity_points", icon: "coin", label: "Punti" },
      { page: "fidelity_points#livelli-card", icon: "stars", label: "Livelli Card", sub: true },
      { page: "gifts", icon: "gift", label: "Omaggi" },
    ],
  },
  {
    label: "Risorse",
    items: [
      { page: "resources", icon: "boxes", label: "Risorse" },
      { page: "services&tab=services", icon: "stars", label: "Servizi" },
      { page: "services&tab=categories", icon: "tags", label: "Categorie servizi", sub: true },
      { page: "services&tab=recommended", icon: "stars", label: "Servizi consigliati", sub: true },
      { page: "cabins", icon: "door-open", label: "Cabine" },
      { page: "staff", icon: "person-badge", label: "Operatori" },
      { page: "staff_availability", icon: "calendar-week", label: "Disponibilità", sub: true },
      { page: "hours", icon: "clock-history", label: "Orari" },
    ],
  },
  {
    label: "Impostazioni",
    items: [
      { page: "business_profile", icon: "gear", label: "Profilo attività" },
      { page: "locations", icon: "building", label: "Sedi" },
      { page: "consent_modules", icon: "shield-check", label: "Moduli consenso" },
      { page: "accessibility", icon: "universal-access", label: "Accessibilità" },
      { page: "roles", icon: "shield-lock", label: "Ruoli" },
      { page: "automation", icon: "lightning-charge", label: "Automazione" },
      { page: "reports", icon: "graph-up", label: "Report" },
      { page: "booking", icon: "globe2", label: "Booking" },
      // Registro attività operatori (feature 2026-07-16): la pagina si
      // auto-gata SOLO-Admin come Ruoli (il menu non filtra per permesso).
      { page: "log", icon: "journal-text", label: "Log" },
    ],
  },
];

// A rendered menu entry: a top-level item plus the consecutive sub-items that
// follow it (its submenu children). Faithful port of buildSidebarSubmenus() in
// assets/js/app.js, which groups each run of `.nav-subitem` after a parent
// `.nav-item` into a collapsible `.sidebar-submenu` wrapper. This MUST happen
// because app.css hides any `.nav-subitem` left as a direct child of
// `.nav-section` (`.app-sidebar .nav-section > .nav-subitem{display:none}`).
type RenderedItem = { item: Item; children: Item[] };
type RenderedGroup = { label?: string; entries: RenderedItem[] };

function buildRenderedMenu(groups: Group[]): RenderedGroup[] {
  return groups.map((group) => {
    const entries: RenderedItem[] = [];
    for (const item of group.items) {
      if (item.sub && entries.length > 0) {
        entries[entries.length - 1].children.push(item);
      } else {
        entries.push({ item, children: [] });
      }
    }
    return { label: group.label, entries };
  });
}

const RENDERED_MENU: RenderedGroup[] = buildRenderedMenu(MENU);

// Build a clean manage URL from a menu page key. The key may embed a legacy
// query (`costs&tab=categories`, `products&action=categories`) or hash anchor
// (`fidelity_points#livelli-card`); the page becomes the path segment and the
// tab/action stay as query params: /<slug>/<page>[?tab=..][#hash].
function pageHref(slug: string, page: string): string {
  const hashIdx = page.indexOf("#");
  const hash = hashIdx >= 0 ? page.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? page.slice(0, hashIdx) : page;
  const ampIdx = noHash.indexOf("&");
  const name = ampIdx >= 0 ? noHash.slice(0, ampIdx) : noHash;
  const query = ampIdx >= 0 ? noHash.slice(ampIdx + 1) : "";
  let url = `/${encodeURIComponent(slug)}/${name}`;
  if (query) url += `?${query}`;
  return url + hash;
}

// Flat, searchable index of every menu function (used by the topbar "Cerca..."
// jump-to-function search). Each entry keeps the original page key (so pageHref
// builds the same clean URL the sidebar uses) plus its group label for context.
type FunctionEntry = { page: string; label: string; icon: string; group: string };
const FUNCTION_INDEX: FunctionEntry[] = MENU.flatMap((group) =>
  group.items.map((item) => ({ page: item.page, label: item.label, icon: item.icon, group: group.label ?? "" })),
);

// Shell-context shapes returned by /api/manage/shell-context.
type NotifCounts = { count: number; quotes: number; installments: number; birthdays: number };
type ShellLocation = { id: number; name: string };
type ShellSupport = { created_by_email?: string; reason?: string; expires_at?: string };
type ShellClosure = { start: string; end: string };
// Gate per-elemento della topbar (View.php 796-848): icone, bottone
// quick-booking e voci del dropdown account esistono SOLO col permesso
// corrispondente (Auth::can), come il markup PHP condizionale. Accessibilità
// ed Esci sono per qualsiasi utente autenticato.
type ShellTopbar = {
  canViewNotifications: boolean;
  bellBirthdays: boolean;
  bellInstallments: boolean;
  bellQuotes: boolean;
  quickBooking: boolean;
  accountBusinessProfile: boolean;
  accountLocations: boolean;
  accountConsentModules: boolean;
  accountRoles: boolean;
};
const TOPBAR_NONE: ShellTopbar = {
  canViewNotifications: false,
  bellBirthdays: false,
  bellInstallments: false,
  bellQuotes: false,
  quickBooking: false,
  accountBusinessProfile: false,
  accountLocations: false,
  accountConsentModules: false,
  accountRoles: false,
};

// Bootstrap's global, loaded by the CDN <script> in the shell. Only the Toast
// API surface notify() needs is declared, to stay strict-mode clean.
type BootstrapToast = { show: () => void };
type BootstrapGlobal = {
  Toast?: {
    getOrCreateInstance: (el: Element, options?: { delay?: number }) => BootstrapToast;
  };
};

function normalize(value: string): string {
  // Lowercase + strip combining diacritics (U+0300–U+036F) so "attività" matches
  // a typed "attivita" and "disponibilità" matches "disponibilita".
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "");
}

// Port of the View.php closure-alert date format: "YYYY-MM-DD" -> "d/m/Y",
// falling back to the raw value when it can't be parsed.
function formatClosureDate(value: string): string {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value ?? "");
}

// Port of $supportExpiresLabel: "YYYY-MM-DD HH:MM:SS" -> "d/m/Y H:i".
function formatSupportExpires(value?: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  const dm = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return dm ? `${dm[3]}/${dm[2]}/${dm[1]}` : raw;
}

export function ManageShell({
  slug,
  userName,
  currentPage = "dashboard",
  emailVerificationGate = false,
  needsLocationSelectionHint = false,
  children,
}: {
  slug: string;
  userName: string;
  currentPage?: string;
  // Gate verifica email (View.php $emailVerificationGate): chrome ridotto —
  // niente nav/topbar/banner, brand che punta ad Accessibilita — finché
  // l'email di accesso non è verificata (index.php 580-590 redirige qui).
  emailVerificationGate?: boolean;
  // Hint SERVER-SIDE del gate selezione sede (session.user.needsLocationSelection):
  // il legacy decide il gate prima del paint; senza hint la shell renderizzava
  // il gestionale per ~1s prima che shell-context rivelasse il gate (flash
  // segnalato dall'utente). Il fetch client resta l'autorità: se smentisce
  // l'hint il gate rientra.
  needsLocationSelectionHint?: boolean;
  children: React.ReactNode;
}) {
  // Port of the app.js sidebar behaviors: desktop collapse (persisted in
  // localStorage) and the mobile off-canvas (sidebar-open + backdrop).
  useEffect(() => {
    const previous = document.body.className;
    let collapsed = false;
    try {
      collapsed = localStorage.getItem("beautysuite_sidebar_collapsed") === "1";
    } catch {
      collapsed = false;
    }
    document.body.className = [collapsed ? "sidebar-collapsed" : "", emailVerificationGate ? "email-verification-gate" : ""]
      .filter(Boolean)
      .join(" ");
    document.documentElement.classList.remove("sidebar-collapsed-initial");

    const desktopToggle = document.getElementById("sidebarDesktopToggle");
    const openBtn = document.getElementById("sidebarOpen");
    const closeBtn = document.getElementById("sidebarClose");
    const backdrop = document.getElementById("sidebarBackdrop");

    const onDesktopToggle = () => {
      const next = !document.body.classList.contains("sidebar-collapsed");
      document.body.classList.toggle("sidebar-collapsed", next);
      try {
        localStorage.setItem("beautysuite_sidebar_collapsed", next ? "1" : "0");
      } catch {
        // ignore storage failures, like the PHP app
      }
    };
    const openSidebar = () => document.body.classList.add("sidebar-open");
    const closeSidebar = () => document.body.classList.remove("sidebar-open");

    desktopToggle?.addEventListener("click", onDesktopToggle);
    openBtn?.addEventListener("click", openSidebar);
    closeBtn?.addEventListener("click", closeSidebar);
    backdrop?.addEventListener("click", closeSidebar);

    return () => {
      desktopToggle?.removeEventListener("click", onDesktopToggle);
      openBtn?.removeEventListener("click", openSidebar);
      closeBtn?.removeEventListener("click", closeSidebar);
      backdrop?.removeEventListener("click", closeSidebar);
      document.body.className = previous;
    };
  }, [emailVerificationGate]);

  const basePage = currentPage.split("&")[0];

  // Shell context (notification bell counts, location selector options, and the
  // support/closure sticky alerts) fetched once on mount from the new
  // /api/manage/shell-context route — a port of the View.php topbar context.
  // The legacy chrome computes these server-side at render with no polling, so a
  // single fetch matches its semantics.
  const [notif, setNotif] = useState<NotifCounts>({ count: 0, quotes: 0, installments: 0, birthdays: 0 });
  const [topbar, setTopbar] = useState<ShellTopbar>(TOPBAR_NONE);
  const [viewerUserId, setViewerUserId] = useState(0);
  const [locations, setLocations] = useState<ShellLocation[]>([]);
  const [currentLocationId, setCurrentLocationId] = useState(0);
  const [needsLocationSelection, setNeedsLocationSelection] = useState(needsLocationSelectionHint);
  const [shellContextLoaded, setShellContextLoaded] = useState(false);
  const [supportAccess, setSupportAccess] = useState<ShellSupport | null>(null);
  const [closureRange, setClosureRange] = useState<ShellClosure | null>(null);
  const supportExpiresLabel = formatSupportExpires(supportAccess?.expires_at);

  // Mirror sincrono dei contatori (per il diff del poller senza closure stale)
  // + ref alle ancore campanella per il pulse legacy `notification-bell--changed`
  // (renderIcon, View.php 2084-2089: remove class → reflow → add → timeout 520ms).
  const notifCountsRef = useRef<NotifCounts>({ count: 0, quotes: 0, installments: 0, birthdays: 0 });
  const bellRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const bellPulseTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/manage/shell-context?slug=${encodeURIComponent(slug)}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || data.ok === false) return;
        const n = data.notif ?? {};
        const counts = {
          count: Number(n.count ?? 0),
          quotes: Number(n.quotes ?? 0),
          installments: Number(n.installments ?? 0),
          birthdays: Number(n.birthdays ?? 0),
        };
        // Equivalente del conteggio renderizzato server-side dal PHP: primo
        // paint SENZA pulse (il pulse scatta solo sui CAMBI rilevati dal poller).
        notifCountsRef.current = counts;
        setNotif(counts);
        const t = data.topbar ?? {};
        setTopbar({
          canViewNotifications: Boolean(t.canViewNotifications),
          bellBirthdays: Boolean(t.bellBirthdays),
          bellInstallments: Boolean(t.bellInstallments),
          bellQuotes: Boolean(t.bellQuotes),
          quickBooking: Boolean(t.quickBooking),
          accountBusinessProfile: Boolean(t.accountBusinessProfile),
          accountLocations: Boolean(t.accountLocations),
          accountConsentModules: Boolean(t.accountConsentModules),
          accountRoles: Boolean(t.accountRoles),
        });
        setViewerUserId(Number(data.viewerUserId ?? 0));
        setLocations(Array.isArray(data.locations) ? data.locations : []);
        setCurrentLocationId(Number(data.currentLocationId ?? 0));
        setNeedsLocationSelection(Boolean(data.needsLocationSelection));
        setShellContextLoaded(true);
        setSupportAccess(data.supportAccess ?? null);
        setClosureRange(data.closureRange ?? null);
      })
      .catch(() => {
        // best effort, like the PHP chrome which silently renders 0 on failure
      });
    return () => controller.abort();
  }, [slug]);

  // POLLER GLOBALE NOTIFICHE — port del footer script legacy (View.php
  // 2000-2463), attivo su OGNI pagina manage quando l'utente ha
  // notifications.view (il legacy emette lo script solo in quel caso e lo
  // script esce subito se non trova icone: gate email/selezione sede → topbar
  // assente → nessun polling). Ogni 5s: con permesso browser CONCESSO in
  // contesto sicuro legge action=feed (badge + pubblicazione eventi con
  // toast/nativa), altrimenti action=count (solo badge). Primo refresh a
  // 1.5s, baseline feed a 300ms, refresh su focus/visibilitychange, e
  // re-baseline su richiesta della pagina notifiche (evento
  // 'bs:notifications-baseline' dopo attivazione permesso o salvataggio
  // preferenze, come refreshNotificationFeed(true) legacy).
  useEffect(() => {
    if (!shellContextLoaded || !topbar.canViewNotifications || emailVerificationGate || needsLocationSelection) return;
    if (typeof window === "undefined") return;
    const pulseTimers = bellPulseTimers.current;
    // Il setup è ASINCRONO (prima si mergia lo stato 'visto' dal server, POI si
    // crea il feed: il flag hydrated viene letto alla creazione); cancelled +
    // cleanup differito coprono lo smontaggio durante il fetch iniziale.
    let cancelled = false;
    let teardown: (() => void) | null = null;

    const storageGet = (key: string): string | null => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };
    const localStorageSet = (key: string, value: string): void => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // ignora, come storageSet legacy
      }
    };
    // Chiavi dello stato 'visto' per QUESTO scope (tenant:utente:sede).
    const prefixForSeen = browserNotificationStoragePrefix(slug, viewerUserId, currentLocationId);
    const seenStorageKey = `${prefixForSeen}:seen`;
    const hydratedStorageKey = `${prefixForSeen}:hydrated`;
    // Write-through L2 (deviazione approvata 2026-07-13): ogni scrittura del
    // motore su seen/hydrated viene ripubblicata al server con debounce —
    // fire-and-forget, su errore resta il localStorage come prima.
    let seenPushTimer = 0;
    const pushSeenToServer = () => {
      window.clearTimeout(seenPushTimer);
      seenPushTimer = window.setTimeout(() => {
        const payload = {
          action: "save_seen_state",
          seen_json: storageGet(seenStorageKey) ?? "[]",
          hydrated: storageGet(hydratedStorageKey) === "1" ? "1" : "0",
        };
        void fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
      }, 400);
    };
    const storageSet = (key: string, value: string): void => {
      localStorageSet(key, value);
      if (key === seenStorageKey || key === hydratedStorageKey) pushSeenToServer();
    };

    (async () => {
      // MERGE L2→L1: lo stato 'visto' del server viene unito al localStorage
      // PRIMA della creazione del feed (unione chiavi cap 180; hydrated se
      // vero su UNO dei due lati) — un browser nuovo eredita i visti e non
      // ri-notifica. Su errore si degrada al solo localStorage.
      try {
        const res = await fetch(
          `/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=seen_state&_=${Date.now()}`,
          { credentials: "include", cache: "no-store", headers: { Accept: "application/json", "x-tenant-slug": slug } },
        );
        const data = await res.json();
        if (res.ok && data?.ok === true) {
          const localSeen = (() => {
            try {
              const parsed = JSON.parse(storageGet(seenStorageKey) || "[]");
              return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
            } catch {
              return [];
            }
          })();
          const serverSeen = Array.isArray(data.seen) ? data.seen.filter(Boolean).map(String) : [];
          if (serverSeen.length) {
            localStorageSet(seenStorageKey, JSON.stringify(Array.from(new Set([...localSeen, ...serverSeen])).slice(-180)));
          }
          if (data.hydrated === true && storageGet(hydratedStorageKey) !== "1") {
            localStorageSet(hydratedStorageKey, "1");
          }
        }
      } catch {
        // degrada al solo localStorage, come prima della L2
      }
      if (cancelled) return;

    const supportsBrowserNotifications = () => "Notification" in window;
    const hasSecureNotificationContext = () =>
      Boolean(window.isSecureContext) || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

    const notificationsUrl = pageHref(slug, "notifications");
    const resolveNotificationUrl = (url: unknown): string => {
      try {
        return new URL(String(url || notificationsUrl), window.location.href).href;
      } catch {
        return notificationsUrl;
      }
    };

    const prefix = browserNotificationStoragePrefix(slug, viewerUserId, currentLocationId);
    const feed = createBrowserNotificationFeed(prefix, {
      storageGet,
      storageSet,
      showNative: (event: FeedEventLike): boolean => {
        if (!browserNotificationsEnabled()) return false;
        try {
          const notification = new Notification(String(event.title || "Notifica"), {
            body: String(event.body || ""),
            tag: String(event.key || ""),
            silent: false,
            ...({ renotify: false } as NotificationOptions),
          });
          notification.onclick = () => {
            try {
              window.focus();
            } catch {
              // noop
            }
            window.location.href = resolveNotificationUrl(event.url);
            notification.close();
          };
          return true;
        } catch {
          return false;
        }
      },
      showToast: (message: string, variant: string) => {
        (window as unknown as { notify?: (m: string, v?: string) => void }).notify?.(message, variant);
      },
      isPageActive: () => !document.hidden && document.hasFocus(),
      notificationsUrl,
    });

    const browserNotificationsEnabled = (): boolean => {
      if (!supportsBrowserNotifications() || !hasSecureNotificationContext()) return false;
      if (Notification.permission !== "granted") return false;
      feed.markEnabled();
      return true;
    };

    // renderCounts legacy: aggiorna SOLO le chiavi presenti nel payload e fa
    // pulsare l'icona il cui conteggio è cambiato.
    const pulseBell = (key: string) => {
      const el = bellRefs.current[key];
      if (!el) return;
      el.classList.remove("notification-bell--changed");
      void el.offsetWidth;
      el.classList.add("notification-bell--changed");
      window.clearTimeout(pulseTimers[key]);
      pulseTimers[key] = window.setTimeout(() => el.classList.remove("notification-bell--changed"), 520);
    };
    const numeric = (value: unknown): number => {
      const n = Number.parseInt(String(value ?? "0"), 10);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const applyCounts = (data: Record<string, unknown>) => {
      const prev = notifCountsRef.current;
      const next = { ...prev };
      for (const key of ["count", "quotes", "installments", "birthdays"] as const) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        const value = numeric(data[key]);
        if (value !== prev[key]) pulseBell(key);
        next[key] = value;
      }
      notifCountsRef.current = next;
      setNotif(next);
    };

    const refreshNotificationFeed = async (baseline: boolean): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=feed&limit=20&_=${Date.now()}`,
          { credentials: "include", cache: "no-store", headers: { Accept: "application/json", "x-tenant-slug": slug } },
        );
        const data = await res.json();
        if (!res.ok || !data || data.ok !== true) return false;
        applyCounts(data);
        feed.handleFeedEvents(data.events ?? [], Boolean(baseline));
        return true;
      } catch {
        return false;
      }
    };

    const refreshNotifications = async (): Promise<void> => {
      try {
        if (browserNotificationsEnabled()) {
          await refreshNotificationFeed(false);
          return;
        }
        const res = await fetch(
          `/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=count&_=${Date.now()}`,
          { credentials: "include", cache: "no-store", headers: { Accept: "application/json", "x-tenant-slug": slug } },
        );
        const data = await res.json();
        if (!res.ok || !data || data.ok !== true) return;
        applyCounts(data);
      } catch {
        // silenzioso come il legacy
      }
    };

    const timers: number[] = [];
    if (browserNotificationsEnabled()) {
      timers.push(window.setTimeout(() => void refreshNotificationFeed(!feed.isHydrated()), 300));
    }
    timers.push(window.setTimeout(() => void refreshNotifications(), 1500));
    const intervalId = window.setInterval(() => void refreshNotifications(), 5000);

    const onFocus = () => void refreshNotifications();
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (browserNotificationsEnabled()) void refreshNotificationFeed(!feed.isHydrated());
      } else {
        void refreshNotifications();
      }
    };
    const onBaselineRequest = () => void refreshNotificationFeed(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("bs:notifications-baseline", onBaselineRequest);

    teardown = () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("bs:notifications-baseline", onBaselineRequest);
      Object.values(pulseTimers).forEach((t) => window.clearTimeout(t));
      window.clearTimeout(seenPushTimer);
    };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [slug, shellContextLoaded, topbar.canViewNotifications, emailVerificationGate, needsLocationSelection, viewerUserId, currentLocationId]);

  // Submenu expand/collapse state. Port of app.js's setExpandedSubmenu(): a run
  // opens by default when it contains the active child (so the active deep link
  // stays revealed on load); the chevron toggles it. We track only explicit user
  // toggles and derive the effective open state, so no setState-in-effect is
  // needed (and the default re-resolves if the active page changes).
  const [submenuToggles, setSubmenuToggles] = useState<Record<string, boolean>>({});
  const toggleSubmenu = (page: string, defaultOpen: boolean) => {
    setSubmenuToggles((prev) => ({ ...prev, [page]: !(prev[page] ?? defaultOpen) }));
  };

  // Change the current location and reload, like the legacy #topbarLocationSwitch
  // (which navigates with ?set_location_id=<id>). The Next equivalent persists
  // the choice on the manage session via POST /api/manage/locations, then
  // reloads so every server component re-reads the new current location.
  const switchLocation = async (locationId: number) => {
    if (!locationId || locationId === currentLocationId) return;
    try {
      await fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId }),
      });
    } catch {
      // fall through to reload; the server keeps the prior location on failure
    }
    window.location.reload();
  };

  // Expose a global notify(message, variant) toast helper — a faithful port of
  // the legacy notify() in assets/js/app.js: appends a Bootstrap toast to
  // #appToastContainer with a 4.5s auto-dismiss, removing it on hide. Page code
  // calls window.notify(...) just like it called the global notify() in PHP.
  useEffect(() => {
    const escHtml = (s: unknown): string =>
      String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m] ?? m));
    const VARIANTS = ["primary", "secondary", "success", "danger", "warning", "info", "light", "dark"];

    const notify = (message: string, variant = "info") => {
      const container = document.getElementById("appToastContainer") ?? document.body;
      const v = String(variant || "info");
      const bgClass = VARIANTS.includes(v) ? `text-bg-${v}` : "text-bg-info";

      const el = document.createElement("div");
      el.className = `toast align-items-center ${bgClass} border-0 app-toast`;
      el.setAttribute("role", "alert");
      el.setAttribute("aria-live", "assertive");
      el.setAttribute("aria-atomic", "true");
      el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${escHtml(message)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Chiudi"></button>
      </div>`;
      container.appendChild(el);

      const bootstrap = (window as unknown as { bootstrap?: BootstrapGlobal }).bootstrap;
      try {
        if (!bootstrap?.Toast) throw new Error("bootstrap-unavailable");
        const toast = bootstrap.Toast.getOrCreateInstance(el, { delay: 4500 });
        el.addEventListener("hidden.bs.toast", () => el.remove());
        toast.show();
      } catch {
        // Fallback (bootstrap JS not yet loaded): show plainly, auto-remove.
        el.style.display = "block";
        window.setTimeout(() => el.remove(), 4500);
      }
    };

    (window as unknown as { notify?: typeof notify }).notify = notify;
    return () => {
      delete (window as unknown as { notify?: typeof notify }).notify;
    };
  }, []);

  // Topbar "Cerca..." jump-to-function search over the MENU items. Filters the flat
  // FUNCTION_INDEX as you type and shows a lightweight dropdown of matches; Enter or
  // a click navigates to the matching page via pageHref (the same clean URL the
  // sidebar uses). Keyboard: ArrowUp/Down move the highlight, Escape closes.
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const searchMatches = useMemo(() => {
    const q = normalize(searchQuery.trim());
    if (!q) return [] as FunctionEntry[];
    return FUNCTION_INDEX.filter((entry) => {
      const haystack = normalize(`${entry.label} ${entry.group} ${entry.page}`);
      return haystack.includes(q);
    }).slice(0, 8);
  }, [searchQuery]);

  // Close the dropdown when clicking outside the search box.
  useEffect(() => {
    if (!searchOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [searchOpen]);

  const goToFunction = (entry: FunctionEntry | undefined) => {
    if (!entry) return;
    setSearchOpen(false);
    window.location.href = pageHref(slug, entry.page);
  };

  // Render a notification bell driven by a real count: `has-notifications` on
  // the anchor when count>0, and a `bell-badge` (hidden when 0, "99+" capped).
  // Faithful port of the View.php topbar bells (aria-label del badge inclusa,
  // View.php 805/811/817/822); countKey aggancia il pulse del poller.
  const renderBell = (page: string, icon: string, label: string, count: number, countKey: string, badgeNoun: string) => {
    const hasCount = count > 0;
    const display = count > 99 ? "99+" : String(count);
    return (
      <a
        ref={(el) => {
          bellRefs.current[countKey] = el;
        }}
        className={`icon-btn position-relative notification-bell${countKey !== "count" ? " notification-shortcut" : ""}${hasCount ? " has-notifications" : ""}`}
        href={pageHref(slug, page)}
        title={hasCount ? `${count} ${label.toLowerCase()}` : label}
        aria-label={hasCount ? `${label}: ${count}` : label}
      >
        <i className={`bi bi-${icon}`} />
        <span className={`bell-badge${hasCount ? "" : " d-none"}`} aria-label={`${count} ${badgeNoun}`}>{display}</span>
      </a>
    );
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSearchOpen(true);
      setActiveIndex((i) => Math.min(i + 1, Math.max(searchMatches.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      goToFunction(searchMatches[activeIndex] ?? searchMatches[0]);
    } else if (e.key === "Escape") {
      setSearchOpen(false);
    }
  };

  // GATE SELEZIONE SEDE — port di View::locationGate (View.php 913-977): un
  // utente multi-sede senza sede corrente (o senza sedi assegnate) vede il
  // chooser a schermo intero PRIMA del gestionale, come il blocco globale di
  // index.php 606-638. La scelta passa da switchLocation (equivalente del
  // legacy ?set_location_id=). Accessibilita è ESCLUSA dal gate sede
  // (index.php 610 la elenca tra le pagine esenti): credenziali gestibili
  // anche senza sede selezionata.
  if (needsLocationSelection && basePage !== "accessibility") {
    // Prima che shell-context risponda (hint dal server) l'elenco sedi non è
    // ancora noto: loader neutro al posto del gestionale, mai il flash della
    // dashboard né il messaggio "nessuna sede" a vuoto.
    if (!shellContextLoaded) {
      return (
        <>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" precedence="bs" />
          <link rel="stylesheet" href="/assets/css/app.css" precedence="app" />
          <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light p-3">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Caricamento…</span>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" precedence="bs" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" precedence="bs" />
        <link rel="stylesheet" href="/assets/css/app.css" precedence="app" />
        <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light p-3">
          <div className="card shadow-sm" style={{ maxWidth: 480, width: "100%" }}>
            <div className="card-body p-4">
              <div className="text-muted small text-uppercase fw-semibold">Sede operativa</div>
              <h1 className="h4 fw-bold mt-1 mb-2">Seleziona sede</h1>
              {locations.length === 0 ? (
                <div className="text-muted">
                  Nessuna sede attiva risulta assegnata al tuo operatore. Chiedi a un amministratore di aggiornare le sedi abilitate prima di continuare.
                </div>
              ) : (
                <>
                  <div className="text-muted mb-3">Scegli la sede su cui vuoi lavorare. Il gestionale verra caricato dopo la selezione.</div>
                  <div className="vstack gap-2">
                    {locations.map((location) => (
                      <button
                        key={location.id}
                        type="button"
                        className="btn btn-outline-primary d-flex justify-content-between align-items-center"
                        onClick={() => switchLocation(Number(location.id))}
                      >
                        <span className="fw-semibold">{location.name || `Sede #${location.id}`}</span>
                        <span className="small">Continua con questa sede</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" precedence="bs" />
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" precedence="bs" />
      <link rel="stylesheet" href="/assets/css/app.css" precedence="app" />
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" async />
      {/* Chart.js 4.4.1 in bundle LOCALE (prima dal CDN jsdelivr): il grafico
          dashboard non dipende più dalla raggiungibilità di un host esterno. */}
      <script src="/assets/vendor/chart.umd.min.js" async />

      {/* CSS del gate verifica email — blocco <style> verbatim di View.php 421-440. */}
      {emailVerificationGate ? (
        <style>{`
    body.email-verification-gate .app-sidebar .sidebar-toggle{display:none!important;}
    body.email-verification-gate .app-main{min-height:100vh;min-height:100dvh;}
    @media (max-width: 992px){
      body.email-verification-gate .app-shell{display:block;}
      body.email-verification-gate .app-sidebar{
        position:static;
        left:auto;
        width:100%;
        height:auto;
        min-height:0;
        border-right:0;
        border-bottom:1px solid var(--border);
        box-shadow:none;
      }
      body.email-verification-gate .app-content{padding:16px;}
    }
        `}</style>
      ) : null}

      <div id="sidebarBackdrop" className="app-backdrop" />
      <div className="app-shell">
        <aside className="app-sidebar" id="sidebar">
          <div className="d-flex align-items-center justify-content-between">
            <a className="brand" href={pageHref(slug, emailVerificationGate ? "accessibility" : "dashboard")}>
              <span className="mark">P</span>
              <span className="name">Prenodo</span>
            </a>
            <button className="sidebar-toggle sidebar-collapse-toggle d-none d-lg-inline-flex" id="sidebarDesktopToggle" type="button" aria-label="Comprimi sidebar" aria-expanded="true">
              <i className="bi bi-chevron-left" />
            </button>
            <button className="sidebar-toggle d-lg-none" id="sidebarClose" type="button" aria-label="Chiudi">
              <i className="bi bi-x-lg" />
            </button>
          </div>

          {emailVerificationGate ? null : RENDERED_MENU.map((group, gi) => (
            <div className="nav-section" key={gi}>
              {group.label ? <div className="nav-label">{group.label}</div> : null}
              {group.entries.map((entry) => {
                const { item, children } = entry;
                const hasSubmenu = children.length > 0;
                const hasActiveChild = children.some((child) => basePage === child.page.split("&")[0]);
                const open = submenuToggles[item.page] ?? hasActiveChild;
                const parentClasses = [
                  "nav-item",
                  basePage === item.page.split("&")[0] ? "active" : "",
                  hasSubmenu ? "has-submenu" : "",
                  hasSubmenu && hasActiveChild ? "has-active-child" : "",
                  hasSubmenu && open ? "is-submenu-open" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div key={item.page} style={{ display: "contents" }}>
                    <a
                      className={parentClasses}
                      href={pageHref(slug, item.page)}
                      data-label={item.label}
                      title={item.label}
                      aria-haspopup={hasSubmenu ? "true" : undefined}
                      aria-expanded={hasSubmenu ? (open ? "true" : "false") : undefined}
                    >
                      <i className={`bi bi-${item.icon}`} />
                      {item.label}
                      {hasSubmenu ? (
                        <span
                          className="sidebar-chevron"
                          aria-hidden="true"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleSubmenu(item.page, hasActiveChild);
                          }}
                        >
                          <i className={`bi bi-chevron-${open ? "up" : "down"}`} />
                        </span>
                      ) : null}
                    </a>
                    {hasSubmenu ? (
                      <div className={`sidebar-submenu${open ? " is-open" : ""}`} hidden={!open}>
                        {children.map((child) => (
                          <a
                            key={child.page}
                            className={`nav-item nav-subitem submenu-child ${basePage === child.page.split("&")[0] ? "active" : ""}`.trim()}
                            href={pageHref(slug, child.page)}
                            data-label={child.label}
                            title={child.label}
                          >
                            <i className={`bi bi-${child.icon}`} />
                            {child.label}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}

          <div className="mt-auto pt-3">
            <div className="small-muted px-2">
              <strong>Accesso:</strong> <strong>{userName}</strong>
            </div>
            <a className="nav-item mt-2" href={`/${encodeURIComponent(slug)}/logout`}>
              <i className="bi bi-box-arrow-right" />
              Esci
            </a>
          </div>
        </aside>

        <div className="app-main">
          {/* Topbar nascosta sotto gate verifica email (View.php 761). */}
          {emailVerificationGate ? null : (
          <header className="topbar">
            <button className="icon-btn d-lg-none" id="sidebarOpen" type="button" aria-label="Menu">
              <i className="bi bi-list" />
            </button>

            <div className="search d-none d-md-block" ref={searchBoxRef}>
              <i className="bi bi-search" />
              <input
                type="search"
                placeholder="Cerca..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchOpen(true);
                  setActiveIndex(0);
                }}
                onFocus={() => {
                  if (searchQuery.trim()) setSearchOpen(true);
                }}
                onKeyDown={onSearchKeyDown}
                role="combobox"
                aria-expanded={searchOpen && searchMatches.length > 0}
                aria-controls="topbarFunctionSearchMenu"
                aria-autocomplete="list"
              />
              {searchOpen && searchMatches.length > 0 ? (
                <ul
                  className="dropdown-menu show w-100 mt-1"
                  id="topbarFunctionSearchMenu"
                  style={{ position: "absolute", top: "100%", left: 0, maxHeight: "60vh", overflowY: "auto", zIndex: 1080 }}
                >
                  {searchMatches.map((entry, i) => (
                    <li key={entry.page}>
                      <button
                        type="button"
                        className={`dropdown-item d-flex align-items-center gap-2${i === activeIndex ? " active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          goToFunction(entry);
                        }}
                        onMouseEnter={() => setActiveIndex(i)}
                      >
                        <i className={`bi bi-${entry.icon}`} />
                        <span className="flex-grow-1 text-truncate">{entry.label}</span>
                        {entry.group ? <small className="text-muted">{entry.group}</small> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="actions ms-auto">
              {locations.length > 1 && currentLocationId > 0 ? (
                <select
                  className="form-select form-select-sm"
                  id="topbarLocationSwitch"
                  style={{ width: "auto", minWidth: 180 }}
                  title="Sede corrente"
                  value={currentLocationId}
                  onChange={(e) => switchLocation(Number(e.target.value))}
                >
                  {locations
                    .filter((loc) => loc.id > 0)
                    .map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name || `Sede #${loc.id}`}
                      </option>
                    ))}
                </select>
              ) : null}
              {/* Gate legacy per-elemento (View.php 796-824): il bottone
                  quick-booking e le tre campanelle scorciatoia esistono SOLO
                  col permesso corrispondente; la campanella Notifiche con
                  notifications.view. */}
              {topbar.quickBooking ? (
                <button
                  className="btn btn-primary btn-pill"
                  type="button"
                  data-qb-new="1"
                  aria-label="Nuova prenotazione"
                >
                  <i className="bi bi-plus-lg me-1" />
                  <span className="topbar-action-text">Prenotazione</span>
                </button>
              ) : null}
              {topbar.canViewNotifications ? (
                <>
                  {topbar.bellBirthdays ? renderBell("notifications_birthdays", "cake2", "Compleanni clienti", notif.birthdays, "birthdays", "compleanni") : null}
                  {topbar.bellInstallments ? renderBell("notifications_installments", "cash-stack", "Rate in scadenza / scadute", notif.installments, "installments", "rate") : null}
                  {topbar.bellQuotes ? renderBell("notifications_quotes", "file-earmark-text", "Preventivi", notif.quotes, "quotes", "preventivi") : null}
                  {renderBell("notifications", "bell", "Notifiche", notif.count, "count", "notifiche")}
                </>
              ) : null}
              <div className="dropdown">
                <button className="icon-btn dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Account">
                  <i className="bi bi-person-circle" />
                </button>
                {/* Voci gated per-permesso come View.php 830-846 (Auth::can:
                    Ruoli è di fatto solo-Admin — non-assegnabile); Accessibilità
                    ed Esci sempre presenti per l'utente autenticato. */}
                <ul className="dropdown-menu dropdown-menu-end">
                  {topbar.accountBusinessProfile ? (
                    <li><a className="dropdown-item" href={pageHref(slug, "business_profile")}><i className="bi bi-gear me-2" />Profilo attività</a></li>
                  ) : null}
                  {topbar.accountLocations ? (
                    <li><a className="dropdown-item" href={pageHref(slug, "locations")}><i className="bi bi-building me-2" />Sedi</a></li>
                  ) : null}
                  {topbar.accountConsentModules ? (
                    <li><a className="dropdown-item" href={pageHref(slug, "consent_modules")}><i className="bi bi-shield-check me-2" />Moduli consenso</a></li>
                  ) : null}
                  <li><a className="dropdown-item" href={pageHref(slug, "accessibility")}><i className="bi bi-universal-access me-2" />Accessibilità</a></li>
                  {topbar.accountRoles ? (
                    <li><a className="dropdown-item" href={pageHref(slug, "roles")}><i className="bi bi-shield-lock me-2" />Ruoli</a></li>
                  ) : null}
                  <li><hr className="dropdown-divider" /></li>
                  <li><a className="dropdown-item" href={`/${encodeURIComponent(slug)}/logout`}><i className="bi bi-box-arrow-right me-2" />Esci</a></li>
                </ul>
              </div>
            </div>
          </header>
          )}

          {/* SUPPORT ACCESS sticky alert (verbatim port of View.php) — shown when
              an operator is acting through a support session (nascosto sotto
              gate verifica email, View.php 853). */}
          {!emailVerificationGate && supportAccess ? (
            <div className="alert alert-info border-0 rounded-0 mb-0 py-2" style={{ position: "sticky", top: 64, zIndex: 1021 }}>
              <div className="container-fluid">
                <div className="d-flex align-items-center gap-2">
                  <i className="bi bi-shield-check" />
                  <div className="flex-grow-1">
                    <strong>Accesso supporto attivo.</strong>
                    {supportAccess.created_by_email ? <> Generato da {supportAccess.created_by_email}.</> : null}
                    {supportAccess.reason ? <> Motivo: {supportAccess.reason}.</> : null}
                    {supportExpiresLabel ? <> Scade: {supportExpiresLabel}.</> : null}
                  </div>
                  <a className="btn btn-sm btn-outline-primary" href={`/${encodeURIComponent(slug)}/logout`}>
                    Termina accesso
                  </a>
                </div>
              </div>
            </div>
          ) : null}

          {/* STORE CLOSURE sticky alert (verbatim port of View.php) — nearest
              upcoming closure window; offset by 40px when support alert is shown
              (nascosto sotto gate verifica email, View.php 876). */}
          {!emailVerificationGate && closureRange ? (
            <div
              className="alert alert-warning border-0 rounded-0 mb-0 py-2"
              style={{ position: "sticky", top: supportAccess ? 104 : 64, zIndex: 1020 }}
            >
              <div className="container-fluid">
                <div className="d-flex align-items-center gap-2">
                  <i className="bi bi-exclamation-triangle-fill" />
                  <div className="flex-grow-1">
                    {closureRange.start === closureRange.end ? (
                      <>
                        <strong>Chiusura negozio:</strong> il negozio sarà chiuso il{" "}
                        <strong>{formatClosureDate(closureRange.start)}</strong>.
                      </>
                    ) : (
                      <>
                        <strong>Chiusura negozio:</strong> il negozio sarà chiuso dal{" "}
                        <strong>{formatClosureDate(closureRange.start)}</strong> al{" "}
                        <strong>{formatClosureDate(closureRange.end)}</strong>.
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <main className="app-content">{children}</main>
        </div>
      </div>

      {/* GLOBAL toast container — target for the window.notify() port of the
          legacy assets/js/app.js notify()/#appToastContainer. */}
      <div
        id="appToastContainer"
        className="toast-container position-fixed bottom-0 end-0 p-3"
        style={{ zIndex: 1080 }}
      />

      {/* GLOBAL quick-booking offcanvas: present on every manage page so any
          [data-qb-new] button (incl. the topbar "+ Prenotazione" above) opens it
          IN PLACE, with no navigation. */}
      <QuickBookingDrawer />
    </>
  );
}
