"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP giftbox TEMPLATE editor (app/pages/giftbox.php,
// tab=boxes action=new|edit). A template is the box CATALOG the POS giftbox-sale
// issues instances from: a `giftboxes` row + its `giftbox_items` (services /
// products / custom voices with qty). Bootstrap markup mirrors the legacy form:
//   - Nome, "Solo clienti con Fidelity" (fidelity_only), Descrizione
//   - Costo in punti (points_cost), Ordine (sort_order), Attiva (active)
//   - Validità dal / Validità al (valid_from / valid_to)
//   - Contenuti GiftBox: repeatable items table (item_type service/product/custom,
//     service/product select, custom label/details, qty)
// Submits to /api/manage/giftboxes (action=save; create when no id, update with
// id). Distinct from the issued GiftBox INSTANCES list (giftbox-content.tsx).
//
// TODO: the legacy editor also renders the advanced Fidelity targeting — the
// "Livelli Punti" checkboxes (eligible_levels_points[], required when
// fidelity_only). That depends on the Fidelity card-levels config which is not
// part of the current giftbox template save pipeline, so it is not yet ported.

type CatalogItem = { id: number; name: string };

type BoxItem = {
  item_type: "service" | "product" | "custom";
  service_id: number;
  product_id: number;
  qty: number;
  custom_label: string;
  custom_details: string;
};

