import { activeTenantSlugs, assertCronAuth, trackCronResponse } from "@/lib/cron";
import { businessNowDateTime } from "@/lib/business-datetime";
import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";
import { sendSmsItaly, smsConfigured } from "@/lib/sms";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/reminders.php (the biggest legacy cron). Per active tenant it:
//   (a) selects due APPOINTMENT reminders (email + SMS) from `reminders` whose
//       linked appointment is still 'scheduled' and whose client has the right
//       contact, honouring the automation_settings reminder toggles, and would
//       mark them sent;
//   (b) syncs expired fidelity cards to 'inactive', queues FIDELITY card-expiry
//       reminders (renewal-window opening) into `card_reminders`, then selects
//       the due ones and would send them;
//   (c) cleans up old history rows in reminders / card_reminders /
//       communication_logs.
//
// MySQL -> Postgres notes: NOW() kept, CURDATE()/date('Y-m-d') -> CURRENT_DATE,
// DATE_ADD/SUB -> `x + (n * interval '1 day')`. Every statement is scoped by
// `tenant_id = ?` (tenantId from tenantIdForSlug(slug)).
//
// Outbound dispatch IS now wired. Email goes through lib/email.ts (SES port of
// mail_send_html inside automation_send_email / automation_send_fidelity_expiry_email);
// SMS goes through lib/sms.ts (OpenAPI port of automation_send_sms_reminder /
// OpenApiSms). The PHP marks a reminder row 'sent' ONLY AFTER a successful
// provider send — we keep that SAFE semantics: we build the message (faithful
// port of the legacy templates), call sendEmail/sendSmsItaly, and run the
// "mark sent" UPDATE only on {ok:true}. On a failed send we write the PHP-style
// failure status (last_error, and for SMS the provider columns) and do NOT mark
// sent, so the row stays eligible for the next run.
//
// Sending is gated by provider configuration, NOT a hard-coded flag:
//  - email sends only when emailConfigured() (SES_FROM_EMAIL set);
//  - SMS sends only when smsConfigured() (OpenAPI token set + enabled).
// When a channel's provider is NOT configured we short-circuit exactly like the
// old SEND_ENABLED=false behaviour: report the due items, mark nothing. Other
// bookkeeping (toggle-off cleanup, expired-card sync, queueing of new
// card_reminders, history cleanup) is always performed live.
const SELECT_LIMIT = 50;

const CLEANUP_DAYS = 30;

type AutomationSettings = RowDataPacket & {
  id: number;
  reminder_enabled: number | null;
  sms_reminder_enabled: number | null;
  fidelity_expiry_reminder_enabled: number | null;
};

// Business settings (legacy setting_get('name'|'email'|'phone') reads the first
// businesses row; here scoped per tenant). The email logo is filesystem-derived
// in PHP (business_logo_absolute_url) — not resolvable in this cron context — so
// we leave it empty (see TODO at buildEmailTemplateOpts).
type BusinessSettings = RowDataPacket & {
  name: string | null;
  email: string | null;
  phone: string | null;
};

// Appointment fields needed by the reminder templates (subset of PHP
// appointment_details: date/time, client name/contact, resolved location, and
// the service names — service_summary/service_list).
type DueAppointmentReminder = RowDataPacket & {
  reminder_id: number;
  appointment_id: number;
  scheduled_at: string;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  location_name: string | null;
  location_phone: string | null;
  service_names: string | null;
};

type FidelityCardRow = RowDataPacket & {
  id: number;
  client_id: number;
  expires_at: string | null;
  client_email: string | null;
};

type DueCardReminder = RowDataPacket & {
  id: number;
  card_id: number;
  client_id: number;
  card_code: string | null;
  card_status: string | null;
  card_expires_at: string;
  client_name: string | null;
  client_email: string | null;
};

type TenantResult = {
  tenant: string;
  fidCardsExpired: number;
  appointmentReminderEnabled: boolean;
  smsReminderEnabled: boolean;
  fidelityExpiryReminderEnabled: boolean;
  emailProviderConfigured: boolean;
  smsProviderConfigured: boolean;
  dueAppointmentReminders: Array<{ reminderId: number; appointmentId: number; email: string }>;
  dueAppointmentSmsReminders: Array<{ reminderId: number; appointmentId: number; phone: string }>;
  fidelityQueued: number;
  dueCardReminders: Array<{ id: number; cardId: number; clientId: number; expiresAt: string; email: string }>;
  cleanup: { reminders: number; cardReminders: number; communicationLogs: number };
  sent: number;
  failed: number;
  skipped: number;
};

// PHP appt_norm_status(): normalize an appointment status to its canonical code.
// We only need to know whether it is 'scheduled' (the only status that keeps a
// reminder eligible); everything else is treated as not-scheduled.
function isScheduled(status: string | null): boolean {
  let s = String(status ?? "").trim().toLowerCase();
  if (s === "cancelled") s = "canceled";
  if (["annullato", "annullata", "cancellato", "cancellata", "rifiutato", "rifiutata", "rejected"].includes(s)) {
    s = "canceled";
  }
  return s === "scheduled";
}

