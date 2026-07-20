"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  BarChart3,
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
  UserPlus,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SaasAdminUser } from "@/lib/saas-admin-auth";
import { AdminSecurityPanel } from "@/components/admin/admin-security-panel";
import { StatsView, type StatsPayload } from "@/components/admin/admin-stats-view";
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
  formatDateTime,
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
  type PlanOption,
  type SmsBillingPayload,
  type Tenant,
  type TenantDetailPayload,
  type TenantStatus,
  type TenantTab,
  type WorkItem,
} from "@/components/admin/admin-shared";

// Menu consolidato (2026-07-19, da 11 a 8 voci): "Fatturazione" riunisce
// abbonamenti e pacchetti SMS; "Operazioni" riunisce controlli, movimenti
// invii e manutenzione. Le vecchie ?page= restano deep-linkabili (mappa in
// app/admin/page.tsx) e la sottosezione vive in ?sec=.
type ViewKey = "dashboard" | "tenants" | "stats" | "billing" | "operations" | "signups" | "audit" | "admins" | "security";
type BillingSection = "plans" | "sms";
type OperationsSection = "controls" | "movements" | "maintenance";

type SignupRow = {
  id: number;
  business_name: string;
  slug: string;
  owner_name: string;
  owner_email: string;
  owner_phone: string | null;
  status: string;
  verified_at: string | null;
  provisioning_error: string | null;
  tenant_id: number | null;
  tenant_exists: boolean;
  created_at: string | null;
};

type AuditFilters = { q: string; action: string; tenant: string };

type AuditSearchPayload = {
  rows: Array<AuditRow & { meta_json?: string | null }>;
  total: number;
  page: number;
  perPage: number;
};

type ExecSummary = {
  mrr: number;
  marketplace_accounts: number;
  sms_month_revenue: number;
  mrr_prev: number | null;
  marketplace_prev: number | null;
};

type SystemStatus = {
  cron_ok: number;
  cron_error: number;
  cron_last_job?: string | null;
  cron_last_at?: string | null;
  last_backup_slug: string | null;
  last_backup_at: string | null;
  totp_policy: boolean;
};

type OverviewPayload = {
  exec: ExecSummary;
  system: SystemStatus;
  plans: PlanOption[];
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
  { key: "stats", label: "Statistiche", icon: BarChart3 },
  { key: "billing", label: "Fatturazione", icon: Wallet },
  { key: "operations", label: "Operazioni", icon: Activity },
  { key: "signups", label: "Registrazioni", icon: UserPlus },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "admins", label: "Admin SaaS", icon: Users },
  { key: "security", label: "Sicurezza", icon: ShieldCheck },
];

const billingSections: Array<{ key: BillingSection; label: string; icon: LucideIcon }> = [
  { key: "plans", label: "Abbonamenti & Ricavi", icon: Wallet },
  { key: "sms", label: "Pacchetti SMS", icon: CreditCard },
];

const operationsSections: Array<{ key: OperationsSection; label: string; icon: LucideIcon }> = [
  { key: "controls", label: "Controlli", icon: Activity },
  { key: "movements", label: "Movimenti invii", icon: Send },
  { key: "maintenance", label: "Manutenzione", icon: Wrench },
];

