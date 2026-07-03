"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful port of the PHP package CATALOG editor (packages.php
// action=catalog_new|catalog_edit): the template header (Nome / Validità /
// Attivo) + Sedi abilitate + the dynamic Contenuto pacchetto rows (servizio/
// prodotto with quantità, prezzo listino [auto], sconto, totale riga) + the
// Sconto totale, with the computed Subtotale / Totale (= prezzo del pacchetto).
// Submits to /api/manage/packages (action=catalog_save; the content lines +
// location ids are sent as JSON strings to survive parseRequestBody).

type ServiceOpt = { id: number; name: string; price: number };
type ProductOpt = { id: number; name: string; price: number; sku: string };
type Ctx = { services: ServiceOpt[]; products: ProductOpt[]; locations: { id: number; name: string }[] };

type Row = { itemType: "service" | "product"; itemId: number; qty: number; unitPrice: number; discountType: "percent" | "amount"; discountValue: number };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "catalog_edit" ? "edit" : "new";
}
function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function emptyRow(): Row {
  return { itemType: "service", itemId: 0, qty: 1, unitPrice: 0, discountType: "percent", discountValue: 0 };
}
function lineTotal(r: Row): number {
  const sub = Math.max(1, r.qty) * Math.max(0, r.unitPrice);
  let disc = r.discountType === "amount" ? r.discountValue : sub * (r.discountValue / 100);
  disc = Math.min(Math.max(0, disc), sub);
  return Math.round((sub - disc) * 100) / 100;
}

