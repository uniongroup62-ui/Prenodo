import { dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public GiftCard voucher API — DB-backed port of app/pages/giftcard_voucher.php's
// PUBLIC mode (index.php?page=giftcard_voucher&public=1&token=<64hex>). The PHP
// page loaded the card via GiftCard::getGiftCardByPublicToken() (token-only;
// the short code stays a cashier secret), then rendered the voucher. Here we
// resolve the tenant from ?slug=, validate the 64-hex token, load the
// tenant-scoped giftcard + its items, and return the voucher data. 64-hex
// validation; 404 on miss.
//
// Tables: giftcards (card) joined to clients (sender), plus giftcard_items
// (services/products included). Branding/address + terms come from the single
// per-tenant `businesses` row (structured site_* address fields, like the PHP).

type GiftcardRow = RowDataPacket & {
  id: number;
  code: string | null;
  status: string | null;
  initial_amount: string | number | null;
  balance: string | number | null;
  issued_at: string | null;
  expires_at: string | null;
  redeemed_at: string | null;
  cancelled_at: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  client_name: string | null;
  event_type: string | null;
  gift_message: string | null;
  note: string | null;
  voucher_hide_amount: number | null;
};

type GiftcardItemRow = RowDataPacket & {
  item_type: string | null;
  display_name: string | null;
  qty: number | null;
};

type BusinessRow = RowDataPacket & {
  name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  site_region: string | null;
  site_province: string | null;
  site_city: string | null;
  site_cap: string | null;
  site_address: string | null;
  giftcard_terms: string | null;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const slug = String(url.searchParams.get("slug") ?? "").trim();
    const token = String(url.searchParams.get("token") ?? "").trim().toLowerCase();

    // Token-only public lookup: exactly 64 hex chars (PHP publicTokenValid).
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return Response.json({ ok: false, error: "Voucher GiftCard non trovato." }, { status: 404 });
    }

    const tenantId = await tenantIdForSlug(slug);
    if (!tenantId) {
      return Response.json({ ok: false, error: "Voucher GiftCard non trovato." }, { status: 404 });
    }

    const gcRows = await dbQuery<GiftcardRow[]>(
      `SELECT gc.id, gc.code, gc.status,
              gc.initial_amount, gc.balance,
              gc.issued_at, gc.expires_at, gc.redeemed_at, gc.cancelled_at,
              gc.recipient_name, gc.recipient_email,
              c.full_name AS client_name,
              gc.event_type, gc.gift_message, gc.note,
              gc.voucher_hide_amount
         FROM giftcards gc
         LEFT JOIN clients c ON c.id = gc.client_id AND c.tenant_id = gc.tenant_id
        WHERE gc.tenant_id = ?
          AND gc.voucher_public_token = ?
        LIMIT 1`,
      [tenantId, token],
    );
    const gc = gcRows[0];
    if (!gc) {
      return Response.json({ ok: false, error: "Voucher GiftCard non trovato." }, { status: 404 });
    }

    const giftcardId = Number(gc.id ?? 0);

    // Items (services/products). display_name mirrors GiftCard::listItems()'s
    // COALESCE(item_name, service.name, product.name).
    const itemRows = await dbQuery<GiftcardItemRow[]>(
      `SELECT i.item_type,
              COALESCE(i.item_name,
                       CASE WHEN i.item_type='service' THEN s.name END,
                       CASE WHEN i.item_type='product' THEN p.name END
              ) AS display_name,
              i.qty
         FROM giftcard_items i
         LEFT JOIN services s ON i.item_type='service' AND s.id = i.item_id AND s.tenant_id = i.tenant_id
         LEFT JOIN products p ON i.item_type='product' AND p.id = i.item_id AND p.tenant_id = i.tenant_id
        WHERE i.tenant_id = ?
          AND i.giftcard_id = ?
        ORDER BY i.id ASC`,
      [tenantId, giftcardId],
    ).catch(() => [] as GiftcardItemRow[]);

    const items = itemRows.map((it) => {
      const type = String(it.item_type ?? "").toLowerCase();
      let name = String(it.display_name ?? "").trim();
      if (name === "") name = type === "product" ? "Prodotto" : "Servizio";
      let qty = Number(it.qty ?? 0);
      if (!Number.isFinite(qty)) qty = 0;
      return { type, name, qty };
    });

    // Business branding + structured address + terms (single per-tenant row).
    const bizRows = await dbQuery<BusinessRow[]>(
      `SELECT name, address, phone, email,
              site_region, site_province, site_city, site_cap, site_address,
              giftcard_terms
         FROM businesses
        WHERE tenant_id = ?
        ORDER BY id ASC
        LIMIT 1`,
      [tenantId],
    );
    const biz = bizRows[0] ?? null;

    // Build the 3 address lines exactly like the PHP (structured site_* with a
    // fallback to the legacy single-string address).
    const siteAddress = String(biz?.site_address ?? "").trim() || String(biz?.address ?? "").trim();
    const siteCap = String(biz?.site_cap ?? "").trim();
    const siteCity = String(biz?.site_city ?? "").trim();
    const siteProvince = String(biz?.site_province ?? "").trim();
    const siteRegion = String(biz?.site_region ?? "").trim();

    let cityLine = ((siteCap !== "" ? siteCap + " " : "") + siteCity).trim();
    if (siteProvince !== "") cityLine = cityLine !== "" ? `${cityLine} (${siteProvince})` : `(${siteProvince})`;

    const initial = Math.round(Number(gc.initial_amount ?? 0) * 100) / 100;
    const balance = Math.round(Number(gc.balance ?? 0) * 100) / 100;
    // Public voucher: amount visibility is driven by the card flag, never the
    // query string (PHP public branch).
    const hideAmount = Number(gc.voucher_hide_amount ?? 0) === 1;

    return Response.json({
      ok: true,
      voucher: {
        code: String(gc.code ?? ""),
        status: String(gc.status ?? "").trim().toLowerCase(),
        initialAmount: initial,
        balance,
        issuedAt: String(gc.issued_at ?? ""),
        expiresAt: String(gc.expires_at ?? ""),
        redeemedAt: String(gc.redeemed_at ?? ""),
        cancelledAt: String(gc.cancelled_at ?? ""),
        recipientName: String(gc.recipient_name ?? "").trim(),
        recipientEmail: String(gc.recipient_email ?? "").trim(),
        clientName: String(gc.client_name ?? "").trim(),
        giftMessage: String(gc.gift_message ?? "").trim(),
        note: String(gc.note ?? "").trim(),
        hideAmount,
        items,
      },
      business: {
        name: String(biz?.name ?? "Prenodo"),
        addrLine1: siteAddress,
        addrLine2: cityLine,
        addrLine3: siteRegion,
        phone: String(biz?.phone ?? "").trim(),
        email: String(biz?.email ?? "").trim(),
        terms: String(biz?.giftcard_terms ?? ""),
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore voucher GiftCard." },
      { status: 500 },
    );
  }
}