// Faithful (minus the deep clamp binary-search) port of
// fidelity_card_renewal_window_config(): reads businesses.fidelity_adhesion_json
// and derives whether the renewal-window reminder is active plus the window
// value/unit. Returns value 0 when the feature is off, which gates the whole
// fidelity queue (PHP: `if (windowCfg.value <= 0) return 0`).
//
// NOTE: the PHP clamps the renewal window so it stays strictly smaller than the
// card validity (fidelity_card_clamp_renewal_window_config, a binary search). We
// keep the configured value as-is here; this only matters once a tenant actually
// stores a renewal window (currently fidelity_adhesion_json is null for live
// tenants, so the feature is off and value is 0). See TODO below.
function renewalWindowConfig(adhesionJson: string | null): { value: number; unit: string } {
  let dec: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(adhesionJson ?? ""));
    if (parsed && typeof parsed === "object") dec = parsed as Record<string, unknown>;
  } catch {
    dec = {};
  }

  const validityValue = normalizeDuration(dec.card_default_validity_value, dec.card_default_validity_unit);
  const expiryEnabled =
    "card_expiry_enabled" in dec ? Boolean(dec.card_expiry_enabled) : validityValue.value > 0;

  const storedEnabled =
    "renewal_enabled" in dec ? Boolean(dec.renewal_enabled) : Number(dec.renewal_window_value ?? 0) > 0;

  const stored = normalizeDuration(dec.renewal_window_value, dec.renewal_window_unit);

  // TODO: port fidelity_card_clamp_renewal_window_config (clamp the window to be
  // strictly smaller than the card validity) if a tenant ever configures one.
  const effectiveEnabled = expiryEnabled && storedEnabled && validityValue.value > 0;
  return {
    value: effectiveEnabled ? stored.value : 0,
    unit: effectiveEnabled ? stored.unit : "days",
  };
}

function normalizeDuration(value: unknown, unit: unknown): { value: number; unit: string } {
  let v = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(v) || v < 0) v = 0;
  if (v > 36500) v = 36500;
  let u = String(unit ?? "days").trim().toLowerCase();
  if (!["days", "months", "years"].includes(u)) u = "days";
  return { value: v, unit: u };
}

// PHP fidelity_card_add_duration_ymd($expiresAt, -window, $unit): the start of
// the renewal window. days -> subtract days; months/years -> subtract whole
// months with day clamping (app_add_months_clamped_ymd).
function subtractDuration(ymd: string, value: number, unit: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  if (unit === "months" || unit === "years") {
    const months = unit === "years" ? value * 12 : value;
    return addMonthsClamped(y, mo, d, -months);
  }
  // days
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - value);
  return `${dt.getUTCFullYear().toString().padStart(4, "0")}-${(dt.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${dt.getUTCDate().toString().padStart(2, "0")}`;
}

// PHP app_add_months_clamped_ymd(): add (possibly negative) months, clamping the
// day to the last day of the resulting month.
function addMonthsClamped(y: number, mo: number, d: number, months: number): string {
  let total = y * 12 + (mo - 1) + months;
  if (total < 0) total = 0;
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nmo, 0)).getUTCDate(); // last day of month
  const nd = Math.min(d, dim);
  return `${ny.toString().padStart(4, "0")}-${nmo.toString().padStart(2, "0")}-${nd
    .toString()
    .padStart(2, "0")}`;
}

// --- Legacy template ports (app/lib/Helpers.php) ---------------------------
//
// These reproduce the message bodies the PHP automation builds so the emails/SMS
// render identically. Placeholder substitution mirrors render_template() /
// render_template_text() (str_replace of {{key}}), but since we resolve every
// placeholder eagerly here we just build the final strings directly.

