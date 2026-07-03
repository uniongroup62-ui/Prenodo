import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";
import { normalizeSmsRecipient } from "@/lib/sms";

// Port fedele dello scheduling promemoria legacy (Helpers.php
// automation_schedule_reminder ~9315-9413 + automation_clear_pending_reminders
// ~9304) e del salvataggio impostazioni della pagina Automazione
// (app/pages/automation.php 24-71 + automation_save_settings ~7873-7919).
//
// Nel legacy le righe `reminders` (email+sms) vengono PRE-SCHEDULATE alla
// creazione/approvazione/modifica dell'appuntamento; il cron si limita a
// inviare le righe pending scadute. Senza questo modulo il cron Next non
// avrebbe mai nulla da inviare.

// Stati che il legacy considera "prenotato" ai fini dei promemoria
// (normalizzazione LOWER(TRIM(status))).
const SCHEDULED_STATUS_SET = new Set([
  "scheduled",
  "prenotato",
  "prenotata",
  "confirmed",
  "confermato",
  "confermata",
]);

const REMINDER_HOUR_CHOICES = new Set([3, 6, 12, 24, 48]);

// Ore promemoria valide: 3/6/12/24/48, altrimenti il fallback (24 nel legacy).
export function normalizeReminderHours(raw: unknown, fallback = 24): number {
  const value = Math.trunc(Number(raw) || 0);
  return REMINDER_HOUR_CHOICES.has(value) ? value : fallback;
}

async function automationSettingsRow(slug: string): Promise<RowDataPacket | null> {
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "automation_settings", orderBy: "id ASC", limit: 1 });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

type ReminderScope = { name: string; clause: string; params: unknown[] };

async function remindersScope(slug: string): Promise<ReminderScope | null> {
  try {
    const table = await tenantTable(slug, "reminders");
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      return { name: table.name, clause: " AND tenant_id = ?", params: [table.tenantId] };
    }
    return { name: table.name, clause: "", params: [] };
  } catch {
    return null;
  }
}

// Cancella le righe pending di un canale (o di entrambi) per un appuntamento.
async function deletePendingChannel(scope: ReminderScope, appointmentId: number, channel?: "email" | "sms"): Promise<void> {
  const channelClause = channel ? " AND channel = ?" : "";
  const params: unknown[] = [appointmentId, ...(channel ? [channel] : []), ...scope.params];
  await dbExecute(
    `DELETE FROM \`${scope.name}\` WHERE appointment_id = ? AND status = 'pending'${channelClause}${scope.clause}`,
    params,
  ).catch(() => undefined);
}

// Upsert legacy: una sola riga pending per (appuntamento, canale) — aggiorna
// la scheduled_at se esiste, altrimenti inserisce.
async function upsertPendingReminder(slug: string, scope: ReminderScope, appointmentId: number, channel: "email" | "sms", scheduledAt: Date): Promise<void> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id FROM \`${scope.name}\` WHERE appointment_id = ? AND channel = ? AND status = 'pending'${scope.clause} ORDER BY id ASC LIMIT 1`,
    [appointmentId, channel, ...scope.params],
  );
  if (rows[0]) {
    await dbExecute(
      `UPDATE \`${scope.name}\` SET scheduled_at = ?, last_error = NULL WHERE id = ?${scope.clause}`,
      [scheduledAt, Number(rows[0].id), ...scope.params],
    );
    return;
  }
  const table = await tenantTable(slug, "reminders");
  await tenantInsert(table, {
    appointment_id: appointmentId,
    channel,
    scheduled_at: scheduledAt,
    status: "pending",
  });
}

