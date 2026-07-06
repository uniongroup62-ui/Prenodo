"use client";

import { useEffect, useState } from "react";

// Comportamenti condivisi delle pagine marketplace, port 1:1 di
// MarketplaceTopbar.php marketplace_topbar_script() + public_marketplace.js:
// - MarketplaceAccountNav: menu account della topbar (toggle; da SLOGGATO
//   'Promuovi la tua attività' + Menu con Accedi/Registrati, da LOGGATO chip
//   avatar/nome/email con Attività/Preferiti/Profilo/Esci).
// - useMarketplacePageEffects: treatment picker (tab/filtro/scelta),
//   suggerimenti città (comuni italy_geo.json + città sedi, validazione
//   'Seleziona una città dalla lista.'), preferiti (toggle con 401 -> login),
//   condivisione (copy link), object-position e sfondi city-card.

// ---------------------------------------------------------------------------
// Menu account topbar (public_marketplace.php 1005-1066).
// ---------------------------------------------------------------------------
type AccountUser = { email: string; fullName: string; firstName: string; lastName: string };

export function MarketplaceAccountNav({ returnPath = "/attivita" }: { returnPath?: string } = {}) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/account")
      .then((r) => r.json())
      .then((j: { ok?: boolean; user?: AccountUser | null }) => {
        if (alive && j?.ok && j.user?.email) setUser(j.user);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Chiusura su click fuori / Escape (initAccountMenus legacy).
  useEffect(() => {
    if (!open) return;
    const onDocClick = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logout() {
    try {
      await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {
      // il redirect avviene comunque, come /account/logout legacy
    }
    window.location.href = "/attivita";
  }

  const ret = encodeURIComponent(returnPath);

  if (user) {
    const name = user.fullName || `${user.firstName} ${user.lastName}`.trim() || user.email;
    const seed = name || user.email || "A";
    const customerInitial = seed.trim().charAt(0).toUpperCase() || "A";
    return (
      <nav className="header-actions">
        <div className="marketplace-account-wrap" data-marketplace-account-menu onClick={(e) => e.stopPropagation()}>
          <button
            className="marketplace-account-chip"
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            data-marketplace-account-toggle
            onClick={() => setOpen((o) => !o)}
          >
            <span className="marketplace-account-chip__avatar">{customerInitial}</span>
            <span className="marketplace-account-chip__text">
              <span className="marketplace-account-chip__name">{name}</span>
              {user.email ? <span className="marketplace-account-chip__email">{user.email}</span> : null}
            </span>
            <span className="marketplace-account-chip__chevron" aria-hidden="true"></span>
          </button>
          <div className="marketplace-account-menu" role="menu" hidden={!open} data-marketplace-account-panel>
            <a role="menuitem" href="/account/activities">
              Attivit&agrave;
            </a>
            <a role="menuitem" href="/account/favorites">
              Preferiti
            </a>
            <a role="menuitem" href="/account/profile">
              Profilo
            </a>
            <a
              className="is-danger"
              role="menuitem"
              href="/attivita"
              onClick={(event) => {
                event.preventDefault();
                void logout();
              }}
            >
              Esci
            </a>
          </div>
        </div>
      </nav>
    );
  }

  return (
    <nav className="header-actions">
      <a className="marketplace-promote-link" href="/#promuovi-attivita">
        Promuovi la tua attivit&agrave;
      </a>
      <div className="marketplace-account-wrap" data-marketplace-account-menu onClick={(e) => e.stopPropagation()}>
        <button
          className="marketplace-menu-chip"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          data-marketplace-account-toggle
          onClick={() => setOpen((o) => !o)}
        >
          <span>Menu</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 7h14"></path>
            <path d="M5 12h14"></path>
            <path d="M5 17h14"></path>
          </svg>
        </button>
        <div className="marketplace-account-menu marketplace-account-menu--public" role="menu" hidden={!open} data-marketplace-account-panel>
          <a role="menuitem" href={`/account/login?return=${ret}`}>
            Accedi
          </a>
          <a role="menuitem" href={`/account/register?return=${ret}`}>
            Registrati
          </a>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Effetti pagina (marketplace_topbar_script + public_marketplace.js).
// ---------------------------------------------------------------------------
function normalize(value: string): string {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function escapeHtml(value: string): string {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch] || ch));
}

const PREFERRED_CITIES = ["Roma", "Milano", "Napoli", "Torino", "Palermo", "Genova", "Bologna", "Firenze", "Bari", "Catania"];

// Città suggerite come il legacy (publicSearchCitySuggestions): città delle
// sedi pubblicate + comuni italiani (italy_geo.json) + preferite.
async function loadCitySuggestions(): Promise<string[]> {
  const cities: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const city = String(value ?? "").trim();
    if (!city) return;
    const key = city.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cities.push(city);
  };
  try {
    const j = await (await fetch("/api/marketplace")).json();
    for (const profile of j?.profiles ?? []) {
      for (const location of profile.locations ?? []) add(location.city);
    }
  } catch { /* come il catch legacy */ }
  try {
    const geo = await (await fetch("/assets/data/italy_geo.json")).json();
    const byProvince = geo?.citiesByProvince ?? {};
    const geoCities: string[] = [];
    for (const key of Object.keys(byProvince)) {
      for (const city of byProvince[key] ?? []) geoCities.push(String(city));
    }
    geoCities.sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base", numeric: true }));
    for (const city of geoCities) add(city);
  } catch { /* senza dataset restano le città delle sedi */ }
  for (const city of PREFERRED_CITIES) add(city);
  return cities;
}

function initTreatmentPickers(root: Document) {
  root.querySelectorAll<HTMLElement>("[data-marketplace-treatment-picker]").forEach((picker) => {
    if (picker.getAttribute("data-marketplace-treatment-ready") === "1") return;
    picker.setAttribute("data-marketplace-treatment-ready", "1");
    const trigger = picker.querySelector<HTMLElement>("[data-marketplace-treatment-trigger]");
    const panel = picker.querySelector<HTMLElement>("[data-marketplace-treatment-panel]");
    const label = picker.querySelector<HTMLElement>("[data-marketplace-treatment-label]");
    const categoryInput = picker.querySelector<HTMLInputElement>("[data-marketplace-treatment-category]");
    const queryInput = picker.querySelector<HTMLInputElement>("[data-marketplace-treatment-query]");
    const serviceInput = picker.querySelector<HTMLInputElement>("[data-marketplace-treatment-service]");
    const filterInput = picker.querySelector<HTMLInputElement>("[data-marketplace-treatment-filter]");
    const emptyNode = picker.querySelector<HTMLElement>("[data-marketplace-treatment-empty]");
    const tabs = Array.from(picker.querySelectorAll<HTMLElement>("[data-marketplace-treatment-tab]"));
    const lists = Array.from(picker.querySelectorAll<HTMLElement>("[data-marketplace-treatment-list]"));
    if (!trigger || !panel || !label || !categoryInput || !queryInput || !serviceInput) return;
    let activeTab = (tabs.find((tab) => tab.classList.contains("is-active")) ?? tabs[0])?.dataset.marketplaceTreatmentTab || "categories";

    const currentList = () => lists.find((list) => list.dataset.marketplaceTreatmentList === activeTab) ?? null;
    const applyFilter = () => {
      const query = normalize(filterInput?.value ?? "");
      const list = currentList();
      let visible = 0;
      if (list) {
        list.querySelectorAll<HTMLElement>("[data-marketplace-treatment-option]").forEach((option) => {
          const haystack = normalize(option.getAttribute("data-treatment-search") || option.textContent || "");
          const show = query === "" || haystack.includes(query);
          option.hidden = !show;
          if (show) visible += 1;
        });
      }
      if (emptyNode) emptyNode.classList.toggle("is-visible", visible === 0);
    };
    const syncFilterVisibility = () => {
      if (!filterInput) return;
      const hideFilter = activeTab === "categories";
      filterInput.hidden = hideFilter;
      filterInput.setAttribute("aria-hidden", hideFilter ? "true" : "false");
      filterInput.tabIndex = hideFilter ? -1 : 0;
    };
    const setActiveTab = (tabName: string) => {
      activeTab = tabName || "categories";
      tabs.forEach((tab) => {
        const active = tab.dataset.marketplaceTreatmentTab === activeTab;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
      });
      lists.forEach((list) => {
        list.hidden = list.dataset.marketplaceTreatmentList !== activeTab;
      });
      if (filterInput) filterInput.value = "";
      syncFilterVisibility();
      applyFilter();
    };
    const close = () => {
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };
    const openPanel = () => {
      root.querySelectorAll<HTMLElement>("[data-marketplace-treatment-panel]").forEach((other) => {
        if (other !== panel) other.hidden = true;
      });
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      setActiveTab(activeTab);
      window.setTimeout(() => {
        if (filterInput && !filterInput.hidden) filterInput.focus();
      }, 0);
    };
    const choose = (option: HTMLElement) => {
      label.textContent = option.getAttribute("data-treatment-label") || "Tutte le attivita";
      categoryInput.value = option.getAttribute("data-treatment-category") || "";
      queryInput.value = option.getAttribute("data-treatment-query") || "";
      serviceInput.value = option.getAttribute("data-treatment-service") || "";
      picker.querySelectorAll<HTMLElement>("[data-marketplace-treatment-option]").forEach((candidate) => {
        const selected = candidate === option;
        candidate.classList.toggle("is-active", selected);
        candidate.setAttribute("aria-selected", selected ? "true" : "false");
      });
      close();
      trigger.focus();
    };

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.hidden) openPanel();
      else close();
    });
    tabs.forEach((tab) => {
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        setActiveTab(tab.dataset.marketplaceTreatmentTab || "categories");
        if (filterInput && !filterInput.hidden) filterInput.focus();
      });
    });
    filterInput?.addEventListener("input", applyFilter);
    panel.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-marketplace-treatment-filter]")) return;
      event.preventDefault();
    });
    panel.addEventListener("click", (event) => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-marketplace-treatment-option]") : null;
      if (option) choose(option);
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Node && picker.contains(target)) return;
      close();
    });
  });
}

