import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { issueDbGiftCard, listDbClients, listDbGiftCards, listManageGiftcardRows, redeemDbGiftCard } from "@/lib/db-repositories";
import { GIFT_EVENT_OPTIONS, getGiftCardFull, redeemGiftCardItemManage, sendGiftCardEmailManage, updateGiftCardData, updateGiftCardExpiry, updateGiftCardInternalNote } from "@/lib/gift-issue-details";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const giftCardPerms = ["giftcard.manage", "pos.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftCardPerms)) return jsonError("Permesso GiftCard mancante.", 403);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Card DETAIL (action=view/edit): vista legacy completa (riepilogo, dati,
    // items, movimenti con sede/operatore, eleggibilità scadenza).
    if (action === "view" || action === "edit") {
      const detail = await getGiftCardFull(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("GiftCard non trovata.", 404);
      const clients = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ ok: true, sourceMode: "database", detail, clients, events: GIFT_EVENT_OPTIONS });
    }

    // Lista MANAGE legacy (giftcard.php list): righe con Mittente/Sede/badge,
    // filtrate sulla sede corrente salvo all_locations=1 (0 = nessuna sede =
    // sempre visibile); l'empty state usa il conteggio NON filtrato.
    if (action === "manage_list") {
      const allRows = await listManageGiftcardRows(tenantSlug);
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      const rows = filterLocationId > 0 ? allRows.filter((r) => r.locationId === 0 || r.locationId === filterLocationId) : allRows;
      return Response.json({ ok: true, sourceMode: "database", rows, totalCount: allRows.length, locationsCount: locationContext?.locations.length ?? 0 });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      giftCards: await listDbGiftCards(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftCard.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftCardPerms)) return jsonError("Permesso GiftCard mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "issue";

  try {
    if (action === "issue") {
      const input = {
        clientId: parseInteger(body.client_id, 0),
        recipientName: body.recipient_name,
        initialAmount: parseNumber(body.amount, 0),
        expiresAt: body.expires_at,
      };
      const giftCard = await issueDbGiftCard(input, tenantSlug);
      return Response.json({ ok: true, source: "giftcard?action=issue", sourceMode: "database", giftCard, giftCards: await listDbGiftCards(tenantSlug) });
    }

    if (action === "redeem") {
      const id = parseInteger(body.id);
      const amount = parseNumber(body.amount ?? body.redeem_amount, 0);
      await redeemDbGiftCard(id, amount, tenantSlug, body.note ?? body.redeem_note);
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=redeem", sourceMode: "database", message: "Riscatto registrato", detail, giftCards: await listDbGiftCards(tenantSlug) });
    }

    // "Dati GiftCard" (port of _mode=update): mittente/evento/nascondi importo/
    // destinatario/nota/dedica.
    if (action === "update") {
      const id = parseInteger(body.id);
      const result = await updateGiftCardData(tenantSlug, id, {
        senderClientId: parseInteger(body.client_id, 0),
        eventType: body.event_type,
        voucherHideAmount: ["1", "true", "on", "yes"].includes(String(body.voucher_hide_amount ?? "").toLowerCase()),
        recipientClientId: parseInteger(body.recipient_client_id, 0),
        recipientName: body.recipient_name,
        recipientEmail: body.recipient_email,
        note: body.note,
        giftMessage: body.gift_message,
      });
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=update", sourceMode: "database", message: result.message, detail });
    }

    // Modale scadenza (port of _mode=update_expiry).
    if (action === "update_expiry") {
      const id = parseInteger(body.id);
      const result = await updateGiftCardExpiry(tenantSlug, id, String(body.expires_at ?? ""));
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=update_expiry", sourceMode: "database", message: result.message, detail });
    }

    // Nota interna (port of _mode=update_internal_note).
    if (action === "update_internal_note") {
      const id = parseInteger(body.id);
      const result = await updateGiftCardInternalNote(tenantSlug, id, String(body.internal_note ?? ""));
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=update_internal_note", sourceMode: "database", message: result.message, detail });
    }

    // Riscatto per-item (port of _mode=redeem_item).
    if (action === "redeem_item") {
      const id = parseInteger(body.id);
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
      const result = await redeemGiftCardItemManage(
        tenantSlug,
        id,
        parseInteger(body.item_row_id, 0),
        parseInteger(body.item_qty, 1),
        String(body.item_note ?? ""),
        session.user.id,
        locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
      );
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=redeem_item", sourceMode: "database", message: result.message, detail });
    }

    // Invio email voucher (port of _mode=send_email).
    if (action === "send_email") {
      const id = parseInteger(body.id);
      const showAmount = ["1", "true", "on", "yes"].includes(String(body.show_amount ?? "").toLowerCase());
      const result = await sendGiftCardEmailManage(tenantSlug, id, String(body.send_to ?? ""), showAmount, String(body.send_gift_message ?? ""));
      const detail = await getGiftCardFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=send_email", sourceMode: "database", message: result.message, detail });
    }

    return jsonError("Azione GiftCard non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftCard.");
  }
}
