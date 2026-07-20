import fs from "node:fs";
import path from "node:path";
import { assertSameOrigin, logSaasAdminAction } from "@/lib/saas-admin-security";
import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { canManageSaasTenants, requireSaasAdminSession } from "@/lib/saas-admin-auth";
import {
  absoluteSaasBackupPath,
  allTenantSmsDiagnostics,
  createManualSmsTopUp,
  createSaasTenantBackup,
  isR2BackupPath,
  r2BackupKey,
  latestEmailMovements,
  latestSmsMovements,
  listSaasTenantBackups,
  saasBackupById,
  saveSmsPlan,
  saveSmsPricingSettings,
  setSmsPlanActive,
  smsOrders,
  smsPlanEconomics,
  smsPlans,
  smsPricingSettings,
  smsProviderDiagnostics,
  smsSummary,
  tenantWalletBalance,
  moveSmsPlan,
} from "@/lib/saas-operations";
import { listSaasTenants, requireSaasTenant, tenantStatus } from "@/lib/saas-tenant-manager";

export const dynamic = "force-dynamic";

// CSV con BOM UTF-8 (Excel-friendly) e campi quotati.
function csvResponse(filename: string, rows: string[][]): Response {
  const body = "﻿" + rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function GET(request: Request) {
  try {
    const session = await requireSaasAdminSession();
    const url = new URL(request.url);
    const section = url.searchParams.get("section") ?? "";

    if (section === "controls") {
      const checkEndpoint = url.searchParams.get("check_endpoint") !== "0";
      const { listCronRuns } = await import("@/lib/cron");
      const [provider, tenants, cron] = await Promise.all([
        smsProviderDiagnostics(checkEndpoint),
        allTenantSmsDiagnostics(false),
        listCronRuns(30),
      ]);
      return Response.json({ ok: true, provider, tenants, cron });
    }

    if (section === "sms_plans") {
      const [settings, plans, activePlans, summary, orders, tenants] = await Promise.all([
        smsPricingSettings(),
        smsPlans(true),
        smsPlans(false),
        smsSummary(),
        smsOrders(40),
        listSaasTenants(),
      ]);
      const tenantOptions = await Promise.all(
        tenants
          .filter((tenant) => tenantStatus(tenant) !== "deleted")
          .map(async (tenant) => ({
            id: Number(tenant.id),
            slug: String(tenant.slug),
            name: String(tenant.name ?? tenant.slug),
            status: tenantStatus(tenant),
            wallet_balance: await tenantWalletBalance(tenant).catch(() => 0),
          })),
      );
      return Response.json({
        ok: true,
        settings,
        suggested_credit_price: Number(settings.suggested_credit_price ?? 0),
        plans: plans.map((plan) => ({ ...plan, economics: smsPlanEconomics(plan, settings) })),
        activePlans,
        summary,
        orders,
        tenants: tenantOptions,
      });
    }

    if (section === "send_movements") {
      const [sms, emails] = await Promise.all([latestSmsMovements(), latestEmailMovements()]);
      return Response.json({ ok: true, sms, emails });
    }

    // Piani & Ricavi (Fase E, 2026-07-19): piani con limiti, MRR, SMS/mese.
    if (section === "billing") {
      const { listSaasPlans, saasRevenueSummary } = await import("@/lib/saas-plans");
      const [plans, revenue, tenants] = await Promise.all([
        listSaasPlans(true),
        saasRevenueSummary(),
        listSaasTenants(),
      ]);
      return Response.json({
        ok: true,
        plans,
        revenue,
        tenants: tenants
          .filter((tenant) => tenantStatus(tenant) === "active")
          .map((tenant) => ({
            id: Number(tenant.id),
            slug: String(tenant.slug),
            name: String(tenant.name ?? tenant.slug),
            plan_id: tenant.plan_id === null || tenant.plan_id === undefined ? null : Number(tenant.plan_id),
            plan: String(tenant.plan ?? ""),
          })),
      });
    }

    // Export CSV (Fase 4, 2026-07-19): download diretto dal browser.
    if (section === "export_tenants") {
      const tenants = await listSaasTenants();
      const rows = [
        ["id", "slug", "nome", "stato", "creato_il"],
        ...tenants.map((tenant) => [
          String(tenant.id ?? ""),
          String(tenant.slug ?? ""),
          String(tenant.name ?? ""),
          tenantStatus(tenant),
          String(tenant.created_at ?? ""),
        ]),
      ];
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "ops_export_tenants", request });
      return csvResponse("tenants.csv", rows);
    }

    if (section === "export_sms_orders") {
      const orders = await smsOrders(500);
      const rows = [
        ["id", "tenant", "crediti", "importo_lordo", "stato", "creato_il"],
        ...orders.map((order) => {
          const r = order as Record<string, unknown>;
          return [
            String(r.id ?? ""),
            String(r.tenant_slug ?? r.tenant ?? ""),
            String(r.credits ?? ""),
            String(r.amount_gross ?? ""),
            String(r.status ?? ""),
            String(r.created_at ?? ""),
          ];
        }),
      ];
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "ops_export_sms_orders", request });
      return csvResponse("ordini-sms.csv", rows);
    }

    // Statistiche piattaforma (vista Statistiche, 2026-07-19).
    if (section === "stats") {
      const { saasStatistics } = await import("@/lib/saas-stats");
      return Response.json({ ok: true, stats: await saasStatistics() });
    }

    // Audit con filtri + paginazione (2026-07-19).
    if (section === "audit_search") {
      const { searchSaasAudit } = await import("@/lib/saas-tenant-manager");
      const result = await searchSaasAudit({
        q: url.searchParams.get("q") ?? "",
        action: url.searchParams.get("audit_action") ?? "",
        tenant: url.searchParams.get("tenant") ?? "",
        days: parseInteger(url.searchParams.get("days"), 0),
        page: parseInteger(url.searchParams.get("page"), 1),
      });
      return Response.json({ ok: true, ...result });
    }

    if (section === "export_audit") {
      const { searchSaasAudit } = await import("@/lib/saas-tenant-manager");
      const result = await searchSaasAudit({
        q: url.searchParams.get("q") ?? "",
        action: url.searchParams.get("audit_action") ?? "",
        tenant: url.searchParams.get("tenant") ?? "",
        days: parseInteger(url.searchParams.get("days"), 0),
        page: 1,
        perPage: 100,
      });
      const rows = [
        ["id", "data", "azione", "tenant", "attore", "messaggio"],
        ...result.rows.map((row) => [
          String(row.id ?? ""),
          String(row.created_at ?? ""),
          String(row.action ?? ""),
          String(row.tenant_slug ?? ""),
          String(row.actor_email ?? row.actor_name ?? ""),
          String(row.message ?? ""),
        ]),
      ];
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "ops_export_audit", request });
      return csvResponse("audit.csv", rows);
    }

    // Ripristino: ultimi backup di slug NON piu' esistenti (post-delete).
    if (section === "restore_candidates") {
      const { restorableSaasBackups } = await import("@/lib/saas-operations");
      return Response.json({ ok: true, candidates: await restorableSaasBackups(20) });
    }

    // Elenco COMPLETO (leggero) per le operazioni massive: la lista tenant
    // dell'overview e' PAGINATA (25/50) — la selezione bulk deve vederli tutti.
    if (section === "maintenance_tenants") {
      const tenants = await listSaasTenants();
      return Response.json({
        ok: true,
        tenants: tenants
          .filter((tenant) => tenantStatus(tenant) !== "deleted")
          .map((tenant) => ({
            slug: String(tenant.slug),
            name: String(tenant.name ?? tenant.slug),
            status: tenant.status,
            is_active: tenant.is_active,
            health: { level: tenant.health_level ?? null },
            health_checked_at: tenant.health_checked_at ?? null,
          })),
      });
    }

    // Registrazioni self-service (lettura censurata, mai hash).
    if (section === "signups") {
      const { listSaasSignups } = await import("@/lib/saas-operations");
      return Response.json({ ok: true, signups: await listSaasSignups(50) });
    }

    if (section === "backups") {
      const tenant = await requireSaasTenant(url.searchParams.get("slug") ?? "");
      return Response.json({ ok: true, backups: await listSaasTenantBackups(Number(tenant.id), 50) });
    }

    if (section === "backup_download") {
      if (!canManageSaasTenants(session.user)) return jsonError("Permessi insufficienti per scaricare backup.", 403);
      const tenant = await requireSaasTenant(url.searchParams.get("slug") ?? "");
      const backup = await saasBackupById(parseInteger(url.searchParams.get("id"), 0), Number(tenant.id));
      if (!backup) return jsonError("Backup non trovato.", 404);
      // Backup su R2 (Fase C): redirect a URL presigned a vita breve — il
      // file non passa dal server e il bucket resta privato.
      if (isR2BackupPath(String(backup.backup_path ?? ""))) {
        const { presignedPrivateGetUrl } = await import("@/lib/storage");
        const presigned = await presignedPrivateGetUrl(r2BackupKey(String(backup.backup_path)), 300);
        return Response.redirect(presigned, 302);
      }
      const absolute = await absoluteSaasBackupPath(backup);
      const bytes = await fs.promises.readFile(absolute);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(absolute).replace(/"/g, "")}"`,
          "Content-Length": String(bytes.byteLength),
        },
      });
    }

    return jsonError("Sezione operativa non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSaasAdminSession();
    if (!canManageSaasTenants(session.user)) return jsonError("Permessi insufficienti per operazioni SaaS.", 403);

    const body = await parseRequestBody(request);
    const action = body.action || "";
    void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: `ops_${action}`, target: String(body.tenant_slug ?? body.slug ?? body.plan_id ?? "") || undefined, request });

    if (action === "sms_save_settings") {
      await saveSmsPricingSettings(body);
      return Response.json({ ok: true });
    }

    if (action === "sms_save_plan") {
      const id = await saveSmsPlan(body);
      return Response.json({ ok: true, id });
    }

    if (action === "sms_set_plan_active") {
      await setSmsPlanActive(parseInteger(body.plan_id, 0), body.active === "1" || body.active === "true");
      return Response.json({ ok: true });
    }

    if (action === "sms_move_plan") {
      await moveSmsPlan(parseInteger(body.plan_id, 0), parseInteger(body.direction, 1));
      return Response.json({ ok: true });
    }

    if (action === "sms_manual_topup") {
      const id = await createManualSmsTopUp(
        body.tenant_slug || body.slug || "",
        parseInteger(body.credits, 0),
        parseInteger(body.plan_id, 0) || null,
        body.note || "",
      );
      return Response.json({ ok: true, id });
    }

    if (action === "backup_create") {
      const result = await createSaasTenantBackup(body.slug || "", body.reason || "");
      return Response.json({ ok: true, backup: result });
    }

    if (action === "plan_save") {
      const { saveSaasPlan } = await import("@/lib/saas-plans");
      const id = await saveSaasPlan(body);
      return Response.json({ ok: true, id });
    }

    if (action === "plan_assign") {
      const { assignSaasPlan } = await import("@/lib/saas-plans");
      await assignSaasPlan(body.tenant_slug || body.slug || "", parseInteger(body.plan_id, 0));
      return Response.json({ ok: true });
    }

    if (action === "backup_restore") {
      const { restoreSaasTenantBackup } = await import("@/lib/saas-operations");
      const result = await restoreSaasTenantBackup(parseInteger(body.backup_id, 0), body.confirm_slug || "");
      return Response.json({ ok: true, result });
    }

    // Esegue ORA un cron sicuro dal pannello (solo diagnostica admin-health):
    // invoca il route handler vero, cosi' passa dal registro saas_cron_runs.
    if (action === "cron_run") {
      if ((body.job || "") !== "admin-health") return jsonError("Job non eseguibile dal pannello.", 400);
      const { GET: runHealthCron } = await import("@/app/api/cron/admin-health/route");
      const secret = process.env.CRON_SECRET ?? "";
      const cronRequest = new Request("http://internal/api/cron/admin-health", {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
      const cronResponse = await runHealthCron(cronRequest);
      return Response.json({ ok: cronResponse.status === 200, result: await cronResponse.json().catch(() => null) });
    }

    if (action === "signup_delete") {
      const { deleteSaasSignup } = await import("@/lib/saas-operations");
      await deleteSaasSignup(parseInteger(body.id, 0));
      return Response.json({ ok: true });
    }

    return jsonError("Azione operativa non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}
