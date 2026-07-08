"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP cost NEW / EDIT form (app/pages/costs.php,
// tab=scadenziario action=new|edit — "Nuovo costo" / "Modifica costo"). Field
// groups and Bootstrap markup mirror the legacy editor:
//   - Titolo, Scadenza (due_date), Totale (amount)
//   - "Già pagato" switch (track_payments) + paid_amount (partial payments)
//   - Sede (location_id; only when >1 location), Categoria, Fornitore
//   - IVA % (vat_percent), Metodo pagamento, Numero/Data documento, Note
//   - Pagato (is_paid), Ricorrente (is_recurring) + ogni/unità + fine ricorrenza
// Submits to /api/manage/costs (action=save_cost; create when id=0, update with
// id). The list page links here via index.php?page=costs&tab=scadenziario&action=
// new|edit, 307-redirected to /<slug>/costs?tab=scadenziario&action=new|edit.
//
// ALLEGATO: il campo file (attachment, solo PDF o JPG max 5MB) è collegato a
// /api/manage/cost-attachment (multipart -> Cloudflare R2 PRIVATO, la key va
// in attachment_path; il download passa dal presigned della stessa route) e
// viaggia DOPO save_cost (in creazione l'id è risolto dalla lista restituita).
// "Rimuovi allegato" replica la rimozione legacy. Divergenza documentata:
// niente compressione server-side (GD per i JPG / Ghostscript per i PDF).

type CostCategory = { id: number; name: string; isActive: boolean };
type CostSupplier = { id: number; name: string };
type CostLocation = { id: number; name: string };

