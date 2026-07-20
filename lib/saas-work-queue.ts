import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery } from "@/lib/tenant-db";
import { tenantStatus, type SaasTenantRow } from "@/lib/saas-tenant-manager";

// CODA DI LAVORO del pannello admin (Fase B "centro di comando", 2026-07-19):
// dalla fotografia dei tenant + poche query aggregate produce la lista di
// cose che RICHIEDONO un'azione, ordinata per gravita'. Niente diagnostica
// live: legge solo snapshot e contatori.

export type SaasWorkItem = {
  key: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  view: string;
  section?: string;
  slug?: string;
  tab?: string;
  // Azione one-click opzionale (POST /api/admin/tenants { action, slug }).
  action?: "record_health";
};

const LOGIN_ANOMALY_THRESHOLD = 10;
const MAX_ITEMS = 30;

export async function buildSaasWorkQueue(tenants: SaasTenantRow[]): Promise<SaasWorkItem[]> {
  const items: SaasWorkItem[] = [];

  // Richieste self-service SENZA tenant (ferme al codice email o fallite):
  // vivono nella card "Richieste in arrivo" della vista Tenant (20/07).
  const pendingSignups = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
       FROM \`saas_professional_signups\` s
      WHERE NOT EXISTS (SELECT 1 FROM \`saas_tenants\` t WHERE t.slug = s.slug)`,
  ).catch(() => [] as RowDataPacket[]);
  const pendingSignupCount = Number(pendingSignups[0]?.count ?? 0);
  if (pendingSignupCount > 0) {
    items.push({
      key: "signups_pending",
      severity: "warning",
      title: `${pendingSignupCount} ${pendingSignupCount === 1 ? "registrazione da completare" : "registrazioni da completare"}`,
      detail: "Richieste self-service senza tenant: ferme al codice email o fallite.",
      view: "tenants",
    });
  }

  for (const tenant of tenants) {
    const slug = String(tenant.slug);
    const status = tenantStatus(tenant);
    const health = tenant.health;

    if (status === "failed") {
      items.push({
        key: `failed:${slug}`,
        severity: "error",
        title: `Provisioning fallito: ${slug}`,
        detail: String(tenant.provisioning_error ?? "").slice(0, 160) || "Creazione interrotta.",
        view: "tenants",
        slug,
        tab: "danger",
      });
      continue;
    }
    if (status === "deleted") continue;

    if (health?.level === "error") {
      items.push({
        key: `health_error:${slug}`,
        severity: "error",
        title: `Tenant in errore: ${slug}`,
        detail: `${health.errors} errori, ${health.warnings} avvisi (ultima verifica: ${health.checked_at || "-"})`,
        view: "tenants",
        slug,
        tab: "health",
        action: "record_health",
      });
    } else if (!tenant.health_checked_at) {
      items.push({
        key: `health_missing:${slug}`,
        severity: "warning",
        title: `Mai verificato: ${slug}`,
        detail: "Nessuna diagnostica registrata per questo tenant.",
        view: "tenants",
        slug,
        tab: "health",
        action: "record_health",
      });
    }

    if (status === "suspended") {
      items.push({
        key: `suspended:${slug}`,
        severity: "info",
        title: `Tenant sospeso: ${slug}`,
        detail: String(tenant.suspended_reason ?? "").slice(0, 120) || "Sospensione manuale.",
        view: "tenants",
        slug,
        tab: "danger",
      });
    }

    // NB: l'onboarding fermo NON e' piu' in coda (richiesta utente 19/07):
    // non richiede un'azione dell'admin di piattaforma — resta visibile
    // nella colonna Onboarding della lista tenant e nel dettaglio.
  }

  // Ordini SMS in attesa (aggregato).
  const pendingOrders = await dbQuery<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM `saas_sms_orders` WHERE status='pending'",
  ).catch(() => []);
  const pendingCount = Number(pendingOrders[0]?.count ?? 0);
  if (pendingCount > 0) {
    items.push({
      key: "sms_orders_pending",
      severity: "warning",
      title: `${pendingCount} ordini SMS in attesa`,
      detail: "Ordini con stato pending da riconciliare o completare.",
      view: "billing",
      section: "sms",
    });
  }

  // Token/sessioni supporto attivi: trasparenza sugli accessi in corso.
  // Frame ROMA coerente col writer (mysqlNow param, mai NOW() del DB).
  const supportRows = await dbQuery<RowDataPacket[]>(
    `SELECT tenant_slug, reason, used_at FROM \`saas_support_access_tokens\`
      WHERE revoked_at IS NULL AND expires_at > ?
      ORDER BY id DESC LIMIT 10`,
    [localNow()],
  ).catch(() => []);
  for (const row of supportRows) {
    const slug = String(row.tenant_slug ?? "");
    items.push({
      key: `support:${slug}:${String(row.reason ?? "")}`,
      severity: "info",
      title: row.used_at ? `Sessione supporto attiva: ${slug}` : `Token supporto in attesa: ${slug}`,
      detail: String(row.reason ?? "").slice(0, 120),
      view: "tenants",
      slug,
      tab: "support",
    });
  }

  // Anomalia login: molti tentativi falliti nelle ultime 24h (stesso frame
  // del writer: attempted_at e' scritto con NOW() del DB).
  const failedLogins = await dbQuery<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM `saas_admin_login_attempts` WHERE success=0 AND attempted_at >= (NOW() - interval '24 hours')",
  ).catch(() => []);
  const failedCount = Number(failedLogins[0]?.count ?? 0);
  if (failedCount >= LOGIN_ANOMALY_THRESHOLD) {
    items.push({
      key: "login_anomaly",
      severity: "warning",
      title: `${failedCount} login falliti nelle ultime 24 ore`,
      detail: "Possibile tentativo di forza bruta sul pannello: controlla sessioni e audit.",
      view: "security",
    });
  }

  // Cron in errore: l'ULTIMA esecuzione di un job e' fallita (registro Fase C).
  const failedCrons = await dbQuery<RowDataPacket[]>(
    `SELECT r.job, r.message, r.started_at FROM \`saas_cron_runs\` r
      WHERE r.id = (SELECT MAX(r2.id) FROM \`saas_cron_runs\` r2 WHERE r2.job = r.job)
        AND r.status = 'error'
      ORDER BY r.job ASC`,
  ).catch(() => []);
  for (const row of failedCrons) {
    items.push({
      key: `cron_error:${String(row.job ?? "")}`,
      severity: "error",
      title: `Cron in errore: ${String(row.job ?? "")}`,
      detail: `${String(row.message ?? "").slice(0, 140) || "Ultima esecuzione fallita."} (${String(row.started_at ?? "")})`,
      view: "operations",
      section: "controls",
    });
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, MAX_ITEMS);
}

function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
