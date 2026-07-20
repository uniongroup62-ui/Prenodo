"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InfoBox from "./info-box";

// Faithful port of the PHP stock_moves page (app/pages/stock_moves.php): LISTA
// documenti (filtri con combobox Prodotto/Fornitore, paginazione 10 per pagina,
// export CSV server-side, colonna Prodotti = CONTEGGIO righe, azione solo
// "Apri"), vista DETTAGLIO (?action=view&id=) come pagina dedicata con
// "Annulla movimento" (conferma verbatim) e vista STAMPA (?action=print&id=)
// con window.print() automatico. Query GET legacy inoltrata dal router.

type StockItem = {
  id: number;
  productId: number;
  productName: string;
  productSku: string;
  qty: number;
  incomingFlag?: boolean;
  incomingQty?: number;
  incomingEta?: string;
};

type StockDocument = {
  id: number;
  moveDate: string;
  cause: "carico" | "scarico";
  operatorName: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  notes: string;
  locationId: number | null;
  isCanceled: boolean;
  createdAt: string;
  canceledAt: string;
  canceledByName: string;
  attachmentName?: string;
  items: StockItem[];
};

type ProductsContext = {
  activeLocationId?: number;
  categories?: Array<{ id: number; name: string }>;
  products?: Array<{ id: number; name: string; sku?: string; internalCode?: string; supplierName?: string; categoryId?: number | null }>;
  stockDocuments?: StockDocument[];
};

export type StockMovesQuery = {
  action?: string;
  id?: string;
  product_id?: string;
  sku?: string;
  internal_code?: string;
  category_id?: string;
  document_number?: string;
  supplier?: string;
  date?: string;
  include_canceled?: string;
  p?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  const raw = String(iso ?? "").slice(0, 10);
  if (!raw) return "—";
  const [y, m, day] = raw.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

// product_display_name legacy: "Nome (SKU)".
function displayName(name: string, sku: string): string {
  const label = (name || "").trim() || "—";
  const code = (sku || "").trim();
  return code ? `${label} (${code})` : label;
}

type Filters = {
  productId: number;
  sku: string;
  internalCode: string;
  categoryId: number;
  documentNumber: string;
  supplier: string;
  date: string;
  includeCanceled: boolean;
};

function filtersFromQuery(q: StockMovesQuery): Filters {
  let supplier = String(q.supplier ?? "").trim();
  if (supplier === "0") supplier = "";
  return {
    productId: Number.parseInt(String(q.product_id ?? "0"), 10) || 0,
    sku: String(q.sku ?? "").trim(),
    internalCode: String(q.internal_code ?? "").trim(),
    categoryId: Number.parseInt(String(q.category_id ?? "0"), 10) || 0,
    documentNumber: String(q.document_number ?? "").trim(),
    supplier,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(q.date ?? "")) ? String(q.date) : "",
    includeCanceled: String(q.include_canceled ?? "") === "1",
  };
}

const PER_PAGE = 10;

