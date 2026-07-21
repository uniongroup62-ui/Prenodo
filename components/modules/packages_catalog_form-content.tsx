"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flashNavigate } from "./flash";

// Faithful port of the PHP package CATALOG editor (packages.php
// action=catalog_new|catalog_edit): Nome + Contenuto pacchetto (#pkgItemsBox
// con combobox ricercabile per riga, quantità, prezzo listino readonly, sconto
// per riga, totale riga readonly, bottoni "Aggiungi servizio"/"Aggiungi
// prodotto", totali Subtotale righe / Sconto sul totale / Totale pacchetto nel
// box) + Validità (giorni) + Stato + Sedi abilitate (tabella Sede|Vendibile) +
// Descrizione. Il prezzo del pacchetto è SEMPRE calcolato (campo readonly).
// Con action=catalog_new e nessun servizio attivo rende lo stato bloccato
// legacy "Nessun contenuto attivo disponibile" (.package-catalog-blocked).
// Submits to /api/manage/packages (action=catalog_save; righe + sedi come
// stringhe JSON per sopravvivere a parseRequestBody).

type ServiceOpt = { id: number; name: string; price: number };
type ProductOpt = { id: number; name: string; price: number; sku: string };
type Ctx = { services: ServiceOpt[]; products: ProductOpt[]; locations: { id: number; name: string }[] };

// _k: key stabile per riga (audit giro 3: key={idx} faceva migrare lo stato
// aperto/ricerca della ItemCombobox sulla riga successiva alle rimozioni).
type Row = { _k: number; itemType: "service" | "product"; itemId: number; qty: number; unitPrice: number; discountType: "percent" | "amount"; discountValue: string };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "catalog_edit" ? "edit" : "new";
}
function money2(n: number): string {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}
let rowKeySeq = 1;
function emptyRow(type: "service" | "product" = "service"): Row {
  return { _k: rowKeySeq++, itemType: type, itemId: 0, qty: 1, unitPrice: 0, discountType: "percent", discountValue: "0.00" };
}
function lineTotal(r: Row): number {
  const sub = Math.max(1, r.qty) * Math.max(0, r.unitPrice);
  const dv = Math.max(0, Number(String(r.discountValue).replace(",", ".")) || 0);
  let disc = r.discountType === "amount" ? dv : sub * (dv / 100);
  disc = Math.min(Math.max(0, disc), sub);
  return Math.round((sub - disc) * 100) / 100;
}

