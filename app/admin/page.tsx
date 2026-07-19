import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SaasAdminApp } from "@/components/saas-admin-app";
import { currentSaasAdminSession } from "@/lib/saas-admin-auth";

export const metadata: Metadata = {
  title: "Dashboard - SaaS Admin",
};

// Fase 3 (2026-07-19): il pannello è la SPA completa (8 sezioni + dettaglio
// tenant a tab + Sicurezza) con URL VERI: /admin?page=<vista>[&slug=..&tab=..]
// — deep-link, refresh e tasto Indietro funzionanti. I nomi pagina legacy
// dell'admin PHP (tenant_detail/tenant_new/…) sono mappati alle viste.
const VIEWS = new Set(["dashboard", "tenants", "billing", "operations", "signups", "audit", "admins", "security"]);
const LEGACY_PAGE_MAP: Record<string, string> = {
  // Menu consolidato (2026-07-19): le vecchie viste restano deep-linkabili.
  controls: "operations",
  send_movements: "operations",
  maintenance: "operations",
  sms_plans: "billing",
  tenant_detail: "tenants",
  tenant_new: "tenants",
  tenant_settings: "tenants",
  tenant_health: "tenants",
  tenant_support: "tenants",
  tenant_backups: "tenants",
  tenant_danger: "tenants",
  tenant_onboarding: "tenants",
  tenant_visibility: "tenants",
  tenant_admin: "tenants",
  tenants: "tenants",
};
const LEGACY_TAB_MAP: Record<string, string> = {
  tenant_settings: "settings",
  tenant_health: "health",
  tenant_support: "support",
  tenant_backups: "backups",
  tenant_danger: "danger",
  tenant_onboarding: "onboarding",
  tenant_visibility: "visibility",
  tenant_admin: "admin",
};
const TABS = new Set(["overview", "timeline", "settings", "visibility", "admin", "onboarding", "health", "support", "backups", "danger"]);
// Sottosezione delle viste consolidate: dalle pagine legacy o da ?sec=.
const LEGACY_SEC_MAP: Record<string, string> = {
  controls: "controls",
  send_movements: "movements",
  maintenance: "maintenance",
  sms_plans: "sms",
};
const SECS = new Set(["plans", "sms", "controls", "movements", "maintenance"]);

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSaasAdminSession();
  if (!session) redirect("/admin/login");

  const query = (await searchParams) ?? {};
  const qs = (key: string): string => {
    const raw = query[key];
    return String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "").trim();
  };
  const rawPage = qs("page");
  const mapped = LEGACY_PAGE_MAP[rawPage] ?? rawPage;
  const view = VIEWS.has(mapped) ? mapped : "dashboard";
  const slug = view === "tenants" ? qs("slug") : "";
  const rawTab = qs("tab") || LEGACY_TAB_MAP[rawPage] || "overview";
  const tab = TABS.has(rawTab) ? rawTab : "overview";
  const rawSec = qs("sec") || LEGACY_SEC_MAP[rawPage] || "";
  const section = SECS.has(rawSec) ? rawSec : "";

  return (
    <SaasAdminApp
      initialUser={session.user}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialView={view as any}
      initialSlug={slug}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialTab={tab as any}
      initialSection={section}
    />
  );
}
