import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  cancelManageGiftBoxInstance,
  deleteManageGiftBoxTemplate,
  getManageGiftBoxTemplate,
  giftFormCatalog,
  issueDbGiftBox,
  listDbClients,
  listDbGiftBoxes,
  listManageGiftboxRows,
  listManageGiftBoxTemplates,
  redeemDbGiftBox,
  redeemManageGiftBoxInstanceFull,
  saveManageGiftBoxTemplate,
} from "@/lib/db-repositories";
import { GIFT_EVENT_OPTIONS, getGiftBoxInstanceFull, redeemGiftBoxInstancePartial, sendGiftBoxInstanceEmail, updateGiftBoxInstanceData, updateGiftBoxInstanceExpiry, updateGiftBoxInstanceInternalNote } from "@/lib/gift-issue-details";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const giftBoxPerms = ["giftbox.manage", "pos.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftBoxPerms)) return jsonError("Permesso GiftBox mancante.", 403);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Template grid (giftbox.php tab=boxes). The box catalog the POS issues from.
    if (action === "templates") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", templates: await listManageGiftBoxTemplates(tenantSlug) });
    }

    // Template editor catalog (services/products for the items dropdowns).
    if (action === "context") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      const { services, products } = await giftFormCatalog(tenantSlug);
      return Response.json({ ok: true, sourceMode: "database", services, products });
    }

    // Edit-form prefill: ONE giftbox template + its items. Port of GiftBox::getGiftBox.
    if (action === "get") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      const templateId = parseInteger(url.searchParams.get("id"), 0);
      if (templateId <= 0) return jsonError("ID GiftBox mancante.");
      const template = await getManageGiftBoxTemplate(tenantSlug, templateId);
      if (!template) return jsonError("GiftBox non trovata.", 404);
      return Response.json({ ok: true, source: "giftbox?action=get", sourceMode: "database", template });
    }

    // Instance DETAIL (tab=instances action=view/edit_instance): vista legacy
    // completa (riepilogo, dati, riscatto per-item, movimenti con sede/operatore).
    if (action === "view" || action === "edit_instance") {
      const detail = await getGiftBoxInstanceFull(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("GiftBox non trovata.", 404);
      const clients = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ ok: true, sourceMode: "database", detail, clients, events: GIFT_EVENT_OPTIONS });
    }

    // Lista MANAGE legacy (giftbox.php tab=instances): righe con Mittente/Sede/
    // badge/Riscatto, filtrate sulla sede corrente salvo all_locations=1.
    if (action === "manage_list") {
      const allRows = await listManageGiftboxRows(tenantSlug);
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      const rows = filterLocationId > 0 ? allRows.filter((r) => r.locationId === 0 || r.locationId === filterLocationId) : allRows;
      return Response.json({ ok: true, sourceMode: "database", rows, totalCount: allRows.length, locationsCount: locationContext?.locations.length ?? 0 });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      giftBoxes: await listDbGiftBoxes(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftBox.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftBoxPerms)) return jsonError("Permesso GiftBox mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "issue";

  try {
    // Faithful giftbox TEMPLATE editor save (port of giftbox.php POST
    // action=new|edit / GiftBox::saveGiftBox). id=0 creates, id>0 updates.
    if (action === "save" || action === "new" || action === "edit") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      const template = await saveManageGiftBoxTemplate(tenantSlug, body, parseInteger(body.id, 0));
      return Response.json({ ok: true, source: "giftbox?action=save", sourceMode: "database", template, templates: await listManageGiftBoxTemplates(tenantSlug) });
    }

    // Soft-delete a giftbox template (port of giftbox.php tab=boxes action=delete).
    if (action === "delete") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      await deleteManageGiftBoxTemplate(tenantSlug, parseInteger(body.id, 0), session.user.id);
      return Response.json({ ok: true, source: "giftbox?action=delete", sourceMode: "database", templates: await listManageGiftBoxTemplates(tenantSlug) });
    }

    if (action === "issue") {
      const input = {
        clientId: parseInteger(body.client_id, 0),
        recipientName: body.recipient_name,
        serviceId: parseInteger(body.service_id, 0),
        sessions: parseInteger(body.sessions, 1),
        expiresAt: body.expires_at,
      };
      const giftBox = await issueDbGiftBox(input, tenantSlug);
      return Response.json({ ok: true, source: "giftbox?action=issue", sourceMode: "database", giftBox, giftBoxes: await listDbGiftBoxes(tenantSlug) });
    }

    if (action === "redeem") {
      const id = parseInteger(body.id);
      const quantity = parseInteger(body.quantity, 1);
      const giftBox = await redeemDbGiftBox(id, quantity, tenantSlug);
      return Response.json({ ok: true, source: "giftbox?action=redeem", sourceMode: "database", giftBox, giftBoxes: await listDbGiftBoxes(tenantSlug) });
    }

    // Redeem an ENTIRE instance (port of redeem_instance): all remaining -> redeemed.
    if (action === "redeem_full" || action === "redeem_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      await redeemManageGiftBoxInstanceFull(tenantSlug, id, session.user.id);
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=redeem_full", sourceMode: "database", detail });
    }

    // "Dati GiftBox" (port of _mode=update_instance): mittente/evento/nascondi
    // importo/destinatario/nota/dedica.
    if (action === "update_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const result = await updateGiftBoxInstanceData(tenantSlug, id, {
        senderClientId: parseInteger(body.client_id, 0),
        eventType: body.event_type,
        voucherHideAmount: ["1", "true", "on", "yes"].includes(String(body.voucher_hide_amount ?? "").toLowerCase()),
        recipientClientId: parseInteger(body.recipient_client_id, 0),
        recipientName: body.recipient_name,
        recipientEmail: body.recipient_email,
        note: body.note,
        giftMessage: body.gift_message,
      });
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=update_instance", sourceMode: "database", message: result.message, detail });
    }

    // Modale scadenza (port of _mode=update_instance_expiry).
    if (action === "update_instance_expiry") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const result = await updateGiftBoxInstanceExpiry(tenantSlug, id, String(body.expires_at ?? ""));
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=update_instance_expiry", sourceMode: "database", message: result.message, detail });
    }

    // Riscatto PARZIALE per-item (port of _mode=redeem_instance_partial):
    // redeem_qty_json = {"<instance_item_row_id>": qty} (stringa JSON:
    // parseRequestBody appiattisce i valori non-stringa).
    if (action === "redeem_instance_partial") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const qtyByRowId: Record<number, number> = {};
      try {
        const raw = JSON.parse(String(body.redeem_qty_json ?? body.redeem_qty ?? "{}"));
        if (raw && typeof raw === "object") {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const rowId = parseInteger(k, 0);
            const qty = parseInteger(v, 0);
            if (rowId > 0 && qty > 0) qtyByRowId[rowId] = qty;
          }
        }
      } catch { /* selezione vuota -> errore legacy sotto */ }
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
      const result = await redeemGiftBoxInstancePartial(
        tenantSlug,
        id,
        qtyByRowId,
        String(body.redeem_note ?? ""),
        session.user.id,
        locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
      );
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=redeem_instance_partial", sourceMode: "database", message: result.message, detail });
    }

    // Nota interna (port of _mode=update_instance_internal_note).
    if (action === "update_instance_internal_note") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const result = await updateGiftBoxInstanceInternalNote(tenantSlug, id, String(body.internal_note ?? body.note ?? ""));
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=update_instance_internal_note", sourceMode: "database", message: result.message, detail });
    }

    // Invio email voucher (port of _mode=send_email).
    if (action === "send_email") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const showDetails = ["1", "true", "on", "yes"].includes(String(body.show_details ?? "").toLowerCase());
      const result = await sendGiftBoxInstanceEmail(tenantSlug, id, String(body.send_to ?? ""), showDetails, String(body.send_gift_message ?? ""));
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=send_email", sourceMode: "database", message: result.message, detail });
    }

    // Cancel an instance (port of cancel / GiftBox::cancelInstance).
    if (action === "cancel" || action === "cancel_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      await cancelManageGiftBoxInstance(tenantSlug, id, session.user.id);
      const detail = await getGiftBoxInstanceFull(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=cancel", sourceMode: "database", detail });
    }

    return jsonError("Azione GiftBox non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftBox.");
  }
}
