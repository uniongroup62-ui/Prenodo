"use client";

import { useEffect, useState } from "react";
import { flashNavigate, useTakenFlash } from "./flash";

// Faithful port of the PHP client DETAIL page (app/pages/clients.php action=view).
// Layout legacy: col-lg-4 (avatar card + stats "Iscritto da/Età/Compleanno",
// card Fidelity SOLO se il cliente aderisce, card Credito, card Tag) +
// col-lg-8 (Informazioni principali / Indirizzo Contatti / Info fiscali in sola
// lettura). La scheda è CONSULTIVA: blocca/elimina vivono nella pagina Modifica.
// Header actions gated dai permessi (Lista/Modifica/Moduli consenso/
// Compilazioni/Storico/Nuovo appuntamento) + badge Attivo/Disattivato nel titolo.

type ManagedClientDetail = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  locationId?: number;
  note?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  vatNumber?: string;
  taxCode?: string;
  sdi?: string;
  pec?: string;
  phoneHome?: string;
  phone2?: string;
  gender?: string;
  birthDate?: string;
  birthPlace?: string;
  registrationDate?: string;
  region?: string;
  province?: string;
  city?: string;
  address?: string;
  cap?: string;
  jobTitle?: string;
};

type DetailPayload = {
  ok: boolean;
  client: ManagedClientDetail;
  fidelity: {
    points: number;
    creditBalance: number;
    adhering: boolean;
    enabled: boolean;
    label: string;
    expireEnabled: boolean;
    expireDays: number;
    expireWarnDays: number;
    expiringSoon: number;
  };
  stats: { sinceValue: number; sinceUnit: string; age: string; birthday: string };
  tags: Array<{ id: number; name: string }>;
  block: { isBlocked: boolean; blockedAt: string | null; blockedInternalNote: string };
  perms?: {
    clientsManage?: boolean;
    clientSheetsManage?: boolean;
    clientConsentsManage?: boolean;
    createAppointments?: boolean;
    openCreditMovements?: boolean;
  };
  error?: string;
};

