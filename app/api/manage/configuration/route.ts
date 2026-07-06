import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { listDbConfigModule, toggleDbConfigRecord, touchDbConfigModule } from "@/lib/db-repositories";
import {
  buildConsentModulePreviewPdf,
  consentModuleAvailableVariables,
  consentModuleSystemPreviewText,
  deleteManageConsentModule,
  ensureSystemGdprModule,
  getManageConsentModule,
  listConsentModuleAssociationCounts,
  saveManageConsentModule,
} from "@/lib/manage-consent-modules";
import { applyExistingPreorders, applyExistingPrepaids, getManagePosSettings, saveManagePosSettings } from "@/lib/manage-pos-settings";
import {
  getFidelityMembershipSettings,
  getGiftboxSettings,
  getGiftcardSettings,
  getPackageSettings,
  getQuoteSettings,
  resetGiftboxTerms,
  resetGiftcardTerms,
  saveFidelityCardValidityDefault,
  saveGiftboxTerms,
  saveGiftboxValidityDefault,
  saveGiftcardTerms,
  saveGiftcardValidityDefault,
  savePackageValidityDefault,
  savePaymentMethods,
  saveQuoteConditions,
  saveQuoteProfile,
} from "@/lib/manage-feature-settings";
import { can, permissionForFeature } from "@/lib/role-permissions";

