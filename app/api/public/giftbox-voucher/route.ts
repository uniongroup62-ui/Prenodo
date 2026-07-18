import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public GiftBox voucher API — DB-backed port of app/pages/giftbox_voucher.php's
// PUBLIC mode (index.php?page=giftbox_voucher&public=1&token=<64hex>). The PHP
// page loaded the instance via GiftBox::getInstanceFullByVoucherPublicToken()
// (token-only lookup; the short code is never used publicly), then rendered the
// voucher. Here we resolve the tenant from ?slug=, validate the 64-hex token,
// load the tenant-scoped instance + its items + redemption map, and return the
// data the faithful component renders. 64-hex validation; 404 on miss.
//
// Tables: giftbox_instances (instance) joined to giftboxes (name/description),
// clients (sender), plus giftbox_instance_items (with services/products) for the
// contents, and giftbox_redemptions/_items for the per-item redeemed quantities.
// Branding + terms come from the single per-tenant `businesses` row.

type InstanceRow = RowDataPacket & {
  id: number;
  giftbox_id: number | null;
  code: string | null;
  status: string | null;
  issued_at: string | null;
  expires_at: string | null;
  redeemed_at: string | null;
  cancelled_at: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  client_name: string | null;
  giftbox_name: string | null;
  giftbox_description: string | null;
  event_type: string | null;
  gift_message: string | null;
  note: string | null;
  voucher_hide_amount: number | null;
};

type ItemRow = RowDataPacket & {
  id: number | null;
  item_type: string | null;
  qty: number | null;
  custom_label: string | null;
  custom_details: string | null;
  service_name: string | null;
  service_price: string | number | null;
  service_snapshot_json: string | null;
  product_name: string | null;
  product_price: string | number | null;
};

type RedemptionItemRow = RowDataPacket & {
  giftbox_item_id: number | null;
  qty: number | null;
  redeemed_at: string | null;
};

type BusinessRow = RowDataPacket & {
  name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  giftbox_terms: string | null;
};

