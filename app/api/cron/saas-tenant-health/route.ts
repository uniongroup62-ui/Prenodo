import { activeTenantSlugs, assertCronAuth, trackCronResponse } from "@/lib/cron";
import { recordSaasTenantHealthForSlug } from "@/lib/saas-tenant-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/saas_tenant_health.php — daily SaaS tenant diagnostic.
// The PHP looped active tenants and called
// SaasTenantManager::recordHealthCheckForTenant($slug, 'cron', true), which
// computes the per-tenant health and upserts a row into saas_tenant_health_checks
// (plus the health_* columns on saas_tenants). The TS equivalent lives in
// lib/saas-tenant-manager.ts as recordSaasTenantHealthForSlug(slug, source, deep)
// so this route just authorizes, iterates the active tenants, and calls it.
type HealthResult = {
  tenant: string;
  level: "ok" | "warning" | "error";
  errors: number;
  warnings: number;
  ok: boolean;
  error?: string;
};

async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const slugs = await activeTenantSlugs();
    const results: HealthResult[] = [];
    let checked = 0;
    let okCount = 0;
    let warnings = 0;
    let errors = 0;
    let failed = 0;

    for (const slug of slugs) {
      try {
        const health = await recordSaasTenantHealthForSlug(slug, "cron", true);
        const level = health.level ?? "ok";
        checked += 1;
        if (level === "error") errors += 1;
        else if (level === "warning") warnings += 1;
        else okCount += 1;
        results.push({
          tenant: slug,
          level,
          errors: Number(health.errors ?? 0),
          warnings: Number(health.warnings ?? 0),
          ok: level === "ok",
        });
      } catch (error) {
        failed += 1;
        results.push({
          tenant: slug,
          level: "error",
          errors: 0,
          warnings: 0,
          ok: false,
          error: error instanceof Error ? error.message : "Errore cron tenant.",
        });
      }
    }

    return Response.json({
      ok: failed === 0,
      job: "saas-tenant-health",
      total: checked,
      checked,
      ok_count: okCount,
      warnings,
      errors,
      failed,
      results,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron saas-tenant-health." },
      { status: 500 },
    );
  }
}

export const POST = GET;

// Registro cron (Fase C pannello, 2026-07-19): auth PRIMA del tracking, poi
// l'esecuzione viene registrata in saas_cron_runs (esito, durata, sintesi).
export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return trackCronResponse("saas-tenant-health", () => handler(request));
}
