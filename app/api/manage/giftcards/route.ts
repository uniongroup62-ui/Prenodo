import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { getManageGiftCard, issueDbGiftCard, listDbClients, listDbGiftCards, listManageGiftcardRows, redeemDbGiftCard, updateManageGiftCard } from "@/lib/db-repositories";
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

    // Card DETAIL (action=view/edit): header + balance + transactions + linked
    // sale + redeem/edit eligibility. Also returns the clients list for the
    // recipient picker.
    if (action === "view" || action === "edit") {
      const detail = await getManageGiftCard(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("GiftCard non trovata.", 404);
      const clients = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ ok: true, sourceMode: "database", detail, clients });
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
      const detail = await getManageGiftCard(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=redeem", sourceMode: "database", detail, giftCards: await listDbGiftCards(tenantSlug) });
    }

    // Update a card's recipient/note/expiry (port of update / update_note / update_expiry).
    if (action === "update") {
      const id = parseInteger(body.id);
      await updateManageGiftCard(tenantSlug, id, {
        recipientClientId: parseInteger(body.recipient_client_id, 0),
        recipientName: body.recipient_name,
        recipientEmail: body.recipient_email,
        giftMessage: body.gift_message,
        internalNote: body.internal_note,
        expiresAt: body.expires_at,
      });
      const detail = await getManageGiftCard(tenantSlug, id);
      return Response.json({ ok: true, source: "giftcard?action=update", sourceMode: "database", detail });
    }

    return jsonError("Azione GiftCard non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftCard.");
  }
}
