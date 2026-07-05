"use client";

import { useEffect, useMemo, useState } from "react";

// Port PIXEL-FEDELE dell'editor promozioni PHP (promotions.php action=new|edit,
// markup estratto dall'istanza live): form dentro un <div class="card"> con
// header interno (titolo + sottotitolo + Salva/Annulla in alto E in basso),
// colonna sinistra Informazioni (nome/descrizione/condizioni/Attiva+Cumulabile
// affiancati con sub-toggle Fidelity-Coupon/tabella Sedi abilitate) e
// Servizi-Prodotti (select + picker con "Sconto rapido", ricerca e sconto per
// voce) + sezione Sconto con i box globali; colonna destra Validità (Dal/Al +
// Giorni-orari validi + Date escluse), Target clienti (box condizionali +
// Clienti esclusi con select+Aggiungi come il legacy) e Limiti utilizzo.
// NB legacy: nessun campo "Visibilità marketplace" nell'editor (il backend
// salva sempre 'auto'); il toggle Cumulabile senza metodo scelto abilita lo
// Sconto punti Fidelity (default legacy 4).

type ApplyMode = "none" | "all" | "selected";
type DiscountType = "percent" | "fixed";
type TargetType = "all" | "new" | "inactive" | "birthday" | "fidelity";

type PromotionForm = {
  id: number;
  title: string;
  description: string;
  promo_conditions_enabled: boolean;
  promo_conditions: string;
  is_active: boolean;
  apply_services_mode: ApplyMode;
  apply_products_mode: ApplyMode;
  discount_type: DiscountType;
  discount_value: string;
  min_qty: string;
  products_discount_type: DiscountType;
  products_discount_value: string;
  products_min_qty: string;
  starts_at: string;
  ends_at: string;
  target_type: TargetType;
  new_within_days: string;
  inactive_days: string;
  birthday_window_days: string;
  per_customer_limit: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyForm(): PromotionForm {
  return {
    id: 0,
    title: "",
    description: "",
    promo_conditions_enabled: false,
    promo_conditions: "",
    is_active: true,
    apply_services_mode: "all",
    apply_products_mode: "none",
    discount_type: "percent",
    discount_value: "10",
    min_qty: "1",
    products_discount_type: "percent",
    products_discount_value: "10",
    products_min_qty: "1",
    starts_at: "",
    ends_at: "",
    target_type: "all",
    new_within_days: "",
    inactive_days: "",
    birthday_window_days: "",
    per_customer_limit: "",
  };
}

function resolveAction(): "new" | "edit" | "duplicate" {
  if (typeof window === "undefined") return "new";
  const a = new URLSearchParams(window.location.search).get("action");
  return a === "edit" ? "edit" : a === "duplicate" ? "duplicate" : "new";
}

type ItemRow = { id: number; discountType: DiscountType; discountValue: string; minQty: string };
type TimeWindow = { day: number; start: string; end: string };
type CatItem = { id: number; name: string; price?: number; sku?: string };
type FormContext = {
  services: CatItem[];
  products: CatItem[];
  locations: { id: number; name: string }[];
  fidelityLevels: { key: string; name: string }[];
  clients: { id: number; name: string }[];
};

const DAY_LABELS = ["", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

export function PromotionFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita (SSR-safe, come PromotionsContent).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit" | "duplicate">(resolveAction);
  // Clona campagna (action=duplicate): il salvataggio crea una NUOVA promo con
  // replace_source_id (la sorgente viene ritirata dal writer legacy).
  const [replaceSourceId, setReplaceSourceId] = useState(0);
  const [form, setForm] = useState<PromotionForm>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [ctx, setCtx] = useState<FormContext>({ services: [], products: [], locations: [], fidelityLevels: [], clients: [] });
  const [services, setServices] = useState<ItemRow[]>([]);
  const [products, setProducts] = useState<ItemRow[]>([]);
  const [locationIds, setLocationIds] = useState<number[]>([]);
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>([]);
  const [blackoutDates, setBlackoutDates] = useState<string[]>([]);
  const [fidelityLevels, setFidelityLevels] = useState<string[]>([]);
  const [excludedClients, setExcludedClients] = useState<number[]>([]);
  const [stackableMaster, setStackableMaster] = useState(false);
  const [stackableFidelity, setStackableFidelity] = useState(false);
  const [stackableCoupon, setStackableCoupon] = useState(false);
  const [marketplaceVisibility, setMarketplaceVisibility] = useState<"auto" | "hidden">("auto");

  // Sconto rapido (selezionati) + ricerca picker.
  const [quickSvc, setQuickSvc] = useState<{ type: DiscountType; value: string; minQty: string }>({ type: "percent", value: "", minQty: "1" });
  const [quickPrd, setQuickPrd] = useState<{ type: DiscountType; value: string; minQty: string }>({ type: "percent", value: "", minQty: "1" });
  const [svcFilter, setSvcFilter] = useState("");
  const [prdFilter, setPrdFilter] = useState("");
  const [excludeCandidate, setExcludeCandidate] = useState("");

  useEffect(() => {
    fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}&action=context`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) {
          setCtx({ services: j.services ?? [], products: j.products ?? [], locations: j.locations ?? [], fidelityLevels: j.fidelityLevels ?? [], clients: j.clients ?? [] });
          // Legacy: nel form nuovo tutte le sedi partono spuntate.
          setLocationIds((prev) => (prev.length ? prev : (j.locations ?? []).map((l: { id: number }) => Number(l.id))));
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const actRaw = params.get("action");
    const act = actRaw === "edit" ? "edit" : actRaw === "duplicate" ? "duplicate" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    const editPromise =
      (act === "edit" || act === "duplicate") && Number.isFinite(id) && id > 0
        ? (act === "edit"
            // Guardia lock strutturale legacy (promotions.php 999-1004): con
            // utilizzi collegati il form NON si apre — redirect alla lista con
            // open_summary + errore.
            ? fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}&action=edit_guard&id=${id}`, { headers: { "x-tenant-slug": slug } })
                .then((r) => r.json())
                .then((g) => {
                  const reason = String(g?.reason ?? "");
                  if (reason !== "") {
                    window.location.href = `/${encodeURIComponent(slug)}/promotions?open_summary=${id}&err=${encodeURIComponent(reason)}`;
                    return null;
                  }
                  return true;
                })
                .catch(() => true)
            : Promise.resolve(true)
          ).then((proceed) => {
            if (proceed === null) return Promise.resolve();
            return fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
            headers: { "x-tenant-slug": slug },
          })
            .then((r) => r.json())
            .then((j) => {
              if (!j.ok || !j.promotion) {
                setError(String(j.error ?? "Promozione non trovata."));
                return;
              }
              const p = j.promotion;
              if (act === "duplicate") setReplaceSourceId(id);
              setForm({
                id: act === "duplicate" ? 0 : Number(p.id ?? id),
                title: String(p.name ?? ""),
                description: String(p.description ?? ""),
                promo_conditions_enabled: Boolean(p.promoConditionsEnabled ?? false),
                promo_conditions: String(p.promoConditions ?? ""),
                is_active: Boolean(p.active ?? true),
                apply_services_mode: (p.applyServicesMode ?? "all") as ApplyMode,
                apply_products_mode: (p.applyProductsMode ?? "none") as ApplyMode,
                discount_type: p.discountType === "fixed" ? "fixed" : "percent",
                discount_value: String(p.discountValue ?? 0),
                min_qty: String(p.minQty ?? "1"),
                products_discount_type: p.productsDiscountType === "fixed" ? "fixed" : "percent",
                products_discount_value: String(p.productsDiscountValue ?? p.discountValue ?? 0),
                products_min_qty: String(p.minQty ?? "1"),
                starts_at: String(p.startsAt ?? "").slice(0, 10),
                ends_at: String(p.endsAt ?? "").slice(0, 10),
                target_type: (p.target === "new_clients" ? "new" : p.target ?? "all") as TargetType,
                new_within_days: String(p.newWithinDays ?? ""),
                inactive_days: String(p.inactiveDays ?? ""),
                birthday_window_days: String(p.birthdayWindowDays ?? ""),
                per_customer_limit: String(p.perCustomerLimit ?? ""),
              });
              const toRows = (arr: unknown): ItemRow[] => (Array.isArray(arr) ? arr : []).map((it) => ({ id: Number((it as ItemRow).id), discountType: (it as ItemRow).discountType === "fixed" ? "fixed" : "percent", discountValue: String((it as ItemRow).discountValue ?? 0), minQty: String((it as ItemRow).minQty ?? 1) }));
              setServices(toRows(p.selectedServices));
              setProducts(toRows(p.selectedProducts));
              setLocationIds(Array.isArray(p.locationIds) ? p.locationIds.map(Number) : []);
              setTimeWindows(Array.isArray(p.timeWindows) ? p.timeWindows.map((w: TimeWindow) => ({ day: Number(w.day), start: String(w.start), end: String(w.end) })) : []);
              setBlackoutDates(Array.isArray(p.blackoutDates) ? p.blackoutDates.map(String) : []);
              setFidelityLevels(Array.isArray(p.targetFidelityLevels) ? p.targetFidelityLevels.map(String) : []);
              setExcludedClients(Array.isArray(p.excludedClientIds) ? p.excludedClientIds.map(Number) : []);
              setStackableFidelity(Boolean(p.stackableFidelity));
              setStackableCoupon(Boolean(p.stackableCoupon));
              setStackableMaster(Boolean(p.stackableFidelity) || Boolean(p.stackableCoupon));
              setMarketplaceVisibility(act === "duplicate" ? "auto" : p.marketplaceVisibility === "hidden" ? "hidden" : "auto");
            })
            .catch(() => setError("Errore nel caricamento della promozione."));
          })
        : Promise.resolve();

    editPromise.finally(() => setLoading(false));
  }, [slug]);

  function set<K extends keyof PromotionForm>(key: K, value: PromotionForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/promotions`;
  }

  function toggleItem(kind: "svc" | "prd", id: number) {
    const [list, setList, quick] = kind === "svc" ? [services, setServices, quickSvc] as const : [products, setProducts, quickPrd] as const;
    setList(list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : [...list, { id, discountType: quick.type, discountValue: quick.value || "10", minQty: quick.minQty || "1" }]);
  }
  function updateItem(kind: "svc" | "prd", id: number, patch: Partial<ItemRow>) {
    const [list, setList] = kind === "svc" ? [services, setServices] as const : [products, setProducts] as const;
    setList(list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  // "Sconto rapido": applica Tipo/Valore/Qta min a tutte le voci spuntate.
  function applyQuick(kind: "svc" | "prd") {
    const [list, setList, quick] = kind === "svc" ? [services, setServices, quickSvc] as const : [products, setProducts, quickPrd] as const;
    setList(list.map((r) => ({ ...r, discountType: quick.type, discountValue: quick.value || r.discountValue, minQty: quick.minQty || r.minQty })));
  }
  function toggleLocation(id: number) {
    setLocationIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleLevel(key: string) {
    setFidelityLevels((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]));
  }
  function addExcluded() {
    const id = Number.parseInt(excludeCandidate, 10) || 0;
    if (id > 0 && !excludedClients.includes(id)) setExcludedClients((prev) => [...prev, id]);
    setExcludeCandidate("");
  }
  function removeExcluded(id: number) {
    setExcludedClients((prev) => prev.filter((x) => x !== id));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (form.title.trim() === "") {
      setError("Inserisci il nome della promozione.");
      return;
    }
    if (form.starts_at !== "" && form.ends_at !== "" && form.starts_at > form.ends_at) {
      setError("La data di fine deve essere uguale o successiva alla data di inizio.");
      return;
    }
    if (form.apply_services_mode === "none" && form.apply_products_mode === "none") {
      setError("Seleziona almeno servizi o prodotti da includere nella promozione.");
      return;
    }
    if (form.apply_services_mode === "all") {
      const v = Number.parseFloat(form.discount_value.replace(",", "."));
      if (!Number.isFinite(v) || v <= 0) {
        setError("Inserisci uno sconto maggiore di 0 per tutti i servizi.");
        return;
      }
      if (form.discount_type === "percent" && v > 100) {
        setError("Lo sconto percentuale servizi non puo superare 100%.");
        return;
      }
    }
    if (form.promo_conditions_enabled && form.promo_conditions.trim() === "") {
      setError("Inserisci il testo delle condizioni promozionali oppure disattiva il flag.");
      return;
    }
    if (form.apply_services_mode === "selected" && services.length === 0) {
      setError('Se hai scelto "Solo servizi selezionati", seleziona almeno un servizio.');
      return;
    }
    if (form.apply_products_mode === "selected" && products.length === 0) {
      setError('Se hai scelto "Solo prodotti selezionati", seleziona almeno un prodotto.');
      return;
    }

    // Cumulabile legacy: master senza metodo scelto => Sconto punti Fidelity.
    const effFidelity = stackableMaster ? (stackableFidelity || stackableCoupon ? stackableFidelity : true) : false;
    const effCoupon = stackableMaster ? stackableCoupon : false;

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "save",
        id: String(form.id),
        replace_source_id: replaceSourceId > 0 ? String(replaceSourceId) : "0",
        title: form.title,
        description: form.description,
        promo_conditions_enabled: form.promo_conditions_enabled ? "1" : "0",
        promo_conditions: form.promo_conditions,
        is_active: form.is_active ? "1" : "0",
        apply_services_mode: form.apply_services_mode,
        apply_products_mode: form.apply_products_mode,
        discount_type: form.discount_type,
        discount_value: form.discount_value,
        min_qty: form.min_qty,
        products_discount_type: form.products_discount_type,
        products_discount_value: form.products_discount_value,
        products_min_qty: form.products_min_qty,
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        target_type: form.target_type,
        new_within_days: form.new_within_days,
        inactive_days: form.inactive_days,
        birthday_window_days: form.birthday_window_days,
        per_customer_limit: form.per_customer_limit,
        service_ids_json: JSON.stringify(services),
        product_ids_json: JSON.stringify(products),
        location_ids_json: JSON.stringify(locationIds),
        time_windows_json: JSON.stringify(timeWindows),
        blackout_dates_json: JSON.stringify(blackoutDates),
        target_fidelity_levels_json: JSON.stringify(fidelityLevels),
        excluded_client_ids_json: JSON.stringify(excludedClients),
        stackable_fidelity: effFidelity ? "1" : "0",
        stackable_coupon: effCoupon ? "1" : "0",
        // Nessun controllo UI nel legacy: il backend salva sempre 'auto'
        // (conserviamo l'eventuale valore caricato in modifica).
        marketplace_visibility: marketplaceVisibility,
      };
      const res = await fetch(`/api/manage/promotions?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio della promozione."));
        setSaving(false);
        return;
      }
      // Redirect flash legacy: lista con msg + open_summary della promo salvata.
      const savedId = Number(j?.promotion?.id ?? 0);
      const msg = String(j?.message ?? "Promozione salvata");
      window.location.href = `/${encodeURIComponent(slug)}/promotions?msg=${encodeURIComponent(msg)}${savedId > 0 ? `&open_summary=${savedId}` : ""}`;
    } catch {
      setError("Errore nel salvataggio della promozione.");
      setSaving(false);
    }
  }

  const title = action === "edit" ? "Modifica promozione" : action === "duplicate" ? "Clona campagna" : "Nuova promozione";
  const filteredServices = useMemo(() => ctx.services.filter((s) => s.name.toLowerCase().includes(svcFilter.toLowerCase())), [ctx.services, svcFilter]);
  const filteredProducts = useMemo(() => ctx.products.filter((p) => `${p.name} ${p.sku ?? ""}`.toLowerCase().includes(prdFilter.toLowerCase())), [ctx.products, prdFilter]);
  const excludeCandidates = useMemo(() => ctx.clients.filter((c) => !excludedClients.includes(c.id)), [ctx.clients, excludedClients]);
  const excludedRows = useMemo(() => ctx.clients.filter((c) => excludedClients.includes(c.id)), [ctx.clients, excludedClients]);
  const showDiscountSection = form.apply_services_mode === "all" || form.apply_products_mode === "all";
  const discountHelp = [
    form.apply_services_mode === "all" ? '"Tutti i servizi"' : "",
    form.apply_products_mode === "all" ? '"Tutti i prodotti"' : "",
  ].filter(Boolean).join(" e ");

  // Riga voce picker (servizio/prodotto) con controlli sconto inline.
  const pickerRow = (kind: "svc" | "prd", item: CatItem, row: ItemRow | undefined) => (
    <div className={`d-flex align-items-center justify-content-between ${kind}-item py-1`} key={item.id}>
      <div className="form-check">
        <input
          className={`form-check-input ${kind}-check`}
          type="checkbox"
          id={`${kind}_${item.id}`}
          checked={!!row}
          onChange={() => toggleItem(kind, item.id)}
        />
        <label className="form-check-label" htmlFor={`${kind}_${item.id}`}>
          {item.name} <span className="text-muted small">{item.price !== undefined ? `(€ ${Number(item.price).toFixed(2)})` : item.sku ? `(${item.sku})` : ""}</span>
        </label>
      </div>
      {row ? (
        <div className="d-flex align-items-center gap-2 flex-wrap item-discount-controls">
          <select className="form-select form-select-sm item-discount-type" value={row.discountType} onChange={(e) => updateItem(kind, item.id, { discountType: e.target.value as DiscountType })}>
            <option value="percent">Percentuale (%)</option>
            <option value="fixed">Importo fisso (€)</option>
          </select>
          <input className="form-control form-control-sm text-end item-discount-value" type="number" step="0.01" min="0" max="100000" placeholder="Valore" value={row.discountValue} onChange={(e) => updateItem(kind, item.id, { discountValue: e.target.value })} />
          <input className="form-control form-control-sm text-end item-min-qty" type="number" min="1" placeholder="Quantità minima" value={row.minQty} onChange={(e) => updateItem(kind, item.id, { minQty: e.target.value })} />
        </div>
      ) : null}
    </div>
  );

  // Pannello "Sconto rapido" del picker (legacy promo-quick-panel).
  const quickPanel = (kind: "svc" | "prd") => {
    const [quick, setQuick, label] = kind === "svc" ? [quickSvc, setQuickSvc, "servizi"] as const : [quickPrd, setQuickPrd, "prodotti"] as const;
    return (
      <div className="border rounded p-2 mb-2 promo-quick-panel">
        <div className="d-flex gap-2 align-items-end flex-wrap">
          <div className="promo-quick-type">
            <label className="form-label small mb-1">Sconto rapido (selezionati) — Tipo</label>
            <select className="form-select form-select-sm" value={quick.type} onChange={(e) => setQuick({ ...quick, type: e.target.value as DiscountType })}>
              <option value="percent">Percentuale (%)</option>
              <option value="fixed">Importo fisso (€)</option>
            </select>
          </div>
          <div className="promo-quick-value">
            <label className="form-label small mb-1">Valore</label>
            <input className="form-control form-control-sm text-end" type="number" step="0.01" min="0" placeholder="Valore" value={quick.value} onChange={(e) => setQuick({ ...quick, value: e.target.value })} />
          </div>
          <div className="promo-quick-value">
            <label className="form-label small mb-1">Quantità minima</label>
            <input className="form-control form-control-sm text-end" type="number" min="1" value={quick.minQty} onChange={(e) => setQuick({ ...quick, minQty: e.target.value })} />
          </div>
          <div className="flex-grow-1" />
          <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => applyQuick(kind)}>
            <i className="bi bi-check2 me-1" />
            Applica
          </button>
        </div>
        <div className="text-muted promo-note-xs">Suggerimento: spunta i {label} e premi “Applica” per impostare gli stessi campi su tutti.</div>
      </div>
    );
  };

  // Label submit legacy: 'Aggiorna' in modifica, 'Salva clone' sul clone.
  const submitLabel = action === "edit" ? "Aggiorna" : action === "duplicate" ? "Salva clone" : "Salva";
  const saveButtons = (
    <div className="d-flex gap-2">
      <button className="btn btn-primary" type="submit" disabled={saving}>
        <i className="bi bi-check2-circle me-1" />
        {submitLabel}
      </button>
      <button className="btn btn-outline-secondary" type="button" onClick={backToList}>
        Annulla
      </button>
    </div>
  );

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/promotions.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity</div>
          <h1 className="bs-page-title">Promozioni</h1>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" className="card" id="promotionForm" onSubmit={onSubmit}>
          <input type="hidden" name="id" value={form.id} />
          <div className="card-body">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div>
                <div className="h5 m-0">{title}</div>
                <div className="text-muted small">Configura regole, target e validità. La promozione verrà applicata automaticamente anche nel booking.</div>
              </div>
              {saveButtons}
            </div>

            <div className="row g-3">
              <div className="col-lg-8">
                <div className="card mb-3">
                  <div className="card-header fw-semibold">Informazioni</div>
                  <div className="card-body">
                    <div className="row g-3">
                      <div className="col-md-8">
                        <label className="form-label">Nome promozione</label>
                        <input className="form-control" name="title" required value={form.title} onChange={(e) => set("title", e.target.value)} />
                      </div>
                      <div className="col-12">
                        <label className="form-label">Descrizione (opz.)</label>
                        <textarea className="form-control" name="description" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
                      </div>

                      <div className="col-12">
                        <div className="form-check form-switch">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            name="promo_conditions_enabled"
                            id="promo_conditions_enabled"
                            checked={form.promo_conditions_enabled}
                            onChange={(e) => set("promo_conditions_enabled", e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor="promo_conditions_enabled">Testo condizioni nel booking (opz.)</label>
                        </div>
                        {form.promo_conditions_enabled ? (
                          <div id="promo_conditions_box" className="mt-2">
                            <textarea
                              className="form-control"
                              name="promo_conditions"
                              rows={3}
                              placeholder="Inserisci le condizioni della promozione (opz.)"
                              value={form.promo_conditions}
                              onChange={(e) => set("promo_conditions", e.target.value)}
                            />
                            <div className="form-text">Questo testo viene mostrato nel booking sotto al totale; non aggiunge regole automatiche e la promo non viene mostrata nella scheda attività.</div>
                          </div>
                        ) : null}
                      </div>

                      <div className="col-md-4">
                        <div className="form-check form-switch mt-4">
                          <input className="form-check-input" type="checkbox" name="is_active" id="is_active" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
                          <label className="form-check-label" htmlFor="is_active">Attiva</label>
                        </div>
                      </div>
                      <div className="col-md-4">
                        <div className="form-check form-switch mt-4">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            name="stackable"
                            id="stackable"
                            checked={stackableMaster}
                            onChange={(e) => setStackableMaster(e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor="stackable">Cumulabile (opz.)</label>
                        </div>
                        {stackableMaster ? (
                          <div id="stackableMethods" className="small mt-2 ms-1">
                            <div className="text-muted mb-1">Cumulabile con:</div>
                            <div className="form-check">
                              <input className="form-check-input" type="checkbox" name="stackable_fidelity" id="stackable_fidelity" checked={stackableFidelity} onChange={(e) => setStackableFidelity(e.target.checked)} />
                              <label className="form-check-label" htmlFor="stackable_fidelity">Sconto punti Fidelity</label>
                            </div>
                            <div className="form-check">
                              <input className="form-check-input" type="checkbox" name="stackable_coupon" id="stackable_coupon" checked={stackableCoupon} onChange={(e) => setStackableCoupon(e.target.checked)} />
                              <label className="form-check-label" htmlFor="stackable_coupon">Coupon</label>
                            </div>
                            <div className="text-muted promo-note-xs">Se non selezioni alcun metodo, verra&apos; abilitato lo Sconto punti Fidelity.</div>
                          </div>
                        ) : null}
                      </div>

                      <div className="col-12">
                        <label className="form-label">Sedi abilitate</label>
                        <div className="table-responsive border rounded">
                          <table className="table table-sm align-middle mb-0">
                            <thead>
                              <tr>
                                <th>Sede</th>
                                <th className="text-center promo-location-valid-col">Valida</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ctx.locations.map((l) => (
                                <tr key={l.id}>
                                  <td className="fw-semibold">{l.name}</td>
                                  <td className="text-center">
                                    <input className="form-check-input" type="checkbox" checked={locationIds.includes(l.id)} onChange={() => toggleLocation(l.id)} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="card mb-3">
                  <div className="card-header fw-semibold">Servizi / Prodotti e sconto</div>
                  <div className="card-body">
                    <div className="text-muted small mb-3">
                      Seleziona cosa includere nella promozione. Se scegli <strong>solo servizi/prodotti selezionati</strong>, puoi impostare uno sconto per ogni elemento.
                    </div>

                    <div className="row g-3">
                      <div className="col-md-6">
                        <label className="form-label">Servizi inclusi</label>
                        <select className="form-select" name="apply_services_mode" id="apply_services_mode" value={form.apply_services_mode} onChange={(e) => set("apply_services_mode", e.target.value as ApplyMode)}>
                          <option value="none">Nessuno</option>
                          <option value="all">Tutti i servizi</option>
                          <option value="selected">Solo servizi selezionati</option>
                        </select>

                        {form.apply_services_mode === "selected" ? (
                          <div id="services_picker" className="mt-2">
                            <div className="form-text mb-2">Seleziona i servizi. Per ogni servizio selezionato imposta lo sconto (Tipo, Valore, Quantità minima).</div>
                            {quickPanel("svc")}
                            <input className="form-control form-control-sm mb-2" type="text" placeholder="Cerca servizio..." value={svcFilter} onChange={(e) => setSvcFilter(e.target.value)} />
                            <div className="border rounded p-2 promo-picker-list">
                              {filteredServices.map((s) => pickerRow("svc", s, services.find((r) => r.id === s.id)))}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="col-md-6">
                        <label className="form-label">Prodotti inclusi</label>
                        <select className="form-select" name="apply_products_mode" id="apply_products_mode" value={form.apply_products_mode} onChange={(e) => set("apply_products_mode", e.target.value as ApplyMode)}>
                          <option value="none">Nessuno</option>
                          <option value="all">Tutti i prodotti</option>
                          <option value="selected">Solo prodotti selezionati</option>
                        </select>

                        {form.apply_products_mode === "selected" ? (
                          <div id="products_picker" className="mt-2">
                            <div className="form-text mb-2">Seleziona i prodotti. Per ogni prodotto selezionato imposta lo sconto (Tipo, Valore, Quantità minima).</div>
                            {quickPanel("prd")}
                            <input className="form-control form-control-sm mb-2" type="text" placeholder="Cerca prodotto..." value={prdFilter} onChange={(e) => setPrdFilter(e.target.value)} />
                            <div className="border rounded p-2 promo-picker-list">
                              {filteredProducts.map((p) => pickerRow("prd", p, products.find((r) => r.id === p.id)))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {showDiscountSection ? (
                      <div id="discount_section">
                        <hr className="my-4" />
                        <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                          <div>
                            <div className="fw-semibold">Sconto</div>
                            <div id="discount_help" className="text-muted small">Imposta lo sconto per {discountHelp}.</div>
                          </div>
                        </div>

                        <div id="global_discounts_wrap" className="mt-3">
                          {form.apply_services_mode === "all" ? (
                            <div id="svc_global_discount_box" className="border rounded p-3 mb-3">
                              <div className="fw-semibold mb-2">Sconto • Tutti i servizi</div>
                              <div className="row g-3">
                                <div className="col-md-4">
                                  <label className="form-label">Tipo</label>
                                  <select className="form-select" name="discount_type" value={form.discount_type} onChange={(e) => set("discount_type", e.target.value as DiscountType)}>
                                    <option value="percent">Percentuale (%)</option>
                                    <option value="fixed">Importo fisso (€)</option>
                                  </select>
                                </div>
                                <div className="col-md-4">
                                  <label className="form-label">Valore</label>
                                  <input className="form-control" name="discount_value" type="number" step="0.01" min="0" value={form.discount_value} onChange={(e) => set("discount_value", e.target.value)} />
                                </div>
                                <div className="col-md-4">
                                  <label className="form-label">Quantità minima</label>
                                  <input className="form-control" name="min_qty" type="number" min="1" value={form.min_qty} onChange={(e) => set("min_qty", e.target.value)} />
                                </div>
                              </div>
                            </div>
                          ) : null}

                          {form.apply_products_mode === "all" ? (
                            <div id="prd_global_discount_box" className="border rounded p-3">
                              <div className="fw-semibold mb-2">Sconto • Tutti i prodotti</div>
                              <div className="row g-3">
                                <div className="col-md-4">
                                  <label className="form-label">Tipo</label>
                                  <select className="form-select" name="products_discount_type" value={form.products_discount_type} onChange={(e) => set("products_discount_type", e.target.value as DiscountType)}>
                                    <option value="percent">Percentuale (%)</option>
                                    <option value="fixed">Importo fisso (€)</option>
                                  </select>
                                </div>
                                <div className="col-md-4">
                                  <label className="form-label">Valore</label>
                                  <input className="form-control" name="products_discount_value" type="number" step="0.01" min="0" value={form.products_discount_value} onChange={(e) => set("products_discount_value", e.target.value)} />
                                </div>
                                <div className="col-md-4">
                                  <label className="form-label">Quantità minima</label>
                                  <input className="form-control" name="products_min_qty" type="number" min="1" value={form.products_min_qty} onChange={(e) => set("products_min_qty", e.target.value)} />
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="col-lg-4">
                <div className="card mb-3">
                  <div className="card-header fw-semibold">Validità</div>
                  <div className="card-body">
                    <div className="row g-3">
                      <div className="col-6">
                        <label className="form-label">Dal</label>
                        <input className="form-control" name="starts_at" type="date" value={form.starts_at} onChange={(e) => set("starts_at", e.target.value)} />
                      </div>
                      <div className="col-6">
                        <label className="form-label">Al</label>
                        <input className="form-control" name="ends_at" type="date" value={form.ends_at} onChange={(e) => set("ends_at", e.target.value)} />
                      </div>
                    </div>

                    <hr />
                    <div className="fw-semibold mb-2">Giorni / orari validi</div>
                    <div id="time_windows_wrap">
                      {timeWindows.map((w, i) => (
                        <div className="row g-2 align-items-end mb-2 tw-row" key={i}>
                          <div className="col-4">
                            <label className="form-label small">Giorno</label>
                            <select className="form-select form-select-sm" value={w.day} onChange={(e) => setTimeWindows(timeWindows.map((x, j) => (j === i ? { ...x, day: Number(e.target.value) } : x)))}>
                              {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
                            </select>
                          </div>
                          <div className="col-3">
                            <label className="form-label small">Da</label>
                            <input className="form-control form-control-sm" type="time" value={w.start} onChange={(e) => setTimeWindows(timeWindows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                          </div>
                          <div className="col-3">
                            <label className="form-label small">A</label>
                            <input className="form-control form-control-sm" type="time" value={w.end} onChange={(e) => setTimeWindows(timeWindows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                          </div>
                          <div className="col-2">
                            <button className="btn btn-outline-danger btn-sm w-100" type="button" onClick={() => setTimeWindows(timeWindows.filter((_, j) => j !== i))}>
                              <i className="bi bi-x-lg" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setTimeWindows([...timeWindows, { day: 1, start: "", end: "" }])}>
                      <i className="bi bi-plus-lg me-1" />
                      Aggiungi
                    </button>

                    <hr />
                    <div className="fw-semibold mb-2">Date escluse (blackout)</div>
                    <div id="blackout_wrap">
                      {blackoutDates.map((d, i) => (
                        <div className="row g-2 align-items-end mb-2 bo-row" key={i}>
                          <div className="col-10">
                            <input className="form-control form-control-sm" type="date" value={d} onChange={(e) => setBlackoutDates(blackoutDates.map((x, j) => (j === i ? e.target.value : x)))} />
                          </div>
                          <div className="col-2">
                            <button className="btn btn-outline-danger btn-sm w-100" type="button" onClick={() => setBlackoutDates(blackoutDates.filter((_, j) => j !== i))}>
                              <i className="bi bi-x-lg" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setBlackoutDates([...blackoutDates, ""])}>
                      <i className="bi bi-plus-lg me-1" />
                      Aggiungi
                    </button>
                  </div>
                </div>

                <div className="card mb-3">
                  <div className="card-header fw-semibold">Target clienti</div>
                  <div className="card-body">
                    <div className="mb-2">
                      <label className="form-label">Target</label>
                      <select className="form-select" name="target_type" id="target_type" value={form.target_type} onChange={(e) => set("target_type", e.target.value as TargetType)}>
                        <option value="all">Tutti i clienti</option>
                        <option value="new">Nuovi clienti</option>
                        <option value="inactive">Clienti inattivi da X giorni</option>
                        <option value="birthday">Clienti con compleanno</option>
                        <option value="fidelity">Solo clienti con Fidelity</option>
                      </select>
                    </div>

                    {form.target_type === "new" ? (
                      <div id="target_new" className="border rounded p-2 mb-2">
                        <div className="fw-semibold small mb-1">Nuovi clienti</div>
                        <label className="form-label small">Entro quanti giorni dalla registrazione (opz.)</label>
                        <input className="form-control form-control-sm" type="number" min="0" name="new_within_days" placeholder="Es. 30" value={form.new_within_days} onChange={(e) => set("new_within_days", e.target.value)} />
                        <div className="form-text">Se vuoto: consideriamo &ldquo;nuovo&rdquo; chi non ha appuntamenti precedenti.</div>
                      </div>
                    ) : null}

                    {form.target_type === "inactive" ? (
                      <div id="target_inactive" className="border rounded p-2 mb-2">
                        <div className="fw-semibold small mb-1">Inattivi</div>
                        <label className="form-label small">Inattivo da almeno X giorni</label>
                        <input className="form-control form-control-sm" type="number" min="1" name="inactive_days" placeholder="Es. 60" value={form.inactive_days} onChange={(e) => set("inactive_days", e.target.value)} />
                      </div>
                    ) : null}

                    {form.target_type === "birthday" ? (
                      <div id="target_birthday" className="border rounded p-2 mb-2">
                        <div className="fw-semibold small mb-1">Compleanno</div>
                        <label className="form-label small">Finestra (± giorni) intorno al compleanno</label>
                        <input className="form-control form-control-sm" type="number" min="0" name="birthday_window_days" placeholder="Es. 7" value={form.birthday_window_days} onChange={(e) => set("birthday_window_days", e.target.value)} />
                        <div className="form-text">Se vuoto: valida solo il giorno del compleanno.</div>
                      </div>
                    ) : null}

                    {form.target_type === "fidelity" ? (
                      <div id="target_fidelity" className="border rounded p-2">
                        <div className="fw-semibold small mb-2">Fidelity</div>
                        <div className="form-text mb-2">Valida solo per clienti aderenti alla Fidelity. Se non selezioni livelli, vale per tutti gli aderenti.</div>
                        {ctx.fidelityLevels.length > 0 ? (
                          <div className="border rounded p-2 promo-fidelity-levels">
                            {ctx.fidelityLevels.map((l) => (
                              <div className="form-check" key={l.key}>
                                <input className="form-check-input promo-fidelity-level" type="checkbox" id={`lvl_${l.key}`} checked={fidelityLevels.includes(l.key)} onChange={() => toggleLevel(l.key)} />
                                <label className="form-check-label" htmlFor={`lvl_${l.key}`}>Punti: {l.name}</label>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <hr />
                    <div className="fw-semibold mb-2">Clienti esclusi</div>
                    <div className="text-muted small mb-2">Puoi escludere clienti dalla promozione già in fase di creazione. Con target <strong>Solo clienti con Fidelity</strong>, la lista rispetta i livelli selezionati.</div>
                    <div className="row g-2 align-items-end">
                      <div className="col-12 col-lg-8">
                        <label className="form-label small">Aggiungi cliente all&apos;esclusione</label>
                        <select className="form-select form-select-sm" id="promoExcludeCandidateSelect" value={excludeCandidate} onChange={(e) => setExcludeCandidate(e.target.value)}>
                          <option value="">— seleziona cliente —</option>
                          {excludeCandidates.map((c) => (
                            <option value={c.id} key={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-12 col-lg-4">
                        <button className="btn btn-outline-primary btn-sm w-100" type="button" id="promoExcludeAddBtn" onClick={addExcluded}>Aggiungi all&apos;esclusione</button>
                      </div>
                      <div className="col-12">
                        <div className="form-text">La lista viene aggiornata in base al target della promozione.</div>
                      </div>
                    </div>
                    <div className="mt-3">
                      <div className="small text-muted fw-semibold mb-2">Clienti esclusi selezionati</div>
                      <div id="promoExcludedClientsList" className="d-flex flex-column gap-2">
                        {excludedRows.length === 0 ? (
                          <div className="text-muted small">Nessun cliente escluso selezionato.</div>
                        ) : (
                          excludedRows.map((c) => (
                            <div className="d-flex justify-content-between align-items-center border rounded px-2 py-1" key={c.id}>
                              <span className="small">{c.name}</span>
                              <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => removeExcluded(c.id)}>
                                <i className="bi bi-x-lg" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-header fw-semibold">Limiti utilizzo</div>
                  <div className="card-body">
                    <div className="row g-2">
                      <div className="col-12">
                        <label className="form-label small">Utilizzi massimi per cliente (opz.)</label>
                        <input className="form-control form-control-sm" type="number" min="0" name="per_customer_limit" placeholder="Es. 1" value={form.per_customer_limit} onChange={(e) => set("per_customer_limit", e.target.value)} />
                      </div>
                    </div>
                    <div className="form-text mt-2">Lascia vuoto per nessun limite. Il conteggio considera vendite gia&apos; registrate e prenotazioni con promozione in stato <strong>In sospeso</strong> / <strong>Prenotato</strong>; le prenotazioni annullate liberano il limite.</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="d-flex gap-2 mt-3">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                {submitLabel}
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={backToList}>
                Annulla
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