const emptyOverview: OverviewPayload = {
  exec: { mrr: 0, marketplace_accounts: 0, sms_month_revenue: 0, mrr_prev: null, marketplace_prev: null },
  system: { cron_ok: 0, cron_error: 0, last_backup_slug: null, last_backup_at: null, totp_policy: false },
  plans: [],
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

export function SaasAdminApp({
  initialUser,
  initialView = "dashboard",
  initialSlug = "",
  initialTab = "overview",
  initialSection = "",
  totpRequired = false,
}: {
  initialUser: SaasAdminUser;
  initialView?: ViewKey;
  initialSlug?: string;
  initialTab?: TenantTab;
  initialSection?: string;
  totpRequired?: boolean;
}) {
  const [activeView, setActiveView] = useState<ViewKey>(initialView);
  const [billingTab, setBillingTab] = useState<BillingSection>(initialView === "billing" && initialSection === "sms" ? "sms" : "plans");
  const [opsTab, setOpsTab] = useState<OperationsSection>(initialView === "operations" && (initialSection === "movements" || initialSection === "maintenance") ? (initialSection as OperationsSection) : "controls");
  const [overview, setOverview] = useState<OverviewPayload>(emptyOverview);
  const [tenantDetail, setTenantDetail] = useState<TenantDetailPayload | null>(null);
  const [activeTenantTab, setActiveTenantTab] = useState<TenantTab>("overview");
  const [controls, setControls] = useState<ControlsPayload | null>(null);
  const [smsBilling, setSmsBilling] = useState<SmsBillingPayload | null>(null);
  const [billing, setBilling] = useState<BillingPayload | null>(null);
  const [restoreCandidates, setRestoreCandidates] = useState<BackupRow[]>([]);
  const [auditData, setAuditData] = useState<AuditSearchPayload | null>(null);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({ q: "", action: "", tenant: "" });
  const [signups, setSignups] = useState<SignupRow[] | null>(null);
  const [statsData, setStatsData] = useState<StatsPayload | null>(null);
  const [movements, setMovements] = useState<MovementsPayload | null>(null);
  const [backups, setBackups] = useState<Record<string, BackupRow[]>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Form "Nuovo tenant" collassato di default (analisi organizzazione 19/07):
  // 8 campi sempre aperti occupavano mezza pagina; si apre dal bottone header.
  const [createOpen, setCreateOpen] = useState(false);
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
  function syncUrl(view: ViewKey, slug = "", tab: TenantTab = "overview", push = true, sec = "") {
    const params = new URLSearchParams();
    if (view !== "dashboard") params.set("page", view);
    if (view === "tenants" && slug) {
      params.set("slug", slug);
      if (tab !== "overview") params.set("tab", tab);
    }
    // Sottosezione (Fatturazione/Operazioni) nell'URL solo se non-default.
    if (view === "billing" && sec && sec !== "plans") params.set("sec", sec);
    if (view === "operations" && sec && sec !== "controls") params.set("sec", sec);
    const url = `/admin${params.toString() ? `?${params}` : ""}`;
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== url) {
      if (push) window.history.pushState({ view, slug, tab, sec }, "", url);
      else window.history.replaceState({ view, slug, tab, sec }, "", url);
    }
  }

  // Caricamento dati per-vista/sottosezione (nav, deep-link, popstate).
  const loadForView = (key: ViewKey, sec = "") => {
    if (key === "admins") void loadAdmins();
    if (key === "signups") void loadSignups();
    if (key === "audit") void loadAudit(auditFilters, 1);
    if (key === "stats") void loadStats();
    if (key === "billing") {
      if (sec === "sms") void loadSmsBilling();
      else void loadBilling();
    }
    if (key === "operations") {
      if (sec === "movements") void loadMovements();
      else if (sec === "maintenance") void loadRestoreCandidates();
      else void loadControls();
    }
  };

  function navigateView(key: ViewKey, push = true, sec = "") {
    setActiveView(key);
    setTenantDetail(null);
    if (key === "billing") setBillingTab(sec === "sms" ? "sms" : "plans");
    if (key === "operations") setOpsTab(sec === "movements" || sec === "maintenance" ? (sec as OperationsSection) : "controls");
    loadForView(key, sec);
    syncUrl(key, "", "overview", push, sec);
  }

  // Cambio sottosezione: stato + load pigro + URL (replace, niente history spam).
  function selectBillingTab(sec: BillingSection) {
    setBillingTab(sec);
    loadForView("billing", sec);
    syncUrl("billing", "", "overview", false, sec);
  }

  function selectOpsTab(sec: OperationsSection) {
    setOpsTab(sec);
    loadForView("operations", sec);
    syncUrl("operations", "", "overview", false, sec);
  }

  // Deep-link iniziale (?page/slug/tab) + tasto Indietro (popstate).
  useEffect(() => {
    if (initialSlug) void loadTenant(initialSlug, initialTab);
    else loadForView(initialView, initialSection);
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const view = (params.get("page") || "dashboard") as ViewKey;
      const slug = params.get("slug") || "";
      const tab = (params.get("tab") || "overview") as TenantTab;
      const sec = params.get("sec") || "";
      if (view === "tenants" && slug) void loadTenant(slug, tab, false);
      else if (navItems.some((item) => item.key === view) || view === "dashboard") {
        navigateView(view, false, sec);
      } else {
        navigateView("dashboard", false);
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
      setMessage(`Verifica eseguita su ${slug}.`);
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
      if (action === "create") setCreateOpen(false);
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

async function loadStats() {
    setLoading(true);
    try {
      const data = await apiGet<{ stats: StatsPayload }>("/api/admin/operations?section=stats");
      setStatsData(data.stats);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadAudit(filters: AuditFilters, nextPage = 1) {
    setLoading(true);
    try {
      const search = new URLSearchParams();
      if (filters.q.trim()) search.set("q", filters.q.trim());
      if (filters.action.trim()) search.set("audit_action", filters.action.trim());
      if (filters.tenant.trim()) search.set("tenant", filters.tenant.trim());
      if (nextPage > 1) search.set("page", String(nextPage));
      search.set("section", "audit_search");
      const data = await apiGet<AuditSearchPayload>(`/api/admin/operations?${search}`);
      setAuditData(data);
      setAuditFilters(filters);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadRestoreCandidates() {
    try {
      const data = await apiGet<{ candidates: BackupRow[] }>("/api/admin/operations?section=restore_candidates");
      setRestoreCandidates(data.candidates ?? []);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function loadSignups() {
    setLoading(true);
    try {
      const data = await apiGet<{ signups: SignupRow[] }>("/api/admin/operations?section=signups");
      setSignups(data.signups ?? []);
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
      if (payload.action === "backup_restore") { await loadRestoreCandidates(); await loadOverview(); }
      if (payload.action === "signup_delete") await loadSignups();
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
            {/* Niente bottone Cerca (richiesta utente 20/07): la palette
                resta disponibile con Ctrl/Cmd+K. */}
            <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canManageTenants} type="button" onClick={() => { navigateView("tenants"); setCreateOpen(true); }}>
              <Plus size={17} aria-hidden />
              Nuovo tenant
            </button>
          </header>

          <div className="p-5">
            {message ? (
              <div className="mb-4 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                <span>{message}</span>
                <button className="text-emerald-900" type="button" onClick={() => setMessage("")}>Chiudi</button>
              </div>
            ) : null}
            {loading ? <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-600"><Loader2 className="animate-spin" size={16} aria-hidden /> Caricamento</div> : null}

            {/* Blocco SOFT policy 2FA: senza 2FA configurata resta usabile
                solo la vista Sicurezza (rifiniture 19/07). */}
            {totpRequired && activeView !== "security" ? (
              <section className="rounded-md border border-amber-200 bg-amber-50 p-6">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 shrink-0 text-amber-700" size={22} aria-hidden />
                  <div>
                    <h2 className="text-lg font-semibold text-amber-900">2FA obbligatoria</h2>
                    <p className="mt-1 text-sm text-amber-800">La policy della piattaforma richiede l&apos;autenticazione a due fattori: configurala per continuare a usare il pannello.</p>
                    <button className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white" type="button" onClick={() => navigateView("security")}>
                      <ShieldCheck size={16} aria-hidden />
                      Configura la 2FA
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <>
            {activeView === "dashboard" ? (
              <DashboardView
                overview={overview}
                canManage={canManageTenants}
                onOpenTenant={(slug, tab) => loadTenant(slug, (tab ?? "overview") as TenantTab)}
                onNavigate={(view, sec) => navigateView(view as ViewKey, true, sec ?? "")}
                onQuickAction={quickWorkAction}
                onRunDiagnostics={async () => { await operationAction({ action: "cron_run", job: "admin-health" }); await loadOverview(); }}
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
                createOpen={createOpen}
                onToggleCreate={setCreateOpen}
                onQueryChange={setQuery}
                onStatusChange={setStatusFilter}
                onFilter={() => loadOverview(query, statusFilter, 1)}
                onPageChange={(next) => loadOverview(query, statusFilter, next)}
                onOpenTenant={(slug, tab) => loadTenant(slug, tab)}
                onBackToList={() => navigateView("tenants")}
                onAction={tenantAction}
                onOperationAction={operationAction}
              />
            ) : null}
            {activeView === "billing" ? (
              <div className="grid gap-4">
                <SectionTabs active={billingTab} sections={billingSections} onSelect={(key) => selectBillingTab(key as BillingSection)} action={<Button variant="outline" icon={RotateCcw} onClick={() => (billingTab === "plans" ? loadBilling() : loadSmsBilling())}>Aggiorna</Button>} />
                {billingTab === "plans" ? <BillingView data={billing} canManage={canManageTenants} onAction={operationAction} onRefresh={loadBilling} /> : null}
                {billingTab === "sms" ? <SmsPlansView data={smsBilling} canManage={canManageTenants} onAction={operationAction} onRefresh={loadSmsBilling} /> : null}
              </div>
            ) : null}
            {activeView === "operations" ? (
              <div className="grid gap-4">
                <SectionTabs active={opsTab} sections={operationsSections} onSelect={(key) => selectOpsTab(key as OperationsSection)} action={opsTab === "maintenance" ? null : <Button variant="outline" icon={RotateCcw} onClick={() => (opsTab === "controls" ? loadControls() : loadMovements())}>Aggiorna</Button>} />
                {opsTab === "controls" ? <ControlsView canManage={canManageTenants} data={controls} onRefresh={loadControls} onRunHealth={async () => { await operationAction({ action: "cron_run", job: "admin-health" }); await loadControls(); }} /> : null}
                {opsTab === "movements" ? <MovementsView data={movements} onRefresh={loadMovements} /> : null}
                {opsTab === "maintenance" ? <MaintenanceView tenants={overview.tenants} results={results} restoreCandidates={restoreCandidates} canManage={canManageTenants} onAction={tenantAction} onOperationAction={operationAction} /> : null}
              </div>
            ) : null}
            {activeView === "stats" ? <StatsView data={statsData} onOpenTenant={(slug) => loadTenant(slug)} onRefresh={loadStats} /> : null}
            {activeView === "signups" ? <SignupsView signups={signups} canManage={canManageTenants} onOpenTenant={(slug) => loadTenant(slug)} onAction={operationAction} onRefresh={loadSignups} /> : null}
            {activeView === "audit" ? <AuditView data={auditData} filters={auditFilters} onSearch={(filters) => loadAudit(filters, 1)} onPageChange={(next) => loadAudit(auditFilters, next)} /> : null}
            {activeView === "admins" ? <AdminsView admins={admins} currentUser={initialUser} onAction={adminAction} /> : null}
            {activeView === "security" ? <AdminSecurityPanel /> : null}
              </>
            )}
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

// Barra sottosezioni delle viste consolidate (Fatturazione/Operazioni).
// `action` (es. Aggiorna) vive QUI a destra: mai bande dedicate a un bottone.
function SectionTabs({ active, sections, onSelect, action }: { active: string; sections: Array<{ key: string; label: string; icon: LucideIcon }>; onSelect: (key: string) => void; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white p-2 shadow-sm">
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <button
            className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold ${active === section.key ? "bg-[#182238] text-white" : "text-slate-600 hover:bg-slate-100"}`}
            key={section.key}
            type="button"
            onClick={() => onSelect(section.key)}
          >
            <Icon size={15} aria-hidden />
            {section.label}
          </button>
        );
      })}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
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

function DashboardView({ overview, canManage, onOpenTenant, onNavigate, onQuickAction, onRunDiagnostics }: {
  overview: OverviewPayload;
  canManage: boolean;
  onOpenTenant: (slug: string, tab?: string) => void;
  onNavigate: (view: string, sec?: string) => void;
  onQuickAction: (action: string, slug: string) => void;
  onRunDiagnostics: () => void;
}) {
  // Riga EXECUTIVE (vista Statistiche 19/07): business prima, operativo
  // sotto. Delta calcolato SOLO se lo snapshot di ~30 giorni fa esiste
  // (mai delta inventati: senza storico si mostra il valore e basta).
  const delta = (current: number, prev: number | null, euro = false) => {
    if (prev === null) return "";
    const diff = Math.round((current - prev) * 100) / 100;
    if (diff === 0) return " · stabile vs 30gg fa";
    const value = euro ? formatEuro(Math.abs(diff)) : String(Math.abs(diff));
    return ` · ${diff > 0 ? "+" : "-"}${value} vs 30gg fa`;
  };
  // KPI cliccabili: ogni numero porta alla vista che lo spiega.
  const execMetrics: Array<[string, string, string, () => void]> = [
    ["Ricavo abbonamenti (MRR)", formatEuro(overview.exec.mrr), `somma piani dei tenant attivi${delta(overview.exec.mrr, overview.exec.mrr_prev, true)}`, () => onNavigate("billing")],
    ["Tenant attivi", String(overview.summary.active), `su ${overview.summary.total} totali`, () => onNavigate("tenants")],
    ["Utenti marketplace", String(overview.exec.marketplace_accounts), `account clienti${delta(overview.exec.marketplace_accounts, overview.exec.marketplace_prev)}`, () => onNavigate("stats")],
    ["Ricavo SMS (mese)", formatEuro(overview.exec.sms_month_revenue), "ordini pagati nel mese", () => onNavigate("billing", "sms")],
  ];
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {execMetrics.map(([label, value, detail, open]) => <Metric key={label} label={label} value={value} detail={detail} onClick={open} />)}
      </div>

      {/* Fascia centrale (redesign 19/07): coda a 2/3 + stato sistema e
          azioni rapide a 1/3. A coda vuota la card non si stira (self-start). */}
      <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
        <section className={`min-w-0 rounded-md border border-slate-200 bg-white shadow-sm ${overview.workQueue.length === 0 ? "self-start" : ""}`}>
          <SectionHead title="Da fare adesso" subtitle="Segnalazioni operative in ordine di gravità." />
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
                      Verifica
                    </button>
                  ) : null}
                  <button
                    className="inline-flex h-8 items-center rounded-md bg-[#182238] px-3 text-xs font-semibold text-white"
                    type="button"
                    onClick={() => (item.slug ? onOpenTenant(item.slug, item.tab) : onNavigate(item.view, item.section))}
                  >
                    Apri
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
          <SectionHead title="Stato sistema" subtitle="Cron, backup e sicurezza a colpo d'occhio." />
          <div className="grid gap-1 p-4 text-sm">
            {/* Ogni riga porta alla vista che la spiega: mai vicoli ciechi. */}
            <button className="flex items-center justify-between gap-2 rounded-md border-b border-slate-100 px-1 pb-2 pt-1 text-left hover:bg-slate-50" type="button" onClick={() => onNavigate("operations", "controls")}>
              <span className="font-medium text-slate-600">Cron</span>
              <span className="text-right">
                {overview.system.cron_error > 0
                  ? <Badge tone="danger">{overview.system.cron_error} in errore</Badge>
                  : overview.system.cron_ok > 0
                    ? <Badge tone="ok">{overview.system.cron_ok} job OK</Badge>
                    : <Badge tone="muted">nessuna esecuzione</Badge>}
                {overview.system.cron_last_job ? <span className="mt-0.5 block text-xs text-slate-500">{overview.system.cron_last_job} · {formatDateTime(overview.system.cron_last_at)}</span> : null}
              </span>
            </button>
            <button className="flex items-center justify-between gap-2 rounded-md border-b border-slate-100 px-1 pb-2 pt-1 text-left hover:bg-slate-50" type="button" onClick={() => onNavigate("operations", "maintenance")}>
              <span className="font-medium text-slate-600">Ultimo backup</span>
              <span className="text-right text-slate-600">{overview.system.last_backup_at ? `${overview.system.last_backup_slug} · ${formatDateTime(overview.system.last_backup_at)}` : "nessuno"}</span>
            </button>
            <button className="flex items-center justify-between gap-2 rounded-md px-1 pb-1 pt-1 text-left hover:bg-slate-50" type="button" onClick={() => onNavigate("security")}>
              <span className="font-medium text-slate-600">Policy 2FA</span>
              {overview.system.totp_policy ? <Badge tone="ok">obbligatoria</Badge> : <Badge tone="warn">da attivare</Badge>}
            </button>
            {/* Azioni rapide senza doppioni: Nuovo tenant vive gia' nella
                barra in alto, sempre visibile. */}
            <div className="mt-2 grid gap-2 border-t border-slate-100 pt-3">
              <button className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={!canManage} type="button" onClick={onRunDiagnostics}>
                <Activity size={15} aria-hidden />
                Esegui diagnostica
              </button>
              <button className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50" type="button" onClick={() => onNavigate("stats")}>
                <BarChart3 size={15} aria-hidden />
                Vedi statistiche
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Attivita' recente al posto di "Tenant recenti" (redesign 19/07): il
          feed audit dice COSA sta succedendo; ai tenant si arriva da nav,
          palette e coda. I messaggi audit sono gia' in italiano. */}
      <Table
        title="Attività recente"
        headers={["Quando", "Cosa", "Tenant", "Chi"]}
        action={<button className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50" type="button" onClick={() => onNavigate("audit")}>Apri l&apos;Audit completo</button>}
        empty="Nessuna attività registrata."
        rows={overview.audit.slice(0, 10).map((row) => [
          formatDateTime(row.created_at),
          row.message || row.action,
          row.tenant_slug
            ? <button className="text-sm font-semibold text-[#365a96] hover:underline" key={`t-${row.id}`} type="button" onClick={() => onOpenTenant(String(row.tenant_slug))}>{row.tenant_slug}</button>
            : "-",
          row.actor_email || "sistema",
        ])}
      />
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
  createOpen: boolean;
  onToggleCreate: (open: boolean) => void;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onFilter: () => void;
  onPageChange: (page: number) => void;
  onOpenTenant: (slug: string, tab?: TenantTab) => void;
  onBackToList: () => void;
  onAction: (action: string, payload?: Record<string, string>) => void;
  onOperationAction: (payload: Record<string, string>) => void;
}) {
  // PAGINA DEDICATA (richiesta utente 19/07): con un tenant aperto la lista
  // sparisce e il dettaglio prende tutta la larghezza, con ritorno esplicito.
  if (props.tenantDetail) {
    return (
      <div className="grid gap-4">
        <div>
          <button className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50" type="button" onClick={props.onBackToList}>
            ← Tutti i tenant
          </button>
        </div>
        <TenantDetailPanel
          detail={props.tenantDetail}
          plans={props.overview.plans}
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

  return (
    <div className="grid min-w-0 gap-5">
        {/* Il modulo di creazione e' un POPUP modale (20/07): visibile subito
            al click, qualunque sia lo scroll della lista. */}
        <CreateTenantPanel canManage={props.canManage} open={props.createOpen} plans={props.overview.plans} onCreate={(payload) => props.onAction("create", payload)} onToggle={props.onToggleCreate} />
        <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
          <SectionHead title="Tenant" subtitle="Cerca, filtra e apri la gestione dedicata." />
          {/* form: Invio nel campo di ricerca filtra (mai solo il click). */}
          <form className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_190px_auto_auto]" onSubmit={(event) => { event.preventDefault(); props.onFilter(); }}>
            <label className="relative">
              <Search className="absolute left-3 top-3 text-slate-400" size={16} aria-hidden />
              <input className="h-10 w-full rounded-md border border-slate-200 pl-9 pr-3 outline-none focus:border-[#365a96]" placeholder="Slug, nome o email admin" value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} />
            </label>
            <select className="h-10 rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" value={props.statusFilter} onChange={(event) => props.onStatusChange(event.target.value)}>
              <option value="">Tutti gli stati</option>
              {(["active", "suspended", "provisioning", "failed", "deleted"] as TenantStatus[]).map((status) => <option key={status} value={status}>{statusLabel[status]}</option>)}
            </select>
            <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold" type="submit">
              <SlidersHorizontal size={16} aria-hidden />
              Filtra
            </button>
            <a className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50" href="/api/admin/operations?section=export_tenants" download>
              <Download size={15} aria-hidden />
              Esporta CSV
            </a>
          </form>
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
    </div>
  );
}

function CreateTenantPanel({ plans, open, canManage, onCreate, onToggle }: { plans: PlanOption[]; open: boolean; canManage: boolean; onCreate: (payload: Record<string, string>) => void; onToggle: (open: boolean) => void }) {
  // POPUP (richiesta utente 20/07): il modulo si apre in un dialog modale
  // sopra la lista — stesso pattern della palette. Esc e click fuori chiudono.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onToggle(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);
  if (!open) return null;
  return (
    <div aria-modal className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4 pt-[8vh]" role="dialog" onClick={() => onToggle(false)}>
    <section className="mx-auto w-full max-w-3xl min-w-0 rounded-md border border-slate-200 bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between pr-4">
        <SectionHead title="Nuovo tenant" subtitle="Crea tenant, admin iniziale, sede principale e onboarding." />
        <button className="mt-4 text-sm font-semibold text-slate-500 hover:text-slate-700" type="button" onClick={() => onToggle(false)}>Chiudi</button>
      </div>
      <form className="grid gap-3 p-4 md:grid-cols-2" onSubmit={(event) => {
        event.preventDefault();
        onCreate(formPayload(event.currentTarget));
        event.currentTarget.reset();
      }}>
        <Input name="tenant_name" label="Nome attività" placeholder="Centro Estetico Elite" />
        <Input name="slug" label="Slug URL" placeholder="centroesteticoelite" required />
        <Input name="admin_name" label="Nome admin" defaultValue="Admin" />
        <Input name="admin_email" label="Email admin" type="email" required />
        {/* Piano come ENTITA' (select dei piani veri, coerenza Fase E). */}
        <label>
          <span className="mb-1 block text-sm font-medium text-slate-600">Piano</span>
          <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" defaultValue="0" name="plan_id">
            <option value="0">Nessun piano (illimitato)</option>
            {plans.map((plan) => <option key={plan.id} value={String(plan.id)}>{plan.name} — {formatEuro(plan.price_month)}/mese</option>)}
          </select>
        </label>
        <Input name="admin_pass" label="Password admin" type="text" required />
        <label className="md:col-span-2">
          <span className="mb-1 block text-sm font-medium text-slate-600">Note interne</span>
          <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-3 outline-none focus:border-[#365a96]" name="notes" />
        </label>
        <div className="md:col-span-2">
          <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#365a96] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canManage}>
            <Plus size={16} aria-hidden />
            Crea tenant
          </button>
        </div>
      </form>
    </section>
    </div>
  );
}

// Dialog modale riusabile della vista Fatturazione (pattern CreateTenantPanel):
// Esc e click sul fondo chiudono, la card ferma la propagazione.
function BillingModal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div aria-modal className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4 pt-[6vh]" role="dialog" onClick={onClose}>
      <section className={`mx-auto w-full ${wide ? "max-w-6xl" : "max-w-3xl"} min-w-0 rounded-md border border-slate-200 bg-white shadow-xl`} onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between pr-4">
          <SectionHead title={title} subtitle={subtitle} />
          <button className="mt-4 text-sm font-semibold text-slate-500 hover:text-slate-700" type="button" onClick={onClose}>Chiudi</button>
        </div>
        <div className="p-4">{children}</div>
      </section>
    </div>
  );
}

// PIANI & RICAVI (Fase E): piani veri con limiti che governano i gate del
// gestionale + MRR, ricavo SMS per mese e wallet aggregato.
function BillingView({ data, canManage, onAction, onRefresh }: { data: BillingPayload | null; canManage: boolean; onAction: (payload: Record<string, string>) => void; onRefresh: () => void }) {
  // Nuovo piano / Assegna piano vivono in POPUP (richiesta 20/07): bottoni a
  // destra nell'header di "Piani e MRR"; "Modifica" apre lo stesso popup
  // precompilato (key = remount con i defaultValue del piano scelto).
  const [editing, setEditing] = useState<BillingPayload["plans"][number] | null>(null);
  const [modal, setModal] = useState<"plan" | "assign" | null>(null);
  if (!data) {
    return <EmptyOperation icon={Wallet} title="Piani & Ricavi" detail="Carica piani, MRR e ricavi SMS." onRefresh={onRefresh} />;
  }
  // "Mese corrente" DAVVERO: la serie e' DESC e [0] e' solo l'ultimo mese con
  // ordini — se e' un mese vecchio il KPI mostrerebbe ricavi d'epoca.
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const smsCurrent = data.revenue.sms_monthly.find((row) => row.month === currentMonth);
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="MRR" value={formatEuro(data.revenue.mrr_total)} detail="tenant attivi x piano" />
        <Metric label="Senza piano" value={String(data.revenue.unassigned_active)} detail="tenant attivi da assegnare" />
        <Metric label="Ricavo SMS (mese corrente)" value={formatEuro(smsCurrent?.revenue ?? 0)} detail={smsCurrent ? `${smsCurrent.orders} ordini pagati` : "nessun ordine questo mese"} />
        <Metric label="Crediti SMS residui" value={String(data.revenue.wallet_credits_total)} detail="somma su tutti i tenant" />
      </div>

      <Table
        title="Piani e MRR"
        headers={["Piano", "Prezzo/mese", "Max sedi", "Max staff", "Tenant", "MRR", "Azioni"]}
        empty="Nessun piano ancora definito: crealo con 'Nuovo piano'."
        action={
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canManage} icon={Plus} type="button" onClick={() => { setEditing(null); setModal("plan"); }}>Nuovo piano</Button>
            <Button disabled={!canManage} icon={UserCog} type="button" variant="outline" onClick={() => setModal("assign")}>Assegna piano</Button>
          </div>
        }
        rows={data.plans.map((plan) => {
          const rev = data.revenue.by_plan.find((row) => row.id === plan.id);
          return [
            <span key={plan.id}><strong>{plan.name}</strong>{plan.is_active === 1 ? null : <span className="ml-2 text-xs text-slate-500">(disattivo)</span>}</span>,
            formatEuro(Number(plan.price_month)),
            plan.max_locations === null ? "illimitato" : String(plan.max_locations),
            plan.max_staff === null ? "illimitato" : String(plan.max_staff),
            String(rev?.tenants ?? 0),
            formatEuro(rev?.mrr ?? 0),
            <span className="flex justify-end gap-2" key={`actions-${plan.id}`}>
              <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40" disabled={!canManage} type="button" onClick={() => { setEditing(plan); setModal("plan"); }}>
                Modifica
              </button>
              {/* Ritiro dal listino SENZA toccare i tenant che lo usano:
                  plan_save completo con is_active ribaltato. */}
              <button
                className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
                disabled={!canManage}
                type="button"
                onClick={() => onAction({
                  action: "plan_save",
                  plan_id: String(plan.id),
                  name: plan.name,
                  price_month: String(plan.price_month),
                  max_locations: plan.max_locations === null ? "" : String(plan.max_locations),
                  max_staff: plan.max_staff === null ? "" : String(plan.max_staff),
                  sms_included_month: String(plan.sms_included_month ?? 0),
                  notes: plan.notes ?? "",
                  is_active: plan.is_active === 1 ? "0" : "1",
                })}
              >
                {plan.is_active === 1 ? "Disattiva" : "Attiva"}
              </button>
            </span>,
          ];
        })}
      />

      {/* La tabella "Ricavo SMS per mese" viveva QUI in triplice copia
          (Statistiche/Entrate + mondo Pacchetti SMS): rimossa (20/07). */}

      {modal === "plan" ? (
        <BillingModal title={editing ? `Modifica piano: ${editing.name}` : "Nuovo piano"} subtitle="Prezzo mensile e LIMITI: vuoto = illimitato. I limiti governano i gate del gestionale (es. creazione sedi)." onClose={() => { setModal(null); setEditing(null); }}>
          <form className="grid gap-3 md:grid-cols-2" key={editing ? `plan-${editing.id}` : "plan-new"} onSubmit={(event) => { submitOperation(event, "plan_save", onAction); setEditing(null); setModal(null); }}>
            <input name="plan_id" type="hidden" value={editing ? String(editing.id) : ""} readOnly />
            <Input name="name" label="Nome piano" placeholder="Pro" defaultValue={editing?.name ?? ""} required />
            <Input name="price_month" label="Prezzo/mese EUR" placeholder="49.90" defaultValue={editing ? String(editing.price_month) : ""} />
            <Input name="max_locations" label="Max sedi" placeholder="illimitato" defaultValue={editing?.max_locations === null || editing === null ? "" : String(editing.max_locations)} />
            <Input name="max_staff" label="Max staff" placeholder="illimitato" defaultValue={editing?.max_staff === null || editing === null ? "" : String(editing.max_staff)} />
            <Input name="sms_included_month" label="SMS inclusi/mese" placeholder="0" defaultValue={editing ? String(editing.sms_included_month) : ""} />
            <div className="flex items-end gap-2">
              <Button disabled={!canManage} icon={Plus}>{editing ? "Salva modifiche" : "Crea piano"}</Button>
            </div>
          </form>
        </BillingModal>
      ) : null}

      {modal === "assign" ? (
        <BillingModal title="Assegna piano a tenant" subtitle="Collega un piano al tenant; 'Nessun piano' = nessun limite." onClose={() => setModal(null)}>
          <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => { submitOperation(event, "plan_assign", onAction); setModal(null); }}>
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
        </BillingModal>
      ) : null}
    </div>
  );
}

// TIMELINE unificata (Fase D): la storia del tenant in un solo feed —
// audit + diagnostiche + backup + supporto + ordini SMS in ordine cronologico.

function ControlsView({ data, canManage, onRefresh, onRunHealth }: { data: ControlsPayload | null; canManage: boolean; onRefresh: () => void; onRunHealth: () => void }) {
  if (!data) {
    return <EmptyOperation icon={Activity} title="Controlli operativi" detail="Carica diagnostica provider SMS e tenant." onRefresh={onRefresh} />;
  }
  const provider = data.provider;
  return (
    <div className="grid gap-5">
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
      {/* Registro cron (Fase C): stato corrente per job; "Esegui ora" lancia
          la diagnostica passando dal registro (rifiniture 19/07). */}
      <Table
        title="Cron: ultima esecuzione per job"
        headers={["Job", "Esito", "Avviato", "Durata", "Sintesi"]}
        action={<Button disabled={!canManage} icon={Activity} variant="outline" onClick={onRunHealth}>Esegui ora la diagnostica</Button>}
        empty="Nessuna esecuzione registrata: schedula /api/cron/* (EventBridge o scheduler esterno con CRON_SECRET)."
        rows={(data.cron?.jobs ?? []).map((run) => [
            <strong key={run.job}>{run.job}</strong>,
            <Badge tone={run.status === "ok" ? "ok" : "danger"} key={`s-${run.job}`}>{run.status === "ok" ? "OK" : "Errore"}</Badge>,
            formatDateTime(run.started_at),
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
          formatDateTime(row.stats.last_sent_at == null ? null : String(row.stats.last_sent_at)),
        ])}
      />
    </div>
  );
}

function SmsPlansView({ data, canManage, onAction, onRefresh }: { data: SmsBillingPayload | null; canManage: boolean; onAction: (payload: Record<string, string>) => void; onRefresh: () => void }) {
  // Piani / Ricarica / Impostazioni in POPUP (richiesta 20/07): la pagina
  // resta KPI + Ordini recenti; il popup Piani NON si chiude al Salva (si
  // lavora su piu' righe), gli altri due si'.
  const [modal, setModal] = useState<"plans" | "recharge" | "pricing" | null>(null);
  if (!data) {
    return <EmptyOperation icon={CreditCard} title="Piani SMS" detail="Carica prezzi, piani, ordini e crediti dei tenant." onRefresh={onRefresh} />;
  }
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Crediti venduti" value={String(data.summary.credits_sold)} detail="da ordini pagati" />
        <Metric label="Ricavo lordo" value={formatEuro(data.summary.revenue_gross)} detail="dalle ricariche SMS pagate" />
        {/* pending = pagamenti incagliati: e' la spia da guardare, in ambra */}
        <Metric label="Ordini" value={String(data.summary.orders_total)} detail={data.summary.orders_pending > 0 ? <span className="font-semibold text-amber-700">{data.summary.orders_pending} in attesa di pagamento</span> : "nessuno in attesa di pagamento"} />
        <Metric label="Piani attivi" value={String(data.activePlans.length)} detail="nella vetrina acquisti dei tenant" />
      </div>

      

      

      <Table
        title="Ordini recenti"
        headers={["ID", "Tenant", "Piano", "Stato", "Crediti", "Importo", "Data"]}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!canManage} icon={CreditCard} type="button" onClick={() => setModal("plans")}>Gestisci piani</Button>
            <Button disabled={!canManage} icon={Wallet} type="button" variant="outline" onClick={() => setModal("recharge")}>Ricarica manuale</Button>
            <Button disabled={!canManage} icon={Settings} type="button" variant="outline" onClick={() => setModal("pricing")}>Impostazioni prezzo</Button>
            <a className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50" href="/api/admin/operations?section=export_sms_orders" download><Download size={14} aria-hidden />Esporta ordini CSV</a>
          </div>
        }
        empty="Nessun ordine SMS."
        rows={data.orders.map((order) => [String(order.id), order.tenant_slug, order.plan_name || "-", order.status, String(order.credits), formatEuro(order.amount_gross), formatDateTime(order.created_at)])}
      />

      {modal === "plans" ? (
      <BillingModal wide title="Piani" subtitle="'In evidenza' mette il pacchetto in risalto nella vetrina acquisti del tenant; le frecce ne cambiano l'ordine. Sotto ogni pacchetto: costo provider, fee e margine." onClose={() => setModal(null)}>
        <div className="grid gap-3">
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
                <button aria-label="Sposta su nella vetrina" className="h-10 rounded-md border border-slate-200 px-2" disabled={!canManage} title="Sposta su nella vetrina" type="button" onClick={() => onAction({ action: "sms_move_plan", plan_id: String(plan.id), direction: "-1" })}><ArrowUp size={16} aria-hidden /></button>
                <button aria-label="Sposta giù nella vetrina" className="h-10 rounded-md border border-slate-200 px-2" disabled={!canManage} title="Sposta giù nella vetrina" type="button" onClick={() => onAction({ action: "sms_move_plan", plan_id: String(plan.id), direction: "1" })}><ArrowDown size={16} aria-hidden /></button>
                <button className="h-10 rounded-md border border-slate-200 px-3 text-sm font-semibold" disabled={!canManage} type="button" onClick={() => onAction({ action: "sms_set_plan_active", plan_id: String(plan.id), active: Number(plan.is_active) === 1 ? "0" : "1" })}>{Number(plan.is_active) === 1 ? "Disattiva" : "Attiva"}</button>
              </div>
              <div className="md:col-span-7 text-sm text-slate-500">
                Costo provider {formatEuro(plan.economics.provider_cost)} - Fee {formatEuro(plan.economics.payment_fee)} - Margine {formatEuro(plan.economics.margin_value)} ({plan.economics.margin_percent.toFixed(1)}%)
                {" · "}
                {/* prezzo/credito vs suggerito: sotto target = ambra, a colpo d'occhio */}
                <span className={plan.economics.price_per_credit < Number(data.settings.suggested_credit_price ?? 0) ? "font-semibold text-amber-700" : ""}>
                  {plan.economics.price_per_credit.toFixed(4).replace(".", ",")} euro/SMS
                </span>
                {" "}(suggerito {Number(data.settings.suggested_credit_price ?? 0).toFixed(4).replace(".", ",")})
                {/* PRECOMPILA il campo Prezzo a crediti x suggerito — non salva
                    nulla: il prezzo passa comunque dagli occhi e dal Salva. */}
                {Math.abs(plan.economics.price_per_credit - Number(data.settings.suggested_credit_price ?? 0)) > 0.0005 ? (
                  <button
                    className="ml-2 rounded-md border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                    disabled={!canManage}
                    title="Precompila il prezzo a target (crediti × suggerito): controlla, ritocca se vuoi e premi Salva."
                    type="button"
                    onClick={(event) => {
                      const form = event.currentTarget.closest("form");
                      const creditsEl = form?.elements.namedItem("credits") as HTMLInputElement | null;
                      const priceEl = form?.elements.namedItem("price_gross") as HTMLInputElement | null;
                      const credits = Math.max(1, Number(creditsEl?.value ?? plan.credits));
                      const target = Math.round(credits * Number(data.settings.suggested_credit_price ?? 0) * 100) / 100;
                      if (priceEl) { priceEl.value = target.toFixed(2); priceEl.focus(); }
                    }}
                  >
                    Porta a target
                  </button>
                ) : null}
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
      </BillingModal>
      ) : null}

      {modal === "recharge" ? (
      <BillingModal title="Ricarica manuale tenant" subtitle="Accredita subito crediti SENZA pagamento (omaggi, correzioni): l'ordine viene registrato a importo zero, il Ricavo lordo resta quello degli acquisti digitali." onClose={() => setModal(null)}>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { submitOperation(event, "sms_manual_topup", onAction); setModal(null); }}>
          <label>
            <span className="mb-1 block text-sm font-medium text-slate-600">Tenant</span>
            <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="tenant_slug" required>
              {data.tenants.map((tenant) => <option key={tenant.slug} value={tenant.slug}>{tenant.name} — {tenant.wallet_balance} crediti</option>)}
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
          <Input name="note" label="Nota" placeholder="Es. omaggio di benvenuto" />
          <div className="flex items-end md:col-span-2">
            <Button disabled={!canManage} icon={CreditCard}>Accredita</Button>
          </div>
        </form>
      </BillingModal>
      ) : null}

      {modal === "pricing" ? (
      <BillingModal title="Impostazioni prezzo" subtitle="Parametri economici dei pacchetti: costo provider, margine e prezzo suggerito. Non cambiano i listini: aggiornano marginalità e prezzo suggerito." onClose={() => setModal(null)}>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { submitOperation(event, "sms_save_settings", onAction); setModal(null); }}>
          <Input name="provider_cost_per_segment" label="Costo provider (euro/SMS)" defaultValue={String(data.settings.provider_cost_per_segment ?? "0.0490")} />
          <Input name="target_margin_percent" label="Margine target (%)" defaultValue={String(data.settings.target_margin_percent ?? "25")} />
          <Input name="payment_fee_percent" label="Fee pagamento (%)" defaultValue={String(data.settings.payment_fee_percent ?? "2")} />
          <Input name="payment_fee_fixed" label="Fee fissa (euro/ordine)" defaultValue={String(data.settings.payment_fee_fixed ?? "0.30")} />
          <Input name="suggested_credit_price" label="Prezzo suggerito (euro/SMS)" defaultValue={String(data.settings.suggested_credit_price ?? "0.0700")} />
          <div className="flex items-end">
            <Button disabled={!canManage} icon={Settings}>Salva prezzi</Button>
          </div>
        </form>
      </BillingModal>
      ) : null}
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
      <Table title="SMS" headers={["Tenant", "Tipo", "Stato", "Destinatario", "Riferimento", "Crediti", "Evento", "Dettaglio"]} rows={movementRows(data.sms)} empty="Nessun invio SMS registrato." />
      <Table title="Email" headers={["Tenant", "Tipo", "Stato", "Destinatario", "Riferimento", "Crediti", "Evento", "Dettaglio"]} rows={movementRows(data.emails)} empty="Nessuna email registrata." />
    </div>
  );
}

function MaintenanceView({ tenants, results, restoreCandidates, canManage, onAction, onOperationAction }: { tenants: Tenant[]; results: Array<{ slug: string; ok: boolean; message: string }>; restoreCandidates: BackupRow[]; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void; onOperationAction: (payload: Record<string, string>) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [restoreConfirm, setRestoreConfirm] = useState<Record<number, string>>({});
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 md:grid-cols-3">
        <ActionPanel icon={Activity} title="Verifica diagnostica" detail="Controlla tutti i tenant e salva lo storico." disabled={!canManage} onClick={() => onAction("health_all")} />
        <ActionPanel icon={RotateCcw} title="Reset onboarding" detail="Riporta i tenant selezionati al primo step." disabled={!canManage || selected.length === 0} onClick={() => onAction("reset_selected_onboarding", { slugs: selected.join(",") })} />
      </div>
      {results.length ? <Table title="Risultati" headers={["Tenant", "Esito", "Messaggio"]} rows={results.map((row) => [row.slug, row.ok ? "OK" : "Errore", row.message])} /> : null}

      {/* RIPRISTINO GUIDATO (feature restore 2026-07-19): ultimi backup dei
          tenant ELIMINATI — digitando lo slug esatto si ricrea il tenant con
          gli id originali. */}
      <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Ripristino da backup" subtitle="Tenant eliminati con un backup disponibile: digita lo slug esatto per ricrearli." />
        {restoreCandidates.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Nessun tenant eliminato con backup disponibile.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {restoreCandidates.map((backup) => (
              <div className="flex flex-wrap items-center gap-3 p-3 text-sm" key={backup.id}>
                <div className="min-w-0 flex-1">
                  <p><strong>{backup.tenant_slug}</strong><span className="ml-2 text-slate-500">{backup.created_at ? formatDateTime(backup.created_at) : ""}</span></p>
                  <p className="text-xs text-slate-500">{backup.reason || "backup"} · {Math.round(Number(backup.backup_size ?? 0) / 1024)} KB</p>
                </div>
                <input
                  className="h-9 w-56 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-[#365a96]"
                  placeholder={String(backup.tenant_slug)}
                  value={restoreConfirm[backup.id] ?? ""}
                  onChange={(event) => setRestoreConfirm((current) => ({ ...current, [backup.id]: event.target.value }))}
                />
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-[#365a96] px-3 text-xs font-semibold text-white disabled:opacity-40"
                  disabled={!canManage || (restoreConfirm[backup.id] ?? "") !== String(backup.tenant_slug)}
                  type="button"
                  onClick={() => onOperationAction({ action: "backup_restore", backup_id: String(backup.id), confirm_slug: restoreConfirm[backup.id] ?? "" })}
                >
                  <RotateCcw size={14} aria-hidden />
                  Ripristina
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
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

// AUDIT potenziato (2026-07-19): filtri testo/azione/tenant, paginazione
// server-side, export CSV coi filtri correnti (prima: ultimi 20 e basta).
function AuditView({ data, filters, onSearch, onPageChange }: { data: AuditSearchPayload | null; filters: AuditFilters; onSearch: (filters: AuditFilters) => void; onPageChange: (page: number) => void }) {
  const [q, setQ] = useState(filters.q);
  const [action, setAction] = useState(filters.action);
  const [tenant, setTenant] = useState(filters.tenant);
  const exportParams = new URLSearchParams({ section: "export_audit" });
  if (filters.q.trim()) exportParams.set("q", filters.q.trim());
  if (filters.action.trim()) exportParams.set("audit_action", filters.action.trim());
  if (filters.tenant.trim()) exportParams.set("tenant", filters.tenant.trim());
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  return (
    <div className="grid gap-4">
      <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
        <form className="grid gap-3 p-4 md:grid-cols-[1fr_200px_200px_auto_auto]" onSubmit={(event) => { event.preventDefault(); onSearch({ q, action, tenant }); }}>
          <Input label="Cerca (messaggio, attore, azione)" placeholder="Es. backup, info@..." value={q} onChange={(event) => setQ(event.target.value)} />
          <Input label="Azione (prefisso)" placeholder="Es. tenant.suspend" value={action} onChange={(event) => setAction(event.target.value)} />
          <Input label="Tenant (slug)" placeholder="Es. centroestetico" value={tenant} onChange={(event) => setTenant(event.target.value)} />
          <div className="flex items-end">
            <Button icon={Search}>Filtra</Button>
          </div>
          <div className="flex items-end">
            <a className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50" href={`/api/admin/operations?${exportParams}`} download>
              <Download size={16} aria-hidden />
              Esporta CSV
            </a>
          </div>
        </form>
      </section>
      <Table
        title={`Registro attività${data ? ` (${data.total})` : ""}`}
        headers={["Data", "Azione", "Tenant", "Attore", "Messaggio"]}
        rows={(data?.rows ?? []).map((row) => [
          formatDateTime(row.created_at),
          <code className="text-xs" key={`a-${row.id}`}>{row.action}</code>,
          row.tenant_slug || "-",
          row.actor_email || "sistema",
          row.message || "-",
        ])}
      />
      {data && pageCount > 1 ? (
        <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-2 text-sm shadow-sm">
          <span className="text-slate-500">{data.total} eventi · pagina {data.page} di {pageCount}</span>
          <div className="flex gap-2">
            <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold disabled:opacity-40" disabled={data.page <= 1} type="button" onClick={() => onPageChange(data.page - 1)}>Precedente</button>
            <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold disabled:opacity-40" disabled={data.page >= pageCount} type="button" onClick={() => onPageChange(data.page + 1)}>Successiva</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const signupStatusLabel: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "info" | "muted" }> = {
  pending_verification: { label: "Da verificare", tone: "warn" },
  verified: { label: "Verificata", tone: "info" },
  provisioning: { label: "Provisioning", tone: "info" },
  active: { label: "Attiva", tone: "ok" },
  failed: { label: "Fallita", tone: "danger" },
  rejected: { label: "Rifiutata", tone: "muted" },
};

// REGISTRAZIONI SELF-SERVICE (feature signups 2026-07-19): le richieste dal
// marketplace con stato, esito provisioning e link al tenant creato.
function SignupsView({ signups, canManage, onOpenTenant, onAction, onRefresh }: { signups: SignupRow[] | null; canManage: boolean; onOpenTenant: (slug: string) => void; onAction: (payload: Record<string, string>) => void; onRefresh: () => void }) {
  if (!signups) {
    return <EmptyOperation icon={UserPlus} title="Registrazioni self-service" detail="Carica le richieste di registrazione dal marketplace." onRefresh={onRefresh} />;
  }
  return (
    <div className="grid gap-5">
      <Table
        title="Richieste di registrazione"
        headers={["Attività", "Titolare", "Stato", "Richiesta il", "Esito", "Azioni"]}
        action={<Button variant="outline" icon={RotateCcw} onClick={onRefresh}>Aggiorna</Button>}
        empty="Nessuna richiesta di registrazione."
        rows={signups.map((signup) => [
          <span key={`b-${signup.id}`}><strong>{signup.business_name}</strong><span className="ml-2 text-slate-500">{signup.slug}</span></span>,
          <span key={`o-${signup.id}`}>{signup.owner_name}<span className="ml-2 text-slate-500">{signup.owner_email}</span></span>,
          <Badge key={`s-${signup.id}`} tone={(signupStatusLabel[signup.status] ?? { tone: "muted" as const }).tone}>{signupStatusLabel[signup.status]?.label ?? signup.status}</Badge>,
          formatDateTime(signup.created_at),
          signup.provisioning_error
            ? <span className="block max-w-xs truncate text-red-700" key={`e-${signup.id}`} title={signup.provisioning_error}>{signup.provisioning_error}</span>
            : (signup.verified_at ? `Email verificata il ${formatDateTime(signup.verified_at)}` : "-"),
          <div className="flex gap-2" key={`a-${signup.id}`}>
            {signup.tenant_exists ? (
              <button className="inline-flex h-8 items-center rounded-md bg-[#182238] px-3 text-xs font-semibold text-white" type="button" onClick={() => onOpenTenant(signup.slug)}>
                Apri tenant
              </button>
            ) : (
              <button
                className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40"
                disabled={!canManage}
                type="button"
                onClick={() => { if (window.confirm(`Eliminare la richiesta di "${signup.business_name}" (${signup.slug})?`)) onAction({ action: "signup_delete", id: String(signup.id) }); }}
              >
                Elimina richiesta
              </button>
            )}
          </div>,
        ])}
      />
    </div>
  );
}

function AdminsView({ admins, currentUser, onAction }: { admins: AdminRecord[]; currentUser: SaasAdminUser; onAction: (payload: Record<string, string>) => void }) {
  return (
    <div className="grid gap-5">
      <section className="rounded-md border border-slate-200 bg-white shadow-sm">
        <SectionHead title="Nuovo admin" subtitle="Owner: controllo completo, Admin: operatività, Viewer: consultazione." />
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
                <div className="flex items-end justify-end text-sm text-slate-500">Ultimo login: {admin.last_login_at ? formatDateTime(admin.last_login_at) : "mai"}</div>
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
  if (view === "stats") return "Statistiche";
  if (view === "billing") return "Fatturazione";
  if (view === "operations") return "Operazioni";
  if (view === "signups") return "Registrazioni";
  if (view === "audit") return "Audit";
  if (view === "admins") return "Admin SaaS";
  if (view === "security") return "Sicurezza";
  return "Dashboard";
}

