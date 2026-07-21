"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

// Port fedele del FORM preventivo (app/pages/quotes.php action=new|edit +
// assets/js/pages/quotes.js mode=form): colonna "Dati preventivo" (data,
// numero automatico N/YYYY, validità, sede, stato con opzione "(automatico)",
// cliente con combobox + snapshot anagrafico/fiscale + italy-geo, note,
// metodi di pagamento configurati, condizioni) + colonna "Righe preventivo"
// (tipo Servizio/Prodotto/Pacchetto/Voce libera, prezzo catalogo BLOCCATO,
// IVA/sconto per riga, tabella righe, totali) e salvataggio con messaggi
// verbatim.

type QuoteFormQuery = { action?: string; id?: string; location_id?: string; msg?: string; err?: string };

type FormClient = {
  id: number;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  cap: string | null;
  city: string | null;
  province: string | null;
  region: string | null;
  company_name: string | null;
  vat_number: string | null;
  tax_code: string | null;
  sdi: string | null;
  pec: string | null;
};

type CatalogRow = {
  id: number;
  name?: string;
  sku?: string | null;
  price?: string | number | null;
  sessions_total?: number | null;
  is_active?: number | boolean | null;
  location_ids: number[];
  location_restricted: boolean;
};

type FormItem = {
  quote_item_id?: number;
  item_type: string;
  item_id: number | null;
  description: string;
  sku: string | null;
  qty: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
};

type FormPayload = {
  redirect?: { to: "list" | "view"; id?: number; err: string };
  form?: {
    id: number;
    number: string;
    quoteDate: string;
    validUntil: string;
    locationId: number;
    clientId: number;
    clientFirstName: string;
    clientLastName: string;
    clientEmail: string;
    clientPhone: string;
    clientAddress: string;
    clientCap: string;
    clientCity: string;
    clientProvince: string;
    clientRegion: string;
    clientCompanyName: string;
    clientVatNumber: string;
    clientTaxCode: string;
    clientSdi: string;
    clientPec: string;
    statusSelectValue: string;
    statusAutoOptionLabel: string;
    notes: string;
    publicNote: string;
    terms: string;
    availablePaymentMethods: string[];
    selectedPaymentMethods: string[];
    itemsInitial: FormItem[];
  };
  config?: {
    clients: FormClient[];
    products: CatalogRow[];
    services: CatalogRow[];
    packages: CatalogRow[];
    locations: Array<{ id: number; name: string }>;
    initialLocationId: string;
  };
};