// Port di automation_schedule_reminder($apptId): (ri)schedula i promemoria
// email/SMS di un appuntamento. Se l'appuntamento non e' in stato "prenotato"
// le righe pending vengono cancellate (come su annullo/rifiuto). Best-effort:
// non lancia mai (un problema promemoria non deve far fallire il salvataggio).
export async function automationScheduleReminder(slug: string, appointmentId: number): Promise<void> {
  if (!appointmentId) return;
  try {
    const scope = await remindersScope(slug);
    if (!scope) return;

    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id, starts_at, status, client_id",
      where: "id = ?",
      params: [appointmentId],
      limit: 1,
    });
    const appointment = rows[0];
    if (!appointment) {
      await deletePendingChannel(scope, appointmentId);
      return;
    }

    const status = String(appointment.status ?? "").trim().toLowerCase();
    if (!SCHEDULED_STATUS_SET.has(status)) {
      await deletePendingChannel(scope, appointmentId);
      return;
    }

    const startsAt = appointment.starts_at ? new Date(appointment.starts_at as string | number | Date) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) return;

    const clientRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "clients",
      columns: "id, email, phone",
      where: "id = ?",
      params: [Number(appointment.client_id ?? 0)],
      limit: 1,
    });
    const client = clientRows[0] ?? null;
    const clientEmail = String(client?.email ?? "").trim();
    const clientPhone = normalizeSmsRecipient(String(client?.phone ?? ""));

    const settings = await automationSettingsRow(slug);
    const emailHours = normalizeReminderHours(settings?.reminder_hours);
    const smsHours = normalizeReminderHours(settings?.sms_reminder_hours, emailHours);

    // scheduled_at = inizio - ore; se gia' passato -> ora + 5 minuti (legacy).
    const targetFor = (hours: number): Date => {
      const target = new Date(startsAt.getTime() - hours * 3_600_000);
      return target.getTime() <= Date.now() ? new Date(Date.now() + 300_000) : target;
    };

    if (clientEmail) {
      await upsertPendingReminder(slug, scope, appointmentId, "email", targetFor(emailHours));
    } else {
      await deletePendingChannel(scope, appointmentId, "email");
    }

    if (clientPhone) {
      await upsertPendingReminder(slug, scope, appointmentId, "sms", targetFor(smsHours));
    } else {
      await deletePendingChannel(scope, appointmentId, "sms");
    }
  } catch {
    // best-effort
  }
}

// Port di automation_clear_pending_reminders($apptId) — usato su delete.
export async function automationClearPendingReminders(slug: string, appointmentId: number): Promise<void> {
  if (!appointmentId) return;
  const scope = await remindersScope(slug);
  if (!scope) return;
  await deletePendingChannel(scope, appointmentId);
}

export type AutomationSettingsView = {
  reminder_enabled: boolean;
  reminder_hours: number;
  sms_reminder_enabled: boolean;
  sms_reminder_hours: number;
  approved_enabled: boolean;
  modified_enabled: boolean;
  rejected_enabled: boolean;
  fidelity_expiry_reminder_enabled: boolean;
  installment_alert_days: number;
  client_birthday_alert_days: number;
};

export async function getAutomationSettings(slug: string): Promise<AutomationSettingsView> {
  const row = await automationSettingsRow(slug);
  const flag = (value: unknown, fallback: number) => Number(value ?? fallback) === 1;
  return {
    reminder_enabled: flag(row?.reminder_enabled, 1),
    reminder_hours: normalizeReminderHours(row?.reminder_hours),
    sms_reminder_enabled: flag(row?.sms_reminder_enabled, 0),
    sms_reminder_hours: normalizeReminderHours(row?.sms_reminder_hours, normalizeReminderHours(row?.reminder_hours)),
    approved_enabled: flag(row?.approved_enabled, 1),
    modified_enabled: flag(row?.modified_enabled, 1),
    rejected_enabled: flag(row?.rejected_enabled, 1),
    fidelity_expiry_reminder_enabled: flag(row?.fidelity_expiry_reminder_enabled, 0),
    installment_alert_days: Math.max(0, Math.min(365, Math.trunc(Number(row?.installment_alert_days ?? 7) || 0))),
    client_birthday_alert_days: Math.max(0, Math.min(365, Math.trunc(Number(row?.client_birthday_alert_days ?? 7) || 0))),
  };
}

