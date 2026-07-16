import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { addDbWalletMovement, deleteFidelityCampaign, deleteFidelityCard, fidelityCampaignPreview, fidelityDisableImpact, fidelityLinkedAppointmentsDetailed, fidelityWalletManualMove, getFidelityEnabled, getFidelityLevelsEditorData, getFidelityMembership, getFidelityPointsSettings, getFidelityPointsStats, getFidelityWallet, getManageCreditMovements, issueFidelityCard, listDbClients, listDbWalletMovements, listFidelityCampaigns, manualCreditDebit, previewFidelityLevelDelete, previewFidelityLevelThresholds, reactivateFidelityCard, saveFidelityCampaign, saveFidelityLevels, saveFidelityPointsSettings, setFidelityEnabled, toggleFidelityCampaign, updateFidelityCardStatus } from "@/lib/db-repositories";
import { searchGiftRecipientClients } from "@/lib/gift-issue-details";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";
import type { WalletMovementType } from "@/lib/tenant-store";
import { tenantSelect, type RowDataPacket } from "@/lib/tenant-db";

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
    // Global Fidelity enabled flag (for the main fidelity.php page toggle) +
    // l'impatto della disattivazione calcolato al load come il GET legacy:
    // campagne bloccanti, e (solo senza campagne) le prenotazioni coinvolte
    // per la modale di conferma.
    if (url.searchParams.get("action") === "state") {
      const enabled = await getFidelityEnabled(tenantSlug);
      const impact = enabled ? await fidelityDisableImpact(tenantSlug) : { blockingPromotions: [], blockingGifts: [], linkedAppointments: [] };
      return Response.json({ ok: true, sourceMode: "database", enabled, impact });
    }

    // Fidelity Points earn/redeem/expire settings (fidelity_points.php).
    if (url.searchParams.get("action") === "points_settings") {
      // stats = colonna destra legacy della pagina Punti (emessi/usati/scaduti
      // filtrati sulla sede corrente, saldo/top clienti con tessera attiva,
      // campagne attive) + campagna attiva oggi; redeemImpacted = prenotazioni
      // aperte con sconto/scelta punti per la modale di conferma legacy;
      // canPoints/canLevels per la vista "solo Livelli Card".
      const settings = await getFidelityPointsSettings(tenantSlug);
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const stats = await getFidelityPointsStats(tenantSlug, locationContext?.currentLocationId ?? 0);
      const redeemImpacted = settings.globalEnabled && settings.pointsEnabled && settings.redeemEnabled
        ? (await fidelityLinkedAppointmentsDetailed(tenantSlug)).filter((a) => a.pointsUsed > 0.00001 || a.pointsDiscount > 0.00001 || ["discount", "later"].includes(a.conflictChoice))
        : [];
      return Response.json({
        ok: true,
        sourceMode: "database",
        settings,
        stats,
        redeemImpacted,
        currentLocationId: locationContext?.currentLocationId ?? 0,
        canPoints: can(session.user.perms, "fidelity.points") || can(session.user.perms, "fidelity.manage"),
        canLevels: can(session.user.perms, "fidelity.levels") || can(session.user.perms, "fidelity.manage"),
        canFidelityManage: can(session.user.perms, "fidelity.manage"),
      });
    }

    // Preview impatto campagna (preview_fidelity_campaign_delete/toggle).
    if (url.searchParams.get("action") === "campaign_preview") {
      const preview = await fidelityCampaignPreview(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      return Response.json({ ok: true, sourceMode: "database", preview });
    }

    // Fidelity POINTS campaigns list (fidelity_campaigns).
    if (url.searchParams.get("action") === "campaigns") {
      return Response.json({ ok: true, sourceMode: "database", campaigns: await listFidelityCampaigns(tenantSlug) });
    }

    // Fidelity card LEVELS settings (editor #livelli-card di fidelity_points.php):
    // livelli + baseKey (primo livello a 0 punti) + conteggi d'uso + label punti.
    if (url.searchParams.get("action") === "levels") {
      return Response.json({ ok: true, sourceMode: "database", levels: await getFidelityLevelsEditorData(tenantSlug) });
    }

    // Fidelity MEMBERSHIP / cards list (fidelity_membership.php "Adesione"),
    // con filtro ?q e pagina ?p (20/pagina); perms per le azioni header gated.
    if (url.searchParams.get("action") === "membership") {
      if (!can(session.user.perms, "fidelity.membership") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso adesione fidelity mancante.", 403);
      return Response.json({
        ok: true,
        sourceMode: "database",
        membership: await getFidelityMembership(tenantSlug, url.searchParams.get("q") ?? "", parseInteger(url.searchParams.get("p"), 1)),
        canFidelityManage: can(session.user.perms, "fidelity.manage"),
        canLevels: can(session.user.perms, "fidelity.levels") || can(session.user.perms, "fidelity.manage"),
      });
    }

    // Ricerca clienti per la Nuova tessera (api_clients.php action=search).
    if (url.searchParams.get("action") === "client_search") {
      const clients = await searchGiftRecipientClients(tenantSlug, url.searchParams.get("q") ?? "");
      return Response.json({ ok: true, clients });
    }

    // Fidelity WALLET / points ledger (fidelity_wallet.php "Portafoglio"),
    // con la pagina movimenti (?p=N, 20/pagina come il legacy).
    if (url.searchParams.get("action") === "wallet") {
      if (!can(session.user.perms, "fidelity.wallet") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso portafoglio fidelity mancante.", 403);
      return Response.json({
        ok: true,
        sourceMode: "database",
        wallet: await getFidelityWallet(tenantSlug, parseInteger(url.searchParams.get("client_id"), 0), parseInteger(url.searchParams.get("p"), 1)),
      });
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

    // Feed compat (nessun consumer UI): stessa shape ma SENZA l'N+1 storico —
    // dbWalletBalance faceva una query PER CLIENTE per rileggere
    // credit_balance/points; ora un'unica SELECT di lookup (fix 2026-07-16).
    const clients = await listDbClients({ slug: tenantSlug });
    const walletRows = await tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "clients", columns: "id, credit_balance, points" }).catch(() => [] as RowDataPacket[]);
    const walletById = new Map(walletRows.map((r) => [Number(r.id ?? 0), { credit: Math.round(Number(r.credit_balance ?? 0) * 100) / 100, points: Math.round(Number(r.points ?? 0)) }]));
    return Response.json({
      ok: true,
      sourceMode: "database",
      clients: clients.map((client) => ({
        ...client,
        wallet: walletById.get(client.id) ?? { credit: 0, points: 0 },
      })),
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

    // Compat legacy (fidelity_points.php ~2170/2789): il movimento manuale è
    // stato spostato nel Portafoglio; le regole per singolo servizio/prodotto
    // non esistono più nelle campagne Punti.
    if (body._mode === "manual_move") {
      return jsonError('Il movimento manuale e stato spostato in "Fidelity -> Portafoglio".');
    }
    if (body._mode === "save_rule" || body._mode === "delete_rule") {
      return jsonError("Le regole per singolo servizio/prodotto non sono piu usate nelle campagne Punti.");
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
      const levels = await saveFidelityLevels(tenantSlug, body as Record<string, unknown>, session.user.id);
      return Response.json({ ok: true, sourceMode: "database", levels, message: (levels as { message?: string }).message });
    }

    // Preview impatto modifica soglie livelli (fidelity_points.php
    // _mode=preview_fidelity_level_thresholds): changes + firma + clienti + regole.
    if (body.action === "preview_level_thresholds" || body._mode === "preview_fidelity_level_thresholds") {
      if (!can(session.user.perms, "fidelity.levels") && !can(session.user.perms, "fidelity.points") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso livelli fidelity mancante.", 403);
      try {
        const impact = await previewFidelityLevelThresholds(tenantSlug, body as Record<string, unknown>);
        return Response.json({ ok: true, impact });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Preview non disponibile.");
      }
    }

    // Preview impatto eliminazione livello (fidelity_points.php
    // _mode=preview_fidelity_level_delete): clienti/campagne/promozioni/omaggi.
    if (body.action === "preview_level_delete" || body._mode === "preview_fidelity_level_delete") {
      if (!can(session.user.perms, "fidelity.levels") && !can(session.user.perms, "fidelity.points") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso livelli fidelity mancante.", 403);
      try {
        const tokens: string[] = [];
        if (body.level_token) tokens.push(String(body.level_token));
        const posted = (body as Record<string, unknown>).delete_tokens ?? (body as Record<string, unknown>)["delete_tokens[]"];
        const postedList = Array.isArray(posted) ? posted : posted ? String(posted).split(",") : [];
        for (const t of postedList) tokens.push(String(t));
        const impact = await previewFidelityLevelDelete(tenantSlug, tokens);
        return Response.json({ ok: true, impact });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "Preview non disponibile.");
      }
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
    // Il flusso legacy allega &warn_locked=N al redirect quando i punti sono
    // tutti prenotati: lo esponiamo insieme all'errore.
    if (body.action === "wallet_move" || body._mode === "manual_move_points") {
      if (!can(session.user.perms, "fidelity.wallet") && !can(session.user.perms, "fidelity.manage")) return jsonError("Permesso portafoglio fidelity mancante.", 403);
      try {
        const result = await fidelityWalletManualMove(tenantSlug, parseInteger(body.client_id, 0), String(body.op ?? "add"), body.points, String(body.note ?? ""), session.user.id);
        return Response.json({ sourceMode: "database", ...result });
      } catch (error) {
        const warnLocked = Number((error as { warnLocked?: number })?.warnLocked ?? 0) || 0;
        return Response.json({ ok: false, error: error instanceof Error ? error.message : "Operazione non riuscita.", ...(warnLocked > 0 ? { warnLocked } : {}) });
      }
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
      const result = await deleteFidelityCampaign(tenantSlug, parseInteger(body.id, 0), session.user.id, String(body.reason ?? body.delete_reason ?? ""));
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
