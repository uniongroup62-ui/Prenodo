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

    // SNAPSHOT metriche del giorno (vista Statistiche): MRR/tenant/account
    // marketplace non sono ricostruibili a posteriori — si fotografano qui.
    const { snapshotDailyMetrics } = await import("@/lib/saas-stats");
    const snapshot = await snapshotDailyMetrics().catch(() => null);

    // ALERT MULTIPLI (rifiniture 2026-07-19): oltre agli errori di salute,
    // il cron segnala provisioning falliti, cron in errore e anomalie login.
    // Anti-spam: ogni chiave notifica al massimo una volta ogni 24 ore.
    const { alertNotRecentlySent, markAlertSent } = await import("@/lib/saas-admin-security");
    const candidates: Array<{ key: string; title: string; lines: string[] }> = [];

    if (errors.length > 0) {
      candidates.push({
        key: "health_errors",
        title: `${errors.length} tenant con diagnostica in errore`,
        lines: errors.map((r) => `${r.slug}: ${r.message}`),
      });
    }

    const failedTenants = await dbQuery<RowDataPacket[]>(
      "SELECT slug, provisioning_error FROM `saas_tenants` WHERE status='failed' ORDER BY id DESC LIMIT 10",
    ).catch(() => [] as RowDataPacket[]);
    if (failedTenants.length > 0) {
      candidates.push({
        key: "tenants_failed",
        title: `${failedTenants.length} tenant con provisioning fallito`,
        lines: failedTenants.map((r) => `${String(r.slug)}: ${String(r.provisioning_error ?? "errore").slice(0, 120)}`),
      });
    }

    const failedCrons = await dbQuery<RowDataPacket[]>(
      `SELECT r.job, r.message FROM \`saas_cron_runs\` r
        WHERE r.id = (SELECT MAX(r2.id) FROM \`saas_cron_runs\` r2 WHERE r2.job = r.job)
          AND r.status = 'error' AND r.job <> 'admin-health'
        ORDER BY r.job ASC`,
    ).catch(() => [] as RowDataPacket[]);
    for (const row of failedCrons) {
      candidates.push({
        key: `cron_error:${String(row.job)}`,
        title: `Cron in errore: ${String(row.job)}`,
        lines: [String(row.message ?? "").slice(0, 160) || "Ultima esecuzione fallita."],
      });
    }

    const failedLogins = await dbQuery<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `saas_admin_login_attempts` WHERE success=0 AND attempted_at >= (NOW() - interval '24 hours')",
    ).catch(() => [] as RowDataPacket[]);
    if (Number(failedLogins[0]?.count ?? 0) >= 10) {
      candidates.push({
        key: "login_anomaly",
        title: `${Number(failedLogins[0]?.count)} login falliti nelle ultime 24 ore`,
        lines: ["Possibile forza bruta sul pannello: controlla sessioni e audit."],
      });
    }

    const alerts: typeof candidates = [];
    for (const candidate of candidates) {
      if (await alertNotRecentlySent(candidate.key)) alerts.push(candidate);
    }

    let alerted = 0;
    if (alerts.length > 0 && emailConfigured()) {
      const admins = await dbQuery<RowDataPacket[]>(
        "SELECT email FROM `saas_admins` WHERE is_active=1 AND role IN ('owner','admin')",
      ).catch(() => [] as RowDataPacket[]);
      const recipients = admins.map((row) => String(row.email ?? "").trim()).filter(Boolean);
      if (recipients.length) {
        const sections = alerts
          .map((a) => `<p><strong>${escapeHtml(a.title)}</strong></p><ul>${a.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`)
          .join("");
        const body =
          `<p>Ciao,</p><p>il monitoraggio della piattaforma segnala:</p>${sections}` +
          `<p>Apri il pannello SaaS Admin per i dettagli e le azioni.</p>`;
        const subject = "Monitoraggio piattaforma: segnalazioni";
        const tpl = buildModernEmailTemplate(subject, body, { business_name: "Prenodo" });
        const sent = await sendEmail({ to: recipients, subject, html: tpl.html, text: tpl.text });
        if (sent.ok) {
          alerted = recipients.length;
          for (const a of alerts) await markAlertSent(a.key);
        }
      }
    }

    return Response.json({
      ok: true,
      checked: results.length,
      errors: errors.length,
      warnings: warnings.length,
      alerts: alerts.map((a) => a.key),
      alerted,
      snapshot: snapshot?.day ?? null,
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