function initCitySuggestions(root: Document, cityOptions: string[]) {
  const findExactCity = (value: string) => {
    const target = normalize(value);
    if (target === "") return "";
    return cityOptions.find((city) => normalize(city) === target) || "";
  };
  root.querySelectorAll<HTMLFormElement>("[data-marketplace-topbar-search]").forEach((form) => {
    if (form.getAttribute("data-marketplace-topbar-ready") === "1") return;
    form.setAttribute("data-marketplace-topbar-ready", "1");
    const input = form.querySelector<HTMLInputElement>("[data-marketplace-topbar-city-input]");
    const panel = form.querySelector<HTMLElement>("[data-marketplace-topbar-city-suggestions]");
    if (!input || !panel || !cityOptions.length) return;

    let selectedCity = findExactCity(input.value);
    const closeSuggestions = () => {
      panel.hidden = true;
      panel.innerHTML = "";
    };
    const chooseCity = (value: string) => {
      const city = findExactCity(value);
      if (city === "") return;
      selectedCity = city;
      input.value = city;
      input.setCustomValidity("");
      closeSuggestions();
      input.focus();
    };
    const renderSuggestions = () => {
      const query = normalize(input.value);
      if (query === "") {
        closeSuggestions();
        return;
      }
      const items = cityOptions.filter((value) => normalize(value).includes(query)).slice(0, 8);
      if (!items.length) {
        closeSuggestions();
        return;
      }
      const panelId = panel.id || (input.id ? `${input.id}-suggestions-panel` : "marketplace-topbar-city-suggestions-panel");
      panel.id = panelId;
      panel.innerHTML = items
        .map((value, index) => {
          const safe = escapeHtml(value);
          return `<button class="marketplace-topbar-city-suggestion" id="${panelId}-item-${index}" type="button" role="option" data-city-suggestion="${safe}">${safe}</button>`;
        })
        .join("");
      panel.hidden = false;
    };

    input.setAttribute("aria-autocomplete", "list");
    input.addEventListener("input", () => {
      selectedCity = "";
      input.setCustomValidity("");
      renderSuggestions();
    });
    panel.addEventListener("mousedown", (event) => event.preventDefault());
    panel.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-city-suggestion]") : null;
      if (button) chooseCity(button.getAttribute("data-city-suggestion") || "");
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Node && (target === input || panel.contains(target))) return;
      closeSuggestions();
    });
    // Validazione legacy: la città digitata deve essere scelta dalla lista.
    form.addEventListener("submit", (event) => {
      const typed = input.value.trim();
      if (typed === "") {
        input.setCustomValidity("");
        return;
      }
      if (selectedCity !== "" && normalize(selectedCity) === normalize(typed)) {
        input.value = selectedCity;
        input.setCustomValidity("");
        return;
      }
      event.preventDefault();
      selectedCity = "";
      input.setCustomValidity("Seleziona una città dalla lista.");
      renderSuggestions();
      input.reportValidity();
    });
  });
}

