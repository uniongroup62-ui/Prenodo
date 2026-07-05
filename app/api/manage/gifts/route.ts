import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { addManageGiftExcludedClient, deleteManageGift, getManageGift, giftFormCatalog, giftStructureBlockReason, issueDbGift, listDbGifts, listManageGiftPage, listManageGifts, redeemDbGift, removeManageGiftExcludedClient, saveManageGift, toggleManageGift, updateManageGiftTerms } from "@/lib/db-repositories";
import { assignGiftManual, cancelGiftInstance, checkGiftManualAssignmentEligibility, deleteClosedGiftInstance, getGiftInstanceDetail, giftCampaignSummaryStats, listGiftInstances, redeemGiftInstanceItems, sendGiftVoucherEmailManage, updateGiftInstanceInternalNote, updateGiftInstanceNote } from "@/lib/gifts-instances";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type GiftRewardType = "service" | "product" | "discount";
const giftPerms = ["gifts.manage", "pos.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftPerms)) return jsonError("Permesso omaggi mancante.", 403);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Campaign editor catalog (services/products/locations for the item + sedi
    // dropdowns). Port of the SELECTs in gifts.php action=new|edit.
    if (action === "context") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", ...(await giftFormCatalog(tenantSlug)) });
    }

    // Edit-form prefill: ONE gift campaign's editable fields. Port of gifts.php
    // action=edit. Gated by gifts.manage like the save action.
    if (action === "get") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const giftId = parseInteger(url.searchParams.get("id"), 0);
      if (giftId <= 0) return jsonError("ID campagna mancante.");
      const gift = await getManageGift(tenantSlug, giftId);
      if (!gift) return jsonError("Campagna non trovata.", 404);
      return Response.json({ ok: true, source: "gifts?action=get", sourceMode: "database", gift });
    }

    // Payload COMPLETO della vista campagne legacy (gifts.php default view):
    // righe con badge stato, label sconto/regola, riepilogo, condizioni,
    // esclusioni con candidati, blocchi riattivazione e lock strutturale.
    if (action === "page") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const page = await listManageGiftPage(tenantSlug);
      return Response.json({ ok: true, sourceMode: "database", ...page });
    }

    // Guardia lock strutturale prima di aprire il form di modifica (gifts.php
    // action=edit -> Gifts::structureEditBlockReason): se la campagna ha gia'
    // dati operativi il legacy redirige alla lista con ?err=reason&open_summary.
    if (action === "edit_guard") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const giftId = parseInteger(url.searchParams.get("id"), 0);
      if (giftId <= 0) return jsonError("ID campagna mancante.");
      const reason = await giftStructureBlockReason(tenantSlug, giftId);
      return Response.json({ ok: true, sourceMode: "database", blocked: reason !== "", reason });
    }

    // Gift CAMPAIGN list (port of gifts.php default view / Gifts::listGifts).
    if (action === "campaigns") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", campaigns: await listManageGifts(tenantSlug) });
    }

    // Statistiche campagna per il modale "Riepilogo" legacy (gifts.php
    // #giftSummaryModal, card "Statistiche"): conteggi per stato + clienti
    // coinvolti + ultime attivita' dell'istanza.
    if (action === "campaign_summary") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const stats = await giftCampaignSummaryStats(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      return Response.json({ ok: true, sourceMode: "database", stats });
    }

    // Istanze assegnate (gifts.php ~1155-1591): filtri inst_client_id /
    // inst_gift_id / inst_state + paginazione 25/pagina (inst_p).
    if (action === "instances") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const instances = await listGiftInstances(tenantSlug, {
        clientId: parseInteger(url.searchParams.get("inst_client_id"), 0),
        giftId: parseInteger(url.searchParams.get("inst_gift_id"), 0),
        state: url.searchParams.get("inst_state") ?? "",
        page: parseInteger(url.searchParams.get("inst_p"), 1),
      });
      return Response.json({ ok: true, sourceMode: "database", instances });
    }

    // Dettaglio istanza (gift_instance.php ?id=N / Gifts::instanceDetails),
    // con stato derivato + auto-scadenza alla lettura.
    if (action === "instance") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const detail = await getGiftInstanceDetail(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("Omaggio non trovato.", 404);
      return Response.json({ ok: true, sourceMode: "database", instance: detail });
    }

    // Pre-check idoneità assegnazione manuale (gifts.php _mode=assign_manual_check).
    if (action === "assign_manual_check") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const check = await checkGiftManualAssignmentEligibility(tenantSlug, parseInteger(url.searchParams.get("gift_id"), 0), parseInteger(url.searchParams.get("client_id"), 0));
      return Response.json({ ok: true, sourceMode: "database", ...check });
    }

    return Response.json({
      ok: true,
      sourceMode: "database",
      gifts: await listDbGifts(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore omaggi.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftPerms)) return jsonError("Permesso omaggi mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? "issue";

  try {
    // Faithful gift CAMPAIGN editor save (port of gifts.php POST action=new|edit
    // / Gifts::saveGift). id=0 creates, id>0 updates. Gated by gifts.manage.
    if (action === "save" || action === "new" || action === "edit") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const gift = await saveManageGift(tenantSlug, body, parseInteger(body.id, 0));
      return Response.json({ ok: true, source: "gifts?action=save", sourceMode: "database", gift, gifts: await listDbGifts(tenantSlug) });
    }

    // Campaign activate/deactivate (port of gifts.php action=toggle_active):
    // flash 'Campagna attivata'/'Campagna disattivata'; sugli errori il legacy
    // redirige con ?err=...&open_summary=ID quando la guardia lo marca.
    if (action === "toggle_active" || action === "toggle") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const active = ["1", "true", "on", "yes"].includes(String(body.active ?? "").toLowerCase());
      try {
        const result = await toggleManageGift(tenantSlug, parseInteger(body.id, 0), active, session.user.id);
        return Response.json({ sourceMode: "database", ...result, msg: result.active ? "Campagna attivata" : "Campagna disattivata", campaigns: await listManageGifts(tenantSlug) });
      } catch (error) {
        const openSummary = error instanceof Error ? (error as Error & { openSummary?: number }).openSummary ?? 0 : 0;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Errore omaggi.", open_summary: openSummary }, { status: 400 });
      }
    }

    // Campaign delete (port of gifts.php action=delete / Gifts::softDeleteGift):
    // flash 'Campagna eliminata' / err 'Errore eliminazione campagna'.
    if (action === "delete" || action === "delete_campaign") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      try {
        const result = await deleteManageGift(tenantSlug, parseInteger(body.id, 0), session.user.id);
        return Response.json({ sourceMode: "database", ...result, msg: "Campagna eliminata", campaigns: await listManageGifts(tenantSlug) });
      } catch {
        return Response.json({ ok: false, error: "Errore eliminazione campagna" }, { status: 400 });
      }
    }

    // Condizioni gift dal riepilogo (gifts.php _mode=gift_terms_update /
    // Gifts::updateGiftTerms): flash 'Condizioni gift aggiornate' + open_summary.
    if (action === "gift_terms_update") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const giftId = parseInteger(body.gift_id ?? body.id, 0);
      const enabled = ["1", "true", "on", "yes"].includes(String(body.terms_enabled ?? "").toLowerCase());
      await updateManageGiftTerms(tenantSlug, giftId, enabled, String(body.terms_text ?? ""), session.user.id);
      return Response.json({ ok: true, sourceMode: "database", msg: "Condizioni gift aggiornate", open_summary: giftId });
    }

    // Esclusioni clienti dal riepilogo (gifts.php _mode=gift_exclusion_add /
    // gift_exclusion_remove) con guardie snapshot + istanze bloccanti.
    if (action === "gift_exclusion_add") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const giftId = parseInteger(body.gift_id ?? body.id, 0);
      await addManageGiftExcludedClient(tenantSlug, giftId, parseInteger(body.client_id, 0), session.user.id);
      return Response.json({ ok: true, sourceMode: "database", msg: "Cliente aggiunto all'esclusione", open_summary: giftId });
    }

    if (action === "gift_exclusion_remove") {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const giftId = parseInteger(body.gift_id ?? body.id, 0);
      await removeManageGiftExcludedClient(tenantSlug, giftId, parseInteger(body.client_id, 0), session.user.id);
      return Response.json({ ok: true, sourceMode: "database", msg: "Cliente rimosso dall'esclusione", open_summary: giftId });
    }

    // ------ AZIONI ISTANZA (gift_instance.php POST _mode=...) ------
    const instanceActions = ["redeem_instance_partial", "cancel_instance", "delete_instance", "update_instance_note", "update_instance_internal_note", "send_email", "assign_manual"];
    if (instanceActions.includes(String(action))) {
      if (!can(session.user.perms, "gifts.manage")) return jsonError("Permesso omaggi mancante.", 403);
      const instanceId = parseInteger(body.instance_id ?? body.id, 0);

      // Riscatto manuale/parziale: redeem_qty_json = {"<reward_item_index>": qty}
      // (stringa JSON: parseRequestBody appiattisce i valori non-stringa).
      if (action === "redeem_instance_partial") {
        const qtyByItem: Record<number, number> = {};
        let raw: unknown = null;
        try { raw = JSON.parse(String(body.redeem_qty_json ?? body.redeem_qty ?? "{}")); } catch { raw = null; }
        if (raw && typeof raw === "object") {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const idx = parseInteger(k, -1);
            const qty = parseInteger(v, 0);
            if (idx >= 0 && qty > 0) qtyByItem[idx] = qty;
          }
        }
        const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
        const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
        const result = await redeemGiftInstanceItems(tenantSlug, {
          instanceId,
          qtyByItem,
          by: session.user.id,
          sourceType: "manual",
          note: String(body.redeem_note ?? ""),
          location: locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
        });
        return Response.json({ sourceMode: "database", ...result, instance: await getGiftInstanceDetail(tenantSlug, instanceId) });
      }

      if (action === "cancel_instance") {
        const confirmed = ["1", "true", "on", "yes"].includes(String(body.confirm_cancel_linked_appointments ?? "").toLowerCase());
        const result = await cancelGiftInstance(tenantSlug, instanceId, session.user.id, String(body.cancel_reason ?? ""), confirmed);
        return Response.json({ sourceMode: "database", ...result, instance: await getGiftInstanceDetail(tenantSlug, instanceId) });
      }

      if (action === "delete_instance") {
        const result = await deleteClosedGiftInstance(tenantSlug, instanceId, session.user.id);
        return Response.json({ sourceMode: "database", ...result });
      }

      if (action === "update_instance_note") {
        const result = await updateGiftInstanceNote(tenantSlug, instanceId, String(body.note ?? ""));
        return Response.json({ sourceMode: "database", ...result });
      }

      if (action === "update_instance_internal_note") {
        const result = await updateGiftInstanceInternalNote(tenantSlug, instanceId, String(body.internal_note ?? body.note ?? ""));
        return Response.json({ sourceMode: "database", ...result });
      }

      if (action === "send_email") {
        const result = await sendGiftVoucherEmailManage(tenantSlug, instanceId, String(body.send_to ?? ""));
        return Response.json({ sourceMode: "database", ...result, instance: await getGiftInstanceDetail(tenantSlug, instanceId) });
      }

      // Assegnazione manuale (gifts.php _mode=assign_manual): crea/riusa
      // un'istanza DISPONIBILE per il cliente, anche senza regole completate.
      if (action === "assign_manual") {
        const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
        const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
        const result = await assignGiftManual(tenantSlug, {
          giftId: parseInteger(body.gift_id, 0),
          clientId: parseInteger(body.client_id, 0),
          expiresDays: body.expires_days !== undefined && String(body.expires_days).trim() !== "" ? parseInteger(body.expires_days, 0) : null,
          by: session.user.id,
          forceIneligible: ["1", "true", "on", "yes"].includes(String(body.force_ineligible ?? "").toLowerCase()),
          location: locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
        });
        return Response.json({ sourceMode: "database", ...result });
      }
    }

    if (action === "issue") {
      const input = {
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        title: body.title,
        rewardType: normalizeRewardType(body.reward_type),
        value: parseNumber(body.value, 0),
        expiresAt: body.expires_at,
      };
      const gift = await issueDbGift(input, tenantSlug);
      return Response.json({ ok: true, source: "gifts?action=issue", sourceMode: "database", gift, gifts: await listDbGifts(tenantSlug) });
    }

    if (action === "redeem") {
      const id = parseInteger(body.id);
      const gift = await redeemDbGift(id, tenantSlug);
      return Response.json({ ok: true, source: "gifts?action=redeem", sourceMode: "database", gift, gifts: await listDbGifts(tenantSlug) });
    }

    return jsonError("Azione omaggi non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore omaggi.");
  }
}

function normalizeRewardType(value: string | undefined): GiftRewardType {
  if (value === "service" || value === "product" || value === "discount") return value;
  return "discount";
}
