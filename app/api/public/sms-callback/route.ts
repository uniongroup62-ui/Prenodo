import { timingSafeEqual } from "node:crypto";
import { smsConfig } from "@/lib/sms";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// WEBHOOK DELIVERY-RECEIPT SMS — port fedele di api_sms_callback.php:
// endpoint PUBBLICO (il provider OpenAPI non ha sessione), POST only, secret
// obbligatorio confrontato in modo timing-safe (?token= o header
// X-OpenAPI-SMS-Secret / X-Callback-Secret). Il payload viene cercato
// ricorsivamente (chiavi case-insensitive, JSON annidati inclusi) per
// reminder_id / message_id / stato; aggiorna la riga `reminders` del canale
// sms (provider_state, delivered_at, status failed|sent, last_error,
// provider_response_json troncato a 65000 char). Risposte JSON identiche.

const FAILED_STATES = new Set(["UNDELIVERABLE", "REJECTED", "EXPIRED"]);

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: status === 405 ? { Allow: "POST" } : undefined });
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Ricerca ricorsiva case-insensitive di una chiave (api_sms_callback_find_value):
// scende in oggetti/array e in stringhe che contengono JSON.
function findValue(source: unknown, keys: string[], depth = 0): string {
  if (depth > 6 || source === null || source === undefined) return "";
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return findValue(JSON.parse(trimmed), keys, depth + 1);
      } catch {
        return "";
      }
    }
    return "";
  }
  if (Array.isArray(source)) {
    for (const item of source) {
      const found = findValue(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof source === "object") {
    const entries = Object.entries(source as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (keys.includes(key.toLowerCase()) && (typeof value === "string" || typeof value === "number")) {
        const str = String(value).trim();
        if (str) return str;
      }
    }
    for (const [, value] of entries) {
      const found = findValue(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

export async function GET() {
  return json(405, { ok: false, error: "Metodo non consentito." });
}

export async function POST(request: Request) {
  const config = smsConfig();
  const secret = String(config.callbackSecret ?? "").trim();
  if (!secret) return json(403, { ok: false, error: "Callback SMS non configurata." });

  const url = new URL(request.url);
  const provided =
    String(url.searchParams.get("token") ?? "").trim() ||
    String(request.headers.get("x-openapi-sms-secret") ?? "").trim() ||
    String(request.headers.get("x-callback-secret") ?? "").trim();
  if (!provided || !safeEqual(provided, secret)) {
    return json(403, { ok: false, error: "Token callback non valido." });
  }

  // Payload: JSON body, fallback form field `data` (JSON), fallback form intero.
  let payload: unknown = null;
  const contentType = String(request.headers.get("content-type") ?? "");
  try {
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else if (contentType.includes("form")) {
      const form = await request.formData();
      const data = form.get("data");
      if (typeof data === "string" && data.trim()) {
        try {
          payload = JSON.parse(data);
        } catch {
          payload = data;
        }
      } else {
        payload = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
      }
    } else {
      const raw = await request.text();
      payload = raw.trim() ? JSON.parse(raw) : null;
    }
  } catch {
    payload = null;
  }
  if (!payload || (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload as object).length === 0)) {
    return json(422, { ok: false, error: "Payload callback vuoto o non valido." });
  }

  const reminderId = Number.parseInt(
    String(url.searchParams.get("rid") ?? "").trim() || findValue(payload, ["reminder_id", "reminderid", "rid"]),
    10,
  ) || 0;
  const messageId = findValue(payload, ["message_id", "messageid", "uuid", "id"]);
  if (reminderId <= 0 && !messageId) {
    return json(422, { ok: false, error: "Identificativo reminder o messaggio mancante." });
  }

  const stateRaw = findValue(payload, ["state", "status", "message_status", "messagestatus"]);
  const state = stateRaw.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const failed = FAILED_STATES.has(state);
  const delivered = state === "DELIVERED";
  const queueStatus = failed ? "failed" : "sent";
  const lastError = failed ? `SMS provider: ${state}` : null;
  const responseJson = JSON.stringify(payload).slice(0, 65000);

  try {
    let updated = 0;
    if (reminderId > 0) {
      // cross-tenant: webhook del provider SMS — la chiave e' provider_message_id, globalmente unica.
      const result = await dbExecute(
        `UPDATE \`reminders\` SET provider = 'openapi_sms',
                provider_message_id = COALESCE(NULLIF(?, ''), provider_message_id),
                provider_state = ?, provider_response_json = ?, last_checked_at = NOW(),
                delivered_at = CASE WHEN ? = 1 THEN NOW() ELSE delivered_at END,
                status = ?, last_error = ?
          WHERE id = ? AND channel = 'sms'`,
        [messageId, state || null, responseJson, delivered ? 1 : 0, queueStatus, lastError, reminderId],
      );
      updated = Number(result.affectedRows ?? 0);
    } else {
      // cross-tenant: webhook del provider SMS — la chiave e' provider_message_id, globalmente unica.
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT id FROM \`reminders\` WHERE channel = 'sms' AND provider = 'openapi_sms' AND provider_message_id = ? LIMIT 1`,
        [messageId],
      );
      if (rows[0]) {
        // cross-tenant: webhook del provider SMS — aggiorna la riga trovata sopra per provider_message_id.
        const result = await dbExecute(
          `UPDATE \`reminders\` SET provider_state = ?, provider_response_json = ?, last_checked_at = NOW(),
                  delivered_at = CASE WHEN ? = 1 THEN NOW() ELSE delivered_at END,
                  status = ?, last_error = ?
            WHERE id = ?`,
          [state || null, responseJson, delivered ? 1 : 0, queueStatus, lastError, Number(rows[0].id)],
        );
        updated = Number(result.affectedRows ?? 0);
      }
    }
    if (updated <= 0) return json(404, { ok: false, error: "Reminder SMS non trovato." });
    return json(200, { ok: true });
  } catch {
    return json(500, { ok: false, error: "Errore aggiornamento callback SMS." });
  }
}
