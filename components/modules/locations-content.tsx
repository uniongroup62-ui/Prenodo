"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTakenFlash } from "./flash";

// Faithful port of the PHP "Sedi" page (app/pages/locations.php — anche
// index.php?page=settings via shim) + assets/js/pages/locations.js:
// header "Impostazioni / Sedi" con i bottoni pill Orari/Booking; tabella
// Sede | Contatti | Booking | Marketplace | Categorie attive (chip) | Ordine |
// Azioni con i badge Visibile/Bloccata/Nascosta; modale sede modal-xl con le
// combobox Regione→Provincia→Città di italy-geo.js e il warning dinamico
// booking/marketplace; modale Marketplace sede con le card categoria (max 5,
// badge Principale/posizione, dblclick = principale) e la gallery legacy
// (pending "Da salvare" con anteprime, dropzone, feedback per-modale); modale
// eliminazione con accordion (configurazioni/esclusivi/condivisi) e conferma
// ELIMINA. I flash dei redirect legacy diventano View::alert locali.

type GalleryImage = { id?: number; url?: string; image_url?: string; path?: string };

type ActivityMapping = {
  marketplaceCategoryId?: number;
  marketplaceCategoryName?: string;
  iconKey?: string;
  isPrimary?: boolean;
  // shape legacy tollerata
  category_id?: number;
  id?: number;
  name?: string;
  is_primary?: number;
};

type LocationRow = {
  id: number;
  name: string;
  address: string;
  isActive: boolean;
  phone: string;
  email: string;
  whatsapp: string;
  facebookUrl: string;
  instagramUrl: string;
  tiktokUrl: string;
  bookingEnabled: boolean;
  marketplaceEnabled: boolean;
  sortOrder: number;
  legal: Record<string, string>;
  galleryImages: GalleryImage[];
  activityCategories: ActivityMapping[];
  bookingUrl: string;
};

type ActivityCategory = { id: number; name: string; slug?: string; iconClass?: string };

type DeletePreview = {
  ok: boolean;
  error?: string;
  location?: { id?: number; name?: string };
  activeCount?: number;
  canDelete?: boolean;
  deleteBlockReason?: string;
  blockingCounts?: Record<string, number>;
  directCounts?: Record<string, number>;
  exclusive?: Record<string, string[]>;
  shared?: Record<string, Record<string, string> | string[]>;
  clientReassignments?: Record<string, { location_name?: string; activity_count?: number; last_activity?: string }>;
  confirmText?: string;
};

type Ctx = {
  locations: LocationRow[];
  activityCategories: ActivityCategory[];
  featureFlags: { bookingPublicAllowed: boolean; marketplacePublicAllowed: boolean; unavailableMessage: string };
};

// $deletePreviewFormatKey (locations.php 941-1035): etichette leggibili
// verbatim per l'anteprima eliminazione, fallback 'Dato collegato'.
const TABLE_LABELS: Record<string, string> = {
  appointments: "Appuntamenti",
  appointment_giftbox_items: "GiftBox negli appuntamenti",
  appointment_gift_items: "Omaggi negli appuntamenti",
  appointment_package_items: "Pacchetti negli appuntamenti",
  appointment_prepaid_service_items: "Prepagati negli appuntamenti",
  appointment_locations: "Sedi appuntamenti",
  appointment_segments: "Segmenti appuntamenti",
  appointment_services: "Servizi appuntamenti",
  appointment_staff: "Operatori appuntamenti",
  business_hours: "Orari attivita",
  business_hours_exceptions: "Eccezioni orari",
  cabins: "Cabine",
  client_packages: "Pacchetti cliente",
  client_package_items: "Elementi pacchetti cliente",
  client_package_services: "Servizi pacchetti cliente",
  client_package_transactions: "Movimenti pacchetti cliente",
  client_package_usages: "Utilizzi pacchetti cliente",
  client_prepaid_services: "Prepagati cliente",
  client_prepaid_service_usages: "Utilizzi prepagati cliente",
  clients: "Clienti",
  clients_reassigned: "Clienti riassegnati",
  clients_without_location: "Clienti senza nuova sede",
  closures: "Chiusure",
  costs: "Costi",
  coupon_locations: "Sedi coupon",
  coupons: "Coupon",
  events: "Eventi",
  gift_instances: "Omaggi",
  gift_locations: "Sedi omaggi",
  gift_progress_resets: "Reset progresso omaggi",
  gift_rule_sets: "Regole omaggi",
  gift_rules: "Dettagli regole omaggi",
  gift_transactions: "Movimenti omaggi",
  gifts: "Campagne omaggi",
  giftbox_instances: "GiftBox",
  giftbox_redemptions: "Riscatti GiftBox",
  giftbox_redemption_items: "Elementi riscatti GiftBox",
  giftbox_transactions: "Movimenti GiftBox",
  giftcards: "GiftCard",
  giftcard_items: "Elementi GiftCard",
  giftcard_transactions: "Movimenti GiftCard",
  location_gallery_images: "Gallery sede",
  locations: "Sedi",
  package_items: "Elementi pacchetti",
  package_locations: "Sedi pacchetti",
  package_pricing: "Prezzi pacchetti",
  package_services: "Servizi pacchetti",
  packages: "Pacchetti",
  products: "Prodotti",
  product_images: "Immagini prodotti",
  product_stocks: "Giacenze prodotti",
  promotion_blackout_dates: "Date escluse promozioni",
  promotion_locations: "Sedi promozioni",
  promotion_products: "Prodotti promozioni",
  promotion_redemptions: "Utilizzi promozioni",
  promotion_services: "Servizi promozioni",
  promotion_time_windows: "Fasce orarie promozioni",
  promotions: "Promozioni",
  quotes: "Preventivi",
  quote_items: "Righe preventivi",
  recharges: "Ricariche",
  credit_adjustments: "Rettifiche credito",
  reminders: "Promemoria",
  resources: "Risorse",
  resource_locations: "Sedi risorse",
  sales: "Vendite",
  sale_items: "Righe vendita",
  sale_installment_plans: "Piani rate vendita",
  sale_installments: "Rate vendita",
  service_cabins: "Cabine servizi",
  service_locations: "Sedi servizi",
  service_recommendations: "Raccomandazioni servizi",
  service_resources: "Risorse servizi",
  services: "Servizi",
  staff: "Operatori",
  staff_availability: "Disponibilita operatori",
  staff_commission_payments: "Pagamenti commissioni operatori",
  staff_commission_periods: "Periodi commissioni operatori",
  staff_commission_settings: "Impostazioni commissioni operatori",
  staff_locations: "Sedi operatori",
  staff_services: "Servizi operatori",
  staff_timeoff: "Assenze operatori",
  stock_docs: "Documenti magazzino",
  stock_doc_items: "Righe documenti magazzino",
  stock_moves: "Movimenti magazzino",
  suppliers: "Fornitori",
  supplier_locations: "Sedi fornitori",
  transactions: "Movimenti credito",
  user_locations: "Sedi utenti",
};
const tableLabel = (t: string) => TABLE_LABELS[t] ?? "Dato collegato";

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// business_profile.js/locations.js formatFileSize: MB con virgola italiana.
function formatGalleryFileSize(bytes: number): string {
  const size = Number(bytes || 0);
  if (size <= 0) return "0 MB";
  return (size / 1048576).toFixed(1).replace(".", ",") + " MB";
}

