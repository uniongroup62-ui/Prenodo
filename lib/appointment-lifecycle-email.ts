import "server-only";

import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";
import { dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

// Port of automation_send_email('approved'|'modified'|'rejected', $appointmentId)
// from app/lib/Helpers.php, wired into the Next "manage appointments" flow so a
// customer gets the same lifecycle email when staff change an appointment.
//
// Trigger points (matching the PHP callers):
//   - 'approved'  fires on a status transition pending -> scheduled
//                 (AppointmentLifecycle / Helpers.php automation_handle_*).
//   - 'rejected'  fires on a status transition pending -> canceled.
//   - 'modified'  fires when an EXISTING appointment's customer-visible data
//                 (date/time/services/...) changes WITHOUT a status change.
//
// Each kind honours its automation_settings toggle (approved_enabled /
// modified_enabled / rejected_enabled — missing column means enabled, exactly
// like automation_kind_enabled). Sending is gated on emailConfigured(): when the
// SES provider is unconfigured we no-op (today's behaviour). The DB write that
// triggered the email has already happened by the time we are called, and any
// send failure is swallowed + logged so a delivery problem never fails the API.
//
// This mirrors the reminders cron's approach (lib + queries): per-tenant
// businesses settings lookup, the appointment-detail enrichment (datetime,
// location, client, services), and buildModernEmailTemplate.

export type AppointmentEmailKind = "approved" | "modified" | "rejected";

// PHP setting_get('name','La mia attività') default.
const DEFAULT_BIZ_NAME = "La mia attività";

type BusinessSettings = RowDataPacket & {
  name: string | null;
  email: string | null;
  phone: string | null;
};

// automation_settings row (only the lifecycle toggles are needed here).
type AutomationToggles = RowDataPacket & {
  approved_enabled: number | null;
  modified_enabled: number | null;
  rejected_enabled: number | null;
};

// Enriched appointment-detail row (subset of PHP appointment_details used by the
// lifecycle templates): date/time, client name/email, resolved location +
// location phone, and the concatenated service names.
type AppointmentDetailRow = RowDataPacket & {
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  client_name: string | null;
  client_email: string | null;
  staff_name: string | null;
  location_name: string | null;
  location_address: string | null;
  location_phone: string | null;
  service_names: string | null;
};

// PHP h(): htmlspecialchars(ENT_QUOTES).
function h(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// PHP automation_compact_email_body(): normalise newlines and trim.
function compactEmailBody(body: string): string {
  let s = String(body ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// PHP date('d/m') / date('H:i') over a stored "YYYY-MM-DD HH:MM:SS" string. Pg
// dateStrings return raw strings, so parse the literal fields with no tz shift.
function fmtDateDM(raw: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? "").trim());
  return m ? `${m[3]}/${m[2]}` : "";
}
function fmtTimeHM(raw: string | null): string {
  const m = /\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(String(raw ?? "").trim());
  return m ? `${m[1]}:${m[2]}` : "";
}

// Split the string_agg'd service names back into an array. The SELECT joins them
// with the \x1f unit separator so names that contain commas stay intact.
function serviceNameList(raw: string | null): string[] {
  return String(raw ?? "")
    .split("\x1f")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Port of appointment_summary_html(): the branded "Riepilogo appuntamento" card
// embedded in the approved/modified emails. The PHP collapses all whitespace via
// preg_replace('/\s+/', ' ', $html) then trims — reproduced here.
function appointmentSummaryHtml(row: AppointmentDetailRow): string {
  const date = fmtDateDM(row.starts_at);
  const time = fmtTimeHM(row.starts_at);
  const end = fmtTimeHM(row.ends_at);

  const staff = h(String(row.staff_name ?? "") || "—");
  const locName = h(String(row.location_name ?? "") || "—");
  const locAddr = h(String(row.location_address ?? ""));

  let serviceLines = "";
  for (const name of serviceNameList(row.service_names)) {
    serviceLines += `<div>${h(name)}</div>`;
  }
  if (serviceLines === "") serviceLines = "<div>—</div>";

  const addrLine = locAddr ? `<div style="color:#64748b;font-size:13px">${locAddr}</div>` : "";
  const html = `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px">
      <div style="font-size:14px;color:#64748b">Riepilogo appuntamento</div>
      <div style="font-size:18px;font-weight:800;margin-top:4px">${date} • ${time}${end ? `–${end}` : ""}</div>
      <div style="margin-top:10px">
        <div style="font-weight:600">Operatore</div>
        <div>${staff}</div>
      </div>
      <div style="margin-top:10px">
        <div style="font-weight:600">Sede</div>
        <div>${locName}</div>
        ${addrLine}
      </div>
      <div style="margin-top:12px">
        <div style="font-weight:600">Servizi</div>
        <div style="margin-top:6px">${serviceLines}</div>
      </div>
    </div>
  `;
  return html.trim().replace(/\s+/g, " ");
}

// PHP automation_support_contact_notice(): falls back to the business phone.
function supportContactNotice(locationPhone: string, bizPhone: string): string {
  const phone = String(locationPhone || bizPhone || "").trim();
  return phone === "" ? "" : `Per assistenza contattaci al ${phone}.`;
}

// automation_kind_enabled('approved'|'modified'|'rejected'): a missing column
// (legacy install) means enabled. We model the missing-column case as a null
// value (the SELECT COALESCEs absent columns to NULL via the LEFT JOIN), so a
// NULL toggle => enabled, exactly like the PHP array_key_exists check.
function kindEnabled(kind: AppointmentEmailKind, toggles: AutomationToggles | undefined): boolean {
  if (!toggles) return true;
  const value =
    kind === "approved" ? toggles.approved_enabled : kind === "modified" ? toggles.modified_enabled : toggles.rejected_enabled;
  return value == null ? true : Boolean(value);
}

// Build the per-kind subject + plain-text body (faithful ports of
// automation_default_*_subject / *_body), then wrap with buildModernEmailTemplate
// using the per-tenant business settings — mirroring automation_send_email which
// renders the template and runs automation_compact_email_body before mail_send_html.
function buildLifecycleEmail(
  kind: AppointmentEmailKind,
  row: AppointmentDetailRow,
  biz: BusinessSettings | undefined,
): { subject: string; html: string; text: string } {
  const bizName = String(biz?.name ?? "") || DEFAULT_BIZ_NAME;
  const bizPhone = String(biz?.phone ?? "");
  // client_greeting is fixed to "Ciao," (automation_client_greeting).
  const greeting = "Ciao,";
  const support = supportContactNotice(String(row.location_phone ?? ""), bizPhone);

  let subject: string;
  let body: string;
  if (kind === "approved") {
    subject = "Appuntamento approvato";
    // {{client_greeting}}\n\nil tuo appuntamento è stato approvato.\n{{appointment_summary}}\n{{support_contact_notice}}\n\nSaluti,\n{{business_name}}
    body =
      `${greeting}\n\nil tuo appuntamento è stato approvato.\n` +
      `${appointmentSummaryHtml(row)}\n${h(support)}\n\nSaluti,\n${h(bizName)}`;
  } else if (kind === "modified") {
    subject = "Appuntamento modificato";
    body =
      `${greeting}\n\nil tuo appuntamento è stato modificato.\n` +
      `${appointmentSummaryHtml(row)}\n${h(support)}\n\nSaluti,\n${h(bizName)}`;
  } else {
    subject = "Appuntamento rifiutato";
    // rejected has no appointment summary (matches automation_default_rejected_body).
    // NIENTE h() qui: senza il summary HTML il body è testo semplice e
    // buildModernEmailTemplate lo escapa già — con h() era double-escape
    // (apostrofi come &#039; nell'email al cliente, audit 21/07).
    body =
      `${greeting}\n\npurtroppo non possiamo confermare l'appuntamento richiesto.\n` +
      `${support}\n\nSaluti,\n${bizName}`;
  }

  const renderedBody = compactEmailBody(body);
  const tpl = buildModernEmailTemplate(subject, renderedBody, {
    business_name: bizName,
    business_email: String(biz?.email ?? ""),
    // TODO: business_logo_url — PHP derives it from business_logo_absolute_url();
    // no host/filesystem to resolve that here, so we send without a logo (the
    // template renders the brand name instead, identical to the no-logo PHP path).
    business_logo_url: "",
  });
  return { subject, html: tpl.html, text: tpl.text };
}

// Enriched appointment-detail SELECT shared by all lifecycle kinds. Mirrors the
// fields automation_send_email pulls from appointment_details: appointment
// date/time, client name/email, the resolved location (appointment_locations ->
// locations, falling back to the business name/phone), and the concatenated
// service names. Tenant-scoped throughout. The \x1f unit separator survives
// service names containing commas (see serviceNameList()).
const APPOINTMENT_DETAIL_SELECT = `
  SELECT a.status, a.starts_at, a.ends_at,
         c.full_name AS client_name, c.email AS client_email,
         st.full_name AS staff_name,
         COALESCE(NULLIF(TRIM(loc.name), ''), b.name) AS location_name,
         COALESCE(NULLIF(TRIM(loc.address), ''), b.address, '') AS location_address,
         COALESCE(NULLIF(TRIM(loc.phone), ''), NULLIF(TRIM(b.phone), ''), '') AS location_phone,
         (SELECT string_agg(COALESCE(NULLIF(TRIM(aps.service_name), ''), s.name), E'\\x1f')
            FROM appointment_services aps
            JOIN services s ON s.id = aps.service_id AND s.tenant_id = aps.tenant_id
           WHERE aps.appointment_id = a.id AND aps.tenant_id = a.tenant_id) AS service_names
    FROM appointments a
    JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
    LEFT JOIN appointment_staff ast ON ast.appointment_id = a.id AND ast.tenant_id = a.tenant_id
    LEFT JOIN staff st ON st.id = ast.staff_id AND st.tenant_id = a.tenant_id
    LEFT JOIN appointment_locations al ON al.appointment_id = a.id AND al.tenant_id = a.tenant_id
    LEFT JOIN locations loc ON loc.id = al.location_id AND loc.tenant_id = a.tenant_id
    LEFT JOIN businesses b ON b.tenant_id = a.tenant_id AND b.id = (
      SELECT MIN(b2.id) FROM businesses b2 WHERE b2.tenant_id = a.tenant_id)
   WHERE a.tenant_id = ? AND a.id = ?
   LIMIT 1`;

// Port of automation_send_email($kind, $appointmentId) for the manage flow.
// Fully gated and best-effort: it NEVER throws (callers fire-and-forget after
// the DB write). Returns whether an email was actually sent.
export async function sendAppointmentLifecycleEmail(args: {
  slug: string;
  appointmentId: number;
  kind: AppointmentEmailKind;
}): Promise<boolean> {
  const { slug, appointmentId, kind } = args;
  try {
    // Provider gating first: when SES is unconfigured we no-op (today's behaviour).
    if (!emailConfigured()) return false;
    if (!appointmentId || appointmentId <= 0) return false;

    const tenantId = await tenantIdForSlug(slug);
    if (!tenantId) return false;

    // automation_settings toggles (automation_kind_enabled). A missing
    // automation_settings row means enabled (PHP defaults), so we treat the
    // absent row exactly like the absent column.
    let toggles: AutomationToggles | undefined;
    try {
      const rows = await dbQuery<AutomationToggles[]>(
        `SELECT approved_enabled, modified_enabled, rejected_enabled
           FROM automation_settings
          WHERE tenant_id = ?
          ORDER BY id ASC
          LIMIT 1`,
        [tenantId],
      );
      toggles = rows[0];
    } catch {
      // Legacy install without the toggle columns -> treat as enabled.
      toggles = undefined;
    }
    if (!kindEnabled(kind, toggles)) return false;

    // Business settings (legacy setting_get name/email/phone from the businesses
    // row), scoped per tenant — supplies the template branding + support phone.
    const bizRows = await dbQuery<BusinessSettings[]>(
      `SELECT name, email, phone FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
      [tenantId],
    );
    const biz = bizRows[0];

    // Appointment detail enrichment (datetime, client, location, services).
    const detailRows = await dbQuery<AppointmentDetailRow[]>(APPOINTMENT_DETAIL_SELECT, [tenantId, appointmentId]);
    const row = detailRows[0];
    if (!row) return false;

    // PHP: missing client email -> bail (it logs a failed communication row; we
    // have no communication_logs equivalent wired here, so we just no-op).
    const to = String(row.client_email ?? "").trim();
    if (to === "") return false;

    const msg = buildLifecycleEmail(kind, row, biz);
    // Pattern SES: From verificato + fromName attività + replyTo attività
    // (un fromEmail tenant non verificato viene RIFIUTATO da SES).
    const res = await sendEmail({
      to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      fromName: String(biz?.name ?? "") || undefined,
      replyTo: String(biz?.email ?? "").trim() || undefined,
    });
    if (!res.ok) {
      console.error(`[appointment-lifecycle-email] send failed (${kind}, appt ${appointmentId}): ${res.error ?? "unknown"}`);
      return false;
    }
    return true;
  } catch (error) {
    // A delivery/build problem must never fail the status/save API.
    console.error(`[appointment-lifecycle-email] error (${kind}, appt ${appointmentId}):`, error);
    return false;
  }
}

// Map an appointment status transition to the lifecycle email kind, mirroring
// the PHP callers in AppointmentLifecycle.php / automation_handle_*:
//   pending -> scheduled  => 'approved'
//   pending -> canceled   => 'rejected'
//   anything else         => null (no lifecycle email)
// The arguments are PHP-normalized status codes (phpStatus()): 'pending',
// 'scheduled', 'canceled', 'done', 'no_show'.
export function lifecycleKindForStatusChange(
  oldPhpStatus: string,
  newPhpStatus: string,
): AppointmentEmailKind | null {
  const from = String(oldPhpStatus ?? "").trim().toLowerCase();
  const to = String(newPhpStatus ?? "").trim().toLowerCase();
  if (from === "pending" && to === "scheduled") return "approved";
  if (from === "pending" && to === "canceled") return "rejected";
  return null;
}