export function StockMovesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: StockMovesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [initial] = useState(() => ({
    filters: filtersFromQuery(initialQuery ?? {}),
    view: initialQuery?.action === "view" || initialQuery?.action === "print" ? Number.parseInt(String(initialQuery?.id ?? "0"), 10) || 0 : 0,
    print: initialQuery?.action === "print",
    page: Math.max(1, Number.parseInt(String(initialQuery?.p ?? "1"), 10) || 1),
  }));

  const [ctx, setCtx] = useState<ProductsContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Vista corrente: 0 = lista, >0 = dettaglio (o stampa) del documento.
  const [viewId, setViewId] = useState(initial.view);
  const [printMode, setPrintMode] = useState(initial.print);
  const [pageNum, setPageNum] = useState(initial.page);

  // Draft filtri (form GET legacy) + applicati.
  const [productId, setProductId] = useState(initial.filters.productId);
  const [categoryId, setCategoryId] = useState(initial.filters.categoryId);
  const [supplier, setSupplier] = useState(initial.filters.supplier);
  const [sku, setSku] = useState(initial.filters.sku);
  const [internalCode, setInternalCode] = useState(initial.filters.internalCode);
  const [documentNumber, setDocumentNumber] = useState(initial.filters.documentNumber);
  const [date, setDate] = useState(initial.filters.date);
  const [includeCanceled, setIncludeCanceled] = useState(initial.filters.includeCanceled);
  const [applied, setApplied] = useState<Filters>(initial.filters);

  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const fetchData = useCallback(() => {
    const params = new URLSearchParams({ slug });
    fetch(`/api/manage/products?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ProductsContext) => setCtx(j))
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeLocationId = ctx?.activeLocationId ?? 0;
  const docs: StockDocument[] = useMemo(() => ctx?.stockDocuments ?? [], [ctx]);
  const products = useMemo(
    () => (ctx?.products ?? []).map((p) => ({
      id: Number(p.id),
      name: String(p.name ?? ""),
      sku: String(p.sku ?? ""),
      internalCode: String(p.internalCode ?? ""),
      supplierName: String(p.supplierName ?? "").trim(),
      categoryId: Number(p.categoryId ?? 0) || 0,
    })),
    [ctx],
  );
  const categories = useMemo(() => (ctx?.categories ?? []).map((c) => ({ id: Number(c.id), name: String(c.name ?? "") })), [ctx]);
  const productMeta = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Fornitori del combobox: DISTINCT dai prodotti (legacy $filterSuppliers).
  const supplierNames = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if (p.supplierName) set.add(p.supplierName);
    return [...set].sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base" }));
  }, [products]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`stock_moves${suffix}`.replace("&", "?")}`;
  }

  const syncUrl = useCallback((filters: Filters, page: number, view: number, print: boolean) => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams();
    if (view > 0) {
      sp.set("action", print ? "print" : "view");
      sp.set("id", String(view));
    } else {
      if (activeLocationId > 0) sp.set("location_id", String(activeLocationId));
      if (filters.productId > 0) sp.set("product_id", String(filters.productId));
      if (filters.sku) sp.set("sku", filters.sku);
      if (filters.internalCode) sp.set("internal_code", filters.internalCode);
      if (filters.categoryId > 0) sp.set("category_id", String(filters.categoryId));
      if (filters.date) sp.set("date", filters.date);
      if (filters.includeCanceled) sp.set("include_canceled", "1");
      if (filters.documentNumber) sp.set("document_number", filters.documentNumber);
      if (filters.supplier) sp.set("supplier", filters.supplier);
      if (page > 1) sp.set("p", String(page));
    }
    window.history.replaceState(null, "", `${window.location.pathname}${sp.size ? `?${sp.toString()}` : ""}`);
  }, [activeLocationId]);

  function applyFilters() {
    const next: Filters = { productId, categoryId, supplier, sku, internalCode, documentNumber, date, includeCanceled };
    setApplied(next);
    setPageNum(1);
    syncUrl(next, 1, 0, false);
  }

  function openView(id: number, print = false) {
    setFlash("");
    setError("");
    setViewId(id);
    setPrintMode(print);
    syncUrl(applied, pageNum, id, print);
  }

  function backToList() {
    setViewId(0);
    setPrintMode(false);
    syncUrl(applied, pageNum, 0, false);
  }

  // Annulla documento (storno) — conferma e flash verbatim legacy.
  async function cancelDoc(doc: StockDocument) {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm("Confermi annullamento del movimento? Verrà applicato lo storno sulla giacenza.")) return;
    setFlash("");
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/products?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "stock_doc_cancel", id: doc.id }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) {
        setError(String(j.error ?? "Errore"));
        return;
      }
      setFlash(doc.isCanceled ? "Documento già annullato" : "Documento annullato (con storno)");
      fetchData();
    } catch {
      setError("Errore di rete.");
    } finally {
      setBusy(false);
    }
  }

  // Filtro legacy client-side (i documenti in context coprono la sede corrente).
  const filteredDocs = useMemo(() => {
    return docs.filter((d) => {
      if (!applied.includeCanceled && d.isCanceled) return false;
      if (applied.date && String(d.moveDate ?? "").slice(0, 10) !== applied.date) return false;
      if (applied.productId && !d.items.some((it) => it.productId === applied.productId)) return false;
      if (applied.sku) {
        const needle = applied.sku.toLowerCase();
        if (!d.items.some((it) => (it.productSku ?? "").toLowerCase().includes(needle))) return false;
      }
      if (applied.internalCode) {
        const needle = applied.internalCode.toLowerCase();
        if (!d.items.some((it) => (productMeta.get(it.productId)?.internalCode ?? "").toLowerCase().includes(needle))) return false;
      }
      if (applied.categoryId) {
        if (!d.items.some((it) => (productMeta.get(it.productId)?.categoryId ?? 0) === applied.categoryId)) return false;
      }
      if (applied.documentNumber) {
        if (!(d.documentNumber ?? "").toLowerCase().includes(applied.documentNumber.toLowerCase())) return false;
      }
      if (applied.supplier) {
        if (!d.items.some((it) => (productMeta.get(it.productId)?.supplierName ?? "") === applied.supplier)) return false;
      }
      return true;
    });
  }, [docs, applied, productMeta]);

  const total = filteredDocs.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(pageNum, pages);
  const pageDocs = filteredDocs.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // Categorie/Fornitori aggregati per documento (GROUP_CONCAT DISTINCT legacy).
  const docCategories = useCallback((d: StockDocument): string => {
    const set = new Set<string>();
    for (const it of d.items) {
      const cid = productMeta.get(it.productId)?.categoryId ?? 0;
      const name = categories.find((c) => c.id === cid)?.name;
      if (name) set.add(name);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "it")).join(", ");
  }, [productMeta, categories]);
  const docSuppliers = useCallback((d: StockDocument): string => {
    const set = new Set<string>();
    for (const it of d.items) {
      const s = productMeta.get(it.productId)?.supplierName ?? "";
      if (s) set.add(s);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "it")).join(", ");
  }, [productMeta]);

  const exportUrl = useMemo(() => {
    const sp = new URLSearchParams({ slug, action: "export" });
    if (applied.productId > 0) sp.set("product_id", String(applied.productId));
    if (applied.sku) sp.set("sku", applied.sku);
    if (applied.internalCode) sp.set("internal_code", applied.internalCode);
    if (applied.categoryId > 0) sp.set("category_id", String(applied.categoryId));
    if (applied.date) sp.set("date", applied.date);
    if (applied.includeCanceled) sp.set("include_canceled", "1");
    if (applied.documentNumber) sp.set("document_number", applied.documentNumber);
    if (applied.supplier) sp.set("supplier", applied.supplier);
    return `/api/manage/products?${sp.toString()}`;
  }, [slug, applied]);

  const viewDoc = viewId > 0 ? docs.find((d) => d.id === viewId) ?? null : null;
  const attachmentUrl = viewDoc?.attachmentName
    ? `/api/manage/stock-doc-attachment?slug=${encodeURIComponent(slug)}&id=${viewDoc.id}`
    : "";

  // STAMPA: autoPrint come il legacy (stockMovesPageConfig.autoPrint).
  const printedRef = useRef(false);
  useEffect(() => {
    if (printMode && viewDoc && !printedRef.current && typeof window !== "undefined") {
      printedRef.current = true;
      setTimeout(() => window.print(), 150);
    }
    if (!printMode) printedRef.current = false;
  }, [printMode, viewDoc]);

  const isScaricoDoc = viewDoc ? viewDoc.cause === "scarico" : false;

  // ------------------------- VISTA STAMPA -------------------------
  if (printMode && viewDoc) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/stock_moves.css" />

        <div className="d-flex justify-content-between align-items-center mb-3 no-print">
          <button className="btn btn-outline-secondary" type="button" onClick={() => openView(viewDoc.id, false)}>
            Torna al dettaglio
          </button>
          <button className="btn btn-primary" type="button" onClick={() => typeof window !== "undefined" && window.print()}>
            <i className="bi bi-printer" /> Stampa / Salva PDF
          </button>
        </div>

        <div className="card p-3">
          <div className="d-flex justify-content-between align-items-start">
            <div>
              <div className="text-muted small">Movimento Magazzino</div>
              <div className="h5 fw-semibold m-0">#{viewDoc.id}</div>
              {viewDoc.isCanceled ? (
                <div className="mt-1"><span className="badge text-bg-danger">ANNULLATO</span></div>
              ) : null}
            </div>
            <div className="text-end">
              <div className="text-muted small">Creato il</div>
              <div className="fw-semibold">{fmtDate(viewDoc.createdAt)}</div>
            </div>
          </div>

          <hr className="my-3" />

          <div className="row g-3">
            <div className="col-md-3">
              <div className="text-muted small">Data</div>
              <div className="fw-semibold">{fmtDate(viewDoc.moveDate)}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Operatore</div>
              <div className="fw-semibold">{viewDoc.operatorName || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Causale</div>
              <div className="fw-semibold text-uppercase">{viewDoc.cause || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Documento</div>
              <div className="fw-semibold">
                {viewDoc.documentType || "—"}
                {viewDoc.documentNumber ? <><span className="text-muted">#</span>{viewDoc.documentNumber}</> : null}
              </div>
              {viewDoc.documentDate ? <div className="text-muted small">{fmtDate(viewDoc.documentDate)}</div> : null}
            </div>

            {viewDoc.notes ? (
              <div className="col-12">
                <div className="text-muted small">Note</div>
                <div className="border rounded-3 p-2" style={{ whiteSpace: "pre-line" }}>{viewDoc.notes}</div>
              </div>
            ) : null}

            <div className="col-12">
              <div className="text-muted small mb-1">Righe prodotto</div>
              <div className="table-responsive border rounded-3">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Prodotto</th>
                      <th>Codice prodotto</th>
                      <th>Fornitore</th>
                      <th className="text-end">Quantità</th>
                      {!isScaricoDoc ? <th>In arrivo</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {viewDoc.items.length === 0 ? (
                      <tr><td colSpan={isScaricoDoc ? 4 : 5} className="text-muted p-3">Nessuna riga.</td></tr>
                    ) : (
                      viewDoc.items.map((it) => (
                        <tr key={it.id}>
                          <td className="fw-semibold">{displayName(it.productName, it.productSku)}</td>
                          <td className="text-muted">{it.productSku || "—"}</td>
                          <td className="text-muted">{productMeta.get(it.productId)?.supplierName || "—"}</td>
                          <td className="text-end fw-semibold">{it.qty}</td>
                          {!isScaricoDoc ? (
                            <td className="text-muted">
                              {it.incomingFlag ? `${it.incomingQty ?? 0} • ${fmtDate(it.incomingEta)}` : "—"}
                            </td>
                          ) : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {attachmentUrl ? (
              <div className="col-12 no-print">
                <div className="text-muted small">Documento allegato</div>
                <a className="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener" href={attachmentUrl}>Apri allegato</a>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // ------------------------- VISTA DETTAGLIO -------------------------
  if (viewDoc) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/stock_moves.css" />

        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Magazzino</div>
            <h1 className="bs-page-title">Carico / Scarico</h1>
            <div className="bs-page-subtitle">Registra movimenti di magazzino e rettifiche prodotto.</div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/products`}>Torna al magazzino</a>
              <a className="btn btn-primary" href={href(`&action=new&location_id=${activeLocationId}`)}>Nuovo carico / scarico</a>
            </div>
          </div>
        </div>

        {flash ? <div className="alert alert-success">{flash}</div> : null}
        {error ? <div className="alert alert-danger">{error}</div> : null}

        <div className="card p-3 mb-3">
          <div className="d-flex justify-content-between align-items-center">
            <div>
              <div className="text-muted small">Dettagli movimento</div>
              <div className="h6 fw-semibold m-0">#{viewDoc.id}</div>
              {viewDoc.isCanceled ? (
                <div className="mt-1"><span className="badge text-bg-danger">Annullato</span></div>
              ) : null}
            </div>
            <div className="d-flex gap-2">
              <button className="btn btn-sm btn-outline-secondary" type="button" onClick={backToList}>Torna alla lista</button>
              <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openView(viewDoc.id, true)}>
                <i className="bi bi-printer" /> Stampa / PDF
              </button>
              {!viewDoc.isCanceled ? (
                <button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => cancelDoc(viewDoc)}>
                  Annulla movimento
                </button>
              ) : null}
            </div>
          </div>

          <hr className="my-3" />

          <div className="row g-3">
            <div className="col-md-3">
              <div className="text-muted small">Data</div>
              <div className="fw-semibold">{fmtDate(viewDoc.moveDate)}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Operatore</div>
              <div className="fw-semibold">{viewDoc.operatorName || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Causale</div>
              <div className="fw-semibold text-uppercase">{viewDoc.cause || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Creato il</div>
              <div className="fw-semibold">{fmtDate(viewDoc.createdAt)}</div>
            </div>

            <div className="col-md-3">
              <div className="text-muted small">Documento</div>
              <div className="fw-semibold">{viewDoc.documentType || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Numero documento</div>
              <div className="fw-semibold">{viewDoc.documentNumber || "—"}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Data documento</div>
              <div className="fw-semibold">{fmtDate(viewDoc.documentDate)}</div>
            </div>
            <div className="col-md-3">
              <div className="text-muted small">Stato</div>
              <div className="fw-semibold">{viewDoc.isCanceled ? "Annullato" : "Attivo"}</div>
              {viewDoc.isCanceled ? (
                <div className="text-muted small">Annullato il: {fmtDate(viewDoc.canceledAt)} • da: {viewDoc.canceledByName || "—"}</div>
              ) : null}
            </div>

            {viewDoc.notes ? (
              <div className="col-md-12">
                <div className="text-muted small">Note</div>
                <div className="border rounded-3 p-2" style={{ whiteSpace: "pre-line" }}>{viewDoc.notes}</div>
              </div>
            ) : null}

            <div className="col-md-12">
              <div className="text-muted small">Righe prodotto</div>
              <div className="table-responsive border rounded-3">
                <table className="table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>Prodotto</th>
                      <th>Codice prodotto</th>
                      <th>Fornitore</th>
                      <th className="text-end">Quantità</th>
                      {!isScaricoDoc ? <th>In arrivo</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {viewDoc.items.length === 0 ? (
                      <tr><td colSpan={isScaricoDoc ? 4 : 5} className="text-muted p-3">Nessuna riga.</td></tr>
                    ) : (
                      viewDoc.items.map((it) => (
                        <tr key={it.id}>
                          <td className="fw-semibold">{displayName(it.productName, it.productSku)}</td>
                          <td className="text-muted">{it.productSku || "—"}</td>
                          <td className="text-muted">{productMeta.get(it.productId)?.supplierName || "—"}</td>
                          <td className="text-end fw-semibold">{it.qty}</td>
                          {!isScaricoDoc ? (
                            <td className="text-muted">
                              {it.incomingFlag ? (
                                <>
                                  <span className="badge badge-soft">{it.incomingQty ?? 0}</span>
                                  <span className="text-muted ms-1">{fmtDate(it.incomingEta)}</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                          ) : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="col-md-12">
              <div className="text-muted small">Documento allegato</div>
              {attachmentUrl ? (
                <div className="d-flex align-items-center justify-content-between border rounded-3 p-2">
                  <div>
                    <div className="fw-semibold">{viewDoc.attachmentName || "Documento"}</div>
                  </div>
                  <a className="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener" href={attachmentUrl}>Apri</a>
                </div>
              ) : (
                <div className="text-muted">Nessun documento.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------- LISTA -------------------------
  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/stock_moves.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Magazzino</div>
          <div className="d-flex align-items-center gap-2">
            <h1 className="bs-page-title">Carico / Scarico</h1>
            <InfoBox>
              <p>Ogni carico o scarico è un <strong>documento</strong> con le sue righe: al salvataggio lo stock si aggiorna subito.</p>
              <ul>
                <li>
                  I documenti <strong>non si modificano</strong>: per correggere, annulla il documento — lo stock viene
                  ripristinato automaticamente — e creane uno nuovo.
                </li>
                <li>L&apos;export CSV rispetta i filtri attivi.</li>
              </ul>
            </InfoBox>
          </div>
          <div className="bs-page-subtitle">Registra movimenti di magazzino e rettifiche prodotto.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary" href={`/${encodeURIComponent(slug)}/products`}>
              Torna al magazzino
            </a>
            <a className="btn btn-primary" href={href(`&action=new&location_id=${activeLocationId}`)}>
              Nuovo carico / scarico
            </a>
          </div>
        </div>
      </div>

      {flash ? <div className="alert alert-success">{flash}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <div className="card p-3 mb-3">
        <form
          method="get"
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <div className="col-md-4">
            <label className="form-label">Prodotto</label>
            <StockCombobox
              boxClass="js-filter-product-box"
              options={[{ id: "0", label: "Tutti" }, ...products.map((p) => ({ id: String(p.id), label: displayName(p.name, p.sku) }))]}
              value={productId > 0 ? String(productId) : "0"}
              onChange={(v) => setProductId(Number.parseInt(v, 10) || 0)}
              placeholder="Tutti"
              hiddenName="product_id"
              hiddenClass="js-filter-product"
            />
          </div>

          <div className="col-md-3">
            <label className="form-label">Categoria</label>
            <select className="form-select" name="category_id" value={String(categoryId)} onChange={(e) => setCategoryId(Number(e.target.value) || 0)}>
              <option value="0">Tutte</option>
              {categories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="col-md-3">
            <label className="form-label">Fornitore</label>
            <StockCombobox
              boxClass="js-filter-supplier-box"
              options={[{ id: "0", label: "Tutti" }, ...supplierNames.map((name) => ({ id: name, label: name }))]}
              value={supplier || "0"}
              onChange={(v) => setSupplier(v === "0" ? "" : v)}
              placeholder="Tutti"
              hiddenName="supplier"
              hiddenClass="js-filter-supplier"
            />
          </div>

          <div className="col-md-2">
            <label className="form-label">Codice prodotto</label>
            <input className="form-control" name="sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Cerca codice prodotto" />
          </div>

          <div className="col-md-2">
            <label className="form-label">Codice interno</label>
            <input className="form-control" name="internal_code" value={internalCode} onChange={(e) => setInternalCode(e.target.value)} placeholder="Cerca codice interno" />
          </div>

          <div className="col-md-2">
            <label className="form-label">N. documento</label>
            <input className="form-control" name="document_number" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="Es. 123/2025" />
          </div>

          <div className="col-md-2">
            <label className="form-label">Data</label>
            <input className="form-control" type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="col-md-2 d-flex align-items-center justify-content-start">
            <div className="form-check mb-2">
              <input
                className="form-check-input"
                type="checkbox"
                name="include_canceled"
                value="1"
                id="includeCanceled"
                checked={includeCanceled}
                onChange={(e) => setIncludeCanceled(e.target.checked)}
              />
              <label className="form-check-label" htmlFor="includeCanceled">
                Mostra annullati
              </label>
            </div>
          </div>

          <div className="col-md-3 d-flex gap-2 app-filter-actions">
            <button className="btn btn-outline-primary flex-grow-1 app-filter-submit" type="submit">
              <i className="bi bi-search me-1" />
              Filtra
            </button>
            <a className="btn btn-outline-secondary app-filter-reset" href={href("")}>
              Reset
            </a>
          </div>

          <div className="col-12 d-flex justify-content-end">
            <a className="btn btn-outline-secondary" href={exportUrl}>
              <i className="bi bi-download" /> Esporta CSV
            </a>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="table-responsive">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th>Data</th>
                <th>Causale</th>
                <th>Documento</th>
                <th>Operatore</th>
                <th>Categorie</th>
                <th>Fornitori</th>
                <th>Prodotti</th>
                <th>Totale q.tà</th>
                <th>Stato</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {pageDocs.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted p-3">
                    {loading ? "Caricamento…" : "Nessun movimento."}
                  </td>
                </tr>
              ) : (
                pageDocs.map((d) => {
                  const totalQty = d.items.reduce((acc, it) => acc + Number(it.qty || 0), 0);
                  const cats = docCategories(d) || "—";
                  const sups = docSuppliers(d) || "—";
                  return (
                    <tr key={d.id}>
                      <td className="text-muted">{fmtDate(d.moveDate)}</td>
                      <td className="text-uppercase">{d.cause || "—"}</td>
                      <td className="text-muted">
                        {d.documentType || "—"}
                        {d.documentNumber ? <> <span className="text-muted">#</span>{d.documentNumber}</> : null}
                        {d.documentDate ? <div className="text-muted small">{fmtDate(d.documentDate)}</div> : null}
                      </td>
                      <td className="text-muted">{d.operatorName || "—"}</td>
                      <td className="text-muted small stock-moves-wrap-cell">{cats}</td>
                      <td className="text-muted small stock-moves-wrap-cell">{sups}</td>
                      <td className="fw-semibold">{d.items.length}</td>
                      <td className="fw-semibold">{totalQty}</td>
                      <td>
                        {d.isCanceled ? (
                          <span className="badge text-bg-danger">Annullato</span>
                        ) : (
                          <span className="badge text-bg-success">Attivo</span>
                        )}
                      </td>
                      <td className="text-end">
                        <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => openView(d.id)}>
                          Apri
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 ? (
          <div className="d-flex justify-content-between align-items-center p-3">
            <div className="text-muted small">Pagina {safePage} di {pages} • Totale: {total}</div>
            <div className="d-flex gap-2">
              <button
                className={`btn btn-sm btn-outline-secondary ${safePage <= 1 ? "disabled" : ""}`}
                type="button"
                onClick={() => {
                  const p = Math.max(1, safePage - 1);
                  setPageNum(p);
                  syncUrl(applied, p, 0, false);
                }}
              >
                &laquo; Prev
              </button>
              <button
                className={`btn btn-sm btn-outline-secondary ${safePage >= pages ? "disabled" : ""}`}
                type="button"
                onClick={() => {
                  const p = Math.min(pages, safePage + 1);
                  setPageNum(p);
                  syncUrl(applied, p, 0, false);
                }}
              >
                Next &raquo;
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Combobox .app-combobox (markup legacy con list-group).
function StockCombobox(props: {
  boxClass: string;
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  hiddenName: string;
  hiddenClass: string;
}) {
  const { boxClass, options, value, onChange, placeholder, hiddenName, hiddenClass } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selected = value !== "0" ? options.find((o) => o.id === value) : undefined;
  const needle = search.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  return (
    <div className={`dropdown app-combobox ${boxClass}${open ? " show" : ""}`} ref={ref}>
      <button
        className="form-control text-start app-combobox-toggle dropdown-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSearch("");
          setOpen(!open);
        }}
      >
        <span className="app-combobox-text">{selected ? selected.label : ""}</span>
        {selected ? null : <span className="app-combobox-placeholder text-muted">{placeholder}</span>}
      </button>
      <input type="hidden" name={hiddenName} className={hiddenClass} value={value} readOnly />
      <div className={`dropdown-menu p-2 w-100 app-combobox-menu${open ? " show" : ""}`}>
        <input
          ref={searchRef}
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="list-group mt-2 app-combobox-list">
          {filtered.map((o) => (
            <button
              type="button"
              key={o.id}
              className={`list-group-item list-group-item-action${o.id === value ? " active" : ""}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
                setSearch("");
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