// Port di client_birthday_notification_set_days (Helpers.php 7471-7495, usato
// da notifications_birthdays.php action=save_settings): clamp 0..365 e scrive
// automation_settings.client_birthday_alert_days sull'unica riga del tenant.
export async function saveClientBirthdayAlertDays(slug: string, days: number): Promise<number> {
  const clamped = Math.max(0, Math.min(365, Math.round(Number(days) || 0)));
  const table = await tenantTable(slug, "automation_settings");
  if (!(await columnExists(table.name, "client_birthday_alert_days"))) return clamped;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "automation_settings", columns: "id", orderBy: "id ASC", limit: 1 });
  if (rows[0]) {
    const params: unknown[] = [clamped, Number(rows[0].id)];
    let clause = "id = ?";
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      clause += " AND tenant_id = ?";
      params.push(table.tenantId);
    }
    await dbExecute(`UPDATE \`${table.name}\` SET client_birthday_alert_days = ? WHERE ${clause}`, params);
  } else {
    await tenantInsert(table, { client_birthday_alert_days: clamped });
  }
  return clamped;
}

// Port del save della pagina Automazione (automation.php 24-71): persiste i
// toggle + le ore promemoria (3/6/12/24/48), forza il sender SMS a 'Prenodo'
// come il legacy, poi RISCHEDULA tutti i promemoria degli appuntamenti futuri
// in stato prenotato (automation.php 57-68). I subject/body NON sono
// modificabili dall'utente nel legacy (vengono sempre riscritti coi default di
// sistema); il Next li genera dal codice, quindi qui non li tocchiamo.
export async function saveAutomationSettings(slug: string, body: Record<string, unknown>): Promise<AutomationSettingsView> {
  const isOn = (value: unknown) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

  const reminderHours = normalizeReminderHours(body.reminder_hours);
  const values: Record<string, unknown> = {
    reminder_enabled: isOn(body.reminder_enabled) ? 1 : 0,
    reminder_hours: reminderHours,
    approved_enabled: isOn(body.approved_enabled) ? 1 : 0,
    modified_enabled: isOn(body.modified_enabled) ? 1 : 0,
    rejected_enabled: isOn(body.rejected_enabled) ? 1 : 0,
    sms_reminder_enabled: isOn(body.sms_reminder_enabled) ? 1 : 0,
    sms_reminder_hours: normalizeReminderHours(body.sms_reminder_hours, reminderHours),
    sms_reminder_sender: "Prenodo",
  };
  // Il toggle Fidelity viene toccato solo se il form lo invia (nel legacy e'
  // disabilitato finche' validita' tessera + finestra rinnovo non sono configurate).
  if (body.fidelity_expiry_reminder_enabled !== undefined) {
    values.fidelity_expiry_reminder_enabled = isOn(body.fidelity_expiry_reminder_enabled) ? 1 : 0;
  }

  const table = await tenantTable(slug, "automation_settings");
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (await columnExists(table.name, key)) filtered[key] = value;
  }

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "automation_settings", columns: "id", orderBy: "id ASC", limit: 1 });
  if (rows[0]) {
    const sets = Object.keys(filtered).map((key) => `\`${key}\` = ?`).join(", ");
    const params: unknown[] = [...Object.values(filtered), Number(rows[0].id)];
    let clause = "id = ?";
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      clause += " AND tenant_id = ?";
      params.push(table.tenantId);
    }
    await dbExecute(`UPDATE \`${table.name}\` SET ${sets} WHERE ${clause}`, params);
  } else {
    await tenantInsert(table, filtered);
  }

  // Rischedula i promemoria di tutti gli appuntamenti futuri "prenotati"
  // (automation.php 57-68) cosi' le nuove ore hanno effetto immediato.
  try {
    const future = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id",
      where: "LOWER(TRIM(COALESCE(status,''))) IN ('scheduled','prenotato','prenotata','confirmed','confermato','confermata') AND starts_at > NOW()",
      orderBy: "starts_at ASC",
    });
    for (const row of future) {
      await automationScheduleReminder(slug, Number(row.id));
    }
  } catch {
    // best-effort
  }

  return getAutomationSettings(slug);
}