export function PackagesCatalogFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [ctx, setCtx] = useState<Ctx>({ services: [], products: [], locations: [] });
  const [id, setId] = useState(0);
  const [name, setName] = useState("");
  const [validityDays, setValidityDays] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [locationIds, setLocationIds] = useState<number[]>([]);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [totalDiscountType, setTotalDiscountType] = useState<"percent" | "amount">("percent");
  const [totalDiscountValue, setTotalDiscountValue] = useState(0);
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
              setValidityDays(t.validityDays != null ? String(t.validityDays) : "");
              setIsActive(Boolean(t.isActive));
              setLocationIds((t.locationIds ?? []).map(Number));
              setTotalDiscountType(t.totalDiscountType === "amount" ? "amount" : "percent");
              setTotalDiscountValue(Number(t.totalDiscountValue ?? 0));
              const items: Row[] = (t.items ?? []).map((it: Record<string, unknown>) => ({
                itemType: it.itemType === "product" ? "product" : "service",
                itemId: Number(it.itemId ?? 0),
                qty: Math.max(1, Number(it.qty ?? 1)),
                unitPrice: Number(it.unitPrice ?? 0),
                discountType: it.discountType === "amount" ? "amount" : "percent",
                discountValue: Number(it.discountValue ?? 0),
              }));
              setRows(items.length > 0 ? items : [emptyRow()]);
            })
            .catch(() => setError("Errore nel caricamento del pacchetto."))
        : Promise.resolve();

    Promise.all([ctxPromise, editPromise]).finally(() => setLoading(false));
  }, [slug]);

  function backToCatalog() {
    window.location.href = `/${encodeURIComponent(slug)}/packages?tab=catalog`;
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
  function changeType(idx: number, t: "service" | "product") {
    updateRow(idx, { itemType: t, itemId: 0, unitPrice: 0 });
  }

  const subtotal = useMemo(() => Math.round(rows.reduce((s, r) => s + lineTotal(r), 0) * 100) / 100, [rows]);
  const total = useMemo(() => {
    let disc = totalDiscountType === "amount" ? totalDiscountValue : subtotal * (totalDiscountValue / 100);
    disc = Math.min(Math.max(0, disc), subtotal);
    return Math.round((subtotal - disc) * 100) / 100;
  }, [subtotal, totalDiscountType, totalDiscountValue]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (name.trim() === "") {
      setError("Nome obbligatorio.");
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
        validity_days: validityDays,
        is_active: isActive ? "1" : "0",
        total_discount_type: totalDiscountType,
        total_discount_value: String(totalDiscountValue),
        items: JSON.stringify(
          filled.map((r) => ({ item_type: r.itemType, item_id: r.itemId, qty: r.qty, unit_price: r.unitPrice, discount_type: r.discountType, discount_value: r.discountValue })),
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
        setError(String(j.error ?? "Errore nel salvataggio del pacchetto."));
        setSaving(false);
        return;
      }
      backToCatalog();
    } catch {
      setError("Errore nel salvataggio del pacchetto.");
      setSaving(false);
    }
  }

  const title = action === "new" ? "Nuovo pacchetto" : "Modifica pacchetto";

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/packages.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Catalogo pacchetti</div>
          <h1 className="bs-page-title">{title}</h1>
          <div className="bs-page-subtitle">Definisci contenuti, sedute e prezzo del pacchetto.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/packages?tab=catalog`}>
            <i className="bi bi-collection me-1" />
            Catalogo
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form className="card p-3 mb-3" onSubmit={onSubmit}>
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label">
                Nome pacchetto <span className="text-danger">*</span>
              </label>
              <input className="form-control" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. 10 sedute Laser" />
            </div>
            <div className="col-md-2">
              <label className="form-label">Validità (giorni)</label>
              <input className="form-control" type="number" min="0" step="1" value={validityDays} onChange={(e) => setValidityDays(e.target.value)} placeholder="180" />
            </div>
            <div className="col-md-2">
              <label className="form-label">Stato</label>
              <div className="form-check form-switch mt-2">
                <input className="form-check-input" type="checkbox" id="pkgActive" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                <label className="form-check-label" htmlFor="pkgActive">
                  Attivo
                </label>
              </div>
            </div>

            {ctx.locations.length > 0 ? (
              <div className="col-md-4">
                <label className="form-label">Sedi abilitate</label>
                <div className="border rounded p-2">
                  {ctx.locations.map((loc) => (
                    <div className="form-check" key={loc.id}>
                      <input className="form-check-input" type="checkbox" id={`pkgloc${loc.id}`} checked={locationIds.includes(loc.id)} onChange={(e) => toggleLocation(loc.id, e.target.checked)} />
                      <label className="form-check-label" htmlFor={`pkgloc${loc.id}`}>
                        {loc.name}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="col-12">
              <label className="form-label">
                Contenuto pacchetto <span className="text-danger">*</span>
              </label>
              <div className="border rounded p-2">
                <div className="row g-2 fw-semibold small text-muted mb-1 d-none d-md-flex">
                  <div className="col-md-2">Tipo</div>
                  <div className="col-md-3">Servizio / Prodotto</div>
                  <div className="col-md-1">Q.tà</div>
                  <div className="col-md-2">Prezzo listino</div>
                  <div className="col-md-2">Sconto</div>
                  <div className="col-md-1 text-end">Totale</div>
                  <div className="col-md-1" />
                </div>
                {rows.map((r, idx) => {
                  const opts = r.itemType === "product" ? ctx.products : ctx.services;
                  return (
                    <div className="row g-2 align-items-end mb-2" key={idx}>
                      <div className="col-md-2">
                        <select className="form-select" value={r.itemType} onChange={(e) => changeType(idx, e.target.value as "service" | "product")}>
                          <option value="service">Servizio</option>
                          <option value="product">Prodotto</option>
                        </select>
                      </div>
                      <div className="col-md-3">
                        <select className="form-select" value={r.itemId} onChange={(e) => selectItem(idx, Number(e.target.value))}>
                          <option value={0}>{r.itemType === "product" ? "Seleziona prodotto…" : "Seleziona servizio…"}</option>
                          {opts.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                              {r.itemType === "product" && (o as ProductOpt).sku ? ` (${(o as ProductOpt).sku})` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-md-1">
                        <input className="form-control" type="number" min="1" step="1" value={r.qty} onChange={(e) => updateRow(idx, { qty: Math.max(1, Number(e.target.value) || 1) })} />
                      </div>
                      <div className="col-md-2">
                        <div className="input-group">
                          <span className="input-group-text">€</span>
                          <input className="form-control" type="number" value={r.unitPrice} readOnly />
                        </div>
                      </div>
                      <div className="col-md-2">
                        <div className="input-group">
                          <input className="form-control" type="number" min="0" step="0.01" value={r.discountValue} onChange={(e) => updateRow(idx, { discountValue: Math.max(0, Number(e.target.value) || 0) })} />
                          <select className="form-select" style={{ maxWidth: "4.5rem" }} value={r.discountType} onChange={(e) => updateRow(idx, { discountType: e.target.value as "percent" | "amount" })}>
                            <option value="percent">%</option>
                            <option value="amount">€</option>
                          </select>
                        </div>
                      </div>
                      <div className="col-md-1 text-end fw-semibold">€ {fmtMoney(lineTotal(r))}</div>
                      <div className="col-md-1 text-end">
                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))} title="Rimuovi riga">
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="btn btn-sm btn-outline-secondary mt-1" onClick={() => setRows((prev) => [...prev, emptyRow()])}>
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi riga
                </button>
              </div>
            </div>

            <div className="col-md-4">
              <label className="form-label">Sconto totale</label>
              <div className="input-group">
                <input className="form-control" type="number" min="0" step="0.01" value={totalDiscountValue} onChange={(e) => setTotalDiscountValue(Math.max(0, Number(e.target.value) || 0))} />
                <select className="form-select" style={{ maxWidth: "5rem" }} value={totalDiscountType} onChange={(e) => setTotalDiscountType(e.target.value as "percent" | "amount")}>
                  <option value="percent">%</option>
                  <option value="amount">€</option>
                </select>
              </div>
            </div>
            <div className="col-md-8 d-flex align-items-end justify-content-end gap-4">
              <div className="text-end">
                <div className="text-muted small">Subtotale</div>
                <div className="fw-semibold">€ {fmtMoney(subtotal)}</div>
              </div>
              <div className="text-end">
                <div className="text-muted small">Totale (prezzo)</div>
                <div className="h4 mb-0 fw-bold">€ {fmtMoney(total)}</div>
              </div>
            </div>
          </div>

          <div className="mt-3 d-flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              {saving ? "Salvataggio…" : "Salva"}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={backToCatalog}>
              Annulla
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
