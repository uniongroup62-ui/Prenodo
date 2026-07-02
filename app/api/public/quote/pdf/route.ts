import { renderQuotePdf } from "@/lib/quote-pdf";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PDF pubblico del preventivo — port of quote_public.php ?format=pdf ->
// quote_pdf_download (QuotePdf.php): stesso accesso via token (32/64 hex,
// bozza mai pubblica), stesse composizioni riga del PDF legacy (che compone le
// proprie linee, leggermente diverse dalla pagina: " | " e prefissi Tel:/Email:)
// e il fallback CONDIZIONI = quotes.terms || businesses.quote_terms (il PDF
// legacy usa terms_default quando il preventivo non ha termini propri).
// Filename legacy: Preventivo_<numero sanificato>.pdf.

const clean = (v: unknown) => String(v ?? "").trim();

function addressLine(address: string, cap: string, city: string, province: string): string {
  let cityLine = `${cap} ${city}`.trim();
  if (province) cityLine += ` (${province})`;
  const parts: string[] = [];
  if (address) parts.push(address);
  if (cityLine.trim()) parts.push(cityLine.trim());
  return parts.join(" - ");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = clean(url.searchParams.get("slug")).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const token = clean(url.searchParams.get("token"));
  if (!slug) return Response.json({ ok: false, error: "Attivita non specificata." }, { status: 400 });
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(token)) {
    return Response.json({ ok: false, error: "Link non valido." }, { status: 404 });
  }

  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "public_token = ?", params: [token], limit: 1 });
    const q = rows[0];
    if (!q) return Response.json({ ok: false, error: "Il link potrebbe essere scaduto o non valido." }, { status: 404 });
    let statusKey = clean(q.status).toLowerCase() || "draft";
    if (statusKey === "cancelled") statusKey = "canceled";
    if (statusKey === "draft") {
      return Response.json({ ok: false, error: "Il link non e attivo per questo preventivo." }, { status: 404 });
    }

    // Nome cliente: snapshot, poi la riga clients collegata.
    let clientName = clean(q.client_name);
    const clientId = Number(q.client_id ?? 0);
    if (!clientName && clientId > 0) {
      const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      clientName = clean(clientRows[0]?.full_name);
    }

    // Profilo azienda quote_* con i fallback + override location del preventivo.
    const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
    const biz = bizRows[0] ?? ({} as RowDataPacket);
    const bizInfo: string[] = [];
    const pushInfo = (label: string, value: string) => {
      if (value) bizInfo.push(`${label}: ${value}`);
    };
    pushInfo("P.IVA", clean(biz.quote_vat_number));
    pushInfo("C.F.", clean(biz.quote_tax_code));
    pushInfo("SDI", clean(biz.quote_sdi));
    pushInfo("PEC", clean(biz.quote_pec));
    pushInfo("Tel", clean(q.location_phone) || clean(biz.quote_phone));
    pushInfo("Email", clean(q.location_email) || clean(biz.quote_email) || clean(biz.email));
    pushInfo("Web", clean(biz.quote_website));

    // Righe cliente come il PDF legacy (Azienda:, indirizzo, tax bits, contatti).
    const clientLines: string[] = [];
    if (clean(q.client_company_name)) clientLines.push(`Azienda: ${clean(q.client_company_name)}`);
    const cAddr = addressLine(clean(q.client_address), clean(q.client_cap), clean(q.client_city), clean(q.client_province));
    if (cAddr) clientLines.push(cAddr);
    const taxBits: string[] = [];
    if (clean(q.client_vat_number)) taxBits.push(`P.IVA: ${clean(q.client_vat_number)}`);
    if (clean(q.client_tax_code)) taxBits.push(`C.F.: ${clean(q.client_tax_code)}`);
    if (clean(q.client_sdi)) taxBits.push(`SDI: ${clean(q.client_sdi)}`);
    if (clean(q.client_pec)) taxBits.push(`PEC: ${clean(q.client_pec)}`);
    if (taxBits.length) clientLines.push(taxBits.join(" | "));
    const contacts: string[] = [];
    if (clean(q.client_phone)) contacts.push(`Tel: ${clean(q.client_phone)}`);
    if (clean(q.client_email)) contacts.push(`Email: ${clean(q.client_email)}`);
    if (contacts.length) clientLines.push(contacts.join(" | "));

    const items = await tenantSelect<RowDataPacket>({
      slug,
      table: "quote_items",
      where: "quote_id = ?",
      params: [Number(q.id ?? 0)],
      orderBy: "position ASC, id ASC",
    }).catch(() => [] as RowDataPacket[]);

    // payment_methods: JSON array o fallback newline (come pagina/PDF legacy).
    const pmRaw = clean(q.payment_methods);
    let paymentMethods: string[] = [];
    if (pmRaw) {
      try {
        const decoded = JSON.parse(pmRaw);
        if (!Array.isArray(decoded)) throw new Error("not-array");
        const seen = new Set<string>();
        for (const v of decoded) {
          const s = clean(v);
          if (!s || seen.has(s)) continue;
          seen.add(s);
          paymentMethods.push(s);
          if (paymentMethods.length >= 50) break;
        }
      } catch {
        paymentMethods = pmRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
    }

    const money = (v: unknown) => Math.round((Math.max(0, Number(v ?? 0) || 0) + Number.EPSILON) * 100) / 100;
    const pdf = await renderQuotePdf({
      number: clean(q.number) || "—",
      quoteDate: q.quote_date ? String(q.quote_date).slice(0, 10) : null,
      validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : null,
      business: {
        companyName: clean(q.location_company_name) || clean(biz.quote_company_name) || clean(biz.name),
        addressLine: addressLine(clean(q.location_address) || clean(biz.quote_address) || clean(biz.address), clean(biz.quote_cap), clean(biz.quote_city), clean(biz.quote_province)),
        infoLine: bizInfo.join(" | "),
        footer: clean(biz.quote_footer),
      },
      clientName: clientName || "—",
      clientLines,
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
      paymentMethodsText: paymentMethods.join("\n"),
      // Fallback legacy del PDF: terms del preventivo, altrimenti i termini
      // predefiniti del profilo preventivi (businesses.quote_terms).
      terms: clean(q.terms) || clean(biz.quote_terms),
    });

    const safeNum = (clean(q.number) || "preventivo").replace(/[^A-Za-z0-9_-]+/g, "_");
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Preventivo_${safeNum}.pdf"`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "PDF non disponibile." }, { status: 400 });
  }
}
