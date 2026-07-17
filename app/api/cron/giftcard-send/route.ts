import { activeTenantSlugs, assertCronAuth } from "@/lib/cron";
import { businessTodayIso } from "@/lib/business-datetime";
import { emailConfigured } from "@/lib/email";
import { sendGiftCardEmailManage } from "@/lib/gift-issue-details";
import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/giftcard_send.php (+ GiftCard::sendDueScheduledGiftCards).
// For each active tenant it finds active giftcards whose scheduled_send_on has
// arrived and that were never emailed, then for each one: atomically claims the
// row and delegates the send to sendGiftCardEmailManage() — the SAME faithful
// builder used at page-load (sendDueScheduledGiftCards) and from the POS. That
// single builder does the send AND the success-path DB writes (last_email_sent_*,
// last_email_hide_amount, clears scheduled_send_on + the claim). Using it here
// keeps the scheduled email IDENTICAL to the manual/page-load one (event hero
// image, subject, terms) instead of the old divergent in-file builder.
//
// MySQL -> Postgres notes: CURDATE() -> CURRENT_DATE, NOW() kept; expires_at is
// a DATE so it is compared to CURRENT_DATE; the MySQL '0000-00-00 00:00:00'
// sentinel is dropped (Postgres can't store it, so "never sent" is simply
// last_email_sent_at IS NULL).
//
// Outbound email goes through lib/email.ts (Amazon SES). When SES is not
// configured (emailConfigured() === false) the job reports the due count but
// marks nothing, so scheduled sends are never silently consumed without an
// email actually going out. Every statement is scoped by tenant_id.
const SELECT_LIMIT = 500;
// Sending is enabled whenever the email provider (SES) is configured. Until
// then the job reports due items but does NOT mark them sent.
const SEND_ENABLED = emailConfigured();

type DueGiftcard = RowDataPacket & {
  id: number;
  recipient_email: string | null;
  gift_message: string | null;
  email_show_amount: number | null;
};

export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const slugs = await activeTenantSlugs();
    const results: Array<{ tenant: string; sent: number; errors: number; due?: number }> = [];
    let total = 0;

    for (const slug of slugs) {
      const tenantId = await tenantIdForSlug(slug);
      if (!tenantId) continue;

      let sent = 0;
      let errors = 0;

      // Select due scheduled giftcards that still need sending. Only the fields
      // the delegation needs (id + recipient + gift_message + show-amount flag);
      // sendGiftCardEmailManage re-reads everything else it renders.
      const due = await dbQuery<DueGiftcard[]>(
        `SELECT gc.id,
                gc.recipient_email,
                gc.gift_message,
                COALESCE(gc.email_show_amount, 1) AS email_show_amount
           FROM giftcards gc
          WHERE gc.tenant_id = ?
            AND gc.status='active'
            AND gc.scheduled_send_on IS NOT NULL
            AND gc.scheduled_send_on <= ?
            AND (gc.expires_at IS NULL OR gc.expires_at >= ?)
            AND gc.last_email_sent_at IS NULL
            AND gc.recipient_email IS NOT NULL
            AND gc.recipient_email <> ''
            AND (gc.email_send_claimed_at IS NULL OR gc.email_send_claimed_at < (NOW() - INTERVAL '15 minutes'))
          ORDER BY gc.scheduled_send_on ASC, gc.id ASC
          LIMIT ${SELECT_LIMIT}`,
        // TZ: scheduled_send_on/expires_at sono date app-locali — 'oggi' di
        // Roma, non CURRENT_DATE UTC (tra mezzanotte e le 2 locali gli invii
        // del giorno restavano fermi e le scadute-di-oggi risultavano valide).
        // Il claim resta su NOW(): scrittura e confronto UTC coerenti tra loro.
        [tenantId, businessTodayIso(), businessTodayIso()],
      );

      if (!SEND_ENABLED) {
        // Provider not configured: surface the due count without consuming items.
        results.push({ tenant: slug, sent: 0, errors: 0, due: due.length });
        continue;
      }

      for (const row of due) {
        const id = Number(row.id ?? 0);
        const to = String(row.recipient_email ?? "").trim();
        const showAmount = Number(row.email_show_amount ?? 1) ? 1 : 0;

        if (id <= 0 || to === "") {
          errors += 1;
          continue;
        }

        // Atomically claim the row so concurrent runs don't double-send it.
        const claim = await dbExecute(
          `UPDATE giftcards
              SET email_send_claimed_at=NOW()
            WHERE tenant_id = ?
              AND id = ?
              AND status='active'
              AND scheduled_send_on IS NOT NULL
              AND scheduled_send_on <= ?
              AND (expires_at IS NULL OR expires_at >= ?)
              AND recipient_email IS NOT NULL
              AND recipient_email <> ''
              AND last_email_sent_at IS NULL
              AND (email_send_claimed_at IS NULL OR email_send_claimed_at < (NOW() - INTERVAL '15 minutes'))`,
          [tenantId, id, businessTodayIso(), businessTodayIso()],
        );
        if (claim.affectedRows <= 0) continue;

        // Delegate to the faithful builder: it sends the email AND writes the
        // success-path fields (last_email_sent_at/_to/_hide_amount, clears
        // scheduled_send_on + email_send_claimed_at). On failure it throws, so we
        // release the claim (last_email_sent_at stays NULL -> retriable next run).
        try {
          await sendGiftCardEmailManage(slug, id, to, showAmount === 1, String(row.gift_message ?? ""), 0);
          sent += 1;
        } catch {
          errors += 1;
          await dbExecute(
            `UPDATE giftcards
                SET email_send_claimed_at=NULL
              WHERE tenant_id = ?
                AND id = ?
                AND last_email_sent_at IS NULL`,
            [tenantId, id],
          );
        }
      }

      results.push({ tenant: slug, sent, errors });
      total += sent;
    }

    return Response.json({ ok: true, job: "giftcard-send", sendEnabled: SEND_ENABLED, total, results });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron giftcard-send." },
      { status: 500 },
    );
  }
}

export const POST = GET;
