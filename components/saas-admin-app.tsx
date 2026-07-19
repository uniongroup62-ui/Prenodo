"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  History,
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
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SaasAdminUser } from "@/lib/saas-admin-auth";
import { AdminSecurityPanel } from "@/components/admin/admin-security-panel";
import { TenantDetailPanel } from "@/components/admin/admin-tenant-detail";
import {
  ActionPanel,
  AuditList,
  Badge,
  Button,
  Detail,
  EmptyOperation,
  Input,
  Metric,
  RoleSelect,
  SectionHead,
  Table,
  TenantTable,
  Toggle,
  apiGet,
  apiPost,
  errorMessage,
  formPayload,
  formatEuro,
  healthLabel,
  healthTone,
  movementTone,
  statusLabel,
  statusTone,
  submitAction,
  submitAdmin,
  submitOperation,
  tenantStatus,
  workSeverityStyle,
  type AdminRecord,
  type AuditRow,
  type BackupRow,
  type BillingPayload,
  type ControlsPayload,
  type MovementRow,
  type MovementsPayload,
  type SmsBillingPayload,
  type Tenant,
  type TenantDetailPayload,
  type TenantStatus,
  type TenantTab,
  type WorkItem,
} from "@/components/admin/admin-shared";

type ViewKey = "dashboard" | "tenants" | "controls" | "sms_plans" | "billing" | "send_movements" | "maintenance" | "audit" | "admins" | "security";

type OverviewPayload = {
  tenants: Tenant[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  summary: { total: number; active: number; suspended: number; failed: number; needs_attention: number };
  operational: { health_errors: number; health_warnings: number; health_missing: number; onboarding_open: number; archived: number; suspended: number };
  workQueue: WorkItem[];
  audit: AuditRow[];
};

const navItems: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "tenants", label: "Tenant", icon: Building2 },
  { key: "controls", label: "Controlli", icon: Activity },
  { key: "sms_plans", label: "Piani SMS", icon: CreditCard },
  { key: "billing", label: "Piani & Ricavi", icon: Wallet },
  { key: "send_movements", label: "Movimenti invii", icon: Send },
  { key: "maintenance", label: "Manutenzione", icon: Wrench },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "admins", label: "Admin SaaS", icon: Users },
  { key: "security", label: "Sicurezza", icon: ShieldCheck },
];

