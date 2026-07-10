// Motore CLIENT del feed notifiche browser — port 1:1 dello script globale del
// footer legacy (app/lib/View.php 2013-2021 e 2126-2288): gestione delle chiavi
// "viste" in localStorage (scoperte per tenant:utente:sede, cap ultime 180),
// idratazione al primo giro (marca tutto visto SENZA notificare), pubblicazione
// dei nuovi eventi — toast in-page quando la scheda è attiva, notifica NATIVA
// quando è nascosta/senza focus — e raggruppamento in un singolo evento
// "N nuove notifiche" quando i nuovi sono più di 3. Nessun accesso diretto a
// DOM/Notification/localStorage: l'ambiente è iniettato (testabile in Node).

export type FeedEventLike = {
  key?: string;
  type?: string;
  title?: string;
  body?: string;
  url?: string;
  severity?: string;
};

export type FeedEnv = {
  storageGet(key: string): string | null;
  storageSet(key: string, value: string): void;
  // new Notification(...) con onclick → focus+navigate; true se mostrata.
  showNative(event: FeedEventLike): boolean;
  // showToast legacy (bootstrap, bottom-end, 4.5s).
  showToast(message: string, variant: string): void;
  // !document.hidden && document.hasFocus() — se attiva si usa il toast.
  isPageActive(): boolean;
  // URL della pagina notifiche (fallback + url del gruppo).
  notificationsUrl: string;
};

// storagePrefix legacy (View.php 2013-2018): scope per tenant, utente e sede
// correnti così account/sedi diverse sullo stesso browser non si contaminano.
export function browserNotificationStoragePrefix(tenant: string, userId: number, locationId: number): string {
  return ["beautysuite_browser_notifications", String(tenant || "root"), String(userId || "0"), String(locationId || "0")].join(":");
}

export function createBrowserNotificationFeed(prefix: string, env: FeedEnv) {
  const seenKey = `${prefix}:seen`;
  const hydratedKey = `${prefix}:hydrated`;
  const enabledKey = `${prefix}:enabled`;
  let feedHydrated = env.storageGet(hydratedKey) === "1";

  function readSeen(): string[] {
    try {
      const parsed = JSON.parse(env.storageGet(seenKey) || "[]");
      return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
    } catch {
      return [];
    }
  }

  function writeSeen(values: string[]): void {
    const compact = Array.from(new Set(values.filter(Boolean).map(String))).slice(-180);
    env.storageSet(seenKey, JSON.stringify(compact));
  }

  function markSeen(events: FeedEventLike[]): void {
    const seen = readSeen();
    for (const event of events) {
      if (event && event.key) seen.push(String(event.key));
    }
    writeSeen(seen);
  }

  function unseenEvents(events: FeedEventLike[]): FeedEventLike[] {
    const seen = new Set(readSeen());
    return events.filter((event) => Boolean(event && event.key && !seen.has(String(event.key))));
  }

  // publishEvent legacy: scheda nascosta/senza focus → notifica nativa;
  // altrimenti toast "titolo: corpo" con la severity dell'evento.
  function publishEvent(event: FeedEventLike): boolean {
    const message = String(event.title || "Notifica") + (event.body ? `: ${String(event.body)}` : "");
    if (!env.isPageActive()) return env.showNative(event);
    env.showToast(message, event.severity || "info");
    return true;
  }

  // publishEvents legacy: più di 3 nuovi → UN solo evento raggruppato.
  function publishEvents(events: FeedEventLike[]): boolean {
    if (!events.length) return false;
    if (events.length > 3) {
      return publishEvent({
        key: `group:${events.map((e) => e.key).join(":")}`,
        title: `${events.length} nuove notifiche`,
        body: events.slice(0, 3).map((e) => e.title || "Notifica").join(" | "),
        url: env.notificationsUrl,
        severity: "primary",
      });
    }
    let delivered = false;
    for (const event of events) {
      if (publishEvent(event)) delivered = true;
    }
    return delivered;
  }

  // handleFeedEvents legacy: al primo giro (baseline o non idratato) marca
  // TUTTO come visto senza pubblicare; poi pubblica solo i non visti e li
  // marca SOLO se la pubblicazione è andata a segno.
  function handleFeedEvents(rawEvents: unknown, baseline: boolean): void {
    const events: FeedEventLike[] = Array.isArray(rawEvents) ? (rawEvents as FeedEventLike[]) : [];
    if (!events.length) {
      if (!feedHydrated) {
        feedHydrated = true;
        env.storageSet(hydratedKey, "1");
      }
      return;
    }
    if (baseline || !feedHydrated) {
      markSeen(events);
      feedHydrated = true;
      env.storageSet(hydratedKey, "1");
      return;
    }
    const fresh = unseenEvents(events);
    if (!fresh.length) return;
    if (publishEvents(fresh)) {
      markSeen(fresh);
    }
  }

  return {
    handleFeedEvents,
    isHydrated: () => feedHydrated,
    // browserNotificationsEnabled legacy scrive enabled='1' quando il permesso
    // risulta concesso (marker write-only, mantenuto per parità di storage).
    markEnabled: () => env.storageSet(enabledKey, "1"),
  };
}
