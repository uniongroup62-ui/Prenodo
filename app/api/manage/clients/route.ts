import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import type { ManagedClient } from "@/lib/tenant-store";
import {
  addManageClientTag,
  archiveDbClient,
  blockDbClient,
  createDbClient,
  deleteDbClientCascade,
  getDbClient,
  getManageClientDeleteSummary,
  getManageClientDetail,
  getManageClientHistory,
  listDbClients,
  countDbClients,
  CLIENTS_LIST_PAGE_SIZE,
  quickBookClientCard,
  quickBookClientContext,
  quickBookClientResidualsDetail,
  removeManageClientTag,
  unblockDbClient,
  updateDbClient,
} from "@/lib/db-repositories";
import { currentManageSession } from "@/lib/manage-auth";
import { resolveManageLocationId } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { can, canAny } from "@/lib/role-permissions";
import { tenantSelect, type RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Legacy page access: clients.php richiede ANY di questi tre permessi; le azioni
// new/edit/delete/history restano gated clients.manage (vedi sotto).
const CLIENTS_PAGE_PERMS = ["clients.manage", "client_sheets.manage", "client_consents.manage"];
// Gate API legacy (api_clients.php 12-19): il drawer quick-booking (search/card/
// storico/residui) e il planner (search) passano anche con i permessi agenda —
// la whitelist a 9 permessi con 403 'Accesso negato'. La PAGINA Clienti resta
// gated ai 3 permessi via flag pageAllowed nella risposta list.
const CLIENTS_API_PERMS = [
  ...CLIENTS_PAGE_PERMS,
  "appointments.manage",
  "appointments.plan",
  "appointments.quick_booking",
  "calendar.view",
  "fidelity.manage",
  "fidelity.membership",
];

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!canAny(session.user.perms, CLIENTS_API_PERMS)) return jsonError("Accesso negato", 403);

  const url = new URL(request.url);
  // Azioni riservate a clients.manage (legacy: redirect "Permessi insufficienti
  // per questa azione sui clienti.").
  const guardedActions = ["history", "delete_summary", "get"];
  const requestedAction = url.searchParams.get("action") ?? "";
  if (guardedActions.includes(requestedAction) && !can(session.user.perms, "clients.manage")) {
    return jsonError("Permessi insufficienti per questa azione sui clienti.", 403);
  }
  // Azioni di PAGINA (scheda cliente): restano sui 3 permessi pagina anche con
  // l'ombrello API a 9 (un utente solo-agenda non apre la scheda; la LIST resta
  // servita per la ricerca drawer/planner e la pagina si gata via pageAllowed).
  if (requestedAction === "detail" && !canAny(session.user.perms, CLIENTS_PAGE_PERMS)) {
    return jsonError("Permesso clienti mancante.", 403);
  }
  const locationId = await resolveManageLocationId({
    slug: tenantSlug,
    raw: url.searchParams.get("location_id"),
    fallbackCurrent: true,
  });

  // NB: Modello A (= PHP) — il CLIENTE e' tenant-wide: qualsiasi operatore puo'
  // aprire/prenotare qualsiasi cliente del centro (come app_client_accessible del
  // legacy, che ignora la sede). L'isolamento per-sede vale solo sui RECORD-operazione
  // di una sede (appuntamenti/POS/magazzino/cabine), non sull'anagrafica cliente.

  // Quick-booking drawer CLIENT HISTORY + RESIDUALS panels. Single GET that
  // returns BOTH the legacy `action=history` (summary) and `action=residuals`
  // (summary=1) payloads for one client, so the drawer can populate both boxes
  // with a single fetch. Port of api_clients.php history/residuals summaries.
  // "Scheda semplificata" cliente per il modal del quick booking (port of
  // api_clients.php action=card): anagrafica+punti, riepilogo, ultimi
  // appuntamenti/vendite, tag e documenti.
  if (url.searchParams.get("action") === "card") {
    const clientId = parseInteger(url.searchParams.get("client_id"));
    if (clientId <= 0) return jsonError("client_id mancante.");
    try {
      const card = await quickBookClientCard(tenantSlug, clientId, parseInteger(url.searchParams.get("limit"), 10));
      return Response.json({ ok: true, sourceMode: "database", ...card });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Impossibile caricare la scheda cliente.");
    }
  }

  if (url.searchParams.get("action") === "quickbook_client_context") {
    const clientId = parseInteger(url.searchParams.get("client_id"));
    if (clientId <= 0) return jsonError("client_id mancante.");
    try {
      const context = await quickBookClientContext({ slug: tenantSlug, clientId, locationId });
      return Response.json({
        ok: true,
        sourceMode: "database",
        summary: context.history,
        residuals: context.residuals,
        // Available packages for the drawer's per-service "Usa pacchetto" control
        // (port of api_clients.php action=residuals package block; see
        // quickBookClientPackages). Each carries the covered service_ids.
        packages: context.packages,
        // Available prepaid-service balances for the drawer's per-service "Usa
        // prepagato" control (port of api_clients.php action=residuals prepaid block;
        // see quickBookClientPrepaids). Each is tied to ONE service (service_id).
        prepaids: context.prepaids,
        // Available giftcards for the drawer's APPOINTMENT-LEVEL "GiftCard" control
        // (port of api_clients.php action=residuals giftcard block; see
        // quickBookClientGiftcards). Each carries a spendable monetary balance.
        giftcards: context.giftcards,
        // Available giftbox ITEMS for the drawer's per-service "Usa GiftBox" control
        // (see quickBookClientGiftboxes). GiftBox is per-service + ITEM-based; each
        // entry covers exactly its service_id and pins the redeem via
        // instance_id + giftbox_item_id.
        giftboxes: context.giftboxes,
        // Available GIFT (omaggio) SERVICE REWARDS for the drawer's per-service "Usa
        // Omaggio" control (see quickBookClientGifts). A gift instance holds reward items;
        // each entry is a still-available service reward covering its service_id, pinned by
        // instance_id + reward_item_index (the reward's array index in reward_items_json).
        gifts: context.gifts,
        // FIDELITY redeem settings + the client's available points, for the drawer's
        // #qbFidelityBox (Block 4): pointsAvailable = clients.points; euroPerPoint/minPoints/
        // redeemEnabled mirror Fidelity::settings() so the drawer can bound the points-use
        // input and compute the "Sconto Fidelity" (pointsUsed x euroPerPoint) deduction.
        fidelity: context.fidelity,
        // The client's spendable CREDIT balance (clients.credit_balance) for the drawer's
        // inline "Usa credito" input (Block 4). Same source the residuals credit badge uses.
        creditAvailable: context.residuals.credit_available,
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore contesto cliente.");
    }
  }

  // Quick-booking "Apri scheda" residuals DETAIL (read-only). Port of
  // api_clients.php action=residuals's per-item payload, DISPLAY-ONLY: it feeds the
  // drawer's #qbClientResidualsModal detail viewer with the five sections
  // (Servizi/Omaggi/GiftBox/GiftCard/Pacchetti) + a Credito line, each with per-item
  // detail (name, remaining, expiry, source sale #). The inline redeem SELECTION
  // (per-service controls + giftcard/credit rows) lives on the drawer form, so this
  // does NOT return the legacy modal's checkbox/data-* redeem attributes or its
  // in-modal credit/giftcard entry controls (intentional divergence). An empty client
  // returns empty sections + credit {available:0,count:0} — the modal's empty-state.
  if (url.searchParams.get("action") === "residuals") {
    const clientId = parseInteger(url.searchParams.get("client_id"));
    if (clientId <= 0) return jsonError("client_id mancante.");
    try {
      const residuals = await quickBookClientResidualsDetail(tenantSlug, clientId);
      return Response.json({ ok: true, sourceMode: "database", ...residuals });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore residui cliente.");
    }
  }

  // Faithful client DETAIL (action=view) reader. Port of clients.php action=view:
  // the full anagrafica + fidelity points/credit + tags + block status + the
  // appointments/sales history summary + residuals (active packages/prepaids/
  // giftcards/giftbox/gifts + credit) for the header card and history sections.
  if (url.searchParams.get("action") === "detail") {
    const clientId = parseInteger(url.searchParams.get("id"));
    if (clientId <= 0) return jsonError("ID cliente mancante.");
    try {
      const detail = await getManageClientDetail(tenantSlug, clientId);
      if (!detail) return jsonError("Cliente non trovato o non disponibile per le tue sedi.", 404);
      return Response.json({
        ok: true,
        sourceMode: "database",
        ...detail,
        // Gating header/azioni della scheda legacy.
        perms: {
          clientsManage: can(session.user.perms, "clients.manage"),
          clientSheetsManage: can(session.user.perms, "client_sheets.manage"),
          clientConsentsManage: can(session.user.perms, "client_consents.manage"),
          createAppointments: can(session.user.perms, "calendar.view") && can(session.user.perms, "appointments.quick_booking"),
          openCreditMovements: can(session.user.perms, "credit_movements.manage"),
        },
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore dettaglio cliente.");
    }
  }

  // Faithful client STORICO (action=history) reader. Port of clients.php
  // action=history: per-status appointment lists + active packages/giftboxes/
  // giftcards + last 10 quotes/sales + summary counts.
  if (url.searchParams.get("action") === "history") {
    const clientId = parseInteger(url.searchParams.get("id"));
    if (clientId <= 0) return jsonError("ID cliente mancante.");
    try {
      const history = await getManageClientHistory(tenantSlug, clientId);
      if (!history) return jsonError("Cliente non trovato o non disponibile per le tue sedi.", 404);
      return Response.json({
        ok: true,
        sourceMode: "database",
        ...history,
        // Gating dei bottoni "Apri" per sezione + header (legacy canOpen*).
        perms: {
          clientSheetsManage: can(session.user.perms, "client_sheets.manage"),
          createAppointments: can(session.user.perms, "calendar.view") && can(session.user.perms, "appointments.quick_booking"),
          openAppointments: can(session.user.perms, "appointments.manage"),
          openPackages: can(session.user.perms, "packages.clients"),
          openGiftbox: can(session.user.perms, "giftbox.manage"),
          openGiftcard: can(session.user.perms, "giftcard.manage"),
          openQuotes: can(session.user.perms, "quotes.manage"),
          openSales: canAny(session.user.perms, ["pos.manage", "pos.movements", "pos.prepaids", "pos.preorders"]),
        },
      });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore storico cliente.");
    }
  }

  // Delete-cascade SUMMARY (port of clients.php delete-confirm ~1215-1248): the
  // counts of what WILL be deleted/affected, so the UI confirm can warn before
  // the actual POST action=delete.
  if (url.searchParams.get("action") === "delete_summary") {
    const clientId = parseInteger(url.searchParams.get("id"));
    if (clientId <= 0) return jsonError("ID cliente mancante.");
    try {
      const summary = await getManageClientDeleteSummary(tenantSlug, clientId);
      return Response.json({ ok: true, sourceMode: "database", summary });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore riepilogo eliminazione.");
    }
  }

  // Edit-form prefill: return the full client anagrafica for one id. Port of
  // clients.php action=edit (client_load_accessible + client_profile_defaults).
  if (url.searchParams.get("action") === "get") {
    const clientId = parseInteger(url.searchParams.get("id"));
    if (clientId <= 0) return jsonError("ID cliente mancante.");
    try {
      const client = await getDbClient(clientId, tenantSlug);
      if (!client) return jsonError("Cliente non trovato.", 404);
      return Response.json({ ok: true, source: "clients?action=get", sourceMode: "database", client });
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Errore cliente.");
    }
  }

  // LIST (default). Faithful clients list: legacy ordering (created_at DESC
  // LIMIT 200), unknown-client filter, strict sede filter (all_locations=1
  // disables it), blocked INCLUDED (badge "Disattivato"). The payload also
  // carries hasAnyClients (unfiltered — empty state + header "Nuovo" gate) and
  // the caller's permessi for the header/actions gating.
  try {
    const allLocations = ["1", "true", "on", "yes", "all"].includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
    const filterLocationId = allLocations ? 0 : locationId;
    // exclude_blocked=1 (search del drawer/planner, api_clients search legacy):
    // i clienti disattivati non compaiono tra i risultati selezionabili.
    const excludeBlocked = ["1", "true", "on", "yes"].includes(String(url.searchParams.get("exclude_blocked") ?? "").trim().toLowerCase());
    // Paginazione (miglioria approvata 2026-07-16): SOLO quando la pagina
    // chiede ?p=N — drawer/planner e gli altri consumer restano sul
    // comportamento storico (LIMIT 200, nessun offset).
    const rawPage = Number.parseInt(String(url.searchParams.get("p") ?? ""), 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 0;
    const q = url.searchParams.get("q") ?? "";
    let clients = await listDbClients({
      slug: tenantSlug,
      query: q,
      locationId: filterLocationId,
      legacyList: true,
      page,
    });
    if (excludeBlocked) clients = clients.filter((c) => !(c as { archived?: boolean }).archived);
    const [totalCount, anyCount] = await Promise.all([
      page >= 1 ? countDbClients({ slug: tenantSlug, query: q, locationId: filterLocationId, legacyList: true }) : Promise.resolve(clients.length),
      countDbClients({ slug: tenantSlug, legacyList: true }),
    ]);
    return Response.json({
      ok: true,
      sourceMode: "database",
      clients,
      totalCount,
      pageSize: CLIENTS_LIST_PAGE_SIZE,
      currentPage: page >= 1 ? page : 1,
      hasAnyClients: anyCount > 0,
      // Gate della PAGINA Clienti (clients.php requireAnyPerm sui 3 permessi):
      // l'ombrello API è a 9 per drawer/planner, la pagina si gata con questo.
      pageAllowed: canAny(session.user.perms, CLIENTS_PAGE_PERMS),
      perms: {
        clientsManage: can(session.user.perms, "clients.manage"),
        clientSheetsManage: can(session.user.perms, "client_sheets.manage"),
        clientConsentsManage: can(session.user.perms, "client_consents.manage"),
        openCalendar: can(session.user.perms, "calendar.view"),
        quickBooking: can(session.user.perms, "appointments.quick_booking"),
        openAppointments: can(session.user.perms, "appointments.manage"),
        openPackages: can(session.user.perms, "packages.clients"),
        openGiftbox: can(session.user.perms, "giftbox.manage"),
        openGiftcard: can(session.user.perms, "giftcard.manage"),
        openQuotes: can(session.user.perms, "quotes.manage"),
        openSales: canAny(session.user.perms, ["pos.manage", "pos.movements", "pos.prepaids", "pos.preorders"]),
        openCreditMovements: can(session.user.perms, "credit_movements.manage"),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore clienti.");
  }
}

// Data-calendario valida: formato YYYY-MM-DD ED esistente (come checkdate del legacy
// normalize_date). Con il solo regex "2020-99-99" passava e il cliente veniva creato
// con la data nulled in silenzio, invece del messaggio d'errore legacy.
function isValidClientCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Validazioni server verbatim di clients.php POST new/edit (ordine legacy):
// nome, email, PEC, date. Ritorna il messaggio d'errore o null.
function legacyClientValidationError(body: Record<string, string>): string | null {
  const first = String(body.first_name ?? "").trim();
  const last = String(body.last_name ?? "").trim();
  const full = `${first} ${last}`.trim() || String(body.full_name ?? "").trim();
  if (full === "") return "Nome e cognome obbligatori";
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const email = String(body.email ?? "").trim();
  if (email !== "" && !emailRe.test(email)) return "Email non valida.";
  const pec = String(body.pec ?? "").trim();
  if (pec !== "" && !emailRe.test(pec)) return "PEC non valida.";
  // regex + validità calendario (checkdate), fedele a normalize_date del legacy.
  const birth = String(body.birth_date ?? "").trim();
  if (birth !== "" && !isValidClientCalendarDate(birth)) return "Data di nascita non valida.";
  const reg = String(body.registration_date ?? "").trim();
  if (reg !== "" && !isValidClientCalendarDate(reg)) return "Data iscrizione non valida.";
  return null;
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const action = String(body.action ?? url.searchParams.get("action") ?? "create");
  // CREATE = anche il drawer quick-booking (legacy api_clients create_quick,
  // 1351-1352: clients.manage O appointments.quick_booking, testo verbatim);
  // tutte le altre azioni restano clients.manage.
  if (action === "create") {
    if (!canAny(session.user.perms, ["clients.manage", "appointments.quick_booking"])) {
      return jsonError("Permesso insufficiente per creare clienti.", 403);
    }
  } else if (!can(session.user.perms, "clients.manage")) {
    return jsonError("Permesso clienti mancante.", 403);
  }

  try {
    // NB: Modello A (= PHP) — nessuna guardia per-sede sul cliente: l'anagrafica e'
    // tenant-wide, ogni operatore puo' modificarla/prenotarla. Vedi nota nel GET.

    if (action === "create") {
      const invalid = legacyClientValidationError(body);
      if (invalid) return jsonError(invalid);
      const input = await clientInputFromBody(body, tenantSlug);
      if (!input.locationId || input.locationId <= 0) return jsonError("Seleziona una sede valida.");
      // BLOCCO duplicati con conferma (miglioria 2026-07-16, rivista su
      // feedback: il warning post-create era tardivo e il drawer QB lo
      // ignorava — questo gate vive nella route quindi copre OGNI percorso
      // di creazione). Stessa email (case-insensitive) o stesso telefono
      // (ultime 9 cifre) di un cliente esistente -> 409 needsDuplicateConfirm;
      // la UI chiede conferma e reinvia con duplicate_confirmed=1.
      const duplicateConfirmed = ["1", "true", "on", "yes"].includes(String(body.duplicate_confirmed ?? "").trim().toLowerCase());
      if (!duplicateConfirmed) {
        const warning = await duplicateClientWarning(tenantSlug, String(body.email ?? ""), String(body.phone ?? ""));
        if (warning !== "") {
          return Response.json({ ok: false, needsDuplicateConfirm: true, error: warning }, { status: 409 });
        }
      }
      const client = await createDbClient(input, tenantSlug);
      return Response.json({ ok: true, source: "clients?action=create", sourceMode: "database", client, clients: await listDbClients({ slug: tenantSlug }) });
    }

    const id = parseInteger(body.id);
    if (id <= 0) return jsonError("ID cliente mancante.");

    if (action === "update") {
      const invalid = legacyClientValidationError(body);
      if (invalid) return jsonError(invalid);
      // EDIT legacy (1856-1859): la sede va POSTATA (nessun fallback corrente).
      const input = await clientInputFromBody(body, tenantSlug, false);
      if (!input.locationId || input.locationId <= 0) return jsonError("Seleziona una sede valida.");
      const client = await updateDbClient(id, input, tenantSlug);
      return Response.json({ ok: true, source: "clients?action=update", sourceMode: "database", client, clients: await listDbClients({ slug: tenantSlug }) });
    }

    if (action === "archive") {
      const client = await archiveDbClient(id, tenantSlug);
      return Response.json({ ok: true, source: "clients?action=archive", sourceMode: "database", client, clients: await listDbClients({ slug: tenantSlug }) });
    }

    // Disattiva cliente (port of clients.php _mode=block_client): is_blocked=1 +
    // blocked_at=now + a REQUIRED internal note. The blocked client drops out of
    // the default list (listDbClients hides is_blocked=1).
    if (action === "block") {
      const note = String(body.blocked_internal_note ?? body.reason ?? "");
      const client = await blockDbClient(id, tenantSlug, note);
      return Response.json({ ok: true, source: "clients?action=block", sourceMode: "database", client, clients: await listDbClients({ slug: tenantSlug }) });
    }

    // Riattiva cliente (port of clients.php _mode=unblock_client): is_blocked=0,
    // clears blocked_at + note. No associated data is touched.
    if (action === "unblock") {
      const client = await unblockDbClient(id, tenantSlug);
      return Response.json({ ok: true, source: "clients?action=unblock", sourceMode: "database", client, clients: await listDbClients({ slug: tenantSlug }) });
    }

    // Add a tag (port of clients.php _mode=add_tag): find-or-create the tenant tag
    // by name, then map it to the client. Returns the refreshed tag list.
    if (action === "add_tag") {
      const tags = await addManageClientTag(tenantSlug, id, String(body.tag ?? body.name ?? ""));
      return Response.json({ ok: true, source: "clients?action=add_tag", sourceMode: "database", tags });
    }

    // Remove a tag (port of clients.php do=remove_tag): drop the client<->tag map row.
    if (action === "remove_tag") {
      const tags = await removeManageClientTag(tenantSlug, id, parseInteger(body.tag_id, 0));
      return Response.json({ ok: true, source: "clients?action=remove_tag", sourceMode: "database", tags });
    }

    if (action === "delete") {
      // Faithful, ATOMIC cascade (port of clients.php client_delete_execute).
      // Guardie legacy verbatim: motivazione obbligatoria (msg senza accento) e
      // conferma testuale ELIMINA. stock_restore_mode seleziona il ripristino
      // magazzino ('restore_stock') o il default 'no_restore' (la pagina legacy
      // invia sempre no_restore via hidden input).
      const reason = String(body.delete_reason ?? body.reason ?? "").trim();
      if (reason === "") return jsonError("La motivazione e obbligatoria.");
      const confirmText = String(body.delete_confirm_text ?? "").trim();
      if (confirmText !== "ELIMINA") return jsonError("Per confermare scrivi ELIMINA.");
      const stockRestoreMode = String(body.stock_restore_mode ?? "") === "restore_stock" ? "restore_stock" : "no_restore";
      // Sede corrente di sessione = fallback del ripristino stock per le vendite
      // senza location (legacy app_current_location_id in $locationBySale).
      const result = await deleteDbClientCascade(tenantSlug, id, { reason, stockRestoreMode, currentLocationId: Number(session.user.currentLocationId ?? 0) || 0 });
      return Response.json({ ok: true, source: "clients?action=delete", sourceMode: "database", ...result, clients: await listDbClients({ slug: tenantSlug }) });
    }

    return jsonError("Azione clienti non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore clienti.");
  }
}

// Avviso duplicati non bloccante per il CREATE (miglioria 2026-07-16): cerca un
// cliente esistente con la stessa email (LOWER, [[pg-case-sensitivity]]) o lo
// stesso telefono confrontato SOLO sulle cifre (i formati '+39 333...' vs
// '333...' devono collidere). Ritorna il testo dell'avviso o "".
async function duplicateClientWarning(slug: string, email: string, phone: string): Promise<string> {
  try {
    const em = email.trim().toLowerCase();
    const digits = phone.replace(/\D/g, "");
    if (em !== "") {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name", where: "LOWER(TRIM(COALESCE(email,''))) = ?", params: [em], limit: 1 });
      if (rows[0]) return `Esiste già un cliente con questa email: ${String(rows[0].full_name ?? "").trim() || "senza nome"}.`;
    }
    if (digits.length >= 6) {
      // Confronto sulle ULTIME 9 cifre quando il numero e' abbastanza lungo:
      // '+39 333 7654321' e '3337654321' devono collidere nonostante il
      // prefisso internazionale. Sotto le 9 cifre, match esatto.
      const needle = digits.length >= 9 ? digits.slice(-9) : digits;
      const expr = (col: string) => digits.length >= 9
        ? `RIGHT(regexp_replace(COALESCE(${col},''), '\\D', '', 'g'), 9) = ?`
        : `regexp_replace(COALESCE(${col},''), '\\D', '', 'g') = ?`;
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "clients",
        columns: "full_name",
        where: `${expr("phone")} OR ${expr("phone2")} OR ${expr("phone_home")}`,
        params: [needle, needle, needle],
        limit: 1,
      });
      if (rows[0]) return `Esiste già un cliente con questo telefono: ${String(rows[0].full_name ?? "").trim() || "senza nome"}.`;
    }
  } catch {
    // best-effort: nessun avviso se la query fallisce
  }
  return "";
}

// client_resolve_location_id (clients.php 583-596): la sede del CLIENTE si
// valida contro QUALSIASI sede ATTIVA del tenant — il form legacy lista tutte
// le sedi attive, non quelle dell'utente (Modello A: anagrafica tenant-wide;
// resolveManageLocationId filtrerebbe alle sedi di sessione e un operatore
// ristretto non potrebbe assegnare il cliente a un'altra sede). Il CREATE con
// campo vuoto ricade sulla sede corrente (1659-1661); l'EDIT la esige postata
// (1856-1859) — in entrambi i casi 0 => 'Seleziona una sede valida.'.
async function resolveClientLocationId(slug: string, raw: unknown, fallbackCurrent: boolean): Promise<number> {
  const id = Number.parseInt(String(raw ?? "").trim(), 10) || 0;
  if (id > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", where: "id = ? AND COALESCE(is_active,1) = 1", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
    return rows[0] ? id : 0;
  }
  if (!fallbackCurrent) return 0;
  return resolveManageLocationId({ slug, raw: null, fallbackCurrent: true });
}

async function clientInputFromBody(body: Record<string, string>, tenantSlug: string, locationFallbackCurrent = true): Promise<Partial<ManagedClient>> {
  const locationId = await resolveClientLocationId(tenantSlug, body.location_id, locationFallbackCurrent);

  return {
    name: body.name ?? body.client_name ?? body.full_name,
    email: body.email,
    phone: body.phone,
    locationId,
    lastVisit: body.last_visit,
    value: body.value,
    next: body.next,
    note: body.note ?? body.notes,
    tags: body.tags ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined,
    // Full anagrafica (port of clients.php new/edit $_POST fields).
    firstName: body.first_name,
    lastName: body.last_name,
    companyName: body.company_name,
    vatNumber: body.vat_number,
    taxCode: body.tax_code,
    sdi: body.sdi,
    pec: body.pec,
    phoneHome: body.phone_home,
    phone2: body.phone2,
    gender: body.gender,
    birthDate: body.birth_date,
    birthPlace: body.birth_place,
    registrationDate: body.registration_date,
    region: body.region,
    province: body.province,
    city: body.city,
    address: body.address,
    cap: body.cap,
    jobTitle: body.job_title,
  };
}