// $editableStatus (ordine legacy).
const EDITABLE_STATUS: Array<{ value: string; label: string }> = [
  { value: "draft", label: "Bozza" },
  { value: "accepted", label: "Accettato" },
  { value: "rejected", label: "Rifiutato" },
  { value: "canceled", label: "Annullato" },
];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// money() di quotes.js: toLocaleString it-IT (fedele al form legacy).
function moneyJs(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// norm() di quotes.js: lowercase + rimozione accenti.
function normSearch(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// computeLine() di quotes.js.
function computeLine(it: FormItem): { line_subtotal: number; line_tax: number; line_total: number; discount_amount: number } {
  const qty = Number(it.qty || 1);
  const unit = Number(it.unit_price || 0);
  const disc = Math.min(100, Math.max(0, Number(it.discount_percent || 0)));
  const tax = Math.min(100, Math.max(0, Number(it.tax_rate || 0)));
  const gross = qty * unit;
  const sub = gross * (1 - disc / 100);
  const taxAmt = sub * (tax / 100);
  const tot = sub + taxAmt;
  return {
    line_subtotal: Math.round(sub * 100) / 100,
    line_tax: Math.round(taxAmt * 100) / 100,
    line_total: Math.round(tot * 100) / 100,
    discount_amount: Math.round((gross - sub) * 100) / 100,
  };
}

// plain: etichetta completa (toggle); name+muted: resa lista con parte muted
// (prodotti "(SKU)", pacchetti "— meta") come l'html di quotes.js.
type ComboItem = { id: string; plain: string; name?: string; muted?: string; search: string };

// initCombobox() di quotes.js: bottone toggle + ricerca + lista dropdown-item.
function FormCombobox({
  boxId,
  items,
  value,
  placeholder,
  searchPlaceholder,
  onSelect,
}: {
  boxId: string;
  items: ComboItem[];
  value: string;
  placeholder: string;
  searchPlaceholder: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const q = normSearch(search);
  const shown = items.filter((it) => !q || it.search.includes(q));
  const selected = items.find((it) => it.id === value);
  const hasSelection = value !== "" && value !== "0" && selected;
  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} id={boxId} ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`app-combobox-text ${hasSelection ? "" : "d-none"}`}>{hasSelection ? selected?.plain : ""}</span>
        <span className={`text-muted app-combobox-placeholder ${hasSelection ? "d-none" : ""}`}>{placeholder}</span>
      </button>
      <div className={`dropdown-menu p-2 ${open ? "show" : ""}`} style={{ width: "100%" }}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder={searchPlaceholder}
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="app-combobox-list mt-2" style={{ maxHeight: "14rem", overflowY: "auto" }}>
          {shown.length === 0 ? (
            <div className="text-muted small px-2 py-1">Nessun risultato</div>
          ) : (
            shown.map((it) => (
              <button
                key={it.id}
                type="button"
                className="dropdown-item d-flex justify-content-between align-items-center"
                onClick={() => {
                  onSelect(it.id);
                  setSearch("");
                  setOpen(false);
                }}
              >
                <span>
                  {it.muted ? it.name : it.plain}
                  {it.muted ? <span className="text-muted"> {it.muted}</span> : null}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Combobox italy-geo (markup legacy js-it-*: gestite da assets/js/italy-geo.js
// iniettato dopo il mount; gli hidden restano non controllati).
function GeoBox({
  label,
  boxClass,
  inputClass,
  name,
  inputId,
  placeholder,
  defaultValue,
  startDisabled,
}: {
  label: string;
  boxClass: string;
  inputClass: string;
  name: string;
  inputId: string;
  placeholder: string;
  defaultValue: string;
  startDisabled: boolean;
}) {
  return (
    <div className="col-md-6">
      <label className="form-label">{label}</label>
      <div className={`dropdown app-combobox ${boxClass}`}>
        <button
          className="form-control text-start app-combobox-toggle dropdown-toggle"
          type="button"
          aria-expanded="false"
          disabled={startDisabled}
        >
          <span className="app-combobox-text" />
          <span className="app-combobox-placeholder text-muted">{placeholder}</span>
        </button>
        <input type="hidden" name={name} id={inputId} className={inputClass} defaultValue={defaultValue} />
        <div className="dropdown-menu p-2 w-100 app-combobox-menu">
          <input type="text" className="form-control form-control-sm app-combobox-search" placeholder="Cerca…" autoComplete="off" />
          <div className="list-group mt-2 app-combobox-list" />
        </div>
      </div>
    </div>
  );
}

export function QuoteFormContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: QuoteFormQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [isEdit, setIsEdit] = useState(false);
  const [quoteId, setQuoteId] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));
  useTakenFlash(setFlash);

  const [config, setConfig] = useState<NonNullable<FormPayload["config"]> | null>(null);

  // Dati preventivo.
  const [quoteDate, setQuoteDate] = useState("");
  const [number, setNumber] = useState("");
  const manualNumberRef = useRef(false);
  const autoNumberSeqRef = useRef(0); // anti-stale sul numero automatico (audit giro 3)
  const [validUntil, setValidUntil] = useState("");
  const [locationId, setLocationId] = useState("");
  const [initialLocation, setInitialLocation] = useState("");
  const [status, setStatus] = useState("draft");
  const [statusAutoOptionLabel, setStatusAutoOptionLabel] = useState("");

  // Cliente (snapshot).
  const [clientId, setClientId] = useState("0");
  const [clientName, setClientName] = useState("");
  const [clientLastName, setClientLastName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [clientCap, setClientCap] = useState("");
  const [geoDefaults, setGeoDefaults] = useState({ region: "", province: "", city: "" });
  const [clientTaxCode, setClientTaxCode] = useState("");
  const [clientVatNumber, setClientVatNumber] = useState("");
  const [clientSdi, setClientSdi] = useState("");
  const [clientCompanyName, setClientCompanyName] = useState("");
  const [clientPec, setClientPec] = useState("");

  // Note / metodi pagamento / condizioni.
  const [notes, setNotes] = useState("");
  const [publicNote, setPublicNote] = useState("");
  const [availablePms, setAvailablePms] = useState<string[]>([]);
  const [selectedPms, setSelectedPms] = useState<string[]>([]);
  const [terms, setTerms] = useState("");

  // Righe.
  const [items, setItems] = useState<FormItem[]>([]);
  const [itemType, setItemType] = useState("service");
  const [serviceId, setServiceId] = useState("0");
  const [productId, setProductId] = useState("0");
  const [packageId, setPackageId] = useState("0");
  const [customDesc, setCustomDesc] = useState("");
  const [itemQty, setItemQty] = useState("1");
  const [itemPrice, setItemPrice] = useState("0");
  const [itemTax, setItemTax] = useState("0");
  const [itemDisc, setItemDisc] = useState("0");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = (initialQuery?.action ?? params.get("action")) === "edit" ? "edit" : "new";
    const editId = Number.parseInt(String(initialQuery?.id ?? params.get("id") ?? ""), 10) || 0;
    const locParam = String(initialQuery?.location_id ?? params.get("location_id") ?? "");
    void Promise.resolve().then(() => setIsEdit(act === "edit"));

    const q = new URLSearchParams({ slug, action: "form", mode: act });
    if (editId > 0) q.set("id", String(editId));
    if (locParam !== "") q.set("location_id", locParam);
    fetch(`/api/manage/quotes?${q.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: FormPayload) => {
        if (j.redirect) {
          const target = j.redirect.to === "view" && j.redirect.id
            ? `/${encodeURIComponent(slug)}/quotes?action=view&id=${j.redirect.id}`
            : `/${encodeURIComponent(slug)}/quotes`;
          flashNavigate(target, { err: j.redirect.err });
          return;
        }
        const f = j.form;
        if (!f || !j.config) {
          setError("Errore nel caricamento del preventivo.");
          setLoading(false);
          return;
        }
        setConfig(j.config);
        setQuoteId(f.id);
        setQuoteDate(f.quoteDate);
        setNumber(f.number);
        setValidUntil(f.validUntil);
        setLocationId(String(f.locationId || j.config.initialLocationId || ""));
        setInitialLocation(String(f.locationId || j.config.initialLocationId || ""));
        setStatus(f.statusSelectValue);
        setStatusAutoOptionLabel(f.statusAutoOptionLabel);
        setClientId(String(f.clientId || 0));
        setClientName(f.clientFirstName);
        setClientLastName(f.clientLastName);
        setClientEmail(f.clientEmail);
        setClientPhone(f.clientPhone);
        setClientAddress(f.clientAddress);
        setClientCap(f.clientCap);
        setGeoDefaults({ region: f.clientRegion, province: f.clientProvince, city: f.clientCity });
        setClientTaxCode(f.clientTaxCode);
        setClientVatNumber(f.clientVatNumber);
        setClientSdi(f.clientSdi);
        setClientCompanyName(f.clientCompanyName);
        setClientPec(f.clientPec);
        setNotes(f.notes);
        setPublicNote(f.publicNote);
        setAvailablePms(f.availablePaymentMethods);
        setSelectedPms(f.selectedPaymentMethods);
        setTerms(f.terms);
        setItems(f.itemsInitial);
        setLoading(false);
      })
      .catch(() => {
        setError("Errore nel caricamento del preventivo.");
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // italy-geo.js (IIFE legacy) DOPO il render del markup con gli hidden
  // prefillati; ?v= cache-buster per ri-eseguirlo a ogni mount.
  useEffect(() => {
    if (loading) return;
    const s = document.createElement("script");
    s.id = "italyGeoScript";
    s.dataset.base = window.location.origin;
    s.src = `/assets/js/italy-geo.js?v=${Date.now()}`;
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, [loading]);

  // Numero automatico SOLO in creazione: aggiorna al cambio data finché
  // l'utente non lo modifica a mano (quotes.js initAutoNumberForNew).
  async function refreshAutoNumber(dateValue: string) {
    if (isEdit || manualNumberRef.current) return;
    const d = String(dateValue || "").trim();
    if (!d) return;
    const seq = ++autoNumberSeqRef.current;
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=next_number&quote_date=${encodeURIComponent(d)}`, {
        headers: { "x-tenant-slug": slug },
      });
      if (!res.ok) return;
      const j = await res.json();
      // Ricontrollo DOPO l'await: l'utente può aver digitato un numero manuale
      // (o cambiato di nuovo data) mentre la richiesta era in volo.
      if (seq !== autoNumberSeqRef.current || manualNumberRef.current) return;
      if (j?.ok && j?.number) setNumber(String(j.number));
    } catch { /* best-effort */ }
  }

  const clients = useMemo(() => config?.clients ?? [], [config]);
  const services = useMemo(() => config?.services ?? [], [config]);
  const products = useMemo(() => config?.products ?? [], [config]);
  const packages = useMemo(() => config?.packages ?? [], [config]);
  const locations = config?.locations ?? [];

  const currentLocationId = String(locationId || config?.initialLocationId || "");

  function rowAllowedForLocation(row: CatalogRow): boolean {
    if (!row.location_restricted) return true;
    const ids = Array.isArray(row.location_ids) ? row.location_ids.map((x) => String(x)) : [];
    return ids.includes(currentLocationId);
  }

  // Item combobox (quotes.js): clienti / servizi / prodotti (nome + SKU) /
  // pacchetti (nome — sedute • prezzo • disattivo).
  const clientItems: ComboItem[] = useMemo(
    () =>
      clients.map((c) => {
        const label = String(c.full_name || `#${c.id}`);
        return { id: String(c.id), plain: label, search: normSearch(label) };
      }),
    [clients],
  );
  const serviceItems: ComboItem[] = useMemo(
    () =>
      services.filter(rowAllowedForLocation).map((s) => {
        const label = String(s.name || `#${s.id}`);
        return { id: String(s.id), plain: label, search: normSearch(label) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, currentLocationId],
  );
  const productItems: ComboItem[] = useMemo(
    () =>
      products.filter(rowAllowedForLocation).map((p) => {
        const name = String(p.name || `#${p.id}`);
        const sku = String(p.sku ?? "");
        return {
          id: String(p.id),
          plain: sku ? `${name} (${sku})` : name,
          name,
          muted: sku ? `(${sku})` : undefined,
          search: normSearch(`${name} ${sku}`),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products, currentLocationId],
  );
  const packageItems: ComboItem[] = useMemo(
    () =>
      packages.filter(rowAllowedForLocation).map((p) => {
        const name = String(p.name || `#${p.id}`);
        const sessions = Number(p.sessions_total || 1);
        const price = Number(p.price || 0);
        const ia = p.is_active === undefined || p.is_active === null ? "1" : p.is_active;
        const isActive = String(ia) === "1" || ia === 1 || ia === true;
        const metaParts: string[] = [];
        if (sessions) metaParts.push(`${Math.round(sessions)} sedute`);
        metaParts.push(`€ ${moneyJs(price)}`);
        if (!isActive) metaParts.push("disattivo");
        const metaPlain = metaParts.join(" • ");
        return {
          id: String(p.id),
          plain: metaPlain ? `${name} — ${metaPlain}` : name,
          name,
          muted: metaPlain ? `— ${metaPlain}` : undefined,
          search: normSearch(`${name} ${metaParts.join(" ")}`),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packages, currentLocationId],
  );

  // applyClient() di quotes.js: prefill snapshot + trigger cascata italy-geo.
  function applyClient(id: string) {
    const c = clients.find((x) => String(x.id) === String(id));
    if (!c) return;
    let first = String(c.first_name || "").trim();
    let last = String(c.last_name || "").trim();
    if (!first && !last) {
      const full = String(c.full_name || "").trim();
      if (full.includes(",")) {
        const parts = full.split(",");
        last = String(parts[0] || "").trim();
        first = parts.slice(1).join(",").trim();
      } else {
        const parts = full.split(/\s+/).filter(Boolean);
        if (parts.length > 1) {
          last = parts.pop() as string;
          first = parts.join(" ");
        } else {
          first = full;
        }
      }
    }
    setClientName(first || c.full_name || "");
    setClientLastName(last || "");
    setClientEmail(c.email || "");
    setClientPhone(c.phone || "");
    setClientAddress(c.address || "");
    setClientCap(c.cap || "");
    setClientCompanyName(c.company_name || "");
    setClientVatNumber(c.vat_number || "");
    setClientTaxCode(c.tax_code || "");
    setClientSdi(c.sdi || "");
    setClientPec(c.pec || "");
    // Regione/Provincia/Città sugli hidden non controllati + change sulla
    // regione per la cascata italy-geo (come il legacy).
    const regionEl = document.getElementById("clientRegion") as HTMLInputElement | null;
    const provinceEl = document.getElementById("clientProvince") as HTMLInputElement | null;
    const cityEl = document.getElementById("clientCity") as HTMLInputElement | null;
    if (provinceEl) provinceEl.value = c.province || "";
    if (cityEl) cityEl.value = c.city || "";
    if (regionEl) {
      regionEl.value = c.region || "";
      try {
        regionEl.dispatchEvent(new Event("change", { bubbles: true }));
      } catch { /* noop */ }
    }
  }

  // addItemBtn di quotes.js (alert verbatim + prezzo catalogo bloccato).
  function addItem() {
    const t = itemType;
    let desc = "";
    let itemId: number | null = null;
    let sku: string | null = null;
    let lockedUnit: number | null = null;

    if (t === "service") {
      if (serviceId === "0") { window.alert("Seleziona un servizio."); return; }
      const s = services.find((x) => String(x.id) === serviceId);
      if (!s) { window.alert("Servizio non trovato."); return; }
      desc = String(s.name || "Servizio");
      itemId = Number(s.id);
      lockedUnit = Number(s.price || 0);
    } else if (t === "product") {
      if (productId === "0") { window.alert("Seleziona un prodotto."); return; }
      const p = products.find((x) => String(x.id) === productId);
      if (!p) { window.alert("Prodotto non trovato."); return; }
      sku = p.sku ? String(p.sku) : null;
      desc = sku ? `${String(p.name || "Prodotto")} (${sku})` : String(p.name || "Prodotto");
      itemId = Number(p.id);
      lockedUnit = Number(p.price || 0);
    } else if (t === "package") {
      if (packageId === "0") { window.alert("Seleziona un pacchetto."); return; }
      const p = packages.find((x) => String(x.id) === packageId);
      if (!p) { window.alert("Pacchetto non trovato."); return; }
      const name = String(p.name || "Pacchetto");
      const sessions = Number(p.sessions_total || 0);
      desc = sessions ? `${name} (${Math.round(sessions)} sedute)` : name;
      itemId = Number(p.id);
      lockedUnit = Number(p.price || 0);
    } else {
      desc = customDesc.trim();
      if (!desc) { window.alert("Inserisci una descrizione."); return; }
    }

    const qty = Number(itemQty || 1);
    const unit = lockedUnit !== null ? Number(lockedUnit || 0) : Number(itemPrice || 0);
    const taxRate = Number(itemTax || 0);
    const discP = Number(itemDisc || 0);

    setItems((prev) => [
      ...prev,
      { item_type: t, item_id: itemId, description: desc, sku, qty, unit_price: unit, tax_rate: taxRate, discount_percent: discP },
    ]);

    if (t === "custom") setCustomDesc("");
    setItemPrice("0");
    setItemQty("1");
    setItemTax(itemTax || "0");
    setItemDisc("0");
    setServiceId("0");
    setProductId("0");
    setPackageId("0");
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const totals = useMemo(() => {
    let sub = 0;
    let disc = 0;
    let tax = 0;
    let total = 0;
    for (const it of items) {
      const calc = computeLine(it);
      sub += calc.line_subtotal;
      disc += calc.discount_amount;
      tax += calc.line_tax;
      total += calc.line_total;
    }
    return { sub, disc, tax, total };
  }, [items]);

  const lockedPrice = itemType === "service" || itemType === "product" || itemType === "package";

  function listUrl(): string {
    return `/${encodeURIComponent(slug)}/quotes`;
  }

  // Cambio sede (select multi-sede): conferma + ricarica come il legacy.
  function onLocationChange(next: string) {
    const initial = initialLocation;
    if (next === initial) {
      setLocationId(next);
      return;
    }
    const message = items.length
      ? "Cambiando sede la pagina verra ricaricata. Eventuali modifiche non salvate andranno perse. Continuare?"
      : "Cambiando sede la pagina verra ricaricata per aggiornare prodotti, servizi e pacchetti. Continuare?";
    if (!window.confirm(message)) return;
    const base = isEdit ? `action=edit&id=${encodeURIComponent(String(quoteId || 0))}` : "action=new";
    window.location.href = `${listUrl()}?${base}&location_id=${encodeURIComponent(next)}`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      const region = (document.getElementById("clientRegion") as HTMLInputElement | null)?.value ?? "";
      const province = (document.getElementById("clientProvince") as HTMLInputElement | null)?.value ?? "";
      const city = (document.getElementById("clientCity") as HTMLInputElement | null)?.value ?? "";
      const payload: Record<string, unknown> = {
        action: "save",
        mode: isEdit ? "edit" : "new",
        id: String(quoteId || 0),
        quote_date: quoteDate,
        number,
        valid_until: validUntil,
        location_id: locationId,
        status,
        client_id: clientId,
        client_name: clientName,
        client_last_name: clientLastName,
        client_email: clientEmail,
        client_phone: clientPhone,
        client_address: clientAddress,
        client_region: region,
        client_province: province,
        client_city: city,
        client_cap: clientCap,
        client_tax_code: clientTaxCode,
        client_vat_number: clientVatNumber,
        client_sdi: clientSdi,
        client_company_name: clientCompanyName,
        client_pec: clientPec,
        notes,
        public_note: publicNote,
        payment_methods: JSON.stringify(selectedPms),
        terms,
        items_json: JSON.stringify(items),
      };
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setError(String(j?.error ?? "Errore salvataggio."));
        setSaving(false);
        window.scrollTo(0, 0);
        return;
      }
      flashNavigate(`${listUrl()}?action=view&id=${j.id}`, { msg: "Preventivo salvato" });
    } catch {
      setError("Errore salvataggio.");
      setSaving(false);
      window.scrollTo(0, 0);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Preventivi</div>
          <h1 className="bs-page-title">{isEdit ? "Modifica preventivo" : "Nuovo preventivo"}</h1>
          <div className="bs-page-subtitle">Aggiungi righe con servizi, prodotti o voci libere.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary" href={listUrl()}>
              <i className="bi bi-arrow-left" /> Lista
            </a>
            {isEdit ? (
              <a className="btn btn-outline-secondary" href={`${listUrl()}?action=view&id=${quoteId}`}>
                Apri
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{flash.err}</div>
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-danger d-flex align-items-start gap-2" role="alert">
          <div><i className="bi bi-info-circle" /></div>
          <div>{error}</div>
        </div>
      ) : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" id="quoteForm" onSubmit={onSubmit}>
          <input type="hidden" name="id" value={String(quoteId || 0)} readOnly />
          <input type="hidden" name="items_json" id="itemsJson" value={JSON.stringify(items)} readOnly />

          <div className="row g-3">
            <div className="col-lg-4">
              <div className="card p-4">
                <div className="fw-semibold mb-3">Dati preventivo</div>

                <div className="mb-3">
                  <label className="form-label">Data</label>
                  <input
                    type="date"
                    className="form-control"
                    id="quoteDate"
                    name="quote_date"
                    value={quoteDate}
                    required
                    onChange={(e) => {
                      setQuoteDate(e.target.value);
                      void refreshAutoNumber(e.target.value);
                    }}
                  />
                </div>

                <div className="mb-3">
                  <label className="form-label">Numero preventivo</label>
                  <input
                    className="form-control"
                    id="quoteNumber"
                    name="number"
                    value={number}
                    required
                    onChange={(e) => {
                      manualNumberRef.current = true;
                      setNumber(e.target.value);
                    }}
                  />
                  <div className="form-text">Modificabile. Non possono esistere duplicati.</div>
                </div>

                <div className="mb-3">
                  <label className="form-label">Valido fino al</label>
                  <input type="date" className="form-control" name="valid_until" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                </div>

                {locations.length > 1 ? (
                  <div className="mb-3">
                    <label className="form-label">Sede</label>
                    <select
                      className="form-select"
                      name="location_id"
                      id="quoteLocationId"
                      data-initial-location={initialLocation}
                      value={locationId}
                      onChange={(e) => onLocationChange(e.target.value)}
                    >
                      {locations.map((loc) => (
                        <option key={loc.id} value={String(loc.id)}>
                          {loc.name || `Sede #${loc.id}`}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input type="hidden" name="location_id" id="quoteLocationId" value={locationId} readOnly />
                )}

                <div className="mb-3">
                  <label className="form-label">Stato</label>
                  <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    {statusAutoOptionLabel !== "" ? <option value="__keep_auto__">{statusAutoOptionLabel}</option> : null}
                    {EDITABLE_STATUS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <div className="form-text">
                    Gli stati <strong>Inviato</strong> e <strong>Scaduto</strong> sono gestiti automaticamente dal sistema.
                  </div>
                </div>

                <hr className="my-3" />

                <div className="fw-semibold mb-2">Cliente</div>

                <div className="mb-2">
                  <label className="form-label">Seleziona cliente (opzionale)</label>
                  <FormCombobox
                    boxId="clientBox"
                    items={clientItems}
                    value={clientId}
                    placeholder="— Seleziona —"
                    searchPlaceholder="Cerca…"
                    onSelect={(id) => {
                      setClientId(id);
                      if (id !== "0") applyClient(id);
                    }}
                  />
                  <div className="form-text">
                    Puoi anche compilare i dati manualmente (snapshot nel preventivo). Se non selezioni un cliente ma inserisci
                    i dati, al salvataggio verrà creato e associato automaticamente.
                  </div>
                </div>

                <div className="mb-2">
                  <label className="form-label">Nome</label>
                  <input className="form-control" name="client_name" id="clientName" value={clientName} placeholder="Nome" onChange={(e) => setClientName(e.target.value)} />
                </div>
                <div className="mb-2">
                  <label className="form-label">Cognome</label>
                  <input className="form-control" name="client_last_name" id="clientLastName" value={clientLastName} placeholder="Cognome" onChange={(e) => setClientLastName(e.target.value)} />
                </div>
                <div className="mb-2">
                  <label className="form-label">Email</label>
                  <input className="form-control" name="client_email" id="clientEmail" value={clientEmail} placeholder="email@cliente.it" onChange={(e) => setClientEmail(e.target.value)} />
                </div>
                <div className="mb-2">
                  <label className="form-label">Telefono</label>
                  <input className="form-control" name="client_phone" id="clientPhone" value={clientPhone} placeholder="+39 ..." onChange={(e) => setClientPhone(e.target.value)} />
                </div>
                <div className="mb-2">
                  <label className="form-label">Indirizzo</label>
                  <input className="form-control" name="client_address" id="clientAddress" value={clientAddress} placeholder="Via ..." onChange={(e) => setClientAddress(e.target.value)} />
                </div>
                <div className="row g-2">
                  <GeoBox
                    label="Regione"
                    boxClass="js-it-region-box"
                    inputClass="js-it-region"
                    name="client_region"
                    inputId="clientRegion"
                    placeholder="Seleziona una regione…"
                    defaultValue={geoDefaults.region}
                    startDisabled={false}
                  />
                  <GeoBox
                    label="Provincia"
                    boxClass="js-it-province-box"
                    inputClass="js-it-province"
                    name="client_province"
                    inputId="clientProvince"
                    placeholder="Seleziona prima la regione…"
                    defaultValue={geoDefaults.province}
                    startDisabled
                  />
                  <GeoBox
                    label="Città"
                    boxClass="js-it-city-box"
                    inputClass="js-it-city"
                    name="client_city"
                    inputId="clientCity"
                    placeholder="Seleziona prima la provincia…"
                    defaultValue={geoDefaults.city}
                    startDisabled
                  />

                  <div className="col-md-6">
                    <label className="form-label">CAP</label>
                    <input className="form-control" name="client_cap" id="clientCap" value={clientCap} onChange={(e) => setClientCap(e.target.value)} />
                  </div>
                </div>

                <div className="mt-3">
                  <div className="fw-semibold mb-2">Info fiscali</div>
                  <div className="row g-2">
                    <div className="col-md-6">
                      <label className="form-label">Codice Fiscale</label>
                      <input className="form-control" name="client_tax_code" id="clientTaxCode" value={clientTaxCode} onChange={(e) => setClientTaxCode(e.target.value)} />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Partita IVA</label>
                      <input className="form-control" name="client_vat_number" id="clientVatNumber" value={clientVatNumber} onChange={(e) => setClientVatNumber(e.target.value)} />
                    </div>

                    <div className="col-md-6">
                      <label className="form-label">SDI</label>
                      <input className="form-control" name="client_sdi" id="clientSdi" value={clientSdi} onChange={(e) => setClientSdi(e.target.value)} />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Azienda</label>
                      <input className="form-control" name="client_company_name" id="clientCompanyName" value={clientCompanyName} onChange={(e) => setClientCompanyName(e.target.value)} />
                    </div>

                    <div className="col-12">
                      <label className="form-label">PEC</label>
                      <div className="input-group">
                        <span className="input-group-text">
                          <i className="bi bi-envelope" />
                        </span>
                        <input className="form-control" type="email" name="client_pec" id="clientPec" value={clientPec} placeholder="pec@dominio.it" onChange={(e) => setClientPec(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>

                <hr className="my-3" />

                <div className="mb-3">
                  <label className="form-label">Note interne (solo staff)</label>
                  <textarea className="form-control" name="notes" rows={3} placeholder="Queste note NON saranno visibili al cliente." value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>

                <div className="mb-3">
                  <label className="form-label">Nota per il cliente (visibile nel preventivo)</label>
                  <textarea className="form-control" name="public_note" rows={3} placeholder="Esempio: informazioni aggiuntive, riferimenti, ecc." value={publicNote} onChange={(e) => setPublicNote(e.target.value)} />
                </div>

                <div className="mb-3">
                  <label className="form-label">Metodi di pagamento (opzionale)</label>
                  {availablePms.length > 0 ? (
                    <>
                      <div className="border rounded-3 p-2 bg-light">
                        {availablePms.map((pm, idx) => {
                          // Riga "Nome: dettagli" -> resa strutturata (legacy).
                          let pmName = pm;
                          let pmDetails = "";
                          const pos = pm.indexOf(":");
                          if (pos !== -1) {
                            const left = pm.slice(0, pos).trim();
                            const right = pm.slice(pos + 1).trim();
                            if (left !== "" && left.length <= 80) {
                              pmName = left;
                              pmDetails = right;
                            }
                          }
                          const pmId = `pm_${idx}`;
                          const checked = selectedPms.includes(pm);
                          return (
                            <div className="form-check" key={pmId}>
                              <input
                                className="form-check-input"
                                type="checkbox"
                                name="payment_methods[]"
                                id={pmId}
                                value={pm}
                                checked={checked}
                                onChange={(e) => {
                                  setSelectedPms((prev) => (e.target.checked ? [...prev, pm] : prev.filter((x) => x !== pm)));
                                }}
                              />
                              <label className="form-check-label" htmlFor={pmId}>
                                <div className="fw-semibold">{pmName}</div>
                                {pmDetails !== "" ? <div className="small text-muted quote-prewrap">{pmDetails}</div> : null}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                      <div className="form-text">
                        Configura l’elenco in <strong>Preventivi → Impostazioni</strong>.
                      </div>
                    </>
                  ) : (
                    <div className="alert alert-light small mb-0">
                      Nessun metodo di pagamento configurato. Vai in <strong>Preventivi → Impostazioni</strong> per inserirli.
                    </div>
                  )}
                </div>

                <div className="mb-0">
                  <label className="form-label">Condizioni (opzionale)</label>
                  <textarea className="form-control" name="terms" rows={4} placeholder="Es. validità 30 giorni..." value={terms} onChange={(e) => setTerms(e.target.value)} />
                  <div className="form-text">
                    Lo stato <strong>Scaduto</strong> viene impostato automaticamente in base a “Valido fino al”.
                  </div>
                </div>
              </div>
            </div>

            <div className="col-lg-8">
              <div className="card p-4">
                <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                  <div>
                    <div className="fw-semibold">Righe preventivo</div>
                    <div className="text-muted small">Aggiungi una riga alla volta (prodotti, servizi o voce libera).</div>
                  </div>
                </div>

                <div className="border rounded-3 p-3 bg-light mt-3">
                  <div className="row g-2 align-items-end">
                    <div className="col-md-3">
                      <label className="form-label">Tipo</label>
                      <select
                        className="form-select"
                        id="itemType"
                        value={itemType}
                        onChange={(e) => setItemType(e.target.value)}
                      >
                        <option value="service">Servizio</option>
                        <option value="product">Prodotto</option>
                        <option value="package">Pacchetto</option>
                        <option value="custom">Voce libera</option>
                      </select>
                    </div>

                    <div className={`col-md-5 ${itemType !== "service" ? "d-none" : ""}`} id="pickServiceWrap">
                      <label className="form-label">Servizio</label>
                      <FormCombobox
                        boxId="serviceBox"
                        items={serviceItems}
                        value={serviceId}
                        placeholder="Seleziona…"
                        searchPlaceholder="Cerca…"
                        onSelect={(id) => {
                          setServiceId(id);
                          const s = services.find((x) => String(x.id) === id);
                          if (s) setItemPrice(String(Number(s.price || 0)));
                        }}
                      />
                    </div>

                    <div className={`col-md-5 ${itemType !== "product" ? "d-none" : ""}`} id="pickProductWrap">
                      <label className="form-label">Prodotto</label>
                      <FormCombobox
                        boxId="productBox"
                        items={productItems}
                        value={productId}
                        placeholder="Seleziona…"
                        searchPlaceholder="Cerca nome o SKU…"
                        onSelect={(id) => {
                          setProductId(id);
                          const p = products.find((x) => String(x.id) === id);
                          if (p) setItemPrice(String(Number(p.price || 0)));
                        }}
                      />
                    </div>

                    <div className={`col-md-5 ${itemType !== "package" ? "d-none" : ""}`} id="pickPackageWrap">
                      <label className="form-label">Pacchetto</label>
                      <FormCombobox
                        boxId="packageBox"
                        items={packageItems}
                        value={packageId}
                        placeholder="Seleziona…"
                        searchPlaceholder="Cerca pacchetto..."
                        onSelect={(id) => {
                          setPackageId(id);
                          const p = packages.find((x) => String(x.id) === id);
                          if (p) {
                            setItemPrice(String(Number(p.price || 0)));
                            setItemQty("1");
                          }
                        }}
                      />
                    </div>

                    <div className={`col-md-5 ${itemType !== "custom" ? "d-none" : ""}`} id="customDescWrap">
                      <label className="form-label">Descrizione</label>
                      <input className="form-control" id="customDesc" placeholder="Descrizione riga..." value={customDesc} onChange={(e) => setCustomDesc(e.target.value)} />
                    </div>

                    <div className="col-md-2">
                      <label className="form-label">Q.tà</label>
                      <input className="form-control" type="number" id="itemQty" min="0.01" step="0.01" value={itemQty} onChange={(e) => setItemQty(e.target.value)} />
                    </div>

                    <div className="col-md-2">
                      <label className="form-label">Prezzo</label>
                      <input
                        className={`form-control ${lockedPrice ? "bg-light" : ""}`}
                        type="number"
                        id="itemPrice"
                        min="0"
                        step="0.01"
                        value={itemPrice}
                        readOnly={lockedPrice}
                        title={lockedPrice ? "Prezzo bloccato: viene preso dal catalogo." : ""}
                        onChange={(e) => setItemPrice(e.target.value)}
                      />
                    </div>

                    <div className="col-md-2">
                      <label className="form-label">IVA %</label>
                      <input className="form-control" type="number" id="itemTax" min="0" max="100" step="0.01" value={itemTax} onChange={(e) => setItemTax(e.target.value)} />
                    </div>

                    <div className="col-md-2">
                      <label className="form-label">Sconto %</label>
                      <input className="form-control" type="number" id="itemDisc" min="0" max="100" step="0.01" value={itemDisc} onChange={(e) => setItemDisc(e.target.value)} />
                    </div>

                    <div className="col-md-1 d-grid">
                      <button className="btn btn-primary" type="button" id="addItemBtn" onClick={addItem}>
                        Aggiungi
                      </button>
                    </div>
                  </div>
                </div>

                <div className="table-responsive mt-3">
                  <table className="table align-middle" id="itemsTable">
                    <thead>
                      <tr>
                        <th>Descrizione</th>
                        <th className="text-end">Q.tà</th>
                        <th className="text-end">Prezzo</th>
                        <th className="text-end">IVA</th>
                        <th className="text-end">Sconto</th>
                        <th className="text-end">Totale</th>
                        <th className="text-end">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-muted p-3">
                            Nessuna riga.
                          </td>
                        </tr>
                      ) : (
                        items.map((it, idx) => {
                          const calc = computeLine(it);
                          const sku = it.sku ? String(it.sku) : "";
                          const shownDesc =
                            String(it.item_type || "") === "product" && sku && !String(it.description || "").includes(`(${sku})`)
                              ? `${String(it.description || "")} (${sku})`
                              : String(it.description || "");
                          return (
                            <tr key={idx}>
                              <td>
                                <div className="fw-semibold">{shownDesc}</div>
                                {sku ? <div className="small text-muted">SKU: {sku}</div> : null}
                                {Number(it.discount_percent || 0) > 0 ? (
                                  <div className="small text-muted">Sconto: {String(it.discount_percent)}%</div>
                                ) : null}
                              </td>
                              <td className="text-end">{String(it.qty || 1)}</td>
                              <td className="text-end">€ {moneyJs(it.unit_price || 0)}</td>
                              <td className="text-end">{String(it.tax_rate || 0)}%</td>
                              <td className="text-end">{String(it.discount_percent || 0)}%</td>
                              <td className="text-end fw-semibold">€ {moneyJs(calc.line_total)}</td>
                              <td className="text-end">
                                <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeItem(idx)}>
                                  <i className="bi bi-x-lg" />
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="row g-3 justify-content-end">
                  <div className="col-md-6">
                    <div className="border rounded-3 p-3 bg-light" id="totalsBox">
                      <div className="d-flex justify-content-between">
                        <span>Subtotale</span>
                        <strong id="tSubtotal">€ {moneyJs(totals.sub)}</strong>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>Sconto</span>
                        <strong id="tDiscount">€ {moneyJs(totals.disc)}</strong>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>IVA</span>
                        <strong id="tTax">€ {moneyJs(totals.tax)}</strong>
                      </div>
                      <hr className="my-2" />
                      <div className="d-flex justify-content-between fs-5">
                        <span>Totale</span>
                        <strong id="tTotal">€ {moneyJs(totals.total)}</strong>
                      </div>
                    </div>
                  </div>
                </div>

                <hr className="my-3" />

                <div className="d-flex gap-2">
                  <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                    <i className="bi bi-check2-circle me-1" />
                    Salva preventivo
                  </button>
                  <a className="btn btn-outline-secondary" href={listUrl()}>
                    Annulla
                  </a>
                </div>
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
