import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { automationScheduleReminder, getAutomationSettings, saveClientBirthdayAlertDays } from "@/lib/automation-reminders";
import { lifecycleKindForStatusChange, sendAppointmentLifecycleEmail } from "@/lib/appointment-lifecycle-email";
import { cancelDoneAppointment, fidelityCardExpiryNotificationConfig, listNotificationPendingAppointments } from "@/lib/db-repositories";
import { listBirthdayNotificationRows, notificationFidelityCardGroups, notificationInstallmentGroups } from "@/lib/manage-dashboard-alerts";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbQuery, quoteIdentifier, tableExists, tenantSelect, tenantTable } from "@/lib/tenant-db";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { getNotificationSummary } from "@/lib/manage-shell-context";
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
      // $fidelityCardsTableOk (notifications.php 309-315): tabella cards
      // assente → card dedicata 'Tessere Fidelity non disponibili.'.
      const fidelityTableOk = await tableExists("cards").catch(() => false);
      return Response.json({
        ok: true,
        pending,
        fidelityGroups,
        fidelitySection: { enabled: canFidelity && cfg.mode !== "disabled", sectionText, emptyText },
        fidelityTableOk,
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

    // Port di BrowserNotifications::feed (BrowserNotifications.php 76-369):
    // eventi {key,type,title,body,url,created_at,severity} per le notifiche
    // desktop. Le PREFERENZE UTENTE gattano i tipi LATO SERVER come il legacy
    // (appointment_pending sempre attivo), le CHIAVI includono seed di
    // conteggio/data (al cambio conteggio l'evento RI-notifica), i preventivi
    // sono eventi PER-QUOTE, ordinamento created_at desc + slice limit 1..50.
    if (action === "feed") {
      const locationContext = await getManageLocationContext(tenantSlug);
      const loc = locationContext.currentLocationId;
      const perms = session.user.perms;
      const limit = Math.max(1, Math.min(50, parseInteger(url.searchParams.get("limit"), 20)));
      const slugify = (v: string) => (String(v).toLowerCase().trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "item");
      const seed = (v: string) => (String(v).replace(/[^0-9a-zA-Z]+/g, "") || "na");
      const isoOf = (v: unknown): string => {
        const raw = String(v ?? "").trim();
        const d = raw ? new Date(raw.includes("T") ? raw : raw.replace(" ", "T")) : new Date();
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      };
      const fmtMoneyIt = (n: number) => {
        const [i, dp] = Math.abs(n).toFixed(2).split(".");
        return `${n < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dp}`;
      };
      type FeedEvent = { key: string; type: string; title: string; body: string; url: string; created_at: string; severity: string; _ts: number };
      const byKey = new Map<string, FeedEvent>();
      const push = (e: Omit<FeedEvent, "_ts">) => {
        if (!e.key) return;
        byKey.set(e.key, { ...e, _ts: Date.parse(e.created_at) || Date.now() });
      };

      // Preferenze utente lette LATO SERVER (BrowserNotifications::preferences).
      const prefs: Record<string, boolean> = { quotes: false, installments: false, birthdays: false, fidelity_cards: false };
      if (await columnExists("users", "browser_notification_preferences")) {
        const uRows = await tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "users", columns: "browser_notification_preferences", where: "id = ?", params: [session.user.id], limit: 1 }).catch(() => [] as RowDataPacket[]);
        try {
          const dec = JSON.parse(String(uRows[0]?.browser_notification_preferences ?? "") || "{}") as Record<string, unknown>;
          for (const k of Object.keys(prefs)) prefs[k] = dec[k] === true || dec[k] === 1 || dec[k] === "1" || dec[k] === "true" || dec[k] === "on" || dec[k] === "yes";
        } catch { /* default */ }
      }

      // Guardia legacy (feed riga 93): sotto gate selezione-sede il feed
      // risponde con metadati + summary (a zero) ed EVENTI VUOTI.
      if (locationContext.needsLocationSelection) {
        const summary = await getNotificationSummary(tenantSlug, session.user, loc, true);
        return Response.json({
          ok: true,
          generated_at: new Date().toISOString(),
          tenant: tenantSlug || "root",
          user_id: Number(session.user.id ?? 0),
          location_id: loc,
          browser_preferences: { appointments: true, ...prefs },
          events: [],
          ...summary,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // appointment_pending (addPendingAppointmentEvents): ordina per
      // COALESCE(created_at, starts_at) DESC, key con seed data creazione,
      // body 'servizio - cliente - d/m/Y H:i - H:i - #codice - pacchetto - prepagato'.
      const pending = await listNotificationPendingAppointments(tenantSlug, loc);
      const pendingIds = pending.map((a) => a.id).filter((n) => n > 0);
      const createdById = new Map<number, string>();
      if (pendingIds.length) {
        const apptTable = await tenantTable(tenantSlug, "appointments");
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT id, created_at, starts_at FROM ${quoteIdentifier(apptTable.name)} WHERE tenant_id = ? AND id = ANY(?)`,
          [apptTable.tenantId ?? 0, pendingIds],
        ).catch(() => [] as RowDataPacket[]);
        for (const r of rows) createdById.set(Number(r.id), String(r.created_at ?? r.starts_at ?? ""));
      }
      const pendingSorted = [...pending].sort((a, b) => (Date.parse(String(createdById.get(b.id) ?? "")) || 0) - (Date.parse(String(createdById.get(a.id) ?? "")) || 0) || b.id - a.id).slice(0, Math.min(20, limit));
      for (const a of pendingSorted) {
        const created = String(createdById.get(a.id) ?? "");
        const when = a.dateLabel ? `${a.dateLabel} ${a.timeLabel}${a.endLabel ? ` - ${a.endLabel}` : ""}` : "";
        let body = a.clientName || "Cliente";
        if (when) body += ` - ${when}`;
        if (a.publicCode) body += ` - #${a.publicCode}`;
        if (a.packageSummary) body += ` - ${a.packageSummary}`;
        if (a.prepaidSummary) body += ` - ${a.prepaidSummary}`;
        push({
          key: `appointment_pending:${a.id}:${seed(created)}`,
          type: "appointment_pending",
          title: "Nuova prenotazione in attesa",
          body: `${a.serviceName || "Appuntamento"} - ${body}`,
          url: `/${tenantSlug}/notifications`,
          created_at: isoOf(created),
          severity: "primary",
        });
      }

      // quote_response (addQuoteResponseEvents): UN EVENTO PER PREVENTIVO con
      // titolo Accettato/Rifiutato e body 'cliente - #numero - EUR importo'.
      if (prefs.quotes && can(perms, "quotes.manage")) {
        const quotesTable = await tenantTable(tenantSlug, "quotes");
        const qLoc = loc > 0 && (await columnExists(quotesTable.name, "location_id")) ? " AND q.location_id = ?" : "";
        const qParams: unknown[] = [quotesTable.tenantId ?? 0, ...(qLoc ? [loc] : [])];
        const clientsTable = await tenantTable(tenantSlug, "clients");
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT q.id, q.number, q.total, q.status, q.customer_decision_at,
                  COALESCE(q.client_name, c.full_name) AS client_name
             FROM ${quoteIdentifier(quotesTable.name)} q
             LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id = q.client_id AND c.tenant_id = q.tenant_id
            WHERE q.tenant_id = ? AND q.status IN ('accepted','rejected')
              AND q.customer_decision_at IS NOT NULL AND q.customer_decision_seen_at IS NULL${qLoc}
            ORDER BY q.customer_decision_at DESC, q.id DESC
            LIMIT ${Math.min(20, limit)}`,
          qParams,
        ).catch(() => [] as RowDataPacket[]);
        for (const r of rows) {
          const accepted = String(r.status ?? "").toLowerCase() === "accepted";
          const decision = String(r.customer_decision_at ?? "");
          let body = String(r.client_name ?? "").trim() || "Cliente";
          const number = String(r.number ?? "").trim();
          if (number) body += ` - #${number}`;
          body += ` - EUR ${fmtMoneyIt(Number(r.total ?? 0))}`;
          push({
            key: `quote_response:${Number(r.id)}:${accepted ? "accepted" : "rejected"}:${seed(decision)}`,
            type: "quote_response",
            title: accepted ? "Preventivo accettato" : "Preventivo rifiutato",
            body,
            url: `/${tenantSlug}/notifications_quotes`,
            created_at: isoOf(decision),
            severity: accepted ? "success" : "danger",
          });
        }
      }

      // installment_due (addInstallmentEvents): gruppi con anteprima 2, max 4,
      // key con conteggio+date_label (ri-notifica al cambio), body testo + 1a riga.
      if (prefs.installments && can(perms, "installments.manage")) {
        for (const g of (await notificationInstallmentGroups(tenantSlug, loc, 2)).slice(0, 4)) {
          if (g.count <= 0) continue;
          let body = g.text || "Rate in scadenza";
          if (g.lines[0]) body += ` - ${g.lines[0]}`;
          push({
            key: `installments:${slugify(g.key.replace(/^installments_/, ""))}:${g.count}:${slugify(g.dateLabel)}`,
            type: "installment_due",
            title: g.title,
            body,
            url: g.link || `/${tenantSlug}/notifications_installments`,
            created_at: isoOf(""),
            severity: g.kind,
          });
        }
      }

      // client_birthday (addBirthdayEvent): singolo evento, testi verbatim,
      // gate canAny come il legacy (clients/schede/consensi).
      if (prefs.birthdays && canAny(perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"])) {
        const settings = await getAutomationSettings(tenantSlug);
        const all = await listBirthdayNotificationRows(tenantSlug, settings.client_birthday_alert_days, 0);
        if (all.length > 0) {
          const first = all[0];
          const today = new Date();
          const pad2 = (n: number) => String(n).padStart(2, "0");
          const todayYmd = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
          const fmtD = (iso: string) => iso.split("-").reverse().join("/");
          push({
            key: `birthdays:${todayYmd}:${all.length}:${seed(first.birthdayNextDate)}`,
            type: "client_birthday",
            title: all.length === 1 ? "Compleanno cliente" : "Compleanni clienti",
            body: all.length === 1
              ? `${first.fullName || "Cliente"} compie gli anni ${fmtD(first.birthdayNextDate)}`
              : `${all.length} compleanni clienti nel periodo configurato`,
            url: `/${tenantSlug}/notifications_birthdays`,
            created_at: isoOf(""),
            severity: "info",
          });
        }
      }

      // fidelity_card (addFidelityCardEvents, tipo SINGOLARE): gruppi anteprima
      // 2, max 4, body testo + primo cliente.
      if (prefs.fidelity_cards && can(perms, "fidelity.membership")) {
        const groups = (await notificationFidelityCardGroups(tenantSlug)).slice(0, 4);
        for (const g of groups) {
          if (g.count <= 0) continue;
          let body = g.text || "Tessere Fidelity in evidenza";
          const firstClient = g.previewRows[0]?.clientName ?? "";
          if (firstClient) body += ` - ${firstClient}`;
          push({
            key: `fidelity_cards:${slugify(g.title)}:${g.count}:${slugify(g.dateLabel)}`,
            type: "fidelity_card",
            title: g.title || "Tessere Fidelity",
            body,
            url: g.link || `/${tenantSlug}/fidelity_membership`,
            created_at: isoOf(""),
            severity: g.kind,
          });
        }
      }

      // Ordinamento legacy: created_at desc, poi key desc; slice al limit.
      const events = Array.from(byKey.values())
        .sort((a, b) => b._ts - a._ts || b.key.localeCompare(a.key))
        .slice(0, limit)
        .map(({ _ts, ...e }) => e);

      // Payload legacy (BrowserNotifications::feed 82-90): metadati + il
      // notificationSummary MERGIATO — il poller topbar aggiorna i badge
      // direttamente dalla risposta del feed (renderCounts(data)).
      const summary = await getNotificationSummary(
        tenantSlug,
        session.user,
        loc,
        locationContext.needsLocationSelection,
      );
      return Response.json({
        ok: true,
        generated_at: new Date().toISOString(),
        tenant: tenantSlug || "root",
        user_id: Number(session.user.id ?? 0),
        location_id: loc,
        browser_preferences: { appointments: true, ...prefs },
        events,
        ...summary,
      }, { headers: { "Cache-Control": "no-store" } });
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

    // Azione GET sconosciuta: nel legacy non esiste una lista JSON generica
    // (la pagina HTML è il default); l'API risponde come api_user_prefs.
    return jsonError("Azione non valida.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}

// appt_norm_status (Helpers.php 9758-9776): sinonimi italiani inclusi — la
// guardia pending del POST legacy normalizza PRIMA di confrontare.
function apptNormStatusIt(status: string): string {
  let s = status.trim().toLowerCase();
  if (s === "cancelled") s = "canceled";
  if (["annullato", "annullata", "cancellato", "cancellata"].includes(s)) s = "canceled";
  if (["rifiutato", "rifiutata", "rejected"].includes(s)) s = "canceled";
  if (["no show", "no-show", "noshow", "non presentato", "non presentata", "cliente assente", "assente"].includes(s)) s = "no_show";
  if (["prenotato", "prenotata", "confirmed", "confermato", "confermata", "approved", "booked"].includes(s)) s = "scheduled";
  if (["in sospeso", "in attesa", "attesa"].includes(s)) s = "pending";
  if (["eseguito", "eseguita", "executed", "completed", "completato", "completata"].includes(s)) s = "done";
  return s;
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "notifications.view")) return jsonError("Permesso notifiche mancante.", 403);

  const body = await parseRequestBody(request);
  const action = String(body.action ?? "");

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

    // Port del POST di notifications.php (77-146): approva/annulla una
    // RICHIESTA IN ATTESA con le guardie legacy — permesso appuntamenti
    // ('Operazione non autorizzata'), riga visibile nella sede corrente col
    // ramo bridge ('Operazione non valida'), stato ancora pending con i
    // sinonimi italiani ('Appuntamento non piu in attesa' — senza accento).
    if (action === "approve" || action === "cancel" || action === "reject") {
      if (!can(session.user.perms, "appointments.manage")) {
        return jsonError("Operazione non autorizzata", 403);
      }
      const id = parseInteger(body.id);
      if (id <= 0) return jsonError("Operazione non valida", 400);

      const locationContext = await getManageLocationContext(tenantSlug);
      const loc = locationContext.currentLocationId;
      const rows = await tenantSelect<RowDataPacket>({
        slug: tenantSlug,
        table: "appointments",
        columns: "id, status, location_id",
        where: "id = ?",
        params: [id],
        limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      const row = rows[0];
      let visible = Boolean(row);
      if (row && loc > 0) {
        const rowLoc = row.location_id === null || row.location_id === undefined ? null : Number(row.location_id);
        if (rowLoc !== null) {
          visible = rowLoc === loc;
        } else {
          // NULL: visibile se nessuna riga bridge oppure bridge verso la sede.
          const bridge = await tenantSelect<RowDataPacket>({
            slug: tenantSlug,
            table: "appointment_locations",
            columns: "location_id",
            where: "appointment_id = ?",
            params: [id],
          }).catch(() => [] as RowDataPacket[]);
          visible = bridge.length === 0 || bridge.some((b) => Number(b.location_id) === loc);
        }
      }
      if (!visible) return Response.json({ ok: false, error: "Operazione non valida" });
      if (apptNormStatusIt(String(row!.status ?? "")) !== "pending") {
        return Response.json({ ok: false, error: "Appuntamento non piu in attesa" });
      }

      if (action === "approve") {
        // UPDATE doppio-guardato dallo stesso set pending della lista legacy
        // (riga 106): 0 righe toccate = approvato/annullato nel frattempo.
        const appt = await tenantTable(tenantSlug, "appointments");
        const updated = await dbQuery<RowDataPacket[]>(
          `UPDATE ${quoteIdentifier(appt.name)} SET status='scheduled'
            WHERE id = ?${appt.tenantId ? " AND tenant_id = ?" : ""}
              AND LOWER(TRIM(COALESCE(status,''))) IN ('pending','in sospeso','in attesa','attesa')
            RETURNING id`,
          appt.tenantId ? [id, appt.tenantId] : [id],
        ).catch(() => [] as RowDataPacket[]);
        if (!updated.length) return Response.json({ ok: false, error: "Appuntamento non piu in attesa" });
        // automation_handle_status_change(old, 'scheduled'): email 'approved'
        // + (ri)schedulazione promemoria.
        const kind = lifecycleKindForStatusChange("pending", "scheduled");
        if (kind) await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: id, kind });
        await automationScheduleReminder(tenantSlug, id);
        return Response.json({ ok: true, message: "Appuntamento approvato" });
      }

      // cancel/reject: lifecycle completa (appt_lifecycle_cancel_done_apply,
      // allowed-from pending già verificato sopra) — restore riserve incluso.
      try {
        await cancelDoneAppointment(tenantSlug, id, "canceled", session.user.id);
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Operazione non valida" });
      }
      const kind = lifecycleKindForStatusChange("pending", "canceled");
      if (kind) await sendAppointmentLifecycleEmail({ slug: tenantSlug, appointmentId: id, kind });
      await automationScheduleReminder(tenantSlug, id);
      return Response.json({ ok: true, message: "Appuntamento annullato" });
    }

    // Fallback legacy (notifications.php 145): qualsiasi altro POST.
    return jsonError("Operazione non valida", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore notifiche.");
  }
}
