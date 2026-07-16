"use client";

import { useEffect, useRef, useState } from "react";

// Port fedele della pagina GiftBox (app/pages/giftbox.php):
// - tab default (instances): filtri SERVER-SIDE Mittente (combobox ricercabile
//   con tutti i clienti) / Cerca (codice, destinatario, email) / Stato
//   (+ Tutte le sedi multi-sede), auto-expire al load, tabella Codice |
//   Mittente | Destinatario | Sede | Stato | Emessa | Scadenza | Riscatto |
//   Azioni con date raw (YYYY-MM-DD) e Codice -> voucher (?id=&embed=1).
// - tab=boxes: barra "Template GiftBox (contenuti + regole base)" + card
//   "GiftBox / N totali" (Nome | Stato | Costo punti | Livello | Contenuti |
//   Istanze | Validità | Modifica/Elimina con confirm legacy).
// Header comune gated: [← Fidelity][Impostazioni giftbox.settings]
// [Crea GiftBox pos.manage → pos] + flash ?msg/?err.

type GiftboxQuery = {
  tab?: string;
  q?: string;
  status?: string;
  client_id?: string;
  all_locations?: string;
  msg?: string;
  err?: string;
  // Pagina corrente (paginazione 25/pagina, miglioria 2026-07-16).
  p?: string;
};

// Badge 'Scade tra N giorni' (miglioria 2026-07-16): istanza ATTIVA (issued)
// con scadenza entro 14 giorni — le GiftBox vivono mesi come i pacchetti,
// quindi finestra 14 e non 7. Prima l'auto-expire marcava 'Scaduta' a cose
// fatte. expiresDate arriva come YYYY-MM-DD ('—' se assente).
export function giftboxExpiryWarning(expiresDate: string, status: string): string | null {
  if (status !== "issued") return null;
  const m = String(expiresDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((exp.getTime() - today.getTime()) / 86400000);
  if (days < 0 || days > 14) return null;
  if (days === 0) return "Scade oggi";
  if (days === 1) return "Scade domani";
  return `Scade tra ${days} giorni`;
}

type InstanceRow = {
  id: number;
  code: string;
  senderName: string;
  recipientLabel: string;
  locationLabel: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedDate: string;
  expiresDate: string;
  redeemedDate: string;
};

type ListPayload = {
  ok?: boolean;
  rows?: InstanceRow[];
  totalCount?: number;
  pageSize?: number;
  hasAnyInstances?: boolean;
  clientItems?: Array<{ id: string; label: string }>;
  showAllLocationsFilter?: boolean;
  canSettings?: boolean;
  canCreate?: boolean;
};

type Template = {
  id: number;
  name: string;
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

// fmt_points legacy: intero con separatore migliaia.
function fmtPoints(v: number): string {
  const n = Math.trunc(Number(v) || 0);
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".").replace(/^/, n < 0 ? "-" : "");
}

// giftbox_page_dt_display d/m/Y per la colonna Validità dei template.
function fmtDmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "—";
}

// norm() di giftbox.js: lowercase + rimozione accenti.
function normSearch(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Combobox filtro Mittente (gbInitFilterCombobox: dropdown-item + "Nessun
// risultato", voce "Tutti").
function SenderFilterCombobox({
  items,
  value,
  onChange,
}: {
  items: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
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
  const data = [{ id: "0", label: "Tutti" }, ...items];
  const q = normSearch(search);
  const shown = data.filter((it) => !q || normSearch(it.label).includes(q));
  const selected = data.find((it) => it.id === value);
  const hasSelection = value !== "" && value !== "0" && selected;
  return (
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} id="giftboxClientFilterBox" ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`app-combobox-text ${hasSelection ? "" : "d-none"}`}>{hasSelection ? selected?.label : ""}</span>
        <span className={`text-muted app-combobox-placeholder ${hasSelection ? "d-none" : ""}`}>Tutti</span>
      </button>
      <div className={`dropdown-menu p-2 w-100 ${open ? "show" : ""}`}>
        <input
          type="text"
          className="form-control form-control-sm app-combobox-search"
          placeholder="Cerca…"
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
                  onChange(it.id);
                  setSearch("");
                  setOpen(false);
                }}
              >
                {it.label}
              </button>
            ))
          )}
        </div>
      </div>
      <input type="hidden" name="client_id" value={value} readOnly />
    </div>
  );
}

