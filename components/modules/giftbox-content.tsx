"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Faithful port of the PHP giftbox page (app/pages/giftbox.php):
// - tab default (instances): filtri Mittente / Cerca / Stato (+ Tutte le sedi
//   multi-sede), tabella Codice | Mittente | Destinatario | [Sede] | Stato |
//   Emessa | Scadenza | Riscatto | Azioni con badge legacy e Codice → voucher.
// - tab=boxes: barra "Template GiftBox (contenuti + regole base)" + card
//   "GiftBox / N totali" con colonne Nome | Stato | Costo punti | Livello |
//   Contenuti | Istanze | Validità | azioni (Modifica / Elimina con confirm
//   legacy "Eliminare questa GiftBox?").
// Header comune: [← Fidelity][Impostazioni][Crea GiftBox → pos (se non vuota)].

type InstanceRow = {
  id: number;
  code: string;
  publicToken: string;
  senderId: number;
  senderName: string;
  recipientName: string;
  recipientEmail: string;
  locationName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string;
};

type Template = {
  id: number;
  name: string;
  description: string;
  active: boolean;
  pointsCost: number;
  itemsCount: number;
  instancesCount: number;
  levelLabel: string;
  validFrom: string;
  validTo: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function currentTab(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("tab") ?? "";
}

function fmtDmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "—";
}

