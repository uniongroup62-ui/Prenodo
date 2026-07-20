import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, tableExists } from "@/lib/tenant-db";
import { businessTodayIso } from "@/lib/business-datetime";

// Serie mensili CONTINUE: i mesi senza dati diventano zeri ESPLICITI (barre
// adiacenti con un buco in mezzo si leggono come mesi consecutivi), estese
// fino al mese corrente nel frame Roma.
function fillMonths<T extends { month: string }>(rows: T[], zero: Omit<T, "month">): T[] {
  if (!rows.length) return rows;
  const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));
  const current = businessTodayIso().slice(0, 7);
  const last = sorted[sorted.length - 1].month;
  const end = current > last ? current : last;
  const byMonth = new Map(sorted.map((row) => [row.month, row]));
  const out: T[] = [];
  let [year, month] = sorted[0].month.split("-").map(Number);
  for (let i = 0; i < 24 && year > 0 && month > 0; i++) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    out.push(byMonth.get(key) ?? ({ ...zero, month: key } as T));
    if (key >= end) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

// STATISTICHE del pannello SaaS Admin (vista "Statistiche", 2026-07-19):
// aggregati di crescita, entrate, piani e utilizzo + SNAPSHOT giornaliero
// (saas_metrics_daily) per i trend che non sono ricostruibili a posteriori
// (MRR, tenant attivi, account marketplace). Lo snapshot lo scrive il cron
// admin-health con upsert per giorno. NB: DDL runtime in dialetto POSTGRES.

export type MonthBucket = { month: string; value: number };

export type SaasStatsPayload = {
  growth: {
    tenants_by_month: Array<{ month: string; admin: number; self_signup: number }>;
    signup_funnel: { requests: number; verified: number; active: number };
    marketplace: { total: number; verified: number; active_30d: number; new_by_month: MonthBucket[] };
  };
  revenue: {
    mrr_total: number;
    arpu: number;
    tenants_active: number;
    sms_by_month: Array<{ month: string; revenue: number; orders: number }>;
    mrr_trend: Array<{ day: string; mrr: number }>;
  };
  plans: {
    by_plan: Array<{ id: number; name: string; tenants: number; mrr: number }>;
    unassigned_active: number;
    top_by_tenants: string;
    top_by_mrr: string;
    assignments_by_month: MonthBucket[];
  };
  usage: {
    totals: { gestionale_users: number; clients: number; appointments: number; sales: number };
    appointments_by_month: MonthBucket[];
    sales_by_month: MonthBucket[];
    top_tenants: Array<{ slug: string; name: string; appointments: number; sales: number }>;
  };
};

let statsSchemaEnsured = false;

export async function ensureSaasStatsSchema(): Promise<void> {
  if (statsSchemaEnsured) return;
  if (!(await tableExists("saas_metrics_daily"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_metrics_daily" (
      "day" VARCHAR(10) PRIMARY KEY,
      "mrr" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "tenants_active" INTEGER NOT NULL DEFAULT 0,
      "tenants_total" INTEGER NOT NULL DEFAULT 0,
      "marketplace_accounts" INTEGER NOT NULL DEFAULT 0,
      "sms_credits_total" INTEGER NOT NULL DEFAULT 0
    )`,
    );
  }
  statsSchemaEnsured = true;
}

// Fotografia del giorno (upsert: piu' esecuzioni nello stesso giorno = ultima
// vince). Giorno nel frame LOCALE, coerente col resto del pannello.
export async function snapshotDailyMetrics(): Promise<{ day: string; mrr: number }> {
  await ensureSaasStatsSchema();
  const day = localDay();
  const mrrRows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(SUM(p.price_month),0) AS mrr
       FROM \`saas_tenants\` t JOIN \`saas_plans\` p ON p.id = t.plan_id AND p.is_active = 1
      WHERE t.status='active'`,
  ).catch(() => []);
  const counts = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active, COUNT(*) AS total FROM \`saas_tenants\``,
  ).catch(() => []);
  const accounts = await dbQuery<RowDataPacket[]>("SELECT COUNT(*) AS count FROM `public_customer_accounts`").catch(() => []);
  const credits = await dbQuery<RowDataPacket[]>("SELECT COALESCE(SUM(balance_credits),0) AS total FROM `sms_credit_wallet` WHERE tenant_id IS NOT NULL").catch(() => []);
  const mrr = Math.round(Number(mrrRows[0]?.mrr ?? 0) * 100) / 100;
  await dbExecute(
    `INSERT INTO \`saas_metrics_daily\`(day,mrr,tenants_active,tenants_total,marketplace_accounts,sms_credits_total)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT ("day") DO UPDATE SET "mrr"=EXCLUDED."mrr", "tenants_active"=EXCLUDED."tenants_active",
       "tenants_total"=EXCLUDED."tenants_total", "marketplace_accounts"=EXCLUDED."marketplace_accounts",
       "sms_credits_total"=EXCLUDED."sms_credits_total"`,
    [day, mrr, Number(counts[0]?.active ?? 0), Number(counts[0]?.total ?? 0), Number(accounts[0]?.count ?? 0), Number(credits[0]?.total ?? 0)],
  );
  return { day, mrr };
}