// Settings modules persisted directly onto the `businesses` row (real save,
// not the generic touch). Their GET returns current values for form prefill.
const FEATURE_SETTINGS_GET: Record<string, (slug: string) => Promise<Awaited<ReturnType<typeof getGiftcardSettings>>>> = {
  giftcard_settings: getGiftcardSettings,
  giftbox_settings: getGiftboxSettings,
  package_settings: getPackageSettings,
  quote_settings: getQuoteSettings,
  fidelity_membership: getFidelityMembershipSettings,
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const url = new URL(request.url);
  const moduleId = url.searchParams.get("module") ?? "custom";
  if (!can(session.user.perms, permissionForFeature(moduleId))) return jsonError("Permesso configurazione mancante.", 403);

  try {
    // Faithful consent-module editor prefill (consent_modules.php action=edit).
    // Returns ONE module's editable fields for the faithful editor form.
    if (moduleId === "consent_modules" && url.searchParams.get("action") === "get") {
      const recordId = parseInteger(url.searchParams.get("id"), 0);
      if (recordId <= 0) return jsonError("ID modulo mancante.");
      await ensureSystemGdprModule(tenantSlug).catch(() => undefined);
      const consentModule = await getManageConsentModule(tenantSlug, recordId);
      if (!consentModule) return jsonError("Modulo consenso non trovato.", 404);
      return Response.json({
        ok: true,
        source: "consent_modules?action=get",
        sourceMode: "database",
        consentModule: { ...consentModule, systemPreviewText: consentModuleSystemPreviewText(consentModule) },
        availableVariables: consentModuleAvailableVariables(),
      });
    }

    // Lista Moduli consenso: come consent_modules.php la pagina garantisce il
    // modulo di sistema (consent_module_ensure_system_gdpr) e mostra
    // 'Associato a N cliente/i' per i moduli non di sistema.
    if (moduleId === "consent_modules") {
      await ensureSystemGdprModule(tenantSlug).catch(() => undefined);
      const moduleState = await listDbConfigModule(moduleId, tenantSlug);
      return Response.json({
        ok: true,
        source: `app/pages/${moduleState.source}`,
        sourceMode: "database",
        module: moduleState,
        records: moduleState.records,
        associationCounts: await listConsentModuleAssociationCounts(tenantSlug),
      });
    }

    const featureGetter = FEATURE_SETTINGS_GET[moduleId];
    const moduleState = moduleId === "pos_settings"
      ? await getManagePosSettings(tenantSlug)
      : featureGetter
        ? await featureGetter(tenantSlug)
        : await listDbConfigModule(moduleId, tenantSlug);

    return Response.json({
      ok: true,
      source: `app/pages/${moduleState.source}`,
      sourceMode: "database",
      module: moduleState,
      records: moduleState.records,
      // quote_settings.php gates i bottoni header su quotes.manage.
      ...(moduleId === "quote_settings" ? { canQuotesManage: can(session.user.perms, "quotes.manage") } : {}),
      // giftbox_settings.php gates: GiftBox su giftbox.manage, Crea su pos.manage.
      ...(moduleId === "giftbox_settings"
        ? { canGiftboxManage: can(session.user.perms, "giftbox.manage"), canCreate: can(session.user.perms, "pos.manage") }
        : {}),
      // giftcard_settings.php gates: GiftCard su giftcard.manage, Crea su pos.manage.
      ...(moduleId === "giftcard_settings"
        ? { canGiftcardManage: can(session.user.perms, "giftcard.manage"), canCreate: can(session.user.perms, "pos.manage") }
        : {}),
      // fidelity_membership_settings.php gates: header 'Livelli Card' su
      // fidelity.levels; stato disabilitato con link Fidelity su fidelity.manage.
      ...(moduleId === "fidelity_membership"
        ? { canFidelityManage: can(session.user.perms, "fidelity.manage"), canLevels: can(session.user.perms, "fidelity.levels") }
        : {}),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore configurazione.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);

  const body = await parseRequestBody(request);
  const url = new URL(request.url);
  const moduleId = body.module ?? url.searchParams.get("module") ?? "custom";
  if (!can(session.user.perms, permissionForFeature(moduleId))) return jsonError("Permesso configurazione mancante.", 403);

  const action = body.action ?? "touch";

  try {
    if (moduleId === "pos_settings") {
      if (action === "save" || action === "save_pos_expiry_settings") {
        const moduleState = await saveManagePosSettings(tenantSlug, body, session.user.id);
        return Response.json({ ok: true, source: "pos_settings?action=save_pos_expiry_settings", sourceMode: "database", module: moduleState, records: moduleState.records });
      }

      if (action === "apply_existing_preorders") {
        const { count, module } = await applyExistingPreorders(tenantSlug);
        return Response.json({ ok: true, source: "pos_settings?action=apply_existing_preorders", sourceMode: "database", count, module, records: module.records });
      }

      if (action === "apply_existing_prepaids") {
        const { count, module } = await applyExistingPrepaids(tenantSlug);
        return Response.json({ ok: true, source: "pos_settings?action=apply_existing_prepaids", sourceMode: "database", count, module, records: module.records });
      }

      const moduleState = await getManagePosSettings(tenantSlug);
      return Response.json({ ok: true, source: "pos_settings", sourceMode: "database", module: moduleState, records: moduleState.records });
    }

    if (FEATURE_SETTINGS_GET[moduleId]) {
      const saved = await saveFeatureSettings(moduleId, action, tenantSlug, body);
      if (saved) {
        return Response.json({ ok: true, source: `${moduleId}?action=${action}`, sourceMode: "database", message: saved.message, module: saved.module, records: saved.module.records });
      }
      // Unknown action for a settings module: return current state untouched.
      const moduleState = await FEATURE_SETTINGS_GET[moduleId](tenantSlug);
      return Response.json({ ok: true, source: moduleId, sourceMode: "database", module: moduleState, records: moduleState.records });
    }

    // Faithful consent-module editor save/delete (consent_modules.php
    // _mode=save_module / action=delete). Backed by the dedicated reader/saver
    // over the consent_modules table; the generic config listing reflects the
    // change on the next list load.
    // Anteprima PDF del template (consent_modules.php preview=pdf): accetta i
    // valori NON salvati del form e streamma il PDF con i dati demo legacy.
    if (moduleId === "consent_modules" && action === "preview_pdf") {
      const pdf = await buildConsentModulePreviewPdf(tenantSlug, body);
      return new Response(new Uint8Array(pdf.bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${pdf.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (moduleId === "consent_modules" && (action === "save" || action === "save_module")) {
      const consentModule = await saveManageConsentModule(tenantSlug, body);
      const moduleState = await listDbConfigModule(moduleId, tenantSlug);
      return Response.json({ ok: true, source: "consent_modules?action=save", sourceMode: "database", consentModule, module: moduleState, records: moduleState.records });
    }
    if (moduleId === "consent_modules" && (action === "delete" || action === "delete_module")) {
      const result = await deleteManageConsentModule(tenantSlug, parseInteger(body.id ?? body.record_id, 0));
      const moduleState = await listDbConfigModule(moduleId, tenantSlug);
      return Response.json({ ok: true, source: "consent_modules?action=delete", sourceMode: "database", ...result, module: moduleState, records: moduleState.records });
    }

    if (action === "toggle") {
      const recordId = parseInteger(body.record_id ?? body.id);
      const active = ["1", "true", "yes", "on"].includes((body.active ?? "").toLowerCase());
      const moduleState = await toggleDbConfigRecord(moduleId, recordId, active, tenantSlug);
      return Response.json({ ok: true, source: `configuration?action=toggle&module=${moduleId}`, sourceMode: "database", module: moduleState, records: moduleState.records });
    }

    const moduleState = await touchDbConfigModule(moduleId, tenantSlug);
    return Response.json({ ok: true, source: `configuration?action=touch&module=${moduleId}`, sourceMode: "database", module: moduleState, records: moduleState.records });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore configurazione.");
  }
}

type FeatureSaveResult = { message: string; module: Awaited<ReturnType<typeof getGiftcardSettings>> };

// Dispatch a settings-module save action to the matching persistence function.
// Returns null when the action is not a recognized save for the module.
async function saveFeatureSettings(
  moduleId: string,
  action: string,
  slug: string,
  body: Record<string, string>,
): Promise<FeatureSaveResult | null> {
  if (moduleId === "giftcard_settings") {
    // Messaggi flash e wrapper errori verbatim di giftcard_settings.php
    // (i msg condizioni sono senza punto finale).
    if (action === "save_giftcard_validity_default") {
      try {
        return { message: "Impostazioni scadenza GiftCard salvate. Le GiftCard già presenti rimarranno invariate.", module: await saveGiftcardValidityDefault(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonne mancanti: aggiorna il DB con il dump SQL completo aggiornato (scadenza GiftCard).");
        throw new Error(`Errore salvataggio impostazioni scadenza GiftCard: ${msg}`);
      }
    }
    if (action === "save" || action === "save_giftcard_terms") {
      try {
        return { message: "Condizioni GiftCard salvate", module: await saveGiftcardTerms(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonna mancante: aggiorna il DB con il dump SQL completo aggiornato (GiftCard condizioni).");
        throw new Error(`Errore salvataggio condizioni GiftCard: ${msg}`);
      }
    }
    if (action === "reset_giftcard_terms") {
      try {
        return { message: "Condizioni GiftCard ripristinate", module: await resetGiftcardTerms(slug) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonna mancante: aggiorna il DB con il dump SQL completo aggiornato (GiftCard condizioni).");
        throw new Error(`Errore ripristino condizioni GiftCard: ${msg}`);
      }
    }
    return null;
  }
  if (moduleId === "giftbox_settings") {
    // Messaggi flash e wrapper errori verbatim di giftbox_settings.php.
    if (action === "save_giftbox_validity_default") {
      try {
        return { message: "Impostazioni scadenza GiftBox salvate. Le GiftBox già presenti rimarranno invariate.", module: await saveGiftboxValidityDefault(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonne mancanti: aggiorna il DB con il dump SQL completo aggiornato (scadenza GiftBox).");
        throw new Error(`Errore salvataggio impostazioni scadenza GiftBox: ${msg}`);
      }
    }
    if (action === "save" || action === "save_giftbox_terms") {
      try {
        return { message: "Condizioni GiftBox salvate", module: await saveGiftboxTerms(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonna mancante: aggiorna il DB con il dump SQL completo aggiornato (GiftBox condizioni).");
        throw new Error(`Errore salvataggio condizioni GiftBox: ${msg}`);
      }
    }
    if (action === "reset_giftbox_terms") {
      try {
        return { message: "Condizioni GiftBox ripristinate", module: await resetGiftboxTerms(slug) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonna mancante: aggiorna il DB con il dump SQL completo aggiornato (GiftBox condizioni).");
        throw new Error(`Errore ripristino condizioni GiftBox: ${msg}`);
      }
    }
    return null;
  }
  if (moduleId === "package_settings") {
    // Messaggio verbatim del redirect legacy (package_settings.php).
    if (action === "save" || action === "save_package_validity_default") return { message: "Impostazioni scadenza Pacchetti salvate. I pacchetti gia presenti rimarranno invariati.", module: await savePackageValidityDefault(slug, body) };
    return null;
  }
  if (moduleId === "quote_settings") {
    // Messaggi flash e wrapper errori verbatim di quote_settings.php (i msg
    // del redirect legacy sono senza punto finale).
    if (action === "save_quote_profile" || action === "save_profile_quote") {
      try {
        return { message: "Dati anagrafici salvati", module: await saveQuoteProfile(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Errore salvataggio dati anagrafici: ${msg} (se persiste, controlla che lo schema business sia aggiornato e che il DB possa eseguire ALTER/UPDATE)`);
      }
    }
    if (action === "save_quote_conditions") {
      try {
        return { message: "Condizioni preventivo salvate", module: await saveQuoteConditions(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonne mancanti: aggiorna il DB con il dump SQL completo aggiornato (Preventivi impostazioni).");
        throw new Error(`Errore salvataggio condizioni preventivo: ${msg}`);
      }
    }
    if (action === "save_payment_methods") {
      try {
        return { message: "Metodi di pagamento salvati", module: await savePaymentMethods(slug, body) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/unknown column|column .* does not exist/i.test(msg)) throw new Error("Colonna mancante: aggiorna il DB con il dump SQL completo aggiornato (Preventivi metodi di pagamento).");
        throw new Error(`Errore salvataggio metodi di pagamento: ${msg}`);
      }
    }
    return null;
  }
  if (moduleId === "fidelity_membership") {
    if (action === "save" || action === "save_fidelity_card_validity_default") {
      // Il writer compone il messaggio legacy per modalità (snapshot/restore/
      // preserve, "Nessuna modifica da salvare.", clamp finestra).
      const saved = await saveFidelityCardValidityDefault(slug, body);
      return { message: saved.message ?? "Impostazioni tessera Fidelity salvate.", module: saved };
    }
    return null;
  }
  return null;
}