function isEmptyDate(value: string | null): boolean {
  const v = String(value ?? "").trim();
  return v === "" || v.startsWith("0000-00-00");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const slug = String(url.searchParams.get("slug") ?? "").trim();
    const token = String(url.searchParams.get("token") ?? "").trim().toLowerCase();

    // Token-only public lookup: must be exactly 64 hex chars (PHP
    // normalizeVoucherPublicToken). Reject anything else with 404.
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return Response.json({ ok: false, error: "Voucher GiftBox non trovato." }, { status: 404 });
    }

    const tenantId = await tenantIdForSlug(slug);
    if (!tenantId) {
      return Response.json({ ok: false, error: "Voucher GiftBox non trovato." }, { status: 404 });
    }

    const instRows = await dbQuery<InstanceRow[]>(
      `SELECT gi.id, gi.giftbox_id, gi.code, gi.status,
              gi.issued_at, gi.expires_at, gi.redeemed_at, gi.cancelled_at,
              gi.recipient_name, gi.recipient_email,
              c.full_name AS client_name,
              gb.name AS giftbox_name,
              gb.description AS giftbox_description,
              gi.event_type, gi.gift_message, gi.note,
              gi.voucher_hide_amount
         FROM giftbox_instances gi
         JOIN giftboxes gb ON gb.id = gi.giftbox_id AND gb.tenant_id = gi.tenant_id
         LEFT JOIN clients c ON c.id = gi.client_id AND c.tenant_id = gi.tenant_id
        WHERE gi.tenant_id = ?
          AND gi.voucher_public_token = ?
        LIMIT 1`,
      [tenantId, token],
    );
    const inst = instRows[0];
    if (!inst) {
      return Response.json({ ok: false, error: "Voucher GiftBox non trovato." }, { status: 404 });
    }

    const instanceId = Number(inst.id ?? 0);

    // Lazy-expire: if issued/active with a past expires_at, flip to expired (the
    // PHP page did the same UPDATE before rendering). Best effort.
    let status = String(inst.status ?? "").trim().toLowerCase();
    if ((status === "issued" || status === "active") && !isEmptyDate(inst.expires_at)) {
      const expTs = Date.parse(String(inst.expires_at).replace(" ", "T"));
      if (!Number.isNaN(expTs) && expTs < Date.now()) {
        await dbExecute(
          `UPDATE giftbox_instances SET status='expired' WHERE tenant_id = ? AND id = ? AND status='issued'`,
          [tenantId, instanceId],
        ).catch(() => {});
        status = "expired";
      }
    }

    // Instance items (services/products/custom). Snapshot name wins over the
    // current service name (GiftBox::applyHistoricalSnapshotNames).
    const itemRows = await dbQuery<ItemRow[]>(
      `SELECT ii.giftbox_item_id AS id, ii.item_type, ii.qty,
              ii.custom_label, ii.custom_details, ii.service_snapshot_json,
              s.name AS service_name, s.price AS service_price,
              p.name AS product_name, p.price AS product_price
         FROM giftbox_instance_items ii
         LEFT JOIN services s ON s.id = ii.service_id AND s.tenant_id = ii.tenant_id
         LEFT JOIN products p ON p.id = ii.product_id AND p.tenant_id = ii.tenant_id
        WHERE ii.tenant_id = ?
          AND ii.instance_id = ?
        ORDER BY COALESCE(ii.sort_order, 0) ASC, ii.giftbox_item_id ASC`,
      [tenantId, instanceId],
    );

    // Per-item redeemed quantities + last redemption time (partial redemption).
    const redemptionRows = await dbQuery<RedemptionItemRow[]>(
      `SELECT ri.giftbox_item_id, ri.qty, r.redeemed_at
         FROM giftbox_redemption_items ri
         JOIN giftbox_redemptions r ON r.id = ri.redemption_id AND r.tenant_id = ri.tenant_id
        WHERE ri.tenant_id = ?
          AND r.instance_id = ?`,
      [tenantId, instanceId],
    ).catch(() => [] as RedemptionItemRow[]);

    const redeemedMap = new Map<number, number>();
    let lastRedeemAt = "";
    for (const r of redemptionRows) {
      const itemId = Number(r.giftbox_item_id ?? 0);
      const q = Number(r.qty ?? 0);
      if (itemId > 0 && Number.isFinite(q) && q > 0) {
        redeemedMap.set(itemId, (redeemedMap.get(itemId) ?? 0) + q);
      }
      const dt = String(r.redeemed_at ?? "").trim();
      if (dt !== "" && (lastRedeemAt === "" || Date.parse(dt.replace(" ", "T")) > Date.parse(lastRedeemAt.replace(" ", "T")))) {
        lastRedeemAt = dt;
      }
    }

    // Build the items payload with snapshot names and used/remaining counts.
    let totalUnits = 0;
    let redeemedUnits = 0;
    const items = itemRows.map((it) => {
      const itemId = Number(it.id ?? 0);
      const type = String(it.item_type ?? "custom").trim().toLowerCase();
      let qty = Number(it.qty ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) qty = 1;
      totalUnits += qty;

      let serviceName = String(it.service_name ?? "");
      let servicePrice: number | null =
        it.service_price !== null && it.service_price !== "" ? Math.round(Number(it.service_price) * 100) / 100 : null;
      const rawSnap = String(it.service_snapshot_json ?? "").trim();
      if (type === "service" && rawSnap !== "") {
        try {
          const snap = JSON.parse(rawSnap) as { name?: unknown; price?: unknown } | null;
          const snapName = String(snap?.name ?? "").trim();
          if (snapName !== "") serviceName = snapName;
          if (snap?.price !== undefined && snap?.price !== null && snap?.price !== "") {
            servicePrice = Math.round(Number(snap.price) * 100) / 100;
          }
        } catch {
          // ignore malformed snapshot
        }
      }

      let label: string;
      let price: number | null = null;
      if (type === "service") {
        label = serviceName !== "" ? serviceName : "Servizio";
        price = servicePrice;
      } else if (type === "product") {
        label = String(it.product_name ?? "Prodotto");
        price = it.product_price !== null && it.product_price !== "" ? Math.round(Number(it.product_price) * 100) / 100 : null;
      } else {
        label = String(it.custom_label ?? "Voce");
        const det = String(it.custom_details ?? "").trim();
        if (det !== "") label += " — " + det;
      }

      let used = itemId > 0 ? redeemedMap.get(itemId) ?? 0 : 0;
      if (used < 0) used = 0;
      if (used > qty) used = qty;
      const remaining = Math.max(0, qty - used);
      redeemedUnits += used;

      return { id: itemId, type, label, qty, used, remaining, price };
    });

    const remainingUnits = Math.max(0, totalUnits - redeemedUnits);

    // Business branding + terms (single per-tenant row).
    const bizRows = await dbQuery<BusinessRow[]>(
      `SELECT name, address, phone, email, giftbox_terms
         FROM businesses
        WHERE tenant_id = ?
        ORDER BY id ASC
        LIMIT 1`,
      [tenantId],
    );
    const biz = bizRows[0] ?? null;

    // Public voucher: amount visibility is driven by the instance flag (never the
    // query string), matching the PHP public branch.
    const hideAmount = Number(inst.voucher_hide_amount ?? 0) === 1;

    return Response.json({
      ok: true,
      voucher: {
        code: String(inst.code ?? ""),
        status,
        issuedAt: String(inst.issued_at ?? ""),
        expiresAt: String(inst.expires_at ?? ""),
        redeemedAt: String(inst.redeemed_at ?? ""),
        cancelledAt: String(inst.cancelled_at ?? ""),
        lastRedeemAt,
        recipientName: String(inst.recipient_name ?? "").trim(),
        recipientEmail: String(inst.recipient_email ?? "").trim(),
        clientName: String(inst.client_name ?? "").trim(),
        giftboxName: String(inst.giftbox_name ?? "GiftBox"),
        giftboxDescription: String(inst.giftbox_description ?? "").trim(),
        giftMessage: String(inst.gift_message ?? "").trim(),
        note: String(inst.note ?? "").trim(),
        hideAmount,
        totalUnits,
        remainingUnits,
        items,
      },
      business: {
        name: String(biz?.name ?? "Prenodo"),
        address: String(biz?.address ?? "").trim(),
        phone: String(biz?.phone ?? "").trim(),
        email: String(biz?.email ?? "").trim(),
        terms: String(biz?.giftbox_terms ?? ""),
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore voucher GiftBox." },
      { status: 500 },
    );
  }
}
