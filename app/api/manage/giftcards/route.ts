import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { listDbGiftCards } from "@/lib/db-repositories";
import {
  GIFT_EVENT_OPTIONS,
  expireDueGiftCards,
  getGiftCardFull,
  hasAnyGiftCards,
  listGiftCardsManagePaged,
  redeemGiftCardCredit,
  redeemGiftCardItemManage,
  searchGiftRecipientClients,
  sendDueScheduledGiftCards,
  sendGiftCardEmailManage,
  updateGiftCardClientNote,
  updateGiftCardData,
  updateGiftCardExpiry,
  updateGiftCardInternalNote,
} from "@/lib/gift-issue-details";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { tenantSelect, type RowDataPacket } from "@/lib/tenant-db";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Gate legacy: giftcard.php:2 Auth::requirePerm('giftcard.manage') — PAGINA INTERA,
// mutazioni comprese. pos.manage NON basta (fix 2026-07-16: l'ombrello includeva
// pos.manage e apriva update/redeem/send_email ai soli permessi POS).
const giftCardPerms = ["giftcard.manage"];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, giftCardPerms)) return jsonError("Permesso GiftCard mancante.", 403);

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    // Card DETAIL (action=view/edit): vista legacy completa (riepilogo, dati
    // con lock destinatario, items, movimenti normalizzati, scadenza).
    if (action === "view" || action === "edit") {
      if (!can(session.user.perms, "giftcard.manage")) return jsonError("Permesso GiftCard mancante.", 403);
      // Best-effort legacy a ogni load: expire-due + invii programmati.
      await expireDueGiftCards(tenantSlug);
      await sendDueScheduledGiftCards(tenantSlug, 20, session.user.id).catch(() => null);
      const detail = await getGiftCardFull(tenantSlug, parseInteger(url.searchParams.get("id"), 0));
      if (!detail) return jsonError("GiftCard non trovata", 404);
      // Niente anagrafica completa (2026-07-16): il Mittente usa action=client_search
      // e il nome corrente arriva da detail.senderName.
      return Response.json({
        ok: true,
        sourceMode: "database",
        detail,
        events: GIFT_EVENT_OPTIONS,
        canCreate: can(session.user.perms, "pos.manage"),
        canSettings: can(session.user.perms, "giftcard.settings"),
      });
    }

    // Ricerca clienti per il destinatario (api_clients.php action=search).
    if (action === "client_search") {
      const clients = await searchGiftRecipientClients(tenantSlug, url.searchParams.get("q") ?? "");
      return Response.json({ ok: true, clients });
    }

    // Lista MANAGE legacy (giftcard.php list): filtri server-side Mittente/
    // Cerca/Stato (+ sede corrente STRETTA salvo all_locations=1), expire-due
    // e invii programmati al load, empty state su conteggio NON filtrato.
    if (action === "manage_list") {
      if (!can(session.user.perms, "giftcard.manage")) return jsonError("Permesso GiftCard mancante.", 403);
      await expireDueGiftCards(tenantSlug);
      await sendDueScheduledGiftCards(tenantSlug, 20, session.user.id).catch(() => null);
      const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const filterLocationId = allLocations ? 0 : (locationContext?.currentLocationId ?? 0);
      // Paginazione 25 (miglioria 2026-07-17): SOLO con ?p= — senza, storico cap 200.
      const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 0;
      const paged = await listGiftCardsManagePaged(tenantSlug, {
        q: url.searchParams.get("q") ?? "",
        status: url.searchParams.get("status") ?? "",
        clientId: parseInteger(url.searchParams.get("client_id"), 0),
        locationId: filterLocationId,
      }, page, 200);
      // Solo il LABEL del mittente filtrato: il combobox fa ricerca server-side
      // (2026-07-16) — niente più anagrafica completa a ogni load.
      const selClientId = parseInteger(url.searchParams.get("client_id"), 0);
      let selectedClientLabel = "";
      if (selClientId > 0) {
        const cRows = await tenantSelect<RowDataPacket>({ slug: tenantSlug, table: "clients", columns: "full_name", where: "id = ?", params: [selClientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
        selectedClientLabel = String(cRows[0]?.full_name ?? "").trim();
      }
      return Response.json({
        ok: true,
        sourceMode: "database",
        rows: paged.rows,
        totalCount: paged.totalCount,
        pageSize: paged.pageSize,
        currentPage: page >= 1 ? page : 1,
        hasAnyGiftCards: await hasAnyGiftCards(tenantSlug),
        selectedClientLabel,
        showAllLocationsFilter: (locationContext?.locations.length ?? 0) > 1,
        canCreate: can(session.user.perms, "pos.manage"),
        canSettings: can(session.user.perms, "giftcard.settings"),
      });
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
  const flashError = (error: unknown, fallback: string) =>
    Response.json({ ok: false, error: (error instanceof Error ? error.message : "") || fallback });

  try {
    // Emissione GiftCard: SOLO da Pagamenti (POS). Il legacy rifiuta _mode=issue
    // (giftcard.php:446): la creazione via questa route non esiste. Messaggio verbatim.
    if (action === "issue") {
      return Response.json({ ok: false, error: "La creazione delle GiftCard avviene da Pagamenti (pulsante GiftCard)." });
    }

    // "Dati GiftCard" (port of _mode=update): lock destinatario server-side +
    // movimento 'Cambio destinatario'; err flash col messaggio grezzo legacy.
    if (action === "update") {
      const id = parseInteger(body.id);
      try {
        const result = await updateGiftCardData(tenantSlug, id, {
          senderClientId: parseInteger(body.client_id, 0),
          eventType: body.event_type,
          voucherHideAmount: ["1", "true", "on", "yes"].includes(String(body.voucher_hide_amount ?? "").toLowerCase()),
          recipientClientId: parseInteger(body.recipient_client_id, 0),
          recipientName: body.recipient_name,
          recipientEmail: body.recipient_email,
          note: body.note,
          giftMessage: body.gift_message,
        }, session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "modifica", entityType: "giftcard", entityId: id, label: `Modificati dati GiftCard #${id}` });
        return Response.json({ ok: true, source: "giftcard?action=update", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore aggiornamento");
      }
    }

    // Modale scadenza (port of _mode=update_expiry).
    if (action === "update_expiry") {
      const id = parseInteger(body.id);
      try {
        const result = await updateGiftCardExpiry(tenantSlug, id, String(body.expires_at ?? ""), session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "modifica", entityType: "giftcard", entityId: id, label: `Aggiornata scadenza GiftCard #${id}` });
        return Response.json({ ok: true, source: "giftcard?action=update_expiry", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore aggiornamento scadenza");
      }
    }

    // Nota interna (port of _mode=update_internal_note).
    if (action === "update_internal_note") {
      const id = parseInteger(body.id);
      try {
        const result = await updateGiftCardInternalNote(tenantSlug, id, String(body.internal_note ?? ""), session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "modifica", entityType: "giftcard", entityId: id, label: `Salvata nota interna GiftCard #${id}` });
        return Response.json({ ok: true, source: "giftcard?action=update_internal_note", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore salvataggio nota interna");
      }
    }

    // Compat legacy _mode=update_note (non presente nella UI edit).
    if (action === "update_note") {
      const id = parseInteger(body.id);
      try {
        const result = await updateGiftCardClientNote(tenantSlug, id, String(body.note ?? ""), session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "modifica", entityType: "giftcard", entityId: id, label: `Salvata nota cliente GiftCard #${id}` });
        return Response.json({ ok: true, source: "giftcard?action=update_note", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore salvataggio nota");
      }
    }

    // "Riscatta (scala credito)" (port of _mode=redeem / GiftCard::redeemGiftCard).
    if (action === "redeem") {
      const id = parseInteger(body.id);
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
      try {
        const result = await redeemGiftCardCredit(
          tenantSlug,
          id,
          parseNumber(body.redeem_amount ?? body.amount, 0),
          String(body.redeem_note ?? body.note ?? ""),
          session.user.id,
          locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
        );
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "riscatta", entityType: "giftcard", entityId: id, label: `Riscatto credito GiftCard #${id} (€ ${parseNumber(body.redeem_amount ?? body.amount, 0).toFixed(2).replace(".", ",")})` });
        return Response.json({ ok: true, source: "giftcard?action=redeem", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore riscatto");
      }
    }

    // Operazioni rimosse dal backend legacy (ricarica/annullamento).
    if (action === "topup" || action === "cancel") {
      return Response.json({ ok: false, error: "Operazione non disponibile." });
    }

    // Riscatto per-item (port of _mode=redeem_item).
    if (action === "redeem_item") {
      const id = parseInteger(body.id);
      const locationContext = await getManageLocationContext(tenantSlug).catch(() => null);
      const currentLocation = locationContext?.locations.find((l) => l.id === locationContext.currentLocationId) ?? null;
      try {
        const result = await redeemGiftCardItemManage(
          tenantSlug,
          id,
          parseInteger(body.item_row_id, 0),
          parseInteger(body.item_qty, 1),
          String(body.item_note ?? ""),
          session.user.id,
          locationContext ? { id: locationContext.currentLocationId, name: currentLocation?.name ?? "" } : null,
        );
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "riscatta", entityType: "giftcard", entityId: id, label: `Riscatto item GiftCard #${id}` });
        return Response.json({ ok: true, source: "giftcard?action=redeem_item", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore riscatto item");
      }
    }

    // Invio email voucher (port of _mode=send_email).
    if (action === "send_email") {
      const id = parseInteger(body.id);
      const showAmount = ["1", "true", "on", "yes"].includes(String(body.show_amount ?? "").toLowerCase());
      try {
        const result = await sendGiftCardEmailManage(tenantSlug, id, String(body.send_to ?? ""), showAmount, String(body.send_gift_message ?? ""), session.user.id);
        void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "giftcard", action: "invia", entityType: "giftcard", entityId: id, label: `Inviato voucher GiftCard #${id} via email` });
        return Response.json({ ok: true, source: "giftcard?action=send_email", sourceMode: "database", message: result.message });
      } catch (error) {
        return flashError(error, "Errore invio email");
      }
    }

    return jsonError("Azione GiftCard non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore GiftCard.");
  }
}
