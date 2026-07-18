import { currentSaasAdminSession, isSaasBootstrapped, saasAdminTotpEnabled } from "@/lib/saas-admin-auth";

export async function GET() {
  const session = await currentSaasAdminSession();
  const totpEnabled = session ? await saasAdminTotpEnabled(session.user.id) : false;
  return Response.json({
    ok: true,
    bootstrapped: await isSaasBootstrapped(),
    user: session?.user ?? null,
    totpEnabled,
    // Owner senza 2FA: la UI mostra il banner di setup (enforcement soft).
    totpSetupSuggested: Boolean(session && session.user.role === "owner" && !totpEnabled),
  });
}