function mappingCategoryId(c: ActivityMapping): number {
  return Number(c.marketplaceCategoryId ?? c.category_id ?? c.id ?? 0);
}

function mappingCategoryName(c: ActivityMapping): string {
  return String(c.marketplaceCategoryName ?? c.name ?? "");
}

function mappingIsPrimary(c: ActivityMapping): boolean {
  return c.isPrimary === true || Number(c.is_primary ?? 0) === 1;
}

// Combobox legacy (app-combobox + italy-geo.js): markup identico a
// locations.php 710-751; i valori vivono negli hidden input NON controllati
// (lo script li gestisce) e vengono letti dal DOM al submit.
function GeoCombobox({
  label,
  boxClass,
  inputClass,
  name,
  placeholder,
  defaultValue,
  startDisabled,
}: {
  label: string;
  boxClass: string;
  inputClass: string;
  name: string;
  placeholder: string;
  defaultValue: string;
  startDisabled: boolean;
}) {
  return (
    <div className="col-md-4">
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
        <input type="hidden" name={name} className={inputClass} defaultValue={defaultValue} />
        <div className="dropdown-menu p-2 w-100 app-combobox-menu">
          <input type="text" className="form-control form-control-sm app-combobox-search" placeholder="Cerca..." autoComplete="off" />
          <div className="list-group mt-2 app-combobox-list" />
        </div>
      </div>
    </div>
  );
}

type Flash = { text: string; type: "success" | "danger" };

type PendingEntry = { file: File; url: string };

