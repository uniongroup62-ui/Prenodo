import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";
import { normalizeSmsRecipient } from "@/lib/sms";
import { businessNowDateTime } from "@/lib/business-datetime";
import { fidelityCardExpiryReminderConfig } from "@/lib/manage-feature-settings";

// Port fedele dello scheduling promemoria legacy (Helpers.php
// automation_schedule_reminder ~9315-9413 + automation_clear_pending_reminders
// ~9304) e del salvataggio impostazioni della pagina Automazione
// (app/pages/automation.php 24-71 + automation_save_settings ~7873-7919).
//
// Nel legacy le righe `reminders` (email+sms) vengono PRE-SCHEDULATE alla
// creazione/approvazione/modifica dell'appuntamento; il cron si limita a
// inviare le righe pending scadute. Senza questo modulo il cron Next non
// avrebbe mai nulla da inviare.

// Stati che il legacy considera "prenotato" ai fini dei promemoria: la
// normalizzazione per-appuntamento usa appt_norm_status (Helpers.php 9758),
// che mappa a 'scheduled' ANCHE 'approved' e 'booked' (la query di
// rischedulazione di automation.php resta invece sui 6 alias storici).
const SCHEDULED_STATUS_SET = new Set([
  "scheduled",
  "prenotato",
  "prenotata",
  "confirmed",
  "confermato",
  "confermata",
  "approved",
  "booked",
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

// scheduled_at ESPLICITO in ora locale (stringa): un Date passato al driver pg
// verrebbe serializzato con offset e il comportamento dipenderebbe dal cast —
// la stringa wall-time locale è deterministica come il date() del PHP.
function sqlLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Upsert legacy: una sola riga pending per (appuntamento, canale) — aggiorna
// la scheduled_at se esiste, altrimenti inserisce.
async function upsertPendingReminder(slug: string, scope: ReminderScope, appointmentId: number, channel: "email" | "sms", scheduledAt: Date): Promise<void> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id FROM \`${scope.name}\` WHERE appointment_id = ? AND channel = ? AND status = 'pending'${scope.clause} ORDER BY id ASC LIMIT 1`,
    [appointmentId, channel, ...scope.params],
  );
  if (rows[0]) {
    // Reset COMPLETO dei campi provider come il legacy (Helpers.php 9366-9380):
    // la riga pending riutilizzata riparte pulita da un eventuale invio prima.
    await dbExecute(
      `UPDATE \`${scope.name}\` SET scheduled_at = ?, last_error = NULL, provider = NULL,
              provider_message_id = NULL, provider_state = NULL, provider_price = NULL,
              provider_total_price = NULL, sms_segments = NULL, sms_credits_used = NULL,
              provider_response_json = NULL, delivered_at = NULL, last_checked_at = NULL
        WHERE id = ?${scope.clause}`,
      [sqlLocalDateTime(scheduledAt), Number(rows[0].id), ...scope.params],
    );
    return;
  }
  const table = await tenantTable(slug, "reminders");
  await tenantInsert(table, {
    appointment_id: appointmentId,
    channel,
    scheduled_at: sqlLocalDateTime(scheduledAt),
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

    // Gate legacy (automation_schedule_reminder 9317-9322): con ENTRAMBI i
    // toggle spenti le pending vengono CANCELLATE, non lasciate in coda.
    // automation_kind_enabled('reminder'): riga/valore assente → attivo;
    // il toggle SMS invece è spento di default.
    const settings = await automationSettingsRow(slug);
    const emailEnabled = !settings || settings.reminder_enabled == null
      ? true
      : Number(settings.reminder_enabled) === 1;
    const smsEnabled = Boolean(settings && Number(settings.sms_reminder_enabled ?? 0) === 1);
    if (!emailEnabled && !smsEnabled) {
      await deletePendingChannel(scope, appointmentId);
      return;
    }

    const status = String(appointment.status ?? "").trim().toLowerCase();
    if (!SCHEDULED_STATUS_SET.has(status)) {
      await deletePendingChannel(scope, appointmentId);
      return;
    }

    const startsAt = appointment.starts_at ? new Date(appointment.starts_at as string | number | Date) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) {
      // strtotime falsy → il legacy cancella le pending e esce (9345-9348).
      await deletePendingChannel(scope, appointmentId);
      return;
    }

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

    const emailHours = normalizeReminderHours(settings?.reminder_hours);
    const smsHours = normalizeReminderHours(settings?.sms_reminder_hours, emailHours);

    // scheduled_at = inizio - ore; se gia' passato -> ora + 5 minuti (legacy).
    const targetFor = (hours: number): Date => {
      const target = new Date(startsAt.getTime() - hours * 3_600_000);
      return target.getTime() <= Date.now() ? new Date(Date.now() + 300_000) : target;
    };

    if (emailEnabled && clientEmail) {
      await upsertPendingReminder(slug, scope, appointmentId, "email", targetFor(emailHours));
    } else {
      await deletePendingChannel(scope, appointmentId, "email");
    }

    if (smsEnabled && clientPhone) {
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

// Testi di sistema (automation_default_* in Helpers.php 7033-7110): il legacy
// li RISCRIVE nel DB a ogni salvataggio della pagina (automation.php 30-51,
// subject/body non modificabili dall'utente) — replicati byte-identici.
const AUTOMATION_DEFAULT_TEXTS: Record<string, string> = {
  approved_subject: "Appuntamento approvato",
  approved_body: "{{client_greeting}}\n\nil tuo appuntamento è stato approvato.\n{{appointment_summary}}\n{{support_contact_notice}}\n\nSaluti,\n{{business_name}}",
  modified_subject: "Appuntamento modificato",
  modified_body: "{{client_greeting}}\n\nil tuo appuntamento è stato modificato.\n{{appointment_summary}}\n{{support_contact_notice}}\n\nSaluti,\n{{business_name}}",
  rejected_subject: "Appuntamento rifiutato",
  rejected_body: "{{client_greeting}}\n\npurtroppo non possiamo confermare l'appuntamento richiesto.\n{{support_contact_notice}}\n\nSaluti,\n{{business_name}}",
  reminder_subject: "Promemoria appuntamento",
  reminder_body: "{{client_greeting}}\n\n{{email_reminder_details}}\n\nSaluti,\n{{business_name}}",
  sms_reminder_body: "{{client_greeting}} ti ricordiamo l'appuntamento da {{location_name}} il {{start_date}} alle {{start_time}}. {{sms_booking_cancellation_notice}} {{sms_support_contact_notice}}",
  fidelity_expiry_reminder_subject: "La tua tessera Fidelity sta per scadere",
  fidelity_expiry_reminder_body: "{{client_greeting}}\n\nla tua tessera Fidelity {{card_code}} scade il {{card_expires_at}}.\nPer mantenerla attiva, effettua un acquisto o completa un appuntamento entro il {{card_expires_at}}.\nIl rinnovo verrà applicato automaticamente.\n\nSaluti,\n{{business_name}}",
};

// Port del save della pagina Automazione (automation.php 24-71): persiste i
// toggle + le ore promemoria (3/6/12/24/48), forza il sender SMS a 'Prenodo'
// e riscrive subject/body coi default di sistema come il legacy, poi
// RISCHEDULA tutti i promemoria degli appuntamenti futuri in stato prenotato
// (automation.php 57-68).
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
    ...AUTOMATION_DEFAULT_TEXTS,
  };
  // Guardia legacy (automation.php 48): il toggle Fidelity viene salvato a 1
  // SOLO se durata tessera + finestra rinnovo sono configurate; il POST del
  // form legacy è sempre completo, quindi il flag viene azzerato se assente.
  const fidelityConfig = await fidelityCardExpiryReminderConfig(slug).catch(() => ({ configOk: false, validityLabel: "0 giorni", windowLabel: "0 giorni" }));
  values.fidelity_expiry_reminder_enabled = fidelityConfig.configOk && isOn(body.fidelity_expiry_reminder_enabled) ? 1 : 0;

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
    // TZ: starts_at è app-locale (Rome) — confine col "now" locale, MAI NOW()
    // del DB (UTC): la finestra futura sarebbe sfasata di 2 ore.
    const future = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id",
      where: "LOWER(TRIM(COALESCE(status,''))) IN ('scheduled','prenotato','prenotata','confirmed','confermato','confermata') AND starts_at > ?",
      params: [businessNowDateTime()],
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

// ---------------------------------------------------------------------------
// Contesto della PAGINA Automazione (automation.php 10-130): saldo crediti
// SMS, esempi email/SMS costruiti con la cancel policy del booking, conteggio
// segmenti, pacchetti SMS del listino centrale e config Fidelity.
// ---------------------------------------------------------------------------

// Port di sms_credit_segment_count (Helpers.php 9193-9226): GSM-7 basic (1
// unità) + extended (2 unità); non-GSM → UCS-2 (70/67 per segmento).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

export function smsSegmentCount(message: string): number {
  const text = message.trim();
  if (text === "") return 0;
  let gsmUnits = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) gsmUnits += 1;
    else if (GSM_EXTENDED.includes(ch)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
  const len = Array.from(text).length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

// number_format legacy (virgola decimali, punto migliaia) + valuta.
function smsMoney(value: number, currency = "EUR", decimals = 2): string {
  const fixed = Number(value || 0).toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped},${decPart} ${(currency.slice(0, 3) || "EUR").toUpperCase()}`;
}

export type AutomationPageContext = {
  businessName: string;
  smsCreditBalance: number;
  emailCancellationNotice: string;
  smsExampleText: string;
  smsExampleSegments: number;
  smsExampleCreditsLabel: string;
  fidelity: { configOk: boolean; validityLabel: string; windowLabel: string };
  smsPlans: Array<{
    id: number;
    name: string;
    credits: number;
    priceLabel: string;
    pricePerCreditLabel: string;
    description: string;
    isFeatured: boolean;
  }>;
  smsDefaultPlanId: number;
  smsPlansError: string;
};

export async function getAutomationPageContext(slug: string): Promise<AutomationPageContext> {
  const bizRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "name, booking_customer_cancel_enabled, booking_customer_cancel_before_value, booking_customer_cancel_before_unit",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? ({} as RowDataPacket);
  const businessName = String(biz.name ?? "").trim() || "La mia attivita";

  // booking_customer_cancel_policy (Helpers.php 5384-5416) → gli avvisi di
  // annullo negli esempi email/SMS (automation.php 75-98).
  let emailCancellationNotice = "";
  let smsCancellationNotice = "";
  if (Number(biz.booking_customer_cancel_enabled ?? 0) === 1) {
    let value = Math.max(0, Math.trunc(Number(biz.booking_customer_cancel_before_value ?? 0) || 0));
    let unit = String(biz.booking_customer_cancel_before_unit ?? "hours").trim().toLowerCase();
    if (unit !== "hours" && unit !== "days") unit = "hours";
    if (unit === "days" && value > 365) value = 365;
    if (unit === "hours" && value > 8760) value = 8760;
    const label = value <= 0
      ? "fino all'inizio dell'appuntamento"
      : `${value} ${unit === "days" ? (value === 1 ? "giorno" : "giorni") : (value === 1 ? "ora" : "ore")}`;
    if (value <= 0 || label === "fino all'inizio dell'appuntamento") {
      emailCancellationNotice = "Puoi annullare l'appuntamento fino all'inizio dell'appuntamento.";
      smsCancellationNotice = "Annulla fino all'inizio.";
    } else {
      emailCancellationNotice = `Puoi annullare l'appuntamento fino a ${label} prima.`;
      smsCancellationNotice = `Annulla entro ${label}.`;
    }
  }

  let smsExampleText = "Ciao, ti ricordiamo l'appuntamento da Sede1 il 22/06 alle 09:00.";
  if (smsCancellationNotice !== "") smsExampleText += ` ${smsCancellationNotice}`;
  smsExampleText += " Non rispondere a questo SMS. Per assistenza: 3756266694.";
  const smsExampleSegments = Math.max(1, smsSegmentCount(smsExampleText));

  // sms_credit_wallet_row: prima riga wallet del tenant (0 se assente).
  const walletRows = await tenantSelect<RowDataPacket>({ slug, table: "sms_credit_wallet", columns: "balance_credits", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const smsCreditBalance = Math.max(0, Number(walletRows[0]?.balance_credits ?? 0) || 0);

  // SaasSmsBilling::plans(false): listino centrale attivo, featured in testa
  // come default; prezzi formattati come il legacy ($smsMoney).
  let smsPlans: AutomationPageContext["smsPlans"] = [];
  let smsPlansError = "";
  try {
    // SaasSmsBilling::plans(false): ORDER BY sort_order, credits, id (156).
    const rows = await dbQuery<RowDataPacket[]>(
      "SELECT id, name, credits, price_gross, currency, is_featured, description FROM saas_sms_plans WHERE is_active=1 ORDER BY sort_order ASC, credits ASC, id ASC",
    );
    smsPlans = rows.map((row) => {
      const credits = Math.max(1, Number(row.credits ?? 0) || 0);
      const price = Number(row.price_gross ?? 0) || 0;
      const currency = String(row.currency ?? "EUR");
      return {
        id: Number(row.id ?? 0),
        name: String(row.name ?? ""),
        credits,
        priceLabel: smsMoney(price, currency),
        pricePerCreditLabel: smsMoney(credits > 0 ? price / credits : 0, currency, 4),
        description: String(row.description ?? ""),
        isFeatured: Number(row.is_featured ?? 0) === 1,
      };
    });
  } catch {
    smsPlansError = "Pacchetti SMS momentaneamente non disponibili.";
  }
  let smsDefaultPlanId = smsPlans.find((plan) => plan.isFeatured)?.id ?? 0;
  if (smsDefaultPlanId <= 0 && smsPlans.length) smsDefaultPlanId = smsPlans[0].id;

  const fidelity = await fidelityCardExpiryReminderConfig(slug).catch(() => ({ configOk: false, validityLabel: "0 giorni", windowLabel: "0 giorni" }));

  return {
    businessName,
    smsCreditBalance,
    emailCancellationNotice,
    smsExampleText,
    smsExampleSegments,
    smsExampleCreditsLabel: smsExampleSegments === 1 ? "1 credito" : `${smsExampleSegments} crediti`,
    fidelity,
    smsPlans,
    smsDefaultPlanId,
    smsPlansError,
  };
}
