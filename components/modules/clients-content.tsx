"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP clients list page (app/pages/clients.php, action=list),
// fed by the DB-backed /api/manage/clients (legacy ordering created_at DESC LIMIT
// 200, unknown-client filter, strict sede filter, blocked INCLUDED with the
// "Disattivato" badge). Renders the legacy empty state, the redirect flash
// (?msg=&err=), the birthday badge and the permission-gated header/row actions.

type Client = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  locationId?: number;
  archived?: boolean;
  createdAt?: string;
  registrationDate?: string;
  birthDate?: string;
  city?: string;
  province?: string;
};

type ClientsPerms = {
  clientsManage: boolean;
  clientSheetsManage: boolean;
};

export type ClientsQuery = {
  q?: string;
  all_locations?: string;
  msg?: string;
  err?: string;
  // Pagina corrente (paginazione 50/pagina, miglioria 2026-07-16).
  p?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// d/m/Y from an ISO date/datetime prefix.
function fmtDate(iso?: string): string {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

// Port of client_birthday_badge_meta(): today -> red pill, else "Tra N giorni"
// soft badge; no/invalid date -> muted "—" (days null).
function birthdayBadge(birthDate?: string): { label: string; className: string; days: number | null } {
  const m = String(birthDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { label: "—", className: "text-muted small", days: null };
  const month = Number(m[2]);
  const day = Number(m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const make = (year: number): Date | null => {
    const dt = new Date(year, month - 1, day);
    if (dt.getMonth() !== month - 1) {
      // 29/02 in un anno non bisestile -> 28/02 (fallback legacy).
      if (month === 2 && day === 29) return new Date(year, 1, 28);
      return null;
    }
    return dt;
  };
  let next = make(today.getFullYear());
  if (!next) return { label: "—", className: "text-muted small", days: null };
  if (next < today) next = make(today.getFullYear() + 1);
  if (!next) return { label: "—", className: "text-muted small", days: null };
  const days = Math.round((next.getTime() - today.getTime()) / 86400000);
  if (days <= 0) return { label: "Oggi è il suo compleanno", className: "badge rounded-pill text-bg-danger", days: 0 };
  return { label: `Tra ${days} ${days === 1 ? "giorno" : "giorni"}`, className: "badge badge-soft", days };
}

// Iscrizione column: registration_date, else created_at (d/m/Y).
function iscrizioneLabel(c: Client): string {
  if (c.registrationDate && c.registrationDate !== "") return fmtDate(c.registrationDate);
  if (c.createdAt) return fmtDate(c.createdAt);
  return "—";
}

export function ClientsContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ClientsQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clients, setClients] = useState<Client[]>([]);
  const [locations, setLocations] = useState<Record<number, string>>({});
  const [locationsCount, setLocationsCount] = useState(0);
  const [hasAnyClients, setHasAnyClients] = useState(true);
  const [perms, setPerms] = useState<ClientsPerms>({ clientsManage: true, clientSheetsManage: true });
  const [q, setQ] = useState(() => initialQuery?.q ?? "");
  const [allLocations, setAllLocations] = useState(() =>
    ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
  );
  // Filtri APPLICATI (≠ bozza nei campi): guidano il Reset condizionale e il
  // '· filtri attivi' nell'header tabella (restyle 2026-07-15); si aggiornano
  // solo al submit, come il GET legacy.
  const [applied, setApplied] = useState<{ q: string; all: boolean }>(() => ({
    q: String(initialQuery?.q ?? ""),
    all: ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()),
  }));
  const [loading, setLoading] = useState(true);
  // Paginazione (miglioria 2026-07-16): 50/pagina lato server al posto del
  // LIMIT 200 secco del legacy. page dalla querystring ?p=, totale filtrato
  // dal server per il pager.
  const [page, setPage] = useState(() => {
    const n = Number.parseInt(String(initialQuery?.p ?? ""), 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  });
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // Gate pagina legacy (clients.php requireAnyPerm sui 3 permessi clienti): la
  // route API ora ammette anche i permessi agenda per la ricerca del drawer, la
  // PAGINA si gata col flag pageAllowed -> card 'Accesso negato'.
  const [accessDenied, setAccessDenied] = useState(false);
  // Flash legacy (View::alert): ?msg= success + ?err= danger dal redirect.
  const [flash] = useState<{ msg?: string; err?: string }>(() => ({ msg: initialQuery?.msg, err: initialQuery?.err }));

  // Fetch puro (setState nei callback della Promise; loading gia' true di default).
  const fetchData = useCallback(
    (query: string, all: boolean, pageN = 1) => {
      fetch(
        `/api/manage/clients?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(query)}${all ? "&all_locations=1" : ""}&p=${Math.max(1, pageN)}`,
        { headers: { "x-tenant-slug": slug } },
      )
        .then((r) => r.json())
        .then((j) => {
          if (j?.pageAllowed === false) setAccessDenied(true);
          setClients(Array.isArray(j.clients) ? j.clients : []);
          setTotalCount(Number(j.totalCount ?? (Array.isArray(j.clients) ? j.clients.length : 0)));
          setPageSize(Math.max(1, Number(j.pageSize ?? 50)));
          setHasAnyClients(Boolean(j.hasAnyClients ?? (Array.isArray(j.clients) && j.clients.length > 0)));
          if (j.perms) {
            setPerms({
              clientsManage: Boolean(j.perms.clientsManage),
              clientSheetsManage: Boolean(j.perms.clientSheetsManage),
            });
          }
        })
        .catch(() => setClients([]))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    const p0 = Number.parseInt(String(initialQuery?.p ?? ""), 10);
    fetchData(initialQuery?.q ?? "", ["1", "true", "on", "yes", "all"].includes(String(initialQuery?.all_locations ?? "").trim().toLowerCase()), Number.isFinite(p0) && p0 >= 1 ? p0 : 1);
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const map: Record<number, string> = {};
        const rows = Array.isArray(j.locations) ? j.locations : [];
        for (const loc of rows) map[Number(loc.id)] = String(loc.name ?? "");
        setLocations(map);
        setLocationsCount(rows.length);
      })
      .catch(() => {});
    // initialQuery è il GET del primo render (parity col server PHP): il refetch
    // avviene solo dal submit "Cerca".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, slug]);

  const load = useCallback(
    (query: string, all: boolean, pageN = 1) => {
      setLoading(true);
      fetchData(query, all, pageN);
    },
    [fetchData],
  );

  // Cambio pagina: aggiorna stato + URL (?p=) e rifetcha coi filtri applicati.
  const goToPage = useCallback(
    (pageN: number) => {
      const p = Math.max(1, Math.floor(pageN));
      setPage(p);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (p > 1) url.searchParams.set("p", String(p));
        else url.searchParams.delete("p");
        window.history.replaceState(null, "", url.toString());
        window.scrollTo(0, 0);
      }
      load(applied.q, applied.all, p);
    },
    [applied, load],
  );

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`clients${suffix}`.replace("&", "?")}`;
  }

  // Mantiene l'URL allineato (il form legacy è un GET con ?q=&all_locations=).
  // Una nuova ricerca riparte sempre da pagina 1 (?p= rimosso).
  function syncUrl(query: string, all: boolean) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("msg");
    url.searchParams.delete("err");
    url.searchParams.delete("p");
    if (query !== "") url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (all) url.searchParams.set("all_locations", "1");
    else url.searchParams.delete("all_locations");
    window.history.replaceState(null, "", url.toString());
  }

  const showEmptyState = !loading && !hasAnyClients;
  // Legacy: il filtro "Tutte le sedi" esiste solo per i tenant multi-sede.
  const showAllLocationsFilter = locationsCount > 1;

  // Port della pagina 403 di requireAnyPerm (clients.php): card 'Accesso negato'.
  if (accessDenied) {
    return (
      <div className="container-fluid">
        <div className="card p-4">
          <div className="h4 fw-semibold mb-2">Accesso negato</div>
          <div className="text-muted">Non hai i permessi per accedere a questa sezione.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      {flash.msg ? (
        <div className="alert alert-success d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.msg}</div>
        </div>
      ) : null}
      {flash.err ? (
        <div className="alert alert-danger d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{flash.err}</div>
        </div>
      ) : null}

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Anagrafica</div>
          <h1 className="bs-page-title">Clienti</h1>
          <div className="bs-page-subtitle">Anagrafiche clienti, contatti, schede e storico.</div>
        </div>
        <div className="bs-page-actions">
          {perms.clientSheetsManage ? (
            <a className="btn btn-outline-primary" href={`/${encodeURIComponent(slug)}/client_sheet_templates`}>
              <i className="bi bi-sliders me-1" />
              Configura schede
            </a>
          ) : null}
          {perms.clientsManage && hasAnyClients ? (
            <a className="btn btn-primary" href={href("&action=new")}>
              <i className="bi bi-plus-lg me-1" />
              Nuovo
            </a>
          ) : null}
        </div>
      </div>

      {showEmptyState ? (
        <div className="card border-0 shadow-sm clients-empty-card">
          <div className="clients-empty-state">
            <div className="clients-empty-icon" aria-hidden="true">
              <i className="bi bi-people" />
            </div>
            <h2>Nessun cliente presente</h2>
            <p>Crea il primo cliente per iniziare a registrare prenotazioni, vendite, pacchetti e consensi.</p>
            {perms.clientsManage ? (
              <div className="d-flex justify-content-center gap-2 flex-wrap">
                <a className="btn btn-primary" href={href("&action=new")}>
                  <i className="bi bi-plus-lg me-1" />
                  Nuovo cliente
                </a>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="card p-3 mb-3">
            <form
              className="row g-2 align-items-end"
              onSubmit={(e) => {
                e.preventDefault();
                // Nuova ricerca -> sempre da pagina 1 (e ?p= rimosso dall'URL).
                setApplied({ q: q.trim(), all: allLocations });
                setPage(1);
                syncUrl(q, allLocations);
                load(q, allLocations, 1);
              }}
            >
              <div className={showAllLocationsFilter ? "col-lg-8" : "col-lg-10"}>
                <label className="form-label">Cerca</label>
                <input
                  className="form-control"
                  name="q"
                  placeholder="Cerca per nome/telefono/email"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              {/* Restyle filtri 2026-07-15 (pattern unificato): switch (solo stile,
                  si applica al submit), Cerca pieno a larghezza naturale, Reset
                  visibile solo con filtri attivi. */}
              {showAllLocationsFilter ? (
                <div className="col-12 col-lg-auto d-flex align-items-center align-self-end app-filter-tail">
                  <div className="form-check form-switch mb-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="clientsAllLocations"
                      name="all_locations"
                      value="1"
                      checked={allLocations}
                      onChange={(e) => setAllLocations(e.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="clientsAllLocations">
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
                  Cerca
                </button>
                {applied.q !== "" || applied.all ? (
                  <a className="btn btn-link text-secondary text-decoration-none px-2" href={href("")}>
                    Reset
                  </a>
                ) : null}
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header bg-transparent d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
              <span className="text-muted small">
                {loading ? "Caricamento…" : totalCount === 1 ? "1 cliente" : `${totalCount} clienti`}
                {!loading && totalCount > pageSize ? ` · pagina ${page} di ${Math.max(1, Math.ceil(totalCount / pageSize))}` : ""}
                {!loading && (applied.q !== "" || applied.all) ? " · filtri attivi" : ""}
              </span>
              {!loading && totalCount > pageSize ? (
                <div className="d-flex align-items-center gap-1">
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                    <i className="bi bi-chevron-left" />
                  </button>
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page >= Math.ceil(totalCount / pageSize)} onClick={() => goToPage(page + 1)}>
                    <i className="bi bi-chevron-right" />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="table-responsive">
              <table className="table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Contatti</th>
                    <th>Sede</th>
                    <th>Iscrizione</th>
                    <th>Compleanno</th>
                    <th className="text-end">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-muted p-3">
                        {loading ? "Caricamento…" : "Nessun cliente trovato con i filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    clients.map((client) => {
                      const bday = birthdayBadge(client.birthDate);
                      return (
                        <tr key={client.id}>
                          <td>
                            <div className="fw-semibold d-flex align-items-center gap-2 flex-wrap">
                              <span>{client.name}</span>
                              {client.archived ? <span className="badge text-bg-warning">Disattivato</span> : null}
                            </div>
                            <div className="text-muted small">
                              {(client.city ?? "") !== "" ? client.city : "—"}{" "}
                              {(client.province ?? "") !== "" ? `• ${client.province}` : ""}
                            </div>
                          </td>
                          <td className="text-muted">
                            {(client.phone ?? "") !== "" ? client.phone : "—"} <br />
                            {(client.email ?? "") !== "" ? client.email : "—"}
                          </td>
                          <td className="text-muted small">
                            {client.locationId && locations[client.locationId] ? locations[client.locationId] : "-"}
                          </td>
                          <td className="text-muted small">{iscrizioneLabel(client)}</td>
                          <td>
                            {bday.days === null ? (
                              <span className="text-muted small">—</span>
                            ) : (
                              <span className={bday.className}>{bday.label}</span>
                            )}
                          </td>
                          <td className="text-end">
                            <a className="btn btn-sm btn-primary" href={href(`&action=view&id=${client.id}`)}>
                              Apri
                            </a>{" "}
                            {perms.clientsManage ? (
                              <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${client.id}`)}>
                                Modifica
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
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
