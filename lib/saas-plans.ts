import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, tableExists } from "@/lib/tenant-db";
import { logSaasTenantAudit, requireSaasTenant } from "@/lib/saas-tenant-manager";

// PIANI VERI (Fase E pannello, 2026-07-19): prima 'plan' era una stringa
// libera senza conseguenze. saas_plans e' l'entita' che governa i limiti
// (sedi, staff, SMS inclusi) e alimenta la vista Ricavi (MRR). Il tenant la
// aggancia via saas_tenants.plan_id; il campo legacy 'plan' resta come
// etichetta ed e' sincronizzato all'assegnazione. REGOLA: nessun piano
// assegnato o limite NULL = ILLIMITATO (zero impatti sui tenant esistenti).
// NB: DDL runtime in dialetto POSTGRES (trappola toPostgresSql).

export type SaasPlanRow = RowDataPacket & {
  id: number;
  name: string;
  price_month: number | string;
  max_locations: number | null;
  max_staff: number | null;
  sms_included_month: number;
  is_active: number;
  sort_order: number;
  notes?: string | null;
};

let plansEnsured = false;

export async function ensureSaasPlansSchema(): Promise<void> {
  if (plansEnsured) return;
  if (!(await tableExists("saas_plans"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_plans" (
      "id" SERIAL PRIMARY KEY,
      "name" VARCHAR(120) NOT NULL,
      "price_month" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "max_locations" INTEGER NULL DEFAULT NULL,
      "max_staff" INTEGER NULL DEFAULT NULL,
      "sms_included_month" INTEGER NOT NULL DEFAULT 0,
      "is_active" SMALLINT NOT NULL DEFAULT 1,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "notes" VARCHAR(500) NULL DEFAULT NULL
    )`,
    );
  }
  await dbExecute(`ALTER TABLE "saas_tenants" ADD COLUMN IF NOT EXISTS "plan_id" INTEGER NULL DEFAULT NULL`).catch(() => undefined);
  plansEnsured = true;
}

export async function listSaasPlans(includeInactive = true): Promise<SaasPlanRow[]> {
  await ensureSaasPlansSchema();
  return dbQuery<SaasPlanRow[]>(
    `SELECT * FROM \`saas_plans\` ${includeInactive ? "" : "WHERE is_active=1"} ORDER BY sort_order ASC, id ASC`,
  );
}

export async function saveSaasPlan(input: Record<string, string>): Promise<number> {
  await ensureSaasPlansSchema();
  const id = parseInt(input.plan_id ?? "0", 10) || 0;
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Nome piano obbligatorio.");
  const price = Math.max(0, Number(String(input.price_month ?? "0").replace(",", ".")) || 0);
  const maxLocations = optionalLimit(input.max_locations);
  const maxStaff = optionalLimit(input.max_staff);
  const smsIncluded = Math.max(0, parseInt(input.sms_included_month ?? "0", 10) || 0);
  const isActive = input.is_active === "0" || input.is_active === "false" ? 0 : 1;
  const notes = (input.notes ?? "").trim() || null;

  if (id > 0) {
    await dbExecute(
      "UPDATE `saas_plans` SET name=?, price_month=?, max_locations=?, max_staff=?, sms_included_month=?, is_active=?, notes=? WHERE id=?",
      [name, price, maxLocations, maxStaff, smsIncluded, isActive, notes, id],
    );
    await logSaasTenantAudit("saas_plan.update", null, "Piano SaaS aggiornato", { plan_id: id, name, price_month: price, max_locations: maxLocations });
    return id;
  }
  const result = await dbExecute(
    "INSERT INTO `saas_plans`(name,price_month,max_locations,max_staff,sms_included_month,is_active,sort_order,notes) VALUES(?,?,?,?,?,?,?,?)",
    [name, price, maxLocations, maxStaff, smsIncluded, isActive, await nextSortOrder(), notes],
  );
  await logSaasTenantAudit("saas_plan.create", null, "Piano SaaS creato", { plan_id: result.insertId, name, price_month: price });
  return result.insertId;
}

// Assegna (o stacca, planId=0) il piano al tenant: plan_id + etichetta legacy.
export async function assignSaasPlan(slug: string, planId: number): Promise<void> {
  await ensureSaasPlansSchema();
  const tenant = await requireSaasTenant(slug);
  if (planId > 0) {
    const rows = await dbQuery<SaasPlanRow[]>("SELECT * FROM `saas_plans` WHERE id=? LIMIT 1", [planId]);
    const plan = rows[0];
    if (!plan) throw new Error("Piano non trovato.");
    await dbExecute("UPDATE `saas_tenants` SET plan_id=?, plan=? WHERE id=?", [planId, String(plan.name), Number(tenant.id)]);
    await logSaasTenantAudit("saas_plan.assign", tenant, `Piano "${String(plan.name)}" assegnato`, { plan_id: planId });
  } else {
    await dbExecute("UPDATE `saas_tenants` SET plan_id=NULL WHERE id=?", [Number(tenant.id)]);
    await logSaasTenantAudit("saas_plan.unassign", tenant, "Piano rimosso dal tenant", {});
  }
}

// Limite sedi del piano del tenant: null = ILLIMITATO (nessun piano, piano
// senza limite o piano disattivato). Letto dal gate del gestionale.
export async function tenantPlanMaxLocations(slug: string): Promise<number | null> {
  try {
    await ensureSaasPlansSchema();
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT p.max_locations FROM \`saas_tenants\` t
        JOIN \`saas_plans\` p ON p.id = t.plan_id AND p.is_active = 1
       WHERE t.slug = ? LIMIT 1`,
      [slug],
    );
    const value = rows[0]?.max_locations;
    if (value === null || value === undefined) return null;
    const limit = Number(value);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
  } catch {
    // Fail-open: un blip del registro piani non deve bloccare il gestionale.
    return null;
  }
}

