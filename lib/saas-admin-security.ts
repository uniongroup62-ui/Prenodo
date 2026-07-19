import "server-only";

import crypto from "node:crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, tableExists } from "@/lib/tenant-db";
import { businessNowDateTime } from "@/lib/business-datetime";

// --- Impostazioni pannello + anti-spam alert (rifiniture 2026-07-19) --------
// saas_admin_settings: policy del pannello (es. require_totp).
// saas_admin_alerts: ultima notifica inviata per chiave — un alert non si
// ripete entro il cooldown. DDL in dialetto POSTGRES (trappola toPostgresSql).

let adminSettingsEnsured = false;

async function ensureAdminSettingsSchema(): Promise<void> {
  if (adminSettingsEnsured) return;
  if (!(await tableExists("saas_admin_settings"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_admin_settings" (
      "key" VARCHAR(60) PRIMARY KEY,
      "value" VARCHAR(500) NOT NULL
    )`,
    );
  }
  if (!(await tableExists("saas_admin_alerts"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_admin_alerts" (
      "alert_key" VARCHAR(120) PRIMARY KEY,
      "last_sent_at" TIMESTAMP NOT NULL
    )`,
    );
  }
  adminSettingsEnsured = true;
}

export async function getAdminSetting(key: string): Promise<string> {
  await ensureAdminSettingsSchema();
  const rows = await dbQuery<RowDataPacket[]>("SELECT `value` FROM `saas_admin_settings` WHERE `key`=? LIMIT 1", [key]).catch(() => []);
  return String(rows[0]?.value ?? "");
}

export async function setAdminSetting(key: string, value: string): Promise<void> {
  await ensureAdminSettingsSchema();
  await dbExecute(
    "INSERT INTO `saas_admin_settings`(`key`,`value`) VALUES(?,?) ON CONFLICT (\"key\") DO UPDATE SET \"value\"=EXCLUDED.\"value\"",
    [key, value],
  );
}

// True se l'alert NON e' stato inviato nelle ultime `hours` ore.
export async function alertNotRecentlySent(alertKey: string, hours = 24): Promise<boolean> {
  await ensureAdminSettingsSchema();
  const rows = await dbQuery<RowDataPacket[]>("SELECT last_sent_at FROM `saas_admin_alerts` WHERE alert_key=? LIMIT 1", [alertKey]).catch(() => []);
  const raw = String(rows[0]?.last_sent_at ?? "");
  if (!raw) return true;
  const ms = new Date(raw.replace(" ", "T")).getTime();
  return !Number.isFinite(ms) || Date.now() - ms > hours * 3_600_000;
}

export async function markAlertSent(alertKey: string): Promise<void> {
  await ensureAdminSettingsSchema();
  const now = localSqlDate();
  await dbExecute(
    "INSERT INTO `saas_admin_alerts`(alert_key,last_sent_at) VALUES(?,?) ON CONFLICT (\"alert_key\") DO UPDATE SET \"last_sent_at\"=EXCLUDED.\"last_sent_at\"",
    [alertKey, now],
  );
}

function localSqlDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Sicurezza del pannello SaaS Admin (Fase 1 blindatura, 2026-07-18):
// - origin-check per le POST (difesa CSRF oltre al sameSite strict);
// - TOTP RFC 6238 (SHA1, 6 cifre, step 30s) implementato su node:crypto,
//   niente dipendenze esterne;
// - audit di OGNI azione mutativa admin su saas_admin_audit (wall-time Roma).

// --- Origin check -----------------------------------------------------------

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  // Richieste senza Origin (curl, server-to-server con cookie assente) non
  // sono vettori CSRF da browser: il check vale quando l'header c'è.
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new Error("Richiesta non valida (origin).");
  }
  if (!host || originHost !== host) {
    throw new Error("Richiesta bloccata: origine non consentita.");
  }
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";
}

// --- TOTP (RFC 6238) --------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

// Verifica con finestra ±1 step (tolleranza clock 30s).
export function verifyTotp(secret: string, codeInput: string): boolean {
  const code = String(codeInput ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code) || !secret) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [0, -1, 1]) {
    const expected = totpAt(secret, counter + delta);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

export function totpUri(email: string, secret: string): string {
  const label = encodeURIComponent(`Prenodo Admin:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Prenodo Admin")}&algorithm=SHA1&digits=6&period=30`;
}

// Codici di backup one-time: 8 codici da 10 hex, salvati come sha256 JSON.
export function generateBackupCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString("hex"));
  return { plain, hashed: plain.map((c) => sha256(c)) };
}

export function consumeBackupCode(hashedJson: string, codeInput: string): { ok: boolean; remaining: string } {
  const code = String(codeInput ?? "").trim().toLowerCase();
  let hashed: string[] = [];
  try {
    hashed = JSON.parse(hashedJson || "[]");
  } catch {
    hashed = [];
  }
  const digest = sha256(code);
  const idx = hashed.findIndex((h) => h === digest);
  if (idx < 0) return { ok: false, remaining: hashedJson };
  hashed.splice(idx, 1);
  return { ok: true, remaining: JSON.stringify(hashed) };
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// --- Audit ------------------------------------------------------------------

export async function logSaasAdminAction(input: {
  adminId: number;
  adminEmail: string;
  action: string;
  target?: string;
  details?: string;
  request?: Request;
}): Promise<void> {
  // Fire-and-forget: l'audit non deve mai far fallire l'azione.
  await dbExecute(
    "INSERT INTO `saas_admin_audit`(admin_id,admin_email,action,target,details,ip,created_at) VALUES(?,?,?,?,?,?,?)",
    [
      input.adminId,
      input.adminEmail,
      input.action.slice(0, 80),
      (input.target ?? "").slice(0, 190) || null,
      (input.details ?? "").slice(0, 500) || null,
      input.request ? clientIp(input.request).slice(0, 45) || null : null,
      businessNowDateTime(),
    ],
  ).catch(() => undefined);
}