function initFavoriteButtons(root: Document, loginUrl: string) {
  const buttons = Array.from(root.querySelectorAll<HTMLElement>("[data-favorite-button]"));
  if (!buttons.length) return;
  const setButton = (button: HTMLElement, active: boolean) => {
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", active ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti");
  };
  const setKey = (key: string, active: boolean) => {
    if (!key) return;
    buttons.forEach((button) => {
      if ((button.dataset.favoriteKey || "") === key) setButton(button, active);
    });
  };
  // Stato iniziale dai preferiti dell'account (il legacy li marca server-side).
  fetch("/api/account")
    .then((r) => r.json())
    .then((j: { ok?: boolean; favoriteKeys?: Record<string, boolean> }) => {
      const keys = j?.favoriteKeys ?? {};
      for (const key of Object.keys(keys)) setKey(key, true);
    })
    .catch(() => undefined);

  buttons.forEach((button) => {
    if (button.getAttribute("data-favorite-ready") === "1") return;
    button.setAttribute("data-favorite-ready", "1");
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.classList.contains("is-loading")) return;
      button.classList.add("is-loading");
      try {
        const response = await fetch("/api/account", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action: "toggle_favorite",
            tenant_slug: button.dataset.tenantSlug || "",
            location_id: button.dataset.locationId || "0",
            location_slug: button.dataset.locationSlug || "",
          }),
        });
        const data = await response.json().catch(() => ({} as Record<string, unknown>));
        if (response.status === 401) {
          window.location.href = loginUrl;
          return;
        }
        if (!response.ok || !data.ok) throw new Error(String(data.error || "Errore preferiti"));
        setKey(String(data.key || button.dataset.favoriteKey || ""), Boolean(data.active));
      } catch (error) {
        console.error(error);
      } finally {
        button.classList.remove("is-loading");
      }
    });
  });
}