export type ClientDetailQuery = {
  msg?: string;
  err?: string;
  // Avviso AGGIUNTIVO non bloccante (es. duplicati al create), sotto il flash.
  warn?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function clientIdFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const id = new URLSearchParams(window.location.search).get("id");
  const n = Number(id ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Port of fmt_money(): number_format(n, 2, ',', '.').
function fmtMoney(value: number): string {
  const v = Number(value || 0);
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

// Port of fmt_points(): integer floor/ceil toward zero, '0' fallback.
function fmtPoints(value: number): string {
  const v = Number(value || 0);
  if (!Number.isFinite(v) || Math.abs(v) < 0.0000001) return "0";
  return String(v > 0 ? Math.floor(v + 0.000000001) : Math.ceil(v - 0.000000001));
}

function fmtDate(value?: string | null): string {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function genderLabel(g?: string): string {
  if (g === "M") return "Maschio";
  if (g === "F") return "Femmina";
  return "";
}

type FieldRow = { label: string; value: string; wide?: boolean };

// Mirror clientViewAddField: only push non-empty values.
function pushField(out: FieldRow[], label: string, value: string | undefined, wide = false) {
  const v = String(value ?? "").trim();
  if (v === "") return;
  out.push({ label, value: v, wide });
}

function FieldGrid({ fields }: { fields: FieldRow[] }) {
  if (fields.length === 0) return <div className="text-muted">Nessun dato</div>;
  return (
    <div className="row g-3">
      {fields.map((f) => (
        <div className={f.wide ? "col-12" : "col-md-6"} key={f.label}>
          <div className="text-muted small">{f.label}</div>
          <div className="fw-semibold clients-prewrap">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

export function ClientDetailContent({ slug: slugProp, initialQuery }: { slug?: string; initialQuery?: ClientDetailQuery } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  // clientId is read from the URL POST-MOUNT (see the effect below), not during
  // render, so the server and the first client paint render the same loading
  // shell — otherwise the server (no window) and client (real id) diverge and
  // React throws a hydration mismatch.
  const [clientId, setClientId] = useState<number>(0);
  const [data, setData] = useState<DetailPayload | null>(null);
  const [locations, setLocations] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Flash legacy (View::alert): ?msg= success + ?err= danger, più gli esiti tag.
  const [flash, setFlash] = useState<{ msg?: string; err?: string }>(() => ({
    msg: initialQuery?.msg,
    err: initialQuery?.err,
  }));

  // Tag add input.
  const [tagInput, setTagInput] = useState("");

  // Read the id from the URL after mount (window is only available client-side).
  // Microtask: evita il setState sincrono nell'effect (primo paint invariato).
  useEffect(() => {
    void Promise.resolve().then(() => {
      const id = clientIdFromUrl();
      if (id > 0) {
        setClientId(id);
      } else {
        setError("Cliente non valido.");
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=detail&id=${clientId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: DetailPayload) => {
        if (!active) return;
        if (j && j.ok && j.client) {
          setData(j);
          setError("");
        } else {
          // Legacy: client_load_accessible fa redirect alla lista con l'errore.
          const msg = String(j?.error || "Cliente non trovato o non disponibile per le tue sedi.");
          flashNavigate(`/${encodeURIComponent(slug)}/clients`, { err: msg });
        }
      })
      .catch(() => {
        if (active) setError("Errore nel caricamento del cliente.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId, slug]);

  useEffect(() => {
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const map: Record<number, string> = {};
        for (const loc of j.locations ?? []) map[Number(loc.id)] = String(loc.name ?? "");
        setLocations(map);
      })
      .catch(() => {});
  }, [slug]);

  function page(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`${suffix}`.replace("&", "?")}`;
  }

  // Add a tag (port of clients.php _mode=add_tag; flash legacy "Tag aggiunto").
  async function addTag() {
    const name = tagInput.trim();
    if (busy || name === "") return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "add_tag", id: String(clientId), tag: name }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setFlash({ err: String(j.error ?? "Errore nell'aggiunta del tag.") });
      } else {
        setData((prev) => (prev ? { ...prev, tags: Array.isArray(j.tags) ? j.tags : prev.tags } : prev));
        setTagInput("");
        setFlash({ msg: "Tag aggiunto" });
      }
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    } catch {
      setFlash({ err: "Errore nell'aggiunta del tag." });
    } finally {
      setBusy(false);
    }
  }

  // Remove a tag (port of clients.php do=remove_tag; flash legacy "Tag rimosso").
  async function removeTag(tagId: number) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "remove_tag", id: String(clientId), tag_id: String(tagId) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setFlash({ err: String(j.error ?? "Errore nella rimozione del tag.") });
      } else {
        setData((prev) => (prev ? { ...prev, tags: Array.isArray(j.tags) ? j.tags : prev.tags } : prev));
        setFlash({ msg: "Tag rimosso" });
      }
      if (typeof window !== "undefined") window.scrollTo(0, 0);
    } catch {
      setFlash({ err: "Errore nella rimozione del tag." });
    } finally {
      setBusy(false);
    }
  }

  const perms = data?.perms ?? {};
  const Header = (
    <div className="bs-page-header">
      <div className="bs-page-heading">
        <div className="bs-page-kicker">Scheda cliente</div>
        <h1 className="bs-page-title">
          <span className="d-flex align-items-center gap-2 flex-wrap">
            <span>{data?.client.name ?? "Cliente"}</span>
            {data ? (
              data.block.isBlocked ? (
                <span className="badge text-bg-warning">
                  <i className="bi bi-slash-circle me-1" />
                  Disattivato
                </span>
              ) : (
                <span className="badge text-bg-success">
                  <i className="bi bi-check2-circle me-1" />
                  Attivo
                </span>
              )
            ) : null}
          </span>
        </h1>
        <div className="bs-page-subtitle">{(data?.client.phone || "-") + " - " + (data?.client.email || "-")}</div>
      </div>
      <div className="bs-page-actions">
        <a className="btn btn-outline-secondary" href={page("clients")}>
          <i className="bi bi-arrow-left me-1" />
          Lista
        </a>
        {perms.clientsManage !== false ? (
          <a className="btn btn-outline-primary" href={page(`clients&action=edit&id=${clientId}`)}>
            <i className="bi bi-pencil-square me-1" />
            Modifica
          </a>
        ) : null}
        {perms.clientConsentsManage !== false ? (
          <a className="btn btn-outline-primary" href={page(`client_consents&client_id=${clientId}`)}>
            <i className="bi bi-shield-check me-1" />
            Moduli consenso
          </a>
        ) : null}
        {perms.clientSheetsManage !== false ? (
          <a className="btn btn-outline-primary" href={page(`client_sheets&client_id=${clientId}`)}>
            <i className="bi bi-journals me-1" />
            Compilazioni
          </a>
        ) : null}
        {perms.clientsManage !== false ? (
          <a className="btn btn-outline-primary" href={page(`clients&action=history&id=${clientId}`)}>
            <i className="bi bi-clock-history me-1" />
            Storico
          </a>
        ) : null}
        {perms.createAppointments !== false ? (
          <a className="btn btn-primary" href={page("calendar")}>
            <i className="bi bi-calendar-plus me-1" />
            Nuovo appuntamento
          </a>
        ) : null}
      </div>
    </div>
  );

  // Il ramo loading DEVE precedere i rami d'errore: in SSR clientId è 0 (l'URL si
  // legge solo dopo il mount) e mettere "Cliente non valido." per primo lo farebbe
  // flashare nell'HTML iniziale finché il client non si idrata.
  if (loading) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        {Header}
        <div className="card p-3 text-muted small">Caricamento…</div>
      </div>
    );
  }

  if (!clientId) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        <div className="alert alert-danger">Cliente non valido.</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/clients.css" />
        {Header}
        <div className="alert alert-danger">{error || "Errore nel caricamento del cliente."}</div>
      </div>
    );
  }

  const c = data.client;
  const displayName = c.name || "Cliente";

  const mainFields: FieldRow[] = [];
  pushField(mainFields, "Nome", c.firstName);
  pushField(mainFields, "Cognome", c.lastName);
  pushField(mainFields, "Cellulare", c.phone);
  pushField(mainFields, "Email", c.email);
  pushField(mainFields, "Sesso", genderLabel(c.gender));
  pushField(mainFields, "Data di nascita", fmtDate(c.birthDate));
  pushField(mainFields, "Luogo di nascita", c.birthPlace);
  pushField(mainFields, "Data iscrizione", fmtDate(c.registrationDate));
  // Legacy: client_location_label_from_id -> '-' quando manca la sede.
  pushField(mainFields, "Sede di riferimento", c.locationId && locations[c.locationId] ? locations[c.locationId] : "-");
  pushField(mainFields, "Note", c.note, true);

  const contactFields: FieldRow[] = [];
  pushField(contactFields, "Regione", c.region);
  pushField(contactFields, "Provincia", c.province);
  pushField(contactFields, "Citta", c.city);
  pushField(contactFields, "CAP", c.cap);
  pushField(contactFields, "Indirizzo", c.address, true);
  pushField(contactFields, "Titolo / Lavoro", c.jobTitle);
  pushField(contactFields, "Telefono fisso", c.phoneHome);
  pushField(contactFields, "Cellulare 2", c.phone2);

  const fiscalFields: FieldRow[] = [];
  pushField(fiscalFields, "Codice Fiscale", c.taxCode);
  pushField(fiscalFields, "Partita IVA", c.vatNumber);
  pushField(fiscalFields, "SDI", c.sdi);
  pushField(fiscalFields, "Azienda", c.companyName);
  pushField(fiscalFields, "PEC", c.pec);

  const fid = data.fidelity;

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
      {String(initialQuery?.warn ?? "") !== "" ? (
        <div className="alert alert-warning d-flex align-items-start gap-2">
          <div>
            <i className="bi bi-exclamation-triangle" />
          </div>
          <div>{initialQuery?.warn}</div>
        </div>
      ) : null}

      {Header}

      <div className="row g-3">
        {/* LEFT column: avatar + stats + fidelity (se aderente) + credito + tag */}
        <div className="col-lg-4">
          <div className="card">
            <div className="p-4 text-center">
              <div className="mx-auto mb-2 clients-profile-avatar">
                <i className="bi bi-person-fill clients-profile-avatar-icon" />
              </div>
              <div className="fw-bold">{displayName}</div>
              <div className="text-muted small">{c.email || "—"}</div>
            </div>
            <div className="border-top px-3 py-3">
              <div className="row text-center g-0">
                <div className="col">
                  <div className="fw-bold">
                    {data.stats.sinceValue} <span className="text-muted fw-semibold">{data.stats.sinceUnit}</span>
                  </div>
                  <div className="text-muted small">Iscritto da</div>
                </div>
                <div className="col border-start border-end">
                  <div className="fw-bold">{data.stats.age}</div>
                  <div className="text-muted small">Età</div>
                </div>
                <div className="col">
                  <div className="fw-bold">{data.stats.birthday}</div>
                  <div className="text-muted small">Compleanno</div>
                </div>
              </div>
            </div>
          </div>

          {/* Fidelity — SOLO per i clienti aderenti (tessera attiva), come il
              legacy Fidelity::isClientAdhering. I livelli a punti del legacy non
              sono configurati per questo profilo (levels disattivi) — il ramo
              base mostra punti + badge "Punti disattivati" quando la Fidelity
              operativa è spenta. */}
          {fid.adhering ? (
            <div className="card p-3 mt-3">
              <div className="d-flex justify-content-between align-items-start gap-2">
                <div className="fw-semibold mb-2">
                  <i className="bi bi-award me-1" />
                  Fidelity
                </div>
                {!fid.enabled ? (
                  <span className="badge rounded-pill text-bg-secondary px-3 py-2 clients-fidelity-badge">Punti disattivati</span>
                ) : null}
              </div>
              <div className="d-flex justify-content-between align-items-end gap-3 flex-wrap">
                <div>
                  <div className="display-6 fw-bold">{fmtPoints(fid.points)}</div>
                  <div className="text-muted small">
                    {fid.label} {fid.enabled ? "disponibili" : "registrati"}
                  </div>
                </div>
              </div>
              {fid.expireEnabled && fid.expireDays > 0 ? (
                <div className="text-muted small mt-1">
                  Scadenza punti: {fid.expireDays} giorni
                  {fid.expireWarnDays > 0 ? (
                    <>
                      {" "}
                      • In scadenza entro {fid.expireWarnDays} giorni: <b>{fmtPoints(fid.expiringSoon)}</b>
                    </>
                  ) : null}
                </div>
              ) : null}
              {perms.openCreditMovements !== false ? (
                <div className="mt-2">
                  <a className="btn btn-sm btn-outline-secondary btn-pill w-100" href={page(`credit_movements&client_id=${clientId}`)}>
                    <i className="bi bi-arrow-right-circle me-1" />
                    Gestisci movimenti
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Credito — clients.credit_balance (fmt_money legacy, senza bottoni). */}
          <div className="card p-3 mt-3">
            <div className="d-flex justify-content-between align-items-start gap-2">
              <div className="fw-semibold mb-2">
                <i className="bi bi-wallet2 me-1" />
                Credito
              </div>
              <div className="text-muted small fw-semibold">Saldo disponibile</div>
            </div>
            <div className="display-6 fw-bold">€ {fmtMoney(fid.creditBalance)}</div>
            <div className="text-muted small">Credito disponibile del cliente</div>
          </div>

          {/* Tag */}
          <div className="card p-3 mt-3">
            <div className="fw-semibold mb-2">
              <i className="bi bi-tags me-1" />
              Tag
            </div>
            <div className="d-flex flex-wrap gap-2">
              {data.tags.length === 0 ? (
                <span className="text-muted small">Nessun tag.</span>
              ) : (
                data.tags.map((t) => (
                  <span className="badge badge-soft" key={t.id}>
                    {t.name}
                    {perms.clientsManage !== false ? (
                      <a
                        className="ms-2 text-decoration-none"
                        href="#"
                        title="Rimuovi"
                        onClick={(e) => {
                          e.preventDefault();
                          void removeTag(t.id);
                        }}
                      >
                        ×
                      </a>
                    ) : null}
                  </span>
                ))
              )}
            </div>
            {perms.clientsManage !== false ? (
              <form
                className="mt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addTag();
                }}
              >
                <div className="input-group">
                  <input
                    className="form-control"
                    name="tag"
                    placeholder="Es. VIP, Allergie, Promo"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                  />
                  <button className="btn btn-outline-primary" type="submit">
                    Aggiungi
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        </div>

        {/* RIGHT column: anagrafica in sola lettura */}
        <div className="col-lg-8">
          <div className="card">
            <div className="card-header">Informazioni principali</div>
            <div className="card-body">
              <FieldGrid fields={mainFields} />
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Indirizzo / Contatti</div>
            <div className="card-body">
              <FieldGrid fields={contactFields} />
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Info fiscali</div>
            <div className="card-body">
              <FieldGrid fields={fiscalFields} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
