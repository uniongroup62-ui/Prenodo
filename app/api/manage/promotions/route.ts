import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { deleteManagePromotion, evaluatePromotionsForCart, getManagePromotion, listDbPromotions, previewDbPromotion, promotionFormContext, saveManagePromotion, toggleManagePromotion, type PromoCartLine } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, ["promotions.manage", "pos.manage"])) return jsonError("Permesso promozioni mancante.", 403);

  try {
    const url = new URL(request.url);

    // Editor form catalogs (services/products/locations/fidelity levels/clients).
    if (url.searchParams.get("action") === "context") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", ...(await promotionFormContext(tenantSlug)) });
    }

    // Edit-form prefill: return ONE promotion's editable fields for one id. Port
    // of promotions.php action=edit. Gated by promotions.manage like the save.
    if (url.searchParams.get("action") === "get") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const promotionId = parseInteger(url.searchParams.get("id"), 0);
      if (promotionId <= 0) return jsonError("ID promozione mancante.");
      const promotion = await getManagePromotion(tenantSlug, promotionId);
      if (!promotion) return jsonError("Promozione non trovata.", 404);
      return Response.json({ ok: true, source: "promotions?action=get", sourceMode: "database", promotion });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      promotions: await listDbPromotions(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore promozioni.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const body = await parseRequestBody(request);
  const action = body.action ?? "preview";
  const id = parseInteger(body.id);

  try {
    if (action === "toggle") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const active = ["1", "true", "yes", "on"].includes((body.active ?? "").toLowerCase());
      const promotion = await toggleManagePromotion(tenantSlug, id, active, session.user.id);
      return Response.json({
        ok: true,
        source: "promotions?action=toggle",
        sourceMode: "database",
        message: active ? "Promozione attivata" : "Promozione disattivata. Le prenotazioni in stato In sospeso/Prenotato collegate hanno perso la promozione.",
        promotion,
        promotions: await listDbPromotions(tenantSlug),
      });
    }

    // Evaluate active promotions against a cart (port of Promotions::evaluatePromotion,
    // the matching + discount computation). Read-only preview — does not apply/record.
    if (action === "evaluate") {
      if (!canAny(session.user.perms, ["promotions.manage", "pos.manage"])) return jsonError("Permesso promozioni mancante.", 403);
      let cart: PromoCartLine[] = [];
      try { const parsed = JSON.parse(String(body.cart_json ?? "[]")); if (Array.isArray(parsed)) cart = parsed as PromoCartLine[]; } catch { cart = []; }
      // auto_only=1 (POS auto-applicazione, pos.php preview_auto_promo 1545-1548):
      // esclude le promo "su codice" (coupon_code) e, senza cliente, quelle con
      // limite per-cliente (pos_promotion_requires_client).
      const autoOnly = String(body.auto_only ?? "") === "1" || String(body.auto_only ?? "").toLowerCase() === "true";
      const result = await evaluatePromotionsForCart(tenantSlug, cart, String(body.date ?? ""), String(body.time ?? ""), parseInteger(body.client_id, 0), parseInteger(body.location_id, 0), { autoOnly });
      return Response.json({ ok: true, sourceMode: "database", ...result });
    }

    // Delete a promotion (port of promotions.php action=delete / Promotions::delete).
    if (action === "delete") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const result = await deleteManagePromotion(tenantSlug, id);
      return Response.json({
        source: "promotions?action=delete",
        sourceMode: "database",
        message: "Promozione eliminata definitivamente. Le prenotazioni in stato In sospeso/Prenotato collegate hanno perso la promozione.",
        ...result,
        promotions: await listDbPromotions(tenantSlug),
      });
    }

    // Faithful promotion editor save (port of promotions.php POST action=new|edit).
    // id=0 creates, id>0 updates the core promotion record.
    if (action === "save" || action === "new" || action === "edit" || action === "update") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const promotion = await saveManagePromotion(tenantSlug, body, id);
      const isClone = (parseInteger(body.replace_source_id, 0) || 0) > 0;
      return Response.json({
        ok: true,
        source: "promotions?action=save",
        sourceMode: "database",
        message: isClone ? "Campagna clonata salvata" : id > 0 ? "Promozione aggiornata" : "Promozione salvata",
        promotion,
        promotions: await listDbPromotions(tenantSlug),
      });
    }

    if (!canAny(session.user.perms, ["promotions.manage", "pos.manage"])) return jsonError("Permesso promozioni mancante.", 403);
    const subtotal = parseNumber(body.subtotal, 0);
    const preview = await previewDbPromotion(id, subtotal, tenantSlug);
    return Response.json({ ok: true, source: "promotions?action=preview", sourceMode: "database", preview, promotions: await listDbPromotions(tenantSlug) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore promozioni.");
  }
}