export async function saasStatistics(): Promise<SaasStatsPayload> {
  await ensureSaasStatsSchema();

  // --- Crescita ------------------------------------------------------------
  const tenantMonths = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month,
            COALESCE(SUM(CASE WHEN source='self_signup' THEN 1 ELSE 0 END),0) AS self_signup,
            COALESCE(SUM(CASE WHEN COALESCE(source,'admin')<>'self_signup' THEN 1 ELSE 0 END),0) AS admin
       FROM \`saas_tenants\`
      WHERE created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);

  const funnel = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN verified_at IS NOT NULL OR status IN ('verified','provisioning','active') THEN 1 ELSE 0 END),0) AS verified,
            COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active
       FROM \`saas_professional_signups\``,
  ).catch(() => []);

  const marketplaceTotals = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END),0) AS verified,
            COALESCE(SUM(CASE WHEN last_login_at >= NOW() - interval '30 days' THEN 1 ELSE 0 END),0) AS active_30d
       FROM \`public_customer_accounts\``,
  ).catch(() => []);
  const marketplaceMonths = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month, COUNT(*) AS value
       FROM \`public_customer_accounts\`
      WHERE created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);

  // --- Entrate -------------------------------------------------------------
  const byPlan = await dbQuery<RowDataPacket[]>(
    `SELECT p.id, p.name, p.price_month, COUNT(t.id) AS tenants
       FROM \`saas_plans\` p
       LEFT JOIN \`saas_tenants\` t ON t.plan_id = p.id AND t.status='active'
      GROUP BY p.id, p.name, p.price_month
      ORDER BY p.sort_order ASC, p.id ASC`,
  ).catch(() => []);
  const plansOut = byPlan.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    tenants: Number(row.tenants ?? 0),
    mrr: Math.round(Number(row.price_month ?? 0) * Number(row.tenants ?? 0) * 100) / 100,
  }));
  const mrrTotal = Math.round(plansOut.reduce((sum, plan) => sum + plan.mrr, 0) * 100) / 100;
  const activeRows = await dbQuery<RowDataPacket[]>("SELECT COUNT(*) AS count FROM `saas_tenants` WHERE status='active'").catch(() => []);
  const tenantsActive = Number(activeRows[0]?.count ?? 0);

  const smsMonths = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month, COUNT(*) AS orders, COALESCE(SUM(amount_gross),0) AS revenue
       FROM \`saas_sms_orders\`
      WHERE status='paid' AND created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);

  const mrrTrend = await dbQuery<RowDataPacket[]>(
    "SELECT day, mrr FROM `saas_metrics_daily` ORDER BY day DESC LIMIT 90",
  ).catch(() => []);

  const unassigned = await dbQuery<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM `saas_tenants` WHERE status='active' AND plan_id IS NULL",
  ).catch(() => []);

  const assignments = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month, COUNT(*) AS value
       FROM \`saas_tenant_audit_logs\`
      WHERE action='saas_plan.assign' AND created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);

  // --- Utilizzo ------------------------------------------------------------
  // cross-tenant: aggregato di PIATTAFORMA (vista Statistiche del pannello admin, mai esposto ai tenant).
  const totals = await dbQuery<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM \`users\`) AS gestionale_users,
            (SELECT COUNT(*) FROM \`clients\`) AS clients,
            (SELECT COUNT(*) FROM \`appointments\`) AS appointments,
            (SELECT COUNT(*) FROM \`sales\`) AS sales`,
  ).catch(() => []);
  // cross-tenant: aggregato di PIATTAFORMA (vista Statistiche del pannello admin, mai esposto ai tenant).
  const apptMonths = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month, COUNT(*) AS value
       FROM \`appointments\` WHERE created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);
  // cross-tenant: aggregato di PIATTAFORMA (vista Statistiche del pannello admin, mai esposto ai tenant).
  const salesMonths = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month, COUNT(*) AS value
       FROM \`sales\` WHERE created_at >= NOW() - interval '12 months'
      GROUP BY 1 ORDER BY 1 ASC`,
  ).catch(() => []);
  const topTenants = await dbQuery<RowDataPacket[]>(
    `SELECT st.slug, st.name,
            (SELECT COUNT(*) FROM \`appointments\` a WHERE a.tenant_id = st.id AND a.created_at >= NOW() - interval '30 days') AS appointments,
            (SELECT COUNT(*) FROM \`sales\` s WHERE s.tenant_id = st.id AND s.created_at >= NOW() - interval '30 days') AS sales
       FROM \`saas_tenants\` st
      WHERE st.status='active'
      ORDER BY 3 DESC, 4 DESC
      LIMIT 5`,
  ).catch(() => []);

  const sortedByTenants = [...plansOut].sort((a, b) => b.tenants - a.tenants);
  const sortedByMrr = [...plansOut].sort((a, b) => b.mrr - a.mrr);

  return {
    growth: {
      tenants_by_month: fillMonths(tenantMonths.map((row) => ({ month: String(row.month), admin: Number(row.admin ?? 0), self_signup: Number(row.self_signup ?? 0) })), { admin: 0, self_signup: 0 }),
      signup_funnel: {
        requests: Number(funnel[0]?.requests ?? 0),
        verified: Number(funnel[0]?.verified ?? 0),
        active: Number(funnel[0]?.active ?? 0),
      },
      marketplace: {
        total: Number(marketplaceTotals[0]?.total ?? 0),
        verified: Number(marketplaceTotals[0]?.verified ?? 0),
        active_30d: Number(marketplaceTotals[0]?.active_30d ?? 0),
        new_by_month: fillMonths(marketplaceMonths.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) })), { value: 0 }),
      },
    },
    revenue: {
      mrr_total: mrrTotal,
      arpu: tenantsActive > 0 ? Math.round((mrrTotal / tenantsActive) * 100) / 100 : 0,
      tenants_active: tenantsActive,
      sms_by_month: fillMonths(smsMonths.map((row) => ({ month: String(row.month), revenue: Math.round(Number(row.revenue ?? 0) * 100) / 100, orders: Number(row.orders ?? 0) })), { revenue: 0, orders: 0 }),
      mrr_trend: mrrTrend.map((row) => ({ day: String(row.day), mrr: Number(row.mrr ?? 0) })).reverse(),
    },
    plans: {
      by_plan: plansOut,
      unassigned_active: Number(unassigned[0]?.count ?? 0),
      top_by_tenants: sortedByTenants[0]?.tenants ? sortedByTenants[0].name : "-",
      top_by_mrr: sortedByMrr[0]?.mrr ? sortedByMrr[0].name : "-",
      assignments_by_month: fillMonths(assignments.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) })), { value: 0 }),
    },
    usage: {
      totals: {
        gestionale_users: Number(totals[0]?.gestionale_users ?? 0),
        clients: Number(totals[0]?.clients ?? 0),
        appointments: Number(totals[0]?.appointments ?? 0),
        sales: Number(totals[0]?.sales ?? 0),
      },
      appointments_by_month: fillMonths(apptMonths.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) })), { value: 0 }),
      sales_by_month: fillMonths(salesMonths.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) })), { value: 0 }),
      top_tenants: topTenants.map((row) => ({ slug: String(row.slug), name: String(row.name), appointments: Number(row.appointments ?? 0), sales: Number(row.sales ?? 0) })),
    },
  };
}

