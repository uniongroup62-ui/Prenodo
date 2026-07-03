"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP clients list page (app/pages/clients.php), fed by
// the existing DB-backed /api/manage/clients.

type Client = {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  locationId?: number;
  tags?: string[];
  createdAt?: string;
  birthday?: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  return day && m && y ? `${day}/${m}/${y}` : "—";
}

export function ClientsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [clients, setClients] = useState<Client[]>([]);
  const [locations, setLocations] = useState<Record<number, string>>({});
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (query: string) => {
      setLoading(true);
      fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&q=${encodeURIComponent(query)}`, {
        headers: { "x-tenant-slug": slug },
      })
        .then((r) => r.json())
        .then((j) => setClients(Array.isArray(j.clients) ? j.clients : []))
        .catch(() => setClients([]))
        .finally(() => setLoading(false));
    },
    [slug],
  );

  useEffect(() => {
    load("");
    fetch(`/api/manage/locations?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const map: Record<number, string> = {};
        for (const loc of j.locations ?? []) map[Number(loc.id)] = String(loc.name ?? "");
        setLocations(map);
      })
      .catch(() => {});
  }, [load, slug]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`clients${suffix}`.replace("&", "?")}`;
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/clients.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Anagrafica</div>
          <h1 className="bs-page-title">Clienti</h1>
          <div className="bs-page-subtitle">Anagrafiche clienti, contatti, schede e storico.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-primary" href={`/${encodeURIComponent(slug)}/client_sheet_templates`}>
            <i className="bi bi-sliders me-1" />
            Configura schede
          </a>
          <a className="btn btn-primary" href={href("&action=new")}>
            <i className="bi bi-plus-lg me-1" />
            Nuovo
          </a>
        </div>
      </div>

      <div className="card p-3 mb-3">
        <form
          className="row g-2 align-items-end"
          onSubmit={(e) => {
            e.preventDefault();
            load(q);
          }}
        >
          <div className="col-lg-10">
            <label className="form-label">Cerca</label>
            <input
              className="form-control"
              name="q"
              placeholder="Cerca per nome/telefono/email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="col-lg-2 d-grid">
            <button className="btn btn-outline-primary" type="submit">
              <i className="bi bi-search me-1" />
              Cerca
            </button>
          </div>
        </form>
      </div>

      <div className="card">
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
                  <td colSpan={6} className="text-muted small p-3">
                    {loading ? "Caricamento…" : "Nessun cliente."}
                  </td>
                </tr>
              ) : (
                clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <div className="fw-semibold d-flex align-items-center gap-2 flex-wrap">
                        <span>{client.name}</span>
                        {(client.tags ?? []).map((tag) => (
                          <span className="badge bg-light text-dark" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="text-muted small">— </div>
                    </td>
                    <td className="text-muted">
                      {client.phone ? (
                        <>
                          {client.phone} <br />
                        </>
                      ) : null}
                      {client.email}
                    </td>
                    <td className="text-muted small">{client.locationId ? locations[client.locationId] ?? "" : ""}</td>
                    <td className="text-muted small">{fmtDate(client.createdAt)}</td>
                    <td>
                      <span className="text-muted small">{fmtDate(client.birthday)}</span>
                    </td>
                    <td className="text-end">
                      <a className="btn btn-sm btn-primary" href={href(`&action=view&id=${client.id}`)}>
                        Apri
                      </a>{" "}
                      <a className="btn btn-sm btn-outline-secondary" href={href(`&action=edit&id=${client.id}`)}>
                        Modifica
                      </a>
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
