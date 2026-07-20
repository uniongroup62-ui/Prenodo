"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the PHP stock_moves NEW document operation form
// (app/pages/stock_moves.php, action=new — "Nuovo carico / scarico"). This is
// the magazzino MOVEMENT transaction form (a stock_docs header + N stock_doc_items
// rows), NOT a per-row CRUD editor. Markup mirrors the legacy form:
//   - Data (auto), Operatore (auto, readonly)
//   - Causale (cause: carico/scarico), Documento (document_type: DDT/Fattura/—)
//   - Numero / Data documento, Note
//   - "Aggiungi prodotti": combobox + qty + Aggiungi → repeatable righe table
//   - For CARICO rows: optional "Prodotto in arrivo" flag + q.tà + data stimata
// Submits to /api/manage/products (action=move_stock) with items_json, which
// inserts the stock_docs + stock_doc_items and adjusts product stock/incoming.
//
// L'allegato documento (PDF/JPG, max 5 MB come stock_moves.php) viene caricato
// DOPO il salvataggio su /api/manage/stock-doc-attachment usando lo stockDocId
// tornato dalla move; un errore di upload non annulla il movimento (parita'
// col legacy, dove il documento e' gia' inserito quando l'upload fallisce).

type ProductLite = { id: number; name: string; sku: string; supplier: string };

type Row = {
  productId: number;
  name: string;
  sku: string;
  qty: number;
  incomingFlag: boolean;
  incomingQty: number;
  incomingEta: string;
};