// Sintesi EXECUTIVE per la dashboard: numeri correnti + delta dal
// primo snapshot di ~30 giorni fa (null se lo storico non c'e' ancora —
// la UI mostra '—', mai delta inventati).
export async function saasExecSummary() {
  await ensureSaasStatsSchema();
  const stats = await dbQuery<RowDataPacket[]>(
    `SELECT (SELECT COALESCE(SUM(p.price_month),0) FROM \`saas_tenants\` t JOIN \`saas_plans\` p ON p.id=t.plan_id AND p.is_active=1 WHERE t.status='active') AS mrr,
            (SELECT COUNT(*) FROM \`public_customer_accounts\`) AS marketplace_accounts,
            (SELECT COALESCE(SUM(amount_gross),0) FROM \`saas_sms_orders\` WHERE status='paid' AND SUBSTRING(created_at::text FROM 1 FOR 7) = SUBSTRING(NOW()::text FROM 1 FOR 7)) AS sms_month`,
  ).catch(() => []);
  const prev = await dbQuery<RowDataPacket[]>(
    "SELECT mrr, marketplace_accounts FROM `saas_metrics_daily` WHERE day <= ? ORDER BY day DESC LIMIT 1",
    [localDay(-30)],
  ).catch(() => []);
  return {
    mrr: Math.round(Number(stats[0]?.mrr ?? 0) * 100) / 100,
    marketplace_accounts: Number(stats[0]?.marketplace_accounts ?? 0),
    sms_month_revenue: Math.round(Number(stats[0]?.sms_month ?? 0) * 100) / 100,
    mrr_prev: prev[0] ? Number(prev[0].mrr ?? 0) : null,
    marketplace_prev: prev[0] ? Number(prev[0].marketplace_accounts ?? 0) : null,
  };
}

