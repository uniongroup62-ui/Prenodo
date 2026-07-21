import { databaseStatus } from "@/lib/tenant-db";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { jsonError } from "@/lib/api-utils";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  // Gate sessione (audit 2026-07-21): era l'unica route manage senza auth —
  // un probe anonimo poteva far eseguire query e leggere l'errore del driver.
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  return Response.json({
    ok: true,
    ...(await databaseStatus(tenantSlug)),
  });
}
