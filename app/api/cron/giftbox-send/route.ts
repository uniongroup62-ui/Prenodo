import { activeTenantSlugs, assertCronAuth } from "@/lib/cron";
import { businessNowDateTime, businessTodayIso } from "@/lib/business-datetime";
import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/giftbox_send.php (+ GiftBox::expireDueInstances /
// GiftBox::sendDueScheduledGiftBoxes + GiftBox::sendGiftBoxEmail). For each
// active tenant it:
//   1. expires issued instances whose expires_at is in the past;
//   2. finds issued instances whose scheduled_send_on has arrived and that
//      were never emailed, claims each row (anti double-send), BUILDS and SENDS
//      the GiftBox email via SES, and only on a successful send records the
//      delivery on the row (last_email_sent_at/last_email_sent_to/
//      last_email_hide_details + clears the claim). On a send failure the claim
//      is released and the row is left untouched so a later run retries it.
//
// MySQL -> Postgres notes: CURDATE() -> CURRENT_DATE, NOW() kept, and the
// MySQL '0000-00-00 00:00:00' sentinel is dropped (Postgres can't store it, so
// "never sent" is simply last_email_sent_at IS NULL).
//
// Sending is gated on emailConfigured() (SES_FROM_EMAIL present). When email is
// NOT configured we keep the previous behaviour: expiry runs, due items are
// reported, but nothing is marked sent. Every statement is scoped by tenant_id.
const SELECT_LIMIT = 500;

// PHP GiftBox::eventMap() — per event_type title/subject/emoji used to build the
// GiftBox email. (The hero image — eventTemplateInfo()['image_abs'] — required a
// tenant base_url which Next does not have here, so it is omitted; see TODO on
// the claim/hero URL below.)
const EVENT_MAP: Record<string, { title: string; subject: string; emoji: string }> = {
  giftbox: { title: "Hai ricevuto una GiftBox!", subject: "Hai ricevuto una GiftBox", emoji: "🎁" },
  compleanno: { title: "Buon compleanno!", subject: "Buon compleanno! Hai ricevuto una GiftBox", emoji: "🎂" },
  anniversario: { title: "Buon anniversario!", subject: "Buon anniversario! Hai ricevuto una GiftBox", emoji: "💍" },
  san_valentino: { title: "Buon San Valentino!", subject: "Buon San Valentino! Hai ricevuto una GiftBox", emoji: "❤️" },
  natale: { title: "Buon Natale!", subject: "Buon Natale! Hai ricevuto una GiftBox", emoji: "🎄" },
  capodanno: { title: "Buon Capodanno!", subject: "Buon Capodanno! Hai ricevuto una GiftBox", emoji: "✨" },
  epifania: { title: "Buona Epifania!", subject: "Buona Epifania! Hai ricevuto una GiftBox", emoji: "🧹" },
  festa_donna: { title: "Buona Festa della Donna!", subject: "Buona Festa della Donna! Hai ricevuto una GiftBox", emoji: "🌼" },
  pasqua: { title: "Buona Pasqua!", subject: "Buona Pasqua! Hai ricevuto una GiftBox", emoji: "🐣" },
  pasquetta: { title: "Buona Pasquetta!", subject: "Buona Pasquetta! Hai ricevuto una GiftBox", emoji: "🧺" },
  festa_mamma: { title: "Buona Festa della Mamma!", subject: "Buona Festa della Mamma! Hai ricevuto una GiftBox", emoji: "🌷" },
  festa_papa: { title: "Buona Festa del Papà!", subject: "Buona Festa del Papà! Hai ricevuto una GiftBox", emoji: "👔" },
};

// PHP GiftBox::eventMap() default terms (setting_get('giftbox_terms') overrides).
const DEFAULT_TERMS = [
  "Voucher utilizzabile in più appuntamenti fino ad esaurimento del contenuto.",
  "Ad ogni utilizzo verranno scalati i singoli servizi/prodotti (riscatto parziale).",
  "Non convertibile in denaro e non rimborsabile.",
  "Presentare il codice (QR) o il codice alfanumerico in cassa per il riscatto.",
];

type DueInstance = RowDataPacket & {
  id: number;
  giftbox_id: number | null;
  voucher_public_token: string | null;
  code: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  client_name: string | null;
  giftbox_name: string | null;
  event_type: string | null;
  issued_at: string | null;
  expires_at: string | null;
  gift_message: string | null;
  note: string | null;
  email_show_details: number | null;
};

type BusinessSettings = RowDataPacket & {
  name: string | null;
  email: string | null;
  logo_path: string | null;
  giftbox_terms: string | null;
};

type ItemRow = RowDataPacket & {
  item_type: string | null;
  qty: number | null;
  service_name: string | null;
  product_name: string | null;
  custom_label: string | null;
  custom_details: string | null;
  service_snapshot_json: string | null;
};

// PHP h() — escape for HTML attribute/text contexts.
function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// PHP nl2br().
function nl2br(s: string): string {
  return s.replace(/(\r\n|\n\r|\n|\r)/g, "<br>$1");
}

// PHP GiftBox::isEmptySqlDate() / isExpiredSqlDate() date formatting in
// sendGiftBoxEmail()'s $fmtDate closure: '—' for empty, else d/m/Y.
function fmtDate(dt: string | null): string {
  const v = String(dt ?? "").trim();
  if (v === "" || v.startsWith("0000-00-00")) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Faithful port of GiftBox::sendGiftBoxEmail()'s HTML body builder. Returns the
// inner `content` HTML fed to buildModernEmailTemplate() (which supplies the
// branded wrapper, header logo and footer that the PHP modern-template wrapper
// added on top of this body) plus the subject line.
function buildGiftBoxEmail(params: {
  row: DueInstance;
  toEmail: string;
  showDetails: boolean;
  items: ItemRow[];
  termsRaw: string;
  bizName: string;
  voucherUrl: string;
}): { subject: string; content: string } {
  const { row, toEmail, showDetails, items, termsRaw, bizName, voucherUrl } = params;

  const code = String(row.code ?? "").trim();
  const recipientName = String(row.recipient_name ?? "").trim();
  const clientName = String(row.client_name ?? "").trim();
  const issuedAt = String(row.issued_at ?? "");
  const expiresAt = String(row.expires_at ?? "");
  const note = String(row.note ?? "").trim();

  let giftMessage = String(row.gift_message ?? "").trim();
  if (giftMessage.length > 2000) giftMessage = giftMessage.slice(0, 2000);

  let giftboxName = String(row.giftbox_name ?? "GiftBox").trim();
  if (giftboxName === "") giftboxName = "GiftBox";
  // POS technical names are not shown in the email (PHP regexes).
  if (/^POS\s*•\s*GiftBox/i.test(giftboxName) || /\bCliente\s+\d+\b/i.test(giftboxName)) {
    giftboxName = "GiftBox";
  }

  // Event template (title/subject/emoji).
  const evKey = String(row.event_type ?? "giftbox").trim().toLowerCase();
  const ev = EVENT_MAP[evKey] ?? EVENT_MAP.giftbox;
  const evTitle = ev.title || "Hai ricevuto una GiftBox!";
  const evSubjectBase = ev.subject || "Hai ricevuto una GiftBox";
  const evEmoji = ev.emoji || "🎁";

  // Subject: "<eventSubject> [<code>] - <bizName>" (clamped to 160).
  let subject = evSubjectBase;
  if (code !== "") subject += " " + code;
  subject += " - " + bizName;
  if (subject.length > 160) subject = subject.slice(0, 160);

  const validFrom = fmtDate(issuedAt);
  const validTo = expiresAt.trim() !== "" && !expiresAt.trim().startsWith("0000-00-00") ? fmtDate(expiresAt) : "—";

  // Items list.
  let itemsHtml: string;
  if (showDetails) {
    if (items.length > 0) {
      itemsHtml = '<ul style="margin:8px 0 0 18px; padding:0;">';
      for (const it of items) {
        const type = String(it.item_type ?? "").trim().toLowerCase();
        let qty = Number(it.qty ?? 1);
        if (!Number.isFinite(qty) || qty <= 0) qty = 1;

        let label = "";
        if (type === "service") label = String(it.service_name ?? "Servizio");
        else if (type === "product") label = String(it.product_name ?? "Prodotto");
        else label = String(it.custom_label ?? it.custom_details ?? "Elemento");
        label = label.trim();
        if (label === "") label = "Elemento";

        itemsHtml += "<li>" + h(label) + (qty > 1 ? " × " + qty : "") + "</li>";
      }
      itemsHtml += "</ul>";
    } else {
      itemsHtml = '<div style="color:#666;">(Nessun elemento)</div>';
    }
  } else {
    itemsHtml = '<div style="color:#666;">(Contenuto non mostrato. Per scoprirlo, mostra il codice in cassa.)</div>';
  }

  const owner = clientName !== "" ? clientName : "—";
  const recipient = recipientName !== "" ? recipientName : toEmail;

  const fromLine =
    clientName !== ""
      ? "Hai ricevuto una GiftBox acquistata da <strong>" + h(clientName) + "</strong>."
      : "Hai ricevuto una GiftBox.";

  // Conditions list (setting_get('giftbox_terms') overrides defaults).
  let termsLines: string[];
  const normTerms = termsRaw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normTerms === "") {
    termsLines = DEFAULT_TERMS;
  } else {
    termsLines = normTerms.split(/\n+/);
  }
  let termsHtml = '<div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:6px">';
  termsHtml += '<div style="font-weight:800;margin:0 0 8px 0">Condizioni</div>';
  termsHtml += '<ul style="margin:0 0 0 18px;padding:0;color:#374151">';
  for (const raw of termsLines) {
    let ln = String(raw).trim();
    if (ln === "") continue;
    ln = ln.replace(/^[-•\t\s]+/u, "");
    ln = ln.split("{BUSINESS_NAME}").join(bizName).split("{{BUSINESS_NAME}}").join(bizName).split("%BUSINESS_NAME%").join(bizName);
    termsHtml += "<li>" + h(ln) + "</li>";
  }
  termsHtml += "</ul></div>";

  // Hero header (no image: see TODO on hero/claim URL).
  const evHead = h((evEmoji + " " + evTitle).trim());
  const heroHtml =
    '<div style="border:1px solid #e5e7eb; border-radius:14px; overflow:hidden; margin:0 0 14px 0;">' +
    '<div style="padding:12px 14px; background:#0f766e; color:#fff; font-weight:600; font-size:16px;">' +
    evHead +
    "</div></div>";

  const safeBiz = h(bizName);
  const safeCode = h(code !== "" ? code : "—");

  const rowHtml = (label: string, value: string): string =>
    '<tr><td style="padding:6px 0;color:#6b7280;font-size:12px">' +
    h(label) +
    '</td><td align="right" style="padding:6px 0;font-weight:600">' +
    h(value) +
    "</td></tr>";

  // ---- body ----
  let html = "";

  let greet = "Ciao";
  if (recipientName !== "") greet += " " + recipientName;
  greet += "!";
  html += '<p style="margin:0 0 10px 0">' + h(greet) + "</p>";

  html += heroHtml;
  html += '<p style="margin:0 0 12px 0">' + fromLine + "</p>";

  if (giftMessage !== "") {
    html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
    html += '<div style="font-weight:800;margin-bottom:6px">Messaggio di dedica</div>';
    html += '<div style="white-space:pre-wrap">' + h(giftMessage) + "</div>";
    html += "</div>";
  }

  html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
  html += '<div style="font-weight:800;margin:0 0 8px 0">Dettagli GiftBox</div>';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">';
  html += rowHtml("GiftBox", giftboxName);
  html += rowHtml("Mittente", owner);
  html += rowHtml("Destinatario", recipient);
  html += rowHtml("Valida dal", validFrom);
  html += rowHtml("Valida fino al", validTo);
  html += "</table></div>";

  html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
  html += '<div style="font-weight:800;margin:0 0 8px 0">Contenuto GiftBox</div>';
  html += itemsHtml;
  html += "</div>";

  // Redemption code (no QR in email).
  html += '<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;margin:0 0 12px 0;background:#ffffff">';
  html += '<div style="color:#6b7280;font-size:12px">Codice di riscatto</div>';
  html += '<div style="font-size:28px;font-weight:600;letter-spacing:1px;margin-top:2px">' + safeCode + "</div>";
  html += '<div style="color:#6b7280;font-size:12px;margin-top:6px">MOSTRA QUESTO CODICE IN CASSA</div>';
  html += "</div>";

  // Voucher / claim button (only if we could build a claim URL).
  if (voucherUrl !== "") {
    const safeVoucher = h(voucherUrl);
    html +=
      '<div style="text-align:center;margin:0 0 18px 0;">' +
      '<a href="' +
      safeVoucher +
      '" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;letter-spacing:.2px">Vedi Voucher</a>' +
      "</div>";
  }

  html += termsHtml;
  html += '<p style="margin:14px 0 0 0;color:#666;font-size:12px">Messaggio automatico da ' + safeBiz + ".</p>";

  // Note for the client (PHP appended it to the dedication block; keep parity by
  // rendering it as its own paragraph after the body).
  if (note !== "") {
    html += '<p style="margin:12px 0 0 0;"><strong>Nota per il cliente:</strong><br>' + nl2br(h(note)) + "</p>";
  }

  return { subject, content: html };
}

export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // PHP GiftBox::giftBoxPublicVoucherAbsoluteUrl() built the claim/voucher link
  // from tenant_base_url(). Next has no tenant base URL here yet, so we read an
  // env base and append the legacy voucher route. When unset, the "Vedi Voucher"
  // button is simply omitted (the redemption code in the body is sufficient).
  // TODO: source a per-tenant public base URL (tenant_base_url equivalent) once
  // available, and likewise restore the hero event image (eventTemplateInfo
  // image_abs) which also needs an absolute base.
  const publicBase = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const sendEnabled = emailConfigured();

  try {
    const slugs = await activeTenantSlugs();
    const results: Array<{ tenant: string; sent: number; expired: number; errors: number; due?: number }> = [];
    let total = 0;

    for (const slug of slugs) {
      const tenantId = await tenantIdForSlug(slug);
      if (!tenantId) continue;

      let sent = 0;
      let errors = 0;

      // 1) Expire due issued instances (GiftBox::expireDueInstances()).
      const expiredRes = await dbExecute(
        `UPDATE giftbox_instances
            SET status='expired'
          WHERE tenant_id = ?
            AND status='issued'
            AND expires_at IS NOT NULL
            AND expires_at > '1000-01-01 00:00:00'
            AND expires_at < ?`,
        // TZ: expires_at è app-locale (Rome) — confine con l'ora locale, non
        // con NOW() UTC (scadenze applicate con 2h di ritardo).
        [tenantId, businessNowDateTime()],
      );
      const expired = expiredRes.affectedRows;

      // 2) Select due scheduled instances that still need sending. Joined to
      // giftboxes (name) and clients (sender name); all email fields come from
      // giftbox_instances (recipient, code, token, event, dates, message, note).
      const due = await dbQuery<DueInstance[]>(
        `SELECT gi.id, gi.giftbox_id, gi.voucher_public_token, gi.code,
                gi.recipient_name, gi.recipient_email,
                c.full_name AS client_name,
                gb.name AS giftbox_name,
                gi.event_type, gi.issued_at, gi.expires_at,
                gi.gift_message, gi.note,
                COALESCE(gi.email_show_details, 1) AS email_show_details
           FROM giftbox_instances gi
           JOIN giftboxes gb ON gb.id = gi.giftbox_id AND gb.tenant_id = gi.tenant_id
           LEFT JOIN clients c ON c.id = gi.client_id AND c.tenant_id = gi.tenant_id
          WHERE gi.tenant_id = ?
            AND gi.status='issued'
            AND gi.scheduled_send_on IS NOT NULL
            AND gi.scheduled_send_on <= ?
            AND (gi.expires_at IS NULL OR gi.expires_at >= ?)
            AND gi.last_email_sent_at IS NULL
            AND gi.recipient_email IS NOT NULL
            AND gi.recipient_email <> ''
            AND (gi.email_send_claimed_at IS NULL OR gi.email_send_claimed_at < (NOW() - INTERVAL '15 minutes'))
          ORDER BY gi.scheduled_send_on ASC, gi.id ASC
          LIMIT ${SELECT_LIMIT}`,
        // TZ: scheduled_send_on/expires_at app-locali — oggi/adesso di Roma
        // (con CURRENT_DATE UTC gli invii di oggi partivano solo dalle 2 di
        // notte locali). Il claim resta su NOW(): scrittura e confronto UTC
        // coerenti tra loro (finestra transiente di 15 minuti).
        [tenantId, businessTodayIso(), businessNowDateTime()],
      );

      if (!sendEnabled) {
        // Email provider not configured (SES_FROM_EMAIL unset): surface due
        // count, expiry already applied above. Mark nothing sent.
        results.push({ tenant: slug, sent: 0, expired, errors: 0, due: due.length });
        continue;
      }

      // Per-tenant business branding/settings (PHP setting_get from `businesses`).
      const bizRows = await dbQuery<BusinessSettings[]>(
        `SELECT name, email, logo_path, giftbox_terms
           FROM businesses
          WHERE tenant_id = ?
          ORDER BY id ASC
          LIMIT 1`,
        [tenantId],
      );
      const biz = bizRows[0];
      const bizName = String(biz?.name ?? "").trim() || "BeautySuite";
      const bizEmail = String(biz?.email ?? "").trim();
      const termsRaw = String(biz?.giftbox_terms ?? "");
      // Logo: businesses.logo_path is a relative path; only usable as an email
      // image with an absolute base. Build it from the public base when set.
      const logoPath = String(biz?.logo_path ?? "").trim();
      const bizLogoUrl =
        logoPath === ""
          ? ""
          : /^https?:\/\//i.test(logoPath)
            ? logoPath
            : publicBase !== ""
              ? publicBase + (logoPath.startsWith("/") ? "" : "/") + logoPath
              : "";

      for (const row of due) {
        const id = Number(row.id ?? 0);
        const to = String(row.recipient_email ?? "").trim();
        const showDetails = Number(row.email_show_details ?? 1) ? 1 : 0;

        if (id <= 0 || to === "") {
          errors += 1;
          continue;
        }

        // Atomically claim the row so concurrent runs don't double-send it.
        const claim = await dbExecute(
          `UPDATE giftbox_instances
              SET email_send_claimed_at=NOW()
            WHERE tenant_id = ?
              AND id = ?
              AND status='issued'
              AND scheduled_send_on IS NOT NULL
              AND scheduled_send_on <= ?
              AND (expires_at IS NULL OR expires_at >= ?)
              AND recipient_email IS NOT NULL
              AND recipient_email <> ''
              AND last_email_sent_at IS NULL
              AND (email_send_claimed_at IS NULL OR email_send_claimed_at < (NOW() - INTERVAL '15 minutes'))`,
          [tenantId, id, businessTodayIso(), businessNowDateTime()],
        );
        if (claim.affectedRows <= 0) continue;

        try {
          // Items (only needed when details are shown). Snapshot name wins over
          // the current service name (GiftBox::applyHistoricalSnapshotNames).
          let items: ItemRow[] = [];
          if (showDetails) {
            items = await dbQuery<ItemRow[]>(
              `SELECT ii.item_type, ii.qty,
                      COALESCE(NULLIF(s.name, ''), '') AS service_name,
                      COALESCE(NULLIF(p.name, ''), '') AS product_name,
                      ii.custom_label, ii.custom_details, ii.service_snapshot_json
                 FROM giftbox_instance_items ii
                 LEFT JOIN services s ON s.id = ii.service_id AND s.tenant_id = ii.tenant_id
                 LEFT JOIN products p ON p.id = ii.product_id AND p.tenant_id = ii.tenant_id
                WHERE ii.tenant_id = ?
                  AND ii.instance_id = ?
                ORDER BY COALESCE(ii.sort_order, 0) ASC, ii.giftbox_item_id ASC`,
              [tenantId, id],
            );
            // Apply historical service snapshot name when present.
            for (const it of items) {
              if (String(it.item_type ?? "").trim().toLowerCase() !== "service") continue;
              const raw = String(it.service_snapshot_json ?? "").trim();
              if (raw === "") continue;
              try {
                const snap = JSON.parse(raw) as { name?: unknown } | null;
                const snapName = String(snap?.name ?? "").trim();
                if (snapName !== "") it.service_name = snapName;
              } catch {
                // ignore malformed snapshot
              }
            }
          }

          // Claim/voucher URL (PHP giftBoxPublicVoucherAbsoluteUrl). Uses the
          // long public token, not the short code. Omitted when no base/token.
          const token = String(row.voucher_public_token ?? "").trim();
          const voucherUrl =
            publicBase !== "" && /^[0-9a-fA-F]{64}$/.test(token)
              ? `${publicBase}/${slug}/giftbox_voucher?public=1&embed=1&token=${encodeURIComponent(token)}`
              : "";

          const { subject, content } = buildGiftBoxEmail({
            row,
            toEmail: to,
            showDetails: showDetails === 1,
            items,
            termsRaw,
            bizName,
            voucherUrl,
          });

          const { html, text } = buildModernEmailTemplate(subject, content, {
            business_name: bizName,
            business_email: bizEmail,
            business_logo_url: bizLogoUrl,
          });

          const result = await sendEmail({
            to,
            subject,
            html,
            text,
            fromName: bizName,
            replyTo: bizEmail || undefined,
          });

          if (!result.ok) {
            errors += 1;
            // Release the claim so a later run retries (do NOT mark sent).
            await dbExecute(
              `UPDATE giftbox_instances
                  SET email_send_claimed_at=NULL
                WHERE tenant_id = ?
                  AND id = ?
                  AND last_email_sent_at IS NULL`,
              [tenantId, id],
            );
            continue;
          }

          // Successful send: record the delivery on the row (mirrors the
          // sendGiftBoxEmail success-path writes) and clear the claim.
          const recorded = await dbExecute(
            `UPDATE giftbox_instances
                SET last_email_sent_at=?,
                    last_email_sent_to=?,
                    last_email_hide_details=?,
                    email_send_claimed_at=NULL
              WHERE tenant_id = ?
                AND id = ?`,
            [businessNowDateTime(), to, showDetails ? 0 : 1, tenantId, id],
          );
          if (recorded.affectedRows > 0) {
            sent += 1;
          } else {
            // The send went out but the bookkeeping update matched no row.
            // Count it as sent (the email was delivered) and best-effort clear
            // the claim so it isn't stuck.
            sent += 1;
          }
        } catch {
          // Any failure building/sending: release the claim and count an error.
          errors += 1;
          await dbExecute(
            `UPDATE giftbox_instances
                SET email_send_claimed_at=NULL
              WHERE tenant_id = ?
                AND id = ?
                AND last_email_sent_at IS NULL`,
            [tenantId, id],
          );
        }
      }

      results.push({ tenant: slug, sent, expired, errors });
      total += sent;
    }

    return Response.json({ ok: true, job: "giftbox-send", sendEnabled, total, results });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron giftbox-send." },
      { status: 500 },
    );
  }
}

export const POST = GET;
