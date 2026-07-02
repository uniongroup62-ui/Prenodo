import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { addDbWalletMovement, dbWalletBalance, deleteFidelityCampaign, deleteFidelityCard, fidelityWalletManualMove, getFidelityEnabled, getFidelityLevelsSettings, getFidelityMembership, getFidelityPointsSettings, getFidelityWallet, getManageCreditMovements, issueFidelityCard, listDbClients, listDbWalletMovements, listFidelityCampaigns, manualCreditDebit, reactivateFidelityCard, saveFidelityCampaign, saveFidelityLevels, saveFidelityPointsSettings, setFidelityEnabled, toggleFidelityCampaign, updateFidelityCardStatus } from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";
import type { WalletMovementType } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const readPerms = ["fidelity.manage", "fidelity.wallet", "fidelity.recharges", "fidelity.points", "fidelity.membership", "credit_movements.manage", "pos.manage"];
const writePerms = ["fidelity.manage", "fidelity.wallet", "fidelity.recharges", "fidelity.points", "fidelity.membership", "credit_movements.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, readPerms)) return jsonError("Permesso fidelity mancante.", 403);

  try {
    const url = new URL(request.url);
    // Global Fidelity enabled flag (for the main fidelity.php page toggle).
    if (url.searchParams.get("action") === "state") {
      return Response.json({ ok: true, sourceMode: "database", enabled: await getFidelityEnabled(tenantSlug) });
    }

    // Fidelity Points earn/redeem/expire settings (fidelity_points.php).
    if (url.searchParams.get("action") === "points_settings") {
      return Response.json({ ok: true, sourceMode: "database", settings: await getFidelityPointsSettings(tenantSlug) });
    }

    // Fidelity POINTS campaigns list (fidelity_campaigns).
    if (url.searchParams.get("action") === "campaigns") {
      return Response.json({ ok: true, sourceMode: "database", campaigns: await listFidelityCampaigns(tenantSlug) });
    }

    // Fidelity card LEVELS settings (fidelity_levels.php).
    if (url.searchParams.get("action") === "levels") {
      return Response.json({ ok: true, sourceMode: "database", levels: await getFidelityLevelsSettings(tenantSlug) });
    }

    // Fidelity MEMBERSHIP / cards list (fidelity_membership.php "Adesione").
    if (url.searchParams.get("action") === "membership") {
      if (!can(session.user.perms, "fidelity.membership") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso adesione fidelity mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", membership: await getFidelityMembership(tenantSlug, url.searchParams.get("q") ?? "") });
    }

    // Fidelity WALLET / points ledger (fidelity_wallet.php "Portafoglio").
    if (url.searchParams.get("action") === "wallet") {
      if (!can(session.user.perms, "fidelity.wallet") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso portafoglio fidelity mancante.", 403);
      return Response.json({ ok: true, sourceMode: "database", wallet: await getFidelityWallet(tenantSlug, parseInteger(url.searchParams.get("client_id"), 0)) });
    }

    // CREDIT movements ledger (credit_movements.php "Movimenti Credito"),
    // paginato 20/pagina come il legacy (?page=N).
    if (url.searchParams.get("action") === "credit") {
      if (!can(session.user.perms, "credit_movements.manage") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso movimenti credito mancante.", 403);
      return Response.json({
        ok: true,
        sourceMode: "database",
        credit: await getManageCreditMovements(tenantSlug, parseInteger(url.searchParams.get("client_id"), 0), parseInteger(url.searchParams.get("page"), 1)),
      });
    }

    const clients = await listDbClients({ slug: tenantSlug });
    return Response.json({
      ok: true,
      sourceMode: "database",
      clients: await Promise.all(clients.map(async (client) => ({ ...client, wallet: await dbWalletBalance(client.id, tenantSlug) }))),
      movements: await listDbWalletMovements(tenantSlug),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore fidelity.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, writePerms)) return jsonError("Permesso fidelity mancante.", 403);

  const body = await parseRequestBody(request);
  try {
    // Global Fidelity toggle (port of fidelity.php _mode=toggle_fidelity).
    if (body.action === "toggle" || body._mode === "toggle_fidelity") {
      if (!can(session.user.perms, "fidelity.manage")) return jsonError("Permesso fidelity mancante.", 403);
      const enabled = ["1", "true", "on", "yes"].includes(String(body.fidelity_enabled ?? body.enabled ?? "").toLowerCase());
      const confirmed = ["1", "true", "on", "yes"].includes(String(body.disable_appointments_confirmed ?? body.confirmed ?? "").toLowerCase());
      const result = await setFidelityEnabled(tenantSlug, enabled, confirmed);
      return Response.json({ sourceMode: "database", ...result });
    }

    // Save the Fidelity Points settings (port of fidelity_points.php save_settings).
    if (body.action === "save_points_settings" || body._mode === "save_settings") {
      if (!can(session.user.perms, "fidelity.points") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso punti fidelity mancante.", 403);
      const settings = await saveFidelityPointsSettings(tenantSlug, body);
      return Response.json({ ok: true, sourceMode: "database", settings });
    }

    // Save card levels (port of fidelity_levels.php save_levels).
    if (body.action === "save_levels" || body._mode === "save_levels") {
      if (!can(session.user.perms, "fidelity.levels") && !can(session.user.perms, "fidelity.points") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso livelli fidelity mancante.", 403);
      const levels = await saveFidelityLevels(tenantSlug, body);
      return Response.json({ ok: true, sourceMode: "database", levels });
    }

    // CREDIT manual debit (port of credit_movements.php manual_credit_debit).
    // La sede corrente è obbligatoria (guard legacy "Seleziona una sede dalla
    // barra superiore..."): risolta qui dal contesto sedi e passata al writer
    // per le colonne location_id/location_name su credit_adjustments.
    if (body.action === "credit_debit" || body._mode === "manual_credit_debit") {
      if (!can(session.user.perms, "credit_movements.manage") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso movimenti credito mancante.", 403);
      const locationContext = await getManageLocationContext(tenantSlug);
      const currentLocation = locationContext.locations.find((loc) => loc.id === locationContext.currentLocationId);
      const result = await manualCreditDebit(tenantSlug, parseInteger(body.client_id, 0), body.amount, String(body.note ?? ""), session.user.id, {
        id: locationContext.currentLocationId,
        name: currentLocation?.name ?? "",
      });
      return Response.json({ sourceMode: "database", ...result });
    }

    // Fidelity WALLET manual points movement (port of manual_move_points).
    if (body.action === "wallet_move" || body._mode === "manual_move_points") {
      if (!can(session.user.perms, "fidelity.wallet") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso portafoglio fidelity mancante.", 403);
      const result = await fidelityWalletManualMove(tenantSlug, parseInteger(body.client_id, 0), String(body.op ?? "add"), body.points, String(body.note ?? ""), session.user.id);
      return Response.json({ sourceMode: "database", ...result });
    }

    // Fidelity MEMBERSHIP / card actions (port of create/update/reactivate/delete_card).
    const cardAction = String(body.action ?? body._mode ?? "");
    if (["card_create", "create_card", "card_update", "update_card", "card_reactivate", "reactivate_card", "card_delete", "delete_card"].includes(cardAction)) {
      if (!can(session.user.perms, "fidelity.membership") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso adesione fidelity mancante.", 403);
      const cardId = parseInteger(body.card_id, 0);
      if (cardAction === "card_create" || cardAction === "create_card") {
        const result = await issueFidelityCard(tenantSlug, body);
        return Response.json({ sourceMode: "database", ...result, membership: await getFidelityMembership(tenantSlug, "") });
      }
      if (cardAction === "card_update" || cardAction === "update_card") {
        const result = await updateFidelityCardStatus(tenantSlug, cardId, String(body.status ?? "active"));
        return Response.json({ sourceMode: "database", ...result, membership: await getFidelityMembership(tenantSlug, "") });
      }
      if (cardAction === "card_reactivate" || cardAction === "reactivate_card") {
        const result = await reactivateFidelityCard(tenantSlug, cardId);
        return Response.json({ sourceMode: "database", ...result, membership: await getFidelityMembership(tenantSlug, "") });
      }
      const result = await deleteFidelityCard(tenantSlug, cardId);
      return Response.json({ sourceMode: "database", ...result, membership: await getFidelityMembership(tenantSlug, "") });
    }

    // Points campaign CRUD (port of save/toggle/delete_fidelity_campaign).
    const campaignAction = body.action ?? "";
    if (["campaign_save", "campaign_toggle", "campaign_delete"].includes(String(campaignAction))) {
      if (!can(session.user.perms, "fidelity.points") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso punti fidelity mancante.", 403);
      if (campaignAction === "campaign_save") {
        const campaign = await saveFidelityCampaign(tenantSlug, body, parseInteger(body.id, 0));
        return Response.json({ ok: true, sourceMode: "database", campaign, campaigns: await listFidelityCampaigns(tenantSlug) });
      }
      if (campaignAction === "campaign_toggle") {
        const active = ["1", "true", "on", "yes"].includes(String(body.active ?? "").toLowerCase());
        const campaign = await toggleFidelityCampaign(tenantSlug, parseInteger(body.id, 0), active);
        return Response.json({ ok: true, sourceMode: "database", campaign, campaigns: await listFidelityCampaigns(tenantSlug) });
      }
      const result = await deleteFidelityCampaign(tenantSlug, parseInteger(body.id, 0), session.user.id);
      return Response.json({ ok: true, sourceMode: "database", mode: result.mode, campaigns: await listFidelityCampaigns(tenantSlug) });
    }

    const input = {
      clientId: parseInteger(body.client_id, 0),
      type: normalizeMovementType(body.type),
      amount: parseNumber(body.amount, 0),
      points: parseInteger(body.points, 0),
      note: body.note,
      source: body.source ?? "manual",
    };
    const movement = await addDbWalletMovement(input, tenantSlug);
    return Response.json({ ok: true, source: "wallet?action=movement", sourceMode: "database", movement, movements: await listDbWalletMovements(tenantSlug) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore fidelity.");
  }
}

function normalizeMovementType(value: string | undefined): WalletMovementType {
  if (value === "recharge" || value === "debit" || value === "points_earn" || value === "points_redeem") return value;
  return "adjustment";
}
