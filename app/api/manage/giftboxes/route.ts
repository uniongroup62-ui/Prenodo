import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  cancelManageGiftBoxInstance,
  deleteManageGiftBoxTemplate,
  getManageGiftBoxTemplate,
  giftFormCatalog,
  issueDbGiftBox,
  listDbClients,
  listDbGiftBoxes,
  listManageGiftBoxTemplates,
  redeemDbGiftBox,
  redeemManageGiftBoxInstanceFull,
  saveManageGiftBoxTemplate,
} from "@/lib/db-repositories";
import {
  GIFTBOX_EVENT_OPTIONS,
  expireDueGiftBoxInstances,
  getGiftBoxInstanceFull,
  hasAnyGiftBoxInstances,
  listGiftBoxInstancesManage,
  redeemGiftBoxInstancePartial,
  searchGiftRecipientClients,
  sendGiftBoxInstanceEmail,
  updateGiftBoxInstanceData,
  updateGiftBoxInstanceExpiry,
  updateGiftBoxInstanceInternalNote,
} from "@/lib/gift-issue-details";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessById, getManageLocationContext, sessionAllowedLocationIds } from "@/lib/manage-locations";
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
    if (action === "perms") {
      return Response.json({ ok: true, canSettings: can(session.user.perms, "giftbox.settings"), canCreate: can(session.user.perms, "pos.manage") });
    }

    if (action === "templates") {
      if (!can(session.user.perms, "giftbox.manage")) return jsonError("Permesso GiftBox mancante.", 403);
      return Response.json({
        ok: true,
        sourceMode: "database",
        templates: await listManageGiftBoxTemplates(tenantSlug),
        canSettings: can(session.user.perms, "giftbox.settings"),
        canCreate: can(session.user.perms, "pos.manage"),
      });
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
      await expireDueGiftBoxInstances(tenantSlug);
      await assertLocationAccessById(tenantSlug, "giftbox_instances", parseInteger(url.searchParams.get("id"), 0), sessionAllowedLocationIds(session), "GiftBox non disponibile per le tue sedi.");
      const detail = await getGiftBoxInstanceFull(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("Istanza non trovata", 404);
      const clients = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: c.id, name: c.name }));
      return Response.json({
        ok: true,
        sourceMode: "database",
        detail,
        clients,
        events: GIFTBOX_EVENT_OPTIONS,
        canSettings: can(session.user.perms, "giftbox.settings"),
        canCreate: can(session.user.perms, "pos.manage"),
      });
    }

    // Ricerca clienti per il destinatario (api_clients.php action=search).
    if (action === "client_search") {
      const clients = await searchGiftRecipientClients(tenantSlug, url.searchParams.get("q") ?? "");
      return Response.json({ ok: true, clients });
    }

    // Lista MANAGE legacy (giftbox.php tab=instances): filtri server-side
    // Mittente/Cerca/Stato (+ sede corrente salvo all_locations=1), auto-expire
    // al load, righe con Sede/badge/date raw come il PHP.
    if (action === "manage_list") {
      await expireDueGiftBoxInstances(tenantSlug);
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      const rows = await listGiftBoxInstancesManage(tenantSlug, {
        q: url.searchParams.get("q") ?? "",
        status: url.searchParams.get("status") ?? "",
        clientId: parseInteger(url.searchParams.get("client_id"), 0),
        locationId: filterLocationId,
      }, 200);
      const hasAny = await hasAnyGiftBoxInstances(tenantSlug);
      const clientRows = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: String(c.id), label: c.name }));
      return Response.json({
        ok: true,
        sourceMode: "database",
        rows,
        hasAnyInstances: hasAny,
        clientItems: clientRows,
        showAllLocationsFilter: (locationContext?.locations.length ?? 0) > 1,
        canSettings: can(session.user.perms, "giftbox.settings"),
        canCreate: can(session.user.perms, "pos.manage"),
      });
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
    // Guardia per-sede sulle azioni relative a un'ISTANZA esistente (per id); i template sono
    // tenant-wide (nessuna location). location_id istanza valorizzato solo al riscatto/POS; NULL = ok.
    const gbInstanceActions = new Set(["redeem", "redeem_full", "redeem_instance", "update_instance", "update_instance_expiry", "redeem_instance_partial", "update_instance_internal_note", "send_email", "cancel", "cancel_instance"]);
    if (gbInstanceActions.has(String(action))) {
      await assertLocationAccessById(tenantSlug, "giftbox_instances", parseInteger(body.id, 0), sessionAllowedLocationIds(session), "GiftBox non disponibile per le tue sedi.");
    }
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
    // importo/destinatario/nota/dedica. Errori flash legacy "Errore: <msg>".
    if (action === "update_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      try {
        const result = await updateGiftBoxInstanceData(tenantSlug, id, {
          senderClientId: parseInteger(body.client_id, 0),
          eventType: body.event_type,
          voucherHideAmount: ["1", "true", "on", "yes"].includes(String(body.voucher_hide_amount ?? "").toLowerCase()),
          recipientClientId: parseInteger(body.recipient_client_id, 0),
          recipientName: body.recipient_name,
          recipientEmail: body.recipient_email,
          note: body.note,
          giftMessage: body.gift_message,
        }, session.user.id);
        return Response.json({ ok: true, source: "giftbox?action=update_instance", sourceMode: "database", message: result.message });
      } catch (error) {
        return Response.json({ ok: false, error: `Errore: ${error instanceof Error ? error.message : ""}` });
      }
    }

    // Modale scadenza (port of _mode=update_instance_expiry).
    if (action === "update_instance_expiry") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      try {
        const result = await updateGiftBoxInstanceExpiry(tenantSlug, id, String(body.expires_at ?? ""), session.user.id);
        return Response.json({ ok: true, source: "giftbox?action=update_instance_expiry", sourceMode: "database", message: result.message });
      } catch (error) {
        return Response.json({ ok: false, error: `Errore: ${error instanceof Error ? error.message : "Errore aggiornamento scadenza"}` });
      }
    }

    // Riscatto PARZIALE per-item (port of _mode=redeem_instance_partial):
    // redeem_qty_json = {"<giftbox_item_id>": qty} come i name legacy
    // redeem_qty[<id>] (stringa JSON: parseRequestBody appiattisce gli oggetti).
    if (action === "redeem_instance_partial") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const qtyByItemId: Record<number, number> = {};
      try {
        const raw = JSON.parse(String(body.redeem_qty_json ?? body.redeem_qty ?? "{}"));
        if (raw && typeof raw === "object") {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const itemId = parseInteger(k, 0);
            const qty = parseInteger(v, 0);
            if (itemId > 0 && qty > 0) qtyByItemId[itemId] = qty;
          }
        }
      } catch { /* selezione vuota -> errore legacy sotto */ }
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
      try {
        const result = await redeemGiftBoxInstancePartial(
          tenantSlug,
          id,
          qtyByItemId,
          String(body.redeem_note ?? ""),
          session.user.id,
          locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
        );
        return Response.json({ ok: true, source: "giftbox?action=redeem_instance_partial", sourceMode: "database", message: result.message });
      } catch (error) {
        return Response.json({ ok: false, error: `Errore: ${error instanceof Error ? error.message : ""}` });
      }
    }

    // Nota interna (port of _mode=update_instance_internal_note).
    if (action === "update_instance_internal_note") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      try {
        const result = await updateGiftBoxInstanceInternalNote(tenantSlug, id, String(body.internal_note ?? body.note ?? ""));
        return Response.json({ ok: true, source: "giftbox?action=update_instance_internal_note", sourceMode: "database", message: result.message });
      } catch (error) {
        return Response.json({ ok: false, error: `Errore: ${error instanceof Error ? error.message : ""}` });
      }
    }

    // Invio email voucher (port of _mode=send_email): err flash legacy senza
    // prefisso (fallback 'Errore invio email').
    if (action === "send_email") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      const showDetails = ["1", "true", "on", "yes"].includes(String(body.show_details ?? "").toLowerCase());
      try {
        const result = await sendGiftBoxInstanceEmail(tenantSlug, id, String(body.send_to ?? ""), showDetails, String(body.send_gift_message ?? ""));
        return Response.json({ ok: true, source: "giftbox?action=send_email", sourceMode: "database", message: result.message });
      } catch (error) {
        return Response.json({ ok: false, error: (error instanceof Error ? error.message : "") || "Errore invio email" });
      }
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