type ProductsContext = {
  activeLocationId?: number;
  products?: Array<{ id: number; name: string; sku?: string; supplierName?: string }>;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function todayDisplay(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export function StockMoveFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [activeLocationId, setActiveLocationId] = useState(0);
  const [operatorName, setOperatorName] = useState("Operatore");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Header fields
  const [cause, setCause] = useState<"carico" | "scarico">("carico");
  const [documentType, setDocumentType] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [notes, setNotes] = useState("");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);

  // Product line repeater state
  const [rows, setRows] = useState<Row[]>([]);
  const [pickProductId, setPickProductId] = useState(0);
  const [pickQty, setPickQty] = useState(1);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickSearch, setPickSearch] = useState("");
  const pickRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loc = params.get("location_id");
    const url = new URLSearchParams({ slug });
    if (loc) url.set("location_id", loc);
    fetch(`/api/manage/products?${url.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ProductsContext & { operatorName?: string; userName?: string }) => {
        setProducts(
          (Array.isArray(j.products) ? j.products : []).map((p) => ({
            id: Number(p.id),
            name: String(p.name ?? ""),
            sku: p.sku ? String(p.sku) : "",
            supplier: p.supplierName ? String(p.supplierName) : "",
          })),
        );
        setActiveLocationId(Number(j.activeLocationId ?? (loc ? Number(loc) : 0)) || 0);
        if (j.operatorName || j.userName) setOperatorName(String(j.operatorName ?? j.userName));
      })
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPickOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const isScarico = cause === "scarico";

  const pickFiltered = useMemo(() => {
    const needle = pickSearch.trim().toLowerCase();
    if (!needle) return products;
    return products.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle));
  }, [products, pickSearch]);

  const pickSelected = products.find((p) => p.id === pickProductId);

  function addRow() {
    setError("");
    if (pickProductId <= 0) {
      setError("Seleziona un prodotto da aggiungere.");
      return;
    }
    const product = products.find((p) => p.id === pickProductId);
    if (!product) return;
    setRows((prev) => {
      // Merge into an existing row for the same product (faithful to the legacy
      // per-product aggregation in normalizeStockItems).
      const existing = prev.find((r) => r.productId === pickProductId);
      if (existing) {
        return prev.map((r) => (r.productId === pickProductId ? { ...r, qty: r.qty + Math.max(0, pickQty) } : r));
      }
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          qty: Math.max(0, pickQty),
          incomingFlag: false,
          incomingQty: 0,
          incomingEta: "",
        },
      ];
    });
    setPickProductId(0);
    setPickQty(1);
    setPickSearch("");
  }

  function setRow(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/stock_moves`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (cause !== "carico" && cause !== "scarico") {
      setError("Causale non valida");
      return;
    }
    if (rows.length === 0) {
      setError("Aggiungi almeno un prodotto");
      return;
    }
    // Validazioni riga verbatim legacy (querystring ?err=...).
    for (const r of rows) {
      const incoming = !isScarico && r.incomingFlag;
      if (r.qty <= 0 && !incoming) {
        setError("Inserisci la quantita per tutte le righe");
        return;
      }
      if (incoming && r.incomingQty <= 0) {
        setError("Inserisci la quantita in arrivo per tutte le righe se spuntato");
        return;
      }
      if (incoming && !r.incomingEta) {
        setError("Inserisci la data stimata di arrivo per tutte le righe se spuntato");
        return;
      }
    }

    setSaving(true);
    try {
      const itemsJson = rows.map((r) => ({
        product_id: r.productId,
        qty: r.qty,
        incoming_flag: !isScarico && r.incomingFlag ? 1 : 0,
        incoming_qty: !isScarico && r.incomingFlag ? r.incomingQty : 0,
        incoming_eta: !isScarico && r.incomingFlag ? r.incomingEta : "",
      }));
      const payload: Record<string, unknown> = {
        action: "move_stock",
        cause,
        document_type: documentType,
        document_number: documentNumber,
        document_date: documentDate,
        notes,
        items_json: JSON.stringify(itemsJson),
      };
      if (activeLocationId > 0) payload.location_id = String(activeLocationId);

      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) {
        setError(String(j.error ?? "Errore nel salvataggio del movimento."));
        setSaving(false);
        return;
      }
      // Allegato documento (facoltativo): upload separato col doc id appena creato.
      const stockDocId = Number(j.stockDocId ?? 0);
      if (attachmentFile && stockDocId > 0) {
        const fd = new FormData();
        fd.set("stock_doc_id", String(stockDocId));
        fd.set("attachment", attachmentFile);
        const up = await fetch(`/api/manage/stock-doc-attachment?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "x-tenant-slug": slug },
          body: fd,
        });
        const uj = await up.json().catch(() => ({}));
        if (!up.ok || uj.ok === false) {
          // Movimento gia' registrato: segnala solo l'errore allegato (come il legacy).
          setError(`Movimento salvato, ma allegato non caricato: ${String(uj.error ?? "errore upload")}`);
          setSaving(false);
          return;
        }
      }
      // Legacy: redirect a ?action=view&id=<doc>&msg=Movimento salvato.
      if (stockDocId > 0) {
        window.location.href = `/${encodeURIComponent(slug)}/stock_moves?action=view&id=${stockDocId}&msg=${encodeURIComponent("Movimento salvato")}`;
      } else {
        backToList();
      }
    } catch {
      setError("Errore nel salvataggio del movimento.");
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/stock_moves.css" />

        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Magazzino</div>
            <h1 className="bs-page-title">Nuovo carico / scarico</h1>
            <div className="bs-page-subtitle">Registra movimenti di magazzino e rettifiche prodotto.</div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/products`}>
                Torna al magazzino
              </a>
              <a className="btn btn-primary" href={`/${encodeURIComponent(slug)}/stock_moves?action=new${activeLocationId > 0 ? `&location_id=${activeLocationId}` : ""}`}>
                Nuovo carico / scarico
              </a>
            </div>
          </div>
        </div>

        {error ? <div className="alert alert-danger">{error}</div> : null}

        {loading ? (
          <div className="card p-3 text-muted small">Caricamento…</div>
        ) : (
          <div className="card p-3 mb-3">
            <div className="d-flex justify-content-end align-items-center">
              <a className="btn btn-sm btn-outline-secondary" href={`/${encodeURIComponent(slug)}/stock_moves`}>
                Torna alla lista
              </a>
            </div>
            <hr className="my-3" />

            <form method="post" id="stockDocForm" onSubmit={onSubmit}>
              <div className="row g-3">
                <div className="col-md-3">
                  <label className="form-label">Data</label>
                  <input className="form-control" value={todayDisplay()} disabled />
                  <div className="form-text">Compilata automaticamente.</div>
                </div>
                <div className="col-md-3">
                  <label className="form-label">Operatore</label>
                  <input className="form-control" value={operatorName} disabled />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Causale</label>
                  <select
                    className="form-select"
                    name="cause"
                    id="causeSelect"
                    required
                    value={cause}
                    onChange={(e) => setCause(e.target.value === "scarico" ? "scarico" : "carico")}
                  >
                    <option value="carico">Carico</option>
                    <option value="scarico">Scarico</option>
                  </select>
                </div>
                <div className="col-md-3">
                  <label className="form-label">Documento</label>
                  <select className="form-select" name="document_type" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                    <option value="">— Nessuno —</option>
                    <option value="DDT">DDT</option>
                    <option value="Fattura">Fattura</option>
                  </select>
                </div>

                <div className="col-md-5">
                  <label className="form-label">Numero documento</label>
                  <input className="form-control" name="document_number" placeholder="Es. 123/2025" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} />
                </div>
                <div className="col-md-4">
                  <label className="form-label">Data documento</label>
                  <input className="form-control" type="date" name="document_date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
                </div>

                <div className="col-12">
                  <label className="form-label">Note</label>
                  <textarea className="form-control" name="notes" rows={3} placeholder="Note interne (opzionale)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>

                <div className="col-12">
                  <div className="border rounded-3 p-3">
                    <div className="fw-semibold mb-2">Aggiungi prodotti</div>
                    <div className="row g-2 align-items-end">
                      <div className="col-md-8">
                        <label className="form-label">Prodotto</label>
                        <div className={`dropdown app-combobox js-product-box${pickOpen ? " show" : ""}`} ref={pickRef}>
                          <button
                            className={`form-control text-start app-combobox-toggle dropdown-toggle${pickOpen ? " show" : ""}`}
                            type="button"
                            aria-expanded={pickOpen ? "true" : "false"}
                            onClick={() => setPickOpen((v) => !v)}
                          >
                            <span className="app-combobox-text">{pickSelected ? (pickSelected.sku ? `${pickSelected.name} (${pickSelected.sku})` : pickSelected.name) : ""}</span>
                            {pickSelected ? null : (
                              <span className="app-combobox-placeholder text-muted">Cerca prodotto per nome o codice prodotto…</span>
                            )}
                          </button>
                          <div className={`dropdown-menu p-2 w-100 app-combobox-menu${pickOpen ? " show" : ""}`}>
                            <input
                              type="text"
                              className="form-control form-control-sm app-combobox-search"
                              placeholder="Cerca…"
                              autoComplete="off"
                              value={pickSearch}
                              onChange={(e) => setPickSearch(e.target.value)}
                            />
                            <div className="list-group mt-2 app-combobox-list">
                              {pickFiltered.map((p) => (
                                <button
                                  type="button"
                                  key={p.id}
                                  className={`list-group-item list-group-item-action${p.id === pickProductId ? " active" : ""}`}
                                  onClick={() => {
                                    setPickProductId(p.id);
                                    setPickOpen(false);
                                    setPickSearch("");
                                  }}
                                >
                                  {p.sku ? `${p.name} (${p.sku})` : p.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="col-md-4">
                        <label className="form-label">Quantità</label>
                        <div className="input-group">
                          <input
                            className="form-control"
                            type="number"
                            id="addQty"
                            min={0}
                            value={pickQty}
                            onChange={(e) => setPickQty(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                          />
                          <button className="btn btn-primary" type="button" id="addItemBtn" onClick={addRow}>
                            Aggiungi
                          </button>
                        </div>
                      </div>
                    </div>
                    {/* helper FUORI dalla row: dentro la colonna, con
                        align-items-end, disallineava Prodotto e Quantità */}
                    <div className="form-text mt-2">Aggiunge una riga al documento.</div>
                  </div>
                </div>

                <div className="col-12">
                  <div className="fw-semibold mb-2">Righe prodotto</div>
                  <div className="table-responsive border rounded-3">
                    <table className="table mb-0 align-middle" id="itemsTable">
                      <thead>
                        <tr id="itemsHeadRow">
                          <th>Prodotto</th>
                          <th>Codice prodotto</th>
                          <th className="text-end stock-moves-col-qty">Quantità</th>
                          {!isScarico ? (
                            <>
                              <th className="stock-moves-col-incoming-product">Prodotto in arrivo</th>
                              <th className="stock-moves-col-incoming-qty">Q.tà in arrivo</th>
                              <th className="stock-moves-col-incoming-date">Data stimata</th>
                            </>
                          ) : null}
                          <th className="text-end stock-moves-col-actions">Azioni</th>
                        </tr>
                      </thead>
                      <tbody id="itemsBody">
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={isScarico ? 4 : 7} className="text-muted p-3">
                              Nessun prodotto aggiunto.
                            </td>
                          </tr>
                        ) : (
                          rows.map((r, index) => (
                            <tr key={r.productId}>
                              <td className="fw-semibold">{r.sku ? `${r.name} (${r.sku})` : r.name}</td>
                              <td className="text-muted">{r.sku || "—"}</td>
                              <td className="text-end stock-moves-col-qty">
                                <input
                                  className="form-control form-control-sm text-end"
                                  type="number"
                                  min={0}
                                  value={r.qty}
                                  onChange={(e) => setRow(index, { qty: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
                                />
                              </td>
                              {!isScarico ? (
                                <>
                                  <td className="stock-moves-col-incoming-product">
                                    <div className="form-check">
                                      <input
                                        className="form-check-input"
                                        type="checkbox"
                                        id={`inc_${index}`}
                                        checked={r.incomingFlag}
                                        onChange={(e) => setRow(index, { incomingFlag: e.target.checked })}
                                      />
                                      <label className="form-check-label" htmlFor={`inc_${index}`}>Prodotto in arrivo</label>
                                    </div>
                                  </td>
                                  <td className="stock-moves-col-incoming-qty">
                                    <input
                                      className="form-control form-control-sm"
                                      type="number"
                                      min={1}
                                      placeholder="Es. 24"
                                      disabled={!r.incomingFlag}
                                      value={r.incomingQty || ""}
                                      onChange={(e) => setRow(index, { incomingQty: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
                                    />
                                  </td>
                                  <td className="stock-moves-col-incoming-date">
                                    <input
                                      className="form-control form-control-sm"
                                      type="date"
                                      disabled={!r.incomingFlag}
                                      value={r.incomingEta}
                                      onChange={(e) => setRow(index, { incomingEta: e.target.value })}
                                    />
                                  </td>
                                </>
                              ) : null}
                              <td className="text-end stock-moves-col-actions">
                                <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeRow(index)}>
                                  Rimuovi
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="form-text" id="itemsHint">
                    Le righe gestiscono quantità e, per i carichi, anche il prodotto in arrivo.
                  </div>
                </div>

                <div className="col-md-12">
                  <label className="form-label">Carica documento (PDF o JPG, max 5MB)</label>
                  <input
                    className="form-control"
                    type="file"
                    name="attachment"
                    accept="application/pdf,image/jpeg"
                    onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="form-text">Il file verrà salvato e compresso (JPG sempre, PDF best-effort).</div>
                </div>
              </div>

              <div className="mt-3 d-flex gap-2">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  <i className="bi bi-check2-circle me-1" />
                  Salva
                </button>
                <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/stock_moves`}>
                  Annulla
                </a>
              </div>
            </form>
          </div>
        )}
    </div>
  );
}
