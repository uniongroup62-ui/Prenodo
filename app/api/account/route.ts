import { jsonError, parseInteger, parseRequestBody } from "@/lib/api-utils";
import {
  cancelPublicCustomerEmailChange,
  changePublicCustomerPassword,
  clearPublicCustomerSession,
  confirmPublicCustomerEmailChange,
  currentPublicCustomerSession,
  issuePublicCustomerVerificationCode,
  loginPublicCustomer,
  publicCustomerActivities,
  publicCustomerFavoriteKeys,
  publicCustomerFavorites,
  registerPublicCustomer,
  removePublicCustomerFavorite,
  requestPublicCustomerEmailChange,
  requestPublicCustomerPasswordReset,
  resetPublicCustomerPassword,
  startPublicCustomerSession,
  togglePublicCustomerFavorite,
  updatePublicCustomerProfile,
  verifyPublicCustomerCode,
  type PublicCustomer,
} from "@/lib/public-customer-account";
import {
  cancelPublicCustomerAppointment,
  decidePublicCustomerQuote,
  listPublicCustomerAppointments,
  listPublicCustomerPackages,
  listPublicCustomerQuotes,
  updatePublicCustomerReferenceLocation,
} from "@/lib/public-customer-appointments";

export async function GET() {
  const account = await currentPublicCustomerSession();
  return Response.json({
    ok: true,
    ...(await accountState(account)),
  });
}

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  const action = String(body.action ?? "login").trim();

  try {
    if (action === "login") {
      const result = await loginPublicCustomer({ email: body.email ?? "", password: body.password ?? "" });
      if (!result.ok) return jsonError(result.error, 401);
      if ("requiresVerification" in result) {
        return Response.json({
          ok: true,
          requiresVerification: true,
          accountId: result.accountId,
          email: result.email,
          devCode: result.devCode,
        });
      }
      const account = await startPublicCustomerSession(result.account.id, request) ?? result.account;
      return Response.json({ ok: true, ...(await accountState(account)) });
    }

    if (action === "register") {
      if ((body.password ?? "") !== (body.password_confirm ?? body.confirm_password ?? "")) {
        return jsonError("Le password non coincidono.");
      }
      const result = await registerPublicCustomer({
        firstName: body.first_name ?? body.firstName ?? "",
        lastName: body.last_name ?? body.lastName ?? "",
        phone: body.phone ?? "",
        email: body.email ?? "",
        password: body.password ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      return Response.json({
        ok: true,
        requiresVerification: true,
        accountId: result.accountId,
        email: result.email,
        devCode: result.devCode,
      });
    }

    if (action === "verify" || action === "verify_email") {
      const accountId = parseInteger(body.account_id ?? body.accountId, 0);
      const result = await verifyPublicCustomerCode(accountId, body.code ?? "");
      if (!result.ok) return jsonError(result.error);
      const account = await startPublicCustomerSession(result.account.id, request) ?? result.account;
      return Response.json({ ok: true, ...(await accountState(account)) });
    }

    if (action === "resend_verification") {
      const result = await issuePublicCustomerVerificationCode(parseInteger(body.account_id ?? body.accountId, 0), true);
      if (!result.ok) return jsonError(result.error);
      return Response.json({
        ok: true,
        requiresVerification: result.requiresVerification,
        email: result.email,
        alreadySent: result.alreadySent,
        devCode: result.devCode,
      });
    }

    if (action === "forgot" || action === "request_password_reset") {
      const result = await requestPublicCustomerPasswordReset(body.email ?? "");
      if (!result.ok) return jsonError(result.error);
      return Response.json({
        ok: true,
        message: result.message,
        devToken: result.devToken,
      });
    }

    if (action === "reset" || action === "reset_password") {
      const result = await resetPublicCustomerPassword({
        email: body.email ?? "",
        token: body.token ?? "",
        password: body.password ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      const account = await startPublicCustomerSession(result.account.id, request) ?? result.account;
      return Response.json({ ok: true, ...(await accountState(account)) });
    }

    if (action === "logout") {
      await clearPublicCustomerSession();
      return Response.json({ ok: true, ...(await accountState(null)) });
    }

    const account = await currentPublicCustomerSession();
    if (!account) return jsonError("Accesso cliente richiesto.", 401);

    if (action === "update_profile") {
      const result = await updatePublicCustomerProfile(account.id, {
        firstName: body.first_name ?? body.firstName ?? "",
        lastName: body.last_name ?? body.lastName ?? "",
        phone: body.phone ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      return Response.json({ ok: true, ...(await accountState(result.account)) });
    }

    if (action === "change_password") {
      const result = await changePublicCustomerPassword(account.id, {
        currentPassword: body.current_password ?? body.currentPassword ?? "",
        newPassword: body.new_password ?? body.newPassword ?? "",
        confirmPassword: body.confirm_password ?? body.confirmPassword ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      return Response.json({ ok: true, ...(await accountState(result.account)) });
    }

    if (action === "request_email_change") {
      const result = await requestPublicCustomerEmailChange(account.id, {
        newEmail: body.new_email ?? body.newEmail ?? "",
        currentPassword: body.current_password ?? body.currentPassword ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      return Response.json({ ok: true, ...(await accountState(result.account)), devCode: result.devCode });
    }

    if (action === "confirm_email_change") {
      const result = await confirmPublicCustomerEmailChange(account.id, body.code ?? "");
      if (!result.ok) return jsonError(result.error);
      return Response.json({ ok: true, ...(await accountState(result.account)) });
    }

    if (action === "cancel_email_change") {
      const result = await cancelPublicCustomerEmailChange(account.id);
      if (!result.ok) return jsonError(result.error);
      return Response.json({ ok: true, ...(await accountState(result.account)) });
    }

    // Sede di riferimento (port of mode=customer_update_reference_location).
    if (action === "update_reference_location") {
      const tenantSlug = String(body.tenant_slug ?? body.tenant ?? "").trim().toLowerCase();
      const locationId = parseInteger(body.location_id, 0);
      if (!tenantSlug) return jsonError("Seleziona una sede valida.");
      await updatePublicCustomerReferenceLocation({ accountId: account.id, tenantSlug, locationId });
      return Response.json({ ok: true, message: "Impostazioni aggiornate.", location_id: locationId, ...(await accountState(account)) });
    }

    // Area cliente — le mie prenotazioni (port of booking.php mode=my_appointments):
    // the account's appointments across every linked activity, with can_cancel.
    if (action === "appointments" || action === "my_appointments") {
      const appointments = await listPublicCustomerAppointments(account.id, account.email);
      return Response.json({ ok: true, appointments });
    }

    // Annulla prenotazione (port of mode=cancel_appointment): ownership + the
    // tenant cancel policy, then the pending/scheduled→canceled path (redeems
    // restored, lifecycle email best-effort). Legacy error strings.
    if (action === "cancel_appointment") {
      const tenantSlug = String(body.tenant_slug ?? body.tenant ?? "").trim().toLowerCase();
      const appointmentId = parseInteger(body.appointment_id ?? body.id, 0);
      if (!tenantSlug || appointmentId <= 0) return jsonError("Appuntamento non valido");
      await cancelPublicCustomerAppointment({
        accountId: account.id,
        email: account.email,
        tenantSlug,
        appointmentId,
      });
      return Response.json({ ok: true, appointments: await listPublicCustomerAppointments(account.id, account.email) });
    }

    // I miei pacchetti (port of booking.php mode=my_packages).
    if (action === "packages" || action === "my_packages") {
      const packages = await listPublicCustomerPackages(account.id);
      return Response.json({ ok: true, packages });
    }

    // I miei preventivi (port of mode=my_quotes).
    if (action === "quotes" || action === "my_quotes") {
      const quotes = await listPublicCustomerQuotes(account.id, account.email);
      return Response.json({ ok: true, quotes });
    }

    // Accetta/Rifiuta preventivo (port of mode=quote_decision). Legacy guards +
    // error strings; the refreshed list rides back for the UI.
    if (action === "quote_decision") {
      const tenantSlug = String(body.tenant_slug ?? body.tenant ?? "").trim().toLowerCase();
      const quoteId = parseInteger(body.quote_id ?? body.id, 0);
      const decision = String(body.decision ?? "").trim().toLowerCase();
      if (quoteId <= 0) return jsonError("Preventivo non valido");
      if (decision !== "accept" && decision !== "reject") return jsonError("Azione non valida");
      if (!tenantSlug) return jsonError("Preventivo non valido");
      await decidePublicCustomerQuote({
        accountId: account.id,
        email: account.email,
        tenantSlug,
        quoteId,
        decision,
      });
      return Response.json({ ok: true, quotes: await listPublicCustomerQuotes(account.id, account.email) });
    }

    if (action === "toggle_favorite") {
      const result = await togglePublicCustomerFavorite(account.id, {
        tenantSlug: body.tenant_slug ?? body.tenantSlug ?? "",
        locationId: parseInteger(body.location_id ?? body.locationId, 0),
        locationSlug: body.location_slug ?? body.locationSlug ?? "",
      });
      if (!result.ok) return jsonError(result.error);
      return Response.json({
        ok: true,
        active: result.active,
        key: result.key,
        favoriteKeys: await publicCustomerFavoriteKeys(account.id),
      });
    }

    if (action === "remove_favorite") {
      const result = await removePublicCustomerFavorite(
        account.id,
        body.tenant_slug ?? body.tenantSlug ?? "",
        parseInteger(body.location_id ?? body.locationId, 0),
      );
      if (!result.ok) return jsonError(result.error);
      return Response.json({
        ok: true,
        favoriteKeys: await publicCustomerFavoriteKeys(account.id),
        favorites: await publicCustomerFavorites(account.id),
      });
    }

    return jsonError("Azione account non riconosciuta.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore account cliente.", 400);
  }
}

async function accountState(account: PublicCustomer | null) {
  if (!account) {
    return {
      user: null,
      favorites: [],
      favoriteKeys: {},
      activities: [],
    };
  }

  const [favorites, favoriteKeys, activities] = await Promise.all([
    publicCustomerFavorites(account.id),
    publicCustomerFavoriteKeys(account.id),
    publicCustomerActivities(account.id),
  ]);

  return {
    user: account,
    favorites,
    favoriteKeys,
    activities,
  };
}
