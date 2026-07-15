"use client";

import { useEffect, useRef, useState } from "react";

// Port fedele della LISTA preventivi (app/pages/quotes.php action=list):
// filtri server-side Cliente (combobox ricercabile) / Stato / Data / Numero
// (+ "Tutte le sedi" multi-sede), tabella Data/Numero/Cliente/Sede/Stato/
// Totale/Azioni con stato EFFETTIVO (auto-expire + paid-sync lato server),
// Elimina solo per le bozze, empty state e flash ?msg/?err.

type QuotesQuery = {
  client_id?: string;
  status?: string;
  date?: string;
  number?: string;
  all_locations?: string;
  msg?: string;
  err?: string;
};

type ListRow = {
  id: number;
  date: string;
  number: string;
  client: string;
  location: string;
  statusKey: string;
  statusLabel: string;
  badge: string;
  total: number;
  canDelete: boolean;
};

type ListPayload = {
  ok?: boolean;
  rows?: ListRow[];
  hasAnyQuotes?: boolean;
  clientItems?: Array<{ id: string; label: string }>;
  multiLocation?: boolean;
  canSettings?: boolean;
};

// $allowedStatus (ordine legacy del select Stato).
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "draft", label: "Bozza" },
  { value: "sent", label: "Inviato" },
  { value: "expired", label: "Scaduto" },
  { value: "accepted", label: "Accettato" },
  { value: "paid", label: "Pagato" },
  { value: "rejected", label: "Rifiutato" },
  { value: "canceled", label: "Annullato" },
];

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// $fmtMoney: number_format(2, ',', '.') — port manuale (toLocaleString it-IT
// non raggruppa 1000-9999).
function fmtMoney(v: number): string {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// $fmtDate: d/m/Y, '—' se vuota.
function fmtDate(d: string): string {
  const s = String(d ?? "").trim();
  if (s === "") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

// norm() di quotes.js: lowercase + rimozione accenti.
function normSearch(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Combobox filtro Cliente (markup app-combobox + comportamento quotes.js:
// dropdown-item, ricerca normalizzata, "Nessun risultato").
function ClientFilterCombobox({
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
    <div className={`app-combobox dropdown ${open ? "show" : ""}`} id="clientFilterBox" ref={boxRef}>
      <button
        className="btn btn-outline-secondary dropdown-toggle w-100 app-combobox-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`app-combobox-text ${hasSelection ? "" : "d-none"}`}>{hasSelection ? selected?.label : ""}</span>
        <span className={`text-muted app-combobox-placeholder ${hasSelection ? "d-none" : ""}`}>Tutti</span>
      </button>
      <div className={`dropdown-menu p-2 ${open ? "show" : ""}`}>
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

export function QuotesContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: QuotesQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  // Filtri applicati (dalla querystring, come il form GET legacy).
  const [applied] = useState(() => ({
    clientId: String(initialQuery?.client_id ?? "0") || "0",
    status: String(initialQuery?.status ?? ""),
    date: String(initialQuery?.date ?? ""),
    number: String(initialQuery?.number ?? ""),
    allLocations: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").toLowerCase()),
  }));

  const [data, setData] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(0);

  // Stato del form filtri (GET come il legacy: il submit naviga con i parametri).
  const [clientId, setClientId] = useState(applied.clientId);
  const [status, setStatus] = useState(applied.status);
  const [date, setDate] = useState(applied.date);
  const [number, setNumber] = useState(applied.number);
  const [allLocations, setAllLocations] = useState(applied.allLocations);

  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  useEffect(() => {
    const params = new URLSearchParams({ slug, action: "list" });
    if (applied.clientId !== "0") params.set("client_id", applied.clientId);
    if (applied.status !== "") params.set("status", applied.status);
    if (applied.date !== "") params.set("date", applied.date);
    if (applied.number !== "") params.set("number", applied.number);
    if (applied.allLocations) params.set("all_locations", "1");
    fetch(`/api/manage/quotes?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: ListPayload) => setData(j))
      .catch(() => setData({ rows: [], hasAnyQuotes: false, clientItems: [] }))
      .finally(() => setLoading(false));
  }, [slug, applied]);

  function listUrl(params?: URLSearchParams): string {
    const qs = params && Array.from(params.keys()).length > 0 ? `?${params.toString()}` : "";
    return `/${encodeURIComponent(slug)}/quotes${qs}`;
  }

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (clientId !== "" && clientId !== "0") params.set("client_id", clientId);
    if (status !== "") params.set("status", status);
    if (date !== "") params.set("date", date);
    if (number !== "") params.set("number", number);
    if (allLocations) params.set("all_locations", "1");
    window.location.href = listUrl(params);
  }

  // Elimina (solo bozze): confirm legacy + redirect con flash msg/err.
  async function deleteQuote(id: number) {
    if (busyId) return;
    if (!window.confirm("Eliminare questo preventivo?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/manage/quotes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: String(id) }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.redirect === "view" && j?.id) {
        window.location.href = `/${encodeURIComponent(slug)}/quotes?action=view&id=${j.id}${j?.err ? `&err=${encodeURIComponent(String(j.err))}` : ""}`;
        return;
      }
      const params = new URLSearchParams();
      if (j?.msg) params.set("msg", String(j.msg));
      else if (j?.err) params.set("err", String(j.err));
      window.location.href = listUrl(params);
    } finally {
      setBusyId(0);
    }
  }

  const rows = data?.rows ?? [];
  const hasAnyQuotes = data?.hasAnyQuotes ?? false;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/quotes.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Vendite</div>
          <h1 className="bs-page-title">Preventivi</h1>
          <div className="bs-page-subtitle">Crea e gestisci preventivi per i tuoi clienti.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            {data?.canSettings ? (
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/quote_settings`}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            ) : null}
            {hasAnyQuotes ? (
              <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/quotes?action=new`}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo preventivo
              </a>
            ) : null}
          </div>
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

      {loading ? (
        <div className="card p-3 text-muted small">Caricamento…</div>
      ) : !hasAnyQuotes ? (
        <div className="card border-0 shadow-sm quotes-empty-card">
          <div className="quotes-empty-state">
            <div className="quotes-empty-icon" aria-hidden="true">
              <i className="bi bi-file-earmark-text" />
            </div>
            <h2>Nessun preventivo presente</h2>
            <p>
              Crea il primo preventivo per preparare proposte, inviarle ai clienti e trasformarle in vendite quando
              vengono accettate.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={`/${encodeURIComponent(slug)}/quotes?action=new`}>
                <i className="bi bi-plus-lg me-1" />
                Nuovo preventivo
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form method="get" className="row g-2 align-items-end" onSubmit={applyFilters}>
              <div className="col-lg-3">
                <label className="form-label">Cliente</label>
                <ClientFilterCombobox items={data?.clientItems ?? []} value={clientId} onChange={setClientId} />
              </div>

              <div className="col-lg-2">
                <label className="form-label">Stato</label>
                <select className="form-select" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Tutti</option>
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-lg-2">
                <label className="form-label">Data</label>
                <input type="date" className="form-control" name="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>

              <div className="col-lg-2">
                <label className="form-label">Numero</label>
                <input
                  className="form-control"
                  name="number"
                  value={number}
                  placeholder="Es. 12/2026"
                  onChange={(e) => setNumber(e.target.value)}
                />
              </div>

              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Filtra pieno a larghezza naturale, Reset
                  visibile solo con filtri attivi. */}
              {/* col-auto: la coda (switch+bottoni) si accoda ai campi con leggero
                  distacco invece di una colonna fissa di griglia. */}
              <div className="col-12 col-lg-auto d-flex align-items-end gap-2 ms-lg-2 flex-wrap">
                {data?.multiLocation ? (
                  <div className="form-check form-switch mb-0 pb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="quotesAllLocations"
                      name="all_locations"
                      value="1"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="quotesAllLocations">
                      Tutte le sedi
                    </label>
                  </div>
                ) : null}
                <button className="btn btn-primary" type="submit">
                  <i className="bi bi-search me-1" />
                  Filtra
                </button>
                {applied.clientId !== "0" || applied.status !== "" || applied.date !== "" || applied.number !== "" || applied.allLocations ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={listUrl()}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header bg-transparent py-2">
              <span className="text-muted small">
                {loading ? "Caricamento…" : rows.length === 1 ? "1 preventivo" : `${rows.length} preventivi`}
                {!loading && (applied.clientId !== "0" || applied.status !== "" || applied.date !== "" || applied.number !== "" || applied.allLocations) ? " · filtri attivi" : ""}
              </span>
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Numero</th>
                    <th>Cliente</th>
                    <th>Sede</th>
                    <th>Stato</th>
                    <th className="text-end">Totale</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.date)}</td>
                      <td className="fw-semibold">{r.number || "—"}</td>
                      <td>{r.client}</td>
                      <td>{r.location}</td>
                      <td>
                        <span className={`badge text-bg-${r.badge}`}>{r.statusLabel}</span>
                      </td>
                      <td className="text-end fw-semibold">€ {fmtMoney(r.total)}</td>
                      <td className="text-end">
                        <a className="btn btn-sm btn-outline-secondary" href={`/${encodeURIComponent(slug)}/quotes?action=view&id=${r.id}`}>
                          Apri
                        </a>{" "}
                        {r.canDelete ? (
                          <a
                            className="btn btn-sm btn-outline-danger"
                            href={`/${encodeURIComponent(slug)}/quotes?action=delete&id=${r.id}`}
                            data-confirm="Eliminare questo preventivo?"
                            aria-disabled={busyId === r.id}
                            onClick={(e) => {
                              e.preventDefault();
                              deleteQuote(r.id);
                            }}
                          >
                            Elimina
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-muted p-3">
                        Nessun preventivo trovato con i filtri selezionati.
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