// PHP h(): htmlspecialchars(ENT_QUOTES). Used in the HTML email body so client /
// business names are escaped exactly as render_template fed them in.
function h(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// PHP automation_template_vars_text()'s $clean(): decode entities, strip tags,
// collapse whitespace. Used for SMS text fields (no HTML).
function cleanText(value: string): string {
  let s = String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

// PHP automation_compact_email_body(): normalise newlines and trim.
function compactEmailBody(body: string): string {
  let s = String(body ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// PHP date('d/m') / date('H:i') over a stored "YYYY-MM-DD HH:MM:SS" string.
// Timestamps come back as raw strings (pg dateStrings), so we parse the literal
// fields without a timezone shift, matching the legacy behaviour.
function fmtDateDM(raw: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? "").trim());
  return m ? `${m[3]}/${m[2]}` : "";
}
function fmtTimeHM(raw: string | null): string {
  const m = /\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(String(raw ?? "").trim());
  return m ? `${m[1]}:${m[2]}` : "";
}

// PHP automation_service_summary(): dedup names, join with Italian conjunctions.
function serviceSummary(names: string[]): string {
  const out: string[] = [];
  for (const raw of names) {
    const n = String(raw ?? "").trim();
    if (n === "" || out.includes(n)) continue;
    out.push(n);
  }
  const count = out.length;
  if (count === 0) return "";
  if (count === 1) return out[0];
  if (count === 2) return `${out[0]} e ${out[1]}`;
  if (count === 3) return `${out[0]}, ${out[1]} e ${out[2]}`;
  const remaining = count - 2;
  return `${out[0]}, ${out[1]} e ${remaining === 1 ? "un altro servizio" : `altri ${remaining} servizi`}`;
}

// Split the string_agg'd service names back into an array. The SELECT joins
// them with the \x1f unit separator (see appointmentReminderSelect) so names
// that contain commas stay intact.
function serviceNameList(raw: string | null): string[] {
  return String(raw ?? "")
    .split("\x1f")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// PHP automation_support_contact_notice(): falls back to the business phone.
function supportContactNotice(locationPhone: string, bizPhone: string): string {
  const phone = String(locationPhone || bizPhone || "").trim();
  return phone === "" ? "" : `Per assistenza contattaci al ${phone}.`;
}
// PHP automation_sms_support_contact_notice().
function smsSupportContactNotice(locationPhone: string, bizPhone: string): string {
  const phone = String(locationPhone || bizPhone || "").trim();
  return phone === "" ? "" : `Non rispondere a questo SMS. Per assistenza: ${phone}.`;
}

// PHP automation_email_reminder_details(): the descriptive reminder line plus
// the (optional) support-contact line. NOTE: the cancellation-policy line is
// intentionally omitted — see TODO at buildReminderEmail/Sms.
function emailReminderDetails(args: {
  startsAt: string | null;
  locationName: string;
  serviceNames: string[];
  locationPhone: string;
  bizPhone: string;
}): string {
  const date = fmtDateDM(args.startsAt);
  const time = fmtTimeHM(args.startsAt);
  const summary = serviceSummary(args.serviceNames);

  let line = "ti ricordiamo il tuo appuntamento";
  if (args.locationName.trim() !== "") line += ` presso ${args.locationName.trim()}`;
  if (date !== "") line += ` il ${date}`;
  if (time !== "") line += ` alle ${time}`;
  if (summary !== "") line += ` per ${summary}`;
  line += ".";

  const lines = [line];
  const support = supportContactNotice(args.locationPhone, args.bizPhone);
  if (support !== "") lines.push(support);
  return lines.join("\n");
}

// PHP setting_get('name','La mia attività') default.
const DEFAULT_BIZ_NAME = "La mia attività";

// Build the buildModernEmailTemplate() opts from the per-tenant business row.
// TODO: business_logo_url — PHP derives it from the uploaded-file mtime via
// business_logo_absolute_url(); there is no host/filesystem to resolve that in
// the cron, so we send the email without a logo (the template renders the brand
// name instead, identical to the no-logo PHP path).
function buildEmailTemplateOpts(biz: BusinessSettings | undefined) {
  return {
    business_name: String(biz?.name ?? "") || DEFAULT_BIZ_NAME,
    business_email: String(biz?.email ?? ""),
    business_logo_url: "",
  };
}

// Port of automation_send_email('reminder', ...): subject + compact HTML body.
// Reminder subject = 'Promemoria appuntamento'. Reminder body template =
// "{{client_greeting}}\n\n{{email_reminder_details}}\n\nSaluti,\n{{business_name}}"
// with client_greeting fixed to "Ciao," (automation_client_greeting).
function buildReminderEmail(
  row: DueAppointmentReminder,
  biz: BusinessSettings | undefined,
): { subject: string; html: string; text: string } {
  const bizName = String(biz?.name ?? "") || DEFAULT_BIZ_NAME;
  const bizPhone = String(biz?.phone ?? "");
  const details = emailReminderDetails({
    startsAt: row.starts_at,
    locationName: String(row.location_name ?? ""),
    serviceNames: serviceNameList(row.service_names),
    locationPhone: String(row.location_phone ?? ""),
    bizPhone,
  });

  // Il body è TESTO SEMPLICE (nessun tag): buildModernEmailTemplate lo escapa
  // già lei (nl2br(h(p))). Pre-escapare qui produceva DOUBLE-ESCAPE: un nome
  // attività "L'Estetica" arrivava al cliente come "L&#039;Estetica" (audit 21/07).
  const subject = "Promemoria appuntamento";
  const body = compactEmailBody(`Ciao,\n\n${details}\n\nSaluti,\n${bizName}`);
  const tpl = buildModernEmailTemplate(subject, body, buildEmailTemplateOpts(biz));
  return { subject, html: tpl.html, text: tpl.text };
}

// Port of automation_send_sms_reminder()'s message build. SMS body template =
// "{{client_greeting}} ti ricordiamo l'appuntamento da {{location_name}} il
// {{start_date}} alle {{start_time}}. {{sms_booking_cancellation_notice}}
// {{sms_support_contact_notice}}". client_greeting = "Ciao,". The cancellation
// notice is omitted (see TODO). normalizeSmsMessage() inside sendSmsItaly will
// collapse the resulting double spaces, matching render_template_text ->
// OpenApiSms::normalizeMessage in the PHP.
function buildReminderSms(row: DueAppointmentReminder, biz: BusinessSettings | undefined): string {
  const bizPhone = String(biz?.phone ?? "");
  const locationName = cleanText(String(row.location_name ?? ""));
  const startDate = fmtDateDM(row.starts_at);
  const startTime = fmtTimeHM(row.starts_at);
  const support = smsSupportContactNotice(String(row.location_phone ?? ""), bizPhone);
  // TODO: {{sms_booking_cancellation_notice}} (automation_sms_booking_cancellation_notice)
  // depends on the customer-cancel policy (businesses.booking_customer_cancel_*);
  // omitted here. Resolve it if cancellation reminders need to be word-identical.
  return `Ciao, ti ricordiamo l'appuntamento da ${locationName} il ${startDate} alle ${startTime}. ${support}`;
}

// Port of automation_send_fidelity_expiry_email(). Subject = 'La tua tessera
// Fidelity sta per scadere'. Body template =
// "{{client_greeting}}\n\nla tua tessera Fidelity {{card_code}} scade il
// {{card_expires_at}}.\nPer mantenerla attiva, effettua un acquisto o completa un
// appuntamento entro il {{card_expires_at}}.\nIl rinnovo verrà applicato
// automaticamente.\n\nSaluti,\n{{business_name}}". automation_fidelity_card_template_vars
// formats card_expires_at as date('d/m').
function buildFidelityEmail(
  row: DueCardReminder,
  biz: BusinessSettings | undefined,
): { subject: string; html: string; text: string } {
  const bizName = String(biz?.name ?? "") || DEFAULT_BIZ_NAME;
  // Testo semplice: l'escaping lo fa buildModernEmailTemplate — niente h() qui
  // (double-escape: "L'Estetica" diventava "L&#039;Estetica", audit 21/07).
  const cardCode = cleanText(String(row.card_code ?? ""));
  const expires = fmtDateDM(row.card_expires_at);
  const subject = "La tua tessera Fidelity sta per scadere";
  const body = compactEmailBody(
    `Ciao,\n\nla tua tessera Fidelity ${cardCode} scade il ${expires}.\n` +
      `Per mantenerla attiva, effettua un acquisto o completa un appuntamento entro il ${expires}.\n` +
      `Il rinnovo verrà applicato automaticamente.\n\nSaluti,\n${bizName}`,
  );
  const tpl = buildModernEmailTemplate(subject, body, buildEmailTemplateOpts(biz));
  return { subject, html: tpl.html, text: tpl.text };
}

// PHP sms_credit_segment_count(): GSM-7 vs UCS-2 segment math. Used to debit the
// SMS credit wallet (1 credit per segment) before sending, matching
// automation_send_sms_reminder.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";
function smsSegmentCount(message: string): number {
  const msg = String(message ?? "").trim();
  if (msg === "") return 0;
  const chars = [...msg];
  let gsmUnits = 0;
  let gsm = true;
  for (const ch of chars) {
    if (GSM_BASIC.includes(ch)) gsmUnits += 1;
    else if (GSM_EXTENDED.includes(ch)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
  const len = chars.length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

// PHP sms_credit_try_debit(): atomically subtract `credits` from the tenant
// wallet, returning whether the debit succeeded. Mirrors the legacy wallet row
// bootstrap (insert a zero-balance row when none exists). Tenant-scoped.
async function smsCreditTryDebit(
  tenantId: number,
  credits: number,
  referenceType: string,
  referenceId: number,
): Promise<{ ok: boolean; balance: number }> {
  const c = Math.max(0, credits);
  if (c <= 0) return { ok: true, balance: await smsCreditBalance(tenantId) };

  const wallet = await smsCreditWalletRow(tenantId);
  const before = Math.max(0, wallet.balance);
  if (wallet.id <= 0 || before < c) return { ok: false, balance: before };

  const upd = await dbExecute(
    `UPDATE sms_credit_wallet
        SET balance_credits = balance_credits - ?
      WHERE tenant_id = ? AND id = ? AND balance_credits >= ?`,
    [c, tenantId, wallet.id, c],
  );
  if (upd.affectedRows <= 0) return { ok: false, balance: await smsCreditBalance(tenantId) };

  const after = await smsCreditBalance(tenantId);
  await smsCreditRecordMovement(tenantId, "send", -c, before, after, referenceType, referenceId);
  return { ok: true, balance: after };
}

// PHP sms_credit_refund(): give the credits back when the provider rejects.
async function smsCreditRefund(
  tenantId: number,
  credits: number,
  referenceType: string,
  referenceId: number,
): Promise<void> {
  const c = Math.max(0, credits);
  if (c <= 0) return;
  const wallet = await smsCreditWalletRow(tenantId);
  if (wallet.id <= 0) return;
  const before = Math.max(0, wallet.balance);
  await dbExecute(`UPDATE sms_credit_wallet SET balance_credits = balance_credits + ? WHERE tenant_id = ? AND id = ?`, [
    c,
    tenantId,
    wallet.id,
  ]);
  await smsCreditRecordMovement(tenantId, "refund", c, before, before + c, referenceType, referenceId);
}

async function smsCreditWalletRow(tenantId: number): Promise<{ id: number; balance: number }> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id, balance_credits FROM sms_credit_wallet WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
    [tenantId],
  );
  if (rows[0]) return { id: Number(rows[0].id ?? 0), balance: Number(rows[0].balance_credits ?? 0) };
  // PHP bootstraps a zero-balance wallet row on first access.
  const ins = await dbExecute(`INSERT INTO sms_credit_wallet (tenant_id, balance_credits) VALUES (?, 0)`, [tenantId]);
  return { id: Number(ins.insertId ?? 0), balance: 0 };
}

async function smsCreditBalance(tenantId: number): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT balance_credits FROM sms_credit_wallet WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
    [tenantId],
  );
  return Math.max(0, Number(rows[0]?.balance_credits ?? 0));
}

async function smsCreditRecordMovement(
  tenantId: number,
  type: string,
  credits: number,
  before: number,
  after: number,
  referenceType: string,
  referenceId: number,
): Promise<void> {
  try {
    await dbExecute(
      `INSERT INTO sms_credit_movements
         (tenant_id, type, credits, balance_before, balance_after, reference_type, reference_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        type.slice(0, 30) || "adjustment",
        credits,
        before,
        after,
        referenceType !== "" ? referenceType.slice(0, 60) : null,
        referenceId > 0 ? referenceId : null,
        "Promemoria SMS appuntamento",
      ],
    );
  } catch {
    // Movement logging must never block the send.
  }
}

// Enriched due-reminder SELECT shared by the email and SMS channels. Mirrors the
// fields automation_send_email/automation_send_sms_reminder pull from
// appointment_details: appointment date/time, client name/contact, the resolved
// location (appointment_locations -> locations, falling back to the business
// name/phone), and the concatenated service names. Tenant-scoped throughout. The
// \x1f unit separator is used as the GROUP-concat delimiter so service names
// containing commas survive the split in serviceNameList().
function appointmentReminderSelect(channel: "email" | "sms"): string {
  return `SELECT r.id AS reminder_id, r.appointment_id, r.scheduled_at,
                 a.status, a.starts_at, a.ends_at,
                 c.full_name AS client_name, c.email AS client_email, c.phone AS client_phone,
                 COALESCE(NULLIF(TRIM(loc.name), ''), b.name) AS location_name,
                 COALESCE(NULLIF(TRIM(loc.phone), ''), NULLIF(TRIM(b.phone), ''), '') AS location_phone,
                 (SELECT string_agg(COALESCE(NULLIF(TRIM(aps.service_name), ''), s.name), E'\\x1f')
                    FROM appointment_services aps
                    JOIN services s ON s.id = aps.service_id AND s.tenant_id = aps.tenant_id
                   WHERE aps.appointment_id = a.id AND aps.tenant_id = a.tenant_id) AS service_names
            FROM reminders r
            JOIN appointments a ON a.id = r.appointment_id AND a.tenant_id = r.tenant_id
            JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
            LEFT JOIN appointment_locations al ON al.appointment_id = a.id AND al.tenant_id = a.tenant_id
            LEFT JOIN locations loc ON loc.id = al.location_id AND loc.tenant_id = a.tenant_id
            LEFT JOIN businesses b ON b.tenant_id = r.tenant_id AND b.id = (
              SELECT MIN(b2.id) FROM businesses b2 WHERE b2.tenant_id = r.tenant_id)
           WHERE r.tenant_id = ?
             AND r.channel='${channel}'
             AND (r.status='pending'
                  OR (r.status='sending' AND r.updated_at < ?))
             AND r.scheduled_at <= ?
           ORDER BY r.scheduled_at ASC
           LIMIT ${SELECT_LIMIT}`;
  // NB TZ: scheduled_at è in ORA LOCALE dell'app (Rome) — il confronto va
  // fatto con businessNowDateTime(), MAI con NOW() del DB (UTC su Supabase:
  // i promemoria partivano con 2 ore di RITARDO).
}

async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const slugs = await activeTenantSlugs();
    const results: TenantResult[] = [];
    let total = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    // Provider gating: a channel only sends when its provider is configured.
    // When unconfigured we behave like the old SEND_ENABLED=false path for that
    // channel — report due items, mark nothing.
    const emailReady = emailConfigured();
    const smsReady = smsConfigured();

    for (const slug of slugs) {
      const result: TenantResult & { error?: string } = {
        tenant: slug,
        fidCardsExpired: 0,
        appointmentReminderEnabled: false,
        smsReminderEnabled: false,
        fidelityExpiryReminderEnabled: false,
        emailProviderConfigured: emailReady,
        smsProviderConfigured: smsReady,
        dueAppointmentReminders: [],
        dueAppointmentSmsReminders: [],
        fidelityQueued: 0,
        dueCardReminders: [],
        cleanup: { reminders: 0, cardReminders: 0, communicationLogs: 0 },
        sent: 0,
        failed: 0,
        skipped: 0,
      };

      // ISOLAMENTO PER-TENANT (audit 21/07): un tenant con dati rotti non deve
      // saltare tutti i successivi (ordine alfabetico) a ogni run — l'errore
      // finisce nel payload del tenant e nel log, il loop prosegue.
      try {
      const tenantId = await tenantIdForSlug(slug);
      if (!tenantId) continue;

      // ----- business settings (legacy setting_get from the businesses row,
      // here scoped per tenant). Supplies name/email/phone for the templates. -----
      const bizSettingsRows = await dbQuery<BusinessSettings[]>(
        `SELECT name, email, phone FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
        [tenantId],
      );
      const bizSettings = bizSettingsRows[0];

      // ----- automation_settings (toggles) -----
      const settingsRows = await dbQuery<AutomationSettings[]>(
        `SELECT id, reminder_enabled, sms_reminder_enabled, fidelity_expiry_reminder_enabled
           FROM automation_settings
          WHERE tenant_id = ?
          ORDER BY id ASC
          LIMIT 1`,
        [tenantId],
      );
      const settings = settingsRows[0];
      // PHP automation_kind_enabled('reminder'/'fidelity...'): a missing column
      // (legacy install) means enabled for reminder; fidelity defaults to off.
      const reminderEnabled = !settings || settings.reminder_enabled == null
        ? true
        : Boolean(settings.reminder_enabled);
      const smsEnabled = Boolean(settings?.sms_reminder_enabled);
      const fidelityEnabled = Boolean(settings?.fidelity_expiry_reminder_enabled);
      result.appointmentReminderEnabled = reminderEnabled;
      result.smsReminderEnabled = smsEnabled;
      result.fidelityExpiryReminderEnabled = fidelityEnabled;

      // ----- expired fidelity cards -> 'inactive' (fidelity_card_sync_expired_statuses) -----
      // Deactivate any card whose expires_at is in the past and that is not
      // already inactive. (PHP also probes alternate columns / releases pending
      // appointment discounts; the live schema uses cards.status + expires_at.)
      const expiredRes = await dbExecute(
        `UPDATE cards
            SET status='inactive'
          WHERE tenant_id = ?
            AND expires_at IS NOT NULL
            AND expires_at < CURRENT_DATE
            AND COALESCE(NULLIF(TRIM(status), ''), 'active') <> 'inactive'`,
        [tenantId],
      );
      result.fidCardsExpired = expiredRes.affectedRows;

      // ----- appointment EMAIL reminders -----
      if (reminderEnabled) {
        const due = await dbQuery<DueAppointmentReminder[]>(
          appointmentReminderSelect("email"),
          [tenantId, claimCutoff(), businessNowDateTime()],
        );

        for (const r of due) {
          const reminderId = Number(r.reminder_id ?? 0);
          const appointmentId = Number(r.appointment_id ?? 0);

          // Appointment no longer scheduled -> mark failed (safe bookkeeping).
          if (!isScheduled(r.status)) {
            await dbExecute(
              `UPDATE reminders SET status='failed', last_error=?, sent_at=NULL
                WHERE tenant_id = ? AND id = ?`,
              [`Appuntamento non schedulato (status=${r.status ?? "n/a"})`, tenantId, reminderId],
            );
            continue;
          }
          // Missing client email -> mark failed (safe bookkeeping).
          if (!String(r.client_email ?? "").trim()) {
            await dbExecute(
              `UPDATE reminders SET status='failed', last_error=?, sent_at=NULL
                WHERE tenant_id = ? AND id = ?`,
              ["Email cliente mancante", tenantId, reminderId],
            );
            continue;
          }

          // Reminder is genuinely due to be sent.
          const to = String(r.client_email).trim();
          result.dueAppointmentReminders.push({ reminderId, appointmentId, email: to });

          // No email provider configured -> behave like the old SEND_ENABLED=false
          // path: leave the row pending (do NOT lose it), just report it.
          if (!emailReady) {
            result.skipped += 1;
            continue;
          }

          // CLAIM atomico anti double-send: un run concorrente non prende la
          // stessa riga (prima due run sovrapposti inviavano DUE email).
          const claim = await dbExecute(
            `UPDATE reminders SET status='sending', updated_at=?
              WHERE tenant_id = ? AND id = ?
                AND (status='pending' OR (status='sending' AND updated_at < ?))`,
            [businessNowDateTime(), tenantId, reminderId, claimCutoff()],
          );
          if (claim.affectedRows <= 0) continue;

          // Port of automation_send_email('reminder', appointmentId): build the
          // subject/body, send via SES. Mark 'sent' ONLY on a successful send.
          const msg = buildReminderEmail(r, bizSettings);
          // Pattern SES: From verificato + fromName attività + replyTo attività
          // (un fromEmail tenant non verificato viene RIFIUTATO da SES).
          const sendRes = await sendEmail({
            to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            fromName: String(bizSettings?.name ?? "") || undefined,
            replyTo: String(bizSettings?.email ?? "").trim() || undefined,
          });

          if (sendRes.ok) {
            await dbExecute(
              `UPDATE reminders SET status='sent', sent_at=?, last_error=NULL
                WHERE tenant_id = ? AND id = ?`,
              [businessNowDateTime(), tenantId, reminderId],
            );
            result.sent += 1;
          } else {
            // Errore TRANSIENTE (throttling/rete) -> la riga TORNA pending e
            // viene ritentata al giro dopo; permanente -> failed definitivo.
            const errText = `Invio email fallito: ${sendRes.error ?? "errore provider"}`;
            const nextStatus = isTransientSendError(String(sendRes.error ?? "")) ? "pending" : "failed";
            await dbExecute(
              `UPDATE reminders SET status=?, last_error=?, sent_at=NULL
                WHERE tenant_id = ? AND id = ?`,
              [nextStatus, errText, tenantId, reminderId],
            );
            result.failed += 1;
          }
        }
      } else {
        // PHP: when the reminder toggle is off, drop pending email reminders.
        await dbExecute(
          `DELETE FROM reminders WHERE tenant_id = ? AND channel='email' AND status='pending'`,
          [tenantId],
        );
      }

      // ----- appointment SMS reminders -----
      if (smsEnabled) {
        const smsDue = await dbQuery<DueAppointmentReminder[]>(
          appointmentReminderSelect("sms"),
          [tenantId, claimCutoff(), businessNowDateTime()],
        );

        for (const r of smsDue) {
          const reminderId = Number(r.reminder_id ?? 0);
          const appointmentId = Number(r.appointment_id ?? 0);

          if (!isScheduled(r.status)) {
            await dbExecute(
              `UPDATE reminders SET status='failed', last_error=?, sent_at=NULL
                WHERE tenant_id = ? AND id = ?`,
              [`Appuntamento non schedulato (status=${r.status ?? "n/a"})`, tenantId, reminderId],
            );
            continue;
          }
          if (!String(r.client_phone ?? "").trim()) {
            await dbExecute(
              `UPDATE reminders SET status='failed', last_error=?, sent_at=NULL
                WHERE tenant_id = ? AND id = ?`,
              ["Telefono cliente mancante", tenantId, reminderId],
            );
            continue;
          }

          const phone = String(r.client_phone).trim();
          result.dueAppointmentSmsReminders.push({ reminderId, appointmentId, phone });

          // No SMS provider configured -> behave like the old SEND_ENABLED=false
          // path: leave the row pending, just report it.
          if (!smsReady) {
            result.skipped += 1;
            continue;
          }

          // CLAIM atomico anti double-send PRIMA del debit: due run sovrapposti
          // inviavano DUE SMS addebitando DUE volte il wallet.
          const smsClaim = await dbExecute(
            `UPDATE reminders SET status='sending', updated_at=?
              WHERE tenant_id = ? AND id = ?
                AND (status='pending' OR (status='sending' AND updated_at < ?))`,
            [businessNowDateTime(), tenantId, reminderId, claimCutoff()],
          );
          if (smsClaim.affectedRows <= 0) continue;

          // Port of automation_send_sms_reminder(): build the message, debit the
          // SMS credit wallet (1 credit/segment), send via OpenAPI, and refund on
          // a rejected send. Then write the provider columns exactly like
          // automation_update_sms_reminder_after_send. Mark 'sent' ONLY on ok.
          const message = buildReminderSms(r, bizSettings);
          const segments = Math.max(1, smsSegmentCount(message));
          const debit = await smsCreditTryDebit(tenantId, segments, "reminder", reminderId);
          if (!debit.ok) {
            // PHP: insufficient credits -> not sent, marked failed.
            await dbExecute(
              `UPDATE reminders SET status='failed', sent_at=NULL, last_error=?, sms_segments=?
                WHERE tenant_id = ? AND id = ?`,
              ["Crediti SMS insufficienti", segments, tenantId, reminderId],
            );
            result.failed += 1;
            continue;
          }

          const smsRes = await sendSmsItaly(phone, message, {
            sender: "Prenodo",
            reminderId,
            appointmentId,
            tenant: slug,
            callbackUrl: process.env.OPENAPI_SMS_CALLBACK_URL || undefined,
          });

          const providerId = String(smsRes.id ?? "").trim();
          const providerState = String(smsRes.state ?? "").trim().toUpperCase();
          const price = typeof smsRes.price === "number" ? smsRes.price : null;
          const totalPrice = typeof smsRes.totalPrice === "number" ? smsRes.totalPrice : null;

          if (smsRes.ok) {
            // Port of automation_update_sms_reminder_after_send (success branch).
            await dbExecute(
              `UPDATE reminders
                  SET status='sent', sent_at=?, last_error=NULL,
                      provider='openapi_sms', provider_message_id=?, provider_state=?,
                      provider_price=?, provider_total_price=?,
                      sms_segments=?, sms_credits_used=?, last_checked_at=?
                WHERE tenant_id = ? AND id = ?`,
              [
                businessNowDateTime(),
                providerId !== "" ? providerId : null,
                providerState !== "" ? providerState : null,
                price,
                totalPrice,
                segments,
                segments,
                businessNowDateTime(),
                tenantId,
                reminderId,
              ],
            );
            result.sent += 1;
          } else {
            // PHP: provider rejected -> refund the debited credits. Errore
            // transiente -> torna pending (retry al giro dopo), permanente -> failed.
            await smsCreditRefund(tenantId, segments, "reminder", reminderId);
            const smsNextStatus = isTransientSendError(String(smsRes.error ?? "")) ? "pending" : "failed";
            await dbExecute(
              `UPDATE reminders
                  SET status=?, sent_at=NULL, last_error=?,
                      provider='openapi_sms', provider_message_id=?, provider_state=?,
                      sms_segments=?, sms_credits_used=0, last_checked_at=?
                WHERE tenant_id = ? AND id = ?`,
              [
                smsNextStatus,
                String(smsRes.error ?? "").trim() || "Invio SMS fallito",
                providerId !== "" ? providerId : null,
                providerState !== "" ? providerState : null,
                segments,
                businessNowDateTime(),
                tenantId,
                reminderId,
              ],
            );
            result.failed += 1;
          }
        }
      } else {
        // PHP: when the SMS toggle is off, drop pending SMS reminders.
        await dbExecute(
          `DELETE FROM reminders WHERE tenant_id = ? AND channel='sms' AND status='pending'`,
          [tenantId],
        );
      }

      // ----- queue FIDELITY expiry-window reminders (automation_queue_fidelity_expiry_window_reminders) -----
      if (fidelityEnabled) {
        const bizRows = await dbQuery<RowDataPacket[]>(
          `SELECT fidelity_adhesion_json FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
          [tenantId],
        );
        const windowCfg = renewalWindowConfig(
          (bizRows[0]?.fidelity_adhesion_json as string | null) ?? null,
        );

        // PHP: feature only runs when the renewal window value > 0.
        if (windowCfg.value > 0) {
          const cards = await dbQuery<FidelityCardRow[]>(
            `SELECT fc.id, fc.client_id, fc.expires_at, c.email AS client_email
               FROM cards fc
               JOIN clients c ON c.id = fc.client_id AND c.tenant_id = fc.tenant_id
              WHERE fc.tenant_id = ?
                AND fc.expires_at IS NOT NULL
                AND fc.expires_at >= CURRENT_DATE
                AND COALESCE(NULLIF(TRIM(c.email), ''), '') <> ''
                AND fc.status='active'
              ORDER BY fc.expires_at ASC, fc.id ASC`,
            [tenantId],
          );

          const today = todayYmd();
          for (const card of cards) {
            const cardId = Number(card.id ?? 0);
            const clientId = Number(card.client_id ?? 0);
            const expiresAt = normalizeYmd(card.expires_at);
            if (cardId <= 0 || clientId <= 0 || expiresAt === null) continue;

            let windowStart = subtractDuration(expiresAt, Math.abs(windowCfg.value), windowCfg.unit);
            if (windowStart === null) windowStart = expiresAt;

            // PHP: only queue when today is inside [windowStart, expiresAt].
            if (today < windowStart || today > expiresAt) continue;

            // INSERT (the UNIQUE key card_id+reminder_kind+card_expires_at makes
            // re-queues idempotent — ignore the duplicate, matching the PHP
            // try/catch around the insert).
            try {
              const ins = await dbExecute(
                `INSERT INTO card_reminders
                   (tenant_id, card_id, client_id, reminder_kind, card_expires_at, scheduled_at, status, last_error)
                 VALUES (?, ?, ?, 'expiry_window', ?, ?, 'pending', NULL)`,
                [tenantId, cardId, clientId, expiresAt, businessNowDateTime()],
              );
              if (ins.affectedRows > 0) result.fidelityQueued += 1;
            } catch {
              // Row already present (unique key) — ignore, as the PHP does.
            }
          }
        }
      }

      // ----- select due FIDELITY card reminders (automation_process_fidelity_expiry_reminders) -----
      // Selected regardless of toggle (mirrors PHP, which only gates queueing and
      // the actual send). We mark these 'sent' only after a successful email send,
      // matching the PHP which marks them after automation_send_fidelity_expiry_email().
      // Fetch card code/status + client name so the email template can be built.
      const dueCards = await dbQuery<DueCardReminder[]>(
        `SELECT cr.id, cr.card_id, cr.client_id, cr.card_expires_at,
                fc.code AS card_code, fc.status AS card_status,
                c.full_name AS client_name, c.email AS client_email
           FROM card_reminders cr
           JOIN cards fc ON fc.id = cr.card_id AND fc.tenant_id = cr.tenant_id
           JOIN clients c ON c.id = cr.client_id AND c.tenant_id = cr.tenant_id
          WHERE cr.tenant_id = ?
            AND cr.reminder_kind='expiry_window'
            AND (cr.status='pending'
                 OR (cr.status='sending' AND cr.updated_at < ?))
            AND cr.scheduled_at <= ?
          ORDER BY cr.scheduled_at ASC, cr.id ASC
          LIMIT ${SELECT_LIMIT}`,
        [tenantId, claimCutoff(), businessNowDateTime()],
      );

      for (const row of dueCards) {
        const id = Number(row.id ?? 0);
        // Missing client email -> mark failed (safe bookkeeping, mirrors PHP).
        if (!String(row.client_email ?? "").trim()) {
          await dbExecute(
            `UPDATE card_reminders SET status='failed', sent_at=NULL, last_error=?
              WHERE tenant_id = ? AND id = ?`,
            ["Email cliente mancante", tenantId, id],
          );
          continue;
        }

        const to = String(row.client_email).trim();
        result.dueCardReminders.push({
          id,
          cardId: Number(row.card_id ?? 0),
          clientId: Number(row.client_id ?? 0),
          expiresAt: String(row.card_expires_at ?? ""),
          email: to,
        });

        // PHP automation_send_fidelity_expiry_email: only sends when the card is
        // still active. A deactivated card -> mark failed (safe bookkeeping).
        if (String(row.card_status ?? "active").trim().toLowerCase() !== "active") {
          await dbExecute(
            `UPDATE card_reminders SET status='failed', sent_at=NULL, last_error=?
              WHERE tenant_id = ? AND id = ?`,
            ["Tessera fidelity non attiva", tenantId, id],
          );
          result.failed += 1;
          continue;
        }

        // No email provider configured -> leave pending, just report it.
        if (!emailReady) {
          result.skipped += 1;
          continue;
        }

        // CLAIM atomico anti double-send (come i reminder appuntamento).
        const cardClaim = await dbExecute(
          `UPDATE card_reminders SET status='sending', updated_at=?
            WHERE tenant_id = ? AND id = ?
              AND (status='pending' OR (status='sending' AND updated_at < ?))`,
          [businessNowDateTime(), tenantId, id, claimCutoff()],
        );
        if (cardClaim.affectedRows <= 0) continue;

        // Port of automation_send_fidelity_expiry_email(): build + send. Mark
        // 'sent' ONLY on a successful send.
        const msg = buildFidelityEmail(row, bizSettings);
        // Pattern SES: From verificato + fromName attività + replyTo attività.
        const sendRes = await sendEmail({
          to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          fromName: String(bizSettings?.name ?? "") || undefined,
          replyTo: String(bizSettings?.email ?? "").trim() || undefined,
        });

        if (sendRes.ok) {
          await dbExecute(
            `UPDATE card_reminders SET status='sent', sent_at=?, last_error=NULL
              WHERE tenant_id = ? AND id = ?`,
            [businessNowDateTime(), tenantId, id],
          );
          result.sent += 1;
        } else {
          // Transiente -> torna pending (retry al giro dopo); permanente -> failed.
          const cardNextStatus = isTransientSendError(String(sendRes.error ?? "")) ? "pending" : "failed";
          await dbExecute(
            `UPDATE card_reminders SET status=?, sent_at=NULL, last_error=?
              WHERE tenant_id = ? AND id = ?`,
            [cardNextStatus, `Invio email fallito: ${sendRes.error ?? "errore provider"}`, tenantId, id],
          );
          result.failed += 1;
        }
      }

      // ----- history cleanup (automation_cleanup_communication_history, 30 days) -----
      // Safe to run regardless of provider config: only removes terminal rows.
      try {
        const c1 = await dbExecute(
          `DELETE FROM reminders
            WHERE tenant_id = ?
              AND status IN ('sent','failed','skipped')
              AND COALESCE(delivered_at, last_checked_at, sent_at, scheduled_at, updated_at, created_at)
                  < (NOW() - (${CLEANUP_DAYS} * interval '1 day'))`,
          [tenantId],
        );
        result.cleanup.reminders = c1.affectedRows;
      } catch {
        // Cleanup must never block the cron.
      }
      try {
        const c2 = await dbExecute(
          `DELETE FROM card_reminders
            WHERE tenant_id = ?
              AND status IN ('sent','failed')
              AND COALESCE(sent_at, scheduled_at, updated_at, created_at)
                  < (NOW() - (${CLEANUP_DAYS} * interval '1 day'))`,
          [tenantId],
        );
        result.cleanup.cardReminders = c2.affectedRows;
      } catch {
        // Cleanup must never block the cron.
      }
      try {
        const c3 = await dbExecute(
          `DELETE FROM communication_logs
            WHERE tenant_id = ?
              AND status IN ('sent','failed','skipped')
              AND COALESCE(sent_at, created_at)
                  < (NOW() - (${CLEANUP_DAYS} * interval '1 day'))`,
          [tenantId],
        );
        result.cleanup.communicationLogs = c3.affectedRows;
      } catch {
        // Cleanup must never block the cron.
      }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[cron reminders] tenant ${slug} FALLITO:`, msg);
        result.error = msg;
      }

      total += result.sent;
      totalFailed += result.failed;
      totalSkipped += result.skipped;
      results.push(result);
    }

    return Response.json({
      ok: true,
      job: "reminders",
      emailProviderConfigured: emailReady,
      smsProviderConfigured: smsReady,
      total,
      totalFailed,
      totalSkipped,
      results,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron reminders." },
      { status: 500 },
    );
  }
}

export const POST = GET;

// PHP app_date_sql() / date('Y-m-d') — today's date as a Y-m-d string. Dates in
// this schema are stored/compared as plain Y-m-d strings (mysql2 dateStrings /
// pg parsers return raw strings), so string comparison against expires_at is
// the same lexicographic order PHP relied on.
function todayYmd(): string {
  // Wall-time ROMA (audit 21/07): coi componenti locali del server (UTC su
  // Amplify) tra le 00:00 e le 02:00 di Roma il "giorno" era quello precedente
  // e la finestra rinnovo tessere slittava di un giorno.
  return businessNowDateTime().slice(0, 10);
}

// CLAIM anti double-send (audit 21/07, stesso schema di giftbox/giftcard ma
// senza DDL: riuso status+updated_at). Un run marca la riga 'sending' con
// UPDATE atomico PRIMA di inviare; un run sovrapposto la salta. Le righe
// 'sending' più vecchie di 15 minuti (crash a metà) tornano eleggibili.
const CLAIM_MINUTES = 15;

function claimCutoff(): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(businessNowDateTime());
  if (!m) return businessNowDateTime();
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]) - CLAIM_MINUTES, Number(m[6])));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Errori provider TRANSIENTI (throttling/rete): la riga torna 'pending' e viene
// ritentata al giro dopo — prima diventava 'failed' per sempre, in
// contraddizione col commento in testa al file.
function isTransientSendError(message: string): boolean {
  return /throttl|rate.?limit|too many|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|temporar|unavailable|5\d\d/i.test(message);
}

// PHP fidelity_card_normalize_date_ymd(): coerce a stored date to Y-m-d, or null.
function normalizeYmd(raw: string | null): string | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Registro cron (Fase C pannello, 2026-07-19): auth PRIMA del tracking, poi
// l'esecuzione viene registrata in saas_cron_runs (esito, durata, sintesi).
export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return trackCronResponse("reminders", () => handler(request));
}
