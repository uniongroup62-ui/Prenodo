"use client";

// Primitive condivise del pannello SaaS Admin (Fase F, 2026-07-19): tipi,
// costanti, componenti UI e helper estratti dal monolite saas-admin-app.tsx.

import {
  RotateCcw,
  type LucideIcon,
} from "lucide-react";

export type CronRunRow = {
  id: number;
  job: string;
  status: "ok" | "error";
  started_at?: string | null;
  duration_ms?: number;
  message?: string | null;
};

export type TenantTab = "overview" | "timeline" | "settings" | "visibility" | "admin" | "onboarding" | "health" | "support" | "backups" | "danger";

export type HealthLevel = "ok" | "warning" | "error";

export type TenantStatus = "provisioning" | "active" | "suspended" | "failed" | "deleted";

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  is_active?: number;
  status?: TenantStatus;
  admin_email?: string | null;
  plan?: string | null;
  notes?: string | null;
  source?: string | null;
  booking_public_allowed?: number;
  marketplace_public_allowed?: number;
  health_checked_at?: string | null;
  health?: {
    level: HealthLevel;
    warnings: number;
    errors: number;
    checks: Array<{ key: string; label: string; level: HealthLevel; message: string }>;
    missing_schema: string[];
  };
  onboarding_status?: string | null;
  onboarding_step?: string | null;
  onboarding_percent?: number;
  onboarding_started_at?: string | null;
  onboarding_completed_at?: string | null;
  created_at?: string;
};

export type AuditRow = {
  id: number;
  action: string;
  message?: string | null;
  tenant_slug?: string | null;
  actor_email?: string | null;
  created_at?: string | null;
};

export type SupportToken = {
  id: number;
  reason?: string | null;
  created_by_email?: string | null;
  expires_at?: string | null;
  used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string | null;
};

export type HealthCheckRow = {
  id: number;
  level: HealthLevel;
  source?: string | null;
  errors_count?: number;
  warnings_count?: number;
  checks_json?: string | null;
  created_at?: string | null;
};

export type AdminRecord = {
  id: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "viewer";
  is_active: number;
  last_login_at?: string | null;
};

export type WorkItem = {
  key: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  view: string;
  slug?: string;
  tab?: string;
  action?: "repair_schema" | "record_health";
};

export type TimelineEvent = {
  at: string;
  kind: "audit" | "health" | "backup" | "support" | "sms";
  title: string;
  detail: string;
  actor: string;
};

export type TenantDetailPayload = {
  tenant: Tenant;
  healthChecks: HealthCheckRow[];
  activeTokens: SupportToken[];
  recentTokens: SupportToken[];
  audit: AuditRow[];
  timeline: TimelineEvent[];
};

export type BackupRow = {
  id: number;
  tenant_slug?: string;
  reason?: string | null;
  backup_path: string;
  backup_size: number;
  status: string;
  created_at?: string | null;
};

export type SmsDiagnosticsRow = {
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
  level: HealthLevel;
  message: string;
  stats: Record<string, string | number | null | undefined>;
  warnings: string[];
  errors: string[];
};

export type ControlsPayload = {
  cron?: { runs: CronRunRow[]; jobs: CronRunRow[] };
  provider: {
    level: HealthLevel;
    configured: boolean;
    token_present: boolean;
    environment: string;
    base_url: string;
    sender: string;
    callback_configured: boolean;
    callback_url_configured: boolean;
    timeout: number;
    endpoint: { checked: boolean; ok: boolean; status_code: number; message: string };
    warnings: string[];
    errors: string[];
  };
  tenants: SmsDiagnosticsRow[];
};

export type SmsPlan = {
  id: number;
  name: string;
  credits: number;
  price_gross: number | string;
  currency: string;
  description?: string | null;
  is_active: number;
  is_featured: number;
  sort_order: number;
  economics: { price_per_credit: number; provider_cost: number; payment_fee: number; margin_value: number; margin_percent: number };
};

