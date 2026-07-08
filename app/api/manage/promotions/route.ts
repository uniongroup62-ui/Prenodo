import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { addManagePromotionExcludedClient, deleteManagePromotion, evaluatePromotionsForCart, getManagePromotion, listDbPromotions, listManagePromotionPage, previewDbPromotion, promotionFormContext, promotionStructuralBlockReason, removeManagePromotionExcludedClient, saveManagePromotion, toggleManagePromotion, updateManagePromotionConditions, type PromoCartLine } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { assertLocationAccessByJunction, sessionAllowedLocationIds } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";

// Guardia per-sede promozione (junction promotion_locations, [] = tutte le sedi).
const PROMO_SEDE_ERR = "Promozione non disponibile per le tue sedi.";
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

    // Lista fedele (promotions.php action=list): righe con badge/riepilogo/
    // conferme + payload dei modal Riepilogo per campagna.
    if (url.searchParams.get("action") === "page") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", ...(await listManagePromotionPage(tenantSlug)) });
    }

    // Guardia lock strutturale del form edit (promotions.php action=edit 999-1004):
    // con utilizzi collegati il form NON si apre e si torna alla lista con l'errore.
    if (url.searchParams.get("action") === "edit_guard") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const reason = await promotionStructuralBlockReason(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      return Response.json({ ok: true, reason });
    }

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
      await assertLocationAccessByJunction(tenantSlug, "promotion_locations", "promotion_id", promotionId, sessionAllowedLocationIds(session), PROMO_SEDE_ERR);
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
      await assertLocationAccessByJunction(tenantSlug, "promotion_locations", "promotion_id", id, sessionAllowedLocationIds(session), PROMO_SEDE_ERR);
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
      await assertLocationAccessByJunction(tenantSlug, "promotion_locations", "promotion_id", id, sessionAllowedLocationIds(session), PROMO_SEDE_ERR);
      const result = await deleteManagePromotion(tenantSlug, id);
      return Response.json({
        source: "promotions?action=delete",
        sourceMode: "database",
        message: "Promozione eliminata definitivamente. Le prenotazioni in stato In sospeso/Prenotato collegate hanno perso la promozione.",
        ...result,
        promotions: await listDbPromotions(tenantSlug),
      });
    }

    // Condizioni booking dal riepilogo (promotions.php _mode=promotion_conditions_update).
    if (action === "conditions_update" || action === "promotion_conditions_update") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const promotionId = parseInteger(body.promotion_id ?? body.id, 0);
      try {
        const enabled = ["1", "true", "yes", "on"].includes(String(body.promo_conditions_enabled ?? "").toLowerCase());
        await updateManagePromotionConditions(tenantSlug, promotionId, enabled, String(body.promo_conditions ?? ""), session.user.id);
        return Response.json({ ok: true, message: "Condizioni promozionali aggiornate", promotionId });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Errore aggiornamento condizioni promozionali");
      }
    }

    // Esclusioni clienti dal riepilogo (promotion_exclusion_add / _remove).
    if (action === "exclusion_add" || action === "promotion_exclusion_add") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const promotionId = parseInteger(body.promotion_id ?? body.id, 0);
      try {
        await addManagePromotionExcludedClient(tenantSlug, promotionId, parseInteger(body.client_id, 0), session.user.id);
        return Response.json({ ok: true, message: "Cliente aggiunto all'esclusione", promotionId });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Errore aggiornamento esclusioni promozione");
      }
    }
    if (action === "exclusion_remove" || action === "promotion_exclusion_remove") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      const promotionId = parseInteger(body.promotion_id ?? body.id, 0);
      try {
        await removeManagePromotionExcludedClient(tenantSlug, promotionId, parseInteger(body.client_id, 0), session.user.id);
        return Response.json({ ok: true, message: "Cliente rimosso dall'esclusione", promotionId });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Errore aggiornamento esclusioni promozione");
      }
    }

    // Faithful promotion editor save (port of promotions.php POST action=new|edit).
    // id=0 creates, id>0 updates the core promotion record.
    if (action === "save" || action === "new" || action === "edit" || action === "update") {
      if (!can(session.user.perms, "promotions.manage")) return jsonError("Permesso promozioni mancante.", 403);
      await assertLocationAccessByJunction(tenantSlug, "promotion_locations", "promotion_id", id, sessionAllowedLocationIds(session), PROMO_SEDE_ERR);
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
