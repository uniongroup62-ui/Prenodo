import { businessTodayIso } from "@/lib/business-datetime";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public quote API — DB-backed port of app/pages/quote_public.php (accesso via
// token, nessuna autenticazione): validate the 32/64-hex public_token, load the
// tenant-scoped quote + items + the business quote profile (businesses.quote_*
// columns with the legacy fallbacks), compute the EFFECTIVE status (draft is
// never public -> 404; a 'sent' quote past valid_until reads 'expired') and
// return the display payload. The PDF download (format=pdf) is NOT ported —
// the PDF generation is deferred infra (QuotePdf/S3).

const STATUS_LABELS: Record<string, string> = {
  draft: "Bozza",
  sent: "Inviato",
  expired: "Scaduto",
  accepted: "Accettato",
  paid: "Pagato",
  rejected: "Rifiutato",
  canceled: "Annullato",
};
const STATUS_BADGES: Record<string, string> = {
  sent: "primary",
  accepted: "success",
  paid: "success",
  rejected: "danger",
  canceled: "dark",
  expired: "warning",
};

const money = (v: unknown) => Math.round((Math.max(0, Number(v ?? 0) || 0) + Number.EPSILON) * 100) / 100;
const clean = (v: unknown) => String(v ?? "").trim();

// The legacy address line: "address - CAP city (PROV)".
function addressLine(address: string, cap: string, city: string, province: string): string {
  let cityLine = `${cap} ${city}`.trim();
  if (province) cityLine += ` (${province})`;
  const parts: string[] = [];
  if (address) parts.push(address);
  if (cityLine.trim()) parts.push(cityLine.trim());
  return parts.join(" - ");
}

function labelRows(pairs: Array<[string, string]>): Array<{ label: string; value: string }> {
  return pairs.filter(([, value]) => value !== "").map(([label, value]) => ({ label, value }));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = String(url.searchParams.get("slug") ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const token = String(url.searchParams.get("token") ?? "").trim();
  if (!slug) return Response.json({ ok: false, error: "Attivita non specificata." }, { status: 400 });
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(token)) {
    return Response.json({ ok: false, error: "Link non valido." }, { status: 404 });
  }

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "quotes",
      where: "public_token = ?",
      params: [token],
      limit: 1,
    });
    const q = rows[0];
    if (!q) return Response.json({ ok: false, error: "Il link potrebbe essere scaduto o non valido." }, { status: 404 });

    // Effective status (quote_sale_effective_status port): cancelled->canceled;
    // a DRAFT is never public; a SENT quote past valid_until reads expired.
    let statusKey = clean(q.status).toLowerCase() || "draft";
    if (statusKey === "cancelled") statusKey = "canceled";
    if (statusKey === "draft") {
      return Response.json({ ok: false, error: "Il link non e attivo per questo preventivo." }, { status: 404 });
    }
    const validUntil = q.valid_until ? String(q.valid_until).slice(0, 10) : "";
    if (statusKey === "sent" && /^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      // OGGI di ROMA (classe TZ server-safe: i componenti locali del server
      // sbaglierebbero giorno nella finestra serale su un server UTC — lo
      // stato 'Scaduto' del link pubblico si accenderebbe col giorno sfasato).
      if (validUntil < businessTodayIso()) statusKey = "expired";
    }

    // Client display name: snapshot first, then the linked client row.
    let clientName = clean(q.client_name);
    const clientId = Number(q.client_id ?? 0);
    if (!clientName && clientId > 0) {
      const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      clientName = clean(clientRows[0]?.full_name);
    }

    // Business quote profile (app_business_quote_profile port: quote_* columns
    // with the plain business fields as fallback), then the per-quote location
    // overrides (location_address/phone/email) like the legacy fallback branch.
    const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
    const biz = bizRows[0] ?? ({} as RowDataPacket);
    const profile = {
      companyName: clean(q.location_company_name) || clean(biz.quote_company_name) || clean(biz.name),
      vat: clean(biz.quote_vat_number),
      taxCode: clean(biz.quote_tax_code),
      sdi: clean(biz.quote_sdi),
      pec: clean(biz.quote_pec),
      address: clean(q.location_address) || clean(biz.quote_address) || clean(biz.address),
      cap: clean(biz.quote_cap),
      city: clean(biz.quote_city),
      province: clean(biz.quote_province),
      phone: clean(q.location_phone) || clean(biz.quote_phone),
      email: clean(q.location_email) || clean(biz.quote_email) || clean(biz.email),
      website: clean(biz.quote_website),
      footer: clean(biz.quote_footer),
    };

    const items = await tenantSelect<RowDataPacket>({
      slug,
      table: "quote_items",
      where: "quote_id = ?",
      params: [Number(q.id ?? 0)],
      orderBy: "position ASC, id ASC",
    }).catch(() => [] as RowDataPacket[]);

    // payment_methods: JSON array or newline-separated fallback (legacy 110-126).
    const pmRaw = clean(q.payment_methods);
    let paymentMethods: string[] = [];
    if (pmRaw) {
      try {
        const decoded = JSON.parse(pmRaw);
        if (Array.isArray(decoded)) {
          const seen = new Set<string>();
          for (const v of decoded) {
            const s = clean(v);
            if (!s || seen.has(s)) continue;
            seen.add(s);
            paymentMethods.push(s);
            if (paymentMethods.length >= 50) break;
          }
        } else {
          throw new Error("not-array");
        }
      } catch {
        paymentMethods = pmRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
    }

    return Response.json({
      ok: true,
      quote: {
        number: clean(q.number) || "—",
        quoteDate: q.quote_date ? String(q.quote_date).slice(0, 10) : null,
        validUntil: validUntil || null,
        statusKey,
        statusLabel: STATUS_LABELS[statusKey] ?? statusKey,
        badge: STATUS_BADGES[statusKey] ?? "secondary",
        clientName: clientName || "—",
        clientRows: labelRows([
          ["Azienda", clean(q.client_company_name)],
          ["Indirizzo", addressLine(clean(q.client_address), clean(q.client_cap), clean(q.client_city), clean(q.client_province))],
          ["P.IVA", clean(q.client_vat_number)],
          ["C.F.", clean(q.client_tax_code)],
          ["SDI", clean(q.client_sdi)],
          ["PEC", clean(q.client_pec)],
          ["Telefono", clean(q.client_phone)],
          ["Email", clean(q.client_email)],
        ]),
        business: {
          companyName: profile.companyName || "—",
          rows: labelRows([
            ["Indirizzo", addressLine(profile.address, profile.cap, profile.city, profile.province)],
            ["P.IVA", profile.vat],
            ["C.F.", profile.taxCode],
            ["SDI", profile.sdi],
            ["PEC", profile.pec],
            ["Telefono", profile.phone],
            ["Email", profile.email],
            ["Web", profile.website],
          ]),
          footer: profile.footer,
        },
        items: items.map((it) => ({
          description: clean(it.description),
          sku: clean(it.sku),
          discountPercent: Math.max(0, Number(it.discount_percent ?? 0) || 0),
          qty: Math.max(0, Number(it.qty ?? 1) || 1),
          unitPrice: money(it.unit_price),
          taxRate: Math.max(0, Number(it.tax_rate ?? 0) || 0),
          lineTotal: money(it.line_total),
        })),
        subtotal: money(q.subtotal),
        discountTotal: money(q.discount_total),
        taxTotal: money(q.tax_total),
        total: money(q.total),
        publicNote: clean(q.public_note),
        paymentMethods,
        terms: clean(q.terms),
      },
    });
  } catch (error) {
    // Solo messaggi di dominio al pubblico; il tecnico (pg/rete) va nei log.
    const message = error instanceof Error ? error.message : "";
    const isTechnical = !message || /relation|column|syntax|SQLSTATE|ECONN|ETIMEDOUT|ENOTFOUND|timeout|SSL|pool|connect/i.test(message);
    if (isTechnical) console.error("[public/quote GET]", message || error);
    return Response.json({ ok: false, error: isTechnical ? "Preventivo non disponibile." : message }, { status: 400 });
  }
}
