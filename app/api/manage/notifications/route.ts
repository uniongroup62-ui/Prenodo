import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { getAutomationSettings, saveClientBirthdayAlertDays } from "@/lib/automation-reminders";
import { fidelityCardExpiryNotificationConfig, listDbNotifications, listNotificationPendingAppointments, markDbNotificationRead } from "@/lib/db-repositories";
import { listBirthdayNotificationRows, notificationFidelityCardGroups, notificationInstallmentGroups } from "@/lib/manage-dashboard-alerts";
import { tableExists } from "@/lib/tenant-db";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { countUnseenQuoteDecisions, countUpcomingBirthdays, getNotificationSummary } from "@/lib/manage-shell-context";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso notifiche mancante.", 403);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";

  try {
    // Port del poller legacy ?page=notifications&action=count: ritorna il
    // notificationSummary corrente (badge topbar) con no-store.
    if (action === "count") {
      const locationContext = await getManageLocationContext(tenantSlug);
      const summary = await getNotificationSummary(
        tenantSlug,
        session.user,
        locationContext.currentLocationId,
        locationContext.needsLocationSelection,
      );
      return Response.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
    }

    // Port di notifications.php: "Appuntamenti in attesa" (dettagli completi) +
    // "Tessere Fidelity in scadenza/scadute", filtrati per la sede corrente.
    if (action === "pending") {
      const locationContext = await getManageLocationContext(tenantSlug);
      const pending = await listNotificationPendingAppointments(tenantSlug, locationContext.currentLocationId);
      const canFidelity = can(session.user.perms, "fidelity.membership");
      const fidelityGroups = canFidelity ? await notificationFidelityCardGroups(tenantSlug) : [];
      // Testi della sezione Fidelity dipendenti dalla config tessera
      // (notifications.php 317-338): renewal / reminder / nessuna finestra.
      const cfg = await fidelityCardExpiryNotificationConfig(tenantSlug).catch(
        () => ({ mode: "disabled" as const, value: 0, unit: "days" as const }),
      );
      const durLabel = (v: number, unit: string) =>
        `${v} ${unit === "years" ? (v === 1 ? "anno" : "anni") : unit === "months" ? (v === 1 ? "mese" : "mesi") : v === 1 ? "giorno" : "giorni"}`;
      let sectionText: string;
      let emptyText: string;
      if (cfg.mode === "renewal" && cfg.value > 0) {
        sectionText = `Mostra le tessere già scadute e quelle entrate nella finestra di rinnovo automatico (${durLabel(cfg.value, cfg.unit)}).`;
        emptyText = "Nessuna tessera è attualmente scaduta o dentro la finestra di rinnovo automatico.";
      } else if (cfg.value > 0) {
        sectionText = `Mostra le tessere già scadute e quelle in scadenza nei prossimi ${cfg.value} ${cfg.value === 1 ? "giorno" : "giorni"}.`;
        emptyText = "Nessuna tessera è attualmente scaduta o dentro il promemoria di scadenza configurato.";
      } else {
        sectionText = "Mostra le tessere già scadute. Per vedere anche quelle in scadenza, imposta il rinnovo automatico oppure il promemoria di scadenza in Fidelity → Adesione → Impostazioni tessera Fidelity.";
        emptyText = "Nessuna tessera è attualmente scaduta.";
      }
      const locationLabel = locationContext.locations.find((l) => l.id === locationContext.currentLocationId)?.name ?? "";
      return Response.json({
        ok: true,
        pending,
        fidelityGroups,
        fidelitySection: { enabled: canFidelity && cfg.mode !== "disabled", sectionText, emptyText },
        canManage: can(session.user.perms, "appointments.manage"),
        locationLabel,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // Pagina "Compleanni clienti" (notifications_birthdays.php): righe con
    // esclusioni legacy (bloccati + clienti-sconosciuto), finestra e permesso.
    if (action === "birthdays") {
      const canSee = canAny(session.user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"]);
      const settings = await getAutomationSettings(tenantSlug);
      const days = settings.client_birthday_alert_days;
      const rows = canSee ? await listBirthdayNotificationRows(tenantSlug, days, 200) : [];
      return Response.json({ ok: true, canSee, schemaOk: true, alertDays: days, rows }, { headers: { "Cache-Control": "no-store" } });
    }

    // Pagina "Rate in scadenza / scadute" (notifications_installments.php):
    // gruppi legacy con anteprima 25, giorni configurati e sede corrente.
    if (action === "installment_groups") {
      const canSee = can(session.user.perms, "installments.manage");
      const settings = await getAutomationSettings(tenantSlug);
      const locationContext = await getManageLocationContext(tenantSlug);
      const schemaOk = await tableExists("sale_installments").catch(() => false);
      const groups = canSee && schemaOk
        ? await notificationInstallmentGroups(tenantSlug, locationContext.currentLocationId, 25)
        : [];
      const locationLabel = locationContext.locations.find((l) => l.id === locationContext.currentLocationId)?.name ?? "";
      return Response.json({
        ok: true,
        canSee,
        schemaOk,
        alertDays: settings.installment_alert_days,
        groups,
        locationLabel,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // Port di BrowserNotifications::feed: eventi {key,type,title,body,url} per le
    // notifiche desktop. Il tipo "appointment_pending" è sempre attivo; gli altri
    // (quotes/installments/birthdays/fidelity_cards) sono filtrati lato client
    // secondo le preferenze utente. Gated dai permessi come il legacy.
    if (action === "feed") {
      const locationContext = await getManageLocationContext(tenantSlug);
      const loc = locationContext.currentLocationId;
      const perms = session.user.perms;
      const events: Array<{ key: string; type: string; title: string; body: string; url: string }> = [];

      const pending = await listNotificationPendingAppointments(tenantSlug, loc);
      for (const a of pending) {
        const when = a.dateLabel ? `${a.dateLabel} ${a.timeLabel}${a.endLabel ? ` - ${a.endLabel}` : ""}` : "";
        const parts = [a.clientName];
        if (when) parts.push(when);
        if (a.publicCode) parts.push(`#${a.publicCode}`);
        if (a.packageSummary) parts.push(a.packageSummary);
        if (a.prepaidSummary) parts.push(a.prepaidSummary);
        events.push({ key: `appointment_pending:${a.id}`, type: "appointment_pending", title: "Nuova prenotazione in attesa", body: `${a.serviceName} - ${parts.join(" - ")}`, url: `/${tenantSlug}/notifications` });
      }

      if (can(perms, "quotes.manage")) {
        const qc = await countUnseenQuoteDecisions(tenantSlug, loc).catch(() => 0);
        if (qc > 0) events.push({ key: `quote_response:count:${qc}`, type: "quote_response", title: qc === 1 ? "Risposta a un preventivo" : "Risposte ai preventivi", body: qc === 1 ? "1 preventivo con risposta del cliente da leggere." : `${qc} preventivi con risposta del cliente da leggere.`, url: `/${tenantSlug}/notifications_quotes` });
      }

      if (can(perms, "installments.manage")) {
        for (const g of await notificationInstallmentGroups(tenantSlug, loc)) {
          events.push({ key: g.key, type: "installment_due", title: g.title, body: g.text, url: `/${tenantSlug}/notifications_installments` });
        }
      }

      const bc = await countUpcomingBirthdays(tenantSlug).catch(() => 0);
      if (bc > 0) events.push({ key: `client_birthday:count:${bc}`, type: "client_birthday", title: bc === 1 ? "Compleanno cliente" : "Compleanni clienti", body: bc === 1 ? "1 cliente compie gli anni a breve." : `${bc} clienti compiono gli anni a breve.`, url: `/${tenantSlug}/notifications_birthdays` });

      if (can(perms, "fidelity.membership")) {
        for (const g of await notificationFidelityCardGroups(tenantSlug)) {
          events.push({ key: g.key, type: "fidelity_cards", title: g.title, body: g.text, url: `/${tenantSlug}/fidelity_membership` });
        }
      }

      return Response.json({ ok: true, events }, { headers: { "Cache-Control": "no-store" } });
    }

    // Impostazioni avvisi lette dalle pagine notifiche (giorni compleanni/rate).
    if (action === "settings") {
      const settings = await getAutomationSettings(tenantSlug);
      return Response.json({
        ok: true,
        client_birthday_alert_days: settings.client_birthday_alert_days,
        installment_alert_days: settings.installment_alert_days,
      });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      notifications: await listDbNotifications(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso notifiche mancante.", 403);

  const body = await parseRequestBody(request);
  const action = String(body.action ?? "read");

  try {
    // Port di notifications_birthdays.php action=save_settings: clamp 0..365 e
    // persistenza di client_birthday_alert_days, messaggio legacy.
    if (action === "save_birthday_days") {
      if (!canAny(session.user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"])) {
        return jsonError("Operazione non autorizzata", 403);
      }
      const days = await saveClientBirthdayAlertDays(tenantSlug, parseInteger(body.client_birthday_alert_days ?? body.days, 7));
      return Response.json({ ok: true, message: "Impostazioni salvate", days });
    }

    const id = parseInteger(body.id);
    const notification = await markDbNotificationRead(id, tenantSlug);
    return Response.json({ ok: true, source: "notifications?action=read", sourceMode: "database", notification, notifications: await listDbNotifications(tenantSlug) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}
