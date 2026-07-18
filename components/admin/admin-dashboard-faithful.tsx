"use client";

import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/admin-shell";

// Pixel-faithful port of the legacy PHP /admin/ dashboard body.
// Renders inside AdminShell and fetches the real tenant data from the admin
// tenants API (GET /api/admin/tenants), mirroring the captured markup:
//   page-head (Overview / Dashboard) + page-actions
//   metric-grid #1 (totali / attivi / sospesi / da verificare)
//   metric-grid #2 (errori diagnostica / onboarding aperti / archiviati)
//   card-panel "Tenant recenti" table (Tenant / Stato / Salute / Azioni)

type HealthLevel = "ok" | "warning" | "error";

type TenantHealth = {
  level?: HealthLevel;
  checked_at?: string;
};

type Tenant = {
  id: number;
  slug: string;
  name: string;
  status?: string;
  is_active?: number;
  health_checked_at?: string | null;
  health?: TenantHealth;
};

type Summary = {
  total: number;
  active: number;
  suspended: number;
  failed: number;
  needs_attention: number;
};

type Operational = {
  health_errors: number;
  health_warnings: number;
  health_missing: number;
  onboarding_open: number;
  archived: number;
  suspended: number;
};

type TenantsResponse = {
  ok: boolean;
  error?: string;
  tenants?: Tenant[];
  summary?: Summary;
  operational?: Operational;
};

const EMPTY_SUMMARY: Summary = { total: 0, active: 0, suspended: 0, failed: 0, needs_attention: 0 };
const EMPTY_OPERATIONAL: Operational = {
  health_errors: 0,
  health_warnings: 0,
  health_missing: 0,
  onboarding_open: 0,
  archived: 0,
  suspended: 0,
};

// Status label + status-badge class, mirroring the legacy admin renderer.
function statusBadge(tenant: Tenant): { label: string; cls: string } {
  const status = (tenant.status || (Number(tenant.is_active ?? 1) === 1 ? "active" : "suspended")).toLowerCase();
  switch (status) {
    case "active":
      return { label: "Attivo", cls: "badge-ok" };
    case "suspended":
      return { label: "Sospeso", cls: "badge-warn" };
    case "failed":
      return { label: "Errore", cls: "badge-danger" };
    case "provisioning":
      return { label: "In provisioning", cls: "badge-info" };
    case "deleted":
      return { label: "Archiviato", cls: "badge-muted" };
    default:
      return { label: status || "—", cls: "badge-muted" };
  }
}

// Health badge, mirroring the legacy admin renderer.
function healthBadge(tenant: Tenant): { label: string; cls: string } {
  if (!tenant.health_checked_at) return { label: "Da verificare", cls: "badge-muted" };
  const level = tenant.health?.level ?? "ok";
  switch (level) {
    case "error":
      return { label: "Errore", cls: "badge-danger" };
    case "warning":
      return { label: "Attenzione", cls: "badge-warn" };
    default:
      return { label: "OK", cls: "badge-ok" };
  }
}

export function AdminDashboardFaithful({ userEmail = "" }: { userEmail?: string }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [operational, setOperational] = useState<Operational>(EMPTY_OPERATIONAL);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/tenants", { credentials: "include" });
        const data: TenantsResponse = await res.json();
        if (!active) return;
        if (!res.ok || !data.ok) {
          setError(data.error || "Impossibile caricare i tenant.");
          setLoading(false);
          return;
        }
        setTenants(data.tenants ?? []);
        setSummary(data.summary ?? EMPTY_SUMMARY);
        setOperational(data.operational ?? EMPTY_OPERATIONAL);
        setLoading(false);
      } catch {
        if (!active) return;
        setError("Servizio non disponibile. Riprova.");
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Legacy "Tenant recenti" shows the most recent tenants (API returns them
  // already ordered newest-first); cap the preview at 5 like the PHP page.
  const recent = tenants.slice(0, 5);

  return (
    <AdminShell activePage="" userEmail={userEmail}>
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Overview</div>
          <h1>Dashboard</h1>
          <p>Stato generale dei tenant e ultime operazioni.</p>
        </div>
        <div className="page-actions">
          <a className="btn btn-primary" href="./?page=tenant_new">
            Nuovo tenant
          </a>
          <a className="btn btn-outline-secondary" href="./?page=maintenance">
            Manutenzione
          </a>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="metric-grid">
        <div className="metric-card">
          <strong>{summary.total}</strong>
          <span>Tenant totali</span>
        </div>
        <div className="metric-card">
          <strong>{summary.active}</strong>
          <span>Attivi</span>
        </div>
        <div className="metric-card">
          <strong>{summary.suspended}</strong>
          <span>Sospesi</span>
        </div>
        <div className="metric-card">
          <strong>{summary.needs_attention}</strong>
          <span>Da verificare</span>
        </div>
      </div>

      <div className="metric-grid">
        <div className="metric-card metric-danger">
          <strong>{operational.health_errors}</strong>
          <span>Errori diagnostica</span>
        </div>
        <div className="metric-card metric-info">
          <strong>{operational.onboarding_open}</strong>
          <span>Onboarding aperti</span>
        </div>
        <div className="metric-card metric-muted">
          <strong>{operational.archived}</strong>
          <span>Archiviati</span>
        </div>
      </div>

      <section className="card-panel">
        <h2>Tenant recenti</h2>
        <div className="table-responsive">
          <table className="table align-middle">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Stato</th>
                <th>Salute</th>
                <th className="text-end">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Caricamento…
                  </td>
                </tr>
              ) : recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    Nessun tenant.
                  </td>
                </tr>
              ) : (
                recent.map((tenant) => {
                  const status = statusBadge(tenant);
                  const health = healthBadge(tenant);
                  return (
                    <tr key={tenant.slug}>
                      <td>
                        <strong>{tenant.name}</strong>
                        <div className="muted">
                          <code>{tenant.slug}</code>
                        </div>
                      </td>
                      <td>
                        <span className={`status-badge ${status.cls}`}>{status.label}</span>
                      </td>
                      <td>
                        <span className={`status-badge ${health.cls}`}>{health.label}</span>
                        {tenant.health_checked_at ? (
                          <div className="muted mt-1">{tenant.health_checked_at}</div>
                        ) : null}
                      </td>
                      <td className="text-end">
                        <a
                          className="btn btn-outline-secondary btn-sm"
                          href={`./?page=tenant_detail&slug=${encodeURIComponent(tenant.slug)}`}
                        >
                          Gestisci
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
