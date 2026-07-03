"use client";

import { useEffect, useMemo, useState } from "react";

// Faithful CORE port of the PHP quote NEW form (app/pages/quotes.php,
// action=new — "Nuovo preventivo"). The legacy editor is very large (full client
// anagrafica snapshot, packages, tax, payment methods, terms, PDF/print/email,
// accept→sale conversion). This port covers the CORE the existing DB pipeline
// (createDbQuote) supports: client + line items (services/products) + discount +
// totals + save. It mirrors the legacy layout (cliente + righe + sconto +
// totale) with Bootstrap markup, then returns to the quotes list.
//
// Submits to /api/manage/quotes (action=create) with client_id/client_name,
// discount, and lines_json (PosSaleItemInput[]). The server resolves the client,
// builds the quote number, computes subtotal/total, and writes quote_items.
//
// TODO (advanced legacy bits NOT yet ported — createDbQuote does not model them):
//   - EDIT / VIEW of an existing quote (action=edit / action=view). This form is
//     NEW-only; the list "Apri" still routes to the Tailwind fallback.
//   - Client anagrafica snapshot fields (company/VAT/tax code/SDI/PEC/address)
//     and "create client from snapshot" when no client is selected.
//   - Package line items, per-line/aggregate tax (IVA), quote_date / valid_until
//     pickers (the API stamps a 30-day validity), public note, payment methods,
//     terms text, and the PDF / email / print / accept→sale actions.

type ClientLite = { id: number; name: string };
type CatalogItem = { id: number; name: string; price: number };

type LineType = "service" | "product";

type Line = {
  type: LineType;
  refId: number;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discountPercent: number;
};