// Combobox ricercabile (port del markup legacy .app-combobox: bottone
// form-control con placeholder, menu dropdown con input "Cerca…" e lista).
function ItemCombobox({
  placeholder,
  options,
  value,
  onSelect,
}: {
  placeholder: string;
  options: { id: number; label: string }[];
  value: number;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value);
  const filtered = search.trim() === "" ? options : options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} ref={boxRef}>
      <button
        className="form-control text-start app-combobox-toggle dropdown-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
        }}
      >
        {selected ? (
          <span className="app-combobox-text">{selected.label}</span>
        ) : (
          <span className="app-combobox-placeholder text-muted">{placeholder}</span>
        )}
      </button>
      {open ? (
        <div className="dropdown-menu p-2 w-100 show">
          <input
            type="text"
            className="form-control form-control-sm app-combobox-search"
            placeholder="Cerca…"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="app-combobox-list mt-2" style={{ maxHeight: "12rem", overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div className="text-muted small px-2 py-1">Nessun risultato</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`dropdown-item ${o.id === value ? "active" : ""}`}
                  onClick={() => {
                    onSelect(o.id);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PackagesCatalogFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action, setAction] = useState<"new" | "edit">("new");
  // Audit giro 3: azione letta POST-MOUNT (pattern SSR-safe) — l'initializer
  // leggeva window e il titolo divergeva tra server ("Nuovo") e client (edit).
  useEffect(() => {
    setAction(resolveAction());
  }, []);
  const [ctx, setCtx] = useState<Ctx>({ services: [], products: [], locations: [] });
  const [id, setId] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [validityDays, setValidityDays] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [locationIds, setLocationIds] = useState<number[]>([]);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [totalDiscountType, setTotalDiscountType] = useState<"percent" | "amount">("percent");
  const [totalDiscountValue, setTotalDiscountValue] = useState("0.00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "catalog_edit" ? "edit" : "new";
    const editId = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=catalog_form_context`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const c: Ctx = j.context ?? { services: [], products: [], locations: [] };
        setCtx(c);
        if (act !== "edit") setLocationIds(c.locations.map((l) => l.id));
        return c;
      })
      .catch(() => setCtx({ services: [], products: [], locations: [] }));

    const editPromise =
      act === "edit" && Number.isFinite(editId) && editId > 0
        ? fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=catalog_get&id=${editId}`, { headers: { "x-tenant-slug": slug } })
            .then((r) => r.json())
            .then((j) => {
              if (!j.ok || !j.template) {
                setError(String(j.error ?? "Pacchetto non trovato."));
                return;
              }
              const t = j.template;
              setId(Number(t.id ?? editId));
              setName(String(t.name ?? ""));
              setDescription(String(t.description ?? ""));
              setValidityDays(t.validityDays != null ? String(t.validityDays) : "");
              setIsActive(Boolean(t.isActive));
              setLocationIds((t.locationIds ?? []).map(Number));
              setTotalDiscountType(t.totalDiscountType === "amount" ? "amount" : "percent");
              setTotalDiscountValue(money2(Number(t.totalDiscountValue ?? 0)));
              const items: Row[] = (t.items ?? []).map((it: Record<string, unknown>) => ({
                itemType: it.itemType === "product" ? "product" : "service",
                itemId: Number(it.itemId ?? 0),
                qty: Math.max(1, Number(it.qty ?? 1)),
                unitPrice: Number(it.unitPrice ?? 0),
                discountType: it.discountType === "amount" ? "amount" : "percent",
                discountValue: money2(Number(it.discountValue ?? 0)),
              }));
              setRows(items.length > 0 ? items.map((it: Omit<Row, "_k">) => ({ ...it, _k: rowKeySeq++ })) : [emptyRow()]);
            })
            .catch(() => setError("Errore nel caricamento del pacchetto."))
        : Promise.resolve();

    Promise.all([ctxPromise, editPromise]).finally(() => setLoading(false));
  }, [slug]);

  function href(path: string): string {
    return `/${encodeURIComponent(slug)}/${path}`;
  }
  function toggleLocation(lid: number, checked: boolean) {
    setLocationIds((prev) => (checked ? Array.from(new Set([...prev, lid])) : prev.filter((x) => x !== lid)));
  }
  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function selectItem(idx: number, itemId: number) {
    const row = rows[idx];
    const opt = row.itemType === "product" ? ctx.products.find((p) => p.id === itemId) : ctx.services.find((s) => s.id === itemId);
    updateRow(idx, { itemId, unitPrice: opt ? opt.price : 0 });
  }

  const subtotal = useMemo(() => Math.round(rows.reduce((s, r) => s + lineTotal(r), 0) * 100) / 100, [rows]);
  const total = useMemo(() => {
    const dv = Math.max(0, Number(String(totalDiscountValue).replace(",", ".")) || 0);
    let disc = totalDiscountType === "amount" ? dv : subtotal * (dv / 100);
    disc = Math.min(Math.max(0, disc), subtotal);
    return Math.round((subtotal - disc) * 100) / 100;
  }, [subtotal, totalDiscountType, totalDiscountValue]);
  // Hint legacy (#pkgItemsHint): "Sedute servizi: N • Prodotti: M".
  const sessionsHint = useMemo(() => {
    const svc = rows.filter((r) => r.itemType === "service" && r.itemId > 0).reduce((s, r) => s + Math.max(1, r.qty), 0);
    const prod = rows.filter((r) => r.itemType === "product" && r.itemId > 0).reduce((s, r) => s + Math.max(1, r.qty), 0);
    if (svc <= 0 && prod <= 0) return "";
    return `Sedute servizi: ${svc} • Prodotti: ${prod}`;
  }, [rows]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (name.trim() === "") {
      setError("Nome obbligatorio");
      return;
    }
    const filled = rows.filter((r) => r.itemId > 0);
    if (filled.length === 0) {
      setError("Aggiungi almeno un servizio/prodotto al pacchetto.");
      return;
    }
    if (!filled.some((r) => r.itemType === "service")) {
      setError("Per creare un pacchetto è necessario almeno un servizio (sedute).");
      return;
    }
    if (ctx.locations.length > 0 && locationIds.length === 0) {
      setError("Seleziona almeno una sede per il pacchetto.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        action: "catalog_save",
        id: String(id),
        name,
        description,
        validity_days: validityDays,
        is_active: isActive ? "1" : "0",
        total_discount_type: totalDiscountType,
        total_discount_value: String(Math.max(0, Number(String(totalDiscountValue).replace(",", ".")) || 0)),
        items: JSON.stringify(
          filled.map((r) => ({
            item_type: r.itemType,
            item_id: r.itemId,
            qty: r.qty,
            unit_price: r.unitPrice,
            discount_type: r.discountType,
            discount_value: Math.max(0, Number(String(r.discountValue).replace(",", ".")) || 0),
          })),
        ),
        location_ids: JSON.stringify(locationIds),
      };
      const res = await fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore salvataggio pacchetto."));
        setSaving(false);
        return;
      }
      // Redirect legacy: catalogo con flash "Pacchetto creato"/"Pacchetto aggiornato".
      flashNavigate(href("packages?tab=catalog"), { msg: action === "edit" ? "Pacchetto aggiornato" : "Pacchetto creato" });
    } catch {
      setError("Errore salvataggio pacchetto.");
      setSaving(false);
    }
  }

  // Vista bloccata legacy (packages.php 3678-3704): catalog_new senza servizi
  // attivi selezionabili.
  const blocked = !loading && action === "new" && ctx.services.length === 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti</h1>
          <div className="bs-page-subtitle">Configura catalogo, assegnazioni clienti e sedute residue.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2 flex-wrap justify-content-end">
            <a className="btn btn-outline-secondary" href={href("package_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
            <a className="btn btn-outline-secondary" href={href("packages?tab=clients")}>
              <i className="bi bi-people me-1" />
              Pacchetti clienti
            </a>
            <a className="btn btn-outline-secondary" href={href("packages?tab=catalog")}>
              <i className="bi bi-collection me-1" />
              Catalogo
            </a>
          </div>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : blocked ? (
        <section className="package-catalog-blocked" aria-live="polite">
          <div className="package-catalog-blocked__inner">
            <div className="package-catalog-blocked__icon" aria-hidden="true">
              <i className="bi bi-exclamation-lg" />
            </div>
            <h2>Nessun contenuto attivo disponibile</h2>
            <p>
              Per creare un pacchetto serve almeno un servizio attivo selezionabile nella sede corrente. I prodotti possono essere aggiunti come contenuto extra, ma non
              sostituiscono le sedute del pacchetto.
            </p>
            {ctx.products.length === 0 ? <p className="mt-2">Al momento non risultano disponibili neanche prodotti attivi da Magazzino.</p> : null}
            <div className="package-catalog-blocked__actions d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("services?action=new")}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo servizio
              </a>
              <a className="btn btn-outline-secondary" href={href("products?action=new")}>
                <i className="bi bi-box-seam me-1" />
                Nuovo prodotto
              </a>
              <a className="btn btn-outline-secondary" href={href("packages?tab=catalog")}>
                <i className="bi bi-arrow-left me-1" />
                Torna al catalogo
              </a>
            </div>
          </div>
        </section>
      ) : (
        <div className="card p-3 mb-3">
          <form onSubmit={onSubmit}>
            <input type="hidden" name="id" value={id} />
            <div className="row g-3">
              <div className="col-md-4">
                <label className="form-label">
                  Nome pacchetto <span className="text-danger">*</span>
                </label>
                <input className="form-control" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. 10 sedute Laser" />
              </div>
              <div className="col-12">
                <label className="form-label">
                  Contenuto pacchetto <span className="text-danger">*</span>
                </label>

                <div className="border rounded p-2" id="pkgItemsBox">
                  <div className="row g-2 fw-semibold small text-muted mb-1">
                    <div className="col-md-4">Servizio / Prodotto</div>
                    <div className="col-md-1">Quantità</div>
                    <div className="col-md-2">Prezzo listino</div>
                    <div className="col-md-2">Sconto</div>
                    <div className="col-md-2">Totale riga</div>
                    <div className="col-md-1" />
                  </div>

                  <div id="pkgItemsRows">
                    {rows.map((r, idx) => {
                      const opts =
                        r.itemType === "product"
                          ? ctx.products.map((p) => ({ id: p.id, label: p.sku ? `${p.name} (${p.sku})` : p.name }))
                          : ctx.services.map((s) => ({ id: s.id, label: s.name }));
                      return (
                        <div className="row g-2 align-items-end pkg-item-row mb-2" data-item-type={r.itemType} key={r._k}>
                          <div className="col-md-4">
                            <ItemCombobox
                              placeholder={r.itemType === "product" ? "Seleziona prodotto…" : "Seleziona servizio…"}
                              options={opts}
                              value={r.itemId}
                              onSelect={(itemId) => selectItem(idx, itemId)}
                            />
                          </div>
                          <div className="col-md-1">
                            <input
                              className="form-control js-pkg-qty"
                              type="number"
                              min="1"
                              step="1"
                              value={r.qty}
                              onChange={(e) => updateRow(idx, { qty: Math.max(1, Number(e.target.value) || 1) })}
                            />
                          </div>
                          <div className="col-md-2">
                            <div className="input-group">
                              <span className="input-group-text">€</span>
                              <input className="form-control js-pkg-unit-price" type="number" min="0" step="0.01" value={money2(r.unitPrice)} readOnly />
                            </div>
                          </div>
                          <div className="col-md-2">
                            <div className="input-group">
                              <select
                                className="form-select js-pkg-discount-type"
                                value={r.discountType}
                                onChange={(e) => updateRow(idx, { discountType: e.target.value as "percent" | "amount" })}
                              >
                                <option value="percent">%</option>
                                <option value="amount">€</option>
                              </select>
                              <input
                                className="form-control js-pkg-discount-value"
                                type="number"
                                min="0"
                                step="0.01"
                                value={r.discountValue}
                                onChange={(e) => updateRow(idx, { discountValue: e.target.value })}
                              />
                            </div>
                          </div>
                          <div className="col-md-2">
                            <div className="input-group">
                              <span className="input-group-text">€</span>
                              <input className="form-control js-pkg-line-total" type="number" min="0" step="0.01" value={money2(lineTotal(r))} readOnly />
                            </div>
                          </div>
                          <div className="col-md-1">
                            <button
                              type="button"
                              className="btn btn-outline-danger w-100 js-pkg-item-remove"
                              title="Rimuovi"
                              onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))}
                            >
                              <i className="bi bi-x-lg" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="d-flex flex-wrap gap-2">
                    <button type="button" className="btn btn-sm btn-outline-primary" id="pkgAddServiceBtn" onClick={() => setRows((prev) => [...prev, emptyRow("service")])}>
                      <i className="bi bi-plus-lg me-1" />
                      Aggiungi servizio
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary"
                      id="pkgAddProductBtn"
                      disabled={ctx.products.length === 0}
                      title={ctx.products.length === 0 ? "Nessun prodotto disponibile in Magazzino" : undefined}
                      onClick={() => setRows((prev) => [...prev, emptyRow("product")])}
                    >
                      <i className="bi bi-plus-lg me-1" />
                      Aggiungi prodotto
                    </button>
                  </div>

                  <div className="row g-2 align-items-end mt-3">
                    <div className="col-md-3">
                      <label className="form-label">Subtotale righe</label>
                      <div className="input-group">
                        <span className="input-group-text">€</span>
                        <input className="form-control" id="pkgSubtotal" type="number" step="0.01" value={money2(subtotal)} readOnly />
                      </div>
                    </div>
                    <div className="col-md-3">
                      <label className="form-label">Sconto sul totale</label>
                      <div className="input-group">
                        <select
                          className="form-select"
                          id="pkgTotalDiscountType"
                          value={totalDiscountType}
                          onChange={(e) => setTotalDiscountType(e.target.value as "percent" | "amount")}
                        >
                          <option value="percent">%</option>
                          <option value="amount">€</option>
                        </select>
                        <input
                          className="form-control"
                          id="pkgTotalDiscountValue"
                          type="number"
                          min="0"
                          step="0.01"
                          value={totalDiscountValue}
                          onChange={(e) => setTotalDiscountValue(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="col-md-3">
                      <label className="form-label">Totale pacchetto</label>
                      <div className="input-group">
                        <span className="input-group-text">€</span>
                        <input className="form-control" id="pkgGrandTotal" type="number" step="0.01" value={money2(total)} readOnly title="Calcolato automaticamente" />
                      </div>
                    </div>
                    <div className="col-md-3">
                      <div className="small text-muted" id="pkgItemsHint">
                        {sessionsHint}
                      </div>
                    </div>
                  </div>

                  <div className="form-text">Totale calcolato automaticamente. Puoi aggiungere servizi e prodotti, impostare quantità e applicare sconti per riga e/o sul totale.</div>
                </div>
              </div>
              <div className="col-md-3">
                <label className="form-label">Validità (giorni)</label>
                <input
                  className="form-control"
                  type="number"
                  min="0"
                  step="1"
                  name="validity_days"
                  value={validityDays}
                  onChange={(e) => setValidityDays(e.target.value)}
                  placeholder="Es. 365"
                />
                <div className="form-text">Se impostata ha priorita sulla scadenza predefinita dei pacchetti.</div>
              </div>
              <div className="col-md-2">
                <label className="form-label">Stato</label>
                <select className="form-select" name="is_active" value={isActive ? "1" : "0"} onChange={(e) => setIsActive(e.target.value === "1")}>
                  <option value="1">Attivo</option>
                  <option value="0">Disattivo</option>
                </select>
              </div>
              {ctx.locations.length > 0 ? (
                <div className="col-12">
                  <div className="fw-semibold mb-2">Sedi abilitate</div>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Sede</th>
                          <th className="text-center">Vendibile</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ctx.locations.map((loc) => (
                          <tr key={loc.id}>
                            <td className="fw-semibold">{loc.name || `Sede #${loc.id}`}</td>
                            <td className="text-center">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                checked={locationIds.includes(loc.id)}
                                onChange={(e) => toggleLocation(loc.id, e.target.checked)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
              <div className="col-12">
                <label className="form-label">Descrizione</label>
                <textarea
                  className="form-control"
                  name="description"
                  rows={3}
                  placeholder="Note interne (es. include 10 sedute)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3 d-flex gap-2">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                Salva
              </button>
              <a className="btn btn-outline-secondary" href={href("packages?tab=catalog")}>
                Annulla
              </a>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
