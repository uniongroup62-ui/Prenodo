import { assertSameOrigin, logSaasAdminAction } from "@/lib/saas-admin-security";
import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { canManageSaasAdmins, requireSaasAdminSession } from "@/lib/saas-admin-auth";
import {
  adminRoles,
  createSaasAdmin,
  listSaasAdmins,
  resetSaasAdminPassword,
  roleLabel,
  updateSaasAdmin,
} from "@/lib/saas-tenant-manager";

export async function GET() {
  try {
    const session = await requireSaasAdminSession();
    if (!canManageSaasAdmins(session.user)) return jsonError("Solo un owner SaaS puo gestire gli admin.", 403);
    return Response.json({
      ok: true,
      admins: await listSaasAdmins(),
      roles: adminRoles().map((role) => ({ role, label: roleLabel(role) })),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Accesso admin richiesto.", 401);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSaasAdminSession();
    if (!canManageSaasAdmins(session.user)) return jsonError("Solo un owner SaaS puo gestire gli admin.", 403);
    const body = await parseRequestBody(request);
    const action = body.action || "";
    void logSaasAdminAction({ adminId: session.user.id, adminEmail: session.user.email, action: `admin_${action}`, target: String(body.email ?? body.id ?? "") || undefined, request });
    if (action === "create") await createSaasAdmin(body);
    else if (action === "update") await updateSaasAdmin(parseInteger(body.id, 0), body, session.user);
    else if (action === "password") await resetSaasAdminPassword(parseInteger(body.id, 0), body.password || "");
    else return jsonError("Azione admin non valida.", 400);
    return Response.json({ ok: true, admins: await listSaasAdmins() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Operazione non riuscita.", 400);
  }
}