// Vista Ricavi: MRR (tenant attivi x prezzo piano), ordini SMS per mese,
// wallet crediti aggregato, tenant senza piano.
export async function saasRevenueSummary() {
  await ensureSaasPlansSchema();
  const byPlan = await dbQuery<RowDataPacket[]>(
    `SELECT p.id, p.name, p.price_month, COUNT(t.id) AS tenants
       FROM \`saas_plans\` p
       LEFT JOIN \`saas_tenants\` t ON t.plan_id = p.id AND t.status = 'active'
      GROUP BY p.id, p.name, p.price_month
      ORDER BY p.sort_order ASC, p.id ASC`,
  ).catch(() => []);
  const mrrTotal = byPlan.reduce((sum, row) => sum + Number(row.price_month ?? 0) * Number(row.tenants ?? 0), 0);
  const unassigned = await dbQuery<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM `saas_tenants` WHERE status='active' AND plan_id IS NULL",
  ).catch(() => []);
  const smsMonthly = await dbQuery<RowDataPacket[]>(
    `SELECT SUBSTRING(created_at::text FROM 1 FOR 7) AS month,
            COUNT(*) AS orders, SUM(credits) AS credits, SUM(amount_gross) AS revenue
       FROM \`saas_sms_orders\`
      WHERE status='paid'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
  ).catch(() => []);
  const wallet = await dbQuery<RowDataPacket[]>(
    "SELECT COALESCE(SUM(balance_credits),0) AS total FROM `sms_credit_wallet` WHERE tenant_id IS NOT NULL",
  ).catch(() => []);
  return {
    mrr_total: Math.round(mrrTotal * 100) / 100,
    by_plan: byPlan.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      price_month: Number(row.price_month ?? 0),
      tenants: Number(row.tenants ?? 0),
      mrr: Math.round(Number(row.price_month ?? 0) * Number(row.tenants ?? 0) * 100) / 100,
    })),
    unassigned_active: Number(unassigned[0]?.count ?? 0),
    sms_monthly: smsMonthly.map((row) => ({
      month: String(row.month ?? ""),
      orders: Number(row.orders ?? 0),
      credits: Number(row.credits ?? 0),
      revenue: Math.round(Number(row.revenue ?? 0) * 100) / 100,
    })),
    wallet_credits_total: Number(wallet[0]?.total ?? 0),
  };
}

function optionalLimit(value: string | undefined): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function nextSortOrder(): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT COALESCE(MAX(sort_order),0) AS max FROM `saas_plans`").catch(() => []);
  return Number(rows[0]?.max ?? 0) + 10;
}