export type SmsBillingPayload = {
  settings: Record<string, string | number>;
  plans: SmsPlan[];
  activePlans: SmsPlan[];
  summary: { credits_sold: number; revenue_gross: number; orders_total: number; orders_pending: number };
  orders: Array<{ id: number; tenant_slug: string; plan_name?: string | null; status: string; credits: number; amount_gross: number | string; created_at?: string | null }>;
  tenants: Array<{ id: number; slug: string; name: string; status: TenantStatus; wallet_balance: number }>;
};

export type BillingPayload = {
  plans: Array<{ id: number; name: string; price_month: number | string; max_locations: number | null; max_staff: number | null; sms_included_month: number; is_active: number; notes?: string | null }>;
  revenue: {
    mrr_total: number;
    by_plan: Array<{ id: number; name: string; price_month: number; tenants: number; mrr: number }>;
    unassigned_active: number;
    sms_monthly: Array<{ month: string; orders: number; credits: number; revenue: number }>;
    wallet_credits_total: number;
  };
  tenants: Array<{ id: number; slug: string; name: string; plan_id: number | null; plan: string }>;
};

export type MovementRow = {
  tenant_slug: string;
  tenant_name: string;
  channel: "SMS" | "Email";
  kind: string;
  status: string;
  recipient: string;
  client_name: string;
  reference: string;
  subject?: string;
  event_at: string;
  credits?: number | null;
  provider_state?: string;
  last_error?: string;
};

export type MovementsPayload = {
  sms: MovementRow[];
  emails: MovementRow[];
};

export const statusLabel: Record<TenantStatus, string> = {
  active: "Attivo",
  suspended: "Sospeso",
  provisioning: "Provisioning",
  failed: "Errore",
  deleted: "Eliminato",
};

export const healthLabel: Record<HealthLevel, string> = {
  ok: "OK",
  warning: "Da verificare",
  error: "Errore",
};

export const workSeverityStyle: Record<WorkItem["severity"], string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  info: "border-slate-200 bg-slate-50 text-slate-600",
};

export const timelineKindStyle: Record<TimelineEvent["kind"], { label: string; tone: "ok" | "warn" | "danger" | "info" | "muted" }> = {
  audit: { label: "Audit", tone: "muted" },
  health: { label: "Diagnostica", tone: "info" },
  backup: { label: "Backup", tone: "ok" },
  support: { label: "Supporto", tone: "warn" },
  sms: { label: "SMS", tone: "info" },
};

