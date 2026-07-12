import "server-only";

// Stato "visto" delle notifiche browser PERSISTITO LATO SERVER (deviazione
// migliorativa approvata dall'utente 2026-07-13): il legacy tiene le chiavi
// viste SOLO in localStorage (View.php 2013-2021) — cambiando browser o
// pulendo lo storage gli eventi già notificati si ripresentano. Qui la
// colonna users.browser_notification_seen fa da L2: la shell la MERGIA nel
// localStorage all'avvio del poller (prima della creazione del feed) e vi
// ripubblica le scritture con debounce. Il motore client resta INTATTO
// (storage sincrono iniettato); su errori server si degrada al solo
// localStorage, come prima.
//
// Formato colonna: JSON { "<locationId>": { seen: string[], hydrated: 0|1 } }
// — stesso scoping per-sede del prefisso localStorage; seen cap 180 come il
// writeSeen del motore.

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, quoteIdentifier, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

const SEEN_CAP = 180;

export type BrowserNotificationSeenState = { seen: string[]; hydrated: boolean };

async function ensureSeenColumn(slug: string): Promise<void> {
  const users = await tenantTable(slug, "users");
  if (await columnExists(users.name, "browser_notification_seen")) return;
  await dbExecute(
    `ALTER TABLE ${quoteIdentifier(users.name)} ADD COLUMN ${quoteIdentifier("browser_notification_seen")} TEXT NULL DEFAULT NULL`,
  ).catch(() => undefined);
}

// Decode tollerante (come json_decode PHP): JSON corrotto -> stato vuoto.
function decodeStates(raw: string): Record<string, { seen?: unknown; hydrated?: unknown }> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSeen(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(Boolean).map(String))).slice(-SEEN_CAP);
}

async function readRaw(slug: string, userId: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "users",
    columns: "browser_notification_seen",
    where: "id = ?",
    params: [userId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.browser_notification_seen ?? "");
}

export async function getBrowserNotificationSeenState(
  slug: string,
  userId: number,
  locationId: number,
): Promise<BrowserNotificationSeenState> {
  if (userId <= 0) return { seen: [], hydrated: false };
  await ensureSeenColumn(slug);
  const states = decodeStates(await readRaw(slug, userId));
  const entry = states[String(Math.max(0, locationId))] ?? {};
  return { seen: normalizeSeen(entry.seen), hydrated: entry.hydrated === 1 || entry.hydrated === true };
}

export async function saveBrowserNotificationSeenState(
  slug: string,
  userId: number,
  locationId: number,
  seen: unknown,
  hydrated: boolean,
): Promise<void> {
  if (userId <= 0) return;
  await ensureSeenColumn(slug);
  const states = decodeStates(await readRaw(slug, userId));
  states[String(Math.max(0, locationId))] = { seen: normalizeSeen(seen), hydrated: hydrated ? 1 : 0 };
  await tenantUpdate({
    slug,
    table: "users",
    id: userId,
    values: { browser_notification_seen: JSON.stringify(states) },
  }).catch(() => undefined);
}
