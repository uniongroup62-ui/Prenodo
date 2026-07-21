import { businessTodayIso } from "@/lib/business-datetime";
import { activeTenantSlugs, assertCronAuth, trackCronResponse } from "@/lib/cron";
import { dbExecute, tenantIdForSlug } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/quotes.php — auto-expire sent quotes past their valid_until,
// per active tenant. CURDATE() -> CURRENT_DATE.
async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const slugs = await activeTenantSlugs();
    const results: Array<{ tenant: string; expired: number }> = [];
    let total = 0;

    for (const slug of slugs) {
      // Isolamento per-tenant (audit 21/07): un tenant rotto non salta i successivi.
      try {
        const tenantId = await tenantIdForSlug(slug);
        if (!tenantId) continue;
        // Confine in ORA ROMA (audit 21/07): CURRENT_DATE del DB è UTC — tra le
        // 00:00 e le 02:00 di Roma la scadenza slittava; il lato manage usa già
        // businessTodayIso (quoteEffectiveStatusDb).
        const res = await dbExecute(
          `UPDATE quotes SET status='expired'
           WHERE tenant_id = ? AND status='sent' AND valid_until IS NOT NULL AND valid_until < ?`,
          [tenantId, businessTodayIso()],
        );
        results.push({ tenant: slug, expired: res.affectedRows });
        total += res.affectedRows;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[cron quotes] tenant ${slug} FALLITO:`, msg);
        results.push({ tenant: slug, expired: 0, error: msg } as { tenant: string; expired: number });
      }
    }

    return Response.json({ ok: true, job: "quotes", total, results });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore cron quotes." }, { status: 500 });
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
  return trackCronResponse("quotes", () => handler(request));
}