function initShareButtons(root: Document) {
  root.querySelectorAll<HTMLElement>("[data-share-button]").forEach((button) => {
    if (button.getAttribute("data-share-ready") === "1") return;
    button.setAttribute("data-share-ready", "1");
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = button.getAttribute("data-share-url") || window.location.href;
      const title = button.getAttribute("data-share-title") || document.title;
      const text = button.getAttribute("data-share-text") || "";
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ url, title, text });
          return;
        } catch { /* annullato: fallback copy */ }
      }
      try {
        await navigator.clipboard.writeText(url);
        const previousLabel = button.getAttribute("aria-label") || "Condividi scheda";
        button.classList.add("is-copied");
        button.setAttribute("aria-label", "Link copiato");
        window.setTimeout(() => {
          button.classList.remove("is-copied");
          button.setAttribute("aria-label", previousLabel);
        }, 1600);
      } catch { /* clipboard non disponibile */ }
    });
  });
}

function applyImageEffects(root: Document) {
  const positionPattern = /^\d{1,3}%\s+\d{1,3}%$/;
  root.querySelectorAll<HTMLElement>("[data-object-position]").forEach((image) => {
    const position = String(image.getAttribute("data-object-position") || "").trim();
    if (positionPattern.test(position)) (image as HTMLElement).style.objectPosition = position;
  });
  root.querySelectorAll<HTMLElement>("[data-city-image]").forEach((card) => {
    const image = String(card.getAttribute("data-city-image") || "").trim();
    if (!image) return;
    const escapedImage = image.replace(/["\\\n\r\f]/g, "\\$&");
    card.style.setProperty("--city-image", `url("${escapedImage}")`);
  });
}

// Hook unico per le pagine marketplace: da chiamare dopo il primo render dei
// contenuti dinamici (dipendenza sui dati caricati per ri-cablare le card).
export function useMarketplacePageEffects(deps: unknown[] = [], options: { loginUrl?: string } = {}) {
  const loginUrl = options.loginUrl ?? "/account/login?return=%2Fattivita";
  useEffect(() => {
    const root = document;
    applyImageEffects(root);
    initTreatmentPickers(root);
    initFavoriteButtons(root, loginUrl);
    initShareButtons(root);
    let cancelled = false;
    void loadCitySuggestions().then((cities) => {
      if (!cancelled) initCitySuggestions(root, cities);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
