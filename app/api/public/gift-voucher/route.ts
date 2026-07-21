import { getGiftVoucherByToken } from "@/lib/gifts-instances";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public GIFT (omaggio) voucher API — port of app/pages/gift_voucher.php PUBLIC
// mode (index.php?page=gift_voucher&public=1&token=<64hex>). In modalità
// pubblica il lookup è SOLO via voucher_public_token (64 hex, il codice
// OM-000000 resta un segreto di cassa); 404 sul miss. Il payload rende il
// voucher stampabile: codice, stato (watermark per non-disponibile), cliente,
// date, tabella "Contenuto Omaggi" (VOCE/TOT/USATA/RIMANENTE), nota cliente,
// condizioni, intestazione attività.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const slug = String(url.searchParams.get("slug") ?? "").trim();
    const token = String(url.searchParams.get("token") ?? "").trim();

    const found = await getGiftVoucherByToken(slug, token);
    if (!found) {
      return Response.json({ ok: false, error: "Voucher omaggio non trovato." }, { status: 404 });
    }
    const { detail, business } = found;

    // Se le unità residue sono 0 il voucher mostra "riscattato" anche quando la
    // colonna state non è ancora stata riallineata (gift_voucher.php ~195-204;
    // getGiftInstanceDetail applica comunque lo stato derivato).
    const remaining = detail.rewardItems.reduce((s, it) => s + it.qtyRemaining, 0);
    const state = detail.state === "disponibile" && detail.rewardItems.length && remaining <= 0 ? "riscattato" : detail.state;

    return Response.json({
      ok: true,
      voucher: {
        code: detail.code,
        state,
        giftName: detail.giftName,
        giftDescription: detail.giftDescription,
        clientName: detail.client.name,
        unlockedAt: detail.unlockedAt,
        expiresAt: detail.expiresAt,
        redeemedAt: detail.redeemedAt,
        note: detail.note,
        termsText: detail.termsEnabled ? detail.termsText : "",
        items: detail.rewardItems.map((it) => ({
          label: it.label,
          qtyTotal: it.qtyTotal,
          qtyRedeemed: it.qtyRedeemed,
          qtyRemaining: it.qtyRemaining,
        })),
      },
      business,
    });
  } catch (error) {
    // Solo messaggi di dominio al pubblico; il tecnico (pg/rete) va nei log.
    const message = error instanceof Error ? error.message : "";
    const isTechnical = !message || /relation|column|syntax|SQLSTATE|ECONN|ETIMEDOUT|ENOTFOUND|timeout|SSL|pool|connect|constraint|duplicate key|deadlock|violates|null value|permission denied|out of memory/i.test(message);
    if (isTechnical) console.error("[public/gift-voucher GET]", message || error);
    return Response.json(
      { ok: false, error: isTechnical ? "Errore voucher omaggio." : message },
      { status: 500 },
    );
  }
}