export function GiftboxContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: GiftboxQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [tab] = useState<string>(() => {
    const t = String(initialQuery?.tab ?? (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") ?? "" : ""));
    return t === "boxes" ? "boxes" : "instances";
  });

  // Filtri applicati (form GET legacy: il submit naviga con i parametri).
  const [applied] = useState(() => ({
    clientId: String(initialQuery?.client_id ?? "0") || "0",
    q: String(initialQuery?.q ?? ""),
    status: String(initialQuery?.status ?? ""),
    allLocations: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").toLowerCase()),
    page: (() => { const n = Number.parseInt(String(initialQuery?.p ?? ""), 10); return Number.isFinite(n) && n >= 1 ? n : 1; })(),
  }));

  const [data, setData] = useState<ListPayload | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatePerms, setTemplatePerms] = useState({ canSettings: false, canCreate: false });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  const [clientFilter, setClientFilter] = useState(applied.clientId);
  const [q, setQ] = useState(applied.q);
  const [statusFilter, setStatusFilter] = useState(applied.status);
  const [allLocations, setAllLocations] = useState(applied.allLocations);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  useEffect(() => {
    if (tab === "boxes") {
      fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=templates`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((j) => {
          setTemplates(Array.isArray(j.templates) ? j.templates : []);
          setTemplatePerms({ canSettings: j.canSettings === true, canCreate: j.canCreate === true });
        })
        .catch(() => setTemplates([]))
        .finally(() => setLoading(false));
      return;
    }
    const params = new URLSearchParams({ slug, action: "manage_list" });
    if (applied.clientId !== "0") params.set("client_id", applied.clientId);
    if (applied.q !== "") params.set("q", applied.q);
    if (applied.status !== "") params.set("status", applied.status);
    if (applied.allLocations) params.set("all_locations", "1");
    params.set("p", String(applied.page ?? 1));
    fetch(`/api/manage/giftboxes?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ListPayload) => setData(j))
      .catch(() => setData({ rows: [], hasAnyInstances: false, clientItems: [] }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, tab]);

  function href(qs: string): string {
    return `/${encodeURIComponent(slug)}/${qs}`;
  }
  function listUrl(params?: URLSearchParams): string {
    const usable = params ?? new URLSearchParams();
    usable.set("tab", "instances");
    return href(`giftbox?${usable.toString()}`);
  }

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (clientFilter !== "" && clientFilter !== "0") params.set("client_id", clientFilter);
    if (q !== "") params.set("q", q);
    if (statusFilter !== "") params.set("status", statusFilter);
    if (allLocations) params.set("all_locations", "1");
    window.location.assign(listUrl(params));
  }

  // Cambio pagina: navigazione GET coi filtri applicati (?p=), come il submit.
  function goToPage(pageN: number) {
    const params = new URLSearchParams();
    if (applied.clientId !== "" && applied.clientId !== "0") params.set("client_id", applied.clientId);
    if (applied.q !== "") params.set("q", applied.q);
    if (applied.status !== "") params.set("status", applied.status);
    if (applied.allLocations) params.set("all_locations", "1");
    if (pageN > 1) params.set("p", String(Math.floor(pageN)));
    window.location.assign(listUrl(params));
  }

  // Elimina template (soft): confirm legacy + redirect flash 'GiftBox eliminata'
  // (il redirect legacy perde tab=boxes e torna alle istanze).
  async function deleteTemplate(t: Template) {
    if (busyId) return;
    if (!window.confirm("Eliminare questa GiftBox?")) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: String(t.id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        window.location.href = href(`giftbox?err=${encodeURIComponent(String(j?.error ?? "Errore GiftBox."))}`);
        return;
      }
      window.location.href = href(`giftbox?msg=${encodeURIComponent("GiftBox eliminata")}`);
    } finally {
      setBusyId(0);
    }
  }

  const rows = data?.rows ?? [];
  const hasAny = data?.hasAnyInstances ?? false;
  const showEmptyState = tab === "instances" && !loading && !hasAny;
  const canSettings = tab === "boxes" ? templatePerms.canSettings : data?.canSettings ?? false;
  const canCreate = tab === "boxes" ? templatePerms.canCreate : data?.canCreate ?? false;
  const showAllLocationsFilter = data?.showAllLocationsFilter ?? false;

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
          {canSettings ? (
            <a className="btn btn-outline-secondary btn-pill" href={href("giftbox_settings")}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
          ) : null}
          {canCreate && !showEmptyState ? (
            <a className="btn btn-primary btn-pill" href={href("pos")}>
              <i className="bi bi-plus-lg me-1" />
              Crea GiftBox
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );

  const flashAlerts = (
    <>
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
    </>
  );

  // Template grid (giftbox.php tab=boxes).
  if (tab === "boxes") {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />
        {header}
        {flashAlerts}

        <div className="d-flex justify-content-between align-items-center mb-3">
          <div className="text-muted small">Template GiftBox (contenuti + regole base)</div>
          <div className="d-flex gap-2">
            <a className="btn btn-primary btn-pill" href={href("giftbox?action=new")}>
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
                {loading ? (
                  <tr>
                    <td colSpan={8} className="text-muted small p-3">
                      Caricamento…
                    </td>
                  </tr>
                ) : (
                  <>
                    {templates.map((t) => (
                      <tr key={t.id}>
                        <td className="fw-semibold">{t.name}</td>
                        <td>
                          <span className={`badge text-bg-${t.active ? "success" : "secondary"}`}>{t.active ? "Attiva" : "Disattiva"}</span>
                        </td>
                        <td className="text-end">{t.pointsCost > 0 ? fmtPoints(t.pointsCost) : "0"}</td>
                        <td className="text-muted small">{t.levelLabel || "—"}</td>
                        <td className="text-center">{t.itemsCount}</td>
                        <td className="text-center">{t.instancesCount}</td>
                        <td className="text-muted small">
                          {t.validFrom !== "" || t.validTo !== "" ? `${t.validFrom !== "" ? fmtDmy(t.validFrom) : "—"} → ${t.validTo !== "" ? fmtDmy(t.validTo) : "—"}` : "—"}
                        </td>
                        <td className="text-end">
                          <a className="btn btn-sm btn-outline-primary" href={href(`giftbox?action=edit&id=${t.id}`)}>
                            Modifica
                          </a>{" "}
                          <a
                            className="btn btn-sm btn-outline-danger"
                            href={href(`giftbox?action=delete&id=${t.id}`)}
                            data-confirm="Eliminare questa GiftBox?"
                            aria-disabled={busyId === t.id}
                            onClick={(e) => {
                              e.preventDefault();
                              deleteTemplate(t);
                            }}
                          >
                            Elimina
                          </a>
                        </td>
                      </tr>
                    ))}
                    {templates.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="text-muted p-3">
                          Nessuna GiftBox.
                        </td>
                      </tr>
                    ) : null}
                  </>
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
      {flashAlerts}

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : showEmptyState ? (
        <div className="card border-0 shadow-sm giftbox-empty-card">
          <div className="giftbox-empty-state">
            <div className="giftbox-empty-icon" aria-hidden="true">
              <i className="bi bi-gift" />
            </div>
            <h2>Nessuna GiftBox presente</h2>
            <p>Le GiftBox emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario, scadenze, riscatti e sede di emissione.</p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              {canCreate ? (
                <a className="btn btn-primary" href={href("pos")}>
                  <i className="bi bi-plus-lg me-1" />
                  Crea GiftBox
                </a>
              ) : null}
              {canSettings ? (
                <a className="btn btn-outline-secondary" href={href("giftbox_settings")}>
                  <i className="bi bi-gear me-1" />
                  Impostazioni
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Lista istanze: filtri allineati alla pagina Pacchetti */}
          <div className="card p-3 mb-3">
            <form className="row g-2 align-items-end" method="get" onSubmit={applyFilters}>
              <div className="col-lg-3">
                <label className="form-label">Mittente</label>
                <SenderFilterCombobox items={data?.clientItems ?? []} value={clientFilter} onChange={setClientFilter} />
              </div>

              <div className={showAllLocationsFilter ? "col-lg-3" : "col-lg-4"}>
                <label className="form-label">Cerca</label>
                <input className="form-control" name="q" placeholder="Codice, destinatario..." value={q} onChange={(e) => setQ(e.target.value)} />
              </div>

              <div className={showAllLocationsFilter ? "col-lg-2" : "col-lg-3"}>
                <label className="form-label">Stato</label>
                <select className="form-select" name="status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">Tutti</option>
                  <option value="issued">Attiva</option>
                  <option value="redeemed">Riscattata</option>
                  <option value="expired">Scaduta</option>
                  <option value="cancelled">Annullata</option>
                </select>
              </div>

              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Filtra pieno a larghezza naturale, Reset
                  (prima assente) visibile solo con filtri attivi. */}
              {showAllLocationsFilter ? (
                <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail">
                  <div className="form-check form-switch mb-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="giftboxAllLocations"
                      name="all_locations"
                      value="1"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="giftboxAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                </div>
              ) : null}

              {/* col-auto: il bottone si accoda ai campi (leggero distacco ms-lg-2)
                  invece di galleggiare in una colonna fissa di griglia. */}
              <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail gap-2 ms-lg-2">
                <button className="btn btn-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {applied.clientId !== "0" || applied.q !== "" || applied.status !== "" || applied.allLocations ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={listUrl()}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header bg-transparent d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
              <span className="text-muted small">
                {(() => {
                  const total = Number(data?.totalCount ?? rows.length);
                  const pageSize = Math.max(1, Number(data?.pageSize ?? 25));
                  return (
                    <>
                      {loading ? "Caricamento…" : total === 1 ? "1 GiftBox" : `${total} GiftBox`}
                      {!loading && total > pageSize ? ` · pagina ${applied.page} di ${Math.max(1, Math.ceil(total / pageSize))}` : ""}
                      {!loading && (applied.clientId !== "0" || applied.q !== "" || applied.status !== "" || applied.allLocations) ? " · filtri attivi" : ""}
                    </>
                  );
                })()}
              </span>
              {!loading && Number(data?.totalCount ?? 0) > Math.max(1, Number(data?.pageSize ?? 25)) ? (
                <div className="d-flex align-items-center gap-1">
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={applied.page <= 1} onClick={() => goToPage(applied.page - 1)}>
                    <i className="bi bi-chevron-left" />
                  </button>
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={applied.page >= Math.ceil(Number(data?.totalCount ?? 0) / Math.max(1, Number(data?.pageSize ?? 25)))} onClick={() => goToPage(applied.page + 1)}>
                    <i className="bi bi-chevron-right" />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Codice</th>
                    <th>Mittente</th>
                    <th>Destinatario</th>
                    <th>Sede</th>
                    <th>Stato</th>
                    <th>Emessa</th>
                    <th>Scadenza</th>
                    <th>Riscatto</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-semibold">
                        <a className="text-decoration-none" target="_blank" rel="noopener" href={href(`giftbox_voucher?id=${r.id}&embed=1`)} title="Apri voucher / stampa">
                          {r.code}
                        </a>
                      </td>
                      <td>{r.senderName}</td>
                      <td className="text-muted">{r.recipientLabel}</td>
                      <td className="text-muted">{r.locationLabel}</td>
                      <td>
                        <span className={`badge bg-${r.statusBadge}`}>{r.statusLabel}</span>
                      </td>
                      <td className="text-muted">{r.issuedDate}</td>
                      <td className="text-muted">
                        {r.expiresDate}
                        {(() => {
                          const warn = giftboxExpiryWarning(r.expiresDate, r.status);
                          return warn ? (
                            <>
                              {" "}
                              <span className="badge text-bg-warning">{warn}</span>
                            </>
                          ) : null;
                        })()}
                      </td>
                      <td className="text-muted">{r.redeemedDate}</td>
                      <td className="text-end">
                        <a
                          className="btn btn-sm btn-outline-secondary me-1"
                          target="_blank"
                          rel="noopener"
                          href={href(`giftbox_voucher?id=${r.id}&embed=1`)}
                          title="Voucher / stampa"
                        >
                          <i className="bi bi-printer" />
                        </a>
                        <a className="btn btn-sm btn-outline-secondary" href={href(`giftbox?tab=instances&action=edit_instance&id=${r.id}`)}>
                          Dettaglio
                        </a>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-muted p-3">
                        Nessuna GiftBox trovata con i filtri selezionati.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
