"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  Download,
  Eye,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Loader2,
  Lock,
  LogOut,
  Plus,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SaasAdminUser } from "@/lib/saas-admin-auth";
import { AdminSecurityPanel } from "@/components/admin/admin-security-panel";

type ViewKey = "dashboard" | "tenants" | "controls" | "sms_plans" | "send_movements" | "maintenance" | "audit" | "admins" | "security";
type TenantTab = "overview" | "settings" | "visibility" | "admin" | "onboarding" | "health" | "support" | "backups" | "danger";
type HealthLevel = "ok" | "warning" | "error";
type TenantStatus = "provisioning" | "active" | "suspended" | "failed" | "deleted";

type Tenant = {
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

type AuditRow = {
  id: number;
  action: string;
  message?: string | null;
  tenant_slug?: string | null;
  actor_email?: string | null;
  created_at?: string | null;
};

type SupportToken = {
  id: number;
  reason?: string | null;
  created_by_email?: string | null;
  expires_at?: string | null;
  used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string | null;
};

type HealthCheckRow = {
  id: number;
  level: HealthLevel;
  source?: string | null;
  errors_count?: number;
  warnings_count?: number;
  created_at?: string | null;
};

type AdminRecord = {
  id: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "viewer";
  is_active: number;
  last_login_at?: string | null;
};

type OverviewPayload = {
  tenants: Tenant[];
  summary: { total: number; active: number; suspended: number; failed: number; needs_attention: number };
  operational: { health_errors: number; health_warnings: number; health_missing: number; onboarding_open: number; archived: number; suspended: number };
  audit: AuditRow[];
};

type TenantDetailPayload = {
  tenant: Tenant;
  healthChecks: HealthCheckRow[];
  activeTokens: SupportToken[];
  recentTokens: SupportToken[];
  audit: AuditRow[];
};

type BackupRow = {
  id: number;
  reason?: string | null;
  backup_path: string;
  backup_size: number;
  status: string;
  created_at?: string | null;
};

type SmsDiagnosticsRow = {
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
  level: HealthLevel;
  message: string;
  stats: Record<string, string | number | null | undefined>;
  warnings: string[];
  errors: string[];
};

type ControlsPayload = {
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

type SmsPlan = {
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

type SmsBillingPayload = {
  settings: Record<string, string | number>;
  plans: SmsPlan[];
  activePlans: SmsPlan[];
  summary: { credits_sold: number; revenue_gross: number; orders_total: number; orders_pending: number };
  orders: Array<{ id: number; tenant_slug: string; plan_name?: string | null; status: string; credits: number; amount_gross: number | string; created_at?: string | null }>;
  tenants: Array<{ id: number; slug: string; name: string; status: TenantStatus; wallet_balance: number }>;
};

type MovementRow = {
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

type MovementsPayload = {
  sms: MovementRow[];
  emails: MovementRow[];
};

const navItems: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "tenants", label: "Tenant", icon: Building2 },
  { key: "controls", label: "Controlli", icon: Activity },
  { key: "sms_plans", label: "Piani SMS", icon: CreditCard },
  { key: "send_movements", label: "Movimenti invii", icon: Send },
  { key: "maintenance", label: "Manutenzione", icon: Wrench },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "admins", label: "Admin SaaS", icon: Users },
  { key: "security", label: "Sicurezza", icon: ShieldCheck },
];

const tenantTabs: Array<{ key: TenantTab; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Panoramica", icon: LayoutDashboard },
  { key: "settings", label: "Dati", icon: Settings },
  { key: "visibility", label: "Visibilita", icon: Eye },
  { key: "admin", label: "Admin", icon: UserCog },
  { key: "onboarding", label: "Onboarding", icon: ClipboardCheck },
  { key: "health", label: "Diagnostica", icon: Activity },
  { key: "support", label: "Supporto", icon: LifeBuoy },
  { key: "backups", label: "Backup", icon: Archive },
  { key: "danger", label: "Azioni critiche", icon: ShieldAlert },
];

const statusLabel: Record<TenantStatus, string> = {
  active: "Attivo",
  suspended: "Sospeso",
  provisioning: "Provisioning",
  failed: "Errore",
  deleted: "Eliminato",
};

const healthLabel: Record<HealthLevel, string> = {
  ok: "OK",
  warning: "Da verificare",
  error: "Errore",
};

const emptyOverview: OverviewPayload = {
  tenants: [],
  summary: { total: 0, active: 0, suspended: 0, failed: 0, needs_attention: 0 },
  operational: { health_errors: 0, health_warnings: 0, health_missing: 0, onboarding_open: 0, archived: 0, suspended: 0 },
  audit: [],
};

export function SaasAdminLoginPage({ initialBootstrapped = true }: { initialBootstrapped?: boolean }) {
  const [bootstrapped, setBootstrapped] = useState(initialBootstrapped);
  const [name, setName] = useState("Admin");
  // MAI credenziali di default nel sorgente (fix sicurezza 2026-07-18).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/auth/status")
      .then((response) => response.json())
      .then((data: { bootstrapped?: boolean }) => {
        if (!cancelled) setBootstrapped(Boolean(data.bootstrapped));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: bootstrapped ? "login" : "bootstrap", name, email, password }),
      });
      const data = await response.json() as { ok?: boolean; redirectTo?: string; error?: string };
      if (!response.ok || !data.ok) {
        setMessage(data.error ?? "Accesso non riuscito.");
        return;
      }
      window.location.href = data.redirectTo ?? "/admin";
    } catch {
      setMessage("Pannello SaaS non disponibile ora.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#eef2f6] text-slate-950">
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="flex items-center justify-center px-5 py-8">
          <div className="w-full max-w-md rounded-md border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-slate-950 text-white">
                <ShieldCheck size={20} aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">SaaS Admin</p>
                <h1 className="text-2xl font-semibold">{bootstrapped ? "Accesso" : "Prima configurazione"}</h1>
              </div>
            </div>

            {message ? <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{message}</div> : null}

            <form className="mt-6 space-y-4" onSubmit={submit}>
              {!bootstrapped ? (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">Nome</span>
                  <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" value={name} onChange={(event) => setName(event.target.value)} />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Email</span>
                <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <button className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading}>
                {loading ? <Loader2 className="animate-spin" size={17} aria-hidden /> : <KeyRound size={17} aria-hidden />}
                {bootstrapped ? "Accedi" : "Crea admin SaaS"}
              </button>
            </form>
          </div>
        </section>
        <aside className="hidden bg-slate-950 p-8 text-white lg:block">
          <div className="flex h-full flex-col justify-between">
            <div>
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-emerald-600">B</div>
              <h2 className="mt-8 text-4xl font-semibold tracking-normal">Console tenant</h2>
              <p className="mt-4 leading-7 text-white/70">Gestione tenant, diagnostica, onboarding, support access e amministratori senza dipendere dal pannello PHP.</p>
            </div>
            <div className="grid gap-2 text-sm text-white/70">
              <span>Schema centrale `saas_*`</span>
              <span>Audit operativo</span>
              <span>Token supporto monouso</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

export function SaasAdminApp({
  initialUser,
  initialView = "dashboard",
  initialSlug = "",
  initialTab = "overview",
}: {
  initialUser: SaasAdminUser;
  initialView?: ViewKey;
  initialSlug?: string;
  initialTab?: TenantTab;
}) {
  const [activeView, setActiveView] = useState<ViewKey>(initialView);
  const [overview, setOverview] = useState<OverviewPayload>(emptyOverview);
  const [tenantDetail, setTenantDetail] = useState<TenantDetailPayload | null>(null);
  const [activeTenantTab, setActiveTenantTab] = useState<TenantTab>("overview");
  const [controls, setControls] = useState<ControlsPayload | null>(null);
  const [smsBilling, setSmsBilling] = useState<SmsBillingPayload | null>(null);
  const [movements, setMovements] = useState<MovementsPayload | null>(null);
  const [backups, setBackups] = useState<Record<string, BackupRow[]>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [admins, setAdmins] = useState<AdminRecord[]>([]);
  const [results, setResults] = useState<Array<{ slug: string; ok: boolean; message: string }>>([]);
  const [supportLink, setSupportLink] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const canManageTenants = initialUser.role === "owner" || initialUser.role === "admin";
  const canManageAdmins = initialUser.role === "owner";
  const visibleNav = useMemo(() => navItems.filter((item) => item.key !== "admins" || canManageAdmins), [canManageAdmins]);

  // URL veri per ogni sezione (Fase 3, 2026-07-19): /admin?page=<vista>
  // [&slug=..&tab=..] — deep-link, refresh e tasto Indietro funzionanti.
  function syncUrl(view: ViewKey, slug = "", tab: TenantTab = "overview", push = true) {
    const params = new URLSearchParams();
    if (view !== "dashboard") params.set("page", view);
    if (view === "tenants" && slug) {
      params.set("slug", slug);
      if (tab !== "overview") params.set("tab", tab);
    }
    const url = `/admin${params.toString() ? `?${params}` : ""}`;
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== url) {
      if (push) window.history.pushState({ view, slug, tab }, "", url);
      else window.history.replaceState({ view, slug, tab }, "", url);
    }
  }

  // Caricamento dati per-vista (riusato da nav, deep-link iniziale e popstate).
  const loadForView = (key: ViewKey) => {
    if (key === "admins") void loadAdmins();
    if (key === "controls") void loadControls();
    if (key === "sms_plans") void loadSmsBilling();
    if (key === "send_movements") void loadMovements();
  };

  function navigateView(key: ViewKey, push = true) {
    setActiveView(key);
    setTenantDetail(null);
    loadForView(key);
    syncUrl(key, "", "overview", push);
  }

  // Deep-link iniziale (?page/slug/tab) + tasto Indietro (popstate).
  useEffect(() => {
    if (initialSlug) void loadTenant(initialSlug, initialTab);
    else loadForView(initialView);
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const view = (params.get("page") || "dashboard") as ViewKey;
      const slug = params.get("slug") || "";
      const tab = (params.get("tab") || "overview") as TenantTab;
      if (view === "tenants" && slug) void loadTenant(slug, tab, false);
      else {
        setActiveView(navItems.some((item) => item.key === view) || view === "dashboard" ? view : "dashboard");
        setTenantDetail(null);
        loadForView(view);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet<OverviewPayload>("/api/admin/tenants")
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((error) => {
        if (!cancelled) setMessage(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadOverview(nextQuery = query, nextStatus = statusFilter) {
    setLoading(true);
    try {
      const search = new URLSearchParams();
      if (nextQuery.trim()) search.set("q", nextQuery.trim());
      if (nextStatus) search.set("status", nextStatus);
      const data = await apiGet<OverviewPayload>(`/api/admin/tenants${search.toString() ? `?${search}` : ""}`);
      setOverview(data);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadTenant(slug: string, tab: TenantTab = activeTenantTab, push = true) {
    setLoading(true);
    setSupportLink("");
    try {
      const data = await apiGet<TenantDetailPayload>(`/api/admin/tenants?slug=${encodeURIComponent(slug)}`);
      setTenantDetail(data);
      setActiveTenantTab(tab);
      setActiveView("tenants");
      syncUrl("tenants", slug, tab, push);
      if (tab === "backups") await loadBackups(slug);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function tenantAction(action: string, payload: Record<string, string> = {}) {
    const slug = payload.slug || tenantDetail?.tenant.slug || "";
    try {
      const data = await apiPost<{ tenant?: Tenant; token?: { link: string }; results?: Array<{ slug: string; ok: boolean; message: string }> }>("/api/admin/tenants", { action, slug, ...payload });
      if (data.token?.link) setSupportLink(data.token.link);
      if (data.results) setResults(data.results);
      setMessage("Operazione completata.");
      await loadOverview();
      if (slug && action !== "delete") await loadTenant(slug);
      if (action === "delete") setTenantDetail(null);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function loadAdmins() {
    setLoading(true);
    try {
      const data = await apiGet<{ admins: AdminRecord[] }>("/api/admin/admins");
      setAdmins(data.admins);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function adminAction(payload: Record<string, string>) {
    try {
      const data = await apiPost<{ admins: AdminRecord[] }>("/api/admin/admins", payload);
      setAdmins(data.admins);
      setMessage("Admin SaaS aggiornati.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function loadControls() {
    setLoading(true);
    try {
      const data = await apiGet<ControlsPayload>("/api/admin/operations?section=controls");
      setControls(data);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadSmsBilling() {
    setLoading(true);
    try {
      const data = await apiGet<SmsBillingPayload>("/api/admin/operations?section=sms_plans");
      setSmsBilling(data);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadMovements() {
    setLoading(true);
    try {
      const data = await apiGet<MovementsPayload>("/api/admin/operations?section=send_movements");
      setMovements(data);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadBackups(slug: string) {
    try {
      const data = await apiGet<{ backups: BackupRow[] }>(`/api/admin/operations?section=backups&slug=${encodeURIComponent(slug)}`);
      setBackups((current) => ({ ...current, [slug]: data.backups }));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function operationAction(payload: Record<string, string>) {
    try {
      await apiPost<{ ok: boolean }>("/api/admin/operations", payload);
      setMessage("Operazione completata.");
      if (payload.action?.startsWith("sms_")) await loadSmsBilling();
      if (payload.action === "backup_create" && payload.slug) await loadBackups(payload.slug);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function logout() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="min-h-screen bg-[#eef2f6] text-slate-950">
      <div className="grid min-h-screen lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-r border-slate-200 bg-slate-950 p-4 text-white">
          <div className="flex items-center gap-3 border-b border-white/10 pb-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-600 font-semibold">P</span>
            <div className="min-w-0">
              <p className="truncate font-semibold">SaaS Admin</p>
              <p className="truncate text-xs text-white/60">{initialUser.email}</p>
            </div>
          </div>
          <nav className="mt-5 grid gap-1">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={`flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm font-semibold ${activeView === item.key ? "bg-white text-slate-950" : "text-white/80 hover:bg-white/10"}`}
                  key={item.key}
                  type="button"
                  onClick={() => navigateView(item.key)}
                >
                  <Icon size={17} aria-hidden />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <button className="mt-5 flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-semibold text-white/80 hover:bg-white/10" type="button" onClick={logout}>
            <LogOut size={17} aria-hidden />
            Logout
          </button>
        </aside>

        <section className="min-w-0">
          <header className="flex min-h-16 items-center justify-between border-b border-slate-200 bg-white px-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Pannello SaaS</p>
              <h1 className="text-2xl font-semibold">{viewTitle(activeView)}</h1>
            </div>
            <button className="inline-flex h-10 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canManageTenants} type="button" onClick={() => setActiveView("tenants")}>
              <Plus size={17} aria-hidden />
              Nuovo tenant
            </button>
          </header>

          <div className="p-5">
            {message ? (
              <div className="mb-4 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                <span>{message}</span>
                <button className="text-emerald-950" type="button" onClick={() => setMessage("")}>Chiudi</button>
              </div>
            ) : null}
            {loading ? <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-600"><Loader2 className="animate-spin" size={16} aria-hidden /> Caricamento</div> : null}

            {activeView === "dashboard" ? <DashboardView overview={overview} onOpenTenant={(slug) => loadTenant(slug)} /> : null}
            {activeView === "tenants" ? (
              <TenantsView
                overview={overview}
                query={query}
                statusFilter={statusFilter}
                canManage={canManageTenants}
                tenantDetail={tenantDetail}
                activeTab={activeTenantTab}
                supportLink={supportLink}
                backups={tenantDetail ? backups[tenantDetail.tenant.slug] ?? [] : []}
                onQueryChange={setQuery}
                onStatusChange={setStatusFilter}
                onFilter={() => loadOverview()}
                onOpenTenant={(slug, tab) => loadTenant(slug, tab)}
                onAction={tenantAction}
                onOperationAction={operationAction}
              />
            ) : null}
            {activeView === "controls" ? <ControlsView data={controls} onRefresh={loadControls} /> : null}
            {activeView === "sms_plans" ? <SmsPlansView data={smsBilling} canManage={canManageTenants} onAction={operationAction} onRefresh={loadSmsBilling} /> : null}
            {activeView === "send_movements" ? <MovementsView data={movements} onRefresh={loadMovements} /> : null}
            {activeView === "maintenance" ? <MaintenanceView tenants={overview.tenants} results={results} canManage={canManageTenants} onAction={tenantAction} /> : null}
            {activeView === "audit" ? <AuditList rows={overview.audit} /> : null}
            {activeView === "admins" ? <AdminsView admins={admins} currentUser={initialUser} onAction={adminAction} /> : null}
            {activeView === "security" ? <AdminSecurityPanel /> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function DashboardView({ overview, onOpenTenant }: { overview: OverviewPayload; onOpenTenant: (slug: string) => void }) {
  const metrics = [
    ["Tenant totali", overview.summary.total, "registro saas_tenants"],
    ["Attivi", overview.summary.active, "operativi"],
    ["Sospesi", overview.summary.suspended, "accesso bloccato"],
    ["Da verificare", overview.summary.needs_attention, "health o storico mancante"],
    ["Errori diagnostica", overview.operational.health_errors, "ultimo controllo"],
    ["Onboarding aperti", overview.operational.onboarding_open, "non completati"],
  ];
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map(([label, value, detail]) => <Metric key={label} label={String(label)} value={String(value)} detail={String(detail)} />)}
      </div>
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Tenant recenti" subtitle="Stato generale e ultimo health salvato." />
        <TenantTable tenants={overview.tenants.slice(0, 8)} onOpenTenant={onOpenTenant} />
      </section>
    </div>
  );
}

function TenantsView(props: {
  overview: OverviewPayload;
  query: string;
  statusFilter: string;
  canManage: boolean;
  tenantDetail: TenantDetailPayload | null;
  activeTab: TenantTab;
  supportLink: string;
  backups: BackupRow[];
  onQueryChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onFilter: () => void;
  onOpenTenant: (slug: string, tab?: TenantTab) => void;
  onAction: (action: string, payload?: Record<string, string>) => void;
  onOperationAction: (payload: Record<string, string>) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(480px,1.05fr)]">
      <div className="grid gap-5">
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <SectionHead title="Tenant" subtitle="Cerca, filtra e apri la gestione dedicata." />
          <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_190px_auto]">
            <label className="relative">
              <Search className="absolute left-3 top-3 text-slate-400" size={16} aria-hidden />
              <input className="h-10 w-full rounded-md border border-slate-200 pl-9 pr-3 outline-none focus:border-emerald-700" placeholder="Slug, nome o email admin" value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} />
            </label>
            <select className="h-10 rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" value={props.statusFilter} onChange={(event) => props.onStatusChange(event.target.value)}>
              <option value="">Tutti gli stati</option>
              {(["active", "suspended", "provisioning", "failed", "deleted"] as TenantStatus[]).map((status) => <option key={status} value={status}>{statusLabel[status]}</option>)}
            </select>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold" type="button" onClick={props.onFilter}>
              <SlidersHorizontal size={16} aria-hidden />
              Filtra
            </button>
          </div>
          <div className="flex justify-end border-b border-slate-100 px-4 py-2">
            <a className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50" href="/api/admin/operations?section=export_tenants" download>
              <Download size={14} aria-hidden />
              Esporta CSV
            </a>
          </div>
          <TenantTable tenants={props.overview.tenants} onOpenTenant={(slug) => props.onOpenTenant(slug)} />
        </section>
        <CreateTenantPanel canManage={props.canManage} onCreate={(payload) => props.onAction("create", payload)} />
      </div>
      <TenantDetailPanel
        detail={props.tenantDetail}
        activeTab={props.activeTab}
        supportLink={props.supportLink}
        backups={props.backups}
        canManage={props.canManage}
        onTabChange={(tab) => props.tenantDetail && props.onOpenTenant(props.tenantDetail.tenant.slug, tab)}
        onAction={props.onAction}
        onOperationAction={props.onOperationAction}
      />
    </div>
  );
}

function CreateTenantPanel({ canManage, onCreate }: { canManage: boolean; onCreate: (payload: Record<string, string>) => void }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <SectionHead title="Nuovo tenant" subtitle="Crea tenant, admin iniziale, sede principale e onboarding." />
      <form className="grid gap-3 p-4 md:grid-cols-2" onSubmit={(event) => {
        event.preventDefault();
        onCreate(formPayload(event.currentTarget));
        event.currentTarget.reset();
      }}>
        <Input name="tenant_name" label="Nome attivita" placeholder="Centro Estetico Elite" />
        <Input name="slug" label="Slug URL" placeholder="centroesteticoelite" required />
        <Input name="admin_name" label="Nome admin" defaultValue="Admin" />
        <Input name="admin_email" label="Email admin" type="email" required />
        <Input name="plan" label="Piano" placeholder="Standard" />
        <Input name="admin_pass" label="Password admin" type="text" required />
        <label className="md:col-span-2">
          <span className="mb-1 block text-sm font-medium text-slate-600">Note interne</span>
          <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-3 outline-none focus:border-emerald-700" name="notes" />
        </label>
        <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2" disabled={!canManage}>
          <Plus size={16} aria-hidden />
          Crea tenant
        </button>
      </form>
    </section>
  );
}

function TenantDetailPanel(props: {
  detail: TenantDetailPayload | null;
  activeTab: TenantTab;
  supportLink: string;
  backups: BackupRow[];
  canManage: boolean;
  onTabChange: (tab: TenantTab) => void;
  onAction: (action: string, payload?: Record<string, string>) => void;
  onOperationAction: (payload: Record<string, string>) => void;
}) {
  if (!props.detail) {
    return (
      <section className="rounded-md border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 text-slate-500">
          <Building2 size={20} aria-hidden />
          Seleziona un tenant per aprire la gestione completa.
        </div>
      </section>
    );
  }

  const tenant = props.detail.tenant;
  const status = tenantStatus(tenant);
  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Tenant</p>
          <h2 className="text-2xl font-semibold">{tenant.name}</h2>
          <div className="mt-1 flex flex-wrap gap-2 text-sm text-slate-500">
            <code>{tenant.slug}</code>
            <span>ID {tenant.id}</span>
          </div>
        </div>
        <Badge tone={statusTone(status)}>{statusLabel[status]}</Badge>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-slate-100 p-2">
        {tenantTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold ${props.activeTab === tab.key ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"}`} key={tab.key} type="button" onClick={() => props.onTabChange(tab.key)}>
              <Icon size={15} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="p-4">
        {props.activeTab === "overview" ? <TenantOverview tenant={tenant} /> : null}
        {props.activeTab === "settings" ? <TenantSettings tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "visibility" ? <TenantVisibility tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "admin" ? <TenantAdmin tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "onboarding" ? <TenantOnboarding tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "health" ? <TenantHealth detail={props.detail} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "support" ? <TenantSupport detail={props.detail} supportLink={props.supportLink} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "backups" ? <TenantBackups tenant={tenant} backups={props.backups} canManage={props.canManage} onAction={props.onOperationAction} /> : null}
        {props.activeTab === "danger" ? <TenantDanger tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
      </div>
    </section>
  );
}

function TenantOverview({ tenant }: { tenant: Tenant }) {
  const health = tenant.health?.level ?? "warning";
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Stato" value={statusLabel[tenantStatus(tenant)]} detail="tenant" />
        <Metric label="Salute" value={healthLabel[health]} detail={tenant.health_checked_at || "mai salvata"} />
        <Metric label="Onboarding" value={`${tenant.onboarding_percent ?? 0}%`} detail={tenant.onboarding_status || "not_started"} />
      </div>
      <div className="grid gap-2 text-sm">
        <Detail label="URL" value={`/${tenant.slug}/`} />
        <Detail label="Email admin" value={tenant.admin_email || "-"} />
        <Detail label="Piano" value={tenant.plan || "-"} />
        <Detail label="Origine" value={tenant.source === "self_signup" ? "Registrazione autonoma" : "Creazione admin"} />
        <Detail label="Creato il" value={tenant.created_at || "-"} />
      </div>
      <HealthChecks checks={tenant.health?.checks ?? []} />
    </div>
  );
}

function TenantSettings({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => submitAction(event, "update", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Input name="name" label="Nome" defaultValue={tenant.name} required />
      <Input name="admin_email" label="Email admin" type="email" defaultValue={tenant.admin_email ?? ""} />
      <Input name="plan" label="Piano" defaultValue={tenant.plan ?? ""} />
      <Input name="tenant_url" label="URL tenant" defaultValue={`/${tenant.slug}/`} disabled />
      <label className="md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-600">Note interne</span>
        <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-3 outline-none focus:border-emerald-700" name="notes" defaultValue={tenant.notes ?? ""} />
      </label>
      <Button disabled={!canManage} icon={Settings}>Salva dati</Button>
    </form>
  );
}

function TenantVisibility({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-4" onSubmit={(event) => submitAction(event, "visibility", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Toggle name="booking_public_allowed" label="Consenti visibilita booking" detail="Abilita prenotazioni online pubbliche e pulsanti Prenota." defaultChecked={Number(tenant.booking_public_allowed ?? 1) === 1} />
      <Toggle name="marketplace_public_allowed" label="Consenti visibilita marketplace" detail="Abilita scheda pubblica, sedi, ricerca e preferiti marketplace." defaultChecked={Number(tenant.marketplace_public_allowed ?? 1) === 1} />
      <Button disabled={!canManage} icon={Eye}>Salva visibilita</Button>
    </form>
  );
}

function TenantAdmin({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => submitAction(event, "repair_admin", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Input name="admin_name" label="Nome admin" defaultValue="Admin" />
      <Input name="admin_email" label="Email admin" type="email" defaultValue={tenant.admin_email ?? ""} required />
      <Input name="admin_pass" label="Nuova password" type="text" placeholder="Lascia vuoto per non cambiarla" />
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Verifica o ricrea utente admin, operatore collegato e sedi abilitate.</div>
      <Button disabled={!canManage} icon={UserCog}>Verifica admin tenant</Button>
    </form>
  );
}

function TenantOnboarding({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <div className="grid gap-4">
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-emerald-600" style={{ width: `${tenant.onboarding_percent ?? 0}%` }} />
      </div>
      <div className="grid gap-2 text-sm">
        <Detail label="Avanzamento" value={`${tenant.onboarding_percent ?? 0}%`} />
        <Detail label="Stato" value={tenant.onboarding_status || "not_started"} />
        <Detail label="Step corrente" value={tenant.onboarding_step || "-"} />
        <Detail label="Iniziato il" value={tenant.onboarding_started_at || "-"} />
        <Detail label="Completato il" value={tenant.onboarding_completed_at || "-"} />
      </div>
      <Button disabled={!canManage} icon={RotateCcw} onClick={() => onAction("reset_onboarding", { slug: tenant.slug })}>Reset onboarding</Button>
    </div>
  );
}

function TenantHealth({ detail, canManage, onAction }: { detail: TenantDetailPayload; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const tenant = detail.tenant;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canManage} icon={Activity} onClick={() => onAction("record_health", { slug: tenant.slug })}>Verifica diagnostica</Button>
        <Button variant="outline" disabled={!canManage} icon={Wrench} onClick={() => onAction("repair_schema", { slug: tenant.slug })}>Ripara schema</Button>
      </div>
      <HealthChecks checks={tenant.health?.checks ?? []} />
      {tenant.health?.missing_schema?.length ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Elementi schema mancanti: {tenant.health.missing_schema.slice(0, 20).join(", ")}</div> : null}
      <Table title="Storico diagnostica" headers={["Data", "Origine", "Esito", "Errori"]} rows={detail.healthChecks.map((row) => [row.created_at || "-", row.source || "-", healthLabel[row.level] || row.level, String(row.errors_count ?? 0)])} />
    </div>
  );
}

function TenantSupport({ detail, supportLink, canManage, onAction }: { detail: TenantDetailPayload; supportLink: string; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const tenant = detail.tenant;
  return (
    <div className="grid gap-4">
      {supportLink ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm font-semibold text-emerald-800">Link monouso generato. Dopo il primo accesso non sara riutilizzabile.</p>
          <input className="mt-2 h-10 w-full rounded-md border border-emerald-200 bg-white px-3 text-sm" readOnly value={supportLink} onFocus={(event) => event.currentTarget.select()} />
        </div>
      ) : null}
      <form className="grid gap-3 md:grid-cols-[1fr_150px]" onSubmit={(event) => submitAction(event, "support_create", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <Input name="reason" label="Motivo" placeholder="Es. verifica problema calendario" required />
        <label>
          <span className="mb-1 block text-sm font-medium text-slate-600">Durata</span>
          <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" name="minutes" defaultValue="30">
            <option value="15">15 minuti</option>
            <option value="30">30 minuti</option>
            <option value="60">1 ora</option>
            <option value="120">2 ore</option>
          </select>
        </label>
        <Button disabled={!canManage} icon={LifeBuoy}>Genera accesso supporto</Button>
      </form>
      <Table
        title="Token disponibili"
        headers={["Motivo", "Creato da", "Scadenza", "Azioni"]}
        rows={detail.activeTokens.map((token) => [
          token.reason || "-",
          token.created_by_email || "-",
          token.expires_at || "-",
          <button className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700" key={token.id} disabled={!canManage} type="button" onClick={() => onAction("support_revoke", { slug: tenant.slug, token_id: String(token.id) })}>Revoca</button>,
        ])}
      />
      <Table title="Storico accessi supporto" headers={["Motivo", "Creato da", "Scadenza", "Uso", "Revoca"]} rows={detail.recentTokens.map((token) => [token.reason || "-", token.created_by_email || "-", token.expires_at || "-", token.used_at || "-", token.revoked_at || "-"])} />
    </div>
  );
}

function TenantBackups({ tenant, backups, canManage, onAction }: { tenant: Tenant; backups: BackupRow[]; canManage: boolean; onAction: (payload: Record<string, string>) => void }) {
  return (
    <div className="grid gap-4">
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => submitOperation(event, "backup_create", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <Input name="reason" label="Motivo backup" placeholder="Es. prima di intervento tecnico" />
        <Button disabled={!canManage} icon={Archive}>Crea backup</Button>
      </form>
      <Table
        title="Backup disponibili"
        headers={["Data", "Motivo", "Dimensione", "Percorso", "Azioni"]}
        rows={backups.map((backup) => [
          backup.created_at || "-",
          backup.reason || "-",
          formatKb(backup.backup_size),
          <code className="text-xs" key={`path-${backup.id}`}>{backup.backup_path}</code>,
          <a className={`rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold ${canManage ? "" : "pointer-events-none opacity-50"}`} href={`/api/admin/operations?section=backup_download&slug=${encodeURIComponent(tenant.slug)}&id=${backup.id}`} key={`download-${backup.id}`}>Scarica</a>,
        ])}
      />
    </div>
  );
}

function ControlsView({ data, onRefresh }: { data: ControlsPayload | null; onRefresh: () => void }) {
  if (!data) {
    return <EmptyOperation icon={Activity} title="Controlli operativi" detail="Carica diagnostica provider SMS e tenant." onRefresh={onRefresh} />;
  }
  const provider = data.provider;
  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <Button variant="outline" icon={RotateCcw} onClick={onRefresh}>Aggiorna</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Provider SMS" value={provider.configured ? "Configurato" : "Non configurato"} detail={provider.environment || "-"} />
        <Metric label="Token" value={provider.token_present ? "Presente" : "Mancante"} detail={provider.sender || "sender non impostato"} />
        <Metric label="Callback" value={provider.callback_configured ? "Attiva" : "Mancante"} detail={provider.callback_url_configured ? "URL dedicato" : "URL automatico"} />
        <Metric label="Endpoint" value={provider.endpoint.ok ? "Raggiungibile" : "Da verificare"} detail={provider.endpoint.message} />
      </div>
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="OpenAPI SMS" subtitle={provider.base_url || "Endpoint non configurato"} />
        <div className="grid gap-2 p-4 text-sm">
          <Detail label="Timeout" value={`${provider.timeout || 0}s`} />
          <Detail label="Stato" value={healthLabel[provider.level]} />
          <Detail label="Avvisi" value={[...provider.errors, ...provider.warnings].join(" | ") || "-"} />
        </div>
      </section>
      <Table
        title="Diagnostica SMS tenant"
        headers={["Tenant", "Esito", "Messaggio", "Inviati", "Falliti", "Ultimo invio"]}
        rows={data.tenants.map((row) => [
          <span key={row.tenant_slug}><strong>{row.tenant_name}</strong><span className="ml-2 text-slate-500">{row.tenant_slug}</span></span>,
          <Badge tone={healthTone(row.level)} key={`level-${row.tenant_slug}`}>{healthLabel[row.level]}</Badge>,
          row.message,
          String(row.stats.sent ?? 0),
          String(row.stats.failed ?? 0),
          String(row.stats.last_sent_at ?? "-") || "-",
        ])}
      />
    </div>
  );
}

function SmsPlansView({ data, canManage, onAction, onRefresh }: { data: SmsBillingPayload | null; canManage: boolean; onAction: (payload: Record<string, string>) => void; onRefresh: () => void }) {
  if (!data) {
    return <EmptyOperation icon={CreditCard} title="Piani SMS" detail="Carica prezzi, piani, ordini e wallet tenant." onRefresh={onRefresh} />;
  }
  return (
    <div className="grid gap-5">
      <div className="flex justify-end gap-2">
        <a className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50" href="/api/admin/operations?section=export_sms_orders" download>
          <Download size={16} aria-hidden />
          Esporta ordini CSV
        </a>
        <Button variant="outline" icon={RotateCcw} onClick={onRefresh}>Aggiorna</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Crediti venduti" value={String(data.summary.credits_sold)} detail="ordini paid" />
        <Metric label="Ricavo lordo" value={formatEuro(data.summary.revenue_gross)} detail="ricariche SMS" />
        <Metric label="Ordini" value={String(data.summary.orders_total)} detail={`${data.summary.orders_pending} pending`} />
        <Metric label="Piani attivi" value={String(data.activePlans.length)} detail="visibili tenant" />
      </div>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Impostazioni prezzo" subtitle="Replica i parametri economici SaaS SMS del pannello PHP." />
        <form className="grid gap-3 p-4 md:grid-cols-5" onSubmit={(event) => submitOperation(event, "sms_save_settings", onAction)}>
          <Input name="provider_cost_per_segment" label="Costo provider" defaultValue={String(data.settings.provider_cost_per_segment ?? "0.0490")} />
          <Input name="target_margin_percent" label="Margine target %" defaultValue={String(data.settings.target_margin_percent ?? "25")} />
          <Input name="payment_fee_percent" label="Fee pagamento %" defaultValue={String(data.settings.payment_fee_percent ?? "2")} />
          <Input name="payment_fee_fixed" label="Fee fissa" defaultValue={String(data.settings.payment_fee_fixed ?? "0.30")} />
          <Input name="suggested_credit_price" label="Prezzo suggerito" defaultValue={String(data.settings.suggested_credit_price ?? "0.0700")} />
          <Button disabled={!canManage} icon={Settings}>Salva prezzi</Button>
        </form>
      </section>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Ricarica manuale tenant" subtitle="Crea ordine manuale, accredita wallet e registra movimento purchase." />
        <form className="grid gap-3 p-4 md:grid-cols-5" onSubmit={(event) => submitOperation(event, "sms_manual_topup", onAction)}>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Tenant</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" name="tenant_slug" required>
              {data.tenants.map((tenant) => <option key={tenant.slug} value={tenant.slug}>{tenant.name} ({tenant.wallet_balance})</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Piano</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" name="plan_id" defaultValue="">
              <option value="">Manuale</option>
              {data.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} - {plan.credits}</option>)}
            </select>
          </label>
          <Input name="credits" label="Crediti" type="number" min="0" placeholder="Da piano" />
          <Input name="amount_gross" label="Importo lordo" placeholder="Da piano" />
          <Input name="note" label="Nota" placeholder="Ricarica manuale SaaS" />
          <Button disabled={!canManage} icon={CreditCard}>Accredita</Button>
        </form>
      </section>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Piani" subtitle="Ordine, attivazione, evidenza e marginalita per pacchetto." />
        <div className="grid gap-3 p-4">
          {data.plans.map((plan) => (
            <form className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-[1.2fr_120px_120px_1.4fr_90px_90px_auto]" key={plan.id} onSubmit={(event) => submitOperation(event, "sms_save_plan", onAction)}>
              <input name="plan_id" type="hidden" value={plan.id} />
              <Input name="name" label="Nome" defaultValue={plan.name} />
              <Input name="credits" label="Crediti" type="number" min="1" defaultValue={plan.credits} />
              <Input name="price_gross" label="Prezzo" defaultValue={String(plan.price_gross)} />
              <Input name="description" label="Descrizione" defaultValue={plan.description ?? ""} />
              <Toggle name="is_active" label="Attivo" defaultChecked={Number(plan.is_active) === 1} compact />
              <Toggle name="is_featured" label="In evidenza" defaultChecked={Number(plan.is_featured) === 1} compact />
              <div className="flex items-end gap-2">
                <Button disabled={!canManage} icon={Settings}>Salva</Button>
                <button className="h-10 rounded-md border border-slate-200 px-2" disabled={!canManage} type="button" onClick={() => onAction({ action: "sms_move_plan", plan_id: String(plan.id), direction: "-1" })}><ArrowUp size={16} aria-hidden /></button>
                <button className="h-10 rounded-md border border-slate-200 px-2" disabled={!canManage} type="button" onClick={() => onAction({ action: "sms_move_plan", plan_id: String(plan.id), direction: "1" })}><ArrowDown size={16} aria-hidden /></button>
                <button className="h-10 rounded-md border border-slate-200 px-3 text-sm font-semibold" disabled={!canManage} type="button" onClick={() => onAction({ action: "sms_set_plan_active", plan_id: String(plan.id), active: Number(plan.is_active) === 1 ? "0" : "1" })}>{Number(plan.is_active) === 1 ? "Disattiva" : "Attiva"}</button>
              </div>
              <div className="md:col-span-7 text-sm text-slate-500">
                Costo provider {formatEuro(plan.economics.provider_cost)} - Fee {formatEuro(plan.economics.payment_fee)} - Margine {formatEuro(plan.economics.margin_value)} ({plan.economics.margin_percent.toFixed(1)}%)
              </div>
            </form>
          ))}
          <form className="grid gap-3 rounded-md border border-dashed border-slate-300 p-3 md:grid-cols-[1fr_120px_120px_1fr_100px_100px_auto]" onSubmit={(event) => submitOperation(event, "sms_save_plan", onAction)}>
            <Input name="name" label="Nuovo piano" placeholder="Nome" />
            <Input name="credits" label="Crediti" type="number" min="1" />
            <Input name="price_gross" label="Prezzo" />
            <Input name="description" label="Descrizione" />
            <Toggle name="is_active" label="Attivo" defaultChecked compact />
            <Toggle name="is_featured" label="In evidenza" compact />
            <Button disabled={!canManage} icon={Plus}>Crea</Button>
          </form>
        </div>
      </section>

      <Table
        title="Ordini recenti"
        headers={["ID", "Tenant", "Piano", "Stato", "Crediti", "Importo", "Data"]}
        rows={data.orders.map((order) => [String(order.id), order.tenant_slug, order.plan_name || "-", order.status, String(order.credits), formatEuro(order.amount_gross), order.created_at || "-"])}
      />
    </div>
  );
}

function MovementsView({ data, onRefresh }: { data: MovementsPayload | null; onRefresh: () => void }) {
  if (!data) {
    return <EmptyOperation icon={Send} title="Movimenti invii" detail="Carica ultimo storico SMS ed email da tutti i tenant." onRefresh={onRefresh} />;
  }
  const movementRows = (rows: MovementRow[]) => rows.map((row) => [
    <span key={`${row.channel}-${row.tenant_slug}-${row.event_at}`}><strong>{row.tenant_name}</strong><span className="ml-2 text-slate-500">{row.tenant_slug}</span></span>,
    row.kind,
    <Badge tone={movementTone(row.status)} key={`status-${row.channel}-${row.tenant_slug}-${row.event_at}`}>{row.status || "-"}</Badge>,
    row.client_name || row.recipient || "-",
    row.reference || row.subject || "-",
    row.channel === "SMS" ? String(row.credits ?? "-") : "-",
    row.event_at || "-",
    row.last_error || row.provider_state || "-",
  ]);
  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <Button variant="outline" icon={RotateCcw} onClick={onRefresh}>Aggiorna</Button>
      </div>
      <Table title="SMS" headers={["Tenant", "Tipo", "Stato", "Destinatario", "Riferimento", "Crediti", "Evento", "Dettaglio"]} rows={movementRows(data.sms)} />
      <Table title="Email" headers={["Tenant", "Tipo", "Stato", "Destinatario", "Riferimento", "Crediti", "Evento", "Dettaglio"]} rows={movementRows(data.emails)} />
    </div>
  );
}

function EmptyOperation({ icon: Icon, title, detail, onRefresh }: { icon: LucideIcon; title: string; detail: string; onRefresh: () => void }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-6 shadow-sm">
      <Icon className="text-emerald-700" size={22} aria-hidden />
      <h2 className="mt-3 text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
      <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white" type="button" onClick={onRefresh}>
        <RotateCcw size={16} aria-hidden />
        Carica
      </button>
    </section>
  );
}

function TenantDanger({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const status = tenantStatus(tenant);
  return (
    <div className="grid gap-4">
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => {
        event.preventDefault();
        const payload = formPayload(event.currentTarget);
        onAction(status === "active" ? "suspend" : "activate", { ...payload, slug: tenant.slug });
      }}>
        <Input name="reason" label={status === "active" ? "Motivo sospensione" : "Riattivazione"} placeholder="Es. pagamento scaduto" disabled={status !== "active"} />
        <Button disabled={!canManage || status === "deleted"} icon={status === "active" ? Lock : CheckCircle2}>{status === "active" ? "Sospendi" : "Riattiva"}</Button>
      </form>
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => {
        event.preventDefault();
        const payload = formPayload(event.currentTarget);
        onAction(status === "deleted" ? "restore" : "archive", { ...payload, slug: tenant.slug });
      }}>
        <Input name="reason" label={status === "deleted" ? "Archivio" : "Motivo archiviazione"} placeholder="Es. cliente cessato" disabled={status === "deleted"} />
        <Button variant="outline" disabled={!canManage} icon={RotateCcw}>{status === "deleted" ? "Ripristina" : "Archivia"}</Button>
      </form>
      <form className="rounded-md border border-red-200 bg-red-50 p-4" onSubmit={(event) => submitAction(event, "delete", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <p className="font-semibold text-red-800">Eliminazione definitiva</p>
        <p className="mt-1 text-sm text-red-700">Rimuove registro tenant e dati condivisi collegati. Digita lo slug esatto.</p>
        <div className="mt-3 flex gap-2">
          <input className="h-10 min-w-0 flex-1 rounded-md border border-red-200 bg-white px-3 outline-none" name="confirm_slug" placeholder={tenant.slug} />
          <button className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300 px-4 text-sm font-semibold text-red-800 disabled:opacity-50" disabled={!canManage}>
            <Trash2 size={16} aria-hidden />
            Elimina
          </button>
        </div>
      </form>
    </div>
  );
}

function MaintenanceView({ tenants, results, canManage, onAction }: { tenants: Tenant[]; results: Array<{ slug: string; ok: boolean; message: string }>; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-3">
        <ActionPanel icon={Activity} title="Verifica diagnostica" detail="Controlla tutti i tenant e salva lo storico." disabled={!canManage} onClick={() => onAction("health_all")} />
        <ActionPanel icon={Wrench} title="Ripara schema" detail="Aggiorna schema e onboarding dei tenant attivi." disabled={!canManage} onClick={() => onAction("repair_all")} />
        <ActionPanel icon={RotateCcw} title="Reset onboarding" detail="Riporta i tenant selezionati al primo step." disabled={!canManage || selected.length === 0} onClick={() => onAction("reset_selected_onboarding", { slugs: selected.join(",") })} />
      </div>
      {results.length ? <Table title="Risultati" headers={["Tenant", "Esito", "Messaggio"]} rows={results.map((row) => [row.slug, row.ok ? "OK" : "Errore", row.message])} /> : null}
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Tenant" subtitle="Seleziona tenant per operazioni massive." />
        <div className="divide-y divide-slate-100">
          {tenants.map((tenant) => (
            <label className="grid cursor-pointer grid-cols-[30px_1fr_auto_auto] items-center gap-3 p-3 text-sm" key={tenant.slug}>
              <input type="checkbox" checked={selected.includes(tenant.slug)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, tenant.slug] : current.filter((item) => item !== tenant.slug))} />
              <span><strong>{tenant.name}</strong><span className="ml-2 text-slate-500">{tenant.slug}</span></span>
              <Badge tone={statusTone(tenantStatus(tenant))}>{statusLabel[tenantStatus(tenant)]}</Badge>
              <Badge tone={healthTone(tenant.health?.level ?? "warning")}>{healthLabel[tenant.health?.level ?? "warning"]}</Badge>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

function AdminsView({ admins, currentUser, onAction }: { admins: AdminRecord[]; currentUser: SaasAdminUser; onAction: (payload: Record<string, string>) => void }) {
  return (
    <div className="grid gap-5">
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Nuovo admin" subtitle="Owner: controllo completo, Admin: operativita, Viewer: consultazione." />
        <form className="grid gap-3 p-4 md:grid-cols-4" onSubmit={(event) => submitAdmin(event, "create", onAction)}>
          <Input name="name" label="Nome" required />
          <Input name="email" label="Email" type="email" required />
          <RoleSelect />
          <Input name="password" label="Password" type="text" required />
          <Button icon={Users}>Crea admin</Button>
        </form>
      </section>
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Admin esistenti" subtitle={`Account corrente: ${currentUser.email}`} />
        <div className="grid gap-3 p-4">
          {admins.map((admin) => (
            <div className="rounded-md border border-slate-200 p-3" key={admin.id}>
              <form className="grid gap-3 md:grid-cols-[1fr_1fr_150px_120px_auto]" onSubmit={(event) => submitAdmin(event, "update", onAction)}>
                <input name="id" type="hidden" value={admin.id} />
                <Input name="name" label="Nome" defaultValue={admin.name} required />
                <Input name="email" label="Email" type="email" defaultValue={admin.email} required />
                <RoleSelect defaultValue={admin.role} />
                <Toggle name="is_active" label="Attivo" defaultChecked={admin.is_active === 1} compact />
                <Button variant="outline" icon={Settings}>Salva</Button>
              </form>
              <form className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_1fr]" onSubmit={(event) => submitAdmin(event, "password", onAction)}>
                <input name="id" type="hidden" value={admin.id} />
                <Input name="password" label="Nuova password" type="text" />
                <Button variant="outline" icon={KeyRound}>Aggiorna password</Button>
                <div className="flex items-end justify-end text-sm text-slate-500">Ultimo login: {admin.last_login_at || "-"}</div>
              </form>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TenantTable({ tenants, onOpenTenant }: { tenants: Tenant[]; onOpenTenant: (slug: string) => void }) {
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
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-600" style={{ width: `${tenant.onboarding_percent ?? 0}%` }} /></div>
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

function HealthChecks({ checks }: { checks: Array<{ key: string; label: string; level: HealthLevel; message: string }> }) {
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

function AuditList({ rows }: { rows: AuditRow[] }) {
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

function Table({ title, headers, rows }: { title: string; headers: string[]; rows: Array<Array<React.ReactNode>> }) {
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

function ActionPanel({ icon: Icon, title, detail, disabled, onClick }: { icon: LucideIcon; title: string; detail: string; disabled?: boolean; onClick: () => void }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <Icon className="text-emerald-700" size={20} aria-hidden />
      <h2 className="mt-3 font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
      <button className="mt-4 h-9 rounded-md border border-slate-200 px-3 text-sm font-semibold disabled:opacity-50" disabled={disabled} type="button" onClick={onClick}>Esegui</button>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <strong className="mt-2 block text-2xl">{value}</strong>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function SectionHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-slate-100 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

function Input({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label>
      <span className="mb-1 block text-sm font-medium text-slate-600">{label}</span>
      <input className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700 disabled:bg-slate-50 disabled:text-slate-500" {...props} />
    </label>
  );
}

function Toggle({ name, label, detail, defaultChecked, compact }: { name: string; label: string; detail?: string; defaultChecked?: boolean; compact?: boolean }) {
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

function RoleSelect({ defaultValue = "admin" }: { defaultValue?: string }) {
  return (
    <label>
      <span className="mb-1 block text-sm font-medium text-slate-600">Ruolo</span>
      <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-emerald-700" name="role" defaultValue={defaultValue}>
        <option value="owner">Owner</option>
        <option value="admin">Admin</option>
        <option value="viewer">Viewer</option>
      </select>
    </label>
  );
}

function Button({ icon: Icon, children, variant = "solid", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; variant?: "solid" | "outline" }) {
  return (
    <button className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:opacity-50 ${variant === "solid" ? "bg-emerald-700 text-white" : "border border-slate-200 bg-white text-slate-800"}`} {...props}>
      <Icon size={16} aria-hidden />
      {children}
    </button>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "info" | "muted"; children: React.ReactNode }) {
  const classes = {
    ok: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-900",
    danger: "bg-red-100 text-red-800",
    info: "bg-sky-100 text-sky-800",
    muted: "bg-slate-100 text-slate-600",
  };
  return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${classes[tone]}`}>{children}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-slate-100 py-2"><strong>{label}</strong><span className="text-right text-slate-600">{value}</span></div>;
}

function submitAction(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (action: string, payload?: Record<string, string>) => void) {
  event.preventDefault();
  onAction(action, formPayload(event.currentTarget));
}

function submitAdmin(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (payload: Record<string, string>) => void) {
  event.preventDefault();
  onAction({ action, ...formPayload(event.currentTarget) });
}

function submitOperation(event: React.FormEvent<HTMLFormElement>, action: string, onAction: (payload: Record<string, string>) => void) {
  event.preventDefault();
  onAction({ action, ...formPayload(event.currentTarget) });
}

function formPayload(form: HTMLFormElement): Record<string, string> {
  const formData = new FormData(form);
  const payload: Record<string, string> = {};
  for (const [key, value] of formData.entries()) payload[key] = typeof value === "string" ? value : value.name;
  return payload;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Richiesta non riuscita.");
  return data;
}

async function apiPost<T>(url: string, payload: Record<string, string>): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error ?? "Operazione non riuscita.");
  return data;
}

function tenantStatus(tenant: Tenant): TenantStatus {
  if (tenant.status && statusLabel[tenant.status]) return tenant.status;
  return Number(tenant.is_active ?? 1) === 1 ? "active" : "suspended";
}

function statusTone(status: TenantStatus): "ok" | "warn" | "danger" | "info" | "muted" {
  if (status === "active") return "ok";
  if (status === "suspended") return "warn";
  if (status === "provisioning") return "info";
  if (status === "failed" || status === "deleted") return "danger";
  return "muted";
}

function healthTone(level: HealthLevel): "ok" | "warn" | "danger" | "info" | "muted" {
  if (level === "ok") return "ok";
  if (level === "warning") return "warn";
  if (level === "error") return "danger";
  return "muted";
}

function movementTone(status: string): "ok" | "warn" | "danger" | "info" | "muted" {
  const normalized = status.toLowerCase();
  if (["sent", "delivered", "paid", "completed", "success"].includes(normalized)) return "ok";
  if (["pending", "scheduled", "queued"].includes(normalized)) return "warn";
  if (["failed", "error", "cancelled", "rejected"].includes(normalized)) return "danger";
  return "muted";
}

function viewTitle(view: ViewKey): string {
  if (view === "tenants") return "Tenant";
  if (view === "controls") return "Controlli";
  if (view === "sms_plans") return "Piani SMS";
  if (view === "send_movements") return "Movimenti invii";
  if (view === "maintenance") return "Manutenzione";
  if (view === "audit") return "Audit";
  if (view === "admins") return "Admin SaaS";
  if (view === "security") return "Sicurezza";
  return "Dashboard";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Operazione non riuscita.";
}

function formatEuro(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  return `${Number.isFinite(amount) ? amount.toFixed(2).replace(".", ",") : "0,00"} euro`;
}

function formatKb(value: number | string | null | undefined): string {
  const bytes = Number(value ?? 0);
  return `${(Number.isFinite(bytes) ? bytes / 1024 : 0).toFixed(1).replace(".", ",")} KB`;
}
