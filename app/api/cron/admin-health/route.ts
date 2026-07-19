import { assertCronAuth, trackCronResponse } from "@/lib/cron";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery } from "@/lib/tenant-db";
import { healthAllSaasTenants } from "@/lib/saas-tenant-manager";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cron HEALTH-CHECK dei tenant (Fase 4 SaaS Admin, 2026-07-19; su Amplify via
// EventBridge, es. ogni 6 ore): esegue la diagnostica di TUTTI i tenant
// (registrata con source 'cron') e, se emergono ERRORI, avvisa via email gli
// admin SaaS attivi (owner+admin). Email di PIATTAFORMA: brand Prenodo,
// nessun replyTo tenant. Con SES non configurato la diagnostica gira comunque
// e l'esito resta nel payload/DB.
async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const results = await healthAllSaasTenants(true, true, "cron");
    const errors = results.filter((r) => r.level === "error");
    const warnings = results.filter((r) => r.level === "warning");

    let alerted = 0;
    if (errors.length > 0 && emailConfigured()) {
      const admins = await dbQuery<RowDataPacket[]>(
        "SELECT email FROM `saas_admins` WHERE is_active=1 AND role IN ('owner','admin')",
      ).catch(() => [] as RowDataPacket[]);
      const recipients = admins.map((row) => String(row.email ?? "").trim()).filter(Boolean);
      if (recipients.length) {
        const lines = errors
          .map((r) => `<li><strong>${escapeHtml(r.slug)}</strong>: ${escapeHtml(r.message)}</li>`)
          .join("");
        const body =
          `<p>Ciao,</p>` +
          `<p>la diagnostica automatica ha rilevato <strong>${errors.length} tenant in errore</strong>` +
          `${warnings.length ? ` (e ${warnings.length} con avvisi)` : ""}:</p>` +
          `<ul>${lines}</ul>` +
          `<p>Apri il pannello SaaS Admin per i dettagli e le azioni di ripristino.</p>`;
        const subject = "Diagnostica tenant: errori rilevati";
        const tpl = buildModernEmailTemplate(subject, body, { business_name: "Prenodo" });
        const sent = await sendEmail({ to: recipients, subject, html: tpl.html, text: tpl.text });
        alerted = sent.ok ? recipients.length : 0;
      }
    }

    return Response.json({
      ok: true,
      checked: results.length,
      errors: errors.length,
      warnings: warnings.length,
      alerted,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Health cron fallito." },
      { status: 500 },
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Registro cron (Fase C pannello, 2026-07-19): auth PRIMA del tracking, poi
// l'esecuzione viene registrata in saas_cron_runs (esito, durata, sintesi).
export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return trackCronResponse("admin-health", () => handler(request));
}