export function Table({ title, headers, rows }: { title: string; headers: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <SectionHead title={title} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500"><tr>{headers.map((header) => <th className="px-4 py-3" key={header}>{header}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td className="px-4 py-3" key={cellIndex}>{cell}</td>)}</tr>)}
            {!rows.length ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={headers.length}>Nessun dato.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ActionPanel({ icon: Icon, title, detail, disabled, onClick }: { icon: LucideIcon; title: string; detail: string; disabled?: boolean; onClick: () => void }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <Icon className="text-[#365a96]" size={20} aria-hidden />
      <h2 className="mt-3 font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
      <button className="mt-4 h-9 rounded-md border border-slate-200 px-3 text-sm font-semibold disabled:opacity-50" disabled={disabled} type="button" onClick={onClick}>Esegui</button>
    </section>
  );
}

export function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <strong className="mt-2 block text-2xl">{value}</strong>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

export function SectionHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-slate-100 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

export function Input({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label>
      <span className="mb-1 block text-sm font-medium text-slate-600">{label}</span>
      <input className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96] disabled:bg-slate-50 disabled:text-slate-500" {...props} />
    </label>
  );
}

export function Toggle({ name, label, detail, defaultChecked, compact }: { name: string; label: string; detail?: string; defaultChecked?: boolean; compact?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${compact ? "mt-6" : "rounded-md border border-slate-200 p-3"}`}>
      <input name={name} type="checkbox" value="1" defaultChecked={defaultChecked} className="mt-1 h-4 w-4 rounded border-slate-300" />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {detail ? <span className="mt-1 block text-sm text-slate-500">{detail}</span> : null}
      </span>
    </label>
  );
}

export function RoleSelect({ defaultValue = "admin" }: { defaultValue?: string }) {
  return (
    <label>
      <span className="mb-1 block text-sm font-medium text-slate-600">Ruolo</span>
      <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="role" defaultValue={defaultValue}>
        <option value="owner">Owner</option>
        <option value="admin">Admin</option>
        <option value="viewer">Viewer</option>
      </select>
    </label>
  );
}

export function Button({ icon: Icon, children, variant = "solid", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; variant?: "solid" | "outline" }) {
  return (
    <button className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:opacity-50 ${variant === "solid" ? "bg-[#365a96] text-white" : "border border-slate-200 bg-white text-slate-800"}`} {...props}>
      <Icon size={16} aria-hidden />
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "info" | "muted"; children: React.ReactNode }) {
  const classes = {
    ok: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-900",
    danger: "bg-red-100 text-red-800",
    info: "bg-sky-100 text-sky-800",
    muted: "bg-slate-100 text-slate-600",
  };
  return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${classes[tone]}`}>{children}</span>;
}

export function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-slate-100 py-2"><strong>{label}</strong><span className="text-right text-slate-600">{value}</span></div>;
}

export function EmptyOperation({ icon: Icon, title, detail, onRefresh }: { icon: LucideIcon; title: string; detail: string; onRefresh: () => void }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-6 shadow-sm">
      <Icon className="text-[#365a96]" size={22} aria-hidden />
      <h2 className="mt-3 text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
      <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white" type="button" onClick={onRefresh}>
        <RotateCcw size={16} aria-hidden />
        Carica
      </button>
    </section>
  );
}

export function HealthChecks({ checks }: { checks: Array<{ key: string; label: string; level: HealthLevel; message: string }> }) {
  if (!checks.length) return <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">Nessun controllo disponibile.</div>;
  return (
    <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
      {checks.map((check) => (
        <div className="flex items-start justify-between gap-3 p-3 text-sm" key={check.key}>
          <div><strong>{check.label}</strong>{check.message ? <div className="mt-1 text-slate-500">{check.message}</div> : null}</div>
          <Badge tone={healthTone(check.level)}>{healthLabel[check.level]}</Badge>
        </div>
      ))}
    </div>
  );
}

export function TenantTable({ tenants, onOpenTenant }: { tenants: Tenant[]; onOpenTenant: (slug: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-[0.12em] text-slate-500">
          <tr><th className="px-4 py-3">Tenant</th><th className="px-4 py-3">Stato</th><th className="px-4 py-3">Onboarding</th><th className="px-4 py-3">Salute</th><th className="px-4 py-3 text-right">Azioni</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tenants.map((tenant) => {
            const status = tenantStatus(tenant);
            const health = tenant.health?.level ?? "warning";
            return (
              <tr key={tenant.slug}>
                <td className="px-4 py-3">
                  <strong>{tenant.name}</strong>
                  <div className="mt-1 text-slate-500"><code>{tenant.slug}</code>{tenant.admin_email ? ` - ${tenant.admin_email}` : ""}</div>
                </td>
                <td className="px-4 py-3"><Badge tone={statusTone(status)}>{statusLabel[status]}</Badge></td>
                <td className="px-4 py-3">
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-[#365a96]" style={{ width: `${tenant.onboarding_percent ?? 0}%` }} /></div>
                  <div className="mt-1 text-xs text-slate-500">{tenant.onboarding_percent ?? 0}% - {tenant.onboarding_status || "not_started"}</div>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={tenant.health_checked_at ? healthTone(health) : "muted"}>{tenant.health_checked_at ? healthLabel[health] : "Non verificato"}</Badge>
                  {tenant.health_checked_at ? <div className="mt-1 text-xs text-slate-500">{tenant.health_checked_at}</div> : null}
                </td>
                <td className="px-4 py-3 text-right"><button className="rounded-md border border-slate-200 px-3 py-1.5 font-semibold" type="button" onClick={() => onOpenTenant(tenant.slug)}>Gestisci</button></td>
              </tr>
            );
          })}
          {!tenants.length ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={5}>Nessun tenant trovato.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export function AuditList({ rows }: { rows: AuditRow[] }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <SectionHead title="Audit" subtitle="Ultime operazioni registrate dal pannello SaaS." />
      <div className="divide-y divide-slate-100">
        {rows.map((row) => (
          <div className="flex items-start justify-between gap-4 p-4 text-sm" key={row.id}>
            <div>
              <strong>{row.action}</strong>
              {row.tenant_slug ? <code className="ml-2 text-slate-500">{row.tenant_slug}</code> : null}
              <div className="mt-1 text-slate-500">{row.message || ""}{row.actor_email ? ` - ${row.actor_email}` : ""}</div>
            </div>
            <time className="shrink-0 text-slate-500">{row.created_at || ""}</time>
          </div>
        ))}
        {!rows.length ? <div className="p-8 text-center text-slate-500">Nessuna azione registrata.</div> : null}
      </div>
    </section>
  );
}

export function submitAction(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (action: string, payload?: Record<string, string>) => void) {
  event.preventDefault();
  onAction(action, formPayload(event.currentTarget));
}

export function submitAdmin(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (payload: Record<string, string>) => void) {
  event.preventDefault();
  onAction({ action, ...formPayload(event.currentTarget) });
}

export function submitOperation(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (payload: Record<string, string>) => void) {
  event.preventDefault();
  onAction({ action, ...formPayload(event.currentTarget) });
}

export function formPayload(form: HTMLFormElement): Record<string, string> {
  const formData = new FormData(form);
  const payload: Record<string, string> = {};
  for (const [key, value] of formData.entries()) payload[key] = typeof value === "string" ? value : value.name;
  return payload;
}

export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Richiesta non riuscita.");
  return data;
}

export async function apiPost<T>(url: string, payload: Record<string, string>): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Operazione non riuscita.");
  return data;
}

export function tenantStatus(tenant: Tenant): TenantStatus {
  if (tenant.status && statusLabel[tenant.status]) return tenant.status;
  return Number(tenant.is_active ?? 1) === 1 ? "active" : "suspended";
}

export function statusTone(status: TenantStatus): "ok" | "warn" | "danger" | "info" | "muted" {
  if (status === "active") return "ok";
  if (status === "suspended") return "warn";
  if (status === "provisioning") return "info";
  if (status === "failed" || status === "deleted") return "danger";
  return "muted";
}

export function healthTone(level: HealthLevel): "ok" | "warn" | "danger" | "info" | "muted" {
  if (level === "ok") return "ok";
  if (level === "warning") return "warn";
  if (level === "error") return "danger";
  return "muted";
}

export function movementTone(status: string): "ok" | "warn" | "danger" | "info" | "muted" {
  const normalized = status.toLowerCase();
  if (["sent", "delivered", "paid", "completed", "success"].includes(normalized)) return "ok";
  if (["pending", "scheduled", "queued"].includes(normalized)) return "warn";
  if (["failed", "error", "cancelled", "rejected"].includes(normalized)) return "danger";
  return "muted";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Operazione non riuscita.";
}

export function formatEuro(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  return `${Number.isFinite(amount) ? amount.toFixed(2).replace(".", ",") : "0,00"} euro`;
}

export function formatKb(value: number | string | null | undefined): string {
  const bytes = Number(value ?? 0);
  return `${(Number.isFinite(bytes) ? bytes / 1024 : 0).toFixed(1).replace(".", ",")} KB`;
}
