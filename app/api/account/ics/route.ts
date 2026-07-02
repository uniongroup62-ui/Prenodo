import { currentPublicCustomerSession } from "@/lib/public-customer-account";
import { publicCustomerAppointmentIcs } from "@/lib/public-customer-appointments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Port of booking.php mode=ics: the .ics calendar file for an appointment the
// LOGGED customer owns, looked up by its public_code (the legacy 404s with a
// plain-text body when the code is unknown/not owned; same here).
export async function GET(request: Request) {
  const account = await currentPublicCustomerSession();
  if (!account) return new Response("Non autenticato", { status: 401 });

  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") ?? "").trim();
  const host = request.headers.get("host") ?? "prenodo";
  const file = code ? await publicCustomerAppointmentIcs(account.id, account.email, code, host) : null;
  if (!file) return new Response("Appuntamento non trovato", { status: 404 });

  return new Response(file.content, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