// STATO SISTEMA per la card della dashboard (redesign 2026-07-19): cron
// (ultimo esito per job), ultimo backup, policy 2FA — tre query leggere.
export async function saasSystemStatus() {
  const cron = await dbQuery<RowDataPacket[]>(
    `SELECT r.status, COUNT(*) AS count FROM \`saas_cron_runs\` r
      WHERE r.id = (SELECT MAX(r2.id) FROM \`saas_cron_runs\` r2 WHERE r2.job = r.job)
      GROUP BY r.status`,
  ).catch(() => []);
  const lastBackup = await dbQuery<RowDataPacket[]>(
    "SELECT tenant_slug, created_at FROM `saas_tenant_backups` WHERE status='completed' ORDER BY id DESC LIMIT 1",
  ).catch(() => []);
  const lastRun = await dbQuery<RowDataPacket[]>(
    "SELECT job, started_at FROM `saas_cron_runs` ORDER BY id DESC LIMIT 1",
  ).catch(() => []);
  const { getAdminSetting } = await import("@/lib/saas-admin-security");
  return {
    cron_ok: Number(cron.find((row) => String(row.status) === "ok")?.count ?? 0),
    cron_error: Number(cron.find((row) => String(row.status) === "error")?.count ?? 0),
    cron_last_job: lastRun[0] ? String(lastRun[0].job) : null,
    cron_last_at: lastRun[0] ? String(lastRun[0].started_at ?? "") : null,
    last_backup_slug: lastBackup[0] ? String(lastBackup[0].tenant_slug) : null,
    last_backup_at: lastBackup[0] ? String(lastBackup[0].created_at ?? "") : null,
    totp_policy: (await getAdminSetting("require_totp").catch(() => "")) === "1",
  };
}

function localDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
