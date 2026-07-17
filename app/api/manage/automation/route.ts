import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { getAutomationPageContext, getAutomationSettings, saveAutomationSettings } from "@/lib/automation-reminders";
import { listDbAutomationRules, runDbAutomationRule, toggleDbAutomationRule } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "automation.manage")) return jsonError("Permesso automazione mancante.", 403);

  try {
    return Response.json({
      ok: true,
      sourceMode: "database",
      rules: await listDbAutomationRules(tenantSlug),
      // Impostazioni complete della pagina Automazione (toggle + ore invio),
      // cosi' il form puo' prefillarsi come il legacy (automation.php).
      settings: await getAutomationSettings(tenantSlug),
      // Contesto pagina legacy: saldo crediti SMS, esempi con cancel policy,
      // pacchetti SMS del listino centrale, config promemoria Fidelity.
      page: await getAutomationPageContext(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore automazione.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "automation.manage")) return jsonError("Permesso automazione mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "run";
  const id = parseInteger(body.id);

  try {
    // Salvataggio della pagina Automazione (port di automation.php 24-71):
    // toggle + ore promemoria, poi rischedulazione dei reminder futuri.
    if (action === "save") {
      const settings = await saveAutomationSettings(tenantSlug, body);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "automazioni", action: "modifica", entityType: "automation_settings", entityId: 0, label: `Salvate impostazioni automazioni (promemoria ${settings.reminder_enabled ? `email ${settings.reminder_hours}h` : "email OFF"}, SMS ${settings.sms_reminder_enabled ? `${settings.sms_reminder_hours}h` : "OFF"})` });
      return Response.json({
        ok: true,
        sourceMode: "database",
        message: "Automazione salvata",
        settings,
        rules: await listDbAutomationRules(tenantSlug),
      });
    }

    if (action === "toggle") {
      const enabled = ["1", "true", "yes", "on"].includes((body.enabled ?? "").toLowerCase());
      const rule = await toggleDbAutomationRule(id, enabled, tenantSlug);
      return Response.json({ ok: true, source: "automation?action=toggle", sourceMode: "database", rule, rules: await listDbAutomationRules(tenantSlug) });
    }

    if (action === "run") {
      const result = await runDbAutomationRule(id, tenantSlug);
      return Response.json({ ok: true, source: "automation?action=run", sourceMode: "database", ...result, rules: await listDbAutomationRules(tenantSlug) });
    }

    return jsonError("Azione automazione non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore automazione.");
  }
}