export function GiftboxContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [tab] = useState<string>(currentTab);
  const [rows, setRows] = useState<InstanceRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [locationsCount, setLocationsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [busyId, setBusyId] = useState(0);
  // Filtri legacy (form GET): applicati al submit "Filtra".
  const [clientFilter, setClientFilter] = useState(0);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [allLocations, setAllLocations] = useState(false);
  const [applied, setApplied] = useState({ clientFilter: 0, q: "", statusFilter: "" });

  const loadTemplates = useCallback(() => {
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=templates`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setTemplates(Array.isArray(j.templates) ? j.templates : []))
      .catch(() => setTemplates([]))
      .finally(() => setLoadingTemplates(false));
  }, [slug]);

  const loadInstances = useCallback((all?: boolean) => {
    setLoading(true);
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=manage_list${all ? "&all_locations=1" : ""}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        setRows(Array.isArray(j.rows) ? j.rows : []);
        setTotalCount(Number(j.totalCount ?? 0));
        setLocationsCount(Number(j.locationsCount ?? 0));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [slug]);

  // Soft-delete a giftbox template via POST (issued instances keep their snapshot).
  async function deleteTemplate(t: Template) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questa GiftBox?")) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: t.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare la GiftBox.");
      } else {
        loadTemplates();
      }
    } finally {
      setBusyId(0);
    }
  }

  useEffect(() => {
    if (tab === "boxes") {
      loadTemplates();
      return;
    }
    loadInstances();
  }, [tab, loadTemplates, loadInstances]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${suffix.replace("&", "?")}`;
  }
  function voucherHref(r: InstanceRow): string {
    return `/${encodeURIComponent(slug)}/giftbox_voucher?public=1&embed=1&token=${encodeURIComponent(r.publicToken)}`;
  }

  const senderOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of rows) if (r.senderId > 0 && !seen.has(r.senderId)) seen.set(r.senderId, r.senderName);
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = applied.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (applied.clientFilter > 0 && r.senderId !== applied.clientFilter) return false;
      // Il filtro Stato legacy usa "issued" come Attiva.
      if (applied.statusFilter !== "" && r.status !== applied.statusFilter) return false;
      if (needle !== "" && !`${r.code} ${r.recipientName} ${r.recipientEmail} ${r.senderName}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, applied]);

  const hasAny = totalCount > 0;
  const showEmptyState = tab !== "boxes" && !loading && !hasAny;
  const showLocationCol = rows.some((r) => r.locationName !== "") || locationsCount > 1;
  const colCount = showLocationCol ? 9 : 8;

  const header = (
    <div className="bs-page-header">
      <div className="bs-page-heading">
        <div className="bs-page-kicker">Programma fedelta</div>
        <h1 className="bs-page-title">Fidelity / GiftBox</h1>
        <div className="bs-page-subtitle">Gestisci template, voucher e GiftBox emesse.</div>
      </div>
      <div className="bs-page-actions">
        <div className="d-flex gap-2">
          <a className="btn btn-outline-secondary btn-pill" href={href("fidelity")}>
            <i className="bi bi-arrow-left me-1" />
            Fidelity
          </a>
          <a className="btn btn-outline-secondary btn-pill" href={href("giftbox_settings")}>
            <i className="bi bi-gear me-1" />
            Impostazioni
          </a>
          {(tab === "boxes" || hasAny) && !showEmptyState ? (
            <a className="btn btn-primary btn-pill" href={href("pos")}>
              <i className="bi bi-plus-lg me-1" />
              Crea GiftBox
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );

  // Template grid (giftbox.php tab=boxes).
  if (tab === "boxes") {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />
        {header}

        <div className="d-flex justify-content-between align-items-center mb-3">
          <div className="text-muted small">Template GiftBox (contenuti + regole base)</div>
          <div className="d-flex gap-2">
            <a className="btn btn-primary btn-pill" href={href("giftbox&action=new")}>
              <i className="bi bi-plus-circle me-1" />
              Nuova GiftBox
            </a>
          </div>
        </div>

        <div className="card">
          <div className="card-header d-flex justify-content-between align-items-center">
            <div className="fw-semibold">GiftBox</div>
            <div className="text-muted small">{templates.length} totali</div>
          </div>
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Stato</th>
                  <th className="text-end">Costo punti</th>
                  <th>Livello</th>
                  <th className="text-center">Contenuti</th>
                  <th className="text-center">Istanze</th>
                  <th>Validità</th>
                  <th className="text-end" />
                </tr>
              </thead>
              <tbody>
                {loadingTemplates ? (
                  <tr>
                    <td colSpan={8} className="text-muted small p-3">
                      Caricamento…
                    </td>
                  </tr>
                ) : templates.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted p-3">
                      Nessuna GiftBox.
                    </td>
                  </tr>
                ) : (
                  templates.map((t) => (
                    <tr key={t.id}>
                      <td className="fw-semibold">
                        {t.name}
                        {t.description !== "" ? <div className="text-muted small fw-normal">{t.description}</div> : null}
                      </td>
                      <td>
                        <span className={`badge ${t.active ? "text-bg-success" : "text-bg-secondary"}`}>{t.active ? "Attiva" : "Disattiva"}</span>
                      </td>
                      <td className="text-end">{t.pointsCost > 0 ? t.pointsCost : "—"}</td>
                      <td className="text-muted">{t.levelLabel}</td>
                      <td className="text-center">{t.itemsCount}</td>
                      <td className="text-center">{t.instancesCount}</td>
                      <td className="text-muted">
                        {t.validFrom !== "" || t.validTo !== "" ? `${t.validFrom !== "" ? fmtDmy(t.validFrom) : "—"} → ${t.validTo !== "" ? fmtDmy(t.validTo) : "—"}` : "—"}
                      </td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" href={href(`giftbox&action=edit&id=${t.id}`)}>
                          Modifica
                        </a>{" "}
                        <button type="button" className="btn btn-sm btn-outline-danger" disabled={busyId === t.id} onClick={() => deleteTemplate(t)}>
                          Elimina
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Vista istanze emesse (tab default).
  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />
      {header}

      {showEmptyState ? (
        <div className="card border-0 shadow-sm giftbox-empty-card">
          <div className="giftbox-empty-state">
            <div className="giftbox-empty-icon" aria-hidden="true">
              <i className="bi bi-gift" />
            </div>
            <h2>Nessuna GiftBox presente</h2>
            <p>Le GiftBox emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario, scadenze, riscatti e sede di emissione.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={href("pos")}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftBox
              </a>
              <a className="btn btn-outline-secondary" href={href("giftbox_settings")}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied({ clientFilter, q, statusFilter });
                loadInstances(allLocations);
              }}
            >
              <div className="col-lg-3">
                <label className="form-label small">Mittente</label>
                <select className="form-select" value={String(clientFilter)} onChange={(e) => setClientFilter(Number(e.target.value) || 0)}>
                  <option value="0">Tutti</option>
                  {senderOptions.map(([id, name]) => (
                    <option value={id} key={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-lg-3">
                <label className="form-label small">Cerca</label>
                <input className="form-control" name="q" placeholder="Codice, destinatario..." value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="col-lg-2">
                <label className="form-label small">Stato</label>
                <select className="form-select" name="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tutti</option>
                  <option value="issued">Attiva</option>
                  <option value="redeemed">Riscattata</option>
                  <option value="expired">Scaduta</option>
                  <option value="cancelled">Annullata</option>
                </select>
              </div>
              {locationsCount > 1 ? (
                <div className="col-lg-2 d-flex align-items-center">
                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="giftboxAllLocations"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="giftboxAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                </div>
              ) : null}
              <div className="col-lg-2 d-flex align-items-end gap-2">
                <button className="btn btn-outline-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Codice</th>
                    <th>Mittente</th>
                    <th>Destinatario</th>
                    {showLocationCol ? <th>Sede</th> : null}
                    <th>Stato</th>
                    <th>Emessa</th>
                    <th>Scadenza</th>
                    <th>Riscatto</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={colCount} className="text-muted small p-3">
                        Caricamento…
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={colCount} className="text-muted p-3">
                        Nessuna GiftBox trovata con i filtri selezionati.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((r) => (
                      <tr key={r.id}>
                        <td className="fw-semibold">
                          <a href={voucherHref(r)} target="_blank" rel="noopener">
                            {r.code || `#${r.id}`}
                          </a>
                        </td>
                        <td className="text-muted">{r.senderName}</td>
                        <td className="text-muted">{r.recipientName}</td>
                        {showLocationCol ? <td className="text-muted">{r.locationName || "—"}</td> : null}
                        <td>
                          <span className={`badge ${r.statusBadge}`}>{r.statusLabel}</span>
                        </td>
                        <td className="text-muted">{r.issuedAt || "—"}</td>
                        <td className="text-muted">{r.expiresAt || "—"}</td>
                        <td className="text-muted">{r.redeemedAt || "—"}</td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-secondary" title="Voucher" target="_blank" rel="noopener" href={voucherHref(r)}>
                            <i className="bi bi-printer" />
                          </a>{" "}
                          <a className="btn btn-sm btn-outline-secondary" href={href(`giftbox&action=edit_instance&id=${r.id}`)}>
                            Dettaglio
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