export function LocationsContent({
  slug: slugProp,
  initialQuery,
}: { slug?: string; initialQuery?: { msg?: string; err?: string; action?: string; id?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  // Flash legacy (View::alert msg success / err danger sopra il page header).
  useTakenFlash((f) => {
    if (f.err) setFlash({ text: f.err, type: "danger" });
    else if (f.msg) setFlash({ text: f.msg, type: "success" });
  });
  const [flash, setFlash] = useState<Flash | null>(() => {
    if (initialQuery?.err) return { text: String(initialQuery.err), type: "danger" };
    if (initialQuery?.msg) return { text: String(initialQuery.msg), type: "success" };
    return null;
  });
  const [busy, setBusy] = useState(false);
  // Modale sede.
  const [editRow, setEditRow] = useState<LocationRow | "new" | null>(null);
  const [formName, setFormName] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formCap, setFormCap] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formWhatsapp, setFormWhatsapp] = useState("");
  const [formFacebook, setFormFacebook] = useState("");
  const [formInstagram, setFormInstagram] = useState("");
  const [formTiktok, setFormTiktok] = useState("");
  const [formBooking, setFormBooking] = useState(true);
  const locationFormRef = useRef<HTMLFormElement | null>(null);
  // Modale marketplace.
  const [mktLocation, setMktLocation] = useState<LocationRow | null>(null);
  const [mktEnabled, setMktEnabled] = useState(false);
  // Ordine di selezione categorie (activitySelectionOrder di locations.js).
  const [mktSelection, setMktSelection] = useState<number[]>([]);
  const [mktPrimaryId, setMktPrimaryId] = useState(0);
  const [galleryPending, setGalleryPending] = useState<PendingEntry[]>([]);
  const [galleryFeedback, setGalleryFeedback] = useState<Flash | null>(null);
  const [galleryUploading, setGalleryUploading] = useState(false);
  const [galleryDragover, setGalleryDragover] = useState(false);
  const galleryFileInputRef = useRef<HTMLInputElement | null>(null);
  // Modale eliminazione (accordion: una sola sezione aperta, direct di default).
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteSection, setDeleteSection] = useState<"direct" | "exclusive" | "shared">("direct");

  const showFlash = useCallback((next: Flash | null) => {
    setFlash(next);
    if (next && typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(() => {
    return fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setCtx({
          locations: Array.isArray(j.locations) ? j.locations : [],
          activityCategories: Array.isArray(j.marketplace?.activityCategories) ? j.marketplace.activityCategories : [],
          featureFlags: j.featureFlags ?? { bookingPublicAllowed: true, marketplacePublicAllowed: true, unavailableMessage: "Funzione non disponibile per il tuo account" },
        });
      })
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Deep-link legacy index.php?page=locations&action=delete_preview&id=N.
  const initialDeleteId = initialQuery?.action === "delete_preview" ? Number(initialQuery?.id ?? 0) : 0;
  useEffect(() => {
    if (initialDeleteId > 0) void openDeletePreviewById(initialDeleteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeleteId]);

  // Combobox Regione/Provincia/Città: inietta italy-geo.js (IIFE legacy) DOPO
  // il render del modale con gli hidden prefillati; ?v= cache-buster per
  // ri-eseguirlo a ogni apertura (il legacy usa ?v=filemtime).
  useEffect(() => {
    if (!editRow) return;
    const s = document.createElement("script");
    s.id = "italyGeoScript";
    s.dataset.base = window.location.origin;
    s.src = `/assets/js/italy-geo.js?v=${Date.now()}`;
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, [editRow]);

  async function post(fields: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ...fields }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Operazione non riuscita."));
      return j as Record<string, unknown>;
    } catch (e) {
      showFlash({ text: e instanceof Error ? e.message : "Operazione non riuscita.", type: "danger" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function applyContext(j: Record<string, unknown>) {
    const list = Array.isArray(j.locations) ? (j.locations as LocationRow[]) : [];
    if (list.length || Array.isArray(j.locations)) {
      setCtx((prev) => (prev ? { ...prev, locations: list } : prev));
    }
  }

  function openNew() {
    setEditRow("new");
    setFormName("");
    setFormAddress("");
    setFormCap("");
    setFormPhone("");
    setFormEmail("");
    setFormWhatsapp("");
    setFormFacebook("");
    setFormInstagram("");
    setFormTiktok("");
    setFormBooking(true);
  }

  function openEdit(l: LocationRow) {
    setEditRow(l);
    setFormName(l.name);
    setFormAddress(l.address);
    setFormCap(l.legal?.legal_cap ?? "");
    setFormPhone(l.phone);
    setFormEmail(l.email);
    setFormWhatsapp(l.whatsapp);
    setFormFacebook(l.facebookUrl);
    setFormInstagram(l.instagramUrl);
    setFormTiktok(l.tiktokUrl);
    setFormBooking(l.bookingEnabled);
  }

  async function saveLocation(e: React.FormEvent) {
    e.preventDefault();
    const isEdit = editRow !== "new" && editRow !== null;
    const geo = (name: string) => locationFormRef.current?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? "";
    const j = await post({
      action: "location_save",
      id: String(isEdit ? (editRow as LocationRow).id : 0),
      name: formName,
      address: formAddress,
      legal_region: geo("legal_region"),
      legal_province: geo("legal_province"),
      legal_city: geo("legal_city"),
      legal_cap: formCap,
      phone: formPhone,
      email: formEmail,
      whatsapp: formWhatsapp,
      facebook_url: formFacebook,
      instagram_url: formInstagram,
      tiktok_url: formTiktok,
      booking_enabled: formBooking ? "1" : "0",
    });
    if (j) {
      setEditRow(null);
      applyContext(j);
      showFlash({ text: String(j.message ?? "Sede salvata"), type: "success" });
    }
  }

  async function move(l: LocationRow, direction: "up" | "down") {
    const j = await post({ action: "location_move", id: String(l.id), direction });
    if (j) {
      applyContext(j);
      showFlash({ text: String(j.message ?? "Ordine sedi aggiornato"), type: "success" });
    }
  }

  function openMarketplace(l: LocationRow) {
    setMktLocation(l);
    setMktEnabled(l.marketplaceEnabled);
    const mappings = l.activityCategories ?? [];
    const ids = mappings.map(mappingCategoryId).filter((n) => n > 0);
    setMktSelection(Array.from(new Set(ids)));
    const primary = mappings.find(mappingIsPrimary);
    setMktPrimaryId(Number(primary ? mappingCategoryId(primary) : ids[0] ?? 0));
    setGalleryPending([]);
    setGalleryFeedback(null);
  }

  function closeMarketplace() {
    for (const entry of galleryPending) URL.revokeObjectURL(entry.url);
    setGalleryPending([]);
    setGalleryFeedback(null);
    setMktLocation(null);
  }

  // Selezione categorie come locations.js: array ordinato per selezione,
  // max 5 con alert, primary = primo se non impostata; dblclick = principale.
  function toggleCategory(id: number, checked: boolean) {
    if (checked) {
      const next = mktSelection.includes(id) ? mktSelection : [...mktSelection, id];
      if (next.length > 5) {
        window.alert("Puoi selezionare al massimo 5 categorie per sede.");
        return;
      }
      setMktSelection(next);
      if (mktPrimaryId <= 0) setMktPrimaryId(id);
    } else {
      const next = mktSelection.filter((x) => x !== id);
      setMktSelection(next);
      if (mktPrimaryId === id) setMktPrimaryId(next[0] ?? 0);
    }
  }

  function makePrimary(id: number) {
    if (!mktSelection.includes(id)) {
      if (mktSelection.length >= 5) {
        window.alert("Puoi selezionare al massimo 5 categorie per sede.");
        return;
      }
      setMktSelection((prev) => [...prev, id]);
    }
    setMktPrimaryId(id);
  }

  const mktEffectivePrimary = mktSelection.length === 0 ? 0 : (mktSelection.includes(mktPrimaryId) ? mktPrimaryId : mktSelection[0]);

  async function saveMarketplace(e: React.FormEvent) {
    e.preventDefault();
    if (!mktLocation) return;
    // Guardia client legacy (locations.js 460-468, testo DIVERSO dal server).
    if (mktEnabled && mktSelection.length === 0) {
      window.alert("Seleziona almeno una categoria attivita per rendere visibile la sede nel marketplace.");
      return;
    }
    const j = await post({
      action: "location_marketplace_save",
      location_id: String(mktLocation.id),
      marketplace_enabled: mktEnabled ? "1" : "0",
      activity_category_ids: mktSelection.join(","),
      activity_category_order: mktSelection.join(","),
      primary_activity_category_id: String(mktEffectivePrimary),
    });
    if (j) {
      closeMarketplace();
      applyContext(j);
      showFlash({ text: String(j.message ?? "Marketplace sede aggiornato"), type: "success" });
    }
  }

  // Refresh della sede aperta nella modale marketplace dopo un'azione gallery.
  function refreshMktLocation(j: Record<string, unknown>) {
    const list = Array.isArray(j.locations) ? (j.locations as LocationRow[]) : [];
    setCtx((prev) => (prev ? { ...prev, locations: list.length ? list : prev.locations } : prev));
    setMktLocation((prev) => (prev ? list.find((l) => l.id === prev.id) ?? prev : prev));
  }

  // Delete foto: AJAX con feedback nel modale (locations.js 471-533).
  async function galleryDelete(imageId: number) {
    if (!mktLocation || imageId <= 0) return;
    if (!window.confirm("Rimuovere questa foto dalla gallery della sede?")) return;
    setGalleryFeedback(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ slug, ajax: "1", action: "location_gallery_delete", location_id: String(mktLocation.id), gallery_image_id: String(imageId) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Errore durante la rimozione della foto."));
      refreshMktLocation(j as Record<string, unknown>);
      setGalleryFeedback({ text: String(j.message ?? "Foto gallery sede rimossa"), type: "success" });
    } catch (e) {
      setGalleryFeedback({ text: e instanceof Error ? e.message : "Errore durante la rimozione della foto.", type: "danger" });
    } finally {
      setBusy(false);
    }
  }

  // Move foto: nel legacy è un form POST classico → redirect col flash
  // globale 'Ordine gallery sede aggiornato' (modale chiuso dal reload).
  async function galleryMove(imageId: number, direction: "up" | "down") {
    if (!mktLocation || imageId <= 0) return;
    const j = await post({ action: "location_gallery_move", location_id: String(mktLocation.id), gallery_image_id: String(imageId), direction });
    if (j) {
      closeMarketplace();
      applyContext(j);
      showFlash({ text: String(j.message ?? "Ordine gallery sede aggiornato"), type: "success" });
    }
  }

  // addGalleryPendingFiles (locations.js 252-281): valida tipo/5MB e accumula
  // le anteprime; le scartate finiscono nell'alert riepilogativo legacy.
  function addGalleryPendingFiles(fileList: FileList | File[] | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (!files.length) return;
    setGalleryFeedback(null);
    const invalid: string[] = [];
    const accepted: PendingEntry[] = [];
    for (const file of files) {
      const typeOk = ["image/jpeg", "image/png", "image/webp"].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name || "");
      if (!typeOk) {
        invalid.push(file.name || "file");
        continue;
      }
      if (file.size > 5242880) {
        invalid.push((file.name || "file") + " supera 5 MB");
        continue;
      }
      accepted.push({ file, url: URL.createObjectURL(file) });
    }
    if (accepted.length) setGalleryPending((prev) => [...prev, ...accepted]);
    if (galleryFileInputRef.current) galleryFileInputRef.current.value = "";
    if (invalid.length) window.alert("Alcune foto non sono state aggiunte: " + invalid.join(", ") + ".");
  }

  function removeGalleryPending(index: number) {
    setGalleryPending((prev) => {
      const entry = prev[index];
      if (entry?.url) URL.revokeObjectURL(entry.url);
      return prev.filter((_, i) => i !== index);
    });
  }

  function clearGalleryPending() {
    for (const entry of galleryPending) URL.revokeObjectURL(entry.url);
    setGalleryPending([]);
  }

  async function submitGallery(e: React.FormEvent) {
    e.preventDefault();
    if (!mktLocation) return;
    // validateGalleryFiles (locations.js 535-562), alert verbatim.
    if (mktLocation.id <= 0) {
      window.alert("Sede non valida.");
      return;
    }
    if (!galleryPending.length) {
      window.alert("Seleziona almeno una foto da salvare.");
      return;
    }
    for (const entry of galleryPending) {
      if (!entry.file) {
        window.alert("Una o piu foto non sono valide.");
        return;
      }
      if (entry.file.size > 5242880) {
        window.alert("Una o piu foto superano il limite di 5 MB.");
        return;
      }
    }
    setGalleryUploading(true);
    setGalleryFeedback(null);
    try {
      const fd = new FormData();
      fd.set("ajax", "1");
      fd.set("action", "location_gallery_upload");
      fd.set("location_id", String(mktLocation.id));
      for (const entry of galleryPending) fd.append("location_gallery_images", entry.file, entry.file.name);
      const res = await fetch(`/api/manage/business-settings?slug=${encodeURIComponent(slug)}`, { method: "POST", headers: { "x-tenant-slug": slug }, body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(String(j.error || "Errore durante il salvataggio gallery."));
      clearGalleryPending();
      refreshMktLocation(j as Record<string, unknown>);
      setGalleryFeedback({ text: String(j.message ?? "Foto gallery sede caricate"), type: "success" });
    } catch (e) {
      setGalleryFeedback({ text: e instanceof Error ? e.message : "Errore durante il salvataggio gallery.", type: "danger" });
    } finally {
      setGalleryUploading(false);
    }
  }

  async function openDeletePreviewById(id: number) {
    setDeleteReason("");
    setDeleteConfirm("");
    setDeleteSection("direct");
    const j = await post({ action: "location_delete_preview", id: String(id) });
    if (j) setDeletePreview((j.deletePreview ?? j) as DeletePreview);
  }

  async function confirmDelete(e: React.FormEvent) {
    e.preventDefault();
    const id = Number(deletePreview?.location?.id ?? 0);
    if (id <= 0) return;
    const j = await post({ action: "location_delete", id: String(id), confirm_text: deleteConfirm, reason: deleteReason });
    if (j) {
      setDeletePreview(null);
      applyContext(j);
      showFlash({ text: String(j.message ?? "Sede eliminata definitivamente"), type: "success" });
    }
  }

  function href(page: string): string {
    return `/${encodeURIComponent(slug)}/${page}`;
  }

  const locations = ctx?.locations ?? [];
  const flags = ctx?.featureFlags;
  const bookingPublicAllowed = flags?.bookingPublicAllowed ?? true;
  const marketplacePublicAllowed = flags?.marketplacePublicAllowed ?? true;
  const unavailableMessage = flags?.unavailableMessage ?? "Funzione non disponibile per il tuo account";
  const isEdit = editRow !== null && editRow !== "new";
  const editData = isEdit ? (editRow as LocationRow) : null;
  // Warning booking/marketplace (locations.js refreshBookingMarketplaceWarning).
  const showBookingWarning = Boolean(editData && editData.marketplaceEnabled && !formBooking);

  const deleteDirectTotal = Object.values(deletePreview?.directCounts ?? {}).reduce((sum, n) => sum + Number(n), 0);
  const deleteExclusiveTotal = Object.values(deletePreview?.exclusive ?? {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : Object.keys(rows ?? {}).length), 0);
  const deleteSharedTotal = Object.values(deletePreview?.shared ?? {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : Object.keys(rows ?? {}).length), 0);

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/locations.css" />

      {flash ? (
        <div className={`alert alert-${flash.type} d-flex align-items-start gap-2`}>
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.text}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Impostazioni</div>
          <h1 className="bs-page-title">Sedi</h1>
          <div className="bs-page-subtitle">Crea e gestisci le tue sedi e la visibilita.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary btn-pill" href={href("hours")}>
            <i className="bi bi-clock-history me-1" />
            Orari
          </a>
          <a className="btn btn-outline-secondary btn-pill" href={href("booking")}>
            <i className="bi bi-link-45deg me-1" />
            Booking
          </a>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12">
          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center">
              <div>
                <div className="fw-semibold">Elenco sedi</div>
              </div>
              <button className="btn btn-sm btn-primary" type="button" onClick={openNew}>
                <i className="bi bi-plus-lg me-1" />
                Nuova
              </button>
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Sede</th>
                    <th>Contatti</th>
                    <th>Booking</th>
                    <th>Marketplace</th>
                    <th>Categorie attive</th>
                    <th className="text-center">Ordine</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((l, idx) => {
                    const bookingLocalEnabled = l.bookingEnabled;
                    const bookingVisible = bookingPublicAllowed && bookingLocalEnabled;
                    const marketplaceLocalEnabled = l.isActive && l.marketplaceEnabled;
                    const marketplaceVisible = marketplacePublicAllowed && marketplaceLocalEnabled;
                    const activityNames = Array.from(new Set((l.activityCategories ?? []).map(mappingCategoryName).map((n) => n.trim()).filter(Boolean)));
                    return (
                      <tr key={l.id}>
                        <td>
                          <div className="fw-semibold">{l.name}</div>
                          <div className="small text-muted">{l.address}</div>
                        </td>
                        <td className="small">
                          {l.phone ? <div>{l.phone}</div> : null}
                          {l.whatsapp ? <div>WhatsApp: {l.whatsapp}</div> : null}
                          {l.email ? <div>{l.email}</div> : null}
                          {!l.phone && !l.whatsapp && !l.email ? <span className="text-muted">-</span> : null}
                        </td>
                        <td>
                          {bookingVisible ? (
                            <span className="badge text-bg-success">Visibile</span>
                          ) : !bookingPublicAllowed && bookingLocalEnabled ? (
                            <span className="badge text-bg-warning" title={unavailableMessage}>Bloccata</span>
                          ) : (
                            <span className="badge text-bg-secondary">Nascosta</span>
                          )}
                        </td>
                        <td>
                          {marketplaceVisible ? (
                            <span className="badge text-bg-success">Visibile</span>
                          ) : !marketplacePublicAllowed && marketplaceLocalEnabled ? (
                            <span className="badge text-bg-warning" title={unavailableMessage}>Bloccata</span>
                          ) : (
                            <span className="badge text-bg-secondary">Nascosta</span>
                          )}
                        </td>
                        <td className="small">
                          {activityNames.length ? (
                            <div className="location-category-list">
                              {activityNames.map((name) => (
                                <span className="location-category-chip" key={name}>{name}</span>
                              ))}
                            </div>
                          ) : marketplaceVisible ? (
                            <span className="text-warning">Da impostare</span>
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </td>
                        <td className="text-center">
                          <div className="d-inline-flex gap-1">
                            <button className="btn btn-sm btn-outline-secondary" type="button" title="Sposta su" disabled={busy || idx <= 0} onClick={() => move(l, "up")}>
                              <i className="bi bi-arrow-up" />
                            </button>
                            <button className="btn btn-sm btn-outline-secondary" type="button" title="Sposta giu" disabled={busy || idx >= locations.length - 1} onClick={() => move(l, "down")}>
                              <i className="bi bi-arrow-down" />
                            </button>
                          </div>
                        </td>
                        <td className="text-end">
                          <div className="d-inline-flex gap-1">
                            <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openEdit(l)}>Modifica</button>
                            <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openMarketplace(l)}>Marketplace</button>
                            <button className="btn btn-sm btn-danger" type="button" onClick={() => openDeletePreviewById(l.id)} disabled={busy}>Elimina</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && locations.length === 0 ? (
                    <tr><td colSpan={7} className="text-muted">Nessuna sede configurata.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* MODALE SEDE (locationModal, locations.php 685-797) */}
      {editRow !== null ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setEditRow(null)}>
          <div className="modal-dialog modal-xl modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title mb-0" id="locationModalTitle">{isEdit ? "Modifica sede" : "Nuova sede"}</h5>
                  <div className="text-muted small" id="locationModalSubtitle">
                    {isEdit && editData?.name
                      ? `Aggiorna i dati e la visibilità della sede: ${editData.name}.`
                      : "Aggiungi i dati della tua sede e imposta la visibilità."}
                  </div>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setEditRow(null)} />
              </div>
              <div className="modal-body">
                <form method="post" className="row g-3" id="locationModalForm" ref={locationFormRef} onSubmit={saveLocation}>
                  <div className="col-12">
                    <label className="form-label">Nome sede</label>
                    <input className="form-control" name="name" required value={formName} onChange={(e) => setFormName(e.target.value)} />
                  </div>
                  <div className="col-12">
                    <label className="form-label">Indirizzo</label>
                    <input className="form-control" name="address" value={formAddress} onChange={(e) => setFormAddress(e.target.value)} />
                  </div>
                  <GeoCombobox label="Regione" boxClass="js-it-region-box" inputClass="js-it-region" name="legal_region" placeholder="Seleziona una regione..." defaultValue={editData?.legal?.legal_region ?? ""} startDisabled={false} />
                  <GeoCombobox label="Provincia" boxClass="js-it-province-box" inputClass="js-it-province" name="legal_province" placeholder="Seleziona prima la regione..." defaultValue={editData?.legal?.legal_province ?? ""} startDisabled />
                  <GeoCombobox label="Città" boxClass="js-it-city-box" inputClass="js-it-city" name="legal_city" placeholder="Seleziona prima la provincia..." defaultValue={editData?.legal?.legal_city ?? ""} startDisabled />
                  <div className="col-md-4">
                    <label className="form-label">CAP</label>
                    <input className="form-control" name="legal_cap" maxLength={20} value={formCap} onChange={(e) => setFormCap(e.target.value)} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Telefono</label>
                    <input className="form-control" name="phone" inputMode="tel" value={formPhone} onChange={(e) => setFormPhone(e.target.value)} />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Email</label>
                    <input className="form-control" type="email" name="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">WhatsApp</label>
                    <input className="form-control" name="whatsapp" inputMode="tel" value={formWhatsapp} onChange={(e) => setFormWhatsapp(e.target.value)} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Facebook</label>
                    <input className="form-control" name="facebook_url" inputMode="url" value={formFacebook} onChange={(e) => setFormFacebook(e.target.value)} placeholder="facebook.com/pagina" />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Instagram</label>
                    <input className="form-control" name="instagram_url" inputMode="url" value={formInstagram} onChange={(e) => setFormInstagram(e.target.value)} placeholder="@profilo" />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">TikTok</label>
                    <input className="form-control" name="tiktok_url" inputMode="url" value={formTiktok} onChange={(e) => setFormTiktok(e.target.value)} placeholder="@profilo" />
                  </div>
                  <div className="col-12">
                    <label className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        name="booking_enabled"
                        value="1"
                        checked={bookingPublicAllowed && formBooking}
                        disabled={!bookingPublicAllowed}
                        onChange={(e) => setFormBooking(e.target.checked)}
                      />
                      <span className="form-check-label">Abilita in prenotazioni online</span>
                    </label>
                    <div
                      className={`alert ${!bookingPublicAllowed ? "alert-danger" : `alert-warning${showBookingWarning ? "" : " d-none"}`} py-2 px-3 mt-2 mb-0`}
                      id="locationBookingMarketplaceWarning"
                      role="alert"
                      aria-live="polite"
                    >
                      {!bookingPublicAllowed
                        ? unavailableMessage
                        : "Disattivando le prenotazioni online, la scheda può restare accessibile ma i pulsanti Prenota non verranno mostrati."}
                    </div>
                  </div>
                  <div className="col-12 d-flex gap-2">
                    <button className="btn btn-primary btn-pill" type="submit" disabled={busy}>
                      <i className="bi bi-check2-circle me-1" />
                      Salva sede
                    </button>
                    <button className="btn btn-outline-secondary btn-pill" type="button" onClick={() => setEditRow(null)}>Annulla</button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE MARKETPLACE SEDE (locationMarketplaceModal, locations.php 799-917) */}
      {mktLocation ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={closeMarketplace}>
          <div className="modal-dialog modal-xl modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title mb-0" id="locationMarketplaceModalTitle">Marketplace sede</h5>
                  <div className="text-muted small d-none" id="locationMarketplaceModalSubtitle" />
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={closeMarketplace} />
              </div>
              <div className="modal-body">
                <form method="post" className="location-marketplace-panel location-marketplace-panel--soft mb-3" id="locationMarketplaceForm" onSubmit={saveMarketplace}>
                  <div className="row g-3 align-items-center">
                    <div className="col-lg-5">
                      <div className="location-marketplace-summary">
                        <div className="text-muted small">Sede</div>
                        <div className="fw-bold" id="locationMarketplaceLocationName">{mktLocation.name || "Sede"}</div>
                        {mktLocation.address ? <div className="text-muted small" id="locationMarketplaceLocationAddress">{mktLocation.address}</div> : null}
                      </div>
                    </div>
                    <div className="col-lg-4">
                      <div>
                        <div className="form-check form-switch m-0">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id="locationMarketplaceEnabled"
                            name="marketplace_enabled"
                            value="1"
                            checked={mktEnabled}
                            disabled={!marketplacePublicAllowed}
                            onChange={(e) => setMktEnabled(e.target.checked)}
                          />
                          <label className="form-check-label fw-semibold" htmlFor="locationMarketplaceEnabled">Visibile</label>
                        </div>
                        <div className={`form-text m-0 ${!marketplacePublicAllowed ? "text-danger" : ""}`} id="locationMarketplaceVisibilityHelp">
                          {!marketplacePublicAllowed ? unavailableMessage : "Visualizza o nasconde la sede nel marketplace"}
                        </div>
                      </div>
                    </div>
                    <div className="col-lg-3">
                      <button className="btn btn-primary btn-pill w-100" type="submit" id="locationMarketplaceSaveButton" disabled={busy}>
                        <i className="bi bi-check2-circle me-1" />
                        Salva
                      </button>
                    </div>
                    <div className="col-12">
                      <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                        <div>
                          <div className="fw-semibold">Categorie attivita della sede</div>
                          <div className="form-text m-0">Scegli una categoria principale e fino a 4 correlate per ricerca e filtri marketplace.</div>
                        </div>
                        <span className="badge rounded-pill text-bg-light" id="locationActivityCategoryCounter">{mktSelection.length}/5</span>
                      </div>
                      {(ctx?.activityCategories ?? []).length ? (
                        <div className="location-activity-grid" id="locationActivityCategories">
                          {(ctx?.activityCategories ?? []).map((category) => {
                            const checked = mktSelection.includes(category.id);
                            const position = mktSelection.indexOf(category.id) + 1;
                            return (
                              <label
                                className={`location-activity-card${checked ? " is-selected" : ""}`}
                                data-activity-card
                                data-activity-id={category.id}
                                key={category.id}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  makePrimary(category.id);
                                }}
                              >
                                <input
                                  className="location-activity-card__check"
                                  type="checkbox"
                                  value={category.id}
                                  checked={checked}
                                  onChange={(e) => toggleCategory(category.id, e.target.checked)}
                                />
                                <span className="location-activity-card__icon"><i className={`bi ${category.iconClass ?? "bi-grid-3x3-gap"}`} aria-hidden="true" /></span>
                                <span className="location-activity-card__name">{category.name}</span>
                                <span className="location-activity-card__badge" data-activity-badge>
                                  {checked ? (category.id === mktEffectivePrimary ? "Principale" : String(position)) : ""}
                                </span>
                                <span className="visually-hidden">{category.slug ?? ""}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="alert alert-warning small mb-0">Categorie attivita marketplace non disponibili. Aggiorna lo schema centrale.</div>
                      )}
                    </div>
                  </div>
                </form>

                <div className="location-marketplace-panel">
                  <div className="fw-semibold mb-1">Gallery marketplace sede</div>
                  <div className="text-muted small mb-3" id="locationGalleryModalSubtitle">Immagini mostrate nella scheda marketplace.</div>
                  <div className={`alert mb-3 ${galleryFeedback ? "" : "d-none "}alert-${galleryFeedback?.type ?? "success"}`} id="locationGalleryFeedback" role="alert" aria-live="polite">
                    {galleryFeedback?.text ?? ""}
                  </div>

                  {(mktLocation.galleryImages ?? []).length === 0 ? (
                    <div className="text-muted small mb-3" id="locationGalleryEmpty">Nessuna foto gallery caricata per questa sede.</div>
                  ) : null}
                  <div className="location-gallery-grid mb-4" id="locationGalleryGrid">
                    {(mktLocation.galleryImages ?? []).map((image, index, all) => {
                      const url = String(image.url ?? image.image_url ?? "");
                      return (
                        <div className="location-gallery-card" key={image.id ?? index}>
                          <div className="location-gallery-card__preview">
                            {url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={url} alt={`Foto gallery sede ${index + 1}`} />
                            ) : (
                              <div className="h-100 d-flex align-items-center justify-content-center text-muted small">File non trovato</div>
                            )}
                          </div>
                          <div className="location-gallery-card__body">
                            <div className="small fw-bold mb-2">Foto {index + 1}</div>
                            <div className="d-flex gap-1 flex-wrap">
                              <button className="btn btn-outline-secondary btn-sm" type="button" title="Sposta su" disabled={busy || index === 0} onClick={() => galleryMove(Number(image.id ?? 0), "up")}>
                                <i className="bi bi-arrow-up" />
                              </button>
                              <button className="btn btn-outline-secondary btn-sm" type="button" title="Sposta giu" disabled={busy || index === all.length - 1} onClick={() => galleryMove(Number(image.id ?? 0), "down")}>
                                <i className="bi bi-arrow-down" />
                              </button>
                              <button className="btn btn-outline-danger btn-sm ms-auto" type="button" title="Rimuovi" disabled={busy} onClick={() => galleryDelete(Number(image.id ?? 0))}>
                                <i className="bi bi-trash3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className={`location-gallery-pending mb-4${galleryPending.length ? "" : " d-none"}`} id="locationGalleryPendingWrap">
                    <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                      <div>
                        <div className="fw-semibold">Da salvare</div>
                        <div className="text-muted small">Queste foto sono solo in anteprima e verranno caricate quando premi Salva gallery.</div>
                      </div>
                      <button className="btn btn-outline-secondary btn-sm" type="button" id="locationGalleryClearPending" onClick={clearGalleryPending}>Svuota</button>
                    </div>
                    <div className="location-gallery-grid" id="locationGalleryPendingGrid">
                      {galleryPending.map((entry, index) => (
                        <div className="location-gallery-card location-gallery-card--pending" key={entry.url}>
                          <div className="location-gallery-card__preview">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={entry.url} alt={`Anteprima foto gallery ${index + 1}`} />
                          </div>
                          <div className="location-gallery-card__body">
                            <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                              <span className="badge text-bg-warning">Da salvare</span>
                              <button className="btn btn-outline-danger btn-sm" type="button" title="Rimuovi anteprima" onClick={() => removeGalleryPending(index)}>
                                <i className="bi bi-x-lg" />
                              </button>
                            </div>
                            <div className="location-gallery-card__meta">
                              <span className="location-gallery-card__name">{entry.file.name || "Foto"}</span>
                              <span>{formatGalleryFileSize(entry.file.size || 0)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="fw-semibold mb-1">Carica foto gallery (JPG/PNG/WEBP)</div>
                  <form method="post" encType="multipart/form-data" id="locationGalleryUploadForm" onSubmit={submitGallery}>
                    <div
                      className={`location-gallery-dropzone${galleryDragover ? " is-dragover" : ""}${galleryUploading ? " pe-none" : ""}`}
                      id="locationGalleryDropzone"
                      role="button"
                      tabIndex={0}
                      onClick={() => galleryFileInputRef.current?.click()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          galleryFileInputRef.current?.click();
                        }
                      }}
                      onDragEnter={(e) => {
                        e.preventDefault();
                        setGalleryDragover(true);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setGalleryDragover(true);
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        setGalleryDragover(false);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setGalleryDragover(false);
                        addGalleryPendingFiles(e.dataTransfer?.files ?? null);
                      }}
                    >
                      <div>
                        <div className="fw-semibold">Trascina qui le foto</div>
                        <div className="text-muted small">oppure clicca per selezionarle (max 5 MB per foto)</div>
                      </div>
                    </div>
                    <input
                      ref={galleryFileInputRef}
                      className="d-none"
                      type="file"
                      id="locationGalleryFileInput"
                      accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                      multiple
                      onChange={(e) => addGalleryPendingFiles(e.target.files)}
                    />
                    <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
                      <button className="btn btn-primary btn-pill" type="submit" id="locationGallerySaveButton" disabled={galleryUploading || galleryPending.length === 0}>
                        {galleryUploading ? (
                          <>
                            <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                            Salvataggio...
                          </>
                        ) : (
                          <>
                            <i className="bi bi-images me-1" />
                            Salva gallery
                          </>
                        )}
                      </button>
                      <div className="form-text m-0" id="locationGallerySelectedFiles">
                        {galleryPending.length === 0
                          ? "Nessuna nuova foto selezionata."
                          : `${galleryPending.length === 1 ? "1 foto pronta" : `${galleryPending.length} foto pronte`} - ${formatGalleryFileSize(galleryPending.reduce((sum, entry) => sum + (entry.file.size || 0), 0))} totali`}
                      </div>
                    </div>
                    <div className="form-text">Max 5 MB per foto. Le immagini verranno ridimensionate se necessario.</div>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE ELIMINAZIONE (locationDeletePreviewModal, locations.php 1041-1239) */}
      {deletePreview ? (
        <div className="modal fade show d-block" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => setDeletePreview(null)}>
          <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable" onClick={(e) => e.stopPropagation()}>
            <form className="modal-content" onSubmit={confirmDelete}>
              <div className="modal-header">
                <div>
                  <div className="text-muted small">Sedi</div>
                  <h5 className="modal-title fw-bold m-0">
                    {deletePreview.canDelete ? "Eliminazione definitiva sede" : "Impossibile eliminare la sede"}
                  </h5>
                </div>
                <button type="button" className="btn-close" aria-label="Chiudi" onClick={() => setDeletePreview(null)} />
              </div>

              <div className="modal-body">
                {!deletePreview.ok ? (
                  <div className="alert alert-danger small mb-0">{deletePreview.error ?? "Sede non trovata."}</div>
                ) : !deletePreview.canDelete ? (
                  <>
                    <div className="alert alert-warning small mb-3">
                      <div className="fw-semibold">Non puoi eliminare <strong>{deletePreview.location?.name?.trim() || "Sede"}</strong>.</div>
                      {deletePreview.deleteBlockReason || "Sede non eliminabile in sicurezza."}
                    </div>
                    {Object.keys(deletePreview.blockingCounts ?? {}).length ? (
                      <div className="border rounded-3 p-3">
                        <div className="fw-semibold mb-2">Storico che blocca l&apos;eliminazione</div>
                        <div className="row g-2">
                          {Object.entries(deletePreview.blockingCounts ?? {}).map(([table, count]) => (
                            <div className="col-md-4" key={table}>
                              <div className="border rounded-3 p-2 small d-flex justify-content-between gap-2">
                                <span>{tableLabel(table)}</span>
                                <span className="fw-semibold">{Number(count)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="alert alert-danger small mb-3">
                      <div className="fw-semibold">Eliminazione definitiva sede: {deletePreview.location?.name?.trim() || "Sede"}</div>
                      Questa operazione elimina solo configurazioni e collegamenti della sede. Lo storico operativo/contabile e i clienti vengono preservati.
                    </div>

                    <div className="accordion mb-3" id="locationDeletePreviewAccordion">
                      <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                        <h3 className="accordion-header">
                          <button
                            className={`accordion-button bg-white shadow-none py-2${deleteSection === "direct" ? "" : " collapsed"}`}
                            type="button"
                            onClick={() => setDeleteSection("direct")}
                          >
                            <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                              <span className="fw-semibold">Configurazioni della sede eliminate</span>
                              <span className="badge rounded-pill text-bg-danger">{deleteDirectTotal}</span>
                            </span>
                          </button>
                        </h3>
                        <div className={`accordion-collapse collapse${deleteSection === "direct" ? " show" : ""}`}>
                          <div className="accordion-body py-2">
                            {Object.keys(deletePreview.directCounts ?? {}).length ? (
                              <div className="row g-2">
                                {Object.entries(deletePreview.directCounts ?? {}).map(([table, count]) => (
                                  <div className="col-md-4" key={table}>
                                    <div className="border rounded-3 p-2 small d-flex justify-content-between gap-2">
                                      <span>{tableLabel(table)}</span>
                                      <span className="fw-semibold">{Number(count)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-muted small">Nessun dato diretto associato alla sede.</div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="accordion-item border rounded-3 overflow-hidden mb-2">
                        <h3 className="accordion-header">
                          <button
                            className={`accordion-button bg-white shadow-none py-2${deleteSection === "exclusive" ? "" : " collapsed"}`}
                            type="button"
                            onClick={() => setDeleteSection("exclusive")}
                          >
                            <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                              <span className="fw-semibold">Dati globali eliminati perche esclusivi</span>
                              <span className="badge rounded-pill text-bg-danger">{deleteExclusiveTotal}</span>
                            </span>
                          </button>
                        </h3>
                        <div className={`accordion-collapse collapse${deleteSection === "exclusive" ? " show" : ""}`}>
                          <div className="accordion-body py-2">
                            {Object.keys(deletePreview.exclusive ?? {}).length ? (
                              Object.entries(deletePreview.exclusive ?? {}).map(([group, rows]) => (
                                <div className="border rounded-3 p-2 small mb-2" key={group}>
                                  <div className="d-flex justify-content-between gap-2">
                                    <span className="fw-semibold">{tableLabel(group)}</span>
                                    <span className="badge rounded-pill text-bg-light">{Array.isArray(rows) ? rows.length : Object.keys(rows ?? {}).length}</span>
                                  </div>
                                  <div className="text-muted mt-1">{(Array.isArray(rows) ? rows : Object.values(rows ?? {})).map(String).join(", ")}</div>
                                </div>
                              ))
                            ) : (
                              <div className="text-muted small">Nessun dato globale esclusivo da eliminare.</div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="accordion-item border rounded-3 overflow-hidden">
                        <h3 className="accordion-header">
                          <button
                            className={`accordion-button bg-white shadow-none py-2${deleteSection === "shared" ? "" : " collapsed"}`}
                            type="button"
                            onClick={() => setDeleteSection("shared")}
                          >
                            <span className="d-flex align-items-center justify-content-between gap-2 w-100 pe-2">
                              <span className="fw-semibold">Dati globali mantenuti perche condivisi</span>
                              <span className="badge rounded-pill text-bg-info">{deleteSharedTotal}</span>
                            </span>
                          </button>
                        </h3>
                        <div className={`accordion-collapse collapse${deleteSection === "shared" ? " show" : ""}`}>
                          <div className="accordion-body py-2">
                            {Object.keys(deletePreview.shared ?? {}).length ? (
                              Object.entries(deletePreview.shared ?? {}).map(([group, rows]) => {
                                const entries = Array.isArray(rows) ? rows.map((value, i) => [String(i), String(value)] as const) : Object.entries(rows ?? {}).map(([k, v]) => [k, String(v)] as const);
                                return (
                                  <div className="border rounded-3 p-2 small mb-2" key={group}>
                                    <div className="d-flex justify-content-between gap-2">
                                      <span className="fw-semibold">{tableLabel(group)}</span>
                                      <span className="badge rounded-pill text-bg-light">{entries.length}</span>
                                    </div>
                                    {group === "clients" ? (
                                      <div className="d-grid gap-2 mt-2">
                                        {entries.map(([clientId, clientLabel]) => {
                                          const plan = deletePreview.clientReassignments?.[clientId] ?? {};
                                          const targetName = String(plan.location_name ?? "").trim() || "sede residua";
                                          const details: string[] = [];
                                          if (Number(plan.activity_count ?? 0) > 0) details.push(`Attivita residue: ${Number(plan.activity_count)}`);
                                          if (String(plan.last_activity ?? "").trim()) details.push(`Ultima attivita: ${String(plan.last_activity).trim()}`);
                                          return (
                                            <div className="border rounded-3 bg-light p-2" key={clientId}>
                                              <div className="d-flex justify-content-between gap-2">
                                                <span className="fw-semibold">{clientLabel}</span>
                                                <span className="badge rounded-pill text-bg-info">Riassegnato a {targetName}</span>
                                              </div>
                                              {details.length ? <div className="text-muted mt-1">{details.join(" | ")}</div> : null}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ) : (
                                      <div className="text-muted mt-1">{entries.map(([, value]) => value).join(", ")}</div>
                                    )}
                                  </div>
                                );
                              })
                            ) : (
                              <div className="text-muted small">Nessun dato globale condiviso da mantenere.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="row g-3">
                      <div className="col-md-6">
                        <label className="form-label">Motivo eliminazione</label>
                        <input className="form-control" name="reason" placeholder="Es. sede chiusa definitivamente" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label">Scrivi {deletePreview.confirmText ?? "ELIMINA"} per confermare</label>
                        <input className="form-control" name="confirm_text" autoComplete="off" required value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} />
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="modal-footer">
                {deletePreview.canDelete ? (
                  <>
                    <button className="btn btn-outline-secondary btn-pill" type="button" onClick={() => setDeletePreview(null)}>Annulla</button>
                    <button className="btn btn-danger btn-pill" type="submit" disabled={busy}>Elimina sede</button>
                  </>
                ) : (
                  <button className="btn btn-outline-secondary btn-pill" type="button" onClick={() => setDeletePreview(null)}>Chiudi</button>
                )}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