type GiftBoxForm = {
  id: number;
  name: string;
  description: string;
  fidelity_only: boolean;
  points_cost: string;
  active: boolean;
  sort_order: string;
  valid_from: string;
  valid_to: string;
  items: BoxItem[];
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function emptyItem(): BoxItem {
  return { item_type: "service", service_id: 0, product_id: 0, qty: 1, custom_label: "", custom_details: "" };
}

function emptyForm(): GiftBoxForm {
  return {
    id: 0,
    name: "",
    description: "",
    fidelity_only: true,
    points_cost: "0",
    active: true,
    sort_order: "0",
    valid_from: "",
    valid_to: "",
    items: [emptyItem()],
  };
}

export function GiftBoxFormContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: { action?: string; id?: string; msg?: string; err?: string } } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [form, setForm] = useState<GiftBoxForm>(emptyForm());
  const [services, setServices] = useState<CatalogItem[]>([]);
  const [products, setProducts] = useState<CatalogItem[]>([]);
  // Livelli Punti configurati in Fidelity (giftbox.php gbLevelsWrap): con
  // "Solo clienti con Fidelity" attivo la selezione è OBBLIGATORIA.
  const [levels, setLevels] = useState<{ key: string; name: string }[]>([]);
  const [eligibleLevels, setEligibleLevels] = useState<string[]>([]);
  const [perms, setPerms] = useState({ canSettings: false, canCreate: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Flash legacy (View::alert): ?msg= dal redirect post-salvataggio.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const act = (initialQuery?.action ?? params.get("action")) === "edit" ? "edit" : "new";
    const id = Number.parseInt(String(initialQuery?.id ?? params.get("id") ?? ""), 10);

    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=perms`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setPerms({ canSettings: j?.canSettings === true, canCreate: j?.canCreate === true }))
      .catch(() => setPerms({ canSettings: false, canCreate: false }));

    const ctxPromise = fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=context`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        setServices(Array.isArray(j.services) ? j.services : []);
        setProducts(Array.isArray(j.products) ? j.products : []);
        return j;
      })
      .catch(() => ({}));

    // Livelli Punti dai settaggi Fidelity (per il blocco gbLevelsWrap).
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=levels`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const lv = (j?.levels?.levels ?? []) as Array<Record<string, unknown>>;
        setLevels(lv.map((l) => ({ key: String(l.key ?? "").toLowerCase(), name: String(l.name ?? l.key ?? "") })).filter((l) => l.key !== ""));
      })
      .catch(() => setLevels([]));

    if (act === "edit" && Number.isFinite(id) && id > 0) {
      Promise.all([
        ctxPromise,
        fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=get&id=${id}`, {
          headers: { "x-tenant-slug": slug },
        }).then((r) => r.json()),
      ])
        .then(([, j]) => {
          if (!j.ok || !j.template) {
            // Legacy: redirect alla pagina GiftBox con "GiftBox non trovata".
            window.location.href = `/${encodeURIComponent(slug)}/giftbox?err=${encodeURIComponent("GiftBox non trovata")}`;
            return;
          }
          const t = j.template;
          const items = ((t.items ?? []) as Array<Record<string, unknown>>).map((it) => ({
            item_type: it.itemType === "product" || it.itemType === "custom" ? (it.itemType as BoxItem["item_type"]) : "service",
            service_id: Number(it.serviceId ?? 0) || 0,
            product_id: Number(it.productId ?? 0) || 0,
            qty: Math.max(1, Number(it.qty ?? 1) || 1),
            custom_label: String(it.customLabel ?? ""),
            custom_details: String(it.customDetails ?? ""),
          }));
          setEligibleLevels(Array.isArray(t.eligibleLevelsPoints) ? t.eligibleLevelsPoints.map((k: unknown) => String(k)) : []);
          setForm({
            id: Number(t.id ?? id),
            name: String(t.name ?? ""),
            description: String(t.description ?? ""),
            fidelity_only: Boolean(t.fidelityOnly),
            points_cost: String(t.pointsCost ?? "0"),
            active: Boolean(t.active),
            sort_order: String(t.sortOrder ?? "0"),
            valid_from: String(t.validFrom ?? "").slice(0, 10),
            valid_to: String(t.validTo ?? "").slice(0, 10),
            items: items.length > 0 ? items : [emptyItem()],
          });
        })
        .catch(() => setError("Errore nel caricamento della GiftBox."))
        .finally(() => setLoading(false));
    } else {
      ctxPromise.finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function set<K extends keyof GiftBoxForm>(key: K, value: GiftBoxForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setItem(index: number, patch: Partial<BoxItem>) {
    setForm((prev) => {
      const next = prev.items.slice();
      next[index] = { ...next[index], ...patch };
      return { ...prev, items: next };
    });
  }

  function addItem() {
    setForm((prev) => ({ ...prev, items: [...prev.items, emptyItem()] }));
  }

  // Il legacy consente di rimuovere anche l'ultima riga (removeItemRow).
  function removeItem(index: number) {
    setForm((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    // Unica validazione client legacy (giftbox.js validateGiftboxForm):
    // fidelity_only richiede almeno un livello Punti (alert bloccante).
    if (form.fidelity_only && levels.length > 0 && eligibleLevels.length === 0) {
      window.alert("Seleziona almeno un livello Punti.");
      return;
    }

    setSaving(true);
    try {
      const itemsJson = form.items.map((it) => ({
        item_type: it.item_type,
        service_id: it.service_id,
        product_id: it.product_id,
        qty: it.qty,
        custom_label: it.custom_label,
        custom_details: it.custom_details,
      }));
      const payload: Record<string, unknown> = {
        action: "save",
        id: String(form.id),
        name: form.name,
        description: form.description,
        fidelity_only: form.fidelity_only ? "1" : "0",
        points_cost: form.points_cost,
        active: form.active ? "1" : "0",
        sort_order: form.sort_order,
        valid_from: form.valid_from,
        valid_to: form.valid_to,
        eligible_levels_points_json: JSON.stringify(eligibleLevels),
        items_json: JSON.stringify(itemsJson),
      };
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        // Errori pagina legacy (View::alert danger, senza redirect).
        setError(String(j.error ?? "Errore: impossibile salvare la GiftBox. Verifica nome, livelli e contenuti."));
        setSaving(false);
        window.scrollTo(0, 0);
        return;
      }
      // Redirect legacy: resta sull'editor della GiftBox salvata con flash.
      const savedId = Number(j?.template?.id ?? form.id) || form.id;
      window.location.href = `/${encodeURIComponent(slug)}/giftbox?action=edit&id=${savedId}&msg=${encodeURIComponent("GiftBox salvata")}`;
    } catch {
      setError("Errore: impossibile salvare la GiftBox. Verifica nome, livelli e contenuti.");
      setSaving(false);
      window.scrollTo(0, 0);
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <h1 className="bs-page-title">GiftBox</h1>
          <div className="bs-page-subtitle">Gestisci template, voucher e GiftBox emesse.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {perms.canSettings ? (
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox_settings`}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            ) : null}
            {perms.canCreate ? (
              <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/pos`}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftBox
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="d-flex justify-content-between align-items-center mb-3">
        <div className="text-muted small">Template GiftBox (contenuti + regole base)</div>
        <div className="d-flex gap-2">
          <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox?action=new`}>
            <i className="bi bi-plus-circle me-1" />
            Nuova GiftBox
          </a>
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
        <div className="card p-3 mb-3">
          <form method="post" id="giftboxForm" onSubmit={onSubmit}>
            <input type="hidden" name="id" value={form.id} />

            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Nome</label>
                <input className="form-control" name="name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
              </div>

              <div className="col-md-6">
                <div className="form-check mt-4">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="fidelity_only"
                    id="gbFidelityOnly"
                    checked={form.fidelity_only}
                    onChange={(e) => set("fidelity_only", e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="gbFidelityOnly">Solo clienti con Fidelity</label>
                </div>
                <div className="form-text">Se disabilitato, tutti i clienti possono usufruire del GiftBox.</div>
              </div>

              <div className="col-12">
                <label className="form-label">Descrizione (opzionale)</label>
                <textarea
                  className="form-control"
                  name="description"
                  rows={2}
                  placeholder="Descrizione/Note interne"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </div>

              <div className="col-md-4">
                <label className="form-label">Costo in punti (opzionale)</label>
                <input
                  className="form-control"
                  name="points_cost"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  placeholder="0"
                  value={form.points_cost}
                  onChange={(e) => set("points_cost", e.target.value)}
                />
                <div className="form-text">Se &gt; 0, in fase di emissione puoi scegliere se scalare i punti.</div>
              </div>

              {/* Markup legacy: il blocco resta in DOM, toggle d-none + checkbox disabilitate (giftbox.js toggleGiftboxLevels). */}
              <div className={`col-12 ${form.fidelity_only ? "" : "d-none"}`} id="gbLevelsWrap">
                <hr />
                <div className="fw-semibold">Livelli Card (obbligatorio)</div>
                <div className="text-muted small">
                  Visibile solo se <strong>Solo clienti con Fidelity</strong> e attivo. Seleziona almeno un livello Punti.
                </div>

                <div className="row g-3 mt-1">
                  <div className="col-md-12">
                    <div className="text-muted small fw-semibold">Livelli Punti</div>
                    {levels.length === 0 ? (
                      <div className="text-muted small">Nessun livello Punti configurato.</div>
                    ) : (
                      <div className="d-flex flex-wrap gap-2 mt-2">
                        {levels.map((l) => (
                          <div className="form-check" key={l.key}>
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id={`gb_lvl_pts_${l.key}`}
                              checked={eligibleLevels.includes(l.key)}
                              disabled={!form.fidelity_only}
                              onChange={(e) =>
                                setEligibleLevels((prev) => (e.target.checked ? Array.from(new Set([...prev, l.key])) : prev.filter((k) => k !== l.key)))
                              }
                            />
                            <label className="form-check-label" htmlFor={`gb_lvl_pts_${l.key}`}>
                              {l.name || l.key}
                            </label>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Ordine</label>
                <input className="form-control" type="number" name="sort_order" value={form.sort_order} onChange={(e) => set("sort_order", e.target.value)} />
              </div>

              <div className="col-md-3">
                <label className="form-label">Attiva</label>
                <div className="form-check mt-2">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    name="active"
                    id="gbActive"
                    checked={form.active}
                    onChange={(e) => set("active", e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="gbActive">Abilitata</label>
                </div>
              </div>

              <div className="col-md-3">
                <label className="form-label">Validità dal</label>
                <input className="form-control" type="date" name="valid_from" value={form.valid_from} onChange={(e) => set("valid_from", e.target.value)} />
              </div>

              <div className="col-md-3">
                <label className="form-label">Validità al</label>
                <input className="form-control" type="date" name="valid_to" value={form.valid_to} onChange={(e) => set("valid_to", e.target.value)} />
              </div>
            </div>

            <div className="col-12 mt-3">
              <div className="fw-semibold">Contenuti GiftBox</div>
              <div className="text-muted small">Aggiungi servizi/prodotti o voci personalizzate (es. &quot;Kit skincare&quot;).</div>
            </div>

            <div className="col-12 mt-2">
              <div className="table-responsive">
                <table className="table table-sm align-middle" id="itemsTable">
                  <thead>
                    <tr>
                      <th className="giftbox-item-type-col">Tipo</th>
                      <th>Servizio / Prodotto / Voce</th>
                      <th className="giftbox-item-qty-col text-center">Qty</th>
                      <th className="giftbox-item-action-col text-end" />
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((it, index) => (
                      <tr key={index}>
                        <td>
                          <select
                            className="form-select form-select-sm item-type"
                            value={it.item_type}
                            onChange={(e) => setItem(index, { item_type: e.target.value as BoxItem["item_type"] })}
                          >
                            <option value="service">Servizio</option>
                            <option value="product">Prodotto</option>
                            <option value="custom">Voce</option>
                          </select>
                        </td>
                        <td>
                          {/* Markup legacy: i 3 selettori sempre in DOM, toggle d-none (giftbox.js refreshItemRow). */}
                          <select
                            className={`form-select form-select-sm item-service ${it.item_type !== "service" ? "d-none" : ""}`}
                            value={it.service_id || ""}
                            onChange={(e) => setItem(index, { service_id: Number(e.target.value) || 0 })}
                          >
                            <option value="">—</option>
                            {services.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>

                          <select
                            className={`form-select form-select-sm item-product mt-1 ${it.item_type !== "product" ? "d-none" : ""}`}
                            value={it.product_id || ""}
                            onChange={(e) => setItem(index, { product_id: Number(e.target.value) || 0 })}
                          >
                            <option value="">—</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>

                          <div className={`row g-2 mt-1 item-custom ${it.item_type !== "custom" ? "d-none" : ""}`}>
                            <div className="col-md-4">
                              <input
                                className="form-control form-control-sm"
                                placeholder="Titolo"
                                value={it.custom_label}
                                onChange={(e) => setItem(index, { custom_label: e.target.value })}
                              />
                            </div>
                            <div className="col-md-8">
                              <input
                                className="form-control form-control-sm"
                                placeholder="Dettagli (opzionale)"
                                value={it.custom_details}
                                onChange={(e) => setItem(index, { custom_details: e.target.value })}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="text-center">
                          <input
                            className="form-control form-control-sm text-center"
                            type="number"
                            min="1"
                            max="1000"
                            value={it.qty}
                            onChange={(e) => setItem(index, { qty: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                          />
                        </td>
                        <td className="text-end">
                          <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeItem(index)}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button className="btn btn-sm btn-outline-primary" type="button" onClick={addItem}>
                <i className="bi bi-plus-circle me-1" />
                Aggiungi riga
              </button>
            </div>

            <div className="col-12 d-flex gap-2 mt-3">
              <button className="btn btn-primary btn-pill" type="submit" disabled={saving}>
                <i className="bi bi-check2-circle me-1" />
                {saving ? "Salvataggio…" : "Salva GiftBox"}
              </button>
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox`}>
                Annulla
              </a>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