const emptyOverview: OverviewPayload = {
  tenants: [],
  total: 0,
  page: 1,
  perPage: 20,
  pageCount: 1,
  summary: { total: 0, active: 0, suspended: 0, failed: 0, needs_attention: 0 },
  operational: { health_errors: 0, health_warnings: 0, health_missing: 0, onboarding_open: 0, archived: 0, suspended: 0 },
  workQueue: [],
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
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-[#182238] text-white">
                <ShieldCheck size={20} aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#365a96]">SaaS Admin</p>
                <h1 className="text-2xl font-semibold">{bootstrapped ? "Accesso" : "Prima configurazione"}</h1>
              </div>
            </div>

            {message ? <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">{message}</div> : null}

            <form className="mt-6 space-y-4" onSubmit={submit}>
              {!bootstrapped ? (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">Nome</span>
                  <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" value={name} onChange={(event) => setName(event.target.value)} />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Email</span>
                <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <button className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={loading}>
                {loading ? <Loader2 className="animate-spin" size={17} aria-hidden /> : <KeyRound size={17} aria-hidden />}
                {bootstrapped ? "Accedi" : "Crea admin SaaS"}
              </button>
            </form>
          </div>
        </section>
        <aside className="hidden bg-[#141c30] p-8 text-white lg:block">
          <div className="flex h-full flex-col justify-between">
            <div>
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-[#365a96]">B</div>
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
  const [billing, setBilling] = useState<BillingPayload | null>(null);
  const [movements, setMovements] = useState<MovementsPayload | null>(null);
  const [backups, setBackups] = useState<Record<string, BackupRow[]>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
    if (key === "billing") void loadBilling();
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

  // Command palette (Fase B): Ctrl/Cmd+K apre la ricerca globale.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  async function loadOverview(nextQuery = query, nextStatus = statusFilter, nextPage = page) {
    setLoading(true);
    try {
      const search = new URLSearchParams();
      if (nextQuery.trim()) search.set("q", nextQuery.trim());
      if (nextStatus) search.set("status", nextStatus);
      if (nextPage > 1) search.set("page", String(nextPage));
      const data = await apiGet<OverviewPayload>(`/api/admin/tenants${search.toString() ? `?${search}` : ""}`);
      setOverview(data);
      setPage(data.page ?? nextPage);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  // Azione one-click dalla coda di lavoro (Fase B): ripara/verifica e
  // ricarica la fotografia senza aprire il dettaglio.
  async function quickWorkAction(action: string, slug: string) {
    try {
      await apiPost<{ ok: boolean }>("/api/admin/tenants", { action, slug });
      setMessage(`${action === "repair_schema" ? "Riparazione" : "Verifica"} eseguita su ${slug}.`);
      await loadOverview();
    } catch (error) {
      setMessage(errorMessage(error));
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

  async function loadBilling() {
    setLoading(true);
    try {
      const data = await apiGet<BillingPayload>("/api/admin/operations?section=billing");
      setBilling(data);
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
      if (payload.action?.startsWith("plan_")) await loadBilling();
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
        <aside className="border-r border-slate-200 bg-[#141c30] p-4 text-white">
          <div className="flex items-center gap-3 border-b border-white/10 pb-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#365a96] font-semibold">P</span>
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
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#365a96]">Pannello SaaS</p>
              <h1 className="text-2xl font-semibold">{viewTitle(activeView)}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50" type="button" onClick={() => setPaletteOpen(true)}>
                <Search size={16} aria-hidden />
                Cerca
                <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-500">Ctrl K</kbd>
              </button>
              <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canManageTenants} type="button" onClick={() => navigateView("tenants")}>
                <Plus size={17} aria-hidden />
                Nuovo tenant
              </button>
            </div>
          </header>

          <div className="p-5">
            {message ? (
              <div className="mb-4 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                <span>{message}</span>
                <button className="text-emerald-900" type="button" onClick={() => setMessage("")}>Chiudi</button>
              </div>
            ) : null}
            {loading ? <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-600"><Loader2 className="animate-spin" size={16} aria-hidden /> Caricamento</div> : null}

            {activeView === "dashboard" ? (
              <DashboardView
                overview={overview}
                canManage={canManageTenants}
                onOpenTenant={(slug, tab) => loadTenant(slug, (tab ?? "overview") as TenantTab)}
                onNavigate={(view) => navigateView(view as ViewKey)}
                onQuickAction={quickWorkAction}
              />
            ) : null}
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
                onFilter={() => loadOverview(query, statusFilter, 1)}
                onPageChange={(next) => loadOverview(query, statusFilter, next)}
                onOpenTenant={(slug, tab) => loadTenant(slug, tab)}
                onAction={tenantAction}
                onOperationAction={operationAction}
              />
            ) : null}
            {activeView === "controls" ? <ControlsView data={controls} onRefresh={loadControls} /> : null}
            {activeView === "sms_plans" ? <SmsPlansView data={smsBilling} canManage={canManageTenants} onAction={operationAction} onRefresh={loadSmsBilling} /> : null}
            {activeView === "billing" ? <BillingView data={billing} canManage={canManageTenants} onAction={operationAction} onRefresh={loadBilling} /> : null}
            {activeView === "send_movements" ? <MovementsView data={movements} onRefresh={loadMovements} /> : null}
            {activeView === "maintenance" ? <MaintenanceView tenants={overview.tenants} results={results} canManage={canManageTenants} onAction={tenantAction} /> : null}
            {activeView === "audit" ? <AuditList rows={overview.audit} /> : null}
            {activeView === "admins" ? <AdminsView admins={admins} currentUser={initialUser} onAction={adminAction} /> : null}
            {activeView === "security" ? <AdminSecurityPanel /> : null}
          </div>
        </section>
      </div>

      <CommandPalette
        open={paletteOpen}
        nav={visibleNav}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(view) => { setPaletteOpen(false); navigateView(view); }}
        onOpenTenant={(slug) => { setPaletteOpen(false); void loadTenant(slug); }}
      />
    </main>
  );
}

// Ricerca globale Ctrl+K (Fase B): sezioni del pannello + tenant cercati
// SERVER-SIDE (la lista in memoria e' paginata, non basta).
function CommandPalette({ open, nav, onClose, onNavigate, onOpenTenant }: {
  open: boolean;
  nav: Array<{ key: ViewKey; label: string; icon: LucideIcon }>;
  onClose: () => void;
  onNavigate: (view: ViewKey) => void;
  onOpenTenant: (slug: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTerm("");
    setIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      const search = new URLSearchParams({ per_page: "8" });
      if (term.trim()) search.set("q", term.trim());
      apiGet<OverviewPayload>(`/api/admin/tenants?${search}`)
        .then((data) => setTenants(data.tenants ?? []))
        .catch(() => setTenants([]));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [open, term]);

  const needle = term.trim().toLowerCase();
  const navMatches = nav.filter((item) => !needle || item.label.toLowerCase().includes(needle));
  const entries: Array<{ id: string; label: string; detail: string; run: () => void }> = [
    ...tenants.map((tenant) => ({
      id: `t:${tenant.slug}`,
      label: tenant.name || tenant.slug,
      detail: `Tenant · ${tenant.slug} · ${statusLabel[(tenant.status ?? "active") as TenantStatus] ?? tenant.status}`,
      run: () => onOpenTenant(tenant.slug),
    })),
    ...navMatches.map((item) => ({
      id: `v:${item.key}`,
      label: item.label,
      detail: "Vai alla sezione",
      run: () => onNavigate(item.key),
    })),
  ];
  const active = Math.min(index, Math.max(0, entries.length - 1));

  if (!open) return null;
  return (
    <div aria-modal className="fixed inset-0 z-50 bg-slate-950/40 p-4 pt-[12vh]" role="dialog" onClick={onClose}>
      <div className="mx-auto w-full max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-100 px-4">
          <Search className="text-slate-400" size={17} aria-hidden />
          <input
            className="h-12 w-full outline-none placeholder:text-slate-400"
            placeholder="Cerca tenant o sezione..."
            ref={inputRef}
            value={term}
            onChange={(event) => { setTerm(event.target.value); setIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(i + 1, entries.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (event.key === "Enter" && entries[active]) entries[active].run();
            }}
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {entries.length === 0 ? <p className="p-3 text-sm text-slate-500">Nessun risultato.</p> : entries.map((entry, i) => (
            <button
              className={`flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left ${i === active ? "bg-[#182238] text-white" : "hover:bg-slate-100"}`}
              key={entry.id}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={entry.run}
            >
              <span className="truncate text-sm font-semibold">{entry.label}</span>
              <span className={`shrink-0 text-xs ${i === active ? "text-white/70" : "text-slate-500"}`}>{entry.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardView({ overview, canManage, onOpenTenant, onNavigate, onQuickAction }: {
  overview: OverviewPayload;
  canManage: boolean;
  onOpenTenant: (slug: string, tab?: string) => void;
  onNavigate: (view: string) => void;
  onQuickAction: (action: string, slug: string) => void;
}) {
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

      {/* CODA DI LAVORO (Fase B): cosa richiede un'azione, in ordine di
          gravita', con azione one-click quando possibile. */}
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Da fare adesso" subtitle="Segnalazioni operative in ordine di gravita'." />
        {overview.workQueue.length === 0 ? (
          <p className="flex items-center gap-2 p-4 text-sm font-semibold text-emerald-700">
            <CheckCircle2 size={17} aria-hidden />
            Nessuna azione richiesta: tutto in ordine.
          </p>
        ) : (
          <div className="grid gap-2 p-4">
            {overview.workQueue.map((item) => (
              <div className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${workSeverityStyle[item.severity]}`} key={item.key}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{item.title}</p>
                  {item.detail ? <p className="truncate text-xs opacity-80">{item.detail}</p> : null}
                </div>
                {item.action && canManage ? (
                  <button className="inline-flex h-8 items-center gap-1 rounded-md border border-current px-3 text-xs font-semibold" type="button" onClick={() => onQuickAction(item.action as string, item.slug ?? "")}>
                    <Wrench size={13} aria-hidden />
                    {item.action === "repair_schema" ? "Ripara" : "Verifica"}
                  </button>
                ) : null}
                <button
                  className="inline-flex h-8 items-center rounded-md bg-[#182238] px-3 text-xs font-semibold text-white"
                  type="button"
                  onClick={() => (item.slug ? onOpenTenant(item.slug, item.tab) : onNavigate(item.view))}
                >
                  Apri
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Tenant recenti" subtitle="Stato generale e ultimo health salvato." />
        <TenantTable tenants={overview.tenants.slice(0, 8)} onOpenTenant={(slug) => onOpenTenant(slug)} />
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
  onPageChange: (page: number) => void;
  onOpenTenant: (slug: string, tab?: TenantTab) => void;
  onAction: (action: string, payload?: Record<string, string>) => void;
  onOperationAction: (payload: Record<string, string>) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(480px,1.05fr)]">
      {/* min-w-0: senza, gli item grid non scendono sotto la larghezza del
          contenuto (tabella min-w 760) e il pannello dettaglio COPRE la
          lista alle larghezze medie (bug walkthrough UX 19/07). */}
      <div className="grid min-w-0 gap-5">
        <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
          <SectionHead title="Tenant" subtitle="Cerca, filtra e apri la gestione dedicata." />
          <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_190px_auto]">
            <label className="relative">
              <Search className="absolute left-3 top-3 text-slate-400" size={16} aria-hidden />
              <input className="h-10 w-full rounded-md border border-slate-200 pl-9 pr-3 outline-none focus:border-[#365a96]" placeholder="Slug, nome o email admin" value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} />
            </label>
            <select className="h-10 rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" value={props.statusFilter} onChange={(event) => props.onStatusChange(event.target.value)}>
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
          {props.overview.pageCount > 1 ? (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm">
              <span className="text-slate-500">{props.overview.total} tenant · pagina {props.overview.page} di {props.overview.pageCount}</span>
              <div className="flex gap-2">
                <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold disabled:opacity-40" disabled={props.overview.page <= 1} type="button" onClick={() => props.onPageChange(props.overview.page - 1)}>
                  Precedente
                </button>
                <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold disabled:opacity-40" disabled={props.overview.page >= props.overview.pageCount} type="button" onClick={() => props.onPageChange(props.overview.page + 1)}>
                  Successiva
                </button>
              </div>
            </div>
          ) : null}
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
    <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
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
          <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-3 outline-none focus:border-[#365a96]" name="notes" />
        </label>
        <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2" disabled={!canManage}>
          <Plus size={16} aria-hidden />
          Crea tenant
        </button>
      </form>
    </section>
  );
}

// PIANI & RICAVI (Fase E): piani veri con limiti che governano i gate del
// gestionale + MRR, ricavo SMS per mese e wallet aggregato.
function BillingView({ data, canManage, onAction, onRefresh }: { data: BillingPayload | null; canManage: boolean; onAction: (payload: Record<string, string>) => void; onRefresh: () => void }) {
  // Modifica per riga (walkthrough UX 19/07): il bottone precompila il form
  // (key = remount con i defaultValue del piano scelto) — niente ID a mano.
  const [editing, setEditing] = useState<BillingPayload["plans"][number] | null>(null);
  if (!data) {
    return <EmptyOperation icon={Wallet} title="Piani & Ricavi" detail="Carica piani, MRR e ricavi SMS." onRefresh={onRefresh} />;
  }
  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <Button variant="outline" icon={RotateCcw} onClick={onRefresh}>Aggiorna</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="MRR" value={formatEuro(data.revenue.mrr_total)} detail="tenant attivi x piano" />
        <Metric label="Senza piano" value={String(data.revenue.unassigned_active)} detail="tenant attivi da assegnare" />
        <Metric label="Ricavo SMS (mese corrente)" value={formatEuro(data.revenue.sms_monthly[0]?.revenue ?? 0)} detail={data.revenue.sms_monthly[0]?.month ?? "-"} />
        <Metric label="Crediti wallet totali" value={String(data.revenue.wallet_credits_total)} detail="somma su tutti i tenant" />
      </div>

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title={editing ? `Modifica piano: ${editing.name}` : "Nuovo piano"} subtitle="Prezzo mensile e LIMITI: vuoto = illimitato. I limiti governano i gate del gestionale (es. creazione sedi)." />
        <form className="grid gap-3 p-4 md:grid-cols-5" key={editing ? `plan-${editing.id}` : "plan-new"} onSubmit={(event) => { submitOperation(event, "plan_save", onAction); setEditing(null); }}>
          <input name="plan_id" type="hidden" value={editing ? String(editing.id) : ""} readOnly />
          <Input name="name" label="Nome piano" placeholder="Pro" defaultValue={editing?.name ?? ""} required />
          <Input name="price_month" label="Prezzo/mese EUR" placeholder="49.90" defaultValue={editing ? String(editing.price_month) : ""} />
          <Input name="max_locations" label="Max sedi" placeholder="illimitato" defaultValue={editing?.max_locations === null || editing === null ? "" : String(editing.max_locations)} />
          <Input name="max_staff" label="Max staff" placeholder="illimitato" defaultValue={editing?.max_staff === null || editing === null ? "" : String(editing.max_staff)} />
          <Input name="sms_included_month" label="SMS inclusi/mese" placeholder="0" defaultValue={editing ? String(editing.sms_included_month) : ""} />
          <div className="flex gap-2 md:col-span-5">
            <Button disabled={!canManage} icon={Plus}>{editing ? "Salva modifiche" : "Crea piano"}</Button>
            {editing ? <Button icon={RotateCcw} type="button" variant="outline" onClick={() => setEditing(null)}>Annulla modifica</Button> : null}
          </div>
        </form>
      </section>

      <Table
        title="Piani e MRR"
        headers={["Piano", "Prezzo/mese", "Max sedi", "Max staff", "Tenant", "MRR", "Azioni"]}
        rows={data.plans.length === 0 ? [["Nessun piano definito", "-", "-", "-", "-", "-", "-"]] : data.plans.map((plan) => {
          const rev = data.revenue.by_plan.find((row) => row.id === plan.id);
          return [
            <span key={plan.id}><strong>{plan.name}</strong>{plan.is_active === 1 ? null : <span className="ml-2 text-xs text-slate-500">(disattivo)</span>}</span>,
            formatEuro(Number(plan.price_month)),
            plan.max_locations === null ? "illimitato" : String(plan.max_locations),
            plan.max_staff === null ? "illimitato" : String(plan.max_staff),
            String(rev?.tenants ?? 0),
            formatEuro(rev?.mrr ?? 0),
            <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40" disabled={!canManage} key={`edit-${plan.id}`} type="button" onClick={() => setEditing(plan)}>
              Modifica
            </button>,
          ];
        })}
      />

      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Assegna piano a tenant" subtitle="Aggiorna plan_id e l'etichetta del tenant; 'Nessun piano' = illimitato." />
        <form className="grid gap-3 p-4 md:grid-cols-3" onSubmit={(event) => submitOperation(event, "plan_assign", onAction)}>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Tenant</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="tenant_slug" required>
              {data.tenants.map((tenant) => <option key={tenant.slug} value={tenant.slug}>{tenant.name} ({tenant.slug}){tenant.plan ? ` — ${tenant.plan}` : ""}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Piano</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="plan_id">
              <option value="0">Nessun piano (illimitato)</option>
              {data.plans.filter((plan) => plan.is_active === 1).map((plan) => <option key={plan.id} value={String(plan.id)}>{plan.name} — {formatEuro(Number(plan.price_month))}/mese</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button disabled={!canManage} icon={UserCog}>Assegna</Button>
          </div>
        </form>
      </section>

      <Table
        title="Ricavo SMS per mese (ordini pagati)"
        headers={["Mese", "Ordini", "Crediti", "Ricavo"]}
        rows={data.revenue.sms_monthly.length === 0 ? [["-", "-", "-", "-"]] : data.revenue.sms_monthly.map((row) => [row.month, String(row.orders), String(row.credits), formatEuro(row.revenue)])}
      />
    </div>
  );
}

// TIMELINE unificata (Fase D): la storia del tenant in un solo feed —
// audit + diagnostiche + backup + supporto + ordini SMS in ordine cronologico.

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
      {/* Registro cron (Fase C): stato corrente per job + esecuzioni recenti. */}
      <Table
        title="Cron: ultima esecuzione per job"
        headers={["Job", "Esito", "Avviato", "Durata", "Sintesi"]}
        rows={(data.cron?.jobs ?? []).length === 0
          ? [["Nessuna esecuzione registrata: schedula /api/cron/* (EventBridge o scheduler esterno con CRON_SECRET)", "-", "-", "-", "-"]]
          : (data.cron?.jobs ?? []).map((run) => [
            <strong key={run.job}>{run.job}</strong>,
            <Badge tone={run.status === "ok" ? "ok" : "danger"} key={`s-${run.job}`}>{run.status === "ok" ? "OK" : "Errore"}</Badge>,
            run.started_at || "-",
            `${Math.round(Number(run.duration_ms ?? 0))} ms`,
            <span className="block max-w-xs truncate" key={`m-${run.job}`} title={run.message ?? ""}>{run.message || "-"}</span>,
          ])}
      />
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
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="tenant_slug" required>
              {data.tenants.map((tenant) => <option key={tenant.slug} value={tenant.slug}>{tenant.name} ({tenant.wallet_balance})</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Piano</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="plan_id" defaultValue="">
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

function viewTitle(view: ViewKey): string {
  if (view === "tenants") return "Tenant";
  if (view === "controls") return "Controlli";
  if (view === "sms_plans") return "Piani SMS";
  if (view === "billing") return "Piani & Ricavi";
  if (view === "send_movements") return "Movimenti invii";
  if (view === "maintenance") return "Manutenzione";
  if (view === "audit") return "Audit";
  if (view === "admins") return "Admin SaaS";
  if (view === "security") return "Sicurezza";
  return "Dashboard";
}

