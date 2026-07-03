import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  cancelManageGiftBoxInstance,
  deleteManageGiftBoxTemplate,
  getManageGiftBoxInstance,
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
  updateManageGiftBoxInstance,
} from "@/lib/db-repositories";
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

    // Instance DETAIL (tab=instances action=view/edit_instance): header + items +
    // redeemed/residual units + linked sale + redeem/cancel eligibility.
    if (action === "view" || action === "edit_instance") {
      const detail = await getManageGiftBoxInstance(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("GiftBox non trovata.", 404);
      const clients = (await listDbClients({ slug: tenantSlug })).map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ ok: true, sourceMode: "database", detail, clients });
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
      const detail = await getManageGiftBoxInstance(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=redeem_full", sourceMode: "database", detail });
    }

    // Update an instance's recipient/note/expiry (port of update_instance).
    if (action === "update_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      await updateManageGiftBoxInstance(tenantSlug, id, {
        recipientClientId: parseInteger(body.recipient_client_id, 0),
        recipientName: body.recipient_name,
        recipientEmail: body.recipient_email,
        note: body.note,
        expiresAt: body.expires_at,
      });
      const detail = await getManageGiftBoxInstance(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=update_instance", sourceMode: "database", detail });
    }

    // Cancel an instance (port of cancel / GiftBox::cancelInstance).
    if (action === "cancel" || action === "cancel_instance") {
      const id = parseInteger(body.instance_id ?? body.id, 0);
      await cancelManageGiftBoxInstance(tenantSlug, id, session.user.id);
      const detail = await getManageGiftBoxInstance(tenantSlug, id);
      return Response.json({ ok: true, source: "giftbox?action=cancel", sourceMode: "database", detail });
    }

    return jsonError("Azione GiftBox non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftBox.");
  }
}
