import { parseRequestBody } from "@/lib/api-utils";
import { clearManageSessionCookie, currentManageSession, revokeManageSessions } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  const slug = body.slug || manageTenantSlugFromRequest(request);
  // Revoca server-side (parita' con session_destroy legacy): un cookie
  // trattenuto dopo il logout non deve restare valido.
  const session = await currentManageSession(slug);
  if (session) await revokeManageSessions(slug, session.user.id);
  await clearManageSessionCookie(slug);
  return Response.json({ ok: true });
}