type CostForm = {
  id: number;
  title: string;
  due_date: string;
  amount: string;
  track_payments: boolean;
  paid_amount: string;
  location_id: number;
  category_id: number;
  supplier_id: number;
  vat_percent: string;
  payment_method: string;
  doc_number: string;
  doc_date: string;
  notes: string;
  is_paid: boolean;
  is_recurring: boolean;
  recurrence_interval: string;
  recurrence_unit: "day" | "week" | "month" | "year";
  recurrence_end_mode: "never" | "date";
  recurrence_end_date: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyForm(): CostForm {
  return {
    id: 0,
    title: "",
    due_date: todayIso(),
    amount: "0,00",
    track_payments: false,
    paid_amount: "0,00",
    location_id: 0,
    category_id: 0,
    supplier_id: 0,
    vat_percent: "",
    payment_method: "",
    doc_number: "",
    doc_date: "",
    notes: "",
    is_paid: false,
    is_recurring: false,
    recurrence_interval: "1",
    recurrence_unit: "month",
    recurrence_end_mode: "never",
    recurrence_end_date: "",
  };
}

function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

// Italian number_format($n, 2, ',', '.') — mirrors the legacy value formatting.
function fmtMoney(n: number): string {
  // number_format($n, 2, ',', '.') manuale: toLocaleString('it-IT') NON raggruppa
  // 1000-9999 (CLDR minimumGroupingDigits=2), il legacy sì ("1.234,56").
  const value = Number.isFinite(n) ? n : 0;
  const [int, dec] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

export function CostFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [form, setForm] = useState<CostForm>(emptyForm());
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [suppliers, setSuppliers] = useState<CostSupplier[]>([]);
  const [locations, setLocations] = useState<CostLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Allegato (PDF/JPG max 5MB): file scelto + nome corrente. Come il legacy,
  // il documento si può solo SOSTITUIRE caricando un nuovo file (niente rimozione).
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [currentAttachmentName, setCurrentAttachmentName] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const id = Number.parseInt(params.get("id") ?? "", 10);

    // Context (categories/suppliers/locations) for the dropdowns.
    const ctxPromise = fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        const cats: CostCategory[] = (Array.isArray(j.categories) ? j.categories : []).map(
          (c: Record<string, unknown>) => ({ id: Number(c.id ?? 0), name: String(c.name ?? ""), isActive: Boolean(c.isActive ?? true) }),
        );
        const sups: CostSupplier[] = (Array.isArray(j.suppliers) ? j.suppliers : []).map(
          (s: Record<string, unknown>) => ({ id: Number(s.id ?? 0), name: String(s.name ?? "") }),
        );
        const locs: CostLocation[] = (Array.isArray(j.locations) ? j.locations : []).map(
          (l: Record<string, unknown>) => ({ id: Number(l.id ?? 0), name: String(l.name ?? "") }),
        );
        setCategories(cats);
        setSuppliers(sups);
        setLocations(locs);
        return { locs };
      })
      .catch(() => ({ locs: [] as CostLocation[] }));

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.cost) {
            setError(String(j.error ?? "Costo non trovato."));
            return;
          }
          const c = j.cost;
          const amount = Number(c.amount ?? 0);
          const paid = Number(c.paidAmount ?? 0);
          setForm({
            id: Number(c.id ?? id),
            title: String(c.title ?? ""),
            due_date: String(c.dueDate ?? todayIso()).slice(0, 10),
            amount: fmtMoney(amount),
            track_payments: paid > 0 && paid < amount,
            paid_amount: fmtMoney(paid),
            location_id: Number(c.locationId ?? 0) || 0,
            category_id: Number(c.categoryId ?? 0) || 0,
            supplier_id: Number(c.supplierId ?? 0) || 0,
            vat_percent: c.vatPercent === null || c.vatPercent === undefined ? "" : String(c.vatPercent),
            payment_method: String(c.paymentMethod ?? ""),
            doc_number: String(c.docNumber ?? ""),
            doc_date: String(c.docDate ?? "").slice(0, 10),
            notes: String(c.notes ?? ""),
            is_paid: Boolean(c.isPaid),
            is_recurring: Boolean(c.isRecurring),
            recurrence_interval: String(c.recurrenceInterval ?? 1),
            recurrence_unit: (["day", "week", "month", "year"].includes(String(c.recurrenceUnit))
              ? String(c.recurrenceUnit)
              : "month") as CostForm["recurrence_unit"],
            recurrence_end_mode: c.recurrenceEndDate ? "date" : "never",
            recurrence_end_date: String(c.recurrenceEndDate ?? "").slice(0, 10),
          });
          setCurrentAttachmentName(String(c.attachmentName ?? "").trim());
        })
        .catch(() => setError("Errore nel caricamento del costo."))
        .finally(() => setLoading(false));
    } else {
      ctxPromise
        .then(({ locs }) => {
          // Default to the single/first location like the legacy form.
          if (locs.length) setForm((prev) => ({ ...prev, location_id: locs[0].id }));
        })
        .finally(() => setLoading(false));
    }
  }, [slug]);

  function set<K extends keyof CostForm>(key: K, value: CostForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function backToList(msg = "") {
    // Flash legacy dopo il salvataggio ("Costo creato"/"Costo aggiornato"): passato via ?msg,
    // letto dalla lista (costs.php redirect con msg=Costo%20creato).
    const q = msg ? `&msg=${encodeURIComponent(msg)}` : "";
    window.location.href = `/${encodeURIComponent(slug)}/costs?tab=scadenziario${q}`;
  }

  // Legacy: il select Sede compare quando la colonna location esiste, anche con
  // UNA sola sede (mostra la singola opzione).
  const showLocation = locations.length >= 1;

  // Port del preview "Residuo: €" di costs.js (updatePreview + fmtEUR Intl).
  const paidPreview = (() => {
    if (!form.track_payments) return "";
    const parse = (v: string) => {
      let s = String(v || "").trim().replace(/\s+/g, "");
      if (!s) return 0;
      const hasComma = s.includes(",");
      const hasDot = s.includes(".");
      if (hasComma && hasDot) s = s.replace(/\./g, "").replace(",", ".");
      else if (hasComma) s = s.replace(",", ".");
      else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    const r = Math.max(parse(form.amount) - parse(form.paid_amount), 0);
    try {
      return `Residuo: ${new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(r)}`;
    } catch {
      return `Residuo: € ${r.toFixed(2).replace(".", ",")}`;
    }
  })();

  // Active categories + the currently-selected one (faithful: a disattiva
  // category stays selectable when it's the one already attached to the cost).
  const categoryOptions = useMemo(() => {
    return categories.filter((c) => c.isActive || c.id === form.category_id);
  }, [categories, form.category_id]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Validation faithful to costs.php POST (messaggi ?err= senza punto finale).
    if (form.title.trim() === "") {
      setError("Titolo obbligatorio");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.due_date)) {
      setError("Data scadenza non valida");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        action: "save_cost",
        id: String(form.id),
        title: form.title,
        due_date: form.due_date,
        amount: form.amount,
        track_payments: form.track_payments ? "1" : "0",
        paid_amount: form.paid_amount,
        category_id: String(form.category_id || ""),
        supplier_id: String(form.supplier_id || ""),
        vat_percent: form.vat_percent,
        payment_method: form.payment_method,
        doc_number: form.doc_number,
        doc_date: form.doc_date,
        notes: form.notes,
        is_paid: form.is_paid ? "1" : "0",
        is_recurring: form.is_recurring ? "1" : "0",
        recurrence_interval: form.recurrence_interval,
        recurrence_unit: form.recurrence_unit,
        // Map the legacy recurrence_end_mode (never/date) onto the API's
        // recurrence_end_never flag + recurrence_end_date pair.
        recurrence_end_never: form.recurrence_end_mode === "never" ? "1" : "0",
        recurrence_end_date: form.recurrence_end_mode === "date" ? form.recurrence_end_date : "",
      };
      if (showLocation) payload.location_id = String(form.location_id);

      const res = await fetch(`/api/manage/costs?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del costo."));
        setSaving(false);
        return;
      }

      // ALLEGATO: dopo il save (serve l'id anche in creazione — risolto dalla
      // lista restituita: match titolo+scadenza, id più alto). Il costo è GIÀ
      // salvato: un errore allegato resta sul form con il messaggio.
      if (attachmentFile) {
        let costId = form.id;
        if (costId <= 0) {
          type SavedCost = { id: number; title: string; dueDate: string };
          const list: SavedCost[] = Array.isArray(j.costs) ? j.costs : [];
          costId = list
            .filter((c) => String(c.title).trim() === form.title.trim() && String(c.dueDate ?? "").slice(0, 10) === form.due_date)
            .reduce((max, c) => Math.max(max, Number(c.id) || 0), 0);
        }
        if (costId > 0) {
          const fd = new FormData();
          fd.set("cost_id", String(costId));
          fd.set("attachment", attachmentFile);
          const attachRes = await fetch(`/api/manage/cost-attachment?slug=${encodeURIComponent(slug)}`, {
            method: "POST",
            headers: { "x-tenant-slug": slug },
            body: fd,
          });
          const attachJson = await attachRes.json().catch(() => ({}));
          if (!attachRes.ok || attachJson.ok === false) {
            setError(`Costo salvato, ma l'allegato non è stato aggiornato: ${String(attachJson.error ?? "errore caricamento allegato.")}`);
            setSaving(false);
            return;
          }
        } else {
          setError("Costo salvato, ma l'allegato non è stato caricato (costo non identificato). Riapri il costo e ricarica il file.");
          setSaving(false);
          return;
        }
      }

      backToList(form.id > 0 ? "Costo aggiornato" : "Costo creato");
    } catch {
      setError("Errore nel salvataggio del costo.");
      setSaving(false);
    }
  }

  const title = form.id > 0 ? "Modifica costo" : "Nuovo costo";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/costs.css" />

      {/* Header IDENTICO alla lista: il legacy in edit non cambia titolo pagina
          né aggiunge azioni (le header actions restano vuote con $editCost). */}
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Amministrazione</div>
          <h1 className="bs-page-title">Scadenziario e Costi</h1>
          <div className="bs-page-subtitle">Gestisci scadenze, costi e categorie operative.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2" />
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <ul className="nav nav-tabs costs-tabs mb-3">
        <li className="nav-item">
          <a className="nav-link active" href={`/${encodeURIComponent(slug)}/costs?tab=scadenziario`}>
            <i className="bi bi-calendar2-check me-1" />
            Scadenziario
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link " href={`/${encodeURIComponent(slug)}/costs?tab=categories`}>
            <i className="bi bi-tags me-1" />
            Categorie
          </a>
        </li>
      </ul>

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <div className="card p-4 mb-3">
          <div className="fw-semibold mb-2">{title}</div>
          <form method="post" onSubmit={onSubmit}>
            <input type="hidden" name="action" value="save_cost" />
            <input type="hidden" name="id" value={form.id} />

            <div className="row g-3">
              <div className="col-md-5">
                <label className="form-label">Titolo</label>
                <input className="form-control" name="title" required value={form.title} onChange={(e) => set("title", e.target.value)} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Scadenza</label>
                <input className="form-control" type="date" name="due_date" required value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Totale</label>
                <input className="form-control" name="amount" required value={form.amount} onChange={(e) => set("amount", e.target.value)} />
              </div>

              <div className="col-md-3">
                <label className="form-label d-flex justify-content-between align-items-center">
                  <span>Già pagato (opz.)</span>
                  <span className="form-check form-switch m-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      name="track_payments"
                      id="track_payments"
                      checked={form.track_payments}
                      onChange={(e) => set("track_payments", e.target.checked)}
                    />
                  </span>
                </label>
                <input
                  className="form-control"
                  name="paid_amount"
                  id="paid_amount"
                  value={form.paid_amount}
                  disabled={!form.track_payments}
                  onChange={(e) => set("paid_amount", e.target.value)}
                  placeholder="es. 50,00"
                />
                <div className="form-text">Inserisci quanto hai già pagato (utile per pagamenti parziali o a rate).</div>
                <div className="small text-muted" id="paid_remaining_preview">{paidPreview}</div>
              </div>

              {showLocation ? (
                <div className="col-md-4">
                  <label className="form-label">Sede</label>
                  <select
                    className="form-select"
                    name="location_id"
                    required
                    value={form.location_id}
                    onChange={(e) => set("location_id", Number(e.target.value) || 0)}
                  >
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name || `Sede #${loc.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="col-md-4">
                <label className="form-label">Categoria</label>
                <select className="form-select" name="category_id" value={form.category_id} onChange={(e) => set("category_id", Number(e.target.value) || 0)}>
                  <option value={0}>(nessuna)</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.isActive ? c.name : `${c.name} (disattiva)`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-md-4">
                <label className="form-label">Fornitore</label>
                <select className="form-select" name="supplier_id" value={form.supplier_id} onChange={(e) => set("supplier_id", Number(e.target.value) || 0)}>
                  <option value={0}>(nessuno)</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-md-4">
                <label className="form-label">IVA % (opz.)</label>
                <input className="form-control" name="vat_percent" value={form.vat_percent} onChange={(e) => set("vat_percent", e.target.value)} placeholder="es. 22" />
              </div>

              <div className="col-md-4">
                <label className="form-label">Metodo pagamento (opz.)</label>
                <input className="form-control" name="payment_method" value={form.payment_method} onChange={(e) => set("payment_method", e.target.value)} placeholder="es. Bonifico" />
              </div>

              <div className="col-md-4">
                <label className="form-label">Numero documento (opz.)</label>
                <input className="form-control" name="doc_number" value={form.doc_number} onChange={(e) => set("doc_number", e.target.value)} />
              </div>
              <div className="col-md-4">
                <label className="form-label">Data documento (opz.)</label>
                <input className="form-control" type="date" name="doc_date" value={form.doc_date} onChange={(e) => set("doc_date", e.target.value)} />
              </div>

              <div className="col-12">
                <label className="form-label">Note (opz.)</label>
                <textarea className="form-control" name="notes" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
              </div>

              {/* Allegato documento (port del campo attachment di costs.php):
                  PDF o JPG max 5MB su R2 privato; download presigned. Testi
                  VERBATIM legacy (la compressione server-side non è portata —
                  divergenza documentata — ma il testo resta identico). */}
              <div className="col-md-12">
                <label className="form-label">Carica documento (PDF o JPG, max 5MB)</label>
                <input
                  className="form-control"
                  type="file"
                  name="attachment"
                  accept="application/pdf,image/jpeg"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    if (file && file.size > 5242880) {
                      setError("File troppo grande (max 5 MB)");
                      e.target.value = "";
                      setAttachmentFile(null);
                      return;
                    }
                    setError("");
                    setAttachmentFile(file);
                  }}
                />
                <div className="form-text">Il file verrà salvato e compresso (JPG sempre, PDF best-effort).</div>
                {currentAttachmentName && form.id > 0 ? (
                  <div className="small mt-1">
                    Documento attuale:{" "}
                    <a
                      href={`/api/manage/cost-attachment?slug=${encodeURIComponent(slug)}&id=${form.id}`}
                      target="_blank"
                      rel="noopener"
                    >
                      <i className="bi bi-paperclip me-1" />
                      {currentAttachmentName}
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="col-md-3">
                <label className="form-label">Pagato</label>
                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="is_paid"
                    id="is_paid"
                    checked={form.is_paid}
                    onChange={(e) => {
                      // costs.js: spuntando Pagato con il tracking attivo, il
                      // campo "Già pagato" viene riempito col totale.
                      const checked = e.target.checked;
                      setForm((prev) => ({
                        ...prev,
                        is_paid: checked,
                        paid_amount: checked && prev.track_payments ? prev.amount : prev.paid_amount,
                      }));
                    }}
                  />
                  <label className="form-check-label" htmlFor="is_paid">Segna come pagato</label>
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Ricorrente</label>
                <div className="form-check mt-2">
                  <input className="form-check-input" type="checkbox" name="is_recurring" id="is_recurring" checked={form.is_recurring} onChange={(e) => set("is_recurring", e.target.checked)} />
                  <label className="form-check-label" htmlFor="is_recurring">Costo ricorrente</label>
                </div>
              </div>

              {form.is_recurring ? (
                <>
                  <div className="col-md-2 rec-fields">
                    <label className="form-label">Ogni</label>
                    <input
                      className="form-control"
                      type="number"
                      min={1}
                      name="recurrence_interval"
                      value={form.recurrence_interval}
                      onChange={(e) => set("recurrence_interval", e.target.value)}
                    />
                  </div>
                  <div className="col-md-2 rec-fields">
                    <label className="form-label">Unità</label>
                    <select
                      className="form-select"
                      name="recurrence_unit"
                      value={form.recurrence_unit}
                      onChange={(e) => set("recurrence_unit", e.target.value as CostForm["recurrence_unit"])}
                    >
                      <option value="day">giorno/i</option>
                      <option value="week">settimana/e</option>
                      <option value="month">mese/i</option>
                      <option value="year">anno/i</option>
                    </select>
                  </div>
                  <div className="col-md-5 rec-fields">
                    <label className="form-label">Fine ricorrenza (opz.)</label>
                    <select
                      className="form-select mb-2"
                      name="recurrence_end_mode"
                      id="recurrence_end_mode"
                      value={form.recurrence_end_mode}
                      onChange={(e) => set("recurrence_end_mode", e.target.value as CostForm["recurrence_end_mode"])}
                    >
                      <option value="never">Mai</option>
                      <option value="date">Data specifica</option>
                    </select>
                    {/* costs.js syncEndMode: con "Mai" il wrap della data è NASCOSTO
                        (display:none), non solo disabilitato. */}
                    <div id="recurrence_end_date_wrap" style={form.recurrence_end_mode === "never" ? { display: "none" } : undefined}>
                      <input
                        className="form-control"
                        type="date"
                        name="recurrence_end_date"
                        id="recurrence_end_date"
                        value={form.recurrence_end_date}
                        disabled={form.recurrence_end_mode === "never"}
                        onChange={(e) => set("recurrence_end_date", e.target.value)}
                      />
                    </div>
                    <div className="form-text">Seleziona <strong>Mai</strong> per lasciare la ricorrenza senza scadenza finale.</div>
                  </div>
                </>
              ) : null}
            </div>

            <hr className="my-3" />
            <div className="d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/costs?tab=scadenziario`}>
                Annulla
              </a>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