// Per-line net + tax (faithful to quotes.php): gross=qty*unit,
// net=gross*(1-disc%), tax=net*iva%, total=net+tax.
function lineNet(l: Line): number {
  const gross = Math.max(1, l.quantity) * Math.max(0, l.unitPrice);
  return roundMoney(gross * (1 - Math.min(100, Math.max(0, l.discountPercent)) / 100));
}
function lineTaxAmt(l: Line): number {
  return roundMoney(lineNet(l) * (Math.min(100, Math.max(0, l.taxRate)) / 100));
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Resolve the legacy-style ?action=new|edit once, synchronously from the URL.
function resolveAction(): "new" | "edit" {
  if (typeof window === "undefined") return "new";
  return new URLSearchParams(window.location.search).get("action") === "edit" ? "edit" : "new";
}

function fmtEuro(n: number): string {
  return `€ ${(Number.isFinite(n) ? n : 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function QuoteFormContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [action] = useState<"new" | "edit">(resolveAction);
  const [quoteId, setQuoteId] = useState(0);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [services, setServices] = useState<CatalogItem[]>([]);
  const [products, setProducts] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [clientId, setClientId] = useState(0);
  const [clientName, setClientName] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  // Header fields (dates + notes/terms/public note).
  const [quoteDate, setQuoteDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [publicNote, setPublicNote] = useState("");

  // Client anagrafica snapshot (collapsible "Dati fiscali cliente").
  const [snap, setSnap] = useState({ companyName: "", vatNumber: "", taxCode: "", sdi: "", pec: "", email: "", phone: "", address: "", cap: "", city: "", province: "" });

  // Add-line picker state
  const [pickType, setPickType] = useState<LineType>("service");
  const [pickRefId, setPickRefId] = useState(0);
  const [pickQty, setPickQty] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = params.get("action") === "edit" ? "edit" : "new";
    const editId = Number.parseInt(params.get("id") ?? "", 10);

    const ctxPromise = fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=context`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setClients((Array.isArray(j.clients) ? j.clients : []).map((c: Record<string, unknown>) => ({ id: Number(c.id ?? 0), name: String(c.name ?? "") })));
        setServices((Array.isArray(j.services) ? j.services : []).map((s: Record<string, unknown>) => ({ id: Number(s.id ?? 0), name: String(s.name ?? ""), price: Number(s.price ?? 0) || 0 })));
        setProducts((Array.isArray(j.products) ? j.products : []).map((p: Record<string, unknown>) => ({ id: Number(p.id ?? 0), name: String(p.name ?? ""), price: Number(p.price ?? 0) || 0 })));
      })
      .catch(() => setError("Errore nel caricamento del catalogo."));

    const editPromise =
      act === "edit" && Number.isFinite(editId) && editId > 0
        ? fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}&action=edit_get&id=${editId}`, { headers: { "x-tenant-slug": slug } })
            .then((r) => r.json())
            .then((j) => {
              if (!j.ok || !j.quote) {
                setError(String(j.error ?? "Preventivo non trovato."));
                return;
              }
              const qd = j.quote;
              setQuoteId(Number(qd.id ?? editId));
              setClientId(Number(qd.clientId ?? 0) || 0);
              setClientName(String(qd.clientName ?? ""));
              setQuoteDate(String(qd.quoteDate ?? "").slice(0, 10));
              setValidUntil(String(qd.validUntil ?? "").slice(0, 10));
              setNotes(String(qd.notes ?? ""));
              setTerms(String(qd.terms ?? ""));
              setPublicNote(String(qd.publicNote ?? ""));
              const s = qd.client ?? {};
              setSnap({
                companyName: String(s.companyName ?? ""),
                vatNumber: String(s.vatNumber ?? ""),
                taxCode: String(s.taxCode ?? ""),
                sdi: String(s.sdi ?? ""),
                pec: String(s.pec ?? ""),
                email: String(s.email ?? ""),
                phone: String(s.phone ?? ""),
                address: String(s.address ?? ""),
                cap: String(s.cap ?? ""),
                city: String(s.city ?? ""),
                province: String(s.province ?? ""),
              });
              setLines(
                (qd.lines ?? []).map((l: Record<string, unknown>) => ({
                  type: l.type === "product" ? "product" : "service",
                  refId: Number(l.refId ?? 0) || 0,
                  name: String(l.name ?? ""),
                  sku: String(l.sku ?? ""),
                  quantity: Math.max(1, Number(l.quantity ?? 1)),
                  unitPrice: Number(l.unitPrice ?? 0) || 0,
                  taxRate: Number(l.taxRate ?? 0) || 0,
                  discountPercent: Number(l.discountPercent ?? 0) || 0,
                })),
              );
            })
            .catch(() => setError("Errore nel caricamento del preventivo."))
        : Promise.resolve();

    Promise.all([ctxPromise, editPromise]).finally(() => setLoading(false));
  }, [slug]);

  const catalog = pickType === "service" ? services : products;

  function addLine() {
    setError("");
    if (pickRefId <= 0) {
      setError("Seleziona un servizio o prodotto da aggiungere.");
      return;
    }
    const item = catalog.find((c) => c.id === pickRefId);
    if (!item) return;
    setLines((prev) => [
      ...prev,
      { type: pickType, refId: item.id, name: item.name, sku: "", quantity: Math.max(1, pickQty), unitPrice: item.price, taxRate: 0, discountPercent: 0 },
    ]);
    setPickRefId(0);
    setPickQty(1);
  }

  function setLine(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  // Totals faithful to quotes.php: subtotale = Σ net, sconto = Σ (gross-net),
  // IVA = Σ line tax, totale = subtotale + IVA.
  const subtotal = useMemo(() => roundMoney(lines.reduce((sum, l) => sum + lineNet(l), 0)), [lines]);
  const discountValue = useMemo(
    () => roundMoney(lines.reduce((sum, l) => sum + (Math.max(1, l.quantity) * Math.max(0, l.unitPrice) - lineNet(l)), 0)),
    [lines],
  );
  const taxValue = useMemo(() => roundMoney(lines.reduce((sum, l) => sum + lineTaxAmt(l), 0)), [lines]);
  const total = useMemo(() => roundMoney(subtotal + taxValue), [subtotal, taxValue]);

  function backToList() {
    window.location.href = `/${encodeURIComponent(slug)}/quotes`;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (lines.length === 0) {
      setError("Aggiungi almeno una voce al preventivo.");
      return;
    }
    setSaving(true);
    try {
      const linesJson = lines.map((l) => ({
        type: l.type,
        refId: l.refId,
        name: l.name,
        sku: l.sku,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: l.taxRate,
        discountPercent: l.discountPercent,
      }));
      const payload: Record<string, unknown> = {
        action: action === "edit" ? "update" : "create",
        id: String(quoteId),
        client_id: String(clientId || 0),
        client_name: clientId > 0 ? "" : clientName,
        quote_date: quoteDate,
        valid_until: validUntil,
        notes,
        terms,
        public_note: publicNote,
        client_company_name: snap.companyName,
        client_vat_number: snap.vatNumber,
        client_tax_code: snap.taxCode,
        client_sdi: snap.sdi,
        client_pec: snap.pec,
        client_email: snap.email,
        client_phone: snap.phone,
        client_address: snap.address,
        client_cap: snap.cap,
        client_city: snap.city,
        client_province: snap.province,
        lines_json: JSON.stringify(linesJson),
      };
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(String(j.error ?? "Errore nel salvataggio del preventivo."));
        setSaving(false);
        return;
      }
      backToList();
    } catch {
      setError("Errore nel salvataggio del preventivo.");
      setSaving(false);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Vendite</div>
          <h1 className="bs-page-title">{action === "edit" ? "Modifica preventivo" : "Nuovo preventivo"}</h1>
          <div className="bs-page-subtitle">Crea e gestisci preventivi per i tuoi clienti.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/quotes`}>
            <i className="bi bi-arrow-left me-1" />
            Torna ai preventivi
          </a>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : (
        <form method="post" onSubmit={onSubmit}>
          <div className="card p-3 mb-3">
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Cliente</label>
                <select
                  className="form-select"
                  value={clientId}
                  onChange={(e) => {
                    const id = Number(e.target.value) || 0;
                    setClientId(id);
                    if (id > 0) setClientName("");
                  }}
                >
                  <option value={0}>— Cliente occasionale —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-md-6">
                <label className="form-label">Nominativo (se cliente occasionale)</label>
                <input
                  className="form-control"
                  value={clientName}
                  disabled={clientId > 0}
                  placeholder="Es. Mario Rossi"
                  onChange={(e) => setClientName(e.target.value)}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Data preventivo</label>
                <input className="form-control" type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
              </div>
              <div className="col-md-3">
                <label className="form-label">Valido fino al</label>
                <input className="form-control" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>

            <details className="mt-3">
              <summary className="text-muted small" style={{ cursor: "pointer" }}>
                Dati fiscali cliente (opzionale)
              </summary>
              <div className="row g-2 mt-1">
                <div className="col-md-4">
                  <label className="form-label small">Ragione sociale</label>
                  <input className="form-control form-control-sm" value={snap.companyName} onChange={(e) => setSnap((s) => ({ ...s, companyName: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">P.IVA</label>
                  <input className="form-control form-control-sm" value={snap.vatNumber} onChange={(e) => setSnap((s) => ({ ...s, vatNumber: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Codice fiscale</label>
                  <input className="form-control form-control-sm" value={snap.taxCode} onChange={(e) => setSnap((s) => ({ ...s, taxCode: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">SDI</label>
                  <input className="form-control form-control-sm" value={snap.sdi} onChange={(e) => setSnap((s) => ({ ...s, sdi: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">PEC</label>
                  <input className="form-control form-control-sm" value={snap.pec} onChange={(e) => setSnap((s) => ({ ...s, pec: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Email</label>
                  <input className="form-control form-control-sm" value={snap.email} onChange={(e) => setSnap((s) => ({ ...s, email: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Telefono</label>
                  <input className="form-control form-control-sm" value={snap.phone} onChange={(e) => setSnap((s) => ({ ...s, phone: e.target.value }))} />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Indirizzo</label>
                  <input className="form-control form-control-sm" value={snap.address} onChange={(e) => setSnap((s) => ({ ...s, address: e.target.value }))} />
                </div>
                <div className="col-md-1">
                  <label className="form-label small">CAP</label>
                  <input className="form-control form-control-sm" value={snap.cap} onChange={(e) => setSnap((s) => ({ ...s, cap: e.target.value }))} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small">Città</label>
                  <input className="form-control form-control-sm" value={snap.city} onChange={(e) => setSnap((s) => ({ ...s, city: e.target.value }))} />
                </div>
                <div className="col-md-1">
                  <label className="form-label small">Prov.</label>
                  <input className="form-control form-control-sm" value={snap.province} onChange={(e) => setSnap((s) => ({ ...s, province: e.target.value }))} />
                </div>
              </div>
            </details>
          </div>

          <div className="card p-3 mb-3">
            <div className="fw-semibold mb-2">Aggiungi voce</div>
            <div className="row g-2 align-items-end">
              <div className="col-md-2">
                <label className="form-label">Tipo</label>
                <select
                  className="form-select"
                  value={pickType}
                  onChange={(e) => {
                    setPickType(e.target.value === "product" ? "product" : "service");
                    setPickRefId(0);
                  }}
                >
                  <option value="service">Servizio</option>
                  <option value="product">Prodotto</option>
                </select>
              </div>
              <div className="col-md-6">
                <label className="form-label">{pickType === "service" ? "Servizio" : "Prodotto"}</label>
                <select className="form-select" value={pickRefId || ""} onChange={(e) => setPickRefId(Number(e.target.value) || 0)}>
                  <option value="">— seleziona —</option>
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({fmtEuro(c.price)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-md-2">
                <label className="form-label">Quantità</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  value={pickQty}
                  onChange={(e) => setPickQty(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                />
              </div>
              <div className="col-md-2 d-grid">
                <button className="btn btn-outline-primary" type="button" onClick={addLine}>
                  <i className="bi bi-plus-lg me-1" />
                  Aggiungi
                </button>
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Voce</th>
                    <th className="text-end">Prezzo</th>
                    <th className="text-end">Q.tà</th>
                    <th className="text-end">Sconto %</th>
                    <th className="text-end">IVA %</th>
                    <th className="text-end">Totale</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted small p-3">
                        Nessuna voce. Aggiungi servizi o prodotti al preventivo.
                      </td>
                    </tr>
                  ) : (
                    lines.map((l, index) => (
                      <tr key={`${l.type}-${l.refId}-${index}`}>
                        <td className="fw-semibold">
                          {l.name}
                          <div className="small text-muted">{l.type === "service" ? "Servizio" : l.type === "product" ? "Prodotto" : "Voce"}</div>
                        </td>
                        <td className="text-end" style={{ maxWidth: 120 }}>
                          <input
                            className="form-control form-control-sm text-end"
                            type="number"
                            step="0.01"
                            min={0}
                            value={l.unitPrice}
                            onChange={(e) => setLine(index, { unitPrice: Math.max(0, Number.parseFloat(e.target.value) || 0) })}
                          />
                        </td>
                        <td className="text-end" style={{ maxWidth: 90 }}>
                          <input
                            className="form-control form-control-sm text-end"
                            type="number"
                            min={1}
                            value={l.quantity}
                            onChange={(e) => setLine(index, { quantity: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                          />
                        </td>
                        <td className="text-end" style={{ maxWidth: 90 }}>
                          <input
                            className="form-control form-control-sm text-end"
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={l.discountPercent}
                            onChange={(e) => setLine(index, { discountPercent: Math.min(100, Math.max(0, Number.parseFloat(e.target.value) || 0)) })}
                          />
                        </td>
                        <td className="text-end" style={{ maxWidth: 90 }}>
                          <input
                            className="form-control form-control-sm text-end"
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={l.taxRate}
                            onChange={(e) => setLine(index, { taxRate: Math.min(100, Math.max(0, Number.parseFloat(e.target.value) || 0)) })}
                          />
                        </td>
                        <td className="text-end fw-semibold">{fmtEuro(roundMoney(lineNet(l) + lineTaxAmt(l)))}</td>
                        <td className="text-end">
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeLine(index)}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-3 mb-3">
            <div className="row g-3">
              <div className="col-md-8">
                <div className="row g-3">
                  <div className="col-md-4">
                    <label className="form-label">Nota per il cliente</label>
                    <textarea className="form-control" rows={2} value={publicNote} onChange={(e) => setPublicNote(e.target.value)} placeholder="Testo mostrato al cliente…" />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Condizioni</label>
                    <textarea className="form-control" rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Condizioni di vendita…" />
                  </div>
                  <div className="col-md-4">
                    <label className="form-label">Note interne</label>
                    <textarea className="form-control" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Non mostrate al cliente…" />
                  </div>
                </div>
              </div>
              <div className="col-md-4">
                <div className="border rounded-3 p-3 bg-light">
                  <div className="d-flex justify-content-between">
                    <span className="text-muted">Subtotale</span>
                    <span className="fw-semibold">{fmtEuro(subtotal)}</span>
                  </div>
                  <div className="d-flex justify-content-between">
                    <span className="text-muted">Sconto</span>
                    <span className="fw-semibold">- {fmtEuro(discountValue)}</span>
                  </div>
                  <div className="d-flex justify-content-between">
                    <span className="text-muted">IVA</span>
                    <span className="fw-semibold">{fmtEuro(taxValue)}</span>
                  </div>
                  <hr className="my-2" />
                  <div className="d-flex justify-content-between">
                    <span className="fw-semibold">Totale</span>
                    <span className="h5 fw-bold m-0">{fmtEuro(total)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="d-flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              {saving ? "Salvataggio…" : "Salva preventivo"}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={backToList}>
              Annulla
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
