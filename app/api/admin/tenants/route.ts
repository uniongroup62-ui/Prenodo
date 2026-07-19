import { assertSameOrigin, logSaasAdminAction } from "@/lib/saas-admin-security";
import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { canManageSaasTenants, requireSaasAdminSession } from "@/lib/saas-admin-auth";
import {
  activeSupportTokens,
  archiveSaasTenant,
  auditRows,
  createSaasTenant,
  createSupportAccessToken,
  deleteSaasTenant,
  healthAllSaasTenants,
  latestSaasHealthChecks,
  listSaasTenants,
  recentSupportTokens,
  repairAllSaasTenants,
  repairSaasTenantAdmin,
  repairSaasTenantSchema,
  resetSaasTenantOnboarding,
  restoreArchivedSaasTenant,
  revokeSupportToken,
  saasOperationalSummary,
  saasTenantBySlug,
  saasTenantSummary,
  recordSaasTenantHealthForSlug,
  setSaasTenantStatus,
  updateSaasPublicVisibility,
  updateSaasTenant,
} from "@/lib/saas-tenant-manager";

export async function GET(request: Request) {
  try {
    await requireSaasAdminSession();
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") ?? "";
    if (slug) {
      const tenant = await saasTenantBySlug(slug);
      if (!tenant) return jsonError("Tenant non trovato.", 404);
      const { buildTenantTimeline } = await import("@/lib/saas-tenant-timeline");
      const { tenantWalletBalance } = await import("@/lib/saas-operations");
      const [healthChecks, activeTokens, recentTokens, tenantAudit, timeline, smsCredits] = await Promise.all([
        latestSaasHealthChecks(Number(tenant.id), 10),
        activeSupportTokens(Number(tenant.id)),
        recentSupportTokens(Number(tenant.id), 20),
        auditRows(Number(tenant.id), 40),
        buildTenantTimeline(Number(tenant.id), 60),
        tenantWalletBalance({ id: Number(tenant.id), slug: String(tenant.slug) }).catch(() => 0),
      ]);
      return Response.json({ ok: true, tenant, healthChecks, activeTokens, recentTokens, audit: tenantAudit, timeline, smsCredits });
    }

    const tenants = await listSaasTenants({
      q: url.searchParams.get("q") ?? "",
      status: url.searchParams.get("status") ?? "",
    });
    // Paginazione (Fase A): summary/coda restano sull'insieme COMPLETO
    // filtrato, la tabella riceve solo la pagina richiesta.
    const perPage = Math.min(50, Math.max(5, parseInteger(url.searchParams.get("per_page"), 20)));
    const pageCount = Math.max(1, Math.ceil(tenants.length / perPage));
    const page = Math.min(pageCount, Math.max(1, parseInteger(url.searchParams.get("page"), 1)));
    const { buildSaasWorkQueue } = await import("@/lib/saas-work-queue");
    const { listSaasPlans } = await import("@/lib/saas-plans");
    const { saasExecSummary, saasSystemStatus } = await import("@/lib/saas-stats");
    return Response.json({
      exec: await saasExecSummary(),
      system: await saasSystemStatus(),
      ok: true,
      // Piani ATTIVI per le select (Nuovo tenant / tab Dati): il piano e'
      // un'entita', mai testo libero (coerenza Fase E).
      plans: (await listSaasPlans(false)).map((plan) => ({ id: Number(plan.id), name: String(plan.name), price_month: Number(plan.price_month ?? 0) })),
      tenants: tenants.slice((page - 1) * perPage, page * perPage),
      total: tenants.length,
      page,
      perPage,
      pageCount,
      summary: saasTenantSummary(tenants),
      operational: saasOperationalSummary(tenants),
      workQueue: await buildSaasWorkQueue(tenants),
      audit: await auditRows(null, 20),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 401);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSaasAdminSession();
    if (!canManageSaasTenants(session.user)) return jsonError("Permessi insufficienti per modificare i tenant.", 403);

    const body = await parseRequestBody(request);
    const action = body.action || "";
    const slug = body.slug || "";
    const origin = new URL(request.url).origin;
    // Audit di OGNI azione mutativa (Fase 1 blindatura): chi/cosa/quando/IP.
    void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: `tenant_${action}`, target: slug || undefined, request });

    if (action === "create") {
      const createdSlug = await createSaasTenant(body);
      // Piano come ENTITA' (select plan_id), mai testo libero.
      if (parseInteger(body.plan_id, 0) > 0) {
        const { assignSaasPlan } = await import("@/lib/saas-plans");
        await assignSaasPlan(createdSlug, parseInteger(body.plan_id, 0));
      }
      return Response.json({ ok: true, slug: createdSlug, tenant: await saasTenantBySlug(createdSlug) });
    }
    if (action === "update") {
      await updateSaasTenant(slug, body);
      if (body.plan_id !== undefined) {
        const { assignSaasPlan } = await import("@/lib/saas-plans");
        await assignSaasPlan(slug, parseInteger(body.plan_id, 0));
      }
    }
    else if (action === "visibility") await updateSaasPublicVisibility(slug, body);
    else if (action === "suspend") await setSaasTenantStatus(slug, "suspended", body.reason || "");
    else if (action === "activate") await setSaasTenantStatus(slug, "active");
    else if (action === "archive") await archiveSaasTenant(slug, body.reason || "");
    else if (action === "restore") await restoreArchivedSaasTenant(slug);
    else if (action === "reset_onboarding") await resetSaasTenantOnboarding(slug);
    else if (action === "repair_schema") await repairSaasTenantSchema(slug);
    else if (action === "record_health") await recordSaasTenantHealthForSlug(slug, "manual", true);
    else if (action === "repair_admin") await repairSaasTenantAdmin(slug, body);
    else if (action === "delete") {
      // Conferma PRIMA del backup: senza slug esatto niente lavoro (e niente
      // file di backup accumulati dai tentativi respinti).
      if ((body.confirm_slug || "").trim() !== slug) {
        return jsonError("Conferma eliminazione non valida: digita lo slug esatto.", 400);
      }
      // Backup AUTOMATICO pre-delete (Fase 4, 2026-07-19): prima di
      // distruggere il tenant si scatta un backup di sicurezza. Best-effort
      // ma TRACCIATO: l'esito finisce nell'audit insieme al delete.
      let preBackup = "";
      try {
        const { createSaasTenantBackup } = await import("@/lib/saas-operations");
        const backup = await createSaasTenantBackup(slug, "pre-delete automatico");
        preBackup = backup.filename;
      } catch (error) {
        preBackup = `FALLITO: ${error instanceof Error ? error.message : "errore"}`;
      }
      void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: "tenant_delete_prebackup", target: slug, details: preBackup, request });
      const result = await deleteSaasTenant(slug, body.confirm_slug || "");
      return Response.json({ ok: true, result, preBackup });
    } else if (action === "health_all") {
      return Response.json({ ok: true, results: await healthAllSaasTenants(true, true, "manual_all") });
    } else if (action === "repair_all") {
      return Response.json({ ok: true, results: await repairAllSaasTenants(body.include_inactive === "1" || body.include_inactive === "true") });
    } else if (action === "reset_selected_onboarding") {
      const slugs = (body.slugs || "").split(",").map((item) => item.trim()).filter(Boolean);
      const results = [];
      for (const item of slugs) {
        try {
          await resetSaasTenantOnboarding(item);
          results.push({ slug: item, ok: true, message: "reset onboarding" });
        } catch (error) {
          results.push({ slug: item, ok: false, message: error instanceof Error ? error.message : "Errore" });
        }
      }
      return Response.json({ ok: true, results });
    } else if (action === "support_create") {
      const token = await createSupportAccessToken(slug, body.reason || "", parseInteger(body.minutes, 30), origin);
      return Response.json({ ok: true, token });
    } else if (action === "support_revoke") {
      await revokeSupportToken(parseInteger(body.token_id, 0), slug);
    } else {
      return jsonError("Azione tenant non valida.", 400);
    }

    return Response.json({ ok: true, tenant: slug ? await saasTenantBySlug(slug) : null });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}
